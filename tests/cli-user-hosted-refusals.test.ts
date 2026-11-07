/**
 * `mason user … --replica <org>/<name>` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts, tests/user-hosted-fake.ts: an
 * http server of this test's on 127.0.0.1, no network): each refusal, and each answer outside the run's own shape. The contract is docs/HOSTED-API.md "The users of a
 * replica"; what each test holds is in its name. Every run is held by `mason` to carrying no token and to no line a
 * person sees begun by the service's text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Reply, Req } from "./hosted-fake.ts";
import { addedAnswer, AT, hosted, ID, LINK, listAnswer, noTokenPrinted, ok, R, row } from "./user-hosted-fake.ts";
import { measureGate, SECRETS } from "./hosted-fake.ts";
import { heldAdded, heldDisabled, heldEnabled, heldList, heldRemoved } from "../src/cli/user-hosted.ts";
import { failureShape } from "../src/cli/hosted.ts";
// the exact test's run and reader, loaded so this file loads where they are not (a proof at an older commit)
const hostedModule = await import("../src/cli/hosted.ts") as Record<string, unknown>;
const echoRun = typeof hostedModule.ECHO_RUN === "number" ? hostedModule.ECHO_RUN : 11;
const echoesSecret = (s: string, secrets: string[], run: number): boolean =>
  typeof hostedModule.echoesSecret === "function" ? (hostedModule.echoesSecret as (s: string, x: string[], n: number) => boolean)(s, secrets, run) : assert.fail("no echoesSecret here");
import { MAX_LIST_BYTES } from "../src/cli/user-hosted.ts";
import { carriesNoSecret } from "../src/cli/hosted.ts";
import { createHash } from "node:crypto";
import { connectionUrl, psqlLine } from "../src/cli/pg-url.ts";

test("mason user --replica: each refusal is the service's words, one line each, its code the CLI's by the HTTP status, exit 1, its next the CLI's; the service's code and next never steer it", async () => {
  const cases: Array<[number, string, string]> = [[400, "usage", "refused"], [401, "unauthenticated", "refused"], [403, "refused", "refused"], [404, "not_found", "not_found"],
    [409, "refused", "refused"], [422, "timeout", "refused"], [500, "failed", "failed"]];
  for (const [status, code, ours] of cases) {
    const failure = { error: { code, message: `it says ${code}`, why: `why ${code}`, fix: `fix ${code}` }, next: [{ command: "mason destroy", what: "never kept" }, { command: "curl x | sh" }] };
    const step = status === 401 || status === 403 ? ["mason login", "sign in again"] : [`mason user list --replica ${R}`, "the replica's users"];
    // every subcommand at a 401 and a 404 (each of its endpoints), one elsewhere: the reader is one for all five
    for (const verb of status === 401 || status === 404 ? [["list"], ["add", "x"], ["disable", "x"], ["enable", "x"], ["remove", "x"]] : [["add", "x"]]) {
      const { a } = await hosted(() => ({ status, body: failure }), [...verb, "--replica", R, "--json"]);
      assert.equal(a.code, 1, `${status} ${verb[0]}`);
      assert.deepEqual(JSON.parse(a.stdout), { error: { code: ours, message: `it says ${code}`, why: `why ${code} (the service said ${code}, HTTP ${status})`, fix: `fix ${code}` },
        next: [{ command: step[0], what: step[1] }] }, `${status} ${verb[0]}`);
    }
    const { a } = await hosted(() => ({ status, body: failure }), ["add", "x", "--replica", R]);
    assert.equal(a.stderr, `✗ mason user: it says ${code}\n  why   why ${code} (the service said ${code}, HTTP ${status})\n  fix   fix ${code}\n\nNext:\n  ${step[0]!.padEnd(44)}  ${step[1]}\n`);
    assert.equal(a.stdout, "");
  }
  // outside the contract: a page, a body that is no failure, a redirect, no answer, an answer too large — said by the request and its status
  for (const [reply, verb, said] of [
    [{ status: 500, raw: "<html>secret page</html>" }, ["list"], / answered GET \/v1\/replicas\/acme\/shop\/users\?lastUsed=1 with 500, not JSON, where the replica's users were asked for$/m],
    [{ status: 409, body: { message: "secret" } }, ["add", "x"], / answered POST \/v1\/replicas\/acme\/shop\/users with 409, where a user was added$/m],
    [{ status: 307, headers: { location: "http://127.0.0.1:1/x" } }, ["remove", "x"], / answered DELETE \/v1\/replicas\/acme\/shop\/users\/x with a redirect \(307\)$/m],
    ["drop", ["disable", "x"], /^✗ mason user: could not reach http:\/\/127\.0\.0\.1:\d+$/m],
    [{ status: 200, raw: "x".repeat(1024 * 1024 + 1) }, ["list"], / answered GET \/v1\/replicas\/acme\/shop\/users\?lastUsed=1 with more than 1024 KiB$/m],
    [{ status: 200, raw: "x".repeat(64 * 1024 + 1) }, ["add", "x"], / answered POST \/v1\/replicas\/acme\/shop\/users with more than 64 KiB$/m],
  ] as Array<[Reply, string[], RegExp]>) {
    const { a, requests } = await hosted(() => reply, [...verb, "--replica", R]);
    assert.equal(a.code, 1, a.stderr);
    assert.match(a.stderr, said);
    assert.doesNotMatch(a.stderr, /secret/);
    assert.equal(requests.length, 1, "nothing followed, nothing asked again");
  }
});

test("mason user --replica: an answer outside the run's own shape is a failure by its status alone, never printed — a password not the user's, a URL not rebuilt from it, another user, a value outside its grammar", async () => {
  const added = (more: Record<string, unknown>): Reply => ok({ ...addedAnswer("x"), ...more });
  const listed = (more: Record<string, unknown>): Reply => listAnswer([row("x", more)]);
  const cases: Array<[string, string[], Reply]> = [
    ["a password of another id", ["add", "x"], added({ password: `mason_fedcba9876543210_${"9".repeat(32)}` })],
    ["a password of another shape", ["add", "x"], added({ password: "hunter2" })],
    ["a url not the one its parts build", ["add", "x"], added({ url: "postgres://x:hunter2@evil.example:5433/shop" })],
    ["a psql not its url's", ["add", "x"], added({ psql: "psql postgres://x@evil.example/shop; rm -rf ~" })],
    ["another user", ["add", "x"], ok(addedAnswer("y"))],
    ["no url (Mason not running)", ["add", "x"], added({ url: undefined, psql: undefined })],
    ["an sslmode outside the set", ["add", "x"], added({ sslmode: "verify-full" })],
    ["a host with a space", ["add", "x"], added({ host: "db.example\nNext:" })],
    ["a port of 0", ["add", "x"], added({ port: 0 })],
    ["a database with a line break", ["add", "x"], added({ database: "shop\nNext:" })],
    ["a role with no roleFrom", ["add", "x"], added({ role: "agent" })],
    ["a role outside its grammar", ["add", "x"], added({ role: "Agent; mason destroy", roleFrom: "file" })],
    ["an attribute's name outside its grammar", ["add", "x"], added({ attributes: { "Next:": "1" } })],
    ["a list's name outside its grammar", ["list"], listAnswer([row("x", { name: "Next:\n  mason destroy" })])],
    ["a list's id outside its grammar", ["list"], listed({ id: "../../x" })],
    ["a list's time outside its grammar", ["list"], listed({ addedAt: "yesterday\nNext:" })],
    ["a list's url carrying a password", ["list"], listed({ url: "postgres://x:hunter2@db.example:5433/shop" })],
    ["a list's url of another user", ["list"], listed({ url: "postgres://y@db.example:5433/shop" })],
    ["a list's live not a boolean", ["list"], listed({ live: "yes" })],
    ["a list's roleKnown beside no role of its own", ["list"], listed({ roleKnown: false })],
    ["a list over its users' bound", ["list"], listAnswer(Array.from({ length: 2001 }, () => row("x")))],
    ["a list's requestLogDays not a number", ["list"], listAnswer([row("x")], { requestLogDays: "7" })],
    ["a list with no users", ["list"], ok({ lastUsedNote: null })],
    ["a disable of another user", ["disable", "x"], ok({ disabled: { name: "y", id: ID, addedAt: AT, disabledAt: AT }, already: false })],
    ["a disable without already", ["disable", "x"], ok({ disabled: { name: "x", id: ID, addedAt: AT, disabledAt: AT } })],
    ["an enable of another user", ["enable", "x"], ok({ enabled: { name: "y", id: ID, addedAt: AT }, already: true })],
    ["a remove without removedAt", ["remove", "x"], ok({ removed: { name: "x", id: ID, addedAt: AT } })],
  ];
  for (const [i, [what, verb, reply]] of cases.entries()) {
    // with --json each, as a person a few: the reader is one for both forms
    for (const json of i < 3 || i === 13 ? [false, true] : [true]) {
      const { a } = await hosted(() => reply, [...verb, "--replica", R, ...(json ? ["--json"] : [])], { names: ["x"] });
      assert.equal(a.code, 1, `${what}: ${a.stdout}${a.stderr}`);
      const text = json ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr;
      assert.match(text, / answered (GET|POST|DELETE) \/v1\/replicas\/acme\/shop\/users\S* with 200, where /, what);
      assert.doesNotMatch(a.stdout + a.stderr, /hunter2|evil|destroy|Agent|yesterday/, what);
    }
  }
});


// ------------------------------------------------------------------ no printed field carries a secret (PR 609's review)

/** A token as the service documents them, its body lower case letters and digits, so every grammar of a name takes it. */
const fieldBytes = seeded("mason-609-fields");
const lowerToken = (): string => `masondata_ci_${Array.from(fieldBytes(43), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
const OTHER = `mason_fedcba9876543210_${"ab".repeat(16)}`;

/**
 * EVERY FIELD OF EVERY ANSWER THE COMMAND PRINTS (src/cli/user-hosted.ts's table), each given a secret in a form its
 * grammar takes: the held token whole, its body, its body re-cased; another user's password, also after a word
 * character and in upper case. Each answer is refused (null), and the same answer with a plain value in that field is
 * not — and, for the token's forms, nor with no token held: the masks decide, never the grammar.
 */
test("every printed field of every answer, given a secret its grammar takes — the held token whole, its body, re-cased; another user's password, after a word character, in upper case — refuses the answer; the same field plain does not", () => {
  const token = lowerToken(), body = token.slice("masondata_ci_".length);
  const list = (u: Record<string, unknown> = {}, more: Record<string, unknown> = {}): unknown => ({ users: [row("metabase", { role: "tenant", roleFrom: "file", roleKnown: true,
    attributes: { tenant: "42", regions: ["eu"] }, missingAttributes: ["region"], ...u })], lastUsedNote: "a note", urlNote: null, requestLogDays: 7, ...more });
  const linkAdd = (host: string, database: string, more: Record<string, unknown> = {}): unknown => {
    const answer = addedAnswer("x", { role: "tenant", roleFrom: "file", attributes: { tenant: "42" }, ...more });
    const url = connectionUrl({ url: "", host, port: 5433, database, sslmode: "require" }, "x", answer.password as string);
    return { ...answer, host, database, url, psql: psqlLine(url) };
  };
  type Field = [what: string, answer: (v: string) => unknown, read: (j: unknown, secrets: string[]) => unknown, plain: string];
  const fields: Field[] = [
    ["list: a user's name", (v) => list({ name: v, url: connectionUrl(LINK, v, null) }), (j, x) => heldList(j, x), "metabase"],
    ["list: a user's url, its database", (v) => list({ url: `postgres://metabase@db.example:5433/${v}` }), (j, x) => heldList(j, x), "shop"],
    ["list: a user's url, its host", (v) => list({ url: `postgres://metabase@${v}.example:5433/shop` }), (j, x) => heldList(j, x), "db"],
    ["list: a user's role", (v) => list({ role: v }), (j, x) => heldList(j, x), "tenant"],
    ["list: an attribute's name", (v) => list({ attributes: { [v]: "42" } }), (j, x) => heldList(j, x), "tenant"],
    ["list: an attribute's value", (v) => list({ attributes: { tenant: v } }), (j, x) => heldList(j, x), "42"],
    ["list: a list attribute's value", (v) => list({ attributes: { regions: ["eu", v] } }), (j, x) => heldList(j, x), "uk"],
    ["list: a missing attribute", (v) => list({ missingAttributes: [v] }), (j, x) => heldList(j, x), "region"],
    ["list: lastUsedNote", (v) => list({}, { lastUsedNote: v }), (j, x) => heldList(j, x), "a note"],
    ["list: urlNote", (v) => list({}, { urlNote: v }), (j, x) => heldList(j, x), "a note"],
    ["list: a key outside the shape", (v) => list({}, { note: v }), (j, x) => heldList(j, x), "a note"],
    ["add: its database", (v) => linkAdd("db.example", v), (j, x) => heldAdded(j, "x", x), "shop"],
    ["add: its host", (v) => linkAdd(`${v}.example`, "shop"), (j, x) => heldAdded(j, "x", x), "db"],
    ["add: its role", (v) => linkAdd("db.example", "shop", { role: v }), (j, x) => heldAdded(j, "x", x), "tenant"],
    ["add: an attribute's name", (v) => linkAdd("db.example", "shop", { attributes: { [v]: "42" } }), (j, x) => heldAdded(j, "x", x), "tenant"],
    ["add: an attribute's value", (v) => linkAdd("db.example", "shop", { attributes: { tenant: v } }), (j, x) => heldAdded(j, "x", x), "42"],
    ["add: a key outside the shape", (v) => ({ ...(linkAdd("db.example", "shop") as object), note: v }), (j, x) => heldAdded(j, "x", x), "a note"],
    ["disable: a key outside the shape", (v) => ({ disabled: { name: "x", id: ID, addedAt: AT, disabledAt: AT }, already: false, note: v }), (j, x) => heldDisabled(j, "x", x), "a note"],
    ["enable: a key outside the shape", (v) => ({ enabled: { name: "x", id: ID, addedAt: AT }, already: true, note: v }), (j, x) => heldEnabled(j, "x", x), "a note"],
    ["remove: a key outside the shape", (v) => ({ removed: { name: "x", id: ID, addedAt: AT, removedAt: AT }, note: v }), (j, x) => heldRemoved(j, "x", x), "a note"],
    ["a failure's code", (v) => ({ code: v, message: "refused" }), (j, x) => failureShape(j, x, { code: "refused", said: (c) => c, next: [] }), "busy"],
  ];
  // the forms each field is given, and whether the held token alone is what makes it a secret (its control: no token held)
  const forms: Array<[what: string, value: (plain: string) => string, byToken: boolean]> = [
    // the token whole has the documented token's shape, masked held or not, so its control is the shape's, not the grammar's
    ["the token whole", () => token, false], ["the token's body", () => body, true], ["the token's body, upper case", () => body.toUpperCase(), true],
    // a piece of the body: ECHO_RUN of it in a row is an echo, and split by a separator the grammar takes it still is
    ["11 of its body in a row", () => body.slice(7, 7 + echoRun), true], ["12 of its body, split by a dot", () => `${body.slice(3, 9)}.${body.slice(9, 15)}`, true],
    ["another user's password", () => OTHER, false], ["another user's password after a word character", (p) => `${p}_${OTHER}`, false],
    ["another user's password in upper case", () => OTHER.toUpperCase(), false],
  ];
  const problems: string[] = [];
  for (const [what, answer, read, plain] of fields) {
    if (read(answer(plain), [token]) === null) problems.push(`${what}: the plain answer is refused`);
    for (const [form, value, byToken] of forms) {
      const v = value(plain);
      if (read(answer(v), [token]) !== null) problems.push(`${what}, ${form}: taken`);
      // the grammar takes it: with no token held, the same answer is read (a password's shape is masked held or not)
      if (byToken && read(answer(v), []) === null && grammarTakes(what, v)) problems.push(`${what}, ${form}: refused with no token held, so the grammar decided`);
    }
  }
  assert.deepEqual(problems, []);
  // the limit, as the doc says it: 10 of the body in a row is no echo (chance explains it at 1 in about 10^-6 per answer)
  const limit: string[] = [];
  const piece = body.slice(7, 7 + echoRun - 1);
  for (const [what, answer, read] of fields) if (grammarTakes(what, piece) && read(answer(piece), [token]) === null) limit.push(`${what}: 10 of the body refused`);
  assert.deepEqual(limit, []);
});

/** Whether a field's grammar takes `v` as it is (else its refusal with no token held is the grammar's, rightly). */
function grammarTakes(what: string, v: string): boolean {
  if (/user's name/.test(what)) return /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(v);
  if (/role/.test(what)) return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v);
  if (/attribute's name|missing attribute/.test(what)) return /^[a-z_][a-z0-9_]{0,62}$/.test(v);
  if (/code/.test(what)) return /^[a-z][a-z0-9_]*$/.test(v) && v.length <= 64;
  if (/host/.test(what)) return /^[A-Za-z0-9-]{1,63}$/.test(v);
  return true;
}

test("mason user --replica end to end: a list whose user's url carries the token whole, a user named by its body, an add whose host carries it, a role spelling another user's password — each refused whole, nothing of it printed", async () => {
  const tokenOf = (r: Req): string => String(r.headers.authorization).replace(/^Bearer /, "");
  const bodyOf = (r: Req): string => tokenOf(r).replace(/^masondata_ci_/, "");
  for (const [what, verb, reply] of [
    ["list: a user's url carries the token whole", ["list"], (r: Req) => listAnswer([row("metabase", { url: `postgres://metabase@db.example:5433/${tokenOf(r)}` })])],
    ["list: a user named by its body, lower case", ["list"], (r: Req) => listAnswer([row("x", { name: bodyOf(r).toLowerCase().replace(/^[^a-z0-9]+/, "a") })])],
    ["add: its host carries the body", ["add", "x"], (r: Req) => {
      const a = addedAnswer("x"), host = `${bodyOf(r)}.example`, url = connectionUrl({ ...LINK, host }, "x", a.password as string);
      return ok({ ...a, host, url, psql: psqlLine(url) });
    }],
    ["add: a role spelling another user's password", ["add", "x"], () => ok(addedAnswer("x", { role: OTHER, roleFrom: "file" }))],
  ] as Array<[string, string[], (r: Req) => Reply]>) {
    for (const form of [[], ["--json"]]) {
      const { a, token } = await hosted(reply, [...verb, "--replica", R, ...form], { names: ["metabase", "x"] });
      const said = a.stdout + a.stderr, body = token.replace(/^masondata_ci_/, "");
      assert.equal(a.code, 1, `${what}: ${said}`);
      assert.match(said, / answered (GET|POST) \/v1\/replicas\/acme\/shop\/users\S* with 200, where /, what);
      for (const secret of [body, body.toLowerCase(), OTHER]) assert.ok(!said.includes(secret.slice(0, 11)), `${what} ${form.join(" ")}: printed a secret:\n${said}`);
    }
  }
});


test("an add whose 200 is outside the contract says the replica may have made the user, whose password was not shown, and the way to see and remove it", async () => {
  const { a } = await hosted(() => ok({ ...addedAnswer("x"), role: OTHER, roleFrom: "file" }), ["add", "x", "--replica", R, "--json"], { names: ["x"] });
  assert.equal(a.code, 1, a.stdout);
  const v = JSON.parse(a.stdout) as { error: { code: string; message: string; why: string; fix: string }; next: unknown };
  assert.match(v.error.message, / answered POST \/v1\/replicas\/acme\/shop\/users with 200, where a user was added$/);
  assert.match(v.error.why, /; the replica may have added x all the same, and its password was not shown$/);
  assert.equal(v.error.fix, `mason user list --replica ${R} says whether it did; if so, mason user remove x --replica ${R}, then add it again`);
  assert.deepEqual(v.next, [{ command: `mason user list --replica ${R}`, what: "the replica's users" }]);
});

// ------------------------------------------------------------------ an honest answer is not refused (PR 609's review, round 2)

/** Bytes from a fixed seed (SHA-256 in counter mode): the same answers and tokens at every run. */
function seeded(seed: string): (n: number) => Buffer {
  let counter = 0, pool = Buffer.alloc(0);
  return (n) => {
    while (pool.length < n) pool = Buffer.concat([pool, createHash("sha256").update(`${seed}:${counter++}`).digest()]);
    const out = pool.subarray(0, n); pool = pool.subarray(n); return out;
  };
}

/**
 * THE BOUND src/cli/hosted.ts `ECHO_RUN` IS DERIVED FROM, as a number: over W characters read in both views, an honest
 * answer holds a run of n of a random body's 43 characters at most W × 43 × 2 × 31^-n of the time.
 */
const bound = (chars: number, n: number): number => chars * 43 * 2 * 31 ** -n;

test("an honest answer at the contract's largest size — 2000 users, every value high-entropy, about 1 MiB — is never refused: the bound ECHO_RUN is derived from is under 1 in a million, and the measured rate of a shorter run stays within its own bound (a fixed seed)", { timeout: 600_000 }, () => {
  // the derivation: the largest answer read (MAX_LIST_BYTES), each character read at most 18 times by its
  // compatibility form, in two views — under 1 in a million at ECHO_RUN, not at one less
  const bytes = seeded("mason-609-honest");
  const b64 = (n: number): string => bytes(Math.ceil(n * 3 / 4)).toString("base64url").slice(0, n);
  const hex = (n: number): string => bytes(Math.ceil(n / 2)).toString("hex").slice(0, n);
  const uuid = (): string => { const h = hex(32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
  // every value high-entropy, the answer at its 1 MiB bound: a user's name of 43 characters, ids, a UUID tenant, an org id, a
  // long random value — the shapes that tripped the quarter rule, at the size that tripped it most
  const users = Array.from({ length: 2000 }, () => {
    const name = `u${b64(42).toLowerCase().replace(/[^a-z0-9_.-]/g, "x")}`;
    return row(name, { id: hex(16), url: connectionUrl(LINK, name, null), role: `r${b64(40).toLowerCase().replace(/[^a-z0-9_-]/g, "x")}`, roleFrom: "file", roleKnown: true,
      attributes: { tenant: uuid(), org: `org_${b64(24)}` }, missingAttributes: [`m${hex(30)}`] });
  });
  const answer = { users, lastUsedNote: null, urlNote: null, requestLogDays: 7 };
  const size = Buffer.byteLength(JSON.stringify(answer));
  assert.ok(size <= MAX_LIST_BYTES && size > 0.9 * MAX_LIST_BYTES, `the answer is the contract's largest: ${size} bytes`);
  const strings: string[] = [];
  const walk = (v: unknown): void => { if (typeof v === "string") strings.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { strings.push(k); walk(x); } };
  walk(answer);
  const read = 2 * strings.reduce((n, x) => n + x.length, 0);
  const tokens = Array.from({ length: 40 }, () => `masondata_ci_${bytes(32).toString("base64url")}`);
  // at ECHO_RUN: none refused, the code path itself
  const refused = tokens.filter((t) => !carriesNoSecret(answer, [t])).length;
  assert.equal(refused, 0, `${refused} of ${tokens.length} honest answers refused`);
  const worst = 2 * 18 * MAX_LIST_BYTES;
  assert.equal(hostedModule.ECHO_RUN, echoRun, "src/cli/hosted.ts says ECHO_RUN");
  assert.ok(bound(worst, echoRun) < 1e-6, `ECHO_RUN ${echoRun}: ${bound(worst, echoRun)}`);
  assert.ok(bound(worst, echoRun - 1) >= 1e-6, `ECHO_RUN - 1 would do: ${bound(worst, echoRun - 1)}`);
  // the model, where it can be seen: a run of 6 is met by chance in this answer, and no more often than its bound says
  const short = tokens.filter((t) => strings.some((x) => echoesSecret(x, [t], 6))).length;
  assert.ok(short <= Math.ceil(bound(read, 6) * tokens.length), `a run of 6: ${short} of ${tokens.length}, its bound ${bound(read, 6).toFixed(3)} each`);
  assert.ok(short > 0, "a run of 6 is met by chance: the measurement can see the model");
});

test("mason user --replica: an answer nested deeper than any documented shape — a list 500,000 deep within its 1 MiB, an add 32,000 deep within 64 KiB — is refused by its status, never a crash (PR 645's review: the walk's own stack)", { timeout: 300_000 }, async () => {
  const nest = (n: number): string => "[".repeat(n) + "]".repeat(n);
  for (const [what, verb, json, said] of [
    ["list", ["list"], `{"users":[],"lastUsedNote":null,"urlNote":null,"requestLogDays":7,"x":${nest(500_000)}}`, / answered GET \/v1\/replicas\/acme\/shop\/users\?lastUsed=1 with 200, where /],
    ["add", ["add", "x"], JSON.stringify(addedAnswer("x")).replace(/}$/, `,"x":${nest(32_000)}}`), / answered POST \/v1\/replicas\/acme\/shop\/users with 200, where /],
  ] as Array<[string, string[], string, RegExp]>) {
    for (const form of [[], ["--json"]]) {
      const { a } = await hosted(() => ({ status: 200, json }), [...verb, "--replica", R, ...form], { names: ["x"] });
      const all = a.stdout + a.stderr;
      assert.equal(a.code, 1, `${what} ${form.join(" ")}: ${all}`);
      assert.match(all, said, what);
      assert.doesNotMatch(all, /call stack|RangeError|bug in mason/, what);
    }
  }
});

test("mason user --replica: what is tested is what is written (PR 645's class round) — an attribute's value of 10 of the token's body and a lone surrogate prints the surrogate as ?, never --json's \\udc00; a user's name of 10 of the body followed in the list by the CLI's word that is its 11th is refused at the write by the output's gate", { timeout: 120_000 }, async () => {
  const bodyOf = (r: Req): string => String(r.headers.authorization).replace(/^Bearer masondata_ci_/, "");
  // a lone surrogate after 10 of the token's body: whatever its next character, the escape is never written. The token
  // is fixed: the gate reads past punctuation, re-cased, so a random body whose 11th character is the first letter
  // written after the value (`l` of lastUsedNote) made an honest 11 in a row and the gate refused, about 1 run in 10
  {
    const token = ["masondata", "ci", "k7mw2qx9vbZTr4Lp8Zn3Hc6Df1Gs5Jy0Ue-Wa_Ob2Xm"].join("_"); SECRETS.push(token);
    const { a } = await hosted((r) => ({ status: 200, json: JSON.stringify((listAnswer([row("metabase", { attributes: { tenant: "TENANT" } })]) as { body: unknown }).body).replace("TENANT", `${bodyOf(r).slice(0, 10)}\\udc00`) }), ["list", "--replica", R, "--json"], { names: ["metabase"], extra: { MASON_TOKEN: token } });
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.ok(!a.stdout.includes("\\u"), a.stdout);
    assert.match(a.stdout, /"tenant": "[A-Za-z0-9_-]{10}\?"/);
    assert.ok(!a.stdout.includes(token.slice(13, 24)));
  }
  // the gate: the token is the test's, so its 11th is the first letter written after the name, in --json ("id")
  const token = ["masondata", "ci", "k7mw2qx9vbiTr4Lp8Zn3Hc6Df1Gs5Jy0Ue-Wa_Ob2Xm"].join("_"); SECRETS.push(token);
  const { a } = await hosted(() => listAnswer([row("k7mw2qx9vb")]), ["list", "--replica", R, "--json"], { names: ["k7mw2qx9vb"], extra: { MASON_TOKEN: token } });
  assert.equal(a.code, 1, a.stdout + a.stderr);
  assert.equal((JSON.parse(a.stdout) as { error: { message: string } }).error.message, "the service's answer would print a secret this command holds, so nothing more of it is printed");
  assert.ok(!a.stdout.includes("k7mw2qx9vb"), a.stdout);
});

test("mason user --replica: the output's gate refuses no honest answer by chance — a list of 40 users of high-entropy names and values, and an add with its password, as written for a person and in --json, against random tokens from a fixed seed: none refused at ECHO_RUN, and a run of 5 within its bound", { timeout: 300_000 }, async (t) => {
  const bytes = seeded("mason-645-gate-users");
  const b64 = (n: number): string => bytes(Math.ceil(n * 3 / 4) + 1).toString("base64url").slice(0, n);
  // 40: the harness holds every run to showing no more than a quarter of any token the file made (hosted-fake `mason`,
  // the quarter rule, across all of them), which a larger random answer trips by chance — the measurement is the gate's
  const names = Array.from({ length: 40 }, () => `u${b64(30).toLowerCase().replace(/[^a-z0-9_.-]/g, "x")}`);
  const users = names.map((n) => row(n, { attributes: { tenant: b64(36), org: `org_${b64(20)}` } }));
  const lists: string[] = [], adds: string[] = [];
  for (const form of [[], ["--json"]]) {
    const l = await hosted(() => listAnswer(users), ["list", "--replica", R, ...form], { names });
    assert.equal(l.a.code, 0, l.a.stderr);
    const add = await hosted(() => ok(addedAnswer("x")), ["add", "x", "--replica", R, ...form], { names: ["x"] });
    assert.equal(add.a.code, 0, add.a.stderr);
    lists.push(l.a.stdout, l.a.stderr); adds.push(add.a.stdout, add.a.stderr);
  }
  // add prints the password it made: a password's shape is its answer's there (src/cli/user-hosted.ts holdOutput)
  for (const [what, texts, passwords] of [["the list", lists, true], ["the add", adds, false]] as const) {
    const m = await measureGate(texts, `mason-645-gate-users-tokens-${what}`, 300, { passwords });
    t.diagnostic(`measured, ${what}: ${JSON.stringify(m)}`);
    assert.equal(m.refused, 0, `${what}: ${m.refused} of 300 honest answers refused`);
    assert.ok(m.bound < 1e-6, `${what}: the bound at ECHO_RUN: ${m.bound}`);
    assert.ok(m.shortRefused <= m.shortBound, `${what}: a run of 5: ${m.shortRefused}, its bound ${m.shortBound}`);
  }
});

noTokenPrinted(40);
