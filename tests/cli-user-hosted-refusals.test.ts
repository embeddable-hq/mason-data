/**
 * `mason user … --replica <org>/<name>` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts, tests/user-hosted-fake.ts: an
 * http server of this test's on 127.0.0.1, no network): each refusal, and each answer outside the run's own shape. The contract is docs/HOSTED-API.md "The users of a
 * replica"; what each test holds is in its name. Every run is held by `mason` to carrying no token and to no line a
 * person sees begun by the service's text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Reply, Req } from "./hosted-fake.ts";
import { addedAnswer, AT, hosted, ID, LINK, listAnswer, noTokenPrinted, ok, R, row } from "./user-hosted-fake.ts";
import { heldAdded, heldDisabled, heldEnabled, heldList, heldRemoved } from "../src/cli/user-hosted.ts";
import { failureShape } from "../src/cli/hosted.ts";
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
const lowerToken = (): string => `masondata_ci_${Array.from(randomBytes(43), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("")}`;
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
});

/** Whether a field's grammar takes `v` as it is (else its refusal with no token held is the grammar's, rightly). */
function grammarTakes(what: string, v: string): boolean {
  if (/name|role|missing attribute|code/.test(what)) return /^[a-z0-9_][a-z0-9_.-]{0,62}$/.test(v) && !/^[_.-]/.test(v);
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

noTokenPrinted(40);
