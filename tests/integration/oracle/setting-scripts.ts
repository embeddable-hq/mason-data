/**
 * A SESSION'S SETTINGS ACROSS ITS TRANSACTIONS (GitHub issue 47), held message by message: each script is one session,
 * its steps sent IN ORDER to Postgres and to Mason, and every step's whole reply must be equal — the warnings, the
 * ParameterStatus and where it falls, the tags, the rows, the refusals and the ReadyForQuery's status, none of which
 * `ask` sees. A step is a simple Query (its string), a batch of statements up to one Sync (`pipeline`: Postgres ends a
 * transaction differently there), a named statement Parsed and later run, the reverted setting in between, or one
 * message of the extended protocol, which is what a failed block holds to its end.
 */
import type pg from "pg";

export type Step = string | { pipeline: string[] } | { prepare: string; sql: string } | { run: string; values?: Array<string | null> }
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

export const SETTING_SCRIPTS: SettingScript[] = [
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
  s("a json path element as a parameter", { prepare: "p", sql: "SELECT id, jb #>> ARRAY[$1], j #>> ARRAY[$1, 'b'], jsonb_extract_path_text(jb, $1, 'b') FROM public.jpath ORDER BY id" }, { run: "p", values: ["o"] }, "SET TimeZone = 'Asia/Tokyo'", { run: "p", values: ["k"] }, { run: "p", values: [null] }, { run: "p", values: ["0"] }),
  s("a statement parsed before, run through SET LOCAL and after", { prepare: "z", sql: ZONED }, { run: "z" }, "BEGIN", "SET LOCAL TimeZone = 'Asia/Tokyo'", "SET LOCAL application_name = 'loc'", { run: "z" }, "COMMIT", { run: "z" }),
  s("a statement parsed before, run through a rolled-back SET and after", { prepare: "z", sql: ZONED }, "BEGIN", "SET TimeZone = 'Asia/Tokyo'", { run: "z" }, "ROLLBACK", { run: "z" }),
  s("a statement parsed under a SET LOCAL, run after", "BEGIN", "SET LOCAL TimeZone = 'Asia/Tokyo'", { prepare: "z", sql: ZONED }, { run: "z" }, "COMMIT", { run: "z" }),
  s("a statement parsed under a rolled-back SET, run after", "BEGIN", "SET TimeZone = 'Asia/Tokyo'", { prepare: "z", sql: ZONED }, "ROLLBACK", { run: "z" }),
  // a * sorted by a text column's number: the plan after a SET is the collation's key, as before it (issue 112)
  s("a * sorted by number, parsed before a SET, run after", { prepare: "st", sql: "SELECT * FROM public.star_o ORDER BY 3 NULLS FIRST, 1" }, { run: "st" }, "SET TimeZone = 'Asia/Tokyo'", { run: "st" }),
  s("a * sorted by name, parsed after a SET", "SET application_name = 'a'", { prepare: "st", sql: "SELECT * FROM public.star_o ORDER BY name NULLS FIRST, id LIMIT 4" }, { run: "st" }, "SET search_path = public, other", { run: "st" }),
  s("a statement run after a failed block", { prepare: "z", sql: ZONED }, "BEGIN", "SET TimeZone = 'Asia/Tokyo'", "SELECT 1/0", "ROLLBACK", { run: "z" }),
  s("a catalog statement run after a revert", { prepare: "c", sql: ALL }, "BEGIN", "SET LOCAL TimeZone = 'Asia/Tokyo'", "SET LOCAL work_mem = '77MB'", { run: "c" }, "ROLLBACK", { run: "c" }),
  s("a set_config statement run again", { prepare: "cfg", sql: "SELECT set_config('application_name', 'c', true)" }, { run: "cfg" }, APP, "BEGIN", { run: "cfg" }, APP, "COMMIT", APP),
  s("a SET LOCAL statement run in and out of a block", { prepare: "lo", sql: "SET LOCAL application_name = 'prep'" }, { run: "lo" }, APP, "BEGIN", { run: "lo" }, APP, "ROLLBACK", APP),
];

/** One step's whole reply, a line a message, the reported parameters of one request in a fixed order (Postgres's is
 *  its list's, a client reads them as a set). Only what a session's settings can move is reported here. */
const REPORTED = new Set(["application_name", "TimeZone", "search_path"]);
interface Message { name: string; severity?: string; code?: string; message?: string; parameterName?: string; parameterValue?: string; text?: string; fields?: unknown[]; status?: string }
const line = (m: Message): string | null => {
  switch (m.name) {
    case "notice": return `notice ${m.severity} ${m.code} ${m.message}`;
    case "error": return `error ${m.code} ${m.message}`;
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

export const stepText = (step: Step): string => typeof step === "string" ? step : "pipeline" in step ? step.pipeline.join(" |> ") : "prepare" in step ? `PARSE ${step.prepare}: ${step.sql}`
  : "suspend" in step ? `SUSPEND ${step.suspend} |> ${step.then.join(" |> ")}` : `${Object.keys(step).join(" ")} ${Object.values(step).join(" ")}`.toUpperCase();
