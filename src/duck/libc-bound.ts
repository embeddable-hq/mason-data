/**
 * THE LIBC KEY FOR THE CANDIDATES ALONE (issue 666: `min(s), max(s)` of a text under the database's en_US.utf8 took 13.7 s
 * over 0.9 M rows where Postgres took 0.33 s, and `ORDER BY s LIMIT 50` over 93 M rows timed out at 300 s). A text's
 * order under a libc collation is its key (src/duck/libc-order.ts `libcKey`), computed in JavaScript, one call a row, on
 * the executor's one thread (~2 µs a row with its wide key sorted). A top N and a min or max need it for a FEW rows
 * only: so each row first gets two NATIVE bounds of its key, and the JavaScript key is computed for the rows the bounds
 * cannot rule out. Postgres's abbreviated keys, made exact by bounds.
 *
 * THE BOUNDS. Of a text s, `lo(s)` and `hi(s)` are texts, compared by their bytes, built by the engine alone
 * (`strlen`, `regexp_full_match`, `regexp_extract`, `lower`, `regexp_replace`, `||`: ~0.05 µs a row, parallel; `translate` was 1 µs), from the order
 * READ FROM THE SOURCE for that collcollate (`LibcOrder`, never a hand-written table): the first-level weights of s's
 * leading run of MAPPED characters (`boundOf`: printable ASCII whose first level the order says without context:
 * covered, one weight or none, no sequence, no contraction that a mapped character could complete), at most
 * `BOUND_CHARS + 1` characters, each weight written as the run's character folded to lower case (the order must say
 * that two characters of one weight fold to one, and that the folded characters' bytes order as their weights do:
 * en_US's `$` < digits < letters, A = a; an order that does not has no bounds), a character of no first-level weight
 * (a space, most punctuation) dropped. Then, with `L` < `E` < every character written < `H` (control characters):
 *  - s whole in the run: its weights then `E` (the level ends there), then `L` in lo and `H` in hi;
 *  - else (an unmapped character, the run's length reached): its weights so far, then `L` in lo and `H` in hi.
 * The marks are written AFTER the weights, never read from s: whether s ended in the run is decided from s itself (at
 * most `BOUND_CHARS` bytes, every one mapped), so a value holding chr(1), chr(2) or chr(127), which glibc ignores at the
 * first three levels and no run holds, cannot pass for a mark (review r1 of PR 675: `E` appended to s and matched as
 * the end of the text took a U+0002 inside it for the end, and `ab` U+0002 `cd` sorted before `abc`).
 * Case is folded only within the run: the engine's `lower()` maps U+212A KELVIN SIGN to `k`, which no run holds.
 * A contraction's first character (`l` of `l·`) ends a run before an unmapped character: its weight there is not known.
 * THE PROOF OBLIGATION: hi(a) < lo(b) implies libcKey(a) < libcKey(b) at the first level, strictly; lo(s) <= hi(s);
 * equal strings have equal bounds (tests/duck-libc-order.test.ts and tests/integration/duck-libc-read.itest.ts hold it
 * over the engine's own expressions). Why it holds: the run's weights are a prefix W' of s's first level W; s whole in
 * the run, W is W' (and `E`, below every code, ends it as a shorter level sorts first); else W is W' and some
 * continuation, which `L` and `H` bracket. Each case of two such sets ordered by the bytes of hi and lo is ordered at W.
 *
 * THE TOP N (`ORDER BY x … LIMIT n [OFFSET m]`, x's first key under a libc order): T is the (n + m)-th smallest hi(x)
 * over the statement's own rows; a row with lo(x) > T has n + m rows strictly before it, so the rows kept are those
 * with x NULL or lo(x) <= T, and the existing sort and LIMIT run over them unchanged (DESC: the (n + m)-th largest lo,
 * hi(x) >= T). MIN / MAX (`arg_min` / `arg_max` over the key, src/duck/rewrite.ts `textMinMax`), ungrouped: T is
 * min(hi(x)) (max: max(lo(x))) over the same rows, and the key's CASE takes only the rows lo(x) <= T (hi(x) >= T): the
 * engine evaluates a CASE's branch on its selected rows alone, so the key is computed for those.
 *
 * THE THRESHOLD READS EXACTLY THE ROWS THE STATEMENT READS: its subquery is the SELECT's own FROM item and WHERE, cloned
 * (a role's walled read included, counted as one more wall). That is the same rows only where reading them twice reads
 * the same rows, which this decides from Postgres's analysis and the rewritten tree, never a guess: nothing volatile in
 * the statement (pg_proc's provolatile, `functionsCalled`), no window function or set-returning select list anywhere,
 * no aggregate but the min/max's own query (a top N: none), one FROM item, and no LIMIT, OFFSET, DISTINCT ON or sample
 * inside what is cloned but a role's barrier (src/duck/row-filter.ts `BARRIER`), which every row passes. Anything else
 * stays as written: a join, a set operation, a window's ORDER BY, WITH TIES, GROUP BY and DISTINCT, a FILTER'd or
 * grouped min, a LIMIT that is not a constant.
 *
 * WHAT CHANGES BESIDE THE TIME: a value the bounds rule out is never keyed, so under a locale whose order leaves a
 * character uncovered (`libc-uncovered`), a value holding it that is outside the top N no longer refuses the statement;
 * a candidate holding one still does.
 */
import type { LibcOrder } from "./libc-order.ts";
import { functionsCalled, type TreeNode, type TreeValue } from "./pgtree.ts";
import { BARRIER } from "./row-filter.ts";

type Body = Record<string, unknown>;
type AstNode = Record<string, unknown>;

/** the run's length in characters: the longest shared prefix a column's values can have and still be told apart by
 *  their bounds (a URL's `https://example.com/item/` is 25), measured (docs/DESIGN.md "The libc key for the candidates
 *  alone"); a longer one costs each row's bounds more and saves little */
export const BOUND_CHARS = 48;
/** the characters a run may hold: printable ASCII (no control character, so `E`, `L` and `H` are none of them) */
const FIRST = 0x20, LAST = 0x7e;
/** `L` below `E` below every character a run writes, below `H` */
const L = 1, E = 2, H = 0x7f;

const S = (sval: string): AstNode => ({ String: { sval } });
const str = (s: string): AstNode => ({ A_Const: { sval: { sval: s } } });
const int = (n: number): AstNode => ({ A_Const: { ival: n === 0 ? {} : { ival: n } } });
const call = (name: string, args: AstNode[]): AstNode => ({ FuncCall: { funcname: [S(name)], args, funcformat: "COERCE_EXPLICIT_CALL" } });
const op = (name: string, l: AstNode, r: AstNode): AstNode => ({ A_Expr: { kind: "AEXPR_OP", name: [S(name)], lexpr: l, rexpr: r } });
/** an AND of `args`, one AND's own arguments in place, as Postgres's grammar reads `(a AND b) AND c` back */
const and = (args: AstNode[]): AstNode => {
  const flat = args.flatMap((a) => isNodeOf(a, "BoolExpr") && bodyOf(a).boolop === "AND_EXPR" ? bodyOf(a).args as AstNode[] : [a]);
  return flat.length === 1 ? flat[0]! : { BoolExpr: { boolop: "AND_EXPR", args: flat } };
};
const nullTest = (arg: AstNode, type: "IS_NULL" | "IS_NOT_NULL"): AstNode => ({ NullTest: { arg, nulltesttype: type } });
const chr = (code: number): AstNode => call("chr", [int(code)]);

/** what a libc order's bounds are written from: the run's pattern, the pattern of a text whole in the run (every
 *  character mapped), and the pattern of its characters of no first-level weight (null: none) */
export interface Bound { run: string; whole: string; dropped: string | null }

/** a character class of code points, as RE2 reads it: each as `\x{…}`, runs as ranges */
function charClass(points: readonly number[]): string {
  const sorted = [...points].sort((a, b) => a - b);
  let out = "";
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const hex = (g: number): string => `\\x{${g.toString(16)}}`;
    out += i === j ? hex(sorted[i]!) : `${hex(sorted[i]!)}-${hex(sorted[j]!)}`;
    i = j + 1;
  }
  return `[${out}]`;
}

/** the engine's `lower()` of a printable ASCII character (tests/duck-libc-order.test.ts runs the engine's own) */
const folded = (g: number): number => g >= 0x41 && g <= 0x5a ? g + 32 : g;

const BOUNDS = new WeakMap<LibcOrder, Bound | null>();

/**
 * The order's bounds, as the module's header says, or null where it has none to give: an order not followed (every
 * value refused, `libc-locale-unread`), byte order, no character mapped, or mapped characters whose weights their
 * folded bytes do not order.
 */
export function boundOf(o: LibcOrder): Bound | null {
  const known = BOUNDS.get(o);
  if (known !== undefined) return known;
  let bound: Bound | null = null;
  if (!o.unread && !o.bytes) {
    // a character whose first level is its own: covered, listed, no sequence of weights
    const mapped = new Set<number>();
    for (let g = FIRST; g <= LAST; g++) if (o.uncovered[g] === 0 && o.unlisted[g] === 0 && !o.sequences.has(g)) mapped.add(g);
    // a contraction a mapped character could complete makes its first character's weight depend on what follows: not mapped
    for (const g of [...mapped]) if ((o.contractions.get(g) ?? []).some((c) => c.rest.length > 0 && mapped.has(c.rest[0]!))) mapped.delete(g);
    // (the rest begin a contraction only before an unmapped character: known where a mapped one follows, or the text ends)
    const plain = [...mapped].filter((g) => !o.contractions.has(g));
    const weighted = [...mapped].filter((g) => o.l1[g]! > 0), dropped = [...mapped].filter((g) => o.l1[g] === 0);
    // each weighted character folds to a mapped one of its weight, and the folded ones' bytes order as their weights,
    // strictly: one weight, one character written
    const written = [...new Set(weighted.map(folded))].sort((a, b) => a - b);
    const ordered = weighted.every((g) => mapped.has(folded(g)) && o.l1[folded(g)] === o.l1[g])
      && written.every((g, i) => i === 0 || o.l1[written[i - 1]!]! < o.l1[g]!);
    if (plain.length > 0 && written.length > 0 && ordered) {
      bound = {
        // the longest run of mapped characters ending in one whose weight is known there; and the whole text mapped
        run: `^${charClass([...mapped])}*${charClass(plain)}`,
        whole: `${charClass([...mapped])}*`,
        dropped: dropped.length === 0 ? null : charClass(dropped),
      };
    }
  }
  BOUNDS.set(o, bound);
  return bound;
}

/** the run's weights of `x`, ending in `E` where x ended in the run: x of at most `BOUND_CHARS` bytes, each a mapped
 *  character (a mapped one is one byte), is whole in it; otherwise the run is the longest prefix of x's first
 *  `BOUND_CHARS + 1` characters ending in a plain one. No mark is ever read from x */
function weightsOf(b: Bound, x: AstNode): AstNode {
  const head = (): AstNode => call("left", [structuredClone(x), int(BOUND_CHARS + 1)]);
  const whole = and([op("<=", call("strlen", [structuredClone(x)]), int(BOUND_CHARS)), call("regexp_full_match", [head(), str(b.whole)])]);
  const run = call("lower", [{ CaseExpr: { args: [{ CaseWhen: { expr: whole, result: op("||", structuredClone(x), chr(E)) } }],
    defresult: call("regexp_extract", [head(), str(b.run)]) } }]);
  return b.dropped === null ? run : call("regexp_replace", [run, str(b.dropped), str(""), str("g")]);
}
/** `lo(x)` and `hi(x)` (the module's header), each its own copy of `x` */
export const lowBound = (b: Bound, x: AstNode): AstNode => op("||", weightsOf(b, structuredClone(x)), chr(L));
export const highBound = (b: Bound, x: AstNode): AstNode => op("||", weightsOf(b, structuredClone(x)), chr(H));

// ------------------------------------------------------------------------------------------------ the statement

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);
const kindOf = (n: unknown): string | null => isObject(n) ? Object.keys(n)[0] ?? null : null;
const bodyOf = (n: unknown): Body => (n as Record<string, Body>)[kindOf(n)!]!;
const isNodeOf = (n: unknown, kind: string): boolean => kindOf(n) === kind && isObject(bodyOf(n));
const nameOf = (list: unknown): string => Array.isArray(list) ? list.map((x) => String(bodyOf(x).sval ?? "")).join(".") : "";
const present = (v: unknown): boolean => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0);
/** an integer constant, or null (a 0 is `ival: {}`) */
const constInt = (n: unknown): number | null => {
  if (!isNodeOf(n, "A_Const")) return null;
  const v = bodyOf(n).ival;
  return isObject(v) ? Number(v.ival ?? 0) : null;
};

/** a libc key the rewrite wrote (`__mason_libc_key(<session>, x, '<collate>')`): x and the collcollate, or null */
function libcKeyOf(n: unknown): { x: AstNode; collate: string } | null {
  if (!isNodeOf(n, "FuncCall") || nameOf(bodyOf(n).funcname) !== "__mason_libc_key") return null;
  const args = bodyOf(n).args as AstNode[] | undefined;
  const collate = args?.at(-1), x = args?.at(-2);
  if (x === undefined || !isNodeOf(collate, "A_Const") || !isObject(bodyOf(collate!).sval)) return null;
  return { x, collate: String((bodyOf(collate!).sval as Body).sval ?? "") };
}

/** every SELECT body inside `v`, at any depth (a subquery's, a derived table's, a WITH query's) */
function selectsIn(v: unknown, out: Body[] = []): Body[] {
  if (Array.isArray(v)) { for (const x of v) selectsIn(x, out); return out; }
  if (!isObject(v)) return out;
  if (isNodeOf(v, "SelectStmt")) out.push(bodyOf(v));
  for (const x of Object.values(v)) selectsIn(x, out);
  return out;
}

/** `v` holds a node of one of `kinds` */
function holds(v: unknown, kinds: ReadonlySet<string>): boolean {
  if (Array.isArray(v)) return v.some((x) => holds(x, kinds));
  if (!isObject(v)) return false;
  const k = kindOf(v);
  if (k !== null && kinds.has(k) && isObject(v[k])) return true;
  return Object.values(v).some((x) => holds(x, kinds));
}

/** a role's barrier (src/duck/row-filter.ts `BARRIER`): a LIMIT every row passes */
const BARRIER_COUNT = /\d+/.exec(BARRIER)![0];
const isBarrier = (s: Body): boolean => {
  const c = s.limitCount;
  return isNodeOf(c, "A_Const") && String((bodyOf(c).fval as Body | undefined)?.fval ?? (bodyOf(c).ival as Body | undefined)?.ival ?? "") === BARRIER_COUNT && (s.limitOffset === undefined || constInt(s.limitOffset) === 0);
};

/** what is cloned reads the same rows twice: no LIMIT or OFFSET but a barrier, no DISTINCT ON, no sample, in any SELECT
 *  inside it (nothing volatile, no window and no set-returning list in the statement: `statementReads`) */
function readsAlike(v: unknown): boolean {
  if (holds(v, new Set(["RangeTableSample"]))) return false;
  return selectsIn(v).every((s) => ((s.limitCount === undefined && s.limitOffset === undefined) || isBarrier(s))
    && !(Array.isArray(s.distinctClause) && s.distinctClause.some((d) => kindOf(d) !== null)));
}

/** the WITH queries of the statement, by name (any depth: a name read in FROM may be any of them) */
function withQueries(tree: unknown): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>();
  for (const s of selectsIn(tree)) {
    for (const c of ((s.withClause as Body | undefined)?.ctes ?? []) as unknown[]) {
      if (!isNodeOf(c, "CommonTableExpr")) continue;
      const b = bodyOf(c);
      out.set(String(b.ctename), [...out.get(String(b.ctename)) ?? [], b.ctequery]);
    }
  }
  return out;
}

/** the one FROM item of a SELECT that may be read twice: a table, a derived table, a WITH query, as `readsAlike` says */
function oneItem(s: Body, ctes: Map<string, unknown[]>): AstNode | null {
  const from = s.fromClause as unknown[] | undefined;
  if (from?.length !== 1) return null;
  const item = from[0] as AstNode;
  if (isNodeOf(item, "RangeVar")) {
    const b = bodyOf(item);
    const named = b.schemaname === undefined ? ctes.get(String(b.relname)) : undefined;
    return named === undefined || named.every(readsAlike) ? item : null;
  }
  if (isNodeOf(item, "RangeSubselect") && bodyOf(item).lateral !== true && readsAlike(item)) return item;
  return null;
}

/** Postgres's analysis of the statement: whether its rows are read alike twice, and where an aggregate may stand */
interface Reads { aggregates: number; windowsOrSets: boolean }
function statementReads(tree: TreeValue): Reads {
  let aggregates = 0, windowsOrSets = false;
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (v === null || v === undefined || typeof v !== "object") return;
    const n = v as TreeNode;
    if (n._node === "QUERY") {
      if (n.hasAggs !== "false") aggregates++;
      if (n.hasWindowFuncs !== "false" || n.hasTargetSRFs !== "false") windowsOrSets = true;
    }
    for (const [k, x] of Object.entries(n)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return { aggregates, windowsOrSets };
}

/** a SELECT that is no set operation, lock or INTO, and whose list holds no window */
const plainSelect = (s: Body): boolean => (s.op === undefined || s.op === "SETOP_NONE") && !present(s.windowClause) && !present(s.lockingClause)
  && !present(s.intoClause) && !present(s.valuesLists) && !windowed(s.targetList);
/** a call OVER a window in `v`, outside its subqueries */
function windowed(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(windowed);
  if (!isObject(v) || isNodeOf(v, "SubLink")) return false;
  if (isNodeOf(v, "FuncCall") && bodyOf(v).over !== undefined) return true;
  return Object.values(v).some(windowed);
}

/** the threshold's subquery over the SELECT's own rows: `SELECT <aggregate> FROM (SELECT <value> AS __mason_bound FROM
 *  <its FROM item> WHERE <its WHERE> AND x IS NOT NULL [ORDER BY 1 [DESC] LIMIT n]) AS __mason_bounds`; a top N's is its
 *  `everyRow` where fewer than n rows have a value (`CASE WHEN count(*) >= n THEN … ELSE <everyRow> END`) */
function threshold(s: Body, item: AstNode, x: AstNode, value: AstNode, aggregate: "min" | "max", top: { desc: boolean; n: number; everyRow: AstNode } | null): AstNode {
  const where = and([...(s.whereClause !== undefined ? [structuredClone(s.whereClause as AstNode)] : []), nullTest(structuredClone(x), "IS_NOT_NULL")]);
  const inner: Body = {
    targetList: [{ ResTarget: { name: "__mason_bound", val: value } }],
    fromClause: [structuredClone(item)], whereClause: where,
    ...(top === null ? {} : {
      sortClause: [{ SortBy: { node: int(1), sortby_dir: top.desc ? "SORTBY_DESC" : "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }],
      limitCount: int(top.n), limitOption: "LIMIT_OPTION_COUNT",
    }),
    op: "SETOP_NONE",
  };
  const outer: Body = {
    targetList: [{ ResTarget: { val: ((v: AstNode): AstNode => top === null ? v : { CaseExpr: {
      args: [{ CaseWhen: { expr: op(">=", { FuncCall: { funcname: [S("count")], agg_star: true, funcformat: "COERCE_EXPLICIT_CALL" } }, int(top.n)), result: v } }], defresult: top.everyRow } })(
      call(aggregate, [{ ColumnRef: { fields: [S("__mason_bounds"), S("__mason_bound")] } }])) } }],
    fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: "__mason_bounds" } } }],
    op: "SETOP_NONE",
  };
  return { SubLink: { subLinkType: "EXPR_SUBLINK", subselect: { SelectStmt: outer } } };
}

/** what the plan knows beside the tree: each collcollate's order, which functions are volatile, a role's walls */
export interface BoundContext {
  order: (collate: string) => LibcOrder | undefined;
  volatile: (functions: number[]) => Promise<ReadonlySet<number>>;
  /** a role's walled reads (src/duck/row-filter.ts `wallStatistics`): each cloned one counted */
  wall: { alias: string; added: number } | null;
}

/** a role's walled reads in `v`: each `SELECT * FROM (… LIMIT <barrier>) AS <wall>` */
const wallsIn = (v: unknown, alias: string): number => selectsIn(v).filter((s) => {
  const from = s.fromClause as unknown[] | undefined;
  return from?.length === 1 && isNodeOf(from[0], "RangeSubselect") && (bodyOf(from[0]).alias as Body | undefined)?.aliasname === alias;
}).length;

/**
 * The statement with each top N and each ungrouped min / max under a libc order keyed for its candidates alone (the
 * module's header), or null where none is. `tree` is the rewrite's DuckDB tree (after src/duck/late.ts), `analysis`
 * Postgres's of the statement it was written from.
 */
export async function libcBounded(tree: AstNode, analysis: TreeValue, context: BoundContext): Promise<AstNode | null> {
  type Top = { s: Body; x: AstNode; bound: Bound; desc: boolean; nullsFirst: boolean; n: number };
  type Pick = { case: Body; x: AstNode; bound: Bound; min: boolean };
  const tops: Top[] = [], picks: Array<{ s: Body; each: Pick[] }> = [];
  const ctes = withQueries(tree);
  const boundFor = (collate: string): Bound | null => { const o = context.order(collate); return o === undefined ? null : boundOf(o); };
  for (const s of selectsIn(tree)) {
    if (!plainSelect(s) || oneItem(s, ctes) === null || (s.whereClause !== undefined && !readsAlike(s.whereClause))) continue;
    // A TOP N: the first key a libc key, a constant LIMIT and OFFSET, no DISTINCT or GROUP BY
    const sorts = (s.sortClause ?? []) as AstNode[];
    const first = sorts[0] !== undefined && isNodeOf(sorts[0], "SortBy") ? bodyOf(sorts[0]) : null;
    const key = first === null || first.useOp !== undefined ? null : libcKeyOf(first.node);
    const count = constInt(s.limitCount), offset = s.limitOffset === undefined ? 0 : constInt(s.limitOffset);
    if (key !== null && count !== null && count > 0 && offset !== null && offset >= 0 && count + offset <= 2_147_483_647 && (s.limitOption === undefined || s.limitOption === "LIMIT_OPTION_COUNT" || s.limitOption === "LIMIT_OPTION_DEFAULT")
      && !present(s.distinctClause) && !present(s.groupClause) && !present(s.havingClause)) {
      const bound = boundFor(key.collate);
      // (where NULL sorts: the engine's default_null_order is Postgres's, last ascending and first descending)
      const desc = first!.sortby_dir === "SORTBY_DESC";
      const nullsFirst = first!.sortby_nulls === "SORTBY_NULLS_FIRST" || (desc && first!.sortby_nulls !== "SORTBY_NULLS_LAST");
      if (bound !== null) tops.push({ s, x: key.x, bound, desc, nullsFirst, n: count + offset });
      continue;
    }
    // A MIN OR A MAX: arg_min / arg_max over the libc key's CASE (src/duck/rewrite.ts textMinMax), ungrouped, no FILTER
    if (present(s.groupClause) || present(s.distinctClause) || present(s.sortClause) || s.limitCount !== undefined || s.limitOffset !== undefined) continue;
    const each: Pick[] = [];
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (!isObject(v) || isNodeOf(v, "SubLink")) return;
      if (isNodeOf(v, "FuncCall")) {
        const f = bodyOf(v), name = nameOf(f.funcname), args = f.args as AstNode[] | undefined;
        const arm = args?.[1] !== undefined && isNodeOf(args[1], "CaseExpr") ? bodyOf(args[1]) : null;
        const when = arm !== null && (arm.args as unknown[]).length === 1 && arm.defresult === undefined ? bodyOf((arm.args as AstNode[])[0]) : null;
        const result = when !== null && isNodeOf(when.result, "RowExpr") ? (bodyOf(when.result).args as AstNode[])[0] : undefined;
        const k = libcKeyOf(result);
        if ((name === "arg_min" || name === "arg_max") && k !== null && f.over === undefined && f.agg_filter === undefined && f.agg_distinct !== true) {
          const bound = boundFor(k.collate);
          if (bound !== null) each.push({ case: when!, x: k.x, bound, min: name === "arg_min" });
          return;
        }
      }
      Object.values(v).forEach(visit);
    };
    visit(s.targetList);
    if (each.length > 0) picks.push({ s, each });
  }
  if (tops.length === 0 && picks.length === 0) return null;
  // the statement reads its rows alike twice (the module's header): Postgres's analysis and pg_proc decide it
  const reads = statementReads(analysis);
  if (reads.windowsOrSets) return null;
  if ((await context.volatile([...functionsCalled(analysis).oids].filter((f) => f > 0).sort((a, b) => a - b))).size > 0) return null;
  // a top N in a statement of no aggregate; a min or max in the one query that aggregates
  const chosen = { tops: reads.aggregates === 0 ? tops : [], picks: reads.aggregates === 1 ? picks : [] };
  if (chosen.tops.length === 0 && chosen.picks.length === 0) return null;
  const counted = (n: AstNode): AstNode => { if (context.wall !== null) context.wall.added += wallsIn(n, context.wall.alias); return n; };
  for (const t of chosen.tops) {
    const item = oneItem(t.s, ctes)!;
    // ASC: the n-th smallest hi, rows of lo <= it; DESC: the n-th largest lo, rows of hi >= it. Fewer than n values,
    // a threshold every bound passes: `H` above every lo, '' below every hi. A NULL row's bound is one every threshold
    // passes where NULL sorts first, and else the one only that threshold passes
    const [everyRow, beforeEvery] = t.desc ? [str(""), chr(H)] : [chr(H), str("")];
    const limit = counted(threshold(t.s, item, t.x, (t.desc ? lowBound : highBound)(t.bound, t.x), t.desc ? "min" : "max", { desc: t.desc, n: t.n, everyRow }));
    const own = { CoalesceExpr: { args: [(t.desc ? highBound : lowBound)(t.bound, t.x), t.nullsFirst ? beforeEvery : structuredClone(everyRow)] } };
    const kept = op(t.desc ? ">=" : "<=", own, limit);
    t.s.whereClause = t.s.whereClause === undefined ? kept : and([t.s.whereClause as AstNode, kept]);
  }
  for (const { s, each } of chosen.picks) {
    const item = oneItem(s, ctes)!;
    for (const p of each) {
      // min: the least hi, rows of lo <= it; max: the greatest lo, rows of hi >= it
      const limit = counted(threshold(s, item, p.x, (p.min ? highBound : lowBound)(p.bound, p.x), p.min ? "min" : "max", null));
      p.case.expr = and([p.case.expr as AstNode, op(p.min ? "<=" : ">=", (p.min ? lowBound : highBound)(p.bound, p.x), limit)]);
    }
  }
  return tree;
}
