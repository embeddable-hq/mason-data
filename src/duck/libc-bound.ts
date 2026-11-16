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
 * LETTERS OF LATIN ARE FOLDED INTO THE RUN (the second round of issue 666: over 30 M names a third beginning with É, Ø
 * or Ł had no run, and all were keyed): a character of `FOLD_BLOCKS` the order covers, lists and begins no contraction
 * with, whose first level is a mapped character's, is written as it, by the engine's `strip_accents` (É, ö, İ: its
 * decomposition, held to `stripped`) or a `replace` of its own where it has none (glibc's en_US: Ø, ł, ð and Ð, Đ,
 * Ħ, ŀ and Ŀ, ſ, ª, º, ¹, ² and ³), and a mark `strip_accents` drops is dropped where its first level is none. A head
 * of ASCII alone (as many bytes as characters) is read as above; any other is folded first over its longest prefix of
 * such characters, and the run read from what that writes. A mark of a weight of its own (U+0363), a letter of two
 * weights (Ǣ) or of one no mapped character has stops the run, as any unmapped character does, and a contraction a
 * folded character could complete unmaps its first character. Which letters fold is the order's to say, never a list:
 * the list above is what the code reads from en_US.utf8 on glibc.
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
 * engine evaluates a CASE's branch on its selected rows alone, so the key is computed for those. That is the form of a
 * SELECT inside a subquery expression or a LATERAL item (`correlatable`), which may read the query around it.
 *
 * EVERY OTHER SELECT KEYS EACH DISTINCT VALUE ONCE (the second round, `Values`): the bounds were three native passes
 * over every row (1.3 µs a row, 6 s of a min/max over 4.5 M codes whose key was computed twice), and a value most rows
 * hold left all those rows candidates, each keyed in JavaScript (19 s for a page of a status column, 98 % one value).
 * The key and the bounds are functions of the value, so the SELECT's DISTINCT values of x are read once, natively, into
 * a WITH query of its own, and the bounds, the threshold and the key are computed over them: a min or max is the
 * least (greatest) key of the values the bounds keep, and a top N joins its rows to the keys of the values the bounds
 * keep, T then the (n + m)-th smallest DISTINCT value's hi (a looser threshold, and as sound: n + m distinct values,
 * each at least one row, are before a value above it).
 *
 * THE THRESHOLD READS EXACTLY THE ROWS THE STATEMENT READS: its subquery is the SELECT's own FROM item and WHERE, cloned
 * (a role's walled read included, counted as one more wall). That is the same rows only where reading them twice reads
 * the same rows, which this decides from Postgres's analysis and the rewritten tree, never a guess: nothing volatile in
 * the statement (pg_proc's provolatile, `functionsCalled`), no window function or set-returning select list anywhere,
 * no aggregate but the min/max's own query (a top N: none), one FROM item, and no LIMIT, OFFSET, DISTINCT ON or sample
 * inside what is cloned but a role's barrier (src/duck/row-filter.ts `BARRIER`), which every row passes. Anything else
 * stays as written: a join (but a top N over joined tables src/duck/late.ts writes as a SELECT of one FROM item, the
 * preserved side limited first or the row numbers chosen, is bounded there), a set operation, a window's ORDER BY,
 * WITH TIES, a grouped top N, a FILTER'd min, a grouping set, a LIMIT that is not a constant.
 *
 * A GROUPED MIN OR MAX KEYS EACH GROUP'S CANDIDATES (the third round, `Values.pickGrouped`: keyed a row, the min and max
 * of names by region took 28 s against Postgres's 0.4 s over 4.5 M rows): the bounds are a group's as they are a
 * statement's, so a pass over the SELECT's rows gives each group its thresholds, a second its distinct candidates, and
 * each group's least and greatest candidate by the key is a WITH query's row, which each pick reads by its group. Both
 * passes hold a row a group and the candidates, never every distinct value (`groupedQueries`). Its keys must be
 * computed again over the same rows (`groupKeys`).
 *
 * A SELECT DISTINCT SORTED BY A LIBC KEY SORTS ITS DISTINCT ROWS (`distinctSorted`), and under a LIMIT is a top N above.
 *
 * WHAT CHANGES BESIDE THE TIME: a value the bounds rule out is never keyed, so under a locale whose order leaves a
 * character uncovered (`libc-uncovered`), a value holding it that is outside the top N no longer refuses the statement;
 * a candidate holding one still does.
 */
import { uncoveredRefusal, type LibcOrder } from "./libc-order.ts";
import { functionsCalled, type TreeNode, type TreeValue } from "./pgtree.ts";
import { BARRIER } from "./row-filter.ts";
import { OWN_PREFIX } from "./own-names.ts";

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
const row = (args: AstNode[]): AstNode => ({ RowExpr: { args, row_format: "COERCE_EXPLICIT_CALL" } });
const nullTest = (arg: AstNode, type: "IS_NULL" | "IS_NOT_NULL"): AstNode => ({ NullTest: { arg, nulltesttype: type } });
const chr = (code: number): AstNode => call("chr", [int(code)]);

/** what a libc order's bounds are written from: the run's pattern, the pattern of a text whole in the run (every
 *  character mapped), and the pattern of its characters of no first-level weight (null: none); and where a letter of
 *  Latin is weighed as a character of the run (`folds`), the characters a run may begin from (`allowed`: the mapped
 *  ones, the letters the engine's `strip_accents` takes to one, the marks it drops) and the letters written as one by
 *  `replace` (`replaced`, each with the mapped character of its weight) */
export interface Bound { run: string; whole: string; dropped: string | null; folds: { allowed: string; replaced: Array<[string, string]> } | null }

/** the engine's `strip_accents` of a text, as utf8proc computes it: decomposed, every mark dropped, composed again
 *  (tests/duck-libc-order.test.ts holds it to the engine's own over every character of `FOLD_BLOCKS`) */
export const stripped = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
/** the characters a letter may be folded from: Latin-1, Latin Extended-A and -B, the combining marks and Latin Extended
 *  Additional, where the engine's `strip_accents` is held to `stripped` */
export const FOLD_BLOCKS: ReadonlyArray<readonly [number, number]> = [[0x80, 0x24f], [0x300, 0x36f], [0x1e00, 0x1eff]];

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
    // A LETTER OF LATIN WEIGHED AS A MAPPED CHARACTER IS FOLDED TO IT (the second round of issue 666: a name beginning
    // with É, Ø or Ł had no run, so it was always a candidate): a character of FOLD_BLOCKS the order covers, lists and
    // begins no contraction with, whose first level is a mapped character's — written as that character by the
    // engine's `strip_accents` (É, ö, İ) or by a `replace` of its own (Ø, ł: no decomposition) — or, a mark
    // `strip_accents` drops, none. Any other is not folded, and a run stops at it, as at any unmapped character
    const firstOf = (g: number): readonly number[] => o.sequences.get(g)?.l1 ?? (o.l1[g]! > 0 ? [o.l1[g]!] : []);
    const weighs = (g: number, a: number): boolean => { const [x, y] = [firstOf(g), firstOf(a)]; return x.length === y.length && x.every((w, i) => w === y[i]); };
    const byWeight = new Map<number, number>();
    for (const g of mapped) if (o.l1[g]! > 0 && !byWeight.has(o.l1[g]!)) byWeight.set(o.l1[g]!, folded(g));
    const folds = new Map<number, number | null>(), replaces = new Map<number, number>();
    for (const [lo, hi] of FOLD_BLOCKS) for (let g = lo; g <= hi; g++) {
      if (o.uncovered[g] !== 0 || o.unlisted[g] !== 0 || o.contractions.has(g)) continue;
      const c = String.fromCodePoint(g), s = stripped(c);
      if (s === "") { if (firstOf(g).length === 0) folds.set(g, null); continue; }
      const a = s.codePointAt(0)!;
      if (s !== c) { if (s.length === 1 && mapped.has(a) && weighs(g, a)) folds.set(g, a); continue; }
      const one = firstOf(g);
      const like = one.length === 1 ? byWeight.get(one[0]!) : undefined;
      if (like !== undefined && weighs(g, like)) replaces.set(g, like);
    }
    // a contraction a mapped character could complete makes its first character's weight depend on what follows: not
    // mapped; a folded character completes it as its own self, which a fold would hide
    for (const g of [...mapped]) if ((o.contractions.get(g) ?? []).some((c) => c.rest.length > 0 && (mapped.has(c.rest[0]!) || folds.has(c.rest[0]!) || replaces.has(c.rest[0]!)))) mapped.delete(g);
    for (const [g, a] of [...folds]) if (a !== null && !mapped.has(a)) folds.delete(g);
    for (const [g, a] of [...replaces]) if (!mapped.has(a)) replaces.delete(g);
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
        folds: folds.size + replaces.size === 0 ? null : {
          allowed: charClass([...mapped, ...folds.keys(), ...replaces.keys()]),
          replaced: [...replaces].sort(([x], [y]) => x - y).map(([g, a]) => [String.fromCodePoint(g), String.fromCodePoint(a)]),
        },
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
  const arms = [{ CaseWhen: { expr: whole, result: op("||", structuredClone(x), chr(E)) } }];
  let rest = call("regexp_extract", [head(), str(b.run)]);
  if (b.folds !== null) {
    // A HEAD OF ASCII ALONE (as many bytes as characters) is as before. Any other is folded first, over the longest
    // prefix of characters the folds map (`allowed`): each is then a mapped one. x of at most `BOUND_CHARS` bytes, each
    // allowed, is whole in the run. (Folding every value cost a unique 192-character column's min / max twice its time)
    const { allowed, replaced } = b.folds;
    const fold = (v: AstNode): AstNode => replaced.reduce((t, [from, to]) => call("replace", [t, str(from), str(to)]), call("strip_accents", [v]));
    const folded = and([op("<=", call("strlen", [structuredClone(x)]), int(BOUND_CHARS)), call("regexp_full_match", [head(), str(`${allowed}*`)])]);
    arms.push({ CaseWhen: { expr: op("=", call("strlen", [head()]), call("length", [head()])), result: rest } });
    arms.push({ CaseWhen: { expr: folded, result: op("||", fold(head()), chr(E)) } });
    rest = call("regexp_extract", [fold(call("regexp_extract", [head(), str(`^${allowed}*`)])), str(b.run)]);
  }
  const run = call("lower", [{ CaseExpr: { args: arms, defresult: rest } }]);
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

/** a libc key the rewrite wrote (`__mason_libc_key(<session>, x, '<collate>')`): the call, x and the collcollate, or null */
function libcKeyOf(n: unknown): { call: AstNode; x: AstNode; collate: string } | null {
  if (!isNodeOf(n, "FuncCall") || nameOf(bodyOf(n).funcname) !== "__mason_libc_key") return null;
  const args = bodyOf(n).args as AstNode[] | undefined;
  const collate = args?.at(-1), x = args?.at(-2);
  if (x === undefined || !isNodeOf(collate, "A_Const") || !isObject(bodyOf(collate!).sval)) return null;
  return { call: n as AstNode, x, collate: String((bodyOf(collate!).sval as Body).sval ?? "") };
}

/** the same libc key's call under another of the order's functions (`__mason_libc_key_or_null`) */
function renamed(call: AstNode, name: string): AstNode {
  const c = structuredClone(call);
  bodyOf(c).funcname = [S(name)];
  return c;
}

/** the same libc key's call of another value: its session and collcollate kept, `x` replaced by `value` */
function keyOf(call: AstNode, value: AstNode): AstNode {
  const c = structuredClone(call);
  const args = bodyOf(c).args as AstNode[];
  args[args.length - 2] = value;
  return c;
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
 *  `everyRow` where fewer than n rows have a value (`CASE WHEN count(*) >= n THEN … ELSE <everyRow> END`). Its two names
 *  begin with the statement's own prefix (`own`, src/duck/own-names.ts) */
function threshold(s: Body, item: AstNode, x: AstNode, value: AstNode, aggregate: "min" | "max", top: { desc: boolean; n: number; everyRow: AstNode } | null, own: string): AstNode {
  const [bound, bounds] = [`${own}bound`, `${own}bounds`];
  const where = and([...(s.whereClause !== undefined ? [structuredClone(s.whereClause as AstNode)] : []), nullTest(structuredClone(x), "IS_NOT_NULL")]);
  const inner: Body = {
    targetList: [{ ResTarget: { name: bound, val: value } }],
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
      call(aggregate, [{ ColumnRef: { fields: [S(bounds), S(bound)] } }])) } }],
    fromClause: [{ RangeSubselect: { subquery: { SelectStmt: inner }, alias: { aliasname: bounds } } }],
    op: "SETOP_NONE",
  };
  return { SubLink: { subLinkType: "EXPR_SUBLINK", subselect: { SelectStmt: outer } } };
}

/** a top N found: its SELECT, its first sort key (`sort`, whose node is the libc key `call` of `x`), where NULL sorts,
 *  and how many rows it keeps (its LIMIT and OFFSET) */
interface Top { s: Body; sort: Body; call: AstNode; x: AstNode; collate: string; bound: Bound; desc: boolean; nullsFirst: boolean; n: number }
/** a min or max found: the arg_min / arg_max call (`f`), its CASE's arm, and the libc key `call` of `x` in it */
interface Pick { f: Body; case: Body; call: AstNode; x: AstNode; collate: string; bound: Bound; min: boolean; refusal: string }

/** a grouped min or max's WITH query of its groups (`Values.pickGrouped`): its name, its group keys' columns, the
 *  columns of each group's least and greatest value, and of whether each is a value the order could not key */
interface GroupedValues { name: string; keys: string[]; min: string; max: string; minUnkeyed: string; maxUnkeyed: string }

const col = (...names: string[]): AstNode => ({ ColumnRef: { fields: names.map(S) } });
/** a node without its offsets: two spellings of one expression at two places */
const shapeOf = (n: AstNode): string => JSON.stringify(n, (k, v: unknown) => k === "location" ? undefined : v);
/** every name in `v` (a string a node holds: an identifier, an alias, a WITH query's name, a column's), lower-cased */
function namesIn(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "string") out.add(v.toLowerCase());
  else if (Array.isArray(v)) for (const x of v) namesIn(x, out);
  else if (isObject(v)) for (const x of Object.values(v)) namesIn(x, out);
  return out;
}

/** a call in `v` of a function of Mason's (`__mason_*`), or over a window (an aggregate is no group's key: Postgres
 *  refuses it, 42803) */
function callsMason(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(callsMason);
  if (!isObject(v)) return false;
  if (isNodeOf(v, "FuncCall") && (nameOf(bodyOf(v).funcname).toLowerCase().startsWith("__mason_") || bodyOf(v).over !== undefined)) return true;
  return Object.values(v).some(callsMason);
}

/**
 * THE KEYS OF A GROUPED SELECT, each as an expression of its FROM item's rows, which the WITH query of its pairs
 * computes again over the same rows (`Values.pickGrouped`), or null where one cannot be: a grouping set, ROLLUP or
 * CUBE, a key that reads a subquery, a `*`, an aggregate or a window, a key that calls a function of Mason's (a
 * jsonb's or a numeric's key: a JavaScript call a row, which the pairs would make again) or a window, and a bare name that is an
 * output's name and not its column (the pairs' SELECT has no such output). A key written as its output's number is
 * that output's expression.
 */
function groupKeys(s: Body): AstNode[] | null {
  const targets = (s.targetList ?? []) as AstNode[];
  const aliases = new Map(targets.flatMap((t) => isNodeOf(t, "ResTarget") && typeof bodyOf(t).name === "string" ? [[String(bodyOf(t).name).toLowerCase(), bodyOf(t).val as AstNode] as const] : []));
  const out: AstNode[] = [];
  for (const g of (s.groupClause ?? []) as AstNode[]) {
    const n = constInt(g);
    const target = n === null ? undefined : targets[n - 1];
    const e = n === null ? g : target !== undefined && isNodeOf(target, "ResTarget") ? bodyOf(target).val as AstNode : undefined;
    if (e === undefined || !isObject(e) || isNodeOf(e, "GroupingSet") || holds(e, new Set(["SubLink", "A_Star", "GroupingFunc"])) || callsMason(e)) return null;
    // (a bare name the SELECT names an output, which the engine may read as that output)
    if (n === null && isNodeOf(e, "ColumnRef")) {
      const fields = bodyOf(e).fields as AstNode[];
      const named = fields.length === 1 ? aliases.get(String(bodyOf(fields[0]).sval ?? "").toLowerCase()) : undefined;
      if (named !== undefined && shapeOf(named) !== shapeOf(e)) return null;
    }
    out.push(e);
  }
  return out.length > 0 ? out : null;
}

/** the SELECTs that may read the query around them: inside a subquery expression or a LATERAL item, at any depth. A
 *  WITH query of theirs could not read it, so they are bounded row by row */
function correlatable(tree: unknown): Set<Body> {
  const out = new Set<Body>();
  const visit = (v: unknown, inside: boolean): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x, inside); return; }
    if (!isObject(v)) return;
    const k = kindOf(v);
    const here = inside || (k === "SubLink" && isObject(v[k])) || (k === "RangeSubselect" && isObject(v[k]) && bodyOf(v).lateral === true);
    if (k === "SelectStmt" && isObject(v[k]) && here) out.add(bodyOf(v));
    for (const x of Object.values(v)) visit(x, here);
  };
  visit(tree, false);
  return out;
}

/** the name a FROM item's columns are read by (`<name>.*`): its alias, else its table's name; null for a derived table
 *  of no alias (Postgres 16 takes one) */
const itemName = (item: AstNode): string | null => {
  const name = (bodyOf(item).alias as Body | undefined)?.aliasname ?? bodyOf(item).relname;
  return typeof name === "string" && name !== "" ? name : null;
};

/**
 * THE KEY ONCE A DISTINCT VALUE (issue 666, the second round): the libc key and the bounds are functions of the value,
 * so a SELECT that no outer query reads into reads its DISTINCT values of x once, natively, as a WITH query of its own
 * (`__mason_values<i>`, MATERIALIZED: each value and its run's weights, `weightsOf`), and the bounds, the threshold and
 * the key are computed over those values, never over the rows: a column of a few thousand codes over 4.5 M rows has
 * its bounds computed 16,900 times, not three times 4.5 M, and its key a few times.
 *  - A MIN OR MAX is `any_value` of a subquery over the values: the arg_min (arg_max) of the key of the values the
 *    bounds keep (lo <= the least hi; hi >= the greatest lo). The values are the SELECT's own rows' (its FROM item and
 *    WHERE, cloned), so over no row it is NULL, as min is; `any_value` keeps the SELECT one aggregate row.
 *  - A TOP N is the SELECT LEFT JOINed to the keys of the values the bounds keep (`__mason_keys<i>`: lo <= the n-th
 *    smallest DISTINCT value's hi, ASC; hi >= the n-th largest lo, DESC), its rows those whose x is one of them or
 *    NULL, sorted by the joined key where the key was. The n-th DISTINCT value's bound is a threshold as the rows' is:
 *    a value above it has n distinct values, each at least one row, strictly before it. A NULL x joins no key, and its
 *    key's NULL sorts where x's did (the sort key keeps its direction and NULLS). Its `*` reads the FROM item alone.
 */
class Values {
  private readonly made = new Map<Body, Map<string, string>>();
  private readonly groupedMade = new Map<Body, Map<string, GroupedValues>>();
  private readonly counted: (n: AstNode) => AstNode;
  /** every name the statement holds, lower-cased (the engine's identifiers are read without case): a name chosen here
   *  is none of them, nor one chosen before (`fresh`). Each begins with the statement's own prefix (src/duck/own-names.ts),
   *  which no name it can reach holds, a table's column read by a `*` included; the rewrite's own names (a lambda's
   *  parameter) begin with it too, and are among those the tree holds */
  private readonly taken: Set<string>;
  /** the columns of the values and of their keys, chosen once for the statement */
  private readonly v: string; private readonly w: string; private readonly k: string; private readonly bound: string;
  private readonly own: string;
  constructor(tree: unknown, counted: (n: AstNode) => AstNode, own: string) {
    this.counted = counted;
    this.own = own;
    this.taken = namesIn(tree);
    [this.v, this.w, this.k, this.bound] = [this.fresh("v"), this.fresh("w"), this.fresh("k"), this.fresh("bound")];
  }

  /** a name no part of the statement holds: the prefix and `word`, else those and the first number that makes it one */
  private fresh(word: string): string {
    const base = `${this.own}${word}`;
    let name = base;
    for (let i = 1; this.taken.has(name.toLowerCase()); i++) name = `${base}${i}`;
    this.taken.add(name.toLowerCase());
    return name;
  }

  /** the WITH query of the DISTINCT values of `x` over the SELECT's rows, made once per SELECT and x: its name */
  of(s: Body, item: AstNode, x: AstNode, collate: string, bound: Bound): string {
    // (by x and the order: two collations of one value weigh it two ways — the review of PR 1104)
    const shape = `${collate}\u0000${shapeOf(x)}`;
    const mine = this.made.get(s) ?? new Map<string, string>();
    this.made.set(s, mine);
    const known = mine.get(shape);
    if (known !== undefined) return known;
    const name = this.fresh("values");
    const where = and([...(s.whereClause !== undefined ? [structuredClone(s.whereClause as AstNode)] : []), nullTest(structuredClone(x), "IS_NOT_NULL")]);
    const distinct: Body = { distinctClause: [{}], targetList: [{ ResTarget: { name: this.v, val: structuredClone(x) } }],
      fromClause: [this.counted(structuredClone(item))], whereClause: where, limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" };
    const query: Body = {
      targetList: [{ ResTarget: { val: col(this.v) } }, { ResTarget: { name: this.w, val: weightsOf(bound, col(this.v)) } }],
      fromClause: [{ RangeSubselect: { subquery: { SelectStmt: distinct }, alias: { aliasname: this.fresh("distinct") } } }],
      limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
    };
    const w = (s.withClause as Body | undefined) ?? {};
    s.withClause = { ...w, ctes: [...(w.ctes as unknown[] | undefined ?? []), { CommonTableExpr: { ctename: name, ctematerialized: "CTEMaterializeAlways", ctequery: { SelectStmt: query } } }] };
    mine.set(shape, name);
    return name;
  }

  /** a value's lo (`L` after its weights) or hi (`H`) */
  private mark(low: boolean): AstNode { return op("||", col(this.w), chr(low ? L : H)); }
  /** `SELECT <list> FROM <values> [WHERE …]` */
  private static over(name: string, list: AstNode[], where?: AstNode, more: Body = {}): AstNode {
    return { SelectStmt: { targetList: list.map((val) => ({ ResTarget: { val } })), fromClause: [{ RangeVar: { relname: name, inh: true, relpersistence: "p" } }],
      ...(where === undefined ? {} : { whereClause: where }), limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE", ...more } };
  }
  private static scalar(select: AstNode): AstNode { return { SubLink: { subLinkType: "EXPR_SUBLINK", subselect: select } }; }

  /** the min or max: `any_value((SELECT arg_min(v, ROW(key(v), v)) FROM <values> WHERE lo <= (SELECT min(hi) FROM <values>)))` */
  pick(p: Pick, name: string): void {
    const limit = Values.scalar(Values.over(name, [call(p.min ? "min" : "max", [this.mark(!p.min)])]));
    const kept = op(p.min ? "<=" : ">=", this.mark(p.min), limit);
    const row = structuredClone(p.case.result as AstNode);
    bodyOf(row).args = [keyOf(p.call, col(this.v)), col(this.v)];
    const chosen = Values.scalar(Values.over(name, [call(p.min ? "arg_min" : "arg_max", [col(this.v), row])], kept));
    for (const k of Object.keys(p.f)) delete p.f[k];
    Object.assign(p.f, { funcname: [S("any_value")], args: [chosen], funcformat: "COERCE_EXPLICIT_CALL" });
  }

  /**
   * A GROUPED MIN OR MAX: each pick is its group's row of a WITH query of the groups' least and greatest values
   * (`groupedQueries`), made once per SELECT, x and order, read by a lookup of the row's group, `ifnull(CASE WHEN
   * any_value((SELECT <unkeyed> FROM <groups> WHERE <its keys> IS NOT DISTINCT FROM <the row's>)) THEN error(<the
   * order's refusal>) END, any_value((SELECT <min> …)))`. The refusal is the engine's, where the value picked is one the
   * order could not key: never a function's call a group (two million groups of one row each were 4 M calls)
   */
  pickGrouped(s: Body, item: AstNode, groups: AstNode[], p: Pick): void {
    // (by x and the order: the review of PR 1104, `min(n), min(n COLLATE zh)` answered the first's for both; a min and
    // a max of one order read one query's two columns)
    const shape = `${p.collate}\u0000${shapeOf(p.x)}`;
    let made = this.groupedMade.get(s)?.get(shape);
    if (made === undefined) {
      made = this.groupedQueries(s, item, groups, p);
      const of = this.groupedMade.get(s) ?? new Map<string, GroupedValues>();
      of.set(shape, made);
      this.groupedMade.set(s, of);
    }
    const { name, keys } = made;
    const [value, unkeyed] = p.min ? [made.min, made.minUnkeyed] : [made.max, made.maxUnkeyed];
    const lookup = (column: string): AstNode => {
      const alias = this.fresh("group");
      const same = and(keys.map((k, i) => ({ A_Expr: { kind: "AEXPR_NOT_DISTINCT", name: [S("=")], lexpr: col(alias, k), rexpr: structuredClone(groups[i]!) } })));
      return call("any_value", [Values.scalar({ SelectStmt: { targetList: [{ ResTarget: { val: col(alias, column) } }],
        fromClause: [{ RangeVar: { relname: name, inh: true, relpersistence: "p", alias: { aliasname: alias } } }], whereClause: same, limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } })]);
    };
    // the order's refusal, raised by the engine where the group's pick is a value it could not key: a group the statement
    // reads, once it is formed (a check inside the lookup is computed for every group the rows hold, before a HAVING or
    // an outer query's WHERE drops one)
    const refused: AstNode = { CaseExpr: { args: [{ CaseWhen: { expr: lookup(unkeyed), result: call("error", [str(`mason[0A000]: ${p.refusal}`)]) } }] } };
    for (const k of Object.keys(p.f)) delete p.f[k];
    Object.assign(p.f, bodyOf(call("ifnull", [refused, lookup(value)])));
  }

  /**
   * The WITH query of a grouped min or max (`pickGrouped`): each group's least and greatest value, from two passes over
   * the SELECT's own rows that hold no more than a row a group and the candidates (the review of PR 1104: the DISTINCT
   * (group, value) pairs, materialised, made 64 such statements at once spill past the spill ceiling, 53400, where the
   * key a row answered every one):
   *  - the thresholds, a row a group: its least hi and greatest lo, and its least and greatest value by their bytes,
   *    which are one where the group holds one value, its answer then with no key;
   *  - the candidates (lo <= the least hi; hi >= the greatest lo) of a group of more than one value, DISTINCT, each
   *    keyed once (`__mason_libc_key_or_null`), the least (greatest) by that key and then its bytes. A value the order
   *    cannot key is NULL there, taken before every key (`''` below every key, `'z'` above) and marked (`unkeyed`), so
   *    a group holding one as a candidate is refused once a statement reads it, as the key a row refused every row it
   *    read.
   * The weights are computed a row in each pass (the pairs weighed a distinct value once, but held every pair).
   */
  private groupedQueries(s: Body, item: AstNode, groups: AstNode[], p: Pick): GroupedValues {
    const name = this.fresh("groups"), bounds = this.fresh("thresholds");
    const keys = groups.map(() => this.fresh("g"));
    const [min, max, minUnkeyed, maxUnkeyed] = [this.fresh("min"), this.fresh("max"), this.fresh("min_unkeyed"), this.fresh("max_unkeyed")];
    const [tmin, tmax, bmin, bmax, low, high] = [this.fresh("tmin"), this.fresh("tmax"), this.fresh("bmin"), this.fresh("bmax"), this.fresh("low"), this.fresh("high")];
    const [rows, t, cands, picks] = [this.fresh("rows"), this.fresh("threshold"), this.fresh("candidates"), this.fresh("picks")];
    const select = (b: Body): Body => ({ ...b, limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" });
    const from = (relname: string, aliasname?: string): AstNode => ({ RangeVar: { relname, inh: true, relpersistence: "p", ...(aliasname === undefined ? {} : { alias: { aliasname } }) } });
    const derived = (b: Body, aliasname: string): AstNode => ({ RangeSubselect: { subquery: { SelectStmt: b }, alias: { aliasname } } });
    const named = (val: AstNode, as?: string): AstNode => ({ ResTarget: { ...(as === undefined ? {} : { name: as }), val } });
    const same = (a: string, b: string): AstNode => and(keys.map((k) => ({ A_Expr: { kind: "AEXPR_NOT_DISTINCT", name: [S("=")], lexpr: col(a, k), rexpr: col(b, k) } })));
    // the SELECT's own rows of a value: each group's keys, the value and its run's weights, a row at a time
    const weighed = (): Body => select({ targetList: [...groups.map((g, i) => named(structuredClone(g), keys[i])), named(structuredClone(p.x), this.v), named(weightsOf(p.bound, structuredClone(p.x)), this.w)],
      fromClause: [this.counted(structuredClone(item))],
      whereClause: and([...(s.whereClause !== undefined ? [structuredClone(s.whereClause as AstNode)] : []), nullTest(structuredClone(p.x), "IS_NOT_NULL")]) });
    // a row a group: its least hi, its greatest lo, and its least and greatest value by their bytes
    const thresholds = select({ targetList: [...keys.map((k) => named(col(k), k)), named(call("min", [this.mark(false)]), tmin), named(call("max", [this.mark(true)]), tmax),
      named(call("min", [col(this.v)]), bmin), named(call("max", [col(this.v)]), bmax)],
      fromClause: [derived(weighed(), rows)], groupClause: keys.map((k) => col(k)) });
    // the candidates of each group of more than one value, once each, keyed once
    const isLow = (): AstNode => op("<=", op("||", col(rows, this.w), chr(L)), col(t, tmin)), isHigh = (): AstNode => op(">=", op("||", col(rows, this.w), chr(H)), col(t, tmax));
    const candidates = select({ distinctClause: [{}],
      targetList: [...keys.map((k) => named(col(t, k), k)), named(col(rows, this.v), this.v), named(isLow(), low), named(isHigh(), high)],
      fromClause: [{ JoinExpr: { jointype: "JOIN_INNER", larg: derived(weighed(), rows), rarg: from(bounds, t), quals: same(rows, t) } }],
      whereClause: and([op("<>", col(t, bmin), col(t, bmax)), { BoolExpr: { boolop: "OR_EXPR", args: [isLow(), isHigh()] } }]) });
    const keyed = select({ targetList: [{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } }, named(keyOf(renamed(p.call, "__mason_libc_key_or_null"), col(this.v)), this.k)],
      fromClause: [derived(candidates, cands)] });
    const by = (lowest: boolean): AstNode => ({ CaseExpr: { args: [{ CaseWhen: { expr: col(lowest ? low : high),
      result: row([{ CoalesceExpr: { args: [col(this.k), str(lowest ? "" : "z")] } }, col(this.v)]) } }] } });
    const unkeyed = (): AstNode => nullTest(col(this.k), "IS_NULL");
    const picked = select({ targetList: [...keys.map((k) => named(col(k), k)),
      named(call("arg_min", [col(this.v), by(true)]), min), named(call("arg_min", [unkeyed(), by(true)]), minUnkeyed),
      named(call("arg_max", [col(this.v), by(false)]), max), named(call("arg_max", [unkeyed(), by(false)]), maxUnkeyed)],
      fromClause: [derived(keyed, this.fresh("keyed"))], groupClause: keys.map((k) => col(k)) });
    // each group: its one value, or its candidates' pick
    const one = (): AstNode => op("=", col(t, bmin), col(t, bmax));
    const either = (single: string, pick: string): AstNode => ({ CaseExpr: { args: [{ CaseWhen: { expr: one(), result: col(t, single) } }], defresult: col(picks, pick) } });
    const flag = (pick: string): AstNode => ({ CaseExpr: { args: [{ CaseWhen: { expr: one(), result: { A_Const: { boolval: {} } } } }], defresult: col(picks, pick) } });
    const groupsQuery = select({ targetList: [...keys.map((k) => named(col(t, k), k)),
      named(either(bmin, min), min), named(flag(minUnkeyed), minUnkeyed), named(either(bmax, max), max), named(flag(maxUnkeyed), maxUnkeyed)],
      fromClause: [{ JoinExpr: { jointype: "JOIN_LEFT", larg: from(bounds, t), rarg: derived(picked, picks), quals: same(t, picks) } }] });
    const w = (s.withClause as Body | undefined) ?? {};
    const cte = (ctename: string, q: Body): AstNode => ({ CommonTableExpr: { ctename, ctematerialized: "CTEMaterializeAlways", ctequery: { SelectStmt: q } } });
    s.withClause = { ...w, ctes: [...(w.ctes as unknown[] | undefined ?? []), cte(bounds, thresholds), cte(name, groupsQuery)] };
    return { name, keys, min, max, minUnkeyed, maxUnkeyed };
  }

  /** the top N: its FROM item LEFT JOINed to the keys of the values the bounds keep, sorted by the joined key */
  top(t: Top, item: AstNode, own: string): void {
    const name = this.of(t.s, item, t.x, t.collate, t.bound);
    const keys = this.fresh("keys"), bounds = this.fresh("bounds");
    // ASC: the n-th smallest value's hi (fewer than n values: `H`, above every lo); DESC: the n-th largest lo ('')
    const threshold: AstNode = { SelectStmt: {
      targetList: [{ ResTarget: { val: { CaseExpr: { args: [{ CaseWhen: { expr: op(">=", { FuncCall: { funcname: [S("count")], agg_star: true, funcformat: "COERCE_EXPLICIT_CALL" } }, int(t.n)),
        result: call(t.desc ? "min" : "max", [col(bounds, this.bound)]) } }], defresult: t.desc ? str("") : chr(H) } } } }],
      fromClause: [{ RangeSubselect: { subquery: Values.over(name, [], undefined, {
        targetList: [{ ResTarget: { name: this.bound, val: this.mark(t.desc) } }],
        sortClause: [{ SortBy: { node: int(1), sortby_dir: t.desc ? "SORTBY_DESC" : "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }],
        limitCount: int(t.n), limitOption: "LIMIT_OPTION_COUNT" }), alias: { aliasname: bounds } } }],
      limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } };
    const kept = op(t.desc ? ">=" : "<=", this.mark(!t.desc), Values.scalar(threshold));
    const keyed: Body = { targetList: [{ ResTarget: { val: col(this.v) } }, { ResTarget: { name: this.k, val: keyOf(t.call, col(this.v)) } }],
      fromClause: [{ RangeVar: { relname: name, inh: true, relpersistence: "p" } }], whereClause: kept, limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" };
    // the list's `*` is the FROM item's columns, never the keys' (`<item>.*`)
    for (const target of (t.s.targetList ?? []) as AstNode[]) {
      const v = isNodeOf(target, "ResTarget") ? bodyOf(target).val : undefined;
      const fields = isNodeOf(v, "ColumnRef") ? bodyOf(v).fields as AstNode[] : undefined;
      if (fields?.length === 1 && isNodeOf(fields[0], "A_Star")) bodyOf(v).fields = [S(own), fields[0]];
    }
    t.s.fromClause = [{ JoinExpr: { jointype: "JOIN_LEFT", larg: (t.s.fromClause as AstNode[])[0], rarg: { RangeSubselect: { subquery: { SelectStmt: keyed }, alias: { aliasname: keys } } },
      quals: op("=", structuredClone(t.x), col(keys, this.v)) } }];
    const joined = { BoolExpr: { boolop: "OR_EXPR", args: [nullTest(structuredClone(t.x), "IS_NULL"), nullTest(col(keys, this.v), "IS_NOT_NULL")] } };
    t.s.whereClause = t.s.whereClause === undefined ? joined : and([t.s.whereClause as AstNode, joined]);
    t.sort.node = col(keys, this.k);
    // the same key in the list (the late select list's sort output, src/duck/late.ts) is the joined one too: else it is
    // computed for every row the join keeps
    const shape = shapeOf(t.call);
    const swap = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach((x, i) => { if (isObject(x) && shapeOf(x as AstNode) === shape) v[i] = col(keys, this.k); else swap(x); }); return; }
      if (!isObject(v) || isNodeOf(v, "SubLink")) return;
      for (const [k, x] of Object.entries(v)) { if (isObject(x) && kindOf(x) === "FuncCall" && shapeOf(x as AstNode) === shape) v[k] = col(keys, this.k); else swap(x); }
    };
    swap(t.s.targetList);
  }
}

/** what the plan knows beside the tree: each collcollate's order, which functions are volatile, a role's walls */
export interface BoundContext {
  order: (collate: string) => LibcOrder | undefined;
  volatile: (functions: number[]) => Promise<ReadonlySet<number>>;
  /** a role's walled reads (src/duck/row-filter.ts `wallStatistics`): each cloned one counted */
  wall: { alias: string; added: number } | null;
  /** the prefix of every name the statement's rewrite invents (src/duck/own-names.ts), which the names written here begin
   *  with too. Absent: `__mason_` */
  own?: string;
}

/**
 * A SELECT DISTINCT SORTED BY A LIBC KEY SORTS ITS DISTINCT ROWS (issue 666: the engine computed the ORDER BY's key for
 * every row before the DISTINCT, 13 s for the 16,900 codes of 4.5 M rows and 18 s for their eight statuses). The SELECT
 * becomes `SELECT <its outputs> FROM (SELECT DISTINCT … AS __mason_d1, …) AS __mason_sorted ORDER BY <its keys over
 * those columns> [LIMIT …]`, so the key is computed once a distinct row, and a LIMIT over it is a top N the bounds
 * then key for its candidates alone. The rows and their order are the same: the keys of a SELECT DISTINCT read its
 * outputs alone (Postgres's 42P10 otherwise), so each key is written over the outputs it reads, by their expression or
 * their name. A SELECT this cannot write so stays as written: a DISTINCT ON, a `*` or an output of no name, a set
 * operation, a lock, a key reading anything but its outputs, and a SELECT that may read the query around it.
 * Returns whether any SELECT was written so.
 */
function distinctSorted(tree: AstNode, own: string): boolean {
  const inner = correlatable(tree);
  const taken = namesIn(tree);
  // (each name the statement's own prefix and a word, as `Values` chooses them: src/duck/own-names.ts)
  const fresh = (word: string): string => { const base = `${own}${word}`; let name = base; for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${base}${i}`; taken.add(name.toLowerCase()); return name; };
  let any = false;
  for (const s of selectsIn(tree)) {
    const distinct = s.distinctClause as unknown[] | undefined;
    if (!Array.isArray(distinct) || distinct.length !== 1 || kindOf(distinct[0]) !== null || inner.has(s) || !plainSelect(s) || !present(s.sortClause)) continue;
    const sorts = s.sortClause as AstNode[];
    if (!sorts.some((k) => isNodeOf(k, "SortBy") && holdsLibcKey(bodyOf(k).node))) continue;
    const targets = s.targetList as AstNode[];
    const outputs = targets.map((t) => isNodeOf(t, "ResTarget") && typeof bodyOf(t).name === "string" && isObject(bodyOf(t).val) && !holds(bodyOf(t).val, new Set(["A_Star"]))
      ? { name: String(bodyOf(t).name), val: bodyOf(t).val as AstNode } : null);
    if (outputs.some((o) => o === null)) continue;
    const alias = fresh("sorted");
    const columns = outputs.map(() => fresh("d"));
    const shapes = outputs.map((o) => shapeOf(o!.val));
    // each key over the outputs: an output's expression, or its name, is its column; anything else that reads a row stays
    let unread = false;
    const over = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(over);
      // (a constant reads no row: an output that is one stays the constant)
      if (!isObject(v) || isNodeOf(v, "A_Const")) return v;
      const at = shapes.indexOf(shapeOf(v as AstNode));
      if (at >= 0) return col(alias, columns[at]!);
      if (isNodeOf(v, "ColumnRef")) {
        const fields = bodyOf(v).fields as AstNode[];
        const named = fields.length === 1 ? outputs.findIndex((o) => o!.name.toLowerCase() === String(bodyOf(fields[0]).sval ?? "\u0000").toLowerCase()) : -1;
        if (named >= 0) return col(alias, columns[named]!);
        unread = true;
        return v;
      }
      if (isNodeOf(v, "SubLink")) { unread = true; return v; }
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, over(x)]));
    };
    const keys = sorts.map((k) => over(k) as AstNode);
    if (unread) continue;
    const { withClause, sortClause: _sorts, limitCount, limitOffset, limitOption, ...rest } = s;
    void _sorts;
    const body: Body = { ...rest, targetList: outputs.map((o, i) => ({ ResTarget: { name: columns[i], val: o!.val } })) };
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, {
      ...(withClause === undefined ? {} : { withClause }),
      targetList: outputs.map((o, i) => ({ ResTarget: { name: o!.name, val: col(alias, columns[i]!) } })),
      fromClause: [{ RangeSubselect: { subquery: { SelectStmt: body }, alias: { aliasname: alias } } }],
      sortClause: keys,
      ...(limitCount === undefined ? {} : { limitCount }), ...(limitOffset === undefined ? {} : { limitOffset }),
      limitOption: limitOption ?? "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
    });
    any = true;
  }
  return any;
}
/** `v` holds a libc key the rewrite wrote */
const holdsLibcKey = (v: unknown): boolean => libcKeyOf(v) !== null || (Array.isArray(v) ? v.some(holdsLibcKey) : isObject(v) && Object.values(v).some(holdsLibcKey));

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
  const tops: Top[] = [], picks: Array<{ s: Body; each: Pick[]; groups: AstNode[] | null }> = [];
  // a SELECT DISTINCT sorted by a libc key sorts its distinct rows (and, under a LIMIT, is a top N as any other below)
  const sortedAfter = distinctSorted(tree, context.own ?? OWN_PREFIX);
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
      if (bound !== null) tops.push({ s, sort: first!, call: key.call, x: key.x, collate: key.collate, bound, desc, nullsFirst, n: count + offset });
      continue;
    }
    // A MIN OR A MAX: arg_min / arg_max over the libc key's CASE (src/duck/rewrite.ts textMinMax), no FILTER; ungrouped,
    // or grouped by keys the WITH query of its pairs can compute again (`groupKeys`)
    const groups = present(s.groupClause) ? groupKeys(s) : null;
    if (present(s.groupClause) ? groups === null
      : present(s.distinctClause) || present(s.sortClause) || s.limitCount !== undefined || s.limitOffset !== undefined) continue;
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
          if (bound !== null) each.push({ f, case: when!, call: k.call, x: k.x, collate: k.collate, bound, min: name === "arg_min", refusal: uncoveredRefusal(context.order(k.collate)!).message });
          return;
        }
      }
      Object.values(v).forEach(visit);
    };
    // (grouped, a pick may stand in the HAVING and the ORDER BY too, each read per group)
    visit(groups === null ? s.targetList : [s.targetList, s.havingClause, s.sortClause]);
    if (each.length > 0) picks.push({ s, each, groups });
  }
  if (tops.length === 0 && picks.length === 0) return sortedAfter ? tree : null;
  // the statement reads its rows alike twice (the module's header): Postgres's analysis and pg_proc decide it
  const reads = statementReads(analysis);
  if (reads.windowsOrSets) return sortedAfter ? tree : null;
  if ((await context.volatile([...functionsCalled(analysis).oids].filter((f) => f > 0).sort((a, b) => a - b))).size > 0) return sortedAfter ? tree : null;
  // a top N in a statement of no aggregate; a min or max in the one query that aggregates
  const chosen = { tops: reads.aggregates === 0 ? tops : [], picks: reads.aggregates === 1 ? picks : [] };
  if (chosen.tops.length === 0 && chosen.picks.length === 0) return sortedAfter ? tree : null;
  const counted = (n: AstNode): AstNode => { if (context.wall !== null) context.wall.added += wallsIn(n, context.wall.alias); return n; };
  // a SELECT that may read the query around it is bounded row by row (its threshold a subquery over its own rows); any
  // other reads its DISTINCT values once, a WITH query of its own (`Values`)
  const inner = correlatable(tree);
  const prefix = context.own ?? OWN_PREFIX;
  const values = new Values(tree, counted, prefix);
  for (const t of chosen.tops) {
    const item = oneItem(t.s, ctes)!;
    const named = itemName(item);
    if (!inner.has(t.s) && named !== null) { values.top(t, item, named); continue; }
    // ASC: the n-th smallest hi, rows of lo <= it; DESC: the n-th largest lo, rows of hi >= it. Fewer than n values,
    // a threshold every bound passes: `H` above every lo, '' below every hi. A NULL row's bound is one every threshold
    // passes where NULL sorts first, and else the one only that threshold passes
    const [everyRow, beforeEvery] = t.desc ? [str(""), chr(H)] : [chr(H), str("")];
    const limit = counted(threshold(t.s, item, t.x, (t.desc ? lowBound : highBound)(t.bound, t.x), t.desc ? "min" : "max", { desc: t.desc, n: t.n, everyRow }, prefix));
    const own = { CoalesceExpr: { args: [(t.desc ? highBound : lowBound)(t.bound, t.x), t.nullsFirst ? beforeEvery : structuredClone(everyRow)] } };
    const kept = op(t.desc ? ">=" : "<=", own, limit);
    t.s.whereClause = t.s.whereClause === undefined ? kept : and([t.s.whereClause as AstNode, kept]);
  }
  for (const { s, each, groups } of chosen.picks) {
    const item = oneItem(s, ctes)!;
    // a grouped SELECT that may read the query around it stays as written
    if (groups !== null) {
      if (!inner.has(s)) for (const p of each) values.pickGrouped(s, item, groups, p);
      continue;
    }
    if (!inner.has(s)) {
      // every WITH query first: each reads the SELECT's WHERE as written
      const names = each.map((p) => values.of(s, item, p.x, p.collate, p.bound));
      each.forEach((p, i) => values.pick(p, names[i]!));
      continue;
    }
    for (const p of each) {
      // min: the least hi, rows of lo <= it; max: the greatest lo, rows of hi >= it
      const limit = counted(threshold(s, item, p.x, (p.min ? highBound : lowBound)(p.bound, p.x), p.min ? "min" : "max", null, prefix));
      p.case.expr = and([p.case.expr as AstNode, op(p.min ? "<=" : ">=", (p.min ? lowBound : highBound)(p.bound, p.x), limit)]);
    }
  }
  return tree;
}
