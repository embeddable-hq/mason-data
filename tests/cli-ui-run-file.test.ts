/**
 * `MASON_UI_RUN_FILE` (src/cli/ui-run-file.ts): `mason serve` writes the page's port and the run's token to a file a
 * supervisor on the same machine reads, held to the bar of MASON_UI_SOCKET: 0600 from the moment it exists, in a folder
 * only Mason's user can write, never through a link, never over a file that is not one of its own (a stale one
 * replaced), written whole, removed on exit. `/healthz` and `mason status --json` say where the page is served (its
 * socket, or null) and whether it is read-only, `/healthz` from the start; the token is in neither. Without the
 * setting nothing changes; `mason start` refuses it.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DemoSource } from "../src/demo/source.ts";
import { runState, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";
import * as commands from "../src/cli/commands.ts";
import { unassignedPort } from "./test-ports.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const runFileModule = await import("../src/cli/ui-run-file.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-run-file.ts")>;
const missing = (): never => assert.fail("src/cli/ui-run-file.ts is not in this tree");
const uiRunFileSetting = runFileModule.uiRunFileSetting ?? missing;
const prepareUiRunFile = runFileModule.prepareUiRunFile ?? missing;
const writeUiRunFile = runFileModule.writeUiRunFile ?? missing;
const { serveSettings, SERVE, healthBody } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const KEY = "k".repeat(48);
const TOKEN = "t".repeat(64);
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
// a short folder: a socket's path is at most 107 bytes, and os.tmpdir() may be long
const temp = (): string => { const d = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "mrf-")); fs.chmodSync(d, 0o700); made.push(d); return d; };
const said: string[] = [];
const say = (l: string): void => { said.push(l); };
const uid = process.getuid!();

/** A port nothing listens on: a stale file's run, gone. */
async function deadPort(): Promise<number> {
  const s = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

test("the file is written whole, mode 0600 and Mason's user's from the moment it exists, whatever the umask; nothing else is left in the folder; it is removed only while it is the file written", () => {
  const dir = temp();
  const file = path.join(dir, "run.json");
  // a wide umask: the file is 0600 anyway, made so by its open before a byte is written
  const before = process.umask(0);
  let w: ReturnType<typeof writeUiRunFile>;
  try { w = writeUiRunFile(file, { port: 4039, token: TOKEN }, say); } finally { process.umask(before); }
  assert.ok(!("message" in w), JSON.stringify(w));
  const st = fs.lstatSync(file);
  assert.ok(st.isFile());
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(st.uid, uid);
  assert.equal(fs.readFileSync(file, "utf8"), `{"port":4039,"token":"${TOKEN}"}\n`, "the port and the token, nothing else");
  assert.deepEqual(fs.readdirSync(dir), ["run.json"], "no temporary file left beside it");
  w.remove();
  assert.equal(fs.existsSync(file), false, "removed");

  // another's file put at the path since is left as it is
  const again = writeUiRunFile(file, { port: 4039, token: TOKEN }, say);
  assert.ok(!("message" in again));
  fs.rmSync(file);
  fs.writeFileSync(file, "someone else's\n", { mode: 0o600 });
  again.remove();
  assert.equal(fs.readFileSync(file, "utf8"), "someone else's\n");

  // something at the path when it is written: refused, and left as it was (a link never replaces what is there)
  const refused = writeUiRunFile(file, { port: 4039, token: TOKEN }, say);
  assert.ok("message" in refused);
  assert.equal(refused.message, `MASON_UI_RUN_FILE=${file}: something was put at the path after the start checked it, and Mason writes over nothing`);
  assert.equal(fs.readFileSync(file, "utf8"), "someone else's\n");
  assert.deepEqual(fs.readdirSync(dir), ["run.json"], "its temporary removed");
  assert.ok(!JSON.stringify(refused).includes(TOKEN), "the token is in no refusal");
});

test("a stale run file of Mason's user is replaced; a live run's, a link, a folder, another's file, a file of another mode or content, or a folder that is not Mason's alone is refused and left as it was", async () => {
  const dir = temp();
  const file = path.join(dir, "run.json");
  // nothing there: nothing to do
  assert.equal(await prepareUiRunFile(file, say), null);

  // stale: a run file whose run does not answer
  fs.writeFileSync(file, JSON.stringify({ port: await deadPort(), token: TOKEN }), { mode: 0o600 });
  said.length = 0;
  assert.equal(await prepareUiRunFile(file, say), null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(said, [`replaced the run file a run that did not stop left at ${file}`]);

  // live: a run answers /api/ping with its token
  const run = http.createServer((req, res) => {
    if (req.url === "/api/ping" && req.headers.authorization === `Bearer ${TOKEN}`) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ pid: 42 }));
    else res.writeHead(403).end();
  }).listen(0, "127.0.0.1");
  await new Promise((r) => run.once("listening", r));
  try {
    const port = (run.address() as net.AddressInfo).port;
    fs.writeFileSync(file, JSON.stringify({ port, token: TOKEN }), { mode: 0o600 });
    const live = await prepareUiRunFile(file, say);
    assert.equal(live?.message, `MASON_UI_RUN_FILE=${file}: the run it names answers with its token: another Mason writes it now`);
    assert.equal(live?.fix, "stop that Mason, or name another path");
    assert.ok(!JSON.stringify(live).includes(TOKEN), "the token is in no refusal");
    assert.ok(fs.existsSync(file), "a live run's file is left alone");
    // the same port, another token: not that run, so stale
    fs.writeFileSync(file, JSON.stringify({ port, token: "other" }), { mode: 0o600 });
    assert.equal(await prepareUiRunFile(file, say), null);
    assert.equal(fs.existsSync(file), false);
  } finally { run.close(); }

  const left = (f: string, problem: RegExp | string, check: () => void) => async () => {
    const r = await prepareUiRunFile(f, say);
    assert.ok(r !== null, f);
    if (typeof problem === "string") assert.equal(r.message, `MASON_UI_RUN_FILE=${f}: ${problem}`); else assert.match(r.message, problem);
    assert.equal(r.code, "refused");
    check();
  };
  // another content: never taken for a run file (the project's config, a file the operator keeps)
  const config = path.join(dir, "config.json");
  fs.writeFileSync(config, JSON.stringify({ name: "shop", apiKey: KEY, running: null }), { mode: 0o600 });
  await left(config, "it is a file of other content than a run file Mason writes ({ port, token })", () => assert.match(fs.readFileSync(config, "utf8"), /"apiKey"/))();
  const extra = path.join(dir, "extra.json");
  fs.writeFileSync(extra, JSON.stringify({ port: 1, token: "x", more: 1 }), { mode: 0o600 });
  await left(extra, /of other content/, () => assert.ok(fs.existsSync(extra)))();
  // another mode: not a file Mason wrote
  const wide = path.join(dir, "wide.json");
  fs.writeFileSync(wide, JSON.stringify({ port: await deadPort(), token: TOKEN }));
  fs.chmodSync(wide, 0o644);
  await left(wide, "it is a file of mode 0644, and a run file Mason writes is 0600", () => assert.ok(fs.existsSync(wide)))();
  // a folder, a link (to a run file, and dangling)
  const folder = path.join(dir, "folder");
  fs.mkdirSync(folder);
  await left(folder, "it is a folder, and Mason replaces only a run file a run of its own left", () => assert.ok(fs.statSync(folder).isDirectory()))();
  const target = path.join(dir, "target.json");
  fs.writeFileSync(target, JSON.stringify({ port: await deadPort(), token: TOKEN }), { mode: 0o600 });
  const link = path.join(dir, "link.json");
  fs.symlinkSync(target, link);
  await left(link, "it is a symbolic link, and Mason never replaces one", () => assert.ok(fs.lstatSync(link).isSymbolicLink() && fs.existsSync(target)))();
  fs.rmSync(target);
  await left(link, /symbolic link/, () => assert.ok(fs.lstatSync(link).isSymbolicLink()))();
  // another user's file: told by the uid Mason runs as (its folder first, so the folder is checked as this user's)
  const r = await prepareUiRunFile(wide, say, uid + 1);
  assert.match(r!.message, new RegExp(`its folder ${dir} is owned by uid ${uid}, not Mason's user \\(uid ${uid + 1}\\)`));
  assert.equal(r!.fix, `mkdir -m 700 ${dir} as Mason's user, or name a run file in a folder that is only its own (the data folder's .mason/ is)`);

  // the folder: missing, a link, writable by others; each refused before anything is written
  const nowhere = path.join(dir, "none", "run.json");
  await left(nowhere, `its folder ${path.join(dir, "none")} cannot be read: it does not exist`, () => assert.ok(!fs.existsSync(path.join(dir, "none"))))();
  const open = path.join(dir, "open");
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  await left(path.join(open, "run.json"), `its folder ${open} can be written by others than Mason's user (mode 0777)`, () => undefined)();
  const w = writeUiRunFile(path.join(open, "run.json"), { port: 1, token: TOKEN }, say);
  assert.ok("message" in w, "the write checks the folder too");
  assert.deepEqual(fs.readdirSync(open), [], "nothing written there");
  const linked = path.join(dir, "linked");
  fs.symlinkSync(dir, linked);
  await left(path.join(linked, "run.json"), `its folder ${linked} is a symbolic link`, () => undefined)();
});

test("MASON_UI_RUN_FILE is a setting of mason serve's, on its one report and in its --help saying what the token grants; unset, nothing changes; mason start refuses it", () => {
  const env = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
  for (const e of [env, { ...env, MASON_UI_RUN_FILE: "" }]) {
    const s = serveSettings(e, "/srv");
    assert.ok(!("message" in s));
    assert.equal(s.ui.runFile, null);
    assert.equal(uiRunFileSetting(e, "/srv"), null);
  }
  const s = serveSettings({ ...env, MASON_UI_RUN_FILE: "data/.mason/run.json" }, "/srv");
  assert.ok(!("message" in s));
  assert.equal(s.ui.runFile, "/srv/data/.mason/run.json", "a relative path is the folder's it runs in, as MASON_DATA");
  const same = serveSettings({ ...env, MASON_UI_RUN_FILE: "/run/mason/ui", MASON_UI_SOCKET: "/run/mason/ui" }, "/srv");
  assert.ok("message" in same);
  assert.equal(same.message, "a setting is missing or wrong: MASON_UI_RUN_FILE names the path MASON_UI_SOCKET names: two paths");
  assert.deepEqual(uiRunFileSetting({ MASON_UI_RUN_FILE: "/x/run.json" }, "/", "win32"),
    { problem: "MASON_UI_RUN_FILE is set, and on Windows a file cannot be kept to Mason's user by its mode: unset it" });
  assert.match(SERVE.usage, /\n {4}MASON_UI_RUN_FILE {7}a file Mason writes once it answers, for a process on this machine that supervises it:\n/);
  assert.match(SERVE.usage.replace(/\s+/g, " "), /which grants what the token grants — the commands' writes \(mason add, mason sync, mason user\) as well as a tunnel to the page; written whole, mode 0600/);

  const dir = temp();
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  const p = { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason") } as unknown as Parameters<typeof startSettingRefusal>[0];
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_RUN_FILE: "/x/run.json" }, { serve: false }),
    { message: "MASON_UI_RUN_FILE is mason serve's setting, and mason start ignores no setting silently", code: "refused",
      fix: "unset MASON_UI_RUN_FILE: mason ui opens this run's page, and the mason commands reach the run by themselves" });
  assert.equal(startSettingRefusal(p, { MASON_UI_RUN_FILE: "/x/run.json" }, { serve: true }), null);
  assert.equal(startSettingRefusal(p, {}, { serve: false }), null);
});

test("/healthz says where the page is served — its socket or null, and whether it is read-only — starting, ready and stopping alike; the state and mason status --json say pageSocket", () => {
  const t0 = Date.now();
  const page = { socket: "/run/mason/ui.sock", readOnly: true };
  for (const phase of [{ phase: "starting" as const }, { phase: "stopping" as const }, { phase: "ready" as const, tables: () => [], metrics: async () => { throw new Error("unused"); } }]) {
    assert.deepEqual(healthBody(phase, t0, t0, page).body.page, page, phase.phase);
    assert.deepEqual(healthBody(phase, t0, t0).body.page, { socket: null, readOnly: false }, `${phase.phase}: none`);
  }
  // the keys it had are as they were
  assert.deepEqual(Object.keys(healthBody({ phase: "starting" }, t0, t0, page).body), ["status", "version", "uptimeSeconds", "page"]);

  const parsed = parseSource("postgres://me@localhost:5432/shop");
  const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);
  const ctxOf = (pageSocket?: string | null) => ({
    source, facts: () => ({ version: 160000, versionText: "16.4", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    page: true, served: true, token: TOKEN, ...(pageSocket === undefined ? {} : { pageSocket }), users: { file: "/app/.mason/users.json", apiKey: KEY, database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => "/app/mason", root: "/app", home: "/app/.mason", version: "0.9.0", startedAt: t0,
    sources: () => ({ file: null, problem: null }), listener: { openSessions: () => ({ open: 0, byClient: [] }) },
    duck: { file: "/app/.mason/duck.db", requests: { days: 7 }, restarts: () => [], disk: () => ({ path: "/app/.mason", freeBytes: null, projectedBytes: null }) },
  }) as unknown as RunContext;
  const on = runState(ctxOf("/run/mason/ui.sock"), [], null, t0) as { pageSocket?: unknown };
  assert.equal(on.pageSocket, "/run/mason/ui.sock");
  assert.equal((runState(ctxOf(), [], null, t0) as { pageSocket?: unknown }).pageSocket, null);
  assert.equal((runState(ctxOf(null), [], null, t0) as { pageSocket?: unknown }).pageSocket, null);
  assert.ok(!JSON.stringify(on).includes(TOKEN), "the state never carries the token");
  assert.ok(commands.STATUS.json!.includes("pageSocket"), "mason status --json declares it");
  assert.match(commands.STATUS.usage.replace(/\s+/g, " "), /pageSocket \(the Unix socket the page is served on too: mason serve with MASON_UI_SOCKET — or null\)/);
});

/** mason serve as a process: its output, its exit, a SIGTERM. */
function serveRun(dir: string, env: Record<string, string>): { out: () => string; exited: Promise<number | null>; kill: () => void } {
  const child = spawn(process.execPath, [MAIN, "serve"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  return { out: () => out, exited: new Promise((r) => child.once("exit", (code) => r(code))), kill: () => child.kill("SIGTERM") };
}

async function healthz(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      return { status: r.status, body: await r.json() as Record<string, unknown> };
    } catch (e) {
      if (!/fetch failed/.test((e as Error).message)) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return assert.fail("/healthz never answered");
}

test("while mason serve starts, /healthz says the page's socket and read-only (null and false without them); the run file is not written until it answers, and a SIGTERM leaves none", { timeout: 60_000 }, async () => {
  const dir = temp();
  // a database that takes the connection and never answers: the run is still connecting
  const sockets: net.Socket[] = [];
  const db = net.createServer((s) => { sockets.push(s); }).listen(0, "127.0.0.1");
  await new Promise((r) => db.once("listening", r));
  const dbPort = (db.address() as net.AddressInfo).port;
  try {
    for (const withPage of [true, false]) {
      const data = path.join(dir, withPage ? "with" : "without");
      fs.mkdirSync(path.join(data, ".mason"), { recursive: true, mode: 0o700 });
      const socket = path.join(data, ".mason", "ui.sock");
      const runFile = path.join(data, ".mason", "run.json");
      const health = await unassignedPort();
      const env = { PATH: process.env.PATH ?? "", HOME: dir, DATABASE_URL: `postgres://mason:secret@127.0.0.1:${dbPort}/app`, MASON_API_KEY: KEY,
        MASON_DATA: data, MASON_PROJECT: path.join(data, "project"), MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1",
        ...(withPage ? { MASON_UI_SOCKET: socket, MASON_UI_RUN_FILE: runFile, MASON_UI_READ_ONLY: "1" } : {}) };
      const a = serveRun(dir, env);
      try {
        const h = await healthz(health);
        assert.equal(h.status, 503, a.out());
        assert.equal(h.body.status, "starting");
        assert.deepEqual(h.body.page, withPage ? { socket, readOnly: true } : { socket: null, readOnly: false }, a.out());
        assert.equal(fs.existsSync(runFile), false, "no run file before the run answers");
        if (withPage) {
          for (let i = 0; i < 50 && !a.out().includes("run file"); i++) await new Promise((r) => setTimeout(r, 50));
          assert.match(a.out(), new RegExp(`\\n  run file  ${runFile.replace(/\./g, "\\.")}: written once Mason answers \\(mode 0600; it holds the run's token\\)\\n`));
        } else assert.doesNotMatch(a.out(), /run file/, "unset: nothing said");
      } finally { a.kill(); }
      await a.exited;
      assert.equal(fs.existsSync(runFile), false);
      assert.equal(fs.existsSync(socket), false);
    }
  } finally {
    for (const s of sockets) s.destroy();
    db.close();
  }
});

test("mason serve writes the run file once it answers: 0600, the page's port and the run's token, which opens the run; /healthz ready says the page; the token in no answer, log or output; a SIGTERM removes it", { timeout: 120_000 }, async () => {
  const dir = temp();
  const source = await DemoSource.open({ dir: path.join(dir, "db"), port: 0, log: () => undefined });
  try {
    const data = path.join(dir, "data");
    fs.mkdirSync(path.join(data, ".mason"), { recursive: true, mode: 0o700 });
    const socket = path.join(data, ".mason", "ui.sock");
    const runFile = path.join(data, ".mason", "run.json");
    // a stale one a killed run left: replaced
    fs.writeFileSync(runFile, JSON.stringify({ port: await deadPort(), token: "old" }), { mode: 0o600 });
    const health = await unassignedPort();
    const env = { PATH: process.env.PATH ?? "", HOME: dir, DATABASE_URL: source.url, MASON_API_KEY: KEY,
      MASON_DATA: data, MASON_PROJECT: path.join(dir, "project"), MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1",
      MASON_PG_PORT: String(await unassignedPort()), MASON_UI_PORT: String(await unassignedPort()), MASON_UI_SOCKET: socket, MASON_UI_RUN_FILE: runFile };
    const a = serveRun(dir, env);
    let token = "";
    try {
      let h = await healthz(health);
      for (let i = 0; i < 600 && h.status !== 200; i++) { await new Promise((r) => setTimeout(r, 100)); h = await healthz(health); }
      assert.equal(h.status, 200, a.out());
      // ready means the file is there: written before /healthz said so
      const st = fs.lstatSync(runFile);
      assert.ok(st.isFile());
      assert.equal(st.mode & 0o777, 0o600);
      assert.equal(st.uid, uid);
      const content = JSON.parse(fs.readFileSync(runFile, "utf8")) as { port: number; token: string };
      assert.deepEqual(Object.keys(content), ["port", "token"]);
      assert.equal(content.port, Number(env.MASON_UI_PORT));
      token = content.token;
      assert.match(token, /^[0-9a-f]{32,}$/);
      const cfg = JSON.parse(fs.readFileSync(path.join(data, ".mason", "config.json"), "utf8")) as { running: { token: string } };
      assert.equal(token, cfg.running.token, "the run's own token");
      // it opens the run: the commands' ping, and HEAD on the API
      const ping = await fetch(`http://127.0.0.1:${content.port}/api/ping`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(ping.status, 200);
      assert.equal((await fetch(`http://127.0.0.1:${content.port}/api/state`, { method: "HEAD", headers: { Authorization: `Bearer ${token}` } })).status, 200);
      assert.deepEqual(h.body.page, { socket, readOnly: false });
      assert.match(a.out(), /replaced the run file a run that did not stop left at/);
      assert.match(a.out(), new RegExp(`\\n  run file  ${runFile.replace(/\./g, "\\.")} \\(the web page's port and the run's token, mode 0600\\)\\n`));

      // mason status --json, beside it: the socket and read-only, never the token
      const status = await new Promise<string>((resolve) => {
        const c = spawn(process.execPath, [MAIN, "status", "--json"], { cwd: data, env: { PATH: env.PATH, HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
        let o = "";
        c.stdout.on("data", (d) => { o += String(d); });
        c.once("exit", () => resolve(o));
      });
      const j = JSON.parse(status) as { pageSocket: unknown; pageReadOnly: unknown };
      assert.equal(j.pageSocket, socket, status);
      assert.equal(j.pageReadOnly, null);
      assert.ok(!status.includes(token), "mason status --json never carries the token");
      assert.ok(!JSON.stringify(h.body).includes(token), "/healthz never carries the token");
      const metrics = await (await fetch(`http://127.0.0.1:${health}/metrics`)).text();
      assert.ok(!metrics.includes(token));
    } finally { a.kill(); }
    assert.equal(await a.exited, 0, a.out());
    assert.equal(fs.existsSync(runFile), false, `a SIGTERM removes the run file:\n${a.out()}`);
    assert.match(a.out(), new RegExp(`removed the run file ${runFile.replace(/\./g, "\\.")}`));
    assert.ok(token !== "" && !a.out().includes(token), "the token is in none of its output");
    for (const f of fs.readdirSync(path.join(data, ".mason"))) {
      const p = path.join(data, ".mason", f);
      if (f === "config.json" || !fs.statSync(p).isFile() || f.endsWith(".db") || f.endsWith(".wal")) continue;
      assert.ok(!fs.readFileSync(p, "utf8").includes(token), `the token is in no log: ${f}`);
    }
  } finally { await source.close(); }
});

test("a run file that cannot be written when the run answers stops it: no ready line, /healthz never ready, exit 1, lastStop says why, and what was put at the path is left as it is", { timeout: 120_000 }, async () => {
  const dir = temp();
  const source = await DemoSource.open({ dir: path.join(dir, "db"), port: 0, log: () => undefined });
  try {
    const data = path.join(dir, "data");
    fs.mkdirSync(path.join(data, ".mason"), { recursive: true, mode: 0o700 });
    const runFile = path.join(data, ".mason", "run.json");
    const health = await unassignedPort();
    const env = { PATH: process.env.PATH ?? "", HOME: dir, DATABASE_URL: source.url, MASON_API_KEY: KEY,
      MASON_DATA: data, MASON_PROJECT: path.join(dir, "project"), MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1",
      MASON_PG_PORT: String(await unassignedPort()), MASON_UI_PORT: String(await unassignedPort()), MASON_UI_RUN_FILE: runFile };
    const a = serveRun(dir, env);
    let everReady = false;
    try {
      // the start checked the path (nothing there) and says it; something is put there before the run answers
      for (let i = 0; i < 200 && !a.out().includes("  run file  "); i++) await new Promise((r) => setTimeout(r, 25));
      assert.match(a.out(), /written once Mason answers/, a.out());
      fs.writeFileSync(runFile, "someone else's\n", { mode: 0o600 });
      const exited = a.exited.then((code) => ({ code }));
      for (;;) {
        const r = await Promise.race([exited, new Promise<null>((res) => setTimeout(() => res(null), 100))]);
        if (r !== null) break;
        try { if ((await fetch(`http://127.0.0.1:${health}/healthz`)).status === 200) everReady = true; }
        catch (e) { if (!/fetch failed/.test((e as Error).message)) throw e; }   // not listening yet, or gone
      }
    } finally { a.kill(); }
    assert.equal(await a.exited, 1, a.out());
    assert.equal(everReady, false, "/healthz never said ready");
    assert.ok(!a.out().includes("mason start: ready"), `no ready line:\n${a.out()}`);
    assert.match(a.out(), new RegExp(`MASON_UI_RUN_FILE=${runFile.replace(/\./g, "\\.")}: something was put at the path after the start checked it, and Mason writes over nothing: Mason stops`));
    assert.equal(fs.readFileSync(runFile, "utf8"), "someone else's\n", "left as it is");
    const cfg = JSON.parse(fs.readFileSync(path.join(data, ".mason", "config.json"), "utf8")) as { running: unknown; lastStop: { how: string } };
    assert.equal(cfg.running, null);
    assert.equal(cfg.lastStop.how, `stopped: the run file (MASON_UI_RUN_FILE) could not be written: ${runFile}: something was put at the path after the start checked it, and Mason writes over nothing`);
  } finally { await source.close(); }
});

test("a SIGTERM while the start asks a stale run file's run (up to 2 s) removes the page's socket", { timeout: 60_000 }, async () => {
  const dir = temp();
  // the stale file's port takes the connection and never answers: the check waits on it
  const sockets: net.Socket[] = [];
  const hung = net.createServer((s) => { sockets.push(s); }).listen(0, "127.0.0.1");
  await new Promise((r) => hung.once("listening", r));
  try {
    const data = path.join(dir, "data");
    fs.mkdirSync(path.join(data, ".mason"), { recursive: true, mode: 0o700 });
    const socket = path.join(data, ".mason", "ui.sock");
    const runFile = path.join(data, ".mason", "run.json");
    fs.writeFileSync(runFile, JSON.stringify({ port: (hung.address() as net.AddressInfo).port, token: "old" }), { mode: 0o600 });
    const env = { PATH: process.env.PATH ?? "", HOME: dir, DATABASE_URL: "postgres://mason:secret@127.0.0.1:1/app", MASON_API_KEY: KEY,
      MASON_DATA: data, MASON_PROJECT: path.join(data, "project"), MASON_HEALTH_PORT: String(await unassignedPort()), MASON_HEALTH_HOST: "127.0.0.1",
      MASON_UI_SOCKET: socket, MASON_UI_RUN_FILE: runFile };
    const a = serveRun(dir, env);
    try {
      for (let i = 0; i < 200 && sockets.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(sockets.length, 1, `the check asks the stale run:\n${a.out()}`);
      assert.ok(fs.existsSync(socket), "the socket is made before the check");
    } finally { a.kill(); }
    await a.exited;
    assert.equal(fs.existsSync(socket), false, `the socket removed:\n${a.out()}`);
    assert.ok(fs.existsSync(runFile), "the stale file, never judged, is left as it is");
  } finally {
    for (const s of sockets) s.destroy();
    hung.close();
  }
});
