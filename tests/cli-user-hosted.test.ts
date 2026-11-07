/**
 * `mason user … --replica <org>/<name>` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts, tests/user-hosted-fake.ts: an
 * http server of this test's on 127.0.0.1, no network): each subcommand's request, a wrong line, the same output as the local command for the same answer, and the password printed once. The contract is docs/HOSTED-API.md "The users of a
 * replica"; what each test holds is in its name. Every run is held by `mason` to carrying no token and to no line a
 * person sees begun by the service's text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envFor, fakeService, home, mason, newToken, SECRETS, type Reply, type Req } from "./hosted-fake.ts";
import { addedAnswer, AT, hosted, ID, LINK, linesFor, listAnswer, made, noTokenPrinted, ok, PASSWORD, R, row, USERS } from "./user-hosted-fake.ts";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import { readSource } from "../src/cli/sources.ts";
import { LiveRoles } from "../src/cli/roles.ts";
import { connectionUrl, psqlLine } from "../src/cli/pg-url.ts";
import { serviceText } from "../src/cli/hosted.ts";

test("mason user --replica: each subcommand sends the run's own /api/users request to the replica's endpoint, with the token as Bearer and nothing of a project", async () => {
  const seen: Req[] = [];
  const answers: Record<string, Reply> = {
    [`POST ${USERS}`]: ok(addedAnswer("acme", { role: "tenant", roleFrom: "file", attributes: { tenant: "42", regions: ["eu", "uk"] } })),
    [`GET ${USERS}`]: listAnswer([row("acme")]),
    [`POST ${USERS}/acme/disable`]: ok({ disabled: { name: "acme", id: ID, addedAt: AT, disabledAt: AT }, already: false }),
    [`POST ${USERS}/acme/enable`]: ok({ enabled: { name: "acme", id: ID, addedAt: AT }, already: false }),
    [`DELETE ${USERS}/acme`]: ok({ removed: { name: "acme", id: ID, addedAt: AT, removedAt: AT } }),
    [`POST ${USERS}/acme/from`]: ok({ changed: { name: "acme", id: ID, addedAt: AT, from: ["203.0.113.0/24"] }, already: false }),
  };
  // a service that honours from: its answer carries the ranges it was sent
  const echo = (reply: Reply, r: Req): Reply => {
    const sent = r.body ? (JSON.parse(r.body) as { from?: unknown }).from : undefined;
    if (sent === undefined || reply === "drop" || typeof reply.body !== "object" || reply.body === null) return reply;
    const b = reply.body as Record<string, unknown>;
    return { ...reply, body: "changed" in b ? { ...b, changed: { ...(b.changed as object), from: sent } } : { ...b, from: sent } };
  };
  const v1 = (r: Req): Reply => { seen.push(r); const a = answers[`${r.method} ${r.path}`]; return a === undefined ? { status: 404, body: { error: { code: "not_found", message: "no" } } } : echo(a, r); };
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
  // --from: each range in its one form, in the order given; mason user from replaces them, --any sends null
  r = await hosted(v1, ["add", "acme", "--from", "203.0.113.0/24", "--from", "2001:DB8:7::/48", "--replica", R]);
  assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
  assert.deepEqual(JSON.parse(r.requests[0]!.body), { name: "acme", from: ["203.0.113.0/24", "2001:db8:7::/48"] });
  r = await hosted(v1, ["from", "acme", "203.0.113.0/24", "--replica", R], { names: ["acme"] });
  assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
  assert.deepEqual(r.requests.map((q) => [q.method, q.path, JSON.parse(q.body)]), [["POST", `${USERS}/acme/from`, { from: ["203.0.113.0/24"] }]]);
  assert.match(r.a.stdout, /^The user acme connects from 203\.0\.113\.0\/24 alone now$/m);
  r = await hosted(v1, ["from", "acme", "--any", "--replica", R], { names: ["acme"] });
  assert.deepEqual(r.requests.map((q) => JSON.parse(q.body)), [{ from: null }]);
  for (const [argv, method, p, search] of [
    [["list"], "GET", USERS, "?lastUsed=1"], [["disable", "acme"], "POST", `${USERS}/acme/disable`, ""],
    [["enable", "acme"], "POST", `${USERS}/acme/enable`, ""], [["remove", "acme"], "DELETE", `${USERS}/acme`, ""],
  ] as Array<[string[], string, string, string]>) {
    r = await hosted(v1, [...argv, "--replica", R], { names: ["acme"] });
    assert.equal(r.a.code, 0, `${argv.join(" ")}: ${r.a.stdout}${r.a.stderr}`);
    assert.deepEqual(r.requests.map((q) => [q.method, q.path, q.search, q.body]), [[method, p, search, ""]], argv.join(" "));
    assert.equal(r.requests[0]!.headers.authorization, `Bearer ${r.token}`);
  }
  // MASON_REPLICA when there is no --replica, said on stderr (it turns mason user from this project's users to a
  // replica's, and an agent may never read the environment it inherits); --replica before it, and nothing said
  r = await hosted(v1, ["list"], { extra: { MASON_REPLICA: R }, names: ["acme"] });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.deepEqual(r.requests.map((q) => q.path), [USERS]);
  assert.equal(r.a.stderr, "using MASON_REPLICA=acme/shop (--replica names another; unset MASON_REPLICA for none)\n");
  r = await hosted(v1, ["remove", "acme", "--json"], { extra: { MASON_REPLICA: R }, names: ["acme"] });
  assert.equal(r.a.stderr, "using MASON_REPLICA=acme/shop (--replica names another; unset MASON_REPLICA for none)\n", "under --json too: stderr, so stdout stays one document");
  assert.equal((JSON.parse(r.a.stdout) as { replica: string }).replica, R, "the answer names the replica it acted on");
  r = await hosted(v1, ["list", "--replica", R], { extra: { MASON_REPLICA: "other/one" }, names: ["acme"] });
  assert.deepEqual(r.requests.map((q) => q.path), [USERS]);
  assert.equal(r.a.stderr, "");
  // every answer names its target: replica in --json, the replica in the headline
  for (const [argv, headline] of [[["add", "acme"], "The user acme of the replica acme/shop added: "], [["disable", "acme"], "The user acme of the replica acme/shop disabled: "],
    [["enable", "acme"], "The user acme of the replica acme/shop enabled: "], [["remove", "acme"], "The user acme of the replica acme/shop removed: "], [["list"], "1 user of acme/shop"]] as Array<[string[], string]>) {
    r = await hosted(v1, [...argv, "--replica", R], { names: ["acme"] });
    assert.ok(r.a.stdout.startsWith(headline), `${argv.join(" ")}: ${r.a.stdout}`);
    r = await hosted(v1, [...argv, "--replica", R, "--json"], { names: ["acme"] });
    assert.equal((JSON.parse(r.a.stdout) as { replica: string }).replica, R, argv.join(" "));
  }
  // nothing of a project: run in a project's folder, its users file is neither read nor written
  const project = home();
  fs.mkdirSync(path.join(project, ".mason"));
  fs.writeFileSync(path.join(project, ".mason", "config.json"), "not a config");
  r = await hosted(v1, ["add", "acme", "--replica", R], { cwd: project });
  assert.equal(r.a.code, 0, r.a.stderr);
  assert.deepEqual(fs.readdirSync(path.join(project, ".mason")), ["config.json"]);
});

test("mason user --replica: an address limit the service does not confirm is refused, the answer never printed — ranges missing, null or others on add, others on from; a service that does not support from is its own 400, said in its words", async () => {
  const sent = ["203.0.113.0/24"];
  for (const [what, answer] of [["missing", addedAnswer("acme")], ["null", addedAnswer("acme", { from: null })], ["others", addedAnswer("acme", { from: ["198.51.100.0/24"] })]] as const) {
    for (const form of [[], ["--json"]]) {
      const r = await hosted(() => ok(answer), ["add", "acme", "--from", sent[0]!, "--replica", R, ...form], { names: ["acme"] });
      const said = r.a.stdout + r.a.stderr;
      assert.equal(r.a.code, 1, `${what}: ${said}`);
      assert.ok(!said.includes(PASSWORD), `${what}: the password of an unconfirmed user is never printed`);
      assert.match(said, /the service did not confirm acme's address limit: its answer does not carry the ranges sent \(203\.0\.113\.0\/24\)/, what);
      assert.match(said, /mason user remove acme --replica acme\/shop/, what);
      if (form.length) {
        const v = JSON.parse(r.a.stdout) as { error: { code: string }; next: Array<{ command: string }> };
        assert.equal(v.error.code, "failed");
        assert.deepEqual(v.next.map((n) => n.command), ["mason user list --replica acme/shop", "mason user remove acme --replica acme/shop"]);
      }
    }
  }
  // the same answer confirmed: printed, its from row
  const good = await hosted(() => ok(addedAnswer("acme", { from: sent })), ["add", "acme", "--from", sent[0]!, "--replica", R], { names: ["acme"] });
  assert.equal(good.a.code, 0, good.a.stderr);
  assert.match(good.a.stdout, /^ {2}from +203\.0\.113\.0\/24 \(it connects from these alone\)$/m);
  // from: the ranges now must be those sent, --any's null included
  for (const [argv, back] of [[["from", "acme", "10.0.0.0/8"], ["198.51.100.0/24"]], [["from", "acme", "10.0.0.0/8"], null], [["from", "acme", "--any"], ["10.0.0.0/8"]]] as Array<[string[], string[] | null]>) {
    const r = await hosted(() => ok({ changed: { name: "acme", id: ID, addedAt: AT, from: back }, already: false }), [...argv, "--replica", R], { names: ["acme"] });
    assert.equal(r.a.code, 1, `${argv.join(" ")}: ${r.a.stdout}`);
    assert.match(r.a.stderr, /the service did not confirm acme's address limit/);
  }
  // a service that does not support from refuses it 400: its words, as any refusal's
  const no = await hosted(() => ({ status: 400, body: { error: { code: "invalid_request", message: "from: per-user address ranges are not supported yet" } } }),
    ["add", "acme", "--from", sent[0]!, "--replica", R, "--json"], { names: ["acme"] });
  assert.equal(no.a.code, 1);
  const e = (JSON.parse(no.a.stdout) as { error: { code: string; message: string } }).error;
  assert.deepEqual([e.code, e.message], ["refused", "from: per-user address ranges are not supported yet"]);
});

test("mason user --replica: a wrong line is refused here, exit 2, and nothing is sent — a verb, a name, a --role or a --set, a replica not <org>/<name>", async () => {
  const wrongLine = await fakeService({ v1: () => ok({}) });
  for (const argv of [["frobnicate"], ["add"], ["add", "Bad Name"], ["add", "x", "--role", "Agent"], ["add", "x", "--set", "tenant"], ["list", "--role", "agent"],
    ["remove", "x", "--set", "a=1"], ["list", "x"], ["add", "x", "--from", "999.999.999.999/99"], ["add", "x", "--from", "10.0.1.5/24"], ["from", "x"],
    ["from", "x", "10.0.0.0/33"], ["from", "x", "10.0.0.0/8", "--any"], ["list", "--from", "10.0.0.0/8"], ["remove", "x", "--any"], ["--replica=acme"], ["list", "--replica", "Acme/shop"], ["list", "--replica", "acme/shop/x"], ["list", "--replica", "../x"]]) {
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
  const names = ["metabase", "grafana", "bot", "acme", "looker"];
  try {
    const both = async (argv: string[]): Promise<{ l: Answer; r: Answer }> => ({
      l: await runMason(local.root, ["user", ...argv], matrixEnv()),
      r: await mason(h, ["user", ...argv, "--replica", R], envFor(h, fake.url, { MASON_TOKEN: token }), { lines: linesFor(names) }),
    });
    const sequence: string[][] = [
      ["add", "metabase"], ["add", "grafana", "--json"], ["add", "bot", "--role", "agent"], ["add", "acme", "--role", "tenant", "--set", "tenant=42", "--json"],
      ["list"], ["list", "--json"], ["disable", "grafana"], ["disable", "grafana", "--json"], ["enable", "grafana", "--json"], ["enable", "grafana"],
      ["add", "looker", "--from", "203.0.113.0/24", "--from", "2001:db8:7::/48"], ["from", "looker", "198.51.100.7", "--json"], ["from", "looker", "198.51.100.7"],
      ["list"], ["list", "--json"], ["from", "looker", "--any"], ["from", "looker", "10.0.0.0/8", "--json"],
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
        // the same, and the replica it acted on, which a project's answer never has
        assert.deepEqual(rrest, { replica: R, ...lrest }, line);
        assert.ok(!("replica" in lrest), line);
        assert.deepEqual(rn, ln.map((n) => ({ ...n, command: onReplica(n.command) })), `${line}: next`);
        continue;
      }
      // a person's: every line above Next: the same (the headline names the replica), the steps the local ones
      const [lt, lnext = ""] = norm(l.stdout).split("\nNext:\n"), [rt, rnext = ""] = norm(r.stdout).split("\nNext:\n");
      assert.equal(rt!.replace(/^(\d+ users? of )acme\/shop/, "$1shop").replace(/^(The user \S+) of the replica acme\/shop /, "$1 "), lt, line);
      assert.deepEqual(steps(rnext), steps(lnext).map(([c, ...w]) => [onReplica(c!), ...w]), `${line}: next`);
      assert.equal(r.stderr, "", `${line}: nothing on stderr`);
    }
    // Mason's refusal on the replica: its words, each one line; its code the CLI's by the status, the run's in why; the
    // next step the CLI's
    for (const [argv, status] of [[["add", "grafana"], 409], [["disable", "nobody"], 404], [["add", "x", "--role", "nosuch"], 404], [["add", "y", "--role", "tenant"], 400], [["remove", "metabase"], 404], [["from", "nobody", "10.0.0.0/8"], 404]] as Array<[string[], number]>) {
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

// ------------------------------------------------------------------ the password, once

/** Every file under `dir`, read. */
const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"));

test("the password is printed once, by add, exactly as locally — in its url, psql and password rows and --json's password, url and psql; never on stderr, in a failure, in a file, or in what any other answer carries", async () => {
  const url = connectionUrl(LINK, "metabase", PASSWORD);
  const answer = addedAnswer("metabase");
  const a = await hosted(() => ok(answer), ["add", "metabase", "--replica", R], { names: ["metabase"] });
  assert.equal(a.a.code, 0, a.a.stderr);
  assert.equal(a.a.stdout, `The user metabase of the replica acme/shop added: its password is printed this once
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
  assert.equal(v.replica, R);
  assert.equal(j.a.stderr, "");
  // a service that repeats it anywhere else: in a refusal's words, masked; in an answer, the answer refused whole —
  // nothing of it printed — whatever key carries it (PR 609's review: a grammar alone is no mask)
  const carrying = `the password is ${PASSWORD}`;
  for (const [verb, reply, refusal] of [
    [["remove", "metabase"], { status: 409, body: { error: { code: "refused", message: carrying, why: carrying, fix: carrying } } }, true],
    [["add", "metabase"], { status: 409, body: { error: { code: "refused", message: `user_${PASSWORD.toUpperCase()}`, why: carrying, fix: `x${PASSWORD}` } } }, true],
    [["list"], listAnswer([row("metabase", { attributes: { tenant: carrying } })], { lastUsedNote: carrying, urlNote: carrying }), false],
    [["disable", "metabase"], ok({ disabled: { name: "metabase", id: ID, addedAt: AT, disabledAt: AT }, already: false, note: carrying }), false],
    [["add", "other"], ok({ ...addedAnswer("other"), note: carrying }), false],
  ] as Array<[string[], Reply, boolean]>) {
    for (const form of [[], ["--json"]]) {
      const r = await hosted(() => reply, [...verb, "--replica", R, ...form], { names: ["metabase", "other"] });
      const said = r.a.stdout + r.a.stderr;
      assert.equal(r.a.code, 1, `${verb.join(" ")}: ${said}`);
      assert.ok(!said.toLowerCase().includes(PASSWORD), `${verb.join(" ")} ${form.join(" ")} printed the password:\n${said}`);
      if (refusal) assert.match(said, /mason_\*\*\*\*/, `${verb.join(" ")}: masked`);
      else assert.match(said, / answered (GET|POST) \/v1\/replicas\/acme\/shop\/users\S* with 200, where /, `${verb.join(" ")}: refused whole`);
      for (const text of [...filesUnder(r.home)]) assert.ok(!text.includes(PASSWORD), "no file holds it");
    }
  }
  for (const text of [...filesUnder(a.home), ...filesUnder(j.home)]) assert.ok(!text.includes(PASSWORD), "no file holds it");
});

noTokenPrinted(30);
