/**
 * WHAT THE COPY HOLDS FOR A POSTGRES TYPE (issues 126 and 129): the one list that says so, read by the copy
 * (src/duck/sync.ts: what it reads and declares), the catalog (the column declared as the source spells it, always), the
 * wire (src/duck/types.ts: the source's OID) and the rewrite (src/duck/rewrite.ts: a literal, a sort).
 *
 * THE CLASS: a type the copy holds as another type. The catalog said the wire's type, and the wire said what DuckDB
 * happened to read (`timetz` as text over DuckDB's TIMETZ, `point` as text over a STRUCT, `box` not copied at all), so a
 * tool believing the catalog sent text functions, and they failed in the engine's words.
 *
 * THE DECISION: the catalog reports the source's type, whatever the copy holds, so Postgres's own analysis decides every
 * statement; and every type is one of two kinds:
 *  - `same` (`NATIVE`): DuckDB holds a value of the type itself, whose order and text are Postgres's;
 *  - `text`: DuckDB holds Postgres's text of the value (`c::text`, an array as `c::text[]`). That is anything `NATIVE`
 *    does not name, a type added to Postgres or made by a user included: nothing falls through to what DuckDB reads.
 * What can be answered over a text is answered (the value, `::text`, `=` and GROUP BY where equal values have one text); an
 * order is not the text's, so a sort is refused by name (`held-type-compare`), and every operator, aggregate and cast
 * stays refused until the oracle has verified it (src/duck/verified.ts).
 *
 * `tests/duck-held-types.test.ts` holds this list to pg_type: a type of Postgres's named neither way fails it.
 */

/** the types DuckDB holds as themselves, as `format_type` spells them with their typmod left off */
const NATIVE = new Set(["smallint", "integer", "bigint", "real", "double precision", "numeric", "text", "character varying", "character", "name", '"char"',
  "boolean", "uuid", "date", "time without time zone", "time with time zone", "timestamp without time zone", "timestamp with time zone", "interval",
  "json", "jsonb", "bytea", "oid",
  // held as their text from the first: an inet's output is the rewrite's and src/duck/types.ts's, a citext's its bytes
  "inet", "citext"]);

/** a built-in type held as its text. `textEqual`: Postgres's equal values have one text, so GROUP BY and DISTINCT are the
 *  text's (a type with no equality never reaches them: Postgres's analysis refuses) */
export interface HeldType { oid: number; array: number; size: number; textEqual: boolean;
  /** Postgres's own function (src/duck/pg-eval.ts, with no source's locale) writes a literal of it as the source does:
   *  a money's text is the source's lc_monetary's, so a literal cannot be compared */
  literal: boolean }
const held = (oid: number, array: number, size: number, textEqual = true, literal = true): HeldType => ({ oid, array, size, textEqual, literal });

/** every built-in type a column can have that `NATIVE` does not name, by its pg_type.typname */
export const HELD: Readonly<Record<string, HeldType>> = {
  point: held(600, 1017, 16, false), lseg: held(601, 1018, 32, false), path: held(602, 1019, -1, false), box: held(603, 1020, 32, false), polygon: held(604, 1027, -1, false),
  line: held(628, 629, 24, false), circle: held(718, 719, 24, false), money: held(790, 791, 8, true, false), macaddr: held(829, 1040, 6), macaddr8: held(774, 775, 8), cidr: held(650, 651, -1),
  bit: held(1560, 1561, -1), varbit: held(1562, 1563, -1), tsvector: held(3614, 3643, -1), tsquery: held(3615, 3645, -1, false), xml: held(142, 143, -1, false),
  jsonpath: held(4072, 4073, -1, false), tid: held(27, 1010, 6), xid: held(28, 1011, 4), cid: held(29, 1012, 4), xid8: held(5069, 271, 8), pg_lsn: held(3220, 3221, 8),
  regclass: held(2205, 2210, 4), regtype: held(2206, 2211, 4), regproc: held(24, 1008, 4), regprocedure: held(2202, 2207, 4), regoper: held(2203, 2208, 4), regoperator: held(2204, 2209, 4),
  regconfig: held(3734, 3735, 4), regdictionary: held(3769, 3770, 4), regnamespace: held(4089, 4090, 4), regrole: held(4096, 4097, 4), regcollation: held(4191, 4192, 4),
  int4range: held(3904, 3905, -1), int8range: held(3926, 3927, -1), daterange: held(3912, 3913, -1), tsrange: held(3908, 3909, -1), tstzrange: held(3910, 3911, -1, false),
  numrange: held(3906, 3907, -1, false), int4multirange: held(4451, 6150, -1), int8multirange: held(4536, 6157, -1), datemultirange: held(4535, 6155, -1), tsmultirange: held(4533, 6152, -1),
  tstzmultirange: held(4534, 6153, -1, false), nummultirange: held(4532, 6151, -1, false), int2vector: held(22, 1006, -1), oidvector: held(30, 1013, -1), aclitem: held(1033, 1034, 16),
  refcursor: held(1790, 2201, -1), pg_snapshot: held(5038, 5039, -1, false), txid_snapshot: held(2970, 2949, -1, false),
};

/** `oid`'s array: DuckDB reads no array of it, so the copy holds it as a list of its digits */
export const OID_ARRAY = 1028;

const HELD_OIDS = new Map(Object.values(HELD).map((h) => [h.oid, h] as const));
const HELD_ARRAYS = new Map<number, HeldType>([...Object.values(HELD).map((h) => [h.array, h] as const), [OID_ARRAY, held(26, OID_ARRAY, -1)]]);
/** a built-in type held as its text, by its OID or its array's */
export const heldType = (oid: number | null): HeldType | undefined => oid === null ? undefined : HELD_OIDS.get(oid) ?? HELD_ARRAYS.get(oid);
/** a held type's name, for a refusal */
export const heldName = (oid: number): string => Object.entries(HELD).find(([, h]) => h.oid === oid || h.array === oid)?.[0] ?? (oid === 18 ? '"char"' : oid === OID_ARRAY ? "oid[]" : String(oid));
/** an array of a type held as its text: a list of each element's text */
export const isHeldArray = (oid: number | null): boolean => oid !== null && HELD_ARRAYS.has(oid);

/** a time written in the session's zone, which the copy's text cannot be: written again where the statement executes */
export const ZONED_HELD: ReadonlyMap<number, string> = new Map([[3910, "tstzrange"], [4534, "tstzmultirange"]]);

/** what `format_type` writes, its typmod and `[]` left off (`time(3) with time zone`, `bit(8)`, `numeric(12,2)[]`) */
const baseOf = (spelled: string): string => spelled.replace(/\[\]$/, "").replace(/\(\d+(,\d+)?\)/, "").replace(/\s+/g, " ").trim().replace(/^interval .*/, "interval");

/** whether DuckDB holds a value of this type as itself */
export const isNative = (spelled: string): boolean => NATIVE.has(baseOf(spelled));

/** How the copy holds a column of the source's type `spelled` (`typeKind`: pg_type.typtype of the type or its element).
 *  An enum is DuckDB's ENUM; any other type a database made is its text. */
export function holdOf(spelled: string, typeKind?: string): "same" | "text" | "text[]" {
  const array = spelled.endsWith("[]");
  if (typeKind === "e" || (isNative(spelled) && !(array && baseOf(spelled) === "oid"))) return "same";
  return array ? "text[]" : "text";
}
