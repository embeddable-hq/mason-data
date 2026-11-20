/**
 * THE TALLY TABLE (issue 1173: a sync by hand of a 17 M-row table showed nothing moving for minutes). A poll reads a
 * table's changed rows from the database in ONE statement (`CREATE TEMP TABLE … AS SELECT … FROM postgres_query(…)`),
 * and DuckDB's own query progress says nothing of a `postgres_query` scan (measured: 0 rows processed for its whole
 * run). So the rows are counted as they ARRIVE, on Mason's side: the statement filters them through
 * `__mason_tally(<slot>)` (src/duck/functions.ts), a volatile function that adds each vector's row count to its slot
 * here and lets every row through, in memory the executor worker and the main thread share, so the sync reads the count
 * while the statement runs. One call a vector of 2,048 rows, no row's value read: a 6 M-row read took 5.9 s with it and
 * 6.1 s without. Nothing is asked of the database for it.
 *
 * A slot is TAKEN for one read and RELEASED after it (`Tallies`, on the main thread). Dependency-free: the listener's
 * thread and the worker load it without DuckDB.
 */

/** how many reads may be counted at once: a poll counts one table at a time per lane */
export const TALLY_SLOTS = 256;

/** a fresh table (the executor makes one and hands it to its worker) */
export function tallyTable(): BigInt64Array { return new BigInt64Array(new SharedArrayBuffer(TALLY_SLOTS * 8)); }

/** a vector of `rows` rows passed through the slot (the worker's call) */
export function addRows(t: BigInt64Array, slot: number, rows: number): void {
  if (slot >= 0 && slot < TALLY_SLOTS) Atomics.add(t, slot, BigInt(rows));
}

/** the rows counted in the slot so far */
export function rowsAt(t: BigInt64Array, slot: number): number { return Number(Atomics.load(t, slot)); }

/** One read's count: the SQL that counts it (`filter`, a WHERE condition true for every row) and the rows so far. */
export interface Tally {
  readonly slot: number;
  /** `__mason_tally(<slot>)`: a condition every row passes, counting it */
  readonly filter: string;
  rows(): number;
  /** the slot is free again; `rows()` keeps the count it had */
  release(): void;
}

/** The slots of one table, handed out on the main thread. */
export class Tallies {
  private readonly free: number[] = Array.from({ length: TALLY_SLOTS }, (_, i) => TALLY_SLOTS - 1 - i);
  readonly table: BigInt64Array;
  constructor(table: BigInt64Array) { this.table = table; }

  /** a slot counted from zero, or null when every slot is taken (the read then goes uncounted: its progress says none) */
  take(): Tally | null {
    const slot = this.free.pop();
    if (slot === undefined) return null;
    Atomics.store(this.table, slot, 0n);
    let kept: number | null = null;
    return {
      slot, filter: `${TALLY_FUNCTION}(${slot})`,
      rows: () => kept ?? rowsAt(this.table, slot),
      release: () => { if (kept !== null) return; kept = rowsAt(this.table, slot); this.free.push(slot); },
    };
  }
}

/** the function's name (src/duck/functions.ts registers it) */
export const TALLY_FUNCTION = "__mason_tally";
