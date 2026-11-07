/**
 * `mason replica create | list | status` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts: an http server of this
 * test's on 127.0.0.1, no network). The contract is docs/HOSTED-API.md "Replicas"; what each test holds is in its name.
 * Every run is held by `mason` to carrying no token, to no line a person sees begun by the service's text, and here to
 * carrying no part of the database's URL that is not printed on purpose (its password never).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS, envFor, fakeService, home, newToken, runForms, runToken, SECRETS, showsRun, type Reply, type Req } from "./hosted-fake.ts";
import { runMason, type Answer } from "./cli-matrix.ts";
import { AT, CHECKS, created, ENV_MARK, hosted, ok, ONE, PASSWORD, project, REPLICAS, replicaOf, URL_, URL_MARK } from "./replica-fake.ts";
import { checkLines, heldReplica, MIN_PASSWORD, ownWordsHold, urlPassword, wordless, type CreateRun } from "../src/cli/replica-hosted.ts";
import { carriesNoSecret } from "../src/cli/hosted.ts";

test("mason replica create: the URL is read from stdin (never .env: its value there is never read), sent once in the body beside the name of the variable the sources file names, never on the command line or printed; the checks are said one line each; the replica's state waited for until it is ready, and its page printed", async () => {
  const root = project();
  let polls = 0;
  const page = (r: Req): string => `http://${r.headers.host}/acme/replicas/shop`;
  const v1 = (r: Req): Reply => r.method === "POST" && r.path === REPLICAS ? created({ state: "creating", pending: [{ change: "create", state: "pending", attempts: 1, nextAttemptAt: AT }] })
    : r.method === "GET" && r.path === ONE ? ok({ replica: replicaOf({ state: polls++ ? "ready" : "creating", allowlist: polls > 1 ? ["192.0.2.0/24"] : [], page: page(r) }) }, { "retry-after": "1" })
    : { status: 404, body: { error: { code: "not_found", message: "no" } } };
  const { a, requests, token } = await hosted(v1, ["create", "acme/shop", "--region", "eu", "--size", "50"], { cwd: root });
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), ["POST /v1/replicas/acme", "GET /v1/replicas/acme/shop", "GET /v1/replicas/acme/shop"]);
  assert.deepEqual(JSON.parse(requests[0]!.body), { name: "shop", region: "eu", sizeGb: 50, sources: [{ name: "app", variable: "DATABASE_URL", url: URL_ }] });
  assert.equal(requests[0]!.headers.authorization, `Bearer ${token}`);
  assert.equal(requests[0]!.headers["content-type"], "application/json");
  for (const q of requests.slice(1)) assert.equal(q.body, "", "only the creation carries the URL");
  const base = a.stdout.match(/on (http:\/\/127\.0\.0\.1:\d+)/)![1]!;
  assert.equal(a.stdout, `Created acme/shop on ${base}: it is ready
  region      eu
  size        50 GB of synced data
  host        brisk-otter-4821
  created     ${AT}
  allowlist   192.0.2.0/24
  page        ${base}/acme/replicas/shop

Tip: Its allowlist, the addresses that may query it, is set on its page, above.
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
  assert.match(a.stderr, /^Creating acme\/shop on http:\/\/127\.0\.0\.1:\d+: Mason checks the database \(DATABASE_URL, its URL read from stdin\) from the replica's side, up to a minute$/m);
  assert.doesNotMatch(a.stderr, /not shown|Ctrl-C/, "stdin is a pipe: nothing is asked");
  assert.match(a.stderr, /^ {2}creating: its region is making it$/m);
  // --json: the replica and the checks, the URL nowhere
  const j = await hosted(() => created(), ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: root });
  assert.equal(j.a.code, 0, j.a.stdout);
  const v = JSON.parse(j.a.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(v), ["replica", "checks", "next"]);
  assert.deepEqual(v.replica, { ...replicaOf(), page: null, pending: [] });
  assert.deepEqual(v.checks, [{ source: "app", outcome: "passed", missing: [],
    checks: [{ name: "connects", status: "ok", detail: "Postgres 16 answers", fix: null }, { name: "the role", status: "warn", detail: "it may write to a synced table", fix: "a role that only reads" }] }]);
  assert.equal(j.a.stderr, "", "--json prints no progress");
  assert.ok(!j.a.stdout.includes(URL_MARK), "nothing of the URL is in --json");
  // with no .env at all, and stdin the URL ending in \r\n (a file written on Windows): the same body
  const bare = await hosted(() => created(), ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: project({ env: null }), stdin: `${URL_}\r\n` });
  assert.equal(bare.a.code, 0, bare.a.stdout);
  assert.equal(JSON.parse(bare.requests[0]!.body).sources[0].url, URL_);
  // DATABASE_URL in the shell is not read either
  const shell = await hosted(() => created(), ["create", "acme/shop", "--region", "eu", "--size", "50", "--json"], { cwd: project({ env: null }), env: { DATABASE_URL: `postgres://shell:${ENV_MARK}xx@h/d` } });
  assert.equal(JSON.parse(shell.requests[0]!.body).sources[0].url, URL_);
});

test("mason replica create: what is refused here, before a byte is sent — a wrong line (exit 2), no project, a url: written in the file, stdin empty, more than one line, past 2 KiB or not a database URL, not signed in", async () => {
  const fake = await fakeService({ v1: () => created() });
  try {
    const run = (cwd: string, argv: string[], extra: Record<string, string> = {}, stdin = URL_): Promise<Answer> =>
      runMason(cwd, ["replica", ...argv, "--json"], envFor(home(), fake.url, { MASON_TOKEN: newToken(), ...extra }), 60_000, undefined, stdin);
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
    const refusal = async (cwd: string, message: RegExp, code: string, stdin = URL_): Promise<void> => {
      const a = await run(cwd, line, {}, stdin);
      const e = (JSON.parse(a.stdout) as { error: { code: string; message: string; why?: string; fix?: string } }).error;
      assert.equal(a.code, 1, a.stdout);
      assert.equal(e.code, code, a.stdout);
      assert.match(e.message, message);
      assert.ok(!a.stdout.includes(PASSWORD) && !a.stdout.includes("not-a-url-secret") && !a.stdout.includes(URL_MARK), a.stdout);
    };
    await refusal(home(), /^no Mason project here or above$/, "no_project");
    await refusal(project({ file: `kind: postgres\nurl: ${URL_}\ntables:\n  orders: {}\n` }), /^mason\/sources\/app\.yml: url: is written in the file$/, "refused");
    await refusal(project(), /^stdin was empty: no URL was given, and nothing was sent$/, "refused", "");
    await refusal(project(), /^stdin was empty: no URL was given, and nothing was sent$/, "refused", "\n");
    await refusal(project(), /^stdin holds more than one line: nothing was sent$/, "refused", `${URL_}\n${URL_}\n`);
    await refusal(project(), /^the database's URL read from stdin is longer than 2048 bytes: nothing was sent$/, "refused", `postgres://u:${PASSWORD}@h/${"d".repeat(3000)}`);
    await refusal(project(), /^the URL given for DATABASE_URL \(read from stdin\) is not a database URL a replica can be made for$/, "refused", "not-a-url-secret");
    await refusal(project(), /^the URL given for DATABASE_URL \(read from stdin\) is not a database URL a replica can be made for$/, "refused", `mysql://u:${PASSWORD}@db-${URL_MARK}.example/app`);
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

test("mason replica status and list name their target as every hosted command does: the argument, --replica or MASON_REPLICA (said on stderr), --org; one named twice, or a flag of another verb, is a wrong line", async () => {
  const v1 = (r: Req): Reply => r.path === ONE ? ok({ replica: replicaOf() }) : r.path === REPLICAS ? ok({ replicas: [replicaOf()], more: false })
    : { status: 404, body: { error: { code: "not_found", message: "no" } } };
  const fake = await fakeService({ v1 });
  try {
    const token = newToken();
    const run = async (argv: string[], extra: Record<string, string> = {}): Promise<{ a: Answer; paths: string[] }> => {
      const before = fake.requests.length;
      const a = await runMason(home(), ["replica", ...argv, "--json"], envFor(home(), fake.url, { MASON_TOKEN: token, ...extra }));
      return { a, paths: fake.requests.slice(before).map((q) => q.path).filter((p) => p.startsWith("/v1/")) };
    };
    const SAID = "using MASON_REPLICA=acme/shop (--replica names another; unset MASON_REPLICA for none)\n";
    for (const [argv, extra, said] of [[["status", "acme/shop"], {}, ""], [["status", "--replica", "acme/shop"], {}, ""], [["status", "acme/shop", "--replica", "acme/shop"], {}, ""],
      [["status"], { MASON_REPLICA: "acme/shop" }, SAID], [["status", "acme/shop"], { MASON_REPLICA: "other/one" }, ""], [["status", "--replica", "acme/shop"], { MASON_REPLICA: "other/one" }, ""]] as Array<[string[], Record<string, string>, string]>) {
      const { a, paths } = await run(argv, extra);
      assert.equal(a.code, 0, `${argv.join(" ")}: ${a.stdout}${a.stderr}`);
      assert.deepEqual(paths, [ONE], argv.join(" "));
      assert.equal((JSON.parse(a.stdout) as { replica: { name: string } }).replica.name, "shop");
      assert.equal(a.stderr, said, argv.join(" "));
    }
    const org = await run(["list", "--org", "acme"]);
    assert.deepEqual([org.a.code, org.paths], [0, [REPLICAS]], org.a.stdout);
    for (const [argv, message] of [[["status", "acme/shop", "--replica", "acme/other"], "the replica is named twice: acme/shop and --replica acme/other"],
      [["list", "acme", "--org", "beta"], "the organisation is named twice: acme and --org beta"], [["list", "--org", "Acme"], 'the organisation "Acme" is not an organisation\'s slug'],
      [["status", "--replica", "acme"], '--replica "acme" is not <org>/<name>'], [["list", "--replica", "acme/shop"], "--replica goes with mason replica create and status"],
      [["status", "acme/shop", "--org", "acme"], "--org goes with mason replica list"]] as Array<[string[], string]>) {
      const { a, paths } = await run(argv);
      assert.equal(a.code, 2, `${argv.join(" ")}: ${a.stdout}`);
      const e = (JSON.parse(a.stdout) as { error: { code: string; message: string } }).error;
      assert.deepEqual([e.code, e.message], ["usage", message], argv.join(" "));
      assert.deepEqual(paths, [], argv.join(" "));
    }
  } finally { await fake.close(); }
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
  assert.deepEqual(urlPassword("postgres://u:hunter2@h/d"), { short: true });
  assert.deepEqual(urlPassword("postgres://u:x@h/d"), { short: true });
  assert.deepEqual(urlPassword(`postgres://u:${"%20".repeat(8)}@h/d`), { short: true }, "eight spaces read as nothing");
  assert.deepEqual(urlPassword(`postgres://u:${encodeURIComponent("a\u200bb\u200bc\u200bd\u200be\u200bf\u200bg")}@h/d`), { short: true }, "zero-width marks read as nothing: 7 characters");
  assert.deepEqual(urlPassword("postgres://u@h/d"), { password: null }, "no password: nothing to hold");
  assert.deepEqual(urlPassword("postgres://u:p%40ss%21wd%2A%2A@h/d"), { password: "p@ss!wd**" }, "decoded, every character counted");
  assert.deepEqual(urlPassword("postgres://u:ab%zzcdefgh@h/d"), { password: "ab%zzcdefgh" }, "a malformed escape: held as written, never dropped");
  assert.deepEqual(checkLines([{ source: "app", outcome: "unknown", checks: [{ name: "a", status: "unknown", detail: "b", fix: null }], missing: [] }]), ["Mason's checks of the database app names: unknown", "  ?  a: b"]);
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

test("the CLI's own words of every honest create — made and ready, waited for, refused with checks, refused — hold no password the rule would send: every window of what was printed that is the CLI's own, taken as a password, is refused before sending (PR 660's review, R2-B2)", { timeout: 300_000 }, async () => {
  const root = project();
  let polls = 0;
  const honest: Array<[string, (r: Req) => Reply]> = [
    ["made, waited for, ready", (r) => r.method === "POST" ? created({ state: "creating" }) : polls++ % 2 ? ok({ replica: replicaOf() }) : { status: 503, body: {}, headers: { "retry-after": "1" } }],
    ["refused with its checks", () => ({ status: 422, body: { error: { code: "checks_failed", message: "#" }, failure: "failed", checks: CHECKS } })],
    ["refused: the first replica", () => ({ status: 403, body: { error: { code: "refused", message: "#", fix: "#" } } })],
    ["lost, then found", (r) => r.method === "POST" ? "drop" : ok({ replica: replicaOf() })],
  ];
  // what the fake sent, said as a placeholder: the windows are the CLI's own words alone
  // (and the system's words for an answer that did not come, which are masked as a service's are, never the CLI's own)
  const theirs = [/brisk-otter-4821/g, /2026-11-02T10:00:00\.000Z/g, /Postgres 16 answers|it may write to a synced table|a role that only reads|the role|connects/g,
    /(?<=The creation's answer was lost \()[^)]*/g];
  const windows = new Set<string>();
  let runs = 0;
  for (const [, v1] of honest) for (const json of [[], ["--json"]]) {
    const { a, url } = await hosted(v1, ["create", "acme/shop", "--region", "eu", "--size", "50", ...json], { cwd: root });
    runs++;
    const run: CreateRun = { r: { org: "acme", name: "shop", from: "argument" }, region: "eu", sizeGb: 50, timeout: { every: "15m", seconds: 900 }, base: url, variable: "DATABASE_URL", from: "read from stdin", source: "app" };
    let text = `${a.stderr}\n${a.stdout}`;
    for (const re of theirs) text = text.replace(re, "#");
    for (const line of text.split("\n")) for (let i = 0; i + 11 <= line.length; i += 5) {
      const w = line.slice(i, i + 11);
      if (!w.includes("#") && w.replace(/[^A-Za-z0-9]/g, "").length >= 8) windows.add(JSON.stringify([w, run]));
    }
  }
  assert.equal(runs, honest.length * 2);
  assert.ok(windows.size > 100, `${windows.size} windows`);
  const sent = [...windows].map((x) => JSON.parse(x) as [string, CreateRun]).filter(([w, run]) => !ownWordsHold(w, run)).map(([w]) => w);
  assert.deepEqual(sent, [], "each would have been sent, and an honest run of it refused by the gate");
});

test("no run of mason replica printed a token or the database's password, nor put either on its command line", () => {
  assert.ok(ANSWERS.length >= 20, `the runs above are here (${ANSWERS.length})`);
  for (const a of ANSWERS) {
    for (const s of [...SECRETS, PASSWORD]) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s) && !a.argv.some((x) => x.includes(s)), `mason ${a.argv.join(" ")} printed a secret`);
    assert.doesNotMatch(a.stdout + a.stderr, /masondata_(pat|ci)_[A-Za-z0-9_-]{43}/, `mason ${a.argv.join(" ")}`);
  }
});
