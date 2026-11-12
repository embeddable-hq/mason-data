/**
 * A TYPE A DATABASE MADE IS COMPARED BY WHAT ITS OID NAMES, NEVER BY THE NUMBER (issue 861). Mason sends its catalog's
 * own OID for a type the source made (an enum, a citext, a composite, a table's row type, an array of one): its catalog
 * is a Postgres of its own, which numbers the types it made itself, so its number is not the source's. What a client reads by the OID is the type its server's pg_type names, and that is what the oracle
 * holds equal: each side's OID at or past 16384 (FirstNormalObjectId) as its own server's pg_type names it,
 * schema-qualified, EQUAL NUMBERS INCLUDED: the same number naming `public.mood` on one side and `public.moods` on the
 * other is #861's own bug, never equal. A built-in type's OID (below 16384) is the same in every Postgres and stays held
 * to EXACT equality. An OID a side's pg_type does not hold is never equal, whatever the other side's. This relaxes
 * nothing else: a made type sent as another made type, or as a built-in one, still differs.
 */
import type pg from "pg";

/** FirstNormalObjectId: the first OID a database gives an object of its own */
export const FIRST_MADE_OID = 16384;

/** each side's made types, by OID: `schema.typname`, read by `readMadeTypes` */
export const madeTypes = { source: new Map<number, string>(), mason: new Map<number, string>() };

/** a side's types made past initdb, as its own pg_type names them; read again before each phase, so a catalog started
 *  again (it is idle-stopped and rebuilt when the synced tables change) is read as it is now */
export async function readMadeTypes(c: pg.Client, into: Map<number, string>): Promise<void> {
  const r = await c.query({ text: "SELECT t.oid::int8::text, n.nspname || '.' || t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace " +
    `WHERE t.oid >= ${FIRST_MADE_OID}`, rowMode: "array" });
  into.clear();
  for (const [oid, name] of r.rows as Array<[string, string]>) into.set(Number(oid), name);
}

/** Postgres's OID `want` and Mason's `got` are one type: a built-in one by its number, a made one by the names its own
 *  servers give it (`names`: `madeTypes`, read before each phase), never by the number, and never when a side lacks it */
export function sameType(want: number, got: number, names: { source: ReadonlyMap<number, string>; mason: ReadonlyMap<number, string> } = madeTypes): boolean {
  if (want < FIRST_MADE_OID || got < FIRST_MADE_OID) return want === got;
  const theirs = names.source.get(want);
  return theirs !== undefined && theirs === names.mason.get(got);
}

/** every column's type the same, by `sameType` */
export const sameTypes = (want: readonly number[], got: readonly number[], names: { source: ReadonlyMap<number, string>; mason: ReadonlyMap<number, string> } = madeTypes): boolean =>
  want.length === got.length && want.every((o, i) => sameType(o, got[i]!, names));
