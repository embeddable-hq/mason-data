/**
 * A SESSION'S SETTINGS ACROSS ITS TRANSACTIONS (GitHub issue 47), held message by message: each script is one session,
 * its steps sent IN ORDER to Postgres and to Mason, and every step's whole reply must be equal — the warnings, the
 * ParameterStatus and where it falls, the tags, the rows, the refusals and the ReadyForQuery's status, none of which
 * `ask` sees. A step is a simple Query (its string), a batch of statements up to one Sync (`pipeline`: Postgres ends a
 * transaction differently there), a named statement Parsed and later run, the reverted setting in between, or one
 * message of the extended protocol, which is what a failed block holds to its end.
 */
import type pg from "pg";
import { GAP_MARK, type GapId } from "../../../src/duck/gaps.ts";

/** a named statement run (Bind, Describe, Execute); `refused`: Mason's reply must be the 0A000 naming that gap
 *  (src/duck/gaps.ts), where Postgres answers — the step met as a refusal by name, never held equal */
export type Run = { run: string; values?: Array<string | null>; refused?: GapId };
export type Step = string | { pipeline: string[] } | { prepare: string; sql: string } | Run
  /** a Parse, Bind and Execute of a row count of one, then `then`'s statements, in one batch */
  | { suspend: string; then: string[] }
  /** a named statement bound to a named portal, and that portal's own messages, each to its own Sync */
  | { bind: string; portal: string } | { execute: string } | { describePortal: string }
  /** a Describe or a Close of a named statement */
  | { describe: string } | { close: string };
export interface SettingScript { name: string; steps: Step[] }

const APP = "SHOW application_name";
const ZONE = "SHOW TimeZone";
const PATH = "SHOW search_path";
const MEM = "SHOW work_mem";
const ALL = "SELECT current_setting('application_name') AS app, current_setting('TimeZone') AS tz, current_setting('work_mem') AS mem, current_setting('search_path') AS path";
const BESIDE = `${ALL} FROM public.one`;
/** read after a revert: the zone a timestamptz is written in, truncated in and read by name, beside a table */
const ORDERS = "SELECT id FROM public.orders ORDER BY id";
/** a block with a value to revert, failed */
const FAILED: Step[] = ["BEGIN", "SET application_name = 'a'", "SELECT 1/0"];
const ZONED = "SELECT created_at, date_trunc('day', created_at) AS day, current_setting('TimeZone') AS tz, current_setting('application_name') AS app FROM public.orders ORDER BY id LIMIT 2";

const s = (name: string, ...steps: Step[]): SettingScript => ({ name, steps });

/** a text[] parameter as a json read's path, spelled as a driver sends it, and the values it is bound to */
const PATH_PARAMETERS: Array<[string, string]> = [
  ["a list", "SELECT id, jb #>> $1::text[] AS a, j #>> $1::text[] AS b, jb #> $1::text[] AS c, j #> $1::text[] AS d FROM public.jpath ORDER BY id"],
  ["inferred", "SELECT id, jb #>> $1 AS a FROM public.jpath ORDER BY id"],
  ["grouped by its output name", "SELECT jb #>> $1::text[] AS v, count(*) FROM public.jpath GROUP BY 1 ORDER BY v"],
  ["filtered", "SELECT id FROM public.jpath WHERE j #>> $1::text[] = 'alpha' ORDER BY id"],
  ["VARIADIC", "SELECT id, jsonb_extract_path_text(jb, VARIADIC $1::text[]), json_extract_path(j, VARIADIC $1::text[]) FROM public.jpath ORDER BY id"],
];
const PATH_VALUES = ["{k}", "{o,b}", "{a,0}", "{a,-1}", "{0}", "{}", "{k,NULL}", null];

/** a text[] parameter DuckDB's list cannot hold as Postgres read it, refused by name, then one it can, run on */
const TEXT_ARRAY_PARAMETERS: Array<[string, string]> = [
  ["in ANY", "SELECT id FROM public.jpath WHERE id::text = ANY($1::text[]) ORDER BY id"],
  ["read whole", "SELECT $1::text[], array_to_string($1::text[], '|'), ($1::text[])[2], array_position($1::text[], '1') FROM public.one"],
];
/** a numeric parameter beside a value the engine holds exactly (issue 214): each statement parsed once and run with
 *  each value — one the column's type holds, one past its scale, past its digits, NaN, ±Infinity, NULL */
const NUMERIC_PARAMETERS: Array<[string, string, Array<Array<string | null>>]> = [
  ["= of a numeric(30,20)", "SELECT id FROM public.pnums WHERE x = $1 ORDER BY id",
    [["2.5"], ["1.00000000000000000001"], ["1.000000000000000000015"], ["2.50000000000000000000000"], ["12345678901.5"], ["NaN"], ["Infinity"], [null]]],
  ["every comparison in the list", "SELECT id, x = $1, x <> $1, x IS DISTINCT FROM $1, nullif(x, $1), CASE x WHEN $1 THEN 'hit' ELSE 'miss' END, x < $1, x >= $1 FROM public.pnums ORDER BY id",
    [["1.00000000000000000001"], ["1.000000000000000000015"], [null], ["NaN"], ["-Infinity"]]],
  ["< and > of a numeric(30,20)", "SELECT id FROM public.pnums WHERE x < $1 OR x > $2 ORDER BY id",
    [["1.000000000000000000015", "2.5"], ["NaN", "-Infinity"], ["99999999999999999999999999999999999999999", "1.00000000000000000001"]]],
  ["BETWEEN and IN", "SELECT id FROM public.pnums WHERE x BETWEEN $1 AND $2 OR x IN ($3, $4) ORDER BY id",
    [["1.000000000000000000005", "1.000000000000000000015", "5", "2.5"], ["1.00000000000000000001", "1.00000000000000000002", "1.000000000000000000015", null]]],
  ["a cast with a typmod on the parameter", "SELECT id FROM public.pnums WHERE x = $1::numeric(30,20) ORDER BY id", [["1.000000000000000000015"], ["2.5"]]],
  ["an integer and an expression", "SELECT id FROM public.pnums WHERE id < $1::numeric OR x * 2 = $2 ORDER BY id", [["2.99999999999999999999", "2.00000000000000000002"], ["3", "10"]]],
  ["a sum in a HAVING", "SELECT count(*) FROM (SELECT id % 2 AS g, sum(x) AS s FROM public.pnums GROUP BY 1 HAVING sum(x) = $1) h", [["3.50000000000000000001"], ["9.00000000000000000002"], ["3.5"]]],
  ["an unconstrained numeric and a numeric(65,30)", "SELECT id FROM public.pnums WHERE u = $1 OR w < $2 ORDER BY id",
    [["1.2345", "19.995"], ["1.23450000000000000001", "19.99"], ["NaN", "123456789012345678901234567890.251"], [null, "Infinity"]]],
];

const TEXT_ARRAY_STEPS: Step[] = [{ run: "p", values: ["{{1},{2}}"], refused: "multidim-array" }, { run: "p", values: ["[2:3]={1,2}"], refused: "array-lower-bound" }, { run: "p", values: ["{1,2}"] }];

export const SETTING_SCRIPTS: SettingScript[] = [
  // a type the copy holds as another: a statement parsed in one zone, run after a SET of another. A literal with no zone
  // is the Parse's offset (Postgres folds it there); a value written in the session's zone is the run's
  s("a timetz parsed in one zone and run in another", "SET TimeZone = 'Asia/Kolkata'", { prepare: "p", sql: "SELECT id, tz, tz::text FROM public.mapped WHERE tz <> '12:30:00' ORDER BY tz, id" },
    "SET TimeZone = 'America/New_York'", { run: "p" }, "SET TimeZone = 'UTC'", { run: "p" }),
  // a time cast implicitly to a timetz takes the EXECUTION's zone and date, as the explicit cast does (issue 167)
  s("a time cast implicitly to a timetz, parsed in one zone and run in another", "SET TimeZone = 'Asia/Kolkata'",
    { prepare: "p", sql: "SELECT id, COALESCE(NULL::timetz, tm), tm = '12:30:00.5+05:30'::timetz FROM public.typed WHERE id IN (2, 101) ORDER BY id" },
    { run: "p" }, "SET TimeZone = 'America/New_York'", { run: "p" }),
  s("a tstzrange parsed in one zone and run in another", { prepare: "p", sql: "SELECT id, rz, mz::text FROM public.mapped ORDER BY id" }, "SET TimeZone = 'Asia/Kolkata'", { run: "p" }),
  s("a held type parsed and run after a SET", { prepare: "p", sql: "SELECT id, mc, substring(cd::text, 1, 3) FROM public.mapped WHERE mc = '08:00:2b:01:02:03' ORDER BY id" }, "SET application_name = 'a'", { run: "p" }),
  // SET LOCAL outside a block: the warning, its value gone by the next request, nothing reported
  s("SET LOCAL alone", "SET LOCAL application_name = 'loc'", APP, ALL, BESIDE),
  s("SET LOCAL TO DEFAULT alone", "SET application_name = 'a'", "SET LOCAL application_name TO DEFAULT", APP),
  s("SET LOCAL of a name nobody knows, alone", "SET LOCAL no_such_setting = 'x'", APP),
  s("SET LOCAL of an invalid value, alone", "SET LOCAL work_mem = 'lots'", MEM),
  s("SET LOCAL of a placeholder, alone", "SET LOCAL myapp.lone = 'v'", "SHOW myapp.lone", "SELECT current_setting('myapp.lone', true) FROM public.one"),
  s("SET LOCAL ROLE alone", "SET LOCAL ROLE NONE"),
  s("SET TRANSACTION alone", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED", "SET LOCAL TRANSACTION ISOLATION LEVEL READ COMMITTED"),
  s("SET LOCAL in a Query of two, no warning", "SET LOCAL application_name = 'loc'; SHOW application_name", APP),
  s("SET LOCAL in a Query of two, read beside a table", `SET LOCAL TimeZone = 'Asia/Tokyo'; ${BESIDE}`, ZONE),

  // inside a block: until its end, whichever end
  s("SET LOCAL to COMMIT", "BEGIN", "SET LOCAL application_name = 'loc'", APP, ALL, BESIDE, "COMMIT", APP, ALL, BESIDE),
  s("SET LOCAL to ROLLBACK", "BEGIN", "SET LOCAL TimeZone = 'Asia/Tokyo'", ZONE, BESIDE, "ROLLBACK", ZONE, BESIDE),
  s("SET LOCAL of an unreported parameter", "BEGIN", "SET LOCAL work_mem = '77MB'", MEM, ALL, "COMMIT", MEM, ALL),
  s("SET LOCAL of search_path", "BEGIN", "SET LOCAL search_path = sales", PATH, BESIDE, "COMMIT", PATH, BESIDE),
  s("SET to COMMIT", "BEGIN", "SET application_name = 'a'", APP, "COMMIT", APP),
  s("SET to ROLLBACK", "BEGIN", "SET application_name = 'a'", APP, "ROLLBACK", APP, ALL, BESIDE),
  s("SET to ROLLBACK, a value from before", "SET application_name = 'before'", "BEGIN", "SET application_name = 'a'", "ROLLBACK", APP),
  s("BEGIN, SET and ROLLBACK in one Query", "BEGIN; SET application_name = 'a'; ROLLBACK; SHOW application_name", APP),
  s("BEGIN, SET and COMMIT in one Query", "BEGIN; SET application_name = 'a'; SET LOCAL TimeZone = 'Asia/Tokyo'; COMMIT; SHOW TimeZone", APP, ZONE),
  s("SET in a block read by a later Query's block", "BEGIN", "SET application_name = 'a'", "COMMIT", "BEGIN", "SET LOCAL application_name = 'b'", "ROLLBACK", APP),

  // both of one name in one block: COMMIT keeps the SET, ROLLBACK neither
  s("SET then SET LOCAL to COMMIT", "BEGIN", "SET application_name = 'a'", "SET LOCAL application_name = 'b'", APP, "COMMIT", APP),
  s("SET then SET LOCAL to ROLLBACK", "BEGIN", "SET application_name = 'a'", "SET LOCAL application_name = 'b'", APP, "ROLLBACK", APP),
  s("SET LOCAL then SET to COMMIT", "BEGIN", "SET LOCAL application_name = 'b'", "SET application_name = 'a'", APP, "COMMIT", APP),
  s("SET then SET LOCAL twice to COMMIT", "BEGIN", "SET application_name = 'a'", "SET LOCAL application_name = 'b'", "SET LOCAL application_name = 'c'", "COMMIT", APP),
  s("SET, SET LOCAL, SET to COMMIT", "BEGIN", "SET application_name = 'a'", "SET LOCAL application_name = 'b'", "SET application_name = 'c'", "COMMIT", APP),
  s("SET LOCAL of one name, SET of another", "BEGIN", "SET LOCAL application_name = 'b'", "SET TimeZone = 'Asia/Tokyo'", "COMMIT", APP, ZONE),

  // a block in the failed state: what it set is undone at the error, and that error's ReadyForQuery reports it
  s("a failed block's SET", "BEGIN", "SET application_name = 'a'", "SELECT 1/0", APP, "ROLLBACK", APP),
  s("a failed block's COMMIT", "BEGIN", "SET application_name = 'a'", "SELECT 1/0", "COMMIT", APP),
  s("a failed block's SET LOCAL", "SET application_name = 'before'", "BEGIN", "SET LOCAL application_name = 'a'", "SELECT 1/0", "ROLLBACK", APP),
  s("a failed block's SET in a Query before", "BEGIN; SET application_name = 'a'", "SELECT 1/0; SELECT 2", "ROLLBACK", APP),
  s("a failed block refuses a SET", "BEGIN", "SELECT 1/0", "SET application_name = 'a'", "RESET ALL", "SELECT set_config('application_name', 'a', true)", "ROLLBACK", APP),
  s("a block failed beside a table", "BEGIN", "SET TimeZone = 'Asia/Tokyo'", "SELECT no_such_column FROM public.one", "ROLLBACK", ZONE, BESIDE),
  s("a block failed by DISCARD ALL", "BEGIN", "SET application_name = 'a'", "DISCARD ALL", "SELECT 1", "ROLLBACK", APP),
  s("a block failed in a pipeline", "BEGIN", "SET application_name = 'a'", { pipeline: ["SELECT 1", "SELECT 1/0", "SELECT 2"] }, "ROLLBACK", APP),

  // an implicit transaction's end: a Query's statements and a Sync's batch are one transaction
  s("a Query's SET, then its error", "SET application_name = 'a'; SELECT 1/0", APP),
  s("a Query's SET, then ROLLBACK", "SET application_name = 'a'; ROLLBACK", APP),
  s("a Query's SET, then COMMIT", "SET application_name = 'a'; COMMIT", APP),
  s("a Query's SET, COMMIT, then its error", "SET application_name = 'a'; COMMIT; SELECT 1/0", APP),
  s("a Query's SET, then BEGIN, then ROLLBACK", "SET application_name = 'a'; BEGIN", "ROLLBACK", APP),
  s("a Query's SET LOCAL, then BEGIN, then COMMIT", "SET LOCAL application_name = 'a'; BEGIN", APP, "COMMIT", APP),
  s("a Query's SET LOCAL, then COMMIT", "SET LOCAL application_name = 'a'; COMMIT; SHOW application_name", APP),
  s("a Query's second transaction", "BEGIN; SET LOCAL application_name = 'x'; COMMIT; SET LOCAL TimeZone = 'Asia/Tokyo'; SHOW TimeZone", APP, ZONE),
  s("a pipeline's SET LOCAL warns once", { pipeline: ["SET LOCAL application_name = 'p'", "SET LOCAL TimeZone = 'Asia/Tokyo'", APP, ZONE] }, APP, ZONE),
  s("a pipeline's SET LOCAL after a SELECT", { pipeline: ["SELECT 1", "SET LOCAL application_name = 'p'", APP] }, APP),
  s("a pipeline's SET, then its error", { pipeline: ["SET application_name = 'p'", "SELECT 1/0"] }, APP),
  s("a pipeline's SET kept at its Sync", { pipeline: ["SET application_name = 'p'", "SELECT 1"] }, APP),
  s("a pipeline's SET, then ROLLBACK", { pipeline: ["SET application_name = 'p'", "ROLLBACK", APP] }, APP),
  s("a pipeline's SET, COMMIT, then its error", { pipeline: ["SET application_name = 'p'", "COMMIT", "SELECT 1/0"] }, APP),
  s("a pipeline's SET, then BEGIN", { pipeline: ["SET application_name = 'p'", "BEGIN", "SET TimeZone = 'Asia/Tokyo'"] }, "ROLLBACK", APP, ZONE),
  s("a pipeline's SET LOCAL, then BEGIN", { pipeline: ["SET LOCAL application_name = 'p'", "BEGIN"] }, APP, "COMMIT", APP),
  s("a pipeline's second transaction", { pipeline: ["BEGIN", "SET LOCAL application_name = 'x'", "COMMIT", "SET LOCAL TimeZone = 'Asia/Tokyo'", "SELECT 1", "SET LOCAL TimeZone = 'Asia/Tokyo'"] }, APP, ZONE),

  // RESET, RESET ALL and DISCARD ALL inside a block
  s("RESET to ROLLBACK", "SET application_name = 'a'", "BEGIN", "RESET application_name", APP, "ROLLBACK", APP),
  s("RESET to COMMIT", "SET application_name = 'a'", "BEGIN", "RESET application_name", APP, "COMMIT", APP),
  s("RESET over a SET LOCAL", "SET application_name = 'a'", "BEGIN", "SET LOCAL application_name = 'b'", "RESET application_name", "COMMIT", APP),
  s("SET LOCAL TO DEFAULT to COMMIT", "SET application_name = 'a'", "BEGIN", "SET LOCAL application_name TO DEFAULT", APP, "COMMIT", APP),
  s("SET TO DEFAULT to ROLLBACK", "SET application_name = 'a'", "BEGIN", "SET application_name TO DEFAULT", APP, "ROLLBACK", APP),
  s("RESET ALL to ROLLBACK", "SET application_name = 'a'", "SET work_mem = '64MB'", "BEGIN", "RESET ALL", APP, MEM, "ROLLBACK", APP, MEM),
  s("RESET ALL to COMMIT", "SET application_name = 'a'", "SET work_mem = '64MB'", "BEGIN", "RESET ALL", APP, MEM, "COMMIT", APP, MEM),
  s("RESET ALL over a SET LOCAL", "BEGIN", "SET LOCAL application_name = 'a'", "RESET ALL", APP, "COMMIT", APP),
  s("RESET ALL then SET LOCAL", "BEGIN", "SET application_name = 'a'", "SET LOCAL TimeZone = 'Asia/Tokyo'", "RESET ALL", "SET LOCAL application_name = 'z'", "COMMIT", APP, ZONE),
  s("RESET ALL then SET", "SET work_mem = '64MB'", "BEGIN", "RESET ALL", "SET application_name = 'a'", "ROLLBACK", APP, MEM),
  s("a Query's RESET ALL, then its error", "SET application_name = 'a'", "RESET ALL; SELECT 1/0", APP),
  s("DISCARD ALL in a Query of two", "SET application_name = 'a'", "SELECT 1; DISCARD ALL", "DISCARD ALL; SELECT 1", APP),
  s("DISCARD ALL after a SET in a Query", "SET application_name = 'a'; DISCARD ALL", APP),
  s("DISCARD ALL after an Execute", { pipeline: ["SELECT 1", "DISCARD ALL"] }, "SELECT 2"),
  s("DISCARD ALL after a SET in a pipeline", { pipeline: ["SET application_name = 'p'", "DISCARD ALL"] }, APP),
  s("DISCARD ALL first in a pipeline", "SET application_name = 'a'", { pipeline: ["DISCARD ALL", "SET LOCAL TimeZone = 'Asia/Tokyo'", "SELECT 1/0"] }, APP),
  s("DISCARD ALL after a pipeline's transaction", { pipeline: ["BEGIN", "COMMIT", "DISCARD ALL"] }, { pipeline: ["SELECT 1", "COMMIT", "DISCARD ALL"] }, "SELECT 2"),
  s("DISCARD PLANS in a block", "BEGIN", "DISCARD PLANS", "COMMIT"),

  // a placeholder stays defined, '', however its transaction ended
  s("a placeholder's SET LOCAL to ROLLBACK", "BEGIN", "SET LOCAL myapp.lo = 'v'", "SHOW myapp.lo", "ROLLBACK", "SHOW myapp.lo", "SELECT current_setting('myapp.lo', true) FROM public.one"),
  s("a placeholder's SET LOCAL to COMMIT", "BEGIN", "SET LOCAL myapp.lo = 'v'", "COMMIT", "SHOW myapp.lo"),
  s("a placeholder's SET to ROLLBACK", "BEGIN", "SET myapp.lo = 'v'", "ROLLBACK", "SHOW myapp.lo", "SELECT current_setting('myapp.lo', true)"),
  s("a placeholder's RESET to ROLLBACK", "BEGIN", "RESET myapp.lo", "ROLLBACK", "SHOW myapp.lo"),
  s("a placeholder in a failed block", "BEGIN", "SET myapp.lo = 'v'", "SELECT 1/0", "ROLLBACK", "SHOW myapp.lo"),
  s("a placeholder's value under a SET LOCAL", "BEGIN", "SET myapp.lo = 'v'", "COMMIT", "BEGIN", "SET LOCAL myapp.lo = 'w'", "SHOW myapp.lo", "COMMIT", "SHOW myapp.lo"),
  s("a placeholder's RESET ALL over a SET LOCAL", "BEGIN", "SET LOCAL myapp.lo = 'v'", "RESET ALL", "COMMIT", "SHOW myapp.lo"),
  s("a Query's placeholder, then its error", "SET myapp.lo = 'v'; SELECT 1/0", "SHOW myapp.lo"),

  // set_config(…, true) is SET LOCAL, less the warning
  s("set_config local alone", "SELECT set_config('application_name', 'c', true)", APP),
  s("set_config local in a Query of two", "SELECT set_config('application_name', 'c', true); SHOW application_name", APP),
  s("set_config local to COMMIT", "BEGIN", "SELECT set_config('application_name', 'c', true)", APP, BESIDE, "COMMIT", APP, BESIDE),
  s("set_config local to ROLLBACK", "BEGIN", "SELECT set_config('TimeZone', 'Asia/Tokyo', true) AS tz", ZONE, "ROLLBACK", ZONE),
  s("set_config to ROLLBACK", "BEGIN", "SELECT set_config('application_name', 'c', false)", APP, "ROLLBACK", APP),
  s("set_config then set_config local", "BEGIN", "SELECT set_config('application_name', 'k', false)", "SELECT set_config('application_name', 'c', true)", "COMMIT", APP),
  s("set_config local in a pipeline", { pipeline: ["SELECT set_config('application_name', 'c', true)", APP] }, APP),
  s("set_config local of a placeholder", "SELECT set_config('myapp.cl', 'c', true)", "SHOW myapp.cl"),
  s("set_config local of a name nobody knows", "SELECT set_config('no_such_setting', 'c', true)"),
  s("set_config local of an invalid value", "SELECT set_config('work_mem', 'lots', true)"),
  s("set_config local, then a failed block", "BEGIN", "SELECT set_config('application_name', 'c', true)", "SELECT 1/0", "ROLLBACK", APP),

  // a portal suspended at a row count begins the batch's implicit block, as an Execute that finished does
  s("a suspended portal, then SET LOCAL", { suspend: ORDERS, then: ["SET LOCAL application_name = 'p'", APP] }, APP),
  s("a suspended portal, then DISCARD ALL", "SET application_name = 'a'", { suspend: ORDERS, then: ["DISCARD ALL"] }, APP, "SELECT 2"),
  s("a suspended portal, then SET, then its error", { suspend: ORDERS, then: ["SET application_name = 'p'", "SELECT 1/0"] }, APP),
  s("a suspended portal, then SET, kept at the Sync", { suspend: ORDERS, then: ["SET application_name = 'p'"] }, APP),
  s("a suspended portal, then BEGIN and SET LOCAL", { suspend: ORDERS, then: ["BEGIN", "SET LOCAL application_name = 'p'"] }, APP, "COMMIT", APP),
  s("a suspended portal, then COMMIT", { suspend: ORDERS, then: ["SET application_name = 'p'", "COMMIT", "SELECT 1/0"] }, APP),

  // a failed block accepts nothing but its end, on every message of either protocol
  s("a failed block, a Query of each kind", ...FAILED, "SELECT 1", ALL, BESIDE, APP, "BEGIN", "INSERT INTO public.one (id) VALUES (9)", "SAVEPOINT s", "EXPLAIN SELECT 1", "PREPARE p AS SELECT 1", "SELECT set_config('application_name', 'b', true), 1", "ROLLBACK", APP),
  s("a failed block, a Query stops at its first", ...FAILED, "SELECT 1; ROLLBACK", "ROLLBACK; SELECT 1", APP),
  s("a failed block, a syntax error stays one", ...FAILED, "SELEC 1", { prepare: "bad", sql: "SELEC 1" }, { prepare: "two", sql: "SELECT 1; SELECT 2" }, "ROLLBACK"),
  s("a failed block, a Parse", ...FAILED, { prepare: "f", sql: "SELECT 1" }, { prepare: "g", sql: BESIDE }, { prepare: "h", sql: "BEGIN" }, "ROLLBACK", { run: "f" }),
  s("a failed block, a Parse of a name taken", { prepare: "f", sql: "SELECT 1" }, ...FAILED, { prepare: "f", sql: "SELECT 2" }, "ROLLBACK", { run: "f" }),
  s("a failed block, a Parse of nothing", ...FAILED, { prepare: "f", sql: "" }, { run: "f" }, "ROLLBACK"),
  s("a failed block, a pipeline of the catalog", ...FAILED, { pipeline: ["SELECT current_setting('application_name')"] }, { pipeline: ["SELECT 1"] }, "ROLLBACK", APP),
  s("a failed block, a pipeline of a table and of SHOW", ...FAILED, { pipeline: [BESIDE] }, { pipeline: [APP] }, { pipeline: ["SET application_name = 'b'"] }, "ROLLBACK", APP),
  s("a failed block, a pipeline stops at its first", ...FAILED, { pipeline: ["SELECT 1", "ROLLBACK"] }, { pipeline: ["ROLLBACK", APP, "SELECT 1/0"] }, APP),
  s("a failed block, a pipeline's COMMIT", ...FAILED, { pipeline: ["COMMIT", APP] }, APP),
  s("a failed block, a Bind of what was parsed before", { prepare: "c", sql: "SELECT 1" }, { prepare: "t", sql: BESIDE }, { prepare: "w", sql: APP }, { prepare: "v", sql: "SET application_name = 'b'" }, ...FAILED, { run: "c" }, { run: "t" }, { run: "w" }, { run: "v" }, { run: "no_such" }, "ROLLBACK", APP),
  s("a failed block, its end parsed before", { prepare: "end", sql: "ROLLBACK" }, ...FAILED, { describe: "end" }, { run: "end" }, APP),
  s("a failed block, its COMMIT parsed before", { prepare: "end", sql: "COMMIT" }, ...FAILED, { run: "end" }, APP),
  s("a failed block, a Describe of a result", { prepare: "c", sql: "SELECT 1" }, { prepare: "t", sql: BESIDE }, { prepare: "w", sql: APP }, { prepare: "cfg", sql: "SELECT set_config('application_name', 'b', false)" }, { prepare: "x", sql: "EXPLAIN SELECT 1" }, ...FAILED, { describe: "c" }, { describe: "t" }, { describe: "w" }, { describe: "cfg" }, { describe: "x" }, "ROLLBACK"),
  s("a failed block, a Describe of no result", { prepare: "v", sql: "SET application_name = 'b'" }, ...FAILED, { describe: "v" }, { describe: "no_such" }, "ROLLBACK"),
  s("a failed block, a Close", { prepare: "c", sql: "SELECT 1" }, { prepare: "v", sql: "SET application_name = 'b'" }, ...FAILED, { close: "c" }, { close: "v" }, { close: "no_such" }, "ROLLBACK", { run: "c" }),
  s("a failed block, a catalog portal bound before", { prepare: "c", sql: ALL }, "BEGIN", { bind: "c", portal: "pc" }, "SELECT 1/0", { execute: "pc" }, { describePortal: "pc" }, { execute: "no_such" }, "ROLLBACK", APP),
  s("a failed block, a table's portal bound before", { prepare: "t", sql: BESIDE }, "BEGIN", { bind: "t", portal: "pt" }, "SELECT 1/0", { execute: "pt" }, { describePortal: "pt" }, "ROLLBACK", APP),
  s("a failed block, a SHOW's portal bound before", { prepare: "w", sql: APP }, "BEGIN", { bind: "w", portal: "ps" }, "SELECT 1/0", { execute: "ps" }, { describePortal: "ps" }, "ROLLBACK", APP),

  // a prepared statement reads what is in force when it RUNS: a reverted setting never stays in its plan
  // a json read's path as a parameter is not constant at the Parse (issue 130): each run reads its own, after a SET too
  ...PATH_PARAMETERS.map(([name, sql]) => s(`a json path as a parameter, ${name}`, { prepare: "p", sql }, ...PATH_VALUES.flatMap((v, i): Step[] => [{ run: "p", values: [v] }, `SET TimeZone = '${i % 2 === 0 ? "Asia/Tokyo" : "UTC"}'`, { run: "p", values: [v] }]))),
  ...TEXT_ARRAY_PARAMETERS.map(([name, sql]) => s(`a text[] parameter of two dimensions or other bounds, ${name}`, { prepare: "p", sql }, ...TEXT_ARRAY_STEPS)),
  ...NUMERIC_PARAMETERS.map(([name, sql, values]) => s(`numeric parameter: ${name}`, { prepare: "p", sql }, ...values.map((v): Step => ({ run: "p", values: v })))),
  s("a json path element as a parameter", { prepare: "p", sql: "SELECT id, jb #>> ARRAY[$1], j #>> ARRAY[$1, 'b'], jsonb_extract_path_text(jb, $1, 'b') FROM public.jpath ORDER BY id" }, { run: "p", values: ["o"] }, "SET TimeZone = 'Asia/Tokyo'", { run: "p", values: ["k"] }, { run: "p", values: [null] }, { run: "p", values: ["0"] }),
  // native json (issue 130): an @> template known only at the Bind stays the function's; a native read prepared, run
  // again after a SET
  s("native json: @> a parameter template", { prepare: "p", sql: "SELECT id FROM public.jcontain WHERE jb @> $1::jsonb ORDER BY id" }, { run: "p", values: ['{"a": 1}'] }, { run: "p", values: ['{"a": 1.0}'] },
    "SET TimeZone = 'Asia/Tokyo'", { run: "p", values: ["[1]"] }, { run: "p", values: [null] }, { run: "p", values: ['{"a": 1}'] }),
  s("native json: a prepared native statement run after a SET", { prepare: "p", sql: "SELECT id, jb -> 'a', jb @> '{\"a\": 1}', (jb -> 'b') IS NULL FROM public.jcontain WHERE id > $1 ORDER BY id" },
    { run: "p", values: ["0"] }, "SET TimeZone = 'Asia/Kolkata'", { run: "p", values: ["10"] }),
  s("a statement parsed before, run through SET LOCAL and after", { prepare: "z", sql: ZONED }, { run: "z" }, "BEGIN", "SET LOCAL TimeZone = 'Asia/Tokyo'", "SET LOCAL application_name = 'loc'", { run: "z" }, "COMMIT", { run: "z" }),
  s("a statement parsed before, run through a rolled-back SET and after", { prepare: "z", sql: ZONED }, "BEGIN", "SET TimeZone = 'Asia/Tokyo'", { run: "z" }, "ROLLBACK", { run: "z" }),
  s("a statement parsed under a SET LOCAL, run after", "BEGIN", "SET LOCAL TimeZone = 'Asia/Tokyo'", { prepare: "z", sql: ZONED }, { run: "z" }, "COMMIT", { run: "z" }),
  s("a statement parsed under a rolled-back SET, run after", "BEGIN", "SET TimeZone = 'Asia/Tokyo'", { prepare: "z", sql: ZONED }, "ROLLBACK", { run: "z" }),
  // a * sorted by a text column's number: the plan after a SET is the collation's key, as before it (issue 112)
  s("a * sorted by number, parsed before a SET, run after", { prepare: "st", sql: "SELECT * FROM public.star_o ORDER BY 3 NULLS FIRST, 1" }, { run: "st" }, "SET TimeZone = 'Asia/Tokyo'", { run: "st" }),
  s("a * sorted by name, parsed after a SET", "SET application_name = 'a'", { prepare: "st", sql: "SELECT * FROM public.star_o ORDER BY name NULLS FIRST, id LIMIT 4" }, { run: "st" }, "SET search_path = public, other", { run: "st" }),
  s("a subquery in a top N's list, parsed after a SET", "SET application_name = 'a'", { prepare: "sublist", sql: "SELECT a.id, a.made, (SELECT count(*) FROM public.top_b b WHERE b.a_id = a.id) AS n FROM public.top_a a LEFT JOIN public.top_b x ON x.a_id = a.id ORDER BY a.made DESC NULLS LAST, a.id, x.id LIMIT 4" }, { run: "sublist" }, "SET TimeZone = 'America/New_York'", { run: "sublist" }),
  s("the preserved side first, parsed before a SET, run after", { prepare: "preserved", sql: "SELECT a.id, a.made, date_trunc('day', a.made) AS day, p.name FROM public.top_a a LEFT JOIN public.top_a p ON p.id = a.parent ORDER BY date_trunc('day', a.made) DESC NULLS LAST, a.id LIMIT 3 OFFSET 1" }, { run: "preserved" }, "SET TimeZone = 'Pacific/Kiritimati'", { run: "preserved" }),
  s("a key-first DISTINCT, parsed before a SET, run after", { prepare: "keyfirst_distinct", sql: "SELECT DISTINCT a.id, a.note, a.made FROM public.top_a a JOIN public.top_b b ON b.a_id = a.id ORDER BY a.made DESC NULLS LAST, a.id LIMIT 3" }, { run: "keyfirst_distinct" }, "SET TimeZone = 'Asia/Tokyo'", { run: "keyfirst_distinct" }),
  s("a key-first DISTINCT ON, parsed before a SET, run after", { prepare: "distinct_on", sql: "SELECT DISTINCT ON (a.id) a.id, a.note, a.made, b.id AS b, b.payload FROM public.top_a a LEFT JOIN public.top_b b ON b.a_id = a.id ORDER BY a.id, b.amount DESC NULLS LAST, b.id LIMIT 3" }, { run: "distinct_on" }, "SET TimeZone = 'Asia/Tokyo'", { run: "distinct_on" }),
  s("a key-first GROUP BY, parsed before a SET, run after", { prepare: "keyfirst", sql: "SELECT a.id, a.note, a.made, count(b.id) AS n FROM public.top_a a LEFT JOIN public.top_b b ON b.a_id = a.id GROUP BY a.id ORDER BY a.made DESC NULLS LAST, a.id LIMIT 3" }, { run: "keyfirst" }, "SET TimeZone = 'Asia/Tokyo'", { run: "keyfirst" }),
  s("a statement run after a failed block", { prepare: "z", sql: ZONED }, "BEGIN", "SET TimeZone = 'Asia/Tokyo'", "SELECT 1/0", "ROLLBACK", { run: "z" }),
  s("a catalog statement run after a revert", { prepare: "c", sql: ALL }, "BEGIN", "SET LOCAL TimeZone = 'Asia/Tokyo'", "SET LOCAL work_mem = '77MB'", { run: "c" }, "ROLLBACK", { run: "c" }),
  s("a set_config statement run again", { prepare: "cfg", sql: "SELECT set_config('application_name', 'c', true)" }, { run: "cfg" }, APP, "BEGIN", { run: "cfg" }, APP, "COMMIT", APP),
  s("a SET LOCAL statement run in and out of a block", { prepare: "lo", sql: "SET LOCAL application_name = 'prep'" }, { run: "lo" }, APP, "BEGIN", { run: "lo" }, APP, "ROLLBACK", APP),
  // SESSION STATE (GitHub issue 253): the session's TimeZone, search_path and DateStyle reach every path that answers —
  // the catalog's (a statement of no table), DuckDB's, a prepared statement's plan run again — and what a tool sets is
  // honoured or read back (#65, #64, #63). The tables: public.one, and public.dup / other.dup / public.dup2 / other.dup2
  // (duck-oracle.itest.ts SESSION_STATE_DDL)
  s("session state: TimeZone reaches a statement of no table", "SET TimeZone = 'Asia/Tokyo'", "SELECT '2026-01-02 03:04:05+00'::timestamptz",
    "SELECT to_char('2026-01-02 03:04:05+00'::timestamptz, 'HH24:MI TZ')",
    "SELECT date_trunc('day', '2026-01-02 20:00:00+00'::timestamptz), '2026-01-02'::date::timestamptz, make_timestamptz(2026, 1, 2, 3, 4, 5)"),
  s("session state: TimeZone across a DST change and a half-hour zone", "SET TimeZone = 'America/New_York'",
    "SELECT '2026-03-08 06:59:59+00'::timestamptz, '2026-03-08 07:00:00+00'::timestamptz, '2026-07-01 12:00'::timestamptz",
    "SELECT tm::timetz FROM (VALUES ('12:30'::time)) v(tm)", "SELECT extract(timezone_hour FROM current_time(0)) IN (-5, -4)",
    { prepare: "p", sql: "SELECT $1::time::timetz" }, { run: "p", values: ["12:30"] },
    "SET TimeZone = 'America/St_Johns'", "SELECT '12:30'::time::timetz"),
  s("session state: SET LOCAL TimeZone on both paths, then the session's", "BEGIN", "SET LOCAL TimeZone = 'Asia/Tokyo'",
    "SELECT '2026-01-02 03:04:05+00'::timestamptz", "SELECT '2026-01-02 03:04:05+00'::timestamptz FROM public.one", "COMMIT",
    "SELECT '2026-01-02 03:04:05+00'::timestamptz"),
  s("session state: search_path reaches the catalog as Postgres's", "SELECT current_schemas(false), current_schemas(true), current_schema()",
    "SET search_path = other, public", "SELECT current_schemas(false), 'dup'::regclass::text, 'public.dup'::regclass::text",
    "SET search_path = pg_catalog, public", "SELECT current_schemas(false)",
    "SET search_path = nowhere", "SELECT 'one'::regclass", "SELECT current_setting('search_path'), pg_catalog.current_setting('TimeZone'), current_setting('application_name')",
    "SELECT version() LIKE 'PostgreSQL 18%'", "SELECT count(*) FROM pg_class WHERE relname = 'one' AND pg_table_is_visible(oid)",
    "SET search_path = other", "SELECT count(*) FROM information_schema.tables WHERE table_name = 'dup'"),
  s("session state: DateStyle's order on both paths", "SET DateStyle = 'ISO, DMY'", "SHOW DateStyle", "SELECT '01/02/2026'::date",
    "SELECT '01/02/2026'::date AS d FROM public.one", { prepare: "p", sql: "SELECT $1::date AS d FROM public.one" }, { run: "p", values: ["01/02/2026"] },
    "SET DateStyle = 'ISO, YMD'", "SHOW DateStyle", "SET DateStyle = 'ISO'", "SHOW DateStyle", "RESET DateStyle", "SHOW DateStyle",
    "BEGIN", "SET LOCAL DateStyle = 'ISO, DMY'", "SELECT '01/02/2026'::date", "ROLLBACK", "SELECT '01/02/2026'::date"),
  s("session state: DateStyle's validity is Postgres's (review r1 of PR 333)", "SET DateStyle = 'YMD, DMY'", "SHOW DateStyle", "SET DateStyle = 'ISO, nonsense'",
    "SET DateStyle = 'ISO, YMD'", "SET DateStyle = 'ISO'", "SHOW DateStyle", "SELECT set_config('DateStyle', 'dmy', false)", "SHOW DateStyle"),
  s("session state: a clock keyword's precision 0 on the catalog path (review r1 of PR 333)", "SET TimeZone = 'UTC'",
    "SELECT length(current_time(0)::text), length(current_timestamp(0)::text), length(localtime(0)::text), length(localtimestamp(0)::text)",
    "SELECT current_time(0)::text ~ '^[0-9]{2}:[0-9]{2}:[0-9]{2}[+-]', current_timestamp(0)::text ~ ':[0-9]{2}[+-]', localtime(0)::text ~ ':[0-9]{2}$', localtimestamp(0)::text ~ ':[0-9]{2}$'"),
  s("session state: a relative literal is the instant now() is, on the catalog path", "SET TimeZone = 'Asia/Tokyo'",
    "SELECT 'now'::timestamptz = now(), 'today'::date = current_date, 'today'::timestamptz = date_trunc('day', now()), timestamp 'today' = current_date::timestamp, 'now'::timestamp = localtimestamp",
    "SELECT E'now'::timestamptz = now(), E'today'::date = current_date, $$now$$::timestamptz = now(), U&'now'::timestamptz = now()",
    "SELECT 'now'::text::timestamptz = now(), 'now'::varchar::timestamptz = now(), 'now'::unknown::timestamptz = now(), now() = 'now', 'now' = now()",
    { prepare: "p", sql: "SELECT $1::int AS n, now() = 'now' AS same" }, { run: "p", values: ["1"] },
    "BEGIN", "SELECT 'now'::timestamptz = now()", "SELECT now() = (SELECT now() FROM public.one)", "COMMIT"),
  // GitHub issues 372 and 363: the instant is microseconds, so a prepared statement's 'now' (its Parse's transaction)
  // and its run's now() (a later one) differ as Postgres's do, even inside one millisecond; and the real clock after
  // the transaction's start never reads earlier than it. The resolution itself is held by the unit tests, whose clock
  // is pinned: a live Postgres's microseconds end in 000 now and then, so no statement here can hold six digits
  s("session state: a prepared relative literal and its run's now() on the DuckDB path", "SET TimeZone = 'Asia/Tokyo'",
    { prepare: "p", sql: "SELECT $1::int AS n, now() = 'now' AS same FROM public.one" }, { run: "p", values: ["1"] },
    "BEGIN", "SELECT statement_timestamp() >= now(), clock_timestamp() >= now(), clock_timestamp() >= statement_timestamp()",
    "SELECT now() = (SELECT now() FROM public.one)", "COMMIT"),
  s("session state: every reader of the transaction's start on the catalog path, however the word reaches it (review r3 of PR 333)", "SET TimeZone = 'Asia/Tokyo'",
    "/* app */ SELECT 'now'::timestamptz = now(), E'now'::timestamptz = now(), now() = 'now', date 'today' = current_date",
    "-- a comment line\nSELECT E'now'::timestamptz = now(), 'now'::text::timestamptz = now()",
    "/* app */ WITH q AS (SELECT 'now'::timestamptz AS x) SELECT x = now() FROM q",
    "SELECT 'now'::char(4)::timestamptz = now(), 'now'::varchar(3)::timestamptz = now(), 'today'::char(5)::date = current_date",
    "SELECT lower('now')::timestamptz = now(), upper('NOW')::timestamptz = now(), coalesce('now', 'x')::timestamptz = now(), ('now' || '')::timestamptz = now(), (SELECT 'now')::timestamptz = now(), CASE WHEN true THEN 'now' END::timestamptz = now()",
    "SELECT U&'now'::timestamp::text = localtimestamp::text, lower('now')::timestamptz = now()",
    { prepare: "q", sql: "SELECT $1::timestamptz = now() AS same" }, { run: "q", values: ["now"] },
    "BEGIN", "SELECT 'now'::timestamptz = now(), lower('now')::timestamptz = now(), statement_timestamp() >= now()", "SELECT now() = (SELECT now() FROM public.one), 'now'::timestamptz = (SELECT now() FROM public.one)", "COMMIT"),
  s("session state: IntervalStyle postgres, and an invalid one", "SET IntervalStyle = 'postgres'", "SHOW IntervalStyle", "SET IntervalStyle = 'nonsense'"),
  s("session state: extra_float_digits read back on both paths", "SET extra_float_digits = 3", "SHOW extra_float_digits",
    "SELECT 0.1::float8, 0.1::float8 * 3 FROM public.one", "SELECT 0.1::float8"),
  s("session state: the isolation levels read back", "BEGIN", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", "SHOW transaction_isolation",
    "SELECT current_setting('transaction_isolation') FROM public.one", "COMMIT", "SHOW transaction_isolation",
    "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE", "SHOW default_transaction_isolation", "BEGIN", "SHOW transaction_isolation", "COMMIT",
    "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ UNCOMMITTED", "SHOW TRANSACTION ISOLATION LEVEL"),
  s("session state: a prepared statement planned again when the search_path moved", { prepare: "p", sql: "SELECT * FROM dup ORDER BY id" }, { run: "p" },
    "SET search_path = other, public", { run: "p" }, "RESET search_path", { run: "p" }, "SET TimeZone = 'Asia/Tokyo'", { run: "p" }),
  s("session state: a prepared statement whose result moved with the search_path", { prepare: "p", sql: "SELECT * FROM dup2 ORDER BY id" }, { run: "p" },
    "SET search_path = other", { run: "p" }),
  s("session state: a prepared statement whose column's type moved with the search_path", { prepare: "p", sql: "SELECT v FROM dup2" }, "SET search_path = other", { run: "p" }),
  s("session state: a prepared statement under a path that holds nothing", { prepare: "p", sql: "SELECT count(*) AS n FROM dup" }, { run: "p" },
    "SET search_path = nowhere", { run: "p" }, "RESET search_path", { run: "p" }),
  s("session state: an unqualified name beside a qualified one, the path moved", { prepare: "p", sql: "SELECT d.v, o.v FROM dup d JOIN public.dup2 o USING (id) ORDER BY 1" },
    "SET search_path = other, public", { run: "p" }),
  s("session state: a catalog statement prepared under one path and run under another",
    { prepare: "p", sql: "SELECT count(*) FROM pg_class WHERE relname = 'dup' AND pg_table_is_visible(oid)" }, { run: "p" }, "SET search_path = nowhere", { run: "p" }),
];

/** One step's whole reply, a line a message, the reported parameters of one request in a fixed order (Postgres's is
 *  its list's, a client reads them as a set). Only what a session's settings can move is reported here. */
const REPORTED = new Set(["application_name", "TimeZone", "search_path"]);
interface Message { name: string; severity?: string; code?: string; message?: string; detail?: string; parameterName?: string; parameterValue?: string; text?: string; fields?: unknown[]; status?: string }
const line = (m: Message): string | null => {
  switch (m.name) {
    case "notice": return `notice ${m.severity} ${m.code} ${m.message}`;
    // Mason's refusal by name carries its gap (Postgres's DETAIL never says "Mason gap")
    case "error": { const gap = GAP_MARK.exec(m.detail ?? "")?.[1]; return `error ${m.code} ${m.message}${gap === undefined ? "" : ` [gap ${gap}]`}`; }
    case "parameterStatus": return REPORTED.has(m.parameterName ?? "") ? `status ${m.parameterName}=${m.parameterValue}` : null;
    case "commandComplete": return `tag ${m.text}`;
    case "dataRow": return `row ${JSON.stringify(m.fields)}`;
    case "portalSuspended": return "suspended";
    case "parseComplete": return "parsed";
    case "bindComplete": return "bound";
    case "closeComplete": return "closed";
    case "noData": return "no data";
    case "rowDescription": return `columns ${JSON.stringify(m.fields?.map((f) => (f as { name: string }).name))}`;
    case "parameterDescription": return "parameters";
    case "readyForQuery": return `ready ${m.status}`;
    default: return null;
  }
};

/** pg's Connection, the calls a step makes of it: the client would otherwise read an error outside a query as fatal */
interface Wire {
  on(event: "message", listener: (m: Message) => void): void;
  removeListener(event: "message", listener: (m: Message) => void): void;
  query(text: string): void;
  parse(q: { text: string; name?: string }): void;
  bind(c: { statement?: string; portal?: string; values?: Array<string | null> }): void;
  describe(m: { type: "P" | "S"; name?: string }): void;
  execute(c: { portal?: string; rows?: number }): void;
  close(m: { type: "P" | "S"; name: string }): void;
  sync(): void;
}

/** one step on one client, as a Submittable: its reply's lines, the ReadyForQuery's included */
export async function traceStep(client: pg.Client, step: Step): Promise<string[]> {
  const wire = (client as unknown as { connection: Wire }).connection;
  const lines: string[] = [];
  const portal = (name: string): void => { wire.bind({ statement: name }); wire.describe({ type: "P" }); wire.execute({}); };
  let listen!: (m: Message) => void;
  await new Promise<void>((resolve) => {
    // the reply's end is read off the wire: the client forgets its query at an ErrorResponse, before the ReadyForQuery
    listen = (m) => { const l = line(m); if (l !== null) lines.push(l); if (m.name === "readyForQuery") resolve(); };
    wire.on("message", listen);
    const noop = (): void => undefined;
    client.query({
      submit: () => {
        if (typeof step === "string") { wire.query(step); return; }
        if ("pipeline" in step) for (const text of step.pipeline) { wire.parse({ text }); portal(""); }
        else if ("suspend" in step) {
          wire.parse({ text: step.suspend });
          wire.bind({});
          wire.describe({ type: "P" });
          wire.execute({ rows: 1 });
          for (const text of step.then) { wire.parse({ text }); portal(""); }
        } else if ("prepare" in step) wire.parse({ name: step.prepare, text: step.sql });
        else if ("run" in step) { wire.bind({ statement: step.run, ...(step.values === undefined ? {} : { values: step.values }) }); wire.describe({ type: "P" }); wire.execute({}); }
        else if ("bind" in step) wire.bind({ statement: step.bind, portal: step.portal });
        else if ("execute" in step) wire.execute({ portal: step.execute });
        else if ("describePortal" in step) wire.describe({ type: "P", name: step.describePortal });
        else if ("describe" in step) wire.describe({ type: "S", name: step.describe });
        else wire.close({ type: "S", name: step.close });
        wire.sync();
      },
      handleReadyForQuery: noop, handleError: noop, handleRowDescription: noop, handleDataRow: noop, handleCommandComplete: noop, handleEmptyQuery: noop, handlePortalSuspended: noop,
    } as unknown as pg.Submittable);
  });
  wire.removeListener("message", listen);
  // one request's statuses, sorted in place: they come together, before its ReadyForQuery
  const isStatus = (l: string): boolean => l.startsWith("status ");
  const at = lines.findIndex(isStatus);
  const others = lines.filter((l) => !isStatus(l));
  return at < 0 ? lines : [...others.slice(0, at), ...lines.filter(isStatus).sort(), ...others.slice(at)];
}

/** a step that must be refused by its gap: null when Mason's reply is that refusal, else what it was */
export function refusedAsNamed(step: Step, got: string[]): { gap: GapId; differs: string | null } | null {
  if (typeof step === "string" || !("run" in step) || step.refused === undefined) return null;
  const gap = step.refused;
  return { gap, differs: got.some((l) => l.startsWith("error 0A000 ") && l.endsWith(` [gap ${gap}]`)) ? null : `${JSON.stringify(got)} where Mason refuses by the gap ${gap}` };
}

export const stepText = (step: Step): string => typeof step === "string" ? step : "pipeline" in step ? step.pipeline.join(" |> ") : "prepare" in step ? `PARSE ${step.prepare}: ${step.sql}`
  : "suspend" in step ? `SUSPEND ${step.suspend} |> ${step.then.join(" |> ")}` : `${Object.keys(step).join(" ")} ${Object.values(step).join(" ")}`.toUpperCase();
