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
    source, facts: () => ({ version: 160000, versionText: "16", standby: false, tables: [], systemIdentifier: null }), warnings: [], slot: "", changes: "poll",
    port: 0, token: TOKEN, page, users: { file: path.join(root, ".mason", "users.json"), apiKey: "k".repeat(48), database: "shop", postgresUrl: "postgresql://127.0.0.1:5433/shop" },
    folder: () => null, root, home: path.join(root, ".mason"), version: "test", startedAt: Date.now(), sources: () => ({ file: null, problem: null }), sourcesChanged: () => undefined, log: () => undefined,
    readSource: () => ({ message: "none", code: "bad_source" }), runUrl: "",
    duck: { copies: () => [], file: path.join(root, "duck.db"), pollSeconds: 5, poll: async () => ({ at: "", tables: [] }), stream: async () => null,
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

test("mason ui, a run that serves no page (mason serve's): refused with the way out, and no URL printed", async () => {
  const p = await upProject(false);
  try {
    const a = await runMason(p.root, ["ui", "--json"], matrixEnv());
    assert.equal(a.code, 1);
    assert.deepEqual(JSON.parse(a.stdout), { error: { code: "refused", message: "Mason for shop serves no web page",
      why: "the page is mason start's: this is mason serve's run, or a run started by a Mason from before the page",
      fix: "on your machine, mason stop && mason start runs it with the page; a server's Mason is read with mason status" },
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
