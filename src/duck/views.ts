/**
 * A SOURCE VIEW, ANSWERED OVER THE COPIED TABLES (the Metabase test of #517: "serve views"). DuckDB holds the tables a
 * view reads, never the view: its definition is Postgres SQL, which means what it means only through the rewrite, and
 * the rewrite depends on the session (its zone, the transaction's clock, the parameters). So a statement reading a view
 * is answered as Postgres itself answers it — its rewriter replaces the view's range-table entry with the view's query
 * — by replacing each reference with `(<definition>) AS <name>` and planning THAT statement from the start: Postgres
 * analyses it, the rewrite and the verification hold it as any other, and the result's columns are the view's.
 *
 * Postgres decides which names are views: the analysis's range table (`relkind v`), and every name the statement
 * writes is resolved by the catalog under the session's search_path. The two must agree, or nothing is expanded. The
 * definition is printed with every name outside pg_catalog qualified (`pg_get_viewdef` under a search_path of
 * pg_catalog alone), so it reads the same tables under the session's search_path. What the expanded statement could
 * read otherwise than the original is refused by name (gap `view-forms`): a view's whole row (a subquery's is a
 * record), a name both a WITH query and a view, a column qualified by its view's schema beside another item of the
 * view's name.
 */
import { deparseSync } from "pgsql-deparser";
import type { Node } from "libpg-query";
import { gapRefusal, type StatementError } from "../api/postgres/server.ts";
import { parseSql } from "../api/postgres/parser.ts";
import { catalogRows, type PgAnalysis } from "./analyze.ts";
import type { TreeValue } from "./pgtree.ts";
import { treeDifference } from "./rewrite.ts";

type Body = Record<string, unknown>;
type Catalog = (bytes: Uint8Array) => Promise<Uint8Array>;

/** views read through views read through views…: past this depth the statement is refused (a definition is never
 *  recursive, so only a deep stack of views reaches it) */
export const MAX_VIEW_DEPTH = 16;

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const sval = (n: unknown): string | null => isObject(n) && isObject(n.String) && typeof n.String.sval === "string" ? n.String.sval : null;

export function viewRefused(message: string, hint: string): StatementError {
  return gapRefusal("view-forms", message, hint);
}

/** the views Postgres's analysis read: every range-table entry of a relation whose kind is a view, by OID */
export function viewsRead(tree: TreeValue): Set<number> {
  const out = new Set<number>();
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === null || typeof v !== "object") return;
    if (v._node === "RANGETBLENTRY" && v.rtekind === "0" && v.relkind === "v" && typeof v.relid === "string") out.add(Number(v.relid));
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return out;
}

/** every `{ Kind: body }` node of the raw tree, with the object and key holding it (to be replaced in place) */
function nodes(root: unknown): Array<{ holder: Body | unknown[]; key: string | number; kind: string; body: Body }> {
  const out: Array<{ holder: Body | unknown[]; key: string | number; kind: string; body: Body }> = [];
  const visit = (holder: Body | unknown[], key: string | number, v: unknown): void => {
    if (Array.isArray(v)) { v.forEach((x, i) => visit(v, i, x)); return; }
    if (!isObject(v)) return;
    const keys = Object.keys(v);
    if (keys.length === 1 && /^[A-Z]/.test(keys[0]!) && isObject(v[keys[0]!])) out.push({ holder, key, kind: keys[0]!, body: v[keys[0]!] as Body });
    for (const k of keys) visit(v, k, v[k]);
  };
  visit({ root }, "root", root);
  return out;
}

/**
 * The statement with every view it reads replaced by its definition, printed; null when it reads no view. Throws a
 * StatementError (gap view-forms) where the replacement could read otherwise than Postgres does.
 */
export async function expandViews(catalog: Catalog, stmt: Node, analysis: PgAnalysis, searchPathSql: string): Promise<{ text: string; stmt: Node } | null> {
  const read = viewsRead(analysis.tree);
  if (read.size === 0) return null;
  const tree = structuredClone(stmt) as unknown as Body;
  const all = nodes(tree);
  const ranges = all.filter((n) => n.kind === "RangeVar");
  const ctes = new Set(all.filter((n) => n.kind === "CommonTableExpr").map((n) => n.body.ctename as string));
  // each name the statement writes, resolved as Postgres resolves it under the session's search_path
  const spelled = ranges.map((r) => [r.body.catalogname, r.body.schemaname, r.body.relname].filter((x): x is string => typeof x === "string").map(quote).join("."));
  const resolved = spelled.length === 0 ? [] : await catalogRows(catalog,
    `SET LOCAL search_path = ${searchPathSql}, pg_catalog; SELECT v.i::text, c.oid::text, n.nspname, c.reltype::text FROM (VALUES ${spelled.map((s, i) => `(${i}, ${literal(s)})`).join(", ")}) AS v(i, name) ` +
    `JOIN pg_class c ON c.oid = to_regclass(v.name) JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'v'`);
  const asView = new Map(resolved.map(([i, oid, schema, rowType]) => [Number(i), { oid: Number(oid), schema: schema!, rowType: Number(rowType) }]));
  // the names that are views must be the views Postgres read: a WITH query of a view's name is one or the other
  for (const [i] of asView) {
    if (ranges[i]!.body.schemaname === undefined && ctes.has(ranges[i]!.body.relname as string)) {
      throw viewRefused(`Mason cannot yet answer a statement whose WITH query is named as a view it reads (${ranges[i]!.body.relname as string})`, "rename the WITH query");
    }
  }
  const found = new Set([...asView.values()].map((v) => v.oid));
  if (found.size !== read.size || [...read].some((o) => !found.has(o))) {
    throw viewRefused("Mason could not tell which of the statement's names are the views Postgres read (a Mason gap: report it, with the statement)", "write each view's name qualified by its schema");
  }
  // a view's whole row is the view's row type; a subquery's is a record
  const rowTypes = new Set([...asView.values()].map((v) => v.rowType));
  if ([...analysis.types.values()].flat().some((t) => rowTypes.has(t.type))) {
    throw viewRefused("Mason cannot yet answer a view's whole row as a value", "name the view's columns, or write view.*");
  }
  const definitions = new Map((await catalogRows(catalog,
    `SET LOCAL search_path = pg_catalog; SELECT c.oid::text, pg_get_viewdef(c.oid) FROM pg_class c WHERE c.oid IN (${[...found].join(", ")})`))
    .map(([oid, def]) => [Number(oid), def!]));
  const parsed = new Map<number, unknown>();
  for (const [oid, def] of definitions) {
    const s = (await parseSql(def)).stmts?.[0]?.stmt;
    if (s === undefined) throw new Error(`the catalog's definition of view ${oid} did not parse: report it`);
    parsed.set(oid, s);
  }
  // a column qualified by its view's schema (`public.v.id`, Metabase writes every column so) names the subquery by its
  // alias alone: sound only where no other item of the statement has the view's name
  const named = all.flatMap((n) => {
    const alias = (n.body.alias as Body | undefined)?.aliasname;
    if (n.kind === "RangeVar") return [typeof alias === "string" ? alias : n.body.relname as string];
    if (n.kind === "CommonTableExpr") return [n.body.ctename as string];
    return typeof alias === "string" && ["RangeSubselect", "RangeFunction", "RangeTableFunc", "JoinExpr"].includes(n.kind) ? [alias] : [];
  });
  const qualified = new Map<string, number>();
  for (const [i, v] of asView) {
    const r = ranges[i]!;
    if (r.body.alias === undefined) qualified.set(`${v.schema}.${r.body.relname as string}`, i);
    r.holder[r.key as never] = { RangeSubselect: { subquery: structuredClone(parsed.get(v.oid)), alias: r.body.alias ?? { aliasname: r.body.relname } } } as never;
  }
  for (const c of all.filter((n) => n.kind === "ColumnRef")) {
    const fields = c.body.fields as unknown[];
    if (fields.length < 3) continue;
    const [schema, rel] = [sval(fields[fields.length - 3]), sval(fields[fields.length - 2])];
    if (schema === null || rel === null || !qualified.has(`${schema}.${rel}`)) continue;
    if (named.filter((n) => n === rel).length > 1) {
      throw viewRefused(`Mason cannot yet answer a column qualified by its view's schema (${schema}.${rel}) beside another item named ${rel}`, `give the view an alias, and qualify its columns by it`);
    }
    c.body.fields = fields.slice(-2);
  }
  // THE PRINTED TEXT MUST READ BACK AS THE TREE, as the rewrite's (src/duck/plan.ts)
  const text = deparseSync(tree as unknown as Node, { pretty: false });
  const back = (await parseSql(text)).stmts?.[0]?.stmt;
  const difference = back === undefined ? "nothing" : treeDifference(back, tree);
  if (difference !== null) {
    throw viewRefused("Mason cannot answer this statement's views: the statement with their definitions does not read back as itself (a Mason gap: report it, with the statement)", `read back: ${difference}`);
  }
  return { text, stmt: back as Node };
}
