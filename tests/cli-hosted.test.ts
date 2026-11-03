/**
 * The pure pieces of a hosted service's client (src/cli/hosted.ts, src/cli/credentials.ts): which base URLs are taken,
 * what of the service's text may be printed, and which credentials files are read. The commands themselves, run as
 * processes against a fake service, are tests/cli-login.test.ts's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { punyLabels } from "./hosted-fake.ts";
import { carriesNoSecret, codeOfStatus, echoesSecret, DEFAULT_SERVICE_URL, deviceName, deviceOf, ECHO_RUN, isFailure, MAX_ANSWER_DEPTH, meOf, oauthFailure, serviceOf, serviceText, urlProblem, type Answer } from "../src/cli/hosted.ts";
import { deployStateOf } from "../src/cli/deploy.ts";
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

// ------------------------------------------------------------------ a grammar is no mask (issue 627)

/**
 * A TOKEN WHOSE BODY HOLDS A RUN EVERY GRAMMAR TAKES: 11 lower case letters (an OAuth error's grammar), 11 digits (a
 * time's fraction), then base64url of every kind. Written in parts, so no line of this file is shaped as a token.
 */
const LETTERS = "qzvwxkpjrtm", DIGITS = "40718293651";
const BODY = `${LETTERS}${DIGITS}Hb1Ns5Gc0Fd-Ue_YoZi7K`;
const TOKEN = ["masondata", "ci", BODY].join("_");
const SERVICE = { base: "https://svc.example" };
const AT = "2026-11-02T10:00:00Z";
const answer = (status: number, json: unknown, what = "POST /x"): Answer => ({ status, json, what, retryAfter: null });

/**
 * EVERY VALUE A HOSTED COMMAND PRINTS THAT A GRAMMAR ALONE HELD ON main (src/cli/deploy.ts's table, src/cli/hosted.ts's
 * readers), and every other string of the same answers: `answer(v)` puts `v` in the field, in a place its grammar may
 * take it; `read` is null for an answer refused; `run` is which run of 11 of the body the grammar can take.
 */
type Field = [what: string, answer: (v: string) => unknown, read: (j: unknown, secrets: string[]) => unknown, plain: string, run: "letters" | "digits"];
const deployRead = (id: string | null) => (j: unknown, x: string[]): unknown => deployStateOf(j, id, x, []);
const deviceRead = (j: unknown, x: string[]): unknown => { const d = deviceOf(SERVICE, answer(200, j), x); return isFailure(d) ? null : d; };
const meRead = (j: unknown, x: string[]): unknown => { const m = meOf(SERVICE, answer(200, j, "GET /v1/me"), x); return isFailure(m) ? null : m; };
const oauthRead = (j: unknown, x: string[]): unknown => /refused this sign-in/.test(oauthFailure(SERVICE, answer(400, j), "a sign-in was asked for", x).message) ? j : null;
const state = (more: Record<string, unknown>, id = "dep_01abc"): unknown => ({ deploy: { id, status: "queued", createdAt: AT, ...more } });
const device = (more: Record<string, unknown>): unknown => ({ device_code: "dev-code-1", user_code: "WDJBMJHT", verification_uri: `${SERVICE.base}/device`, expires_in: 60, interval: 1, ...more });
const me = (more: Record<string, unknown> = {}, org: Record<string, unknown> = {}): unknown => ({ email: "ada@example.com", name: "Ada", orgs: [{ slug: "acme", name: "Acme Inc", role: "owner", ...org }], ...more });
const FIELDS: Field[] = [
  ["deploy: the POST's id", (v) => state({}, v), deployRead(null), "dep_01abc", "letters"],
  ["deploy: a status", (v) => state({ status: v }), deployRead(null), "queued", "letters"],
  ["deploy: a phase", (v) => state({ status: "applying", phase: v }), deployRead(null), "checking", "letters"],
  ["deploy: createdAt", (v) => state({ createdAt: `2026-11-02T10:00:00.${v}Z` }), deployRead(null), "5", "digits"],
  ["deploy: finishedAt", (v) => state({ status: "running", finishedAt: `2026-11-02T10:01:00.${v}Z` }), deployRead("dep_01abc"), "5", "digits"],
  ["deploy: a refusal's code", (v) => state({ status: "refused", finishedAt: AT, failure: { code: v, message: "refused" } }), deployRead("dep_01abc"), "bad_source", "letters"],
  ["deploy: a key outside the shape", (v) => ({ ...(state({}) as object), note: v }), deployRead(null), "a note", "letters"],
  ["deploy: a key named by it", (v) => state({ [v]: 1 }), deployRead(null), "note", "letters"],
  ["login: the device code", (v) => device({ device_code: v }), deviceRead, "dev-code-1", "letters"],
  ["login: the user code", (v) => device({ user_code: v }), deviceRead, "WDJBMJHT", "letters"],
  ["login: the sign-in page", (v) => device({ verification_uri: `${SERVICE.base}/device?c=${v}` }), deviceRead, "x", "letters"],
  ["login: the page with its code", (v) => device({ verification_uri_complete: `${SERVICE.base}/device?c=${v}` }), deviceRead, "x", "letters"],
  // a number in its grammar, as a number; any other form as the string it is
  ["login: expires_in", (v) => device({ expires_in: /^\d+$/.test(v) ? Number(v) : v }), deviceRead, "60", "digits"],
  ["login: interval", (v) => device({ interval: /^\d+$/.test(v) ? Number(v) : v }), deviceRead, "5", "digits"],
  ["login: a key outside the device code's shape", (v) => device({ note: v }), deviceRead, "a note", "letters"],
  ["login: an OAuth refusal's code", (v) => ({ error: v }), oauthRead, "invalid_request", "letters"],
  ["login: who signed in, the email", (v) => me({ email: `${v}@example.com` }), meRead, "ada", "letters"],
  ["login: who signed in, the name", (v) => me({ name: v }), meRead, "Ada", "letters"],
  ["login: an organisation's slug", (v) => me({}, { slug: v }), meRead, "acme", "letters"],
  ["login: an organisation's name", (v) => me({}, { name: v }), meRead, "Acme Inc", "letters"],
  ["login: an organisation's role", (v) => me({}, { role: v }), meRead, "owner", "letters"],
  ["login: a key outside who signed in", (v) => me({ note: v }), meRead, "a note", "letters"],
];
/** The forms each field is given: the token whole, its body, its body in lower case, 11 of its characters in a row. */
const FORMS: Array<[what: string, value: (run: "letters" | "digits") => string]> = [
  ["the token whole", () => TOKEN], ["its body", () => BODY], ["its body in lower case", () => BODY.toLowerCase()],
  ["11 of its characters in a row", (run) => run === "letters" ? LETTERS : DIGITS],
];

test("every value a hosted command prints that a grammar alone held — deploy's id, status, phase, times and a refusal's code; login's device code, user code, pages, intervals, OAuth code and who signed in; a key outside each shape — given the token whole, its body, its body in lower case or 11 of its characters in a row, refuses the answer; the same field plain does not", () => {
  assert.equal(BODY.length, 43);
  assert.equal(ECHO_RUN, LETTERS.length);
  const problems: string[] = [];
  for (const [what, answerOf, read, plain, run] of FIELDS) {
    if (read(answerOf(plain), [TOKEN]) === null) problems.push(`${what}: the plain answer is refused`);
    for (const [form, value] of FORMS) {
      if (read(answerOf(value(run)), [TOKEN]) !== null) problems.push(`${what}, ${form}: taken`);
    }
    // the limit: 10 of the body in a row is no echo, taken wherever the grammar takes it
    const ten = (run === "letters" ? LETTERS : DIGITS).slice(0, 10);
    if (read(answerOf(ten), []) !== null && read(answerOf(ten), [TOKEN]) === null) problems.push(`${what}: 10 of the body refused`);
  }
  assert.deepEqual(problems, []);
  // the masks decide, never the grammar alone: where a grammar takes a form with no token held, the token refuses it
  const byToken = FIELDS.filter(([, answerOf, read, , run]) => read(answerOf(run === "letters" ? LETTERS : DIGITS), []) !== null).map(([what]) => what);
  for (const what of ["deploy: the POST's id", "deploy: createdAt", "deploy: finishedAt", "deploy: a refusal's code", "login: the device code", "login: the sign-in page",
    "login: an OAuth refusal's code", "login: who signed in, the name", "login: an organisation's role"]) assert.ok(byToken.includes(what), `${what}: its grammar takes 11 of the body`);
  // a deploy's failure words are free text, masked as every failure's, never a refusal of the deploy's state
  const refused = deployStateOf(state({ status: "refused", finishedAt: AT, failure: { code: "bad_source", message: `the token ${BODY} is not known` } }), "dep_01abc", [TOKEN], []);
  assert.ok(refused !== null && refused.failure !== null);
  assert.equal(refused.failure.message, "the token **** is not known");
});

/** Bytes from a fixed seed (SHA-256 in counter mode): the same answers and tokens at every run. */
function seeded(seed: string): (n: number) => Buffer {
  let counter = 0, pool = Buffer.alloc(0);
  return (n) => {
    while (pool.length < n) pool = Buffer.concat([pool, createHash("sha256").update(`${seed}:${counter++}`).digest()]);
    const out = pool.subarray(0, n); pool = pool.subarray(n); return out;
  };
}

test("an honest answer of deploy and login — every value high-entropy, random tokens from a fixed seed — is never refused, and reads as it came", () => {
  const bytes = seeded("mason-627-honest");
  const b64 = (n: number): string => bytes(Math.ceil(n * 3 / 4) + 1).toString("base64url").slice(0, n);
  const letters = (n: number): string => Array.from(bytes(n), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[b % 26]).join("");
  const time = (): string => `2026-11-02T10:${String(bytes(1)[0]! % 60).padStart(2, "0")}:00.${String(bytes(2).readUInt16BE()).padStart(5, "0")}Z`;
  const problems: string[] = [];
  for (let i = 0; i < 2000; i++) {
    const token = `masondata_ci_${bytes(32).toString("base64url")}`, saved = `masondata_pat_${bytes(32).toString("base64url")}`;
    const id = b64(64), code = letters(8);
    const states = [state({}, id), state({ status: "applying", phase: "checking", createdAt: time() }, id), state({ status: "running", createdAt: time(), finishedAt: time() }, id),
      state({ status: "failed", finishedAt: time(), failure: { code: "machine_lost", message: `deploy ${b64(20)} failed`, why: b64(40) } }, id)];
    for (const [n, s] of states.entries()) if (deployStateOf(s, n === 0 ? null : id, [token], []) === null) problems.push(`deploy state ${n}, token ${i}`);
    const d = device({ device_code: b64(43), user_code: code, verification_uri: `${SERVICE.base}/device`, verification_uri_complete: `${SERVICE.base}/device?user_code=${code}&s=${b64(32)}` });
    if (deviceRead(d, [saved]) === null) problems.push(`device code, token ${i}`);
    const who = me({ email: `${b64(20).toLowerCase()}@example.com`, name: b64(30) }, { slug: b64(24).toLowerCase(), name: b64(30), role: "owner" });
    if (meRead(who, [token, saved]) === null) problems.push(`who signed in, token ${i}`);
    if (!carriesNoSecret({ error: b64(30).toLowerCase().replace(/[^a-z]/g, "_") }, [saved])) problems.push(`an OAuth refusal, token ${i}`);
  }
  assert.deepEqual(problems, []);
});

// ------------------------------------------------------------------ what is printed is what is tested (PR 645's review)

test("a sign-in page is tested as the URL parser prints it: dot segments that join pieces of a held secret, in either page and either spelling, and a host whose xn-- form spells one, each refuse the device code's answer, nothing of it printed; an honest page is printed as before", () => {
  const pieces = BODY.match(/.{1,10}/g)!;
  const problems: string[] = [];
  for (const dots of ["..", "%2E%2E", "%2e%2e", ".%2E", null]) {
    // (null: the pieces as they would be printed, written so: the same page)
    const page = `${SERVICE.base}/device/${pieces.join(dots === null ? "/" : `/x/${dots}/`)}`;
    // the answer's own string holds no 11 of the body in a row (an `x` between each two pieces): the walk alone would take it
    if (dots !== null) assert.ok(carriesNoSecret({ page }, [TOKEN]), `${dots}: the raw page reads as no echo`);
    assert.ok(new URL(page).href.includes(pieces.join("/")), `${dots}: the parser joins the pieces`);
    for (const field of ["verification_uri", "verification_uri_complete"]) {
      if (deviceRead(device({ [field]: page }), [TOKEN]) !== null) problems.push(`${field}, ${dots}: taken`);
    }
  }
  const labels = punyLabels(BODY, 3);
  assert.ok(labels.length >= 2, `labels found: ${labels.length}`);
  for (const field of ["verification_uri", "verification_uri_complete"]) {
    const page = `https://${labels.join(".")}.example/device`;
    assert.ok(carriesNoSecret({ page }, [TOKEN]), "the raw host reads as no echo");
    const d = deviceOf(SERVICE, answer(200, device({ [field]: page })), [TOKEN]);
    if (!isFailure(d) || /another address/.test(d.message) || d.message.includes("xn--")) problems.push(`${field}, a punycode host: ${JSON.stringify(d)}`);
  }
  assert.deepEqual(problems, []);
  // honest: a page on the service's own origin as the parser writes it, and another address named
  const ok = deviceOf(SERVICE, answer(200, device({ verification_uri_complete: `${SERVICE.base}/device/./a/../?user_code=WDJBMJHT` })), [TOKEN]);
  assert.ok(!isFailure(ok) && ok.verificationUriComplete === `${SERVICE.base}/device/?user_code=WDJBMJHT`, JSON.stringify(ok));
  const elsewhere = deviceOf(SERVICE, answer(200, device({ verification_uri: "https://bücher.example/device" })), [TOKEN]);
  assert.ok(isFailure(elsewhere) && elsewhere.message === `${SERVICE.base} named a sign-in page on another address: https://xn--bcher-kva.example`, JSON.stringify(elsewhere));
  // a page that holds no run of 11, but pieces the held secret's mask would take (two of 10, an x between): refused too,
  // never printed masked nor whole
  const split = `${SERVICE.base}/device/${pieces[0]}x${pieces[1]}`;
  assert.ok(carriesNoSecret({ split }, [TOKEN]));
  assert.equal(deviceRead(device({ verification_uri: split }), [TOKEN]), null);
  // free text as serviceText prints it: no form of the token, split by what it makes one line, leaves it an echo
  const echoed: string[] = [];
  for (const [form, value] of FORMS) {
    for (const v of [value("letters"), value("digits"), `${value("letters")}\n${value("digits")}`, pieces.join("\u0000"), pieces.join("\u202e  ")]) {
      const line = serviceText(`said: ${v}`, 2000, [TOKEN], new Map());
      if (echoesSecret(line, [TOKEN])) echoed.push(`serviceText, ${form}: ${line}`);
    }
  }
  assert.deepEqual(echoed, []);
});

test("an answer nested deeper than any documented shape is refused, never a crash: the walk keeps its own stack, at 31 deep it reads, past MAX_ANSWER_DEPTH it refuses, and 500,000 deep (1 MiB) it refuses at once", () => {
  const nest = (n: number): string => "[".repeat(n) + "]".repeat(n);
  assert.equal(MAX_ANSWER_DEPTH, 32);
  assert.equal(carriesNoSecret(JSON.parse(`{"x":${nest(MAX_ANSWER_DEPTH - 1)}}`), [TOKEN]), true);
  assert.equal(carriesNoSecret(JSON.parse(`{"x":${nest(MAX_ANSWER_DEPTH)}}`), [TOKEN]), false);
  assert.equal(carriesNoSecret(JSON.parse(`{"x":${nest(500_000)}}`), [TOKEN]), false);
  assert.equal(carriesNoSecret(JSON.parse(nest(500_000)), []), false, "with no secret held too: a depth is no echo, it is outside the contract");
  // objects as deep: the same
  const deepObject = `${'{"a":'.repeat(40_000)}1${"}".repeat(40_000)}`;
  assert.equal(carriesNoSecret(JSON.parse(deepObject), [TOKEN]), false);
  // each reader: outside the contract, said by its status
  const deep = JSON.parse(`{"x":${nest(32_000)}}`) as Record<string, unknown>;
  assert.equal(deployStateOf({ ...(state({}) as object), ...deep }, null, [TOKEN], []), null);
  assert.ok(isFailure(deviceOf(SERVICE, answer(200, { ...(device({}) as object), ...deep }), [TOKEN])));
  assert.ok(isFailure(meOf(SERVICE, answer(200, { ...(me() as object), ...deep }, "GET /v1/me"), [TOKEN])));
});
