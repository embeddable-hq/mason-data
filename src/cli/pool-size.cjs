/**
 * THE SIZE OF LIBUV'S POOL (issue 88). A statement in flight holds one of its threads for as long as DuckDB computes
 * (docs/FLOWS.md "What waits, and where"), and at Node's four a fifth statement waits behind four heavy ones: 10 s to 50 s
 * for a `SELECT 1`. libuv reads UV_THREADPOOL_SIZE once, when the first task reaches the pool, so this must run before
 * anything uses it: CommonJS, loaded synchronously, by src/cli/mason.cjs and as main.ts's FIRST import. Nothing here may
 * use the pool: every read is synchronous.
 *
 * WHY 32, MEASURED AND NOT DERIVED (docs/DESIGN.md "The pool"): Mason admits no fixed number of running statements. A
 * session runs one at a time and CANCEL_SLOTS allows 4,096 sessions, past the 1,024 threads libuv allows, so no pool
 * sits above that limit. The 1,024 itself is refused: libuv starts every thread at once and ABORTS the process with no
 * message when one cannot be made (exit 133 under `--pids-limit=300`). 16 fixed five statements and 32 fixed eight; past
 * eight there is no data, and the old queue was the only limit on how much memory statements take at once.
 *
 * A LIMIT ON THREADS IS READ FIRST, because that abort under a platform's restart is a silent loop. Below what Mason
 * needs the size is lowered to fit and said; an operator's own size that does not fit refuses the start, as an invalid
 * one does (`abc` would run 1 thread, `-1` 1,024). A size of 4 or less is never refused: it is Node's own, and what a
 * run inherits from the `mason start` that lowered it.
 *
 * ON WINDOWS `process.env` never reaches libuv's getenv, so what this sets does nothing and the pool stays at 4:
 * UV_THREADPOOL_SIZE must be set in the shell before `mason`.
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");

const POOL_THREADS = 32;
const LIBUV_MAX = 1024;
/** Node's own size: never lowered past it */
const FLOOR = 4;
const CGROUP_LIMITS = ["/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/pids/pids.max"];
const PROCESS_LIMITS = "/proc/self/limits";

/** A file's text; null when this machine has no such file, or it cannot be read: then it says no limit. */
function read(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return null; }
}

/** The lowest numeric limit on threads the files say; null when none does (`max`, `unlimited`, not Linux). */
function threadLimit(cgroupFiles, processLimits) {
  const said = cgroupFiles.map((f) => /^\s*(\d+)\s*$/.exec(read(f) ?? "")?.[1]);
  said.push(/^Max processes\s+(\d+)/m.exec(read(processLimits) ?? "")?.[1]);
  const numbers = said.filter((n) => n !== undefined).map(Number);
  return numbers.length === 0 ? null : Math.min(...numbers);
}

/**
 * Sets UV_THREADPOOL_SIZE in `o.env` and returns the size, or refuses by `o.refuse`. Everything it reads is a parameter,
 * for tests/cli-pool-size.test.ts. `o.announce`: say a lowered size (the commands that start a run; any other would
 * repeat it on every call).
 */
function sizePool(o = {}) {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const cpus = o.cpus ?? os.availableParallelism();
  const say = o.say ?? ((line) => process.stderr.write(`${line}\n`));
  const refuse = o.refuse ?? ((line) => { say(line); process.exit(1); });
  const limit = platform !== "linux" ? null : threadLimit(o.cgroupFiles ?? CGROUP_LIMITS, o.processLimits ?? PROCESS_LIMITS);
  /** the threads of a run with a pool of `size`: its other threads are about 20 plus five a CPU (read off real runs) */
  const needs = (size) => size + 20 + 5 * cpus;
  const fitting = limit === null ? POOL_THREADS : Math.min(POOL_THREADS, Math.max(FLOOR, limit - needs(0)));

  const own = env.UV_THREADPOOL_SIZE;
  if (own) {
    if (!/^[1-9]\d*$/.test(own) || Number(own) > LIBUV_MAX) {
      refuse(`UV_THREADPOOL_SIZE=${JSON.stringify(own)} is not a number of threads from 1 to ${LIBUV_MAX}: set one, or unset it for Mason's ${POOL_THREADS}`);
      return null;
    }
    const size = Number(own);
    if (limit !== null && size > FLOOR && limit < needs(size)) {
      refuse(`UV_THREADPOOL_SIZE=${own} does not fit: this machine allows ${limit} threads, Mason would need about ${needs(size)}, and Node exits with no message past the limit: set UV_THREADPOOL_SIZE=${fitting}`);
      return null;
    }
    return size;
  }
  if (fitting < POOL_THREADS && o.announce === true) {
    say(`this machine allows ${limit} threads and Mason wants about ${needs(POOL_THREADS)}, so it uses a pool of ${fitting}: set UV_THREADPOOL_SIZE=${fitting} to choose it, or another that fits`);
  }
  env.UV_THREADPOOL_SIZE = String(fitting);
  return fitting;
}

sizePool({ announce: ["start", "serve"].includes(process.argv[2] ?? "") });

module.exports = { sizePool, POOL_THREADS };
