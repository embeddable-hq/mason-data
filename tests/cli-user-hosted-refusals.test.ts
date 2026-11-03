/**
 * `mason user … --replica <org>/<name>` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts, tests/user-hosted-fake.ts: an
 * http server of this test's on 127.0.0.1, no network): each refusal, and each answer outside the run's own shape. The contract is docs/HOSTED-API.md "The users of a
 * replica"; what each test holds is in its name. Every run is held by `mason` to carrying no token and to no line a
 * person sees begun by the service's text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Reply } from "./hosted-fake.ts";
import { addedAnswer, AT, hosted, ID, listAnswer, noTokenPrinted, ok, R, row } from "./user-hosted-fake.ts";

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

noTokenPrinted(40);
