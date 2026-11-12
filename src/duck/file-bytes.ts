/**
 * THE SYNCED DATA'S BYTES ON DISK, read by this one function (`mason status`'s Synced data line and `engine.bytes`, the
 * web page's file card, the usage samples' `copyBytes`, `mason_copy_bytes`, and the first sync's disk projection): the
 * DuckDB file AND its write-ahead log. What a sync writes lands in the log until a checkpoint, and DuckDB checkpoints by
 * itself only once the log passes 16 MiB, so a run whose tables are small can hold all its rows there: the file read
 * 12 KiB beside a log of 1.3 MB (issue 815). A light module: the CLI reads it with Mason stopped, without the engine.
 */
import * as fs from "node:fs";

const size = (f: string): number | null => {
  try { return fs.statSync(f).size; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
};

/** The file's bytes and its write-ahead log's (none between checkpoints), or null when the file is not there. */
export function syncedDataBytes(file: string): number | null {
  const main = size(file);
  return main === null ? null : main + (walBytes(file) ?? 0);
}

/** The write-ahead log's bytes alone (`<file>.wal`), or null when there is none (nothing written since a checkpoint):
 *  one file-size read, no database work — what a synced table whose rows are all in the log is under
 *  (src/duck/usage.ts `unsizedTables`, issue 883). */
export function walBytes(file: string): number | null {
  return size(`${file}.wal`);
}
