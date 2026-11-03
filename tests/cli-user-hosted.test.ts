/**
 * `mason user … --replica <org>/<name>` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts: an http server of this
 * test's on 127.0.0.1, no network): the real CLI as a child process, its service `MASON_CLOUD_URL`, its home and its
 * folder temp folders with no project. The contract is docs/HOSTED-API.md "The users of a replica"; what each test holds
 * is in its name. Every run's output is held by `mason` to carrying no token and to no line a person sees begun by the
 * service's text, and the last test to no password printed where it should not be.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ANSWERS, envFor, fakeService, home, mason, newToken, SECRETS, type Lines, type Reply, type Req } from "./hosted-fake.ts";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import { readSource } from "../src/cli/sources.ts";
import { LiveRoles } from "../src/cli/roles.ts";
import { connectionUrl, psqlLine } from "../src/cli/pg-url.ts";
import { serviceText } from "../src/cli/hosted.ts";

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const R = "acme/shop";
const USERS = "/v1/replicas/acme/shop/users";
/** The steps under Next: and in --json, the CLI's own: the local command's, each naming the replica, or mason login. */
const OWN_STEP = /^ {2}(mason login|mason user (add|list|remove|enable|disable)( \S+)? --replica acme\/shop)(\s|$)/;
/** The lines mason user begins (tests/hosted-fake.ts's rule, in its words); a list's row is begun by a user's name. On a
 *  terminal `width` wide a head longer than the line may be broken by the CLI within a word, exactly at its limit. */
const linesFor = (names: readonly string[] = [], width: number | null = null): Lines => {
  const heads = ["The user ", "No users yet for ", "✘ mason user: ", "✗ mason user: ",
    "Tip: Paste it into the tool now: ", "Tip: It never expires: ", "Tip: Rotating the API key ", "Tip: Last used: ", "Tip: Adding ", "Tip: It connects no more until ",
    ...["url", "psql", "user", "password", "database", "attributes", "role", "host", "port", "ssl mode", "disabled", "added", "sessions", "why", "fix"].map((l) => `  ${l} `)];
  return { heads, steps: ["  mason user ", "  mason login"], ownStep: OWN_STEP,
    row: (line) => /^\d+ users?( |$)/.test(line) || (((m) => m !== null && names.includes(m[1]!))(/^ {2}([a-z0-9][a-z0-9_.-]*)( |$)/.exec(line)))
      || (width !== null && [...line].length === width - 1 && heads.some((h) => h.startsWith(line))) };
};

/** One run against a fresh fake whose replica endpoints `v1` answers, signed in by MASON_TOKEN; its requests. */
async function hosted(v1: (r: Req) => Reply | Promise<Reply>, argv: string[], o: { extra?: Record<string, string>; terminal?: number; names?: readonly string[]; cwd?: string } = {}): Promise<{ a: Answer; requests: Req[]; token: string; home: string }> {
  const token = newToken("ci"); SECRETS.push(token);
  const fake = await fakeService({ v1 });
  const h = home();
  try {
    const a = await mason(o.cwd ?? h, ["user", ...argv], envFor(h, fake.url, { MASON_TOKEN: token, ...o.extra }), { lines: linesFor(o.names, o.terminal ?? null), ...(o.terminal ? { terminal: o.terminal } : {}) });
    return { a, requests: fake.requests.filter((r) => r.path.startsWith("/v1/")), token, home: h };
  } finally { await fake.close(); }
}

const ID = "0123456789abcdef";
const PASSWORD = `mason_${ID}_${"9".repeat(32)}`;
const AT = "2026-11-02T10:00:00.000Z";
const LINK = { url: "", host: "db.example", port: 5433, database: "shop", sslmode: "require" as const };
const addedAnswer = (name: string, more: Record<string, unknown> = {}): Record<string, unknown> => {
  const password = `mason_${ID}_${"9".repeat(32)}`;
  const url = connectionUrl(LINK, name, password);
  return { user: name, id: ID, addedAt: AT, password, database: "shop", url, psql: psqlLine(url), host: "db.example", port: 5433, sslmode: "require", roleFrom: "none", ...more };
};
const row = (name: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ name, id: ID, addedAt: AT, removedAt: null, disabledAt: null, live: true, lastUsedAt: null,
  url: connectionUrl(LINK, name, null), roleFrom: "none", ...more });
const listAnswer = (users: unknown[], more: Record<string, unknown> = {}): Reply => ({ status: 200, body: { users, lastUsedNote: null, urlNote: null, requestLogDays: 7, next: [{ command: "mason destroy" }], ...more } });
const ok = (body: unknown): Reply => ({ status: 200, body });

test("mason user --replica: each subcommand sends the run's own /api/users request to the replica's endpoint, with the token as Bearer and nothing of a project", async () => {
  const seen: Req[] = [];
  const answers: Record<string, Reply> = {
    [`POST ${USERS}`]: ok(addedAnswer("acme", { role: "tenant", roleFrom: "file", attributes: { tenant: "42", regions: ["eu", "uk"] } })),
    [`GET ${USERS}`]: listAnswer([row("acme")]),
    [`POST ${USERS}/acme/disable`]: ok({ disabled: { name: "acme", id: ID, addedAt: AT, disabledAt: AT }, already: false }),
    [`POST ${USERS}/acme/enable`]: ok({ enabled: { name: "acme", id: ID, addedAt: AT }, already: false }),
    [`DELETE ${USERS}/acme`]: ok({ removed: { name: "acme", id: ID, addedAt: AT, removedAt: AT } }),
  };
  const v1 = (r: Req): Reply => { seen.push(r); return answers[`${r.method} ${r.path}`] ?? { status: 404, body: { error: { code: "not_found", message: "no" } } }; };
  // the --role and the --set as they were given, repeated --set in order: the run's /api/users body
  let r = await hosted(v1, ["add", "acme", "--role", "tenant", "--set", "tenant=42", "--set", "regions=eu", "--set", "regions=uk", "--replica", R, "--json"], { names: ["acme"] });
  assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
  assert.deepEqual(r.requests.map((q) => [q.method, q.path, q.search]), [["POST", USERS, ""]]);
  assert.deepEqual(JSON.parse(r.requests[0]!.body), { name: "acme", role: "tenant", set: ["tenant=42", "regions=eu", "regions=uk"] });
  assert.equal(r.requests[0]!.headers.authorization, `Bearer ${r.token}`);
  assert.equal(r.requests[0]!.headers["content-type"], "application/json");
  assert.match(String(r.requests[0]!.headers["user-agent"]), /^mason-cli\//);
  assert.ok(!r.a.argv.some((x) => x.includes(r.token)), "the token is never on the command line");
  // with no --role and no --set, the body names the user alone
  r = await hosted(v1, ["add", "acme", "--replica", R]);
  assert.deepEqual(JSON.parse(r.requests[0]!.body), { name: "acme" });
  for (const [argv, method, p, search] of [
    [["list"], "GET", USERS, "?lastUsed=1"], [["disable", "acme"], "POST", `${USERS}/acme/disable`, ""],
    [["enable", "acme"], "POST", `${USERS}/acme/enable`, ""], [["remove", "acme"], "DELETE", `${USERS}/acme`, ""],
  ] as Array<[string[], string, string, string]>) {
    r = await hosted(v1, [...argv, "--replica", R], { names: ["acme"] });
    assert.equal(r.a.code, 0, `${argv.join(" ")}: ${r.a.stdout}${r.a.stderr}`);
    assert.deepEqual(r.requests.map((q) => [q.method, q.path, q.search, q.body]), [[method, p, search, ""]], argv.join(" "));
    assert.equal(r.requests[0]!.headers.authorization, `Bearer ${r.token}`);
  }
  // MASON_REPLICA when there is no --replica; --replica before it
  r = await hosted(v1, ["list"], { extra: { MASON_REPLICA: R }, names: ["acme"] });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.deepEqual(r.requests.map((q) => q.path), [USERS]);
  r = await hosted(v1, ["list", "--replica", R], { extra: { MASON_REPLICA: "other/one" }, names: ["acme"] });
  assert.deepEqual(r.requests.map((q) => q.path), [USERS]);
  // nothing of a project: run in a project's folder, its users file is neither read nor written
  const project = home();
  fs.mkdirSync(path.join(project, ".mason"));
  fs.writeFileSync(path.join(project, ".mason", "config.json"), "not a config");
  r = await hosted(v1, ["add", "acme", "--replica", R], { cwd: project });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.deepEqual(fs.readdirSync(path.join(project, ".mason")), ["config.json"]);
});

test("mason user --replica: a wrong line is refused here, exit 2, and nothing is sent — a verb, a name, a --role or a --set, a replica not <org>/<name>", async () => {
  const wrongLine = await fakeService({ v1: () => ok({}) });
  for (const argv of [["frobnicate"], ["add"], ["add", "Bad Name"], ["add", "x", "--role", "Agent"], ["add", "x", "--set", "tenant"], ["list", "--role", "agent"],
    ["remove", "x", "--set", "a=1"], ["list", "x"], ["--replica=acme"], ["list", "--replica", "Acme/shop"], ["list", "--replica", "acme/shop/x"], ["list", "--replica", "../x"]]) {
    const line = argv.includes("--replica") || argv.some((x) => x.startsWith("--replica=")) ? argv : [...argv, "--replica", R];
    const a = await runMason(home(), ["user", ...line, "--json"], envFor(home(), wrongLine.url, { MASON_TOKEN: newToken() }));
    assert.equal(a.code, 2, `${line.join(" ")}: ${a.stdout}`);
    assert.equal((JSON.parse(a.stdout) as { error: { code: string } }).error.code, "usage");
    assert.deepEqual(wrongLine.requests, [], line.join(" "));
  }
  await wrongLine.close();
  // MASON_REPLICA not <org>/<name>: refused, exit 1 (the environment, not the line), nothing sent
  const fake = await fakeService({ v1: () => ok({}) });
  try {
    const a = await runMason(home(), ["user", "list", "--json"], envFor(home(), fake.url, { MASON_TOKEN: newToken(), MASON_REPLICA: "acme" }));
    assert.equal(a.code, 1, a.stdout);
    assert.equal((JSON.parse(a.stdout) as { error: { message: string } }).error.message, 'MASON_REPLICA "acme" is not <org>/<name>');
    // not signed in: the login's refusal, naming mason login, nothing sent
    const b = await runMason(home(), ["user", "list", "--replica", R], envFor(home(), fake.url));
    assert.equal(b.code, 1);
    assert.equal(b.stderr, `✗ mason user: this machine is not signed in to ${fake.url}\n` +
      "  why   a replica's users are asked for as a person signed in (mason login), or with a token in MASON_TOKEN (CI)\n" +
      "  fix   run mason login, then mason user list again; in CI, set MASON_TOKEN to a CI token\n\n" +
      `Next:\n  mason login                                   sign this machine in to ${fake.url}\n`);
    assert.deepEqual(fake.requests, []);
  } finally { await fake.close(); }
});

// ------------------------------------------------------------------ the same answer prints the same output

/** A project with its run's command server up (main's RunContext, its ledgers faked, its roles a LiveRoles), as
 *  tests/cli-commands.test.ts makes one: the run's own /api/users, which a local mason user asks, and which the fake
 *  service below forwards to unchanged. */
async function projectUp(): Promise<{ root: string; port: number; token: string; close: () => void }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-user-hosted-")));
  made.push(root);
  const folder = path.join(root, "mason");
  fs.mkdirSync(path.join(folder, "sources"), { recursive: true });
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.writeFileSync(path.join(folder, "sources", "shop.yml"), "kind: postgres\nurl: postgres://mason:x@127.0.0.1:1/shop\ntables:\n  orders: {}\n  customers: {}\n");
  fs.writeFileSync(path.join(folder, "roles.yml"), "default: everything\nroles:\n  everything:\n    tables: all\n  agent:\n    tables:\n      orders: {}\n" +
    "  tenant:\n    attributes: [tenant]\n    tables:\n      orders: { where: \"tenant_id = :tenant\" }\n");
  const live = new LiveRoles(folder, root, () => [{ source: "public.orders", columns: [{ name: "id" }, { name: "tenant_id" }] }, { source: "public.customers", columns: [{ name: "id" }] }]);
  const parsed = parseSource("postgres://mason:x@127.0.0.1:1/shop");
  assert.ok("source" in parsed);
  const ctx: RunContext = {
    page: false, users: { file: path.join(root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:1/shop" },
    source: parsed.source, facts: () => ({ version: 180000, versionText: "18", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null, port: 0, token: "t0ken-of-the-run",
    folder: () => folder, root, home: path.join(root, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => {}, log: () => {},
    readSource: () => readSource(folder, root, {}), runUrl: "postgres://mason:x@127.0.0.1:1/shop", roles: () => live.now(),
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [], cancel: (session) => ({ unknown: session }) },
    logs: { capacity: 2000, recent: () => [] },
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, unsupported: async () => [], page: async () => ({ requests: [], before: null }), slow: async () => [], refused: async () => ({ total: 0, refused: [] }),
        summary: async () => { throw new Error("not asked here"); }, window: async () => { throw new Error("not asked here"); }, clients: async () => ({ clients: [], total: { clients: 0, sessions: 0 } }),
        slowest: async () => [], durationsBy: async () => new Map(), lastUsed: async (u) => u.map(() => null) },
      events: { days: 7, recent: async () => [] }, usage: { days: 7, sampleSeconds: 60, samples: async () => [], copySizes: async () => [], statementTotals: () => ({ completed: 0, refused: 0, failed: 0, cancelled: 0, completedMs: 0 }), lastDurations: () => null }, restarts: () => [] },
  };
  const server = createRunServer(ctx);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  ctx.port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${ctx.port}`, token: ctx.token, postgresUrl: "postgresql://127.0.0.1:1/shop", postgresListener: { host: "127.0.0.1", tls: null } }, lastRun: null }), { mode: 0o600 });
  return { root, port: ctx.port, token: ctx.token, close: () => server.close() };
}

/** A service that passes each replica request to the run's /api/users and its answer back unchanged: a success's body
 *  without its next, a refusal's `failure` as the `/v1/` failure shape, the status the run's. */
const forwarding = (run: { port: number; token: string }) => async (r: Req): Promise<Reply> => {
  if (!r.path.startsWith(USERS)) return { status: 404, body: { error: { code: "not_found", message: "no such replica" } } };
  const res = await fetch(`http://127.0.0.1:${run.port}/api/users${r.path.slice(USERS.length)}${r.search}`, { method: r.method,
    headers: { Authorization: `Bearer ${run.token}`, "Content-Type": "application/json" }, ...(r.body ? { body: r.body } : {}) });
  const body = await res.json() as Record<string, unknown>;
  if (res.status === 200) { const { next: _, ...rest } = body; return { status: 200, body: rest }; }
  const { next, ...error } = body.failure as Record<string, unknown>;
  return { status: res.status, body: { error, next } };
};

/** What differs between two runs by construction: ids, passwords and times. */
const norm = (t: string): string => t.replace(/mason_[0-9a-f]{16}_[0-9a-f]{32}/g, "PASSWORD").replace(/\b[0-9a-f]{16}\b/g, "ID")
  .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "TIME").replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/g, "STAMP");
const onReplica = (command: string): string => command.startsWith("mason user ") ? `${command} --replica ${R}` : command;
const steps = (block: string): string[][] => block.split("\n").filter((l) => l.startsWith("  ")).map((l) => l.trim().split(/\s{2,}/));

test("the same answer prints the same output: mason user --replica, whose service forwards to a run's /api/users, prints what mason user prints beside that run — as a person and with --json, its next steps naming the replica", { timeout: 300_000 }, async () => {
  const local = await projectUp(), remote = await projectUp();
  const token = newToken("ci"); SECRETS.push(token);
  const fake = await fakeService({ v1: forwarding(remote) });
  const h = home();
  const names = ["metabase", "grafana", "bot", "acme"];
  try {
    const both = async (argv: string[]): Promise<{ l: Answer; r: Answer }> => ({
      l: await runMason(local.root, ["user", ...argv], matrixEnv()),
      r: await mason(h, ["user", ...argv, "--replica", R], envFor(h, fake.url, { MASON_TOKEN: token }), { lines: linesFor(names) }),
    });
    const sequence: string[][] = [
      ["add", "metabase"], ["add", "grafana", "--json"], ["add", "bot", "--role", "agent"], ["add", "acme", "--role", "tenant", "--set", "tenant=42", "--json"],
      ["list"], ["list", "--json"], ["disable", "grafana"], ["disable", "grafana", "--json"], ["enable", "grafana", "--json"], ["enable", "grafana"],
      ["remove", "metabase"], ["remove", "bot", "--json"], ["list"], ["list", "--json"],
    ];
    for (const argv of sequence) {
      const { l, r } = await both(argv);
      const line = argv.join(" ");
      assert.equal(l.code, 0, `local ${line}: ${l.stdout}${l.stderr}`);
      assert.equal(r.code, 0, `hosted ${line}: ${r.stdout}${r.stderr}`);
      if (argv.includes("--json")) {
        const lv = JSON.parse(norm(l.stdout)) as { next: Array<{ command: string; what: string }> }, rv = JSON.parse(norm(r.stdout)) as typeof lv;
        const { next: ln, ...lrest } = lv, { next: rn, ...rrest } = rv;
        assert.deepEqual(rrest, lrest, line);
        assert.deepEqual(rn, ln.map((n) => ({ ...n, command: onReplica(n.command) })), `${line}: next`);
        continue;
      }
      // a person's: every line above Next: the same (the list's headline names the replica), the steps the local ones
      const [lt, lnext = ""] = norm(l.stdout).split("\nNext:\n"), [rt, rnext = ""] = norm(r.stdout).split("\nNext:\n");
      assert.equal(rt!.replace(/^(\d+ users? of )acme\/shop/, "$1shop"), lt, line);
      assert.deepEqual(steps(rnext), steps(lnext).map(([c, ...w]) => [onReplica(c!), ...w]), `${line}: next`);
      assert.equal(r.stderr, "", `${line}: nothing on stderr`);
    }
    // Mason's refusal on the replica: its words, each one line; its code the CLI's by the status, the run's in why; the
    // next step the CLI's
    for (const [argv, status] of [[["add", "grafana"], 409], [["disable", "nobody"], 404], [["add", "x", "--role", "nosuch"], 404], [["add", "y", "--role", "tenant"], 400], [["remove", "metabase"], 404]] as Array<[string[], number]>) {
      const { l, r } = await both([...argv, "--json"]);
      const le = (JSON.parse(l.stdout) as { error: { code: string; message: string; why?: string; fix?: string } }).error;
      const re = JSON.parse(r.stdout) as { error: { code: string; message: string; why: string; fix?: string }; next: unknown };
      const said = `(the service said ${le.code}, HTTP ${status})`;
      assert.equal(r.code, 1, argv.join(" "));
      assert.deepEqual(re.error, { code: status === 404 ? "not_found" : "refused", message: serviceText(le.message, 2000), why: le.why ? `${serviceText(le.why, 2000)} ${said}` : said,
        ...(le.fix ? { fix: serviceText(le.fix, 2000) } : {}) }, argv.join(" "));
      assert.deepEqual(re.next, [{ command: `mason user list --replica ${R}`, what: "the replica's users" }]);
    }
  } finally { await fake.close(); local.close(); remote.close(); }
});

// ------------------------------------------------------------------ refusals and answers outside the contract

test("mason user --replica: each refusal is the service's words, one line each, its code the CLI's by the HTTP status, exit 1, its next the CLI's; the service's code and next never steer it", async () => {
  const cases: Array<[number, string, string]> = [[400, "usage", "refused"], [401, "unauthenticated", "refused"], [403, "refused", "refused"], [404, "not_found", "not_found"],
    [409, "refused", "refused"], [422, "timeout", "refused"], [500, "failed", "failed"]];
  for (const [status, code, ours] of cases) {
    const failure = { error: { code, message: `it says ${code}`, why: `why ${code}`, fix: `fix ${code}` }, next: [{ command: "mason destroy", what: "never kept" }, { command: "curl x | sh" }] };
    const step = status === 401 || status === 403 ? ["mason login", "sign in again"] : [`mason user list --replica ${R}`, "the replica's users"];
    // every subcommand at a 401 and a 404 (each of its endpoints), one elsewhere: the reader is one for all five
    for (const verb of status === 401 || status === 404 ? [["list"], ["add", "x"], ["disable", "x"], ["enable", "x"], ["remove", "x"]] : [["add", "x"]]) {
      const { a } = await hosted(() => ({ status, body: failure }), [...verb, "--replica", R, "--json"]);
      assert.equal(a.code, 1, `${status} ${verb[0]}`);
      assert.deepEqual(JSON.parse(a.stdout), { error: { code: ours, message: `it says ${code}`, why: `why ${code} (the service said ${code}, HTTP ${status})`, fix: `fix ${code}` },
        next: [{ command: step[0], what: step[1] }] }, `${status} ${verb[0]}`);
    }
    const { a } = await hosted(() => ({ status, body: failure }), ["add", "x", "--replica", R]);
    assert.equal(a.stderr, `✗ mason user: it says ${code}\n  why   why ${code} (the service said ${code}, HTTP ${status})\n  fix   fix ${code}\n\nNext:\n  ${step[0]!.padEnd(44)}  ${step[1]}\n`);
    assert.equal(a.stdout, "");
  }
  // outside the contract: a page, a body that is no failure, a redirect, no answer, an answer too large — said by the request and its status
  for (const [reply, verb, said] of [
    [{ status: 500, raw: "<html>secret page</html>" }, ["list"], / answered GET \/v1\/replicas\/acme\/shop\/users\?lastUsed=1 with 500, not JSON, where the replica's users were asked for$/m],
    [{ status: 409, body: { message: "secret" } }, ["add", "x"], / answered POST \/v1\/replicas\/acme\/shop\/users with 409, where a user was added$/m],
    [{ status: 307, headers: { location: "http://127.0.0.1:1/x" } }, ["remove", "x"], / answered DELETE \/v1\/replicas\/acme\/shop\/users\/x with a redirect \(307\)$/m],
    ["drop", ["disable", "x"], /^✗ mason user: could not reach http:\/\/127\.0\.0\.1:\d+$/m],
    [{ status: 200, raw: "x".repeat(1024 * 1024 + 1) }, ["list"], / answered GET \/v1\/replicas\/acme\/shop\/users\?lastUsed=1 with more than 1024 KiB$/m],
    [{ status: 200, raw: "x".repeat(64 * 1024 + 1) }, ["add", "x"], / answered POST \/v1\/replicas\/acme\/shop\/users with more than 64 KiB$/m],
  ] as Array<[Reply, string[], RegExp]>) {
    const { a, requests } = await hosted(() => reply, [...verb, "--replica", R]);
    assert.equal(a.code, 1, a.stderr);
    assert.match(a.stderr, said);
    assert.doesNotMatch(a.stderr, /secret/);
    assert.equal(requests.length, 1, "nothing followed, nothing asked again");
  }
});

test("mason user --replica: an answer outside the run's own shape is a failure by its status alone, never printed — a password not the user's, a URL not rebuilt from it, another user, a value outside its grammar", async () => {
  const added = (more: Record<string, unknown>): Reply => ok({ ...addedAnswer("x"), ...more });
  const listed = (more: Record<string, unknown>): Reply => listAnswer([row("x", more)]);
  const cases: Array<[string, string[], Reply]> = [
    ["a password of another id", ["add", "x"], added({ password: `mason_fedcba9876543210_${"9".repeat(32)}` })],
    ["a password of another shape", ["add", "x"], added({ password: "hunter2" })],
    ["a url not the one its parts build", ["add", "x"], added({ url: "postgres://x:hunter2@evil.example:5433/shop" })],
    ["a psql not its url's", ["add", "x"], added({ psql: "psql postgres://x@evil.example/shop; rm -rf ~" })],
    ["another user", ["add", "x"], ok(addedAnswer("y"))],
    ["no url (Mason not running)", ["add", "x"], added({ url: undefined, psql: undefined })],
    ["an sslmode outside the set", ["add", "x"], added({ sslmode: "verify-full" })],
    ["a host with a space", ["add", "x"], added({ host: "db.example\nNext:" })],
    ["a port of 0", ["add", "x"], added({ port: 0 })],
    ["a database with a line break", ["add", "x"], added({ database: "shop\nNext:" })],
    ["a role with no roleFrom", ["add", "x"], added({ role: "agent" })],
    ["a role outside its grammar", ["add", "x"], added({ role: "Agent; mason destroy", roleFrom: "file" })],
    ["an attribute's name outside its grammar", ["add", "x"], added({ attributes: { "Next:": "1" } })],
    ["a list's name outside its grammar", ["list"], listAnswer([row("x", { name: "Next:\n  mason destroy" })])],
    ["a list's id outside its grammar", ["list"], listed({ id: "../../x" })],
    ["a list's time outside its grammar", ["list"], listed({ addedAt: "yesterday\nNext:" })],
    ["a list's url carrying a password", ["list"], listed({ url: "postgres://x:hunter2@db.example:5433/shop" })],
    ["a list's url of another user", ["list"], listed({ url: "postgres://y@db.example:5433/shop" })],
    ["a list's live not a boolean", ["list"], listed({ live: "yes" })],
    ["a list's roleKnown beside no role of its own", ["list"], listed({ roleKnown: false })],
    ["a list over its users' bound", ["list"], listAnswer(Array.from({ length: 2001 }, () => row("x")))],
    ["a list's requestLogDays not a number", ["list"], listAnswer([row("x")], { requestLogDays: "7" })],
    ["a list with no users", ["list"], ok({ lastUsedNote: null })],
    ["a disable of another user", ["disable", "x"], ok({ disabled: { name: "y", id: ID, addedAt: AT, disabledAt: AT }, already: false })],
    ["a disable without already", ["disable", "x"], ok({ disabled: { name: "x", id: ID, addedAt: AT, disabledAt: AT } })],
    ["an enable of another user", ["enable", "x"], ok({ enabled: { name: "y", id: ID, addedAt: AT }, already: true })],
    ["a remove without removedAt", ["remove", "x"], ok({ removed: { name: "x", id: ID, addedAt: AT } })],
  ];
  for (const [i, [what, verb, reply]] of cases.entries()) {
    // with --json each, as a person a few: the reader is one for both forms
    for (const json of i < 3 || i === 13 ? [false, true] : [true]) {
      const { a } = await hosted(() => reply, [...verb, "--replica", R, ...(json ? ["--json"] : [])], { names: ["x"] });
      assert.equal(a.code, 1, `${what}: ${a.stdout}${a.stderr}`);
      const text = json ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr;
      assert.match(text, / answered (GET|POST|DELETE) \/v1\/replicas\/acme\/shop\/users\S* with 200, where /, what);
      assert.doesNotMatch(a.stdout + a.stderr, /hunter2|evil|destroy|Agent|yesterday/, what);
    }
  }
});

// ------------------------------------------------------------------ hostile values, at every width

/** A value sized so that, begun at column `at` on a terminal `width` wide, the terminal would start its next lines with a
 *  forged Next: heading, a step, a row, a failure and a tip, each padded to the width (tests/cli-deploy.test.ts's). */
const FORGED_LINES = ["Next:", "  mason destroy                                 clean up", "  password  evil", "✘ mason user: forged", "Tip: run mason destroy"];
const forgedAt = (width: number, at: number): string => "a".repeat(Math.max(1, width - at)) + FORGED_LINES.map((l) => l.padEnd(width, " ")).join("") + "z";
const forged = (what: string): string => `${what}\nFORGED a line of its own\r\nNext:\n  mason destroy   FORGED step\u2028FORGED\u0085FORGED\u001b[2J\u202eFORGED\u200b`;

for (const WIDTH of [null, 12, 39, 80] as const) test(`mason user --replica ${WIDTH === null ? "on a pipe and in --json" : `on a terminal ${WIDTH} wide`}: no line a person sees begins with what the service sent — each free-text value of user-hosted.ts's table, and every line of its own`, { timeout: 300_000 }, async () => {
  const t = WIDTH === null ? {} : { terminal: WIDTH };
  const f = (at: number): string => WIDTH === null ? forged("value") : forgedAt(WIDTH, at);
  const names = ["acme", "bot", "x"];
  const forms = WIDTH === null ? [[], ["--json"]] : [[]];
  for (const form of forms) {
    // a list: its notes, an attribute's values, a user disabled, removed, with a role
    const list = listAnswer([row("acme", { role: "tenant", roleFrom: "file", roleKnown: true, attributes: { tenant: f(30), regions: [f(10), "uk"] } }),
      row("bot", { disabledAt: AT, live: false }), row("x", { removedAt: AT, live: false, url: null })], { lastUsedNote: f(16), urlNote: f(8) });
    let r = await hosted(() => list, ["list", "--replica", R, ...form], { ...t, names });
    assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
    assert.match(r.a.stdout, /FORGED|destroy/, "the value is shown");
    if (form.length === 0 && WIDTH === null) {
      assert.equal(r.a.stdout.split("\n").filter((l) => l.includes("FORGED")).length, 2, `one line each, the acme row and the tip:\n${r.a.stdout}`);
      assert.doesNotMatch(r.a.stdout, /\u001b|\u202e|\u200b|\u2028|\u0085/);
    }
    // an add: its attributes' values
    r = await hosted(() => ok(addedAnswer("acme", { role: "tenant", roleFrom: "file", attributes: { tenant: f(15) } })), ["add", "acme", "--replica", R, ...form], { ...t, names });
    assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
    // a refusal: its message (after "✘ mason user: "), why and fix (after their labels), at 409 and 500
    for (const status of [409, 500]) {
      r = await hosted(() => ({ status, body: { error: { code: "refused", message: f(14), why: f(8), fix: f(8) }, next: [{ command: "mason destroy" }] } }), ["remove", "acme", "--replica", R, ...form], { ...t, names });
      assert.equal(r.a.code, 1, `${status}: ${r.a.stdout}${r.a.stderr}`);
      if (form.length === 0 && WIDTH === null) assert.equal(r.a.stderr.split("\n").filter((l) => l.includes("FORGED")).length, 3, `message, why, fix one line each:\n${r.a.stderr}`);
    }
    // the reports of disable, enable and remove, on the terminal
    for (const [verb, body] of [["disable", { disabled: { name: "acme", id: ID, addedAt: AT, disabledAt: AT }, already: false }], ["enable", { enabled: { name: "acme", id: ID, addedAt: AT }, already: true }],
      ["remove", { removed: { name: "acme", id: ID, addedAt: AT, removedAt: AT } }]] as const) {
      r = await hosted(() => ok(body), [verb, "acme", "--replica", R, ...form], { ...t, names });
      assert.equal(r.a.code, 0, `${verb}: ${r.a.stdout}${r.a.stderr}`);
    }
  }
});

// ------------------------------------------------------------------ the password, once

/** Every file under `dir`, read. */
const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"));

test("the password is printed once, by add, exactly as locally — in its url, psql and password rows and --json's password, url and psql; never on stderr, in a failure, in a file, or in what any other answer carries", async () => {
  const url = connectionUrl(LINK, "metabase", PASSWORD);
  const answer = addedAnswer("metabase");
  const a = await hosted(() => ok(answer), ["add", "metabase", "--replica", R], { names: ["metabase"] });
  assert.equal(a.a.code, 0, a.a.stderr);
  assert.equal(a.a.stdout, `The user metabase added: its password is printed this once
  url        ${url}
  psql       ${psqlLine(url)}
  user       metabase
  password   ${PASSWORD}
  database   shop
  host       db.example
  port       5433
  ssl mode   require

Tip: Paste it into the tool now: Mason keeps no copy of the password. Lost, remove the user and add it again.
Tip: It never expires: mason user remove ends it, at once and for every session it holds.
Tip: Rotating the API key (apiKey in .mason/config.json, MASON_API_KEY under mason serve) removes every user at once.

Next:
  mason user list --replica acme/shop           the users
  mason user remove metabase --replica acme/shop  it connects no more
`);
  assert.deepEqual(a.a.stdout.split("\n").filter((l) => l.includes(PASSWORD)).map((l) => l.trim().split(/\s+/)[0]), ["url", "psql", "password"]);
  assert.equal(a.a.stderr, "");
  const j = await hosted(() => ok(answer), ["add", "metabase", "--replica", R, "--json"]);
  const v = JSON.parse(j.a.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.entries(v).filter(([, x]) => typeof x === "string" && x.includes(PASSWORD)).map(([k]) => k), ["password", "url", "psql"]);
  assert.equal(j.a.stderr, "");
  // a service that repeats it anywhere else: masked, every time, as a person and with --json
  const carrying = `the password is ${PASSWORD}`;
  for (const [verb, reply] of [
    [["list"], listAnswer([row("metabase", { attributes: { tenant: carrying } })], { lastUsedNote: carrying, urlNote: carrying })],
    [["remove", "metabase"], { status: 409, body: { error: { code: "refused", message: carrying, why: carrying, fix: carrying } } }],
    [["add", "metabase"], { status: 409, body: { error: { code: "refused", message: carrying, why: carrying, fix: carrying } } }],
    [["disable", "metabase"], ok({ disabled: { name: "metabase", id: ID, addedAt: AT, disabledAt: AT }, already: false, note: carrying })],
    [["add", "other"], ok({ ...addedAnswer("other"), note: carrying })],
  ] as Array<[string[], Reply]>) {
    for (const form of [[], ["--json"]]) {
      const r = await hosted(() => reply, [...verb, "--replica", R, ...form], { names: ["metabase", "other"] });
      const said = r.a.stdout + r.a.stderr;
      if (verb[0] === "disable") {
        // a key outside the answer's shape is never read, so never printed
        assert.doesNotMatch(said, /the password is|mason_\*\*\*\*/, "disable: not printed");
        continue;
      }
      if (verb.join(" ") === "add other") {
        // another user's add prints its own password — the one it was asked for — and nothing else of the answer
        assert.equal(said.split(PASSWORD).length - 1, 3, `${verb.join(" ")}: its own rows`);
        assert.doesNotMatch(said, /the password is/);
        continue;
      }
      assert.ok(!said.includes(PASSWORD), `${verb.join(" ")} ${form.join(" ")} printed the password:\n${said}`);
      assert.match(said, /mason_\*\*\*\*/, `${verb.join(" ")}: masked`);
      for (const text of [...filesUnder(r.home)]) assert.ok(!text.includes(PASSWORD), "no file holds it");
    }
  }
  for (const text of [...filesUnder(a.home), ...filesUnder(j.home)]) assert.ok(!text.includes(PASSWORD), "no file holds it");
});

test("no run of mason user --replica printed a token, nor put one on its command line", () => {
  assert.ok(ANSWERS.length > 50, `the runs above are here (${ANSWERS.length})`);
  for (const a of ANSWERS) {
    for (const s of SECRETS) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s) && !a.argv.some((x) => x.includes(s)), `mason ${a.argv.join(" ")} printed a token`);
    assert.doesNotMatch(a.stdout + a.stderr, /masondata_(pat|ci)_[A-Za-z0-9_-]{43}/, `mason ${a.argv.join(" ")}`);
  }
});
