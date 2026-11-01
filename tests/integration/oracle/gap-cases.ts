/**
 * One statement for each entry of src/duck/gaps.ts that nothing else the oracle asks meets: so every refusal and
 * decided difference the registry lists is one the oracle has watched happen (a refusal naming its gap, or the
 * KNOWN difference), and an entry Mason no longer has fails the oracle as dead. Over `typed`
 * (oracle/type-matrix.ts) and `one`.
 */
import type { GapId } from "../../../src/duck/gaps.ts";

export const GAP_CASES: Array<{ gap: GapId; sql: string }> = [
  { gap: "fromless-text-order", sql: "SELECT 'a' < 'B'" },
  { gap: "libc-mark-run-form", sql: "SELECT 'a6ß' > E'a\\u03086ß' FROM public.one" },
  { gap: "libc-rare-letter", sql: "SELECT E'\\uA79A' < E'\\u00C4' FROM public.one" },
  { gap: "explain-option", sql: "EXPLAIN (FORMAT XML) SELECT id FROM typed" },
  // is_local: Postgres's change ends with the statement's own transaction, so the session's state is the same after
  { gap: "set-config-forms", sql: "SELECT set_config('application_name', 'gap-case', true) FROM public.one" },
  { gap: "star-join-twin", sql: "SELECT j.* FROM (star_o a FULL JOIN star_b b USING (name)) AS j ORDER BY 1 NULLS FIRST, 2, 8" },
  { gap: "setop-ordinal-star", sql: "SELECT *, t FROM (SELECT id, t FROM typed) s UNION SELECT id, t, t FROM typed ORDER BY 2, 1" },
  { gap: "with-ties-distinct", sql: "SELECT DISTINCT i4 FROM typed ORDER BY i4 FETCH FIRST 2 ROWS WITH TIES" },
  { gap: "collation-unknown", sql: "SELECT id FROM typed ORDER BY t COLLATE \"en_US.utf8\", id" },
  { gap: "like-any-array", sql: "SELECT id FROM typed WHERE t LIKE ANY (at) ORDER BY id" },
  { gap: "similar-to-forms", sql: "SELECT id FROM typed WHERE t SIMILAR TO vc ORDER BY id" },
  { gap: "array-remove-type", sql: "SELECT id, array_remove(ARRAY[iv], iv) FROM typed ORDER BY id" },
  { gap: "json-agg-distinct", sql: "SELECT json_agg(DISTINCT i4) FROM typed WHERE id < 100" },
  { gap: "json-rows-in-select", sql: "SELECT jsonb_array_elements('[1, 2]'::jsonb) FROM public.one" },
  { gap: "regexp-flags", sql: "SELECT id, regexp_replace(t, 'a', 'x', 1, 1) FROM typed ORDER BY id" },
  { gap: "regexp-functions", sql: "SELECT id, regexp_count(t, 'a') FROM typed ORDER BY id" },
  { gap: "regexp-matches-forms", sql: "SELECT id, m FROM typed, regexp_matches(t, '(a)(b)') AS m ORDER BY id" },
  { gap: "json-of-type", sql: "SELECT id, to_json(ARRAY[iv]) FROM typed ORDER BY id" },
  { gap: "extract-julian", sql: "SELECT id, extract(julian FROM d) FROM typed WHERE id < 100 ORDER BY id" },
  { gap: "with-ordinality", sql: "SELECT id, e, k FROM typed, jsonb_array_elements(jb) WITH ORDINALITY AS x(e, k) WHERE jsonb_typeof(jb) = 'array' ORDER BY id, k" },
  { gap: "format-specifiers", sql: "SELECT id, format('%I', t) FROM typed ORDER BY id" },
  { gap: "to-timestamp-format", sql: "SELECT id, to_date('2026-01-01', t) FROM typed WHERE false" },
  { gap: "percentile-text-libc", sql: "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY t) FROM typed" },
  { gap: "div-numeric", sql: "SELECT id, div(n, 3) FROM typed WHERE id < 100 ORDER BY id" },
  { gap: "width-bucket-forms", sql: "SELECT id, width_bucket(i4, ARRAY[0, 10, 100]) FROM typed ORDER BY id" },
  { gap: "relative-time-literal", sql: "SELECT id FROM typed WHERE ts < 'today 12:00' ORDER BY id" },
  { gap: "bytea-forms", sql: "SELECT id, convert_to(t, 'LATIN1') FROM typed WHERE id < 3 ORDER BY id" },
  { gap: "infinite-interval", sql: "SELECT id, s::interval FROM castable WHERE id = 32" },
  { gap: "numeric-math", sql: "SELECT id, ln(n2 ^ 2) FROM typed WHERE n2 > 0 ORDER BY id" },
  { gap: "view-forms", sql: "SELECT happy FROM happy" },
  { gap: "enum-forms", sql: "SELECT id, t::text::mood[] FROM moods WHERE false" },
  { gap: "numeric-exact-sum", sql: "SELECT sum(s::numeric) FROM castable WHERE id IN (71, 79)" },
  { gap: "jsonb-compare", sql: "SELECT id, greatest(jb, '1') FROM typed ORDER BY id" },
  { gap: "held-type-compare", sql: "SELECT id FROM mapped ORDER BY mc, id" },
  // the decided differences (KNOWN in duck-oracle.itest.ts)
  { gap: "domain-column", sql: "SELECT pg_typeof(di)::text FROM mapped LIMIT 1" },
  { gap: "limit-errors", sql: "SELECT l.id, (l.j ->> 'n')::int, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.k DESC LIMIT 3" },
  { gap: "limit-errors", sql: "SELECT c.id, d.id AS d, d.n FROM late_c c JOIN (SELECT l.id, l.k, l.c, (l.j ->> 'n')::int AS n FROM late l) d ON d.c = c.id ORDER BY d.k DESC LIMIT 3" },
  { gap: "limit-errors", sql: "SELECT * FROM (SELECT l.id, (l.j ->> 'n')::int AS n, l.k, c.name FROM late l JOIN late_c c ON c.id = l.c) t ORDER BY t.k DESC LIMIT 3" },
  { gap: "limit-errors", sql: "SELECT a.id, (SELECT 1 / (a.id - 7)) AS x FROM top_a a LEFT JOIN top_b b ON b.a_id = a.id ORDER BY a.name, a.id, b.id LIMIT 2" },
  // a DISTINCT ON's list: row 2000's 'x' is in c = 0's group but not its first row (issue 134, task E)
  { gap: "limit-errors", sql: "SELECT DISTINCT ON (l.c) l.c, l.id, (l.j ->> 'n')::int AS n FROM late l ORDER BY l.c, l.id LIMIT 3" },
  { gap: "volatile-window", sql: "SELECT id, row_number() OVER (PARTITION BY b ORDER BY random()) FROM typed" },
  { gap: "min-max-scale-tie", sql: "SELECT min(a / b), max(a / b) FROM public.one, (VALUES (0::numeric, 7::numeric), (0, 1000000)) AS v(a, b)" },
  { gap: "nested-exact-numeric", sql: "SELECT x * 2 FROM (SELECT 7 / 3.0 AS x FROM public.one) AS s" },
  { gap: "unicode-16-case", sql: "SELECT upper('\u{10D70}'), lower('\u{10D50}') FROM public.one" },
  // the session's own statement (Postico's connect): its fields and the rows the sessions set are held alike (KNOWN's `holds`)
  { gap: "show-all", sql: "SHOW ALL" },
];
