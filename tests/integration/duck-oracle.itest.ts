/**
 * THE DUCKDB ORACLE (docs/DESIGN.md): Mason's DuckDB-backed Postgres endpoint must answer EVERY statement
 * EXACTLY as the Postgres it copies from — the same column names, the same type OIDs, the same text, the same rows in
 * the same order, the same refusal (SQLSTATE) — because a customer's BI tool sends it the SQL it sends Postgres, and
 * reads the answer as Postgres's.
 *
 * The endpoint runs Postgres SQL as written, so the SAME TEXT goes to both and the answers are diffed. What is asked,
 * and over what:
 *  - THE ORACLE'S ADVERSARIAL DATA (oracle/data.ts: NULL beside '' beside a value, case variants, ties, bucket
 *    boundaries, 1970 and the far future, negatives, float-unfriendly decimals) in a fresh database of
 *    IT_POSTGRES_URL's server, added to a DuckDB store by the real copy (src/duck/sync.ts) and served by the real
 *    listener (src/api/postgres/server.ts with `duck`);
 *  - THE DIALECT CASES (postgres-cases.ts: ~250 expressions over edge-case literals, and whole statements over literal
 *    rows), each made to read a copied one-row table so DuckDB answers it (a statement that reads no table is the
 *    catalog Postgres's own answer, Postgres's by construction);
 *  - THE BI SHAPES (oracle/bi-shapes.ts): the structures saved reports use most that nothing above generates;
 *  - THE TYPE MATRIX (oracle/type-matrix.ts): every common column type sorted, grouped, compared, computed, cast and
 *    aggregated, over edge values (NaN, infinities, -0, a bigint past 2^53);
 *  - THE GAP CASES (oracle/gap-cases.ts): one statement for each entry of src/duck/gaps.ts nothing else meets;
 *  - every synced table, whole, as text: the copy itself is held to the source;
 * after the first sync, and again after each round of changes (oracle/data.ts `mutations`) the poll carries. After
 * the copy, each statement both answered alike is asked again in THE SHAPES a tool wraps it in (oracle/shapes.ts: a
 * subquery, a CTE, a UNION ALL, its filter's values as parameters, its columns by Postgres's names, its ORDER BY
 * outside the derived table; `IT_ORACLE_SHAPES=0` leaves them out).
 *
 * WHAT THE STATEMENTS ANSWERED ALIKE ARE MADE OF is what the endpoint admits (src/duck/verified.ts, rewritten by
 * `UPDATE_VERIFIED=1`, or from a CI run's legs by `node scripts/oracle-legs.ts --write <run-id>`; anything else is
 * refused): this test fails while the file is not exactly that.
 *
 * A difference is a defect to fix, or a DECIDED one in `KNOWN` naming its `differs` gap, which must still differ in the
 * kind decided; a refusal where Postgres answers must name a `refused` gap, and a gap none of the statements meets is
 * dead (docs/SQL-SUPPORT.md). Every difference is written to `IT_LOG_DIR` (default: the OS temp dir) `duck-oracle-differences.txt`.
 *
 * IN CI IT RUNS IN LEGS (scripts/oracle-legs.ts): `IT_ORACLE_LEG=1/2` asks the statements that are that leg's, each after
 * the same copy and through the same rounds of changes, and writes a report instead of what only a whole run can
 * assert; `integration (oracle)` holds the reports to the whole. Without it a run is the whole, as ever.
 *
 * Needs IT_POSTGRES_URL (any wal_level; a database of its own is created and dropped), psql on PATH, and the copy's
 * extensions installed from this platform's package (`node cli/extensions.ts --node-modules node_modules`, once): the
 * oracle refuses to run on the engine's own install, so what it holds equal is what a user's install answers.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { DuckStore } from "../../src/duck/store.ts";
import { readLibcOrder } from "../../src/duck/libc-order.ts";
import { isLibcCollation, nodesPlacedTwice } from "../../src/duck/rewrite.ts";
import { Sync } from "../../src/duck/sync.ts";
import { startPostgresApi, type PgApiServer } from "../../src/api/postgres/server.ts";
import { connectSource, parseSource, readSourceFacts } from "../../src/cli/preflight.ts";
import { mutations, KEY_OF, SCHEMA, STAMPING, seed, TABLES } from "./oracle/data.ts";
import { normalise, same } from "./oracle/compare.ts";
import { CASES, MIXED_SCALE, QUERY_CASES, REFUSED_CASES, T, U, Z } from "./postgres-cases.ts";
import { BI_SHAPES, META } from "./oracle/bi-shapes.ts";
import { TYPE_MATRIX, TYPED, typedMutations } from "./oracle/type-matrix.ts";
import { MERGE_COPIED, UNORDERED_LIMITS, UNORDERED_ROW_SHAPES, everyRowOnce, withinWhole, type UnorderedLimit } from "./oracle/unordered-limit.ts";
import { GAP_CASES } from "./oracle/gap-cases.ts";
import { refusedAsNamed, SETTING_SCRIPTS, stepText, traceStep } from "./oracle/setting-scripts.ts";
import { collationMet, staleDecisions, type Answered, type Decided } from "./oracle/known.ts";
import { shapes as shapesOf } from "./oracle/shapes.ts";
import { LATEST_CASES, LATEST_SCHEMA, LATEST_TABLES } from "./oracle/latest.ts";
import { LATEST_SQL } from "../../src/api/postgres/catalog.ts";
import { BARRIER_SHAPES, HIDDEN_SHAPES, referenceSql, ROW_SHAPES, ROWS_ROLES, ROWS_SCHEMA, ROWS_USERS, TIER_SHAPES } from "./oracle/row-filters.ts";
import { countGap, emptyTally, fixtureText, gapSummary, type Met } from "./oracle/gap-tally.ts";
import { VERIFIED } from "../../src/duck/verified.ts";
import { describeKeys } from "../../src/duck/resolved.ts";
import { GAP_MARK, GAPS, type GapId } from "../../src/duck/gaps.ts";
import { deadGaps, FIRST_LEG_RUNS_STAGES, fixtureOf, legOf, legRefused, movedTallies, parseLeg, PHASES, statementId, verifiedDiff, verifiedText, WRITE_COMMAND, type LegReport, type Measured } from "../../scripts/oracle-legs.ts";
import type { RolesLive } from "../../src/duck/grants.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const adminUrl = process.env.IT_POSTGRES_URL;
/** a regular expression over the statements' names: only those run (a fix's check, minutes faster than all of them) */
const ONLY = process.env.IT_ORACLE_ONLY === undefined ? null : new RegExp(process.env.IT_ORACLE_ONLY);
/** `IT_ORACLE_LEG=1/2`: one leg of the oracle (scripts/oracle-legs.ts), its end-of-run assertions left to `integration (oracle)` */
const LEG = parseLeg(process.env.IT_ORACLE_LEG);
{ const refused = legRefused(process.env); if (refused !== null) throw new Error(refused); }
/** every statement was asked, so what only all of them can say may be said */
const WHOLE = ONLY === null && LEG === null;
/** `IT_ORACLE_SHAPES=0` leaves the shape multiplier out (oracle/shapes.ts): a quicker run while fixing one statement */
const SHAPES = process.env.IT_ORACLE_SHAPES !== "0";
/** `IT_ORACLE_JSON_PATHS=eager` stores every JSON path a statement reads before it is planned (src/duck/kept.ts, the
 *  test's own option): every such read is then answered from its stored column, and must still answer as Postgres */
const EAGER_JSON = process.env.IT_ORACLE_JSON_PATHS === "eager";
/** the DuckDB-alone pass's tallies (`duckdbAlone`, below): what docs/SQL-SUPPORT.md's comparison renders (tests/duck-gaps.test.ts) */
const ALONE_FIXTURE = path.join(REPO, "tests", "fixtures", "oracle-duckdb-alone.json");
const UPDATE_FIXTURE = process.env.UPDATE_FIXTURE === "1";
// the DuckDB-alone pass reads a timestamptz's JSON text in the process's zone (the client's conversion, not DuckDB's
// answer): UTC, as the session's TimeZone is, so that pass is not charged for the machine's clock
process.env.TZ = "UTC";
const tag = `it_duckoracle_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
/** the Postgres LOGIN role of the role cases (`roleCases`): a role is the cluster's, not the database's, so it is named
 *  for this run and dropped with the database */
const ROLE_LOGIN = `${tag}_agent`;
/** the Postgres LOGIN role of the `tables: all` role cases (stage 1b): GRANT SELECT ON ALL TABLES IN SCHEMA public */
const ROLE_ALL = `${tag}_all`;
/** the Postgres LOGIN of the no-role cases (stage 1b): CONNECT and USAGE only, against a Mason user with no role under a
 *  roles file with no default: */
const ROLE_NONE = `${tag}_none`;
/** the Postgres LOGIN of each row-filter user (`rowFilterCases`, oracle/row-filters.ts ROWS_USERS) */
const rowLogin = (key: string): string => `${tag}_rf_${key}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-duck-oracle-"));
const report = path.join(process.env.IT_LOG_DIR ?? os.tmpdir(), "duck-oracle-differences.txt");

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url], { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql.slice(0, 300)}`);
  return r.stdout.trim();
}

/** every table the oracle copies: the shop's, `one`, and the type matrix's (oracle/type-matrix.ts TYPED) */
const COPIED = [...TABLES, "one", "typed", "mapped", "grouped", "typed_arrays", "castable", "cased", "jcased", "jpath", "coll", "moods", "defaults", "late", "late_c", ...MERGE_COPIED, "top_a", "top_b", "top_c", "top_n", "top_r", "top_rc", "star_o", "star_b", "instants", "docs", "nullish", "jorder", "keyed", "pairs", "vkeys", "moodlog", ...LATEST_TABLES];

/** the one-row table every dialect case reads, so DuckDB (not the catalog Postgres) answers it */
const ONE = "CREATE TABLE public.one (id int PRIMARY KEY); INSERT INTO public.one VALUES (1);";
/** a relation of literal rows, read through `one`: `(…) AS t` becomes `(SELECT t.* FROM public.one CROSS JOIN (…) AS t) AS t` */
const viaOne = (rel: string): string => {
  const alias = /\) AS (\w+)$/.exec(rel)?.[1];
  assert.ok(alias, `a relation of literal rows ends with its alias: ${rel.slice(-40)}`);
  return `(SELECT ${alias}.* FROM public.one CROSS JOIN ${rel}) AS ${alias}`;
};
const throughOne = (sql: string): string => sql.replaceAll(T, viaOne(T)).replaceAll(U, viaOne(U)).replaceAll(Z, viaOne(Z));

type Answer = { names: string[]; oids: number[]; rows: (string | null)[][] } | { code: string; message: string; detail?: string | undefined };
const raw = { getTypeParser: () => (v: string) => v };
async function ask(c: pg.Client, sql: string, values?: string[], name?: string): Promise<Answer> {
  try {
    const r = await c.query({ text: sql, ...(values === undefined ? {} : { values }), ...(name === undefined ? {} : { name }), rowMode: "array", types: raw } as pg.QueryConfig);
    return { names: r.fields.map((f) => f.name), oids: r.fields.map((f) => f.dataTypeID), rows: r.rows as (string | null)[][] };
  } catch (e) {
    const d = e as pg.DatabaseError;
    if (d.code === undefined) throw e;
    return { code: d.code, message: d.message, detail: d.detail };
  }
}

/** a statement sorts its result when its OUTERMOST query has an ORDER BY (a parenthesised one inside does not count) */
const ordered = (sql: string): boolean => { let s = sql, prev = ""; while (s !== prev) { prev = s; s = s.replace(/\([^()]*\)/g, ""); } return /\border\s+by\b/i.test(s); };

/**
 * THE VERDICT ON ONE STATEMENT, as the kinds of difference a tool can see, worst first: a wrong VALUE (normalised as
 * the oracle does: `1.50` and `1.5` are one value), a different TEXT of the same value, a different TYPE (OID), a
 * different NAME, a refusal where Postgres answered (or the reverse, or another SQLSTATE). null when identical.
 */
export function verdict(want: Answer, got: Answer, inOrder: boolean): { kind: "value" | "rows" | "text" | "type" | "name" | "refused" | "answered" | "sqlstate"; detail: string } | null {
  if ("code" in want && "code" in got) return want.code === got.code ? null : { kind: "sqlstate", detail: `${got.code} ${got.message} where Postgres refuses ${want.code} ${want.message}` };
  if ("code" in want) return { kind: "answered", detail: `answered where Postgres refuses ${want.code} ${want.message}` };
  if ("code" in got) return { kind: "refused", detail: `${got.code} ${got.message}${got.detail ? ` (${got.detail})` : ""}` };
  if (want.rows.length !== got.rows.length) return { kind: "rows", detail: `${got.rows.length} row(s) where Postgres has ${want.rows.length}` };
  const key = (r: (string | null)[]): string => JSON.stringify(r);
  const sorted = (rs: (string | null)[][]): (string | null)[][] => [...rs].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const [w, g] = inOrder ? [want.rows, got.rows] : [sorted(want.rows), sorted(got.rows)];
  let text: string | null = null;
  for (let i = 0; i < w.length; i++) {
    for (let j = 0; j < w[i]!.length; j++) {
      const a = w[i]![j]!, b = g[i]![j]!;
      if (a === b) continue;
      const loc = `row ${i + 1}, ${JSON.stringify(want.names[j])}: ${JSON.stringify(b)} where Postgres has ${JSON.stringify(a)}`;
      if (!same(normalise(a), normalise(b))) {
        // the rows may be the same SET in another order: a sort difference, not a value
        if (inOrder && key(sorted(w).flat()) === key(sorted(g).flat())) return { kind: "rows", detail: `the same rows in another ORDER (first at ${loc})` };
        return { kind: "value", detail: loc };
      }
      text ??= loc;
    }
  }
  if (text !== null) return { kind: "text", detail: text };
  const types = want.oids.map((o, i) => o === got.oids[i] ? null : `${JSON.stringify(want.names[i])} OID ${got.oids[i]} where Postgres sends ${o}`).filter((x) => x !== null);
  if (types.length) return { kind: "type", detail: types.join(", ") };
  if (want.names.join("\u0000") !== got.names.join("\u0000")) return { kind: "name", detail: `${JSON.stringify(got.names)} where Postgres names ${JSON.stringify(want.names)}` };
  return null;
}

/**
 * SHOW ALL's part that is the session's, held alike while the rest is Mason's own (Mason gap show-all): Postgres's
 * fields (name, setting, description: text), and the settings both sessions set alike — TimeZone (SET at their start),
 * search_path, application_name (the startup's), DateStyle.
 */
const SESSION_SET = ["TimeZone", "search_path", "application_name", "DateStyle"];
/** a session's own settings SHOW ALL would list (`SET myapp.x`, a user's `mason.attr.x`): Postgres lists none, GUC_NO_SHOW_ALL */
const ownSettings = (a: Answered): string => a.rows.map((r) => r[0]).filter((n) => /^(myapp|mason)\./.test(n ?? "")).join(", ");
function showAllOwn(want: Answered, got: Answered): string | null {
  if (JSON.stringify([want.names, want.oids]) !== JSON.stringify([got.names, got.oids])) return `fields ${JSON.stringify([got.names, got.oids])} where Postgres sends ${JSON.stringify([want.names, want.oids])}`;
  return ownSettings(got) === ownSettings(want) ? null : `the session's own settings [${ownSettings(got)}] where Postgres lists [${ownSettings(want)}]`;
}
function showAllHolds(want: Answered, got: Answered): string | null {
  const own = showAllOwn(want, got);
  if (own !== null) return own;
  const setting = (a: Answered, name: string): string | null | undefined => a.rows.find((r) => r[0] === name)?.[1];
  const parted = SESSION_SET.filter((n) => setting(want, n) === undefined || setting(got, n) !== setting(want, n));
  return parted.length === 0 ? null : parted.map((n) => `${n}: ${JSON.stringify(setting(got, n))} where Postgres has ${JSON.stringify(setting(want, n))}`).join(", ");
}

/**
 * DECIDED DIFFERENCES: what the endpoint answers differently from Postgres on purpose, or cannot answer alike, each
 * with why. Each must STILL differ (a fixed one is removed), but one whose truth depends on the machine's floating-point
 * arithmetic (`machineFloat`, oracle/known.ts) may agree on this machine; nothing else may differ. One that `holds`
 * part of the answer may differ in any kind but there.
 */
const KNOWN: Decided[] = [
  // a domain's column is its base type's: the wire and data_type say so on Postgres too, pg_typeof and format_type do not
  { sql: /pg_typeof\(d[itzp]\)|attname = 'd[itzp]'/, kind: "value", gap: "domain-column", why: "a domain's column is read and declared as its base type" },
  // SHOW ALL (Postico sends it at every connection): the listener's settings — its catalog Postgres's, the session's
  // laid over — never the source's, so its values differ (and its rows, where the two servers list other settings); its
  // fields and the rows the sessions set are held alike (`holds`)
  { sql: /^SHOW ALL$/, kind: "value", gap: "show-all", why: "the catalog Postgres's settings with the session's laid over, never the source's", holds: showAllHolds },
  // A NUMERIC COLUMN OF VALUES OF SEVERAL SCALES: Postgres keeps each value's (`1` beside `1.5`), a DuckDB DECIMAL
  // column has one (`1.0`). Only where values of two scales meet in ONE column — a UNION of an integer and a numeric,
  // a window function's default — which the exact programs (src/duck/rewrite.ts ExactColumn) cannot reach
  { sql: /^SELECT v FROM \(SELECT 1 AS v FROM public\.one UNION ALL SELECT 1\.5 FROM public\.one\)/, kind: "text", gap: "mixed-scale-numeric", why: "a DuckDB DECIMAL column has one scale; Postgres's numeric keeps each value's" },
  { sql: /^SELECT id AS v FROM \(SELECT t\.\* FROM public\.one CROSS JOIN \(SELECT 1 AS id, 'Ab' AS name, 1\.5 AS x/, kind: "text", gap: "mixed-scale-numeric", why: "an integer UNION ALL a numeric: Postgres's `1`, DuckDB's DECIMAL `1.0`" },
  { sql: /lead\(x, 1, 0\) OVER/, kind: "text", gap: "mixed-scale-numeric", why: "lead's default 0 beside numeric(2,1) values: Postgres's `0`, DuckDB's DECIMAL `0.0`" },
  // THE TYPE MATRIX'S DECIDED ONES (oracle/type-matrix.ts): what a double's bits, -0 and an overflow do
  { sql: /greatest\((\w+, f4|f4, \w+)\), least/, kind: "text", gap: "negative-zero", why: "least(-0, 0): Postgres keeps the first, DuckDB the other" },
  { sql: /percentile_disc\(0\.25\) WITHIN GROUP \(ORDER BY f[48]\)/, kind: "text", gap: "negative-zero", why: "percentile_disc picks -0 or 0 of equal values" },
  { sql: /stddev\(f4\)/, kind: "text", gap: "float-last-digit", why: "a float's stddev: Youngs-Cramer in Postgres, another accumulation in DuckDB" },
  // (a double's stddev, the 17th digit, differed after the polls' writes while the copy was in key order; now the
  // copy is in the heap's order and the oracle's rows meet DuckDB's accumulation in Postgres's order. A real heap's
  // updates may still part the two orders: float-last-digit says that last digit may differ). In that order it is
  // alike on aarch64, Linux or macOS, and differs on CI's x86_64 runner (variance 1.6935087641981325e+15 where Postgres
  // has …328e+15): the machine's arithmetic decides, so `machineFloat`. Its pieces are verified by the rounded one,
  // "stddev / variance of a double" (oracle/type-matrix.ts), alike on every machine
  { sql: /^SELECT stddev\(f8\), stddev_samp\(f8\), stddev_pop\(f8\), variance\(f8\), var_samp\(f8\), var_pop\(f8\) FROM typed/, kind: "text", gap: "float-last-digit", why: "a double's variance, the 17th digit: Youngs-Cramer in Postgres, DuckDB's accumulation, apart on x86_64", machineFloat: true },
  // (log10's last digit: it differs with Postgres in a Linux container and Mason on macOS, and agrees with both on
  // Linux, as in CI, or both on macOS: the machines' math libraries decide, so `machineFloat`)
  // (a source of another collation meets none of these, so `collation` decides staleness, and each gap's `heldBy` is this file:
  // Mason gap libc-mark-run-form
  // Mason gap libc-rare-letter
  // Mason gap fromless-text-order)
  { sql: /^SELECT 'a6ß' > E'a\\u03086ß' FROM public\.one$/, collation: "libc", kind: "value", gap: "libc-mark-run-form", why: "a mark's skipped run compares ß's third level with a digit's: glibc's one scale, Mason's per letter" },
  { sql: /^SELECT 'a' < 'B'$/, collation: "not-c", kind: "value", gap: "fromless-text-order", why: "the catalog answers a SELECT of no table, in byte order (issue 141)" },
  { sql: /^SELECT E'\\uA79A' < E'\\u00C4' FROM public\.one$/, collation: "libc", kind: "value", gap: "libc-rare-letter", why: "a rare letter's weight no spelling of it says" },
  { sql: /sqrt\(abs\((i2|f4)\)\)/, kind: "text", gap: "float-last-digit", why: "log10's last digit: libm's against DuckDB's", machineFloat: true },
  { sql: /sqrt\(abs\((i4|i8|f8)\)\)/, kind: "answered", gap: "float-overflow", why: "exp past a double's range: Postgres's error, DuckDB's Infinity (or 0 below it)" },
  { sql: /stddev\(DISTINCT (i4|n2)\)|stddev\(n\)/, kind: "text", gap: "numeric-stddev", why: "Postgres's numeric stddev of DISTINCT values, or of an unconstrained numeric, is exact to its scale; DuckDB's a double" },
  { sql: /greatest\(ch, (t|vc)\)/, kind: "value", gap: "char-n-minmax", why: "least(char(5) '', text ''): Postgres compares without the padding" },
  { sql: /^SELECT min\(a \/ b\), max\(a \/ b\) FROM public\.one, \(VALUES/, kind: "text", gap: "min-max-scale-tie", why: "min of 0 / 7 and 0 / 1000000, equal values at two scales: Postgres keeps the last it reads, Mason the least operands" },
  { sql: /^SELECT sum\(x\) FROM \(SELECT 7 \/ 3\.0 AS x/, kind: "text", gap: "nested-exact-numeric", why: "the subquery's 7 / 3.0 is DuckDB's double where the outer query sums it (an outer x * 2 now reads its program)" },
  { sql: /^SELECT count\(\*\) FROM public\.one, \(VALUES \(1\.00000000000000000001::numeric\(30,20\)\), \(1\.00000000000000000002\)\) AS v\(x\) WHERE v\.x \/ 1 IN \(1\.00000000000000000001\)$/, kind: "value", gap: "numeric-quotient-compare", why: "IN equates the two quotients' doubles, which Postgres's exact values tell apart" },
  { sql: /^SELECT DISTINCT ON \(l\.c\) l\.c, l\.id, \(l\.j ->> 'n'\)::int AS n FROM late l ORDER BY l\.c, l\.id LIMIT 3$/, kind: "answered", gap: "limit-errors", why: "row 2000's 'x' is in c = 0's group but not its first row: Postgres computes the list below its Unique for every row, Mason chooses the kept rows by row number and computes the list for them" },
  { sql: /^SELECT upper\('\u{10D70}'\)/u, kind: "value", gap: "unicode-16-case", why: "a Garay letter (Unicode 16): DuckDB's ICU predates it" },
  { sql: /^SELECT q\.id, x FROM docs q LEFT JOIN unnest\(ARRAY\[q\.id, \(CASE WHEN q\.id = 10 THEN 'x' ELSE '1' END\)::int\]\) x ON TRUE LIMIT 3$/, kind: "refused", gap: "limit-errors", why: "row 10's 'x' is no integer, and the limit leaves it out: Postgres stops at row 2, DuckDB computes a lateral's argument a vector of rows at a time" },
  { sql: /^SELECT q\.id, d\.key FROM docs q LEFT JOIN jsonb_each\(CASE WHEN q\.id % 1 = 0 AND q\.id > 2 THEN q\.jb END\) d ON TRUE LIMIT 3$/, kind: "refused", gap: "limit-errors", why: "an array document in a row the limit leaves out: Postgres stops before it, DuckDB computes a lateral's argument a vector of rows at a time" },
  { sql: /^SELECT c\.id, d\.id AS d, d\.n FROM late_c c JOIN \(SELECT l\.id, l\.k, l\.c, \(l\.j ->> 'n'\)::int AS n FROM late l\) d ON d\.c = c\.id ORDER BY d\.k DESC LIMIT 3$/, kind: "answered", gap: "limit-errors", why: "row 2000's 'x' is no integer, and the limit leaves it out: Postgres computes the derived list and sorts every row, Mason computes it for the rows chosen" },
  { sql: /^SELECT \* FROM \(SELECT l\.id, \(l\.j ->> 'n'\)::int AS n, l\.k, c\.name FROM late l JOIN late_c c ON c\.id = l\.c\) t ORDER BY t\.k DESC LIMIT 3$/, kind: "answered", gap: "limit-errors", why: "row 2000's 'x' is no integer, and the limit leaves it out: a wrapper's list folded into its join is computed for the rows chosen" },
  { sql: /^SELECT l\.id, \(l\.j ->> 'n'\)::int, c\.name FROM late l LEFT JOIN late_c c ON c\.id = l\.c ORDER BY l\.k DESC LIMIT 3$/, kind: "answered", gap: "limit-errors", why: "row 2000's 'x' is no integer, and the limit leaves it out: Postgres sorts every row (no index on k) and raises, Mason computes the list for the kept rows" },
  { sql: /^SELECT a\.id, \(SELECT 1 \/ \(a\.id - 7\)\) AS x FROM top_a a LEFT JOIN top_b b ON b\.a_id = a\.id ORDER BY a\.name, a\.id, b\.id LIMIT 2$/, kind: "answered", gap: "limit-errors", why: "row 7's division by zero, and the limit leaves it out: Postgres computes a subquery this cheap below its sort, for every row, Mason computes the list's subquery for the rows chosen" },
  { sql: /^SELECT x\.id, x\.e FROM \(SELECT s\.id, s\.e::text AS e FROM \(SELECT q\.id, e FROM docs q LEFT JOIN jsonb_array_elements\(.*\) e ON TRUE\) s WHERE s\.id > \$1\) x LIMIT/, kind: "value", gap: "limit-lateral-filter", why: "a parameter in the filter around the lateral: DuckDB plans the streamed UNNEST as a delimiter join, and the LIMIT keeps other rows (the same statement with the literal keeps Postgres's)" },
  { sql: /\), b AS \(SELECT \* FROM a WHERE a\.id > 3\) SELECT \* FROM b LIMIT 40 OFFSET 23$/, kind: "value", gap: "limit-lateral-filter", why: "a filter in the CTE that reads the lateral's CTE: DuckDB plans the streamed UNNEST as a delimiter join, and the LIMIT keeps other rows" },
  { sql: /^SELECT q\.id, d\.key FROM docs q LEFT JOIN jsonb_each\(.*\) d ON TRUE WHERE d\.key <> 'n' LIMIT 40$/, kind: "value", gap: "limit-lateral-filter", why: "a filter on the lateral's own column: DuckDB plans the streamed UNNEST as a delimiter join, and the LIMIT keeps other rows" },
  { sql: /^SELECT \* FROM \(SELECT t\.id, t\.jb FROM docs t\) q LEFT JOIN jsonb_each\(CASE WHEN q\.id % 4 <> 1 AND .*\) d ON TRUE LIMIT 40 OFFSET 7$/, kind: "value", gap: "limit-lateral-argument", why: "an argument of two columns under a `*`: DuckDB plans the streamed UNNEST as a delimiter join, and the LIMIT keeps other rows (a step of its own would be a column the `*` reads)" },
  { sql: /^SELECT q\.id, v FROM docs q LEFT JOIN unnest\(ARRAY\(SELECT e FROM jsonb_array_elements_text\(.*\) e\)\) v ON TRUE LIMIT 50 OFFSET 7$/, kind: "value", gap: "limit-lateral-argument", why: "a subquery in the lateral's argument: DuckDB plans the streamed UNNEST as a delimiter join in every form, and the LIMIT keeps other rows" },
  { sql: /^SELECT q\.id, d\.key, row_number\(\) OVER (\(PARTITION BY q\.id\)|w) AS r/, kind: "value", gap: "window-partition-order", why: "row_number / lag / first_value over PARTITION BY with no ORDER BY: DuckDB's partitioning hands a partition's rows back in its own order, streamed lateral or not" },
];

let server: PgApiServer | null = null;
let store: DuckStore | null = null;
let sync: Sync | null = null;
const clients: pg.Client[] = [];
after(async () => {
  for (const c of clients) await c.end().catch((e: Error) => console.error(`a client's end: ${e.message}`));
  if (server) await server.close();
  // the sync's next pass is a timer: left running, it holds the process open after a failed assertion
  await sync?.stop();
  store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (adminUrl) psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
  // the role cases' login role (its grants went with the database)
  if (adminUrl) psql(adminUrl, `DROP ROLE IF EXISTS ${ROLE_LOGIN}; DROP ROLE IF EXISTS ${ROLE_ALL}; DROP ROLE IF EXISTS ${ROLE_NONE}; ` +
    ROWS_USERS.map((u) => `DROP ROLE IF EXISTS ${rowLogin(u.key)};`).join(" "));
});

test("the DuckDB endpoint answers every statement exactly as Postgres does, before and after changes", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 1_800_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, SCHEMA);
  const s = seed();
  psql(dbUrl, s.sql);
  psql(dbUrl, STAMPING);
  psql(dbUrl, ONE);
  psql(dbUrl, META);
  psql(dbUrl, TYPED);
  psql(dbUrl, ROWS_SCHEMA);
  // latest(x ORDER BY …), Mason's aggregate, declared here from the catalog's own definition: like with like
  psql(dbUrl, `${LATEST_SQL.map((s) => `${s};`).join("\n")}\n${LATEST_SCHEMA}`);
  const collation = psql(dbUrl, "SELECT datcollate || ' (' || datlocprovider::text || ')' FROM pg_database WHERE datname = current_database()");
  console.log(`duck oracle: database ${tag}, collation ${collation}`);

  // ---- the copy and the listener, as `mason start` runs them ----------------------------------------------------
  const parsed = parseSource(dbUrl);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const conn = await connectSource(parsed.source);
  if ("failure" in conn) throw new Error(`connect: ${JSON.stringify(conn.failure)}`);
  const facts = await readSourceFacts(conn.pg);
  conn.pg.close();
  // top_n has no primary key: it is copied as a sources file's `key:` would copy it, and the catalog declares none
  const added = facts.tables.filter((t) => COPIED.includes(t.table) && t.schema === "public").map((t) => t.table === "top_n" ? { ...t, key: ["a", "b"], primaryKey: [] } : t);
  assert.equal(added.length, COPIED.length, `the oracle's tables in the catalog: ${facts.tables.map((t) => t.source).join(", ")}`);
  // the row filters' own shop (oracle/row-filters.ts), copied beside the rest and read by `rowFilterCases` alone
  const shop = facts.tables.filter((t) => t.schema === "shop");
  assert.deepEqual(shop.map((t) => t.source).sort(), ["shop.accounts", "shop.customers", "shop.invoice_lines", "shop.invoices", "shop.order_items", "shop.orders"]);
  const log: string[] = [];
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => log.push(l));
  sync = new Sync(store, parsed.source, tag, (l) => log.push(l), 3_600_000, "poll", null, EAGER_JSON ? { json: { eager: true } } : {});
  await sync.open();
  sync.setTables([...added, ...shop]);
  sync.setViews(facts.views ?? []);
  await sync.once();
  assert.deepEqual(sync.state().filter((x) => x.phase !== "copied").map((x) => `${x.source} ${x.phase} ${x.error}`), [], "every table copied");
  // THE ORACLE RUNS AS A USER'S INSTALL DOES, with the copy's extensions from this platform's package (src/duck/extensions.ts):
  // autoinstall off and both files the package's, so every statement it holds equal is answered with nothing
  // downloaded, and a regression to downloading fails here rather than passing on the engine's own install
  const x = store.extensions;
  assert.ok(x?.shipped, `the oracle runs with the copy's extensions installed from their package: ${x && !x.shipped ? x.why : "none found"}. ` +
    "Run node cli/extensions.ts --node-modules node_modules once at the repo's root (CI's integration job does)");
  const ext = (await store.writer.runAndReadAll("SELECT current_setting('autoinstall_known_extensions'), current_setting('extension_directory')")).getRowsJS();
  assert.deepEqual(ext, [[false, x.directory]]);
  const files = (await store.writer.runAndReadAll("SELECT extension_name, loaded, install_path FROM duckdb_extensions() WHERE extension_name IN ('postgres_scanner', 'inet') ORDER BY 1")).getRowsJS();
  assert.deepEqual(files.map(([name, loaded, at]) => [name, loaded, String(at).startsWith(x.directory)]), [["inet", false, true], ["postgres_scanner", true, true]],
    `the copy's postgres extension is loaded from the package and inet would autoload from it: ${JSON.stringify(files)}`);
  const theStore = store, theSync = sync;
  // WHAT EACH STATEMENT WAS MADE OF (src/duck/resolved.ts), recorded as it is planned — with nothing refused for being
  // unverified, since this run is what verifies it
  // a libc collation's order, read from the database as `mason start` reads it (src/duck/libc-order.ts)
  const coll = facts.collation;
  const libc = coll !== undefined && isLibcCollation(coll.provider, coll.collate) ? (await theStore.libcOrder(coll.collate, coll.version ?? null, async () => {
    const c = await connectSource(parsed.source);
    if ("failure" in c) throw new Error(`connect: ${JSON.stringify(c.failure)}`);
    try { return await readLibcOrder(async (sql) => (await c.pg.query(sql)).rows, coll.collate, coll.version ?? null); } finally { c.pg.close(); }
  })).order : undefined;
  // the stored JSON paths as mason start serves them (on by default): a `*` reads each copy's visible columns
  const duck = await theStore.listener(facts.collation, null, libc, () => [], theSync.kept);
  /**
   * DUCKDB ALONE (why a user would not just use DuckDB by itself): the same statement, as written, to
   * a plain connection of the same copy — no analysis, no rewrite, no Mason function — scored by the oracle's own
   * verdict (names, rows, text; the OIDs taken as Postgres's, since DuckDB has none). The tallies are
   * tests/fixtures/oracle-duckdb-alone.json, which docs/SQL-SUPPORT.md's comparison renders; UPDATE_FIXTURE=1 rewrites it, and
   * a run whose tallies moved by more than a percentage point of the statements fails until it is. Its `gaps` detail
   * (oracle/gap-tally.ts) is rewritten with it and never compared: one statement moving between two gaps is no
   * failure, and a total that moves is already held, so the detail reads as of the last UPDATE_FIXTURE=1. It is that
   * run's, and more than the statements decide it: the decided counts part by machine (a float's last digit, and which
   * of -0 and 0 an aggregate keeps), shapes off leaves out what only a shape meets, and a C or ICU database what only
   * libc meets. `measured` says what it was measured on; tests/duck-gaps.test.ts holds shapes on, libc and Linux.
   */
  const alone = await theStore.instance.connect();
  await alone.run("SET search_path = 'public'");
  await alone.run("SET TimeZone = 'UTC'");
  const askAlone = async (sql: string): Promise<Answer> => {
    try {
      const r = await alone.runAndReadAll(sql);
      const rows = r.getRowsJson().map((row) => row.map((v) => v === null ? null : typeof v === "string" ? v : typeof v === "boolean" ? (v ? "t" : "f") : typeof v === "object" ? JSON.stringify(v) : String(v)));
      return { names: [...r.columnNames], oids: [], rows };
    } catch (e) { return { code: "XX000", message: (e as Error).message.split("\n")[0] ?? "" }; }
  };
  if (EAGER_JSON) console.log("duck oracle: every JSON path a statement reads is stored before it is planned (IT_ORACLE_JSON_PATHS=eager)");
  const resolvedOf = new Map<string, readonly string[]>();
  const planOf = duck.plan.bind(duck);
  duck.plan = async (...a) => { const p = await planOf(...a); resolvedOf.set(a[1], p.resolved); return p; };
  // THE ROLE (GitHub issue 30, src/duck/grants.ts): one Mason role as `mason/roles.yml` resolves it — three columns of
  // orders, customers whole — mirrored by a Postgres role with the same GRANTs (`roleCases`, below); every other
  // session has no role, so every statement above is planned with its reads named (null grants) and nothing refused
  const ROLE_FILE = "mason/roles.yml";
  let roles: RolesLive = { file: ROLE_FILE, problem: null, default: null, grants: new Map([["agent", { name: "agent", file: ROLE_FILE, all: false, tables: new Map([
    ["public.orders", { table: "public.orders", all: false, columns: ["id", "customer_id", "status", "amount"] }],
    ["public.customers", { table: "public.customers", all: true, columns: [] }]]) }]]) };
  server = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: tag, masonVersion: "oracle",
    authenticate: (_password, user) => {
      const rows = ROWS_USERS.find((u) => rowLogin(u.key) === user);
      if (rows !== undefined) return { user, role: rows.role, attributes: rows.attributes };
      return user === ROLE_LOGIN ? { user, role: "agent" } : user === ROLE_ALL ? { user, role: "everything" } : user === ROLE_NONE ? { user } : {};
    },
    roles: () => roles,
    schema: () => theSync.schema(),
    record: () => undefined, log: (l) => log.push(l),
    duck,
  });
  const source = new pg.Client({ connectionString: dbUrl, application_name: "duck-oracle" });
  const mason = new pg.Client({ host: "127.0.0.1", port: server.port, database: tag, user: "oracle", password: "x", application_name: "duck-oracle" });
  for (const c of [source, mason]) { await c.connect(); clients.push(c); await c.query("SET TimeZone = 'UTC'"); }

  // ---- every statement, both ways -------------------------------------------------------------------------------
  const tableSql = (t: string): string => `SELECT * FROM public.${t} ORDER BY ${KEY_OF[t] ?? "id"} COLLATE "C"`;
  const every = (): Array<{ group: string; name: string; sql: string; inOrder?: boolean; zone?: string }> => [
    ...COPIED.map((t) => ({ group: "copy", name: `the table ${t}, whole`, sql: tableSql(t) })),
    ...CASES.map((c) => ({ group: "dialect", name: c, sql: `SELECT ${c} FROM public.one` })),
    ...QUERY_CASES.map((q) => ({ group: "query case", name: q.slice(0, 80), sql: throughOne(q) })),
    ...REFUSED_CASES.map((q) => ({ group: "refused case", name: q.sql.slice(0, 80), sql: throughOne(q.sql) })),
    ...BI_SHAPES.map((q) => ({ group: "BI shape", name: q.name, sql: q.sql })),
    ...TYPE_MATRIX.map((q) => ({ group: "type matrix", name: q.name, sql: q.sql, ...(q.zone === undefined ? {} : { zone: q.zone }) })),
    ...GAP_CASES.map((q) => ({ group: "gap case", name: `gap case: ${q.gap}`, sql: q.sql })),
    ...LATEST_CASES.map((q) => ({ group: "latest", name: q.name, sql: q.sql })),
    { group: "decided", name: "numeric values of several scales", sql: MIXED_SCALE },
  ];
  const all = (): ReturnType<typeof every> => every().filter((q) => (ONLY === null || ONLY.test(q.name)) && (LEG === null || legOf(q.sql, LEG.of) === LEG.leg));
  /** a statement of oracle/unordered-limit.ts: asked apart from `all()`, in every phase, by the leg its text hashes to */
  const unorderedSql = (q: UnorderedLimit): string => `${q.head ?? ""}SELECT ${q.list} ${q.from} ${q.tail}`;
  const unorderedStatement = (q: UnorderedLimit): { group: string; name: string; sql: string } => ({ group: "unordered limit", name: `unordered limit: ${q.name}`, sql: unorderedSql(q) });
  /** the statements as they were asked, by phase, for scripts/oracle-legs.ts to hold to `every` */
  const askedIn: Record<string, string[]> = {};
  /** what each stage of one session asked; a leg without the stages asks none */
  const stageAsked: LegReport["stages"] = {};
  const differences: Array<{ phase: string; group: string; kind: string; name: string; detail: string; sql: string }> = [];
  // the decided differences a statement differed by, and those that decided a statement asked (oracle/known.ts)
  const known = new Set<Decided>(), decided = new Set<Decided>();
  // a statement verifies what it is made of when DuckDB answered it with rows, exactly as Postgres, in every phase
  const unproven = new Set<string>();
  /** the copy phase's tallies: how Mason answered each statement, and how DuckDB alone did (`duckdbAlone`) */
  const tallies = { statements: 0, mason: { exact: 0, decided: 0, refused: 0, differs: 0 }, duckdb: { exact: 0, name: 0, refused: 0, value: 0, rows: 0, text: 0, other: 0 } };
  // the gaps (src/duck/gaps.ts) the statements met: a refusal that names one, a decided difference. One place counts
  // both the total and its gap, so each gap's count sums to `tallies.mason` (oracle/gap-tally.ts, the two measures)
  const copyPhaseGaps = emptyTally(), everyAskGaps = emptyTally();
  const meet = (met: Met, g: GapId, group: string, first: boolean): void => {
    countGap(everyAskGaps, met, g, group);
    if (first) { tallies.mason[met]++; countGap(copyPhaseGaps, met, g, group); }
  };
  /** A REFUSAL BY NAME: Mason's 0A000 naming a refused gap, where Postgres answers (or refuses otherwise) */
  const namedGap = (got: Answer): GapId | null => {
    const named = "code" in got && got.code === "0A000" ? GAP_MARK.exec(`${got.message} ${got.detail ?? ""}`)?.[1] : undefined;
    return named !== undefined && named in GAPS && GAPS[named as GapId].kind === "refused" ? named as GapId : null;
  };
  let shaped = 0;
  // the sessions' TimeZone: UTC, as set at their start, until a statement asks for another
  let zone = "UTC";
  const run = async (phase: string): Promise<void> => {
    const first = phase === PHASES[0];
    for (const q of all()) {
      (askedIn[phase] ??= []).push(statementId(q));
      // A STATEMENT ASKED IN A SESSION ZONE OF ITS OWN (`zone`; UTC otherwise): both sessions, and DuckDB alone, set to it
      if ((q.zone ?? "UTC") !== zone) {
        zone = q.zone ?? "UTC";
        for (const c of [source, mason]) await c.query(`SET TimeZone = '${zone}'`);
        if (first) await alone.run(`SET TimeZone = '${zone}'`);
      }
      const [want, got] = [await ask(source, q.sql), await ask(mason, q.sql)];
      const v = verdict(want, got, q.inOrder ?? ordered(q.sql));
      if (first) {
        tallies.statements++;
        const a = verdict(want, await askAlone(q.sql).then((x) => "code" in x || "code" in want ? x : { ...x, oids: want.oids }), q.inOrder ?? ordered(q.sql));
        const kind = a === null ? "exact" : a.kind === "name" ? "name" : a.kind === "refused" ? "refused" : a.kind === "value" ? "value" : a.kind === "rows" ? "rows" : a.kind === "text" ? "text" : "other";
        tallies.duckdb[kind]++;
      }
      if (v !== null || "code" in got) unproven.add(q.sql);
      const k = KNOWN.find((x) => x.sql.test(q.sql));
      if (k) decided.add(k);
      // a decision that HOLDS part of the answer alike (SHOW ALL's fields and the rows the sessions set): that part
      // differing, or a refusal on either side, is a difference like any other; the rest may differ in any kind
      const broken = k?.holds === undefined ? null : "code" in got ? `refused: ${got.code} ${got.message}` : "code" in want ? `answered where Postgres refuses ${want.code} ${want.message}` : k.holds(want, got);
      if (broken !== null) { if (first) tallies.mason.differs++; differences.push({ phase, group: q.group, kind: "held", name: q.name, detail: broken, sql: q.sql }); continue; }
      // a decided case differing in ANOTHER way than decided is a difference like any other
      if (k && (v === null || v.kind === k.kind || k.holds !== undefined)) { unproven.add(q.sql); if (v !== null) { known.add(k); meet("decided", k.gap, q.group, first); } else if (first) tallies.mason.exact++; continue; }
      const gap = v === null ? null : namedGap(got);
      if (gap !== null) { meet("refused", gap, q.group, first); continue; }
      if (v !== null) { if (first) tallies.mason.differs++; differences.push({ phase, group: q.group, kind: v.kind, name: q.name, detail: v.detail, sql: q.sql }); continue; }
      if (first) tallies.mason.exact++;
      // THE SHAPES (oracle/shapes.ts), once, of what both answered alike with rows: the same answer at another depth
      if (!first || "code" in want || q.group === "copy" || SHAPES === false) continue;
      for (const s of await shapesOf(q.sql, q.inOrder ?? ordered(q.sql))) {
        shaped++;
        const [sw, sg] = [await ask(source, s.sql, s.values), await ask(mason, s.sql, s.values)];
        const sv = verdict(sw, sg, s.inOrder);
        // a decided difference a shape alone meets (a filter's literal sent as a parameter: limit-lateral-filter),
        // decided before an agreement so one that no longer differs is said so (staleDecisions)
        const sk = KNOWN.find((x) => x.sql.test(s.sql));
        if (sk) decided.add(sk);
        if (sv === null) continue;
        const sgap = namedGap(sg);
        if (sgap !== null) { meet("refused", sgap, q.group, false); continue; }
        if (sk && sv.kind === sk.kind) { known.add(sk); meet("decided", sk.gap, q.group, false); continue; }
        differences.push({ phase, group: `${q.group} [${s.shape}]`, kind: sv.kind, name: `${q.name} [${s.shape}]`, detail: sv.detail,
          sql: s.values === undefined ? s.sql : `${s.sql} -- with ${JSON.stringify(s.values)}` });
      }
    }
  };
  /** a LIMIT with no ORDER BY: what is defined of its rows, held (oracle/unordered-limit.ts); null where it holds */
  const unorderedLimit = async (q: UnorderedLimit, source: pg.Client, mason: pg.Client): Promise<string | null> => {
    const sql = unorderedSql(q), head = q.head ?? "";
    if (q.zone !== undefined) for (const c of [source, mason]) await c.query(`SET TimeZone = '${q.zone}'`);
    const [want, whole, got] = [await ask(source, sql, q.values), await ask(source, `${head}SELECT ${q.list} ${q.whole ?? q.from}`), await ask(mason, sql, q.values)];
    if (q.zone !== undefined) for (const c of [source, mason]) await c.query("SET TimeZone = 'UTC'");
    if ("code" in want || "code" in whole) return `Postgres refuses it: ${JSON.stringify("code" in want ? want : whole)}`;
    if ("code" in got) return `refused: ${got.code} ${got.message}`;
    const wrong = withinWhole(want, whole.rows, got);
    if (wrong !== null || q.pages === undefined) return wrong;
    const rows: (string | null)[][] = [];
    for (let offset = 0; offset < whole.rows.length; offset += q.pages) {
      const page = await ask(mason, `${head}SELECT ${q.list} ${q.from} LIMIT ${q.pages} OFFSET ${offset}`);
      if ("code" in page) return `page at ${offset} refused: ${page.code} ${page.message}`;
      rows.push(...page.rows);
    }
    return everyRowOnce(rows, whole.rows);
  };
  const unorderedLimits = async (phase: string): Promise<void> => {
    for (const q of UNORDERED_LIMITS) {
      const { name, sql } = unorderedStatement(q);
      if (ONLY !== null && !ONLY.test(name)) continue;
      if (LEG !== null && legOf(sql, LEG.of) !== LEG.leg) continue;
      (askedIn[phase] ??= []).push(statementId(unorderedStatement(q)));
      const wrong = await unorderedLimit(q, source, mason);
      if (wrong !== null) differences.push({ phase, group: "unordered limit", kind: "rows", name, detail: wrong, sql: unorderedSql(q) });
    }
  };
  await run(PHASES[0]);
  await unorderedLimits(PHASES[0]);
  alone.closeSync();
  // sessions asked in order, never divided: each runs whole in one leg (scripts/oracle-legs.ts STAGES)
  if (LEG === null || LEG.leg === FIRST_LEG_RUNS_STAGES) {
    await roleCases();
    await rowFilterCases();
    await settingCases();
    await settingScripts();
  }
  for (const round of [1, 2]) {
    psql(dbUrl, mutations(round) + typedMutations(round));
    await sync.once();
    await run(PHASES[round]!);
    await unorderedLimits(PHASES[round]!);
  }
  const asked = all().length * 3 + shaped;
  // the DuckDB-alone tallies, held to the fixture docs/SQL-SUPPORT.md renders (a percentage point of the statements of
  // play), and the gaps' detail beside them: here, past the last phase, as `everyAsk` counts every phase. A leg reports
  // its part, and `measured`, for scripts/oracle-legs.ts --write
  const measured: Measured = {
    what: "the copy phase of tests/integration/duck-oracle.itest.ts, each statement as written to a plain DuckDB connection over the same copy",
    machine: `${process.platform} ${process.arch}`, postgres: psql(dbUrl, "SELECT version()").split(",")[0]!, collation, shapes: SHAPES,
  };
  if (WHOLE) {
    const fixture = fixtureOf(tallies, copyPhaseGaps, everyAskGaps, asked, measured);
    const pct = (n: number): string => `${(100 * n / tallies.statements).toFixed(1)}%`;
    console.log(`duck oracle, DuckDB alone: ${tallies.statements} statements: exact ${pct(tallies.duckdb.exact)}, the rows under its own names ${pct(tallies.duckdb.name)}, refused ${pct(tallies.duckdb.refused)}, ` +
      `a wrong value ${pct(tallies.duckdb.value)}, wrong rows ${pct(tallies.duckdb.rows)}, other text ${pct(tallies.duckdb.text)}, other ${pct(tallies.duckdb.other)}; ` +
      `Mason: exact ${pct(tallies.mason.exact)}, decided ${pct(tallies.mason.decided)}, refused by name ${pct(tallies.mason.refused)}, differs ${pct(tallies.mason.differs)}`);
    if (UPDATE_FIXTURE) { fs.writeFileSync(ALONE_FIXTURE, fixtureText(fixture)); console.log(`UPDATE_FIXTURE=1: wrote ${ALONE_FIXTURE}`); }
    else {
      const was = JSON.parse(fs.readFileSync(ALONE_FIXTURE, "utf8")) as typeof fixture;
      const moved = movedTallies(tallies, was);
      assert.deepEqual(moved, [], `${ALONE_FIXTURE} is not what this run measured (docs/SQL-SUPPORT.md's comparison renders it): regenerate with ${WRITE_COMMAND} and read the diff`);
    }
  }

  /**
   * ROLES, HELD TO POSTGRES'S OWN GRANTS: a Postgres role with `GRANT SELECT (columns)` on orders and `GRANT SELECT` on
   * customers, a session as it, and a Mason session as a user with the role above; every statement asked of both —
   * what a role may read, and a hidden column read in every shape a statement can read one — must be answered alike,
   * and a refusal must carry the same SQLSTATE AND MESSAGE (`permission denied for table orders`: Postgres never names
   * the column; Mason's DETAIL does). The catalog too: information_schema and the privilege functions answer for the
   * role as Postgres's do. (A view is not asked: every role may see a view in Mason, docs/POSTGRES-API.md "Roles".)
   */
  async function roleCases(): Promise<void> {
    // `decided`: Mason refuses with this SQLSTATE where Postgres answers (the gap `roles`, docs/POSTGRES-API.md "Roles")
    const cases: Array<{ name: string; sql: string; values?: string[]; decided?: string }> = [
      { name: "granted columns", sql: "SELECT id, status, amount FROM public.orders ORDER BY id" },
      { name: "count(*) over a partly granted table", sql: "SELECT count(*) FROM public.orders" },
      { name: "a GROUP BY of granted columns", sql: "SELECT status, count(*), sum(amount) FROM public.orders GROUP BY status ORDER BY status" },
      { name: "a join on granted columns", sql: "SELECT c.name, count(o.id) FROM public.orders o JOIN public.customers c ON c.id = o.customer_id GROUP BY c.name ORDER BY c.name" },
      { name: "a whole table granted, *", sql: "SELECT * FROM public.customers ORDER BY id" },
      { name: "no table read", sql: "SELECT 1 + 1 AS two" },
      { name: "a parameter over granted columns", sql: "SELECT id FROM public.orders WHERE status = $1 ORDER BY id", values: ["paid"] },
      { name: "a hidden column in a WHERE", sql: "SELECT id FROM public.orders WHERE notes IS NULL" },
      { name: "a hidden column in a CTE", sql: "WITH n AS (SELECT notes FROM public.orders) SELECT count(*) FROM n" },
      { name: "a hidden column in a subquery", sql: "SELECT (SELECT max(notes) FROM public.orders) AS m" },
      { name: "a hidden column in a USING join", sql: "SELECT o.status FROM public.orders o JOIN public.customers c USING (tenant_id)" },
      { name: "a hidden column in a NATURAL join", sql: "SELECT o.status FROM public.orders o NATURAL JOIN public.customers c" },
      { name: "a hidden column in a window's PARTITION BY", sql: "SELECT id, row_number() OVER (PARTITION BY notes ORDER BY id) FROM public.orders" },
      { name: "a hidden column in an ORDER BY", sql: "SELECT id FROM public.orders ORDER BY notes, id" },
      { name: "a hidden column in a GROUP BY", sql: "SELECT notes, count(*) FROM public.orders GROUP BY notes" },
      { name: "a hidden column in a CASE", sql: "SELECT CASE WHEN notes IS NULL THEN 0 ELSE 1 END FROM public.orders" },
      { name: "a hidden column in a lateral's argument", sql: "SELECT x.n FROM public.orders o CROSS JOIN LATERAL (SELECT o.notes AS n) x" },
      { name: "a hidden column under a parameter", sql: "SELECT id FROM public.orders WHERE notes = $1", values: ["x"] },
      // a LIMIT with no ORDER BY over a join reads each table again by row number: what the role may not read is refused first
      { name: "a hidden column under a LIMIT over a join", sql: "SELECT o.notes FROM public.orders o JOIN public.customers c ON c.id = o.customer_id LIMIT 2" },
      { name: "a hidden column in a join under a LIMIT", sql: "SELECT o.id FROM public.orders o JOIN public.customers c ON c.name = o.notes LIMIT 2" },
      { name: "a * on a partly granted table under a LIMIT over a join", sql: "SELECT * FROM public.orders o JOIN public.customers c ON c.id = o.customer_id LIMIT 2" },
      { name: "SELECT * on a partly granted table", sql: "SELECT * FROM public.orders" },
      { name: "t.* on a partly granted table", sql: "SELECT o.* FROM public.orders o" },
      { name: "a whole-row reference", sql: "SELECT o FROM public.orders o" },
      { name: "a count(*) whose join reads a hidden column", sql: "SELECT count(*) FROM public.orders o JOIN public.customers c ON c.name = o.notes" },
      { name: "a table the role lacks", sql: "SELECT count(*) FROM public.products" },
      { name: "a system column", sql: "SELECT xmin::text FROM public.orders" },
      { name: "information_schema.columns for the role", sql: "SELECT table_name::text, column_name::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('orders', 'customers', 'products') ORDER BY 1, 2" },
      { name: "information_schema.tables for the role", sql: "SELECT table_name::text FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name IN ('orders', 'customers', 'products') ORDER BY 1" },
      { name: "the privilege functions for the role", sql: "SELECT has_table_privilege('public.orders', 'SELECT'), has_any_column_privilege('public.orders', 'SELECT'), has_column_privilege('public.orders', 'notes', 'SELECT'), " +
        "has_column_privilege('public.orders', 'status', 'SELECT'), has_table_privilege('public.customers', 'SELECT'), has_table_privilege('public.products', 'SELECT')" },
      // current_user is the ROLE's name under SET ROLE on both (the Postgres login here is the login role, the Mason role agent: asked of neither)
      { name: "session_user is the session's user", sql: "SELECT session_user::text, session_user::text || '!' AS t, (SELECT session_user::text) AS sub" },
      { name: "SET ROLE to another role", sql: "SET ROLE postgres" },
      { name: "SET SESSION AUTHORIZATION to another", sql: "SET SESSION AUTHORIZATION postgres" },
      { name: "SET ROLE to itself", sql: `SET ROLE ${ROLE_LOGIN}` },
      // set_config('role', 'none') is Postgres's permitted RESET ROLE to the login role; in Mason's catalog it was a way to
      // the superuser inside one statement (the review of #35). Beside another column it never reaches the catalog now:
      // refused by name (set-config-forms), a decided difference; alone it is the session's SET ROLE NONE, a no-op
      { name: "set_config of the role, decided", sql: "SELECT set_config('role', 'none', false) AS a, (SELECT count(*) FROM information_schema.tables WHERE table_name = 'products') AS b", decided: "0A000" },
      { name: "set_config of the role alone", sql: "SELECT set_config('role', 'none', false)" },
      { name: "after set_config of the role", sql: "SELECT current_setting('role'), count(*) FROM information_schema.tables WHERE table_name = 'products'" },
    ].filter((q) => ONLY === null || ONLY.test(`role case: ${q.name}`));
    if (cases.length === 0) return;
    psql(dbUrl, `CREATE ROLE ${ROLE_LOGIN} LOGIN PASSWORD 'x'; GRANT CONNECT ON DATABASE ${tag} TO ${ROLE_LOGIN}; GRANT USAGE ON SCHEMA public TO ${ROLE_LOGIN}; ` +
      `GRANT SELECT (id, customer_id, status, amount) ON public.orders TO ${ROLE_LOGIN}; GRANT SELECT ON public.customers TO ${ROLE_LOGIN};`);
    const u = new URL(dbUrl); u.username = ROLE_LOGIN; u.password = "x";
    const sourceAgent = new pg.Client({ connectionString: u.toString(), application_name: "duck-oracle-role" });
    const masonAgent = new pg.Client({ host: "127.0.0.1", port: server!.port, database: tag, user: ROLE_LOGIN, password: "x", application_name: "duck-oracle-role" });
    for (const c of [sourceAgent, masonAgent]) { await c.connect(); clients.push(c); await c.query("SET TimeZone = 'UTC'"); }
    let refusedAlike = 0;
    for (const q of cases) {
      const [want, got] = [await ask(sourceAgent, q.sql, q.values), await ask(masonAgent, q.sql, q.values)];
      if (q.decided !== undefined) {
        // Postgres answers, Mason refuses by the decided SQLSTATE: anything else is a difference
        const ok = !("code" in want) && "code" in got && got.code === q.decided;
        if (!ok) differences.push({ phase: "roles", group: "role case", kind: "code" in got ? "sqlstate" : "answered", name: `role case: ${q.name}`, detail: `decided ${q.decided}: ${JSON.stringify(got)} where Postgres ${JSON.stringify(want)}`, sql: q.sql });
        continue;
      }
      const v = verdict(want, got, ordered(q.sql));
      if (v !== null) { differences.push({ phase: "roles", group: "role case", kind: v.kind, name: `role case: ${q.name}`, detail: v.detail, sql: q.sql }); continue; }
      if ("code" in want && "code" in got) {
        refusedAlike++;
        if (want.message !== got.message) differences.push({ phase: "roles", group: "role case", kind: "text", name: `role case: ${q.name}`, detail: `${JSON.stringify(got.message)} where Postgres says ${JSON.stringify(want.message)}`, sql: q.sql });
      }
    }
    stageAsked.roles = cases.length;
    console.log(`duck oracle: ${cases.length} role case(s) asked as a role of Postgres and a user of a Mason role, ${refusedAlike} refused alike by SQLSTATE and message`);
    await allRoleCases();
    await noRoleCases();
  }

  /**
   * A USER THE FILE HOLDS TO NOTHING (no role, `default:` not written — this run's file names none), HELD TO A POSTGRES
   * LOGIN WITH NO GRANT (CONNECT and USAGE only): a table read refused alike by SQLSTATE and message, and the catalog
   * answering alike — information_schema lists nothing, the privilege functions are false, the user names itself.
   */
  async function noRoleCases(): Promise<void> {
    const cases: Array<{ name: string; sql: string; decided?: string }> = [
      { name: "no role, a table read", sql: "SELECT count(*) FROM public.orders" },
      { name: "no role, a column read", sql: "SELECT id FROM public.customers ORDER BY id" },
      { name: "no role, no table read", sql: "SELECT 1 + 1 AS two" },
      { name: "no role, information_schema.tables", sql: "SELECT table_name::text FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1" },
      { name: "no role, information_schema.columns", sql: "SELECT column_name::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' ORDER BY 1" },
      { name: "no role, the privilege functions", sql: "SELECT has_table_privilege('public.orders', 'SELECT'), has_any_column_privilege('public.orders', 'SELECT'), has_column_privilege('public.orders', 'status', 'SELECT')" },
      { name: "no role, the user's names", sql: "SELECT current_user::text, current_role::text, user::text, session_user::text" },
      // Postgres lets a login set_config: alone it is the session's SET, never the catalog's (where it is revoked)
      { name: "no role, set_config", sql: "SELECT set_config('application_name', 'x', false)" },
    ].filter((q) => ONLY === null || ONLY.test(`role case: ${q.name}`));
    if (cases.length === 0) return;
    psql(dbUrl, `CREATE ROLE ${ROLE_NONE} LOGIN PASSWORD 'x'; GRANT CONNECT ON DATABASE ${tag} TO ${ROLE_NONE}; GRANT USAGE ON SCHEMA public TO ${ROLE_NONE};`);
    const u = new URL(dbUrl); u.username = ROLE_NONE; u.password = "x";
    const sourceNone = new pg.Client({ connectionString: u.toString(), application_name: "duck-oracle-role-none" });
    const masonNone = new pg.Client({ host: "127.0.0.1", port: server!.port, database: tag, user: ROLE_NONE, password: "x", application_name: "duck-oracle-role-none" });
    for (const c of [sourceNone, masonNone]) { await c.connect(); clients.push(c); await c.query("SET TimeZone = 'UTC'"); }
    let refusedAlike = 0;
    for (const q of cases) {
      const [want, got] = [await ask(sourceNone, q.sql), await ask(masonNone, q.sql)];
      if (q.decided !== undefined) {
        const ok = !("code" in want) && "code" in got && got.code === q.decided;
        if (!ok) differences.push({ phase: "roles", group: "role case", kind: "code" in got ? "sqlstate" : "answered", name: `role case: ${q.name}`, detail: `decided ${q.decided}: ${JSON.stringify(got)} where Postgres ${JSON.stringify(want)}`, sql: q.sql });
        continue;
      }
      const v = verdict(want, got, ordered(q.sql));
      if (v !== null) { differences.push({ phase: "roles", group: "role case", kind: v.kind, name: `role case: ${q.name}`, detail: v.detail, sql: q.sql }); continue; }
      if ("code" in want && "code" in got) {
        refusedAlike++;
        if (want.message !== got.message) differences.push({ phase: "roles", group: "role case", kind: "text", name: `role case: ${q.name}`, detail: `${JSON.stringify(got.message)} where Postgres says ${JSON.stringify(want.message)}`, sql: q.sql });
      }
    }
    console.log(`duck oracle: ${cases.length} role case(s) asked as a Postgres login with no grant and a Mason user the roles file holds to nothing, ${refusedAlike} refused alike by SQLSTATE and message`);
  }

  /**
   * `tables: all` (stage 1b), HELD TO POSTGRES'S `GRANT SELECT ON ALL TABLES IN SCHEMA public`: the Mason role resolved
   * from the roles file's own words against the copied tables (src/cli/roles.ts), a Postgres role granted every table
   * of the schema, and the same statements asked of both — every column of every table read, the catalog's answer.
   */
  async function allRoleCases(): Promise<void> {
    const cases = [
      { name: "tables: all, every column", sql: "SELECT * FROM public.orders ORDER BY id" },
      { name: "tables: all, a column another role may not read", sql: "SELECT id, notes FROM public.orders ORDER BY id" },
      { name: "tables: all, every table", sql: "SELECT count(*) FROM public.products" },
      { name: "tables: all, information_schema.columns", sql: "SELECT table_name::text, column_name::text FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('orders', 'customers', 'products') ORDER BY 1, 2" },
      { name: "tables: all, the privilege functions", sql: "SELECT has_table_privilege('public.orders', 'SELECT'), has_column_privilege('public.orders', 'notes', 'SELECT'), has_table_privilege('public.products', 'SELECT')" },
    ].filter((q) => ONLY === null || ONLY.test(`role case: ${q.name}`));
    if (cases.length === 0) return;
    const r = await import("../../src/cli/roles.ts");
    const file = r.parseRolesText("roles:\n  everything:\n    tables: all\n", ROLE_FILE);
    assert.ok(!("problems" in file), JSON.stringify(file));
    const copiedNow = theSync.schema().tables.map((t) => ({ source: `${t.schema ?? "public"}.${t.name}`, columns: t.columns.map((c) => ({ name: c.name })) }));
    const resolved = r.resolveRoles(file, copiedNow, dir);
    assert.ok(!("message" in resolved), JSON.stringify(resolved));
    // the catalog is rebuilt with the new role at the next statement (a new RolesLive object)
    roles = { ...roles, grants: new Map([...roles.grants, ...resolved]) };
    psql(dbUrl, `CREATE ROLE ${ROLE_ALL} LOGIN PASSWORD 'x'; GRANT CONNECT ON DATABASE ${tag} TO ${ROLE_ALL}; GRANT USAGE ON SCHEMA public TO ${ROLE_ALL}; ` +
      `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE_ALL};`);
    const u = new URL(dbUrl); u.username = ROLE_ALL; u.password = "x";
    const sourceAll = new pg.Client({ connectionString: u.toString(), application_name: "duck-oracle-role-all" });
    const masonAll = new pg.Client({ host: "127.0.0.1", port: server!.port, database: tag, user: ROLE_ALL, password: "x", application_name: "duck-oracle-role-all" });
    for (const c of [sourceAll, masonAll]) { await c.connect(); clients.push(c); await c.query("SET TimeZone = 'UTC'"); }
    for (const q of cases) {
      const v = verdict(await ask(sourceAll, q.sql), await ask(masonAll, q.sql), ordered(q.sql));
      if (v !== null) differences.push({ phase: "roles", group: "role case", kind: v.kind, name: `role case: ${q.name}`, detail: v.detail, sql: q.sql });
    }
    console.log(`duck oracle: ${cases.length} role case(s) asked as a role granted ALL TABLES IN SCHEMA public and a user of a Mason role of tables: all`);
  }

  /**
   * ROWS PER USER, HELD TO POSTGRES ROW SECURITY (oracle/row-filters.ts): the roles file's `where:` and `through:`
   * resolved from its own words against the copied shop (its foreign keys as the source's catalog reports them), each
   * Mason user beside a Postgres login of the same `mason.attr.*` settings under the same policies, every shape asked of
   * both — as each filtered user, and as `open`, a user of the same tables with no filter — and held equal by the
   * oracle's verdict (a refusal by SQLSTATE and message). A one-value list answers as the scalar; EXPLAIN says each
   * table's filter where the user has one, and none for `open`.
   */
  async function rowFilterCases(): Promise<void> {
    const name = (user: string, shape: string): string => `row filter: ${user}: ${shape}`;
    const shapesOfUser = (key: string): ReadonlyArray<{ name: string; sql: string; values?: string[]; prepared?: string[] }> =>
      key === "hidden" ? HIDDEN_SHAPES : key === "tiers" ? TIER_SHAPES : key === "open" ? [...ROW_SHAPES, ...BARRIER_SHAPES, ...TIER_SHAPES] : [...ROW_SHAPES, ...BARRIER_SHAPES];
    const users = ROWS_USERS.filter((u) => ONLY === null || [...shapesOfUser(u.key), ...UNORDERED_ROW_SHAPES.map((x) => ({ name: `unordered limit: ${x.name}` })), { name: "EXPLAIN" }, { name: "SHOW ALL" }].some((q) => ONLY.test(name(u.key, q.name))));
    if (users.length === 0) return;
    const r = await import("../../src/cli/roles.ts");
    const file = r.parseRolesText(ROWS_ROLES, ROLE_FILE);
    assert.ok(!("problems" in file), JSON.stringify(file));
    const resolved = r.resolveRoles(file, shop.map((t) => ({ source: t.source, columns: t.columns.map((c) => ({ name: c.name })), foreignKeys: t.foreignKeys, key: t.key })), dir);
    assert.ok(!("message" in resolved), JSON.stringify(resolved));
    roles = { ...roles, grants: new Map([...roles.grants, ...resolved]) };
    psql(dbUrl, referenceSql(tag, rowLogin));
    const pair = new Map<string, { source: pg.Client; mason: pg.Client }>();
    for (const u of users) {
      const url = new URL(dbUrl); url.username = rowLogin(u.key); url.password = "x";
      const source = new pg.Client({ connectionString: url.toString(), application_name: "duck-oracle-rows" });
      const mason = new pg.Client({ host: "127.0.0.1", port: server!.port, database: tag, user: rowLogin(u.key), password: "x", application_name: "duck-oracle-rows" });
      for (const c of [source, mason]) { await c.connect(); clients.push(c); await c.query("SET TimeZone = 'UTC'"); }
      pair.set(u.key, { source, mason });
    }
    let asked = 0, refusedAlike = 0, preparedNames = 0;
    const answers = new Map<string, Answer>();
    const hold = (n: string, sql: string, want: Answer, got: Answer): void => {
      asked++;
      const v = verdict(want, got, ordered(sql));
      if (v !== null) { differences.push({ phase: "row filters", group: "row filter", kind: v.kind, name: n, detail: v.detail, sql }); return; }
      if ("code" in want && "code" in got) {
        refusedAlike++;
        if (want.message !== got.message) differences.push({ phase: "row filters", group: "row filter", kind: "text", name: n, detail: `${JSON.stringify(got.message)} where Postgres says ${JSON.stringify(want.message)}`, sql });
      }
    };
    for (const u of users) {
      const { source, mason } = pair.get(u.key)!;
      for (const q of shapesOfUser(u.key)) {
        const n = name(u.key, q.name);
        if (ONLY !== null && !ONLY.test(n)) continue;
        const prepared = q.prepared;
        if (prepared !== undefined) {
          // Parsed once under the statement's name, Bound and Executed with each value in turn. The name is the
          // statement's own: node-pg ties a name to one SQL text per client, and refuses a second text under it
          const statement = `rows_prepared_${preparedNames++}`;
          for (const [i, value] of prepared.entries()) {
            const [want, got] = [await ask(source, q.sql, [value], statement), await ask(mason, q.sql, [value], statement)];
            hold(`${n} (execution ${i + 1})`, q.sql, want, got);
          }
          continue;
        }
        const [want, got] = [await ask(source, q.sql, q.values), await ask(mason, q.sql, q.values)];
        hold(n, q.sql, want, got);
        answers.set(n, got);
      }
      // a LIMIT with no ORDER BY: the filter's rows alone, whichever are chosen (oracle/unordered-limit.ts)
      if (u.key !== "hidden" && u.key !== "tiers") for (const q of UNORDERED_ROW_SHAPES) {
        const n = name(u.key, `unordered limit: ${q.name}`);
        if (ONLY !== null && !ONLY.test(n)) continue;
        asked++;
        const wrong = await unorderedLimit(q, source, mason);
        if (wrong !== null) differences.push({ phase: "row filters", group: "row filter", kind: "rows", name: n, detail: wrong, sql: unorderedSql(q) });
      }
      // SHOW ALL: an attribute is a placeholder, listed by neither
      if (ONLY === null || ONLY.test(name(u.key, "SHOW ALL"))) {
        const [want, got] = [await ask(source, "SHOW ALL"), await ask(mason, "SHOW ALL")];
        asked++;
        const broken = "code" in want || "code" in got ? `${JSON.stringify(got).slice(0, 300)} where Postgres ${JSON.stringify(want).slice(0, 300)}` : showAllOwn(want, got);
        if (broken !== null) differences.push({ phase: "row filters", group: "row filter", kind: "value", name: name(u.key, "SHOW ALL"), detail: broken, sql: "SHOW ALL" });
      }
      // EXPLAIN: Postgres's shape (one QUERY PLAN column of text), the filter said on each table read where there is one
      const n = name(u.key, "EXPLAIN");
      if (ONLY !== null && !ONLY.test(n)) continue;
      const sql = u.key === "hidden" ? "EXPLAIN SELECT count(*) FROM shop.customers" : u.key === "tiers" ? "EXPLAIN SELECT count(*) FROM shop.accounts" : "EXPLAIN SELECT count(*) FROM shop.order_items i JOIN shop.orders o ON o.id = i.order_id";
      const [want, got] = [await ask(source, sql), await ask(mason, sql)];
      asked++;
      if ("code" in want || "code" in got || JSON.stringify([want.names, want.oids]) !== JSON.stringify([got.names, got.oids])) {
        differences.push({ phase: "row filters", group: "row filter", kind: "type", name: n, detail: `${JSON.stringify(got).slice(0, 300)} where Postgres ${JSON.stringify(want).slice(0, 300)}`, sql });
        continue;
      }
      const plan = got.rows.map((row) => row[0]).join("\n");
      const said = (plan.match(new RegExp(`filtered by the role ${u.role}: `, "g")) ?? []).length;
      const expected = u.role === "open" ? 0 : u.role === "hidden" || u.role === "tiers" ? 1 : u.role === "regions" ? 3 : 2;
      if (said !== expected || /filtered by the role/.test(plan) !== (expected > 0)) {
        differences.push({ phase: "row filters", group: "row filter", kind: "value", name: n, detail: `${said} table(s) said filtered where ${expected} are: ${plan}`, sql });
      }
    }
    // A ONE-VALUE LIST ANSWERS AS THE SCALAR: list1 (tenants: [3]) and tenant (tenant: 3), shape by shape
    let alike = 0;
    for (const q of [...ROW_SHAPES, ...BARRIER_SHAPES]) {
      const a = answers.get(name("list1", q.name)), b = answers.get(name("tenant", q.name));
      if (a === undefined || b === undefined || q.name.startsWith("information_schema")) continue;
      const v = verdict(b, a, ordered(q.sql));
      if (v === null) alike++;
      else differences.push({ phase: "row filters", group: "row filter", kind: v.kind, name: name("list1 as tenant", q.name), detail: v.detail, sql: q.sql });
    }
    // and a filter that filters: open reads more customers than tenant, which reads more than nobody
    const count = (k: string): number | null => { const x = answers.get(name(k, "SELECT * of a filtered table")); return x === undefined || "code" in x ? null : x.rows.length; };
    const [open, one] = [count("open"), count("tenant")];
    if (open !== null && one !== null) assert.ok(open > one && one > 0, `open reads ${open} customers, tenant ${one}: the filter must leave some rows and drop some`);
    stageAsked["row filters"] = asked;
    console.log(`duck oracle: ${asked} row-filter statement(s) asked as ${users.length} user(s) of Mason roles with where: and through: and Postgres logins under the same row security, ` +
      `${refusedAlike} refused alike; a one-value list answered as the scalar in ${alike}`);
  }

  /**
   * THE SESSION'S SETTINGS (GitHub issues 40, 41): one session of each, asked the same statements IN ORDER — a SET
   * moves what every later one reads — each held equal, a refusal by SQLSTATE and message. `current_setting` answers the
   * session's value in the catalog and beside a copied table (a WHERE, a CTE, a parameter), and RESET, RESET ALL and
   * DISCARD ALL restore the startup's values (its application_name and `options`; TimeZone is the startup's UTC on both,
   * so a RESET never meets the server's own zone; work_mem and search_path are other than Postgres's defaults, so a
   * restore of them is told from a reset to the default). A `named` case is a prepared statement of that name, Parsed
   * at its first case and Bound and Executed again at each later one: read after later SETs. `set_config` alone is the
   * session's SET; a view reads the settings of the session reading it.
   */
  async function settingCases(): Promise<void> {
    const read = "SELECT current_setting('TimeZone') AS tz, current_setting('search_path') AS path, current_setting('work_mem') AS mem, current_setting('application_name') AS app";
    const besideNamed = "SELECT current_setting('TimeZone') AS tz, current_setting($1) AS v FROM public.one";
    const catalogNamed = "SELECT current_setting('TimeZone') AS tz, current_setting($1, true) AS v";
    const cases: Array<{ name: string; sql: string; values?: string[]; named?: string }> = [
      { name: "before any SET", sql: read },
      { name: "a named statement beside a table, before any SET", sql: besideNamed, values: ["work_mem"], named: "settings_beside" },
      { name: "a named statement of the catalog, before any SET", sql: catalogNamed, values: ["search_path"], named: "settings_catalog" },
      { name: "strict on NULL, in the catalog", sql: "SELECT current_setting(NULL), current_setting(NULL, true), current_setting('TimeZone', NULL)" },
      { name: "strict on NULL, beside a table", sql: "SELECT current_setting(NULL), current_setting(NULL, true), current_setting('TimeZone', NULL) FROM public.one" },
      { name: "SET TimeZone", sql: "SET TimeZone = 'Europe/Berlin'" },
      { name: "SET search_path", sql: "SET search_path = sales, public" },
      { name: "SET work_mem", sql: "SET work_mem = '64MB'" },
      { name: "after the SETs, in the catalog", sql: read },
      { name: "the named statement beside a table, after the SETs", sql: besideNamed, values: ["work_mem"], named: "settings_beside" },
      { name: "the named statement of the catalog, after the SETs", sql: catalogNamed, values: ["search_path"], named: "settings_catalog" },
      { name: "a view of the settings, after the SETs", sql: "SELECT id, tz, app FROM public.settings_seen ORDER BY id" },
      { name: "after the SETs, beside a table", sql: `${read}, count(*) AS n FROM public.orders` },
      { name: "after the SETs, any case and missing_ok", sql: "SELECT current_setting('TIMEZONE'), current_setting('Search_Path', true), current_setting('work_mem', false), current_setting('DateStyle'), current_setting('IntervalStyle') FROM public.one" },
      { name: "qualified, in the catalog", sql: "SELECT pg_catalog.current_setting('TimeZone'), pg_catalog.current_setting('work_mem', true)" },
      { name: "qualified, beside a table", sql: "SELECT pg_catalog.current_setting('search_path'), pg_catalog.current_setting('work_mem', true) FROM public.one" },
      { name: "SET search_path without public", sql: "SET search_path = sales" },
      { name: "a search_path without public, beside a table", sql: "SELECT current_setting('search_path'), current_setting('TimeZone', true) FROM public.one" },
      { name: "a search_path without public, in the catalog", sql: "SELECT current_setting('search_path'), current_setting('work_mem', false)" },
      { name: "SET search_path back", sql: "SET search_path = sales, public" },
      { name: "in a WHERE over a table", sql: "SELECT count(*) FROM public.orders WHERE current_setting('search_path') = 'sales, public' AND current_setting('TimeZone') = 'Europe/Berlin'" },
      { name: "in a WHERE of the catalog", sql: "SELECT relname::text FROM pg_catalog.pg_class WHERE relname = 'pg_class' AND current_setting('work_mem') = '64MB'" },
      { name: "in a CTE over a table", sql: "WITH s AS (SELECT id, current_setting('work_mem') AS mem FROM public.orders) SELECT mem, count(*) FROM s GROUP BY mem" },
      { name: "in a CTE of no table", sql: "WITH s AS (SELECT current_setting('search_path') AS p) SELECT p FROM s" },
      { name: "a parameter, beside a table", sql: "SELECT current_setting($1) FROM public.one", values: ["TimeZone"] },
      { name: "a parameter, in the catalog", sql: "SELECT current_setting($1), current_setting($2, true)", values: ["search_path", "work_mem"] },
      { name: "a placeholder not set, missing_ok", sql: "SELECT current_setting('myapp.flag', true) IS NULL AS unset, current_setting('no_such_setting', true) IS NULL AS unknown FROM public.one" },
      { name: "a placeholder not set", sql: "SELECT current_setting('myapp.flag')" },
      { name: "SET a placeholder", sql: "SET myapp.flag = 'on'" },
      { name: "a placeholder set", sql: "SELECT current_setting('myapp.flag'), current_setting('myapp.flag', true) FROM public.one" },
      { name: "SHOW ALL with a placeholder set", sql: "SHOW ALL" },
      { name: "a name nobody knows, beside a table", sql: "SELECT current_setting('no_such_setting') FROM public.one" },
      { name: "a name nobody knows, in the catalog", sql: "SELECT current_setting('no_such_setting')" },
      { name: "RESET TimeZone", sql: "RESET TimeZone" },
      { name: "after RESET TimeZone", sql: read },
      { name: "SET work_mem TO DEFAULT", sql: "SET work_mem TO DEFAULT" },
      { name: "after SET work_mem TO DEFAULT", sql: read },
      { name: "SET search_path TO DEFAULT", sql: "SET search_path TO DEFAULT" },
      { name: "after SET search_path TO DEFAULT", sql: `${read} FROM public.one` },
      { name: "SET search_path again", sql: "SET search_path = sales, public" },
      { name: "SET application_name", sql: "SET application_name = 'after-set'" },
      { name: "SHOW application_name, set", sql: "SHOW application_name" },
      { name: "RESET ALL", sql: "RESET ALL" },
      { name: "SHOW application_name after RESET ALL", sql: "SHOW application_name" },
      { name: "SHOW a placeholder after RESET ALL", sql: "SHOW myapp.flag" },
      { name: "SET a placeholder again", sql: "SET myapp.flag = 'again'" },
      { name: "RESET a placeholder", sql: "RESET myapp.flag" },
      { name: "a placeholder after its RESET", sql: "SELECT current_setting('myapp.flag'), current_setting('myapp.flag', true)" },
      { name: "RESET a placeholder never set", sql: "RESET myapp.never" },
      { name: "a placeholder RESET but never set", sql: "SELECT current_setting('myapp.never', true) FROM public.one" },
      { name: "after RESET ALL, in the catalog", sql: read },
      { name: "after RESET ALL, beside a table", sql: `${read}, current_setting('myapp.flag', true) AS flag FROM public.one` },
      { name: "SET application_name again", sql: "SET application_name = 'pooled'" },
      { name: "DISCARD ALL", sql: "DISCARD ALL" },
      { name: "after DISCARD ALL", sql: "SELECT current_setting('application_name'), current_setting('TimeZone') FROM public.one" },
      { name: "set_config alone", sql: "SELECT set_config('work_mem', '128MB', false)" },
      { name: "after set_config", sql: `${read}, current_setting('work_mem') AS beside FROM public.one` },
      { name: "set_config of TimeZone, in its own spelling", sql: "SELECT set_config('TimeZone', 'europe/berlin', false) AS tz" },
      { name: "set_config of application_name", sql: "SELECT pg_catalog.set_config('application_name', 'by-set-config', false)" },
      { name: "set_config of a placeholder", sql: "SELECT set_config('myapp.cfg', 'v', false)" },
      { name: "after the set_configs", sql: `${read}, current_setting('myapp.cfg') AS cfg FROM public.one` },
      { name: "a view of the settings, after the set_configs", sql: "SELECT id, tz, app FROM public.settings_seen ORDER BY id" },
      { name: "set_config of a name nobody knows", sql: "SELECT set_config('no_such_setting', 'x', false)" },
      { name: "the named statements, after set_config", sql: besideNamed, values: ["application_name"], named: "settings_beside" },
      { name: "RESET ALL after set_config", sql: "RESET ALL" },
      { name: "after RESET ALL, the startup's options", sql: `${read}, current_setting('myapp.cfg') AS cfg FROM public.one` },
      { name: "the named statement of the catalog, after RESET ALL", sql: catalogNamed, values: ["work_mem"], named: "settings_catalog" },
    ].filter((q) => ONLY === null || ONLY.test(`setting case: ${q.name}`));
    if (cases.length === 0) return;
    const startup = { application_name: "duck-oracle-settings", options: "-c TimeZone=UTC -c work_mem=32MB -c search_path=startup_path,public" };
    const sourceS = new pg.Client({ connectionString: dbUrl, ...startup });
    const masonS = new pg.Client({ host: "127.0.0.1", port: server!.port, database: tag, user: "oracle", password: "x", ...startup });
    for (const c of [sourceS, masonS]) { await c.connect(); clients.push(c); }
    let refusedAlike = 0;
    for (const q of cases) {
      const [want, got] = [await ask(sourceS, q.sql, q.values, q.named), await ask(masonS, q.sql, q.values, q.named)];
      // SHOW ALL lists the two servers' own settings: held on the session's part, as `showAllHolds` holds it
      if (q.sql === "SHOW ALL") {
        const broken = "code" in want || "code" in got ? `${JSON.stringify(got).slice(0, 300)} where Postgres ${JSON.stringify(want).slice(0, 300)}` : showAllHolds(want, got);
        if (broken !== null) differences.push({ phase: "settings", group: "setting case", kind: "value", name: `setting case: ${q.name}`, detail: broken, sql: q.sql });
        continue;
      }
      const v = verdict(want, got, ordered(q.sql));
      if (v !== null) { differences.push({ phase: "settings", group: "setting case", kind: v.kind, name: `setting case: ${q.name}`, detail: v.detail, sql: q.sql }); continue; }
      if ("code" in want && "code" in got) {
        refusedAlike++;
        if (want.message !== got.message) differences.push({ phase: "settings", group: "setting case", kind: "text", name: `setting case: ${q.name}`, detail: `${JSON.stringify(got.message)} where Postgres says ${JSON.stringify(want.message)}`, sql: q.sql });
      }
    }
    stageAsked.settings = cases.length;
    console.log(`duck oracle: ${cases.length} setting case(s) asked in order of one session each, ${refusedAlike} refused alike by SQLSTATE and message`);
  }

  /** THE SETTINGS ACROSS TRANSACTIONS (GitHub issue 47; oracle/setting-scripts.ts): a session of each per script, under
   *  the settings cases' startup, every step's whole reply held equal, its warnings and ParameterStatus among it. */
  async function settingScripts(): Promise<void> {
    const startup = { application_name: "duck-oracle-settings", options: "-c TimeZone=UTC -c work_mem=32MB -c search_path=startup_path,public" };
    const scripts = SETTING_SCRIPTS.filter((q) => ONLY === null || ONLY.test(`setting case: ${q.name}`));
    let steps = 0;
    for (const script of scripts) {
      const sourceT = new pg.Client({ connectionString: dbUrl, ...startup });
      const masonT = new pg.Client({ host: "127.0.0.1", port: server!.port, database: tag, user: "oracle", password: "x", ...startup });
      await sourceT.connect();
      await masonT.connect();
      try {
        for (const step of script.steps) {
          steps++;
          const [want, got] = [await traceStep(sourceT, step), await traceStep(masonT, step)];
          // a value Mason refuses by name where Postgres answers: met as its gap, the session going on alike after
          const named = refusedAsNamed(step, got);
          if (named !== null && named.differs === null) { meet("refused", named.gap, "setting case", false); continue; }
          if (named === null && JSON.stringify(want) === JSON.stringify(got)) continue;
          differences.push({ phase: "settings", group: "setting case", kind: "text", name: `setting case: ${script.name}`, detail: named?.differs ?? `${JSON.stringify(got)} where Postgres answers ${JSON.stringify(want)}`, sql: stepText(step) });
          break;   // what follows in a session parted from Postgres's says nothing more
        }
      } finally { await sourceT.end(); await masonT.end(); }
    }
    stageAsked["setting scripts"] = steps;
    if (scripts.length > 0) console.log(`duck oracle: ${scripts.length} setting script(s), ${steps} steps, each reply held whole`);
  }

  // ---- the verdict ----------------------------------------------------------------------------------------------
  const counted = new Map<string, number>();
  for (const d of differences) counted.set(`${d.group} / ${d.kind}`, (counted.get(`${d.group} / ${d.kind}`) ?? 0) + 1);
  fs.writeFileSync(report, `${asked} statements asked (${all().length} × 3 phases, and ${shaped} in other shapes); ${differences.length} differ\n` +
    [...counted].sort((a, b) => b[1] - a[1]).map(([k, n]) => `  ${n} × ${k}`).join("\n") + "\n\n" +
    differences.map((d) => `[${d.phase}] ${d.group} / ${d.kind}: ${d.name}\n  ${d.detail}\n  ${d.sql.replace(/\s+/g, " ")}`).join("\n\n") + "\n");
  console.log(`duck oracle: ${asked} statements asked, ${differences.length} differ (${report}): ${[...counted].map(([k, n]) => `${n} ${k}`).join(", ")}`);
  // the first differences in the log too, whichever assertion below fails first (a difference can be why a decision
  // is stale or a verified entry dropped, and CI keeps only the log)
  for (const d of differences.slice(0, 5)) console.log(`duck oracle: differs: [${d.phase}] ${d.group} / ${d.kind}: ${d.name}\n  ${d.detail}\n  ${d.sql.replace(/\s+/g, " ")}`);
  console.log(`duck oracle: ${nodesPlacedTwice().length} node(s) a rewrite placed twice${nodesPlacedTwice().length > 0 ? `: ${nodesPlacedTwice().slice(0, 10).join(" | ")}` : ""}`);
  if (EAGER_JSON) {
    // the run read JSON from stored columns: how many paths, and none left unfilled
    const paths = theSync.kept.status();
    const orders = paths.filter((p) => p.state === "ready" && p.steps.startsWith("order:"));
    console.log(`duck oracle: ${paths.filter((p) => p.state === "ready").length} JSON path(s) stored and read from their columns, over ${new Set(paths.map((p) => p.table)).size} table(s); ` +
      `${orders.length} of them a jsonb's order (${orders.map((p) => `${p.table}.${p.column}`).join(", ")})`);
    assert.ok(paths.some((p) => p.state === "ready"), "IT_ORACLE_JSON_PATHS=eager stored no JSON path: the run did not exercise them");
    // a jsonb sorted, grouped or compared is read from its stored key (src/duck/kept-route.ts ORDER_STEPS)
    assert.ok(orders.some((p) => p.table === "public.jorder"), "IT_ORACLE_JSON_PATHS=eager stored no jsonb's order: the run did not exercise it");
    // under a libc collation a jsonb's equality is read from its stored C key, a second column (EQUAL_STEPS); under C
    // and ICU the order's key serves it, and no second column is ever made
    const equals = paths.filter((p) => p.steps.startsWith("equal:"));
    console.log(`duck oracle: ${equals.filter((p) => p.state === "ready").length} jsonb equality key(s) stored (${equals.map((p) => `${p.table}.${p.column} ${p.state}`).join(", ")})`);
    if (libc !== undefined) assert.ok(equals.some((p) => p.table === "public.jorder" && p.state === "ready"), "IT_ORACLE_JSON_PATHS=eager under libc stored no jsonb's C key: the run did not exercise it");
    else assert.deepEqual(equals.map((p) => `${p.table}.${p.column} ${p.steps} ${p.state}`), [], "under C or ICU no jsonb's C key is stored: the order's key equates");
    assert.deepEqual(paths.filter((p) => p.state !== "ready").map((p) => `${p.table} ${p.column} ${p.steps}: ${p.state} ${p.why}`), [], "every path stored is ready");
  }
  for (const line of gapSummary(copyPhaseGaps, tallies.statements, everyAskGaps, asked)) console.log(line);
  // a filtered run or a leg asks only some statements: a decision it did not meet is not stale
  const [, runCollate = "", runProvider = ""] = /^(.*) \((.)\)$/.exec(collation) ?? [];
  const unmet = (k: Decided): boolean => !collationMet(k, runProvider, runCollate);
  const stale = WHOLE ? staleDecisions(KNOWN, known, decided, unmet) : [];
  assert.deepEqual(stale, [], "a decided difference that no longer differs");
  // A DEAD GAP: a refused or decided entry no statement meets (removed, or held by a test it names)
  const dead = WHOLE ? deadGaps(everyAskGaps) : [];
  assert.deepEqual(dead, [], "src/duck/gaps.ts entries no oracle statement meets: add a statement that does (oracle/gap-cases.ts), or remove the entry");

  // ---- what is verified (src/duck/verified.ts): exactly what the statements answered alike were made of ----------
  const verified = new Set<string>();
  for (const q of all()) if (!unproven.has(q.sql)) for (const k of resolvedOf.get(q.sql) ?? []) verified.add(k);
  const { added: newly, dropped } = verifiedDiff(verified, VERIFIED);
  // A LEG'S REPORT, before the assertion below, so that a leg that differs still lets the check say what else is wrong
  if (LEG !== null) {
    const legReport: LegReport = { ...LEG, whole: [...every().map((q) => ({ id: statementId(q), name: q.name })), ...UNORDERED_LIMITS.map(unorderedStatement).map((q) => ({ id: statementId(q), name: q.name, apart: true as const }))], asked: askedIn, stages: stageAsked, shaped, tallies, copyPhase: copyPhaseGaps, everyAsk: everyAskGaps,
      decisions: KNOWN.map((k) => ({ sql: String(k.sql), why: k.why, ...(k.machineFloat === true || unmet(k) ? { machineFloat: true as const } : {}), differed: known.has(k), decided: decided.has(k) })),
      verified: [...verified], names: Object.fromEntries(await describeKeys(async (sql) => (await source.query({ text: sql, rowMode: "array" })).rows as (string | null)[][], verified)),
      asks: asked, measured, differences: differences.length };
    const out = process.env.IT_ORACLE_LEG_REPORT!;   // legRefused: a leg without it does not start
    fs.writeFileSync(out, JSON.stringify(legReport));
    console.log(`duck oracle: leg ${LEG.leg} of ${LEG.of}: ${tallies.statements} statements of ${legReport.whole.filter((w) => w.apart !== true).length}, and those of ${UNORDERED_LIMITS.length} apart that are its own; report in ${out}`);
  }
  if (process.env.UPDATE_VERIFIED === "1" && WHOLE) {
    const names = await describeKeys(async (sql) => (await source.query({ text: sql, rowMode: "array" })).rows as (string | null)[][], verified);
    const file = path.join(REPO, "src", "duck", "verified.ts");
    fs.writeFileSync(file, verifiedText(fs.readFileSync(file, "utf8"), verified, names));
    console.log(`duck oracle: src/duck/verified.ts rewritten: ${verified.size} verified (${newly.length} added, ${dropped.length} dropped)`);
  } else if (WHOLE) {
    assert.deepEqual({ added: newly, dropped }, { added: [], dropped: [] }, "src/duck/verified.ts is not what the oracle verifies: `added` were answered " +
      `exactly and are refused until listed, \`dropped\` are listed and no statement answered alike uses them. Regenerate with ${WRITE_COMMAND} and read the diff`);
  }
  assert.equal(differences.length, 0, `the endpoint answered ${differences.length} statement(s) differently from Postgres; ${report} lists them. The first:\n` +
    differences.slice(0, 5).map((d) => `[${d.phase}] ${d.group} / ${d.kind}: ${d.name}\n  ${d.detail}`).join("\n"));
  // ONE PLACE PER NODE (src/duck/rewrite.ts nodesPlacedTwice): a rule that put a node in two places rewrote it in one
  assert.deepEqual(nodesPlacedTwice(), [], "a rule placed a node in two places: clone it per use (Rewriter.cp)");
});
