/**
 * THE DATABASE'S CATALOG AS A RUN HOLDS IT (issue 890): the tables this user can read, their columns and keys, the
 * views — what `mason tables`, `mason add`, `mason status`, `mason doctor` and the web page show of the database while
 * Mason runs. Read at the start (src/cli/preflight.ts checkSource), then again ONLY WHEN ASKED: a run read it on a
 * 10-second timer, a connection to the database every 10 s whatever each table's sync, which kept a serverless compute
 * awake and billing with every table `sync: off`. Three readers:
 *
 * - one that must never connect (a usage sample, `/metrics`) takes the last read as it is (`facts`);
 * - one that SHOWS it (`/api/state`: the commands and the page) asks `fresh`: the last read when one began under
 *   `CATALOG_FRESH_MS` ago, else the read running, else one read now — waited for at most `waitMs`, the last read
 *   answering after that (the review of PR 900, B1: a read queued behind a lock left the run answering nothing);
 * - one that ACTS on it (an add, a remove, a table's columns or Sync choice) asks `now`: a read begun after it asked —
 *   never the last one, however young (B2: an add was refused a table made a moment before) — waited for at most
 *   `waitMs`; a read that failed is said with its reason, one still running is said as such, never an older read
 *   answered as if it were the database now (the re-check of PR 900). A read still running when an actor stops waiting
 *   goes on, and the next actor takes it: a catalog whose read takes longer than any one wait (10,000 tables, 76 s) is
 *   read once, and the add asked again uses it.
 *
 * A read is never held to a cap shorter than it can need: its session gives up on a LOCK after
 * `CATALOG_LOCK_TIMEOUT_MS` (a table's size takes a lock of it, which a migration holds or queues for), and the whole
 * read only after `CATALOG_READ_TIMEOUT_MS`, which guards a connection gone silent, never a large catalog. A failed read
 * leaves the last in place and is said in the run's log; what only shows the catalog does not try again within
 * `CATALOG_FRESH_MS`, so a database that is away is not asked every 2 s by an open page.
 *
 * There is no timer here, and none may be added: nothing reads the database's catalog unless something asked.
 */
import type { SourceFacts } from "./preflight.ts";
import type { Failure } from "./command.ts";

/**
 * What an actor says when its read is not the database now (the re-check of PR 900: an add answered "no table" from an
 * older read): null for a read, else the failure — the read failed, and why (a lock another session holds, said as such),
 * or it is still running — each with the way out. Never an older read in its place.
 */
export function catalogFailure(r: ReadNow, database: string): Failure | null {
  if ("facts" in r) return null;
  if ("failed" in r) {
    const lock = /lock timeout/i.test(r.failed);
    return { code: "failed", message: `the tables of ${database} could not be read just now: ${r.failed}`,
      ...(lock ? { why: `another session holds a lock on one of its tables (a migration, often), and Mason waits on a lock at most ${CATALOG_LOCK_TIMEOUT_MS / 1000} s` } : {}),
      fix: lock ? "run it again once that session's transaction ends" : "run it again in a moment",
      next: [["mason doctor", "checks the machine and the project's database"]] };
  }
  return { code: "failed", message: `the tables of ${database} are still being read (for ${r.running} s)`,
    why: "a database with many tables takes a while to read, or the connection is slow",
    fix: "run it again in a moment: it uses that read once it ends",
    next: [["mason logs", "says if the read fails"]] };
}

/** How old a read of the catalog may be and still be shown: about a minute (the owner's choice, issue 890). */
export const CATALOG_FRESH_MS = 60_000;
/** The longest a read may take before it is a failed one, its connection closed: a guard for a connection gone silent,
 *  far past what a large catalog needs (10,000 tables read in 76 s, the re-check of PR 900). */
export const CATALOG_READ_TIMEOUT_MS = 15 * 60_000;
/** The read's session waits on a lock at most this long (src/cli/dev.ts). */
export const CATALOG_LOCK_TIMEOUT_MS = 2_000;
/** How long `/api/state` waits for a read before it answers with the last one. */
export const STATE_WAIT_MS = 2_000;
/** How long an add, a remove, a table's columns or Sync choice wait for their read before they say it still runs: under
 *  the 30 s a command waits for the run (src/cli/control.ts callRun), so a slow read is never said as Mason down. */
export const ACT_WAIT_MS = 20_000;

/** What an actor's ask came to: the read, one that failed and why, or one still running and for how long. */
export type ReadNow = { facts: SourceFacts } | { failed: string } | { running: number };

export interface SourceCatalog {
  /** The last read, whatever its age: for a reader that must not connect. */
  facts(): SourceFacts;
  /** For what shows the catalog: a read as `CATALOG_FRESH_MS` allows, waited for at most `waitMs` (default: until it
   *  ends), else the last one. Never fails: a failed read answers the last. */
  fresh(o?: { waitMs?: number }): Promise<SourceFacts>;
  /** For what acts on it: a read begun after it asked (or after an earlier actor that stopped waiting asked), waited for
   *  at most `waitMs` — never an older read in its place. */
  now(o?: { waitMs?: number }): Promise<ReadNow>;
}

interface Read { startedAt: number; endedAt: number; done: Promise<{ facts: SourceFacts } | { failed: string }>; ended: { facts: SourceFacts } | { failed: string } | null }

/**
 * The catalog of a run, starting from the read the start made (`first`, read at `o.now()`); `read` connects, reads and
 * closes, throwing when it cannot (its message is said, never a password: src/cli/preflight.ts reads it), and closes its
 * connection when `signal` aborts.
 */
export function sourceCatalog(first: SourceFacts, read: (signal: AbortSignal) => Promise<SourceFacts>,
  o: { log: (m: string) => void; now?: () => number; freshMs?: number; readTimeoutMs?: number }): SourceCatalog {
  const clock = o.now ?? Date.now;
  const freshMs = o.freshMs ?? CATALOG_FRESH_MS;
  const readTimeoutMs = o.readTimeoutMs ?? CATALOG_READ_TIMEOUT_MS;
  let facts = first;
  // the start of the read `facts` is: an older read ending later never replaces a newer one
  let factsFrom = clock();
  let latest: Read = { startedAt: factsFrom, endedAt: factsFrom, done: Promise.resolve({ facts: first }), ended: { facts: first } };
  // the ask of the first actor that stopped waiting while its read ran: a later actor takes a read begun since then, so a
  // read longer than one wait is read once, not begun again at every ask
  let waitingSince: number | null = null;

  const begin = (): Read => {
    const startedAt = clock();
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stop.abort(); reject(new Error(`no answer within ${Math.round(readTimeoutMs / 1000)} s`)); }, readTimeoutMs);
      timer.unref?.();
    });
    const r: Read = { startedAt, endedAt: 0, ended: null, done: Promise.resolve({ failed: "" }) };
    r.done = Promise.race([read(stop.signal), timedOut]).then((f): { facts: SourceFacts } => {
      if (startedAt >= factsFrom) { facts = f; factsFrom = startedAt; }
      return { facts: f };
    }, (e: unknown) => {
      // tolerated for what shows the catalog: the last read stays in place, and the failure is said
      const failed = (e as Error).message;
      o.log(`the database's tables could not be read again (${failed}): the tables read before are shown until a read succeeds`);
      return { failed };
    }).then((x) => { clearTimeout(timer); r.ended = x; r.endedAt = clock(); return x; });
    latest = r;
    return r;
  };

  const waited = <T>(p: Promise<T>, waitMs: number | undefined, otherwise: () => T): Promise<T> => {
    if (waitMs === undefined) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(otherwise()), waitMs); timer.unref?.(); });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };

  return {
    facts: () => facts,
    fresh: (ask = {}) => {
      const at = clock();
      // a read running is shared whatever its age (a large catalog's is long: never a second one beside it); a read begun
      // under freshMs ago, ended or failed, answers as it is
      const r = latest.ended === null || at - latest.startedAt < freshMs ? latest : begin();
      return waited(r.done.then(() => facts), ask.waitMs, () => facts);
    },
    now: async (ask = {}) => {
      const at = clock();
      const since = waitingSince ?? at;
      // a read begun since: running, or ended well (an earlier actor's, ended under freshMs ago) — never a failed one
      // begun before this asked, and never one that ended long ago
      const usable = latest.startedAt >= since && (latest.ended === null
        || (latest.startedAt >= at || (!("failed" in latest.ended) && at - latest.endedAt < freshMs)));
      const r = usable ? latest : begin();
      const answer = await waited<ReadNow>(r.done, ask.waitMs, () => ({ running: Math.round((clock() - r.startedAt) / 1000) }));
      if ("running" in answer) { waitingSince ??= at; return answer; }
      waitingSince = null;
      return answer;
    },
  };
}
