/**
 * The pure pieces of a hosted service's client (src/cli/hosted.ts, src/cli/credentials.ts): which base URLs are taken,
 * what of the service's text may be printed, and which credentials files are read. The commands themselves, run as
 * processes against a fake service, are tests/cli-login.test.ts's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeOfStatus, DEFAULT_SERVICE_URL, deviceName, serviceOf, serviceText, urlProblem } from "../src/cli/hosted.ts";
import { credentialsPath, environmentToken, parseLogins } from "../src/cli/credentials.ts";

test("serviceOf: the default when MASON_CLOUD_URL is unset; its origin when it is an address alone; else refused", () => {
  assert.deepEqual(serviceOf({}), { base: "https://app.masondata.ai" });
  assert.equal(DEFAULT_SERVICE_URL, "https://app.masondata.ai");
  assert.deepEqual(serviceOf({ MASON_CLOUD_URL: "https://Example.COM:443/" }), { base: "https://example.com" });
  assert.deepEqual(serviceOf({ MASON_CLOUD_URL: "http://localhost:8080" }), { base: "http://localhost:8080" });
  assert.deepEqual(serviceOf({ MASON_CLOUD_URL: "http://[::1]:8080" }), { base: "http://[::1]:8080" });
  for (const bad of ["http://10.0.0.1", "http://127.0.0.1.example.com", "https://x/y", "https://x?y", "https://u@x", "file:///etc/passwd", "javascript:alert(1)", " ", "x"]) {
    const r = serviceOf({ MASON_CLOUD_URL: bad });
    assert.ok("code" in r && r.code === "refused", `${bad}: ${JSON.stringify(r)}`);
  }
  assert.equal(urlProblem(new URL("https://a.example")), null);
});

test("serviceText: one line, every line break, control, format and bidi character replaced, bounded, secrets and documented token shapes masked", () => {
  assert.equal(serviceText("a\u001b[2Jb\u202ec\u0007d\ne", 100), "a?[2Jb?c?d?e");
  // one line: no break of any kind survives, nor a zero-width or directional mark
  assert.equal(serviceText("1\n2\r3\u000b4\u000c5\u00856\u20287\u20298\t9\u200b0\u200e1\u061c2\u20663\ufeff4", 100), "1?2?3?4?5?6?7?8?9?0?1?2?3?4");
  assert.equal(serviceText("abcdef", 3), "abc…");
  const t = `masondata_pat_${"x".repeat(43)}`;
  assert.equal(serviceText(`token ${t}!`, 200), "token masondata_pat_****!");
  assert.equal(serviceText("opaque-secret-1 and more", 200, ["opaque-secret-1"]), "**** and more");
  assert.equal(serviceText("masondata_ci_short", 200), "masondata_ci_short", "only the documented shape is a token");
});

test("parseLogins: the documented shape, or why not, never quoting the text", () => {
  assert.deepEqual(parseLogins('{"version":1,"logins":{}}'), { version: 1, logins: {} });
  const secret = "SECRET-IN-FILE";
  for (const text of [`{"token":"${secret}"`, `[1]`, `{"version":2,"logins":{}}`, `{"version":1}`, `{"version":1,"logins":{"https://x":{"token":"${secret}"}}}`]) {
    const r = parseLogins(text);
    assert.equal(typeof r, "string", text);
    assert.ok(!(r as string).includes(secret), r as string);
  }
});

test("credentialsPath: XDG_CONFIG_HOME when absolute, else ~/.config; MASON_TOKEN read, an empty one unset", () => {
  assert.equal(credentialsPath({ XDG_CONFIG_HOME: "/x/cfg" }).file, "/x/cfg/mason/credentials.json");
  assert.match(credentialsPath({ XDG_CONFIG_HOME: "relative" }).file, /\/\.config\/mason\/credentials\.json$/);
  assert.equal(environmentToken({ MASON_TOKEN: "t" }), "t");
  assert.equal(environmentToken({ MASON_TOKEN: "" }), null);
  assert.equal(environmentToken({}), null);
});

test("deviceName: the hostname as printable ASCII, at most 64 characters, never empty", () => {
  assert.equal(deviceName("ada-laptop.local"), "ada-laptop.local");
  assert.equal(deviceName("café\u001b[2J\nx"), "caf--[2J-x");
  assert.equal(deviceName("a".repeat(100)).length, 64);
  assert.equal(deviceName(""), "unknown");
  assert.equal(deviceName("\u0000\u0007"), "--");
  assert.match(deviceName(), /^[\x20-\x7e]{1,64}$/, "this machine's");
});

test("codeOfStatus: the CLI's own code for a service's failure, by its HTTP status, never usage or timeout", () => {
  assert.deepEqual([400, 401, 403, 404, 408, 409, 413, 415, 422, 429, 499, 500, 502, 503, 504].map(codeOfStatus),
    ["refused", "refused", "refused", "not_found", "refused", "refused", "refused", "refused", "refused", "refused", "refused", "failed", "failed", "failed", "failed"]);
});
