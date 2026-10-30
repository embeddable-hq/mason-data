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
import { gapRefusal, StatementError } from "../api/postgres/server.ts";
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
  const predicate = renderWhere(parts, (a) => {
    const v = valueOf(a);
    const type = types.get(a) ?? "text";
    return typeof v === "string" ? `CAST(${literal(v)} AS ${type})` : `CAST(ARRAY[${v.map(literal).join(", ")}]${v.length === 0 ? "::text[]" : ""} AS ${type})`;
  });
  const words = renderWhere(parts, (a) => { const v = valueOf(a); return typeof v === "string" ? shownValue(v) : shownList(v); }).replace(/\s+/g, " ").trim();
  return { table: f.table, predicate, words };
}

/** the attributes a role reads (its filters' `where:`s) that a user's values lack, each with the filter that reads it */
export function missingAttributes(filters: Iterable<RowFilter>, values: AttributeValues): Array<{ attr: string; at: string; where: string }> {
  const out: Array<{ attr: string; at: string; where: string }> = [];
  for (const f of filters) {
    if (f.where === undefined) continue;
    for (const a of whereAttributes(f.where.parts)) if (values[a] === undefined && !out.some((x) => x.attr === a)) out.push({ attr: a, at: `${f.at}.where`, where: f.where.text });
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

/** the filtered read of `table` as SQL: its rows the filter keeps, `through:` read through its parent's filtered read */
export function filteredSql(table: string, filters: ReadonlyMap<string, BoundFilter>, depth = 1): string {
  const f = filters.get(table);
  if (f === undefined) return `SELECT * FROM ${tableSql(table)}`;
  if (f.predicate !== undefined) return `SELECT * FROM ${tableSql(table)} WHERE (${f.predicate})`;
  const t = f.through!;
  const p = `__mason_parent${depth}`;
  return `SELECT * FROM ${tableSql(table)} WHERE EXISTS (SELECT 1 FROM (${filteredSql(t.parent, filters, depth + 1)}) AS ${p} WHERE ${p}.${quoteIdent(t.parentColumn)} = ${tableSql(table)}.${quoteIdent(t.column)})`;
}

/**
 * The statement with every read of a filtered table replaced by its filtered read, printed; null when it reads no
 * filtered table. Throws a StatementError (gap roles) where the replacement could read otherwise than Postgres's row
 * security: a filtered table's whole row (a subquery's is a record), a name both a WITH query and a filtered table, a
 * TABLESAMPLE of one, a column qualified by its schema beside another item of the table's name.
 */
export async function expandRowFilters(catalog: Catalog, stmt: Node, analysis: PgAnalysis, searchPathSql: string, filters: ReadonlyMap<string, BoundFilter>): Promise<{ text: string; stmt: Node; tables: string[] } | null> {
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
  const qualified = new Set<string>();
  const parsedOf = new Map<string, unknown>();
  for (const [i, table] of asFiltered) {
    const r = ranges[i]!;
    let sub = parsedOf.get(table);
    if (sub === undefined) {
      const s = (await parseSql(filteredSql(table, filters))).stmts?.[0]?.stmt;
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
  return { text, stmt: back as Node, tables: [...tables] };
}
