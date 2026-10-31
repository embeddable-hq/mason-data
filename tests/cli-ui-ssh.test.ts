/**
 * `mason ui --ssh` (src/cli/ui-ssh.ts) as real processes over a FAKE `ssh` on PATH: a script that records its line and
 * runs the remote command on this machine, stdin and stdout passed through, as ssh does. No sshd, no network: what real
 * ssh adds (authentication, the wire, a server's shell) is not exercised here, and the PR says so. The "server" is this
 * test's own command server (src/cli/run-server.ts) named in a project's config; the bridge is a real `mason ui --bridge`.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createRunServer, listenOnLoopback, runState, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import { serveSettings } from "../src/cli/serve.ts";
import { exitFailure, FrameLink, sshArgs, targetProblem } from "../src/cli/ui-ssh.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (name: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `mason-${name}-`)); made.push(d); return d; };

const TOKEN = "t".repeat(64);
const parsed = parseSource("postgres://me@localhost:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);

/** A project whose config says Mason runs at this test's command server, as `mason serve`'s does. */
async function server(page = true): Promise<{ root: string; port: number; logs: string[]; close: () => void }> {
  const root = temp("ui-ssh");
  const logs: string[] = [];
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    port: 0, token: TOKEN, page, served: true, users: { file: path.join(root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://localhost:5433/shop" },
    folder: () => null, root, home: path.join(root, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => undefined, log: (l: string) => { logs.push(l); },
    listener: { openSessions: () => ({ open: 0, sessions: [] }) }, readSource: () => ({ message: "none", code: "bad_source" }), runUrl: "",
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async () => ({ at: "t", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }), restarts: () => [],
      requests: { days: 7 } },
  } as unknown as RunContext;
  const s = createRunServer(ctx);
  await listenOnLoopback(s, 0);
  const port = ctx.port = (s.address() as net.AddressInfo).port;
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(root, "mason", "sources", "shop.yml"), "kind: postgres\nurl: postgres://me@localhost:5432/shop\ntables: {}\n");
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: true, served: true, apiKey: "k".repeat(48), sourceServer: null,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${port}`, token: TOKEN, postgresUrl: "postgresql://localhost:5433/shop", postgresListener: { host: "0.0.0.0", tls: null } }, lastRun: null }), { mode: 0o600 });
  return { root, port, logs, close: () => { s.closeAllConnections(); s.close(); } };
}

/** The fake ssh: records its line and pid, prints what a server's shell may, and runs the remote command, or exits as told. */
function fakeSsh(): { bin: string; line: string; pid: string } {
  const bin = temp("fake-ssh");
  const line = path.join(bin, "line"), pid = path.join(bin, "pid");
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
printf '%s\\n' "$@" >> "${line}"
echo $$ > "${pid}"
case "$FAKE_SSH" in
  unreachable) echo "ssh: connect to host mason.example port 22: Operation timed out" >&2; exit 255 ;;
  no-mason) echo "sh: 1: mason: not found" >&2; exit 127 ;;
  old) echo "mason ui: unknown option --bridge" >&2; exit 2 ;;
  other-bridge) echo 'MASON-UI-BRIDGE {"protocol":99,"version":"9.9.9","project":"shop","ticket":"x"}'; sleep 30; exit 0 ;;
  silent) sleep 30; exit 0 ;;
esac
echo "Welcome to a server whose shell prints a banner"
while [ "$1" != "--" ]; do shift; done
shift; shift
exec sh -c "$1"
`, { mode: 0o755 });
  return { bin, line, pid };
}

const env = (bin: string, extra: Record<string, string> = {}): Record<string, string> => matrixEnv({ PATH: `${bin}:${process.env.PATH ?? ""}`, ...extra });
const remote = (root: string): string => `cd '${root}' && '${process.execPath}' '${MAIN}'`;

interface Held { child: ChildProcess; first: { url: string; port: number; server: string; project: string; version: string; next: unknown[] }; out: () => string; err: () => string; done: Promise<number | null> }

/** `mason ui --ssh … --json`, held: its one JSON object read, the process left running. */
async function hold(root: string, bin: string, cwd = temp("laptop")): Promise<Held> {
  const child = spawn(process.execPath, [MAIN, "ui", "--ssh", "deploy@mason.example", "--mason", remote(root), "--json", "--timeout", "30"], { cwd, env: env(bin), stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  child.stderr!.on("data", (b: Buffer) => { err += b.toString(); });
  const done = new Promise<number | null>((r) => child.on("close", (c) => r(c)));
  const first = await new Promise<Held["first"]>((resolve, reject) => {
    child.stdout!.on("data", (b: Buffer) => { out += b.toString(); try { resolve(JSON.parse(out) as Held["first"]); } catch { /* not whole yet: the next chunk */ } });
    void done.then((c) => reject(new Error(`it ended (${c}): ${out}${err}`)));
  });
  return { child, first, out: () => out, err: () => err, done };
}

/** A request with the Host and headers given, which fetch will not send. */
function ask(port: number, o: { path?: string; method?: string; headers?: Record<string, string> }): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: o.path ?? "/", method: o.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, Connection: "close", ...o.headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end();
  });
}

const isGone = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch { return true; } };

test("through the tunnel: the ticket trades once for a cookie, the guard holds, Ctrl-C leaves nothing, and the token is nowhere", async () => {
  const s = await server();
  const ssh = fakeSsh();
  try {
    const h = await hold(s.root, ssh.bin);
    const { port, url } = h.first;
    assert.equal(h.first.server, "deploy@mason.example");
    assert.equal(h.first.project, "shop");
    assert.notEqual(port, s.port, "the laptop's port is its own: the guard must take it, by its Host");
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?ticket=[0-9a-f]{64}$`));

    // nothing answers to no ticket; the ticket trades for a cookie named for the laptop's port, and drops from the address
    assert.equal((await ask(port, {})).status, 403);
    const ticket = new URL(url).search;
    const traded = await ask(port, { path: `/${ticket}` });
    assert.equal(traded.status, 303);
    assert.equal(traded.headers.location, "/");
    const set = traded.headers["set-cookie"]![0]!;
    assert.match(set, new RegExp(`^mason_dev_${port}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/$`));
    const cookie = set.split(";")[0]!;
    assert.ok(!cookie.includes(TOKEN), "the cookie is the tunnel's, never the run's token");

    // used once: a second use is refused, as the URL was on a command line
    assert.equal((await ask(port, { path: `/${ticket}` })).status, 403);

    // the page and its files through one ssh, at once and whole, as a browser asks
    const page = await ask(port, { headers: { Cookie: cookie } });
    assert.equal(page.status, 200);
    assert.match(page.text, /<title>/);
    const files = ["/app.js", "/app.css", "/shared.js", "/charts.js", "/vendor/uplot-1.6.32/uPlot.esm.js", "/pages/tables.js"];
    const got = await Promise.all(files.map((p) => ask(port, { path: p, headers: { Cookie: cookie } })));
    const web = path.resolve(path.dirname(MAIN), "..", "web");
    for (const [i, p] of files.entries()) assert.equal(got[i]!.text, fs.readFileSync(path.join(web, p), "utf8"), p);
    const state = JSON.parse((await ask(port, { path: "/api/state", headers: { Cookie: cookie } })).text) as { served: boolean; ui: boolean };
    assert.deepEqual([state.served, state.ui], [true, true]);

    // a forged Host, through the tunnel's own port and with its cookie: DNS rebinding names itself
    for (const Host of [`evil.example:${port}`, "evil.example", `127.0.0.1.evil.example:${port}`, `127.0.0.1:${port + 1}`]) {
      assert.equal((await ask(port, { headers: { Host, Cookie: cookie } })).status, 421, Host);
    }
    // a foreign Origin on a change, and one with none
    const change = { path: "/api/sync", method: "POST", headers: { Cookie: cookie } };
    for (const Origin of ["http://evil.example", `http://evil.example:${port}`, `http://127.0.0.1:${s.port}`]) {
      assert.equal((await ask(port, { ...change, headers: { ...change.headers, Origin } })).status, 403, Origin);
    }
    assert.equal((await ask(port, change)).status, 403);
    // the page's own Origin passes the guard (the body is what is wrong here), by either of the names the Host may have
    assert.equal((await ask(port, { ...change, headers: { ...change.headers, Origin: `http://127.0.0.1:${port}` } })).status, 400);
    // the commands' Bearer is not the tunnel's: the token is refused on this path, right or wrong
    assert.equal((await ask(port, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 403);
    // and the run's token is no ticket
    assert.equal((await ask(port, { path: `/?ticket=${TOKEN}` })).status, 403);
    assert.equal((await ask(port, { path: `/?token=${TOKEN}` })).status, 403);

    // the run's own server: the laptop's cookie is good only by the laptop's Host
    assert.equal((await ask(s.port, { headers: { Cookie: cookie } })).status, 403);
    assert.equal((await ask(s.port, { headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } })).status, 200);

    const pid = Number(fs.readFileSync(ssh.pid, "utf8"));
    assert.ok(!isGone(pid), "ssh is up while the tunnel is");
    h.child.kill("SIGINT");
    assert.equal(await h.done, 0, h.err());
    assert.match(h.err(), /the tunnel to deploy@mason\.example is closed/);
    assert.ok(isGone(pid), "no ssh process left");
    await assert.rejects(ask(port, {}), /ECONNREFUSED/, "the local port is closed");
    // the run forgets it: its Host and its cookie are refused from now on
    for (let i = 0; i < 100 && !s.logs.some((l) => /closed/.test(l)); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal((await ask(s.port, { headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } })).status, 421);

    // the token: in no argument, on neither stream, in no line the run logged
    const seen = [fs.readFileSync(ssh.line, "utf8"), h.out(), h.err(), s.logs.join("\n")];
    assert.ok(seen.every((t) => !t.includes(TOKEN)), "the run's token crossed");
    assert.ok(!s.logs.join("\n").includes(new URL(url).searchParams.get("ticket")!), "no ticket in a log");
    assert.match(s.logs.join("\n"), new RegExp(`web page: a tunnel opened from local port ${port}`));
  } finally { s.close(); }
});

test("a dropped connection is reported, exit 1, with the way back: on stderr, stdout staying one document", async () => {
  const s = await server();
  const ssh = fakeSsh();
  try {
    const h = await hold(s.root, ssh.bin);
    const before = h.out();
    process.kill(Number(fs.readFileSync(ssh.pid, "utf8")), "SIGKILL");
    assert.equal(await h.done, 1);
    assert.equal(h.out(), before, "stdout stays the one object");
    assert.match(h.err(), /✗ mason ui: the tunnel to deploy@mason\.example dropped/);
    assert.match(h.err(), /mason ui --ssh deploy@mason\.example/);
    await assert.rejects(ask(h.first.port, {}), /ECONNREFUSED/);
  } finally { s.close(); }
});

test("the run going away ends the tunnel: said, not silent", async () => {
  const s = await server();
  const ssh = fakeSsh();
  const h = await hold(s.root, ssh.bin);
  s.close();
  assert.equal(await h.done, 1);
  assert.match(h.err(), /Mason for shop ended the tunnel: it stopped or restarted/);
  assert.match(h.err(), /the tunnel to deploy@mason\.example dropped/);
});

const refused = async (bin: string, root: string, extra: Record<string, string>, args: string[] = ["--timeout", "20"]): Promise<{ code: number | null; error: { code: string; message: string; why?: string; fix?: string }; next: Array<{ command: string }> }> => {
  const a = await runMason(temp("laptop"), ["ui", "--ssh", "deploy@mason.example", "--mason", remote(root), "--json", ...args], env(bin, extra));
  return { code: a.code, ...JSON.parse(a.stdout) as { error: { code: string; message: string }; next: Array<{ command: string }> } };
};

test("each failure is one report with its way out, in the failure shape, and no ssh left", async () => {
  const ssh = fakeSsh();
  const s = await server();
  try {
    const down = await refused(ssh.bin, s.root, { FAKE_SSH: "unreachable" });
    assert.equal(down.code, 1);
    assert.equal(down.error.message, "ssh could not reach deploy@mason.example");
    assert.match(down.error.why!, /^ssh exited 255: ssh: connect to host mason\.example port 22: Operation timed out$/);
    assert.match(down.error.fix!, /A firewall rule that names your old IP address is the common cause/);
    assert.deepEqual(down.next.map((n) => n.command), ["ssh deploy@mason.example true"]);

    const none = await refused(ssh.bin, s.root, { FAKE_SSH: "no-mason" });
    assert.equal(none.error.code, "not_found");
    assert.match(none.error.fix!, /--mason "docker exec -i <container> mason"/);

    const old = await refused(ssh.bin, s.root, { FAKE_SSH: "old" });
    assert.equal(old.error.message, "the Mason on deploy@mason.example does not know mason ui --bridge");
    assert.match(old.error.fix!, /upgrade the server's Mason/);

    const other = await refused(ssh.bin, s.root, { FAKE_SSH: "other-bridge" });
    assert.match(other.error.message, /^the Mason on deploy@mason\.example \(9\.9\.9\) and this one \(.+\) speak different bridges$/);
    assert.equal(other.code, 1);

    const late = await refused(ssh.bin, s.root, { FAKE_SSH: "silent" }, ["--timeout", "1"]);
    assert.equal(late.error.message, "no answer from deploy@mason.example in 1 s");
    assert.ok(isGone(Number(fs.readFileSync(ssh.pid, "utf8"))), "the ssh that said nothing is ended");
  } finally { s.close(); }

  // no ssh on this machine at all
  const a = await runMason(temp("laptop"), ["ui", "--ssh", "deploy@mason.example", "--json"], matrixEnv({ PATH: temp("empty") }));
  assert.equal(a.code, 1);
  const missing = JSON.parse(a.stdout) as { error: { code: string; message: string; fix: string } };
  assert.equal(missing.error.code, "not_found");
  assert.equal(missing.error.message, "ssh is not on this machine's PATH, and mason ui --ssh runs it");
  assert.match(missing.error.fix, /OpenSSH client/);
});

test("what the server says of itself reaches the laptop as its failure: no project there, no run, no page", async () => {
  const ssh = fakeSsh();
  const nowhere = await refused(ssh.bin, temp("empty-server"), {});
  assert.equal(nowhere.error.code, "no_project");
  assert.match(nowhere.error.message, /^on deploy@mason\.example: /);
  assert.match(nowhere.error.fix!, /--mason "cd <MASON_DATA> && mason"/);

  const stopped = temp("stopped-server");
  fs.mkdirSync(path.join(stopped, ".mason"));
  fs.writeFileSync(path.join(stopped, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: true, apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null }));
  assert.equal((await refused(ssh.bin, stopped, {})).error.code, "not_running");

  const s = await server(false);
  try {
    const none = await refused(ssh.bin, s.root, {});
    assert.equal(none.error.code, "refused");
    assert.match(none.error.message, /^on deploy@mason\.example: Mason for shop serves no web page through a tunnel$/);
  } finally { s.close(); }
});

test("a command line it refuses reaches no ssh: a target read as ssh's own option above all", async () => {
  const ssh = fakeSsh();
  for (const args of [["--ssh", "-oProxyCommand=touch /tmp/x"], ["--ssh", "a b"], ["--ssh", "a;b"], ["--ssh", "a@b", "--timeout", "soon"], ["--ssh", "a@b", "--mason", "x\ny"],
    ["--mason", "x"], ["--timeout", "3"], ["--local-port", "3"], ["--bridge"], ["--bridge", "--local-port", "0"], ["--bridge", "--local-port", "3", "--ssh", "a@b"]]) {
    const a = await runMason(temp("laptop"), ["ui", ...args, "--json"], env(ssh.bin));
    assert.equal(a.code, 2, args.join(" "));
    assert.equal((JSON.parse(a.stdout) as { error: { code: string } }).error.code, "usage");
  }
  assert.ok(!fs.existsSync(ssh.line), "ssh never ran");
  assert.equal(targetProblem("deploy@mason.example"), null);
  assert.equal(targetProblem("my-server"), null, "a Host of the ssh config");
  assert.equal(targetProblem("deploy@[::1]"), null);
  assert.match(targetProblem("-p22")!, /is not user@server/);
});

test("the ssh line: the target after --, never a forward nor a shared connection, and prompts only for a person", () => {
  const a = sshArgs("deploy@server", "mason ui --bridge --local-port 5", true);
  assert.deepEqual(a.slice(-3), ["--", "deploy@server", "mason ui --bridge --local-port 5"]);
  assert.ok(!a.includes("-L"), "the page stays on loopback: the tunnel is ssh's stdio");
  assert.ok(a.includes("ControlPath=none"), "a master that persists would be an ssh left behind");
  assert.ok(!a.includes("BatchMode=yes"));
  assert.ok(sshArgs("x", "y", false).includes("BatchMode=yes"), "nobody to answer: fail, never wait");
  assert.match(exitFailure({ target: "x", mason: "mason", code: 3, signal: null, said: "" }).message, /^the bridge on x ended before it answered$/);
});

test("the frames survive any chunking, both ways, and a stream that is not frames is said", async () => {
  const pipe = [new PassThrough(), new PassThrough()] as const;
  const echo = net.createServer((c) => c.pipe(c));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  const bridgeEnd = new FrameLink({ input: pipe[0], output: pipe[1], connect: () => net.connect((echo.address() as net.AddressInfo).port, "127.0.0.1"), broken: (w) => assert.fail(w) });
  const laptopEnd = new FrameLink({ input: pipe[1], output: pipe[0], broken: (w) => assert.fail(w) });
  // one byte at a time, the worst a pipe can do
  pipe[0].on("data", (b: Buffer) => { for (const x of b) bridgeEnd.read(Buffer.from([x])); });
  pipe[1].on("data", (b: Buffer) => { laptopEnd.read(b); });
  const front = net.createServer((c) => laptopEnd.open(c));
  await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
  const body = Buffer.alloc(200_000, "abc");
  const round = (): Promise<Buffer> => new Promise((resolve, reject) => {
    const c = net.connect((front.address() as net.AddressInfo).port, "127.0.0.1");
    const got: Buffer[] = [];
    let n = 0;
    c.on("data", (b: Buffer) => { got.push(b); n += b.length; if (n >= body.length) { c.destroy(); resolve(Buffer.concat(got)); } });
    c.on("error", reject);
    c.write(body);
  });
  for (const r of await Promise.all([round(), round(), round()])) assert.ok(r.equals(body));
  laptopEnd.end(); bridgeEnd.end();
  echo.close(); front.close();
  let said = "";
  new FrameLink({ input: new PassThrough(), output: new PassThrough(), broken: (w) => { said = w; } }).read(Buffer.from("this is a shell's banner, no frame"));
  assert.match(said, /not the bridge's stream/);
});

test("the page is on no interface but loopback, whatever the settings", async () => {
  const before = { host: process.env.MASON_UI_HOST, pg: process.env.MASON_PG_HOST, health: process.env.MASON_HEALTH_HOST };
  process.env.MASON_UI_HOST = "0.0.0.0"; process.env.MASON_PG_HOST = "0.0.0.0"; process.env.MASON_HEALTH_HOST = "0.0.0.0";
  const s = http.createServer((_q, r) => { r.end("page"); });
  try {
    await listenOnLoopback(s, 0);
    const a = s.address() as net.AddressInfo;
    assert.equal(a.address, "127.0.0.1");
    const outward = Object.values(os.networkInterfaces()).flat().filter((i) => i !== undefined && !i.internal && i.family === "IPv4");
    for (const i of outward) {
      // refused, an address that takes no connection from here, or nothing at all: anything but connected
      const connected = await new Promise<boolean>((resolve) => {
        const c = net.connect(a.port, i!.address);
        c.setTimeout(2000, () => { c.destroy(); resolve(false); });
        c.once("connect", () => { c.destroy(); resolve(true); });
        c.once("error", () => { resolve(false); });
      });
      assert.equal(connected, false, i!.address);
    }
  } finally {
    s.close();
    for (const [k, v] of [["MASON_UI_HOST", before.host], ["MASON_PG_HOST", before.pg], ["MASON_HEALTH_HOST", before.health]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  // the run listens one way: no address reaches it from a setting
  const dev = fs.readFileSync(path.join(path.dirname(MAIN), "dev.ts"), "utf8");
  assert.match(dev, /await listenOnLoopback\(server, setupPort\);/);
  assert.ok(!/server\.listen\(/.test(dev), "dev.ts must not listen its own way");
  assert.ok(!/MASON_UI_HOST/.test(dev + fs.readFileSync(path.join(path.dirname(MAIN), "run-server.ts"), "utf8")), "no setting names the page's address");
});

test("/api/state says whether the page may offer Add and Remove: a server's file it cannot write is why not, a laptop's is never asked", () => {
  const dir = temp("sources");
  const file = path.join(dir, "shop.yml");
  fs.writeFileSync(file, "tables: {}\n");
  const state = (served: boolean, at: string): { served: boolean; sourcesReadOnly: string | null } => runState({
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null, page: true, served,
    users: { postgresUrl: "postgresql://localhost:5433/shop" }, folder: () => null, root: dir, home: dir, version: "t", startedAt: 0, sources: () => ({ file: { file: at, name: "shop", tables: [] }, problem: null }),
    listener: { openSessions: () => ({ open: 0 }) }, duck: { file, requests: { days: 7 }, restarts: () => [], disk: () => ({ path: dir, freeBytes: null, projectedBytes: null }) },
  } as unknown as RunContext, [], null) as { served: boolean; sourcesReadOnly: string | null };
  assert.equal(state(true, file).served, true);
  assert.equal(state(true, file).sourcesReadOnly, null);
  const gone = state(true, path.join(dir, "no-such-folder", "shop.yml"));
  assert.match(gone.sourcesReadOnly!, /^the sources file cannot be written on this server \(ENOENT\): commit a change to it, and deploy$/);
  assert.equal(state(false, path.join(dir, "no-such-folder", "shop.yml")).sourcesReadOnly, null);
});

test("mason serve's settings: the page's port is a setting, and an address for it is refused by name", () => {
  const base = { DATABASE_URL: "postgres://me@db.internal:5432/app", MASON_API_KEY: "k".repeat(48) };
  const cwd = temp("serve-settings");
  const ok = serveSettings(base, cwd);
  assert.ok(!("message" in ok));
  if (!("message" in ok)) assert.deepEqual(ok.ui, { port: 4039, named: false });
  const named = serveSettings({ ...base, MASON_UI_PORT: "4100" }, cwd);
  if ("message" in named) assert.fail(named.message); else assert.deepEqual(named.ui, { port: 4100, named: true });
  const host = serveSettings({ ...base, MASON_UI_HOST: "0.0.0.0" }, cwd);
  assert.ok("message" in host);
  if ("message" in host) assert.match(host.message, /MASON_UI_HOST is set, and the web page has no address but 127\.0\.0\.1: remove it/);
  for (const [v, says] of [["abc", /MASON_UI_PORT="abc": a port number/], ["4140", /is MASON_HEALTH_PORT too/], ["5433", /is the Postgres API's port too/]] as const) {
    const r = serveSettings({ ...base, MASON_UI_PORT: v }, cwd);
    assert.ok("message" in r, v);
    if ("message" in r) assert.match(r.message, says);
  }
});
