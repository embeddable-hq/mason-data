/**
 * `mason token create | list | revoke` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts: an http server of this
 * test's on 127.0.0.1, no network). The contract is docs/HOSTED-API.md "CI tokens"; what each test holds is in its name.
 * Every run is held by `mason` to carrying no login token and to no line a person sees begun by the service's text; the
 * CI token a create makes is held here to appearing on its one line, or in its one field, once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS, bodyOf, envFor, fakeService, home, mason, newToken, runToken, SECRETS, showsRun, type Lines, type Reply, type Req } from "./hosted-fake.ts";
import { runMason, type Answer } from "./cli-matrix.ts";
import { heldMade } from "../src/cli/token-hosted.ts";

const AT = "2026-11-02T10:00:00.000Z";
const LATER = "2027-01-31T10:00:00.000Z";
const TOKENS = "/v1/tokens/acme";
const ID = "3f1c9a2e-0b7d-4c55-9e8a-61d2f0a4b7c3";
const listed = (more: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: ID, name: "github-actions", replica: "acme/shop", scopes: ["deploy"], madeBy: "ada@example.com", createdAt: AT, lastUsedAt: null, expiresAt: LATER, ...more });
const made = (value: string, more: Record<string, unknown> = {}): Reply =>
  ({ status: 201, body: { token: { id: ID, value, name: "github-actions", replica: "acme/shop", scopes: ["deploy"], createdAt: AT, expiresAt: LATER, ...more } } });
const ok = (body: unknown): Reply => ({ status: 200, body });
const ME_TWO = { email: "ada@example.com", name: "Ada", orgs: [{ slug: "acme", name: "Acme", role: "owner" }, { slug: "beta", name: "Beta", role: "viewer" }, { slug: "gamma", name: "Gamma", role: "admin" }] };

const OWN_STEP = /^ {2}(mason login|mason token (create --replica (\S+)|list( \S+)?|revoke \S+ --org \S+))(\s|$)/;
const LINES: Lines = {
  heads: ["Made a CI token for ", "Revoked the CI token ", "No CI tokens that act, in ", "✘ mason token: ", "✗ mason token: ", "Tip: Store it now, ", "Tip: It acts on ", "Tip: acme has more ",
    ...["token", "id", "name", "scopes", "expires", "why", "fix"].map((l) => `  ${l} `)],
  steps: ["  mason login", "  mason token "], ownStep: OWN_STEP,
  row: (line) => /^\d+ CI tokens? that act, in /.test(line) || line.startsWith(`  ${ID} `) || line.startsWith("  b2 "),
};

/** One run against a fresh fake whose endpoints `v1` answers, signed in by MASON_TOKEN; its requests. */
async function hosted(v1: (r: Req) => Reply | Promise<Reply>, argv: string[], o: { token?: string; me?: Reply; terminal?: number } = {}): Promise<{ a: Answer; requests: Req[]; token: string }> {
  const token = o.token ?? newToken("pat"); SECRETS.push(token);
  const fake = await fakeService({ v1, ...(o.me ? { me: o.me } : {}) });
  const h = home();
  try {
    const a = await mason(h, ["token", ...argv], envFor(h, fake.url, { MASON_TOKEN: token }), { lines: LINES, ...(o.terminal ? { terminal: o.terminal } : {}) });
    return { a, requests: fake.requests.filter((r) => r.path.startsWith("/v1/")), token };
  } finally { await fake.close(); }
}

/** How many times `text` holds `value`, whole. */
const times = (text: string, value: string): number => text.split(value).length - 1;

test("mason token create: the request names the replica, the scopes, a name and the days; the token is printed ONCE — on its one line for a person, in token.value alone under --json — and never on stderr", async () => {
  const value = newToken("ci");
  const r = await hosted((q) => q.method === "POST" && q.path === TOKENS ? made(value) : { status: 404, body: { error: { code: "not_found", message: "no" } } },
    ["create", "--replica", "acme/shop", "--name", "github-actions"]);
  assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
  assert.deepEqual(r.requests.map((q) => `${q.method} ${q.path}`), ["POST /v1/tokens/acme"]);
  assert.deepEqual(JSON.parse(r.requests[0]!.body), { name: "github-actions", replica: "shop", scopes: ["deploy"], expiresInDays: 90 });
  assert.equal(r.requests[0]!.headers.authorization, `Bearer ${r.token}`);
  assert.equal(r.a.stdout, `Made a CI token for acme/shop: it is printed this once
  token     ${value}
  id        ${ID}
  name      github-actions
  scopes    deploy
  expires   ${LATER}

Tip: Store it now, as MASON_TOKEN in your CI's secrets: the service does not keep it, and nothing shows it again.
Tip: It acts on acme/shop alone, for deploy, until it expires or is revoked.

Next:
  mason token list acme                         the organisation's CI tokens
  mason token revoke ${ID} --org acme  end it
`);
  assert.deepEqual(r.a.stdout.split("\n").filter((l) => showsRun(l, value)), [`  token     ${value}`], "the one line that carries it");
  assert.equal(r.a.stderr, "");
  const value2 = newToken("ci");
  const j = await hosted(() => made(value2, { scopes: ["deploy", "users"] }), ["create", "--replica", "acme/shop", "--scope", "users", "--scope", "deploy", "--days", "30", "--json"]);
  assert.equal(j.a.code, 0, j.a.stdout);
  assert.deepEqual(JSON.parse(j.requests[0]!.body), { name: "ci", replica: "shop", scopes: ["users", "deploy"], expiresInDays: 30 });
  const v = JSON.parse(j.a.stdout) as { token: Record<string, unknown>; next: unknown };
  assert.deepEqual(v.token, { id: ID, value: value2, name: "github-actions", replica: "acme/shop", scopes: ["deploy", "users"], createdAt: AT, expiresAt: LATER });
  assert.equal(times(j.a.stdout, value2), 1, "once, in token.value");
  assert.ok(!showsRun(JSON.stringify({ ...v, token: { ...v.token, value: null } }), value2), "no other field holds any of it");
  assert.equal(j.a.stderr, "");
  // MASON_REPLICA names the replica when --replica does not
  const fake = await fakeService({ v1: () => made(newToken("ci")) });
  try {
    const e = await runMason(home(), ["token", "create", "--json"], envFor(home(), fake.url, { MASON_TOKEN: newToken(), MASON_REPLICA: "acme/shop" }));
    assert.equal(e.code, 0, e.stdout);
    assert.equal(JSON.parse(fake.requests[0]!.body).replica, "shop");
  } finally { await fake.close(); }
});

test("mason token create: an answer whose token is not the documented form, is the login's own, or is carried a second time — in its name, its id, a key, another field — is refused whole: nothing of it printed", async () => {
  const login = runToken("pat");
  const value = runToken("ci", 1);
  const cases: Array<[string, Reply]> = [
    ["a value not of the documented form", made("masondata_ci_short")],
    ["a pat as the value", made(newToken("pat"))],
    ["the login's own token as the value", made(login)],
    ["the value again in its name", made(value, { name: value })],
    ["11 of its body in a row in its id", made(value, { id: bodyOf(value).slice(0, 11) })],
    ["the value again in a key", { status: 201, body: { token: { id: ID, value, name: "x", replica: "acme/shop", scopes: ["deploy"], createdAt: AT, expiresAt: LATER }, [bodyOf(value)]: 1 } }],
    ["the login's body in its name", made(value, { name: bodyOf(login) })],
    ["another replica than asked", made(value, { replica: "acme/other" })],
    ["other scopes than asked", made(value, { scopes: ["deploy", "users"] })],
  ];
  for (const [what, reply] of cases) {
    for (const form of [[], ["--json"]]) {
      const r = await hosted(() => reply, ["create", "--replica", "acme/shop", ...form], { token: login });
      const said = r.a.stdout + r.a.stderr;
      assert.equal(r.a.code, 1, `${what}: ${said}`);
      assert.match(said, / answered POST \/v1\/tokens\/acme with 201, where a CI token was made/, what);
      assert.match(said, /a token may have been made all the same, and it was not shown/, what);
      assert.ok(!showsRun(said, value) && !showsRun(said, login), `${what}: printed none of either`);
      assert.doesNotMatch(said, /masondata_(pat|ci)_[A-Za-z0-9_-]{20}/, what);
    }
  }
  assert.equal(heldMade({ token: { id: ID, value, name: "n", replica: "acme/shop", scopes: ["deploy"], createdAt: AT, expiresAt: LATER } }, { org: "acme", name: "shop", scopes: ["deploy"] }, [login])?.value, value);
});

test("mason token list and revoke: the tokens that act, each value held, never a token itself; every organisation the login is an admin or an owner of when none is named; revoke by its id, in --org or the login's one such organisation", async () => {
  const v1 = (r: Req): Reply => r.method === "GET" && r.path === TOKENS ? ok({ tokens: [listed(), listed({ id: "b2", name: "deploy-bot", scopes: ["deploy", "users"], lastUsedAt: AT })], more: true })
    : r.method === "GET" && r.path === "/v1/tokens/gamma" ? ok({ tokens: [], more: false })
    : r.method === "POST" && r.path === `${TOKENS}/${ID}/revoke` ? ok({ revoked: { id: ID, name: "github-actions" } })
    : { status: 404, body: { error: { code: "not_found", message: `acme has no live CI token ${r.path.split("/")[4]}`, fix: "GET /v1/tokens/<org> lists them" } } };
  const one = await hosted(v1, ["list", "acme"]);
  assert.equal(one.a.code, 0, one.a.stderr);
  assert.match(one.a.stdout, new RegExp(`^2 CI tokens that act, in acme\\n {2}${ID} {3}github-actions: acme/shop, deploy, until ${LATER.replace(/\./g, "\\.")}, last used never, made by ada@example\\.com\\n {2}b2 {3}deploy-bot: acme/shop, deploy and users, until `));
  assert.match(one.a.stdout, /\nTip: acme has more CI tokens than the service lists at once/);
  // every organisation the login is an admin or an owner of: acme and gamma, never the viewer's beta
  const all = await hosted(v1, ["list", "--json"], { me: ok(ME_TWO) });
  assert.equal(all.a.code, 0, all.a.stdout);
  assert.deepEqual(all.requests.map((q) => q.path), ["/v1/me", TOKENS, "/v1/tokens/gamma"]);
  const v = JSON.parse(all.a.stdout) as { tokens: Array<Record<string, unknown>>; more: boolean };
  assert.deepEqual(v.tokens[0], listed());
  assert.equal(v.more, true);
  // revoke: no body, by --org
  const rv = await hosted(v1, ["revoke", ID, "--org", "acme", "--json"]);
  assert.equal(rv.a.code, 0, rv.a.stdout);
  assert.deepEqual(rv.requests.map((q) => [q.method, q.path, q.body]), [["POST", `${TOKENS}/${ID}/revoke`, ""]]);
  assert.deepEqual(JSON.parse(rv.a.stdout), { revoked: { org: "acme", id: ID, name: "github-actions" }, next: [{ command: "mason token list acme", what: "the organisation's CI tokens" }] });
  // without --org: the login's one organisation it may revoke in; of two, it asks which (exit 2), nothing revoked
  const solo = await hosted(v1, ["revoke", ID], { me: ok({ ...ME_TWO, orgs: [ME_TWO.orgs[0], ME_TWO.orgs[1]] }) });
  assert.equal(solo.a.code, 0, solo.a.stderr);
  assert.match(solo.a.stdout, new RegExp(`^Revoked the CI token ${ID} of acme: it acts no more\\n {2}name {3}github-actions\\n`));
  const two = await hosted(v1, ["revoke", ID, "--json"], { me: ok(ME_TWO) });
  const te = JSON.parse(two.a.stdout) as { error: { code: string; message: string; fix: string } };
  assert.deepEqual([two.a.code, te.error.code, te.error.message], [2, "usage", "this login is an admin or an owner of 2 organisations: which one is the token of?"]);
  assert.match(te.error.fix, /\(acme, gamma\)$/);
  assert.deepEqual(two.requests.map((q) => q.path), ["/v1/me"]);
  // revoked already, or not of this organisation: the service's words, not_found, the CLI's next step the list
  const gone = await hosted(v1, ["revoke", "nope", "--org", "acme", "--json"]);
  const ge = JSON.parse(gone.a.stdout) as { error: { code: string; message: string }; next: Array<{ command: string }> };
  assert.deepEqual([gone.a.code, ge.error.code, ge.error.message, ge.next.map((n) => n.command)], [1, "not_found", "acme has no live CI token nope", ["mason token list acme"]]);
  // a viewer, or a CI token: the service's words, and the role that may
  const viewer = await hosted(() => ({ status: 403, body: { error: { code: "refused", message: "a viewer may not list CI tokens" }, next: [{ command: "mason destroy" }] } }), ["list", "beta", "--json"]);
  const vn = JSON.parse(viewer.a.stdout) as { error: { code: string }; next: Array<{ command: string; what: string }> };
  assert.deepEqual([viewer.a.code, vn.error.code, vn.next], [1, "refused", [{ command: "mason login", what: "sign in as an admin or an owner of beta" }]]);
  // a list carrying a token in any value is refused whole
  const login = runToken("pat");
  for (const bad of [listed({ name: login }), listed({ madeBy: bodyOf(login).toLowerCase() }), listed({ id: bodyOf(login).slice(0, 20) }), listed({ value: newToken("ci") }), listed({ scopes: ["deploy", "admin"] }), listed({ replica: "beta/shop" })]) {
    const x = await hosted(() => ok({ tokens: [bad], more: false }), ["list", "acme"], { token: login });
    assert.equal(x.a.code, 1, JSON.stringify(bad));
    assert.match(x.a.stderr, / answered GET \/v1\/tokens\/acme with 200, where the CI tokens were asked for/);
    assert.ok(!showsRun(x.a.stdout + x.a.stderr, login));
    assert.doesNotMatch(x.a.stdout + x.a.stderr, /masondata_ci_/);
  }
});

test("mason token: a wrong line is refused here, exit 2, and nothing is sent — a verb, a scope, a name, the days, an id, an organisation, a flag of another subcommand", async () => {
  const fake = await fakeService({ v1: () => made(newToken("ci")) });
  try {
    for (const argv of [[], ["frobnicate"], ["create"], ["create", "acme/shop"], ["create", "--replica", "acme"], ["create", "--replica", "acme/shop", "--scope", "admin"],
      ["create", "--replica", "acme/shop", "--scope", "deploy", "--scope", "deploy"], ["create", "--replica", "acme/shop", "--name", ""], ["create", "--replica", "acme/shop", "--name", "a\nb"],
      ["create", "--replica", "acme/shop", "--name", "x".repeat(65)], ["create", "--replica", "acme/shop", "--days", "0"], ["create", "--replica", "acme/shop", "--days", "366"],
      ["create", "--replica", "acme/shop", "--days", "1.5"], ["revoke"], ["revoke", "../x"], ["revoke", "a", "b"], ["revoke", "a", "--org", "Acme"], ["list", "Acme"], ["list", "--org", "acme"],
      ["list", "--scope", "deploy"], ["revoke", "a", "--replica", "acme/shop"]]) {
      const a = await runMason(home(), ["token", ...argv, "--json"], envFor(home(), fake.url, { MASON_TOKEN: newToken() }));
      assert.equal(a.code, 2, `${argv.join(" ")}: ${a.stdout}`);
      assert.equal((JSON.parse(a.stdout) as { error: { code: string } }).error.code, "usage", argv.join(" "));
    }
    assert.deepEqual(fake.requests, []);
  } finally { await fake.close(); }
});

test("mason token, on a terminal 20 to 80 wide: every line one the CLI begins, none the terminal broke — the token's line too", async () => {
  for (const width of [20, 41, 80]) {
    const value = newToken("ci");
    const r = await hosted(() => made(value), ["create", "--replica", "acme/shop"], { terminal: width });
    assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
    // broken by the CLI at the width, the token is still printed once: its pieces, joined, are it
    assert.equal(times(r.a.stdout.replace(/\n {4,}/g, ""), value), 1, `${width}: ${r.a.stdout}`);
  }
});

test("no run of mason token printed a login's token, nor put one on its command line", () => {
  assert.ok(ANSWERS.length >= 30, `the runs above are here (${ANSWERS.length})`);
  for (const a of ANSWERS) for (const s of SECRETS) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s) && !a.argv.some((x) => x.includes(s)), `mason ${a.argv.join(" ")} printed a login's token`);
});
