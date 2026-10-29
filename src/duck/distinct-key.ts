/**
 * A COUNT OF DISTINCT KEYS IS A COUNT (docs/DESIGN.md "A count of distinct keys"): a BI tool's "count of entities" is
 * `count(DISTINCT t.id)` with `id` the table's primary key, and DuckDB computes it as a hash aggregate of every id to
 * find the duplicates — over a 197 M-row table grouped by a joined dimension, a two-level hash aggregate that spilled
 * 1.5 GB and took 120 s, where `count(t.id)` took 9 s. Postgres's answer is the same for both when no two of the rows
 * counted can hold one value: the column is the table's KEY and the FROM cannot repeat a row of its table. So the
 * rewrite drops the DISTINCT there (src/duck/rewrite.ts `funcCall`), and only there; this module decides where, from
 * POSTGRES'S ANALYSIS of the statement and the CATALOG Postgres's own pg_index — never by a column's name:
 *
 * - THE KEY, AND ONLY THE PRIMARY KEY: a column that is, alone, the table's PRIMARY KEY in the catalog Postgres
 *   (src/api/postgres/catalog.ts declares the source's primary key, read valid at `mason start` and at `mason add` /
 *   `remove`; a table copied by a sources file's `key:` has none, src/cli/sources.ts `addedTables`) — the key the copy
 *   is WRITTEN by, so the copy never holds it twice (a write by key deletes before it inserts, a batch is folded per
 *   key, the swap checks as many distinct keys as rows). Never a UNIQUE index that is not the key, though the catalog
 *   declares those too: a column the copy is not written by may hold one value twice for a moment the source never
 *   showed (a large transaction applied in pieces, a row refetched as it is now), and the catalog's indexes are the
 *   source's as of the start (a unique constraint dropped since is still declared). A composite key's column is not a
 *   key. The equality is the key's btree family's `=` under its collation (the catalog declares the type's default
 *   opclass and collation, not the source index's: the same equality for a scalar column).
 * - NOT MULTIPLIED: the counted column's table is the FROM's one item, or joined (INNER, LEFT, RIGHT or FULL) only to
 *   base tables each on a conjunction holding an equality of the OTHER table's primary key with a column of the
 *   counted side: each row of that side then meets at most one row of the other, so it is in at most one row of the join
 *   (a row the join leaves unmatched is in exactly one, and a NULL-extended one counts no value). Any other conjunct only
 *   filters. A second FROM item (a comma join), a derived table, a CTE, a function (a LATERAL `jsonb_each`), a VALUES
 *   list, a join of joins on the other side, a condition with an OR at its top, or a key equality whose other side is
 *   an expression: the DISTINCT stays. WHERE, GROUP BY, HAVING and grouping sets only take rows away.
 *
 * Conservative by construction: what this cannot prove keeps its DISTINCT, which costs time; a DISTINCT dropped where
 * two rows hold one value costs an answer. The oracle holds every shape (tests/integration/oracle/bi-shapes.ts, the
 * type matrix's `keyed`), the plan fixture the plans (tests/duck-plans.test.ts), and tests/duck-distinct-key.test.ts
 * the decision.
 */
import type { TreeNode, TreeValue } from "./pgtree.ts";

/** pg_proc's count(any) */
const COUNT_ANY = 2147;
const RTE_RELATION = 0;
/** JoinType: INNER, LEFT, FULL, RIGHT (nodes.h); the planner's SEMI / ANTI never reach a parse tree */
const JOINS = new Set([0, 1, 2, 3]);

/** a column that is its table's primary key alone, as the catalog Postgres declares it: by `relid.attno` */
export interface UniqueColumn {
  /** the index's collation (0 for a type with none): an equality under another (a COLLATE in the statement) is not its */
  collation: number;
  /** the equality operators of the index's btree operator family (cross-type ones included: int4 = int8) */
  equalities: ReadonlySet<number>;
}
export type UniqueColumns = ReadonlyMap<string, UniqueColumn>;
export const columnKey = (relid: number, attno: number): string => `${relid}.${attno}`;

const isNode = (v: TreeValue | undefined): v is TreeNode => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);
const num = (v: TreeValue | undefined): number | null => typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null;
const list = (v: TreeValue | undefined): TreeValue[] => Array.isArray(v) ? v : [];

/** whether an AGGREF is a count(DISTINCT …) of one argument: the only aggregate this rewrite touches */
const isDistinctCount = (a: TreeNode): boolean => a._node === "AGGREF" && num(a.aggfnoid) === COUNT_ANY && list(a.aggdistinct).length === 1;

/**
 * The tables a statement's count(DISTINCT …) may be decided over: every base table of its queries, by the catalog's
 * OID, when it holds such a count at all (none: the plan asks the catalog nothing). Read before the decision, so the
 * catalog is asked once per statement planned.
 */
export function distinctCountTables(tree: TreeValue): number[] {
  let counts = false;
  const relids = new Set<number>();
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (!isNode(v)) return;
    if (isDistinctCount(v)) counts = true;
    if (v._node === "RANGETBLENTRY" && num(v.rtekind) === RTE_RELATION) { const r = num(v.relid); if (r !== null && r > 0) relids.add(r); }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return counts ? [...relids].sort((a, b) => a - b) : [];
}

/**
 * The catalog Postgres's single-column PRIMARY KEYS of `relids` (never another unique index: the module's doc), with
 * each one's collation and the equality operators of its btree family. A primary key is valid, unique and over a plain
 * column; the conditions are written out all the same, so the rule is this query's and not a reader's memory.
 */
export function uniqueColumnsSql(relids: readonly number[]): string {
  return "SELECT i.indrelid::text, i.indkey[0]::text, i.indcollation[0]::text, coalesce(string_agg(o.amopopr::text, ' ' ORDER BY o.amopopr), '') " +
    "FROM pg_index i JOIN pg_opclass c ON c.oid = i.indclass[0] JOIN pg_am m ON m.oid = c.opcmethod AND m.amname = 'btree' " +
    "LEFT JOIN pg_amop o ON o.amopfamily = c.opcfamily AND o.amopmethod = c.opcmethod AND o.amopstrategy = 3 " +
    `WHERE i.indrelid IN (${relids.map((r) => String(Math.trunc(r))).join(", ")}) AND i.indisprimary AND i.indisunique AND i.indisvalid AND i.indnatts = 1 AND i.indnkeyatts = 1 ` +
    "AND i.indkey[0] > 0 AND i.indpred IS NULL AND i.indexprs IS NULL GROUP BY 1, 2, 3";
}

/** `uniqueColumnsSql`'s rows, as the decision reads them (a table has one primary key; the merge is for a second row
 *  of one column, which no catalog writes) */
export function uniqueColumnsOf(rows: ReadonlyArray<ReadonlyArray<string | null>>): Map<string, UniqueColumn> {
  const out = new Map<string, UniqueColumn>();
  for (const [relid, attno, collation, ops] of rows) {
    const key = columnKey(Number(relid), Number(attno));
    const equalities = new Set((ops ?? "").split(" ").filter((x) => x !== "").map(Number));
    const had = out.get(key);
    // two rows for one column under two collations (none today): either's equality, under its own collation, is the key's;
    // kept as the first (the decision then asks that one's), which is conservative
    if (had === undefined) out.set(key, { collation: Number(collation ?? 0), equalities });
    else if (had.collation === Number(collation ?? 0)) out.set(key, { collation: had.collation, equalities: new Set([...had.equalities, ...equalities]) });
  }
  return out;
}

/** a VAR of this query's own FROM (varlevelsup 0), bare or under a binary-compatible relabel (a varchar read as text) */
function ownVar(v: TreeValue | undefined): TreeNode | null {
  if (!isNode(v)) return null;
  if (v._node === "RELABELTYPE") return ownVar(v.arg);
  return v._node === "VAR" && (num(v.varlevelsup) ?? 0) === 0 && (num(v.varattno) ?? 0) >= 1 ? v : null;
}

/** the rtindexes a join tree's node holds (its tables', and its joins' own: a USING join's column is the join's) */
function indexesOf(n: TreeNode): Set<number> {
  const out = new Set<number>();
  const visit = (v: TreeValue | undefined): void => {
    if (!isNode(v)) return;
    if (v._node === "RANGETBLREF") { const i = num(v.rtindex); if (i !== null) out.add(i); return; }
    if (v._node === "JOINEXPR") { const i = num(v.rtindex); if (i !== null) out.add(i); visit(v.larg); visit(v.rarg); }
  };
  visit(n);
  return out;
}

/** a conjunction's conjuncts (outfuncs.c writes BOOLEXPR's boolop as `and`, `or`, `not`), or the one condition */
function conjuncts(q: TreeValue | undefined): TreeNode[] {
  if (!isNode(q)) return [];
  if (q._node === "BOOLEXPR" && q.boolop === "and") return list(q.args).flatMap((a) => conjuncts(a));
  return [q];
}

/** the base table a FROM's RANGETBLREF names: its RANGETBLENTRY, when it is one (a relation, not a subquery, a CTE, a
 *  function, VALUES or a join) */
function baseTable(rtable: readonly TreeValue[], ref: TreeValue | undefined): { rtindex: number; relid: number } | null {
  if (!isNode(ref) || ref._node !== "RANGETBLREF") return null;
  const rtindex = num(ref.rtindex);
  const rte = rtindex === null ? undefined : rtable[rtindex - 1];
  if (!isNode(rte) || num(rte.rtekind) !== RTE_RELATION || rte.relkind !== "r") return null;
  const relid = num(rte.relid);
  return rtindex !== null && relid !== null && relid > 0 ? { rtindex, relid } : null;
}

/**
 * Whether a join's condition matches each row of its `side` with at most ONE row of `other`, a base table: a conjunct
 * that is an equality, by the operator of `other`'s single-column primary key and under its collation, of that
 * column (bare) with a column of `side` (bare).
 */
function atMostOne(quals: TreeValue | undefined, side: ReadonlySet<number>, other: { rtindex: number; relid: number }, unique: UniqueColumns): boolean {
  return conjuncts(quals).some((c) => {
    if (c._node !== "OPEXPR" || list(c.args).length !== 2) return false;
    const [a, b] = list(c.args).map(ownVar);
    if (a == null || b == null) return false;
    for (const [mine, theirs] of [[a, b], [b, a]] as const) {
      if (num(theirs.varno) !== other.rtindex || !side.has(num(mine.varno) ?? -1)) continue;
      const u = unique.get(columnKey(other.relid, num(theirs.varattno)!));
      const collation = num(c.inputcollid) ?? 0;
      if (u !== undefined && u.equalities.has(num(c.opno) ?? -1) && (collation === 0 || collation === u.collation)) return true;
    }
    return false;
  });
}

/**
 * Whether the FROM of `query` holds each row of the table at `rtindex` at most once: its one item, that table or a
 * join tree whose every join on the way down to it joins one base table on that table's primary key (`atMostOne`).
 */
export function notMultiplied(query: TreeNode, rtindex: number, unique: UniqueColumns): boolean {
  const jt = query.jointree;
  if (!isNode(jt)) return false;
  const from = list(jt.fromlist);
  if (from.length !== 1) return false;
  const rtable = list(query.rtable);
  const down = (n: TreeValue | undefined): boolean => {
    if (!isNode(n)) return false;
    if (n._node === "RANGETBLREF") return num(n.rtindex) === rtindex;
    if (n._node !== "JOINEXPR" || !JOINS.has(num(n.jointype) ?? -1) || !isNode(n.larg) || !isNode(n.rarg)) return false;
    const left = indexesOf(n.larg);
    const [side, otherRef] = left.has(rtindex) ? [n.larg, n.rarg] : indexesOf(n.rarg).has(rtindex) ? [n.rarg, n.larg] : [null, null];
    if (side === null) return false;
    const other = baseTable(rtable, otherRef);
    return other !== null && atMostOne(n.quals, indexesOf(side), other, unique) && down(side);
  };
  return down(from[0]);
}

/** Whether this AGGREF of `query` is a count(DISTINCT x) whose DISTINCT changes nothing (the module's doc). */
function distinctOfKey(query: TreeNode, a: TreeNode, unique: UniqueColumns): boolean {
  if (!isDistinctCount(a) || (num(a.agglevelsup) ?? 0) !== 0 || a.aggkind !== "n" || a.aggstar === "true" || list(a.aggorder).length > 0) return false;
  const args = list(a.args);
  const arg = args.length === 1 && isNode(args[0]) && args[0]._node === "TARGETENTRY" ? args[0].expr : undefined;
  // the column itself: a cast or an expression of it need not be unique (`id / 2`, `id::text` under another equality)
  if (!isNode(arg) || arg._node !== "VAR" || (num(arg.varlevelsup) ?? 0) !== 0) return false;
  const varno = num(arg.varno), attno = num(arg.varattno);
  if (varno === null || attno === null || attno < 1) return false;
  const table = baseTable(list(query.rtable), { _node: "RANGETBLREF", rtindex: String(varno) });
  if (table === null) return false;
  const u = unique.get(columnKey(table.relid, attno));
  const distinct = list(a.aggdistinct)[0];
  const collation = num(a.inputcollid) ?? 0;
  if (u === undefined || !isNode(distinct) || !u.equalities.has(num(distinct.eqop) ?? -1) || (collation !== 0 && collation !== u.collation)) return false;
  return notMultiplied(query, varno, unique);
}

/**
 * THE DECISION: the offsets (into the analysed text) of every count(DISTINCT x) of the statement whose DISTINCT may be
 * dropped — each AGGREF decided in the query it belongs to (an outer query's aggregate inside a subquery,
 * agglevelsup > 0, is left as it is).
 */
export function distinctKeyCounts(tree: TreeValue, unique: UniqueColumns): Set<number> {
  const out = new Set<number>();
  if (unique.size === 0) return out;
  const visit = (v: TreeValue | undefined, query: TreeNode | null): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x, query); return; }
    if (!isNode(v)) return;
    if (v._node === "QUERY") { for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x, v); return; }
    if (query !== null && v._node === "AGGREF" && distinctOfKey(query, v, unique)) {
      const at = num(v.location);
      if (at !== null && at >= 0) out.add(at);
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x, query);
  };
  visit(tree, null);
  return out;
}
