/**
 * POSTGRES DECIDES, DUCKDB COMPUTES — THE REWRITE (docs/DESIGN.md). A statement a tool sends is Postgres SQL;
 * DuckDB reads most of it the same, but not all of it the same WAY: `7 / 2` is 3.5 to DuckDB and 3 to Postgres,
 * `round(2.5::float8)` 3 and 2, `'a%b' LIKE 'a\%b'` false and true, `ORDER BY name` by bytes and by the database's
 * collation, `'{"a":1}'::jsonb ->> 'a'` refused. So the statement is not handed to DuckDB as written. Postgres itself
 * (the catalog Postgres, src/duck/analyze.ts) analyses it first, and its analysis says what every expression IS — the
 * operator it chose for `/` and over which types, the function `round` resolved to, the collation a sort compares
 * under — and this module rewrites the RAW parse tree (libpg-query's, the tree the server already has) wherever DuckDB
 * would compute something else, by what Postgres decided, never by guessing from the text:
 *  - integer division (both operands integers, Postgres's `int4div` …) is DuckDB's `//`, and a division by a zero
 *    that DuckDB would answer with Infinity or NULL raises Postgres's error;
 *  - `round` of a double precision rounds half to even (`rint`), of a numeric half away from zero;
 *  - LIKE / ILIKE escape with a backslash, as Postgres's do by default;
 *  - a regular expression is Postgres's (ARE): `.` matches a newline, `\w` and `\d` are Unicode's, `\y` is a word
 *    boundary, and a replacement's `\&` is the whole match;
 *  - a text sort key, a text comparison and a text min / max follow the SOURCE database's collation
 *    (`DuckCollation`): ICU's through DuckDB's own ICU collation, a tie by the bytes, libc's through a sort key built
 *    from the order read of the source (src/duck/libc-order.ts);
 *  - a cast to an unconstrained `numeric` keeps the value's digits (DuckDB's `NUMERIC` is DECIMAL(18,3));
 *  - a text cast to an integer is as strict as Postgres's (`'0.3'::int` is an error, DuckDB says 0);
 *  - `extract` is the exact numeric Postgres returns (`epoch` with six decimals);
 *  - jsonb is DuckDB's JSON, and the operators and functions Postgres has for it are DuckDB's spelling of them;
 *  - `date_trunc(unit, t, zone)`, `make_interval`, `every`, `FETCH … WITH TIES` are spelled the way DuckDB has them;
 *  - a parameter is cast to the type Postgres inferred for it.
 * What DuckDB cannot be made to compute as Postgres does is REFUSED by name (SQLSTATE 0A000 with the way out), never
 * answered differently. The rewritten tree is printed with pgsql-deparser; the server parses the printed text again
 * and refuses the statement unless it reads back as exactly this tree (`sameTree`), so a printing gap can only refuse.
 */
import { HELD, heldType, isHeldArray, ZONED_HELD } from "./held-types.ts";
import { pgEvalSync } from "./pg-eval.ts";
import type { GapId, PostgresRefuses } from "./gaps.ts";
import type { PgAnalysis } from "./analyze.ts";
import type { CellConv } from "./types.ts";
import { pathIndex, PG_SESSION_SEPARATOR, SESSION_VARIABLE, SETTINGS_VARIABLE, TURN_FUNCTION, type JsonKind, type PgKind } from "./functions.ts";
import { cellsOf, evaluateText, mapCells, numericLiteral, programJson, type NumericProgram } from "../lib/pg-numeric.ts";
import { analysedQueries, caseTwins, FIRST_USER_OID, implicitTimetzCasts, joinsUsing, setOperationOutputs, type Grouping, type Keys, type QueryOutputs, type TreeValue, type Typed } from "./pgtree.ts";
import { evaluated, keysBound, type Unbound } from "./constant-key.ts";
import { canonicalRead, EQUAL_STEPS, KEY_NULL_HEX, KEY_RECOMPUTE_HEX, MARKED_FUNCTIONS, markedError, ORDER_STEPS, readKey, type JsonRead, type KeptLookup } from "./kept-route.ts";
import { JSONB_KEY_FUNCTIONS } from "./jsonb-order.ts";
import { jsonbText, parseJson, storedPairs, type Json } from "./jsonb.ts";
import { atTimeZoneOf, isUtc, UTC_NAMES } from "../lib/timezone.ts";
import type { CaseMapping, DuckCollation, StatementCollations } from "./collation.ts";

/** A parse-tree node (`{ Kind: body }`) and a body, as libpg-query's JSON has them. */
type Body = Record<string, any>;
type AstNode = Record<string, Body>;

/** How text is ordered under a collation, and what an OID of the analysis means: src/duck/collation.ts, the one reader */
export { duckCollation, isLibcCollation, type DuckCollation } from "./collation.ts";

/**
 * A RESULT COLUMN'S EXACT NUMERIC: Postgres computes a numeric with every digit and its own scale rule (`7 / 2.0` is
 * 3.5000000000000000, `round(x, 4)` keeps four decimals, `least(2.5, 1)` is `1`), DuckDB as a DECIMAL(≤38) or a double.
 * Where a result column is a numeric (or a numeric's text), its expression is a program (src/lib/pg-numeric.ts) over
 * CELLS — the parts DuckDB computes exactly (a column, an integer, a sum, a count) — sent as hidden columns after
 * Postgres's, and the runner computes the column from them as Postgres does. A cell DuckDB answers as a double (a
 * float inside an aggregate) leaves the column DuckDB's, the divergence its runner logs.
 */
export interface ExactColumn {
  column: number;
  program: NumericProgram;
  /** each cell's value: exact digits, or a float as Postgres's float8 / float4 → numeric casts write it */
  cells: Array<CellConv>;
  /** the column is the program's text (`(x / 3)::text`) */
  text: boolean;
}

/** a query's output columns' types, as `exactThrough` reads them */
type Fields = ReadonlyArray<{ oid: number; typmod?: number }>;

/** how the ENGINE's GROUP BY holds an expression Postgres groups (`grouping`): as written, by a key in its place whose
 *  readers read the WHOLE expression per group (`keyed`), or by a key in its place whose readers read its COLUMNS per
 *  group (`cells`) */
type GroupedAs = "engine" | "keyed" | "cells";

/** a column of a table's row type, as the catalog has it (its collation pg_attribute's attcollation) */
export interface RowColumn { name: string; type: number; typmod: number; collation: number }

/** Postgres's DEFAULT_COLLATION_OID: the database's collation, a collatable type's own (typcollation) */
const DEFAULT_COLLATION_OID = 100;

/** A statement Postgres would answer and this rewrite cannot make DuckDB answer the same: refused with the way out. */
/** a statement the rewrite refuses: by a gap of src/duck/gaps.ts, or as Postgres refuses it (its SQLSTATE, not a gap) */
/** The catalog's enums (src/duck/plan.ts reads pg_enum): each type's labels in their declared order, by its OID, and
 *  each enum array type's element type. The copy holds an enum as DuckDB's ENUM of the same labels (src/duck/sync.ts),
 *  which orders, groups and compares by them; a value the rewrite hands DuckDB is cast to that ENUM (`enumCast`). */
export interface EnumTypes { labels: ReadonlyMap<number, readonly string[]>; arrays: ReadonlyMap<number, number> }

export class Unrewritable extends Error {
  readonly hint: string;
  readonly gap: GapId | PostgresRefuses;
  constructor(message: string, hint: string, gap: GapId | PostgresRefuses) { super(message); this.hint = hint; this.gap = gap; }
}

// --------------------------------------------------------------------------------------------------------- the types

const INT2 = 21, INT4 = 23, INT8 = 20, FLOAT4 = 700, FLOAT8 = 701, NUMERIC = 1700, TEXT = 25, VARCHAR = 1043, BPCHAR = 1042, NAME = 19, TEXT_ARRAY = 1009, VARCHAR_ARRAY = 1015;
const DATE = 1082, TIMESTAMP = 1114, TIMESTAMPTZ = 1184, INTERVAL = 1186, JSON_OID = 114, JSONB = 3802, UNKNOWN = 705, INET = 869, RECORD = 2249;
const INTEGERS = new Set([INT2, INT4, INT8]);
const FLOATS = new Set([FLOAT4, FLOAT8]);
/** the fields of a time that grow with it, ±Infinity of an infinite one (Postgres 14+); the rest are NULL of it */
const MONOTONIC = new Set(["year", "years", "decade", "decades", "century", "centuries", "millennium", "millennia", "isoyear", "epoch", "julian"]);
/** an interval field's numeric scale: a second's is 6, a millisecond's 3, an epoch's 6 */
const INTERVAL_SCALE: Record<string, string> = { second: "6", seconds: "6", millisecond: "3", milliseconds: "3", epoch: "6" };
const NUMBER_TYPES = new Set([INT2, INT4, INT8, FLOAT4, FLOAT8, NUMERIC]);
/** an array type's element (the numbers', where an IN list's element type decides a comparison) */
const NUMBER_ELEMENT: Record<number, number> = { 1005: INT2, 1007: INT4, 1016: INT8, 1021: FLOAT4, 1022: FLOAT8, 1231: NUMERIC };
const FLOAT8_ARRAY = 1022;
const TEXTS = new Set([TEXT, VARCHAR, BPCHAR, NAME, UNKNOWN]);
/** the text types that carry a collation once analysed (an unknown literal carries none until it is resolved) */
const COLLATED_TEXTS = new Set([TEXT, VARCHAR, BPCHAR, NAME]);
/** the hypothetical-set aggregates (`rank('b') WITHIN GROUP (ORDER BY t)`), which the engine has none of */
const HYPOTHETICAL_SET = new Set(["rank", "dense_rank", "percent_rank", "cume_dist"]);
/** Postgres's error where text is ordered under no collation it could determine (two implicit ones met: `c > i`, a set
 *  operation's column of C and ICU). Postgres raises it where it compares; the plan, where it orders */
const indeterminate = (): Unrewritable => new Unrewritable("could not determine which collation to use for string comparison", "Use the COLLATE clause to set the collation explicitly.", { postgres: "42P22" });
const JSONS = new Set([JSON_OID, JSONB]);
const JSONB_ARRAY = 3807;
const HELD_TYPE_NAMES = new Map(Object.entries(HELD).map(([name, h]) => [h.oid, name] as const));
/** the way out of a jsonb comparison Mason does not key (gap jsonb-compare) */
const JSONB_WAY_OUT = "compare a member (j ->> 'k'), or j::text for the canonical text";
const BOOL = 16, UUID = 2950, TIME = 1083, BYTEA = 17;
/** pg_type's array types of the element types above */
const ARRAYS = new Set([1000, 1001, 1005, 1007, 1009, 1014, 1015, 1016, 1021, 1022, 1115, 1182, 1183, 1185, 1187, 1231, 1270, 2951, 199, 3807]);
/** inet[], which the copy holds as a list of its text (src/duck/sync.ts KEPT_ARRAYS) */
const INET_ARRAY = 1041;
const TIMETZ = 1266;
/** time[] and timetz[] */
const TIME_ARRAY = 1183, TIMETZ_ARRAY = 1270;
/** numeric[] and record[] */
const NUMERIC_ARRAY = 1231, RECORD_ARRAY = 2287;
/** The DuckDB type a Postgres type is cast to (a typmod's numeric(p, s) included), or null where DuckDB has none. */
function duckTypeOf(oid: number, typmod = -1): string[] | null {
  switch (oid) {
    case INT2: return ["smallint"];
    case INT4: return ["integer"];
    case INT8: return ["bigint"];
    case FLOAT4: return ["real"];
    case FLOAT8: return ["double"];
    case NUMERIC: {
      if (typmod < 4) return null;
      const p = ((typmod - 4) >> 16) & 0xffff, s = (typmod - 4) & 0xffff;
      return p <= 38 ? ["decimal", String(p), String(s)] : ["double"];
    }
    case TEXT: case VARCHAR: case BPCHAR: case NAME: case UNKNOWN: return ["varchar"];
    case 16: return ["boolean"];
    case DATE: return ["date"];
    case TIMESTAMP: return ["timestamp"];
    case TIMESTAMPTZ: return ["timestamptz"];
    case INTERVAL: return ["interval"];
    case 1083: return ["time"];
    case TIMETZ: return ["timetz"];
    case 18: return ["varchar"];
    case 2950: return ["uuid"];
    case JSON_OID: case JSONB: return ["json"];
    case 17: return ["blob"];
    default: return null;
  }
}

// ---------------------------------------------------------------------------------------------------- tree builders

const S = (s: string): AstNode => ({ String: { sval: s } });
const strConst = (s: string): AstNode => ({ A_Const: { sval: { sval: s } } });
const intConst = (n: number): AstNode => ({ A_Const: { ival: n === 0 ? {} : { ival: n } } });
const numConst = (text: string): AstNode => ({ A_Const: { fval: { fval: text } } });
const nullConst = (): AstNode => ({ A_Const: { isnull: true } });
const boolConst = (v: boolean): AstNode => ({ A_Const: { boolval: v ? { boolval: true } : {} } });
const arrayOf = (elements: AstNode[]): AstNode => ({ A_ArrayExpr: { elements } });
const or = (args: AstNode[]): AstNode => ({ BoolExpr: { boolop: "OR_EXPR", args } });
const isNotNull = (n: AstNode): AstNode => ({ NullTest: { arg: n, nulltesttype: "IS_NOT_NULL" } });
// a Mason function's first argument is the session (src/duck/functions.ts "every call carries its session"): DuckDB
// folds `getvariable` to the session's literal at bind time
const fn = (name: string, args: AstNode[], extra: Body = {}): AstNode => ({
  FuncCall: { funcname: [S(name)], args: name.startsWith("__mason_") ? [fn("getvariable", [strConst(SESSION_VARIABLE)]), ...args] : args, funcformat: "COERCE_EXPLICIT_CALL", ...extra },
});
const cast = (arg: AstNode, type: string[]): AstNode => ({
  TypeCast: { arg, typeName: { names: [S(type[0]!)], ...(type.length > 1 ? { typmods: type.slice(1).map((t) => intConst(Number(t))) } : {}), typemod: -1 } },
});
/** a value as DuckDB's ENUM of these labels (`CAST(x AS enum('sad', 'ok'))`), or a list of it */
const enumCast = (arg: AstNode, labels: readonly string[], list = false): AstNode => ({ TypeCast: { arg, typeName: { names: [S("enum")], typmods: labels.map(strConst), typemod: -1,
  ...(list ? { arrayBounds: [{ Integer: { ival: -1 } }] } : {}) } } });
const arrayCast = (arg: AstNode, element: string): AstNode => ({ TypeCast: { arg, typeName: { names: [S(element)], typemod: -1, arrayBounds: [{ Integer: { ival: -1 } }] } } });
const op = (name: string, l: AstNode | null, r: AstNode): AstNode => ({ A_Expr: { kind: "AEXPR_OP", name: [S(name)], ...(l === null ? {} : { lexpr: l }), rexpr: r } });
const not = (n: AstNode): AstNode => ({ BoolExpr: { boolop: "NOT_EXPR", args: [n] } });
const and = (args: AstNode[]): AstNode => ({ BoolExpr: { boolop: "AND_EXPR", args } });
/** the call that raises a marked row's error (src/duck/kept-route.ts `markedError`), over the column read */
const markedRaise = (name: string, column: AstNode, e: { code: string; message: string }): AstNode => fn(name, [column, strConst(e.code), strConst(e.message)]);
const caseWhen = (arms: Array<[AstNode, AstNode]>, otherwise: AstNode | null): AstNode => ({
  CaseExpr: { args: arms.map(([expr, result]) => ({ CaseWhen: { expr, result } })), ...(otherwise === null ? {} : { defresult: otherwise }) },
});
const isNull = (n: AstNode): AstNode => ({ NullTest: { arg: n, nulltesttype: "IS_NULL" } });
const collate = (n: AstNode, name: string): AstNode => ({ CollateClause: { arg: n, collname: [S(name)] } });
const row = (args: AstNode[]): AstNode => ({ RowExpr: { args, row_format: "COERCE_EXPLICIT_CALL" } });
const concat = (...parts: AstNode[]): AstNode => parts.reduce((a, b) => op("||", a, b));

const kindOf = (n: AstNode): string => Object.keys(n)[0]!;
const bodyOf = (n: AstNode): Body => n[kindOf(n)]!;
const isNode = (v: unknown): v is AstNode => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && /^[A-Z]/.test(Object.keys(v)[0]!);
const names = (list: unknown): string[] => Array.isArray(list) ? list.map((x) => isNode(x) && kindOf(x) === "String" ? String(bodyOf(x).sval ?? "") : "") : [];
/** a function's or type's name without its `pg_catalog.` */
const lastName = (list: unknown): string => { const n = names(list); return (n[n.length - 1] ?? "").toLowerCase(); };
/** a literal, a parameter, or a cast of one: a value fixed for the statement's run */
const isConstant = (n: AstNode): boolean => {
  const k = kindOf(n);
  if (k === "A_Const" || k === "ParamRef") return true;
  return k === "TypeCast" && isNode(bodyOf(n).arg) && isConstant(bodyOf(n).arg as AstNode);
};
const constString = (n: AstNode | undefined): string | null => n !== undefined && kindOf(n) === "A_Const" && bodyOf(n).sval !== undefined ? String(bodyOf(n).sval.sval ?? "") : null;
const constInt = (n: AstNode | undefined): number | null => {
  if (n === undefined || kindOf(n) !== "A_Const") return null;
  const b = bodyOf(n);
  return b.ival !== undefined ? Number(b.ival.ival ?? 0) : null;
};

// ---------------------------------------------------------------------------------------------------- the rewrite

/** what a raw node kind is analysed into (pgtree.ts's node names), to find ITS entry among those at one offset */
const ANALYSED: Record<string, readonly string[]> = {
  ColumnRef: ["VAR"],
  A_Const: ["CONST"],
  ParamRef: ["PARAM"],
  FuncCall: ["FUNCEXPR", "AGGREF", "WINDOWFUNC", "COERCEVIAIO", "RELABELTYPE", "ARRAYCOERCEEXPR", "OPEXPR", "MINMAXEXPR", "SQLVALUEFUNCTION"],
  A_Expr: ["OPEXPR", "DISTINCTEXPR", "NULLIFEXPR", "SCALARARRAYOPEXPR", "BOOLEXPR", "FUNCEXPR"],
  TypeCast: ["FUNCEXPR", "COERCEVIAIO", "RELABELTYPE", "CONST", "ARRAYCOERCEEXPR", "COERCETODOMAIN"],
  CaseExpr: ["CASEEXPR"], CoalesceExpr: ["COALESCEEXPR"], MinMaxExpr: ["MINMAXEXPR"], SubLink: ["SUBLINK"], NullTest: ["NULLTEST"],
  BoolExpr: ["BOOLEXPR"], A_ArrayExpr: ["ARRAYEXPR"], GroupingFunc: ["GROUPINGFUNC"], RowExpr: ["ROWEXPR"], SQLValueFunction: ["SQLVALUEFUNCTION"],
  A_Indirection: ["SUBSCRIPTINGREF", "FIELDSELECT", "FUNCEXPR"], CollateClause: ["COLLATEEXPR"], BooleanTest: ["BOOLEANTEST"],
};

/**
 * A NODE THE REWRITE PLACED TWICE (the walker's detector, Rewriter.walk): the walker runs a node's rule at its first
 * place only, so a node a rule put in two places is rewritten in one — the json read's column was qualified in the
 * first arm of its CASE alone (42804 from DuckDB; a review finding). Each is a bug of the rule that placed it:
 * it should clone the node per use. Recorded here, never refused (the second place may well need no rule), and held to
 * none by the tests that answer statements (tests/duck-wire.test.ts, tests/duck-corpus.test.ts, the oracle).
 */
const PLACED_TWICE: string[] = [];
function placedTwice(kind: string, b: Body): void {
  if (PLACED_TWICE.length < 100) PLACED_TWICE.push(`a ${kind} at offset ${typeof b.location === "number" ? b.location : "?"}: ${JSON.stringify(b).slice(0, 160)}`);
}
/** the nodes the rewrite placed twice since the process began (at most 100): none, when every rule clones per use */
export const nodesPlacedTwice = (): readonly string[] => PLACED_TWICE;

class Rewriter {
  private readonly types: Map<number, Typed[]>;
  private readonly analysed: PgAnalysis["outputs"];
  private readonly base: number;
  /** what each collation OID of the statement's analysis means (src/duck/collation.ts): the ONE reader of a collation */
  private readonly collations: StatementCollations;
  private readonly params: readonly number[];
  /** bodies whose rule has run: a rule may wrap its own node, which must not be rewritten twice */
  private readonly done = new WeakSet<Body>();
  /** the statement's own bodies (and copies of them): only these are rewritten, never a node a rule built */
  private readonly original = new WeakSet<Body>();
  /** the sort keys `distinctOnSorted` appended, each with its ON expression's binding (the one resolver's, `keysBound`):
   *  no key of the analysis's sort list, which holds the ORDER BY as written */
  private readonly distinctAppended = new WeakMap<Body, { output: Output | null; constant: boolean | null }>();
  /** the statement's own bodies the walk has met, each in its one place (walk) */
  private readonly placed = new WeakSet<Body>();
  /** the bodies whose own rule's answer is being walked: met there, a body is in the place its rule put it */
  private readonly answering = new Set<Body>();
  /** the function calls a FROM reads (a set-returning function there is a table, not unnest's) */
  private readonly inFrom = new WeakSet<Body>();
  /** the set-returning functions in FROM a LEFT JOIN … ON TRUE reads, written as a list never empty (leftLateral) */
  private readonly nonEmpty = new WeakSet<Body>();
  /** such a function whose argument a step of its own before the lateral computes: the step's column (leftLateral) */
  private readonly stepArg = new WeakMap<Body, AstNode>();
  /** the steps leftLateral wrote, each named for its number in the statement */
  private steps = 0;
  /** the joins whose every column a `*` of the SELECT that holds them, or a join's own name, reads (markWholeReads):
   *  a step written into one would be a column of the answer (leftLateral) */
  private readonly readWhole = new WeakSet<Body>();
  /** the SELECTs and joins whose rows' order decides the answer (a LIMIT keeps the first of them, an aggregate or a
   *  window reads them in order): a LEFT lateral of a list is streamed there alone (markBounds, leftLateral) */
  private bounded = new WeakSet<Body>();
  /** the same, were the statement's own rows bounded by a row count on the wire (an Execute's, markBounds): null when
   *  they are (the plan made for that Execute) */
  private boundedOnWire: WeakSet<Body> | null = null;
  /** a LEFT lateral of a list left DuckDB's join that a row count on the wire would stream (leftLateral): the
   *  listener plans the statement again for an Execute that sets one (PlannedSql.unboundedLateral) */
  unboundedLateral = false;
  /**
   * A JSON PATH BOUND AS A PARAMETER, READ AS A CONSTANT (issues 465, 466): the values an Execute bound to the
   * parameters this statement reads as a json read's path or one of its elements, as Postgres's input function read
   * them (src/duck/analyze.ts readParameters: a text as itself, a text[] as its JSON, an integer's digits), by the
   * parameter's number. Empty at a Parse, which cannot see them: there each such read is the function's, and the plan
   * says which parameters would fold (`pathParams`), so the listener plans it again at the Execute with the values.
   */
  boundPaths: ReadonlyMap<number, string> = new Map();
  /** the parameters met as a json read's path, or an element or key of one, of a type read as a constant (`foldParam`) */
  readonly pathParams = new Set<number>();
  /** the parameters the read being written folded, and the text each was bound to (`folded`); null outside a json
   *  read's rule, where nothing folds */
  private folds: Map<number, string> | null = null;
  /** the ANY / ALL comparisons already guarded against a NULL array (the guard holds the comparison, walked again) */
  private readonly nullArrayTested = new WeakSet<Body>();
  /** the catalog's enums: each one's labels in their declared order, and its array type's element */
  private readonly enums: EnumTypes;
  /** THE NAME OF THE HIDDEN CELLS an exact numeric rides on (`exactColumns`, `carry`), a prefix and their place: one no
   *  name the statement writes begins with (issue 239: a user's `__mason_cell_0` was read as a cell, its quotient called
   *  exact, and its double printed). The engine binds a name without regard to case, so neither does the choice */
  cellPrefix = "__mason_cell_";
  /** the catalog's user types by OID (`citext`), for the few the rewrite knows (src/duck/plan.ts reads pg_type) */
  private readonly userTypes: ReadonlyMap<number, string>;
  /** every type holding a citext anywhere in its structure, by the catalog's OID (src/duck/plan.ts `CITEXT_HELD`) */
  private readonly citextHeld: ReadonlySet<number>;
  /** a type a database made as `pg_typeof` names it, the catalog's `regtype` under the session's search_path
   *  (`other.level`, `mood[]`), read by src/duck/plan.ts where the statement calls pg_typeof */
  private readonly typeNames: ReadonlyMap<number, string>;
  /** a copied table's row type: its columns, by the catalog's OID (src/duck/plan.ts) */
  private readonly rowTypes: ReadonlyMap<number, readonly RowColumn[]>;
  /** the session's TimeZone the statement was analysed under (a relative literal's day is its) */
  private readonly timeZone: string;
  /** the session's DateStyle the statement was analysed under: Postgres's input of a date constant reads its order */
  private readonly dateStyle: string;
  /** the stored JSON paths (src/duck/kept-route.ts): null where none is consulted (the feature off, a test) */
  private readonly kept: KeptLookup | null;
  /** every read of a copied table's JSON column by literal steps the statement makes, stored or not: the request log's
   *  `json_reads`, which the keeper's policy reads (src/duck/kept.ts `review`) */
  readonly jsonReads = new Map<string, JsonRead>();
  constructor(analysis: PgAnalysis, base: number, collations: StatementCollations, userTypes: ReadonlyMap<number, string> = new Map(), rowTypes: ReadonlyMap<number, readonly RowColumn[]> = new Map(), timeZone = "UTC", dateStyle = "ISO, MDY",
    enums: EnumTypes = { labels: new Map(), arrays: new Map() }, kept: KeptLookup | null = null, keyCounts: ReadonlySet<number> = new Set(), citextHeld: ReadonlySet<number> = new Set(),
    typeNames: ReadonlyMap<number, string> = new Map()) {
    this.types = analysis.types; this.analysed = analysis.outputs; this.base = base; this.collations = collations; this.params = analysis.params; this.userTypes = userTypes; this.rowTypes = rowTypes; this.timeZone = timeZone; this.dateStyle = dateStyle;
    this.enums = enums; this.kept = kept; this.citextHeld = citextHeld; this.typeNames = typeNames;
    for (const at of keyCounts) this.keyCounts.add(at + base);
    this.twins = caseTwins(analysis.tree);
    this.analysisTree = analysis.tree;
  }

  /** Postgres's analysis of the statement, for what is read of it only where asked (`setOperationColumns`) */
  private readonly analysisTree: TreeValue;

  /** the subqueries and CTEs whose columns have twins in another case, by the name the query calls them (caseTwins) */
  private readonly twins: Map<string, string[]>;

  /**
   * THE count(DISTINCT x) WHOSE DISTINCT CHANGES NOTHING, by the raw node's offset: x a column unique on the source and
   * its table's rows not repeated by the FROM, decided over Postgres's analysis (src/duck/distinct-key.ts), and the
   * same call repeated in its own SELECT's ORDER BY (`repeatedKeyCounts`). Each is counted without its DISTINCT
   * (`funcCall`): DuckDB's hash aggregate of every value, which finds no duplicate, is what that saves.
   */
  private readonly keyCounts = new Set<number>();

  /**
   * An ORDER BY (or a window's) that repeats a count(DISTINCT x) of its SELECT list is analysed as THAT target
   * (findTargetlistEntrySQL99): its own offset is in no AGGREF, so the decision never saw it. It is the same call over
   * the same FROM, so it drops its DISTINCT where its twin in the SAME SELECT did — never by a twin in another SELECT,
   * whose `x` may be another table's column.
   */
  repeatedKeyCounts(root: AstNode): void {
    if (this.keyCounts.size === 0) return;
    const select = (b: Body): void => {
      const own: Body[] = [];
      const collect = (v: unknown): void => {
        if (Array.isArray(v)) { for (const x of v) collect(x); return; }
        if (v === null || typeof v !== "object") return;
        if (isNode(v) && kindOf(v) === "SelectStmt") { select(bodyOf(v)); return; }
        if (isNode(v) && kindOf(v) === "FuncCall" && bodyOf(v).agg_distinct === true && lastName(bodyOf(v).funcname) === "count") own.push(bodyOf(v));
        for (const [k, x] of Object.entries(isNode(v) ? bodyOf(v) : v as Body)) { const arm = armOf(k, x); if (arm !== null) select(bodyOf(arm)); else collect(x); }
      };
      for (const [k, x] of Object.entries(b)) { const arm = armOf(k, x); if (arm !== null) select(bodyOf(arm)); else collect(x); }
      const dropped = new Set(own.filter((f) => this.keyCounts.has(f.location)).map((f) => shapeOf({ FuncCall: f })));
      for (const f of own) {
        if (typeof f.location === "number" && !this.keyCounts.has(f.location) && this.at(f, ["AGGREF"]) === null && dropped.has(shapeOf({ FuncCall: f }))) this.keyCounts.add(f.location);
      }
    };
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) visit(x); return; }
      if (v === null || typeof v !== "object") return;
      if (isNode(v) && kindOf(v) === "SelectStmt") { select(bodyOf(v)); return; }
      for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) visit(x);
    };
    visit(root);
  }

  /**
   * A STORED JSON PATH READ FROM ITS COLUMN (docs/DESIGN.md "Stored JSON paths"): `l` a copied table's
   * json or jsonb column (Typed.relation) read by literal `steps` — recorded as one of the statement's reads (as its
   * one path: canonicalRead), and, when every row of its path is stored (READY, src/duck/kept.ts), answered from the
   * hidden column ALONE: the read names no document, so DuckDB reads only the stored column (on the test server a
   * whole-table read through a CASE whose fallback named the document still read every document: 41.6 s, where a small
   * column's scan took 8.5 s). The column holds the path's `->` answer (the value's JSON text) or `KEPT_NULL` (a NULL
   * answer), so `->` is the column with the mark read as NULL, and `->>` is derived from it (`keptText`). Only a path
   * whose column is not EXACT — a row unset, or marked to be computed (src/duck/functions.ts keptJsonValue) — keeps
   * the document: `CASE WHEN <col> IS NULL OR <col> = KEPT_RECOMPUTE THEN <the call> ELSE <from the column> END`.
   * null: not such a read, or not stored — the caller writes the call.
   */
  private keptRead(l: AstNode, steps: AstNode, either: boolean, canonical: boolean, asText: boolean): AstNode | null {
    // a path bound as a parameter is read natively, never from its stored column, and is no read the policy counts:
    // a stored path read under a late select list or a keyed GROUP BY names its column where it is not (issue 919)
    if (this.folds !== null && this.folds.size > 0) return null;
    if (this.kept === null || kindOf(l) !== "ColumnRef") return null;
    const path = constString(steps);
    const fields = (bodyOf(l).fields ?? []) as AstNode[];
    const last = fields.at(-1);
    const t = this.typed(l);
    if (path === null || last === undefined || kindOf(last) !== "String" || t === null || t.node !== "VAR" || t.relation === undefined || t.renamed !== null) return null;
    const at = this.kept.at(t.relation.relid, t.relation.attno);
    if (at === null) return null;
    const read: JsonRead = canonicalRead({ source: at.source, column: at.column, steps: path, either, canonical, asText });
    this.jsonReads.set(readKey(read), read);
    const ready = this.kept.ready(read);
    if (ready === null) return null;
    // the column as the statement names it (its FROM item's alias or table, as rule() qualifies a bare one)
    const prefix = fields.length === 1 && t.qualifier !== null ? [S(t.qualifier)] : fields.slice(0, -1).map((f) => structuredClone(f));
    const column = (): AstNode => ({ ColumnRef: { fields: [...prefix.map((f) => structuredClone(f)), S(ready.name)] } });
    const nul = (): AstNode => fn("chr", [intConst(0)]);
    const recompute = (): AstNode => op("||", nul(), strConst("!"));
    const value = asText ? keptText(column, canonical) : caseWhen([[op("=", column(), nul()), nullConst()]], column());
    // a row marked since the path was counted exact is never read as its value: it raises (kept-route.ts markedError)
    if (ready.exact) return caseWhen([[op("=", column(), recompute()), markedRaise(MARKED_FUNCTIONS.value, column(), markedError(read, false))]], value);
    // (a copied table's column, checked above: a jsonb's text is the copy's canonical one)
    return caseWhen([[or([isNull(column()), op("=", column(), recompute())]), jsonGet(this.cp, l, steps, either, canonical, asText, canonical)]], value);
  }

  /**
   * A JSON READ OFF `base` BY `steps`: from its stored column where every row holds it (keptRead), else DuckDB's own
   * read where that is Postgres's answer, else the function (jsonGet). A jsonb's text holds each key once only where it
   * is a COPIED TABLE'S column (the copy holds Postgres's canonical text; Typed.relation, as the stored paths find a
   * column's table): a jsonb the statement computes — jsonb_object_agg, jsonb_build_object, in a CTE, a subquery or an
   * arm of a UNION — is written by the rewrite as text that may hold a key twice, whose `->>` in Postgres is the LAST
   * value, so its read checks every object on the way as a json column's does (a review finding).
   */
  private jsonRead(base: AstNode, steps: AstNode, either: boolean, canonical: boolean, asText: boolean): AstNode {
    return this.keptRead(base, steps, either, canonical, asText) ?? jsonGet(this.cp, base, steps, either, canonical, asText, canonical && this.copiedColumn(base));
  }

  /** `l <name> r`, a json read (`->`, `->>`, `#>`, `#>>`, `a0` json or jsonb), as the document it reads and its steps:
   *  `(c -> 'a') ->> 'b'` is one read at the steps a, b (jsonChain). The one reading of a read's operands, for the
   *  operator (aExpr) and its nullness (jsonNullTest) alike */
  private jsonReadOf(name: string, l: AstNode, r: AstNode, a0: number, a1: number | null): { base: AstNode; steps: AstNode; either: boolean; canonical: boolean } {
    const either = name.startsWith("#");
    let steps = either ? this.jsonPath(r) : this.jsonKey(r, a1), base = l;
    const chain = this.jsonChain(l, either), literal = constString(steps);
    if (chain !== null && literal !== null) { base = chain.base; steps = strConst(JSON.stringify([...chain.steps, ...JSON.parse(literal) as unknown[]])); }
    return { base, steps, either, canonical: a0 === JSONB };
  }

  /** a copied table's column (Typed.relation): its jsonb text is the copy's, Postgres's canonical text, each key once */
  private copiedColumn(n: AstNode): boolean {
    const t = kindOf(n) === "ColumnRef" ? this.typed(n) : null;
    return t !== null && t.node === "VAR" && t.relation !== undefined;
  }

  /**
   * `(<a ->/#> read>) IS [NOT] NULL` (issue 130: a BI tool's "is not empty" filter, `(j -> 'a') IS NOT NULL`): the read's
   * NULLNESS alone, which needs no text of the value — SQL NULL only for a missing path or a NULL document, a JSON null
   * being a value — so `json_extract(doc, path) IS [NOT] NULL`, one parse and no row through the function, whatever
   * the value's kind. A stored path's column first (keptRead), as for the read itself. Native off a COLUMN, by keys only
   * (duckJsonPath), and where DuckDB finds the key Postgres does: a copied jsonb (each key once), or a json column read
   * by one key (a key held twice is present whichever occurrence is read; deeper, the first and the last may differ).
   * Null for anything else: the read is rewritten as itself and tested.
   */
  private jsonNullTest(b: Body): AstNode | null {
    const arg = b.arg as AstNode | undefined;
    if (arg === undefined || kindOf(arg) !== "A_Expr") return null;
    const e = bodyOf(arg), name = lastName(e.name);
    if (e.kind !== "AEXPR_OP" || (name !== "->" && name !== "#>") || e.lexpr === undefined || e.rexpr === undefined) return null;
    const t = this.typed(arg);
    const a0 = t?.args[0]?.type ?? null, a1 = t?.args[1]?.type ?? null;
    if (a0 === null || !JSONS.has(a0)) return null;
    const { base, steps, either, canonical } = this.jsonReadOf(name, e.lexpr as AstNode, e.rexpr as AstNode, a0, a1);
    // (a path the Parse cannot see is the read's own: nothing made here is placed)
    const keys = stepKeys(steps, either);
    const path = keys === null || keys.length === 0 || kindOf(base) !== "ColumnRef" ? null : duckJsonPath(keys);
    if (path === null) return null;
    const kept = this.keptRead(base, steps, either, canonical, false);
    if (kept !== null) return { NullTest: { ...b, arg: kept } };
    if (!(canonical && this.copiedColumn(base)) && keys!.length !== 1) return null;
    return { NullTest: { ...b, arg: fn("json_extract", [this.cp(base), strConst(path)]) } };
  }

  /**
   * `doc @> template` (`template <@ doc`) in DuckDB's own SQL where that is Postgres's answer (nativeContains): `doc` a
   * copied table's jsonb column, `template` a constant Postgres read as a jsonb — its canonical text as jsonb_in and
   * jsonb_out make it (a key written twice keeps its last value), from the analysis and Postgres itself, never the
   * statement's text read again. Null for anything else (a parameter, an expression, a column on the right, a json
   * template that is not an object or holds an array): the caller keeps the function.
   */
  private containsRead(doc: AstNode, template: AstNode): AstNode | null {
    if (!this.copiedColumn(doc) || this.typeOf(doc) !== JSONB) return null;
    const c = this.constRead(template);
    const written = constString(kindOf(template) === "TypeCast" ? bodyOf(template).arg as AstNode : template);
    if (c === null || c.node !== "CONST" || c.type !== JSONB || written === null) return null;
    // (the text Postgres validated at the Parse, as jsonb writes it: jsonbText, the model the function's own parse of a
    // template is; never pgEvalSync, whose first call starts its Postgres on the listener's thread, ~1 s that every
    // session waits)
    const canonical = jsonbText(written);
    // the rows the native read cannot decide go to the function with the template as jsonb holds it (its last value of
    // a key written twice)
    return nativeContains(this.cp, doc, parseJson(canonical), fn("__mason_jsonb_contains", [jsonArg(doc), strConst(canonical)]));
  }

  private isCitext(oid: number | null): boolean { return oid !== null && this.userTypes.get(oid) === "citext"; }
  /** A CITEXT ANYWHERE IN THE TYPE'S STRUCTURE (PR 674 shrink 2, the class citext compared by bytes in a quantified
   *  subquery): the type itself, an array's element, a domain's base, a composite's attributes, a range's subtype, to
   *  any depth, as the catalog says (`citextHeld`). Every refusal of a comparison that would read a citext by its bytes
   *  asks this, never the top-level type alone: an array of citext, or of a domain over one, compared by ALL */
  private holdsCitext(oid: number | null | undefined): boolean { return oid !== null && oid !== undefined && (this.isCitext(oid) || this.citextHeld.has(oid)); }

  /** a text lower-cased by the database's case mapping (what Postgres's citext compares, sorts and groups: str_tolower
   *  under the default collation) */
  private lowerOf(n: AstNode): AstNode {
    return this.caseCall("lower", n, this.collations.caseOf(DEFAULT_COLLATION_OID));
  }

  /** upper / lower / initcap of a text under a case mapping: glibc's upper and lower the engine's own (its upper with
   *  `ß` kept, which glibc's towupper keeps: an exhaustive comparison over every code point differed only in letters
   *  newer than the server's glibc), every other mapping src/duck/functions.ts's */
  private caseCall(name: "upper" | "lower" | "initcap", arg: AstNode, m: CaseMapping): AstNode {
    if (name === "initcap") return fn("__mason_initcap", [arg, strConst(m)]);
    if (m !== "libc") return fn("__mason_case", [arg, boolConst(name === "upper"), strConst(m)]);
    return name === "lower" ? fn("lower", [arg]) : fn("replace", [fn("upper", [fn("replace", [arg, strConst("ß"), strConst("﷐")])]), strConst("﷐"), strConst("ß")]);
  }

  /** THE CASE MAPPING an upper / lower / initcap call maps under: its input collation, as Postgres's analysis resolved
   *  it (`Typed.inputCollation`: a COLLATE, a column's, a concatenation's, never the database's by default), and what
   *  that collation means for case (src/duck/collation.ts `caseOf`). Postgres's 42P22 where the analysis could
   *  determine none (two implicit collations in conflict) */
  private caseMapping(t: Typed | null, name: string): CaseMapping {
    const coll = t === null ? DEFAULT_COLLATION_OID : t.inputCollation;
    if (coll === 0) throw new Unrewritable(`could not determine which collation to use for ${name}() function`, "Use the COLLATE clause to set the collation explicitly.", { postgres: "42P22" });
    return this.collations.caseOf(coll);
  }

  /** a citext value as the text citext compares: lower-cased, typed as text under the database's collation, so the
   *  text rules (the collation's sort keys, LIKE's escape) apply to it */
  private foldCitext(n: AstNode): AstNode {
    const out = this.lowerOf(n);
    // (under the citext's own collation, as citext_cmp compares: its type's, the database's, where the analysis has none)
    const collation = this.typed(n)?.collation ?? DEFAULT_COLLATION_OID;
    this.synthetic.set(bodyOf(out), { node: "FUNCEXPR", type: TEXT, typmod: -1, args: [], oid: null, format: null, collation, inputCollation: collation, levelsUp: null, datum: null, qualifier: null, renamed: null });
    return out;
  }

  /** the nodes the rewrite made whose type it decided itself (a citext lower-cased to text) */
  private readonly synthetic = new WeakMap<Body, Typed>();

  /** every CTE the statement declares, by name, from the queries walked so far (a subquery may read an outer one's) */
  private readonly ctes = new Map<string, AstNode>();

  /** What Postgres made of this raw node: its entry at the node's offset, of a kind the raw kind is analysed into. */
  typed(n: AstNode): Typed | null {
    const own = this.typedAt(n);
    if (own !== null) return own;
    // an ORDER BY or a window's ORDER BY that repeats an expression of the SELECT list is analysed as THAT target
    // (findTargetlistEntrySQL99): its own offset is in no analysed node, the same expression's elsewhere is
    return this.byShape.get(shapeOf(n)) ?? null;
  }

  /** the nodes the rewrite made that Postgres analysed as another: typed as that one */
  private readonly typedLike = new WeakMap<Body, AstNode>();
  /** a row the SELECT list writes as its text (`rowValues`): an output a key sorts by must never be one (`rowKey`) */
  private readonly rowTexts = new WeakSet<Body>();
  /** what `widen` made, and the type it made it: a rule after it reads that type (a date widened to a timestamptz is
   *  one, never cast again), and a second pass leaves it as it is — a SELECT's expression and its GROUP BY twin must
   *  print alike, or DuckDB refuses the grouping (42803) */
  private readonly widened = new WeakMap<Body, number>();

  /** a literal Postgres analysed only where the statement repeats it (src/duck/rewrite.ts `typeCast`) */
  private readonly constLike = new WeakMap<Body, Typed>();

  /** the analysed type of each expression's shape (its tree less offsets), from the first place it was analysed */
  private readonly byShape = new Map<string, Typed>();
  /** each COLLATE's analysed node by its shape, from the first place it was analysed: an ORDER BY that repeats a target
   *  (findTargetlistEntrySQL99) has none at its own offset (`collationOf`) */
  private readonly collatedByShape = new Map<string, Typed>();
  /** a COLLATE's analysed node, read once (`collateTyped`): a rule may rewrite its argument after */
  private readonly collateOf = new WeakMap<Body, Typed>();

  /** after `adopt`: every expression of the statement whose offset Postgres analysed, by its shape */
  indexShapes(v: unknown): void {
    if (Array.isArray(v)) { for (const x of v) this.indexShapes(x); return; }
    if (v === null || typeof v !== "object") return;
    if (isNode(v)) {
      const t = this.typedAt(v);
      if (t !== null) { const k = shapeOf(v); if (!this.byShape.has(k)) this.byShape.set(k, t); }
      // a COLLATE's own node (its collation, which `typedAt` reads through to its argument's type)
      const own = kindOf(v) === "CollateClause" ? this.at(bodyOf(v), ["COLLATEEXPR"]) : null;
      if (own !== null) { const k = shapeOf(v); if (!this.collatedByShape.has(k)) this.collatedByShape.set(k, own); }
    }
    for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) this.indexShapes(x);
  }

  private typedAt(n: AstNode): Typed | null { return this.ownEntries(n)[0] ?? null; }

  /**
   * A RAW NODE'S OWN ANALYSED ENTRIES, its own first (`typedAt`): those at its offset of a kind it is analysed into. Most
   * nodes have one; an expression Postgres copies has one a copy (BETWEEN's operand is in both of its comparisons).
   */
  private ownEntries(n: AstNode): readonly Typed[] {
    const k = kindOf(n);
    const b = bodyOf(n);
    const own = this.synthetic.get(b);
    if (own !== undefined) return [own];
    if (k === "TypeCast") {
      // a cast to the type the value already has leaves no node of its own: the value's
      const cast = this.allAt(b, ANALYSED.TypeCast!);
      return cast.length > 0 ? cast : b.arg !== undefined ? this.ownEntries(b.arg) : [];
    }
    if (k === "CollateClause") return b.arg !== undefined ? this.ownEntries(b.arg) : [];
    // a node the rewrite made that reads as another (decidedByKey's any_value, a set operation's sort column)
    const like = this.typedLike.get(b);
    if (like !== undefined) { const t = this.typed(like); return t === null ? [] : [t]; }
    const kinds = ANALYSED[k];
    return kinds === undefined ? [] : this.allAt(b, kinds);
  }

  private at(b: Body, kinds: readonly string[]): Typed | null {
    if (typeof b.location !== "number" || b.location < 0) return null;
    return this.types.get(b.location - this.base)?.find((t) => kinds.includes(t.node)) ?? null;
  }
  private allAt(b: Body, kinds: readonly string[]): readonly Typed[] {
    if (typeof b.location !== "number" || b.location < 0) return [];
    return this.types.get(b.location - this.base)?.filter((t) => kinds.includes(t.node)) ?? [];
  }

  typeOf(n: AstNode): number | null { return this.widened.get(bodyOf(n)) ?? this.typed(n)?.type ?? null; }

  // ------------------------------------------------------------------------------------------------ the walk

  /** marks every body of the statement as its own */
  adopt(v: unknown): void {
    if (Array.isArray(v)) { for (const x of v) this.adopt(x); return; }
    if (v === null || typeof v !== "object") return;
    if (isNode(v)) this.original.add(bodyOf(v));
    if (isNode(v) && kindOf(v) === "SelectStmt") {
      this.unplacedSelect(bodyOf(v));
      for (const s of (bodyOf(v).sortClause ?? []) as AstNode[]) if (isNode(s) && kindOf(s) === "SortBy") this.writtenKeys.add(bodyOf(s));
    }
    for (const [k, x] of Object.entries(isNode(v) ? bodyOf(v) : v as Body)) this.adopt(armOf(k, x) ?? x);
  }

  /**
   * THE KEYS OF THE STATEMENT'S OWN ORDER BY (the class "a statement's sort keys read from the rewritten tree", PR 231):
   * each SortBy as Postgres parsed it, marked before any rule runs. Postgres's analysis sorts by exactly these
   * (transformSortClause; a DISTINCT ON's expressions its ORDER BY lacks go to its distinctClause, never its
   * sortClause), and FETCH … WITH TIES ties on its sortClause alone. A rule that adds a key for its own sort (a DISTINCT
   * ON's, `distinctOnSorted`, which a DISTINCT over an exact numeric becomes) adds none of these, so it never reaches
   * the ties. A copy of one is one (`clone`); a key folded from two of them stands for both (`nullsKeyFolded`).
   */
  private readonly writtenKeys = new WeakSet<Body>();

  /** a SELECT whose targets hold no offset (`TABLE t`): what else knows its query in Postgres's analysis
   *  (`analysedQuery`), by its targets, which the rewrite keeps as they are (a list made anew holds the same targets) */
  private readonly unplacedTargets = new WeakMap<Body, { from: string[]; limits: number[] }>();

  private unplacedSelect(b: Body): void {
    const targets = b.targetList;
    if (!Array.isArray(targets) || targets.length === 0 || this.offsetsIn(targets).length > 0) return;
    if (!targets.every((t) => isNode(t) && hasStar(bodyOf(t).val))) return;
    const from = ((b.fromClause ?? []) as AstNode[]).map((f) => kindOf(f) === "RangeVar" ? String(bodyOf(f).alias?.aliasname ?? bodyOf(f).relname) : null);
    if (from.length === 0 || from.some((f) => f === null)) return;
    for (const t of targets as AstNode[]) this.unplacedTargets.set(bodyOf(t), { from: from as string[], limits: this.offsetsIn([b.limitCount, b.limitOffset]) });
  }

  /** the offsets a part of the statement holds, as Postgres's analysis numbers them (a subquery's are its own) */
  private offsetsIn(n: unknown): number[] {
    if (Array.isArray(n)) return n.flatMap((x) => this.offsetsIn(x));
    if (n === null || typeof n !== "object") return [];
    return Object.entries(n).flatMap(([k, x]) => k === "location" && typeof x === "number" ? (x >= 0 ? [x - this.base] : []) : k === "subselect" || k === "SelectStmt" ? [] : this.offsetsIn(x));
  }

  /**
   * WHICH OF POSTGRES'S ANALYSED QUERIES A PART OF THE STATEMENT IS (the class "a fact looked up by an offset the parse
   * does not hold", PR 231: `TABLE t` writes its `*` at none, so its query, and a set operation of it, were found by
   * nothing): each candidate is scored by the evidence both sides hold, a side that holds none no evidence either way;
   * one that holds some is that many points where it agrees and out where it does not. The best are the one where they
   * are what is read of them alike (`same`: two `TABLE t` of one table are one expansion); else none is.
   */
  private picked<T>(candidates: readonly T[], evidence: (c: T) => Array<{ parse: number[]; analysed: number[] }>, same: (c: T) => string): T | undefined {
    const scored = candidates.map((c) => {
      let score = 0;
      for (const e of evidence(c)) {
        if (e.parse.length === 0 || e.analysed.length === 0) continue;
        if (!e.parse.some((o) => e.analysed.includes(o))) return { c, score: -1 };
        score++;
      }
      return { c, score };
    }).filter((s) => s.score >= 0);
    const best = Math.max(...scored.map((s) => s.score));
    const top = scored.filter((s) => s.score === best);
    if (top.length === 0) return undefined;
    const first = same(top[0]!.c);
    return top.every((s) => same(s.c) === first) ? top[0]!.c : undefined;
  }

  /** `clone` for the helpers outside the class */
  readonly cp: Copy = (n) => this.clone(n);

  /** a deep copy that stays the statement's own (a rule that uses a node twice rewrites each use) */
  clone<T>(v: T): T {
    if (Array.isArray(v)) return v.map((x) => this.clone(x) as unknown) as T;
    if (v === null || typeof v !== "object") return v;
    const out: Body = {};
    for (const [k, x] of Object.entries(v as Body)) {
      out[k] = this.clone(x);
      // (a set operation's arm is a bare body, the statement's own as `adopt` marks it, so its copy is too: else a copy's
      // arm ran no SELECT rule — its WITH TIES printed as a LIMIT, refused at the read-back; PR 415's CI, a scalar
      // subquery's copy, `subqueryText`)
      if (armOf(k, x) !== null && this.original.has(x as Body)) this.original.add(out[k] as Body);
    }
    if (isNode(v) && this.original.has(bodyOf(v))) this.original.add(bodyOf(out as AstNode));
    if (isNode(v) && this.elementsUnread.has(bodyOf(v))) this.elementsUnread.add(bodyOf(out as AstNode));
    if (isNode(v) && this.writtenKeys.has(bodyOf(v))) this.writtenKeys.add(bodyOf(out as AstNode));
    if (isNode(v) && this.readPerGroup.has(bodyOf(v))) this.readPerGroup.add(bodyOf(out as AstNode));
    if (isNode(v) && this.nativeKeys.has(bodyOf(v))) this.nativeKeys.add(bodyOf(out as AstNode));
    // a node the rewrite typed itself stays typed (a picked operand of min / max, exactOf)
    const own = isNode(v) ? this.synthetic.get(bodyOf(v)) : undefined;
    if (own !== undefined) this.synthetic.set(bodyOf(out as AstNode), own);
    // and one typed as another (decidedByKey's any_value): a grouped ORDER BY 1 over a jsonb is keyed over its copy
    const like = isNode(v) ? this.typedLike.get(bodyOf(v)) : undefined;
    if (like !== undefined) this.typedLike.set(bodyOf(out as AstNode), like);
    // and a column reference the rewrite wrote is read where it was (a `*` written out: `refScopes`)
    const scope = isNode(v) ? this.refScopes.get(bodyOf(v)) : undefined;
    if (scope !== undefined) this.refScopes.set(bodyOf(out as AstNode), scope);
    // a query already derived is that derivation, its cells selected (issue 342: a WITH query copied after a reader
    // derived it selected its cells, and the copy, derived again, recorded none; a union beside it was two widths)
    const record = this.derived.get(v as object);
    if (record !== undefined) this.derived.set(out, record.map((e) => ({ ...e })));
    // and its columns' decisions (`decided`), so a copy reads the decision its original took, never takes it again
    const decisions = this.decisions.get(v as object);
    if (decisions !== undefined) this.decisions.set(out, new Map(decisions));
    // and its GROUP BY as Postgres analysed it (`grouping`), recorded before a rule wrote its clause for the engine: a
    // copy of a SELECT whose clause holds a jsonb's key in its place still groups the expression
    const grouping = this.groupings.get(v as object);
    if (grouping !== undefined) this.groupings.set(out, new Map(grouping));
    // and an arm `exactArms` wrapped is still the arm it reads
    if (this.armWrapped.has(v as object)) {
      const subquery = ((out.fromClause as AstNode[] | undefined)?.[0] !== undefined ? bodyOf((out.fromClause as AstNode[])[0]!).subquery : undefined) as AstNode | undefined;
      if (subquery !== undefined) this.armWrapped.set(out, bodyOf(subquery));
    }
    return out as T;
  }

  walk(v: unknown): unknown {
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) {
        const w = this.walk(x);
        // a rule may answer several nodes for one (a sort key is several under a libc collation)
        if (Array.isArray(w) && isNode(x)) out.push(...w); else out.push(w);
      }
      return out;
    }
    if (v === null || typeof v !== "object") return v;
    if (isNode(v)) {
      const k = kindOf(v);
      const b = bodyOf(v);
      // A COLUMN OF AN EXPRESSION GROUPED BY ITS KEY ALONE, READ PER GROUP (`readPerGroup`, decidedByKey; issue 665):
      // wrapped here, after every rule above it has read the expression as Postgres analysed it; its own rule runs on it
      // as the aggregate's argument, as on any column (a cell a carried program reads is the rewrite's own: no rule).
      // ALL FROM ONE ROW: `first`, never any_value, which skips a NULL, so two columns of the expression could come from
      // two rows (`(coalesce(x, 0) + coalesce(y, 0)) / 7` of (7, NULL) and (NULL, 7) is 1; of the one's 7 and the
      // other's 7 it is 2). Every row of the group holds the one exact value, so one row's columns compute it; the
      // engine's first() of a group's aggregates is one row for each (their states are made and merged together)
      if (k === "ColumnRef" && this.readPerGroup.has(b)) {
        this.readPerGroup.delete(b);
        const call: AstNode = { FuncCall: { funcname: [S("first")], args: [v], funcformat: "COERCE_EXPLICIT_CALL" } };
        this.done.add(bodyOf(call));
        this.typedLike.set(bodyOf(call), v);
        return this.walk(call);
      }
      if (this.original.has(b)) {
        // ONE PLACE PER NODE: a body met again, outside its own rule's answer, is a node a rule placed twice — and the
        // second place would skip its rule (qualified or renamed in its first place alone; a review finding).
        // A rule that uses a node twice clones it per use (`clone`, `cp`)
        if (this.placed.has(b) && !this.answering.has(b)) placedTwice(k, b);
        this.placed.add(b);
      }
      if (this.original.has(b) && !this.done.has(b)) {
        this.done.add(b);
        const r = this.rule(k, b);
        if (r !== null) {
          // the answer may hold the node itself (a rule wrapping its own node): that is the same place
          this.answering.add(b);
          try { return Array.isArray(r) ? r.map((x) => this.walk(x)) : this.walk(r); }
          finally { this.answering.delete(b); }
        }
      }
      return { [k]: this.walkBody(b) };
    }
    return this.walkBody(v as Body);
  }

  private walkBody(b: Body): Body {
    const out: Body = {};
    for (const [key, x] of Object.entries(b)) {
      const arm = armOf(key, x);
      if (arm === null) { out[key] = this.walk(x); continue; }
      // a set operation's arm is a query of its own: every rule of a SELECT (its GROUP BY's decided columns, its ORDER
      // BY's collation, its WITH TIES) applies to it, as to the statement
      const w = this.walk(arm);
      if (!isNode(w) || kindOf(w) !== "SelectStmt") throw new Unrewritable("this arm of a set operation is not supported by Mason", "write the arm as a subquery: SELECT * FROM (…) AS a", "unverified");
      out[key] = bodyOf(w);
    }
    return out;
  }

  /** a node's rewrite, or null to keep it (its children are still walked) */
  private rule(k: string, b: Body): AstNode | AstNode[] | null {
    switch (k) {
      case "SelectStmt": return this.select(b);
      case "A_Expr": return this.aExpr(b);
      case "FuncCall": { const r = this.funcCall(b); if (r === null && b.agg_within_group === true) this.widenArgs(b); return r; }
      case "TypeCast": return this.typeCast(b);
      case "A_Const": return this.aConst(b);
      case "ParamRef": return this.param(b);
      case "SortBy": return this.sortBy(b, null, null);
      case "RangeFunction": return this.rangeFunction(b);
      case "JoinExpr": return this.leftLateral(b);
      case "CollateClause": return this.collateClause(b);
      case "MinMaxExpr": return this.minMax(b);
      case "SQLValueFunction": return this.sqlValueFunction(b);
      case "NullTest": return this.folded(() => this.jsonNullTest(b), () => ({ NullTest: { ...b } }));
      // CASE x WHEN v …: each WHEN is x = v, jsonb's equality for a jsonb (its keys compared)
      case "CaseExpr": {
        this.caseOfNumericParam(b);
        if (!isNode(b.arg) || (this.typeOf(b.arg) !== JSONB && this.typeOf(b.arg) !== JSONB_ARRAY)) return null;
        b.arg = this.equated(b.arg, "CASE … WHEN of");
        for (const w of (b.args ?? []) as AstNode[]) if (isNode(bodyOf(w).expr)) bodyOf(w).expr = this.equalKey(bodyOf(w).expr as AstNode);
        return null;
      }
      // x IN (SELECT …), x = ANY / ALL (SELECT …): the subquery's values compared with x by jsonb's equality
      case "SubLink": {
        if (b.subLinkType === "ARRAY_SUBLINK") { this.arraySubquery(b); return null; }
        if (!isNode(b.testexpr) || !["ANY_SUBLINK", "ALL_SUBLINK", "ROWCOMPARE_SUBLINK"].includes(String(b.subLinkType))) return null;
        const type = this.typeOf(b.testexpr);
        if (type === JSONB || type === JSONB_ARRAY || this.rowHoldsJsonb(b.testexpr)) throw new Unrewritable("a jsonb compared with a subquery's values (IN (SELECT …), = ANY (SELECT …)) is not supported by Mason (Postgres equates jsonb by its own rules)", "join the subquery instead: … JOIN (SELECT …) s ON s.v = t.j", "jsonb-compare");
        return this.sublinkCompared(b);
      }
      // a row as a value anywhere but the SELECT list, a cast to text and the json functions (rowValues) is a struct
      // to DuckDB, compared, tested and grouped by its rules
      case "ColumnRef": case "RowExpr": {
        const t = this.typed({ [k]: b });
        if (t !== null && (k === "RowExpr" ? t.node === "ROWEXPR" : t.node === "VAR" && this.isRowType(t.type))) {
          throw new Unrewritable("a row used as a value here (compared, tested, grouped or sorted) is not supported by Mason", "compare, test or sort its columns", "row-value");
        }
        // a bare name another FROM item has in another case (`"Email"` beside `email`) is ambiguous to DuckDB, which
        // binds names case-insensitively: it is qualified with the FROM item Postgres resolved it to
        // and a column its subquery has twice in two cases (`"T"`, `t`) is that subquery's renamed one (caseTwins)
        const fields = (b.fields ?? []) as AstNode[];
        const last = fields.at(-1);
        // a function's whole row by its FROM name alone, where the function is one column and no row (`e` of
        // `jsonb_array_elements(x) e`, whose column is `value`): that column, which DuckDB would read as a struct
        const whole = k === "ColumnRef" && t?.node === "VAR" && fields.length === 1 && last !== undefined && kindOf(last) === "String" ? t.functionColumn : undefined;
        if (whole !== undefined && String(bodyOf(last!).sval) !== whole.column) return { ColumnRef: { ...b, fields: [S(whole.alias), S(t!.renamed ?? whole.column)] } };
        if (k === "ColumnRef" && t?.node === "VAR" && last !== undefined && kindOf(last) === "String" && (t.renamed !== null || (t.qualifier !== null && fields.length === 1))) {
          const prefix = fields.length === 1 && t.qualifier !== null ? [S(t.qualifier)] : fields.slice(0, -1);
          return { ColumnRef: { ...b, fields: [...prefix, t.renamed !== null ? S(t.renamed) : last] } };
        }
        return null;
      }
      case "RangeSubselect": case "RangeVar": {
        // a subquery or a CTE whose columns have twins in another case: named by an alias list, the twins renamed
        const alias = b.alias as Body | undefined;
        const name = alias?.aliasname ?? (k === "RangeVar" ? b.relname : undefined);
        const names = typeof name === "string" && alias?.colnames === undefined ? this.twins.get(name) : undefined;
        if (names !== undefined) b.alias = { ...(alias ?? {}), aliasname: name, colnames: names.map(S) };
        // a VALUES list's columns by Postgres's names, which DuckDB's are not (a `*`'s key reads them by name)
        const rows = k === "RangeSubselect" && isNode(b.subquery) ? bodyOf(b.subquery).valuesLists as AstNode[] | undefined : undefined;
        if (Array.isArray(rows) && rows.length > 0 && alias?.colnames === undefined) {
          const width = (bodyOf(rows[0]!).items as unknown[]).length;
          b.alias = { ...(alias ?? {}), aliasname: alias?.aliasname ?? "__mason_values", colnames: Array.from({ length: width }, (_, i) => S(`column${i + 1}`)) };
        }
        return null;
      }
      default: return null;
    }
  }

  /**
   * A ZONE AS POSTGRES READS IT (AT TIME ZONE, date_trunc's third argument): an IANA name in any case, spelled as tzdata
   * spells it; `UT` and `Z` as UTC. Postgres reads an abbreviation or a POSIX zone with a fixed offset (`CST` is -06 all
   * year, `UTC+3` three hours west) where DuckDB reads several as another zone (`CST` as Chicago's, `IST` as India's,
   * `UTC+3` east), so those are refused (src/lib/timezone.ts atTimeZoneOf, the rule the other paths apply): a constant
   * here, a row's value when it is read (`__mason_zone`).
   */
  private zoneArg(z: AstNode): AstNode {
    const text = constString(z);
    if (text === null) return fn("__mason_zone", [z]);
    const read = atTimeZoneOf(text);
    if ("problem" in read) throw new Unrewritable(read.problem, "write an IANA zone name (America/Chicago, Asia/Kolkata)", read.sqlstate === "0A000" ? "zone-abbreviation" : { postgres: read.sqlstate });
    return strConst(read.zone);
  }

  /** the parameters the session sends the transaction's start in (DuckPlan.clock), numbered after the statement's own */
  readonly clock: { parse?: number; exec?: number } = {};

  /** the transaction's start as of the Parse (`parse`) or the execution (`exec`), a TIMESTAMPTZ parameter */
  private now(which: "parse" | "exec"): AstNode {
    this.clock[which] ??= this.params.length + Object.keys(this.clock).length + 1;
    return cast({ ParamRef: { number: this.clock[which] } }, ["timestamptz"]);
  }

  /**
   * A RELATIVE TIME LITERAL (`'now'`, `'today'`, `'tomorrow'`, `'yesterday'`): Postgres reads it once, when it analyses
   * the statement — the transaction's start, and its day in the session's zone — and a prepared statement keeps that
   * value. So it is the Parse's start (a parameter the session sends), never DuckDB's clock or the plan's.
   */
  private relativeTime(word: string, type: number): AstNode {
    const days = { now: 0, today: 0, tomorrow: 1, yesterday: -1 }[word as "now"];
    const zone = strConst(this.timeZone);
    const local = fn("timezone", [zone, this.now("parse")]);
    const day = (): AstNode => { const d = cast(fn("timezone", [strConst(this.timeZone), this.now("parse")]), ["date"]); return days === 0 ? d : op("+", d, intConst(days)); };
    if (type === DATE) return day();
    if (type === TIMESTAMP) return word === "now" ? local : cast(day(), ["timestamp"]);
    return word === "now" ? this.now("parse") : fn("timezone", [zone, cast(day(), ["timestamp"])]);
  }

  /** CURRENT_DATE and its kin: the transaction's start as of the execution, in the session's zone (DuckDB's own clock
   *  starts with each statement, and a transaction of several would read several) */
  private sqlValueFunction(b: Body): AstNode | null {
    const exec = (): AstNode => this.now("exec");
    switch (b.op) {
      case "SVFOP_CURRENT_TIMESTAMP": return exec();
      case "SVFOP_CURRENT_DATE": return cast(exec(), ["date"]);
      case "SVFOP_LOCALTIMESTAMP": return cast(exec(), ["timestamp"]);
      case "SVFOP_LOCALTIME": return cast(cast(exec(), ["timestamp"]), ["time"]);
      default: return null;
    }
  }

  /**
   * ARRAY(SELECT x …) answers as Postgres's only where x is a scalar DuckDB holds as Postgres does (text, an integer,
   * jsonb, an enum, a bool, a date, …): a numeric is DuckDB's double there (Postgres's numeric[] is exact), an array
   * is a list of lists (Postgres accumulates a multi-dimensional array, and raises 2202E on an empty one, 22004 on a
   * NULL), a row a struct (record[] to Postgres). Those, and an element whose type the analysis does not say, are
   * refused by name.
   */
  private arraySubquery(b: Body): void {
    let q = isNode(b.subselect) ? bodyOf(b.subselect) : undefined;
    while (q !== undefined && q.op !== undefined && q.op !== "SETOP_NONE" && q.larg !== undefined) q = q.larg as Body;
    const target = ((q?.targetList ?? []) as AstNode[])[0];
    const val = target !== undefined ? bodyOf(target).val : undefined;
    let t = isNode(val) ? this.typeOf(val) : null;
    // an array's element (`a[1]`: no offset of its own to the analysis) is a scalar of the array's element type, a
    // numeric where the array is a numeric[]; a slice is an array
    if (t === null && isNode(val) && kindOf(val) === "A_Indirection") {
      const ind = (bodyOf(val).indirection ?? []) as AstNode[];
      const at = isNode(bodyOf(val).arg) ? this.typeOf(bodyOf(val).arg as AstNode) : null;
      // (a user type's array other than an enum's may be a table's rows: an element whose type is not told)
      const told = at !== null && at !== RECORD_ARRAY && (this.userTypes.get(at)?.startsWith("_") !== true || this.enums.arrays.has(at));
      if (told && ind.length > 0 && ind.every((x) => kindOf(x) === "A_Indices" && bodyOf(x).is_slice !== true)) t = at === NUMERIC_ARRAY ? NUMERIC : TEXT;
    }
    const refuse = (what: string): never => {
      throw new Unrewritable(`ARRAY(SELECT …) of ${what} is not supported by Mason`, "array_agg(x ORDER BY …) in a subquery, or ARRAY(SELECT x::text …)", "array-subquery-element");
    };
    if (t === null) refuse("a value whose type Mason cannot tell");
    if (t === NUMERIC) refuse("a numeric (Postgres's numeric[] is exact)");
    if (ARRAYS.has(t!) || this.enums.arrays.has(t!) || t === INET_ARRAY || this.userTypes.get(t!)?.startsWith("_") === true) refuse("an array (Postgres accumulates a multi-dimensional array)");
    if (this.isRowType(t!)) refuse("a row (Postgres's record[])");
  }

  private isRowType(oid: number): boolean { return oid === RECORD || this.userTypes.get(oid)?.startsWith("rowtype:") === true; }

  /** a typed reference to a FROM item's column (a row's, read as its columns) */
  private typedRef(names: readonly string[], type: number, typmod: number, collation: number): AstNode {
    const n: AstNode = { ColumnRef: { fields: names.map(S) } };
    this.synthetic.set(bodyOf(n), { node: "VAR", type, typmod, args: [], oid: null, format: null, collation, inputCollation: 0, levelsUp: 0, datum: null, qualifier: null, renamed: null });
    return n;
  }

  /** a whole row's columns as values, each typed: a FROM item's (`r`, `r.*`, a table's own name) or a ROW(…)'s; null
   *  where n is no row */
  private rowFields(n: AstNode, select: Body): Array<{ name: string; value: AstNode; type: number | null }> | null {
    const k = kindOf(n);
    if (k === "RowExpr") {
      if (this.typed(n)?.node !== "ROWEXPR") return null;
      return ((bodyOf(n).args ?? []) as AstNode[]).map((a, i) => ({ name: `f${i + 1}`, value: a, type: this.typeOf(a) }));
    }
    if (k !== "ColumnRef") return null;
    const fields = (bodyOf(n).fields ?? []) as AstNode[];
    const star = fields.length === 2 && kindOf(fields[1]!) === "A_Star";
    if (fields.length !== 1 && !star) return null;
    const t = this.typed(n);
    if (t === null || t.node !== "VAR" || !this.isRowType(t.type)) return null;
    const alias = String(bodyOf(fields[0]!).sval);
    const table = this.rowTypes.get(t.type);
    if (table !== undefined) return table.map((c) => ({ name: c.name, value: this.typedRef([alias, c.name], c.type, c.typmod, c.collation), type: c.type }));
    if (t.type !== RECORD) throw new Unrewritable(`a row of ${this.userTypes.get(t.type)?.replace(/^rowtype:/, "") ?? "a table"} is not supported by Mason: Mason synced the table in part`, "name its columns instead", "row-value");
    const source = this.fromSources(select).filter((q) => q.alias === alias);
    if (source.length !== 1) throw new Unrewritable("a row of this FROM item is not supported by Mason", "name its columns instead", "row-value");
    let q = bodyOf(source[0]!.query);
    while (q.op !== undefined && q.op !== "SETOP_NONE" && q.larg !== undefined) q = q.larg as Body;
    const targets = (q.targetList ?? []) as AstNode[];
    if (targets.some((x) => hasStar(bodyOf(x).val))) throw new Unrewritable("a row of a subquery that selects * is not supported by Mason", "name the subquery's columns", "row-value");
    return targets.map((x) => {
      const val = bodyOf(x).val as AstNode;
      const name = bodyOf(x).name ?? figureColname(val);
      const typed = this.typed(val);
      return { name, value: this.typedRef([alias, name], typed?.type ?? TEXT, typed?.typmod ?? -1, typed?.collation ?? 0), type: typed?.type ?? null };
    });
  }

  /** a row's text as record_out writes it: each column's text, quoted where it must be, NULL as nothing */
  private recordText(cols: ReadonlyArray<{ value: AstNode; type: number | null }>): AstNode {
    for (const c of cols) if (c.type !== null && this.isRowType(c.type)) throw new Unrewritable("a row holding a row is not supported by Mason", "name the inner row's columns", "row-value");
    return fn("__mason_record_text", cols.map((c) => this.pgText(c.value, c.type, false) ?? cast(c.value, ["varchar"])));
  }

  /** a row's json as row_to_json writes it (`{"id":1,"t":"a"}`) */
  private rowJson(cols: ReadonlyArray<{ name: string; value: AstNode; type: number | null }>, fnName: string): AstNode {
    const values = cols.map((c) => this.jsonValue(c.value, c.type, fnName));
    return fn("__mason_json_build", [strConst(`r:${values.map((v) => `s${v.kind}`).join("")}`), ...cols.flatMap((c, i) => [strConst(c.name), values[i]!.value])]);
  }

  /**
   * A ROW AS A VALUE (the corpus run: `SELECT r FROM (…) r`, `row_to_json(t)`, `json_agg(t)`): DuckDB holds
   * it as a struct, written `{'id': 1}`. In this query's own expressions (not its subqueries'), each row the SELECT list
   * writes, casts to text or hands a json function is written as Postgres writes it, from its columns; any other row is
   * refused by the ColumnRef / RowExpr rule.
   */
  private rowValues(b: Body): void {
    const textTypes = new Set(["text", "varchar"]);
    const visit = (v: unknown, inList: boolean): unknown => {
      if (Array.isArray(v)) return v.map((x) => visit(x, inList));
      if (!isNode(v)) return v;
      const k = kindOf(v), body = bodyOf(v);
      if (k === "SelectStmt" || k === "SubLink" || k === "RangeSubselect") return v;
      if (inList) {
        const cols = this.rowFields(v, b);
        if (cols !== null) {
          const text = this.recordText(cols);
          this.rowTexts.add(bodyOf(text));
          return text;
        }
      }
      if (k === "TypeCast" && isNode(body.arg) && textTypes.has(lastName(body.typeName?.names))) {
        const cols = this.rowFields(body.arg as AstNode, b);
        if (cols !== null) return this.recordText(cols);
      }
      if (k === "FuncCall" && Array.isArray(body.args) && body.args.length >= 1 && body.over === undefined) {
        const name = lastName(body.funcname);
        const cols = ["to_json", "to_jsonb", "row_to_json", "json_agg", "jsonb_agg"].includes(name) ? this.rowFields(body.args[0] as AstNode, b) : null;
        if (cols !== null) {
          if (body.args.length > 1) throw new Unrewritable(`${name}() of a row with more arguments is not supported by Mason`, `${name}(row)`, "row-value");
          const json = this.rowJson(cols, name);
          if (name === "to_json" || name === "row_to_json") return json;
          if (name === "to_jsonb") return cast(fn("__mason_jsonb_text", [json]), ["json"]);
          if (body.agg_distinct === true) throw new Unrewritable(`${name}(DISTINCT …) is not supported by Mason`, `select the DISTINCT values in a subquery and ${name} them`, "json-agg-distinct");
          // json_agg puts a line break before each row but the first (json_agg_transfn: a composite's or an array's)
          const array = linedAgg(body, concat(strConst("\n "), json), this.done);
          return name === "jsonb_agg" ? cast(fn("__mason_jsonb_text", [array]), ["json"]) : array;
        }
      }
      const out: Body = {};
      for (const [key, x] of Object.entries(body)) out[key] = visit(x, false);
      // the node stays the statement's own (its rule still runs), with its children replaced in place
      for (const [key, x] of Object.entries(out)) body[key] = x;
      return v;
    };
    if (Array.isArray(b.targetList)) for (const t of b.targetList as AstNode[]) { const tb = bodyOf(t); if (isNode(tb.val)) tb.val = visit(tb.val, true); }
    for (const key of ["whereClause", "havingClause"]) if (isNode(b[key])) b[key] = visit(b[key], false);
  }

  // ---------------------------------------------------------------------------------------- SELECT

  private select(b: Body): AstNode | null {
    for (const c of (b.withClause?.ctes ?? []) as AstNode[]) if (isNode(c) && typeof bodyOf(c).ctename === "string" && isNode(bodyOf(c).ctequery)) this.ctes.set(bodyOf(c).ctename, bodyOf(c).ctequery as AstNode);
    // a window's ORDER BY key in a grouped SELECT is read per group (`overGroups`): its query, for the key's rule
    const targets = (b.targetList ?? []) as AstNode[];
    if ((Array.isArray(b.groupClause) && b.groupClause.length > 0) || b.havingClause !== undefined || targets.some((t) => this.hasAggregate(bodyOf(t).val))) {
      const keys = (v: unknown): void => {
        if (Array.isArray(v)) { for (const x of v) keys(x); return; }
        if (v === null || typeof v !== "object") return;
        if (isNode(v) && (kindOf(v) === "SelectStmt" || kindOf(v) === "SubLink")) return;
        if (isNode(v) && kindOf(v) === "WindowDef") for (const s of (bodyOf(v).orderClause ?? []) as AstNode[]) if (isNode(s)) this.groupedWindowKeys.set(bodyOf(s), b);
        // (a call's OVER is a window's body, written in place)
        if (isNode(v) && kindOf(v) === "FuncCall" && bodyOf(v).over !== null && typeof bodyOf(v).over === "object") keys({ WindowDef: bodyOf(v).over });
        for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) keys(x);
      };
      keys([b.targetList, b.windowClause, b.sortClause]);
    }
    // a DISTINCT ON's sort holds its ON expressions (distinctOnSorted): before any key is built, so each is built as one
    this.distinctOnSorted(b);
    // `x IS NULL, x DESC` as `x DESC NULLS LAST` (nullsKeyFolded): the folded key is the statement's own, its rules to
    // run; before anything writes a key another way, as the two are told alike by their trees
    if (Array.isArray(b.sortClause)) {
      const given = b.sortClause as AstNode[];
      b.sortClause = nullsKeyFolded(given, b);
      for (const s of b.sortClause as AstNode[]) this.original.add(bodyOf(s));
      // (a folded key is made of two of the statement's own, never under a DISTINCT ON, the one rule that adds keys)
      for (const s of b.sortClause as AstNode[]) if (!given.includes(s)) this.writtenKeys.add(bodyOf(s));
    }
    this.naturalWritten(b);
    this.refuseMergedExact(b);
    this.namedThroughStar(b);
    this.starWrittenOut(b);
    // THE GROUP BY AS POSTGRES ANALYSED IT (`grouping`), recorded here: over the list as the engine reads it (a `*`
    // written out, so a key's shape is its written column's), before any rule below writes the clause for the engine
    this.grouping(b);
    if ((Array.isArray(b.groupClause) && b.groupClause.length > 0) || b.havingClause !== undefined || ((b.targetList ?? []) as AstNode[]).some((t) => this.hasAggregate(bodyOf(t).val))) {
      // each cast read per group: outside an aggregate's or a window's argument, whose rows are each its own, and outside
      // a grouped expression (`GROUP BY 1` of the cast itself is grouped as it is written)
      const casts = (v: unknown): void => {
        if (Array.isArray(v)) { for (const x of v) casts(x); return; }
        if (v === null || typeof v !== "object") return;
        if (isNode(v) && (kindOf(v) === "SelectStmt" || kindOf(v) === "SubLink" || this.groupedAs(v, b) !== null)) return;
        if (isNode(v) && kindOf(v) === "FuncCall" && (bodyOf(v).over !== undefined || this.typed(v)?.node === "AGGREF" || bodyOf(v).agg_within_group === true)) return;
        if (isNode(v) && kindOf(v) === "TypeCast") this.groupedCasts.set(bodyOf(v), b);
        for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) casts(x);
      };
      casts([b.targetList, b.sortClause, b.havingClause]);
    }
    this.rowValues(b);
    for (const w of (b.windowClause ?? []) as AstNode[]) if (isNode(w)) this.keyedPartition(bodyOf(w));
    // a GROUP BY of an output name is grouped by its ordinal: DuckDB binds a name without regard to case, so `"Name"`
    // would be another table's `name` (the corpus run of fbbf8f08), where Postgres finds no input column of that name
    if (Array.isArray(b.groupClause) && Array.isArray(b.targetList)) {
      const targets = b.targetList as AstNode[];
      const outputs = this.outputs(targets);
      b.groupClause = (b.groupClause as AstNode[]).map((g) => {
        const f = kindOf(g) === "ColumnRef" ? names(bodyOf(g).fields) : [];
        if (f.length !== 1 || this.typedAt(g)?.node === "VAR") return g;
        const named = (o: Output): boolean => !o.star && bodyOf(targets[o.target]!).name === f[0];
        const at = outputs.findIndex(named);
        return at >= 0 && outputs.filter(named).length === 1 ? intConst(at + 1) : g;
      });
    }
    this.keyedGroups(b);
    // a set operation compares its rows (without ALL, and INTERSECT ALL / EXCEPT ALL count them by equality)
    if (b.op !== undefined && b.op !== "SETOP_NONE" && (b.all !== true || b.op !== "SETOP_UNION")) {
      let first: Body = b;
      while (first.larg !== undefined) first = first.larg as Body;
      const what = `${String(b.op).replace("SETOP_", "")}${b.all === true ? " ALL" : " (without ALL)"} of`;
      for (const t of (first.targetList ?? []) as AstNode[]) {
        const v = bodyOf(t).val;
        if (!isNode(v)) continue;
        if (this.starHoldsJsonb(v)) throw new Unrewritable(`${what} a * holding a jsonb column is not supported by Mason (Postgres equates jsonb by its own rules)`, JSONB_WAY_OUT, "jsonb-compare");
        // (INTERSECT ALL and EXCEPT ALL: jsonb's equality alone, which is not its text's; the rest as before)
        if (b.all !== true || this.typeOf(v) === JSONB || this.typeOf(v) === JSONB_ARRAY) this.comparable(v, what);
      }
      // a numeric decided exactly, in any arm: the rows are compared whole, where no exact key can be placed
      const arms: Body[] = [];
      const armsOf = (x: Body): void => { if (x.op !== undefined && x.op !== "SETOP_NONE" && x.larg !== undefined && x.rarg !== undefined) { armsOf(x.larg as Body); armsOf(x.rarg as Body); } else arms.push(x); };
      armsOf(b);
      for (const arm of arms) for (const t of (arm.targetList ?? []) as AstNode[]) if (isNode(bodyOf(t).val)) this.refuseExactEquality(bodyOf(t).val as AstNode, what);
      // A NUMERIC COLUMN WHOSE ARMS WRITE IT AT SEVERAL SCALES (issue 929's review): Postgres prints each row it keeps at
      // the scale of the arm the row came from (`3` from an integer, `7.00` from a numeric(12,2)); the engine unifies the
      // arms to one DECIMAL first, so every row prints at the widest scale. A UNION ALL keeps each row's own arm
      // (`exactArms`). A UNION keeps rows of every arm, and which arm's row a duplicate keeps is the plan's; so does an
      // INTERSECT (Postgres may read the smaller input first). An EXCEPT keeps rows of its left arms alone, so it prints as
      // Postgres does where those arms write the widest scale. An arm whose scale its values decide (null: an
      // unconstrained column) counts as a scale of its own, never the widest
      const columns = this.unreadSetOps.has(b) ? [] : this.setOperationColumns(b, false) ?? [];
      const leftArms: Body[] = [];
      if (b.op === "SETOP_EXCEPT" && b.larg !== undefined) { const collect = (x: Body): void => { if (isSetOp(x) && x.larg !== undefined && x.rarg !== undefined) { collect(x.larg as Body); if (x.op !== "SETOP_EXCEPT") collect(x.rarg as Body); } else leftArms.push(x); }; collect(b.larg as Body); }
      columns.forEach((c, i) => {
        if (c?.type !== NUMERIC) return;
        const scalesOf = (of: readonly Body[]): Array<number | null> => of.flatMap((arm) => this.armScales({ SelectStmt: arm }, i));
        const scales = scalesOf(arms);
        if (new Set(scales).size <= 1) return;
        if (b.op === "SETOP_EXCEPT" && !scales.includes(null)) {
          const widest = Math.max(...(scales as number[]));
          if (scalesOf(leftArms).every((x) => x === widest)) return;
        }
        throw new Unrewritable(`${what} numeric values of different scales (column ${i + 1}) is not supported by Mason (Postgres prints each row at its own query's scale)`,
          "cast each query's column to one scale, numeric(p, s), or use UNION ALL", "numeric-set-scales");
      });
    }
    this.decidedByKey(b);
    // (after decidedByKey: a DISTINCT ON a target names it as the SELECT list reads it, through any_value where it must)
    this.keyedDistinct(b);
    // (its keys read through the one resolver too, before the ORDER BY below writes them for a sort)
    if (b.limitOption === "LIMIT_OPTION_WITH_TIES") return this.withTies(b);
    this.orderBy(b);
    if (Array.isArray(b.sortClause) && b.op !== undefined && b.op !== "SETOP_NONE") { this.setOperationExactKeys(b); this.setOperationOrdinals(b); }
    return null;
  }

  /** a SELECT's own ORDER BY, each key written for DuckDB's sort (below) */
  private orderBy(b: Body): void {
    // the statement's own ORDER BY: an ordinal or an output name sorts by that target's expression, so its key is
    // built over the expression (DuckDB's `ORDER BY 1 COLLATE …` would sort by the constant)
    // A CONSTANT SORT KEY (the class, issue 134: whether a key is constant is the ANALYSIS's, src/duck/constant-key.ts):
    // a key Postgres analysed as a Const, after its ordinal or output name is resolved, orders nothing, and written
    // into DuckDB's sort it is an ordinal (an integer) or refused (42804, a non-integer literal), whether as the value or
    // as a collation's key over it. So it is no key, here where every key of a SELECT is written, at any depth; with
    // none left there is no ORDER BY, and the LIMIT keeps any rows, as Postgres's plan does. Any other key Postgres
    // evaluates, and may raise on at planning: written so DuckDB evaluates it, never as a bare non-integer literal
    if (Array.isArray(b.sortClause) && Array.isArray(b.targetList) && (b.op === undefined || b.op === "SETOP_NONE")) {
      const targets = b.targetList as AstNode[];
      // (a key bound to an output or another clause's key by equality, spelled unlike it: by the one resolver)
      const sorts = b.sortClause as AstNode[];
      // (a key a DISTINCT ON appended (`distinctOnSorted`) is none of the analysis's sort list: the written keys are bound
      // by it, an appended one as its ON expression was, by the DISTINCT ON's list)
      const written = sorts.filter((s) => !this.distinctAppended.has(bodyOf(s)));
      const nodeOf = (s: AstNode): AstNode | undefined => kindOf(s) === "SortBy" && isNode(bodyOf(s).node) ? bodyOf(s).node as AstNode : undefined;
      const writtenBound = this.keysBound(written.map(nodeOf), this.analysedQuery(targets)?.keys, "sorted", targets);
      const bound = sorts.map((s) => {
        const appended = this.distinctAppended.get(bodyOf(s));
        return appended === undefined ? writtenBound[written.indexOf(s)]! : { ...appended, equal: false };
      });
      const starred = targets.some((t) => hasStar(bodyOf(t).val));
      b.sortClause = sorts.flatMap((s, i) => {
        const sb = bodyOf(s);
        this.done.add(sb);
        const out = bound[i]!.output;
        if (kindOf(s) === "SortBy" && sb.useOp === undefined) {
          if (out?.twin !== true && (bound[i]!.constant ?? this.typed(out !== null ? out.value : sb.node as AstNode)?.constant) === true) return [];
        }
        // (a key bound by equality is built over its own expression, which is the output's and carries its own typing)
        // (a collated key bound by equality to a grouped output: its collation's keys read the grouped value, as a key
        // named by the output's number or name does, `overGroups`)
        if (bound[i]!.equal && out !== null && kindOf(s) === "SortBy" && isNode(sb.node) && kindOf(sb.node as AstNode) === "CollateClause") sb.node = this.overGroups(sb.node as AstNode, b);
        const as = sb.node;
        // (a key bound by equality has no analysed node of its own where Postgres's tree reads it as the entry: it is
        // typed as the output it is, so a jsonb's, a citext's or a collation's key is built for it)
        // (a cast of a grouped expression read per group is typed by its result where `decidedByKey` reads it)
        if (bound[i]!.equal && out !== null && kindOf(s) === "SortBy" && isNode(as) && this.typeOf(as as AstNode) === null && this.typeOf(out.value) !== null) this.typedLike.set(bodyOf(as as AstNode), out.value);
        const built = this.sortBy(sb, targets, b, bound[i]!.equal ? null : out);
        // a key bound to a computed output by EQUALITY, written as it is, is that output: its ordinal, so DuckDB reads
        // the one value the list shows (`ORDER BY random()` beside `random() AS r` is r, never a second random()). A
        // list with a * keeps its key: its outputs' numbers are Postgres's expansion
        if (built === null && sb.node === as && bound[i]!.equal && out !== null && !starred && kindOf(out.value) !== "ColumnRef" && kindOf(s) === "SortBy" && sb.useOp === undefined) {
          sb.node = { A_Const: { ival: { ival: out.target + 1 } } };
        }
        // (an integer the rewrite wrote is an ordinal it meant; any other bare literal DuckDB would refuse)
        const written = built ?? [s];
        for (const w of written) {
          const n = kindOf(w) === "SortBy" ? bodyOf(w).node as AstNode | undefined : undefined;
          if (n !== undefined && kindOf(n) === "A_Const" && bodyOf(n).ival === undefined) bodyOf(w).node = evaluated(n);
        }
        return written;
      });
      if ((b.sortClause as AstNode[]).length === 0) delete b.sortClause;
    }
  }

  /**
   * A SELECT'S OUTPUT COLUMNS, AS POSTGRES NUMBERS AND NAMES THEM (issue 112: `SELECT * FROM t ORDER BY 3` under a
   * collation sorted by bytes, as nothing here saw the column): a target is one output, a `*` or `t.*` one per column,
   * from Postgres's own expansion (its query's targetList, `outputsByLocation`). THE CLASS IS AN ORDER BY, GROUP BY OR DISTINCT
   * ON OUTPUT NOT RESOLVED TO ITS COLUMN, and every reader of an output's number or name goes through here: a star's
   * column is a ColumnRef made from that VAR, typed by it, so every rule (a collation's key, jsonb's, citext's, char(n)'s,
   * a refusal) meets it as it meets the column named.
   */
  private outputs(targets: readonly AstNode[]): Output[] {
    const stars = targets.filter((t) => hasStar(bodyOf(t).val));
    const query = stars.length === 0 ? undefined : this.analysedQuery(targets);
    const widthOf = (t: AstNode): number | null => {
      const f = bodyOf(bodyOf(t).val as AstNode).fields as AstNode[];
      return f.length < 2 ? null : query?.widths.get(String(bodyOf(f[f.length - 2]!).sval)) ?? 0;
    };
    // a bare `*` lists what the named ones and the other targets leave, shared out among the bare ones
    const bare = stars.filter((t) => widthOf(t) === null).length;
    const rest = (query?.columns.length ?? 0) - (targets.length - stars.length) - stars.reduce((n, t) => n + (widthOf(t) ?? 0), 0);
    const out: Output[] = [];
    let at = 0;
    targets.forEach((t, target) => {
      const v = bodyOf(t).val;
      if (!isNode(v)) return;
      if (!hasStar(v)) { at++; out.push({ target, at: out.length, name: typeof bodyOf(t).name === "string" ? bodyOf(t).name : figureColname(v), value: v, star: false, twin: false, row: this.rowTexts.has(bodyOf(v)) }); return; }
      const width = widthOf(t) ?? (bare === 0 ? 0 : rest / bare);
      for (const c of query?.columns.slice(at, at + width) ?? []) {
        const n = c?.column;
        if (c === null || c === undefined || n === undefined) throw new Error("a column of a * is no column in Postgres's analysis: report it, with the statement");
        const value: AstNode = { ColumnRef: { fields: [...(n.owner === null ? [] : [S(n.owner)]), S(n.name)], location: -1 } };
        this.original.add(bodyOf(value));
        this.synthetic.set(bodyOf(value), c);
        // read in the query the `*` is read in, so a subquery's column it names is found (`fromColumn`, issue 252)
        const starAt = bodyOf(v).location;
        const scope = typeof starAt === "number" ? this.scopes.get(starAt) : undefined;
        if (scope !== undefined) this.refScopes.set(bodyOf(value), scope);
        out.push({ target, at: out.length, name: n.name, value, star: true, twin: n.twin === true, row: false });
      }
      at += width;
    });
    return out;
  }

  /** a SELECT's query in Postgres's analysis, found by an offset its targets hold (a subquery's targets are its own);
   *  one whose targets hold none (`TABLE t`) by the FROM it reads and its own limits' offsets (`picked`); else undefined */
  private analysedQuery(targets: readonly AstNode[]): QueryOutputs | undefined {
    const held = this.offsetsIn(targets);
    if (held.length > 0) return held.map((l) => this.analysed.get(l)).find((q) => q !== undefined);
    const unplaced = targets.length === 0 ? undefined : this.unplacedTargets.get(bodyOf(targets[0]!));
    if (unplaced === undefined) return undefined;
    this.unplaced ??= analysedQueries(this.analysisTree).unplaced;
    const candidates = this.unplaced.filter((q) => q.from.length === unplaced.from.length && q.from.every((f, i) => f === unplaced.from[i]));
    return this.picked(candidates, (q) => [{ parse: unplaced.limits, analysed: q.limits }],
      (q) => JSON.stringify([q.outputs.columns, [...q.outputs.widths], q.outputs.joins, q.outputs.keys]))?.outputs;
  }
  private unplaced: ReturnType<typeof analysedQueries>["unplaced"] | undefined;

  /**
   * A NATURAL JOIN WRITTEN AS THE COLUMNS POSTGRES MERGED, in every statement: `USING (<them>)`, or `ON true` where it
   * found none, which DuckDB refuses ("No columns found to join on in NATURAL JOIN"); so a copy's hidden columns
   * (src/duck/kept-route.ts) are never joined on either. The join's body is changed in place, so what is known of it by
   * identity still holds. A SELECT whose list holds no offset (`SELECT FROM …`) keeps its NATURAL as written.
   */
  private naturalWritten(b: Body): void {
    const from = b.fromClause as unknown[] | undefined;
    const natural = (x: unknown): boolean => isNode(x) && kindOf(x) === "JoinExpr" && (bodyOf(x).isNatural === true || natural(bodyOf(x).larg) || natural(bodyOf(x).rarg));
    if (!Array.isArray(from) || !from.some(natural)) return;
    const joins = this.analysedQuery((b.targetList ?? []) as AstNode[])?.joins;
    if (joins === undefined) return;
    // each JOIN after its sides, left to right: the order Postgres's range table holds them
    const found: Body[] = [];
    const walk = (x: unknown): void => {
      if (!isNode(x) || kindOf(x) !== "JoinExpr") return;
      walk(bodyOf(x).larg); walk(bodyOf(x).rarg);
      found.push(bodyOf(x));
    };
    from.forEach(walk);
    if (found.length !== joins.length) return;
    found.forEach((j, at) => {
      if (j.isNatural !== true) return;
      const columns = joins[at]!;
      delete j.isNatural;
      if (columns.length > 0) j.usingClause = columns.map(S);
      else j.quals = { A_Const: { boolval: { boolval: true } } };
    });
  }

  /**
   * A `*` WRITTEN OUT where DuckDB's own expansion would not be Postgres's: over a JOIN … USING or a NATURAL JOIN, whose
   * merged columns Postgres lists first and DuckDB where the left table has them (every column of the row in another
   * place); and beside a GROUP BY, where a decided column is read through any_value one by one (decidedByKey).
   */
  private starWrittenOut(b: Body): void {
    const targets = b.targetList as AstNode[] | undefined;
    if (!Array.isArray(targets) || !targets.some((t) => hasStar(bodyOf(t).val))) return;
    const merges = (x: unknown): boolean => isNode(x) && kindOf(x) === "JoinExpr" && (bodyOf(x).usingClause !== undefined || bodyOf(x).isNatural === true || merges(bodyOf(x).larg) || merges(bodyOf(x).rarg));
    const grouped = Array.isArray(b.groupClause) && b.groupClause.length > 0;
    if (!grouped && !((b.fromClause ?? []) as unknown[]).some(merges)) return;
    const outputs = this.outputs(targets);
    b.targetList = targets.flatMap((t, i) => {
      if (!hasStar(bodyOf(t).val)) return [t];
      const own = outputs.filter((o) => o.target === i);
      if (own.some((o) => o.twin)) throw this.twinRefused();
      return own.length === 0 ? [t] : own.map((o) => ({ ResTarget: { name: o.name, val: o.value } }));
    });
    this.forgetDecisions();
  }

  /**
   * A JOIN … USING, OR A NATURAL JOIN, ON A COLUMN A FROM ITEM COMPUTES AS A PROGRAM (issue 218: a quotient a subquery
   * computed): the engine equates the merged column's doubles, which tie values Postgres tells apart past 17 digits, and
   * its merged value is no program's. Refused by name, whichever side computes it (a numeric not `outputExact`, whether
   * or not a carry could take its program): `numeric-quotient-equality`, its way out the ON the join answers exactly
   */
  private refuseMergedExact(b: Body): void {
    const frames = this.frames.get(b);
    if (frames === undefined) return;
    for (const j of fromJoins(b.fromClause)) {
      const using = names(bodyOf(j).usingClause);
      // (a NATURAL JOIN is its USING by now: `naturalWritten`)
      if (using.length === 0) continue;
      for (const leaf of fromLeaves([bodyOf(j).larg, bodyOf(j).rarg])) {
        const lb = bodyOf(leaf);
        const owner = kindOf(leaf) === "RangeSubselect" ? lb.alias?.aliasname : kindOf(leaf) === "RangeVar" ? lb.alias?.aliasname ?? lb.relname : undefined;
        if (typeof owner !== "string") continue;
        for (const column of using) {
          const found = this.fromItemOf(frames, owner, column);
          // (a numeric the engine does not hold exactly, `outputExact`, the one decider's: whether or not a program of it
          // could be built, its merged value is the engine's double)
          const values = found === null ? null : this.valuesAt(found.query, found.index);
          if (found === null || values === null || !values.some((v) => this.typeOf(v) === NUMERIC) || this.outputExact(found.query, found.index)) continue;
          // (a value at a fixed scale, every numeric of the column: computed as main computes it, `atFixedScale`)
          if (values.every((v) => this.typeOf(v) !== NUMERIC || this.duckExact(v) || this.atFixedScale(v))) continue;
          throw new Unrewritable(`a JOIN … USING or a NATURAL JOIN on ${this.approximateWhat(this.valuesAt(found.query, found.index) ?? [])} a subquery or WITH query computed (column "${column}") is not supported by Mason (Postgres equates the exact values; the engine holds them as doubles)`,
            `join ON the two columns: … JOIN t ON t.${column} = s.${column}`, "numeric-quotient-equality");
        }
      }
    }
  }

  private twinRefused(): Unrewritable {
    return new Unrewritable("this * of a named join lists two columns of one name, and Mason cannot read one of them apart here", "name the join's columns in the SELECT, or leave the join's own name out", "star-join-twin");
  }

  /**
   * A DISTINCT ON'S SORT IS ITS ON EXPRESSIONS TOO (transformDistinctOnClause: Postgres appends each ON expression its
   * ORDER BY lacks, ASC NULLS LAST, and its Unique runs over that order, so the groups come back in it and a LIMIT or an
   * OFFSET keeps the first groups of it). The engine is sent the sort Postgres runs, never the one written: each ON
   * expression whose output (by its number, its bare name or the expression repeated) no sort key reads is appended
   * here, as written, before any key is built, so every form sent (as written, src/duck/late.ts's inner query and its
   * outer sort) sorts by it. Only where an order is read: a sort or a LIMIT. A sort with a key that is no ON expression
   * holds them all already (else the catalog's 42P10). A constant ON expression orders nothing, and is not appended.
   */
  private distinctOnSorted(b: Body): void {
    const on = b.distinctClause;
    if (!Array.isArray(on) || on.length === 0 || !on.every(isNode) || (b.op !== undefined && b.op !== "SETOP_NONE")) return;
    const sorts = (b.sortClause ?? []) as AstNode[];
    if (sorts.length === 0 && b.limitCount === undefined && b.limitOffset === undefined) return;
    const targets = (b.targetList ?? []) as AstNode[];
    const read = (e: AstNode): AstNode => { const o = this.outputOf(e, targets); return o !== null && !o.twin ? o.value : e; };
    const same = (x: AstNode, y: AstNode): boolean => sameTree(x, y) && sameTree(y, x);
    const keys = sorts.flatMap((s) => kindOf(s) === "SortBy" && isNode(bodyOf(s).node) ? [read(bodyOf(s).node as AstNode)] : []);
    // (each ON expression as the one resolver binds it, as keyedDistinct reads it: its output, and whether it is constant)
    const bound = this.keysBound(on as AstNode[], this.analysedQuery(targets)?.keys, "distinct", targets);
    const added = (on as AstNode[]).flatMap((d, i) => {
      const e = read(d);
      const constant = bound[i]!.constant ?? this.typed(e)?.constant;
      if (keys.some((k) => same(k, e)) || kindOf(e) === "ParamRef" || constant === true) return [];
      const key: AstNode = { SortBy: { node: this.clone(d), sortby_dir: "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } };
      this.distinctAppended.set(bodyOf(key), { output: bound[i]!.output, constant: bound[i]!.constant });
      return [key];
    });
    if (added.length > 0) b.sortClause = [...sorts, ...added];
  }

  /** the output an ORDER BY item reads: by its number, or by its bare name (SQL92's rule: an output before an input
   *  column; two outputs of one name reach here only as Postgres found them equal) */
  private outputOf(e: AstNode, targets: readonly AstNode[]): Output | null {
    const outputs = this.outputs(targets);
    return outputs[this.outputIndex(e, outputs)] ?? null;
  }

  /** the place in `outputs` of the output an ORDER BY or DISTINCT ON item reads by its number or bare name, or -1 */
  private outputIndex(e: AstNode, outputs: readonly Output[]): number {
    const n = constInt(e);
    if (n !== null) return n >= 1 && n <= outputs.length ? n - 1 : -1;
    if (kindOf(e) !== "ColumnRef") return -1;
    const f = names(bodyOf(e).fields);
    return f.length !== 1 ? -1 : outputs.findIndex((o) => o.name === f[0]);
  }

  /**
   * WHETHER EACH KEY IS CONSTANT, by the entry Postgres bound it to (`keysConstant`, src/duck/constant-key.ts, the one
   * resolver): a SELECT's ORDER BY or DISTINCT ON over its outputs (`targets`), or an aggregate's ORDER BY over its
   * arguments (no `targets`: there a number is a value, never an output). A key's entry is known by its number or output
   * name, or by an entry at its own offset (one Postgres made for it); one bound by equality is left to the resolver.
   * null for a key it cannot tell (the analysis not found, a way that does not fit), whose own reading stands.
   */
  private keysConstant(nodes: ReadonlyArray<AstNode | undefined>, keys: Keys | undefined, clause: "sorted" | "distinct", targets?: readonly AstNode[]): Array<boolean | null> {
    return this.keysBound(nodes, keys, clause, targets).map((k) => k.constant);
  }

  /**
   * EACH KEY OF A SELECT'S ORDER BY OR DISTINCT ON, AS POSTGRES BOUND IT: THE ONE RESOLVER (the class "an output not
   * resolved to its column", its fourth round: the binding decides how a key is WRITTEN, not only whether it is
   * constant). A key bound to an output, by its number, its output name (an alias that is also an input column
   * included: ORDER BY and DISTINCT ON take the output) or an expression EQUAL to it (findTargetlistEntrySQL99), IS that
   * output, and every writer of a key writes it through `output`: a key built over the output's expression, or, for a
   * key bound by equality and written as it is, the output itself (`equal`: its ordinal), never a second evaluation of a
   * volatile one. `constant` as `keysConstant`. With no analysis, the number or name alone binds.
   */
  private keysBound(nodes: ReadonlyArray<AstNode | undefined>, keys: Keys | undefined, clause: "sorted" | "distinct", targets?: readonly AstNode[]): Array<{ output: Output | null; constant: boolean | null; equal: boolean; entry: number | null }> {
    const bound = this.keysBoundAs(nodes, keys, clause, targets);
    for (const k of bound) this.rowKey(k.output);
    return bound;
  }

  /**
   * A KEY BOUND TO A ROW OUTPUT (by its number, its name or an expression equal to it) is refused by `row-value`, as the
   * row written as a key is (the ColumnRef / RowExpr rule): the list writes a row as its text (`rowValues`), and a key
   * over that output would sort or tell apart the text (`(0,100)` before `(0,50)`), where Postgres compares field by
   * field. Every reader of a key's output goes through here: the ORDER BY, DISTINCT ON and FETCH … WITH TIES.
   */
  private rowKey(out: Output | null): void {
    if (out?.row === true) throw new Unrewritable("a row used as a value here (compared, tested, grouped or sorted) is not supported by Mason", "sort by its columns", "row-value");
  }

  private keysBoundAs(nodes: ReadonlyArray<AstNode | undefined>, keys: Keys | undefined, clause: "sorted" | "distinct", targets?: readonly AstNode[]): Array<{ output: Output | null; constant: boolean | null; equal: boolean; entry: number | null }> {
    const outputs = targets === undefined ? [] : this.outputs(targets);
    const named = (n: AstNode | undefined): Output | null => n === undefined || !isNode(n) ? null : outputs[this.outputIndex(n, outputs)] ?? null;
    if (keys === undefined) return nodes.map((n) => ({ output: named(n), constant: null, equal: false, entry: null }));
    const offsets = (n: AstNode): number[] => {
      const b = bodyOf(n);
      const own = typeof b.location === "number" && b.location >= 0 ? [b.location - this.base] : [];
      const k = kindOf(n);
      return (k === "TypeCast" || k === "CollateClause") && isNode(b.arg) ? [...own, ...offsets(b.arg as AstNode)] : own;
    };
    const known = nodes.map((n) => {
      if (n === undefined || !isNode(n)) return -1;
      const out = targets === undefined ? -1 : this.outputIndex(n, outputs);
      // (an output's place is its entry's: Postgres lists the outputs first, a *'s columns each one)
      if (out >= 0) return out;
      const at = offsets(n);
      const own = keys.entries.findIndex((e) => e.at !== null && at.includes(e.at));
      if (own >= 0) return own;
      // bound by equality: whether it reads a column (a subquery's own columns aside), and its constancy where the
      // same text was analysed elsewhere (`typed`'s shape)
      const text = JSON.stringify(n);
      const t = this.typed(n);
      return { reads: text.includes("\"SubLink\"") ? null : text.includes("\"ColumnRef\""), constant: t === null ? null : t.constant === true, ...(text.includes("\"SubLink\"") ? {} : { groupings: text.split("\"GroupingFunc\"").length - 1 }) } satisfies Unbound;
    });
    // (a key no entry can be told for leaves the clause's reading to each key's own)
    if (known.includes(-1)) return nodes.map((n) => ({ output: named(n), constant: null, equal: false, entry: null }));
    return keysBound(keys, clause, known).map((k, i) => {
      const by = named(nodes[i]);
      if (by !== null) return { output: by, constant: k.constant, equal: false, entry: k.entry };
      // (an entry Postgres made an output is the output at its place: it lists the outputs first, a *'s columns each one)
      const output = k.entry !== null && keys.entries[k.entry]?.output === true ? outputs[k.entry] ?? null : null;
      return { output, constant: k.constant, equal: output !== null, entry: k.entry };
    });
  }

  /**
   * THE OUTPUT A GROUP BY ITEM NAMES (the one resolver's GROUP BY reading): its number, or its bare name where Postgres
   * read no input column of that name (GROUP BY prefers the column, the opposite of ORDER BY), or null.
   */
  private groupOutput(g: AstNode, targets: readonly AstNode[]): Output | null {
    if (constInt(g) !== null) return this.outputOf(g, targets);
    if (kindOf(g) !== "ColumnRef" || this.typedAt(g)?.node === "VAR") return null;
    // (a *'s column is an input column by that name: never an output name here)
    const out = this.outputOf(g, targets);
    return out?.star === true ? null : out;
  }

  /**
   * An ORDER BY or GROUP BY item beside a `*` written as the column it resolves to where a table's column is what it is:
   * so a GROUP BY's decided columns (decidedByKey) read it through their rule, and the rows of a join are chosen by it
   * (src/duck/late.ts), neither of which can tell a star's number. Any other FROM item's keeps its number and is resolved
   * where its key is built (sortBy): DuckDB's own name for it may be another, and a number reads the right one.
   */
  private namedThroughStar(b: Body): void {
    const targets = (b.targetList ?? []) as AstNode[];
    if ((b.op !== undefined && b.op !== "SETOP_NONE") || !targets.some((t) => hasStar(bodyOf(t).val))) return;
    const asColumn = (e: AstNode): AstNode => {
      const out = this.outputOf(e, targets);
      if (out === null) return e;
      if (out.twin) throw this.twinRefused();
      if (out.star) return this.typed(out.value)?.relation !== undefined ? out.value : e;
      // (a computed output stays its number: `random() AS r` is one value a row)
      return constInt(e) !== null && kindOf(out.value) === "ColumnRef" ? this.clone(out.value) : e;
    };
    if (Array.isArray(b.groupClause)) b.groupClause = (b.groupClause as AstNode[]).map((g) => isNode(g) && constInt(g) !== null ? asColumn(g) : g);
    for (const s of (b.sortClause ?? []) as AstNode[]) if (kindOf(s) === "SortBy") bodyOf(s).node = asColumn(bodyOf(s).node as AstNode);
  }

  /** whether a value's order is DuckDB's of what it holds, so its number sorts it; any other goes through the SortBy
   *  rule, by its output's name: a key (a collation's, jsonb's), a citext's lower(), a char(n)'s rtrim(), a refusal */
  private sortsAsStored(n: AstNode): boolean {
    const type = this.typeOf(n);
    const c = this.orderedUnder(n);
    return (c === null || c.kind === "bytes") && type !== BPCHAR && !this.isCitext(type) && type !== INET && !(type !== null && [JSONB, JSONB_ARRAY, 1009, 1015].includes(type));
  }

  /**
   * A SET OPERATION'S ORDER BY of a text column (`… UNION … ORDER BY 1`, or `ORDER BY status` where the first SELECT
   * says `o.status`): Postgres sorts by its output column, which it analysed at no offset of the ORDER BY's own, so the
   * SortBy rule found no type and DuckDB sorted by bytes. Each is typed as the set operation's column, as Postgres resolved
   * it (`setOperationColumns`: a citext SELECT beside a text one is text, never its first SELECT's type), and an ordinal is
   * sorted by that output column's name, so the rule builds the collation's keys. A target with no name of its own is
   * given one: Postgres's analysis names the columns the tool reads, never DuckDB's.
   */
  private setOperationOrdinals(b: Body): void {
    // a set operation's arms are SelectStmt bodies, unwrapped (libpg-query's larg / rarg)
    let arm: Body = b;
    while (arm.op !== undefined && arm.op !== "SETOP_NONE" && arm.larg !== undefined) arm = isNode(arm.larg) ? bodyOf(arm.larg) : arm.larg as Body;
    const targets = (arm.targetList ?? []) as AstNode[];
    const outputs = this.outputs(targets);
    // each key is typed as the set operation's column, as Postgres resolved it, never as the first SELECT's target (a
    // citext beside a text is text; a row is refused, as any row key is: `rowKey`)
    let resolved: Array<Typed | null> | undefined;
    const typeAs = (key: AstNode, out: Output): void => {
      resolved ??= this.setOperationColumns(b) ?? [];
      const own = resolved[out.at] ?? null;
      if (own === null) { this.typedLike.set(bodyOf(key), out.value); return; }
      this.rowKey({ ...out, row: own.node === "ROWEXPR" || (own.node === "VAR" && this.isRowType(own.type)) });
      this.synthetic.set(bodyOf(key), own);
    };
    for (const s of b.sortClause as AstNode[]) {
      const sb = bodyOf(s);
      const by = sb.node as AstNode;
      const f = kindOf(by) === "ColumnRef" ? names(bodyOf(by).fields) : [];
      if (f.length === 1) {
        const named = outputs.filter((o) => o.name === f[0]);
        if (named.length === 1) typeAs(by, named[0]!);
        continue;
      }
      const n = constInt(by);
      const out = n === null ? null : this.outputOf(by, targets);
      if (out === null) continue;
      if (out.star) {
        // a set operation's ORDER BY reads an output by its name alone: a column of a `*` has no other
        if (outputs.filter((o) => o.name === out.name).length !== 1) throw new Unrewritable("ORDER BY a column number of a set operation whose first SELECT lists two columns of that name is not supported by Mason", "name the columns apart in the first SELECT", "setop-ordinal-star");
        const named: AstNode = { ColumnRef: { fields: [S(out.name)] } };
        typeAs(named, out);
        if (this.sortsAsStored(named)) continue;
        sb.node = named;
        continue;
      }
      const target = bodyOf(targets[out.target]!);
      const ref: AstNode = { ColumnRef: { fields: [S(String(target.name ?? `__mason_sort_${n}`))] } };
      typeAs(ref, out);
      if (this.sortsAsStored(ref)) continue;
      if (target.name === undefined) target.name = `__mason_sort_${n}`;
      sb.node = ref;
    }
  }

  /**
   * A COLUMN THE GROUP'S KEY DECIDES (`SELECT c.id, c.name … GROUP BY c.id`, c.id the primary key): Postgres accepts it
   * ungrouped (functional dependency), DuckDB refuses it (42803). Postgres accepted this statement, so every column of
   * this query outside an aggregate has one value per group: `any_value(column)` is that value, exactly — in the SELECT
   * list, HAVING, ORDER BY, a window's OVER, and a correlated subquery (where this query's column is one level up:
   * DuckDB, as SQL says, computes an aggregate of outer columns in the outer query). `t.*` is `any_value(COLUMNS(t.*))`.
   * A group key itself is left as it is, and so are an aggregate's argument, a subquery's own columns, and a grouping
   * set (where a key reads NULL in its total rows).
   */
  private decidedByKey(b: Body): void {
    const groups = (b.groupClause ?? []) as AstNode[];
    if (groups.length === 0 || groups.some((g) => kindOf(g) === "GroupingSet")) return;
    const targets = (b.targetList ?? []) as AstNode[];
    // WHAT IS GROUPED IS THE GROUP BY AS POSTGRES ANALYSED IT (`groupedAs`, issue 212), a target it names by its number
    // or its output name included: a grouped expression the engine's clause holds as written is untouched; one it groups
    // by a key in its place (a jsonb) is read through ONE any_value of the WHOLE expression, the group's value, typed
    // as it, so every reader (a cast's text, a `#>` path, a function) reads it as the expression it is
    const perGroup = (v: AstNode): AstNode => {
      const call = fn("any_value", [v]);
      this.done.add(bodyOf(call));
      this.typedLike.set(bodyOf(call), v);
      return call;
    };
    // (inside a subquery, only an expression of this query's columns alone: the engine computes an aggregate of outer
    // columns in the outer query, and a shape alike over the subquery's own columns is no grouped expression of this one)
    const ofThisQuery = (v: unknown, depth: number): boolean => {
      if (Array.isArray(v)) return v.every((x) => ofThisQuery(x, depth));
      if (v === null || typeof v !== "object") return true;
      if (isNode(v) && kindOf(v) === "SubLink") return false;
      if (isNode(v) && kindOf(v) === "ColumnRef") { const t = this.typed(v); return t?.node === "VAR" && t.levelsUp === depth; }
      return Object.values(isNode(v) ? bodyOf(v) : v as Body).every((x) => ofThisQuery(x, depth));
    };
    // `depth`: the subqueries between here and this query (a correlated subquery's column of this query is levelsUp 1)
    // `sorted`: an ORDER BY key, where a bare name is first an output's (findTargetlistEntrySQL92)
    // `windowed`: a WINDOW's PARTITION BY or ORDER BY key, where a bare name is an input column, never an output
    // (findTargetlistEntrySQL99; PR 674 class round r2)
    const wrap = (v: unknown, depth: number, sorted = false, cells = false, windowed = false): unknown => {
      if (Array.isArray(v)) return v.map((x) => wrap(x, depth, sorted, cells, windowed));
      if (v === null || typeof v !== "object") return v;
      // a plain body (a window's OVER, a SubLink's select): its parts
      if (!isNode(v)) { for (const [key, x] of Object.entries(v as Body)) if (key !== "location") (v as Body)[key] = wrap(x, depth, sorted, cells, windowed); return v; }
      const k = kindOf(v), n = bodyOf(v);
      // AN ORDER BY's OUTPUT NAME (`ORDER BY v` of `v::text`, Postgres's output column `v`) is the target, no column,
      // whatever the column of that name is grouped as (fix round 1 of PR 582: `… GROUP BY v ORDER BY v` read the jsonb
      // column through any_value and sorted by jsonb's key, where Postgres sorts by the output, its text). Only in the
      // ORDER BY: in the list, a column grouped by its key has no analysed node at its own offset either (a VAR of the
      // GROUP entry), and is the column. Never inside an expression grouped by its key (`cells`): a name in an expression
      // is the FROM's column, whatever output bears it (Metabase's bin `… AS amount` of `amount`; issue 665)
      if (sorted && !cells && k === "ColumnRef" && depth === 0 && this.outputNamed(v, targets)) return v;
      // (a GROUPING's arguments are the engine's own GROUP BY entries, `groupingArguments`: never read per group)
      if (k === "GroupingFunc") return v;
      const as = this.groupedAs(v, b);
      if (as === "engine") return v;
      if (as === "keyed" && (depth === 0 || ofThisQuery(v, depth))) return perGroup(v);
      // AN EXPRESSION THE ENGINE GROUPS BY ITS KEY ALONE, READ THROUGH ITS COLUMNS (`cells`: a numeric decided exactly,
      // issue 665): every column of this query in it is marked to be read per group (`readPerGroup`), so the
      // expression, its double, its cast, its text and the programs built over it are computed once per group
      const inCells = cells || as === "cells";
      // (a column that is itself the expression grouped so: Postgres bound it to the column, whatever output shares its
      // name; an ORDER BY's output name was returned above)
      if (as === "cells" && k === "ColumnRef") { this.readPerGroup.add(n); return v; }
      // A CAST OF AN EXPRESSION READ PER GROUP IS TYPED BY ITS RESULT (PR 582 review r9, the class
      // grouped-jsonb-cast-typed-by-its-argument): a cast with no analysed node at its own place (a key that repeats a
      // target, Postgres's entry being the target's; a key a rule folded or copied) is otherwise typed by its argument,
      // and its argument is about to become the group's any_value, typed as the jsonb (`perGroup`), so `(j -> 'r')::text`
      // was sorted, ranked and compared by jsonb's key. Its type is pinned HERE, the one place a grouped expression is
      // replaced, from Postgres's analysis of the same cast (`byShape`), before the argument is: every key built from it
      // after (an ORDER BY, its folded NULLS key, a window's ORDER BY or PARTITION BY, HAVING, WITH TIES) is the text's
      if (k === "TypeCast" && isNode(n.arg) && this.groupedAs(n.arg as AstNode, b) === "keyed" && this.allAt(n, ANALYSED.TypeCast!).length === 0) {
        const result = this.byShape.get(shapeOf(v)) ?? this.typed(v);
        if (result !== null) this.synthetic.set(n, result);
      }
      // A SUBLINK's TEST EXPRESSION (`x IN (…)`, `x = ANY (…)`, `x > ALL (…)`) is this query's, walked at this depth;
      // only its subselect is one deeper (review r1 of PR 674, the class sublink-testexpr-walked-at-inner-depth: a
      // column of this query there, at depth + 1, was taken for an outer one and left a bare column, the engine's 42803)
      if (k === "SubLink") { for (const [key, x] of Object.entries(n)) if (key !== "location") n[key] = wrap(x, key === "testexpr" ? depth : depth + 1, false, inCells, key === "testexpr" && windowed); return v; }
      // A WINDOW's keys (a named one, an OVER's own): read per group as every clause after grouping is, each name an
      // input column (SQL99)
      if (k === "WindowDef") { for (const key of ["partitionClause", "orderClause"]) if (n[key] !== undefined) n[key] = wrap(n[key], depth, false, inCells, true); return v; }
      if (k === "FuncCall" && n.over !== null && typeof n.over === "object" && !isNode(n.over)) {
        const over = n.over as Body;
        for (const key of ["partitionClause", "orderClause"]) if (over[key] !== undefined) over[key] = wrap(over[key], depth, false, inCells, true);
        for (const [key, x] of Object.entries(n)) if (key !== "location" && key !== "over") n[key] = wrap(x, depth, sorted, inCells, windowed);
        return v;
      }
      if (k === "FuncCall" && n.over === undefined && this.typed(v)?.node === "AGGREF") return v;
      if (k === "ColumnRef" && hasStar(v)) {
        if (depth > 0) return v;
        // `c.*` beside an aggregate: every column of c, each through any_value (DuckDB's COLUMNS expands the star)
        const call: AstNode = { FuncCall: { funcname: [S("any_value")], args: [{ FuncCall: { funcname: [S("columns")], args: [v], funcformat: "COERCE_EXPLICIT_CALL" } }], funcformat: "COERCE_EXPLICIT_CALL" } };
        this.done.add(bodyOf(call));
        return call;
      }
      if (k === "ColumnRef") {
        // an output name (`ORDER BY p` of `max(x) AS p`) is the target, no column: its shape may be another query's
        // column (the corpus run of fbbf8f08: `… GROUP BY p` outside read it as one, and any_value(p) nested aggregates)
        if (!cells && !windowed && depth === 0 && this.outputNamed(v, targets)) return v;
        const t = this.typed(v);
        // (a WINDOW's name Postgres bound by equality to an entry has no node at its offset: an input column all the same)
        const column = t?.node === "VAR" ? t.levelsUp === depth : windowed && depth === 0 && t === null;
        // a cell riding beside a FROM item's column the group decides (carry): its value is the group's too
        if (!(depth === 0 && isCellRef(v, this.cellPrefix)) && !column) return v;
        if (inCells) { this.readPerGroup.add(n); return v; }
        const call: AstNode = { FuncCall: { funcname: [S("any_value")], args: [v], funcformat: "COERCE_EXPLICIT_CALL" } };
        this.done.add(bodyOf(call));
        // typed as the column it reads: a sort's collation, a cast's source type
        this.typedLike.set(bodyOf(call), v);
        return call;
      }
      for (const [key, x] of Object.entries(n)) if (key !== "location") n[key] = wrap(x, depth, sorted, inCells, windowed);
      return v;
    };
    // EVERY CLAUSE POSTGRES EVALUATES AFTER GROUPING (PR 674 class round r2, the class post-grouping-clause-not-read-
    // per-group): the list, HAVING, ORDER BY, DISTINCT ON and the WINDOW clauses, each an expression of the Query's
    // targetList or havingQual in Postgres's analysis; the join tree (FROM, WHERE) and the GROUP BY are read per row
    for (const t of targets) { const tb = bodyOf(t); tb.val = wrap(tb.val, 0); }
    if (b.havingClause !== undefined) b.havingClause = wrap(b.havingClause, 0);
    if (Array.isArray(b.sortClause)) for (const s of b.sortClause as AstNode[]) { const sb = bodyOf(s); sb.node = wrap(sb.node, 0, true); }
    // (DISTINCT ON binds an output name first, as ORDER BY does: findTargetlistEntrySQL92)
    if (Array.isArray(b.distinctClause)) b.distinctClause = (b.distinctClause as unknown[]).map((d) => isNode(d) ? wrap(d, 0, true) : d);
    for (const w of (b.windowClause ?? []) as AstNode[]) if (isNode(w)) wrap(w, 0);
  }

  /**
   * `FETCH FIRST n ROWS WITH TIES` (DuckDB has none): the rows Postgres keeps — those past the OFFSET up to the n-th,
   * and every row after it whose keys equal its own — read off a rank and a row number over the ORDER BY:
   *
   *   SELECT __mason_c1 AS <its name>, … FROM (
   *     SELECT __mason_c1, …, rank() OVER w AS __mason_ties_rank, row_number() OVER w AS __mason_ties_row
   *     FROM (<the statement, no ORDER BY nor limit, each key no output is listed after its outputs>)
   *       AS __mason_ties_in(__mason_c1, …, __mason_ties_k1, …)
   *     WINDOW w AS (ORDER BY <each key: its output's column, or its own>)) AS __mason_ties,
   *   (<the count and the offset, read once>) AS __mason_ties_bound
   *   WHERE __mason_ties_row > <offset> AND (<count> IS NULL OR (<count> > 0 AND __mason_ties_rank - <offset> <= <count>))
   *   ORDER BY __mason_ties_row
   *
   * EVERY KEY IS READ THROUGH THE ONE RESOLVER (the class "an output not resolved to its column", issue 192): a key bound
   * to an output, by its number (beside a `*` too), its name or an expression equal to it (`keysBound`; a set operation's
   * by its number or name, which is all Postgres takes there), IS that output, read from its column by its place, so a
   * window, a set-returning function or a volatile function in it is the one value the row shows; any other key is
   * computed once, as a column of its own. The window builds a key over each as the ORDER BY would (a collation's, a
   * jsonb's, a citext's), each column typed as what it holds. The outer list is the statement's own columns by place,
   * named as Postgres names them, so a query around it reads what Postgres's would and no rank among them.
   *
   * Postgres's limits: the count and offset as bigints, a NULL count no limit and a NULL offset none, a count of 0 no
   * rows, and a negative one its error (2201X for the offset, read first; 2201W for the count).
   */
  private withTies(b: Body): AstNode {
    const setOperation = b.op !== undefined && b.op !== "SETOP_NONE";
    // a set operation's outputs are its first arm's (libpg-query writes the arms unwrapped)
    let arm: Body = b;
    while (arm.op !== undefined && arm.op !== "SETOP_NONE" && arm.larg !== undefined) arm = isNode(arm.larg) ? bodyOf(arm.larg) : arm.larg as Body;
    // (a VALUES's outputs are its first row's, named as Postgres names them)
    const rows = arm.targetList === undefined ? arm.valuesLists as AstNode[] | undefined : undefined;
    const listed = Array.isArray(rows) && rows.length > 0
      ? ((bodyOf(rows[0]!).items ?? []) as AstNode[]).map((val, i): AstNode => ({ ResTarget: { name: `column${i + 1}`, val } }))
      : (arm.targetList ?? []) as AstNode[];
    // THE CELLS ITS EXACT COLUMNS READ ARE THE ONE RECORD'S (the class "the cells a plan carries decided in two places",
    // PR 231): as many as `exactThrough` recorded for the statement, after its columns, whether its SELECT list writes
    // them (its own, a set operation's arms') or a `*` passes them through (a FROM item's, a WITH query's, nested). The
    // wrapper passes that many through and never counts them itself; its columns are the rest of the list
    const cellCount = this.cellsOf(b);
    const targets = listed.filter((t) => !isCellTarget(t, this.cellPrefix));
    if (targets.length !== listed.length && listed.length - targets.length !== cellCount) {
      throw new Error("the hidden columns of a FETCH … WITH TIES are not those its exact numbers read: report it, with the statement");
    }
    // (the columns are read by place: a `*` is as many as Postgres expanded it to, which only its analysis says)
    if (targets.some((t) => hasStar(bodyOf(t).val)) && this.analysedQuery(targets) === undefined) {
      throw new Error("a * under FETCH … WITH TIES is not in Postgres's analysis: report it, with the statement");
    }
    const outputs = this.outputs(targets);
    // its ORDER BY as Postgres analysed it: the statement's own keys, never one a rule added for its own sort
    const sorts = ((b.sortClause ?? []) as AstNode[]).filter((s) => kindOf(s) === "SortBy" && this.writtenKeys.has(bodyOf(s)));
    const nodes = sorts.map((s) => bodyOf(s).node as AstNode);
    const bound = setOperation
      ? nodes.map((n) => {
        const output = outputs[this.outputIndex(n, outputs)] ?? null;
        this.rowKey(output);
        return { output, constant: false as boolean | null, equal: false };
      })
      : this.keysBound(nodes, this.analysedQuery(targets)?.keys, "sorted", targets);
    // (a set operation's columns are typed as Postgres resolved them, never as its first SELECT's)
    const resolved = setOperation ? this.setOperationColumns(b) : null;
    const COLUMN = (i: number): string => `__mason_c${i + 1}`;
    const hidden: AstNode[] = [];
    const window: AstNode[] = [];
    sorts.forEach((s, i) => {
      const sb = bodyOf(s);
      const out = bound[i]!.output;
      // a set operation's key is one of its outputs, by its number or name, as Postgres takes it
      if (setOperation && out === null) throw new Error("a set operation's ORDER BY key is none of its outputs: report it, with the statement");
      // a constant key orders nothing (as the ORDER BY reads it, `orderBy`): every row ties on it
      if (!setOperation && sb.useOp === undefined && out?.twin !== true && (bound[i]!.constant ?? this.typed(out !== null ? out.value : nodes[i]!)?.constant) === true) return;
      // what the window's key holds: an output's column, or a column of its own computing the key
      const held = out !== null ? out.value : nodes[i]!;
      // (a COLLATE over the value is the key's collation: kept over the column, which holds the value under it)
      const collated = kindOf(held) === "CollateClause" ? bodyOf(held) : null;
      const value = collated !== null ? collated.arg as AstNode : held;
      // what the column is typed as: a set operation's as Postgres resolved it; a derived table's column read through
      // `s.*`, which Postgres analysed at no offset of the key's, as the subquery's target (`sortBy`); else the value
      const own = resolved !== null && out !== null ? resolved[out.at] ?? null : null;
      const like = out === null && kindOf(value) === "ColumnRef" && this.typed(value) === null ? this.derivedTarget(value, b) ?? value : value;
      const typed = own ?? this.typed(like);
      if (typed !== null && (typed.node === "ROWEXPR" || (typed.node === "VAR" && this.isRowType(typed.type)))) {
        throw new Unrewritable("a row used as a value here (compared, tested, grouped or sorted) is not supported by Mason", "compare, test or sort its columns", "row-value");
      }
      let column: string;
      // a numeric the engine holds as a double is ranked by its exact value's order key (`exactOrderKey`), a column of
      // its own (bytes: sorted as they are), computed in the query it keys: in a grouped one, per group (`overGroups`),
      // as the ORDER BY's rule builds it
      const exactOrder = !setOperation && typed?.type === NUMERIC && collated === null ? this.exactOrderKey(value, b) : null;
      // a set operation's column its record computes (issue 352): ranked by the record's exact order key, read over the
      // cells the ranked rows carry (`recordOrderKey`), never the engine's unified double
      const recordKey = setOperation && out !== null && collated === null ? this.recordOrderKey(b, out.at, (j) => ({ ColumnRef: { fields: [S(`${this.cellPrefix}${j}`)] } })) : null;
      if (recordKey !== null) {
        const key: Body = { ...sb, node: recordKey.node, location: -1 };
        // (a numeric's key sorts as its bytes; a text's is keyed by the sort's own rule, as its column would be)
        if (recordKey.keyed) this.done.add(key); else this.original.add(key);
        window.push({ SortBy: key });
        return;
      }
      if (exactOrder !== null) {
        hidden.push(exactOrder);
        column = `__mason_ties_k${hidden.length}`;
      } else if (out !== null) column = COLUMN(out.at);
      else {
        hidden.push(this.clone(value));
        column = `__mason_ties_k${hidden.length}`;
      }
      const read: AstNode = { ColumnRef: { fields: [S(column)] } };
      if (exactOrder !== null) { /* bytes, untyped: no rule rebuilds the key */ }
      else if (own !== null) this.synthetic.set(bodyOf(read), own);
      else this.typedLike.set(bodyOf(read), like);
      const key: Body = { ...sb, node: collated !== null ? { CollateClause: { ...collated, arg: read } } : read, location: -1 };
      // (its rule builds the key, as it does for an ORDER BY's)
      this.original.add(key);
      window.push({ SortBy: key });
    });
    // a DISTINCT ON keeps the first row of each of its sets: the ORDER BY, written for a sort, decides which
    const distinctOn = Array.isArray(b.distinctClause) && (b.distinctClause as unknown[]).some(isNode);
    if (distinctOn) this.orderBy(b);
    else delete b.sortClause;
    const count = b.limitCount as AstNode;
    const offset = b.limitOffset as AstNode | undefined;
    delete b.limitCount;
    delete b.limitOffset;
    b.limitOption = "LIMIT_OPTION_DEFAULT";
    // the cells after the columns, where the exact programs read them
    const cells = Array.from({ length: cellCount }, (_c, j) => `${this.cellPrefix}${j}`);
    if (hidden.length > 0) b.targetList = [...(b.targetList as AstNode[]), ...hidden.map((h, j) => ({ ResTarget: { name: `__mason_ties_k${j + 1}`, val: h } }))];
    const columns = [...outputs.map((o) => COLUMN(o.at)), ...cells, ...hidden.map((_h, j) => `__mason_ties_k${j + 1}`)];
    const plain = (body: Body): AstNode => ({ SelectStmt: { ...body, limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } });
    const read = (...f: string[]): AstNode => ({ ColumnRef: { fields: f.map(S) } });
    const target = (val: AstNode, name?: string): AstNode => ({ ResTarget: { ...(name !== undefined ? { name } : {}), val } });
    const W = "__mason_ties_w", RANK = "__mason_ties_rank", ROW = "__mason_ties_row", TIES = "__mason_ties", BOUND = "__mason_ties_bound";
    const ranked = plain({
      targetList: [
        ...outputs.map((o) => target(read(COLUMN(o.at)))),
        ...cells.map((c) => target(read(c))),
        target({ FuncCall: { funcname: [S("rank")], over: { name: W, frameOptions: 1058 }, funcformat: "COERCE_EXPLICIT_CALL" } }, RANK),
        target({ FuncCall: { funcname: [S("row_number")], over: { name: W, frameOptions: 1058 }, funcformat: "COERCE_EXPLICIT_CALL" } }, ROW),
      ],
      fromClause: [{ RangeSubselect: { subquery: { SelectStmt: b }, alias: { aliasname: "__mason_ties_in", colnames: columns.map(S) } } }],
      windowClause: [{ WindowDef: { name: W, ...(window.length > 0 ? { orderClause: window } : {}), frameOptions: 1058 } }],
    });
    // the count and the offset, each read once (as Postgres's executor reads them), as bigints
    const given = plain({ targetList: [target(cast(count, ["int8"]), "n"), target(offset === undefined ? intConst(0) : cast(offset, ["int8"]), "o")] });
    const raise = (code: string, message: string): AstNode => fn("error", [strConst(`mason[${code}]: ${message}`)]);
    const limits = plain({
      targetList: [
        target(caseWhen([[op("<", read("v", "o"), intConst(0)), raise("2201X", "OFFSET must not be negative")], [op("<", read("v", "n"), intConst(0)), raise("2201W", "LIMIT must not be negative")]], read("v", "n")), "n"),
        target({ CoalesceExpr: { args: [read("v", "o"), intConst(0)] } }, "o"),
      ],
      fromClause: [{ RangeSubselect: { subquery: given, alias: { aliasname: "v" } } }],
    });
    const [n, o] = [(): AstNode => read(BOUND, "n"), (): AstNode => read(BOUND, "o")];
    // THE LIMITS ARE READ WHETHER OR NOT A ROW IS (Postgres raises 2201W over no rows too): beside the ranked rows, the
    // bound's own row where its count is negative, which it never is past its CASE — so DuckDB reads the bound even
    // where it knows the rows are none (`WHERE false`). The bound is a WITH query of its own, materialized, so the
    // count and the offset are read once for both
    const check = plain({
      targetList: [...outputs, ...cells, RANK, ROW].map((): AstNode => target({ A_Const: { isnull: true } })),
      fromClause: [{ RangeVar: { relname: BOUND, inh: true, relpersistence: "p" } }],
      whereClause: op("<", n(), intConst(0)),
    });
    const ranks: AstNode = { SelectStmt: { op: "SETOP_UNION", all: true, larg: bodyOf(ranked), rarg: bodyOf(check), limitOption: "LIMIT_OPTION_DEFAULT" } };
    const outer = plain({
      withClause: { ctes: [{ CommonTableExpr: { ctename: BOUND, ctematerialized: "CTEMaterializeAlways", ctequery: limits } }] },
      targetList: [...outputs.map((out) => target(read(TIES, COLUMN(out.at)), out.name)), ...cells.map((c) => target(read(TIES, c), c))],
      fromClause: [{ RangeSubselect: { subquery: ranks, alias: { aliasname: TIES } } }, { RangeVar: { relname: BOUND, inh: true, relpersistence: "p" } }],
      whereClause: and([op(">", read(TIES, ROW), o()), or([isNull(n()), and([op(">", n(), intConst(0)), op("<=", op("-", read(TIES, RANK), o()), n())])])]),
      sortClause: [{ SortBy: { node: read(TIES, ROW), sortby_dir: "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }],
    });
    for (const x of [outer, ranked, given, limits, check, ranks]) this.done.add(bodyOf(x));
    this.wroteTies = true;
    return outer;
  }

  /** a set operation's SELECTs as Postgres's analysis tells them: an arm that is a set operation of its own is one
   *  SELECT where it has an ORDER BY, a LIMIT, a lock or a WITH (libpg-query writes the arms unwrapped) */
  private setOperationArms(b: Body): Body[] {
    const arms: Body[] = [];
    const leaves = (given: Body): void => {
      // (an arm `exactArms` wrapped is the arm it reads)
      const s = this.armWrapped.get(given) ?? given;
      if (isSetOp(s) && (s === b || !ownClauses(s))) { leaves(unwrappedArm(s.larg)); leaves(unwrappedArm(s.rarg)); return; }
      arms.push(s);
    };
    leaves(b);
    return arms;
  }

  /**
   * A SET OPERATION'S COLUMNS AS POSTGRES RESOLVED THEM (`setOperationOutputs`, src/duck/pgtree.ts): its analysis, known
   * by the SELECTs it combines (`setOperationArms`), each by the offsets its outputs hold (a VALUES by its rows'; a
   * `TABLE t` by none), and by the offsets its own limits hold, the one the most of them agree on (`picked`). A rewrite
   * that cannot be written without them refuses to guess (`required`); one that only reads them where they are found
   * (`castArms`) is given null.
   */
  private setOperationColumns(b: Body, required = true): Array<Typed | null> | null {
    return this.setOperationFound(b, required)?.columns ?? null;
  }
  /** a set operation's analysis (`setOperationColumns`), with each arm's own output types (`armTypes`) */
  private setOperationFound(b: Body, required: boolean): ReturnType<typeof setOperationOutputs>[number] | undefined {
    const arms = this.setOperationArms(b);
    const offsets = arms.map((a) => { let first = a; while (isSetOp(first)) first = unwrappedArm(first.larg); return this.offsetsIn(first.targetList ?? first.valuesLists ?? []); });
    const limits = this.offsetsIn([b.limitCount, b.limitOffset]);
    this.setOps ??= setOperationOutputs(this.analysisTree);
    const found = this.picked(this.setOps.filter((q) => q.arms.length === offsets.length),
      (q) => [...q.arms.map((at, i) => ({ parse: offsets[i]!, analysed: at })), { parse: limits, analysed: q.limits }],
      (q) => JSON.stringify(q.columns));
    if (found === undefined && required) throw new Error("a set operation is not in Postgres's analysis, or twice: report it, with the statement");
    return found;
  }
  private setOps: ReturnType<typeof setOperationOutputs> | undefined;

  /**
   * EACH ARM'S COLUMN AS THE SET OPERATION'S (the class "a set operation's column read as an arm's type", PR 231):
   * Postgres resolves one type for each column and coerces every arm's value to it, where DuckDB unifies the arms by its
   * own rules. A char(n) arm of a text column is its text WITHOUT its padding (`'a b  '` is `'a b'`, so a UNION, a
   * GROUP BY, a sort's ties and the text all read one value): it is written as the cast Postgres makes, through the
   * cast's own rule (`typeCast`), typed as the column Postgres resolved (`setOperationColumns`). Before anything reads
   * the arms (the exact numerics' cells, the walk). An integer arm of a numeric column is exact as it is (`exactArms`).
   * A set operation Postgres's analysis does not tell is left as it is written.
   */
  castArms(v: unknown, inner: WeakSet<Body> = new WeakSet()): void {
    if (Array.isArray(v)) { for (const x of v) this.castArms(x, inner); return; }
    if (v === null || typeof v !== "object") return;
    const b = isNode(v) ? bodyOf(v) : v as Body;
    if (isNode(v) && kindOf(v) === "SelectStmt" && isSetOp(b) && !inner.has(b)) {
      // (a set operation inside it that is no SELECT of its own is part of this one)
      const mark = (s: Body): void => { if (isSetOp(s) && s !== b && ["sortClause", "limitCount", "limitOffset", "lockingClause", "withClause"].every((k) => s[k] === undefined)) inner.add(s); if (isSetOp(s)) { mark(unwrappedArm(s.larg)); mark(unwrappedArm(s.rarg)); } };
      mark(b);
      const found = this.setOperationFound(b, false);
      const resolved = found?.columns ?? null;
      // a time arm of a timetz column (issue 167): Postgres casts it implicitly (time_timetz), which the arm must say;
      // where the analysis is not found, or the arm cannot be written, the statement is refused, never answered
      // with the engine's own unifying of the two
      if (found === undefined && (this.setOps ?? []).some((q) => q.columns.some((c, i) => c?.type === TIMETZ && q.armTypes.some((a) => a === null || a[i] === TIME)))) refuseTimetz();
      if (found !== undefined && resolved !== null) for (const [ai, arm] of this.setOperationArms(b).entries()) {
        const armTypes = found.armTypes[ai] ?? null;
        const timeArm = (i: number): boolean => resolved[i]?.type === TIMETZ && (armTypes === null || armTypes[i] === TIME);
        const targets = arm.targetList as AstNode[] | undefined;
        const rows = Array.isArray(arm.valuesLists) ? (arm.valuesLists as AstNode[]).map((r) => (isNode(r) ? bodyOf(r).items : r) as AstNode[]) : null;
        if (!isSetOp(arm) && !Array.isArray(targets) && rows !== null && rows.every(Array.isArray)) {
          for (const items of rows) items.forEach((x, i) => { if (timeArm(i)) items[i] = this.asImplicitTimetz(x); });
          continue;
        }
        if (isSetOp(arm) || !Array.isArray(targets) || targets.some((t) => hasStar(bodyOf(t).val))) {
          if (resolved.some((_, i) => timeArm(i))) refuseTimetz();
          continue;
        }
        targets.forEach((t, i) => {
          const tb = bodyOf(t), column = resolved[i] ?? null;
          const own = isNode(tb.val) ? this.typed(tb.val as AstNode) : null;
          if (timeArm(i) && isNode(tb.val)) {
            // (the column keeps its name: the cast's would be `timetz`)
            if (tb.name === undefined) tb.name = figureColname(tb.val as AstNode);
            tb.val = this.asImplicitTimetz(tb.val as AstNode);
            return;
          }
          if (own === null || column === null || own.type !== BPCHAR || (column.type !== TEXT && column.type !== VARCHAR)) return;
          const to: AstNode = { TypeCast: { arg: tb.val, typeName: { names: [S("pg_catalog"), S(column.type === TEXT ? "text" : "varchar")], typemod: -1 }, location: -1 } };
          this.synthetic.set(bodyOf(to), { ...column, node: "FUNCEXPR", format: 2, oid: null, args: [{ type: own.type, typmod: own.typmod }] });
          this.original.add(bodyOf(to));
          // (the column keeps its name: the cast's would be `text`)
          if (tb.name === undefined) tb.name = figureColname(tb.val as AstNode);
          tb.val = to;
        });
      }
    }
    for (const [k, x] of Object.entries(b)) this.castArms(armOf(k, x) ?? x, inner);
  }

  /**
   * `x` AS POSTGRES'S IMPLICIT time→timetz CAST (time_timetz, function 2047, COERCE_IMPLICIT_CAST): a cast node typed as
   * that FUNCEXPR, which the cast's own rule writes (`typeCast` → `timeAsTimetz`), so an implicit coercion and an
   * explicit `tm::timetz` send the same SQL (issue 167). Its analysed type is TIMETZ, which every rule above it reads.
   */
  private asImplicitTimetz(x: AstNode): AstNode {
    const to: AstNode = { TypeCast: { arg: x, typeName: { names: [S("pg_catalog"), S("timetz")], typemod: -1 }, location: -1 } };
    this.synthetic.set(bodyOf(to), { node: "FUNCEXPR", type: TIMETZ, typmod: -1, args: [{ type: TIME, typmod: -1 }], oid: 2047, format: 2, collation: 0, inputCollation: 0,
      levelsUp: null, datum: null, qualifier: null, renamed: null });
    this.original.add(bodyOf(to));
    return to;
  }

  /** `x`, a char(n), AS POSTGRES'S IMPLICIT CAST TO A TEXT OR A VARCHAR (text(bpchar), function 401, COERCE_IMPLICIT_CAST):
   *  a cast node typed as that FUNCEXPR, which the cast's own rule writes (its value without the trailing blanks), as
   *  castArms writes a char(n) arm of a text column */
  private asImplicitText(x: AstNode, own: Typed, to: number): AstNode {
    const cast: AstNode = { TypeCast: { arg: x, typeName: { names: [S("pg_catalog"), S(to === VARCHAR ? "varchar" : "text")], typemod: -1 }, location: -1 } };
    this.synthetic.set(bodyOf(cast), { node: "FUNCEXPR", type: to, typmod: -1, args: [{ type: own.type, typmod: own.typmod }], oid: 401, format: 2,
      collation: own.collation, inputCollation: own.collation, levelsUp: null, datum: null, qualifier: null, renamed: null });
    this.original.add(bodyOf(cast));
    return cast;
  }

  /**
   * EACH IMPLICIT time→timetz CAST POSTGRES ADDED, WRITTEN WHERE IT IS (the class "a coercion Postgres adds that the raw
   * tree lacks: the analysed node unread", issue 167). Postgres casts a time beside a timetz (an operator's operand, IN,
   * BETWEEN, IS DISTINCT FROM, NULLIF, a CASE's or COALESCE's arm, GREATEST, LEAST, an ARRAY's element, a VALUES row, a
   * function's argument) with time_timetz, which has no offset of its own: its ARGUMENT's analysed entry says so
   * (`Typed.implicitTimetz`, src/duck/pgtree.ts), and the raw node whose OWN entry it is (the outermost that reads it:
   * `'12:30'::time` is read by its cast and its literal) is wrapped in the cast (`asImplicitTimetz`), once, before the
   * walk: DuckDB would compare a TIME with a TIMETZ ignoring the offset, or refuse to mix them. An expression with no
   * entry of its own repeats a target (an ORDER BY's, a GROUP BY's: findTargetlistEntrySQL99) and is written as its
   * twin is: by the shape of the node that HOLDS the coercion (a bare `t.tm` is coerced in one place and not in
   * another). A set operation's arm is castArms's (Postgres leaves it as written). Every cast of the analysis must be
   * written: one that is not, an operand cast in one copy and not the other (BETWEEN a time and a timetz), or a bare
   * literal, is refused by name (time-timetz-coerced).
   *
   * EACH IMPLICIT CAST OF A char(n) TO A TEXT OR A VARCHAR, THE SAME WAY (PR 674 class round r3, the class
   * char-padding-in-sublink-test): Postgres casts a char(n) beside a text (an operator's or a function's argument, a
   * CASE or NULLIF arm, a VALUES row of a text column, a subquery's output compared with a text …) with text(bpchar),
   * which drops its trailing blanks: its argument's entry says so (`Typed.implicitText`), and the node is wrapped in the
   * cast (`asImplicitText`), so every place Postgres trimmed the value, the engine trims it, and a comparison's two
   * sides are never trimmed one alone. One it cannot write (a copy left a char(n), a bare literal) is left as written,
   * as before this rule: never refused.
   */
  coerceImplicit(root: unknown): void {
    const expected = implicitTimetzCasts(this.analysisTree);
    const listed = new Set<Typed>();
    let texts = 0;
    for (const list of this.types.values()) for (const t of list) { if (t.implicitTimetz === true) listed.add(t); if (t.implicitText !== undefined) texts++; }
    if (expected === 0 && texts === 0) return;
    if (listed.size !== expected) refuseTimetz();
    type Slot = { holder: AstNode; path: ReadonlyArray<string | number>; node: AstNode; text: Typed | null };
    const wraps: Slot[] = [], unanalysed: Slot[] = [];
    const claimed = new Set<Typed>();
    const byHolder = new Map<string, Set<string>>();
    const visit = (v: unknown, holder: AstNode | null, path: ReadonlyArray<string | number>): void => {
      if (Array.isArray(v)) { v.forEach((x, i) => visit(x, holder, [...path, i])); return; }
      if (v === null || typeof v !== "object") return;
      if (!isNode(v)) { for (const [k, x] of Object.entries(v as Body)) visit(x, holder, [...path, k]); return; }
      const own = this.ownEntries(v);
      const cast = own.filter((t) => t.implicitTimetz === true);
      const text = own.filter((t) => t.implicitText !== undefined);
      // (an entry an outer node of it took: a cast's literal)
      if (cast.length > 0 && !claimed.has(cast[0]!)) {
        // a copy of it left a time (BETWEEN a time and a timetz bound): one node cannot be written both ways. (Another
        // entry at its offset of another type is another node's: a set operation's output, at its first arm's)
        if (own.some((t) => t.implicitTimetz !== true && t.node === cast[0]!.node && t.type === cast[0]!.type) || holder === null || kindOf(v) === "A_Const") refuseTimetz();
        for (const t of cast) claimed.add(t);
        wraps.push({ holder: holder!, path, node: v, text: null });
        const key = shapeOf(holder!);
        const at = byHolder.get(key) ?? new Set<string>();
        at.add(JSON.stringify(path));
        byHolder.set(key, at);
      } else if (text.length > 0 && !claimed.has(text[0]!)) {
        for (const t of text) claimed.add(t);
        // (a copy of it left a char(n), or nothing holds it, or a bare literal: left as written, as before)
        const left = own.some((t) => t.implicitText === undefined && t.node === text[0]!.node && t.type === text[0]!.type);
        if (!left && holder !== null && kindOf(v) !== "A_Const") {
          wraps.push({ holder, path, node: v, text: text[0]! });
          const key = shapeOf(holder);
          const at = byHolder.get(key) ?? new Set<string>();
          at.add(JSON.stringify(path));
          byHolder.set(key, at);
        }
        const key = shapeOf(holder!);
        const at = byHolder.get(key) ?? new Set<string>();
        at.add(JSON.stringify(path));
        byHolder.set(key, at);
      } else if (own.length === 0 && holder !== null) unanalysed.push({ holder, path, node: v, text: null });
      for (const [k, x] of Object.entries(bodyOf(v))) { const arm = armOf(k, x); if (arm !== null) visit(arm, null, []); else visit(x, v, [k]); }
    };
    visit(root, null, []);
    for (const t of listed) if (!claimed.has(t)) refuseTimetz();
    // a twin's (the shapes read before any node is wrapped)
    const shapes = new Map<AstNode, string>();
    const shaped = (h: AstNode): string => { let k = shapes.get(h); if (k === undefined) { k = shapeOf(h); shapes.set(h, k); } return k; };
    const kindAt = new Map<string, Typed | null>();
    for (const w of wraps) kindAt.set(`${shaped(w.holder)}|${JSON.stringify(w.path)}`, w.text);
    const twins = unanalysed.filter((u) => byHolder.get(shaped(u.holder))?.has(JSON.stringify(u.path)) === true)
      .map((u) => ({ ...u, text: kindAt.get(`${shaped(u.holder)}|${JSON.stringify(u.path)}`) ?? null }));
    for (const { holder, path, node, text } of [...wraps, ...twins]) {
      let at: unknown = bodyOf(holder);
      for (const step of path.slice(0, -1)) at = (at as Record<string | number, unknown>)[step];
      const slot = at as Record<string | number, unknown>;
      const last = path.at(-1)!;
      if (slot[last] !== node) throw new Error("an implicit cast was not where its analysis was read: report it, with the statement");
      slot[last] = text !== null ? this.asImplicitText(node, text, text.implicitText!) : this.asImplicitTimetz(node);
    }
    // the wrapped expressions' shapes, for an ORDER BY or GROUP BY that repeats one (`typed`)
    if (wraps.length > 0) this.indexShapes(root);
  }

  /** whether a FETCH … WITH TIES was written (a generated table refuses one: src/duck/generated-plan.ts) */
  wroteTies = false;

  // ------------------------------------------------------------------------------------- exact numerics

  /** The statement's numeric result columns as programs, their cells appended to its SELECT list (before the walk,
   *  which rewrites each cell as it rewrites the column). Not a UNION, which would read the hidden cells as part of each
   *  row. A DISTINCT ON compares its ON expressions alone, so the cells ride beside them, the kept row's; a plain DISTINCT
   *  with a cell is written as the DISTINCT ON of every output by its number, which keeps the same rows and lets the cells
   *  ride so too: a numeric decided exactly never leaves the engine as a double's text. */
  exactColumns(stmt: AstNode, fields: ReadonlyArray<{ oid: number; typmod?: number }> | null): ExactColumn[] {
    if (kindOf(stmt) !== "SelectStmt" || fields === null) return [];
    const b = bodyOf(stmt);
    // (a FETCH … WITH TIES reads its outputs by place, the cells among them: `withTies`)
    if (b.op !== undefined && b.op !== "SETOP_NONE") return [];
    const plainDistinct = Array.isArray(b.distinctClause) && !b.distinctClause.every(isNode);
    const targets = (b.targetList ?? []) as AstNode[];
    // a query that selects cells already is never given them twice. No WITH query read twice reaches here: its programs
    // and its fields are derived once and every later reader is given them (`exactThrough`'s `derived`, read before
    // anything is derived from the query again), never this empty answer
    if (targets.some((t) => typeof bodyOf(t).name === "string" && (bodyOf(t).name as string).startsWith(this.cellPrefix))) return [];
    // A `*` BESIDE A NUMERIC THE ENGINE HOLDS AS A DOUBLE (issue 252, the PRINT reader): written out as the columns
    // Postgres expanded it to (`outputs`), so each is printed as any column is — a subquery's quotient by its program
    // over its cells, which then ride. Only where an output needs one: any other `*` is left as it is written
    if (targets.some((t) => hasStar(bodyOf(t).val))) {
      const written = this.starsWrittenForExact(b, targets, fields.length);
      if (written === null) return [];
      return this.exactColumns(stmt, fields);
    }
    if (targets.length !== fields.length) return [];
    const grouped = (Array.isArray(b.groupClause) && b.groupClause.length > 0) || b.havingClause !== undefined || targets.some((t) => this.hasAggregate(bodyOf(t).val));
    // (what the GROUP BY groups, as Postgres analysed it: `grouping`, an ordinal beside a `*` read by the one resolver)
    const groupShapes = new Set(this.grouping(b).keys());
    const cells: Array<{ node: AstNode; conv: CellConv; shape: string }> = [];
    const out: ExactColumn[] = [];
    targets.forEach((target, i) => {
      const field = fields[i]!;
      let node = bodyOf(target).val as AstNode;
      let text = false;
      // a numeric's text (a varchar(n) cuts it, which the program does not: left to the rewrite's cast), under a COLLATE
      // too, which orders the text and changes none of it (issue 358's `x::text COLLATE "C"`)
      const uncollated = kindOf(node) === "CollateClause" && isNode(bodyOf(node).arg) ? bodyOf(node).arg as AstNode : node;
      if (TEXTS.has(field.oid) && (field.typmod ?? -1) < 0 && kindOf(uncollated) === "TypeCast" && this.typeOf(bodyOf(uncollated).arg as AstNode) === NUMERIC) { node = bodyOf(uncollated).arg as AstNode; text = true; }
      // a subquery's column holding such a text (carry): its program, the text Postgres writes
      else if (TEXTS.has(field.oid) && (field.typmod ?? -1) < 0 && kindOf(node) === "ColumnRef" && (this.carry(node) as { text?: boolean } | null)?.text === true) text = true;
      else if (field.oid !== NUMERIC) return;
      const mine: typeof cells = [];
      const cell = (n: AstNode, conv: CellConv = "exact"): NumericProgram => {
        if (grouped && !this.validGrouped(n, groupShapes)) throw NOT_EXACT;
        const shape = `${conv}:${shapeOf(n)}`;
        let at = mine.findIndex((c) => c.shape === shape);
        if (at < 0) { mine.push({ node: n, conv, shape }); at = mine.length - 1; }
        return { op: "cell", key: String(at) };
      };
      const built = this.programOf(node, cell);
      // (the one test of whether its text needs the program: `programNeeded`)
      if (built === null || !this.programNeeded(node, built.p, mine, text ? -1 : field.typmod ?? -1)) return;
      // the column's cells after every earlier column's
      const base = cells.length;
      cells.push(...mine);
      out.push({ column: i, program: offsetCells(built.p, base), cells: [], text });
    });
    if (out.length === 0) return [];
    for (const c of out) c.cells = cells.map((x) => x.conv);
    if (plainDistinct) b.distinctClause = targets.map((_t, i) => intConst(i + 1));
    b.targetList = [...targets, ...cells.map((c, j) => ({ ResTarget: { name: `${this.cellPrefix}${j}`, val: this.clone(c.node) } }))];
    return out;
  }

  /** a SELECT list's `*`s written out as Postgres's expansion of them (`outputs`), where an output of it (a star's
   *  column or another) is a numeric the engine holds as a double (`duckExact`, the one decider); null where none is,
   *  or where they cannot be (a column twice under one name, no analysis of the list) */
  private starsWrittenForExact(b: Body, targets: readonly AstNode[], width: number): AstNode[] | null {
    if (b.op !== undefined && b.op !== "SETOP_NONE") return null;
    // (a `SELECT * FROM (q) s` passes q's cells through as they are: `exactThroughIn`'s pass-through)
    if (this.passThrough(b)?.columns === "star") return null;
    if (this.analysedQuery(targets) === undefined) return null;
    const outputs = this.outputs(targets);
    if (outputs.length !== width || outputs.some((o) => o.twin)) return null;
    // (a reference written for a star's column names it: two of one name under one FROM item would be one column)
    const refs = outputs.filter((o) => o.star).map((o) => names(bodyOf(o.value).fields).join(".").toLowerCase());
    if (new Set(refs).size !== refs.length) return null;
    if (!outputs.some((o) => this.typeOf(o.value) === NUMERIC && !this.duckExact(o.value))) return null;
    const written = targets.flatMap((t, i) => {
      if (!hasStar(bodyOf(t).val)) return [t];
      return outputs.filter((o) => o.target === i).map((o): AstNode => ({ ResTarget: { name: o.name, val: o.value } }));
    });
    b.targetList = written;
    this.forgetDecisions();
    return written;
  }
  /** the query levels a column reference the rewrite wrote is read in (a `*` written out), as `scopes` holds a written one's */
  private readonly refScopes = new WeakMap<Body, Frame[]>();

  /**
   * The exact columns of a statement whose outermost query PASSES THROUGH what an inner one computed: `SELECT * FROM
   * (inner) s`, a CTE read whole, the columns of one subquery by name (Metabase's nested question), a UNION ALL whose
   * every arm builds the same programs. The inner query selects its cells (`exactColumns`), the outer selects them
   * after its own columns, and the programs are the inner's at the outer's column. Anything else that computes over an
   * inner exact numeric reads DuckDB's value (docs/SQL-SUPPORT.md `nested-exact-numeric`).
   */
  exactThrough(stmt: AstNode, fields: Fields | null | (() => Fields | null)): ExactColumn[] {
    if (kindOf(stmt) !== "SelectStmt") return [];
    // DERIVED ONCE, AND EVERYTHING A LATER READER IS GIVEN WITH IT: a query read again (a WITH query two arms of a UNION
    // ALL read, directly, through another WITH query or a subquery) is given what its first read derived, whichever arm
    // read it first, before anything is derived from it again. Its programs derived again answered none (it selected
    // its cells already: PR 202 round 9); its FIELDS derived again (`outputFields`, a FROM item's reader) were typed over
    // the cells the first read appended, which cannot be: null, none, the arms disagreed and the union was the engine's
    // double (round 10). So a reader's fields are asked for only when nothing is derived yet (a function, `innerExact`)
    const known = this.derived.get(bodyOf(stmt));
    if (known !== undefined) return known.map((e) => ({ ...e }));
    const typed = typeof fields === "function" ? fields() : fields;
    let out: ExactColumn[] = [];
    if (typed !== null) {
      // the query's CTEs are visible to every query inside it (`WITH base AS (…) SELECT b.x FROM (SELECT * FROM base) b`)
      const ctes = bodyOf(stmt).withClause?.recursive === true ? [] : ((bodyOf(stmt).withClause?.ctes ?? []) as AstNode[]);
      this.cteScope.push(ctes);
      try { out = this.exactThroughIn(stmt, typed); } finally { this.cteScope.pop(); }
    }
    this.derived.set(bodyOf(stmt), out);
    return out.map((e) => ({ ...e }));
  }

  /** each query's exact columns as `exactThrough` first derived them, by the query (a trial's copy is its own query):
   *  the one record of them, which every reader (an arm, a FROM item's `innerExact`, a carry) reads */
  private readonly derived = new WeakMap<object, ExactColumn[]>();

  /** how many hidden cells a query's rows carry after its columns: its record's (`derived`), which says a query's
   *  cells wherever they are written — its own SELECT list, a `*` passing an inner query's through, a union's arms —
   *  so every reader that must pass them on (FETCH … WITH TIES's wrapper) reads them here, and none counts them */
  private cellsOf(b: Body): number {
    return this.derived.get(b)?.[0]?.cells.length ?? 0;
  }

  /** the CTEs of the queries `exactThrough` is inside, outermost first (a recursive WITH's are none: never read whole) */
  private readonly cteScope: AstNode[][] = [];

  // ------------------------------------------------------------------------------- an exact numeric carried

  /** each column reference's query levels, by its offset in the statement: the query it is in last, each with the
   *  WITH queries it declares (a clone keeps the offset, so it is found alike) */
  private readonly scopes = new Map<number, Frame[]>();
  /** each of the statement's own queries, with the query levels it is in (its own last): a WITH query a FROM name
   *  reads is resolved by these, the one resolver (`cteOf`), wherever the reading query is met */
  private readonly frames = new WeakMap<Body, Frame[]>();
  /** every query that reads a WITH query in its FROM, by the WITH query */
  private readonly cteReaders = new Map<Body, Body[]>();
  /** whether a FROM item's query's cells may ride, decided at its first column read (`carry`): true, or why not */
  private readonly rides = new Map<Body, true | string>();
  /** why each FROM item's column could not be carried, in the developer's words (`refuseUncarried`) */
  private readonly whyUncarried = new Map<Body, { what: string; where: string; why: string }>();
  /** the subqueries in a FROM given a name for their cells to be read by */
  private named = 0;

  /** the set operations whose rows are compared or counted, never printed (`markUnreadSetOps`) */
  private readonly unreadSetOps = new WeakSet<Body>();

  /**
   * THE SET OPERATIONS WHOSE COLUMNS NO ONE READS AS TEXT (`numeric-set-scales` refuses only where a row's text is read,
   * the class `refusal-wider-than-the-wrong-answer`): the query of an EXISTS, an IN, = ANY or ALL, which compares
   * values, and a FROM item of a query that names no column at all (`SELECT count(*) FROM (… UNION …) AS u`)
   */
  markUnreadSetOps(v: unknown): void {
    if (Array.isArray(v)) { for (const x of v) this.markUnreadSetOps(x); return; }
    if (v === null || typeof v !== "object" || !isNode(v)) return;
    const k = kindOf(v), b = bodyOf(v);
    const setOp = (n: unknown): Body | null => isNode(n) && kindOf(n) === "SelectStmt" && isSetOp(bodyOf(n)) ? bodyOf(n) : null;
    if (k === "SubLink" && ["EXISTS_SUBLINK", "ANY_SUBLINK", "ALL_SUBLINK"].includes(String(b.subLinkType))) { const q = setOp(b.subselect); if (q !== null) this.unreadSetOps.add(q); }
    if (k === "SelectStmt" && !isSetOp(b) && Array.isArray(b.fromClause)) {
      const names = (n: unknown): boolean => Array.isArray(n) ? n.some(names) : isNode(n) ? kindOf(n) === "ColumnRef" || Object.values(bodyOf(n)).some(names) : false;
      const outer = [b.targetList, b.whereClause, b.groupClause, b.havingClause, b.sortClause, b.windowClause, b.distinctClause];
      if (!names(outer)) for (const f of b.fromClause as AstNode[]) { if (kindOf(f) === "RangeSubselect") { const q = setOp(bodyOf(f).subquery); if (q !== null) this.unreadSetOps.add(q); } }
    }
    for (const x of Object.values(b)) this.markUnreadSetOps(x);
  }

  /** Before anything else: which query each column reference is read in (`carry` resolves its FROM item there) */
  scopeColumns(v: unknown, stack: Frame[] = []): void {
    if (Array.isArray(v)) { for (const x of v) this.scopeColumns(x, stack); return; }
    if (v === null || typeof v !== "object") return;
    if (isNode(v) && kindOf(v) === "SelectStmt") { this.scopeQuery(bodyOf(v), stack); return; }
    if (isNode(v) && kindOf(v) === "ColumnRef" && typeof bodyOf(v).location === "number") this.scopes.set(bodyOf(v).location as number, stack);
    for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) this.scopeColumns(x, stack);
  }

  private scopeQuery(b: Body, stack: Frame[]): void {
    const here: Frame[] = [...stack, { select: b, ctes: (b.withClause?.ctes ?? []) as AstNode[], recursive: b.withClause?.recursive === true }];
    this.frames.set(b, here);
    for (const item of fromLeaves(b.fromClause)) {
      if (kindOf(item) !== "RangeVar" || bodyOf(item).schemaname !== undefined) continue;
      const cte = cteIn(here, String(bodyOf(item).relname));
      if (cte !== null) this.cteReaders.set(bodyOf(cte.cte), [...this.cteReaders.get(bodyOf(cte.cte)) ?? [], b]);
    }
    // a set operation's arms are queries a level below it, as Postgres analyses them
    for (const [key, x] of Object.entries(b)) {
      if ((key === "larg" || key === "rarg") && x !== null && typeof x === "object") this.scopeQuery(x as Body, here);
      else this.scopeColumns(x, here);
    }
  }

  /** A ROW HOLDING A NUMERIC DECIDED EXACTLY (`(x / 1, y)`), compared, grouped or written, is refused by name: its
   *  members are the engine's values, compared and written as its doubles, where Postgres's are exact */
  refuseExactRows(v: unknown): void {
    if (Array.isArray(v)) { for (const x of v) this.refuseExactRows(x); return; }
    if (v === null || typeof v !== "object") return;
    if (isNode(v) && kindOf(v) === "RowExpr" && ((bodyOf(v).args ?? []) as unknown[]).some((m) => isNode(m) && this.exactKey(m) !== null)) {
      throw new Unrewritable("a row holding a numeric quotient or average is not supported by Mason (Postgres compares and writes the exact value, which the engine holds as a double)", "compare or select its members one by one: a = x AND b = y", "row-value");
    }
    for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) this.refuseExactRows(x);
  }

  /** after the outermost query's exact columns: every FROM item an exact numeric is read from carries its cells, before
   *  the walk rewrites the query that holds them (a rule meeting the column later finds them made: `innerExact`) */
  carryAll(v: unknown): void {
    if (Array.isArray(v)) { for (const x of v) this.carryAll(x); return; }
    if (v === null || typeof v !== "object") return;
    if (isNode(v) && kindOf(v) === "ColumnRef") { this.carry(v); return; }
    for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) this.carryAll(x);
  }

  /**
   * A NUMERIC A SUBQUERY DECIDED EXACTLY, READ OUTSIDE IT (the classes approximate-compared-as-exact and
   * approximate-printed-as-exact, PR 207's third round): a column of a FROM item — a subquery, a WITH query — whose
   * query computes it as the engine's double (a quotient, an avg) is its query's PROGRAM over that query's cells, which
   * ride as hidden columns of the item (`innerExact`, the same cells a pass-through reads), so every rule that asks for
   * a numeric's program — its text, its equality key, a sum's scale — has it, wherever the column is read: grouped,
   * joined, filtered, under an alias list or none. Decided ONCE, here, for the column, never per form of the query
   * that reads it. "uncarried": the column is such a value, and its cells cannot ride (the item is read by a `*` beside
   * other columns, a NATURAL JOIN or as a whole row, which would read them; its query computes no program): a rule that
   * must equate it refuses by name, never the double. null: anything else (a table's column, an exact value).
   */
  private carry(ref: AstNode): { program: NumericProgram; text: boolean; owner: string; convs: ExactColumn["cells"] } | "uncarried" | null {
    const found = this.fromColumn(ref);
    if (found === null) return null;
    const approximate = this.approximateAt(found.query, found.index);
    // (a numeric whose values are not found is not known exact: it cannot be carried, and is never compared as exact)
    if (approximate === null && this.typeOf(ref) === NUMERIC) return this.uncarried(found, "Mason cannot tell how that query computes it");
    if (approximate !== true) return null;
    // decided once for the item, before the walk (`carryAll`), which rewrites what the decision reads (a NATURAL JOIN
    // written as USING, a whole row as its columns' text)
    let rides = this.rides.get(bodyOf(found.query));
    if (rides === undefined) {
      const why = found.recursive ? "it is a recursive WITH query" : found.readers.map((r) => this.cellsMayRide(r.select, r.names, found.query)).find((w) => w !== null) ?? null;
      rides = why ?? true;
      this.rides.set(bodyOf(found.query), rides);
    }
    if (rides !== true) return this.uncarried(found, rides);
    // A CARRY IS DECIDED BEFORE THE WALK (`carryAll`), whose queries' widths every set operation's arms were counted
    // by (`exactArms`): a column the walk meets first (an ORDER BY 1 of a `*`, written out at the walk) whose query
    // selects no cells yet is the engine's value, never given cells late (issue 252: a UNION ALL's arm grew wider than
    // the arm beside it, 42804)
    // (an answer of the walk's time alone: no decision that read it is recorded, `decided`)
    if (this.walking && !this.derived.has(bodyOf(found.query))) { this.provisionalBelow = -1; return null; }
    const exact = this.innerExact(found.query).find((e) => e.column === found.index);
    if (exact === undefined) return this.uncarried(found, this.unwritable(found.query));
    // decided from what the item exposes, as it is written: its query (through a `*`, a WITH query's) holds the cells
    if (this.exposedCells(found.query) < exact.cells.length) return this.uncarried(found, "Mason cannot carry its exact digits out of it");
    // a subquery with no name (Postgres 16) is given one, so its cells can be read
    if (found.name === null && bodyOf(found.item).alias === undefined) bodyOf(found.item).alias = { aliasname: `__mason_from${this.named++}` };
    return { program: exact.program, text: exact.text, owner: found.name ?? String((bodyOf(found.item).alias as Body).aliasname), convs: exact.cells };
  }

  /** the FROM item a column reference reads (`fromItemOf`, by the query levels it is in), or null: a table's column */
  private fromColumn(ref: AstNode): ReturnType<Rewriter["fromItemOf"]> {
    if (kindOf(ref) !== "ColumnRef" || hasStar(ref)) return null;
    const t = this.typed(ref);
    const at = bodyOf(ref).location;
    if (t?.node !== "VAR" || t.column === undefined || t.levelsUp === null || typeof at !== "number") return null;
    const stack = this.refScopes.get(bodyOf(ref)) ?? this.scopes.get(at);
    if (stack === undefined || stack.length <= t.levelsUp) return null;
    return this.fromItemOf(stack.slice(0, stack.length - t.levelsUp), t.column.owner, t.column.name);
  }

  /**
   * A carried column's program over the cells `cell` makes of its item's hidden columns, each read as it rode. SHARED,
   * NEVER COPIED (issue 244, #484): every reference to one (FROM item, column) within one program's build (one `cell`)
   * is given the SAME node, so a level reading the column below k times holds one program of it, not k copies (k^depth
   * through a chain of levels). The cells it reads are made once, by the first reference, as the build's `cell` makes
   * them (deduplicated by shape, or one a call): every later reference reads those. A mapping that throws (a cell not
   * exact) is not kept, and throws again at the next reference. Sound because a program is never changed once made
   * (src/lib/pg-numeric.ts).
   */
  private carried(ref: AstNode, cell: (n: AstNode, conv?: CellConv) => NumericProgram): NumericProgram | "uncarried" | null {
    const c = this.carry(ref);
    if (c === null || c === "uncarried") return c;
    let built = this.carriedBy.get(cell);
    if (built === undefined) { built = new Map(); this.carriedBy.set(cell, built); }
    let byOwner = built.get(c.program);
    if (byOwner === undefined) { byOwner = new Map(); built.set(c.program, byOwner); }
    // (a column read per group, `readPerGroup`: its cells are read per group too, issue 665; a build reads them apart)
    const perGroup = this.readPerGroup.has(bodyOf(ref));
    const owner = perGroup ? `${c.owner}\u0000per group` : c.owner;
    const known = byOwner.get(owner);
    if (known !== undefined) return known;
    const cells = new Map<string, NumericProgram>();
    const program = mapCells(c.program, (k) => {
      let at = cells.get(k);
      if (at === undefined) {
        const read: AstNode = { ColumnRef: { fields: [S(c.owner), S(`${this.cellPrefix}${k}`)] } };
        if (perGroup) this.readPerGroup.add(bodyOf(read));
        at = k.startsWith("$") ? { op: "cell", key: k } : cell(read, c.convs[Number(k)]);
        cells.set(k, at);
      }
      return at;
    });
    byOwner.set(owner, program);
    return program;
  }
  /** each program build's carried programs (`carried`), by its `cell`: by the item's record's program (the one object
   *  `derived` holds for the column) and the item's name */
  private readonly carriedBy = new WeakMap<object, Map<NumericProgram, Map<string, NumericProgram>>>();

  /** the FROM item of a query (`frames`' last) a column is read from, by the name Postgres resolved it to: the item's
   *  query, the column's place in its outputs, and every query that reads the item (a WITH query's every reader) */
  private fromItemOf(frames: Frame[], owner: string | null, column: string): {
    item: AstNode; query: AstNode; index: number; name: string | null; recursive: boolean; readers: Array<{ select: Body; names: Set<string> }>;
  } | null {
    const frame = frames[frames.length - 1]!;
    const candidates: Array<{ item: AstNode; query: AstNode; name: string | null; colnames: string[]; recursive: boolean; cte: AstNode | null }> = [];
    for (const item of fromLeaves(frame.select.fromClause)) {
      const b = bodyOf(item);
      const aliasNames = ((b.alias?.colnames ?? []) as AstNode[]).map((n) => String(bodyOf(n).sval));
      if (kindOf(item) === "RangeSubselect" && isNode(b.subquery)) {
        // (a name `carry` gave it is none of Postgres's)
        const name = b.alias?.aliasname === undefined || String(b.alias.aliasname).startsWith("__mason_from") ? null : String(b.alias.aliasname);
        candidates.push({ item, query: b.subquery, name, colnames: aliasNames, recursive: false, cte: null });
      } else if (kindOf(item) === "RangeVar" && b.schemaname === undefined) {
        const cte = cteIn(frames, String(b.relname));
        if (cte === null || !isNode(bodyOf(cte.cte).ctequery)) continue;
        const own = ((bodyOf(cte.cte).aliascolnames ?? []) as AstNode[]).map((n) => String(bodyOf(n).sval));
        candidates.push({ item, query: bodyOf(cte.cte).ctequery as AstNode, name: b.alias?.aliasname ?? String(b.relname),
          colnames: own.map((n, i) => aliasNames[i] ?? n).concat(aliasNames.slice(own.length)), recursive: cte.recursive, cte: cte.cte });
      }
    }
    const matching = candidates.filter((c) => c.name === owner && (owner !== null || this.columnsOf(c.query, c.colnames).includes(column)));
    if (matching.length !== 1) return null;
    const m = matching[0]!;
    const columns = this.columnsOf(m.query, m.colnames);
    const index = columns.indexOf(column);
    if (index < 0 || columns.lastIndexOf(column) !== index) return null;
    const readers = m.cte === null ? [{ select: frame.select, names: new Set(m.name === null ? [] : [m.name]) }]
      : (this.cteReaders.get(bodyOf(m.cte)) ?? []).map((select) => ({ select, names: new Set(fromLeaves(select.fromClause)
        .filter((i) => kindOf(i) === "RangeVar" && bodyOf(i).relname === bodyOf(m.cte!).ctename).map((i) => String(bodyOf(i).alias?.aliasname ?? bodyOf(i).relname))) }));
    return { item: m.item, query: m.query, index, name: m.name, recursive: m.recursive, readers };
  }

  /** a FROM item's column names: its query's outputs under its alias list */
  private columnsOf(query: AstNode, colnames: readonly string[]): string[] {
    // (a VALUES list's are column1, column2, …; a set operation's its first SELECT's, a VALUES list's too, issue 342)
    let first = bodyOf(query);
    while (first.op !== undefined && first.op !== "SETOP_NONE" && first.larg !== undefined) first = first.larg;
    const rows = first.valuesLists as AstNode[] | undefined;
    const own = Array.isArray(rows) && rows.length > 0 ? ((bodyOf(rows[0]!).items ?? []) as unknown[]).map((_v, i) => `column${i + 1}`)
      : this.outputNames(query) ?? this.listed(query)?.map((o) => o.name) ?? [];
    return own.map((n, i) => colnames[i] ?? n);
  }

  /** a plain query's outputs, a `*` beside other columns listed as Postgres's analysis expands it (`outputs`), or
   *  null: a set operation, a VALUES list, a query the analysis does not hold */
  private listed(query: AstNode): Output[] | null {
    const b = bodyOf(query);
    if ((b.op !== undefined && b.op !== "SETOP_NONE") || !Array.isArray(b.targetList)) return null;
    return this.outputs(b.targetList as AstNode[]);
  }

  /** whether a query's i-th output is a numeric (or a numeric's text) the engine holds as a double where the plan has
   *  its program: in any arm of a set operation, through a `*` pass-through */
  private approximateAt(query: AstNode, index: number): boolean | null {
    const own = this.decided(query, index, "approximate", () => this.over(query, false, (values) => values.some((v) => this.approximateValue(v)), index));
    // (a UNION ALL's numeric column whose arms write it at several scales is its arms' programs, `exactArms`, issue 227:
    // read outside it, it is carried as a quotient is, so each row keeps its own arm's scale)
    return own === false && this.scalesDiffer(query, index) ? true : own;
  }

  /** whether a UNION ALL's numeric column (as Postgres resolved it) is written at several scales by the values it can be
   *  (`displayScale`, as `exactArms` decides it); a NULL writes none */
  private scalesDiffer(query: AstNode, index: number): boolean {
    const b = this.armWrapped.get(bodyOf(query)) ?? bodyOf(query);
    if (b.op !== "SETOP_UNION" || b.all !== true) return false;
    // (decided once per column, `decided`: read from the record inside a recursive WITH's cycle too, as main read its own)
    return this.decided(query, index, "scales", (): boolean => {
      if (this.setOperationColumns(b, false)?.[index]?.type !== NUMERIC) return false;
      const values = this.valuesAt(query, index);
      // (a recursive WITH query's own column read in its recursive arm writes the scale its rows compute, which no type
      // decides: the engine's, as before)
      const recursive = (v: unknown): boolean => Array.isArray(v) ? v.some(recursive) : isNode(v) ? (kindOf(v) === "ColumnRef" && this.fromColumn(v)?.recursive === true) || Object.values(bodyOf(v)).some(recursive) : false;
      return values !== null && !values.some(recursive) && new Set(values.filter((v) => !isNullValue(v)).map((v) => this.displayScale(v))).size > 1;
    }, true);
  }

  /**
   * A FROM ITEM'S COLUMN IS DECIDED ONCE (issue 244, the class "a fact derived again at every reference"): whether the
   * engine holds it exactly (`outputExact`), whether its text needs its program (`approximateAt`) and whether a UNION
   * ALL writes it at several scales (`scalesDiffer`) are each taken once per (query, output index) and read by every
   * reference, so `a + a + a` over the level below asks that level once, never three times a level (3^depth). The
   * record is keyed by the query's BODY as `valuesAt` reads it (an arm `exactArms` wrapped: the arm), stores the
   * deciders' answers and derives nothing of its own, and is copied by `clone` as `derived` is, so a trial copy and the
   * real pass read one decision. NEVER RECORDED: a decision that read an answer which holds only where it was asked —
   * `over`'s provisional `met` for a recursive WITH query whose cycle was open before the decision began, or `carry`'s
   * walk-time guard (issue 252) — so every answer read from the record is the one a fresh decision gives then. A query
   * whose own cycle is open is never read from the record (it answers `met`, as `over` does; `always` for scalesDiffer,
   * which no cycle answers). An in-place rewrite of a list a decision read (a `*` written out) drops the record whole
   * (`forgetDecisions`).
   */
  private decided<T extends boolean | null>(query: AstNode, index: number, which: "exact" | "approximate" | "scales", decide: () => T, always = false): T {
    if (!always && this.deciding.has(bodyOf(query))) return decide();
    const key = this.armWrapped.get(bodyOf(query)) ?? bodyOf(query);
    const at = `${which}:${index}`;
    const record = this.decisions.get(key);
    if (record?.has(at) === true) return record.get(at) as T;
    const outer = this.provisionalBelow, depth = this.deciding.size;
    this.provisionalBelow = Infinity;
    try {
      const answer = decide();
      if (this.provisionalBelow >= depth) {
        const own = this.decisions.get(key) ?? new Map<string, boolean | null>();
        own.set(at, answer);
        this.decisions.set(key, own);
      }
      return answer;
    } finally { this.provisionalBelow = Math.min(outer, this.provisionalBelow); }
  }
  private decisions = new WeakMap<Body, Map<string, boolean | null>>();
  /** the lowest `deciding` place a provisional answer was given at since the innermost decision began (-1: `carry`'s
   *  walk-time guard, below every place); a decision is recorded only where none was below its own start */
  private provisionalBelow = Infinity;
  /** a list a decision read was rewritten in place: every decision is taken again, as it would be fresh */
  private forgetDecisions(): void { this.decisions = new WeakMap(); }

  /** whether a FROM item's column is a value the engine computes exactly (`duckExact` of each value it can be); a
   *  column none of whose values is found is not (unknown is not exact) */
  private outputExact(query: AstNode, index: number): boolean {
    return this.decided(query, index, "exact", () => this.over(query, true, (values) => values.every((v) => this.duckExact(v)), index) ?? false);
  }

  /** a decision over a query's i-th output's values (`valuesAt`), or `met` where it is met again inside itself: a
   *  recursive WITH query's own column read in its recursive arm, which its other values decide. Null where its values
   *  are not found: COULDN'T TELL, which no caller reads as a decision (PR 207's fifth round: an empty list's `every`
   *  called a column exact that nothing had decided) */
  private over(query: AstNode, met: boolean, decide: (values: AstNode[]) => boolean, index: number): boolean | null {
    const b = bodyOf(query);
    const open = this.deciding.get(b);
    // (a provisional answer: no decision begun outside this cycle records what read it, `decided`)
    if (open !== undefined) { this.provisionalBelow = Math.min(this.provisionalBelow, open); return met; }
    this.deciding.set(b, this.deciding.size);
    try { const values = this.valuesAt(query, index); return values === null ? null : decide(values); } finally { this.deciding.delete(b); }
  }
  /** the bodies being decided (`over`), each at its place: the number open when it began */
  private readonly deciding = new Map<Body, number>();

  /** the values a query's i-th output can be: each arm's of a set operation, each row's of a VALUES list, through a
   *  `*` pass-through; a `*` beside other columns by the output Postgres's analysis puts there. Null where the output
   *  is a column a `*` lists (decided where it is read), or none is found */
  /** whether a call is percentile_disc or mode() WITHIN GROUP whose ORDER BY is a numeric the rewrite sorts by its exact
   *  order key (`exactOrderKey`, the one decider): it picks a row by that key and answers the row's value
   *  (`pickedByExactKey`), never the key (issue 486; PR 506's class round) */
  private picksByExactKey(b: Body): boolean {
    if (b.agg_within_group !== true || !["percentile_disc", "mode"].includes(lastName(b.funcname))) return false;
    const by = ((b.agg_order ?? []) as AstNode[])[0];
    const key = by === undefined ? undefined : bodyOf(by).node;
    return isNode(key) && this.typeOf(key) === NUMERIC && this.exactOrderKey(key, null) !== null;
  }

  /**
   * PERCENTILE_DISC OR MODE() PICKED BY AN EXACT ORDER KEY (`picksByExactKey`), answering the picked row's `value(key)`:
   * the engine's own value of the key under the raw reader (`withinGroup`, a double as any quotient), the program's text
   * under a program's cell (`exactOf`), so every reader of the aggregate (its print, a cast, a comparison, a sort, a
   * GROUP BY, a nullness test) reads it as it reads any numeric Mason computes exactly, never the key's bytes (PR 506's
   * class round, refusal-wider-than-the-wrong-answer; issue 538). Each row rides as row(key, value), NULL where the key
   * is: percentile_disc takes the position in the key's order; mode() the most frequent key in that order (Postgres's
   * tie: the first, `mode(k ORDER BY k)`) and then that key's row, so equal values of two scales count as one.
   * `b` is placed here (a caller with the original places its clone)
   */
  private pickedByExactKey(name: string, b: Body, value: (key: AstNode) => AstNode | null): AstNode | null {
    const sort = bodyOf(((b.agg_order ?? []) as AstNode[])[0]!);
    const key = sort.node as AstNode;
    const v = value(this.clone(key));
    if (v === null) return null;
    const k = (): AstNode => this.exactOrderKey(this.clone(key), null)!;
    const pair = caseWhen([[isNotNull(k()), row([k(), v])]], null);
    const second = (x: AstNode): AstNode => fn("struct_extract", [x, intConst(2)]);
    // (each aggregate made here is typed as the call it answers: an aggregate, which a GROUP BY's any_value leaves be)
    const aggregate = (x: AstNode): AstNode => { this.typedLike.set(bodyOf(x), { FuncCall: b }); return x; };
    if (name === "percentile_disc") return second(aggregate({ FuncCall: { ...b, agg_order: [{ SortBy: { ...sort, node: pair } }] } }));
    const each = (): AstNode => ({ ColumnRef: { fields: [S("__mason_e")] } });
    const listed = aggregate(fn("list", [pair], b.agg_filter === undefined ? {} : { agg_filter: this.clone(b.agg_filter as AstNode) }));
    const modal = aggregate({ FuncCall: { ...b, args: [k()], agg_order: [{ SortBy: { ...sort, node: k() } }], agg_within_group: undefined } });
    return second(fn("list_extract", [fn("list_filter", [listed, op("->", each(), op("=", fn("struct_extract", [each(), intConst(1)]), modal))]), intConst(1)]));
  }

  private valuesAt(query: AstNode, index: number): AstNode[] | null {
    // (an arm `exactArms` wrapped: the arm it reads)
    const b = this.armWrapped.get(bodyOf(query)) ?? bodyOf(query);
    if (b !== bodyOf(query)) return this.valuesAt({ SelectStmt: b }, index);
    if (b.op !== undefined && b.op !== "SETOP_NONE") {
      const arms = [b.larg, b.rarg].map((a) => a === undefined || a === null ? null : this.valuesAt({ SelectStmt: a }, index));
      return arms.some((a) => a === null) ? null : arms.flatMap((a) => a!);
    }
    const star = this.starOf(b);
    if (star !== null) return this.valuesAt(star, index);
    if (Array.isArray(b.valuesLists)) {
      const values = (b.valuesLists as AstNode[]).map((row) => ((bodyOf(row).items ?? []) as unknown[])[index]);
      return values.every(isNode) ? values as AstNode[] : null;
    }
    const output = this.listed(query)?.[index];
    if (output === undefined) return null;
    if (!output.star) return [output.value];
    // a column a `*` lists is what it reads: a table's column as it is, a FROM item's the values that item's column can
    // be (one level deeper, decided there); a column it cannot place, none
    const column = this.typed(output.value)?.column;
    const frames = this.frames.get(b);
    if (column === undefined || frames === undefined) return null;
    const found = this.fromItemOf(frames, column.owner, column.name);
    if (found !== null) return this.valuesAt(found.query, found.index);
    const table = fromLeaves(b.fromClause).some((i) => kindOf(i) === "RangeVar" && cteIn(frames, String(bodyOf(i).relname)) === null
      && String(bodyOf(i).alias?.aliasname ?? bodyOf(i).relname) === column.owner);
    return table ? [output.value] : null;
  }

  /** whether a value is a numeric (or a numeric's text) whose text needs the program the plan has (`programNeeded`) */
  private approximateValue(given: AstNode): boolean {
    // (a COLLATE orders a text and changes none of it)
    const v = kindOf(given) === "CollateClause" && isNode(bodyOf(given).arg) ? bodyOf(given).arg as AstNode : given;
    const type = this.typeOf(v);
    const text = type !== null && TEXTS.has(type) && kindOf(v) === "TypeCast" && isNode(bodyOf(v).arg) && this.typeOf(bodyOf(v).arg as AstNode) === NUMERIC;
    const numeric = text ? bodyOf(v).arg as AstNode : type === NUMERIC ? v : null;
    if (numeric === null) return false;
    const cells: Array<{ conv: CellConv }> = [];
    const built = this.programOf(numeric, (_m, conv = "exact") => { cells.push({ conv }); return { op: "cell", key: String(cells.length - 1) }; });
    return built !== null && this.programNeeded(numeric, built.p, cells, text ? -1 : this.typed(numeric)?.typmod ?? -1);
  }

  /**
   * WHETHER A NUMERIC'S TEXT NEEDS ITS PROGRAM — the one test of a column printed (`exactColumns`) and of a FROM item's
   * column carried (`carry`), so a column read alone and the same column beside another are computed alike (PR 207's
   * fourth round): the engine does not compute its value exactly (`duckExact`), or writes other digits (a scale the
   * copy dropped, a rounding, a parameter's text, a cell read from a float or a text). Not a numeric(p, s) value as it
   * is (`typmod` its own, -1 for its text): the wire pads it to s (src/duck/types.ts pgTypedColumn).
   */
  private programNeeded(node: AstNode, p: NumericProgram, cells: ReadonlyArray<{ conv: CellConv }>, typmod: number): boolean {
    if (this.duckExact(node) && !worthComputing(p) && cells.every((c) => c.conv === "exact")) return false;
    // a constant cast to numeric(p, s) that needs no rounding (its decimals within s, its whole digits within p - s): the
    // engine's DECIMAL(p, s) of it, which writes Postgres's digits at Postgres's scale (issue 358: a VALUES row's
    // `1.00000000000000000001::numeric(30,20)`, which no carry could take out of its list)
    if (this.duckExact(node) && p.op === "typmod" && p.arg.op === "literal" && literalFits(p.arg.text, p.precision, p.scale)) return false;
    return !(p.op === "pad" && p.arg.op === "cell" && typmod >= 4 && ((typmod - 4) & 0xffff) === p.scale);
  }

  /** whether a FROM item's hidden cells may ride in a query that reads it (null), or why not: never where they would be
   *  read as columns — a `*` (but the pass-through's own, which drops them), a NATURAL JOIN, the item's whole row */
  private cellsMayRide(select: Body, names: ReadonlySet<string>, query: AstNode): string | null {
    if (fromJoins(select.fromClause).some((j) => bodyOf(j).isNatural === true)) return "it is joined by a NATURAL JOIN";
    const passThrough = this.passThrough(select, true);
    if (passThrough !== null && passThrough.columns === "star" && passThrough.query === query) return null;
    const outputs = new Set(this.outputNames(query) ?? []);
    let rides: string | null = null;
    const look = (v: unknown, depth: number): void => {
      if (rides !== null || v === null || typeof v !== "object") return;
      if (Array.isArray(v)) { for (const x of v) look(x, depth); return; }
      if (isNode(v)) {
        const k = kindOf(v), n = bodyOf(v);
        if (k === "SelectStmt") { look(n.targetList, depth + 1); look(n.whereClause, depth + 1); return; }
        if (k === "ColumnRef") {
          const f = (n.fields ?? []) as AstNode[];
          if (hasStar(v) && depth === 0 && (f.length === 1 || names.has(String(bodyOf(f[0]!).sval)))) rides = "it is read by * beside other columns";
          if (f.length === 1 && kindOf(f[0]!) === "String" && names.has(String(bodyOf(f[0]!).sval)) && !outputs.has(String(bodyOf(f[0]!).sval))) rides = "its whole row is read";
          return;
        }
        for (const [key, x] of Object.entries(n)) if (key !== "fromClause") look(x, depth);
        return;
      }
      for (const x of Object.values(v as Body)) look(x, depth);
    };
    look(select.targetList, 0); look(select.whereClause, 0); look(select.havingClause, 0); look(select.groupClause, 0);
    look(select.sortClause, 0); look(select.distinctClause, 0); look(select.windowClause, 0); look(fromJoins(select.fromClause).map((j) => bodyOf(j).quals), 0);
    return rides;
  }

  /** a FROM item's query's exact columns, its cells appended to its SELECT list once (`exactThrough`'s one derivation:
   *  its fields are typed only before it, over the query as written) */
  private innerExact(query: AstNode): ExactColumn[] {
    return this.exactThrough(query, () => this.outputFields(query));
  }

  private exactThroughIn(stmt: AstNode, fields: ReadonlyArray<{ oid: number; typmod?: number }>): ExactColumn[] {
    const b = bodyOf(stmt);
    if (b.op === "SETOP_UNION" && b.all === true) return this.exactArms(b, fields);
    const direct = this.exactColumns(stmt, fields);
    if (direct.length > 0) return direct;
    const through = this.passThrough(b, true);
    // (never where the cells would be read as columns: the item's whole row, `SELECT s FROM (…) s`)
    if (through === null || this.cellsMayRide(b, new Set([through.alias]), through.query) !== null) return [];
    const inner = this.innerExact(through.query);
    if (inner.length === 0) return [];
    const cells = inner[0]!.cells.length;
    const targets = (b.targetList ?? []) as AstNode[];
    const cellRef = (j: number): AstNode => ({ ColumnRef: { fields: [S(through.alias), S(`${this.cellPrefix}${j}`)] } });
    const map = through.columns;
    const out = inner.flatMap((e) => (map === "star" ? [e.column] : map.flatMap((k, i) => k === e.column ? [i] : []))
      .filter((i) => i < fields.length && fields[i]!.oid === NUMERIC || e.text).map((column) => ({ ...e, column })));
    // (its record says its cells: a query that passes no exact column on selects none, so none is read as a column)
    if (out.length === 0) return [];
    if (through.columns !== "star") b.targetList = [...targets, ...Array.from({ length: cells }, (_, j) => ({ ResTarget: { name: `${this.cellPrefix}${j}`, val: cellRef(j) } }))];
    if (b.distinctClause !== undefined) this.distinctThrough(b, through, out, fields.length, cellRef);
    return out;
  }

  /**
   * A DISTINCT OVER A PASS-THROUGH (approximate-printed-as-exact, PR 207): the outer query reads the inner's cells
   * beside its columns, so a plain DISTINCT would compare them too, and its exact columns are the inner's doubles. It
   * is the DISTINCT ON of every output, an exact one by the exact key of its program over the inner's cells (`exactKey`
   * read through the pass-through), the rest by their number (a `*`: by the inner's output name); a DISTINCT ON's own
   * entries that name an exact column (by number or name) are keyed alike. The cells ride, the kept row's.
   */
  private distinctThrough(b: Body, through: { alias: string; columns: number[] | "star"; query: AstNode; colnames: string[] }, exact: ExactColumn[], outputs: number, cellRef: (j: number) => AstNode): void {
    const innerNames = through.columns === "star" ? this.outputNames(through.query)?.map((n, i) => through.colnames[i] ?? n) ?? null : null;
    const keyAt = (i: number): AstNode => {
      const e = exact.find((x) => x.column === i);
      if (e !== undefined) {
        const value = this.carriedText(e, cellRef);
        return e.text ? value : fn("__mason_numeric_key", [value]);
      }
      if (innerNames === null) return intConst(i + 1);
      const name = innerNames[i];
      if (name === undefined || innerNames.indexOf(name) !== innerNames.lastIndexOf(name)) throw new Unrewritable("SELECT DISTINCT * over a subquery with two columns of one name beside a numeric quotient is not supported by Mason", "name the columns: SELECT DISTINCT a, b, …", "numeric-quotient-equality");
      return { ColumnRef: { fields: [S(through.alias), S(name)] } };
    };
    const on = b.distinctClause as unknown[];
    if (on.length === 0 || !on.every(isNode)) { b.distinctClause = Array.from({ length: outputs }, (_, i) => keyAt(i)); return; }
    const targets = (b.targetList ?? []) as AstNode[];
    b.distinctClause = (on as AstNode[]).map((d) => {
      const n = constInt(d);
      let at = n !== null && n >= 1 && n <= outputs ? n - 1 : -1;
      if (at < 0 && kindOf(d) === "ColumnRef" && !hasStar(d)) {
        const f = names(bodyOf(d).fields), last = f[f.length - 1]!;
        // the inner column it reads, then the output that passes it through
        const inner = (innerNames ?? this.outputNames(through.query) ?? []).indexOf(last);
        at = through.columns === "star" ? inner : inner < 0 ? -1 : through.columns.indexOf(inner);
        if (at < 0 && f.length === 1) at = targets.findIndex((t, i) => i < outputs && bodyOf(t).name === last);
      }
      return at >= 0 && exact.some((x) => x.column === at) ? keyAt(at) : d;
    });
  }

  /**
   * A UNION ALL's exact columns. Where every arm builds the same programs, each arm's cells are the union's. Where they
   * differ (a column beside a quotient, a quotient beside a literal), EACH ARM CARRIES ITS OWN PROGRAM (the class
   * approximate-printed-as-exact, PR 207's third round): the arm's cells in slots of its own (NULL in the other arms'),
   * its number in a last cell, and the column is the program of the arm the row came from (`pick`); an arm with no
   * program at the column is one DuckDB holds exactly (a column, a literal), its own cell — so DuckDB unifying the
   * column to a double loses no arm's digits. An arm none of this can write (a `*`, a value with no program the engine
   * holds as a double) leaves the union DuckDB's.
   */
  private exactArms(b: Body, fields: ReadonlyArray<{ oid: number; typmod?: number }>): ExactColumn[] {
    // (its SELECTs as Postgres analyses them, `setOperationArms`: a UNION ALL of its own ORDER BY, limit or WITH is one,
    // whose cells are its own record's, read with its WITH queries in scope), each with the place it is held in, so an
    // arm whose own list cannot take the union's cells is wrapped there (below)
    const held: Array<{ parent: Body; key: "larg" | "rarg" }> = [];
    const flatten = (x: Body): void => {
      for (const key of ["larg", "rarg"] as const) {
        const a = unwrappedArm(x[key]);
        if (a.op === "SETOP_UNION" && a.all === true && a.larg !== undefined && a.rarg !== undefined && !ownClauses(a)) flatten(a);
        else held.push({ parent: x, key });
      }
    };
    flatten(b);
    const arms: AstNode[] = held.map((h) => ({ SelectStmt: unwrappedArm(h.parent[h.key]) }));
    // an arm typed otherwise than the union is cast by Postgres: not this program; but an integer arm of a numeric
    // column, which Postgres casts exactly to the integer's digits (`castArms`): its value is the engine's exact one. A
    // VALUES arm is typed by its rows as Postgres analysed them (issue 342: it was untyped, and the union the engine's)
    // (a column this computes nothing for is Postgres's to coerce, as it is written: only a numeric one is read here)
    const castExactly = (oid: number, to: number | undefined): boolean => oid === to || (to === NUMERIC && INTEGERS.has(oid));
    if (arms.some((a) => { const f = this.armFields(a, fields); return f === null || f.some((x, i) => fields[i]?.oid === NUMERIC && !castExactly(x.oid, NUMERIC)); })) return [];
    // THE TRIAL WRITES ONLY COPIES: of the arms, AND of the CTEs above them, which an arm that reads one appends its cells
    // to. A trial that wrote the real CTE left it selecting cells its arm, built again below, never read: arms of
    // different widths, which the engine refused (`WITH t AS (… sqrt(abs(x)) AS v …) SELECT v FROM t UNION ALL SELECT
    // sqrt(abs(x)) …`, PR 202 round 8). The copies are shared across the arms as the real CTEs are, so the trial is the
    // real pass run on a copy, and what it finds is what the real pass will. (A column an arm's copy CARRIES out of a
    // WITH query is resolved by where it is written, `carry`'s `scopes`: the real WITH query, derived once there, and
    // the real pass is given that one derivation, `exactThrough`'s `derived`)
    // THE FROM ITEMS THE ARMS CARRY OUT OF ARE DERIVED FIRST, ONCE, on the real tree (as `carryAll` derives them before
    // the walk), so each copy below is made with their records (`clone` copies `derived`) and its carry reads them, never
    // derives them again: a chain of unions each read through a subquery derived its lower levels once in the trial's
    // copy and again in the real pass, 2^depth (the class of issue 244; tests/duck-generated.test.ts "round 14")
    if (!this.walking) for (const a of arms) this.carryAll(a);
    const real = this.cteScope.splice(0);
    this.cteScope.push(...real.map((list) => this.clone(list)));
    let trial: Array<{ made: ExactColumn[]; listed: AstNode[]; exposed: number }>;
    try {
      trial = arms.map((a) => {
        const clone = this.clone(a);
        const made = this.exactThrough(clone, fields);
        return { made, listed: (bodyOf(clone).targetList ?? []) as AstNode[], exposed: this.exposedCells(clone) };
      });
    } finally { this.cteScope.splice(0, this.cteScope.length, ...real); }
    // THE SCALE EACH ARM WRITES A NUMERIC COLUMN AT (issue 227): Postgres resolves the column to numeric with no typmod
    // and coerces no arm's digits, so a row prints at its own arm's scale (an integer whole, a numeric(p, s) at s, a
    // literal as written, each VALUES row its own), where the engine unifies the arms to one DECIMAL scale. A column whose
    // arms' scales differ is computed from each arm's own cell; one whose arms agree keeps the engine's plan
    // (only where every arm's value there is one it can carry as its own cell: the engine's exact value, or a VALUES row's
    // text. A column of scales alone is the record's to improve, never to give up: one whose arm the engine holds as a
    // double (`sign(n)` beside an integer) stays the engine's union, and the union's other columns are still the record's
    // — PR 415's CI: a scaled `sign(n)` gave up `abs(n)` beside it, which main answered)
    const ownCell = (a: AstNode, k: number, i: number): boolean => {
      if (Array.isArray(bodyOf(a).valuesLists)) return true;
      if (isSetOp(bodyOf(a)) || trial[k]!.listed.some((t) => hasStar(bodyOf(t).val))) return this.outputExact(a, i);
      const v = trial[k]!.listed[i] === undefined ? undefined : bodyOf(trial[k]!.listed[i]!).val;
      return isNode(v) && this.duckExact(v);
    };
    const scaled = new Set(fields.flatMap((f, i) => f.oid === NUMERIC && new Set(arms.flatMap((a) => this.armScales(a, i))).size > 1
      && (trial.some((t) => t.made.some((e) => e.column === i)) || arms.every((a, k) => ownCell(a, k, i))) ? [i] : []));
    // A VALUES ROW'S NUMERIC THE ENGINE HOLDS AS A DOUBLE (a constant past its 38 digits, `'…'::numeric(65,30)`): the
    // column is each arm's own too, the row's text Postgres's (`valuesText`), so the engine's double is never printed
    const inexact = new Set(fields.flatMap((f, i) => f.oid === NUMERIC && arms.some((a) => Array.isArray(bodyOf(a).valuesLists)
      && (this.valuesAt(a, i) ?? []).some((v) => !isNullValue(v) && !this.duckExact(v))) ? [i] : []));
    // (each arm's record compared as TREES, by the one text of a program, whatever its sharing: `programJson`)
    const recordText = (made: readonly ExactColumn[]): string => JSON.stringify(made.map((e) => [e.column, e.text, e.cells, programJson(e.program)]));
    const first = recordText(trial[0]!.made);
    if (scaled.size === 0 && inexact.size === 0 && trial[0]!.made.length > 0 && trial.every((t) => recordText(t.made) === first)) return arms.map((a) => this.exactThrough(a, fields))[0]!;
    // the columns some arm computes, or whose arms' scales differ; every other arm's value there must be DuckDB's exact one
    // A NUMERIC'S TEXT some arm computes (`(x / 3)::text`) is a column of the record too: an arm that computes none
    // there is its own text, as the engine writes it (a cell read as text)
    // A "text" cell is by contract a NUMERIC's text, which the program parses: so a column is one only where EVERY arm's
    // value there is a numeric's text or a NULL (`numericTextValue`); a column some arm writes as any other text (a
    // text column, a char(n), a literal) is left out of the record, the engine's union as before (PR 415's review:
    // `(c / 3)::text … UNION ALL SELECT b` raised 22P02 parsing 'x' as a numeric)
    // (the column's type is Postgres's resolved one, `fields`, never an arm's: a numeric column is never a text cell; an
    // arm's value is a numeric's text where its own program says so, or where it is one by its analysed type)
    const armText = (k: number, i: number): boolean => trial[k]!.made.some((e) => e.column === i && e.text)
      || (this.valuesAt(arms[k]!, i) ?? [null]).every((v) => v !== null && this.numericTextValue(v));
    const texts = new Set(fields.flatMap((f, i) => f.oid !== NUMERIC && trial.some((t) => t.made.some((e) => e.column === i && e.text))
      && arms.every((_a, k) => armText(k, i)) ? [i] : []));
    const columns = fields.map((f, i) => texts.has(i) || (f.oid === NUMERIC && (scaled.has(i) || inexact.has(i) || trial.some((t) => t.made.some((e) => e.column === i)))) ? i : -1).filter((i) => i >= 0);
    if (columns.length === 0) return [];
    // AN ARM WHOSE OWN LIST CANNOT TAKE THE UNION'S CELLS (issue 342: a VALUES list, a set operation of its own clauses, a
    // `*` that passes an inner query's cells) is WRAPPED: `SELECT <its columns>, <the union's cells> FROM (<the arm>) AS
    // <name>(…)`, its own cells read from its last columns there. So every arm is widened by the ONE cell count decided
    // here, for the whole set operation: the engine never meets arms of different widths (its 42804). Decided over the
    // trial's copy, before any arm is written, so a set operation given up on writes none
    const wrapped = arms.map((a, k) => Array.isArray(bodyOf(a).valuesLists) || isSetOp(bodyOf(a)) || trial[k]!.listed.some((t) => hasStar(bodyOf(t).val)));
    // a VALUES arm's rows each write their own text (`valuesText`): the cells a row adds, one a column computed here.
    // WHAT A VALUES ARM APPENDS is ONE list (`appended`), read by its rows' items, its wrapper's column names and its
    // cells alike: a column with no program of the arm's own and not a numeric's text (a text column is read as its own
    // column, `c<i>`, which no row appends). PR 415's review r2: the width counted a text cell the rows never appended (42804)
    const appended = arms.map((_a, k) => columns.filter((i) => !texts.has(i) && !trial[k]!.made.some((e) => e.column === i)));
    const rowTexts = arms.map((a, k) => {
      if (!Array.isArray(bodyOf(a).valuesLists)) return null;
      return (bodyOf(a).valuesLists as AstNode[]).map((row) => appended[k]!.map((i) => {
        const item = ((bodyOf(row).items ?? []) as unknown[])[i];
        return isNode(item) ? this.valuesText(item) : null;
      }));
    });
    if (rowTexts.some((r) => r !== null && r.some((texts) => texts.some((t) => t === null)))) return [];
    for (const [k, a] of arms.entries()) {
      const t = trial[k]!;
      // every arm's cells its list's last entries: its own, or those its `*` passes (read from the wrapper's last columns)
      if (t.made.length > 0 && (wrapped[k] ? t.exposed : t.listed.length - fields.length) !== t.made[0]!.cells.length) return [];
      const valueLess = columns.filter((i) => !texts.has(i) && !t.made.some((e) => e.column === i));
      if (rowTexts[k] !== null) continue;
      if (wrapped[k] ? valueLess.some((i) => !this.outputExact(a, i)) : valueLess.some((i) => { const v = t.listed[i] === undefined ? undefined : bodyOf(t.listed[i]!).val; return !isNode(v) || !this.duckExact(v); })) return [];
    }
    // (an arm's column names, read before its cells are appended: a wrapper names its columns as the arm does, so a
    // union whose first arm it is keeps Postgres's names)
    const names = arms.map((a) => this.columnsOf(a, []));
    const made = arms.map((a) => this.exactThrough(a, fields));
    // each arm's cells: its own program's, then its plain values'
    const own = arms.map((a, k) => {
      const targets = (bodyOf(a).targetList ?? []) as AstNode[];
      const alias = `${this.cellPrefix}arm${this.named++}`;
      const read = (column: string): AstNode => ({ ColumnRef: { fields: [S(alias), S(column)] } });
      const ownCells = made[k]![0]?.cells ?? [];
      const cells: Array<{ node: AstNode; conv: CellConv }> = wrapped[k]
        ? ownCells.map((conv, j) => ({ node: read(`${this.cellPrefix}i${j}`), conv }))
        : targets.slice(fields.length).map((t, j) => ({ node: bodyOf(t).val as AstNode, conv: ownCells[j]! }));
      const programs = new Map<number, NumericProgram>();
      for (const i of columns) {
        const e = made[k]!.find((x) => x.column === i);
        if (e !== undefined) { programs.set(i, e.program); continue; }
        if (texts.has(i)) {
          cells.push({ node: wrapped[k] ? read(`${this.cellPrefix}c${i}`) : this.clone(bodyOf(targets[i]!).val as AstNode), conv: "text" });
          programs.set(i, { op: "cell", key: String(cells.length - 1) });
          continue;
        }
        if (rowTexts[k] !== null) {
          // (a VALUES row's text, after the arm's own cells in the wrapper's columns, at its place in `appended`)
          cells.push({ node: read(`${this.cellPrefix}i${ownCells.length + appended[k]!.indexOf(i)}`), conv: "text" });
          programs.set(i, { op: "cell", key: String(cells.length - 1) });
          continue;
        }
        const v = wrapped[k] ? null : bodyOf(targets[i]!).val as AstNode;
        cells.push({ node: v === null ? read(`${this.cellPrefix}c${i}`) : this.clone(v), conv: "exact" });
        const at: NumericProgram = { op: "cell", key: String(cells.length - 1) };
        // (a wrapped arm's column at the scale its values share, as `padded` reads a value's)
        const scales = v === null ? new Set((this.valuesAt(a, i) ?? []).map((x) => this.displayScale(x))) : null;
        const shared = scales === null || scales.size !== 1 ? null : [...scales][0]!;
        programs.set(i, v !== null ? this.padded(v, at) : shared !== null && shared > 0 ? { op: "pad", arg: at, scale: shared } : at);
      }
      return { targets: targets.slice(0, fields.length), cells, programs, alias, width: wrapped[k] ? ownCells.length + (rowTexts[k] !== null ? appended[k]!.length : 0) : 0 };
    });
    const total = own.reduce((n, o) => n + o.cells.length, 0);
    const offsets = own.map((_o, k) => own.slice(0, k).reduce((n, o) => n + o.cells.length, 0));
    const convs: ExactColumn["cells"] = [...own.flatMap((o) => o.cells.map((c) => c.conv)), "exact"];
    own.forEach((o, k) => {
      const slots: AstNode[] = Array.from({ length: total }, (): AstNode => ({ A_Const: { isnull: true } }));
      o.cells.forEach((c, j) => { slots[offsets[k]! + j] = c.node; });
      const cellTargets = [...slots, intConst(k)].map((val, j): AstNode => ({ ResTarget: { name: `${this.cellPrefix}${j}`, val } }));
      const arm = bodyOf(arms[k]!);
      let reads: Body = arm;
      if (!wrapped[k]) arm.targetList = [...o.targets, ...cellTargets];
      else {
        // a VALUES row writes its texts after its columns
        if (rowTexts[k] !== null) (arm.valuesLists as AstNode[]).forEach((row, r) => { bodyOf(row).items = [...(bodyOf(row).items as AstNode[]), ...rowTexts[k]![r]!]; });
        const colnames = [...fields.map((_f, i) => `${this.cellPrefix}c${i}`), ...Array.from({ length: o.width }, (_c, j) => `${this.cellPrefix}i${j}`)];
        reads = {
          targetList: [...fields.map((_f, i): AstNode => ({ ResTarget: { name: names[k]![i] ?? `?column?`, val: { ColumnRef: { fields: [S(o.alias), S(`${this.cellPrefix}c${i}`)] } } } })), ...cellTargets],
          fromClause: [{ RangeSubselect: { subquery: arms[k]!, alias: { aliasname: o.alias, colnames: colnames.map(S) } } }],
          limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
        };
        held[k]!.parent[held[k]!.key] = reads;
        this.armWrapped.set(reads, arm);
      }
      // (the arm's record is what it now selects: the union's cells, its own program in its slots; `cellsOf`)
      this.derived.set(reads, columns.map((i) => ({ column: i, text: texts.has(i), cells: convs, program: offsetCells(o.programs.get(i)!, offsets[k]!) })));
    });
    return columns.map((i) => ({ column: i, text: texts.has(i), cells: convs,
      program: { op: "pick", index: { op: "cell", key: String(total) }, args: own.map((o, k) => offsetCells(o.programs.get(i)!, offsets[k]!)) } }));
  }

  /** the arms `exactArms` wrapped, each wrapper to the arm it reads: Postgres's analysis knows the arm (`setOperationArms`,
   *  `valuesAt`) */
  private readonly armWrapped = new WeakMap<Body, Body>();

  /** an arm's column types, as Postgres analysed them: a SELECT's (`outputFields`), a VALUES list's by its rows (each
   *  row's value, a NULL none: Postgres coerced each to the column's type), or null where they are not known */
  private armFields(a: AstNode, fields: Fields): Array<{ oid: number; typmod: number }> | null {
    const rows = bodyOf(a).valuesLists;
    if (!Array.isArray(rows)) return this.outputFields(a);
    return fields.map((f, i) => {
      const types = (rows as AstNode[]).map((row) => ((bodyOf(row).items ?? []) as unknown[])[i]).filter((v) => !(isNode(v) && kindOf(v) === "A_Const" && bodyOf(v).isnull === true))
        .map((v) => isNode(v) ? this.typed(v)?.type ?? null : null);
      if (types.some((t) => t === null)) return { oid: -1, typmod: -1 };
      return { oid: types.includes(NUMERIC) ? NUMERIC : (types[0] ?? f.oid)!, typmod: -1 };
    });
  }

  /** the scales an arm writes its i-th column at (`displayScale`, null where its values' own digits decide): a VALUES
   *  list's each row's, a SELECT's its value's, any other arm's each value it can be (`valuesAt`); a NULL writes none */
  private armScales(a: AstNode, i: number): Array<number | null> {
    const b = bodyOf(a);
    const targets = (b.targetList ?? []) as AstNode[];
    const values: unknown[] = Array.isArray(b.valuesLists) ? (b.valuesLists as AstNode[]).map((row) => ((bodyOf(row).items ?? []) as unknown[])[i])
      : !isSetOp(b) && targets.length > 0 && !targets.some((t) => hasStar(bodyOf(t).val)) ? [targets[i] === undefined ? undefined : bodyOf(targets[i]!).val]
      : this.valuesAt(a, i) ?? [undefined];
    return values.filter((v) => !isNullValue(v)).map((v) => isNode(v) ? this.displayScale(v) : null);
  }

  /** a VALUES row's numeric as Postgres writes it: a value of constants by its program, evaluated here (its text a
   *  string); any other by the one builder of a value's text (`exactText`); a NULL a NULL text. Null where it has none */
  private valuesText(item: AstNode): AstNode | null {
    // (a NULL, cast or not: `NULL::numeric`, as a tool's VALUES row types its NULLs)
    const bare = stripCasts(item);
    if (kindOf(bare) === "A_Const" && bodyOf(bare).isnull === true) return cast(nullConst(), ["varchar"]);
    let cells = 0;
    const built = this.programOf(item, (_m, conv = "exact") => ({ op: "cell", key: `${conv}:${cells++}` }));
    if (built === null) return null;
    if (cells === 0 && cellsOf(built.p).length === 0) {
      const text = evaluateText(built.p, {});
      return text === null ? cast(nullConst(), ["varchar"]) : strConst(text);
    }
    return this.exactText(item);
  }

  /**
   * THE WITH QUERY A FROM NAME READS, from a query: its own WITH first, then the enclosing queries', innermost first (a
   * nearer one of the name shadows a farther); none of a recursive WITH (never read whole). A query of the statement's
   * own is resolved by the levels it is in (`frames`), as `carry` resolves its FROM items, so the two never name two
   * WITH queries (PR 207's fourth round: a carry decided over one `base`, its cells added to another); a copy of one (a
   * union arm's trial) by the WITH queries `exactThrough` is inside.
   */
  private cteOf(b: Body, name: string): AstNode | null {
    const frames = this.frames.get(b);
    if (frames !== undefined) { const found = cteIn(frames, name); return found === null || found.recursive ? null : found.cte; }
    if (b.withClause?.recursive === true) return null;
    const scopes = [(b.withClause?.ctes ?? []) as AstNode[], ...[...this.cteScope].reverse()];
    return scopes.map((list) => list.find((c) => bodyOf(c).ctename === name)).find((c) => c !== undefined) ?? null;
  }

  /** how many hidden cells a query's rows carry after its columns, as it is written now: its own `__mason_cell_n`
   *  targets, or those a `*` passes through (a set operation's: its first arm's) */
  private exposedCells(query: AstNode): number {
    let b = bodyOf(query);
    // (a set operation's own WITH queries are in scope of its first arm's `*`, which a copy finds by `cteScope` alone:
    // `(WITH t AS (…) SELECT * FROM t UNION ALL …)` as an arm, issue 358)
    const own: AstNode[][] = [];
    const scoped = (x: Body): void => { if (x.withClause !== undefined && x.withClause.recursive !== true) own.push((x.withClause.ctes ?? []) as AstNode[]); };
    while (b.op !== undefined && b.op !== "SETOP_NONE" && b.larg !== undefined) { scoped(b); b = b.larg; }
    scoped(b);
    this.cteScope.push(...own);
    try {
      const targets = (b.targetList ?? []) as AstNode[];
      const through = targets.length === 1 && hasStar(bodyOf(targets[0]!).val) ? this.passThrough(b) : null;
      if (through !== null && through.columns === "star") return this.exposedCells(through.query);
      return targets.filter((t) => String(bodyOf(t).name ?? "").startsWith(this.cellPrefix)).length;
    } finally { this.cteScope.splice(this.cteScope.length - own.length, own.length); }
  }

  /** an outer query that only reads one subquery's or CTE's columns: the inner query, its alias, and which inner
   *  column each outer one is ("star": all of them, in order) */
  private passThrough(b: Body, distinct = false): { query: AstNode; alias: string; columns: number[] | "star"; colnames: string[] } | null {
    if ((b.op !== undefined && b.op !== "SETOP_NONE") || b.groupClause !== undefined || b.havingClause !== undefined || (b.distinctClause !== undefined && !distinct) || b.windowClause !== undefined) return null;
    const from = (b.fromClause ?? []) as AstNode[];
    if (from.length !== 1) return null;
    const f = from[0]!;
    let query: AstNode | undefined, alias: string | undefined;
    if (kindOf(f) === "RangeSubselect") { query = bodyOf(f).subquery as AstNode; alias = bodyOf(f).alias?.aliasname; }
    else if (kindOf(f) === "RangeVar" && bodyOf(f).schemaname === undefined) {
      const cte = this.cteOf(b, String(bodyOf(f).relname));
      if (cte === null || bodyOf(cte).aliascolnames !== undefined) return null;
      query = bodyOf(cte).ctequery as AstNode; alias = bodyOf(f).alias?.aliasname ?? bodyOf(f).relname;
    }
    if (query === undefined || alias === undefined || kindOf(query) !== "SelectStmt") return null;
    const targets = (b.targetList ?? []) as AstNode[];
    if (targets.some((t) => this.hasAggregate(bodyOf(t).val))) return null;
    // (an alias list renames the columns a `*` reads, and leaves the cells after them their own names)
    const colnames = ((bodyOf(f).alias?.colnames ?? []) as AstNode[]).map((n) => String(bodyOf(n).sval));
    if (targets.length === 1 && hasStar(bodyOf(targets[0]!).val)) return { query, alias, columns: "star", colnames };
    if (colnames.length > 0) return null;
    const outputs = this.outputNames(query);
    if (outputs === null) return null;
    const columns = targets.map((t) => {
      const v = bodyOf(t).val as AstNode;
      if (kindOf(v) !== "ColumnRef" || hasStar(v)) return -1;
      const f = names(bodyOf(v).fields);
      const at = outputs.indexOf(f[f.length - 1]!);
      return at >= 0 && outputs.lastIndexOf(f[f.length - 1]!) === at ? at : -1;
    });
    return { query, alias, columns, colnames };
  }

  /** the query a `SELECT * FROM (q) s` passes through whole, or null: its output names and types are q's (a BI tool's
   *  `SELECT "sql".* FROM (…) AS "sql"` inside a query that names a column of it) */
  private starOf(b: Body): AstNode | null {
    // (only a lone `*` passes a query through whole: any other list is none, asked before `passThrough` maps its
    // columns, which reads the inner query's names, and so every level's below, at every call: #484's chains)
    const targets = (b.targetList ?? []) as AstNode[];
    if (targets.length !== 1 || !hasStar(bodyOf(targets[0]!).val)) return null;
    const through = this.passThrough(b);
    return through !== null && through.columns === "star" ? through.query : null;
  }

  /** a query's output column names, as Postgres names them (a set operation's are its first arm's) */
  private outputNames(q: AstNode): string[] | null {
    let b = bodyOf(q);
    while (b.op !== undefined && b.op !== "SETOP_NONE" && b.larg !== undefined) b = b.larg;
    const star = this.starOf(b);
    if (star !== null) return this.outputNames(star);
    const targets = (b.targetList ?? []) as AstNode[];
    if (targets.some((t) => hasStar(bodyOf(t).val))) return null;
    return targets.map((t) => bodyOf(t).name ?? figureColname(bodyOf(t).val as AstNode));
  }

  /** a query's output columns' types, as Postgres analysed them (a set operation's: its first arm's) */
  private outputFields(q: AstNode): Array<{ oid: number; typmod: number }> | null {
    let b = bodyOf(q);
    // a set operation's columns as Postgres resolved them, never its first SELECT's (an integer SELECT beside a numeric
    // one is a numeric column, issue 227)
    if (isSetOp(b)) {
      const resolved = this.setOperationColumns(b, false);
      if (resolved !== null && resolved.every((x) => x !== null)) return resolved.map((x) => ({ oid: x!.type, typmod: x!.typmod }));
    }
    while (b.op !== undefined && b.op !== "SETOP_NONE" && b.larg !== undefined) b = b.larg;
    const star = this.starOf(b);
    if (star !== null) return this.outputFields(star);
    const targets = (b.targetList ?? []) as AstNode[];
    // (a `*` beside other columns: each column of Postgres's expansion, typed by it, issue 252)
    const values = targets.some((t) => hasStar(bodyOf(t).val)) && this.analysedQuery(targets) !== undefined
      ? this.outputs(targets).map((o) => o.value) : targets.map((t) => bodyOf(t).val as AstNode);
    const out = values.map((v) => { const x = this.typed(v); return x === null ? null : { oid: x.type, typmod: x.typmod }; });
    return out.some((x) => x === null) ? null : out as Array<{ oid: number; typmod: number }>;
  }

  /** whether an expression holds an aggregate (outside a subquery) */
  private hasAggregate(v: unknown): boolean {
    if (Array.isArray(v)) return v.some((x) => this.hasAggregate(x));
    if (v === null || typeof v !== "object") return false;
    if (isNode(v)) {
      if (kindOf(v) === "SubLink") return false;
      if (kindOf(v) === "FuncCall" && bodyOf(v).over === undefined && this.typed(v)?.node === "AGGREF") return true;
      return Object.values(bodyOf(v)).some((x) => this.hasAggregate(x));
    }
    return Object.values(v as Body).some((x) => this.hasAggregate(x));
  }

  /** whether a cell can be selected on its own in a grouped SELECT: a GROUP BY expression, an aggregate or a window
   *  function, a constant, or built of those */
  private validGrouped(n: AstNode, groupShapes: ReadonlySet<string>): boolean {
    if (groupShapes.has(shapeOf(n))) return true;
    const k = kindOf(n);
    if (k === "A_Const") return true;
    // a column of this query Postgres accepted outside the GROUP BY is one the group's key decides: valid, and read
    // through any_value when the walk reaches its cell (decidedByKey)
    if (k === "ColumnRef") { const t = this.typed(n); return (t?.node === "VAR" && t.levelsUp === 0) || isCellRef(n, this.cellPrefix); }
    if (k === "SubLink") return false;
    if (k === "FuncCall" && (bodyOf(n).over !== undefined || this.typed(n)?.node === "AGGREF")) return true;
    // a lambda the rewrite wrote (`pickedByExactKey`'s mode()): its parameter is no column of the query
    if (k === "A_Expr" && lastName(bodyOf(n).name) === "->" && isNode(bodyOf(n).lexpr) && isNode(bodyOf(n).rexpr)) {
      return this.validGrouped(bodyOf(n).rexpr as AstNode, new Set([...groupShapes, shapeOf(bodyOf(n).lexpr as AstNode)]));
    }
    const children = Object.values(bodyOf(n)).flatMap((x) => Array.isArray(x) ? x : [x]).filter(isNode);
    return children.every((c) => this.validGrouped(c, groupShapes));
  }

  /** An expression as a program over cells (`cell` makes one), or null where it is not a numeric Postgres's rules
   *  decide here; `kind` int where the value is an integer (integer arithmetic is DuckDB's, one cell). */
  private exactOf(n: AstNode, cell: (n: AstNode, conv?: CellConv) => NumericProgram): Built | null {
    const k = kindOf(n), b = bodyOf(n);
    const type = this.typeOf(n);
    const asCell = (): Built | null => type !== null && INTEGERS.has(type) ? { p: cell(n), kind: "int" } : type === NUMERIC ? { p: this.padded(n, cell(n)), kind: "numeric" } : null;
    const numeric = (p: NumericProgram): Built => ({ p, kind: "numeric" });
    const sub = (x: unknown): Built | null => isNode(x) ? this.exactOf(x, cell) : null;
    switch (k) {
      // a numeric parameter is its bound text, as Postgres reads it (DuckDB is given it as a double: 15 digits)
      case "ParamRef": return type === NUMERIC ? numeric({ op: "cell", key: `$${b.number}` }) : asCell();
      // a column of a FROM item whose query decided it exactly: that query's program over its cells, which ride (carry)
      case "ColumnRef": {
        const carried = this.carried(n, cell);
        return carried === "uncarried" ? null : carried !== null ? numeric(carried) : asCell();
      }
      // A SCALAR SUBQUERY whose one column has a program (issue 350): ONE cell, read as text, the subquery answering its
      // column's exact text, built inside it by the one builder (`subqueryText`), so every reader of the value (its
      // print, a cast, =, IN, a sort key, a sum) follows from the program, as a FROM item's column does
      case "SubLink": {
        if (type !== NUMERIC) return asCell();
        const text = this.subqueryText(n);
        return text === null ? asCell() : numeric(cell(text, "text"));
      }
      case "A_Const": {
        if (b.ival !== undefined) return { p: { op: "literal", text: String(b.ival.ival ?? 0) }, kind: "int" };
        if (b.fval !== undefined) return numeric({ op: "literal", text: positional(String(b.fval.fval)) });
        const v = constString(n);
        const literal = v !== null && type === NUMERIC ? numericLiteral(v) : null;
        if (literal !== null) return numeric({ op: "literal", text: literal });
        return null;
      }
      case "A_Expr": {
        const name = lastName(b.name);
        // NULLIF(a, b) of a numeric the engine holds as a double (issue 242): a's program where the row's a is not equal
        // to b by the one comparison of a quotient (`exactEquality`: both exact keys), else NULL (the index past the arm)
        if (b.kind === "AEXPR_NULLIF" && type === NUMERIC && isNode(b.lexpr) && isNode(b.rexpr) && !this.duckExact(b.lexpr)) {
          const l = sub(b.lexpr);
          const sides = l === null ? null : this.exactEquality(this.clone(b.lexpr), this.clone(b.rexpr));
          if (l === null || sides === null) return asCell();
          // (its NULL is ONE representation, a NULL index on EVERY row whose value is NULL — equal, or the operand NULL —
          // so a reader that regroups the carried cells, any_value of each, never meets a row's 0 beside another's
          // operand: review r1 of PR 506, nullif-pick-null-lost-outside-subquery)
          const keyL = this.clone(sides[0]);
          return numeric({ op: "pick", index: cell(caseWhen([[or([op("=", sides[0], sides[1]), isNull(keyL)]), nullConst()]], intConst(0))), args: [l.p] });
        }
        // x ^ y: Postgres's own power, as power(x, y) is (`pgNumeric`)
        if (b.kind === "AEXPR_OP" && name === "^" && type === NUMERIC) { const text = this.pgNumeric(n); return text === null ? asCell() : numeric(cell(text, "text")); }
        if (b.kind !== "AEXPR_OP" || !["+", "-", "*", "/", "%"].includes(name)) return asCell();
        if (type !== NUMERIC) return asCell();
        if (b.lexpr === undefined) { const r = sub(b.rexpr); return r === null ? null : name === "-" ? numeric({ op: "neg", arg: r.p }) : r; }
        const l = sub(b.lexpr), r = sub(b.rexpr);
        if (l === null || r === null) return null;
        const ops = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod" } as const;
        return numeric({ op: ops[name as "+"], args: [l.p, r.p] });
      }
      case "TypeCast": {
        const target = lastName(b.typeName?.names);
        if (target !== "numeric" && target !== "decimal") return asCell();
        const arg = b.arg as AstNode;
        const from = this.typeOf(arg);
        const inner: Built | null = from !== null && FLOATS.has(from) ? numeric(cell(arg, from === FLOAT4 ? "float4" : "float8"))
          // a text: the digits Postgres's numeric_in reads (`1.50` keeps its scale, `1_000.5` is 1000.5)
          : from !== null && TEXTS.has(from) && from !== UNKNOWN && constString(arg) === null ? numeric(cell(pgCall("text", "a1::numeric", [this.clone(arg)]), "parsed"))
          : sub(arg);
        if (inner === null) return null;
        const mods = ((b.typeName?.typmods ?? []) as AstNode[]).map((m) => constInt(m));
        if (mods.length === 0) return numeric(inner.p);
        if (mods.some((m) => m === null)) return null;
        return numeric({ op: "typmod", arg: inner.p, precision: mods[0]!, scale: mods[1] ?? 0 });
      }
      case "CaseExpr": {
        // each arm as its own program, and the arm the row took as an integer cell: the same CASE with each result its
        // arm's number (the ELSE the last; past the arms, a CASE without one, NULL). Only the taken arm is computed, as
        // in Postgres, and an arm's cells are read only on its rows (`CASE WHEN <its arm> THEN … END`): DuckDB computes
        // every cell on every row, and sqrt(x) of an arm `WHEN x > 0` raised on the rest
        if (type !== NUMERIC) return asCell();
        const whens = (b.args ?? []) as AstNode[];
        const index = (): AstNode => ({ CaseExpr: { ...(b.arg === undefined ? {} : { arg: this.clone(b.arg) }),
          args: whens.map((w, i) => ({ CaseWhen: { expr: this.clone(bodyOf(w).expr), result: intConst(i) } })), defresult: intConst(whens.length) } });
        const onItsRows = (i: number) => (m: AstNode, conv?: CellConv): NumericProgram =>
          cell(kindOf(m) === "ColumnRef" || !holdsKind(m, "ColumnRef") ? m : caseWhen([[op("=", index(), intConst(i)), m]], null), conv);
        const results = [...whens.map((w) => bodyOf(w).result), ...(b.defresult === undefined ? [] : [b.defresult])];
        const arms = results.map((r, i) => isNode(r) ? this.exactOf(r, onItsRows(i)) : null);
        if (arms.some((a) => a === null)) return asCell();
        return numeric({ op: "pick", index: cell(index()), args: arms.map((a) => a!.p) });
      }
      case "MinMaxExpr": case "CoalesceExpr": {
        if (type !== NUMERIC) return asCell();
        const args = ((b.args ?? []) as AstNode[]).map(sub);
        if (args.some((a) => a === null)) return null;
        const opName = k === "CoalesceExpr" ? "coalesce" : b.op === "IS_GREATEST" ? "greatest" : "least";
        return numeric({ op: opName, args: args.map((a) => a!.p) });
      }
      case "FuncCall": {
        const name = lastName(b.funcname);
        const args = (b.args ?? []) as AstNode[];
        const plain = b.over === undefined && b.agg_within_group !== true;
        if (type !== NUMERIC) return asCell();
        // percentile_disc or mode() picked by an exact order key: the picked row's exact text (`pickedByExactKey`)
        if (this.picksByExactKey(b)) {
          const text = this.pickedByExactKey(name, bodyOf(this.clone(n)), (key) => this.exactText(key));
          return text === null ? asCell() : numeric(cell(text, "text"));
        }
        switch (name) {
          case "round": case "trunc": {
            if (!plain || args.length < 1 || args.length > 2) return asCell();
            const x = sub(args[0]);
            const scale = args.length === 2 ? constInt(args[1]) : 0;
            if (x === null || scale === null) return asCell();
            return numeric({ op: name, arg: x.p, scale });
          }
          case "abs": case "floor": case "ceil": case "ceiling": {
            const x = args.length === 1 ? sub(args[0]) : null;
            return x === null ? asCell() : numeric({ op: name === "ceiling" ? "ceil" : name, arg: x.p });
          }
          case "mod": {
            const x = sub(args[0]), y = sub(args[1]);
            return x === null || y === null ? asCell() : numeric({ op: "mod", args: [x.p, y.p] });
          }
          case "ln": case "log": case "log10": case "exp": case "sqrt": case "power": case "pow": {
            const text = this.pgNumeric(n);
            return text === null ? asCell() : numeric(cell(text, "text"));
          }
          case "avg": {
            // Postgres's avg of an integer or a numeric is its sum divided by its count, both exact (int8_avg,
            // numeric_avg): DuckDB computes each, with the same DISTINCT, FILTER and window
            if (b.agg_within_group === true || args.length !== 1 || b.agg_star === true) return asCell();
            const argType = this.typeOf(args[0]!);
            if (argType === null || !(INTEGERS.has(argType) || argType === NUMERIC)) return asCell();
            const as = (f: string): AstNode => ({ FuncCall: { ...this.clone(b), funcname: [S(f)] } });
            const sum = as("sum");
            return numeric({ op: "div", args: [this.summed(b, args[0]!, sum, cell), cell(as("count"))] });
          }
          case "stddev": case "stddev_samp": case "stddev_pop": case "variance": case "var_samp": case "var_pop": {
            // Postgres's stddev and variance of an integer or a numeric are exact (numeric_stddev_internal), from N, Σx
            // and Σx², which DuckDB computes exactly, with the same FILTER and window. Not DISTINCT: the distinct values'
            // squares are not the distinct squares (-1 and 1)
            if (b.agg_within_group === true || args.length !== 1 || b.agg_star === true || b.agg_distinct === true) return asCell();
            const argType = this.typeOf(args[0]!);
            if (argType === null || !(INTEGERS.has(argType) || argType === NUMERIC)) return asCell();
            // a numeric only where its type bounds its digits: numeric(p ≤ 18, s), read as its unscaled bigint (x·10^s).
            // An unconstrained one (copied at the widest scale its values use) or a wider one could overflow DuckDB's 38
            // digits, where Postgres answers: DuckDB's double, the numeric-stddev gap
            const typmod = this.typed(n)?.args[0]?.typmod ?? -1;
            const precision = typmod >= 4 ? ((typmod - 4) >> 16) & 0xffff : null, scale = typmod >= 4 ? (typmod - 4) & 0xffff : 0;
            if (argType === NUMERIC && (precision === null || precision > 18)) return asCell();
            const as = (f: string, arg?: AstNode): AstNode => ({ FuncCall: { ...this.clone(b), funcname: [S(f)], ...(arg === undefined ? {} : { args: [arg] }) } });
            const x = args[0]!;
            const sum = as("sum");
            // x² of an int2 or int4 as a HUGEINT
            const squares = (): NumericProgram => cell(as("sum", op("*", cast(this.clone(x), ["hugeint"]), cast(this.clone(x), ["hugeint"]))));
            // a bigint's squares may pass a HUGEINT's 1.7e38 (two near 2^63): u = h·2^32 + l, so Σu² = Σh²·2^64 +
            // Σhl·2^33 + Σl², three sums that fit; a numeric(p ≤ 18, s) is u·10^-s, its Σx² that times 10^-2s
            const splitSquares = (u: () => AstNode, s: number): NumericProgram => {
              const h = (): AstNode => cast(op(">>", u(), intConst(32)), ["hugeint"]);
              const l = (): AstNode => cast(op("&", u(), numConst("4294967295")), ["hugeint"]);
              const term = (a: AstNode, c: AstNode, by: bigint): NumericProgram => ({ op: "mul", args: [cell(as("sum", op("*", a, c))), { op: "literal", text: String(by) }] });
              const whole: NumericProgram = { op: "add", args: [term(h(), h(), 2n ** 64n), { op: "add", args: [term(h(), l(), 2n ** 33n), term(l(), l(), 1n)] }] };
              return s === 0 ? whole : { op: "mul", args: [whole, { op: "literal", text: `0.${"0".repeat(2 * s - 1)}1` }] };
            };
            // the unscaled value: exact, as the copy holds a numeric(p, s) with at most s decimals
            const unscaled = (): AstNode => cast(op("*", this.clone(x), cast(scale <= 9 ? intConst(10 ** scale) : numConst(String(10n ** BigInt(scale))), ["decimal", "38", "0"])), ["bigint"]);
            const sumX2 = argType === NUMERIC ? splitSquares(unscaled, scale) : argType === INT8 ? splitSquares(() => this.clone(x), 0) : squares();
            return numeric({ op: "stddev", args: [cell(as("count")), this.padded(sum, cell(sum)), sumX2],
              sample: !name.endsWith("_pop"), variance: name.startsWith("var") });
          }
          case "sum": {
            // Postgres's sum of a numeric has the most decimals a value SUMMED has (add_var keeps the larger dscale): of
            // a CASE, the arms the rows took, where DuckDB's sum has its CASE type's — the widest arm's, taken or not
            // (Metabase's "sum where", `sum(CASE WHEN … THEN amount ELSE 0.0 END)`, read 5.0 for 5)
            if (args.length !== 1 || b.agg_star === true || b.agg_within_group === true || this.typeOf(args[0]!) !== NUMERIC) return asCell();
            return numeric(this.summed(b, args[0]!, n, cell));
          }
          case "min": case "max": {
            // Postgres's min / max of a numeric is one row's value, with that row's scale (numeric_smaller). Of an
            // expression computed here (a quotient), DuckDB picks the row — by its value as DuckDB has it (a quotient's
            // double orders as Postgres's numerics, __mason_numeric_div), its operands breaking a tie, so every operand
            // is the same row's — and the program computes that row's operands. A NULL operand is kept (_null): a
            // coalesce may read it. Of equal values whose scales differ, Postgres keeps the last it reads (scan order),
            // Mason the one whose operands are least (greatest for max): docs/SQL-SUPPORT.md `min-max-scale-tie`
            // (a window's min / max too, issue 343: each operand picked by arg_min / arg_max over the same window)
            if (b.agg_within_group === true || args.length !== 1 || b.agg_star === true || this.typeOf(args[0]!) !== NUMERIC) return asCell();
            const operands: AstNode[] = [];
            const probe = this.exactOf(args[0]!, (m) => { operands.push(m); return { op: "cell", key: String(operands.length - 1) }; });
            // a column's own min is DuckDB's exact decimal, padded to its scale
            if (probe === null || ((probe.p.op === "cell" || (probe.p.op === "pad" && probe.p.arg.op === "cell")) && this.duckExact(args[0]!)) || (this.duckExact(args[0]!) && !worthComputing(probe.p))) return asCell();
            // picked by its exact value's order key (`exactOrderKey`, issue 252), its operands breaking a tie of scales;
            // an aggregate's argument is read per row, so its key is no group's (null)
            const key = caseWhen([[isNotNull(this.clone(args[0]!)), row([this.exactOrderKey(args[0]!, null) ??this.clone(args[0]!), ...operands.map((m) => this.clone(m))])]], null);
            const picked = (m: AstNode): AstNode => {
              const call = fn(name === "min" ? "arg_min_null" : "arg_max_null", [this.clone(m), this.clone(key)],
                { ...(b.agg_filter === undefined ? {} : { agg_filter: this.clone(b.agg_filter) }), ...(b.over === undefined ? {} : { over: this.clone(b.over) }) });
              // an aggregate, as the grouping checks read it (validGrouped, decidedByKey), typed as the operand it picks
              const t = this.typed(m);
              this.synthetic.set(bodyOf(call), { node: "AGGREF", type: t?.type ?? NUMERIC, typmod: t?.typmod ?? -1, args: [], oid: null, format: null,
                collation: t?.collation ?? 0, inputCollation: 0, levelsUp: null, datum: null, qualifier: null, renamed: null });
              return call;
            };
            const built = this.exactOf(args[0]!, (m, conv) => cell(picked(m), conv));
            return built === null ? asCell() : numeric(built.p);
          }
          // A WINDOW'S PICK OF A ROW (issue 343): the value's program over cells each picked by the same function and
          // window, so every operand is the same row's; lag / lead's default is its own program, picked by whether the
          // row exists (the same lag of 1 with the default 0)
          case "first_value": case "last_value": case "nth_value": case "lag": case "lead": {
            if (b.over === undefined || args.length < 1 || this.typeOf(args[0]!) !== NUMERIC) return asCell();
            const shifted = name === "lag" || name === "lead";
            const rest = args.slice(1, shifted ? 2 : undefined);
            const at = (m: AstNode, extra: AstNode[] = []): AstNode => {
              const call = fn(name, [this.clone(m), ...rest.map((x) => this.clone(x)), ...extra], { over: this.clone(b.over) });
              const t = this.typed(m);
              this.synthetic.set(bodyOf(call), { node: "WINDOWFUNC", type: t?.type ?? NUMERIC, typmod: t?.typmod ?? -1, args: [], oid: null, format: null,
                collation: t?.collation ?? 0, inputCollation: 0, levelsUp: null, datum: null, qualifier: null, renamed: null });
              return call;
            };
            const value = this.exactOf(args[0]!, (m, conv) => cell(at(m), conv));
            if (value === null) return asCell();
            if (!shifted || args.length < 3) return numeric(value.p);
            const fallback = this.exactOf(args[2]!, cell);
            if (fallback === null) return asCell();
            if (rest.length === 0) rest.push(intConst(1));
            return numeric({ op: "pick", index: cell(at(intConst(1), [intConst(0)])), args: [fallback.p, value.p] });
          }
          default: return asCell();
        }
      }
      default: return asCell();
    }
  }

  /**
   * A SCALAR SUBQUERY'S EXACT TEXT (issue 350, the class exact-numeric-leaves-exact-path): the subquery itself, answering
   * its one column's exact text in place of the column. Of a plain query, the column's program built inside it by the
   * one builder (`exactText`: a quotient, an avg, a column carried out of its FROM, a window's pick), read per group
   * where the query is grouped as the walk reads any grouped column; of a UNION ALL, its record (`exactThrough` of a copy, `carriedText`)
   * read over its cells. Null where the column is the engine's exact value (its own cell), or has no program (the
   * engine's value everywhere). A correlated subquery stays correlated: only its SELECT list is written
   */
  private subqueryText(n: AstNode): AstNode | null {
    const b = bodyOf(n);
    if (b.subLinkType !== "EXPR_SUBLINK" || !isNode(b.subselect)) return null;
    const target = scalarTarget(n);
    if (target !== null) {
      if (this.duckExact(target)) return null;
      const text = this.exactText(target);
      if (text === null) return null;
      const sub = this.clone(b);
      const q = bodyOf(sub.subselect as AstNode);
      const first = bodyOf((q.targetList as AstNode[])[0]!);
      // (an ORDER BY, GROUP BY or DISTINCT ON naming the column, by its number or its name, still reads the value, never
      // the text written in its place: `ORDER BY 1 DESC` sorts 120.00 above 80.50)
      const value = first.val as AstNode;
      const names = (x: AstNode): boolean => constInt(x) === 1 || (typeof first.name === "string" && kindOf(x) === "ColumnRef" && (bodyOf(x).fields as AstNode[]).length === 1 && bodyOf((bodyOf(x).fields as AstNode[])[0]!).sval === first.name);
      if (Array.isArray(q.sortClause)) q.sortClause = (q.sortClause as AstNode[]).map((s) => isNode(bodyOf(s).node) && names(bodyOf(s).node as AstNode) ? { SortBy: { ...bodyOf(s), node: this.clone(value) } } : s);
      for (const key of ["groupClause", "distinctClause"] as const) {
        if (Array.isArray(q[key])) q[key] = (q[key] as unknown[]).map((g) => isNode(g) && names(g) ? this.clone(value) : g);
      }
      q.targetList = [{ ResTarget: { ...(first.name === undefined ? {} : { name: first.name }), val: text } }];
      return { SubLink: sub };
    }
    const q = bodyOf(b.subselect);
    if (q.op !== "SETOP_UNION" || q.all !== true) return null;
    const sub = this.clone(b);
    const typed = this.typed(n);
    const e = this.exactThrough(sub.subselect as AstNode, [{ oid: NUMERIC, typmod: typed?.typmod ?? -1 }]).find((x) => x.column === 0 && !x.text);
    if (e === undefined) return null;
    const alias = `${this.cellPrefix}sub${this.named++}`;
    const read: AstNode = { SelectStmt: { targetList: [{ ResTarget: { val: this.carriedText(e, (j) => ({ ColumnRef: { fields: [S(alias), S(`${this.cellPrefix}${j}`)] } })) } }],
      fromClause: [{ RangeSubselect: { subquery: sub.subselect, alias: { aliasname: alias } } }], limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE" } };
    return { SubLink: { ...sub, subselect: read } };
  }

  /** a numeric cell at Postgres's display scale where its types decide one (`displayScale`): DuckDB may hold the value
   *  with fewer decimals (a numeric(65,30) is copied at the decimals its values use, src/duck/sync.ts) */
  private padded(n: AstNode, p: NumericProgram): NumericProgram {
    const scale = this.displayScale(n);
    return scale !== null && scale > 0 ? { op: "pad", arg: p, scale } : p;
  }

  /**
   * A numeric sum (`sum`, DuckDB's sum of `x` with the aggregate `agg`'s DISTINCT, FILTER and window) at Postgres's
   * scale: the types' where they decide it (`padded`); where the rows do (`rowScale`: a CASE's arms, a coalesce), the
   * most decimals a value summed has, DuckDB's max of each row's scale beside its sum, under the same FILTER and
   * window. Not of DISTINCT values: of 5 and 5.0 Postgres keeps one, and which is its sort's
   * (docs/SQL-SUPPORT.md `mixed-scale-numeric`)
   */
  private summed(agg: Body, x: AstNode, sum: AstNode, cell: (n: AstNode, conv?: CellConv) => NumericProgram): NumericProgram {
    if (this.displayScale(x) !== null || agg.agg_distinct === true) return this.padded(sum, cell(sum));
    // a text read as an unconstrained numeric (Metabase's every JSON number), an ln or a sqrt: DuckDB holds it as a
    // double, so it is summed as Postgres computes it (`pgNumeric`), in two exact DECIMAL(38,18) parts (a value they cannot hold refused, `numeric-exact-sum`), at the
    // most decimals a row's text has. A sum holding a NaN or an infinity is the double's (NaN, ±Infinity, as Postgres adds
    // them)
    // (and a value the engine holds as a double whose program the plan has — a quotient, an avg, a subquery's column
    // holding one — summed from its program's exact text: issue 252, the AGGREGATE reader)
    const text = this.pgNumeric(x) ?? (this.typeOf(x) === NUMERIC && !this.duckExact(x) ? this.exactText(x) : null);
    if (text !== null) {
      const read = (): AstNode => this.clone(text);
      const aggregate = (name: string, arg: AstNode, type: number): AstNode => {
        const n: AstNode = { FuncCall: { ...this.clone(agg), funcname: [S(name)], args: [arg] } };
        this.synthetic.set(bodyOf(n), { node: "AGGREF", type, typmod: -1, args: [], oid: null, format: null, collation: 0, inputCollation: 0,
          levelsUp: null, datum: null, qualifier: null, renamed: null });
        return n;
      };
      const part = (i: number): NumericProgram => cell(aggregate("sum", cast(fn("__mason_numeric_exact", [read(), intConst(i)]), ["decimal", "38", "18"]), NUMERIC));
      const exact: NumericProgram = { op: "add", args: [part(0), { op: "mul", args: [part(1), { op: "literal", text: `0.${"0".repeat(17)}1` }] }] };
      const scales = aggregate("max", fn("__mason_numeric_scale", [read()]), INT4);
      const special: AstNode = { CoalesceExpr: { args: [aggregate("max", cast(fn("__mason_numeric_special", [read()]), ["integer"]), INT4), intConst(0)] } };
      return { op: "pick", index: cell(special), args: [{ op: "rescale", arg: exact, scale: cell(scales) }, cell(sum, "float8")] };
    }
    const scale = this.rowScale(x);
    if (scale === null) return this.padded(sum, cell(sum));
    const most: AstNode = { FuncCall: { ...this.clone(agg), funcname: [S("max")], args: [caseWhen([[isNotNull(this.clone(x)), scale]], null)] } };
    // an aggregate, as the grouping checks read it (validGrouped, decidedByKey)
    this.synthetic.set(bodyOf(most), { node: "AGGREF", type: INT4, typmod: -1, args: [], oid: null, format: null, collation: 0, inputCollation: 0,
      levelsUp: null, datum: null, qualifier: null, renamed: null });
    return { op: "rescale", arg: cell(sum), scale: cell(most) };
  }

  /**
   * A numeric DuckDB answers as a double whose every row's value Postgres's own function computes (src/duck/pg-eval.ts),
   * as numeric_out writes it: a text read as an unconstrained numeric (`(j ->> 'k')::numeric`), and ln, log, exp, sqrt
   * and power, whose digits follow a scale from the argument's own (numeric.c's ln_var, power_var) — each argument at
   * the scale Postgres gives it: a numeric(p, s) or an expression its types decide at s (DuckDB may hold fewer decimals:
   * src/duck/sync.ts), an integer whole, a literal as written, a column of no declared scale at the decimals the copy
   * holds (`mixed-scale-numeric`). Null for anything else.
   */
  private pgNumeric(n: AstNode): AstNode | null {
    const b = bodyOf(n);
    if (kindOf(n) === "TypeCast") {
      const target = lastName(b.typeName?.names);
      if ((target !== "numeric" && target !== "decimal") || ((b.typeName?.typmods ?? []) as AstNode[]).length > 0 || !isNode(b.arg)) return null;
      const from = this.typeOf(b.arg);
      return from !== null && TEXTS.has(from) && from !== UNKNOWN && constString(b.arg) === null ? pgCall("text", "a1::numeric", [this.clone(b.arg)]) : null;
    }
    // (`x ^ y` of numerics is Postgres's numeric_power, power(x, y)'s function: issue 242)
    const raised = kindOf(n) === "A_Expr" && b.kind === "AEXPR_OP" && lastName(b.name) === "^" && isNode(b.lexpr) && isNode(b.rexpr);
    const name = kindOf(n) === "FuncCall" ? lastName(b.funcname) : raised ? "power" : "";
    const args = (raised ? [b.lexpr, b.rexpr] : b.args ?? []) as AstNode[];
    if (!["ln", "log", "log10", "exp", "sqrt", "power", "pow"].includes(name) || this.typeOf(n) !== NUMERIC || b.over !== undefined || args.length < 1 || args.length > 2) return null;
    // an argument computed here (a quotient): its exact value, the program DuckDB evaluates row by row
    const read = args.map((a): [string, AstNode] | null => {
      const own = this.typed(a);
      if (own !== null && INTEGERS.has(own.type)) return ["numeric", this.clone(a)];
      // (read as itself only where the engine holds it exactly: `duckExact`; else its program)
      const scale = this.displayScale(a);
      if (scale !== null && this.duckExact(a)) return [`numeric(1000, ${scale})`, this.clone(a)];
      if (kindOf(a) === "ColumnRef" && own?.type === NUMERIC && this.duckExact(a)) return ["numeric", this.clone(a)];
      const exact = this.exactText(a);
      return exact === null ? null : ["numeric", exact];
    });
    if (read.some((x) => x === null)) {
      // (an operator's operand with no program stays the engine's double, as before issue 242: refused only where
      // something needs it exact, the CAST reader's integer)
      if (raised) return null;
      throw new Unrewritable(`${name}() of a numeric Mason cannot compute exactly is not supported by Mason`, `cast the argument to numeric(p, s): ${name}(x::numeric(20, 4))`, "numeric-math");
    }
    return pgCall("text", `${name}(${read.map((x, i) => `a${i + 1}::${x![0]}`).join(", ")})`, read.map((x) => x![1]));
  }

  /**
   * A VALUE POSTGRES TYPES AT A FIXED SCALE (PR 415's review r3, the class refused-by-type-not-by-program; narrowed after
   * review r5): a cast to numeric(p, s) (p within the engine's 38 digits, `numericCastWrite`'s "decimal") or round /
   * trunc(x, n) (a constant n) of a numeric the engine holds as a double whose program the plan has over values the
   * engine holds exactly (`programOf`'s cells: a quotient, an avg; never a JSON number's `->>` cast to numeric, nor a
   * double's text, nor a sum of texts), or of another such value. Its value is computed as main computes it, the
   * engine's double with its program: this decides only that the refusals added for a quotient's double (a JOIN …
   * USING or NATURAL JOIN on it, `refuseMergedExact`; an array_agg of it) do not refuse it, so it is answered where main
   * answered it. (A DECIMAL of its program was tried in rounds 3 and 4: every reader the engine widens two DECIMALs in
   * cut a scale or overflowed, and a round's magnitude has no bound Postgres's analysis gives.)
   */
  private atFixedScale(n: AstNode): boolean {
    const b = bodyOf(n);
    const programmed = (x: unknown): boolean => {
      if (!isNode(x) || this.typeOf(x) !== NUMERIC || this.duckExact(x)) return false;
      const convs: CellConv[] = [];
      const built = this.programOf(x, (_m, conv = "exact") => { convs.push(conv); return { op: "cell", key: String(convs.length - 1) }; });
      return built !== null && convs.every((c) => c === "exact");
    };
    if (kindOf(n) === "TypeCast" && ["numeric", "decimal"].includes(lastName(b.typeName?.names)) && programmed(b.arg)) {
      return numericCastWrite((b.typeName?.typmods ?? []) as AstNode[], this.typeOf(b.arg as AstNode), constString(b.arg)).as === "decimal";
    }
    if (kindOf(n) === "FuncCall" && ["round", "trunc"].includes(lastName(b.funcname)) && b.over === undefined && b.agg_within_group !== true
      && this.typeOf(n) === NUMERIC) {
      const args = (b.args ?? []) as AstNode[];
      const scale = args.length === 1 ? 0 : args.length === 2 ? constInt(args[1]) : null;
      return scale !== null && programmed(args[0]);
    }
    return false;
  }
  /**
   * Whether the engine holds a value at a fixed scale (`atFixedScale`) as a DECIMAL at Postgres's scale, as main writes
   * it: a cast to numeric(p, s) (the engine's DECIMAL(p, s) of the double), a round(x, n) of one (DuckDB's round of a
   * DECIMAL is a DECIMAL at n), or a FROM item's column whose every value is one. An array_agg of it is the engine's list
   * of those DECIMALs, whose text is Postgres's (main's answer); of a round of a double, never (40.0 for 40.00).
   */
  private decimalAtFixedScale(x: AstNode): boolean {
    if (kindOf(x) === "ColumnRef") {
      const found = this.fromColumn(x);
      const values = found === null ? null : this.valuesAt(found.query, found.index);
      return values !== null && values.length > 0 && values.every((v) => this.decimalAtFixedScale(v));
    }
    if (!this.atFixedScale(x)) return false;
    if (kindOf(x) === "TypeCast") return true;
    const b = bodyOf(x), arg = ((b.args ?? []) as AstNode[])[0];
    return lastName(b.funcname) === "round" && arg !== undefined && this.decimalAtFixedScale(arg);
  }
  /** the array_aggs whose elements no reader sees (an `ELEMENT_BLIND` function's argument): their elements' type is
   *  never the answer's, so no element is refused for it (PR 415's review r3) */
  private readonly elementsUnread = new WeakSet<Body>();

  /**
   * A NUMERIC BIN THE ENGINE COMPUTES EXACTLY (issues 464, 465): `floor(e / c)` or `ceil(e / c)` of a constant c, the
   * form every BI tool's auto-bin sends (Metabase's `floor((x - min) / width) * width + min`). Its value is an integer,
   * which DuckDB computes in HUGEINT arithmetic with no Mason function: grouped by the quotient's program's key a row, a
   * binned card was 46–76 s against Postgres's 2.6–6.7 s over 12 M rows. Decided here ONCE; it is written only as a
   * GROUP BY's key (`nativeKey`, `nativeKeys`, the writer in `funcCall`): every other reader of the bin reads its
   * program and the engine's double, as before, and `duckExact` never calls it exact (the review of PR 922).
   *
   * It must be Postgres's integer, which is NOT always the exact quotient's floor: numeric_div rounds the quotient to
   * `select_div_scale`'s rscale first, so a quotient within half a unit of that scale below an integer floors to the
   * integer (`floor(1000000000000000012 / 12.5)` is 80000000000000001). So it is answered here only where no quotient
   * can be that close: e and c read as integers at scale S (the more decimals of the two), a quotient that is not whole
   * is at least 1 / (|c|·10^S) from every integer, so the floor is exact when 2·|c|·10^S < 10^rscale (two units of the
   * last place, a margin past a division off by its last digit; half of one is the bound), rscale at least
   * 16 − 4·(the quotient's largest base-10000 weight), and at least each operand's display scale. Everything is read
   * from types and constants: e is + and − of columns of a bounded type (numeric(p, s), smallint, integer, bigint) and
   * constants, so its magnitude and its display scale are known; e·10^(c's scale) must fit DuckDB's 38 digits, and so
   * must the bin; c is at most 18 places. Anything else (no typmod, a wider column, a computed e) keeps the program's key.
   */
  private nativeBin(n: AstNode): NativeBin | null {
    if (kindOf(n) !== "FuncCall") return null;
    const b = bodyOf(n);
    const name = lastName(b.funcname);
    if (name !== "floor" && name !== "ceil" && name !== "ceiling") return null;
    if (b.over !== undefined || b.agg_star === true || b.agg_distinct === true || b.agg_within_group === true || b.agg_filter !== undefined || b.agg_order !== undefined) return null;
    const args = (b.args ?? []) as AstNode[];
    if (args.length !== 1 || this.typeOf(n) !== NUMERIC) return null;
    const q = args[0]!;
    if (kindOf(q) !== "A_Expr" || bodyOf(q).kind !== "AEXPR_OP" || lastName(bodyOf(q).name) !== "/" || this.typeOf(q) !== NUMERIC) return null;
    const e = bodyOf(q).lexpr, c = bodyOf(q).rexpr;
    if (!isNode(e) || !isNode(c) || kindOf(c) !== "A_Const") return null;
    const cb = bodyOf(c);
    const cText = cb.ival !== undefined ? String(cb.ival.ival ?? 0) : cb.fval !== undefined ? positional(String(cb.fval.fval)) : null;
    const cm = cText === null ? null : /^(-?)(\d+)(?:\.(\d+))?$/.exec(cText);
    if (cm === null || cm === undefined) return null;
    const sc = (cm[3] ?? "").length;
    const cAbs = BigInt(`${cm[2]}${cm[3] ?? ""}`);
    // (a divisor within 18 places: the remainder's `% c + c` stays far inside a HUGEINT, and DuckDB reads it as an
    // integer, never a double)
    if (cAbs === 0n || cAbs >= 10n ** 18n) return null;
    const magnitude = this.binMagnitude(e);
    const se = this.displayScale(e);
    if (magnitude === null || se === null || !this.duckExact(e)) return null;
    // |e| < 10^d: e·10^sc and the bin within DuckDB's 38 digits, e written at its own scale
    const d = Math.max(magnitude, 1);
    if (d + sc + se > 38) return null;
    // the quotient's largest weight in base 10000 (select_div_scale's qweight, at most weight1 − weight2) and the least
    // rscale Postgres can choose for it
    const cDigits = cAbs.toString().length;
    const weight1 = Math.floor((d - 1) / 4), weight2 = Math.floor((cDigits - 1 - sc) / 4);
    const rscale = Math.max(16 - 4 * (weight1 - weight2), se, sc);
    const s = Math.max(se, sc);
    if (2n * cAbs * 10n ** BigInt(s - sc) >= 10n ** BigInt(Math.max(rscale, 0))) return null;
    // the bin: |floor(e / c)| ≤ 10^d / |c| + 1, within 38 places
    if (((10n ** BigInt(d + sc)) / cAbs + 1n).toString().length > 38) return null;
    // (DuckDB multiplies two DECIMALs of at most 18 places in 64 bits, and fails past them: where e·10^sc may pass 17
    // places, e is cast to DECIMAL(38, its scale) first. The bin is a DECIMAL(38, 0), so its `* width` above is made in
    // 128 bits too, whatever the width is written with)
    return { e, up: name !== "floor", shift: (cm[1] === "-" ? -1n : 1n) * 10n ** BigInt(sc), divisor: cAbs, scale: se, wide: d + sc + se > 17 };
  }
  /** the digits d of a bound |e| < 10^d for a native bin's dividend (`nativeBin`): + and − of columns of a bounded type
   *  and constants, or null where none is known (a numeric of no typmod, a computed value, a parameter) */
  private binMagnitude(read: AstNode): number | null {
    // (a column a grouped query reads through the rewrite's any_value or first is that column's value)
    const e = perGroupRead(read);
    const k = kindOf(e), b = bodyOf(e), t = this.typed(e);
    switch (k) {
      case "ColumnRef": {
        if (t === null) return null;
        if (t.type === INT2) return 5;
        if (t.type === INT4) return 10;
        if (t.type === INT8) return 19;
        if (t.type !== NUMERIC || t.typmod < 4) return null;
        const precision = ((t.typmod - 4) >> 16) & 0xffff, scale = (t.typmod - 4) & 0xffff;
        // (a negative scale, numeric(5, -2), reads here as a scale past its precision: not bounded here)
        return precision >= 1 && precision <= 38 && scale <= precision ? Math.max(precision - scale, 0) : null;
      }
      case "A_Const": {
        const text = b.ival !== undefined ? String(b.ival.ival ?? 0) : b.fval !== undefined ? positional(String(b.fval.fval)) : null;
        const m = text === null ? null : /^-?(\d+)(?:\.\d+)?$/.exec(text);
        return m === null || m === undefined ? null : m[1]!.replace(/^0+/, "").length + 1;
      }
      case "A_Expr": {
        if (b.kind !== "AEXPR_OP") return null;
        const name = lastName(b.name);
        if (name !== "+" && name !== "-") return null;
        const r = isNode(b.rexpr) ? this.binMagnitude(b.rexpr) : null;
        if (b.lexpr === undefined) return name === "-" ? r : null;
        const l = isNode(b.lexpr) ? this.binMagnitude(b.lexpr) : null;
        return l === null || r === null ? null : Math.max(l, r) + 1;
      }
      default: return null;
    }
  }
  /** a native bin as DuckDB computes it (`nativeBin`): y = e·(±10^sc), an integer once floored (or ceiled: of an integer
   *  divisor, floor(y / c) = floor(floor(y) / c)), divided in HUGEINT by the divisor, rounding down (or up) where DuckDB's
   *  `//` truncates, as a DECIMAL(38, 0) — the type every reader above it (`* width + min`) reads exactly */
  private nativeBinWritten(bin: NativeBin, first: AstNode): AstNode {
    const big = (v: bigint): AstNode => v >= -2_147_483_647n && v <= 2_147_483_647n ? intConst(Number(v)) : numConst(String(v));
    const whole = (e: AstNode): AstNode => {
      const x = bin.wide ? cast(e, ["decimal", "38", String(bin.scale)]) : e;
      const y = bin.shift === 1n ? x : op("*", x, cast(big(bin.shift), ["decimal", String(String(bin.shift).replace("-", "").length), "0"]));
      return cast(fn(bin.up ? "ceil" : "floor", [y]), ["hugeint"]);
    };
    const c = bin.divisor;
    if (c === 1n) return cast(whole(first), ["decimal", "38", "0"]);
    // floor: (f − ((f % c) + c) % c) // c; ceil: (f + ((−f % c) + c) % c) // c — the remainder DuckDB's `%` truncates
    // toward zero, made the one that leaves an exact multiple of c
    const f = whole(first), g = whole(this.clone(bin.e));
    const rest = op("%", op("+", op("%", bin.up ? op("-", null, g) : g, big(c)), big(c)), big(c));
    return cast(op("//", op(bin.up ? "+" : "-", f, rest), big(c)), ["decimal", "38", "0"]);
  }

  /**
   * WHETHER WHAT IS SENT FOR AN EXPRESSION COMPUTES ITS VALUE EXACTLY — THE ONE DECIDER of a numeric's exactness (PR
   * 207's fourth round, the class a-fact-derived-in-several-places): an integer or a DECIMAL as the walk WRITES it for
   * the engine, never a double. Every place that asks whether a value, a cell or a column is exact asks this: a
   * program's cells (`programOf`), whether a program is the engine's own answer (`exactColumns`, min / max), a FROM
   * item's column (`carry`), an equality key (`exactKey`), a union arm's value, a function's argument (`pgNumeric`).
   * A constant and a cast to numeric are decided by the writer's own decision (`engineReadsExactly`,
   * `numericCastWrite`); an operator, a function or an aggregate by what DuckDB computes from exact operands (+ - * a
   * DECIMAL, a sum / min / max / a window's or arg_min's pick the value's own type, a count an integer); the rewrite's
   * own integer casts (a variance's split squares) are integers. Anything else is not called exact: a quotient, `^`,
   * `%`, an avg (DuckDB's doubles), a parameter (written as a double where it is read; COMPARED with a value this calls
   * exact it is that value's own type or its exact key, `numericParamComparison`), a column a FROM item computes as a double
   * (`carry`), a function this does not know — whose value then has its program, or is the engine's everywhere.
   */
  private duckExact(n: AstNode): boolean {
    const t = this.typed(n), b = bodyOf(n), k = kindOf(n);
    if (t !== null && INTEGERS.has(t.type)) return true;
    if (isCellRef(n, this.cellPrefix)) return true;
    const exact = (x: unknown): boolean => isNode(x) && this.duckExact(x);
    const args = (b.args ?? []) as AstNode[];
    switch (k) {
      // a table's column; a FROM item's, the value it is (`outputExact`), whether or not its program rides
      // (a UNION ALL's column of several scales is its arms' program, `scalesDiffer`: its value is exact, its text is not
      // the engine's one-scale DECIMAL's, issue 227)
      case "ColumnRef": { if (t === null || t.type !== NUMERIC) return false; const found = this.fromColumn(n); return found === null || (this.outputExact(found.query, found.index) && !this.scalesDiffer(found.query, found.index)); }
      // a scalar subquery: its one column
      case "SubLink": { const target = scalarTarget(n); return target !== null && this.duckExact(target); }
      case "A_Const":
        if (b.isnull === true || b.ival !== undefined) return true;
        // a numeric constant as it is written (`numericConstText`, `decimalConst`): DuckDB's DECIMAL within 38 digits
        return b.fval !== undefined && (t === null || t.type === NUMERIC) && engineReadsExactly(numericConstText(String(b.fval.fval)));
      case "TypeCast": {
        const target = lastName(b.typeName?.names);
        // the rewrite's own integer casts (a variance's split squares: `CAST(x >> 32 AS hugeint)`)
        if (DUCK_INTEGER_NAMES.has(target)) return true;
        if ((target !== "numeric" && target !== "decimal") || !isNode(b.arg)) return false;
        const w = numericCastWrite((b.typeName?.typmods ?? []) as AstNode[], this.typeOf(b.arg), constString(b.arg));
        switch (w.as) {
          // DuckDB's DECIMAL(p, s) of a text constant, or of a value it holds exactly (of a double: the double's)
          case "decimal": return constString(b.arg) !== null || this.duckExact(b.arg)
            || (kindOf(b.arg) === "FuncCall" && EXACT_TEXTS.has(lastName(bodyOf(b.arg).funcname)));
          case "whole": return true;
          case "literal": return engineReadsExactly(w.text);
          case "same": return this.duckExact(b.arg);
          case "double": case "as written": return false;
        }
        return false;
      }
      case "A_Expr": {
        const name = lastName(b.name);
        // + - * of DuckDB's DECIMALs is a DECIMAL (a scale past 38 an error, never a double); / % ^ are its doubles
        if (b.kind === "AEXPR_OP" && ["+", "-", "*"].includes(name)) return (b.lexpr === undefined || exact(b.lexpr)) && exact(b.rexpr);
        if (b.kind === "AEXPR_NULLIF") return exact(b.lexpr);
        return false;
      }
      case "FuncCall": {
        const name = lastName(b.funcname);
        // a count (an avg's, made from the avg's node, carries the avg's type), and what the walk writes as a DECIMAL
        if (WRITTEN_EXACT.has(name)) return true;
        // the engine's sign is a TINYINT (-1, 0, 1), whatever its argument: Postgres's numeric_sign is the same value
        // (issue 242: `sign(x)::int` stays the engine's, and `exp(…) * sign(x)` has a program)
        if (name === "sign" && b.over === undefined && args.length === 1) return true;
        // percentile_disc and mode() pick one row's value of their ORDER BY, in its own type (review r1 of PR 506)
        if ((name === "percentile_disc" || name === "mode") && b.agg_within_group === true && t !== null && t.type === NUMERIC) {
          const by = ((b.agg_order ?? []) as AstNode[])[0];
          return by !== undefined && exact(bodyOf(by).node);
        }
        // a value picked or summed, in its own type: an aggregate, a window's row, min / max's picked operand
        if (VALUE_KEEPING.has(name) && args.length >= 1) return exact(args[0]) && ((name !== "lag" && name !== "lead") || args.length < 3 || exact(args[2]));
        return false;
      }
      // DuckDB's CASE, COALESCE, GREATEST and LEAST of DECIMALs are a DECIMAL
      case "CaseExpr": return [...args.map((w) => bodyOf(w).result), ...(b.defresult === undefined ? [] : [b.defresult])].every(exact);
      case "CoalesceExpr": case "MinMaxExpr": return args.every(exact);
      default: return false;
    }
  }

  /**
   * A GROUP BY's expression that is a ONE-TO-ONE function of a numeric bin (`nativeBin`): that bin, written as the
   * engine's own integer (`nativeKeys`), is the key the engine groups by in place of the program's key (issues 464, 465:
   * `__mason_numeric_program_key` a row was ×16–25 of Postgres). Rows equal in the bin are equal in the value and the
   * other way round, so the groups are Postgres's; everything that reads the value is computed per group from its
   * program, as for any keyed group (`cells`). The bin is the KEY ONLY: written where the engine reads it as a value,
   * its DECIMAL(38, 0) beside another DECIMAL in a UNION, an IN, a CASE or a comparison was cast to a type that rounds
   * the other's decimals, and a product of it passed 38 places where Postgres answers (the review of PR 922), so every
   * other place the expression is read is its program and the engine's double, as before. One-to-one: the bin itself,
   * a negation, + or − of a constant, × by a constant that is not zero (Metabase's `bin * width + min`). null for
   * anything else, or an expression with no program, which keeps the program's key
   */
  private nativeKey(e: AstNode): AstNode | null {
    if (this.typeOf(e) !== NUMERIC || this.exactText(e) === null) return null;
    const constant = (x: unknown): string | null => {
      if (!isNode(x)) return null;
      const k = kindOf(x), b = bodyOf(x);
      if (k === "A_Const") return b.ival !== undefined ? String(b.ival.ival ?? 0) : b.fval !== undefined ? positional(String(b.fval.fval)) : null;
      if (k === "A_Expr" && b.kind === "AEXPR_OP" && b.lexpr === undefined && lastName(b.name) === "-") return constant(b.rexpr);
      return null;
    };
    const bin = (x: AstNode): AstNode | null => {
      if (this.nativeBin(x) !== null) return x;
      const k = kindOf(x), b = bodyOf(x);
      if (k !== "A_Expr" || b.kind !== "AEXPR_OP" || !isNode(b.rexpr)) return null;
      const name = lastName(b.name);
      if (b.lexpr === undefined) return name === "-" ? bin(b.rexpr) : null;
      if (!isNode(b.lexpr) || !["+", "-", "*"].includes(name)) return null;
      const [inner, by] = constant(b.rexpr) !== null ? [b.lexpr, constant(b.rexpr)!] : constant(b.lexpr) !== null ? [b.rexpr, constant(b.lexpr)!] : [null, null];
      if (inner === null || by === null || (name === "*" && /^-?0*(\.0*)?$/.test(by))) return null;
      return bin(inner as AstNode);
    };
    const found = bin(e);
    if (found === null) return null;
    const key = this.clone(found);
    this.nativeKeys.add(bodyOf(key));
    return key;
  }
  /** the bins a GROUP BY groups by as the engine's integer (`nativeKey`), and their copies: the writer writes these alone */
  private readonly nativeKeys = new WeakSet<Body>();

  /** AN EXPRESSION AS A PROGRAM OVER CELLS (`exactOf`), every cell it reads as exact one the engine holds exactly
   *  (`duckExact`, the one decider), or null: a program over a double's digits computes nothing Postgres's. Every
   *  program is built here — a column's (`exactColumns`), a value's text or key (`exactText`) — so no two disagree */
  private programOf(n: AstNode, cell: (n: AstNode, conv?: CellConv) => NumericProgram): Built | null {
    const checked = (m: AstNode, conv: CellConv = "exact"): NumericProgram => {
      if (conv === "exact" && !this.duckExact(m)) throw NOT_EXACT;
      return cell(m, conv);
    };
    try { return this.exactOf(n, checked); } catch (e) { if (e === NOT_EXACT) return null; throw e; }
  }

  /** a numeric's exact text, row by row: its program (exactOf) evaluated by DuckDB over its cells' texts
   *  (`__mason_numeric_program`, src/duck/functions.ts); null where there is none, or it reads a parameter */
  private exactText(n: AstNode): AstNode | null {
    const cells: Array<{ node: AstNode; conv: CellConv }> = [];
    const built = this.programOf(n, (m, conv = "exact") => { cells.push({ node: m, conv }); return { op: "cell", key: String(cells.length - 1) }; });
    if (built === null) return null;
    return this.programText(built.p, cells.map((c) => ({ node: this.clone(c.node), conv: c.conv })));
  }

  /**
   * A PROGRAM'S TEXT FROM ITS CELLS, row by row: THE ONE BUILDER of `__mason_numeric_program`, for a value's program
   * (`exactText`) and for a query's record read where its cells already ride (a set operation's sort, `carriedText`;
   * a DISTINCT over a pass-through). Each cell is read as it rode (an exact value as its varchar, a text as it is, a
   * float by its nearest numeric). A parameter is the text it was bound as, Postgres's numeric_out of what it read
   * (src/duck/analyze.ts readParameters): DuckDB reads it as its varchar, never the double the rewrite makes of it
   */
  private programText(p: NumericProgram, given: ReadonlyArray<{ node: AstNode; conv: CellConv }>): AstNode {
    const cells = [...given];
    // (a parameter's cell made once a node, as before; every other cell itself, so a program reading none is as given)
    const program = cellsOf(p).some((key) => key.startsWith("$")) ? mapCells(p, (key) => {
      if (!key.startsWith("$")) return { op: "cell", key };
      cells.push({ node: cast({ ParamRef: { number: Number(key.slice(1)) } }, ["varchar"]), conv: "text" });
      return { op: "cell", key: String(cells.length - 1) };
    }) : p;
    const texts = cells.map((c) => c.conv === "text" || c.conv === "parsed" ? c.node : c.conv === "exact" ? cast(c.node, ["varchar"])
      : fn("__mason_float_numeric_text", [cast(c.node, ["double"]), boolConst(c.conv === "float4")]));
    // the program's one text (src/lib/pg-numeric.ts `programJson`): each distinct node once, however many read it
    return fn("__mason_numeric_program", [strConst(programJson(program)), ...texts]);
  }

  /** a query's exact column as its text, read from the cells its rows carry (`cellRef` names each): its record's program
   *  (`derived`), by the one builder */
  private carriedText(e: ExactColumn, cellRef: (j: number) => AstNode): AstNode {
    return this.programText(e.program, e.cells.map((conv, j) => ({ node: cellRef(j), conv })));
  }

  /**
   * A SET OPERATION'S COLUMN AS ITS EXACT ORDER KEY (issue 352, the ORDER reader of a set operation): the record's
   * program (`derived`: `exactArms`' `pick`, or the program every arm shares) over the cells its rows carry, by the one
   * builder, as `__mason_numeric_order` — never the engine's unified double. Null where the set operation keeps no
   * program for the column, or where every value an arm can give it is the engine's exact one (`outputExact`: a column
   * computed only for its arms' scales sorts natively, equal values tied as Postgres ties them). A numeric's TEXT the
   * record computes (`(x / 3)::text` beside an arm's own text) is its program's text, typed as the column Postgres
   * resolved, so the sort's rule builds its collation's keys over it (`keyed` false)
   */
  private recordOrderKey(b: Body, at: number, cellRef: (j: number) => AstNode): { node: AstNode; keyed: boolean } | null {
    const e = (this.derived.get(b) ?? []).find((x) => x.column === at);
    if (e === undefined || (!e.text && this.outputExact({ SelectStmt: b }, at))) return null;
    if (!e.text) return { node: fn("__mason_numeric_order", [this.carriedText(e, cellRef)]), keyed: true };
    const own = this.setOperationColumns(b, false)?.[at] ?? null;
    if (own === null) return null;
    const text = this.carriedText(e, cellRef);
    this.synthetic.set(bodyOf(text), own);
    return { node: text, keyed: false };
  }

  /** a set operation's ORDER BY: each key that is an exact column of its record sorted by its exact order key
   *  (`recordOrderKey`), the key read over the set operation's own output cells, by name (the engine sorts a set
   *  operation by an expression of its outputs); the rest left to `setOperationOrdinals` */
  private setOperationExactKeys(b: Body): void {
    if ((this.derived.get(b) ?? []).length === 0) return;
    let arm: Body = b;
    while (isSetOp(arm) && arm.larg !== undefined) arm = unwrappedArm(arm.larg);
    const outputs = this.outputs(((arm.targetList ?? []) as AstNode[]).filter((t) => !isCellTarget(t, this.cellPrefix)));
    for (const s of b.sortClause as AstNode[]) {
      const sb = bodyOf(s);
      if (kindOf(s) !== "SortBy" || !isNode(sb.node)) continue;
      const out = outputs[this.outputIndex(sb.node as AstNode, outputs)];
      const key = out === undefined ? null : this.recordOrderKey(b, out.at, (j) => ({ ColumnRef: { fields: [S(`${this.cellPrefix}${j}`)] } }));
      if (key === null) continue;
      sb.node = key.node;
      // (a numeric's key sorts as its bytes; a text's is keyed by the sort's own rule, as its column is)
      if (key.keyed) this.done.add(sb);
    }
  }

  /**
   * A NUMERIC THE PLAN DECIDES EXACTLY, AS ITS EQUALITY KEY (the class approximate-compared-as-exact, PR 207): a
   * numeric DuckDB holds as a double (a quotient, an avg) whose exact program the plan has is compared by that
   * program's value, trailing zeros dropped (`__mason_numeric_key`), never by its double, which equates two values
   * Postgres tells apart past the double's 17 digits. Every context that equates — DISTINCT, DISTINCT ON, GROUP BY,
   * PARTITION BY, count(DISTINCT), =, <> — reads this one; where none can be placed the form is refused by name
   * (`numeric-quotient-equality`). null: no such value (one DuckDB holds exactly, or one with no program, which is the
   * engine's value everywhere).
   */
  private exactKey(e: AstNode, oneCall = false): AstNode | null {
    const type = this.typeOf(e);
    // a numeric's text: the program's text, which text's equality compares as it is
    if (type !== null && TEXTS.has(type)) return this.exactNumericText(e);
    if (type !== NUMERIC || this.duckExact(e)) return null;
    // (a scalar subquery, cast or not, is its program's one text cell: `exactOf`, issue 350)
    const exact = this.exactText(e);
    if (exact === null) return this.refuseUncarried(e);
    // `oneCall` (a GROUP BY's key, computed for every row: issue 665): the program and its key in one call, the same
    // program text and cells (`programText`, the one builder), the key of what `__mason_numeric_program` answers (its
    // arguments after the session, which `fn` writes again)
    if (oneCall && kindOf(exact) === "FuncCall" && lastName(bodyOf(exact).funcname) === "__mason_numeric_program") return fn("__mason_numeric_program_key", (bodyOf(exact).args as AstNode[]).slice(1));
    return fn("__mason_numeric_key", [exact]);
  }

  /**
   * A NUMERIC THE PLAN DECIDES EXACTLY, AS ITS ORDER KEY (issue 252, the ORDER reader of the class
   * exact-numeric-leaves-exact-path): a numeric the engine holds as a double (`duckExact`, the one decider) whose program
   * the plan has (`exactText`, the one builder) is sorted, ranked, tied (FETCH … WITH TIES) and picked by min / max by
   * bytes that order as numeric_cmp does (`__mason_numeric_order`, src/lib/pg-numeric.ts `numericOrderKey`), never by
   * its double, which ties two values Postgres orders apart past 17 digits and orders 0.1 + 0.2 after 0.3. null: a
   * value the engine holds exactly (a DECIMAL column, an integer: its native sort, no function), or one with no program
   * (the engine's value everywhere). `grouped` is the query the key is computed in, never defaulted (the class
   * exact-key-built-outside-its-group, PR 341 r1): in a grouped one the text is read per group (`overGroups`), so every
   * rule that keys a value (ORDER BY, a window's ORDER BY, FETCH … WITH TIES) names it, and an aggregate's argument
   * (min / max) says null.
   */
  private exactOrderKey(e: AstNode, grouped: Body | null): AstNode | null {
    if (this.typeOf(e) !== NUMERIC || this.duckExact(e)) return null;
    const exact = this.exactText(e);
    // (in a grouped SELECT, the text is read once per group, whose rows hold one value, and keyed once per group)
    return exact === null ? null : fn("__mason_numeric_order", [this.overGroups(exact, grouped)]);
  }

  /** whether the walk has begun: what the passes before it decided (a carry's cells) is all a query selects */
  walking = false;

  /** each window ORDER BY key of a grouped SELECT, by the SELECT (`select`): its exact order key is read per group */
  private readonly groupedWindowKeys = new WeakMap<Body, Body>();
  /** each cast in a grouped SELECT, by the SELECT: a program's text the CAST reader builds there is read per group
   *  (`overGroups`), never over cells the group does not decide (review r1 of PR 506: the engine's 42803) */
  private readonly groupedCasts = new WeakMap<Body, Body>();
  /** each column of an expression the engine groups by its key alone (`cells`, issue 665) where a SELECT's list, HAVING
   *  or ORDER BY reads it (decidedByKey): read through first() when the walk reaches it, so that the expression is
   *  computed once per group, never once per row. Marked, never wrapped there: every rule above the column (a
   *  division's, a cast's, a program built over it) reads the expression as written, typed by Postgres's analysis of
   *  its shape, which an any_value inside it would change. A copy of one is marked too (`clone`) */
  private readonly readPerGroup = new WeakSet<Body>();
  /** THE ENGINE'S GROUP BY ENTRY OF AN EXPRESSION GROUPED BY A KEY IN ITS PLACE (`keyed`, `cells`; `keyedGroups`), by the
   *  SELECT and the expression's shape, as placed (before the walk): what the engine groups the expression AS, the one
   *  answer GROUPING(e) reads (`groupingArguments`; review r1 of PR 674) */
  private readonly groupKeys = new WeakMap<Body, Map<string, AstNode>>();

  /** whether a value is a NUMERIC's text (`x::text`, `(x / 3)::text`, under a COLLATE, a subquery's column carrying
   *  one) or a NULL: what a "text" cell may hold, its program parsing it as a numeric */
  private numericTextValue(v: AstNode): boolean {
    const bare = kindOf(v) === "CollateClause" && isNode(bodyOf(v).arg) ? bodyOf(v).arg as AstNode : v;
    if (isNullValue(bare)) return true;
    const type = this.typeOf(bare);
    if (type === null || !TEXTS.has(type)) return false;
    if (kindOf(bare) === "TypeCast" && isNode(bodyOf(bare).arg)) return this.typeOf(bodyOf(bare).arg as AstNode) === NUMERIC;
    return kindOf(bare) === "ColumnRef" && (this.carry(bare) as { text?: boolean } | null)?.text === true;
  }

  /** a numeric's text decided exactly (`(x / 3)::text`, a subquery's column holding one) as the program's text, or null */
  private exactNumericText(e: AstNode): AstNode | null {
    const b = bodyOf(e);
    if (kindOf(e) === "TypeCast" && isNode(b.arg) && this.typeOf(b.arg) === NUMERIC && ((b.typeName?.typmods ?? []) as unknown[]).length === 0 && !this.duckExact(b.arg)) {
      return this.exactText(b.arg) ?? this.refuseUncarried(b.arg);
    }
    if (kindOf(e) !== "ColumnRef") return null;
    const c = this.carry(e);
    if (c === "uncarried") return this.refuseUncarried(e);
    return c === null || !c.text ? null : this.exactText(e);
  }

  /**
   * TWO NUMERICS COMPARED FOR EQUALITY, each by its exact key (`exactKey`; a value the engine holds exactly by its own
   * text's key), or null where neither is decided exactly: the one comparison of a quotient, `=` and `<>`'s and
   * NULLIF's (issue 242). A parameter alone is keyed only beside a value decided exactly (its bound text); beside a
   * value the ENGINE holds exactly it is never its double: `numericParamComparison`, asked first (issue 214)
   */
  private exactEquality(l: AstNode, r: AstNode): [AstNode, AstNode] | null {
    const kl = this.exactKey(l), kr = this.exactKey(r);
    const side = (x: AstNode, k: AstNode | null): AstNode | null => k ?? (this.duckExact(x) ? fn("__mason_numeric_key", [cast(x, ["varchar"])]) : null);
    const decided = (x: AstNode, k: AstNode | null): boolean => k !== null && kindOf(stripCasts(x)) !== "ParamRef";
    const sl = !decided(l, kl) && !decided(r, kr) ? null : side(l, kl), sr = sl === null ? null : side(r, kr);
    return sl !== null && sr !== null ? [sl, sr] : null;
  }

  /** a parameter of type numeric as it was bound, cast to nothing but numeric without a typmod (`$1`, `$1::numeric`):
   *  its number, whose bound text is the value (Postgres's numeric_out, src/duck/analyze.ts readParameters); else null */
  private plainNumericParam(x: AstNode): number | null {
    let n = x;
    while (kindOf(n) === "TypeCast" && isNode(bodyOf(n).arg)) {
      const t = bodyOf(n).typeName;
      if (!["numeric", "decimal"].includes(lastName(t?.names)) || ((t?.typmods ?? []) as unknown[]).length > 0 || Array.isArray(t?.arrayBounds)) return null;
      n = bodyOf(n).arg as AstNode;
    }
    if (kindOf(n) !== "ParamRef") return null;
    const number = Number(bodyOf(n).number);
    return this.params[number - 1] === NUMERIC ? number : null;
  }

  /**
   * A NUMERIC PARAMETER COMPARED WITH VALUES THE ENGINE HOLDS EXACTLY (issue 214, the class numeric-parameter-as-double):
   * `x = $1`, `<>`, `<`, `<=`, `>`, `>=`, IS [NOT] DISTINCT FROM, NULLIF, IN a list and [NOT] BETWEEN, every
   * other operand one `duckExact` calls exact (a DECIMAL column, an integer, + - * and sum / min / max of them) — never
   * the parameter's double, which equates and orders values Postgres tells apart past 15 digits.
   *
   * NATIVE where the engine's own type of the compared value holds the bound value exactly: `CASE WHEN
   * __mason_numeric_fits(typeof(x), $1::text) THEN x = $1 ELSE <keyed> END`. DuckDB casts the parameter into x's type
   * (its prepared statement types the parameter by the comparison), which rounds a value past its scale and fails past
   * its digits: so the guard decides, from DuckDB's own name of the type (`typeof`, never Postgres's typmod: a numeric(65,
   * 30) is held as DECIMAL(38, the scale its values use), nor a type this module derives for an expression) and the bound
   * text alone (src/lib/pg-numeric.ts `fitsEngineType`, the copy's own rule of what a DECIMAL holds). Both are constants,
   * so DuckDB folds the guard at Execute: one call, and the comparison it keeps is the scan's own filter. A NULL fits.
   *
   * KEYED otherwise (a value past the scale or the digits, NaN, ±Infinity; a parameter under a cast with a typmod, which
   * Postgres rounds first; more than one exact operand): each operand by its exact key, `__mason_numeric_key` for an
   * equality, `__mason_numeric_order` for an order (numeric_cmp's: NaN above every number, ±Infinity outside them),
   * the parameter by its bound text or its program's (`exactText`), a value the engine holds exactly by its own text.
   * null: no numeric parameter here, or an operand with no exact value (a quotient: `exactEquality`; a value past 38
   * digits: `numeric-over-38-digits`), left as it was.
   */
  private numericParamComparison(b: Body, operatorResolved = false): AstNode | null {
    const kind = String(b.kind), name = lastName(b.name);
    const equating = (kind === "AEXPR_OP" && ["=", "<>", "!="].includes(name)) || ["AEXPR_DISTINCT", "AEXPR_NOT_DISTINCT", "AEXPR_NULLIF", "AEXPR_IN"].includes(kind);
    const ordering = (kind === "AEXPR_OP" && ["<", "<=", ">", ">="].includes(name)) || ["AEXPR_BETWEEN", "AEXPR_NOT_BETWEEN"].includes(kind);
    const l = b.lexpr, r = b.rexpr;
    if ((!equating && !ordering) || !isNode(l) || !isNode(r)) return null;
    const listed = kind === "AEXPR_IN" || kind.includes("BETWEEN");
    if (listed && kindOf(r) !== "List") return null;
    const operands = [l, ...(listed ? (bodyOf(r).items ?? []) as AstNode[] : [r])];
    // compared as numerics, by Postgres's own operator where it names one
    if (!operands.every((x) => { const t = this.typeOf(x); return t === NUMERIC || (t !== null && INTEGERS.has(t)); })) return null;
    if (kind === "AEXPR_OP" && !operatorResolved) { const t = this.typed({ A_Expr: b }); if (t?.args[0]?.type !== NUMERIC || t?.args[1]?.type !== NUMERIC) return null; }
    const plain = operands.map((x) => this.plainNumericParam(x));
    // a parameter under a cast with a typmod (`$1::numeric(30,20)`): its program's value, Postgres's rounding first
    const ofParam = operands.map((x, i) => plain[i] !== null || (!this.duckExact(x) && kindOf(stripCasts(x)) === "ParamRef"
      && this.params[Number(bodyOf(stripCasts(x)).number) - 1] === NUMERIC && this.exactText(x) !== null));
    if (!ofParam.some(Boolean) || operands.some((x, i) => !ofParam[i] && !this.duckExact(x))) return null;
    // NULLIF answers its first operand: a parameter there is printed, not compared (left as it was)
    if (kind === "AEXPR_NULLIF" && ofParam[0]) return null;
    const exactAt = operands.flatMap((_, i) => ofParam[i] ? [] : [i]);
    // the native form: ONE value the engine holds exactly (first, or either side of an operator), every other operand a
    // plain parameter, so each parameter is cast into that value's own type
    const at = exactAt.length === 1 && exactAt[0] !== undefined && (exactAt[0] === 0 || kind === "AEXPR_OP") && plain.every((p, i) => i === exactAt[0] || p !== null) ? exactAt[0] : null;
    const param = (n: number): AstNode => ({ ParamRef: { number: n } });
    const f = equating ? "__mason_numeric_key" : "__mason_numeric_order";
    const keys = operands.map((x, i) => fn(f, [plain[i] !== null ? cast(param(plain[i]!), ["varchar"]) : ofParam[i] ? this.exactText(x)! : cast(at === null ? x : this.clone(x), ["varchar"])]));
    const rebuilt = (ops: AstNode[]): Body => ({ ...b, lexpr: ops[0]!, rexpr: listed ? { List: { items: ops.slice(1) } } : ops[1]! });
    const keyed: AstNode = kind === "AEXPR_NULLIF" ? caseWhen([[op("=", keys[0]!, keys[1]!), nullConst()]], this.clone(l)) : { A_Expr: { ...rebuilt(keys), name: this.clone(b.name) } };
    if (at === null) return keyed;
    const exact = operands[at]!;
    const guards = plain.flatMap((p, i) => i === at || p === null ? [] : [fn("__mason_numeric_fits", [fn("typeof", [this.clone(exact)]), cast(param(p), ["varchar"])])]);
    // (the comparison as written, its parameters bare: this node, its exact operand walked as everywhere)
    Object.assign(b, rebuilt(operands.map((x, i) => i === at ? x : param(plain[i]!))));
    return caseWhen([[guards.length === 1 ? guards[0]! : and(guards), { A_Expr: b }]], keyed);
  }

  /** CASE x WHEN $1 …, x a value the engine holds exactly and a WHEN a numeric parameter (issue 214): each WHEN written
   *  as the comparison it is, x = v, the parameter's by `numericParamComparison` (Postgres resolved each WHEN's `=` as
   *  numeric's: every operand is a numeric or an integer, one a numeric parameter); x read once a WHEN, as CASE reads it */
  private caseOfNumericParam(b: Body): void {
    const arg = b.arg, whens = (b.args ?? []) as AstNode[];
    if (!isNode(arg) || !this.duckExact(arg) || !whens.some((w) => isNode(bodyOf(w).expr) && kindOf(stripCasts(bodyOf(w).expr as AstNode)) === "ParamRef")) return;
    let changed = false;
    const compared = whens.map((w, i) => {
      const x = i === 0 ? arg : this.clone(arg), v = bodyOf(w).expr as AstNode;
      const viaParameter = this.numericParamComparison({ kind: "AEXPR_OP", name: [S("=")], lexpr: x, rexpr: v }, true);
      if (viaParameter !== null) changed = true;
      return viaParameter ?? op("=", x, v);
    });
    // (nothing changed where no WHEN is such a parameter: the clones are dropped unplaced)
    if (!changed) return;
    whens.forEach((w, i) => { bodyOf(w).expr = compared[i]!; });
    delete b.arg;
  }

  /** null where a value is no numeric decided exactly; a refusal where it is one whose program cannot be read here (a
   *  subquery's quotient whose cells cannot ride: `carry`): never its double, compared */
  private refuseUncarried(e: AstNode): null {
    if (kindOf(e) !== "ColumnRef" || this.carry(e) !== "uncarried") return null;
    const found = this.fromColumn(e);
    const w = found === null ? undefined : this.whyUncarried.get(bodyOf(found.query));
    const what = w?.what ?? "a numeric the engine holds as a double", where = w?.where ?? "a subquery", why = w?.why ?? "Mason cannot carry its exact digits out of it";
    // (each way out is one a test follows to Postgres's answer, tests/duck-wire.test.ts "sixth round": a round(x, n)
    // inside the query is still its double, and a USING join reads it as the double — neither is offered)
    const hint = why.includes("*") ? "name the columns in place of the *: SELECT s.q, … FROM (…) s"
      : why.includes("NATURAL") ? "join it with ON, naming its columns: … JOIN t ON t.id = s.id"
      : why.includes("whole row") ? "read its columns, not its whole row: s.q, never s"
      : why.includes("recursive") ? "compute the value outside the recursive WITH query, from the columns it carries"
      : where === "a VALUES list" && what === "a numeric of more than 38 digits" ? "write each value in the VALUES list in 38 digits or fewer (the 0 of 0.5 counts)"
      : "compute the value in the query that compares it, from the columns it is made of";
    throw new Unrewritable(`${what} from ${where}, compared outside it, is not supported by Mason where ${why} (Postgres compares the exact value; the engine holds it as a double)`, hint, "numeric-quotient-equality");
  }

  /** a FROM item's column that cannot be carried, its reason kept for the refusal's words (`refuseUncarried`) */
  private uncarried(found: NonNullable<ReturnType<Rewriter["fromItemOf"]>>, why: string): "uncarried" {
    const b = bodyOf(found.query);
    const where = Array.isArray(b.valuesLists) ? "a VALUES list" : kindOf(found.item) === "RangeVar" ? "a WITH query" : "a subquery";
    this.whyUncarried.set(b, { what: this.approximateWhat(this.valuesAt(found.query, found.index) ?? []), where, why });
    return "uncarried";
  }

  /** why a FROM item's query computes no program for its columns, in the developer's words */
  private unwritable(query: AstNode): string {
    const b = bodyOf(query);
    if (Array.isArray(b.valuesLists)) return "Mason cannot carry its exact digits out of a VALUES list";
    if (((b.targetList ?? []) as AstNode[]).some((t) => hasStar(bodyOf(t).val))) return "it lists * beside other columns";
    return "Mason cannot carry its exact digits out of it";
  }

  /** what a value the engine holds as a double is, as the developer wrote it: the first of a quotient, an average, a
   *  variance, a numeric past 38 digits, a float read as numeric, in what it computes */
  private approximateWhat(values: readonly AstNode[]): string {
    const kinds: string[] = [];
    const look = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) look(x); return; }
      if (!isNode(v)) return;
      const k = kindOf(v), b = bodyOf(v);
      if (k === "A_Expr" && ["/", "%", "^"].includes(lastName(b.name))) kinds.push("a numeric quotient");
      if (k === "FuncCall" && lastName(b.funcname) === "avg") kinds.push("an average");
      if (k === "FuncCall" && /^(stddev|var)/.test(lastName(b.funcname))) kinds.push("a standard deviation or variance");
      // (a constant, or a cast to numeric, the writer writes as a double: `engineReadsExactly`, `numericCastWrite`)
      const written = k === "TypeCast" && ["numeric", "decimal"].includes(lastName(b.typeName?.names)) && isNode(b.arg)
        ? numericCastWrite((b.typeName?.typmods ?? []) as AstNode[], this.typeOf(b.arg as AstNode), constString(b.arg)) : null;
      if ((k === "A_Const" && b.fval !== undefined && !engineReadsExactly(numericConstText(String(b.fval.fval))))
        || (written !== null && ((written.as === "double" && ((b.typeName?.typmods ?? []) as unknown[]).length > 0) ||(written.as === "literal" && !engineReadsExactly(written.text))))) kinds.push("a numeric of more than 38 digits");
      if (k === "TypeCast" && isNode(b.arg) && FLOATS.has(this.typeOf(b.arg as AstNode) ?? -1)) kinds.push("a float read as numeric");
      for (const x of Object.values(b)) look(x);
    };
    look(values);
    const order = ["a numeric quotient", "an average", "a standard deviation or variance", "a numeric of more than 38 digits", "a float read as numeric"];
    return order.find((o) => kinds.includes(o)) ?? "a numeric the engine holds as a double";
  }

  /** the refusal of a form that equates a numeric decided exactly where no exact key can be placed */
  private refuseExactEquality(e: AstNode, where: string): void {
    if (this.exactKey(e) === null) return;
    // (each way out is one a test follows to Postgres's answer, tests/duck-wire.test.ts "sixth round"; a round(x, n) is
    // computed as exactly as the quotient, and refused alike, so none offers it)
    const hint = where.startsWith("UNION") ? "SELECT DISTINCT over the UNION ALL of the same queries: SELECT DISTINCT u.q FROM (SELECT … UNION ALL SELECT …) u"
      : / ALL of$/.test(where) ? "count each value in each query (GROUP BY it) and join the counts on it: … FROM (SELECT q, count(*) AS n … GROUP BY q) a JOIN (…) b ON b.q = a.q"
      : where.startsWith("INTERSECT") ? "keep the rows the other query has, by EXISTS: SELECT DISTINCT a.q FROM … a WHERE EXISTS (SELECT 1 FROM … b WHERE b.q = a.q)"
      : where.startsWith("EXCEPT") ? "keep the rows the other query has not, by NOT EXISTS: SELECT DISTINCT a.q FROM … a WHERE NOT EXISTS (SELECT 1 FROM … b WHERE b.q = a.q)"
      : where.startsWith("GROUP BY") ? "a GROUP BY for each grouping set, joined by UNION ALL: SELECT q, count(*) … GROUP BY q UNION ALL SELECT NULL, count(*) …"
      : "count(DISTINCT …) of it is answered; Mason has no exact form of this aggregate's DISTINCT of it";
    throw new Unrewritable(`${where} a numeric quotient or average is not supported by Mason (Postgres compares the exact values, which the engine holds as doubles)`, hint, "numeric-quotient-equality");
  }

  /**
   * The decimals Postgres writes for one ROW's value of a numeric expression, as DuckDB computes them (an integer), where
   * the arm a row took decides them: a CASE's arms, a coalesce's first value that is not NULL, + - * over those
   * (numeric.c's add_var, mul_var). Null where a value's own digits decide (an unconstrained column, a division).
   */
  private rowScale(n: AstNode): AstNode | null {
    const fixed = this.displayScale(n);
    if (fixed !== null) return intConst(fixed);
    const k = kindOf(n), b = bodyOf(n);
    const of = (x: unknown): AstNode | null => isNode(x) ? this.rowScale(x) : null;
    switch (k) {
      case "CaseExpr": {
        const whens = (b.args ?? []) as AstNode[];
        const results = whens.map((w) => of(bodyOf(w).result));
        const otherwise = b.defresult === undefined ? nullConst() : of(b.defresult);
        if (results.some((r) => r === null) || otherwise === null) return null;
        return { CaseExpr: { ...(b.arg === undefined ? {} : { arg: this.clone(b.arg) }),
          args: whens.map((w, i) => ({ CaseWhen: { expr: this.clone(bodyOf(w).expr), result: results[i]! } })), defresult: otherwise } };
      }
      case "CoalesceExpr": {
        const args = (b.args ?? []) as AstNode[];
        const scales = args.map(of);
        if (scales.some((r) => r === null)) return null;
        return caseWhen(args.map((a, i) => [isNotNull(this.clone(a)), scales[i]!]), null);
      }
      case "A_Expr": {
        if (b.kind !== "AEXPR_OP") return null;
        const name = lastName(b.name);
        const r = of(b.rexpr);
        if (b.lexpr === undefined) return name === "-" || name === "+" ? r : null;
        const l = of(b.lexpr);
        if (l === null || r === null) return null;
        return name === "+" || name === "-" ? fn("greatest", [l, r]) : name === "*" ? op("+", l, r) : null;
      }
      case "TypeCast": {
        const target = lastName(b.typeName?.names);
        return (target === "numeric" || target === "decimal") && ((b.typeName?.typmods ?? []) as AstNode[]).length === 0 && isNode(b.arg) && this.typeOf(b.arg) === NUMERIC ? of(b.arg) : null;
      }
      default: return null;
    }
  }

  /**
   * The decimals Postgres writes for an expression's every value, where its types alone decide them: a numeric(p, s)
   * column's s, a literal's own, a sum / min / max of one, + and - the larger, * the sum (numeric.c's add_var, mul_var).
   * Null where the values decide (an unconstrained column, a division): DuckDB's own scale stands there.
   */
  private displayScale(n: AstNode): number | null {
    const k = kindOf(n), b = bodyOf(n);
    const t = this.typed(n);
    if (t !== null && INTEGERS.has(t.type)) return 0;
    switch (k) {
      case "ColumnRef": return t !== null && t.type === NUMERIC && t.typmod >= 4 ? (t.typmod - 4) & 0xffff : null;
      case "A_Const": return b.ival !== undefined ? 0 : b.fval !== undefined ? (positional(String(b.fval.fval)).split(".")[1] ?? "").length : null;
      case "A_Expr": {
        if (b.kind !== "AEXPR_OP") return null;
        const name = lastName(b.name);
        const r = isNode(b.rexpr) ? this.displayScale(b.rexpr) : null;
        if (b.lexpr === undefined) return name === "-" || name === "+" ? r : null;
        const l = isNode(b.lexpr) ? this.displayScale(b.lexpr) : null;
        if (l === null || r === null) return null;
        return name === "+" || name === "-" ? Math.max(l, r) : name === "*" ? l + r : null;
      }
      case "FuncCall": {
        const args = (b.args ?? []) as AstNode[];
        // (div of two integers is whole: the only div the rewrite answers, `div-numeric`)
        if (lastName(b.funcname) === "div" && args.length === 2) return 0;
        // (extract's numeric: a second and an epoch to the microsecond, milliseconds to three places, the rest whole; a
        // date's every part whole, as the rewrite writes them, `extract`)
        if (lastName(b.funcname) === "extract" && args.length === 2) {
          const field = (constString(args[0]) ?? "").toLowerCase();
          if (field === "") return null;
          return this.typeOf(args[1]!) === DATE ? 0 : Number(INTERVAL_SCALE[field] ?? "0");
        }
        // (latest, Mason's, answers one row's value: its scale is its argument's)
        // (any_value and first, the rewrite's read of a column per group, are one row's value too)
        if (!["sum", "min", "max", "latest", "any_value", "first"].includes(lastName(b.funcname)) || args.length !== 1 || b.agg_star === true || b.agg_within_group === true) return null;
        return this.displayScale(args[0]!);
      }
      case "TypeCast": {
        const target = lastName(b.typeName?.names);
        if (target !== "numeric" && target !== "decimal") return null;
        const mods = ((b.typeName?.typmods ?? []) as AstNode[]).map((m) => constInt(m));
        if (mods.length === 0) {
          if (!isNode(b.arg)) return null;
          const from = this.typeOf(b.arg);
          // an integer is whole; a literal text has the decimals it is written with (`'1.50'::numeric`)
          if (from !== null && INTEGERS.has(from)) return 0;
          const literal = constString(b.arg) === null ? null : numericLiteral(constString(b.arg)!);
          if (literal !== null) return (literal.split(".")[1] ?? "").length;
          return from === NUMERIC ? this.displayScale(b.arg) : null;
        }
        return mods.some((m) => m === null) ? null : mods[1] ?? 0;
      }
      default: return null;
    }
  }

  // ------------------------------------------------------------------------------------- sorting and collation

  /**
   * THE COLLATION A TEXT EXPRESSION CARRIES, as DuckDB follows it: Postgres's analysis of it (exprCollation, `Typed.collation`:
   * a COLLATE's, a column's own, a derived table's or a set operation's column, a function's result), what the OID
   * means the one resolver's (src/duck/collation.ts). Null for a value of no text type. Never a COLLATE's name, never
   * the database's read directly (tests/conventions.test.ts "collation resolver").
   */
  private collationOf(n: AstNode): DuckCollation | null {
    if (kindOf(n) === "CollateClause") {
      const own = this.collateTyped(n);
      if (own !== null) return TEXTS.has(own.type) || this.isCitext(own.type) ? this.collations.resolve(own.collation) : null;
      // a COLLATE the analysis has nowhere is no expression Postgres ordered by: never its argument's collation
      if (TEXTS.has(this.typeOf(n) ?? -1)) throw new Unrewritable("Mason could not read the collation of this COLLATE", "add the COLLATE where the value is selected, or COLLATE \"C\"", "collation-unknown");
    }
    const t = this.typed(n);
    const type = this.typeOf(n);
    if (t === null || type === null || !TEXTS.has(type)) return null;
    return this.collations.resolve(t.collation);
  }

  /** a COLLATE's analysed node: at its own offset, else (an ORDER BY repeating a target) the same COLLATE's where the
   *  analysis has it — read before a rule rewrites its argument (`overGroups`), and kept for the node */
  private collateTyped(n: AstNode): Typed | null {
    const b = bodyOf(n);
    const known = this.collateOf.get(b);
    if (known !== undefined) return known;
    const own = this.at(b, ["COLLATEEXPR"]) ?? this.collatedByShape.get(shapeOf(n)) ?? null;
    if (own !== null) this.collateOf.set(b, own);
    return own;
  }

  /** THE COLLATION A COMPARISON, A GREATEST / LEAST, AN AGGREGATE OR A WINDOW COMPARED ITS INPUTS UNDER: the analysed
   *  node's inputcollid (`Typed.inputCollation`), never its left operand's (issue 150). Null where it compared none */
  private inputCollationOf(t: Typed | null): DuckCollation | null {
    if (t !== null && t.inputCollation === 0 && t.args.some((a) => COLLATED_TEXTS.has(a.type))) throw indeterminate();
    return t === null || t.inputCollation === 0 ? null : this.collations.resolve(t.inputCollation);
  }

  /** the collation an ORDER BY key, a percentile's or a min's argument is ordered under: `collationOf`, and Postgres's
   *  error where it could determine none (a set operation's column of C and ICU) */
  private orderedUnder(n: AstNode): DuckCollation | null {
    const c = this.collationOf(n);
    if (c === null && kindOf(n) !== "CollateClause" && this.typed(n)?.collation === 0 && COLLATED_TEXTS.has(this.typeOf(n) ?? -1)) throw indeterminate();
    return c;
  }

  /** the keys DuckDB sorts by for one text expression under a collation */
  private sortKeys(e: AstNode, c: DuckCollation): AstNode[] {
    const plain = kindOf(e) === "CollateClause" ? bodyOf(e).arg as AstNode : e;
    switch (c.kind) {
      case "bytes": return [plain];
      // (ICU ignores U+FE0F, a joiner: a tie there is two strings, which Postgres orders by their bytes, as under libc)
      case "icu": return [collate(this.cp(plain), c.name), plain];
      case "libc": return libcKeys(this.cp, plain, c.collate);
    }
  }

  /** a SortBy: its expression's sort keys under its collation (several under a libc one), each with its direction */
  private sortBy(b: Body, targets: AstNode[] | null, select: Body | null, bound?: Output | null): AstNode[] | null {
    let e = b.node as AstNode;
    if (targets !== null) {
      // (the output the one resolver bound the key to, where the caller has it: `keysBound`)
      const out = bound !== undefined ? bound : this.outputOf(e, targets);
      if (out?.twin === true) throw this.twinRefused();
      if (out !== null) {
        // AN OUTPUT THAT IS A NUMERIC THE ENGINE HOLDS AS A DOUBLE (issue 353) is keyed as its analysed expression by
        // `exactOrderKey`, which reads the key per group itself (`overGroups` of its text): never over the value already
        // read through any_value, which no program is built over, whatever the GROUP BY's spelling (`GROUP BY b.id, b.x`)
        const ordered = this.exactOrderKey(this.clone(out.value), select);
        if (ordered !== null) return [{ SortBy: { ...b, node: ordered } }];
        e = this.overGroups(this.clone(out.value), select);
      }
    }
    // a derived table's column read through `s.*` (`SELECT s.* FROM (…) AS s ORDER BY s.pod`, a tool's wrapper): Postgres
    // analysed the ORDER BY as the star's expansion, at no offset of its own, so the column has no type here — it is the
    // subquery's target of that name, whose type and collation decide the order (a review finding: sorted by bytes)
    if (kindOf(e) === "ColumnRef" && select !== null && this.typed(e) === null) {
      const target = this.derivedTarget(e, select);
      if (target !== null) this.typedLike.set(bodyOf(e), target);
    }
    const type = this.typeOf(e);
    if (type === INET) throw new Unrewritable("ORDER BY an inet value is not supported by Mason (Postgres orders addresses by network, then host)", "sort by another column", "inet-order");
    // the copy holds its text, and the type's order is not the text's (src/duck/held-types.ts)
    if (heldType(type) !== undefined) throw new Unrewritable("ORDER BY a value of this type is not supported by Mason: Mason holds the value's text, and Postgres orders it by the type's own rules", "ORDER BY x::text, or another column", "held-type-compare");
    // a citext sorts by its lower-cased text under the database's collation (citext_cmp)
    if (this.isCitext(type)) { e = this.foldCitext(e); b.node = e; }
    // a jsonb sorts by its order key (jsonb's own order: src/duck/jsonb-order.ts), its NULLs where the SortBy puts them
    if (type === JSONB) return [{ SortBy: { ...b, node: this.jsonbKey(e) } }];
    // a numeric the engine holds as a double sorts by its exact value's order key (`exactOrderKey`); in a grouped SELECT
    // read once per group, whose rows hold one value
    const ordered = this.exactOrderKey(e, select ?? this.groupedWindowKeys.get(b) ?? null);
    if (ordered !== null) return [{ SortBy: { ...b, node: ordered } }];
    this.comparable(e, "ORDER BY");
    const c = this.orderedUnder(e);
    // a char(n) sorts without its padding (bpcharcmp)
    if (this.typeOf(e) === BPCHAR) { e = fn("rtrim", [e]); this.typedLike.set(bodyOf(e), b.node as AstNode); b.node = e; }
    if (c === null || (c.kind === "bytes" && kindOf(b.node as AstNode) !== "CollateClause")) return null;
    return this.sortKeys(e, c).map((k) => ({ SortBy: { ...b, node: k } }));
  }

  /**
   * AN OUTPUT'S EXPRESSION AS A KEY BUILT OVER IT READS IT IN A GROUPED SELECT (the class "an output not resolved to its
   * column"): a collation's keys, citext's lower() or jsonb's order key are built over the value under the output's
   * COLLATE, which is no grouped expression when the GROUP BY groups the output itself (`t.s COLLATE "und-x-icu" AS x
   * … GROUP BY 1 ORDER BY 1`: DuckDB refused t.s, "must appear in the GROUP BY clause"). Every row of a group holds one
   * such value, so it is read through any_value. A grouped expression itself, or one holding an aggregate or a window,
   * stays as it is.
   */
  private overGroups(e: AstNode, select: Body | null): AstNode {
    const groups = (select?.groupClause ?? []) as AstNode[];
    if (select === null || groups.length === 0 || groups.some((g) => kindOf(g) === "GroupingSet")) return e;
    const collated = kindOf(e) === "CollateClause" && isNode(bodyOf(e).arg);
    const value = collated ? bodyOf(e).arg as AstNode : e;
    // (DuckDB groups `t.s COLLATE …` as that expression: the bare t.s under it is not grouped; a jsonb the engine groups
    // by its key is read per group too, as one value: `groupedAs`)
    if (this.groupedAs(value, select) === "engine" || kindOf(value) === "A_Const") return e;
    const aggregated = (v: unknown): boolean => {
      if (Array.isArray(v)) return v.some(aggregated);
      if (v === null || typeof v !== "object") return false;
      if (isNode(v) && kindOf(v) === "FuncCall" && (bodyOf(v).over !== undefined || this.typed(v)?.node === "AGGREF" || ["any_value", "first", "count"].includes(lastName(bodyOf(v).funcname)))) return true;
      if (isNode(v) && kindOf(v) === "SubLink") return true;
      // (a column decidedByKey marked to be read per group: the value is computed per group over it, issue 665)
      if (isNode(v) && kindOf(v) === "ColumnRef" && this.readPerGroup.has(bodyOf(v))) return true;
      return Object.values(isNode(v) ? bodyOf(v) : v as Body).some(aggregated);
    };
    if (aggregated(value)) return e;
    // (the COLLATE's collation read before its argument changes shape)
    if (collated) this.collateTyped(e);
    const read = fn("any_value", [value]);
    this.typedLike.set(bodyOf(read), value);
    if (!collated) return read;
    bodyOf(e).arg = read;
    return e;
  }

  /** the target a derived table's column names (`s.pod`, or `pod` where one derived table is read): the subquery's or
   *  the CTE's target with that output name, when there is exactly one; null for a base table's column or an ambiguity */
  /** the FROM's subqueries and CTE references, by alias (a column list renames them: left out) */
  private fromSources(select: Body): Array<{ alias: string; query: AstNode }> {
    const sources: Array<{ alias: string; query: AstNode }> = [];
    const visit = (x: AstNode): void => {
      if (kindOf(x) === "JoinExpr") { for (const side of [bodyOf(x).larg, bodyOf(x).rarg]) if (isNode(side)) visit(side); return; }
      if (kindOf(x) === "RangeSubselect") { const a = bodyOf(x).alias?.aliasname; if (typeof a === "string" && isNode(bodyOf(x).subquery) && bodyOf(x).alias?.colnames === undefined) sources.push({ alias: a, query: bodyOf(x).subquery as AstNode }); return; }
      if (kindOf(x) === "RangeVar" && bodyOf(x).schemaname === undefined && bodyOf(x).alias?.colnames === undefined) {
        const cte = this.ctes.get(String(bodyOf(x).relname));
        if (cte !== undefined) sources.push({ alias: bodyOf(x).alias?.aliasname ?? String(bodyOf(x).relname), query: cte });
      }
    };
    for (const x of (select.fromClause ?? []) as AstNode[]) if (isNode(x)) visit(x);
    return sources;
  }

  private derivedTarget(ref: AstNode, select: Body): AstNode | null {
    const f = names(bodyOf(ref).fields);
    if (f.length === 0 || f.length > 2) return null;
    const col = f[f.length - 1]!, alias = f.length === 2 ? f[0] : undefined;
    const sources = this.fromSources(select);
    const matching = alias === undefined ? sources : sources.filter((q) => q.alias === alias);
    if (matching.length !== 1) return null;
    let q = bodyOf(matching[0]!.query);
    while (q.op !== undefined && q.op !== "SETOP_NONE" && q.larg !== undefined) q = q.larg as Body;
    const hits = ((q.targetList ?? []) as AstNode[]).filter((t) => isNode(bodyOf(t).val) && !hasStar(bodyOf(t).val) && (bodyOf(t).name ?? figureColname(bodyOf(t).val as AstNode)) === col);
    return hits.length === 1 ? bodyOf(hits[0]!).val as AstNode : null;
  }

  /** a GROUP BY item as the expression it groups: an ordinal or an output name is that target's */
  private groupedExpression(g: AstNode, b: Body): AstNode {
    return this.groupOutput(g, (b.targetList ?? []) as AstNode[])?.value ?? g;
  }

  /**
   * THE GROUP BY AS POSTGRES ANALYSED IT (issue 212; the class "a fact derived in several places"): the shape of each
   * expression a SELECT's GROUP BY groups, outside a grouping set, each item resolved by the one resolver
   * (`groupedExpression`: an ordinal or an output name is its target's), RECORDED ONCE per SELECT before any rule writes
   * the clause for the engine (`select` asks first; `exactColumns`, before the walk, may). What the record says of each
   * is how the ENGINE's GROUP BY holds it: `engine`, as written; `keyed`, by a key a rule put in its place
   * (`keyedGroups`: a jsonb by its equality key, so the engine groups 1.0 with 1.00 as Postgres does), the expression
   * read per group through one any_value of it; `cells`, by a key in its place too (a numeric decided exactly, by its
   * exact key: issue 665), the expression computed per group over its columns, each read per group. A grouped
   * expression is grouped whatever the clause became: whether one is, and how, is read here alone (`groupedAs`), never
   * from the clause as a later rule left it — the clause read after `keyedGroups` lost the jsonb expression, so its
   * every reader took it for ungrouped and read its column through any_value (`any_value(j.j) -> 'r'`: 2.45 for 2.450).
   */
  private readonly groupings = new WeakMap<object, Map<string, GroupedAs>>();

  private grouping(b: Body): Map<string, GroupedAs> {
    let record = this.groupings.get(b);
    if (record === undefined) {
      record = new Map();
      for (const g of (b.groupClause ?? []) as AstNode[]) if (isNode(g) && kindOf(g) !== "GroupingSet") record.set(shapeOf(this.groupedExpression(g, b)), "engine");
      this.groupings.set(b, record);
    }
    return record;
  }

  /** whether a bare name is an output's name Postgres bound it to, no column: it has no analysed node of its own (an
   *  ORDER BY or HAVING naming an output is analysed as the target) and an output of the list bears it */
  private outputNamed(ref: AstNode, targets: readonly AstNode[]): boolean {
    const f = names(bodyOf(ref).fields);
    return f.length === 1 && this.typedAt(ref) === null && targets.some((t) => bodyOf(t).name === f[0]);
  }

  /** how SELECT `b`'s GROUP BY groups `e` (`grouping`): as written in the engine's clause, by a key in its place, or
   *  not at all (null) */
  private groupedAs(e: AstNode, b: Body | null): GroupedAs | null {
    return b === null ? null : this.grouping(b).get(shapeOf(e)) ?? null;
  }

  /** a value Mason cannot sort, group or compare as Postgres does: a jsonb where it is not keyed (`compared` keys it),
   *  a jsonb array (each element by jsonb's rules), a text array under the database's collation (each element under
   *  it) — refused, where a statement would need it */
  private comparable(n: AstNode, where: string): void {
    const type = this.typeOf(n);
    const held = heldType(type);
    if (held !== undefined && !held.textEqual) throw new Unrewritable(`${where} a value of this type is not supported by Mason: Mason holds the value's text, and Postgres's equal values may be written apart`, "x::text, where equal text is what is meant", "held-type-compare");
    if (this.isCitext(type)) throw new Unrewritable(`${where} a citext value is not supported by Mason (Postgres groups and sorts it without regard to case)`, "GROUP BY lower(x), or x::text where case matters", "citext-forms");
    if (type === JSONB) throw new Unrewritable(`${where} a jsonb value is not supported by Mason (Postgres orders and equates jsonb by its own rules)`, JSONB_WAY_OUT, "jsonb-compare");
    if (type === JSONB_ARRAY) throw new Unrewritable(`${where} a jsonb array is not supported by Mason (Postgres compares its elements by jsonb's rules)`, "compare an element (a[1]), or a::text", "jsonb-compare");
    if (this.rowHoldsJsonb(n)) throw new Unrewritable(`${where} a row holding a jsonb is not supported by Mason (Postgres compares the jsonb by its own rules)`, "list its members one by one: GROUP BY a, j", "jsonb-compare");
    if ((type === 1009 || type === 1015) && this.collations.resolve(this.typed(n)?.collation ?? DEFAULT_COLLATION_OID)?.kind !== "bytes") {
      throw new Unrewritable(`${where} a text array is not supported by Mason under its collation`, "sort by an element (a[1]) or by array_to_string(a, ',')", "text-array-order");
    }
  }

  /**
   * A JSONB AS ITS ORDER KEY (src/duck/jsonb-order.ts): bytes whose order and equality are Postgres's for jsonb
   * (`compareJsonbContainers`: by type, then size, then member by member; numbers as numerics; strings under the
   * database's collation). Under C or a libc locale the key is one call; under ICU each of the document's strings
   * needs DuckDB's ICU key, which a JavaScript function cannot ask for, so DuckDB makes them over the strings the
   * function lists (`list_transform` with a lambda, src/duck/store.ts `lambda_syntax`) and hands them to the key.
   */
  private jsonbKey(e: AstNode): AstNode {
    return this.keptKey(e) ?? this.jsonbKeyCall(e);
  }

  /** the key computed per row (`jsonbKey`): the functions src/duck/jsonb-order.ts `JSONB_KEY_FUNCTIONS` names */
  private jsonbKeyCall(e: AstNode): AstNode {
    // (Postgres compares a jsonb's strings under DEFAULT_COLLATION_OID, whatever the column's: the database's)
    const c = this.collations.database;
    if (c.kind !== "icu") return fn(JSONB_KEY_FUNCTIONS[c.kind].key, [e]);
    const each = (): AstNode => ({ ColumnRef: { fields: [S("__mason_s")] } });
    const f = JSONB_KEY_FUNCTIONS.icu;
    const keys = fn("list_transform", [fn(f.strings, [this.clone(e)]), op("->", each(), fn("icu_sort_key", [each(), strConst(c.name)]))]);
    return fn(f.key, [e, keys]);
  }

  /**
   * A JSONB'S STORED KEY (src/duck/kept-route.ts `ORDER_STEPS`): `e` a copied table's jsonb column — recorded as one of
   * the statement's reads, the order's, so the keeper weighs storing its key as it weighs a path — read from the key's
   * hidden column once every row of it is stored (READY). The column holds the key, `KEY_NULL` for a NULL document, or
   * `KEY_RECOMPUTE` where the key raised; read alone while no row is marked, else through a CASE that computes the
   * marked rows (and raises the key's own error). null: not such a column, or not stored — the caller computes the key.
   * `steps` `EQUAL_STEPS` is the C key under a libc collation (`equalKey`), recorded and read the same way, computed by
   * the C key's function where a row is marked.
   */
  private keptKey(e: AstNode, steps: typeof ORDER_STEPS | typeof EQUAL_STEPS = ORDER_STEPS): AstNode | null {
    // a column of a derived table typed as the subquery's target (sortBy's `s.*` wrapper, `typedLike`) is the
    // subquery's column, whose FROM item has no hidden column (the oracle's eager run: DuckDB's 42703)
    if (this.kept === null || kindOf(e) !== "ColumnRef" || this.typedLike.has(bodyOf(e))) return null;
    const fields = (bodyOf(e).fields ?? []) as AstNode[];
    const last = fields.at(-1);
    const t = this.typed(e);
    if (last === undefined || kindOf(last) !== "String" || t === null || t.node !== "VAR" || t.relation === undefined || t.renamed !== null) return null;
    const at = this.kept.at(t.relation.relid, t.relation.attno);
    if (at === null) return null;
    const read: JsonRead = { source: at.source, column: at.column, steps, either: false, canonical: true, asText: false };
    this.jsonReads.set(readKey(read), read);
    const ready = this.kept.ready(read);
    if (ready === null) return null;
    const computed = (): AstNode => steps === EQUAL_STEPS ? fn(JSONB_KEY_FUNCTIONS.bytes.key, [e]) : this.jsonbKeyCall(e);
    const prefix = fields.length === 1 && t.qualifier !== null ? [S(t.qualifier)] : fields.slice(0, -1).map((f) => structuredClone(f));
    const column = (): AstNode => ({ ColumnRef: { fields: [...prefix.map((f) => structuredClone(f)), S(ready.name)] } });
    const recompute = (): AstNode => fn("unhex", [strConst(KEY_RECOMPUTE_HEX)]);
    const isNullKey = (): AstNode => op("=", column(), fn("unhex", [strConst(KEY_NULL_HEX)]));
    // a row marked since the key was counted exact is never read as a key: it raises (kept-route.ts markedError)
    if (ready.exact) {
      const raise = markedRaise(MARKED_FUNCTIONS.key, fn("hex", [column()]), markedError(read, this.collations.database.kind === "libc"));
      return caseWhen([[isNullKey(), nullConst()], [op("=", column(), recompute()), raise]], column());
    }
    return caseWhen([[or([isNull(column()), op("=", column(), recompute())]), computed()]], caseWhen([[isNullKey(), nullConst()]], column()));
  }

  /**
   * A JSONB AS ITS EQUALITY KEY: the key under C, whatever the database's collation. Postgres's default collation is
   * deterministic, so two jsonb strings are equal only when their bytes are (varstr_cmp breaks a collation's tie by
   * strcmp), and the C key's equality is exactly jsonb's — where the collation's key would refuse a value its order
   * does not cover (a libc collation's `libc-uncovered`) that equality
   * never needed to order. Every context that only equates (=, <>, IN, = ANY, IS DISTINCT FROM, NULLIF, CASE x WHEN,
   * GROUP BY, DISTINCT [ON], count(DISTINCT), PARTITION BY) reads this one; ORDER BY, <, >, BETWEEN read `jsonbKey`.
   */
  private equalKey(e: AstNode): AstNode {
    // under C and ICU the order's key is an equality key too (a string's collation key, then its bytes), which never
    // refuses, so a stored one serves (keptKey) — both sides of an equality read the order's key; only a libc key
    // refuses a string (libc-uncovered), so under libc equality reads the C key: its own stored column where it is
    // (`EQUAL_STEPS`, src/duck/kept.ts), else computed
    if (this.collations.database.kind !== "libc") return this.jsonbKey(e);
    return this.keptKey(e, EQUAL_STEPS) ?? fn(JSONB_KEY_FUNCTIONS.bytes.key, [e]);
  }

  /** a value compared for EQUALITY only (PARTITION BY, IS DISTINCT FROM, NULLIF, CASE x WHEN, = ANY, DISTINCT ON): a
   *  jsonb as its equality key, a jsonb array refused; any other value as it is (its equality is DuckDB's) */
  private equated(n: AstNode, where: string): AstNode {
    const type = this.typeOf(n);
    if (type === JSONB) return this.equalKey(n);
    if (type === JSONB_ARRAY) this.comparable(n, where);
    return n;
  }

  /** a row value (`(a, j)`, `ROW(…)`, a list of IN's left) one of whose members, at any depth, is a jsonb or a jsonb array */
  private rowHoldsJsonb(n: AstNode): boolean {
    if (kindOf(n) !== "RowExpr") return false;
    return ((bodyOf(n).args ?? []) as AstNode[]).some((a) => isNode(a) && (this.typeOf(a) === JSONB || this.typeOf(a) === JSONB_ARRAY || this.rowHoldsJsonb(a)));
  }

  /** a `*` (or `t.*`) whose columns hold a jsonb or a jsonb array, as Postgres expanded it (each column's VAR at the
   *  star's own offset) */
  private starHoldsJsonb(n: AstNode): boolean {
    if (!hasStar(n) || kindOf(n) !== "ColumnRef") return false;
    const at = bodyOf(n).location;
    return typeof at === "number" && (this.types.get(at - this.base) ?? []).some((t) => t.node === "VAR" && (t.type === JSONB || t.type === JSONB_ARRAY));
  }

  /**
   * GROUP BY A JSONB (Postgres groups by jsonb's equality: `1.0` and `1.00` are one group): grouped by its order key,
   * an ordinal or an output name by its target's. The value itself is then no group key of the engine's, so it is
   * recorded `keyed` (`grouping`) and `decidedByKey` reads the whole expression through ONE any_value — the group's
   * value, which is one of the texts Postgres's group holds, as Postgres's answer is the one its plan meets first (gap
   * jsonb-equal-text). Anything else Mason cannot group as Postgres does is refused,
   * in a grouping set too.
   */
  private keyedGroups(b: Body): void {
    if (!Array.isArray(b.groupClause)) return;
    const refuseIn = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) refuseIn(x); return; }
      if (!isNode(v)) return;
      if (kindOf(v) === "GroupingSet") refuseIn(bodyOf(v).content);
      else { const e = this.groupedExpression(v, b); this.refuseExactEquality(e, "GROUP BY a grouping set of"); this.comparable(e, "GROUP BY a grouping set of"); }
    };
    const items = [...b.groupClause as AstNode[]];
    b.groupClause = (b.groupClause as AstNode[]).flatMap((g): AstNode[] => {
      if (!isNode(g)) return [g];
      if (kindOf(g) === "GroupingSet") { refuseIn(bodyOf(g).content); return [g]; }
      const grouped = this.groupedExpression(g, b);
      // (a column a `*` of the list expanded to, grouped by name, is analysed as that entry, at no offset of its own:
      // typed as the list's column it is, so its exact key is built — issue 252)
      const e = this.typed(grouped) === null && kindOf(grouped) === "ColumnRef" ? this.listedColumn(grouped, b) ?? grouped : grouped;
      // A NUMERIC DECIDED EXACTLY IS GROUPED BY ITS EXACT KEY ALONE (exactKey; issue 665): the key is the one thing
      // computed for every row, in ONE call (`__mason_numeric_program_key`), and everything that reads the value (the
      // list's double, a cast, its text, HAVING, the ORDER BY's exact order key, WITH TIES, the record's cells) is
      // computed per group over its columns, each read per group (`cells`: decidedByKey, overGroups). Every row of a
      // group holds one exact value, so any row's columns compute it. Grouped beside its key as well (4861a5b), the
      // value's double, its program and its key were three calls a row, and the ORDER BY's program a fourth
      const exact = this.nativeKey(e) ?? this.exactKey(e, true);
      if (exact !== null) {
        this.grouping(b).set(shapeOf(grouped), "cells");
        return [this.placedKey(b, grouped, exact)];
      }
      if (this.typeOf(e) !== JSONB) { this.comparable(e, "GROUP BY"); return [g]; }
      // (the engine groups it by its key alone: every reader of the expression reads it per group, `groupedAs`)
      this.grouping(b).set(shapeOf(grouped), "keyed");
      return [this.placedKey(b, grouped, this.equalKey(e === g ? g : this.clone(e)))];
    });
    this.groupingArguments(b, items);
  }

  /** a key `keyedGroups` places in the engine's GROUP BY for `grouped`, recorded as placed (`groupKeys`) */
  private placedKey(b: Body, grouped: AstNode, key: AstNode): AstNode {
    let keys = this.groupKeys.get(b);
    if (keys === undefined) this.groupKeys.set(b, keys = new Map());
    keys.set(shapeOf(grouped), this.clone(key));
    return key;
  }

  /**
   * GROUPING(e) OF AN EXPRESSION THE ENGINE GROUPS BY A KEY IN ITS PLACE (PR 674, the class
   * grouping-of-keyed-expression-reads-value, its class round r2): the engine's GROUPING takes only its own GROUP BY
   * entries, so an argument grouped by a key (`keyed`, `cells`) is written as THAT key, as `keyedGroups` placed it
   * (`groupKeys`), never as a reader's value (the expression over its columns read per group), which is no grouping
   * column of the engine's (42804).
   *
   * WHICH GROUPING IS THIS SELECT'S, AND WHICH ENTRY EACH ARGUMENT READS, IS POSTGRES'S ANALYSIS (`Grouping`): the
   * GROUPINGFUNC at the GroupingFunc's offset gives its query level (`levelsUp`, its arguments' Var level: one inside a
   * subquery reading this query's column is this query's) and the GROUP BY entry each argument matched (`refs`, by
   * Postgres's equality). A GROUPING Postgres left no node for is one inside a key it bound by equality to an earlier
   * entry (an ORDER BY's, DISTINCT ON's or WINDOW's key repeating one: findTargetlistEntrySQL92/99 discards the
   * transform): it is read through that key's binding, the entry the key's SortGroupClause names (`keysBound` for an
   * ORDER BY or DISTINCT ON key; a WINDOW clause's own lists, the clause found by its name or by its window function's
   * `winref`), whose expression's GROUPINGFUNCs, in order, are the key's. The whole body is walked, no list of clauses;
   * a subquery one level deeper. An entry's placed key is found by the entry's offset (a target's expression or the
   * GROUP BY item's), then the record. Only where there is no analysed query is an argument matched by its spelling,
   * as before. `decidedByKey` leaves a GROUPING's arguments as they are.
   */
  private groupingArguments(b: Body, items: readonly AstNode[]): void {
    const placed = this.groupKeys.get(b);
    if (placed === undefined) return;
    const targets = (b.targetList ?? []) as AstNode[];
    const keys = this.analysedQuery(targets)?.keys;
    // (an analysed entry's raw expression, by its offset: a target's, or a GROUP BY item's, as it stood)
    const raws = [...targets.map((t) => bodyOf(t).val), ...items, ...items.filter(isNode).map((g) => this.groupedExpression(g, b))].filter(isNode);
    const keyOfEntry = (entry: number): AstNode | undefined => {
      const at = keys?.entries[entry]?.at;
      if (at === null || at === undefined) return undefined;
      const raw = raws.find((r) => this.nodeOffsets(r).includes(at));
      return raw === undefined ? undefined : placed.get(shapeOf(raw));
    };
    const entryOf = (ref: number): number => keys?.entries.findIndex((e) => e.ref === ref) ?? -1;
    // each key Postgres bound by equality to an earlier entry, with that entry's GROUPINGs in order
    const bound = new Map<Body, Grouping[]>();
    const bind = (node: unknown, entry: number | null | undefined): void => {
      if (!isNode(node) || entry === null || entry === undefined || keys === undefined) return;
      const groupings = keys.entries[entry]?.groupings ?? [];
      if (groupings.length > 0) bound.set(bodyOf(node), groupings);
    };
    if (keys !== undefined) {
      const sorts = Array.isArray(b.sortClause) ? (b.sortClause as AstNode[]).map((s) => bodyOf(s).node as AstNode) : [];
      if (sorts.length > 0) this.keysBound(sorts, keys, "sorted", targets).forEach((k, i) => bind(sorts[i], k.entry));
      const ons = Array.isArray(b.distinctClause) ? (b.distinctClause as unknown[]).filter(isNode) : [];
      if (ons.length > 0) this.keysBound(ons, keys, "distinct", targets).forEach((k, i) => bind(ons[i], k.entry));
      const windowed = (def: Body, clause: Keys["windows"][number] | undefined): void => {
        if (clause === undefined) return;
        const partition = (def.partitionClause ?? []) as AstNode[], order = ((def.orderClause ?? []) as AstNode[]).map((s) => bodyOf(s).node as AstNode);
        if (partition.length === clause.partition.length) partition.forEach((p, i) => bind(p, clause.partition[i]));
        if (order.length === clause.order.length) order.forEach((o, i) => bind(o, clause.order[i]));
      };
      for (const w of (b.windowClause ?? []) as AstNode[]) if (isNode(w)) windowed(bodyOf(w), keys.windows.find((c) => c.name === bodyOf(w).name));
      const overs = (v: unknown): void => {
        if (Array.isArray(v)) { for (const x of v) overs(x); return; }
        if (v === null || typeof v !== "object" || (isNode(v) && (kindOf(v) === "SubLink" || kindOf(v) === "SelectStmt"))) return;
        // (an OVER's own window is a plain body, a WindowDef unwrapped)
        const over = isNode(v) && kindOf(v) === "FuncCall" ? bodyOf(v).over : undefined;
        if (over !== null && typeof over === "object") {
          const winref = this.allAt(bodyOf(v as AstNode), ["WINDOWFUNC"])[0]?.winref;
          windowed(over as Body, winref === null || winref === undefined ? undefined : keys.windows.find((c) => c.winref === winref));
        }
        for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) overs(x);
      };
      overs([b.targetList, b.sortClause]);
    }
    const visit = (v: unknown, depth: number, inherited: Grouping[] | undefined): void => {
      if (Array.isArray(v)) { for (const x of v) visit(x, depth, inherited); return; }
      if (v === null || typeof v !== "object") return;
      if (!isNode(v)) { for (const x of Object.values(v as Body)) visit(x, depth, inherited); return; }
      const k = kindOf(v), n = bodyOf(v);
      // (another query: one level deeper, its own keys its own)
      if (k === "SelectStmt") { for (const x of Object.values(n)) visit(x, depth + 1, undefined); return; }
      const queue = bound.has(n) ? [...bound.get(n)!] : inherited;
      if (k === "GroupingFunc") {
        const own = this.allAt(n, ["GROUPINGFUNC"])[0]?.grouping;
        const g = own ?? queue?.shift();
        const args = Array.isArray(n.args) ? n.args as unknown[] : [];
        if (g !== undefined && keys !== undefined) {
          if (g.levelsUp === depth) n.args = args.map((a, i) => { const ref = g.refs[i]; const key = ref === undefined ? undefined : keyOfEntry(entryOf(ref)); return key === undefined ? a : this.clone(key); });
        } else if (keys === undefined && depth === 0) {
          // (no analysed query to read: the argument by its spelling, the record's own key)
          n.args = args.map((a) => { const key = isNode(a) ? placed.get(shapeOf(a)) : undefined; return key === undefined ? a : this.clone(key); });
        }
        return;
      }
      for (const [key, x] of Object.entries(n)) if (key !== "location") visit(x, depth, queue);
    };
    // (the GROUP BY holds the keys themselves, and a set operation's arms and WITH queries are SELECTs of their own)
    for (const [key, x] of Object.entries(b)) if (key !== "groupClause" && key !== "withClause" && key !== "larg" && key !== "rarg") visit(x, 0, undefined);
  }

  /** the offsets a raw expression is analysed at: its own, and a cast's or a COLLATE's argument's (an analysed node
   *  Postgres folded away leaves its argument's) */
  private nodeOffsets(n: AstNode): number[] {
    const b = bodyOf(n);
    const own = typeof b.location === "number" && b.location >= 0 ? [b.location - this.base] : [];
    const k = kindOf(n);
    return (k === "TypeCast" || k === "CollateClause") && isNode(b.arg) ? [...own, ...this.nodeOffsets(b.arg as AstNode)] : own;
  }

  /** the SELECT list's column (a `*`'s, as Postgres expanded it: `outputs`) a column reference names by the same
   *  qualified name, typed; null where none, or more than one, is */
  private listedColumn(ref: AstNode, b: Body): AstNode | null {
    const want = names(bodyOf(ref).fields).join(".");
    const hits = this.outputs((b.targetList ?? []) as AstNode[]).filter((o) => kindOf(o.value) === "ColumnRef" && names(bodyOf(o.value).fields).join(".") === want && this.typed(o.value) !== null);
    return hits.length === 1 ? this.clone(hits[0]!.value) : null;
  }

  /**
   * SELECT DISTINCT OVER A JSONB (Postgres's DISTINCT is jsonb's equality): DuckDB's DISTINCT ON the targets, each
   * jsonb by its order key — the first row of each set of equal ones, in the ORDER BY's order, as DuckDB's DISTINCT ON
   * keeps (one of the texts Postgres's answer may be: gap jsonb-equal-text). A DISTINCT ON's own jsonb expression is
   * keyed alike. A `*` holding a jsonb column is refused (its columns are not written out here).
   */
  private keyedDistinct(b: Body): void {
    if (!Array.isArray(b.distinctClause)) return;
    const targets = (b.targetList ?? []) as AstNode[];
    const plain = b.distinctClause.length === 1 && !isNode(b.distinctClause[0]);
    const values = targets.map((t) => bodyOf(t).val).filter(isNode);
    // (a DISTINCT ON compares its ON expressions alone: the targets beside them are only read)
    if (plain) for (const v of values) if (this.typeOf(v) !== JSONB) this.comparable(v, "SELECT DISTINCT");
    if (!plain) {
      // A CONSTANT KEY (the class, issue 134: a constant key written into the engine as a bare literal, in any clause;
      // src/duck/constant-key.ts): a DISTINCT ON key the analysis put a Const, after its output name or number is
      // resolved, divides no rows, and written as the bare literal the engine refuses it (42804) or reads an ordinal. It
      // is no key; with none left every row is one set, so one key the engine evaluates, which divides nothing either
      // (a key bound to an output or the ORDER BY's key by equality, spelled unlike it: by the one resolver)
      const ons = b.distinctClause as AstNode[];
      // (a key bound to an output, by its number, its name or an equal expression, is that output: the one resolver;
      // a jsonb's equality key is built over the output's expression, a key named by its alias included)
      const bound = this.keysBound(ons.map((d) => isNode(d) ? d : undefined), this.analysedQuery(targets)?.keys, "distinct", targets);
      const keys = ons.flatMap((d, i) => {
        const out = bound[i]!.output;
        return !isNode(d) || out?.twin === true || (bound[i]!.constant ?? this.typed(out !== null ? out.value : d)?.constant) !== true ? [{ d, out }] : [];
      });
      if (keys.length === 0) { b.distinctClause = [evaluated(strConst("one set"))]; return; }
      b.distinctClause = keys.map(({ d, out }) => {
        // (the output's expression, typed and keyed here, so every form sent reads the key, never the raw value an alias
        // names; a numeric decided exactly by its exact key: exactKey)
        const e = out !== null && !out.twin ? out.value : d;
        const exact = this.exactKey(e);
        if (exact !== null) return exact;
        if (this.typeOf(e) !== JSONB) { this.comparable(e, "SELECT DISTINCT ON"); return d; }
        return this.equalKey(e !== d ? this.clone(e) : d);
      });
      return;
    }
    for (const v of values) if (this.starHoldsJsonb(v)) throw new Unrewritable("SELECT DISTINCT * over a jsonb column is not supported by Mason (Postgres equates jsonb by its own rules)", "name the columns: SELECT DISTINCT a, b, …", "jsonb-compare");
    if (!values.some((v) => this.typeOf(v) === JSONB || this.exactKey(v) !== null)) return;
    // (a numeric decided exactly by its exact key: exactKey)
    b.distinctClause = values.map((v) => this.exactKey(v) ?? this.equated(this.clone(v), "SELECT DISTINCT"));
  }

  /**
   * AN EXPRESSION'S OWN COLLATE IS NEVER THE ENGINE'S: every reader that orders text (a sort, a comparison, GREATEST,
   * min / max, WITHIN GROUP) builds its keys under the collation Postgres's analysis resolved, the COLLATE's included,
   * however far it reached (a derived table's column, a set operation's); and what only equates is byte equality under
   * any deterministic collation. A COLLATE left in the engine's SQL would carry the engine's own collation to whatever
   * read the value next (a derived table's column sorted by bytes under another COLLATE) — so it is dropped.
   */
  private collateClause(b: Body): AstNode | null {
    return b.arg as AstNode;
  }

  /** a text comparison under the collation: `a < b` compares their keys */
  private compareText(name: string, l: AstNode, r: AstNode, c: DuckCollation): AstNode {
    if (c.kind === "icu") return op(name, icuKey(this.cp, strip(l), c.name), icuKey(this.cp, strip(r), c.name));
    if (c.kind === "libc") return op(name, libcKey(this.cp, strip(l), c.collate), libcKey(this.cp, strip(r), c.collate));
    return op(name, l, r);
  }

  /** A ROW COMPARISON (`(c, id) < ('b', 3)`): each column under its own collation, the one Postgres compared it under
   *  (RowCompareExpr's inputcollids, found at its first left column's offset); a text column of a collation that is not
   *  byte order compared by its key, which ends in the value's bytes (so equal keys are equal values); and the row
   *  compared PAIR BY PAIR as Postgres compares it (`rowOrdered`), never as the engine's struct */
  private rowCompared(name: string, l: AstNode, r: AstNode): AstNode | null {
    const ls = (bodyOf(l).args ?? []) as AstNode[], rs = (bodyOf(r).args ?? []) as AstNode[];
    if (ls.length !== rs.length || ls.length === 0) return null;
    const textual = [...ls, ...rs].some((x) => TEXTS.has(this.typeOf(x) ?? -1));
    const first = ls[0];
    const compared = first === undefined ? null : this.rowCompareAt(first);
    // a citext member: Postgres orders it without regard to case (citext_cmp), which the pair's own ordering is not
    if ([...ls, ...rs].some((x) => this.holdsCitext(this.typeOf(x))) || compared?.inputTypes?.some((t) => this.holdsCitext(t)) === true) {
      throw new Unrewritable("a row holding a citext compared by <, <=, > or >= is not supported by Mason (Postgres compares the citext without regard to case)", "compare its members one by one: lower(x) < lower(y)", "citext-forms");
    }
    const collations = compared?.inputCollations;
    if (collations === undefined || collations.length !== ls.length) {
      if (textual) throw new Unrewritable(`Mason could not read the collations of this row comparison (${name})`, "compare the columns one by one", "collation-unknown");
      return this.rowOrdered(name, ls, rs);
    }
    if (collations.some((o, i) => o === 0 && [ls[i], rs[i]].some((x) => x !== undefined && COLLATED_TEXTS.has(this.typeOf(x) ?? -1)))) throw indeterminate();
    const each = collations.map((o) => this.collations.resolve(o));
    // both sides of a column in ONE shape, the type Postgres compared it as (`inputTypes`), never each side's own: a
    // literal beside a char(n) is a char(n), compared without its padding (bpcharcmp), a char(n) beside a text its text
    const types = compared?.inputTypes;
    if (types === undefined || types.length !== ls.length) {
      if (textual) throw new Unrewritable(`Mason could not read the types of this row comparison (${name})`, "compare the columns one by one", "collation-unknown");
      return this.rowOrdered(name, ls, rs);
    }
    const plain = (i: number): boolean => { const c = each[i]; return c === null || c === undefined || c.kind === "bytes"; };
    if (types.every((t, i) => t !== BPCHAR && plain(i)) && ![...ls, ...rs].some((x) => this.typeOf(x) === BPCHAR)) return this.rowOrdered(name, ls, rs);
    const keyed = (xs: AstNode[]): AstNode[] => xs.map((x, i) => {
      const c = each[i], t = types[i]!, v = this.widen(x, t);
      if (c === null || c === undefined || c.kind === "bytes") return t === BPCHAR ? fn("rtrim", [strip(v)]) : v;
      return this.textKey(v, c, t === BPCHAR, null);
    });
    return this.rowOrdered(name, keyed(ls), keyed(rs));
  }

  /**
   * TWO ROWS ORDERED AS POSTGRES ORDERS THEM (PR 674 CI fix 1, the class of `rowQuantified`): the pairs read left to
   * right, the first pair holding a NULL making the comparison NULL and the first unequal pair deciding it, all equal
   * true for <= and >=. The engine compares a row as a struct, a NULL member ordered rather than NULL. Each operand is
   * evaluated once: the pairs are one ROW, read by a lambda over a list of it
   */
  private rowOrdered(name: string, ls: AstNode[], rs: AstNode[]): AstNode {
    const less = name === "<" || name === "<=" ? "<" : ">";
    const param = `__mason_r${this.sublinkOutputs++}`;
    // each operand read once through the ROW, but a constant (a literal, a cast of one, a parameter), placed where it is
    // compared so the engine casts it to the other side's type as it does any comparison's (`(u, id) > ('…', 0)`)
    const read: AstNode[] = [];
    const operand = (x: AstNode): (() => AstNode) => {
      if (isConstant(x)) return () => this.clone(x);
      read.push(x);
      const k = read.length;
      return () => fn("struct_extract", [{ ColumnRef: { fields: [S(param)] } }, intConst(k)]);
    };
    const arms: Array<[AstNode, AstNode]> = [];
    const sides = ls.map((x, i) => [operand(x), operand(rs[i]!)] as const);
    sides.forEach(([left, right]) => {
      arms.push([or([isNull(left()), isNull(right())]), nullConst()]);
      arms.push([op("<>", left(), right()), op(less, left(), right())]);
    });
    const pairs = row(read);
    const each = fn("list_transform", [{ A_ArrayExpr: { elements: [pairs] } }, op("->", { ColumnRef: { fields: [S(param)] } }, caseWhen(arms, boolConst(name === "<=" || name === ">=")))]);
    return fn("list_extract", [each, intConst(1)]);
  }

  /** the row comparison Postgres made of a raw `ROW(…) < ROW(…)`, by its first left column (src/duck/pgtree.ts) */
  /**
   * ONE OPERAND OF A COMPARISON AS POSTGRES RESOLVED IT (PR 674 class round r2, the class char-padding-in-sublink-test):
   * `own` and `other` the types of the operator's two arguments, read from Postgres's analysis of the comparison by the
   * caller. Widened to its own (`widen`: a char(n) read as a text is its rtrim, Postgres's bpchar-to-text cast); and,
   * where the comparison is between two char(n) (bpchareq, bpcharlt …, no cast on either side), without its padding.
   * Every comparison writes its operands through here: an operator's (`AEXPR_OP`), IN over a list's, a SubLink's.
   */
  private compared(n: AstNode, own: number | null | undefined, other: number | null | undefined, comparison: boolean): AstNode {
    if (comparison && own === BPCHAR && other === BPCHAR) { const r = fn("rtrim", [n]); this.typedLike.set(bodyOf(r), n); return r; }
    return this.widen(n, own) as AstNode;
  }

  /**
   * A SUBLINK's COMPARISON (`x IN (SELECT …)`, `x = ANY / ALL (SELECT …)`, a row's) AS POSTGRES RESOLVED IT, column by
   * column (PR 674 class rounds r2 and r3, the class char-padding-in-sublink-test): each pair's argument types read from
   * the analysed operator at the SubLink (an OPEXPR a column) or, for a row compared by an ordering operator, the
   * ROWCOMPAREEXPR placed at the SubLink's offset (pgtree.ts `typesByLocation`; a grouped column's Var has none of its
   * own) or at its first left column's (`rowCompareAt`); each output column's own type from the subquery's
   * output the operator reads (`Typed.params`, its PARAM_SUBLINK), whatever the subquery's form. The test operands are
   * written through `compared`, and the outputs through it FROM OUTSIDE the subquery, over its columns (`SELECT <each
   * written> FROM (<the subquery>) AS <alias>(c1 … cn)`), so a set operation, VALUES, a *, TABLE or a CTE is written as
   * a plain list is, and a pair's two operands are written together. A row under an ordering operator in ANY / ALL is
   * Postgres's row comparison of each output row (`rowQuantified`): the engine compares a row as a struct.
   */
  private sublinkCompared(b: Body): AstNode | null {
    const test = b.testexpr as AstNode;
    const row = kindOf(test) === "RowExpr";
    const lefts = row ? ((bodyOf(test).args ?? []) as AstNode[]) : [test];
    const ops = this.allAt(b, ["OPEXPR"]);
    // (a row's ROWCOMPAREEXPR is placed at the SubLink's offset, where a grouped first column's Var has none)
    const compare = row && lefts[0] !== undefined && ops.length !== lefts.length ? this.at(b, ["ROWCOMPAREEXPR"]) ?? this.rowCompareAt(lefts[0]) : null;
    let types: Array<[number | null, number | null]> | null = null;
    let outputs: Array<{ type: number; typmod: number } | null> = [];
    if (ops.length === lefts.length) {
      types = ops.map((t) => [t.args[0]?.type ?? null, t.args[1]?.type ?? null]);
      outputs = ops.map((t) => t.params?.[1] ?? null);
    } else if (compare?.inputTypes !== undefined && compare.inputTypes.length === lefts.length) {
      types = compare.inputTypes.map((t) => [t, t]);
      outputs = lefts.map((_, i) => compare.params?.[i] ?? null);
    }
    if (types === null || !isNode(b.subselect)) return null;
    const pairs = types;
    const alias = `${this.cellPrefix}o${this.sublinkOutputs++}`;
    const column = (i: number): AstNode => ({ ColumnRef: { fields: [S(alias), S(`c${i + 1}`)] } });
    const refs = outputs.map((p, i) => {
      if (p === null) return null;
      const ref = column(i);
      this.synthetic.set(bodyOf(ref), { node: "VAR", type: p.type, typmod: p.typmod, args: [], oid: null, format: null, collation: 0, inputCollation: 0, levelsUp: 0, datum: null, qualifier: null, renamed: null });
      this.original.add(bodyOf(ref));
      return ref;
    });
    const wrap = (targets: AstNode[]): AstNode => ({ SelectStmt: {
      targetList: targets.map((v) => ({ ResTarget: { val: v } })),
      fromClause: [{ RangeSubselect: { subquery: b.subselect, alias: { aliasname: alias, colnames: lefts.map((_, i) => S(`c${i + 1}`)) } } }],
      limitOption: "LIMIT_OPTION_DEFAULT", op: "SETOP_NONE",
    } });
    const name = names(b.operName ?? []).at(-1) ?? "=";
    const sorts = ["<", "<=", ">", ">="].includes(name);
    // (a row's <> ANY too, which the engine, filtering by it, answers true for a NULL member: `<> ALL` is NOT IN, and
    // `=` IN, each a join the engine answers as Postgres does)
    const ordering = compare !== null && sorts && (b.subLinkType === "ANY_SUBLINK" || b.subLinkType === "ALL_SUBLINK");
    const rowWise = ordering || (row && name === "<>" && b.subLinkType === "ANY_SUBLINK");
    // A CITEXT PAIR IN A COMPARISON THIS REWRITE WRITES PAIR BY PAIR (PR 674 shrink 1, the class citext compared by bytes
    // in a quantified subquery): Postgres compares a citext without regard to case (citext_eq, citext_cmp), and the
    // pairs here are written by `orderedOperand` and `rowQuantified`, which compare its bytes. Decided here, where every
    // pair's argument types are read (the OPEXPRs, the ROWCOMPAREEXPR), so every path below sees it: ALL of a subquery,
    // whatever its operator, and a row compared with each output row; refused by name, as a plain row's is (`rowCompared`)
    if ((b.subLinkType === "ALL_SUBLINK" || rowWise) && pairs.some(([l, r]) => this.holdsCitext(l) || this.holdsCitext(r))) {
      const what = `${row ? "a row holding a citext" : pairs.some(([l, r]) => this.isCitext(l) || this.isCitext(r)) ? "a citext" : "a value holding a citext (an array of one, or of a domain over one)"} compared by ${name} ${b.subLinkType === "ALL_SUBLINK" ? "ALL" : "ANY"} of a subquery`;
      throw new Unrewritable(`${what} is not supported by Mason (Postgres compares the citext without regard to case)`, "compare lower() of each side: lower(x) < ALL (SELECT lower(y) …)", "citext-forms");
    }
    // AN ORDERING OF TEXT UNDER ITS COLLATION (PR 674 CI fix 1): each pair's collation the one Postgres compared it under
    // (the OPEXPR's inputcollid, the ROWCOMPAREEXPR's inputcollids); both operands of a text pair under one that is not
    // byte order written as its key (`orderedOperand`), as a plain comparison's are (`compareText`, `rowCompared`)
    const colls: Array<DuckCollation | null> = !sorts ? lefts.map(() => null) : ops.length === lefts.length
      ? ops.map((t) => this.inputCollationOf(t))
      : lefts.map((_, i) => { const o = compare?.inputCollations?.[i] ?? 0; return o === 0 ? null : this.collations.resolve(o); });
    if (sorts && compare !== null && compare.inputCollations === undefined && pairs.some(([t]) => TEXTS.has(t ?? -1))) {
      throw new Unrewritable(`Mason could not read the collations of this row comparison (${name})`, "compare the columns one by one", "collation-unknown");
    }
    const side = (n: AstNode, i: number, own: 0 | 1): AstNode => this.orderedOperand(n, pairs[i]![own], pairs[i]![own === 0 ? 1 : 0], colls[i] ?? null);
    if (rowWise) {
      if (refs.some((r) => r === null)) return null;
      return this.rowQuantified(name, b.subLinkType === "ALL_SUBLINK", lefts, refs as AstNode[], side, wrap);
    }
    // each pair written together: an output that cannot be typed leaves its pair as written
    const rights = refs.map((r, i) => r === null ? null : side(r, i, 1));
    const written = lefts.map((x, i) => rights[i] === null ? x : side(x, i, 0));
    if (row) bodyOf(test).args = written; else b.testexpr = written[0];
    if (rights.some((r, i) => r !== null && r !== refs[i])) b.subselect = wrap(rights.map((r, i) => r ?? column(i)));
    return null;
  }
  private sublinkOutputs = 0;

  /** one operand of an ordering comparison as Postgres resolved it: `compared`, and under a collation that is not byte
   *  order a text pair's key (`textKey`, its char(n) without its padding), so the engine's byte order is the collation's
   *  and equal keys are equal values; `own` and `other` the pair's argument types, `c` the comparison's collation */
  private orderedOperand(n: AstNode, own: number | null, other: number | null, c: DuckCollation | null): AstNode {
    if (c === null || c.kind === "bytes" || !TEXTS.has(own ?? -1)) return this.compared(n, own, other, true);
    const padded = own === BPCHAR && other === BPCHAR;
    return this.textKey(padded ? n : this.widen(n, own), c, padded, null);
  }

  /**
   * A ROW COMPARED BY AN ORDERING OPERATOR WITH ANY / ALL OF A SUBQUERY, OR BY <> WITH ANY, AS POSTGRES COMPARES IT (PR
   * 674 class round r3): each output row's comparison is Postgres's row comparison, its pairs read left to right, the
   * first pair holding a NULL making it NULL and the first unequal pair deciding it (all equal: true for <= and >=);
   * for <>, any pair unequal and neither NULL is true, else a NULL is NULL. The engine compares a
   * row as a struct, a NULL member ordered rather than NULL. The subquery's rows are read as ONE list of their written
   * outputs (`list(ROW(…))`), and each is compared OUTSIDE the subquery, by a lambda over the list, with the test as the
   * outer query reads it: a test column read inside the subquery is an outer reference, which the engine binds to the
   * select list's alias of a grouped column and refuses (42803). Each row's answer is 2 (true), 1 (NULL) or 0 (false),
   * and ANY is the greatest of them (none, a NULL list: false), ALL the least (none: true); each pair's operands
   * written by `compared`, the test's copied for each use.
   */
  private rowQuantified(name: string, all: boolean, lefts: AstNode[], refs: AstNode[], side: (n: AstNode, i: number, own: 0 | 1) => AstNode, wrap: (targets: AstNode[]) => AstNode): AstNode {
    // (all pairs equal: true for <= and >=, false for <, > and <>)
    const strict = name === "<" || name === ">" || name === "<>";
    const less = name === "<" || name === "<=" ? "<" : ">";
    const listed = { SubLink: { subLinkType: "EXPR_SUBLINK", subselect: wrap([fn("list", [row(refs.map((r, i) => side(r, i, 1)))])]) } };
    // (a lambda's parameter, the rewrite's own name: never the cells' prefix, which a GROUP BY reads per group)
    const param = `__mason_r${this.sublinkOutputs++}`;
    const arms: Array<[AstNode, AstNode]> = [];
    const left = (i: number): AstNode => side(this.clone(lefts[i]!), i, 0);
    const right = (i: number): AstNode => fn("struct_extract", [{ ColumnRef: { fields: [S(param)] } }, intConst(i + 1)]);
    if (name === "<>") {
      // Postgres's row <>: any pair unequal (neither NULL) is true, else any NULL is NULL, else false
      lefts.forEach((_, i) => arms.push([op("<>", left(i), right(i)), intConst(2)]));
      arms.push([or(lefts.flatMap((_, i) => [isNull(left(i)), isNull(right(i))])), intConst(1)]);
    } else lefts.forEach((_, i) => {
      arms.push([or([isNull(left(i)), isNull(right(i))]), intConst(1)]);
      arms.push([op("<>", left(i), right(i)), caseWhen([[op(less, left(i), right(i)), intConst(2)]], intConst(0))]);
    });
    const each = fn("list_transform", [listed, op("->", { ColumnRef: { fields: [S(param)] } }, caseWhen(arms, intConst(strict ? 0 : 2)))]);
    const answers: Array<[number, AstNode]> = all ? [[0, boolConst(false)], [1, nullConst()]] : [[2, boolConst(true)], [1, nullConst()]];
    return { CaseExpr: { arg: fn(all ? "list_min" : "list_max", [each]), args: answers.map(([v, r]) => ({ CaseWhen: { expr: intConst(v), result: r } })), defresult: boolConst(all) } };
  }

  private rowCompareAt(first: AstNode): Typed | null {
    const own = bodyOf(first);
    const at = typeof own.location === "number" ? own.location : kindOf(first) === "TypeCast" && isNode(own.arg) ? bodyOf(own.arg as AstNode).location : undefined;
    return typeof at === "number" ? (this.types.get(at - this.base) ?? []).find((t) => t.node === "ROWCOMPAREEXPR") ?? null : null;
  }

  /** a text value's key under a collation that is not byte order, as ONE text that orders as Postgres does and ends in
   *  the value's own bytes (`icuKey`, `libcKey`). A char(n) is ordered without its padding (bpcharcmp: `'b   '` is `'b'`,
   *  which an ICU key, whose spaces weigh, would put after `'B'`), then its trimmed bytes, then `tie` (what decides
   *  between two equal char(n) values of another padding), and its value whole, read back from the last bytes; `tie`
   *  null where the key is only compared, never read back (a row comparison), so equal char(n) values have equal keys.
   *  `padded`: the comparison is of char(n), as the CALLER read it from Postgres's analysis of the comparison, never
   *  this value's own type (two sides of one comparison keyed in two shapes never compare equal) */
  private textKey(a: AstNode, c: DuckCollation, padded: boolean, tie: string | null): AstNode {
    const v = strip(a);
    if (!padded) {
      if (c.kind === "bytes") throw new Error("a text key under byte order is the value itself: only a char(n) is keyed (minMax)");
      return c.kind === "libc" ? libcKey(this.cp, v, c.collate) : icuKey(this.cp, v, c.name);
    }
    const trimmed = (): AstNode => fn("rtrim", [this.cp(v)]);
    // (under byte order the trimmed bytes are the order: their hex, a fixed two characters a byte, orders as they do)
    const key = c.kind === "bytes" ? strConst("") : c.kind === "libc" ? fn("__mason_libc_key", [trimmed(), strConst(c.collate)]) : fn("icu_sort_key", [trimmed(), strConst(c.name)]);
    // (compared, never read back: two char(n) values of another padding are EQUAL, so the key ends at the trimmed bytes)
    if (tie === null) return concat(key, strConst(" "), fn("hex", [trimmed()]));
    return concat(key, strConst(" "), fn("hex", [trimmed()]), strConst(` ${tie} `), fn("hex", [v]));
  }

  private minMax(b: Body): AstNode | null {
    // GREATEST / LEAST of text compare under the collation
    const t = this.at(b, ["MINMAXEXPR"]);
    if (t !== null && (t.type === JSONB || t.type === JSONB_ARRAY)) {
      throw new Unrewritable(`${b.op === "IS_LEAST" ? "LEAST" : "GREATEST"} of jsonb values is not supported by Mason (Postgres orders jsonb by its own rules)`, "ORDER BY the value … LIMIT 1 in a subquery", "jsonb-compare");
    }
    if (t !== null) b.args = (b.args as AstNode[]).map((a, i) => this.widen(a, t.args[i]?.type));
    // a timetz by its order (the instant, then the zone), as `<` and max() compare it: DuckDB's own GREATEST of two
    // timetz compares otherwise (23:59:59-05 below 23:59:59.999999+05:30, which Postgres has the other way round). A
    // list's greatest skips its NULLs, as GREATEST does
    if (t !== null && t.type === TIMETZ) return fn(b.op === "IS_LEAST" ? "list_min" : "list_max", [arrayOf(b.args as AstNode[])]);
    if (t === null || !TEXTS.has(t.type)) return null;
    // under the collation the GREATEST compared under (its inputcollid), never the database's whatever the arguments
    const c = this.inputCollationOf(t);
    // (under byte order a text's own order is the engine's; a char(n)'s is not: its padding is ignored, and of equal
    // values of another padding Postgres keeps the first argument, so it is keyed as under any other collation)
    if (c === null || (c.kind === "bytes" && t.type !== BPCHAR)) return null;
    // the greatest (least) of the values' keys, which end in the value's own bytes: the value is read back from them
    // (equal char(n) values of another padding: Postgres keeps the first argument, which `tie` makes the least, or
    // the greatest, of the equal keys)
    const args = b.args as AstNode[];
    const keys = args.map((a, i) => this.textKey(a, c, t.type === BPCHAR, String(b.op === "IS_LEAST" ? i : args.length - i).padStart(4, "0")));
    const best: AstNode = { MinMaxExpr: { ...b, args: keys } };
    this.done.add(bodyOf(best));
    return fn("decode", [fn("unhex", [fn("regexp_extract", [best, strConst("[^ ]*$")])])]);
  }

  // --------------------------------------------------------------------------------------------- operators

  private aExpr(b: Body): AstNode | null {
    const name = lastName(b.name);
    const t = this.typed({ A_Expr: b });
    let l = b.lexpr as AstNode | undefined, r = b.rexpr as AstNode | undefined;
    const args = t?.args ?? [];
    const a0 = args[0]?.type ?? null, a1 = args[1]?.type ?? null;
    // jsonb's jsonpath operators: Postgres's answer for each row (src/duck/pg-eval.ts)
    if (b.kind === "AEXPR_OP" && (name === "@?" || name === "@@") && a0 === JSONB && l !== undefined && r !== undefined) return pgCall("bool", `a1::jsonb ${name} a2::jsonpath`, [l, r]);
    // x = ANY (ARRAY(SELECT …)): DuckDB binds the array's subquery as a comparison of its own and refuses the types
    if ((b.kind === "AEXPR_OP_ANY" || b.kind === "AEXPR_OP_ALL") && r !== undefined && kindOf(r) === "SubLink" && bodyOf(r).subLinkType === "ARRAY_SUBLINK") {
      throw new Unrewritable(`${b.kind === "AEXPR_OP_ANY" ? "ANY" : "ALL"} of ARRAY(SELECT …) is not supported by Mason`, `x ${name} ${b.kind === "AEXPR_OP_ANY" ? "ANY" : "ALL"} (SELECT …), without the ARRAY`, "array-subquery-element");
    }
    if ((b.kind === "AEXPR_OP_ANY" || b.kind === "AEXPR_OP_ALL") && this.isCitext(a0)) {
      throw new Unrewritable("a citext compared with ANY or ALL of an array is not supported by Mason", "x IN (…) with the values written out, or lower(x) = ANY (…)", "citext-forms");
    }
    // A JSONB COMPARED (jsonb's =, <>, <, … and its btree's order: src/duck/jsonb-order.ts), each side as its order key
    // (an operand of a jsonb operator is a jsonb, a literal included: each is keyed, whatever its own analysis says)
    const lType = l === undefined ? null : this.typeOf(l);
    const comparing = ["=", "<>", "!=", "<", "<=", ">", ">="].includes(name);
    // a numeric parameter compared with values the engine holds exactly: natively in their own type where it holds the
    // bound value, else by exact keys — never the parameter's double (issue 214)
    const viaParameter = this.numericParamComparison(b);
    if (viaParameter !== null) return viaParameter;
    // a numeric decided exactly, compared for equality: by its exact key, the other side by its own (exactKey)
    if (b.kind === "AEXPR_OP" && (name === "=" || name === "<>" || name === "!=") && a0 === NUMERIC && a1 === NUMERIC && l !== undefined && r !== undefined) {
      const sides = this.exactEquality(l, r);
      if (sides !== null) { [b.lexpr, b.rexpr] = sides; return null; }
    }
    // and IN a list of values (issue 350: each item an equality, Postgres's `=` of each): every side by its exact key
    if (b.kind === "AEXPR_IN" && l !== undefined && r !== undefined && kindOf(r) === "List" && this.typeOf(l) === NUMERIC) {
      const items = (bodyOf(r).items ?? []) as AstNode[];
      if (items.every((x) => this.typeOf(x) === NUMERIC || (this.typeOf(x) !== null && INTEGERS.has(this.typeOf(x)!)))) {
        const keys = [l, ...items].map((x) => ({ x, k: this.exactKey(x) }));
        if (keys.some(({ x, k }) => k !== null && kindOf(stripCasts(x)) !== "ParamRef")) {
          const sides = keys.map(({ x, k }) => k ?? (this.duckExact(x) ? fn("__mason_numeric_key", [cast(x, ["varchar"])]) : null));
          if (sides.every((s) => s !== null)) return { A_Expr: { ...b, lexpr: sides[0]!, rexpr: { List: { items: sides.slice(1) } } } };
        }
      }
    }
    // a numeric's text decided exactly (`(x / 3)::text`), compared for equality: by the program's text (text's equality
    // is its bytes', under any deterministic collation)
    if (b.kind === "AEXPR_OP" && (name === "=" || name === "<>" || name === "!=") && a0 !== null && a1 !== null && TEXTS.has(a0) && TEXTS.has(a1) && l !== undefined && r !== undefined) {
      const tl = this.exactNumericText(l), tr = this.exactNumericText(r);
      if (tl !== null) b.lexpr = tl;
      if (tr !== null) b.rexpr = tr;
      if (tl !== null || tr !== null) return null;
    }
    // rows compared member by member (`(id, j) = (1, '…')`: Postgres's per-member operators; a struct to DuckDB,
    // compared by its text)
    if ((l !== undefined && this.rowHoldsJsonb(l)) || (r !== undefined && this.rowHoldsJsonb(r))) {
      throw new Unrewritable("a row holding a jsonb compared with another is not supported by Mason (Postgres compares the jsonb by its own rules)", "compare the members one by one: a = x AND j = y", "jsonb-compare");
    }
    // a jsonb array's containment and overlap compare its elements by jsonb's equality, DuckDB's list operators by text
    if (b.kind === "AEXPR_OP" && ["@>", "<@", "&&"].includes(name) && (a0 === JSONB_ARRAY || a1 === JSONB_ARRAY)) {
      throw new Unrewritable(`a jsonb array's ${name} is not supported by Mason (Postgres compares its elements by jsonb's equality)`, "compare an element: a[1] = '…'::jsonb, or a::text", "jsonb-compare");
    }
    // a jsonb's containment with ANY / ALL of an array written out: each element's containment, OR'd (ALL: AND'd), as
    // SQL's three values are ANY's and ALL's (DuckDB has no `@> ANY`)
    if ((b.kind === "AEXPR_OP_ANY" || b.kind === "AEXPR_OP_ALL") && (name === "@>" || name === "<@") && (a0 === JSONB || lType === JSONB) && l !== undefined && r !== undefined) {
      if (kindOf(r) !== "A_ArrayExpr" || ((bodyOf(r).elements ?? []) as AstNode[]).length === 0) {
        throw new Unrewritable(`a jsonb's ${name} with ${b.kind === "AEXPR_OP_ANY" ? "ANY" : "ALL"} of an array that is not written out is not supported by Mason`, `write the values out: j ${name} '…' OR j ${name} '…'`, "jsonb-compare");
      }
      const each = ((bodyOf(r).elements ?? []) as AstNode[]).map((e, i) => {
        const x: AstNode = i === 0 ? l! : this.clone(l!);
        return name === "@>" ? fn("__mason_jsonb_contains", [jsonArg(x), jsonArg(e)]) : fn("__mason_jsonb_contains", [jsonArg(e), jsonArg(x)]);
      });
      return b.kind === "AEXPR_OP_ANY" ? or(each) : and(each);
    }
    // an operator's ANY / ALL compares only for a comparison (`j @> ANY (…)` is containment, above)
    const compares = b.kind === "AEXPR_OP" || b.kind === "AEXPR_OP_ANY" || b.kind === "AEXPR_OP_ALL" ? comparing : true;
    if (l !== undefined && r !== undefined && (a0 === JSONB || a0 === JSONB_ARRAY || lType === JSONB || lType === JSONB_ARRAY) && compares) {
      const what = `comparing (${b.kind === "AEXPR_OP" ? name : b.kind.replace("AEXPR_", "").replace(/_/g, " ").toLowerCase()})`;
      if (a0 === JSONB_ARRAY || lType === JSONB_ARRAY) this.comparable(l, what);
      // equality by the equality key (no collation: equalKey), an order by the collation's
      const equating = ["=", "<>", "!="].includes(name) || ["AEXPR_DISTINCT", "AEXPR_NOT_DISTINCT", "AEXPR_NULLIF"].includes(String(b.kind));
      const key = (x: AstNode): AstNode => equating ? this.equalKey(x) : this.jsonbKey(x);
      switch (b.kind) {
        case "AEXPR_OP": return op(name, key(l), key(r));
        case "AEXPR_DISTINCT": case "AEXPR_NOT_DISTINCT": return { A_Expr: { ...b, lexpr: key(l), rexpr: key(r) } };
        // NULLIF(a, b): NULL where a = b, else a (the value, never its key)
        case "AEXPR_NULLIF": return caseWhen([[op("=", key(l), key(r)), nullConst()]], this.clone(l));
        case "AEXPR_IN":
          if (kindOf(r) === "List") return { A_Expr: { ...b, lexpr: key(l), rexpr: { List: { items: ((bodyOf(r).items ?? []) as AstNode[]).map(key) } } } };
          break;
        case "AEXPR_OP_ANY": case "AEXPR_OP_ALL":
          if (kindOf(r) === "A_ArrayExpr" && comparing) return { A_Expr: { ...b, lexpr: key(l), rexpr: { A_ArrayExpr: { ...bodyOf(r), elements: ((bodyOf(r).elements ?? []) as AstNode[]).map(key) } } } };
          throw new Unrewritable(`a jsonb compared with ${b.kind === "AEXPR_OP_ANY" ? "ANY" : "ALL"} of an array that is not written out is not supported by Mason`, "write the values out: x IN ('…'::jsonb, …), or ARRAY['…'::jsonb, …]", "jsonb-compare");
        case "AEXPR_BETWEEN": case "AEXPR_NOT_BETWEEN": {
          const [lo, hi] = (bodyOf(r).items ?? []) as AstNode[];
          if (lo === undefined || hi === undefined) break;
          const inside = and([op(">=", key(l), key(lo)), op("<=", key(this.clone(l)), key(hi))]);
          return b.kind === "AEXPR_NOT_BETWEEN" ? not(inside) : inside;
        }
        default: break;
      }
      throw new Unrewritable(`${what} a jsonb value is not supported by Mason (Postgres orders and equates jsonb by its own rules)`, JSONB_WAY_OUT, "jsonb-compare");
    }
    switch (b.kind) {
      case "AEXPR_LIKE": case "AEXPR_ILIKE": {
        // DuckDB's LIKE has no escape character unless asked; Postgres's is the backslash
        const negated = name.startsWith("!");
        // a citext's LIKE is case-insensitive (texticlike)
        const ilike = b.kind === "AEXPR_ILIKE" || this.isCitext(a0);
        let pattern = r!, escape: AstNode = strConst("\\");
        if (kindOf(pattern) === "FuncCall" && lastName(bodyOf(pattern).funcname) === "like_escape") {
          const a = bodyOf(pattern).args as AstNode[];
          pattern = a[0]!; escape = a[1]!;
        }
        const call = fn(ilike ? "ilike_escape" : "like_escape", [l!, pattern, escape]);
        return negated ? not(call) : call;
      }
      case "AEXPR_BETWEEN": case "AEXPR_NOT_BETWEEN": {
        const bounds = (bodyOf(r!).items ?? []) as AstNode[];
        // numbers of which one is a float are compared as double precision (float8 is Postgres's preferred numeric
        // type: `real BETWEEN 0.1 AND 1` is float48ge and float8le), where DuckDB's common type is single precision
        const own = [l!, ...bounds].map((x) => this.typeOf(x));
        if (own.some((x) => x !== null && FLOATS.has(x)) && own.every((x) => x !== null && NUMBER_TYPES.has(x)) && new Set(own).size > 1) {
          b.lexpr = cast(l!, ["double"]);
          bodyOf(r!).items = bounds.map((x) => cast(x, ["double"]));
          return null;
        }
        // Postgres splits it into two comparisons at its offset (`a >= b AND a <= c`; NOT: `a < b OR a > c`), each under
        // its own collation (a COLLATE on one bound is that comparison's alone)
        const compared = typeof b.location === "number" ? (this.types.get(b.location - this.base) ?? []).filter((x) => x.node === "OPEXPR") : [];
        const textual = own.some((x) => x !== null && TEXTS.has(x));
        if (textual && compared.length !== 2) throw new Unrewritable("Mason could not read the collations of this BETWEEN", "write the two comparisons: a >= b AND a <= c", "collation-unknown");
        const [c1, c2] = textual ? [this.inputCollationOf(compared[0]!), this.inputCollationOf(compared[1]!)] : [null, null];
        // char(n): compared without the padding
        const trim = (x: AstNode): AstNode => this.typeOf(x) === BPCHAR ? fn("rtrim", [x]) : x;
        if ((c1 === null || c1.kind === "bytes") && (c2 === null || c2.kind === "bytes")) {
          if (own.includes(BPCHAR)) { b.lexpr = trim(l!); bodyOf(r!).items = bounds.map(trim); }
          return null;
        }
        const bytes: DuckCollation = { kind: "bytes" };
        const inside = and([this.compareText(">=", trim(l!), trim(bounds[0]!), c1 ?? bytes), this.compareText("<=", trim(this.clone(l!)), trim(bounds[1]!), c2 ?? bytes)]);
        return b.kind === "AEXPR_NOT_BETWEEN" ? not(inside) : inside;
      }
      case "AEXPR_OP_ANY": case "AEXPR_OP_ALL": {
        // x LIKE ANY (patterns): each pattern's LIKE, OR'd (ALL: AND'd) — SQL's three values are ANY's and ALL's
        const like = { "~~": ["like_escape", false], "~~*": ["ilike_escape", false], "!~~": ["like_escape", true], "!~~*": ["ilike_escape", true] }[name];
        if (like === undefined) {
          // DuckDB reads a NULL array as an empty one (ANY false, ALL true), where Postgres's answer is NULL; with a NULL
          // element or a NULL operand it answers as Postgres does. An array written out is never NULL
          if (r === undefined || kindOf(r) === "A_ArrayExpr" || constString(r) !== null || this.nullArrayTested.has(b)) return null;
          this.nullArrayTested.add(b);
          return caseWhen([[isNull(this.clone(r)), nullConst()]], { A_Expr: b });
        }
        const literal = constString(r);
        const patterns: AstNode[] | null = r !== undefined && kindOf(r) === "A_ArrayExpr" ? (bodyOf(r).elements ?? []) as AstNode[]
          : literal !== null ? arrayLiteral(literal).map((p) => p === null ? nullConst() : strConst(p)) : null;
        if (patterns === null) throw new Unrewritable(`${like[0] === "like_escape" ? "LIKE" : "ILIKE"} ${b.kind === "AEXPR_OP_ANY" ? "ANY" : "ALL"} over an array that is not written out is not supported by Mason`, "write the patterns as ARRAY['…', '…'], or OR the LIKEs", "like-any-array");
        const each = patterns.map((p, i) => { const m = fn(like[0] as string, [i === 0 ? l! : this.clone(l!), p, strConst("\\")]); return like[1] ? not(m) : m; });
        if (each.length === 0) return boolConst(b.kind === "AEXPR_OP_ALL");
        return b.kind === "AEXPR_OP_ANY" ? or(each) : and(each);
      }
      case "AEXPR_SIMILAR": {
        const call = bodyOf(r!);
        const a = (call.args ?? []) as AstNode[];
        const pattern = constString(a[0]), escape = a[1] === undefined ? "\\" : constString(a[1]);
        if (pattern === null || escape === null) throw new Unrewritable("SIMILAR TO with a pattern or an ESCAPE that is not a literal is not supported by Mason", "write the pattern as a string literal, or use ~ with a POSIX regular expression", "similar-to-forms");
        const m = fn("regexp_full_match", [l!, strConst(`(?s)${similarToRe2(pattern, escape)}`)]);
        return name.startsWith("!") ? not(m) : m;
      }
      case "AEXPR_OP": break;
      case "AEXPR_IN": {
        // `x IN (a, b)` is x = ANY (ARRAY[a, b]) over the type Postgres chose for both
        const want = t?.args[0]?.type ?? null, element = t?.args[1]?.type !== undefined ? NUMBER_ELEMENT[t.args[1].type] ?? null : null;
        // a citext IN a list: each side lower-cased (citext_eq)
        if (this.isCitext(want) && l !== undefined && r !== undefined && kindOf(r) === "List") {
          b.lexpr = this.foldCitext(l);
          bodyOf(r).items = ((bodyOf(r).items ?? []) as AstNode[]).map((x) => this.foldCitext(x));
          return null;
        }
        if (l !== undefined) this.comparable(l, "IN");
        if (want === BPCHAR && l !== undefined && r !== undefined && kindOf(r) === "List") {
          b.lexpr = this.compared(l, BPCHAR, BPCHAR, true);
          bodyOf(r).items = ((bodyOf(r).items ?? []) as AstNode[]).map((x) => this.compared(x, BPCHAR, BPCHAR, true));
          return null;
        }
        if (l !== undefined) b.lexpr = this.widen(l, want);
        if (r !== undefined && kindOf(r) === "List") bodyOf(r).items = ((bodyOf(r).items ?? []) as AstNode[]).map((x) => this.widen(x, element) as AstNode);
        return null;
      }
      default: return null;
    }
    const comparison = ["=", "<>", "!=", "<", "<=", ">", ">="].includes(name);
    // a citext beside a citext: compared lower-cased (citext_eq, citext_cmp); beside a text, Postgres's text operator
    // compares the text as it is, and so does this
    // (into l and r: what follows widens and pads THEM, and would put the column back)
    if (comparison && this.isCitext(a0) && this.isCitext(a1) && l !== undefined && r !== undefined) { l = b.lexpr = this.foldCitext(l); r = b.rexpr = this.foldCitext(r); }
    if (comparison && name !== "=" && name !== "<>" && name !== "!=" && (a0 === INET || a1 === INET)) {
      throw new Unrewritable(`comparing (${name}) inet values is not supported by Mason (Postgres orders addresses by network, then host)`, "compare them for equality, or compare host(x)::text", "inet-order");
    }
    // each operand as the type of the operator Postgres chose (`real / smallint` is float8's division, `real = 0.1`
    // float8's comparison): DuckDB would compute in its own common type (single precision, for those)
    // (the one writer of a comparison's operands as Postgres resolved it, `compared`: a SubLink's too)
    // (rtrim of both decided by the argument types alone: every operator over two char(n) ignores their trailing blanks)
    const both = l !== undefined && r !== undefined;
    if (l !== undefined) b.lexpr = this.compared(l, a0, a1, both);
    if (r !== undefined) b.rexpr = this.compared(r, l === undefined ? a0 : a1, a0, both);
    if (comparison && b.lexpr !== undefined) this.comparable(b.lexpr as AstNode, `comparing (${name})`);
    switch (name) {
      case "/": {
        if (l === undefined || r === undefined) return null;
        if (a0 !== null && a1 !== null && INTEGERS.has(a0) && INTEGERS.has(a1)) return op("//", b.lexpr as AstNode, b.rexpr as AstNode);
        // a numeric quotient is Postgres's, rounded at its scale (numeric_div), so equal quotients are one value where
        // DuckDB's double division gives each its own last bits; the client's text is the exact program's
        if (a0 === NUMERIC && a1 === NUMERIC) return fn("__mason_numeric_div", [cast(b.lexpr as AstNode, ["varchar"]), cast(b.rexpr as AstNode, ["varchar"])]);
        // a float division by zero is Postgres's error, where DuckDB answers Infinity or NULL
        return op("/", b.lexpr as AstNode, nonZero(this.cp, b.rexpr as AstNode));
      }
      case "%": return null;
      case "#": return a0 !== null && INTEGERS.has(a0) && l !== undefined && r !== undefined ? fn("xor", [b.lexpr as AstNode, b.rexpr as AstNode]) : null;
      case "<<": case ">>": {
        // C's shift, as Postgres does it: the count masked to the word (31 for a smallint promoted to int, 63 for a
        // bigint), a left shift wrapping to the type's width. DuckDB refuses to left-shift a negative number
        if (a0 === null || !INTEGERS.has(a0) || l === undefined || r === undefined) return null;
        const count = op("&", b.rexpr as AstNode, intConst(a0 === INT8 ? 63 : 31));
        const type = a0 === INT8 ? "bigint" : a0 === INT4 ? "integer" : "smallint";
        if (name === ">>") return cast(op(">>", b.lexpr as AstNode, count), [type]);
        const bits = a0 === INT8 ? 64 : a0 === INT4 ? 32 : 16;
        const huge = (v: bigint): AstNode => cast(strConst(String(v)), ["hugeint"]);
        const product = op("*", cast(b.lexpr as AstNode, ["hugeint"]), op("<<", huge(1n), count));
        const half = huge(1n << BigInt(bits - 1)), whole = huge(1n << BigInt(bits));
        return cast(op("-", op("%", op("+", op("%", op("+", product, half), whole), whole), whole), half), [type]);
      }
      case "*": {
        // a numeric product is exact to 38 digits in Postgres; DuckDB multiplies two narrow DECIMALs in 18
        if (t?.type !== NUMERIC || l === undefined || r === undefined) return null;
        // (as the one writer of a cast to numeric writes numeric(38, s), `numericCastWrite`: a scale DuckDB's DECIMAL cannot
        // hold is no DECIMAL, and the operand stays as it is written — PR 207's fifth round, a second writer)
        const wide = (x: AstNode): AstNode => {
          const m = this.typed(x)?.typmod ?? -1;
          if (m < 4 || this.typeOf(x) !== NUMERIC) return x;
          const w = numericCastWrite([intConst(38), intConst((m - 4) & 0xffff)], NUMERIC, null);
          return w.as === "decimal" ? cast(x, ["decimal", String(w.precision), String(w.scale)]) : x;
        };
        b.lexpr = wide(b.lexpr as AstNode); b.rexpr = wide(b.rexpr as AstNode);
        return null;
      }
      case "-": {
        if (a0 === JSONB && l !== undefined && r !== undefined) {
          if (a1 !== null && TEXTS.has(a1)) return fn("__mason_jsonb_delete", [jsonArg(l), r]);
          throw new Unrewritable("jsonb - of a text array or an index is not supported by Mason", "build the value with jsonb_build_object", "jsonb-set");
        }
        // a date minus a date is Postgres's integer (date_mi), DuckDB's BIGINT: a date plus it has no DuckDB function
        if (a0 === DATE && a1 === DATE && l !== undefined && r !== undefined) return cast(op("-", b.lexpr as AstNode, b.rexpr as AstNode), ["integer"]);
        // a time minus a time: as timestamps of one day (DuckDB has no TIME - TIME)
        if (a0 === TIME && a1 === TIME && l !== undefined && r !== undefined) return op("-", op("+", cast(strConst("2000-01-01"), ["date"]), l), op("+", cast(strConst("2000-01-01"), ["date"]), r));
        return null;
      }
      case "#-": throw new Unrewritable("jsonb #- is not supported by Mason", "build the value with jsonb_build_object", "jsonb-set");
      case "||": {
        if (t?.type === JSONB && l !== undefined && r !== undefined) return fn("__mason_jsonb_concat", [jsonArg(l), jsonArg(r)]);
        // text || a value (textanycat, anytextcat): the value's text is its output function's
        // an array and an element or another array: DuckDB's || joins two of one type only
        if (t !== null && ARRAYS.has(t.type) && l !== undefined && r !== undefined) {
          const la = a0 !== null && ARRAYS.has(a0), ra = a1 !== null && ARRAYS.has(a1);
          return la && ra ? caseWhen([[and([isNull(this.clone(l)), isNull(this.clone(r))]), nullConst()]], fn("list_concat", [l, r]))
            : la ? fn("list_append", [l, r]) : fn("list_prepend", [l, r]);
        }
        if (t === null || !TEXTS.has(t.type)) return null;
        // textanycat is `$1::text || $2`: the value's text is its cast's (`true`, where its output is `t`)
        if (l !== undefined && a0 !== null && !TEXTS.has(a0)) b.lexpr = this.pgText(l, a0, true) ?? l;
        if (r !== undefined && a1 !== null && !TEXTS.has(a1)) b.rexpr = this.pgText(r, a1, true) ?? r;
        return null;
      }
      case "~": case "~*": case "!~": case "!~*": {
        if (l === undefined || r === undefined) return null;
        const re = regexPattern(r);
        // a pattern RE2 would read otherwise (regexPattern): Postgres's engine, a chunk at a time
        if (re === null) return pgCall("bool", `a1 ${name} a2`, [l, r]);
        const call = fn("regexp_matches", [l, re, ...(name.endsWith("*") ? [strConst("i")] : [])]);
        return name.startsWith("!") ? not(call) : call;
      }
      case "#>": case "#>>": case "->": case "->>": {
        if (a0 === null || !JSONS.has(a0)) return null;
        // (a path bound as a parameter read as its value, guarded by it: folded)
        return this.folded(() => {
          const { base, steps, either, canonical } = this.jsonReadOf(name, l!, r!, a0, a1);
          // a stored column of the path where every row holds it (keptRead), else DuckDB's own read where it is
          // Postgres's, else the function (jsonGet)
          return this.jsonRead(base, steps, either, canonical, name.endsWith(">>"));
        });
      }
      case "@>": case "<@":
        if (a0 !== null && JSONS.has(a0)) {
          const [doc, template] = name === "@>" ? [l!, r!] : [r!, l!];
          return this.containsRead(doc, template) ?? fn("__mason_jsonb_contains", [jsonArg(doc), jsonArg(template)]);
        }
        if (a0 === null || ARRAY_DUCK[a0] === undefined && NUMBER_ELEMENT[a0] === undefined || l === undefined || r === undefined) return null;
        {
          // an array's NULL element is contained in nothing in Postgres ('{NULL,3}' <@ '{1,2,3}' is false); DuckDB
          // finds it contained
          const inner = name === "@>" ? b.rexpr as AstNode : b.lexpr as AstNode;
          return { BoolExpr: { boolop: "AND_EXPR", args: [{ A_Expr: { ...b } }, op("=", fn("list_count", [this.cp(inner)]), fn("len", [this.cp(inner)]))] } };
        }
      case "?": case "?|": case "?&": {
        if (a0 === null || !JSONS.has(a0)) return null;
        const f = { "?": "__mason_jsonb_exists", "?|": "__mason_jsonb_exists_any", "?&": "__mason_jsonb_exists_all" }[name];
        return fn(f, [jsonArg(l!), r!]);
      }
      case "<": case ">": case "<=": case ">=": {
        if (l === undefined || r === undefined) return null;
        // a row comparison: each column under its own collation (RowCompareExpr's inputcollids)
        if (kindOf(l) === "RowExpr" && kindOf(r) === "RowExpr") return this.rowCompared(name, l, r);
        // the operands as rewritten so far (a citext lower-cased to text sorts under the collation), compared under the
        // collation the operator was resolved under (its inputcollid): a COLLATE on either side, or neither's own
        const textual = [b.lexpr, b.rexpr].some((x) => isNode(x) && TEXTS.has(this.typeOf(x as AstNode) ?? -1));
        if (textual && t === null) throw new Unrewritable(`Mason could not read the collation of this ${name}`, "add COLLATE \"C\" for byte order", "collation-unknown");
        const c = textual ? this.inputCollationOf(t) : null;
        if (c === null || c.kind === "bytes") return null;
        // the operands as Postgres cast them (a char(n) beside a text is its text without the padding)
        return this.compareText(name, b.lexpr as AstNode, b.rexpr as AstNode, c);
      }
      default: return null;
    }
  }

  /**
   * A number as the numeric type Postgres resolved it to for its operator or function (an implicit cast Postgres
   * inserted, which the raw tree does not show): DuckDB chooses its own common type, single precision for `real` beside
   * a numeric, where Postgres widens to double precision. A numeric target is left to the exact programs.
   */
  private widen(n: AstNode, want: number | null | undefined): AstNode;
  private widen(n: AstNode | undefined, want: number | null | undefined): AstNode | undefined;
  private widen(n: AstNode | undefined, want: number | null | undefined): AstNode | undefined {
    if (n === undefined || want === null || want === undefined || this.widened.get(bodyOf(n)) === want) return n;
    const made = this.widenOnce(n, want);
    if (made !== n) this.widened.set(bodyOf(made), want);
    return made;
  }

  private widenOnce(n: AstNode, want: number): AstNode {
    if ((want === TEXT || want === VARCHAR) && this.typeOf(n) === BPCHAR) { const r = fn("rtrim", [n]); this.typedLike.set(bodyOf(r), n); return r; }
    // a date (or a timestamp) where Postgres chose a timestamptz's function, generate_series(date, date, interval)
    // among them: cast in the session's zone, as Postgres's implicit cast is (DuckDB would keep a timestamp)
    if (want === TIMESTAMPTZ || want === TIMESTAMP) {
      const own = this.typeOf(n);
      // a timestamptz Postgres chose is cast whatever the argument's own type reads as: an implicit cast of a constant
      // has no offset of its own, so a date literal can read as the timestamptz it became
      if (want === TIMESTAMPTZ) return own === TIMESTAMPTZ && kindOf(n) !== "TypeCast" && kindOf(n) !== "A_Const" ? n : cast(n, ["timestamptz"]);
      if (own === DATE) return cast(n, ["timestamp"]);
      return n;
    }
    if (want === NUMERIC || !NUMBER_TYPES.has(want)) return n;
    const own = this.typeOf(n);
    if (own === null || own === want || !NUMBER_TYPES.has(own)) return n;
    const type = duckTypeOf(want);
    return type === null ? n : cast(n, type);
  }

  /** a call kept as written: each argument as the type Postgres resolved it to (an ordered-set aggregate's sorted one) */
  private widenArgs(b: Body): void {
    const t = this.typed({ FuncCall: b });
    if (t === null) return;
    if (b.agg_within_group === true) {
      for (const [i, s] of ((b.agg_order ?? []) as AstNode[]).entries()) { const sb = bodyOf(s); if (isNode(sb.node)) sb.node = this.widen(sb.node, t.args[i]?.type); }
      return;
    }
    if (Array.isArray(b.args)) b.args = (b.args as AstNode[]).map((a, i) => this.widen(a, t.args[i]?.type));
  }

  // --------------------------------------------------------------------------------------------- functions

  /** a window's PARTITION BY: a jsonb by its order key (jsonb's equality), a jsonb array refused */
  private keyedPartition(w: Body | undefined): void {
    if (w !== undefined && Array.isArray(w.partitionClause)) w.partitionClause = (w.partitionClause as AstNode[]).map((p) => isNode(p) ? this.exactKey(p) ?? this.equated(p, "PARTITION BY") : p);
  }

  /**
   * LATEST(x ORDER BY k…): the x of the row the ORDER BY sorts last. Each key is sorted as an ORDER BY sorts it (`sortBy`:
   * a collation's keys, jsonb's order key, a char(n) trimmed, a citext folded, and its refusals). Every key ascending
   * with its NULLs last (Postgres's default) is arg_max_null over the keys as ONE row value — a row even of one key, as
   * arg_max_null skips a row whose key is NULL where Postgres sorts it last and it wins, and a row's NULL field sorts
   * after every value. Any other direction or NULLS, or a key a row cannot carry (an ICU collation, which a row's
   * comparison drops), is the engine's last(x ORDER BY …), its NULLs placed as written or by the session's
   * default_null_order, which is Postgres's (src/duck/store.ts). A tie is any of the tied rows, as Postgres's sort leaves
   * it. With no ORDER BY (or only constant keys) the row is whichever is read last, so it is refused, as is a window's.
   * DISTINCT may order only by x, so its last row's x is the last distinct x: it is dropped.
   */
  private latest(b: Body, args: AstNode[]): null {
    if (b.over !== undefined) throw new Unrewritable("latest() as a window function is not supported by Mason", "latest(x ORDER BY k, id) in a GROUP BY", "latest-order");
    if (!Array.isArray(b.agg_order) || args.length !== 1) {
      throw new Unrewritable("latest(x) needs an ORDER BY of its own that is not constant: the row it answers is the one that ORDER BY sorts last",
        "latest(x ORDER BY k, id), its keys ending in a unique column", "latest-order");
    }
    // a numeric the engine holds as a double (a quotient, an avg) would be answered with its digits: its operands are
    // each latest'd instead, which the way out says
    if (this.typeOf(args[0]!) === NUMERIC && !this.duckExact(args[0]!)) {
      throw new Unrewritable("latest() of a numeric quotient or average is not supported by Mason (Postgres answers its exact value, which the engine holds as a double)",
        "latest(a ORDER BY …) / latest(b ORDER BY …)", "latest-quotient");
    }
    delete b.agg_distinct;
    const sorted: AstNode[] = [];
    for (const s of b.agg_order as AstNode[]) {
      const sb = bodyOf(s);
      // each key's rule runs here, once: the walker skips it (`done`)
      this.done.add(sb);
      sorted.push(...(kindOf(s) === "SortBy" ? this.sortBy(sb, null, null) ?? [s] : [s]));
    }
    const lastIsGreatest = sorted.every((s) => kindOf(s) === "SortBy" && bodyOf(s).useOp === undefined && isNode(bodyOf(s).node)
      && ["SORTBY_DEFAULT", "SORTBY_ASC"].includes(bodyOf(s).sortby_dir as string) && ["SORTBY_NULLS_DEFAULT", "SORTBY_NULLS_LAST"].includes(bodyOf(s).sortby_nulls as string)
      && kindOf(bodyOf(s).node as AstNode) !== "CollateClause");
    if (lastIsGreatest) {
      b.funcname = [S("arg_max_null")];
      b.args = [args[0]!, row(sorted.map((s) => bodyOf(s).node as AstNode))];
      delete b.agg_order;
    } else {
      b.funcname = [S("last")];
      b.agg_order = sorted;
    }
    return null;
  }

  private funcCall(b: Body): AstNode | AstNode[] | null {
    const name = lastName(b.funcname);
    this.keyedPartition(b.over as Body | undefined);
    const t = this.typed({ FuncCall: b });
    const args = (b.args ?? []) as AstNode[];
    const argType = (i: number): number | null => t?.args[i]?.type ?? (args[i] !== undefined ? this.typeOf(args[i]!) : null);
    // a numeric bin: its integer in the engine's own arithmetic (`nativeBin`, issues 464, 465)
    const bin = this.nativeKeys.has(b) ? this.nativeBin({ FuncCall: b }) : null;
    if (bin !== null) return this.nativeBinWritten(bin, bin.e);
    // an array_agg whose elements no reader sees (its length, its bounds): the engine's list has as many, whatever their
    // type, so no element of it is refused (`elementsUnread`)
    if (ELEMENT_BLIND.has(name) && args[0] !== undefined && kindOf(args[0]) === "FuncCall" && lastName(bodyOf(args[0]).funcname) === "array_agg") this.elementsUnread.add(bodyOf(args[0]));
    // each argument as the type Postgres resolved it to (a real to a double precision, a char(n) to its text), before
    // any rule reads it; an aggregate's own ORDER BY of the same expression with it (DISTINCT needs them alike)
    if (b.agg_within_group !== true) {
      args.forEach((a, i) => {
        const w = this.widen(a, t?.args[i]?.type);
        if (w === a) return;
        args[i] = w;
        for (const s of (b.agg_order ?? []) as AstNode[]) if (isNode(bodyOf(s).node) && shapeOf(bodyOf(s).node as AstNode) === shapeOf(a)) bodyOf(s).node = this.widen(bodyOf(s).node as AstNode, t?.args[i]?.type);
      });
    }
    // an array of arrays is a multi-dimensional array, which DuckDB's lists are not
    if ((name === "array_agg" || name === "array_cat") && args[0] !== undefined && argType(0) !== null && ARRAYS.has(argType(0)!) && name === "array_agg") {
      throw new Unrewritable("array_agg of an array (a multi-dimensional array) is not supported by Mason", "array_agg the elements, or array_to_string the arrays first", "multidim-array");
    }
    // array_agg of a numeric the engine holds as a double whose program the plan has (issue 343): the engine's list is
    // of doubles (float8[], 15 digits), where Postgres answers numeric[] of exact elements
    // (one the engine holds as a DECIMAL at Postgres's scale, as main wrote it, `decimalAtFixedScale`, is answered as main
    // answered it; a round of a quotient is a double, whose text is not Postgres's: 40.0 for 40.00)
    if (name === "array_agg" && args[0] !== undefined && argType(0) === NUMERIC && !this.elementsUnread.has(b) && !this.duckExact(args[0]) && !this.decimalAtFixedScale(args[0]) && this.exactText(args[0]) !== null) {
      throw new Unrewritable("array_agg of a numeric quotient or average is not supported by Mason (Postgres answers numeric[] of the exact values, which the engine holds as doubles)", "array_agg of its text: array_agg((x / y)::text), or string_agg((x / y)::text, ',')", "array-subquery-element");
    }
    if ((name === "sum" || name === "avg") && argType(0) === INTERVAL) throw new Unrewritable(`${name}() of an interval is not supported by Mason`, "sum(extract(epoch FROM x)) for the seconds", "interval-aggregates");
    if (name === "sum" && this.typeOf(args[0] ?? { A_Const: {} }) === FLOAT4 && argType(0) === FLOAT4) throw new Unrewritable("sum() of a real is not supported by Mason (Postgres adds in single precision)", "sum(x::double precision)", "sum-real");
    // count(DISTINCT x) of a column unique on the source, over a FROM that repeats none of its table's rows: no value is
    // there twice, so it is count(x), its FILTER kept (src/duck/distinct-key.ts, `keyCounts`)
    if (b.agg_distinct === true && name === "count" && typeof b.location === "number" && this.keyCounts.has(b.location)) delete b.agg_distinct;
    // count(DISTINCT j) counts jsonb's equal values once: their keys, counted (another aggregate's DISTINCT would hand
    // the key itself to the aggregate)
    // count(DISTINCT q) of a numeric decided exactly counts its exact keys (exactKey); another aggregate's DISTINCT would
    // hand the key itself to the aggregate, and is refused
    const exactArg = b.agg_distinct === true && args[0] !== undefined && name === "count" && args.length === 1 ? this.exactKey(args[0]) : null;
    if (exactArg !== null) args[0] = exactArg;
    else if (b.agg_distinct === true && args[0] !== undefined && name === "count" && args.length === 1 && this.typeOf(args[0]) === JSONB) args[0] = this.equalKey(args[0]);
    else if (b.agg_distinct === true && args[0] !== undefined) { this.refuseExactEquality(args[0], `${name}(DISTINCT …) of`); this.comparable(args[0], `${name}(DISTINCT …) of`); }
    // a jsonb array searched for an element: jsonb's equality, where DuckDB's list functions compare the text
    if (["array_position", "array_positions", "array_remove", "array_replace"].includes(name) && args[0] !== undefined && this.typeOf(args[0]) === JSONB_ARRAY) {
      throw new Unrewritable(`${name}() of a jsonb array is not supported by Mason (Postgres compares its elements by jsonb's equality)`, "compare an element: a[1] = '…'::jsonb", "jsonb-compare");
    }
    // timetz(tm) (time_timetz, function 2047) in any spelling: the cast's rule
    if (t !== null && t.node === "FUNCEXPR" && t.oid === 2047 && args.length === 1) return this.timeAsTimetz(args[0]!);
    // a function-style cast (`date(x)`, `text(x)`, `numeric(x)`) is the cast
    if (t !== null && (t.node === "COERCEVIAIO" || t.node === "RELABELTYPE" || (t.node === "FUNCEXPR" && t.format !== null && t.format !== 0 && t.format !== 3)) && args.length === 1) {
      if (t.type === TEXT || t.type === VARCHAR) { const text = this.pgText(args[0]!, this.typeOf(args[0]!), true); if (text !== null) return text; }
      const type = duckTypeOf(t.type, t.typmod);
      if (type !== null && !(t.type === NUMERIC && t.typmod < 0)) return cast(args[0]!, type);
    }
    // A CONSTANT KEY of an aggregate's ORDER BY (the class, issue 134; src/duck/constant-key.ts): a key the analysis put
    // a Const orders nothing, and written as the bare literal the engine refuses it (42804, reported as 42803). It is no
    // key, and with none left no ORDER BY. An ordered-set aggregate's key is its VALUE, so it stays (`withinGroup`)
    // A key equal to an argument by the analysis (`array_agg(1.5::numeric ORDER BY '1.5'::numeric)`) is that argument:
    // resolved by the one resolver (`keysConstant`)
    if (b.agg_within_group !== true && Array.isArray(b.agg_order)) {
      const order = b.agg_order as AstNode[];
      const constant = this.keysConstant(order.map((s) => kindOf(s) === "SortBy" && isNode(bodyOf(s).node) ? bodyOf(s).node as AstNode : undefined), t?.keys, "sorted");
      b.agg_order = order.filter((s, i) => {
        const sb = bodyOf(s);
        return !(kindOf(s) === "SortBy" && sb.useOp === undefined && isNode(sb.node) && (constant[i] ?? this.typed(sb.node as AstNode)?.constant) === true);
      });
      if ((b.agg_order as AstNode[]).length === 0) delete b.agg_order;
    }
    // latest(x ORDER BY …), Mason's aggregate (src/api/postgres/catalog.ts LATEST_SQL): known by Postgres's analysis, an
    // aggregate or window function the catalog made (an OID past the built-ins), never by its name alone
    if (name === "latest" && t !== null && (t.node === "AGGREF" || t.node === "WINDOWFUNC") && (t.oid ?? 0) >= FIRST_USER_OID) return this.latest(b, args);
    // an aggregate over DISTINCT values sorts them to find the duplicates, so Postgres's string_agg / array_agg (DISTINCT)
    // lists them in that order (the argument's, under its collation); DuckDB's in any order. A constant argument is one
    // value, and would be a constant key (above)
    if (b.agg_distinct === true && b.agg_order === undefined && args[0] !== undefined && this.typed(args[0])?.constant !== true && ["string_agg", "array_agg", "json_agg", "jsonb_agg"].includes(name)) {
      b.agg_order = [{ SortBy: { node: this.clone(args[0]), sortby_dir: "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }];
      this.original.add(bodyOf((b.agg_order as AstNode[])[0]!));
    }
    if (b.agg_within_group === true) return this.withinGroup(name, b);
    switch (name) {
      case "every": b.funcname = [S("bool_and")]; return null;
      case "upper": case "lower": {
        if (args.length !== 1 || argType(0) === null || !TEXTS.has(argType(0)!)) return null;
        const m = this.caseMapping(t, name);
        // (glibc's lower is the engine's own: the call left as it is)
        return m === "libc" && name === "lower" ? null : this.caseCall(name, args[0]!, m);
      }
      case "initcap": return args.length === 1 ? this.caseCall("initcap", args[0]!, this.caseMapping(t, name)) : null;
      case "btrim": b.funcname = [S("trim")]; b.funcformat = "COERCE_EXPLICIT_CALL"; return null;
      case "to_hex":
        // an integer's two's complement in its own width, in lower case
        if (args.length === 1 && argType(0) === INT4) return fn("lower", [fn("to_hex", [op("&", cast(args[0]!, ["bigint"]), numConst("4294967295"))])]);
        return args.length === 1 ? fn("lower", [fn("to_hex", [args[0]!])]) : null;
      case "array_remove": {
        // by the elements' text (src/duck/functions.ts), the answer cast back to the array's type
        const element = ARRAY_DUCK[t?.type ?? -1];
        if (element === undefined || args.length !== 2) throw new Unrewritable(`array_remove() of an array of type OID ${t?.type ?? "unknown"} is not supported by Mason`, "array_remove an array of text, integers, floats, booleans, dates or timestamps", "array-remove-type");
        return arrayCast(fn("__mason_array_remove", [arrayCast(args[0]!, "varchar"), cast(args[1]!, ["varchar"])]), element);
      }
      case "overlaps": {
        if (args.length !== 4) return null;
        // (start, length) is the period start … start + length
        const ends = args.map((a, i) => i % 2 === 1 && this.typeOf(a) === INTERVAL ? op("+", this.clone(args[i - 1]!), a) : a);
        const [a1, b1, a2, b2] = ends.map((a, i) => i % 2 === 0 || this.typeOf(args[i]!) !== INTERVAL ? this.asInstant(a, t?.args[i]?.type ?? null) : a) as [AstNode, AstNode, AstNode, AstNode];
        return overlaps(this.cp, a1, b1, a2, b2);
      }
      case "generate_series":
        // in a SELECT list, a set of rows: DuckDB's generate_series there is one list, unnest makes it rows
        if (this.inFrom.has(b)) return null;
        b.args = args.map((a, i) => i < 2 ? this.asInstant(a, argType(i)) : a);
        return fn("unnest", [{ FuncCall: b }]);
      case "regexp_match": case "regexp_matches": return this.regexpMatch(name, b, args);
      case "round":
        if (args.length === 1 && argType(0) !== null && FLOATS.has(argType(0)!)) return fn("round_even", [args[0]!, intConst(0)]);
        return null;
      case "timezone":
        // AT TIME ZONE z: the zone as Postgres reads it (zoneArg); the call kept
        if (args.length === 2) b.args = [this.zoneArg(args[0]!), args[1]!];
        return null;
      case "date_trunc":
        if (args.length === 3) {
          // in a zone: the instant's own arithmetic where that is Postgres's answer (truncInstant), else the wall clock
          // there truncated, read back as an instant in that zone
          const [unit, ts] = args as [AstNode, AstNode, AstNode];
          const zone = this.zoneArg(args[2]!);
          const instant = this.asInstant(ts, argType(1));
          const fast = this.truncInstant((constString(unit) ?? "").toLowerCase(), instant, zone, constString(zone));
          // date_trunc is strict and reads its zone first: a zone not a constant name (a row's, a NULL) is read here
          // (`__mason_zone`, which refuses a name Postgres would) and a NULL one is NULL, whatever the part — a second
          // or less never names the zone, and a minute's or an hour's ±infinity is the instant's own
          if (fast !== null) return constString(zone) !== null ? fast : caseWhen([[isNull(zone), nullConst()]], fast);
          return fn("timezone", [zone, this.truncWall(unit, fn("timezone", [this.clone(zone), instant]), TIMESTAMP)]);
        }
        if (args.length !== 2) return null;
        {
          const unit = (constString(args[0]) ?? "").toLowerCase();
          const own = this.typeOf(args[1]!);
          if (own === TIME) throw new Unrewritable("date_trunc() of a time is not supported by Mason", "date_trunc a timestamp, or extract the parts", "time-date-trunc");
          if (argType(1) === INTERVAL && unit === "week") throw new Unrewritable(`unit "week" not supported for type interval`, "", { postgres: "0A000" });
          const x = argType(1) === TIMESTAMPTZ && own === DATE ? cast(args[1]!, ["timestamptz"]) : args[1]!;
          const wall = (v: AstNode): AstNode | null => (unit === "century" || unit === "millennium" || unit === "decade") && argType(1) !== INTERVAL
            ? this.truncWall(args[0]!, v, argType(1) === TIMESTAMPTZ ? TIMESTAMPTZ : TIMESTAMP)
            : v === args[1] ? null : fn("date_trunc", [args[0]!, v]);
          // a timestamptz in the session's zone: the instant's own arithmetic where that is Postgres's answer. The
          // zone is the one the statement EXECUTES in, never the one it was planned in (a prepared statement is
          // planned at its Parse and run after any later SET TimeZone): `current_setting('TimeZone')`, which DuckDB
          // folds to a constant when it plans the statement it runs, so the CASE costs no row anything
          if (argType(1) === TIMESTAMPTZ) {
            const session = (): AstNode => fn("current_setting", [strConst("TimeZone")]);
            const utc = this.truncInstant(unit, this.clone(x), session(), "UTC");
            if (utc !== null && ["microseconds", "milliseconds", "second"].includes(unit)) return utc;
            if (utc !== null) {
              const inUtc = or(UTC_NAMES.map((z) => op("=", session(), strConst(z))));
              const elsewhere = this.truncInstant(unit, x, session(), null) ?? wall(x) ?? fn("date_trunc", [args[0]!, x]);
              return caseWhen([[inUtc, utc]], elsewhere);
            }
          }
          return wall(x);
        }
      case "make_interval": return makeInterval(args);
      // isfinite of a time or an interval: DuckDB has none, and neither is ever infinite here
      case "isfinite": {
        const own = args[0] === undefined ? null : this.typeOf(args[0]);
        return own === TIME || own === INTERVAL ? caseWhen([[isNull(args[0]!), nullConst()]], boolConst(true)) : null;
      }
      case "date_bin": return args.length === 3 ? fn("time_bucket", args) : null;
      case "justify_days": case "justify_hours": case "justify_interval": return args.length === 1 ? fn("__mason_justify", [strConst(name.slice("justify_".length)), args[0]!]) : null;
      case "rpad": case "lpad": if (args.length === 2) b.args = [...args, strConst(" ")]; return null;
      case "chr": if (args.length === 1) b.args = [cast(args[0]!, ["integer"])]; return null;
      case "quote_literal": return args.length === 1 ? fn("__mason_quote_literal", [this.pgText(args[0]!, argType(0), true) ?? cast(args[0]!, ["varchar"])]) : null;
      case "quote_ident": throw new Unrewritable("quote_ident() is not supported by Mason", "quote the identifier in the statement", "quote-ident");
      case "length": case "char_length": case "character_length":
        // a bytea's length is its bytes (DuckDB has no length of a BLOB)
        if (args.length === 1 && argType(0) === BYTEA) return fn("octet_length", [args[0]!]);
        return args.length === 1 && argType(0) === BPCHAR ? fn("length", [fn("rtrim", [args[0]!])]) : null;
      // an empty array has no dimension 1 (Postgres's NULL; DuckDB has neither function)
      case "array_upper": case "array_lower": {
        if (args.length !== 2) return null;
        if (constInt(args[1]!) !== 1) return constInt(args[1]!) === null ? null : nullConst();
        return caseWhen([[op(">", fn("len", [this.clone(args[0]!)]), intConst(0)), name === "array_upper" ? fn("len", [args[0]!]) : intConst(1)]], null);
      }
      case "array_cat": return args.length === 2 ? caseWhen([[and([isNull(this.clone(args[0]!)), isNull(this.clone(args[1]!))]), nullConst()]], fn("list_concat", args)) : null;
      case "array_to_string": return args.length === 2 || args.length === 3 ? fn("__mason_array_to_string", [arrayCast(args[0]!, "varchar"), args[1]!, args[2] ?? cast(nullConst(), ["varchar"])]) : null;
      case "jsonb_strip_nulls": return args.length === 1 ? fn("__mason_jsonb_strip_nulls", [jsonArg(args[0]!)]) : null;
      case "jsonb_set": case "jsonb_insert": case "jsonb_set_lax": throw new Unrewritable(`${name}() is not supported by Mason`, "build the value with jsonb_build_object", "jsonb-set");
      case "div": {
        // div of two integers is their integer quotient, truncated toward zero
        const own = args.map((a) => this.typeOf(a));
        if (args.length === 2 && own.every((x) => x !== null && INTEGERS.has(x))) return wholeNumeric(op("//", args[0]!, nonZero(this.cp, args[1]!)));
        throw new Unrewritable("div() of a value that is not an integer is not supported by Mason", "trunc(a / b)", "div-numeric");
      }
      case "width_bucket": {
        // width_bucket_float8 / _numeric: below the range 0, at or past its top count + 1, else the bucket
        if (args.length !== 4 || (argType(0) !== FLOAT8 && argType(0) !== NUMERIC)) throw new Unrewritable("width_bucket() of an array of thresholds is not supported by Mason", "width_bucket(value, low, high, count)", "width-bucket-forms");
        const [x, lo, hi, n] = args.map((a) => argType(0) === FLOAT8 ? cast(a, ["double"]) : a) as [AstNode, AstNode, AstNode, AstNode];
        const count = cast(args[3]!, ["integer"]);
        const bucket = op("+", fn("least", [cast(fn("trunc", [op("*", n, op("/", op("-", x, lo), op("-", hi, this.clone(lo))))]), ["integer"]), op("-", this.clone(count), intConst(1))]), intConst(1));
        return caseWhen([
          [or(args.map((a) => isNull(this.clone(a)))), nullConst()],
          [op(">=", this.clone(lo), this.clone(hi)), fn("error", [strConst(`mason: width_bucket() with its bounds reversed or equal is not supported by Mason (${"Mason gap width-bucket-forms"})`)])],
          [op("<", this.clone(x), this.clone(lo)), intConst(0)],
          [op(">=", this.clone(x), this.clone(hi)), op("+", this.clone(count), intConst(1))],
        ], bucket);
      }
      case "extract": return this.extract(args);
      case "date_part": return this.datePart(args);
      case "jsonb_typeof": case "json_typeof": return jsonTypeof(args[0]!);
      case "jsonb_array_length": case "json_array_length": return args.length === 1 ? fn("__mason_json_array_length", [jsonArg(args[0]!)]) : null;
      // DuckDB's string_split makes [''] of '' and characters of an empty delimiter (src/duck/functions.ts stringToArray)
      case "string_to_array": return args.length === 2 || args.length === 3 ? fn("__mason_string_to_array", [args[0]!, args[1]!, args[2] ?? cast(nullConst(), ["varchar"])]) : null;
      // an empty array has no dimension 1 (Postgres's NULL; DuckDB's 0)
      case "array_length": {
        if (args.length !== 2 || constInt(args[1]!) !== 1) return null;
        return caseWhen([[op("=", fn("len", [this.clone(args[0]!)]), intConst(0)), nullConst()]], fn("array_length", args));
      }
      // array_to_json(a) is to_json(a): one writer, so an array's elements are written by their type (a jsonb's embedded)
      case "array_to_json": case "jsonb_build_object": case "json_build_object": case "jsonb_build_array": case "json_build_array": case "to_json": case "to_jsonb": {
        if (name === "array_to_json" && args.length !== 1) return null;
        const values = args.map((a, i) => this.jsonValue(a, t?.args[i]?.type ?? this.typeOf(a), name));
        const style = name.endsWith("_object") ? "o" : name.endsWith("_array") ? "a" : "v";
        return fn("__mason_json_build", [strConst(`${style}:${values.map((v) => v.kind).join("")}`), ...values.map((v) => v.value)]);
      }
      case "jsonb_agg": case "json_agg": {
        if (b.agg_distinct === true) throw new Unrewritable(`${name}(DISTINCT …) is not supported by Mason`, `select the DISTINCT values in a subquery and ${name} them`, "json-agg-distinct");
        if (b.over !== undefined || args.length !== 1) return null;
        const isArray = name === "json_agg" && argType(0) !== null && ARRAYS.has(argType(0)!);
        const tested = isArray ? this.cp(args[0]!) : null;
        const v = this.jsonValue(args[0]!, argType(0), name);
        const item = fn("__mason_json_value", [strConst(v.kind), v.value]);
        // json_agg puts a line break before each array but the first, and never before a NULL (json_agg_transfn);
        // jsonb_agg's text is canonical
        if (tested !== null) return linedAgg(b, caseWhen([[isNull(tested), item]], concat(strConst("\n "), this.cp(item))), this.done);
        const agg: AstNode = { FuncCall: { ...b, funcname: [S("string_agg")], args: [item, strConst(", ")] } };
        this.done.add(bodyOf(agg));
        return concat(strConst("["), agg, strConst("]"));
      }
      case "jsonb_object_agg": case "json_object_agg": {
        if (b.over !== undefined || args.length !== 2 || b.agg_distinct === true) return null;
        const v = this.jsonValue(args[1]!, argType(1), name);
        const member = concat(fn("__mason_json_value", [strConst("s"), cast(args[0]!, ["varchar"])]), strConst(" : "), fn("__mason_json_value", [strConst(v.kind), v.value]));
        const agg: AstNode = { FuncCall: { ...b, funcname: [S("string_agg")], args: [member, strConst(", ")] } };
        this.done.add(bodyOf(agg));
        return concat(strConst("{ "), agg, strConst(" }"));
      }
      case "jsonb_extract_path_text": case "json_extract_path_text": case "jsonb_extract_path": case "json_extract_path": {
        const own = argType(0);
        return this.folded(() => {
          // VARIADIC <array>: the array's elements are the path, as `#>`'s; else each argument is an element
          const steps = b.func_variadic === true ? this.jsonPath(args[1]!, (n) => arrayCast(n, "varchar")) : this.pathOfArguments(args.slice(1));
          const canonical = own === JSONB || name.startsWith("jsonb");
          return this.jsonRead(args[0]!, steps, true, canonical, name.endsWith("_text"));
        });
      }
      case "jsonb_object_keys": case "json_object_keys":
        if (this.inFrom.has(b)) return null;
        return fn("unnest", [fn("__mason_json_keys", [args[0]!, boolConst(name.startsWith("jsonb")), boolConst(false)])]);
      case "jsonb_array_elements": case "json_array_elements": case "jsonb_array_elements_text": case "json_array_elements_text":
      case "jsonb_each": case "json_each": case "jsonb_each_text": case "json_each_text":
        throw new Unrewritable(`${name}() in a SELECT list is not supported by Mason`, `read it in FROM: SELECT … FROM ${name}(…) AS e`, "json-rows-in-select");
      case "regexp_replace": {
        if (args.length < 3) return null;
        const flags = constString(args[3]);
        const re = regexPattern(args[1]!, true);
        if (args.length > 4 || (args[3] !== undefined && (argType(3) === null || !TEXTS.has(argType(3)!)))) {
          throw new Unrewritable("regexp_replace() with a start position or a count is not supported by Mason", "write regexp_replace(text, pattern, replacement[, flags]); the flag g replaces every match", "regexp-flags");
        }
        // a pattern, a replacement or flags RE2 would read otherwise: Postgres's engine, a chunk at a time
        if (re === null || constString(args[2]) === null || (args[3] !== undefined && (flags === null || !/^[gi]*$/.test(flags)))) {
          return pgCall("text", `regexp_replace(${args.map((_, i) => `a${i + 1}`).join(", ")})`, args);
        }
        b.args = [args[0]!, re, replacement(args[2]!), ...args.slice(3)];
        return null;
      }
      // the type Postgres says the argument has, never DuckDB's name for what it holds
      case "pg_typeof": {
        const type = argType(0);
        if (type === null) return null;
        // a type a database made is the catalog's, named as Postgres names it under the session's search_path (issue 861:
        // its pg_type name alone said `level` for `other.level` and `_mood` for `mood[]`)
        const named = this.typeNames.get(type);
        return strConst(named !== undefined ? named : pgEvalSync("SELECT $1::oid::regtype::text", [String(type)], this.timeZone, this.dateStyle)[0]?.[0] ?? String(type));
      }
      case "regexp_matches": case "regexp_match": case "regexp_split_to_table": case "regexp_split_to_array": case "regexp_count": case "regexp_instr": case "regexp_substr": case "regexp_like":
        throw new Unrewritable(`${name}() is not supported by Mason`, "test a match with ~ (or ~*), take a part with substring(text from pattern), or replace with regexp_replace", "regexp-functions");
      case "substring":
        // substring(text FROM pattern): Postgres's regular-expression form (two text arguments)
        if (args.length === 2 && argType(1) !== null && TEXTS.has(argType(1)!)) {
          if (regexPattern(args[1]!, true) === null) return pgCall("text", "substring(a1 from a2)", args);
          return regexSubstring(this.cp, args[0]!, args[1]!);
        }
        if (args.length === 3 && argType(1) !== null && TEXTS.has(argType(1)!)) throw new Unrewritable("substring(… SIMILAR … ESCAPE …) is not supported by Mason", "use substring(text from pattern) with a POSIX regular expression", "similar-to-forms");
        return null;
      case "octet_length": if (argType(0) !== null && TEXTS.has(argType(0)!)) return fn("strlen", args); return null;
      case "to_char": return toChar(args, argType(0));
      case "to_timestamp": if (args.length === 2) return cast(fn("strptime", [args[0]!, strConst(strptimeFormat(args[1]!))]), ["timestamptz"]); return null;
      case "to_date": if (args.length === 2) return cast(fn("strptime", [args[0]!, strConst(strptimeFormat(args[1]!))]), ["date"]); return null;
      case "format": return formatCall(args, (a, i) => this.pgText(a, argType(i), false) ?? cast(a, ["varchar"]));
      // each value as its output function writes it (concat_ws's separator is text)
      case "concat": case "concat_ws":
        b.args = args.map((a, i) => name === "concat_ws" && i === 0 ? a : this.pgText(a, argType(i), false) ?? a);
        return null;
      // an inet's text functions over its stored text (`10.3.6.45/32`)
      case "host": return argType(0) === INET && args.length === 1 ? fn("regexp_replace", [args[0]!, strConst("/\\d+$"), strConst("")]) : null;
      case "masklen": return argType(0) === INET && args.length === 1 ? cast(fn("regexp_extract", [args[0]!, strConst("/(\\d+)$"), intConst(1)]), ["integer"]) : null;
      case "family": return argType(0) === INET && args.length === 1
        ? caseWhen([[{ NullTest: { arg: this.cp(args[0]!), nulltesttype: "IS_NULL" } }, nullConst()], [fn("contains", [args[0]!, strConst(":")]), intConst(6)]], intConst(4)) : null;
      case "abbrev": return argType(0) === INET && args.length === 1 ? inetOut(args[0]!) : null;
      // the session's setting, never DuckDB's own (`settingRead`)
      case "current_setting": return args.length === 1 || args.length === 2 ? settingRead(this.cp, args) : null;
      // the transaction's start, as of the execution (sqlValueFunction says why)
      case "now": case "transaction_timestamp": return args.length === 0 ? this.now("exec") : null;
      case "age":
        // age(t): from midnight of the session's day at the transaction's start (Postgres's `age(current_date, t)`),
        // never DuckDB's own clock
        if (args.length === 1 && (argType(0) === TIMESTAMP || argType(0) === TIMESTAMPTZ)) {
          b.args = [cast(cast(this.now("exec"), ["date"]), [argType(0) === TIMESTAMPTZ ? "timestamptz" : "timestamp"]), args[0]!];
        }
        return null;
      // jsonpath is Postgres's own language: each row's answer is Postgres's (src/duck/pg-eval.ts)
      case "jsonb_path_query_array": case "jsonb_path_query_first": case "jsonb_path_exists": case "jsonb_path_match": {
        if (args.length < 2 || args.length > 4 || args.some((a) => kindOf(a) === "NamedArgExpr")) return null;
        const call = pgCall(name.endsWith("_exists") || name.endsWith("_match") ? "bool" : "text", `${name}(${args.map((_, i) => `a${i + 1}::${JSONPATH_ARGS[i]}`).join(", ")})`, args);
        return name.endsWith("_exists") || name.endsWith("_match") ? call : cast(call, ["json"]);
      }
      case "jsonb_path_query":
        if (this.inFrom.has(b)) return null;
        throw new Unrewritable(`${name}() in a SELECT list is not supported by Mason`, `read it in FROM: SELECT … FROM ${name}(…) AS p`, "json-rows-in-select");
      // a bytea's functions: DuckDB's octet_length, hex and md5 read a BLOB; Postgres's encodings are its own
      case "encode": {
        const format = constString(args[1]);
        if (argType(0) !== BYTEA || args.length !== 2) return null;
        if (format === "hex") return fn("lower", [fn("hex", [args[0]!])]);
        if (format === "base64" || format === "escape") return fn("__mason_bytea_encode", [fn("lower", [fn("hex", [args[0]!])]), strConst(format)]);
        throw new Unrewritable(`encode() to ${format === null ? "a format that is not a literal" : JSON.stringify(format)} is not supported by Mason`, "encode(x, 'hex'), 'base64' or 'escape'", "bytea-forms");
      }
      case "decode": {
        const format = constString(args[1]);
        if (args.length !== 2) return null;
        if (format === "hex" || format === "base64" || format === "escape") return fn("unhex", [fn("__mason_bytea_decode", [cast(args[0]!, ["varchar"]), strConst(format)])]);
        throw new Unrewritable(`decode() from ${format === null ? "a format that is not a literal" : JSON.stringify(format)} is not supported by Mason`, "decode(x, 'hex'), 'base64' or 'escape'", "bytea-forms");
      }
      case "convert_to": case "convert_from": {
        const encoding = (constString(args[1]) ?? "").toUpperCase().replace(/[-_]/g, "");
        if (args.length !== 2 || encoding !== "UTF8") throw new Unrewritable(`${name}() of an encoding other than UTF8 is not supported by Mason`, `${name}(x, 'UTF8')`, "bytea-forms");
        return fn(name === "convert_to" ? "encode" : "decode", [args[0]!]);
      }
      case "min": case "max": {
        if (this.isCitext(argType(0))) throw new Unrewritable(`${name}() of a citext is not supported by Mason (Postgres picks it without regard to case)`, `${name}(x::text), or ${name}(lower(x))`, "citext-forms");
        if (argType(0) === INET) throw new Unrewritable(`${name}() of an inet is not supported by Mason (Postgres orders addresses by network, then host)`, `${name}(host(x))`, "inet-order");
        // a text array picks by each element under the collation: refused as its order is (text-array-order)
        if (args[0] !== undefined) this.comparable(args[0], `${name}() of`);
        return this.textMinMax(name, b, args);
      }
      default: return null;
    }
  }

  /** a value Postgres reads as a timestamptz (a date or a timestamp is cast, as Postgres casts it implicitly) */
  private asInstant(n: AstNode, wanted: number | null): AstNode {
    const own = this.typeOf(n);
    return wanted === TIMESTAMPTZ && own !== null && own !== TIMESTAMPTZ && own !== UNKNOWN ? cast(n, ["timestamptz"]) : n;
  }

  /**
   * A TIMESTAMPTZ TRUNCATED AS THE INSTANT'S OWN ARITHMETIC (docs/DESIGN.md "date_trunc of a timestamptz"), where
   * that is exactly Postgres's `timestamptz_trunc_internal` and cheaper than DuckDB's: DuckDB's `date_trunc(part,
   * TIMESTAMPTZ)` is ICU's calendar, ~45 ns a row a thread even in UTC (and its sub-day parts in another zone re-read the
   * wall clock, so an instant in a repeated hour lands on the other side of the transition, where Postgres keeps its
   * offset), while the instant's microseconds (`epoch_us`, `make_timestamptz`) are ~7. Postgres truncates the wall clock
   * in `zone` and, for a day or longer, reads the truncated wall clock back in that zone (`redotz`), else keeps the
   * instant's own offset. So, the instant's microseconds `u`, floored by integer arithmetic (`%` is truncating, hence
   * `((u % k) + k) % k`):
   *  - microseconds: the instant itself;
   *  - milliseconds, second: `u` floored, in every zone (an offset is whole seconds);
   *  - minute, hour: in UTC `u` floored; elsewhere `u` less the wall clock's remainder (one zone conversion, the
   *    offset kept);
   *  - day, week (Monday's, ISO: 1970-01-01 was a Thursday), month and up: in UTC only — `u` floored by a day or a
   *    week, or the naive calendar (`make_timestamp(u)`, no zone) truncated as a timestamp is (`truncWall`); in
   *    another zone the wall clock read back is a zone lookup DuckDB's own call makes as cheaply, so null (the caller's
   *    path).
   * `zoneName` is the zone as a constant (UTC and its aliases: `isUtc`), null for a zone a row holds. ±infinity is
   * itself (Postgres 14+) and NULL is NULL: the CASE's ELSE. null where the unit is not a constant this handles.
   */
  private truncInstant(unit: string, value: AstNode, zone: AstNode, zoneName: string | null): AstNode | null {
    // a literal Postgres read as a timestamptz is one to DuckDB too (in the session's zone, as Postgres reads it)
    const x = this.typeOf(value) === UNKNOWN ? cast(value, ["timestamptz"]) : value;
    const utc = zoneName !== null && isUtc(zoneName);
    const DAY = 86_400_000_000n;
    const k = ({ milliseconds: 1000n, second: 1_000_000n, minute: 60_000_000n, hour: 3_600_000_000n, day: DAY } as Record<string, bigint>)[unit];
    const big = (n: bigint): AstNode => n <= 2_147_483_647n ? intConst(Number(n)) : numConst(String(n));
    const u = (): AstNode => fn("epoch_us", [this.clone(x)]);
    const floorMod = (v: () => AstNode, by: bigint, plus = 0n): AstNode => op("%", op("+", op("%", v(), big(by)), big(by + plus)), big(by));
    let micros: AstNode;
    if (unit === "microseconds") return x;
    if (k !== undefined && (utc || unit === "milliseconds" || unit === "second")) micros = op("-", u(), floorMod(u, k));
    else if (k !== undefined && unit !== "day") micros = op("-", u(), floorMod(() => fn("epoch_us", [fn("timezone", [this.clone(zone), this.clone(x)])]), k));
    else if (!utc) return null;
    // Monday's: u - ((u + 3 days) mod 7 days), as ((u % 7d) + 10d) % 7d, which no instant overflows
    else if (unit === "week") micros = op("-", u(), floorMod(u, 7n * DAY, 3n * DAY));
    else if (["month", "quarter", "year", "decade", "century", "millennium"].includes(unit)) micros = fn("epoch_us", [this.truncWall(strConst(unit), fn("make_timestamp", [u()]), TIMESTAMP)]);
    else return null;
    return caseWhen([[fn("isfinite", [this.clone(x)]), fn("make_timestamptz", [micros])]], x);
  }

  /**
   * `date_trunc(unit, x)` of a wall clock (a timestamp, or a timestamptz read in the session's zone: `type`), DuckDB's
   * except where Postgres counts otherwise: its centuries and millennia begin in a year 1 (2001-01-01), DuckDB's in a
   * year 0 (DT_CENTURY), and a decade before year 1 is counted back as timestamp_trunc's DTK_DECADE counts it.
   */
  private truncWall(unitNode: AstNode, x: AstNode, type: number): AstNode {
    const unit = (constString(unitNode) ?? "").toLowerCase();
    if (unit !== "century" && unit !== "millennium" && unit !== "decade") return fn("date_trunc", [unitNode, x]);
    const y = fn("year", [this.clone(x)]);
    const first = unit === "decade"
      ? caseWhen([[op(">", y, intConst(0)), op("*", op("//", this.clone(y), intConst(10)), intConst(10))]],
        op("*", op("-", intConst(0), op("//", op("-", intConst(8), op("-", this.clone(y), intConst(1))), intConst(10))), intConst(10)))
      : (() => {
        const n = unit === "century" ? 100 : 1000;
        return caseWhen([[op(">", y, intConst(0)), op("-", op("*", op("//", op("+", this.clone(y), intConst(n - 1)), intConst(n)), intConst(n)), intConst(n - 1))]],
          op("+", op("*", op("-", intConst(0), op("//", op("-", intConst(n - 1), op("-", this.clone(y), intConst(1))), intConst(n))), intConst(n)), intConst(1)));
      })();
    const truncated = op("+", fn("date_trunc", [strConst("year"), this.clone(x)]), fn("to_years", [cast(op("-", first, this.clone(y)), ["integer"])]));
    return caseWhen([[fn("isfinite", [this.clone(x)]), truncated]], type === TIMESTAMPTZ ? cast(x, ["timestamptz"]) : cast(x, ["timestamp"]));
  }

  private textMinMax(name: string, b: Body, args: AstNode[]): AstNode | null {
    const arg = args[0];
    // a window's too (`max(t) OVER (…)`): arg_min / arg_max are DuckDB window aggregates as well
    if (arg === undefined || !TEXTS.has(this.typeOf(arg) ?? -1)) return null;
    // under the collation the aggregate compared under (its inputcollid: one argument's own collation); a min the
    // rewrite made of another has no node of its own, and reads its argument's
    const agg = this.at(b, ["AGGREF", "WINDOWFUNC"]);
    const c = agg !== null ? this.inputCollationOf(agg) : this.orderedUnder(arg);
    if (c === null || c.kind === "bytes") return null;
    // the value whose key is least (or greatest); a NULL value has no key and is skipped, as min skips it
    // (the value in three places, each its own copy: the walker rewrites a node in its first place alone)
    const keys = c.kind === "icu" ? [collate(this.cp(strip(arg)), c.name), this.cp(strip(arg))] : libcKeys(this.cp, this.cp(strip(arg)), c.collate);
    const key = caseWhen([[not(isNull(this.cp(strip(arg)))), row(keys)]], null);
    return { FuncCall: { ...b, funcname: [S(name === "min" ? "arg_min" : "arg_max")], args: [strip(arg), key] } };
  }

  /** WITHIN GROUP: mode() picks the most frequent value and, of equals, the first in the ORDER BY's order — DuckDB's
   *  mode over the values in that order picks the same (its tie goes to the first it saw); percentile_disc / _cont
   *  take a position in the order, which DuckDB computes by bytes: refused for text under a libc collation */
  private withinGroup(name: string, b: Body): AstNode | null {
    // a hypothetical-set aggregate: the engine has none, of any type under any collation
    if (HYPOTHETICAL_SET.has(name)) {
      throw new Unrewritable(`${name}() WITHIN GROUP is not supported by Mason`, "count the rows below the value in a subquery: SELECT count(*) + 1 FROM t WHERE x < 'value'", "hypothetical-set");
    }
    const order = (b.agg_order ?? []) as AstNode[];
    const key = order[0] !== undefined ? bodyOf(order[0]).node as AstNode : undefined;
    // a jsonb's position in its order, or its most frequent value: DuckDB would pick by its text
    if (key !== undefined && (this.typeOf(key) === JSONB || this.typeOf(key) === JSONB_ARRAY)) {
      throw new Unrewritable(`${name}() WITHIN GROUP (ORDER BY a jsonb) is not supported by Mason (Postgres orders jsonb by its own rules)`, "ORDER BY the value … LIMIT 1 OFFSET n in a subquery", "jsonb-compare");
    }
    // A NUMERIC THE RULES SORT BY ITS EXACT ORDER KEY (a quotient, a NULLIF, a power, …): picked by that key, answering
    // the row's value (`pickedByExactKey`). An array of fractions would answer the doubles of a numeric[]: refused
    if (this.picksByExactKey(b)) {
      if (this.typed({ FuncCall: b })?.directArgs?.[0]?.type === FLOAT8_ARRAY) {
        throw new Unrewritable(`${name}() WITHIN GROUP of an array of fractions, ordered by a numeric Mason computes exactly (such as a quotient), is not supported by Mason (Postgres answers the picked rows' exact values)`,
          `ask for each fraction alone: ${name}(0.25) WITHIN GROUP (ORDER BY a / b), ${name}(0.75) WITHIN GROUP (ORDER BY a / b)`, "numeric-ordered-set");
      }
      return this.pickedByExactKey(name, b, (key) => key);
    }
    // a key the analysis put a Const (the class, issue 134; src/duck/constant-key.ts) is the value aggregated, and written
    // as the bare literal the engine's WITHIN GROUP refuses it (42804): every row holds it, so mode() and percentile_disc
    // take it as an argument, which the engine evaluates (NULL where no row is aggregated, as Postgres's)
    if (key !== undefined && order.length === 1 && this.typed(key)?.constant === true && (name === "mode" || name === "percentile_disc")) {
      const args = (b.args ?? []) as AstNode[];
      if (name === "mode") return { FuncCall: { ...b, args: [this.clone(key)], agg_order: undefined, agg_within_group: undefined } };
      if (args.length === 1) return { FuncCall: { ...b, funcname: [S("quantile_disc")], args: [this.clone(key), args[0]!], agg_order: undefined, agg_within_group: undefined } };
    }
    const c = key === undefined ? null : this.orderedUnder(key);
    if (c === null || c.kind === "bytes") return null;
    if (name === "mode" && order.length === 1) {
      return { FuncCall: { ...b, args: [this.clone(key!)], agg_within_group: undefined } };
    }
    // percentile_disc of text takes the value at a position in the collation's order: the position of its KEY, which
    // orders as the collation does and ends in the value's own bytes, read back from it (as GREATEST's is)
    if (name === "percentile_disc" && order.length === 1) {
      const sort = bodyOf(order[0]!);
      const keyed: AstNode = { FuncCall: { ...b, agg_order: [{ SortBy: { ...sort, node: this.textKey(key!, c, this.typeOf(key!) === BPCHAR, "") } }] } };
      this.done.add(bodyOf(keyed));
      const value = (k: AstNode): AstNode => fn("decode", [fn("unhex", [fn("regexp_extract", [k, strConst("[^ ]*$")])])]);
      // an array of fractions answers an array of keys: the overload Postgres chose, read from its analysis of the
      // call (a float8[] fraction), never from the answer's element type, which is whatever text type the key is
      if (this.typed({ FuncCall: b })?.directArgs?.[0]?.type === FLOAT8_ARRAY) {
        const each = (): AstNode => ({ ColumnRef: { fields: [S("__mason_k")] } });
        return fn("list_transform", [keyed, op("->", each(), value(each()))]);
      }
      return value(keyed);
    }
    // (percentile_disc and mode() are the ordered-set aggregates of text; a hypothetical-set one is refused above)
    return null;
  }

  /** regexp_match: the first match's groups (or the match) as an array, NULL without one; regexp_matches: a row per
   *  match ('g') or for the first, each such an array */
  private regexpMatch(name: string, b: Body, args: AstNode[]): AstNode {
    const pattern = constString(args[1]);
    const flags = args[2] === undefined ? "" : constString(args[2]);
    // a pattern or flags RE2 would read otherwise: Postgres's engine, a chunk at a time (regexp_matches's rows, each
    // match's text[], as JSON)
    const viaPostgres = (): AstNode => {
      const call = `${name}(${args.map((_, i) => `a${i + 1}`).join(", ")})`;
      if (name === "regexp_match") return pgCall("list", call, args);
      const rows = pgCall("list", `ARRAY(SELECT to_json(mason_m)::text FROM ${call} AS mason_m)`, args);
      const matrix: AstNode = { TypeCast: { arg: arrayCast(rows, "json"), typeName: { names: [S("varchar")], typemod: -1, arrayBounds: [{ Integer: { ival: -1 } }, { Integer: { ival: -1 } }] } } };
      return fn("unnest", [matrix]);
    };
    if (name === "regexp_matches" && this.inFrom.has(b)) throw new Unrewritable("regexp_matches() in FROM is not supported by Mason", "call it in the SELECT list: SELECT regexp_matches(…) FROM t", "regexp-matches-forms");
    if (pattern === null || flags === null || regexPattern(args[1]!, true) === null || !/^[gi]*$/.test(flags)
      || (name === "regexp_matches" && flags.includes("g") && captureGroups(pattern) > 1)) return viaPostgres();
    if (name === "regexp_match" && flags.includes("g")) throw new Unrewritable("regexp_match() does not support the \"global\" option", "use the regexp_matches function instead", { postgres: "22023" });
    const s = args[0]!;
    const re = regexPattern(args[1]!, true)!;
    const options = strConst(flags.includes("i") ? "i" : "");
    const groups = captureGroups(pattern);
    const extract = (g: number): AstNode => fn("regexp_extract", [this.clone(s), this.clone(re), intConst(g), this.clone(options)]);
    const found = arrayOf(groups === 0 ? [extract(0)] : Array.from({ length: groups }, (_, i) => extract(i + 1)));
    const matches = fn("regexp_matches", [s, re, options]);
    if (name === "regexp_match") return caseWhen([[matches, found]], null);
    if (!flags.includes("g")) return fn("unnest", [caseWhen([[matches, arrayOf([found])]], null)]);
    // each match's group as a one-element array: list_value of the unnested matches
    return fn("list_value", [fn("unnest", [fn("regexp_extract_all", [this.clone(s), this.clone(re), intConst(groups === 0 ? 0 : 1), this.clone(options)])])]);
  }

  /**
   * A value's TEXT as Postgres writes it where DuckDB's cast to VARCHAR writes another — its output function's (what
   * `concat`, `format`, `||` and to_json write) or, `asCast`, an explicit cast's (which differs from the output for a
   * boolean alone: `true::text` is `true`, its output `t`). Null where DuckDB's VARCHAR is already Postgres's text.
   */
  private pgText(n: AstNode, type: number | null, asCast: boolean): AstNode | null {
    if (type === null) return null;
    // a char(n)'s output is padded; its cast to text drops the padding
    if (type === BPCHAR) return asCast ? fn("rtrim", [n]) : null;
    // a float cast to numeric is a DuckDB double; Postgres's numeric holds the float's shortest digits, written plainly
    // (`round(x)::numeric::text` is `25`, never `25.0`; `1e-7` is `0.0000001`)
    if (type === NUMERIC && kindOf(n) === "TypeCast" && (this.typed(n)?.typmod ?? -1) < 0) {
      const inner = bodyOf(n).arg as AstNode, from = this.typeOf(inner);
      if (from !== null && FLOATS.has(from)) return fn("__mason_float_numeric_text", [cast(inner, ["double"]), boolConst(from === FLOAT4)]);
    }
    // an inet's output drops a full mask (`10.3.6.45`, `::1`); its cast to text keeps it (`10.3.6.45/32`), as stored
    if (type === INET) return asCast ? null : inetOut(n);
    // a bytea's text is its hex (bytea_output = hex): `\x00ff`
    if (type === BYTEA) return concat(strConst("\\x"), fn("lower", [fn("hex", [n])]));
    if (FLOATS.has(type)) return fn("__mason_float_text", [cast(n, ["double"]), boolConst(type === FLOAT4)]);
    if (type === BOOL) return asCast ? null : caseWhen([[n, strConst("t")], [not(this.clone(n)), strConst("f")]], null);
    if (type === INTERVAL) return fn("__mason_interval_text", [n]);
    if (ARRAYS.has(type) || isHeldArray(type)) return fn("__mason_array_text", [arrayCast(n, "varchar"), boolConst(type === 1000)]);
    // written again in the zone the statement executes under (the copy's text is the zone it was read in)
    const zoned = ZONED_HELD.get(type);
    if (zoned !== undefined) return pgCall("text", `a1::${zoned}`, [n]);
    if (type === JSONB) return fn("__mason_jsonb_text", [n]);
    // a year before 1 is DuckDB's `4713-11-24 (BC)`, Postgres's `4713-11-24 BC` (after the time, for a timestamp)
    if (type === DATE || type === TIMESTAMP || type === TIMESTAMPTZ) return fn("regexp_replace", [cast(n, ["varchar"]), strConst("^(\\S+) \\(BC\\)(.*)$"), strConst("\\1\\2 BC")]);
    return null;
  }

  /** a value as json_build_object / json_agg / to_json write it: its text, and how (by its Postgres type) */
  private jsonValue(n: AstNode, oid: number | null, fnName: string): { kind: JsonKind; value: AstNode } {
    // an array: each element written as its own type's json (src/duck/functions.ts jsonArray), from its text as DuckDB
    // writes it — only for elements whose text is Postgres's (not a float's NaN, a timestamp's T, an interval's or a
    // char(n)'s). Never DuckDB's to_json of the list: it quotes a jsonb element's text as a string (`["\"x\""]`)
    const element = oid === null ? undefined : JSON_ARRAY_ELEMENT[oid];
    if (element !== undefined) return { kind: "r", value: fn("__mason_json_array", [strConst(element), arrayCast(n, "varchar")]) };
    if (oid === JSONB) return { kind: "k", value: cast(n, ["varchar"]) };
    if (oid === TIMESTAMPTZ) return { kind: "z", value: this.pgText(n, oid, false) ?? cast(n, ["varchar"]) };
    if (oid === TIMESTAMP) return { kind: "t", value: this.pgText(n, oid, false) ?? cast(n, ["varchar"]) };
    if (oid !== null && (FLOATS.has(oid) || oid === NUMERIC)) return { kind: "n", value: this.pgText(n, oid, false) ?? cast(n, ["varchar"]) };
    if (oid !== null && (INTEGERS.has(oid) || oid === BOOL || oid === JSON_OID)) return { kind: "r", value: cast(n, ["varchar"]) };
    if (oid !== null && (TEXTS.has(oid) || oid === UUID || oid === DATE || oid === TIME || oid === INTERVAL || oid === INET)) return { kind: "s", value: this.pgText(n, oid, false) ?? cast(n, ["varchar"]) };
    throw new Unrewritable(`${fnName}() of a value of type OID ${oid ?? "unknown"} is not supported by Mason`, "cast the value to text, a number, a boolean, a timestamp or json first", "json-of-type");
  }

  /** EXTRACT, as the exact numeric Postgres returns: `epoch` and `second` with their fraction, the rest whole */
  private extract(args: AstNode[]): AstNode | null {
    const field = (constString(args[0]) ?? "").toLowerCase();
    const x = args[1]!;
    const type = this.typeOf(x);
    this.unitSupported(field, type);
    // an interval's parts as Postgres computes them (src/duck/functions.ts intervalPart)
    if (type === INTERVAL) {
      const scale = INTERVAL_SCALE[field];
      const part = fn("__mason_interval_part", [strConst(field), x]);
      return scale === undefined ? wholeNumeric(part) : cast(part, ["decimal", "38", scale]);
    }
    // a field that grows with time is ±Infinity of an infinite time, which a DECIMAL cannot hold: refused when met
    if ((type === DATE || type === TIMESTAMP || type === TIMESTAMPTZ) && MONOTONIC.has(field)) {
      const inner = this.extractFinite(field, this.clone(x), type) ?? fn("date_part", [strConst(field), this.clone(x)]);
      // tested as NOT isfinite: isfinite of a NULL is NULL, which would take the infinite branch
      return caseWhen([[not(fn("isfinite", [x])), fn("error", [strConst(`mason: extract(${field} …) of an infinite date or timestamp is not supported by Mason (Mason gap infinite-extract)`)])]], inner);
    }
    return this.extractFinite(field, x, type);
  }

  /** Postgres refuses a unit a type does not have (at run time, so its analysis does not): its words, its SQLSTATE */
  private unitSupported(field: string, type: number | null): void {
    const name = type === DATE ? "date" : type === TIMESTAMP ? "timestamp without time zone" : type === TIME ? "time without time zone" : null;
    const refused = type === DATE ? ["hour", "minute", "second", "milliseconds", "microseconds", "timezone", "timezone_hour", "timezone_minute", "timezone_m"]
      : type === TIMESTAMP || type === TIME ? ["timezone", "timezone_hour", "timezone_minute"] : [];
    if (name !== null && refused.includes(field)) throw new Unrewritable(`unit "${field}" not supported for type ${name}`, "", { postgres: "0A000" });
  }

  private extractFinite(field: string, x: AstNode, type: number | null): AstNode | null {
    const micros = (expr: AstNode, scale: string): AstNode => op("*", cast(expr, ["decimal", "38", "0"]), numConst(scale));
    switch (field) {
      case "epoch":
        return type === DATE ? wholeNumeric(fn("epoch", [x])) : micros(fn("epoch_us", [x]), "0.000001");
      case "second": return micros(fn("microsecond", [x]), "0.000001");
      case "milliseconds": return micros(fn("microsecond", [x]), "0.001");
      case "microseconds": return wholeNumeric(fn("microsecond", [x]));
      case "julian": throw new Unrewritable("extract(julian …) is not supported by Mason", "compute it from extract(epoch …) / 86400 + 2440587.5", "extract-julian");
      default: return null;
    }
  }

  /** date_part: Postgres's double precision, a second with its fraction; ±Infinity of an infinite time */
  private datePart(args: AstNode[]): AstNode | null {
    const field = (constString(args[0]) ?? "").toLowerCase();
    const x = args[1]!;
    const type = this.typeOf(x);
    this.unitSupported(field, type);
    if (type === INTERVAL) return cast(fn("__mason_interval_part", [strConst(field), x]), ["double"]);
    if ((type === DATE || type === TIMESTAMP || type === TIMESTAMPTZ) && MONOTONIC.has(field)) {
      const inner = this.datePartFinite(field, this.clone(x)) ?? fn("date_part", [strConst(field), this.clone(x)]);
      // tested as NOT isfinite: isfinite of a NULL is NULL, which would take an infinite branch
      const infinite = (): AstNode => not(fn("isfinite", [this.clone(x)]));
      return caseWhen([[and([infinite(), op(">", this.clone(x), cast(strConst("2000-01-01"), ["date"]))]), cast(strConst("Infinity"), ["double"])],
        [infinite(), cast(strConst("-Infinity"), ["double"])]], inner);
    }
    return this.datePartFinite(field, x);
  }

  private datePartFinite(field: string, x: AstNode): AstNode | null {
    switch (field) {
      case "second": return op("/", cast(fn("microsecond", [x]), ["double"]), numConst("1000000.0"));
      case "milliseconds": return op("/", cast(fn("microsecond", [x]), ["double"]), numConst("1000.0"));
      case "epoch": return this.typeOf(x) === DATE ? cast(fn("epoch", [x]), ["double"]) : op("/", cast(fn("epoch_us", [x]), ["double"]), numConst("1000000.0"));
      default: return null;
    }
  }

  // --------------------------------------------------------------------------------------------- casts, constants

  /** a timestamp (or timestamptz) rounded to `p` decimals of a second: half away from 2000-01-01, an infinity kept */
  private roundTime(x: AstNode, p: number): AstNode {
    const unit = intConst(10 ** (6 - p));
    const e = (): AstNode => op("-", fn("epoch_us", [this.cp(x)]), numConst("946684800000000"));
    const rounded = op("*", op("*", fn("sign", [e()]), op("//", op("+", fn("abs", [e()]), intConst(10 ** (6 - p) / 2)), unit)), this.cp(unit));
    return caseWhen([[fn("isfinite", [this.cp(x)]), op("+", this.cp(x), fn("to_microseconds", [op("-", rounded, e())]))]], x);
  }

  /**
   * A TIME AS A TIMETZ (time_timetz, function 2047, and the cast): the session zone's offset on the transaction's date
   * in that zone AT THE VALUE'S OWN TIME OF DAY (GetCurrentDateTime, then DetermineTimeZoneOffset). DuckDB's own cast
   * takes the offset of the current instant, which differs on a day the clocks change (issue 162: 12:30 answered -04
   * at 00:31 EDT on 2026-11-01, where Postgres has -05). The offset is the wall time less the instant it names in the
   * session's zone, which resolves a repeated hour to its second (standard) half and a skipped one to the offset before
   * the change, keeping the value's own time (02:30-05 on 2026-03-08 in New York), as DetermineTimeZoneOffset does;
   * the instant's own timetz would be 03:30-04 there. The date and the zone are the execution's (`now("exec")` read in
   * DuckDB's session zone), as CURRENT_DATE's. The result is the value's OWN time of day beside that offset, written
   * as `<time><±hh:mm:ss>` and read as a timetz: 24:00 stays 24:00 (time_timetz copies the time), where the instant's
   * timetz would roll it to the next midnight's 00:00. DuckDB has no constructor of a timetz from a time and an offset.
   */
  private timeAsTimetz(x: AstNode): AstNode {
    const wall = (v: AstNode): AstNode => op("+", cast(this.now("exec"), ["date"]), v);
    const instant = (v: AstNode): AstNode => cast(wall(v), ["timestamptz"]);
    const seconds = (): AstNode => op("//", op("-", fn("epoch_us", [wall(this.cp(x))]), fn("epoch_us", [instant(this.cp(x))])), intConst(1000000));
    const abs = (): AstNode => fn("abs", [seconds()]);
    const zone = fn("printf", [strConst("%s%02d:%02d:%02d"), caseWhen([[op("<", seconds(), intConst(0)), strConst("-")]], strConst("+")),
      op("//", abs(), intConst(3600)), op("%", op("//", abs(), intConst(60)), intConst(60)), op("%", abs(), intConst(60))]);
    return cast(op("||", cast(x, ["varchar"]), zone), ["timetz"]);
  }

  /** a text read as `type` (with `typmod`) by Postgres's own input function, a chunk at a time (`__mason_pg_*`,
   *  src/duck/functions.ts), under the zone DuckDB's session has; null for a type DuckDB reads as Postgres does */
  pgInput(arg: AstNode, type: number, typmod: number): AstNode | null {
    const p = typmod >= 4 ? (typmod - 4) >> 16 : -1, sc = typmod >= 4 ? (typmod - 4) & 0xffff : -1;
    const spelled: Record<number, [string, PgKind, string[] | null]> = {
      [DATE]: ["date", "date", null], [TIMESTAMP]: [typmod >= 0 ? `timestamp(${typmod})` : "timestamp", "timestamp", null],
      [TIMESTAMPTZ]: [typmod >= 0 ? `timestamptz(${typmod})` : "timestamptz", "timestamptz", null], [INTERVAL]: ["interval", "interval", null],
      [BOOL]: ["boolean", "bool", null], [UUID]: ["uuid", "text", ["uuid"]], [INT2]: ["smallint", "int8", ["smallint"]], [INT4]: ["integer", "int8", ["integer"]], [INT8]: ["bigint", "int8", null],
      // a numeric is its digits beside it (exactOf); here the value DuckDB computes with
      [NUMERIC]: [p >= 0 ? `numeric(${p},${sc})` : "numeric", "text", p >= 0 && p <= 38 ? ["decimal", String(p), String(sc)] : ["double"]],
    };
    const s = spelled[type];
    if (s === undefined) return null;
    const call = pgCall(s[1], `a1::${s[0]}`, [arg]);
    return s[2] === null ? call : cast(call, s[2]);
  }

  private typeCast(b: Body): AstNode | null {
    const target = lastName(b.typeName?.names);
    const t = this.typed({ TypeCast: b });
    const arg = b.arg as AstNode;
    // a GROUP BY or ORDER BY repeating `INTERVAL '1 day'` of the SELECT list: its literal has no analysed node of its
    // own (Postgres refers to the list's), and is the value the list's was parsed to — the same SQL on both sides
    if (t?.node === "CONST" && kindOf(arg) === "A_Const" && this.at(bodyOf(arg), ["CONST"]) === null) this.constLike.set(bodyOf(arg), t);
    const from = this.typeOf(arg);
    // a literal of a type the copy holds as its text, or of a timetz(n): the text Postgres writes it as
    if (t !== null && constString(arg) !== null && (heldType(t.type) !== undefined || t.type === TIMETZ)) {
      if (t.typmod >= 0) {
        const written = pgEvalSync(`SELECT $1::timetz(${t.typmod})::text`, [constString(arg)], this.timeZone, this.dateStyle)[0]?.[0];
        if (written != null) return cast(strConst(written), ["timetz"]);
      }
      this.constLike.set(bodyOf(arg), t);
      return this.aConst(bodyOf(arg)) ?? arg;
    }
    // a bit string read as its type: its text, for what the copy holds
    const bits = bodyOf(arg).bsval as { bsval?: string } | undefined;
    if (t !== null && kindOf(arg) === "A_Const" && bits?.bsval !== undefined && heldType(t.type) !== undefined) {
      return strConst(pgEvalSync("SELECT $1::varbit::text", [bits.bsval], this.timeZone, this.dateStyle)[0]?.[0] ?? "");
    }
    // a parameter Postgres read as the type: its text already (src/duck/analyze.ts readParameters)
    if (t !== null && from === t.type && heldType(t.type) !== undefined) return arg;
    // only Postgres's input function reads a text as one, and it is the session's offset where the text has none
    if (t !== null && t.type === TIMETZ && from !== null && TEXTS.has(from)) throw new Unrewritable("a text read as a timetz is not supported by Mason", "compare the text, or write a literal", "held-type-compare");
    if (t !== null && t.type === TIMETZ && t.typmod >= 0) throw new Unrewritable("a timetz(n) of a value is not supported by Mason", "cast to timetz with no precision", "held-type-compare");
    if (t !== null && t.type === TIMETZ && from === TIME) {
      // (typed as the cast it writes, explicit or Postgres's implicit one: `asImplicitTimetz`)
      const made = this.timeAsTimetz(arg);
      this.typedLike.set(bodyOf(made), { TypeCast: b });
      return made;
    }
    // ARRAY[tm, …]::timetz[]: Postgres casts each element (transformArrayExpr), so each time element by the same rule
    if (t !== null && t.type === TIMETZ_ARRAY && kindOf(arg) === "A_ArrayExpr") {
      const elements = (bodyOf(arg).elements ?? []) as AstNode[];
      if (elements.some((e) => this.typeOf(e) === TIME)) return arrayCast(arrayOf(elements.map((e) => this.typeOf(e) === TIME ? this.timeAsTimetz(e) : e)), "timetz");
    }
    // a time[] value as a timetz[]: each element by the same rule (an element's NULL stays NULL)
    if (t !== null && t.type === TIMETZ_ARRAY && from === TIME_ARRAY) {
      const each = (): AstNode => ({ ColumnRef: { fields: [S("__mason_t")] } });
      return fn("list_transform", [arg, op("->", each(), this.timeAsTimetz(each()))]);
    }
    // to an enum (or an array of one): a label, a text read by Postgres's rules, or the enum it already is
    if (t !== null && (this.enums.labels.has(t.type) || this.enums.arrays.has(t.type))) {
      if (from === t.type) return arg;
      if (constString(arg) !== null) return this.enumValue(arg, t.type, constString(arg));
      if (from !== null && TEXTS.has(from)) return this.enumValue(arg, t.type, null);
    }
    const isArray = Array.isArray(b.typeName?.arrayBounds) && b.typeName.arrayBounds.length > 0;
    if (isArray) {
      // an array literal ('{a,b}'::text[]): its elements, read as array_in reads them
      const literal = constString(arg);
      const element = ARRAY_ELEMENT[target];
      if (literal === null || element === undefined) return null;
      const list = arrayOf(arrayLiteral(literal).map((e) => e === null ? nullConst() : strConst(e)));
      return element === "varchar" ? list : arrayCast(list, element);
    }
    // a text read as a date, a time, an interval, a boolean, an integer or a numeric: by Postgres's own input function
    // (src/duck/pg-eval.ts), which reads `01/02/2026`, `1 day ago`, ` yes `, `0x1F` and `1_000` (DuckDB reads ISO alone)
    if (t !== null && from !== null && TEXTS.has(from) && from !== UNKNOWN && constString(arg) === null) {
      const read = this.pgInput(arg, t.type, t.typmod);
      if (read !== null) {
        this.typedLike.set(bodyOf(read), { TypeCast: b });
        if (target === "interval" && Array.isArray(b.typeName?.typmods) && b.typeName.typmods.length > 0) return intervalFields(read, constInt(b.typeName.typmods[0]));
        return read;
      }
    }
    // a value's text is Postgres's (an array's `{a,b}`, a jsonb's canonical text, a float's shortest digits …), cut to a
    // varchar(n)'s length as the explicit cast cuts it
    // A NUMERIC THE ENGINE HOLDS AS A DOUBLE, CAST (issue 252, the CAST reader): its program's exact text (`exactText`),
    // never the double's — its text, its nearest double (numeric_float8 reads numeric_out's text) and its integer
    // rounded half away from zero (numeric_int4), as Postgres computes each
    if (t !== null && from === NUMERIC && [TEXT, VARCHAR, BPCHAR, INT2, INT4, INT8, FLOAT8].includes(t.type) && !this.duckExact(arg)) {
      const text = this.exactText(arg);
      // (in a grouped SELECT, read once per group, as one row's whole text: `overGroups`)
      const exact = text === null ? null : this.overGroups(text, this.groupedCasts.get(b) ?? null);
      if (exact !== null) {
        if (t.type === FLOAT8) return fn("__mason_numeric_double", [exact]);
        if (INTEGERS.has(t.type)) {
          const [bits, name] = t.type === INT2 ? [16, "smallint"] : t.type === INT4 ? [32, "integer"] : [64, "bigint"];
          return cast(fn("__mason_numeric_int", [exact, intConst(bits as number)]), [name as string]);
        }
        if (t.type === BPCHAR) { if (t.typmod > 4) return fn("rpad", [fn("left", [exact, intConst(t.typmod - 4)]), intConst(t.typmod - 4), strConst(" ")]); }
        else return t.type === VARCHAR && t.typmod > 4 ? fn("left", [exact, intConst(t.typmod - 4)]) : exact;
      }
      // (issue 242) an integer is never the engine's double's, which rounds half to even (2.5 is 2) where Postgres's
      // numeric_int4 rounds the exact value half away from zero (3). Where no program computes it, what the engine holds
      // decides, by ITS type (review r1 of PR 506: the complement of `duckExact`'s forms is no authority on a double):
      // a DECIMAL's or a text's exact digits rounded as numeric_int4 rounds them, a double or bytes refused by name
      // (`__mason_numeric_int_of`, src/duck/functions.ts)
      else if (INTEGERS.has(t.type)) {
        const [bits, name] = t.type === INT2 ? [16, "smallint"] : t.type === INT4 ? [32, "integer"] : [64, "bigint"];
        // what the REWRITE itself makes bytes, it knows before the engine runs (review r2 of PR 506, the class
        // runtime-refusal-preempted-by-engine-error): percentile_disc or mode() ordered by an exact order key answer
        // that key's bytes, so a cast of them, or of anything over them, is refused here by name, never left to the
        // engine's own error over bytes; the run's `typeof` decides only what the rewrite cannot type
        return cast(fn("__mason_numeric_int_of", [fn("typeof", [this.clone(arg)]), cast(arg, ["varchar"]), intConst(bits as number)]), [name as string]);
      }
    }
    // to char(n): the text cut and padded to n
    if (t !== null && t.type === BPCHAR && t.typmod > 4) {
      const text = from === BPCHAR ? arg : this.pgText(arg, from, true) ?? cast(arg, ["varchar"]);
      return fn("rpad", [fn("left", [text, intConst(t.typmod - 4)]), intConst(t.typmod - 4), strConst(" ")]);
    }
    if (t !== null && (t.type === TEXT || t.type === VARCHAR)) {
      const text = this.pgText(arg, from, true);
      if (text !== null) return t.type === VARCHAR && t.typmod > 4 ? fn("left", [text, intConst(t.typmod - 4)]) : text;
    }
    // timestamp(p) / timestamptz(p) of a time: rounded to p decimals of a second as AdjustTimestampForTypmod rounds, half
    // away from Postgres's epoch (2000-01-01: `1960-01-01 00:00:00.5` is `00:00:00`); DuckDB rounds otherwise or not at all
    if (t !== null && (t.type === TIMESTAMP || t.type === TIMESTAMPTZ) && kindOf(arg) !== "A_Const" && from !== null && (from === DATE || from === TIMESTAMP || from === TIMESTAMPTZ)) {
      const own = from === t.type ? arg : cast(arg, [t.type === TIMESTAMPTZ ? "timestamptz" : "timestamp"]);
      return t.typmod >= 0 && t.typmod < 6 ? this.roundTime(own, t.typmod) : own;
    }
    if (target === "name") return fn("left", [this.pgText(arg, from, true) ?? cast(arg, ["varchar"]), intConst(63)]);
    if (target === "time" && from === TIMESTAMPTZ) return cast(cast(arg, ["timestamp"]), ["time"]);
    if (target === "interval" && Array.isArray(b.typeName?.typmods) && b.typeName.typmods.length > 0) return intervalFields(arg, constInt(b.typeName.typmods[0]));
    // a text or a json read as jsonb is jsonb's canonical text (keys sorted and once, `1.0` kept, whitespace Postgres's),
    // as the copy stores a jsonb column
    if (target === "jsonb" && from !== JSONB && from !== null && (TEXTS.has(from) || from === JSON_OID)) return cast(fn("__mason_jsonb_text", [cast(arg, ["varchar"])]), ["json"]);
    if (target === "jsonb" || target === "json") { b.typeName = { names: [S("json")], typemod: -1 }; return null; }
    if (target === "numeric" || target === "decimal") {
      // (how it is written is one decision, `numericCastWrite`, which `duckExact` reads too)
      const w = numericCastWrite((b.typeName?.typmods ?? []) as AstNode[], from, constString(arg));
      switch (w.as) {
        case "double": return cast(arg, ["double"]);
        case "decimal": return cast(arg, ["decimal", String(w.precision), String(w.scale)]);
        case "whole": return wholeNumeric(arg);
        case "literal": return decimalConst(w.text);
        case "same": return arg;
        case "as written": return null;
      }
    }
    if ((target === "varchar" || target === "bpchar") && t !== null && t.typmod > 4 && target === "varchar") {
      // varchar(n) cuts the value to n characters, as Postgres's explicit cast does
      return fn("left", [cast(arg, ["varchar"]), intConst(t.typmod - 4)]);
    }
    return null;
  }

  private aConst(b: Body): AstNode | null {
    // a string Postgres read as an array ('{1}' beside an int[]): its elements, as array_in reads them
    if (b.sval !== undefined) {
      const t = this.at(b, ["CONST"]) ?? this.constLike.get(b) ?? null;
      // a label of an enum (or an array of them) Postgres read it as: DuckDB's ENUM, which compares by the declared order
      // where the text would compare as text
      const asEnum = t === null ? null : this.enumValue(strConst(String(b.sval.sval ?? "")), t.type, String(b.sval.sval ?? ""));
      if (asEnum !== null) return asEnum;
      // a date, timestamp or interval: the value Postgres parsed, never the text again — DuckDB reads only ISO, and not
      // `'01/02/2026'`, `'March 1, 2026'`, `'… BC'`, `'epoch'`, `'1 day ago'` or `'P1D'`
      // a value of a type the copy holds as its text: the text Postgres writes it as, under the session's zone (a
      // timetz with no zone of its own is at the Parse's offset, as Postgres folds it)
      if (t !== null && (t.type === TIMETZ || heldType(t.type) !== undefined) && t.type !== 26) {
        const type = t.type === TIMETZ ? "timetz" : HELD_TYPE_NAMES.get(t.type);
        if (type !== undefined) {
          const written = pgEvalSync(`SELECT $1::${type}::text`, [String(b.sval.sval ?? "")], this.timeZone, this.dateStyle)[0]?.[0];
          if (written != null) return t.type === TIMETZ ? cast(strConst(written), ["timetz"]) : strConst(written);
        }
      }
      // an inet literal as Postgres canonicalises it (`'10.3.6.45'` is `10.3.6.45/32`, as the copy stores the column)
      // a bytea literal (`'\x00ff'`, an escaped `'a\000b'`): the bytes Postgres read, by their hex
      if (t !== null && t.type === BYTEA && t.datum !== null && t.datum.length >= 4) return fn("unhex", [strConst(t.datum.slice(4).map((x) => x.toString(16).padStart(2, "0")).join(""))]);
      if (t !== null && t.type === INET && t.datum !== null) {
        const text = datumText(INET, t.datum);
        if (text !== null) return strConst(text);
      }
      if (t !== null && t.type === INTERVAL && t.datum !== null) {
        const parts = intervalDatum(t.datum);
        if (parts !== null) return cast(strConst(`${parts.months} months ${parts.days} days ${parts.micros} microseconds`), ["interval"]);
      }
      if (t !== null && (t.type === DATE || t.type === TIMESTAMP || t.type === TIMESTAMPTZ)) {
        const text = String(b.sval.sval ?? "");
        const word = /^\s*(now|today|tomorrow|yesterday)\s*$/i.exec(text)?.[1]?.toLowerCase();
        if (word !== undefined) return this.relativeTime(word, t.type);
        if (/\b(now|today|tomorrow|yesterday)\b/i.test(text)) {
          throw new Unrewritable(`the literal '${text}' is not supported by Mason: it means another time on each run`, "write current_date, now(), current_date + 1 or current_date - 1", "relative-time-literal");
        }
        const iso = t.datum === null ? null : datumText(t.type, t.datum);
        if (iso !== null) return cast(strConst(iso), [t.type === DATE ? "date" : t.type === TIMESTAMP ? "timestamp" : "timestamptz"]);
      }
      const element = t === null ? undefined : ARRAY_DUCK[t.type];
      if (element !== undefined) {
        const list = arrayOf(arrayLiteral(String(b.sval.sval ?? "")).map((e) => e === null ? nullConst() : strConst(e)));
        return element === "varchar" ? list : arrayCast(list, element);
      }
    }
    // a NULL of an enum type (`null::mood`): DuckDB's ENUM, which enum_first and enum_range need
    if (b.isnull === true) {
      const t = this.at(b, ["CONST"]) ?? this.constLike.get(b) ?? null;
      const labels = t === null ? undefined : this.enums.labels.get(t.type);
      if (labels !== undefined) return enumCast(nullConst(), labels);
    }
    // a numeric literal with an exponent is a positional decimal (DuckDB reads `1e-7` as a double)
    if (b.fval !== undefined && /[eE]/.test(String(b.fval.fval ?? ""))) {
      const t = this.at(b, ["CONST"]);
      if (t === null || t.type === NUMERIC) return decimalConst(numericConstText(String(b.fval.fval)));
    }
    return null;
  }

  /** a value of an enum type (or an enum array type), as DuckDB's ENUM: a constant label, or one read by Postgres's rules
   *  from a text (`__mason_enum_in`: 22P02 for a label the type lacks); null for any other type */
  private enumValue(text: AstNode, type: number, literal: string | null): AstNode | null {
    const own = this.enums.labels.get(type);
    if (own !== undefined) return enumCast(literal !== null ? strConst(literal) : fn("__mason_enum_in", [cast(text, ["varchar"]), strConst(this.userTypes.get(type) ?? "enum"), arrayOf(own.map(strConst))]), own);
    const element = this.enums.arrays.get(type);
    const labels = element === undefined ? undefined : this.enums.labels.get(element);
    if (labels === undefined) return null;
    if (literal === null) throw new Unrewritable("an array of an enum read from a text is not supported by Mason", "write the array as a literal, or ARRAY[…] of its labels", "enum-forms");
    const elements = arrayLiteral(literal);
    if (elements.some((e) => e !== null && !labels.includes(e))) return null;
    return enumCast(arrayOf(elements.map((e) => e === null ? nullConst() : strConst(e))), labels, true);
  }

  private param(b: Body): AstNode | null {
    // a parameter is bound as its text; Postgres decided its type, and DuckDB is told it. A numeric one READ is the
    // engine's double (a program over its `$n` cell where its digits are printed, `exactOf`); one COMPARED with a value
    // the engine holds exactly never reaches here (`numericParamComparison`, issue 214)
    const oid = this.params[Number(b.number) - 1];
    // a text array is bound as the JSON Postgres read it to (src/duck/analyze.ts readParameters)
    if (oid === TEXT_ARRAY || oid === VARCHAR_ARRAY) return fn("from_json", [cast({ ParamRef: b }, ["varchar"]), strConst('["VARCHAR"]')]);
    const asEnum = oid === undefined || !this.enums.labels.has(oid) ? null : this.enumValue({ ParamRef: b }, oid, null);
    if (asEnum !== null) return asEnum;
    const type = oid === undefined ? null : oid === NUMERIC ? ["double"] : duckTypeOf(oid);
    return type === null ? null : cast({ ParamRef: b }, type);
  }

  /**
   * The reads a json read is made off (`(c -> 'a') -> 0`, `c #> '{a}'`), folded into one read's steps: the inner
   * read's text parsed again is the same tree (jsonb's canonical text is canonical; json's is the document's own
   * slice), so stepping on from it is stepping on in place — one parse instead of one per operator, and the native
   * read (jsonGet) sees the column. Reads of one operator family only (`->`'s steps are keys and indexes, `#>`'s
   * elements are either), with literal keys; null for anything else, which is read as written.
   */
  private jsonChain(node: AstNode, either: boolean): { base: AstNode; steps: unknown[] } | null {
    if (kindOf(node) !== "A_Expr") return null;
    const b = bodyOf(node);
    if (b.kind !== "AEXPR_OP" || lastName(b.name) !== (either ? "#>" : "->") || b.lexpr === undefined || b.rexpr === undefined) return null;
    const t = this.typed(node);
    const a0 = t?.args[0]?.type ?? null, a1 = t?.args[1]?.type ?? null;
    if (a0 === null || !JSONS.has(a0)) return null;
    const r = b.rexpr as AstNode;
    const own = constString(either ? this.jsonPath(r) : this.jsonKey(r, a1));
    if (own === null) return null;
    const deeper = this.jsonChain(b.lexpr as AstNode, either);
    return { base: deeper === null ? b.lexpr as AstNode : deeper.base, steps: [...(deeper === null ? [] : deeper.steps), ...JSON.parse(own) as unknown[]] };
  }

  /**
   * A CONSTANT OF A JSON READ'S PATH, AS POSTGRES READ IT, from the analysis alone (Typed.text, Typed.textArray). A path
   * has ONE ROUTE however it is spelled — `'{a,b}'`, `'{a,b}'::text[]`, `ARRAY['a', 'b']`, `ARRAY['a', 'b']::text[]`,
   * `'a'::text` — so a BI tool's `#>> array['k']` is the read `->> 'k'` is: DuckDB's own, a stored column, one path in
   * the request log. Spelled as an array it was a `to_json` of the list, a literal to none of those, and every row went
   * through the function (issue 130: 160-205 s against 11 s). Only a cast written directly on the constant is seen
   * through, which Postgres folds in; a length is a node of its own over the Const (no constant), and a cast on a cast
   * is one `typedAt` may step past to the value inside, so neither is read here.
   */
  private constRead(n: AstNode): Typed | null {
    const inner = kindOf(n) === "TypeCast" && isNode(bodyOf(n).arg) ? bodyOf(n).arg as AstNode : n;
    return kindOf(inner) === "A_Const" || kindOf(inner) === "A_ArrayExpr" ? this.typed(n) : null;
  }

  /**
   * A PARAMETER IN A JSON PATH, READ AS THE CONSTANT IT WAS BOUND TO (issues 465, 466; `boundPaths`): `n` a parameter,
   * bare or cast to its own type with no length (`$1::text`), of a type whose bound text IS the path's text — `text` or
   * `varchar` for a key or an element, `text[]` or `varchar[]` for a whole path (its JSON), int2 or int4 for an index —
   * so the read is DuckDB's own read, as its literal's is (never its stored column yet: `keptRead`, issue 919).
   * Anything else (another type, whose cast to text writes its own text; a cast with a length; a NULL value) is null,
   * and the read stays the function's, as at the Parse. The parameter is recorded as a path's (`pathParams`) whatever
   * its value, so the listener knows to plan the statement again at an Execute; it folds only inside a read's rule
   * (`folded`), which guards the read by the value it folded.
   */
  private foldParam(n: AstNode, kind: "text" | "array" | "index"): string | null {
    const number = this.pathParam(n, kind);
    const value = number === null ? undefined : this.boundValue(number, kind);
    if (number === null || value === undefined || this.folds === null) return null;
    this.folds.set(number, value);
    return value;
  }

  /** the number of the parameter `n` is, where it is one `foldParam` may read as a constant (recorded in `pathParams`) */
  private pathParam(n: AstNode, kind: "text" | "array" | "index"): number | null {
    let p = n;
    if (kindOf(p) === "TypeCast") {
      const c = bodyOf(p), t = this.typed(p);
      const allowed = kind === "text" ? [TEXT, VARCHAR] : kind === "array" ? [TEXT_ARRAY, VARCHAR_ARRAY] : [INT4];
      if (((c.typeName?.typmods ?? []) as AstNode[]).length > 0 || t === null || !allowed.includes(t.type) || t.typmod !== -1 || !isNode(c.arg)) return null;
      p = c.arg as AstNode;
    }
    if (kindOf(p) !== "ParamRef") return null;
    const number = Number(bodyOf(p).number);
    const oid = this.params[number - 1];
    const types = kind === "text" ? [TEXT, VARCHAR] : kind === "array" ? [TEXT_ARRAY, VARCHAR_ARRAY] : [INT2, INT4];
    if (oid === undefined || !types.includes(oid)) return null;
    this.pathParams.add(number);
    return number;
  }

  /** a parameter's bound value as a json read takes it as a constant: an index an int4's digits, a path a JSON array of
   *  texts and NULLs (to_json of what array_in read), a key any text; undefined for none (a NULL, no Execute's value) */
  private boundValue(number: number, kind: "text" | "array" | "index"): string | undefined {
    const value = this.boundPaths.get(number);
    if (value === undefined) return undefined;
    if (kind === "index") return /^-?\d{1,10}$/.test(value) && pathIndex(value) !== null ? value : undefined;
    if (kind === "array") {
      let read: unknown;
      try { read = JSON.parse(value); } catch (e) { if (e instanceof SyntaxError) return undefined; throw e; }
      if (!Array.isArray(read) || read.some((x) => x !== null && typeof x !== "string")) return undefined;
    }
    return value;
  }

  /** `#>`'s path bound as parameters (`foldParam`): the whole path one (`$1`, `$1::text[]`), or an ARRAY[…] of constants
   *  and parameters (`array[$1, $2]::text[]`, a BI tool's spelling of a nested field) — its elements as Postgres read
   *  them, a NULL one included; undefined for any other path, or one with an element that does not fold */
  private foldPath(r: AstNode): Array<string | null> | undefined {
    const whole = this.foldParam(r, "array");
    if (whole !== null) return JSON.parse(whole) as Array<string | null>;
    let a = r;
    if (kindOf(a) === "TypeCast") {
      const t = this.typed(a);
      if (((bodyOf(a).typeName?.typmods ?? []) as AstNode[]).length > 0 || t === null || (t.type !== TEXT_ARRAY && t.type !== VARCHAR_ARRAY) || t.typmod !== -1 || !isNode(bodyOf(a).arg)) return undefined;
      a = bodyOf(a).arg as AstNode;
    }
    if (kindOf(a) !== "A_ArrayExpr") return undefined;
    return this.foldElements((bodyOf(a).elements ?? []) as AstNode[]);
  }

  /** a path's elements (an ARRAY[…]'s, json_extract_path's arguments) as Postgres read them, where each is a text
   *  constant or a parameter that folds (`foldParam`); undefined where any is neither */
  private foldElements(elements: AstNode[]): Array<string | null> | undefined {
    // each element a text constant (its value as Postgres read it, a NULL included) or a parameter that may fold, every
    // parameter recorded as a path's before any folds, so a path with one element that cannot fold folds none
    const read = elements.map((e) => {
      const c = this.constRead(e);
      if (c !== null) return c.text === undefined ? { no: true as const } : { text: c.text };
      const number = this.pathParam(e, "text");
      return number === null ? { no: true as const } : { number };
    });
    if (read.some((x) => "no" in x)) return undefined;
    const values = read.map((x) => "number" in x ? this.boundValue(x.number, "text") : (x as { text: string | null }).text);
    if (this.folds === null || values.some((v) => v === undefined)) return undefined;
    for (const [i, x] of read.entries()) if ("number" in x) this.folds.set(x.number, values[i]!);
    return values as Array<string | null>;
  }

  /**
   * A JSON READ WHOSE PATH FOLDED A BOUND PARAMETER (`foldParam`), GUARDED BY THE VALUE IT FOLDED: `CASE WHEN $n::varchar
   * = '<the value>' AND … THEN <the read> ELSE <the read as at the Parse> END`. A plan made for one value is kept by that
   * value (the listener's plans are keyed by it), so the ELSE is never taken; run with another value, it reads that one
   * through the function, Postgres's answer either way. Never `error()` there: DuckDB holds an expression calling it
   * volatile, and refuses it as a window's key (PR 917's review). It keeps every parameter in the SQL, which DuckDB
   * numbers by the ones it meets; DuckDB compares two constants once a vector, and runs the ELSE on no row.
   * `make` null: no read written here, nothing folded. `asAtParse`: the read as the Parse writes it (`make` again with
   * nothing folded, by default).
   */
  private folded(make: () => AstNode | null, asAtParse: () => AstNode | null = make): AstNode | null {
    const outer = this.folds;
    this.folds = new Map();
    let read: AstNode | null, folds: Map<number, string>;
    try { read = make(); folds = this.folds; } finally { this.folds = outer; }
    if (read === null || folds.size === 0) return read;
    this.folds = null;
    let parsed: AstNode | null;
    try { parsed = asAtParse(); } finally { this.folds = outer; }
    if (parsed === null) throw new Error("a json read folded at the Execute has no form at the Parse: report it (src/duck/rewrite.ts folded)");
    const bound = (p: number): AstNode => cast({ ParamRef: { number: p } }, ["varchar"]);
    const same = [...folds].map(([p, v]) => op("=", bound(p), strConst(v)));
    return caseWhen([[same.length === 1 ? same[0]! : and(same), read]], parsed);
  }

  /** `#>`'s path, or VARIADIC's array (`list` as DuckDB reads it), as the JSON array of its elements; a NULL path or a
   *  NULL element is NULL (get_path_all, the functions being strict) */
  private jsonPath(r: AstNode, list: (n: AstNode) => AstNode = (n) => n): AstNode {
    let read = this.constRead(r)?.textArray;
    // a literal the analysis does not read as an array here: a twin of the same text typed otherwise (`typed`'s shape)
    const literal = read === undefined ? constString(r) : null;
    if (literal !== null) read = arrayLiteral(literal);
    // a path bound as parameters, read as the constant it was bound to
    if (read === undefined) read = this.foldPath(r);
    if (read === undefined) {
      this.pathTypeKnown(r);
      return cast(fn("to_json", [list(r)]), ["varchar"]);
    }
    return read === null || read.includes(null) ? nullConst() : strConst(JSON.stringify(read));
  }

  /** a path that reaches Postgres through a type that changes its text (`varchar(1)[]` cuts it, `char(2)[]` pads and
   *  trims it, `name[]`), which DuckDB's list holds as written: refused, never read as what was written */
  private pathTypeKnown(r: AstNode): void {
    const t = this.typed(r);
    const length = kindOf(r) === "TypeCast" && ((bodyOf(r).typeName?.typmods ?? []) as AstNode[]).length > 0;
    if (length || (t !== null && t.type !== TEXT_ARRAY && t.type !== VARCHAR_ARRAY && t.type !== UNKNOWN)) {
      throw new Unrewritable("a json path of a type that changes its text is not supported by Mason", "cast the path to text[]", "json-path-type");
    }
  }

  /** json_extract_path's elements, an argument each, as the JSON array of steps */
  private pathOfArguments(keys: AstNode[]): AstNode {
    // each a constant, or a parameter bound to one (foldElements)
    const read = keys.some((k) => this.constRead(k)?.text === undefined) ? this.foldElements(keys) : keys.map((k) => this.constRead(k)?.text);
    if (read === undefined || read.some((k) => k === undefined)) return jsonSteps(keys.map((k) => this.widen(k, TEXT)), false);
    return read.includes(null) ? nullConst() : strConst(JSON.stringify(read));
  }

  /** `->`'s key: an integer one an index, a constant text its one step, a char(n)'s text without its padding (`widen`) */
  private jsonKey(r: AstNode, type: number | null): AstNode {
    const index = type !== null && INTEGERS.has(type);
    // a parameter bound to the key, read as the constant it was bound to (foldParam): an index as its integer
    const folded = index ? this.foldParam(r, "index") : null;
    if (folded !== null) return strConst(JSON.stringify([Number(folded)]));
    const own = index ? null : this.constRead(r);
    const text = own !== null ? own.text : index ? null : this.foldParam(r, "text");
    return typeof text === "string" ? strConst(JSON.stringify([text])) : jsonSteps([index ? r : this.widen(r, TEXT)], index);
  }

  // --------------------------------------------------------------------------------------------- FROM

  /**
   * WHERE THE ORDER OF A JOIN'S ROWS DECIDES THE ANSWER (leftLateral), computed for the whole statement before the walk
   * (`rewrite`): libpg-query writes a SELECT's keys in its struct's order (fromClause … limitCount, withClause, larg,
   * rarg) and the walk follows it, so a SELECT's CTEs and arms are met after its FROM, and a CTE another CTE reads is
   * met before the one that reads it. So every SELECT of the statement is collected with the CTEs it sees (its own
   * WITH's and those around it, the nearest first), and `limitBounds` runs over them all until no more is bounded.
   *
   * `wire`: the statement's own rows are bounded by a row count the Execute sets on the wire (JDBC's setMaxRows or
   * fetch size: the client reads the first rows and may read no more), which the rewrite never sees in the SQL — its
   * outermost SELECT is bounded as a SELECT a LIMIT reads is (limitBounds: no aggregate, GROUP BY, DISTINCT, window or
   * set operation but UNION ALL between, and under an ORDER BY only a LIMIT of its own, which a row count on the wire
   * is not: DuckDB sorts every row first whichever plan it is given). Unless `wire`, the bounds a wire's row count
   * would add are computed too (`boundedOnWire`), so the plan says whether such an Execute plans it again.
   */
  markBounds(root: AstNode, wire = false): void {
    this.bounded = this.boundsOf(root, wire);
    this.boundedOnWire = wire ? null : this.boundsOf(root, true);
  }

  private boundsOf(root: AstNode, wire: boolean): WeakSet<Body> {
    const selects: Array<{ b: Body; scope: ReadonlyMap<string, Body> }> = [];
    const select = (b: Body, outer: ReadonlyMap<string, Body>): void => {
      const scope = new Map(outer);
      for (const c of (b.withClause?.ctes ?? []) as AstNode[]) {
        const cb = isNode(c) ? bodyOf(c) : null;
        if (cb !== null && typeof cb.ctename === "string" && isNode(cb.ctequery) && kindOf(cb.ctequery) === "SelectStmt") scope.set(cb.ctename, bodyOf(cb.ctequery));
      }
      selects.push({ b, scope });
      for (const [k, x] of Object.entries(b)) { const arm = armOf(k, x); if (arm !== null) select(bodyOf(arm), scope); else visit(x, scope); }
    };
    const visit = (v: unknown, scope: ReadonlyMap<string, Body>): void => {
      if (Array.isArray(v)) { for (const x of v) visit(x, scope); return; }
      if (v === null || typeof v !== "object") return;
      if (isNode(v) && kindOf(v) === "SelectStmt") { select(bodyOf(v), scope); return; }
      for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) visit(x, scope);
    };
    visit(root, new Map());
    const set = new WeakSet<Body>();
    let count = 0;
    const bound = (b: Body): void => { if (!set.has(b)) { set.add(b); count++; } };
    if (wire && isNode(root) && kindOf(root) === "SelectStmt") bound(bodyOf(root));
    let before: number;
    do { before = count; for (const s of selects) this.limitBounds(s.b, s.scope, set, bound); } while (count !== before);
    return set;
  }

  /**
   * One SELECT's part of markBounds. Its FROM's order decides the answer where:
   *  - a LIMIT or an OFFSET keeps the first of its rows — its own, or one around it whose rows are its rows in their
   *    order (`bounded`: the SELECT reads it as a derived table or a CTE, or as an arm of its UNION ALL) — with no
   *    aggregate, GROUP BY, DISTINCT, window or other set operation between, each of which reads every row first and
   *    hands back an order of its own. Under an ORDER BY only a LIMIT of its own bounds (never WITH TIES: Mason ranks
   *    every row for it, src/duck/rewrite.ts withTies), and only when its first key, once the nulls idiom is folded
   *    (nullsKeyFolded), is a column of a table sorted bare (sortsByTableColumn): DuckDB's top N pushes its bound into
   *    that table's scan as a filter, so the rows reaching the lateral are few (measured, docs/DESIGN.md "A LEFT lateral
   *    of a list": 0.1–6 s streamed against 0.4–106 s for the delimiter join over 20 M rows); any other key — the
   *    lateral's own column, an expression, a text under a collation, a citext, a char(n), a jsonb, each sorted by an
   *    expression — is a top N over every row, each row's function calls paid in full;
   *  - an aggregate that reads its rows in order (string_agg, array_agg, json_agg …) has no ORDER BY of its own, or a
   *    window function that reads its frame in order (row_number, lag, first_value …, or such an aggregate) has a
   *    window with no ORDER BY: Postgres hands each base row's members to it in their order (`readsInOrder`).
   * Its joins, and the derived tables and CTEs its FROM reads, are bounded. An OFFSET alone is bounded for the
   * answer's sake (Postgres's rows after it) and streams every row it does not skip; a CTE read twice or MATERIALIZED
   * is computed whole, a call a row. Bounding too much costs time, never an answer (the streamed lateral is Postgres's
   * rows in Postgres's order); bounding too little keeps DuckDB's delimiter join, whose rows come in an order of its own.
   */
  private limitBounds(b: Body, scope: ReadonlyMap<string, Body>, bounded: WeakSet<Body>, bound: (b: Body) => void): void {
    const keeps = (n: unknown): boolean => isNode(n) && !(kindOf(n) === "A_Const" && bodyOf(n).isnull === true);
    const sort = (b.sortClause ?? []) as AstNode[];
    const inOrder = this.readsInOrder(b);
    if (!inOrder) {
      if (!keeps(b.limitCount) && !keeps(b.limitOffset) && !bounded.has(b)) return;
      if (b.limitOption === "LIMIT_OPTION_WITH_TIES") return;
      // a UNION ALL's arms, each read in turn (a set operation's arm is a SELECT body, unwrapped: walkBody)
      if (b.op !== undefined && b.op !== "SETOP_NONE") {
        if (b.op === "SETOP_UNION" && b.all === true && sort.length === 0) for (const arm of [b.larg, b.rarg]) if (arm !== null && typeof arm === "object" && !isNode(arm)) bound(arm as Body);
        return;
      }
      if (sort.length > 0) {
        const first = nullsKeyFolded(sort, b)[0];
        if (!keeps(b.limitCount) || first === undefined || kindOf(first) !== "SortBy" || !this.sortsByTableColumn(bodyOf(first).node as AstNode, b, scope)) return;
      }
      if ((Array.isArray(b.groupClause) && b.groupClause.length > 0) || b.havingClause !== undefined || b.distinctClause !== undefined) return;
      if ((Array.isArray(b.windowClause) && b.windowClause.length > 0) || ((b.targetList ?? []) as AstNode[]).some((t) => this.hasAggregate(t) || hasWindow(t))) return;
    } else if (b.op !== undefined && b.op !== "SETOP_NONE") return;
    const visit = (x: unknown): void => {
      if (!isNode(x)) return;
      const xb = bodyOf(x);
      if (kindOf(x) === "JoinExpr") { bound(xb); visit(xb.larg); visit(xb.rarg); return; }
      if (kindOf(x) === "RangeSubselect" && isNode(xb.subquery)) { bound(bodyOf(xb.subquery as AstNode)); return; }
      if (kindOf(x) === "RangeVar" && xb.schemaname === undefined) {
        const cte = scope.get(String(xb.relname));
        if (cte !== undefined) bound(cte);
      }
    };
    for (const x of (b.fromClause ?? []) as AstNode[]) visit(x);
  }

  /** whether a SELECT's aggregate or window function reads its rows in the order they come (limitBounds): an
   *  order-sensitive aggregate with no ORDER BY of its own (nor DISTINCT, whose values Postgres sorts), or a window
   *  function that reads its frame in order over a window with no ORDER BY; not inside a subquery */
  private readsInOrder(b: Body): boolean {
    const windows = new Map(((b.windowClause ?? []) as AstNode[]).filter(isNode).map((w) => [String(bodyOf(w).name ?? ""), bodyOf(w)]));
    const ordered = (w: Body | undefined): boolean => {
      if (w === undefined) return false;
      if (Array.isArray(w.orderClause) && w.orderClause.length > 0) return true;
      return typeof w.refname === "string" && ordered(windows.get(w.refname));
    };
    const reads = (v: unknown): boolean => {
      if (Array.isArray(v)) return v.some(reads);
      if (v === null || typeof v !== "object") return false;
      if (!isNode(v)) return Object.values(v as Body).some(reads);
      if (kindOf(v) === "SubLink") return false;
      if (kindOf(v) === "FuncCall") {
        const c = bodyOf(v), name = lastName(c.funcname);
        const aggregate = IN_ORDER_AGGREGATES.has(name) && c.agg_order === undefined && c.agg_distinct !== true;
        if (c.over === undefined ? aggregate : (aggregate || IN_ORDER_WINDOWS.has(name)) && !ordered(c.over as Body)) return true;
      }
      return Object.values(bodyOf(v)).some(reads);
    };
    return reads(b.targetList) || reads(b.havingClause);
  }

  /** whether an ORDER BY key is a column of a table sorted as it is stored (limitBounds): an ordinal or an output
   *  name is its target's expression, and a derived table's or a CTE's column is followed to what it selects */
  private sortsByTableColumn(key: AstNode, b: Body, scope: ReadonlyMap<string, Body>): boolean {
    const targets = (b.targetList ?? []) as AstNode[];
    const out = this.outputOf(key, targets);
    return constInt(key) !== null && out === null ? false : this.tableColumn(out?.value ?? key, b, scope, 0);
  }

  /** a column of a table, or of a derived table or CTE that selects one, sorted bare: no collation's keys, citext's
   *  lower(), char(n)'s rtrim() or jsonb's order key (sortBy), each an expression no top N filter reaches the scan by.
   *  (A CTE is looked up among those the SELECT sees; a derived table's own WITH is not followed through its `*`.) */
  private tableColumn(e: AstNode, select: Body, scope: ReadonlyMap<string, Body>, depth: number): boolean {
    if (!isNode(e) || kindOf(e) !== "ColumnRef" || depth > 8) return false;
    const t = this.typed(e);
    if (t !== null) {
      if (t.node !== "VAR" || t.functionColumn !== undefined || (t.levelsUp ?? 0) !== 0) return false;
      if (t.type === JSONB || t.type === BPCHAR || t.type === INET || this.isCitext(t.type)) return false;
      const c = this.collationOf(e);
      if (c !== null && c.kind !== "bytes") return false;
      if (t.relation !== undefined) return true;
    }
    // a derived table's or a CTE's column: what it selects under that name, or a column of the one table its * reads
    const f = names(bodyOf(e).fields);
    const col = f.at(-1), alias = f.length === 2 ? f[0] : undefined;
    const sources: Array<{ alias: string; query: Body }> = [];
    const from = (x: unknown): void => {
      if (!isNode(x)) return;
      const xb = bodyOf(x);
      if (kindOf(x) === "JoinExpr") { from(xb.larg); from(xb.rarg); return; }
      if (kindOf(x) === "RangeSubselect" && typeof xb.alias?.aliasname === "string" && isNode(xb.subquery) && xb.alias?.colnames === undefined) sources.push({ alias: xb.alias.aliasname, query: bodyOf(xb.subquery as AstNode) });
      if (kindOf(x) === "RangeVar" && xb.schemaname === undefined && xb.alias?.colnames === undefined) {
        const cte = scope.get(String(xb.relname));
        if (cte !== undefined) sources.push({ alias: xb.alias?.aliasname ?? String(xb.relname), query: cte });
      }
    };
    for (const x of (select.fromClause ?? []) as AstNode[]) from(x);
    const matching = sources.filter((s) => alias === undefined || s.alias === alias);
    if (col === undefined || matching.length !== 1) return false;
    const q = matching[0]!.query;
    if (q.op !== undefined && q.op !== "SETOP_NONE") return false;
    const qt = (q.targetList ?? []) as AstNode[];
    const hits = qt.filter((x) => isNode(bodyOf(x).val) && !hasStar(bodyOf(x).val) && (bodyOf(x).name ?? figureColname(bodyOf(x).val as AstNode)) === col);
    if (hits.length === 1) return this.tableColumn(bodyOf(hits[0]!).val as AstNode, q, scope, depth + 1);
    const qf = (q.fromClause ?? []) as AstNode[];
    return t !== null && hits.length === 0 && qt.some((x) => hasStar(bodyOf(x).val)) && qf.length === 1 && kindOf(qf[0]!) === "RangeVar" && !scope.has(String(bodyOf(qf[0]!).relname));
  }

  /**
   * A LEFT JOIN LATERAL OF A LIST'S ROWS ON TRUE (docs/DESIGN.md "A LEFT lateral of a list"): `FROM base LEFT JOIN
   * json_each(base.doc) d ON TRUE` is every base row with each of its members, or once with NULLs where it has none.
   * DuckDB plans a LEFT lateral as a delimiter join — the whole base grouped, the function called for every distinct
   * argument, a hash join back — so a LIMIT over it reads every row (a BI tool's "expand the JSON" preview: 37.9 s over
   * 22 M rows), and the join hands its rows back in an order of its own, so the LIMIT kept OTHER rows than Postgres's
   * (Postgres walks the base and each row's members in order). Written as an INNER lateral over a list that is never
   * empty — the members, or one NULL (`orNull`) — it is the same rows, and DuckDB runs it as a streaming UNNEST: in the
   * base's order, the members in theirs, stopping at the LIMIT. But it calls the function once per ROW where the
   * delimiter join calls it once per DISTINCT argument, so where every row is read anyway — a count, a GROUP BY, a
   * DISTINCT, a window, a whole result, a sort by the lateral's own column — it is the slower plan (a count over 22 M
   * rows of few distinct documents: 79 s joined, over 200 s streamed; 2.2 s against 62.5 s over 20 M rows of 2,000).
   * So it is written only where the order of the join's rows decides the answer — a LIMIT keeps the first of them, or
   * an aggregate or a window reads them in order (`bounded`: markBounds, limitBounds) — and only for a
   * join that is LEFT, ON a literal TRUE, its right side one function of a list Mason writes (the json rows, an array's
   * unnest: a column's, or an expression's, computed once), without ORDINALITY. A RIGHT or FULL join, another
   * condition, or another function keeps DuckDB's own plan. Such a join a row count on the wire alone would bound
   * (`boundedOnWire`) is left DuckDB's and said (`unboundedLateral`): the listener plans the statement again, bounded,
   * for an Execute that sets one.
   */
  private leftLateral(b: Body): AstNode | null {
    const bounded = this.bounded.has(b);
    if (!bounded && this.boundedOnWire?.has(b) !== true) return null;
    const quals = b.quals as AstNode | undefined;
    if (b.jointype !== "JOIN_LEFT" || b.isNatural === true || b.usingClause !== undefined || quals === undefined || kindOf(quals) !== "A_Const" || bodyOf(quals).boolval?.boolval !== true) return null;
    const rarg = b.rarg as AstNode | undefined;
    if (rarg === undefined || kindOf(rarg) !== "RangeFunction") return null;
    const r = bodyOf(rarg);
    const items = (r.functions ?? []) as AstNode[];
    const calls = items.length === 1 ? (bodyOf(items[0]!).items ?? []) as AstNode[] : [];
    const call = calls[0];
    if (r.ordinality === true || r.is_rowsfrom === true || r.coldeflist !== undefined || call === undefined || kindOf(call) !== "FuncCall") return null;
    const c = bodyOf(call);
    const args = (c.args ?? []) as AstNode[];
    const name = lastName(c.funcname);
    if (args.length !== 1 || c.agg_star === true || c.func_variadic === true || kindOf(args[0]!) === "NamedArgExpr") return null;
    if (!LIST_ROWS.has(name) && name !== "unnest") return null;
    if (!bounded) { this.unboundedLateral = true; return null; }
    this.nonEmpty.add(r);
    const { quals: _true, ...rest } = b;
    // DuckDB 2.0 streams the INNER lateral only where its list reads ONE column of the row, or an array column
    // (measured, docs/DESIGN.md "A LEFT lateral of a list"): one that reads two or more is its delimiter join again,
    // the rows in an order of its own. Such an argument is computed by a step of its own before the lateral, `CROSS
    // JOIN LATERAL (SELECT <arg> AS __mason_arg<n>) AS __mason_arg<n>` (a name no column of the query has) — a
    // projection under the same UNNEST — and the lateral reads the step's one column; so is an unnest's expression of
    // any columns, whose never-empty CASE then names the step's column twice, at no cost but the expression's. Not where the argument reads an array (DuckDB plans that
    // step as a delimiter join, and the lateral streams without it: an unnest's expression is computed once inside,
    // rangeFunction's list_transform), nor where a `*` or a join's name reads every column of the join (the step's
    // would be one of them), nor for a subquery (a delimiter join in every form): `limit-lateral-argument`, decided
    const arg = args[0]!;
    if (kindOf(arg) === "ColumnRef" || this.readWhole.has(b)) return { JoinExpr: { ...rest, jointype: "JOIN_INNER" } };
    const reads = this.rowReads(arg);
    if (reads === null || (reads < 2 && name !== "unnest")) return { JoinExpr: { ...rest, jointype: "JOIN_INNER" } };
    const alias = `__mason_arg${++this.steps}`;
    const sub: Body = { targetList: [{ ResTarget: { name: alias, val: arg } }], op: "SETOP_NONE" };
    this.done.add(sub);
    this.stepArg.set(r, { ColumnRef: { fields: [S(alias), S(alias)] } });
    const step: AstNode = { RangeSubselect: { lateral: true, subquery: { SelectStmt: sub }, alias: { aliasname: alias } } };
    return { JoinExpr: { ...rest, jointype: "JOIN_INNER", larg: { JoinExpr: { jointype: "JOIN_INNER", larg: b.larg, rarg: step } } } };
  }

  /** how many columns of the row an argument reads (each named once), or null where it reads an array, a whole row,
   *  a column whose type Postgres did not say, or holds a subquery: a step before the lateral is no help there
   *  (leftLateral) */
  private rowReads(arg: AstNode): number | null {
    const seen = new Set<string>();
    let plain = true;
    const visit = (v: unknown): void => {
      if (!plain) return;
      if (Array.isArray(v)) { for (const x of v) visit(x); return; }
      if (v === null || typeof v !== "object") return;
      if (isNode(v)) {
        if (kindOf(v) === "SubLink") { plain = false; return; }
        if (kindOf(v) === "ColumnRef") {
          const t = this.typed(v)?.type;
          // an array (a list to DuckDB, whose step it plans as its join) or a row (a struct) reads as no column a
          // step could hold; a user type's array is named `_<type>` in pg_type. A scalar user type (an enum, a
          // domain, citext) is a column like any other
          if (t === undefined || ARRAYS.has(t) || this.enums.arrays.has(t) || this.isRowType(t) || this.userTypes.get(t)?.startsWith("_") === true || t === INET_ARRAY) { plain = false; return; }
          seen.add(JSON.stringify(names(bodyOf(v).fields)));
          return;
        }
      }
      for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) visit(x);
    };
    visit(arg);
    return plain ? seen.size : null;
  }

  /**
   * The joins whose every column the answer reads (leftLateral): those in the FROM of a SELECT whose list holds a bare
   * `*`, and those inside a join that has a name of its own (`(a JOIN b) AS j`, read whole by `j.*` or `j`). A column a
   * step added to one would be a column of the answer that Postgres's has not.
   */
  markWholeReads(root: AstNode): void {
    const joins = (x: unknown): void => {
      if (!isNode(x) || kindOf(x) !== "JoinExpr") return;
      const j = bodyOf(x);
      this.readWhole.add(j);
      joins(j.larg); joins(j.rarg);
    };
    const bareStar = (t: unknown): boolean => {
      const v = isNode(t) ? bodyOf(t).val : undefined;
      if (!isNode(v) || kindOf(v) !== "ColumnRef") return false;
      const fields = (bodyOf(v).fields ?? []) as AstNode[];
      return fields.length === 1 && kindOf(fields[0]!) === "A_Star";
    };
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) visit(x); return; }
      if (v === null || typeof v !== "object") return;
      if (isNode(v)) {
        const b = bodyOf(v);
        if (kindOf(v) === "SelectStmt" && ((b.targetList ?? []) as unknown[]).some(bareStar)) for (const f of (b.fromClause ?? []) as unknown[]) joins(f);
        if (kindOf(v) === "JoinExpr" && b.alias !== undefined) joins(v);
      }
      for (const [k, x] of Object.entries(isNode(v) ? bodyOf(v) : v as Body)) visit(armOf(k, x) ?? x);
    };
    visit(root);
  }

  private rangeFunction(b: Body): AstNode | null {
    const items = (b.functions ?? []) as AstNode[];
    const first = items[0] !== undefined ? (bodyOf(items[0]).items as AstNode[] | undefined)?.[0] : undefined;
    if (first === undefined || kindOf(first) !== "FuncCall") return null;
    const call = bodyOf(first);
    const name = lastName(call.funcname);
    // a LEFT lateral's argument computed by a step of its own before it (leftLateral): its column, in its place
    const stepped = this.stepArg.get(b);
    const args = stepped !== undefined ? [stepped] : (call.args ?? []) as AstNode[];
    const alias = b.alias as Body | undefined;
    const aliasName = alias?.aliasname as string | undefined;
    const colnames = names(alias?.colnames);
    for (const item of items) for (const f of (bodyOf(item).items ?? []) as AstNode[]) if (isNode(f) && kindOf(f) === "FuncCall") this.inFrom.add(bodyOf(f));
    const canonical = name.startsWith("jsonb");
    // the right side of a LEFT JOIN … ON TRUE whose rows are a list: written never empty (leftLateral)
    const orNull = this.nonEmpty.has(b);
    switch (name) {
      // jsonpath's rows, as Postgres finds them (src/duck/pg-eval.ts), unnested
      case "jsonb_path_query": {
        if (b.ordinality === true) throw new Unrewritable(`${name}() WITH ORDINALITY is not supported by Mason`, "number the rows with row_number() OVER () instead", "with-ordinality");
        if (args.length < 2 || args.length > 4 || args.some((a) => kindOf(a) === "NamedArgExpr")) return null;
        const list = pgCall("list", `ARRAY(SELECT mason_p::text FROM jsonb_path_query(${args.map((_, i) => `a${i + 1}::${JSONPATH_ARGS[i]}`).join(", ")}) AS mason_p)`, args);
        const column = colnames[0] ?? aliasName ?? name;
        const item = bodyOf(items[0]!);
        return { RangeFunction: { ...b, functions: [{ List: { ...item, items: [fn("unnest", [arrayCast(list, "json")]), ...(item.items as unknown[]).slice(1)] } }], alias: { aliasname: aliasName ?? name, colnames: [S(column)] } } };
      }
      case "jsonb_array_elements": case "json_array_elements": case "jsonb_array_elements_text": case "json_array_elements_text": {
        if (b.ordinality === true) throw new Unrewritable(`${name}() WITH ORDINALITY is not supported by Mason`, "number the elements with row_number() OVER () instead", "with-ordinality");
        const text = name.endsWith("_text");
        const elements = fn("__mason_json_elements", [jsonArg(args[0]!), boolConst(canonical), boolConst(text), boolConst(orNull)]);
        const list = text ? elements : arrayCast(elements, "json");
        // its column is its OUT parameter's, `value`, under a FROM name too (`e.value`), unless the alias names it;
        // the FROM name alone is the element (the ColumnRef rule: Typed.functionColumn)
        const column = colnames[0] ?? "value";
        const unnest: AstNode = fn("unnest", [list]);
        if (orNull) return listLateral([{ name: column, list }], aliasName ?? name, this.done);
        const item = bodyOf(items[0]!);
        return { RangeFunction: { ...b, functions: [{ List: { ...item, items: [unnest, ...(item.items as unknown[]).slice(1)] } }], alias: { aliasname: aliasName ?? name, colnames: [S(column)] } } };
      }
      case "generate_series": {
        // a series of times as DuckDB's list, unnested: its table function of times answers no rows for EVERY outer row
        // once one row's series is empty, when correlated (a LATERAL or a subquery; DuckDB 2.0.0, threads or none),
        // where the list form and the series of integers are right
        const type = this.typed({ FuncCall: call })?.type ?? null;
        if (items.length !== 1 || (type !== TIMESTAMP && type !== TIMESTAMPTZ)) return null;
        if (b.ordinality === true) throw new Unrewritable(`${name}() of times WITH ORDINALITY is not supported by Mason`, "number the rows with row_number() OVER (ORDER BY the value) instead", "with-ordinality");
        const column = colnames[0] ?? aliasName ?? name;
        const item = bodyOf(items[0]!);
        return { RangeFunction: { ...b, functions: [{ List: { ...item, items: [fn("unnest", [first]), ...(item.items as unknown[]).slice(1)] } }], alias: { aliasname: aliasName ?? name, colnames: [S(column)] } } };
      }
      case "jsonb_to_record": case "json_to_record": {
        // each column as Postgres reads it from the object (src/duck/pg-eval.ts, a chunk at a time), in a lateral row
        const defs = ((b.coldeflist ?? []) as AstNode[]).map((d) => bodyOf(d));
        if (defs.length === 0 || args.length !== 1 || b.ordinality === true) return null;
        const spelled = defs.map((d) => ({ name: String(d.colname), ...recordColumn(d.typeName as Body | undefined) }));
        const bad = spelled.find((c) => c.read === null);
        if (bad !== undefined) throw new Unrewritable(`${name}() with a column of type ${bad.spelled} is not supported by Mason`, "read the column as text and cast it outside: AS x(c text)", "unverified");
        const list = spelled.map((c) => `"${c.name.replaceAll('"', '""')}" ${c.spelled}`).join(", ");
        const sub: Body = {
          targetList: spelled.map((c) => {
            const [kind, duck] = c.read!;
            const call = pgCall(kind, `(SELECT mason_r."${c.name.replaceAll('"', '""')}" FROM ${name}(a1::${canonical ? "jsonb" : "json"}) AS mason_r(${list}))`, [this.clone(args[0]!)]);
            return { ResTarget: { name: c.name, val: duck === null ? call : cast(call, duck) } };
          }),
          op: "SETOP_NONE",
        };
        this.done.add(sub);
        return { RangeSubselect: { lateral: true, subquery: { SelectStmt: sub }, alias: { aliasname: aliasName ?? name } } };
      }
      case "jsonb_each": case "json_each": case "jsonb_each_text": case "json_each_text": {
        if (b.ordinality === true) throw new Unrewritable(`${name}() WITH ORDINALITY is not supported by Mason`, "number the members with row_number() OVER () instead", "with-ordinality");
        const text = name.endsWith("_text");
        // each member's key and value, two lists of one length that unnest side by side
        return listLateral([
          { name: colnames[0] ?? "key", list: fn("__mason_json_keys", [jsonArg(args[0]!), boolConst(canonical), boolConst(orNull)]) },
          { name: colnames[1] ?? "value", list: fn("__mason_json_values", [this.clone(args[0]!), boolConst(canonical), boolConst(text), boolConst(orNull)]) },
        ], aliasName ?? name, this.done);
      }
      case "jsonb_object_keys": case "json_object_keys": {
        const column = colnames[0] ?? aliasName ?? name;
        const keys = fn("__mason_json_keys", [args[0]!, boolConst(canonical), boolConst(orNull)]);
        if (orNull) return listLateral([{ name: column, list: keys }], aliasName ?? name, this.done);
        const item = bodyOf(items[0]!);
        return { RangeFunction: { ...b, functions: [{ List: { ...item, items: [fn("unnest", [keys]), ...(item.items as unknown[]).slice(1)] } }], alias: { aliasname: aliasName ?? name, colnames: [S(column)] } } };
      }
      // an array's elements, never empty: its list where it has one, else one NULL (leftLateral). The CASE names the
      // list twice: a column's (or the column of the step leftLateral computed the expression in) costs nothing
      // twice; an expression left here (it reads an array, holds a subquery, or a `*` reads the join) would be
      // computed twice (a call of Mason's string_to_array a row more), so it is computed ONCE, the one element of a
      // list whose lambda names it twice: `list_transform(list_value(<expr>), __mason_l -> CASE … __mason_l …
      // END)[1]`, a copy of its list a row more, the same streaming UNNEST (measured: docs/DESIGN.md "A LEFT lateral
      // of a list")
      case "unnest": {
        if (!orNull) return null;
        const list = args[0]!;
        const column = colnames[0] ?? aliasName ?? name;
        const never = (l: () => AstNode): AstNode => caseWhen([[op(">", fn("len", [l()]), intConst(0)), l()]], arrayOf([nullConst()]));
        const each = (): AstNode => ({ ColumnRef: { fields: [S("__mason_l")] } });
        const once = kindOf(list) === "ColumnRef" ? never(() => this.clone(list))
          : { A_Indirection: { arg: fn("list_transform", [fn("list_value", [list]), op("->", each(), never(each))]), indirection: [{ A_Indices: { uidx: intConst(1) } }] } };
        return listLateral([{ name: column, list: once }], aliasName ?? name, this.done);
      }
      default: return null;
    }
  }
}

// ---------------------------------------------------------------------------------------------------- helpers

/** a deep copy that stays the statement's own: each helper below that uses a node twice is handed its rewriter's */
type Copy = <T>(n: T) => T;

/**
 * THE NULLS-PLACEMENT IDIOM AS ONE KEY (docs/DESIGN.md "Nulls placed by a key of their own"): `ORDER BY x IS NULL,
 * x DESC` — nulls last, written without NULLS LAST, as SQL that must also run where NULLS LAST is not grammar — orders
 * exactly as `ORDER BY x DESC NULLS LAST`. DuckDB's top N cannot push its threshold into the scan of an expression key,
 * so it read every row of a 197 M-row copy for a 100-row page (6.4 s by a timestamp; 91 s by a text id, cut off by
 * the tool); one plain key with its NULLS placement is pruned by the zone maps. So a pair of CONSECUTIVE keys, the
 * first `<e> IS [NOT] NULL` (either direction, no USING) and the second the same `<e>` (the same tree, parentheses
 * being no node of it), is one key on `<e>` with the second's direction and the nulls where the first put them: `IS
 * NULL ASC` and `IS NOT NULL DESC` last, `IS NULL DESC` and `IS NOT NULL ASC` first. Every other key stays in place.
 * Not under a DISTINCT ON, whose expressions must lead the ORDER BY as written, and never a window's ORDER BY.
 */
function nullsKeyFolded(keys: AstNode[], select: Body): AstNode[] {
  const distinctOn = Array.isArray(select.distinctClause) && (select.distinctClause as unknown[]).some((d) => isNode(d));
  if (distinctOn || keys.length < 2) return keys;
  const out: AstNode[] = [];
  for (let i = 0; i < keys.length; i++) {
    const first = keys[i]!, second = keys[i + 1];
    const a = kindOf(first) === "SortBy" ? bodyOf(first) : null, b = second !== undefined && kindOf(second) === "SortBy" ? bodyOf(second) : null;
    const test = a !== null && isNode(a.node) && kindOf(a.node) === "NullTest" ? bodyOf(a.node) : null;
    if (a === null || b === null || test === null || a.useOp !== undefined || b.useOp !== undefined || !isNode(test.arg) || !alikeTree(test.arg, b.node)
      || !bareKeyIsInput(test.arg, b.node as AstNode, select)) { out.push(first); continue; }
    const last = (test.nulltesttype === "IS_NULL") === (a.sortby_dir !== "SORTBY_DESC");
    out.push({ SortBy: { ...b, sortby_nulls: last ? "SORTBY_NULLS_LAST" : "SORTBY_NULLS_FIRST" } });
    i++;
  }
  return out;
}

/**
 * Whether an ORDER BY key read BARE is the same value as the same tree read inside an expression (the `x` of `x IS
 * NULL`), where Postgres reads them by two rules (findTargetlistEntrySQL92, parse_clause.c): inside an expression a name
 * is always an input column, while a bare key that is an integer constant is an output column by its position (`ORDER
 * BY 2`), and a bare one-part name that is an output column's name is that output column (`SELECT coalesce(x, 0) AS x
 * … ORDER BY x`). Every other node is read alike either way. So a constant is never, and a one-part name is only
 * where no output column may bear its name or every one that may is the same tree as the input's (`SELECT x … ORDER BY
 * x`). An output column's name is its alias, else Postgres's FigureColname (a CASE's may be its ELSE's).
 */
function bareKeyIsInput(inner: AstNode, bare: AstNode, select: Body): boolean {
  if (kindOf(bare) === "A_Const") return false;
  if (kindOf(bare) !== "ColumnRef") return true;
  const fields = (bodyOf(bare).fields ?? []) as AstNode[];
  if (fields.length !== 1 || kindOf(fields[0]!) !== "String") return true;
  const name = String(bodyOf(fields[0]!).sval);
  return ((select.targetList ?? []) as AstNode[]).every((t) => {
    const r = bodyOf(t), val = r.val as AstNode | undefined;
    if (val === undefined) return true;
    // `*` and `t.*` are the input columns themselves
    const last = kindOf(val) === "ColumnRef" ? ((bodyOf(val).fields ?? []) as AstNode[]).at(-1) : undefined;
    if (last !== undefined && kindOf(last) === "A_Star") return true;
    // every target is named by now: its alias, else Postgres's name for it (nameTargets, figureColname)
    return (typeof r.name === "string" && r.name !== name) || alikeTree(val, inner);
  });
}

/** two trees alike but for where their text stood (`location`): `(x)` and `x` are one tree, parentheses no node */
function alikeTree(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => alikeTree(x, b[i]));
  if (a === null || typeof a !== "object") return a === b;
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => k !== "location"), kb = Object.keys(b).filter((k) => k !== "location");
  return ka.length === kb.length && ka.every((k) => alikeTree((a as Body)[k], (b as Body)[k]));
}

/** the json functions whose rows Mason writes as lists in FROM (src/duck/rewrite.ts rangeFunction), each with an
 *  `orNull` form (src/duck/functions.ts) */
const LIST_ROWS = new Set(["jsonb_each", "json_each", "jsonb_each_text", "json_each_text", "jsonb_array_elements", "json_array_elements",
  "jsonb_array_elements_text", "json_array_elements_text", "jsonb_object_keys", "json_object_keys"]);

/** `LATERAL (SELECT unnest(<list>) AS <name>, …) AS <alias>`: lists of one length unnested side by side, a subquery
 *  DuckDB runs as its UNNEST operator when the join is INNER (leftLateral) */
function listLateral(columns: Array<{ name: string; list: AstNode }>, alias: string, done: WeakSet<Body>): AstNode {
  const sub: Body = { targetList: columns.map((c) => ({ ResTarget: { name: c.name, val: fn("unnest", [c.list]) } })), op: "SETOP_NONE" };
  done.add(sub);
  return { RangeSubselect: { lateral: true, subquery: { SelectStmt: sub }, alias: { aliasname: alias } } };
}

type Built = { p: NumericProgram; kind: "int" | "numeric" };
/** a cell an exact program cannot take (in a grouped SELECT, a column not grouped): the column stays DuckDB's */
const NOT_EXACT = new Error("not exact");
/** the engine's integer types, as the rewrite casts to them (`duckExact`: an integer is exact) */
const DUCK_INTEGER_NAMES = new Set(["tinyint", "smallint", "integer", "int", "bigint", "hugeint", "int2", "int4", "int8"]);
/** the functions whose value is one of their first argument's (or its sum), in its own type (`duckExact`) */
const VALUE_KEEPING = new Set(["sum", "min", "max", "latest", "any_value", "first", "arg_min_null", "arg_max_null", "lag", "lead", "first_value", "last_value", "nth_value"]);
/** the numeric functions the walk writes as an exact DECIMAL or integer (`duckExact`): count, extract (`extract`: as
 *  the exact numeric Postgres returns), div of integers */
const WRITTEN_EXACT = new Set(["count", "extract", "div"]);
/** the array functions that read an array's shape, never its elements (`elementsUnread`) */
const ELEMENT_BLIND = new Set(["array_length", "cardinality", "array_ndims", "array_lower", "array_upper"]);
/** Mason's functions whose text is an exact decimal's, which a DECIMAL cast reads exactly (`summed`'s parts) */
const EXACT_TEXTS = new Set(["__mason_numeric_exact"]);

/** a SELECT list item that is `*` or `t.*` */
/** a set operation's arm (libpg-query's `larg` / `rarg`: a SelectStmt's body, unwrapped), as the node it is */
const armOf = (key: string, v: unknown): AstNode | null =>
  (key === "larg" || key === "rarg") && v !== null && typeof v === "object" && !Array.isArray(v) && !isNode(v) ? { SelectStmt: v as Body } : null;

/** the aggregates whose answer follows the order their rows come in, without an ORDER BY of their own (readsInOrder) */
const IN_ORDER_AGGREGATES = new Set(["string_agg", "array_agg", "json_agg", "jsonb_agg", "json_agg_strict", "jsonb_agg_strict", "json_object_agg",
  "jsonb_object_agg", "json_object_agg_strict", "jsonb_object_agg_strict", "json_object_agg_unique", "jsonb_object_agg_unique",
  "json_object_agg_unique_strict", "jsonb_object_agg_unique_strict", "xmlagg"]);
/** the window functions that read their frame in order: over a window with no ORDER BY, the order the rows come in */
const IN_ORDER_WINDOWS = new Set(["row_number", "ntile", "lag", "lead", "first_value", "last_value", "nth_value"]);

/** whether an expression holds a window function (outside a subquery) */
const hasWindow = (v: unknown): boolean => Array.isArray(v) ? v.some(hasWindow)
  : v === null || typeof v !== "object" ? false
  : isNode(v) ? kindOf(v) !== "SubLink" && ((kindOf(v) === "FuncCall" && bodyOf(v).over !== undefined) || Object.values(bodyOf(v)).some(hasWindow))
  : Object.values(v as Body).some(hasWindow);

/** one output column of a SELECT (Rewriter.outputs): the target it comes from, its name, what it reads, and whether a `*` lists it */
/** one output column: its target, and its place among the outputs (a `*` is one per column) */
/** an output of a SELECT; `row`: a row value, which the list writes as its text (`rowValues`) */
type Output = { target: number; at: number; name: string; value: AstNode; star: boolean; twin: boolean; row: boolean };
/** a time Postgres casts to a timetz where the rewrite cannot write the cast (`coerceImplicit`, `castArms`) */
function refuseTimetz(): never {
  throw new Unrewritable("a time beside a timetz here is not supported by Mason (Postgres casts the time to a timetz, which Mason cannot write in this place)", "cast the time: tm::timetz", "time-timetz-coerced");
}
const hasStar = (v: unknown): boolean => isNode(v) && kindOf(v) === "ColumnRef" && (bodyOf(v).fields as AstNode[]).some((f) => kindOf(f) === "A_Star");

/** whether a program of a value the engine holds exactly (`duckExact`, asked first) writes what DuckDB would write
 *  otherwise: a rounding, a scale chosen per value, a parameter's text; a sum, a difference or a product of DuckDB's
 *  decimals is DuckDB's own right answer */
/** whether a positional decimal literal (`-1.50`) fits numeric(precision, scale) as it is: no decimal past the scale,
 *  no more whole digits than precision - scale (so the cast neither rounds nor overflows) */
function literalFits(text: string, precision: number, scale: number): boolean {
  const m = /^[+-]?(\d*)(?:\.(\d*))?$/.exec(text);
  if (m === null || precision > 38) return false;
  const whole = (m[1] ?? "").replace(/^0+/, ""), decimals = m[2] ?? "";
  return decimals.length <= scale && whole.length <= precision - scale;
}

/** whether a program computes digits the engine's own arithmetic would not: once per DISTINCT node (a program is never
 *  changed once made, and a node several parents share is asked once: src/lib/pg-numeric.ts) */
function worthComputing(p: NumericProgram): boolean {
  const known = WORTH.get(p);
  if (known !== undefined) return known;
  let v: boolean;
  switch (p.op) {
    // a parameter's cell is its text: DuckDB computes with it as a double
    case "cell": v = p.key.startsWith("$"); break;
    case "literal": v = false; break;
    // DuckDB's decimals may be fewer than Postgres's (src/duck/sync.ts copies a numeric(65,30) at its values' scale)
    case "pad": v = true; break;
    case "add": case "sub": case "mul": v = worthComputing(p.args[0]) || worthComputing(p.args[1]); break;
    case "neg": case "abs": v = worthComputing(p.arg); break;
    default: v = true;
  }
  WORTH.set(p, v);
  return v;
}
const WORTH = new WeakMap<NumericProgram, boolean>();

/** the program with each cell's key moved by `by` (the cells of the columns before it), its sharing kept (`mapCells`) */
function offsetCells(p: NumericProgram, by: number): NumericProgram {
  if (by === 0) return p;
  const cells = new Map<string, NumericProgram>();
  return mapCells(p, (key) => {
    let c = cells.get(key);
    if (c === undefined) { c = key.startsWith("$") ? { op: "cell", key } : { op: "cell", key: String(Number(key) + by) }; cells.set(key, c); }
    return c;
  });
}

/** an expression without the casts around it */
function stripCasts(n: AstNode): AstNode {
  return kindOf(n) === "TypeCast" && isNode(bodyOf(n).arg) ? stripCasts(bodyOf(n).arg as AstNode) : n;
}

/** whether a value is a NULL, cast or not (`NULL::numeric`): it writes no scale */
function isNullValue(v: unknown): boolean {
  return isNode(v) && kindOf(stripCasts(v)) === "A_Const" && bodyOf(stripCasts(v)).isnull === true;
}

/** whether a SELECT is a set operation (UNION, INTERSECT, EXCEPT) */
function isSetOp(s: Body): boolean { return s.op !== undefined && s.op !== "SETOP_NONE"; }

/** a set operation's arm as a SelectStmt's body (libpg-query writes the arms unwrapped) */
function unwrappedArm(x: unknown): Body { return isNode(x) ? bodyOf(x) : x as Body; }

/** a hidden cell riding beside a FROM item's columns, read outside it (`carry`, `exactThrough`): `s.__mason_cell_0` */
function isCellRef(n: AstNode, prefix: string): boolean {
  if (kindOf(n) !== "ColumnRef") return false;
  const f = (bodyOf(n).fields ?? []) as AstNode[];
  return f.length === 2 && kindOf(f[1]!) === "String" && String(bodyOf(f[1]!).sval).startsWith(prefix);
}

/** a set operation's clauses of its own, which make it one SELECT of the set operation around it (Postgres's analysis
 *  makes it a subquery there; libpg-query writes it unwrapped) */
function ownClauses(s: Body): boolean {
  return ["sortClause", "limitCount", "limitOffset", "lockingClause", "withClause"].some((k) => s[k] !== undefined);
}

/** a SELECT list's entry that is a hidden cell an exact column reads (`exactColumns`, a pass-through's, `exactArms`) */
function isCellTarget(t: AstNode, prefix: string): boolean {
  return String(bodyOf(t).name ?? "").startsWith(prefix);
}

/** a scalar subquery's one column, where it is a plain query's (not a set operation's, not a `*`) */
function scalarTarget(n: AstNode): AstNode | null {
  const b = bodyOf(n);
  if (kindOf(n) !== "SubLink" || b.subLinkType !== "EXPR_SUBLINK" || !isNode(b.subselect)) return null;
  const q = bodyOf(b.subselect);
  if (q.op !== undefined && q.op !== "SETOP_NONE") return null;
  const targets = (q.targetList ?? []) as AstNode[];
  const v = targets.length === 1 ? bodyOf(targets[0]!).val : undefined;
  return isNode(v) && !hasStar(v) ? v : null;
}


/** a query level as `scopeColumns` meets it: the query and the WITH queries it declares */
interface Frame { select: Body; ctes: AstNode[]; recursive: boolean }

/** the WITH query a FROM name reads, from the innermost query outwards (a nearer one of the name shadows a farther) */
function cteIn(frames: readonly Frame[], name: string): { cte: AstNode; recursive: boolean } | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const cte = frames[i]!.ctes.find((c) => bodyOf(c).ctename === name);
    if (cte !== undefined) return { cte, recursive: frames[i]!.recursive };
  }
  return null;
}

/** a FROM list's items, through its joins (a join's own name is no item: what it joins is read by that name) */
function fromLeaves(from: unknown): AstNode[] {
  if (!Array.isArray(from)) return [];
  return (from as AstNode[]).flatMap((f): AstNode[] => !isNode(f) ? [] : kindOf(f) === "JoinExpr"
    ? [...fromLeaves([bodyOf(f).larg]), ...fromLeaves([bodyOf(f).rarg])] : [f]);
}

/** a FROM list's joins */
function fromJoins(from: unknown): AstNode[] {
  if (!Array.isArray(from)) return [];
  return (from as AstNode[]).flatMap((f): AstNode[] => !isNode(f) || kindOf(f) !== "JoinExpr" ? []
    : [f, ...fromJoins([bodyOf(f).larg]), ...fromJoins([bodyOf(f).rarg])]);
}

/** an expression's shape: its tree without offsets */
/** a node without its offsets (`location`, and an ARRAY[…]'s `list_start` and `list_end`): two spellings of one expression at two places */
const shapeOf = (n: AstNode): string => JSON.stringify(n, (k, v: unknown) => k === "location" || k === "list_start" || k === "list_end" ? undefined : v);

const strip = (n: AstNode): AstNode => kindOf(n) === "CollateClause" ? bodyOf(n).arg as AstNode : n;

/** glibc's order of the libc collation `collate` (its collcollate), as the source was MEASURED to order text
 *  (src/duck/libc-order.ts: its levels as one text; the engine holds one order per collcollate, told by name), then
 *  the bytes, as Postgres breaks a tie */
function libcKeys(copy: Copy, e: AstNode, collate: string): AstNode[] {
  return [fn("__mason_libc_key", [copy(e), strConst(collate)]), e];
}

/** the libc keys as ONE text that orders as they do: the key, a space (below every hex digit, so a shorter key
 *  orders first), the value's own bytes in hex */
function libcKey(copy: Copy, e: AstNode, collate: string): AstNode {
  const [key, bytes] = libcKeys(copy, e, collate) as [AstNode, AstNode];
  return concat(key, strConst(" "), fn("hex", [bytes]));
}

/** a text's ICU key as ONE text that orders as Postgres does: ICU's, then, where ICU ties two strings, their bytes */
function icuKey(copy: Copy, e: AstNode, name: string): AstNode {
  return concat(fn("icu_sort_key", [copy(e), strConst(name)]), strConst(" "), fn("hex", [e]));
}

/** Postgres's array types whose elements are DuckDB's of these names */
/**
 * A date's or timestamp's datum (src/duck/pgtree.ts `datumBytes`) as ISO text DuckDB reads back to the same value: a
 * date is days since 2000-01-01 (int32), a timestamp microseconds (int64), little-endian; a year before 1 is
 * astronomical (`-0043` is 44 BC), a timestamptz's in UTC (`+00`). Null where the bytes are not one.
 */
/** an IPv6 address as Postgres writes it (inet_net_ntop): the longest run of two or more zero words as `::` (the first
 *  such run), hex words without leading zeros, and an IPv4-compatible or -mapped address's tail in dotted form */
export function ipv6Text(addr: readonly number[]): string {
  const words = Array.from({ length: 8 }, (_, i) => (addr[2 * i]! << 8) | addr[2 * i + 1]!);
  let best = { base: -1, len: 0 }, cur = { base: -1, len: 0 };
  words.forEach((w, i) => {
    if (w === 0) { if (cur.base < 0) cur = { base: i, len: 1 }; else cur.len++; }
    else if (cur.base >= 0) { if (best.base < 0 || cur.len > best.len) best = cur; cur = { base: -1, len: 0 }; }
  });
  if (cur.base >= 0 && (best.base < 0 || cur.len > best.len)) best = cur;
  if (best.base >= 0 && best.len < 2) best = { base: -1, len: 0 };
  const dotted = best.base === 0 && (best.len === 6 || (best.len === 5 && words[5] === 0xffff) || (best.len === 7 && words[7] !== 1));
  let out = "";
  for (let i = 0; i < 8; i++) {
    if (best.base >= 0 && i >= best.base && i < best.base + best.len) { if (i === best.base) out += "::"; continue; }
    if (i !== 0 && !out.endsWith(":")) out += ":";
    if (i === 6 && dotted) { out += addr.slice(12, 16).join("."); break; }
    out += words[i]!.toString(16);
  }
  return out;
}

/** an inet's output text: a full mask dropped (`/32` of an IPv4, `/128` of an IPv6), as inet_out writes it */
const inetOut = (n: AstNode): AstNode =>
  fn("regexp_replace", [fn("regexp_replace", [n, strConst("^([0-9.]+)/32$"), strConst("\\1")]), strConst("^([0-9a-f:.]+)/128$"), strConst("\\1")]);

/** An interval's datum: microseconds (int64), days, months (int32), little-endian; null for an infinite one, which
 *  DuckDB has no counterpart of */
export function intervalDatum(bytes: readonly number[]): { months: number; days: number; micros: bigint } | null {
  if (bytes.length !== 16) return null;
  const le = (at: number, n: number): bigint => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]!); return BigInt.asIntN(n * 8, v); };
  const micros = le(0, 8), days = Number(le(8, 4)), months = Number(le(12, 4));
  if (months === 2147483647 || months === -2147483648) return null;
  return { months, days, micros };
}

export function datumText(type: number, bytes: readonly number[]): string | null {
  const le = (n: number): bigint => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]!); return BigInt.asIntN(n * 8, v); };
  const civil = (days: bigint): string => {
    // days since 1970-01-01 → a proleptic Gregorian date (Howard Hinnant's civil_from_days)
    const z = days + 719468n, era = (z >= 0n ? z : z - 146096n) / 146097n, doe = z - era * 146097n;
    const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n, doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
    const mp = (5n * doy + 2n) / 153n, d = doy - (153n * mp + 2n) / 5n + 1n, m = mp < 10n ? mp + 3n : mp - 9n;
    const y = yoe + era * 400n + (m <= 2n ? 1n : 0n);
    const year = y < 0n ? `-${String(-y).padStart(4, "0")}` : String(y).padStart(4, "0");
    return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  if (type === INET) {
    // a varlena: a 4-byte header, the family (2 IPv4, 3 IPv6), the mask's bits, the address
    if (bytes.length < 10) return null;
    const family = bytes[4], bits = bytes[5], addr = bytes.slice(6);
    if (family === 2 && addr.length >= 4) return `${addr.slice(0, 4).join(".")}/${bits}`;
    if (family === 3 && addr.length >= 16) return `${ipv6Text(addr.slice(0, 16))}/${bits}`;
    return null;
  }
  if (type === DATE) {
    if (bytes.length !== 4) return null;
    const v = le(4);
    if (v === -2147483648n) return "-infinity";
    if (v === 2147483647n) return "infinity";
    return civil(v + 10957n);
  }
  if (bytes.length !== 8) return null;
  const v = le(8);
  if (v === -(1n << 63n)) return "-infinity";
  if (v === (1n << 63n) - 1n) return "infinity";
  const micros = v + 946_684_800_000_000n, day = 86_400_000_000n;
  const days = micros >= 0n ? micros / day : -((-micros + day - 1n) / day), rest = micros - days * day;
  const hh = rest / 3_600_000_000n, mm = (rest / 60_000_000n) % 60n, ss = (rest / 1_000_000n) % 60n, us = rest % 1_000_000n;
  const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(us).padStart(6, "0")}`;
  return `${civil(days)} ${time}${type === TIMESTAMPTZ ? "+00" : ""}`;
}

/** an array type whose elements' DuckDB text is Postgres's, and how each is written into json: smallint, integer, bigint
 *  and boolean as they are, text, varchar and uuid as strings, jsonb canonical, json as written */
const JSON_ARRAY_ELEMENT: Record<number, JsonKind> = { 1005: "r", 1007: "r", 1016: "r", 1000: "r", 1009: "s", 1015: "s", 2951: "s", 3807: "k", 199: "r" };
const ARRAY_DUCK: Record<number, string> = { 1009: "varchar", 1015: "varchar", 1014: "varchar", 1007: "integer", 1016: "bigint", 1005: "smallint", 1022: "double", 1021: "real", 1000: "boolean", 1182: "date", 1115: "timestamp", 1185: "timestamptz", 2951: "uuid" };

/** (a1, b1) OVERLAPS (a2, b2), as Postgres's overlaps_timestamp decides it, NULLs included: each period's ends in
 *  order (a NULL start takes the end's place), then the SQL standard's cases */
function overlaps(copy: Copy, a1: AstNode, b1: AstNode, a2: AstNode, b2: AstNode): AstNode {
  const start = (a: AstNode, b: AstNode): AstNode => caseWhen([[isNull(copy(a)), copy(b)], [and([isNotNull(copy(b)), op(">", copy(a), copy(b))]), copy(b)]], copy(a));
  const end = (a: AstNode, b: AstNode): AstNode => caseWhen([[isNull(copy(a)), nullConst()], [and([isNotNull(copy(b)), op(">", copy(a), copy(b))]), copy(a)]], copy(b));
  const s1 = (): AstNode => start(a1, b1), e1 = (): AstNode => end(a1, b1), s2 = (): AstNode => start(a2, b2), e2 = (): AstNode => end(a2, b2);
  const T = boolConst(true), F = (): AstNode => boolConst(false);
  return caseWhen([
    [or([isNull(s1()), isNull(s2())]), nullConst()],
    [op(">", s1(), s2()), caseWhen([[isNull(e2()), nullConst()], [op("<", s1(), e2()), T], [isNull(e1()), nullConst()]], F())],
    [op("<", s1(), s2()), caseWhen([[isNull(e1()), nullConst()], [op("<", s2(), e1()), boolConst(true)], [isNull(e2()), nullConst()]], F())],
  ], caseWhen([[or([isNull(e1()), isNull(e2())]), nullConst()]], boolConst(true)));
}

/**
 * A json read by its steps (a JSON array of keys and indexes, src/duck/functions.ts jsonGet), native where DuckDB's
 * answer is Postgres's, the function's for the rest.
 *
 * THE FUNCTION IS A HOP TO THE MAIN THREAD PER VECTOR (the test server: 4.5 µs a row, a `->>` over 22 M
 * rows took 98 s and every other session, the stream and the commands waited for it). A `->>` / `#>>` of a column
 * is answered by DuckDB's own JSON reader where that reader answers exactly as Postgres does — a STRING value is the
 * same text from json_extract_string as from the function, a missing path (json_type's NULL) or a JSON null (its
 * 'NULL') is SQL NULL on both — and by
 * the function for every other value (a number, whose digits Postgres keeps as written where DuckDB writes `7.0`; an
 * object or an array, whose spacing is Postgres's): the CASE's ELSE, which DuckDB evaluates on those rows only
 * (measured: 10,000 number rows of 100,000 reached the function, in 49 vectors). Measured over 5 M rows: 3.85 s
 * through the function, 0.10 s native.
 *  - Only a COLUMN's json is read natively (a chain of reads off one included, folded into one read: jsonChain): a literal
 *    or an expression cast to json is validated by Postgres's rules inside the function, where DuckDB's parser would
 *    refuse it in its own words.
 *  - A document may hold a key twice, of which Postgres reads the LAST and DuckDB the first: the read is native only
 *    where every object on the way holds each key once (json_keys at each step), unless `keysOnce` says the text holds
 *    each once — jsonb's canonical text as the copy holds it (a copied table's column, Rewriter.jsonRead). A `json`
 *    column is the document as written; a jsonb the statement computes (jsonb_object_agg, jsonb_build_object) is the
 *    rewrite's text, a key twice included (a review finding).
 *  - `j` is placed in every arm of the CASE, and each placement is its own copy (`copy`, the rewriter's clone): the
 *    walker runs a node's rule once, so a node placed twice would be qualified or renamed in its first place alone
 *    (`"Doc"` beside another table's `doc` was ambiguous to DuckDB, 42804; a review finding).
 *  - Steps are keys only: an index, or a `#>` element that reads as one (pathIndex, the function's own definition: ` 1`
 *    and `+1` are, `1 ` is not), stays the function's (a negative one counts from the end, and jsonb reads a scalar as
 *    a one-element array). A pointer reads only an all-digit element as an index, so every other element is a key to
 *    it, as to Postgres. The path is a JSON pointer (`/a/b`, `~` and `/`
 *    escaped), which takes every key — except an all-digit key, which a pointer reads as an index on an array where
 *    Postgres reads NULL: a path with one is JSONPath's quoted keys, which cannot say `*` (a wildcard even quoted)
 *    or an empty key, so those stay the function's.
 * `->` (the json itself) is DuckDB's own only off a copied jsonb, where each key is held once, and only for a value whose
 * text DuckDB writes as Postgres does (jsonValueRead); a json column's `->` is the document as written, the function's.
 * tests/duck-wire.test.ts "a ->> of a column is DuckDB's own read" holds the answers and counts the hops.
 */
function jsonGet(copy: Copy, j: AstNode, steps: AstNode, either: boolean, canonical: boolean, asText: boolean, keysOnce: boolean): AstNode {
  const call = fn("__mason_json_get", [jsonArg(copy(j)), steps, boolConst(either), boolConst(canonical), boolConst(asText)]);
  if (kindOf(j) !== "ColumnRef") return call;
  const keys = stepKeys(steps, either);
  if (keys === null || keys.length === 0) return call;
  const path = duckJsonPath(keys);
  if (path === null) return call;
  // `->` (the value's own text): only where the text holds each key once (a copied jsonb), read by ONE extraction
  if (!asText) return keysOnce ? jsonValueRead(copy, j, path, call) : call;
  const pointer = jsonPointer;
  const type = (): AstNode => fn("json_type", [copy(j), strConst(path)]);
  // each object on the way holds every key once (json_keys of an array or a scalar is empty, of a missing path NULL:
  // the read there is NULL on both sides, so both pass)
  // (made again for each arm that tests it: every node is placed once)
  const once = (): AstNode[] => keysOnce ? [] : keys.map((_, i) => {
    const at = (): AstNode => fn("json_keys", i === 0 ? [copy(j)] : [copy(j), strConst(pointer(keys.slice(0, i)))]);
    return { CoalesceExpr: { args: [op("=", fn("len", [at()]), fn("len", [fn("list_distinct", [at()])])), boolConst(true)] } };
  });
  const when = (test: AstNode): AstNode => keysOnce ? test : and([...once(), test]);
  return caseWhen([
    // (a NULL document first: its json_keys is NULL, which no check passes)
    [isNull(copy(j)), nullConst()],
    [when(op("=", type(), strConst("VARCHAR"))), fn("json_extract_string", [copy(j), strConst(path)])],
    // a missing path is SQL NULL from json_type, a JSON null its name
    [when(or([isNull(type()), op("=", type(), strConst("NULL"))])), nullConst()],
  ], call);
}

/** a json read's constant steps as keys: null where they are not a constant, or a step is an index — a `->` step that
 *  is an integer, a `#>` element that reads as one on an array, as the function reads it (pathIndex: `+1` and ` 1` are,
 *  `1 ` is a key) */
function stepKeys(steps: AstNode, either: boolean): string[] | null {
  const literal = constString(steps);
  if (literal === null) return null;
  const keys: string[] = [];
  for (const s of JSON.parse(literal) as unknown[]) {
    if (typeof s !== "string" || (either && pathIndex(s) !== null)) return null;
    keys.push(s);
  }
  return keys;
}

/** a JSON pointer of keys (`/a/b`, `~` and `/` escaped), which reads every key — but an all-digit one as an index of an
 *  array */
const jsonPointer = (keys: readonly string[]): string => keys.map((k) => "/" + k.replaceAll("~", "~0").replaceAll("/", "~1")).join("");

/**
 * THE ONE WRITER OF A KEY PATH AS DUCKDB'S JSON FUNCTIONS READ IT (`->>`'s and `->`'s native read, a `->` read's
 * nullness, `@>`'s template leaves): null where no path of DuckDB's reads exactly these keys, and the caller keeps the
 * function. The root (no key) is `$`. A key holding a control character stays the function's. The path is a JSON
 * pointer, which takes every key — except an all-digit key, which a pointer reads as an index on an array where
 * Postgres reads NULL: a path with one is JSONPath's quoted keys, which cannot say `*` (a wildcard even quoted) or an
 * empty key, so those stay the function's.
 */
function duckJsonPath(keys: readonly string[]): string | null {
  if (keys.length === 0) return "$";
  if (keys.some((k) => /[\u0000-\u001f]/.test(k))) return null;
  if (!keys.some((k) => /^\d+$/.test(k))) return jsonPointer(keys);
  if (keys.some((k) => k === "" || k === "*")) return null;
  return "$" + keys.map((k) => `."${k.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join("");
}

/** the json types of DuckDB's reader whose text is Postgres's jsonb text of the value: an integer's digits (int64 and
 *  uint64; a number past them, or with a point or an exponent, is a DOUBLE whose text DuckDB writes again), `true` /
 *  `false`, and `null` (a JSON null, never SQL NULL) */
const NATIVE_VALUE_TYPES = ["BIGINT", "UBIGINT", "BOOLEAN", "NULL"];

/** one value through a lambda that names it as often as it likes, `list_transform(list_value(x), <name> -> <body>)[1]`:
 *  `x` computed ONCE (every json_* call parses the whole document again: 6.8 s for a json_type and a json_extract of one
 *  path over 100 k 20 kB documents, 3.8 s for the json_extract alone) */
function bound(x: AstNode, name: string, body: (v: () => AstNode) => AstNode): AstNode {
  const v = (): AstNode => ({ ColumnRef: { fields: [S(name)] } });
  return { A_Indirection: { arg: fn("list_transform", [fn("list_value", [x]), op("->", v(), body(v))]), indirection: [{ A_Indices: { uidx: intConst(1) } }] } };
}

/**
 * A COPIED JSONB'S `->` VALUE, DUCKDB'S OWN WHERE ITS TEXT IS POSTGRES'S (issue 130): the value extracted once, and its
 * text where DuckDB writes what jsonb_out does — an integer, a boolean, a JSON null (NATIVE_VALUE_TYPES), or a string
 * whose written text holds no `\u00` escape (DuckDB writes `\u001F` where Postgres's escape_json writes `\u001f`; `"`,
 * `\`, `/`, `\b` `\f` `\n` `\r` `\t`, DEL and every other character are written alike; a string holding the
 * characters `\u00` themselves is written `\\u00` and goes to the function, which is only slower). A missing key or a
 * NULL document is SQL NULL. The rest — a number DuckDB types DOUBLE (`1.50` reads `1.5`), an object or an array
 * (DuckDB writes them without spaces) — is the function's, the CASE's ELSE, which DuckDB runs on those rows alone.
 */
function jsonValueRead(copy: Copy, j: AstNode, path: string, call: AstNode): AstNode {
  return bound(fn("json_extract", [copy(j), strConst(path)]), "__mason_v", (v) => {
    const type = (): AstNode => fn("json_type", [v()]);
    const text = (): AstNode => cast(v(), ["varchar"]);
    return caseWhen([
      [isNull(v()), nullConst()],
      [or([...NATIVE_VALUE_TYPES.map((t) => op("=", type(), strConst(t))),
        and([op("=", type(), strConst("VARCHAR")), not(fn("contains", [text(), strConst("\\u00")]))])]), text()],
    ], call);
  });
}

/** a leaf of an `@>` template: the keys to it and the value it must be (a string, a boolean, a JSON null, a number, or
 *  an EMPTY object, which only says the value there is an object) */
interface TemplateLeaf { keys: string[]; want: Json }

/** a constant `@>` template's leaves (an object at its root, its members as jsonb holds them: storedPairs), or null
 *  where it holds an array anywhere — the function's, whose rules for an array's elements DuckDB has no reader of */
function templateLeaves(t: Json, keys: string[] = []): TemplateLeaf[] | null {
  if (t.t === "arr") return null;
  if (t.t !== "obj" || t.v.length === 0) return [{ keys, want: t }];
  const out: TemplateLeaf[] = [];
  for (const [k, x] of storedPairs(t.v)) {
    const leaves = templateLeaves(x, [...keys, k]);
    if (leaves === null) return null;
    out.push(...leaves);
  }
  return out;
}

/**
 * `doc @> template`, A COPIED JSONB COLUMN AND A CONSTANT OBJECT, IN DUCKDB'S OWN SQL (issue 130): Postgres's
 * JsonbDeepContains of an object template whose every leaf is a scalar (or an empty object) is the AND over its leaves
 * of "the document holds the leaf's key path with a value of the same kind equal to it" — each key of the template held
 * once (jsonb's canonical text) and of the document too (the copy's canonical text), so DuckDB's read of a key is
 * Postgres's. Every leaf is read in ONE extraction (`json_extract(doc, [p1, p2, …])`, one parse of the document), and
 * each leaf is decided on its own small value:
 *  - a string: a JSON string whose decoded text is the template's, byte for byte (`=` on DuckDB's VARCHAR, no collation);
 *  - a boolean, a JSON null: that kind (and value);
 *  - an empty object: an object (a nested object with members is decided by its leaves, a key read off an array or a
 *    scalar being NULL);
 *  - a number: an integer DuckDB reads (int64 or uint64) is equal exactly when its digits are the template's integer
 *    value's (a template that is not integral equals no integer); a DOUBLE (a point, an exponent, past uint64) is
 *    UNEQUAL where its double differs from the template's — equal numbers round to one double, both reads being
 *    correctly rounded (DuckDB's reader, JavaScript's Number) — and undecided where they are the same double: the
 *    function's (`1.0000000000000000001` beside `1`).
 * A missing leaf, any other kind: unequal. A row with every leaf equal is true, one with a leaf unequal false, one with
 * an undecided leaf (and none unequal) the function's, the CASE's ELSE. A NULL document is NULL (the operator is strict).
 * Null where the template is not such an object: the caller keeps the function.
 */
function nativeContains(copy: Copy, doc: AstNode, template: Json, call: AstNode): AstNode | null {
  if (template.t !== "obj") return null;
  const leaves = templateLeaves(template);
  if (leaves === null) return null;
  const paths = leaves.map((l) => duckJsonPath(l.keys));
  if (paths.some((p) => p === null)) return null;
  return bound(fn("json_extract", [copy(doc), arrayOf(paths.map((p) => strConst(p!)))]), "__mason_x", (x) => {
    const at = (i: number) => (): AstNode => ({ A_Indirection: { arg: x(), indirection: [{ A_Indices: { uidx: intConst(i + 1) } }] } });
    const decided = leaves.map((l, i) => leafTest(at(i), l.want));
    const known = (t: AstNode): AstNode => ({ CoalesceExpr: { args: [t, boolConst(false)] } });
    // (a BoolExpr of one argument is printed as the argument alone, and would not read back as itself)
    const all = (xs: AstNode[]): AstNode => xs.length === 1 ? xs[0]! : and(xs), any = (xs: AstNode[]): AstNode => xs.length === 1 ? xs[0]! : or(xs);
    return caseWhen([
      [isNull(x()), nullConst()],
      [all(decided.map((d) => known(d.equal()))), boolConst(true)],
      [any(decided.map((d) => not(known(d.undecided === null ? d.equal() : or([d.equal(), d.undecided()]))))), boolConst(false)],
    ], call);
  });
}

/** one template leaf against the document's value there (`v`, NULL where the path is missing): when it is equal, and,
 *  for a number, when DuckDB's read cannot tell (a DOUBLE equal to the template's double) */
function leafTest(v: () => AstNode, want: Json): { equal: () => AstNode; undecided: (() => AstNode) | null } {
  const type = (): AstNode => fn("json_type", [v()]);
  const is = (t: string): AstNode => op("=", type(), strConst(t));
  const text = (): AstNode => cast(v(), ["varchar"]);
  switch (want.t) {
    case "obj": return { equal: () => is("OBJECT"), undecided: null };
    case "null": return { equal: () => is("NULL"), undecided: null };
    case "bool": return { equal: () => and([is("BOOLEAN"), op("=", text(), strConst(want.v ? "true" : "false"))]), undecided: null };
    case "str": return { equal: () => and([is("VARCHAR"), op("=", fn("json_extract_string", [v(), strConst("$")]), strConst(want.v))]), undecided: null };
    case "num": {
      // (jsonb_out's text of a numeric: no exponent, a point only with digits after it)
      const whole = /^(-?)(\d+)(?:\.0*)?$/.exec(want.text);
      const digits = whole === null ? null : BigInt(whole[2]!) === 0n ? "0" : `${whole[1]}${BigInt(whole[2]!)}`;
      const d = Number(want.text);
      return {
        equal: () => digits === null ? boolConst(false) : and([or([is("BIGINT"), is("UBIGINT")]), op("=", text(), strConst(digits))]),
        // (a CASE: DuckDB evaluates both sides of an AND on every row, and a string's cast to double raises)
        undecided: () => Number.isFinite(d) ? caseWhen([[is("DOUBLE"), op("=", cast(v(), ["double"]), cast(strConst(String(d)), ["double"]))]], boolConst(false)) : is("DOUBLE"),
      };
    }
    case "arr": throw new Error("an array leaf is the function's (templateLeaves)");
  }
}

/**
 * A STORED PATH'S `->>`, FROM ITS COLUMN ALONE (Rewriter.keptRead): the column holds the `->` answer — the value's JSON
 * text — or `KEPT_NULL`, and `->>` is that text where the value is not a string (a number's text is the same both ways,
 * a jsonb's numeric included; an object or an array its text), NULL for a JSON null or no value, and a string's
 * characters: its text between the quotes where it holds no escape, else the function's `->>` of the value's own text
 * (`[]` steps) — the same function on the same value, only for the rows that take that arm, never the document.
 */
function keptText(column: () => AstNode, canonical: boolean): AstNode {
  return caseWhen([
    [or([op("=", column(), fn("chr", [intConst(0)])), op("=", column(), strConst("null"))]), nullConst()],
    [fn("starts_with", [column(), strConst('"')]), caseWhen([
      [fn("contains", [column(), strConst("\\")]), fn("__mason_json_get", [column(), strConst("[]"), boolConst(false), boolConst(canonical), boolConst(true)])],
    ], fn("substr", [column(), intConst(2), op("-", fn("length", [column()]), intConst(2))]))],
  ], column());
}

/** `->`'s key (an integer one an index) or json_extract_path's elements, as the JSON array of steps */
function jsonSteps(keys: AstNode[], index: boolean): AstNode {
  const literal = keys.map((k) => index ? constInt(k) : constString(k));
  if (literal.every((k) => k !== null)) return strConst(JSON.stringify(literal));
  return cast(fn("to_json", [fn("list_value", keys.map((k) => cast(k, [index ? "bigint" : "varchar"])))]), ["varchar"]);
}

/** Postgres's text-array element types, as DuckDB's */
const ARRAY_ELEMENT: Record<string, string> = { text: "varchar", varchar: "varchar", int4: "integer", int: "integer", integer: "integer", int8: "bigint", bigint: "bigint", int2: "smallint", smallint: "smallint", float8: "double", numeric: "double", bool: "boolean", boolean: "boolean", date: "date" };

/** an array literal's elements as array_in reads them: quotes and backslashes, an unquoted NULL is NULL */
function arrayLiteral(text: string): Array<string | null> {
  const inner = text.trim();
  if (!inner.startsWith("{") || !inner.endsWith("}")) throw new Unrewritable(`malformed array literal: "${text}"`, 'write it as \'{a,b}\'', { postgres: "22P02" });
  const body = inner.slice(1, -1);
  if (body.trim() === "") return [];
  const out: Array<string | null> = [];
  let cur = "", quoted = false, wasQuoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === "\\") { cur += body[++i] ?? ""; continue; }
      if (c === '"') { quoted = false; continue; }
      cur += c; continue;
    }
    if (c === "{") throw new Unrewritable("a multi-dimensional array literal is not supported by Mason", "write a one-dimensional array", "multidim-array");
    if (c === '"') { quoted = true; wasQuoted = true; continue; }
    if (c === "\\") { cur += body[++i] ?? ""; continue; }
    if (c === ",") { out.push(!wasQuoted && cur.trim().toUpperCase() === "NULL" ? null : wasQuoted ? cur : cur.trim()); cur = ""; wasQuoted = false; continue; }
    cur += c;
  }
  out.push(!wasQuoted && cur.trim().toUpperCase() === "NULL" ? null : wasQuoted ? cur : cur.trim());
  return out;
}

/**
 * A SIMILAR TO pattern as RE2's, as Postgres's similar_to_escape translates it: `%` any text, `_` one character, the
 * escape character's next character itself, `.` `^` `$` themselves, and the regular-expression operators (`|` `*` `+`
 * `?` `{…}` `(…)` `[…]`) as they are. The whole text must match (regexp_full_match).
 */
export function similarToRe2(pattern: string, escape: string): string {
  if (escape.length > 1) throw new Unrewritable("invalid escape string", "Escape string must be empty or one character.", { postgres: "22025" });
  let out = "", inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (escape !== "" && c === escape) {
      const next = pattern[++i];
      if (next === undefined) throw new Unrewritable("invalid escape at the end of a SIMILAR TO pattern", "escape a character, or end the pattern without the escape character", { postgres: "22025" });
      if (next === '"') throw new Unrewritable("SIMILAR TO's substring markers (escape + \") are not supported by Mason", "use substring(text from pattern) with a POSIX regular expression", "similar-to-forms");
      out += /[A-Za-z0-9]/.test(next) ? next : `\\${next}`;
      continue;
    }
    if (inClass) { out += c === "\\" ? "\\\\" : c; if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; out += c; if (pattern[i + 1] === "^") { out += "^"; i++; } if (pattern[i + 1] === "]") { out += "\\]"; i++; } continue; }
    if (c === "%") { out += ".*"; continue; }
    if (c === "_") { out += "."; continue; }
    if (c === "(") { out += pattern[i + 1] === "?" ? "(" : "(?:"; continue; }
    if (".^$\\".includes(c)) { out += `\\${c}`; continue; }
    out += c;
  }
  return out;
}

/** the parenthesised groups of a regular expression that capture (`(?:…)` does not; inside […] a parenthesis is a character) */
function captureGroups(pattern: string): number {
  let n = 0, inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; if (pattern[i + 1] === "^") i++; if (pattern[i + 1] === "]") i++; continue; }
    if (c === "(" && pattern[i + 1] !== "?") n++;
  }
  return n;
}

/** pg_catalog.interval's field masks (INTERVAL_MASK): the lowest field a typmod names, finest first */
const INTERVAL_FIELDS: Array<[number, string]> = [[1 << 12, "second"], [1 << 11, "minute"], [1 << 10, "hour"], [1 << 3, "day"], [1 << 1, "month"], [1 << 2, "year"]];

/** `interval '3' day`, `x::interval hour`: a bare number is a count of the lowest field, and the fields below it are
 *  cut off (AdjustIntervalForTypmod), as date_trunc cuts an interval */
function intervalFields(arg: AstNode, mask: number | null): AstNode {
  const unit = INTERVAL_FIELDS.find(([bit]) => mask !== null && (mask & bit) !== 0)?.[1] ?? "second";
  const s = constString(arg);
  const value = s !== null && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(s) ? strConst(`${s.trim()} ${unit}s`) : arg;
  const iv = cast(value, ["interval"]);
  return unit === "second" ? iv : fn("date_trunc", [strConst(unit), iv]);
}

/** a json_to_record column definition's type, spelled for Postgres, and how its value comes back to DuckDB (the
 *  worker's kind and the DuckDB type it is cast to); `read` null for a type not read here (an array, a type of a
 *  schema's own) */
function recordColumn(t: Body | undefined): { spelled: string; read: [PgKind, string[] | null] | null } {
  const name = lastName(t?.names);
  const mods = ((t?.typmods ?? []) as AstNode[]).map((m) => constInt(m));
  const spelled = `${name}${mods.length > 0 ? `(${mods.join(", ")})` : ""}${Array.isArray(t?.arrayBounds) && t.arrayBounds.length > 0 ? "[]" : ""}`;
  if (spelled.endsWith("]") || mods.some((m) => m === null) || (t?.names as AstNode[] | undefined ?? []).length > 2) return { spelled, read: null };
  const reads: Record<string, [PgKind, string[] | null]> = {
    int2: ["int8", ["smallint"]], int4: ["int8", ["integer"]], int8: ["int8", null], bool: ["bool", null], date: ["date", null],
    timestamp: ["timestamp", null], timestamptz: ["timestamptz", null], interval: ["interval", null], text: ["text", null],
    varchar: ["text", null], bpchar: ["text", null], float8: ["text", ["double"]], float4: ["text", ["float"]], uuid: ["text", ["uuid"]],
    json: ["text", ["json"]], jsonb: ["text", ["json"]],
    numeric: ["text", mods.length > 0 && mods[0]! <= 38 ? ["decimal", String(mods[0]), String(mods[1] ?? 0)] : ["double"]],
  };
  return { spelled, read: reads[name] ?? null };
}

/** json_agg's text of items each written with its own line break before it (`\n {…}`, `null`): `[` the items joined by
 *  `, ` `]`, the first item's line break dropped, as json_agg_transfn writes none before the first */
function linedAgg(b: Body, item: AstNode, done: WeakSet<Body>): AstNode {
  const agg: AstNode = { FuncCall: { ...b, funcname: [S("string_agg")], args: [item, strConst(", ")] } };
  done.add(bodyOf(agg));
  return concat(strConst("["), fn("regexp_replace", [agg, strConst("^\n "), strConst("")]), strConst("]"));
}

/** the divisor of a float or numeric division: Postgres raises on zero */
function nonZero(copy: Copy, r: AstNode): AstNode {
  // a constant, or a constant the rewrite cast (`CAST(2 AS double)`): no guard, so no volatile error() call, which DuckDB
  // refuses in a DISTINCT aggregate's ORDER BY
  let c = r;
  while (kindOf(c) === "TypeCast" && isNode(bodyOf(c).arg)) c = bodyOf(c).arg as AstNode;
  if (kindOf(c) === "A_Const") {
    const b = bodyOf(c);
    const v = b.ival !== undefined ? Number(b.ival.ival ?? 0) : b.fval !== undefined ? Number(b.fval.fval) : null;
    if (v !== null && v !== 0) return r;
  }
  // NULL in the branch no row takes: the CASE keeps the divisor's type
  return caseWhen([[fn("__mason_zero_divisor", [op("=", r, intConst(0))]), nullConst()]], copy(r));
}

/** a column the rewrite reads per group (`any_value(c)`, `first(c)`, one argument): the column itself */
/** a bin the engine computes (`Rewriter.nativeBin`): floor (or ceil) of e·shift / divisor, e at its display scale */
type NativeBin = { readonly e: AstNode; readonly up: boolean; readonly shift: bigint; readonly divisor: bigint; readonly scale: number; readonly wide: boolean };

const perGroupRead = (e: AstNode): AstNode => {
  if (kindOf(e) !== "FuncCall") return e;
  const b = bodyOf(e), args = (b.args ?? []) as AstNode[];
  return ["any_value", "first"].includes(lastName(b.funcname)) && args.length === 1 && b.over === undefined ? perGroupRead(args[0]!) : e;
};

/** a decimal text without an exponent: `1.5e-3` → `0.0015` */
function positional(text: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (m === null) return text;
  const digits = `${m[2] ?? ""}${m[3] ?? ""}`;
  const point = (m[2] ?? "").length + Number(m[4] ?? 0);
  let whole: string, frac: string;
  if (point <= 0) { whole = "0"; frac = "0".repeat(-point) + digits; }
  else if (point >= digits.length) { whole = digits + "0".repeat(point - digits.length); frac = ""; }
  else { whole = digits.slice(0, point); frac = digits.slice(point); }
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  return `${m[1] === "-" ? "-" : ""}${whole}${frac === "" ? "" : `.${frac}`}`;
}

/** a numeric constant written positionally, as DuckDB's DECIMAL: `0.025` reads as one, but a whole `250` (from `2.5e2`)
 *  would read back as an INTEGER — integer arithmetic, an overflow where Postgres's numeric has none — so it is
 *  written as an integer cast to numeric is (`wholeNumeric`). Past DuckDB's 38 digits it stays as written: DuckDB's
 *  double, as before */
function decimalConst(text: string): AstNode {
  if (text.includes(".") || !engineReadsExactly(text)) return numConst(text);
  const n = Number(text);
  return wholeNumeric(Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 ? intConst(n) : numConst(text));
}

/**
 * A WHOLE NUMERIC Postgres computes (an integer cast to numeric, div() of two integers, a whole constant, extract of a
 * whole part) as the engine's HUGEINT, never a DECIMAL(38, 0) (issue 929). Beside another DECIMAL in a UNION, an IN, a
 * CASE, a COALESCE, GREATEST or an ARRAY, DuckDB brings both to one type; a DECIMAL(38, 0) leaves no room for the
 * other's decimals, so DuckDB drops them and rows and order are wrong. A HUGEINT beside a DECIMAL(w, s) is brought to
 * DECIMAL(38, s): the scale is kept and the width is 38, as for `sum` of an integer column (a HUGEINT). A whole value
 * of more than 38 − s digits does not fit it, and is DuckDB's error (22003 on the wire), never rounded: beside a
 * numeric(38,30), a 9-digit integer. HUGEINT still keeps a product in 128 bits, as DECIMAL(38, 0) did (DuckDB keeps a
 * product of two 18-digit decimals in 64 bits and fails past it). A set operation that compares rows of numerics of
 * several scales is refused (`numeric-set-scales`): its rows would all print at the widest scale.
 */
function wholeNumeric(n: AstNode): AstNode {
  return cast(n, ["hugeint"]);
}

/** WHETHER THE ENGINE READS A NUMERIC CONSTANT EXACTLY, AS IT IS WRITTEN FOR IT (the one reader of a constant's
 *  exactness: `decimalConst` writes by it, `duckExact` asks it): DuckDB's DECIMAL holds 38 digits, every digit written
 *  counted (`0.5` is two); past them, or with an exponent, DuckDB reads the constant as a double */
function engineReadsExactly(text: string): boolean {
  return !/[eE]/.test(text) && (text.match(/[0-9]/g) ?? []).length <= 38;
}

/** the text a numeric constant (`A_Const`'s fval) is written with for the engine: positional where it has an exponent
 *  (`decimalConst`, which DuckDB would read as a double), else as Postgres's parser kept it */
const numericConstText = (fval: string): string => /[eE]/.test(fval) ? positional(fval) : fval;

/** HOW A CAST TO NUMERIC IS WRITTEN FOR THE ENGINE: one decision, which the cast's writer (`typeCast`) follows and
 *  `duckExact` reads, so what is called exact is what is sent — and a product's widening (`aExpr` `*`) writes by it too.
 *  With a typmod: DuckDB's DECIMAL(p, s) of the value, its double past 38 digits or a scale past the precision, as
 *  written where the typmod is no constant. Unconstrained: an integer as a whole DECIMAL, a
 *  text constant as numeric_in reads it (`decimalConst`: BEFORE a numeric, Postgres types `'1.5'` as the cast's numeric,
 *  and as it stood DuckDB answered the text, `2.5e2` for 250), a numeric as itself, anything else (a float, NaN) as
 *  the engine's double */
type NumericCastWrite = { as: "double" } | { as: "decimal"; precision: number; scale: number } | { as: "whole" } | { as: "literal"; text: string } | { as: "same" } | { as: "as written" };
function numericCastWrite(typmods: readonly AstNode[], from: number | null, text: string | null): NumericCastWrite {
  if (typmods.length > 0) {
    const p = constInt(typmods[0]), s = typmods.length > 1 ? constInt(typmods[1]) : 0;
    // (DuckDB's DECIMAL holds 38 digits, and a scale no larger than its precision)
    if (p !== null && (p > 38 || (s ?? 0) > p)) return { as: "double" };
    return p !== null ? { as: "decimal", precision: p, scale: s ?? 0 } : { as: "as written" };
  }
  if (from !== null && INTEGERS.has(from)) return { as: "whole" };
  // as numeric_in reads it (`1_000`, `0x1F`, `1.5e3`: one reader, src/lib/pg-numeric.ts); NaN and Infinity are no
  // DuckDB decimal and keep the double
  const literal = text === null ? null : numericLiteral(text);
  if (literal !== null) return { as: "literal", text: literal };
  return from === NUMERIC ? { as: "same" } : { as: "double" };
}

/** a text cast to an integer, as strict as Postgres's: whitespace around an optional sign and digits, nothing else */
/** the jsonpath functions' arguments: the target, the path, the variables, `silent` */
const JSONPATH_ARGS = ["jsonb", "jsonpath", "jsonb", "boolean"];

/** Postgres's own answer for each row (src/duck/pg-eval.ts): `template` over a1…an, each argument's text, under the
 *  zone DuckDB's session has and the session's DateStyle (its settings, src/duck/store.ts settle), as one argument
 *  (`PG_SESSION_SEPARATOR`) */
function pgCall(kind: PgKind, template: string, args: AstNode[]): AstNode {
  const dateStyle = fn("ifnull", [fn("map_extract_value", [fn("getvariable", [strConst(SETTINGS_VARIABLE)]), strConst("datestyle")]), strConst("ISO, MDY")]);
  const session = concat(fn("current_setting", [strConst("TimeZone")]), strConst(PG_SESSION_SEPARATOR), dateStyle);
  return fn(`__mason_pg_${kind}`, [session, strConst(template), ...args.map((a) => cast(a, ["varchar"]))]);
}

/** a json argument: a text literal is read as JSON (DuckDB's json functions over a VARCHAR literal parse it anyway) */
const jsonArg = (n: AstNode): AstNode => n;


/**
 * A Postgres (ARE) pattern as RE2's: `.` matches a newline (Postgres's default; RE2's `(?s)`), `\w` / `\d` / `\s` are
 * Unicode's (RE2's are ASCII), `\Z` is the end (`\z`). Null where RE2 would not answer as Postgres's engine does, which
 * then answers it (src/duck/pg-eval.ts): a pattern that is not a literal; a construct RE2 lacks or reads otherwise — a
 * lookaround, a back reference, embedded options, a word boundary or a word's start or end (`\y`, `\m`, `\M`: RE2's
 * `\b` knows ASCII words alone); and, `extract`, a pattern whose MATCH (not whether there is one) depends on the
 * engine: alternation, or more than one quantifier (Postgres takes the longest match, RE2 the first: `substring('aab'
 * from 'a*(ab)?')` is `aab` there, `aa` in RE2).
 */
function regexPattern(p: AstNode, extract = false): AstNode | null {
  const s = constString(p);
  if (s === null) return null;
  const re = areToRe2(s, extract);
  return re === null ? null : strConst(`(?s)${re}`);
}

export function areToRe2(s: string, extract = false): string | null {
  if (s.startsWith("***")) return null;
  let out = "", inClass = false, quantifiers = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      const e = s[i + 1]!;
      i++;
      const cls = { w: "\\p{L}\\p{Nd}_", d: "\\p{Nd}", s: "\\s" }[e as "w" | "d" | "s"];
      if (cls !== undefined) { out += inClass ? cls : `[${cls}]`; continue; }
      const neg = { W: "\\p{L}\\p{Nd}_", D: "\\p{Nd}" }[e as "W" | "D"];
      if (neg !== undefined && !inClass) { out += `[^${neg}]`; continue; }
      // a word boundary, start or end; a back reference (\1, \k<…>): Postgres's engine
      if (!inClass && /[yYmM1-9k]/.test(e)) return null;
      if (!inClass && e === "Z") { out += "\\z"; continue; }
      out += `\\${e}`;
      continue;
    }
    if (c === "[" && !inClass) { inClass = true; out += c; if (s[i + 1] === "^") { out += "^"; i++; } if (s[i + 1] === "]") { out += "\\]"; i++; } continue; }
    if (c === "]" && inClass) { inClass = false; out += c; continue; }
    if (!inClass) {
      // a lookaround, embedded options, a comment: everything after `(?` but a group that only groups
      if (c === "(" && s[i + 1] === "?" && s[i + 2] !== ":") return null;
      if (c === "|") quantifiers += 2;
      // a group that may match nothing (`(b)?`, `(b)*`): RE2's extract has no unmatched group ('' where Postgres has NULL)
      if (extract && (c === "?" || c === "*" || c === "{") && s[i - 1] === ")") return null;
      // a quantifier (a `?` after one makes it lazy, and is none of its own)
      if (c === "*" || c === "+" || c === "{" || (c === "?" && !/[*+?}]/.test(s[i - 1] ?? "") && s[i - 1] !== "(")) quantifiers++;
    }
    out += c;
  }
  return extract && quantifiers > 1 ? null : out;
}

/** regexp_replace's replacement: Postgres's `\&` is the whole match, RE2's `\0` */
function replacement(r: AstNode): AstNode {
  const s = constString(r);
  if (s === null) return fn("replace", [r, strConst("\\&"), strConst("\\0")]);
  return strConst(s.replace(/\\(.)/g, (_m, c: string) => c === "&" ? "\\0" : `\\${c}`));
}

/** substring(text FROM pattern): the first parenthesised part when there is one, else the whole match; NULL without one */
/**
 * `current_setting(name[, missing_ok])` BESIDE A COPIED TABLE IS THE SESSION'S (GitHub issue 40): the name read, in any
 * case, from the settings the session's statement runs under (`SETTINGS_VARIABLE`: src/api/postgres/server.ts
 * `duckSession`, the listener's `sessionSetting` laid over the catalog Postgres's own, set by src/duck/store.ts
 * `settle`) — never DuckDB's own `current_setting`, which answered DuckDB's settings (`search_path` its schemas,
 * `work_mem` an error). A name neither holds is Postgres's 42704, or NULL under missing_ok; strict, as Postgres's.
 */
function settingRead(copy: Copy, args: AstNode[]): AstNode {
  const [name, missingOk] = args as [AstNode, AstNode | undefined];
  const settings = (): AstNode => fn("getvariable", [strConst(SETTINGS_VARIABLE)]);
  const key = (): AstNode => fn("lower", [copy(name)]);
  const unknown = fn("error", [concat(strConst('mason[42704]: unrecognized configuration parameter "'), copy(name), strConst('"'))]);
  return caseWhen([
    [missingOk === undefined ? isNull(name) : or([isNull(name), isNull(missingOk)]), nullConst()],
    [fn("map_contains", [settings(), key()]), fn("map_extract_value", [settings(), key()])],
    ...(missingOk === undefined ? [] : [[copy(missingOk), nullConst()] as [AstNode, AstNode]]),
  ], unknown);
}

function regexSubstring(copy: Copy, s: AstNode, p: AstNode): AstNode {
  const pattern = regexPattern(p, true)!;
  const text = constString(p);
  const group = text !== null && /\((?!\?)/.test(text.replace(/\\./g, "")) ? 1 : 0;
  return caseWhen([[fn("regexp_matches", [copy(s), copy(pattern)]), fn("regexp_extract", [s, pattern, intConst(group)])]], null);
}

/** make_interval(years, months, weeks, days, hours, mins, secs), positional or named, as DuckDB's interval sums */
function makeInterval(args: AstNode[]): AstNode {
  const order = ["years", "months", "weeks", "days", "hours", "mins", "secs"];
  const parts = new Map<string, AstNode>();
  args.forEach((a, i) => {
    if (kindOf(a) === "NamedArgExpr") parts.set(String(bodyOf(a).name), bodyOf(a).arg as AstNode);
    else parts.set(order[i]!, a);
  });
  const terms: AstNode[] = [];
  const add = (key: string, f: (x: AstNode) => AstNode): void => { const x = parts.get(key); if (x !== undefined) terms.push(f(x)); };
  add("years", (x) => fn("to_years", [cast(x, ["integer"])]));
  add("months", (x) => fn("to_months", [cast(x, ["integer"])]));
  add("weeks", (x) => fn("to_days", [op("*", cast(x, ["integer"]), intConst(7))]));
  add("days", (x) => fn("to_days", [cast(x, ["integer"])]));
  add("hours", (x) => fn("to_hours", [cast(x, ["bigint"])]));
  add("mins", (x) => fn("to_minutes", [cast(x, ["bigint"])]));
  add("secs", (x) => fn("to_microseconds", [cast(fn("round", [op("*", cast(x, ["double"]), numConst("1000000.0"))]), ["bigint"])]));
  if (terms.length === 0) return cast(strConst("0 seconds"), ["interval"]);
  return terms.reduce((a, b) => op("+", a, b));
}

/** jsonb_typeof: DuckDB's json_type in Postgres's words */
function jsonTypeof(x: AstNode): AstNode {
  const t = fn("json_type", [x]);
  return { CaseExpr: { arg: t, args: [["OBJECT", "object"], ["ARRAY", "array"], ["VARCHAR", "string"], ["BIGINT", "number"], ["UBIGINT", "number"], ["DOUBLE", "number"], ["HUGEINT", "number"], ["BOOLEAN", "boolean"], ["NULL", "null"]]
    .map(([w, r]) => ({ CaseWhen: { expr: strConst(w!), result: strConst(r!) } })) } };
}

/** format(fmt, …) with only `%s` and `%%`: DuckDB's printf, each value as its text and NULL as nothing (Postgres's) */
function formatCall(args: AstNode[], text: (a: AstNode, i: number) => AstNode): AstNode {
  const fmt = constString(args[0]);
  if (fmt === null || /%(?![s%])/.test(fmt)) throw new Unrewritable("format() with a format other than %s is not supported by Mason", "concatenate the parts with ||, or use only %s", "format-specifiers");
  return fn("printf", [strConst(fmt), ...args.slice(1).map((a, i): AstNode => ({ CoalesceExpr: { args: [text(a, i + 1), strConst("")] } }))]);
}

/** Postgres's to_char / to_timestamp template patterns, as strftime / strptime's (null where strftime has none) */
const TEMPLATE: Array<[string, string | null]> = [
  ["HH24", "%H"], ["HH12", "%I"], ["HH", "%I"], ["MI", "%M"], ["SS", "%S"], ["MS", "%g"], ["US", "%f"],
  ["AM", "%p"], ["PM", "%p"], ["am", "%p"], ["pm", "%p"],
  ["YYYY", "%Y"], ["IYYY", "%G"], ["YY", "%y"], ["MONTH", null], ["Month", "%B"], ["month", null], ["MON", null], ["Mon", "%b"], ["mon", null], ["MM", "%m"],
  ["DAY", null], ["Day", "%A"], ["day", null], ["DY", null], ["Dy", "%a"], ["dy", null], ["DDD", "%j"], ["DD", "%d"], ["IW", "%V"], ["TZ", "%Z"],
];

function translateTemplate(fmt: string, forParse: boolean): string {
  let out = "", i = 0;
  while (i < fmt.length) {
    if (fmt[i] === '"') { const end = fmt.indexOf('"', i + 1); const lit = fmt.slice(i + 1, end < 0 ? undefined : end); out += lit.replace(/%/g, "%%"); i = end < 0 ? fmt.length : end + 1; continue; }
    if (fmt.startsWith("FM", i)) { i += 2; continue; }
    const hit = TEMPLATE.find(([p]) => fmt.startsWith(p, i));
    if (hit !== undefined) {
      const [pattern, spec] = hit;
      // Month / Day pad to 9 characters in Postgres unless FM: refused there rather than answered unpadded
      const padded = (pattern === "Month" || pattern === "Day") && !fmt.slice(Math.max(0, i - 2), i).startsWith("FM");
      if (spec === null || (padded && !forParse)) throw new Unrewritable(`the to_char pattern ${pattern}${padded ? " (padded to 9 characters)" : ""} is not supported by Mason`, padded ? `write FM${pattern} for the unpadded name` : "use YYYY MM DD HH24 MI SS MS US Mon Month Dy Day IYYY IW DDD AM", "to-char-patterns");
      out += spec; i += pattern.length; continue;
    }
    if (/[A-Za-z]/.test(fmt[i]!)) {
      const word = /^[A-Za-z]+/.exec(fmt.slice(i))![0];
      throw new Unrewritable(`the to_char pattern ${word} is not supported by Mason`, "use YYYY MM DD HH24 MI SS MS US Mon Month Dy Day IYYY IW DDD AM, or put literal text in double quotes", "to-char-patterns");
    }
    out += fmt[i] === "%" ? "%%" : fmt[i]; i++;
  }
  return out;
}

/** to_char of a time or a number, by Postgres's template rules (src/duck/to-char.ts): the value's text, the format's */
function toChar(args: AstNode[], type: number | null): AstNode {
  if (args.length !== 2) throw new Unrewritable("to_char() takes a value and a format", "write to_char(value, 'format')", { postgres: "42883" });
  if (type !== null && [DATE, TIMESTAMP, TIMESTAMPTZ].includes(type)) return fn("__mason_to_char_time", [cast(args[0]!, ["varchar"]), cast(args[1]!, ["varchar"])]);
  if (type !== null && (INTEGERS.has(type) || FLOATS.has(type) || type === NUMERIC)) return fn("__mason_to_char_number", [cast(args[0]!, ["varchar"]), cast(args[1]!, ["varchar"])]);
  throw new Unrewritable("to_char of an interval is not supported by Mason", "format its parts with extract(… from interval), or to_char a timestamp", "to-char-patterns");
}

function strptimeFormat(fmt: AstNode): string {
  const s = constString(fmt);
  if (s === null) throw new Unrewritable("to_timestamp / to_date with a format that is not a literal is not supported by Mason", "write the format as a string literal", "to-timestamp-format");
  return translateTemplate(s, true);
}

/** Rewrites one statement's raw tree (libpg-query's `stmt`, offsets from `base`) by Postgres's analysis of it. */
/**
 * The name Postgres gives a select-list expression that has no AS (FigureColname, parse_target.c): a column's own
 * name, a function's, `case`, `coalesce`, `array`, `exists`, a cast's argument's name or its type's, and `?column?` for
 * the rest. DuckDB names them otherwise (`count_star()`, `(1 + 1)`, `CAST(x AS VARCHAR(40))`), so a query reading an
 * inner query's column by Postgres's name failed there (a review finding: `SELECT s.count FROM (SELECT count(*)
 * …) s`). Every unnamed target is given this name (`nameTargets`).
 */
export function figureColname(n: AstNode): string {
  const [name, strength] = colnameOf(n);
  return strength === 0 ? "?column?" : name;
}

/** FigureColnameInternal: the name and its strength — 2 a name of the expression's own (a column's, a function's), 1 a
 *  kind's (`case`, a cast's type), 0 none. A CASE is named by its ELSE where that name is strong (`CASE … ELSE n END`
 *  is `n`), and a cast by its argument where that one's is, else by its type */
function colnameOf(n: AstNode): [string, number] {
  const k = kindOf(n), b = bodyOf(n);
  switch (k) {
    case "TypeCast": { const inner = isNode(b.arg) ? colnameOf(b.arg) : ["?column?", 0] as [string, number]; return inner[1] > 1 ? inner : [lastName(b.typeName?.names), 1]; }
    case "CollateClause": return isNode(b.arg) ? colnameOf(b.arg) : ["?column?", 0];
    case "CaseExpr": { const d = isNode(b.defresult) ? colnameOf(b.defresult) : ["?column?", 0] as [string, number]; return d[1] > 1 ? d : ["case", 1]; }
    case "A_Expr": return b.kind === "AEXPR_NULLIF" ? ["nullif", 2] : ["?column?", 0];
    case "A_Indirection": {
      const ind = ((b.indirection ?? []) as AstNode[]);
      for (let i = ind.length - 1; i >= 0; i--) { if (kindOf(ind[i]!) === "String") return [String(bodyOf(ind[i]!).sval), 2]; if (kindOf(ind[i]!) === "A_Star") break; }
      return isNode(b.arg) ? colnameOf(b.arg) : ["?column?", 0];
    }
    default: { const name = strongColname(n); return name === "?column?" ? [name, 0] : [name, 2]; }
  }
}

/** the kinds whose name is their own (strength 2), or none */
function strongColname(n: AstNode): string {
  const k = kindOf(n), b = bodyOf(n);
  switch (k) {
    case "ColumnRef": { const f = (b.fields ?? []) as AstNode[]; const last = f[f.length - 1]; return last !== undefined && kindOf(last) === "String" ? String(bodyOf(last).sval) : "?column?"; }
    case "FuncCall": return lastName(b.funcname);
    case "GroupingFunc": return "grouping";
    case "SubLink": {
      if (b.subLinkType === "EXISTS_SUBLINK") return "exists";
      if (b.subLinkType === "ARRAY_SUBLINK") return "array";
      if (b.subLinkType !== "EXPR_SUBLINK" || !isNode(b.subselect)) return "?column?";
      const first = ((bodyOf(b.subselect).targetList ?? []) as AstNode[])[0];
      return first !== undefined ? (bodyOf(first).name ?? (isNode(bodyOf(first).val) ? figureColname(bodyOf(first).val as AstNode) : "?column?")) : "?column?";
    }
    case "A_ArrayExpr": return "array";
    case "RowExpr": return "row";
    case "CoalesceExpr": return "coalesce";
    case "MinMaxExpr": return b.op === "IS_GREATEST" ? "greatest" : "least";
    case "SQLValueFunction": return String(b.op ?? "").replace(/^SVFOP_/, "").replace(/_N$/, "").toLowerCase() || "?column?";
    case "XmlExpr": return String(b.op ?? "").replace(/^IS_/, "").toLowerCase().replace(/^document$/, "?column?") || "?column?";
    case "XmlSerialize": return "xmlserialize";
    case "JsonObjectConstructor": return "json_object";
    case "JsonArrayConstructor": case "JsonArrayQueryConstructor": return "json_array";
    case "JsonObjectAgg": return "json_objectagg";
    case "JsonArrayAgg": return "json_arrayagg";
    case "JsonParseExpr": return "json";
    case "JsonScalarExpr": return "json_scalar";
    case "JsonSerializeExpr": return "json_serialize";
    case "JsonFuncExpr": return String(b.op ?? "").replace(/^JSON_(.*)_OP$/, "json_$1").toLowerCase() || "?column?";
    default: return "?column?";
  }
}

/** every select list's unnamed target named as Postgres names it (a star keeps its expansion) */
function nameTargets(v: unknown): void {
  if (Array.isArray(v)) { for (const x of v) nameTargets(x); return; }
  if (v === null || typeof v !== "object") return;
  const b = isNode(v) ? bodyOf(v) : v as Body;
  if (isNode(v) && kindOf(v) === "SelectStmt" || !isNode(v) && Array.isArray(b.targetList)) {
    for (const t of (b.targetList ?? []) as AstNode[]) {
      const r = bodyOf(t);
      if (r.name === undefined && isNode(r.val) && !hasStar(r.val)) r.name = figureColname(r.val);
    }
  }
  for (const [k, x] of Object.entries(b)) nameTargets(armOf(k, x) ?? x);
}

/** what a statement is rewritten from: `rewrite`'s one argument */
export interface RewriteOptions {
  stmt: AstNode;
  base: number;
  analysis: PgAnalysis;
  /** the statement's collations, resolved (src/duck/collation.ts `CollationResolver.prepare`) */
  collations: StatementCollations;
  userTypes?: ReadonlyMap<number, string>;
  /** every type holding a citext anywhere in its structure (src/duck/plan.ts `CITEXT_HELD`) */
  citextHeld?: ReadonlySet<number>;
  /** a type a database made as `pg_typeof` names it (src/duck/plan.ts) */
  typeNames?: ReadonlyMap<number, string>;
  rowTypes?: ReadonlyMap<number, readonly RowColumn[]>;
  timeZone?: string;
  /** the session's DateStyle (src/api/postgres/catalog.ts SessionState) */
  dateStyle?: string;
  enums?: EnumTypes;
  kept?: KeptLookup | null;
  wireBound?: boolean;
  keyCounts?: ReadonlySet<number>;
  /** the values an Execute bound to the parameters read as a json path, by number (`Rewriter.boundPaths`) */
  boundPaths?: ReadonlyMap<number, string>;
}

export function rewrite({ stmt, base, analysis, collations, userTypes = new Map(), citextHeld = new Set(), typeNames = new Map(), rowTypes = new Map(), timeZone = "UTC", dateStyle = "ISO, MDY", enums = { labels: new Map(), arrays: new Map() }, kept = null,
  wireBound = false, keyCounts = new Set(), boundPaths = new Map() }: RewriteOptions):
  { tree: AstNode; withTies: boolean; exact: ExactColumn[]; clock: { parse?: number; exec?: number }; jsonReads: JsonRead[]; unboundedLateral: boolean; pathParams: number[] } {
  const r = new Rewriter(analysis, base, collations, userTypes, rowTypes, timeZone, dateStyle, enums, kept, keyCounts, citextHeld, typeNames);
  r.boundPaths = boundPaths;
  if (joinsUsing(analysis.tree, new Set([JSONB, JSONB_ARRAY]))) {
    throw new Unrewritable("a JOIN … USING or a NATURAL JOIN on a jsonb column is not supported by Mason (Postgres equates jsonb by its own rules)", "JOIN … ON a.j = b.j", "jsonb-compare");
  }
  const own = JSON.parse(JSON.stringify(stmt)) as AstNode;
  // (the hidden cells' name: one the statement's own text never begins a name with, `cellPrefix`)
  const written = JSON.stringify(stmt).toLowerCase();
  for (let n = 0; written.includes(r.cellPrefix); n++) r.cellPrefix = `__mason_cell${n}_`;
  volatileWindows(own);
  r.adopt(own);
  nameTargets(own);
  r.indexShapes(own);
  r.repeatedKeyCounts(own);
  r.scopeColumns(own);
  r.markUnreadSetOps(own);
  r.refuseExactRows(own);
  r.castArms(own);
  r.coerceImplicit(own);
  const exact = r.exactThrough(own, analysis.fields);
  r.carryAll(own);
  r.markBounds(own, wireBound);
  r.markWholeReads(own);
  r.walking = true;
  const tree = guardFilters(flattenBool(r.walk(own))) as AstNode;
  return { tree, withTies: r.wroteTies, exact, clock: r.clock, jsonReads: [...r.jsonReads.values()], unboundedLateral: r.unboundedLateral, pathParams: [...r.pathParams].sort((a, b) => a - b) };
}

/** the functions whose every call is a new value (Postgres's volatile ones Mason answers) */
const VOLATILE = new Set(["random", "gen_random_uuid", "uuid_generate_v4", "clock_timestamp", "timeofday"]);

/** A window ordered or partitioned by a volatile function (`row_number() OVER (ORDER BY random())`, a random row per
 *  group) is refused by name: DuckDB refuses a volatile expression there, and one it takes as deterministic is computed
 *  once for every row (one value: the order is the input's, never random) */
function volatileWindows(v: unknown): void {
  const calls = (x: unknown): boolean => Array.isArray(x) ? x.some(calls) : x !== null && typeof x === "object"
    && ((isNode(x) && kindOf(x) === "FuncCall" && VOLATILE.has(lastName(bodyOf(x).funcname))) || Object.values(isNode(x) ? bodyOf(x) : x as Body).some(calls));
  const check = (w: Body): void => {
    if (calls(w.orderClause) || calls(w.partitionClause)) {
      throw new Unrewritable("a window ordered or partitioned by random() (or another volatile function) is not supported by Mason",
        "compute it in a subquery and order by its column: SELECT …, row_number() OVER (ORDER BY r) FROM (SELECT *, random() AS r FROM t) AS s", "volatile-window");
    }
  };
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x === null || typeof x !== "object") return;
    if (isNode(x)) {
      const b = bodyOf(x);
      if (kindOf(x) === "FuncCall" && b.over !== undefined && b.over !== null && typeof b.over === "object") check(b.over as Body);
      if (kindOf(x) === "WindowDef") check(b);
      Object.values(b).forEach(walk);
      return;
    }
    Object.values(x as Body).forEach(walk);
  };
  walk(v);
}

/** An AND inside an AND (an OR inside an OR) as one list: a rewrite may make one (a text BETWEEN is two comparisons
 *  under the collation), the printer writes it without parentheses and the parser reads one flat list back. The same
 *  statement, by associativity, in three-valued logic too */
function flattenBool(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(flattenBool);
  if (v === null || typeof v !== "object") return v;
  const out = Object.fromEntries(Object.entries(v as Body).map(([k, x]) => [k, flattenBool(x)])) as Body;
  if (isNode(v) && kindOf(v) === "BoolExpr") {
    const b = bodyOf(out as AstNode);
    if (b.boolop === "AND_EXPR" || b.boolop === "OR_EXPR") {
      b.args = ((b.args ?? []) as AstNode[]).flatMap((a) => kindOf(a) === "BoolExpr" && bodyOf(a).boolop === b.boolop ? bodyOf(a).args as AstNode[] : [a]);
    }
  }
  return out;
}

/** whether a tree holds a node of this kind */
function holdsKind(v: unknown, kind: string): boolean {
  if (Array.isArray(v)) return v.some((x) => holdsKind(x, kind));
  if (v === null || typeof v !== "object") return false;
  if (isNode(v) && kindOf(v) === kind) return true;
  return Object.values(isNode(v) ? bodyOf(v) : v as Body).some((x) => holdsKind(x, kind));
}

/**
 * AN AGGREGATE'S FILTER GUARDS ITS ARGUMENTS: Postgres evaluates an aggregate's arguments and ORDER BY only on the rows
 * its FILTER keeps, DuckDB on every row before it filters, so `min(a / b) FILTER (WHERE b <> 0)` raised 22012 where
 * Postgres answers (the oracle statement of min / max of a quotient). Each argument that reads a column
 * and is more than the column is read under a CASE of the filter, which DuckDB evaluates only where it holds. A filter
 * holding a subquery is left as it is (it would run twice), and so is a constant argument (percentile_cont's fraction
 * must stay one). So is a DISTINCT aggregate: DuckDB holds its ORDER BY to its arguments (42803), and a guarded
 * collation key no longer matched them (`string_agg(DISTINCT t, ', ') FILTER (…)`, the rerun at cc380e8d) — its
 * arguments may still raise on a row the filter drops.
 */
function guardFilters(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(guardFilters);
  if (v === null || typeof v !== "object") return v;
  const out = Object.fromEntries(Object.entries(v as Body).map(([k, x]) => [k, guardFilters(x)])) as Body;
  if (!isNode(v) || kindOf(v) !== "FuncCall") return out;
  const b = bodyOf(out as AstNode);
  const filter = b.agg_filter;
  if (!isNode(filter) || holdsKind(filter, "SubLink") || b.agg_distinct === true) return out;
  const guard = (a: AstNode): AstNode => kindOf(a) === "ColumnRef" || !holdsKind(a, "ColumnRef") ? a : caseWhen([[structuredClone(filter), a]], null);
  if (Array.isArray(b.args)) b.args = (b.args as AstNode[]).map(guard);
  if (Array.isArray(b.agg_order)) for (const sort of b.agg_order as AstNode[]) { const sb = bodyOf(sort); if (isNode(sb.node)) sb.node = guard(sb.node); }
  return out;
}

const isTypeName = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as Body).names) && "typemod" in (v as Body);
/** a type's name as the parser spells it: `bigint` is `pg_catalog.int8` once read */
const TYPE_ALIAS: Record<string, string> = { bigint: "int8", integer: "int4", int: "int4", smallint: "int2", real: "float4", double: "float8", "double precision": "float8", boolean: "bool", decimal: "numeric", varchar: "varchar", "character varying": "varchar" };
const canonicalType = (n: string[]): string => { const last = (n[n.length - 1] ?? "").toLowerCase(); return TYPE_ALIAS[last] ?? last; };

/**
 * THE MASON FUNCTIONS A REWRITTEN TREE CALLS: every `FuncCall` of a `__mason_*` name in it (`fn` builds each, the
 * stored path's `__mason_json_get` behind its CASE included), sorted, each once. What the plan carries to the executor
 * (src/duck/plan.ts PlannedSql `functions`), which cancels a statement that calls one through its session and
 * interrupts one that calls none (src/duck/store.ts "HOW A STATEMENT IS CANCELLED"). Read off the TREE, never the
 * printed text: a `__mason_` in the text is also a stored path's column or the view of a copy's visible columns
 * (src/duck/kept-route.ts), which call nothing — read as a call, every `SELECT *` over a copy with a stored path could
 * no longer be timed out or cancelled (a review finding).
 */
/**
 * EVERY VECTOR OF A MASON FUNCTION PASSES THROUGH THE TURN (src/duck/functions.ts `registerTurn` says why): the session,
 * a call's first argument, becomes `__mason_turn(<the session>, <an argument>)`, so a thread leaves the running queue of
 * calls before it computes the next vector, and one statement cannot hold the executor's loop for 1,000 calls. On the
 * finished tree, once, so no rule of the rewrite meets it and the two copies of the argument are not one node.
 *
 * The argument is there to make the turn run per vector: of constants alone DuckDB would fold it once, and a call whose
 * arguments are all constant is folded too and needs none. It is the call's own argument, whole, never a column read
 * out of it: `f(a + b)` under `GROUP BY a + b` binds, `a` alone would not. DuckDB computes it again where it cannot share
 * it, so the cheapest that qualifies is taken, and one that may not be repeated never is:
 *  - a Mason call in it would run twice. A call with no other argument relies on the turn of the call inside it, which
 *    a thread takes on the same vector;
 *  - a subquery, a window, an `unnest` or a `COLUMNS` is work or rows of its own; a `*` no value `ANY` can type. (A bare `$n` reads no
 *    column, so it is never chosen; a `$n` beside a column, `a = $1`, is typed by the column.)
 * A statement with no such argument keeps its calls as they are: it reads no column, so it calls for few rows.
 */
export function giveTurns(tree: unknown): void {
  const never = (n: unknown): boolean => {
    if (Array.isArray(n)) return n.some(never);
    if (n === null || typeof n !== "object") return false;
    return Object.entries(n).some(([k, v]) => k === "SubLink" || k === "A_Star" || k === "over"
      || (k === "FuncCall" && /^(unnest|columns|__mason_.*)$/.test(lastName((v as Body).funcname))) || never(v));
  };
  const readsColumn = (n: unknown): boolean => {
    if (Array.isArray(n)) return n.some(readsColumn);
    if (n === null || typeof n !== "object") return false;
    return Object.entries(n).some(([k, v]) => k === "ColumnRef" || readsColumn(v));
  };
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n === null || typeof n !== "object") return;
    for (const [k, v] of Object.entries(n)) {
      if (k === "FuncCall" && v !== null && typeof v === "object") {
        const name = lastName((v as Body).funcname);
        const [session, ...args] = ((v as Body).args ?? []) as AstNode[];
        if (name.startsWith("__mason_") && name !== TURN_FUNCTION && lastName((session as Body | undefined)?.FuncCall?.funcname) === "getvariable") {
          const by = args.filter((a) => readsColumn(a) && !never(a)).map((a) => ({ a, size: JSON.stringify(a).length })).sort((x, y) => x.size - y.size)[0];
          if (by !== undefined) (v as Body).args = [{ FuncCall: { funcname: [S(TURN_FUNCTION)], args: [session, structuredClone(by.a)], funcformat: "COERCE_EXPLICIT_CALL" } }, ...args];
        }
      }
      walk(v);
    }
  };
  walk(tree);
}

export function masonCalls(tree: unknown): string[] {
  const found = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    if (n === null || typeof n !== "object") return;
    for (const [k, v] of Object.entries(n)) {
      if (k === "FuncCall" && v !== null && typeof v === "object") {
        const name = lastName((v as Body).funcname);
        if (name.startsWith("__mason_") && name !== TURN_FUNCTION) found.add(name);
      }
      walk(v);
    }
  };
  walk(tree);
  return [...found].sort();
}

/**
 * The printed statement READ BACK holds the rewritten tree: every field the tree has, equal (offsets aside), where the
 * parser may add the defaults a built node leaves out (a `location`, `typemod: -1`, `inh: true`). A field the printer
 * dropped or changed (a `WITH TIES`, an operator) is a difference.
 */
export function sameTree(back: unknown, tree: unknown): boolean { return treeDifference(back, tree) === null; }

/** where the read-back tree first differs from the rewritten one (a path and both values), or null */
export function treeDifference(back: unknown, tree: unknown, at = "$"): string | null {
  const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 120) ?? String(v);
  if (isTypeName(tree) && isTypeName(back)) {
    const { names: _a, ...restTree } = tree as Body, { names: _b, ...restBack } = back as Body;
    const [t, b] = [canonicalType(names((tree as Body).names)), canonicalType(names((back as Body).names))];
    return t !== b ? `${at}.names: ${b} where the rewrite has ${t}` : treeDifference(restBack, restTree, at);
  }
  if (Array.isArray(tree)) {
    if (!Array.isArray(back) || back.length !== tree.length) return `${at}: ${show(back)} where the rewrite has ${show(tree)}`;
    for (let i = 0; i < tree.length; i++) { const d = treeDifference(back[i], tree[i], `${at}[${i}]`); if (d !== null) return d; }
    return null;
  }
  if (tree === null || typeof tree !== "object") return back === tree || (typeof tree === "number" && Number(back) === tree) ? null : `${at}: ${show(back)} where the rewrite has ${show(tree)}`;
  if (back === null || typeof back !== "object" || Array.isArray(back)) return `${at}: ${show(back)} where the rewrite has ${show(tree)}`;
  for (const [k, v] of Object.entries(tree as Body)) {
    if (k === "location" || k === "stmt_location" || k === "stmt_len" || /(^|_)list_(start|end)$/.test(k)) continue;
    const d = treeDifference((back as Body)[k], v, `${at}.${k}`);
    if (d !== null) return d;
  }
  return null;
}
