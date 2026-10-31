/**
 * POSTGRES DECIDES, DUCKDB COMPUTES (docs/DESIGN.md). Before DuckDB answers a statement, the catalog Postgres
 * (src/api/postgres/catalog.ts: Postgres 18 itself, holding every copied table under its source types, no rows) parses
 * and analyses it, and that analysis is the answer's contract:
 *  - a statement Postgres REFUSES at analysis (an unknown column, a GROUP BY it would not take, `'99.99'` compared with
 *    an integer, ORDER BY outside a DISTINCT's list) is refused with Postgres's own error, word for word;
 *  - the result's column NAMES, type OIDs and typmods are Postgres's RowDescription, and the parameters' types its
 *    ParameterDescription;
 *  - the analysed tree (`debug_print_parse`, src/duck/pgtree.ts) gives the rewrite every expression's resolved type.
 * The statement is analysed under the SESSION's search_path (an unqualified table is the one the session would read).
 *
 * ONE BATCH, SERIALISED (the catalog's queue): the logging is switched on, the statement is parsed, described and
 * closed under a name of its own, and everything is set back, before the next session's call runs. Nothing of it is
 * left in the sidecar between calls — another session's Sync can lose nothing (tests/postgres-api/server.test.ts "a
 * catalog statement's portal, beside another session's").
 */
import { cstr, decodeBackend, frame, int16, int32 } from "../api/postgres/protocol.ts";
import { outputsByLocation, parseTree, typesByLocation, type QueryOutputs, type Typed, type TreeValue } from "./pgtree.ts";

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
/** the catalog's TimeZone, set back after a statement set the session's (src/api/postgres/catalog.ts sets it at start) */
const CATALOG_ZONE = "SET TimeZone = 'UTC'";
const query = (sql: string): Buffer => frame("Q", cstr(sql));

/** Asks the catalog Postgres to analyse `sql` (with these declared parameter OIDs, 0 = infer). */
export async function analyze(run: (bytes: Uint8Array) => Promise<Uint8Array>, sql: string, paramOids: readonly number[], searchPath = "public", timeZone = "UTC"): Promise<PgAnalysis | PgRefusal> {
  const bytes = Buffer.concat([
    // the session's search_path, pg_catalog after it as the catalog's own setup has it (catalog.ts)
    // …and its TimeZone: Postgres parses a literal under it ('2026-01-01 12:00'::timestamptz is that zone's noon), and
    // the rewrite writes the value it parsed (src/duck/rewrite.ts `aConst`)
    query(`SET search_path = ${searchPath}, pg_catalog; SET TimeZone = '${timeZone.replace(/'/g, "''")}'; SET client_min_messages = log; SET debug_print_parse = on; SET debug_pretty_print = off`),
    frame("P", cstr(NAME), cstr(sql), int16(paramOids.length), ...paramOids.map(int32)),
    frame("D", Buffer.from("S"), cstr(NAME)),
    frame("C", Buffer.from("S"), cstr(NAME)),
    frame("S"),
    // the catalog's own TimeZone back (catalog.ts sets UTC at its start): RESET would be the server's boot default, the
    // machine's zone, under which the catalog then answered what reads no table
    query(`RESET debug_print_parse; RESET debug_pretty_print; RESET client_min_messages; ${CATALOG_ZONE}; SET search_path = public, pg_catalog`),
  ]);
  const messages = decodeBackend(Buffer.from(await run(bytes)));
  // the replies to the first Query end at its ReadyForQuery; the statement's run to the next one
  const z = messages.findIndex((m) => m.type === "ReadyForQuery");
  const end = messages.findIndex((m, i) => i > z && m.type === "ReadyForQuery");
  if (z < 0 || end < 0) throw new Error(`the catalog Postgres's analysis came back out of step (${messages.map((m) => m.type).join(", ")}): report it`);
  const mine = messages.slice(z + 1, end);
  const refused = mine.find((m) => m.type === "ErrorResponse");
  if (refused?.type === "ErrorResponse") return { refused: refused.fields };
  const firstError = messages.find((m) => m.type === "ErrorResponse");
  if (firstError?.type === "ErrorResponse") throw new Error(`the catalog Postgres could not switch its analysis log on or off: ${firstError.fields.M}`);
  const log = mine.find((m) => m.type === "NoticeResponse" && /^\{QUERY\b/.test(m.fields.D ?? ""));
  if (log?.type !== "NoticeResponse") throw new Error("the catalog Postgres logged no parse tree for the statement: report it");
  const tree = parseTree(log.fields.D!);
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

/** the types whose input DuckDB reads otherwise than Postgres, as the catalog Postgres writes their value back */
const PARAM_TYPES: Record<number, string> = {
  16: "boolean", 21: "smallint", 23: "integer", 20: "bigint", 700: "real", 701: "double precision", 1700: "numeric",
  2950: "uuid", 114: "json", 3802: "jsonb", 1083: "time", 1082: "date", 1114: "timestamp", 1184: "timestamptz", 1186: "interval", 869: "inet",
};

/**
 * A statement's parameters as Postgres reads them: each value through its type's input function (the type Postgres
 * inferred, or the one declared), under the session's TimeZone — so `'1.5'` for a smallint is Postgres's 22P02, and
 * `'01/02/2026'` for a date is 2026-01-02. A value comes back as text DuckDB reads to the same value: a number, a
 * boolean or a uuid canonical; a date as days and a timestamp as microseconds since 2000-01-01 (src/duck/rewrite.ts
 * `datumText` writes them), an interval as its months, days and microseconds; `infinity` as itself.
 */
export async function readParameters(run: (bytes: Uint8Array) => Promise<Uint8Array>, oids: readonly number[], values: readonly (string | null)[],
  timeZone: string): Promise<{ values: Array<{ oid: number; text: string } | null> } | PgRefusal> {
  const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const items = values.map((v, i) => {
    const oid = oids[i] ?? 0, type = PARAM_TYPES[oid];
    if (v === null || type === undefined) return null;
    const x = `${quote(v)}::${type}`;
    if (oid === 1082) return `CASE WHEN isfinite(${x}) THEN (${x} - date '2000-01-01')::text ELSE ${x}::text END`;
    if (oid === 1114 || oid === 1184) return `CASE WHEN isfinite(${x}) THEN (extract(epoch FROM ${x}) * 1000000 - 946684800000000)::int8::text ELSE ${x}::text END`;
    if (oid === 1186) return `(extract(year FROM ${x}) * 12 + extract(month FROM ${x}))::text || ' ' || extract(day FROM ${x})::text || ' ' || ((extract(hour FROM ${x}) * 60 + extract(minute FROM ${x})) * 60000000 + extract(microseconds FROM ${x}))::int8::text`;
    return `${x}::text`;
  });
  if (items.every((x) => x === null)) return { values: values.map(() => null) };
  const sql = `SET TimeZone = ${quote(timeZone)}; SELECT ${items.map((x) => x ?? "NULL").join(", ")}; ${CATALOG_ZONE}`;
  const messages = decodeBackend(Buffer.from(await run(query(sql))));
  const refused = messages.find((m) => m.type === "ErrorResponse");
  if (refused?.type === "ErrorResponse") {
    // the value's own error (22P02, 22003, 22008 …) — and the zone set back, which the failed statement skipped
    await run(query(CATALOG_ZONE));
    return { refused: refused.fields };
  }
  const row = messages.find((m) => m.type === "DataRow");
  if (row?.type !== "DataRow") throw new Error("the catalog Postgres read the parameters and answered no row: report it");
  return { values: items.map((x, i) => x === null ? null : { oid: oids[i]!, text: row.values[i]!.toString("utf8") }) };
}

/** One read of the catalog Postgres's own catalog (a signature from pg_proc, a type's name): its rows as text. */
export async function catalogRows(run: (bytes: Uint8Array) => Promise<Uint8Array>, sql: string): Promise<(string | null)[][]> {
  const messages = decodeBackend(Buffer.from(await run(query(sql))));
  const refused = messages.find((m) => m.type === "ErrorResponse");
  if (refused?.type === "ErrorResponse") throw new Error(`the catalog Postgres refused its own catalog read: ${refused.fields.M} (in: ${sql.slice(0, 200)})`);
  return messages.flatMap((m) => m.type === "DataRow" ? [m.values.map((v) => v === null ? null : v.toString("utf8"))] : []);
}
