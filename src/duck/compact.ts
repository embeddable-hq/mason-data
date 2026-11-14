/**
 * A SYNCED TABLE COMPACTED BY MASON ITSELF (issue 851; docs/DESIGN.md "Compaction"). The instance's checkpoint merges no
 * row groups (`max_vacuum_tasks` 0, src/duck/store.ts `INSTANCE_SETTINGS`, issue 371: such a merge that did not fit the
 * memory invalidated the whole database), so two things are never given back by the engine:
 *  - DEAD ROWS: a table written by key (the poll, the stream: its keys deleted, its rows inserted) keeps every deleted
 *    row's space and reads past it, until a whole row group is deleted;
 *  - SMALL ROW GROUPS: after each checkpoint the next append to a table starts a row group of its own, at least one
 *    block (256 KiB) however few its rows, and none is ever merged.
 *
 * What is wasted is estimated from the table's own facts (`readShape`: the rows it stores, deleted ones included —
 * `duckdb_tables().estimated_size` — its row groups and blocks — `pragma_storage_info`, metadata only, as the usage
 * sampler sizes a copy — and the live rows the sync counts), and a table is compacted when that waste is at least
 * `COMPACT_WASTE_SHARE` of its blocks and at least `COMPACT_MIN_WASTE_BLOCKS` blocks (`wasteOf`; the measurement is in
 * docs/DESIGN.md). Wide values make big row groups, so a table of few rows of large values is not rewritten for its
 * row-group count alone.
 *
 * THE REWRITE IS AN ORDINARY STATEMENT, never a checkpoint's (`rewrite`): the table's rows into a side table
 * `<table>__mason_compact` of the same columns, in their order (heap order kept), a piece of rows by rowid at a time, each
 * piece its own transaction, sized to `COMPACT_MEMORY_SHARE` of `store.memoryLimitBytes` (`pieceRows`) and halved at
 * every out-of-memory (53200, a statement's or its commit's), as the first sync's chunks are. Measured: one statement
 * over a table of ~400 MiB of 100 KB values failed at its COMMIT at 128 and 256 MB (`failed to pin block`), the
 * database valid; in pieces it fits. A piece of one row that does not fit fails the compaction alone (`CompactTooLarge`).
 * The caller swaps the side table in on the writer's turn, the table frozen meanwhile (src/duck/sync.ts `compact`).
 */
import type { DuckConnection } from "./executor.ts";
import type { KeyChange } from "./stream.ts";
import { endedTransaction, pgErrorOf } from "./store.ts";

/** DuckDB's row group: a compacted table holds its rows in row groups of this many (the last one fewer) */
export const ROW_GROUP_ROWS = 122_880;
/** a table is compacted when what it wastes is at least this share of its blocks: it is then at least twice what its
 *  compaction leaves (docs/DESIGN.md "Compaction": the cost of a rewrite against the growth, measured) */
export const COMPACT_WASTE_SHARE = 0.5;
/** ... and at least this many blocks (4 MiB at DuckDB's 256 KiB): a small table is never rewritten for a few blocks */
export const COMPACT_MIN_WASTE_BLOCKS = 16;
/** a piece of the rewrite holds at most this share of the memory limit, by its rows' size on disk times
 *  `COMPACT_ROW_EXPANSION` (as a first sync's chunk holds an eighth of it, src/duck/sync.ts COPY_CHUNK_MEMORY_SHARE) */
export const COMPACT_MEMORY_SHARE = 1 / 8;
/** a row in memory against its bytes on disk, at most: forced zstd stores text 2.5 to 4.5 times smaller, and a first
 *  sync measured a jsonb's read at about 5.5 times its bytes (docs/DESIGN.md "Large values out of line") */
export const COMPACT_ROW_EXPANSION = 8;
/** a piece is at most this many row groups' rows: a piece commits whole row groups (and one partial one at its end) */
export const COMPACT_MAX_PIECE_ROWS = 8 * ROW_GROUP_ROWS;
/** the least room on disk a compaction leaves beside what it writes (src/duck/sync.ts `diskShortFor`): the log, and the
 *  checkpoint after the swap, which frees the old table's blocks only once it has written what the pieces left */
export const COMPACT_DISK_MARGIN_BYTES = 64 * 2 ** 20;
/** the side table a compaction fills, beside its table, dropped when the compaction ends either way and at every open */
export const COMPACT_SIDE_SUFFIX = "__mason_compact";

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** A synced table's facts as stored: rows `live` (the sync's count) and `stored` (deleted ones included), its row
 *  groups and blocks as of the last checkpoint, and the block's size. */
export interface TableShape { live: number; stored: number; rowGroups: number; blocks: number; blockSize: number }

/** The table's facts (`TableShape`), read on `c` from the engine's catalog: metadata only, never a scan unless the
 *  live rows are not known (`live` null: counted). Null: the table is not there (dropped since it was asked). */
export async function readShape(c: Pick<DuckConnection, "runAndReadAll">, schema: string, table: string, live: number | null): Promise<TableShape | null> {
  const t = (await c.runAndReadAll(`SELECT estimated_size FROM duckdb_tables() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2`, [schema, table])).getRowsJS();
  if (t.length === 0) return null;
  const stored = Number(t[0]![0]);
  const q = `${ident(schema)}.${ident(table)}`;
  // its row groups and distinct blocks, the overflow blocks of long strings included (src/duck/usage.ts sizes a copy so)
  const [rowGroups, blocks] = (await c.runAndReadAll(`WITH s AS (SELECT row_group_id, block_id, additional_block_ids FROM pragma_storage_info($1) WHERE persistent), ` +
    `b AS (SELECT block_id FROM s WHERE block_id >= 0 UNION SELECT unnest(additional_block_ids) FROM s) SELECT (SELECT count(DISTINCT row_group_id) FROM s), (SELECT count(*) FROM b)`, [q])).getRowsJS()[0]!.map(Number) as [number, number];
  const blockSize = Number((await c.runAndReadAll("SELECT block_size FROM pragma_database_size() WHERE database_name = current_database()")).getRowsJS()[0]?.[0] ?? 262_144);
  const rows = live ?? Number((await c.runAndReadAll(`SELECT count(*) FROM ${q}`)).getRowsJS()[0]![0]);
  return { live: rows, stored, rowGroups, blocks, blockSize };
}

/** What a table wastes (`TableShape`), and whether it is compacted for it. */
export interface Waste {
  /** the share of its stored rows that are deleted (a row updated by key counts once, its old version) */
  deadShare: number;
  /** its row groups past the fewest its live rows fill */
  extraRowGroups: number;
  /** its blocks, in bytes, and what of them is waste: the dead rows' share of them, and a block per extra row group */
  bytes: number; wasteBytes: number;
  due: boolean;
}

export function wasteOf(s: TableShape, o: { share?: number; minBlocks?: number } = {}): Waste {
  const share = o.share ?? COMPACT_WASTE_SHARE, minBlocks = o.minBlocks ?? COMPACT_MIN_WASTE_BLOCKS;
  const deadShare = s.stored > 0 ? Math.max(0, Math.min(1, 1 - s.live / s.stored)) : 0;
  const extraRowGroups = Math.max(0, s.rowGroups - Math.max(1, Math.ceil(s.live / ROW_GROUP_ROWS)));
  const bytes = s.blocks * s.blockSize;
  // the two add up: a write by key leaves its deleted rows in the old row groups and its new rows in a row group of
  // their own at each checkpoint (measured: 300,000 rows churned 5 % a round grew 27 → 63 blocks in 12 rounds, the
  // dead rows' share 23.6 of them and the 12 extra row groups 12). Where both are one (a small row group's rows deleted)
  // it is counted twice, which compacts a little early, never late; never past the table's blocks
  const wasteBytes = Math.min(bytes, deadShare * bytes + extraRowGroups * s.blockSize);
  return { deadShare, extraRowGroups, bytes, wasteBytes, due: bytes > 0 && wasteBytes >= share * bytes && wasteBytes >= minBlocks * s.blockSize };
}

/** A piece's rows: `COMPACT_MEMORY_SHARE` of the memory limit over a row's bytes on disk times `COMPACT_ROW_EXPANSION`,
 *  at least one and at most `COMPACT_MAX_PIECE_ROWS`. A sizing decision: it reads the limit the operator set
 *  (`store.memoryLimitBytes`), never a constant. */
export function pieceRows(memoryLimitBytes: number, s: Pick<TableShape, "stored" | "blocks" | "blockSize">): number {
  const perRow = s.stored > 0 && s.blocks > 0 ? (s.blocks * s.blockSize / s.stored) * COMPACT_ROW_EXPANSION : 0;
  if (perRow === 0) return COMPACT_MAX_PIECE_ROWS;
  return Math.max(1, Math.min(COMPACT_MAX_PIECE_ROWS, Math.floor(memoryLimitBytes * COMPACT_MEMORY_SHARE / perRow)));
}

/** One row read alone ran out of memory: the table cannot be compacted under this limit (it serves as it is). */
export class CompactTooLarge extends Error {}
/** The disk has no room for the rows left to write: stopped before the piece that would have filled it. */
export class CompactNoRoom extends Error {}

/** what marks a column an UPDATE left unchanged (pgoutput sent no value) in a spilled change: JSON has no undefined */
const UNCHANGED = { unchanged: true };
/** A key's change as a spill's text (src/duck/sync.ts `spill`), and back (`unspilled`): every value's text, null, or
 *  the column left unchanged — never confused, so a replayed partial row keeps the table's value where it carried none. */
export const spilled = (c: KeyChange): string => JSON.stringify(c, (_k, v: unknown) => v === undefined ? UNCHANGED : v);
export function unspilled(text: string): KeyChange {
  const c = JSON.parse(text) as { kind: "delete" } | { kind: "row"; values: unknown[]; refetch?: true };
  if (c.kind === "delete") return { kind: "delete" };
  const values = c.values.map((v) => v !== null && typeof v === "object" ? undefined : v as string | null);
  return c.refetch ? { kind: "row", values, refetch: true } : { kind: "row", values };
}

/**
 * THE TABLE'S ROWS INTO ITS SIDE TABLE, in pieces (the module's header), on `c`, whose statements `run` runs (the sync's
 * interruptible lane: `mason stop` interrupts a piece, which rolls back). The table must not be written meanwhile (the
 * caller holds its writes). Answers the rows written, held equal to the table's count: never a half table swapped in.
 * The side table is left for the caller to swap in, or to drop on a failure (`dropSide`).
 */
export interface RewriteHooks {
  /** runs a piece's statements (the sync's interruptible lane); else `c.run` */
  run?: (sql: string) => Promise<void>;
  /** a line for the log (a piece out of memory) */
  said?: (line: string) => void;
  /** awaited before each piece is read: a test holds the compaction there, as `heldCopy` holds a first sync */
  beforePiece?: () => Promise<void> | void;
  /** before each piece, given the share of the table's rows left to write: why there is no room for them on disk, or
   *  null (`CompactNoRoom` stops the compaction there) */
  room?: (left: number) => string | null;
}

export async function rewrite(c: DuckConnection, schema: string, table: string, firstPiece: number, hooks: RewriteHooks = {}): Promise<{ rows: number; pieces: number; pieceRows: number }> {
  const run = hooks.run ?? (async (sql: string) => { await c.run(sql); }), said = hooks.said ?? (() => undefined);
  const target = `${ident(schema)}.${ident(table)}`, side = sideOf(schema, table);
  // the side table's columns are the table's own, in its order, as the engine has them (types, NOT NULL, defaults; a
  // stored JSON path's column and a plain numeric's hidden scale column too, src/duck/scale-column.ts): CREATE TABLE AS
  // would drop a NOT NULL
  const cols = (await c.runAndReadAll(`SELECT column_name, data_type, is_nullable, column_default FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = $1 AND table_name = $2 ORDER BY column_index`,
    [schema, table])).getRowsJS() as Array<[string, string, boolean, string | null]>;
  if (cols.length === 0) throw new Error(`${schema}.${table} is not a table of the synced data (Mason bug: report it)`);
  await c.run(`DROP TABLE IF EXISTS ${side}`);
  await c.run(`CREATE TABLE ${side} (${cols.map(([n, type, nullable, def]) => `${ident(n)} ${type}${nullable ? "" : " NOT NULL"}${def === null ? "" : ` DEFAULT ${def}`}`).join(", ")})`);
  const end = Number((await c.runAndReadAll(`SELECT coalesce(max(rowid), -1) + 1 FROM ${target}`)).getRowsJS()[0]![0]);
  let n = Math.max(1, Math.floor(firstPiece)), pieces = 0;
  for (let lo = 0; lo < end;) {
    let inTx = false;
    await hooks.beforePiece?.();
    const noRoom = hooks.room?.(1 - lo / end) ?? null;
    if (noRoom !== null) throw new CompactNoRoom(noRoom);
    try {
      await c.run("BEGIN TRANSACTION");
      inTx = true;
      await run(`INSERT INTO ${side} SELECT * FROM ${target} WHERE rowid >= ${lo} AND rowid < ${lo + n}`);
      await run("COMMIT");
      inTx = false;
      lo += n;
      pieces++;
    } catch (e) {
      if (inTx) {
        try { await c.run("ROLLBACK"); }
        // the engine ended it itself (a COMMIT out of memory): nothing of the piece is left to roll back
        catch (r) { if (!endedTransaction(r)) throw r; }
      }
      if (pgErrorOf(e, "").fields.code !== "53200") throw e;
      if (n === 1) throw new CompactTooLarge(`one row of it, read alone, ran out of memory`);
      n = Math.max(1, Math.floor(n / 2));
      said(`a piece of its compaction ran out of memory: read on in pieces of ${n} row(s)`);
    }
  }
  const [rows, kept] = (await c.runAndReadAll(`SELECT (SELECT count(*) FROM ${side}), (SELECT count(*) FROM ${target})`)).getRowsJS()[0]!.map(Number) as [number, number];
  if (rows !== kept) throw new Error(`its compaction wrote ${rows} row(s) of its ${kept} (Mason bug: report it, with mason logs): it was not swapped in`);
  return { rows, pieces, pieceRows: n };
}

/** the side table of `schema.table`, quoted */
export const sideOf = (schema: string, table: string): string => `${ident(schema)}.${ident(`${table}${COMPACT_SIDE_SUFFIX}`)}`;

/** THE SWAP'S STATEMENTS, in the caller's ONE transaction on the writer's turn: the table replaced by its side table.
 *  A session reading the table meanwhile reads the old one to its end (its transaction's snapshot); one after the
 *  commit reads the new one; none reads no table or half of one. */
export function swapSql(schema: string, table: string): string[] {
  return [`DROP TABLE ${ident(schema)}.${ident(table)}`, `ALTER TABLE ${sideOf(schema, table)} RENAME TO ${ident(table)}`];
}

/** every side table a compaction cut short left (a crash): dropped at the open, before anything reads them */
export async function dropLeftovers(c: DuckConnection): Promise<string[]> {
  const left = (await c.runAndReadAll(`SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = current_database() AND ends_with(table_name, ${literal(COMPACT_SIDE_SUFFIX)})`)).getRowsJS() as Array<[string, string]>;
  for (const [schema, table] of left) await c.run(`DROP TABLE IF EXISTS ${ident(schema)}.${ident(table)}`);
  return left.map(([s, t]) => `${s}.${t}`);
}
