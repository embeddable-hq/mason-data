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

test("strictWrap: every line within the width, a long word broken within, every continuation at column 4 or deeper", async () => {
  const { strictWrap, CONTINUATION } = await import("../src/cli/command.ts");
  const width = 40;
  const cases = ["a".repeat(200), `x ${"b".repeat(90)} y`, "Next: mason destroy clean up", "ü".repeat(50), "short"];
  for (const [i, text] of cases.entries()) {
    for (const [indent, first] of [[2, 15], [8, 8], [5, 5], [0, 0]]) {
      const lines = strictWrap(text, width, indent!, first!).split("\n");
      const cols = (l: string): number => [...l].reduce((n, ch) => n + (ch.codePointAt(0)! <= 0x7e ? 1 : 2), 0);
      assert.ok(cols(lines[0]!) + first! <= width - 1 || cols(lines[0]!) <= 2, `case ${i}: the first line fits`);
      for (const l of lines.slice(1)) {
        assert.ok(cols(l) <= width - 1, `case ${i}: ${JSON.stringify(l)} fits`);
        assert.match(l, new RegExp(`^ {${Math.max(indent!, CONTINUATION)}}\\S`), `case ${i}: a continuation at ${Math.max(indent!, CONTINUATION)}`);
      }
      assert.equal(lines.join("").replace(/ /g, ""), text.replace(/ /g, ""), `case ${i}: nothing lost`);
    }
  }
});

test("strictWrap and strictLines at every width from 1 to 200: no line reaches the edge, every continuation at continuationAt(width), nothing lost", async () => {
  const { strictWrap, strictLines, continuationAt } = await import("../src/cli/command.ts");
  const cols = (l: string): number => [...l.replace(/\x1b\[[0-9;]*m/g, "")].reduce((n, ch) => n + (ch.codePointAt(0)! <= 0x7e ? 1 : 2), 0);
  const texts = ["a".repeat(300), `Next: mason destroy clean up, then sign in again ${"b".repeat(90)} y`, "ü漢".repeat(40), "x", "  mason logout                                  sign this machine out of http://127.0.0.1:45678",
    "✗ mason login: " + "m".repeat(70) + " Next: mason destroy", "\x1b[1mSigned in to http://127.0.0.1:1 as someone\x1b[22m"];
  // a line takes at most width - 1 columns; one that holds a single character may take the width itself (a terminal
  // draws a line exactly its width without breaking it), and at one column a wide character is all there is
  for (let width = 1; width <= 200; width++) {
    const limit = Math.max(1, width - 1), cont = continuationAt(width);
    const fits = (l: string): boolean => cols(l) <= limit || ([...l.trim()].length === 1 && (cols(l) <= width || width === 1));
    for (const [i, text] of texts.entries()) {
      // the last pass, over a whole line the CLI wrote
      const lines = strictLines(text, width).split("\n");
      for (const [n, l] of lines.entries()) {
        assert.ok(fits(l), `${width} columns, text ${i}, line ${n}: ${JSON.stringify(l)} takes ${cols(l)}`);
        if (n > 0) assert.ok(l.startsWith(" ".repeat(cont)) && (cont === 0 || l[cont] !== " "), `${width} columns, text ${i}: a continuation at ${cont}: ${JSON.stringify(l)}`);
      }
      assert.equal(lines.join("").replace(/\s/g, ""), text.replace(/\s/g, ""), `${width} columns, text ${i}: nothing lost`);
      // a value after a prefix, at an indent wider than the terminal too
      for (const [indent, first] of [[2, 15], [8, 8], [50, 48], [0, 0]] as const) {
        const w = strictWrap(text.replace(/\x1b\[[0-9;]*m/g, ""), width, indent, first).split("\n");
        for (const [n, l] of w.entries()) {
          if (n === 0) assert.ok(l === "" || cols(l) + first <= limit || [...l].length === 1, `${width} columns, text ${i}: the first line fits after its prefix: ${JSON.stringify(l)}`);
          else {
            assert.ok(fits(l), `${width}, ${indent}: ${JSON.stringify(l)} fits`);
            const lead = l.length - l.trimStart().length;
            assert.ok(lead === Math.max(indent, 4) || lead === cont, `${width}, ${indent}: at its own column or the continuation's: ${JSON.stringify(l)}`);
            assert.ok(lead + 1 <= limit || limit === 1, `${width}, ${indent}: an indent that leaves a column: ${JSON.stringify(l)}`);
          }
        }
      }
    }
  }
});
