/**
 * A LIMIT MASON SETS ON A CONNECTION ENDS WITH MASON'S OWN WORK (issue 930). A session `SET statement_timeout` stays
 * on the server connection until it closes. Behind a pooler in transaction mode (PgBouncer's `pool_mode =
 * transaction`, Supabase's default pooler URL), that server connection is handed to the application's next client
 * with nothing reset. So the application's queries ran under Mason's limit for as long as the connection lived (an
 * hour by default), on its own production database. PR 900 met the same with the catalog read's `lock_timeout`.
 *
 * So every limit is `SET LOCAL`, inside ONE read-only transaction around the work, and never a session `SET`. A
 * setting made LOCAL ends with the transaction, whatever the pooler does. Every way out ends the transaction:
 * - COMMIT when the work succeeds;
 * - ROLLBACK after any failure (a timeout, a refusal, a cancel), while the connection still answers, bounded;
 * - else the connection's close, which Postgres rolls back. A pooler closes a server connection whose client left
 *   in a transaction: it never hands one on mid-transaction.
 *
 * The work must be reads alone: the transaction is READ ONLY. The caller closes the connection after.
 */

/** How long a ROLLBACK after a failure is waited for before the caller's close ends the transaction instead. */
export const ROLLBACK_WAIT_MS = 5_000;

/** A setting's name as SET takes it bare: lower-case letters, digits and `_`. */
const NAME = /^[a-z_][a-z0-9_]*$/;

/** `work` inside `BEGIN READ ONLY`, under each of `settings` as `SET LOCAL`, then COMMIT; ROLLBACK on every failure
 *  while `answers()` (the connection is not closed), waited for at most `rollbackMs`. The work's own error is thrown
 *  as it was. */
export async function withLocalSettings<T>(o: {
  query: (sql: string) => Promise<unknown>;
  settings: ReadonlyArray<readonly [name: string, value: number]>;
  work: () => Promise<T>;
  /** false once the connection is closed: no ROLLBACK is sent, the close ended the transaction */
  answers?: () => boolean;
  /** sends the ROLLBACK (default: `query`) */
  rollback?: () => Promise<unknown>;
  rollbackMs?: number;
  /** called once the work has ended, however, before any ROLLBACK is sent */
  settle?: () => void;
  log: (m: string) => void;
}): Promise<T> {
  // checked before anything is sent: a name or a value the SET would read as something else is a bug, refused
  for (const [name, value] of o.settings) {
    if (!NAME.test(name)) throw new Error(`a local setting's name must be a bare word, not ${JSON.stringify(name)}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`the local setting ${name} must be a whole number of 0 or more, not ${value}`);
  }
  let begun = false;
  try {
    await o.query("BEGIN READ ONLY");
    begun = true;
    // LOCAL: this transaction's alone, never the server connection's
    for (const [name, value] of o.settings) await o.query(`SET LOCAL ${name} = ${value}`);
    const out = await o.work();
    await o.query("COMMIT");
    begun = false;
    return out;
  } finally {
    o.settle?.();
    if (begun && (o.answers?.() ?? true)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => { timer = setTimeout(resolve, o.rollbackMs ?? ROLLBACK_WAIT_MS); timer.unref?.(); });
      const rollback = o.rollback ?? (() => o.query("ROLLBACK"));
      // tolerated: the caller closes the connection next, and the database rolls back a transaction whose client is gone
      await Promise.race([rollback().then(() => undefined), late])
        .catch((e: unknown) => o.log(`a transaction Mason opened could not be rolled back (${(e as Error).message}): its connection is closed, which ends it`))
        .finally(() => clearTimeout(timer));
    }
  }
}
