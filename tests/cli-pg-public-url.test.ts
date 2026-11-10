/**
 * `MASON_PG_PUBLIC_URL` (src/cli/pg-public-url.ts; issue 501): the Postgres API's address as a client reaches it, under
 * `mason serve`. Its one reading — what it may hold, and every refusal at every entrance that takes the settings, naming
 * the setting and never quoting the value — then ONE builder (src/cli/pg-url.ts `clientLink`) read by every surface that
 * prints a URL to paste: `mason status` and `mason user add` / `list` (text and `--json`) beside a run, and the run's
 * own `/api/state` and `POST /api/users` (the web page's; its panels are tests/web-page.test.ts's). Unset, each says what
 * it said before.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";
import * as pgUrl from "../src/cli/pg-url.ts";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const publicModule = await import("../src/cli/pg-public-url.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/pg-public-url.ts")>;
const missing = (): never => assert.fail("src/cli/pg-public-url.ts is not in this tree");
const readPublicUrl = publicModule.readPublicUrl ?? missing;
const pgPublicUrlSetting = publicModule.pgPublicUrlSetting ?? missing;
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");
const P = pgUrl as unknown as Partial<typeof import("../src/cli/pg-url.ts")>;
const clientLink = P.clientLink ?? ((): never => assert.fail("src/cli/pg-url.ts has no clientLink"));

const KEY = "k".repeat(48);
const ENV = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); made.push(d); return d; };
const project = (): Parameters<typeof startSettingRefusal>[0] => {
  const dir = tmp("mpublic-");
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  return { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason", false) } as unknown as Parameters<typeof startSettingRefusal>[0];
};

/** What every entrance of mason serve says of the setting: its own reading, the one report, the run's check. */
function everyEntrance(v: string): { setting: unknown; report: string | null; run: string | null } {
  const env = { MASON_PG_PUBLIC_URL: v };
  const s = serveSettings({ ...ENV, ...env }, "/srv");
  const r = startSettingRefusal(project(), env, { serve: true });
  return { setting: pgPublicUrlSetting(env), report: "message" in s ? s.message : null, run: r === null ? null : r.message };
}

test("taken: a host, a port (5432 when none), a database (the run's when none) and an sslmode a client keeps to; unset or empty is none", () => {
  const cases: Array<[string, unknown]> = [
    ["postgres://db.example.com:5433/?sslmode=verify-full", { host: "db.example.com", port: 5433, database: null, sslmode: "verify-full" }],
    ["postgres://db.example.com:5433?sslmode=require", { host: "db.example.com", port: 5433, database: null, sslmode: "require" }],
    ["postgresql://DB.Example.com/analytics?sslmode=require", { host: "db.example.com", port: 5432, database: "analytics", sslmode: "require" }],
    ["postgres://[2001:db8::1]:6432/?sslmode=disable", { host: "2001:db8::1", port: 6432, database: null, sslmode: "disable" }],
    ["postgres://192.0.2.10:5433/Sales%20DB?sslmode=verify-ca", { host: "192.0.2.10", port: 5433, database: "Sales DB", sslmode: "verify-ca" }],
    ["postgres://xn--bcher-kva.example.com:5433/?sslmode=require", { host: "xn--bcher-kva.example.com", port: 5433, database: null, sslmode: "require" }],
  ];
  for (const [v, want] of cases) {
    const e = everyEntrance(v);
    assert.deepEqual(e.setting, want, v);
    assert.equal(e.report, null, v);
    assert.equal(e.run, null, v);
    // the record's form reads back as the same address
    assert.deepEqual(readPublicUrl(publicModule.publicUrlText!(want as never)), want, `${v}: recorded and read back`);
  }
  assert.equal(pgPublicUrlSetting({}), null);
  assert.equal(pgPublicUrlSetting({ MASON_PG_PUBLIC_URL: "" }), null);
});

test("refused at every entrance of mason serve, naming the setting and the way out, never quoting the value: a user or password, another parameter, no or a falling-back sslmode, a bad host, port or path", () => {
  const at = "MASON_PG_PUBLIC_URL is set to";
  const shape = "postgres://<host>:<port>/<database>?sslmode=<mode>";
  const host = `${at} a URL with a host that is not a name or an address: a name (db.example.com), an IPv4 address, or an IPv6 one in brackets`;
  const port = `${at} a URL whose port is not 1-65535: name it, or leave out the : for 5432`;
  const secret = `${at} a URL with a user or a password in it, which every page and command would print: remove them (a user's name and password are mason user add's)`;
  const param = `${at} a URL with a parameter other than sslmode: the address takes sslmode alone; leave the rest out (a user and its password are mason user add's)`;
  const cases: Array<[string, string]> = [
    ["postgres://metabase:hunter2@db.example.com:5433/?sslmode=require", secret],
    ["postgres://hunter2@db.example.com:5433/?sslmode=require", secret],
    ["postgres://db.example.com:5433/?sslmode=require&password=hunter2", param],
    ["postgres://db.example.com:5433/?sslmode=require&user=hunter2&host=evil.example.com", `${at} a URL with 2 parameters other than sslmode: the address takes sslmode alone; leave the rest out (a user and its password are mason user add's)`],
    ["postgres://db.example.com:5433/?SSLMODE=require", param],
    ["postgres://db.example.com:5433/", `${at} a URL with no sslmode: add ?sslmode= disable, require, verify-ca, verify-full — whether a client uses TLS to reach that address`],
    ["postgres://db.example.com:5433/?sslmode=prefer", `${at} a URL whose sslmode is not one of disable, require, verify-ca, verify-full (a client that falls back to plain would send a password in clear)`],
    ["postgres://db.example.com:5433/?sslmode=allow", `${at} a URL whose sslmode is not one of disable, require, verify-ca, verify-full (a client that falls back to plain would send a password in clear)`],
    ["postgres://db.example.com:5433/?sslmode=hunter2", `${at} a URL whose sslmode is not one of disable, require, verify-ca, verify-full`],
    ["postgres://db.example.com/?sslmode=require&sslmode=disable", `${at} a URL with sslmode twice: name it once`],
    ["https://db.example.com/", `${at} a URL of the scheme https://: ${shape}`],
    ["db.example.com:5433", `${at} no URL: ${shape}`],
    ["postgres://:5433/?sslmode=require", `${at} a URL with no host: a name (db.example.com), an IPv4 address, or an IPv6 one in brackets`],
    ["postgres://db_x.example.com/?sslmode=require", host],
    ["postgres://-db.example.com/?sslmode=require", host],
    ["postgres://db%2eexample.com/?sslmode=require", host],
    ["postgres://[::1/?sslmode=require", host],
    ["postgres://[db.example.com]/?sslmode=require", host],
    ["postgres://db.example.com:0/?sslmode=require", port],
    ["postgres://db.example.com:65536/?sslmode=require", port],
    ["postgres://db.example.com:/?sslmode=require", port],
    ["postgres://db.example.com:5433x/?sslmode=require", port],
    ["postgres://db.example.com:5433/a/b?sslmode=require", `${at} a URL whose path is more than a database: postgres://<host>:<port>/<database>`],
    ["postgres://db.example.com:5433/..?sslmode=require", `${at} a URL whose database is not a name a tool can connect with`],
    ["postgres://db.example.com:5433/%ZZ?sslmode=require", `${at} a URL whose database is not %-encoded right`],
    ["postgres://db.example.com:5433/?sslmode=require#top", `${at} a URL with a #fragment: remove it`],
    ["postgres://db.example.com:5433/\n?sslmode=require", `${at} a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and a database %-encoded`],
    ["postgres://bücher.example.com/?sslmode=require", `${at} a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and a database %-encoded`],
    [`postgres://db.example.com/${"a".repeat(2048)}?sslmode=require`, `${at} 2090 characters, and an address is at most 2048: ${shape}`],
  ];
  for (const [v, problem] of cases) {
    const e = everyEntrance(v);
    assert.deepEqual(e.setting, { problem }, JSON.stringify(v));
    assert.equal(e.report, `a setting is missing or wrong: ${problem}`, JSON.stringify(v));
    assert.equal(e.run, problem, JSON.stringify(v));
    assert.ok(!e.report!.includes("hunter2") && !e.report!.includes("evil") && !e.report!.includes("6432") && !e.report!.includes("5433"), `the value is never quoted: ${JSON.stringify(v)}`);
  }
  const r = startSettingRefusal(project(), { MASON_PG_PUBLIC_URL: "postgres://u:hunter2@db.example.com/?sslmode=require" }, { serve: true });
  assert.deepEqual(r && { code: r.code, fix: r.fix }, { code: "refused", fix: "set MASON_PG_PUBLIC_URL as mason serve --help says, or unset it" });
});

test("mason serve's: in its --help beside the other MASON_PG_* settings; mason start refuses it, naming it, valid or not", () => {
  assert.match(SERVE.usage, /\n {4}MASON_PG_PUBLIC_URL {5}the Postgres API's address as a client reaches it, behind a load balancer, a proxy or a DNS\n/);
  assert.match(SERVE.usage, /sslmode required \(disable, require, verify-ca, verify-full\), no user,\n\s+no password and no other parameter \(refused\)/);
  assert.ok(SERVE.usage.indexOf("MASON_PG_PUBLIC_URL") > SERVE.usage.indexOf("MASON_PG_TLS_CERT, MASON_PG_TLS_KEY") && SERVE.usage.indexOf("MASON_PG_PUBLIC_URL") < SERVE.usage.indexOf("MASON_PG_PROXY_FROM"));
  const refusal = { message: "MASON_PG_PUBLIC_URL is mason serve's setting, and mason start ignores no setting silently", code: "refused",
    fix: "unset MASON_PG_PUBLIC_URL: mason start prints the address it listens on, and mason serve the one a server's clients reach" };
  for (const v of ["postgres://db.example.com:5433/?sslmode=require", "postgres://u:hunter2@db.example.com/"]) {
    assert.deepEqual(startSettingRefusal(project(), { MASON_PG_PUBLIC_URL: v }, { serve: false }), refusal, v);
  }
  assert.equal(startSettingRefusal(project(), { MASON_PG_PUBLIC_URL: "" }, { serve: false }), null, "set empty is unset");
});

test("one builder: unset, every URL is the listener's as before; set, its host, port, database and sslmode, the run's database when it names none", () => {
  const own = { postgresUrl: "postgresql://localhost:5433/shop?sslmode=require" };
  assert.deepEqual(clientLink(own), pgUrl.postgresLink(own.postgresUrl), "unset: the recorded link");
  assert.deepEqual(clientLink({ ...own, postgresPublicUrl: null }), pgUrl.postgresLink(own.postgresUrl));
  assert.equal(pgUrl.connectionUrl(clientLink(own), "metabase", "pw"), "postgres://metabase:pw@localhost:5433/shop?sslmode=require");
  assert.equal(P.shownUrl!(clientLink(own)), "postgres://<user>:<password>@localhost:5433/shop?sslmode=require");
  for (const recorded of ["postgresql://127.0.0.1:5433/shop", "postgresql://[::1]:5433/Sales%20DB?sslmode=require", "postgresql://localhost:1/a%2Fb"]) {
    assert.equal(P.shownUrl!(clientLink({ postgresUrl: recorded })), recorded.replace(/^postgresql:\/\//, "postgres://<user>:<password>@"), `unset: the line printed before, ${recorded}`);
  }
  const pub = clientLink({ ...own, postgresPublicUrl: "postgresql://db.example.com:6432/?sslmode=verify-full" });
  assert.deepEqual(pub, { url: "postgresql://db.example.com:6432/shop?sslmode=verify-full", host: "db.example.com", port: 6432, database: "shop", sslmode: "verify-full", public: true });
  assert.equal(pgUrl.connectionUrl(pub, "metabase", "p@ss"), "postgres://metabase:p%40ss@db.example.com:6432/shop?sslmode=verify-full");
  assert.equal(clientLink({ ...own, postgresPublicUrl: "postgresql://[2001:db8::1]:5432/analytics?sslmode=disable" }).database, "analytics", "a database named: printed as it is");
  assert.equal(pgUrl.connectionUrl(clientLink({ ...own, postgresPublicUrl: "postgresql://[2001:db8::1]:5432/?sslmode=disable" }), "u", null), "postgres://u@[2001:db8::1]:5432/shop?sslmode=disable");
  // the listener's tips are for its own address: a public one has none
  const every = { host: "0.0.0.0", tls: "self-signed" as const, fingerprint: "AB:CD" };
  assert.equal(pgUrl.listenerTips(every, clientLink(own)).length, 2);
  assert.deepEqual(pgUrl.listenerTips(every, pub), []);
});

/** A run's command server over a project folder whose config records it, with MASON_PG_PUBLIC_URL's address or none. */
async function runningProject(postgresPublicUrl: string | null): Promise<{ app: string; ctx: RunContext; close: () => Promise<void> }> {
  const app = tmp("mpublic-run-");
  fs.mkdirSync(path.join(app, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(app, "mason", "sources", "shop.yml"), "kind: postgres\nurl: postgres://me@127.0.0.1:1/shop\ndatabase: shop\ntables: {}\n");
  fs.mkdirSync(path.join(app, ".mason"), { mode: 0o700 });
  const parsed = parseSource("postgres://me@localhost:5432/shop");
  assert.ok("source" in parsed);
  const postgresUrl = "postgresql://localhost:5433/shop?sslmode=require";
  const ctx = {
    page: true, served: true, users: { file: path.join(app, ".mason", "users.json"), apiKey: KEY, database: "shop", postgresUrl, ...(postgresPublicUrl === null ? {} : { postgresPublicUrl }) },
    source: parsed.source, facts: () => ({ version: 180000, versionText: "18", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null, port: 0,
    token: "t0ken-of-the-run", folder: () => path.join(app, "mason"), root: app, home: path.join(app, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => {}, log: () => {},
    readSource: () => ({ message: "not read here", code: "bad_source" }), runUrl: "postgres://me@localhost:5432/shop",
    listener: { openSessions: () => ({ open: 0, byClient: [] }), running: () => [], cancel: (session: number) => ({ unknown: session }) },
    logs: { capacity: 2000, recent: () => [] },
    duck: { copies: () => [], file: path.join(app, "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, unsupported: async () => [], page: async () => ({ requests: [], before: null }), slow: async () => [], refused: async () => ({ total: 0, refused: [] }),
        summary: async () => { throw new Error("not asked here"); }, window: async () => { throw new Error("not asked here"); }, clients: async () => ({ clients: [], total: { clients: 0, sessions: 0 } }),
        slowest: async () => [], durationsBy: async () => new Map(), lastUsed: async (u: unknown[]) => u.map(() => null) },
      events: { days: 7, recent: async () => [] }, usage: { days: 7, sampleSeconds: 60, samples: async () => [], copySizes: async () => [], statementTotals: () => ({ completed: 0, refused: 0, failed: 0, cancelled: 0, completedMs: 0 }), lastDurations: () => null },
      restarts: () => [] },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  ctx.port = (server.address() as { port: number }).port;
  fs.writeFileSync(path.join(app, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: KEY, sourceServer: null, served: true,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${ctx.port}`, token: ctx.token, postgresUrl, ...(postgresPublicUrl === null ? {} : { postgresPublicUrl }),
      postgresListener: { host: "0.0.0.0", tls: "self-signed", fingerprint: "AB:CD" } }, lastRun: null }), { mode: 0o600 });
  return { app, ctx, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("every surface beside a run prints the URL from the one builder: mason status, mason user add and list (text and --json), /api/state and the page's POST /api/users", async () => {
  const PUBLIC = "postgresql://db.example.com:6432/?sslmode=verify-full";
  const seen: Record<string, Record<string, unknown>> = {};
  for (const [label, recorded] of [["public", PUBLIC], ["unset", null]] as const) {
    const { app, ctx, close } = await runningProject(recorded);
    const run = (argv: string[]) => runMason(app, argv, matrixEnv());
    try {
      const st = await run(["status", "--json"]);
      assert.equal(st.code, 0, st.stdout + st.stderr);
      const stText = await run(["status"]);
      const add = await run(["user", "add", "metabase", "--json"]);
      assert.equal(add.code, 0, add.stdout + add.stderr);
      const addText = await run(["user", "add", "looker"]);
      assert.equal(addText.code, 0, addText.stdout + addText.stderr);
      const list = await run(["user", "list", "--json"]);
      const state = await (await fetch(`http://127.0.0.1:${ctx.port}/api/state`, { headers: { Authorization: `Bearer ${ctx.token}` } })).json() as { postgres: unknown };
      const page = await (await fetch(`http://127.0.0.1:${ctx.port}/api/users`, { method: "POST", headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "superset" }) })).json() as Record<string, unknown>;
      const a = JSON.parse(add.stdout) as Record<string, unknown>;
      seen[label] = { status: (JSON.parse(st.stdout) as { postgres: unknown }).postgres, statusText: stText.stdout, add: a, addText: addText.stdout,
        list: (JSON.parse(list.stdout) as { users: Array<{ name: string; url: unknown }> }).users.map((u) => [u.name, u.url]), state: state.postgres, page, password: a.password };
    } finally { await close(); }
  }
  const pub = seen.public!, own = seen.unset!;
  const listener = { host: "0.0.0.0", tls: "self-signed", fingerprint: "AB:CD" };
  // mason status: the address a client reaches, and the listener's own beside it
  assert.deepEqual(pub.status, { url: "postgresql://db.example.com:6432/shop?sslmode=verify-full", host: "db.example.com", port: 6432, database: "shop", sslmode: "verify-full", public: true,
    shown: "postgres://<user>:<password>@db.example.com:6432/shop?sslmode=verify-full", psql: "psql 'postgres://<user>:<password>@db.example.com:6432/shop?sslmode=verify-full'", listener });
  assert.deepEqual(own.status, { url: "postgresql://localhost:5433/shop?sslmode=require", host: "localhost", port: 5433, database: "shop", sslmode: "require",
    shown: "postgres://<user>:<password>@localhost:5433/shop?sslmode=require", psql: "psql 'postgres://<user>:<password>@localhost:5433/shop?sslmode=require'", listener });
  assert.match(pub.statusText as string, /^ {2}Postgres API +postgres:\/\/<user>:<password>@db\.example\.com:6432\/shop\?sslmode=verify-full {2}\(mason user add <name> makes a user\)$/m);
  assert.match(pub.statusText as string, /^ {2}Listener +0\.0\.0\.0:5433 \(every address of this machine\), TLS required/m, "the listener's own address stays its row");
  assert.match(own.statusText as string, /^ {2}Postgres API +postgres:\/\/<user>:<password>@localhost:5433\/shop\?sslmode=require {2}\(mason user add <name> makes a user\)$/m);
  // /api/state's postgres is mason status --json's, but the listener
  const { listener: _p, ...pubFacts } = pub.status as Record<string, unknown>;
  const { listener: _o, ...ownFacts } = own.status as Record<string, unknown>;
  assert.deepEqual(pub.state, pubFacts);
  assert.deepEqual(own.state, ownFacts);
  // mason user add: the URL, psql, host, port and sslmode from the same builder; the listener's tips only for its own address
  const pw = pub.password as string;
  const pwOwn = own.password as string;
  const addOf = (r: Record<string, unknown>) => ({ url: r.url, psql: r.psql, host: r.host, port: r.port, sslmode: r.sslmode, database: r.database });
  assert.deepEqual(addOf(pub.add as Record<string, unknown>), { url: `postgres://metabase:${encodeURIComponent(pw)}@db.example.com:6432/shop?sslmode=verify-full`,
    psql: `psql 'postgres://metabase:${encodeURIComponent(pw)}@db.example.com:6432/shop?sslmode=verify-full'`, host: "db.example.com", port: 6432, sslmode: "verify-full", database: "shop" });
  assert.deepEqual(addOf(own.add as Record<string, unknown>), { url: `postgres://metabase:${encodeURIComponent(pwOwn)}@localhost:5433/shop?sslmode=require`,
    psql: `psql 'postgres://metabase:${encodeURIComponent(pwOwn)}@localhost:5433/shop?sslmode=require'`, host: "localhost", port: 5433, sslmode: "require", database: "shop" });
  assert.match(pub.addText as string, /^ {2}url +postgres:\/\/looker:[^@\s]+@db\.example\.com:6432\/shop\?sslmode=verify-full$/m);
  assert.match(pub.addText as string, /^ {2}host +db\.example\.com\n {2}port +6432\n {2}ssl mode +verify-full$/m);
  assert.doesNotMatch(pub.addText as string, /put this machine's address|self-signed/, "no tip about the listener's own address");
  assert.match(own.addText as string, /^ {2}url +postgres:\/\/looker:[^@\s]+@localhost:5433\/shop\?sslmode=require$/m);
  assert.match(own.addText as string, /put this machine's address or name in place of localhost/, "unset: the tip, as before");
  // mason user list: each user's URL without its password
  assert.deepEqual(pub.list, [["metabase", "postgres://metabase@db.example.com:6432/shop?sslmode=verify-full"], ["looker", "postgres://looker@db.example.com:6432/shop?sslmode=verify-full"]]);
  assert.deepEqual(own.list, [["metabase", "postgres://metabase@localhost:5433/shop?sslmode=require"], ["looker", "postgres://looker@localhost:5433/shop?sslmode=require"]]);
  // the page's Add a user (POST /api/users): the same builder
  const pageAdd = pub.page as { url: string; host: string; port: number; sslmode: string; password: string };
  assert.deepEqual([pageAdd.url, pageAdd.host, pageAdd.port, pageAdd.sslmode], [`postgres://superset:${encodeURIComponent(pageAdd.password)}@db.example.com:6432/shop?sslmode=verify-full`, "db.example.com", 6432, "verify-full"]);
  assert.match((own.page as { url: string }).url, /^postgres:\/\/superset:[^@]+@localhost:5433\/shop\?sslmode=require$/);
});
