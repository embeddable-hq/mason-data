/**
 * STORED JSON PATHS: THE JSON VALUES STATEMENTS KEEP READING, KEPT AS COLUMNS (docs/DESIGN.md "Stored JSON paths";
 * what a plan needs of them is src/duck/kept-route.ts). On the test server a read of one JSON path
 * over 22 M rows took 98 s and starved the process: every row's read is a call of a JavaScript function from DuckDB's
 * thread (`__mason_json_get`). A BI tool asks the same paths again and again, so a path statements read often, or one a
 * slow statement read, is STORED: a hidden column of the copied table holding exactly what that function answers for
 * the row (`__mason_json_kept`, src/duck/functions.ts `keptJsonValue`), computed once per row WRITTEN — by the copy, the
 * stream and the poll, in the write itself — instead of once per row per statement.
 *
 * - ONE COLUMN PER PATH (src/duck/kept-route.ts `pathKey`): a path's `->` and `->>` reads, and its `#>` spelling where
 *   no element reads as an index, are one stored path; the column holds the `->` answer and `->>` is derived from it.
 * - WHICH PATHS (`review`, every `REVIEW_MS`): the request log (`_mason.requests.json_reads`, each answered or failed
 *   statement's reads, src/duck/requests.ts) weighed against what the fill would cost (`decide`): a table whose fill is
 *   estimated under `SMALL_FILL_SECONDS` stores a path `KEEP_AFTER_STATEMENTS` statements read, or one that took
 *   `KEEP_AFTER_MS`; a larger one only a path `KEEP_AFTER_STATEMENTS` statements read for at least `KEEP_FILL_SHARE` of
 *   its fill's estimate in all (`estimate`: the rate the last fill of that JSON column measured, else `fillEstimate`,
 *   the table's rows and its JSON column's bytes ON DISK a row). A path the cost holds back has a `waiting` row saying
 *   so. Never more than one path is added per review, and a review never waits for a fill (`fills`): it runs on its
 *   cadence whatever a fill is doing, so the waiting rows' evidence stays current and a path decided meanwhile is
 *   queued behind the fill under way.
 * - ITS LIFE (`_mason.json_paths`, a row per path): `backfilling` — the column added (`ALTER TABLE … ADD COLUMN …
 *   VARCHAR`, no default: DuckDB writes a non-NULL default into every row on the writer's turn, 28 s on the test
 *   server's 196 M-row table; its NULL is the mark of a value not stored yet) and its existing rows filled
 *   `backfillRows` at a time, each chunk a transaction on the writer's turn, so the stream and the polls go on between
 *   them and the event loop gets a turn — one path's fill at a time, the others queued in the order they were added
 *   (`fills`), each measured (`filled`: its rows and the seconds its chunks took); then `ready` — every row stored, and the rewrite reads the column
 *   (`KeptRoutes.ready`); `dropped` — its column went (the source column left the copy, or the feature was turned
 *   off): the row says why.
 * - EQUAL TO THE FUNCTION BY CONSTRUCTION: the column holds `keptJsonValue`'s answer — the `->` answer, `KEPT_NULL` for
 *   a NULL one, or `KEPT_RECOMPUTE` where it must be computed at read time (the function raised) — and a READY read is
 *   the column ALONE while it is EXACT (no row unset or `KEPT_RECOMPUTE`: `marked` 0), so DuckDB never reads the
 *   document; a path with marked rows is read through a CASE that computes them (src/duck/rewrite.ts `keptRead`). A
 *   row is unset after READY only through a write path that does not compute it (a Mason bug); a row is marked
 *   where its function raised — for a path, a document Postgres accepted and the function cannot read (a Mason bug);
 *   for a jsonb's key under a libc collation, a string holding a character the measured order does not cover (the gap
 *   `libc-uncovered`, which a stream or a poll may write at any time). A MARK WRITTEN AFTER THE COUNT is never read
 *   as a value: the exact read raises at it by the column alone (src/duck/kept-route.ts `markedError`; the gap's
 *   refusal for a libc key, else the bug's), so no write path — the poll's, the stream's, a side table's — has to
 *   report its marks before it commits. The DETECTOR: every `CHECK_EVERY` reviews each READY column's unset and marked
 *   rows are counted; the RESPONSE: unset rows are filled, marked rows turn the path's reads back to the CASE (the
 *   generation moves), which computes them and raises the function's own error (the character named), and either is
 *   said — a libc key's marks as the gap, any other as a bug (`markedText`).
 * - EVERY WRITE COMPUTES IT (`stored`, `storedSet`): the poll's write by key (src/duck/sync.ts `writeStaged`), the
 *   stream's insert by key and unchanged-TOAST update (`writeByKey`, `updateCarried`), and the copy — its side table
 *   filled before its swap (`fillSide`), so the column is never missing from the served table. A column is added only
 *   on the writer's turn and never while its table is rebuilt (a catch-up poll writes it from another connection), so
 *   every write knows the columns of the table it writes.
 * - HIDDEN: a statement that lists a table's columns without naming them reads the copy's view of its visible columns
 *   (src/duck/kept-route.ts `hideKept`, `VISIBLE_CATALOG`); the catalog Postgres never knows the column.
 * - A JSONB'S ORDER (src/duck/kept-route.ts `ORDER_STEPS`): `ORDER BY j`, `GROUP BY j`, `j = k` compare a key of the
 *   whole document, stored as a read like a path's — a BLOB column of the key (`orderKeySql`), under the collation the
 *   listener tells (`orderBy`): `ORDER_STEPS:<id>`, so a key of another collation is another column, dropped. Under a
 *   LIBC collation equality reads the C key instead (src/duck/rewrite.ts `equalKey`), a read of its own
 *   (`EQUAL_STEPS:<equalId>`): a SECOND column beside the order's, stored, filled, swept, marked and dropped exactly as
 *   it is; under C and ICU the order's key serves equality, and no second column is ever made (`own`, `orderBy`).
 * - OFF (`enabled: false`, `.mason/config.json` `storeJsonPaths: false`, `MASON_STORE_JSON_PATHS=off` for a serve): at
 *   open every stored column is dropped and its row marked dropped, and nothing is recorded, stored or routed.
 */
import type { DuckConnection } from "./executor.ts";
import { DUCKDB_VERSION, MASON_SCHEMA, type DuckStore } from "./store.ts";
import { createHash } from "node:crypto";
import { canonicalRead, EQUAL_STEPS, HIDDEN_PREFIX, HIDDEN_RE, hiddenName, isEqualRead, isKeyRead, isOrderRead, KEY_NULL_HEX, KEY_RECOMPUTE_HEX, knownSteps, ORDER_STEPS, pathKey,
  pathText, readOfKey, VISIBLE_CATALOG,
  type JsonRead, type KeptRoutes, type ReadyPath } from "./kept-route.ts";
import { JSONB_KEY_FUNCTIONS, KEY_VERSION, libcUncovered, STORED_SUFFIX } from "./jsonb-order.ts";
import { TURN_FUNCTION } from "./functions.ts";
import { encodeLibcOrder, type LibcOrder } from "./libc-order.ts";
import { icuNameOf, type DuckCollation } from "./rewrite.ts";

/** a path read by this many statements in the request log is stored (a larger table's also needs `KEEP_FILL_SHARE`) */
export const KEEP_AFTER_STATEMENTS = 3;
/** a path of a SMALL table (`SMALL_FILL_SECONDS`) read by one statement that took this long (ms, the request log's
 *  duration: arrival to last row) is stored at once — the cost the feature removes is per row, so one slow read is the
 *  evidence where the fill is cheap; the same second the request log's slow statements are listed from
 *  (src/cli/run-server.ts SLOW_MS) */
export const KEEP_AFTER_MS = 1000;
/**
 * A FILL IS WEIGHED AGAINST THE READS (the test server: one 3.5 s read of a 7-day window started a fill of
 * a 196.5 M-row table — 1 h 34 min, disk-bound, ~2.5 KB read a row, stalling other work — and one-off checks queued
 * eight paths, two on that table). The evidence was one statement's window; the cost is the whole table. A table whose
 * fill is estimated under `SMALL_FILL_SECONDS` keeps the rule above (`KEEP_AFTER_STATEMENTS` statements, or one slower
 * than `KEEP_AFTER_MS`); any other needs `KEEP_AFTER_STATEMENTS` statements whose reads took `KEEP_FILL_SHARE` of the
 * fill's estimate in all, within the request log's window: what the reads cost by the function, over the window, is the
 * evidence the fill will pay back.
 */
export const SMALL_FILL_SECONDS = 60;
export const KEEP_FILL_SHARE = 0.1;
/**
 * A FILL'S ESTIMATE, MODELLED (`fillEstimate`): `FILL_US_PER_ROW` µs a row plus the JSON column's bytes ON DISK a row
 * at `FILL_DISK_BYTES_PER_US` — what a chunk reads of the column, never the text's average length, which priced the
 * test server's fill (4 vCPU, EBS; ~313 B of text a row by a sample of its first rows, 443–580 B on the source) at
 * ~5 µs a row, 16 min 48 s for 196.6 M rows, where it took 18–29 µs a row (3,606 s with the `->` key, 5,640 s before
 * it), reading ~2.5 KB of disk a row filled. A table whose column is not on disk yet (never checkpointed) is priced by
 * its text's bytes, which overstates it (text is several times its compressed size), the safe side.
 *
 * THE FIT: the two measured fills cost about the same a row for different reasons. A laptop (10 cores, NVMe, the file
 * in the page cache), 30 M rows of ~2.3 KB documents, ~329 B a row on disk: 558 s, 18.6 µs a row; a chunk of it loads
 * exactly its rows' share of the column (330–346 B a row, whatever its alignment to the row groups) and costs 0.8 µs a
 * row without the function, 13–15 µs with it — there the function parsing each document is the cost. The test server:
 * 18.35 µs a row, ~2.5 KB of disk read a row — there the disk is. So most of the cost is per row (`FILL_US_PER_ROW`),
 * and the bytes term spans what the server's column may hold on disk, not known here (~260 B a row if its copy is
 * zstd, ~660 B uncompressed, 2.5 KB if every byte the fill read was the column's): the model gives the laptop 472 s
 * (0.85×) and the server 2,980–6,650 s across that range, within 2× of both its fills (tests/duck-json-columns.test.ts
 * holds it). A fill that ran replaces the model (`MEASURED_MIN_ROWS`).
 */
export const FILL_US_PER_ROW = 13;
export const FILL_DISK_BYTES_PER_US = 120;
/**
 * A MEASURED RATE BEATS THE MODEL: once a fill of a JSON column has run (any path of it: the cost is the column's, not
 * the path's), its rows a second (`KeptPath.filled`, the seconds its chunks held the writer) estimate that column's
 * next fill — while that fill filled at least `MEASURED_MIN_ROWS` (a smaller one measures the transactions, not the
 * rows) and the table has at most `MEASURED_SPAN` times the rows it filled (a table grown past that may no longer fit
 * the memory its rows were read from).
 */
export const MEASURED_MIN_ROWS = 10_000;
export const MEASURED_SPAN = 10;
/** the rows a table's JSON column's text bytes a row are sampled over, where its column is not on disk yet (its first
 *  rows: never a scan of the table) */
const SAMPLE_ROWS = 10_000;
/** how long a table's measurement is kept before it is measured again (a fill of its column ending forgets it) */
const MEASURE_AGAIN_MS = 10 * 60_000;
/** rows filled per transaction of a backfill: ~0.1–0.25 s of the function on a laptop (2.6 s a million rows, measured),
 *  so the writer's other turns and the event loop wait at most that long */
export const BACKFILL_ROWS = 50_000;
/** how often the request log is read for new paths, and backfills continued */
export const REVIEW_MS = 10_000;
/** the marked rows whose documents are read to say what they are (`markedText`) */
const MARKS_READ = 10_000;
/** every this many reviews, each READY column's unset rows are counted (the detector) */
const CHECK_EVERY = 6;

export const PATHS_TABLE = `${MASON_SCHEMA}.json_paths`;
const PATHS_DDL = `CREATE TABLE IF NOT EXISTS ${PATHS_TABLE} (name VARCHAR PRIMARY KEY, source VARCHAR, column_name VARCHAR, steps VARCHAR, either BOOLEAN, ` +
  `canonical BOOLEAN, as_text BOOLEAN, state VARCHAR, rows_total BIGINT, rows_done BIGINT, statements BIGINT, slowest_ms BIGINT, kept_at TIMESTAMPTZ, ` +
  `ready_at TIMESTAMPTZ, why VARCHAR)`;
/** what a ledger from before these columns lacks */
const PATHS_ADDED = ["marked BIGINT", "total_ms BIGINT", "fill_rows BIGINT", "fill_bytes_per_row BIGINT", "fill_seconds DOUBLE", "fill_basis VARCHAR",
  "fill_rows_per_second DOUBLE", "filled_rows BIGINT", "filled_seconds DOUBLE"];
const PATHS_COLUMNS = "name, source, column_name, steps, either, canonical, as_text, state, rows_total, rows_done, statements, slowest_ms, kept_at, ready_at, why, " +
  "marked, total_ms, fill_rows, fill_bytes_per_row, fill_seconds, fill_basis, fill_rows_per_second, filled_rows, filled_seconds";
/** the column's marks (src/duck/functions.ts keptJsonValue), as SQL: a NULL answer, and a value computed at read time */
const NULL_SQL = "chr(0)";
const RECOMPUTE_SQL = "chr(0) || '!'";

/** `waiting`: read often enough to be stored but held back by its fill's cost (`decide`), with no column */
export type KeptState = "waiting" | "backfilling" | "ready" | "dropped";
/** where a fill's estimate comes from: `measured`, the rate of the last fill of the same JSON column (`measuredEstimate`);
 *  `disk`, modelled from the column's bytes on disk a row (`fillEstimate`); `text`, modelled from its text's bytes a row,
 *  where the column is not on disk yet */
export type FillBasis = "measured" | "disk" | "text";
/** What a path's fill would cost: the table's rows, the seconds, and what they were estimated from — the JSON column's
 *  bytes a row (modelled; 0 for a measured one) or the rows a second of its last fill (measured; null for a modelled one). */
export interface FillEstimate { rows: number; bytesPerRow: number; seconds: number; basis: FillBasis; rowsPerSecond: number | null }
/** A stored JSON path as `mason status` shows it (`--json`'s `jsonPaths`): a path's `->` read, `asText` false. */
export interface KeptPath extends JsonRead {
  /** its hidden column (`__mason_json_…`) */
  name: string;
  state: KeptState;
  /** READY rows marked to be computed at read time (KEPT_RECOMPUTE): its reads go through the document while any is */
  marked: number;
  /** the request log's statements' time reading it, in all (ms), when it was decided */
  totalMs: number;
  /** its fill's estimate when it was decided, null where none was made (the oracle's eager store) */
  fill: FillEstimate | null;
  /** what its own fill measured, once it ended: the rows its chunks filled and the seconds they held the writer (the
   *  next fill of its JSON column is estimated from them: `MEASURED_MIN_ROWS`) */
  filled: { rows: number; seconds: number } | null;
  /** status only: a backfilling path whose fill waits for the one under way (`fills`) */
  queued?: boolean;
  /** the rows to fill when it was added, and filled so far: a backfill's progress */
  rowsTotal: number;
  rowsDone: number;
  /** the statements of the request log that read it, and the slowest one's ms, when it was stored */
  statements: number;
  slowestMs: number | null;
  keptAt: string;
  readyAt: string | null;
  /** why it was stored, or why it was dropped */
  why: string;
}
/** A path as `mason status` says it: its copied table is `table` (a JSON key named `source` is a database, src/cli/commands.ts) */
export type KeptPathStatus = Omit<KeptPath, "source"> & { table: string };

/** What the keeper needs of the sync (src/duck/sync.ts `Sync`). */
export interface KeptHost {
  /** a job on the writer's turn (Sync.onWriter): no other write of the copies is inside its transaction */
  onWriter<T>(f: () => Promise<T>): Promise<T>;
  /** every copy served now, by source: its columns' names and source types (the copy's own, `copiedColumns`) */
  served(): ReadonlyMap<string, ReadonlyArray<{ name: string; type: string }>>;
  /** a rebuild of it is under way: its copy, or its catch-up poll, which writes the table from another connection */
  rebuilding(source: string): boolean;
  log(line: string): void;
}

export interface KeptOptions {
  enabled: boolean;
  /** the oracle's: every read a plan meets is stored, and filled, before the plan is made (`keepNow`) */
  eager?: boolean;
  /** tests': the review's interval (0: no timer), a backfill's chunk, and a fill's estimate in place of the measured one */
  reviewMs?: number;
  backfillRows?: number;
  estimate?: (read: JsonRead) => FillEstimate;
}

/**
 * THE SETTING (`MASON_STORE_JSON_PATHS`, for mason start and mason serve): `on` (the default) stores the JSON paths
 * statements keep reading; `off` stores none, and drops what was stored at the next start.
 */
export const STORE_JSON_PATHS_SETTING = "MASON_STORE_JSON_PATHS";
export function storeJsonPathsOf(env: NodeJS.ProcessEnv): boolean {
  const v = (env[STORE_JSON_PATHS_SETTING] ?? "").trim().toLowerCase();
  if (v === "" || v === "on") return true;
  if (v === "off") return false;
  throw new Error(`${STORE_JSON_PATHS_SETTING}=${JSON.stringify(env[STORE_JSON_PATHS_SETTING])} is not a setting: on (the default) stores the JSON paths statements keep reading ` +
    "as columns of the synced table, off stores none (and drops those stored, at this start)");
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;
const tableOf = (source: string): string => { const at = source.indexOf("."); return `${ident(source.slice(0, at))}.${ident(source.slice(at + 1))}`; };

/** the value a stored column takes from its JSON column's `value` (a column reference or an expression): the path's
 *  `->` answer, never NULL (a NULL document's is `KEPT_NULL` too: the column's NULL is a row not stored yet) */
export function keptValueSql(p: Omit<JsonRead, "asText">, value: string): string {
  return `coalesce(__mason_json_kept(${TURN_FUNCTION}(NULL, ${value}), ${value}, ${literal(p.steps)}, ${p.either}, ${p.canonical}, false), ${NULL_SQL})`;
}

/**
 * A JSONB'S STORED KEY, from its column's `value` (src/duck/kept-route.ts `ORDER_STEPS`): the key the statement would
 * compute (src/duck/rewrite.ts `jsonbKeyCall`), by the same functions (src/duck/jsonb-order.ts `JSONB_KEY_FUNCTIONS`,
 * their stored twins), never NULL — `KEY_NULL_HEX` for a NULL document (the column's NULL is a row not stored yet), and
 * `KEY_RECOMPUTE_HEX` where the key raised, which its read computes (and raises) again.
 */
export function orderKeySql(c: DuckCollation, value: string): string {
  const call = (name: string, ...args: string[]): string => `${name}${STORED_SUFFIX}(${TURN_FUNCTION}(NULL, ${value}), ${args.join(", ")})`;
  const key = c.kind === "bytes" ? call(JSONB_KEY_FUNCTIONS.bytes.key, value)
    : call(JSONB_KEY_FUNCTIONS[c.kind].key, value, `list_transform(${call(JSONB_KEY_FUNCTIONS[c.kind].strings, value)}, __mason_s -> icu_sort_key(__mason_s, ${literal(icuNameOf(c))}))`);
  return `CASE WHEN (${value}) IS NULL THEN unhex('${KEY_NULL_HEX}') ELSE coalesce(${key}, unhex('${KEY_RECOMPUTE_HEX}')) END`;
}

/**
 * A STORED KEY'S ID in its `steps` (`ORDER_STEPS:<id>`): what its bytes depend on, so a key is read only where the
 * statement's own key would be the same bytes — its collation (a libc one by its measured order's content: a glibc
 * whose order moved is another collation), the key's encoding (`KEY_VERSION`) and the DuckDB whose ICU made its strings'
 * keys (`DUCKDB_VERSION`: an upgrade may bring another ICU). Another id is another column, dropped at `orderBy`.
 */
export function orderId(c: DuckCollation, libc: LibcOrder | undefined, versions = `k${KEY_VERSION}:${DUCKDB_VERSION}`): string {
  if (c.kind === "bytes") return `c:${versions}`;
  if (c.kind === "icu") return `icu:${c.name}:${versions}`;
  if (libc === undefined) throw new Error("a libc collation's order was not read (Mason bug: report it)");
  return `libc:${c.icu}:${createHash("sha256").update(encodeLibcOrder(libc)).digest("hex").slice(0, 16)}:${versions}`;
}

/**
 * THE C KEY'S ID, stored under a libc collation for equality (`EQUAL_STEPS:<id>`, src/duck/kept-route.ts): the C
 * collation's order id (`orderId`), so with the key's encoding (`KEY_VERSION`) and the DuckDB (`DUCKDB_VERSION`) in it,
 * as an order key's — a release that changes either stores it again. The libc order is not in it: the C key reads no
 * collation, so a glibc whose order moved keeps it.
 */
export function equalId(versions?: string): string {
  return versions === undefined ? orderId({ kind: "bytes" }, undefined) : orderId({ kind: "bytes" }, undefined, versions);
}

/** a stored column's type, and its mark of a value computed at read time, as SQL */
const columnType = (p: { steps: string }): string => isKeyRead(p) ? "BLOB" : "VARCHAR";
const recomputeSql = (p: { steps: string }): string => isKeyRead(p) ? `unhex('${KEY_RECOMPUTE_HEX}')` : RECOMPUTE_SQL;

/** what a fill's measured rate is kept by (`estimate`, `lastRate`): the JSON column, and whether the fill computes a path,
 *  a jsonb's order key or its C key — a key's function is not a path's (a list of strings, their ICU keys, the key's
 *  bytes), nor a libc order's key the C key's (4.7 µs a row against 1.4, docs/DESIGN.md "jsonb's order"), so one's
 *  rate is no evidence for another's */
const measuredKey = (r: { source: string; column: string; steps: string }): string =>
  `${r.source}\u0000${r.column}\u0000${isOrderRead(r) ? "order" : isEqualRead(r) ? "equal" : "path"}`;

/** a read as its stored path's `->` read (src/duck/kept-route.ts pathKey): what the ledger holds */
export const pathOf = (r: JsonRead): JsonRead => ({ ...canonicalRead(r), asText: false });

/** the statements of the request log that read each path (its `->` and `->>` alike, a statement once), the slowest's
 *  time and their time in all (src/duck/requests.ts json_reads) */
export interface ReadCount { read: JsonRead; statements: number; slowestMs: number; totalMs: number }

/** a span of seconds as a person reads it: `4 s`, `9 min 40 s`, `1 h 28 min` */
export function spanText(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, "") : s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
  return `${Math.floor(s / 3600)} h${Math.round((s % 3600) / 60) ? ` ${Math.round((s % 3600) / 60)} min` : ""}`;
}

/** a fill's estimate MODELLED from the table's rows and its JSON column's bytes a row, on disk unless `basis` says its
 *  text (`FILL_US_PER_ROW`, `FILL_DISK_BYTES_PER_US`) */
export function fillEstimate(rows: number, bytesPerRow: number, basis: "disk" | "text" = "disk"): FillEstimate {
  return { rows, bytesPerRow, seconds: rows * (FILL_US_PER_ROW + bytesPerRow / FILL_DISK_BYTES_PER_US) / 1e6, basis, rowsPerSecond: null };
}

/** a fill's estimate from the rate the last fill of its JSON column MEASURED (rows a second) */
export function measuredEstimate(rows: number, rowsPerSecond: number): FillEstimate {
  return { rows, bytesPerRow: 0, seconds: rows / rowsPerSecond, basis: "measured", rowsPerSecond };
}

/** what an estimate says it was made from, in the ledger's `why` and so in `mason status` */
export function estimateText(fill: FillEstimate): string {
  const rows = `${Math.round(fill.rows).toLocaleString("en-US")} row(s)`;
  const bytes = `~${Math.round(fill.bytesPerRow).toLocaleString("en-US")} bytes`;
  return fill.basis === "measured"
    ? `its fill estimated at ${spanText(fill.seconds)} from the last fill of its column: ${rows} at ${Math.round(fill.rowsPerSecond ?? 0).toLocaleString("en-US")} rows/s`
    : fill.basis === "disk" ? `its fill estimated at ${spanText(fill.seconds)}: ${rows} of ${bytes} of JSON on disk (modelled)`
    : `its fill estimated at ${spanText(fill.seconds)}: ${rows} of ${bytes} of JSON text, not on disk yet (modelled)`;
}

/**
 * THE POLICY, ONE PATH (`review`): whether the request log's reads of it justify its fill. `keep`: store it; `held`:
 * the reads would have stored it on a small table, its fill's cost holds it back (a `waiting` row says so); `why` is
 * what the ledger and `mason status` say either way.
 */
export function decide(c: Pick<ReadCount, "statements" | "slowestMs" | "totalMs">, fill: FillEstimate): { keep: boolean; held: boolean; why: string } {
  const cost = estimateText(fill);
  const read = `read by ${c.statements} statement${c.statements === 1 ? "" : "s"}`;
  const often = c.statements >= KEEP_AFTER_STATEMENTS, slow = c.slowestMs >= KEEP_AFTER_MS;
  if (fill.seconds < SMALL_FILL_SECONDS) {
    if (often) return { keep: true, held: false, why: `${read} (${cost})` };
    if (slow) return { keep: true, held: false, why: `read by a statement that took ${(c.slowestMs / 1000).toFixed(1)} s (${cost})` };
    return { keep: false, held: false, why: `${read} (${cost})` };
  }
  const needMs = KEEP_FILL_SHARE * fill.seconds * 1000;
  const spent = `${read} taking ${spanText(c.totalMs / 1000)} in all`;
  if (often && c.totalMs >= needMs) return { keep: true, held: false, why: `${spent}, over ${KEEP_FILL_SHARE * 100} % of ${cost}` };
  return { keep: false, held: often || slow,
    why: `not stored: ${spent}, and ${cost}; stored once ${KEEP_AFTER_STATEMENTS} statements read it for ${spanText(needMs / 1000)} in all` };
}

export class KeptJsonPaths implements KeptRoutes {
  private readonly store: DuckStore;
  private readonly host: KeptHost;
  readonly enabled: boolean;
  private readonly eager: boolean;
  private readonly reviewMs: number;
  private readonly backfillRows: number;
  private readonly estimateFor: ((read: JsonRead) => FillEstimate) | undefined;
  /** every path with a row, by its hidden column's name */
  private readonly paths = new Map<string, KeptPath>();
  /** the copies with a view of their visible columns (`VISIBLE_CATALOG`) */
  private readonly views = new Set<string>();
  /** where each backfill is (the rowid it continues at) */
  private readonly cursors = new Map<string, number>();
  private gen = 0;
  private timer: NodeJS.Timeout | null = null;
  private reviewing: Promise<void> | null = null;
  private reviews = 0;
  private stopped = false;
  /** the reads already said as not storable (said once a run) */
  private readonly refusedSaid = new Set<string>();
  /** the connection the request log is read on (its own: never the writer's turn) */
  private reader: DuckConnection | null = null;

  constructor(store: DuckStore, host: KeptHost, options: KeptOptions) {
    this.store = store; this.host = host; this.enabled = options.enabled; this.eager = options.eager === true;
    this.reviewMs = options.reviewMs ?? REVIEW_MS; this.backfillRows = options.backfillRows ?? BACKFILL_ROWS;
    this.estimateFor = options.estimate;
    this.keepNow = this.enabled && this.eager ? (reads) => this.keepAll(reads) : null;
  }

  readonly keepNow: ((reads: readonly JsonRead[]) => Promise<void>) | null;

  // --------------------------------------------------------------------------------------------- what a plan reads

  ready(asked: JsonRead): ReadyPath | null {
    if (!this.enabled) return null;
    const read = this.own(asked);
    const p = this.paths.get(hiddenName(read));
    return p !== undefined && p.state === "ready" && pathKey(p) === pathKey(read) ? { name: p.name, exact: p.marked === 0 } : null;
  }
  visible(): ReadonlySet<string> { return this.views; }
  generation(): number { return this.gen; }

  // --------------------------------------------------------------------------------------------- a jsonb's order

  /** the collation a jsonb's key is stored under (`orderBy`), and its id (`orderId`); null until told */
  private order: { id: string; collation: DuckCollation; libc: LibcOrder | undefined } | null = null;

  /**
   * A READ AS THIS KEEPER STORES IT: a jsonb's order (`ORDER_STEPS`) under the collation it was told; its equality
   * (`EQUAL_STEPS`) as the C key (`equalId`) under a libc collation, and under C or ICU as the ORDER's read — the order's
   * key equates there, so one column serves both and no second is ever made; any other read as it is.
   */
  private own(r: JsonRead): JsonRead {
    if (isEqualRead(r) && this.order !== null && this.order.collation.kind !== "libc") return { ...r, steps: `${ORDER_STEPS}:${this.order.id}` };
    if (isEqualRead(r)) return { ...r, steps: `${EQUAL_STEPS}:${this.order === null ? "?" : equalId()}` };
    return isOrderRead(r) ? { ...r, steps: `${ORDER_STEPS}:${this.order?.id ?? "?"}` } : r;
  }

  /** the steps a stored key would have now (`orderBy`): the order's under the collation told, the C key's under a libc
   *  one (none under C or ICU: the order's key serves); null until told */
  private nowSteps(p: { steps: string }): string | null {
    if (this.order === null) return null;
    if (isEqualRead(p)) return this.order.collation.kind === "libc" ? `${EQUAL_STEPS}:${equalId()}` : null;
    return `${ORDER_STEPS}:${this.order.id}`;
  }

  /** a stored key of the collation statements sort and equate by now (`orderBy`): computed by writes and read by plans */
  private current(p: { steps: string }): boolean { const now = this.nowSteps(p); return now !== null && p.steps === now; }

  /**
   * THE COLLATION, TOLD (src/duck/store.ts `listener`, once the source's is known): a jsonb's stored key is that
   * collation's. Until then a stored key is written unset and read by no plan (`open`); now the keys of another
   * collation (the source's changed, or its glibc's order moved) are dropped, and those of this one filled where a
   * write left them unset — the backfill's sweep — and ready again.
   */
  async orderBy(collation: DuckCollation, libc: LibcOrder | undefined): Promise<void> {
    if (!this.enabled) return;
    const id = orderId(collation, libc);
    await this.host.onWriter(async () => {
      this.order = { id, collation, libc };
      for (const p of [...this.paths.values()].filter((x) => isKeyRead(x) && !this.current(x) && (x.state === "backfilling" || x.state === "ready"))) {
        const was = p.steps.slice(p.steps.indexOf(":") + 1), now = this.nowSteps(p);
        await this.drop(this.store.writer, p, now === null
          ? `the database's collation is no longer a libc one (now ${id}): its order's key equates jsonb, so equality reads that one`
          : `stored under another collation or version (${was}, now ${now.slice(now.indexOf(":") + 1)}); stored again when its reads ask for it`);
        this.host.log(`${p.source}: ${pathText(p)} is no longer stored: ${p.why}`);
      }
    });
    void this.fills();
  }

  /** what a stored column takes from its JSON column's `value`: a path's `->` answer (`keptValueSql`), a jsonb's order
   *  key (`orderKeySql` under the collation told), or its C key (`orderKeySql` under C) — unset (NULL) while the key is
   *  not the one told (`orderBy`): the sweep fills it */
  private valueSql(p: KeptPath, value: string): string {
    if (!isKeyRead(p)) return keptValueSql(p, value);
    if (!this.current(p)) return "NULL";
    return orderKeySql(isEqualRead(p) ? { kind: "bytes" } : this.order!.collation, value);
  }

  /** every path with a row, for `mason status` */
  status(): KeptPathStatus[] {
    return [...this.paths.values()].sort((a, b) => a.source.localeCompare(b.source) || pathText(a).localeCompare(pathText(b)))
      .map(({ source, ...p }) => ({ table: source, ...p, queued: p.state === "backfilling" && this.fillingNow !== p.name }));
  }

  // --------------------------------------------------------------------------------------------- what a write names

  /** a table's stored columns (backfilling or ready), with the value each takes from its JSON column (`valueOf`): what a
   *  write of whole rows names after the copy's own columns */
  stored(source: string, valueOf: (column: string) => string): { names: string[]; values: string[] } {
    const kept = this.physical(source);
    return { names: kept.map((p) => p.name), values: kept.map((p) => this.valueSql(p, valueOf(p.column))) };
  }

  /** what an UPDATE that sets `carried` sets too: each stored column read from one of them, from its new value */
  storedSet(source: string, carried: readonly string[], valueOf: (column: string) => string): string[] {
    return this.physical(source).filter((p) => carried.includes(p.column)).map((p) => `${ident(p.name)} = ${this.valueSql(p, valueOf(p.column))}`);
  }

  private physical(source: string): KeptPath[] {
    return [...this.paths.values()].filter((p) => p.source === source && (p.state === "backfilling" || p.state === "ready")).sort((a, b) => a.name.localeCompare(b.name));
  }

  // --------------------------------------------------------------------------------------------- open and stop

  /** At the sync's open, before the catalog serves anything: the ledger, the views, and what the file holds reconciled
   *  with it — or, turned off, every stored column dropped. */
  async open(): Promise<void> {
    const w = this.store.writer;
    await w.run(PATHS_DDL);
    for (const c of PATHS_ADDED) await w.run(`ALTER TABLE ${PATHS_TABLE} ADD COLUMN IF NOT EXISTS ${c}`);
    const rows = (await w.runAndReadAll(`SELECT name, source, column_name, steps, either, canonical, as_text, state, rows_total, rows_done, statements, slowest_ms, ` +
      `kept_at::VARCHAR, ready_at::VARCHAR, why, marked, total_ms, fill_rows, fill_bytes_per_row, fill_seconds, fill_basis, fill_rows_per_second, filled_rows, filled_seconds ` +
      `FROM ${PATHS_TABLE}`)).getRowsJS() as unknown[][];
    const isBasis = (b: unknown): b is FillBasis => b === "measured" || b === "disk" || b === "text";
    for (const r of rows) {
      const [name, source, column, steps, either, canonical, asText, state, total, done, statements, slowest, keptAt, readyAt, why, marked, totalMs, fillRows, fillBytes, fillSeconds,
        fillBasis, fillRate, filledRows, filledSeconds] = r;
      this.paths.set(String(name), { name: String(name), source: String(source), column: String(column), steps: String(steps), either: either === true, canonical: canonical === true,
        asText: asText === true, state: String(state) as KeptState, rowsTotal: Number(total ?? 0), rowsDone: Number(done ?? 0), statements: Number(statements ?? 0),
        slowestMs: slowest === null ? null : Number(slowest), keptAt: String(keptAt), readyAt: readyAt === null ? null : String(readyAt), why: String(why ?? ""),
        marked: Number(marked ?? 0), totalMs: Number(totalMs ?? 0),
        // an estimate recorded before its basis was: the text model's
        fill: fillSeconds === null || fillSeconds === undefined ? null : { rows: Number(fillRows ?? 0), bytesPerRow: Number(fillBytes ?? 0), seconds: Number(fillSeconds),
          basis: isBasis(fillBasis) ? fillBasis : "text", rowsPerSecond: fillRate === null || fillRate === undefined ? null : Number(fillRate) },
        filled: filledRows === null || filledRows === undefined || filledSeconds === null || filledSeconds === undefined ? null : { rows: Number(filledRows), seconds: Number(filledSeconds) } });
    }
    // a row of a kind this Mason does not know (another release's: `knownSteps`) is dropped, its column with it (no
    // write here could compute it, and none names it once dropped), and said with its steps: inert, never fatal
    for (const p of this.paths.values()) {
      if (p.state === "dropped" || knownSteps(p.steps)) continue;
      await this.drop(w, p, `stored by another release as ${p.steps}, a kind this Mason does not know`);
      this.host.log(`${p.source}: dropped the stored ${p.column} of a kind this Mason does not know (${p.steps}); its column goes at this start`);
    }
    // a path an earlier Mason stored in another form (a column per spelling or per `->>`, its rows' marks other): its
    // name is not its path's (`hiddenName`), so it is dropped with its column, and stored again as the policy says
    const earlier = "stored by an earlier Mason in another form; stored again when its reads ask for it";
    for (const p of this.paths.values()) {
      if (p.state === "dropped" || p.state === "waiting" || (p.name === hiddenName(p) && !p.asText)) continue;
      await this.drop(w, p, earlier);
    }
    // the hidden columns the file holds, by table (side tables of a copy in progress included)
    const held = (await w.runAndReadAll(`SELECT schema_name || '.' || table_name, column_name FROM duckdb_columns() WHERE database_name = current_database() ` +
      `AND schema_name <> ${literal(MASON_SCHEMA)} AND starts_with(column_name, ${literal(HIDDEN_PREFIX)})`)).getRowsJS() as Array<[string, string]>;
    if (!this.enabled) {
      for (const [table, column] of held) await w.run(`ALTER TABLE ${tableOf(table)} DROP COLUMN ${ident(column)}`);
      const n = Number((await w.run(`UPDATE ${PATHS_TABLE} SET state = 'dropped', why = 'stored JSON paths are turned off (storeJsonPaths)' WHERE state <> 'dropped'`)).rowsChanged);
      for (const p of this.paths.values()) if (p.state !== "dropped") Object.assign(p, { state: "dropped", why: "stored JSON paths are turned off (storeJsonPaths)" });
      if (held.length || n) this.host.log(`stored JSON paths are turned off (storeJsonPaths): dropped ${held.length} stored column(s) of ${n} path(s); their reads are computed per row again`);
      return;
    }
    // what the ledger and the file disagree on: a column with no row is dropped, a row whose column is gone is dropped
    const named = new Set(held.filter(([t]) => !t.endsWith("__mason_copy")).map(([t, c]) => `${t}\u0000${c}`));
    const live = (column: string, table: string): boolean => { const p = this.paths.get(column); return p !== undefined && p.source === table && (p.state === "backfilling" || p.state === "ready"); };
    for (const [table, column] of held) {
      if (table.endsWith("__mason_copy") && live(column, table.slice(0, -"__mason_copy".length)) || HIDDEN_RE.test(column) && live(column, table)) continue;
      await w.run(`ALTER TABLE ${tableOf(table)} DROP COLUMN ${ident(column)}`);
      this.host.log(`${table}: dropped the column ${column}: no stored JSON path is recorded for it`);
    }
    for (const p of this.paths.values()) {
      if (p.state === "dropped" || p.state === "waiting" || named.has(`${p.source}\u0000${p.name}`)) continue;
      await this.drop(w, p, "its column is not in the synced table");
    }
    // a jsonb's stored key is its collation's, told after this (`orderBy`): until then a write leaves it unset and no
    // plan reads it, so a ready one is filled again where unset first — the backfill's sweep alone (its ranges are done)
    for (const p of this.paths.values()) {
      if (!isKeyRead(p) || p.state !== "ready") continue;
      p.state = "backfilling";
      this.cursors.set(p.name, Number.MAX_SAFE_INTEGER);
    }
    await w.run(`ATTACH IF NOT EXISTS ':memory:' AS ${VISIBLE_CATALOG}`);
    for (const source of this.host.served().keys()) await this.view(source);
    if (this.reviewMs > 0 && !this.eager) {
      this.timer = setInterval(() => { void this.review(); }, this.reviewMs);
      this.timer.unref();
    }
  }

  /** no review starts from now on; resolves once the one under way has ended (it stops at its next chunk) */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
    await this.reviewing;   // never rejects: a review says its own failure
    await this.filling;     // nor a fill (`fills`)
    this.reader?.closeSync();
    this.reader = null;
  }

  /** a path's row marked dropped, with why (on the caller's connection and turn). Its COLUMN stays in the table until
   *  the next start, whose reconciling of the file with the ledger (`open`, "a column with no row") drops it: every
   *  write names only the stored columns (`stored`), and DuckDB's DROP COLUMN rewrites the table */
  private async drop(c: DuckConnection, p: KeptPath, why: string): Promise<void> {
    await c.run(`UPDATE ${PATHS_TABLE} SET state = 'dropped', why = ${literal(why)} WHERE name = ${literal(p.name)}`);
    if (p.state === "ready") this.gen++;
    Object.assign(p, { state: "dropped", why });
    this.cursors.delete(p.name);
  }

  /**
   * A COPY'S VIEW OF ITS VISIBLE COLUMNS (`VISIBLE_CATALOG`): made for every served copy, before the catalog serves it
   * and before any column is stored in it, and made again after every swap (its columns or their types may be other).
   * DuckDB writes one attached database a transaction, so never inside the swap's. A view that cannot be made is said;
   * its table then gets no stored column (`keep`), so nothing of it is hidden that its statements could list.
   */
  private async view(source: string): Promise<void> {
    if (!this.enabled) return;
    const at = source.indexOf(".");
    const [schema, table] = [source.slice(0, at), source.slice(at + 1)];
    const w = this.store.writer;
    try {
      const cols = (await w.runAndReadAll(`SELECT column_name FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = ${literal(schema)} ` +
        `AND table_name = ${literal(table)} ORDER BY column_index`)).getRowsJS().map((r) => String(r[0])).filter((c) => !HIDDEN_RE.test(c));
      if (cols.length === 0) { this.views.delete(source); return; }
      const db = String((await w.runAndReadAll("SELECT current_database()")).getRowsJS()[0]![0]);
      await w.run(`CREATE SCHEMA IF NOT EXISTS ${VISIBLE_CATALOG}.${ident(schema)}`);
      await w.run(`CREATE OR REPLACE VIEW ${VISIBLE_CATALOG}.${ident(schema)}.${ident(table)} AS SELECT ${cols.map(ident).join(", ")} FROM ${ident(db)}.${ident(schema)}.${ident(table)}`);
      this.views.add(source);
    } catch (e) {
      this.views.delete(source);
      this.host.log(`${source}: the view of its columns for statements that list them all could not be made, so none of its JSON paths is stored: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // --------------------------------------------------------------------------------------------- what the sync tells it

  /**
   * THE COPY'S SIDE TABLE, BEFORE ITS SWAP (src/duck/sync.ts `copy`, on the rebuilds' connection): every stored column of
   * its table whose JSON column the copy holds, added and filled, so the swapped-in table has them all, whole — never a
   * moment without the column a plan reads. Filled where unset, so a copy resumed after a stop fills what is left. `run`
   * is the sync's interruptible statement (a `mason stop` interrupts it, and the copy resumes).
   */
  async fillSide(c: DuckConnection, source: string, side: string, columns: readonly string[], run: (sql: string) => Promise<number>): Promise<void> {
    if (!this.enabled) return;
    for (const p of this.physical(source).filter((x) => columns.includes(x.column))) {
      // no default: its NULL is "not stored yet", and an ADD COLUMN writes nothing into the rows (`keep`)
      await c.run(`ALTER TABLE ${side} ADD COLUMN IF NOT EXISTS ${ident(p.name)} ${columnType(p)}`);
      const end = Number((await c.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${side}`)).getRowsJS()[0]![0]);
      for (let lo = 0; lo < end; lo += this.backfillRows) {
        await run(`UPDATE ${side} SET ${ident(p.name)} = ${this.valueSql(p, ident(p.column))} WHERE rowid >= ${lo} AND rowid < ${lo + this.backfillRows} AND ${ident(p.name)} IS NULL`);
      }
      // rows the column cannot answer alone (KEPT_RECOMPUTE) turn its reads to the CASE before the side table serves;
      // counted again once it does (`swapped`)
      const marked = Number((await c.runAndReadAll(`SELECT count(*) FROM ${side} WHERE ${ident(p.name)} = ${recomputeSql(p)}`)).getRowsJS()[0]![0]);
      if (marked > p.marked) { if (p.marked === 0 && p.state === "ready") this.gen++; p.marked = marked; }
    }
  }

  /** In the swap's transaction (src/duck/sync.ts `swap`): the paths whose JSON column the new copy does not hold are
   *  recorded dropped — their column goes with the old table — and forgotten here once it commits (`swapped`). */
  async swapping(c: DuckConnection, source: string, columns: readonly string[]): Promise<void> {
    this.gone = [];
    for (const p of this.physical(source).filter((x) => !columns.includes(x.column))) {
      const why = `${p.column} is no longer a column of the synced table ${source}`;
      await c.run(`UPDATE ${PATHS_TABLE} SET state = 'dropped', why = ${literal(why)} WHERE name = ${literal(p.name)}`);
      this.gone.push({ p, why });
    }
  }
  /** what the swap under way drops (`swapping`), applied when it commits (`swapped`) */
  private gone: Array<{ p: KeptPath; why: string }> = [];

  /** After the swap committed, on the writer's turn: the paths it dropped forgotten, the table's view made again; a
   *  backfill of the old table is over — the side table was filled whole (`fillSide`), so the next review finds it ready. */
  async swapped(source: string): Promise<void> {
    for (const { p, why } of this.gone) {
      if (p.state === "ready") this.gen++;
      Object.assign(p, { state: "dropped", why });
      this.cursors.delete(p.name);
      this.host.log(`${source}: ${pathText(p)} is no longer stored: ${why}`);
    }
    this.gone = [];
    await this.view(source);
    for (const p of this.physical(source)) {
      this.cursors.set(p.name, Number.MAX_SAFE_INTEGER);
      await this.settle(p);
    }
  }

  /** A table no longer added, dropped by the sync on the writer's turn: its paths and view go with it. */
  async removed(source: string): Promise<void> {
    const w = this.store.writer;
    await w.run(`DELETE FROM ${PATHS_TABLE} WHERE source = ${literal(source)}`);
    for (const p of [...this.paths.values()].filter((x) => x.source === source)) { if (p.state === "ready") this.gen++; this.paths.delete(p.name); this.cursors.delete(p.name); }
    if (this.views.delete(source)) {
      const at = source.indexOf(".");
      await w.run(`DROP VIEW IF EXISTS ${VISIBLE_CATALOG}.${ident(source.slice(0, at))}.${ident(source.slice(at + 1))}`);
    }
  }

  // --------------------------------------------------------------------------------------------- the policy

  /**
   * The request log's reads (`_mason.requests.json_reads`), counted by stored PATH — its `->` and `->>` reads and its
   * spellings alike, each statement once — with the slowest statement's time and their time in all; none while there
   * is no log (a test's sync).
   */
  private async readCounts(): Promise<ReadCount[]> {
    this.reader ??= await this.store.instance.connect();
    const r = this.reader;
    const there = (await r.runAndReadAll(`SELECT count(*) FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = ${literal(MASON_SCHEMA)} ` +
      `AND table_name = 'requests' AND column_name = 'json_reads'`)).getRowsJS()[0]![0] as bigint;
    if (there === 0n) return [];
    const rows = (await r.runAndReadAll(`SELECT read, statement, duration_ms FROM (SELECT DISTINCT unnest(from_json(json_reads, '["VARCHAR"]')) AS read, rowid AS statement, ` +
      `coalesce(duration_ms, 0) AS duration_ms FROM ${MASON_SCHEMA}.requests WHERE json_reads IS NOT NULL)`)).getRowsJS() as Array<[string, bigint, number | bigint]>;
    // by path: a statement that read a path twice (its -> and its ->>) counts once
    const by = new Map<string, { read: JsonRead; statements: Map<bigint, number> }>();
    for (const [key, statement, ms] of rows) {
      const read = readOfKey(key);
      if (read === null) continue;
      const path = this.own(pathOf(read)), k = pathKey(path);
      let e = by.get(k);
      if (e === undefined) by.set(k, e = { read: path, statements: new Map() });
      e.statements.set(statement, Number(ms));
    }
    return [...by.values()].map(({ read, statements }) => {
      const ms = [...statements.values()];
      return { read, statements: ms.length, slowestMs: Math.max(0, ...ms), totalMs: ms.reduce((a, b) => a + b, 0) };
    });
  }

  /**
   * A PATH'S FILL ESTIMATED: the table's rows at the rate the last fill of the same JSON column measured (`lastRate`),
   * else modelled from the column's bytes ON DISK a row (`diskBytesPerRow`), else — the column not on disk yet — from
   * its text's bytes a row over its first `SAMPLE_ROWS` (never a scan of the table). Kept `MEASURE_AGAIN_MS`, and
   * forgotten when a fill of the column ends.
   */
  private readonly measured = new Map<string, { at: number; fill: FillEstimate }>();
  private async estimate(read: JsonRead): Promise<FillEstimate> {
    if (this.estimateFor !== undefined) return this.estimateFor(read);
    const key = measuredKey(read);
    const was = this.measured.get(key);
    if (was !== undefined && Date.now() - was.at < MEASURE_AGAIN_MS) return was.fill;
    this.reader ??= await this.store.instance.connect();
    const target = tableOf(read.source);
    const rows = Number((await this.reader.runAndReadAll(`SELECT count(*) FROM ${target}`)).getRowsJS()[0]![0]);
    const rate = this.lastRate(read, rows);
    let fill: FillEstimate;
    if (rate !== null) fill = measuredEstimate(rows, rate);
    else {
      const disk = await this.diskBytesPerRow(read.source, read.column);
      if (disk !== null) fill = fillEstimate(rows, disk, "disk");
      else {
        const text = Number((await this.reader.runAndReadAll(`SELECT coalesce(avg(coalesce(strlen(${ident(read.column)}::VARCHAR), 0)), 0) FROM ` +
          `(SELECT ${ident(read.column)} FROM ${target} LIMIT ${SAMPLE_ROWS})`)).getRowsJS()[0]![0]);
        fill = fillEstimate(rows, text, "text");
      }
    }
    this.measured.set(key, { at: Date.now(), fill });
    return fill;
  }

  /** the rows a second of the last fill of a JSON column (any path of it; a jsonb's key by a key's fill alone) that is
   *  evidence for a table of `rows` now (`MEASURED_MIN_ROWS`, `MEASURED_SPAN`), or null */
  private lastRate(read: JsonRead, rows: number): number | null {
    let last: KeptPath | null = null;
    for (const p of this.paths.values()) {
      if (measuredKey(p) !== measuredKey(read) || p.filled === null || p.filled.seconds <= 0 || p.filled.rows < MEASURED_MIN_ROWS) continue;
      if (rows > MEASURED_SPAN * p.filled.rows) continue;
      if (last === null || (p.readyAt ?? "") > (last.readyAt ?? "")) last = p;
    }
    return last === null || last.filled === null ? null : last.filled.rows / last.filled.seconds;
  }

  /**
   * A JSON column's bytes ON DISK a row: the distinct blocks its checkpointed segments occupy (`pragma_storage_info`:
   * a segment's block and its additional ones; a block shared by two segments counted once) at the file's block size,
   * over the rows those segments hold. A metadata read, never a read of the rows. Null where none of it is on disk.
   */
  private async diskBytesPerRow(source: string, column: string): Promise<number | null> {
    const r = this.reader!;
    const info = `pragma_storage_info(${literal(tableOf(source))})`;
    const [blocks, held] = (await r.runAndReadAll(`SELECT (SELECT count(DISTINCT b) FROM (SELECT unnest(list_prepend(block_id, coalesce(additional_block_ids, []::BIGINT[]))) AS b ` +
      `FROM ${info} WHERE column_name = ${literal(column)} AND persistent AND block_id >= 0)), ` +
      `(SELECT coalesce(sum(count), 0) FROM ${info} WHERE column_name = ${literal(column)} AND persistent AND NOT contains(column_path, ','))`)).getRowsJS()[0]!.map(Number) as [number, number];
    if (held === 0 || blocks === 0) return null;
    const size = Number((await r.runAndReadAll("SELECT block_size FROM pragma_database_size() WHERE database_name = current_database()")).getRowsJS()[0]![0]);
    return blocks * size / held;
  }

  /**
   * ONE REVIEW (every `REVIEW_MS`, one at a time, WHATEVER A FILL IS DOING): the request log read again, its reads
   * weighed against their fills (`decide`) — the first the evidence justifies stored (its column added on the writer's
   * turn, between a running fill's chunks, and its fill queued behind that one: `fills`), those the cost holds back
   * recorded `waiting` with their reads and estimate as they are now; the fills started if none is running, never
   * waited for (a review that waited for an hour's fill left every waiting row an hour stale and decided nothing); and,
   * every `CHECK_EVERY` reviews, each READY column's unset and marked rows found (the detector). A failure is said and
   * tried at the next review: the copies serve as they were.
   */
  review(): Promise<void> {
    if (!this.enabled || this.stopped) return Promise.resolve();
    this.reviewing ??= (async () => {
      try {
        const counts = await this.readCounts();
        for (const c of counts) { const p = this.paths.get(hiddenName(c.read)); if (p !== undefined && p.state !== "waiting") { p.statements = c.statements; p.slowestMs = c.slowestMs; p.totalMs = c.totalMs; } }
        const candidates = counts.filter((c) => { const p = this.paths.get(hiddenName(c.read)); return (p === undefined || p.state === "dropped" || p.state === "waiting") && this.storable(c.read); })
          .sort((a, b) => b.totalMs - a.totalMs || b.statements - a.statements || pathKey(a.read).localeCompare(pathKey(b.read)));
        let kept = false;
        for (const c of candidates) {
          // (only the reads that would be stored on a small table are measured: never a table per ad-hoc read)
          if (c.statements < KEEP_AFTER_STATEMENTS && c.slowestMs < KEEP_AFTER_MS) continue;
          const fill = await this.estimate(c.read);
          const d = decide(c, fill);
          if (d.keep && !kept) { await this.keep(c.read, c, fill, d.why); kept = true; }
          else if (d.held) await this.wait(c.read, c, fill, d.why);
        }
        void this.fills();
        if (++this.reviews % CHECK_EVERY === 0) for (const p of [...this.paths.values()].filter((x) => x.state === "ready")) await this.check(p);
      } catch (e) {
        this.host.log(`stored JSON paths: the review failed, and runs again in ${Math.round(this.reviewMs / 1000)} s (the synced tables serve as they were): ${e instanceof Error ? e.message : String(e)}`);
      } finally { this.reviewing = null; }
    })();
    return this.reviewing;
  }

  /** the fill loop under way (`fills`), and the path it fills now */
  private filling: Promise<void> | null = null;
  private fillingNow: string | null = null;

  /**
   * THE FILLS, ONE PATH AT A TIME (started by a review, or the oracle's `keepAll`; resolves once none is left to run
   * now): every backfilling path, the first added first, each to its end a chunk a writer's turn (`backfill`) — a path
   * added while one fills waits for it, so the writer is never held by two fills' chunks at once and each chunk stays one
   * short transaction. A path paused by its table's rebuild is tried again by the next review. A failure is said, and
   * the next review starts the fills again.
   */
  fills(): Promise<void> {
    if (!this.enabled || this.stopped) return Promise.resolve();
    if (this.filling !== null) return this.filling;
    // set before it runs and cleared by its own end: a loop with nothing to fill ends before its first await, and its
    // end must not run before it is recorded (it would leave a finished loop recorded as running, and no fill after it)
    const run = this.runFills();
    this.filling = run;
    void run.then(() => { if (this.filling === run) this.filling = null; });
    return run;
  }

  /** the loop `fills` records: it never rejects (a failure is said) */
  private async runFills(): Promise<void> {
    const tried = new Set<string>();
    try {
      for (;;) {
        const next = [...this.paths.values()].filter((p) => p.state === "backfilling" && !tried.has(p.name))
          .sort((a, b) => a.keptAt.localeCompare(b.keptAt) || a.name.localeCompare(b.name))[0];
        if (next === undefined || this.stopped) break;
        tried.add(next.name);
        this.fillingNow = next.name;
        await this.backfill(next);
      }
    } catch (e) {
      this.host.log(`stored JSON paths: a fill failed, and goes on at the next review in ${Math.round(this.reviewMs / 1000)} s (its rows filled so far are kept): ${e instanceof Error ? e.message : String(e)}`);
    } finally { this.fillingNow = null; }
  }

  /** a read whose column can be stored now: its table served, with its view, the column a json or jsonb, no column of
   *  its own of the hidden name, and no rebuild of it under way. One that never can be is said once. */
  private storable(read: JsonRead): boolean {
    const cols = this.host.served().get(read.source);
    if (cols === undefined || !this.views.has(read.source) || this.host.rebuilding(read.source)) return false;
    // a jsonb's key waits for its collation (`orderBy`, at the listener's start), and its C key is stored under a libc
    // one alone (`own` folds it into the order's elsewhere): nothing to say
    if (isKeyRead(read) && !this.current(read)) return false;
    const name = hiddenName(read);
    const col = cols.find((c) => c.name === read.column);
    const why = col === undefined ? `${read.column} is not a column of the synced table`
      : !/^jsonb?$/.test(col.type) ? `${read.column} is a ${col.type}, not a json or jsonb`
      : isKeyRead(read) && col.type !== "jsonb" ? `${read.column} is a ${col.type}, which has no order or equality (a jsonb's is stored)`
      : cols.some((c) => c.name.toLowerCase() === name) ? `the synced table has a column named ${name} of its own` : null;
    if (why === null) return true;
    const key = pathKey(read);
    if (!this.refusedSaid.has(key)) { this.refusedSaid.add(key); this.host.log(`${read.source}: ${pathText(read)} is not stored: ${why}`); }
    return false;
  }

  /** the ledger's row of a path, written whole (on the caller's connection and turn) */
  private async record(c: DuckConnection, p: KeptPath): Promise<void> {
    const v = (x: number | null): string => x === null ? "NULL" : String(x);
    await c.run(`INSERT OR REPLACE INTO ${PATHS_TABLE} (${PATHS_COLUMNS}) VALUES (${literal(p.name)}, ${literal(p.source)}, ${literal(p.column)}, ${literal(p.steps)}, ` +
      `${p.either}, ${p.canonical}, false, ${literal(p.state)}, ${p.rowsTotal}, ${p.rowsDone}, ${p.statements}, ${v(p.slowestMs)}, ${literal(p.keptAt)}::TIMESTAMPTZ, ` +
      `${p.readyAt === null ? "NULL" : `${literal(p.readyAt)}::TIMESTAMPTZ`}, ${literal(p.why)}, ${p.marked}, ${p.totalMs}, ${v(p.fill?.rows ?? null)}, ` +
      `${v(p.fill === null ? null : Math.round(p.fill.bytesPerRow))}, ${v(p.fill?.seconds ?? null)}, ${p.fill === null ? "NULL" : literal(p.fill.basis)}, ` +
      `${v(p.fill?.rowsPerSecond ?? null)}, ${v(p.filled?.rows ?? null)}, ${v(p.filled?.seconds ?? null)})`);
  }

  /** a path the reads would store but its fill's cost holds back: its row, `waiting`, says why (written when it says
   *  something new), and no column */
  private async wait(read: JsonRead, c: ReadCount, fill: FillEstimate, why: string): Promise<void> {
    const name = hiddenName(read);
    const was = this.paths.get(name);
    if (was !== undefined && was.state === "waiting" && was.why === why) return;
    const p: KeptPath = { ...pathOf(read), name, state: "waiting", rowsTotal: fill.rows, rowsDone: 0, statements: c.statements, slowestMs: c.slowestMs, totalMs: c.totalMs, fill,
      filled: null, marked: 0, keptAt: new Date().toISOString(), readyAt: null, why };
    await this.host.onWriter(async () => {
      if (this.stopped) return;
      const now = this.paths.get(name);
      if (now !== undefined && now.state !== "waiting" && now.state !== "dropped") return;
      await this.record(this.store.writer, p);
      this.paths.set(name, p);
    });
    if (was?.state !== "waiting") this.host.log(`${read.source}: ${pathText(read)} is ${why}`);
  }

  /**
   * A PATH'S COLUMN ADDED to its table, on the writer's turn, with its row (backfilling): from this turn on every write
   * computes it; its existing rows are the backfill's. With NO DEFAULT: DuckDB's ADD COLUMN writes its
   * default into every row before the turn ends, a NULL one as validity alone — measured on a laptop over 30 M rows,
   * `DEFAULT chr(0)` held the turn 0.7 - 1.0 s (the ALTER computing it, then its COMMIT writing ~4 bytes a row into the
   * file under force_compression), no default 0.1 s and nothing written until a checkpoint; on the test server's
   * 196.5 M-row table the default held the writer 28 s. Still a known cost nothing here shortens: the ALTER reads no
   * block of the table but builds the new column in memory for every row (~4.5 B a row; 30 M rows: 100–330 ms, 135 MB),
   * which the next checkpoint writes (one block a row group under forced zstd), the same on another connection, as
   * JSON, with IF NOT EXISTS or outside this transaction; the test server's 196.6 M rows held the writer 8–17 s
   * (docs/DESIGN.md "Stored JSON paths" 2.; tests/duck-json-columns.test.ts times it).
   */
  private async keep(read: JsonRead, c: Pick<ReadCount, "statements" | "slowestMs" | "totalMs">, fill: FillEstimate | null, why: string): Promise<void> {
    const name = hiddenName(read);
    const kept = await this.host.onWriter(async () => {
      const was = this.paths.get(name);
      if (this.stopped || this.host.rebuilding(read.source) || (was !== undefined && (was.state === "backfilling" || was.state === "ready"))) return null;
      const w = this.store.writer;
      const target = tableOf(read.source);
      await w.run("BEGIN TRANSACTION");
      try {
        await w.run(`ALTER TABLE ${target} ADD COLUMN ${ident(name)} ${columnType(read)}`);
        const rows = Number((await w.runAndReadAll(`SELECT count(*) FROM ${target}`)).getRowsJS()[0]![0]);
        const p: KeptPath = { ...pathOf(read), name, state: "backfilling", rowsTotal: rows, rowsDone: 0, statements: c.statements, slowestMs: c.slowestMs, totalMs: c.totalMs,
          fill, filled: null, marked: 0, keptAt: new Date().toISOString(), readyAt: null, why };
        await this.record(w, p);
        await w.run("COMMIT");
        this.paths.set(name, p);
        this.cursors.set(name, 0);
        // the plans kept are made again: none of them knew the column (a `*` over the table reads its view regardless)
        this.gen++;
        return p;
      } catch (e) {
        await w.run("ROLLBACK");
        throw e;
      }
    });
    if (kept !== null) this.host.log(`${read.source}: storing ${pathText(read)} as a column (${kept.why}): filling its ${kept.rowsTotal.toLocaleString("en-US")} row(s), then statements read it from there`);
  }

  /** a backfill continued to its end, a chunk a writer's turn (paused while its table is rebuilt: the next review goes
   *  on), then the path made ready once no row of it is unset — and read by its column alone once none is marked */
  private async backfill(p: KeptPath): Promise<void> {
    // a jsonb's key waits for its collation (`orderBy`): its rows would be filled unset
    if (isKeyRead(p) && !this.current(p)) return;
    const target = tableOf(p.source);
    const end = await this.host.onWriter(async () => Number((await this.store.writer.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${target}`)).getRowsJS()[0]![0]));
    // what this fill measures: the rows its chunks filled and the time they held the writer (never the waits for its
    // turns, which are the other work's), the rate the next fill of its column is estimated from (`lastRate`)
    let rows = 0, ms = 0;
    for (let lo = this.cursors.get(p.name) ?? 0; lo < end; lo += this.backfillRows) {
      const done = await this.host.onWriter(async () => {
        if (this.stopped || this.host.rebuilding(p.source) || p.state !== "backfilling") return false;
        const at = performance.now();
        rows += await this.fillChunk(p, `rowid >= ${lo} AND rowid < ${lo + this.backfillRows} AND `);
        ms += performance.now() - at;
        this.cursors.set(p.name, lo + this.backfillRows);
        return true;
      });
      if (!done) return;
    }
    // THE SWEEP: what the ranges did not reach (a row whose rowid moved, a row a write left unset while a jsonb's
    // collation was not told), by the mark itself — a chunk a writer's turn, as the ranges are; the turn whose chunk
    // finds none unset makes the path ready (every write computes it from then on, so none is left unset after it)
    for (;;) {
      const swept = await this.host.onWriter(async () => {
        if (this.stopped || this.host.rebuilding(p.source) || p.state !== "backfilling") return "paused";
        if (await this.fillChunk(p, `rowid IN (SELECT rowid FROM ${target} WHERE ${ident(p.name)} IS NULL LIMIT ${this.backfillRows}) AND `) > 0) return "more";
        p.marked = await this.markedRows(p);
        Object.assign(p, { state: "ready", readyAt: new Date().toISOString(), filled: rows > 0 && ms > 0 ? { rows, seconds: ms / 1000 } : p.filled });
        await this.record(this.store.writer, p);
        this.cursors.delete(p.name);
        this.measured.delete(measuredKey(p));
        this.gen++;
        return "ready";
      });
      if (swept !== "more") break;
    }
    if (p.state === "ready") {
      const took = rows > 0 && ms > 0 ? `, ${rows.toLocaleString("en-US")} by this fill in ${spanText(ms / 1000)}${p.fill === null ? "" : `, estimated at ${spanText(p.fill.seconds)} (${p.fill.basis === "measured" ? "from the last fill" : "modelled"})`}` : "";
      this.host.log(`${p.source}: ${pathText(p)} is stored: statements read it from its column (${p.rowsDone.toLocaleString("en-US")} row(s) filled${took})` +
        (p.marked > 0 ? `; ${await this.markedText(p, p.marked)}` : ""));
    }
  }

  /**
   * WHAT A PATH'S MARKED ROWS ARE, in words (the fill's end, the detector): a jsonb's key under a libc collation is
   * marked where a string holds a character the measured order does not cover — the gap its sort is refused by
   * (`libc-uncovered`), told apart by reading the marked rows' documents (`libcUncovered`, at most `MARKS_READ` of
   * them); any other mark is a row its function could not read, a Mason bug.
   */
  private async markedText(p: KeptPath, marked: number): Promise<string> {
    let uncovered = 0, read = marked;
    const libc = this.order?.libc;
    if (isOrderRead(p) && this.current(p) && libc !== undefined) {
      const docs = await this.host.onWriter(async () => (await this.store.writer.runAndReadAll(`SELECT ${ident(p.column)}::VARCHAR FROM ${tableOf(p.source)} ` +
        `WHERE ${ident(p.name)} = ${recomputeSql(p)} LIMIT ${MARKS_READ}`)).getRowsJS() as Array<[string | null]>);
      read = docs.length;
      uncovered = docs.filter(([d]) => d !== null && libcUncovered(libc, d)).length;
    }
    const of = read < marked ? ` (of the first ${read.toLocaleString("en-US")} read, of ${marked.toLocaleString("en-US")})` : "";
    const said: string[] = [];
    if (uncovered > 0) said.push(`${uncovered.toLocaleString("en-US")} row(s) hold a character the database's libc order is not measured for, so a sort of them is refused by name (Mason gap libc-uncovered)`);
    if (read > uncovered) said.push(`${(read - uncovered).toLocaleString("en-US")} row(s) its function could not read are computed from their document when read (a Mason bug: report it, with mason logs)`);
    return said.join("; ") + of;
  }

  /** a column's rows marked to be computed at read time (KEPT_RECOMPUTE), on the caller's turn */
  private async markedRows(p: KeptPath): Promise<number> {
    return Number((await this.store.writer.runAndReadAll(`SELECT count(*) FROM ${tableOf(p.source)} WHERE ${ident(p.name)} = ${recomputeSql(p)}`)).getRowsJS()[0]![0]);
  }

  /** a READY path's marked rows counted again (its table swapped in, the detector): a change of exactness moves the
   *  plans' generation, so a plan that read the column alone is made again as the CASE, and the other way */
  private async settle(p: KeptPath): Promise<void> {
    if (p.state !== "ready") return;
    const marked = await this.markedRows(p);
    if (marked === p.marked) return;
    if ((marked === 0) !== (p.marked === 0)) this.gen++;
    p.marked = marked;
    await this.store.writer.run(`UPDATE ${PATHS_TABLE} SET marked = ${marked} WHERE name = ${literal(p.name)}`);
  }

  /** one chunk of a fill, in a transaction of its own on the writer's turn (the caller's): the rows `where` picks that
   *  are unset, filled, and the path's count with them */
  private async fillChunk(p: KeptPath, where: string): Promise<number> {
    const w = this.store.writer;
    await w.run("BEGIN TRANSACTION");
    try {
      const n = Number((await w.run(`UPDATE ${tableOf(p.source)} SET ${ident(p.name)} = ${this.valueSql(p, ident(p.column))} WHERE ${where}${ident(p.name)} IS NULL`)).rowsChanged);
      await w.run(`UPDATE ${PATHS_TABLE} SET rows_done = rows_done + ${n} WHERE name = ${literal(p.name)}`);
      await w.run("COMMIT");
      p.rowsDone += n;
      return n;
    } catch (e) {
      await w.run("ROLLBACK");
      throw e;
    }
  }

  /** THE DETECTOR: a READY column's rows still unset (a write that did not compute it: a Mason bug), filled and said;
   *  and its marked rows counted again (`settle`) */
  private async check(p: KeptPath): Promise<void> {
    const marked = await this.host.onWriter(async (): Promise<number> => {
      if (this.stopped || this.host.rebuilding(p.source) || p.state !== "ready") return 0;
      const unset = Number((await this.store.writer.runAndReadAll(`SELECT count(*) FROM ${tableOf(p.source)} WHERE ${ident(p.name)} IS NULL`)).getRowsJS()[0]![0]);
      if (unset > 0) {
        this.host.log(`${p.source}: ${unset} row(s) were written without the stored value of ${pathText(p)} (a Mason bug: report it, with mason logs); they are filled now`);
        while (await this.fillChunk(p, `rowid IN (SELECT rowid FROM ${tableOf(p.source)} WHERE ${ident(p.name)} IS NULL LIMIT ${this.backfillRows}) AND `) > 0);
      }
      const was = p.marked;
      await this.settle(p);
      return p.marked > was ? p.marked : 0;
    });
    // (the words read the table again on a writer's turn of their own, never inside the detector's)
    if (marked > 0) this.host.log(`${p.source}: ${pathText(p)} has marked rows, read through their document from now on: ${await this.markedText(p, marked)}`);
  }

  /** THE ORACLE'S (`eager`): every read's path stored and filled now, whatever the request log says */
  private async keepAll(reads: readonly JsonRead[]): Promise<void> {
    for (const r of reads) {
      const read = this.own(pathOf(r));
      const name = hiddenName(read);
      if (this.paths.get(name)?.state === "ready" || !this.storable(read)) continue;
      if (this.paths.get(name)?.state !== "backfilling") await this.keep(read, { statements: 0, slowestMs: 0, totalMs: 0 }, null, "stored at once (eager)");
      // the same fills a review starts, waited for: one fill at a time whoever asks
      for (;;) {
        const p = this.paths.get(name);
        if (p?.state !== "backfilling" || this.stopped) break;
        const before = p.rowsDone;
        await this.fills();
        // paused by its table's rebuild, or failed (said): no row moved, and the read is the function's until a later plan
        const now = this.paths.get(name);
        if (now?.state === "backfilling" && now.rowsDone === before) break;
      }
    }
  }
}
