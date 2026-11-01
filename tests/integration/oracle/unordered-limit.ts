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
 * hold the rows, not the parallelism: tests/duck-wire.test.ts holds the plan's order. ONLY A JOIN PROVED BOUNDED HAS
 * `pages` (fanOutBounded, src/duck/distinct-key.ts): the rest have no sort, and their pages may overlap, as is decided.
 *
 * These are asked apart from `all()`: such a statement can verify nothing for src/duck/verified.ts, whose statements
 * are answered alike, and they may not weaken the verdict the others are held to.
 */

export interface UnorderedLimit { name: string; list: string; from: string; tail: string; values?: string[]; pages?: number; whole?: string;
  /** a WITH clause before the SELECT */
  head?: string;
  /** the session's TimeZone it is asked in (UTC where none is said) */
  zone?: string }

const JOINED = "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id LEFT JOIN top_c c ON b.id = c.b_id";
const u = (name: string, list: string, from: string, tail: string, more: Partial<UnorderedLimit> = {}): UnorderedLimit => ({ name, list, from, tail, ...more });

const JOINED_TABLES: UnorderedLimit[] = [
  u("LEFT joins, every table's columns, the tool's preview", "a.*, b.*, c.*", JOINED, "LIMIT 12 OFFSET 0"),
  u("LEFT joins, paged", "a.id, a.note, b.payload, c.doc", JOINED, "LIMIT 7 OFFSET 7", { pages: 7 }),
  u("a LEFT join whose right side is empty of matches", "a.id, b.id AS b, b.payload", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id + 1000", "LIMIT 5"),
  u("a RIGHT join", "a.id, a.note, b.id AS b, b.payload", "FROM top_a a RIGHT JOIN top_b b ON a.id = b.a_id", "LIMIT 6 OFFSET 2", { pages: 6 }),
  u("a FULL join", "a.id, a.note, b.id AS b, b.amount", "FROM top_a a FULL JOIN top_b b ON a.id = b.a_id", "LIMIT 9", { pages: 9 }),
  u("a FULL join with nothing matching", "a.id, b.id AS b", "FROM top_a a FULL JOIN top_b b ON a.id = b.a_id + 1000", "LIMIT 9 OFFSET 3"),
  u("an inner join", "a.id, b.id AS b, b.payload ->> 'k' AS k", "FROM top_a a JOIN top_b b ON a.id = b.a_id", "LIMIT 6", { pages: 6 }),
  u("a comma join", "b.id, c.id AS c, c.label", "FROM top_b b, top_c c WHERE c.b_id = b.id", "LIMIT 6"),
  u("a cross join's pairs", "x.id, y.id AS y, x.note, y.note AS n", "FROM top_a x, top_a y", "LIMIT 9 OFFSET 4"),
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
  // THE FAN-OUT GUARD (src/duck/distinct-key.ts fanOutBounded), held to count, rows and multiplicity on both sides.
  // Not proved, no sort: many to many under each join kind, a table joined to itself, every column read
  u("many to many", "x.id, y.id AS y, x.note, y.note AS n", "FROM top_b b JOIN top_b b2 ON b.a_id = b2.a_id JOIN top_a x ON x.id = b.id JOIN top_a y ON y.id = b2.id", "LIMIT 7"),
  u("many to many, a table joined to itself", "x.id, y.id AS y, x.payload", "FROM top_b x JOIN top_b y ON x.a_id = y.a_id", "LIMIT 13 OFFSET 3"),
  u("many to many, LEFT", "x.id, y.id AS y, y.payload", "FROM top_b x LEFT JOIN top_b y ON x.a_id = y.a_id", "LIMIT 13 OFFSET 3"),
  u("many to many, RIGHT", "x.id, y.id AS y, x.payload", "FROM top_b x RIGHT JOIN top_b y ON x.a_id = y.a_id", "LIMIT 13 OFFSET 3"),
  u("many to many, FULL", "x.id, y.id AS y, x.amount", "FROM top_b x FULL JOIN top_b y ON x.a_id = y.a_id", "LIMIT 13 OFFSET 3"),
  u("many to many, a row repeated", "x.a_id", "FROM top_b x JOIN top_b y ON x.a_id = y.a_id", "LIMIT 40"),
  u("many to many, a * and a page past the end", "*", "FROM top_b x JOIN top_b y ON x.a_id = y.a_id", "LIMIT 5 OFFSET 100000"),
  u("a chasm: a key equated twice, the first join repeating it", "a.id, b.id AS b, c.id AS c", "FROM top_a a JOIN top_b b ON b.a_id = a.id JOIN top_b c ON c.a_id = a.id", "LIMIT 11"),
  u("a chasm of LEFT joins", "a.note, b.payload, c.payload AS p", "FROM top_a a LEFT JOIN top_b b ON b.a_id = a.id LEFT JOIN top_b c ON c.a_id = a.id", "LIMIT 11 OFFSET 2"),
  u("a composite key in part", "k.id, p.line, p.v", "FROM keyed k JOIN pairs p ON p.id = k.part", "LIMIT 5"),
  u("a composite key in part, LEFT", "k.id, p.line, p.v", "FROM keyed k LEFT JOIN pairs p ON p.id = k.part", "LIMIT 8 OFFSET 2"),
  u("a partial unique index that is no key", "k.id, r.id AS r, r.code", "FROM keyed k JOIN keyed r ON r.part = k.part", "LIMIT 6"),
  u("a UNIQUE that is no key", "k.id, r.id AS r, r.code", "FROM keyed k LEFT JOIN keyed r ON r.code = k.ref", "LIMIT 6"),
  u("a composite UNIQUE that is no key", "k.id, r.id AS r", "FROM keyed k JOIN keyed r ON r.a = k.a AND r.b = k.b", "LIMIT 6"),
  u("a table with no primary key, copied by its key", "b.id, n.note", "FROM top_b b JOIN top_n n ON n.a = b.a_id AND n.b = b.a_id", "LIMIT 2"),
  u("a table with no primary key, joined to itself by its key", "n.b, m.note", "FROM top_n n JOIN top_n m ON m.a = n.a AND m.b = n.b", "LIMIT 4"),
  u("an OR in the ON", "a.id, b.id AS b, b.payload", "FROM top_a a JOIN top_b b ON a.id = b.a_id OR a.id = b.id", "LIMIT 9"),
  u("an OR in a LEFT join's ON", "a.id, b.id AS b, b.payload", "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id OR b.id = 1", "LIMIT 9 OFFSET 2"),
  // proved, sorted: a key on each side, a composite key whole, each outer join, pages one list
  u("the key on the right", "b.id, a.note", "FROM top_b b JOIN top_a a ON a.id = b.a_id", "LIMIT 6", { pages: 6 }),
  u("the key on the left of a RIGHT join", "b.id, a.note", "FROM top_a a RIGHT JOIN top_b b ON b.a_id = a.id", "LIMIT 6", { pages: 6 }),
  u("the key of a FULL join, on the right", "b.id, a.note", "FROM top_b b FULL JOIN top_a a ON a.id = b.a_id", "LIMIT 6", { pages: 6 }),
  u("a composite key, whole", "x.id, x.line, y.v", "FROM pairs x JOIN pairs y ON y.id = x.id AND y.line = x.line", "LIMIT 3", { pages: 3 }),
  u("a composite key, whole, LEFT with no match", "x.id, y.line, y.v", "FROM pairs x LEFT JOIN pairs y ON y.id = x.id + 1 AND y.line = x.line", "LIMIT 3"),
  u("a star of keys", "b.id, a.note, c.label", "FROM top_c c JOIN top_b b ON b.id = c.b_id JOIN top_a a ON a.id = b.a_id", "LIMIT 6", { pages: 6 }),
  u("a comma join on a key", "c.id, b.payload", "FROM top_c c, top_b b WHERE b.id = c.b_id", "LIMIT 6", { pages: 6 }),
  u("a varchar key from a text column", "k.id, v.label", "FROM keyed k LEFT JOIN vkeys v ON v.id = k.ref", "LIMIT 3", { pages: 3 }),
  u("a derived table of the join", "s.id, s.b", "FROM (SELECT a.id, b.id AS b FROM top_a a JOIN top_b b ON a.id = b.a_id LIMIT 3) s", "LIMIT 2", { whole: "FROM (SELECT a.id, b.id AS b FROM top_a a JOIN top_b b ON a.id = b.a_id) s" }),
];

/**
 * A JOIN'S FROM ITEMS (src/duck/late.ts; issue 134, step 2): a table, a plain derived read, or carried, each spelling of
 * each under every kind of join. `FROM_ITEMS_*` are generated, so a kind or a spelling added is held in all of them:
 * here with no ORDER BY, and in the type matrix (`FROM_ITEMS_SORTED`) under every collation kind and two session zones.
 */
/** the views a spelling reads (added to oracle/type-matrix.ts TYPED): `top_read` the plain side, `top_read2` a view of it,
 *  `top_sums` a grouped side, and a view of a join per kind below */
const SIDE_LIST = "b.id, b.a_id, b.a_id + 1 AS key, b.payload, 1 AS one, b.amount * 2 AS twice, upper(b.payload ->> 'k') AS up, date_trunc('day', b.seen::timestamptz) AS day";
const SIDE = `SELECT ${SIDE_LIST} FROM top_b b WHERE b.id < 20`;
/** the same side over the left table: a table joined to itself */
const SIDE_SELF = "SELECT p.id, p.parent AS a_id, p.parent + 1 AS key, p.note AS payload, 1 AS one, p.id * 2 AS twice, upper(p.name) AS up, date_trunc('day', p.made) AS day FROM top_a p WHERE p.id > 1";
const SUMS = "SELECT b.a_id, b.a_id + 1 AS key, count(*) AS id, 'sum' AS payload, 1 AS one, sum(b.amount) AS twice, max(b.payload ->> 'k') AS up, max(b.seen)::timestamptz AS day FROM top_b b GROUP BY b.a_id";

const JOIN_KINDS: ReadonlyArray<{ kind: string; from: (side: string) => string; bounded: boolean }> = [
  { kind: "LEFT", from: (d) => `top_a a LEFT JOIN ${d} ON a.id = d.a_id`, bounded: true },
  { kind: "RIGHT", from: (d) => `top_a a RIGHT JOIN ${d} ON a.id = d.a_id`, bounded: true },
  { kind: "FULL", from: (d) => `top_a a FULL JOIN ${d} ON a.id = d.a_id`, bounded: true },
  { kind: "inner", from: (d) => `top_a a JOIN ${d} ON a.id = d.a_id`, bounded: true },
  { kind: "comma", from: (d) => `top_a a, ${d} WHERE a.id = d.a_id`, bounded: true },
  { kind: "a side with no match", from: (d) => `top_a a LEFT JOIN ${d} ON a.id = d.a_id + 1000`, bounded: false },
  { kind: "a computed join key", from: (d) => `top_a a LEFT JOIN ${d} ON a.id = d.key`, bounded: false },
  { kind: "a join that multiplies", from: (d) => `top_a a JOIN ${d} ON a.id % 2 = d.a_id % 2`, bounded: false },
];
const SELF = { kind: "a table joined to itself", from: (d: string) => `top_a a LEFT JOIN ${d} ON a.id = d.a_id`, bounded: true };

const OUT = "a.id, a.name, a.made, d.id AS d_id, d.a_id, d.key, d.one, d.twice, d.up, d.day";
const wrapped = (from: string): string => `SELECT ${OUT} FROM ${from}`;
const viewName = (kind: string): string => `top_join_${JOIN_KINDS.findIndex((k) => k.kind === kind)}`;

/** the tables merged columns are held over: `top_m1` and `top_m2` share columns of differing types, NULLs and repeats on
 *  either side; `top_m4` shares two of `top_m1`'s; `top_m3` shares none */
export const MERGE_COPIED = ["top_m1", "top_m2", "top_m3", "top_m4"];
const MERGE_TABLES =
  "CREATE TABLE public.top_m1 (id int PRIMARY KEY, k int, s varchar(8), t text, w bigint, f real, made timestamptz, only1 text); " +
  "INSERT INTO public.top_m1 VALUES (1, 10, 'a', 'b', 4294967296, 0.1, '2024-03-10 23:30:00+00', 'one'), (2, 20, 'b', 'A', 2, 0.5, '2024-03-11 01:00:00+00', 'two'), (3, NULL, 'c', NULL, NULL, NULL, NULL, 'three'), " +
  "(4, 20, NULL, 'a', 4, 1.5, '2024-11-03 05:30:00+00', 'four'), (5, 50, 'e', 'é', 5, 2.5, '2024-11-03 06:30:00+00', 'five'), (6, NULL, 'f', 'Z', 6, 3.5, NULL, 'six'); " +
  "CREATE TABLE public.top_m2 (id bigint PRIMARY KEY, k int, s text, t text, w int, f double precision, made timestamptz, only2 text); " +
  "INSERT INTO public.top_m2 VALUES (2, 20, 'b', 'A', 2, 0.5, '2024-03-11 01:00:00+00', 'dos'), (3, 30, 'x', 'c', 3, 0.10000000149011612, NULL, 'tres'), (4, NULL, NULL, 'a', 4, 1.5, '2024-11-03 05:30:00+00', 'cuatro'), " +
  "(7, 20, 'g', 'é', 70, 7.5, '2024-03-10 23:30:00+00', 'siete'), (8, NULL, 'h', NULL, NULL, NULL, NULL, 'ocho'); " +
  "CREATE TABLE public.top_m3 (x int PRIMARY KEY, y text); INSERT INTO public.top_m3 VALUES (1, 'p'), (2, 'q'); " +
  "CREATE TABLE public.top_m4 (id int PRIMARY KEY, k int, tail text); INSERT INTO public.top_m4 VALUES (2, 20, 'l2'), (4, 21, 'l4'), (9, 90, 'l9'), (10, NULL, 'l10'); ";

/** the side's spelling by kind, and the same in each view of a join */
export const FROM_ITEM_VIEWS: string = MERGE_TABLES +
  "CREATE VIEW public.top_merged AS SELECT id, k, x.only1, y.only2 FROM public.top_m1 x FULL JOIN public.top_m2 y USING (id, k); " +
  `CREATE VIEW public.top_read AS ${SIDE}; CREATE VIEW public.top_read2 AS SELECT * FROM public.top_read WHERE id > 1; CREATE VIEW public.top_sums AS ${SUMS}; ` +
  JOIN_KINDS.map((k) => `CREATE VIEW public.${viewName(k.kind)} AS ${wrapped(k.from(`(${SIDE}) d`))}; `).join("") +
  `CREATE VIEW public.top_join_twice AS SELECT * FROM public.top_join_0 WHERE id IS NOT NULL OR d_id > 0;`;

interface Spelling { spelled: string; side?: (k: typeof SELF) => string; head?: string; from?: (k: typeof SELF) => string; carried?: boolean }
const SPELLINGS: Spelling[] = [
  { spelled: "a derived side", side: (k) => k.from(`(${k === SELF ? SIDE_SELF : SIDE}) d`) },
  { spelled: "a view as a side", side: (k) => k.from("top_read d") },
  { spelled: "a view of a view as a side", side: (k) => k.from("top_read2 d") },
  { spelled: "a WITH query as a side", head: `WITH d AS (${SIDE}) `, side: (k) => k.from("d") },
  { spelled: "a MATERIALIZED WITH query", head: `WITH d AS MATERIALIZED (${SIDE}) `, side: (k) => k.from("d"), carried: true },
  { spelled: "an aggregated side", side: (k) => k.from(`(${SUMS}) d`), carried: true },
  { spelled: "a grouped view as a side", side: (k) => k.from("top_sums d"), carried: true },
  { spelled: "a tool's wrapper", from: (k) => `(${wrapped(k.from(`(${SIDE}) d`))}) t` },
  { spelled: "a WITH query of the join", from: () => "j" },
  { spelled: "a view of the join", from: (k) => viewName(k.kind) },
];

/** a spelling of a kind: the SELECT's head, its list and its FROM */
function spelledAs(s: Spelling, k: typeof SELF): { head: string; list: string; from: string } {
  if (s.spelled === "a WITH query of the join") return { head: `WITH j AS (${wrapped(k.from(`(${SIDE}) d`))}) `, list: "*", from: "FROM j" };
  return s.side !== undefined ? { head: s.head ?? "", list: OUT, from: `FROM ${s.side(k)}` } : { head: "", list: "*", from: `FROM ${s.from!(k)}` };
}
const applies = (s: Spelling, k: typeof SELF): boolean => k !== SELF || s.spelled === "a derived side";

const everySpelling = (): Array<{ s: Spelling; k: typeof SELF }> => [...JOIN_KINDS, SELF].flatMap((k) => SPELLINGS.filter((s) => applies(s, k)).map((s) => ({ s, k })));

/** each spelling of each kind with no ORDER BY: pages one list where the join is proved, never where it is not */
export const FROM_ITEMS_UNORDERED: UnorderedLimit[] = [
  ...everySpelling().map(({ s, k }) => {
    const { head, list, from } = spelledAs(s, k);
    return u(`${s.spelled}, ${k.kind}`, list, from, "LIMIT 7 OFFSET 1", { ...(head !== "" ? { head } : {}), ...(k.bounded && s.carried !== true ? { pages: 6 } : {}) });
  }),
  // a WITH query read twice is no plain read of one reference, and a column of a side the list does not read
  u("a WITH query read twice", "a.id, x.id AS x, y.up", "FROM top_a a LEFT JOIN w x ON x.a_id = a.id LEFT JOIN w y ON y.key = a.id", "LIMIT 9", { head: `WITH w AS (${SIDE}) ` }),
  u("a recursive WITH query beside a table", "a.id, a.note, r.n", "FROM top_a a JOIN r ON r.n = a.id", "LIMIT 3", { head: "WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT r.n + 1 FROM r WHERE r.n < 4) " }),
  u("a set-returning derived list beside a table", "a.id, a.note, d.g", "FROM top_a a JOIN (SELECT b.a_id, generate_series(1, 2) AS g FROM top_b b) d ON d.a_id = a.id", "LIMIT 7"),
  u("a side the list does not read", "a.id, a.note", `FROM top_a a JOIN (${SIDE}) d ON d.a_id = a.id`, "LIMIT 5"),
  u("a zone of the session's in a derived list", "a.id, d.day", `FROM top_a a LEFT JOIN (${SIDE}) d ON d.a_id = a.id`, "LIMIT 5", { zone: "America/New_York" }),
];

/**
 * MERGED COLUMNS (src/duck/late.ts; issue 134, step 3): `USING` and `NATURAL` under each join kind, read through Postgres's
 * join alias variables, in a list and in a `*`, unsorted here and sorted in the type matrix.
 */
const JOINS: ReadonlyArray<{ kind: string; join: string }> = [{ kind: "inner", join: "JOIN" }, { kind: "LEFT", join: "LEFT JOIN" }, { kind: "RIGHT", join: "RIGHT JOIN" }, { kind: "FULL", join: "FULL JOIN" }];
/** a merged spelling: `from` by the join's words, the columns merged, and what sorts its rows to one order */
const MERGED: ReadonlyArray<{ spelled: string; from: (j: string) => string; list: string; ties: string }> = [
  { spelled: "USING (id), bigint and int", from: (j) => `top_m1 x ${j} top_m2 y USING (id)`, list: "id, x.only1, y.only2", ties: "x.only1 NULLS FIRST, y.only2 NULLS FIRST" },
  { spelled: "USING (k), a column that repeats and holds NULLs", from: (j) => `top_m1 x ${j} top_m2 y USING (k)`, list: "k, x.only1, y.only2", ties: "x.only1 NULLS FIRST, y.only2 NULLS FIRST" },
  { spelled: "USING of a varchar and a text", from: (j) => `top_m1 x ${j} top_m2 y USING (s)`, list: "s, x.only1, y.only2", ties: "x.only1 NULLS FIRST, y.only2 NULLS FIRST" },
  { spelled: "USING of a bigint and an int", from: (j) => `top_m1 x ${j} top_m2 y USING (w)`, list: "w, x.only1, y.only2", ties: "x.only1 NULLS FIRST, y.only2 NULLS FIRST" },
  { spelled: "USING of a real and a double", from: (j) => `top_m1 x ${j} top_m2 y USING (f)`, list: "f, x.only1, y.only2", ties: "x.only1 NULLS FIRST, y.only2 NULLS FIRST" },
  { spelled: "a many-column USING", from: (j) => `top_m1 x ${j} top_m2 y USING (id, k, s, t, w, f, made)`, list: "id, k, s, t, w, f, made, x.only1, y.only2", ties: "k NULLS FIRST, x.only1 NULLS FIRST, y.only2 NULLS FIRST" },
  { spelled: "NATURAL, two columns in common", from: (j) => `top_m1 x NATURAL ${j} top_m4 z`, list: "id, k, x.only1, z.tail", ties: "k NULLS FIRST, x.only1 NULLS FIRST, z.tail NULLS FIRST" },
  { spelled: "NATURAL with no column in common", from: (j) => `top_m1 x NATURAL ${j} top_m3 z`, list: "id, x.only1, z.x, z.y", ties: "z.x" },
  { spelled: "two joins merging one column", from: (j) => `top_m1 x ${j} top_m4 z USING (id) ${j} top_m2 y USING (id)`, list: "id, x.only1, z.tail, y.only2", ties: "x.only1 NULLS FIRST, z.tail NULLS FIRST, y.only2 NULLS FIRST" },
  { spelled: "a merged column beside a join on a condition", from: (j) => `top_m1 x ${j} top_m4 z USING (id) LEFT JOIN top_m3 m ON m.x = id`, list: "id, x.only1, z.tail, m.y", ties: "x.only1 NULLS FIRST, z.tail NULLS FIRST" },
];
const MERGED_ROWS = MERGED.flatMap((m) => JOINS.map(({ kind, join }) => ({ name: `${m.spelled}, ${kind}`, from: `FROM ${m.from(join)}`, list: m.list, key: m.list.split(",")[0]!, ties: m.ties })));

const MERGED_UNORDERED: UnorderedLimit[] = [
  ...MERGED_ROWS.flatMap((m) => [
    u(`merged: ${m.name}`, m.list, m.from, "LIMIT 7 OFFSET 1"),
    u(`merged: ${m.name}, a *`, "*", m.from, "LIMIT 7"),
  ]),
  // a USING that equates a key is proved bounded: its pages are one list
  ...JOINS.map(({ kind, join }) => u(`merged: paged, a key's USING, ${kind}`, "id, x.only1, z.tail", `FROM top_m1 x ${join} top_m4 z USING (id)`, "LIMIT 3", { pages: 3 })),
];

const keysOver = (id: string): ReadonlyArray<{ key: string; order: string; zone?: string }> => [
  { key: "the database's order", order: `name DESC NULLS LAST, ${id}` },
  { key: "bytes", order: `name COLLATE "C", ${id}` },
  { key: "ICU", order: `name COLLATE "und-x-icu" DESC, ${id}` },
  { key: "the nulls idiom, in a zone of daylight saving", order: `(made) IS NULL ASC, made DESC, ${id}`, zone: "America/New_York" },
];

/**
 * COMPUTED SORT KEYS (src/duck/late.ts; issue 134, step 3): each spelling of one output as a key, each direction, each kind
 * of value, its value shown: one value, read from the key.
 */
const COMPUTED_FROM = "FROM top_a a LEFT JOIN top_b b ON b.a_id = a.id";
const COMPUTED_OUTPUTS: ReadonlyArray<{ value: string; what: string; zone?: string }> = [
  { value: "a.id * 2", what: "an integer" },
  { value: "upper(a.name)", what: "a text under the database's order" },
  { value: "b.payload ->> 'k'", what: "a jsonb field" },
  { value: "b.amount * 2", what: "a numeric" },
  { value: "date_trunc('day', a.made)", what: "a day in the zone of the session" },
  { value: "date_trunc('day', a.made)", what: "a day in a zone of daylight saving", zone: "America/New_York" },
  { value: "to_char(a.made, 'YYYY-MM-DD HH24')", what: "a timestamptz's text in another zone", zone: "Asia/Kathmandu" },
  { value: "coalesce(a.note, 'none') || '!'", what: "a value of a NULL" },
];
const DIRECTIONS = ["", " DESC", " DESC NULLS LAST", " NULLS FIRST"];
const COMPUTED_TIES = "2 NULLS FIRST, 3 NULLS FIRST";
const COMPUTED_SPELLINGS: ReadonlyArray<{ spelled: string; order: (value: string) => string }> = [
  { spelled: "by name", order: () => "x" },
  { spelled: "by ordinal", order: () => "1" },
  { spelled: "by the repeated expression", order: (value) => value },
];
const COMPUTED_KEYS: ReadonlyArray<{ name: string; sql: string; zone?: string }> = [
  ...COMPUTED_OUTPUTS.flatMap(({ value, what, zone }) => COMPUTED_SPELLINGS.flatMap(({ spelled, order }) => DIRECTIONS.map((dir) => ({
    name: `computed key: ${what}, ${spelled}${dir}`,
    sql: `SELECT ${value} AS x, a.id, b.id AS b, b.payload ${COMPUTED_FROM} ORDER BY ${order(value)}${dir}, ${COMPUTED_TIES} LIMIT 6 OFFSET 1`,
    ...(zone !== undefined ? { zone } : {}) })))),
  ...["C", "und-x-icu"].flatMap((c) => [
    { name: `computed key: an output of its own collation ${c}, by name`, sql: `SELECT upper(a.name) COLLATE "${c}" AS x, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY x DESC, ${COMPUTED_TIES} LIMIT 5` },
    { name: `computed key: a key of a collation the output has not, ${c}`, sql: `SELECT upper(a.name) AS x, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY upper(a.name) COLLATE "${c}", ${COMPUTED_TIES} LIMIT 5` },
  ]),
  { name: "computed key: the nulls idiom over a computed key", sql: `SELECT a.id * 2 AS x, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY (b.amount * 2) IS NULL ASC, b.amount * 2 DESC, ${COMPUTED_TIES} LIMIT 5` },
  { name: "computed key: the nulls idiom of an input an output's name shadows", sql: `SELECT upper(a.note) AS name, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY (name) IS NULL ASC, name DESC, ${COMPUTED_TIES} LIMIT 5` },
  { name: "computed key: two outputs of one expression, the second named", sql: `SELECT upper(a.name) AS x, a.id, b.id AS b, upper(a.name) AS y ${COMPUTED_FROM} ORDER BY y DESC, ${COMPUTED_TIES} LIMIT 5` },
  { name: "computed key: an output computed over its own key", sql: `SELECT a.id * 2 AS x, a.id, b.id AS b, a.id * 2 + 1 AS y ${COMPUTED_FROM} ORDER BY x DESC, ${COMPUTED_TIES} LIMIT 5` },
  { name: "computed key: one output twice in the sort", sql: `SELECT a.id * 2 AS x, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY x, 1 DESC, ${COMPUTED_TIES} LIMIT 5` },
  { name: "computed key: a key no output shows", sql: `SELECT a.id, b.id AS b, b.payload ${COMPUTED_FROM} ORDER BY a.id % 3, 1, 2 NULLS FIRST LIMIT 5` },
  { name: "computed key: beside a *, by ordinal", sql: `SELECT *, a.id * 2 AS x ${COMPUTED_FROM} ORDER BY 11 DESC, 1, 6 NULLS FIRST LIMIT 4` },
  { name: "computed key: beside a *, by name", sql: `SELECT a.*, b.id AS b, a.id * 2 AS x ${COMPUTED_FROM} ORDER BY x DESC, b NULLS FIRST LIMIT 4` },
  { name: "computed key: a tool's wrapper by its output's name", sql: `SELECT id, b, x FROM (SELECT a.id, b.id AS b, a.id * 2 AS x, b.payload ${COMPUTED_FROM}) t ORDER BY x DESC, 2 NULLS FIRST LIMIT 4` },
  { name: "computed key: a tool's wrapper by the qualified column", sql: `SELECT id, b, x FROM (SELECT a.id, b.id AS b, upper(a.name) AS x, b.payload ${COMPUTED_FROM}) t ORDER BY t.x DESC, 1, 2 NULLS FIRST LIMIT 4` },
  { name: "computed key: a wrapper's * by ordinal", sql: `SELECT * FROM (SELECT a.id, b.id AS b, upper(a.name) AS x ${COMPUTED_FROM}) t ORDER BY 3 DESC, 1, 2 NULLS FIRST LIMIT 4` },
  { name: "computed key: a view of joins by its computed column", sql: "SELECT * FROM top_join_0 ORDER BY twice DESC NULLS LAST, id, d_id NULLS FIRST LIMIT 4" },
  { name: "computed key: a computed output beside an aggregated side", sql: "SELECT a.id, s.twice * 2 AS total FROM top_a a LEFT JOIN top_sums s ON s.a_id = a.id ORDER BY total DESC NULLS LAST, 1 LIMIT 3" },
  { name: "computed key: a derived side's column in a computed key", sql: `SELECT a.id, d.twice + 1 AS x, d.id AS d FROM top_a a LEFT JOIN (${SIDE}) d ON d.a_id = a.id ORDER BY x DESC NULLS LAST, 1, 3 LIMIT 4` },
  { name: "computed key: over a merged column", sql: "SELECT id + 1 AS x, y.only2 FROM top_m1 x FULL JOIN top_m2 y USING (id) ORDER BY x DESC, 2 NULLS FIRST LIMIT 4" },
  // what a computed key may not change: it runs on every row, as Postgres sorts every row
  { name: "computed key: an output that raises, by name", sql: `SELECT 1 / (a.id - 2) AS x, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY x, 2, 3 LIMIT 1` },
  { name: "computed key: a key that raises, no output shows it", sql: `SELECT a.id, b.id AS b ${COMPUTED_FROM} ORDER BY 1 / (a.id - 2), 1, 2 LIMIT 1` },
  { name: "computed key: a cast that raises", sql: `SELECT (a.name || 'x')::int AS x, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY x, 2, 3 LIMIT 1` },
  // random() and now(): what is defined of them
  { name: "computed key: random() in the list, no key", sql: `SELECT random() < 2 AS r, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY a.id, b.id NULLS FIRST LIMIT 4` },
  { name: "computed key: random() shown and a key", sql: `SELECT random() < 2 AS r, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY r, ${COMPUTED_TIES} LIMIT 4` },
  { name: "computed key: random() a key beside the columns", sql: `SELECT a.id, b.id AS b ${COMPUTED_FROM} ORDER BY random() < 2, 1, 2 NULLS FIRST LIMIT 4` },
  { name: "computed key: now() shown and a key", sql: `SELECT now() - now() AS r, a.id, b.id AS b ${COMPUTED_FROM} ORDER BY r, ${COMPUTED_TIES} LIMIT 4` },
  { name: "computed key: now() a key, in a zone", sql: `SELECT a.id, b.id AS b, a.made < now() AS gone ${COMPUTED_FROM} ORDER BY gone NULLS FIRST, 1, 2 NULLS FIRST LIMIT 4`, zone: "America/New_York" },
];

/** the merged columns sorted, each byte held: by the merged column, a `*`, each collation kind, the nulls idiom, a zone */
const MERGED_SORTED: ReadonlyArray<{ name: string; sql: string; zone?: string }> = [
  ...MERGED_ROWS.flatMap((m) => [
    { name: `merged: ${m.name}, sorted by it`, sql: `SELECT ${m.list} ${m.from} ORDER BY ${m.key} NULLS FIRST, ${m.ties} LIMIT 6 OFFSET 1` },
    { name: `merged: ${m.name}, sorted by it DESC`, sql: `SELECT ${m.list} ${m.from} ORDER BY ${m.key} DESC NULLS LAST, ${m.ties} LIMIT 6` },
    { name: `merged: ${m.name}, a *, sorted by it`, sql: `SELECT * ${m.from} ORDER BY ${m.key} NULLS FIRST, ${m.ties} LIMIT 6` },
  ]),
  ...JOINS.flatMap(({ kind, join }) => {
    const from = `FROM top_m1 x ${join} top_m2 y USING (t)`, ties = "x.only1 NULLS FIRST, y.only2 NULLS FIRST";
    return [
      { name: `merged: a text ${kind}, the database's order`, sql: `SELECT t, x.only1, y.only2 ${from} ORDER BY t DESC NULLS LAST, ${ties} LIMIT 6` },
      { name: `merged: a text ${kind}, bytes`, sql: `SELECT t, x.only1, y.only2 ${from} ORDER BY t COLLATE "C", ${ties} LIMIT 6` },
      { name: `merged: a text ${kind}, ICU`, sql: `SELECT t, x.only1, y.only2 ${from} ORDER BY t COLLATE "und-x-icu" DESC, ${ties} LIMIT 6` },
      { name: `merged: a text ${kind}, the nulls idiom`, sql: `SELECT t, x.only1, y.only2 ${from} ORDER BY (t) IS NULL ASC, t DESC, ${ties} LIMIT 6` },
      { name: `merged: a timestamptz ${kind}, in a zone of daylight saving`, sql: `SELECT made, date_trunc('day', made) AS day, x.only1, y.only2 FROM top_m1 x ${join} top_m2 y USING (made) ORDER BY day DESC NULLS LAST, made, x.only1 NULLS FIRST, y.only2 NULLS FIRST LIMIT 6`, zone: "America/New_York" },
      { name: `merged: a timestamptz ${kind}, in another zone`, sql: `SELECT made, date_trunc('day', made) AS day, x.only1, y.only2 FROM top_m1 x ${join} top_m2 y USING (made) ORDER BY day DESC NULLS LAST, made, x.only1 NULLS FIRST, y.only2 NULLS FIRST LIMIT 6`, zone: "Asia/Kathmandu" },
    ];
  }),
  { name: "merged: a merged column in an expression of the list", sql: "SELECT id * 2 AS d, coalesce(y.only2, 'none') AS o, x.only1 FROM top_m1 x FULL JOIN top_m2 y USING (id) ORDER BY id NULLS FIRST LIMIT 5" },
  { name: "merged: the join's sides read apart from the merged column", sql: "SELECT id, x.id AS l, y.id AS r FROM top_m1 x FULL JOIN top_m2 y USING (id) ORDER BY l NULLS FIRST, r NULLS FIRST LIMIT 6" },
  { name: "merged: an output's name before the merged column", sql: "SELECT x.only1 AS id, y.only2 FROM top_m1 x FULL JOIN top_m2 y USING (id) ORDER BY id NULLS FIRST, 2 NULLS FIRST LIMIT 6" },
  { name: "merged: a WHERE on it", sql: "SELECT id, x.only1 FROM top_m1 x LEFT JOIN top_m2 y USING (id) WHERE id > 2 ORDER BY id DESC LIMIT 3" },
  { name: "merged: a view of a merging join, by its column", sql: "SELECT * FROM top_merged ORDER BY id NULLS FIRST, k NULLS FIRST, only1 NULLS FIRST LIMIT 6" },
  { name: "merged: a tool's wrapper of a *", sql: "SELECT * FROM (SELECT * FROM top_m1 x JOIN top_m2 y USING (id)) t ORDER BY id DESC LIMIT 3" },
  { name: "merged: a wrapper by the merged column", sql: "SELECT id, only2 FROM (SELECT id, y.only2 FROM top_m1 x FULL JOIN top_m2 y USING (id)) t ORDER BY t.id NULLS FIRST LIMIT 6" },
  { name: "merged: a WITH query of a merging join", sql: "WITH j AS (SELECT id, k, y.only2 FROM top_m1 x LEFT JOIN top_m2 y USING (id, k)) SELECT * FROM j ORDER BY id LIMIT 3" },
  { name: "merged: a derived side in the USING", sql: "SELECT id, d.two, x.only1 FROM top_m1 x FULL JOIN (SELECT id, k * 2 AS two FROM top_m4) d USING (id) ORDER BY id NULLS FIRST LIMIT 6" },
  { name: "merged: an aggregated side in the USING", sql: "SELECT id, s.n, x.only1 FROM top_m1 x FULL JOIN (SELECT id, count(*) AS n FROM top_m4 GROUP BY id) s USING (id) ORDER BY id NULLS FIRST LIMIT 6" },
  { name: "merged: a join's own alias stays as it was", sql: "SELECT j.id, x.only1 FROM (top_m1 x JOIN top_m4 z USING (id)) AS j ORDER BY j.id LIMIT 2" },
  { name: "merged: a table's whole row stays as it was", sql: "SELECT row_to_json(z), x.only1 FROM top_m1 x JOIN top_m4 z USING (id) ORDER BY x.id LIMIT 2" },
  // a NATURAL is the columns Postgres merged in every statement, not only one whose rows a LIMIT chooses (src/duck/rewrite.ts
  // `naturalWritten`): with none in common, DuckDB refused it
  { name: "natural: none in common, a count", sql: "SELECT count(*) FROM top_m1 x NATURAL JOIN top_m3 z" },
  { name: "natural: none in common, sorted, no LIMIT", sql: "SELECT id, z.y FROM top_m1 x NATURAL JOIN top_m3 z ORDER BY id, z.x" },
  ...["LEFT JOIN", "FULL JOIN"].flatMap((join) => [
    { name: `natural: none in common, ${join}, no LIMIT`, sql: `SELECT id, x.only1, z.x, z.y FROM top_m1 x NATURAL ${join} top_m3 z ORDER BY id NULLS FIRST, z.x NULLS FIRST` },
    { name: `natural: two columns in common, ${join}, no LIMIT`, sql: `SELECT id, k, x.only1, z.tail FROM top_m1 x NATURAL ${join} top_m4 z ORDER BY id NULLS FIRST, k NULLS FIRST, x.only1 NULLS FIRST, z.tail NULLS FIRST` },
    { name: `natural: two columns in common, ${join}, a *, no LIMIT`, sql: `SELECT * FROM top_m1 x NATURAL ${join} top_m4 z ORDER BY id NULLS FIRST, k NULLS FIRST, x.only1 NULLS FIRST, z.tail NULLS FIRST` },
  ]),
  { name: "natural: two columns in common, a count", sql: "SELECT count(*) FROM top_m1 x NATURAL FULL JOIN top_m4 z" },
];

/** each spelling of each kind sorted, so every byte of the answer is held: asked in the type matrix */
export const FROM_ITEMS_SORTED: ReadonlyArray<{ name: string; sql: string; zone?: string }> = [
  ...MERGED_SORTED,
  ...COMPUTED_KEYS,
  ...everySpelling().flatMap(({ s, k }) => {
    const { head, list, from } = spelledAs(s, k);
    // a key of the join's row, by its output names, whatever the spelling's list, NULLs placed alike
    return keysOver("id NULLS FIRST, d_id NULLS FIRST, a_id NULLS FIRST").map(({ key, order, zone }) => ({ name: `from items: ${s.spelled}, ${k.kind}, sorted by ${key}`, sql: `${head}SELECT ${list} ${from} ORDER BY ${order} LIMIT 6 OFFSET 2`, ...(zone !== undefined ? { zone } : {}) }));
  }),
  // the grouped view, by its output name, its ordinal and the qualified column, alone and joined
  { name: "from items: the grouped view ordered by its output name", sql: "SELECT a_id, twice AS total FROM top_sums ORDER BY total DESC NULLS LAST, a_id LIMIT 3" },
  { name: "from items: the grouped view ordered by its ordinal", sql: "SELECT a_id, twice AS total FROM top_sums ORDER BY 2, 1 LIMIT 3" },
  { name: "from items: the grouped view joined, by its output name", sql: "SELECT a.id, s.twice AS total FROM top_a a LEFT JOIN top_sums s ON s.a_id = a.id ORDER BY total DESC NULLS LAST, a.id LIMIT 3" },
  { name: "from items: the grouped view joined, by its ordinal", sql: "SELECT a.id, s.twice AS total FROM top_a a LEFT JOIN top_sums s ON s.a_id = a.id ORDER BY 2, 1 LIMIT 3" },
  { name: "from items: the grouped view joined, by the qualified column", sql: "SELECT a.id, a.note, s.twice AS total FROM top_a a LEFT JOIN top_sums s ON s.a_id = a.id ORDER BY s.twice, a.id LIMIT 3" },
  { name: "from items: a view of a view of a join", sql: "SELECT * FROM top_join_twice ORDER BY id NULLS FIRST, d_id NULLS FIRST LIMIT 6" },
  { name: "from items: a wrapper's column of a repeated name, by a *", sql: "SELECT * FROM (SELECT a.made, a.id, b.id, a.id + b.id AS sum FROM top_a a JOIN top_b b ON b.a_id = a.id) t ORDER BY sum, made NULLS FIRST LIMIT 3" },
  { name: "from items: a wrapper's output name before its column", sql: "SELECT id AS name FROM (SELECT a.id, b.id AS b, a.name FROM top_a a JOIN top_b b ON b.a_id = a.id) t ORDER BY name DESC, b DESC LIMIT 3" },
  { name: "from items: a wrapper's WHERE beside its join's", sql: "SELECT * FROM (SELECT a.id, b.id AS b, b.amount FROM top_a a JOIN top_b b ON b.a_id = a.id WHERE a.id > 1 OR b.id = 1) t WHERE t.amount > 5 OR t.b < 3 ORDER BY id, b LIMIT 3" },
  { name: "from items: a derived list's value read twice", sql: `SELECT a.id, d.twice, d.twice + 1 AS more FROM top_a a LEFT JOIN (${SIDE}) d ON d.a_id = a.id WHERE d.twice IS NULL OR d.twice > 2 ORDER BY d.twice DESC NULLS LAST, a.id, d.id LIMIT 4` },
  { name: "from items: a volatile derived list, carried", sql: "SELECT a.id, d.id AS d, d.r < 2 AS r FROM top_a a JOIN (SELECT b.id, b.a_id, random() AS r FROM top_b b) d ON d.a_id = a.id ORDER BY a.id, d.id LIMIT 4" },
  { name: "from items: a volatile derived WHERE, carried", sql: "SELECT a.id, d.id AS d FROM top_a a JOIN (SELECT b.id, b.a_id FROM top_b b WHERE random() < 2) d ON d.a_id = a.id ORDER BY a.id, d.id LIMIT 4" },
  { name: "from items: a side with a column named rowid", sql: "SELECT a.id, r.rowid, r.a FROM top_a a JOIN (SELECT id, a_id, rowid, 1 AS a FROM top_r) r ON r.a_id = a.id ORDER BY a.id, r.id LIMIT 3" },
  { name: "from items: a derived output named rowid", sql: "SELECT a.id, d.rowid FROM top_a a JOIN (SELECT b.a_id, b.id AS rowid FROM top_b b) d ON d.a_id = a.id ORDER BY a.id, d.rowid LIMIT 3" },
  { name: "from items: two outputs of one name but for case", sql: `SELECT d."N", d.n FROM top_a a JOIN (SELECT b.a_id, b.id AS "N", b.id + 1 AS n FROM top_b b) d ON d.a_id = a.id ORDER BY a.id, d."N" LIMIT 3` },
  { name: "from items: a LATERAL read", sql: "SELECT a.id, d.c FROM top_a a, LATERAL (SELECT count(*) AS c FROM top_b b WHERE b.a_id = a.id) d ORDER BY a.id LIMIT 3" },
];

export const UNORDERED_LIMITS: UnorderedLimit[] = [...JOINED_TABLES, ...FROM_ITEMS_UNORDERED, ...MERGED_UNORDERED,
  // a key that decides nothing the oracle can compare: the rows are rows of the whole join
  u("random() as the only key", "a.id, b.id AS b", COMPUTED_FROM, "ORDER BY random() LIMIT 4", { whole: COMPUTED_FROM }),
  u("random() by a name, shown as no value", "a.id, b.id AS b, random() * 0 AS r", COMPUTED_FROM, "ORDER BY r LIMIT 4", { whole: COMPUTED_FROM }),
];

/** a filtered user's reads (oracle/row-filters.ts): a filtered read is a subquery by now, and stays as it was */
export const UNORDERED_ROW_SHAPES: UnorderedLimit[] = [
  u("two filtered tables", "o.id, c.name, c.tenant_id", "FROM shop.orders o LEFT JOIN shop.customers c ON c.id = o.customer_id", "LIMIT 7"),
  u("three, paged by an offset", "i.id, o.status, c.name", "FROM shop.order_items i JOIN shop.orders o ON o.id = i.order_id JOIN shop.customers c ON c.id = o.customer_id", "LIMIT 5 OFFSET 3"),
  u("a wrapper of two filtered tables", "*", "FROM (SELECT o.id, c.name, c.tenant_id FROM shop.orders o LEFT JOIN shop.customers c ON c.id = o.customer_id) t", "LIMIT 7"),
  u("a plain derived read of a filtered table", "o.id, d.name", "FROM shop.orders o LEFT JOIN (SELECT id, upper(name) AS name FROM shop.customers) d ON d.id = o.customer_id", "LIMIT 7"),
  u("a WITH query of a filtered table", "o.id, w.name", "FROM shop.orders o JOIN w ON w.id = o.customer_id", "LIMIT 7", { head: "WITH w AS (SELECT id, name FROM shop.customers) " }),
  u("a view joined to a filtered table", "p.id, c.name", "FROM shop.paid_orders p JOIN shop.customers c ON c.id = p.customer_id", "LIMIT 7"),
  u("a USING of a filtered table", "id, c.name, o.status", "FROM shop.orders o JOIN shop.customers c USING (id)", "LIMIT 7"),
  u("a computed key over a filtered table", "o.id, c.name, upper(c.name) AS shout", "FROM shop.orders o LEFT JOIN shop.customers c ON c.id = o.customer_id", "ORDER BY shout LIMIT 7"),
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
