/**
 * THE NAMES MASON INVENTS IN A STATEMENT (issue 1024). The rewrite writes names of its own into the SQL it sends the
 * engine: a column it adds beside a table's (the row number a top N over a join reads rows by), a lambda's parameter,
 * a derived table's alias, a WITH query's name, the hidden cells of an exact numeric. A source column, an alias, a table
 * or a WITH query of the same name was then read as Mason's, or Mason's as it: a table with a column `__mason_rid`
 * answered NULLs under a top N over a LEFT JOIN, since `SELECT *, t.rowid AS __mason_rid` listed the table's column
 * first and the join read it as the row number.
 *
 * So every name Mason invents for a statement begins with ONE PREFIX, chosen for that statement (`ownPrefix`): one that
 * no name the statement can reach holds, in any case. Its readers are src/duck/rewrite.ts, src/duck/cte-names.ts,
 * src/duck/late.ts and src/duck/libc-bound.ts, each handed the prefix by src/duck/plan.ts, and src/duck/pgtree.ts for
 * the columns it renames apart.
 *
 * What the statement can reach is read from two places:
 * - the statement as parsed: every name it writes (a table, an alias, a WITH query, a column, an output), and its
 *   literals, which can do no harm here but are not told apart;
 * - Postgres's analysis of it, whose range table names EVERY column of every table and subquery it reads. A column the
 *   statement never writes still reaches the engine through a `*` or a whole row (`SELECT *`, `row_to_json(t)`).
 * Names are compared WITHOUT CASE, as the engine binds them: Postgres tells `"__MASON_RID"` from `__mason_rid`, and
 * DuckDB does not (the review of PR 1093 met that in a WITH query's new name).
 *
 * The prefix is `__mason_` for nearly every statement, so what Mason sends for one that holds no such name is as it
 * was. Where a name holds it, the prefix is `__mason<n>_` for the first n that no name holds.
 *
 * Mason's FUNCTIONS keep their `__mason_` names whatever the prefix: a function is named in a namespace of its own,
 * which no column, alias or table shares.
 */

/** the prefix of a statement's invented names where none of its names holds it */
export const OWN_PREFIX = "__mason_";

/**
 * The prefix every invented name of a statement begins with: one no string of `held` contains, in any case. `held` is
 * what the statement can reach (its parse tree, Postgres's analysis of it). `written` are names Mason itself wrote into
 * the statement before it was analysed (a role's filtered reads, src/duck/row-filter.ts), left out of the test: no
 * invented name is ever one of them.
 */
export function ownPrefix(held: readonly unknown[], written: readonly string[] = []): string {
  let text = JSON.stringify(held).toLowerCase();
  // (each written name as a whole JSON string, quotes included: a name the user wrote that only contains one is kept)
  for (const name of written) text = text.replaceAll(JSON.stringify(name).toLowerCase(), '""');
  let prefix = OWN_PREFIX;
  for (let n = 0; text.includes(prefix); n++) prefix = `__mason${n}_`;
  return prefix;
}

/** the analysed trees' prefixes, each computed once (src/duck/pgtree.ts reads one for several of its readers) */
const analysed = new WeakMap<object, string>();

/** `ownPrefix` of an analysed tree alone, computed once per tree: what src/duck/pgtree.ts renames columns apart by, where
 *  every name to keep apart from is a column the analysis names */
export function analysedPrefix(tree: unknown): string {
  if (tree === null || typeof tree !== "object") return ownPrefix([tree]);
  const known = analysed.get(tree);
  if (known !== undefined) return known;
  const prefix = ownPrefix([tree]);
  analysed.set(tree, prefix);
  return prefix;
}
