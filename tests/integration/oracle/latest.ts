/**
 * `latest(x ORDER BY a [, b …])`, THE AGGREGATE MASON ADDS (src/api/postgres/catalog.ts masonAggregatesSql, declared in
 * the oracle's Postgres from that same list): each statement over `latest_t`, whose every column holds NULLs and whose a
 * ties within a group, `latest_e`, empty, and `latest_g`, a group's label. Every statement here ends its ORDER BY in
 * `id`, so no tie is left to the scan: Postgres defines no pick among tied rows, and a statement held row for row must
 * not ask for one (tests/duck-wire.test.ts holds a tie to ANY of the tied rows). The names start `latest:`, so
 * `IT_ORACLE_ONLY=latest` runs them and the gap cases of `latest-*`.
 */

export const LATEST_TABLES = ["latest_t", "latest_e", "latest_g"];

export const LATEST_DDL = `
CREATE TABLE public.latest_t (id int PRIMARY KEY, g int, a int, b int, n numeric(12,2), ts timestamp, tz timestamptz, d date, s text, j jsonb, ok boolean);
INSERT INTO public.latest_t VALUES
  (1, 1, 1, 10, 1.50, '2026-01-01 00:00', '2026-01-01 00:00+00', '2026-01-01', 'b', '{"k": 1}', true),
  (2, 1, 3, 20, 2.25, '2026-01-03 00:00', '2026-01-03 00:00+00', '2026-01-03', 'a', '[1, 2]', false),
  (3, 1, NULL, 30, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (4, 1, 3, NULL, 9.99, '2026-01-02 00:00', '2026-01-02 00:00+00', '2026-01-02', 'B', '"x"', true),
  (5, 2, 2, 5, 0.10, '2025-12-31 00:00', '2025-12-31 00:00+00', '2025-12-31', 'c', 'null', true),
  (6, 2, 2, 6, 0.10, '2025-12-31 00:00', '2025-12-31 00:00+00', '2025-12-31', 'C', '{"k": 2}', false),
  (7, 2, 1, NULL, 3.00, '2024-02-29 12:00', '2024-02-29 12:00+00', '2024-02-29', 'é', '{}', NULL),
  (8, 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (9, 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
  (10, NULL, 5, 50, 5.00, '2026-05-05 00:00', '2026-05-05 00:00+00', '2026-05-05', 'z', '1', true),
  (11, 4, 7, 70, 7.00, '2026-07-07 00:00', '2026-07-07 00:00+00', '2026-07-07', 'Z', '2', false),
  (12, 4, 7, 71, 7.10, '2026-07-07 00:00', '2026-07-07 00:00+00', '2026-07-07', 'Z', '2', false);
CREATE TABLE public.latest_e (LIKE public.latest_t INCLUDING ALL);
CREATE TABLE public.latest_g (g int PRIMARY KEY, label text);
INSERT INTO public.latest_g VALUES (1, 'one'), (2, 'two'), (3, 'three'), (4, 'four');
`;

const G = "FROM latest_t GROUP BY g ORDER BY g";
const KEYS = ["a", "n", "ts", "tz", "d", "s", 's COLLATE "C"'];
const VALUES = ["a", "n", "ts", "tz", "d", "s", "j", "ok"];

export const LATEST_SHAPES: Array<{ name: string; sql: string }> = [
  { name: "latest: ascending, a NULL key last", sql: `SELECT g, latest(s ORDER BY a, id) ${G}` },
  { name: "latest: descending, a NULL key first", sql: `SELECT g, latest(s ORDER BY a DESC, id) ${G}` },
  { name: "latest: NULLS FIRST and DESC NULLS LAST", sql: `SELECT g, latest(s ORDER BY a NULLS FIRST, id), latest(s ORDER BY a DESC NULLS LAST, id) ${G}` },
  { name: "latest: mixed directions", sql: `SELECT g, latest(s ORDER BY a ASC, id DESC) ${G}` },
  ...KEYS.map((k) => ({ name: `latest: every value by ${k}`, sql: `SELECT g, ${VALUES.map((x) => `latest(${x} ORDER BY ${k}, id)`).join(", ")} ${G}` })),
  ...KEYS.map((k) => ({ name: `latest: every value by ${k} DESC`, sql: `SELECT g, ${VALUES.map((x) => `latest(${x} ORDER BY ${k} DESC, id)`).join(", ")} ${G}` })),
  { name: "latest: the outer ORDER BY on its output name", sql: "SELECT g, latest(b ORDER BY a, id) AS s FROM latest_t GROUP BY g ORDER BY s, g" },
  { name: "latest: in HAVING", sql: "SELECT g FROM latest_t GROUP BY g HAVING latest(b ORDER BY a, id) > 0 ORDER BY g" },
  { name: "latest: FILTER", sql: "SELECT g, latest(b ORDER BY a, id) FILTER (WHERE ok) FROM latest_t GROUP BY g ORDER BY g" },
  { name: "latest: in a subquery", sql: "SELECT * FROM (SELECT g, latest(b ORDER BY a, id) AS l FROM latest_t GROUP BY g) q ORDER BY g" },
  { name: "latest: in a CTE", sql: "WITH q AS (SELECT g, latest(b ORDER BY a, id) AS l FROM latest_t GROUP BY g) SELECT * FROM q ORDER BY g" },
  { name: "latest: over a join", sql: "SELECT g, latest(label ORDER BY a, id), latest(b ORDER BY a DESC, id) FROM latest_t JOIN latest_g USING (g) GROUP BY g ORDER BY g" },
  { name: "latest: beside other aggregates", sql: "SELECT g, count(*), max(a), latest(b ORDER BY a, id), sum(n) FROM latest_t GROUP BY g ORDER BY g" },
  { name: "latest: an empty table", sql: "SELECT latest(b ORDER BY a, id) FROM latest_e" },
  { name: "latest: no row", sql: "SELECT latest(b ORDER BY a, id) FROM latest_t WHERE false" },
  { name: "latest: a group all NULL", sql: "SELECT latest(b ORDER BY a, id), latest(b ORDER BY a DESC, id) FROM latest_t WHERE g = 3" },
  { name: "latest: DISTINCT", sql: "SELECT latest(DISTINCT b ORDER BY b) FROM latest_t" },
  // and a numeric whose rows' scales differ (a coalesce or a CASE of n and a literal), at the picked row's scale: 0
  // where the literal 0 was taken, never n's 0.00 (PR 274's review, round 1), in both rewrites; NULL where a FILTER
  // keeps no row of a group (g 3), never the coalesce of no row's n
  { name: "latest: wrapped (* 2, coalesce, round), and of a coalesce or a CASE over a literal", sql: "SELECT g, latest(n ORDER BY a, id) * 2, coalesce(latest(b ORDER BY a DESC, id), 0), round(latest(n ORDER BY ts, id), 1), latest(coalesce(n, 0) ORDER BY a, id), latest(CASE WHEN ok THEN n ELSE 0 END ORDER BY a, id), latest(coalesce(n, 1.5) ORDER BY a DESC, id), latest(coalesce(n, 0) ORDER BY a, id) FILTER (WHERE ok) FROM latest_t GROUP BY g ORDER BY g" },
  { name: "latest: a scalar subquery", sql: "SELECT o.g, (SELECT latest(b ORDER BY a, id) FROM latest_t i WHERE i.g = o.g) FROM latest_g o ORDER BY o.g" },
  { name: "latest: each operand, then divided (latest-computed-numeric's way out)", sql: "SELECT g, latest(n ORDER BY a, id) / latest(3 ORDER BY a, id) FROM latest_t GROUP BY g ORDER BY g" },
];
