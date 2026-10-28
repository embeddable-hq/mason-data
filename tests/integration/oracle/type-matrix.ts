/**
 * THE TYPE MATRIX: every common column type, and what SQL does with each — sort it, group it, compare it with
 * every type of its family, compute with it, call its functions, cast it, aggregate it — over EDGE values. The DuckDB
 * oracle (duck-oracle.itest.ts) asks each statement of Postgres and of the DuckDB endpoint, and what the statements
 * answered alike are made of is what the endpoint admits (src/duck/verified.ts): a function, an operator, a cast or a
 * type no statement here or elsewhere in the oracle verifies is REFUSED. So this matrix decides what a customer's SQL may
 * use, and anything a tool sends that is refused for being unverified belongs here, as a statement.
 *
 * `public.typed` has ORDINARY rows (id < 100: values chosen so arithmetic between any two stays in range) and EXTREME
 * rows (id ≥ 100: NaN, ±Infinity, -0, infinite dates and times, a bigint past 2^53, the widest exact numeric) — an
 * arithmetic statement reads the ordinary rows only (an overflow is an error in both, which proves nothing), everything
 * else reads every row. A statement Postgres refuses (min(json), a % of floats) is asked too: it must be refused alike.
 */

/** the columns, by family, with the type each is declared with */
const COLUMNS = {
  i2: "smallint", i4: "integer", i8: "bigint", f4: "real", f8: "double precision", n: "numeric", n2: "numeric(12,2)",
  t: "text", vc: "varchar(20)", ch: "char(5)", b: "boolean", d: "date", ts: "timestamp", tz: "timestamptz", iv: "interval",
  tm: "time", u: "uuid", j: "json", jb: "jsonb", ai: "integer[]", at: "text[]",
  // a review finding: a citext compared case-sensitively, an inet written as its text (both silently wrong)
  ci: "citext", ip: "inet",
} as const;
type Col = keyof typeof COLUMNS;
const NUMBERS: Col[] = ["i2", "i4", "i8", "f4", "f8", "n", "n2"];
const TEXTS: Col[] = ["t", "vc", "ch"];
const TIMES: Col[] = ["d", "ts", "tz"];
/** what each extreme-less column holds beyond the 22 above: [ci, ip] per row id */
const EXTRA: Record<string, [string, string]> = {
  1: ["''", "'0.0.0.0'"], 2: ["'finalized'", "'10.3.6.45'"], 3: ["'FINALIZED'", "'10.0.0.0/8'"], 4: ["'Finalized'", "'10.3.6.45/32'"],
  5: ["'é'", "'::1'"], 6: ["'draft'", "'fe80::1/64'"], 7: ["'Draft '", "'2001:db8::ff00:42:8329'"], 8: ["NULL", "NULL"],
  9: ["'10'", "'192.168.1.5'"], 10: ["'9'", "'9.255.255.255'"], 101: ["'É'", "'255.255.255.255'"], 102: ["'z'", "'::'"],
  103: ["'Z'", "'::ffff:10.3.6.45'"], 104: ["'ß'", "'2001:db8::/32'"],
};
const ALL = Object.keys(COLUMNS) as Col[];

/** one row per array: [id, i2, i4, i8, f4, f8, n, n2, t, vc, ch, b, d, ts, tz, iv, tm, u, j, jb, ai, at] as SQL literals */
const ROWS: string[][] = [
  ["1", "0", "0", "0", "0", "0", "0.00", "0", "''", "''", "''", "true", "'2026-01-01'", "'2026-01-01 00:00:00'", "'2026-01-01 00:00:00+00'", "'0'", "'00:00:00'", "'00000000-0000-0000-0000-000000000000'", "'{}'", "'{}'", "'{}'", "'{}'"],
  ["2", "1", "1", "1", "1.5", "1.5", "1.50", "1.5", "'a'", "'a'", "'a'", "false", "'2024-02-29'", "'2024-02-29 12:30:00.5'", "'2024-02-29 23:30:00-05'", "'1 day'", "'12:30:00.5'", "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'", "'{\"a\": 1}'", "'{\"a\": 1}'", "'{1,2}'", "'{a,b}'"],
  ["3", "-1", "-1", "-1", "-2.25", "-2.25", "-2.25", "-2.25", "'B'", "'B'", "'B'", "NULL", "'1970-01-01'", "'1970-01-01 00:00:00'", "'1970-01-01 00:00:00+00'", "'-1 hour'", "'23:59:59.999999'", "'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A12'", "'[1, 2,  3]'", "'[1, 2,  3]'", "'{NULL,3}'", "'{NULL,\"x y\"}'"],
  ["4", "7", "7", "7", "0.1", "0.1", "0.10", "0.1", "'b'", "'b'", "'ab'", "true", "'2026-09-15'", "'2026-09-15 10:04:05.123456'", "'2026-09-15 10:04:05.123456+02'", "'1 mon 2 days 03:04:05'", "'10:04:05'", "'ffffffff-ffff-ffff-ffff-ffffffffffff'", "'{\"b\": [1, {\"c\": 2}], \"a\": \"x\"}'", "'{\"b\": [1, {\"c\": 2}], \"a\": \"x\"}'", "'{3,1,2}'", "'{b,a}'"],
  ["5", "100", "100000", "123456789", "1e-07", "123456789.123", "12345678901.25", "1234567890.12", "'é'", "'é'", "'é'", "false", "'2000-03-05'", "'2000-03-05 07:00:00'", "'2000-03-05 07:00:00+00'", "'36 hours'", "'07:00:00'", "'12345678-1234-1234-1234-123456789abc'", "'null'", "'null'", "'{5}'", "'{\"\"}'"],
  ["6", "-300", "-2147483", "-5", "3.25", "1e-10", "-0.01", "-0.01", "'Ab'", "'Ab'", "'ab '", "true", "'1999-12-31'", "'1999-12-31 23:59:59'", "'1999-12-31 23:59:59-08'", "'1 day 12:00:00'", "'00:00:01'", "'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'", "'\"s\"'", "'\"s\"'", "'{1,2}'", "'{a,b}'"],
  ["7", "2", "2", "2", "2", "2", "2.00", "2", "' space'", "' space'", "' sp'", "false", "'2026-12-28'", "'2026-12-28 18:45:00'", "'2026-12-28 18:45:00+00'", "'1 year -1 day'", "'18:45:00'", "'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'", "'1.50'", "'1.50'", "'{2}'", "'{c}'"],
  ["8", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL", "NULL"],
  ["9", "3", "3", "3", "3", "3", "3.00", "3", "'10'", "'10'", "'10'", "true", "'2026-01-01'", "'2026-01-01 00:00:00'", "'2026-01-01 05:00:00+05'", "'2 days'", "'00:00:00'", "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'", "'{\"a\": 2}'", "'{\"a\": 2}'", "'{}'", "'{}'"],
  ["10", "-7", "-7", "-7", "-7.5", "-7.5", "-7.50", "-7.5", "'9'", "'9'", "'9'", "false", "'2025-12-29'", "'2025-12-29 00:00:00'", "'2025-12-29 00:00:00+00'", "'00:00:00.000001'", "'12:00:00'", "'d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'", "'[]'", "'[]'", "'{-1,0}'", "'{\"NULL\",z}'"],
  // the extreme rows
  ["101", "32767", "2147483647", "9007199254740993", "'NaN'", "'NaN'", "99999999999999999999.99", "9999999999.99", "'zz'", "'zz'", "'zz'", "true", "'infinity'", "'infinity'", "'infinity'", "'178000000 years'", "'24:00:00'", "'00000000-0000-0000-0000-000000000001'", "'{\"a\": 1e2}'", "'{\"a\": 1e2}'", "'{2147483647}'", "'{zz}'"],
  ["102", "-32768", "-2147483648", "-9223372036854775808", "'Infinity'", "'Infinity'", "-99999999999999999999.99", "-9999999999.99", "'Z'", "'Z'", "'Z'", "false", "'-infinity'", "'-infinity'", "'-infinity'", "'-178000000 years'", "'00:00:00'", "'ffffffff-0000-0000-0000-000000000000'", "'{\"a\": -0}'", "'{\"a\": -0}'", "'{-2147483648}'", "'{\"\\\\\"}'"],
  ["103", "0", "0", "9223372036854775807", "'-Infinity'", "'-Infinity'", "0.01", "0.01", "'a'", "'a'", "'a'", "NULL", "'4713-11-24 BC'", "'4713-11-24 00:00:00 BC'", "'2262-04-11 23:47:16+00'", "'-1 mon'", "'00:00:00.5'", "'00000000-0000-0000-0000-000000000000'", "'{\"a\": 1.0}'", "'{\"a\": 1.0}'", "'{0}'", "'{a}'"],
  ["104", "1", "1", "1", "'-0'", "'-0'", "0.00", "0.00", "'b'", "'b'", "'b'", "true", "'2026-01-01'", "'2026-01-01 00:00:00'", "'2026-01-01 00:00:00+00'", "'1 day'", "'00:00:00'", "'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'", "'{\"a\": 1}'", "'{\"a\": 1}'", "'{1}'", "'{a}'"],
];

/** text a cast reads, by the type Postgres reads it as (ids by range: a cast that refuses a value is an error, so each
 *  statement reads the range its type accepts); the forms are Postgres's input functions' own, not ISO alone */
const CASTABLE: Array<[number, string]> = [
  // integers (1-9; 10 a bigint only)
  [1, "1"], [2, " 2 "], [3, "+5"], [4, "1_000"], [5, "0x1F"], [6, "0o17"], [7, "0b101"], [8, "007"], [9, "-2147483648"], [10, "9223372036854775807"],
  // booleans (11-19)
  [11, "t"], [12, "TRUE"], [13, " yes "], [14, "off"], [15, "0"], [16, "f"], [17, "n"], [18, "ON"], [19, "1"],
  // dates and times (21-46)
  [21, "2026-01-02"], [22, "01/02/2026"], [23, "1/2/26"], [24, "January 2, 2026"], [25, "2026-1-2"], [26, "20260102"], [27, "2 Jan 2026"],
  [28, "Jan-02-2026"], [29, "2026-01-02 10:30:00"], [30, "2026-01-02T10:30:00Z"], [31, "0044-03-15 BC"], [32, "infinity"], [33, "epoch"],
  [34, "2026-01-02 10:30:00+05:30"], [35, "2026.01.02"], [36, "02.01.2026"], [37, "2026/01/02"], [38, "Fri Jan 02 2026"],
  [39, "2026-01-02 America/New_York"], [40, "2026-002"], [41, "J2461043"], [42, "2026-01-02 10:30:00.123456789"], [43, "  2026-01-02  "],
  [44, "-infinity"], [45, "2026-03-08 02:30 America/New_York"], [46, "2026-01-02 10:30 PM"],
  // intervals (51-69)
  [51, "1 day"], [52, "2 days 03:00:00"], [53, "1 day ago"], [54, "P1DT2H"], [55, "@ 3 hours"], [56, "1:30"], [57, "-1 mon +2 days"],
  [58, "1 year 2 mons"], [59, "90 minutes"], [60, "1.5 days"], [61, "1 week"], [62, "10"], [63, "1-2"], [64, "1.5 months"],
  [65, "P1Y2M3DT4H5M6.5S"], [66, "3 days -02:00"], [67, "100 years"], [68, "-00:00:01"], [69, "P0001-02-03T04:05:06"],
  // numerics (71-78)
  [71, "1.50"], [72, "1e3"], [73, " -0.0 "], [74, "NaN"], [75, "12345678901234567890.123"], [76, "Infinity"], [77, ".5"], [78, "1_000.5"], [79, "123456789012345678901234.5"],
  // uuids (81-83), json (91-93)
  [81, "{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}"], [82, "A0EEBC999C0B4EF8BB6D6BB9BD380A11"], [83, "a0ee-bc99-9c0b-4ef8-bb6d-6bb9-bd38-0a11"],
  [91, ' {"b": 1, "a": [1, 2.50]} '], [92, '{"a":1,"a":2}'], [93, "1e2"],
  // read as nothing
  [99, "not a value"],
];

/**
 * JSONB IN POSTGRES'S ORDER (src/duck/jsonb-order.ts): each type at the top and inside, sizes, an object's keys in
 * storage order (`{"b", "aa"}` against `{"a", "bb"}`), numbers equal at other scales and in other spellings (`1.0`,
 * `1.00`, `1e2`, `-0`), the raw scalar's place between `[]` and `[x]`, nested empty containers, a key held twice, and
 * strings that differ in case, accent, punctuation or script — compared under the database's collation, which the
 * oracle is run under (C, ICU and glibc's en_US.utf8 each sort these differently). No combining mark: a libc
 * collation refuses one (libc-uncovered).
 */
export const JORDER: Array<string | null> = [
  null, "null", "true", "false", "0", "-0", "0.0", "1", "1.0", "1.00", "10", "9.5", "-1", "-10", "-9.5", "-0.5", "-0.50", "1e2", "100", "1E+2",
  "0.001", "1e-3", "123456789012345678901234567890.5", "-123456789012345678901234567890", "2.5e-30",
  '""', '"a"', '"A"', '"b"', '"B"', '"ab"', '"Ab"', '"aB"', '"a b"', '"a-b"', '"ab-"', '"é"', '"e"', '"\\u00e9"', '"E"', '"z"', '"\\n"', '"\\"q\\""', '"\\ud83d\\ude00"',
  '"日本"', '"ß"', '"ss"', '"Zürich"', '"zulu"', '"10"', '"9"', '"$x"', '"@x"',
  "[]", "[null]", "[1]", "[1.0]", "[2]", "[1, 2]", "[2, 1]", "[[]]", "[{}]", '["a"]', '["B"]', '["b"]', "[1, [2]]", "[[1], 1]", "[true, false]", "[[], []]", "[[[]]]",
  "{}", '{"a": 1}', '{"a": 1.0}', '{"a": 2}', '{"b": 1}', '{"B": 1}', '{"A": 1}', '{"a": null}', '{"a": []}', '{"a": {}}', '{"a": "1"}', '{"a": "B"}', '{"a": "b"}',
  '{"a": 1, "b": 2}', '{"b": 1, "aa": 1}', '{"a": 1, "bb": 1}', '{"aa": 1}', '{"Ab": 1}', '{"a": {"b": [1, "x"]}}', '{"a": 1, "a": 2}', '{"é": 1}', '{"e": 1}', '{"a": 1, "B": 2}',
];

export const COLL: Array<[number, string | null]> = [
  [1, "대지"], [2, "Animal"], [3, "zebra"], [4, "Dob"], [5, "Do\uFFFDa"], [6, "$x"], [7, "€x"], [8, "@x"], [9, "~x"], [10, "ab"],
  [11, "a-b"], [12, "a b"], [13, "가나"], [14, "나"], [15, "가가"], [16, "-"], [17, "--"], [18, "-@"], [19, "@"], [20, "三"],
  [21, "가三"], [22, "三가"], [23, ":三"], [24, "a가"], [25, "가a"], [26, "-a"], [27, "a"], [28, "A"], [29, "ß"], [30, "ss"],
  [31, "Ss"], [32, "æ"], [33, "ae"], [34, "café"], [35, "Cafe"], [36, "co-op"], [37, "coop"], [38, "x?"], [39, "-X"], [40, "1a"],
  [41, "Ölbaum"], [42, "Zürich"], [43, "zulu"], [44, "αβγ"], [45, "абв"], [46, "東京"], [47, "\uFFFD"], [48, "£5"], [49, null],
  [50, "1x"], [51, "1-X"], [99, "e\u0301"],
];

/** the table and its rows (the oracle's TimeZone is UTC: a timestamptz literal's offset is folded into UTC); beside it,
 *  `typed_arrays` holds the array types the review found sent as text[] */
export const TYPED = `CREATE EXTENSION IF NOT EXISTS citext; CREATE TABLE public.typed (id int PRIMARY KEY, ${ALL.map((c) => `${c} ${COLUMNS[c]}`).join(", ")}); ` +
  `INSERT INTO public.typed VALUES ${ROWS.map((r) => `(${[...r, ...EXTRA[r[0]!]!].join(", ")})`).join(", ")}; ` +
  // an unbounded numeric beside an extension's arrays: the copy reads the table through postgres_query (the corpus
  // run of fbbf8f08: a citext[] arrived as one text, and the table could not be copied)
  "CREATE TABLE public.typed_arrays (id int PRIMARY KEY, jba jsonb[], ja json[], vca varchar(5)[], by bytea, n numeric, ca citext[], ia inet[]); " +
  "INSERT INTO public.typed_arrays VALUES (1, ARRAY['{\"a\": 1}'::jsonb, '[1, 2]'], ARRAY['{\"a\":1}'::json, ' 2 '], ARRAY['ß', 'alpha'], '\\x00ff', 1.5, '{ß,alpha}', '{10.3.6.45,::1}'), (2, '{}', '{}', '{}', '', 0, '{}', '{}'), (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL), " +
  "(4, ARRAY[NULL, '\"s\"'::jsonb], ARRAY['[]'::json], ARRAY['a b', NULL, '\"q\"', 'NULL', '', 'x,y', 'b\\\\'], '\\x5c27', 12345678901234567890.5, '{\"a b\",NULL}', '{10.0.0.0/8}');" +
  `CREATE TABLE public.castable (id int PRIMARY KEY, s text); INSERT INTO public.castable VALUES ${CASTABLE.map(([id, v]) => `(${id}, '${v.replace(/'/g, "''")}')`).join(", ")}; ` +
  // a column named as typed's `t` in another case: DuckDB binds names case-insensitively (the corpus rerun)
  `CREATE TABLE public.cased (id int PRIMARY KEY, "T" text, "Tz" text); INSERT INTO public.cased VALUES (1, 'one', 'Europe/London'), (2, 'a', 'utc'), (4, 'B', 'UT'), (9, NULL, 'asia/kolkata');` +
  // JSON COLUMNS NAMED AS typed's j and jb in another case (the review of the native read): a read's column
  // is placed in every arm of its CASE, and each place must be qualified as Postgres resolved the bare name; its
  // documents hold `#>` elements an index reads otherwise than a key (`+1`, ` 1`, `1 `)
  `CREATE TABLE public.jcased (id int PRIMARY KEY, "JB" jsonb, "J" json); INSERT INTO public.jcased VALUES ` +
  `(1, '{"a": "upper", "1": "one", "1 ": "trailing", " 1": "leading", "+1": "plus", "01": "zero-one"}', '{"a": "upper", "1 ": "trailing", " 1": "leading", "+1": "plus", "a": "last"}'), ` +
  `(4, '["x", "y", "z"]', '["x", "y", "z"]'), (5, NULL, NULL), (6, '{"a": "p", "o": {"a": "q", "b": ["r", "s"]}}', '{"o": {"a": "q", "a": "q2"}}');` +
  // TEXT IN THE DATABASE'S ORDER (the BI-tools test of #517): what a glibc locale orders otherwise than ICU
  // and than its bytes — Hangul (no letter weight), $ and € (a letter-level weight, @ and ~ none), U+FFFD (after the
  // letters), ß = ss, CJK (no last-level weight), punctuation runs, case. Below 50 the covered ones; 50–59 the decided
  // difference (libc-symbol-punctuation); 99 a combining mark, refused (libc-uncovered)
  `CREATE TABLE public.coll (id int PRIMARY KEY, s text); INSERT INTO public.coll VALUES ${COLL.map(([id, v]) => `(${id}, ${v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`})`).join(", ")};` +
  // ENUMS IN THEIR DECLARED ORDER (the BI-tools test of #517): a label with a quote, an enum of another schema, an
  // array of one, NULL and empty arrays, and a text column read as the enum
  "CREATE TYPE public.mood AS ENUM ('sad', 'ok', 'happy', 'it''s'); CREATE SCHEMA IF NOT EXISTS other; CREATE TYPE other.level AS ENUM ('low', 'high'); " +
  "CREATE TABLE public.moods (id int PRIMARY KEY, m mood, ms mood[], l other.level, t text); " +
  "INSERT INTO public.moods VALUES (1, 'happy', '{sad,ok}', 'high', 'ok'), (2, 'sad', NULL, 'low', 'happy'), (3, 'ok', '{}', NULL, NULL), " +
  "(4, NULL, '{happy}', 'low', 'sad'), (5, 'it''s', '{it''s,sad}', 'high', 'it''s'), (6, 'sad', '{ok}', 'high', 'ok');" +
  // A SOURCE'S NOT NULL AND DEFAULTS (the Metabase test of #517): a serial, a smallserial, both identities, a text's
  // default, a function's, and a generated column (its expression is no default)
  "CREATE TABLE public.defaults (id serial PRIMARY KEY, sm smallserial, ia int GENERATED ALWAYS AS IDENTITY, ib bigint GENERATED BY DEFAULT AS IDENTITY, " +
  "s text NOT NULL DEFAULT 'draft', u uuid DEFAULT gen_random_uuid(), g int GENERATED ALWAYS AS (id * 2) STORED, n int NOT NULL); " +
  "INSERT INTO public.defaults (s, n) VALUES ('a', 1), ('b', 2);" +
  // VIEWS, served over the copied tables (the Metabase test of #517): one in another schema with a column list, an
  // aggregate, a view over a view
  "CREATE VIEW public.happy AS SELECT id, m, t FROM moods WHERE m >= 'ok'; " +
  "CREATE VIEW other.typed_summary (flag, n, total) AS SELECT b, count(*), sum(i4) FROM typed GROUP BY b; " +
  "CREATE VIEW public.happy_count AS SELECT count(*) AS n, max(m) AS top FROM happy;" +
  // A SELECT LIST COMPUTED AFTER ITS LIMIT (the Metabase test of #517: a table's preview, its JSON's fields, a join):
  // row 2000's 'x' is no integer, and late.k orders the rows backwards with no index
  "CREATE TABLE public.late (id int PRIMARY KEY, j jsonb, k int, c int); " +
  "INSERT INTO public.late SELECT g, jsonb_build_object('n', CASE WHEN g = 2000 THEN 'x' ELSE g::text END, 'd', jsonb_build_object('os', 'ios' || g % 7)), 2000 - g, g % 50 FROM generate_series(1, 2000) g; " +
  "CREATE TABLE public.late_c (id int PRIMARY KEY, name text); INSERT INTO public.late_c SELECT g, 'c' || g FROM generate_series(0, 49) g;" +
  // JSONB IN POSTGRES'S ORDER (JORDER above), beside a json of the same text, which has no order at all
  `CREATE TABLE public.jorder (id int PRIMARY KEY, j jsonb, js json); INSERT INTO public.jorder VALUES ${JORDER.map((v, i) => `(${i + 1}, ${v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`}, ${v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`})`).join(", ")};`

/** a round of changes the poll carries: values move, a row goes, one comes */
export function typedMutations(round: number): string {
  return round === 1
    ? "UPDATE public.typed SET i4 = i4 + 1, f8 = f8 * 2, n = n + 0.01, t = t || 'x', tz = tz + interval '1 hour', jb = jb || '{\"r\": 1}', ai = ai || 9, ci = upper(ci), ip = '10.3.6.46' WHERE id IN (2, 4); UPDATE public.typed SET f8 = 'NaN', t = 'é2' WHERE id = 103; DELETE FROM public.typed WHERE id = 7; " +
      "INSERT INTO public.typed (id, i2, i4, i8, f8, n, t, d, tz, iv, jb, ai, at) VALUES (11, 11, 11, 11, 11.5, 11.25, 'new', '2026-10-24', '2026-10-24 12:00:00+00', '11 minutes', '{\"n\": 11}', '{11}', '{new}')"
    : "UPDATE public.typed SET i8 = NULL, t = NULL, jb = NULL, ai = NULL WHERE id = 11; UPDATE public.typed SET b = NOT b, d = d + 1 WHERE id < 10; " +
      "UPDATE public.typed_arrays SET ca = ca || 'Z'::citext, ia = ia || '192.168.0.1'::inet, jba = jba || '{\"m\": 2}'::jsonb, n = n + 1 WHERE id IN (1, 4)";
}

const ORDINARY = "id < 100";
const OPS = ["=", "<>", "<", "<=", ">", ">="];
const pairs = <T>(xs: readonly T[]): Array<[T, T]> => xs.flatMap((a) => xs.map((b): [T, T] => [a, b]));
const q = (name: string, sql: string): { name: string; sql: string } => ({ name: `type matrix: ${name}`, sql });

/** a literal of each family to compare a column with */
const LITERALS: Partial<Record<Col, string[]>> = {
  i2: ["1", "1.5", "-300"], i4: ["1", "100000", "2.5"], i8: ["1", "9007199254740993", "-5.5"], f4: ["1.5", "0.1", "2"], f8: ["1.5", "0.1", "1e-10"],
  n: ["1.5", "0.1", "12345678901.25"], n2: ["1.50", "0.1", "2"], t: ["'a'", "'B'", "'é'"], vc: ["'a'", "'Ab'", "''"], ch: ["'ab'", "'ab   '", "'a'"],
  d: ["'2026-01-01'", "'2024-02-29 12:00'", "now()"], ts: ["'2026-01-01'", "'2024-02-29 12:30:00.5'", "now()"], tz: ["'2026-01-01'", "'2024-02-29 23:30:00-05'", "now()"],
  iv: ["'1 day'", "'24 hours'", "'1 mon'"], tm: ["'12:00'", "'00:00:00'", "'23:59:59.999999'"], u: ["'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'"],
  ci: ["'finalized'", "'DRAFT'", "'é'"], ip: ["'10.3.6.45'", "'10.0.0.0/8'", "'::1'"],
  // a jsonb by its own order: an object equal to two of typed's at another scale, a raw scalar, an empty array
  jb: ["'{\"a\": 1.00}'", "'1.5'", "'[]'"],
};

function* matrix(): Generator<{ name: string; sql: string }> {
  // ---- every column: its text, its order, its groups, its NULLs, its aggregates, its casts to text ----------------
  for (const c of ALL) {
    yield q(`${c} as written`, `SELECT id, ${c} FROM typed ORDER BY id`);
    yield q(`${c} sorted`, `SELECT id, ${c} FROM typed ORDER BY ${c}, id`);
    yield q(`${c} sorted DESC NULLS LAST`, `SELECT id, ${c} FROM typed ORDER BY ${c} DESC NULLS LAST, id`);
    yield q(`${c} grouped`, `SELECT ${c}, count(*) FROM typed GROUP BY ${c}`);
    yield q(`${c} DISTINCT`, `SELECT DISTINCT ${c} FROM typed`);
    yield q(`${c} min/max/count`, `SELECT count(${c}), count(DISTINCT ${c}), min(${c}), max(${c}) FROM typed`);
    yield q(`${c} IS NULL`, `SELECT id FROM typed WHERE ${c} IS NULL ORDER BY id`);
    yield q(`${c} IS DISTINCT FROM itself`, `SELECT id, ${c} IS DISTINCT FROM ${c}, ${c} IS NOT DISTINCT FROM NULL FROM typed ORDER BY id`);
    yield q(`${c}::text`, `SELECT id, ${c}::text, ${c}::varchar, ${c}::varchar(3) FROM typed ORDER BY id`);
    yield q(`${c} || text`, `SELECT id, ${c} || '|', concat(${c}, '!'), format('%s', ${c}) FROM typed ORDER BY id`);
    yield q(`${c} array_agg / string_agg`, `SELECT array_agg(${c} ORDER BY id), string_agg(${c}::text, ',' ORDER BY id) FROM typed`);
    yield q(`${c} coalesce / nullif / CASE`, `SELECT id, coalesce(${c}, ${c}), nullif(${c}, ${c}), CASE WHEN ${c} IS NULL THEN 'none' ELSE 'some' END FROM typed ORDER BY id`);
    yield q(`${c} to_json / to_jsonb`, `SELECT id, to_json(${c}), to_jsonb(${c}), json_build_object('v', ${c}), jsonb_build_object('v', ${c}) FROM typed ORDER BY id`);
    yield q(`${c} window first_value / lag`, `SELECT id, first_value(${c}) OVER (ORDER BY id), lag(${c}) OVER (ORDER BY id), count(${c}) OVER () FROM typed ORDER BY id`);
    for (const lit of LITERALS[c] ?? []) {
      for (const op of OPS) yield q(`${c} ${op} ${lit}`, `SELECT id FROM typed WHERE ${c} ${op} ${lit} ORDER BY id`);
      yield q(`${c} IN (${lit})`, `SELECT id FROM typed WHERE ${c} IN (${lit}, ${lit}) ORDER BY id`);
    }
    const lits = LITERALS[c];
    if (lits !== undefined && lits.length >= 2) yield q(`${c} BETWEEN`, `SELECT id FROM typed WHERE ${c} BETWEEN ${lits[1]} AND ${lits[0]} OR ${c} NOT BETWEEN ${lits[0]} AND ${lits[1]} ORDER BY id`);
  }

  // ---- numbers: each pair compared and computed, each function, each cast, each aggregate --------------------------
  for (const [a, b] of pairs(NUMBERS)) {
    for (const op of OPS) yield q(`${a} ${op} ${b}`, `SELECT id FROM typed WHERE ${a} ${op} ${b} ORDER BY id`);
    yield q(`${a} + - * ${b}`, `SELECT id, ${a} + ${b}, ${a} - ${b}, ${a} * ${b} FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${a} / ${b}`, `SELECT id, ${a} / ${b} FROM typed WHERE ${ORDINARY} AND ${b} <> 0 ORDER BY id`);
    yield q(`${a} % ${b}`, `SELECT id, ${a} % ${b}, mod(${a}, ${b}) FROM typed WHERE ${ORDINARY} AND ${b} <> 0 ORDER BY id`);
    yield q(`greatest(${a}, ${b})`, `SELECT id, greatest(${a}, ${b}), least(${a}, ${b}), coalesce(${a}, ${b}) FROM typed ORDER BY id`);
    yield q(`${a}::${COLUMNS[b]}`, `SELECT id, ${a}::${COLUMNS[b]} FROM typed WHERE ${ORDINARY} ORDER BY id`);
  }
  for (const c of NUMBERS) {
    yield q(`${c} sum/avg`, `SELECT sum(${c}), avg(${c}) FROM typed WHERE ${ORDINARY}`);
    yield q(`${c} sum/avg over every row`, `SELECT sum(${c}), avg(${c}) FROM typed`);
    yield q(`${c} stddev/variance`, `SELECT stddev(${c}), stddev_samp(${c}), stddev_pop(${c}), variance(${c}), var_samp(${c}), var_pop(${c}) FROM typed WHERE ${ORDINARY}`);
    yield q(`${c} percentile`, `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${c}), percentile_disc(0.25) WITHIN GROUP (ORDER BY ${c}) FROM typed`);
    yield q(`${c} sum OVER`, `SELECT id, sum(${c}) OVER (ORDER BY id), avg(${c}) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} abs/sign/-`, `SELECT id, abs(${c}), sign(${c}), -${c}, +${c} FROM typed ORDER BY id`);
    yield q(`${c} ceil/floor/round/trunc`, `SELECT id, ceil(${c}), ceiling(${c}), floor(${c}), round(${c}), trunc(${c}) FROM typed ORDER BY id`);
    yield q(`${c} round(x, 1)`, `SELECT id, round(${c}, 1), trunc(${c}, 1) FROM typed ORDER BY id`);
    yield q(`${c} round(x::numeric, 2)`, `SELECT id, round(${c}::numeric, 2) FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} sqrt/power/exp/ln`, `SELECT id, sqrt(abs(${c})), power(${c}, 2), ${c} ^ 2, exp(${c} / 1000), ln(abs(${c}) + 1), log(abs(${c}) + 1) FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} width_bucket`, `SELECT id, width_bucket(${c}, -10, 10, 4) FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} to_char`, `SELECT id, to_char(${c}, 'FM999,999,990.00'), to_char(${c}, '9999') FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} = ANY array`, `SELECT id FROM typed WHERE ${c} = ANY (ARRAY[0, 1, 7]) OR ${c} <> ALL (ARRAY[2, 3]) ORDER BY id`);
    yield q(`${c} = ANY ai`, `SELECT id FROM typed WHERE ${c} = ANY (ai) ORDER BY id`);
  }
  for (const c of ["i2", "i4", "i8"] as const) {
    yield q(`${c} bit operators`, `SELECT id, ${c} & 3, ${c} | 4, ${c} # 5, ~${c}, ${c} << 2, ${c} >> 1 FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} gcd/lcm/div`, `SELECT id, div(${c}, 3), gcd(${c}, 6), lcm(${c}, 4) FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} bit_and / bit_or`, `SELECT bit_and(${c}), bit_or(${c}) FROM typed WHERE ${ORDINARY}`);
    yield q(`${c} generate_series`, `SELECT id, generate_series(0, ${c} % 3) FROM typed WHERE ${ORDINARY} AND ${c} >= 0 ORDER BY 1, 2`);
  }

  // ---- text: each pair, each function a report uses -------------------------------------------------------------
  for (const [a, b] of pairs(TEXTS)) {
    for (const op of OPS) yield q(`${a} ${op} ${b}`, `SELECT id FROM typed WHERE ${a} ${op} ${b} ORDER BY id`);
    yield q(`${a} || ${b}`, `SELECT id, ${a} || ${b}, concat_ws('-', ${a}, ${b}), greatest(${a}, ${b}), least(${a}, ${b}) FROM typed ORDER BY id`);
  }
  const TEXT_FUNCTIONS = [
    "length(c)", "char_length(c)", "octet_length(c)", "lower(c)", "upper(c)", "initcap(c)", "trim(c)", "ltrim(c)", "rtrim(c)", "btrim(c, ' a')",
    "substr(c, 2)", "substr(c, 1, 2)", "substring(c from 1 for 2)", "left(c, 1)", "right(c, 1)", "left(c, -1)", "lpad(c, 4, '*')", "rpad(c, 4)",
    "replace(c, 'a', 'x')", "reverse(c)", "position('a' in c)", "strpos(c, 'b')", "split_part(c, ' ', 2)", "md5(c)", "repeat(c, 2)", "ascii(c)",
    "translate(c, 'ab', 'xy')", "c LIKE 'a%'", "c ILIKE 'A%'", "c NOT LIKE '%b'", "c ~ '^a'", "c ~* '^a'", "c !~ 'b'", "regexp_replace(c, '[ab]', '-', 'g')",
    "starts_with(c, 'a')", "c::text = ''", "quote_literal(c)", "quote_ident(c)", "to_hex(length(c))", "chr(65 + length(c))",
  ];
  for (const c of TEXTS) {
    for (const f of TEXT_FUNCTIONS) yield q(f.replace(/\bc\b/g, c), `SELECT id, ${f.replace(/\bc\b/g, c)} FROM typed ORDER BY id`);
    yield q(`${c} string_agg DISTINCT`, `SELECT string_agg(DISTINCT ${c}, ',' ORDER BY ${c}) FROM typed`);
    yield q(`${c}::int where numeric`, `SELECT id, ${c}::int, ${c}::numeric, ${c}::float8 FROM typed WHERE ${c} ~ '^[0-9]+$' ORDER BY id`);
    yield q(`${c}::char(3)`, `SELECT id, ${c}::char(3), ${c}::varchar(2), ${c}::name FROM typed ORDER BY id`);
  }

  // ---- times: each pair compared and subtracted, the units of date_trunc and extract, intervals -------------------
  for (const [a, b] of pairs(TIMES)) {
    for (const op of OPS) yield q(`${a} ${op} ${b}`, `SELECT id FROM typed WHERE ${a} ${op} ${b} ORDER BY id`);
    yield q(`${a} - ${b}`, `SELECT id, ${a} - ${b} FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${a}::${COLUMNS[b]}`, `SELECT id, ${a}::${COLUMNS[b]} FROM typed ORDER BY id`);
  }
  for (const c of [...TIMES, "iv", "tm"] as const) {
    for (const unit of ["microseconds", "milliseconds", "second", "minute", "hour", "day", "week", "month", "quarter", "year", "decade", "century", "millennium"]) {
      yield q(`date_trunc('${unit}', ${c})`, `SELECT id, date_trunc('${unit}', ${c}) FROM typed ORDER BY id`);
    }
    for (const field of ["century", "day", "decade", "dow", "doy", "epoch", "hour", "isodow", "isoyear", "microseconds", "millennium", "milliseconds", "minute", "month", "quarter", "second", "timezone", "week", "year"]) {
      yield q(`extract(${field} from ${c})`, `SELECT id, extract(${field} from ${c}), date_part('${field}', ${c}) FROM typed ORDER BY id`);
    }
    yield q(`${c} + - interval`, `SELECT id, ${c} + interval '1 day', ${c} - interval '1 month', ${c} + interval '90 minutes' FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} + iv`, `SELECT id, ${c} + iv, ${c} - iv FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} to_char`, `SELECT id, to_char(${c}, 'YYYY-MM-DD HH24:MI:SS.US'), to_char(${c}, 'FMMonth DD, YYYY') FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} isfinite`, `SELECT id, isfinite(${c}) FROM typed ORDER BY id`);
  }
  for (const c of TIMES) {
    yield q(`${c} date / ::date / ::timestamptz`, `SELECT id, ${c}::date, ${c}::timestamp, ${c}::timestamptz, date(${c}) FROM typed ORDER BY id`);
    yield q(`${c} AT TIME ZONE`, `SELECT id, ${c} AT TIME ZONE 'America/New_York', ${c} AT TIME ZONE 'UTC', timezone('Asia/Kolkata', ${c}) FROM typed ORDER BY id`);
    yield q(`${c} age`, `SELECT id, age(${c}, timestamp '2000-01-01'), age(timestamp '2030-06-15', ${c}) FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} vs now()/current_date`, `SELECT id, ${c} < now(), ${c} >= current_date - 30, ${c} > now() - interval '7 days' FROM typed ORDER BY id`);
    yield q(`${c} date_bin`, `SELECT id, date_bin(interval '15 minutes', ${c}::timestamp, timestamp '2000-01-01') FROM typed WHERE ${ORDINARY} ORDER BY id`);
    yield q(`${c} generate_series of days`, `SELECT id, generate_series(${c}::date, ${c}::date + 2, interval '1 day')::date FROM typed WHERE ${ORDINARY} ORDER BY 1, 2`);
  }
  yield q("d + / - integer", "SELECT id, d + 1, d - 7, d - i2, d + i4 % 30 FROM typed WHERE id < 100 ORDER BY id");
  yield q("make_date / make_timestamp / make_interval", "SELECT id, make_date(2026, i4 % 12 + 1, 1), make_timestamp(2026, 1, 1, 0, 0, 1.5), make_interval(days => i4 % 30), make_timestamptz(2026, 1, 2, 3, 4, 5) FROM typed WHERE id < 100 AND i4 IS NOT NULL ORDER BY id");
  yield q("to_timestamp(epoch)", "SELECT id, to_timestamp(i4) FROM typed WHERE id < 100 ORDER BY id");
  yield q("interval * / number", "SELECT id, iv * 2, iv * 1.5, iv / 2, -iv FROM typed WHERE id < 100 ORDER BY id");
  yield q("interval sum / avg", "SELECT sum(iv), avg(iv) FROM typed WHERE id < 100");
  yield q("justify_* interval", "SELECT id, justify_days(iv), justify_hours(iv), justify_interval(iv) FROM typed ORDER BY id");
  yield q("time - time / time + interval", "SELECT id, tm - time '06:00', tm + interval '1 hour' FROM typed ORDER BY id");
  yield q("timestamptz literal zones", "SELECT id FROM typed WHERE tz >= '2024-02-29 23:00:00 America/New_York' AND tz < timestamptz '2026-12-31 00:00:00+05' ORDER BY id");

  // ---- booleans, uuids ------------------------------------------------------------------------------------------
  yield q("boolean logic", "SELECT id, b AND true, b OR false, NOT b, b IS TRUE, b IS NOT FALSE, b IS UNKNOWN, b = true, b::int, b::text FROM typed ORDER BY id");
  yield q("boolean aggregates", "SELECT bool_and(b), bool_or(b), every(b), count(*) FILTER (WHERE b), count(*) FILTER (WHERE NOT b) FROM typed");
  yield q("uuid functions", "SELECT id, u::text, upper(u::text), u = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid, md5(u::text) FROM typed ORDER BY id");

  // ---- json, jsonb -----------------------------------------------------------------------------------------------
  for (const c of ["j", "jb"] as const) {
    const fn = c === "j" ? "json" : "jsonb";
    yield q(`${c} -> ->> #> #>>`, `SELECT id, ${c} -> 'a', ${c} ->> 'a', ${c} -> 1, ${c} ->> 0, ${c} #> '{b,1}', ${c} #>> '{b,1,c}' FROM typed ORDER BY id`);
    yield q(`${fn}_typeof`, `SELECT id, ${fn}_typeof(${c}) FROM typed ORDER BY id`);
    yield q(`${fn}_array_length`, `SELECT id, ${fn}_array_length(${c}) FROM typed WHERE ${fn}_typeof(${c}) = 'array' ORDER BY id`);
    yield q(`${fn}_object_keys`, `SELECT id, ${fn}_object_keys(${c}) FROM typed WHERE ${fn}_typeof(${c}) = 'object' ORDER BY 1, 2`);
    yield q(`${fn}_array_elements`, `SELECT t.id, e FROM typed t, ${fn}_array_elements(t.${c}) e WHERE ${fn}_typeof(t.${c}) = 'array' ORDER BY 1, e::text`);
    yield q(`${fn}_each_text`, `SELECT t.id, e.key, e.value FROM typed t, ${fn}_each_text(t.${c}) e WHERE ${fn}_typeof(t.${c}) = 'object' ORDER BY 1, 2`);
    // a set-returning function in a LEFT JOIN … ON TRUE, guarded by a CASE that passes only an object (a BI tool's
    // statement): a NULL or a non-object yields no rows and keeps the outer row; a json's members are its
    // text's, in its order, duplicates kept, each value as written; a jsonb's are its canonical ones
    for (const each of [`${fn}_each`, `${fn}_each_text`]) {
      // a json value is ordered by its text (json has no ordering)
      const byValue = each.endsWith("_text") ? "3" : "e.value::text";
      yield q(`${each} in a LEFT JOIN ON TRUE`, `SELECT t.id, e.key, e.value FROM typed t LEFT JOIN ${each}(CASE WHEN substring(ltrim(t.${c}::text), 1, 1) = '{' THEN t.${c} ELSE NULL END) e ON TRUE ORDER BY 1, 2, ${byValue}`);
      // the members' order, which no ORDER BY decides: aggregated as the function yields them
      yield q(`${each}: the members' order`, `SELECT t.id, (SELECT string_agg(e.key || '=' || coalesce(e.value::text, 'NULL'), ', ') FROM ${each}(t.${c}) e) AS members FROM typed t WHERE ${fn}_typeof(t.${c}) = 'object' ORDER BY 1`);
    }
    yield q(`${fn}_agg / ${fn}_object_agg`, `SELECT ${fn}_agg(${c} ORDER BY id), ${fn}_object_agg(id, ${c} ORDER BY id) FROM typed`);
    yield q(`sum / avg of ${c} ->> as numeric`, `SELECT sum((${c} ->> 'a')::numeric), avg((${c} ->> 'a')::decimal), avg((${c} #>> '{a}')::numeric) FROM typed WHERE ${fn}_typeof(${c} -> 'a') = 'number'`);
    yield q(`${c}::text / ->> cast`, `SELECT id, ${c}::text, (${c} ->> 'a')::numeric, (${c} -> 'a')::text FROM typed WHERE ${fn}_typeof(${c}) = 'object' ORDER BY id`);
  }
  // THE REVIEW OF THE NATIVE READ: a jsonb the statement computes is the rewrite's text and may hold a key
  // twice (Postgres reads the LAST, at every level); the column a read is made off is named in every arm of the read
  // as Postgres resolved it (a name another FROM item has in another case, a subquery's twins)
  yield q("->> of jsonb_object_agg holding a key twice, in a CTE", "WITH w AS (SELECT jsonb_object_agg('a', t ORDER BY id) AS d FROM typed WHERE t IS NOT NULL) SELECT d ->> 'a' FROM w");
  yield q("->> of jsonb_object_agg holding a key twice, in a subquery", "SELECT d ->> 'a' FROM (SELECT jsonb_object_agg('a', t ORDER BY id) AS d FROM typed WHERE t IS NOT NULL) s");
  yield q("->> of jsonb_build_object holding a key twice", "SELECT id, d ->> 'a' FROM (SELECT id, jsonb_build_object('a', t, 'a', vc || '!') AS d FROM typed) s ORDER BY id");
  yield q("->> of a key twice in an arm of a UNION ALL", "SELECT d ->> 'a' FROM (SELECT jb AS d FROM typed WHERE id = 4 UNION ALL SELECT jsonb_build_object('a', 'p', 'a', t) FROM typed WHERE id = 2) s ORDER BY 1");
  yield q("a key twice in a nested computed jsonb", "SELECT id, d -> 'o' ->> 'a', d #>> '{o,a}' FROM (SELECT id, jsonb_build_object('o', jsonb_build_object('a', t, 'a', vc || '!')) AS d FROM typed) s ORDER BY id");
  yield q("->> of json_object_agg holding a key twice, in a CTE", "WITH w AS (SELECT json_object_agg('a', t ORDER BY id) AS d FROM typed WHERE t IS NOT NULL) SELECT d ->> 'a' FROM w");
  yield q("a json column beside its name in another case, joined", 'SELECT t.id, "JB" ->> \'a\', jb ->> \'a\', "J" ->> \'a\', j ->> \'a\' FROM typed t JOIN jcased c ON c.id = t.id ORDER BY 1');
  yield q("a json column beside its name in another case, bare", 'SELECT "JB" ->> \'a\', "J" -> \'o\' ->> \'a\' FROM typed, jcased ORDER BY 1, 2');
  yield q("a subquery's json column beside its twin", 'SELECT id, "J" ->> \'a\', j ->> \'a\', "J" #>> \'{b,1,c}\' FROM (SELECT id, jb AS "J", j FROM typed) s ORDER BY id');
  // a `#>` element is an index as Postgres's strtoint reads one: a sign and white space before it, nothing after it
  yield q("#> path elements read as an array index", "SELECT id, " + ["{+1}", "{\" 1\"}", "{\"1 \"}", "{01}", "{-1}", "{\" -1\"}", "{+-1}", "{1.0}", "{99999999999}"]
    .flatMap((e) => [`"JB" #>> '${e}'`, `"J" #>> '${e}'`]).join(", ") + ", jsonb_extract_path_text(\"JB\", '+1'), json_extract_path_text(\"J\", ' 1'), \"JB\" #>> '{o,b,+1}' FROM jcased ORDER BY id");
  yield q("jsonb operators", "SELECT id, jb @> '{\"a\": 1}', jb <@ '{\"a\": 1, \"b\": 2}', jb ? 'a', jb ?| ARRAY['a', 'z'], jb ?& ARRAY['a', 'b'], jb || '{\"z\": 0}', jb - 'a' FROM typed ORDER BY id");
  yield q("jsonb sorted", "SELECT id, jb FROM typed ORDER BY jb, id");
  // ---- jsonb's order and equality (src/duck/jsonb-order.ts), over JORDER: every pair compared, sorted every way ----
  yield q("jsonb: every pair compared", "SELECT a.id, string_agg(CASE WHEN a.j < b.j THEN '<' WHEN a.j = b.j THEN '=' WHEN a.j > b.j THEN '>' ELSE 'n' END, '' ORDER BY b.id) FROM jorder a, jorder b GROUP BY a.id ORDER BY 1");
  yield q("jsonb: every pair by <=, >=, <>", "SELECT a.id, count(*) FILTER (WHERE a.j <= b.j), count(*) FILTER (WHERE a.j >= b.j), count(*) FILTER (WHERE a.j <> b.j) FROM jorder a, jorder b GROUP BY a.id ORDER BY 1");
  yield q("jsonb: sorted", "SELECT id, j FROM jorder ORDER BY j, id");
  yield q("jsonb: sorted DESC NULLS FIRST", "SELECT id FROM jorder ORDER BY j DESC NULLS FIRST, id");
  // the BI tool's click on a column (Trevor.io): its NULLs first, then the values in descending order
  yield q("jsonb: a BI tool's sort of a clicked column", `SELECT "e"."id", "e"."j" FROM "public"."jorder" AS "e" ORDER BY ("e"."j") IS NULL ASC, "e"."j" DESC, "e"."id" LIMIT 100`);
  yield q("jsonb: sorted by a member, in a window, in an aggregate", "SELECT id, rank() OVER (ORDER BY j), row_number() OVER (ORDER BY j -> 'a', id), count(*) OVER (PARTITION BY j) FROM jorder ORDER BY id");
  yield q("jsonb: an aggregate's ORDER BY", "SELECT string_agg(id::text, ',' ORDER BY j DESC, id), jsonb_agg(j ORDER BY j, id) FROM jorder");
  yield q("jsonb: grouped, counted", "SELECT count(*), min(id), max(id) FROM jorder GROUP BY j ORDER BY 2");
  yield q("jsonb: grouped by a member", "SELECT count(*), min(id) FROM jorder GROUP BY j -> 'a' ORDER BY 2");
  yield q("jsonb: count(DISTINCT)", "SELECT count(DISTINCT j), count(DISTINCT j -> 'a') FROM jorder");
  yield q("jsonb: DISTINCT ON", "SELECT DISTINCT ON (j) id, j FROM jorder ORDER BY j, id");
  yield q("jsonb: DISTINCT, counted", "SELECT count(*) FROM (SELECT DISTINCT j FROM jorder) s");
  yield q("jsonb: IN, BETWEEN, = ANY", "SELECT id FROM jorder WHERE j IN ('1', '[]', '{\"a\": 1.0}', '\"E\"') OR j BETWEEN '\"b\"' AND '\"z\"' OR j = ANY (ARRAY['[1]'::jsonb, '{}']) ORDER BY id");
  yield q("jsonb: IS DISTINCT FROM, NULLIF, CASE", "SELECT id, j IS DISTINCT FROM '1.00', j IS NOT DISTINCT FROM '[]', nullif(j, '[]'), CASE j WHEN '{}' THEN 'empty' WHEN '1' THEN 'one' ELSE 'other' END FROM jorder ORDER BY id");
  yield q("jsonb: joined on =", "SELECT a.id, b.id FROM jorder a JOIN jorder b ON a.j = b.j AND a.id < b.id ORDER BY 1, 2");
  yield q("jsonb: HAVING", "SELECT min(id), count(*) FROM jorder GROUP BY j HAVING j > '[]' AND count(*) > 1 ORDER BY 1");
  // json has no ordering and no equality: Postgres refuses each (42883), and so does Mason, in Postgres's words
  yield q("json: sorted", "SELECT id FROM jorder ORDER BY js");
  yield q("json: grouped", "SELECT js, count(*) FROM jorder GROUP BY js");
  yield q("json: DISTINCT", "SELECT DISTINCT js FROM jorder");
  yield q("json: compared", "SELECT id FROM jorder WHERE js = js");
  yield q("jsonb_strip_nulls / jsonb_pretty / jsonb_set", "SELECT id, jsonb_strip_nulls(jb), jsonb_set(jb, '{a}', '9') FROM typed WHERE jsonb_typeof(jb) = 'object' ORDER BY id");

  // ---- arrays -----------------------------------------------------------------------------------------------------
  yield q("array subscripts and length", "SELECT id, ai[1], ai[2:3], at[1], array_length(ai, 1), cardinality(ai), array_upper(ai, 1), array_lower(ai, 1) FROM typed ORDER BY id");
  // a literal is the value Postgres parsed, in every form it reads (DuckDB reads ISO alone)
  yield q("date literals Postgres reads", "SELECT id FROM typed WHERE d > '01/02/2026' OR d = 'March 1, 2026' OR d < '0001-01-01 BC' ORDER BY id");
  yield q("time literals Postgres reads", "SELECT id, ts - timestamp 'epoch', tz > timestamptz '0044-03-15 12:00:00+00 BC', iv + interval '1 day ago', iv - interval 'P1DT2H', iv + interval '@ 3 hours' FROM typed WHERE id < 100 ORDER BY id");
  // a float rounded into a numeric, as text: Postgres's `25`, never a double's `25.0` (a review finding)
  for (const c of ["f4", "f8"]) {
    yield q(`${c} rounded into numeric as text`, `SELECT id, round(${c} / 3 * 100)::numeric::text || '%', (${c}::numeric)::text, concat(${c}::numeric), trunc(${c})::numeric FROM typed WHERE id < 100 ORDER BY id`);
  }
  // a citext: compared, matched and sorted without regard to case; grouped, refused (Mason gap citext-forms)
  yield q("citext compared with text", "SELECT id, ci = 'FINALIZED', ci <> 'finalized', ci = t, ci::text = 'finalized', lower(ci), ci || '!' FROM typed ORDER BY id");
  yield q("citext LIKE", "SELECT id FROM typed WHERE ci LIKE 'final%' OR ci ILIKE 'DR%' OR ci NOT LIKE 'f%' ORDER BY id");
  yield q("citext IN / ANY", "SELECT id FROM typed WHERE ci IN ('finalized', 'draft') OR ci = ANY (ARRAY['É'::citext]) ORDER BY id");
  yield q("citext ordered", "SELECT id, ci FROM typed WHERE id <> 104 ORDER BY ci, id");
  yield q("citext filter counted", "SELECT count(*) FROM typed WHERE ci = 'finalized'");
  yield q("citext grouped", "SELECT ci, count(*) FROM typed GROUP BY ci ORDER BY 1");
  yield q("citext DISTINCT", "SELECT DISTINCT ci FROM typed ORDER BY 1");
  yield q("citext min / max", "SELECT min(ci), max(ci) FROM typed");
  yield q("citext lowered and grouped", "SELECT lower(ci), count(*) FROM typed GROUP BY 1 ORDER BY 1");
  // an inet: its own text, equality, its functions; its order refused (Mason gap inet-order)
  yield q("inet written and compared", "SELECT id, ip, ip::text, ip = '10.3.6.45/32', ip = '10.3.6.45', host(ip), masklen(ip), family(ip), abbrev(ip) FROM typed ORDER BY id");
  yield q("inet ordered", "SELECT id FROM typed ORDER BY ip, id");
  yield q("inet less than", "SELECT id FROM typed WHERE ip < '10.3.6.45' ORDER BY id");
  yield q("inet min", "SELECT min(ip) FROM typed");
  yield q("inet grouped", "SELECT ip, count(*) FROM typed GROUP BY ip ORDER BY count(*), ip::text");
  yield q("inet to_json", "SELECT id, to_json(ip), concat(ip), format('%s', ip) FROM typed ORDER BY id");
  // the array types the review found sent as text[], and a bytea
  // (n is an unconstrained numeric holding 0 beside 1.5: one scale per DuckDB column, mixed-scale-numeric; at a declared
  // scale it is exact)
  yield q("json arrays and a bytea", "SELECT id, jba, ja, vca, by, jba[1], vca[2], array_length(jba, 1), n::numeric(30, 1), ca, ia, ca[1], ia[1] FROM typed_arrays ORDER BY id");
  yield q("json arrays unnested", "SELECT id, unnest(jba), unnest(vca) FROM typed_arrays ORDER BY 1, 2::text, 3");
  // Metabase's week from Sunday: the literals of the GROUP BY and ORDER BY repeat the SELECT list's
  yield q("time literals grouped", "SELECT (date_trunc('week', (ts + INTERVAL '1 day')) + INTERVAL '-1 day') AS w, count(*) FROM typed GROUP BY (date_trunc('week', (ts + INTERVAL '1 day')) + INTERVAL '-1 day') ORDER BY (date_trunc('week', (ts + INTERVAL '1 day')) + INTERVAL '-1 day')");
  // `unicode` is ICU's root locale under Postgres's own name
  yield q("COLLATE unicode", 'SELECT id, t FROM typed ORDER BY t COLLATE "unicode", id');
  yield q("array operators", "SELECT id, ai || 4, 0 || ai, ai || ARRAY[5, 6], ai @> '{1}', ai <@ '{1,2,3}', ai && '{1,9}', ai = '{1,2}' FROM typed ORDER BY id");
  yield q("array ANY / ALL", "SELECT id FROM typed WHERE 3 = ANY (ai) OR 'a' = ANY (at) ORDER BY id");
  yield q("array functions", "SELECT id, array_to_string(ai, ','), array_to_string(at, ',', '*'), array_position(ai, 2), array_append(ai, 7), array_prepend(7, ai), array_cat(ai, ai), array_remove(ai, 1) FROM typed ORDER BY id");
  yield q("array sorted / grouped", "SELECT ai, count(*) FROM typed GROUP BY ai ORDER BY ai");
  yield q("unnest in the SELECT list", "SELECT id, unnest(ai) FROM typed ORDER BY 1, 2");
  yield q("unnest in FROM", "SELECT t.id, x FROM typed t, unnest(t.at) x ORDER BY 1, 2");
  yield q("array_agg of an array column", "SELECT array_agg(at ORDER BY id) FILTER (WHERE cardinality(at) = 2) FROM typed");
  yield q("string_to_array / regexp_split", "SELECT id, string_to_array(t, 'a'), array_to_string(string_to_array(vc, ''), '.') FROM typed ORDER BY id");

  // ---- the corpus run's unverified pieces: each refused by the allowlist on a real BI tool's SQL ----------------------
  // a window's max / min of every type, and the polymorphic window functions with every argument form
  for (const c of ALL) {
    yield q(`${c} window max / min`, `SELECT id, max(${c}) OVER (PARTITION BY id % 3), min(${c}) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM typed ORDER BY id`);
    yield q(`${c} window lead / lag / nth_value`, `SELECT id, lead(${c}) OVER (ORDER BY id), lead(${c}, 2, ${c}) OVER (ORDER BY id), lag(${c}, 2) OVER (ORDER BY id), lag(${c}, 1, ${c}) OVER (ORDER BY id), nth_value(${c}, 2) OVER (ORDER BY id), last_value(${c}) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM typed ORDER BY id`);
  }
  // (row_number and ntile number the rows of a tie in any order: theirs is ordered to the row)
  yield q("window rank family", "SELECT id, rank() OVER w, dense_rank() OVER w, percent_rank() OVER w, cume_dist() OVER w, row_number() OVER v, ntile(3) OVER v FROM typed WINDOW w AS (ORDER BY b NULLS FIRST), v AS (ORDER BY b NULLS FIRST, id) ORDER BY id");
  yield q("window aggregate FILTER", "SELECT id, count(*) FILTER (WHERE b) OVER (), sum(i4) FILTER (WHERE i4 > 0) OVER (PARTITION BY b ORDER BY id), max(t) FILTER (WHERE t <> '') OVER (ORDER BY id) FROM typed WHERE id < 100 ORDER BY id");
  yield q("NOT ILIKE / !~*", "SELECT id FROM typed WHERE t NOT ILIKE 'a%' AND t !~* '^b' ORDER BY id");
  yield q("WITH … AS MATERIALIZED", "WITH x AS MATERIALIZED (SELECT id, t FROM typed), y AS NOT MATERIALIZED (SELECT id FROM typed WHERE b) SELECT x.id, x.t FROM x JOIN y USING (id) ORDER BY 1");
  yield q("boolean compared", "SELECT id, b <> true, b <> b, b = NOT b, b < true, b >= false FROM typed ORDER BY id");
  // a text read as each type: Postgres's input functions accept far more than ISO (castable's ranges, above)
  yield q("text as integers", "SELECT id, s::bigint, s::int, CAST(s AS bigint) FROM castable WHERE id BETWEEN 1 AND 9 ORDER BY id");
  yield q("text as smallint", "SELECT id, s::smallint FROM castable WHERE id BETWEEN 1 AND 8 ORDER BY id");
  yield q("text as bigint, its widest", "SELECT id, s::bigint FROM castable WHERE id = 10");
  yield q("text as integer, out of range", "SELECT id, s::int FROM castable WHERE id = 10");
  yield q("text as integer, not one", "SELECT id, s::int FROM castable WHERE id = 99");
  yield q("text as boolean", "SELECT id, s::boolean, CAST(s AS bool) FROM castable WHERE id BETWEEN 11 AND 19 ORDER BY id");
  yield q("text as boolean, not one", "SELECT id, s::boolean FROM castable WHERE id = 99");
  yield q("text as date / timestamp / timestamptz", "SELECT id, s::date, s::timestamp, s::timestamptz FROM castable WHERE id BETWEEN 21 AND 46 ORDER BY id");
  yield q("text as date, not one", "SELECT id, s::date FROM castable WHERE id = 99");
  yield q("text as timestamptz, not one", "SELECT id, s::timestamptz FROM castable WHERE id = 51");
  yield q("text as date, compared and computed", "SELECT id, s::date + 1, s::date - date '2026-01-01', s::timestamptz > timestamptz '2026-01-01' FROM castable WHERE id BETWEEN 21 AND 31 ORDER BY id");
  yield q("text as interval", "SELECT id, s::interval, CAST(s AS interval) + interval '1 day' FROM castable WHERE id BETWEEN 51 AND 69 ORDER BY id");
  yield q("text as interval, built", "SELECT id, (i4 || ' days')::interval, (i2 || ' hours')::interval, now() - (abs(i4) || ' minutes')::interval < now() FROM typed WHERE id < 100 AND i4 IS NOT NULL ORDER BY id");
  yield q("text as interval, not one", "SELECT id, s::interval FROM castable WHERE id = 99");
  yield q("text as numeric", "SELECT id, s::numeric FROM castable WHERE id BETWEEN 71 AND 78 AND id <> 76 ORDER BY id");
  // (a NaN read into a numeric(p, s) is refused by name: DuckDB's decimal has none, numeric-special)
  yield q("text as numeric(p, s)", "SELECT id, s::numeric(30, 4) FROM castable WHERE id BETWEEN 71 AND 78 AND id NOT IN (74, 76) ORDER BY id");
  yield q("text as numeric(p, s), a NaN", "SELECT id, s::numeric(30, 4) FROM castable WHERE id = 74");
  // what Metabase writes and the endpoint refused as unverified (its findings on #517): a float's spread, a
  // smallint difference, a filter on an inet, a time's hour as a time, the session's zone, a numeric's log
  // (rounded: their last digit is each engine's accumulator's, float-last-digit)
  // (stddev and variance too: the unrounded "f8 stddev/variance" is decided on x86_64, where its last digit parts)
  yield q("stddev / variance of a double", "SELECT round(stddev_pop(f8)::numeric, 9), round(var_pop(f8)::numeric, 9), round(var_samp(f8)::numeric, 9), round(stddev_samp(f8)::numeric, 9), round(stddev(f8)::numeric, 9), round(variance(f8)::numeric, 9) FROM typed WHERE id < 100 AND abs(f8) < 1e6");
  yield q("smallint minus smallint", "SELECT id, i2 - i2, i2 - (i2 / 2)::smallint, i2 + i2, -i2 FROM typed WHERE i2 BETWEEN -1000 AND 1000 ORDER BY id");
  yield q("an inet equal to a varchar cast", "SELECT id FROM typed WHERE ip = CAST('10.3.6.45'::varchar AS inet) OR ip = CAST('::1' AS inet) ORDER BY id");
  yield q("make_time of a time's hour", "SELECT make_time(extract(hour from tm)::integer, 0, 0.0) AS h, make_time(extract(hour from tm)::integer, extract(minute from tm)::integer, 0.0), count(*) FROM typed GROUP BY 1, 2 ORDER BY 1, 2");
  yield q("current_setting beside a table", "SELECT id, current_setting('TimeZone') FROM typed WHERE id < 3 ORDER BY id");
  yield q("log / ln / exp / sqrt / power of a numeric", "SELECT id, log(10, n2), log(n2), ln(n2), log10(n2), exp(n2 / 100), sqrt(n2), power(n2, 2), round(log(n2), 3) FROM typed WHERE n2 BETWEEN 0.01 AND 1000 ORDER BY id");
  yield q("ln / sqrt of an unconstrained numeric, a quotient", "SELECT id, ln(n), sqrt(n), ln(n / 3), sqrt(n2 / 7) FROM typed WHERE n > 0 AND n < 1e6 AND n2 > 0 ORDER BY id");
  yield q("sum / avg of a numeric's ln", "SELECT sum(ln(n2)), avg(sqrt(n2)), sum(exp(n2 / 1000)) FROM typed WHERE n2 BETWEEN 0.01 AND 1000");
  // a text read as an unconstrained numeric, summed: Postgres's exact sum at the most decimals a row's text has
  // (Metabase's JSON numbers), a NaN or an infinity as Postgres adds them
  const FINITE = "id BETWEEN 71 AND 78 AND id NOT IN (74, 76)";
  yield q("sum / avg of a text as numeric", `SELECT sum(s::numeric), avg(s::numeric), sum(s::decimal) FILTER (WHERE id > 72), count(*) FROM castable WHERE ${FINITE}`);
  yield q("sum / avg of a text as numeric, grouped", `SELECT id % 2, sum(s::numeric), avg(s::numeric) FROM castable WHERE ${FINITE} GROUP BY 1 ORDER BY 1`);
  yield q("sum of a text as numeric, a window", `SELECT id, sum(s::numeric) OVER (ORDER BY id), avg(s::numeric) OVER () FROM castable WHERE ${FINITE} ORDER BY id`);
  yield q("sum of a text as numeric, a NaN", "SELECT sum(s::numeric), avg(s::numeric) FROM castable WHERE id IN (71, 74)");
  yield q("sum of a text as numeric, an infinity", "SELECT sum(s::numeric) FROM castable WHERE id IN (71, 76)");
  yield q("sum of a text as numeric, no rows", "SELECT sum(s::numeric), avg(s::numeric) FROM castable WHERE id IN (71, 72) AND s = 'none'");
  yield q("text as float8 / real", "SELECT id, s::float8, s::real FROM castable WHERE id BETWEEN 71 AND 77 ORDER BY id");
  yield q("text as uuid", "SELECT id, s::uuid FROM castable WHERE id BETWEEN 81 AND 83 ORDER BY id");
  yield q("text as json / jsonb", "SELECT id, s::json, s::jsonb, s::json::jsonb FROM castable WHERE id BETWEEN 91 AND 93 ORDER BY id");
  yield q("text as jsonb, not one", "SELECT id, s::jsonb FROM castable WHERE id = 99");
  yield q("json as jsonb, jsonb as json", "SELECT id, j::jsonb, jb::json, j::jsonb -> 'a', (jb::json) ->> 'a' FROM typed ORDER BY id");
  // generate_series in each form Postgres has
  yield q("generate_series of integers, stepped", "SELECT * FROM generate_series(1, 10, 3) g, generate_series(5::bigint, 1, -2) h ORDER BY 1, 2");
  yield q("generate_series of numerics", "SELECT g FROM generate_series(1.5, 3, 0.5) g ORDER BY 1");
  yield q("generate_series of dates", "SELECT g::date, g FROM generate_series('2026-01-30'::date, '2026-03-02'::date, interval '1 month') g ORDER BY 1");
  yield q("generate_series of timestamps", "SELECT g FROM generate_series(timestamp '2026-03-07 12:00', timestamp '2026-03-09 12:00', interval '12 hours') g ORDER BY 1");
  yield q("generate_series in the SELECT list, aliased", "SELECT id, generate_series(1, 2) AS n FROM typed WHERE id < 4 ORDER BY 1, 2");
  yield q("generate_series empty and backwards", "SELECT count(*) FROM generate_series(3, 1) g");
  // jsonpath (Postgres's own language over jsonb)
  yield q("jsonb_path_query_array / _first / _exists", "SELECT id, jsonb_path_query_array(jb, '$.b[*]'), jsonb_path_query_first(jb, '$.b[1].c'), jsonb_path_exists(jb, '$.a'), jsonb_path_query_array(jb, '$[*] ? (@ > 1)'), jsonb_path_query_array(jb, 'strict $.a', '{}', true), jsonb_path_query_array(jb, '$.*'), jsonb_path_query_array(jb, '$.a.type()'), jsonb_path_query_array(jb, '$.size()') FROM typed ORDER BY id");
  yield q("jsonpath strict, an error", "SELECT id, jsonb_path_query_array(jb, 'strict $.a') FROM typed ORDER BY id");
  yield q("jsonpath operators", "SELECT id, jb @? '$.a', jb @@ '$.a == 1', jb @? '$[*] ? (@ == 2)' FROM typed ORDER BY id");
  yield q("jsonb_path_query", "SELECT t.id, p FROM typed t, jsonb_path_query(t.jb, '$.b[*]') p ORDER BY 1, p::text");
  // a row as a value: its text, its json
  yield q("a row as json", "SELECT r.id, row_to_json(r), to_jsonb(r), to_json(r) FROM (SELECT id, i4, n2, t, b, ts, tz, at FROM typed) r ORDER BY r.id");
  yield q("json_agg of arrays", "SELECT json_agg(ai ORDER BY id), jsonb_agg(ai ORDER BY id), json_agg(at ORDER BY id) FROM typed WHERE id < 100");
  yield q("rows aggregated as json", "SELECT json_agg(r ORDER BY r.id), jsonb_agg(r ORDER BY r.id) FROM (SELECT id, t, b FROM typed WHERE id < 5) r");
  yield q("a row as its text", "SELECT r FROM (SELECT id, t, b, at, n2 FROM typed) r ORDER BY r.id");
  yield q("a table's row", "SELECT row_to_json(castable), castable FROM castable WHERE id < 3 ORDER BY id");
  yield q("an anonymous row", "SELECT id, ROW(id, t, b), (id, t)::text FROM typed ORDER BY id");
  // a bytea: its text and its functions
  yield q("bytea functions", "SELECT id, by, by::text, encode(by, 'hex'), encode(by, 'base64'), encode(by, 'escape'), length(by), octet_length(by), md5(by), by = '\\x00ff' FROM typed_arrays ORDER BY id");
  yield q("bytea decoded", "SELECT decode('00ff', 'hex'), decode('AP8=', 'base64'), '\\x00ff'::bytea, 'abc'::bytea, convert_to('é', 'UTF8')");
  // arrays of varchar, json and jsonb: their text and their functions
  yield q("json[] / jsonb[] as json: array_to_json", "SELECT id, array_to_json(jba), array_to_json(ja) FROM typed_arrays ORDER BY id");
  yield q("json[] / jsonb[] as json", "SELECT id, to_json(jba), to_json(ja), to_jsonb(jba), to_jsonb(ja), json_build_array(jba, ja), json_build_object('a', jba) FROM typed_arrays ORDER BY id");
  yield q("varchar[] / json[] / jsonb[] as text", "SELECT id, vca::text, jba::text, ja::text, array_to_string(vca, ','), vca = '{alpha}', 'a b' = ANY (vca), cardinality(jba) FROM typed_arrays ORDER BY id");
  // a relative time written as a literal is the transaction's start, as now() and current_date are
  yield q("relative time literals", "SELECT 'now'::timestamptz = now(), 'today'::date = current_date, 'tomorrow'::date - 'yesterday'::date, 'today'::timestamptz = date_trunc('day', now()), timestamp 'today' = current_date::timestamp, date 'tomorrow' = current_date + 1");
  yield q("relative time literals filtering", "SELECT id FROM typed WHERE tz < 'now' AND d <= 'today' AND ts < 'tomorrow' ORDER BY id");
  // ---- text in the database's order (src/duck/libc-order.ts): sorted, a field list's LIMIT, compared, min / max -----
  yield q("text in the database's order", "SELECT id, s FROM coll WHERE id < 50 ORDER BY s, id");
  yield q("text in the database's order, descending", "SELECT s FROM coll WHERE id < 50 ORDER BY s DESC NULLS LAST, id");
  yield q("a field's values, as Metabase lists them", "SELECT s FROM coll WHERE id < 50 GROUP BY s ORDER BY s ASC LIMIT 12");
  yield q("text compared in the database's order", "SELECT count(*) FILTER (WHERE s < 'b'), count(*) FILTER (WHERE s > 'Dob'), count(*) FILTER (WHERE s BETWEEN 'a' AND 'z'), count(*) FILTER (WHERE s >= '가') FROM coll WHERE id < 50");
  yield q("min and max text in the database's order", "SELECT min(s), max(s) FROM coll WHERE id < 50");
  // ---- the corpus rerun of fbbf8f08: what reached DuckDB and failed, and the pieces still unverified -------------------
  // a name another table has in another case: qualified with the table Postgres resolved it to
  yield q("a name in another case, joined", `SELECT id, "T", t, "Tz" FROM typed JOIN cased USING (id) ORDER BY id`);
  yield q("a name in another case, correlated", `SELECT id, t FROM typed x WHERE EXISTS (SELECT 1 FROM cased c WHERE c.id = x.id AND "T" = t) ORDER BY id`);
  yield q("GROUP BY an output name in another case", `SELECT upper(t) AS "T", count(*) FROM typed GROUP BY "T" ORDER BY 1`);
  // a DISTINCT aggregate's ORDER BY over a division (its zero test was a volatile error() DuckDB refuses there)
  yield q("DISTINCT aggregate ordered by a division", "SELECT array_agg(DISTINCT (t || ': ' || (i4::float8 / 2)::text) ORDER BY (t || ': ' || (i4::float8 / 2)::text)), array_agg(DISTINCT i4::float8 / nullif(i2, 0) ORDER BY i4::float8 / nullif(i2, 0)) FROM typed WHERE id < 100");
  yield q("division by zero, a float", "SELECT id, i4::float8 / i2 FROM typed WHERE id = 1");
  yield q("division by zero, a numeric", "SELECT id, n / i2 FROM typed WHERE id = 1");
  yield q("numeric modulo by zero", "SELECT id, n % i2 FROM typed WHERE id = 1");
  // a date AT TIME ZONE beside a timestamp AT TIME ZONE (a timestamp and a timestamptz in one CASE)
  yield q("date and timestamp AT TIME ZONE in one CASE", "SELECT id, date_trunc('month', CASE WHEN ts < '2000-01-01'::date THEN d AT TIME ZONE 'America/Chicago' ELSE ts AT TIME ZONE 'America/Chicago' END) FROM typed WHERE id < 100 ORDER BY id");
  // zones as Postgres reads them: an IANA name in any case, UT and Z as UTC, a zone held by a row; an abbreviation or a
  // POSIX zone (CST is -06 all year there, UTC+3 three hours west) refused
  yield q("zones as written", "SELECT id, tz AT TIME ZONE 'UT', tz AT TIME ZONE 'Z', tz AT TIME ZONE 'america/new_york', ts AT TIME ZONE 'utc', date_trunc('day', tz, 'asia/kolkata') FROM typed WHERE id < 100 ORDER BY id");
  yield q("zones held by a row", `SELECT t.id, c."Tz", t.tz AT TIME ZONE c."Tz", date_trunc('hour', t.tz, c."Tz") FROM typed t JOIN cased c USING (id) ORDER BY 1`);
  yield q("a zone abbreviation", "SELECT id, tz AT TIME ZONE 'CST' FROM typed WHERE id < 100 ORDER BY id");
  yield q("a POSIX zone", "SELECT id, tz AT TIME ZONE 'UTC+3' FROM typed WHERE id < 100 ORDER BY id");
  // regular expressions RE2 would read otherwise, answered by Postgres's engine: a lookaround, a word's start and end, a
  // pattern built at run time, and the match of a pattern whose match depends on the engine (alternation, two quantifiers)
  yield q("regex Postgres's engine matches", "SELECT id, t ~* '(?<![a-z])a', t ~ '\\mab', t ~ ('^' || vc), t ~* ('\\m' || 'b' || '\\M'), t !~ '(?=a)', t ~ '\\yé' FROM typed WHERE id < 100 ORDER BY id");
  yield q("regex matches that depend on the engine", "SELECT id, substring(t from 'a*(b)?'), substring(t from 'a|ab'), regexp_replace(t, 'a|ab', 'X', 'g'), regexp_replace(t, '(a)(b)?', '[\\1\\2]'), regexp_match(t, '(a)|(b)'), regexp_replace(t, 'A', 'z', 'gi'), regexp_replace(t, vc, '-'), substring(t from '[0-9]+') FROM typed WHERE id < 100 ORDER BY id");
  yield q("regexp_matches of groups, global", "SELECT id, regexp_matches(t, '(a)(b)?', 'g') AS m FROM typed WHERE id < 100 ORDER BY 1, 2");
  // a numeric NaN or Infinity written as a result; a time past the year 9999
  yield q("numeric NaN and Infinity as results", "SELECT id, f8::numeric, s FROM typed, (SELECT sum(s::numeric) AS s FROM castable WHERE id IN (71, 74)) x WHERE id > 100 ORDER BY id");
  yield q("a time past the year 9999", "SELECT id, tz + 3000000 * interval '1 day', ts + 3000000 * interval '1 day', d + 3000000 FROM typed WHERE id < 100 ORDER BY id");
  // timestamp(p), timestamptz(p): rounded half away from 2000-01-01
  yield q("timestamp(p) and timestamptz(p)", "SELECT id, ts::timestamp(0), ts::timestamp(1), tz::timestamptz(2), tz::timestamp(3), d::timestamp(0), CAST(ts AS timestamp(6)), ('1960-01-01 00:00:00.5'::timestamp)::timestamp(0), ('1960-01-01 00:00:00.25'::timestamp)::timestamp(1) FROM typed ORDER BY id");
  // age(t) is from the session's midnight at the transaction's start
  yield q("age of one time", "SELECT id, age(tz) = age(current_date::timestamptz, tz), age(ts) = age(current_date::timestamp, ts), age(tz, ts::timestamptz), age(ts, d::timestamp) FROM typed WHERE id < 100 ORDER BY id");
  yield q("abs and negation of integers", "SELECT id, abs(i8), -i8, abs(i4), -i4, abs(i2), -i2, abs(n), abs(f8) FROM typed WHERE id < 100 ORDER BY id");
  yield q("negation of the smallest bigint", "SELECT -i8 FROM typed WHERE id = 102");
  yield q("rtrim / ltrim / btrim of characters", "SELECT id, rtrim(t, 'a'), ltrim(t, ' s'), btrim(t, 'Ab'), rtrim(vc, 'ae'), ltrim(t) FROM typed ORDER BY id");
  yield q("arrays of times as text", "SELECT array_agg(tz ORDER BY id)::text, array_agg(ts ORDER BY id)::text, array_agg(d ORDER BY id)::text FROM typed WHERE id < 100");
  yield q("a date plus a time", "SELECT id, d + tm, d + tm > ts FROM typed WHERE id < 100 ORDER BY id");
  yield q("varchar read as uuid / date / boolean", "SELECT id, s::varchar::uuid FROM castable WHERE id BETWEEN 81 AND 83 UNION ALL SELECT id, NULL FROM castable WHERE id = 1 ORDER BY id");
  yield q("varchar read as date / boolean", "SELECT id, s::varchar(40)::date, s::varchar::timestamptz FROM castable WHERE id BETWEEN 21 AND 28 ORDER BY id");
  yield q("varchar read as boolean", "SELECT id, s::varchar::boolean FROM castable WHERE id BETWEEN 11 AND 19 ORDER BY id");
  yield q("jsonb_to_record / json_to_record", "SELECT t.id, x.a, x.b, y.a, y.b FROM typed t, jsonb_to_record(t.jb) AS x(a int, b text), json_to_record(t.j) AS y(a numeric, b jsonb) WHERE t.id IN (1, 2, 8, 9) ORDER BY 1");
  yield q("jsonb_to_record of text columns", "SELECT t.id, x.a, x.b FROM typed t, jsonb_to_record(t.jb) AS x(a text, b text) WHERE jsonb_typeof(t.jb) = 'object' ORDER BY 1");
  yield q("random()", "SELECT count(*) FROM typed WHERE random() >= 0 AND random() < 1");
  yield q("json_extract_path_text", "SELECT id, json_extract_path_text(j, 'b', '1', 'c'), json_extract_path(j, 'a'), jsonb_extract_path_text(jb, 'a'), json_extract_path_text(j, VARIADIC ARRAY['a']) FROM typed ORDER BY id");
  // ---- the rerun over BIRD and TPC-DS: what it found, and the pieces it named unverified ----------------------------
  // a numeric quotient is Postgres's rounded one: 0.3 / 0.1 and 0.9 / 0.3 are one value, counted, grouped, ranked
  yield q("numeric quotients alike", "SELECT count(DISTINCT (i4 * 0.3) / (i4 * 0.1)), count(*) FILTER (WHERE (i4 * 0.3) / (i4 * 0.1) = 3), count(DISTINCT (i4 * 0.7) / (i4 * 0.1)) FROM typed WHERE id < 100 AND i4 > 0");
  yield q("min / max of numeric quotients", "SELECT min((i4 * 0.7) / (i4 * 0.1)), max((i4 * 0.3) / (i4 * 0.1)) FROM typed WHERE id < 100 AND i4 > 0");
  // min / max of a quotient is the picked row's quotient, at its scale (the rerun at ae2c5169: max(x / 3600) read 3)
  yield q("min / max of numeric quotients, rounded and grouped", "SELECT i4 % 3 AS g, round(max(n2 / 3600), 2), round(min(i8::numeric / 3600), 4), min(n / n2) FILTER (WHERE i4 > 10), max(coalesce(n2 / nullif(i2, 0), 0)) FROM typed WHERE id < 100 GROUP BY 1 ORDER BY 1");
  yield q("min / max of an interval's hours", "SELECT min(extract(epoch FROM i4 * interval '1 hour') / 3600), round(max(extract(epoch FROM i4 * interval '1 hour') / 3600), 2), round(min(extract(epoch FROM iv)::numeric / 3600), 2) FROM typed WHERE id < 100");
  // an aggregate's argument and ORDER BY are evaluated only on the rows its FILTER keeps: no 22012 from a row filtered out
  yield q("FILTER guards the argument", "SELECT i4 % 3 AS g, sum(i4 / i2) FILTER (WHERE i2 <> 0), min(n / n2) FILTER (WHERE n2 <> 0), string_agg(t, ',' ORDER BY 100 / i2, id) FILTER (WHERE i2 <> 0), count(*) FILTER (WHERE i2 <> 0) FROM typed WHERE id < 100 GROUP BY 1 ORDER BY 1");
  yield q("FILTER guards a window's argument", "SELECT id, sum(i4 / i2) FILTER (WHERE i2 <> 0) OVER (ORDER BY id) FROM typed WHERE id < 100 ORDER BY id");
  yield q("FILTER of a DISTINCT aggregate", "SELECT i4 % 3 AS g, string_agg(DISTINCT t, ', ') FILTER (WHERE i2 <> 0), array_agg(DISTINCT vc) FILTER (WHERE i2 <> 0) FROM typed WHERE id < 100 GROUP BY 1 ORDER BY 1");
  // a numeric CASE is its arms, each computed on its own rows (an integer arm is 0, not a double's 0)
  yield q("a numeric CASE arm by arm", "SELECT id, CASE WHEN i4 > 0 THEN n2 / i4 ELSE 0 END, CASE i2 WHEN 1 THEN n WHEN 2 THEN n2 END, CASE WHEN f8 >= 0 THEN sqrt(f8)::numeric ELSE n END FROM typed WHERE id < 100 ORDER BY id");
  yield q("min / max of a numeric CASE", "SELECT i4 % 3 AS g, round(min(CASE WHEN i4 = 1 THEN 0 ELSE i4 / 3.0 END), 2), max(CASE WHEN i2 > 0 THEN n / i2 END) FROM typed WHERE id < 100 GROUP BY 1 ORDER BY 1");
  yield q("min / max of a quotient over no rows", "SELECT min(n / n2), max(n2 / 7) FROM typed WHERE false");
  yield q("numeric quotients grouped and ranked", "SELECT (i4 * 0.3) / (i4 * 0.1) AS r, count(*), rank() OVER (ORDER BY (i4 * 0.3) / (i4 * 0.1)) FROM typed WHERE id < 100 AND i4 > 0 GROUP BY 1 ORDER BY 1");
  yield q("numeric quotients of columns", "SELECT id, n / n2, n2 / i4, n / 3, i8 / n2 FROM typed WHERE id < 100 AND n2 <> 0 AND i4 <> 0 ORDER BY n / n2, id");
  yield q("numeric quotient by zero", "SELECT id, n2 / i2::numeric FROM typed WHERE id = 1");
  // a NULL time is NULL, never infinite
  yield q("extract of a NULL time", "SELECT id, extract(year FROM d), extract(epoch FROM ts), extract(day FROM tz), date_part('year', d), date_part('epoch', tz) FROM typed WHERE id < 100 ORDER BY id");
  // a text BETWEEN (two comparisons under the collation) beside another condition: one AND, one OR
  yield q("text BETWEEN beside AND / OR", "SELECT id FROM typed WHERE t BETWEEN 'a' AND 'z' AND id > 1 AND (t NOT BETWEEN 'b' AND 'c' OR t BETWEEN 'A' AND 'B' OR id > 3) ORDER BY id");
  // INTERSECT and EXCEPT, with and without ALL
  yield q("INTERSECT / EXCEPT", "SELECT t FROM typed INTERSECT SELECT vc FROM typed WHERE id > 2 ORDER BY 1");
  yield q("INTERSECT ALL / EXCEPT ALL", "(SELECT i4 FROM typed WHERE id < 100 EXCEPT ALL SELECT i2 FROM typed WHERE id > 5) UNION ALL (SELECT i2 FROM typed INTERSECT ALL SELECT i4 FROM typed) ORDER BY 1");
  yield q("EXCEPT", "SELECT d FROM typed EXCEPT SELECT ts::date FROM typed WHERE id > 5 ORDER BY 1");
  // avg of a real (float8's accumulation in Postgres), stddev and variance of an integer or a numeric (exact)
  yield q("avg of a real", "SELECT avg(f4), avg(f4) FILTER (WHERE id > 2), avg(DISTINCT f4) FROM typed WHERE id < 100");
  yield q("avg of a real OVER", "SELECT id, avg(f4) OVER (ORDER BY id) FROM typed WHERE id < 100 ORDER BY id");
  yield q("stddev of integers, grouped", "SELECT b, stddev_samp(i4), stddev_samp(i4) / avg(i4), var_samp(i8), stddev_pop(n2), variance(n2) FROM typed WHERE id < 100 GROUP BY b ORDER BY b");
  yield q("stddev of integers OVER", "SELECT id, stddev_samp(i4) OVER (ORDER BY id), var_pop(n2) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) FROM typed WHERE id < 100 ORDER BY id");
  yield q("stddev of one row and of none", "SELECT stddev(i4), stddev_pop(i4), var_samp(n2), var_pop(n2) FROM typed WHERE id = 2 UNION ALL SELECT stddev(i4), stddev_pop(i4), var_samp(n2), var_pop(n2) FROM typed WHERE id = 0");
  yield q("stddev of a numeric(18, s)", "SELECT stddev(n::numeric(18, 6)), var_pop(n::numeric(18, 4)), stddev_samp((-n)::numeric(18, 0)) FROM typed WHERE id < 100");
  yield q("stddev of DISTINCT integers", "SELECT stddev(DISTINCT i4), stddev(DISTINCT n2) FROM typed WHERE id < 100");
  yield q("stddev of the extremes", "SELECT stddev(i8), variance(i8), stddev(n2), variance(i2) FROM typed");
  // an expression over an argument Mason widens (a date where Postgres chose a timestamptz), repeated in GROUP BY and
  // ORDER BY: each copy must print alike, or DuckDB refuses the grouping (42803; the rerun at e49380ee)
  yield q("date_trunc of a date, grouped by the expression", "SELECT date_trunc('week', d) AS w, count(*), sum(i4) FROM typed WHERE id < 100 GROUP BY date_trunc('week', d) ORDER BY date_trunc('week', d)");
  yield q("date_trunc of a date in a zone, grouped by the expression", "SELECT date_trunc('month', d, 'Asia/Tokyo'), count(*) FROM typed WHERE id < 100 GROUP BY date_trunc('month', d, 'Asia/Tokyo') ORDER BY 1");
  yield q("a widened date in a HAVING and a window", "SELECT date_trunc('year', d), count(*), rank() OVER (ORDER BY date_trunc('year', d)) FROM typed WHERE id < 100 GROUP BY date_trunc('year', d) HAVING date_trunc('year', d) > '2000-01-01' ORDER BY 1");
  // the rerun at 7957b687: a series of times in FROM, correlated, where one row's series is empty
  // (DuckDB's table function then answered no rows for every row); a date plus a difference of dates; a random row
  // per group, written as the way out of volatile-window
  yield q("a correlated series of times, one empty", "SELECT id, (SELECT count(*) FROM generate_series(tz, tz + (i4 % 5) * interval '1 day', interval '1 day') AS g) AS n, (SELECT min(g) FROM generate_series(ts, ts - interval '1 day', interval '6 hours') g) FROM typed WHERE id < 100 ORDER BY id");
  yield q("a lateral series of times, one empty", "SELECT t.id, count(g.g), max(g.g) FROM typed t LEFT JOIN LATERAL generate_series(t.d, t.d + (t.i2 % 4), interval '1 day') AS g ON true WHERE t.id < 100 GROUP BY t.id ORDER BY t.id");
  yield q("a series of times WITH a column alias", "SELECT x.v FROM typed t, generate_series(t.tz, t.tz + interval '2 hours', interval '1 hour') AS x(v) WHERE t.id IN (1, 2) ORDER BY 1");
  yield q("a date plus a difference of dates", "SELECT id, d + (d - '2000-01-01'::date), d - (d - date '1999-12-31'), (d - '2026-01-01'::date) * 2 FROM typed WHERE id < 100 ORDER BY id");
  yield q("a random row per group, through a subquery", "SELECT count(*) FROM (SELECT row_number() OVER (PARTITION BY b ORDER BY r) AS rn FROM (SELECT *, random() AS r FROM typed) AS s) AS x WHERE rn = 1");
  yield q("an outer column in a correlated UNION, scalar", "SELECT id, (SELECT max(x) FROM (SELECT t.i4 AS x UNION SELECT t.i2) AS u) FROM typed t WHERE id < 100 ORDER BY id");
  yield q("an outer column in a correlated UNION, IN", "SELECT id FROM typed t WHERE t.i4 IN (SELECT c.id FROM cased c WHERE c.id = t.id UNION SELECT t.i2) ORDER BY id");
  yield q("an outer column in a correlated UNION, lateral", "SELECT t.id, u.x FROM typed t, LATERAL (SELECT t.i4 AS x UNION SELECT t.i2 UNION ALL SELECT c.id FROM cased c WHERE c.id = t.id) AS u WHERE t.id < 100 ORDER BY 1, 2");
  yield q("an outer column in a correlated UNION, EXISTS", "SELECT id FROM typed t WHERE EXISTS (SELECT 1 FROM cased c WHERE c.\"T\" = t.t UNION SELECT 1 WHERE t.i4 > 5) ORDER BY id");
  yield q("an outer column in a correlated UNION, unqualified", "SELECT id, (SELECT count(*) FROM (SELECT i4 FROM cased c WHERE c.id = id UNION SELECT i2) AS u) FROM typed WHERE id < 100 ORDER BY id");
  // an exact numeric named through a SELECT * of a derived table (a BI tool's `SELECT "sql".* FROM (…) AS "sql"` inside
  // a query that names its column): its scale is Postgres's (0.0, never 0); a CTE of the enclosing query read whole
  yield q("an exact numeric named through SELECT *", "SELECT s.c, s.id FROM (SELECT * FROM (SELECT round(i8::numeric, 1) AS c, id FROM typed WHERE id < 100) q) s ORDER BY s.id");
  yield q("an exact numeric named through SELECT * of an outer CTE", "WITH base AS (SELECT round(100.0 * (i4 - i2) / nullif(i2, 0), 1) AS pct, id FROM typed WHERE id < 100) SELECT b.pct, b.id FROM (SELECT * FROM base) AS b ORDER BY b.id");
  yield q("an exact numeric through a CTE shadowing another", "WITH base AS (SELECT round(i4::numeric, 2) AS v, id FROM typed WHERE id < 100) SELECT b.v FROM (WITH base AS (SELECT round(i2::numeric, 3) AS v, id FROM typed WHERE id < 100) SELECT * FROM base) AS b ORDER BY b.id");
  yield q("enum sorted", "SELECT id, m FROM moods ORDER BY m, id");
  yield q("enum sorted DESC NULLS LAST", "SELECT id, m FROM moods ORDER BY m DESC NULLS LAST, id");
  yield q("enum compared with a literal", "SELECT id FROM moods WHERE m > 'sad' ORDER BY id");
  yield q("enum compared every way", "SELECT id, m < 'happy', m <= 'ok', m >= 'ok', 'ok'::mood < m, m < t::mood, m <> t::mood FROM moods ORDER BY id");
  yield q("enum BETWEEN, IN, =", "SELECT id, m BETWEEN 'sad' AND 'ok', m IN ('ok', 'happy'), m = 'it''s', m <> 'sad' FROM moods ORDER BY id");
  yield q("enum min / max", "SELECT min(m), max(m), min(l), max(l) FROM moods");
  yield q("enum grouped", "SELECT m, count(*) FROM moods GROUP BY m ORDER BY m");
  yield q("enum DISTINCT", "SELECT DISTINCT m FROM moods ORDER BY m");
  yield q("enum as text", "SELECT id, m::text, upper(m::text), m::text < 'p' FROM moods ORDER BY id");
  yield q("text as enum", "SELECT id, t::mood, t::mood > 'sad'::mood FROM moods WHERE t IS NOT NULL ORDER BY id");
  yield q("text as enum, refused", "SELECT 'nope'::mood FROM moods");
  yield q("enum coalesce / CASE / greatest", "SELECT id, coalesce(m, 'ok'), CASE WHEN id > 3 THEN m ELSE 'happy' END, greatest(m, 'ok') FROM moods ORDER BY id");
  yield q("enum UNION a literal", "SELECT m FROM moods UNION SELECT 'ok' ORDER BY 1");
  yield q("enum array", "SELECT id, ms, ms[1], 'ok' = ANY (ms), m = ANY ('{ok,happy}') FROM moods ORDER BY id");
  yield q("enum array sorted", "SELECT id, ms FROM moods ORDER BY ms, id");
  yield q("enum of another schema", "SELECT id, l FROM moods WHERE l = 'high' ORDER BY l, id");
  yield q("enum_range / enum_first", "SELECT enum_first(null::mood), enum_last(m), enum_range(m) FROM moods WHERE id = 1");
  yield q("an ORDER BY name two columns answer (42702)", "SELECT m, m::text FROM moods GROUP BY m ORDER BY m");
  yield q("a source's defaults and NOT NULL in information_schema", "SELECT column_name, column_default, is_nullable, is_identity, identity_generation FROM information_schema.columns WHERE table_name = 'defaults' ORDER BY ordinal_position");
  yield q("a serial's and an identity's sequence", "SELECT pg_get_serial_sequence('defaults', 'id'), pg_get_serial_sequence('public.defaults', 'sm'), pg_get_serial_sequence('defaults', 'ia'), pg_get_serial_sequence('defaults', 'ib'), pg_get_serial_sequence('defaults', 's')");
  yield q("a source's defaults in pg_attribute and pg_attrdef", "SELECT a.attname, a.attnotnull, a.attidentity, a.atthasdef, pg_get_expr(d.adbin, d.adrelid) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'public.defaults'::regclass AND a.attnum > 0 AND a.attname <> 'g' ORDER BY a.attnum");
  yield q("the sequences, by type", "SELECT sequence_name, data_type FROM information_schema.sequences WHERE sequence_name LIKE 'defaults%' ORDER BY 1");
  // through the key's index Postgres stops at the limit and answers; Mason computes the list for the kept rows alike
  yield q("a select list after its limit, through a join (Metabase's preview)", "SELECT l.id, l.j -> 'd' ->> 'os' AS os, (l.j ->> 'n')::int AS n, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 5");
  yield q("a select list after its limit and offset, sorted by an output's name and an ordinal", "SELECT l.id AS key, upper(c.name), l.j ->> 'n' FROM late l JOIN late_c c ON c.id = l.c ORDER BY c.name DESC, key LIMIT 4 OFFSET 3");
  yield q("a select list after its limit, the bad row kept", "SELECT l.id, (l.j ->> 'n')::int, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id DESC LIMIT 3");
  yield q("a select list after its limit, sorted by an ordinal, filtered through the join", "SELECT l.id, (l.j ->> 'n')::int FROM late l JOIN late_c c ON c.id = l.c WHERE c.name = 'c7' ORDER BY 1 LIMIT 2");
  yield q("a view", "SELECT * FROM happy ORDER BY id");
  yield q("a view's columns qualified by its schema (Metabase)", "SELECT \"public\".\"happy\".\"id\" AS \"id\", \"public\".\"happy\".\"m\" AS \"m\" FROM \"public\".\"happy\" WHERE \"public\".\"happy\".\"m\" > 'ok' ORDER BY \"public\".\"happy\".\"id\" ASC LIMIT 2000");
  yield q("a view of another schema, its columns renamed", "SELECT * FROM other.typed_summary ORDER BY flag NULLS FIRST");
  yield q("a view over a view", "SELECT n, top FROM happy_count");
  yield q("a view joined to a table, aliased with its columns", "SELECT h.i, x.t FROM happy AS h(i, mm) JOIN moods x ON x.id = h.i WHERE h.mm <> 'happy' ORDER BY 1");
  yield q("a view in a subquery", "SELECT count(*) FROM moods WHERE id IN (SELECT id FROM happy) AND m IS NOT NULL");
  yield q("the views in information_schema and pg_views", "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_name IN ('happy', 'typed_summary', 'happy_count') ORDER BY 1, 2");
  yield q("a view's definition", "SELECT viewname, definition FROM pg_views WHERE viewname IN ('happy', 'typed_summary', 'happy_count') ORDER BY 1");
  yield q("enum columns in information_schema", "SELECT column_name, data_type, udt_schema, udt_name FROM information_schema.columns WHERE table_name = 'moods' ORDER BY ordinal_position");
  // ANY / ALL over a NULL array is NULL (DuckDB read it as an empty one)
  yield q("ANY / ALL over a NULL array", "SELECT id, 1 = ANY (ai), 1 <> ALL (ai), 1 < ANY (ai), 1 = ALL (ai), (1 = ANY (ai)) IS NULL FROM typed WHERE id < 100 ORDER BY id");
  yield q("window frames", "SELECT id, sum(i4) OVER (ORDER BY id RANGE BETWEEN 2 PRECEDING AND CURRENT ROW), count(*) OVER (ORDER BY ts RANGE BETWEEN interval '1 day' PRECEDING AND interval '1 day' FOLLOWING), sum(i4) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 2 FOLLOWING), max(i4) OVER (ORDER BY id GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW), sum(i4) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING EXCLUDE CURRENT ROW), sum(i4) OVER (ORDER BY id RANGE UNBOUNDED PRECEDING) FROM typed WHERE id < 100 ORDER BY id");
}

export const TYPE_MATRIX: Array<{ name: string; sql: string }> = [...matrix()];
