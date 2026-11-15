/**
 * WILL A TABLE FIT ON DISK, ASKED BEFORE ITS SYNC (issue 1075). A first sync that cannot fit was found only once it was
 * under way (`copyDiskProjection`, src/duck/sync.ts, after 1 % of the heap), and by then the source had been read for a
 * while for nothing. So every entrance that adds a table, or syncs one again whole, asks this module first: the web
 * page's Add and Columns…, `mason add` (with Mason up, through `/api/pick`; with it down, by itself) and `mason deploy`'s
 * plan. The estimate, the room and the words are decided HERE alone (`syncedEstimate`, `diskFit`, `diskShortWords`,
 * `diskFitNote`), so the entrances say one thing. It only warns: a person goes ahead anyway (the page's Add anyway,
 * `--yes`), and the mid-sync check stays the backstop.
 *
 * THE ESTIMATE reads the source's catalog alone, never the table (CLAUDE.md "The source database is production"): the
 * table's size on disk without its indexes (`pg_table_size`: the heap and its TOAST), the share of it the entry's
 * columns hold, and what DuckDB stores for that share (`STORED_SHARE`, measured: docs/DESIGN.md "What a synced table
 * takes on disk"). The columns' share is by `pg_stats.avg_width` for what is in line, and by count among the columns
 * stored out of line for the TOAST bytes, since a value stored out of line has the width of its pointer there (18 B
 * for a 2 KB value). A table never analysed shares by column count.
 *
 * THE ROOM kept beside the table is what queries may spill into (the spill's ceiling as it stands: half of what is free,
 * or `MASON_SPILL_LIMIT`; src/duck/store.ts `spillCeiling`), and what the first syncs already under way still need. A
 * table synced again whole keeps its synced data on disk until its new data is in place, so the old data is not free
 * space, and the new must fit beside it.
 */
import type { SourceTable } from "../cli/preflight.ts";

/**
 * WHAT DUCKDB STORES FOR A TABLE'S BYTES IN POSTGRES (`pg_table_size`), the one ratio of the estimate. Measured on
 * DuckDB 2.0 (ZSTD strings forced) against Postgres 16, synthetic tables synced by the real sync, the largest run of
 * each shape (docs/DESIGN.md "What a synced table takes on disk"): 0.11 (repeated words), 0.14 (`jsonb`), 0.16 (a mixed
 * orders table), 0.18 (numerics), 0.20 (integers, timestamps), 0.25 (low-cardinality text), 0.39 (text Postgres
 * compressed in line), 0.40 (random text, in line or out of line), 0.52 (uuids). 0.4 is at or above all but the
 * uuids: an estimate that errs to warning, since the backstop catches one that errs the other way. The ratio falls as
 * a table grows, since a table's fixed cost weighs less (a mixed table 0.21 at 200,000 rows, 0.16 at 1,000,000; the
 * compressed text 0.87 at 3 MB).
 */
export const STORED_SHARE = 0.4;

/** Bytes for a person: `1 B`, `3.2 MiB`, `49.1 GiB` (the sync's words and these alike). */
export function humanBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** What the estimate reads of a table: its size, with and without indexes, its TOAST bytes, and each column's width. */
export type SizedTable = Pick<SourceTable, "bytes" | "tableBytes" | "toastBytes" | "columns">;

/**
 * THE BYTES A TABLE'S SYNCED DATA WOULD TAKE, estimated from the catalog alone, for the columns an entry syncs:
 * `columns` those named (null: every one), less `exclude`. Rough by nature (the same table's first sync took between
 * 13 and 33 GiB across tries), so it only ever warns.
 */
export function syncedEstimate(t: SizedTable, columns: readonly string[] | null, exclude: readonly string[] = []): number {
  // an older catalog (no `tableBytes`) has the size with its indexes alone: larger, so the estimate errs to warning
  const base = Math.max(0, t.tableBytes ?? t.bytes);
  const toast = Math.min(base, Math.max(0, t.toastBytes ?? 0));
  const all = t.columns;
  const kept = all.filter((c) => columns === null ? !exclude.includes(c.name) : columns.includes(c.name));
  const count = (xs: readonly unknown[]): number => xs.length;
  // in line: by each column's average width, where the catalog has every one; else by count
  const widths = all.every((c) => typeof c.width === "number");
  const total = widths ? all.reduce((s, c) => s + c.width!, 0) : 0;
  const inline = kept.length === all.length ? 1 : widths && total > 0 ? kept.reduce((s, c) => s + c.width!, 0) / total : count(kept) / Math.max(1, count(all));
  // out of line: by count among the columns that can be stored there (their width is a pointer's)
  const outOfLine = all.filter((c) => c.toastable === true);
  const outShare = kept.length === all.length ? 1 : outOfLine.length ? count(kept.filter((c) => c.toastable === true)) / outOfLine.length : inline;
  return Math.round(((base - toast) * inline + toast * outShare) * STORED_SHARE);
}

/** The room on the disk the synced data is on, as the entrance reads it. */
export interface DiskRoom {
  /** bytes free where the synced data is */
  freeBytes: number;
  /** what queries may spill into, the spill's ceiling as it stands (src/duck/store.ts `spillCeiling`) */
  reserveBytes: number;
  /** `MASON_SPILL_LIMIT` sets the reserve (else it is half of what is free); null: not known here (a replica's) */
  spillSet: boolean | null;
  /** what the first syncs already under way still need, estimated (0 when none, or when it cannot be told) */
  pendingBytes: number;
}

/** What `diskFit` decided for one table, its numbers as `--json` carries them. */
export interface DiskFit {
  table: string;
  estimateBytes: number;
  freeBytes: number;
  reserveBytes: number;
  pendingBytes: number;
  spillSet: boolean | null;
  /** synced again whole: its synced data now stays on disk until the new data is in place */
  resync: boolean;
  /** the estimate fits in what is free, less the reserve and what the first syncs under way need */
  fits: boolean;
}

/** Why a table's fit could not be told (the free disk unreadable): said, and the table goes on. */
export interface DiskUnknown { table: string; unknown: string }

/** THE DECISION: does a table of `estimateBytes` fit in what is free, less the room kept beside it. */
export function diskFit(table: string, estimateBytes: number, room: DiskRoom, resync: boolean): DiskFit {
  const fits = estimateBytes + room.pendingBytes + room.reserveBytes <= room.freeBytes;
  return { table, estimateBytes, freeBytes: room.freeBytes, reserveBytes: room.reserveBytes, pendingBytes: room.pendingBytes, spillSet: room.spillSet, resync, fits };
}

/** The bytes left for the table: what is free, less the reserve and what the first syncs under way need. */
export const roomFor = (f: DiskFit): number => Math.max(0, f.freeBytes - f.reserveBytes - f.pendingBytes);

/** The failure code of a table that likely won't fit, or no longer fits, on disk (src/cli/command.ts FAILURE_CODES; the
 *  sync's event, `/api/state`). */
export const DISK_SHORT = "disk_short" as const;

/**
 * A SHORTAGE OF DISK AS NUMBERS (the owner, on issue 1075: nothing has to parse the words): the bytes the table needs,
 * the bytes free where the synced data is, the room kept for queries that spill to disk, and what the first syncs under
 * way need; `estimated` when it is the catalog's estimate before a sync (`diskFit`), false when the sync measured it
 * part way (`syncShortWords`, the backstop). Made only beside its words, by the functions below, so the two never
 * disagree. Carried by `/api/pick`'s refusal and `mason add --json` (as `disk`, the whole `DiskFit`), the sync's
 * failure event and `/api/state` `tables[].diskShort`.
 */
export interface DiskShortage { code: typeof DISK_SHORT; neededBytes: number; freeBytes: number; reserveBytes: number; pendingBytes: number; estimated: boolean }

/** The shortage of a table `diskFit` found would not fit, as numbers. */
export const shortageOf = (f: DiskFit): DiskShortage =>
  ({ code: DISK_SHORT, neededBytes: f.estimateBytes, freeBytes: f.freeBytes, reserveBytes: f.reserveBytes, pendingBytes: f.pendingBytes, estimated: true });

/** THE MID-SYNC BACKSTOP'S FAILURE (src/duck/sync.ts `diskShort`): its words, and its shortage as numbers; the sync
 *  records its `code` and its numbers on the failure's event itself (src/lib/failure-facts.ts reads SQLSTATEs and
 *  errnos alone). */
export class DiskShortError extends Error {
  readonly code: typeof DISK_SHORT = DISK_SHORT;
  readonly shortage: DiskShortage;
  constructor(message: string, shortage: DiskShortage) { super(message); this.shortage = shortage; }
}

/**
 * THE WORDS AND NUMBERS OF A FIRST SYNC THAT NO LONGER FITS, as the sync measured it part way (src/duck/sync.ts
 * `copyDiskProjection`): what its pages left need against what is free, and the room kept for queries (said; the sync
 * stops only when the pages left need more than is free, before the disk fills).
 */
export function syncShortWords(table: string, o: { neededBytes: number; freeBytes: number; reserveBytes: number; file: string; pagesRead: number; pages: number; addedBytes: number }): DiskShortError {
  return new DiskShortError(`${table} no longer fits on disk: its sync needs about ${humanBytes(o.neededBytes)} more, and ${humanBytes(o.freeBytes)} is free (where ${o.file} is; ` +
    `${o.pagesRead} of ${o.pages} pages read, ${humanBytes(o.addedBytes)} added): free some disk, mason remove ${table}, or mason add ${table} --columns … with fewer columns`,
    { code: DISK_SHORT, neededBytes: Math.round(o.neededBytes), freeBytes: o.freeBytes, reserveBytes: o.reserveBytes, pendingBytes: 0, estimated: false });
}

/** A table added anyway though it likely won't fit, as `mason status` and the web page warn of it until its first sync
 *  ends (`/api/state` `warnings`): its numbers' own words. */
export function shortageWarning(table: string, s: DiskShortage): string {
  return `${table} was added though it likely won't fit on disk: it needs about ${humanBytes(s.neededBytes)}, and ${humanBytes(Math.max(0, s.freeBytes - s.reserveBytes - s.pendingBytes))} is free for it, beside ${humanBytes(s.reserveBytes)} kept for queries that spill to disk`;
}

/**
 * THE WORDS OF A TABLE THAT LIKELY WON'T FIT, for every entrance: what is wrong, the numbers, and the way out in words
 * that name no command and no button. Each entrance adds how to go ahead in its own interface (the page's Add anyway,
 * `mason add … --yes`, the deploy's question).
 */
export function diskShortWords(f: DiskFit): { message: string; why: string; fix: string; shortage: DiskShortage } {
  const why = [
    `Its synced data would need about ${humanBytes(f.estimateBytes)} on disk, estimated from the database's catalog.`,
    ...(f.resync ? ["Its synced data now stays on disk until the new sync is done, so both are on disk at once."] : []),
    `${humanBytes(f.freeBytes)} is free where the synced data is.`,
    ...(f.pendingBytes > 0 ? [`The first syncs under way need about ${humanBytes(f.pendingBytes)} of it.`] : []),
    `Mason keeps ${humanBytes(f.reserveBytes)} of it for queries that spill to disk (${f.spillSet === true ? "MASON_SPILL_LIMIT" : f.spillSet === false ? "half of what is free; MASON_SPILL_LIMIT sets it" : "half of what is free, or MASON_SPILL_LIMIT"}).`,
  ].join(" ");
  return {
    message: `${f.table} likely won't fit on disk: it needs about ${humanBytes(f.estimateBytes)}, and ${humanBytes(roomFor(f))} is free for it`,
    why,
    fix: "Choose fewer columns, or give Mason more disk. Or go ahead anyway: a sync that runs short of disk stops before the disk fills, and keeps the rows it has.",
    shortage: shortageOf(f),
  };
}

/** One line for a table that went ahead anyway (`mason add`'s note, the page's answer, the deploy's plan). */
export function diskFitNote(f: DiskFit): string {
  return `it likely won't fit on disk: it needs about ${humanBytes(f.estimateBytes)}, and ${humanBytes(roomFor(f))} is free for it, beside ${humanBytes(f.reserveBytes)} kept for queries that spill to disk`;
}
