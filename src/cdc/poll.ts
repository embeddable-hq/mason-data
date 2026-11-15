/**
 * THE POLL'S SQL (so that development can read a local database without WAL): the
 * xmin poll `mason start` keeps a copy current with by default (src/duck/sync.ts), with plain SELECTs — no
 * `wal_level=logical`, no replication slot, no publication, no REPLICATION attribute, nothing created or changed on
 * the source. Each poll reads, in one snapshot, every row whose `xmin` (the transaction that wrote this version of it)
 * is at or past the WATERMARK — the oldest transaction still running at the last poll (`pg_snapshot_xmin`):
 * everything that committed before it was read by an earlier poll (or the copy); a transaction that was running then
 * has an id at or past it, and so has every subtransaction of it (a savepoint's rows carry the SUBtransaction's id,
 * which `pg_visible_in_snapshot` would misjudge, so the bound is a range, never a visibility test). A copy taken in
 * several source transactions is held to its first snapshot by the complement (`xminBeforeSql`).
 *
 * WHAT IT COSTS THE SOURCE: a poll reads every polled table whole (no index covers `xmin`), so the interval stretches
 * to four times what the last poll took (`nextPollDelayMs`).
 */

/** How the run learns what changed — Postgres's logical replication stream, or polling. */
export type ChangeSource = "replication" | "poll";

/** The snapshot's `xmin` — the oldest transaction running when it was taken — from its text (`xmin:xmax:xip,…`). */
export function snapshotXmin(snapshot: string): bigint {
  const m = /^(\d+):(\d+):/.exec(snapshot);
  if (!m) throw new Error(`not a pg_snapshot: ${JSON.stringify(snapshot)}`);
  return BigInt(m[1]!);
}

/** The poll's snapshot, its xmin and xmax (64-bit transaction ids, Postgres 13+), read as the transaction's first statement. */
export const SNAPSHOT_SQL = "SELECT pg_current_snapshot()::text, pg_snapshot_xmax(pg_current_snapshot())::text";

/**
 * A row's `xmin` as a 64-bit transaction id. `xmin` is the 32-bit id; its epoch is the current one, or the one
 * before when its low bits are past the current id's (it was assigned before the counter last wrapped). A row older
 * than one wrap (2^31 transactions) is frozen long since and reads as old either way: it is never at the watermark.
 */
export function xmin8Sql(currentXid8: bigint): string {
  const epoch = currentXid8 >> 32n, low = currentXid8 & 0xffffffffn;
  return `((${epoch}::bigint - (xmin::text::bigint > ${low})::int) << 32 | xmin::text::bigint)`;
}

/**
 * A ROW WRITTEN BEFORE THE WATERMARK: the complement of `xmin8Sql(…) >= watermark` (the poll's "changed since"), for a
 * copy taken in several source transactions that is held to its FIRST snapshot (src/duck/sync.ts `copy`): every
 * transaction that commits after a snapshot has an id at or past its xmin (it was running then, or began later), and a
 * tuple's xmin never changes, so a read in any later snapshot that keeps only these rows keeps none written after the
 * first — and the catch-up poll from that watermark reads every row this leaves out.
 *
 * Written with `age()`, never `xmin::text::bigint` (measured on PG 18 over 3 M rows: the text casts took a
 * scan from 320 to 1,640 ms of the source's CPU, `age` to 437): `age(x)` is the 32-bit distance from the transaction's
 * stable latest id L (the next id, read once per transaction) to `x`, so for every row within 2^31 transactions of L,
 * `age(xmin) > age(watermark)` is exactly "older than the watermark" — while L is within 2^31 of the watermark, which
 * `xminBeforeHolds` checks. A row whose `age` is negative has a raw xmin more than 2^31 transactions old (frozen: a
 * freeze keeps the raw id since 9.4), which `xmin8Sql` may place at or past a watermark: it is kept here AND read again by
 * the catch-up (written by key, so once), never neither. `age` of a special id (frozen, bootstrap) is INT_MAX: kept.
 * Normal ids never have low bits below 3 (FirstNormalTransactionId), so a watermark's below 3 reads as 3: the same rows.
 */
export function xminBeforeSql(watermark: bigint): string {
  const low = watermark & 0xffffffffn;
  return `(age(xmin) > (SELECT age('${low < 3n ? 3n : low}'::xid)) OR age(xmin) < 0)`;
}

/**
 * THE TABLE'S FILE, AS THE READING TRANSACTION'S SNAPSHOT SEES IT AND AS IT IS NOW (issue 1025). A rewrite of the table
 * (TRUNCATE, VACUUM FULL, CLUSTER, an ALTER TABLE that rewrites it, SET TABLESPACE, a pg_repack-style swap) gives it a
 * new file, and is not MVCC-safe: a snapshot taken before it commits reads the NEW file once its read gets the lock,
 * and an ALTER's or a TRUNCATE's rows there are invisible to it — a read of 0 rows that is no error. So:
 *  1. `seen`, pg_class's `relfilenode` read through the transaction's snapshot (a plain SELECT of the catalog is MVCC),
 *     against 2. `now`, `pg_relation_filenode` (the catalog cache, current once the transaction holds a lock on the
 *     table): they differ, or `seen` is null (the name is another table now), when the file changed after the snapshot;
 *  3. `replaced`: the file is not the one the table was created with (`relfilenode` is the oid until a rewrite);
 *  4. `fresh`: the catalog row the snapshot sees was written at or after `watermark` (`xminBeforeSql`'s complement), so
 *     a rewrite there may have given every row an xmin a copy held to that watermark leaves out; null with no watermark;
 *  5. that row's `xmin`, as text: which rewrite it was (a copy that waits for one checks it again by this, unread).
 * Catalog reads only, one row; `regclass` is a literal such as `'public.t'::regclass`. A table with no file of its own
 * (partitioned) reads 0 for both.
 */
export function fileFactsSql(regclass: string, watermark: bigint | null): string {
  const fresh = watermark === null ? "NULL::boolean" : `NOT ${xminBeforeSql(watermark)}`;
  // pg_class alone in the lateral's FROM: `xminBeforeSql` names `xmin` unqualified
  return `SELECT c.relfilenode::bigint AS seen, COALESCE(pg_relation_filenode(r.rel), 0)::bigint AS now, c.relfilenode <> c.oid AS replaced, c.fresh, ` +
    `c.xmin::text AS written_by FROM (SELECT ${regclass}::oid AS rel) r LEFT JOIN LATERAL (SELECT oid, relfilenode, xmin, ${fresh} AS fresh FROM pg_class WHERE oid = r.rel) c ON true`;
}

/**
 * WHETHER A COPY HELD TO `watermark` WOULD READ ANY ROW OF A TABLE (issue 1025), in the reading transaction's snapshot:
 * a row it keeps exists (`kept`), any row exists (`any`), and the backend whose transaction is the watermark, when one
 * is (`pid`: what holds every snapshot's xmin back). Asked only of a table whose file the snapshot sees was made at or
 * after the watermark (`fileFactsSql` `fresh` and `replaced`): a CLUSTER, a VACUUM FULL or a SET TABLESPACE keeps each
 * row's xmin, so `kept` finds one at once; a rewrite that writes its rows again (an ALTER TABLE, a TRUNCATE and a load,
 * pg_repack) leaves none, and the scan reads the table to its end once. Never an ORDER BY on the source.
 */
export function rowsHeldSql(pgFrom: string, watermark: bigint): string {
  const low = watermark & 0xffffffffn;
  return `SELECT EXISTS (SELECT 1 FROM ${pgFrom} WHERE ${xminBeforeSql(watermark)}) AS kept, EXISTS (SELECT 1 FROM ${pgFrom}) AS any, ` +
    `(SELECT pid FROM pg_stat_activity WHERE backend_xid = '${low}'::xid LIMIT 1) AS pid`;
}

/** `xminBeforeSql` is exact while the transaction's latest id is within 2^31 of the watermark: held to a margin of half
 *  that (a billion transactions), `current` being the reading transaction's snapshot xmax (`SNAPSHOT_SQL`) */
export function xminBeforeHolds(current: bigint, watermark: bigint): boolean {
  return current >= watermark && current - watermark < 2n ** 30n;
}

/**
 * The wait before the next poll: the table's interval (its sync:, src/lib/table-sync.ts), or four times what the last
 * poll took when that is longer, so a table that takes a while to read costs at most a fifth of the source's time.
 * Never sooner than either (the test server: a cap of a minute polled a 22 M-row production table every 74 s for 6.5
 * hours under an hourly interval, and a poll of 20 s every 60 s is a third of the source's time): the database's load
 * decides, and a slow poll's freshness is said by its own timing line.
 */
export function nextPollDelayMs(pollMs: number, lastPollMs: number): number {
  return Math.max(pollMs, 4 * lastPollMs);
}
