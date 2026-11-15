/**
 * WHICH SYNCED TABLES A START READS AGAIN WHOLE FROM THE SOURCE, AND WHY (issue 1069; release-notes/README.md "Which
 * tables the first start reads again"). One module decides it, from one set of facts, for two callers:
 *
 * - the run's start (src/duck/sync.ts `open`, `needsCopy`), which reads the facts from the synced data's file and acts;
 * - `mason upgrade --check` (src/cli/upgrade.ts), a newer release's command, which reads the same facts from a running
 *   Mason (`/api/state?storage=1`, published by `Sync.storedFacts`) and applies its own release's checks to them.
 *
 * So what the command says a newer start will read again, and what that start reads again, cannot disagree: both are
 * these functions over these facts. A new check reads a new fact: add it to `StoredTable` and to `readStored` here, so
 * the run publishes it too. A release's command can check only the facts the running Mason published, so a new fact
 * helps from the release after the one that publishes it.
 *
 * What a start also reads from the source (each added table's columns) the command takes from the running Mason as its
 * catalog read them (`StoredFacts.added`). A release that reads a new fact of a column from the source is the one case
 * the command cannot see: its notes say so, as they always did.
 */
import type { SourceColumnInfo } from "../cli/preflight.ts";
import type { DuckConnection } from "./executor.ts";
import { holdOf, nativeVarchar } from "./held-types.ts";
import { plainNumeric, scaleColumn } from "./scale-column.ts";
import { MASON_SCHEMA } from "./store.ts";
import { relationKey } from "../lib/relation-key.ts";

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

/**
 * A COPY AN OLDER MASON MADE BEFORE A PLAIN NUMERIC'S OWN SCALE WAS HELD (issue 946, src/duck/scale-column.ts): a column
 * declared `numeric` with no precision, stored as a DECIMAL with no hidden scale column beside it, so every value prints
 * with the column's most decimals. The scales are the source's alone: found by what the copy physically is, copied
 * again through the normal path (`needsCopy`) once, serving as it was until its swap.
 */
export const SCALE_LAYOUT = "stored by an older Mason without each numeric value's own decimals: read again whole, once";

/**
 * A COPY MISSING A COLUMN ITS RECORD NAMES (issue 998): an older Mason dropped a source column named like one of its
 * own hidden columns (`__mason_json_…`) at a start, so the copy lacks a column it syncs, and every poll and stream write
 * of it failed. Its values are the source's alone: found by what the copy physically is, copied again through the normal
 * path (`needsCopy`), serving as it was until its swap.
 */
export const MISSING_LAYOUT = "missing a column it syncs, which an older Mason dropped: read again whole, once";

/**
 * A COPY AN OLDER MASON MADE OF A COLUMN WHOSE NAME STARTS WITH U+FEFF (issue 991, src/duck/text.ts): it looked the
 * column's type up by the name DuckDB handed back, which had lost its byte-order mark, found none, and stored the
 * column as a VARCHAR whatever its type (a numeric served as text). Found by what the copy physically is (`lostType`),
 * copied again through the normal path (`needsCopy`) once, serving as it was until its swap.
 */
export const BOM_LAYOUT = "stored by an older Mason with a column whose name starts with a byte-order mark as text: read again whole, once";

/** a copied column an older Mason stored as a VARCHAR only because its name starts with U+FEFF (`BOM_LAYOUT`): one the
 *  copy now stores as its own type (a native type that is no text, an array, an enum). A domain is left as it is. */
export function lostType(c: SourceColumnInfo, stored: string): boolean {
  return c.name.startsWith("﻿") && stored === "VARCHAR" && c.domain !== true && holdOf(c.type, c.typeKind) === "same" &&
    !/^jsonb?$/.test(c.type) && !nativeVarchar(c.type);
}

/** a table's columns as a copy is made with them: their names and source types, in order */
export const columnsKey = (columns: readonly SourceColumnInfo[]): string => JSON.stringify(columns.map((c) => {
  // what the copy holds is part of the shape: a copy made before a column's type was held as its text is read again
  const hold = holdOf(c.type, c.typeKind);
  return hold === "same" && c.domain !== true ? [c.name, c.type] : [c.name, c.type, hold, ...(c.domain === true ? ["domain"] : [])];
}));

/** a copy in a layout this Mason no longer keeps: the layout as `mason status` says it, its short form for a line, and
 *  what the start's log says of it after the table's name */
export interface Retired { layout: string; short: string; said: string }

/**
 * WHAT THE SYNCED DATA HOLDS OF ONE TABLE, as a start reads it from the file (`readStored`): the ledger's rows of it and
 * the engine's own catalog of it. Every fact a check of this module reads, and nothing of the source's data: names,
 * types and counts. Published as it is by a running Mason (`/api/state?storage=1`), so a newer release's command reads
 * exactly what that release's start would.
 */
export interface StoredTable {
  /** `schema.table`, as the ledger keys it */
  source: string;
  /** `_mason.copy_state.phase`: `copied` once its first sync is in */
  phase: string;
  /** `_mason.copy_state.columns`: the columns it was synced with, as recorded (null: none recorded) */
  record: SourceColumnInfo[] | null;
  /** its rows in the synced data, and the source table's bytes when it was synced (`copy_state`): what a whole read of
   *  it costs, about */
  rows: number | null;
  bytes: number | null;
  /** a row of `_mason.poll_state`: where its next poll reads from */
  watermark: boolean;
  /** a table at its name in the synced data, as the engine finds names (`relationKey`) */
  present: boolean;
  /** a PRIMARY KEY or UNIQUE constraint on it (`duckdb_constraints()`): the layout before heap order */
  keyed: boolean;
  /** each column the synced table holds, hidden ones included, with its type as the engine names it
   *  (`duckdb_columns()`), in order; null where no table has its name exactly */
  stored: Array<[name: string, type: string]> | null;
}

/** what a running Mason publishes for `mason upgrade --check` (`/api/state?storage=1` `storage`) */
export interface StoredFacts {
  /** the shape of these facts: a release that changes it reads the older one too, or says it cannot */
  format: 1;
  tables: StoredTable[];
  /** each table the sources file adds now, with its columns as the run read them from the source: what a start
   *  compares each table's record with (`columnsKey`) */
  added: Array<{ table: string; columns: SourceColumnInfo[] }>;
}

/** the tables in the synced data, by `relationKey`: whether a recorded table is there (`forgetMissing`, `readStored`) */
export async function tablesThere(c: DuckConnection): Promise<Set<string>> {
  return new Set(((await c.runAndReadAll(`SELECT schema_name || '.' || table_name FROM duckdb_tables() WHERE database_name = current_database()`)).getRowsJS() as [string][])
    .map(([n]) => relationKey(n)));
}

/** a number the engine hands back (a BIGINT is a bigint), as a number; null as null */
const num = (x: unknown): number | null => x === null || x === undefined ? null : Number(x);

/**
 * THE FACTS OF EVERY TABLE THE LEDGER RECORDS, read from the synced data's file on the caller's connection: at a start
 * on the writer (`Sync.open`), and for `/api/state?storage=1` in a transaction of a connection of its own, so the reads
 * see one moment. The ONE reader of what the checks below read.
 */
export async function readStored(c: DuckConnection): Promise<StoredTable[]> {
  const there = await tablesThere(c);
  const watermarks = new Set((await c.runAndReadAll(`SELECT source FROM ${MASON_SCHEMA}.poll_state`)).getRowsJS().map((r) => String(r[0])));
  const keyed = new Set((await c.runAndReadAll(`SELECT DISTINCT schema_name || '.' || table_name FROM duckdb_constraints() ` +
    `WHERE database_name = current_database() AND schema_name <> '${MASON_SCHEMA}' AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')`)).getRowsJS().map((r) => String(r[0])));
  const physical = new Map<string, Array<[string, string]>>();
  for (const [source, column, type] of (await c.runAndReadAll(`SELECT schema_name || '.' || table_name, column_name, data_type FROM duckdb_columns() ` +
    `WHERE database_name = current_database() AND schema_name <> '${MASON_SCHEMA}' ORDER BY schema_name, table_name, column_index`)).getRowsJS() as Array<[string, string, string]>) {
    const m = physical.get(source) ?? [];
    m.push([column, type]);
    physical.set(source, m);
  }
  const rows = (await c.runAndReadAll(`SELECT source, phase, "rows", bytes, columns::VARCHAR FROM ${MASON_SCHEMA}.copy_state ORDER BY source`)).getRowsJS();
  return rows.map((r) => {
    const source = String(r[0]);
    return { source, phase: String(r[1]), record: r[4] === null ? null : JSON.parse(String(r[4])) as SourceColumnInfo[], rows: num(r[2]), bytes: num(r[3]),
      watermark: watermarks.has(source), present: there.has(relationKey(source)), keyed: keyed.has(source),
      stored: physical.get(source) ?? null };
  });
}

/**
 * A SYNCED TABLE'S LAYOUT, as this release finds it in the facts (`findRetired` and `findHeldLayout` before, issue 1069):
 * the layout it no longer keeps, if any, and its record completed where the record could not say a column's kind (an
 * enum, from its stored ENUM type), so its columns' key is the one a fresh read makes and it is not read again for
 * nothing. A table not synced yet is as it is recorded.
 */
export function layoutOf(t: Pick<StoredTable, "source" | "phase" | "record" | "keyed" | "stored">): { retired: Retired | null; columns: SourceColumnInfo[] | null } {
  if (t.phase !== "copied") return { retired: null, columns: t.record };
  if (t.keyed) {
    return { retired: { layout: RETIRED_LAYOUT, short: "in an older Mason's layout, key order with an index",
      said: `it is ${RETIRED_LAYOUT} — its rows are sorted on disk, and only the source has them in its own order, so it is read again whole; its synced data serves as it was until then` },
    columns: t.record };
  }
  const columns = t.record;
  if (columns === null || t.stored === null) return { retired: null, columns };
  const types = new Map(t.stored);
  const mis: string[] = [];
  const unscaled: string[] = [];
  const missing: string[] = [];
  const untyped: string[] = [];
  const completed = columns.map((c) => {
    const type = types.get(c.name);
    if (type === undefined) { missing.push(c.name); return c; }
    if (c.typeKind === undefined && type.startsWith("ENUM(")) return { ...c, typeKind: "e" };
    if (lostType(c, type)) untyped.push(c.name);
    const hold = holdOf(c.type, c.typeKind);
    const want = hold === "text" ? "VARCHAR" : hold === "text[]" ? "VARCHAR[]" : null;
    if (want !== null && type !== want) mis.push(`${c.name} (${c.type})`);
    // a plain numeric synced exactly, its values' own scales not held beside it (`SCALE_LAYOUT`)
    if (plainNumeric(c.type) && type.startsWith("DECIMAL(38,") && !types.has(scaleColumn(c.name, columns.map((x) => x.name)))) unscaled.push(c.name);
    return c;
  });
  const retired = (layout: string, short: string, said: string): { retired: Retired; columns: SourceColumnInfo[] } => ({ retired: { layout, short, said }, columns: completed });
  if (missing.length > 0) {
    return retired(MISSING_LAYOUT, `missing ${missing.join(", ")}, which an older Mason dropped`, `it is ${MISSING_LAYOUT} (${missing.join(", ")}) — its synced data serves as it was until then`);
  }
  if (mis.length === 0 && untyped.length > 0) {
    const named = untyped.map((n) => JSON.stringify(n)).join(", ");
    return retired(BOM_LAYOUT, `in an older Mason's layout, ${named} stored as text`, `it is ${BOM_LAYOUT} (${named}) — its synced data serves as it was until then`);
  }
  if (mis.length === 0 && unscaled.length > 0) {
    return retired(SCALE_LAYOUT, `in an older Mason's layout, ${unscaled.join(", ")} without each value's own decimals`,
      `it is ${SCALE_LAYOUT} (${unscaled.join(", ")}) — its synced data serves as it was until then, each value of those columns printed with the column's most decimals`);
  }
  if (mis.length === 0) return { retired: null, columns: completed };
  return retired(HELD_LAYOUT, `in an older Mason's layout, ${mis.join(", ")} not held as the source's text`,
    `it is ${HELD_LAYOUT} (${mis.join(", ")}) — it is read again whole; its synced data serves as it was until then`);
}

/** why a table is read whole from the source: its first sync is not in, it has no watermark, its layout is one this
 *  release no longer keeps, or its columns are not the ones it was synced with */
export type WholeRead = { kind: "first" } | { kind: "watermark" } | { kind: "layout"; retired: Retired } | { kind: "columns" };

/**
 * WHETHER A TABLE IS READ WHOLE FROM THE SOURCE, AND WHY, or null when its synced data is kept current as it is: what
 * `needsCopy` (src/duck/sync.ts) decides, from what the run holds of the table — its phase, its watermark, its record's
 * columns' key and its layout — and its columns as the source has them now.
 */
export function wholeRead(t: { phase: string | undefined; watermark: boolean; copiedAs: string | undefined; retired: Retired | undefined }, columns: readonly SourceColumnInfo[]): WholeRead | null {
  if (t.phase !== "copied") return { kind: "first" };
  if (t.retired !== undefined) return { kind: "layout", retired: t.retired };
  if (t.copiedAs !== columnsKey(columns)) return { kind: "columns" };
  if (!t.watermark) return { kind: "watermark" };
  return null;
}

/** a synced table a start would read again whole: why, in the command's words and as a stable code, its size, and
 *  whether it serves its synced data until its new sync is in */
export interface ReadAgain {
  table: string;
  /** `missing` (no synced table at its name), `layout`, `columns`, `watermark` */
  why: "missing" | "layout" | "columns" | "watermark";
  /** the reason in a person's words */
  reason: string;
  /** the layout as `mason status` says it, for `why: "layout"` */
  layout?: string;
  rows: number | null;
  bytes: number | null;
  /** it serves its synced data until its new sync is in */
  serves: boolean;
}

/**
 * EVERY SYNCED TABLE THIS RELEASE'S START WOULD READ AGAIN WHOLE, over a running Mason's facts: the start's own steps,
 * in its order — a recorded table with no table under it is forgotten and synced anew (`forgetMissing`), then each
 * table's layout (`layoutOf`), then `wholeRead` against its columns as the source has them. A table not synced yet
 * (its first sync) and one the sources file no longer adds (dropped at the start) are not read AGAIN, and not listed.
 */
export function readAgain(facts: Pick<StoredFacts, "tables" | "added">): ReadAgain[] {
  const added = new Map(facts.added.map((a) => [a.table, a.columns]));
  const out: ReadAgain[] = [];
  for (const t of facts.tables) {
    const columns = added.get(t.source);
    if (columns === undefined || t.phase !== "copied") continue;
    const base = { table: t.source, rows: t.rows, bytes: t.bytes };
    if (!t.present) { out.push({ ...base, why: "missing", reason: "its synced data is missing", serves: false }); continue; }
    const layout = layoutOf(t);
    const why = wholeRead({ phase: t.phase, watermark: t.watermark, copiedAs: layout.columns === null ? undefined : columnsKey(layout.columns), retired: layout.retired ?? undefined }, columns);
    if (why === null || why.kind === "first") continue;
    if (why.kind === "layout") out.push({ ...base, why: "layout", reason: why.retired.short, layout: why.retired.layout, serves: true });
    else if (why.kind === "columns") out.push({ ...base, why: "columns", reason: "the columns it was synced with are not its columns as this release reads them", serves: true });
    else out.push({ ...base, why: "watermark", reason: "it has no record of where its next sync reads from", serves: true });
  }
  return out;
}
