/**
 * `mason start`'s local pages' guard (src/cli/security.ts): every refusal a request from another site, a
 * DNS-rebinding page or a stale tab meets, and the one way in — the run's token, traded for a cookie.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as security from "../src/cli/security.ts";
import { cookieOf, guard, newToken, sameSecret, setCookieHeader, SECURITY_HEADERS } from "../src/cli/security.ts";

const token = newToken();
const port = 4039;
const cookie = `other=1; mason_dev_4039=${token}`;

test("the token in the URL is traded for an HttpOnly, SameSite=Strict cookie, and the URL loses it", () => {
  // (a browser never sends the #fragment, and keeps it across the redirect: a link to #/playground lands there)
  const v = guard({ method: "GET", url: `/x?a=1&token=${token}`, host: "127.0.0.1:4039" }, port, token);
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.status === 303);
  if (!v.ok && v.status === 303) {
    assert.equal(v.location, "/x?a=1");
    assert.match(v.setCookie, /^mason_dev_4039=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
  }
  assert.equal(setCookieHeader("x", 4039), "mason_dev_4039=x; HttpOnly; SameSite=Strict; Path=/");
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
  if (!one.ok && one.status === 303 && !two.ok && two.status === 303) assert.notEqual(one.setCookie.split("=")[0], two.setCookie.split("=")[0], "each run sets a cookie of its own name");
});
