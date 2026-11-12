/**
 * THE DATABASE'S CATALOG AS A RUN HOLDS IT (issue 890): the tables this user can read, their columns and keys, the
 * views — what `mason tables`, `mason add`, `mason status`, `mason doctor` and the web page show of the database while
 * Mason runs. Read at the start (src/cli/preflight.ts checkSource), then again ONLY WHEN ASKED: a run read it on a
 * 10-second timer, a connection to the database every 10 s whatever each table's sync, which kept a serverless compute
 * awake and billing with every table `sync: off`. A reader that must never connect (a usage sample, `/metrics`) takes
 * the last read as it is (`facts`); one that shows or checks against the catalog asks `fresh`:
 *
 * - what SHOWS it (`/api/state`: the commands and the page) gets the last read when it is under `CATALOG_FRESH_MS` old,
 *   so a page's polls do not each connect, else one read now — and waits for it at most `waitMs`, answering the last
 *   read after that (the review of PR 900: a read held by a lock left the run answering nothing for 30 s);
 * - what ACTS on it (an add, a remove, a table's columns or Sync choice) asks `maxAgeMs: 0`: a read made after it asked,
 *   so a table made a moment ago is there (the same review: an add was refused a table `mason tables` had just listed).
 *
 * One read at a time, every asker it is fresh enough for sharing it. A read is bounded (`readTimeoutMs`): one that does
 * not end by then is a failed read, its connection closed through the signal `read` is given. A failed read leaves the
 * last in place, is said in the run's log, and is not tried again within `CATALOG_FRESH_MS` by what only shows it: a
 * database that is away is not asked every 2 s by an open page.
 *
 * There is no timer here, and none may be added: nothing reads the database's catalog unless something asked.
 */
import type { SourceFacts } from "./preflight.ts";

/** How old a read of the catalog may be and still be shown: about a minute (the owner's choice, issue 890). */
export const CATALOG_FRESH_MS = 60_000;
/** The longest a read may take before it is a failed one, its connection closed. */
export const CATALOG_READ_TIMEOUT_MS = 30_000;
/** The read's session settings (src/cli/dev.ts): a lock waited for at most 2 s (a table's size takes a lock of it,
 *  which a migration holds or queues for), a statement at most 20 s. */
export const CATALOG_LOCK_TIMEOUT_MS = 2_000;
export const CATALOG_STATEMENT_TIMEOUT_MS = 20_000;
/** How long `/api/state` waits for a read it began before it answers with the last one. */
export const STATE_WAIT_MS = 2_000;

/** What an asker needs: a read made at most `maxAgeMs` before it asked (default `CATALOG_FRESH_MS`; 0, one made after
 *  it asked), waited for at most `waitMs` (default: until it ends), after which the last read answers. */
export interface FreshAsk { maxAgeMs?: number; waitMs?: number }

export interface SourceCatalog {
  /** The last read, whatever its age: for a reader that must not connect. */
  facts(): SourceFacts;
  /** A read as fresh as `ask` says, else the last one (a read that failed, or one not ended within `waitMs`). */
  fresh(ask?: FreshAsk): Promise<SourceFacts>;
}

/**
 * The catalog of a run, starting from the read the start made (`first`, read at `o.now()`); `read` connects, reads and
 * closes, throwing when it cannot (its message is said in the log, never a password: src/cli/preflight.ts reads it),
 * and closes its connection when `signal` aborts.
 */
export function sourceCatalog(first: SourceFacts, read: (signal: AbortSignal) => Promise<SourceFacts>,
  o: { log: (m: string) => void; now?: () => number; freshMs?: number; readTimeoutMs?: number }): SourceCatalog {
  const now = o.now ?? Date.now;
  const freshMs = o.freshMs ?? CATALOG_FRESH_MS;
  const readTimeoutMs = o.readTimeoutMs ?? CATALOG_READ_TIMEOUT_MS;
  let facts = first;
  // when the last read was BEGUN, whether it succeeded or not: a failed one is not tried again within freshMs by a shower
  let begunAt = now();
  let reading: { startedAt: number; done: Promise<SourceFacts> } | null = null;

  const begin = (): Promise<SourceFacts> => {
    const startedAt = now();
    begunAt = startedAt;
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stop.abort(); reject(new Error(`no answer within ${readTimeoutMs / 1000} s`)); }, readTimeoutMs);
      timer.unref?.();
    });
    const done: Promise<SourceFacts> = Promise.race([read(stop.signal), timedOut]).then((f) => { facts = f; return f; }, (e: unknown) => {
      // tolerated: the last read stays in place (the commands and the page show it), and the failure is said
      o.log(`the database's tables could not be read again (${(e as Error).message}): the tables read before are shown until a read succeeds`);
      return facts;
    }).finally(() => {
      clearTimeout(timer);
      if (reading?.done === done) reading = null;
    });
    reading = { startedAt, done };
    return done;
  };

  // a read made at or after `since`: the one running when it began then, else a new one once the running one ends
  const readSince = async (since: number): Promise<SourceFacts> => {
    while (reading !== null && reading.startedAt < since) await reading.done;
    return reading !== null ? reading.done : begin();
  };

  return {
    facts: () => facts,
    fresh: (ask = {}) => {
      const at = now();
      const maxAgeMs = ask.maxAgeMs ?? freshMs;
      let answer: Promise<SourceFacts>;
      if (reading !== null && reading.startedAt >= at - maxAgeMs) answer = reading.done;
      else if (reading === null && at - begunAt < maxAgeMs) return Promise.resolve(facts);
      else answer = readSince(maxAgeMs === 0 ? at : at - maxAgeMs);
      if (ask.waitMs === undefined) return answer;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<SourceFacts>((resolve) => { timer = setTimeout(() => resolve(facts), ask.waitMs); timer.unref?.(); });
      return Promise.race([answer, waited]).finally(() => clearTimeout(timer));
    },
  };
}
