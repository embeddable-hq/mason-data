/**
 * `mason start`'s local pages' guard (src/cli/security.ts): every refusal a request from another site, a
 * DNS-rebinding page or a stale tab meets, and the one way in — the run's token, traded for a cookie. And a source's URL
 * in a shape no mask recognises is never repeated, by any command that reads it (issue 541). And `mason serve`'s MCP
 * endpoint's check of a bearer token (src/cli/mcp-oauth.ts, issue 1115): every way a forged or confused token is told
 * from the issuer's, and every answer of the issuer held untrusted — failing closed when it cannot tell.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import * as security from "../src/cli/security.ts";
// the MCP endpoint's modules, imported when the file loads: at a commit without them each of their tests fails by name
// (scripts/fails-without.ts), never the file
const oauth = await import("../src/cli/mcp-oauth.ts" as string).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; return null; }) as typeof import("../src/cli/mcp-oauth.ts") | null;
const mcpHttp = await import("../src/cli/mcp-http.ts" as string).catch((e: unknown) => { if ((e as NodeJS.ErrnoException).code !== "ERR_MODULE_NOT_FOUND") throw e; return null; }) as typeof import("../src/cli/mcp-http.ts") | null;
const { parseProxyFrom } = await import("../src/api/postgres/proxy.ts");
const mcpSettings: typeof import("../src/cli/mcp-oauth.ts").mcpSettings = (...a) => { assert.ok(oauth !== null, "src/cli/mcp-oauth.ts"); return oauth.mcpSettings(...a); };
type Issuer = import("../src/cli/mcp-oauth.ts").Issuer;
import { cookieName, cookieOf, guard, newToken, newTunnel, sameSecret, setCookieHeader, SECURITY_HEADERS, TICKET_MS, type GuardRequest } from "../src/cli/security.ts";

const token = newToken();
const port = 4039;
const cookie = `other=1; mason_dev_4039=${token}`;

test("the token in the URL is traded for an HttpOnly, SameSite=Strict cookie, and the URL loses it", () => {
  // (a browser never sends the #fragment, and keeps it across the redirect: a link to #/playground lands there)
  const v = guard({ method: "GET", url: `/x?a=1&token=${token}`, host: "127.0.0.1:4039" }, port, token);
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.status === 303);
  if (!v.ok && v.status === 303) {
    assert.equal(v.location, "./x?a=1");
    assert.match(v.setCookie!, /^mason_dev_4039=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
  }
  assert.equal(setCookieHeader("x", 4039), "mason_dev_4039=x; HttpOnly; SameSite=Strict; Path=/");
});

test("the trade's redirect is relative to the address asked, so a page a proxy serves under a prefix lands back there", () => {
  // the server sees /?token=… whatever prefix a reverse proxy stripped; the browser resolves Location against what IT asked
  const at = (url: string) => { const v = guard({ method: "GET", url, host: "127.0.0.1:4039" }, port, token); assert.ok(!v.ok && v.status === 303); return v.location; };
  assert.equal(at(`/?token=${token}`), "./");
  assert.equal(new URL(at(`/?token=${token}`), `https://example.com/tools/mason/?token=${token}`).href, "https://example.com/tools/mason/");
  assert.equal(new URL(at(`/?token=${token}`), `http://127.0.0.1:4039/?token=${token}`).href, "http://127.0.0.1:4039/", "mason ui's own URL, at /");
  assert.equal(new URL(at(`/x?a=1&token=${token}`), `https://example.com/p/x?a=1&token=${token}`).href, "https://example.com/p/x?a=1");
  // a tunnel's ticket alike
  const t = newTunnel(51000, 1000);
  const v = guard({ method: "GET", url: `/?ticket=${t.ticket}`, host: "127.0.0.1:51000" }, port, token, [t], 1000);
  assert.ok(!v.ok && v.status === 303 && v.location === "./");
});

test("a request with the run's cookie is served; without it, or with another run's, refused", () => {
  assert.deepEqual(guard({ method: "GET", url: "/api/state", host: "127.0.0.1:4039", cookie }, port, token), { ok: true });
  assert.deepEqual(guard({ method: "GET", url: "/api/state", host: "localhost:4039", cookie }, port, token), { ok: true });
  for (const c of [undefined, "mason_dev_4039=", `mason_dev_4039=${newToken()}`, `mason_dev=${token}`, `mason_dev_4040=${token}`]) {
    const v = guard({ method: "GET", url: "/api/state", host: "127.0.0.1:4039", cookie: c }, port, token);
    assert.ok(!v.ok && v.status === 403, String(c));
  }
  const wrong = guard({ method: "GET", url: "/?token=00", host: "127.0.0.1:4039" }, port, token);
  assert.ok(!wrong.ok && wrong.status === 403, "a wrong token in the URL sets nothing");
});

test("a page that reaches 127.0.0.1 under another name (DNS rebinding) is refused by that name", () => {
  for (const host of ["evil.example:4039", "127.0.0.1:4040", "127.0.0.1", undefined]) {
    const v = guard({ method: "GET", url: `/?token=${token}`, host, cookie }, port, token);
    assert.ok(!v.ok && v.status === 421, String(host));
  }
});

test("a change must come from the page itself: another site's origin, or none, is refused", () => {
  const post = (origin: string | undefined) => guard({ method: "POST", url: "/api/pick", host: "127.0.0.1:4039", cookie, origin }, port, token);
  assert.deepEqual(post("http://127.0.0.1:4039"), { ok: true });
  assert.deepEqual(post("http://localhost:4039"), { ok: true });
  for (const o of ["http://evil.example", "http://127.0.0.1:4040", "null", undefined]) {
    const v = post(o);
    assert.ok(!v.ok && v.status === 403, String(o));
  }
});

test("helpers: cookies are read by name, secrets compared whole, and the pages refuse framing", () => {
  assert.equal(cookieOf("a=1; mason_dev_4039=abc; b=2", "mason_dev_4039"), "abc");
  assert.equal(cookieOf("mason_dev_40390=abc", "mason_dev_4039"), null);
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.match(SECURITY_HEADERS["Content-Security-Policy"]!, /frame-ancestors 'none'/);
  assert.equal(SECURITY_HEADERS["Referrer-Policy"], "no-referrer");
});

test("the commands send the run's token as a Bearer header: served without a cookie or an Origin; another token refused", () => {
  const req = { method: "POST", url: "/api/pick", host: `127.0.0.1:${port}` };
  assert.deepEqual(guard({ ...req, authorization: `Bearer ${token}` }, port, token), { ok: true });
  assert.equal((guard({ ...req, authorization: "Bearer nope" }, port, token) as { status: number }).status, 403);
  assert.equal((guard({ ...req, authorization: "Basic abc", cookie: `mason_dev_${port}=${token}`, origin: `http://127.0.0.1:${port}` }, port, token) as { status: number }).status, 403,
    "a header that is not the token is refused, whatever else the request carries");
  assert.equal((guard({ ...req, host: "evil.example", authorization: `Bearer ${token}` }, port, token) as { status: number }).status, 421, "the Host is checked first");
});

test("two runs on one machine keep a cookie each: the browser sends both to either port, and each run reads its own", () => {
  // a browser keeps cookies per host, never per port: one name for every run, and opening the second run's page
  // replaced the first's cookie, logging it out (review)
  const a = newToken(), b = newToken();
  const cookieName = (security as { cookieName?: (port: number) => string }).cookieName;
  assert.equal(typeof cookieName, "function", "src/cli/security.ts names the cookie for the port");
  const jar = `${cookieName!(4039)}=${a}; ${cookieName!(4040)}=${b}`;
  assert.deepEqual(guard({ method: "GET", url: "/api/state", host: "127.0.0.1:4039", cookie: jar }, 4039, a), { ok: true });
  assert.deepEqual(guard({ method: "GET", url: "/api/state", host: "127.0.0.1:4040", cookie: jar }, 4040, b), { ok: true });
  const one = guard({ method: "GET", url: `/?token=${a}`, host: "127.0.0.1:4039" }, 4039, a);
  const two = guard({ method: "GET", url: `/?token=${b}`, host: "127.0.0.1:4040" }, 4040, b);
  assert.ok(!one.ok && one.status === 303 && !two.ok && two.status === 303);
  if (!one.ok && one.status === 303 && !two.ok && two.status === 303) assert.notEqual(one.setCookie!.split("=")[0], two.setCookie!.split("=")[0], "each run sets a cookie of its own name");
});

test("a tunnel adds its port's two loopback names and nothing else, for as long as it is open", () => {
  const token = "r".repeat(64);
  const t = newTunnel(51000, 1000);
  const ticket = t.ticket!;
  const at = (req: Partial<GuardRequest>, now = 2000): ReturnType<typeof guard> => guard({ method: "GET", url: "/", ...req }, 4039, token, [t], now);
  // any other Host stays refused: a rebinding page names itself, whatever the port
  for (const host of ["evil.example:51000", "51000", "127.0.0.1", "127.0.0.1:51001", "127.0.0.1.evil.example:51000", "[::1]:51000"]) {
    const v = at({ host, url: `/?ticket=${ticket}` });
    assert.ok(!v.ok && v.status === 421, host);
  }
  assert.equal(t.ticket, ticket, "a refused Host spends no ticket");
  // past its time, a ticket is refused
  const late = at({ host: "127.0.0.1:51000", url: `/?ticket=${ticket}` }, 1000 + TICKET_MS);
  assert.ok(!late.ok && late.status === 403);
  // a POST never spends it
  const posted = at({ method: "POST", host: "127.0.0.1:51000", url: `/?ticket=${ticket}`, origin: "http://127.0.0.1:51000" });
  assert.ok(!posted.ok && posted.status === 403);
  // the trade: once, by either name, the cookie named for the tunnel's port and holding its session, never the token
  const v = at({ host: "LOCALHOST:51000", url: `/x?a=1&ticket=${ticket}` });
  assert.ok(!v.ok && v.status === 303);
  if (!v.ok && v.status === 303) {
    assert.equal(v.location, "./x?a=1");
    assert.equal(v.setCookie, setCookieHeader(t.session, 51000));
    assert.ok(!v.setCookie!.includes(token));
  }
  assert.equal(t.ticket, null);
  const cookie = `${cookieName(51000)}=${t.session}`;
  // the same URL again: refused, but a browser that holds the cookie (a reload of it) is sent on, with nothing new
  const again = at({ host: "127.0.0.1:51000", url: `/?ticket=${ticket}` });
  assert.ok(!again.ok && again.status === 403);
  const reload = at({ host: "127.0.0.1:51000", url: `/?ticket=${ticket}`, cookie });
  assert.ok(!reload.ok && reload.status === 303 && reload.setCookie === undefined);
  assert.deepEqual(at({ host: "127.0.0.1:51000", url: "/api/state", cookie }), { ok: true });
  assert.deepEqual(at({ host: "localhost:51000", url: "/api/state", cookie }), { ok: true });
  // a change: its own Origin only
  assert.deepEqual(at({ method: "POST", host: "127.0.0.1:51000", cookie, origin: "http://127.0.0.1:51000" }), { ok: true });
  for (const origin of [undefined, "http://evil.example", "http://127.0.0.1:4039", "https://127.0.0.1:51000"]) {
    const o = at({ method: "POST", host: "127.0.0.1:51000", cookie, origin });
    assert.ok(!o.ok && o.status === 403, String(origin));
  }
  // the run's cookie and Bearer are no good here, and the tunnel's cookie is none on the run's own Host
  const bearer = at({ host: "127.0.0.1:51000", authorization: `Bearer ${token}` });
  assert.ok(!bearer.ok && bearer.status === 403);
  const own = at({ host: "127.0.0.1:51000", cookie: `${cookieName(51000)}=${token}` });
  assert.ok(!own.ok && own.status === 403);
  const crossed = at({ host: "127.0.0.1:4039", cookie: `${cookieName(4039)}=${t.session}` });
  assert.ok(!crossed.ok && crossed.status === 403);
  // the run's own server is as it was, and with the tunnel gone its Host is refused again
  assert.deepEqual(at({ host: "127.0.0.1:4039", authorization: `Bearer ${token}` }), { ok: true });
  const gone = guard({ method: "GET", url: "/", host: "127.0.0.1:51000", cookie }, 4039, token, []);
  assert.ok(!gone.ok && gone.status === 421);
});

/**
 * A SOURCE'S URL THAT NO MASK RECOGNISES (issue 541): every command that reads the source's URL — the sources file's
 * `${DATABASE_URL}` from .env, DATABASE_URL to mason serve, MASON_URL to mason mcp — given a keyword/value string, a bare
 * password, a URL whose password holds an unencoded @, one whose password holds an unencoded / (which splits the
 * URL into a host, a port and a path), a password as a query parameter (`?password=`, `?sslpassword=`), and one inside
 * the value of a parameter Mason reads (`sslmode=prefer%26password=…`, a repeated sslmode, an application_name). Each password is a marker no answer, stream, --json or log file may hold.
 */
test("a source URL in any shape never repeats its password: every command that reads it, person and --json, and the logs", { timeout: 600_000 }, async () => {
  const KEY = "k".repeat(48);
  const values: Array<[string, string]> = [
    ["host=127.0.0.1 port=1 user=mason password=Mk541KvPw dbname=shop", "Mk541KvPw"],
    ["Mk541BarePw", "Mk541BarePw"],
    ["postgres://mason:p@Mk541AtPw@127.0.0.1:1/shop", "Mk541AtPw"],
    ["postgres://mason:12/Mk541SlashPw@127.0.0.1:1/shop", "Mk541SlashPw"],
    // a password libpq reads from the query, where no mask of the userinfo looks (the review of #575)
    ["postgres://mason@127.0.0.1:1/shop?password=Mk541QueryPw", "Mk541QueryPw"],
    ["postgres://mason:x@127.0.0.1:1/shop?sslmode=disable&sslpassword=Mk541SslPw", "Mk541SslPw"],
    // a password inside the VALUE of a parameter Mason reads (the review of #575, round 2)
    ["postgres://mason@127.0.0.1:1/shop?sslmode=prefer%26password=Mk541EncAmpPw", "Mk541EncAmpPw"],
    ["postgres://mason@127.0.0.1:1/shop?sslmode=prefer;password=Mk541SemiPw", "Mk541SemiPw"],
    ["postgres://mason:x@127.0.0.1:1/shop?sslmode=Mk541SslValuePw", "Mk541SslValuePw"],
    ["postgres://mason:x@127.0.0.1:1/shop?sslmode=prefer&sslmode=Mk541RepeatPw", "Mk541RepeatPw"],
    ["postgres://mason:x@127.0.0.1:1/shop?application_name=password=Mk541AppValuePw", "Mk541AppValuePw"],
  ];
  const filesUnder = (dir: string): string[] => !fs.existsSync(dir) ? [] : fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile()).map((d) => path.join(d.parentPath, d.name));
  await Promise.all(values.map(async ([value, marker]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-541-"));
    try {
      const home = path.join(root, "home");
      fs.mkdirSync(home);
      const env = matrixEnv({ HOME: home });
      // a project whose sources file names ${DATABASE_URL}, given the value in its .env; a second one whose config an older
      // Mason recorded as streaming, so mason destroy reads the URL too (to drop the slot)
      const projectOf = (name: string, extra: Record<string, unknown>): string => {
        const dir = path.join(root, name);
        fs.mkdirSync(path.join(dir, ".mason"), { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.join(dir, "mason", "sources"), { recursive: true });
        fs.writeFileSync(path.join(dir, "mason", "sources", "shop.yml"), "kind: postgres\nurl: ${DATABASE_URL}\ntables: {}\n");
        fs.writeFileSync(path.join(dir, ".env"), `DATABASE_URL=${value}\n`, { mode: 0o600 });
        fs.writeFileSync(path.join(dir, ".mason", "config.json"), JSON.stringify({
          name: "shop", folder: "mason", remote: false, apiKey: KEY, sourceServer: null, lastRun: null, running: null, ...extra,
        }), { mode: 0o600 });
        return dir;
      };
      const project = projectOf("project", {});
      const streamed = projectOf("streamed", { changes: "replication" });
      // a folder mason init makes a project of, the URL in its .env
      const fresh = path.join(root, "fresh");
      fs.mkdirSync(fresh);
      fs.writeFileSync(path.join(fresh, ".env"), `DATABASE_URL=${value}\n`, { mode: 0o600 });
      // a server's folder: its settings from the environment alone
      const served = path.join(root, "served");
      fs.mkdirSync(path.join(served, "data"), { recursive: true });
      const serveEnv = { ...env, DATABASE_URL: value, MASON_API_KEY: KEY, MASON_DATA: path.join(served, "data") };
      const runs: Array<[string, string[], Record<string, string>]> = [];
      for (const json of [[], ["--json"]]) {
        for (const argv of [["start"], ["start", "--attach"], ["doctor"], ["tables"], ["add", "orders"], ["status"]]) runs.push([project, [...argv, ...json], env]);
        runs.push([fresh, ["init", ...json], env]);
        runs.push([served, ["serve", ...json], serveEnv]);
      }
      runs.push([fresh, ["mcp"], { ...env, MASON_URL: value }]);
      const answers: Answer[] = [];
      for (const [cwd, argv, e] of runs) answers.push(await runMason(cwd, argv, e));
      for (const json of [[], ["--json"]]) answers.push(await runMason(streamed, ["destroy", ...json], env));
      for (const a of answers) {
        assert.equal(a.signal, null, `mason ${a.argv.join(" ")} hung`);
        assert.ok(!(a.stdout + a.stderr).includes(marker), `mason ${a.argv.join(" ")} given ${JSON.stringify(value)} repeated its password:\n${a.stdout}${a.stderr}`);
      }
      // every file the commands wrote (the .env the test wrote holds the value, as it is meant to)
      const files = [project, streamed, fresh, served, home].flatMap(filesUnder).filter((f) => path.basename(f) !== ".env");
      assert.ok(files.some((f) => /\.log$/.test(f)), `the runs wrote their logs: ${files.join(", ")}`);
      for (const file of files) {
        assert.ok(!fs.readFileSync(file, "latin1").includes(marker), `${path.relative(root, file)} holds the password of ${JSON.stringify(value)}`);
      }
      // the refusal names where the value is and what it looks like, never the value
      if (value.startsWith("host=")) {
        const doctor = answers.find((a) => a.argv.join(" ") === "doctor")!;
        assert.match(doctor.stdout + doctor.stderr, /DATABASE_URL in \.env is not a postgres:\/\/ URL: it looks like a keyword\/value connection string/);
        const start = answers.find((a) => a.argv.join(" ") === "start")!;
        assert.match(start.stdout + start.stderr, /DATABASE_URL in \.env is not a postgres:\/\/ URL: it looks like a keyword\/value connection string/, "mason start reached the URL");
        const serve = answers.find((a) => a.argv.join(" ") === "serve --json")!;
        assert.match(serve.stdout, /DATABASE_URL is not a postgres:\/\/ URL: it looks like a keyword\/value connection string \(host=… user=… password=…\)\. Write it as postgres:\/\/user:password@host:5432\/your_app/);
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }));
});


// ------------------------------------------------------------------ mason serve's MCP endpoint: the bearer token

const ISSUER = "https://auth.example.test";
const RESOURCE = "https://mason.example.test/mcp";
const rsaKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const weakKey = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
const edKey = crypto.generateKeyPairSync("ed25519");
const jwk = (k: crypto.KeyObject, kid: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ ...k.export({ format: "jwk" }), kid, ...more });

/** a token: its header and claims, signed as the header's alg says, by `key` */
function bearer(header: Record<string, unknown>, claims: Record<string, unknown>, key: crypto.KeyObject | Buffer | null): string {
  const b = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  const signed = `${b(header)}.${b(claims)}`;
  const alg = String(header.alg);
  const sig = key === null ? Buffer.alloc(0) : Buffer.isBuffer(key) ? crypto.createHmac("sha256", key).update(signed).digest()
    : alg === "EdDSA" ? crypto.sign(null, Buffer.from(signed), key) : crypto.sign("sha256", Buffer.from(signed), key);
  return `${signed}.${sig.toString("base64url")}`;
}
const valid = (more: Record<string, unknown> = {}): Record<string, unknown> => ({ iss: ISSUER, aud: RESOURCE, mason_user: "analyst", mason_user_id: "0123456789abcdef", exp: Math.floor(Date.now() / 1000) + 600, ...more });
const JWKS_AT = `${ISSUER}/jwks`;

/** an issuer whose answers are a test's, by URL; what was asked, in order */
function issuerOf(answers: Record<string, () => Response>, asked: string[] = []): Issuer {
  assert.ok(oauth !== null, "src/cli/mcp-oauth.ts");
  const s = mcpSettings({ MASON_MCP_URL: RESOURCE, MASON_MCP_ISSUER: ISSUER, MASON_MCP_JWKS_URL: JWKS_AT }, "127.0.0.1");
  assert.ok(s !== null && !("problems" in s));
  return new oauth.Issuer(s, { log: () => undefined, fetch: async (url, init) => {
    asked.push(url);
    assert.equal(init.redirect, "manual", "a redirect is never followed");
    const a = answers[url];
    if (a === undefined) return new Response("", { status: 404 });
    return a();
  } });
}
const json = (v: unknown): () => Response => () => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const KEYS = { [JWKS_AT]: json({ keys: [jwk(rsaKey.publicKey, "r1", { use: "sig" }), jwk(weakKey.publicKey, "weak"), jwk(edKey.publicKey, "ed"), jwk(rsaKey.publicKey, "enc", { use: "enc" })] }) };

test("an MCP bearer token: the issuer's signature by its published key alone — never alg none, an HMAC keyed by the public key, a weak or an encryption key", async () => {
  const issuer = issuerOf(KEYS);
  assert.deepEqual(await issuer.check(bearer({ alg: "RS256", kid: "r1" }, valid(), rsaKey.privateKey)), { user: "analyst", id: "0123456789abcdef" });
  assert.deepEqual(await issuer.check(bearer({ alg: "EdDSA", kid: "ed" }, valid(), edKey.privateKey)), { user: "analyst", id: "0123456789abcdef" });
  const publicBytes = Buffer.from(rsaKey.publicKey.export({ format: "pem", type: "spki" }) as string);
  const refused: Array<[string, string, RegExp]> = [
    ["alg none", bearer({ alg: "none", kid: "r1" }, valid(), null), /never none nor HS/],
    ["alg None", bearer({ alg: "None", kid: "r1" }, valid(), null), /never none nor HS/],
    ["HS256 keyed by the published key", bearer({ alg: "HS256", kid: "r1" }, valid(), publicBytes), /never none nor HS/],
    ["a 1024-bit RSA key", bearer({ alg: "RS256", kid: "weak" }, valid(), weakKey.privateKey), /none of the issuer's published keys/],
    ["a key published for encryption", bearer({ alg: "RS256", kid: "enc" }, valid(), rsaKey.privateKey), /none of the issuer's published keys/],
    ["EdDSA named on an RSA key", bearer({ alg: "EdDSA", kid: "r1" }, valid(), edKey.privateKey), /does not fit its key's type/],
    ["a signature cut off", bearer({ alg: "RS256", kid: "r1" }, valid(), rsaKey.privateKey).replace(/\.[^.]+$/, "."), /no signature/],
    ["an audience list without this endpoint", bearer({ alg: "RS256", kid: "r1" }, valid({ aud: ["https://other.example.test", `${RESOURCE}/`] }), rsaKey.privateKey), /audience/],
    // exactly this endpoint: a list naming it beside another is a token the other could replay here
    ["an audience list of this endpoint and another", bearer({ alg: "RS256", kid: "r1" }, valid({ aud: ["https://other.example.test", RESOURCE] }), rsaKey.privateKey), /audience \(aud\) must be exactly/],
    ["a user name of another grammar", bearer({ alg: "RS256", kid: "r1" }, valid({ mason_user: "Robert'); --" }), rsaKey.privateKey), /not a mason user's name/],
    ["an id of another grammar", bearer({ alg: "RS256", kid: "r1" }, valid({ mason_user_id: "1 OR 1=1" }), rsaKey.privateKey), /not a mason user's id/],
    ["a JWE", "a.b.c.d.e", /encrypted/],
    ["too long", "a".repeat(20_000), /at most/],
  ];
  for (const [what, t, re] of refused) {
    const r = await issuer.check(t);
    assert.ok("status" in r && r.status === 401, what);
    assert.match(r.reason, re, what);
    // what is said of a token never holds it, nor its signature
    assert.ok(!r.reason.includes(t.slice(-16)), what);
  }
  // a list of this endpoint alone is accepted
  assert.ok("user" in await issuer.check(bearer({ alg: "RS256", kid: "r1" }, valid({ aud: [RESOURCE] }), rsaKey.privateKey)));
});

test("the issuer's keys are untrusted: a redirect not followed, an answer too large or not JSON, no key Mason can read, the server down — every token refused 503, never let through; a JWKS URL that is not https refused at the start", async () => {
  const t = bearer({ alg: "RS256", kid: "r1" }, valid(), rsaKey.privateKey);
  const cases: Array<[string, Record<string, () => Response>, RegExp]> = [
    ["a redirect", { [JWKS_AT]: () => new Response("", { status: 302, headers: { location: "https://evil.example.test/" } }) }, /HTTP 302 \(a redirect, which Mason does not follow\)/],
    ["keys too large", { [JWKS_AT]: () => new Response("x".repeat(600_000)) }, /more than/],
    ["keys not JSON", { [JWKS_AT]: () => new Response("<html>") }, /not JSON/],
    ["not a JWK set", { [JWKS_AT]: json({ issuer: ISSUER }) }, /not a JWK set/],
    ["no key Mason can read", { [JWKS_AT]: json({ keys: [{ kty: "oct", k: "c2VjcmV0", kid: "r1" }] }) }, /no signing key/],
    ["the issuer down", { [JWKS_AT]: () => { throw new TypeError("fetch failed"); } }, /could not be fetched/],
  ];
  for (const [what, answers, re] of cases) {
    const asked: string[] = [];
    const r = await issuerOf(answers, asked).check(t);
    assert.ok("status" in r && r.status === 503, `${what}: ${JSON.stringify(r)}`);
    assert.match(r.reason, re, what);
    assert.deepEqual([...new Set(asked)], [JWKS_AT], `${what}: the JWKS URL set, and nothing else, asked`);
  }
  const plain = mcpSettings({ MASON_MCP_URL: RESOURCE, MASON_MCP_ISSUER: ISSUER, MASON_MCP_JWKS_URL: "http://auth.example.test/jwks" }, "127.0.0.1");
  assert.ok(plain !== null && "problems" in plain && /MASON_MCP_JWKS_URL is http:\/\/auth\.example\.test\/…: https:\/\//.test(plain.problems.join("; ")));
});

/** An issuer on a clock the test moves, its JWKS answer the test's (`answer`), counting its fetches; each fetch takes
 *  `slowMs` (real time) so concurrent checks overlap it. */
function clockedIssuer(answer: () => Response, slowMs = 0): { issuer: Issuer; fetches: () => number; tick: (ms: number) => void } {
  assert.ok(oauth !== null, "src/cli/mcp-oauth.ts");
  const s = mcpSettings({ MASON_MCP_URL: RESOURCE, MASON_MCP_ISSUER: ISSUER, MASON_MCP_JWKS_URL: JWKS_AT }, "127.0.0.1");
  assert.ok(s !== null && !("problems" in s));
  let at = Date.now(), n = 0;
  const issuer = new oauth.Issuer(s, { log: () => undefined, now: () => at, fetch: async () => {
    n++;
    if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
    return answer();
  } });
  return { issuer, fetches: () => n, tick: (ms) => { at += ms; } };
}
/** a token that stays within its exp however far the test's clock moves */
const lasting = (kid = "r1"): string => bearer({ alg: "RS256", kid }, valid({ exp: Math.floor(Date.now() / 1000) + 86_400 }), rsaKey.privateKey);
const MIN = 60_000;
const statusOf = (r: { status: number } | { user: string }): number => "status" in r ? r.status : 200;

test("the issuer's keys are fetched ONE at a time and at most once a minute whatever asks — a JWKS that fails backs off, bounded, and refuses every token 503 meanwhile; a burst of tokens with made-up kids is one fetch a minute", async () => {
  assert.ok(oauth !== null, "src/cli/mcp-oauth.ts");
  // the JWKS failing: 53 tokens, valid or not, then a concurrent burst: ONE fetch; every one 503, never let through
  let up = false;
  const down = clockedIssuer(() => up ? json({ keys: [jwk(rsaKey.publicKey, "r1", { use: "sig" })] })() : new Response("", { status: 500 }), 20);
  for (let i = 0; i < 53; i++) {
    const r = await down.issuer.check(i % 2 ? lasting() : lasting(`made-up-${i}`));
    assert.ok("status" in r && r.status === 503, `${i}: ${JSON.stringify(r)}`);
  }
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => down.issuer.check(lasting(`burst-${i}`))));
  assert.ok(burst.every((r) => "status" in r && r.status === 503));
  assert.equal(down.fetches(), 1, "53 requests and a burst of 30, one fetch");
  // the next fetch a minute on; failing again, two minutes after that, then four… never past BACKOFF_MAX_MS
  const waits: number[] = [];
  for (let k = 0; k < 8; k++) {
    const before = down.fetches();
    let waited = 0;
    while (down.fetches() === before) {
      down.tick(10_000); waited += 10_000;
      assert.ok(waited <= oauth.BACKOFF_MAX_MS, `fetch ${k + 2} waited past the bound`);
      for (let i = 0; i < 5; i++) assert.equal(statusOf(await down.issuer.check(lasting())), 503);
    }
    assert.equal(down.fetches(), before + 1, "one fetch per wait, whatever the requests between");
    waits.push(waited);
  }
  assert.deepEqual(waits.slice(0, 4), [MIN, 2 * MIN, 4 * MIN, 8 * MIN]);
  assert.ok(waits.every((w) => w <= oauth.BACKOFF_MAX_MS) && waits.at(-1) === oauth.BACKOFF_MAX_MS, waits.join(", "));
  // back up: at its next fetch the keys judge again
  up = true;
  down.tick(oauth.BACKOFF_MAX_MS);
  assert.deepEqual(await down.issuer.check(lasting()), { user: "analyst", id: "0123456789abcdef" });

  // healthy keys, a stream of made-up kids: one fetch a minute, single-flight under a burst
  const ok = clockedIssuer(json({ keys: [jwk(rsaKey.publicKey, "r1", { use: "sig" })] }), 20);
  assert.ok("user" in await ok.issuer.check(lasting()));
  assert.equal(ok.fetches(), 1);
  for (let i = 0; i < 50; i++) assert.equal(statusOf(await ok.issuer.check(lasting(`made-up-${i}`))), 401);
  assert.equal(ok.fetches(), 1, "within the minute: no fetch for a made-up kid");
  ok.tick(MIN);
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => ok.issuer.check(lasting(`again-${i}`))));
  assert.ok(many.every((r) => "status" in r && r.status === 401));
  assert.equal(ok.fetches(), 2, "a burst past the minute: one fetch");
});

test("a key the issuer removes is refused within KEYS_TTL_MS (5 minutes), sooner under a shorter Cache-Control max-age, never later under a longer; keys past their life are never used again: a failed fetch then refuses (503)", async () => {
  assert.ok(oauth !== null, "src/cli/mcp-oauth.ts");
  assert.ok(oauth.KEYS_TTL_MS <= 5 * MIN, "a removal takes effect within a few minutes");
  const both = { keys: [jwk(rsaKey.publicKey, "r1", { use: "sig" }), jwk(edKey.publicKey, "ed")] };
  const edOnly = { keys: [jwk(edKey.publicKey, "ed")] };
  for (const [what, cacheControl, life] of [["no Cache-Control", null, oauth.KEYS_TTL_MS], ["max-age=90", "public, max-age=90", 90_000],
    ["max-age=86400, capped", "max-age=86400", oauth.KEYS_TTL_MS], ["max-age=5, floored at a minute", "max-age=5", MIN], ["no-store", "no-store", MIN]] as const) {
    let published: unknown = both;
    const at = clockedIssuer(() => new Response(JSON.stringify(published), { status: 200, headers: cacheControl === null ? {} : { "cache-control": cacheControl } }));
    assert.ok("user" in await at.issuer.check(lasting()), what);
    // the issuer drops r1: still accepted from the cache until its life ends, refused once it has
    published = edOnly;
    at.tick(life - 1_000);
    assert.ok("user" in await at.issuer.check(lasting()), `${what}: within its life`);
    at.tick(1_000);
    const after = await at.issuer.check(lasting());
    assert.ok("status" in after && after.status === 401, `${what}: ${JSON.stringify(after)}`);
    assert.match((after as { reason: string }).reason, /none of the issuer's published keys/);
  }
  // past their life the keys are not trusted on a failure: 503, never the old key accepted
  let failing = false;
  const f = clockedIssuer(() => failing ? new Response("", { status: 503 }) : json(both)());
  assert.ok("user" in await f.issuer.check(lasting()));
  failing = true;
  f.tick(oauth.KEYS_TTL_MS);
  for (let i = 0; i < 3; i++) {
    const r = await f.issuer.check(lasting());
    assert.ok("status" in r && r.status === 503, JSON.stringify(r));
  }
  assert.equal(f.fetches(), 2, "one fetch after the life ended, then the back-off");
});

test("the MCP endpoint's client address: a named proxy's LAST X-Forwarded-For entry alone; an entry the client forged in front of it, and a header from a peer not named, never believed", () => {
  assert.ok(mcpHttp !== null, "src/cli/mcp-http.ts");
  const { clientOf } = mcpHttp;
  const relay = parseProxyFrom("10.0.0.1, 2001:db8::1", "MASON_MCP_PROXY_FROM");
  assert.ok(relay !== null && !("problem" in relay));
  // a peer no setting names: its own address, whatever header it sends (a client can send any)
  assert.deepEqual(clientOf("203.0.113.7", "10.1.2.3", relay), { address: "203.0.113.7" });
  assert.deepEqual(clientOf("::ffff:203.0.113.7", "10.1.2.3", null), { address: "203.0.113.7" });
  // the named relay: the entry IT appended, the last; what came before it is the client's to write
  assert.deepEqual(clientOf("10.0.0.1", "10.1.2.3", relay), { address: "10.1.2.3" });
  assert.deepEqual(clientOf("10.0.0.1", "10.9.9.9, 198.51.100.4", relay), { address: "198.51.100.4" });
  assert.deepEqual(clientOf("10.0.0.1", ["10.9.9.9", "198.51.100.4"], relay), { address: "198.51.100.4" }, "the header sent twice: the last line's last entry");
  assert.deepEqual(clientOf("::ffff:10.0.0.1", "  198.51.100.4  ", relay), { address: "198.51.100.4" });
  assert.deepEqual(clientOf("2001:db8::1", "2001:db8:7::9", relay), { address: "2001:db8:7::9" });
  // the forms relays write (issue 1115's review): a port beside the address, IPv6 in brackets with or without one, and
  // a v4-mapped address (nginx on a dual-stack [::] listener) — the one address each names, as Mason shows it
  for (const [header, address] of [["203.0.113.7:51234", "203.0.113.7"], ["[2001:db8::1]:443", "2001:db8::1"], ["[2001:DB8::1]", "2001:db8::1"],
    ["::ffff:203.0.113.7", "203.0.113.7"], ["[::ffff:203.0.113.7]:8080", "203.0.113.7"], ["10.9.9.9, 203.0.113.7:51234", "203.0.113.7"],
    ["2001:db8::1:443", "2001:db8::1:443"]] as const) {
    assert.deepEqual(clientOf("10.0.0.1", header, relay), { address }, header);
  }
  // still the LAST entry alone: a port-carrying entry the client wrote in front is never read
  assert.deepEqual(clientOf("10.0.0.1", "10.1.2.3:443, 198.51.100.4", relay), { address: "198.51.100.4" });
  // the relay itself, seen as v4-mapped (a dual-stack listener) or with its v6 spelt another way: named, its entry read
  assert.deepEqual(clientOf("::ffff:10.0.0.1", "203.0.113.7:51234", relay), { address: "203.0.113.7" });
  assert.deepEqual(clientOf("2001:0db8:0:0:0:0:0:1", "[::ffff:198.51.100.4]:1", relay), { address: "198.51.100.4" });
  // a named relay that does not say, or says what is not one address: refused, never the relay itself let in
  for (const header of [undefined, "", "10.1.2.3, ", "unknown", "10.0.0.0/8", "10.1.2.3:", "10.1.2.3:99999", "10.1.2.3:x", "[10.1.2.3]:443", "[2001:db8::9]:", "[2001:db8::9]:70000",
    "[2001:db8::9", "010.1.2.3", "10.1.2.3:443:1", "relay.example.test", "relay.example.test:443", "fe80::1%eth0", "[fe80::1%25eth0]:443", "[2001:db8::/32]"]) {
    assert.ok("refused" in clientOf("10.0.0.1", header, relay), String(header));
  }
  assert.ok("refused" in clientOf(undefined, undefined, null), "a peer that cannot be read");
});
