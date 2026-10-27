/**
 * THE POSTGRES DIALECT CASES: the expressions over edge-case literals (`CASES`) and the whole statements over literal
 * rows (`QUERY_CASES`, `REFUSED_CASES`) that tests/integration/duck-oracle.itest.ts holds the Postgres endpoint to, as
 * written (the endpoint runs a customer's Postgres SQL unchanged). Each case says why it is here.
 */

/** Postgres expressions over literals: NULL, '', non-ASCII text, negatives, boundaries. */
export const CASES: string[] = [
  // strings
  "lower('ÄB')", "upper('äbc')", "lower('ÉCOLE')", "length('ä')", "length('')", "length(NULL::text)",
  "trim('  a b  ')", "trim(both 'x' from 'xxaxx')", "ltrim(' a ')", "rtrim(' a ')", "trim(leading 'x' from 'xxaxx')",
  "substring('héllo', 2, 3)", "substring('héllo' from 2)", "substring('abc', 2, 0)", "substring('abc', 5, 2)", "substring(NULL::text, 1, 2)",
  // a regular expression's FIRST group (a BI tool's domain of an email), of a varchar, compared in a CASE
  "substring(('ab@ex.com')::varchar from ('@(.*)'))", "substring('a@b@c' from '@(.*)')", "substring('abc' from '(b)(c)')", "substring('abc' from 'z(.)')", "substring(NULL::varchar from '@(.*)')",
  "CASE WHEN ((substring(('x@ex.com')::varchar from ('@(.*)')))::varchar) = ('ex.com') THEN ('x') ELSE ('y') END", "CASE WHEN substring('nope'::varchar from '@(.*)')::varchar = 'ex.com' THEN 'x' ELSE 'y' END",
  "substring(ltrim('  {\"a\": 1}'::json::text), 1, 1)", "substring(ltrim('[1]'::jsonb::text), 1, 1) = '{'",
  "position('l' in 'hello')", "position('z' in 'hello')", "strpos('héllo', 'l')", "position('' in 'abc')",
  "replace('aXbX', 'X', 'yy')", "replace('abc', '', 'x')",
  "split_part('use-filter', '-', 1)", "split_part('use-filter', '-', 2)", "split_part('use-filter', '-', 3)", "split_part('a-b-c', '-', -1)", "split_part('', '-', 1)",
  "left('héllo', 2)", "left('abc', -1)", "right('héllo', 2)", "right('abc', -1)", "reverse('ab')", "repeat('ab', 2)", "repeat('ab', 0)",
  "starts_with('hello', 'he')", "starts_with('hello', '')", "md5('a')", "md5('')",
  "'a' || 'b' || 'c'", "'a' || NULL", "'a' || 1", "concat('a', NULL, 1)", "concat(NULL, NULL)",
  "'x' <> ''", "'' = ''", "NULL::text = 'a'", "'a' = 'a'", "'ä' = 'ä'",
  "'a' LIKE '_'", "'ä' LIKE '_'", "'aä' LIKE 'a_'", "'a%b' LIKE 'a\\%b'", "'a_b' LIKE 'a\\_b'", "'axb' LIKE 'a\\_b'", "'ABC' ILIKE 'abc'", "'Ä' ILIKE 'ä'", "'x' NOT LIKE 'y%'", "NULL::text LIKE 'a'",
  "'ab' IN ('ab', 'cd')", "'zz' NOT IN ('ab')", "NULL::text IN ('a')", "1 IN (1, 2)", "3 NOT IN (1, 2)",
  "nullif('', '')", "nullif('a', '')", "nullif(1, 1)", "coalesce(NULL::text, '', 'x')", "coalesce(NULL::int, 3)", "coalesce(NULL::text, NULL::text)",
  "greatest(1, NULL, 3)", "least(1, NULL, 3)", "greatest('a', 'b')", "least(2.5, 1)",
  // booleans and CASE
  "true AND NULL", "false AND NULL", "true OR NULL", "false OR NULL", "NOT NULL::boolean", "NOT true",
  "NULL::boolean IS TRUE", "true IS TRUE", "false IS NOT TRUE", "NULL::boolean IS NOT TRUE", "false IS FALSE", "NULL::boolean IS UNKNOWN", "true IS NOT UNKNOWN",
  "1 IS DISTINCT FROM NULL", "NULL::int IS NOT DISTINCT FROM NULL::int", "1 IS DISTINCT FROM 1", "1 IS NOT DISTINCT FROM 2", "NULL::int IS DISTINCT FROM NULL::int",
  "CASE WHEN NULL THEN 1 ELSE 2 END", "CASE WHEN true THEN 'a' END", "CASE WHEN false THEN 'a' END",
  "CASE 2 WHEN 1 THEN 'one' WHEN 2 THEN 'two' ELSE 'other' END", "CASE NULL::int WHEN 1 THEN 'one' ELSE 'other' END",
  "CASE 2 WHEN '2' THEN 'two' ELSE 'other' END",
  "1 BETWEEN 1 AND 2", "3 NOT BETWEEN 1 AND 2", "NULL::int BETWEEN 1 AND 2", "1 BETWEEN NULL AND 3", "'b' BETWEEN 'a' AND 'c'",
  "1 = 1 AND (2 = 3 OR 4 = 4)", "NOT (1 = 1 AND NULL)",
  // numbers
  "7 / 2", "-7 / 2", "7 / -2", "7::int / 2", "7 / 2.0", "1 / 3.0", "7::float8 / 2", "10::numeric(10,2) / 4", "1::float8 / 0.5",
  "7 % 3", "-7 % 3", "7 % -3", "7.5 % 2", "mod(7, 3)", "mod(-7, 3)",
  "abs(-3)", "abs(-1.5)", "abs(NULL::int)", "floor(-1.5)", "floor(2.7)", "ceil(1.2)", "ceiling(-1.2)", "floor(2.7)::int", "ceil(2.1)::int",
  "power(2, 10)", "sqrt(16)", "ln(1)", "exp(0)",
  "1 + 2 * 3", "(1 + 2) * 3", "-(1 + 2)", "2 - -3", "1.5 + 1", "'12'::int + 1", "'1.5'::float8 * 2", "'3'::int8 * 2", "NULL::int + 1", "2 > 1", "1 = 1.0", "1 <> 2", "1 <= 1", "-1 < 0",
  "7::numeric(10,2)", "(-7)::int::numeric(10,1)", "7::int8::numeric(20,3) / 2",
  // casts
  "123::text", "true::text", "NULL::int::text", "(-1)::text", "'  x '::text",
  "'2024-01-07'::date", "'2024-01-07 23:30:00'::timestamptz", "'2024-01-07T23:30:00Z'::timestamptz", "'2024-01-07 23:30:00+02'::timestamptz",
  "'2024-01-07'::timestamptz", "'2024-01-07 23:30:00.123456'::timestamptz", "'2024-01-07 23:30:00'::timestamptz::date", "'2024-01-07'::date::text", "NULL::timestamptz",
  "'00000000-0000-0000-0000-000000000000'::uuid", "'0f6b7a52-1f6b-4c0e-9c3a-9d8e6f1a2b3c'::uuid", "'0F6B7A52-1F6B-4C0E-9C3A-9D8E6F1A2B3C'::uuid = '0f6b7a52-1f6b-4c0e-9c3a-9d8e6f1a2b3c'::uuid", "NULL::uuid",
  "'t'::bool", "'true'::bool", "'yes'::bool", "'0'::bool", "1::bool", "0::bool", "NULL::bool",
  "'42'::int", "'42'::int8", "'-7'::int2", "'1.5'::float8", "'1e3'::float8",
  // time
  "date_trunc('day', '2024-01-07 23:30:00'::timestamptz)", "date_trunc('week', '2024-01-07 23:30:00'::timestamptz)", "date_trunc('week', '2024-01-08 00:00:00'::timestamptz)",
  "date_trunc('month', '2024-01-07 23:30:00'::timestamptz)", "date_trunc('year', '2024-05-07 23:30:00'::timestamptz)", "date_trunc('hour', '2024-01-07 23:30:59'::timestamptz)",
  "date_trunc('minute', '2024-01-07 23:30:59.9'::timestamptz)", "date_trunc('quarter', '2024-05-07'::timestamptz)", "date_trunc('day', NULL::timestamptz)",
  "extract(year from '2024-03-07 12:00:00'::timestamptz)", "extract(month from '2024-03-07 12:00:00'::timestamptz)", "extract(day from '2024-03-07 12:00:00'::timestamptz)",
  "extract(hour from '2024-03-07 12:34:00'::timestamptz)", "extract(minute from '2024-03-07 12:34:00'::timestamptz)", "date_part('hour', '2024-03-07 12:34:00'::timestamptz)",
  "extract(dow from '2024-03-10 12:00:00'::timestamptz)", "extract(dow from '2024-03-11 12:00:00'::timestamptz)", "extract(dow from '2024-03-09 12:00:00'::timestamptz)",
  "extract(isodow from '2024-03-10 12:00:00'::timestamptz)", "extract(isodow from '2024-03-11 12:00:00'::timestamptz)", "extract(doy from '2024-03-10 12:00:00'::timestamptz)",
  "extract(quarter from '2024-05-10'::timestamptz)", "extract(week from '2024-01-07'::timestamptz)", "extract(week from '2024-12-30'::timestamptz)", "extract(week from '2021-01-01'::timestamptz)",
  "extract(epoch from '2024-01-01 00:00:01.5'::timestamptz)", "extract(epoch from '1969-12-31 23:59:59'::timestamptz)", "extract(epoch from '2024-01-07 23:30:00.123456'::timestamptz)",
  "extract(epoch from ('2024-01-02'::timestamptz - '2024-01-01'::timestamptz))", "extract(epoch from ('2024-01-01'::timestamptz - '2024-01-02 00:00:00.5'::timestamptz))",
  "extract(epoch from ('2024-01-01 00:00:01.25'::timestamptz - '2024-01-01'::timestamptz)) * 1000", "floor(extract(epoch from ('2024-01-01 00:00:01.25'::timestamptz - '2024-01-01'::timestamptz)) * 1000)::int",
  "extract(epoch from NULL::timestamptz)", "extract(epoch from '2024-01-07'::date)", "extract(year from '2024-03-07'::date)",
  "'2024-03-10 12:00:00'::timestamptz + interval '7 days'", "'2024-03-31 12:00:00'::timestamptz - interval '1 month'", "'2024-01-31 12:00:00'::timestamptz + interval '1 month'",
  "'2024-03-10 12:00:00'::timestamptz + 3 * interval '1 day'", "'2024-03-10 12:00:00'::timestamptz + interval '90 minutes'", "'2024-03-10 12:00:00'::timestamptz - interval '1 year'",
  "'2024-03-10 12:00:00'::timestamptz + interval '1 week'", "'2024-03-10 12:00:00'::timestamptz + interval '-1 hour'", "'2024-03-10 12:00:00'::timestamptz + interval '1500 milliseconds'",
  "'2024-01-01'::date + interval '1 day'", "'2024-01-05'::date - '2024-01-01'::date", "'2024-01-01'::date < '2024-01-02'::date", "'2024-01-01'::date = '2024-01-01 00:00:00'::timestamptz",
  // a timestamp difference beside an interval literal: the literal as seconds, in the Decimal the difference has
  "'2024-03-10 12:00:05'::timestamptz - '2024-03-10 12:00:01'::timestamptz < interval '1 second'", "'2024-03-10 12:00:05'::timestamptz - '2024-03-10 12:00:01'::timestamptz >= interval '4 seconds'",
  "'2024-03-10 13:30:00'::timestamptz - '2024-03-10 12:00:00'::timestamptz > interval '90 minutes'", "interval '2 hours' > '2024-03-10 13:30:00'::timestamptz - '2024-03-10 12:00:00'::timestamptz",
  "'2024-01-01 10:00:00'::timestamptz < '2024-01-01 11:00:00'::timestamptz", "'2024-01-01 10:00:00'::timestamptz = '2024-01-01 12:00:00+02'::timestamptz", "now() > '2024-01-01'::timestamptz", "current_date >= '2024-01-01'::date", "current_timestamp > '2024-01-01'::timestamptz",
  // JSON
  "'{\"a\":\"x\"}'::jsonb->>'a'", "'{\"a\":\"x\"}'::jsonb->>'missing'", "'{\"z\":null}'::jsonb->>'z'", "'{\"n\":1}'::jsonb->>'n'", "'{\"n\":-2.5}'::jsonb->>'n'", "'{\"b\":true}'::jsonb->>'b'",
  "'{\"a\":{\"b\":\"x\"}}'::jsonb->'a'->>'b'", "'{\"a\":{\"b\":\"x\"}}'::jsonb->'missing'->>'b'", "'{\"a\":\"é\"}'::jsonb->>'a'", "'{\"a\":\"\"}'::jsonb->>'a'",
  "'[\"x\",\"y\"]'::jsonb->>0", "'[\"x\",\"y\"]'::jsonb->>1", "'[\"x\",\"y\"]'::jsonb->>-1", "'[\"x\",\"y\"]'::jsonb->>5", "'[{\"_type\":\"FROM\"}]'::jsonb->0->>'_type'",
  "'{\"a\":\"x\"}'::jsonb->'a'", "'{\"a\":\"x\"}'::jsonb->'missing'", "NULL::jsonb->>'a'", "coalesce('{}'::jsonb->>'k', '')", "coalesce(NULL::jsonb->'a'->>'b', '')", "'{\"a\":\"x\"}'::jsonb->>'a' = 'x'",
  // numeric and round: Postgres's numeric rounds half away from zero on the decimal spelling
  "round(2.675, 2)", "round(0.125, 2)", "round(1.005, 2)", "round(-0.125, 2)", "round(42.875, 2)", "round(12345678.125, 2)", "round(2.5)", "round(-2.5)", "round(2.5, 0)",
  "round(NULL::numeric, 2)", "round(7::numeric / 2, 1)", "round(1e-7::numeric, 9)", "round(3.14159, 3)", "round(0.5)", "round(1.5)", "round(3::numeric / 100, 2)",
  "round(2.5::float8)", "round(3.5::float8)", "round(-2.5::float8)", "1234.5::numeric", "7::numeric / 2", "10 / 4.0", "1.5 * 2", "2.5 + 1", "3::numeric * 1.5",
  "length(E'a\\nb')", "replace(E'a\\nb', E'\\n', '|')", "replace(E'tab\\there', E'\\t', '|')", "E'q\\'s'", "'back\\slash'", "length('back\\slash')",
  // regular expressions (Postgres ARE -> RE2)
  "E'a\\nb' ~ 'a.b'", "E'a\\nb' ~ '[^x]b'", "E'a\\nb' ~ '^b'", "regexp_replace(E'a\\nb\\nc', 'a.*c', 'X')", "regexp_replace(E'x\\ny', '.', '-', 'g')",
  "'abc123' ~ '\\d+'", "'abc' ~ '\\d+'", "'ABC' ~* 'abc'", "'ABC' ~ 'abc'", "'abc' !~ 'x'", "'abc' !~* 'B'", "NULL::text ~ 'a'", "'naïve' ~ '^\\w+$'", "'na ve' ~ '^\\w+$'", "'a word here' ~ '\\yword\\y'", "'swordfish' ~ '\\yword\\y'",
  "regexp_replace('a1b22c333', '\\d+', 'N', 'g')", "regexp_replace('a1b22c333', '\\d+', 'N')", "regexp_replace('Hello World', 'o', '0', 'gi')", "regexp_replace('Hello', 'L', 'l', 'g')", "regexp_replace('Hello', 'L', 'l', 'gi')",
  "regexp_replace('abc', 'b', '[\\&]', 'g')", "regexp_replace('abc', '(b)', '<\\1>', 'g')", "regexp_replace('a.b.c', '\\.', '-', 'g')", "regexp_replace(NULL::text, 'a', 'b', 'g')", "regexp_replace('', 'a', 'b', 'g')",
  "regexp_replace('naïve café', '\\w+', 'W', 'g')", "regexp_replace('foo bar', '\\s+', ' ', 'g')", "regexp_replace('the word here', '\\yword\\y', 'X', 'g')", "regexp_replace('aaa', 'a*?', 'x', 'g')", "regexp_replace('a<b>c<d>e', '<.+?>', '', 'g')", "regexp_replace('a<b>c<d>e', '<.+>', '', 'g')",
  "regexp_replace('Error: Code 62. DB::Exception: x', '\\yCode \\d+\\y', 'Code N', 'g')", "regexp_replace('column \"foo\" of \"bar\"', '\"[^\"]*\"', '?', 'g')", "regexp_replace('x [1, 2] y', '\\[[^\\]]*\\]', '[]', 'g')",
  // JSON paths, types and constructors
  "'{\"a\":{\"b\":[10,20]}}'::jsonb #>> '{a,b,1}'", "'{\"a\":{\"b\":[10,20]}}'::jsonb #>> '{a,b,5}'", "'{\"a\":\"x\"}'::jsonb #>> '{a}'", "'\"str\"'::jsonb #>> '{}'", "'12'::jsonb #>> '{}'", "'null'::jsonb #>> '{}'", "'true'::jsonb #>> '{}'", "'{\"a\":\"x\"}'::jsonb->'a' #>> '{}'", "'{\"a\":null}'::jsonb->'a' #>> '{}'",
  "jsonb_typeof('{}'::jsonb)", "jsonb_typeof('[]'::jsonb)", "jsonb_typeof('\"s\"'::jsonb)", "jsonb_typeof('1'::jsonb)", "jsonb_typeof('1.5'::jsonb)", "jsonb_typeof('-1'::jsonb)", "jsonb_typeof('true'::jsonb)", "jsonb_typeof('null'::jsonb)", "jsonb_typeof(NULL::jsonb)", "jsonb_typeof('{\"a\":[1]}'::jsonb->'a')", "jsonb_typeof('{\"a\":[1]}'::jsonb->'missing')",
  "jsonb_typeof('{\"a\":[1]}'::jsonb->'a') = 'array'", "jsonb_build_array('{\"a\":\"x\"}'::jsonb->'a') #>> '{0}'", "jsonb_build_array('5'::jsonb) #>> '{0}'",
  // subqueries over set-returning JSON functions, as array pipelines
  "(SELECT count(*) FROM jsonb_array_elements('[1,2,3]'::jsonb) AS e)", "(SELECT count(*) FROM jsonb_array_elements('[]'::jsonb) AS e)", "(SELECT count(*) FROM jsonb_array_elements(NULL::jsonb) AS e)",
  "(SELECT count(*) FROM jsonb_array_elements_text('[\"a\",\"b\",null]'::jsonb) AS e)", "(SELECT count(e) FROM jsonb_array_elements_text('[\"a\",\"b\",null]'::jsonb) AS e)", "(SELECT count(DISTINCT e) FROM jsonb_array_elements_text('[\"a\",\"b\",\"a\",null]'::jsonb) AS e)",
  "(SELECT count(*) FROM jsonb_array_elements_text('[\"a\",\"\",\"b\"]'::jsonb) AS e WHERE e <> '')", "(SELECT count(DISTINCT lower(trim(e))) FROM jsonb_array_elements_text('[\" A \",\"a\",\"B\"]'::jsonb) AS e)",
  "(SELECT string_agg(e, ',' ORDER BY e) FROM jsonb_array_elements_text('[\"b\",\"a\",\"c\"]'::jsonb) AS e)", "(SELECT string_agg(DISTINCT e, ',' ORDER BY e) FROM jsonb_array_elements_text('[\"b\",\"a\",\"b\"]'::jsonb) AS e)", "(SELECT string_agg(e, ',') FROM jsonb_array_elements_text('[]'::jsonb) AS e)", "(SELECT string_agg(e, '|' ORDER BY e) FROM jsonb_array_elements_text('[\"x\",null,\"y\"]'::jsonb) AS e)",
  "(SELECT string_agg(e->>'k', ',' ORDER BY e->>'k') FROM jsonb_array_elements('[{\"k\":\"z\"},{\"k\":\"y\"}]'::jsonb) AS e)", "(SELECT string_agg(e #>> '{}', ',' ORDER BY e #>> '{}') FROM jsonb_array_elements('[1,\"s\",true,null]'::jsonb) AS e)",
  "(SELECT sum((e->>'n')::int) FROM jsonb_array_elements('[{\"n\":1},{\"n\":2}]'::jsonb) AS e)", "(SELECT sum((e->>'n')::int) FROM jsonb_array_elements('[]'::jsonb) AS e)", "(SELECT max(e) FROM jsonb_array_elements_text('[\"b\",\"a\"]'::jsonb) AS e)", "(SELECT min(e) FROM jsonb_array_elements_text('[]'::jsonb) AS e)",
  "(SELECT bool_or(e = 'a') FROM jsonb_array_elements_text('[\"b\",\"a\"]'::jsonb) AS e)", "(SELECT bool_and(e = 'a') FROM jsonb_array_elements_text('[\"b\",\"a\"]'::jsonb) AS e)", "(SELECT bool_or(e = 'a') FROM jsonb_array_elements_text('[]'::jsonb) AS e)",
  "(SELECT count(*) FROM jsonb_each('{\"a\":1,\"b\":[1,2]}'::jsonb) AS kv)", "(SELECT string_agg(kv.key, ',' ORDER BY kv.key) FROM jsonb_each('{\"b\":1,\"a\":2}'::jsonb) AS kv)", "(SELECT count(*) FROM jsonb_each('{\"a\":1,\"b\":[1,2]}'::jsonb) AS kv WHERE jsonb_typeof(kv.value) = 'array')",
  "(SELECT string_agg(kv.key || '=' || (v #>> '{}'), ',' ORDER BY kv.key || '=' || (v #>> '{}')) FROM jsonb_each('{\"ws\":[\"b\",\"a\"],\"u\":\"1\",\"n\":5}'::jsonb) AS kv CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(kv.value) = 'array' THEN kv.value ELSE jsonb_build_array(kv.value) END) AS v)",
  "(SELECT string_agg(DISTINCT kv.key || '=' || (v #>> '{}'), ',' ORDER BY kv.key || '=' || (v #>> '{}')) FROM jsonb_each('{\"a\":[\"x\",\"x\"]}'::jsonb) AS kv CROSS JOIN LATERAL jsonb_array_elements(kv.value) AS v)",
  "(SELECT string_agg(kv.key, ',' ORDER BY kv.key) FROM jsonb_each('{}'::jsonb) AS kv)", "(SELECT count(*) FROM jsonb_each(NULL::jsonb) AS kv)",
  "EXISTS (SELECT 1 FROM jsonb_each('{\"a\":1}'::jsonb) AS kv WHERE kv.key = 'a')", "EXISTS (SELECT 1 FROM jsonb_each('{\"a\":1}'::jsonb) AS kv WHERE kv.key = 'z')", "NOT EXISTS (SELECT 1 FROM jsonb_array_elements('[]'::jsonb) AS e)",
  "'a' IN (SELECT e FROM jsonb_array_elements_text('[\"a\",\"b\"]'::jsonb) AS e)", "'z' IN (SELECT e FROM jsonb_array_elements_text('[\"a\",\"b\"]'::jsonb) AS e)", "'z' IN (SELECT e FROM jsonb_array_elements_text('[]'::jsonb) AS e)",
  "(SELECT count(*) FILTER (WHERE e <> 'a') FROM jsonb_array_elements_text('[\"a\",\"b\",\"c\"]'::jsonb) AS e)",
  "coalesce((SELECT string_agg(e, ',' ORDER BY e) FROM jsonb_array_elements_text('[]'::jsonb) AS e), '')", "left(md5(coalesce((SELECT string_agg(e, ',' ORDER BY e) FROM jsonb_array_elements_text('[\"b\",\"a\"]'::jsonb) AS e), '')), 16)",
  "concat_ws(',', 'a', NULL, 'b')", "concat_ws('-', NULL, NULL)",
  // a count is a signed bigint in Postgres: one less than none is -1, never 2^64 - 1
  "(SELECT count(*) FROM jsonb_array_elements('[]'::jsonb) AS e) - 1", "(SELECT count(DISTINCT e) FROM jsonb_array_elements_text('[]'::jsonb) AS e) - 1",
  // a string literal takes the type of its typed neighbour, as Postgres resolves an untyped literal
  "coalesce(NULL::timestamptz, '1970-01-01')", "coalesce('2024-01-02 03:04:05+00'::timestamptz, '1970-01-01')",
  "coalesce(NULL::uuid, '00000000-0000-0000-0000-000000000000')", "coalesce(NULL::int, '5')", "coalesce(NULL::date, '2024-02-29')",
  "CASE WHEN true THEN NULL::date ELSE '2024-01-01' END", "CASE WHEN false THEN NULL::timestamptz ELSE '2024-01-01 12:00:00+00' END",
  "greatest(1.5::numeric, '2')", "least(3, '2')", "nullif('2024-01-01'::date, '2024-01-01')", "nullif(7, '8')",
];

/**
 * QUERY CASES: STATEMENT CLAUSES, one row per construct of the inventory the Postgres API was planned from (written for
 * the unrouted SQL path of the ClickHouse stack this was cut from). Each is a WHOLE statement over literal rows — a
 * UNION ALL of constant SELECTs is a table — run on both engines, and compared ROW
 * BY ROW after the same normalisation as the expressions above. What a row proves is the statement's MEANING: an alias
 * that shadows a column, Postgres's NULL placement in ORDER BY, a sum of nothing, a UNION dropping duplicates, a window's
 * default frame, IN's three-valued answer over a set with a NULL. The expressions inside them are the cases above.
 */
// the names sort alike by bytes and by a locale ('Ab' < 'b' < 'c'): what a row proves is the clause, never the declared
// collation divergence (the grammar harness has that one); the one COLLATE "C" case below is the translator accepting it.
// Every `x` has one scale (`-1.0`): a numeric column of literals of several scales is its own case (MIXED_SCALE below),
// which the DuckDB endpoint answers in one scale — decided, not something each of these should differ by
export const T = "(SELECT 1 AS id, 'Ab' AS name, 1.5 AS x, timestamptz '2026-01-01 10:00:00+00' AS at UNION ALL SELECT 2, NULL, NULL, timestamptz '2026-01-02 00:30:00+00' UNION ALL SELECT 3, 'b', 2.5, timestamptz '2026-02-01 00:00:00+00' UNION ALL SELECT 4, 'c', -1.0, NULL) AS t";
/** a numeric column whose values have their own scales: Postgres keeps each (`1`, `1.5`), DuckDB's DECIMAL has one (it
 *  reads the copied `public.one`, or the catalog Postgres would answer it, as Postgres by construction) */
export const MIXED_SCALE = "SELECT v FROM (SELECT 1 AS v FROM public.one UNION ALL SELECT 1.5 FROM public.one) AS m ORDER BY v";
export const U = "(SELECT 1 AS id, 10 AS k UNION ALL SELECT 2, 20 UNION ALL SELECT 5, NULL) AS u";
// AT TIME ZONE's rows (Cube's zoned bucket): both instants London's clock reads 01:30 at on 2026-10-25 (it
// falls back at 01:00Z), the hour after, a London midnight that is 23:00Z the day before, a São Paulo evening that is the
// next day in UTC, the two instants Havana's clock reads 00:30 at on 2026-11-01 (it falls back over midnight), a Monday
// and a Sunday for the week, and a NULL; `v` an integer, as Cube's sums of cents are
export const Z = "(SELECT 1 AS id, timestamptz '2026-10-25 00:30:00+00' AS at, 150 AS v UNION ALL SELECT 2, timestamptz '2026-10-25 01:30:00+00', 275 " +
  "UNION ALL SELECT 3, timestamptz '2026-10-25 02:10:00+00', 1 UNION ALL SELECT 4, timestamptz '2026-07-31 23:00:00+00', 99 " +
  "UNION ALL SELECT 5, timestamptz '2026-09-01 01:30:00+00', 1001 UNION ALL SELECT 6, timestamptz '2026-11-01 04:30:00+00', 20 " +
  "UNION ALL SELECT 7, timestamptz '2026-11-01 05:30:00+00', 30 UNION ALL SELECT 8, timestamptz '2026-10-19 12:00:00+00', 7 " +
  "UNION ALL SELECT 9, timestamptz '2026-10-18 23:30:00+00', 8 UNION ALL SELECT 10, NULL, 5 " +
  // the epoch (a sentinel a source may hold): São Paulo's wall clock reads 1969-12-31 21:00, a date before 1970;
  // Lord Howe's clock springs forward HALF an hour at 02:00 local on 2026-10-04 (15:30Z)
  "UNION ALL SELECT 11, timestamptz '1970-01-01 00:00:00+00', 3 UNION ALL SELECT 12, timestamptz '2026-10-03 15:45:00+00', 4) AS z";
export const QUERY_CASES: string[] = [
  // EXACT NUMERICS (src/lib/pg-numeric.ts; held to psql's text digit for digit): a bigint's sum divided as a numeric (an
  // integer sum's division stays integer division), rounded; averages of integers, of an integer division and a negative
  // one; a cast to numeric(p, s); round of a numeric; an average over no rows is NULL
  `SELECT k, round(sum(id::bigint * 1001) / 100.0, 2) AS r, avg(id / 3) AS b, (sum(id) / 7)::numeric(20, 4) AS c, round(avg(id)) AS w, avg(id - 10) * 3 AS neg, sum(id::bigint) / 3 AS q, sum(id::bigint) / 6 AS sixth, sum(id::bigint) AS total FROM (SELECT id, id % 2 AS k FROM ${T}) s GROUP BY k ORDER BY k`,
  `SELECT avg(id) AS a, round(sum(id::bigint) / 100.0, 2) AS r, count(*) AS n FROM ${T} WHERE id > 100`,
  // AT TIME ZONE: the zone's wall clock (a timestamp without time zone), truncated on the wall clock — London's repeated
  // 01:30 is ONE hour bucket, Havana's doubled midnight one day — beside Cube's own aggregates of an integer column
  `SELECT date_trunc('day', (z.at::timestamptz AT TIME ZONE 'Europe/London')) AS d, round(sum(z.v) / 100.0, 2) AS s, avg(z.v / 100) AS a, count(z.id) AS n FROM ${Z} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT date_trunc('hour', z.at AT TIME ZONE 'Europe/London') AS h, count(*) AS n FROM ${Z} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT date_trunc('week', z.at AT TIME ZONE 'America/Sao_Paulo') AS w, date_trunc('month', z.at AT TIME ZONE 'America/Sao_Paulo') AS m, count(*) AS n FROM ${Z} GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2`,
  `SELECT date_trunc('day', z.at AT TIME ZONE 'America/Havana') AS d, count(*) AS n FROM ${Z} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT z.id, date_trunc('day', z.at AT TIME ZONE 'America/Sao_Paulo') AS d, date_trunc('quarter', z.at AT TIME ZONE 'America/Sao_Paulo') AS q, date_trunc('year', z.at AT TIME ZONE 'America/Sao_Paulo') AS y, date_trunc('hour', z.at AT TIME ZONE 'America/Sao_Paulo') AS h, date_trunc('minute', z.at AT TIME ZONE 'Australia/Lord_Howe') AS mi, date_trunc('hour', z.at AT TIME ZONE 'Australia/Lord_Howe') AS lh FROM ${Z} ORDER BY z.id`,
  // Cube's time dimension over a DATE column: the date's UTC midnight (this path's session), then the zone's wall clock
  `SELECT date_trunc('day', (d::timestamptz AT TIME ZONE 'America/Sao_Paulo')) AS x, count(*) AS n FROM (SELECT (z.at)::date AS d FROM ${Z}) s GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT date_trunc('month', z.at AT TIME ZONE 'UTC') AS m, sum(z.v) AS s FROM ${Z} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT z.id, z.at AT TIME ZONE 'Europe/London' AS local, extract(hour from z.at AT TIME ZONE 'America/Sao_Paulo')::int AS h, (z.at AT TIME ZONE 'Asia/Kolkata')::date AS d FROM ${Z} ORDER BY z.id`,
  `SELECT z.id FROM ${Z} WHERE (z.at AT TIME ZONE 'Europe/London') < timestamptz '2026-10-25 01:00:00+00' AND z.at > timestamptz '2026-10-01 00:00:00+00' ORDER BY z.id`,
  // select list with aliases: an alias shadows nothing — WHERE reads the column, ORDER BY the output name, GROUP BY the input column first
  `SELECT lower(name) AS name, id FROM ${T} WHERE name = 'Ab' ORDER BY id`,
  `SELECT lower(name) AS n, count(*) AS c FROM ${T} GROUP BY n ORDER BY n NULLS FIRST`,
  `SELECT id % 2 AS id, count(*) AS c FROM ${T} GROUP BY 1 ORDER BY 1`,
  `SELECT x > 2 AS big, count(*) AS c FROM ${T} GROUP BY 1 ORDER BY 1 NULLS FIRST`,
  `SELECT upper(name) AS u, id FROM ${T} ORDER BY u DESC, id`,
  // *, t.*
  `SELECT * FROM (SELECT id, name FROM ${T}) s ORDER BY id`,
  `SELECT t.*, u.k FROM ${T} JOIN ${U} ON u.id = t.id ORDER BY t.id`,
  // ORDER BY: NULLS LAST on ASC, FIRST on DESC; text by bytes under COLLATE "C"
  `SELECT id, name FROM ${T} ORDER BY name DESC, id`,
  `SELECT id, name FROM ${T} ORDER BY name, id`,
  `SELECT id, x FROM ${T} ORDER BY x DESC NULLS LAST, id`,
  `SELECT name FROM ${T} WHERE name IS NOT NULL ORDER BY name COLLATE "C" LIMIT 1`,
  // LIMIT / OFFSET / FETCH FIRST
  `SELECT id FROM ${T} ORDER BY id LIMIT 2 OFFSET 1`,
  `SELECT id FROM ${T} ORDER BY id DESC FETCH FIRST 2 ROWS ONLY`,
  // DISTINCT with NULLs; DISTINCT ON
  `SELECT DISTINCT x > 2 AS big FROM ${T} ORDER BY 1 NULLS FIRST`,
  `SELECT DISTINCT ON (k) k, id FROM (SELECT id, id % 2 AS k FROM ${T}) s ORDER BY k, id DESC`,
  // GROUP BY / HAVING at the top level; aggregates of nothing
  `SELECT k, sum(x) AS total, count(*) AS c, count(x) AS cx, avg(id) AS a, min(name) AS mn, max(at) AS mx FROM (SELECT id, x, name, at, id % 2 AS k FROM ${T}) s GROUP BY k HAVING count(*) > 1 ORDER BY k`,
  `SELECT sum(x) AS s, count(x) AS c, count(*) AS n, max(name) AS m, avg(x) AS a FROM ${T} WHERE id > 100`,
  `SELECT count(DISTINCT name) AS dn, count(DISTINCT x > 2) AS db FROM ${T}`,
  // more aggregates
  `SELECT string_agg(name, ',' ORDER BY name) AS names, bool_or(x > 2) AS any_big, bool_and(x > 0) AS all_pos, every(id > 0) AS e FROM ${T}`,
  `SELECT k, string_agg(name, ',' ORDER BY name) AS names FROM (SELECT name, id % 2 AS k FROM ${T}) s GROUP BY k ORDER BY k`,
  // CTEs: read twice; shadowing a name; a column list
  `WITH a AS (SELECT id, x FROM ${T} WHERE x IS NOT NULL) SELECT count(*) AS n, (SELECT max(x) FROM a) AS m FROM a`,
  `WITH t AS (SELECT 7 AS id) SELECT id FROM t`,
  `WITH c(i, nm) AS (SELECT id, name FROM ${T}) SELECT i, nm FROM c WHERE nm IS NULL`,
  // derived tables and joins between them
  `SELECT t.id, s.total FROM ${T} JOIN (SELECT id, id * 10 AS total FROM ${U}) s ON s.id = t.id ORDER BY t.id`,
  `SELECT t.id, u.k FROM ${T} LEFT JOIN ${U} ON u.id = t.id ORDER BY t.id`,
  `SELECT t.id, u.k FROM ${T} LEFT JOIN ${U} ON u.id = t.id AND u.k > 10 ORDER BY t.id`,
  `SELECT t.id AS tid, u.id AS uid FROM ${T} RIGHT JOIN ${U} ON u.id = t.id ORDER BY u.id`,
  `SELECT t.id AS tid, u.id AS uid FROM ${T} FULL JOIN ${U} ON u.id = t.id ORDER BY t.id NULLS LAST, u.id NULLS LAST`,
  `SELECT count(*) AS n FROM ${T} CROSS JOIN ${U}`,
  `SELECT count(*) AS n FROM ${T}, ${U} WHERE u.id = t.id`,
  `SELECT t.id, u.k FROM ${T} INNER JOIN ${U} ON u.id = t.id AND t.x IS NOT NULL ORDER BY t.id`,
  // set operations
  `SELECT name FROM ${T} UNION SELECT name FROM ${T} ORDER BY 1 NULLS FIRST`,
  `SELECT count(*) AS n FROM (SELECT name FROM ${T} UNION ALL SELECT name FROM ${T}) q`,
  `SELECT id AS v FROM ${T} UNION ALL SELECT x FROM ${T} ORDER BY v NULLS LAST`,
  `SELECT id, 'a' AS kind FROM ${T} UNION ALL SELECT id, 'b' FROM ${U} ORDER BY kind, id LIMIT 5`,
  // window functions
  `SELECT id, row_number() OVER (ORDER BY x DESC NULLS LAST, id) AS rn, rank() OVER (ORDER BY name) AS r, dense_rank() OVER (ORDER BY name) AS dr FROM ${T} ORDER BY id`,
  `SELECT id, sum(x) OVER (ORDER BY id) AS run, count(*) OVER () AS n, count(x) OVER (ORDER BY id) AS cx, avg(x) OVER (PARTITION BY id % 2) AS pa FROM ${T} ORDER BY id`,
  `SELECT id, lag(x) OVER (ORDER BY id) AS prev, lead(name) OVER (ORDER BY id) AS nxt, lag(x, 2) OVER (ORDER BY id) AS prev2, lead(x, 1, 0) OVER (ORDER BY id) AS nxt0 FROM ${T} ORDER BY id`,
  `SELECT id, first_value(name) OVER (ORDER BY id) AS fv, last_value(name) OVER (ORDER BY id) AS lv_default, last_value(name) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lv FROM ${T} ORDER BY id`,
  `SELECT id, min(id) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS mn, max(x) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS mx, sum(id) OVER w AS s FROM ${T} WINDOW w AS (PARTITION BY id % 2 ORDER BY id) ORDER BY id`,
  `SELECT id, sum(k) OVER (ORDER BY k RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peers FROM (SELECT id, id % 2 AS k FROM ${T}) s ORDER BY id`,
  // subqueries over tables: IN's three values, NOT IN, EXISTS, a scalar over no rows
  `SELECT id, (x IN (SELECT x FROM ${T} WHERE id <> 4)) AS inset, (x NOT IN (SELECT x FROM ${T} WHERE id <> 4)) AS notin FROM ${T} ORDER BY id`,
  `SELECT id, (x IN (SELECT x FROM ${T} WHERE x > 2)) AS inset, (x NOT IN (SELECT x FROM ${T} WHERE x > 2)) AS notin FROM ${T} ORDER BY id`,
  `SELECT id FROM ${T} WHERE x IN (SELECT x FROM ${T} WHERE id = 1) ORDER BY id`,
  `SELECT id FROM ${T} WHERE id NOT IN (SELECT id FROM ${U}) ORDER BY id`,
  `SELECT id FROM ${T} WHERE EXISTS (SELECT 1 FROM ${U} WHERE k > 100) ORDER BY id`,
  `SELECT id FROM ${T} WHERE EXISTS (SELECT 1 FROM ${U}) AND NOT EXISTS (SELECT 1 FROM ${U} WHERE k > 100) ORDER BY id`,
  `SELECT (SELECT max(k) FROM ${U} WHERE k > 100) AS m, (SELECT k FROM ${U} WHERE id = 1) AS one, (SELECT count(*) FROM ${U}) AS n`,
  `SELECT id, x FROM ${T} WHERE x > (SELECT avg(x) FROM ${T}) ORDER BY id`,
  // expressions in a statement: CASE, coalesce, arithmetic, casts, intervals, buckets (a UTC session)
  `SELECT id, coalesce(name, '-') AS n, CASE WHEN x > 2 THEN 'big' WHEN x IS NULL THEN 'none' ELSE 'small' END AS size, x * 2 AS twice, floor(x)::int AS whole, name || '!' AS bang FROM ${T} ORDER BY id`,
  `SELECT id, at + interval '1 day' AS tomorrow, date_trunc('month', at) AS m, extract(year from at) AS y, at::date AS d, extract(hour from at)::int AS h FROM ${T} ORDER BY id`,
  `SELECT id FROM ${T} WHERE name LIKE 'A%' OR NOT (x > 2) OR name ~ '^b' ORDER BY id`,
  `SELECT id FROM ${T} WHERE at >= timestamptz '2026-01-02 00:00:00+00' AND at < timestamptz '2026-03-01 00:00:00+00' ORDER BY id`,
  `SELECT now() > timestamptz '2020-01-01 00:00:00+00' AS later, CURRENT_DATE > date '2020-01-01' AS later2`,
  // two-level aggregation
  `SELECT c, count(*) AS groups FROM (SELECT id % 2 AS k, count(*) AS c FROM ${T} GROUP BY k) g GROUP BY c ORDER BY c`,
  `WITH per AS (SELECT id % 2 AS k, sum(x) AS s FROM ${T} GROUP BY k) SELECT max(s) AS top, min(s) AS bottom, count(*) AS n FROM per`,
  // a window function or an expression over a grouped SELECT:
  // the window's own ORDER BY reads an expression EQUAL to a GROUP BY expression, which Postgres takes as grouped
  `SELECT k, count(*) AS c, count(*) * 100.0 / sum(count(*)) OVER () AS share FROM (SELECT id % 2 AS k FROM ${T}) s GROUP BY k ORDER BY k`,
  `SELECT date_trunc('day', at) AS d, count(*) AS c, sum(count(*)) OVER (ORDER BY date_trunc('day', at)) AS running FROM ${T} GROUP BY date_trunc('day', at) ORDER BY d NULLS LAST`,
  `SELECT k, sum(x) AS total, rank() OVER (ORDER BY sum(x) DESC NULLS LAST) AS r FROM (SELECT id % 2 AS k, x FROM ${T}) s GROUP BY k ORDER BY k`,
];

/** STATEMENTS BOTH ENGINES REFUSE: what Postgres refuses, this path refuses too — never answered with rows nothing defines. */
export const REFUSED_CASES: Array<{ sql: string; sqlstate: string }> = [
  // under DISTINCT an ORDER BY expression must be a select item (42P10): an engine that ran it would let a LIMIT keep arbitrary rows
  { sql: `SELECT DISTINCT name FROM ${T} ORDER BY x LIMIT 2`, sqlstate: "42P10" },
  // DISTINCT ON's ORDER BY must lead with its expressions
  { sql: `SELECT DISTINCT ON (name) name, id FROM ${T} ORDER BY id`, sqlstate: "42P10" },
  // a zone nobody knows: Postgres's own 22023
  { sql: `SELECT z.at AT TIME ZONE 'Europe/Londinium' AS l FROM ${Z}`, sqlstate: "22023" },
];
