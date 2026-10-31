/**
 * THE SIZE OF LIBUV'S POOL (issue 88). A statement in flight holds one of its threads for as long as DuckDB computes
 * (docs/FLOWS.md "What waits, and where"), and at Node's four a fifth statement waits behind four heavy ones: 13 s to 30 s
 * for a `SELECT 1`. libuv reads UV_THREADPOOL_SIZE once, when the first task reaches the pool, so this must run before
 * anything uses it: CommonJS, loaded synchronously, by src/cli/mason.cjs and as main.ts's FIRST import.
 *
 * WHY 64, MEASURED AND NOT DERIVED (docs/DESIGN.md "The pool"): Mason admits no fixed number of running statements. A
 * session runs one at a time and CANCEL_SLOTS allows 4,096 sessions, past the 1,024 threads libuv allows, so no pool
 * sits above that limit. The 1,024 itself is refused: libuv starts every thread at once and ABORTS the process with no
 * message when one cannot be made (exit 133 under `--pids-limit=300`), and platforms limit threads, some to 256. 64 costs
 * no more than a few tens of MB, a real run has 81 threads at 2 vCPU and 121 at 10, and it leaves room beside the sync's
 * readers (at most 8, and the writer).
 *
 * An operator's own UV_THREADPOOL_SIZE is left alone. An empty one counts as unset: libuv would read it as 1.
 */
"use strict";
const POOL_THREADS = 64;
process.env.UV_THREADPOOL_SIZE ||= String(POOL_THREADS);
