/**
 * A TABLESAMPLE ANYWHERE IN A STATEMENT IS REFUSED BY NAME (issue 982): a sample is of the source's pages or rows, which
 * the synced table does not hold, and DuckDB's own TABLESAMPLE reads `SYSTEM (100)` as 100 rows. Postgres's analysis is
 * the one reader (its TABLESAMPLECLAUSE, wherever the statement reads a table: a subquery, a CTE, a join, a view's
 * expansion), never a list of places, so no spelling passes it. src/duck/plan.ts asks it after the role's refusals and
 * before the rewrite and the allowlist.
 *
 * A percent or seed Postgres rejects as the sample starts (past 100, NaN, NULL) is Postgres's own error, worked out HERE
 * from the literal alone (`sampleLiteral`), never by running anything. It is an allow-list: a literal, or a cast of one to
 * float4, float8 or numeric. Anything else (an operator, a function, a parameter, a column, a subquery) gets the gap,
 * unevaluated. Nothing of a statement may run in the catalog Postgres, which is one connection every session shares,
 * run as its superuser: a sample's arguments run there once set a parameter for every session, read the server's files
 * and left large objects and locks behind (the review of PR 1092).
 */
import type { Node } from "libpg-query";
import type { TreeValue } from "./pgtree.ts";
import { gapRefusal, StatementError } from "./statement.ts";

/** Postgres's two built-in methods: bernoulli (3313) and system (3314), by their handlers' OIDs */
const METHODS = new Set(["3313", "3314"]);
/** a float4 never holds more than this: a literal past it is Postgres's 22003, which is not worked out here */
const FLOAT4_MAX = 3.4028234663852886e38;
/** a number as float4in, float8in and numeric_in all read it (no `_`, no hex: such a literal gets the gap) */
const FLOAT_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
/** Postgres's white space around a number's text (`isspace`) */
const PG_SPACE = /^[ \t\n\r\v\f]+|[ \t\n\r\v\f]+$/g;

/** The refusal of a statement that samples a table, or Postgres's own error for its literal arguments; null for none. */
export function sampleRefusal(tree: TreeValue, stmt: Node, text: string): StatementError | null {
  const handlers: string[] = [];
  const analysed = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { v.forEach(analysed); return; }
    if (v === null || v === undefined || typeof v !== "object") return;
    if (v._node === "TABLESAMPLECLAUSE") handlers.push(String(v.tsmhandler));
    for (const [k, x] of Object.entries(v)) if (k !== "_node") analysed(x);
  };
  analysed(tree);
  if (handlers.length === 0) return null;
  const refusal = gapRefusal("tablesample", "Mason cannot answer TABLESAMPLE: the synced table has none of the source's pages, so its sample would not be Postgres's",
    "read the whole table, or a part of it by a filter (WHERE id % 10 = 0)", text);
  const samples: Array<Record<string, unknown>> = [];
  const written = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(written); return; }
    if (typeof v !== "object" || v === null) return;
    const s = (v as { RangeTableSample?: Record<string, unknown> }).RangeTableSample;
    if (s !== undefined) samples.push(s);
    Object.values(v).forEach(written);
  };
  written(stmt);
  // each sample of the analysis met in the text, of a built-in method: else the gap, nothing worked out
  if (samples.length !== handlers.length || handlers.some((h) => !METHODS.has(h))) return refusal;
  const errors = new Set<string>();
  for (const s of samples) {
    const args = Array.isArray(s.args) ? s.args : [];
    if (args.length !== 1) return refusal;
    const percent = sampleLiteral(args[0], "float4");
    const seed = s.repeatable === undefined ? 0 : sampleLiteral(s.repeatable, "float8");
    if (percent === undefined || seed === undefined) return refusal;
    // in Postgres's order (tablesample_init): each argument's NULL, the seed's NULL, then the method's check of the percent
    if (percent === null) errors.add("2202H TABLESAMPLE parameter cannot be null");
    else if (seed === null) errors.add("2202G TABLESAMPLE REPEATABLE parameter cannot be null");
    else if (Number.isNaN(percent) || percent < 0 || percent > 100) errors.add("2202H sample percentage must be between 0 and 100");
  }
  // none: the gap. Two samples that would raise apart raise whichever Postgres starts first, which only its plan says
  if (errors.size !== 1) return refusal;
  const error = [...errors][0]!;
  return new StatementError({ code: error.slice(0, 5), message: error.slice(6) }, text);
}

/**
 * What a sample's argument is, from its literal alone, as Postgres reads it into a percent's float4 or a seed's float8:
 * a number, null for NULL, or undefined for anything that is not a literal or a cast of one to float4, float8 or
 * numeric, or that is not read here exactly as Postgres reads it (then the caller refuses by name).
 */
export function sampleLiteral(node: unknown, into: "float4" | "float8"): number | null | undefined {
  type Raw = { A_Const?: Record<string, unknown>; TypeCast?: { arg?: unknown; typeName?: { names?: Array<{ String?: { sval?: string } }>; typmods?: unknown; arrayBounds?: unknown } } };
  let n = (node ?? {}) as Raw;
  if (n.TypeCast !== undefined) {
    const t = n.TypeCast.typeName;
    const names = (t?.names ?? []).map((x) => x.String?.sval);
    const type = names.length === 1 ? names[0] : names.length === 2 && names[0] === "pg_catalog" ? names[1] : undefined;
    if (t?.typmods !== undefined || t?.arrayBounds !== undefined || (type !== "float4" && type !== "float8" && type !== "numeric")) return undefined;
    n = (n.TypeCast.arg ?? {}) as Raw;
    if (n.TypeCast !== undefined) return undefined;
  }
  const c = n.A_Const;
  if (c === undefined) return undefined;
  if (c.isnull === true) return null;
  let v: number;
  // (libpg-query's JSON leaves out a field at its default: an ival of 0 is `{}`)
  if ("ival" in c) v = Number((c.ival as { ival?: number }).ival ?? 0);
  else if ("fval" in c) {
    const f = (c.fval as { fval?: string }).fval ?? "";
    if (!FLOAT_TEXT.test(f)) return undefined;
    v = Number(f);
  } else if ("sval" in c) {
    const t = ((c.sval as { sval?: string }).sval ?? "").replace(PG_SPACE, "");
    if (/^nan$/i.test(t)) return Number.NaN;
    if (/^\+?inf(inity)?$/i.test(t)) return Number.POSITIVE_INFINITY;
    if (/^-inf(inity)?$/i.test(t)) return Number.NEGATIVE_INFINITY;
    if (!FLOAT_TEXT.test(t)) return undefined;
    v = Number(t);
  } else return undefined;
  if (!Number.isFinite(v) || (into === "float4" && Math.abs(v) > FLOAT4_MAX)) return undefined;
  return into === "float4" ? Math.fround(v) : v;
}
