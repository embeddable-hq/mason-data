/**
 * `mason ui` (src/cli/ui.ts) against a run that answers: this test's own command server (src/cli/run-server.ts), named
 * in a project's config with this process's pid, so the command — a real process — finds Mason up. It prints the
 * page's URL with the run's token (`--json`: { url, port }), asks the page before it says so, and refuses a run that
 * serves none (mason serve's); the opener is the platform's. The states with no run are the state matrix's.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunServer, type RunContext } from "../src/cli/run-server.ts";
import { parseSource } from "../src/cli/preflight.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const TOKEN = "u".repeat(64);
const parsed = parseSource("postgres://me@localhost:5432/shop");
const source = "source" in parsed ? parsed.source : assert.fail(parsed.problem);

/** A project folder whose config says Mason runs at this test's command server (`page`: whether it serves the page). */
async function upProject(page: boolean): Promise<{ root: string; port: number; close: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-ui-"));
  made.push(root);
  const ctx = {
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [], systemIdentifier: null }), warnings: [], replication: () => null,
    port: 0, token: TOKEN, page, users: { file: path.join(root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => null, root, home: path.join(root, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => undefined, log: () => undefined,
    readSource: () => ({ message: "none", code: "bad_source" }), runUrl: "",
    duck: { copies: () => [], file: path.join(root, "duck.db"), poll: async () => ({ at: "", tables: [] }), stream: async () => null, disk: () => ({ path: "/x", freeBytes: null, projectedBytes: null }),
      requests: { days: 7, recent: async () => [], slow: async () => [], refused: async () => ({ total: 0, refused: [] }) } },
  } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = ctx.port = (server.address() as { port: number }).port;
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(root, "mason", "sources", "shop.yml"), "kind: postgres\nurl: postgres://me@localhost:5432/shop\ntables: {}\n");
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null,
    running: { pid: process.pid, controlUrl: `http://127.0.0.1:${port}`, token: TOKEN, postgresUrl: "postgresql://127.0.0.1:5433/shop", postgresListener: { host: "127.0.0.1", tls: null } },
    lastRun: null }), { mode: 0o600 });
  return { root, port, close: () => { server.close(); } };
}

test("mason ui --json: the page's URL with the run's token, and its port — the URL the page then takes", async () => {
  const p = await upProject(true);
  try {
    const a = await runMason(p.root, ["ui", "--json"], matrixEnv());
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(JSON.parse(a.stdout), { url: `http://127.0.0.1:${p.port}/?token=${TOKEN}`, port: p.port,
      next: [{ command: "mason status", what: "the same, in this terminal" }, { command: "mason user list", what: "the users" }] });
    // the URL it printed is the one the guard trades for the cookie, and the page answers to the cookie
    const handed = await fetch(`http://127.0.0.1:${p.port}/?token=${TOKEN}`, { redirect: "manual" });
    assert.equal(handed.status, 303);
    assert.equal(handed.headers.get("location"), "/");
    const html = await fetch(`http://127.0.0.1:${p.port}/`, { headers: { Cookie: handed.headers.get("set-cookie")!.split(";")[0]! } });
    assert.equal(html.status, 200);
  } finally { p.close(); }
});

test("mason ui --no-open: the URL for the person at this terminal, and nothing opened", async () => {
  const p = await upProject(true);
  try {
    const a = await runMason(p.root, ["ui", "--no-open"], matrixEnv());
    assert.equal(a.code, 0, a.stderr);
    assert.match(a.stdout, /^Mason's web page\n {2}url {7}http:\/\/127\.0\.0\.1:\d+\/\?token=u{64}\n {2}project {3}shop\n/);
    assert.match(a.stdout, /Tip: The URL carries this run's token, traded for a cookie on the first visit: paste it nowhere else\./);
    assert.match(a.stdout, /Next:\n {2}mason status +the same, in this terminal/);
  } finally { p.close(); }
});

test("mason ui, a run that serves no page (one from before it): refused with the way out, and no URL printed", async () => {
  const p = await upProject(false);
  try {
    const a = await runMason(p.root, ["ui", "--json"], matrixEnv());
    assert.equal(a.code, 1);
    assert.deepEqual(JSON.parse(a.stdout), { error: { code: "refused", message: "Mason for shop serves no web page",
      why: "this run was started by a Mason from before the page",
      fix: "mason stop && mason start runs it with the page" },
      next: [{ command: "mason status", what: "what it is doing, in this terminal" }] });
    assert.ok(!a.stdout.includes(TOKEN));
  } finally { p.close(); }
});

test("mason ui on a server (mason serve's project): refused with mason ui --ssh, and no token printed", async () => {
  const p = await upProject(true);
  try {
    const file = path.join(p.root, ".mason", "config.json");
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), served: true }), { mode: 0o600 });
    const a = await runMason(p.root, ["ui", "--json"], matrixEnv());
    assert.equal(a.code, 1);
    assert.deepEqual(JSON.parse(a.stdout), { error: { code: "refused", message: "Mason for shop runs on this server: its page is opened from your own machine",
      why: "the page listens on this machine's loopback alone, and a browser on a server has no one in front of it",
      fix: "on your machine, mason ui --ssh <user@server> (mason ui --help: for a container, --mason)" },
      next: [{ command: "mason status", what: "what it is doing, in this terminal" }] });
    assert.ok(!a.stdout.includes(TOKEN));
  } finally { p.close(); }
});

test("mason ui, Mason stopped: the stopped failure, mason start next", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-ui-stopped-"));
  made.push(root);
  fs.mkdirSync(path.join(root, ".mason"));
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null }));
  const a = await runMason(root, ["ui", "--json"], matrixEnv());
  assert.equal(a.code, 1);
  const v = JSON.parse(a.stdout) as { error: { code: string; message: string }; next: Array<{ command: string }> };
  assert.equal(v.error.code, "not_running");
  assert.match(v.error.message, /^Mason is not running for shop /);
  assert.deepEqual(v.next.map((s) => s.command), ["mason start"]);
});

test("the browser is the platform's: open on macOS, start on Windows, xdg-open elsewhere", async () => {
  const { openCommand } = await import("../src/cli/ui.ts" as string).catch(() => ({})) as { openCommand?: (p: NodeJS.Platform, u: string) => [string, string[]] };
  assert.equal(typeof openCommand, "function", "src/cli/ui.ts exports openCommand");
  const u = "http://127.0.0.1:4039/?token=abc";
  assert.deepEqual(openCommand!("darwin", u), ["open", [u]]);
  assert.deepEqual(openCommand!("win32", u), ["cmd", ["/c", "start", "", u]]);
  assert.deepEqual(openCommand!("linux", u), ["xdg-open", [u]]);
  assert.deepEqual(openCommand!("freebsd", u), ["xdg-open", [u]]);
});

// ------------------------------------------------------------------ Connect from anywhere: the page's share endpoint

const { RunShares } = await import("../src/cli/share-run.ts");
const { PageShares } = await import("../src/cli/page-share.ts" as string).catch(() => ({})) as typeof import("../src/cli/page-share.ts");
const { NO_ROLES } = await import("../src/duck/grants.ts");

/** A run's command server with the page's share over a fake socket and a fake tunnel (`served`: mason serve's, none). */
async function shareServer(served: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-ui-share-"));
  made.push(root);
  const logged: string[] = [];
  let tunnels = 0, stops = 0;
  const shares = new RunShares({ listener: { openShare: async () => ({ port: 40001, sessions: 0, endSessions: () => 0, close: async () => undefined }), checkRoles: async () => NO_ROLES }, database: "shop", log: (l) => logged.push(l),
    stopTunnel: () => undefined, certificate: () => ({ cert: Buffer.from("c"), key: Buffer.from("k"), fingerprint: "AA:BB" }) });
  const pageShares = new PageShares({ shares, home: root, log: (l) => logged.push(l), probe: async () => "same",
    start: async () => { tunnels++; return { host: "relay.example", port: 41234, endsAt: null, pid: 4242, ended: new Promise<string>(() => undefined), stop: () => { stops++; } }; } });
  const ctx = { source, port: 0, token: TOKEN, page: true, served, root, home: path.join(root, ".mason"), log: (l: string) => logged.push(l), ...(served ? {} : { shares, pageShares }) } as unknown as RunContext;
  const server = createRunServer(ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = ctx.port = (server.address() as { port: number }).port;
  const ask = async (method: string, p: string, o: { body?: unknown; origin?: string | null; cookie?: string | null } = {}) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const cookie = o.cookie === undefined ? `mason_dev_${port}=${TOKEN}` : o.cookie;
    if (cookie !== null) headers.Cookie = cookie;
    const origin = o.origin === undefined ? `http://127.0.0.1:${port}` : o.origin;
    if (origin !== null) headers.Origin = origin;
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
    return { status: r.status, text: await r.text() };
  };
  return { shares, logged, ask, tunnels: () => tunnels, stops: () => stops, close: () => server.close() };
}

const OPEN = { from: "page", confirmed: true };

test("the page's share endpoint behind the guard: another Origin, none, no cookie, another run's cookie, and no confirmation are each refused, nothing opened", async () => {
  const s = await shareServer(false);
  try {
    for (const [what, o] of [["another Origin", { origin: "http://evil.example" }], ["no Origin", { origin: null }], ["no cookie", { cookie: null }], ["another run's cookie", { cookie: `mason_dev_1=${"x".repeat(64)}` }]] as const) {
      const r = await s.ask("POST", "/api/share", { body: OPEN, ...o });
      assert.equal(r.status, 403, `${what}: ${r.text}`);
    }
    const unconfirmed = await s.ask("POST", "/api/share", { body: { from: "page" } });
    assert.equal(unconfirmed.status, 400);
    assert.equal(JSON.parse(unconfirmed.text).failure.message, "nothing was shared: a temporary public address is opened only once the person said yes to it");
    assert.equal(s.tunnels(), 0, "no tunnel started");
    assert.equal(s.shares.state(), null, "no share open");
    // a forged beat or stop, from elsewhere, reaches nothing either
    assert.equal((await s.ask("DELETE", "/api/share/share_abcdef", { origin: "http://evil.example" })).status, 403);
  } finally { s.close(); }
});

test("the page's share opened: its password in the one answer and no log line; a beat holds it; Stop sharing ends it and its tunnel; a beat after says it ended and why", async () => {
  const s = await shareServer(false);
  try {
    const choices = await s.ask("GET", "/api/share/choices");
    assert.deepEqual(JSON.parse(choices.text), { choices: [], role: null, reads: "every synced table" });
    const opened = await s.ask("POST", "/api/share", { body: OPEN });
    assert.equal(opened.status, 200, opened.text);
    const r = JSON.parse(opened.text) as { user: string; password: string; host: string; port: number; sslmode: string; beatMs: number; boundMs: number };
    assert.match(r.password, /^mason_share_[0-9a-f]{48}$/);
    assert.deepEqual([r.host, r.port, r.sslmode, r.beatMs, r.boundMs], ["relay.example", 41234, "require", 15_000, 120_000]);
    assert.ok(!s.logged.join("\n").includes(r.password), "no log line carries it");
    assert.ok(!JSON.stringify(s.shares.state()).includes(r.password));
    const second = await s.ask("POST", "/api/share", { body: OPEN });
    assert.equal(second.status, 409);
    assert.match(JSON.parse(second.text).failure.message, new RegExp(`a share is open already: ${r.user}, opened by the web page at relay.example:41234`));
    assert.equal((await s.ask("POST", `/api/share/${r.user}/beat`)).status, 200);
    assert.equal((await s.ask("DELETE", `/api/share/${r.user}`)).status, 200);
    assert.equal(s.stops(), 1, "the tunnel's client stopped");
    assert.equal(s.shares.state(), null);
    const late = await s.ask("POST", `/api/share/${r.user}/beat`);
    assert.equal(late.status, 404);
    assert.equal(JSON.parse(late.text).failure.message, `the share ${r.user} is not open; it ended: Stop sharing, on the web page`);
    // a share of mason share's is its command's to end
    const cmd = await s.shares.open({ secret: "a".repeat(64) });
    assert.ok("user" in cmd);
    const refused = await s.ask("DELETE", `/api/share/${cmd.user}`);
    assert.equal(refused.status, 409);
    assert.match(JSON.parse(refused.text).failure.message, /is mason share's: Ctrl-C in its terminal ends it/);
    await s.shares.closeAll("the test");
  } finally { s.close(); }
});

test("under mason serve the page's share is refused by the endpoint, in the CLI's Failure, whatever is asked", async () => {
  const s = await shareServer(true);
  try {
    for (const [method, p, body] of [["POST", "/api/share", OPEN], ["GET", "/api/share/choices", undefined], ["POST", "/api/share/share_abcdef/beat", undefined], ["DELETE", "/api/share/share_abcdef", undefined]] as const) {
      const r = await s.ask(method, p, body === undefined ? {} : { body });
      assert.equal(r.status, 409, `${method} ${p}: ${r.text}`);
      const f = JSON.parse(r.text).failure as { code: string; message: string; next: Array<{ command: string }> };
      assert.equal(f.code, "refused");
      assert.equal(f.message, "this run is on a server, and has an address of its own: mason share is for a run on a laptop");
      assert.deepEqual(f.next.map((n) => n.command), ["mason help production"]);
    }
    assert.equal(s.tunnels(), 0);
  } finally { s.close(); }
});
