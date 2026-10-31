/**
 * `mason serve` (src/cli/serve.ts): Mason on a server or in a container, configured by the environment. Its
 * settings are every one said at once, its state is the data folder's own (a developer's project is never taken over,
 * a renamed copy refused), and /healthz answers before the database does, 503 until the run answers, counts only.
 * The run itself against a real Postgres, its health turning 200 and its stop on SIGTERM: tests/integration/duck-serve.itest.ts.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as serveModule from "../src/cli/serve.ts";
import { cliPinProblem } from "../src/cli/pin.ts";
import { newConfig, readProject, writeConfig } from "../src/cli/project.ts";
import { imagePinProblem } from "../src/lib/project-version.ts";
import type { CopyState } from "../src/duck/sync.ts";
import { unassignedPort } from "./test-ports.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { serveSettings, serveConfig, serveSource, healthBody } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { healthServer, serveRecordRefusal } = serveModule as unknown as typeof import("../src/cli/serve.ts");
// imported when the tests run: the file loads at a commit without the module, and a test that needs it fails by name
const sourcesModule = await import("../src/cli/sources.ts" as string).catch(() => ({})) as Record<string, unknown>;
const readSource = (sourcesModule.readSource ?? (() => ({ message: "no sources module at this commit" }))) as typeof import("../src/cli/sources.ts").readSource;

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const KEY = "k".repeat(48);
const URL_ = "postgres://mason:secret@db.internal:5432/app";

test("the settings: every one missing or wrong said at once, each with what to set; the defaults otherwise", () => {
  const none = serveSettings({}, "/srv");
  assert.ok("message" in none);
  assert.equal(none.code, "bad_config");
  // the database's URL is a setting like the others: an unset one and a missing key on ONE report, one deploy (the review
  // of the sources file: they took two)
  assert.equal(none.message, "2 settings are missing or wrong: DATABASE_URL is not set, and the project folder (/srv/mason) has no sources file to name " +
    "the database another way; MASON_API_KEY is not set: what the users' passwords are made with (mason user add; openssl rand -hex 24 makes one)");
  const wrong = serveSettings({ DATABASE_URL: "mysql://x", MASON_API_KEY: "short", MASON_NAME: "Big Name", MASON_CHANGES: "cdc",
    MASON_PG_SELF_SIGNED_TLS: "yes", MASON_HEALTH_PORT: "99999", MASON_POLL_MS: "30000" }, "/srv");
  assert.ok("message" in wrong);
  for (const said of [/DATABASE_URL: the URL's scheme is mysql/, /MASON_API_KEY is 5 characters: at least 32/, /MASON_NAME="Big Name" is not a project name/,
    /MASON_PG_SELF_SIGNED_TLS="yes": 1, or 0/, /MASON_HEALTH_PORT="99999": a port number/]) assert.match(wrong.message, said);
  // a setting that is no longer read refuses the start, naming the line to write instead (never runs a default)
  assert.ok(wrong.message.includes("MASON_POLL_MS=30000 is no longer read: how often each table is polled is its sync: in the sources file — " +
    "write sync: poll 30s at the top of mason/sources/<name>.yml (every table; a table's entry may say its own), then unset MASON_POLL_MS"), wrong.message);
  assert.ok(wrong.message.includes("MASON_CHANGES=cdc is no longer read: how each table is kept current is its sync: in the sources file (at the top for every table, " +
    "on an entry for that one), so what runs is what is committed — write sync: replication or sync: poll 5m at the top of mason/sources/<name>.yml (every table; " +
    "a table's entry may say its own), then unset MASON_CHANGES"), wrong.message);
  assert.match(wrong.message, /^7 settings are missing or wrong/);

  const s = serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY }, "/srv");
  assert.ok(!("message" in s));
  assert.deepEqual(s, { name: "mason", apiKey: KEY, selfSignedTls: false, project: "/srv/mason", data: "/srv",
    health: { host: "0.0.0.0", port: 4140 }, ui: { port: 4039, named: false } });
  const t = serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY, MASON_PROJECT: "/mason/project", MASON_DATA: "/mason/data", MASON_NAME: "shop",
    MASON_PG_SELF_SIGNED_TLS: "1", MASON_HEALTH_PORT: "8080", MASON_HEALTH_HOST: "127.0.0.1" }, "/srv");
  assert.ok(!("message" in t));
  assert.deepEqual([t.project, t.data, t.name, t.selfSignedTls, t.health], ["/mason/project", "/mason/data", "shop", true, { host: "127.0.0.1", port: 8080 }]);
});

test("the config: new on an empty volume, resumed over what the runs recorded; a developer's project and a renamed copy refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-"));
  try {
    const s = serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY, MASON_DATA: dir, MASON_PROJECT: "/mason/project" }, "/");
    assert.ok(!("message" in s));
    const fresh = serveConfig(s, readProject(dir));
    assert.ok("config" in fresh);
    assert.equal(fresh.config.served, true);
    assert.equal(fresh.config.remote, true, "a server's database is on another machine, on purpose");
    assert.deepEqual([fresh.config.name, fresh.config.apiKey, fresh.config.folder], ["mason", KEY, "/mason/project"]);
    assert.equal("source" in fresh.config, false, "the database's URL is the sources file's, never the config's");
    assert.match(fresh.said[0]!, /new synced data in .*\.mason$/);

    // what a run recorded stays; the environment's settings are written again
    // (a config an older serve wrote carries the URL: it goes)
    writeConfig(path.join(dir, ".mason"), { ...fresh.config, sourceServer: { systemIdentifier: "7", database: "app" }, publication: "app_pub", changes: "replication", source: URL_ } as typeof fresh.config);
    const rotated = serveConfig({ ...s, apiKey: "n".repeat(48) }, readProject(dir));
    assert.ok("config" in rotated);
    assert.deepEqual(rotated.config.sourceServer, { systemIdentifier: "7", database: "app" });
    assert.deepEqual([rotated.config.publication, rotated.config.changes, rotated.config.apiKey, "source" in rotated.config],
      ["app_pub", "replication", "n".repeat(48), false]);
    assert.deepEqual(rotated.said.slice(1), ["MASON_API_KEY changed: every mason user is removed (mason user add each again)"]);

    const renamed = serveConfig({ ...s, name: "shop" }, readProject(dir));
    assert.ok("message" in renamed);
    assert.match(renamed.message, /the synced data in .* is the project mason, and MASON_NAME says shop/);
    assert.match(renamed.fix!, /set MASON_NAME=mason again, or give the new name a new MASON_DATA/);

    // a project mason init made: the developer's, never overwritten from the environment
    writeConfig(path.join(dir, ".mason"), newConfig("mason", "mason", false));
    const theirs = serveConfig(s, readProject(dir));
    assert.ok("message" in theirs);
    assert.equal(theirs.code, "refused");
    assert.match(theirs.message, /is a project mason init made, and mason serve keeps its own state/);

    fs.writeFileSync(path.join(dir, ".mason", "config.json"), "{");
    const broken = serveConfig(s, readProject(dir));
    assert.ok("message" in broken);
    assert.equal(broken.code, "bad_config");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason serve refuses what its volume's 0.7.0 config records and the sources file does not say, before the volume or the project folder is written; each way through passes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-record-"));
  try {
    const data = path.join(dir, "data"), project = path.join(dir, "project");
    const env = { DATABASE_URL: "postgres://mason:secret@127.0.0.1:1/app", MASON_API_KEY: KEY, MASON_DATA: data, MASON_PROJECT: project, MASON_NAME: "shop" };
    const s = serveSettings(env, "/");
    assert.ok(!("message" in s));
    const replication = { slot: "mason_dev_shop_app", publication: "app_pub", owned: false };
    fs.mkdirSync(path.join(data, ".mason"), { recursive: true });
    // no sources file yet: serve would write one saying sync: off, which is no one's choice
    writeConfig(path.join(data, ".mason"), { ...newConfig("shop", project, true), apiKey: KEY, served: true, changes: "replication", publication: "app_pub", replication });
    const was = fs.readFileSync(path.join(data, ".mason", "config.json"), "utf8");
    const serveNow = async (): Promise<{ code: number | null; json: string }> => {
      const child = spawn(process.execPath, [MAIN, "serve", "--json"], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let json = "";
      child.stdout.on("data", (d) => { json += String(d); });
      return { code: await new Promise<number | null>((r) => child.once("exit", r)), json };
    };
    const none = await serveNow();
    assert.equal(none.code, 1, none.json);
    const first = JSON.parse(none.json) as { error: { code: string; message: string }; next: Array<{ command: string }> };
    assert.deepEqual([first.error.code, first.error.message], ["refused", "this project streams, and it has no sources file to say so"]);
    assert.deepEqual(first.next.map((n) => n.command), ["mason serve"]);
    assert.equal(fs.existsSync(project), false, "no sources file written");
    assert.equal(fs.readFileSync(path.join(data, ".mason", "config.json"), "utf8"), was, "the volume as it was");

    // the file 0.7.0 ran: silent, and both records said on one report
    fs.mkdirSync(path.join(project, "sources"), { recursive: true });
    const file = path.join(project, "sources", "app.yml");
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n");
    const silent = await serveNow();
    assert.equal(silent.code, 1, silent.json);
    const e = (JSON.parse(silent.json) as { error: { message: string; fix: string } }).error;
    assert.equal(e.message, "this project streams, and project/sources/app.yml does not say so: no sync: at its top or on an entry");
    assert.match(e.fix, /write sync: replication and publication: app_pub at the top of project\/sources\/app\.yml/);
    assert.equal(fs.readFileSync(path.join(data, ".mason", "config.json"), "utf8"), was);

    // sync: replication alone: the publication is still unnamed
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: replication\ntables:\n  orders: {}\n");
    const unnamed = serveRecordRefusal(s, readProject(data), env);
    assert.equal(unnamed?.message, "this project reads publication app_pub, and project/sources/app.yml does not name it");
    assert.equal(serveRecordRefusal(s, readProject(data), { ...env, PG_PUBLICATION: "app_pub" }), null, "named by the setting a server sets");
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: replication\npublication: app_pub\ntables:\n  orders: {}\n");
    assert.equal(serveRecordRefusal(s, readProject(data), env), null);
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: replication\npublication: null\ntables:\n  orders: {}\n");
    assert.equal(serveRecordRefusal(s, readProject(data), env), null);
    // the file says it does not stream: the run drops what was made, as it did
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: poll 5m\ntables:\n  orders: {}\n");
    assert.equal(serveRecordRefusal(s, readProject(data), env), null);
    // a file that cannot be read is the next step's to say, and a project init made is serveConfig's
    fs.writeFileSync(file, "kind: nope\n");
    assert.equal(serveRecordRefusal(s, readProject(data), env), null);
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n");
    writeConfig(path.join(data, ".mason"), { ...newConfig("shop", project, false), changes: "replication" });
    assert.equal(serveRecordRefusal(s, readProject(data), env), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("MASON_PG_DATABASE names the database a tool connects with where the sources file does not, is never MASON_NAME's, and the two never disagree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-db-"));
  try {
    const project = path.join(dir, "project");
    const env = { DATABASE_URL: URL_, MASON_API_KEY: KEY, MASON_DATA: dir, MASON_PROJECT: project, MASON_NAME: "shop" };
    const s = serveSettings(env, "/");
    assert.ok(!("message" in s));
    // no file: the one a serve writes names no database, and the setting says it
    assert.equal((serveSource(s, env) as { database: string }).database, "mason", "MASON_NAME is the project's, never the database a tool connects with");
    assert.equal((serveSource(s, { ...env, MASON_PG_DATABASE: "Production" }) as { database: string }).database, "Production");
    assert.doesNotMatch(fs.readFileSync(path.join(project, "sources", "app.yml"), "utf8"), /^database:/m, "the setting is the setting's: nothing written");
    const bad = serveSettings({ ...env, MASON_PG_DATABASE: "${DB}" }, "/");
    assert.ok("message" in bad);
    assert.match(bad.message, /^a setting is missing or wrong: MASON_PG_DATABASE: "\$\{DB\}" is a variable/);
    // a sources file's own name: the setting may repeat it, and may not contradict it
    fs.writeFileSync(path.join(project, "sources", "app.yml"), "kind: postgres\nurl: ${DATABASE_URL}\ndatabase: production\ntables: {}\n");
    assert.ok(!("message" in serveSettings({ ...env, MASON_PG_DATABASE: "production" }, "/")));
    assert.equal((serveSource(s, env) as { database: string }).database, "production", "the file's, with no setting");
    const both = serveSettings({ ...env, MASON_PG_DATABASE: "reporting" }, "/");
    assert.ok("message" in both);
    assert.equal(both.message, "a setting is missing or wrong: MASON_PG_DATABASE=\"reporting\", and the sources file says database: production: keep one");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the sources file: one a folder lacks is written from DATABASE_URL, without it the way out is said; one there is read as the run reads it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-src-"));
  try {
    const s = serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY, MASON_DATA: dir, MASON_PROJECT: path.join(dir, "project") }, "/");
    assert.ok(!("message" in s));
    const unset = serveSource(s, {});
    assert.ok("message" in unset);
    assert.deepEqual([unset.code, unset.message], ["bad_config", "DATABASE_URL is not set, and the project folder has no sources file to name the database another way"]);
    assert.ok(!fs.existsSync(path.join(dir, "project", "sources")), "nothing written");
    const made = serveSource(s, { DATABASE_URL: URL_ });
    assert.deepEqual(made, { wrote: path.join(dir, "project", "sources", "app.yml"), database: "mason" });
    // the file there now: read as the run reads it, its URL from this environment
    assert.deepEqual(serveSource(s, { DATABASE_URL: URL_ }), { wrote: null, database: "mason" });
    const gone = serveSource(s, {});
    assert.ok("message" in gone);
    assert.match(gone.message, /: url: \$\{DATABASE_URL\} is not set — not in the environment, \.env\.local or \.env$/);
    // the settings say it too, with the variable the file names: the platform sets it before the first deploy
    assert.match((serveSettings({ MASON_API_KEY: KEY, MASON_DATA: dir, MASON_PROJECT: path.join(dir, "project") }, "/") as { message: string }).message,
      /^a setting is missing or wrong: DATABASE_URL is not set: the database to sync from, as the sources file's url: \$\{DATABASE_URL\} names it$/);
    // a server is configured by its environment: a .env in its data folder never overrides the platform's DATABASE_URL
    fs.writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgres://someone@elsewhere:5432/other\n");
    const r = readSource(path.join(dir, "project"), dir, { DATABASE_URL: URL_ }, { shellFirst: true });
    assert.deepEqual("resolved" in r ? [r.resolved, r.from] : r, [URL_, "DATABASE_URL in the environment"]);
    // an older Mason's project: no file written beside its folder, the way out said (mason init); nothing migrated
    const old = path.join(dir, "old");
    fs.mkdirSync(path.join(old, "models"), { recursive: true });
    const moved = serveSource({ ...s, project: old }, { DATABASE_URL: URL_ });
    assert.ok("message" in moved);
    assert.equal(moved.code, "bad_source");
    assert.match(moved.fix ?? "", /^mason init writes old\/sources\/ \(then mason add each table again\); remove old\/models\/ afterwards$/);
    assert.ok(!fs.existsSync(path.join(old, "sources")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("/healthz: 503 while it starts and stops, 200 once it answers whatever its copies do, counts and never a table's name", () => {
  const t0 = Date.parse("2026-10-26T10:00:00Z");
  const starting = healthBody({ phase: "starting" }, t0, t0 + 5_500);
  assert.equal(starting.status, 503);
  assert.deepEqual({ ...starting.body, version: "-" }, { status: "starting", version: "-", uptimeSeconds: 5 });
  assert.equal(healthBody({ phase: "stopping" }, t0, t0).status, 503);
  const copy = (source: string, phase: CopyState["phase"]): CopyState => ({ source, phase, rows: null, bytes: null, seconds: null, copiedAt: null, error: phase === "failed" ? "boom" : null });
  const ready = healthBody({ phase: "ready", tables: () => [copy("public.orders", "copied"), copy("public.users", "copying"), copy("sales.secret_ledger", "failed")],
    metrics: async () => { throw new Error("/healthz never reads the metrics"); } }, t0, t0 + 60_000);
  assert.equal(ready.status, 200, "a table that failed leaves the rest served");
  assert.deepEqual(ready.body.tables, { total: 3, copied: 1, copying: 1, waiting: 0, failed: 1 });
  assert.doesNotMatch(JSON.stringify(ready.body), /orders|users|secret_ledger|boom/, "the endpoint takes no credential");
});

test("GET /metrics on the health port: 200 in Prometheus's text format while it starts and once it serves; /healthz as it was; another path 404", async () => {
  const t0 = Date.now() - 90_000;
  const copy = (source: string, phase: CopyState["phase"]): CopyState => ({ source, phase, rows: null, bytes: null, seconds: null, copiedAt: null, error: null });
  const usage = { copyBytes: 4_096, totals: { added: 2, copied: 1, failed: 0, rows: 10 }, oldestSyncSeconds: 3, streamLag: null, copied: ["public.secret_orders"],
    slotWalHeldBytes: null, diskFreeBytes: 1_000_000, sessionsOpen: 2, tables: { total: 2, copied: 1, copying: 1, waiting: 0, failed: 0 },
    streamLagReadAt: null, slotWalReadAt: null };
  const statements = { completed: 5, refused: 1, failed: 0, cancelled: 0, completedMs: 50 };
  let broken = false;
  type Phase = Parameters<typeof healthBody>[0];
  let state: Phase = { phase: "starting" };
  const logged: string[] = [];
  const server = healthServer(() => state, t0, (l: string) => { logged.push(l); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const get = async (p: string, method = "GET"): Promise<{ status: number; type: string | null; body: string }> => {
    const r = await fetch(`${base}${p}`, { method });
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  };
  const TYPE = "text/plain; version=0.0.4; charset=utf-8";
  try {
    const starting = await get("/metrics");
    assert.deepEqual([starting.status, starting.type], [200, TYPE], "a scrape never fails while Mason starts");
    assert.match(starting.body, /^mason_ready 0$/m);
    assert.match(starting.body, /^mason_info\{version="[^"]+"\} 1$/m);
    assert.doesNotMatch(starting.body, /^mason_(tables|uptime_seconds|statements_total)/m, "nothing of the run before it serves");
    // /healthz as it was: 503 and JSON while it starts
    const health = await get("/healthz");
    assert.deepEqual([health.status, health.type, (JSON.parse(health.body) as { status: string }).status], [503, "application/json", "starting"]);
    state = { phase: "ready", tables: () => [copy("public.secret_orders", "copied"), copy("public.users", "copying")],
      metrics: async () => { if (broken) throw new Error("the copy of public.secret_orders on db.internal could not be read"); return { usage, statements, durations: null, at: Date.now(), freshSeconds: 120 }; } };
    const ready = await get("/metrics");
    assert.deepEqual([ready.status, ready.type], [200, TYPE]);
    assert.match(ready.body, /^mason_ready 1$/m);
    assert.match(ready.body, /^mason_tables\{phase="copying"\} 1$/m);
    assert.match(ready.body, /^mason_statements_total\{outcome="completed"\} 5$/m);
    const up = Number(/^mason_uptime_seconds (\d+)$/m.exec(ready.body)?.[1]);
    const healthy = await get("/healthz");
    const h = JSON.parse(healthy.body) as { status: string; uptimeSeconds: number; tables: unknown };
    assert.deepEqual([healthy.status, h.status, h.tables], [200, "ready", { total: 2, copied: 1, copying: 1, waiting: 0, failed: 0 }]);
    assert.ok(Math.abs(up - h.uptimeSeconds) <= 1 && up >= 90, `/metrics' uptime is /healthz's: ${up}, ${h.uptimeSeconds}`);
    assert.ok(!ready.body.includes("secret_orders") && !healthy.body.includes("secret_orders"), "never a table's name");
    const head = await get("/metrics", "HEAD");
    assert.deepEqual([head.status, head.type, head.body], [200, TYPE, ""]);
    assert.equal((await get("/metrics", "POST")).status, 405);
    // the run's numbers that cannot be read fail the scrape, said in the log; the error's text (a name) never in the answer
    broken = true;
    const failed = await get("/metrics");
    assert.equal(failed.status, 500);
    assert.doesNotMatch(failed.body, /secret_orders|db\.internal/);
    assert.deepEqual(logged.map((l) => /secret_orders/.test(l)), [true], "said once, in the log");
    // stopping: as starting
    state = { phase: "stopping" };
    const stopping = await get("/metrics");
    assert.deepEqual([stopping.status, /^mason_ready 0$/m.test(stopping.body)], [200, true]);
    assert.equal((await get("/healthz")).status, 503);
    // any other path: 404, as before
    for (const p of ["/", "/metrics/", "/api/state"]) assert.equal((await get(p)).status, 404, p);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a serve answers /healthz before its database does: 503 starting while it connects; refused settings exit 1 in the failure shape", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-"));
  // a database that takes the connection and never answers: the run is still connecting while /healthz is asked
  const sockets: net.Socket[] = [];
  const db = net.createServer((sock) => { sockets.push(sock); }).listen(0, "127.0.0.1");
  await new Promise((r) => db.once("listening", r));
  const dbPort = (db.address() as net.AddressInfo).port;
  // the serve binds it later: a port out of the kernel's ephemeral range, so nothing is handed it meanwhile (tests/test-ports.ts)
  const health = await unassignedPort();
  const env = { PATH: process.env.PATH ?? "", HOME: dir, DATABASE_URL: `postgres://mason:secret@127.0.0.1:${dbPort}/app`, MASON_API_KEY: KEY,
    MASON_DATA: path.join(dir, "data"), MASON_PROJECT: path.join(dir, "project"), MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1" };
  fs.mkdirSync(env.MASON_DATA);
  const child = spawn(process.execPath, [MAIN, "serve"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  try {
    let answer: { status: number; body: Record<string, unknown> } | null = null;
    for (let i = 0; i < 100 && answer === null; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${health}/healthz`);
        answer = { status: r.status, body: await r.json() as Record<string, unknown> };
      } catch (e) {
        // not listening yet: asked again
        if (!/fetch failed/.test((e as Error).message)) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(answer, `/healthz never answered:\n${out}`);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.status, "starting");
    assert.equal((await fetch(`http://127.0.0.1:${health}/`)).status, 404);
    // /metrics beside it, on the same port: 200 while it starts, the run not ready yet
    const scrape = await fetch(`http://127.0.0.1:${health}/metrics`);
    assert.deepEqual([scrape.status, scrape.headers.get("content-type")], [200, "text/plain; version=0.0.4; charset=utf-8"]);
    assert.match(await scrape.text(), /^mason_ready 0$/m);
    for (let i = 0; i < 50 && !out.includes("/metrics"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, new RegExp(`\\n  health    http://127\\.0\\.0\\.1:${health}/healthz\\n  metrics   http://127\\.0\\.0\\.1:${health}/metrics\\n`), "its start says both");
    assert.match(fs.readFileSync(path.join(env.MASON_PROJECT, "sources", "app.yml"), "utf8"), /\nurl: \$\{DATABASE_URL\}.*\n[^]*\ntables: \{\}\n$/, "the project's sources file made, no table until one is added");
    const cfg = readProject(env.MASON_DATA);
    assert.ok(cfg && !("broken" in cfg) && cfg.config.served === true, "the state written to MASON_DATA");
    assert.doesNotMatch(out, /secret|k{48}/, "neither the database's password nor the API key is printed");
  } finally {
    child.kill("SIGTERM");
    await exited;
    for (const s of sockets) s.destroy();
    db.close();
  }

  const refused = spawn(process.execPath, [MAIN, "serve", "--json"], { cwd: dir, env: { PATH: env.PATH, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let json = "";
  refused.stdout.on("data", (d) => { json += String(d); });
  const code = await new Promise<number | null>((r) => refused.once("exit", r));
  assert.equal(code, 1);
  const v = JSON.parse(json) as { error: { code: string; message: string }; next: unknown[] };
  assert.equal(v.error.code, "bad_config");
  assert.match(v.error.message, /^2 settings are missing or wrong: DATABASE_URL is not set, .*; MASON_API_KEY is not set/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("mason start refuses MASON_POLL_MS too, before it spawns and in the run itself, in the Failure shape: the line to write, never a default", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-poll-ms-"));
  try {
    fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
    // the file has its sync: line already (as every file mason init writes): the way out changes it, never adds a second
    fs.writeFileSync(path.join(root, "mason", "sources", "shop.yml"), "kind: postgres\nurl: postgres://mason:secret@127.0.0.1:1/shop\nsync: off\ntables: {}\n");
    fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({
      name: "shop", source: "postgres://mason:secret@127.0.0.1:1/shop", folder: "mason", remote: false, apiKey: KEY,
      sourceServer: null, lastRun: null, running: null,
    }), { mode: 0o600 });
    const env = matrixEnv({ HOME: path.join(root, "home"), PATH: path.dirname(process.execPath), MASON_POLL_MS: "30000" });
    for (const attach of [false, true]) {
      const p = await runMason(root, ["start", ...(attach ? ["--attach"] : [])], env);
      assert.equal(p.code, 1, p.stdout + p.stderr);
      assert.match(p.stderr, /^✗ mason start: MASON_POLL_MS=30000 is no longer read\n {2}why {3}how often each table is polled is its sync: in the sources file\n {2}fix {3}change sync: off at the top of mason\/sources\/shop\.yml to sync: poll 30s \(every table; a table's entry may say its own\), then unset MASON_POLL_MS$/m,
        `${attach ? "the run itself" : "before it spawns"}:\n${p.stdout}${p.stderr}`);
      assert.doesNotMatch(p.stdout + p.stderr, /Connecting to/, "refused before the database is connected to");
    }
    const j = await runMason(root, ["start", "--json"], env);
    assert.equal(j.code, 1, j.stdout + j.stderr);
    assert.deepEqual((JSON.parse(j.stdout) as { error: unknown }).error, { code: "refused", message: "MASON_POLL_MS=30000 is no longer read",
      why: "how often each table is polled is its sync: in the sources file",
      fix: "change sync: off at the top of mason/sources/shop.yml to sync: poll 30s (every table; a table's entry may say its own), then unset MASON_POLL_MS" });
    assert.ok(!fs.existsSync(path.join(root, ".mason", "dev.log")), "nothing was spawned");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("MASON_CHANGES set is refused with the other settings, naming the sync: line to write in the project's sources file, before anything is written or connected; mason serve exits 1 in the failure shape", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-changes-"));
  try {
    fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
    fs.writeFileSync(path.join(dir, "mason", "sources", "app.yml"), "kind: postgres\nurl: ${DATABASE_URL}\nsync: replication\ntables:\n  orders: {}\n");
    const env = { DATABASE_URL: URL_, MASON_API_KEY: KEY };
    // whatever it says, even what the file says: the setting is gone, never read where it agrees
    // the file's top says sync: replication already: kept for replication, changed for poll — never a second sync: line
    const line = (v: string, edit: string): string => `a setting is missing or wrong: MASON_CHANGES=${v} is no longer read: how each table is kept current is its sync: in the sources file ` +
      `(at the top for every table, on an entry for that one), so what runs is what is committed — ${edit} (every table; a table's entry may say its own), then unset MASON_CHANGES`;
    const edits = { replication: "keep sync: replication at the top of mason/sources/app.yml", poll: "change sync: replication at the top of mason/sources/app.yml to sync: poll 5m" };
    for (const [v, sync] of Object.entries(edits)) {
      const refused = serveSettings({ ...env, MASON_CHANGES: v }, dir);
      assert.ok("message" in refused, v);
      assert.deepEqual([refused.code, refused.message], ["bad_config", line(v, sync)]);
    }
    assert.ok(!("message" in serveSettings({ ...env, MASON_CHANGES: "" }, dir)), "set empty is unset");
    assert.equal(fs.readdirSync(dir).join(","), "mason", "nothing written beside the project: no .mason/");
    const child = spawn(process.execPath, [MAIN, "serve", "--json"], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...env, MASON_CHANGES: "replication" }, stdio: ["ignore", "pipe", "pipe"] });
    let json = "";
    child.stdout.on("data", (d) => { json += String(d); });
    const code = await new Promise<number | null>((r) => child.once("exit", r));
    assert.equal(code, 1, json);
    const v = JSON.parse(json) as { error: { code: string; message: string; fix: string }; next: Array<{ command: string }> };
    assert.deepEqual([v.error.code, v.error.message], ["bad_config", line("replication", edits.replication)]);
    assert.deepEqual(v.next.map((n) => n.command), ["mason serve --help"]);
    assert.equal(fs.readdirSync(dir).join(","), "mason", "mason serve wrote nothing: no .mason/");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a MASON_HISTORY_DAYS that is not a number of days refuses mason serve (on its one report) and mason start (before it spawns, in the run, and --json) in the Failure shape, before anything opens", async () => {
  const why = "it is how many days Mason keeps its history (the request log, the sync's events, the usage samples and the synced tables' sizes): a whole number, 1 or more";
  const fix = "write MASON_HISTORY_DAYS=7 (the default, as when it is unset) or another whole number of days";
  for (const bad of ["abc", "0", "-1"]) {
    const served = serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY, MASON_HISTORY_DAYS: bad }, "/srv");
    assert.ok("message" in served, `${bad}: refused`);
    assert.equal(served.message, `a setting is missing or wrong: MASON_HISTORY_DAYS=${JSON.stringify(bad)} is not a number of days: ${why} — ${fix}`, bad);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-history-days-bad-"));
  try {
    fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
    fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({
      name: "shop", source: "postgres://mason:secret@127.0.0.1:1/shop", folder: "mason", remote: false, apiKey: KEY,
      sourceServer: null, lastRun: null, running: null,
    }), { mode: 0o600 });
    const env = matrixEnv({ HOME: path.join(root, "home"), PATH: path.dirname(process.execPath), MASON_HISTORY_DAYS: "abc" });
    const message = 'MASON_HISTORY_DAYS="abc" is not a number of days';
    for (const attach of [false, true]) {
      const p = await runMason(root, ["start", ...(attach ? ["--attach"] : [])], env);
      assert.equal(p.code, 1, p.stdout + p.stderr);
      assert.ok(p.stderr.includes(`✗ mason start: ${message}\n  why   ${why}\n  fix   ${fix}\n`),
        `${attach ? "the run itself" : "before it spawns"}:\n${p.stdout}${p.stderr}`);
      assert.doesNotMatch(p.stdout + p.stderr, /Connecting to|Opening the copy/, "refused before the database or the copy is touched");
    }
    assert.ok(!fs.existsSync(path.join(root, ".mason", "duck.db")), "the copy's file was never opened");
    const j = await runMason(root, ["start", "--json"], env);
    assert.equal(j.code, 1, j.stdout + j.stderr);
    assert.deepEqual((JSON.parse(j.stdout) as { error: unknown }).error, { code: "refused", message, why, fix });
    assert.ok(!fs.existsSync(path.join(root, ".mason", "dev.log")), "nothing was spawned");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("MASON_REQUEST_LOG_DAYS is MASON_HISTORY_DAYS now: set, it refuses mason serve (on its one report) and mason start (before it spawns and in the run), naming the line to write — never runs the default", async () => {
  const why = "it was renamed MASON_HISTORY_DAYS, since the days it keeps are every history's (the request log, the sync's events, the usage samples and the synced tables' sizes)";
  const fix = "write MASON_HISTORY_DAYS=30 instead, then unset MASON_REQUEST_LOG_DAYS";
  const served = serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY, MASON_REQUEST_LOG_DAYS: "30" }, "/srv");
  assert.ok("message" in served, "refused");
  assert.equal(served.message, `a setting is missing or wrong: MASON_REQUEST_LOG_DAYS=30 is no longer read: ${why} — ${fix}`);
  assert.ok(!("message" in serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY, MASON_HISTORY_DAYS: "30" }, "/srv")), "the new name is taken");
  assert.match(serveModule.SERVE.usage, /\n {4}MASON_HISTORY_DAYS {6}how many days Mason keeps its history: the request log, the sync's events, the usage\n/);
  assert.ok(!serveModule.SERVE.usage.includes("MASON_REQUEST_LOG_DAYS"), "the old name is not offered");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-history-days-"));
  try {
    fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
    fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
    fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({
      name: "shop", source: "postgres://mason:secret@127.0.0.1:1/shop", folder: "mason", remote: false, apiKey: KEY,
      sourceServer: null, lastRun: null, running: null,
    }), { mode: 0o600 });
    const env = matrixEnv({ HOME: path.join(root, "home"), PATH: path.dirname(process.execPath), MASON_REQUEST_LOG_DAYS: "30" });
    for (const attach of [false, true]) {
      const p = await runMason(root, ["start", ...(attach ? ["--attach"] : [])], env);
      assert.equal(p.code, 1, p.stdout + p.stderr);
      assert.ok(p.stderr.includes(`✗ mason start: MASON_REQUEST_LOG_DAYS=30 is no longer read\n  why   ${why}\n  fix   ${fix}\n`),
        `${attach ? "the run itself" : "before it spawns"}:\n${p.stdout}${p.stderr}`);
      assert.doesNotMatch(p.stdout + p.stderr, /Connecting to/, "refused before the database is connected to");
    }
    const j = await runMason(root, ["start", "--json"], env);
    assert.equal(j.code, 1, j.stdout + j.stderr);
    assert.deepEqual((JSON.parse(j.stdout) as { error: unknown }).error, { code: "refused", message: "MASON_REQUEST_LOG_DAYS=30 is no longer read", why, fix });
    assert.ok(!fs.existsSync(path.join(root, ".mason", "dev.log")), "nothing was spawned");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** A project mounted at MASON_PROJECT, pinned as `pin` says (no mason.yml for null), its sources file there, and a data
 *  folder of its own holding a mason/ that pins something else: a check reading the folder serve runs in sees that one. */
function mounted(dir: string, pin: string | null): { project: string; data: string; file: string } {
  const project = path.join(dir, "mounted"), data = path.join(dir, "volume");
  fs.mkdirSync(path.join(project, "sources"), { recursive: true });
  fs.mkdirSync(path.join(data, "mason"), { recursive: true });
  fs.writeFileSync(path.join(data, "mason", "mason.yml"), "version: 0.6.1\n");
  if (pin !== null) fs.writeFileSync(path.join(project, "mason.yml"), pin);
  fs.writeFileSync(path.join(project, "sources", "app.yml"), "kind: postgres\nurl: ${DATABASE_URL}\ntables: {}\n");
  return { project, data, file: path.join(project, "mason.yml") };
}

/** Everything a serve needs but a database: its URL names a port nothing listens on, so a run that gets past the checks
 *  fails at Connecting to. `version` is the image's MASON_VERSION; undefined is a checkout's `dev`. */
async function serveEnv(dir: string, m: { project: string; data: string }, version: string | undefined): Promise<Record<string, string>> {
  return matrixEnv({ HOME: dir, DATABASE_URL: "postgres://mason:secret@127.0.0.1:1/app", MASON_API_KEY: KEY, MASON_PROJECT: m.project, MASON_DATA: m.data,
    MASON_HEALTH_HOST: "127.0.0.1", MASON_HEALTH_PORT: String(await unassignedPort()), MASON_PG_PORT: String(await unassignedPort()),
    ...(version === undefined ? {} : { MASON_VERSION: version }) });
}

const IMAGE_WAY_OUT = (p: string): string => `run the image the project names (ghcr.io/embeddable-hq/mason-data:${p})`;
/** each direction a project can be pinned from image 0.6.1, as the image's whole message and way out */
const PIN_DIRECTIONS: ReadonlyArray<{ name: string; pin: string; message: (file: string) => string; fix: string }> = [
  { name: "a newer release line", pin: "0.7.0", message: (f) => `${f} pins Mason 0.7.0, and this mason image is 0.6.1: the project is written for a newer Mason`, fix: IMAGE_WAY_OUT("0.7.0") },
  { name: "an older release line", pin: "0.5.2", message: (f) => `${f} pins Mason 0.5.2, and this mason image is 0.6.1, a newer release line than 0.5.x, which may read the project differently`,
    fix: `${IMAGE_WAY_OUT("0.5.2")}, or upgrade the project: read the release notes of every version after 0.5.2 up to 0.6.1 (their "Before you upgrade"), change what they say, then set version: 0.6.1 in mason.yml` },
  { name: "the same line at a later patch", pin: "0.6.3", message: (f) => `${f} pins Mason 0.6.3, and this mason image is 0.6.1, older than it: the project may use a fix or a key 0.6.1 does not have`, fix: IMAGE_WAY_OUT("0.6.3") },
];

for (const d of PIN_DIRECTIONS) {
  test(`mason serve refuses a project pinned to ${d.name} in its own failure shape, text and --json, the mounted project's file named, before anything is written or connected`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-pin-"));
    try {
      const m = mounted(dir, `version: ${d.pin}\n`);
      // no sources file: one the serve would write in the project folder is written after the check, or never
      fs.rmSync(path.join(m.project, "sources"), { recursive: true });
      const env = await serveEnv(dir, m, "v0.6.1");
      const said = await runMason(dir, ["serve"], env);
      assert.equal(said.code, 1, said.stdout + said.stderr);
      assert.equal(said.stderr, `✗ mason serve: ${d.message(m.file)}\n  fix   ${d.fix}\n`);
      assert.equal(said.stdout, "", "no start line: it refused before it began");
      const json = await runMason(dir, ["serve", "--json"], env);
      assert.equal(json.code, 1, json.stdout + json.stderr);
      assert.deepEqual(JSON.parse(json.stdout), { error: { code: "refused", message: d.message(m.file), fix: d.fix }, next: [] });
      assert.equal(json.stderr, "");
      assert.deepEqual(fs.readdirSync(m.data), ["mason"], "the volume as it was: no .mason/");
      assert.deepEqual(fs.readdirSync(m.project), ["mason.yml"], "the project folder as it was: no sources file written");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("mason serve refuses a mason.yml it cannot read in its own failure shape, naming the file, before anything is written", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-pin-"));
  try {
    const m = mounted(dir, "version: soon\n");
    const j = await runMason(dir, ["serve", "--json"], await serveEnv(dir, m, "v0.6.1"));
    assert.equal(j.code, 1, j.stdout + j.stderr);
    assert.deepEqual(JSON.parse(j.stdout), { error: { code: "refused", message: `${m.file}: version "soon" is not a version (x.y.z, e.g. 0.5.1)`,
      fix: "correct mason.yml in the project folder (MASON_PROJECT), then start it again" }, next: [] });
    assert.deepEqual(fs.readdirSync(m.data), ["mason"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason serve run from the npm package is the mason command, never the image: its words and the npm way out, text and --json, exit 1, nothing written", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-pin-"));
  try {
    // the package's layout: this src/ beside the package.json version() reads, as npm installs it
    const pkg = path.join(dir, "pkg"), main = path.join(pkg, "src", "cli", "main.ts");
    fs.mkdirSync(pkg);
    fs.cpSync(path.resolve(path.dirname(MAIN), "..", "..", "src"), path.join(pkg, "src"), { recursive: true });
    fs.symlinkSync(path.resolve(path.dirname(MAIN), "..", "..", "node_modules"), path.join(pkg, "node_modules"));
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@mason-data/cli", version: "0.6.1", type: "module" }));
    const m = mounted(dir, "version: 0.7.0\n");
    fs.rmSync(path.join(m.project, "sources"), { recursive: true });
    const env = await serveEnv(dir, m, undefined);
    assert.equal((await runMason(dir, ["--version"], env, undefined, main)).stdout, "0.6.1\n");
    const message = `${m.file} pins Mason 0.7.0, and this mason command is 0.6.1: the project is written for a newer Mason`;
    const fix = "run the mason command it names: npm i -g @mason-data/cli@0.7.0 (or npx @mason-data/cli@0.7.0 …)";
    const said = await runMason(dir, ["serve"], env, undefined, main);
    assert.equal(said.code, 1, said.stdout + said.stderr);
    assert.equal(said.stderr, `✗ mason serve: ${message}\n  fix   ${fix}\n`);
    assert.equal(said.stdout, "");
    const json = await runMason(dir, ["serve", "--json"], env, undefined, main);
    assert.equal(json.code, 1, json.stdout + json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), { error: { code: "refused", message, fix }, next: [] });
    // the package's version is what runs, whatever the environment says: one fact, read in one order
    const stamped = await runMason(dir, ["serve", "--json"], { ...env, MASON_VERSION: "v0.7.0" }, undefined, main);
    assert.deepEqual((JSON.parse(stamped.stdout) as { error: unknown }).error, { code: "refused", message, fix });
    assert.deepEqual(fs.readdirSync(m.data), ["mason"], "the volume as it was: no .mason/");
    assert.deepEqual(fs.readdirSync(m.project), ["mason.yml"], "the project folder as it was");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason serve starts on a project it may run: the same line at the pin's patch or later, and no mason.yml; a build that is no release checks nothing, whatever the file says", async () => {
  const cases: Array<[string | undefined, string | null]> = [["v0.6.1", "version: 0.6.1\n"], ["v0.6.1", "version: 0.6.0\n"], ["v0.6.1", null],
    [undefined, "version: 9.9.9\n"], ["main-abc1234", "version: 9.9.9\n"], ["main-abc1234", "version: soon\n"]];
  for (const [version, pin] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-pin-"));
    try {
      const p = await runMason(dir, ["serve"], await serveEnv(dir, mounted(dir, pin), version));
      // past the check: stopped by the database nothing listens for, the state written
      assert.match(p.stdout, /▸ Connecting to /, `${version} on ${pin}:\n${p.stdout}${p.stderr}`);
      assert.doesNotMatch(p.stdout + p.stderr, /pins Mason|mason start:/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("the image's check: one rule from 1.0 too, its major the line; a project with no mason.yml and a build that is no release answer null", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-pin-"));
  try {
    const { project: at, file } = mounted(dir, "version: 1.2.0\n");
    assert.equal(imagePinProblem(at, "1.9.0"), null, "a later minor is the same line from 1.0");
    assert.deepEqual(imagePinProblem(at, "2.0.0"), { problem: `${file} pins Mason 1.2.0, and this mason image is 2.0.0, a newer release line than 1.x, which may read the project differently`,
      ways: [IMAGE_WAY_OUT("1.2.0"), 'upgrade the project: read the release notes of every version after 1.2.0 up to 2.0.0 (their "Before you upgrade"), change what they say, then set version: 2.0.0 in mason.yml'] });
    assert.equal(imagePinProblem(at, "dev"), null);
    assert.equal(imagePinProblem(at, "main-abc1234"), null);
    assert.equal(imagePinProblem(path.join(dir, "volume"), "9.0.0"), null, "no mason.yml is unpinned");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason start's words stay the command's: one line, its own way out, in each direction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-start-pin-"));
  try {
    const { project: at, file } = mounted(dir, "version: 0.7.0\n");
    const npm = (p: string): string => `Run the mason command it names: npm i -g @mason-data/cli@${p} (or npx @mason-data/cli@${p} …).`;
    assert.equal(cliPinProblem(at, "0.6.1"), `${file} pins Mason 0.7.0, and this mason command is 0.6.1: the project is written for a newer Mason. ${npm("0.7.0")}`);
    fs.writeFileSync(file, "version: 0.5.2\n");
    assert.equal(cliPinProblem(at, "0.6.1"), `${file} pins Mason 0.5.2, and this mason command is 0.6.1, a newer release line than 0.5.x, which may read the project differently. ${npm("0.5.2")} ` +
      `Or upgrade the project: read the release notes of every version after 0.5.2 up to 0.6.1 (their "Before you upgrade"), change what they say, then set version: 0.6.1 in mason.yml.`);
    fs.writeFileSync(file, "version: 0.6.3\n");
    assert.equal(cliPinProblem(at, "0.6.1"), `${file} pins Mason 0.6.3, and this mason command is 0.6.1, older than it: the project may use a fix or a key 0.6.1 does not have. ${npm("0.6.3")}`);
    fs.writeFileSync(file, "version: soon\n");
    assert.equal(cliPinProblem(at, "0.6.1"), `${file}: version "soon" is not a version (x.y.z, e.g. 0.5.1)`);
    assert.equal(cliPinProblem(at, "dev"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mason serve --help lists every setting a server sets: PG_PUBLICATION beside DATABASE_URL, with its default; MASON_CHANGES no more", () => {
  const usage = (serveModule as unknown as { SERVE: { usage: string } }).SERVE.usage;
  assert.match(usage, /^ {4}DATABASE_URL .*\n.*\n {4}PG_PUBLICATION {10}the publication the tables under sync: replication are read through, the database owner's,\n {28}never altered: the sources file's publication: first \(publication: \$\{PG_PUBLICATION\} reads\n {28}this one\), else this; default none: Mason makes its own\n/m);
  assert.doesNotMatch(usage, /MASON_CHANGES/);
});
