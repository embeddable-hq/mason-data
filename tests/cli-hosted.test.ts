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

test("serviceText: a secret the command holds is masked by its value — without its prefix, split, re-cased, URL-encoded, in full-width or accented letters, or in runs that together show more than a quarter of it; ordinary words never", () => {
  // a body of every kind of base64url character, a dash and an underscore among them
  const body = "Ab3-dE_fG7hIjK9lMnOpQ2rStUvWx8yZaBcDeFgHiJk", token = `masondata_ci_${body}`;
  assert.equal(body.length, 43);
  // each value read as the first a process prints, unless a record is given: what was shown before counts (`shown`)
  const held = (s: string, max = 2000, shown = new Map<string, Set<number>>()): string => serviceText(s, max, [token], shown);
  const pieces = (n: number): string[] => body.match(new RegExp(`.{1,${n}}`, "g"))!;
  const cases: Array<[string, string]> = [
    [`try ${body} again`, "the body without its prefix"],
    [`try ${pieces(4).join(" ")} again`, "split by spaces"],
    [`try ${body.toUpperCase()} again`, "in upper case"],
    [`try ${body.toLowerCase().match(/.{1,5}/g)!.join("-")} again`, "split by dashes"],
    [`try ${pieces(3).join("\n\u200b")} again`, "split by line breaks and zero-width marks"],
    [`try ${[...body].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")} again`, "every character URL-encoded"],
    [`try ${[...body].map((c) => /[A-Za-z0-9]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c).join("")} again`, "in full-width letters"],
    // one reading for both spellings of an accented letter: precomposed, and a letter and its combining mark
    [`try ${[...body].map((c) => `${c}\u0301`.normalize("NFC")).join("")} again`, "accented, precomposed where Unicode has the letter"],
    [`try ${[...body].map((c) => `${c}\u0301`).join("")} again`, "accented by a combining mark"],
    [`try ${body.slice(4, 16)} again`, "a 12-character slice"],
    [`try ${body.slice(20, 31)} again`, "an 11-character slice: more than a quarter"],
    [`try ${body.slice(19, 25)}, ${body.slice(25, 31)} again`, "a 12-character slice in two halves"],
  ];
  for (const [text, what] of cases) assert.equal(held(text), "try **** again", what);
  // runs shorter than the bound, with something between them, are counted together (the review of PR 591)
  assert.equal(held(`the token ${pieces(11).join(" x ")} is not known`), "the token **** x **** x **** x **** is not known", "11 at a time, a letter between");
  assert.equal(held(`try ${pieces(4).join("\u001b[31m")}`), `try ${"****?[31m".repeat(10)}iJk`, "4 at a time, a colour code between (the last 3 no run)");
  assert.equal(held(`try ${pieces(5).join("0")}`), `try ${"****0".repeat(8)}iJk`, "5 at a time, a digit between (the last 3 no run)");
  // and across the values one process prints: a quarter of it in one, then any run of it in the next is masked
  const shown = new Map<string, Set<number>>();
  assert.equal(held(`message ${body.slice(20, 28)}`, 2000, shown), `message ${body.slice(20, 28)}`);
  assert.equal(held(`why ${body.slice(28, 36)}`, 2000, shown), "why ****");
  assert.equal(held(`fix ${body.slice(20, 24)}`, 2000, shown), `fix ${body.slice(20, 24)}`, "what was shown before, shown again, shows nothing new");
  assert.equal(held(`again ${body.slice(20, 28)} ${body.slice(36, 40)}`, 2000, shown), "again ****", "runs side by side are one mask");
  // a quarter of it, 10 characters, is shown; a run of 3 or fewer is no echo, and is never one
  assert.equal(held(`try ${body.slice(20, 30)} again`), `try ${body.slice(20, 30)} again`);
  assert.equal(held(`try ${pieces(3).join(" x ")}`), `try ${pieces(3).join(" x ")}`);
  assert.equal(held(`the token ${token} is unknown`), "the token **** is unknown", "the token whole, as before");
  // the prefix is a documented, public form, and stays: what follows it is masked
  assert.equal(held(`try ${token.replaceAll("_", "%5F")} again`), "try masondata%5Fci%5F**** again", "the token URL-encoded, its prefix too");
  assert.equal(held("sign in with masondata_ci_ tokens"), "sign in with masondata_ci_ tokens");
  // a mask joins what lay either side of it, which is read again: pieces of 2, which only a mask makes runs, nested
  // around the token three times over; read five times, a value still holding a run to mask is masked whole (fail closed)
  const nested = (depth: number): string => [0, 1, 2].map((c) => {
    let s = token;
    for (let i = 0; i < depth; i++) { const p = 13 * c + 3 * i; s = `${body.slice(p, p + 2)}.${s}.${body.slice(p + 2, p + 4)}`; }
    return s;
  }).join(" / ");
  assert.equal(held(`try ${nested(4)} again`), "try **** again");
  assert.equal(held(`try ${nested(5)} again`), "****");
  // a `-` or `_` the body begins or ends with goes with it, though the dashes that split it are skipped
  const other = "k2Pq7Rs1Tu8Vw3Xy9Za4Bc0De5Fg6HiYJmUNo2Lq3Mr";
  assert.equal(serviceText(`try _${other.toLowerCase().match(/.{1,5}/g)!.join("-")}- again`, 2000, [`masondata_ci__${other}-`], new Map()), "try **** again");
  // the mask reads the value as it came: the bound cannot cut a body into a part shown
  assert.equal(held(`${"x ".repeat(5)}${body}`, 20), "x x x x x ****");
  // ordinary words, an address and a URL are left as they are
  const prose = "ada@example.com cannot deploy acme/shop: the token was revoked at https://example.com/settings/tokens?page=2%20x";
  assert.equal(held(prose), prose);
  // a secret of another form, too short to show a quarter of, is masked at any run: fail closed
  assert.equal(serviceText("a key of x/Ab9Z, or AB 9z, here", 200, ["ab9z"], new Map()), "a key of x/****, or ****, here");
  // a token the command does not hold is still masked by its shape
  assert.equal(held(`also masondata_pat_${"y".repeat(43)}`), "also masondata_pat_****");
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

test("serviceText: a Mason user's password is masked whatever precedes it and in any case; split, encoded or without its prefix it has no shape, the limit of a shape mask", () => {
  const pw = `mason_0123456789abcdef_${"a1b2".repeat(8)}`;
  const t = (s: string): string => serviceText(s, 2000, [], new Map());
  for (const s of [`the password is ${pw}`, `user_${pw}`, `x${pw}`, `1${pw}`, pw.toUpperCase(), `mason_${pw.slice(6).toUpperCase()}`, `postgres://u:${pw}@h:1/db`]) {
    assert.ok(!t(s).toLowerCase().includes(pw), `${s} → ${t(s)}`);
    assert.match(t(s), /mason_\*\*\*\*/i, s);
  }
  // the limit, as docs/HOSTED-API.md says it: no shape to match
  for (const s of [pw.replace(/_/g, " "), pw.slice("mason_".length), pw.replace(/_/g, "%5F")]) assert.equal(t(s), s.replace(/\s+/g, " "), s);
});
