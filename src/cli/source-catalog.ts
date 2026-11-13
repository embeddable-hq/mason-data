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
 *   answering after that (the review of PR 900: a read queued behind a lock left the run answering nothing);
 * - one that ACTS on it (an add, a remove, a table's columns or Sync choice) asks for a read of its own (`ask`) and
 *   waits for it (`wait`), by the read's number, which it may carry to its next request: a read BEGUN AFTER IT ASKED,
 *   never one begun before, however young (the re-check of PR 900: an add answered "no table" of a table made after the
 *   read it was given began). An add's steps carry the number of the read its first step was given, so one read serves
 *   the whole add, every table of it; and a read longer than one request's wait is waited for again by its number, so
 *   a catalog that takes 44 s to read is read once, never begun again at every ask.
 *
 * ONE READ AT A TIME (CLAUDE.md "Keep the load on Mason's side"; the re-check put 11 at once on the source, each 44 s
 * read stretched to 2.5 min): an actor that asks while one runs — begun before it asked, so never its read — is given the
 * NEXT read, which begins when that one ends and is shared by every actor that asked meanwhile.
 *
 * A read is never held to a cap shorter than it can need: its session gives up on a LOCK after
 * `CATALOG_LOCK_TIMEOUT_MS` (a table's size takes a lock of it, which a migration holds or queues for); a read whose
 * session the database says is not working on it is a connection gone silent, ended (src/cli/dev.ts's watch); and
 * `CATALOG_READ_TIMEOUT_MS` is the last guard. A failed read leaves the last in place and is said in the run's log; what
 * only shows the catalog does not try again within `CATALOG_FRESH_MS`, so a database that is away is not asked every 2 s
 * by an open page.
 *
 * There is no timer here, and none may be added: nothing reads the database's catalog unless something asked.
 */
import type { SourceFacts } from "./preflight.ts";
import type { Failure } from "./command.ts";

/** How old a read of the catalog may be and still be shown: about a minute (the owner's choice, issue 890). */
export const CATALOG_FRESH_MS = 60_000;
/** The last guard on a read: far past what a large catalog needs (10,000 tables read in 44–76 s, the re-checks of PR
 *  900); a connection gone silent is ended much sooner, by the database's word (src/cli/dev.ts). */
export const CATALOG_READ_TIMEOUT_MS = 15 * 60_000;
/** The read's session waits on a lock at most this long (src/cli/dev.ts). */
export const CATALOG_LOCK_TIMEOUT_MS = 2_000;
/** How long `/api/state` waits for a read before it answers with the last one. */
export const STATE_WAIT_MS = 2_000;
/** How long one request of an actor waits for its read before it answers that the read still runs, with the read's
 *  number to wait on again: under the 30 s a command waits for the run (src/cli/control.ts callRun), so a slow read is
 *  never said as Mason down. */
export const ACT_WAIT_MS = 20_000;
/** The header an actor's request carries the number of its read in, and the answer says it in. */
export const CATALOG_READ_HEADER = "x-mason-catalog-read";

/** What an actor's wait came to: the read, one that failed and why, or one still running and for how long. */
export type ReadNow = { facts: SourceFacts } | { failed: string } | { running: number };
type Outcome = { facts: SourceFacts } | { failed: string };

export interface SourceCatalog {
  /** The last read, whatever its age: for a reader that must not connect. */
  facts(): SourceFacts;
  /** For what shows the catalog: a read as `CATALOG_FRESH_MS` allows, waited for at most `waitMs` (default: until it
   *  ends), else the last one. Never fails: a failed read answers the last. */
  fresh(o?: { waitMs?: number }): Promise<SourceFacts>;
  /** For what acts on it: the number of a read that begins after this asked — now when none runs, else the next one. */
  ask(): number;
  /** The read numbered `read` (or a later one that succeeded), waited for at most `waitMs`; null for a number this
   *  catalog never gave (the actor asks again). */
  wait(read: number, o?: { waitMs?: number }): Promise<ReadNow | null>;
}

interface Read { seq: number; askedAt: number; startedAt: number | null; outcome: Outcome | null; done: Promise<Outcome> }

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
  // the number of the read `facts` is (0: the start's), and the reads given out
  let factsSeq = 0, issued = 0;
  // when the last read began: what only shows the catalog does not begin another within freshMs
  let begunAt = clock();
  let running: Read | null = null;
  let queued: Read | null = null;
  // the reads given out, kept a while by number: an actor waits on its own again by it
  const reads = new Map<number, Read>();

  const keep = (r: Read): void => {
    reads.set(r.seq, r);
    for (const seq of reads.keys()) if (reads.size > 64 && seq < r.seq - 32) reads.delete(seq);
  };

  /** Runs `r` now: one read on the database, bounded by the last guard. */
  const run = (r: Read): Promise<Outcome> => {
    r.startedAt = clock();
    begunAt = r.startedAt;
    running = r;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stop.abort(); reject(new Error(`no answer within ${Math.round(readTimeoutMs / 1000)} s`)); }, readTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([read(stop.signal), timedOut]).then((f): Outcome => {
      // one read at a time, so a later number is a later read: the newest that succeeded is what is shown
      if (r.seq >= factsSeq) { facts = f; factsSeq = r.seq; }
      return { facts: f };
    }, (e: unknown): Outcome => {
      // tolerated for what shows the catalog: the last read stays in place, and the failure is said; an actor is told it
      const failed = (e as Error).message;
      o.log(`the database's tables could not be read again (${failed}): the tables read before are shown until a read succeeds`);
      return { failed };
    }).then((x) => {
      clearTimeout(timer);
      r.outcome = x;
      running = null;
      return x;
    });
  };

  const fresh = (): Read => {
    const r: Read = { seq: ++issued, askedAt: clock(), startedAt: null, outcome: null, done: Promise.resolve({ failed: "" }) };
    keep(r);
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
      // a read running is shared, whatever its age (a large catalog's is long: never a second one beside it); a read
      // begun under freshMs ago, ended or failed, answers as it is
      const busy = queued ?? running;
      if (busy !== null) return waited(busy.done.then(() => facts), ask.waitMs, () => facts);
      if (clock() - begunAt < freshMs) return Promise.resolve(facts);
      const r = fresh();
      r.done = run(r);
      return waited(r.done.then(() => facts), ask.waitMs, () => facts);
    },
    ask: () => {
      if (queued !== null) return queued.seq;
      if (running === null) { const r = fresh(); r.done = run(r); return r.seq; }
      // one runs, begun before this asked: the next one, shared by every actor that asks while this one runs; it begins
      // when the one running ends (whose settling has left `running` empty by then)
      const r = fresh();
      r.done = running.done.then(() => { queued = null; return run(r); });
      queued = r;
      return r.seq;
    },
    wait: async (seq, ask = {}) => {
      if (!Number.isInteger(seq) || seq < 1 || seq > issued) return null;
      const r = reads.get(seq);
      // a read no longer kept: answered by the newest that succeeded when it is that one or later, else asked again
      if (r === undefined) return factsSeq >= seq ? { facts } : null;
      const answer = await waited<Outcome | { running: number }>(r.done, ask.waitMs, () => ({ running: Math.round((clock() - (r.startedAt ?? r.askedAt)) / 1000) }));
      if ("running" in answer) return answer;
      // a later read that succeeded is as good as this one (it began later still)
      if ("failed" in answer && factsSeq > seq) return { facts };
      return "facts" in answer ? { facts } : answer;
    },
  };
}

/** How often a read that has not ended is asked after (the database, on a connection of its own, about the read's own
 *  session), and how long that session may have done nothing on it before the read is said gone silent. */
export const SILENT_CHECK_MS = 15_000;
export const SILENT_AFTER_S = 10;

/**
 * A WATCH ON A READ THAT DOES NOT END (the re-check of PR 900: a connection gone silent after login held every add for
 * the whole quarter of an hour of the last guard): every `everyMs`, `check` asks the database whether the read's own
 * session is working on it, and answers a reason when it is not (gone, or idle a while), null when it is (a large
 * catalog's read is long, and is never cut); one that cannot tell (it throws: the database away, a connection refused)
 * is "couldn't tell", and the watch goes on. On a reason, `onSilent` is told once and the watch ends. A slow read pays one
 * small query each `everyMs`, only while it runs past it.
 */
export function silentWatch(o: { everyMs?: number; check: () => Promise<string | null>; onSilent: (why: string) => void }): () => void {
  let stopped = false, checking = false;
  const timer = setInterval(() => {
    if (stopped || checking) return;
    checking = true;
    void o.check().then((why) => {
      if (why !== null && !stopped) { stopped = true; clearInterval(timer); o.onSilent(why); }
    }, () => undefined /* couldn't tell: the read goes on, asked after again at the next turn */).finally(() => { checking = false; });
  }, o.everyMs ?? SILENT_CHECK_MS);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/** What an actor's request came to: the number of its read (to carry to its next request), and null when that read is
 *  the database now, else the failure to answer — `running` when the same number can be waited on again. */
export interface ActRead { read: number; failure: Failure | null; running: boolean }

/** An actor's request: its own read (`carried`, the number an earlier request of the same act was given, else a new
 *  one), waited for `ACT_WAIT_MS`. */
export async function actRead(catalog: SourceCatalog, carried: number | null, database: string, waitMs = ACT_WAIT_MS): Promise<ActRead> {
  let read = carried ?? catalog.ask();
  let r = await catalog.wait(read, { waitMs });
  // a number this run never gave (another run's, or made up): a read of its own
  if (r === null) { read = catalog.ask(); r = (await catalog.wait(read, { waitMs }))!; }
  return { read, failure: catalogFailure(r, database), running: "running" in r };
}

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
