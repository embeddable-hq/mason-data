/**
 * THE ENTRIES `mason add` WROTE WHILE MASON WAS STOPPED (issue 1073): `mason add` writes a table's entry against the
 * database's columns as they are now, so it confirms it. With Mason running the run takes the entry afresh at once
 * (src/cli/run-server.ts `/api/pick`, src/duck/column-identity.ts `confirmed`). With Mason stopped the command writes
 * the file itself, and the next start would hold a table whose entry syncs a column it left out before — while the
 * command said the sync begins at mason start (the re-check of PR 1078). So the command records which tables it
 * confirmed, here in `.mason/` (the machine's, never the project's files), and the next start takes those entries
 * afresh, then forgets them (src/cli/dev.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { replaceFile } from "../lib/disk-full.ts";

export const CONFIRMED_FILE = "confirmed-entries.json";

/** The tables `mason add` confirmed while Mason was stopped (`schema.table`), none when there is no record; a record
 *  this module did not write is said by its caller and read as none. */
export function readConfirmed(dir: string): { tables: string[] } | { problem: string } {
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
  if (!Array.isArray(tables) || !tables.every((t) => typeof t === "string")) return { problem: `.mason/${CONFIRMED_FILE} does not list tables` };
  return { tables };
}

/** `tables` recorded as confirmed by `mason add` while Mason is stopped, beside those recorded before. */
export function confirmEntries(dir: string, tables: readonly string[]): void {
  const now = readConfirmed(dir);
  const before = "tables" in now ? now.tables : [];
  replaceFile(path.join(dir, CONFIRMED_FILE), `${JSON.stringify({ tables: [...new Set([...before, ...tables])] })}\n`);
}

/** The record forgotten, once a start took its entries (`readConfirmed`). */
export function forgetConfirmed(dir: string): void {
  try { fs.unlinkSync(path.join(dir, CONFIRMED_FILE)); }
  catch (e) {
    // already gone: nothing to forget
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
