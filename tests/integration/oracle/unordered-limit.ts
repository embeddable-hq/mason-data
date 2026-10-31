/**
 * A LIMIT WITH NO ORDER BY (issue 105; src/duck/late.ts joinRows). Which rows such a statement answers is defined by
 * neither engine, and Postgres's choice follows its plan, so the verdict's comparison with Postgres's rows would hold
 * an accident. What IS defined is held instead, in every phase, byte for byte:
 *  - the names, the OIDs and the row count are those of Postgres's answer to the same statement;
 *  - every row is a row of the whole join, as Postgres answers it unlimited, in Postgres's text;
 *  - no row comes back more often than the whole join holds it.
 * With `pages`, the statement is also run page by page: pages of one statement over rows that did not change read
 * every row of the join once. Postgres promises no such thing (its documentation warns that a LIMIT's rows follow the
 * plan), but its fixed plan does it in practice, and a tool paging a preview counts on it; Mason's rows are one list
 * by row number (src/duck/late.ts), which is what keeps a parallel join's pages from overlapping. Tables this small
 * hold the rows, not the parallelism: tests/duck-wire.test.ts holds the plan's order.
 *
 * These are asked apart from `all()`: such a statement can verify nothing for src/duck/verified.ts, whose statements
 * are answered alike, and they may not weaken the verdict the others are held to.
 */

export interface UnorderedLimit { name: string; list: string; from: string; tail: string; values?: string[]; pages?: number; whole?: string }

const JOINED = "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id LEFT JOIN top_c c ON b.id = c.b_id";
const u = (name: string, list: string, from: string, tail: string, more: Partial<UnorderedLimit> = {}): UnorderedLimit => ({ name, list, from, tail, ...more });

export const UNORDERED_LIMITS: UnorderedLimit[] = [
  u("LEFT joins, every table's columns, the tool's preview", "a.*, b.*, c.*", JOINED, "LIMIT 12 OFFSET 0"),
  u("LEFT joins, paged", "a.id, a.note, b.payload, c.doc", JOINED, "LIMIT 7 OFFSET 7", { pages: 7 }),
  u("a LEFT join whose right side is empty of matches", "a.id, b.id AS b, b.payload", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id + 1000", "LIMIT 5"),
  u("a RIGHT join", "a.id, a.note, b.id AS b, b.payload", "FROM top_a a RIGHT JOIN top_b b ON a.id = b.a_id", "LIMIT 6 OFFSET 2", { pages: 6 }),
  u("a FULL join", "a.id, a.note, b.id AS b, b.amount", "FROM top_a a FULL JOIN top_b b ON a.id = b.a_id", "LIMIT 9", { pages: 9 }),
  u("a FULL join with nothing matching", "a.id, b.id AS b", "FROM top_a a FULL JOIN top_b b ON a.id = b.a_id + 1000", "LIMIT 9 OFFSET 3", { pages: 9 }),
  u("an inner join", "a.id, b.id AS b, b.payload ->> 'k' AS k", "FROM top_a a JOIN top_b b ON a.id = b.a_id", "LIMIT 6", { pages: 6 }),
  u("a comma join", "b.id, c.id AS c, c.label", "FROM top_b b, top_c c WHERE c.b_id = b.id", "LIMIT 6"),
  u("a cross join's pairs", "x.id, y.id AS y, x.note, y.note AS n", "FROM top_a x, top_a y", "LIMIT 9 OFFSET 4", { pages: 9 }),
  u("a join that multiplies, one table read", "a.note", "FROM top_a a JOIN top_b b ON a.id = b.a_id", "LIMIT 11"),
  u("rows alike the join repeats", "c.label", "FROM top_c c JOIN top_b b ON c.b_id = b.id", "LIMIT 11", { pages: 11 }),
  u("a table joined to itself", "x.id, x.name, p.id AS parent, g.name AS g", "FROM top_a x LEFT JOIN top_a p ON p.id = x.parent LEFT JOIN top_a g ON g.id = p.parent", "LIMIT 4"),
  u("a WHERE", "a.id, b.id AS b, b.amount", "FROM top_a a JOIN top_b b ON a.id = b.a_id WHERE b.amount > 10 AND a.name IS NOT NULL", "LIMIT 3"),
  u("LIMIT 0", "a.*, b.*", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id", "LIMIT 0"),
  u("a LIMIT parameter", "a.id, b.payload", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id", "LIMIT $1", { values: ["4"] }),
  u("LIMIT and OFFSET parameters", "a.id, b.payload", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id", "LIMIT $1 OFFSET $2", { values: ["4", "3"] }),
  u("OFFSET past the end", "a.id, b.id AS b", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id", "LIMIT 5 OFFSET 100000"),
  u("a LIMIT past the end", "a.id, b.id AS b", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id", "LIMIT 100000"),
  u("FETCH FIRST", "a.id, b.id AS b", "FROM top_a a JOIN top_b b ON a.id = b.a_id", "FETCH FIRST 2 ROWS ONLY"),
  u("a *", "*", JOINED, "LIMIT 8 OFFSET 1"),
  u("a * beside computed columns", "*, b.payload ->> 'k' AS k, upper(a.note) AS n", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id", "LIMIT 8"),
  u("bare names", "note, payload", "FROM top_a a JOIN top_b b ON a.id = b.a_id", "LIMIT 5"),
  u("a cast in the list", "(b.payload ->> 'n')::int AS n, a.id", "FROM top_a a JOIN top_b b ON a.id = b.a_id", "LIMIT 3"),
  u("a view among the tables stays as it was", "a.id, v.id AS v, v.payload", "FROM top_a a JOIN top_v v ON a.id = v.a_id", "LIMIT 5"),
  u("a view alone with a table's *", "a.*, v.*", "FROM top_a a LEFT JOIN top_v v ON a.id = v.a_id", "LIMIT 5 OFFSET 2"),
  u("a table of a column named rowid stays as it was", "r.*, a.note", "FROM top_r r JOIN top_a a ON a.id = r.a_id", "LIMIT 2"),
  u("a derived table of the join", "s.id, s.b", "FROM (SELECT a.id, b.id AS b FROM top_a a JOIN top_b b ON a.id = b.a_id LIMIT 3) s", "LIMIT 2", { whole: "FROM (SELECT a.id, b.id AS b FROM top_a a JOIN top_b b ON a.id = b.a_id) s" }),
];

/** a filtered user's reads (oracle/row-filters.ts): a filtered read is a subquery by now, and stays as it was */
export const UNORDERED_ROW_SHAPES: UnorderedLimit[] = [
  u("two filtered tables", "o.id, c.name, c.tenant_id", "FROM shop.orders o LEFT JOIN shop.customers c ON c.id = o.customer_id", "LIMIT 7"),
  u("three, paged by an offset", "i.id, o.status, c.name", "FROM shop.order_items i JOIN shop.orders o ON o.id = i.order_id JOIN shop.customers c ON c.id = o.customer_id", "LIMIT 5 OFFSET 3"),
];

type Rows = ReadonlyArray<ReadonlyArray<string | null>>;
export interface Answered { names: string[]; oids: number[]; rows: Rows }

const key = (r: ReadonlyArray<string | null>): string => JSON.stringify(r);

/** a row of `rows` the whole join does not hold, or holds fewer times; each row taken from `left` */
function taken(rows: Rows, left: Map<string, number>): string | null {
  for (const r of rows) {
    const n = left.get(key(r));
    if (n === undefined) return `${key(r)} is no row of the whole join`;
    if (n === 0) return `${key(r)} comes back more often than the whole join holds it`;
    left.set(key(r), n - 1);
  }
  return null;
}

function tally(whole: Rows): Map<string, number> {
  const left = new Map<string, number>();
  for (const r of whole) left.set(key(r), (left.get(key(r)) ?? 0) + 1);
  return left;
}

/** what is wrong with Mason's answer `got` to a LIMIT with no ORDER BY, or null. `want` is Postgres's answer to the
 *  same statement, `whole` Postgres's to it unlimited */
export function withinWhole(want: Answered, whole: Rows, got: Answered): string | null {
  if (JSON.stringify([want.names, want.oids]) !== JSON.stringify([got.names, got.oids])) return `fields ${JSON.stringify([got.names, got.oids])} where Postgres sends ${JSON.stringify([want.names, want.oids])}`;
  if (want.rows.length !== got.rows.length) return `${got.rows.length} row(s) where Postgres has ${want.rows.length}`;
  return taken(got.rows, tally(whole));
}

/** what is wrong with `pages` read in turn over a whole join: each row of it comes back exactly as often as it holds it */
export function everyRowOnce(pages: Rows, whole: Rows): string | null {
  const left = tally(whole);
  const wrong = taken(pages, left);
  if (wrong !== null) return wrong;
  const missed = [...left].find(([, n]) => n > 0);
  return missed === undefined ? null : `${missed[0]} is in no page`;
}
