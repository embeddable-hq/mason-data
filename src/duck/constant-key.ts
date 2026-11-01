/**
 * A SORT KEY WRITTEN AS A BARE LITERAL (the class, issue 134): a constant orders no row, and written into the engine's
 * sort it is an ordinal (an integer) or refused (42804, a non-integer literal). This is its ONE definition, read where a
 * SELECT's keys are written (src/duck/rewrite.ts) and where a derived table is folded into the statement around it
 * (src/duck/late.ts): a literal, or ONE cast of one (`'x'::text`), under an optional COLLATE. A chain of casts is left as
 * written: `'abc'::text::int` raises its own error when it runs, as Postgres's does, and is never dropped.
 */
export function constantKey(n: unknown): boolean {
  const kind = (x: unknown): string | null =>
    typeof x === "object" && x !== null && !Array.isArray(x) ? Object.keys(x)[0] ?? null : null;
  const arg = (x: unknown): unknown => ((x as Record<string, Record<string, unknown>>)[kind(x)!]!).arg;
  const literal = (x: unknown): boolean => kind(x) === "A_Const" || (kind(x) === "TypeCast" && kind(arg(x)) === "A_Const");
  return literal(n) || (kind(n) === "CollateClause" && literal(arg(n)));
}
