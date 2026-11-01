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
 * the table is answered by the very path that answers one over a copy. A type with no entry is refused by name: `numeric`
 * too, whose digits a statement computes at the result's edge (`DuckPlan.exact`), so no plain write stores them.
 */
import { deparseSync } from "pgsql-deparser";
import type { Node } from "libpg-query";
import { parseSql, PostgresSyntaxError } from "../api/postgres/parser.ts";
import { describeKeys } from "./resolved.ts";
import { treeDifference } from "./rewrite.ts";
import { StatementError, type DuckPlan } from "./statement.ts";

/** A refusal of a generated table: its key in the file (null: the file itself), what is wrong, why, and the ways out. */
export interface GeneratedRefusal { key: string | null; message: string; why: string | null; options: string[] }

/** the Postgres type of an output column, by OID, as a copy stores it (src/duck/types.ts writes each back as Postgres's) */
const STORED_TYPES: ReadonlyMap<number, string> = new Map([
  [16, "BOOLEAN"], [17, "BLOB"], [20, "BIGINT"], [21, "SMALLINT"], [23, "INTEGER"], [25, "VARCHAR"], [114, "JSON"], [700, "FLOAT"], [701, "DOUBLE"], [1043, "VARCHAR"],
  [1082, "DATE"], [1083, "TIME"], [1114, "TIMESTAMP"], [1184, "TIMESTAMPTZ"], [1186, "INTERVAL"], [2950, "UUID"], [3802, "JSON"],
]);
const NUMERIC_OID = 1700;
/** the Postgres name `?column?` is an expression no one named, and a table's column needs one */
const UNNAMED = "?column?";
/** what the subquery of a definition with an `order_by:` is called: its output's columns are all it can read */
const SHELL_ALIAS = "__mason_generated";
const SHELL_KEYS = new Set(["targetList", "fromClause", "sortClause", "limitOption", "op"]);

/** An output column: its name, its type as the catalog spells it, as a copy stores it. */
export interface GeneratedColumn { name: string; type: string; duck: string }
/** A definition that can be stored: what `src/duck/generated.ts` runs. */
export interface DefinitionPlan {
  plan: DuckPlan;
  columns: GeneratedColumn[];
  /** the tables it reads, views read through (`schema.table`) */
  bases: string[];
  /** what its file does that changes nothing: said, never refused */
  warnings: string[];
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
function columnProblem(f: { name: string; oid: number }, typeName: string): GeneratedRefusal | null {
  const it = `column ${f.name}`;
  if (f.name === UNNAMED) return { key: "sql", message: "an output column has no name", why: "A table's columns are named, and Postgres has no name for an expression.", options: ["give it one: count(*) + 1 AS total"] };
  if (f.name.startsWith("__mason")) return { key: "sql", message: `${it} has a name Mason keeps for itself`, why: null, options: ["rename it with AS"] };
  if (f.oid === NUMERIC_OID) {
    return { key: "sql", message: `${it} is numeric, which a generated table can't store yet`, why: "Postgres's digits for a numeric are worked out when a statement is answered, and a stored column skips that step.",
      options: [`read ${f.name}::double precision if it need not be exact`, `or cast it to an integer type if it holds whole numbers: ${f.name}::bigint`] };
  }
  if (STORED_TYPES.has(f.oid)) return null;
  return { key: "sql", message: `${it} is of type ${typeName}, which a generated table can't store yet`, why: null, options: [`cast it to a type it can store: ${f.name}::text`] };
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
export async function planDefinition(p: Planner, sql: string, orderBy: string | null, relations?: ReadonlyMap<string, string>): Promise<{ definition: DefinitionPlan } | { refused: GeneratedRefusal[] }> {
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
  fields.forEach((f, i) => { const bad = columnProblem(f, typeNames.get(i) ?? String(f.oid)); if (bad !== null) refused.push(bad); });
  // a column computed after the engine's answer (`(x / 3)::text`): what a plain write would store is not Postgres's
  if (refused.length === 0 && (plan.exact?.length ?? 0) > 0) {
    const f = fields[plan.exact![0]!.column]!;
    refused.push({ key: "sql", message: `column ${f.name} is computed from a numeric, which a generated table can't store yet`, why: "Postgres's digits for a numeric are worked out when a statement is answered, and a stored column skips that step.", options: [`compute it over double precision: (x::double precision / 3)::text`] });
  }
  if (refused.length > 0) return { refused };
  return { definition: { plan, bases, warnings: statement.warnings, columns: fields.map((f, i) => ({ name: f.name, type: typeNames.get(i)!, duck: STORED_TYPES.get(f.oid)! })) } };
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
