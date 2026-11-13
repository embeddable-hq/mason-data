/**
 * THE DATABASE'S CATALOG AS A RUN HOLDS IT (issue 890): the tables this user can read, their columns and keys, the
 * views — what `mason tables`, `mason add`, `mason status`, `mason doctor` and the web page show of the database while
 * Mason runs. Read at the start (src/cli/preflight.ts checkSource), then again ONLY WHEN ASKED: a run read it on a
 * 10-second timer, a connection to the database every 10 s whatever each table's sync, which kept a serverless compute
 * awake and billing with every table `sync: off`. Three readers:
 *
 * - one that must never connect (a usage sample, `/metrics`) takes the last read as it is (`facts`);
 * - one that SHOWS it (`/api/state`: the commands and the page) asks `fresh`: the last read when one ended under
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
 * session the database says is not working on it is a connection gone silent, ended (`watchedRead`); and
 * `CATALOG_READ_TIMEOUT_MS` is the last guard. A failed read leaves the last in place and is said in the run's log; what
 * only shows the catalog does not try again within `CATALOG_FRESH_MS`, so a database that is away is not asked every 2 s
 * by an open page.
 *
 * There is no timer here, and none may be added: nothing reads the database's catalog unless something asked.
 */
import { randomBytes } from "node:crypto";
import type { SourceFacts } from "./preflight.ts";
import type { Failure } from "./command.ts";

/** How old a read of the catalog may be and still be shown: about a minute (the owner's choice, issue 890). */
export const CATALOG_FRESH_MS = 60_000;
/** The last guard on a read: far past what a large catalog needs (10,000 tables read in 44–76 s, the re-checks of PR
 *  900); a connection gone silent is ended much sooner, by the database's word (`watchedRead`). */
export const CATALOG_READ_TIMEOUT_MS = 15 * 60_000;
/** The read's session waits on a lock at most this long (`watchedRead`). */
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
  // when the last read ENDED (the start's, then each one's, failed too): what only shows the catalog does not begin
  // another within freshMs of it. Counted from its end, never its start (the review of PR 900 at 0d5a63fc, B2: a read
  // over a minute long was stale the moment it ended, so the add that waited on it began a second, and an open page
  // read the catalog back to back)
  let endedAt = clock();
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
      endedAt = clock();
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
      // that ended under freshMs ago, failed or not, answers as it is
      const busy = queued ?? running;
      if (busy !== null) return waited(busy.done.then(() => facts), ask.waitMs, () => facts);
      if (clock() - endedAt < freshMs) return Promise.resolve(facts);
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

/** How often the watch on a read looks at it. */
export const STALL_LOOK_MS = 5_000;
/** Nothing received on the read's connection for this long: the database is asked whether it still works on the read. */
export const STALL_QUIET_MS = 15_000;
/** Nothing received, and no word from the database that it works on the read, for this long: the read went silent. */
export const STALL_GIVE_UP_MS = 60_000;
/** One question to the database about the read gets this long, its connection included. */
export const STALL_CHECK_MS = 10_000;

/**
 * A WATCH ON A READ THAT DOES NOT END (the re-checks of PR 900: a connection gone silent held every add for the whole
 * quarter of an hour of the last guard). It tells SLOW BUT PROGRESSING from SILENT by progress, never by a cap a large
 * catalog's read could need:
 *
 * - bytes arrive on the read's connection (`lastHeard`): it progresses, and nothing is asked;
 * - none for `quietMs`: `check` asks the database, on a connection of its own and within `checkMs`, about the read's
 *   session. Working on it (null: a long query of a large catalog) — it progresses. Not working on it (a reason: the
 *   session is gone, idle, or waiting to send results that never arrive) — it went silent, and `onSilent` is told;
 * - the database cannot be asked (`check` throws or outlasts `checkMs`: a source that stopped answering altogether) is
 *   "couldn't tell", and the watch looks again; once neither the connection nor the database has said anything for
 *   `giveUpMs`, the read went silent all the same. A read is cheap to begin again, and an add held for a quarter of an
 *   hour is not.
 *
 * `onSilent` is told once, and the watch ends. A read that progresses costs the database nothing; a slow one, one small
 * query each `lookMs` while it is quiet.
 */
export function stallWatch(o: {
  lastHeard: () => number; check: (signal: AbortSignal) => Promise<string | null>; onSilent: (why: string) => void;
  now?: () => number; lookMs?: number; quietMs?: number; giveUpMs?: number; checkMs?: number;
}): () => void {
  const clock = o.now ?? Date.now;
  const quietMs = o.quietMs ?? STALL_QUIET_MS, giveUpMs = o.giveUpMs ?? STALL_GIVE_UP_MS, checkMs = o.checkMs ?? STALL_CHECK_MS;
  let stopped = false, checking = false;
  // when the database last said it works on the read
  let confirmedAt = -Infinity;
  const silent = (why: string): void => { if (!stopped) { stopped = true; clearInterval(timer); o.onSilent(why); } };
  const timer = setInterval(() => {
    if (stopped || checking || clock() - o.lastHeard() < quietMs) return;
    checking = true;
    const ask = new AbortController();
    let limit: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      limit = setTimeout(() => { ask.abort(); reject(new Error(`no answer within ${Math.round(checkMs / 1000)} s`)); }, checkMs);
      limit.unref?.();
    });
    void Promise.race([o.check(ask.signal), late]).then((why) => {
      if (why === null) confirmedAt = clock();
      else silent(why);
    }, (e: unknown) => {
      // couldn't tell: the database could not be asked. Looked at again next time, until nothing at all was heard for
      // giveUpMs: neither bytes on the read's connection nor the database's word
      const heard = Math.max(o.lastHeard(), confirmedAt);
      if (clock() - heard >= giveUpMs) {
        silent(`nothing came from the database for ${Math.round((clock() - o.lastHeard()) / 1000)} s, and it could not be asked whether it still works on the read (${(e as Error).message}): the connection went silent`);
      }
    }).finally(() => { clearTimeout(limit); checking = false; });
  }, o.lookMs ?? STALL_LOOK_MS);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/** A connection a catalog read is made on (src/cdc/pg-wire.ts PgConnection): what the watch needs of it. */
export interface CatalogConnection {
  query(sql: string): Promise<{ rows: Array<Array<string | null>> }>;
  /** Postgres's CancelRequest, sent the way the connection came (through a pooler, with the key the pooler gave) */
  cancel(): Promise<void>;
  close(): void;
  /** when the server last sent this connection anything */
  readonly lastHeardAt: number;
}

/** How long a CancelRequest may take to be sent before the read's connection is closed all the same. */
export const CANCEL_SEND_MS = 5_000;

/**
 * ONE READ OF THE CATALOG, WATCHED (`stallWatch`), on a connection of its own (`connect`), closed when it ends.
 *
 * WHICH SESSION IS THE READ'S is told by what it runs, never by a process id (the review of PR 900 at 0d5a63fc, B1): a
 * pooler or proxy (PgBouncer, Supavisor, Neon's proxy) hands the client an id of its own in BackendKeyData, so asking
 * `pg_stat_activity` about that id found no row, judged the session gone, and ended every read of a large catalog
 * after 15 s. Each statement of the read begins with a comment of its own (`mark`: a random id, and the statement's
 * number), and the check asks the database about the session whose query begins with the CURRENT statement's comment
 * (`statementVerdict`): working on it is slow; done with it (its results never arrived) or blocked sending them
 * (`ClientWrite`) is silent; no such query on the database (the statement queued in a pooler, or its session gone) is
 * "couldn't tell", which ends the read only after `STALL_GIVE_UP_MS` with nothing heard.
 *
 * A READ GIVEN UP ON IS CANCELLED ON THE DATABASE before its connection is closed: closing the socket alone left its
 * query running on the source for its whole length (Postgres notices a client gone only when it writes to it), and a
 * read asked again began a second beside it. The CancelRequest goes the way the connection came, so a pooler maps its
 * own key to the backend's, as it does for any client's cancel.
 */
export async function watchedRead<C extends CatalogConnection>(o: {
  connect: () => Promise<C>;
  read: (pg: Pick<C, "query">) => Promise<SourceFacts>;
  signal: AbortSignal;
  log: (m: string) => void;
  mark?: string;
  watch?: { now?: () => number; lookMs?: number; quietMs?: number; giveUpMs?: number; checkMs?: number };
  cancelMs?: number;
}): Promise<SourceFacts> {
  const mark = o.mark ?? `mason catalog read ${randomBytes(8).toString("hex")}`;
  const c = await o.connect();
  // the statement running now, by its number: what the check asks the database about
  let statement = 0;
  const marked = (n: number): string => `/* ${mark} ${n} */`;
  let silent: string | null = null, ended = false;
  /** Gives the read up: its statement cancelled on the database (the sending bounded), then its connection closed. */
  const giveUp = (why: string): void => {
    if (ended) return;
    ended = true;
    silent = why;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, o.cancelMs ?? CANCEL_SEND_MS); timer.unref?.(); });
    void Promise.race([c.cancel(), late])
      // tolerated: the read ends all the same, its connection closed below; the database may then run the statement to
      // its end, which is said in the log
      .catch((e: unknown) => o.log(`a read of the database's tables that was given up on could not be cancelled there (${(e as Error).message}): its statement may run to its end`))
      .finally(() => { clearTimeout(timer); c.close(); });
  };
  if (o.signal.aborted) { c.close(); throw new Error("the read ran out of time"); }
  o.signal.addEventListener("abort", () => giveUp("the read ran out of time"), { once: true });
  const stopWatch = stallWatch({
    ...o.watch,
    lastHeard: () => c.lastHeardAt,
    check: async (signal) => {
      const asked = statement;
      if (asked === 0) throw new Error("the read has sent nothing yet");
      const p = await o.connect();
      if (signal.aborted) { p.close(); throw new Error("no answer in time"); }
      signal.addEventListener("abort", () => p.close(), { once: true });
      try {
        // the check's own query begins with SELECT, never with the comment: it never finds itself
        const rows = (await p.query("SELECT state, wait_event, extract(epoch FROM now() - state_change)::float8::text FROM pg_stat_activity " +
          `WHERE query LIKE '${marked(asked)}%'`)).rows;
        // the statement asked about ended meanwhile and another began: it progresses
        if (asked !== statement) return null;
        return statementVerdict(rows);
      } finally { p.close(); }
    },
    onSilent: giveUp,
  });
  const tagged = { query: ((sql: string) => c.query(`${marked(++statement)} ${sql}`)) as C["query"] };
  try {
    // never queued behind a lock for long: the sizes it reads take a lock of every table, which a migration's ALTER (or
    // one queued behind another session) holds; this session's settings alone, nothing on the database
    await tagged.query(`SET lock_timeout = ${CATALOG_LOCK_TIMEOUT_MS}`);
    return await o.read(tagged);
  } catch (e) {
    // the read the watch gave up on: said as what it found, never as the cancel or the closed connection
    if (silent !== null) throw new Error(silent);
    throw e;
  } finally {
    stopWatch();
    // a read that ended by itself is closed now; one given up on, once its cancel is sent
    if (!ended) { ended = true; c.close(); }
  }
}

/**
 * What the database says of a read's current statement: `pg_stat_activity`'s rows whose query begins with its comment
 * (state, wait_event, seconds since the state changed). Null while it works on it; the reason when it does not (its
 * results wait to be sent, or it is done with it and they never arrived); thrown when it cannot tell (no such query
 * there: queued in a pooler, or its session gone; or a row this user may not see).
 */
export function statementVerdict(rows: ReadonlyArray<ReadonlyArray<string | null | undefined>>): string | null {
  const row = rows.find((r) => r[0] === "active") ?? rows[0];
  if (row === undefined) throw new Error("the database runs no statement of the read just now");
  if (row[0] === null || row[0] === undefined) throw new Error("the database does not show the read's session to this user");
  // the database waits to send results this run never received: the connection, not the database, is stuck
  if (row[0] === "active" && row[1] === "ClientWrite") return "the database has results for it that do not arrive: the connection went silent";
  if (row[0] === "active") return null;
  return `the database has had nothing to do for it for ${Math.round(Number(row[2]))} s (its session is ${row[0]}): the connection went silent`;
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
