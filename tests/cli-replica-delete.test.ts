/**
 * `mason replica delete` AGAINST A FAKE HOSTED SERVICE (tests/hosted-fake.ts: an http server of this test's on
 * 127.0.0.1, no network), and `mason replica status` of a replica being deleted. The contract is docs/HOSTED-API.md
 * `DELETE /v1/replicas/{org}/{name}`; what each test holds is in its name. Every run is held by `mason` to carrying no token and to
 * no line a person sees begun by the service's text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ANSWERS, envFor, fakeService, home, newToken, runForms, runToken, SECRETS, showsRun, type Lines, type Reply, type Req } from "./hosted-fake.ts";
import { runMason } from "./cli-matrix.ts";
import { AT, hosted, LINES, ok, ONE, replicaOf } from "./replica-fake.ts";
import * as replicaHosted from "../src/cli/replica-hosted.ts";
import type { DeletionSource } from "../src/cli/replica-hosted.ts";
import * as replicationMode from "../src/cli/replication-mode.ts";
import { carriesNoSecret } from "../src/cli/hosted.ts";

// by the modules, so the file loads where src/ has none of these yet (scripts/fails-without.ts), each test failing by name
const { byHandOf, heldDeletion, PG_NAME, REASONS, wordless } = replicaHosted;
const { dropStatements, listSlotsStatement } = replicationMode;

const LATER = "2026-11-02T10:05:00.000Z";
/** The lines mason replica delete begins, beside mason replica's own; its statements by hand, written unbroken. */
const OWN_STEP = /^ {2}(mason login|mason replica (create|list|status|delete|--help)( \S+)*)(\s|$)/;
const DELETE_LINES: Lines = {
  heads: [...LINES.heads, "Deleted ", "Deleting ", "> ", "  done: ", "  requested: ", "  under way: ", "  being deleted: ", "  The deletion's answer was lost ", "  by hand, ",
    "Tip: run each statement above ",
    ...["deletion", "last heard", "finished", "step", "source 0", "source 1", "source 2"].map((l) => `  ${l} `)],
  steps: ["  mason login", "  mason replica "], ownStep: OWN_STEP, row: LINES.row!,
  unbroken: (line) => /^ {4}SELECT /.test(line),
};
/**
 * EVERY STATEMENT A PERSON PASTES IS WHOLE, ON A LINE OF ITS OWN (#687's review, N1: one inside a failure's words was broken
 * at the width): in what a person reads, any line holding SQL is a statement Mason renders, alone and unbroken, and no
 * line holds a piece of one. Held for every run of this file that a person reads.
 */
function pastedWhole(a: { argv: string[]; stdout: string; stderr: string }): void {
  if (a.argv.includes("--json")) return;
  for (const line of `${a.stdout}\n${a.stderr}`.split("\n")) {
    if (!/pg_|replication_slots|\bSELECT\b|DROP PUBLICATION/.test(line)) continue;
    assert.match(line, /^ {4}SELECT [^\n]*;$/, `mason ${a.argv.join(" ")}: a line holding a piece of a statement, not the statement whole on its own:\n${line}`);
  }
}
const run = async (v1: (r: Req) => Reply | Promise<Reply>, argv: string[], o: Parameters<typeof hosted>[2] = {}) => {
  const r = await hosted(v1, ["delete", "acme/shop", ...argv], { lines: DELETE_LINES, ...o });
  pastedWhole(r.a);
  return r;
};

/** A deletion's steps, generic: what the fake says it did, each done by `done` (how many). */
const STEPS = ["nobody may query it", "Mason's replication slots are dropped", "its synced data is removed"];
const steps = (done: number) => STEPS.map((what, i) => ({ step: `step_${i + 1}`, what, doneAt: i < done ? AT : null }));
const dropped = (ordinal = 0) => ({ ordinal, outcome: "dropped", slot: "mason_shop_app", publication: "mason_shop_app", publicationOwned: true, reportedAt: AT });
const noSlot = (ordinal = 0) => ({ ordinal, outcome: "no_slot", slot: null, publication: null, reportedAt: AT });
/**
 * THE SERVICE'S OWN STATEMENT, as the fake sends it: never the CLI's text (#687's review, B1: a fake that rendered it with
 * the CLI's own function hid a service whose text differed). The CLI renders its own and prints none of this.
 */
const SERVICE_BY_HAND = "SELECT 'the service''s own statement, advisory';";
/** A slot not verified gone, as the service says it: its byHand the service's own, unless `byHand` says otherwise. */
function notVerified(o: { ordinal?: number; reason?: string; why?: string; slot?: string | null; publication?: string | null; owned?: boolean | null; byHand?: unknown } = {}): Record<string, unknown> {
  const slot = o.slot === undefined ? "mason_shop_app" : o.slot, publication = o.publication === undefined ? "mason_shop_app" : o.publication, owned = o.owned === undefined ? true : o.owned;
  return { ordinal: o.ordinal ?? 0, outcome: "not_verified", reason: o.reason ?? "unreachable", why: o.why ?? "the connection timed out", slot, publication, publicationOwned: owned,
    ...("byHand" in o ? { byHand: o.byHand } : { byHand: SERVICE_BY_HAND }), reportedAt: AT };
}
/** A replica in a deletion's stage, with what else the deletion says. */
function deleting(stage: "requested" | "in_region" | "needs_person" | "finished", more: Record<string, unknown> = {}, replica: Record<string, unknown> = {}): Record<string, unknown> {
  return replicaOf({ state: stage === "finished" ? "deleted" : "deleting", ...replica, deletion: { stage, requestedAt: AT, lastHeardAt: stage === "requested" ? null : AT,
    finishedAt: stage === "finished" ? LATER : null, steps: steps(stage === "finished" ? 3 : stage === "requested" ? 0 : stage === "in_region" ? 1 : 2),
    sources: stage === "finished" ? [dropped()] : stage === "needs_person" ? [notVerified()] : [], ...more } });
}
const answer = (status: 200 | 202, replica: Record<string, unknown>, headers: Record<string, string> = { "retry-after": "1" }): Reply => ({ status, body: { replica }, headers });

const service = (a: { stdout: string; stderr: string }): string => (a.stdout + a.stderr).match(/http:\/\/127\.0\.0\.1:\d+/)![0];

test("mason replica delete --yes: the DELETE carries the confirm, exactly; the deletion is asked for until it is finished, each step said once as the service words it; every slot dropped or none, exit 0", async () => {
  let polls = 0;
  const v1 = (r: Req): Reply => r.method === "DELETE" ? answer(202, deleting("requested", { handover: { attempts: 1, nextAttemptAt: AT } }))
    : polls++ === 0 ? ok({ replica: deleting("in_region") }, { "retry-after": "1" })
    : ok({ replica: deleting("finished", { sources: [dropped(0), noSlot(1)] }) });
  const { a, requests, token } = await run(v1, ["--yes"]);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), [`DELETE ${ONE}`, `GET ${ONE}`, `GET ${ONE}`]);
  assert.equal(requests[0]!.body, JSON.stringify({ confirm: "acme/shop" }));
  assert.equal(requests[0]!.headers["content-type"], "application/json");
  assert.equal(requests[0]!.headers.authorization, `Bearer ${token}`);
  for (const q of requests.slice(1)) assert.equal(q.body, "");
  const base = service(a);
  assert.equal(a.stdout, `Deleted acme/shop on ${base}
  deletion     finished; asked for at ${AT}
  last heard   ${AT}
  finished     ${LATER}
  step         done: nobody may query it (at ${AT})
  step         done: Mason's replication slots are dropped (at ${AT})
  step         done: its synced data is removed (at ${AT})
  source 0     replication slot mason_shop_app: dropped, verified gone
  source 1     no replication slot: nothing to drop

Next:
  mason replica list acme                       the organisation's replicas
`);
  assert.equal(a.stderr, `Deleting acme/shop on ${base}: each step is said as the service reports it, waiting up to 15m
  requested: the service has not handed it to its region yet, and the addresses of its allowlist may still query it (1 attempt to hand it over, the next at ${AT})
  under way: nobody may query it now
  done: nobody may query it
  done: Mason's replication slots are dropped
  done: its synced data is removed
`);
  // --json: the replica, its deletion, every value held; no progress
  polls = 0;
  const j = await run(v1, ["--yes", "--json"]);
  assert.equal(j.a.code, 0, j.a.stdout);
  assert.equal(j.a.stderr, "");
  const v = JSON.parse(j.a.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(v), ["replica", "deletion", "next"]);
  assert.deepEqual(v.replica, { ...replicaOf({ state: "deleted" }), page: null, mason: null });
  assert.deepEqual(v.deletion, { stage: "finished", requestedAt: AT, handover: null, lastHeardAt: AT, finishedAt: LATER, steps: steps(3),
    sources: [{ ...dropped(0), reason: null, why: null, byHand: null }, { ...noSlot(1), reason: null, why: null, publicationOwned: null, byHand: null }] });
  assert.deepEqual(v.next, [{ command: "mason replica list acme", what: "the organisation's replicas" }]);
});

test("mason replica delete: deleted already (200, the tombstone) is said at once, no poll; a repeat changes nothing", async () => {
  const { a, requests } = await run(() => answer(200, deleting("finished")), ["--yes", "--json"]);
  assert.equal(a.code, 0, a.stdout);
  assert.deepEqual(requests.map((q) => q.method), ["DELETE"]);
  assert.equal((JSON.parse(a.stdout) as { deletion: { stage: string } }).deletion.stage, "finished");
});

test("mason replica delete: a slot not verified gone, for every reason, needs a person — said with why and Mason's own statement to run by hand, on a line of its own, exactly dropStatements'; the wait stops at once, the exit is 1, the failure after it", async () => {
  for (const reason of REASONS) {
    const src = notVerified({ reason, why: `the service's words for ${reason}`, ...(reason === "record_unreadable" ? { slot: null, publication: null, owned: null } : {}) });
    const { a, requests } = await run(() => answer(202, deleting("needs_person", { sources: [src] })), ["--yes", "--json"]);
    assert.equal(a.code, 1, `${reason}: ${a.stdout}`);
    assert.deepEqual(requests.map((q) => q.method), ["DELETE"], `${reason}: nothing more is asked once a person is needed`);
    const v = JSON.parse(a.stdout) as { deletion: { sources: Array<Record<string, unknown>> }; error: { code: string; message: string; fix: string }; next: Array<{ command: string }> };
    assert.equal(v.error.code, "failed", reason);
    assert.equal(v.error.message, "acme/shop is not deleted yet: the replication slot of source 0 is NOT verified gone", reason);
    assert.equal((v.deletion as unknown as { stage: string }).stage, "needs_person", reason);
    assert.match(v.error.fix, /then confirm it on the replica's page in the service's web app/, reason);
    assert.equal(v.deletion.sources[0]!.byHand, reason === "record_unreadable" ? listSlotsStatement() : dropStatements({ slot: "mason_shop_app", publication: "mason_shop_app", owned: true }), reason);
    assert.equal(v.deletion.sources[0]!.reason, reason);
    assert.deepEqual(v.next.map((n) => n.command), ["mason replica status acme/shop"]);
    assert.ok(!a.stdout.includes("advisory"), `${reason}: the service's statement is never printed`);
  }
  // a person: each source's outcome, then each statement alone on its line, then the failure on stderr
  const sources = [notVerified({ ordinal: 0, reason: "in_use", why: "a reader holds it" }), notVerified({ ordinal: 1, reason: "refused", slot: "mason_other", publication: "orders_pub", owned: false }),
    notVerified({ ordinal: 2, reason: "record_unreadable", slot: null, publication: null, owned: null })];
  const { a } = await run(() => answer(202, deleting("needs_person", { sources })), ["--yes"]);
  assert.equal(a.code, 1, a.stdout + a.stderr);
  assert.match(a.stdout, /^acme\/shop on http:\/\/127\.0\.0\.1:\d+ is not deleted yet: its deletion needs a person\n {2}deletion {5}needs a person: /);
  const lines = a.stdout.split("\n");
  assert.deepEqual(lines.filter((l) => /^ {2}source \d/.test(l)), [
    "  source 0     replication slot mason_shop_app: NOT verified gone, a reader still holds the slot (a reader holds it)",
    "  source 1     replication slot mason_other: NOT verified gone, its database refused the drop (the connection timed out)",
    "  source 2     its replication slot: NOT verified gone, the replica's record of its slot could not be read (the connection timed out)",
  ]);
  // the statements: Mason's own, and nothing else of the service's on their lines
  assert.deepEqual(lines.filter((l) => /^ {4}SELECT /.test(l)), [
    "    SELECT pg_drop_replication_slot('mason_shop_app') FROM pg_replication_slots WHERE slot_name = 'mason_shop_app' AND NOT active; DROP PUBLICATION IF EXISTS mason_shop_app;",
    "    SELECT pg_drop_replication_slot('mason_other') FROM pg_replication_slots WHERE slot_name = 'mason_other' AND NOT active;",
    "    SELECT slot_name, database, active FROM pg_replication_slots WHERE left(slot_name, 6) = 'mason_';",
  ]);
  assert.match(a.stdout, /^ {2}by hand, for source 1: run this on its database, as a user that may drop a replication slot \(its owner, or one with REPLICATION\):\n {4}SELECT /m);
  assert.match(a.stdout, /^ {2}by hand, for source 2: this lists Mason's replication slots on its database; drop this replica's slot from them, as a user that may drop a replication slot:\n {4}SELECT slot_name/m);
  assert.doesNotMatch(a.stdout, /^Next:/m, "the failure carries the next step");
  assert.ok(!(a.stdout + a.stderr).includes("advisory"), "the service's statement is never printed");
  assert.match(a.stderr, /^✗ mason replica: acme\/shop is not deleted yet: the replication slots of 3 sources are NOT verified gone$/m);
});

test("the statement by hand is dropStatements' for every name Postgres's grammar takes, the publication only when it is Mason's own, whatever the service's byHand says; a name outside the grammar holds no deletion, refused by the grammar alone", () => {
  // names the grammar takes: the shortest, the longest, digits first, underscores alone, and 300 more from a fixed seed
  let n = 0;
  const rand = (): number => createHash("sha256").update(`mason-683:${n++}`).digest().readUInt32BE(0) / 2 ** 32;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
  const names = ["a", "0", "_", "9".repeat(63), "_".repeat(63), "z".repeat(63), "mason_", "0abc", ...Array.from({ length: 300 }, () => Array.from({ length: 1 + Math.floor(rand() * 63) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join(""))];
  const finished = (sources: unknown[]): unknown => ({ stage: "finished", requestedAt: AT, lastHeardAt: AT, finishedAt: LATER, steps: [], sources });
  const needsPerson = (sources: unknown[]): unknown => ({ stage: "needs_person", requestedAt: AT, lastHeardAt: AT, finishedAt: null, steps: [], sources });
  for (const slot of names) {
    assert.ok(PG_NAME.test(slot), slot);
    const own = `mason_${slot}`.slice(0, 63);
    for (const [publication, owned] of [[own, true], [slot, false], [slot, null], [null, null], [null, false]] as Array<[string | null, boolean | null]>) {
      const want = dropStatements({ slot, publication: publication ?? "", owned: owned === true });
      assert.equal(byHandOf({ slot, publication, publicationOwned: owned }), want);
      // the service's byHand, whatever it says or if it says nothing, changes nothing of the statement (#687's review, B1)
      for (const theirs of [SERVICE_BY_HAND, want, `${want} DROP TABLE orders;`, "", null, undefined]) {
        const d = heldDeletion(needsPerson([notVerified({ slot, publication, owned, byHand: theirs })]), "deleting", []);
        assert.ok(d, `${slot} ${publication} ${owned} ${theirs}`);
        assert.equal(d.sources[0]!.byHand, want);
      }
    }
  }
  assert.equal(byHandOf({ slot: null, publication: null, publicationOwned: null }), listSlotsStatement());
  assert.equal(heldDeletion(needsPerson([notVerified({ slot: null, publication: null, owned: null, reason: "record_unreadable" })]), "deleting", [])?.sources[0]!.byHand, listSlotsStatement());
  // the statements' text is the public contract (docs/HOSTED-API.md prints both)
  assert.equal(dropStatements({ slot: "mason_a", publication: "mason_a", owned: true }), "SELECT pg_drop_replication_slot('mason_a') FROM pg_replication_slots WHERE slot_name = 'mason_a' AND NOT active; DROP PUBLICATION IF EXISTS mason_a;");
  assert.equal(listSlotsStatement(), "SELECT slot_name, database, active FROM pg_replication_slots WHERE left(slot_name, 6) = 'mason_';");
  // a byHand that is not a string is no answer of the contract's
  for (const theirs of [1, true, {}, ["SELECT 1;"]]) assert.equal(heldDeletion(needsPerson([notVerified({ byHand: theirs })]), "deleting", []), null, JSON.stringify(theirs));
  // A NAME OUTSIDE THE GRAMMAR, refused by the grammar ALONE (#687's review, N2: every name tested was refused for another
  // reason too): a quote or a semicolon in a name otherwise lower case, short and spaceless, where nothing else is checked
  for (const bad of ["a'", "a;", "a'b", "a;b", "'", ";", "mason_shop'", "mason_shop;"]) {
    assert.equal(PG_NAME.test(bad), false, bad);
    assert.equal(heldDeletion(finished([{ ...dropped(), slot: bad }]), "deleted", []), null, `a dropped slot ${bad}`);
    assert.equal(heldDeletion(needsPerson([notVerified({ slot: bad })]), "deleting", []), null, `a slot not verified ${bad}`);
    assert.equal(heldDeletion(needsPerson([notVerified({ publication: bad, owned: false })]), "deleting", []), null, `a publication ${bad}`);
    assert.equal(heldDeletion(finished([{ ...noSlot(), slot: bad }]), "deleted", []), null, `no slot ${bad}`);
  }
  // and the other ways out of it
  for (const bad of ["", "Mason_shop", "mason-shop", "a".repeat(64), "x'; DROP TABLE orders; --", "mason shop", "maßon", "mason_shop\n", "\"mason\""]) {
    assert.equal(PG_NAME.test(bad), false, bad);
    assert.equal(heldDeletion(needsPerson([notVerified({ slot: bad })]), "deleting", []), null, `slot ${bad}`);
    assert.equal(heldDeletion(needsPerson([notVerified({ publication: bad, owned: false })]), "deleting", []), null, `publication ${bad}`);
    assert.equal(heldDeletion(finished([{ ...dropped(), slot: bad }]), "deleted", []), null, `dropped ${bad}`);
  }
  // Mason's own publication is mason_…: one said to be its own that is not, or none named, does not hold
  for (const publication of ["orders_pub", null]) assert.equal(heldDeletion(needsPerson([notVerified({ publication, owned: true })]), "deleting", []), null, String(publication));
});

test("a deletion held to the contract: present exactly while the replica is deleting or deleted, its stage the state's, the handover at requested alone, each step once, each source in order, a reason and byHand for not_verified alone", () => {
  const d = (more: Record<string, unknown>, stage = "in_region"): Record<string, unknown> => ({ stage, requestedAt: AT, lastHeardAt: AT, finishedAt: stage === "finished" ? LATER : null, steps: steps(1), sources: [], ...more });
  assert.ok(heldDeletion(d({}), "deleting", []));
  assert.equal(heldDeletion(undefined, "ready", []), undefined, "a replica in no deletion carries none");
  assert.equal(heldDeletion(null, "ready", []), undefined, "nor null");
  // a replica deleting may carry none (deleted another way): what is known is that it is being deleted
  assert.equal(heldDeletion(undefined, "deleting", []), undefined, "none while it is deleting");
  assert.equal(heldDeletion(null, "deleting", []), undefined, "null while it is deleting");
  // a person is needed exactly while a slot is not verified gone; a person's confirmation finishes it
  assert.equal(heldDeletion(d({ sources: [notVerified()] }, "needs_person"), "deleting", [])?.stage, "needs_person");
  assert.ok(heldDeletion(d({ sources: [notVerified(), dropped(1)] }), "deleting", []), "a slot not verified gone while it is under way");
  const confirmed = heldDeletion(d({ sources: [{ ordinal: 0, outcome: "confirmed", slot: null, publication: null, publicationOwned: null, reportedAt: AT }] }, "finished"), "deleted", []);
  assert.deepEqual(confirmed?.sources[0], { ordinal: 0, outcome: "confirmed", reason: null, why: null, slot: null, publication: null, publicationOwned: null, byHand: null, reportedAt: AT });
  for (const [what, v, state] of [
    ["a deletion of a ready replica", d({}), "ready"], ["none while it is deleted", undefined, "deleted"], ["null while it is deleted", null, "deleted"],
    ["not an object while it is deleting", "deleting", "deleting"], ["an empty one while it is deleting", {}, "deleting"],
    ["needs a person with every slot gone", d({ sources: [dropped()] }, "needs_person"), "deleting"], ["needs a person while deleted", d({ sources: [notVerified()] }, "needs_person"), "deleted"],
    ["finished with a slot not verified gone", d({ sources: [notVerified()] }, "finished"), "deleted"],
    ["a confirmed slot with a reason", d({ sources: [{ ordinal: 0, outcome: "confirmed", reason: "failed", publicationOwned: null, reportedAt: AT }] }, "finished"), "deleted"],
    ["a confirmed slot whose publicationOwned is unsaid", d({ sources: [{ ordinal: 0, outcome: "confirmed", reportedAt: AT }] }, "finished"), "deleted"],
    ["finished while deleting", d({}, "finished"), "deleting"], ["under way while deleted", d({}), "deleted"], ["a stage of its own", d({ stage: "melting" }), "deleting"],
    ["finished with no finishedAt", d({ finishedAt: null }, "finished"), "deleted"], ["a finishedAt before it is finished", d({ finishedAt: LATER }), "deleting"],
    ["a handover under way", d({ handover: { attempts: 1 } }), "deleting"], ["a handover's attempts not a number", d({ handover: { attempts: "1" } }, "requested"), "deleting"],
    ["a step twice", d({ steps: [...steps(1), steps(1)[0]] }), "deleting"], ["a step's id in capitals", d({ steps: [{ step: "Step_1", what: "x", doneAt: null }] }), "deleting"],
    ["a step's what not a string", d({ steps: [{ step: "s", what: 1, doneAt: null }] }), "deleting"], ["a step's time not one", d({ steps: [{ step: "s", what: "x", doneAt: "soon" }] }), "deleting"],
    ["65 steps", d({ steps: Array.from({ length: 65 }, (_, i) => ({ step: `s${i}`, what: "x", doneAt: null })) }), "deleting"],
    ["a source out of order", d({ sources: [dropped(1)] }), "deleting"], ["an outcome of its own", d({ sources: [{ ...dropped(), outcome: "gone" }] }), "deleting"],
    ["a reason beside dropped", d({ sources: [{ ...dropped(), reason: "failed" }] }), "deleting"], ["a byHand not a string", d({ sources: [{ ...dropped(), byHand: 1 }] }), "deleting"],
    ["dropped with no slot", d({ sources: [{ ...dropped(), slot: null }] }), "deleting"], ["publicationOwned beside no_slot", d({ sources: [{ ...noSlot(), publicationOwned: true }] }), "deleting"],
    ["not_verified with no reason", d({ sources: [{ ...notVerified(), reason: undefined }] }), "deleting"], ["a reason of its own", d({ sources: [notVerified({ reason: "bad_luck" })] }), "deleting"],
    ["publicationOwned unsaid for not_verified", d({ sources: [{ ...notVerified(), publicationOwned: undefined }] }), "deleting"],
    ["no reportedAt", d({ sources: [{ ...dropped(), reportedAt: undefined }] }), "deleting"],
  ] as Array<[string, unknown, "deleting" | "deleted" | "ready"]>) assert.equal(heldDeletion(v, state, []), null, what);
  // the service's byHand is advisory: beside any outcome, or none at all, it changes nothing
  for (const source of [{ ...dropped(), byHand: "SELECT 1;" }, { ...notVerified(), byHand: undefined }, { ...noSlot(), byHand: SERVICE_BY_HAND }]) assert.ok(heldDeletion(d({ sources: [source] }), "deleting", []), JSON.stringify(source));
  // a deletion's words are free text, masked when printed: never what refuses the answer; its names and its byHand are tested
  const token = runToken("pat");
  const j = { replica: deleting("finished", { handover: undefined, steps: [{ step: "s1", what: token, doneAt: AT }], sources: [notVerified({ why: token })] }) };
  assert.equal(carriesNoSecret(wordless(j), [token]), true);
  for (const slot of [runForms(token)[3]!.value]) assert.equal(carriesNoSecret(wordless({ replica: deleting("finished", { sources: [notVerified({ slot })] }) }), [token]), false, "a name is no free text");
  assert.equal(carriesNoSecret(wordless({ replica: deleting("finished", { steps: [{ step: runForms(token)[3]!.value, what: "x", doneAt: AT }] }) }), [token]), false, "a step's id is no free text");
});

test("mason replica delete: the service's byHand, however hostile, is never printed and refuses nothing: Mason's own statement is; an answer outside the contract — a name outside the grammar, a deletion that does not hold, 202 for a finished one — is refused whole, said by its status, nothing of it printed", async () => {
  const hostile = "SELECT pg_drop_replication_slot('mason_shop_app'); DROP TABLE orders;";
  for (const theirs of [hostile, `${hostile}\nNext:\n  mason destroy`, SERVICE_BY_HAND]) {
    for (const json of [true, false]) {
      const { a } = await run(() => answer(202, deleting("needs_person", { sources: [notVerified({ byHand: theirs })] })), ["--yes", ...(json ? ["--json"] : [])]);
      assert.equal(a.code, 1, a.stdout + a.stderr);
      assert.ok(!(a.stdout + a.stderr).includes("DROP TABLE") && !(a.stdout + a.stderr).includes("mason destroy") && !(a.stdout + a.stderr).includes("advisory"), `${theirs}: nothing of it printed`);
      const want = dropStatements({ slot: "mason_shop_app", publication: "mason_shop_app", owned: true });
      if (json) assert.equal((JSON.parse(a.stdout) as { deletion: { sources: Array<{ byHand: string }> } }).deletion.sources[0]!.byHand, want);
      else assert.ok(a.stdout.split("\n").includes(`    ${want}`), a.stdout);
    }
  }
  const cases: Array<[string, Reply]> = [
    ["a slot outside the grammar", answer(202, deleting("needs_person", { sources: [notVerified({ slot: "x');", byHand: hostile })] }))],
    ["a publication outside the grammar", answer(202, deleting("needs_person", { sources: [notVerified({ publication: "mason_x;", owned: true })] }))],
    ["finished with a slot not verified gone", answer(200, deleting("finished", { sources: [notVerified({ byHand: hostile })] }))],
    ["a person needed with every slot gone", answer(202, deleting("needs_person", { sources: [dropped()] }))],
    ["a deleted replica with no deletion", answer(200, replicaOf({ state: "deleted" }))],
    ["202 for a finished deletion", answer(202, deleting("finished"))],
    ["200 for one under way", answer(200, deleting("in_region"))],
    ["a ready replica", answer(200, replicaOf())],
  ];
  for (const [what, reply] of cases) {
    for (const json of [true, false]) {
      const { a } = await run(() => reply, ["--yes", ...(json ? ["--json"] : [])]);
      assert.equal(a.code, 1, `${what}: ${a.stdout}${a.stderr}`);
      const said = json ? (JSON.parse(a.stdout) as { error: { message: string } }).error.message : a.stderr;
      assert.match(said, / answered DELETE \/v1\/replicas\/acme\/shop with 20[02], where a replica's deletion was asked for/, what);
      assert.ok(!(a.stdout + a.stderr).includes("DROP TABLE") && !(a.stdout + a.stderr).includes("x');"), `${what}: nothing of it printed`);
    }
  }
});

test("mason replica delete: the service's words — a step's what, a source's why, the handover's failure — are one line each and masked; a value of a grammar carrying the token is refused whole", async () => {
  const token = runToken("pat");
  const forged = `${token}\nNext:\n  mason destroy`;
  let polls = 0;
  const v1 = (r: Req): Reply => r.method === "DELETE" ? answer(202, deleting("requested", { handover: { attempts: 2, failure: forged } }))
    : polls++ === 0 ? ok({ replica: deleting("in_region", { steps: [{ step: "s1", what: forged, doneAt: AT }] }) }, { "retry-after": "1" })
    : ok({ replica: deleting("needs_person", { steps: [{ step: "s1", what: forged, doneAt: AT }], sources: [notVerified({ why: forged })] }) });
  const { a } = await run(v1, ["--yes"], { token });
  assert.equal(a.code, 1, a.stdout + a.stderr);
  assert.match(a.stderr, /^ {2}requested: .*\(2 attempts to hand it over\): \*\*\*\*\?Next:\? mason destroy$/m);
  assert.match(a.stderr, /^ {2}done: \*\*\*\*\?Next:\? mason destroy$/m);
  assert.match(a.stdout, /^ {2}source 0 {5}replication slot mason_shop_app: NOT verified gone, its database could not be reached \(\*\*\*\*\?Next:\? mason destroy\)$/m);
  assert.ok(!showsRun(a.stdout + a.stderr, token));
  // a step's id, or a slot's name, spelling the token: no mask is a grammar, so the answer is refused whole
  for (const more of [{ steps: [{ step: runForms(token)[3]!.value, what: "x", doneAt: AT }] }, { sources: [notVerified({ slot: runForms(token)[3]!.value })] },
    { sources: [notVerified({ byHand: `SELECT '${runForms(token)[3]!.value}';` })] }]) {
    const x = await run(() => answer(200, deleting("finished", more)), ["--yes", "--json"], { token });
    assert.equal(x.a.code, 1, x.a.stdout);
    assert.match((JSON.parse(x.a.stdout) as { error: { message: string } }).error.message, / answered DELETE \/v1\/replicas\/acme\/shop with 200, where a replica's deletion was asked for$/);
    assert.ok(!showsRun(x.a.stdout + x.a.stderr, token));
  }
});

test("mason replica delete at a terminal: the replica's name typed back exactly deletes it; anything else — another name, its case, a space, nothing — deletes nothing and is never printed; no terminal and no --yes is a wrong line (exit 2), nothing sent", async () => {
  const v1 = (): Reply => answer(200, deleting("finished"));
  const typed = await run(v1, [], { terminal: 80, input: "acme/shop\n" });
  assert.equal(typed.a.code, 0, typed.a.stdout + typed.a.stderr);
  assert.deepEqual(typed.requests.map((q) => `${q.method} ${q.body}`), [`DELETE ${JSON.stringify({ confirm: "acme/shop" })}`]);
  assert.match(typed.a.stderr.replace(/\n {4}/g, " "), /^Deleting acme\/shop on http:\/\/127\.0\.0\.1:\d+ cannot be undone: the replica and its synced data go, and Mason's replication slot on its database is dropped\. Type acme\/shop to delete it, anything else to keep it\.$/m);
  assert.match(typed.a.stderr, /^> /m);
  for (const input of ["acme/shopx\n", "ACME/SHOP\n", " acme/shop\n", "acme/shop \n", "acme/other\n", "", "\n", "typed-secret-Qz7Vw2Xk\n"]) {
    const { a, requests } = await run(v1, [], { terminal: 80, input });
    assert.equal(a.code, 1, `${JSON.stringify(input)}: ${a.stderr}`);
    assert.deepEqual(requests, [], `${JSON.stringify(input)}: nothing sent`);
    // (a pipe is no terminal: nothing echoes the line typed, so the failure follows the prompt on its line)
    assert.match(a.stderr, /^(> )?✗ mason replica: acme\/shop was not deleted: what was typed is not its name$/m);
    // what was typed is never written back (the ones that are not the name itself, which the CLI prints of its own)
    for (const typedText of ["acme/shopx", "ACME/SHOP", "acme/other", "typed-secret"]) assert.ok(!(a.stdout + a.stderr).includes(typedText), `${JSON.stringify(input)}: ${typedText} printed`);
  }
  // with --yes at a terminal: no question
  const yes = await run(v1, ["--yes"], { terminal: 80, input: "" });
  assert.equal(yes.a.code, 0, yes.a.stderr);
  assert.doesNotMatch(yes.a.stderr, /^> /m);
  // no terminal, or --json, and no --yes: a wrong line, before a byte is sent (a person's is followed by the usage)
  const fake = await fakeService({ v1 });
  try {
    for (const argv of [[], ["--json"]]) {
      const a = await runMason(home(), ["replica", "delete", "acme/shop", ...argv], envFor(home(), fake.url, { MASON_TOKEN: newToken() }));
      assert.equal(a.code, 2, a.stdout + a.stderr);
      const e = argv.length ? (JSON.parse(a.stdout) as { error: { code: string; message: string; fix: string } }).error : null;
      if (e) assert.deepEqual([e.code, e.message, e.fix], ["usage", "mason replica delete asks for acme/shop to be typed back at a terminal, and --json is no terminal", "say it on the line: mason replica delete acme/shop --yes"]);
      else assert.match(a.stderr, /^✗ mason replica: mason replica delete asks for acme\/shop to be typed back at a terminal, and there is none here$/m);
    }
    assert.deepEqual(fake.requests, [], "nothing was sent");
  } finally { await fake.close(); }
  const json = await run(v1, ["--json"], { terminal: 80, input: "acme/shop\n" });
  assert.equal(json.a.code, 2, "--json is never asked, even at a terminal");
});

test("mason replica delete: a refusal is the service's words, its code the CLI's by the status, its next step the CLI's — a login too old says mason login then delete within 15 minutes, or the web app; a role below owner, who may; 429, when", async () => {
  const cases: Array<[Reply, string, RegExp]> = [
    [{ status: 403, body: { error: { code: "fresh_login_needed", message: "deleting a replica needs a login made in the last 15 minutes" }, next: [{ command: "mason destroy" }] } }, "refused",
      /^mason login: sign in again, then mason replica delete acme\/shop within 15 minutes of it; or delete it on its page in the service's web app, http:\/\/127\.0\.0\.1:\d+$/],
    [{ status: 403, body: { error: { code: "refused", message: "only an owner of acme deletes a replica, and a CI token none" } } }, "refused",
      /^mason login: sign in as an owner of acme: an owner deletes a replica, signed in as a person \(a CI token deletes none\)$/],
    [{ status: 401, body: { error: { code: "unauthenticated", message: "this token is not taken" } } }, "refused", /^mason login: sign in as an owner of acme/],
    [{ status: 429, body: { error: { code: "slow_down", message: "the account's deletions this hour are made" } }, headers: { "retry-after": "120" } }, "refused",
      /^mason replica delete acme\/shop: again after \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ \(in 120 s\), when the service takes it$/],
    [{ status: 429, body: { error: { code: "slow_down", message: "the account's deletions this hour are made" } } }, "refused", /^mason replica delete acme\/shop: again later: the service did not say when$/],
    [{ status: 503, body: { error: { code: "unavailable", message: "the organisation's changes are queued" } }, headers: { "retry-after": "30" } }, "failed", /^mason replica delete acme\/shop: again after .* \(in 30 s\)/],
    [{ status: 404, body: { error: { code: "not_found", message: "there is no replica acme/shop this token can reach" } } }, "not_found", /^mason replica list acme: the organisation's replicas$/],
    [{ status: 409, body: { error: { code: "refused", message: "the role was lowered while it ran: nothing changed" } } }, "refused", /^mason replica delete acme\/shop: delete it again \(a repeat changes nothing\)$/],
    [{ status: 400, body: { error: { code: "bad_request", message: "confirm does not name the replica" } } }, "refused", /^mason replica delete acme\/shop: delete it again/],
  ];
  for (const [reply, code, next] of cases) {
    const { a, requests } = await run(() => reply, ["--yes", "--json"]);
    const v = JSON.parse(a.stdout) as { error: { code: string; message: string; why: string }; next: Array<{ command: string; what: string }> };
    const body = (reply as { body: { error: { code: string; message: string } } }).body;
    assert.equal(a.code, 1, a.stdout);
    assert.equal(v.error.code, code, body.error.code);
    assert.equal(v.error.message, body.error.message, "the service's words, as they came");
    assert.match(v.error.why, new RegExp(`the service said ${body.error.code}, HTTP ${(reply as { status: number }).status}$`));
    assert.equal(v.next.length, 1, body.error.code);
    assert.match(`${v.next[0]!.command}: ${v.next[0]!.what}`, next, body.error.code);
    assert.equal(requests.length, 1, "a refusal is never retried");
  }
});

test("mason replica delete: the wait's bounds — an answer that cannot say is a wait, past --timeout 124 with nothing stopped; a replica gone midway, not_found; a DELETE with no answer is asked about once, and goes on, or says it did not begin", async () => {
  // 503 while it is under way: a wait; past --timeout, 124
  const slow = await run((r) => r.method === "DELETE" ? answer(202, deleting("in_region")) : { status: 503, body: {}, headers: { "retry-after": "1" } }, ["--yes", "--timeout", "2s", "--json"]);
  const se = JSON.parse(slow.a.stdout) as { error: { code: string; message: string; why: string; fix: string }; deletion: { stage: string } };
  assert.equal(slow.a.code, 124, slow.a.stdout);
  assert.deepEqual([se.error.code, se.error.message, se.deletion.stage], ["timeout", "acme/shop's deletion did not finish within 2s", "in_region"]);
  assert.equal(se.error.why, "it was last under way: nobody may query it now");
  assert.match(se.error.fix, /^nothing was stopped, and its deletion goes on: mason replica status acme\/shop says how it goes/);
  assert.ok(slow.requests.length >= 2, "it asked again after the 503");
  const person = await run((r) => r.method === "DELETE" ? answer(202, deleting("in_region")) : { status: 503, body: {} }, ["--yes", "--timeout", "1s"]);
  assert.equal(person.a.code, 124);
  assert.match(person.a.stderr, /^✗ mason replica: acme\/shop's deletion did not finish within 1s$/m);
  // gone midway: what it did to each slot is not known, said with the statement that lists Mason's slots
  const gone = await run((r) => r.method === "DELETE" ? answer(202, deleting("in_region")) : { status: 404, body: { error: { code: "not_found", message: "no" } } }, ["--yes", "--json"]);
  const ge = JSON.parse(gone.a.stdout) as { error: { code: string; fix: string } };
  assert.deepEqual([gone.a.code, ge.error.code], [1, "not_found"]);
  assert.ok(ge.error.fix.endsWith(listSlotsStatement()), "--json, where nothing is broken: in the fix");
  const gonePerson = await run((r) => r.method === "DELETE" ? answer(202, deleting("in_region")) : { status: 404, body: { error: { code: "not_found", message: "no" } } }, ["--yes"]);
  assert.equal(gonePerson.a.code, 1);
  assert.ok(gonePerson.a.stdout.split("\n").includes(`    ${listSlotsStatement()}`), "a person: the statement pasted alone, on stdout");
  assert.match(gonePerson.a.stderr, /^ {2}fix {3}look for Mason's slots on each database it synced with the statement printed above, and drop this replica's$/m);
  // a deletion that ends otherwise than finished: outside the contract
  const undone = await run((r) => r.method === "DELETE" ? answer(202, deleting("in_region")) : ok({ replica: replicaOf() }), ["--yes", "--json"]);
  assert.equal(undone.a.code, 1);
  assert.match((JSON.parse(undone.a.stdout) as { error: { message: string } }).error.message, / answered GET \/v1\/replicas\/acme\/shop with 200, where a replica's deletion was asked for$/);
  // a DELETE with no answer: its state asked once
  let n = 0;
  const lost = await run((r) => r.method === "DELETE" ? "drop" : ok({ replica: deleting(n++ ? "finished" : "in_region") }, { "retry-after": "1" }), ["--yes"]);
  assert.equal(lost.a.code, 0, lost.a.stdout + lost.a.stderr);
  assert.match(lost.a.stderr, /^ {2}The deletion's answer was lost \(.*\); the service has acme\/shop, its deletion under way: nobody may query it now$/m);
  for (const [reply, why] of [[ok({ replica: replicaOf() }), /asked since, it is ready: its deletion did not begin$/], [{ status: 404, body: { error: { code: "not_found", message: "no" } } }, /asked since, the service has no acme\/shop for this login$/],
    [{ status: 500, body: {} }, /whether its deletion began is not known$/]] as Array<[Reply, RegExp]>) {
    const x = await run((r) => r.method === "DELETE" ? "drop" : reply, ["--yes", "--json"]);
    const xe = JSON.parse(x.a.stdout) as { error: { code: string; why: string }; next: Array<{ command: string }> };
    assert.equal(x.a.code, 1);
    assert.equal(xe.error.code, "failed");
    assert.match(xe.error.why, why);
    assert.deepEqual(xe.next.map((s) => s.command), ["mason replica status acme/shop", "mason replica delete acme/shop"]);
  }
});

test("mason replica delete: a deletion that comes to need a person stops the wait at once, whatever --timeout — the statement printed alone, what the person does then, exit 1; --json the same, its stage needs_person", async () => {
  let polls = 0;
  const v1 = (r: Req): Reply => r.method === "DELETE" ? answer(202, deleting("in_region")) : polls++ === 0 ? ok({ replica: deleting("in_region") }, { "retry-after": "1" }) : ok({ replica: deleting("needs_person") });
  const want = dropStatements({ slot: "mason_shop_app", publication: "mason_shop_app", owned: true });
  const t0 = Date.now();
  const { a, requests } = await run(v1, ["--yes", "--timeout", "1h"]);
  assert.equal(a.code, 1, a.stdout + a.stderr);
  assert.ok(Date.now() - t0 < 30_000, "it did not wait for --timeout");
  assert.deepEqual(requests.map((q) => q.method), ["DELETE", "GET", "GET"], "nothing is asked once a person is needed");
  assert.ok(a.stdout.split("\n").includes(`    ${want}`), a.stdout);
  assert.match(a.stdout, /^ {2}source 0 {5}replication slot mason_shop_app: NOT verified gone, its database could not be reached \(the connection timed out\)$/m);
  assert.doesNotMatch(a.stdout, /^Deleted /m, "it is not deleted");
  assert.match(a.stderr, /^✗ mason replica: acme\/shop is not deleted yet: the replication slot of source 0 is NOT verified gone$/m);
  assert.match(a.stderr.replace(/\n {4,}/g, " "), /^ {2}fix {3}run the statement printed for it on its database \(with --json, deletion\.sources\[\]\.byHand\), then confirm it on the replica's page in the service's web app \(or there, that the database is no more\): its deletion then finishes$/m);
  assert.match(a.stderr, /^ {2}mason replica status acme\/shop {2,}how its deletion goes, once confirmed$/m);
  polls = 0;
  const j = await run(v1, ["--yes", "--json"]);
  assert.equal(j.a.code, 1, j.a.stdout);
  const v = JSON.parse(j.a.stdout) as { replica: { state: string }; deletion: { stage: string; finishedAt: unknown; sources: DeletionSource[] }; error: { code: string; message: string }; next: Array<{ command: string }> };
  assert.deepEqual(Object.keys(v), ["replica", "deletion", "error", "next"]);
  assert.deepEqual([v.replica.state, v.deletion.stage, v.deletion.finishedAt, v.error.code], ["deleting", "needs_person", null, "failed"]);
  assert.deepEqual(v.deletion.sources.map((x) => [x.outcome, x.slot, x.byHand]), [["not_verified", "mason_shop_app", want]]);
  assert.deepEqual(v.next.map((n) => n.command), ["mason replica status acme/shop"]);
  // confirmed by the person, finished: exit 0, nothing to run by hand
  const fin = await run(() => answer(200, deleting("finished", { sources: [{ ordinal: 0, outcome: "confirmed", slot: "mason_shop_app", publication: "mason_shop_app", publicationOwned: true, reportedAt: AT }] })), ["--yes"]);
  assert.equal(fin.a.code, 0, fin.a.stdout + fin.a.stderr);
  assert.match(fin.a.stdout, /^Deleted acme\/shop on /);
  assert.match(fin.a.stdout, /^ {2}source 0 {5}replication slot mason_shop_app: not verified gone by the service; a person confirmed it was dropped by hand, or that its database is no more$/m);
});

test("a replica being deleted that carries no deletion (deleted another way): status says it is being deleted and nothing more, exit 0, --json deletion null; delete waits on it as on any deletion", async () => {
  const none = replicaOf({ state: "deleting" });
  const st = await hosted(() => ok({ replica: none }), ["status", "acme/shop"], { lines: DELETE_LINES });
  assert.equal(st.a.code, 0, st.a.stdout + st.a.stderr);
  assert.match(st.a.stdout, /^ {2}deletion {4}being deleted: the service said no more of it$/m);
  assert.doesNotMatch(st.a.stdout, /step|source \d|SELECT/, "nothing invented");
  const sj = await hosted(() => ok({ replica: { ...none, deletion: null } }), ["status", "acme/shop", "--json"]);
  assert.equal(sj.a.code, 0, sj.a.stdout);
  const sv = JSON.parse(sj.a.stdout) as { replica: { state: string }; deletion: unknown };
  assert.deepEqual([sv.replica.state, sv.deletion], ["deleting", null]);
  // delete: 202 with none, then none, then finished
  let polls = 0;
  const { a, requests } = await run((r) => r.method === "DELETE" ? answer(202, none) : ok({ replica: polls++ === 0 ? none : deleting("finished") }, { "retry-after": "1" }), ["--yes"]);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.deepEqual(requests.map((q) => q.method), ["DELETE", "GET", "GET"]);
  assert.match(a.stderr, /^ {2}being deleted: the service said no more of it$/m);
  assert.match(a.stdout, /^Deleted acme\/shop on /);
  // past --timeout with none: what is known, said
  const slow = await run((r) => r.method === "DELETE" ? answer(202, none) : ok({ replica: none }, { "retry-after": "1" }), ["--yes", "--timeout", "1s", "--json"]);
  assert.equal(slow.a.code, 124, slow.a.stdout);
  const se = JSON.parse(slow.a.stdout) as { error: { why: string }; deletion: unknown };
  assert.deepEqual([se.error.why, se.deletion], ["it was last being deleted: the service said no more of it", null]);
  // a deletion present but malformed is still refused whole
  const bad = await run(() => answer(202, { ...none, deletion: { stage: "in_region" } }), ["--yes", "--json"]);
  assert.equal(bad.a.code, 1, bad.a.stdout);
  assert.match((JSON.parse(bad.a.stdout) as { error: { message: string } }).error.message, / answered DELETE \/v1\/replicas\/acme\/shop with 202, where a replica's deletion was asked for$/);
});

test("mason replica status of a replica being deleted, or deleted: its deletion as delete says it, the statements by hand included; exit 0; --json's deletion null for a replica in none", async () => {
  const st = await hosted(() => ok({ replica: deleting("in_region") }), ["status", "acme/shop"], { lines: DELETE_LINES });
  assert.equal(st.a.code, 0, st.a.stderr);
  assert.match(st.a.stdout, /^acme\/shop on http:\/\/127\.0\.0\.1:\d+: deleting\n {2}state {8}deleting\n/);
  assert.match(st.a.stdout, /^ {2}deletion {5}under way: nobody may query it now; asked for at 2026-11-02T10:00:00\.000Z\n {2}last heard {3}2026-11-02T10:00:00\.000Z\n {2}step {9}done: nobody may query it \(at 2026-11-02T10:00:00\.000Z\)\n {2}step {9}not yet: Mason's replication slots are dropped\n/m);
  assert.match(st.a.stdout, /^ {2}mason replica status acme\/shop {2,}how it is$/m);
  // a deletion that needs a person: said, the statement pasted, what the person does then; exit 0 (status says it)
  const person = await hosted(() => ok({ replica: deleting("needs_person") }), ["status", "acme/shop"], { lines: DELETE_LINES });
  assert.equal(person.a.code, 0, "status says it, whatever it says");
  pastedWhole(person.a);
  assert.ok(person.a.stdout.includes(`\n    ${dropStatements({ slot: "mason_shop_app", publication: "mason_shop_app", owned: true })}\n`), person.a.stdout);
  assert.match(person.a.stdout, /^ {2}deletion {5}needs a person: a replication slot is NOT verified gone, and the service keeps the replica until it is seen gone or a person confirms it was dropped; asked for at /m);
  assert.match(person.a.stdout, /^Tip: run each statement above on its database, then confirm it on the replica's page in the service's web app \(or there, that the database is no more\): the service deletes the replica only then$/m);
  assert.match(person.a.stdout, /^ {2}mason replica status acme\/shop {2,}how it is$/m);
  const j = await hosted(() => ok({ replica: deleting("needs_person") }), ["status", "acme/shop", "--json"]);
  const v = JSON.parse(j.a.stdout) as { deletion: { stage: string; sources: DeletionSource[] } };
  assert.equal(v.deletion.stage, "needs_person");
  assert.equal(v.deletion.sources[0]!.byHand, dropStatements({ slot: "mason_shop_app", publication: "mason_shop_app", owned: true }));
  // finished: every slot dropped, none there, or confirmed by a person (never seen gone by the service: said so)
  const done = await hosted(() => ok({ replica: deleting("finished", { sources: [dropped(0), { ordinal: 1, outcome: "confirmed", slot: "mason_shop_app", publication: null, publicationOwned: null, reportedAt: AT }] }) }),
    ["status", "acme/shop"], { lines: DELETE_LINES });
  assert.equal(done.a.code, 0, done.a.stdout + done.a.stderr);
  assert.match(done.a.stdout, /^ {2}source 1 {5}replication slot mason_shop_app: not verified gone by the service; a person confirmed it was dropped by hand, or that its database is no more$/m);
  assert.doesNotMatch(done.a.stdout, /SELECT/, "nothing to run by hand once a person confirmed it");
  assert.match(done.a.stdout, /^ {2}mason replica list acme {2,}the organisation's replicas$/m);
  const ready = await hosted(() => ok({ replica: replicaOf() }), ["status", "acme/shop", "--json"]);
  assert.deepEqual(Object.keys(JSON.parse(ready.a.stdout) as object), ["replica", "deletion", "next"]);
  assert.equal((JSON.parse(ready.a.stdout) as { deletion: unknown }).deletion, null);
  // a deletion where there is none, or none where there is one: outside the contract
  // the service's own byHand (record_unreadable's too) refuses nothing: status says it, exit 0, with Mason's statement (#687's review, B1)
  for (const source of [notVerified({ byHand: "SELECT 1;" }), notVerified({ slot: null, publication: null, owned: null, reason: "record_unreadable" })]) {
    const x = await hosted(() => ok({ replica: deleting("needs_person", { sources: [source] }) }), ["status", "acme/shop"], { lines: DELETE_LINES });
    assert.equal(x.a.code, 0, x.a.stdout + x.a.stderr);
    pastedWhole(x.a);
    assert.ok(x.a.stdout.split("\n").includes(`    ${byHandOf({ slot: source.slot as string | null, publication: source.publication as string | null, publicationOwned: source.publicationOwned as boolean | null })}`), x.a.stdout);
    assert.ok(!x.a.stdout.includes("SELECT 1;") && !x.a.stdout.includes("advisory"));
  }
  for (const replica of [replicaOf({ deletion: { stage: "in_region" } }), replicaOf({ state: "deleted" }), deleting("needs_person", { sources: [notVerified({ slot: "a;" })] }),
    deleting("finished", { sources: [notVerified()] }), deleting("in_region", { stage: "melting" })]) {
    const x = await hosted(() => ok({ replica }), ["status", "acme/shop", "--json"]);
    assert.equal(x.a.code, 1, JSON.stringify(replica));
  }
});

test("mason replica delete and status, on a terminal of every width from 20 to 80: every line one the CLI begins, none the terminal broke but the statements a person pastes, each written whole on every path that prints one", async () => {
  const sources = [notVerified({ ordinal: 0, why: `a long reason ${"x".repeat(90)}` }), notVerified({ ordinal: 1, reason: "record_unreadable", slot: null, publication: null, owned: null }), noSlot(2)];
  for (const width of [20, 33, 47, 80]) {
    let polls = 0;
    const { a } = await run((r) => r.method === "DELETE" ? answer(202, deleting("requested", { handover: { attempts: 3, failure: "the region did not answer", nextAttemptAt: AT } }))
      : ok({ replica: polls++ ? deleting("needs_person", { sources }) : deleting("in_region") }, { "retry-after": "1" }), ["--yes"], { terminal: width });
    assert.equal(a.code, 1, a.stdout + a.stderr);
    assert.ok(a.stdout.split("\n").includes(`    ${dropStatements({ slot: "mason_shop_app", publication: "mason_shop_app", owned: true })}`), `${width}: the statement, whole on its line`);
    // EVERY PATH THAT PRINTS A STATEMENT (#687's review, N1), at this width: status's report, and a replica gone midway
    const st = await hosted(() => ok({ replica: deleting("needs_person", { sources }) }), ["status", "acme/shop"], { lines: DELETE_LINES, terminal: width });
    assert.equal(st.a.code, 0, st.a.stdout + st.a.stderr);
    pastedWhole(st.a);
    assert.ok(st.a.stdout.split("\n").includes(`    ${listSlotsStatement()}`), `${width}: status`);
    const gone = await run((r) => r.method === "DELETE" ? answer(202, deleting("in_region")) : { status: 404, body: { error: { code: "not_found", message: "no" } } }, ["--yes"], { terminal: width });
    assert.equal(gone.a.code, 1, gone.a.stdout + gone.a.stderr);
    assert.ok(gone.a.stdout.split("\n").includes(`    ${listSlotsStatement()}`), `${width}: gone midway, ${gone.a.stdout}`);
  }
  const asked = await run(() => answer(200, deleting("finished")), [], { terminal: 20, input: "acme/shop\n" });
  assert.equal(asked.a.code, 0, asked.a.stderr);
});

test("mason replica delete: a wrong line is exit 2 before a byte is sent — no replica, two, one outside the grammar, --yes or --timeout where they do not go, a timeout that is none", async () => {
  for (const argv of [["delete"], ["delete", "acme"], ["delete", "Acme/shop", "--yes"], ["delete", "acme/shop", "x", "--yes"], ["delete", "acme/shop", "--yes", "--timeout", "soon"],
    ["delete", "acme/shop", "--yes", "--region", "eu"], ["status", "acme/shop", "--yes"], ["status", "acme/shop", "--timeout", "1m"], ["list", "--yes"], ["remove", "acme/shop"]]) {
    const { a, requests } = await hosted(() => answer(200, deleting("finished")), [...argv, "--json"], { lines: DELETE_LINES });
    assert.equal(a.code, 2, `${argv.join(" ")}: ${a.stdout}`);
    assert.equal((JSON.parse(a.stdout) as { error: { code: string } }).error.code, "usage");
    assert.deepEqual(requests, [], argv.join(" "));
  }
  const near = await hosted(() => answer(200, deleting("finished")), ["delet", "acme/shop", "--json"], { lines: DELETE_LINES });
  assert.match((JSON.parse(near.a.stdout) as { error: { message: string } }).error.message, /did you mean `delete`\?/);
});

test("no run of mason replica delete printed a token, nor put one on its command line", () => {
  assert.ok(ANSWERS.length >= 40, `the runs above are here (${ANSWERS.length})`);
  for (const a of ANSWERS) {
    for (const s of SECRETS) assert.ok(!a.stdout.includes(s) && !a.stderr.includes(s) && !a.argv.some((x) => x.includes(s)), `mason ${a.argv.join(" ")} printed a secret`);
    assert.doesNotMatch(a.stdout + a.stderr, /masondata_(pat|ci)_[A-Za-z0-9_-]{43}/, `mason ${a.argv.join(" ")}`);
  }
});
