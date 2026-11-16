/**
 * WHAT A NAME IN A FROM READS, BY POSTGRES'S RULES (issue 981). A WITH query is seen by the query that declares it, by
 * every query inside that one, and by the WITH queries declared after it in the same list. It is never seen by its own
 * body or by an earlier one's, unless the WITH is RECURSIVE: then every query of the list sees every other, and itself.
 * So `WITH big AS (SELECT * FROM big WHERE tenant = 0) SELECT … FROM big` reads the TABLE big inside the WITH query, and
 * the WITH query outside it.
 *
 * This module is the one place that reads those rules. Its readers:
 * - the listener, which sends a statement that reads a table to the synced data, and one that reads none to the
 *   catalog (src/api/postgres/translate.ts `duckTranslate`). It took the body's `big` for the WITH query, so the
 *   statement read "no table" and the empty catalog answered: a count of 0.
 * - the hidden columns' view (src/duck/kept-route.ts `exposes`, `hideKept`), which reads a copy listed by a `*`
 *   through its view. It missed a set operation's arm's own WITH, and read a name that WITH binds as the copy of that
 *   name.
 * - the rewrite (src/duck/rewrite.ts `rewrite`), before anything else reads the statement. Its resolvers, and those of
 *   src/duck/late.ts, src/duck/libc-bound.ts, src/duck/kept-route.ts and the generated tables' swap, each read a name
 *   by rules of their own. Each took the body's `big` for the WITH query, and a pass-through followed it into itself
 *   for ever (XX000 "Maximum call stack size exceeded"). Rather than teach each one the rules, `cteNamesApart` renames
 *   a WITH query whose name the statement also gives to anything else (a table, qualified or not, or another WITH
 *   query). Its new name is one the statement holds nowhere. Each read of it is renamed too, and keeps the name it was
 *   written by as its alias, so a qualified column, a whole row and the output's names are as before. After that, a
 *   bare name has one meaning in the statement, whatever rules a later reader applies.
 *
 * Names are compared WITHOUT CASE here, as DuckDB binds them (the review of PR 1093). Postgres tells `"Small"` from
 * `small`, and DuckDB does not: `WITH small AS (…) SELECT … FROM "Small"` read the WITH query there. So a WITH query
 * whose name equals another's or a table's in any case is renamed, and the new name is one the statement holds in no
 * case (a table `"__MASON_WITH0"` was read as the renamed WITH query).
 *
 * A statement whose names are already apart is left exactly as it was.
 */

type Body = Record<string, unknown>;

const isBody = (v: unknown): v is Body => v !== null && typeof v === "object" && !Array.isArray(v);

/** One FROM name of a statement, and the WITH query Postgres's rules bind it to (null: a relation). */
interface Read { range: Body; to: Body | null }

/**
 * Each FROM name of a statement, bound as Postgres binds it, and every WITH query it declares. A locking clause's
 * `OF t` names a FROM item by its alias, and INTO names a table to make. Neither is a read, so neither is bound or
 * renamed, and a reader that counts relations still counts them.
 */
function bindings(tree: unknown): { reads: Read[]; ctes: Body[] } {
  const reads: Read[] = [];
  const ctes: Body[] = [];
  const bound = (scope: ReadonlyArray<ReadonlyMap<string, Body>>, name: string): Body | null => {
    for (let i = scope.length - 1; i >= 0; i--) { const c = scope[i]!.get(name); if (c !== undefined) return c; }
    return null;
  };
  const walk = (v: unknown, scope: ReadonlyArray<ReadonlyMap<string, Body>>): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x, scope); return; }
    if (!isBody(v)) return;
    if (isBody(v.SelectStmt)) { query(v.SelectStmt, scope); return; }
    if (isBody(v.RangeVar)) {
      const r = v.RangeVar;
      const bare = r.schemaname === undefined && r.catalogname === undefined;
      reads.push({ range: r, to: bare ? bound(scope, String(r.relname)) : null });
      return;
    }
    for (const x of Object.values(v)) walk(x, scope);
  };
  const query = (b: Body, outer: ReadonlyArray<ReadonlyMap<string, Body>>): void => {
    const w = isBody(b.withClause) ? b.withClause : undefined;
    const list = (Array.isArray(w?.ctes) ? w.ctes : []).map((c) => isBody(c) && isBody(c.CommonTableExpr) ? c.CommonTableExpr : null)
      .filter((c): c is Body => c !== null);
    ctes.push(...list);
    const named = (cs: Body[]): Map<string, Body> => new Map(cs.map((c) => [String(c.ctename), c]));
    const all = list.length === 0 ? outer : [...outer, named(list)];
    // a WITH query's body sees every query of a RECURSIVE list, else only those declared before it
    list.forEach((c, i) => walk(c.ctequery, w?.recursive === true ? all : [...outer, named(list.slice(0, i))]));
    for (const [key, x] of Object.entries(b)) {
      // (a set operation's arms are SELECTs written bare, not as nodes: each a query of its own, with its own WITH)
      if ((key === "larg" || key === "rarg") && isBody(x)) query(x, all);
      else if (key !== "withClause" && key !== "lockingClause" && key !== "intoClause") walk(x, all);
    }
  };
  walk(tree, []);
  return { reads, ctes };
}

/** The RangeVars of a statement (its parse tree, from its root node) that Postgres binds to a WITH query. Every other
 *  RangeVar it holds names a relation. */
export function cteReads(tree: unknown): Set<object> {
  return new Set(bindings(tree).reads.filter((r) => r.to !== null).map((r) => r.range));
}

/** Renames, in place, each WITH query of `tree` whose name the statement gives to anything else, and its reads (see
 *  the module's comment). */
export function cteNamesApart(tree: unknown): void {
  const { reads, ctes } = bindings(tree);
  if (ctes.length === 0) return;
  // (without case, as DuckDB binds a name: see above)
  const same = (a: unknown, b: unknown): boolean => String(a).toLowerCase() === String(b).toLowerCase();
  const clashes = ctes.filter((c) => ctes.some((o) => o !== c && same(o.ctename, c.ctename)) || reads.some((r) => same(r.range.relname, c.ctename) && r.to !== c));
  if (clashes.length === 0) return;
  const written = JSON.stringify(tree).toLowerCase();
  let n = 0;
  const fresh = (): string => { let name: string; do name = `__mason_with${n++}`; while (written.includes(name)); return name; };
  for (const c of clashes) {
    const was = String(c.ctename), now = fresh();
    for (const r of reads) {
      if (r.to !== c) continue;
      r.range.relname = now;
      if (!isBody(r.range.alias)) r.range.alias = { aliasname: was };
    }
    c.ctename = now;
  }
}
