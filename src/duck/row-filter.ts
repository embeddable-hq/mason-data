/**
 * ROW FILTERS: WHICH ROWS OF A TABLE A ROLE READS (GitHub issue 30, stage 2). A table of a role in the roles file
 * (src/cli/roles.ts) may carry `where: "<a Postgres boolean expression>"` over the table's columns and the role's
 * attributes (`:tenant`), or `through: <table>` — a row is visible when the row of that other table it references by its
 * foreign key is visible. A user carries the attributes' values (`mason user add … --set tenant=42`, src/duck/users.ts).
 *
 * ANSWERED AS POSTGRES'S ROW SECURITY ANSWERS IT: Postgres's rewriter adds a policy's USING expression to the range-table
 * entry of every read of the table, wherever the read is (a view, a CTE, a subquery, a join's side, a UNION's branch), with
 * `current_setting('mason.attr.<name>')::<type>` read as the session's value. Mason does what it does to a view
 * (src/duck/views.ts): every reference to a filtered table, in the statement as Postgres analysed it, becomes
 * `(SELECT * FROM <table> WHERE <the predicate, the user's values bound as literals of their type>) AS <its name>`, and
 * THAT statement is planned from the start — analysed by Postgres, rewritten for DuckDB by the same rewrite as every
 * statement (one grammar), verified as any other. A literal's type is the type Postgres infers for the parameter where
 * the predicate uses it (`tenant_id = :tenant`: the column's), so `'42'` binds as `CAST('42' AS integer)` — what
 * `current_setting(…)::integer` is — and a list as `CAST(ARRAY['12', '41'] AS integer[])`.
 *
 * `:name` is read by ONE lexer (`whereParts`), for the file's check, the catalog's policy and the binding alike: outside a
 * string, a quoted name, a dollar-quoted body and a comment, never in a `::` cast.
 */
import { deparseSync } from "pgsql-deparser";
import type { Node } from "libpg-query";
import { gapRefusal, StatementError } from "./statement.ts";
import { parseSql } from "../api/postgres/parser.ts";
import { analyze, catalogRows, type PgAnalysis } from "./analyze.ts";
import type { TreeValue } from "./pgtree.ts";
import { treeDifference } from "./rewrite.ts";

type Body = Record<string, unknown>;
type Catalog = (bytes: Uint8Array) => Promise<Uint8Array>;

/** an attribute's name: what `:name` reads and `--set name=value` sets */
export const ATTRIBUTE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;
export const ATTRIBUTE_NAME_RULE = "1 to 63 lower case letters, digits or \"_\", starting with a letter or \"_\" (e.g. tenant)";

/** a scalar attribute holds one value (`--set tenant=42`); a list several (`--set tenants=12 --set tenants=41`) */
export type AttributeShape = "scalar" | "list";
/** a user's attribute values, as the users file keeps them: a string per scalar, an array of strings per list */
export type AttributeValues = Readonly<Record<string, string | readonly string[]>>;

/** a `where:` read by the lexer: its text, with each `:name` a part of its own */
export type WherePart = string | { attr: string };

/**
 * A `where:` read: its text in parts, each `:name` one of them; or what is wrong with it (an unterminated string or
 * comment). A name that is no attribute is the caller's to judge (src/cli/roles.ts).
 */
export function whereParts(sql: string): WherePart[] | { problem: string } {
  const out: WherePart[] = [];
  let text = "";
  let i = 0;
  const n = sql.length;
  const until = (end: string, from: number, what: string): number | { problem: string } => {
    const at = sql.indexOf(end, from);
    return at < 0 ? { problem: `${what} is not closed` } : at + end.length;
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    let to: number | { problem: string } | null = null;
    if (c === "'" || ((c === "e" || c === "E") && next === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? ""))) {
      // a string: '' is a quote inside it; E'…' takes a backslash's escape too
      const escapes = c !== "'";
      let j = escapes ? i + 2 : i + 1;
      for (;;) {
        if (j >= n) return { problem: "a string ('…') is not closed" };
        if (escapes && sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } j++; break; }
        j++;
      }
      to = j;
    } else if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= n) return { problem: "a quoted name (\"…\") is not closed" };
        if (sql[j] === '"') { if (sql[j + 1] === '"') { j += 2; continue; } j++; break; }
        j++;
      }
      to = j;
    } else if (c === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      to = eol < 0 ? n : eol;
    } else if (c === "/" && next === "*") {
      // comments nest in Postgres
      let depth = 0, j = i;
      for (;;) {
        if (j >= n) return { problem: "a comment (/* … */) is not closed" };
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; continue; }
        if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; if (depth === 0) break; continue; }
        j++;
      }
      to = j;
    } else if (c === "$" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag !== null) to = until(tag[0], i + tag[0].length, `a dollar-quoted string (${tag[0]}…${tag[0]})`);
      // $1 is a statement's parameter: bound here it would read the STATEMENT's first value, never the role's
      else if (/[0-9]/.test(next ?? "")) return { problem: `${/^\$[0-9]+/.exec(sql.slice(i))![0]} is a statement's parameter, which a where: cannot read — name an attribute of the role: :tenant` };
    } else if (c === ":" && next === ":") {
      to = i + 2;
    } else if (c === ":" && /[A-Za-z_]/.test(next ?? "")) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))![0];
      if (text !== "") { out.push(text); text = ""; }
      out.push({ attr: name });
      i += 1 + name.length;
      continue;
    }
    if (to !== null) {
      if (typeof to !== "number") return to;
      text += sql.slice(i, to);
      i = to;
      continue;
    }
    text += c;
    i++;
  }
  if (text !== "") out.push(text);
  return out;
}

/** the attributes a `where:` reads, in the order it first reads each */
export const whereAttributes = (parts: readonly WherePart[]): string[] =>
  [...new Set(parts.flatMap((p) => typeof p === "string" ? [] : [p.attr]))];

/** the `where:` written again, each `:name` as `render` says (the same text between them) */
export const renderWhere = (parts: readonly WherePart[], render: (attr: string) => string): string =>
  parts.map((p) => typeof p === "string" ? p : render(p.attr)).join("");

/**
 * A user's attribute as a session setting, `mason.attr.<name>` (a list's values joined by commas), or null: what
 * `SHOW` and `current_setting` answer, and what the catalog's row security policies read (src/api/postgres/catalog.ts
 * catalogPolicies), as a Postgres role's own `ALTER ROLE … SET mason.attr.tenant` would. Never the session's to SET.
 */
export function attributeSetting(name: string, values: AttributeValues | undefined): string | null {
  if (values === undefined || !name.startsWith("mason.attr.")) return null;
  const v = values[name.slice("mason.attr.".length)];
  return v === undefined ? null : typeof v === "string" ? v : v.join(",");
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
/** `schema.table` as SQL: each part quoted */
export const tableSql = (table: string): string => { const dot = table.indexOf("."); return `${quoteIdent(table.slice(0, dot))}.${quoteIdent(table.slice(dot + 1))}`; };
export const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** One table's filter in a role, resolved against the copied tables (src/cli/roles.ts resolveRoles). */
export interface RowFilter {
  /** `schema.table` */
  table: string;
  /** where it is written, as a message names it: `roles.tenant.tables.orders` */
  at: string;
  /** `where:`: its text as written, and read in parts */
  where?: { text: string; parts: readonly WherePart[] };
  /** `through:`: a row is visible when the row of `parent` whose `parentColumn` equals its `column` is visible */
  through?: { parent: string; column: string; parentColumn: string };
}

/**
 * THE TYPE OF EACH ATTRIBUTE A `where:` READS, as Postgres infers it — the predicate analysed as `SELECT 1 FROM <table>
 * WHERE <it>` with each `:name` a parameter `$n` — or Postgres's own refusal, said at the key (`at`) with `:name` for
 * `$n`. A list must be read as an array (`= ANY(:tenants)`) and a scalar as a value: the other way round, the predicate
 * is analysed again with the parameter DECLARED of the shape the file says, so the refusal is Postgres's own
 * (`operator does not exist: integer = integer[]`). A `where:` that reads another table (a subquery) is refused:
 * `through:` is how a filter reads another table. The ONE derivation of the types: the catalog's policies and every
 * statement's binding read what this returns (src/api/postgres/server.ts `checkedRoles`).
 */
export async function filterTypes(run: Catalog, f: RowFilter, shapes: ReadonlyMap<string, AttributeShape>): Promise<{ types: Map<string, string> } | { problem: string }> {
  if (f.where === undefined) return { types: new Map() };
  const names = whereAttributes(f.where.parts);
  const sqlOf = (): string => `SELECT 1 FROM ${tableSql(f.table)} WHERE ${renderWhere(f.where!.parts, (a) => `$${names.indexOf(a) + 1}`)}`;
  const sql = sqlOf();
  const prefix = `SELECT 1 FROM ${tableSql(f.table)} WHERE `;
  const said = (r: Record<string, string>): { problem: string } => {
    const at = r.P !== undefined && Number(r.P) > prefix.length ? ` (at character ${Number(r.P) - prefix.length} of the where:)` : "";
    const message = (r.M ?? "Postgres refused it").replace(/\$(\d+)/g, (m, k: string) => names[Number(k) - 1] !== undefined ? `:${names[Number(k) - 1]}` : m);
    return { problem: `${f.at}.where: ${message}${at} — the predicate is checked by Postgres as SELECT 1 FROM ${f.table} WHERE ${f.where!.text}` };
  };
  const first = await analyze(run, sql, names.map(() => 0), "public");
  if ("refused" in first) return said(first.refused);
  if (hasSubquery(first.tree)) return { problem: `${f.at}.where: reads another table (a subquery) — a where: reads its own table's columns; through: <table> makes a row visible through another table's` };
  const oids = first.params;
  // each type named as it reads under any search_path (pg_catalog's own bare, every other qualified)
  const rows = oids.length === 0 ? [] : await catalogRows(run, `SET LOCAL search_path = pg_catalog; SELECT t.oid::text, format_type(t.oid, NULL), (t.typcategory = 'A')::text, t.typelem::text, ` +
    `t.typarray::text FROM pg_type t WHERE t.oid IN (${oids.map((o) => Math.trunc(o)).join(", ")})`);
  const byOid = new Map(rows.map(([oid, name, isArray, elem, array]) => [Number(oid), { name: name!, isArray: isArray === "true", elem: Number(elem), array: Number(array) }]));
  const types = new Map<string, string>();
  const declared: number[] = [];
  let mismatch: string | null = null;
  for (const [i, a] of names.entries()) {
    const t = byOid.get(oids[i]!);
    if (t === undefined) return { problem: `${f.at}.where: Postgres inferred no type for :${a} — write a cast: :${a}::integer` };
    const list = (shapes.get(a) ?? "scalar") === "list";
    if (list && !t.isArray) { mismatch ??= `:${a} is a list, read here as one ${t.name} — write = ANY(:${a})`; declared.push(t.array); }
    else if (!list && t.isArray) {
      mismatch ??= `:${a} is a scalar, read here as a list (${t.name}) — declare it attributes: { ${a}: list }, or compare it as a value`;
      declared.push(t.elem);
    } else declared.push(oids[i]!);
    types.set(a, t.name);
  }
  if (mismatch !== null) {
    // Postgres's own refusal, the parameter declared of the shape the file says
    const again = await analyze(run, sql, declared, "public");
    if ("refused" in again) return { problem: `${said(again.refused).problem} (${mismatch})` };
    return { problem: `${f.at}.where: ${mismatch}` };
  }
  return { types };
}

/** whether an analysed tree holds a subquery (a SubLink: IN, EXISTS, a scalar subquery …) */
function hasSubquery(tree: TreeValue): boolean {
  let found = false;
  const visit = (v: TreeValue | undefined): void => {
    if (found) return;
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === null || typeof v !== "object") return;
    if (v._node === "SUBLINK") { found = true; return; }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return found;
}

/**
 * A ROLE'S FILTER OF ONE TABLE, BOUND TO ONE USER: the predicate as SQL over the table's columns, each attribute a
 * literal of the type Postgres inferred for it (`filterTypes`); for `through:`, the parent it is read through. `words`:
 * how EXPLAIN says it (`tenant_id = 42`, a list `tenant_id = ANY(12, 41)`, bounded).
 */
export interface BoundFilter {
  table: string;
  predicate?: string;
  through?: { parent: string; column: string; parentColumn: string };
  words: string;
  /** each attribute it reads as it was bound, so a value its type refuses is said by the attribute (`attributeRefused`) */
  attributes?: ReadonlyArray<{ name: string; type: string; sql: string; at: string; where: string }>;
}

/** a value as EXPLAIN says it: a number bare, anything else quoted */
const shownValue = (v: string): string => /^-?\d+(\.\d+)?$/.test(v) ? v : literal(v);
/** a list as EXPLAIN says it: its first values, then how many more */
const SHOWN_VALUES = 5;
export const shownList = (vs: readonly string[]): string =>
  vs.length <= SHOWN_VALUES ? vs.map(shownValue).join(", ") : `${vs.slice(0, SHOWN_VALUES).map(shownValue).join(", ")}, … and ${vs.length - SHOWN_VALUES} more`;

/** The filter bound to a user's values (every attribute it reads is set: `missingAttributes` refused the user first). */
export function bindFilter(f: RowFilter, types: ReadonlyMap<string, string>, values: AttributeValues): BoundFilter {
  if (f.through !== undefined) {
    const parent = f.through.parent.replace(/^public\./, "");
    return { table: f.table, through: f.through, words: `a row of ${parent} it references by ${f.through.column} is visible` };
  }
  const parts = f.where!.parts;
  const valueOf = (a: string): string | readonly string[] => values[a] ?? "";
  const bound = (a: string): string => {
    const v = valueOf(a);
    const type = types.get(a) ?? "text";
    return typeof v === "string" ? `CAST(${literal(v)} AS ${type})` : `CAST(ARRAY[${v.map(literal).join(", ")}] AS ${type})`;
  };
  const words = renderWhere(parts, (a) => { const v = valueOf(a); return typeof v === "string" ? shownValue(v) : shownList(v); }).replace(/\s+/g, " ").trim();
  const attributes = whereAttributes(parts).map((a) => ({ name: a, type: types.get(a) ?? "text", sql: bound(a), at: `${f.at}.where`, where: f.where!.text }));
  return { table: f.table, predicate: renderWhere(parts, bound), words, attributes };
}

/**
 * THE ATTRIBUTE WHOSE VALUE ITS TYPE REFUSES, read when a filtered statement's analysis raised a data exception: only a
 * bound value can be `--set tenant=abc` on an integer, and only here is the attribute still known. `tables`: the filters
 * this statement reads, for a value it never binds is no cause of its error. Null: every value is good, so the exception
 * is the statement's own. `mason user add` cannot refuse it at the door: the type is the catalog's
 * inference, and a role changed since is met here anyway.
 */
export async function attributeRefused(run: Catalog, rows: ReadonlyMap<string, BoundFilter>, tables: readonly string[]): Promise<{ name: string; type: string; at: string; where: string; problem: string } | null> {
  for (const table of tables) {
    for (const a of rows.get(table)?.attributes ?? []) {
      const r = await analyze(run, `SELECT ${a.sql}`, [], "public");
      if ("refused" in r) return { name: a.name, type: a.type, at: a.at, where: a.where, problem: r.refused.M ?? "Postgres refused it" };
    }
  }
  return null;
}

/**
 * THE FILTERED READ `checkRoles` PLANS, so a `where:` Mason's rewrite cannot send is the file's problem at its key, never
 * a refusal at every statement of its users: the one read a statement meets (`filteredSql`), every attribute NULL, the
 * one value of every type.
 */
export function filterProbe(f: RowFilter, types: ReadonlyMap<string, string>, shapes: ReadonlyMap<string, AttributeShape>): string {
  const predicate = renderWhere(f.where!.parts, (a) => `CAST(${shapes.get(a) === "list" ? "ARRAY[NULL]" : "NULL"} AS ${types.get(a) ?? "text"})`);
  return filteredSql(f.table, new Map([[f.table, { table: f.table, predicate, words: "" }]]));
}

/** whether a user holds a value of an attribute: an empty list is none, never a filter that keeps no row (a user
 *  written by hand: `mason user add` refuses one), which would be the silent zero rows this refuses */
const hasValue = (v: string | readonly string[] | undefined): boolean => v !== undefined && (typeof v === "string" || v.length > 0);

/** the attributes a role reads (its filters' `where:`s) that a user's values lack, each with the filter that reads it */
export function missingAttributes(filters: Iterable<RowFilter>, values: AttributeValues): Array<{ attr: string; at: string; where: string }> {
  const out: Array<{ attr: string; at: string; where: string }> = [];
  for (const f of filters) {
    if (f.where === undefined) continue;
    for (const a of whereAttributes(f.where.parts)) if (!hasValue(values[a]) && !out.some((x) => x.attr === a)) out.push({ attr: a, at: `${f.at}.where`, where: f.where.text });
  }
  return out;
}

// ------------------------------------------------------------------ the statement with its filters in place

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const sval = (n: unknown): string | null => isObject(n) && isObject(n.String) && typeof n.String.sval === "string" ? n.String.sval : null;

/** every `{ Kind: body }` node of the raw tree, with the object and key holding it (to be replaced in place) */
function nodes(root: unknown): Array<{ holder: Body | unknown[]; key: string | number; kind: string; body: Body; parent: string | null }> {
  const out: Array<{ holder: Body | unknown[]; key: string | number; kind: string; body: Body; parent: string | null }> = [];
  const visit = (holder: Body | unknown[], key: string | number, v: unknown, parent: string | null): void => {
    if (Array.isArray(v)) { v.forEach((x, i) => visit(v, i, x, parent)); return; }
    if (!isObject(v)) return;
    const keys = Object.keys(v);
    let kind = parent;
    if (keys.length === 1 && /^[A-Z]/.test(keys[0]!) && isObject(v[keys[0]!])) { out.push({ holder, key, kind: keys[0]!, body: v[keys[0]!] as Body, parent }); kind = keys[0]!; }
    for (const k of keys) visit(v, k, v[k], kind);
  };
  visit({ root }, "root", root, null);
  return out;
}

/** the copied tables Postgres's analysis read, by OID (range-table entries of a relation, relkind r) */
function relationsRead(tree: TreeValue): Set<number> {
  const out = new Set<number>();
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === null || typeof v !== "object") return;
    if (v._node === "RANGETBLENTRY" && v.rtekind === "0" && v.relkind === "r" && typeof v.relid === "string") out.add(Number(v.relid));
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return out;
}

function refused(message: string, hint: string): StatementError {
  return gapRefusal("roles", message, hint);
}

/**
 * THE SECURITY BARRIER: what Postgres's row security gets by marking a policy's subquery a barrier, written in the one
 * form the engine's optimiser cannot see through. It pushes a filter through a subquery, a projection and a join's side,
 * so a statement's own condition would run on the rows the filter is there to hide — below a SEMI join, on every row of
 * the table — and an expression that raises on one (`1/(CASE WHEN qty = 99 THEN 0 ELSE 1 END)`) would answer "does a
 * hidden row satisfy P?" for any P. It never pushes a filter through a LIMIT, which would change what the limit keeps,
 * so a limit that keeps every row is a wall: everything of the statement runs on what comes out of it. Measured
 * (docs/DESIGN.md "Roles: rows per user"): `LIMIT <the largest bigint>` beside `OFFSET 0`, which runs a serial operator
 * under the default settings, and with no gate: every filtered read has it. A filter's own reads (the parents of a
 * `through:`) hold nothing of the statement's, so only the outermost read needs it.
 *
 * THE LIMIT STOPS A FILTER, NOT A FACT: the engine carries each column's table-wide minimum, maximum and null count up
 * through a limit, and proves a condition false from them. `WHERE 1/(id-id) > 0 AND secret > N` then raises for N below
 * the table's maximum and answers nothing above it, a binary search on a hidden row with no EXPLAIN in it. So the read
 * ends in a projection the engine carries no statistics through, `try(col)` of every column (`STATISTICS_WALL`; a
 * column's name and type pass through it): what the statement meets knows nothing of the table. Disabling the
 * optimiser pass per statement is not open: the engine's setting is global, so it would race the other sessions.
 */
export const BARRIER = "LIMIT 9223372036854775807";
/** the name of the select around the barrier, unless the statement holds it (`wallsOf`) */
const WALL = "__mason_barrier";
/** the FROM item `filterProbe`'s read names at its top, Mason's own: the namespace check passes it (plan.ts `own`) */
export const FILTER_PROBE_OWN: readonly string[] = [WALL];
/** the select list's call of `try(col)` on every column, as the engine reads it; `AS "\0"` keeps each column's name */
export const STATISTICS_WALL = "try(COLUMNS(*))";
/** FOR TESTS ALONE (tests/duck-roles-barrier-wire.test.ts): `statistics` false leaves `try` out, so the LIMIT is shown to
 *  hold the barrier's shapes by itself. Nothing in src/ sets it */
export const wallSwitch = { statistics: true };

/** the walls Mason wrote into a statement: their select's name, which nothing the statement wrote holds, and how many */
export interface Walls { alias: string; reads: number }

/** a name for the walls that no string of the statement holds (its names, its literals), so nothing of the user's can be
 *  taken for Mason's: a name is no proof of whose a subquery is unless it is chosen after reading the statement. The
 *  same statement chooses the same name, so what EXPLAIN says of it does not vary */
function wallName(tree: unknown): string {
  const strings = new Set<string>();
  const collect = (v: unknown): void => {
    if (typeof v === "string") strings.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (isObject(v)) Object.values(v).forEach(collect);
  };
  collect(tree);
  let name = WALL;
  for (let i = 1; strings.has(name); i++) name = `${WALL}_${i}`;
  return name;
}

/**
 * THE WALL'S SELECT LIST, in place of the `*` `filteredSql` wrote around the barrier, once the rewrite is done: Postgres
 * has no `COLUMNS(*)`, so it is the engine's text, never the analysed one. Exactly the reads Mason wrote, or the statement
 * is refused: a read with no wall would answer a statement from the statistics of a whole table.
 */
export function wallStatistics(tree: unknown, walls: Walls): void {
  let placed = 0;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isObject(v)) return;
    const from = v.fromClause as Array<{ RangeSubselect?: { alias?: { aliasname?: string } } }> | undefined;
    if (from?.length === 1 && from[0]?.RangeSubselect?.alias?.aliasname === walls.alias) {
      const list = v.targetList as Array<{ ResTarget?: { val?: { ColumnRef?: { fields?: Array<Record<string, unknown>> } } } }> | undefined;
      const fields = list?.length === 1 ? list[0]?.ResTarget?.val?.ColumnRef?.fields : undefined;
      if (fields?.length === 1 && fields[0]?.A_Star !== undefined) {
        const columns = { FuncCall: { funcname: [{ String: { sval: "columns" } }], agg_star: true } };
        v.targetList = [{ ResTarget: { name: "\\0", val: { FuncCall: { funcname: [{ String: { sval: "try" } }], args: [columns] } } } }];
        placed++;
      }
    }
    Object.values(v).forEach(visit);
  };
  visit(tree);
  if (placed !== walls.reads) {
    throw refused(`Mason cannot yet answer this statement over the tables its role filters: it holds ${placed} of the ${walls.reads} filtered reads Mason wrote (a Mason gap: report it, with the statement)`,
      "read the filtered table in a simpler form");
  }
}

/** the filtered read of `table` as SQL: its rows the filter keeps, `through:` read through its parent's filtered read;
 *  behind the barrier at its outermost (`depth` 1), where the statement meets it */
export function filteredSql(table: string, filters: ReadonlyMap<string, BoundFilter>, depth = 1, wall = WALL): string {
  const f = filters.get(table);
  if (f === undefined) return `SELECT * FROM ${tableSql(table)}`;
  // the select around the barrier, for the wall (`wallStatistics`)
  const walled = (read: string): string => depth === 1 ? `SELECT * FROM (${read} ${BARRIER}) AS ${wall}` : read;
  if (f.predicate !== undefined) return walled(`SELECT * FROM ${tableSql(table)} WHERE (${f.predicate})`);
  const t = f.through!;
  const p = `__mason_parent${depth}`;
  return walled(`SELECT * FROM ${tableSql(table)} WHERE EXISTS (SELECT 1 FROM (${filteredSql(t.parent, filters, depth + 1)}) AS ${p} WHERE ${p}.${quoteIdent(t.parentColumn)} = ${tableSql(table)}.${quoteIdent(t.column)})`);
}

/** the items a select's FROM reads itself: never a subquery's, through its JOINs */
function fromItems(from: unknown): Body[] {
  if (Array.isArray(from)) return from.flatMap(fromItems);
  if (!isObject(from)) return [];
  const j = isObject(from.JoinExpr) ? from.JoinExpr : null;
  if (j !== null) return [...fromItems(j.larg), ...fromItems(j.rarg)];
  return isObject(from.RangeVar) ? [from.RangeVar] : [];
}

/**
 * A GROUP BY OF A FILTERED TABLE'S PRIMARY KEY KEEPS WHAT THE KEY DECIDES. Postgres accepts `SELECT o.id, o.status … GROUP
 * BY o.id` by functional dependency on the table's key, and a table turned into a subquery has no key, so the filtered
 * text alone would be refused 42803. So each column of the table the select reads outside an aggregate joins its GROUP
 * BY. The key is grouped whole, so a group holds one row of the table and no column added can change a group; the gate
 * is the key, never Postgres's acceptance, since `GROUP BY lower(status)` also reads a column ungrouped. A grouping set
 * is left alone and refused by name (plan.ts), as is a column no type's equality can group.
 */
async function carryKeyDependency(catalog: Catalog, tree: Body, reads: ReadonlyArray<{ range: Body; table: string }>, analysis: PgAnalysis, oids: ReadonlyMap<string, number>): Promise<void> {
  const selects = nodes(tree).filter((n) => n.kind === "SelectStmt" && Array.isArray(n.body.groupClause) && n.body.groupClause.length > 0);
  if (selects.length === 0) return;
  const aliasOf = (r: Body): string => ((r.alias as Body | undefined)?.aliasname ?? r.relname) as string;
  const keys = new Map<string, { key: string[]; columns: string[] }>();
  const shape = async (table: string): Promise<{ key: string[]; columns: string[] }> => {
    const known = keys.get(table);
    if (known !== undefined) return known;
    const rows = await catalogRows(catalog, `SELECT a.attname, COALESCE(a.attnum = ANY(i.indkey), false)::text FROM pg_attribute a LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary ` +
      `WHERE a.attrelid = ${Math.trunc(oids.get(table)!)} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
    const got = { key: rows.filter(([, k]) => k === "true").map(([c]) => c!), columns: rows.map(([c]) => c!) };
    keys.set(table, got);
    return got;
  };
  for (const { body: s } of selects) {
    const groups = s.groupClause as unknown[];
    if (groups.some((g) => isObject(g) && "GroupingSet" in g)) continue;
    const own = new Set(fromItems(s.fromClause));
    const here = reads.filter((r) => own.has(r.range));
    if (here.length === 0) continue;
    const targets = (s.targetList ?? []) as Body[];
    // what the GROUP BY groups, by name: a column, an output name of one, or a position of one
    const columnOf = (n: unknown): string[] | null => isObject(n) && isObject(n.ColumnRef) ? (n.ColumnRef.fields as unknown[]).map(sval).filter((x): x is string => x !== null) : null;
    const target = (t: Body | undefined): unknown => isObject(t?.ResTarget) ? t.ResTarget.val : undefined;
    const grouped = groups.map((g) => {
      const c = columnOf(g);
      if (c?.length === 1) { const named = targets.find((t) => isObject(t.ResTarget) && t.ResTarget.name === c[0]); if (named !== undefined) return columnOf(target(named)); return c; }
      const at = isObject(g) && isObject(g.A_Const) && isObject(g.A_Const.ival) ? Number(g.A_Const.ival.ival) : null;
      return at !== null ? columnOf(target(targets[at - 1])) : c;
    }).filter((c): c is string[] => c !== null);
    // what the select reads outside an aggregate, of itself or from a subquery's correlation
    const read: Array<{ of: string | null; name: string | null }> = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (!isObject(v)) return;
      const call = isObject(v.FuncCall) ? v.FuncCall : null;
      if (call !== null && call.over === undefined && analysis.types.get(call.location as number)?.some((t) => t.node === "AGGREF")) return;
      if (isObject(v.ColumnRef)) {
        const fields = v.ColumnRef.fields as unknown[];
        const star = isObject(fields[fields.length - 1]) && "A_Star" in (fields[fields.length - 1] as Body);
        const names = fields.map(sval);
        read.push({ of: fields.length >= 2 ? names[fields.length - 2]! : null, name: star ? null : names[fields.length - 1]! });
        return;
      }
      Object.values(v).forEach(walk);
    };
    walk([s.targetList, s.havingClause, s.sortClause, s.windowClause]);
    for (const { range, table } of here) {
      const alias = aliasOf(range);
      const { key, columns } = await shape(table);
      const groupedHere = grouped.filter((c) => c.length === 1 || c[c.length - 2] === alias).map((c) => c[c.length - 1]!);
      if (key.length === 0 || !key.every((k) => groupedHere.includes(k))) continue;
      const add = columns.filter((c) => !groupedHere.includes(c) && read.some((r) => (r.of === null || r.of === alias) && (r.name === null || r.name === c)));
      groups.push(...add.map((c) => ({ ColumnRef: { fields: [{ String: { sval: alias } }, { String: { sval: c } }] } })));
    }
  }
}

/**
 * The statement with every read of a filtered table replaced by its filtered read, printed; null when it reads no
 * filtered table. Throws a StatementError (gap roles) where the replacement could read otherwise than Postgres's row
 * security: a filtered table's whole row (a subquery's is a record), a name both a WITH query and a filtered table, a
 * TABLESAMPLE of one, a column qualified by its schema beside another item of the table's name.
 */
export async function expandRowFilters(catalog: Catalog, stmt: Node, analysis: PgAnalysis, searchPathSql: string, filters: ReadonlyMap<string, BoundFilter>): Promise<{ text: string; stmt: Node; walls: Walls; tables: string[] } | null> {
  const read = relationsRead(analysis.tree);
  if (read.size === 0 || filters.size === 0) return null;
  const names = await catalogRows(catalog, `SELECT c.oid::text, n.nspname || '.' || c.relname, c.reltype::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid IN (${[...read].join(", ")})`);
  const filteredRead = new Map(names.filter(([, name]) => filters.has(name!)).map(([oid, name, rowType]) => [Number(oid), { table: name!, rowType: Number(rowType) }]));
  if (filteredRead.size === 0) return null;
  // a filtered table's whole row is the table's row type; a subquery's is a record
  const rowTypes = new Set([...filteredRead.values()].map((v) => v.rowType));
  if ([...analysis.types.values()].flat().some((t) => rowTypes.has(t.type))) {
    throw refused("Mason cannot yet answer a whole row of a table its role filters", "name the table's columns, or write t.*");
  }
  const tree = structuredClone(stmt) as unknown as Body;
  const all = nodes(tree);
  const ranges = all.filter((n) => n.kind === "RangeVar");
  const ctes = new Set(all.filter((n) => n.kind === "CommonTableExpr").map((n) => n.body.ctename as string));
  const spelled = ranges.map((r) => [r.body.catalogname, r.body.schemaname, r.body.relname].filter((x): x is string => typeof x === "string").map(quoteIdent).join("."));
  const resolved = spelled.length === 0 ? [] : await catalogRows(catalog,
    `SET LOCAL search_path = ${searchPathSql}, pg_catalog; SELECT v.i::text, c.oid::text FROM (VALUES ${spelled.map((s, i) => `(${i}, ${literal(s)})`).join(", ")}) AS v(i, name) ` +
    `JOIN pg_class c ON c.oid = to_regclass(v.name) WHERE c.relkind = 'r'`);
  const asFiltered = new Map<number, string>();
  for (const [i, oid] of resolved) {
    const hit = filteredRead.get(Number(oid));
    if (hit === undefined) continue;
    const r = ranges[Number(i)]!;
    if (r.body.schemaname === undefined && ctes.has(r.body.relname as string)) {
      throw refused(`Mason cannot yet answer a statement whose WITH query is named as a table its role filters (${r.body.relname as string})`, "rename the WITH query");
    }
    if (r.parent === "RangeTableSample") throw refused(`Mason cannot yet answer a TABLESAMPLE of a table its role filters (${hit.table})`, "read the table without TABLESAMPLE");
    asFiltered.set(Number(i), hit.table);
  }
  // `row(c.*)`, `ARRAY[c.*]`, `VALUES (c.*)`: a star expanded where it is written, which only a SELECT's own list does
  // on the copy; a whole row by another spelling (above), refused by the same name rather than the engine's own words
  const filteredNames = new Set([...asFiltered.keys()].map((i) => { const b = ranges[i]!.body; return ((b.alias as Body | undefined)?.aliasname ?? b.relname) as string; }));
  for (const c of all.filter((n) => n.kind === "ColumnRef" && n.parent !== "ResTarget")) {
    const fields = c.body.fields as unknown[];
    const star = isObject(fields[fields.length - 1]) && "A_Star" in (fields[fields.length - 1] as Body);
    const of = fields.length >= 2 ? sval(fields[fields.length - 2]) : null;
    if (star && of !== null && filteredNames.has(of)) throw refused("Mason cannot yet answer a whole row of a table its role filters", "name the table's columns, or write t.*");
  }
  const found = new Set(asFiltered.values());
  if ([...filteredRead.values()].some((v) => !found.has(v.table))) {
    throw refused("Mason could not tell which of the statement's names are the tables its role filters (a Mason gap: report it, with the statement)", "write each table's name qualified by its schema");
  }
  // a column qualified by its table's schema (`public.orders.id`, Metabase writes every column so) names the subquery by
  // its alias alone: sound only where no other item of the statement has the table's name
  const named = all.flatMap((n) => {
    const alias = (n.body.alias as Body | undefined)?.aliasname;
    if (n.kind === "RangeVar") return [typeof alias === "string" ? alias : n.body.relname as string];
    if (n.kind === "CommonTableExpr") return [n.body.ctename as string];
    return typeof alias === "string" && ["RangeSubselect", "RangeFunction", "RangeTableFunc", "JoinExpr"].includes(n.kind) ? [alias] : [];
  });
  await carryKeyDependency(catalog, tree, [...asFiltered].map(([i, table]) => ({ range: ranges[i]!.body, table })), analysis, new Map([...filteredRead].map(([oid, v]) => [v.table, oid])));
  const qualified = new Set<string>();
  const parsedOf = new Map<string, unknown>();
  const wall = wallName(tree);
  for (const [i, table] of asFiltered) {
    const r = ranges[i]!;
    let sub = parsedOf.get(table);
    if (sub === undefined) {
      const s = (await parseSql(filteredSql(table, filters, 1, wall))).stmts?.[0]?.stmt;
      if (s === undefined) throw new Error(`the filtered read of ${table} did not parse: report it`);
      parsedOf.set(table, s);
      sub = s;
    }
    if (r.body.alias === undefined) qualified.add(`${table.slice(0, table.indexOf("."))}.${r.body.relname as string}`);
    r.holder[r.key as never] = { RangeSubselect: { subquery: structuredClone(sub), alias: r.body.alias ?? { aliasname: r.body.relname } } } as never;
  }
  for (const c of all.filter((n) => n.kind === "ColumnRef")) {
    const fields = c.body.fields as unknown[];
    if (fields.length < 3) continue;
    const [schema, rel] = [sval(fields[fields.length - 3]), sval(fields[fields.length - 2])];
    if (schema === null || rel === null || !qualified.has(`${schema}.${rel}`)) continue;
    if (named.filter((n) => n === rel).length > 1) {
      throw refused(`Mason cannot yet answer a column qualified by its schema (${schema}.${rel}) beside another item named ${rel}, where its role filters ${rel}`, "give the table an alias, and qualify its columns by it");
    }
    c.body.fields = fields.slice(-2);
  }
  const text = deparseSync(tree as unknown as Node, { pretty: false });
  const back = (await parseSql(text)).stmts?.[0]?.stmt;
  const difference = back === undefined ? "nothing" : treeDifference(back, tree);
  if (difference !== null) {
    throw refused("Mason cannot answer this statement's filtered tables: the statement with their filters does not read back as itself (a Mason gap: report it, with the statement)", `read back: ${difference}`);
  }
  // every table whose filter the statement now reads: the filtered ones, and the parents they are read through
  const tables = new Set<string>();
  const reach = (t: string): void => { if (tables.has(t)) return; const f = filters.get(t); if (f === undefined) return; tables.add(t); if (f.through) reach(f.through.parent); };
  for (const t of found) reach(t);
  return { text, stmt: back as Node, walls: { alias: wall, reads: asFiltered.size }, tables: [...tables] };
}
