/**
 * POSTGRES DECIDES, DUCKDB COMPUTES (docs/DESIGN.md). Before DuckDB answers a statement, the catalog Postgres
 * (src/api/postgres/catalog.ts: Postgres 18 itself, holding every copied table under its source types, no rows) parses
 * and analyses it, and that analysis is the answer's contract:
 *  - a statement Postgres REFUSES at analysis (an unknown column, a GROUP BY it would not take, `'99.99'` compared with
 *    an integer, ORDER BY outside a DISTINCT's list) is refused with Postgres's own error, word for word;
 *  - the result's column NAMES, type OIDs and typmods are Postgres's RowDescription, and the parameters' types its
 *    ParameterDescription;
 *  - the analysed tree (`debug_print_parse`, src/duck/pgtree.ts) gives the rewrite every expression's resolved type.
 * The statement is analysed under the SESSION's state (src/api/postgres/catalog.ts sessionSetSql, the catalog's one
 * applier): its search_path as written (an unqualified table is the one the session would read), its TimeZone and its
 * DateStyle (a literal is folded under both: `'01/02/2026'::date` is the session's order).
 *
 * ONE BATCH, SERIALISED (the catalog's queue): the logging is switched on, the statement is parsed, described and
 * closed under a name of its own, and everything is set back, before the next session's call runs. Nothing of it is
 * left in the sidecar between calls — another session's Sync can lose nothing (tests/postgres-api/server.test.ts "a
 * catalog statement's portal, beside another session's").
 */
import { HELD } from "./held-types.ts";
import { CATALOG_BASE_SQL, sessionSetSql, type SessionState } from "../api/postgres/catalog.ts";
import { cstr, decodeBackend, frame, int16, int32, splitFrames } from "../api/postgres/protocol.ts";
import { gapRefusal } from "./statement.ts";
import { outputsByLocation, readParseLog, typesByLocation, UnreadableNames, type QueryOutputs, type Typed, type TreeValue } from "./pgtree.ts";

export interface PgField { name: string; oid: number; typmod: number }
export interface PgAnalysis {
  /** the parameters' types, as Postgres inferred them (or as declared) */
  params: number[];
  /** the result's columns, or null for a statement that returns none */
  fields: PgField[] | null;
  /** every typed expression by its offset into the text */
  types: Map<number, Typed[]>;
  /** each SELECT's output columns, by any offset its targets hold */
  outputs: Map<number, QueryOutputs>;
  tree: TreeValue;
}
/** Postgres's ErrorResponse fields (M message, C code, P position, H hint, D detail …) */
export type PgRefusal = { refused: Record<string, string> };

const NAME = "__mason_analysis";
/** what a statement of no session is analysed under (a row filter's read, a unit test): UTC, under `public`, ISO with month-day-year */
const NO_SESSION: SessionState = { timeZone: "UTC", searchPath: "public", dateStyle: "ISO, MDY" };
const query = (sql: string): Buffer => frame("Q", cstr(sql));

/** Asks the catalog Postgres to analyse `sql` (with these declared parameter OIDs, 0 = infer). `written`: every name the
 *  statement writes (`writtenNames` of its raw tree), which tells a name holding a line break apart in the log (pgtree.ts
 *  `readParseLog`); without it, such a name the log cannot tell apart is refused by name. */
export async function analyze(run: (bytes: Uint8Array) => Promise<Uint8Array>, sql: string, paramOids: readonly number[], under: SessionState = NO_SESSION,
  written: ReadonlySet<string> = new Set()): Promise<PgAnalysis | PgRefusal> {
  const bytes = Buffer.concat([
    // the session's state: Postgres parses a literal under its zone and order ('2026-01-01 12:00'::timestamptz is that
    // zone's noon), and the rewrite writes the value it parsed (src/duck/rewrite.ts `aConst`)
    query(`${sessionSetSql(under)}; SET client_min_messages = log; SET debug_print_parse = on; SET debug_pretty_print = off`),
    frame("P", cstr(NAME), cstr(sql), int16(paramOids.length), ...paramOids.map(int32)),
    frame("D", Buffer.from("S"), cstr(NAME)),
    frame("C", Buffer.from("S"), cstr(NAME)),
    frame("S"),
    // the catalog's own state back (catalog.ts CATALOG_BASE): RESET would be the server's boot default, the machine's
    // zone, under which the catalog then answered what reads no table
    query(`RESET debug_print_parse; RESET debug_pretty_print; RESET client_min_messages; ${CATALOG_BASE_SQL}`),
  ]);
  const reply = Buffer.from(await run(bytes));
  const messages = decodeBackend(reply);
  // the replies to the first Query end at its ReadyForQuery; the statement's run to the next one
  const z = messages.findIndex((m) => m.type === "ReadyForQuery");
  const end = messages.findIndex((m, i) => i > z && m.type === "ReadyForQuery");
  if (z < 0 || end < 0) throw new Error(`the catalog Postgres's analysis came back out of step (${messages.map((m) => m.type).join(", ")}): report it`);
  const mine = messages.slice(z + 1, end);
  const refused = mine.find((m) => m.type === "ErrorResponse");
  if (refused?.type === "ErrorResponse") return { refused: refused.fields };
  const firstError = messages.find((m) => m.type === "ErrorResponse");
  if (firstError?.type === "ErrorResponse") throw new Error(`the catalog Postgres could not switch its analysis log on or off: ${firstError.fields.M}`);
  const at = mine.findIndex((m) => m.type === "NoticeResponse" && /^\{QUERY\b/.test(m.fields.D ?? ""));
  if (at < 0) throw new Error("the catalog Postgres logged no parse tree for the statement: report it");
  // the log's own BYTES, never its text decoded: Postgres wraps it by bytes, and may break a line inside a character
  const frames = splitFrames(reply);
  if (frames.length !== messages.length) throw new Error(`the catalog Postgres's reply split into ${frames.length} frames and ${messages.length} messages: report it`);
  const detail = noticeField(frames[z + 1 + at]!.frame, "D");
  let tree: TreeValue;
  try { tree = readParseLog(detail, written); }
  catch (e) {
    if (!(e instanceof UnreadableNames)) throw e;
    // a name with a line break the statement does not write is a column's (every relation lists all its columns'
    // names): the columns so named of the relations the statement reads tell it too
    const relations = e.relations.filter((r) => Number.isSafeInteger(r) && r > 0);
    const columns = relations.length === 0 ? [] : await catalogRows(run, "SELECT attname::text FROM pg_catalog.pg_attribute WHERE attnum > 0 AND NOT attisdropped " +
      `AND strpos(attname::text, chr(10)) > 0 AND attrelid IN (${relations.join(", ")})`);
    try { tree = readParseLog(detail, new Set([...written, ...columns.flatMap(([n]) => typeof n === "string" ? [n] : [])])); }
    catch (again) {
      if (!(again instanceof UnreadableNames)) throw again;
      throw gapRefusal("name-unreadable", "Mason cannot read back a name in this statement from Postgres's analysis of it",
        "give the columns whose names hold line breaks, or many of ( ) { } \\ and tabs, aliases without them", sql);
    }
  }
  const pd = mine.find((m) => m.type === "ParameterDescription");
  const rd = mine.find((m) => m.type === "RowDescription");
  return {
    params: pd?.type === "ParameterDescription" ? pd.oids : [],
    fields: rd?.type === "RowDescription" ? rd.fields.map((f) => ({ name: f.name, oid: f.typeOid, typmod: f.typeModifier })) : null,
    types: typesByLocation(tree),
    outputs: outputsByLocation(tree),
    tree,
  };
}

/** Every string a raw parse tree (libpg-query's) holds: each name the statement writes, as Postgres read it (an
 *  identifier folded, a U&"…" escape undone), for `analyze` to tell a name with a line break by. */
export function writtenNames(raw: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") out.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(raw);
  return out;
}

/** One field of a NoticeResponse frame (its type byte included) as the bytes Postgres sent: a code byte, then a
 *  NUL-terminated value, closed by a zero byte. */
function noticeField(f: Buffer, code: string): Buffer {
  const want = code.charCodeAt(0);
  for (let off = 5; off < f.length && f[off] !== 0;) {
    const end = f.indexOf(0, off + 1);
    if (end < 0) break;
    if (f[off] === want) return f.subarray(off + 1, end);
    off = end + 1;
  }
  throw new Error(`the catalog Postgres's notice has no ${code} field: report it`);
}

/** the types whose input DuckDB reads otherwise than Postgres, as the catalog Postgres writes their value back */
const PARAM_TYPES: Record<number, string> = {
  16: "boolean", 21: "smallint", 23: "integer", 20: "bigint", 700: "real", 701: "double precision", 1700: "numeric",
  2950: "uuid", 114: "json", 3802: "jsonb", 1083: "time", 1082: "date", 1114: "timestamp", 1184: "timestamptz", 1186: "interval", 869: "inet", 1266: "timetz",
  1009: "text[]", 1015: "varchar[]",
  // a type the copy holds as its text: the text Postgres writes the value as
  ...Object.fromEntries(Object.entries(HELD).map(([name, h]) => [h.oid, name])),
};

/**
 * A statement's parameters as Postgres reads them: each value through its type's input function (the type Postgres
 * inferred, or the one declared), under the session's state (its TimeZone and DateStyle) — so `'1.5'` for a smallint
 * is Postgres's 22P02, and `'01/02/2026'` for a date is 2026-01-02 (2026-02-01 under `ISO, DMY`). A value comes back as text DuckDB reads to the same value: a number, a
 * boolean or a uuid canonical; a date as days and a timestamp as microseconds since 2000-01-01 (src/duck/rewrite.ts
 * `datumText` writes them), an interval as its months, days and microseconds; `infinity` as itself.
 */
export async function readParameters(run: (bytes: Uint8Array) => Promise<Uint8Array>, oids: readonly number[], values: readonly (string | null)[],
  under: SessionState): Promise<{ values: Array<{ oid: number; text: string } | null> } | PgRefusal | TextArrayRefusal> {
  const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const items = values.map((v, i) => {
    const oid = oids[i] ?? 0, type = PARAM_TYPES[oid];
    if (v === null || type === undefined) return null;
    const x = `${quote(v)}::${type}`;
    if (oid === 1082) return `CASE WHEN isfinite(${x}) THEN (${x} - date '2000-01-01')::text ELSE ${x}::text END`;
    if (oid === 1114 || oid === 1184) return `CASE WHEN isfinite(${x}) THEN (extract(epoch FROM ${x}) * 1000000 - 946684800000000)::int8::text ELSE ${x}::text END`;
    // a text array as JSON, which holds what array_in read (a NULL element, any character) as DuckDB reads it back; a
    // JSON array always starts with `[`, so a word in its place says why the value cannot be read as one list
    // (TEXT_ARRAY_REFUSALS): several dimensions, or subscripts that do not start at 1, which a list of DuckDB's has not
    if (oid === 1009 || oid === 1015) return `CASE WHEN array_ndims(${x}) > 1 THEN 'multidim-array' WHEN array_lower(${x}, 1) <> 1 THEN 'array-lower-bound' ELSE to_json(${x})::text END`;
    if (oid === 1186) return `(extract(year FROM ${x}) * 12 + extract(month FROM ${x}))::text || ' ' || extract(day FROM ${x})::text || ' ' || ((extract(hour FROM ${x}) * 60 + extract(minute FROM ${x})) * 60000000 + extract(microseconds FROM ${x}))::int8::text`;
    return `${x}::text`;
  });
  if (items.every((x) => x === null)) return { values: values.map(() => null) };
  const sql = `${sessionSetSql(under)}; SELECT ${items.map((x) => x ?? "NULL").join(", ")}; ${CATALOG_BASE_SQL}`;
  const messages = decodeBackend(Buffer.from(await run(query(sql))));
  const refused = messages.find((m) => m.type === "ErrorResponse");
  if (refused?.type === "ErrorResponse") {
    // the value's own error (22P02, 22003, 22008 …) — and the catalog's state set back, which the failed statement skipped
    await run(query(CATALOG_BASE_SQL));
    return { refused: refused.fields };
  }
  const row = messages.find((m) => m.type === "DataRow");
  if (row?.type !== "DataRow") throw new Error("the catalog Postgres read the parameters and answered no row: report it");
  const read = items.map((x, i) => x === null ? null : { oid: oids[i]!, text: row.values[i]!.toString("utf8") });
  const unlisted = read.findIndex((r) => r !== null && (r.oid === 1009 || r.oid === 1015) && !r.text.startsWith("["));
  if (unlisted >= 0) return { gap: read[unlisted]!.text as TextArrayRefusal["gap"], parameter: unlisted + 1 };
  return { values: read };
}

/** a text[] parameter Postgres read, which no list of DuckDB's holds: its gap, and the parameter's number ($1 is 1) */
export type TextArrayRefusal = { gap: "multidim-array" | "array-lower-bound"; parameter: number };

/** One read of the catalog Postgres's own catalog (a signature from pg_proc, a type's name): its rows as text. */
export async function catalogRows(run: (bytes: Uint8Array) => Promise<Uint8Array>, sql: string): Promise<(string | null)[][]> {
  const messages = decodeBackend(Buffer.from(await run(query(sql))));
  const refused = messages.find((m) => m.type === "ErrorResponse");
  if (refused?.type === "ErrorResponse") throw new Error(`the catalog Postgres refused its own catalog read: ${refused.fields.M} (in: ${sql.slice(0, 200)})`);
  return messages.flatMap((m) => m.type === "DataRow" ? [m.values.map((v) => v === null ? null : v.toString("utf8"))] : []);
}
