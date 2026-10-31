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
 *    (`DuckCollation`): ICU's through DuckDB's own ICU collation, libc's through a sort key that ignores punctuation
 *    first, as glibc's locales do;
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
import type { GapId, PostgresRefuses } from "./gaps.ts";
import type { PgAnalysis } from "./analyze.ts";
import { pathIndex, SESSION_VARIABLE, SETTINGS_VARIABLE, TURN_FUNCTION, type CaseMode, type JsonKind, type PgKind } from "./functions.ts";
import { cellsOf as cellsOfProgram, numericLiteral, type NumericProgram } from "../lib/pg-numeric.ts";
import { caseTwins, joinsUsing, type Typed } from "./pgtree.ts";
import { canonicalRead, EQUAL_STEPS, KEY_NULL_HEX, KEY_RECOMPUTE_HEX, MARKED_FUNCTIONS, markedError, ORDER_STEPS, readKey, type JsonRead, type KeptLookup } from "./kept-route.ts";
import { JSONB_KEY_FUNCTIONS } from "./jsonb-order.ts";
import { atTimeZoneOf, isUtc, UTC_NAMES } from "../lib/timezone.ts";

/** A parse-tree node (`{ Kind: body }`) and a body, as libpg-query's JSON has them. */
type Body = Record<string, any>;
type AstNode = Record<string, Body>;

/** How the source database orders text (pg_database's datlocprovider / datcollate / datlocale), as DuckDB can follow it. */
export type DuckCollation =
  /** byte order; `ascii` where the database's ctype is the C locale's too (upper() changes ASCII letters only) */
  | { kind: "bytes"; ascii?: boolean }
  /** ICU: DuckDB's own ICU collation of that locale gives the same order (held to Postgres by tests/integration/duck-oracle.itest.ts) */
  | { kind: "icu"; name: string }
  /** a libc locale (glibc's en_US.UTF-8, RDS's default): ICU's order of the letters and digits, then the punctuation */
  | { kind: "libc"; icu: string };

/** the DuckDB ICU collation a collation's strings are keyed by (`icu_sort_key`): ICU's own, or the one a libc order's
 *  accent and case levels are read with */
export const icuNameOf = (c: Exclude<DuckCollation, { kind: "bytes" }>): string => c.kind === "icu" ? c.name : c.icu;

/** Whether pg_database's collation is a libc locale's (not C or POSIX), whose order is read from the database
 *  (src/duck/libc-order.ts) for `duckCollation`'s `libc` */
export const isLibcCollation = (provider: string, collate: string): boolean =>
  provider !== "b" && provider !== "i" && !/^(C|POSIX)([.].*)?$/i.test(collate);

/** The source's collation as DuckDB follows it, from pg_database: `provider` c (libc), i (ICU) or b (builtin). */
export function duckCollation(provider: string, collate: string, locale: string | null, known: ReadonlySet<string>): DuckCollation {
  const icuName = (l: string): string | null => {
    const lang = l.replace(/[.@].*$/, "").replace(/-/g, "_").toLowerCase();
    if (known.has(lang)) return lang;
    const base = lang.split("_")[0]!;
    return known.has(base) ? base : null;
  };
  if (provider === "b") return { kind: "bytes" };
  if (/^(C|POSIX)([.].*)?$/i.test(collate) && provider !== "i") return { kind: "bytes", ascii: true };
  if (provider === "i") {
    const name = icuName(locale ?? collate);
    if (name === null) throw new Error(`the source database's ICU locale ${JSON.stringify(locale ?? collate)} has no collation in the engine: Mason cannot sort text as it does`);
    return { kind: "icu", name };
  }
  const name = icuName(collate);
  if (name === null) throw new Error(`the source database's collation ${JSON.stringify(collate)} has no collation in the engine to follow: Mason cannot sort text as it does`);
  return { kind: "libc", icu: name };
}

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
  cells: Array<"exact" | "float8" | "float4" | "text">;
  /** the column is the program's text (`(x / 3)::text`) */
  text: boolean;
}

/** a column of a table's row type, as the catalog has it */
export interface RowColumn { name: string; type: number; typmod: number }

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

const INT2 = 21, INT4 = 23, INT8 = 20, FLOAT4 = 700, FLOAT8 = 701, NUMERIC = 1700, TEXT = 25, VARCHAR = 1043, BPCHAR = 1042, NAME = 19;
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
const TEXTS = new Set([TEXT, VARCHAR, BPCHAR, NAME, UNKNOWN]);
const JSONS = new Set([JSON_OID, JSONB]);
const JSONB_ARRAY = 3807;
/** the way out of a jsonb comparison Mason does not key (gap jsonb-compare) */
const JSONB_WAY_OUT = "compare a member (j ->> 'k'), or j::text for the canonical text";
const BOOL = 16, UUID = 2950, TIME = 1083, BYTEA = 17;
/** pg_type's array types of the element types above */
const ARRAYS = new Set([1000, 1001, 1005, 1007, 1009, 1014, 1015, 1016, 1021, 1022, 1028, 1115, 1182, 1183, 1185, 1187, 1231, 2951, 199, 3807]);
/** inet[], which the copy holds as a list of its text (src/duck/sync.ts KEPT_ARRAYS) */
const INET_ARRAY = 1041;
/** numeric[] and record[] */
const NUMERIC_ARRAY = 1231, RECORD_ARRAY = 2287;
/** pg_collation's C and POSIX: byte order */
const BYTE_COLLATIONS = new Set([950, 951]);

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
  BoolExpr: ["BOOLEXPR"], A_ArrayExpr: ["ARRAYEXPR"], RowExpr: ["ROWEXPR"], SQLValueFunction: ["SQLVALUEFUNCTION"],
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
  private readonly collation: DuckCollation;
  private readonly params: readonly number[];
  /** bodies whose rule has run: a rule may wrap its own node, which must not be rewritten twice */
  private readonly done = new WeakSet<Body>();
  /** the statement's own bodies (and copies of them): only these are rewritten, never a node a rule built */
  private readonly original = new WeakSet<Body>();
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
  /** how the database changes a letter's case */
  private readonly caseMode: CaseMode;

  /** the ANY / ALL comparisons already guarded against a NULL array (the guard holds the comparison, walked again) */
  private readonly nullArrayTested = new WeakSet<Body>();
  /** the catalog's enums: each one's labels in their declared order, and its array type's element */
  private readonly enums: EnumTypes;
  /** the catalog's user types by OID (`citext`), for the few the rewrite knows (src/duck/plan.ts reads pg_type) */
  private readonly userTypes: ReadonlyMap<number, string>;
  /** a copied table's row type: its columns, by the catalog's OID (src/duck/plan.ts) */
  private readonly rowTypes: ReadonlyMap<number, readonly RowColumn[]>;
  /** the session's TimeZone the statement was analysed under (a relative literal's day is its) */
  private readonly timeZone: string;
  /** the stored JSON paths (src/duck/kept-route.ts): null where none is consulted (the feature off, a test) */
  private readonly kept: KeptLookup | null;
  /** every read of a copied table's JSON column by literal steps the statement makes, stored or not: the request log's
   *  `json_reads`, which the keeper's policy reads (src/duck/kept.ts `review`) */
  readonly jsonReads = new Map<string, JsonRead>();
  constructor(analysis: PgAnalysis, base: number, collation: DuckCollation, userTypes: ReadonlyMap<number, string> = new Map(), rowTypes: ReadonlyMap<number, readonly RowColumn[]> = new Map(), timeZone = "UTC",
    enums: EnumTypes = { labels: new Map(), arrays: new Map() }, kept: KeptLookup | null = null, keyCounts: ReadonlySet<number> = new Set()) {
    this.types = analysis.types; this.analysed = analysis.outputs; this.base = base; this.collation = collation; this.params = analysis.params; this.userTypes = userTypes; this.rowTypes = rowTypes; this.timeZone = timeZone;
    this.enums = enums; this.kept = kept;
    for (const at of keyCounts) this.keyCounts.add(at + base);
    this.caseMode = collation.kind === "icu" ? "icu" : collation.kind === "bytes" && collation.ascii === true ? "ascii" : "libc";
    this.twins = caseTwins(analysis.tree);
  }

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
    const t = kindOf(base) === "ColumnRef" ? this.typed(base) : null;
    const copied = t !== null && t.node === "VAR" && t.relation !== undefined;
    return this.keptRead(base, steps, either, canonical, asText) ?? jsonGet(this.cp, base, steps, either, canonical, asText, canonical && copied);
  }

  private isCitext(oid: number | null): boolean { return oid !== null && this.userTypes.get(oid) === "citext"; }

  /** a text lower-cased by the database's case rules (what Postgres's citext compares, sorts and groups: str_tolower
   *  under the default collation) */
  private lowerOf(n: AstNode): AstNode {
    return this.caseMode === "libc" ? fn("lower", [n]) : fn("__mason_case", [n, boolConst(false), strConst(this.caseMode)]);
  }

  /** a citext value as the text citext compares: lower-cased, typed as text under the database's collation, so the
   *  text rules (the collation's sort keys, LIKE's escape) apply to it */
  private foldCitext(n: AstNode): AstNode {
    const out = this.lowerOf(n);
    this.synthetic.set(bodyOf(out), { node: "FUNCEXPR", type: TEXT, typmod: -1, args: [], oid: null, format: null, collation: 100, inputCollation: 100, levelsUp: null, datum: null, qualifier: null, renamed: null });
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
  /** what `widen` made, and the type it made it: a rule after it reads that type (a date widened to a timestamptz is
   *  one, never cast again), and a second pass leaves it as it is — a SELECT's expression and its GROUP BY twin must
   *  print alike, or DuckDB refuses the grouping (42803) */
  private readonly widened = new WeakMap<Body, number>();

  /** a literal Postgres analysed only where the statement repeats it (src/duck/rewrite.ts `typeCast`) */
  private readonly constLike = new WeakMap<Body, Typed>();

  /** the analysed type of each expression's shape (its tree less offsets), from the first place it was analysed */
  private readonly byShape = new Map<string, Typed>();

  /** after `adopt`: every expression of the statement whose offset Postgres analysed, by its shape */
  indexShapes(v: unknown): void {
    if (Array.isArray(v)) { for (const x of v) this.indexShapes(x); return; }
    if (v === null || typeof v !== "object") return;
    if (isNode(v)) {
      const t = this.typedAt(v);
      if (t !== null) { const k = shapeOf(v); if (!this.byShape.has(k)) this.byShape.set(k, t); }
    }
    for (const x of Object.values(isNode(v) ? bodyOf(v) : v as Body)) this.indexShapes(x);
  }

  private typedAt(n: AstNode): Typed | null {
    const k = kindOf(n);
    const b = bodyOf(n);
    const own = this.synthetic.get(b);
    if (own !== undefined) return own;
    if (k === "TypeCast") {
      // a cast to the type the value already has leaves no node of its own: the value's
      return this.at(b, ANALYSED.TypeCast!) ?? (b.arg !== undefined ? this.typedAt(b.arg) : null);
    }
    if (k === "CollateClause") return b.arg !== undefined ? this.typedAt(b.arg) : null;
    // a node the rewrite made that reads as another (decidedByKey's any_value, a set operation's sort column)
    const like = this.typedLike.get(b);
    if (like !== undefined) return this.typed(like);
    const kinds = ANALYSED[k];
    return kinds === undefined ? null : this.at(b, kinds);
  }

  private at(b: Body, kinds: readonly string[]): Typed | null {
    if (typeof b.location !== "number" || b.location < 0) return null;
    return this.types.get(b.location - this.base)?.find((t) => kinds.includes(t.node)) ?? null;
  }

  typeOf(n: AstNode): number | null { return this.widened.get(bodyOf(n)) ?? this.typed(n)?.type ?? null; }

  // ------------------------------------------------------------------------------------------------ the walk

  /** marks every body of the statement as its own */
  adopt(v: unknown): void {
    if (Array.isArray(v)) { for (const x of v) this.adopt(x); return; }
    if (v === null || typeof v !== "object") return;
    if (isNode(v)) this.original.add(bodyOf(v));
    for (const [k, x] of Object.entries(isNode(v) ? bodyOf(v) : v as Body)) this.adopt(armOf(k, x) ?? x);
  }

  /** `clone` for the helpers outside the class */
  readonly cp: Copy = (n) => this.clone(n);

  /** a deep copy that stays the statement's own (a rule that uses a node twice rewrites each use) */
  clone<T>(v: T): T {
    if (Array.isArray(v)) return v.map((x) => this.clone(x) as unknown) as T;
    if (v === null || typeof v !== "object") return v;
    const out: Body = {};
    for (const [k, x] of Object.entries(v as Body)) out[k] = this.clone(x);
    if (isNode(v) && this.original.has(bodyOf(v))) this.original.add(bodyOf(out as AstNode));
    // a node the rewrite typed itself stays typed (a picked operand of min / max, exactOf)
    const own = isNode(v) ? this.synthetic.get(bodyOf(v)) : undefined;
    if (own !== undefined) this.synthetic.set(bodyOf(out as AstNode), own);
    // and one typed as another (decidedByKey's any_value): a grouped ORDER BY 1 over a jsonb is keyed over its copy
    const like = isNode(v) ? this.typedLike.get(bodyOf(v)) : undefined;
    if (like !== undefined) this.typedLike.set(bodyOf(out as AstNode), like);
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
      // CASE x WHEN v …: each WHEN is x = v, jsonb's equality for a jsonb (its keys compared)
      case "CaseExpr": {
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
        return null;
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
  private typedRef(names: readonly string[], type: number, typmod: number): AstNode {
    const n: AstNode = { ColumnRef: { fields: names.map(S) } };
    this.synthetic.set(bodyOf(n), { node: "VAR", type, typmod, args: [], oid: null, format: null, collation: TEXTS.has(type) ? 100 : 0, inputCollation: 0, levelsUp: 0, datum: null, qualifier: null, renamed: null });
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
    if (table !== undefined) return table.map((c) => ({ name: c.name, value: this.typedRef([alias, c.name], c.type, c.typmod), type: c.type }));
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
      return { name, value: this.typedRef([alias, name], typed?.type ?? TEXT, typed?.typmod ?? -1), type: typed?.type ?? null };
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
        if (cols !== null) return this.recordText(cols);
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
    // `x IS NULL, x DESC` as `x DESC NULLS LAST` (nullsKeyFolded): the folded key is the statement's own, its rules to
    // run; before anything writes a key another way, as the two are told alike by their trees
    if (Array.isArray(b.sortClause)) {
      b.sortClause = nullsKeyFolded(b.sortClause as AstNode[], b);
      for (const s of b.sortClause as AstNode[]) this.original.add(bodyOf(s));
    }
    this.namedThroughStar(b);
    this.starWrittenOut(b);
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
    }
    this.decidedByKey(b);
    // (after decidedByKey: a DISTINCT ON a target names it as the SELECT list reads it, through any_value where it must)
    this.keyedDistinct(b);
    // the statement's own ORDER BY: an ordinal or an output name sorts by that target's expression, so its key is
    // built over the expression (DuckDB's `ORDER BY 1 COLLATE …` would sort by the constant)
    if (Array.isArray(b.sortClause) && Array.isArray(b.targetList) && (b.op === undefined || b.op === "SETOP_NONE")) {
      const targets = b.targetList as AstNode[];
      b.sortClause = (b.sortClause as AstNode[]).flatMap((s) => {
        const sb = bodyOf(s);
        this.done.add(sb);
        return this.sortBy(sb, targets, b) ?? [s];
      });
    }
    if (Array.isArray(b.sortClause) && b.op !== undefined && b.op !== "SETOP_NONE") this.setOperationOrdinals(b);
    if (b.limitOption === "LIMIT_OPTION_WITH_TIES") return this.withTies(b);
    return null;
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
    const held = (n: unknown): number[] => {
      if (Array.isArray(n)) return n.flatMap(held);
      if (n === null || typeof n !== "object") return [];
      // (a subquery's targets are its own: this SELECT's offsets alone find this SELECT's query)
      return Object.entries(n).flatMap(([k, x]) => k === "location" && typeof x === "number" ? [x] : k === "subselect" || k === "SelectStmt" ? [] : held(x));
    };
    const query = stars.length === 0 ? undefined : held(targets).map((l) => this.analysed.get(l - this.base)).find((q) => q !== undefined);
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
      if (!hasStar(v)) { at++; out.push({ target, name: typeof bodyOf(t).name === "string" ? bodyOf(t).name : figureColname(v), value: v, star: false, twin: false }); return; }
      const width = widthOf(t) ?? (bare === 0 ? 0 : rest / bare);
      for (const c of query?.columns.slice(at, at + width) ?? []) {
        const n = c?.column;
        if (c === null || c === undefined || n === undefined) throw new Error("a column of a * is no column in Postgres's analysis: report it, with the statement");
        const value: AstNode = { ColumnRef: { fields: [...(n.owner === null ? [] : [S(n.owner)]), S(n.name)], location: -1 } };
        this.original.add(bodyOf(value));
        this.synthetic.set(bodyOf(value), c);
        out.push({ target, name: n.name, value, star: true, twin: n.twin === true });
      }
      at += width;
    });
    return out;
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
  }

  private twinRefused(): Unrewritable {
    return new Unrewritable("this * of a named join lists two columns of one name, and Mason cannot read one of them apart here", "name the join's columns in the SELECT, or leave the join's own name out", "star-join-twin");
  }

  /** the output a number names, or null for a number past the list */
  private outputAt(targets: readonly AstNode[], n: number): Output | null { return n >= 1 ? this.outputs(targets)[n - 1] ?? null : null; }

  /** the output an ORDER BY item reads: by its number, or by its bare name (SQL92's rule: an output before an input
   *  column; two outputs of one name reach here only as Postgres found them equal) */
  private outputOf(e: AstNode, targets: readonly AstNode[]): Output | null {
    const n = constInt(e);
    if (n !== null) return this.outputAt(targets, n);
    if (kindOf(e) !== "ColumnRef") return null;
    const f = names(bodyOf(e).fields);
    return f.length !== 1 ? null : this.outputs(targets).find((o) => o.name === f[0]) ?? null;
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
    const c = this.textCollation(n);
    return (c === null || c.kind === "bytes") && type !== BPCHAR && !this.isCitext(type) && type !== INET && !(type !== null && [JSONB, JSONB_ARRAY, 1009, 1015].includes(type));
  }

  /**
   * A SET OPERATION'S ORDER BY of a text column (`… UNION … ORDER BY 1`, or `ORDER BY status` where the first SELECT
   * says `o.status`): Postgres sorts by its output column, which it analysed at no offset of the ORDER BY's own, so the
   * SortBy rule found no type and DuckDB sorted by bytes. Each is typed as the first SELECT's target, and an ordinal is
   * sorted by that output column's name, so the rule builds the collation's keys. A target with no name of its own is
   * given one: Postgres's analysis names the columns the tool reads, never DuckDB's.
   */
  private setOperationOrdinals(b: Body): void {
    // a set operation's arms are SelectStmt bodies, unwrapped (libpg-query's larg / rarg)
    let arm: Body = b;
    while (arm.op !== undefined && arm.op !== "SETOP_NONE" && arm.larg !== undefined) arm = isNode(arm.larg) ? bodyOf(arm.larg) : arm.larg as Body;
    const targets = (arm.targetList ?? []) as AstNode[];
    const outputs = this.outputs(targets);
    for (const s of b.sortClause as AstNode[]) {
      const sb = bodyOf(s);
      const by = sb.node as AstNode;
      const f = kindOf(by) === "ColumnRef" ? names(bodyOf(by).fields) : [];
      if (f.length === 1) {
        const named = outputs.filter((o) => o.name === f[0]);
        if (named.length === 1) this.typedLike.set(bodyOf(by), named[0]!.value);
        continue;
      }
      const n = constInt(by);
      const out = n === null ? null : this.outputAt(targets, n);
      if (out === null) continue;
      const value = out.value;
      if (out.star) {
        // a set operation's ORDER BY reads an output by its name alone: a column of a `*` has no other
        if (outputs.filter((o) => o.name === out.name).length !== 1) throw new Unrewritable("ORDER BY a column number of a set operation whose first SELECT lists two columns of that name is not supported by Mason", "name the columns apart in the first SELECT", "setop-ordinal-star");
        if (this.sortsAsStored(value)) continue;
        const named: AstNode = { ColumnRef: { fields: [S(out.name)] } };
        this.typedLike.set(bodyOf(named), value);
        sb.node = named;
        continue;
      }
      const target = bodyOf(targets[out.target]!);
      if (this.sortsAsStored(value)) continue;
      if (target.name === undefined) target.name = `__mason_sort_${n}`;
      const ref: AstNode = { ColumnRef: { fields: [S(String(target.name))] } };
      this.typedLike.set(bodyOf(ref), value);
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
    // a target the GROUP BY names by its ordinal or its output name is a key itself, and DuckDB reads it there: untouched
    const keyTargets = new Set<number>();
    for (const g of groups) {
      const n = constInt(g);
      const out = n === null ? null : this.outputAt(targets, n);
      if (out !== null) { keyTargets.add(out.target); continue; }
      // a bare name is an output name only where it is no input column (Postgres prefers the column)
      const f = kindOf(g) === "ColumnRef" ? names(bodyOf(g).fields) : [];
      if (f.length === 1 && this.typedAt(g)?.node !== "VAR") targets.forEach((t, i) => { if (bodyOf(t).name === f[0]) keyTargets.add(i); });
    }
    const grouped = new Set([...groups.map(shapeOf), ...[...keyTargets].map((i) => shapeOf(bodyOf(targets[i]!).val as AstNode))]);
    // `depth`: the subqueries between here and this query (a correlated subquery's column of this query is levelsUp 1)
    const wrap = (v: unknown, depth: number): unknown => {
      if (Array.isArray(v)) return v.map((x) => wrap(x, depth));
      if (v === null || typeof v !== "object") return v;
      // a plain body (a window's OVER, a SubLink's select): its parts
      if (!isNode(v)) { for (const [key, x] of Object.entries(v as Body)) if (key !== "location") (v as Body)[key] = wrap(x, depth); return v; }
      const k = kindOf(v), n = bodyOf(v);
      if (grouped.has(shapeOf(v))) return v;
      if (k === "SubLink") { for (const [key, x] of Object.entries(n)) if (key !== "location") n[key] = wrap(x, depth + 1); return v; }
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
        const f = names(n.fields);
        if (depth === 0 && f.length === 1 && this.typedAt(v) === null && targets.some((t) => bodyOf(t).name === f[0])) return v;
        const t = this.typed(v);
        if (t?.node !== "VAR" || t.levelsUp !== depth) return v;
        const call: AstNode = { FuncCall: { funcname: [S("any_value")], args: [v], funcformat: "COERCE_EXPLICIT_CALL" } };
        this.done.add(bodyOf(call));
        // typed as the column it reads: a sort's collation, a cast's source type
        this.typedLike.set(bodyOf(call), v);
        return call;
      }
      for (const [key, x] of Object.entries(n)) if (key !== "location") n[key] = wrap(x, depth);
      return v;
    };
    targets.forEach((t, i) => { if (!keyTargets.has(i)) { const tb = bodyOf(t); tb.val = wrap(tb.val, 0); } });
    if (b.havingClause !== undefined) b.havingClause = wrap(b.havingClause, 0);
    if (Array.isArray(b.sortClause)) for (const s of b.sortClause as AstNode[]) { const sb = bodyOf(s); sb.node = wrap(sb.node, 0); }
  }

  /**
   * `FETCH FIRST n ROWS WITH TIES` (DuckDB has none): the rows whose rank under the ORDER BY is at most n — the
   * statement, with that rank as a column of its own, read by a statement around it that keeps those rows in the
   * same order and leaves the rank out (`* EXCLUDE`, DuckDB's).
   */
  private withTies(b: Body): AstNode {
    if (b.distinctClause !== undefined) throw new Unrewritable("FETCH … WITH TIES over a SELECT DISTINCT is not supported by Mason (the engine has no WITH TIES)", "select the DISTINCT rows in a subquery and FETCH … WITH TIES from it", "with-ties-distinct");
    const order = (b.sortClause as AstNode[] | undefined) ?? [];
    const count = b.limitCount as AstNode;
    delete b.limitCount;
    b.limitOption = "LIMIT_OPTION_DEFAULT";
    const offset = b.limitOffset as AstNode | undefined;
    delete b.limitOffset;
    const rankName = "__mason_rank";
    const sortCopy = order.map((o) => this.clone(o));
    for (const s of sortCopy) this.done.add(bodyOf(s));
    const rank: AstNode = { FuncCall: { funcname: [S("rank")], over: { orderClause: sortCopy, frameOptions: 1058 }, funcformat: "COERCE_EXPLICIT_CALL" } };
    this.done.add(bodyOf(rank));
    b.targetList = [...(b.targetList as AstNode[]), { ResTarget: { name: rankName, val: rank } }];
    const inner: AstNode = { SelectStmt: b };
    // the rank of the first row past the offset is offset + 1; a row is kept while its rank is within offset + n
    const bound = offset === undefined ? count : op("+", offset, count);
    const outer: Body = {
      targetList: [{ ResTarget: { val: { ColumnRef: { fields: [{ A_Star: {} }] } } } }],
      fromClause: [{ RangeSubselect: { subquery: inner, alias: { aliasname: "__mason_ties" } } }],
      whereClause: op("<=", { ColumnRef: { fields: [S(rankName)] } }, bound),
      sortClause: [{ SortBy: { node: { ColumnRef: { fields: [S(rankName)] } }, sortby_dir: "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }],
      op: "SETOP_NONE",
    };
    if (offset !== undefined) outer.limitOffset = offset;
    this.done.add(outer);
    this.excludeRank = true;
    return { SelectStmt: outer };
  }

  /** the outer WITH TIES statement reads `*` and must not send its rank: the server drops that last column */
  excludeRank = false;

  // ------------------------------------------------------------------------------------- exact numerics

  /** The statement's numeric result columns as programs, their cells appended to its SELECT list (before the walk,
   *  which rewrites each cell as it rewrites the column). Only a plain SELECT: a UNION or a DISTINCT would read the
   *  hidden cells as part of each row. */
  exactColumns(stmt: AstNode, fields: ReadonlyArray<{ oid: number; typmod?: number }> | null): ExactColumn[] {
    if (kindOf(stmt) !== "SelectStmt" || fields === null) return [];
    const b = bodyOf(stmt);
    if ((b.op !== undefined && b.op !== "SETOP_NONE") || b.distinctClause !== undefined || b.limitOption === "LIMIT_OPTION_WITH_TIES") return [];
    const targets = (b.targetList ?? []) as AstNode[];
    if (targets.length !== fields.length || targets.some((t) => hasStar(bodyOf(t).val))) return [];
    const grouped = (Array.isArray(b.groupClause) && b.groupClause.length > 0) || b.havingClause !== undefined || targets.some((t) => this.hasAggregate(bodyOf(t).val));
    const groupShapes = new Set(((b.groupClause ?? []) as AstNode[]).map((g) => {
      const n = constInt(g);
      return shapeOf(n !== null && n >= 1 && n <= targets.length ? bodyOf(targets[n - 1]!).val as AstNode : g);
    }));
    const cells: Array<{ node: AstNode; conv: "exact" | "float8" | "float4" | "text"; shape: string }> = [];
    const out: ExactColumn[] = [];
    targets.forEach((target, i) => {
      const field = fields[i]!;
      let node = bodyOf(target).val as AstNode;
      let text = false;
      // a numeric's text (a varchar(n) cuts it, which the program does not: left to the rewrite's cast)
      if (TEXTS.has(field.oid) && (field.typmod ?? -1) < 0 && kindOf(node) === "TypeCast" && this.typeOf(bodyOf(node).arg as AstNode) === NUMERIC) { node = bodyOf(node).arg as AstNode; text = true; }
      else if (field.oid !== NUMERIC) return;
      const mine: typeof cells = [];
      const cell = (n: AstNode, conv: "exact" | "float8" | "float4" | "text" = "exact"): NumericProgram => {
        if (grouped && !this.validGrouped(n, groupShapes)) throw NOT_EXACT;
        const shape = `${conv}:${shapeOf(n)}`;
        let at = mine.findIndex((c) => c.shape === shape);
        if (at < 0) { mine.push({ node: n, conv, shape }); at = mine.length - 1; }
        return { op: "cell", key: String(at) };
      };
      let built: Built | null;
      try { built = this.exactOf(node, cell); } catch (e) { if (e === NOT_EXACT) return; throw e; }
      if (built === null || !worthComputing(built.p) && mine.every((c) => c.conv === "exact")) return;
      // a numeric(p, s) column as it is: the wire pads it to s (src/duck/types.ts pgTypedColumn), no program needed
      if (built.p.op === "pad" && built.p.arg.op === "cell" && !text && (field.typmod ?? -1) >= 4 && ((field.typmod! - 4) & 0xffff) === built.p.scale) return;
      // the column's cells after every earlier column's
      const base = cells.length;
      cells.push(...mine);
      out.push({ column: i, program: offsetCells(built.p, base), cells: [], text });
    });
    if (out.length === 0) return [];
    for (const c of out) c.cells = cells.map((x) => x.conv);
    b.targetList = [...targets, ...cells.map((c, j) => ({ ResTarget: { name: `__mason_cell_${j}`, val: this.clone(c.node) } }))];
    return out;
  }

  /**
   * The exact columns of a statement whose outermost query PASSES THROUGH what an inner one computed: `SELECT * FROM
   * (inner) s`, a CTE read whole, the columns of one subquery by name (Metabase's nested question), a UNION ALL whose
   * every arm builds the same programs. The inner query selects its cells (`exactColumns`), the outer selects them
   * after its own columns, and the programs are the inner's at the outer's column. Anything else that computes over an
   * inner exact numeric reads DuckDB's value (docs/SQL-SUPPORT.md `nested-exact-numeric`).
   */
  exactThrough(stmt: AstNode, fields: ReadonlyArray<{ oid: number; typmod?: number }> | null): ExactColumn[] {
    if (fields === null || kindOf(stmt) !== "SelectStmt") return [];
    // the query's CTEs are visible to every query inside it (`WITH base AS (…) SELECT b.x FROM (SELECT * FROM base) b`)
    const ctes = bodyOf(stmt).withClause?.recursive === true ? [] : ((bodyOf(stmt).withClause?.ctes ?? []) as AstNode[]);
    this.cteScope.push(ctes);
    try { return this.exactThroughIn(stmt, fields); } finally { this.cteScope.pop(); }
  }

  /** the CTEs of the queries `exactThrough` is inside, outermost first (a recursive WITH's are none: never read whole) */
  private readonly cteScope: AstNode[][] = [];

  private exactThroughIn(stmt: AstNode, fields: ReadonlyArray<{ oid: number; typmod?: number }>): ExactColumn[] {
    const b = bodyOf(stmt);
    if (b.op === "SETOP_UNION" && b.all === true) return this.exactArms(b, fields);
    const direct = this.exactColumns(stmt, fields);
    if (direct.length > 0) return direct;
    const through = this.passThrough(b);
    if (through === null) return [];
    const inner = this.exactThrough(through.query, this.outputFields(through.query));
    if (inner.length === 0) return [];
    const cells = inner[0]!.cells.length;
    if (through.columns !== "star") {
      const targets = (b.targetList ?? []) as AstNode[];
      b.targetList = [...targets, ...Array.from({ length: cells }, (_, j) => ({ ResTarget: { name: `__mason_cell_${j}`,
        val: { ColumnRef: { fields: [S(through.alias), S(`__mason_cell_${j}`)] } } } }))];
    }
    const map = through.columns;
    return inner.flatMap((e) => (map === "star" ? [e.column] : map.flatMap((k, i) => k === e.column ? [i] : []))
      .filter((i) => i < fields.length && fields[i]!.oid === NUMERIC || e.text).map((column) => ({ ...e, column })));
  }

  /** a UNION ALL's arms, each with the same programs at the same columns (else none is computed) */
  private exactArms(b: Body, fields: ReadonlyArray<{ oid: number; typmod?: number }>): ExactColumn[] {
    const arms: AstNode[] = [];
    const flatten = (n: AstNode): void => {
      const x = bodyOf(n);
      if (x.op === "SETOP_UNION" && x.all === true && x.larg !== undefined && x.rarg !== undefined) { flatten({ SelectStmt: x.larg }); flatten({ SelectStmt: x.rarg }); }
      else arms.push(n);
    };
    flatten({ SelectStmt: b });
    // an arm typed otherwise than the union (an integer arm of a numeric column) is cast by Postgres: not this program
    if (arms.some((a) => { const f = this.outputFields(a); return f === null || f.some((x, i) => x.oid !== fields[i]?.oid); })) return [];
    const trial = arms.map((a) => this.exactThrough(this.clone(a), fields));
    const first = JSON.stringify(trial[0]);
    if (trial[0]!.length === 0 || trial.some((t) => JSON.stringify(t) !== first)) return [];
    const made = arms.map((a) => this.exactThrough(a, fields));
    return made[0]!;
  }

  /** an outer query that only reads one subquery's or CTE's columns: the inner query, its alias, and which inner
   *  column each outer one is ("star": all of them, in order) */
  private passThrough(b: Body): { query: AstNode; alias: string; columns: number[] | "star" } | null {
    if ((b.op !== undefined && b.op !== "SETOP_NONE") || b.groupClause !== undefined || b.havingClause !== undefined || b.distinctClause !== undefined || b.windowClause !== undefined) return null;
    const from = (b.fromClause ?? []) as AstNode[];
    if (from.length !== 1) return null;
    const f = from[0]!;
    let query: AstNode | undefined, alias: string | undefined;
    if (kindOf(f) === "RangeSubselect") { query = bodyOf(f).subquery as AstNode; alias = bodyOf(f).alias?.aliasname; }
    else if (kindOf(f) === "RangeVar" && bodyOf(f).schemaname === undefined) {
      // its own WITH first, then the enclosing queries', innermost first (a nearer CTE of the name shadows a farther)
      if (b.withClause?.recursive === true) return null;
      const scopes = [(b.withClause?.ctes ?? []) as AstNode[], ...[...this.cteScope].reverse()];
      const cte = scopes.map((list) => list.find((c) => bodyOf(c).ctename === bodyOf(f).relname)).find((c) => c !== undefined);
      if (cte === undefined || bodyOf(cte).aliascolnames !== undefined) return null;
      query = bodyOf(cte).ctequery as AstNode; alias = bodyOf(f).alias?.aliasname ?? bodyOf(f).relname;
    }
    if (query === undefined || alias === undefined || kindOf(query) !== "SelectStmt") return null;
    if (bodyOf(f).alias?.colnames !== undefined) return null;
    const targets = (b.targetList ?? []) as AstNode[];
    if (targets.some((t) => this.hasAggregate(bodyOf(t).val))) return null;
    if (targets.length === 1 && hasStar(bodyOf(targets[0]!).val)) return { query, alias, columns: "star" };
    const outputs = this.outputNames(query);
    if (outputs === null) return null;
    const columns = targets.map((t) => {
      const v = bodyOf(t).val as AstNode;
      if (kindOf(v) !== "ColumnRef" || hasStar(v)) return -1;
      const f = names(bodyOf(v).fields);
      const at = outputs.indexOf(f[f.length - 1]!);
      return at >= 0 && outputs.lastIndexOf(f[f.length - 1]!) === at ? at : -1;
    });
    return { query, alias, columns };
  }

  /** the query a `SELECT * FROM (q) s` passes through whole, or null: its output names and types are q's (a BI tool's
   *  `SELECT "sql".* FROM (…) AS "sql"` inside a query that names a column of it) */
  private starOf(b: Body): AstNode | null {
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
    while (b.op !== undefined && b.op !== "SETOP_NONE" && b.larg !== undefined) b = b.larg;
    const star = this.starOf(b);
    if (star !== null) return this.outputFields(star);
    const targets = (b.targetList ?? []) as AstNode[];
    const out = targets.map((t) => { const x = this.typed(bodyOf(t).val as AstNode); return x === null ? null : { oid: x.type, typmod: x.typmod }; });
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
    if (k === "ColumnRef") { const t = this.typed(n); return t?.node === "VAR" && t.levelsUp === 0; }
    if (k === "SubLink") return false;
    if (k === "FuncCall" && (bodyOf(n).over !== undefined || this.typed(n)?.node === "AGGREF")) return true;
    const children = Object.values(bodyOf(n)).flatMap((x) => Array.isArray(x) ? x : [x]).filter(isNode);
    return children.every((c) => this.validGrouped(c, groupShapes));
  }

  /** An expression as a program over cells (`cell` makes one), or null where it is not a numeric Postgres's rules
   *  decide here; `kind` int where the value is an integer (integer arithmetic is DuckDB's, one cell). */
  private exactOf(n: AstNode, cell: (n: AstNode, conv?: "exact" | "float8" | "float4" | "text") => NumericProgram): Built | null {
    const k = kindOf(n), b = bodyOf(n);
    const type = this.typeOf(n);
    const asCell = (): Built | null => type !== null && INTEGERS.has(type) ? { p: cell(n), kind: "int" } : type === NUMERIC ? { p: this.padded(n, cell(n)), kind: "numeric" } : null;
    const numeric = (p: NumericProgram): Built => ({ p, kind: "numeric" });
    const sub = (x: unknown): Built | null => isNode(x) ? this.exactOf(x, cell) : null;
    switch (k) {
      // a numeric parameter is its bound text, as Postgres reads it (DuckDB is given it as a double: 15 digits)
      case "ParamRef": return type === NUMERIC ? numeric({ op: "cell", key: `$${b.number}` }) : asCell();
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
          : from !== null && TEXTS.has(from) && from !== UNKNOWN && constString(arg) === null ? numeric(cell(pgCall("text", "a1::numeric", [this.clone(arg)]), "text"))
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
        const onItsRows = (i: number) => (m: AstNode, conv?: "exact" | "float8" | "float4" | "text"): NumericProgram =>
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
            if (!plain || args.length !== 1 || b.agg_star === true || this.typeOf(args[0]!) !== NUMERIC) return asCell();
            const operands: AstNode[] = [];
            const probe = this.exactOf(args[0]!, (m) => { operands.push(m); return { op: "cell", key: String(operands.length - 1) }; });
            // a column's own min is DuckDB's exact decimal, padded to its scale
            if (probe === null || probe.p.op === "cell" || (probe.p.op === "pad" && probe.p.arg.op === "cell") || !worthComputing(probe.p)) return asCell();
            const key = caseWhen([[isNotNull(this.clone(args[0]!)), row([this.clone(args[0]!), ...operands.map((m) => this.clone(m))])]], null);
            const picked = (m: AstNode): AstNode => {
              const call = fn(name === "min" ? "arg_min_null" : "arg_max_null", [this.clone(m), this.clone(key)], b.agg_filter === undefined ? {} : { agg_filter: this.clone(b.agg_filter) });
              // an aggregate, as the grouping checks read it (validGrouped, decidedByKey), typed as the operand it picks
              const t = this.typed(m);
              this.synthetic.set(bodyOf(call), { node: "AGGREF", type: t?.type ?? NUMERIC, typmod: t?.typmod ?? -1, args: [], oid: null, format: null,
                collation: t?.collation ?? 0, inputCollation: 0, levelsUp: null, datum: null, qualifier: null, renamed: null });
              return call;
            };
            const built = this.exactOf(args[0]!, (m, conv) => cell(picked(m), conv));
            return built === null ? asCell() : numeric(built.p);
          }
          default: return asCell();
        }
      }
      default: return asCell();
    }
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
  private summed(agg: Body, x: AstNode, sum: AstNode, cell: (n: AstNode, conv?: "exact" | "float8" | "float4" | "text") => NumericProgram): NumericProgram {
    if (this.displayScale(x) !== null || agg.agg_distinct === true) return this.padded(sum, cell(sum));
    // a text read as an unconstrained numeric (Metabase's every JSON number), an ln or a sqrt: DuckDB holds it as a
    // double, so it is summed as Postgres computes it (`pgNumeric`), in two exact DECIMAL(38,18) parts (a value they cannot hold refused, `numeric-exact-sum`), at the
    // most decimals a row's text has. A sum holding a NaN or an infinity is the double's (NaN, ±Infinity, as Postgres adds
    // them)
    const text = this.pgNumeric(x);
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
    const name = kindOf(n) === "FuncCall" ? lastName(b.funcname) : "";
    const args = (b.args ?? []) as AstNode[];
    if (!["ln", "log", "log10", "exp", "sqrt", "power", "pow"].includes(name) || this.typeOf(n) !== NUMERIC || b.over !== undefined || args.length < 1 || args.length > 2) return null;
    // an argument computed here (a quotient): its exact value, the program DuckDB evaluates row by row
    const read = args.map((a): [string, AstNode] | null => {
      const own = this.typed(a);
      if (own !== null && INTEGERS.has(own.type)) return ["numeric", this.clone(a)];
      const scale = this.displayScale(a);
      if (scale !== null) return [`numeric(1000, ${scale})`, this.clone(a)];
      if (kindOf(a) === "ColumnRef" && own?.type === NUMERIC) return ["numeric", this.clone(a)];
      const exact = this.exactText(a);
      return exact === null ? null : ["numeric", exact];
    });
    if (read.some((x) => x === null)) {
      throw new Unrewritable(`${name}() of a numeric Mason cannot compute exactly is not supported by Mason`, `cast the argument to numeric(p, s): ${name}(x::numeric(20, 4))`, "numeric-math");
    }
    return pgCall("text", `${name}(${read.map((x, i) => `a${i + 1}::${x![0]}`).join(", ")})`, read.map((x) => x![1]));
  }

  /** whether DuckDB holds an expression's value exactly (an integer, or a DECIMAL its types decide): a column, an
   *  expression of declared scales, a sum / min / max of one, a count; a CASE the rewrite made of such arms (an exact
   *  program's arm index, a cell on its arm's rows). Not what DuckDB computes as a double (`^`, a quotient). */
  private duckExact(n: AstNode): boolean {
    const t = this.typed(n), b = bodyOf(n);
    if (t !== null && INTEGERS.has(t.type)) return true;
    if (kindOf(n) === "ColumnRef") return t !== null && t.type === NUMERIC;
    if (this.displayScale(n) !== null) return true;
    const args = (b.args ?? []) as AstNode[];
    // a count (an avg's, made from the avg's node, carries the avg's type)
    if (kindOf(n) === "FuncCall" && lastName(b.funcname) === "count") return true;
    if (kindOf(n) === "FuncCall" && ["sum", "min", "max", "any_value"].includes(lastName(b.funcname)) && args.length === 1) return this.duckExact(args[0]!);
    if (kindOf(n) === "CaseExpr" && t === null) return [...args.map((w) => bodyOf(w).result), ...(b.defresult === undefined ? [] : [b.defresult])].every((r) => isNode(r) && this.duckExact(r));
    return false;
  }

  /** a numeric's exact text, row by row: its program (exactOf) evaluated by DuckDB over its cells' texts
   *  (`__mason_numeric_program`, src/duck/functions.ts); null where there is none, or it reads a parameter */
  private exactText(n: AstNode): AstNode | null {
    const cells: Array<{ node: AstNode; conv: "exact" | "float8" | "float4" | "text" }> = [];
    let built: Built | null;
    try { built = this.exactOf(n, (m, conv = "exact") => { cells.push({ node: m, conv }); return { op: "cell", key: String(cells.length - 1) }; }); }
    catch (e) { if (e === NOT_EXACT) return null; throw e; }
    if (built === null || cellsOfProgram(built.p).some((k) => k.startsWith("$"))) return null;
    if (cells.some((c) => c.conv === "exact" && !this.duckExact(c.node))) return null;
    const texts = cells.map((c) => c.conv === "text" ? this.clone(c.node) : c.conv === "exact" ? cast(this.clone(c.node), ["varchar"])
      : fn("__mason_float_numeric_text", [cast(this.clone(c.node), ["double"]), boolConst(c.conv === "float4")]));
    return fn("__mason_numeric_program", [strConst(JSON.stringify(built.p)), ...texts]);
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
        if (!["sum", "min", "max"].includes(lastName(b.funcname)) || args.length !== 1 || b.agg_star === true || b.agg_within_group === true) return null;
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

  /** the collation a text expression compares under, as DuckDB follows it; null for a type that is no text */
  private textCollation(n: AstNode): DuckCollation | null {
    if (kindOf(n) === "CollateClause") return this.namedCollation(lastName(bodyOf(n).collname));
    const t = this.typed(n);
    if (t === null || !TEXTS.has(t.type)) return null;
    if (BYTE_COLLATIONS.has(t.collation)) return { kind: "bytes" };
    return this.collation;
  }

  private namedCollation(name: string): DuckCollation {
    if (["c", "posix", "ucs_basic", "pg_c_utf8"].includes(name)) return { kind: "bytes" };
    if (name === "default") return this.collation;
    // Postgres's `unicode` is ICU's root locale, `und-x-icu` by another name
    if (name === "unicode") return { kind: "icu", name: "en_us" };
    const icu = /^(.*)-x-icu$/.exec(name);
    if (icu) return { kind: "icu", name: icu[1] === "und" ? "en_us" : icu[1]!.replace(/-/g, "_") };
    throw new Unrewritable(`collation "${name}" is not supported by Mason`, `write COLLATE "C" for byte order, or leave the COLLATE out for the database's`, "collation-unknown");
  }

  /** the keys DuckDB sorts by for one text expression under a collation */
  private sortKeys(e: AstNode, c: DuckCollation): AstNode[] {
    const plain = kindOf(e) === "CollateClause" ? bodyOf(e).arg as AstNode : e;
    switch (c.kind) {
      case "bytes": return [plain];
      case "icu": return [collate(plain, c.name)];
      case "libc": return libcKeys(this.cp, plain, c.icu);
    }
  }

  /** a SortBy: its expression's sort keys under its collation (several under a libc one), each with its direction */
  private sortBy(b: Body, targets: AstNode[] | null, select: Body | null): AstNode[] | null {
    let e = b.node as AstNode;
    if (targets !== null) {
      const out = this.outputOf(e, targets);
      if (out?.twin === true) throw this.twinRefused();
      if (out !== null) e = this.clone(out.value);
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
    // a citext sorts by its lower-cased text under the database's collation (citext_cmp)
    if (this.isCitext(type)) { e = this.foldCitext(e); b.node = e; }
    // a jsonb sorts by its order key (jsonb's own order: src/duck/jsonb-order.ts), its NULLs where the SortBy puts them
    if (type === JSONB) return [{ SortBy: { ...b, node: this.jsonbKey(e) } }];
    this.comparable(e, "ORDER BY");
    const c = this.textCollation(e);
    // a char(n) sorts without its padding (bpcharcmp)
    if (this.typeOf(e) === BPCHAR) { e = fn("rtrim", [e]); this.typedLike.set(bodyOf(e), b.node as AstNode); b.node = e; }
    if (c === null || (c.kind === "bytes" && kindOf(b.node as AstNode) !== "CollateClause")) return null;
    return this.sortKeys(e, c).map((k) => ({ SortBy: { ...b, node: k } }));
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
    const targets = (b.targetList ?? []) as AstNode[];
    const n = constInt(g);
    const out = n === null ? null : this.outputAt(targets, n);
    if (out !== null) return out.value;
    if (kindOf(g) === "ColumnRef") {
      const f = names(bodyOf(g).fields);
      const named = f.length === 1 && this.typed(g) === null ? targets.filter((t) => bodyOf(t).name === f[0]) : [];
      if (named.length === 1) return bodyOf(named[0]!).val as AstNode;
    }
    return g;
  }

  /** a value Mason cannot sort, group or compare as Postgres does: a jsonb where it is not keyed (`compared` keys it),
   *  a jsonb array (each element by jsonb's rules), a text array under the database's collation (each element under
   *  it) — refused, where a statement would need it */
  private comparable(n: AstNode, where: string): void {
    const type = this.typeOf(n);
    if (this.isCitext(type)) throw new Unrewritable(`${where} a citext value is not supported by Mason (Postgres groups and sorts it without regard to case)`, "GROUP BY lower(x), or x::text where case matters", "citext-forms");
    if (type === JSONB) throw new Unrewritable(`${where} a jsonb value is not supported by Mason (Postgres orders and equates jsonb by its own rules)`, JSONB_WAY_OUT, "jsonb-compare");
    if (type === JSONB_ARRAY) throw new Unrewritable(`${where} a jsonb array is not supported by Mason (Postgres compares its elements by jsonb's rules)`, "compare an element (a[1]), or a::text", "jsonb-compare");
    if (this.rowHoldsJsonb(n)) throw new Unrewritable(`${where} a row holding a jsonb is not supported by Mason (Postgres compares the jsonb by its own rules)`, "list its members one by one: GROUP BY a, j", "jsonb-compare");
    if ((type === 1009 || type === 1015) && this.collation.kind !== "bytes") throw new Unrewritable(`${where} a text array is not supported by Mason under the database's collation`, "sort by an element (a[1]) or by array_to_string(a, ',')", "text-array-order");
  }

  /**
   * A JSONB AS ITS ORDER KEY (src/duck/jsonb-order.ts): bytes whose order and equality are Postgres's for jsonb
   * (`compareJsonbContainers`: by type, then size, then member by member; numbers as numerics; strings under the
   * database's collation). Under C the key is one call; under ICU or a libc locale each of the document's strings
   * needs DuckDB's ICU key, which a JavaScript function cannot ask for, so DuckDB makes them over the strings the
   * function lists (`list_transform` with a lambda, src/duck/store.ts `lambda_syntax`) and hands them to the key.
   */
  private jsonbKey(e: AstNode): AstNode {
    return this.keptKey(e) ?? this.jsonbKeyCall(e);
  }

  /** the key computed per row (`jsonbKey`): the functions src/duck/jsonb-order.ts `JSONB_KEY_FUNCTIONS` names */
  private jsonbKeyCall(e: AstNode): AstNode {
    const c = this.collation;
    if (c.kind === "bytes") return fn(JSONB_KEY_FUNCTIONS.bytes.key, [e]);
    const each = (): AstNode => ({ ColumnRef: { fields: [S("__mason_s")] } });
    const f = JSONB_KEY_FUNCTIONS[c.kind];
    const keys = fn("list_transform", [fn(f.strings, [this.clone(e)]), op("->", each(), fn("icu_sort_key", [each(), strConst(icuNameOf(c))]))]);
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
      const raise = markedRaise(MARKED_FUNCTIONS.key, fn("hex", [column()]), markedError(read, this.collation.kind === "libc"));
      return caseWhen([[isNullKey(), nullConst()], [op("=", column(), recompute()), raise]], column());
    }
    return caseWhen([[or([isNull(column()), op("=", column(), recompute())]), computed()]], caseWhen([[isNullKey(), nullConst()]], column()));
  }

  /**
   * A JSONB AS ITS EQUALITY KEY: the key under C, whatever the database's collation. Postgres's default collation is
   * deterministic, so two jsonb strings are equal only when their bytes are (varstr_cmp breaks a collation's tie by
   * strcmp), and the C key's equality is exactly jsonb's — where the collation's key would refuse a value its order
   * does not cover (a libc collation's `libc-uncovered`: an emoji's variation selector, an NFD accent) that equality
   * never needed to order. Every context that only equates (=, <>, IN, = ANY, IS DISTINCT FROM, NULLIF, CASE x WHEN,
   * GROUP BY, DISTINCT [ON], count(DISTINCT), PARTITION BY) reads this one; ORDER BY, <, >, BETWEEN read `jsonbKey`.
   */
  private equalKey(e: AstNode): AstNode {
    // under C and ICU the order's key is an equality key too (a string's collation key, then its bytes), which never
    // refuses, so a stored one serves (keptKey) — both sides of an equality read the order's key; only a libc key
    // refuses a string (libc-uncovered), so under libc equality reads the C key: its own stored column where it is
    // (`EQUAL_STEPS`, src/duck/kept.ts), else computed
    if (this.collation.kind !== "libc") return this.jsonbKey(e);
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
   * an ordinal or an output name by its target's. The value itself is then no group key, so `decidedByKey` reads it
   * through any_value — the group's value, which is one of the texts Postgres's group holds, as Postgres's answer is
   * the one its plan meets first (gap jsonb-equal-text). Anything else Mason cannot group as Postgres does is refused,
   * in a grouping set too.
   */
  private keyedGroups(b: Body): void {
    if (!Array.isArray(b.groupClause)) return;
    const refuseIn = (v: unknown): void => {
      if (Array.isArray(v)) { for (const x of v) refuseIn(x); return; }
      if (!isNode(v)) return;
      if (kindOf(v) === "GroupingSet") refuseIn(bodyOf(v).content);
      else this.comparable(this.groupedExpression(v, b), "GROUP BY a grouping set of");
    };
    b.groupClause = (b.groupClause as AstNode[]).map((g) => {
      if (!isNode(g)) return g;
      if (kindOf(g) === "GroupingSet") { refuseIn(bodyOf(g).content); return g; }
      const e = this.groupedExpression(g, b);
      if (this.typeOf(e) !== JSONB) { this.comparable(e, "GROUP BY"); return g; }
      return this.equalKey(e === g ? g : this.clone(e));
    });
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
      b.distinctClause = (b.distinctClause as AstNode[]).map((d) => {
        const n = constInt(d);
        const out = n === null ? null : this.outputAt(targets, n);
        const e = out?.value ?? d;
        if (this.typeOf(e) !== JSONB) { this.comparable(e, "SELECT DISTINCT ON"); return d; }
        return this.equalKey(out !== null ? this.clone(e) : d);
      });
      return;
    }
    for (const v of values) if (this.starHoldsJsonb(v)) throw new Unrewritable("SELECT DISTINCT * over a jsonb column is not supported by Mason (Postgres equates jsonb by its own rules)", "name the columns: SELECT DISTINCT a, b, …", "jsonb-compare");
    if (!values.some((v) => this.typeOf(v) === JSONB)) return;
    b.distinctClause = values.map((v) => this.equated(this.clone(v), "SELECT DISTINCT"));
  }

  private collateClause(b: Body): AstNode | null {
    // an expression's own COLLATE outside a sort: a comparison's is handled at the comparison; C needs nothing
    const c = this.namedCollation(lastName(b.collname));
    if (c.kind === "bytes") return b.arg as AstNode;
    if (c.kind === "icu") { b.collname = [S(c.name)]; return null; }
    return null;
  }

  /** a text comparison under the collation: `a < b` compares their keys */
  private compareText(name: string, l: AstNode, r: AstNode, c: DuckCollation): AstNode {
    if (c.kind === "icu") return op(name, collate(strip(l), c.name), collate(strip(r), c.name));
    if (c.kind === "libc") return op(name, libcKey(this.cp, strip(l), c.icu), libcKey(this.cp, strip(r), c.icu));
    return op(name, l, r);
  }

  private minMax(b: Body): AstNode | null {
    // GREATEST / LEAST of text compare under the collation
    const t = this.at(b, ["MINMAXEXPR"]);
    if (t !== null && (t.type === JSONB || t.type === JSONB_ARRAY)) {
      throw new Unrewritable(`${b.op === "IS_LEAST" ? "LEAST" : "GREATEST"} of jsonb values is not supported by Mason (Postgres orders jsonb by its own rules)`, "ORDER BY the value … LIMIT 1 in a subquery", "jsonb-compare");
    }
    if (t !== null) b.args = (b.args as AstNode[]).map((a, i) => this.widen(a, t.args[i]?.type));
    if (t === null || !TEXTS.has(t.type) || BYTE_COLLATIONS.has(t.inputCollation) || this.collation.kind === "bytes") return null;
    if (this.collation.kind === "libc") {
      // the greatest (least) of the values' keys, which end in the value's own bytes: the value is read back from them
      const icu = this.collation.icu;
      const keys = (b.args as AstNode[]).map((a) => libcKey(this.cp, strip(a), icu));
      const best: AstNode = { MinMaxExpr: { ...b, args: keys } };
      this.done.add(bodyOf(best));
      return fn("decode", [fn("unhex", [fn("regexp_extract", [best, strConst("[^ ]*$")])])]);
    }
    const name = this.collation.name;
    b.args = (b.args as AstNode[]).map((a) => collate(a, name));
    return null;
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
        const c = this.textCollation(l!);
        // char(n): compared without the padding
        const trim = (x: AstNode): AstNode => this.typeOf(x) === BPCHAR ? fn("rtrim", [x]) : x;
        if (c === null || c.kind === "bytes") {
          if (own.includes(BPCHAR)) { b.lexpr = trim(l!); bodyOf(r!).items = bounds.map(trim); }
          return null;
        }
        const inside = and([this.compareText(">=", trim(l!), trim(bounds[0]!), c), this.compareText("<=", trim(this.clone(l!)), trim(bounds[1]!), c)]);
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
          b.lexpr = fn("rtrim", [l]);
          bodyOf(r).items = ((bodyOf(r).items ?? []) as AstNode[]).map((x) => fn("rtrim", [x]));
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
    if (l !== undefined) b.lexpr = this.widen(l, a0);
    if (r !== undefined) b.rexpr = this.widen(r, l === undefined ? a0 : a1);
    // char(n) beside char(n): compared without the padding (bpchareq, bpcharlt …)
    if (a0 === BPCHAR && a1 === BPCHAR && ["=", "<>", "!=", "<", "<=", ">", ">="].includes(name) && l !== undefined && r !== undefined) {
      b.lexpr = fn("rtrim", [l]); b.rexpr = fn("rtrim", [r]);
      this.typedLike.set(bodyOf(b.lexpr as AstNode), l); this.typedLike.set(bodyOf(b.rexpr as AstNode), r);
    }
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
        const wide = (x: AstNode): AstNode => { const m = this.typed(x)?.typmod ?? -1; return m >= 4 && this.typeOf(x) === NUMERIC ? cast(x, ["decimal", "38", String((m - 4) & 0xffff)]) : x; };
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
        const either = name.startsWith("#"), canonical = a0 === JSONB, asText = name.endsWith(">>");
        let steps = either ? jsonPath(r!) : jsonSteps([r!], a1 !== null && INTEGERS.has(a1)), base = l!;
        // `(c -> 'a') ->> 'b'` is one read at the steps a, b (jsonChain)
        const chain = this.jsonChain(l!, either), literal = constString(steps);
        if (chain !== null && literal !== null) { base = chain.base; steps = strConst(JSON.stringify([...chain.steps, ...JSON.parse(literal) as unknown[]])); }
        // a stored column of the path where every row holds it (keptRead), else DuckDB's own read where it is
        // Postgres's, else the function (jsonGet)
        return this.jsonRead(base, steps, either, canonical, asText);
      }
      case "@>": case "<@":
        if (a0 !== null && JSONS.has(a0)) return name === "@>" ? fn("__mason_jsonb_contains", [jsonArg(l!), jsonArg(r!)]) : fn("__mason_jsonb_contains", [jsonArg(r!), jsonArg(l!)]);
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
        // the operands as rewritten so far (a citext lower-cased to text sorts under the collation)
        const c = this.textCollation(b.lexpr as AstNode) ?? this.textCollation(b.rexpr as AstNode);
        if (c === null || c.kind === "bytes" || (t !== null && BYTE_COLLATIONS.has(t.inputCollation))) return null;
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
    if (w !== undefined && Array.isArray(w.partitionClause)) w.partitionClause = (w.partitionClause as AstNode[]).map((p) => isNode(p) ? this.equated(p, "PARTITION BY") : p);
  }

  private funcCall(b: Body): AstNode | AstNode[] | null {
    const name = lastName(b.funcname);
    this.keyedPartition(b.over as Body | undefined);
    const t = this.typed({ FuncCall: b });
    const args = (b.args ?? []) as AstNode[];
    const argType = (i: number): number | null => t?.args[i]?.type ?? (args[i] !== undefined ? this.typeOf(args[i]!) : null);
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
    if ((name === "sum" || name === "avg") && argType(0) === INTERVAL) throw new Unrewritable(`${name}() of an interval is not supported by Mason`, "sum(extract(epoch FROM x)) for the seconds", "interval-aggregates");
    if (name === "sum" && this.typeOf(args[0] ?? { A_Const: {} }) === FLOAT4 && argType(0) === FLOAT4) throw new Unrewritable("sum() of a real is not supported by Mason (Postgres adds in single precision)", "sum(x::double precision)", "sum-real");
    // count(DISTINCT x) of a column unique on the source, over a FROM that repeats none of its table's rows: no value is
    // there twice, so it is count(x), its FILTER kept (src/duck/distinct-key.ts, `keyCounts`)
    if (b.agg_distinct === true && name === "count" && typeof b.location === "number" && this.keyCounts.has(b.location)) delete b.agg_distinct;
    // count(DISTINCT j) counts jsonb's equal values once: their keys, counted (another aggregate's DISTINCT would hand
    // the key itself to the aggregate)
    if (b.agg_distinct === true && args[0] !== undefined && name === "count" && args.length === 1 && this.typeOf(args[0]) === JSONB) args[0] = this.equalKey(args[0]);
    else if (b.agg_distinct === true && args[0] !== undefined) this.comparable(args[0], `${name}(DISTINCT …) of`);
    // a jsonb array searched for an element: jsonb's equality, where DuckDB's list functions compare the text
    if (["array_position", "array_positions", "array_remove", "array_replace"].includes(name) && args[0] !== undefined && this.typeOf(args[0]) === JSONB_ARRAY) {
      throw new Unrewritable(`${name}() of a jsonb array is not supported by Mason (Postgres compares its elements by jsonb's equality)`, "compare an element: a[1] = '…'::jsonb", "jsonb-compare");
    }
    // a function-style cast (`date(x)`, `text(x)`, `numeric(x)`) is the cast
    if (t !== null && (t.node === "COERCEVIAIO" || t.node === "RELABELTYPE" || (t.node === "FUNCEXPR" && t.format !== null && t.format !== 0 && t.format !== 3)) && args.length === 1) {
      if (t.type === TEXT || t.type === VARCHAR) { const text = this.pgText(args[0]!, this.typeOf(args[0]!), true); if (text !== null) return text; }
      const type = duckTypeOf(t.type, t.typmod);
      if (type !== null && !(t.type === NUMERIC && t.typmod < 0)) return cast(args[0]!, type);
    }
    // an aggregate over DISTINCT values sorts them to find the duplicates, so Postgres's string_agg / array_agg (DISTINCT)
    // lists them in that order (the argument's, under its collation); DuckDB's in any order
    if (b.agg_distinct === true && b.agg_order === undefined && args[0] !== undefined && ["string_agg", "array_agg", "json_agg", "jsonb_agg"].includes(name)) {
      b.agg_order = [{ SortBy: { node: this.clone(args[0]), sortby_dir: "SORTBY_DEFAULT", sortby_nulls: "SORTBY_NULLS_DEFAULT" } }];
      this.original.add(bodyOf((b.agg_order as AstNode[])[0]!));
    }
    if (b.agg_within_group === true) return this.withinGroup(name, b);
    switch (name) {
      case "every": b.funcname = [S("bool_and")]; return null;
      case "upper": case "lower": {
        if (args.length !== 1 || argType(0) === null || !TEXTS.has(argType(0)!)) return null;
        // glibc's upper keeps ß (DuckDB's gives ẞ); its every other letter is DuckDB's (an exhaustive comparison over
        // every code point differed only in letters newer than the server's glibc)
        if (this.caseMode === "libc") return name === "lower" ? null : fn("replace", [fn("upper", [fn("replace", [args[0]!, strConst("ß"), strConst("\ufdd0")])]), strConst("\ufdd0"), strConst("ß")]);
        return fn("__mason_case", [args[0]!, boolConst(name === "upper"), strConst(this.caseMode)]);
      }
      case "initcap": return args.length === 1 ? fn("__mason_initcap", [args[0]!, strConst(this.caseMode)]) : null;
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
        if (args.length === 2 && own.every((x) => x !== null && INTEGERS.has(x))) return cast(op("//", args[0]!, nonZero(this.cp, args[1]!)), ["decimal", "38", "0"]);
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
        // VARIADIC <array>: the array's elements are the path (a literal as array_in reads it)
        const literal = b.func_variadic === true && args.length === 2 ? constString(args[1]) : null;
        const steps = b.func_variadic !== true ? jsonSteps(args.slice(1), false)
          : literal !== null ? strConst(JSON.stringify(arrayLiteral(literal)))
          : cast(fn("to_json", [arrayCast(args[1]!, "varchar")]), ["varchar"]);
        const canonical = own === JSONB || name.startsWith("jsonb");
        return this.jsonRead(args[0]!, steps, true, canonical, name.endsWith("_text"));
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
    if (arg === undefined) return null;
    const c = this.textCollation(arg);
    if (c === null || c.kind === "bytes") return null;
    if (c.kind === "icu") { b.args = [collate(strip(arg), c.name)]; return null; }
    // libc: the value whose key is least (or greatest); a NULL value has no key and is skipped, as min skips it
    // (the value in three places, each its own copy: the walker rewrites a node in its first place alone)
    const key = caseWhen([[not(isNull(this.cp(strip(arg)))), row(libcKeys(this.cp, this.cp(strip(arg)), c.icu))]], null);
    return { FuncCall: { ...b, funcname: [S(name === "min" ? "arg_min" : "arg_max")], args: [strip(arg), key] } };
  }

  /** WITHIN GROUP: mode() picks the most frequent value and, of equals, the first in the ORDER BY's order — DuckDB's
   *  mode over the values in that order picks the same (its tie goes to the first it saw); percentile_disc / _cont
   *  take a position in the order, which DuckDB computes by bytes: refused for text under a libc collation */
  private withinGroup(name: string, b: Body): AstNode | null {
    const order = (b.agg_order ?? []) as AstNode[];
    const key = order[0] !== undefined ? bodyOf(order[0]).node as AstNode : undefined;
    // a jsonb's position in its order, or its most frequent value: DuckDB would pick by its text
    if (key !== undefined && (this.typeOf(key) === JSONB || this.typeOf(key) === JSONB_ARRAY)) {
      throw new Unrewritable(`${name}() WITHIN GROUP (ORDER BY a jsonb) is not supported by Mason (Postgres orders jsonb by its own rules)`, "ORDER BY the value … LIMIT 1 OFFSET n in a subquery", "jsonb-compare");
    }
    const c = key === undefined ? null : this.textCollation(key);
    if (c === null || c.kind === "bytes") return null;
    if (name === "mode" && order.length === 1) {
      return { FuncCall: { ...b, args: [this.clone(key!)], agg_within_group: undefined } };
    }
    if (c.kind === "libc") throw new Unrewritable(`${name}() WITHIN GROUP (ORDER BY text) under the database's libc collation is not supported by Mason`, "order by a number, or take the value with ORDER BY … LIMIT in a subquery", "percentile-text-libc");
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
    if (ARRAYS.has(type)) return fn("__mason_array_text", [arrayCast(n, "varchar"), boolConst(type === 1000)]);
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
    if (type === INTERVAL) return cast(fn("__mason_interval_part", [strConst(field), x]), ["decimal", "38", INTERVAL_SCALE[field] ?? "0"]);
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
        return type === DATE ? cast(fn("epoch", [x]), ["decimal", "38", "0"]) : micros(fn("epoch_us", [x]), "0.000001");
      case "second": return micros(fn("microsecond", [x]), "0.000001");
      case "milliseconds": return micros(fn("microsecond", [x]), "0.001");
      case "microseconds": return cast(fn("microsecond", [x]), ["decimal", "38", "0"]);
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
      const typmods = (b.typeName?.typmods ?? []) as AstNode[];
      if (typmods.length > 0) {
        const p = constInt(typmods[0]), s = typmods.length > 1 ? constInt(typmods[1]) : 0;
        if (p !== null && p > 38) return cast(arg, ["double"]);
        if (p !== null) return cast(arg, ["decimal", String(p), String(s ?? 0)]);
        return null;
      }
      // an unconstrained numeric keeps the value's digits: an integer is a whole decimal, a literal text is read as a
      // decimal literal (BEFORE a numeric: Postgres types `'1.5'` as the cast's numeric, and as it stood DuckDB answered
      // the text, `2.5e2` for 250), a numeric stays what it is
      if (from !== null && INTEGERS.has(from)) return cast(arg, ["decimal", "38", "0"]);
      // as numeric_in reads it (`1_000`, `0x1F`, `1.5e3`: one reader, src/lib/pg-numeric.ts); NaN and Infinity are no
      // DuckDB decimal and keep the double below
      const s = constString(arg);
      const literal = s === null ? null : numericLiteral(s);
      if (literal !== null) return decimalConst(literal);
      if (from === NUMERIC) return arg;
      return cast(arg, ["double"]);
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
      if (t === null || t.type === NUMERIC) return decimalConst(positional(String(b.fval.fval)));
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
    // a parameter is bound as its text; Postgres decided its type, and DuckDB is told it
    const oid = this.params[Number(b.number) - 1];
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
    const own = constString(either ? jsonPath(r) : jsonSteps([r], a1 !== null && INTEGERS.has(a1)));
    if (own === null) return null;
    const deeper = this.jsonChain(b.lexpr as AstNode, either);
    return { base: deeper === null ? b.lexpr as AstNode : deeper.base, steps: [...(deeper === null ? [] : deeper.steps), ...JSON.parse(own) as unknown[]] };
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
      const c = this.textCollation(e);
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
type Output = { target: number; name: string; value: AstNode; star: boolean; twin: boolean };
const hasStar = (v: unknown): boolean => isNode(v) && kindOf(v) === "ColumnRef" && (bodyOf(v).fields as AstNode[]).some((f) => kindOf(f) === "A_Star");

/** whether a program does what DuckDB would compute otherwise: a division, a rounding, a scale chosen per value; a
 *  sum, a difference or a product of DuckDB's decimals is DuckDB's own right answer */
function worthComputing(p: NumericProgram): boolean {
  switch (p.op) {
    // a parameter's cell is its text: DuckDB computes with it as a double
    case "cell": return p.key.startsWith("$");
    case "literal": return false;
    // DuckDB's decimals may be fewer than Postgres's (src/duck/sync.ts copies a numeric(65,30) at its values' scale)
    case "pad": return true;
    case "add": case "sub": case "mul": return worthComputing(p.args[0]) || worthComputing(p.args[1]);
    case "neg": case "abs": return worthComputing(p.arg);
    default: return true;
  }
}

/** the program with each cell's key moved by `by` (the cells of the columns before it) */
function offsetCells(p: NumericProgram, by: number): NumericProgram {
  switch (p.op) {
    case "cell": return p.key.startsWith("$") ? p : { op: "cell", key: String(Number(p.key) + by) };
    case "literal": return p;
    case "add": case "sub": case "mul": case "div": case "mod": return { op: p.op, args: [offsetCells(p.args[0], by), offsetCells(p.args[1], by)] };
    case "neg": case "abs": case "floor": case "ceil": return { op: p.op, arg: offsetCells(p.arg, by) };
    case "round": case "trunc": case "pad": return { op: p.op, arg: offsetCells(p.arg, by), scale: p.scale };
    case "typmod": return { op: "typmod", arg: offsetCells(p.arg, by), precision: p.precision, scale: p.scale };
    case "greatest": case "least": case "coalesce": return { op: p.op, args: p.args.map((x) => offsetCells(x, by)) };
    case "stddev": return { ...p, args: [offsetCells(p.args[0], by), offsetCells(p.args[1], by), offsetCells(p.args[2], by)] };
    case "pick": return { op: "pick", index: offsetCells(p.index, by), args: p.args.map((x) => offsetCells(x, by)) };
    case "rescale": return { op: "rescale", arg: offsetCells(p.arg, by), scale: offsetCells(p.scale, by) };
  }
}

/** an expression's shape: its tree without offsets */
const shapeOf = (n: AstNode): string => JSON.stringify(n, (k, v: unknown) => k === "location" ? undefined : v);

const strip = (n: AstNode): AstNode => kindOf(n) === "CollateClause" ? bodyOf(n).arg as AstNode : n;

/** glibc's order, as the source was MEASURED to order text (src/duck/libc-order.ts: its levels as one text, ICU's
 *  accent and case levels over the characters of the first), then the bytes, as Postgres breaks a tie */
function libcKeys(copy: Copy, e: AstNode, icu: string): AstNode[] {
  return [fn("__mason_libc_key", [copy(e), fn("icu_sort_key", [fn("__mason_libc_kept", [copy(e)]), strConst(icu)])]), e];
}

/** the libc keys as ONE text that orders as they do: the key, a space (below every hex digit, so a shorter key
 *  orders first), the value's own bytes in hex */
function libcKey(copy: Copy, e: AstNode, icu: string): AstNode {
  const [key, bytes] = libcKeys(copy, e, icu) as [AstNode, AstNode];
  return concat(key, strConst(" "), fn("hex", [bytes]));
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
 * `->` (the json itself) stays the function's: a string's quoting and escapes are rewritten by DuckDB's writer.
 * tests/duck-wire.test.ts "a ->> of a column is DuckDB's own read" holds the answers and counts the hops.
 */
function jsonGet(copy: Copy, j: AstNode, steps: AstNode, either: boolean, canonical: boolean, asText: boolean, keysOnce: boolean): AstNode {
  const call = fn("__mason_json_get", [jsonArg(copy(j)), steps, boolConst(either), boolConst(canonical), boolConst(asText)]);
  if (!asText || kindOf(j) !== "ColumnRef") return call;
  const literal = constString(steps);
  if (literal === null) return call;
  const keys: string[] = [];
  for (const s of JSON.parse(literal) as unknown[]) {
    // a `->` step that is an integer is an index; a `#>` element that reads as one is an index on an array, as the
    // function reads it (pathIndex: `+1` and ` 1` are, `1 ` is a key)
    if (typeof s !== "string" || (either && pathIndex(s) !== null) || /[\u0000-\u001f]/.test(s)) return call;
    keys.push(s);
  }
  if (keys.length === 0) return call;
  const pointer = (ks: string[]): string => ks.map((k) => "/" + k.replaceAll("~", "~0").replaceAll("/", "~1")).join("");
  let path: string;
  if (keys.some((k) => /^\d+$/.test(k))) {
    if (keys.some((k) => k === "" || k === "*")) return call;
    path = "$" + keys.map((k) => `."${k.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join("");
  } else path = pointer(keys);
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
 *  would read back as an INTEGER — integer arithmetic, an overflow where Postgres's numeric has none — so it is cast,
 *  as an integer cast to numeric is, to DECIMAL(38, 0) (DuckDB keeps a product of two 18-digit decimals in 64 bits and
 *  fails past it). Past DuckDB's 38 digits it stays as written: DuckDB's double, as before */
function decimalConst(text: string): AstNode {
  if (text.includes(".") || text.replace(/^-/, "").length > 38) return numConst(text);
  const n = Number(text);
  return cast(Number.isSafeInteger(n) && n >= -2147483648 && n <= 2147483647 ? intConst(n) : numConst(text), ["decimal", "38", "0"]);
}

/** a text cast to an integer, as strict as Postgres's: whitespace around an optional sign and digits, nothing else */
/** the jsonpath functions' arguments: the target, the path, the variables, `silent` */
const JSONPATH_ARGS = ["jsonb", "jsonpath", "jsonb", "boolean"];

/** Postgres's own answer for each row (src/duck/pg-eval.ts): `template` over a1…an, each argument's text, under the
 *  zone DuckDB's session has */
function pgCall(kind: PgKind, template: string, args: AstNode[]): AstNode {
  return fn(`__mason_pg_${kind}`, [fn("current_setting", [strConst("TimeZone")]), strConst(template), ...args.map((a) => cast(a, ["varchar"]))]);
}

/** a json argument: a text literal is read as JSON (DuckDB's json functions over a VARCHAR literal parse it anyway) */
const jsonArg = (n: AstNode): AstNode => n;

/** `#>` / `#>>`'s path (a text array: a literal `'{a,b,1}'` or an expression) as the JSON array of its elements */
function jsonPath(r: AstNode): AstNode {
  const s = constString(r);
  if (s === null) return cast(fn("to_json", [r]), ["varchar"]);
  const elements = arrayLiteral(s);
  if (elements.some((e) => e === null)) return nullConst();
  return strConst(JSON.stringify(elements));
}

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
  collation: DuckCollation;
  userTypes?: ReadonlyMap<number, string>;
  rowTypes?: ReadonlyMap<number, readonly RowColumn[]>;
  timeZone?: string;
  enums?: EnumTypes;
  kept?: KeptLookup | null;
  wireBound?: boolean;
  keyCounts?: ReadonlySet<number>;
}

export function rewrite({ stmt, base, analysis, collation, userTypes = new Map(), rowTypes = new Map(), timeZone = "UTC", enums = { labels: new Map(), arrays: new Map() }, kept = null,
  wireBound = false, keyCounts = new Set() }: RewriteOptions):
  { tree: AstNode; dropLast: boolean; exact: ExactColumn[]; clock: { parse?: number; exec?: number }; jsonReads: JsonRead[]; unboundedLateral: boolean } {
  const r = new Rewriter(analysis, base, collation, userTypes, rowTypes, timeZone, enums, kept, keyCounts);
  if (joinsUsing(analysis.tree, new Set([JSONB, JSONB_ARRAY]))) {
    throw new Unrewritable("a JOIN … USING or a NATURAL JOIN on a jsonb column is not supported by Mason (Postgres equates jsonb by its own rules)", "JOIN … ON a.j = b.j", "jsonb-compare");
  }
  const own = JSON.parse(JSON.stringify(stmt)) as AstNode;
  volatileWindows(own);
  r.adopt(own);
  nameTargets(own);
  r.indexShapes(own);
  r.repeatedKeyCounts(own);
  const exact = r.exactThrough(own, analysis.fields);
  r.markBounds(own, wireBound);
  r.markWholeReads(own);
  const tree = guardFilters(flattenBool(r.walk(own))) as AstNode;
  return { tree, dropLast: r.excludeRank, exact, clock: r.clock, jsonReads: [...r.jsonReads.values()], unboundedLateral: r.unboundedLateral };
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
