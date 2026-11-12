/**
 * THE SYNCED DATA'S BYTES ON DISK, read by this one function (`mason status`'s Synced data line and `engine.bytes`, the
 * web page's file card, the usage samples' `copyBytes`, `mason_synced_bytes`, and the first sync's disk projection): the
 * DuckDB file AND its write-ahead log. What a sync writes lands in the log until a checkpoint, and DuckDB checkpoints by
 * itself only once the log passes 16 MiB, so a run whose tables are small can hold all its rows there: the file read
 * 12 KiB beside a log of 1.3 MB (issue 815). A light module: the CLI reads it with Mason stopped, without the engine.
 */
import * as fs from "node:fs";

/** The file's bytes and its write-ahead log's (none between checkpoints), or null when the file is not there. */
export function syncedDataBytes(file: string): number | null {
  const size = (f: string): number | null => {
    try { return fs.statSync(f).size; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  };
  const main = size(file);
  return main === null ? null : main + (size(`${file}.wal`) ?? 0);
}
