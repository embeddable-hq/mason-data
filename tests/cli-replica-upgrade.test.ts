/**
 * `mason replica upgrade` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts: an http server of this test's on
 * 127.0.0.1, no network), and a replica's Mason (`Replica.mason`) as `mason replica status` says it. The contract is
 * docs/HOSTED-API.md `POST /v1/replicas/{org}/{name}/upgrade` and `Replica`; what each test holds is in its name. Every
 * run is held by `mason` to carrying no token and to no line a person sees begun by the service's text (issue 764).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS, envFor, fakeService, home, newToken, SECRETS, type Lines, type Reply, type Req } from "./hosted-fake.ts";
import { runMason } from "./cli-matrix.ts";
import { AT, hosted, LINES, ok, ONE, replicaOf } from "./replica-fake.ts";
import * as replicaHosted from "../src/cli/replica-hosted.ts";

// by the module, so the file loads where src/ has none of these yet (scripts/fails-without.ts), each test failing by name
const { heldMason, heldReplica } = replicaHosted as unknown as { heldMason?: (v: unknown) => unknown; heldReplica: (v: unknown, asked: { org: string; name?: string }, secrets: readonly string[]) => unknown };

const OWN_STEP = /^ {2}(mason login|mason replica (create|list|status|upgrade|--help)( \S+)*|mason (deploy|token create) --replica acme\/shop)(\s|$)/;
const UPGRADE_LINES: Lines = {
  heads: [...LINES.heads, "Upgraded ", "Upgrading ", "Nothing to upgrade: ", "> ", "  its upgrade is under way ", "  ready", "Tip: Mason ", "  mason "],
  steps: ["  mason login", "  mason replica ", "  mason deploy ", "  mason token "], ownStep: OWN_STEP, row: LINES.row!,
};
const run = (v1: (r: Req) => Reply | Promise<Reply>, argv: string[], o: Parameters<typeof hosted>[2] = {}) =>
  hosted(v1, ["upgrade", "acme/shop", ...argv], { lines: UPGRADE_LINES, ...o });

const UPGRADE = `${ONE}/upgrade`;
const under = (attempts = 0) => ({ change: "upgrade", state: "pending", attempts, nextAttemptAt: null });
const answer = (status: 200 | 202, replica: Record<string, unknown>): Reply => ({ status, body: { replica }, headers: { "retry-after": "1" } });
const service = (a: { stdout: string; stderr: string }): string => (a.stdout + a.stderr).match(/http:\/\/127\.0\.0\.1:\d+/)![0];

test("mason replica upgrade --yes: the POST carries the CLI's version; the replica is asked for until it carries no upgrade and is ready, said as it goes; exit 0, the Mason it runs said; --json { replica, already, next }", async () => {
  let polls = 0;
  const before = { version: "0.8.1", latest: "0.8.3" };
  const v1 = (r: Req): Reply => r.method === "POST" ? answer(202, replicaOf({ pending: [under()], mason: before }))
    : polls++ === 0 ? ok({ replica: replicaOf({ pending: [under(1)], mason: before }) }, { "retry-after": "1" })
    : ok({ replica: replicaOf({ mason: { version: "0.8.3", latest: "0.8.3" } }) });
  const { a, requests, token } = await run(v1, ["--yes"]);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), [`POST ${UPGRADE}`, `GET ${ONE}`, `GET ${ONE}`]);
  assert.equal(requests[0]!.body, JSON.stringify({ client: { version: "dev" } }));
  assert.equal(requests[0]!.headers["content-type"], "application/json");
  assert.equal(requests[0]!.headers.authorization, `Bearer ${token}`);
  const base = service(a);
  assert.equal(a.stdout, `Upgraded acme/shop on ${base}: it runs Mason 0.8.3
  state       ready
  region      eu
  size        50 GB of synced data
  host        brisk-otter-4821
  created     ${AT}
  allowlist   none: no address may query it yet
  mason       0.8.3, the newest the service offers

Next:
  mason deploy --replica acme/shop              send this project to it
  mason token create --replica acme/shop        a CI token for it
`);
  assert.equal(a.stderr, `Upgrading acme/shop on ${base}: waiting up to 15m for it to be done
  its upgrade is under way (0 attempts)
  its upgrade is under way (1 attempt)
`);
  polls = 0;
  const j = await run(v1, ["--yes", "--json"]);
  assert.equal(j.a.code, 0, j.a.stdout);
  assert.equal(j.a.stderr, "");
  const v = JSON.parse(j.a.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(v), ["replica", "already", "next"]);
  assert.equal(v.already, false);
  assert.deepEqual(v.replica, { ...replicaOf(), page: null, mason: { version: "0.8.3", latest: "0.8.3", next: null } });
});

test("mason replica upgrade to a newer release line: the version installed is said, and what starts it — a deploy of a project pinned to its line", async () => {
  const done = replicaOf({ mason: { version: "0.8.3", latest: "0.9.0", next: "0.9.0" } });
  const v1 = (r: Req): Reply => r.method === "POST" ? answer(202, replicaOf({ pending: [under()], mason: { version: "0.8.3", latest: "0.9.0" } })) : ok({ replica: done });
  const { a } = await run(v1, ["--yes"]);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /^Upgraded acme\/shop on http:\/\/127\.0\.0\.1:\d+: Mason 0\.9\.0 is installed, and starts with the first deploy pinned to 0\.9\.x$/m);
  assert.match(a.stdout, /^ {2}mason {7}0\.8\.3; 0\.9\.0 installed, which starts with the first deploy pinned to 0\.9\.x; the newest the service offers$/m);
  assert.match(a.stdout, /^Tip: Mason 0\.9\.0 starts with the first mason deploy of a project pinned to 0\.9\.x: .* npx @mason-data\/cli@0\.9\.0\), then mason deploy --replica acme\/shop; until then the replica runs 0\.8\.3, and a project pinned to 0\.8\.x as before$/m);
});

test("mason replica upgrade: the newest already (200) is said at once, no poll, already: true; a service that says no version is said without one", async () => {
  const { a, requests } = await run(() => answer(200, replicaOf({ mason: { version: "0.8.3", latest: "0.8.3" } })), ["--yes", "--json"]);
  assert.equal(a.code, 0, a.stdout);
  assert.deepEqual(requests.map((q) => q.method), ["POST"]);
  assert.equal((JSON.parse(a.stdout) as { already: boolean }).already, true);
  const person = await run(() => answer(200, replicaOf()), ["--yes"]);
  assert.equal(person.a.code, 0, person.a.stderr);
  assert.match(person.a.stdout, /^Nothing to upgrade: acme\/shop on http:\/\/127\.0\.0\.1:\d+ has the newest Mason the service offers$/m);
  assert.doesNotMatch(person.a.stdout, /^ {2}mason {7}/m);
});

test("mason replica upgrade: its upgrade failed is exit 1 with the service's words; past --timeout 124, nothing stopped; gone midway not_found; a wait on what cannot say; a POST with no answer is never sent again", async () => {
  const failed = await run((r) => r.method === "POST" ? answer(202, replicaOf({ pending: [under()] }))
    : ok({ replica: replicaOf({ pending: [{ change: "upgrade", state: "failed", attempts: 3, failure: "the new version did not start" }] }) }), ["--yes", "--json"]);
  assert.equal(failed.a.code, 1, failed.a.stdout);
  const fe = (JSON.parse(failed.a.stdout) as { error: { code: string; message: string; why: string } }).error;
  assert.deepEqual([fe.code, fe.message, fe.why], ["failed", "acme/shop was not upgraded: its upgrade failed", "the new version did not start"]);

  const slow = await run((r) => r.method === "POST" ? answer(202, replicaOf({ pending: [under()] })) : ok({ replica: replicaOf({ pending: [under()] }) }, { "retry-after": "1" }), ["--yes", "--timeout", "2", "--json"]);
  assert.equal(slow.a.code, 124, slow.a.stdout);
  assert.deepEqual((JSON.parse(slow.a.stdout) as { next: Array<{ command: string }> }).next.map((n) => n.command), ["mason replica status acme/shop"]);

  const gone = await run((r) => r.method === "POST" ? answer(202, replicaOf({ pending: [under()] })) : { status: 404, body: { error: { code: "not_found", message: "no such replica" } } }, ["--yes", "--json"]);
  assert.equal(gone.a.code, 1);
  assert.equal((JSON.parse(gone.a.stdout) as { error: { code: string } }).error.code, "not_found");

  let n = 0;
  const unsure = await run((r) => r.method === "POST" ? answer(202, replicaOf({ pending: [under()] }))
    : n++ === 0 ? { status: 503, body: { error: { code: "unavailable", message: "busy" } }, headers: { "retry-after": "1" } } : ok({ replica: replicaOf() }), ["--yes"]);
  assert.equal(unsure.a.code, 0, unsure.a.stderr);
  assert.match(unsure.a.stderr, /^ {2}its upgrade is under way \(0 attempts\); the service could not say more just now \(GET \/v1\/replicas\/acme\/shop answered 503\): asking again$/m);

  const lost = await run(() => "drop", ["--yes", "--json"]);
  assert.equal(lost.a.code, 1, lost.a.stdout);
  assert.deepEqual(lost.requests.map((q) => q.method), ["POST"], "never sent again, never guessed");
  const le = JSON.parse(lost.a.stdout) as { error: { why: string }; next: Array<{ command: string }> };
  assert.match(le.error.why, /; whether its upgrade began is not known$/);
  assert.deepEqual(le.next.map((x) => x.command), ["mason replica status acme/shop", "mason replica upgrade acme/shop"]);
});

test("mason replica upgrade: a refusal is the service's words, its code the CLI's by the status, its next step the CLI's — a CI token or a role below owner, who may; not ready or busy, its status; 404, the organisation's replicas", async () => {
  const cases: Array<[Reply, string, string, RegExp]> = [
    [{ status: 403, body: { error: { code: "refused", message: "only an owner of acme upgrades a replica" }, next: [{ command: "mason destroy" }] } }, "refused", "mason login", /an owner upgrades a replica \(a CI token upgrades none\)$/],
    [{ status: 409, body: { error: { code: "busy", message: "a deploy is under way" } } }, "refused", "mason replica status acme/shop", /it upgrades once it is ready, and no other change of it is under way$/],
    [{ status: 409, body: { error: { code: "refused", message: "the replica is not ready" } } }, "refused", "mason replica status acme/shop", /once it is ready/],
    [{ status: 404, body: { error: { code: "not_found", message: "no such replica" } } }, "not_found", "mason replica list acme", /replicas/],
    [{ status: 429, body: { error: { code: "slow_down", message: "too many" } }, headers: { "retry-after": "30" } }, "refused", "mason replica upgrade acme/shop", /^again after .* \(in 30 s\)/],
  ];
  for (const [reply, code, step, what] of cases) {
    const { a, requests } = await run(() => reply, ["--yes", "--json"]);
    assert.equal(a.code, 1, `${reply !== "drop" && reply.status}: ${a.stdout}`);
    assert.deepEqual(requests.map((q) => q.method), ["POST"]);
    const v = JSON.parse(a.stdout) as { error: { code: string; message: string }; next: Array<{ command: string; what: string }> };
    assert.equal(v.error.code, code);
    assert.deepEqual(v.next.map((x) => x.command), [step]);
    assert.match(v.next[0]!.what, what);
  }
});

test("mason replica upgrade: an answer outside the contract is refused whole — a 202 carrying no upgrade under way, a 200 carrying one, a mason that does not hold — said by its status, nothing of it printed", async () => {
  for (const [what, reply] of [["202 without an upgrade", answer(202, replicaOf())], ["200 with one under way", answer(200, replicaOf({ pending: [under()] }))],
    ["a version not x.y.z", answer(202, replicaOf({ pending: [under()], mason: { version: "FORGED", latest: "0.8.3" } }))]] as Array<[string, Reply]>) {
    const { a, requests } = await run(() => reply, ["--yes", "--json"]);
    assert.equal(a.code, 1, `${what}: ${a.stdout}`);
    assert.match((JSON.parse(a.stdout) as { error: { message: string } }).error.message, /answered POST \/v1\/replicas\/acme\/shop\/upgrade with 20[02], where a replica's upgrade was asked for$/, what);
    assert.deepEqual(requests.map((q) => q.method), ["POST"], what);
    assert.doesNotMatch(a.stdout, /FORGED/);
  }
});

test("a replica's Mason, held: version and latest x.y.z, latest not older; next null or newer than version and not newer than latest; absent or null is none (an older service); anything else refuses the replica whole", () => {
  assert.ok(heldMason, "heldMason is exported");
  assert.equal(heldMason!(undefined), undefined);
  assert.equal(heldMason!(null), undefined);
  assert.deepEqual(heldMason!({ version: "0.8.1", latest: "0.9.0" }), { version: "0.8.1", latest: "0.9.0", next: null });
  assert.deepEqual(heldMason!({ version: "0.8.1", latest: "0.9.0", next: "0.9.0" }), { version: "0.8.1", latest: "0.9.0", next: "0.9.0" });
  for (const bad of ["0.8.1", [], { version: "0.8.1" }, { version: "v0.8.1", latest: "0.8.1" }, { version: "0.8.1 ", latest: "0.8.1" }, { version: "0.8", latest: "0.8.1" },
    { version: "0.8.1", latest: "0.8.0" }, { version: "0.8.1", latest: "0.9.0", next: "0.8.1" }, { version: "0.8.1", latest: "0.9.0", next: "0.9.1" },
    { version: "0.8.1", latest: "0.9.0", next: 9 }, { version: "01.8.1", latest: "1.8.1" }, { version: "0.8.1-rc1", latest: "0.8.1" }]) {
    assert.equal(heldMason!(bad), null, JSON.stringify(bad));
    assert.equal(heldReplica(replicaOf({ mason: bad }), { org: "acme" }, []), null, `the replica: ${JSON.stringify(bad)}`);
  }
  assert.notEqual(heldReplica(replicaOf({ pending: [under()] }), { org: "acme" }, []), null, "a pending upgrade is a change of the contract's");
});

test("mason replica status says the Mason a replica runs, and names mason replica upgrade while the service offers a newer one; a pending upgrade is said; no mason key, no row", async () => {
  const offered = await hosted(() => ok({ replica: replicaOf({ mason: { version: "0.8.1", latest: "0.8.3" } }) }), ["status", "acme/shop"], { lines: UPGRADE_LINES });
  assert.equal(offered.a.code, 0, offered.a.stderr);
  assert.match(offered.a.stdout, /^ {2}mason {7}0\.8\.1; the newest the service offers is 0\.8\.3$/m);
  assert.match(offered.a.stdout, /^ {2}mason replica upgrade acme\/shop +move it to Mason 0\.8\.3$/m);
  const pending = await hosted(() => ok({ replica: replicaOf({ pending: [under(2)], mason: { version: "0.8.1", latest: "0.8.3" } }) }), ["status", "acme/shop", "--json"], { lines: UPGRADE_LINES });
  assert.equal(pending.a.code, 0, pending.a.stdout);
  const v = JSON.parse(pending.a.stdout) as { replica: { pending: Array<{ change: string }>; mason: unknown }; next: Array<{ command: string }> };
  assert.equal(v.replica.pending[0]!.change, "upgrade");
  assert.ok(!v.next.some((n) => n.command.includes("upgrade")), "no upgrade named while one is under way");
  const personPending = await hosted(() => ok({ replica: replicaOf({ pending: [under(2)] }) }), ["status", "acme/shop"], { lines: UPGRADE_LINES });
  assert.match(personPending.a.stdout, /^ {2}pending {5}its upgrade is under way \(2 attempts\)$/m);
  const none = await hosted(() => ok({ replica: replicaOf() }), ["status", "acme/shop", "--json"], { lines: UPGRADE_LINES });
  assert.equal((JSON.parse(none.a.stdout) as { replica: { mason: unknown } }).replica.mason, null);
});

test("mason replica upgrade at a terminal: the replica's name typed back exactly upgrades it, anything else nothing; no terminal and no --yes is a wrong line (exit 2), nothing sent", async () => {
  const v1 = (): Reply => answer(200, replicaOf());
  const typed = await run(v1, [], { terminal: 80, input: "acme/shop\n" });
  assert.equal(typed.a.code, 0, typed.a.stdout + typed.a.stderr);
  assert.deepEqual(typed.requests.map((q) => q.method), ["POST"]);
  assert.match(typed.a.stderr.replace(/\n {4}/g, " "), /^Upgrading acme\/shop on http:\/\/127\.0\.0\.1:\d+ moves it to the newest Mason the service offers, and restarts Mason on it: every connection to it drops, and queries are refused until it is back\. Type acme\/shop to upgrade it, anything else to keep it as it is\.$/m);
  for (const input of ["acme/other\n", "ACME/SHOP\n", ""]) {
    const { a, requests } = await run(v1, [], { terminal: 80, input });
    assert.equal(a.code, 1, `${JSON.stringify(input)}: ${a.stderr}`);
    assert.deepEqual(requests, [], `${JSON.stringify(input)}: nothing sent`);
    assert.match(a.stderr, /^(> )?✗ mason replica: acme\/shop was not upgraded: what was typed is not its name$/m);
    assert.ok(!(a.stdout + a.stderr).includes("acme/other"));
  }
  const fake = await fakeService({ v1 });
  try {
    for (const argv of [[], ["--json"]]) {
      const a = await runMason(home(), ["replica", "upgrade", "acme/shop", ...argv], envFor(home(), fake.url, { MASON_TOKEN: newToken() }));
      assert.equal(a.code, 2, a.stdout + a.stderr);
      if (argv.length) assert.deepEqual((JSON.parse(a.stdout) as { error: { message: string; fix: string } }).error.fix, "say it on the line: mason replica upgrade acme/shop --yes");
    }
    assert.deepEqual(fake.requests, [], "nothing was sent");
  } finally { await fake.close(); }
});

test("mason replica upgrade: a wrong line is exit 2 before a byte is sent — no replica, two, --timeout that is none, --region; --yes and --timeout still refuse where they do not go", async () => {
  for (const argv of [["upgrade"], ["upgrade", "acme"], ["upgrade", "acme/shop", "x", "--yes"], ["upgrade", "acme/shop", "--yes", "--timeout", "soon"], ["upgrade", "acme/shop", "--yes", "--size", "50"],
    ["status", "acme/shop", "--yes"], ["list", "--timeout", "1m"]]) {
    const { a, requests } = await hosted(() => answer(200, replicaOf()), [...argv, "--json"], { lines: UPGRADE_LINES });
    assert.equal(a.code, 2, `${argv.join(" ")}: ${a.stdout}`);
    assert.deepEqual(requests, [], argv.join(" "));
  }
  const near = await hosted(() => answer(200, replicaOf()), ["upgrad", "acme/shop", "--json"], { lines: UPGRADE_LINES });
  assert.match((JSON.parse(near.a.stdout) as { error: { message: string } }).error.message, /did you mean `upgrade`\?/);
});

test("mason replica upgrade and status, on a terminal of every width from 20 to 80: every line one the CLI begins, none the terminal broke", async () => {
  const done = replicaOf({ mason: { version: "0.8.3", latest: "0.9.0", next: "0.9.0" } });
  const v1 = (r: Req): Reply => r.method === "POST" ? answer(202, replicaOf({ pending: [under()], mason: { version: "0.8.3", latest: "0.9.0" } })) : ok({ replica: done });
  for (const width of [20, 33, 47, 80]) {
    const { a } = await run(v1, ["--yes"], { terminal: width });
    assert.equal(a.code, 0, `${width}: ${a.stderr}`);
    const s = await hosted(() => ok({ replica: replicaOf({ pending: [under(2)], mason: { version: "0.8.1", latest: "0.9.0" } }) }), ["status", "acme/shop"], { lines: UPGRADE_LINES, terminal: width });
    assert.equal(s.a.code, 0, `${width}: ${s.a.stderr}`);
  }
});

test("no run of mason replica upgrade printed a token, nor put one on its command line", () => {
  assert.ok(ANSWERS.length >= 20, `the runs above are here (${ANSWERS.length})`);
  for (const a of ANSWERS) {
    for (const s of SECRETS) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s) && !a.argv.some((x) => x.includes(s)), `mason ${a.argv.join(" ")} printed a secret`);
    assert.doesNotMatch(a.stdout + a.stderr, /masondata_(pat|ci)_[A-Za-z0-9_-]{43}/, `mason ${a.argv.join(" ")}`);
  }
});
