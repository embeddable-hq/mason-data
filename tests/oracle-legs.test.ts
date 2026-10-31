/**
 * THE ORACLE IN LEGS (scripts/oracle-legs.ts): the two legs CI runs must be the whole oracle. A statement left out, or
 * asked twice, fails `integration (oracle)`, and what a whole run asserts at its end is asserted of the legs together.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GAPS, type GapId } from "../src/duck/gaps.ts";
import { STAGES, deadGaps, foldProblems, legOf, legRefused, movedTallies, parseLeg, partitionProblems, PHASES, statementId, sumTally, verifiedDiff, wholeRunProblems, type Decision, type LegReport } from "../scripts/oracle-legs.ts";

const statements = Array.from({ length: 40 }, (_, i) => ({ group: "g", name: `statement ${i}`, sql: `SELECT ${i}` }));
/** asked in every phase and held apart from the tallies, as oracle/unordered-limit.ts's are */
const apart = [{ group: "unordered limit", name: "unordered limit: a", sql: "SELECT a LIMIT 1" }, { group: "unordered limit", name: "unordered limit: b", sql: "SELECT b LIMIT 1" }];
const whole: LegReport["whole"] = [...statements.map((q) => ({ id: statementId(q), name: q.name })), ...apart.map((q) => ({ id: statementId(q), name: q.name, apart: true as const }))];
/** every gap a whole run must meet, met in leg 1 */
const everyGap = () => ({ refused: {}, decided: Object.fromEntries((Object.keys(GAPS) as GapId[]).map((id) => [id, { planted: 1, natural: 0 }])) });
const decisions = (over: Partial<Decision> = {}): Decision[] => [{ sql: "/x/", why: "why", differed: true, decided: true, ...over }];

function report(leg: number, of = 2): LegReport {
  const mine = statements.filter((q) => legOf(q.sql, of) === leg).map(statementId);
  const mineApart = apart.filter((q) => legOf(q.sql, of) === leg).map(statementId);
  return { leg, of, whole, asked: Object.fromEntries(PHASES.map((p) => [p, [...mine, ...mineApart]])), stages: leg === 1 ? Object.fromEntries(STAGES.map((s) => [s, 5])) : {}, shaped: 3,
    tallies: { statements: mine.length, mason: { exact: mine.length }, duckdb: { exact: mine.length } }, copyPhase: { refused: {}, decided: {} }, everyAsk: leg === 1 ? everyGap() : { refused: {}, decided: {} },
    decisions: decisions({ differed: leg === 1 }), verified: [`k${leg}`], differences: 0 };
}
const legs = (): [LegReport, LegReport] => [report(1), report(2)];

test("every statement falls in exactly one leg of any number, by its text alone", () => {
  for (const n of [1, 2, 3]) {
    const counts = Array.from({ length: n }, (_, i) => statements.filter((q) => legOf(q.sql, n) === i + 1).length);
    assert.equal(counts.reduce((a, b) => a + b), statements.length);
    assert.ok(n === 1 || counts.every((n) => n > 0), `${counts}`);
  }
  assert.equal(legOf("SELECT 1", 2), legOf("SELECT 1", 2));
});

test("the legs of a whole run hold: nothing is said", () => {
  assert.deepEqual(partitionProblems(legs(), 2), []);
});

test("a statement left out of a leg fails, by name, whichever phase left it out", () => {
  for (const phase of PHASES) {
    const [a, b] = legs();
    const dropped = a.asked[phase]!.pop()!;
    const name = whole.find((s) => s.id === dropped)!.name;
    const problems = partitionProblems([a, b], 2);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems[0]!, new RegExp(`^${phase}: the legs asked \\d+ \\+ \\d+ = 41 statements, where the whole has 42$`));
    assert.equal(problems[1], `${phase}: no leg asked ${JSON.stringify(name)}`);
  }
});

test("a statement asked apart from the tallies is held to the whole like the rest, and counts in no tally", () => {
  const id = statementId(apart[0]!);
  const [a, b] = legs();
  assert.deepEqual(partitionProblems([a, b], 2), [], "the tallies are of the 40, the whole of 42");
  const holder = a.asked[PHASES[1]]!.includes(id) ? a : b;
  holder.asked[PHASES[1]] = holder.asked[PHASES[1]]!.filter((x) => x !== id);
  assert.ok(partitionProblems([a, b], 2).includes(`${PHASES[1]}: no leg asked "unordered limit: a"`));
  const [c, d] = legs();
  (c.asked[PHASES[0]]!.includes(id) ? d : c).asked[PHASES[0]]!.push(id);
  assert.match(partitionProblems([c, d], 2).join("\n"), /asked more often than the whole has it: "unordered limit: a"/);
});

test("a statement asked by both legs, or swapped for another, fails though the counts may sum", () => {
  const [a, b] = legs();
  const moved = a.asked[PHASES[0]]!.pop()!;
  a.asked[PHASES[0]]!.push(b.asked[PHASES[0]]![0]!);
  const problems = partitionProblems([a, b], 2);
  assert.deepEqual(problems, [
    `${PHASES[0]}: no leg asked ${JSON.stringify(whole.find((s) => s.id === moved)!.name)}`,
    `${PHASES[0]}: asked more often than the whole has it: ${JSON.stringify(whole.find((s) => s.id === b.asked[PHASES[0]]![0])!.name)}`,
  ]);
});

test("a statement the whole has twice is held to be asked twice", () => {
  const twice = [...whole, whole[0]!];
  const [a, b] = legs();
  a.whole = twice; b.whole = twice;
  assert.ok(partitionProblems([a, b], 2).some((p) => p.includes("no leg asked")));
});

test("a leg missing, two reports of one leg, a leg of another split, or two wholes fail", () => {
  assert.match(partitionProblems([report(1)], 2).join("\n"), /the reports are of leg\(s\) 1, where 1, 2 must each report once/);
  assert.match(partitionProblems([], 2).join("\n"), /the reports are of leg\(s\) none/);
  assert.match(partitionProblems([report(1), report(1)], 2).join("\n"), /leg\(s\) 1, 1/);
  assert.match(partitionProblems([report(1), report(2, 3)], 2).join("\n"), /leg 2 ran as one of 3/);
  const [a, b] = legs();
  b.whole = whole.slice(1);
  assert.match(partitionProblems([a, b], 2).join("\n"), /list another whole \(41 and 42 statements\)/);
});

test("a stage of one session runs in exactly one leg", () => {
  const [a, b] = legs();
  delete a.stages.settings;
  assert.deepEqual(partitionProblems([a, b], 2), ["the stage settings ran in 0 legs, where it runs whole in exactly one"]);
  const [c, d] = legs();
  d.stages.roles = 1;
  assert.deepEqual(partitionProblems([c, d], 2), ["the stage roles ran in 2 legs, where it runs whole in exactly one"]);
});

test("a tally that does not sum to the whole fails", () => {
  const [a, b] = legs();
  a.tallies.statements--;
  assert.match(partitionProblems([a, b], 2).join("\n"), /the legs' tallies count 39 statements, where the whole has 40/);
});

const fixture = { mason: { exact: 40 }, duckdb: { exact: 40 } };
const listed = new Map([["k1", "one"], ["k2", "two"]]);

test("what a whole run asserts at its end holds of the legs together, none of it of a leg alone", () => {
  assert.deepEqual(wholeRunProblems(legs(), fixture, listed), [], "a decision that differed in one leg alone is not stale, and each leg's verified keys count");
  assert.deepEqual(foldProblems(legs(), 2, fixture, listed), []);
  assert.match(wholeRunProblems([report(1)], fixture, listed).join("\n"), /verified\.ts is not what the legs verified: added \[\], dropped \["k2"\]/);
});

test("a stale decision, a dead gap, an allowlist or tallies that moved each fail the legs", () => {
  const stale = legs();
  for (const r of stale) r.decisions = decisions({ differed: false });
  assert.match(wholeRunProblems(stale, fixture, listed).join("\n"), /\/x\/: no longer differs \(why\)/);
  const unmatched = legs();
  for (const r of unmatched) r.decisions = decisions({ differed: false, decided: false });
  assert.match(wholeRunProblems(unmatched, fixture, listed).join("\n"), /\/x\/: no statement asked matches it/);
  const float = legs();
  for (const r of float) r.decisions = decisions({ differed: false, machineFloat: true });
  assert.deepEqual(wholeRunProblems(float, fixture, listed), [], "a machineFloat decision may differ nowhere on this machine, as in a whole run");

  const dead = legs();
  dead[0].everyAsk = { refused: {}, decided: {} };
  assert.match(wholeRunProblems(dead, fixture, listed).join("\n"), /src\/duck\/gaps\.ts entries no oracle statement meets/);
  const extra = legs();
  extra[1].verified.push("k3");
  assert.match(wholeRunProblems(extra, fixture, listed).join("\n"), /added \["k3"\]/);
  assert.match(wholeRunProblems(legs(), { mason: { exact: 30 }, duckdb: { exact: 40 } }, listed).join("\n"), /mason\.exact: 40 where the fixture has 30/);
});

test("the check of a partition comes first: of a part, what a whole run asserts says nothing", () => {
  const [a, b] = legs();
  a.asked[PHASES[1]]!.pop();
  a.everyAsk = { refused: {}, decided: {} };
  const problems = foldProblems([a, b], 2, fixture, listed);
  assert.ok(problems.every((p) => !p.includes("gaps.ts")), problems.join("\n"));
});

test("the sums and the helpers a whole run shares", () => {
  assert.deepEqual(sumTally([{ refused: { "show-all": { planted: 1, natural: 2 } } as never, decided: {} }, { refused: { "show-all": { planted: 3, natural: 4 } } as never, decided: {} }]).refused, { "show-all": { planted: 4, natural: 6 } });
  assert.deepEqual(movedTallies({ statements: 100, mason: { exact: 90 }, duckdb: {} }, { mason: { exact: 89 }, duckdb: {} }), [], "within a percentage point");
  assert.deepEqual(verifiedDiff(new Set(["a", "c"]), new Map([["a", ""], ["b", ""]])), { added: ["c"], dropped: ["b"] });
  assert.ok(deadGaps({ refused: {}, decided: {} }).length > 0);
  assert.deepEqual(deadGaps(everyGap()), []);
});

test("a leg names itself exactly, and refuses what reads or rewrites the whole oracle", () => {
  assert.deepEqual(parseLeg("1/2"), { leg: 1, of: 2 });
  assert.equal(parseLeg(undefined), null);
  for (const bad of ["0/2", "3/2", "1", "a/b", ""]) assert.throws(() => parseLeg(bad), /IT_ORACLE_LEG/, bad);
  assert.equal(legRefused({ IT_ORACLE_LEG: "1/2", IT_ORACLE_LEG_REPORT: "r" }), null);
  assert.equal(legRefused({ UPDATE_VERIFIED: "1" }), null, "a whole run regenerates");
  assert.match(legRefused({ IT_ORACLE_LEG: "1/2" })!, /with no IT_ORACLE_LEG_REPORT: .*Unset IT_ORACLE_LEG/);
  assert.match(legRefused({ IT_ORACLE_LEG: "1/2", UPDATE_VERIFIED: "1" })!, /with UPDATE_VERIFIED: .*Unset IT_ORACLE_LEG/);
  assert.match(legRefused({ IT_ORACLE_LEG: "1/2", UPDATE_FIXTURE: "1" })!, /UPDATE_FIXTURE/);
  assert.match(legRefused({ IT_ORACLE_LEG: "1/2", IT_ORACLE_ONLY: "x" })!, /IT_ORACLE_ONLY/);
});

test("a leg left in a shell fails the oracle's file at once, before it needs a Postgres: part of it never passes as all of it", () => {
  const { IT_ORACLE_LEG_REPORT: _report, ...env } = process.env;
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("integration/duck-oracle.itest.ts", import.meta.url))], { encoding: "utf8", env: { ...env, IT_ORACLE_LEG: "1/2" } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /IT_ORACLE_LEG=1\/2 with no IT_ORACLE_LEG_REPORT/);
});
