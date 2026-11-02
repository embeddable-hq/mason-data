/**
 * latest(x ORDER BY …), the aggregate Mason adds (src/api/postgres/catalog.ts LATEST_SQL; src/duck/rewrite.ts `latest`):
 * its tables and its statements, each held to the real Postgres, which is given the same declaration. A tie under the
 * ORDER BY has no defined pick in Postgres, so every statement here breaks its ties (`…, id`) but one, which asks
 * whether the answer is ONE of the tied rows' values (true on both sides), never which.
 */

/** latest_t holds NULLs in every column, ties in a within each group, a group (g = 9) whose a and b are all NULL, and
 *  a NULL g; latest_e is empty; latest_t2 is joined USING (g) */
export const LATEST_SCHEMA = `
CREATE TABLE public.latest_t (id int PRIMARY KEY, g int, a int, b int, n numeric(12,2), ts timestamp, tz timestamptz, d date, s text, j jsonb, ok boolean);
INSERT INTO public.latest_t SELECT i, CASE WHEN i % 13 = 0 THEN NULL ELSE i % 4 END,
  CASE WHEN i % 7 = 0 THEN NULL ELSE (i * 37) % 11 END,
  CASE WHEN i % 5 = 0 THEN NULL ELSE (i * 13) % 17 - 5 END,
  CASE WHEN i % 6 = 0 THEN NULL ELSE ((i * 29) % 23)::numeric / 4 END,
  CASE WHEN i % 8 = 0 THEN NULL ELSE timestamp '2024-01-01' + ((i * 79) % 100) * interval '1 hour' END,
  CASE WHEN i % 9 = 0 THEN NULL ELSE timestamptz '2024-01-01 00:00+00' + ((i * 53) % 90) * interval '1 hour' END,
  CASE WHEN i % 10 = 0 THEN NULL ELSE date '2024-01-01' + (i * 17) % 40 END,
  (ARRAY['apple', 'Apple', 'banana', ' b', 'Zed', 'éclair', 'a-b', 'ab', NULL])[i % 9 + 1],
  (ARRAY['{"a": 1}', '[1, 2]', '"x"', '3', 'null', NULL, '{"b": [1]}'])[i % 7 + 1]::jsonb,
  CASE WHEN i % 11 = 0 THEN NULL ELSE i % 3 = 0 END
FROM generate_series(1, 80) i;
INSERT INTO public.latest_t (id, g) VALUES (101, 9), (102, 9), (103, 9);
CREATE TABLE public.latest_e (id int PRIMARY KEY, g int, a int, b int, n numeric(12,2), ts timestamp, tz timestamptz, d date, s text, j jsonb, ok boolean);
CREATE TABLE public.latest_t2 (g int PRIMARY KEY, label text);
INSERT INTO public.latest_t2 VALUES (0, 'zero'), (1, 'one'), (2, 'two'), (3, 'three');
`;

export const LATEST_TABLES = ["latest_t", "latest_e", "latest_t2"];

function* cases(): Generator<string> {
  const t = "latest_t";
  yield `SELECT g, latest(s ORDER BY a, id) FROM ${t} GROUP BY g ORDER BY g`;
  yield `SELECT g, latest(s ORDER BY a DESC, id) FROM ${t} GROUP BY g ORDER BY g`;
  yield `SELECT g, latest(s ORDER BY a NULLS FIRST, id), latest(s ORDER BY a DESC NULLS LAST, id) FROM ${t} GROUP BY g ORDER BY g`;
  yield `SELECT g, latest(s ORDER BY a ASC, id DESC) FROM ${t} GROUP BY g ORDER BY g`;
  yield `SELECT g, latest(s ORDER BY a, id NULLS FIRST) FROM ${t} GROUP BY g ORDER BY g`;
  for (const k of ["a", "n", "ts", "tz", "d", "s", `s COLLATE "C"`, "j", "ok"]) {
    for (const x of ["a", "n", "ts", "tz", "d", "s", "j", "ok"]) yield `SELECT g, latest(${x} ORDER BY ${k}, id) FROM ${t} GROUP BY g ORDER BY g`;
    yield `SELECT g, latest(id ORDER BY ${k} DESC, id) FROM ${t} GROUP BY g ORDER BY g`;
  }
  yield `SELECT g, latest(b ORDER BY a, id) AS s FROM ${t} GROUP BY g ORDER BY s, g`;
  yield `SELECT g FROM ${t} GROUP BY g HAVING latest(b ORDER BY a, id) > 0 ORDER BY g`;
  yield `SELECT g, latest(b ORDER BY a, id) FILTER (WHERE ok), latest(b ORDER BY a DESC, id) FILTER (WHERE ok) FROM ${t} GROUP BY g ORDER BY g`;
  yield `SELECT * FROM (SELECT g, latest(b ORDER BY a, id) AS l FROM ${t} GROUP BY g) q ORDER BY g`;
  yield `WITH q AS (SELECT g, latest(b ORDER BY a, id) AS l FROM ${t} GROUP BY g) SELECT * FROM q ORDER BY g`;
  yield `SELECT g, label, latest(b ORDER BY a, id) FROM ${t} JOIN latest_t2 USING (g) GROUP BY g, label ORDER BY g`;
  yield `SELECT g, count(*), max(a), latest(b ORDER BY a, id), sum(n) FROM ${t} GROUP BY g ORDER BY g`;
  yield `SELECT latest(b ORDER BY a, id), latest(b ORDER BY a DESC, id) FROM latest_e`;
  yield `SELECT latest(b ORDER BY a, id) FROM ${t} WHERE false`;
  yield `SELECT g, latest(b ORDER BY a, id), latest(b ORDER BY a DESC, id) FROM ${t} WHERE g = 9 GROUP BY g`;
  // ties in a: the answer is one of the tied rows' b (those whose a is the group's last: NULL where any is)
  yield `SELECT q.g, EXISTS (SELECT 1 FROM ${t} r WHERE r.g IS NOT DISTINCT FROM q.g AND r.b IS NOT DISTINCT FROM q.l AND r.a IS NOT DISTINCT FROM q.top) ` +
    `FROM (SELECT g, latest(b ORDER BY a) AS l, CASE WHEN count(*) > count(a) THEN NULL ELSE max(a) END AS top FROM ${t} GROUP BY g) q ORDER BY q.g`;
  yield `SELECT latest(DISTINCT b ORDER BY b) FROM ${t}`;
  yield `SELECT g, latest(DISTINCT s ORDER BY s DESC) FROM ${t} GROUP BY g ORDER BY g`;
  // Postgres's own refusal: an aggregate's ORDER BY under OVER
  yield `SELECT id, latest(b ORDER BY a, id) OVER (PARTITION BY g ORDER BY id) FROM ${t} ORDER BY id`;
  yield `SELECT latest(b ORDER BY a, id) * 2, coalesce(latest(n ORDER BY a, id), 0), round(latest(n ORDER BY ts, id), 1) FROM ${t}`;
  yield `SELECT g, latest(n ORDER BY a, id) / latest(b ORDER BY a, id) FROM ${t} GROUP BY g ORDER BY g`;
  yield `SELECT g, (SELECT latest(b ORDER BY a, id) FROM ${t} i WHERE i.g = o.g) FROM latest_t2 o ORDER BY g`;
  yield `SELECT g, latest(s ORDER BY lower(s), id), latest(upper(s) ORDER BY s DESC NULLS LAST, id) FROM ${t} GROUP BY g ORDER BY g`;
  yield `SELECT pg_catalog.latest(b ORDER BY a, id) FROM ${t}`;
  // the engine's own functions stay the engine's: a client naming one meets Postgres's 42883, as before
  yield `SELECT arg_max_null(b, a) FROM ${t}`;
  yield `SELECT last(b ORDER BY a) FROM ${t}`;
}

export const LATEST_CASES: Array<{ name: string; sql: string }> = [...cases()].map((sql) => ({ name: `latest: ${sql.slice(0, 100)}`, sql }));
