/**
 * THE CANCEL TABLE (the executor worker: src/duck/executor.ts). A statement that calls a Mason function is
 * cancelled through its SESSION as well as interrupted (src/duck/functions.ts "every call carries its session"): its
 * next call reads this table and raises, and its result is closed only once its calls have stopped (store.ts `cleanUp`,
 * the suite's hang). The calls run on the executor worker, which such a statement keeps busy between
 * DuckDB's turns for seconds at a time, so a cancel cannot be a message to it: the listener (the main thread) writes
 * the table directly, in memory both threads share, and the next call sees it at once.
 *
 * Two Int32 cells per session SLOT (a wire session's DuckDB connection holds one while it is open): `cancelled`, the
 * highest statement number of the session cancelled so far, and `running`, the number of the statement its connection
 * runs now (set by the worker once the one before it has been released). A call is cancelled when `cancelled >=
 * running`: a cancel of a statement already past never reaches the next one, a cancel that lands before its statement
 * starts still does, and a statement being drained after its cancel stays cancelled whatever the next one's number.
 * Dependency-free: the listener's thread loads it without DuckDB.
 */

/** how many wire sessions may hold a DuckDB connection at once (a slot each) */
export const CANCEL_SLOTS = 4096;

/** a fresh table (the executor makes one and hands it to its worker) */
export function cancelTable(): Int32Array { return new Int32Array(new SharedArrayBuffer(CANCEL_SLOTS * 2 * 4)); }

const cancelledAt = (slot: number): number => slot * 2;
const runningAt = (slot: number): number => slot * 2 + 1;

/** a slot handed to a new session: nothing cancelled, nothing running */
export function resetSlot(t: Int32Array, slot: number): void { Atomics.store(t, cancelledAt(slot), 0); Atomics.store(t, runningAt(slot), 0); }

/** statement `seq` of the session in `slot` is cancelled (and every one before it): monotonic, from either thread */
export function cancelStatement(t: Int32Array, slot: number, seq: number): void {
  for (let was = Atomics.load(t, cancelledAt(slot)); was < seq; was = Atomics.load(t, cancelledAt(slot))) {
    if (Atomics.compareExchange(t, cancelledAt(slot), was, seq) === was) return;
  }
}

/** statement `seq` is the one the session's connection runs now */
export function beginStatement(t: Int32Array, slot: number, seq: number): void { Atomics.store(t, runningAt(slot), seq); }

/** whether the statement the session's connection runs now is cancelled */
export function isCancelled(t: Int32Array, slot: number): boolean {
  const running = Atomics.load(t, runningAt(slot));
  return running !== 0 && Atomics.load(t, cancelledAt(slot)) >= running;
}

/** whether statement `seq` of the session in `slot` was cancelled (its cancel asked, whether or not a call saw it) */
export function statementCancelled(t: Int32Array, slot: number, seq: number): boolean {
  return seq !== 0 && Atomics.load(t, cancelledAt(slot)) >= seq;
}

/** the session variable's value for a slot, and back (`s<slot>`; null for what is no session's) */
export const slotName = (slot: number): string => `s${slot}`;
export function slotOf(name: string | null): number | null {
  if (name === null || !/^s\d+$/.test(name)) return null;
  const n = Number(name.slice(1));
  return n < CANCEL_SLOTS ? n : null;
}
