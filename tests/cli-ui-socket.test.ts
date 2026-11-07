/**
 * `MASON_UI_SOCKET` (src/cli/ui-socket.ts): `mason serve`'s page on a Unix socket, for a process on the same machine.
 * The socket is the run's own command server behind its guard (src/cli/security.ts), exactly as a request through
 * `mason ui --bridge` is; it is made 0600 in a folder only Mason's user can write, a stale one is replaced, anything
 * else at the path is refused and left alone, and it is removed on exit. Without the setting nothing changes.
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
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import * as serveModule from "../src/cli/serve.ts";
import * as projectModule from "../src/cli/project.ts";
import { unassignedPort } from "./test-ports.ts";

// imported when the tests run: the file loads at a commit without the module, and each test that needs it fails by name
const socketModule = await import("../src/cli/ui-socket.ts" as string).catch(() => ({})) as Partial<typeof import("../src/cli/ui-socket.ts")>;
const missing = (): never => assert.fail("src/cli/ui-socket.ts is not in this tree");
const uiSocketSetting = socketModule.uiSocketSetting ?? missing;
const prepareUiSocket = socketModule.prepareUiSocket ?? missing;
const listenOnUiSocket = socketModule.listenOnUiSocket ?? missing;
const { serveSettings, SERVE } = serveModule as unknown as typeof import("../src/cli/serve.ts");
const { newConfig, startSettingRefusal } = projectModule as unknown as typeof import("../src/cli/project.ts");

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const KEY = "k".repeat(48);
const TOKEN = "t".repeat(64);
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
// a short folder: a socket's path is at most 107 bytes, and os.tmpdir() may be long
const temp = (): string => { const d = fs.mkdtempSync(path.join(fs.existsSync("/tmp") ? "/tmp" : os.tmpdir(), "mu-")); fs.chmodSync(d, 0o700); made.push(d); return d; };
const said: string[] = [];
const say = (l: string): void => { said.push(l); };

const parsed = parseSource("postgres://me@localhost:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);

/** `mason serve`'s command server, as tests/cli-ui-ssh.test.ts makes it, listening nowhere: the socket alone reaches it. */
function runServer(port: number): { server: http.Server; logs: string[] } {
  const root = temp();
  const logs: string[] = [];
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    port, token: TOKEN, page: true, served: true, users: { file: path.join(root, "users.json"), apiKey: KEY, database: "shop", postgresUrl: "postgresql://localhost:5433/shop" },
    folder: () => null, root, home: root, version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => undefined, log: (l: string) => { logs.push(l); },
    listener: { openSessions: () => ({ open: 0, sessions: [] }) }, readSource: () => ({ message: "none", code: "bad_source" }), runUrl: "",
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async () => ({ at: "t", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }), restarts: () => [],
      requests: { days: 7 } },
  } as unknown as RunContext;
  return { server: createRunServer(ctx), logs };
}

/** A request on the socket with the Host and headers given; the body read whole, the connection held open by `hold`. */
function ask(file: string, o: { path?: string; method?: string; headers?: Record<string, string>; body?: string; hold?: boolean }): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: file, path: o.path ?? "/", method: o.method ?? "GET", headers: { Connection: "close", ...o.headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        text += c;
        // a tunnel's answer stays open: its first line is the whole of what is read
        if (o.hold && text.includes("\n")) resolve({ status: res.statusCode ?? 0, headers: res.headers, text, req });
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text, req }));
    });
    req.on("error", reject);
    req.end(o.body);
  });
}

/** A socket left at `file` by a process that did not stop: it listened, then was killed with -9. */
async function staleSocket(file: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.ok(fs.lstatSync(file).isSocket(), "a killed listener leaves its socket");
}

test("the page and /api/state answer on the socket behind the guard of mason ui --bridge's requests, never as a local browser; 503 until the run is attached; the socket is 0600 and removed on close", async () => {
  const dir = temp();
  const file = path.join(dir, "ui.sock");
  const port = 4039;
  const { server, logs } = runServer(port);
  assert.equal(await prepareUiSocket(file, say), null);
  const sock = await listenOnUiSocket(file, say);
  assert.ok(!("message" in sock), JSON.stringify(sock));
  try {
    const st = fs.lstatSync(file);
    assert.ok(st.isSocket());
    assert.equal(st.mode & 0o777, 0o600, "the socket is Mason's user's alone");
    assert.equal(st.uid, process.getuid!());

    // before the run answers: starting, and nothing of the page
    const early = await ask(file, { headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TOKEN}` }, path: "/api/state" });
    assert.equal(early.status, 503);
    assert.doesNotMatch(early.text, /shop|<html/i);
    sock.attach(server);

    // arriving on the socket proves nothing: no credential is refused, a Host the guard does not take is refused by name
    const host = { Host: `127.0.0.1:${port}` };
    for (const p of ["/", "/api/state", "/app.js"]) assert.equal((await ask(file, { path: p, headers: host })).status, 403, p);
    assert.equal((await ask(file, { path: "/api/state", headers: {} })).status, 421, "no Host");
    assert.equal((await ask(file, { path: "/api/state", headers: { Host: "mason.example" } })).status, 421, "a proxy's own name is not a Host the guard takes");
    assert.equal((await ask(file, { path: "/api/state", headers: { ...host, Authorization: "Bearer wrong" } })).status, 403);
    assert.equal((await ask(file, { path: "/api/state", headers: { ...host, Cookie: `mason_dev_${port}=wrong` } })).status, 403);

    // the commands' path is the same as on loopback: the run's token as Bearer
    const bearer = await ask(file, { path: "/api/state", headers: { ...host, Authorization: `Bearer ${TOKEN}` } });
    assert.equal(bearer.status, 200);
    assert.equal((JSON.parse(bearer.text) as { project: { served?: boolean } }).project !== undefined, true);

    // a browser's path is a tunnel's, as mason ui --bridge opens one: asked with the run's token, its ticket traded once
    const tunnelPort = 51234;
    const opened = await ask(file, { method: "POST", path: "/api/ui/tunnel", headers: { ...host, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ port: tunnelPort }), hold: true });
    assert.equal(opened.status, 200, opened.text);
    const ticket = (JSON.parse(opened.text.split("\n")[0]!) as { ticket: string }).ticket;
    const tunnelHost = { Host: `127.0.0.1:${tunnelPort}` };
    assert.equal((await ask(file, { path: "/", headers: tunnelHost })).status, 403, "a tunnel's page takes its ticket or its cookie");
    const traded = await ask(file, { path: `/?ticket=${ticket}`, headers: tunnelHost });
    assert.equal(traded.status, 303);
    assert.equal(traded.headers.location, "./", "relative to the address asked, so a proxy's prefix is kept (issue 746)");
    const cookie = String(traded.headers["set-cookie"]).split(";")[0]!;
    assert.match(cookie, new RegExp(`^mason_dev_${tunnelPort}=[0-9a-f]{64}$`));
    assert.doesNotMatch(cookie, new RegExp(TOKEN), "the run's token never reaches the browser");
    assert.equal((await ask(file, { path: `/?ticket=${ticket}`, headers: tunnelHost })).status, 403, "a ticket trades once");
    const pageHtml = await ask(file, { path: "/", headers: { ...tunnelHost, Cookie: cookie } });
    assert.equal(pageHtml.status, 200);
    assert.match(pageHtml.text, /<html/i);
    assert.match(String(pageHtml.headers["content-security-policy"]), /^default-src 'self'/, "the guard's headers too");
    const state = await ask(file, { path: "/api/state", headers: { ...tunnelHost, Cookie: cookie } });
    assert.equal(state.status, 200);
    assert.ok("tables" in (JSON.parse(state.text) as object));
    // a change from another origin, and the run's token under a tunnel's Host, are refused as through the bridge
    assert.equal((await ask(file, { method: "POST", path: "/api/sync", headers: { ...tunnelHost, Cookie: cookie, Origin: "http://evil.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await ask(file, { path: "/api/state", headers: { ...tunnelHost, Authorization: `Bearer ${TOKEN}` } })).status, 403);
    // the tunnel's connection gone, its cookie is nothing
    opened.req.destroy();
    for (let i = 0; i < 50 && !logs.some((l) => l.includes("closed")); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal((await ask(file, { path: "/api/state", headers: { ...tunnelHost, Cookie: cookie } })).status, 421);
  } finally {
    sock.close();
  }
  assert.equal(fs.existsSync(file), false, "removed on close");
});

test("a stale socket a killed run left is replaced; one a process answers on, another kind of file, a link or a folder that is not Mason's alone is refused and left as it was", async () => {
  const dir = temp();
  const file = path.join(dir, "ui.sock");

  // stale: replaced, and said
  await staleSocket(file);
  said.length = 0;
  assert.equal(await prepareUiSocket(file, say), null);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(said, [`replaced the socket a run that did not stop left at ${file}`]);
  const sock = await listenOnUiSocket(file, say);
  assert.ok(!("message" in sock));
  assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);

  // live: another process serves it, so it is never taken
  const live = await prepareUiSocket(file, say);
  assert.ok(live !== null);
  assert.equal(live.code, "refused");
  assert.equal(live.message, `MASON_UI_SOCKET=${file}: a process answers on it: another Mason, or something else, serves it now`);
  assert.equal(live.fix, "stop that process, or name another path");
  assert.ok(fs.lstatSync(file).isSocket(), "the live socket is left alone");
  sock.close();

  // a regular file, a folder and a link: refused, each left as it was
  const plain = path.join(dir, "plain");
  fs.writeFileSync(plain, "not a socket\n");
  const f = await prepareUiSocket(plain, say);
  assert.equal(f?.message, `MASON_UI_SOCKET=${plain}: it is a file, not a socket, and Mason removes only a socket a run of its own left`);
  assert.equal(f?.fix, "remove it yourself if it is not needed, or name another path");
  assert.equal(fs.readFileSync(plain, "utf8"), "not a socket\n");
  const folder = path.join(dir, "folder");
  fs.mkdirSync(folder);
  assert.match((await prepareUiSocket(folder, say))!.message, /: it is a folder, not a socket/);
  assert.ok(fs.statSync(folder).isDirectory());
  const target = path.join(dir, "target.sock");
  await staleSocket(target);
  const link = path.join(dir, "link.sock");
  fs.symlinkSync(target, link);
  assert.equal((await prepareUiSocket(link, say))?.message, `MASON_UI_SOCKET=${link}: it is a symbolic link, and Mason never replaces one`);
  assert.ok(fs.lstatSync(link).isSymbolicLink() && fs.lstatSync(target).isSocket(), "neither the link nor what it names is removed");
  // a link whose target is gone is still a link: never followed, never removed
  fs.rmSync(target);
  assert.match((await prepareUiSocket(link, say))!.message, /symbolic link/);
  assert.ok(fs.lstatSync(link).isSymbolicLink());

  // the folder: missing, a link, writable by others, another's
  const nowhere = path.join(dir, "none", "ui.sock");
  const m = await prepareUiSocket(nowhere, say);
  assert.equal(m?.message, `MASON_UI_SOCKET=${nowhere}: its folder ${path.join(dir, "none")} cannot be read: it does not exist`);
  assert.equal(m?.fix, `mkdir -m 700 ${path.join(dir, "none")} as Mason's user, or name a socket in a folder that is only its own (the data folder's .mason/ is)`);
  const open = path.join(dir, "open");
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  assert.equal((await prepareUiSocket(path.join(open, "ui.sock"), say))?.message, `MASON_UI_SOCKET=${path.join(open, "ui.sock")}: its folder ${open} can be written by others than Mason's user (mode 0777)`);
  fs.chmodSync(open, 0o770);
  assert.match((await prepareUiSocket(path.join(open, "ui.sock"), say))!.message, /can be written by others than Mason's user \(mode 0770\)/);
  const linked = path.join(dir, "linked");
  fs.symlinkSync(dir, linked);
  assert.equal((await prepareUiSocket(path.join(linked, "ui.sock"), say))?.message, `MASON_UI_SOCKET=${path.join(linked, "ui.sock")}: its folder ${linked} is a symbolic link`);
  // another user's folder and socket: told by the uid Mason runs as
  const other = process.getuid!() + 1;
  assert.match((await prepareUiSocket(file, say, other))!.message, new RegExp(`its folder ${dir} is owned by uid ${process.getuid!()}, not Mason's user \\(uid ${other}\\)`));
});

test("MASON_UI_SOCKET is a setting of mason serve's, on its one report and in its --help; unset, nothing changes; mason start refuses it", () => {
  const env = { DATABASE_URL: "postgres://mason:secret@db.internal:5432/app", MASON_API_KEY: KEY };
  // unset or empty: no socket
  for (const e of [env, { ...env, MASON_UI_SOCKET: "" }]) {
    const s = serveSettings(e, "/srv");
    assert.ok(!("message" in s));
    assert.deepEqual(s.ui, { port: 4039, named: false, socket: null });
    assert.equal(uiSocketSetting(e, "/srv"), null);
  }
  const s = serveSettings({ ...env, MASON_UI_SOCKET: "data/.mason/ui.sock" }, "/srv");
  assert.ok(!("message" in s));
  assert.equal(s.ui.socket, "/srv/data/.mason/ui.sock", "a relative path is the folder's it runs in, as MASON_DATA");
  const long = `/${"x".repeat(120)}.sock`;
  const wrong = serveSettings({ ...env, MASON_UI_SOCKET: long }, "/srv");
  assert.ok("message" in wrong);
  assert.match(wrong.message, new RegExp(`^a setting is missing or wrong: MASON_UI_SOCKET="${long.replace(/\./g, "\\.")}" is 126 bytes as a full path, and a Unix socket's path is at most 107: name a shorter one$`));
  assert.deepEqual(uiSocketSetting({ MASON_UI_SOCKET: "/x/ui.sock" }, "/", "win32"),
    { problem: "MASON_UI_SOCKET is set, and Windows has no Unix socket for the page: unset it (mason ui --ssh <user@server> opens the page from your machine)" });
  assert.match(SERVE.usage, /\n {4}MASON_UI_SOCKET {9}a Unix socket the web page is served on too, for a process on this machine/);
  assert.match(SERVE.usage, /guard as mason ui --ssh's \(default unset: none\)\n/);

  // mason start ignores no setting silently: refused there, taken by mason serve's run
  const dir = temp();
  fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
  const p = { root: dir, folder: path.join(dir, "mason"), config: newConfig("shop", "mason", false) } as unknown as Parameters<typeof startSettingRefusal>[0];
  assert.equal(startSettingRefusal(p, {}, { serve: false }), null);
  assert.deepEqual(startSettingRefusal(p, { MASON_UI_SOCKET: "/x/ui.sock" }, { serve: false }),
    { message: "MASON_UI_SOCKET is mason serve's setting, and mason start ignores no setting silently", code: "refused", fix: "unset MASON_UI_SOCKET: mason ui opens this run's page" });
  assert.equal(startSettingRefusal(p, { MASON_UI_SOCKET: "/x/ui.sock" }, { serve: true }), null);
});

test("mason serve makes the socket before the database answers (503 starting), refuses a file at its path leaving it, and a SIGTERM removes it", { timeout: 60_000 }, async () => {
  const dir = temp();
  // a database that takes the connection and never answers: the run is still connecting
  const sockets: net.Socket[] = [];
  const db = net.createServer((s) => { sockets.push(s); }).listen(0, "127.0.0.1");
  await new Promise((r) => db.once("listening", r));
  const dbPort = (db.address() as net.AddressInfo).port;
  const health = await unassignedPort();
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  const file = path.join(data, ".mason", "ui.sock");
  const env = { PATH: process.env.PATH ?? "", HOME: dir, DATABASE_URL: `postgres://mason:secret@127.0.0.1:${dbPort}/app`, MASON_API_KEY: KEY,
    MASON_DATA: data, MASON_PROJECT: path.join(dir, "project"), MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1", MASON_UI_SOCKET: file };
  const run = (): { out: () => string; exited: Promise<number | null>; kill: () => void } => {
    const child = spawn(process.execPath, [MAIN, "serve"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    return { out: () => out, exited: new Promise((r) => child.once("exit", (code) => r(code))), kill: () => child.kill("SIGTERM") };
  };
  try {
    const a = run();
    try {
      for (let i = 0; i < 200 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(fs.existsSync(file), `no socket:\n${a.out()}`);
      assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
      const r = await ask(file, { path: "/api/state", headers: { Host: "127.0.0.1:4039" } });
      assert.equal(r.status, 503, "starting: the run is still connecting");
      assert.match(a.out(), new RegExp(`\\n  web page  ${file.replace(/\./g, "\\.")} \\(a Unix socket, mode 0600: a request on it passes the same guard as mason ui --ssh's\\)\\n`));
    } finally { a.kill(); }
    await a.exited;
    assert.equal(fs.existsSync(file), false, `a SIGTERM while it connects removes the socket:\n${a.out()}`);

    // a file at the path: refused before anything listens, exit 1, the file as it was
    fs.writeFileSync(file, "mine\n");
    const b = run();
    assert.equal(await b.exited, 1);
    assert.match(b.out(), new RegExp(`MASON_UI_SOCKET=${file.replace(/\./g, "\\.")}: it is a file, not a socket`));
    assert.equal(fs.readFileSync(file, "utf8"), "mine\n");
  } finally {
    for (const s of sockets) s.destroy();
    db.close();
  }
});
