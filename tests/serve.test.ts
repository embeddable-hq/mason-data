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
import { newConfig, readProject, writeConfig } from "../src/cli/project.ts";
import type { CopyState } from "../src/duck/sync.ts";
import { unassignedPort } from "./test-ports.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { serveSettings, serveConfig, serveSource, healthBody } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { healthServer } = serveModule as unknown as typeof import("../src/cli/serve.ts");
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
    /MASON_CHANGES="cdc": poll or replication/, /MASON_PG_SELF_SIGNED_TLS="yes": 1, or 0/, /MASON_HEALTH_PORT="99999": a port number/]) assert.match(wrong.message, said);
  // a setting that is no longer read refuses the start, naming the line to write instead (never runs a default)
  assert.ok(wrong.message.includes("MASON_POLL_MS=30000 is no longer read: how often each table is polled is its sync: in the sources file — " +
    "write sync: poll 30s at its top (every table) or on a table's entry, then unset MASON_POLL_MS"), wrong.message);
  assert.match(wrong.message, /^7 settings are missing or wrong/);

  const s = serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY }, "/srv");
  assert.ok(!("message" in s));
  assert.deepEqual(s, { name: "mason", apiKey: KEY, changes: null, selfSignedTls: false, project: "/srv/mason", data: "/srv",
    health: { host: "0.0.0.0", port: 4140 } });
  const t = serveSettings({ DATABASE_URL: URL_, MASON_API_KEY: KEY, MASON_PROJECT: "/mason/project", MASON_DATA: "/mason/data", MASON_NAME: "shop",
    MASON_CHANGES: "replication", MASON_PG_SELF_SIGNED_TLS: "1", MASON_HEALTH_PORT: "8080", MASON_HEALTH_HOST: "127.0.0.1" }, "/srv");
  assert.ok(!("message" in t));
  assert.deepEqual([t.project, t.data, t.name, t.changes, t.selfSignedTls, t.health], ["/mason/project", "/mason/data", "shop", "replication", true, { host: "127.0.0.1", port: 8080 }]);
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
    assert.match(fresh.said[0]!, /a new copy in .*\.mason$/);

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
    assert.match(renamed.message, /the copy in .* is the project mason, and MASON_NAME says shop/);
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
    assert.deepEqual(made, { wrote: path.join(dir, "project", "sources", "app.yml") });
    // the file there now: read as the run reads it, its URL from this environment
    assert.deepEqual(serveSource(s, { DATABASE_URL: URL_ }), { wrote: null });
    const gone = serveSource(s, {});
    assert.ok("message" in gone);
    assert.match(gone.message, /: url: \$\{DATABASE_URL\} is not set — not in the environment, \.env\.local or \.env$/);
    // the settings say it too, with the variable the file names: the platform sets it before the first deploy
    assert.match((serveSettings({ MASON_API_KEY: KEY, MASON_DATA: dir, MASON_PROJECT: path.join(dir, "project") }, "/") as { message: string }).message,
      /^a setting is missing or wrong: DATABASE_URL is not set: the database to copy from, as the sources file's url: \$\{DATABASE_URL\} names it$/);
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
  const ready = healthBody({ phase: "ready", tables: () => [copy("public.orders", "copied"), copy("public.users", "copying"), copy("sales.secret_ledger", "failed")] }, t0, t0 + 60_000);
  assert.equal(ready.status, 200, "a table that failed leaves the rest served");
  assert.deepEqual(ready.body.tables, { total: 3, copied: 1, copying: 1, waiting: 0, failed: 1 });
  assert.doesNotMatch(JSON.stringify(ready.body), /orders|users|secret_ledger|boom/, "the endpoint takes no credential");
});

test("GET /metrics on the health port: 200 in Prometheus's text format while it starts and once it serves; /healthz as it was; another path 404", async () => {
  const t0 = Date.now() - 90_000;
  const copy = (source: string, phase: CopyState["phase"]): CopyState => ({ source, phase, rows: null, bytes: null, seconds: null, copiedAt: null, error: null });
  const usage = { copyBytes: 4_096, totals: { added: 2, copied: 1, failed: 0, rows: 10 }, oldestSyncSeconds: 3, streamLag: null, copied: ["public.secret_orders"],
    slotWalHeldBytes: null, diskFreeBytes: 1_000_000, sessionsOpen: 2, tables: { total: 2, copied: 1, copying: 1, waiting: 0, failed: 0 } };
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
      metrics: async () => { if (broken) throw new Error("the copy of public.secret_orders on db.internal could not be read"); return { usage, statements, durations: null }; } };
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
    fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({
      name: "shop", source: "postgres://mason:secret@127.0.0.1:1/shop", folder: "mason", remote: false, apiKey: KEY,
      sourceServer: null, lastRun: null, running: null,
    }), { mode: 0o600 });
    const env = matrixEnv({ HOME: path.join(root, "home"), PATH: path.dirname(process.execPath), MASON_POLL_MS: "30000" });
    for (const attach of [false, true]) {
      const p = await runMason(root, ["start", ...(attach ? ["--attach"] : [])], env);
      assert.equal(p.code, 1, p.stdout + p.stderr);
      assert.match(p.stderr, /^✗ mason start: MASON_POLL_MS=30000 is no longer read\n {2}why {3}how often each table is polled is its sync: in the sources file\n {2}fix {3}write sync: poll 30s at its top \(every table\) or on a table's entry, then unset MASON_POLL_MS$/m,
        `${attach ? "the run itself" : "before it spawns"}:\n${p.stdout}${p.stderr}`);
      assert.doesNotMatch(p.stdout + p.stderr, /Connecting to/, "refused before the database is connected to");
    }
    const j = await runMason(root, ["start", "--json"], env);
    assert.equal(j.code, 1, j.stdout + j.stderr);
    assert.deepEqual((JSON.parse(j.stdout) as { error: unknown }).error, { code: "refused", message: "MASON_POLL_MS=30000 is no longer read",
      why: "how often each table is polled is its sync: in the sources file", fix: "write sync: poll 30s at its top (every table) or on a table's entry, then unset MASON_POLL_MS" });
    assert.ok(!fs.existsSync(path.join(root, ".mason", "dev.log")), "nothing was spawned");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("MASON_CHANGES against the sources file is refused with the other settings, before anything is written or connected; one that agrees is taken", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-serve-changes-"));
  try {
    fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
    const file = (text: string): void => fs.writeFileSync(path.join(dir, "mason", "sources", "app.yml"), text);
    const env = { DATABASE_URL: URL_, MASON_API_KEY: KEY };
    file("kind: postgres\nurl: ${DATABASE_URL}\nsync: poll 5m\ntables:\n  orders: { sync: replication }\n");
    const refused = serveSettings({ ...env, MASON_CHANGES: "poll" }, dir);
    assert.ok("message" in refused);
    assert.equal(refused.message, "a setting is missing or wrong: MASON_CHANGES=poll polls every table, and mason/sources/app.yml streams orders (sync: replication) — " +
      "write sync: poll 5m (or off) on the entry of orders — or keep the file as it is — then unset MASON_CHANGES, then start again");
    assert.equal(fs.readdirSync(dir).join(","), "mason", "nothing written beside the project: no .mason/");
    file("kind: postgres\nurl: ${DATABASE_URL}\nsync: replication\ntables:\n  orders: {}\n");
    assert.ok(!("message" in serveSettings({ ...env, MASON_CHANGES: "replication" }, dir)), "every table replicated: it agrees");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a MASON_HISTORY_DAYS that is not a number of days refuses mason serve (on its one report) and mason start (before it spawns, in the run, and --json) in the Failure shape, before anything opens", async () => {
  const why = "it is how many days Mason keeps its history (the request log, the sync's events, the usage samples and the copies' sizes): a whole number, 1 or more";
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
  const why = "it was renamed MASON_HISTORY_DAYS, since the days it keeps are every history's (the request log, the sync's events, the usage samples and the copies' sizes)";
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
