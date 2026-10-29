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

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { serveSettings, serveConfig, serveSource, healthBody } = serveModule as unknown as typeof import("../src/cli/serve.ts");
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
    MASON_PG_SELF_SIGNED_TLS: "yes", MASON_HEALTH_PORT: "99999" }, "/srv");
  assert.ok("message" in wrong);
  for (const said of [/DATABASE_URL: the URL's scheme is mysql/, /MASON_API_KEY is 5 characters: at least 32/, /MASON_NAME="Big Name" is not a project name/,
    /MASON_CHANGES="cdc": poll or replication/, /MASON_PG_SELF_SIGNED_TLS="yes": 1, or 0/, /MASON_HEALTH_PORT="99999": a port number/]) assert.match(wrong.message, said);
  assert.match(wrong.message, /^6 settings are missing or wrong/);

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
