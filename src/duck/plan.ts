/**
 * ONE STATEMENT'S DUCKDB PLAN (docs/DESIGN.md "Postgres decides, DuckDB computes"): Postgres's analysis of
 * it (src/duck/analyze.ts) — its refusal, or its result's columns and its parameters' types — and the DuckDB SQL that
 * computes the same answer (src/duck/rewrite.ts), printed (pgsql-deparser) and read back to be sure it is the tree the
 * rewrite meant. The Postgres listener asks for a plan at Parse (and for each statement of a simple query), and keeps it
 * per text until the schema changes.
 */
import { deparseSync, QuoteUtils } from "pgsql-deparser";
import type { Node } from "libpg-query";
import { HELD_ROW_INPUT, HELD_TYPE_INPUT } from "../api/postgres/schema.ts";
import { heldName, heldType, isHeldArray } from "./held-types.ts";
import type { TreeValue } from "./pgtree.ts";
import { gapRefusal, StatementError, type DuckPlan } from "./statement.ts";
import { parseSql } from "../api/postgres/parser.ts";
import { analyze, catalogRows, readParameters } from "./analyze.ts";
import { argumentTypes, describeKeys, nameUserKeys, heldUses, nullTested, resolvedKeys } from "./resolved.ts";
import { expandViews, MAX_VIEW_DEPTH, viewRefused } from "./views.ts";
import { selectListAfterLimit } from "./late.ts";
import { tiesRanked } from "./ties.ts";
import { pgTyplen } from "./types.ts";
import type { CopyState } from "./sync.ts";
import { giveTurns, datumText, masonCalls, rewrite, treeDifference, Unrewritable, type DuckCollation, type EnumTypes, type RowColumn } from "./rewrite.ts";
import { exposes, hideKept, readKey, searchSchemas, type KeptLookup, type KeptRoutes } from "./kept-route.ts";
import { distinctCountTables, distinctKeyCounts, fanOutTables, groupedLimitTables, primaryKeysOf, uniqueColumnsOf, uniqueColumnsSql } from "./distinct-key.ts";
import type { PrimaryKeys } from "./distinct-key.ts";
import { enforceGrants, type RoleGrants } from "./grants.ts";
import { attributeRefused, expandRowFilters, wallStatistics, wallSwitch, type Walls } from "./row-filter.ts";
import type { PgAnalysis } from "./analyze.ts";

const JSON_OID = 114, JSONB_OID = 3802;

/** what the rewrite asks of the stored JSON paths (src/duck/kept-route.ts KeptLookup): the copied table and column of
 *  each json or jsonb column the statement reads from a table (Typed.relation), by the catalog's OIDs; null when it
 *  reads none */
async function keptLookup(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, types: ReadonlyMap<number, ReadonlyArray<{ type: number; relation?: { relid: number; attno: number } }>>,
  kept: KeptRoutes): Promise<KeptLookup | null> {
  const wanted = new Map<string, { relid: number; attno: number }>();
  for (const t of [...types.values()].flat()) if (t.relation !== undefined && (t.type === JSON_OID || t.type === JSONB_OID)) wanted.set(`${t.relation.relid}.${t.relation.attno}`, t.relation);
  if (wanted.size === 0) return null;
  const pairs = [...wanted.values()].map((r) => `(${Math.trunc(r.relid)}, ${Math.trunc(r.attno)})`).join(", ");
  const rows = await catalogRows(catalog, `SELECT c.oid::text, a.attnum::text, n.nspname, c.relname, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
    `JOIN pg_attribute a ON a.attrelid = c.oid WHERE (c.oid::int8, a.attnum::int8) IN (${pairs}) AND c.relkind = 'r' AND NOT a.attisdropped`);
  const at = new Map(rows.map(([relid, attno, schema, table, column]) => [`${relid}.${attno}`, { source: `${schema}.${table}`, column: column! }]));
  return { at: (relid, attno) => at.get(`${relid}.${attno}`) ?? null, ready: (read) => kept.ready(read) };
}

/** the count(DISTINCT x) of the statement that are count(x) (src/duck/distinct-key.ts), by their offsets into the
 *  analysed text: x unique by the CATALOG's own pg_index — the source's keys as the catalog declares them — read only
 *  for a statement that counts DISTINCT values at all */
async function distinctKeys(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, tree: PgAnalysis["tree"]): Promise<ReadonlySet<number>> {
  const relids = distinctCountTables(tree);
  if (relids.length === 0) return new Set();
  return distinctKeyCounts(tree, uniqueColumnsOf(await catalogRows(catalog, uniqueColumnsSql(relids))));
}

/** the primary keys that may prove a LIMIT with no ORDER BY's joins bounded, or a grouped LIMIT grouped by a whole key
 *  (src/duck/late.ts), read only for a statement that has one */
async function joinKeys(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, tree: PgAnalysis["tree"]): Promise<PrimaryKeys> {
  const relids = [...new Set([...fanOutTables(tree), ...groupedLimitTables(tree)])].sort((a, b) => a - b);
  return relids.length === 0 ? new Map() : primaryKeysOf(await catalogRows(catalog, uniqueColumnsSql(relids)));
}

/** which of `functions` the catalog says are volatile: asked only of a statement with a derived read the list after the
 *  limit may read twice (src/duck/late.ts) */
async function volatileFunctions(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, functions: number[]): Promise<Set<number>> {
  if (functions.length === 0) return new Set();
  const rows = await catalogRows(catalog, `SELECT oid::text FROM pg_proc WHERE provolatile = 'v' AND oid IN (${functions.map((f) => String(Math.trunc(f))).join(", ")})`);
  return new Set(rows.map(([oid]) => Number(oid)));
}

/**
 * DuckDB's keywords that Postgres's are not: a column named `at` (DuckDB's AT TIME ZONE) or `qualify` is an identifier
 * the deparser writes bare, as Postgres reads it, and DuckDB refuses as a syntax error. The deparser's one quoting
 * function (`QuoteUtils.quoteIdentifier`, its every bare identifier) also quotes these, read from DuckDB itself
 * (`duckdb_keywords()`, every category but the unreserved) by the store at the listener's start.
 */
const duckKeywords = new Set<string>();
const pgQuote = QuoteUtils.quoteIdentifier.bind(QuoteUtils);
export function quoteDuckKeywords(words: Iterable<string>): void {
  for (const w of words) duckKeywords.add(w.toLowerCase());
  QuoteUtils.quoteIdentifier = (ident: string): string => {
    const q = pgQuote(ident);
    return q === ident && duckKeywords.has(ident) ? `"${ident}"` : q;
  };
}

/** a search_path as SET writes it: each schema quoted (`"$user"` kept) */
const pathSql = (searchPath: string): string => searchPath.split(",").map((s) => s.trim()).filter((s) => s !== "")
  .map((s) => s.startsWith('"') ? s : `"${s.replaceAll('"', '""')}"`).join(", ") || "public";

declare const PLANNED: unique symbol;
/**
 * DuckDB SQL made from a statement Postgres analysed, by the rewrite, and read back as itself: the ONLY SQL a session's
 * DuckDB connection runs (src/duck/store.ts `run`). Made here alone (tests/conventions.test.ts): a statement's own text
 * never reaches DuckDB — an EXPLAIN that did ran the write under it (a review finding).
 *
 * It carries the Mason functions its tree calls (`functions`, src/duck/rewrite.ts masonCalls), which decide how the
 * executor cancels it (src/duck/store.ts "HOW A STATEMENT IS CANCELLED") and what an EXPLAIN lists: decided once, here,
 * from the tree, and never read off `text` again (a text match took every `SELECT *` over a copy with a
 * stored JSON path for a calling statement, and none of them could be timed out or cancelled).
 */
export interface PlannedSql {
  readonly text: string;
  /** the `__mason_*` functions it calls, sorted; none: it is interrupted and closed at once when cancelled */
  readonly functions: readonly string[];
  /**
   * a LEFT lateral of a list it leaves DuckDB's delimiter join that a row count on the wire would stream
   * (src/duck/rewrite.ts leftLateral, docs/DESIGN.md "A LEFT lateral of a list"): an Execute that sets one runs the
   * plan made again with that bound asserted (planDuck's `wireBound`), kept beside this one. Absent: no such lateral
   * (none, a LIMIT already bounds it, or an aggregate, a GROUP BY, a DISTINCT, a window or an ORDER BY reads every row)
   */
  readonly unboundedLateral?: true;
  /**
   * the exact cells DuckDB answers after Postgres's columns (src/duck/rewrite.ts `cellsAfter`, the statement's own
   * body's record); absent: none. The store holds DuckDB's width to Postgres's columns plus these, exactly
   */
  readonly cells?: number;
  readonly [PLANNED]: true;
}

/** whether the statement itself is FETCH … WITH TIES: Postgres's analysis says so (its QUERY's limitOption), never the
 *  rewrite's text */
function tiesQuery(tree: TreeValue): boolean {
  const top = Array.isArray(tree) ? tree[0] : tree;
  return typeof top === "object" && top !== null && !Array.isArray(top) && top._node === "QUERY" && String(top.limitOption) === "1";
}

/**
 * `verified`: what the oracle has held to Postgres (src/duck/verified.ts). A statement using anything else is REFUSED,
 * by name — never answered by a rewrite nobody checked. null only for the oracle itself, which records what it verifies.
 */
/**
 * A statement's parameter values as DuckDB must read them: what Postgres's input function made of each (readParameters,
 * src/duck/analyze.ts), written back in a form DuckDB reads to the same value. A value Postgres refuses is refused with
 * its error (`'1.5'` for a smallint: 22P02).
 */
export async function duckParameters(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, oids: readonly number[], values: readonly (string | null)[],
  timeZone: string): Promise<(string | null)[]> {
  const read = await readParameters(catalog, oids, values, timeZone);
  if ("refused" in read) {
    const f = read.refused;
    throw new StatementError({ code: f.C ?? "22P02", message: f.M ?? "invalid parameter value", ...(f.D ? { detail: f.D } : {}), ...(f.H ? { hint: f.H } : {}) }, "");
  }
  // a text[] value DuckDB's list cannot hold as Postgres read it: refused by name, as its literal is
  if ("gap" in read) {
    throw read.gap === "multidim-array"
      ? gapRefusal("multidim-array", `a multi-dimensional array as parameter $${read.parameter} is not supported by Mason`, "bind a one-dimensional array")
      : gapRefusal("array-lower-bound", `an array whose subscripts do not start at 1 as parameter $${read.parameter} is not supported by Mason`, "bind the array without its bounds ('{a,b}', not '[2:3]={a,b}')");
  }
  return values.map((v, i) => {
    const r = read.values[i];
    if (v === null || r === undefined || r === null) return v;
    if (/^-?infinity$/.test(r.text)) return r.text;
    const le = (n: bigint, bytes: number): number[] => Array.from({ length: bytes }, (_, k) => Number((BigInt.asUintN(bytes * 8, n) >> BigInt(8 * k)) & 255n));
    if (r.oid === 1082) return datumText(1082, le(BigInt(r.text), 4));
    if (r.oid === 1114 || r.oid === 1184) return datumText(r.oid, le(BigInt(r.text), 8));
    if (r.oid === 1186) { const [m, d, us] = r.text.split(" "); return `${m} months ${d} days ${us} microseconds`; }
    return r.text;
  });
}

/**
 * THE WAY OUT OF `relation "x" does not exist`, from the sync's copy state (`Sync.state`, the one reader: a
 * table added and still copying was told "mason add x copies it", which it already was). A table the catalog does not
 * hold is one of: added and waiting its turn, added and copying (how far), added and failed (why, and when it is tried
 * again), copied a moment ago (the catalog is rebuilt as each copy commits), or not added — the one `mason add` away.
 * `relation` is the name as Postgres wrote it: qualified, or bare, which matches an added table of that name (public's first).
 */
export function missingRelationHint(relation: string, copies: readonly CopyState[]): string {
  const matches = copies.filter((c) => c.source === relation || (!relation.includes(".") && c.source.endsWith(`.${relation}`)))
    .sort((a, b) => Number(b.source.startsWith("public.")) - Number(a.source.startsWith("public.")));
  const c = matches[0];
  const served = "it is served once its first sync commits; mason wait waits for it (mason status shows how far it is)";
  if (c === undefined) return `a table is in Mason once it is added: mason add ${relation} syncs it (mason tables lists the database's)`;
  switch (c.phase) {
    case "waiting": return `${c.source} is added and waits its turn to be synced: ${served}`;
    case "copying": {
      // the share is of the heap's PAGES read (`CopyProgressView.share`: exact, so it never moves backwards), the count
      // the rows the committed chunks and the ones reading have in; a copy can outrun the source's estimate (Postgres's
      // statistics lag the table) and then says so, never a share that fell to 0 (the same class as mason
      // wait's bar: a share derived from an estimate must never move backwards)
      const p = c.progress;
      const so = c.rowsSoFar === null || c.rowsSoFar === undefined ? null : c.rowsSoFar + (p?.rowsReading ?? 0), of = c.rowsEstimate ?? null;
      const share = p === undefined ? "" : `${Math.floor(p.share * 100)}% of its pages read, `;
      const how = so === null ? `${share}its rows are being read`
        : of === null || of <= 0 ? `${share}about ${so} rows so far`
        : so > of ? `${share}${so} rows so far, past the ~${of} estimated`
        : `${share}about ${so} of ~${of} rows so far${p === undefined ? `, ${Math.min(99, Math.floor((so / of) * 100))}%` : ""}`;
      return `${c.source} is added and being synced (${how}): ${served}`;
    }
    case "failed": return `${c.source} is added, but its first sync failed: ${c.error ?? "no reason recorded"}; mason logs says more`;
    case "copied": return `${c.source} was just synced and joins the catalog as it is rebuilt: run the statement again in a moment (if it stays missing, mason logs says why)`;
  }
}

/**
 * THE TREE AS TEXT, DuckDB's `COLUMNS(…)` (decidedByKey's star, the statistics wall) unquoted: it is an expression only so,
 * and the deparser quotes the keyword. Marked in the tree, never found in the printed text, where a literal or a name may
 * hold the same characters: each call printed under a name the text holds nowhere else (the count says so), then that name
 * replaced. No statement Postgres accepted calls a function "columns" (Postgres has none), and the read-back checks the text.
 */
function printed(tree: Node, statement: string): string {
  const calls: Array<{ String: { sval: string } }> = [];
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (typeof v !== "object" || v === null) return;
    const name = (v as { FuncCall?: { funcname?: Array<{ String?: { sval: string } }> } }).FuncCall?.funcname;
    if (name?.length === 1 && name[0]?.String?.sval === "columns") calls.push(name[0] as { String: { sval: string } });
    Object.values(v).forEach(collect);
  };
  collect(tree);
  if (calls.length === 0) return deparseSync(tree, { pretty: false });
  // a text holds a mark at most once per few characters; a count that never agrees is a call the deparser does not print
  const bound = deparseSync(tree, { pretty: false }).length;
  for (let i = 0; i <= bound; i++) {
    const mark = `__mason_columns_${i}`;
    for (const c of calls) c.String.sval = mark;
    const text = deparseSync(tree, { pretty: false });
    for (const c of calls) c.String.sval = "columns";
    if (text.split(`${mark}(`).length - 1 === calls.length) return text.replaceAll(`${mark}(`, "COLUMNS(");
  }
  throw new StatementError({ code: "0A000", message: "Mason cannot print this statement for the engine (a Mason gap: report it, with the statement)" }, statement);
}

/**
 * A CHAIN'S CHILD READS ITS PARENT'S SIDE TABLE (src/duck/generated.ts, issue 124 stage 2): on the finished tree, each
 * read of a table `relations` names is swapped for the table it maps to, in the same schema, under the name the statement
 * read it by (its alias, else the table's own), so every column the rewrite qualified still binds. A bare name is the
 * search path's first schema's (a generated table is planned under `public`), and a bare name a WITH in scope holds is a
 * CTE's, never swapped. Every table named must be met: a read left on the served table would read the old parent, so
 * one not met throws. The read-back below holds the swapped text to the tree, as any other.
 */
function swapRelations(tree: unknown, relations: ReadonlyMap<string, string>, schemas: readonly string[]): void {
  const met = new Set<string>();
  const walk = (v: unknown, ctes: ReadonlySet<string>): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x, ctes); return; }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    const r = o.RangeVar as { schemaname?: string; relname: string; alias?: { aliasname: string } } | undefined;
    if (r !== undefined) {
      if (r.schemaname === undefined && ctes.has(r.relname)) return;
      const key = `${r.schemaname ?? schemas[0] ?? "public"}.${r.relname}`;
      const to = relations.get(key);
      if (to !== undefined) { r.alias ??= { aliasname: r.relname }; r.relname = to; met.add(key); }
      return;
    }
    // a column by the table's schema-qualified name (`public.counts.tenant_id`, valid Postgres): the swapped table is
    // read under its own name as an alias, which binds no schema, so the column is named by that alias alone
    const fields = (o.ColumnRef as { fields?: unknown[] } | undefined)?.fields;
    if (fields !== undefined && fields.length >= 3) {
      const sval = (x: unknown): string | undefined => (x as { String?: { sval?: string } } | undefined)?.String?.sval;
      const schema = sval(fields[fields.length - 3]), table = sval(fields[fields.length - 2]);
      if (schema !== undefined && table !== undefined && relations.has(`${schema}.${table}`)) (o.ColumnRef as { fields: unknown[] }).fields = fields.slice(-2);
      return;
    }
    const list = (o.withClause as { ctes?: Array<{ CommonTableExpr?: { ctename?: string } }> } | undefined)?.ctes;
    const scope = list === undefined ? ctes : new Set([...ctes, ...list.map((c) => c.CommonTableExpr?.ctename ?? "")]);
    for (const x of Object.values(o)) walk(x, scope);
  };
  walk(tree, new Set());
  const missed = [...relations.keys()].filter((k) => !met.has(k));
  if (missed.length > 0) throw new Error(`a generated table's plan does not read ${missed.join(", ")} by a name it can swap (Mason bug: report it)`);
}

/** what a statement is planned from: `planDuck`'s one argument */
export interface PlanOptions {
  catalog: (bytes: Uint8Array) => Promise<Uint8Array>;
  text: string;
  stmt: Node;
  base: number;
  paramOids: readonly number[];
  searchPath: string;
  timeZone: string;
  collation: DuckCollation;
  verified: ReadonlyMap<string, string> | null;
  userTypes?: ReadonlyMap<string, number>;
  copies?: () => readonly CopyState[];
  depth?: number;
  kept?: KeptRoutes | null;
  wireBound?: boolean;
  grants?: RoleGrants | null | undefined;
  walls?: Walls | null;
  /** a generated table's run (src/duck/generated.ts): `schema.table` → the table read in its place, in the same schema */
  relations?: ReadonlyMap<string, string>;
}

/** The catalog declares a type the source made with nothing over it (`PgColumn.made`), so what its analysis says is not
 *  there (an `=`, an order, a field of a composite) the source may have: Mason's gap, never Postgres's refusal. */
async function madeTypeRefusal(catalog: Parameters<typeof catalogRows>[0], code: string | undefined, message: string | undefined, text: string): Promise<StatementError | null> {
  if (message === undefined || (code !== "42883" && code !== "42809" && code !== "42804" && code !== "42846")) return null;
  const types = (await catalogRows(catalog, `SELECT t.typname FROM pg_type t WHERE t.typinput::text LIKE '%${HELD_TYPE_INPUT}%'`)).map((r) => r[0]!);
  const name = types.find((t) => new RegExp(`\\b${t.replace(/[^\w]/g, ".")}\\b`).test(message));
  if (name === undefined || /^function /.test(message) && !/\(.*\)/.test(message)) return null;
  return gapRefusal("held-type-compare", `Mason cannot answer this over a column of the type ${name}: it holds the value's text, and has no operator of the type`,
    "read the value, or its text (x::text); compare, sort or take a field on the source's own columns", text);
}

/** the functions that read a held value's position, not its value: its type, a count, an array's shape and rows */
const HELD_READERS = new Set(["1619", "2147", "2803", "3179", "2176", "2091", "2092", "2331", "2334", "730", "2922"]);

/** What a statement does with a value the copy holds as its text that the text cannot answer as the type would: an
 *  operator but `=` and `<>` of a type whose equal values have one text, a function, a cast to another type. */
async function heldRefusal(catalog: Parameters<typeof catalogRows>[0], tree: TreeValue, text: string): Promise<StatementError | null> {
  const uses = heldUses(tree).filter((u) => !(u.kind === "function" && HELD_READERS.has(u.oid)));
  if (uses.length === 0) return null;
  const ops = uses.filter((u) => u.kind === "operator");
  const equality = new Set(ops.length === 0 ? [] : (await catalogRows(catalog, `SELECT oid::text FROM pg_operator WHERE oid IN (${ops.map((u) => Number(u.oid)).join(", ")}) AND oprname IN ('=', '<>')`)).map((r) => r[0]!));
  const bad = uses.find((u) => !(u.kind === "operator" && equality.has(u.oid) && heldType(u.type)?.textEqual === true && heldType(u.type)?.literal === true && !isHeldArray(u.type)));
  if (bad === undefined) return null;
  return gapRefusal("held-type-compare", `Mason cannot answer this over a value of the type ${heldName(bad.type)}: it holds the value's text, and this needs the type's own value`,
    "read the value, or its text (x::text); = and GROUP BY are answered where equal values have one text", text);
}

/** A statement's plan. `wireBound`: its rows are bounded by a row count an Execute sets on the wire, which its SQL
 *  does not say (src/duck/rewrite.ts markBounds; the listener asks for it where PlannedSql.unboundedLateral says so).
 *  `grants`: the session's role (src/duck/grants.ts), held after the analysis; null for a session with no role where
 *  roles exist (the plan still names its reads, for an Execute under a role given later); undefined with no roles at all.
 *  `walls`: `text` is the statement with its filtered reads in place (expandRowFilters), each of which the wall ends */
export async function planDuck(options: PlanOptions): Promise<DuckPlan> {
  const { catalog, text, stmt, base, paramOids, searchPath, timeZone, collation, verified, userTypes = new Map<string, number>(), copies = () => [],
    depth = 0, kept = null, wireBound = false, grants, walls = null, relations } = options;
  const started = performance.now();
  const analysis = await analyze(catalog, text, paramOids, pathSql(searchPath), timeZone);
  if ("refused" in analysis) {
    const f = analysis.refused;
    // a table the catalog does not hold: where its copy is, or the `mason add` away
    const missing = f.C === "42P01" ? /^relation "([^"]+)" does not exist$/.exec(f.M ?? "")?.[1] : undefined;
    // a generated table not built yet (src/duck/generated.ts): by name, and what it is doing
    const unbuilt = missing === undefined ? undefined : copies().find((c) => c.kept?.by === "generated" && c.phase !== "copied" && (c.source === missing || c.source === `public.${missing}`));
    if (unbuilt?.kept?.by === "generated") throw gapRefusal("generated-not-built", `the generated table ${unbuilt.source} is not built yet: ${unbuilt.kept.text}`, "mason status says how far it is", text);
    const hint = missing !== undefined ? missingRelationHint(missing, copies()) : f.H;
    const made = await madeTypeRefusal(catalog, f.C, f.M, text);
    if (made !== null) throw made;
    throw new StatementError({ code: f.C ?? "XX000", message: f.M ?? "Postgres refused the statement", ...(f.D ? { detail: f.D } : {}), ...(hint ? { hint } : {}),
      ...(f.P ? { position: Number(f.P) } : {}) }, text);
  }
  // A VIEW is answered as Postgres answers it, by its definition in its place (src/duck/views.ts): the statement so
  // written is planned from the start, its parameters typed as this one's were. Its errors are the expanded text's, so
  // they carry no position into this one
  const expanded = await expandViews(catalog, stmt, analysis, pathSql(searchPath));
  if (expanded !== null) {
    if (depth >= MAX_VIEW_DEPTH) throw viewRefused(`Mason cannot yet answer views read through more than ${MAX_VIEW_DEPTH} other views`, "read the tables the views read");
    try { return await planDuck({ ...options, text: expanded.text, stmt: expanded.stmt, base: 0, paramOids: analysis.params, depth: depth + 1 }); }
    catch (e) {
      if (!(e instanceof StatementError)) throw e;
      const { position: _p, ...fields } = e.fields;
      throw new StatementError(fields, text, e.gap);
    }
  }
  const held = await heldRefusal(catalog, analysis.tree, text);
  if (held !== null) throw held;
  // THE ROLE (src/duck/grants.ts): the tables and columns Postgres's analysis says the statement reads, held to the
  // session's role — after Postgres's own refusal and the views' expansion (the check sees the tables a view reads),
  // before the rewrite (a role's refusal before a Mason gap's). The reads stay on the plan: an Execute under a role
  // given or taken since the Parse is held to them again (src/api/postgres/server.ts)
  const reads = grants === undefined ? undefined : await enforceGrants(catalog, analysis.tree, grants);
  // THE ROLE'S ROWS (src/duck/row-filter.ts): every read of a table the role filters becomes its filtered read, and that
  // statement is planned from the start — analysed by Postgres, rewritten and verified as any other (one grammar), held
  // to nothing more (the grants were held above, on the statement as written: a filter may read a column the role
  // may not, as a policy may on Postgres). Its errors are the expanded text's, so they carry no position into this one
  if (grants?.rows !== undefined && grants.rows.size > 0) {
    const filtered = await expandRowFilters(catalog, stmt, analysis, pathSql(searchPath), grants.rows);
    if (filtered !== null) {
      let inner: DuckPlan;
      try { inner = await planDuck({ ...options, text: filtered.text, stmt: filtered.stmt, base: 0, paramOids: analysis.params, depth: depth + 1, grants: undefined, walls: filtered.walls }); }
      catch (e) {
        if (!(e instanceof StatementError)) throw e;
        // a data exception may be a bound value's, not the statement's: `--set tenant=abc` on an integer
        const bad = e.fields.code.startsWith("22") && e.gap === null ? await attributeRefused(catalog, grants.rows, filtered.tables) : null;
        if (bad !== null) {
          const user = JSON.stringify(grants.rowsUser ?? "");
          throw new StatementError({ code: "42501", message: `permission denied: the user ${user} has a value for the attribute ${bad.name} that is not of type ${bad.type}, which the role ${grants.name} filters rows by`,
            detail: `${bad.at} reads :${bad.name} as ${bad.type} (${bad.where}): ${bad.problem}`,
            hint: `mason user remove ${grants.rowsUser ?? "<user>"} && mason user add ${grants.rowsUser ?? "<user>"} --role ${grants.name} --set ${bad.name}=<a value of type ${bad.type}>` }, text);
        }
        // the statement as written passed this check above, so what fails it is the table being a subquery (carryKeyDependency)
        if (e.fields.code === "42803" || /could not identify an equality operator/.test(e.fields.message)) {
          throw gapRefusal("roles", `Mason cannot yet answer a GROUP BY of a key of a table its role filters here: ${e.fields.message}`,
            "name each column it reads in the GROUP BY, or read it in an aggregate", text);
        }
        const { position: _p, ...fields } = e.fields;
        throw new StatementError(fields, text, e.gap);
      }
      const rowFilters = filtered.tables.map((t) => ({ table: t, words: `filtered by the role ${grants.name}: ${grants.rows!.get(t)!.words}` }));
      return { ...inner, ...(reads !== undefined ? { reads } : {}), rowFilters };
    }
  }
  // the catalog's own OIDs for the types an extension made (citext): the rewrite knows a few by name, and the wire sends
  // the SOURCE's OID for them (`userTypes`, from the copy), never the catalog's
  let resolved = resolvedKeys(analysis.tree);
  const catalogTypes = new Map<number, string>();
  const enumLabels = new Map<number, string[]>(), enumArrays = new Map<number, number>();
  const enums: EnumTypes = { labels: enumLabels, arrays: enumArrays };
  const fields = analysis.fields === null ? null : analysis.fields.map((f) => ({ ...f }));
  // a table's row type (a whole row, `SELECT t FROM t`): its columns, which the rewrite writes the row from, and the
  // name the wire maps to the source's OID (`rowtype:<schema>.<table>`)
  const rowTypes = new Map<number, RowColumn[]>();
  const used = new Set([...analysis.types.values()].flat().map((t) => t.type).filter((o) => o >= 16384));
  if ([...resolved].some((k) => /\bu\d+/.test(k)) || fields?.some((f) => f.oid >= 16384) || used.size > 0) {
    for (const [oid, name] of await catalogRows(catalog, "SELECT oid::text, typname FROM pg_type WHERE oid >= 16384 AND typtype IN ('b', 'd', 'e')")) catalogTypes.set(Number(oid), name!);
    // an enum's labels in their declared order, by its OID and its array type's: DuckDB is handed each value as its ENUM
    for (const [oid, array, label] of await catalogRows(catalog, "SELECT t.oid::text, t.typarray::text, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid ORDER BY t.oid, e.enumsortorder")) {
      const labels = enumLabels.get(Number(oid)) ?? [];
      labels.push(label!);
      enumLabels.set(Number(oid), labels);
      if (Number(array) > 0) enumArrays.set(Number(array), Number(oid));
    }
    for (const [oid, name] of await catalogRows(catalog, "SELECT t.oid::text, 'rowtype:' || n.nspname || '.' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.oid >= 16384 AND t.typtype = 'c'")) {
      catalogTypes.set(Number(oid), name!);
      if (!used.has(Number(oid))) continue;
      const columns = await catalogRows(catalog, `SELECT a.attname, a.atttypid::text, a.atttypmod::text FROM pg_attribute a JOIN pg_type t ON t.typrelid = a.attrelid WHERE t.oid = ${Number(oid)} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
      rowTypes.set(Number(oid), columns.map(([n, type, typmod]) => ({ name: n!, type: Number(type), typmod: Number(typmod) })));
    }
    resolved = await nameUserKeys((sql) => catalogRows(catalog, sql), resolved);
    for (const f of fields ?? []) {
      const source = f.oid >= 16384 ? userTypes.get(catalogTypes.get(f.oid) ?? "") : undefined;
      if (source !== undefined) f.oid = source;
    }
  }
  let tree, cells, exact, clock, jsonReads, unboundedLateral;
  // a table's row the source has otherwise (copied in part: no source OID for it) is not the source's row
  const sourceRows = new Map([...rowTypes].filter(([oid]) => userTypes.has(catalogTypes.get(oid) ?? "")));
  // IS [NOT] NULL of a composite reads its fields (a row of NULLs IS NULL), which the copy's text does not
  if (used.size > 0) {
    const rows = await catalogRows(catalog, `SELECT oid::text FROM pg_type WHERE typinput::text LIKE '${HELD_ROW_INPUT}%'`);
    if (rows.length > 0 && nullTested(analysis.tree, new Set(rows.map((r) => Number(r[0]))))) {
      throw gapRefusal("held-type-compare", "IS [NOT] NULL of a composite column is not supported by Mason: it holds the value's text, and Postgres reads each of its fields",
        "read x::text, or the source's own columns", text);
    }
  }
  // the stored JSON paths the statement's JSON reads may be answered from (src/duck/kept-route.ts)
  const lookup = kept === null ? null : await keptLookup(catalog, analysis.types, kept);
  const keyCounts = await distinctKeys(catalog, analysis.tree);
  const analysed = performance.now();
  const rewritten = (l = lookup): ReturnType<typeof rewrite> => rewrite({ stmt: stmt as unknown as Record<string, Record<string, unknown>>, base, analysis, collation, userTypes: catalogTypes, rowTypes: sourceRows, timeZone, enums, kept: l, wireBound, keyCounts });
  try {
    ({ tree, cells, exact, clock, jsonReads, unboundedLateral } = rewritten());
    // the oracle's (`eager`): every read stored before the plan is made, and the plan made again over them
    if (kept?.keepNow != null && lookup !== null && jsonReads.some((r) => kept.ready(r) === null)) {
      await kept.keepNow(jsonReads);
      ({ tree, cells, exact, clock, jsonReads, unboundedLateral } = rewritten());
    }
    // a statement that lists a copy's columns without naming them reads none from a stored column (hideKept): made
    // again with every read its call, the reads still recorded
    if (lookup !== null && exposes(tree)) ({ tree, cells, exact, clock, jsonReads, unboundedLateral } = rewritten({ at: (relid, attno) => lookup.at(relid, attno), ready: () => null }));
  }
  catch (e) {
    // a gap says its id (docs/SQL-SUPPORT.md); Postgres's own refusal is its SQLSTATE, and no gap
    if (e instanceof Unrewritable) {
      throw typeof e.gap === "string" ? gapRefusal(e.gap, e.message, e.hint, text)
        : new StatementError({ code: e.gap.postgres, message: e.message, hint: e.hint }, text);
    }
    throw e;
  }
  // a statement that lists a copy's columns without naming them reads its visible ones (src/duck/kept-route.ts); before
  // the late select list, which then reads the columns this leaves
  if (kept !== null) hideKept(tree, { visible: kept.visible(), searchPath: searchSchemas(searchPath) });
  // a sorted, limited select list is computed over the rows the limit keeps (src/duck/late.ts)
  // (a role's walled read it fetches through itself is one more wall: counted, so `wallStatistics` still walls every one)
  const lateWall = walls !== null ? { alias: walls.alias, added: 0 } : null;
  tree = await selectListAfterLimit(tree as Record<string, unknown>, analysis.tree, () => joinKeys(catalog, analysis.tree),
    { volatile: (functions) => volatileFunctions(catalog, functions), wall: lateWall }) ?? tree;
  // every FETCH … WITH TIES late.ts did not rank on row numbers, ranked (src/duck/ties.ts)
  try { tiesRanked(tree as Record<string, unknown>); }
  catch (e) { throw new StatementError({ code: "XX000", message: (e as Error).message }, text); }
  // THE WIDTH DuckDB ANSWERS IS POSTGRES'S COLUMNS AND THE CELLS RECORDED AFTER THEM (src/duck/store.ts checks it): the
  // exact columns read the same cells, or the two have drifted
  if (exact.length > 0 && exact[0]!.cells.length !== cells) {
    throw new StatementError({ code: "XX000", message: `Mason's rewrite recorded ${cells} cell(s) after Postgres's columns where its exact columns read ${exact[0]!.cells.length}: report it, with the statement` }, text);
  }
  // ONLY WHAT THE ORACLE VERIFIED: after the rewrite, so a construct the rewrite refuses by name (with its own way out)
  // says so first
  const keys = [...resolved].sort();
  const unverified = verified === null ? [] : keys.filter((k) => !verified.has(k));
  if (unverified.length > 0) {
    const names = await describeKeys((sql) => catalogRows(catalog, sql), unverified);
    const listed = unverified.map((k) => names.get(k) ?? k);
    throw gapRefusal("unverified",
      `Mason cannot yet answer this statement exactly as Postgres would: it uses ${listed.slice(0, 5).join("; ")}${listed.length > 5 ? ` and ${listed.length - 5} more` : ""}, which Mason has not verified`,
      "write the statement without it (docs/SQL-SUPPORT.md lists what is verified), or report it: a statement Mason has not verified is refused rather than answered differently",
      text, `: ${unverified.join(", ")}`);
  }
  // only a statement with its filtered reads in place: no other statement's text changes, whatever it names its subqueries
  if (walls !== null && wallSwitch.statistics) wallStatistics(tree, { alias: walls.alias, reads: walls.reads + (lateWall?.added ?? 0) });
  // on the finished tree, so no rule above meets it; `masonCalls` below does not count it as a function called
  giveTurns(tree);
  if (relations !== undefined && relations.size > 0) swapRelations(tree, relations, searchSchemas(searchPath));
  const sql = printed(tree as Node, text);
  // THE PRINTED TEXT MUST READ BACK AS THE TREE: a printing gap (the deparser drops or respells something) would run
  // another statement than the one Postgres analysed — refused instead, by name
  const back = (await parseSql(sql)).stmts?.[0]?.stmt;
  const difference = back === undefined ? "nothing" : treeDifference(back, tree);
  if (difference !== null) {
    throw new StatementError({ code: "0A000", message: "Mason cannot run this statement exactly: its rewritten form does not read back as itself (a Mason gap: report it, with the statement)",
      detail: `read back: ${difference}; the rewritten SQL: ${sql}` }, text);
  }
  const planned = { text: sql, functions: masonCalls(tree), ...(unboundedLateral ? { unboundedLateral: true } : {}), ...(cells > 0 ? { cells } : {}) } as unknown as PlannedSql;
  return { sql: planned, params: analysis.params, fields: fields?.map((f) => ({ ...f, size: pgTyplen(f.oid) })) ?? null, ties: tiesQuery(analysis.tree), ...(exact.length > 0 ? { exact } : {}), resolved: keys, argumentTypes: argumentTypes(analysis.tree),
    ...(Object.keys(clock).length > 0 ? { clock } : {}), ...(jsonReads.length > 0 ? { jsonReads: jsonReads.map(readKey) } : {}), ...(reads !== undefined ? { reads } : {}),
    timing: { analysisMs: analysed - started, rewriteMs: performance.now() - analysed } };
}
