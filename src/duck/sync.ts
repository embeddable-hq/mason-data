/**
 * THE COPY AND ITS FRESHNESS (the prototype, docs/DESIGN.md decisions F and G, step 0): every added table —
 * a table the project's sources file names, as `mason add` writes it there — is copied into DuckDB as `<schema>.<table>`
 * through DuckDB's `postgres` extension (`ATTACH … (TYPE postgres, READ_ONLY)`: type-faithful, streamed, nothing
 * created on the source), its listed columns only, stored in the order the source's scan delivers its rows (its heap
 * order: about the order they were inserted in, on a table that mostly grows) and with NO key constraint or index
 * (`copy` says what was measured).
 *
 * KEPT CURRENT AS THE SOURCES FILE SAYS, PER TABLE (`AddedTable.sync`, src/lib/table-sync.ts; GitHub issue 33): `off`
 * (the default) reads a table again only when asked (`pollNow`, `mason sync`), `poll <interval>` by MASON'S XMIN
 * POLL (step 1, decision G; `MASON_DUCK_SYNC=poll`, the default) at that interval, and `replication` by the database's
 * change log (src/duck/stream.ts) through the project's ONE slot and publication, which carries the replicated tables
 * only (`ensurePublication`) — the polled tables polled beside the stream, the slot made when the first table is
 * replicated and dropped, verified gone, when the last one no longer is (`retireReplication`). Each polled table is polled by ONE
 * DuckDB transaction of its own (one over every table held them all behind the slowest), which reads the source through the attached extension — which runs every read of a
 * DuckDB transaction in ONE Postgres REPEATABLE READ READ ONLY transaction (verified: a count inside it did
 * not move for an INSERT committed outside it), so every read below sees one snapshot — and commits what it read:
 *   1. the snapshot (`pg_current_snapshot()`, src/cdc/poll.ts SNAPSHOT_SQL);
 *   2. per table, every row whose `xmin` is at or past the table's WATERMARK (the oldest transaction running at the
 *      last poll, `pg_snapshot_xmin`; src/cdc/poll.ts xmin8Sql), written by its primary key — the keys deleted, then
 *      the rows inserted (`writeByKey`: no index, so no `INSERT OR REPLACE`) — so a row read again because its
 *      transaction was still running last time is simply written again;
 *   3. per table, the source's count against DuckDB's; only when they differ (a DELETE, a TRUNCATE, a key an UPDATE
 *      changed) are the keys compared — DuckDB anti-joins the source's keys — and a key the source lacks is deleted;
 *   4. the new watermarks (`_mason.poll_state`), in the SAME DuckDB transaction as the rows: a poll that dies leaves
 *      both as they were, and is read again.
 * The first copy pins its snapshot first and records ITS watermark, as the change reader records one before its copy,
 * and is read in chunks held to that snapshot, which resume (`copy`; the smallest table first, `copyOrder`). What a poll costs the source — a scan per table (no index covers xmin) and a
 * count — is timed, per table, in the log's `poll:` line. A table's next poll waits its interval, stretched to four
 * times what its last poll took (`nextPollDelayMs`), and the next pass waits at least four times what the last pass's
 * polls took together: so the polls never take more than a fifth of the source's time, whatever the intervals say. The
 * size of a table decides nothing here: `mason add` writes `sync: off` for a big one (src/lib/table-sync.ts
 * BIG_TABLE_ROWS), in the file, where a reviewer sees it.
 *
 * A REBUILD RUNS BESIDE, NEVER INSTEAD (adding one 195 M-row table stopped every other table's
 * freshness, and held the slot's WAL, for the 35 minutes of its copy). A copy, and the catch-up poll after it, run one
 * at a time (a queue: DuckDB's memory limit is shared) on a DuckDB connection of their own (the
 * `rebuilder` lane), writing only their own table, its side table and its ledger rows — DuckDB's MVCC lets two
 * transactions write different rows of one database. Everything else that writes runs on `store.writer`, one turn at a
 * time (`onWriter`: a statement on a connection lands inside whatever transaction is open there): the stream's batches,
 * the polls, the attachment of the source, and every rebuild's SWAP, so a table is never dropped under a write of it.
 * A table rebuilt is left out of the polls and the stream until its swap, then caught up by ONE poll from its
 * watermark before it joins them again (src/duck/stream.ts "why replaying is safe" says why nothing is lost).
 *
 * STEP 0 (`MASON_DUCK_SYNC=recopy`) keeps the crude way: the whole table copied again every interval, in one DuckDB
 * transaction. Bounded by the table's size; kept to compare against.
 *
 * WHAT IS KEPT (`_mason.copy_state`, one row per table, in the same file): the phase, rows, the source's bytes, how
 * long the copy took and when, and the error of the last attempt — `mason status` / `wait` read it through the run's
 * `/api/state`, and docs/DESIGN.md's measurements are read from it. A copy in progress has a row of its own
 * in `_mason.copy_progress` (`CopyProgress`), written with each chunk and removed with its swap.
 *
 * Read-only on the source (CLAUDE.md): only SELECTs, through a READ_ONLY attachment.
 */
import type { DuckStore } from "./store.ts";
import { freeBytesAt, MASON_SCHEMA, NO_ROLE_SESSION, SessionSetup } from "./store.ts";

/** the session the generated tables' run passes the Mason functions: no slot of the cancel table (src/duck/cancel.ts
 *  `slotOf`), so never cancelled through it; a stop interrupts the run's connection instead */
const GENERATED_SESSION = "generated";
import { GeneratedTables, type GeneratedOptions } from "./generated.ts";
import { KeptJsonPaths, type KeptOptions } from "./kept.ts";
import type { Source, SourceColumnInfo, SourceTable, SourceView } from "../cli/preflight.ts";
import { DuckDBEnumType, DuckDBListType, type DuckDBType } from "@duckdb/node-api";
import type { DuckConnection } from "./executor.ts";
import type { PgApiType, PgColumn, PgJoin, PgSchema, PgTable, PgView } from "../api/postgres/schema.ts";
import { wireColumn } from "./types.ts";
import { nextPollDelayMs, SNAPSHOT_SQL, snapshotXmin, xmin8Sql, xminBeforeHolds, xminBeforeSql } from "../cdc/poll.ts";
import { pgIdent } from "../cdc/pg-wire.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { PgConnection, formatLsn, parseLsn, pgLiteral, type PgConnectOptions } from "../cdc/pg-wire.ts";
import { createSlot, currentLsn, dropSlot, readSlot, type SlotState } from "../cdc/source.ts";
import { holdOf } from "./held-types.ts";
import { addCounts, countsText, duckValue, foldInto, noChanges, noCounts, ReplicationStream, type ChangeCounts, type StreamedTable, type TableChanges } from "./stream.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { namedPublicationVerdict, readNamedPublication } from "./publication.ts";
import type { SyncEventInput } from "./events.ts";
import { extensionFailure, loadPostgresSql } from "./extensions.ts";
import { BIG_TABLE_ROWS, intervalOf, syncedText, syncText, syncWords, type PolledSync, type TableSync } from "../lib/table-sync.ts";

/** how a run keeps its copies current: each table as its `sync:` says (`poll`; a table with none — a test's — polled at
 *  the run's interval), each as its `sync:` says with a table with none streamed (`replication`: a test's run of the
 *  stream), or every table copied again whole (step 0, `recopy`) */
export type SyncMode = "poll" | "recopy" | "replication";
export function syncModeOf(env: NodeJS.ProcessEnv): SyncMode {
  const v = env.MASON_DUCK_SYNC || "poll";
  if (v !== "poll" && v !== "recopy") throw new Error(`MASON_DUCK_SYNC must be poll or recopy, got ${JSON.stringify(v)}`);
  return v;
}

/** An added table: the source's, narrowed to the columns its entry in the sources file copies (the key always among
 *  them; src/cli/sources.ts addedTables). `key` is what it is copied by; `primaryKey`, when present, the source's own
 *  primary key (none) where the sources file names a `key:` — the catalog declares only what the source does. `sync`
 *  is how the sources file keeps it current after its first copy (its entry's, else the file's, else `off`); a table
 *  with none — a test's — is polled at the sync's own interval (`Sync.syncOf`). */
export type AddedTable = Pick<SourceTable, "source" | "schema" | "table" | "key" | "columns" | "foreignKeys" | "bytes" | "rows"> & Partial<Pick<SourceTable, "rowTypeOid" | "uniqueKeys">> &
  { primaryKey?: string[]; sync?: TableSync; replicaIdentity?: SourceTable["replicaIdentity"] };

export type CopyPhase = "waiting" | "copying" | "copied" | "failed";

/** The slot and publication a replication run reads; `owned` when the publication is Mason's own to make and alter. */
export interface SyncReplication { slot: string; publication: string; owned: boolean }

/**
 * WHEN A POLLED TABLE IS POLLED NEXT: its interval after its last poll ended, stretched to four times that poll's own
 * time (`nextPollDelayMs`) — so one table's polls never take more than a fifth of the source's time, whatever its
 * `sync: poll <interval>` says (a 20 s poll of a table set to `poll 5s` waits 80 s).
 */
export function nextPollAt(endedMs: number, intervalSeconds: number, pollMs: number): number {
  return endedMs + nextPollDelayMs(intervalSeconds * 1000, pollMs);
}

/**
 * HOW LONG THE NEXT PASS WAITS: until the first polled table is due — and at least four times what the last pass took
 * (its polls, one after another on the writer), so ALL the tables' polls together never take more than a fifth of the
 * source's time, however many are due at once. Bounded by setTimeout's 2^31 - 1 ms: a later poll is waited for in
 * steps, a pass that finds nothing due polling nothing.
 */
export function passDelayMs(earliestDueMs: number, nowMs: number, lastPassMs: number): number {
  return Math.min(2 ** 31 - 1, Math.max(0, earliestDueMs - nowMs, 4 * lastPassMs));
}

/** what one table's poll found (`Sync.pollNow`): the rows it wrote, the keys it deleted, the source's count after */
export interface PolledTable { table: string; changed: number; deleted: number; rows: number; ms: number }

/** a table `mason sync` named in replication mode (`Sync.pollNow`): nothing to poll, so where the stream is and its part */
export interface StreamedAnswer { table: string; position: string; state: StreamTableStatus["state"]; why: string | null }

/** a poll asked for that cannot run (`Sync.pollNow`), its reason in the asker's words: `code` is the CLI's failure code */
export class PollRefused extends Error {
  readonly code: "not_found" | "nothing_yet" | "refused";
  constructor(code: PollRefused["code"], message: string) { super(message); this.code = code; }
}

/** a statement interrupted, or never started, because the sync is stopping (`Sync.stop`): a stop, never a failure */
export class Stopping extends Error {
  constructor() { super("Mason is stopping"); }
}

export interface CopyState {
  source: string;
  phase: CopyPhase;
  rows: number | null;
  /** the source table's size on disk when copied (pg_total_relation_size, from the catalog read) */
  bytes: number | null;
  /** how long the last whole copy took */
  seconds: number | null;
  copiedAt: string | null;
  error: string | null;
  /** while a table copies: its committed chunks' rows (exact), else absent */
  rowsSoFar?: number | null;
  /** while a table copies: the source's estimate of its rows that `rowsSoFar` is a share of, else absent */
  rowsEstimate?: number | null;
  /** while a table's chunks are read: what they have done and are doing at the moment the state is asked
   *  (`copyProgressNow`), so a reader of it moves between two commits; else absent */
  progress?: CopyProgressView;
  /** the copy is in a layout this Mason no longer keeps (`RETIRED_LAYOUT`): it serves as it was until it is copied
   *  again, in heap order */
  retired?: string;
  /** when the copy was last brought current, how long that took and by what (`Synced`); absent before its first copy */
  synced?: Synced;
  /** copied, and caught up by one poll before the polls or the stream keep it current again (`behind`): why */
  behind?: string;
  /** a copy or a catch-up of it is running now (one rebuild at a time): a table copied before serves that copy meanwhile */
  rebuilding?: "copy" | "catch-up";
  /** how the run keeps this copy current NOW (`Sync.keptOf`): present on every state a run's `state` answers */
  kept?: KeptCurrent;
}

/**
 * WHEN A COPY WAS LAST BROUGHT CURRENT (`CopyState.synced`; mason status, `/api/state` `tables[].sync`). `at` is the
 * moment the copy held everything the database had committed as of the sync that brought it there, and ONE VALUE: the
 * time the ledger holds (`copied_at`, `polled_at`, `applied_at`), taken once, written and remembered alike, never a
 * second clock read at the commit (`Sync.polledAt`):
 *  - `copy`: right after its swap (the whole copy in, as of its first snapshot; its catch-up follows);
 *  - `poll`, `catch-up`: the poll's start, at or before its source snapshot, so it never says more than the rows hold —
 *    its rows and its watermark are one transaction (a catch-up is the one poll that brings a new copy current);
 *  - `stream` (replication mode): the start of the last batch the stream applied while the table was streamed — the
 *    position that batch records covers every table streamed, changed in it or not. A database that commits nothing
 *    sends no batch, so this ages while nothing changes, as `stream.lag.seconds` does.
 * `seconds` is how long that sync took: the copy's whole time, THIS table's poll (never the pass's), the batch's apply;
 * null when not known (read back at a start: the ledger keeps when a poll began, not how long it took). Nothing here
 * is relative to now: a reader derives the age (`ageSeconds`, src/cli/run-server.ts).
 */
export interface Synced { at: string; seconds: number | null; by: "copy" | "poll" | "catch-up" | "stream" }

/**
 * HOW A COPY IS KEPT CURRENT, NOW: the ONE derivation, by the sync (`Sync.keptOf`), that `mason status` (`state`'s
 * `kept`, `streamStatus`'s tables; under `--json` each table's `kept`, as it is: src/cli/run-server.ts runState) and
 * EXPLAIN (src/duck/explain.ts `keptText`) read. EXPLAIN once derived it from
 * the poll's ledger alone (`_mason.poll_state`), and a project switched to logical replication was said to be "kept
 * current by polling, last poll" two days before, while status said streamed.
 * - `poll`: the poll's mode, its table kept current as its `sync` says (src/lib/table-sync.ts: `off`, read again only when
 *   asked — `mason sync` — or `poll` every `seconds`); `syncedAt` its last copy or poll, `nextAt` when its next poll is
 *   due (null: off, or not polled now); `pending` why the copy is not kept current now,
 *   its phase included — waiting for its copy, being copied, its copy failed, to be copied again, or caught up by one
 *   poll first (`notStreamedWhy`'s words) — so `kept` read alone never says a table not copied is polled;
 * - `recopy`: copied again whole every interval (every table, whatever its state: `pass`); `pending` as the poll's, for
 *   a table not copied now (waiting, being copied, its copy failed);
 * - `replication`: its part in the stream (`StreamTableStatus`'s state and why), where the stream is (`position`, the
 *   status's), the commit time of the newest change applied this run, why the stream is not running (null: it is), and
 *   `syncedAt`: the copy is current as of then — the last moment the stream had everything the database wrote (a
 *   keepalive with nothing pending, a batch applied) while the table was streamed, else its last copy or poll.
 */
export type KeptCurrent =
  | { by: "poll"; sync: PolledSync; syncedAt: string | null; nextAt: string | null; pending?: string }
  | { by: "recopy"; copiedAt: string | null; pending?: string }
  | { by: "replication"; slot: string; state: StreamTableStatus["state"]; why: string | null; position: string; lastCommit: string | null;
    notRunning: string | null; syncedAt: string | null }
  | { by: "generated"; text: string };

/**
 * WHERE THE STREAM IS, for `mason status`, `mason wait` and their `--json` (`Sync.streamStatus`; the test server's
 * first replication run printed one stream line in 35 minutes, and status showed no position, lag or count, so the slot
 * on the database was the only way to tell it worked). Positions are Postgres's `X/Y`, times ISO.
 */
export interface StreamStatus {
  /** the replication slot's name (the one object Mason makes on the database) */
  slot: string;
  /** the WAL the slot holds on the database (`SlotWal`), read at most every SLOT_READ_MS on the position's connection */
  slotWal: SlotWal;
  publication: string;
  /** a stream is running now; when not, `failure` says why and when it starts again (null: it has not started yet) */
  running: boolean;
  failure: { error: string; retryAt: string } | null;
  /** everything the database wrote up to it is in DuckDB (applied, or passed over: none of the added tables' changes) */
  position: string;
  /** the end of the last commit applied with changes, as `_mason.stream_state` records it */
  applied: string;
  /** the database's own position (pg_current_wal_lsn, pg_last_wal_replay_lsn on a standby) and when it was read — at most
   *  every 5 s, over a connection of its own (`databasePosition`) — or why it could not be */
  database: { lsn: string; at: string } | { error: string };
  /** how far behind: the WAL between `position` and the database's, and the age of the newest change applied (its commit
   *  on the database to now: an upper bound on commit → queryable right after a change; it grows while nothing changes) */
  lag: { bytes: number | null; seconds: number | null };
  /** the last batch applied with changes: when, and when its newest transaction committed on the database */
  lastBatch: { appliedAt: string; committedAt: string } | null;
  tables: StreamTableStatus[];
}
/**
 * THE WAL THE REPLICATION SLOT HOLDS ON THE DATABASE (pg_replication_slots, src/cdc/source.ts `readSlot`): from its
 * restart_lsn to the database's position now, in bytes; Postgres's `wal_status`; and `safe_wal_size`, how many more bytes
 * of WAL may be written before Postgres invalidates the slot — null when `max_slot_wal_keep_size` is unset (-1: the slot
 * holds WAL for ever while nothing reads it, CLAUDE.md "Hard-won gotchas") or the slot is lost. `at` is when it was read.
 * A read that failed is its error, never a 0.
 */
export type SlotWal = { walHeldBytes: number; walStatus: "reserved" | "extended" | "unreserved" | "lost" | null; safeWalSizeBytes: number | null; at: string } | { error: string };

/** How often the slot's WAL is read at most (`streamStatus`): a catalog view's row, on the connection the database's
 *  position is read on, so never a connection of its own — and never per poll or per batch. */
export const SLOT_READ_MS = 30_000;

/** The slot as `readSlot` read it, as `SlotWal` says it. */
export function slotWalOf(s: SlotState, name: string, at: number): SlotWal {
  if (!s.exists) return { error: `replication slot ${name} does not exist on the database (the next pass makes it again)` };
  const status = s.walStatus === "reserved" || s.walStatus === "extended" || s.walStatus === "unreserved" || s.walStatus === "lost" ? s.walStatus : null;
  // a lost slot's WAL was freed by Postgres (its restart_lsn is null): it holds none; any other null is not known
  if (s.retainedBytes === null && status !== "lost") return { error: `replication slot ${name} has no restart position yet: the WAL it holds is not known` };
  return { walHeldBytes: s.retainedBytes === null ? 0 : Number(s.retainedBytes), walStatus: status, safeWalSizeBytes: s.safeBytes === null ? null : Number(s.safeBytes), at: new Date(at).toISOString() };
}

export interface StreamTableStatus {
  /** `schema.table` */
  table: string;
  /** streamed: its changes applied as they come; catching-up: copied, one poll from its watermark first (the stream holds
   *  its changes meanwhile); waiting: not streamed until copied and caught up; left-out: the publication does not carry it */
  state: "streamed" | "catching-up" | "waiting" | "left-out";
  /** why it is not streamed, in the reader's words; null when it is */
  why: string | null;
  /** catching up: queued for its poll, polling, or applying what the stream held meanwhile; from: the watermark's time
   *  (the poll reads every row changed since); startedAt: when its poll started; held: the changes the stream holds of it;
   *  retryAt: when it is tried again after a failure (`backOff`), null when it is not waiting out one */
  catchUp?: { phase: "queued" | "polling" | "applying"; from: string | null; startedAt: string | null; held: number; retryAt: string | null };
  /** the changes the stream applied to it this run, as the database made them */
  applied: ChangeCounts;
}

export const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
export const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;
export const SRC = "_mason_source";
/** a poll's changed rows, staged per table (`poll`): a TEMP table, the writer's own */
const POLL_STAGE = "_mason_polled_";
/**
 * THE MOST CHANGED ROWS ONE POLL WRITES TO A TABLE IN ONE STATEMENT AND TRANSACTION (`poll`): past it, the rows go in
 * committed pieces of this many, a piece a range of the stage's rowids (a pushed-down filter of its scan). Set
 * when the copy had a primary key: at 64 MB on 1 M uuid keys one INSERT OR REPLACE of 600,000 changed rows
 * ran out of memory (its index). Without one (heap order, no index, measured on DuckDB 2.0.0) a piece is a
 * DELETE of its keys joined against the table's key column, then an INSERT (`writeByKey`): a scan of the key column per
 * piece, the price of having no index — 50,000 keys into 1 M uuid rows at 64 MB took 3 ms to delete and 8 ms to
 * insert, into 10 M at 2 GB 15 ms and 11 ms. The pieces stay: they bound what one transaction holds.
 */
const POLL_PIECE_ROWS = 50_000;
/** the table a copy builds beside the one that serves (`copy`), swapped in when whole */
const SIDE_SUFFIX = "__mason_copy";
/** the keys and rows one write by key deletes and inserts (`writeByKey`), TEMP tables of the writer's */
const WRITE_KEYS = "__mason_write_keys";
const WRITE_ROWS = "__mason_write_rows";
/** an unchanged-TOAST update's rows, the key and the columns it carries (`updateCarried`), a TEMP table of the
 *  writer's, and the column numbering its rows */
const WRITE_PARTIAL = "__mason_write_partial";
const WRITE_ROW = "__mason_row";

/**
 * A WRITE BY KEY WITHOUT AN INDEX: the rows of `target` whose key is one of `relation`'s (a table or a parenthesised
 * SELECT, its key columns named `named`, in the key's order) deleted by ONE join against the table's key column — a
 * scan of that column, the price of having no index (`POLL_PIECE_ROWS` has the measurements; a bigserial key prunes,
 * heap order putting its zonemaps in order). Answers how many went. A table with no key deletes nothing.
 */
async function deleteKeys(w: DuckConnection, t: Pick<AddedTable, "key">, target: string, relation: string, named: readonly string[]): Promise<number> {
  if (t.key.length === 0) return 0;
  const on = t.key.map((k, i) => `t.${ident(k)} = k.${ident(named[i]!)}`).join(" AND ");
  return Number((await w.run(`DELETE FROM ${target} AS t USING ${relation} AS k WHERE ${on}`)).rowsChanged);
}

/** a poll's staged rows (`where`: a range of them, or all) written by key into the table: their keys deleted, then the
 *  rows inserted. The stage's columns are named by position (`c0`, `c1`, …), the table's order */
export async function writeStaged(w: DuckConnection, t: Pick<AddedTable, "key" | "columns" | "source">, target: string, stage: string, where: string, kept: KeptJsonPaths): Promise<void> {
  const named = t.key.map((k) => `c${t.columns.findIndex((c) => c.name === k)}`);
  await deleteKeys(w, t, target, `(SELECT ${named.map(ident).join(", ")} FROM ${stage}${where})`, named);
  // the table's columns named, and its stored JSON paths computed from the staged JSON (src/duck/kept.ts)
  const stored = kept.stored(t.source, (c) => ident(`c${t.columns.findIndex((x) => x.name === c)}`));
  await w.run(`INSERT INTO ${target} (${[...t.columns.map((c) => ident(c.name)), ...stored.names.map(ident)].join(", ")}) ` +
    `SELECT ${[...t.columns.map((_, i) => ident(`c${i}`)), ...stored.values].join(", ")} FROM ${stage}${where}`);
}

/**
 * A COPY IN AN EARLIER LAYOUT (before copies were kept in heap order with no index): sorted by its primary
 * key, with the key's index. Its rows are physically in key order, and only the source has them in its own: it is
 * never converted in place, but copied again through the normal path (`needsCopy`), serving as it was meanwhile. Found
 * by its constraint (`duckdb_constraints()`), which every copy of that layout carries and no copy of this one does.
 */
export const RETIRED_LAYOUT = "stored in key order with an index, by an older Mason: read again whole, in heap order";

/**
 * A COPY AN OLDER MASON MADE BEFORE A TYPE WAS HELD AS ITS TEXT (src/duck/held-types.ts): a column this Mason holds as the
 * source's text (a `point`, a `money`, a range) stored as the extension's scan read it (a `point` as a STRUCT). Its
 * record (`copy_state.columns`) was written by code that did not know the column's kind, so it cannot say so: found by
 * what the copy physically is (`duckdb_columns()`), copied again through the normal path (`needsCopy`), serving as it
 * was until its swap; never converted in place.
 */
export const HELD_LAYOUT = "stored by an older Mason with a column not held as the source's text: read again whole, each such column as its text";

/** a copy in a layout this Mason no longer keeps: the layout as `mason status` says it, and its short form for a line */
interface Retired { layout: string; short: string }

/**
 * How long a failed copy waits before it is tried again: four times the attempt, at least 5 minutes, doubled for each
 * failure in a row, at most 6 hours (a copy whose sort failed for good read a production replica whole for
 * 20 minutes at every pass). A restart, or a change of the table's columns or key, tries it at once.
 */
export function copyRetryDelayMs(failures: number, attemptMs: number): number {
  return Math.min(6 * 3_600_000, Math.max(300_000, 4 * attemptMs) * 2 ** Math.max(0, failures - 1));
}

/**
 * THE ORDER TABLES ARE COPIED IN (the test server: three small tables — 776, 15 k and 22 M rows — waited the
 * whole 23 minutes of a 196 M-row table's copy before they were current): the smallest first, by the catalog's row
 * estimate (`AddedTable.rows`; unknown last), ties by the source's bytes, then by name — so most tables are current
 * within seconds while a big one copies. A first copy and a copy again (a retired layout, changed columns) alike.
 */
export function copyOrder<T extends Pick<AddedTable, "source" | "rows" | "bytes">>(tables: readonly T[]): T[] {
  const rank = (rows: number | null): number => rows === null || rows < 0 ? Infinity : rows;
  // Infinity - Infinity is NaN, falsy: two unknown estimates fall through to their bytes
  return [...tables].sort((a, b) => rank(a.rows) - rank(b.rows) || a.bytes - b.bytes || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
}

/** an added table as its records say it is when it is added (`Sync.addedStatus`): copied at the next pass and why;
 *  copied, but caught up by one poll first and why; a named publication's gap; or copied, and how it is kept current
 *  (`kept`, `Sync.keptWords`: `off` when its sync reads it again only when asked) */
export type AddedTableStatus = { source: string } & ({ copy: string } | { behind: string } | { refused: string } | { kept: string; off: boolean });

/**
 * THE LINE A START (OR AN ADDED TABLE) LOGS ABOUT ITS TABLES: what each one's records say it is, never a promise
 * of a copy that is not coming (the test server: every start said `added <all four tables>: they are copied at the
 * next pass` while all four were copied and streamed from the acknowledged position — read as a long re-copy that never
 * came). ONE line: the tables grouped by state, each group `<n> table(s) <state>: <tables>`, the current ones first,
 * those copied at the next pass last, each with its reason, a current copy with how it is kept so (`keptWords`).
 */
export function addedText(tables: readonly AddedTableStatus[]): string {
  const groups = new Map<string, { rank: number; sources: string[] }>();
  for (const t of tables) {
    const [rank, state] = "copy" in t ? [3, `synced at the next pass (${t.copy})`]
      : "behind" in t ? [2, `already synced, caught up by one poll first (${t.behind})`]
      : "refused" in t ? [4, `not synced or streamed (${t.refused})`]
      : t.off ? [1, `already synced, ${t.kept}`]
      : [0, `already synced and ${t.kept}`];
    const g = groups.get(state) ?? { rank, sources: [] };
    g.sources.push(t.source);
    groups.set(state, g);
  }
  return [...groups].sort(([, a], [, b]) => a.rank - b.rank)
    .map(([state, g]) => `${g.sources.length} table${g.sources.length === 1 ? "" : "s"} ${state}: ${g.sources.join(", ")}`).join("; ");
}

/**
 * THE LARGEST CHUNK OF A COPY (`copy`): about this many rows by the catalog's estimate — on the test server a copy read ~140,000
 * rows a second, so 2 M rows is ~15 s, and on this laptop's disposable Postgres 3 M rows read in 2.7 to 5.5 s in two
 * chunks. A chunk costs ~30 ms beyond its rows (its commit, snapshot and file check: 15 chunks of that table read in 2.4
 * to 2.5 s, 2 in 2.0 to 2.1; docs/DESIGN.md "The copy in chunks"). Bounded in pages: at least one, at most
 * `COPY_CHUNK_MAX_PAGES` (1 GiB of 8 kB pages), and that many where the estimate is unknown or the heap is wide. It is
 * the CEILING: the chunks themselves are sized by the time they take here (`nextChunkPages`).
 */
export const COPY_CHUNK_ROWS = 2_000_000;
const COPY_CHUNK_MAX_PAGES = 131_072;
/** the pages of a chunk of a table of `pages` heap pages and about `rows` rows (`COPY_CHUNK_ROWS`): the ceiling */
export function chunkPages(pages: number, rows: number | null, targetRows: number = COPY_CHUNK_ROWS): number {
  if (pages <= 0 || rows === null || rows <= 0) return COPY_CHUNK_MAX_PAGES;
  return Math.min(COPY_CHUNK_MAX_PAGES, Math.max(1, Math.round(targetRows / (rows / pages))));
}

/**
 * HOW LONG A CHUNK SHOULD TAKE TO READ, in seconds (`MASON_COPY_CHUNK_SECONDS`, 1 to 300, default 12:
 * a laptop copying a 20 M-row table from a database over the internet showed `0 of ~20,126,276 rows` for minutes, then
 * jumped by 27 %). A chunk is the unit that commits — what a stop rolls back and what `mason wait` can count — and the
 * same 2 M rows that take ~6 s on the test server's replica took minutes over a WAN, so a chunk is sized by the rate
 * measured HERE, never by a row estimate alone (`nextChunkPages`).
 */
export const COPY_CHUNK_SECONDS = 12;
const COPY_CHUNK_SECONDS_MIN = 1, COPY_CHUNK_SECONDS_MAX = 300;
export function copyChunkSecondsOf(env: NodeJS.ProcessEnv): number {
  const v = env.MASON_COPY_CHUNK_SECONDS;
  if (v === undefined || v === "") return COPY_CHUNK_SECONDS;
  const n = Number(v);
  if (!/^\d+(\.\d+)?$/.test(v.trim()) || n < COPY_CHUNK_SECONDS_MIN || n > COPY_CHUNK_SECONDS_MAX) {
    throw new Error(`MASON_COPY_CHUNK_SECONDS=${JSON.stringify(v)} is not a number of seconds from ${COPY_CHUNK_SECONDS_MIN} to ${COPY_CHUNK_SECONDS_MAX}: each of a first sync's chunks is sized to take ` +
      `about that long to read, and a stop reads at most that much again, so set it lower for a first sync that moves more often or higher for fewer, larger chunks, or unset it for ${COPY_CHUNK_SECONDS}`);
  }
  return n;
}

/** the smallest chunk, in pages (1 MiB of 8 kB pages), unless the ceiling is smaller: below it a chunk's own round
 *  trips (its snapshot, file check, ledger row and commit) are what it measures */
export const COPY_CHUNK_MIN_PAGES = 128;
/** how much of the ceiling a chunk is before anything is measured: enough to measure, small enough to move soon */
const COPY_FIRST_CHUNK_SHARE = 0.1;
/** the weight of the newest chunk in a copy's rate (`nextRate`), a moving average: 0.7 when it read slower than the rate
 *  so far, 0.3 when faster — quick to shrink, slow to grow, because a chunk sized for a rate the link no longer has is
 *  minutes nobody sees move, and one too small costs ~30 ms */
export const COPY_RATE_WEIGHT = { slower: 0.7, faster: 0.3 } as const;

/** A READER'S MEASURED RATE (`nextRate`): what one reader — one backend on the source — reads a second, here */
export interface ChunkRate { pagesPerSecond: number; rowsPerSecond: number; bytesPerSecond: number; chunks: number }

/** the rate after a chunk of `pages` heap pages and `rows` rows read in `seconds`: the first chunk's own, then an
 *  exponentially weighted moving average (`COPY_RATE_WEIGHT`, by whether the chunk read slower or faster in pages) */
export function nextRate(prev: ChunkRate | null, m: { pages: number; rows: number; seconds: number; blockSize: number }): ChunkRate {
  const s = Math.max(0.001, m.seconds), pages = Math.max(1, m.pages);
  const now = { pagesPerSecond: pages / s, rowsPerSecond: m.rows / s, bytesPerSecond: (pages * m.blockSize) / s };
  if (prev === null) return { ...now, chunks: 1 };
  const w = now.pagesPerSecond < prev.pagesPerSecond ? COPY_RATE_WEIGHT.slower : COPY_RATE_WEIGHT.faster;
  const mix = (a: number, b: number): number => (1 - w) * a + w * b;
  return { pagesPerSecond: mix(prev.pagesPerSecond, now.pagesPerSecond), rowsPerSecond: mix(prev.rowsPerSecond, now.rowsPerSecond),
    bytesPerSecond: mix(prev.bytesPerSecond, now.bytesPerSecond), chunks: prev.chunks + 1 };
}

/**
 * THE PAGES OF A COPY'S NEXT CHUNK: before anything is measured a tenth of the ceiling (`chunkPages`), at least
 * `COPY_CHUNK_MIN_PAGES`; then what one reader reads in `seconds` at the measured rate, between those two. Re-sized at
 * every chunk taken, so a copy that slows (a WAN, a busy source) cuts smaller chunks, and one that speeds up larger.
 */
export function nextChunkPages(ceiling: number, rate: ChunkRate | null, seconds: number): number {
  const floor = Math.min(ceiling, COPY_CHUNK_MIN_PAGES);
  if (rate === null) return Math.max(floor, Math.round(ceiling * COPY_FIRST_CHUNK_SHARE));
  return Math.min(ceiling, Math.max(floor, Math.round(rate.pagesPerSecond * seconds)));
}

/**
 * A COPY AS ITS CHUNKS ARE READ (`readChunks`, kept in memory while they are): what `Sync.state` turns into the copy's
 * progress at the moment it is asked (`copyProgressNow`), so `mason wait` moves between two commits.
 */
export interface CopyLive {
  /** the heap's pages when the copy began */
  pages: number;
  /** the committed chunks: how many, their pages, their rows (a resumed copy's included) */
  chunksDone: number; pagesDone: number; rowsDone: number;
  /** pages no chunk has taken yet */
  untaken: number;
  /** the pages the next chunk would be taken at (`nextChunkPages`) */
  chunkPages: number;
  /** how many readers the copy reads with */
  readers: number;
  /** the chunks being read now: since when (ms), and their pages */
  reading: Array<{ since: number; pages: number }>;
  /** one reader's measured rate this attempt, null until a chunk committed */
  rate: ChunkRate | null;
  /** rows per heap page: the committed chunks', else the catalog's estimate, else unknown */
  rowsPerPage: number | null;
  /** what its pages left are projected to add on disk, bytes (`copyDiskProjection`, at each chunk's check); null until
   *  it can be said */
  diskNeeded: number | null;
}

/**
 * WHERE THE COPY'S FILE IS, AND THE DISK UNDER IT (`Sync.diskStatus`, `/api/state` `disk`): the bytes free there — the
 * sync's own `diskFree`, the one a copy is held to — and, while copies run, what their pages left are projected to add
 * (`copyDiskProjection`, as each chunk's check last computed it: summed over the copies, null while none can say). A
 * free space that cannot be read is its error.
 */
export interface DiskStatus { path: string; freeBytes: number | null; projectedBytes: number | null; error?: string }

/** A COPY'S PROGRESS AT A MOMENT (`CopyState.progress`), for `mason wait` and `mason status` to render */
export interface CopyProgressView {
  /** the committed chunks, and about how many the copy will have (the ones left at the size the next would be) */
  chunksDone: number; chunksTotal: number;
  /** the chunks being read now, and how long the oldest of them has been */
  reading: number; readingSeconds: number | null;
  /** the rows the chunks being read have read by now at the measured rate, each held under `READING_SHARE_CAP` of its
   *  EXPECTED rows (its pages at the rows a page so far), so a commit that holds them moves the count forward. An
   *  estimate: a chunk's pages may hold fewer (the heap's last page, a sparse range), and the count then steps back to
   *  what committed; `share`, of exact pages, never does. 0 until something is measured */
  rowsReading: number;
  /** what the copy reads a second, its readers together (null: nothing measured yet), and the time its pages left take at it */
  rowsPerSecond: number | null; bytesPerSecond: number | null; secondsLeft: number | null;
  /** how much of the heap is read: the committed chunks' pages and what the ones in flight have read by now, of the pages
   *  counted when the copy began, below 1 until the copy is done. PAGES, never rows: the ranges are exact where the row
   *  count is Postgres's estimate, which a copy can outrun (23.7 M rows under an estimate of 20.1 M, and a
   *  share of the rows went back to 0 % once past it) — so it never moves backwards */
  share: number;
}

/** the most of a chunk's expected rows its reading may count before it commits (`copyProgressNow`) */
export const READING_SHARE_CAP = 0.9;

/** What a copy has done and is doing at `now` (ms): the committed chunks, plus the chunks in flight at the measured rate. */
export function copyProgressNow(l: CopyLive, now: number): CopyProgressView {
  const left = l.untaken <= 0 ? 0 : Math.ceil(l.untaken / Math.max(1, l.chunkPages));
  const oldest = l.reading.reduce<number | null>((o, r) => o === null || r.since < o ? r.since : o, null);
  const view = { chunksDone: l.chunksDone, chunksTotal: l.chunksDone + l.reading.length + left, reading: l.reading.length,
    readingSeconds: oldest === null ? null : Math.max(0, (now - oldest) / 1000) };
  const share = (pages: number): number => Math.min(0.99, Math.max(0, pages / Math.max(1, l.pages)));
  if (l.rate === null) return { ...view, rowsReading: 0, rowsPerSecond: null, bytesPerSecond: null, secondsLeft: null, share: share(l.pagesDone) };
  const rate = l.rate;
  let rowsReading = 0, pagesReading = 0;
  for (const r of l.reading) {
    const s = Math.max(0, (now - r.since) / 1000);
    pagesReading += Math.min(READING_SHARE_CAP * r.pages, rate.pagesPerSecond * s);
    rowsReading += l.rowsPerPage === null ? 0 : Math.min(READING_SHARE_CAP * r.pages * l.rowsPerPage, rate.rowsPerSecond * s);
  }
  // the readers at work while the pages left are read: no more than the chunks left to read
  const active = Math.max(1, Math.min(l.readers, l.reading.length + left));
  const pagesLeft = Math.max(0, l.untaken + l.reading.reduce((n, r) => n + r.pages, 0) - pagesReading);
  return { ...view, rowsReading: Math.floor(rowsReading), rowsPerSecond: rate.rowsPerSecond * active, bytesPerSecond: rate.bytesPerSecond * active,
    secondsLeft: pagesLeft / (rate.pagesPerSecond * active), share: share(l.pagesDone + pagesReading) };
}

/** a range of a copy's heap pages, `first` to before `end`; the heap's last range is open-ended (`end` null): a page
 *  added since the copy counted them is read too */
export interface PageRange { first: number; end: number | null }

/** The pages a copy has read: every committed range's, the open-ended one to the heap's end. */
export function pagesRead(done: readonly PageRange[], pages: number): number {
  return done.reduce((n, d) => n + (d.end ?? pages) - d.first, 0);
}

/**
 * WHAT A COPY'S PAGES LEFT WOULD ADD ON DISK, from what the pages this attempt read added to the file (the
 * test server's copy of a 194 M-row table was at 49 GB after 38% of it, with 75 GB free, and nothing said so until the
 * disk filled). Null until this attempt read 1% of the heap (at least a page), or when the file shrank meanwhile (a
 * checkpoint): too early to say. `readChunks` holds `needed` to what is free where the file is, and fails the copy
 * past it with the way out, its chunks kept, as a failed copy is tried again (tests/duck-copy-disk.test.ts;
 * tests/integration/duck-poll.itest.ts).
 */
export function copyDiskProjection(c: { pages: number; done: readonly PageRange[]; doneAtStart: readonly PageRange[]; bytesAtStart: number; bytesNow: number }): { needed: number; perPage: number; left: number } | null {
  const read = pagesRead(c.done, c.pages);
  const since = read - pagesRead(c.doneAtStart, c.pages);
  const added = c.bytesNow - c.bytesAtStart;
  if (since < Math.max(1, c.pages / 100) || added <= 0) return null;
  const perPage = added / since;
  const left = Math.max(0, c.pages - read);
  return { needed: perPage * left, perPage, left };
}

/** Bytes for a person: `1 B`, `3.2 MiB`, `49.1 GiB`. */
export function humanBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * THE CHUNKS A COPY HAS STILL TO READ (`readChunks`): every range of the heap no committed chunk (`done`) covers, in
 * page order, cut into chunks of `size` pages — the gap before the heap's end into chunks of its own (they meet a
 * committed chunk exactly), the rest up to `pages` with its last chunk open-ended. A copy of one reader leaves no gap
 * (its chunks commit in order), one of several may: a chunk committed past one in flight that died.
 */
export function chunksToRead(pages: number, size: number, done: readonly PageRange[]): PageRange[] {
  const gaps = copyGaps(done), out: PageRange[] = [];
  for (let r = takeChunk(gaps, pages, size); r !== undefined; r = takeChunk(gaps, pages, size)) out.push(r);
  return out;
}

/** every range of the heap no committed chunk (`done`) covers, in page order, whole: the last one open-ended */
export function copyGaps(done: readonly PageRange[]): PageRange[] {
  const out: PageRange[] = [];
  let cursor: number | null = 0;
  for (const d of [...done].sort((a, b) => a.first - b.first)) {
    if (cursor === null) break;
    if (d.first > cursor) out.push({ first: cursor, end: d.first });
    cursor = d.end === null ? null : Math.max(cursor, d.end);
  }
  if (cursor !== null) out.push({ first: cursor, end: null });
  return out;
}

/** THE NEXT CHUNK of `size` pages, cut from the first of `gaps` (which it shortens): a gap that meets a committed chunk
 *  is cut up to it exactly, the open-ended one into closed chunks while pages before `pages` are left, then open-ended.
 *  Undefined when nothing is left. Chunks of one size are `chunksToRead`'s; `readChunks` takes each at the size the
 *  measured rate says (`nextChunkPages`). */
export function takeChunk(gaps: PageRange[], pages: number, size: number): PageRange | undefined {
  const g = gaps[0];
  if (g === undefined) return undefined;
  const n = Math.max(1, size);
  if (g.end !== null) {
    const end = Math.min(g.end, g.first + n);
    if (end >= g.end) gaps.shift(); else gaps[0] = { first: end, end: g.end };
    return { first: g.first, end };
  }
  if (g.first + n < pages) { gaps[0] = { first: g.first + n, end: null }; return { first: g.first, end: g.first + n }; }
  gaps.shift();
  return { first: g.first, end: null };
}

/** the pages of `gaps` before the heap's end (`pages`): what no chunk has taken yet */
export const gapPages = (gaps: readonly PageRange[], pages: number): number => gaps.reduce((n, g) => n + Math.max(0, (g.end ?? pages) - g.first), 0);

/** the page before which every page of a copy is read (`done`, its committed chunks, from page 0 with no gap), or null
 *  when every page is: its swap is next */
export function readThrough(done: readonly PageRange[]): number | null {
  let cursor = 0;
  for (const d of [...done].sort((a, b) => a.first - b.first)) {
    if (d.first > cursor) break;
    if (d.end === null) return null;
    cursor = Math.max(cursor, d.end);
  }
  return cursor;
}

/** the committed chunks past the first gap, said beside `readThrough`'s page: `` when there are none */
export function pastPages(done: readonly PageRange[]): string {
  const at = readThrough(done);
  const past = at === null ? 0 : done.filter((d) => d.first > at).length;
  return past === 0 ? "" : ` (and ${past} chunk(s) past it)`;
}

/**
 * HOW MANY OF A COPY'S CHUNKS ARE READ AT ONCE (`MASON_COPY_PARALLEL`, 1 to 8: the load stays on Mason's
 * side, and the customer's Postgres is never overloaded): each reader is a DuckDB connection of its
 * own, so ONE backend on the source. A chunk's time is one backend's throughput — on the test server's read replica one 2 M-row
 * chunk of a table with two wide text columns took 6.1 s, of which the TID range scan was 0.6 s and the rest that
 * backend detoasting, formatting and sending at ~150 MB/s — so one reader took the 22 M-row table 72 s where the
 * extension's attached scan (about ten backends at once) took 28 s. A bounded few is the point between: about the old
 * scan's time while the source carries that many backends, never ten (docs/DESIGN.md "Chunks read N at a time").
 */
export const COPY_PARALLEL = 3;
const COPY_PARALLEL_MAX = 8;
export function copyParallelOf(env: NodeJS.ProcessEnv): number {
  const v = env.MASON_COPY_PARALLEL;
  if (v === undefined || v === "") return COPY_PARALLEL;
  const n = Number(v);
  if (!/^\d+$/.test(v.trim()) || n < 1 || n > COPY_PARALLEL_MAX) {
    throw new Error(`MASON_COPY_PARALLEL=${JSON.stringify(v)} is not a number of readers from 1 to ${COPY_PARALLEL_MAX}: each reads a first sync's chunks on a backend of the database's own, ` +
      `so set it to 1 (one at a time, the lightest on the database) up to ${COPY_PARALLEL_MAX}, or unset it for ${COPY_PARALLEL}`);
  }
  return n;
}

/** a copy begun before that cannot be continued as it stands (`copy`): started over once, said with this reason */
class StartOver extends Error {}

/** A COPY IN PROGRESS: what it was begun with (`_mason.copy_progress`, one row per table, written once in its own
 *  transaction) — the first snapshot every chunk is held to (null: a recopy, one transaction), the columns it is made
 *  with (`columnsKey`), its exact numerics' scales, its heap pages when it began — and what it has committed since
 *  (`_mason.copy_chunks`, a row per chunk, each in its chunk's transaction): the chunks' page ranges, their rows, and
 *  the source table's file they were read from (`pg_relation_filenode`, null until a chunk read it) */
interface CopyProgress {
  snapshot: string | null; columns: string; exact: Map<string, number>; filenode: number | null; pages: number; done: PageRange[]; rows: number;
}

/** WHAT A COPY'S CHUNK DID, for a test (`Sync`'s `onChunk`): read (its rows in, before its commit) or committed — its
 *  pages, the ceiling and the measured rate it was sized by (`nextChunkPages`), and once committed the seconds it took
 *  from its BEGIN to its COMMIT (what `nextRate` is fed) */
export interface ChunkEvent { source: string; first: number; end: number | null; reader: number; rows: number; phase: "read" | "committed";
  pages: number; ceiling: number; sizedBy: ChunkRate | null; seconds?: number }

/** a time as the log and `mason status` say a next attempt's: `14:05` (UTC) */
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/** How long a failed replication stream waits before it starts again: the interval, doubled for each failure in a row
 *  (an applied batch resets the count), at most 5 minutes — each start decodes the slot's WAL again on the source */
export function streamRetryDelayMs(intervalMs: number, failures: number): number {
  return Math.min(300_000, intervalMs * 2 ** Math.max(0, failures - 1));
}

/** what Mason's backends on the source are called (pg_stat_activity.application_name): the copy's readers and the polls */
export const SOURCE_APPLICATION_NAME = "mason-data";

/** libpq's keyword form of the source, for DuckDB's ATTACH (a value quoted as libpq reads it) */
export function libpqString(s: Pick<Source, "host" | "port" | "database" | "user" | "password" | "sslmode">): string {
  const v = (x: string | number): string => `'${String(x).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  return [`host=${v(s.host)}`, `port=${v(s.port)}`, `dbname=${v(s.database)}`, `user=${v(s.user)}`,
    ...(s.password ? [`password=${v(s.password)}`] : []), `sslmode=${v(s.sslmode)}`, `application_name=${v(SOURCE_APPLICATION_NAME)}`].join(" ");
}

/** a table's columns as a copy is made with them: their names and source types, in order */
const columnsKey = (columns: readonly SourceColumnInfo[]): string => JSON.stringify(columns.map((c) => {
  // what the copy holds is part of the shape: a copy made before a column's type was held as its text is read again
  const hold = holdOf(c.type, c.typeKind);
  return hold === "same" && c.domain !== true ? [c.name, c.type] : [c.name, c.type, hold, ...(c.domain === true ? ["domain"] : [])];
}));

/** `postgres_query` over the attached source: a read of Postgres's own SQL in the DuckDB transaction's snapshot */
const pq = (sql: string): string => `postgres_query(${literal(SRC)}, ${literal(sql)})`;

/**
 * A NUMERIC THE EXTENSION WOULD READ AS A DOUBLE — one with no precision, or one past DuckDB's 38 digits (a Rails
 * `decimal`, Prisma's `Decimal` numeric(65,30)) — is copied EXACTLY instead: read as its text and stored as
 * DECIMAL(38, s) when every value fits 38 digits (one aggregate over the column, in the copy's own snapshot, says). For
 * an unconstrained column s is the most decimals a value has; for a declared scale, the most its values USE (19.99 in a
 * numeric(65,30) is stored as DECIMAL(38,2): at 30 a sum past 10^8 would overflow), and Postgres's 30 are written back by
 * the wire and the rewrite (src/duck/types.ts `padDecimals`, src/duck/rewrite.ts `displayScale`). One that does not fit
 * stays a double, said in the log. A later value with more digits or decimals than s re-copies the table at its new
 * width (`WIDER`) rather than being rounded. Postgres keeps each value's own scale where an unconstrained column's
 * differ (`1` beside `1.50`); the copy answers them all with s decimals, also said.
 */
const NUMERIC_TYPE = /^numeric(?:\((\d+)(?:,\s*(\d+))?\))?$/;
const WIDER = "mason: a numeric value wider than its synced column";

/** a source numeric the extension reads as a DOUBLE: no precision, or more than DuckDB's 38 digits */
function readsAsDouble(type: string): boolean {
  const m = NUMERIC_TYPE.exec(type);
  return m !== null && (m[1] === undefined || Number(m[1]) > 38);
}

/** a DuckDB check on a numeric's text that it fits DECIMAL(38, scale): an error naming the table where it does not */
function fitsDecimal(column: string, scale: number, source: string, significant: boolean): string {
  const v = ident(column);
  // a declared scale's text has its trailing zeros (19.990000…): only the decimals a value uses must fit
  const decimals = significant ? `rtrim(regexp_extract(${v}, '\\.(\\d+)', 1), '0')` : `regexp_extract(${v}, '\\.(\\d+)', 1)`;
  return `CASE WHEN length(${decimals}) > ${scale} OR length(regexp_extract(${v}, '^-?(\\d+)', 1)) > ${38 - scale} ` +
    `OR ${v} IN ('NaN', 'Infinity', '-Infinity') THEN error(${literal(`${WIDER} [${source}]`)}) ELSE ${v} END AS ${v}`;
}

/** a numeric's text that does not fit DECIMAL(38, scale): `fitsDecimal`'s rule, for a value the stream brings */
function widerThan(text: string, scale: number, significant: boolean): boolean {
  if (text === "NaN" || text === "Infinity" || text === "-Infinity") return true;
  const m = /^-?(\d*)(?:\.(\d+))?$/.exec(text);
  if (m === null) return true;
  const decimals = significant ? (m[2] ?? "").replace(/0+$/, "") : m[2] ?? "";
  return decimals.length > scale || m[1]!.length > 38 - scale;
}

/** The DuckDB type a copied column is stored as: the extension's own, but a JSON for a json / jsonb (it reads them as text). */
/** a char(n) column (format_type's `character(n)`): the extension reads its values with the padding trimmed */
const CHAR_TYPE = /^character\((\d+)\)$/;
/** a column as it is stored: a char(n) value padded back to n, as Postgres holds it */
function storedValue(c: SourceColumnInfo): string {
  const m = CHAR_TYPE.exec(c.type);
  return m ? `rpad(${ident(c.name)}, ${m[1]}, ' ')` : ident(c.name);
}

function storedType(c: SourceColumnInfo, scanned: string): string {
  const hold = holdOf(c.type, c.typeKind);
  return hold === "text" ? "VARCHAR" : hold === "text[]" ? "VARCHAR[]" : /^jsonb?$/.test(c.type) ? "JSON" : scanned;
}

/** a DuckDB connection the sync runs statements on, and whether a long one is running on it (`interruptible`): what
 *  `stop` interrupts, each connection its own */
interface Lane { readonly conn: DuckConnection; inFlight: boolean }

/** a rebuild waiting its turn (`enqueue`): a whole copy, or the one poll that catches a table up before it is kept
 *  current again */
/** a rebuild of a copied table */
type TableRebuild = "copy" | "catch-up";
type RebuildKind = TableRebuild | "generated";
interface Rebuild { kind: RebuildKind }
/** the order the queue takes them in: a catch-up is one poll that makes a copied table current; a generated table's
 *  re-run reads what the copies hold, so it goes behind them */
const REBUILD_ORDER: readonly RebuildKind[] = ["catch-up", "copy", "generated"];

export class Sync {
  private readonly store: DuckStore;
  private readonly source: Source;
  private readonly log: (line: string) => void;
  private readonly intervalMs: number;
  private readonly mode: SyncMode;
  /** each polled table's watermark: the snapshot of the last poll that stored it */
  private readonly snapshots = new Map<string, string>();
  /** how long the last pass took: the next waits at least four times that (its polls' share of the source's time) */
  private lastPassMs = 0;
  /** each polled table's next poll (ms since the epoch: its last poll's end plus its interval, stretched to four times
   *  that poll — `nextPollDelayMs`); absent: from its last poll's time in the ledger (`dueAt`). One pass polls the
   *  tables due and the timer waits for the next one due (`nextPassDelay`), never a timer per table: a pass also
   *  queues the copies and drops removed tables, and attaches the source once for all of it — timers of their own would
   *  each attach it, and race those for the writer's turn */
  private readonly due = new Map<string, number>();
  /** each table's sync as its last poll or copy recorded it (`_mason.poll_state.sync`; null: recorded before syncs were) */
  private readonly recordedSync = new Map<string, string | null>();
  /** the tables whose sync changed since they were last polled (`setTables`): kept, and caught up by ONE poll now */
  private readonly switched = new Set<string>();
  /** how long each table's last poll took, this run (ms): its next waits four times that, and mason add estimates by it */
  private readonly lastPollMs = new Map<string, number>();
  /** each table whose copy failed: the failures in a row, and when it is tried again (`copyRetryDelayMs`) */
  private readonly retries = new Map<string, { failures: number; at: number }>();
  /** each copied table in a layout this Mason no longer keeps (`RETIRED_LAYOUT`), found at `open`: copied again */
  private readonly retired = new Map<string, Retired>();
  /** the catalog's own connection (`rebuildSchema`): it sees only what a copy or poll has committed, and is never
   *  held by a copy's statement, so a table is served the moment its copy commits */
  private catalog: DuckConnection | null = null;
  /** the catalog's rebuilds, one at a time */
  private schemaBuild: Promise<void> = Promise.resolve();
  private tables = new Map<string, AddedTable>();
  private views: PgView[] = [];
  private readonly states = new Map<string, CopyState>();
  /** each copied table's columns as its copy was made with them (`columnsKey`): a change copies it again */
  private readonly copiedAs = new Map<string, string>();
  /** THE COPY'S OWN COLUMNS, as `_mason.copy_state.columns` records them: what every write to it is shaped by (`asCopied`),
   *  never the sources file's columns of the moment nor the publication's */
  private readonly copiedColumns = new Map<string, SourceColumnInfo[]>();
  /** the pass a failed rebuild's back-off waits for (`wakeAt`): replication mode runs a pass only when kicked */
  private wake: { timer: NodeJS.Timeout; at: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private attached = false;
  private loaded = false;
  private stopped = false;
  /** REPLICATION: the publication and slot the `replication` tables are read through (`owned`: the publication is
   *  Mason's own, made and kept equal to the replicated tables; else the operator named it, and it is only read —
   *  src/duck/publication.ts), null in a run that cannot stream (the demo's); the stream while it runs, the last commit
   *  DuckDB applied */
  private readonly replication: SyncReplication | null;
  /** told when the slot is made (true) and when it is dropped, verified gone (false): the run records it, so `mason
   *  destroy` drops what was made by its own name (src/cli/dev.ts) */
  private readonly onReplication: ((made: boolean) => void) | undefined;
  /** the last moment the stream had everything the database wrote (a keepalive with nothing pending, a batch applied):
   *  a streamed table's copy is current as of then (`keptOf`'s syncedAt) */
  private streamCurrentAt: number | null = null;
  private stream: ReplicationStream | null = null;
  private appliedLsn = 0n;
  /** the slot has a row in `_mason.stream_state`: what this copy applied of it is known */
  private slotKnown = false;
  /** THE TABLES COPIED BUT NOT YET CAUGHT UP (`_mason.catch_up`, so a run that stops first catches them up at its next
   *  start), and why: left out of the polls and the stream until one poll from their watermark (`catchUp`). Each mark is
   *  an object of its own, so a catch-up clears only the mark it caught up (a slot made again meanwhile marks anew) */
  private readonly behind = new Map<string, { why: string }>();
  /** REPLICATION: the changes the stream decoded of each table being caught up, held until its catch-up poll commits
   *  and applied after it (src/duck/stream.ts "why replaying is safe") */
  private readonly held = new Map<string, TableChanges>();
  /** REPLICATION: what the stream applies, by source — the tables joined, and those held — read at each change */
  private readonly streamed = new Map<string, StreamedTable>();
  /** the last `StreamedTable.stay` given (`refreshStreamed`) */
  private lastStay = 0;
  /** a NAMED publication's gaps: each added table it does not carry, with the refusal (neither copied nor streamed) */
  private readonly unpublished = new Map<string, string>();
  /** the error each table a named publication did not carry was given (`settlePrepared`): cleared by the pass that finds
   *  it carried again, and by nothing else that pass */
  private readonly gapErrors = new Map<string, string>();
  /** a named publication that does not publish TRUNCATE has been said (once a run) */
  private truncateSaid = false;
  /** the last pass failed: in replication mode it is tried again after the interval, the stream started by it */
  private passFailed = false;
  /** a table copied again because a numeric arrived wider than its copy, this run: bounded (`startStream`) */
  private readonly widened = new Map<string, number>();
  /** each copied table's column types as DuckDB holds them (DESCRIBE), read once per copy */
  private readonly duckTypes = new Map<string, Map<string, string>>();
  /** the stream's failures in a row: each restart waits twice the one before (`streamRetryDelayMs`), until `streamAt`
   *  (a pass kicked sooner leaves it stopped) */
  private streamFailures = 0;
  private streamAt = 0;
  /** when each copy was last brought current, and how (`Synced`): seeded at `open` from the ledger, moved by every
   *  swap, poll commit and stream batch */
  private readonly synced = new Map<string, Synced>();
  /** where the sync's failures and notable events go (src/duck/events.ts `SyncEvents.record`): never the writer's turn */
  private readonly onEvent: (e: SyncEventInput) => void;
  /** when each table was last copied or polled, its `syncedAt`: `_mason.poll_state.polled_at` and nothing else — the
   *  value `pollStateSql` wrote is the one set here once its transaction commits, and `readPolledAt` only moves a time
   *  forward, so nothing moves it back (a time read at the commit stood until that read replaced it: a `syncedAt` that
   *  went backwards). A copy's is its watermark's, taken before the swap; `copied_at`, after it, is `Synced.at`'s */
  private readonly polledAt = new Map<string, string>();
  /** the store's writer: the stream's batches, the polls, the source's attachment and every swap, one turn at a time */
  private readonly writerLane: Lane;
  /** the rebuilds' own connection (`open`): a copy or a catch-up, beside the writer's work */
  private rebuilderLane: Lane | null = null;
  /** the writer's turns (`onWriter`): each job runs once every one queued before it has ended */
  private writerTurn: Promise<void> = Promise.resolve();
  /** the rebuilds waiting, by source; the one running and its loop (`drainRebuilds`) */
  private readonly queued = new Map<string, Rebuild>();
  private rebuildingNow: { source: string; kind: TableRebuild } | null = null;
  private rebuilding: Promise<void> | null = null;
  /** the source attached for this many users (a pass, a rebuild): DETACHed when the last ends (`detach`) */
  private sourceUsers = 0;
  private currentSchema: PgSchema;
  /** what the catalog last built from: replaced (a new object) only when it changes */
  private schemaKey = "";
  /** REPLICATION, WHERE THE STREAM IS (`streamStatus`, the stream's log): the changes it applied this run by table, and
   *  since its last periodic line (`reportStream`, every `streamReportMs` when something moved) */
  private readonly appliedCounts = new Map<string, ChangeCounts>();
  private readonly sinceLine = new Map<string, ChangeCounts>();
  private lineAt = Date.now();
  private readonly streamReportMs: number;
  /** about how many rows a copy's largest chunk reads (`chunkPages`, the ceiling): COPY_CHUNK_ROWS, or a test's own */
  private readonly copyChunkRows: number;
  /** how many of a copy's chunks are read at once, each on a connection of its own (`COPY_PARALLEL`) */
  private readonly copyParallel: number;
  /** how long a copy's chunk should take to read, in seconds (`COPY_CHUNK_SECONDS`, `nextChunkPages`) */
  private readonly copyChunkSeconds: number;
  /** each copy whose chunks are being read, as they are (`CopyLive`): `state` renders it at the moment it is asked */
  private readonly copyLive = new Map<string, CopyLive>();
  /** a test's: told what each chunk did (`ChunkEvent`), inside the chunk's transaction before it commits ("read") and
   *  once it has ("committed") */
  private readonly onChunk: ((e: ChunkEvent) => void | Promise<void>) | undefined;
  /** bytes free on the disk the file is on (a test's: a full disk) */
  private readonly diskFree: (dir: string) => number;
  /** the copy's readers past the rebuilds' own connection, open while it reads (`readChunks`): what `stop` interrupts too */
  private readonly copyLanes = new Set<Lane>();
  private reportTimer: NodeJS.Timeout | null = null;
  /** the last batch applied with changes: when, and when its newest transaction committed on the database (ms) */
  private lastBatch: { appliedAt: number; committedAt: number } | null = null;
  /** the tables the stream applies as they come, as `refreshStreamed` last made them: a table joining or leaving is said */
  private joinedNow = new Set<string>();
  /** why a table is about to join, said on its join line (`catchUp`) */
  private readonly joinWhy = new Map<string, string>();
  /** the table being caught up, and what its catch-up is doing */
  private catchingUp: { source: string; phase: "polling" | "applying"; startedAt: number } | null = null;
  /** the stream's last failure and when it starts again; cleared when it starts */
  private streamFailure: { error: string; retryAt: number } | null = null;
  /** A WHOLE-SYNC FAILURE NOT YET OVER, as its event said it (`table: null`): the stream stopped, over when it next applies
   *  a batch; the publication and slot could not be made ready, over when a pass makes them so; the database's attach,
   *  over when an attach succeeds. Its end is a `recovered` event of no table, which lets the next such failure be said again
   *  (src/duck/events.ts: a failure said word for word within an hour is one event unless it recovered between) */
  private readonly wholeFailure: { stream: string | null; prepare: string | null; attach: string | null } = { stream: null, prepare: null, attach: null };
  /** the database's position as last read (`databasePosition`), and the read in flight */
  private dbPosition: { lsn: bigint; at: number } | { error: string; at: number } | null = null;
  /** the slot's WAL as last read (`databasePosition`, at most every SLOT_READ_MS), and when */
  private slotWal: { wal: SlotWal; at: number } | null = null;
  private dbPositionRead: Promise<void> | null = null;
  /** THE STORED JSON PATHS (src/duck/kept.ts): every write below computes them; the plans read them */
  readonly kept: KeptJsonPaths;
  /** THE GENERATED TABLES (src/duck/generated.ts): every commit that changes a copy marks them, the rebuild queue runs them */
  readonly generated: GeneratedTables;
  /** the connection their runs read and write on (`open`), set up as a session: what `stop` interrupts */
  private generatedLane: Lane | null = null;
  /** the generated lane's session set-up: settled before each plan and run (`GeneratedHost.settle`) */
  private generatedSession: SessionSetup | null = null;
  /** the review's check's own connection and its set-up, never the run's (`GeneratedHost.checkConnection`) */
  private generatedCheck: { conn: DuckConnection; setup: SessionSetup } | null = null;

  constructor(store: DuckStore, source: Source, database: string, log: (line: string) => void, intervalMs: number, mode: SyncMode = "poll",
    replication: SyncReplication | null = null,
    options: { streamReportMs?: number; copyChunkRows?: number; copyParallel?: number; copyChunkSeconds?: number; onChunk?: (e: ChunkEvent) => void | Promise<void>; diskFree?: (dir: string) => number;
      json?: Partial<KeptOptions>; generated?: GeneratedOptions; onReplication?: (made: boolean) => void;
      /** each failure and notable event of the sync, as it happens (src/duck/events.ts): the run records them */
      onEvent?: (e: SyncEventInput) => void } = {}) {
    this.store = store; this.source = source; this.log = log; this.intervalMs = intervalMs; this.mode = mode;
    this.streamReportMs = options.streamReportMs ?? 60_000;
    this.copyChunkRows = options.copyChunkRows ?? COPY_CHUNK_ROWS;
    this.copyParallel = options.copyParallel ?? COPY_PARALLEL;
    if (!Number.isInteger(this.copyParallel) || this.copyParallel < 1 || this.copyParallel > COPY_PARALLEL_MAX) {
      throw new Error(`a first sync reads with 1 to ${COPY_PARALLEL_MAX} readers, not ${this.copyParallel} (Mason bug: report it; copyParallelOf reads MASON_COPY_PARALLEL)`);
    }
    this.copyChunkSeconds = options.copyChunkSeconds ?? COPY_CHUNK_SECONDS;
    if (!(this.copyChunkSeconds > 0)) throw new Error(`a first sync's chunk takes a positive number of seconds, not ${this.copyChunkSeconds} (Mason bug: report it; copyChunkSecondsOf reads MASON_COPY_CHUNK_SECONDS)`);
    this.onChunk = options.onChunk;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.diskFree = options.diskFree ?? freeBytesAt;
    if (mode === "replication" && replication === null) throw new Error("replication mode needs its slot and publication (Mason bug: report it)");
    this.replication = replication;
    this.onReplication = options.onReplication;
    this.currentSchema = { database, tables: [] };
    this.writerLane = { conn: store.writer, inFlight: false };
    this.kept = new KeptJsonPaths(store, {
      onWriter: (f) => this.onWriter(f),
      // every copy served, by its own columns (a table removed serves until the pass drops it)
      served: () => new Map([...this.states.values()].filter((s) => s.phase === "copied" && this.copiedColumns.has(s.source))
        .map((s) => [s.source, this.copiedColumns.get(s.source)!.map((c) => ({ name: c.name, type: c.type }))])),
      rebuilding: (source) => this.rebuildingNow?.source === source,
      log: (line) => this.log(line),
    }, { enabled: options.json?.enabled ?? true, ...options.json });
    const generatedLane = (): Lane => {
      if (this.generatedLane === null) throw new Error("the generated tables' connection is not open (Mason bug: report it)");
      return this.generatedLane;
    };
    this.generated = new GeneratedTables(store, {
      onWriter: (f) => this.onWriter(f),
      connection: () => generatedLane().conn,
      settle: async () => {
        if (this.generatedSession === null) throw new Error("the generated tables' connection is not open (Mason bug: report it)");
        await this.generatedSession.settle(NO_ROLE_SESSION);
      },
      checkConnection: () => {
        if (this.generatedCheck === null) throw new Error("the generated tables' check connection is not open (Mason bug: report it)");
        return this.generatedCheck.conn;
      },
      settleCheck: async () => {
        if (this.generatedCheck === null) throw new Error("the generated tables' check connection is not open (Mason bug: report it)");
        await this.generatedCheck.setup.settle(NO_ROLE_SESSION);
      },
      enqueue: (name) => this.enqueue(name, { kind: "generated" }),
      interruptible: (f) => this.interruptible(generatedLane(), f),
      added: (name) => this.tables.has(name) ? (this.states.get(name)?.phase === "copied" ? "copied" : "adding") : this.views.some((v) => `${v.schema ?? "public"}.${v.name}` === name) ? "view" : null,
      syncedAt: (base) => this.synced.get(base)?.at ?? null,
      rebuildCatalog: () => this.rebuildSchema(),
      schema: () => this.currentSchema,
      retryDelayMs: copyRetryDelayMs,
      stopping: (e) => e instanceof Stopping,
      log: (line) => this.log(line),
      event: (e) => this.event(e),
    }, options.generated ?? {});
  }

  /** the rebuilds' connection: open from `open` until `stop` */
  private get rebuilder(): Lane {
    if (this.rebuilderLane === null) throw new Error("the sync's rebuild connection is not open (Mason bug: report it)");
    return this.rebuilderLane;
  }

  /** an event of the sync, to its record (src/duck/events.ts), which never throws into the sync; a sink that does is
   *  said, and the sync goes on (its state and its log line hold what happened) */
  private event(e: SyncEventInput): void {
    try { this.onEvent(e); }
    catch (x) { this.log(`the sync's event (${e.kind}${e.table ? ` ${e.table}` : ""}) could not be recorded: ${x instanceof Error ? x.message : String(x)}`); }
  }

  /** a whole-sync failure (`wholeFailure`) is over: said once, as a `recovered` event of no table */
  private recovered(what: keyof Sync["wholeFailure"], words: string): void {
    const was = this.wholeFailure[what];
    if (was === null) return;
    this.wholeFailure[what] = null;
    this.event({ kind: "recovered", table: null, message: `${words} (it had failed: ${was.split("\n")[0]})` });
  }

  /** `f` on the writer's next turn: once every job queued before it has ended, so no other job's statement lands inside
   *  its transaction. A job never queues another and waits for it (it would wait for itself) */
  private onWriter<T>(f: () => Promise<T>): Promise<T> {
    const turn = this.writerTurn.then(f);
    // the next job waits for this one either way: its failure is its caller's
    this.writerTurn = turn.then(() => undefined, () => undefined);
    return turn;
  }

  async open(): Promise<void> {
    this.rebuilderLane = { conn: await this.store.instance.connect(), inFlight: false };
    await this.store.writer.run(`CREATE TABLE IF NOT EXISTS ${MASON_SCHEMA}.copy_state (source VARCHAR PRIMARY KEY, phase VARCHAR, "rows" BIGINT, bytes BIGINT, seconds DOUBLE, copied_at TIMESTAMPTZ, error VARCHAR, columns JSON)`);
    // the re-sort's count of rows written out of key order (in the earlier layout): gone with the key order
    for (const gone of ["written", "counted"]) await this.store.writer.run(`ALTER TABLE ${MASON_SCHEMA}.copy_state DROP COLUMN IF EXISTS ${gone}`);
    await this.store.writer.run(`CREATE TABLE IF NOT EXISTS ${MASON_SCHEMA}.poll_state (source VARCHAR PRIMARY KEY, snapshot VARCHAR, polled_at TIMESTAMPTZ, sync VARCHAR)`);
    // the sync each table was last polled or copied under (src/lib/table-sync.ts syncText): a change is caught up by one poll
    await this.store.writer.run(`ALTER TABLE ${MASON_SCHEMA}.poll_state ADD COLUMN IF NOT EXISTS sync VARCHAR`);
    // replication mode's record: per slot, the end of the last commit applied, in the same transaction as its rows
    await this.store.writer.run(`CREATE TABLE IF NOT EXISTS ${MASON_SCHEMA}.stream_state (slot VARCHAR PRIMARY KEY, lsn VARCHAR, applied_at TIMESTAMPTZ)`);
    // the tables copied (or under a new slot) and not yet caught up by their one poll (`behind`), written
    // with the swap and removed with the catch-up: a run that stops between catches them up at its next start
    await this.store.writer.run(`CREATE TABLE IF NOT EXISTS ${MASON_SCHEMA}.catch_up (source VARCHAR PRIMARY KEY, why VARCHAR, since TIMESTAMPTZ)`);
    // a copy in progress (`CopyProgress`): what it was begun with, and a row per chunk committed — each in that chunk's
    // transaction, so a copy that dies continues where it was. Removed with the swap. A chunk's row is APPENDED, never
    // an update of one row: several readers commit at once, and DuckDB lets transactions append to one table side by
    // side; the key refuses a chunk committed twice (a Mason bug) at its commit
    await this.store.writer.run(`CREATE TABLE IF NOT EXISTS ${MASON_SCHEMA}.copy_progress (source VARCHAR PRIMARY KEY, snapshot VARCHAR, columns VARCHAR, exact VARCHAR, ` +
      `pages BIGINT, updated_at TIMESTAMPTZ)`);
    await this.store.writer.run(`CREATE TABLE IF NOT EXISTS ${MASON_SCHEMA}.copy_chunks (source VARCHAR, first_page BIGINT, end_page BIGINT, "rows" BIGINT, filenode BIGINT, ` +
      `committed_at TIMESTAMPTZ, PRIMARY KEY (source, first_page))`);
    await this.oneReaderProgress();
    for (const [source, why] of (await this.store.writer.runAndReadAll(`SELECT source, why FROM ${MASON_SCHEMA}.catch_up`)).getRowsJS() as [string, string][]) this.behind.set(source, { why });
    if (this.replication !== null) {
      const r = (await this.store.writer.runAndReadAll(`SELECT lsn FROM ${MASON_SCHEMA}.stream_state WHERE slot = $1`, [this.replication.slot])).getRowsJS();
      this.slotKnown = r.length > 0;
      this.appliedLsn = r.length > 0 ? parseLsn(String(r[0]![0])) : 0n;
    }
    for (const [source, snapshot, sync] of (await this.store.writer.runAndReadAll(`SELECT source, snapshot, sync FROM ${MASON_SCHEMA}.poll_state`)).getRowsJS() as [string, string, string | null][]) {
      this.snapshots.set(source, snapshot);
      this.recordedSync.set(source, sync);
    }
    await this.readPolledAt();
    const r = await this.store.writer.runAndReadAll(`SELECT source, phase, "rows", bytes, seconds, epoch_ms(copied_at), error, columns::VARCHAR FROM ${MASON_SCHEMA}.copy_state`);
    for (const row of r.getRowsJS()) {
      const [source, phase, rows, bytes, seconds, copiedMs, error, columns] = row as [string, CopyPhase, bigint | null, bigint | null, number | null, number | bigint | null, string | null, string | null];
      // an instant as a run writes it (ISO, UTC), never DuckDB's text of it in the connection's zone
      const copiedAt = copiedMs === null ? null : new Date(Number(copiedMs)).toISOString();
      if (columns !== null) { const c = JSON.parse(columns) as SourceColumnInfo[]; this.copiedAs.set(source, columnsKey(c)); this.copiedColumns.set(source, c); }
      this.states.set(source, { source, phase: phase === "copying" ? "waiting" : phase, rows: rows === null ? null : Number(rows), bytes: bytes === null ? null : Number(bytes), seconds, copiedAt, error });
    }
    await this.readSynced();
    await this.findRetired();
    this.removeStageLeftovers();
    // the stored JSON paths, before the catalog serves anything: each served copy's view, what the file holds
    await this.kept.open();
    // the run's connection is a session's, set up by the one set-up (src/duck/store.ts `SessionSetup`): a plan's SQL reads it
    const conn = await this.store.instance.connect();
    this.generatedSession = await SessionSetup.open(conn, GENERATED_SESSION);
    this.generatedLane = { conn, inFlight: false };
    const checkConn = await this.store.instance.connect();
    this.generatedCheck = { conn: checkConn, setup: await SessionSetup.open(checkConn, GENERATED_SESSION) };
    await this.generated.open();
    this.catalog = await this.store.instance.connect();
    await this.rebuildSchema();
  }

  /** the tables the project adds now (its sources file): a new one is copied at the next pass unless its copy is already
   *  here and current (said as its records say it, `addedText`), a removed one dropped.
   *  What it returns is the catalog rebuilt over them (never rejected: a failure is said in the log) */
  setTables(tables: readonly AddedTable[]): Promise<void> {
    // (called at mason start and at mason add / remove only: the catalog's keys and constraints are the source's as of
    // then — docs/DESIGN.md "A count of distinct keys")
    const before = this.tables;
    this.tables = new Map(tables.map((t) => [t.source, t]));
    // said as it happens: what is added, each table as its records say it is (`addedText`), and what is no longer
    // (dropped at the next pass)
    const added = tables.filter((t) => !before.has(t.source));
    const removed = [...before.keys()].filter((s) => !this.tables.has(s));
    if (added.length) this.log(addedText(added.map((t) => this.addedStatus(t))));
    // A TABLE WHOSE SYNC CHANGED — by mason add --sync now, or by hand since its last poll (the ledger's record) — keeps
    // its copy and is caught up by ONE poll now, whatever it changed to, then kept as it says: never copied again
    for (const t of tables) {
      const now = syncText(this.syncOf(t)), prev = before.get(t.source);
      const was = prev !== undefined ? syncText(this.syncOf(prev)) : this.recordedSync.get(t.source) ?? null;
      if (was === null || was === now) continue;
      this.due.delete(t.source);
      // recopy copies every table again whatever its sync, and a table whose columns changed too is copied again with
      // them, its new sync recorded at that copy's swap
      const copied = this.states.get(t.source)?.phase === "copied" && this.snapshots.has(t.source) && this.copiedAs.get(t.source) === columnsKey(t.columns);
      if (this.mode === "recopy" || !copied) continue;
      if (this.replicated(t)) {
        // INTO THE STREAM (poll or off → replication): caught up by ONE poll with the stream's changes of it held from
        // just before that poll (`catchUp`), as a slot new to the copy is — once the pass has the publication carry it
        // (`prepareReplication` runs before the pass queues the catch-up). Marked in `_mason.catch_up`, on the writer's
        // turn and so before the catch-up starts: the stream acknowledges what it holds, so a run that dies between
        // the catch-up's poll and the held changes' apply must catch it up again (its recorded sync is already the new)
        this.switched.delete(t.source);
        const why = `after its sync changed from ${was}`;
        if (!this.behind.has(t.source)) {
          const mark = { why };
          this.behind.set(t.source, mark);
          void this.onWriter(() => this.store.writer.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.catch_up VALUES (${literal(t.source)}, ${literal(why)}, now())`)).catch((e: unknown) => {
            // its next start catches it up again only by this row: said, and the mark kept for this run's own catch-up
            this.log(`${t.source}: its catch-up could not be recorded (a stop before it ends catches it up again only if its sync changes): ${e instanceof Error ? e.message : String(e)}`);
          });
        }
      } else {
        // OUT OF THE STREAM, or between off and poll: it leaves the stream at its next batch (`refreshStreamed`) and the
        // next pass polls it from its watermark, which every change since is at or past
        this.switched.add(t.source);
      }
      // said, and recorded as the sync's event (src/duck/events.ts): what a table's sync was is history the log alone loses
      const switched = `sync: ${was} → ${now}: its synced data is kept, and caught up by one poll now${this.replicated(t) ? ", then streamed" : ""}`;
      this.log(`${t.source}: ${switched}`);
      this.event({ kind: "sync_changed", table: t.source, message: switched });
    }
    // loud: the copy goes with the table's entry, and comes back only by reading the source again (the test server: a 53 GB
    // copy, 21 minutes of a production replica, dropped by a project file moved aside)
    if (removed.length) this.log(`removed ${removed.join(", ")}: no longer added, so ${removed.length === 1 ? "its synced data is" : "their synced data is"} DROPPED at the next pass — mason add syncs ${removed.length === 1 ? "it" : "them"} again from the source, whole`);
    for (const t of tables) if (!this.states.has(t.source)) this.states.set(t.source, { source: t.source, phase: "waiting", rows: null, bytes: t.bytes, seconds: null, copiedAt: null, error: null });
    // a failed copy whose table changed (its columns or key) is tried at once: the change may be its fix
    const shape = (t: AddedTable): string => JSON.stringify([columnsKey(t.columns), t.key]);
    for (const t of tables) { const b = before.get(t.source); if (b !== undefined && shape(b) !== shape(t)) this.retries.delete(t.source); }
    // the tables copied before are served at once, not after this start's first pass (its copies may take hours)
    const built = this.rebuildSchema().catch((e: unknown) => this.log(`the catalog could not be rebuilt (it is at the next pass): ${e instanceof Error ? e.message : String(e)}`));
    this.kick();
    return built;
  }

  /** an added table as the sync's records say it is, before the pass that acts on it (`addedText`): `needsCopy`'s reasons
   *  first, in `notStreamedReason`'s words, then a catch-up still owed (`behind`; in replication mode every copy is owed
   *  one under a slot this copy has no record of, `prepareReplication`), then a table the polls leave out */
  private addedStatus(t: AddedTable): AddedTableStatus {
    const st = this.states.get(t.source);
    const firstLine = (s: string | null): string => (s ?? "mason logs says why").split("\n")[0]!;
    // a named publication's gap is said again by the pass, which refuses the table by name until its owner adds it
    if (st?.error?.startsWith("replication: ")) return { source: t.source, refused: firstLine(st.error.slice("replication: ".length)) };
    const copy = st === undefined ? "never synced"
      : st.phase === "failed" ? `its first sync failed: ${firstLine(st.error)}`
      : st.phase !== "copied" ? "its first sync has not finished"
      : this.retired.has(t.source) ? `it is ${this.retired.get(t.source)!.short}`
      : this.readAgainWhy(t);
    if (copy !== null) return { source: t.source, copy };
    const b = this.behind.get(t.source);
    if (b !== undefined) return { source: t.source, behind: b.why };
    if (this.replicated(t) && this.replication !== null && !this.slotKnown) return { source: t.source, behind: `slot ${this.replication.slot} is new to the synced data` };
    const off = this.mode !== "recopy" && this.syncOf(t).mode === "off";
    return { source: t.source, kept: this.keptWords(t), off };
  }

  /** how a copy that is current is kept so, in this run's mode and by its sync: the start line's words (`addedText`) */
  private keptWords(t: AddedTable): string {
    const every = `${Number((this.intervalMs / 1000).toFixed(1))} s`;
    const s = this.syncOf(t);
    return this.mode === "recopy" ? `read again whole every ${every}`
      : s.mode === "replication" ? `streamed from ${formatLsn(this.appliedLsn)}`
      : s.mode === "off" ? `sync: off (read again only by mason sync ${t.source})` : syncWords(s);
  }

  /** how a table is kept current, as the sources file says (`AddedTable.sync`); a table with none — a test's — polled at
   *  the sync's own interval */
  private syncOf(t: AddedTable): TableSync {
    if (t.sync !== undefined) return t.sync;
    return this.mode === "replication" ? { mode: "replication" } : { mode: "poll", every: intervalOf(this.intervalMs / 1000), seconds: this.intervalMs / 1000 };
  }

  /** a table the stream keeps current: its sync is `replication` (never in a run that copies every table again whole) */
  private replicated(t: AddedTable): boolean {
    return this.mode !== "recopy" && this.syncOf(t).mode === "replication";
  }

  /** the added tables the stream keeps current, in the project's order */
  private replicatedTables(): AddedTable[] {
    return [...this.tables.values()].filter((t) => this.replicated(t));
  }

  /** THE RUN STREAMS NOW: a table's sync is `replication` (the slot is made, or kept, and the stream runs) */
  streams(): boolean {
    return this.replication !== null && this.replicatedTables().length > 0;
  }

  /**
   * WHEN A TABLE'S NEXT POLL IS DUE (ms since the epoch), or null when none is: a table whose sync changed at once
   * (`switched`), unless a failed attempt set its next; an `off` one never; a polled one at `due`, else its last poll's
   * time in the ledger plus its interval (a restart does not poll a table before its interval), else now.
   */
  private dueAt(t: AddedTable): number | null {
    const s = this.syncOf(t), d = this.due.get(t.source);
    if (s.mode !== "poll" && !this.switched.has(t.source)) return null;
    if (d !== undefined) return d;
    if (this.switched.has(t.source) || s.mode !== "poll") return 0;
    const at = this.polledAt.get(t.source);
    return at === undefined ? 0 : Date.parse(at) + s.seconds * 1000;
  }

  /** a table polled (by a pass, `mason sync` or its catch-up) in `ms`: its next poll after its interval, stretched to four
   *  times that poll (`nextPollDelayMs`), and its sync now the one recorded (the poll wrote it, `poll`) */
  private polledNow(t: AddedTable, ms: number): void {
    const s = this.syncOf(t);
    this.switched.delete(t.source);
    this.lastPollMs.set(t.source, ms);
    this.recordedSync.set(t.source, syncText(s));
    if (s.mode === "poll") this.due.set(t.source, nextPollAt(Date.now(), s.seconds, ms));
    else this.due.delete(t.source);
  }

  /**
   * WHAT THIS RUN MEASURED OF A TABLE, for `mason add`'s estimate of what polling it costs the database
   * (src/cli/source-edit.ts pollCost): its last poll's time, and ONE reader's rate at its copy — the copy reading now,
   * else the last copy's rows over its time and its readers. Null when nothing of it is measured.
   */
  measured(source: string): { lastPollMs: number | null; copyRowsPerSecond: number | null } | null {
    const st = this.states.get(source);
    const live = this.copyLive.get(source)?.rate?.rowsPerSecond ?? null;
    const copied = st?.phase === "copied" && st.rows && st.seconds ? st.rows / st.seconds / this.copyParallel : null;
    const last = this.lastPollMs.get(source) ?? null;
    return last === null && live === null && copied === null ? null : { lastPollMs: last, copyRowsPerSecond: live ?? copied };
  }

  /**
   * HOW LONG UNTIL THE NEXT PASS, in poll mode (null: none until something kicks one — every table `off`, or nothing
   * copied yet): a pass that failed, or a table waiting for a copy nothing queued, after the sync's interval; else when
   * the first polled table is due — and at least four times the last pass took, so the passes' polls together never
   * take more than a fifth of the source's time. `recopy` copies every table again every interval, stretched the same.
   */
  private nextPassDelay(): number | null {
    if (this.passFailed || this.waiting()) return this.intervalMs;
    if (this.mode === "recopy") return nextPollDelayMs(this.intervalMs, this.lastPassMs);
    // a table copying, queued, or owed its catch-up is not polled by a pass (its catch-up polls it, then `rearm`): counted
    // as due it would run a pass every few ms that polls nothing and attaches the source each time
    const dues = [...this.tables.values()].filter((t) => this.pollable(t)).flatMap((t) => this.dueAt(t) ?? []);
    return dues.length ? passDelayMs(Math.min(...dues), Date.now(), this.lastPassMs) : null;
  }

  /** a table a pass would poll now if it were due: copied, not queued or rebuilt, and not owed its catch-up */
  private pollable(t: AddedTable): boolean {
    return !this.needsCopy(t) && !this.behind.has(t.source) && !this.queued.has(t.source) && this.rebuildingNow?.source !== t.source;
  }

  /** the source's views (src/cli/preflight.ts VIEWS_SQL), served over the copied tables: in the catalog from the next
   *  pass. A view over a table that is not copied is left out of it (said in the catalog's log) */
  setViews(views: readonly SourceView[]): void {
    this.views = views.map((v) => ({ schema: v.schema, name: v.name, definition: v.definition, ...(v.comment ? { description: v.comment } : {}) }));
  }

  /** every table read again from the start: the database was restored to another server (src/cli/dev.ts sourceMove) */
  async rereadAll(): Promise<void> {
    // from watermark 0 every row is read and written again; the count check deletes what the new server lacks
    await this.onWriter(() => this.store.writer.run(`UPDATE ${MASON_SCHEMA}.poll_state SET snapshot = '0:0:'`));
    for (const s of this.snapshots.keys()) this.snapshots.set(s, "0:0:");
  }

  state(): CopyState[] {
    const now = Date.now();
    // in the project's order, whatever order the copies ran and were recorded in (`copyOrder`)
    return [...this.tables.keys()].flatMap((source) => this.states.get(source) ?? [])
      .map((s) => { const r = this.retired.get(s.source); return r !== undefined ? { ...s, retired: r.layout } : s; })
      // a copy's chunks as they are NOW: the rows the ones in flight have read by now at the measured rate
      .map((s) => { const l = this.copyLive.get(s.source); return s.phase === "copying" && l !== undefined ? { ...s, progress: copyProgressNow(l, Date.now()) } : s; })
      // how it is kept current, and a table the passes leave as copied, from ONE derivation (`keptOf`)
      .map((s) => {
        const t = this.tables.get(s.source);
        if (t === undefined) return s;
        const kept = this.keptOf(t, now);
        return { ...s, kept };
      })
      // when it was last brought current, whether it waits for its catch-up, and whether it is being rebuilt now
      .map((s) => {
        const synced = this.synced.get(s.source), behind = this.behind.get(s.source)?.why;
        const rebuilding = this.rebuildingNow?.source === s.source ? this.rebuildingNow.kind : undefined;
        return { ...s, ...(synced ? { synced } : {}), ...(behind !== undefined ? { behind } : {}), ...(rebuilding ? { rebuilding } : {}) };
      });
  }

  /**
   * HOW AN ADDED TABLE IS KEPT CURRENT, NOW (`KeptCurrent`): the run's mode, then in replication mode its part in the
   * stream (`streamTable`, what `streamStatus` says of it) and where the stream is; in poll mode its sync, its last copy
   * or poll and its next. The one place it is derived: `state` carries it to `mason status` and the listener's EXPLAIN
   * alike.
   */
  private keptOf(t: AddedTable, now: number): KeptCurrent {
    const st = this.states.get(t.source);
    const sync = this.syncOf(t);
    if (this.mode !== "recopy" && sync.mode !== "replication") {
      const polledAt = this.polledAt.get(t.source) ?? null;
      // a copy the passes do not keep current now, and why, from what a poll of it asks (`pollable`): not copied (waiting,
      // being copied, its copy failed: `needsCopy` holds for every phase but copied), to be copied again (its columns
      // changed, a numeric outgrew it, a retired layout), caught up first, or its rebuild not ended yet: the moment this
      // says nothing is pending, `mason sync` of it runs
      const pending = this.pollable(t) ? null : this.notStreamedWhy(t.source);
      const next = pending === null ? this.dueAt(t) : null;
      return { by: "poll", sync, syncedAt: polledAt, nextAt: next === null ? null : new Date(Math.max(next, now)).toISOString(), ...(pending !== null ? { pending } : {}) };
    }
    // copied again whole every pass, whatever its watermark: only a table not copied now (waiting, being copied, its copy
    // failed) is not kept current
    if (this.mode === "recopy") return { by: "recopy", copiedAt: st?.copiedAt ?? null, ...(st?.phase !== "copied" ? { pending: this.notStreamedWhy(t.source) } : {}) };
    const s = this.stream;
    const part = this.streamTable(t, now, s);
    // current as of its last copy or poll, or — streamed — the last moment the stream had all the database wrote
    const polled = this.polledAt.get(t.source) ?? null;
    const streamed = part.state === "streamed" && this.streamCurrentAt !== null ? new Date(this.streamCurrentAt).toISOString() : null;
    const syncedAt = streamed !== null && (polled === null || streamed > polled) ? streamed : polled;
    return { by: "replication", slot: this.replication?.slot ?? "", state: part.state, why: part.why, position: formatLsn(s?.position() ?? this.appliedLsn),
      lastCommit: this.lastBatch === null ? null : new Date(this.lastBatch.committedAt).toISOString(), notRunning: this.streamDownWhy(s, st), syncedAt };
  }

  /** why the stream is not running, in the reader's words (null: it runs): its last failure and when it starts again; the
   *  replication check a pass failed (`prepareReplication`, recorded on each copy's state); a slot not made yet; a sync
   *  stopping; else it starts at the next pass */
  private streamDownWhy(s: ReplicationStream | null, st: CopyState | undefined): string | null {
    if (s !== null) return null;
    const firstLine = (e: string): string => e.replace(/^replication: /, "").split("\n")[0]!;
    if (this.streamFailure !== null) return `${firstLine(this.streamFailure.error)} · it starts again after ${clock(this.streamFailure.retryAt)} UTC`;
    if (st?.error?.startsWith("replication: ")) return firstLine(st.error);
    if (this.replication === null) return "this run reads no slot, so nothing streams it (the demo database has no change log): give its entry sync: poll <interval>";
    if (!this.slotKnown) return `slot ${this.replication.slot} is not made yet: it starts once it is`;
    if (this.stopped) return "Mason is stopping";
    return "it has not started yet: it starts at the next pass";
  }

  /** an added table's part in the stream (`StreamTableStatus` but what it applied): streamed, being caught up, waiting
   *  for its copy, or left out of the publication, and why — what `streamStatus` and `keptOf` both say, each of the
   *  stream `s` it read once */
  private streamTable(t: AddedTable, now: number, s: ReplicationStream | null): Omit<StreamTableStatus, "table" | "applied"> {
    const iso = (ms: number): string => new Date(ms).toISOString();
    if (this.unpublished.has(t.source)) return { state: "left-out", why: this.notStreamedWhy(t.source) };
    const b = this.behind.get(t.source);
    if (!this.needsCopy(t) && b !== undefined) {
      const c = this.catchingUp?.source === t.source ? this.catchingUp : null;
      const held = this.held.get(t.source)?.counts;
      const at = this.retries.get(t.source)?.at ?? 0;
      return { state: "catching-up", why: `caught up by one poll ${b.why}${at > now ? ` — its last catch-up failed, tried again after ${clock(at)} UTC` : ""}`,
        catchUp: { phase: c?.phase ?? "queued", from: this.polledAt.get(t.source) ?? null, startedAt: c ? iso(c.startedAt) : null, held: held ? held.inserts + held.updates + held.deletes + held.truncates : 0,
          retryAt: c === null && at > now ? iso(at) : null } };
    }
    if (this.joinedNow.has(t.source) || (s === null && !this.needsCopy(t))) return { state: "streamed", why: null };
    return { state: "waiting", why: this.notStreamedWhy(t.source) };
  }

  /**
   * Each table's last copy or poll, from the ledger (a copy writes its watermark there too), ONLY EVER FORWARD: this
   * SELECT's snapshot may be older than a commit on the rebuilds' connection whose time is set while it is answered
   * (`committed`, `swap`), so what it read never replaces a later time, and a table it does not hold is dropped (removed:
   * nothing else drops it) only when no such commit gave it a time meanwhile.
   */
  private async readPolledAt(): Promise<void> {
    const asked = new Map(this.polledAt);
    const r = await this.store.writer.runAndReadAll(`SELECT source, epoch_ms(polled_at) FROM ${MASON_SCHEMA}.poll_state WHERE polled_at IS NOT NULL`);
    const ledger = new Map((r.getRowsJS() as [string, number | bigint][]).map(([source, ms]) => [source, new Date(Number(ms)).toISOString()]));
    for (const [source, at] of this.polledAt) if (!ledger.has(source) && at === asked.get(source)) this.polledAt.delete(source);
    for (const [source, at] of ledger) {
      const now = this.polledAt.get(source);
      if (now === undefined || at > now) this.polledAt.set(source, at);
    }
  }
  /**
   * EACH COPY'S LAST SYNC AS THE LEDGER KEEPS IT, at a start (`Synced`): the swap and every poll write
   * `poll_state.polled_at` in their own transaction, and a copy's `copied_at` is recorded right after its swap — so a
   * copy recorded at or after its table's `polled_at` was last brought current by that copy (its time the copy's
   * `seconds`), else by a poll (its time unknown: null). In replication mode the stream's last batch
   * (`stream_state.applied_at`) is newer for a table it streamed; a table not caught up is left at its copy, and one the
   * named publication does not carry (`unpublished`: never streamed, so the stream's time is not its own) at its copy
   * or poll. `only`: those tables alone, read again (the pass that found them out of the publication), the others'
   * last sync kept as it is.
   */
  private async readSynced(only?: ReadonlySet<string>): Promise<void> {
    const r = await this.store.writer.runAndReadAll(`SELECT p.source, epoch_ms(p.polled_at), epoch_ms(c.copied_at), c.seconds FROM ${MASON_SCHEMA}.poll_state p ` +
      `LEFT JOIN ${MASON_SCHEMA}.copy_state c USING (source) WHERE p.polled_at IS NOT NULL`);
    const streamed = this.replication === null ? [] : (await this.store.writer.runAndReadAll(`SELECT epoch_ms(applied_at) FROM ${MASON_SCHEMA}.stream_state ` +
      `WHERE slot = $1 AND applied_at IS NOT NULL`, [this.replication.slot])).getRowsJS();
    const streamMs = streamed.length ? Number(streamed[0]![0]) : null;
    if (only === undefined) this.synced.clear();
    for (const [source, polled, copied, seconds] of r.getRowsJS() as Array<[string, bigint | number, bigint | number | null, number | null]>) {
      if (only !== undefined && !only.has(source)) continue;
      const at = Number(polled);
      const s: Synced = copied !== null && Number(copied) >= at ? { at: new Date(Number(copied)).toISOString(), seconds, by: "copy" }
        : { at: new Date(at).toISOString(), seconds: null, by: "poll" };
      const streamedIt = !this.behind.has(source) && !this.unpublished.has(source);
      this.synced.set(source, streamMs !== null && streamMs > Date.parse(s.at) && streamedIt ? { at: new Date(streamMs).toISOString(), seconds: null, by: "stream" } : s);
    }
  }
  schema(): PgSchema { return this.currentSchema; }

  start(): void { this.kick(); }

  /** a pass now (or right after the one running) */
  kick(): void {
    if (this.stopped) return;
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.running !== null) { void this.running.then(() => this.kick()); return; }
    this.running = this.pass().then(() => { this.passFailed = false; }, (e: unknown) => {
      this.passFailed = true;
      this.log(`sync pass failed: ${e instanceof Error ? e.message : String(e)}`);
    }).finally(() => {
      this.running = null;
      if (this.stopped) return;
      // when the next polled table is due (`nextPassDelay`) — the stream keeps a replicated table current between passes,
      // and a pass runs for it when the tables change — or after the interval, when it failed or a table waits for a copy
      // or catch-up nothing has queued (a copy that failed waits its turn, `copyRetryDelayMs`)
      const d = this.nextPassDelay();
      if (d !== null) this.timer = setTimeout(() => this.kick(), d);
    });
  }

  /** an added table needs a copy or a catch-up that is neither queued nor running: a later pass must queue it */
  private waiting(): boolean {
    const busy = (s: string): boolean => this.queued.has(s) || this.rebuildingNow?.source === s;
    // a table a named publication does not carry waits for its owner, never for the interval (prepareReplication)
    // a table waiting out a failure's back-off is `wakeAt`'s, never a pass every interval (each one reads the source)
    const backingOff = (s: string): boolean => (this.retries.get(s)?.at ?? 0) > Date.now();
    return [...this.tables.values()].some((t) => !busy(t.source) && !backingOff(t.source) && !this.unpublished.has(t.source) && (this.needsCopy(t) || this.behind.has(t.source)));
  }

  /**
   * A FAILED COPY, CATCH-UP OR REFUSED STREAM OF A TABLE WAITS before its next attempt (`copyRetryDelayMs`: four times the
   * attempt, at least 5 minutes, doubled per failure in a row, at most 6 hours — at once after a restart or a column/key
   * change, `setTables`), and a pass is kicked then (`wakeAt`). Answers the next attempt's words for its log line and
   * `mason status`.
   */
  private backOff(source: string, attemptMs: number): string {
    const failures = (this.retries.get(source)?.failures ?? 0) + 1;
    const at = Date.now() + copyRetryDelayMs(failures, attemptMs);
    this.retries.set(source, { failures, at });
    this.wakeAt(at);
    return `${clock(at)} UTC (failure ${failures} in a row), or at once when Mason starts again or its columns or key change`;
  }

  /** a pass at `at` (the earliest asked for wins): in replication mode nothing else runs one when a back-off ends */
  private wakeAt(at: number): void {
    if (this.stopped || (this.wake !== null && this.wake.at <= at)) return;
    if (this.wake !== null) clearTimeout(this.wake.timer);
    const timer = setTimeout(() => { this.wake = null; this.kick(); }, Math.max(0, at - Date.now()));
    this.wake = { timer, at };
  }

  /**
   * AFTER EVERY REBUILD, ITS TABLE'S NEXT STEP: a table that still needs a copy (its columns changed while it was copied, or
   * its copy failed) or a catch-up (its catch-up failed, a slot was made again) gets a pass now — never left for one that
   * may not come: in replication mode a pass runs only when kicked, and a change of its columns that arrived while the table was
   * rebuilt kicked one that passed it over (the test server: a failed catch-up left a 22 M-row table neither streamed
   * nor copied, for good). A pass, not a copy queued here: it re-points Mason's own publication at the added columns
   * first. One backing off waits for its time (`backOff`).
   */
  private followUp(source: string): void {
    const t = this.tables.get(source);
    if (t === undefined || this.stopped || this.unpublished.has(source)) return;
    // copied and caught up: polled from now on, so the next pass is timed again (`rearm`)
    if (!this.needsCopy(t) && !this.behind.has(source)) { this.rearm(); return; }
    const at = this.retries.get(source)?.at ?? 0;
    if (at > Date.now()) this.wakeAt(at);
    else this.kick();
  }

  /**
   * THE NEXT PASS TIMED AGAIN, in poll mode, once a table is copied and caught up: a pass that ended while every table
   * still copied found none due (`nextPassDelay` skips a table that needs its copy) and set no timer, so without this a
   * table's polls never began. A pass running sets its own when it ends, from the state then.
   */
  private rearm(): void {
    if (this.stopped || this.running !== null) return;
    const d = this.nextPassDelay();
    if (d === null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.kick(), d);
  }

  /** one pass, now, every polled table taken as due (an `off` one is not: it is polled only when asked), and its end
   *  awaited (the one running first, if any), and the copies and catch-ups it queued: what a test waits on */
  async once(): Promise<void> {
    while (this.running !== null) await this.running;
    for (const t of this.tables.values()) if (this.syncOf(t).mode === "poll") this.due.set(t.source, 0);
    this.kick();
    if (this.running !== null) await this.running;
    while (this.rebuilding !== null) await this.rebuilding;
  }

  /**
   * A POLL OF EXACTLY THESE TABLES, NOW, whatever their sync says (`mason sync`: an `off` table is read again only so):
   * a pass of its own, queued behind the one running, in one source snapshot as every poll is; a polled table's next
   * poll waits its interval from this one. A replicated table is not polled: its answer is where the stream is
   * (`streamed`), beside the polled ones'. Refused by name (`PollRefused`) for a table not added or not copied yet, and in a run that copies
   * every table again whole. Its failure is its caller's to say: the copies serve as they were, and the passes go on.
   */
  async pollNow(sources: readonly string[]): Promise<{ at: string; tables: PolledTable[]; streamed?: StreamedAnswer[] }> {
    if (this.mode === "recopy") throw new PollRefused("refused", "this run reads every table again whole at each pass (MASON_DUCK_SYNC=recopy), so there is nothing to poll");
    const tables = sources.map((s) => {
      const t = this.tables.get(s);
      if (t === undefined) throw new PollRefused("not_found", `${s} is not added (mason add adds it)${didYouMean(s, [...this.tables.keys()])}`);
      return t;
    });
    // a replicated table: the stream keeps it current, so nothing to poll — its answer is where the stream is, and its part
    const said = (): StreamedAnswer[] => {
      const now = Date.now(), position = formatLsn(this.stream?.position() ?? this.appliedLsn);
      return tables.filter((t) => this.replicated(t)).map((t) => { const p = this.streamTable(t, now, this.stream); return { table: t.source, position, state: p.state, why: p.why }; });
    };
    const polled = tables.filter((t) => !this.replicated(t));
    if (polled.length === 0) return { at: new Date().toISOString(), tables: [], streamed: said() };
    while (this.running !== null) await this.running;
    if (this.stopped) throw new Stopping();
    // asked after the pass ahead of it: that pass may have copied it, or failed its copy
    for (const t of polled) {
      const st = this.states.get(t.source);
      if (st?.phase !== "copied") throw new PollRefused("nothing_yet", `${t.source} is not synced yet (${st?.phase === "failed" ? `its first sync failed: ${st.error ?? "mason logs says why"}` : "its first sync has not finished"}): mason wait waits for it`);
      const again = this.readAgainWhy(t);
      if (again !== null) throw new PollRefused("nothing_yet", `${t.source} is being read again whole (${again}): mason wait waits for it`);
      const r = this.retired.get(t.source);
      if (r !== undefined) throw new PollRefused("nothing_yet", `${t.source} is ${r.layout} (its synced data serves as it was): it is current once read again — mason wait waits for it`);
      this.refuseRebuilding(t);
    }
    const poll = (async (): Promise<PolledTable[]> => {
      await this.onWriter(() => this.attach());
      try {
        // a transaction per table, as the passes poll; a table whose rebuild started since it was asked is refused
        const found: PolledTable[] = [];
        for (const t of polled) {
          const f = await this.onWriter(async () => { this.refuseRebuilding(t); return this.poll(this.writerLane, [t]); });
          for (const x of f) this.polledNow(t, x.ms);
          found.push(...f);
        }
        return found;
      } finally { await this.onWriter(async () => { await this.detach(); await this.readPolledAt(); }); }
    })();
    // the pass slot is held until it ends (kick and once queue behind it); its failure reaches the caller through `poll`
    // and the next pass timed again as a pass's end times it (`rearm`): a copy that ended meanwhile found the slot held,
    // and a polled table's next poll moved past the timer set before
    this.running = poll.then(() => undefined, () => undefined).finally(() => { this.running = null; this.rearm(); });
    const found = await poll;
    // A SYNC BY HAND IS AN EVENT (src/duck/events.ts `synced`), in the words mason sync and the page's Sync now say:
    // a scheduled poll that succeeds records nothing (one every few seconds would bury the failures), so without it a
    // person who synced and then read the events found only an older copy, and read it as a sync lost. A replicated
    // table asked for is answered with the stream's position and records none: nothing was read for it
    for (const x of found) this.event({ kind: "synced", table: x.table, message: `synced by hand: ${syncedText(x)}` });
    const missing = polled.filter((t) => !found.some((f) => f.table === t.source));
    if (missing.length) throw new Error(`${missing.map((t) => t.source).join(", ")} has a numeric value wider than its synced DECIMAL column: it is read again whole at the next pass, and current once read`);
    const streamed = said();
    return { at: new Date().toISOString(), tables: found, ...(streamed.length ? { streamed } : {}) };
  }

  /**
   * The sync stopped: no pass starts, and the one running ends at once — its long statement (a copy's scan, a poll's
   * reads; `interruptible`) interrupted, rolled back and said as stopped, never failed (`mason
   * stop` waited for a 30 GB table's sort). DuckDB loses an interrupt that arrives before its statement has started
   * (measured: the statement ran to its end), so it is sent again every 50 ms until the pass has ended.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.wake !== null) { clearTimeout(this.wake.timer); this.wake = null; }
    if (this.reportTimer !== null) { clearInterval(this.reportTimer); this.reportTimer = null; }
    // the stream, the pass and the rebuild end together: a batch waiting for the writer's turn behind a poll must not
    // wait for that poll, so each connection's long statement is interrupted from the start
    const interrupt = (): void => { for (const lane of [this.writerLane, this.rebuilderLane, this.generatedLane, ...this.copyLanes]) if (lane?.inFlight) lane.conn.interrupt(); };
    const again = setInterval(interrupt, 50);
    interrupt();
    try {
      // none of them rejects: each says its own failure
      await Promise.all([this.stream?.stop(), this.running, this.rebuilding, this.kept.stop(), this.generated.stop()]);
      await this.writerTurn;
    } finally { clearInterval(again); }
    this.stream = null;
    // the last catalog rebuild ended, either way, before its connection closes: a failure of it is said by its caller
    await new Promise<void>((done) => { this.schemaBuild.then(done, done); });
    this.catalog?.closeSync();
    this.catalog = null;
    this.rebuilderLane?.conn.closeSync();
    this.rebuilderLane = null;
    this.generatedLane?.conn.closeSync();
    this.generatedLane = null;
    this.generatedSession = null;
    // after `generated.stop`, which waited for the review and so for any check on it
    this.generatedCheck?.conn.closeSync();
    this.generatedCheck = null;
  }

  /** a poll asked of a table while it is rebuilt or not yet caught up: refused, by name (it is caught up when that ends) */
  private refuseRebuilding(t: AddedTable): void {
    const now = this.rebuildingNow?.source === t.source ? this.rebuildingNow.kind : null;
    if (now === null && !this.behind.has(t.source)) return;
    const doing = now === "copy" ? "being read again whole" : `being caught up by one poll ${this.behind.get(t.source)?.why ?? ""}`.trimEnd();
    throw new PollRefused("nothing_yet", `${t.source} is ${doing} (its synced data serves as it was): it is caught up by one poll when that ends, so there is nothing to poll — mason wait waits for it`);
  }

  /** the source's connection, as the sync's own reads and replication make it (never DuckDB's: that is `attach`) */
  private pgOptions(): PgConnectOptions {
    const s = this.source;
    return { host: s.host, port: s.port, database: s.database, user: s.user, password: s.password, sslmode: s.sslmode, applicationName: "mason-data", connectTimeoutMs: 10_000 };
  }

  /** an added table with no copy to keep current (never copied, or to be copied again: its columns changed, a numeric
   *  outgrew its copy, or its copy is in a retired layout, `RETIRED_LAYOUT`). A table a named publication does not carry (`unpublished`) needs one too, but waits for
   *  its owner, never for the interval: its callers skip it */
  private needsCopy(t: AddedTable): boolean {
    return this.states.get(t.source)?.phase !== "copied" || !this.snapshots.has(t.source) || this.copiedAs.get(t.source) !== columnsKey(t.columns) || this.retired.has(t.source);
  }

  /**
   * THE TABLE AS ITS COPY HOLDS IT: its columns the copy's own (`copiedColumns`), the rest the added table's. Every write to a
   * copy — a stream batch, the changes held during a catch-up, an unchanged-TOAST update, a delete by key, a catch-up poll
   * — is shaped by it, never by the added columns of the moment (which change while a copy runs, as on the test server)
   * nor by what pgoutput's relation carries. A table not copied yet is as it is added.
   */
  private asCopied(t: AddedTable): AddedTable {
    const columns = this.copiedColumns.get(t.source);
    return columns === undefined ? t : { ...t, columns };
  }

  /**
   * REPLICATION, BEFORE A PASS COPIES: the publication carries every replicated table, and the slot exists — so a table
   * copied now has its changes in the stream from before it joins (src/duck/stream.ts "why replaying is safe"). A slot
   * made now, or one this copy has no record of, carries nothing from before it: the tables already copied are caught
   * up by one poll each before the stream applies their changes (`behind`, recorded with the slot in one transaction).
   * A slot Postgres invalidated (`wal_status = lost`, past `max_slot_wal_keep_size`) lost changes: it is dropped and
   * made again, and the copies are caught up the same way.
   */
  private async prepareReplication(): Promise<void> {
    const r = this.replication!;
    const tables = this.replicatedTables();
    const pg = await PgConnection.connect(this.pgOptions());
    try {
      const identities = new Map((await pg.query(`SELECT n.nspname || '.' || c.relname, c.relreplident FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
        `WHERE n.nspname || '.' || c.relname IN (${tables.map((t) => pgLiteral(t.source)).join(", ")})`)).rows.map((x) => [x[0]!, x[1]!] as const));
      // a table that identifies no row would make the app's own UPDATEs and DELETEs on it fail once a publication of
      // updates carries it: never added
      const nothing = tables.filter((t) => identities.get(t.source) === "n").map((t) => t.source);
      if (nothing.length) {
        throw new Error(`${nothing.join(", ")} ${nothing.length === 1 ? "has" : "have"} REPLICA IDENTITY NOTHING: a publication carrying ${nothing.length === 1 ? "it" : "them"} ` +
          `would make the app's own UPDATEs and DELETEs fail, so Mason does not replicate ${nothing.length === 1 ? "it" : "them"}. Give ${nothing.length === 1 ? "its entry" : "their entries"} ` +
          `sync: poll <interval> (poll 5m) in the sources file, or ALTER TABLE … REPLICA IDENTITY DEFAULT on the database`);
      }
      if (r.owned) await this.ensurePublication(pg, tables, identities);
      else await this.verifyPublication(pg, tables, identities);
      const slot = await readSlot(pg, r.slot);
      let made = false;
      if (slot.exists && slot.walStatus === "lost") {
        this.log(`replication slot ${r.slot} was invalidated by the database (wal_status lost: it held more WAL than max_slot_wal_keep_size), so changes are missing from it: made again, and the synced tables caught up by one poll`);
        if (slot.active) throw new Error(`replication slot ${r.slot} is lost and still in use by pid ${slot.activePid}`);
        await dropSlot(pg, r.slot);
      } else if (slot.exists && slot.plugin !== "pgoutput") {
        throw new Error(`replication slot ${r.slot} exists with the plugin ${slot.plugin}, not pgoutput: it is not Mason's (drop it, or name another project)`);
      }
      if (!slot.exists || slot.walStatus === "lost") {
        const repl = await PgConnection.connect({ ...this.pgOptions(), replication: true });
        try { this.log(`made replication slot ${r.slot} at ${await createSlot(repl, r.slot)} (it holds the database's WAL until Mason reads it: mason destroy drops it, and so does a sources file in which no table's sync is replication)`); }
        finally { repl.close(); }
        made = true;
        this.onReplication?.(true);
      }
      if (made || !this.slotKnown) {
        // the replicated tables already copied: the slot carries nothing from before it (a polled one is the poll's)
        const copied = tables.filter((t) => this.states.get(t.source)?.phase === "copied" && this.snapshots.has(t.source));
        await this.onWriter(async () => {
          const w = this.store.writer;
          await w.run("BEGIN TRANSACTION");
          try {
            await w.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.stream_state VALUES ($1, '0/0', now())`, [r.slot]);
            for (const t of copied) await w.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.catch_up VALUES (${literal(t.source)}, 'after the slot was made', now())`);
            await w.run("COMMIT");
          } catch (e) {
            await w.run("ROLLBACK");
            throw e;
          }
          this.appliedLsn = 0n;
          this.slotKnown = true;
          for (const t of copied) this.behind.set(t.source, { why: "after the slot was made" });
          this.refreshStreamed();
        });
      }
    } finally { pg.close(); }
    await this.onWriter(() => this.settlePrepared(tables));
  }

  /**
   * WHAT A PASS'S PUBLICATION CHECK SETTLES, ON THE WRITER'S TURN (`prepareReplication`, once the publication and slot are
   * as they should be): a table a named publication does not carry is refused on its own line (a copy it never had is
   * failed), the others go on; a table it carries AGAIN has that gap's error cleared, and a table never copied the last
   * pass's failure to prepare. NOTHING ELSE: a copy whose stream failed, or that the failed preparation left behind, is
   * current again only once the stream applies a batch with a position (`applyChanges`) — the publication being right
   * says nothing of whether its changes are in the copy, and a pass runs while the stream waits out its back-off.
   */
  private async settlePrepared(tables: readonly AddedTable[]): Promise<void> {
    for (const t of tables) {
      const st = this.states.get(t.source)!;
      const gap = this.unpublished.get(t.source);
      if (gap !== undefined) {
        const error = `replication: ${gap}`;
        if (st.error !== error) { this.log(`${t.source} is not synced or streamed: ${error}`); this.event({ kind: "stream_failed", table: t.source, message: `not synced or streamed: ${error}` }); }
        this.gapErrors.set(t.source, error);
        await this.record({ ...st, phase: st.phase === "copied" ? "copied" : "failed", error });
        continue;
      }
      const gapClosed = this.gapErrors.get(t.source);
      this.gapErrors.delete(t.source);
      if (st.error === null) continue;
      if (st.error === gapClosed || (st.phase !== "copied" && st.error === this.wholeFailure.prepare)) await this.record({ ...st, error: null });
    }
    // a table the publication does not carry was never streamed: its last sync is its copy's or its poll's, never
    // the stream's time a start credited it with (`readSynced` at `open`, before the publication was read)
    const credited = tables.filter((t) => this.unpublished.has(t.source) && this.synced.get(t.source)?.by === "stream").map((t) => t.source);
    if (credited.length) await this.readSynced(new Set(credited));
    // a table the publication stopped carrying leaves the stream; one it carries now may join
    this.refreshStreamed();
  }

  /**
   * A publication the operator NAMED: read as it is, verified, never created, altered or dropped (src/duck/publication.ts).
   * One that cannot be read through at all refuses the pass; a table it does not carry is left out of the copy and the
   * stream (`unpublished`), every other table going on.
   */
  private async verifyPublication(pg: PgConnection, tables: readonly AddedTable[], identities: ReadonlyMap<string, string>): Promise<void> {
    const name = this.replication!.publication;
    const v = namedPublicationVerdict(await readNamedPublication(pg, name, tables), tables, identities);
    if (v.refused !== null) throw new Error(v.refused);
    this.unpublished.clear();
    for (const [source, m] of v.tables) this.unpublished.set(source, m);
    if (v.noTruncate && !this.truncateSaid) {
      this.log(`publication ${name} does not publish truncate: a TRUNCATE on the database does not reach the synced data (the poll's count would see it: sync: poll <interval> on its entry)`);
      this.truncateSaid = true;
    }
  }

  /**
   * Mason's own publication made, or re-pointed, to carry exactly the added tables, with inserts, updates, deletes and
   * truncates. A table with the default identity (its primary key) carries its added columns only (Postgres 15's
   * column lists): what the stream sends is what the copy keeps. Any other identity carries the whole table, since a
   * column list that misses an identity column makes the app's UPDATEs fail; a generated column is never listed (Postgres
   * refuses it there; the stream reads it from the source, `refetch`).
   */
  private async ensurePublication(pg: PgConnection, tables: readonly AddedTable[], identities: ReadonlyMap<string, string>): Promise<void> {
    const name = this.replication!.publication;
    const lists = Number((await pg.query("SHOW server_version_num")).rows[0]?.[0] ?? 0) >= 150000;
    const want = new Map(tables.map((t) => [t.source, lists && identities.get(t.source) === "d" ? t.columns.filter((c) => !c.generated).map((c) => c.name).sort() : null]));
    const flags = (await pg.query(`SELECT pubinsert AND pubupdate AND pubdelete AND pubtruncate, puballtables FROM pg_publication WHERE pubname = ${pgLiteral(name)}`)).rows[0];
    const now = new Map((await pg.query(lists
      ? `SELECT n.nspname || '.' || c.relname, CASE WHEN r.prattrs IS NULL THEN NULL ELSE (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = r.prrelid AND a.attnum = ANY(r.prattrs)) END ` +
        `FROM pg_publication_rel r JOIN pg_publication p ON p.oid = r.prpubid JOIN pg_class c ON c.oid = r.prrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE p.pubname = ${pgLiteral(name)}`
      : `SELECT schemaname || '.' || tablename, NULL FROM pg_publication_tables WHERE pubname = ${pgLiteral(name)}`)).rows.map((x) => [x[0]!, x[1] ?? null] as const));
    const same = flags !== undefined && flags[0] === "t" && flags[1] === "f" && now.size === want.size &&
      [...want].every(([source, cols]) => now.has(source) && now.get(source) === (cols === null ? null : [...cols].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).join(",")));
    if (same) return;
    const list = tables.map((t) => { const cols = want.get(t.source); return `${pgIdent(t.schema)}.${pgIdent(t.table)}${cols ? ` (${cols.map(pgIdent).join(", ")})` : ""}`; }).join(", ");
    if (flags === undefined) {
      await pg.query(`CREATE PUBLICATION ${pgIdent(name)} FOR TABLE ${list} WITH (publish = 'insert, update, delete, truncate')`);
      this.log(`made publication ${name} for ${tables.map((t) => t.source).join(", ")}`);
    } else {
      if (flags[1] === "t") throw new Error(`publication ${name} is FOR ALL TABLES: it is not the one Mason made (drop it, or name another project)`);
      await pg.query(`ALTER PUBLICATION ${pgIdent(name)} SET TABLE ${list}`);
      await pg.query(`ALTER PUBLICATION ${pgIdent(name)} SET (publish = 'insert, update, delete, truncate')`);
      this.log(`re-pointed publication ${name} at ${tables.map((t) => t.source).join(", ")}: the tables whose sync is replication`);
    }
    // VERIFIED, never assumed: what the publication carries is what the database says it does
    const carried = (await pg.query(`SELECT schemaname || '.' || tablename FROM pg_publication_tables WHERE pubname = ${pgLiteral(name)}`)).rows.map((x) => x[0]!).sort();
    const wanted = tables.map((t) => t.source).sort();
    if (carried.join("\n") !== wanted.join("\n")) {
      throw new Error(`publication ${name} carries ${carried.join(", ") || "no table"} after it was set to ${wanted.join(", ")} (Mason bug: report it, with mason logs)`);
    }
  }

  /**
   * NO TABLE'S SYNC IS REPLICATION ANY MORE (at the start that finds none, or live when the last one leaves): the stream
   * stopped, the slot dropped — it holds the database's WAL while it exists, read or not — and Mason's own publication
   * with it (a named one is its owner's: left as it is), each VERIFIED gone; then this copy's record of the slot goes,
   * so a table replicated again later is caught up by one poll under the slot made anew. Idempotent: what is already
   * gone is not an error. A failure is the pass's, said, and tried again at the next.
   */
  private async retireReplication(): Promise<void> {
    const r = this.replication!;
    const s = this.stream;
    if (s !== null) { await s.stop(); if (this.stream === s) this.stream = null; }
    const pg = await PgConnection.connect(this.pgOptions());
    const dropped: string[] = [];
    try {
      // the walsender a stop ended lets the slot go a moment later: waited for, at most 10 s
      let slot = await readSlot(pg, r.slot);
      for (let i = 0; slot.exists && slot.active && i < 100; i++) { await new Promise((res) => setTimeout(res, 100)); slot = await readSlot(pg, r.slot); }
      if (slot.exists) {
        if (slot.active) throw new Error(`replication slot ${r.slot} is in use by pid ${slot.activePid ?? "?"}, so it cannot be dropped (another Mason over the same project? stop it)`);
        await dropSlot(pg, r.slot);
        dropped.push(`replication slot ${r.slot}`);
      }
      const hasPub = async (): Promise<boolean> => (await pg.query(`SELECT 1 FROM pg_publication WHERE pubname = ${pgLiteral(r.publication)}`)).rows.length > 0;
      if (r.owned && await hasPub()) {
        await pg.query(`DROP PUBLICATION IF EXISTS ${pgIdent(r.publication)}`);
        dropped.push(`publication ${r.publication}`);
      }
      if ((await readSlot(pg, r.slot)).exists) throw new Error(`replication slot ${r.slot} is still there after pg_drop_replication_slot`);
      if (r.owned && await hasPub()) throw new Error(`publication ${r.publication} is still there after DROP PUBLICATION`);
    } finally { pg.close(); }
    await this.onWriter(async () => {
      await this.store.writer.run(`DELETE FROM ${MASON_SCHEMA}.stream_state WHERE slot = $1`, [r.slot]);
      this.slotKnown = false;
      this.appliedLsn = 0n;
      this.streamCurrentAt = null;
      this.refreshStreamed();
    });
    this.log(`no table's sync is replication now: ${dropped.length ? `dropped ${dropped.join(" and ")} from ${this.source.database}, verified gone` : `replication slot ${r.slot} was already gone`}` +
      ` (the slot held the database's WAL)${r.owned ? "" : `; publication ${r.publication} is its owner's, left as it is`} — a table set to sync: replication makes the slot again`);
    this.onReplication?.(false);
  }

  /**
   * The stream started from the slot's acknowledged position, once the slot is known (a pass's `prepareReplication`),
   * and never stopped by a pass: a copy runs beside it. What it applies is `streamed`, read at each change, so a table
   * joins once caught up and leaves when copied again without a restart.
   */
  private startStream(): void {
    if (this.stream !== null || this.stopped || !this.streams() || !this.slotKnown || Date.now() < this.streamAt) return;
    const r = this.replication!;
    this.refreshStreamed();
    const s = new ReplicationStream({
      connect: () => PgConnection.connect({ ...this.pgOptions(), replication: true }), slot: r.slot, publication: r.publication, log: (l) => this.log(l),
      target: { tables: () => this.streamed, apply: (batch, lsn, committedAt) => this.applyStreamed(batch, lsn, committedAt), applied: () => this.appliedLsn,
        refuse: (source, missing) => this.refuseStreamed(source, missing), current: () => { if (this.stream === s) this.streamCurrentAt = Date.now(); } },
    });
    this.stream = s;
    this.streamFailure = null;
    this.lineAt = Date.now();
    // the stream's periodic line: at most every streamReportMs, and only when it applied something (`reportStream`)
    if (this.reportTimer === null) { this.reportTimer = setInterval(() => this.reportStream(), this.streamReportMs); this.reportTimer.unref(); }
    const joined = [...this.streamed.keys()].filter((x) => !this.held.has(x));
    this.log(`streaming ${joined.length ? joined.join(", ") : "no table yet"} from slot ${r.slot} (publication ${r.publication}), applied through ${formatLsn(this.appliedLsn)}` +
      `${joined.length < this.replicatedTables().length ? "; a table synced or caught up meanwhile joins it once current" : ""}`);
    void s.done.then(async (e) => {
      if (this.stream === s) this.stream = null;
      if (e === null || this.stopped) return;
      // a numeric wider than its copy's DECIMAL: that table leaves the stream and is copied again, wider, and the stream
      // goes on at once without it (it joins again caught up from its new copy) — at most three times a run, past which
      // a value the stream keeps replaying is wider than any copy of now
      const wider = [...this.tables.values()].find((t) => e.message.includes(`${WIDER} [${t.source}]`));
      const n = wider === undefined ? 0 : (this.widened.get(wider.source) ?? 0) + 1;
      if (wider !== undefined && n <= 3) {
        this.widened.set(wider.source, n);
        await this.onWriter(async () => { this.snapshots.delete(wider.source); this.refreshStreamed(); });
        this.log(`replication: ${wider.source} has a numeric value wider than its synced DECIMAL column: it is read again whole, then streamed`);
        this.startStream();
        this.kick();
        return;
      }
      const m = `replication: ${e.message}`;
      // a failure that recurs must not restart the stream every second: each restart decodes the slot's WAL again on
      // the source
      this.streamFailures++;
      const wait = streamRetryDelayMs(this.intervalMs, this.streamFailures);
      // a timer may fire a little early: the pass it kicks starts the stream
      this.streamAt = Date.now() + wait - 50;
      this.streamFailure = { error: m, retryAt: this.streamAt };
      this.log(`${m} (the stream starts again in ${wait / 1000} s, failure ${this.streamFailures} in a row; the synced tables serve as they are)`);
      // one event for the stream, never one per table it kept current (each table's error says it); its failures in a
      // row are left out of the words, so a stream failing for good is one event, not one per restart
      this.event({ kind: "stream_failed", table: null, message: `${m} (the stream starts again by itself; the synced tables serve as they are)` });
      this.wholeFailure.stream = m;
      // on the tables the stream kept current when it failed (one being caught up says its own)
      await this.onWriter(async () => { for (const source of this.streamed.keys()) if (!this.held.has(source)) await this.record({ ...this.states.get(source)!, error: m }); });
      this.timer = setTimeout(() => this.kick(), wait);
    });
  }

  /**
   * A STREAMED TABLE WHOSE RELATION NO LONGER CARRIES A COLUMN ITS COPY HOLDS (a DDL on the database, or a publication's
   * column list narrowed while Mason streams; at the start `checkPublication` refuses the same): refused by name with the
   * way out, the other tables streaming on. It leaves the stream and is marked behind (`_mason.catch_up`, on the writer's
   * turn, so before the stream acknowledges a change it skipped), and caught up by one poll from its watermark once its
   * back-off ends (`backOff`) — that poll, or the next pass's publication check, says whether the column is back; added
   * without it, the table is copied again at once. The stream waits for it: one that cannot be recorded ends the stream with its
   * error, before anything past it is acknowledged.
   */
  private refuseStreamed(source: string, missing: readonly string[]): Promise<void> {
    return this.onWriter(async () => {
      const t = this.tables.get(source);
      if (t === undefined || !this.streamed.has(source)) return;
      const cols = missing.join(", ");
      const why = `after the stream stopped carrying ${cols}`;
      await this.store.writer.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.catch_up VALUES (${literal(source)}, ${literal(why)}, now())`);
      this.behind.set(source, { why });
      this.held.delete(source);
      const when = this.backOff(source, 0);
      const pub = this.replication!.publication;
      const m = `replication: the stream no longer carries ${source}'s ${cols}, which its synced table holds (a column dropped or renamed on the database, or the publication's column list narrowed), ` +
        `so its changes are not applied: it is caught up by one poll again after ${when}. The way out: remove ${cols} from its columns in the sources file (mason add ${source} --columns … ` +
        `picks the columns it has; it is read again whole at once)${this.replication!.owned ? "" : `, or publish ${missing.length === 1 ? "it" : "them"} again (ALTER PUBLICATION ${pub} …)`}`;
      this.log(`${source}: ${m}`);
      this.event({ kind: "stream_failed", table: source, message: m });
      await this.record({ ...this.states.get(source)!, error: m });
      this.refreshStreamed();
    });
  }

  /**
   * What the stream applies, made again from the tables' state (on the writer's turn, or before the stream exists): a
   * table copied at its present columns and caught up, and a table being caught up (its changes held, `held`). A table
   * that is not — never copied, being copied again, or not caught up — is skipped: its copy's snapshot, or its catch-up,
   * covers what the stream passes over (src/duck/stream.ts "why replaying is safe"). A table here since the last refresh
   * keeps its STAY, a table new here gets one, and `swap` ends it: changes decoded in a stay that ended committed before
   * what came next, so that copy and its catch-up hold them, and only that stay's are applied (`applyStreamed`).
   */
  private refreshStreamed(): string[] {
    const before = new Map(this.streamed);
    this.streamed.clear();
    const now = new Set<string>();
    for (const t of this.tables.values()) {
      // a table a named publication does not carry is never streamed (`unpublished`): its changes are not in the slot;
      // nor one whose sync is not replication (it is polled, or off)
      const joined = this.replicated(t) && !this.behind.has(t.source) && !this.needsCopy(t) && !this.unpublished.has(t.source);
      // in the COPY's columns: a held table's columns may have changed since its copy began (`asCopied`)
      const c = this.asCopied(t).columns;
      if (joined || this.held.has(t.source)) {
        this.streamed.set(t.source, { stay: before.get(t.source)?.stay ?? ++this.lastStay, columns: c.map((x) => x.name), key: t.key, generated: c.filter((x) => x.generated).map((x) => x.name), big: t.rows !== null && t.rows > BIG_TABLE_ROWS });
      }
      if (joined) now.add(t.source);
    }
    // A TABLE JOINING OR LEAVING THE STREAM IS SAID, with the position it does so at — never a line per batch. Said only
    // while a stream runs: its start names what it streams. What it returns is the tables whose join was said
    const said: string[] = [];
    const s = this.stream;
    if (s !== null) {
      const at = formatLsn(s.position());
      for (const source of this.joinedNow) {
        if (now.has(source)) continue;
        const t = this.tables.get(source);
        // its sync changed: what keeps it current now, in the words of the switch
        const why = t !== undefined && !this.replicated(t)
          ? `its sync is ${syncText(this.syncOf(t))} now, so it is caught up by one poll from its watermark${this.syncOf(t).mode === "off" ? ", then read again only by mason sync" : ", then polled"}`
          : this.notStreamedWhy(source);
        this.log(`${source} leaves the stream at ${at}: ${why}`);
      }
      for (const source of now) {
        if (this.joinedNow.has(source)) continue;
        const why = this.joinWhy.get(source);
        this.log(why === undefined ? `${source} joins the stream at ${at}: the stream carries what follows` : `${why}: it joins the stream at ${at}, which carries what follows`);
        said.push(source);
      }
    }
    this.joinWhy.clear();
    this.joinedNow = now;
    return said;
  }

  /** why an added table is not streamed now (or a removed one no longer), in the reader's words, with what it waits for
   *  next: a failure's back-off (its time), or the rebuild it is queued behind (one runs at a time) */
  private notStreamedWhy(source: string): string {
    const why = this.notStreamedReason(source);
    const at = this.retries.get(source)?.at ?? 0;
    if (at > Date.now()) return `${why} — after a failure, tried again after ${clock(at)} UTC`;
    const ahead = this.rebuildingNow;
    if (this.queued.has(source) && ahead !== null && ahead.source !== source) return `${why} — queued behind ${ahead.source}'s ${ahead.kind === "copy" ? "whole read" : "catch-up"} (one rebuild at a time)`;
    return why;
  }

  /** why a table whose first sync finished is to be read again whole, or null: what the start's line and mason sync say */
  private readAgainWhy(t: AddedTable): string | null {
    if (this.copiedAs.get(t.source) !== columnsKey(t.columns)) return "its columns changed";
    return this.snapshots.has(t.source) ? null : "a numeric value outgrew its synced DECIMAL column";
  }

  private notStreamedReason(source: string): string {
    const t = this.tables.get(source);
    if (t === undefined) return "it is no longer added (its synced data is dropped)";
    const gap = this.unpublished.get(source);
    if (gap !== undefined) return gap.split("\n")[0]!;
    const st = this.states.get(source);
    if (this.copiedAs.has(source) && this.copiedAs.get(source) !== columnsKey(t.columns)) return "its columns changed: it is read again whole, then caught up by one poll";
    if (st?.phase === "copied" && !this.snapshots.has(source)) return "a numeric value outgrew its synced DECIMAL column: it is read again whole, wider, then caught up by one poll";
    const r = this.retired.get(source);
    if (st?.phase === "copied" && r !== undefined) return `it is ${r.short}: it is read again whole, then caught up by one poll`;
    // what follows the copy: a catch-up poll, then the stream or the polls; copied again whole, nothing (`keptOf`'s recopy)
    const joins = this.mode === "recopy" ? "it is kept current once synced" : "it joins once synced and caught up by one poll";
    if (st?.phase === "copying" || this.rebuildingNow?.source === source && this.rebuildingNow.kind === "copy") return `it is being read whole: ${joins}`;
    if (st?.phase === "failed") return `its first sync failed (${(st.error ?? "").split("\n")[0]}): ${joins}`;
    const b = this.behind.get(source);
    if (!this.needsCopy(t) && b !== undefined) return `it is caught up by one poll ${b.why} first`;
    // synced, caught up, and not yet polled (`pollable`): its rebuild's last writer's turn, or a rebuild still queued
    if (st?.phase === "copied") {
      if (this.rebuildingNow?.source === source) return "its sync is ending: it is kept current from then on";
      const queued = this.queued.get(source)?.kind;
      if (queued !== undefined) return queued === "copy" ? `it is queued to be read whole: ${joins}` : "it is queued to be caught up by one poll";
    }
    return `it waits for its first sync: ${joins}`;
  }

  /**
   * WHERE THE STREAM IS (`StreamStatus`): its position, the database's, the lag, the last batch, and each added table's
   * part in it with what it applied this run. Null outside replication mode. The database's position costs a
   * connection at most every 5 s (`databasePosition`); everything else is the run's own.
   *
   * `refresh: false` NEVER REACHES THE DATABASE: the position and the slot as last read (`database.at`, `slotWal.at` say
   * when), or "not read yet". What an unauthenticated reader asks with (`GET /metrics`, src/cli/run-server.ts
   * `metricsFacts`): a scraper's rate, or anyone's loop on the health port, must never become connections and SELECTs
   * on the source; the usage sampler, `mason status` and `mason wait` keep the reads fresh.
   */
  async streamStatus({ refresh = true }: { refresh?: boolean } = {}): Promise<StreamStatus | null> {
    if (!this.streams()) return null;
    const r = this.replication!;
    const s = this.stream;
    const position = s?.position() ?? this.appliedLsn;
    const db = refresh ? await this.databasePosition() : this.dbPosition ?? { error: "not read yet: nothing has asked where the database is since the run began", at: Date.now() };
    const now = Date.now();
    const iso = (ms: number): string => new Date(ms).toISOString();
    // each table's part, as `keptOf` says it for EXPLAIN (`streamTable`), with what it applied this run
    const tables = this.replicatedTables().map((t): StreamTableStatus =>
      ({ table: t.source, ...this.streamTable(t, now, s), applied: { ...(this.appliedCounts.get(t.source) ?? noCounts()) } }));
    return {
      slot: r.slot, slotWal: this.slotWal?.wal ?? { error: "not read yet: the database did not answer within 3 s" }, publication: r.publication, running: s !== null,
      failure: s === null && this.streamFailure !== null ? { error: this.streamFailure.error, retryAt: iso(this.streamFailure.retryAt) } : null,
      position: formatLsn(position), applied: formatLsn(this.appliedLsn),
      database: "lsn" in db ? { lsn: formatLsn(db.lsn), at: iso(db.at) } : { error: db.error },
      lag: { bytes: "lsn" in db ? Number(db.lsn > position ? db.lsn - position : 0n) : null,
        seconds: this.lastBatch === null ? null : Math.max(0, now - this.lastBatch.committedAt) / 1000 },
      lastBatch: this.lastBatch === null ? null : { appliedAt: iso(this.lastBatch.appliedAt), committedAt: iso(this.lastBatch.committedAt) },
      tables,
    };
  }

  /**
   * THE DATABASE'S OWN POSITION, read over a connection of its own at most every 5 s however often it is asked (`mason
   * wait` asks every second), waited for at most 3 s (the last read is answered meanwhile, with its time). Not the
   * stream's keepalive: that carries the walsender's own read position, not the database's, so it cannot say how far
   * behind the stream is when that matters — while it decodes a backlog. A read that fails is answered as its error.
   * THE SLOT'S WAL (`SlotWal`) is read on the same connection, at most every SLOT_READ_MS (one row of
   * pg_replication_slots): what the slot holds on the database's disk, said by `mason status` and sampled by usage.
   */
  private async databasePosition(): Promise<{ lsn: bigint; at: number } | { error: string; at: number }> {
    const fresh = this.dbPosition !== null && Date.now() - this.dbPosition.at < 5_000;
    if (!fresh && this.dbPositionRead === null) {
      const slotDue = this.slotWal === null || Date.now() - this.slotWal.at >= SLOT_READ_MS;
      const slot = this.replication!.slot;
      this.dbPositionRead = (async () => {
        try {
          const pg = await PgConnection.connect(this.pgOptions());
          try {
            this.dbPosition = { lsn: await currentLsn(pg), at: Date.now() };
            if (slotDue) {
              // its own failure is the slot's line alone: the position read above stands
              try { this.slotWal = { wal: slotWalOf(await readSlot(pg, slot), slot, Date.now()), at: Date.now() }; }
              catch (e) { this.slotWal = { wal: { error: `the slot could not be read: ${e instanceof Error ? e.message : String(e)}` }, at: Date.now() }; }
            }
          } finally { pg.close(); }
        } catch (e) {
          // answered as the status's (and the log line's) own words: the position could not be read, and why
          const m = e instanceof Error ? e.message : String(e);
          this.dbPosition = { error: m, at: Date.now() };
          if (slotDue) this.slotWal = { wal: { error: `the database could not be reached: ${m}` }, at: Date.now() };
        } finally { this.dbPositionRead = null; }
      })();
    }
    if (!fresh && this.dbPositionRead !== null) await Promise.race([this.dbPositionRead, new Promise<void>((done) => { setTimeout(done, 3_000).unref(); })]);
    return this.dbPosition ?? { error: "the database did not answer within 3 s", at: Date.now() };
  }

  /**
   * THE STREAM'S PERIODIC LINE, every `streamReportMs` (a minute) and only when it applied something since the last:
   * where it is, what it applied by table, and the lag. Silent when idle; never a line per batch.
   */
  private reportStream(): void {
    const s = this.stream;
    if (this.sinceLine.size === 0 || s === null) return;
    const moved = [...this.sinceLine].map(([source, c]) => `${source} ${countsText(c)}`).join(", ");
    const span = Date.now() - this.lineAt;
    this.sinceLine.clear();
    this.lineAt = Date.now();
    const position = s.position();
    const last = this.lastBatch;
    void this.databasePosition().then((db) => {
      const behind = "lsn" in db ? `${(db.lsn > position ? db.lsn - position : 0n).toLocaleString("en-US")} bytes behind the database` : `the database's position could not be read (${db.error})`;
      const age = last === null ? "" : `; the newest change applied was committed ${secondsText(Date.now() - last.committedAt)} ago, and applied ${secondsText(last.appliedAt - last.committedAt)} after its commit`;
      this.log(`replication: applied through ${formatLsn(position)} · in the last ${secondsText(span)}: ${moved} · ${behind}${age}`);
    });
  }

  /**
   * THE STREAM'S BATCH, ON THE WRITER'S TURN: a joined table's changes applied (`applyChanges`, which records the
   * position even when nothing is applied), a table being caught up's held for after its poll (`foldInto`), and one
   * that left since the batch was decoded dropped.
   */
  private applyStreamed(batch: ReadonlyMap<string, TableChanges>, lsn: bigint | null, committedAt: Date): Promise<void> {
    return this.onWriter(async () => {
      this.refreshStreamed();
      const applied = new Map<string, TableChanges>();
      for (const [name, changes] of batch) {
        // decoded in a stay that ended (before its table was copied again, or left the stream): what they changed
        // committed before the next copy's catch-up, so that copy or its catch-up holds it — never written over them, in
        // a shape the copy may not have, or as an old change after the poll that read a newer one
        if (this.streamed.get(name)?.stay !== changes.stay) continue;
        const held = this.held.get(name);
        if (held !== undefined) { foldInto(held, changes); continue; }
        applied.set(name, changes);
      }
      await this.applyChanges(applied, { lsn, committedAt });
    });
  }

  /**
   * A batch of the stream applied in ONE DuckDB transaction with the position it ends at: per table, a TRUNCATE's
   * rows removed, a row an UPDATE left a large value unchanged in (pgoutput sends none) updated in the columns it
   * carries (`updateCarried`) — read whole from the source by its key where DuckDB has no row to keep the value of, or
   * a column of it is not streamed — then the deleted keys and the whole rows written by key (`writeByKey`). With no
   * index each of those is a scan of the table's key column, so a batch costs a few scans per table, never one per row. A numeric wider than its copy's DECIMAL is the table's to copy
   * again (`WIDER`), never rounded. A null `lsn` is a piece of a large transaction (src/duck/stream.ts): committed, the
   * position left as it was, so a run that dies before the transaction's last piece applies it again whole. What it
   * applied is counted by table (`streamStatus`), and the batch's newest commit time kept.
   *
   * `"held"` is THE CHANGES A CATCH-UP HELD, replayed after its poll (`catchUp`): written, and counted, as a batch's are,
   * but NOT A POSITION of the stream — no `stream_state` row (its LSN and `applied_at` are the batches' that held them),
   * no table's `synced`, no commit time, and not the stream working again (`streamFailures`): the replay ran on the
   * writer, whatever the stream is doing (it may be failing).
   */
  private async applyChanges(batch: ReadonlyMap<string, TableChanges>, from: { lsn: bigint | null; committedAt: Date | null } | "held"): Promise<void> {
    const lsn = from === "held" ? null : from.lsn;
    const committedAt = from === "held" ? null : from.committedAt;
    const w = this.store.writer;
    let source: PgConnection | null = null;
    const started = Date.now();
    // EACH TABLE'S ROWS AFTER THE BATCH, kept current at every batch (it was counted at most every 5 s, so a table's
    // count missed the batches after one until another came): what its writes added and removed, which DuckDB says
    // (`rowsChanged`) — never a count(*), which a write by key's deletes make a scan (12 ms on 20 M rows, measured) —
    // written to the ledger IN the batch's transaction, so a run that dies keeps a count equal to its rows
    const rowsAfter = new Map<string, number>();
    // a batch with a position: its time in the ledger and in this run, ONE value (`Synced`)
    const position = lsn === null ? null : { lsn, at: new Date().toISOString() };
    await w.run("BEGIN TRANSACTION");
    try {
      for (const [name, changes] of batch) {
        const added = this.tables.get(name);
        if (added === undefined) continue;
        // written as the COPY's columns, whatever the sources file says now: the stream decoded them so (`refreshStreamed`)
        const t = this.asCopied(added);
        const target = `${ident(t.schema)}.${ident(t.table)}`;
        const types = await this.columnTypes(t, target);
        const cols = t.columns.map((c) => c.name);
        const exact = await this.exactOf(t);
        const declared = (c: string): boolean => NUMERIC_TYPE.exec(t.columns.find((x) => x.name === c)?.type ?? "")?.[1] !== undefined;
        const value = (c: string, v: string | null): string => {
          const scale = exact.get(c);
          if (scale !== undefined && v !== null && widerThan(v, scale, declared(c))) throw new Error(`${WIDER} [${name}]: ${c} = ${v}`);
          return duckValue(v, types.get(c)!);
        };
        let delta = changes.truncated ? -Number((await w.run(`DELETE FROM ${target}`)).rowsChanged) : 0;
        const whole: Array<Array<string | null>> = [];
        const fetch: Array<Array<string | null>> = [];
        const gone: Array<Array<string | null>> = [];
        // the rows an UPDATE left a large value unchanged in, by the columns they carry: one UPDATE for each set
        const partial = new Map<string, Array<{ key: Array<string | null>; values: Array<string | null | undefined> }>>();
        for (const { key, change } of changes.keys.values()) {
          if (change.kind === "delete") { gone.push(key); continue; }
          if (change.refetch) { fetch.push(key); continue; }
          if (!change.values.includes(undefined)) { whole.push(change.values as Array<string | null>); continue; }
          const carried = cols.filter((_, i) => change.values[i] !== undefined).join("\0");
          const same = partial.get(carried) ?? [];
          partial.set(carried, same);
          same.push({ key, values: change.values });
        }
        for (const [carried, rows] of partial) fetch.push(...await this.updateCarried(t, target, carried.split("\0"), rows, value, types));
        if (fetch.length) {
          source ??= await PgConnection.connect(this.pgOptions());
          whole.push(...await this.sourceRows(source, t, fetch));
        }
        delta += await this.writeByKey(t, target, gone, whole, value);
        // a copy whose rows the ledger does not know (none should be: its copy counts them) is counted, once
        const known = this.states.get(name)?.rows ?? null;
        const rows = known === null ? Number((await w.runAndReadAll(`SELECT count(*) FROM ${target}`)).getRowsJS()[0]![0] as bigint) : known + delta;
        if (rows !== known) await w.run(`UPDATE ${MASON_SCHEMA}.copy_state SET "rows" = $1 WHERE source = $2`, [rows, name]);
        rowsAfter.set(name, rows);
      }
      if (position !== null) await w.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.stream_state VALUES ($1, $2, $3::TIMESTAMPTZ)`, [this.replication!.slot, formatLsn(position.lsn), position.at]);
      await w.run("COMMIT");
    } catch (e) {
      await w.run("ROLLBACK");
      throw e;
    } finally { source?.close(); }
    if (lsn !== null) this.appliedLsn = lsn;
    if (from !== "held") this.streamFailures = 0;
    // THE STREAM'S FAILURE IS OVER when it applies a batch WITH A POSITION: every table it keeps current is current as of
    // it. A piece of a large transaction (no position) is not that yet, nor the changes a catch-up held
    if (lsn !== null) this.recovered("stream", "the stream applies changes again");
    let moved = false;
    for (const [name, changes] of batch) {
      if (!this.tables.has(name)) continue;
      // committed: a generated table over it is behind from here (nothing of this is in the transaction above)
      if (changes.truncated || changes.keys.size > 0) this.generated.changed(name);
      for (const into of [this.appliedCounts, this.sinceLine]) {
        const c = into.get(name) ?? noCounts();
        addCounts(c, changes.counts);
        into.set(name, c);
      }
      moved = true;
    }
    if (moved && committedAt !== null && committedAt.getTime() > 0) this.lastBatch = { appliedAt: Date.now(), committedAt: committedAt.getTime() };
    // the rows, as the ledger has them now; with a position, a table the batch wrote is current again (its error, if
    // any, cleared), and so is every table the stream keeps current whose error was the replication's (the stream's
    // failure, the preparation's): the position covers each of them, changed in the batch or not
    for (const [name, rows] of rowsAfter) {
      const st = this.states.get(name);
      if (st === undefined) continue;
      if (st.error !== null && lsn !== null) await this.record({ ...st, rows, error: null });
      else this.states.set(name, { ...st, rows });
    }
    if (lsn !== null) {
      for (const source of this.joinedNow) {
        const st = this.states.get(source);
        if (st !== undefined && st.phase === "copied" && st.error?.startsWith("replication: ")) await this.record({ ...st, error: null });
      }
    }
    // every table the stream keeps current is current as of this batch's position (`Synced`); a piece of a large
    // transaction (no position) and the changes a catch-up held are not a position
    if (position !== null) for (const source of this.joinedNow) this.synced.set(source, { at: position.at, seconds: (Date.now() - started) / 1000, by: "stream" });
  }

  /**
   * Rows an UPDATE left a large value unchanged in, every one carrying the same columns (`carried`, the key among them):
   * those columns set by ONE `UPDATE … FROM` the rows' keys, in the caller's transaction — with no index an UPDATE by key
   * is a scan of the key column, so never a statement per row (measured on DuckDB 2.0.0: 10,000 such rows
   * into 195 M uuid keys at 2.7 GiB took 1.5–1.8 s). Answers the keys DuckDB holds no row of, read whole from the source.
   */
  private async updateCarried(t: AddedTable, target: string, carried: readonly string[], rows: ReadonlyArray<{ key: Array<string | null>; values: Array<string | null | undefined> }>,
    value: (c: string, v: string | null) => string, types: ReadonlyMap<string, string>): Promise<Array<Array<string | null>>> {
    const w = this.store.writer;
    const cols = t.columns.map((c) => c.name);
    const set = carried.filter((c) => !t.key.includes(c));
    await w.run(`CREATE OR REPLACE TEMP TABLE ${WRITE_PARTIAL} (${ident(WRITE_ROW)} INTEGER, ${carried.map((c) => `${ident(c)} ${types.get(c)!}`).join(", ")})`);
    for (let i = 0; i < rows.length; i += 500) {
      await w.run(`INSERT INTO ${WRITE_PARTIAL} VALUES ${rows.slice(i, i + 500).map((r, j) => `(${i + j}, ${carried.map((c) => value(c, r.values[cols.indexOf(c)] ?? null)).join(", ")})`).join(", ")}`);
    }
    const on = t.key.map((k) => `t.${ident(k)} = p.${ident(k)}`).join(" AND ");
    // a stored JSON path of a JSON column it carries, computed from the new value (one it does not carry is unchanged)
    const assign = [...set.map((c) => `${ident(c)} = p.${ident(c)}`), ...this.kept.storedSet(t.source, set, (c) => `p.${ident(c)}`)];
    const matched = set.length === 0 ? 0 : Number((await w.run(`UPDATE ${target} AS t SET ${assign.join(", ")} FROM ${WRITE_PARTIAL} p WHERE ${on}`)).rowsChanged);
    // only when some row was not there: another scan, to say which
    const missing = matched === rows.length ? [] : (await w.runAndReadAll(`SELECT p.${ident(WRITE_ROW)} FROM ${WRITE_PARTIAL} p ANTI JOIN ${target} t ON ${on}`)).getRowsJS().map((r) => Number(r[0]));
    await w.run(`DROP TABLE ${WRITE_PARTIAL}`);
    return missing.map((i) => rows[i]!.key);
  }

  /**
   * THE STREAM'S WRITE BY KEY, IN THE CALLER'S TRANSACTION: the deleted keys and the whole rows' keys deleted by ONE
   * join against the table's key column (`deleteKeys`), then the rows inserted. No copy has a primary key,
   * so there is no `INSERT OR REPLACE`; a key's row is the source's at the batch's end
   * whatever the table held, as replaying needs (src/duck/stream.ts). A table with no key (none can be added:
   * src/cli/preflight.ts) is only appended to. Answers what it did to the table's count: the rows inserted less the rows
   * its deletes removed (DuckDB's own count of each).
   */
  private async writeByKey(t: AddedTable, target: string, gone: ReadonlyArray<Array<string | null>>, whole: ReadonlyArray<Array<string | null>>, value: (c: string, v: string | null) => string): Promise<number> {
    if (gone.length === 0 && whole.length === 0) return 0;
    let delta = 0;
    const w = this.store.writer;
    const cols = t.columns.map((c) => c.name);
    const list = cols.map(ident).join(", ");
    if (whole.length) {
      await w.run(`CREATE OR REPLACE TEMP TABLE ${WRITE_ROWS} AS SELECT ${list} FROM ${target} LIMIT 0`);
      for (let i = 0; i < whole.length; i += 500) {
        await w.run(`INSERT INTO ${WRITE_ROWS} VALUES ${whole.slice(i, i + 500).map((v) => `(${v.map((x, k) => value(cols[k]!, x)).join(", ")})`).join(", ")}`);
      }
    }
    if (t.key.length > 0) {
      const keys = t.key.map(ident).join(", ");
      await w.run(`CREATE OR REPLACE TEMP TABLE ${WRITE_KEYS} AS SELECT ${keys} FROM ${target} LIMIT 0`);
      for (let i = 0; i < gone.length; i += 500) {
        await w.run(`INSERT INTO ${WRITE_KEYS} VALUES ${gone.slice(i, i + 500).map((k) => `(${t.key.map((c, j) => value(c, k[j] ?? null)).join(", ")})`).join(", ")}`);
      }
      if (whole.length) await w.run(`INSERT INTO ${WRITE_KEYS} SELECT ${keys} FROM ${WRITE_ROWS}`);
      delta -= await deleteKeys(w, t, target, WRITE_KEYS, t.key);
      await w.run(`DROP TABLE ${WRITE_KEYS}`);
    }
    if (whole.length) {
      // and its stored JSON paths, computed from the rows' JSON (src/duck/kept.ts)
      const stored = this.kept.stored(t.source, ident);
      delta += Number((await w.run(`INSERT INTO ${target} (${[list, ...stored.names.map(ident)].join(", ")}) SELECT ${[list, ...stored.values].join(", ")} FROM ${WRITE_ROWS}`)).rowsChanged);
      await w.run(`DROP TABLE ${WRITE_ROWS}`);
    }
    return delta;
  }

  /** a copied table's columns' DuckDB types, as DESCRIBE spells them (what `duckValue` casts a value's text to) */
  private async columnTypes(t: AddedTable, target: string): Promise<Map<string, string>> {
    let m = this.duckTypes.get(t.source);
    if (m === undefined) {
      m = new Map((await this.store.writer.runAndReadAll(`DESCRIBE ${target}`)).getRowsJS().map((r) => [String(r[0]), String(r[1])] as const));
      this.duckTypes.set(t.source, m);
    }
    return m;
  }

  /** rows read from the source by key, each column as its text (as the stream sends it); a key it no longer has is
   *  left out (its delete is in the stream) */
  private async sourceRows(pg: PgConnection, t: AddedTable, keys: ReadonlyArray<Array<string | null>>): Promise<Array<Array<string | null>>> {
    const out: Array<Array<string | null>> = [];
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      // the key's values as untyped literals: Postgres reads each as its column's type, so the primary key's index is used
      const tuple = (k: Array<string | null>): string => `(${k.map((v) => v === null ? "NULL" : pgLiteral(v)).join(", ")})`;
      const where = t.key.length === 1 ? `${pgIdent(t.key[0]!)} IN (${chunk.map((k) => k[0] === null ? "NULL" : pgLiteral(k[0]!)).join(", ")})`
        : `(${t.key.map(pgIdent).join(", ")}) IN (${chunk.map(tuple).join(", ")})`;
      const r = await pg.query(`SELECT ${t.columns.map((c) => `${pgIdent(c.name)}::text`).join(", ")} FROM ${pgIdent(t.schema)}.${pgIdent(t.table)} WHERE ${where}`);
      out.push(...r.rows);
    }
    return out;
  }

  /** for a test or a wait: resolves once every change the source had committed when it was called is in DuckDB, in every
   *  table the stream keeps current — a table still copying is not waited for, one copied and not yet caught up is */
  async caughtUp(timeoutMs = 30_000): Promise<void> {
    while (this.running !== null) await this.running;
    const pg = await PgConnection.connect(this.pgOptions());
    let target: bigint;
    try { target = await currentLsn(pg); } finally { pg.close(); }
    const until = Date.now() + timeoutMs;
    for (;;) {
      const s = this.stream;
      const behind = [...this.behind.keys()].filter((x) => this.tables.has(x));
      if (s !== null && s.position() >= target && behind.length === 0) return;
      if (Date.now() > until) throw new Error(`the stream did not reach ${formatLsn(target)} in ${timeoutMs} ms (${s === null ? "no stream is running" : `at ${formatLsn(s.position())}`}${behind.length ? `; not caught up yet: ${behind.join(", ")}` : ""})`);
      s?.poke();
      await new Promise((res) => setTimeout(res, 100));
    }
  }

  /**
   * A long statement on a lane's connection (or several, none of them a COMMIT, ROLLBACK or DETACH), which `stop`
   * interrupts: never started once the sync is stopping, and its interrupt then thrown as `Stopping`. The flag is
   * cleared before the caller's next statement is issued (one thread), so an interrupt never lands on a rollback; one
   * sent between two statements is cleared by DuckDB when the next starts. An interrupt is the connection's own: the
   * rebuild's never reaches the writer's statement, nor the writer's the rebuild's.
   */
  private async interruptible<T>(lane: Lane, f: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Stopping();
    lane.inFlight = true;
    try { return await f(); }
    catch (e) { throw this.stopped && e instanceof Error && /^INTERRUPT Error/.test(e.message) ? new Stopping() : e; }
    finally { lane.inFlight = false; }
  }

  /** the source attached for one more user (a pass, a rebuild), on the writer's turn: ATTACHed by the first. A user
   *  whose attach throws is not one: it never detaches */
  private async attach(): Promise<void> {
    if (!this.attached) {
      // the extension ships with Mason (src/duck/extensions.ts): a LOAD from the platform's package, nothing downloaded;
      // without the package, INSTALL fetches it the first time on a machine (then ~/.duckdb/extensions), said once,
      // and offline the first copy fails here saying why
      if (!this.loaded) {
        const x = this.store.extensions;
        if (!x.shipped) this.log(`Mason's extensions are not installed with it here: ${x.why}. The first sync on this machine downloads its postgres extension`);
        try { await this.store.writer.run(loadPostgresSql(x)); }
        catch (e) { throw new Error(extensionFailure(x, (e as Error).message)); }
        this.loaded = true;
      }
      await this.store.writer.run(`ATTACH ${literal(libpqString(this.source))} AS ${SRC} (TYPE postgres, READ_ONLY)`);
      this.attached = true;
    }
    this.sourceUsers++;
  }

  /**
   * THE SOURCE IS ATTACHED ONLY WHILE A PASS OR A REBUILD READS IT. An attached database is every connection's — a wire
   * session's too, and the rebuilds' — and its path is the connection string, password included (`duckdb_databases()`).
   * A session runs only planned SQL (src/duck/plan.ts PlannedSql), which cannot name it; detached when its last user
   * ends (on the writer's turn, so never under a transaction reading it), it is not there to name either.
   */
  private async detach(): Promise<void> {
    this.sourceUsers = Math.max(0, this.sourceUsers - 1);
    if (this.sourceUsers > 0 || !this.attached) return;
    try { await this.store.writer.run(`DETACH ${SRC}`); this.attached = false; }
    // the pass's work stands; still attached, the next pass detaches it again (and attach() sees it is attached)
    catch (e) { this.log(`the source could not be detached after the pass (tried again after the next): ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** one pass: every removed table dropped, every added table needing it queued for a copy (step 0: whole, again) or
   *  a catch-up (`enqueue`, run beside), and in poll mode every table kept current polled */
  private async pass(): Promise<void> {
    // a table no longer added (mason remove) is dropped, and its ledger rows with it — one whose rebuild is running at
    // the pass after that rebuild ends (its swap would make it again)
    for (const source of [...this.states.keys()].filter((s) => !this.tables.has(s) && this.rebuildingNow?.source !== s)) {
      const [schema, table] = [source.slice(0, source.indexOf(".")), source.slice(source.indexOf(".") + 1)];
      this.queued.delete(source);
      await this.onWriter(async () => {
        const w = this.store.writer;
        await w.run(`DROP TABLE IF EXISTS ${ident(schema)}.${ident(table)}`);
        // and what a copy of it that a crash cut short left beside it (`copy`)
        await w.run(`DROP TABLE IF EXISTS ${ident(schema)}.${ident(`${table}${SIDE_SUFFIX}`)}`);
        for (const ledger of ["copy_state", "poll_state", "catch_up", "copy_progress", "copy_chunks"]) await w.run(`DELETE FROM ${MASON_SCHEMA}.${ledger} WHERE source = ${literal(source)}`);
        // its stored JSON paths and its view
        await this.kept.removed(source);
        this.behind.delete(source);
        this.held.delete(source);
        this.refreshStreamed();
      });
      this.snapshots.delete(source);
      this.retries.delete(source);
      this.due.delete(source);
      this.lastPollMs.delete(source);
      this.recordedSync.delete(source);
      this.switched.delete(source);
      this.retired.delete(source);
      this.copiedAs.delete(source);
      this.copiedColumns.delete(source);
      this.states.delete(source);
      this.synced.delete(source);
      this.log(`dropped ${source}'s synced data: it is no longer added (mason add ${source} syncs it again from the source, whole)`);
    }
    // REPLICATION, as the tables' syncs say: the publication and slot made ready for the replicated tables and the stream
    // started — or, when none is replicated any more, the slot dropped (verified gone). Its failure is the replicated
    // tables' alone (not copied, not caught up: `work`), and the pass's, said once the polled tables are polled
    let replicationFailed: unknown = null;
    let replicationReady = false;
    for (const source of [...this.unpublished.keys()]) { const t = this.tables.get(source); if (t === undefined || !this.replicated(t)) this.unpublished.delete(source); }
    if (this.streams()) {
      try { await this.prepareReplication(); replicationReady = true; }
      catch (e) {
        // the way out on the table's own line: a failure that names none (a slot the database will not make, a role that
        // may not replicate) says the line that keeps the tables polled meanwhile — never a bare SQLSTATE's text
        const said = e instanceof Error ? e.message : String(e);
        const names = this.replicatedTables().map((t) => t.source);
        const m = `replication: ${said}${/sync: poll/.test(said) ? "" : ` — ${names.join(", ")} ${names.length === 1 ? "is" : "are"} NOT kept current until it is fixed: ` +
          `give ${names.length === 1 ? "its entry" : "their entries"} sync: poll <interval> (poll 5m) in the sources file to poll ${names.length === 1 ? "it" : "them"} instead`}`;
        this.event({ kind: "stream_failed", table: null, message: m });
        this.wholeFailure.prepare = m;
        // a table copied before keeps serving its copy; one never copied is failed, so mason status says why
        await this.onWriter(async () => {
          for (const t of this.replicatedTables()) { const st = this.states.get(t.source)!; await this.record({ ...st, phase: st.phase === "copied" ? "copied" : "failed", error: m }); }
        });
        replicationFailed = e;
      }
      this.recovered("prepare", "the publication and the slot are ready again");
      // the stream starts once the slot is known, and runs from then on whatever the passes and rebuilds do
      if (replicationReady) this.startStream();
    } else if (this.replication !== null && (this.slotKnown || this.stream !== null)) {
      try { await this.retireReplication(); }
      catch (e) { replicationFailed = new Error(`no table's sync is replication now, but replication slot ${this.replication.slot} could not be dropped (it holds the database's WAL; tried again at the next pass): ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (this.tables.size === 0) { await this.rebuildSchema(); if (replicationFailed !== null) throw replicationFailed; return; }
    try { await this.onWriter(() => this.attach()); }
    catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.event({ kind: "source_unreachable", table: null, message: `could not attach the database: ${m}` });
      this.wholeFailure.attach = m;
      // a table copied before keeps serving its copy (and its place in the catalog): the source being away is its error,
      // not a reason to copy it whole again when the source is back; one never copied is failed
      await this.onWriter(async () => {
        for (const t of this.tables.values()) {
          const st = this.states.get(t.source)!;
          await this.record({ ...st, phase: st.phase === "copied" ? "copied" : "failed", error: `could not attach the database: ${m}` });
        }
      });
      // the copies serve while the source is away: the catalog lists them (on a fresh start, nothing else has)
      await this.rebuildSchema();
      throw new Error(`Mason could not attach ${this.source.database} on ${this.source.host}:${this.source.port}: ${m}`);
    }
    this.recovered("attach", "the database is attached again");
    try { await this.work(replicationReady); }
    finally { await this.onWriter(() => this.detach()); }
    await this.rebuildSchema();
    if (replicationFailed !== null) throw replicationFailed;
  }

  /** a pass's queueing and polls, the source attached; a replicated table is copied or caught up only once the publication
   *  carries it and the slot exists (`replicationReady`): its changes are in the stream from before it joins */
  private async work(replicationReady: boolean): Promise<void> {
    const started = Date.now();
    // a table never copied (or whose copy failed, or whose copy is out of date) is copied whole, beside the rest: the
    // smallest first (`copyOrder`)
    for (const t of copyOrder([...this.tables.values()])) {
      if (this.stopped) return;
      // a failed copy waits its turn (`copyRetryDelayMs`); the error it recorded says when
      if ((this.retries.get(t.source)?.at ?? 0) > Date.now()) continue;
      // a table the named publication does not carry: copied, nothing would keep it current (prepareReplication)
      if (this.unpublished.has(t.source)) continue;
      if (this.replicated(t) && !replicationReady) continue;
      if (this.mode !== "recopy" && !this.needsCopy(t)) continue;
      if (this.queued.has(t.source) || this.rebuildingNow?.source === t.source) continue;
      if (this.states.get(t.source)?.phase === "copied" && this.copiedAs.get(t.source) !== columnsKey(t.columns)) this.log(`${t.source}: its columns are not the ones it was synced with: it is read again whole`);
      this.enqueue(t.source, { kind: "copy" });
    }
    // a table copied and not yet caught up (a slot new to the copy, or a run that stopped first): its one poll
    for (const source of this.behind.keys()) {
      const t = this.tables.get(source);
      // a failed catch-up waits its turn as a failed copy does (`backOff`); the error it recorded says when
      if (t !== undefined && !this.needsCopy(t) && (this.retries.get(source)?.at ?? 0) <= Date.now() && (!this.replicated(t) || replicationReady)) this.enqueue(source, { kind: "catch-up" });
    }
    // POLL MODE: the tables due (`dueAt`: a polled one past its interval, one whose sync changed), and not a table whose
    // new columns could not be copied (its copy failed above): it is not polled with them
    const now = Date.now();
    const kept = this.mode !== "recopy" ? [...this.tables.values()].filter((t) => !this.replicated(t) && this.pollable(t) && (this.dueAt(t) ?? Infinity) <= now) : [];
    for (const t of kept) {
      if (this.stopped) break;
      // A TRANSACTION PER TABLE, on the writer's turn: one table's slow scan holds no other, and a batch of the stream
      // or a swap may run between two. A table rebuilt or not yet caught up is not polled (decided on the turn itself);
      // its catch-up polls it
      try {
        const found = await this.onWriter(async () => this.rebuildingNow?.source !== t.source && !this.behind.has(t.source) ? this.poll(this.writerLane, [t]) : []);
        for (const f of found) this.polledNow(t, f.ms);
      } catch (e) {
        if (e instanceof Stopping) { this.log("poll stopped: Mason is stopping (rolled back; the synced tables serve as they were)"); return; }
        // tried again after its interval (an `off` table whose sync changed: after the sync's), never at every pass
        const s = this.syncOf(t);
        this.due.set(t.source, Date.now() + (s.mode === "poll" ? s.seconds * 1000 : this.intervalMs));
        // the table serves its copy as it was, and says why it is not current (mason status reads the ledger); the other
        // tables are polled as ever
        const m = `the poll failed, and is tried again at the next one (the synced data serves as it was): ${e instanceof Error ? e.message : String(e)}`;
        this.log(`${t.source}: ${m}`);
        this.event({ kind: "poll_failed", table: t.source, message: m });
        await this.onWriter(() => this.record({ ...this.states.get(t.source)!, error: m }));
      }
    }
    if (this.mode !== "recopy") await this.onWriter(() => this.readPolledAt());
    this.lastPassMs = Date.now() - started;
  }

  /** a rebuild queued, unless that table's is queued or running already; the queue started if idle */
  private enqueue(source: string, r: Rebuild): void {
    if (this.stopped || this.queued.has(source) || this.rebuildingNow?.source === source) return;
    this.queued.set(source, r);
    this.drainRebuilds();
  }

  /** THE REBUILD QUEUE, one at a time on the rebuilds' connection: DuckDB's memory limit is one. Each rebuild says its
   *  own failure; one that throws past that is a bug, said */
  private drainRebuilds(): void {
    if (this.rebuilding !== null || this.stopped) return;
    this.rebuilding = (async () => {
      while (!this.stopped) {
        // a catch-up first, then the smallest copy (`copyOrder`): a table queued while a big one copied goes next
        const size = new Map(copyOrder([...this.queued.keys()].flatMap((s) => this.tables.get(s) ?? [])).map((t, i) => [t.source, i]));
        const next = [...this.queued].sort(([sa, a], [sb, b]) => REBUILD_ORDER.indexOf(a.kind) - REBUILD_ORDER.indexOf(b.kind) || (size.get(sa) ?? 0) - (size.get(sb) ?? 0))[0];
        if (next === undefined) return;
        this.queued.delete(next[0]);
        // a generated table's run reads no source: nothing is attached and no table is marked as rebuilt
        const kind = next[1].kind;
        if (kind === "generated") {
          await this.generated.run(next[0]).catch((e: unknown) => { if (!(e instanceof Stopping)) throw e; });
          continue;
        }
        const t = this.tables.get(next[0]);
        // a catch-up that found a numeric wider than the copy: copied again, next
        if (t !== undefined && await this.rebuild(t, kind) === "copy again") this.enqueue(t.source, { kind: "copy" });
        // still needing a copy or a catch-up: a pass now, or when its back-off ends
        else this.followUp(next[0]);
        // removed while it was rebuilt: the pass that removal kicked left it for this one to drop
        if (!this.tables.has(next[0]) && this.states.has(next[0])) this.kick();
      }
    })().catch((e: unknown) => {
      this.log(`a rebuild failed outside its own handling (Mason bug: report it): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }).finally(() => {
      this.rebuilding = null;
      // what was queued behind a rebuild that threw is still queued
      if (!this.stopped && this.queued.size > 0) this.drainRebuilds();
    });
  }

  /**
   * ONE REBUILD, beside the stream and the polls: the table marked as rebuilt on the writer's turn (from then on no poll
   * starts on it), then its copy on the rebuilds' connection, then — a table left behind by it — its catch-up.
   */
  private async rebuild(t: AddedTable, kind: TableRebuild): Promise<"copy again" | null> {
    await this.onWriter(async () => {
      this.rebuildingNow = { source: t.source, kind };
      this.refreshStreamed();
    });
    let attached = false;
    try {
      try { await this.onWriter(() => this.attach()); attached = true; }
      catch (e) {
        // the next pass says the same of every table, and queues it again
        const m = `could not attach the database: ${e instanceof Error ? e.message : String(e)}`;
        this.log(`${kind} of ${t.source} waits: ${m}`);
        this.event({ kind: "source_unreachable", table: t.source, message: `its ${kind} waits: ${m}` });
        const st = this.states.get(t.source)!;
        await this.onWriter(() => this.record({ ...st, phase: st.phase === "copied" ? "copied" : "failed", error: m }));
        return null;
      }
      if (kind === "copy") await this.copy(t);
      // the whole read is over, whatever comes next: what the table is said to be doing from here (`notStreamedReason`,
      // `refuseRebuilding`, `state`'s `rebuilding`)
      this.rebuildingNow = { source: t.source, kind: "catch-up" };
      // a table its copy left behind (`swap`), or one marked so before: one poll, unless a copy of it comes first — the
      // table as it is added NOW, which may have changed while it was copied (then copied again at once: `followUp`)
      const now = this.tables.get(t.source);
      if (now !== undefined && this.behind.has(t.source) && !this.needsCopy(now) && !this.stopped) return await this.catchUp(now);
      // not caught up: nothing is held for it (its next copy's swap holds anew)
      if (this.held.has(t.source)) await this.onWriter(async () => { this.held.delete(t.source); this.refreshStreamed(); });
      return null;
    } finally {
      await this.onWriter(async () => {
        if (attached) await this.detach();
        this.rebuildingNow = null;
        this.refreshStreamed();
      });
    }
  }

  /**
   * A TABLE CAUGHT UP BY ONE POLL FROM ITS WATERMARK before the polls or the stream keep it current again — after its
   * copy (the copy's snapshot), or a slot new to the copy — on the rebuilds'
   * connection, so the stream and the other tables' polls go on meanwhile. In replication mode the stream holds the
   * table's changes from before the poll's snapshot and applies them after it (src/duck/stream.ts "why replaying is
   * safe"). A table whose sync is `off` is caught up too: the one scan its rebuild costs, then nothing until asked.
   */
  private async catchUp(t: AddedTable): Promise<"copy again" | null> {
    const mark = this.behind.get(t.source)!;
    const replication = this.replicated(t);
    // J: from the writer's turn on, every batch's changes of this table are held (`applyStreamed`)
    if (replication) await this.onWriter(async () => { if (!this.held.has(t.source)) this.held.set(t.source, noChanges()); this.refreshStreamed(); });
    const release = (): Promise<void> => this.onWriter(async () => { this.held.delete(t.source); this.refreshStreamed(); });
    let found: PolledTable[];
    const started = Date.now();
    this.catchingUp = { source: t.source, phase: "polling", startedAt: started };
    // A FAILED CATCH-UP waits as a failed copy does (`backOff`), said whole with its next attempt — in the log and in
    // mason status — and is caught up again then: what was held is read again by that poll (still behind, nothing lost)
    const failed = (what: string, e: unknown): Promise<void> => {
      const when = this.backOff(t.source, Date.now() - started);
      const m = `${what} (the synced data serves as it was; it is caught up by one poll again after ${when}): ${e instanceof Error ? e.message : String(e)}`;
      this.log(`${t.source}: ${m}`);
      this.event({ kind: "catch_up_failed", table: t.source, message: m });
      return this.onWriter(() => this.record({ ...this.states.get(t.source)!, error: m }));
    };
    // the catch-up's poll reads the columns the copy holds (`asCopied`)
    try { found = await this.poll(this.rebuilder, [this.asCopied(t)]); }
    catch (e) {
      this.catchingUp = null;
      await release();
      if (e instanceof Stopping) { this.log(`catch-up of ${t.source} stopped: Mason is stopping (rolled back; it is caught up by one poll at the next start)`); return null; }
      await failed("its catch-up poll failed", e);
      return null;
    }
    // a numeric wider than its copy: the poll said so, and the table is copied again (and caught up after that copy)
    if (found.length === 0) { this.catchingUp = null; await release(); return "copy again"; }
    this.polledNow(t, found[0]!.ms);
    let saidJoin = false;
    if (this.catchingUp?.source === t.source) this.catchingUp.phase = "applying";
    let heldFailure: unknown = null;
    const joined = await this.onWriter(async (): Promise<boolean | "copy again"> => {
      this.catchingUp = null;
      const held = this.held.get(t.source);
      this.held.delete(t.source);
      if (held !== undefined && (held.truncated || held.keys.size > 0)) {
        try { await this.applyChanges(new Map([[t.source, held]]), "held"); }
        catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.refreshStreamed();
          // a numeric wider than its copy: copied again (`needsCopy`), and caught up after that copy
          if (m.includes(`${WIDER} [${t.source}]`)) {
            this.snapshots.delete(t.source);
            this.log(`${t.source}: the changes the stream held during its catch-up could not be applied: it is read again whole, wider (${m})`);
            return "copy again";
          }
          heldFailure = e;
          return false;
        }
      }
      // caught up: a failure's back-off and its words are the past
      this.retries.delete(t.source);
      const st = this.states.get(t.source);
      if (st !== undefined && st.error !== null) await this.record({ ...st, error: null });
      // a slot made again meanwhile marked it anew: caught up once more
      if (this.behind.get(t.source) === mark) {
        await this.store.writer.run(`DELETE FROM ${MASON_SCHEMA}.catch_up WHERE source = ${literal(t.source)}`);
        this.behind.delete(t.source);
      }
      // ITS JOIN, said with the position it joins at (`refreshStreamed`), on the line that says it was caught up
      this.joinWhy.set(t.source, `caught up ${t.source} by one poll ${mark.why}`);
      saidJoin = this.refreshStreamed().includes(t.source);
      await this.readPolledAt();
      return true;
    });
    if (heldFailure !== null) await failed("the changes the stream held during its catch-up could not be applied", heldFailure);
    if (joined !== true) return joined || null;
    if (saidJoin) return null;
    const s = this.syncOf(t);
    const tail = replication ? (this.behind.has(t.source) ? "it is caught up again first (the slot was made again meanwhile)" : "the stream carries what follows once it runs again")
      : s.mode === "off" ? `its sync is off, so it is served as of now: mason sync ${t.source} syncs it again`
        : `the poll keeps it current (${syncWords(s)})`;
    this.log(`caught up ${t.source} by one poll ${mark.why}: ${tail}`);
    return null;
  }

  /**
   * A COPY'S SWAP, ON THE WRITER'S TURN (`onWriter`): the side table a copy built on its own connection replaces the
   * table in ONE transaction between two of the writer's — never beside a poll's or the stream's write of the table,
   * whose commit a DROP under it fails. With it: the copy's watermark and — what the polls and stream skipped while it
   * was copied — the table marked behind (`_mason.catch_up`), its changes held from now (replication), so one poll
   * catches it up (`catchUp`). A copy in a retired layout (`RETIRED_LAYOUT`) is replaced whole here, never converted.
   */
  private async swap(t: AddedTable, side: string, o: { snapshot: string | null; behind: string | null }): Promise<void> {
    const w = this.store.writer;
    const target = `${ident(t.schema)}.${ident(t.table)}`;
    // the copy's time in the ledger and in this run, ONE value, and before `copied_at`, recorded after the swap
    // (`readSynced`: a copy recorded at or after its polled_at was last brought current by that copy)
    const at = new Date().toISOString();
    await w.run("BEGIN TRANSACTION");
    try {
      await w.run(`DROP TABLE IF EXISTS ${target}`);
      await w.run(`ALTER TABLE ${side} RENAME TO ${ident(t.table)}`);
      if (o.snapshot !== null) await w.run(this.pollStateSql(t, o.snapshot, at));
      if (o.behind !== null) await w.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.catch_up VALUES (${literal(t.source)}, ${literal(o.behind)}, now())`);
      // the copy is whole: nothing of it is left to continue
      await w.run(`DELETE FROM ${MASON_SCHEMA}.copy_progress WHERE source = ${literal(t.source)}`);
      await w.run(`DELETE FROM ${MASON_SCHEMA}.copy_chunks WHERE source = ${literal(t.source)}`);
      // the stored JSON paths of a column the new copy does not hold went with the old table
      await this.kept.swapping(w, t.source, t.columns.map((c) => c.name));
      await w.run("COMMIT");
    } catch (e) {
      await w.run("ROLLBACK");
      throw e;
    }
    // committed: a new copy, so a generated table over it is behind from here
    this.generated.changed(t.source);
    // the copy's view of its visible columns, made again (its own transaction: DuckDB writes one database a transaction)
    await this.kept.swapped(t.source);
    if (o.snapshot !== null) {
      this.snapshots.set(t.source, o.snapshot); this.recordedSync.set(t.source, syncText(this.syncOf(t))); this.switched.delete(t.source); this.due.delete(t.source);
      // synced as of its copy, said at once (a review finding: until the next pass re-read the ledger, a table just
      // copied said "never synced"), and the value the ledger holds, so that read moves nothing
      this.polledAt.set(t.source, at);
    }
    // the columns this copy holds, from its swap on: what every write to it is shaped by (`asCopied`)
    this.copiedColumns.set(t.source, [...t.columns]);
    if (o.behind !== null) {
      this.behind.set(t.source, { why: o.behind });
      if (this.replicated(t)) this.held.set(t.source, noChanges());
    }
    this.retired.delete(t.source);
    this.duckTypes.delete(t.source);
    // a new copy, a new stay, whatever the columns: what the stream decoded before this moment is not for it
    this.streamed.delete(t.source);
    this.refreshStreamed();
  }

  /** a table's watermark, the time and the sync it is polled or copied under (`recordedSync`): ONE row of `_mason.poll_state`.
   *  `at` is the caller's, an ISO instant (`toISOString`, as `copied_at`), the very value it remembers (`polledAt`) */
  private pollStateSql(t: AddedTable, snapshot: string, at: string): string {
    return `INSERT OR REPLACE INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES (${literal(t.source)}, ${literal(snapshot)}, ${literal(at)}::TIMESTAMPTZ, ${literal(syncText(this.syncOf(t)))})`;
  }

  /**
   * One poll of the tables given (the passes and `pollNow` give one at a time), in ONE DuckDB transaction over ONE
   * source snapshot (the module's header), on the lane's connection — the writer's, or the rebuilds' for a catch-up —
   * except a table with more than `POLL_PIECE_ROWS` changed rows. Every table's changed rows are read into a STAGE (a
   * TEMP table: no index, spilled past the memory limit) in the snapshot's transaction, and written by key from it
   * (`writeStaged`: their keys deleted, then the rows inserted). A bigger
   * stage is reconciled in that transaction — the count DuckDB WILL hold is its count now and the stage's keys it lacks
   * (a local anti-join of the stage), and only when the source's differs are its keys read and the keys it lacks
   * deleted, as for a small one — and written after it commits, `POLL_PIECE_ROWS` to a committed transaction, the LAST
   * piece's moving the table's watermark (`_mason.poll_state`). Deleting first is also what fits: at 64 MB, 8,000 deletes
   * after 720,000 upserts into an 800,000-row table ran out of memory where before them they did not (measured).
   * Safe for the same reason a poll read twice is: a row a piece writes is the source's row at the snapshot,
   * and a poll that dies between pieces leaves the watermark where it was, so the next poll reads every changed row
   * again and writes it again. A reader may see a table's deletes and earlier pieces before its later ones, as it sees
   * one table's poll before another's. A statement that fails is named in the error (`doing`): a poll runs several
   * against the source and DuckDB, and the engine's message names none. Answers what it found per table (a pieced
   * table's once its last piece is in), or none when a numeric wider than its copy rolled it back.
   */
  private async poll(lane: Lane, tables: readonly AddedTable[]): Promise<PolledTable[]> {
    const w = lane.conn;
    const timed: string[] = [];
    const found: PolledTable[] = [];
    // the tables whose changed rows are written in pieces once the snapshot's transaction commits
    const pieced: Array<{ t: AddedTable; target: string; stage: string; staged: number; deleted: number; started: number }> = [];
    // its row counts, kept until its transaction commits (the poll's own: a catch-up's runs beside a pass's)
    const pending = new Map<string, number>();
    const exacts = new Map<string, Map<string, number>>();
    const declared = (t: AddedTable, column: string): boolean => NUMERIC_TYPE.exec(t.columns.find((c) => c.name === column)?.type ?? "")?.[1] !== undefined;
    for (const t of tables) exacts.set(t.source, await this.exactOf(t, w));
    // the statement running, for the error of one that fails
    let doing = "reading the source's snapshot";
    const named = (e: unknown): unknown => e instanceof Stopping || !(e instanceof Error) ? e : new Error(`${doing}: ${e.message}`, { cause: e });
    // the source's count against DuckDB's, and when they differ the keys DuckDB holds that the source does not deleted
    // (`adds`: the keys a stage still to be written adds to DuckDB's count)
    const reconcile = async (t: AddedTable, target: string, from: string, adds = 0n): Promise<{ rows: number; deleted: number; countMs: number }> => {
      const c0 = Date.now();
      doing = `${t.source}: counting its rows on the source and in the synced table`;
      const counts = (await w.runAndReadAll(`SELECT (SELECT count FROM ${pq(`SELECT count(*) AS count FROM ${from}`)}), (SELECT count(*) FROM ${target})`)).getRowsJS()[0] as [bigint, bigint];
      const countMs = Date.now() - c0;
      let deleted = 0;
      if (counts[0] !== counts[1] + adds) {
        doing = `${t.source}: deleting the keys the source no longer holds (its keys anti-joined with the synced table's)`;
        const on = t.key.map((k) => `t.${ident(k)} = k.${ident(k)}`).join(" AND ");
        const gone = await w.run(`DELETE FROM ${target} WHERE rowid IN (SELECT t.rowid FROM ${target} t ANTI JOIN ${pq(`SELECT ${t.key.map(pgIdent).join(", ")} FROM ${from}`)} k ON ${on})`);
        deleted = Number(gone.rowsChanged);
      }
      return { rows: Number(counts[0]), deleted, countMs };
    };
    let snapshot = "";
    // THE POLL'S TIME, ONE VALUE: taken before its snapshot, so `syncedAt` never says more than the rows hold, written
    // with its watermark (`pollStateSql`) and remembered as written once that commits (`committed`, `polledAt`)
    const polledAt = new Date().toISOString();
    await w.run("BEGIN TRANSACTION");
    try {
      await this.interruptible(lane, async () => {
        const t0 = Date.now();
        const at = (await w.runAndReadAll(`SELECT * FROM ${pq(SNAPSHOT_SQL)}`)).getRowsJS()[0] as [string, string];
        snapshot = at[0];
        const xmax = BigInt(at[1]);
        timed.push(`snapshot ${Date.now() - t0} ms`);
        for (const t of tables) {
          const target = `${ident(t.schema)}.${ident(t.table)}`;
          const from = `${pgIdent(t.schema)}.${pgIdent(t.table)}`;
          const exact = exacts.get(t.source)!;
          // an exact numeric as its text, checked to fit its copy's DECIMAL (WIDER: the table is copied again, wider)
          const cols = t.columns.map((c) => exact.has(c.name) ? fitsDecimal(c.name, exact.get(c.name)!, t.source, declared(t, c.name)) : storedValue(c)).join(", ");
          const enums = await enumLists(w, target);
          const pgCols = t.columns.map((c) => pgColumnSql(c, exact, enums)).join(", ");
          const watermark = snapshotXmin(this.snapshots.get(t.source)!);
          const stage = `temp.main.${ident(`${POLL_STAGE}${pieced.length}`)}`;
          const c0 = Date.now();
          doing = `${t.source}: reading its changed rows from the source into the poll's stage`;
          // its columns named by position: a source column named rowid would hide the stage's own, which a piece reads
          const staged = Number((await w.run(`CREATE OR REPLACE TEMP TABLE ${ident(`${POLL_STAGE}${pieced.length}`)} AS SELECT * FROM (SELECT ${cols} FROM ` +
            `${pq(`SELECT ${pgCols} FROM ${from} WHERE ${xmin8Sql(xmax)} >= ${watermark}`)}) AS polled(${t.columns.map((_, i) => `c${i}`).join(", ")})`)).rowsChanged);
          if (staged > POLL_PIECE_ROWS) {
            const c1 = Date.now();
            doing = `${t.source}: counting the keys its ${staged} changed row(s) add to the synced table (the stage anti-joined with its keys)`;
            const on = t.key.map((k) => `s.${ident(`c${t.columns.findIndex((c) => c.name === k)}`)} = t.${ident(k)}`).join(" AND ");
            const adds = (await w.runAndReadAll(`SELECT count(*) FROM ${stage} s ANTI JOIN ${target} t ON ${on}`)).getRowsJS()[0]![0] as bigint;
            const { rows, deleted, countMs } = await reconcile(t, target, from, adds);
            pieced.push({ t, target, stage, staged, deleted, started: c0 });
            timed.push(`${t.source} ${staged} changed, staged in ${c1 - c0} ms, ${adds} new, counted in ${countMs} ms${deleted ? `, ${deleted} deleted` : ""}`);
            pending.set(t.source, rows);
            continue;
          }
          doing = `${t.source}: writing its ${staged} changed row(s) by key`;
          await writeStaged(w, t, target, stage, "", this.kept);
          const c1 = Date.now();
          const { rows, deleted, countMs } = await reconcile(t, target, from);
          await w.run(this.pollStateSql(t, snapshot, polledAt));
          await w.run(`DROP TABLE ${stage}`);
          timed.push(`${t.source} ${staged} changed in ${c1 - c0} ms, counted in ${countMs} ms${deleted ? `, ${deleted} deleted in ${Date.now() - c1 - countMs} ms` : ""}`);
          found.push({ table: t.source, changed: staged, deleted, rows, ms: Date.now() - c0 });
          pending.set(t.source, rows);
        }
      });
      doing = "committing the poll";
      await w.run("COMMIT");
    } catch (e) {
      try { await w.run("ROLLBACK"); }
      catch (r) { this.log(`the poll's ROLLBACK failed too: ${r instanceof Error ? r.message : String(r)}`); }
      // a stage made in the rolled-back transaction went with it
      pieced.length = 0;
      // a numeric wider than its copy: that table is copied again (wider) at the next pass, the others polled
      // matched against the tables' own names (a name may hold a space)
      const wider = e instanceof Error ? tables.find((t) => e.message.includes(`${WIDER} [${t.source}]`))?.source : undefined;
      if (wider !== undefined && this.snapshots.delete(wider)) {
        this.log(`poll: ${wider} has a numeric value wider than its synced DECIMAL column: it is read again whole at the next pass`);
        return [];
      }
      throw named(e);
    }
    // committed: the watermarks and the row counts move together (a pieced table's with its last piece)
    // and the table's last sync (`Synced`): the poll's time as the ledger now holds it, and how long THIS table's poll took
    const committed = async (source: string, rows: number, ms: number): Promise<void> => {
      this.polledAt.set(source, polledAt);
      const st = this.states.get(source)!;
      if (st.rows !== rows || st.error !== null) await this.record({ ...st, rows, error: null }, undefined, w);
      this.snapshots.set(source, snapshot);
      this.synced.set(source, { at: polledAt, seconds: ms / 1000, by: lane === this.writerLane ? "poll" : "catch-up" });
    };
    try {
      for (const [source, rows] of pending) if (!pieced.some((p) => p.t.source === source)) await committed(source, rows, found.find((f) => f.table === source)?.ms ?? 0);
      this.log(`poll: ${timed.join("; ")}`);
      for (const { t, target, stage, staged, deleted, started } of pieced) {
        const p0 = Date.now();
        const n = Math.ceil(staged / POLL_PIECE_ROWS);
        for (let i = 0; i < n; i++) {
          await w.run("BEGIN TRANSACTION");
          try {
            doing = `${t.source}: writing piece ${i + 1} of ${n} of its ${staged} changed row(s) by key`;
            await this.interruptible(lane, () => writeStaged(w, t, target, stage, ` WHERE rowid >= ${i * POLL_PIECE_ROWS} AND rowid < ${(i + 1) * POLL_PIECE_ROWS}`, this.kept));
            if (i === n - 1) {
              await w.run(this.pollStateSql(t, snapshot, polledAt));
            }
            doing = `${t.source}: committing piece ${i + 1} of ${n}`;
            await w.run("COMMIT");
          } catch (e) {
            await w.run("ROLLBACK");
            throw named(e);
          }
        }
        const rows = pending.get(t.source)!;
        await committed(t.source, rows, Date.now() - started);
        found.push({ table: t.source, changed: staged, deleted, rows, ms: Date.now() - started });
        this.log(`poll: ${t.source}: ${staged.toLocaleString("en-US")} changed row(s), written in ${n} pieces in ${Date.now() - p0} ms`);
      }
    } finally {
      for (const { stage } of pieced) await w.run(`DROP TABLE IF EXISTS ${stage}`);
    }
    // committed: a generated table over a table that changed is behind from here
    for (const f of found) if (f.changed > 0 || f.deleted > 0) this.generated.changed(f.table);
    return found;
  }

  /**
   * A WHOLE COPY OF ONE TABLE, IN THE SOURCE'S HEAP ORDER, WITH NO INDEX (docs/DESIGN.md "Heap order, no index"), IN
   * CHUNKS THAT RESUME (on the test server: a copy of one 196 M-row table was 23 minutes that could not step aside, and one
   * that failed at 90 % started from zero, reading the customer's replica again — ~738 GB over a day's attempts). On
   * the rebuilds' connection, a side table `<table>__mason_copy` is filled a range of the source's heap pages at a
   * time, each sized to take `MASON_COPY_CHUNK_SECONDS` at the rate measured here (`nextChunkPages`; `chunkPages` the
   * ceiling): each chunk a passthrough read (`pq`) of `ctid >= '(p,0)' AND ctid < '(q,0)'` — a TID range scan, the
   * extension's own way of splitting a scan, never an ORDER BY there — appended in the order Postgres's scan delivers
   * it, in a DuckDB transaction of its own that also records the copy's progress (`_mason.copy_progress`,
   * `CopyProgress`), committed. The last chunk is open-ended, so pages past the count read at the start (a table that
   * grew) are read too. Then the writer swaps it in (`swap`; readers see the old copy until then) and it is caught up
   * from the copy's FIRST snapshot (`catchUp`).
   *
   * HELD TO ITS FIRST SNAPSHOT: each DuckDB transaction is a Postgres transaction of its own, so every chunk after the
   * first — and every chunk of a copy resumed by a later run — reads a newer snapshot. Each chunk therefore keeps only
   * the rows written before the first snapshot's xmin, the copy's watermark (src/cdc/poll.ts `xminBeforeSql`, the
   * complement of the poll's "changed since"): a transaction that commits after that snapshot has an id at or past its
   * xmin (it was running then, or began later), and a tuple's xmin never changes, so each chunk's rows are rows of the
   * first snapshot that no later transaction changed. A row updated or deleted since is absent from the copy (its old
   * version is invisible later, its new one is past the watermark) or stale in it (read before the change), exactly as
   * in a one-transaction copy, and a key is never read twice. The catch-up poll from that watermark reads every row the
   * chunks left out and writes it by key, and its count check deletes what the source no longer holds. Two things
   * would break it, and each starts the copy over, said: a rewrite of the source table (VACUUM FULL, CLUSTER, TRUNCATE,
   * a column type change: its rows MOVE between pages, read twice or never) — its file (`pg_relation_filenode`) is read
   * after each chunk, under the lock that chunk's read still holds, and compared with the first chunk's — and a billion
   * transactions since the first snapshot (`xminBeforeHolds`: past 2^31 `age()` wraps). The swap asserts what this
   * gives: as many distinct keys as rows.
   *
   * WHY NO STAGE AND NO KEY (measured on DuckDB 2.0.0, sampling `duckdb_memory()` every 50 ms): an insert into
   * a table with no index writes its row groups to the file as they fill (DuckDB's optimistic writes), so a chunk's
   * memory does not grow with the table — 5,000,000 rows of the test server's table's shape at 256 MB peaked at 244 MiB as one
   * statement; the chunked copy's numbers are in the docs. In heap order the time column's zonemaps prune.
   *
   * READ A FEW AT A TIME (`readChunks`, `COPY_PARALLEL`): each chunk on one of up to `MASON_COPY_PARALLEL` DuckDB
   * connections, each one backend on the source — never the attached scan's ten.
   *
   * RESUMED, NEVER READ TWICE: a copy that died — a crash, `mason stop` (it interrupts the chunks in flight, which alone
   * roll back), a failure — continues with the ranges no chunk committed (`chunksToRead`) when its columns are the same,
   * said ("resuming the copy of …"); changed columns, or a table no longer added, drop the side table and its progress,
   * and so does a copy that ends before any chunk committed (it has nothing to keep but its beginning). A failed copy
   * waits before it is tried again (`copyRetryDelayMs`). Step 0 (`recopy`) has no catch-up to bring what a later
   * snapshot changed: its chunks are one transaction on one connection, and it does not resume. Read-only on the
   * source: SELECTs.
   */
  private async copy(t: AddedTable): Promise<void> {
    const was = this.states.get(t.source)!;
    const first = was.phase !== "copied";
    const w = this.rebuilder.conn;
    if (first) await this.record({ ...was, phase: "copying", error: null }, undefined, w);
    const started = Date.now();
    const side = `${ident(t.schema)}.${ident(`${t.table}${SIDE_SUFFIX}`)}`;
    const recopy = this.mode === "recopy";
    // what this copy has committed of itself: kept for the next attempt (a failure, a stop), dropped when it cannot be
    let kept: CopyProgress | null = null;
    try {
      // a copy begun before (a run that died or stopped, a copy that failed): continued where its columns are the same
      kept = recopy ? await this.forgetCopy(t, side) : await this.resumable(t, side);
      const resumed = kept;
      if (resumed === null) {
        // the stream (or the other tables' polls) goes on: the slot holds no WAL for this copy, and the table joins once
        // caught up from the copy's snapshot
        const beside = this.replicated(t) ? "beside the stream, which goes on keeping the other tables current: it is streamed once caught up by one poll from the snapshot it was read at"
          : this.mode !== "recopy" ? "beside the other tables' polls: once read, it is caught up by one poll from the snapshot it was read at" : "beside the other tables";
        const r = this.retired.get(t.source);
        const again = r !== undefined ? `, again (it is ${r.layout})` : "";
        this.log(`syncing ${t.source}${again}: ${t.rows === null ? "rows unknown" : `about ${t.rows} row(s)`}, ${t.bytes} source bytes, ${beside}`);
      }
      let read: { rows: number; seconds: number; progress: CopyProgress };
      try { read = await this.readChunks(t, side, kept, (p) => { kept = p; }); }
      catch (e) {
        if (!(e instanceof StartOver)) throw e;
        // once: a second reason to start over is the copy's failure
        this.log(`starting the sync of ${t.source} over, from its first page: ${e.message}`);
        kept = await this.forgetCopy(t, side);
        read = await this.readChunks(t, side, null, (p) => { kept = p; });
      }
      const p = read.progress;
      // AS MANY DISTINCT KEYS AS ROWS (`copy`'s header): every chunk read only the first snapshot's rows, and no page
      // twice. Never expected to fail; when it does (a source rewritten in place in a way its file does not show — none
      // known — or a Mason bug) the copy is not swapped in and starts over at its retry
      if (t.key.length > 0) {
        const [rows, keys] = (await w.runAndReadAll(`SELECT count(*), count(DISTINCT (${t.key.map(ident).join(", ")})) FROM ${side}`)).getRowsJS()[0] as [bigint, bigint];
        if (rows !== keys) {
          kept = await this.forgetCopy(t, side);
          throw new Error(`its synced data holds ${rows} rows but ${keys} distinct keys (Mason bug: report it, with mason logs): it was not swapped in, and is read again from its first page`);
        }
      }
      // its stored JSON paths filled, so the table swapped in has every one whole (src/duck/kept.ts fillSide)
      await this.kept.fillSide(w, t.source, side, t.columns.map((c) => c.name), (sql) => this.interruptible(this.rebuilder, async () => Number((await w.run(sql)).rowsChanged)));
      // THE SWAP, on the writer's turn: one transaction, between two of the stream's or the polls'. It carries the copy's
      // watermark (its first snapshot), removes its progress, and leaves the table behind until its catch-up (none in
      // recopy mode: no poll)
      await this.onWriter(() => this.swap(t, side, { snapshot: p.snapshot, behind: p.snapshot === null ? null : "after its whole read" }));
      this.copyLive.delete(t.source);
      kept = null;
      this.retries.delete(t.source);
      const seconds = (Date.now() - started) / 1000;
      this.log(`synced ${t.source}: ${p.rows} row(s), ${t.bytes} source bytes, in ${seconds.toFixed(2)} s (read in ${read.seconds.toFixed(2)} s` +
        `${resumed === null ? "" : `, resumed at page ${readThrough(resumed.done) ?? p.pages} of ${resumed.pages}${pastPages(resumed.done)} with ${resumed.rows} row(s) in`}), stored as the source's scan delivered them, with no index`);
      const copiedAt = new Date().toISOString();
      await this.record({ source: t.source, phase: "copied", rows: p.rows, bytes: t.bytes, seconds, copiedAt, error: null }, t.columns, w);
      this.synced.set(t.source, { at: copiedAt, seconds, by: "copy" });
      this.event({ kind: "copied", table: t.source, message: `synced: ${p.rows.toLocaleString("en-US")} row(s) in ${seconds.toFixed(2)} s` });
      this.copiedAs.set(t.source, columnsKey(t.columns));
      // in the catalog at once: a pass's other copies may take hours
      await this.rebuildSchema();
    } catch (e) {
      // its chunks are no longer read (a failure after every chunk was read, at its check, fill or swap, included)
      this.copyLive.delete(t.source);
      let k: CopyProgress | null = kept;
      // begun, and no chunk committed: nothing of the source's rows to keep, so its next attempt begins again (a new
      // snapshot), as when the beginning and the first chunk were one transaction
      if (k !== null && k.done.length === 0) {
        try { k = await this.forgetCopy(t, side); }
        catch (f) { this.log(`the sync of ${t.source} could not drop what it began (its next attempt continues it): ${f instanceof Error ? f.message : String(f)}`); }
      }
      const through = k === null ? null : readThrough(k.done);
      const where = k === null ? null : through === null ? "with every page read (its swap is next)" : `at page ${through} of ${k.pages}${pastPages(k.done)}, ${k.rows} row(s) in`;
      if (e instanceof Stopping) {
        // the chunks in flight rolled back: a table never copied continues at the next start, one copied before serves its
        // copy as it was meanwhile
        this.log(`sync of ${t.source} stopped: Mason is stopping (${where === null ? "rolled back; it is synced at the next start" : `the chunks in flight rolled back; it continues ${where} at the next start`})`);
        if (first) await this.record({ ...was, phase: "waiting", error: null }, undefined, w);
        return;
      }
      const m = e instanceof Error ? e.message : String(e);
      // tried again after a wait that grows with each failure in a row: a copy failing for good must not read the
      // source at every pass (a 20-minute read of a production replica every 95 minutes) — and then
      // continued where it was, never read again from its first page
      const failures = (this.retries.get(t.source)?.failures ?? 0) + 1;
      const at = Date.now() + copyRetryDelayMs(failures, Date.now() - started);
      this.retries.set(t.source, { failures, at });
      const when = `tried again after ${new Date(at).toISOString().slice(11, 16)} UTC (failure ${failures} in a row), or at once when Mason starts again or its columns or key change` +
        (where === null ? "" : `; it continues ${where}`);
      this.log(`sync of ${t.source} failed: ${m}; ${when}`);
      this.event({ kind: "copy_failed", table: t.source, message: `${m}; ${when}` });
      // a table that was copied keeps serving its last copy; one never copied is failed
      await this.record({ ...this.states.get(t.source)!, phase: first ? "failed" : "copied", error: `${m} (${when})` }, undefined, w);
    }
  }

  /** Where the copy's file is, the bytes free there, and what the copies running are projected to add (`DiskStatus`). */
  diskStatus(): DiskStatus {
    const dir = path.dirname(this.store.file);
    const needed = [...this.copyLive.values()].map((l) => l.diskNeeded).filter((n): n is number => n !== null);
    const projectedBytes = needed.length ? Math.round(needed.reduce((a, b) => a + b, 0)) : null;
    try { return { path: dir, freeBytes: this.diskFree(dir), projectedBytes }; }
    catch (e) { return { path: dir, freeBytes: null, projectedBytes, error: `the free space where the synced data is could not be read: ${e instanceof Error ? e.message : String(e)}` }; }
  }

  /** The DuckDB file's bytes with its write-ahead log's (what a copy adds lands in the log until a checkpoint). */
  private fileBytes(): number {
    let n = 0;
    for (const f of [this.store.file, `${this.store.file}.wal`]) {
      try { n += fs.statSync(f).size; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }   // no log between checkpoints
    }
    return n;
  }

  /** Why the copy of `t` must stop now — what its pages left would add is more than the disk has free — or null. What
   *  it projects is kept on the copy's `live` (`diskStatus` says it). */
  private diskShort(t: AddedTable, p: CopyProgress, disk: { bytesAtStart: number; doneAtStart: readonly PageRange[] }, live: CopyLive): string | null {
    const bytesNow = this.fileBytes();
    const projected = copyDiskProjection({ pages: p.pages, done: p.done, doneAtStart: disk.doneAtStart, bytesAtStart: disk.bytesAtStart, bytesNow });
    live.diskNeeded = projected?.needed ?? null;
    if (projected === null) return null;
    const free = this.diskFree(path.dirname(this.store.file));
    if (projected.needed <= free) return null;
    return `the sync of ${t.source} would need about ${humanBytes(projected.needed)} more on disk than is free (${humanBytes(free)} free where ${this.store.file} is; ` +
      `${pagesRead(p.done, p.pages)} of ${p.pages} pages read, ${humanBytes(bytesNow - disk.bytesAtStart)} added): free some disk, mason remove ${t.source}, or mason add ${t.source} --columns … with fewer columns`;
  }

  /**
   * THE CHUNKS OF A COPY (`copy`), from `from` (a copy begun before) or begun here (`beginCopy`, a transaction of its
   * own), READ `copyParallel` AT A TIME (`COPY_PARALLEL`, `MASON_COPY_PARALLEL`): each reader a DuckDB connection of
   * its own — the rebuilds' and up to seven opened for this copy — so each is one transaction, hence one backend, on the
   * source (the attachment is the instance's; `postgres_query` on a connection reads through that connection's own
   * transaction, measured: three connections, three backends). The readers take the chunks left in page order, each
   * cut at the size the measured rate says when it is taken (`takeChunk`, `nextChunkPages`), each a DuckDB transaction of its own that appends its rows to the ONE side table and its own row to
   * `_mason.copy_chunks`, committed: DuckDB 2.0 lets transactions append to one table side by side (tests/integration/
   * duck-poll.itest.ts holds it), so no reader waits for another's commit. Chunks commit OUT OF ORDER; each committed
   * one is recorded by its range, so a copy that dies continues with exactly the ranges no chunk committed — the ones
   * in flight, never one read twice (the key of `copy_chunks` refuses that at its commit) nor one skipped.
   *
   * EVERY CHUNK IS HELD TO THE FIRST SNAPSHOT (`xminBeforeSql` from `beginCopy`'s one read; `copy`'s header), whichever
   * reader reads it and whenever, and checks the source table's file after its read: the first file read is the
   * copy's, and a chunk that reads another starts the whole copy over (`StartOver`). The first reader to fail —
   * a rewrite, a snapshot held too long, an error, `mason stop` — interrupts the others (sent again every 50 ms: DuckDB
   * loses an interrupt that arrives before its statement starts) and none commits after it: their chunks roll back and
   * are read again by the next attempt. A recopy is one transaction on one reader, no progress. `kept` hears each
   * committed progress; every minute a line says where it is, the chunks of that minute and the readers.
   */
  private async readChunks(t: AddedTable, side: string, from: CopyProgress | null, kept: (p: CopyProgress) => void): Promise<{ rows: number; seconds: number; progress: CopyProgress }> {
    const w = this.rebuilder.conn;
    const recopy = this.mode === "recopy";
    const pgFrom = `${pgIdent(t.schema)}.${pgIdent(t.table)}`;
    const stored = t.columns.map(storedValue).join(", ");
    // named: a copy resumed after its stored JSON paths were filled holds them too (src/duck/kept.ts fillSide)
    const named = t.columns.map((c) => ident(c.name)).join(", ");
    const started = Date.now();
    const lanes: Lane[] = [this.rebuilder];
    if (recopy) await w.run("BEGIN TRANSACTION");
    try {
      let begun = from;
      if (begun === null) {
        if (!recopy) await w.run("BEGIN TRANSACTION");
        try {
          begun = await this.interruptible(this.rebuilder, () => this.beginCopy(t, side, pgFrom));
          if (!recopy) {
            await this.writeBegun(t, begun);
            await w.run("COMMIT");
          }
        } catch (e) {
          if (!recopy) await w.run("ROLLBACK");
          throw e;
        }
        if (!recopy) kept(begun);
      }
      let p: CopyProgress = begun;
      // what this attempt adds to the file, against the pages it reads (copyDiskProjection)
      const disk = { bytesAtStart: this.fileBytes(), doneAtStart: p.done };
      // CHUNKS SIZED BY THE TIME THEY TAKE HERE (`nextChunkPages`): the row estimate's chunk is only the ceiling; the
      // first chunks are a tenth of it, to measure, and every later one is what a reader reads in copyChunkSeconds at
      // the rate measured since — cut from what no committed chunk covers (`copyGaps`, `takeChunk`), so a copy resumed
      // reads exactly the ranges it did not commit, whatever size its chunks were
      const ceiling = chunkPages(p.pages, t.rows, this.copyChunkRows);
      const gaps = copyGaps(p.done);
      let rate: ChunkRate | null = null;
      // the source's page size, for the bytes a second its readers read (pg_relation_size is in bytes; pages are its unit)
      const blockSize = Number((await this.interruptible(this.rebuilder, () => w.runAndReadAll(`SELECT * FROM ${pq("SELECT current_setting('block_size')::int")}`))).getRowsJS()[0]![0]);
      // the side table's enum arrays (`pgColumnSql`; over every type the oracle and the stream suite hold, the enum array
      // is the one a passthrough read types otherwise than the attached scan)
      const lists = await enumLists(w, side);
      const read = t.columns.map((c) => pgColumnSql(c, p.exact, lists)).join(", ");
      const watermark = p.snapshot === null ? null : snapshotXmin(p.snapshot);
      // THE COPY'S FILE: the first a chunk read (or the one its committed chunks were read from); set before any commit
      // after it, so of two chunks that read different files the second to look starts the copy over, whichever commits
      let filenode = p.filenode;
      // as many readers as the first chunks fill (a small table opens only the readers it has chunks for)
      const readers = recopy ? 1 : Math.max(1, Math.min(this.copyParallel, chunksToRead(p.pages, nextChunkPages(ceiling, null, this.copyChunkSeconds), p.done).length));
      const pagesDone = pagesRead(p.done, p.pages);
      const live: CopyLive = { pages: p.pages, chunksDone: p.done.length, pagesDone, rowsDone: p.rows, untaken: gapPages(gaps, p.pages),
        chunkPages: nextChunkPages(ceiling, null, this.copyChunkSeconds), readers, reading: [], rate: null,
        rowsPerPage: pagesDone > 0 ? p.rows / pagesDone : t.rows !== null && t.rows > 0 && p.pages > 0 ? t.rows / p.pages : null, diskNeeded: null };
      this.copyLive.set(t.source, live);
      for (let i = 1; i < readers; i++) {
        const lane: Lane = { conn: await this.store.instance.connect(), inFlight: false };
        lanes.push(lane);
        this.copyLanes.add(lane);
      }
      // the first failure, which every reader stops at (the others' are their interruption, or the same cause)
      let failure: { error: unknown } | null = null;
      const fail = (e: unknown): void => {
        failure ??= { error: e };
        for (const l of lanes) if (l.inFlight) l.conn.interrupt();
      };
      // the chunks since the last minute's line, and how long they took
      let lineAt = Date.now(), chunks = 0, chunkMs = 0;
      const reader = async (lane: Lane, k: number): Promise<void> => {
        const c = lane.conn;
        for (;;) {
          if (failure !== null) return;
          const sizedBy = rate;
          const range = takeChunk(gaps, p.pages, nextChunkPages(ceiling, sizedBy, this.copyChunkSeconds));
          if (range === undefined) return;
          const { first, end } = range;
          // its pages as counted when the copy began (an open-ended last chunk reads what the table grew by too)
          const chunkSize = Math.max(1, (end ?? p.pages) - first);
          const slot = { since: Date.now(), pages: chunkSize };
          live.reading.push(slot);
          live.untaken = gapPages(gaps, p.pages);
          live.chunkPages = nextChunkPages(ceiling, rate, this.copyChunkSeconds);
          const told = { source: t.source, first, end, reader: k, pages: chunkSize, ceiling, sizedBy };
          const c0 = slot.since;
          let inTx = false;
          try {
            if (!recopy) { await c.run("BEGIN TRANSACTION"); inTx = true; }
            const rows = await this.interruptible(lane, async (): Promise<number> => {
              // each chunk is a transaction, so a snapshot, of its own: held to the first one while that can tell
              if (watermark !== null) {
                const xmax = BigInt((await c.runAndReadAll(`SELECT * FROM ${pq(SNAPSHOT_SQL)}`)).getRowsJS()[0]![1] as string);
                if (!xminBeforeHolds(xmax, watermark)) {
                  throw new StartOver(`${(xmax - watermark).toLocaleString("en-US")} transactions ran on the source since its first snapshot, past what a row's age can tell apart`);
                }
              }
              const where = `ctid >= '(${first},0)'::tid${end === null ? "" : ` AND ctid < '(${end},0)'::tid`}`;
              const r = await c.run(`INSERT INTO ${side} (${named}) SELECT ${stored} FROM ${pq(`SELECT ${read} FROM ${pgFrom} WHERE ${watermark === null ? where : `${where} AND ${xminBeforeSql(watermark)}`}`)}`);
              // the table's file, under the lock this transaction's read holds until it ends: a rewrite moved its rows
              const node = Number((await c.runAndReadAll(`SELECT * FROM ${pq(`SELECT pg_relation_filenode(${pgLiteral(pgFrom)}::regclass)::bigint`)}`)).getRowsJS()[0]![0]);
              filenode ??= node;
              if (node !== filenode) {
                throw new StartOver(`the source rewrote ${t.source} since its sync began (its file changed: a VACUUM FULL, CLUSTER, TRUNCATE or column type change), so its rows moved between pages`);
              }
              const n = Number(r.rowsChanged);
              await this.onChunk?.({ ...told, rows: n, phase: "read" });
              if (!recopy) await this.recordChunk(c, t, range, n, node);
              return n;
            });
            // another reader failed while this one read (its interrupt arrived between two statements): never committed
            if (failure !== null) throw (failure as { error: unknown }).error;
            if (!recopy) await c.run("COMMIT");
            const seconds = (Date.now() - c0) / 1000;
            p = { ...p, filenode, done: [...p.done, range], rows: p.rows + rows };
            if (!recopy) kept(p);
            // the measured rate, and the copy's progress, before anything else hears of the commit
            rate = nextRate(rate, { pages: chunkSize, rows, seconds, blockSize });
            live.reading.splice(live.reading.indexOf(slot), 1);
            live.chunksDone++; live.pagesDone += chunkSize; live.rowsDone = p.rows; live.rate = rate;
            live.rowsPerPage = live.pagesDone > 0 ? live.rowsDone / live.pagesDone : live.rowsPerPage;
            live.chunkPages = nextChunkPages(ceiling, rate, this.copyChunkSeconds);
            const now = this.states.get(t.source);
            if (now !== undefined && now.phase === "copying") this.states.set(t.source, { ...now, rowsSoFar: p.rows, rowsEstimate: t.rows });
            await this.onChunk?.({ ...told, rows, phase: "committed", seconds });
            chunks++;
            chunkMs += Date.now() - c0;
          } catch (e) {
            const at = live.reading.indexOf(slot);
            if (at >= 0) live.reading.splice(at, 1);
            if (inTx) {
              try { await c.run("ROLLBACK"); }
              catch (r) { this.log(`a chunk of ${t.source}'s sync could not be rolled back after it failed (its connection is closed with the sync): ${r instanceof Error ? r.message : String(r)}`); }
            }
            fail(e);
            return;
          }
          // STOPPED BEFORE THE DISK FILLS: the chunks committed are kept, the copy fails with the way out and is tried
          // again as a failed copy is (freed disk is used at the retry, or at once at the next start)
          const short = recopy ? null : this.diskShort(t, p, disk, live);
          if (short !== null) { fail(new Error(short)); return; }
          const at = readThrough(p.done);
          if (Date.now() - lineAt >= 60_000 && at !== null) {
            this.log(`syncing ${t.source}: page ${at} of ${p.pages}${pastPages(p.done)}, ${p.rows.toLocaleString("en-US")} row(s) in; ${chunks} chunk(s) in the last minute on ${readers} reader(s), ` +
              `${(chunkMs / chunks / 1000).toFixed(1)} s each` + (rate === null ? "" : `; a reader reads ~${Math.round(rate.rowsPerSecond).toLocaleString("en-US")} rows/s ` +
              `(${humanBytes(rate.bytesPerSecond)}/s of the table's pages), so the next chunk is ${live.chunkPages} page(s), ~${this.copyChunkSeconds} s (MASON_COPY_CHUNK_SECONDS; at most ${ceiling})`));
            lineAt = Date.now(); chunks = 0; chunkMs = 0;
          }
        }
      };
      // an interrupt sent before a reader's statement began is lost: sent again until every reader has stopped
      const again = setInterval(() => { if (failure !== null) for (const l of lanes) if (l.inFlight) l.conn.interrupt(); }, 50);
      try { await Promise.all(lanes.map((lane, k) => reader(lane, k))); }
      finally { clearInterval(again); }
      if (failure !== null) throw (failure as { error: unknown }).error;
      if (recopy) await w.run("COMMIT");
      return { rows: p.rows, seconds: (Date.now() - started) / 1000, progress: p };
    } catch (e) {
      // a failure or a stop: nothing in flight any more (a copy that read every chunk keeps its progress to its swap, `copy`)
      this.copyLive.delete(t.source);
      if (recopy) await w.run("ROLLBACK");
      throw e;
    } finally {
      for (const lane of lanes.slice(1)) { this.copyLanes.delete(lane); lane.conn.closeSync(); }
    }
  }

  /** A COPY BEGUN, in a transaction of its own: the source's snapshot read FIRST (the transaction's first read fixes the
   *  extension's REPEATABLE READ snapshot; its xmin is the copy's watermark, as the change reader records one before its
   *  copy), the exact numerics' widths, the side table (NO KEY: no PRIMARY KEY or UNIQUE, so no index), and the heap's
   *  pages now (`pg_relation_size`, exact where `relpages` is an estimate) */
  private async beginCopy(t: AddedTable, side: string, pgFrom: string): Promise<CopyProgress> {
    const w = this.rebuilder.conn;
    const snapshot = this.mode !== "recopy" ? ((await w.runAndReadAll(`SELECT * FROM ${pq(SNAPSHOT_SQL)}`)).getRowsJS()[0] as [string, string])[0] : null;
    const described = await w.runAndReadAll(`DESCRIBE SELECT ${t.columns.map((c) => ident(c.name)).join(", ")} FROM ${SRC}.${ident(t.schema)}.${ident(t.table)}`);
    const scanned = new Map((described.getRowsJS() as unknown[][]).map((r) => [String(r[0]), String(r[1])]));
    // a domain's column as its base type reads: the extension's scan of the table does not know a domain
    const domains = t.columns.filter((c) => c.domain === true);
    if (domains.length > 0) {
      const read = await w.runAndReadAll(`DESCRIBE SELECT * FROM ${pq(`SELECT ${domains.map((c) => pgColumnSql(c, new Map(), new Set())).join(", ")} FROM ${pgFrom} LIMIT 0`)}`);
      for (const r of read.getRowsJS() as unknown[][]) scanned.set(String(r[0]), String(r[1]));
    }
    // the numerics the extension would read as doubles: their widths, in the copy's snapshot (NUMERIC_TYPE)
    const exact = await this.exactNumerics(t, scanned, pgFrom);
    const defs = t.columns.map((c) => `${ident(c.name)} ${exact.has(c.name) ? `DECIMAL(38,${exact.get(c.name)})` : storedType(c, scanned.get(c.name) ?? "VARCHAR")}`);
    await w.run(`CREATE SCHEMA IF NOT EXISTS ${ident(t.schema)}`);
    await w.run(`CREATE OR REPLACE TABLE ${side} (${defs.join(", ")})`);
    const pages = Number((await w.runAndReadAll(`SELECT * FROM ${pq(`SELECT (pg_relation_size(${pgLiteral(pgFrom)}::regclass) / current_setting('block_size')::int)::bigint`)}`)).getRowsJS()[0]![0]);
    const ceiling = chunkPages(pages, t.rows, this.copyChunkRows);
    const firstSize = nextChunkPages(ceiling, null, this.copyChunkSeconds);
    const readers = this.mode === "recopy" ? 1 : Math.min(this.copyParallel, Math.max(1, Math.ceil(pages / firstSize)));
    this.log(`syncing ${t.source}${snapshot === null ? "" : ` as of the source's snapshot ${snapshot}: what commits after it is caught up by one poll once read`}; ` +
      `${pages} page(s) in chunks sized to ~${this.copyChunkSeconds} s of reading each at the rate measured here (MASON_COPY_CHUNK_SECONDS; at most ${ceiling} page(s)), ` +
      `the first of ${firstSize} page(s) to measure it, ${readers === 1 ? "one at a time" : `${readers} at a time (MASON_COPY_PARALLEL), each a backend on the database`}`);
    return { snapshot, columns: columnsKey(t.columns), exact, filenode: null, pages, done: [], rows: 0 };
  }

  /** what a copy was begun with, in its beginning's transaction (`CopyProgress`) */
  private async writeBegun(t: AddedTable, p: CopyProgress): Promise<void> {
    await this.rebuilder.conn.run(`INSERT OR REPLACE INTO ${MASON_SCHEMA}.copy_progress VALUES (${literal(t.source)}, ${p.snapshot === null ? "NULL" : literal(p.snapshot)}, ` +
      `${literal(p.columns)}, ${literal(JSON.stringify([...p.exact]))}, ${p.pages}, now())`);
  }

  /** a chunk committed, in its own transaction on its reader's connection (`CopyProgress`): appended, never an update */
  private async recordChunk(c: DuckConnection, t: AddedTable, r: PageRange, rows: number, filenode: number): Promise<void> {
    await c.run(`INSERT INTO ${MASON_SCHEMA}.copy_chunks VALUES (${literal(t.source)}, ${r.first}, ${r.end === null ? "NULL" : r.end}, ${rows}, ${filenode}, now())`);
  }

  /**
   * A COPY BEGUN BEFORE, TO CONTINUE (`copy`): what it was begun with, its committed chunks and its side table, when its
   * columns are the ones it was begun with — said, with where it continues and the first snapshot it is held to.
   * Otherwise null, and what it left is dropped (`forgetCopy`), said when there was something.
   */
  private async resumable(t: AddedTable, side: string): Promise<CopyProgress | null> {
    const w = this.rebuilder.conn;
    const r = (await w.runAndReadAll(`SELECT snapshot, columns, exact, pages FROM ${MASON_SCHEMA}.copy_progress WHERE source = ${literal(t.source)}`)).getRowsJS();
    const there = (await w.runAndReadAll(`SELECT count(*) FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = ${literal(t.schema)} AND table_name = ${literal(`${t.table}${SIDE_SUFFIX}`)}`)).getRowsJS()[0]![0] === 1n;
    const row = r[0] as [string | null, string, string, bigint] | undefined;
    if (row === undefined || row[0] === null || row[1] !== columnsKey(t.columns) || !there) {
      if (row !== undefined) this.log(`starting the sync of ${t.source} over, from its first page: ${!there ? "the table it was filling is gone" : row[0] === null ? "it was begun as a recopy" : "its columns are not the ones its sync was begun with"}`);
      return this.forgetCopy(t, side);
    }
    const chunks = (await w.runAndReadAll(`SELECT first_page, end_page, "rows", filenode FROM ${MASON_SCHEMA}.copy_chunks WHERE source = ${literal(t.source)} ORDER BY first_page`)).getRowsJS() as Array<[bigint, bigint | null, bigint, bigint]>;
    const done = chunks.map(([first, end]) => ({ first: Number(first), end: end === null ? null : Number(end) }));
    const rows = chunks.reduce((n, c) => n + Number(c[2]), 0);
    const p: CopyProgress = { snapshot: row[0], columns: row[1], exact: new Map(JSON.parse(row[2]) as Array<[string, number]>), filenode: chunks.length ? Number(chunks[0]![3]) : null, pages: Number(row[3]), done, rows };
    const at = readThrough(done);
    this.log(at === null ? `resuming the sync of ${t.source} with every page read (${rows} row(s) in): its swap is next`
      : `resuming the sync of ${t.source} at page ${at} of ${p.pages}${pastPages(done)}, ${rows} row(s) in, held to its first snapshot ${p.snapshot}: the pages read before are not read again`);
    const now = this.states.get(t.source);
    if (now !== undefined && now.phase === "copying") this.states.set(t.source, { ...now, rowsSoFar: rows, rowsEstimate: t.rows });
    return p;
  }

  /**
   * A COPY IN PROGRESS RECORDED BY A MASON OF ONE READER (before copies read in parallel chunks): one progress row whose
   * `next_page` was the page before which every page was read (null: every page). Turned into the chunk it amounts to,
   * so that copy continues where it was rather than reading the source again, and the row's last three columns dropped.
   */
  private async oneReaderProgress(): Promise<void> {
    const w = this.store.writer;
    const old = (await w.runAndReadAll(`SELECT count(*) FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = ${literal(MASON_SCHEMA)} ` +
      `AND table_name = 'copy_progress' AND column_name = 'next_page'`)).getRowsJS()[0]![0] as bigint;
    if (old === 0n) return;
    await w.run("BEGIN TRANSACTION");
    try {
      const moved = Number((await w.run(`INSERT INTO ${MASON_SCHEMA}.copy_chunks SELECT source, 0, next_page, "rows", filenode, updated_at FROM ${MASON_SCHEMA}.copy_progress ` +
        `WHERE snapshot IS NOT NULL AND filenode IS NOT NULL AND (next_page IS NULL OR next_page > 0)`)).rowsChanged);
      for (const gone of ["filenode", "next_page", "rows"]) await w.run(`ALTER TABLE ${MASON_SCHEMA}.copy_progress DROP COLUMN IF EXISTS ${ident(gone)}`);
      await w.run("COMMIT");
      if (moved > 0) this.log(`${moved} sync(s) in progress were begun by a Mason that read one chunk at a time: each continues where it was`);
    } catch (e) {
      await w.run("ROLLBACK");
      throw e;
    }
  }

  /** a copy's side table and progress dropped (on the rebuilds' connection, outside a transaction): its next attempt
   *  starts from the first page. Answers null, the progress there is now */
  private async forgetCopy(t: AddedTable, side: string): Promise<null> {
    const w = this.rebuilder.conn;
    await w.run(`DROP TABLE IF EXISTS ${side}`);
    await w.run(`DELETE FROM ${MASON_SCHEMA}.copy_progress WHERE source = ${literal(t.source)}`);
    await w.run(`DELETE FROM ${MASON_SCHEMA}.copy_chunks WHERE source = ${literal(t.source)}`);
    return null;
  }

  /**
   * THE COPIES IN A RETIRED LAYOUT (`RETIRED_LAYOUT`), read at `open`: a copied table that carries a primary-key or
   * unique constraint was stored in key order with that key's index (the earlier layout). Each is said by name and copied
   * again through the normal path (`needsCopy`), serving as it was until its swap; never converted in place.
   */
  private async findRetired(): Promise<void> {
    const r = await this.store.writer.runAndReadAll(`SELECT DISTINCT schema_name || '.' || table_name FROM duckdb_constraints() ` +
      `WHERE database_name = current_database() AND schema_name <> ${literal(MASON_SCHEMA)} AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')`);
    for (const [source] of r.getRowsJS() as Array<[string]>) {
      if (this.states.get(source)?.phase !== "copied") continue;
      this.retired.set(source, { layout: RETIRED_LAYOUT, short: "in an older Mason's layout, key order with an index" });
      this.log(`${source}: it is ${RETIRED_LAYOUT} — its rows are sorted on disk, and only the source has them in its own order, so it is read again whole; its synced data serves as it was until then`);
    }
    await this.findHeldLayout();
  }

  /**
   * THE COPIES AN OLDER MASON MADE BEFORE A TYPE WAS HELD AS ITS TEXT (`HELD_LAYOUT`), read at `open` from what each copy
   * physically is, never from its record alone: a record written before `typeKind` was read says neither that a column
   * is an enum nor how a held one was stored. Each copied column is held to what `storedType` makes of it now: an ENUM is
   * an enum (its record completed, so its key is the one a fresh read makes, and it is not read again for nothing); a
   * column held as its text that is not a VARCHAR (a `point` as the extension's STRUCT) marks the table, said by name and
   * copied again through the normal path (`needsCopy`), serving as it was until its swap.
   */
  private async findHeldLayout(): Promise<void> {
    const r = await this.store.writer.runAndReadAll(`SELECT schema_name || '.' || table_name, column_name, data_type FROM duckdb_columns() ` +
      `WHERE database_name = current_database() AND schema_name <> ${literal(MASON_SCHEMA)}`);
    const physical = new Map<string, Map<string, string>>();
    for (const [source, column, type] of r.getRowsJS() as Array<[string, string, string]>) {
      const m = physical.get(source) ?? new Map<string, string>();
      m.set(column, type);
      physical.set(source, m);
    }
    for (const [source, columns] of this.copiedColumns) {
      const types = physical.get(source);
      if (this.states.get(source)?.phase !== "copied" || types === undefined || this.retired.has(source)) continue;
      const mis: string[] = [];
      const completed = columns.map((c) => {
        const type = types.get(c.name);
        if (type === undefined) return c;
        if (c.typeKind === undefined && type.startsWith("ENUM(")) return { ...c, typeKind: "e" };
        const hold = holdOf(c.type, c.typeKind);
        const want = hold === "text" ? "VARCHAR" : hold === "text[]" ? "VARCHAR[]" : null;
        if (want !== null && type !== want) mis.push(`${c.name} (${c.type})`);
        return c;
      });
      this.copiedColumns.set(source, completed);
      this.copiedAs.set(source, columnsKey(completed));
      if (mis.length === 0) continue;
      this.retired.set(source, { layout: HELD_LAYOUT, short: `in an older Mason's layout, ${mis.join(", ")} not held as the source's text` });
      this.log(`${source}: it is ${HELD_LAYOUT} (${mis.join(", ")}) — it is read again whole; its synced data serves as it was until then`);
    }
  }

  /** what a copy of the retired layout left beside the file (in that layout a copy was staged in a file of its own,
   *  `<file>.stage-<table>.db`, and partitioned into parquet parts beside it, `….parts`): removed, said */
  private removeStageLeftovers(): void {
    const dir = path.dirname(this.store.file), base = `${path.basename(this.store.file)}.stage-`;
    for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(base))) {
      fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      this.log(`removed ${f}: a sync's stage, from an older Mason (a sync now reads the source once, straight into its table)`);
    }
  }

  /** The table's numerics the extension would read as doubles, each with the DECIMAL(38, s) scale that holds every value
   *  (NUMERIC_TYPE); one whose values do not fit is left out (a double, said). */
  private async exactNumerics(t: AddedTable, scanned: ReadonlyMap<string, string>, pgFrom: string): Promise<Map<string, number>> {
    const wide = t.columns.filter((c) => readsAsDouble(c.type) && scanned.get(c.name) === "DOUBLE");
    const out = new Map<string, number>();
    if (wide.length === 0) return out;
    const parts = wide.map((c) => {
      const v = pgIdent(c.name);
      const finite = `${v}::text NOT IN ('NaN', 'Infinity', '-Infinity')`;
      return `max(scale(${v})) FILTER (WHERE ${finite}), min(scale(${v})) FILTER (WHERE ${finite}), max(scale(trim_scale(${v}))) FILTER (WHERE ${finite}), ` +
        `max(length(trunc(abs(${v}))::text)) FILTER (WHERE ${finite}), count(*) FILTER (WHERE NOT ${finite})`;
    });
    // in the copy's transaction, on the rebuilds' connection: its snapshot
    const row = (await this.rebuilder.conn.runAndReadAll(`SELECT * FROM ${pq(`SELECT ${parts.join(", ")} FROM ${pgFrom}`)}`)).getRowsJS()[0] as Array<bigint | number | null>;
    wide.forEach((c, k) => {
      const [maxScale, minScale, used, digits, special] = row.slice(5 * k, 5 * k + 5).map((x) => x === null ? null : Number(x));
      const declared = NUMERIC_TYPE.exec(c.type)!;
      const scale = declared[1] !== undefined ? used ?? 0 : maxScale ?? 0;
      const width = (digits ?? 1) + scale;
      if ((special ?? 0) > 0) { this.log(`${t.source}.${c.name}: ${special} value(s) NaN or Infinity, which the synced table's DECIMAL cannot hold: synced as a double`); return; }
      if (scale > 38 || width > 38) { this.log(`${t.source}.${c.name}: values of ${digits ?? 1} digit(s) and ${scale} decimal(s) do not fit the synced table's DECIMAL(38): synced as a double (15 significant digits)`); return; }
      if (declared[1] === undefined && minScale !== null && minScale !== maxScale) this.log(`${t.source}.${c.name}: values of ${minScale} to ${maxScale} decimals: Mason answers each with ${scale}, Postgres with its own`);
      out.set(c.name, scale);
    });
    return out;
  }

  /** the exact numerics (NUMERIC_TYPE) of a copied table, from the copy's own DECIMAL columns (on the connection of the
   *  caller's transaction) */
  private async exactOf(t: AddedTable, c: DuckConnection = this.store.writer): Promise<Map<string, number>> {
    const rows = (await c.runAndReadAll(`SELECT column_name, numeric_scale FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema = ${literal(t.schema)} AND table_name = ${literal(t.table)} AND data_type LIKE 'DECIMAL(38,%'`)).getRowsJS() as Array<[string, number]>;
    const numerics = new Set(t.columns.filter((c) => readsAsDouble(c.type)).map((c) => c.name));
    return new Map(rows.filter(([name]) => numerics.has(name)).map(([name, scale]) => [name, Number(scale)]));
  }

  /** the state, kept and written to the ledger, on the connection of the flow that knows it (awaited, and on the
   *  writer only on its turn: a statement on a connection lands inside the transaction open there). The table's row is
   *  that flow's alone while it writes it (a rebuild's table is not polled or streamed until caught up) */
  private async record(s: CopyState, columns?: readonly SourceColumnInfo[], c: DuckConnection = this.store.writer): Promise<void> {
    // A COPY CURRENT AGAIN after its poll, catch-up or stream failed (its error cleared by the flow that keeps it current,
    // never by a copy of it: that is its own `copied` event) — the one place an error is cleared, so the one place said
    const was = this.states.get(s.source);
    if (was !== undefined && was.error !== null && s.error === null && was.phase === "copied" && s.phase === "copied" && was.copiedAt === s.copiedAt) {
      this.event({ kind: "recovered", table: s.source, message: `current again (it had failed: ${was.error.split("\n")[0]})` });
    }
    this.states.set(s.source, s);
    const v = (x: string | number | null): string => x === null ? "NULL" : typeof x === "number" ? String(x) : literal(x);
    const sql = `INSERT OR REPLACE INTO ${MASON_SCHEMA}.copy_state (source, phase, "rows", bytes, seconds, copied_at, error, columns) VALUES (${literal(s.source)}, ${literal(s.phase)}, ${v(s.rows)}, ${v(s.bytes)}, ${v(s.seconds)}, ` +
      `${s.copiedAt === null ? "NULL" : `${literal(s.copiedAt)}::TIMESTAMPTZ`}, ${v(s.error)}, ${columns ? `${literal(JSON.stringify(columns))}::JSON` : `(SELECT columns FROM ${MASON_SCHEMA}.copy_state WHERE source = ${literal(s.source)})`})`;
    // the ledger is the record the commands read: a failed write is said, never silent, and the copy itself stands
    try { await c.run(sql); }
    catch (e) { this.log(`recording ${s.source}'s sync state failed: ${e instanceof Error ? e.message : String(e)}`); }
  }

  /** the catalog rebuilt (`schemaBuilt`), after any rebuild already under way */
  private rebuildSchema(): Promise<void> {
    // after the one before, whether it succeeded or failed (its failure is its own caller's to say)
    const next = this.schemaBuild.then(() => this.schemaBuilt(), () => this.schemaBuilt());
    this.schemaBuild = next;
    return next;
  }

  /** the catalog's tables: every copied table as DuckDB holds it, typed as the source spells it where the wire agrees */
  private async schemaBuilt(): Promise<void> {
    // its own connection, which sees what is committed: never the writer, which a copy's transaction may hold for hours
    const c = this.catalog ?? this.store.writer;
    const r = await c.runAndReadAll(`SELECT source, columns FROM ${MASON_SCHEMA}.copy_state WHERE phase = 'copied'`);
    const copied = new Map((r.getRowsJS() as [string, string | null][]).map(([s, c]) => [s, c === null ? [] : JSON.parse(c) as SourceColumnInfo[]]));
    const tables: PgTable[] = [];
    for (const t of this.tables.values()) {
      const cols = copied.get(t.source);
      if (cols === undefined) continue;
      const types = await c.prepare(`SELECT * FROM ${ident(t.schema)}.${ident(t.table)} LIMIT 0`);
      const duckTypes = new Map(Array.from({ length: types.columnCount }, (_, i) => [types.columnName(i), types.columnType(i)] as const));
      types.destroySync();
      // the column's constraints and default — and below the table's keys and unique indexes — as the source had them
      // when the tables were last set (`setTables`: at mason start, and at mason add / remove; the run's 10-second
      // catalog read reaches the commands' facts, not this): what the copy recorded describes its types, which a
      // change of recopies
      const now = new Map(t.columns.map((c) => [c.name, c]));
      const columns: PgColumn[] = cols.filter((c) => duckTypes.has(c.name)).map((c) => pgColumn(c, duckTypes.get(c.name)!, now.get(c.name)));
      const joins: PgJoin[] = t.foreignKeys.filter((f) => this.tables.has(f.target) && columns.some((c) => c.name === f.column))
        .map((f) => ({ name: f.target.split(".")[1]!, table: f.target, on: [f.column, f.targetColumn], relationship: "many_to_one" }));
      // a unique index over columns the copy keeps: the catalog's too, so a foreign key to it is one (and pg_indexes lists it)
      const uniqueKeys = (t.uniqueKeys ?? []).filter((u) => u.columns.every((c) => columns.some((x) => x.name === c)));
      tables.push({ name: t.table, schema: t.schema, primaryKey: t.primaryKey ?? t.key, columns, joins,
        ...(uniqueKeys.length ? { uniqueKeys } : {}),
        ...(t.rowTypeOid !== undefined && columns.length === cols.length ? { rowTypeOid: t.rowTypeOid } : {}) });
    }
    // ONE SOURCE OF AN ENUM'S LABELS, the synced table's ENUM: a generated table stores the ENUM it was built with, which
    // a value added since (ALTER TYPE … ADD VALUE, re-copied) is not in, so its column declares the type by the synced
    // labels; its own only where no synced column has the type
    const synced = new Map(tables.flatMap((t) => t.columns.flatMap((x) => x.enumLabels !== undefined && x.spelled !== undefined ? [[x.spelled.replace(/\[\]$/, ""), x.enumLabels] as const] : [])));
    // each generated table served, as a copy of its output's types: no key, no joins
    for (const g of this.generated.served()) {
      const types = await c.prepare(`SELECT * FROM ${ident(g.schema)}.${ident(g.table)} LIMIT 0`);
      const duckTypes = new Map(Array.from({ length: types.columnCount }, (_, i) => [types.columnName(i), types.columnType(i)] as const));
      types.destroySync();
      const columns = g.columns.filter((x) => duckTypes.has(x.name)).map((x) => pgColumn({ name: x.name, type: x.type, notNull: false, comment: null }, duckTypes.get(x.name)!, undefined))
        .map((x) => { const labels = x.enumLabels !== undefined && x.spelled !== undefined ? synced.get(x.spelled.replace(/\[\]$/, "")) : undefined; return labels === undefined ? x : { ...x, enumLabels: labels }; });
      tables.push({ name: g.table, schema: g.schema, primaryKey: [], columns, joins: [], ...(g.comment !== null ? { description: g.comment } : {}) });
    }
    const views = this.views;
    const key = JSON.stringify([tables, views]);
    if (key !== this.schemaKey) { this.schemaKey = key; this.currentSchema = { database: this.currentSchema.database, tables, ...(views.length > 0 ? { views } : {}) }; }
  }
}

const KEPT_ARRAYS = new Set(["json[]", "jsonb[]", "inet[]", "citext[]"]);

/** the columns of a DuckDB table stored as a LIST of ENUM (`pgColumnSql`), on the connection of the caller's
 *  transaction: an enum array is named by its stored type, never its source spelling (`mood[]`, `other.level[]`) */
async function enumLists(c: DuckConnection, table: string): Promise<Set<string>> {
  return new Set(((await c.runAndReadAll(`DESCRIBE ${table}`)).getRowsJS() as unknown[][]).filter((r) => /^ENUM\(.*\)\[\]$/s.test(String(r[1]))).map((r) => String(r[0])));
}

/** a column as `postgres_query` reads it: an exact numeric as its text (DECIMAL takes it digit for digit); a kept array
 *  as text[] — the extension reads a query's citext[] or inet[] as one VARCHAR, a table's as a VARCHAR[] (the corpus
 *  run of fbbf8f08: a table with both an unbounded numeric and a citext[] could not be copied) — and so is an enum
 *  array (`enumLists`: one VARCHAR, '{sad,ok}', which DuckDB cannot cast to its ENUM(...)[]; text[] it casts element by
 *  element). Found once every chunk of a copy read through `postgres_query`: the oracle's enum array failed to
 *  copy; the poll's read of a changed one had failed the same way */
function pgColumnSql(c: SourceColumnInfo, exact: ReadonlyMap<string, number>, lists: ReadonlySet<string>): string {
  if (exact.has(c.name)) return `${pgIdent(c.name)}::text AS ${pgIdent(c.name)}`;
  const hold = holdOf(c.type, c.typeKind);
  if (KEPT_ARRAYS.has(c.type) || lists.has(c.name) || hold === "text[]") return `${pgIdent(c.name)}::text[] AS ${pgIdent(c.name)}`;
  if (hold === "text") return `${pgIdent(c.name)}::text AS ${pgIdent(c.name)}`;
  // a domain's value as its base type, which the extension reads
  return c.domain === true ? `${pgIdent(c.name)}::${c.type} AS ${pgIdent(c.name)}` : pgIdent(c.name);
}

const API_TYPE: Record<number, PgApiType> = { 21: "int2", 23: "int4", 20: "int8", 700: "float4", 701: "float8", 1700: "numeric", 25: "text", 16: "bool", 2950: "uuid", 1082: "date", 1184: "timestamptz", 3802: "jsonb" };

/** an ENUM's labels, of the column or of its list's element; null for any other type */
function enumLabelsOf(t: DuckDBType): readonly string[] | null {
  const own = t instanceof DuckDBListType ? t.valueType : t;
  return own instanceof DuckDBEnumType ? own.values : null;
}

/**
 * A copied column in the catalog: ALWAYS the source's type, as the source spells it (`numeric(12,2)`, `character
 * varying(255)`, `time with time zone`, `point`), so a tool sees the source's own types whatever the copy holds
 * (src/duck/held-types.ts) — but for the one the copy computes as another: a `numeric` past DuckDB's DECIMAL, read as
 * DOUBLE, is `double precision` on the catalog as on the wire (the limits `numeric-over-38-digits`, `numeric-array`).
 */
function pgColumn(c: SourceColumnInfo, duck: DuckDBType, now: SourceColumnInfo | undefined): PgColumn {
  const wire = wireColumn(c.name, duck).oid;
  // an enum (or an array of one) DuckDB holds as its ENUM, in the declared order: declared with its labels, so Postgres
  // orders and compares it by them
  const labels = enumLabelsOf(duck);
  const double = c.type.startsWith("numeric") ? wire === 701 ? "double precision" : wire === 1022 ? "double precision[]" : null : null;
  const spelled = double ?? c.type;
  const kind = (now ?? c).typeKind ?? c.typeKind;
  // a type a database made, held as its text: the catalog declares it as a type with nothing over it
  const made = c.typeOid !== undefined && labels === null && holdOf(c.type, kind) !== "same" ? kind === "c" ? "row" as const : true : undefined;
  // `type` is the ClickHouse path's; the catalog reads `spelled`
  const type: PgApiType = API_TYPE[wire] ?? "text";
  const facts = now ?? c;
  return { name: c.name, type, spelled, ...(c.comment ? { description: c.comment } : {}), ...(labels !== null ? { enumLabels: labels } : {}), ...(made !== undefined ? { made } : {}),
    ...(facts.notNull ? { notNull: true } : {}), ...(facts.default !== undefined ? { default: facts.default } : {}),
    ...(facts.identity !== undefined ? { identity: facts.identity } : {}), ...(facts.sequence !== undefined ? { sequence: facts.sequence } : {}),
    // a number, whatever spelling the column's record kept (an oid is a string in Postgres's JSON, and a copy's columns are JSON)
    ...(c.typeOid !== undefined && double === null ? { typeOid: Number(c.typeOid), ...(c.typeArrayOid !== undefined ? { typeArrayOid: Number(c.typeArrayOid) } : {}) } : {}) };
}

/** a span as the stream's line says it: `2.1 s`, `3 min`, `2 h` */
function secondsText(ms: number): string {
  const sec = Math.max(0, ms) / 1000;
  return sec < 90 ? `${sec.toFixed(1)} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`;
}
