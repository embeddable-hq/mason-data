/**
 * WHAT THE COPY HOLDS FOR A POSTGRES TYPE (issues 126 and 129): the one list that says so, read by the copy
 * (src/duck/sync.ts: what it reads and declares), the catalog (the column declared as the source spells it, always), the
 * wire (src/duck/types.ts: the type's OID, the catalog's for a type a database made) and the rewrite (src/duck/rewrite.ts: a literal, a sort).
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

/**
 * THE ARRAY TYPES A PARAMETER IS BOUND AS A LIST OF, each by its element's OID (issue 983): read by Postgres's own
 * array_in in the catalog (src/duck/analyze.ts readParameters), bound for DuckDB as the list of its elements
 * (src/duck/rewrite.ts `param`), and decoded from a binary Bind (src/api/postgres/server.ts `arrayFromBinary`). One
 * table, so the three agree on which arrays are lists.
 */
export const PARAM_ARRAYS: ReadonlyMap<number, number> = new Map([
  [1000, 16], [1005, 21], [1007, 23], [1016, 20], [1021, 700], [1022, 701], [1231, 1700], [2951, 2950],
  [1182, 1082], [1115, 1114], [1185, 1184], [1009, 25], [1015, 1043],
]);

/**
 * THE SOURCE'S TEXT OF A HELD TYPE (issue 1198).
 *
 * THE CLASS: a source whose text form for a type differs from the catalog Postgres's. The copy holds the source's text
 * of a value, and a literal or a parameter is read by the catalog Postgres (PGlite 18), which writes it in its own form.
 * Postgres 19 writes a pg_lsn's low half as 8 hex digits (`0/016B3748`), where 18 writes `0/16B3748`, so on a 19 source
 * one value had two spellings: `=` found no row, `<>` every row, and a literal printed in 18's form.
 *
 * THE DECISION: a literal or a parameter of a held type is written as the source writes it (`written`), from the
 * source's version read at the start. So each value has one text, in the copy and in the statement, and the text
 * compares as the value does. A statement of no table stays the catalog's, which writes such a value in its own form:
 * one that would print a constant whose text differs (`constDiffers`) is refused by name, `source-text-form`
 * (src/duck/plan.ts `ordersText`; the owner's decision on PR 1201, after the synced data answered such statements'
 * other values wrongly).
 *
 * Postgres 19 writes every other built-in held type's text as 18 does: a value of each was compared, 18 against 19.
 */
export interface SourceForms {
  /** the types (and their arrays) whose text the source writes otherwise than the catalog Postgres */
  readonly differs: ReadonlySet<number>;
  /** a value of type `oid` (or its array) as the source writes it, from the catalog Postgres's text of it */
  written(oid: number, text: string): string;
  /** whether a constant of type `oid`, by its datum's bytes as the catalog holds it, has a text the source writes
   *  otherwise than the catalog (true where the bytes cannot be read) */
  constDiffers(oid: number, bytes: readonly number[] | null): boolean;
}

/** a source that writes every type as the catalog Postgres does */
export const CATALOG_FORMS: SourceForms = { differs: new Set(), written: (_oid, text) => text, constDiffers: () => false };

const PG_LSN = 3220, PG_LSN_ARRAY = 3221;
/** the types whose text a source may write otherwise than the catalog Postgres, by name (src/api/postgres/translate.ts
 *  `namesFormType` reads a statement of no table for them) */
export const FORM_TYPES: ReadonlySet<string> = new Set(["pg_lsn"]);
/** whether a Postgres of this `server_version_num` writes a pg_lsn's low half as 8 hex digits (Postgres 19's `%X/%08X`) */
const lsnPadded = (version: number): boolean => version >= 190000;
/** the catalog Postgres is 18, which writes `%X/%X` (`tests/duck-held-types.test.ts` holds it to the catalog) */
export const CATALOG_LSN_PADDED = false;
/** each pg_lsn in a value's text (a pg_lsn's, or its array's, whose elements are never quoted), in the `padded` form */
const lsnWritten = (text: string, padded: boolean): string =>
  text.replace(/\b([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})\b/g, (_, hi: string, lo: string) => `${hi}/${padded ? lo.padStart(8, "0") : lo.replace(/^0+(?=.)/, "")}`);

/** the source's forms, by its `server_version_num` (null where none is known, as in a unit test: the catalog's own) */
export function sourceForms(version: number | null): SourceForms {
  if (version === null || lsnPadded(version) === CATALOG_LSN_PADDED) return CATALOG_FORMS;
  const padded = lsnPadded(version);
  return { differs: new Set([PG_LSN, PG_LSN_ARRAY]), written: (oid, text) => oid === PG_LSN || oid === PG_LSN_ARRAY ? lsnWritten(text, padded) : text,
    constDiffers: (oid, bytes) => oid === PG_LSN ? lsnLowsOf(bytes, false)?.some(short) ?? true : oid === PG_LSN_ARRAY ? lsnLowsOf(bytes, true)?.some(short) ?? true : false };
}

/** a pg_lsn's text is the same in both forms where its low half has 8 hex digits */
const short = (low: number): boolean => low < 0x10000000;
const int32 = (b: readonly number[], at: number): number => ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>> 0;
/**
 * The low halves of a pg_lsn datum, or of a pg_lsn[]'s elements, as the catalog (little-endian) holds them: a pg_lsn
 * is 8 bytes by value; an array is array.h's varlena (its header, ndim, dataoffset, elemtype, the dims and lower
 * bounds, the null bitmap where dataoffset is set, then each element aligned to 8 bytes). Null where it cannot be read.
 */
function lsnLowsOf(b: readonly number[] | null, array: boolean): number[] | null {
  if (b === null) return null;
  if (!array) return b.length === 8 ? [int32(b, 0)] : null;
  if (b.length < 16 || (b[0]! & 3) !== 0 || int32(b, 12) !== PG_LSN) return null;
  const ndim = int32(b, 4), offset = int32(b, 8);
  if (ndim === 0) return [];
  if (ndim > 6 || b.length < 16 + 8 * ndim) return null;
  let count = 1;
  for (let d = 0; d < ndim; d++) count *= int32(b, 16 + 4 * d);
  const bitmap = 16 + 8 * ndim;
  let at = offset !== 0 ? offset : (bitmap + 7) & ~7;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (offset !== 0 && (((b[bitmap + (i >> 3)] ?? 0) >> (i & 7)) & 1) === 0) continue;
    if (at + 8 > b.length) return null;
    out.push(int32(b, at));
    at += 8;
  }
  return out;
}

/** a time written in the session's zone, which the copy's text cannot be: written again where the statement executes */
export const ZONED_HELD: ReadonlyMap<number, string> = new Map([[3910, "tstzrange"], [4534, "tstzmultirange"]]);

/** what `format_type` writes, its typmod and `[]` left off (`time(3) with time zone`, `bit(8)`, `numeric(12,2)[]`) */
const baseOf = (spelled: string): string => spelled.replace(/\[\]$/, "").replace(/\(\d+(,\d+)?\)/, "").replace(/\s+/g, " ").trim().replace(/^interval .*/, "interval");

/** whether DuckDB holds a value of this type as itself */
export const isNative = (spelled: string): boolean => NATIVE.has(baseOf(spelled));

/** the native types the copy stores as a VARCHAR (the extension reads them as text, or the copy holds their text) */
const NATIVE_VARCHAR = new Set(["text", "character varying", "character", "name", '"char"', "inet", "citext"]);
/** whether a native column of this type is stored as a VARCHAR: never an array, which is a list */
export const nativeVarchar = (spelled: string): boolean => !spelled.endsWith("[]") && NATIVE_VARCHAR.has(baseOf(spelled));

/** How the copy holds a column of the source's type `spelled` (`typeKind`: pg_type.typtype of the type or its element).
 *  An enum is DuckDB's ENUM; any other type a database made is its text. */
export function holdOf(spelled: string, typeKind?: string): "same" | "text" | "text[]" {
  const array = spelled.endsWith("[]");
  if (typeKind === "e" || (isNative(spelled) && !(array && baseOf(spelled) === "oid"))) return "same";
  return array ? "text[]" : "text";
}
