import type { TreeValue } from "./pgtree.ts";

/**
 * A CONSTANT SORT KEY (the class, issue 134: a fact derived in several places, whether a sort key is constant). A
 * constant orders no row, and written into the engine's sort as a bare literal it is an ordinal (an integer) or refused
 * (42804, a non-integer literal). Five findings on PR 170 were each a spelling a syntactic matcher took or missed
 * (`1.5::numeric`, a Const to Postgres, written as the bare 1.5), so it is decided from Postgres's ANALYSIS, here alone:
 * an expression is constant where the analysis put a Const (under a COLLATE, which changes no value). The analysis has
 * folded a cast of an untyped literal and a cast to the type the value has (`'x'::text`, `NULL::int`, `1.5::numeric`)
 * and checked them; anything else is a node Postgres evaluates (`1::bigint`, `2147483648::int`, `12345::numeric(3)`,
 * `'abc'::text::int`, `1 / 0`, `$1`), at planning where it may raise, so it is a key the engine evaluates too.
 *
 * Read by `typesByLocation` (src/duck/pgtree.ts: `Typed.constant`, what src/duck/rewrite.ts drops a SELECT's key by,
 * resolved through its output's name or number) and by src/duck/late.ts (a derived table's column, folded into the
 * query around it).
 */
export function constantExpression(v: TreeValue | undefined): boolean {
  if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) return false;
  return v._node === "CONST" || (v._node === "COLLATEEXPR" && constantExpression(v.arg));
}

/**
 * A KEY WRITTEN AS A BARE LITERAL that the analysis did not call constant (a rewrite that wrote a value it computed):
 * the engine would read it as an ordinal or refuse it, so it is written as an expression the engine evaluates, which
 * orders nothing, as the value does in Postgres. A literal cannot raise, and its text never fails a cast.
 */
export function evaluated<T>(n: T): T {
  const kind = typeof n === "object" && n !== null && !Array.isArray(n) ? Object.keys(n)[0] : undefined;
  return kind === "A_Const"
    ? { TypeCast: { arg: n, typeName: { names: [{ String: { sval: "varchar" } }], typemod: -1 } } } as T
    : n;
}
