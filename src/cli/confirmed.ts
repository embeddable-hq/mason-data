/**
 * THE ENTRIES `mason add` WROTE WHILE MASON WAS STOPPED (issue 1073): `mason add` writes a table's entry against the
 * database's columns as they are now, so it confirms it. With Mason running the run takes the entry afresh at once
 * (src/cli/run-server.ts `/api/pick`, src/duck/column-identity.ts `confirmed`). With Mason stopped the command writes
 * the file itself, and the next start would hold a table whose entry syncs a column it left out before — while the
 * command said the sync begins at mason start (the re-check of PR 1078). So the command records which tables it
 * confirmed, here in `.mason/` (the machine's, never the project's files), and the next start takes those entries
 * afresh, then forgets them (src/cli/dev.ts).
 *
 * A CONFIRMATION IS OF THE TABLE THE ADD READ (the third re-check of PR 1078): each carries the table's shape as the
 * add read it (src/cli/preflight.ts `shape`: its oid, and each column's name, type and number). Columns renamed on the
 * database before the start (a left-out column swapped into a name the entry syncs) change it, and the start takes the
 * entry as it took it before, holding the table (src/duck/sync.ts `placeColumns`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { replaceFile } from "../lib/disk-full.ts";

export const CONFIRMED_FILE = "confirmed-entries.json";

/** A table `mason add` confirmed, and its shape when the add read it (undefined: the catalog gave none). */
export interface Confirmation { table: string; shape: string | undefined }

/** The tables `mason add` confirmed while Mason was stopped, none when there is no record; a record this module did not
 *  write is said by its caller and read as none. */
export function readConfirmed(dir: string): { tables: Confirmation[] } | { problem: string } {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, CONFIRMED_FILE), "utf8"); }
  catch (e) {
    // no record: nothing was added while Mason was stopped
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { tables: [] };
    throw e;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (e) {
    if (e instanceof SyntaxError) return { problem: `.mason/${CONFIRMED_FILE} is not JSON` };
    throw e;
  }
  const tables = (parsed as { tables?: unknown } | null)?.tables;
  const one = (t: unknown): t is { table: string; shape: string | null } => typeof t === "object" && t !== null
    && typeof (t as { table?: unknown }).table === "string" && (typeof (t as { shape?: unknown }).shape === "string" || (t as { shape?: unknown }).shape === null);
  if (!Array.isArray(tables) || !tables.every(one)) return { problem: `.mason/${CONFIRMED_FILE} does not list tables` };
  return { tables: tables.map((t) => ({ table: t.table, shape: t.shape ?? undefined })) };
}

/** `tables` recorded as confirmed by `mason add` while Mason is stopped, beside those recorded before: a table added
 *  again is recorded as this add read it. */
export function confirmEntries(dir: string, tables: readonly Confirmation[]): void {
  const now = readConfirmed(dir);
  const all = new Map(("tables" in now ? now.tables : []).map((t) => [t.table, t.shape]));
  for (const t of tables) all.set(t.table, t.shape);
  replaceFile(path.join(dir, CONFIRMED_FILE), `${JSON.stringify({ tables: [...all].map(([table, shape]) => ({ table, shape: shape ?? null })) })}\n`);
}

/** The record forgotten, once a start took its entries (`readConfirmed`). */
export function forgetConfirmed(dir: string): void {
  try { fs.unlinkSync(path.join(dir, CONFIRMED_FILE)); }
  catch (e) {
    // already gone: nothing to forget
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
