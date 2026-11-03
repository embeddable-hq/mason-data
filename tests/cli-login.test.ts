/**
 * `mason login` AND `mason logout` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts: no network, an http server of
 * this test's on 127.0.0.1, which plain http may name): the real CLI as a child process, its service `MASON_CLOUD_URL`,
 * its home a temp folder. The contract is docs/HOSTED-API.md; what each test holds is in its name. The device flow, the
 * base URL, the credentials file, MASON_TOKEN and logout are here; what the service's values may and may not do to the
 * output is tests/cli-login-service.test.ts's. Every run is held by `mason` to the rules no answer may break.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ANSWERS, DEVICE, ME, MAIN, SECRETS, credentials, envFor, fakeService, granted, home, mason, mode, newToken, noTokenLeaked, pending, saved, writeSaved, type Reply, type Req, type Script } from "./hosted-fake.ts";

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

test("no token reaches any stdout or stderr of mason login or mason logout, in any run of this file, success or failure", () => {
  noTokenLeaked([["login", true], ["login", false], ["logout", true], ["logout", false]]);
});
