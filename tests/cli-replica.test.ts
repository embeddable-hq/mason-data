/**
 * `mason replica create | list | status` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts: an http server of this
 * test's on 127.0.0.1, no network). The contract is docs/HOSTED-API.md "Replicas"; what each test holds is in its name.
 * Every run is held by `mason` to carrying no token, to no line a person sees begun by the service's text, and here to
 * carrying no part of the database's URL that is not printed on purpose (its password never).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { ANSWERS, envFor, fakeService, home, mason, newToken, runForms, runToken, SECRETS, showsRun, type Lines, type Reply, type Req } from "./hosted-fake.ts";
import { runMason, type Answer } from "./cli-matrix.ts";
import { checkLines, heldReplica, MIN_PASSWORD, urlPassword, wordless } from "../src/cli/replica-hosted.ts";
import { carriesNoSecret } from "../src/cli/hosted.ts";

const AT = "2026-11-02T10:00:00.000Z";
/** The database's password: long enough (12) to be held by the exact test and the output's gate, as the token is. */
const PASSWORD = "Zq8vLm2Xr7Tp";
const URL_ = `postgres://app_reader:${PASSWORD}@db.example:5432/app`;
const REPLICAS = "/v1/replicas/acme";
const ONE = `${REPLICAS}/shop`;
const replicaOf = (more: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ org: "acme", name: "shop", region: "eu", sizeGb: 50, hostId: "brisk-otter-4821", state: "ready", createdAt: AT, allowlist: [], pending: [], ...more });
const CHECKS = [{ source: "app", outcome: "passed", checks: [{ name: "connects", status: "ok", detail: "Postgres 16 answers" },
  { name: "the role", status: "warn", detail: "it may write to a synced table", fix: "a role that only reads" }], missing: [] }];
const created = (more: Record<string, unknown> = {}): Reply => ({ status: 201, body: { replica: replicaOf(more), checks: CHECKS }, headers: { "retry-after": "1" } });
const ok = (body: unknown, headers?: Record<string, string>): Reply => ({ status: 200, body, ...(headers ? { headers } : {}) });

/** The lines mason replica begins (tests/hosted-fake.ts's rule, in its words); a list's row is begun by a replica's name. */
const OWN_STEP = /^ {2}(mason login|mason doctor|mason replica (create|list|status)( \S+)*|mason (deploy|token create) --replica acme\/shop)(\s|$)/;
const LINES: Lines = {
  heads: ["Created ", "Creating ", "acme/shop on ", "No replicas yet in ", "Mason's checks of the database ", "✘ mason replica: ", "✗ mason replica: ",
    "  ok ", "  !  ", "  !! ", "  ?  ", "  The creation's answer was lost ", "  checking: ", "  creating: ", "Tip: The service does not keep ", "Tip: acme has more ",
    ...["state", "region", "size", "host", "created", "allowlist", "pending", "why", "fix"].map((l) => `  ${l} `)],
  steps: ["  mason login", "  mason doctor", "  mason replica ", "  mason deploy ", "  mason token "], ownStep: OWN_STEP,
  row: (line) => /^\d+ replicas? in /.test(line) || /^ {2}(acme|beta)\/[a-z]+ /.test(line),
};

/** A project whose sources file names its database by DATABASE_URL, set in its .env (or as `env` says). */
function project(o: { url?: string | null; file?: string } = {}): string {
  const root = home();
  fs.mkdirSync(path.join(root, ".mason"), { mode: 0o700 });
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  fs.writeFileSync(path.join(root, ".mason", "config.json"), JSON.stringify({ name: "shop", folder: "mason", remote: false, apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "mason", "sources", "app.yml"), o.file ?? "kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  orders: {}\n");
  if (o.url !== null) fs.writeFileSync(path.join(root, ".env"), `DATABASE_URL=${o.url ?? URL_}\n`);
  return root;
}

/** One run in `cwd` against a fresh fake whose replica endpoints `v1` answers, signed in by MASON_TOKEN; its requests. */
async function hosted(v1: (r: Req) => Reply | Promise<Reply>, argv: string[], o: { cwd?: string; token?: string; terminal?: number; me?: Reply } = {}): Promise<{ a: Answer; requests: Req[]; token: string }> {
  const token = o.token ?? newToken("pat"); SECRETS.push(token);
  const fake = await fakeService({ v1, ...(o.me ? { me: o.me } : {}) });
  const h = home();
  try {
    const a = await mason(o.cwd ?? h, ["replica", ...argv], envFor(h, fake.url, { MASON_TOKEN: token }), { lines: LINES, ...(o.terminal ? { terminal: o.terminal } : {}) });
    // the database's URL: never its password, in any form a run prints
    for (const text of [a.stdout, a.stderr]) assert.ok(!text.includes(PASSWORD) && !text.toLowerCase().includes(PASSWORD.toLowerCase()), `mason replica ${argv.join(" ")} printed the database's password:\n${a.stdout}${a.stderr}`);
    assert.ok(!a.argv.some((x) => x.includes(PASSWORD) || x.includes("postgres://")), "the URL is never on the command line");
    return { a, requests: fake.requests.filter((r) => r.path.startsWith("/v1/")), token };
  } finally { await fake.close(); }
}

test("mason replica create: the URL is read by the variable the sources file names, sent once in the body beside that variable's name, never on the command line or printed; the checks are said one line each; the replica's state waited for until it is ready", async () => {
  const root = project();
  let polls = 0;
  const v1 = (r: Req): Reply => r.method === "POST" && r.path === REPLICAS ? created({ state: "creating", pending: [{ change: "create", state: "pending", attempts: 1, nextAttemptAt: AT }] })
    : r.method === "GET" && r.path === ONE ? ok({ replica: replicaOf({ state: polls++ ? "ready" : "creating", allowlist: polls > 1 ? ["192.0.2.0/24"] : [] }) }, { "retry-after": "1" })
    : { status: 404, body: { error: { code: "not_found", message: "no" } } };
  const { a, requests, token } = await hosted(v1, ["create", "acme/shop", "--region", "eu", "--size", "50"], { cwd: root });
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), ["POST /v1/replicas/acme", "GET /v1/replicas/acme/shop", "GET /v1/replicas/acme/shop"]);
  assert.deepEqual(JSON.parse(requests[0]!.body), { name: "shop", region: "eu", sizeGb: 50, sources: [{ name: "app", variable: "DATABASE_URL", url: URL_ }] });
  assert.equal(requests[0]!.headers.authorization, `Bearer ${token}`);
  assert.equal(requests[0]!.headers["content-type"], "application/json");
  for (const q of requests.slice(1)) assert.equal(q.body, "", "only the creation carries the URL");
  assert.equal(a.stdout, `Created acme/shop on ${a.stdout.match(/on (http:\/\/127\.0\.0\.1:\d+)/)![1]}: it is ready
  region      eu
  size        50 GB of synced data
  host        brisk-otter-4821
  created     ${AT}
  allowlist   192.0.2.0/24

Tip: The service does not keep the database's URL: the replica reads it by its variable, from its own environment.

Next:
  mason deploy --replica acme/shop              send this project to it
  mason token create --replica acme/shop        a CI token for it
`);
  assert.deepEqual(a.stderr.split("\n").filter((l) => /^ {2}(ok|!) /.test(l) || l.startsWith("Mason's checks")), [
    "Mason's checks of the database app names: passed",
    "  ok connects: Postgres 16 answers",
    "  !  the role: it may write to a synced table (fix: a role that only reads)",
  ]);
  assert.match(a.stderr, /^Creating acme\/shop on http:\/\/127\.0\.0\.1:\d+: Mason checks the database DATABASE_URL names \(DATABASE_URL in \.env\) from the replica's side, up to a minute$/m);
  assert.match(a.stderr, /^ {2}creating: its region is making it$/m);
  // --json: the replica and the checks, the URL nowhere
  const j = await hosted(() => created(), ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root });
  assert.equal(j.a.code, 0, j.a.stdout);
  const v = JSON.parse(j.a.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(v), ["replica", "checks", "next"]);
  assert.deepEqual(v.replica, { ...replicaOf(), pending: [] });
  assert.deepEqual(v.checks, [{ source: "app", outcome: "passed", missing: [],
    checks: [{ name: "connects", status: "ok", detail: "Postgres 16 answers", fix: null }, { name: "the role", status: "warn", detail: "it may write to a synced table", fix: "a role that only reads" }] }]);
  assert.equal(j.a.stderr, "", "--json prints no progress");
  assert.ok(!j.a.stdout.includes("db.example"), "nothing of the URL is in --json");
});

test("mason replica create: what is refused here, before a byte is sent — a wrong line (exit 2), no project, a url: written in the file, a variable unset or not a database URL, not signed in", async () => {
  const fake = await fakeService({ v1: () => created() });
  try {
    const run = (cwd: string, argv: string[], extra: Record<string, string> = {}): Promise<Answer> => runMason(cwd, ["replica", ...argv, "--json"], envFor(home(), fake.url, { MASON_TOKEN: newToken(), ...extra }));
    const root = project();
    for (const argv of [["create"], ["create", "acme"], ["create", "Acme/shop", "--region", "eu", "--size", "50"], ["create", "acme/shop", "--size", "50"], ["create", "acme/shop", "--region", "eu"],
      ["create", "acme/shop", "--region", "EU", "--size", "50"], ["create", "acme/shop", "--region", "eu", "--size", "50gb"], ["create", "acme/shop", "--region", "eu", "--size", "0"],
      ["create", "acme/shop", "--region", "eu", "--size", "50", "--timeout", "soon"], ["create", "acme/shop", "x", "--region", "eu", "--size", "50"], ["status"], ["status", "acme/shop", "--region", "eu"],
      ["frobnicate"], [], ["list", "Acme"], ["list", "acme", "beta"]]) {
      const a = await run(root, argv);
      assert.equal(a.code, 2, `${argv.join(" ")}: ${a.stdout}`);
      assert.equal((JSON.parse(a.stdout) as { error: { code: string } }).error.code, "usage", argv.join(" "));
    }
    const line = ["create", "acme/shop", "--region", "eu", "--size", "50"];
    const refusal = async (cwd: string, message: RegExp, code: string, extra: Record<string, string> = {}): Promise<void> => {
      const a = await run(cwd, line, extra);
      const e = (JSON.parse(a.stdout) as { error: { code: string; message: string; why?: string; fix?: string } }).error;
      assert.equal(a.code, 1, a.stdout);
      assert.equal(e.code, code, a.stdout);
      assert.match(e.message, message);
      assert.ok(!a.stdout.includes(PASSWORD) && !a.stdout.includes("not-a-url-secret"), a.stdout);
    };
    await refusal(home(), /^no Mason project here or above$/, "no_project");
    await refusal(project({ file: `kind: postgres\nurl: ${URL_}\ntables:\n  orders: {}\n` }), /^mason\/sources\/app\.yml: url: is written in the file$/, "refused");
    await refusal(project({ url: null }), /^mason\/sources\/app\.yml: url: \$\{DATABASE_URL\} is not set/, "bad_source");
    await refusal(project({ url: "not-a-url-secret" }), /^DATABASE_URL \(DATABASE_URL in \.env\) is not a database URL a replica can be made for$/, "refused");
    await refusal(project({ url: `mysql://u:${PASSWORD}@db.example/app` }), /is not a database URL a replica can be made for$/, "refused");
    // not signed in: the login's refusal, naming mason login
    const b = await runMason(root, ["replica", ...line, "--json"], envFor(home(), fake.url));
    assert.equal(b.code, 1);
    assert.match((JSON.parse(b.stdout) as { error: { message: string } }).error.message, /^this machine is not signed in to /);
    assert.deepEqual(fake.requests, [], "nothing was sent");
  } finally { await fake.close(); }
});

test("mason replica create: a creation not made says the service's words, its code the CLI's by the status, and the checks one line each — 422 the checks failed (mason doctor runs them here), 403 an account's first replica or a viewer (who may, and the web app), 409, 503, 429", async () => {
  const root = project();
  const failedChecks = [{ source: "app", outcome: "failed", checks: [{ name: "logical replication", status: "failed", detail: "wal_level is replica", fix: "set wal_level = logical" }], missing: ["the publication"] }];
  const cases: Array<[Reply, string, number, string[]]> = [
    [{ status: 422, body: { error: { code: "checks_failed", message: "the replica was not made: Mason's checks of the database failed", fix: "fix what the checks say, then create it again" }, next: [{ command: "mason destroy" }], failure: "failed", checks: failedChecks } },
      "refused", 1, ["mason doctor", "mason replica create acme/shop --region eu --size 50"]],
    [{ status: 403, body: { error: { code: "refused", message: "the replica was not made: your account has not passed the check that a person is asking yet", fix: "make your account's first replica in the web app" }, next: [] } },
      "refused", 1, ["mason login"]],
    [{ status: 409, body: { error: { code: "refused", message: "the token was revoked while the checks ran" }, next: [], failure: "refused", checks: [] } }, "refused", 1, ["mason replica create acme/shop --region eu --size 50"]],
    [{ status: 503, body: { error: { code: "checks_unknown", message: "Mason could not tell whether the source is ready" }, next: [], failure: "unknown", checks: [] }, headers: { "retry-after": "30" } }, "failed", 1, ["mason replica create acme/shop --region eu --size 50"]],
    [{ status: 404, body: { error: { code: "not_found", message: "there is no organisation acme" }, next: [] } }, "not_found", 1, ["mason replica list acme"]],
    [{ status: 429, body: { error: { code: "slow_down", message: "new replicas are started at most 10 an hour" }, next: [] } }, "refused", 1, ["mason replica create acme/shop --region eu --size 50"]],
  ];
  for (const [reply, code, exit, next] of cases) {
    const j = await hosted(() => reply, ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root });
    const v = JSON.parse(j.a.stdout) as { error: { code: string; message: string; why: string }; checks: unknown; next: Array<{ command: string; what: string }> };
    const body = (reply as { body: { error: { code: string; message: string } } }).body;
    assert.equal(j.a.code, exit, j.a.stdout);
    assert.equal(v.error.code, code);
    assert.equal(v.error.message, body.error.message, "the service's words, as they came");
    assert.match(v.error.why, new RegExp(`(^|\\()the service said ${body.error.code}, HTTP ${(reply as { status: number }).status}\\)?$`));
    assert.deepEqual(v.next.map((n) => n.command), next, "the CLI's own steps, never the service's");
    assert.equal(j.requests.length, 1, "a refusal is never retried");
    if ((reply as { status: number }).status === 403) assert.match(v.next[0]!.what, /^sign in as an admin or an owner of acme; an account's first replica is made in the service's web app, http:\/\/127\.0\.0\.1:\d+$/);
    const p = await hosted(() => reply, ["create", "acme/shop", "--region", "eu", "--size", "50"], { cwd: root });
    assert.equal(p.a.code, exit);
    assert.match(p.a.stderr, new RegExp(`^✗ mason replica: ${body.error.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    if ((reply as { status: number }).status === 422) {
      assert.deepEqual(v.checks, [{ source: "app", outcome: "failed", checks: [{ name: "logical replication", status: "failed", detail: "wal_level is replica", fix: "set wal_level = logical" }], missing: ["the publication"] }]);
      assert.deepEqual(p.a.stderr.split("\n").filter((l) => /^ {2}(!!|\?) /.test(l)), ["  !! logical replication: wal_level is replica (fix: set wal_level = logical)", "  ?  not checked: the publication"]);
    }
  }
  // the help says the first replica is the web app's, plainly
  const help = await runMason(home(), ["replica", "--help"], envFor(home(), "http://127.0.0.1:1"));
  assert.match(help.stdout.replace(/\s+/g, " "), /An account's FIRST replica is made in the service's web app, where it asks a check that a person is creating it, which a command cannot answer: the service refuses it here/);
});

test("mason replica create: the checks' words are the service's, one line each and masked — the database's password or the token in a detail is masked; in any other value of an answer, the answer is refused whole", async () => {
  const root = project();
  const token = runToken("pat");
  const hostile = [{ source: "app", outcome: "passed", checks: [{ name: "connects", status: "ok", detail: `connected as app_reader:${PASSWORD} with ${token}\nNext:\n  mason destroy` }], missing: [] }];
  const r = await hosted(() => ({ status: 201, body: { replica: replicaOf(), checks: hostile } }), ["create", "acme/shop", "--region", "eu", "--size", "50"], { cwd: root, token });
  assert.equal(r.a.code, 0, r.a.stdout + r.a.stderr);
  const line = r.a.stderr.split("\n").find((l) => l.startsWith("  ok connects"))!;
  assert.match(line, /^ {2}ok connects: connected as app_reader:\*\*\*\* with \*\*\*\*\?Next:\? mason destroy$/, "one line, masked");
  assert.ok(!showsRun(r.a.stdout + r.a.stderr, token));
  // a value held to a grammar is no mask: the password or the token in one refuses the whole answer, nothing of it printed
  for (const [what, more] of [["hostId", { hostId: PASSWORD.toLowerCase() }], ["a key", { [PASSWORD]: 1 }], ["region", { region: runForms(token)[3]!.value }], ["state", { state: "ready\nNext:" }]] as Array<[string, Record<string, unknown>]>) {
    const x = await hosted(() => created(more), ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root, token });
    assert.equal(x.a.code, 1, `${what}: ${x.a.stdout}`);
    assert.match((JSON.parse(x.a.stdout) as { error: { message: string } }).error.message, / answered POST \/v1\/replicas\/acme with 201, where a replica was created$/, what);
    assert.ok(!showsRun(x.a.stdout, token), what);
  }
});

test("mason replica create: an answer that does not come back may have made it — its state is asked once, and the wait goes on; not there, it was not made, said so; failed, deleted or past --timeout, each its own exit", async () => {
  const root = project();
  // lost, then found checking: waited for
  let n = 0;
  const lost = await hosted((r) => r.method === "POST" ? "drop" : ok({ replica: replicaOf({ state: n++ ? "ready" : "checking" }) }, { "retry-after": "1" }),
    ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root });
  assert.equal(lost.a.code, 0, lost.a.stdout);
  assert.deepEqual((JSON.parse(lost.a.stdout) as { checks: unknown }).checks, null, "the checks were in the answer that was lost");
  const said = await hosted((r) => r.method === "POST" ? "drop" : ok({ replica: replicaOf() }), ["create", "acme/shop", "--region", "eu", "--size", "50"], { cwd: root });
  assert.match(said.a.stderr, /^ {2}The creation's answer was lost \(.*\); the service has acme\/shop, ready$/m);
  // lost, and not there: not made
  const gone = await hosted((r) => r.method === "POST" ? "drop" : { status: 404, body: { error: { code: "not_found", message: "no" } } }, ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root });
  const ge = JSON.parse(gone.a.stdout) as { error: { code: string; why: string }; next: Array<{ command: string }> };
  assert.equal(gone.a.code, 1);
  assert.equal(ge.error.code, "failed");
  assert.match(ge.error.why, /asked since, the service has no such replica: it was not made$/);
  assert.deepEqual(ge.next.map((x) => x.command), ["mason replica status acme/shop", "mason replica create acme/shop --region eu --size 50"]);
  // its region could not make it
  const failedState = await hosted((r) => r.method === "POST" ? created({ state: "creating" }) : ok({ replica: replicaOf({ state: "failed", pending: [{ change: "create", state: "failed", attempts: 3, failure: "the machine did not start" }] }) }, { "retry-after": "1" }),
    ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root });
  const fe = JSON.parse(failedState.a.stdout) as { error: { code: string; message: string; why: string; fix: string }; replica: { state: string } };
  assert.equal(failedState.a.code, 1);
  assert.deepEqual([fe.error.code, fe.error.message, fe.error.why, fe.replica.state], ["failed", "acme/shop was not made: its region could not make it, after every attempt", "the machine did not start", "failed"]);
  // a 503 midway is a wait; past --timeout, 124, nothing stopped
  const slow = await hosted((r) => r.method === "POST" ? created({ state: "creating" }) : { status: 503, body: {}, headers: { "retry-after": "1" } },
    ["create", "acme/shop", "--region", "eu", "--size", "50", "--timeout", "2s", "--json"], { cwd: root });
  const se = JSON.parse(slow.a.stdout) as { error: { code: string; message: string; fix: string }; replica: { state: string } };
  assert.equal(slow.a.code, 124, slow.a.stdout);
  assert.deepEqual([se.error.code, se.error.message, se.replica.state], ["timeout", "acme/shop was not ready within 2s", "creating"]);
  assert.match(se.error.fix, /^nothing was stopped, and its region goes on making it: mason replica status acme\/shop says how it goes/);
  assert.ok(slow.requests.length >= 2, "it asked again after the 503");
});

test("mason replica list and status: the service's replicas, each value held, in the CLI's words; every organisation of the login when none is named; more said; a 404 not_found", async () => {
  const lists: Record<string, Reply> = {
    "/v1/replicas/acme": ok({ replicas: [replicaOf(), replicaOf({ name: "analytics", state: "creating", sizeGb: 100 })], more: true }),
    "/v1/replicas/beta": ok({ replicas: [], more: false }),
  };
  const v1 = (r: Req): Reply => lists[r.path] ?? (r.path === ONE ? ok({ replica: replicaOf({ allowlist: ["192.0.2.0/24", "2001:db8::/32"], pending: [{ change: "allowlist", state: "pending", attempts: 2, nextAttemptAt: AT }] }) })
    : { status: 404, body: { error: { code: "not_found", message: "there is no replica acme/nope this token can reach" } } });
  const one = await hosted(v1, ["list", "acme"]);
  assert.equal(one.a.code, 0, one.a.stderr);
  assert.deepEqual(one.requests.map((q) => q.path), ["/v1/replicas/acme"]);
  assert.match(one.a.stdout, /^2 replicas in acme, on http:\/\/127\.0\.0\.1:\d+\n {2}acme\/shop {8}ready {6}eu, 50 GB, host brisk-otter-4821\n {2}acme\/analytics {3}creating {3}eu, 100 GB, host brisk-otter-4821\n\nTip: acme has more replicas than the service lists at once/);
  // every organisation of the login (GET /v1/me): acme and beta
  const all = await hosted(v1, ["list", "--json"]);
  assert.equal(all.a.code, 0, all.a.stdout);
  assert.deepEqual(all.requests.map((q) => q.path), ["/v1/me", "/v1/replicas/acme", "/v1/replicas/beta"]);
  const v = JSON.parse(all.a.stdout) as { replicas: Array<{ name: string }>; more: boolean };
  assert.deepEqual([v.replicas.map((x) => x.name), v.more], [["shop", "analytics"], true]);
  // a login the service cannot say the organisations of (a CI token): its words, and the way out names one
  const ci = await hosted(v1, ["list", "--json"], { me: { status: 403, body: { error: { code: "refused", message: "a CI token is no person" } } } });
  assert.equal(ci.a.code, 1);
  assert.equal((JSON.parse(ci.a.stdout) as { next: Array<{ command: string }> }).next[0]!.command, "mason replica list <org>");
  // status
  const st = await hosted(v1, ["status", "acme/shop"]);
  assert.equal(st.a.code, 0, st.a.stderr);
  assert.match(st.a.stdout, /^acme\/shop on http:\/\/127\.0\.0\.1:\d+: ready\n {2}state {7}ready\n {2}region {6}eu\n {2}size {8}50 GB of synced data\n {2}host {8}brisk-otter-4821\n {2}created {5}2026-11-02T10:00:00\.000Z\n {2}allowlist {3}192\.0\.2\.0\/24, 2001:db8::\/32\n {2}pending {5}its allowlist is under way \(2 attempts, the next at 2026-11-02T10:00:00\.000Z\)\n/);
  const nope = await hosted(v1, ["status", "acme/nope", "--json"]);
  const ne = JSON.parse(nope.a.stdout) as { error: { code: string; message: string }; next: Array<{ command: string }> };
  assert.deepEqual([nope.a.code, ne.error.code, ne.error.message, ne.next[0]!.command], [1, "not_found", "there is no replica acme/nope this token can reach", "mason replica list acme"]);
  // an answer outside the contract: said by its status alone
  for (const bad of [{ replica: replicaOf({ name: "other" }) }, { replica: replicaOf({ state: "melting" }) }, { replica: replicaOf({ allowlist: ["anywhere"] }) }, { replica: replicaOf({ org: "beta" }) }, { replica: replicaOf({ sizeGb: "50" }) }]) {
    const x = await hosted(() => ok(bad), ["status", "acme/shop", "--json"]);
    assert.equal(x.a.code, 1, JSON.stringify(bad));
    assert.match((JSON.parse(x.a.stdout) as { error: { message: string } }).error.message, / answered GET \/v1\/replicas\/acme\/shop with 200, where a replica's state was asked for$/);
  }
});

test("mason replica, on a terminal of every width from 20 to 80: every line one the CLI begins, none the terminal broke", async () => {
  const root = project();
  for (const width of [20, 33, 47, 80]) {
    const a = await hosted(() => created({ hostId: `h-${"x".repeat(60)}` }), ["create", "acme/shop", "--region", "eu", "--size", "50"], { cwd: root, terminal: width });
    assert.equal(a.a.code, 0, a.a.stdout + a.a.stderr);
  }
});

test("the pure pieces: a replica held to its grammars, the free text kept out of the exact test, the URL's password decoded and held whatever its alphabet, one under MIN_PASSWORD not sent, the checks one line each", () => {
  assert.equal(heldReplica(replicaOf(), { org: "acme", name: "shop" }, [])?.hostId, "brisk-otter-4821");
  assert.equal(heldReplica(replicaOf({ pending: [{ change: "create", state: "pending", attempts: -1 }] }), { org: "acme" }, []), null);
  assert.equal(heldReplica(replicaOf({ createdAt: "yesterday" }), { org: "acme" }, []), null);
  // a pending change's failure and a check's words are free text: masked when printed, never what refuses the answer
  const j = { replica: replicaOf({ pending: [{ change: "create", state: "failed", attempts: 1, failure: `x ${PASSWORD}` }] }), checks: [{ source: "app", outcome: "passed", checks: [{ name: PASSWORD, status: "ok", detail: PASSWORD }], missing: [PASSWORD] }] };
  assert.equal(carriesNoSecret(wordless(j), [PASSWORD]), true);
  assert.equal(carriesNoSecret(wordless({ ...j, replica: replicaOf({ hostId: PASSWORD }) }), [PASSWORD]), false);
  assert.equal(MIN_PASSWORD, 8);
  assert.deepEqual(urlPassword(`postgres://u:${PASSWORD}@h/d`), { password: PASSWORD });
  assert.deepEqual(urlPassword("postgres://u:hunter2@h/d"), { short: 7 });
  assert.deepEqual(urlPassword("postgres://u:x@h/d"), { short: 1 });
  assert.deepEqual(urlPassword("postgres://u@h/d"), { password: null }, "no password: nothing to hold");
  assert.deepEqual(urlPassword("postgres://u:p%40ss%21wd%2A%2A@h/d"), { password: "p@ss!wd**" }, "decoded, every character counted");
  assert.deepEqual(urlPassword("postgres://u:ab%zzcdefgh@h/d"), { password: "ab%zzcdefgh" }, "a malformed escape: held as written, never dropped");
  assert.deepEqual(checkLines([{ source: "app", outcome: "unknown", checks: [{ name: "a", status: "unknown", detail: "b", fix: null }], missing: [] }]), ["Mason's checks of the database app names: unknown", "  ?  a: b"]);
});

/** Whether `text` shows `password` whole: as written, in any case, or %-encoded (as a URL writes it), or decoded from that. */
const showsPassword = (text: string, password: string): boolean => {
  const t = text.toLowerCase(), decoded = text.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))).toLowerCase();
  return [password, encodeURIComponent(password)].some((p) => t.includes(p.toLowerCase()) || decoded.includes(p.toLowerCase()));
};

test("the database's password is held by ONE rule at every boundary, whatever its length from 8 and its alphabet: echoed in a value held to a grammar (hostId, region, an allowlist entry, a key), in a check's words, a refusal's words or a pending change's failure — as written, re-cased or %-encoded — it is never printed whole; one under 8 is not sent (PR 660's review, B1)", { timeout: 600_000 }, async () => {
  const passwords = ["abcdefgh", "ab3def6hjk", "Zq8vLm2Xr7Tp", "!*!*!*!*!*!*!*!*!*!*!*a1", "!!!!!!!!!!!!!!!!ab", "pass word 1", "pässwörd99", "deadbeefcafe"];
  const forms = [(p: string) => p, (p: string) => p.toUpperCase(), (p: string) => encodeURIComponent(p)];
  const slots: Array<[string, (e: string) => Reply]> = [
    ["hostId", (e) => created({ hostId: e })],
    ["region", (e) => created({ region: e })],
    ["an allowlist entry", (e) => created({ allowlist: [`${e}/1`] })],
    ["a key", (e) => ({ status: 201, body: { replica: { ...replicaOf(), [e]: 1 }, checks: CHECKS } })],
    ["a check's detail", (e) => ({ status: 201, body: { replica: replicaOf(), checks: [{ ...CHECKS[0], checks: [{ name: "connects", status: "ok", detail: `connected with ${e}` }] }] } })],
    ["a check's name and missing", (e) => ({ status: 201, body: { replica: replicaOf(), checks: [{ ...CHECKS[0], checks: [{ name: e, status: "ok", detail: "x" }], missing: [e] }] } })],
    ["a refusal's words", (e) => ({ status: 403, body: { error: { code: "refused", message: `refused ${e}`, why: e, fix: `x${e}x` } } })],
    ["a pending change's failure", (e) => created({ pending: [{ change: "allowlist", state: "failed", attempts: 1, failure: `could not ${e}` }] })],
  ];
  let runs = 0;
  for (const [i, password] of passwords.entries()) {
    const root = project({ url: `postgres://app:${encodeURIComponent(password)}@db.example:5432/app` });
    for (const [j, [what, reply]] of slots.entries()) {
      const form = forms[(i + j) % forms.length]!;
      const json = (i + j) % 2 === 0 ? ["--json"] : [];
      const { a, requests } = await hosted(() => reply(form(password)), ["create", "acme/shop", "--region", "eu", "--size", "50", ...json], { cwd: root });
      runs++;
      assert.equal(JSON.parse(requests[0]!.body).sources[0].url, `postgres://app:${encodeURIComponent(password)}@db.example:5432/app`, "the URL is sent as it was read");
      assert.ok(!showsPassword(a.stdout + a.stderr, password), `${JSON.stringify(password)} in ${what} (${form("x") === "x" ? "as written" : form("x") === "X" ? "re-cased" : "encoded"}) was printed:\n${a.stdout}${a.stderr}`);
    }
  }
  assert.equal(runs, passwords.length * slots.length);
  // under 8 characters, whatever they are: refused before a byte is sent, its length said, never it
  for (const short of ["x", "ab3d", "!*!*a1", "hunter2"]) {
    const fake = await fakeService({ v1: () => created() });
    try {
      const a = await runMason(project({ url: `postgres://app:${encodeURIComponent(short)}@db.example:5432/app` }), ["replica", "create", "acme/shop", "--region", "eu", "--size", "50", "--json"], envFor(home(), fake.url, { MASON_TOKEN: newToken() }));
      const e = (JSON.parse(a.stdout) as { error: { code: string; message: string } }).error;
      assert.deepEqual([a.code, e.code], [1, "refused"], short);
      assert.equal(e.message, `the password in DATABASE_URL (DATABASE_URL in .env) is ${[...short].length} character${short.length === 1 ? "" : "s"} long, under the 8 this command sends`);
      assert.ok(!a.stdout.includes(short) || short === "x", short);
      assert.deepEqual(fake.requests, [], `${short}: nothing sent`);
    } finally { await fake.close(); }
  }
});

test("a replica's state answer carrying the token in a value its grammar takes — status, and a poll of create's wait — is refused whole by the exact test, said by its status (never left to the output's gate)", async () => {
  const token = runToken("pat");
  const carrying = runForms(token)[3]!.value;   // 11 of its body in a row, lower case: HOST_ID takes it
  const st = await hosted(() => ok({ replica: replicaOf({ hostId: carrying }) }), ["status", "acme/shop", "--json"], { token });
  assert.equal(st.a.code, 1, st.a.stdout);
  assert.equal((JSON.parse(st.a.stdout) as { error: { message: string } }).error.message.replace(/^http:\/\/127\.0\.0\.1:\d+/, "SERVICE"), "SERVICE answered GET /v1/replicas/acme/shop with 200, where a replica's state was asked for");
  const root = project();
  const poll = await hosted((r) => r.method === "POST" ? created({ state: "creating" }) : ok({ replica: replicaOf({ hostId: carrying }) }), ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root, token });
  assert.equal(poll.a.code, 1, poll.a.stdout);
  assert.match((JSON.parse(poll.a.stdout) as { error: { message: string } }).error.message, / answered GET \/v1\/replicas\/acme\/shop with 200, where a replica's state was asked for$/);
  assert.ok(!showsRun(st.a.stdout + st.a.stderr + poll.a.stdout + poll.a.stderr, token));
});

test("mason replica create allows the creation's POST more than another request's 15 s: an answer after 16 s is the answer, never a lost one", { timeout: 120_000 }, async () => {
  const root = project();
  const r = await hosted(async (q) => {
    if (q.method === "POST") { await new Promise((resolve) => setTimeout(resolve, 16_500)); return created(); }
    return { status: 404, body: { error: { code: "not_found", message: "no such replica" } } };
  }, ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root });
  assert.equal(r.a.code, 0, r.a.stdout);
  assert.deepEqual(r.requests.map((q) => q.method), ["POST"], "the POST's own answer, no GET after a lost one");
});

test("no run of mason replica printed a token or the database's password, nor put either on its command line", () => {
  assert.ok(ANSWERS.length >= 20, `the runs above are here (${ANSWERS.length})`);
  for (const a of ANSWERS) {
    for (const s of [...SECRETS, PASSWORD]) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s) && !a.argv.some((x) => x.includes(s)), `mason ${a.argv.join(" ")} printed a secret`);
    assert.doesNotMatch(a.stdout + a.stderr, /masondata_(pat|ci)_[A-Za-z0-9_-]{43}/, `mason ${a.argv.join(" ")}`);
  }
});
