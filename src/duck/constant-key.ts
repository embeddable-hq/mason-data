/**
 * A SORT KEY WRITTEN AS A BARE LITERAL (the class, issue 134): a constant orders no row, and written into the engine's
 * sort it is an ordinal (an integer) or refused (42804, a non-integer literal). This is its ONE definition, read where a
 * SELECT's keys are written (src/duck/rewrite.ts) and where a derived table is folded into the statement around it
 * (src/duck/late.ts): a literal, or ONE cast of a string literal or a NULL (`'x'::text`, `NULL::int`), under an optional
 * COLLATE: the casts Postgres's analysis folds, so a bad one was refused there, before Mason drops it. A cast of a typed
 * literal (`2147483648::int`, `12345::numeric(3)`) Postgres evaluates at planning, where it can raise (22003); a chain
 * of casts (`'abc'::text::int`) when it runs: each is left as written, to raise as Postgres's does.
 */
export function constantKey(n: unknown): boolean {
  const kind = (x: unknown): string | null =>
    typeof x === "object" && x !== null && !Array.isArray(x) ? Object.keys(x)[0] ?? null : null;
  const arg = (x: unknown): unknown => ((x as Record<string, Record<string, unknown>>)[kind(x)!]!).arg;
  const folded = (x: unknown): boolean => {
    if (kind(x) !== "A_Const") return false;
    const c = (x as Record<string, Record<string, unknown>>).A_Const!;
    return c.isnull === true || c.sval !== undefined;
  };
  const literal = (x: unknown): boolean => kind(x) === "A_Const" || (kind(x) === "TypeCast" && folded(arg(x)));
  return literal(n) || (kind(n) === "CollateClause" && literal(arg(n)));
}
