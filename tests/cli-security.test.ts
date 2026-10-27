/**
 * `mason start`'s local pages' guard (src/cli/security.ts): every refusal a request from another site, a
 * DNS-rebinding page or a stale tab meets, and the one way in — the run's token, traded for a cookie.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { cookieOf, guard, newToken, sameSecret, setCookieHeader, SECURITY_HEADERS } from "../src/cli/security.ts";

const token = newToken();
const port = 4039;
const cookie = `other=1; mason_dev=${token}`;

test("the token in the URL is traded for an HttpOnly, SameSite=Strict cookie, and the URL loses it", () => {
  // (a browser never sends the #fragment, and keeps it across the redirect: a link to #/playground lands there)
  const v = guard({ method: "GET", url: `/x?a=1&token=${token}`, host: "127.0.0.1:4039" }, port, token);
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.status === 303);
  if (!v.ok && v.status === 303) {
    assert.equal(v.location, "/x?a=1");
    assert.match(v.setCookie, /^mason_dev=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
  }
  assert.equal(setCookieHeader("x"), "mason_dev=x; HttpOnly; SameSite=Strict; Path=/");
});

test("a request with the run's cookie is served; without it, or with another run's, refused", () => {
  assert.deepEqual(guard({ method: "GET", url: "/api/state", host: "127.0.0.1:4039", cookie }, port, token), { ok: true });
  assert.deepEqual(guard({ method: "GET", url: "/api/state", host: "localhost:4039", cookie }, port, token), { ok: true });
  for (const c of [undefined, "mason_dev=", `mason_dev=${newToken()}`]) {
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
  assert.equal(cookieOf("a=1; mason_dev=abc; b=2"), "abc");
  assert.equal(cookieOf("mason_devx=abc"), null);
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
  assert.equal((guard({ ...req, authorization: "Basic abc", cookie: `mason_dev=${token}`, origin: `http://127.0.0.1:${port}` }, port, token) as { status: number }).status, 403,
    "a header that is not the token is refused, whatever else the request carries");
  assert.equal((guard({ ...req, host: "evil.example", authorization: `Bearer ${token}` }, port, token) as { status: number }).status, 421, "the Host is checked first");
});
