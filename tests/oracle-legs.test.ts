/**
 * THE ORACLE IN LEGS (scripts/oracle-legs.ts): the two legs CI runs must be the whole oracle. A statement left out, or
 * asked twice, fails `integration (oracle)`, and what a whole run asserts at its end is asserted of the legs together.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GAPS, type GapId } from "../src/duck/gaps.ts";
import { collationMet, staleDecisions } from "./integration/oracle/known.ts";
import { emptyShapeCount, NEW_SHAPES, shapeProblems, sumShapeTallies, type ShapeTally } from "./integration/oracle/shape-names.ts";
import { staleOrDead, STAGES, deadGaps, filesFromLegs, FIXTURE_FILE, foldProblems, legRefused, movedTallies, parseLeg, partitionProblems, PHASES, statementId, sumTally, VERIFIED_FILE, verifiedDiff, wholeRunProblems, runProblems, writeFromLegs, Clock, FIRST_LEG_RUNS_STAGES, partition, readWeights, timesLine, weightKey, weightsFromLegs, legScales, legsBalance, balanceLines, LEGS_APART_MS, weightsText, writeWeights, WEIGHTS_FILE, README_FILE, SUPPORT_FILE, type Decision, type LegReport, type Measured, type Tallies, type Weights } from "../scripts/oracle-legs.ts";
import { reportName } from "../scripts/ci-layout.ts";
import { VERIFIED } from "../src/duck/verified.ts";
import type { GapTally } from "./integration/oracle/gap-tally.ts";
import { README_END, README_START, renderGaps, renderReadmeSupport, spliceReadme, type AloneTallies } from "./sql-support.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const statements = Array.from({ length: 40 }, (_, i) => ({ group: "g", name: `statement ${i}`, sql: `SELECT ${i}` }));
/** asked in every phase and held apart from the tallies, as oracle/unordered-limit.ts's are */
const apart = [{ group: "unordered limit", name: "unordered limit: a", sql: "SELECT a LIMIT 1" }, { group: "unordered limit", name: "unordered limit: b", sql: "SELECT b LIMIT 1" }];
const whole: LegReport["whole"] = [...statements.map((q) => ({ id: statementId(q), name: q.name })), ...apart.map((q) => ({ id: statementId(q), name: q.name, apart: true as const }))];
/** every gap a whole run must meet, met in leg 1 */
const everyGap = () => ({ refused: {}, decided: Object.fromEntries((Object.keys(GAPS) as GapId[]).map((id) => [id, { planted: 1, natural: 0 }])) });
const decisions = (over: Partial<Decision> = {}): Decision[] => [{ sql: "/x/", why: "why", differed: true, decided: true, ...over }];

const measured: Measured = { what: "w", machine: "linux x64", postgres: "PostgreSQL 18 on x86_64-pc-linux-gnu", collation: "en_US.utf8 (c)", shapes: true };
/** no text listed: every text the default weight, the stages none */
const NONE: Weights = { stages: 0, default: 1, statements: {} };
/** weights by text, keyed as the leg measures them (`weightKey`) */
const weighted = (byText: Record<string, number>, rest = 1, stages = 0): Weights =>
  ({ stages, default: rest, statements: Object.fromEntries(Object.entries(byText).map(([sql, ms]) => [weightKey(sql), { ms, name: sql }])) });
/** each leg's load under a split: its texts' weights, leg FIRST_LEG_RUNS_STAGES's stages too */
const loads = (split: Map<string, number>, of: number, w: Weights, withStages = true): number[] => Array.from({ length: of }, (_, i) =>
  [...split].filter(([, l]) => l === i + 1).reduce((n, [sql]) => n + (w.statements[weightKey(sql)]?.ms ?? w.default), withStages && i + 1 === FIRST_LEG_RUNS_STAGES ? w.stages : 0));

function report(leg: number, of = 2, split = partition([...statements, ...apart], of, NONE)): LegReport {
  const mine = statements.filter((q) => split.get(q.sql) === leg).map(statementId);
  const mineApart = apart.filter((q) => split.get(q.sql) === leg).map(statementId);
  return { leg, of, whole, asked: Object.fromEntries(PHASES.map((p) => [p, [...mine, ...mineApart]])), stages: leg === 1 ? Object.fromEntries(STAGES.map((s) => [s, 5])) : {}, shaped: 3,
    tallies: { statements: mine.length, mason: { exact: mine.length }, duckdb: { exact: mine.length } }, copyPhase: { refused: {}, decided: {} }, everyAsk: leg === 1 ? everyGap() : { refused: {}, decided: {} },
    decisions: decisions({ differed: leg === 1 }), verified: [`k${leg}`], names: { [`k${leg}`]: leg === 1 ? "one" : "two" }, asks: 3 * (mine.length + mineApart.length) + 3, measured, differences: 0 };
}
const legs = (): [LegReport, LegReport] => [report(1), report(2)];

test("every statement falls in exactly one leg of any number, and with no weight listed the legs differ by at most one text", () => {
  for (const n of [1, 2, 3]) {
    const split = partition(statements, n, NONE);
    assert.deepEqual([...split.keys()].sort(), statements.map((q) => q.sql).sort());
    assert.ok([...split.values()].every((l) => l >= 1 && l <= n));
    const load = loads(split, n, NONE);
    assert.ok(load.every((x) => x > 0), `${load}`);
    assert.ok(Math.max(...load) - Math.min(...load) <= NONE.default, `${load}`);
  }
});

test("the heaviest texts go to different legs, and the legs differ by no more than the heaviest text", () => {
  const w = weighted({ "SELECT 0": 100, "SELECT 1": 90, "SELECT 2": 80 });
  const split = partition(statements, 2, w);
  assert.notEqual(split.get("SELECT 0"), split.get("SELECT 1"));
  const [a, b] = loads(split, 2, w);
  assert.ok(Math.abs(a! - b!) <= 100, `${a} ${b}`);
  // greedy, exactly: 100 to leg 1, 90 then 80 to leg 2 (170), and the 37 of weight 1 to leg 1, the lighter (137)
  assert.deepEqual([split.get("SELECT 0"), split.get("SELECT 1"), split.get("SELECT 2"), a, b], [1, 2, 2, 137, 170]);
});

test("the stages' cost is leg 1's head start: its statements weigh that much less, and it still has some", () => {
  const w: Weights = { ...weighted(Object.fromEntries(statements.map((q) => [q.sql, 10]))), stages: 300 };
  const split = partition(statements, 2, w);
  const [one, two] = loads(split, 2, w, false);
  assert.ok(Math.abs(two! - one! - 300) <= 10, `${one} ${two}`);
  const [a, b] = loads(split, 2, w);
  assert.ok(Math.abs(a! - b!) <= 10, `${a} ${b}`);
  assert.ok(one! > 0);
});

test("a text asked under two names is one leg's", () => {
  for (const n of [2, 3]) {
    const twice = [{ group: "g", name: "a", sql: "SELECT 7" }, ...statements, { group: "h", name: "b", sql: "SELECT 7" }];
    const split = partition(twice, n, NONE);
    assert.equal(split.size, statements.length, "one entry a text");
    const leg = split.get("SELECT 7")!;
    assert.deepEqual(twice.filter((q) => q.sql === "SELECT 7").map((q) => split.get(q.sql)), [leg, leg, leg]);
  }
});

test("the split depends on the set of texts and the weights alone, never their order", () => {
  for (const w of [NONE, weighted({ "SELECT 0": 100, "SELECT 1": 90, "SELECT 2": 80 })]) {
    const want = [...partition(statements, 2, w)].sort();
    assert.deepEqual([...partition([...statements].reverse(), 2, w)].sort(), want);
    const swapped = [...statements];
    [swapped[5], swapped[30]] = [swapped[30]!, swapped[5]!];
    assert.deepEqual([...partition(swapped, 2, w)].sort(), want);
  }
});

test("a weight for a text no statement has moves nothing; a text no weight lists is asked once at the default weight", () => {
  const w = weighted({ "SELECT 0": 100, "SELECT 1": 90 });
  const split = partition([...statements, ...apart], 2, w);
  assert.deepEqual([...partition([...statements, ...apart], 2, { ...w, statements: { ...w.statements, ...weighted({ "SELECT 999": 500 }).statements } })], [...split]);
  assert.deepEqual(partitionProblems([report(1, 2, split), report(2, 2, split)], 2), []);
  const more = [...statements, { group: "g", name: "statement 40", sql: "SELECT 40" }];
  const grown = partition([...more, ...apart], 2, w);
  assert.ok([1, 2].includes(grown.get("SELECT 40")!));
  const wholeOf = [...more.map((q) => ({ id: statementId(q), name: q.name })), ...apart.map((q) => ({ id: statementId(q), name: q.name, apart: true as const }))];
  const leg = (n: number): LegReport => {
    const mine = [...more, ...apart].filter((q) => grown.get(q.sql) === n).map(statementId);
    return { ...report(n, 2, grown), whole: wholeOf, asked: Object.fromEntries(PHASES.map((p) => [p, mine])), tallies: { statements: more.filter((q) => grown.get(q.sql) === n).length, mason: {}, duckdb: {} } };
  };
  assert.deepEqual(partitionProblems([leg(1), leg(2)], 2), []);
});

test("the unordered limits are split by the same function as the rest", () => {
  const split = partition([...statements, ...apart], 2, NONE);
  const [a, b] = legs();
  for (const q of apart) assert.ok([a, b][split.get(q.sql)! - 1]!.asked[PHASES[0]]!.includes(statementId(q)), q.name);
});

test("the committed weights are the file the legs read, and a leg's clock gives each key the time to its next lap", () => {
  const w = readWeights(ROOT);
  assert.ok(w.default > 0 && w.stages >= 0, JSON.stringify(w).slice(0, 200));
  assert.equal(fs.readFileSync(path.join(ROOT, WEIGHTS_FILE), "utf8"), weightsText(w), `${WEIGHTS_FILE} is as \`--weights\` writes it`);
  let now = 0;
  const clock = new Clock(() => now);
  clock.lap("a", "first a"); now = 5;
  clock.lap("b", "b"); now = 7;
  clock.lap("a", "second a"); now = 10;
  clock.stop(); now = 50;
  clock.stop();
  assert.deepEqual([...clock.spent], [["a", { ms: 8, name: "first a" }], ["b", { ms: 2, name: "b" }]]);
  assert.match(timesLine({ fixed: { setup: 1500 }, stages: { roles: 2000 }, statements: Object.fromEntries(clock.spent) }), /^fixed: setup 1\.5 s; stages: roles 2\.0 s; statements: 0\.0 s over 2 texts; slowest: "first a" 0\.0 s, "b" 0\.0 s$/);
});

/** the legs, each timed as a leg times itself: `SELECT 0` 120 s, every other text 200 ms, the stages in leg 1 */
const timed = (): [LegReport, LegReport] => legs().map((r): LegReport => ({ ...r, times: {
  fixed: { setup: 20000, "first sync": 5000 },
  stages: r.leg === 1 ? { roles: 30000, "row filters": 15000, settings: 1000, "setting scripts": 4000 } : {},
  statements: Object.fromEntries([...statements, ...apart].filter((q) => r.asked[PHASES[0]]!.includes(statementId(q))).map((q) => [weightKey(q.sql), { ms: q.sql === "SELECT 0" ? 120000 : 200, name: q.name }])),
} })) as LegReport[] as [LegReport, LegReport];

test("--weights lists each text above the threshold by the key the split reads, the stages' total, and the mean of the rest", () => {
  const got = weightsFromLegs(timed(), 2, "123", 1000);
  assert.ok("weights" in got, JSON.stringify(got));
  assert.deepEqual(got.weights, { from: "123", above: 1000, stages: 50000, default: 200, statements: { [weightKey("SELECT 0")]: { ms: 120000, name: "statement 0" } } });
  const split = partition([...statements, ...apart], 2, got.weights);
  const load = loads(split, 2, got.weights);
  assert.ok(Math.abs(load[0]! - load[1]!) <= 120000, `${load}`);
  assert.deepEqual([split.get("SELECT 0"), ...load], [2, 50000 + 41 * 200, 120000], "the heaviest text goes to the leg without the stages, every other text to the one with them");
  assert.equal(JSON.parse(weightsText(got.weights)).statements[weightKey("SELECT 0")].ms, 120000);
});

test("--weights counts each leg's times in one machine's milliseconds: a leg whose runner took twice the setup weighs its statements half", () => {
  // leg 1's runner slow (setup 30 s), leg 2's fast (10 s): the same setup, so leg 1's times are scaled by 20/30, leg 2's by 20/10
  const [a, b] = timed();
  const slow = { ...a, times: { ...a.times!, fixed: { setup: 30000 }, statements: Object.fromEntries(Object.entries(a.times!.statements).map(([k, x]) => [k, { ...x, ms: x.ms === 120000 ? 3000 : 300 }])) } };
  const fast = { ...b, times: { ...b.times!, fixed: { setup: 10000 }, statements: Object.fromEntries(Object.entries(b.times!.statements).map(([k, x]) => [k, { ...x, ms: x.ms === 120000 ? 3000 : 100 }])) } };
  const got = weightsFromLegs([slow, fast], 2, "7", 1000);
  assert.ok("weights" in got, JSON.stringify(got));
  const inLeg1 = a.asked[PHASES[0]]!.includes(statementId(statements[0]!));
  assert.deepEqual(got.weights, { from: "7", above: 1000, stages: Math.round(50000 * 20 / 30), default: 200,
    statements: { [weightKey("SELECT 0")]: { ms: inLeg1 ? 2000 : 6000, name: "statement 0" } } });
  // a report with no setup (or a zero one) is taken as it stands
  const unscaled = weightsFromLegs([{ ...slow, times: { ...slow.times, fixed: {} } }, fast], 2, "7", 1000);
  assert.ok("weights" in unscaled && unscaled.weights.stages === 50000 && unscaled.weights.default > 100 && unscaled.weights.default < 300, JSON.stringify(unscaled).slice(0, 300));
});

test("--weights refuses a report from before the timing, naming the leg and the run, and writes nothing; the report still serves the check and --write", (t) => {
  const [a, b] = timed();
  const { times: _t, ...old } = b;
  assert.deepEqual(weightsFromLegs([a, old], 2, "4242", 1000), { problems: ["the report of leg(s) 2 of 4242 has no times: the run predates the timing. Use a run of a commit that times its statements"] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-weights-"));
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const root = path.join(tmp, "repo"), dir = path.join(tmp, "download");
  fs.mkdirSync(path.dirname(path.join(root, WEIGHTS_FILE)), { recursive: true });
  fs.writeFileSync(path.join(root, WEIGHTS_FILE), "was\n");
  for (const r of [a, old]) { fs.mkdirSync(path.join(dir, `ran-oracle-${r.leg}`), { recursive: true }); fs.writeFileSync(path.join(dir, `ran-oracle-${r.leg}`, reportName(r.leg)), JSON.stringify(r)); }
  const refused = writeWeights(dir, root, "4242", 1000);
  assert.equal(refused.code, 1);
  assert.match(refused.err.join("\n"), /leg\(s\) 2 of 4242 has no times[\s\S]*nothing written/);
  assert.equal(fs.readFileSync(path.join(root, WEIGHTS_FILE), "utf8"), "was\n");
  assert.deepEqual(partitionProblems([a, old], 2), []);
  assert.deepEqual(foldProblems([a, old], 2, fixture, listed), []);
  const [c, d] = legsOfTheRepo();
  assert.ok(!("problems" in filesFromLegs([c, d], 2, fs.readFileSync(path.join(ROOT, VERIFIED_FILE), "utf8"))), "legs with no times still write verified.ts and the fixture");
  fs.writeFileSync(path.join(dir, "ran-oracle-2", reportName(2)), JSON.stringify(b));
  const done = writeWeights(dir, root, "4242", 1000);
  assert.equal(done.code, 0, done.err.join("\n"));
  assert.equal(fs.readFileSync(path.join(root, WEIGHTS_FILE), "utf8"), weightsText({ from: "4242", above: 1000, stages: 50000, default: 200, statements: { [weightKey("SELECT 0")]: { ms: 120000, name: "statement 0" } } }));
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
  // a decision that needs a libc source, on a run under C or ICU: met, or as a machineFloat
  const libcOnly = { sql: /x/, why: "w", kind: "value", gap: "libc-rare-letter" as const, collation: "libc" as const };
  assert.deepEqual([collationMet(libcOnly, "c", "en_US.utf8"), collationMet(libcOnly, "c", "C"), collationMet(libcOnly, "i", "en-US")], [true, false, false]);
  assert.deepEqual([collationMet({ collation: "not-c" }, "i", "en-US"), collationMet({ collation: "not-c" }, "c", "C"), collationMet({}, "c", "C")], [true, false, true]);
  const decided = new Set([libcOnly]);
  assert.deepEqual(staleDecisions([libcOnly], new Set(), decided, (k) => !collationMet(k, "c", "C")), []);
  assert.equal(staleDecisions([libcOnly], new Set(), decided, (k) => !collationMet(k, "c", "en_US.utf8")).length, 1, "under libc it must differ");
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

test("a failure of the allowlist or the fixture names the command that writes them from the legs", () => {
  const extra = legs();
  extra[1].verified.push("k3");
  assert.match(wholeRunProblems(extra, fixture, listed).join("\n"), /verified\.ts is not what the legs verified: .*Regenerate with `node scripts\/oracle-legs\.ts --write (<run-id>|\d+)`/);
  assert.match(wholeRunProblems(legs(), { mason: { exact: 30 }, duckdb: { exact: 40 } }, listed).join("\n"), /oracle-duckdb-alone\.json is not what the legs measured: .*Regenerate with `node scripts\/oracle-legs\.ts --write (<run-id>|\d+)`/);
});

/** Two legs whose sums are the committed fixture and the committed allowlist, every count split between them (the
 *  fixture's 3669 statements as the whole, partitioned by `partition` as CI's are) */
function legsOfTheRepo(): [LegReport, LegReport] {
  type Fixture = Tallies & { gaps: { copyPhase: GapTally; everyAsk: GapTally & { asked: number } }; measured: Measured };
  const was = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURE_FILE), "utf8")) as Fixture;
  const many = Array.from({ length: was.statements }, (_, i) => ({ group: "g", name: `s${i}`, sql: `SELECT ${i}` }));
  const all = many.map((q) => ({ id: statementId(q), name: q.name }));
  const half = (n: number, leg: number): number => leg === 1 ? Math.ceil(n / 2) : Math.floor(n / 2);
  const halves = <T extends Record<string, number>>(o: T, leg: number): T => Object.fromEntries(Object.entries(o).map(([k, n]) => [k, half(n, leg)])) as T;
  // leg 2 lists the gaps in the other order, and leaves out every other one (leg 1 has it whole): the sums are by id
  const split = (counts: GapTally["refused"], leg: number): GapTally["refused"] => Object.fromEntries((leg === 1 ? Object.entries(counts) : Object.entries(counts).reverse())
    .flatMap(([id, c]) => Object.keys(counts).indexOf(id) % 2 === 1 ? (leg === 1 ? [[id, c!]] : []) : [[id, halves(c!, leg)]]));
  const tally = (t: GapTally, leg: number): GapTally => ({ refused: split(t.refused, leg), decided: split(t.decided, leg) });
  const keys = [...VERIFIED.keys()];
  const legOfText = partition(many, 2, NONE);
  const leg = (n: 1 | 2): LegReport => {
    const mine = many.filter((q) => legOfText.get(q.sql) === n).map(statementId);
    const verified = keys.filter((_, i) => i % 3 === 0 || i % 2 === n - 1).reverse();   // some in both legs, in no order
    return { leg: n, of: 2, whole: all, asked: Object.fromEntries(PHASES.map((p) => [p, mine])), stages: n === 1 ? Object.fromEntries(STAGES.map((s) => [s, 1])) : {}, shaped: 0,
      tallies: { statements: mine.length, mason: halves(was.mason, n), duckdb: halves(was.duckdb, n) }, copyPhase: tally(was.gaps.copyPhase, n), everyAsk: tally(was.gaps.everyAsk, n),
      decisions: [], verified, names: Object.fromEntries(verified.map((k) => [k, VERIFIED.get(k)!])), asks: half(was.gaps.everyAsk.asked, n), measured: was.measured, differences: 0 };
  };
  return [leg(1), leg(2)];
}

test("--write gives src/duck/verified.ts and the fixture byte for byte as a whole run's UPDATE_VERIFIED=1 and UPDATE_FIXTURE=1 wrote them", () => {
  const files = filesFromLegs(legsOfTheRepo(), 2, fs.readFileSync(path.join(ROOT, VERIFIED_FILE), "utf8"));
  assert.ok(!("problems" in files), JSON.stringify(files));
  assert.equal(files.verified, fs.readFileSync(path.join(ROOT, VERIFIED_FILE), "utf8"));
  assert.equal(files.fixture, fs.readFileSync(path.join(ROOT, FIXTURE_FILE), "utf8"));
});

test("--write refuses legs that are not the whole, or that predate it, and legs measured apart", () => {
  const verifiedNow = fs.readFileSync(path.join(ROOT, VERIFIED_FILE), "utf8");
  const [a, b] = legsOfTheRepo();
  assert.match(JSON.stringify(filesFromLegs([a], 2, verifiedNow)), /the reports are of leg\(s\) 1, where 1, 2 must each report once/);
  const { names: _n, asks: _a, measured: _m, ...old } = b;
  assert.match(JSON.stringify(filesFromLegs([a, old as LegReport], 2, verifiedNow)), /leg\(s\) 2 has no names, asks or measured: the run predates/);
  assert.match(JSON.stringify(filesFromLegs([a, { ...b, measured: { ...b.measured, machine: "another machine" } }], 2, verifiedNow)), /the legs measured on different machines/);
});

/** A temp root as a checkout stands before `--write`: src/duck/verified.ts without `aggregate:2050`, the fixture `{}`,
 *  README.md's generated block saying another statement count (its hand-written text the repo's), docs/SQL-SUPPORT.md
 *  an old text. `seed()` writes them again; `seeded` is what each file was written as. */
function staleRoot(t: { after: (fn: () => void) => void }, readme?: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-write-"));
  t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
  const root = path.join(tmp, "repo"), dir = path.join(tmp, "download");
  const repoReadme = fs.readFileSync(path.join(ROOT, README_FILE), "utf8");
  const a = repoReadme.indexOf(README_START), z = repoReadme.indexOf(README_END, a);
  assert.ok(a >= 0 && z > a && repoReadme.slice(a, z).includes("6,976"), "the repo's README block says the fixture's 6,976 statements: the stale one says another");
  const seeded: Record<string, string> = {
    [VERIFIED_FILE]: fs.readFileSync(path.join(ROOT, VERIFIED_FILE), "utf8").replace(/^ {2}\["aggregate:2050".*\n/m, ""),
    [FIXTURE_FILE]: "{}\n",
    [README_FILE]: readme ?? repoReadme.slice(0, a) + repoReadme.slice(a, z).replace("6,976", "6,879") + repoReadme.slice(z),
    [SUPPORT_FILE]: "# an old SQL-SUPPORT.md\n",
  };
  const seed = (): void => { for (const [f, text] of Object.entries(seeded)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); } };
  seed();
  fs.mkdirSync(dir, { recursive: true });
  const read = (f: string): string => fs.readFileSync(path.join(root, f), "utf8");
  return { root, dir, seeded, seed, read };
}
const FOUR = [FIXTURE_FILE, VERIFIED_FILE, README_FILE, SUPPORT_FILE];
const COMMIT_FOUR = `oracle legs: read the diff, then commit the four files: ${FIXTURE_FILE}, ${VERIFIED_FILE}, ${README_FILE} and ${SUPPORT_FILE}`;

test("--write over a folder as `gh run download` leaves it: the four files rewritten to what the legs measured, and nothing when a leg is missing", (t) => {
  const { root, dir, seeded, read } = staleRoot(t);
  const reports = legsOfTheRepo();
  for (const r of reports) { fs.mkdirSync(path.join(dir, `ran-oracle-${r.leg}`), { recursive: true }); fs.writeFileSync(path.join(dir, `ran-oracle-${r.leg}`, reportName(r.leg)), JSON.stringify(r)); }
  fs.rmSync(path.join(dir, "ran-oracle-2", reportName(2)));
  const missing = writeFromLegs(dir, root);
  assert.equal(missing.code, 1);
  assert.match(missing.err.join("\n"), /nothing written/);
  for (const f of FOUR) assert.equal(read(f), seeded[f], `${f} as seeded`);
  fs.writeFileSync(path.join(dir, "ran-oracle-2", reportName(2)), JSON.stringify(reports[1]));
  const done = writeFromLegs(dir, root);
  assert.equal(done.code, 0, done.err.join("\n"));
  assert.deepEqual(done.out, [...FOUR.map((f) => `oracle legs: wrote ${f}`), COMMIT_FOUR]);
  // README.md's hand-written text is the repo's too, so the whole file is: only the block was replaced
  for (const f of FOUR) assert.equal(read(f), fs.readFileSync(path.join(ROOT, f), "utf8"), f);
  // what else a whole run asserts is said after writing, and fails
  reports[0].differences = 2;
  fs.writeFileSync(path.join(dir, "ran-oracle-1", reportName(1)), JSON.stringify(reports[0]));
  const differ = writeFromLegs(dir, root);
  assert.equal(differ.code, 1);
  assert.deepEqual(differ.out, FOUR.map((f) => `oracle legs: unchanged ${f}`));
  assert.match(differ.err.join("\n"), /written, and still wrong: 2 statement\(s\) answered differently/);
});

test("--write renders the docs from the verified list it writes, never the one the process imported", (t) => {
  const { root, dir, read } = staleRoot(t);
  const reports = legsOfTheRepo();
  for (const r of reports) { r.verified = r.verified.filter((k) => k !== "aggregate:2050"); delete r.names["aggregate:2050"]; fs.writeFileSync(path.join(dir, reportName(r.leg)), JSON.stringify(r)); }
  const done = writeFromLegs(dir, root);
  assert.equal(done.code, 0, done.err.join("\n"));
  const written = new Map([...VERIFIED].filter(([k]) => k !== "aggregate:2050"));
  assert.equal(written.size, VERIFIED.size - 1);
  const alone = JSON.parse(read(FIXTURE_FILE)) as AloneTallies;
  assert.equal(read(README_FILE), spliceReadme(fs.readFileSync(path.join(ROOT, README_FILE), "utf8"), renderReadmeSupport(GAPS, written, alone)));
  assert.match(read(README_FILE), new RegExp(`the ${(VERIFIED.size - 1).toLocaleString("en-US")} verified pieces`));
  assert.equal(read(SUPPORT_FILE), renderGaps(GAPS, written, alone));
  assert.ok(read(SUPPORT_FILE).includes(`\n## What is verified (${VERIFIED.size - 1})\n`));
  assert.notEqual(read(SUPPORT_FILE), renderGaps(GAPS, VERIFIED, alone), "not what the imported VERIFIED renders");
});

test("--write renders the docs from the tallies it writes, never the repo's fixture", (t) => {
  const { root, dir, read } = staleRoot(t);
  const reports = legsOfTheRepo();
  // 700 statements moved from exact to a wrong value in leg 1: the sums kept, the percentage moved
  reports[0].tallies.duckdb.exact! -= 700;
  reports[0].tallies.duckdb.value! += 700;
  for (const r of reports) fs.writeFileSync(path.join(dir, reportName(r.leg)), JSON.stringify(r));
  const done = writeFromLegs(dir, root);
  assert.equal(done.code, 0, done.err.join("\n"));
  const repo = JSON.parse(fs.readFileSync(path.join(ROOT, FIXTURE_FILE), "utf8")) as AloneTallies;
  const alone = JSON.parse(read(FIXTURE_FILE)) as AloneTallies;
  assert.equal(alone.duckdb.exact, repo.duckdb.exact - 700);
  const pct = (n: number): string => `${Math.round(100 * n / alone.statements)}%`;
  assert.notEqual(pct(alone.duckdb.exact), pct(repo.duckdb.exact), "the move is enough to move the rounded percentage");
  assert.ok(read(README_FILE).includes(`**DuckDB alone answers only ${pct(alone.duckdb.exact)} of them`), "the README says the legs' percentage");
  assert.ok(read(SUPPORT_FILE).includes(`| ${pct(alone.mason.exact)} | ${pct(alone.duckdb.exact)} |`) && read(SUPPORT_FILE).includes(`| ${pct(alone.mason.differs)} | ${pct(alone.duckdb.value)} |`), "the doc's comparison says the legs' numbers");
  assert.equal(read(SUPPORT_FILE), renderGaps(GAPS, VERIFIED, alone));
});

test("--write with a README that has no generated block writes nothing, naming README.md and both lines", (t) => {
  const { root, dir, seeded, read } = staleRoot(t, "# readme\n");
  for (const r of legsOfTheRepo()) fs.writeFileSync(path.join(dir, reportName(r.leg)), JSON.stringify(r));
  const got = writeFromLegs(dir, root);
  assert.equal(got.code, 1);
  assert.deepEqual(got.out, []);
  const err = got.err.join("\n");
  assert.ok(err.includes(README_FILE) && err.includes(README_START) && err.includes(README_END), err);
  assert.match(err, /nothing written/);
  for (const f of FOUR) assert.equal(read(f), seeded[f], `${f} as seeded`);
});

test("--write as a whole run: a stale decision or a dead gap writes the fixture and leaves src/duck/verified.ts and the docs as they were", (t) => {
  const { root, dir, seeded, seed, read } = staleRoot(t);
  const reports = legsOfTheRepo();
  for (const r of reports) r.decisions = [{ sql: "/x/", why: "why", differed: false, decided: true }];
  const run = (): ReturnType<typeof writeFromLegs> => {
    seed();
    for (const r of reports) fs.writeFileSync(path.join(dir, reportName(r.leg)), JSON.stringify(r));
    return writeFromLegs(dir, root);
  };
  const notRendered = `oracle legs: ${README_FILE} and ${SUPPORT_FILE} not rendered either, since ${VERIFIED_FILE} was not written: once it is, render them with \`UPDATE_FIXTURE=1 node --test --test-timeout=300000 --test-force-exit tests/duck-gaps.test.ts\` and read the diff`;
  const decided = run();
  assert.equal(decided.code, 1);
  assert.deepEqual(decided.out, [`oracle legs: wrote ${FIXTURE_FILE}`]);
  assert.match(decided.err.join("\n"), /no longer differs[\s\S]*src\/duck\/verified\.ts not written/);
  assert.ok(decided.err.includes(notRendered), decided.err.join("\n"));
  for (const f of [VERIFIED_FILE, README_FILE, SUPPORT_FILE]) assert.equal(read(f), seeded[f], `${f} is left as it was`);
  assert.equal(read(FIXTURE_FILE), fs.readFileSync(path.join(ROOT, FIXTURE_FILE), "utf8"), "the fixture is written first, as a whole run's");
  for (const r of reports) { r.decisions = []; r.everyAsk = { refused: {}, decided: {} }; }
  const dead = run();
  assert.equal(dead.code, 1);
  assert.match(dead.err.join("\n"), /entries no oracle statement meets/);
  assert.ok(dead.err.includes(notRendered), dead.err.join("\n"));
  for (const f of [VERIFIED_FILE, README_FILE, SUPPORT_FILE]) assert.equal(read(f), seeded[f], `${f} is left as it was`);
});

test("the renderers' module, which --write imports, registers no test of its own", () => {
  // run as a plain module, a node:test test it reached (a test file imported) would run and print its report
  // outside this run's test context (NODE_TEST_CONTEXT would make a child report to it), and never rewriting a fixture
  const { UPDATE_FIXTURE: _u, NODE_TEST_CONTEXT: _c, ...env } = process.env;
  const plain = (file: string) => spawnSync(process.execPath, [path.join(ROOT, file)], { encoding: "utf8", timeout: 120_000, env });
  const run = plain("tests/sql-support.ts");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "");
  // the probe sees a test where there is one
  assert.match(plain("tests/duck-gaps.test.ts").stdout, /\btests [1-9]\d*\b/);
});

test("--write <run-id> takes only a finished run of the commit checked out: another push's or branch's legs measured another tree", () => {
  const head = "a".repeat(40);
  assert.deepEqual(runProblems({ headSha: head, status: "completed", conclusion: "failure" }, head), [], "a run whose oracle failed is the one to write from");
  assert.match(runProblems({ headSha: "b".repeat(40), status: "completed", conclusion: "success" }, head).join("\n"), /the run is of commit b{40}, where this checkout is at a{40}/);
  assert.match(runProblems({ headSha: head, status: "in_progress", conclusion: null }, head).join("\n"), /has not finished \(in_progress\)/);
  assert.equal(runProblems({}, head).length, 2, "a view that says nothing is refused");
});

test("the shapes' tallies are summed across the legs: a dead or misspelt new shape fails by name, a shape decision merges apart from a base one", () => {
  const live = (): NonNullable<LegReport["shapeTally"]> => Object.fromEntries(Object.entries(NEW_SHAPES).map(([s, spec]) => [s, { ...emptyShapeCount(), asked: 2,
    ...(spec.life === "answer" ? { answeredAlike: 1 } : { refusedAlike: { [spec.may[0]!]: 1 }, postgresRefused: { [spec.may[0]!]: 1 } }) }]));
  const [a, b] = legs();
  assert.deepEqual(staleOrDead([{ ...a, shapeTally: live() }, { ...b, shapeTally: {} }]), [], "alive in one leg is alive");
  const dead = { ...live(), "char-arm": { ...emptyShapeCount(), asked: 40, refusedByGap: 40 } };
  assert.match(staleOrDead([{ ...a, shapeTally: dead }, { ...b, shapeTally: {} }]).join("\n"), /the shape char-arm is dead/);
  const misspelt = { ...live(), "values-arm": { ...emptyShapeCount(), asked: 30, refusedAlike: { "42804": 30 }, postgresRefused: { "42804": 30 } } };
  const said = staleOrDead([{ ...a, shapeTally: misspelt }, { ...b, shapeTally: {} }]).join("\n");
  assert.match(said, /the shape values-arm is dead/);
  assert.match(said, /the shape values-arm is misspelt: Postgres refused it 30 time\(s\) with 42804/);
  assert.deepEqual(staleOrDead([{ ...a, shapeTally: dead, measured: { ...measured, shapes: false } }, { ...b, shapeTally: {}, measured: { ...measured, shapes: false } }]), [], "shapes off: no shape check");
  assert.match(staleOrDead([{ ...a, shapeTally: live() }, b]).join("\n"), /leg\(s\) 2 has no shape tally where another has/);
  // a base entry /x/ and a shape entry of the same pattern are two decisions: the shape's, differing in neither leg, is stale
  const withShape = (r: LegReport, differed: boolean): LegReport => ({ ...r, shapeTally: r.leg === 1 ? live() : {}, decisions: [...r.decisions, { sql: "/x/", shape: "integer-arm", kind: "text", why: "a scale", differed, decided: true }] });
  assert.deepEqual(staleOrDead([withShape(a, false), withShape(b, true)]), [], "the shape entry differed in leg 2");
  assert.deepEqual(staleOrDead([withShape(a, false), withShape(b, false)]), ["a decided difference that no longer differs: [integer-arm] text /x/: no longer differs (a scale) — remove it from KNOWN"]);
  // PR 261's merged run: one group and pattern, two kinds (#247's padding as a value and as a kept row). The rows entry
  // no longer differs on the merged tree; keyed by its kind it is said stale, never hidden behind the value entry
  const kinds = (r: LegReport): LegReport => ({ ...r, shapeTally: r.leg === 1 ? live() : {}, decisions: [...r.decisions,
    { sql: "/[\\s\\S]/", shape: "char-arm, char-arm-first", kind: "value", issue: 247, why: "padding", differed: true, decided: true },
    { sql: "/[\\s\\S]/", shape: "char-arm, char-arm-first", kind: "rows", issue: 247, why: "a row kept", differed: false, decided: true }] });
  assert.deepEqual(staleOrDead([kinds(a), kinds(b)]), ["a decided difference that no longer differs: [char-arm, char-arm-first] rows /[\\s\\S]/: no longer differs (a row kept) — remove it from KNOWN, and say on #247 that it no longer differs (on this tree: main may have fixed it)"]);
});

test("every shape's liveness can be reached by deciding a difference the base already has: a refusal shape lives by a decided refusal under its SQLSTATE, an answer shape by no refusal", () => {
  const live = (): ShapeTally => Object.fromEntries(Object.entries(NEW_SHAPES).map(([s, spec]) => [s, { ...emptyShapeCount(), asked: 2,
    ...(spec.life === "answer" ? { answeredAlike: 1 } : { refusedAlike: { [spec.may[0]!]: 1 }, postgresRefused: { [spec.may[0]!]: 1 } }) }]));
  // issue 119's base difference: Postgres refuses a negative LIMIT 2201W and a negative OFFSET 2201X, Mason both 42804
  const base: ShapeTally = { ...live(),
    "count-negative": { ...emptyShapeCount(), asked: 3, postgresRefused: { "2201W": 3 }, differs: 3 },
    "offset-negative": { ...emptyShapeCount(), asked: 3, postgresRefused: { "2201X": 3 }, differs: 3 } };
  assert.deepEqual(shapeProblems(base).map((p) => p.split(":")[0]), ["the shape count-negative is dead", "the shape offset-negative is dead"], "undecided, they are dead");
  assert.match(shapeProblems(base)[0]!, /recorded in KNOWN with `shape` and `issue`/, "the message names the response a PR may take");
  // decided (KNOWN with `shape` and `issue: 119`): the itest counts each under Postgres's SQLSTATE, and they live
  const decided: ShapeTally = { ...live(),
    "count-negative": { ...emptyShapeCount(), asked: 3, postgresRefused: { "2201W": 3 }, decided: 3, decidedRefused: { "2201W": 3 } },
    "offset-negative": { ...emptyShapeCount(), asked: 3, postgresRefused: { "2201X": 3 }, decided: 3, decidedRefused: { "2201X": 3 } } };
  assert.deepEqual(shapeProblems(decided), []);
  // across legs: the decided refusals are summed by SQLSTATE
  assert.deepEqual(sumShapeTallies([decided, decided])["count-negative"]!.decidedRefused, { "2201W": 6 });
  // a decided refusal under ANOTHER SQLSTATE keeps no refusal shape alive, and a decided refusal keeps no answer shape alive
  const other: ShapeTally = { ...decided, "count-negative": { ...emptyShapeCount(), asked: 3, postgresRefused: { "2201W": 3 }, decided: 3, decidedRefused: { "2201X": 3 } } };
  assert.match(shapeProblems(other).join("\n"), /the shape count-negative is dead/);
  const refusedOnly: ShapeTally = { ...live(), "table-arm": { ...emptyShapeCount(), asked: 2, postgresRefused: { "42883": 2 }, decided: 2, decidedRefused: { "42883": 2 } } };
  assert.match(shapeProblems(refusedOnly).join("\n"), /the shape table-arm is dead/);
  // an answer shape whose every ask Postgres answered and Mason differed from by a decided difference lives
  assert.deepEqual(shapeProblems({ ...live(), "integer-arm": { ...emptyShapeCount(), asked: 2, decided: 2 } }), []);
  // count-null computes every row: a row past the base's bound Postgres cannot compute (22P02, PR 261's first run) is
  // what its text means, not a misspelling; a syntax error still is
  const unbounded = (code: string): ShapeTally => ({ ...live(), "count-null": { ...emptyShapeCount(), asked: 3, answeredAlike: 2, refusedAlike: { [code]: 1 }, postgresRefused: { [code]: 1 } } });
  assert.deepEqual(shapeProblems(unbounded("22P02")), []);
  assert.deepEqual(shapeProblems(unbounded("22012")), []);
  assert.match(shapeProblems(unbounded("42601")).join("\n"), /the shape count-null is misspelt: Postgres refused it 1 time\(s\) with 42601/);
});

// THE LEGS' BALANCE (issue 326): the folder check says how far apart the legs ran, in one machine's seconds, and warns past
// LEGS_APART_MS; a cost, never coverage. Each leg's load is its statements and stages; the setup scales it (`legScales`)
/** the legs of `timed()`, leg n's setup and its statements and stages totalling `load[n - 1]` ms as run (one text and
 *  one stage carry it), and its CPU when given */
const balanced = (setup: number[], load: number[], cpu: Array<string | undefined> = []): LegReport[] => setup.map((ms, i) => {
  const r = report(i + 1, setup.length, partition([...statements, ...apart], setup.length, NONE));
  return { ...r, times: { fixed: { setup: ms, "first sync": 5000 }, stages: i === 0 ? { roles: 1000 } : {},
    statements: { [weightKey(`SELECT ${i}`)]: { ms: load[i]! - (i === 0 ? 1000 : 0), name: `statement ${i}` } }, ...(cpu[i] === undefined ? {} : { cpu: cpu[i] }) } };
});
const warning = (lines: string[]): string[] => lines.filter((l) => l.startsWith("::warning"));

test("balance: one scale of a leg's times to one machine's, the mean setup over its own, UNKNOWN with no setup; --weights reads the same", () => {
  assert.deepEqual(legScales(balanced([30000, 10000], [1, 1])), [20000 / 30000, 20000 / 10000]);
  for (const setup of [[0, 10000], [10000, -1]]) assert.equal(legScales(balanced(setup, [1, 1])), null, `${setup}`);
  const [a, b] = balanced([30000, 10000], [1, 1]);
  assert.equal(legScales([{ ...a!, times: { ...a!.times!, fixed: {} } }, b!]), null);
  const { times: _t, ...old } = b!;
  assert.equal(legScales([a!, old]), null);
  assert.equal(legScales([]), null);
});

test("balance: equal runners and a balanced load, 10 s apart: said, no warning", () => {
  const lines = balanceLines(balanced([60000, 60000], [600000, 610000]), "123");
  assert.deepEqual(warning(lines), []);
  assert.match(lines.join("\n"), /oracle legs: balance: 10\.0 s apart as run, 10\.0 s in one machine's seconds \(the target: 60\.0 s or less\)/);
  assert.match(lines[0]!, /^oracle leg 1: balance: setup 60\.0 s; statements and stages 600\.0 s as run, 600\.0 s in one machine's seconds; runner: not reported$/);
});

test("balance: leg 1 on a 1.24x faster runner with the same work (run 41393151088's shape) is 152 s apart as run and 26 s scaled: no warning", () => {
  const b = legsBalance(balanced([55200, 68300], [520400, 672800], ["AMD EPYC 7763 64-Core Processor × 4", "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz × 4"]));
  assert.ok(b.measured, JSON.stringify(b));
  assert.equal(Math.round(b.apartAsRun / 1000), 152);
  assert.equal(Math.round(b.apart / 1000), 26);
  assert.ok(b.apart < LEGS_APART_MS);
  const lines = balanceLines(balanced([55200, 68300], [520400, 672800], ["AMD EPYC 7763 64-Core Processor × 4", "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz × 4"]), "123");
  assert.deepEqual(warning(lines), []);
  assert.match(lines[0]!, /runner: AMD EPYC 7763 64-Core Processor × 4$/);
  assert.match(lines[1]!, /^oracle leg 2: balance: setup 68\.3 s; statements and stages 672\.8 s as run, 608\.\d s in one machine's seconds; runner: Intel/);
});

// ISSUE 347: one run past the target is never an order to rebalance from it. The warning branches on ONE fact,
// `alikeRunners` of the measured Balance: every leg's CPU reported and the same string. Not alike (or unknown): no
// command at all; alike: the command, conditioned on earlier runs on matching CPUs also past the target
const EPYC_7763 = "AMD EPYC 7763 64-Core Processor × 4";
const EPYC_9V74 = "AMD EPYC 9V74 80-Core Processor × 4";
/** the warning invites no rebalance from this run: no `--weights` command, no run id as one, no "rebalance with" */
const noRebalanceCommand = (line: string, runId: string): void => {
  assert.doesNotMatch(line, /--weights/, line);
  assert.doesNotMatch(line, /oracle-legs\.ts/, line);
  assert.doesNotMatch(line, /rebalance with/, line);
  assert.doesNotMatch(line, /<run-id>/, line);
  assert.ok(!line.includes(` ${runId}\``) && !line.includes(`${runId} `), line);
};
/** the not-alike warning's substance: the gap, the target, each leg's CPU, the setup under-reading a newer CPU, and the
 *  rule to rebalance only on a gap that persists across runs on matching CPUs */
const saysReadBesideTheCpus = (line: string, gap: string, cpus: string[]): void => {
  assert.match(line, /^::warning title=oracle legs::/, line);
  assert.ok(line.includes(`${gap} apart in one machine's seconds`) && line.includes("past the target of 60.0 s"), line);
  cpus.forEach((cpu, i) => assert.ok(line.includes(`leg ${i + 1}: ${cpu}`), `leg ${i + 1}'s CPU: ${line}`));
  assert.match(line, /under-read a newer CPU/, line);
  assert.match(line, /persists across runs whose legs ran on matching CPUs/, line);
};

test("balance: a gap past the target on different CPUs never names --weights (issue 347, PR 332's runs' shape)", () => {
  const legs = balanced([55200, 68300], [700000, 520000], [EPYC_7763, EPYC_9V74]);
  const b = legsBalance(legs);
  assert.ok(b.measured && b.alikeRunners === false && b.apart > LEGS_APART_MS, JSON.stringify(b));
  for (const runId of ["123", undefined]) {
    const lines = balanceLines(legs, runId);
    assert.equal(warning(lines).length, 1, lines.join("\n"));
    const w = warning(lines)[0]!;
    saysReadBesideTheCpus(w, `${(b.apart / 1000).toFixed(1)} s`, [EPYC_7763, EPYC_9V74]);
    noRebalanceCommand(w, "123");
    // the per-leg lines and the gap line as they were
    assert.deepEqual(lines.filter((l) => !l.startsWith("::warning")), [
      `oracle leg 1: balance: setup 55.2 s; statements and stages 700.0 s as run, ${(700000 * 61750 / 55200 / 1000).toFixed(1)} s in one machine's seconds; runner: ${EPYC_7763}`,
      `oracle leg 2: balance: setup 68.3 s; statements and stages 520.0 s as run, ${(520000 * 61750 / 68300 / 1000).toFixed(1)} s in one machine's seconds; runner: ${EPYC_9V74}`,
      `oracle legs: balance: 180.0 s apart as run, ${(b.apart / 1000).toFixed(1)} s in one machine's seconds (the target: 60.0 s or less)`,
    ]);
  }
});

test("balance: a CPU not reported is never alike: one leg's or every leg's, 120 s apart, warns without --weights", () => {
  const one = legsBalance(balanced([68000, 68000], [750000, 630000], ["x × 4", undefined]));
  assert.ok(one.measured && one.alikeRunners === false, JSON.stringify(one));
  const oneLines = balanceLines(balanced([68000, 68000], [750000, 630000], ["x × 4", undefined]), "123");
  assert.equal(warning(oneLines).length, 1, oneLines.join("\n"));
  saysReadBesideTheCpus(warning(oneLines)[0]!, "120.0 s", ["x × 4", "not reported"]);
  noRebalanceCommand(warning(oneLines)[0]!, "123");
  // the base's 120 s legs, which report no CPU at all: once a warning naming --weights 123, now not alike
  const none = balanced([68000, 68000], [750000, 630000]);
  const noneB = legsBalance(none);
  assert.ok(noneB.measured && noneB.alikeRunners === false, JSON.stringify(noneB));
  const lines = balanceLines(none, "123");
  assert.equal(warning(lines).length, 1, lines.join("\n"));
  saysReadBesideTheCpus(warning(lines)[0]!, "120.0 s", ["not reported", "not reported"]);
  noRebalanceCommand(warning(lines)[0]!, "123");
  assert.deepEqual(lines.filter((l) => !l.startsWith("::warning")), [
    "oracle leg 1: balance: setup 68.0 s; statements and stages 750.0 s as run, 750.0 s in one machine's seconds; runner: not reported",
    "oracle leg 2: balance: setup 68.0 s; statements and stages 630.0 s as run, 630.0 s in one machine's seconds; runner: not reported",
    "oracle legs: balance: 120.0 s apart as run, 120.0 s in one machine's seconds (the target: 60.0 s or less)",
  ]);
});

test("balance: a real imbalance on matching CPUs, 120 s apart, warns once: rebalance only when earlier runs on matching CPUs were past the target too, then --weights with this run, or <run-id> outside CI", () => {
  const legs120 = balanced([68000, 68000], [750000, 630000], [EPYC_7763, EPYC_7763]);
  const b = legsBalance(legs120);
  assert.ok(b.measured && b.alikeRunners === true, JSON.stringify(b));
  const lines = balanceLines(legs120, "123");
  assert.deepEqual(lines.filter((l) => !l.startsWith("::warning")), [
    `oracle leg 1: balance: setup 68.0 s; statements and stages 750.0 s as run, 750.0 s in one machine's seconds; runner: ${EPYC_7763}`,
    `oracle leg 2: balance: setup 68.0 s; statements and stages 630.0 s as run, 630.0 s in one machine's seconds; runner: ${EPYC_7763}`,
    "oracle legs: balance: 120.0 s apart as run, 120.0 s in one machine's seconds (the target: 60.0 s or less)",
  ]);
  assert.equal(warning(lines).length, 1, lines.join("\n"));
  const w = warning(lines)[0]!;
  assert.match(w, /^::warning title=oracle legs::the legs are 120\.0 s apart in one machine's seconds, past the target of 60\.0 s/);
  assert.ok(w.includes(EPYC_7763), w);
  // conditioned before the command, never an unconditional order from this run
  const command = w.indexOf("`node scripts/oracle-legs.ts --weights 123`");
  assert.ok(command > 0, w);
  assert.match(w.slice(0, command), /one run is not enough/);
  assert.match(w.slice(0, command), /earlier runs whose legs ran on matching CPUs were also past the target/);
  assert.ok(w.includes("tests/fixtures/oracle-weights.json"), w);
  assert.doesNotMatch(w, /rebalance with|from this run's oracle legs/);
  const outside = warning(balanceLines(legs120, undefined));
  assert.equal(outside.length, 1);
  assert.match(outside[0]!, /`node scripts\/oracle-legs\.ts --weights <run-id>`/);
});

test("balance: not measured, and why, never a gap of 0 or a scale of 1: a report with no times, a setup missing or 0, the legs not each present once", () => {
  const [a, b] = balanced([60000, 60000], [600000, 900000]);
  const { times: _t, ...old } = b!;
  assert.deepEqual(balanceLines([a!, old], "1"), ["oracle legs: balance: not measured: the report of leg(s) 2 has no times (a run from before the timing)"]);
  for (const fixed of [{}, { setup: 0 }]) {
    const lines = balanceLines([a!, { ...b!, times: { ...b!.times!, fixed } }], "1");
    assert.deepEqual(lines, ["oracle legs: balance: not measured: the report of leg(s) 2 has no setup time to scale by"], JSON.stringify(fixed));
  }
  assert.match(balanceLines([b!], "1")[0]!, /^oracle legs: balance: not measured: the reports are of leg\(s\) 2, not each leg of 2 once$/);
  assert.match(balanceLines([], "1")[0]!, /not measured: the reports are of leg\(s\) none/);
  // --weights over the same reports still scales by 1, as it did before the shared scale
  const t = timed();
  const noSetup = weightsFromLegs([{ ...t[0], times: { ...t[0].times!, fixed: { setup: 0 } } }, t[1]], 2, "7", 1000);
  assert.ok("weights" in noSetup && noSetup.weights.stages === 50000 && noSetup.weights.default === 200, JSON.stringify(noSetup).slice(0, 300));
});

test("balance: three legs, every leg named and the gap the heaviest scaled load less the lightest", () => {
  const three = balanced([40000, 60000, 80000], [400000, 600000, 1000000]);
  const b = legsBalance(three);
  assert.ok(b.measured, JSON.stringify(b));
  // mean setup 60 s: scales 1.5, 1, 0.75; loads 600, 600, 750 s
  assert.deepEqual(b.legs.map((l) => [l.leg, Math.round(l.scaled)]), [[1, 600000], [2, 600000], [3, 750000]]);
  assert.equal(Math.round(b.apart), 150000);
  assert.equal(b.apartAsRun, 600000);
  const lines = balanceLines(three, "9");
  assert.deepEqual(lines.filter((l) => /^oracle leg \d: balance/.test(l)).map((l) => l.slice(0, 12)), ["oracle leg 1", "oracle leg 2", "oracle leg 3"]);
  assert.equal(warning(lines).length, 1);
  noRebalanceCommand(warning(lines)[0]!, "9");
});

test("balance: three legs, two alike and one not, are not alike; all three alike, the conditional --weights", () => {
  const mixed = balanced([40000, 60000, 80000], [400000, 600000, 1000000], ["a × 4", "a × 4", "b × 4"]);
  const m = legsBalance(mixed);
  assert.ok(m.measured && m.alikeRunners === false, JSON.stringify(m));
  const lines = balanceLines(mixed, "9");
  assert.equal(warning(lines).length, 1, lines.join("\n"));
  saysReadBesideTheCpus(warning(lines)[0]!, "150.0 s", ["a × 4", "a × 4", "b × 4"]);
  noRebalanceCommand(warning(lines)[0]!, "9");
  const same = balanced([40000, 60000, 80000], [400000, 600000, 1000000], ["a × 4", "a × 4", "a × 4"]);
  const s = legsBalance(same);
  assert.ok(s.measured && s.alikeRunners === true, JSON.stringify(s));
  const alike = warning(balanceLines(same, "9"));
  assert.equal(alike.length, 1);
  assert.match(alike[0]!, /earlier runs whose legs ran on matching CPUs were also past the target[\s\S]*`node scripts\/oracle-legs\.ts --weights 9`/);
});

test("balance: below the target, alike or not, no warning; the lines as they were", () => {
  for (const cpu of [["a × 4", "b × 4"], ["a × 4", "a × 4"], [undefined, undefined]]) {
    const lines = balanceLines(balanced([60000, 60000], [600000, 610000], cpu), "123");
    assert.deepEqual(warning(lines), [], JSON.stringify(cpu));
    assert.equal(lines.length, 3);
    assert.equal(lines[2], "oracle legs: balance: 10.0 s apart as run, 10.0 s in one machine's seconds (the target: 60.0 s or less)");
  }
});

test("the runner's CPU: on the time line when reported, the line as before when not; never in `measured`, so --write and --weights take legs of different CPUs", () => {
  const t = { fixed: { setup: 1500 }, stages: {}, statements: {} };
  assert.equal(timesLine(t), "fixed: setup 1.5 s; stages: none; statements: 0.0 s over 0 texts; slowest: none");
  assert.equal(timesLine({ ...t, cpu: "AMD EPYC 7763 64-Core Processor × 4" }), "fixed: setup 1.5 s; stages: none; statements: 0.0 s over 0 texts; slowest: none; runner: AMD EPYC 7763 64-Core Processor × 4");
  const [c, d] = legsOfTheRepo();
  const cpus = [{ ...c, times: { ...t, cpu: "AMD EPYC 7763 64-Core Processor × 4" } }, { ...d, times: { ...t, cpu: "Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz × 4" } }];
  assert.ok(!("problems" in filesFromLegs(cpus, 2, fs.readFileSync(path.join(ROOT, VERIFIED_FILE), "utf8"))), "legs of different CPUs, measured alike, write verified.ts and the fixture");
  assert.ok(!("problems" in filesFromLegs([cpus[0]!, d], 2, fs.readFileSync(path.join(ROOT, VERIFIED_FILE), "utf8"))), "one leg with a CPU and one without");
  const [a, b] = timed();
  const got = weightsFromLegs([{ ...a, times: { ...a.times!, cpu: "x × 4" } }, b], 2, "123", 1000);
  assert.deepEqual(got, weightsFromLegs(timed(), 2, "123", 1000), "a CPU moves no weight");
});
