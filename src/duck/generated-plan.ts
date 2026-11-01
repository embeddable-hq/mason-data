/**
 * WHAT A GENERATED TABLE'S SQL IS, ASKED OF THE CATALOG POSTGRES (issue 124; src/duck/generated.ts keeps the table): the
 * file's `sql:` planned as any statement is — analysed by Postgres, rewritten, held to the verified list, read back — and
 * then held to what a table with no session can store. Everything here refuses, by file, key, reason and way out; none
 * of it moves a table from one `kind:` to another.
 *
 * A TABLE HAS NO SESSION. So the plan is made in UTC under `public` (src/duck/generated.ts sets the connection it runs on
 * to the same), and anything whose answer a session's settings decide is refused rather than given a default: a default
 * zone would give wrong days with no error. Postgres already says which those are (`sessionReads`): a function, an
 * operator or a text cast it marks IMMUTABLE reads no session, by its own rule for what an index may hold. The two
 * exceptions are named: `age(timestamptz, timestamptz)` is marked immutable and reads the zone, `to_char(timestamp, …)`
 * is marked stable and reads none of it, the zone being in the SQL by then. `now()` and its kin are instants, the run's.
 *
 * WHAT IS STORED IS WHAT A COPY OF THAT TYPE HOLDS (`STORED_TYPES`): the column's own Postgres type, so a statement over
 * the table is answered by the very path that answers one over a copy. A `numeric`, an enum and a citext are stored as
 * the engine answers them (`duck: null`), which is what a copy of that column holds: a numeric's DECIMAL, whose display
 * scale the catalog's typmod pads on read; an enum's ENUM, in its declared order; a citext's text (stage 3, issue 175). A
 * numeric whose digits a statement computes at the result's edge (`DuckPlan.exact`) is stored where Postgres's types fix
 * its scale, written as the engine's DECIMAL arithmetic (`storedNumeric`); one they don't is refused with its own reason
 * (`notStoredRefusal`). Any other type is refused by name.
 */
import { deparseSync } from "pgsql-deparser";
import type { Node } from "libpg-query";
import { parseSql, PostgresSyntaxError } from "../api/postgres/parser.ts";
import { describeKeys } from "./resolved.ts";
import { treeDifference } from "./rewrite.ts";
import { StatementError, type DuckPlan } from "./statement.ts";
import type { NumericProgram } from "../lib/pg-numeric.ts";
import type { CellConv } from "./types.ts";

/** A refusal of a generated table: its key in the file (null: the file itself), what is wrong, why, and the ways out. */
export interface GeneratedRefusal { key: string | null; message: string; why: string | null; options: string[] }

/** the Postgres type of an output column, by OID, as a copy stores it (src/duck/types.ts writes each back as Postgres's) */
const STORED_TYPES: ReadonlyMap<number, string> = new Map([
  [16, "BOOLEAN"], [17, "BLOB"], [20, "BIGINT"], [21, "SMALLINT"], [23, "INTEGER"], [25, "VARCHAR"], [114, "JSON"], [700, "FLOAT"], [701, "DOUBLE"], [1043, "VARCHAR"],
  [1082, "DATE"], [1083, "TIME"], [1114, "TIMESTAMP"], [1184, "TIMESTAMPTZ"], [1186, "INTERVAL"], [2950, "UUID"], [3802, "JSON"],
]);
const NUMERIC_OID = 1700;
/** the most decimals a stored DECIMAL(38, s) may keep: past it a sum could overflow its 38 digits and fail the write */
const MAX_STORED_SCALE = 18;
/** the Postgres name `?column?` is an expression no one named, and a table's column needs one */
const UNNAMED = "?column?";
/** what the subquery of a definition with an `order_by:` is called: its output's columns are all it can read */
const SHELL_ALIAS = "__mason_generated";
const SHELL_KEYS = new Set(["targetList", "fromClause", "sortClause", "limitOption", "op"]);

/** An output column: its name, its type as the catalog spells it, as a copy stores it (null: as the engine answers it,
 *  a numeric's DECIMAL, an enum's ENUM, a citext's text), and what it is computed as where that is not its own output
 *  column (a numeric's exact digits, the engine's DECIMAL arithmetic over the plan's cells, `storedNumeric`). */
export interface GeneratedColumn { name: string; type: string; duck: string | null; expr?: string }
/** A definition that can be stored: what `src/duck/generated.ts` runs. */
export interface DefinitionPlan {
  plan: DuckPlan;
  columns: GeneratedColumn[];
  /** the tables it reads, views read through (`schema.table`) */
  bases: string[];
  /** what its file does that changes nothing: said, never refused */
  warnings: string[];
  /** each numeric column computed after the engine's answer (`DuckPlan.exact`): its `expr` is written over the engine
   *  types the plan's SQL has (`storedColumns`), at the check where a `describe` is given and at the write */
  numerics: Array<{ column: number; program: NumericProgram; cells: readonly CellConv[] }>;
  /** each output column's outermost function, as written (`stddev`), else null: the FORM a refusal's reason and way out
   *  are said from where nothing else carries it (a numeric the engine answers itself, `storedColumns`) */
  forms: Array<string | null>;
}

/** What a plan is asked of: the listener's catalog (src/api/postgres/server.ts `planner`). */
export interface Planner {
  /** a statement planned as a session with no role, in UTC under `public`, would be: a StatementError where it is refused */
  plan(text: string, stmt: Node, relations?: ReadonlyMap<string, string>): Promise<DuckPlan>;
  /** rows of a read of the catalog */
  rows(sql: string): Promise<(string | null)[][]>;
}

const asRecord = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;
const WAY_OUT_DOCS = "write it as a SELECT: one statement, reading the tables the sources file syncs";

/** the file's `sql:` parsed: one SELECT, or the refusal */
async function selectOf(sql: string): Promise<{ stmt: Node } | { refused: GeneratedRefusal }> {
  let stmts;
  try { stmts = (await parseSql(sql)).stmts ?? []; }
  catch (e) {
    if (!(e instanceof PostgresSyntaxError)) throw e;
    return { refused: { key: "sql", message: `it is not SQL Postgres reads: ${e.message}`, why: null, options: [WAY_OUT_DOCS] } };
  }
  const only = stmts[0]?.stmt;
  if (stmts.length !== 1 || only === undefined) return { refused: { key: "sql", message: `it holds ${stmts.length} statements`, why: "A generated table is what one SELECT gives.", options: [WAY_OUT_DOCS] } };
  const body = asRecord(only).SelectStmt as Record<string, unknown> | undefined;
  if (body === undefined) return { refused: { key: "sql", message: "it is not a SELECT", why: "Mason reads and stores: a generated table is what a SELECT gives.", options: [WAY_OUT_DOCS] } };
  if (body.intoClause !== undefined || body.lockingClause !== undefined) return { refused: { key: "sql", message: "it is a SELECT with an INTO or a locking clause", why: "Neither means anything in a table Mason keeps.", options: ["remove the clause"] } };
  return { stmt: only };
}

/** a top-level ORDER BY with no LIMIT: it can't change which rows the table holds, so nothing is refused for it */
const UNUSED_ORDER = "sql: its ORDER BY doesn't change what the table holds. Set order_by: for how its rows are laid out, and sort in the statements that read it.";

/**
 * THE STATEMENT A DEFINITION RUNS: its `sql:`, and with an `order_by:` that SELECT read by a shell sorted by it, so Postgres
 * resolves the order over the output's columns and the rewrite sorts as a statement sorts. The shell is held to its own
 * shape and the `sql:` put in as a tree, never pasted into text: `order_by:` is one clause, so `x LIMIT 1` or `x; DROP`
 * is refused.
 */
export async function definitionStatement(sql: string, orderBy: string | null): Promise<{ text: string; stmt: Node; warnings: string[] } | { refused: GeneratedRefusal }> {
  const select = await selectOf(sql);
  if ("refused" in select) return select;
  const top = asRecord(select.stmt).SelectStmt as Record<string, unknown>;
  const warnings = top.sortClause !== undefined && top.limitCount === undefined && top.limitOffset === undefined ? [UNUSED_ORDER] : [];
  if (orderBy === null) return { text: sql, stmt: select.stmt, warnings };
  const bad = (why: string): { refused: GeneratedRefusal } => ({ refused: { key: "order_by", message: `is not what follows ORDER BY over the table's columns: ${why}`, why: null, options: ["write one SQL string, like order_by: day, tenant_id"] } });
  let stmts;
  try { stmts = (await parseSql(`SELECT * FROM (SELECT 1) AS ${SHELL_ALIAS} ORDER BY ${orderBy}`)).stmts ?? []; }
  catch (e) {
    if (!(e instanceof PostgresSyntaxError)) throw e;
    return bad(e.message);
  }
  const shell = stmts[0]?.stmt, body = asRecord(shell ?? {}).SelectStmt as Record<string, unknown> | undefined;
  if (stmts.length !== 1 || shell === undefined || body === undefined) return bad("it ends the statement");
  const stray = Object.keys(body).filter((k) => !SHELL_KEYS.has(k));
  const from = (body.fromClause as unknown[] | undefined) ?? [];
  if (stray.length > 0 || from.length !== 1 || (body.op !== undefined && body.op !== "SETOP_NONE") || (body.limitOption !== undefined && body.limitOption !== "LIMIT_OPTION_DEFAULT")) return bad("it says more than an order");
  (asRecord(from[0]).RangeSubselect as Record<string, unknown>).subquery = select.stmt;
  const text = deparseSync(shell, { pretty: false });
  const back = (await parseSql(text)).stmts?.[0]?.stmt;
  const difference = back === undefined ? "nothing" : treeDifference(back, shell);
  if (back === undefined || difference !== null) throw new Error(`a generated table's statement does not read back as itself (Mason bug: report it): ${difference}`);
  return { text, stmt: back, warnings };
}

const THE_SESSION_WHY = "A generated table has no session, so nothing may depend on one's time zone or settings: a default would give wrong days with no error.";
const THE_SESSION_WAYS = [
  "name the zone in the SQL: t AT TIME ZONE 'UTC', or date_trunc('day', t, 'UTC')",
  "for today, (now() AT TIME ZONE 'UTC')::date",
];

/** the SQLVALUEFUNCTION kinds that are instants, the run's (`field:SQLVALUEFUNCTION.op=`): CURRENT_TIMESTAMP and (n) */
const INSTANTS = new Set(["3", "4"]);
/** Marked stable or volatile, and reading no session here: the clock, as of the run (`DuckPlan.clock`), and a timestamp's
 *  text, whose zone the SQL has already said */
const NOT_THE_SESSION = ["now()", "transaction_timestamp()", "statement_timestamp()", "clock_timestamp()", "random()", "to_char(timestamp without time zone, text)"];
/** Marked immutable, and reading the session's zone (timestamptz_age splits both instants in it) */
const READS_ZONE_ANYWAY = ["age(timestamp with time zone, timestamp with time zone)"];

/**
 * What the plan's keys read of a session, as a person reads each (none: nothing). The keys are what Postgres resolved the
 * statement to (src/duck/resolved.ts): a function by its OID, an operator by its, a cast through text by its two types'
 * output and input functions, read back from the catalog so nothing here is a list of names to keep current.
 */
export async function sessionReads(rows: Planner["rows"], keys: readonly string[]): Promise<string[]> {
  // the listener's own current_setting (src/api/postgres/catalog.ts), which reads a session's settings by construction
  const out = keys.filter((k) => /^function:ext:current_setting\(/.test(k));
  const values = (kind: string): string[] => keys.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1));
  for (const k of keys) {
    const m = /^field:SQLVALUEFUNCTION\.op=(\d+)$/.exec(k);
    if (m !== null && !INSTANTS.has(m[1]!)) out.push(k);
  }
  const procs = [...values("function"), ...values("aggregate"), ...values("window")].filter((v) => /^\d+$/.test(v));
  const allowed = NOT_THE_SESSION.map((s) => `'${s}'::regprocedure::oid`).join(", ");
  const denied = READS_ZONE_ANYWAY.map((s) => `'${s}'::regprocedure::oid`).join(", ");
  if (procs.length > 0) {
    // a stable function over "any" or a polymorphic type is stable for its arguments' text alone: `textReads` judges it
    const hit = await rows(`SELECT p.oid::text FROM pg_proc p WHERE p.oid IN (${procs.join(", ")}) AND (p.oid IN (${denied}) OR (p.provolatile <> 'i' AND p.oid NOT IN (${allowed}) ` +
      `AND NOT (p.provolatile = 's' AND ${FOR_ITS_ARGUMENTS})))`);
    const set = new Set(hit.map(([o]) => o));
    for (const k of keys) { const v = k.slice(k.indexOf(":") + 1); if (/^(function|aggregate|window):/.test(k) && set.has(v)) out.push(k); }
  }
  const ops = values("operator").filter((v) => /^\d+$/.test(v));
  if (ops.length > 0) {
    const hit = new Set((await rows(`SELECT o.oid::text FROM pg_operator o JOIN pg_proc p ON p.oid = o.oprcode WHERE o.oid IN (${ops.join(", ")}) AND (p.oid IN (${denied}) OR (p.provolatile <> 'i' AND p.oid NOT IN (${allowed})))`)).map(([o]) => o));
    for (const v of ops) if (hit.has(v)) out.push(`operator:${v}`);
  }
  // a cast through text calls its type's output function, and the next type's input function (`date::text` reads DateStyle)
  const casts = values("cast").map((v) => v.split(">")).filter((p) => p.length === 2 && p.every((x) => /^\d+$/.test(x)));
  if (keys.includes("node:COERCEVIAIO") && casts.length > 0) {
    const list = casts.map(([from, to]) => `(${from}, ${to})`).join(", ");
    const hit = await rows(`SELECT c.a::text, c.b::text FROM (VALUES ${list}) AS c(a, b) JOIN pg_type f ON f.oid = c.a JOIN pg_type t ON t.oid = c.b ` +
      `JOIN pg_proc o ON o.oid = f.typoutput::oid JOIN pg_proc i ON i.oid = t.typinput::oid WHERE o.provolatile <> 'i' OR i.provolatile <> 'i'`);
    for (const [a, b] of hit) out.push(`cast:${a}>${b}`);
  }
  if (out.length === 0) return [];
  const names = await describeKeys(rows, out);
  return [...new Set(out.map((k) => names.get(k) ?? k))];
}

/** a definition that reads a session, `session` what it reads as a person reads each */
const sessionRefusal = (session: readonly string[]): GeneratedRefusal =>
  ({ key: "sql", message: `it reads a session: ${session.slice(0, 5).join("; ")}`, why: THE_SESSION_WHY, options: THE_SESSION_WAYS });

/** a function (`p`) taking "any" or a polymorphic type: Postgres marks one stable when an argument's text may read a
 *  setting (`jsonb_build_object`, `concat`, `format`, `to_jsonb`, `jsonb_agg`) */
const FOR_ITS_ARGUMENTS = "EXISTS (SELECT 1 FROM unnest(p.proargtypes::oid[] || p.provariadic) AS a(t) JOIN pg_type y ON y.oid = a.t WHERE y.typtype = 'p')";

/**
 * What a stable function over "any" or a polymorphic type reads of a session through its arguments' text, as a person
 * reads each (none: nothing): a function given an argument whose type's text Postgres writes by a setting (a timestamptz,
 * an interval, a date, an array or row of one). Judged by each argument the statement gives it (`argTypes`, src/duck/resolved.ts
 * `argumentTypes`), from the type's own output function, as `sessionReads` judges a cast through text.
 */
export async function textReads(rows: Planner["rows"], keys: readonly string[], argTypes: readonly string[]): Promise<string[]> {
  const procs = keys.filter((k) => /^(function|aggregate|window):\d+$/.test(k)).map((k) => k.slice(k.indexOf(":") + 1));
  if (procs.length === 0) return [];
  const flagged = new Set((await rows(`SELECT p.oid::text FROM pg_proc p WHERE p.oid IN (${procs.join(", ")}) AND p.provolatile = 's' AND ${FOR_ITS_ARGUMENTS}`)).map(([o]) => o!));
  if (flagged.size === 0) return [];
  const pairs = argTypes.map((a) => a.split(":")).filter((x): x is [string, string] => x.length === 2 && flagged.has(x[0]!) && /^\d+$/.test(x[1]!));
  const out: string[] = [];
  // a function the statement gives no argument of a known type: nothing shows what it reads, so it is refused
  const unknown = [...flagged].filter((f) => !pairs.some(([g]) => g === f));
  if (unknown.length > 0) for (const [n] of await rows(`SELECT oid::regprocedure::text FROM pg_proc WHERE oid IN (${unknown.join(", ")})`)) out.push(n!);
  if (pairs.length > 0) {
    const hit = await rows(`SELECT DISTINCT format('%s over %s', (SELECT proname FROM pg_proc WHERE oid = a.f), format_type(a.t, NULL)) FROM (VALUES ${pairs.map(([f, t]) => `(${f}::oid, ${t}::oid)`).join(", ")}) AS a(f, t) ` +
      `JOIN pg_type y ON y.oid = a.t JOIN pg_proc o ON o.oid = y.typoutput LEFT JOIN pg_type el ON y.typelem <> 0 AND el.oid = y.typelem LEFT JOIN pg_proc eo ON eo.oid = el.typoutput ` +
      `WHERE CASE WHEN y.typcategory = 'A' THEN coalesce(eo.provolatile, 'v') <> 'i' ELSE o.provolatile <> 'i' END`);
    for (const [n] of hit) out.push(n!);
  }
  return out;
}

/** a definition whose function reads a session through an argument's text */
const textRefusal = (reads: readonly string[]): GeneratedRefusal => ({
  key: "sql", message: `it calls ${reads.slice(0, 3).join("; ")}, a type whose text Postgres writes by the session's settings`,
  why: "Postgres writes that value's text by the session's DateStyle, TimeZone or IntervalStyle, and a generated table has no session.",
  options: ["give it that value as text you write, with the zone named: to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')", "or call it in the statement that reads the table, over the column this one stores"],
});

/** the reason a table's column cannot be stored, with its ways out; null: it can */
function columnProblem(f: { name: string; oid: number }, typeName: string, kind: string | undefined): GeneratedRefusal | null {
  const it = `column ${f.name}`;
  if (f.name === UNNAMED) return { key: "sql", message: "an output column has no name", why: "A table's columns are named, and Postgres has no name for an expression.", options: ["give it one: count(*) + 1 AS total"] };
  if (f.name.startsWith("__mason")) return { key: "sql", message: `${it} has a name Mason keeps for itself`, why: null, options: ["rename it with AS"] };
  if (STORED_TYPES.has(f.oid) || asAnswered(f.oid, kind)) return null;
  if (kind === "d") return { key: "sql", message: `${it} is of type ${typeName}, a domain, which a generated table can't store yet`, why: null, options: [`cast it to the domain's own type, or to text: ${f.name}::text`] };
  return { key: "sql", message: `${it} is of type ${typeName}, which a generated table can't store yet`, why: null, options: [`cast it to a type it can store: ${f.name}::text`] };
}

/** a column stored as the engine answers it (`GeneratedColumn.duck` null): a numeric, an enum (`typtype` e), a citext */
const asAnswered = (oid: number, kind: string | undefined): boolean => oid === NUMERIC_OID || kind === "e" || kind === "citext";

/** why a numeric is not stored (`storedNumeric`, `storedColumns`): each its own refusal, with ways out that hold */
type NotStored = { why: "divides" | "per-value" | "computed" | "rows" | "picks" | "double" | "text" } | { why: "scale" | "held"; scale: number } | { why: "other"; what: string }
  | { why: "variance"; fn: string } | { why: "engine-double"; fn: string | null };

/** the variance family: Postgres computes each of a numeric exactly, at decimals it picks by the value's size */
const VARIANCES = new Set(["variance", "var_samp", "var_pop", "stddev", "stddev_samp", "stddev_pop"]);

/** the decimals Postgres's types give a value: a number, or what decides them per row, never unknown. "value": Postgres
 *  picks them by each value's size (a variance, sqrt, exp, ln, power); "rows": a sum's rows (`rescale`); "picks": the
 *  value a GREATEST, LEAST, COALESCE or CASE took; "text": a numeric read from text, at the decimals each value's text
 *  has (its `sql` is that text: only a typmod reads it). A round, a trunc, a typmod, floor or ceil fixes a number again. */
type Scale = number | "picks" | "rows" | "value" | "text";

/**
 * A numeric as the engine's DECIMAL arithmetic: `sql`, what DuckDB holds it at (`held`, the scale of its DECIMAL), the most
 * decimals any step on the way holds (`peak`), the decimals Postgres's types give it (`scale`), and what makes its digits
 * not Postgres's whatever its scale (`blocked`): "double", a cell the engine holds as a double (a float cast to numeric);
 * "variance", a variance or a standard deviation's program (`fn` its name); "computed", a value Postgres computes for
 * each row at its own decimals (a text cell of sqrt, exp, ln, log or power, which the catalog's Postgres computes when a
 * statement is answered). Each carries the FORM it came from, so a refusal says that form's reason and way out.
 */
type Stored = { sql: string; held: number; peak: number; scale: Scale; blocked: "double" | "variance" | "computed" | null; fn?: string };

/** the engine type of each column of a plan's SQL, as DuckDB says it computes it (a prepared statement's): by name, and
 *  by position as `#<i>` (an output column's own name may be any) */
export type EngineTypes = ReadonlyMap<string, string>;

const INTEGER_TYPES = new Set(["TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT"]);
const DECIMAL_TYPE = /^DECIMAL\((\d+),(\d+)\)$/;

/** the scale of values combined: what decides it per row, by precedence, else `numbers` of the numbers */
const scaleOf = (xs: readonly Stored[], numbers: (n: number[]) => number): Scale => {
  for (const k of ["text", "value", "rows", "picks"] as const) if (xs.some((x) => x.scale === k)) return k;
  return numbers(xs.map((x) => x.scale as number));
};
const blockedOf = (xs: readonly Stored[]): Stored["blocked"] => (["double", "variance", "computed"] as const).find((b) => xs.some((x) => x.blocked === b)) ?? null;
const made = (sql: string, held: number, scale: Scale, from: readonly Stored[]): Stored => {
  const fn = from.find((x) => x.fn !== undefined)?.fn;
  return { sql, held, scale, peak: Math.max(held, ...from.map((x) => x.peak)), blocked: blockedOf(from), ...(fn === undefined ? {} : { fn }) };
};

/**
 * A NUMERIC COMPUTED AT THE RESULT'S EDGE (`ExactColumn`), WRITTEN AS THE ENGINE'S DECIMAL ARITHMETIC over the plan's cells
 * (`__mason_output."__mason_cell_<key>"`, src/duck/rewrite.ts). Each cell's ENGINE type is what DuckDB says the plan's SQL
 * computes (`types`, never assumed): a DECIMAL is used at its own scale, an integer (a sum of int8 is a HUGEINT) is cast
 * to DECIMAL(38,0) first, since DuckDB's floor, ceil and round of an integer are a double's; a text cell (sqrt, exp, ln,
 * power, computed by the catalog's Postgres) is a value at its own decimals, and a double cell is a double: each judged
 * at the top (`verdict`), where what is around it is known. DuckDB's DECIMAL keeps the scale Postgres's numeric does for
 * `+ - *` (the larger; the sum), a negation, `abs` and `mod` (the larger), and an explicit one for `round(x, n)` and
 * `trunc(x, n)` (n < 0: none), a cast to numeric(p,s), `floor` and `ceil`, each rounded half away from zero as Postgres
 * rounds. A GREATEST, LEAST, COALESCE or CASE is the value it takes, each argument cast to the most decimals any holds so
 * none loses a digit. Not stored here: a division (the engine divides a numeric as a double; an average is one).
 */
function storedNumeric(p: NumericProgram, types: EngineTypes, cells: readonly CellConv[]): Stored | NotStored {
  // a numeric read from text is its text until a typmod gives it a scale: nothing else computes over it
  const all = (args: readonly NumericProgram[]): Stored[] | NotStored => {
    const out: Stored[] = [];
    for (const a of args) { const x = storedNumeric(a, types, cells); if ("why" in x) return x; if (x.scale === "text") return { why: "text" }; out.push(x); }
    return out;
  };
  const one = (arg: NumericProgram, make: (x: Stored) => Stored): Stored | NotStored => {
    const x = storedNumeric(arg, types, cells);
    return "why" in x ? x : x.scale === "text" ? { why: "text" } : make(x);
  };
  // a scale the types fix again: the value cast to it
  const fixed = (x: Stored, sql: string, scale: number, precision = 38): Stored => made(`CAST(${sql} AS DECIMAL(${precision},${scale}))`, scale, scale, [x]);
  // round or trunc to n decimals; n < 0 rounds left of the point, at no decimals
  const toPlace = (fn: string, arg: NumericProgram, n: number): Stored | NotStored => one(arg, (x) => fixed(x, `${fn}(${x.sql}, ${n})`, Math.max(0, n)));
  switch (p.op) {
    case "cell": {
      const name = `__mason_cell_${p.key}`, type = types.get(name);
      const sql = `__mason_output.${JSON.stringify(name)}`;
      const d = type === undefined ? null : DECIMAL_TYPE.exec(type);
      if (d !== null) return { sql, held: Number(d[2]), peak: Number(d[2]), scale: Number(d[2]), blocked: null };
      if (type !== undefined && INTEGER_TYPES.has(type)) return { sql: `CAST(${sql} AS DECIMAL(38,0))`, held: 0, peak: 0, scale: 0, blocked: null };
      // a text cell, by the form it came from: a numeric read from text (stored under a typmod, which rounds it as
      // numeric_in does, half away from zero), or a function the catalog's Postgres computes (never stored)
      if (type === "VARCHAR" && cells[Number(p.key)] === "parsed") return { sql, held: 0, peak: 0, scale: "text", blocked: null };
      if (type === "VARCHAR") return { sql: "NULL", held: 0, peak: 0, scale: "value", blocked: "computed" };
      if (type === "DOUBLE" || type === "FLOAT") return { sql, held: 0, peak: 0, scale: "value", blocked: "double" };
      return { why: "other", what: `a value the engine holds as ${type ?? "nothing it names"}` };
    }
    case "literal": {
      const m = /^-?(\d+)(?:\.(\d*))?$/.exec(p.text);
      if (m === null) return { why: "other", what: `the literal ${p.text}` };
      const scale = m[2]?.length ?? 0;
      return { sql: `CAST('${p.text}' AS DECIMAL(${Math.min(38, Math.max(1, m[1]!.length + scale))},${scale}))`, held: scale, peak: scale, scale, blocked: null };
    }
    case "add": case "sub": case "mul": case "mod": {
      const xs = all(p.args);
      if (!Array.isArray(xs)) return xs;
      const [a, b] = xs as [Stored, Stored];
      if (p.op === "mul") return made(`(${a.sql} * ${b.sql})`, a.held + b.held, scaleOf(xs, (n) => n[0]! + n[1]!), xs);
      // a mod by zero raises, as Postgres's does: the engine's would be NULL
      const sql = p.op === "mod" ? `(CASE WHEN ${b.sql} = 0 THEN error('division by zero') ELSE ${a.sql} % ${b.sql} END)` : `(${a.sql} ${p.op === "add" ? "+" : "-"} ${b.sql})`;
      return made(sql, Math.max(a.held, b.held), scaleOf(xs, (n) => Math.max(...n)), xs);
    }
    case "neg": return one(p.arg, (x) => ({ ...x, sql: `(-${x.sql})` }));
    case "abs": return one(p.arg, (x) => ({ ...x, sql: `abs(${x.sql})` }));
    case "floor": case "ceil": return one(p.arg, (x) => fixed(x, `${p.op}(${x.sql})`, 0));
    case "round": return toPlace("round", p.arg, p.scale);
    case "trunc": return toPlace("trunc", p.arg, p.scale);
    // numeric(p, s) past 38 digits holds what DECIMAL(38, s) does, for a value the engine computed
    case "typmod": {
      const x = storedNumeric(p.arg, types, cells);
      return "why" in x ? x : fixed(x, x.sql, p.scale, Math.min(38, p.precision));
    }
    // past MAX_STORED_SCALE the cast could overflow: the value as held, its scale the types' (refused at the top, unless
    // a round or a cast above fixes a smaller one); a scale decided per row stays so (a pad is at least, never at)
    case "pad": return one(p.arg, (x) => typeof x.scale !== "number" ? x : p.scale <= MAX_STORED_SCALE ? fixed(x, x.sql, p.scale) : { ...x, scale: p.scale });
    case "greatest": case "least": case "coalesce": case "pick": {
      // a sum of numbers read from text (src/duck/rewrite.ts `summed`): its exact sum, or the double's NaN or Infinity,
      // which no stored numeric holds; the exact sum's refusal is the form's true reason
      if (p.op === "pick" && p.args[0]?.op === "rescale") return storedNumeric(p.args[0], types, cells);
      const xs = all(p.args);
      if (!Array.isArray(xs)) return xs;
      const held = Math.max(0, ...xs.map((x) => x.held));
      const args = xs.map((x) => `CAST(${x.sql} AS DECIMAL(38,${held}))`);
      const scales = new Set(xs.map((x) => x.scale));
      const scale: Scale = scales.size === 1 ? [...scales][0]! : scaleOf(xs, () => -1) === -1 ? "picks" : scaleOf(xs, () => -1);
      // (differing numbers: the value taken decides, "picks"; a scale decided per row stays so)
      if (p.op !== "pick") return made(`${p.op}(${args.join(", ")})`, held, scale, xs);
      const index = storedNumeric(p.index, types, cells);
      if ("why" in index) return index;
      return made(`(CASE CAST(${index.sql} AS BIGINT) ${args.map((a, i) => `WHEN ${i} THEN ${a}`).join(" ")} END)`, held, scale, [...xs, index]);
    }
    case "div": return { why: "divides" };
    // a variance's digits: a square root Postgres takes at decimals it picks by the value's size
    case "stddev": return { sql: "NULL", held: 0, peak: 0, scale: "value", blocked: "variance", fn: p.variance ? (p.sample ? "variance" : "var_pop") : (p.sample ? "stddev" : "stddev_pop") };
    case "rescale": return one(p.arg, (x) => ({ ...x, scale: typeof x.scale === "number" ? "rows" : x.scale }));
  }
}

/** a stored numeric's verdict, where all that is around it is known: null where it is stored */
function verdict(s: Stored): NotStored | null {
  if (s.scale === "text") return { why: "text" };
  if (s.blocked === "double") return { why: "double" };
  if (s.blocked === "variance") return { why: "variance", fn: s.fn ?? "stddev" };
  if (s.scale === "value") return { why: "per-value" };
  if (s.scale === "rows") return { why: "rows" };
  if (s.scale === "picks") return { why: "picks" };
  if (s.blocked === "computed") return { why: "computed" };
  if (s.scale > MAX_STORED_SCALE) return { why: "scale", scale: s.scale };
  if (s.peak > MAX_STORED_SCALE) return { why: "held", scale: s.peak };
  return null;
}

/** a numeric not stored, said by its own reason, with ways out that hold */
function notStoredRefusal(name: string, n: NotStored): GeneratedRefusal {
  const double = `or read it as ${name}::double precision if it need not be exact`;
  const asDouble = `store it as a double if it need not be exact: sqrt(x)::double precision AS ${name}`;
  // the variance family, one wording whichever path saw it (a program, or the engine's double)
  const variance = (fn: string): GeneratedRefusal => ({ key: "sql",
    message: `column ${name} is a ${fn}, which Postgres computes as an exact numeric at decimals it picks by the size of each value, and the engine only as a double`,
    why: "A stored numeric keeps one scale for every row, and a stored double holds neither Postgres's digits nor its type.",
    options: [`store it as a double if it need not be exact: ${fn}(x)::double precision AS ${name}`, atRead] });
  const atRead = "or compute it in the statement that reads the synced table";
  switch (n.why) {
    case "divides": return { key: "sql", message: `column ${name} divides a numeric, which the engine computes as a double`, why: "Postgres divides a numeric exactly (an average is a division), so a stored double would not hold its digits.",
      options: ["store what it divides and divide where you read the table: sum(x) AS total, count(x) AS n", double] };
    case "variance": return variance(n.fn);
    case "per-value": return { key: "sql", message: `column ${name} is a numeric whose decimals Postgres picks by the size of each value (sqrt, exp, ln, log or power)`, why: "A stored numeric keeps one scale for every row.",
      options: [asDouble, atRead] };
    case "computed": return { key: "sql", message: `column ${name} rounds or casts a numeric Postgres computes for each row at decimals it picks (sqrt, exp, ln, log or power), which the engine computes as a double`, why: "Postgres's digits for it are worked out when a statement is answered, and a stored column skips that step.",
      options: [asDouble, atRead] };
    case "engine-double": return n.fn !== null && VARIANCES.has(n.fn) ? variance(n.fn) : { key: "sql",
      message: `column ${name} is a numeric the engine computes as a double${n.fn === null ? "" : ` (${n.fn})`}, where Postgres computes it exactly`, why: "A stored double would hold neither Postgres's digits nor its type.",
      options: [`store it as a double if it need not be exact: ${n.fn ?? "x"}(…)::double precision AS ${name}`, atRead] };
    case "text": return { key: "sql", message: `column ${name} is a numeric read from text (a JSON number's ->> cast to numeric), which keeps the decimals each value's text has`, why: "A stored numeric keeps one scale for every row.",
      options: [`give it one scale: (x)::numeric(20,4) AS ${name}`, double] };
    case "scale": return { key: "sql", message: `column ${name} has ${n.scale} decimals, more than the ${MAX_STORED_SCALE} a stored numeric keeps`, why: "A sum at that scale could overflow the 38 digits a stored numeric has.",
      options: [`round it to fewer: round(sum(x), 2) AS ${name}`, double] };
    case "held": return { key: "sql", message: `column ${name} is computed at ${n.scale} decimals on the way to its own, more than the ${MAX_STORED_SCALE} a stored numeric keeps (a sum of numbers read from text is added at 36)`, why: "A value at that scale could overflow the 38 digits a stored numeric has before it is rounded.",
      options: [`give the values fewer decimals first: sum((x)::numeric(20,4)) AS ${name}`, double] };
    case "rows": return { key: "sql", message: `column ${name} sums values Postgres keeps at differing scales, so the rows decide its decimals`, why: "A stored numeric keeps one scale for every row.",
      options: [`give the values one scale first: sum(x::numeric(20,4)) AS ${name}`, double] };
    case "picks": return { key: "sql", message: `column ${name} is whichever value a GREATEST, LEAST, COALESCE or CASE takes, at that value's own decimals, and its values have differing ones`, why: "A stored numeric keeps one scale for every row.",
      options: [`give it one scale: greatest(x, 1)::numeric(12,2) AS ${name}, or give each value the same decimals`, double] };
    case "double": return { key: "sql", message: `column ${name} is a numeric cast from a double precision value (x::float8::numeric)`, why: "Postgres writes such a numeric from the double's digits when a statement is answered, a step a stored column skips.",
      options: [`read it as ${name}::double precision`, "or compute it in the statement that reads the table"] };
    case "other": return { key: "sql", message: `column ${name} computes a numeric from ${n.what}, which Mason can't store exactly yet`, why: null,
      options: [`compute it in the statement that reads the table`, double] };
  }
}

/** each output column's outermost function, as written (`DefinitionPlan.forms`): null where it is none, or the columns
 *  are not one target each (a star, a set operation) */
function formsOf(stmt: unknown, n: number): Array<string | null> {
  const rec = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
  const top = rec(rec(stmt).SelectStmt);
  const targets = Array.isArray(top.targetList) ? top.targetList as unknown[] : [];
  if (targets.length !== n) return Array<string | null>(n).fill(null);
  return targets.map((t) => {
    const call = rec(rec(rec(rec(t).ResTarget).val).FuncCall);
    const names = Array.isArray(call.funcname) ? call.funcname as unknown[] : [];
    const last = rec(rec(names[names.length - 1]).String).sval;
    return typeof last === "string" ? last.toLowerCase() : null;
  });
}

/** a numeric output column, as the catalog spells its type */
export const isNumeric = (c: { type: string }): boolean => /^numeric\b/.test(c.type);

/**
 * EVERY NUMERIC OF A DEFINITION, AS STORED, held to the engine type DuckDB says the plan's SQL computes (`types`), or refused
 * by its own reason. A computed one (`DefinitionPlan.numerics`) is written as DECIMAL arithmetic over its cells; one the
 * engine answers itself (no program, "as the engine answers it", a passthrough's among them) is stored as the engine's
 * DECIMAL, an integer as HUGEINT (one type for a numeric of no decimals: a sum of int8, a sign), and a double refused.
 * At the check (`planDefinition` with a `describe`) and again at the write, over the SQL that runs.
 */
export function storedColumns(d: DefinitionPlan, types: EngineTypes): { columns: GeneratedColumn[] } | { refused: GeneratedRefusal[] } {
  const refused: GeneratedRefusal[] = [], exprs = new Map<number, string>();
  for (const { column, program, cells } of d.numerics) {
    const name = d.columns[column]!.name, stored = storedNumeric(program, types, cells);
    const no = "why" in stored ? stored : verdict(stored);
    if (no !== null) refused.push(notStoredRefusal(name, no));
    else exprs.set(column, (stored as Stored).sql);
  }
  d.columns.forEach((c, i) => {
    if (!isNumeric(c) || d.numerics.some((n) => n.column === i)) return;
    const type = types.get(`#${i}`);
    if (type !== undefined && (DECIMAL_TYPE.test(type) || type === "HUGEINT")) return;
    if (type !== undefined && INTEGER_TYPES.has(type)) exprs.set(i, `CAST(__mason_output.__mason_c${i} AS HUGEINT)`);
    else refused.push(notStoredRefusal(c.name, type === "DOUBLE" || type === "FLOAT" ? { why: "engine-double", fn: d.forms[i] ?? null } : { why: "other", what: `a value the engine holds as ${type ?? "nothing it names"}` }));
  });
  if (refused.length > 0) return { refused };
  return { columns: d.columns.map((c, i) => { const expr = exprs.get(i); return expr === undefined ? c : { ...c, duck: null, expr }; }) };
}

/** the tables a definition's SQL names, by name alone (`schema.table`, a bare name `public`'s): what a cycle is told
 *  from before anything is planned. A bare name some WITH of the statement holds is a CTE's and left out. Nothing,
 *  where the SQL does not parse: that is refused at its check. */
export async function readsByName(sql: string): Promise<string[]> {
  const select = await selectOf(sql);
  if ("refused" in select) return [];
  const ctes = new Set<string>(), qualified = new Set<string>(), bare = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    const cte = o.CommonTableExpr as { ctename?: string } | undefined;
    if (cte?.ctename !== undefined) ctes.add(cte.ctename);
    const r = o.RangeVar as { schemaname?: string; relname: string } | undefined;
    if (r !== undefined) (r.schemaname === undefined ? bare : qualified).add(r.schemaname === undefined ? r.relname : `${r.schemaname}.${r.relname}`);
    Object.values(o).forEach(walk);
  };
  walk(select.stmt);
  return [...new Set([...qualified, ...[...bare].filter((n) => !ctes.has(n)).map((n) => `public.${n}`)])].sort();
}

/** a definition in a cycle of generated tables (`cycle`: the tables, from this one round to it again) */
export function cycleRefusal(cycle: readonly string[]): GeneratedRefusal {
  return { key: "sql", message: cycle.length <= 2 ? `it reads ${cycle[0]}, itself` : `it reads itself through other generated tables: ${cycle.join(" -> ")}`,
    why: "A generated table is built from the tables built before it, so none can read itself, through others or not.",
    options: ["read the tables the cycle is generated from instead", "or write the other table's SQL into this one, as a subquery"] };
}

/**
 * A DEFINITION HELD TO WHAT A TABLE CAN STORE, its reads named. `relations`: for a run of a chain, each parent built in
 * the same run (`schema.table`) and the side table read in its place (src/duck/plan.ts swapRelations). Throws what `Planner.plan` throws: a statement Postgres or the rewrite refuses is the
 * caller's to say at its key, and a table not there yet its to wait for.
 */
export async function planDefinition(p: Planner, sql: string, orderBy: string | null, relations?: ReadonlyMap<string, string>, describe?: (sql: string) => Promise<EngineTypes>): Promise<{ definition: DefinitionPlan } | { refused: GeneratedRefusal[] }> {
  const statement = await definitionStatement(sql, orderBy);
  if ("refused" in statement) return { refused: [statement.refused] };
  let plan: DuckPlan;
  try { plan = await p.plan(statement.text, statement.stmt, relations); }
  catch (e) {
    // a statement refused for what Mason has not verified (`current_time`, a timetz) that also reads a session is refused
    // for the session, with the line to write: verifying it would not make it a table's to hold
    if (!(e instanceof StatementError) || e.gap !== "unverified") throw e;
    const keys = (/: ([^]*)$/.exec(e.fields.detail ?? "")?.[1] ?? "").split(", ").filter((k) => k !== "");
    const session = await sessionReads(p.rows, keys);
    if (session.length === 0) throw e;
    return { refused: [sessionRefusal(session)] };
  }
  const bases = [...new Set((plan.reads ?? []).map((r) => r.table))].sort();
  const refused: GeneratedRefusal[] = [];
  const session = await sessionReads(p.rows, plan.resolved);
  if (session.length > 0) refused.push(sessionRefusal(session));
  const text = await textReads(p.rows, plan.resolved, plan.argumentTypes ?? []);
  if (text.length > 0) refused.push(textRefusal(text));
  if (plan.clock?.parse !== undefined) refused.push({ key: "sql", message: "it reads a relative literal ('now', 'today')", why: THE_SESSION_WHY, options: ["use now(), as of the run, with the zone named if it reads a day: (now() AT TIME ZONE 'UTC')::date"] });
  if (plan.dropLast) refused.push({ key: "sql", message: "it ends in FETCH … WITH TIES", why: "That row count isn't a table's to keep.", options: ["use LIMIT, with an ORDER BY that decides every row"] });
  const fields = plan.fields ?? [];
  const twice = fields.find((f, i) => f.name !== UNNAMED && fields.findIndex((x) => x.name === f.name) !== i);
  if (twice !== undefined) refused.push({ key: "sql", message: `it names column ${twice.name} twice`, why: "A table's columns have one name each.", options: ["rename one with AS"] });
  const typeNames = new Map((await p.rows(fields.length === 0 ? "SELECT 0, ''" : `SELECT v.i::text, format_type(v.oid, v.typmod) FROM (VALUES ${fields.map((f, i) => `(${i}, ${Math.trunc(f.oid)}::oid, ${Math.trunc(f.typmod)})`).join(", ")}) AS v(i, oid, typmod)`))
    .map(([i, name]) => [Number(i), name!]));
  // a type a user or an extension made: an enum (`e`) and a citext are stored, a domain and a composite are not. Judged
  // by the column's INDEX and the catalog's type of the name the wire gives its OID: a field carries the SOURCE's OID
  // for a made type (src/duck/plan.ts), which the catalog's pg_type does not have
  const made = fields.map((f, i) => [f, i] as const).filter(([f]) => !STORED_TYPES.has(f.oid) && f.oid !== NUMERIC_OID);
  const kinds = new Map(made.length === 0 ? [] : (await p.rows(`SELECT v.i::text, CASE WHEN t.typname = 'citext' AND t.typtype = 'b' THEN 'citext' ELSE t.typtype::text END ` +
    `FROM (VALUES ${made.map(([f, i]) => `(${i}, ${Math.trunc(f.oid)}::oid)`).join(", ")}) AS v(i, oid) JOIN pg_type t ON t.oid = coalesce(to_regtype(public.mason_wire_type(v.oid, -1)), v.oid)`))
    .map(([i, kind]) => [Number(i), kind!] as const));
  fields.forEach((f, i) => { const bad = columnProblem(f, typeNames.get(i) ?? String(f.oid), kinds.get(i)); if (bad !== null) refused.push(bad); });
  // a numeric computed after the engine's answer: stored as DECIMAL arithmetic where the types fix its scale, over the
  // engine types DuckDB says the plan computes (`storedColumns`)
  const numerics: DefinitionPlan["numerics"] = [];
  for (const e of refused.length === 0 ? plan.exact ?? [] : []) {
    const f = fields[e.column]!;
    if (e.text) {
      refused.push({ key: "sql", message: `column ${f.name} is the text of a numeric computed when a statement is answered, which a generated table can't store yet`, why: "Postgres's digits for it are worked out when a statement is answered, and a stored column skips that step.", options: [`store the numeric, and write its text in the statement that reads the table`] });
      continue;
    }
    numerics.push({ column: e.column, program: e.program, cells: e.cells });
  }
  if (refused.length > 0) return { refused };
  const definition: DefinitionPlan = { plan, bases, warnings: statement.warnings, numerics, forms: formsOf(statement.stmt, fields.length),
    columns: fields.map((f, i) => ({ name: f.name, type: typeNames.get(i)!, duck: numerics.some((n) => n.column === i) ? null : STORED_TYPES.get(f.oid) ?? null })) };
  if (describe === undefined || !definition.columns.some(isNumeric)) return { definition };
  const stored = storedColumns(definition, await describe(plan.sql.text));
  return "refused" in stored ? stored : { definition: { ...definition, columns: stored.columns } };
}

/** A refusal said to a person: the file, the key, then the reason and the ways out a line each (issue 124's shape). */
export function refusalText(file: string, r: GeneratedRefusal): string {
  return [`${file}: ${r.key === null ? "" : `${r.key}: `}${r.message}.`, ...(r.why === null ? [] : [`  ${r.why}`]),
    ...(r.options.length === 0 ? [] : ["  Your options:", ...r.options.map((o) => `    - ${o}`)])].join("\n");
}

/** A statement's refusal as a table's: Postgres's or a gap's message, at `sql:`, with its hint as the way out. */
export function refusalOf(e: StatementError): GeneratedRefusal {
  const options = e.fields.hint === undefined ? [] : [e.fields.hint];
  // a column the database has and the copy doesn't is the likely reason a generated table meets this
  if (e.fields.code === "42703") options.push("if the table has that column, sync it: add it to the table's columns:, or take it out of exclude:, in the sources file");
  return { key: "sql", message: e.fields.message, why: e.fields.detail ?? null, options };
}
