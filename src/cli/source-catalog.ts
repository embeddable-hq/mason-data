/**
 * THE DATABASE'S CATALOG AS A RUN HOLDS IT (issue 890): the tables this user can read, their columns and keys, the
 * views — what `mason tables`, `mason add`, `mason status`, `mason doctor` and the web page show of the database while
 * Mason runs. Read at the start (src/cli/preflight.ts checkSource), then again ONLY WHEN ASKED: a run read it on a
 * 10-second timer, a connection to the database every 10 s whatever each table's sync, which kept a serverless compute
 * awake and billing with every table `sync: off`. Now a reader that shows the catalog asks for a FRESH one, and gets
 * the last read when it is under `CATALOG_FRESH_MS` old (so a page's polls do not each connect), else one read now —
 * one at a time, every asker of the moment sharing it. A reader that must never connect (a usage sample, `/metrics`)
 * takes the last read as it is. A failed read leaves the last in place, is said in the run's log, and is not tried
 * again within `CATALOG_FRESH_MS`: a database that is away is not asked every 2 s by an open page.
 *
 * There is no timer here, and none may be added: nothing reads the database's catalog unless something asked.
 */
import type { SourceFacts } from "./preflight.ts";

/** How old a read of the catalog may be and still be shown: about a minute (the owner's choice, issue 890). */
export const CATALOG_FRESH_MS = 60_000;

export interface SourceCatalog {
  /** The last read, whatever its age: for a reader that must not connect. */
  facts(): SourceFacts;
  /** A read no older than `CATALOG_FRESH_MS`: the last one when it is that young, else one read now (shared by every
   *  asker while it runs). A read that fails leaves the last in place, and this answers it. */
  fresh(): Promise<SourceFacts>;
}

/**
 * The catalog of a run, starting from the read the start made (`first`, read at `o.now()`); `read` connects, reads and
 * closes, throwing when it cannot (its message is said in the log, never a password: src/cli/preflight.ts reads it).
 */
export function sourceCatalog(first: SourceFacts, read: () => Promise<SourceFacts>,
  o: { log: (m: string) => void; now?: () => number; freshMs?: number }): SourceCatalog {
  const now = o.now ?? Date.now;
  const freshMs = o.freshMs ?? CATALOG_FRESH_MS;
  let facts = first;
  // when the last read was ASKED for, whether it succeeded or not: a failed one is not tried again within freshMs
  let askedAt = now();
  let reading: Promise<SourceFacts> | null = null;
  return {
    facts: () => facts,
    fresh: () => {
      if (reading !== null) return reading;
      if (now() - askedAt < freshMs) return Promise.resolve(facts);
      askedAt = now();
      reading = read().then((f) => { facts = f; return f; }, (e: unknown) => {
        // tolerated: the last read stays in place (the commands and the page show it), and the failure is said
        o.log(`the database's tables could not be read again (${(e as Error).message}): the tables read before are shown until a read succeeds`);
        return facts;
      }).finally(() => { reading = null; });
      return reading;
    },
  };
}
