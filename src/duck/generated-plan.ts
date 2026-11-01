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
import { exprType, type TreeNode, type TreeValue } from "./pgtree.ts";

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
  /** each output column's FORM, read from its ANALYSED expression by the type Postgres gave each node and carried up
   *  through every wrapper over it, with its way out in the user's own expression (`formsOf`), else null: what a
   *  refusal's reason and way out are said from wherever the engine computes the value */
  forms: Array<Form | null>;
  /** each output column's own expression as the user wrote it (the raw tree's), else null (a set operation's): what a
   *  way out that casts the whole column is written over */
  roots: unknown[];
}

/**
 * WHAT A NUMERIC IS, AS POSTGRES TYPES IT: the node of a column's ANALYSED expression (`DuckPlan.outputs`, every node with
 * the type Postgres gave it, src/duck/pgtree.ts) whose value the engine can't store, carried up through every node over
 * it. The TYPE decides: a node Postgres types as a double is a double whatever its kind (`sqrt(float8)`, `avg(float8)`,
 * `float8 / n`, `coalesce(numeric, float8)`), and a numeric cast from one is "double"; only a node Postgres types as an
 * exact numeric over exact inputs is said by its own kind (a variance; sqrt, exp, ln, log or power; avg or `/`; a text
 * read as a numeric, which keeps the form of what the text was made from where it has one, `textFrom`). A name never decides a type here: it only chooses the words, once the type has said what the value
 * is (`fn` the user's own function, `fixed` that a round, a trunc, floor, ceil or a typmod is over it, `from` what a text
 * read as a numeric was, as the analysis typed it). The walk follows the value wherever the analysis says it comes from
 * (a sublink's subselect, a CTE, each arm of a set operation, a subquery: src/duck/pgtree.ts `outputExpressions`), and
 * `sites` says where its node is: its offset in the statement's text (`at`), with the offsets of the VARs followed to
 * it, the column's own first (`vars`); a set operation's arms of the same form are each a site. `way` and `scaled` are
 * its ways out in the user's own SQL (`wayOf`): as a double, and for a text read as a numeric, given one scale.
 */
export type Form = { why: "variance" | "per-value" | "text" | "divides" | "double"; fn: string; fixed: boolean; from: TextFrom | null; sites: Site[]; way: Way | null; scaled: Way | null };
type Seen = Form | "double" | null;
/** what a text read as a numeric was: a JSON value's text (an operator or function over json or jsonb), a double's, any other */
type TextFrom = "json" | "double" | "text";
type Site = { at: number; vars: number[] };
/** a way out in the user's own SQL: the column's own expression rewritten, or each query of the statement it belongs in,
 *  named in the user's words and given whole */
export type Way = { expr: string } | { places: Array<{ place: string; select: string }> };

const PER_VALUE = new Set(["sqrt", "exp", "ln", "log", "log10", "power", "pow"]);
const FIXES = new Set(["round", "trunc", "floor", "ceil", "ceiling"]);
const DOUBLES = new Set([700, 701]);
const TEXTS = new Set([25, 1042, 1043]);
const JSONS = new Set([114, 3802]);
const rec = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
const lastName = (names: unknown): string => {
  const list = Array.isArray(names) ? names as unknown[] : [];
  const s = rec(rec(list[list.length - 1]).String).sval;
  return typeof s === "string" ? s.toLowerCase() : "";
};
const isForm = (s: Seen): s is Form => s !== null && s !== "double";
const isTree = (v: TreeValue | undefined): v is TreeNode => v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v: TreeValue | undefined): number => typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : -1;

/** the nodes whose values an analysed node computes from: a call's or an operator's arguments, an aggregate's, the
 *  results of a CASE (never its conditions), a coercion's argument, a scalar sublink's subselect's column, what a VAR
 *  reads (`followed`: a subquery's, a CTE's or each set operation arm's column) */
function inputsOf(n: TreeNode): TreeNode[] {
  if (n._node === "AGGREF") return (Array.isArray(n.args) ? n.args : []).map((e) => isTree(e) && isTree(e.expr) ? e.expr : null).filter(isTree);
  if (n._node === "CASEEXPR") return [...(Array.isArray(n.args) ? n.args : []).map((w) => isTree(w) ? w.result : null), n.defresult].filter(isTree);
  if (n._node === "SUBLINK") {
    const q = n.subselect, first = isTree(q) && Array.isArray(q.targetList) ? q.targetList.find((e) => isTree(e) && e.resjunk !== "true") : undefined;
    return isTree(first) && isTree(first.expr) ? [first.expr] : [];
  }
  if (n._node === "VAR") return Array.isArray(n.followed) ? n.followed.filter(isTree) : [];
  if (Array.isArray(n.args)) return n.args.filter(isTree);
  return isTree(n.arg) ? [n.arg] : [];
}

/** a form born at a node: its kind, the user's function, and the node's offset as its one site */
const bornAt = (why: Form["why"], fn: string, at: number, from: TextFrom | null = null): Form => ({ why, fn, fixed: false, from, sites: [{ at, vars: [] }], way: null, scaled: null });

/**
 * WHAT THE TEXT A NUMERIC IS READ FROM WAS MADE FROM (PR 202 round 12): a value's form survives every conversion, so the
 * walk goes down through every text and JSON node over it (a cast, `||`, a jsonb build and `->>`, a WITH or subquery
 * column, any other) to the values it was made from. A numeric there keeps its own form (`seen`: a variance, sqrt and
 * its kin, a division, a cast from a double, a text read as a numeric), and a double the statement computes is "a cast
 * from a double" at its node: either is the text's form, so a typmod over the text never stores the engine's double. Where
 * none is, `from` says what the text was, as the analysis typed it: a JSON value's (an operator or a function over json or
 * jsonb: `->>`, `json_extract_path_text`), a stored double's (a column or a constant), or any other text (a stored or
 * exactly computed numeric's among them). Any other type stops the walk: an integer's, a date's or a boolean's text is
 * exact whatever made it.
 */
function textFrom(n: TreeNode, w: Walk): { form: Form | null; from: TextFrom } {
  const made = madeOf(n, w);
  return { form: made.form, from: made.from ?? "text" };
}
/** what a node of a text was made from (`textFrom`), once per node (`Walk.made`): its form, and the first of what the
 *  text was that the walk met, in the walk's order, up to the form */
type Made = { form: Form | null; from: TextFrom | null };
function madeOf(x: TreeNode, w: Walk): Made {
  const done = w.made.get(x);
  if (done !== undefined) return done;
  const made = madeAt(x, w);
  w.made.set(x, made);
  return made;
}
function madeAt(x: TreeNode, w: Walk): Made {
  const type = exprType(x)?.type ?? -1, at = int(x.location);
  if (x._node === "VAR" && inputsOf(x).length > 0) {
    // a column read from a subquery, a CTE or a set operation: the first arm's form, every arm of it a site, through this VAR
    const made = inputsOf(x).map((i) => madeOf(i, w)), from = made.find((m) => m.from !== null)?.from ?? null;
    return { form: throughVar(made.map((m) => m.form), at), from };
  }
  if (DOUBLES.has(type)) {
    if (x._node === "VAR" || x._node === "CONST") return { form: null, from: "double" };
    return { form: bornAt("double", "", at), from: null };
  }
  if (type === NUMERIC_OID) { const s = seen(x, w); return { form: isForm(s) ? s : null, from: null }; }
  if (!TEXTS.has(type) && !JSONS.has(type)) return { form: null, from: null };
  const args: TreeNode[] = Array.isArray(x.args) ? x.args.filter(isTree) : [];
  let from: TextFrom | null = (x._node === "OPEXPR" || x._node === "FUNCEXPR") && args[0] !== undefined && JSONS.has(exprType(args[0])?.type ?? -1) ? "json" : null;
  for (const i of inputsOf(x)) {
    const m = madeOf(i, w);
    from ??= m.from;
    if (m.form !== null) return { form: m.form, from };
  }
  return { form: null, from };
}

/** the most sites a form's way out is written at: a statement whose set operations each read the level below in two
 *  arms doubles them at every level, so past this the reason stands and the way out is the column's whole (round 14) */
const MAX_SITES = 64;
/** a column read from a subquery, a CTE or a set operation (a VAR at `at`): the first arm's form says the reason, and
 *  every arm of that form is a site of the way out, reached through this VAR; at most one past `MAX_SITES` kept */
function throughVar(below: ReadonlyArray<Seen>, at: number): Form | null {
  const forms = below.filter(isForm), first = forms[0];
  if (first === undefined) return null;
  const sites = forms.filter((f) => f.why === first.why).flatMap((f) => f.sites).slice(0, MAX_SITES + 1)
    .map((s) => ({ at: s.at, vars: at >= 0 ? [at, ...s.vars] : s.vars }));
  return { ...first, sites };
}

/** ONE WALK OF A STATEMENT'S ANALYSED OUTPUTS (PR 202 round 14): the outputs are a graph whose shared nodes every VAR
 *  that reads them holds by reference (src/duck/pgtree.ts `outputExpressions`), so each node's form and what its text was
 *  made from are found once and given to every reader; `names` the functions' and operators' names */
type Walk = { names: ReadonlyMap<string, string>; seen: Map<TreeNode, Seen>; made: Map<TreeNode, Made> };

/** the walk: each node's type first (a double is a double, anything but a numeric carries nothing), then the form below
 *  it passed up, marked by what is over it; `names` the functions' and operators' names, by `f<oid>` and `o<oid>` */
function seen(n: TreeNode, w: Walk): Seen {
  const done = w.seen.get(n);
  if (done !== undefined) return done;
  const s = seenAt(n, w);
  w.seen.set(n, s);
  return s;
}
function seenAt(n: TreeNode, w: Walk): Seen {
  const names = w.names, t = exprType(n);
  if (t !== null && DOUBLES.has(t.type)) return "double";
  if (t === null || t.type !== NUMERIC_OID) return null;
  const inputs = inputsOf(n), below = inputs.map((x) => seen(x, w));
  const inner = below.find(isForm) ?? null, at = int(n.location);
  const born = (why: Form["why"], fn: string, from: TextFrom | null = null): Form => bornAt(why, fn, at, from);
  // a text read as a numeric is the one form a node over it outranks: one scale for the text would not store a division,
  // a variance or sqrt and its kin over it, so that node is the reason
  const under = (outranks: boolean): Form | null => inner !== null && !(outranks && inner.why === "text") ? inner : null;
  switch (n._node) {
    case "FUNCEXPR": {
      const cast = int(n.funcformat) === 1 || int(n.funcformat) === 2, typmod = t.typmod >= 0;
      if (cast) {
        // a numeric cast from a double; a typmod over a text read as a numeric gives it its one scale
        if (below[0] === "double") return { ...born("double", ""), fixed: typmod };
        return inner === null || (inner.why === "text" && typmod) ? null : { ...inner, fixed: inner.fixed || typmod };
      }
      const name = names.get(`f${int(n.funcid)}`) ?? "", kept = under(PER_VALUE.has(name) || name === "div");
      if (kept !== null) return { ...kept, fixed: kept.fixed || FIXES.has(name) };
      return PER_VALUE.has(name) ? born("per-value", name) : name === "div" ? born("divides", name) : null;
    }
    case "AGGREF": {
      const name = names.get(`f${int(n.aggfnoid)}`) ?? "";
      return under(VARIANCES.has(name) || name === "avg") ?? (VARIANCES.has(name) ? born("variance", name) : name === "avg" ? born("divides", name) : null);
    }
    case "OPEXPR": {
      const divides = names.get(`o${int(n.opno)}`) === "/";
      return under(divides) ?? (divides ? born("divides", "/") : null);
    }
    // a text read as a numeric keeps the form of what the text was made from (round 12: a variance's text under a typmod
    // stored the engine's double); where nothing beneath has one, it keeps the decimals each value's text has
    case "COERCEVIAIO": {
      if (inputs[0] === undefined || !TEXTS.has(exprType(inputs[0])?.type ?? -1)) return inner;
      const made = textFrom(inputs[0], w);
      return made.form ?? born("text", "", made.from);
    }
    // a column read from a subquery, a CTE or a set operation: the first arm's form says the reason, and every arm of
    // that form is a site of the way out, reached through this VAR
    case "VAR": return throughVar(below, at);
    // a coalesce, a greatest or least, a CASE's results, a relabel, a sublink: the value it takes
    default: return inner;
  }
}

/** the functions and operators of analysed expressions, as `f<oid>` and `o<oid>` */
function oidsOf(v: TreeValue | undefined, out: { f: Set<number>; o: Set<number> }, met = new Set<TreeNode>()): void {
  if (Array.isArray(v)) { for (const x of v) oidsOf(x, out, met); return; }
  if (!isTree(v) || met.has(v)) return;
  met.add(v);
  if (v._node === "FUNCEXPR" && int(v.funcid) > 0) out.f.add(int(v.funcid));
  if (v._node === "AGGREF" && int(v.aggfnoid) > 0) out.f.add(int(v.aggfnoid));
  if (v._node === "OPEXPR" && int(v.opno) > 0) out.o.add(int(v.opno));
  for (const [k, x] of Object.entries(v)) if (k !== "_node") oidsOf(x, out, met);
}

/** the user's own top SELECT's body (under an `order_by:` shell, the shell's subquery's) */
function userTop(stmt: unknown): Record<string, unknown> {
  const body = rec(rec(stmt).SelectStmt), targets = body.targetList;
  const from = Array.isArray(body.fromClause) ? body.fromClause as unknown[] : [];
  const sub = rec(rec(from[0]).RangeSubselect);
  const star = Array.isArray(targets) ? rec(rec(rec(rec(targets[0]).ResTarget).val).ColumnRef).fields : undefined;
  if (Array.isArray(targets) && targets.length === 1 && from.length === 1 && rec(sub.alias).aliasname === SHELL_ALIAS && Array.isArray(star) && "A_Star" in rec(star[0])) return userTop(sub.subquery);
  return body;
}
/** the user's own expression of each output column (the raw tree's targets), null for a set operation's */
function rawTargets(stmt: unknown): unknown[] | null {
  const targets = userTop(stmt).targetList;
  return Array.isArray(targets) ? targets.map((t) => rec(rec(t).ResTarget).val) : null;
}

const typeName = (name: string, typmods: readonly number[] = []): unknown => ({ names: [{ String: { sval: "pg_catalog" } }, { String: { sval: name } }],
  ...(typmods.length === 0 ? {} : { typmods: typmods.map((m) => ({ A_Const: { ival: { ival: m } } })) }), typemod: -1 });
const DOUBLE_TYPE = typeName("float8");
/** the one scale a way out gives a text read as a numeric */
const ONE_SCALE = typeName("numeric", [20, 4]);
const isNumericCast = (n: unknown): boolean => "TypeCast" in rec(n) && lastName(rec(rec(rec(n).TypeCast).typeName).names) === "numeric";
const isFixer = (n: unknown): boolean => isNumericCast(n) || ("FuncCall" in rec(n) && FIXES.has(lastName(rec(rec(n).FuncCall).funcname)));
const castTo = (n: unknown, type: unknown): unknown => ({ TypeCast: { arg: n, typeName: type } });
/** a cast made a cast to `type` (a call such as `numeric(x)`: its argument cast) */
const retyped = (n: unknown, type: unknown): unknown => "TypeCast" in rec(n) ? { TypeCast: { ...rec(rec(n).TypeCast), typeName: type } }
  : castTo((rec(rec(n).FuncCall).args as unknown[] | undefined)?.[0], type);
/** an expression of the raw tree, as the deparser writes it */
const exprText = (val: unknown): string =>
  deparseSync({ SelectStmt: { targetList: [{ ResTarget: { val } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } } as unknown as Node, { pretty: false }).replace(/^SELECT /, "");

/** a step of the path from the statement's root to a node of its raw tree: the object, and the key it is under */
type Step = { key: string; node: Record<string, unknown> };
function pathTo(root: unknown, hit: (o: Record<string, unknown>) => boolean): Step[] | null {
  const path: Step[] = [];
  const find = (v: unknown, key: string): boolean => {
    if (Array.isArray(v)) return v.some((x) => find(x, key));
    if (typeof v !== "object" || v === null) return false;
    const node = v as Record<string, unknown>;
    path.push({ key, node });
    if (hit(node) || Object.entries(node).some(([k, x]) => find(x, k))) return true;
    path.pop();
    return false;
  };
  return find(root, "") ? path : null;
}
const located = (kinds: readonly string[], at: number) => (o: Record<string, unknown>): boolean => kinds.some((k) => k in o && rec(o[k]).location === at);

/**
 * WHERE A WAY OUT IS WRITTEN, for a path to a node of the raw tree: the output column's own expression (its ResTarget,
 * `name` null; a scalar sublink is inside it), or the query of the statement the node is in, named in the user's words
 * (`the WITH query t`, `the subquery s`, `the UNION ALL`: an arm of a set operation is written as the whole of it).
 * Undefined where that query has no name the user wrote.
 */
function placeOf(path: readonly Step[], top: Record<string, unknown>): { key: unknown; name: string | null } | undefined {
  const i = path.findIndex((s) => "ResTarget" in s.node);
  if (i < 1) return undefined;
  if (path[i - 1]!.node === top) return { key: path[i]!.node, name: null };
  let r = i - 1;
  while (r > 0 && (path[r]!.key === "larg" || path[r]!.key === "rarg")) r--;
  const body = path[r]!.node;
  if (body === top) return { key: body, name: `the ${String(body.op).replace(/^SETOP_/, "")}${body.all === true ? " ALL" : ""}` };
  const wrapper = path[r - 1], parent = path[r - 2], alias = rec(parent?.node.alias).aliasname;
  if (wrapper?.key === "ctequery" && parent?.key === "CommonTableExpr") return { key: body, name: `the WITH query ${String(parent.node.ctename)}` };
  if (wrapper?.key === "subquery" && parent?.key === "RangeSubselect" && typeof alias === "string") return { key: body, name: `the subquery ${alias}` };
  return undefined;
}

/**
 * THE WAY OUT IN THE USER'S OWN WORDS (`Form.way`, `Form.scaled`): their SQL with only the cast moved, every aggregate and
 * wrapper kept, at each of the form's sites. As a double (`double`), the value is cast to double precision at the node
 * the engine can't store, or above the outermost round, trunc, floor, ceil or numeric cast over it, through every query
 * the walk followed it across (a round of a double takes no decimals, and a numeric cast would make it a numeric again):
 * a numeric cast there is made the cast to double, a numeric cast from a double with nothing over it is taken away, and a
 * text's cast to numeric is made the cast to double. Given one scale (`scale`, a text read as a numeric), the text's cast
 * is given `numeric(20,4)`. Written where the cast lands (`placeOf`); null where a node is not found in the user's text.
 */
function wayOf(stmt: unknown, f: Form, mode: "double" | "scale"): Way | null {
  const top = userTop(stmt), swaps = new Map<unknown, unknown>(), places = new Map<unknown, string | null>();
  for (const site of f.sites) {
    const born = pathTo(stmt, located(["FuncCall", "TypeCast", "A_Expr"], site.at));
    if (born === null) return null;
    const target = born[born.length - 1]!.node;
    // the expressions over the node within each query, the column's own first, through each VAR the walk followed
    const segments = [...site.vars.map((v) => pathTo(stmt, located(["ColumnRef"], v))).filter((p): p is Step[] => p !== null), born];
    const over = (p: Step[]): Step | undefined => p.slice(p.findIndex((s) => "ResTarget" in s.node) + 1, -1).find((s) => isFixer(s.node));
    const fixed = mode === "scale" ? undefined : segments.map((p) => ({ p, s: over(p) })).find((x) => x.s !== undefined);
    const [node, path] = fixed?.s !== undefined ? [fixed.s.node, fixed.p] : [target, born];
    swaps.set(node, mode === "scale" ? retyped(target, ONE_SCALE)
      : fixed !== undefined ? (isNumericCast(node) ? retyped(node, DOUBLE_TYPE) : castTo(node, DOUBLE_TYPE))
      : !isNumericCast(target) ? castTo(target, DOUBLE_TYPE) : f.why === "double" ? rec(rec(target).TypeCast).arg : retyped(target, DOUBLE_TYPE));
    const place = placeOf(path, top);
    if (place === undefined) return null;
    places.set(place.key, place.name);
  }
  const swap = (v: unknown): unknown => swaps.has(v) ? swaps.get(v) : Array.isArray(v) ? v.map(swap)
    : typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
  const all = [...places];
  if (all.length === 1 && all[0]![1] === null) return { expr: exprText(swap(rec(rec(all[0]![0]).ResTarget).val)) };
  if (all.some(([, name]) => name === null)) return null;
  return { places: all.map(([body, name]) => ({ place: name!, select: deparseSync({ SelectStmt: swap(body) } as unknown as Node, { pretty: false }) })) };
}

/** each output column's form (`DefinitionPlan.forms`), read from its analysed expression, with its ways out written over
 *  the user's own SQL: null where it has none */
async function formsOf(rows: Planner["rows"], outputs: ReadonlyArray<TreeNode | null> | undefined, stmt: unknown, n: number): Promise<Array<Form | null>> {
  if (outputs === undefined || outputs.length !== n) return Array<Form | null>(n).fill(null);
  const oids = { f: new Set<number>(), o: new Set<number>() };
  oidsOf(outputs as TreeValue[], oids);
  const names = new Map<string, string>(oids.f.size + oids.o.size === 0 ? [] : (await rows(
    `SELECT 'f' || oid::text, proname::text FROM pg_proc WHERE oid IN (${[0, ...oids.f].join(", ")}) UNION ALL SELECT 'o' || oid::text, oprname::text FROM pg_operator WHERE oid IN (${[0, ...oids.o].join(", ")})`))
    .map(([k, name]) => [k!, name!] as const));
  const w: Walk = { names, seen: new Map(), made: new Map() };
  return outputs.map((e) => {
    const s = e === null ? null : seen(e, w);
    if (!isForm(s)) return null;
    const found = s.sites.length <= MAX_SITES && s.sites.every((x) => x.at >= 0);
    return { ...s, way: found ? wayOf(stmt, s, "double") : null, scaled: found && s.why === "text" ? wayOf(stmt, s, "scale") : null };
  });
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
type NotStored = { why: "divides" | "rows" | "text" | "engine" } | { why: "scale" | "held" | "picks"; scale: number } | { why: "other"; what: string };

/** the forms whose value the engine computes as a double, where Postgres computes it exactly (a variance; sqrt, exp, ln,
 *  log or power; avg or `/`) or from a double's digits (a numeric cast from one): never stored, whatever the program */
const ENGINE_DOUBLES: ReadonlySet<Form["why"]> = new Set(["variance", "per-value", "divides", "double"]);

/** the variance family: Postgres computes each of a numeric exactly, at decimals it picks by the value's size */
const VARIANCES = new Set(["variance", "var_samp", "var_pop", "stddev", "stddev_samp", "stddev_pop"]);

/** the decimals Postgres's types give a value: a number, or what decides them per row, never unknown. "value": Postgres
 *  picks them by each value's size (a variance, sqrt, exp, ln, power); "rows": a sum's rows (`rescale`); "picks": the
 *  value a GREATEST, LEAST, COALESCE or CASE took; "text": a numeric read from text, at the decimals each value's text
 *  has (its `sql` is that text: only a typmod reads it). A round, a trunc, a typmod, floor or ceil fixes a number again. */
type Scale = number | "picks" | "rows" | "value" | "text";

/**
 * A numeric as the engine's DECIMAL arithmetic: `sql`, what DuckDB holds it at (`held`, the scale of its DECIMAL), the most
 * decimals any step on the way holds (`peak`), the decimals Postgres's types give it (`scale`), and whether its digits are
 * the engine's computation whatever its scale (`engine`: a cell the engine holds as a double, a variance's program, a
 * cell the catalog's Postgres computes). Why it is not stored is then the column's FORM's (`formsOf`), never this cell's
 * type: one type is several forms.
 */
type Stored = { sql: string; held: number; peak: number; scale: Scale; engine: boolean };

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
const made = (sql: string, held: number, scale: Scale, from: readonly Stored[]): Stored =>
  ({ sql, held, scale, peak: Math.max(held, ...from.map((x) => x.peak)), engine: from.some((x) => x.engine) });

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
      if (d !== null) return { sql, held: Number(d[2]), peak: Number(d[2]), scale: Number(d[2]), engine: false };
      if (type !== undefined && INTEGER_TYPES.has(type)) return { sql: `CAST(${sql} AS DECIMAL(38,0))`, held: 0, peak: 0, scale: 0, engine: false };
      // a text cell: a numeric read from text (stored under a typmod, which rounds it as numeric_in does, half away from
      // zero), or a function the catalog's Postgres computes; a double cell: the engine's. Neither of the last two is
      // stored, and why is the column's form's
      if (type === "VARCHAR" && cells[Number(p.key)] === "parsed") return { sql, held: 0, peak: 0, scale: "text", engine: false };
      if (type === "VARCHAR" || type === "DOUBLE" || type === "FLOAT") return { sql: "NULL", held: 0, peak: 0, scale: "value", engine: true };
      return { why: "other", what: `a value the engine holds as ${type ?? "nothing it names"}` };
    }
    case "literal": {
      const m = /^-?(\d+)(?:\.(\d*))?$/.exec(p.text);
      if (m === null) return { why: "other", what: `the literal ${p.text}` };
      const scale = m[2]?.length ?? 0;
      return { sql: `CAST('${p.text}' AS DECIMAL(${Math.min(38, Math.max(1, m[1]!.length + scale))},${scale}))`, held: scale, peak: scale, scale, engine: false };
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
    case "stddev": return { sql: "NULL", held: 0, peak: 0, scale: "value", engine: true };
    case "rescale": return one(p.arg, (x) => ({ ...x, scale: typeof x.scale === "number" ? "rows" : x.scale }));
  }
}

/** a stored numeric's verdict, where all that is around it is known: null where it is stored (a picked value's `scale`:
 *  the most decimals any value it picks from holds, which one scale for it keeps) */
function verdict(s: Stored): NotStored | null {
  if (s.scale === "text") return { why: "text" };
  if (s.engine || s.scale === "value") return { why: "engine" };
  if (s.scale === "rows") return { why: "rows" };
  if (s.scale === "picks") return { why: "picks", scale: s.held };
  if (s.scale > MAX_STORED_SCALE) return { why: "scale", scale: s.scale };
  if (s.peak > MAX_STORED_SCALE) return { why: "held", scale: s.peak };
  return null;
}

/** what a text read as a numeric was, in the words of its refusal */
const TEXT_WORDS: Record<TextFrom, string> = { json: "a JSON number's ->> cast to numeric", double: "the text of a double precision value, cast to numeric", text: "a text value cast to numeric" };

/**
 * A numeric not stored, said by its own reason, with ways out that hold. Where the engine computes the value
 * ("engine"), and for a numeric read from text, the reason and the way out are its FORM's (`formsOf`), in the user's own
 * function's name; the scale's reasons are the program's walk's (`verdict`). Every way out is the user's own SQL
 * (`Form.way`, `Form.scaled`, or the column's own expression, `root`, cast whole), never a placeholder, and never the
 * output column named as if its source had it. Nothing here reads a reason from an engine type, the outermost node or a
 * constant.
 */
function notStoredRefusal(name: string, n: NotStored, f: Form | null, root: unknown): GeneratedRefusal {
  const atRead = "or compute it in the statement that reads the synced table";
  const written = (w: Way): string => "expr" in w ? `${w.expr} AS ${name}` : w.places.map((p) => `write ${p.place} as ${p.select}`).join("; and ");
  // the column's own expression cast whole, where the user wrote one (a set operation's column has none)
  const whole = (type: unknown): Way | null => root === null || root === undefined ? null : { expr: exprText(castTo(root, type)) };
  const doubleWay = f?.way ?? whole(DOUBLE_TYPE);
  const asDouble = (or: boolean): string => `${or ? "or " : ""}store it as a double if it need not be exact: ${doubleWay === null ? "cast it to double precision where it is computed" : written(doubleWay)}`;
  const scaled = (words: string, fallback: string): string => `${words}: ${f?.why === "text" && f.scaled !== null ? written(f.scaled) : fallback}`;
  // a value the engine computes (a variance, sqrt and its kin, a double) is its form's reason, whatever the program saw
  // around it (a sum of sqrt's texts is "the rows decide" to the program, and no scale given to its rows would store
  // it); a division over a text read as a numeric is the division's, since one scale for the text would not store it
  const strong = f !== null && (f.why === "variance" || f.why === "per-value" || f.why === "double");
  const why = n.why === "engine" ? f?.why ?? "engine" : strong ? f.why : n.why === "text" ? (f?.why === "divides" ? "divides" : "text") : null;
  switch (why) {
    case "variance": return { key: "sql",
      message: `column ${name} is a ${f!.fn}, which Postgres computes as an exact numeric at decimals it picks by the size of each value, and the engine only as a double`,
      why: "A stored numeric keeps one scale for every row, and a stored double holds neither Postgres's digits nor its type.",
      options: [asDouble(false), atRead] };
    case "per-value": return f!.fixed
      ? { key: "sql", message: `column ${name} rounds or casts a numeric Postgres computes for each row at decimals it picks (${f!.fn}), which the engine computes as a double`, why: "Postgres's digits for it are worked out when a statement is answered, and a stored column skips that step.",
        options: [asDouble(false), atRead] }
      : { key: "sql", message: `column ${name} is a numeric whose decimals Postgres picks by the size of each value (${f!.fn})`, why: "A stored numeric keeps one scale for every row.",
        options: [asDouble(false), atRead] };
    case "text": return { key: "sql", message: `column ${name} is a numeric read from text (${TEXT_WORDS[f?.why === "text" && f.from !== null ? f.from : "text"]}), which keeps the decimals each value's text has`,
      why: "A stored numeric keeps one scale for every row.",
      options: [scaled("give it one scale", "cast the text to numeric(20,4) where it is read"), asDouble(true)] };
    case "divides": return divides(name, asDouble(false));
    case "double": return { key: "sql", message: `column ${name} is a numeric cast from a double precision value (x::float8::numeric)`, why: "Postgres writes such a numeric from the double's digits when a statement is answered, a step a stored column skips.",
      options: [`store the double it is: ${f?.way === null || f?.way === undefined ? "take its cast to numeric away" : written(f.way)}`, atRead] };
    case "engine": return { key: "sql", message: `column ${name} is a numeric the engine computes as a double, where Postgres computes it exactly`, why: "A stored double would hold neither Postgres's digits nor its type.",
      options: [asDouble(false), atRead] };
    case null: break;
  }
  switch (n.why) {
    case "divides": return divides(name, asDouble(false));
    case "scale": return { key: "sql", message: `column ${name} has ${n.scale} decimals, more than the ${MAX_STORED_SCALE} a stored numeric keeps`, why: "A sum at that scale could overflow the 38 digits a stored numeric has.",
      options: [`round it to fewer: round(sum(x), 2) AS ${name}`, asDouble(true)] };
    case "held": return { key: "sql", message: `column ${name} is computed at ${n.scale} decimals on the way to its own, more than the ${MAX_STORED_SCALE} a stored numeric keeps (a sum of numbers read from text is added at 36)`, why: "A value at that scale could overflow the 38 digits a stored numeric has before it is rounded.",
      options: [scaled("give the values fewer decimals first", "cast each value to numeric(20,4) before it is summed or rounded"), asDouble(true)] };
    case "rows": return { key: "sql", message: `column ${name} sums values Postgres keeps at differing scales, so the rows decide its decimals`, why: "A stored numeric keeps one scale for every row.",
      options: [scaled("give the values one scale first", "cast each value to numeric(20,4) before it is summed"), asDouble(true)] };
    case "picks": {
      const one = whole(typeName("numeric", [38, n.scale]));
      return { key: "sql", message: `column ${name} is whichever value a GREATEST, LEAST, COALESCE or CASE takes, at that value's own decimals, and its values have differing ones`, why: "A stored numeric keeps one scale for every row.",
        options: [`give it one scale: ${one === null ? `cast it to numeric(38,${n.scale}) where it is computed` : written(one)}`, asDouble(true)] };
    }
    case "other": return { key: "sql", message: `column ${name} computes a numeric from ${n.what}, which Mason can't store exactly yet`, why: null,
      options: [`compute it in the statement that reads the table`, asDouble(true)] };
    default: throw new Error(`a numeric not stored with no reason said: ${n.why}`);
  }
}
const divides = (name: string, double: string): GeneratedRefusal => ({ key: "sql", message: `column ${name} divides a numeric, which the engine computes as a double`,
  why: "Postgres divides a numeric exactly (an average is a division), so a stored double would not hold its digits.",
  options: [double, "or store what it divides, and divide in the statement that reads the table"] });

/** a numeric output column, as the catalog spells its type */
export const isNumeric = (c: { type: string }): boolean => /^numeric\b/.test(c.type);

/**
 * EVERY NUMERIC OF A DEFINITION, AS STORED, held to the engine type DuckDB says the plan's SQL computes (`types`), or refused
 * by its own reason. A computed one (`DefinitionPlan.numerics`) is written as DECIMAL arithmetic over its cells; one the
 * engine answers itself (no program, "as the engine answers it", a passthrough's among them) is stored as the engine's
 * DECIMAL, an integer as HUGEINT (one type for a numeric of no decimals: a sum of int8, a sign), and a double refused.
 * Before either, the ONE authority: a column whose analysed form the engine computes as a double (`ENGINE_DOUBLES`) is
 * refused by that form, whether the rewrite made a program for it or not.
 * At the check (`planDefinition` with a `describe`) and again at the write, over the SQL that runs.
 */
export function storedColumns(d: DefinitionPlan, types: EngineTypes): { columns: GeneratedColumn[] } | { refused: GeneratedRefusal[] } {
  const refused: GeneratedRefusal[] = [], exprs = new Map<number, string>();
  // what the analysis says the engine computes as a double is refused by its form, whether or not the rewrite made a
  // program for it: no exact program carries one, and the rewrite's silence (src/duck/rewrite.ts `programNeeded`, the
  // wire's rule) stored `stddev(x)::numeric(p,s)` from the engine's double (PR 202 round 11)
  const engineDouble = (i: number): boolean => { const f = d.forms[i]; return f !== null && f !== undefined && ENGINE_DOUBLES.has(f.why); };
  for (const { column, program, cells } of d.numerics) {
    const name = d.columns[column]!.name, stored = storedNumeric(program, types, cells);
    const no = engineDouble(column) ? { why: "engine" as const } : "why" in stored ? stored : verdict(stored);
    if (no !== null) refused.push(notStoredRefusal(name, no, d.forms[column] ?? null, d.roots[column]));
    else exprs.set(column, (stored as Stored).sql);
  }
  d.columns.forEach((c, i) => {
    if (!isNumeric(c) || d.numerics.some((n) => n.column === i)) return;
    if (engineDouble(i)) { refused.push(notStoredRefusal(c.name, { why: "engine" }, d.forms[i] ?? null, d.roots[i])); return; }
    const type = types.get(`#${i}`);
    if (type !== undefined && (DECIMAL_TYPE.test(type) || type === "HUGEINT")) return;
    if (type !== undefined && INTEGER_TYPES.has(type)) exprs.set(i, `CAST(__mason_output.__mason_c${i} AS HUGEINT)`);
    else refused.push(notStoredRefusal(c.name, type === "DOUBLE" || type === "FLOAT" ? { why: "engine" } : { why: "other", what: `a value the engine holds as ${type ?? "nothing it names"}` }, d.forms[i] ?? null, d.roots[i]));
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

/** a definition whose check failed on what Mason did not expect (src/duck/generated.ts `check`): a verdict all the same,
 *  in a user's words, never the error's, which names the engine (its text goes to the log, for the report) */
export function uncheckedRefusal(): GeneratedRefusal {
  return { key: "sql", message: "Mason could not check this definition (a Mason bug: report it)",
    why: "Checking it stopped on something Mason did not expect, so the table is not built; Mason's log says what, for the report.",
    options: ["report it, with the file's SQL and the log's line for this file", "or write the SQL another way: a CTE or a subquery as a join, or each UNION ALL arm as its own generated table"] };
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
  if (plan.withTies) refused.push({ key: "sql", message: "it ends in FETCH … WITH TIES", why: "That row count isn't a table's to keep.", options: ["use LIMIT, with an ORDER BY that decides every row"] });
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
  const definition: DefinitionPlan = { plan, bases, warnings: statement.warnings, numerics, forms: await formsOf(p.rows, plan.outputs, statement.stmt, fields.length),
    roots: ((raw) => fields.map((_, i) => raw !== null && raw.length === fields.length ? raw[i] : null))(rawTargets(statement.stmt)),
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
