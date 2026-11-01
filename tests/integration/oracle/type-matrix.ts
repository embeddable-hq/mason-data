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
import { FROM_ITEM_VIEWS, FROM_ITEMS_SORTED } from "./unordered-limit.ts";


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
 * oracle is run under (C, ICU and glibc's en_US.utf8 each sort these differently).
 */
export const JORDER: Array<string | null> = [
  null, "null", "true", "false", "0", "-0", "0.0", "1", "1.0", "1.00", "10", "9.5", "-1", "-10", "-9.5", "-0.5", "-0.50", "1e2", "100", "1E+2",
  "0.001", "1e-3", "123456789012345678901234567890.5", "-123456789012345678901234567890", "2.5e-30",
  '""', '"a"', '"A"', '"b"', '"B"', '"ab"', '"Ab"', '"aB"', '"a b"', '"a-b"', '"ab-"', '"é"', '"e"', '"\\u00e9"', '"E"', '"z"', '"\\n"', '"\\"q\\""', '"\\ud83d\\ude00"',
  '"日本"', '"ß"', '"ss"', '"Zürich"', '"zulu"', '"10"', '"9"', '"$x"', '"@x"',
  "[]", "[null]", "[1]", "[1.0]", "[2]", "[1, 2]", "[2, 1]", "[[]]", "[{}]", '["a"]', '["B"]', '["b"]', "[1, [2]]", "[[1], 1]", "[true, false]", "[[], []]", "[[[]]]",
  "{}", '{"a": 1}', '{"a": 1.0}', '{"a": 2}', '{"b": 1}', '{"B": 1}', '{"A": 1}', '{"a": null}', '{"a": []}', '{"a": {}}', '{"a": "1"}', '{"a": "B"}', '{"a": "b"}',
  '{"a": 1, "b": 2}', '{"b": 1, "aa": 1}', '{"a": 1, "bb": 1}', '{"aa": 1}', '{"Ab": 1}', '{"a": {"b": [1, "x"]}}', '{"a": 1, "a": 2}', '{"é": 1}', '{"e": 1}', '{"a": 1, "B": 2}',
  '["e\u0301"]', '["\u2764\ufe0f"]', '["\u2764"]', '{"k": "\u0e40\u0e01"}', '{"k": "\u0e01"}',
];

/**
 * A JSON READ'S PATH, THE SHAPES IT MUST HOLD (issue 130): a value of every kind at a key, a number's key beside an
 * array's index on one document, a key with a dot or a quote, a key held twice (`json` keeps both, jsonb the last),
 * white space around a `json` value, a scalar and an array as the whole document, a key's text a collation orders
 * otherwise than its bytes. One document as a jsonb and as a json.
 */
export const JPATH: Array<string | null> = [
  String.raw`{"k": "alpha", "n": 7.00, "t": true, "f": false, "z": null, "o": {"b": "deep", "0": "key0"}, "a": ["x", "y", {"0": "in"}], "0": "zero", "1": "one", "a.b": "dot", "q\"r": "quote", "o.b": "flat", "e": "esc\"aped\n"}`,
  String.raw`{"k": "Beta", "k": "dup", "o": {"b": 1, "b": 2}, "a": [1, 2.50, null, "s", [1,  2], {"x":  1}]}`,
  String.raw` { "k" : "Zed" , "o" :  { "b" : [ 1 , 2 ] } , "a" : { "0" : "object", "1" : "other" } , "0" : ["nested"] } `,
  '{"k": "éa", "o": null, "a": []}',
  '{"k": "ea", "o": {}, "a": {}}',
  '{"k": 12, "o": "text"}',
  '{"k": null}',
  '{"k": {"b": "object"}}',
  '{"k": ["array"]}',
  '{}',
  '[]',
  '["first", "second", ["third", {"k": "inner"}]]',
  '"scalar"',
  '5',
  'true',
  'null',
  null,
];

export const COLL: Array<[number, string | null]> = [
  [1, "대지"], [2, "Animal"], [3, "zebra"], [4, "Dob"], [5, "Do\uFFFDa"], [6, "$x"], [7, "€x"], [8, "@x"], [9, "~x"], [10, "ab"],
  [11, "a-b"], [12, "a b"], [13, "가나"], [14, "나"], [15, "가가"], [16, "-"], [17, "--"], [18, "-@"], [19, "@"], [20, "三"],
  [21, "가三"], [22, "三가"], [23, ":三"], [24, "a가"], [25, "가a"], [26, "-a"], [27, "a"], [28, "A"], [29, "ß"], [30, "ss"],
  [31, "Ss"], [32, "æ"], [33, "ae"], [34, "café"], [35, "Cafe"], [36, "co-op"], [37, "coop"], [38, "x?"], [39, "-X"], [40, "1a"],
  [41, "Ölbaum"], [42, "Zürich"], [43, "zulu"], [44, "αβγ"], [45, "абв"], [46, "東京"], [47, "\uFFFD"], [48, "£5"], [49, null],
  [50, "1x"], [51, "1-X"],
  // what a libc collation's order holds beyond its letters (issue 128): an emoji's variation selector, skin tones and
  // joiners, Thai and Lao vowels written before their consonant, Arabic and its marks, an accent spelled by its marks,
  // in a run of marks (read backward, one skipped), an NFD spelling of a letter of its own, what the table does not
  // list (one element per byte), digits and punctuation in a run, each beside the plain text it sorts by. 99: refused
  [52, "Sales \u2764\uFE0F"], [53, "Sales \u2764"], [54, "Sales"], [55, "Sales \u2764\uFE0F!"], [56, "\u{1F600}"], [57, "\u{1F600}a"], [58, "a\u{1F600}"], [59, "\u{1F44D}"],
  [60, "\u{1F44D}\u{1F3FD}"], [61, "\u{1F44D}\u{1F3FB}"], [62, "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"], [63, "\u{1F468}\u{1F469}\u{1F467}"], [64, "\u0E40\u0E01"], [65, "\u0E01\u0E40"], [66, "\u0E01"],
  [67, "\u0E44\u0E01\u0E48"], [68, "\u0E41\u0E21\u0E48"], [69, "\u0E01\u0E32"], [70, "\u0E33"], [71, "\u0E4D\u0E32"], [72, "\u0EC0\u0E81"], [73, "\u0E81"], [74, "\u0645\u0631\u062D\u0628\u0627"],
  [75, "\u0645\u064E\u0631\u062D\u0628\u0627"], [76, "\u0622"], [77, "\u0627\u0653"], [78, "e\u0301"], [79, "\u00E9"], [80, "e"], [81, "E\u0301"], [82, "e\u0301\u0300x"], [83, "e\u0300\u0301x"],
  [84, "o\u0302\u0301"], [85, "\u1ED1"], [86, "\u0418\u0306"], [87, "\u0419"], [88, "\u0378"], [89, "\uE000x"], [90, "\u{F0000}"], [91, "a\u0378b"], [92, "ab\uE000"], [93, "1\u0301a"],
  [94, "12a"], [95, "1-2a"], [96, "$-X"], [97, "a\uFE0Fb"], [98, "\u200Bx"],
  [99, "\u33E9"],
  // issue 128's second review: each symbol class, none refused under en_US: circled, CJK compatibility, currency, a
  // fraction, a Roman numeral, U+FFFD, private use
  [100, "\u2460"], [101, "\u32BF"], [102, "\u2485"], [103, "\u24EA"], [104, "\u337F"], [105, "\u33E0"], [106, "\u{1F170}"], [107, "\u20AC5"], [108, "\u00A3"], [109, "\u00A5 x"],
  [110, "\u00BD"], [111, "\u216B"], [112, "\uFFFDx"], [113, "\uE001"], [114, "\u{F0001}"], [115, "\u{10FFFD}x"], [116, "x\uE000"],
];

/**
 * EVERY TYPE THE COPY HOLDS AS ANOTHER (src/duck/held-types.ts, issues 126 and 129): one column of `mapped` each, read
 * every way a tool reads a column. Each value list is [id 1 … id 5] with id 1 and id 3 equal, id 6 NULL; `eq` is a value's
 * literal, in another spelling of it where the type has one. A statement Postgres refuses is refused alike; one Mason
 * cannot answer names its gap, or the oracle fails.
 */
const MAPPED: Record<string, { type: string; values: string[]; eq?: string }> = {
  tz: { type: "timetz", values: ["'12:30:00+02'", "'00:00:00-05:30'", "'12:30:00+02'", "'10:30:00+00'", "'23:59:59.999999+14:15:30'"], eq: "'12:30+2'" },
  tz3: { type: "timetz(3)", values: ["'12:30:00.1234+02'", "'24:00:00-15:59:59'", "'12:30:00.1234+02'", "'00:00:00+15:59:59'", "'01:00:00+00'"], eq: "'12:30:00.123+02'" },
  tza: { type: "timetz[]", values: ["'{12:30:00+02,NULL}'", "'{}'", "'{12:30:00+02,NULL}'", "'{01:00:00+00}'", "'{\"23:59:59.5-03:30\"}'"] },
  ivy: { type: "interval year to month", values: ["'1 year 2 mons'", "'1 mon'", "'1 year 2 mons'", "'2 years'", "'-1 mon'"], eq: "'14 mons'" },
  ta3: { type: "time(3)[]", values: ["'{01:00:00}'", "'{}'", "'{01:00:00}'", "'{02:00:00,03:00:00.5}'", "'{NULL}'"] },
  pt: { type: "point", values: ["'(1,2)'", "'(1.5,-2.5)'", "'(1,2)'", "'(0,0)'", "'(1e300,-0)'"], eq: "'1,2'" },
  ln: { type: "line", values: ["'{1,2,3}'", "'{0,1,5}'", "'{1,2,3}'", "'{1,-1,0}'", "'{2,4,6}'"], eq: "'{1,2,3}'" },
  ls: { type: "lseg", values: ["'[(0,0),(1,1)]'", "'[(1,2),(3,4)]'", "'[(0,0),(1,1)]'", "'[(5,5),(6,6)]'", "'[(1,1),(0,0)]'"], eq: "'[(0,0),(1,1)]'" },
  bx: { type: "box", values: ["'(1,1),(0,0)'", "'(3,4),(1,2)'", "'(1,1),(0,0)'", "'(9,9),(8,8)'", "'(0,0),(1,1)'"], eq: "'(1,1),(0,0)'" },
  pa: { type: "path", values: ["'((0,0),(1,1))'", "'[(0,0),(1,1),(2,0)]'", "'((0,0),(1,1))'", "'[(5,5),(6,6)]'", "'[(0,0),(1,1)]'"], eq: "'((0,0),(1,1))'" },
  pg: { type: "polygon", values: ["'((0,0),(1,1),(1,0))'", "'((0,0),(2,2),(2,0))'", "'((0,0),(1,1),(1,0))'", "'((5,5),(6,6),(7,5))'", "'((0,0),(0,1),(1,1))'"], eq: "'((0,0),(1,1),(1,0))'" },
  ci: { type: "circle", values: ["'<(1,2),3>'", "'<(0,0),1>'", "'<(1,2),3>'", "'<(5,5),2>'", "'<(0,0),3>'"], eq: "'<(1,2),3>'" },
  mn: { type: "money", values: ["'12.50'", "'-3.00'", "'12.50'", "'1000000.99'", "'0'"], eq: "'12.5'" },
  bi: { type: "bit(8)", values: ["B'10101010'", "B'00000001'", "B'10101010'", "B'11111111'", "B'00000000'"], eq: "B'10101010'" },
  vb: { type: "varbit", values: ["B'101'", "B'1'", "B'101'", "B''", "B'1010'"], eq: "B'101'" },
  mc: { type: "macaddr", values: ["'08:00:2b:01:02:03'", "'00:00:00:00:00:01'", "'08:00:2b:01:02:03'", "'ff:ff:ff:ff:ff:ff'", "'0a:00:2b:01:02:03'"], eq: "'0800.2b01.0203'" },
  m8: { type: "macaddr8", values: ["'08:00:2b:01:02:03:04:05'", "'00:00:00:00:00:00:00:01'", "'08:00:2b:01:02:03:04:05'", "'ff:ff:ff:ff:ff:ff:ff:ff'", "'0a:00:2b:01:02:03:04:05'"], eq: "'0800-2b01-0203-0405'" },
  cd: { type: "cidr", values: ["'10.0.0.0/8'", "'192.168.1.0/24'", "'10.0.0.0/8'", "'::/0'", "'2001:db8::/32'"], eq: "'10/8'" },
  tv: { type: "tsvector", values: ["'a b c'", "'fat:1 cat:2'", "'a b c'", "''", "'c b a b'"], eq: "'c b a'" },
  tq: { type: "tsquery", values: ["'a & b'", "'c | d'", "'a & b'", "'!e'", "'b & a'"], eq: "'a & b'" },
  xm: { type: "xml", values: ["'<a>1</a>'", "'<b/>'", "'<a>1</a>'", "'text'", "'<a x=\"1\"/>'"] },
  oi: { type: "oid", values: ["1", "2", "1", "4294967295", "10"], eq: "1" },
  rc: { type: "regclass", values: ["'pg_class'", "'pg_type'", "'pg_class'", "'pg_proc'", "'pg_attribute'"], eq: "'pg_class'" },
  rt: { type: "regtype", values: ["'int4'", "'text'", "'int4'", "'bool'", "'numeric'"], eq: "'integer'" },
  xi: { type: "xid", values: ["'1'", "'2'", "'1'", "'3'", "'10'"], eq: "'1'" },
  x8: { type: "xid8", values: ["'1'", "'2'", "'1'", "'3'", "'10'"], eq: "'1'" },
  ct: { type: "cid", values: ["'1'", "'2'", "'1'", "'3'", "'10'"], eq: "'1'" },
  ti: { type: "tid", values: ["'(0,1)'", "'(1,2)'", "'(0,1)'", "'(3,4)'", "'(0,10)'"], eq: "'(0,1)'" },
  lsn: { type: "pg_lsn", values: ["'0/16B3748'", "'1/0'", "'0/16B3748'", "'FFFFFFFF/FFFFFFFF'", "'0/9'"], eq: "'0/16b3748'" },
  ch1: { type: '"char"', values: ["'a'", "'b'", "'a'", "'Z'", "'~'"], eq: "'a'" },
  nm: { type: "name", values: ["'abc'", "'B'", "'abc'", "'z'", "'é'"], eq: "'abc'" },
  r4: { type: "int4range", values: ["'[1,5)'", "'[2,3)'", "'[1,4]'", "'empty'", "'(,5)'"], eq: "'(0,5)'" },
  r8: { type: "int8range", values: ["'[1,5)'", "'[2,3)'", "'[1,5)'", "'empty'", "'[10,)'"], eq: "'[1,4]'" },
  rn: { type: "numrange", values: ["'[1.5,5)'", "'[2,3]'", "'[1.50,5.0)'", "'empty'", "'(,1)'"], eq: "'[1.5,5)'" },
  rd: { type: "daterange", values: ["'[2026-01-01,2026-02-01)'", "'[2026-03-01,)'", "'[2026-01-01,2026-02-01)'", "'empty'", "'(,2026-01-01]'"], eq: "'[2026-01-01,2026-01-31]'" },
  rs: { type: "tsrange", values: ["'[2026-01-01,2026-02-01)'", "'[2026-03-01,)'", "'[2026-01-01,2026-02-01)'", "'empty'", "'(,2026-01-01 12:00]'"], eq: "'[2026-01-01,2026-02-01)'" },
  rz: { type: "tstzrange", values: ["'[2026-01-01 00:00+00,2026-07-01 00:00+00)'", "'[2026-03-01 12:00+05,)'", "'[2026-01-01 00:00+00,2026-07-01 00:00+00)'", "'empty'", "'(,2026-01-01 12:00+00]'"], eq: "'[2026-01-01 00:00+00,2026-07-01 00:00+00)'" },
  m4: { type: "int4multirange", values: ["'{[1,5)}'", "'{[1,2),[3,4)}'", "'{[1,3),[3,5)}'", "'{}'", "'{(,1)}'"], eq: "'{[1,4]}'" },
  mz: { type: "tstzmultirange", values: ["'{[2026-01-01 00:00+00,2026-07-01 00:00+00)}'", "'{}'", "'{[2026-01-01 00:00+00,2026-07-01 00:00+00)}'", "'{(,2026-01-01 00:00+00)}'", "'{[2026-07-01 00:00+00,)}'"] },
  jp: { type: "jsonpath", values: ["'$.a'", "'$.b[0]'", "'$.a'", "'$'", "'$.a.b ? (@ > 1)'"] },
  ps: { type: "pair", values: ["'(1,a)'", "'(2,b)'", "'(1,a)'", "'(3,)'", "'(,)'"], eq: "'(1,a)'" },
  ur: { type: "shop_range", values: ["'[1,5)'", "'[2,3)'", "'[1,5)'", "'empty'", "'[3,)'"], eq: "'[1,5)'" },
  di: { type: "shop_count", values: ["1", "2", "1", "30", "4"], eq: "1" },
  dt: { type: "shop_label", values: ["'a'", "'b'", "'a'", "'C'", "'é'"], eq: "'a'" },
  dz: { type: "shop_clock", values: ["'12:30:00+02'", "'01:00:00+00'", "'12:30:00+02'", "'02:00:00+01'", "'23:00:00-05'"], eq: "'12:30+2'" },
  dp: { type: "shop_place", values: ["'(1,2)'", "'(0,0)'", "'(1,2)'", "'(3,4)'", "'(5,6)'"] },
  pta: { type: "point[]", values: ["ARRAY['(1,2)'::point]", "'{}'", "ARRAY['(1,2)'::point]", "ARRAY['(0,0)'::point,'(3,4)'::point]", "ARRAY[NULL::point]"] },
  mna: { type: "money[]", values: ["'{12.50}'", "'{}'", "'{12.50}'", "'{1,2}'", "'{NULL}'"] },
  maa: { type: "macaddr[]", values: ["'{08:00:2b:01:02:03}'", "'{}'", "'{08:00:2b:01:02:03}'", "'{00:00:00:00:00:01}'", "'{NULL}'"] },
  cda: { type: "cidr[]", values: ["'{10.0.0.0/8}'", "'{}'", "'{10.0.0.0/8}'", "'{192.168.1.0/24,10.0.0.0/8}'", "'{NULL}'"] },
  bia: { type: "bit(3)[]", values: ["'{101}'", "'{}'", "'{101}'", "'{000,111}'", "'{NULL}'"] },
  tva: { type: "tsvector[]", values: ["ARRAY['a b'::tsvector]", "'{}'", "ARRAY['a b'::tsvector]", "ARRAY['c'::tsvector]", "'{NULL}'"] },
  ra: { type: "int4range[]", values: ["'{\"[1,5)\"}'", "'{}'", "'{\"[1,5)\"}'", "'{\"[2,3)\",empty}'", "'{NULL}'"] },
  oia: { type: "oid[]", values: ["'{1,2}'", "'{}'", "'{1,2}'", "'{3}'", "'{NULL}'"] },
};
const MAPPED_TABLE = "CREATE TYPE pair AS (a int, b text); CREATE TYPE shop_range AS RANGE (subtype = int4); CREATE DOMAIN shop_count AS integer CHECK (VALUE > 0); " +
  "CREATE DOMAIN shop_label AS varchar(5); CREATE DOMAIN shop_clock AS timetz; CREATE DOMAIN shop_place AS point; " +
  `CREATE TABLE public.mapped (id int PRIMARY KEY, ${Object.entries(MAPPED).map(([c, m]) => `${c} ${m.type}`).join(", ")}); ` +
  [0, 1, 2, 3, 4].map((i) => `INSERT INTO public.mapped VALUES (${i + 1}, ${Object.values(MAPPED).map((m) => m.values[i]).join(", ")});`).join(" ") +
  " INSERT INTO public.mapped (id) VALUES (6);" +
  // issue 126: a grouped `*`'s outputs are named, for the query that reads them
  " CREATE TABLE public.grouped (id int PRIMARY KEY, name text, y int, a_id int); INSERT INTO public.grouped VALUES (1, 'a', 2, 3), (2, 'b', NULL, 4), (3, 'a', 2, NULL);";

/** the instants of `instants` (as UTC text, which every zone reads alike) */
const INSTANTS: Array<[number, string | null]> = [
  [1, "2026-03-29 00:59:59.999999+00"], [2, "2026-03-29 01:00:00+00"], [3, "2026-03-29 01:30:00+00"], [4, "2026-10-25 00:30:00+00"],
  [5, "2026-10-25 01:00:00+00"], [6, "2026-10-25 01:30:00+00"], [7, "2026-10-25 02:00:00+00"], [8, "2026-03-08 06:59:59+00"],
  [9, "2026-03-08 07:00:00+00"], [10, "2026-11-01 05:30:00+00"], [11, "2026-11-01 06:30:00+00"], [12, "1969-12-31 23:59:59.5+00"],
  [13, "1960-02-29 12:34:56.789+00"], [14, "1880-06-15 12:00:30+00"], [15, "2000-12-31 23:00:00+00"], [16, "2001-01-01 00:00:00+00"],
  [17, "2026-01-04 23:59:59+00"], [18, "2026-01-05 00:00:00+00"], [19, "2026-07-01 12:34:56.123456+00"], [20, "infinity"], [21, "-infinity"], [22, null],
  [23, "1999-12-31 23:59:59.999999+00"], [24, "2262-04-11 23:47:16+00"], [25, "2026-03-29 00:30:00+00"], [26, "2026-11-01 04:59:59.999999+00"],
];

/** the table and its rows (the oracle's TimeZone is UTC: a timestamptz literal's offset is folded into UTC); beside it,
 *  `typed_arrays` holds the array types the review found sent as text[] */
export const TYPED = `${MAPPED_TABLE} CREATE EXTENSION IF NOT EXISTS citext; CREATE TABLE public.typed (id int PRIMARY KEY, ${ALL.map((c) => `${c} ${COLUMNS[c]}`).join(", ")}); ` +
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
  // a json read's path (issue 130), and read through a view grouped by it
  `CREATE TABLE public.jpath (id int PRIMARY KEY, jb jsonb, j json); INSERT INTO public.jpath VALUES ${JPATH.map((d, i) => `(${i + 1}, ${d === null ? "NULL, NULL" : `'${d.replace(/'/g, "''")}', '${d.replace(/'/g, "''")}'`})`).join(", ")};` +
  "CREATE VIEW public.jpath_by_array AS SELECT jb #>> ARRAY['k'] AS v, count(*) AS n FROM public.jpath GROUP BY 1; " +
  "CREATE VIEW public.jpath_by_literal AS SELECT j #>> '{o,b}'::text[] AS v, count(*) AS n FROM public.jpath GROUP BY 1;" +
  // TEXT IN THE DATABASE'S ORDER (the BI-tools test of #517): what a glibc locale orders otherwise than ICU
  // and than its bytes — Hangul (no letter weight), $ and € (a letter-level weight, @ and ~ none), U+FFFD (after the
  // letters), ß = ss, CJK (no last-level weight), punctuation runs, case; from 50 issue 128's (COLL says each); 99 a
  // ligature of a CJK weight, sorted in place under en_US (libc-rare-letter), and on from it each class of symbol
  `CREATE TABLE public.coll (id int PRIMARY KEY, s text); INSERT INTO public.coll VALUES ${COLL.map(([id, v]) => `(${id}, ${v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`})`).join(", ")};` +
  // ENUMS IN THEIR DECLARED ORDER (the BI-tools test of #517): a label with a quote, an enum of another schema, an
  // array of one, NULL and empty arrays, and a text column read as the enum
  "CREATE TYPE public.mood AS ENUM ('sad', 'ok', 'happy', 'it''s'); CREATE SCHEMA IF NOT EXISTS other; CREATE TYPE other.level AS ENUM ('low', 'high'); " +
  "CREATE TABLE public.moods (id int PRIMARY KEY, m mood, ms mood[], l other.level, t text); " +
  "INSERT INTO public.moods VALUES (1, 'happy', '{sad,ok}', 'high', 'ok'), (2, 'sad', NULL, 'low', 'happy'), (3, 'ok', '{}', NULL, NULL), " +
  "(4, NULL, '{happy}', 'low', 'sad'), (5, 'it''s', '{it''s,sad}', 'high', 'it''s'), (6, 'sad', '{ok}', 'high', 'ok');" +
  // an enum beside a document, enough rows for DuckDB's join to reorder a lateral over them
  "CREATE TABLE public.moodlog (id int PRIMARY KEY, m mood, jb jsonb, s text); INSERT INTO public.moodlog SELECT g, (ARRAY['sad', 'ok', 'happy', NULL])[g % 4 + 1]::mood, " +
  "CASE g % 5 WHEN 0 THEN NULL WHEN 1 THEN '[1, 2]' ELSE jsonb_build_object('a', g, 'b', 'x' || (g % 3)) END, 's' || (g % 7) FROM generate_series(1, 300) g;" +
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
  // a view reading the session's settings (the setting cases of duck-oracle.itest.ts read it after a SET)
  "CREATE VIEW public.settings_seen AS SELECT id, current_setting('TimeZone'::text) AS tz, pg_catalog.current_setting('application_name'::text, true) AS app FROM moods;" +
  // A SELECT LIST COMPUTED AFTER ITS LIMIT (the Metabase test of #517: a table's preview, its JSON's fields, a join):
  // row 2000's 'x' is no integer, and late.k orders the rows backwards with no index
  "CREATE TABLE public.late (id int PRIMARY KEY, j jsonb, k int, c int); " +
  "INSERT INTO public.late SELECT g, jsonb_build_object('n', CASE WHEN g = 2000 THEN 'x' ELSE g::text END, 'd', jsonb_build_object('os', 'ios' || g % 7)), 2000 - g, g % 50 FROM generate_series(1, 2000) g; " +
  "CREATE TABLE public.late_c (id int PRIMARY KEY, name text); INSERT INTO public.late_c SELECT g, 'c' || g FROM generate_series(0, 49) g;" +
  // A TOP N OVER JOINED TABLES (issue 105), its rows chosen by row number (src/duck/late.ts joinRows): a row with no
  // match, a key NULL on either side, a row the join multiplies, ties (made repeats), a table joined to itself, the
  // strings a collation orders otherwise than bytes, a view, and a table whose own column is named rowid
  "CREATE TABLE public.top_a (id int PRIMARY KEY, made timestamptz, name text, parent int, note text); " +
  "INSERT INTO public.top_a VALUES (1, '2024-03-10 23:30:00+00', 'b', NULL, repeat('n', 300)), (2, '2024-03-11 01:00:00+00', 'A', 1, NULL), (3, NULL, 'a', 1, 'x'), (4, '2024-03-11 01:00:00+00', 'é', 2, 'y'), " +
  "(5, NULL, 'Z', 9, 'z'), (6, '2024-01-01 00:00:00+00', NULL, 2, 'w'), (7, '2024-03-11 01:00:00+00', 'z', 4, 'v');" +
  "CREATE TABLE public.top_b (id int PRIMARY KEY, a_id int, payload jsonb, amount numeric(10,2), seen date); " +
  "INSERT INTO public.top_b SELECT g, CASE WHEN g % 11 = 0 THEN NULL ELSE g % 4 + 1 END, jsonb_build_object('k', 'v' || g, 'n', g, 'wide', repeat('w', 200)), g * 1.25, CASE WHEN g % 3 = 0 THEN NULL ELSE date '2024-01-01' + g END FROM generate_series(1, 30) g;" +
  "CREATE TABLE public.top_c (id int PRIMARY KEY, b_id int, doc json, label text); " +
  "INSERT INTO public.top_c SELECT g, g % 7 + 1, json_build_object('n', g, 'wide', repeat('d', 200)), CASE WHEN g % 5 = 0 THEN NULL ELSE 'l' || g % 3 END FROM generate_series(1, 40) g;" +
  "CREATE TABLE public.top_r (id int PRIMARY KEY, rowid int, a_id int); INSERT INTO public.top_r VALUES (1, 70, 1), (2, 60, 2), (3, 50, 2);" +
  "CREATE TABLE public.top_rc (id int PRIMARY KEY, \"RowId\" int, a_id int); INSERT INTO public.top_rc SELECT g, 5, g % 3 + 1 FROM generate_series(1, 6) g;" +
  // no primary key: the copy is keyed by a UNIQUE over NOT NULL columns, as a sources file's `key:` keys it, and the
  // catalog declares no key (oracle's `added`; src/cli/sources.ts addedTables)
  "CREATE TABLE public.top_n (a int NOT NULL, b int NOT NULL, note text, UNIQUE (a, b)); INSERT INTO public.top_n SELECT g % 3 + 1, g % 2, 'n' || g FROM generate_series(1, 6) g;" +
  "CREATE VIEW public.top_v AS SELECT b.id, b.a_id, b.payload FROM public.top_b b WHERE b.id < 20;" +
  // A SORT THROUGH A `*` (issue 112): text a collation orders otherwise than bytes, a citext and a char(n) likewise, a
  // jsonb; star_b for a join's own columns of the same names
  "CREATE TABLE public.star_o (id int PRIMARY KEY, n int, name text, ci citext, ch char(4), j jsonb); " +
  "INSERT INTO public.star_o VALUES (1, 5, 'b', 'b', 'b', '2'), (2, 4, 'A', 'A', 'A', '\"a\"'), (3, 3, 'a', 'c', 'a', '[1]'), (4, 2, 'Z', 'Z', 'Z', '{\"a\": 1}'), " +
  "(5, 1, NULL, NULL, NULL, NULL), (6, 5, 'é', 'É', 'é', '10'), (7, 7, 'a-b', 'y', 'a b', 'null'), (8, 8, 'ab', 'X', 'ab', 'true');" +
  "CREATE TABLE public.star_b (id int PRIMARY KEY, a_id int, name text, y text); " +
  "INSERT INTO public.star_b VALUES (1, 1, 'Q', 'b'), (2, 2, 'q', 'A'), (3, 3, 'r', 'a'), (4, 2, 'R', 'Z'), (5, 8, NULL, NULL), (6, 99, 'é', 'é');" +
  "CREATE VIEW public.star_v AS SELECT id, name, ci, ch FROM public.star_o;" +
  // JSONB IN POSTGRES'S ORDER (JORDER above), beside a json of the same text, which has no order at all
  `CREATE TABLE public.jorder (id int PRIMARY KEY, j jsonb, js json); INSERT INTO public.jorder VALUES ${JORDER.map((v, i) => `(${i + 1}, ${v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`}, ${v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`})`).join(", ")};` +
  // INSTANTS AT A TRUNCATION'S EDGES (date_trunc of a timestamptz, in the session's zone or a zone of its own): each side
  // of Europe/Berlin's and America/New_York's changes of 2026, a repeated hour's two halves, before 1970, a zone's local
  // mean time (1880), the first instant of a week, a century and a millennium, a microsecond, ±infinity and NULL
  `CREATE TABLE public.instants (id int PRIMARY KEY, at timestamptz); INSERT INTO public.instants VALUES ${INSTANTS.map(([id, v]) => `(${id}, ${v === null ? "NULL" : `'${v}'`})`).join(", ")};` +
  // DOCUMENTS A PREVIEW EXPANDS (a LEFT JOIN LATERAL json_each … ON TRUE): objects of several keys, a key twice in a
  // json, an empty object, NULL, an array and a string the tool's CASE passes over; and arrays of other element types
  // (an unnest's padding NULL is of each), empty, NULL, or holding a NULL
  "CREATE TABLE public.docs (id int PRIMARY KEY, j json, jb jsonb, tags text[], ia int[], da date[], ua uuid[]); INSERT INTO public.docs SELECT g, d::json, d::jsonb, CASE WHEN g % 6 = 0 THEN NULL WHEN g % 6 = 1 THEN '{}' ELSE ARRAY['t' || (g % 4), 'u' || (g % 3)] END, " +
  "CASE WHEN g % 5 = 0 THEN NULL WHEN g % 5 = 1 THEN '{}' WHEN g % 5 = 2 THEN ARRAY[g, NULL] ELSE ARRAY[g, g % 3] END, " +
  "CASE WHEN g % 4 = 0 THEN NULL WHEN g % 4 = 1 THEN '{}' ELSE ARRAY[date '2026-01-01' + g, NULL] END, " +
  "CASE WHEN g % 7 = 0 THEN NULL WHEN g % 7 = 1 THEN '{}' ELSE ARRAY[('00000000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid] END " +
  "FROM (SELECT g, CASE WHEN g % 13 = 0 THEN NULL WHEN g % 17 = 0 THEN '[1, 2, 3]' WHEN g % 19 = 0 THEN '{}' WHEN g % 23 = 0 THEN '\"s\"' WHEN g % 29 = 0 THEN '{\"a\": 1, \"a\": 2, \"bb\": null}' " +
  "ELSE json_build_object('event', 'e' || (g % 7), 'n', g, 'ok', g % 2 = 0, 'nested', json_build_object('k', g % 3), 'z', CASE WHEN g % 3 = 0 THEN NULL ELSE 'x' || g END)::text END AS d FROM generate_series(1, 300) g) s;" +
  // A NULLABLE COLUMN OF EACH KIND A SORT MEETS (the nulls-placement idiom): NULLs among ties
  "CREATE TABLE public.nullish (id int PRIMARY KEY, ts timestamp, t text, n int); INSERT INTO public.nullish SELECT g, CASE WHEN g % 5 = 0 THEN NULL ELSE timestamp '2026-01-01' + (g % 17) * interval '1 hour' END, " +
  "CASE WHEN g % 7 = 0 THEN NULL ELSE 'v' || (g % 11) END, CASE WHEN g % 4 = 0 THEN NULL ELSE g % 9 END FROM generate_series(1, 60) g;" +
  // KEYS AND NOT-KEYS FOR A COUNT OF DISTINCT VALUES (src/duck/distinct-key.ts: only a primary key drops its DISTINCT):
  // a UNIQUE text column holding NULLs and a case pair, a UNIQUE citext (one value in either case), a partial unique
  // index (repeats where it does not apply), a composite UNIQUE (a column repeats), and references to each; `pairs` has
  // a composite primary key whose first column is named `id` and repeats; `vkeys` a varchar primary key (joined from a
  // text column: the key side read through a relabel)
  "CREATE TABLE public.keyed (id int PRIMARY KEY, code text UNIQUE, tag citext UNIQUE, part int, a int NOT NULL, b int NOT NULL, ref text, tag_ref citext, UNIQUE (a, b)); " +
  "CREATE UNIQUE INDEX keyed_part ON public.keyed (part) WHERE part > 0; " +
  "INSERT INTO public.keyed VALUES (1, 'a', 'x', 1, 1, 1, 'a', 'X'), (2, 'A', 'y', 2, 1, 2, 'a', 'x'), (3, NULL, NULL, 0, 2, 1, 'A', 'Y'), (4, NULL, 'Zz', 0, 2, 2, NULL, NULL), " +
  "(5, 'b', NULL, -1, 3, 1, 'zz', 'zZ'), (6, '', 'w', -1, 3, 2, '', 'none'), (7, 'c', 'v', NULL, 4, 1, 'b', 'W'), (8, 'd', 'u', NULL, 4, 2, NULL, 'v'); " +
  "CREATE TABLE public.pairs (id int, line int, v text, PRIMARY KEY (id, line)); " +
  "INSERT INTO public.pairs VALUES (1, 1, 'a'), (1, 2, 'a'), (2, 1, 'A'), (2, 2, NULL), (3, 1, 'b'), (5, 1, 'none'), (5, 2, ''), (5, 3, 'c'); " +
  "CREATE TABLE public.vkeys (id varchar(8) PRIMARY KEY, label text); " +
  "INSERT INTO public.vkeys VALUES ('a', 'one'), ('A', 'one'), ('b', NULL), ('', 'empty'), ('zz', 'two'), ('none', 'two');" +
  FROM_ITEM_VIEWS

/** a round of changes the poll carries: values move, a row goes, one comes */
export function typedMutations(round: number): string {
  // a row of each mapped type read by the poll, as the copy read the first (a round's text, and a whole-table read)
  const mapped = `INSERT INTO public.mapped VALUES (${10 + round}, ${Object.values(MAPPED).map((m) => m.values[round % 5]).join(", ")}); UPDATE public.mapped SET id = id WHERE id = 2;`;
  return mapped + typedRows(round);
}

function typedRows(round: number): string {
  return round === 1
    ? "UPDATE public.typed SET i4 = i4 + 1, f8 = f8 * 2, n = n + 0.01, t = t || 'x', tz = tz + interval '1 hour', jb = jb || '{\"r\": 1}', ai = ai || 9, ci = upper(ci), ip = '10.3.6.46' WHERE id IN (2, 4); UPDATE public.typed SET f8 = 'NaN', t = 'é2' WHERE id = 103; DELETE FROM public.typed WHERE id = 7; " +
      "INSERT INTO public.typed (id, i2, i4, i8, f8, n, t, d, tz, iv, jb, ai, at) VALUES (11, 11, 11, 11, 11.5, 11.25, 'new', '2026-10-24', '2026-10-24 12:00:00+00', '11 minutes', '{\"n\": 11}', '{11}', '{new}')"
    : "UPDATE public.typed SET i8 = NULL, t = NULL, jb = NULL, ai = NULL WHERE id = 11; UPDATE public.typed SET b = NOT b, d = d + 1 WHERE id < 10; " +
      "UPDATE public.typed_arrays SET ca = ca || 'Z'::citext, ia = ia || '192.168.0.1'::inet, jba = jba || '{\"m\": 2}'::jsonb, n = n + 1 WHERE id IN (1, 4)";
}

const ORDINARY = "id < 100";
const OPS = ["=", "<>", "<", "<=", ">", ">="];
const pairs = <T>(xs: readonly T[]): Array<[T, T]> => xs.flatMap((a) => xs.map((b): [T, T] => [a, b]));
/** a statement of the matrix; `zone`, the session's TimeZone it is asked in (UTC where none is said) */
export interface Matrixed { name: string; sql: string; zone?: string; inOrder?: boolean }
const q = (name: string, sql: string, zone?: string): Matrixed => ({ name: `type matrix: ${name}`, sql, ...(zone === undefined ? {} : { zone }) });

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

/**
 * A JSON READ'S PATH, HOWEVER IT IS SPELLED (issue 130, src/duck/rewrite.ts `jsonPath`): every spelling of one path is
 * one read, so each is held over every path on both types; then what must NOT read as a constant (a cast that changes the
 * value, an element a row holds), the NULLs, the functions, and the shapes a tool groups and sorts by.
 */
function* jsonPathCases(): Generator<Matrixed> {
  const paths: string[][] = [["k"], ["n"], ["t"], ["f"], ["z"], ["o"], ["a"], ["missing"], ["o", "b"], ["o", "0"], ["o", "missing"], ["k", "b"], ["0"], ["1"], ["-1"], ["2"],
    ["a", "0"], ["a", "1"], ["a", "2", "0"], ["a", "-1"], ["a", "-7"], ["a", "4", "1"], ["a", "5", "x"], ["2", "1"], ["2", "2", "1"], ["a.b"], ['q"r'], ["o.b"], ["e"], ["k", "0"], ["+1"], [" 1"], ["1 "], ["01"], [""]];
  const array = (p: string[]): string => `ARRAY[${p.map((e) => `'${e}'`).join(", ")}]`;
  const literal = (p: string[]): string => `'{${p.map((e) => `"${e.replaceAll('"', '\\"')}"`).join(",")}}'`;
  const spellings: Array<[string, (p: string[]) => string]> = [
    ["a literal", literal], ["an array", array], ["an array cast", (p) => `${array(p)}::text[]`], ["a literal cast", (p) => `${literal(p)}::text[]`],
    ["an array of casts", (p) => `ARRAY[${p.map((e) => `'${e}'::text`).join(", ")}]`], ["a varchar array", (p) => `${array(p)}::varchar[]`],
  ];
  for (const c of ["j", "jb"]) for (const [name, spell] of spellings) {
    yield q(`a path as ${name}, ->> ${c}`, `SELECT id, ${paths.map((p) => `${c} #>> ${spell(p)}`).join(", ")} FROM jpath ORDER BY id`);
    yield q(`a path as ${name}, -> ${c}`, `SELECT id, ${paths.map((p) => `${c} #> ${spell(p)}`).join(", ")} FROM jpath ORDER BY id`);
  }
  for (const c of ["j", "jb"]) {
    const fn = c === "j" ? "json" : "jsonb";
    // the empty path and the NULLs
    yield q(`an empty path, ${c}`, `SELECT id, ${c} #>> '{}', ${c} #> '{}', ${c} #>> '{}'::text[], ${c} #> ARRAY[]::text[], ${c} #>> ARRAY[]::text[], ${c} #>> ARRAY[]::varchar[], ${fn}_extract_path(${c}, VARIADIC '{}'), ${fn}_extract_path_text(${c}, VARIADIC ARRAY[]::text[]) FROM jpath ORDER BY id`);
    yield q(`a NULL path or element, ${c}`, `SELECT id, ${c} #>> NULL, ${c} #> NULL, ${c} #>> NULL::text[], ${c} #> ARRAY['k', NULL], ${c} #>> ARRAY[NULL, 'k'], ${c} #>> ARRAY[NULL]::text[], ${c} #> '{k,NULL}', ${c} #>> '{NULL}'::text[], ${c} #>> '{"NULL"}', ${c} #>> ARRAY['NULL'], ${c} #>> ARRAY['k', NULL::text], ${c} #>> CAST(NULL AS text[]) FROM jpath ORDER BY id`);
    // what must not read as the text it was written with: the cast changes it, or a row holds it
    yield q(`a cast that cuts a key, ${c}`, `SELECT id, ${c} #>> ARRAY['kk'::varchar(1)], ${c} ->> 'kk'::varchar(1), ${c} ->> 'k '::char(2), ${c} -> 'kk'::varchar(1), ${fn}_extract_path_text(${c}, 'kk'::varchar(1)), ${c} #>> ARRAY['k ']::text[] FROM jpath ORDER BY id`);
    for (const path of ["ARRAY['kk']::varchar(1)[]", "'{kk}'::varchar(1)[]", "ARRAY['kk']::char(1)[]", "'{kk}'::char(1)[]", "ARRAY['kk']::text[]::varchar(1)[]", "ARRAY['k ']::char(2)[]", "ARRAY['k '::char(2)]", "ARRAY['k']::name[]"]) {
      yield q(`a path through a type that changes it, ${c}: ${path}`, `SELECT id, ${c} #>> ${path} FROM jpath ORDER BY id`);
    }
    yield q(`a path a row or an expression holds, ${c}`, `SELECT id, ${c} #>> ARRAY[CASE WHEN id % 2 = 0 THEN 'k' ELSE 'o' END], ${c} #>> ARRAY['o', id::text], ${c} #> ARRAY['k' || ''], ${c} #>> ARRAY[lower('K')], ${c} #>> string_to_array('o,b', ','), ${c} #>> ARRAY[NULLIF('k', 'k')], ${c} #>> CASE WHEN id > 3 THEN '{k}'::text[] END FROM jpath ORDER BY id`);
    // an array literal as array_in reads it
    yield q(`a path literal as array_in reads it, ${c}`, `SELECT id, ${c} #>> '[2:3]={o,b}', ${c} #>> ' { o , b } ', ${c} #>> '{"o",b}', ${c} #>> E'{o,\\b}', ${c} #>> '[0:0]={k}'::text[], ${c} #> '{"a.b"}', ${c} #> E'{"q\\"r"}', ${c} #>> '{Null}' FROM jpath ORDER BY id`);
    yield q(`a path of two dimensions, ${c}`, `SELECT ${c} #>> '{{a},{b}}' FROM jpath ORDER BY id`);
    yield q(`a path array of arrays, ${c}`, `SELECT ${c} #>> ARRAY[ARRAY['a'], ARRAY['b']] FROM jpath ORDER BY id`);
    // a chain: each read folded, and the path read off a read
    yield q(`a chain of path reads, ${c}`, `SELECT id, ${c} #> ARRAY['o'] #>> ARRAY['b'], ${c} #> '{o}'::text[] #>> '{b}', ${c} #> ARRAY['a'] #>> ARRAY['0'], ${c} #> ARRAY[]::text[] #>> ARRAY['k'], ${c} #> ARRAY['o'] #> ARRAY['b'] #>> ARRAY[]::text[], ${c} #> ARRAY['o', NULL] #>> ARRAY['b'], ${c} -> 'o' #>> ARRAY['b'], ${c} #> ARRAY['o'] ->> 'b', ${c} -> 'a'::text -> 0 ->> '0'::text FROM jpath ORDER BY id`);
    // the functions take the same route
    yield q(`${fn}_extract_path, every spelling`, `SELECT id, ${fn}_extract_path(${c}, 'o', 'b'), ${fn}_extract_path_text(${c}, 'o', 'b'), ${fn}_extract_path(${c}, 'o'::text, 'b'::text), ${fn}_extract_path_text(${c}, 'k'::varchar), ${fn}_extract_path_text(${c}, VARIADIC ARRAY['o', 'b']), ${fn}_extract_path(${c}, VARIADIC ARRAY['o', 'b']::text[]), ${fn}_extract_path_text(${c}, VARIADIC '{o,b}'), ${fn}_extract_path(${c}, VARIADIC '{a,0}'::text[]), ${fn}_extract_path_text(${c}, 'a', '0'), ${fn}_extract_path_text(${c}, '1'), ${fn}_extract_path_text(${c}, 'a', '-1'), ${fn}_extract_path_text(${c}, 'a.b'), ${fn}_extract_path_text(${c}, 'q"r') FROM jpath ORDER BY id`);
    yield q(`${fn}_extract_path, the NULLs and a row's element`, `SELECT id, ${fn}_extract_path(${c}, 'k', NULL), ${fn}_extract_path_text(${c}, NULL), ${fn}_extract_path_text(${c}, NULL::text), ${fn}_extract_path_text(${c}, 'o', NULL::text), ${fn}_extract_path(${c}, VARIADIC ARRAY['k', NULL]), ${fn}_extract_path_text(${c}, VARIADIC NULL), ${fn}_extract_path_text(${c}, VARIADIC NULL::text[]), ${fn}_extract_path_text(${c}, 'o', id::text), ${fn}_extract_path_text(${c}, VARIADIC ARRAY['o', id::text]), ${fn}_extract_path_text(${c}, 'kk'::varchar(1)) FROM jpath ORDER BY id`);
    // a path grouped, ordered and filtered on, as a tool sends it
    for (const [name, path] of [["an array", "ARRAY['k']"], ["an array cast", "ARRAY['k']::text[]"], ["a literal", "'{k}'"], ["two keys", "ARRAY['o', 'b']"], ["an index", "ARRAY['a', '0']"]] as const) {
      const v = `${c} #>> ${path}`;
      yield q(`${c} #>> ${name}: grouped, by the ordinal`, `SELECT ${v}, count(*) FROM jpath GROUP BY 1 ORDER BY 1`);
      yield q(`${c} #>> ${name}: grouped, by the output name`, `SELECT ${v} AS v, count(*) FROM jpath GROUP BY v ORDER BY v DESC NULLS LAST`);
      yield q(`${c} #>> ${name}: grouped by the expression, ordered by the name`, `SELECT ${v} AS v, count(*) AS n FROM jpath GROUP BY ${v} ORDER BY v`);
      yield q(`${c} #>> ${name}: grouped by the expression, ordered by it`, `SELECT ${v}, count(*) FROM jpath GROUP BY ${v} ORDER BY ${v} NULLS FIRST`);
      yield q(`${c} #>> ${name}: ordered by the output name`, `SELECT id, ${v} AS v FROM jpath ORDER BY v, id`);
      yield q(`${c} #>> ${name}: ordered by it, the nulls idiom`, `SELECT id FROM jpath ORDER BY (${v}) IS NULL, ${v}, id`);
      yield q(`${c} #>> ${name}: filtered`, `SELECT id FROM jpath WHERE ${v} = 'alpha' OR ${v} IN ('Zed', '12') OR ${v} LIKE '%ea' ORDER BY id`);
      yield q(`${c} #>> ${name}: DISTINCT and an aggregate`, `SELECT DISTINCT ${v} FROM jpath ORDER BY 1`);
      yield q(`${c} #>> ${name}: min, max and count(DISTINCT)`, `SELECT min(${v}), max(${v}), count(DISTINCT ${v}) FROM jpath`);
      // (the database's: a libc order in CI's Postgres, oracle/README)
      for (const [kind, coll] of [["bytes", '"C"'], ["ICU", '"und-x-icu"'], ["the database's order", '"default"']] as const) {
        yield q(`${c} #>> ${name}: ordered under ${kind}`, `SELECT id, ${v} AS v FROM jpath ORDER BY v COLLATE ${coll}, id`);
        yield q(`${c} #>> ${name}: compared under ${kind}`, `SELECT id FROM jpath WHERE (${v}) COLLATE ${coll} > 'b' ORDER BY id`);
        yield q(`${c} #>> ${name}: grouped, ordered under ${kind}`, `SELECT ${v} AS v, count(*) FROM jpath GROUP BY 1 ORDER BY v COLLATE ${coll}`);
      }
    }
  }
  yield q("jb #> an array: grouped by its output name", "SELECT jb #> ARRAY['o'] AS v, count(*) FROM jpath GROUP BY v ORDER BY v");
  yield q("jb #> an array: ordered by its output name", "SELECT id, jb #> ARRAY['a', '0'] AS v FROM jpath ORDER BY v, id");
  yield q("j #> an array: grouped, which json refuses", "SELECT j #> ARRAY['o'] AS v, count(*) FROM jpath GROUP BY v");
  yield q("j #> an array as text: grouped by its output name", "SELECT (j #> ARRAY['o'])::text AS v, count(*) FROM jpath GROUP BY v ORDER BY v");
  yield q("#> an array compared", "SELECT id FROM jpath WHERE jb #> ARRAY['k'] = '\"alpha\"'::jsonb OR jb #> ARRAY['o'] = '{}' ORDER BY id");
  yield q("a grouped view by an array path, ordered by its output name", "SELECT * FROM jpath_by_array ORDER BY v");
  yield q("a grouped view by an array path, its columns, descending", "SELECT v, n FROM jpath_by_array ORDER BY v DESC NULLS LAST");
  yield q("a grouped view by a literal path, ordered by its output name", "SELECT v, n FROM jpath_by_literal ORDER BY v");
  yield q("a grouped view by an array path, ordered under ICU", `SELECT v, n FROM jpath_by_array ORDER BY v COLLATE "und-x-icu"`);
  yield q("a path in a subquery, grouped by its output name", "SELECT s.v, count(*) FROM (SELECT jb #>> ARRAY['k'] AS v FROM jpath) s GROUP BY s.v ORDER BY s.v");
  yield q("a path read beside a * of the same table", "SELECT *, jb #>> ARRAY['k'] AS v FROM jpath ORDER BY v, id");
  yield q("a ->> read beside a * of the same table", "SELECT *, jb ->> 'k' AS v FROM jpath ORDER BY v, id");
  yield q("a path off a computed document", "SELECT id, ('{\"a\": 1}'::jsonb) #>> ARRAY['a'], jsonb_build_object('a', 'p', 'a', 'q') #>> ARRAY['a'] FROM jpath WHERE id < 3 ORDER BY id");
}

/** each column of `mapped`, every way a tool reads one (the issue's list: the statement a BI tool's fingerprint, breakout
 *  and filter send) */
function* mappedTypes(): Generator<Matrixed> {
  for (const [c, m] of Object.entries(MAPPED)) {
    const name = `mapped ${m.type}`;
    yield q(`${name}: rows`, `SELECT id, ${c} FROM mapped ORDER BY id`);
    yield q(`${name}: its NULL`, `SELECT id, ${c} IS NULL, ${c} IS NOT NULL FROM mapped ORDER BY id`);
    yield q(`${name}: counts`, `SELECT count(*), count(${c}) FROM mapped`);
    yield q(`${name}: pg_typeof`, `SELECT pg_typeof(${c}), pg_typeof(${c})::text FROM mapped ORDER BY id LIMIT 1`);
    yield q(`${name}: information_schema`, `SELECT column_name, data_type, udt_name, datetime_precision, character_maximum_length FROM information_schema.columns WHERE table_name = 'mapped' AND column_name = '${c}'`);
    yield q(`${name}: pg_attribute`, `SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'mapped'::regclass AND attname = '${c}'`);
    if (m.eq !== undefined) {
      yield q(`${name}: =`, `SELECT id FROM mapped WHERE ${c} = ${m.eq} ORDER BY id`);
      yield q(`${name}: <>`, `SELECT id FROM mapped WHERE ${c} <> ${m.eq} ORDER BY id`);
      yield q(`${name}: IN`, `SELECT id FROM mapped WHERE ${c} IN (${m.eq}) ORDER BY id`);
      // (a cast to a domain is refused by Postgres's catalog here: the gap domain-column)
      if (!m.type.startsWith("shop_")) yield q(`${name}: =, as a cast`, `SELECT id FROM mapped WHERE ${c} = ${m.eq}::${m.type} ORDER BY id`);
    }
    yield q(`${name}: grouped, by the count`, `SELECT ${c}::text AS v, count(*) FROM mapped GROUP BY ${c} ORDER BY 2, ${c}::text COLLATE "C"`);
    yield q(`${name}: grouped, ORDER BY the column`, `SELECT ${c}, count(*) FROM mapped GROUP BY ${c} ORDER BY ${c}`);
    yield q(`${name}: grouped, ORDER BY ordinal`, `SELECT ${c}, count(*) FROM mapped GROUP BY 1 ORDER BY 1`);
    yield q(`${name}: grouped, ORDER BY its output name`, `SELECT ${c} AS v, count(*) FROM mapped GROUP BY v ORDER BY v`);
    yield q(`${name}: grouped, ORDER BY the qualified column`, `SELECT m.${c}, count(*) FROM mapped m GROUP BY m.${c} ORDER BY m.${c} DESC NULLS LAST`);
    yield q(`${name}: the nulls idiom`, `SELECT id FROM mapped ORDER BY ${c} IS NULL, ${c}, id`);
    yield q(`${name}: DISTINCT`, `SELECT v FROM (SELECT DISTINCT ${c}::text AS v FROM mapped) s ORDER BY v COLLATE "C"`);
    yield q(`${name}: DISTINCT of the column`, `SELECT count(*) FROM (SELECT DISTINCT ${c} FROM mapped) s`);
    yield q(`${name}: DISTINCT ON`, `SELECT DISTINCT ON (${c}) id FROM mapped ORDER BY ${c}, id`);
    yield q(`${name}: count(DISTINCT)`, `SELECT count(DISTINCT ${c}) FROM mapped`);
    yield q(`${name}: min, max`, `SELECT min(${c}), max(${c}) FROM mapped`);
    yield q(`${name}: text, length`, `SELECT id, length(${c}::text) FROM mapped ORDER BY id`);
    yield q(`${name}: text, substring`, `SELECT id, substring(${c}::text, 1, 3), substring(${c}::text, 1, 1234) FROM mapped ORDER BY id`);
    yield q(`${name}: text, contains`, `SELECT id FROM mapped WHERE ${c}::text LIKE '%1%' ORDER BY id`);
    yield q(`${name}: text, ILIKE`, `SELECT id FROM mapped WHERE ${c}::text ILIKE '%a%' ORDER BY id`);
    yield q(`${name}: as written, substring`, `SELECT substring(${c}, 1, 3) FROM mapped ORDER BY id`);
    yield q(`${name}: as written, length`, `SELECT length(${c}) FROM mapped ORDER BY id`);
    yield q(`${name}: as written, LIKE`, `SELECT id FROM mapped WHERE ${c} LIKE '%1%' ORDER BY id`);
    // each collation kind: a text compared and sorted under the default (the database's), C and ICU
    yield q(`${name}: its text sorted`, `SELECT id, ${c}::text FROM mapped ORDER BY ${c}::text, id`);
    yield q(`${name}: its text sorted, C`, `SELECT id FROM mapped ORDER BY ${c}::text COLLATE "C", id`);
    yield q(`${name}: its text sorted, ICU`, `SELECT id FROM mapped ORDER BY ${c}::text COLLATE "und-x-icu", id`);
    yield q(`${name}: its text compared`, `SELECT id FROM mapped WHERE ${c}::text > '1' ORDER BY id`);
    yield q(`${name}: its text compared, C`, `SELECT id FROM mapped WHERE ${c}::text COLLATE "C" > '1' ORDER BY id`);
    yield q(`${name}: its text compared, ICU`, `SELECT id FROM mapped WHERE ${c}::text COLLATE "und-x-icu" > '1' ORDER BY id`);
    yield q(`${name}: in a subquery`, `SELECT s.${c} FROM (SELECT id, ${c} FROM mapped) s ORDER BY s.id`);
    yield q(`${name}: beside a *`, `SELECT m.${c}, m.* FROM mapped m WHERE m.id = 1`);
    yield q(`${name}: a parameter of its type`, `SELECT id, COALESCE(${c}, NULL) FROM mapped ORDER BY id`);
  }
  yield q("mapped: every column", "SELECT * FROM mapped ORDER BY id");
  yield q("a grouped star read by name", "WITH w AS (SELECT * FROM grouped GROUP BY name, id) SELECT * FROM w GROUP BY y, name, a_id, id ORDER BY id");
  yield q("a grouped star read in a subquery", "SELECT o.id FROM public.one o WHERE o.id IN (SELECT id FROM (SELECT * FROM grouped GROUP BY name, id) s)");
  yield q("a grouped star, a column read from it", "SELECT s.y FROM (SELECT * FROM grouped GROUP BY name, id) s ORDER BY s.id");
  yield q("mapped: a row's text", "SELECT m::text FROM mapped m WHERE id = 1");
  yield q("mapped: a joined value", "SELECT a.id, b.id FROM mapped a JOIN mapped b ON a.mc = b.mc ORDER BY 1, 2");
  yield q("mapped: an element", "SELECT id, maa[1], cda[1], tza[1], oia[1] FROM mapped ORDER BY id");
  yield q("mapped: an array unnested", "SELECT id, x FROM mapped, unnest(cda) AS x ORDER BY id, x::text");
  yield q("mapped: an array's length", "SELECT id, cardinality(maa), array_length(tza, 1) FROM mapped ORDER BY id");
  yield q("mapped: a composite's field", "SELECT id, (ps).a FROM mapped ORDER BY id");
  yield q("mapped: a range's bound", "SELECT id, lower(r4), upper(r4), isempty(r4) FROM mapped ORDER BY id");
  yield q("mapped: a range contains", "SELECT id FROM mapped WHERE r4 @> 3 ORDER BY id");
  yield q("mapped: a point's x", "SELECT id, pt[0] FROM mapped ORDER BY id");
  yield q("mapped: money as a number", "SELECT id, mn::numeric FROM mapped ORDER BY id");
  yield q("mapped: money summed", "SELECT sum(mn) FROM mapped");
  yield q("mapped: a tsvector matched", "SELECT id FROM mapped WHERE tv @@ 'a'::tsquery ORDER BY id");
  yield q("mapped: a cidr contains", "SELECT id FROM mapped WHERE cd >> '10.1.0.0/16' ORDER BY id");
  yield q("mapped: a regclass as its oid", "SELECT id, rc::oid FROM mapped ORDER BY id");
  yield q("mapped: a text read as a held type", "SELECT id, t::macaddr FROM typed WHERE false");
  yield q("mapped: an oid compared", "SELECT id FROM mapped WHERE oi > 1 ORDER BY id");
  yield q("mapped: an oid as a bigint", "SELECT id, oi::bigint FROM mapped ORDER BY id");
  // a timetz: read in zones with daylight saving and a half-hour offset, compared by its instant and then its zone
  for (const zone of ["UTC", "America/New_York", "Asia/Kolkata"]) {
    yield q(`mapped timetz in ${zone}: rows`, "SELECT id, tz, tz3, tz::text FROM mapped ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: sorted`, "SELECT id FROM mapped ORDER BY tz, id", zone);
    yield q(`mapped timetz in ${zone}: compared`, "SELECT id FROM mapped WHERE tz < '12:00:00+00' ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: every comparison`, "SELECT id, tz <= tz3, tz > tz3, tz >= tz3, tz < tz3, tz BETWEEN '01:00:00+00' AND '12:00:00+00' FROM mapped ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: at a zone with daylight saving`, "SELECT id, tz AT TIME ZONE 'America/New_York', timezone('Asia/Kolkata', tz3) FROM mapped ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: an hour back`, "SELECT id, tz - interval '1 hour', interval '25 hours' + tz FROM mapped ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: a column cast to a precision`, "SELECT id, tz::timetz(1) FROM mapped ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: a text read as one`, "SELECT id, t::timetz FROM typed WHERE false", zone);
    yield q(`mapped timetz in ${zone}: a literal with no zone`, "SELECT id FROM mapped WHERE tz = '12:30:00' ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: a literal's value`, "SELECT '12:30:00'::timetz::text = ('12:30:00'::timetz)::text, '12:30:00+01'::timetz, id FROM mapped WHERE id = 1", zone);
    yield q(`mapped timetz in ${zone}: min, max, grouped`, "SELECT min(tz), max(tz), tz IS NULL FROM mapped GROUP BY 3 ORDER BY 3", zone);
    yield q(`mapped timetz in ${zone}: its parts`, "SELECT id, extract(hour FROM tz), extract(timezone FROM tz), extract(minute FROM tz) FROM mapped WHERE tz IS NOT NULL ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: as a time`, "SELECT id, tz::time FROM mapped ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: at a zone`, "SELECT id, tz AT TIME ZONE 'UTC' FROM mapped ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: an hour on`, "SELECT id, tz + interval '1 hour' FROM mapped ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: a time as one`, "SELECT id, tm::timetz FROM typed WHERE id < 3 ORDER BY id", zone);
    yield q(`mapped timetz in ${zone}: a timestamptz as one`, "SELECT id, tz::timetz FROM typed WHERE id < 3 ORDER BY id", zone);
    yield q(`mapped tstzrange in ${zone}: rows`, "SELECT id, rz, mz, rz::text, length(mz::text) FROM mapped ORDER BY id", zone);
  }
}

function* matrix(): Generator<Matrixed> {
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
  yield* jsonPathCases();
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
  // equality alone (under libc: the C key, stored as a column of its own where statements keep equating; src/duck/kept.ts
  // EQUAL_STEPS): IN a list alone and NOT IN one beside the NULLs, count(DISTINCT) per group, grouped beside another key,
  // DISTINCT beside another column, equal to a constant written another way
  yield q("jsonb: IN a list alone", `SELECT id FROM jorder WHERE j IN ('1.00', '{"a": 1}', '[]', 'null', '"a"') ORDER BY id`);
  yield q("jsonb: NOT IN a list", `SELECT id FROM jorder WHERE j NOT IN ('1', '{}') ORDER BY id`);
  yield q("jsonb: count(DISTINCT) per group", "SELECT id % 3, count(DISTINCT j), count(j) FROM jorder GROUP BY 1 ORDER BY 1");
  yield q("jsonb: grouped beside another key", "SELECT id % 2, count(*), min(id) FROM jorder GROUP BY j, id % 2 ORDER BY 3, 1");
  yield q("jsonb: DISTINCT beside another column, counted", "SELECT count(*) FROM (SELECT DISTINCT j, id % 2 FROM jorder) s");
  yield q("jsonb: = a constant written another way", `SELECT id FROM jorder WHERE j = '{"a": 1.000}' OR j = '1.0' ORDER BY id`);
  yield q("jsonb: joined on =, counted per row", "SELECT a.id, count(*) FROM jorder a JOIN jorder b ON a.j = b.j GROUP BY a.id ORDER BY 1");
  // A GROUPED VIEW, as a BI tool sends it: the ORDER BY over the output name, the ordinal or the nulls idiom is keyed
  // over the group's value. Over one text of each value (twice for some, so the counts differ): a group of values
  // written apart writes one of them (jsonb-equal-text), here there is one
  const once = "SELECT j FROM public.jorder WHERE id IN (SELECT min(id) FROM public.jorder GROUP BY j)";
  const g = `(${once} UNION ALL ${once} AND id % 4 = 0)`;
  yield q("jsonb: grouped view, ORDER BY the column DESC", `SELECT j, count(*) FROM ${g} AS e GROUP BY j ORDER BY j DESC, 2`);
  yield q("jsonb: grouped view, ORDER BY its output name", `SELECT "e"."j" AS "e.j", count(*) AS "count" FROM ${g} AS "e" GROUP BY 1 ORDER BY "e.j" DESC, "count" DESC LIMIT 100 OFFSET 0`);
  yield q("jsonb: grouped view, its NULLs first", `SELECT "e"."j" AS "e.j", count(*) AS "count" FROM ${g} AS "e" GROUP BY 1 ORDER BY ("e"."j") IS NULL ASC, "e"."j" DESC LIMIT 100 OFFSET 0`);
  yield q("jsonb: grouped view, ORDER BY 1", `SELECT j, count(*) FROM ${g} AS e GROUP BY j ORDER BY 1`);
  // the group's own tree, qualified, sorted: under libc the group is the equality key and the sort the collation's, so
  // the sort reads the group's value (any_value), never the column
  yield q("jsonb: grouped view, qualified, ORDER BY the column", `SELECT e.j, count(*) FROM ${g} AS e GROUP BY e.j ORDER BY e.j`);
  yield q("jsonb: grouped view, qualified, ORDER BY the column DESC", `SELECT e.j, count(*) FROM ${g} AS e GROUP BY e.j ORDER BY e.j DESC, 2`);
  yield q("jsonb: grouped view, qualified, its NULLs last", `SELECT e.j, count(*) FROM ${g} AS e GROUP BY e.j ORDER BY e.j IS NULL, e.j DESC`);
  yield q("jsonb: grouped view, HAVING",`SELECT "e"."j" AS "e.j", count(*) AS "count" FROM ${g} AS "e" GROUP BY "e.j" HAVING "e"."j" IS NOT NULL AND count(*) >= 1 ORDER BY "e.j" DESC`);
  // the same class over text: a column the GROUP BY's key decides is read through any_value, and an ORDER BY of its
  // ordinal or output name sorts a copy of that under the database's collation (it sorted by bytes before)
  yield q("text decided by the key, ORDER BY its ordinal and its name", "SELECT t AS name, id FROM typed GROUP BY id ORDER BY 1, 2 LIMIT 40");
  yield q("jsonb: grouped view of the copy, counted", `SELECT count(*) AS "count", min("e"."id") FROM "public"."jorder" AS "e" GROUP BY "e"."j" ORDER BY ("e"."j") IS NULL ASC, "e"."j" DESC LIMIT 100`);
  // the review's: a jsonb the GROUP BY's key decides, sorted by its ordinal; a set operation sorted by a jsonb; a * sorted
  // by another column's number; containment with ANY, and a raw scalar's containment of an array
  yield q("jsonb: decided by the key, ORDER BY its ordinal", "SELECT id, j FROM jorder GROUP BY id ORDER BY 2, 1");
  yield q("jsonb: decided by the key, DISTINCT", "SELECT count(*) FROM (SELECT DISTINCT j FROM jorder GROUP BY id) s");
  yield q("jsonb: UNION ALL sorted by its ordinal", "SELECT id, j FROM jorder WHERE id < 40 UNION ALL SELECT id, j FROM jorder WHERE id >= 40 ORDER BY 2, 1");
  yield q("jsonb: UNION ALL sorted by its name", "SELECT id, j FROM jorder WHERE id < 40 UNION ALL SELECT id, j FROM jorder WHERE id >= 40 ORDER BY j DESC, id");
  yield q("jsonb: a * sorted by another column's number", "SELECT * FROM (SELECT id, j FROM jorder) s ORDER BY 1");
  yield q("jsonb: contained, with ANY", `SELECT id FROM jorder WHERE j @> ANY (ARRAY['{"a": 1}'::jsonb, '[1]', '"a"']) OR j <@ ALL (ARRAY['[1, 2, "b"]'::jsonb, '[1, "b"]']) ORDER BY id`);
  yield q("jsonb: a raw scalar's containment", `SELECT id, j @> '[1]', '[1, "a"]' @> j FROM jorder ORDER BY id`);
  yield q("jsonb: equality beside a value only a sort refuses", `SELECT count(*), min(n) FROM (SELECT j, id AS n FROM jorder UNION ALL SELECT '{"t": "❤️"}', 0 FROM public.one) s WHERE j = '{"a": 1.00}' OR j = '{"t": "❤️"}' GROUP BY j ORDER BY 2`);
  yield q("jsonb[]: contained, searched (refused)", "SELECT id FROM typed_arrays WHERE jba @> ARRAY['{\"a\": 1.0}'::jsonb] OR array_position(jba, '1'::jsonb) IS NOT NULL ORDER BY id");
  yield q("jsonb: a row holding one, compared (refused)", "SELECT id FROM jorder WHERE (id, j) = (2, '\"a\"') ORDER BY id");
  yield q("jsonb: an empty string, as a key, a member and the value", `SELECT id FROM jorder, (VALUES ('{"": 1}'::jsonb), ('[""]'), ('""'), ('{"": ""}')) v(x) WHERE id < 3 ORDER BY x, id`);
  yield q("jsonb: a 1,000-string array's last string", `SELECT id FROM jorder WHERE j::text LIKE '"%' ORDER BY ('[' || repeat('"x", ', 999) || (j::text) || ']')::jsonb, id`);
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
  // the session's settings beside a table, never DuckDB's own (GitHub issue 40): missing_ok's form, a name the session
  // holds (application_name, the startup's), one it does not (block_size, Postgres's own), one nobody knows
  yield q("current_setting beside a table, the session's and Postgres's", "SELECT id, current_setting('TimeZone', true), current_setting('search_path'), current_setting('application_name', false), " +
    "current_setting('block_size'), current_setting('no_such_setting', true) FROM typed WHERE id < 3 AND current_setting('search_path') <> '' ORDER BY id");
  yield q("current_setting beside a table, written pg_catalog's", "SELECT id, pg_catalog.current_setting('TimeZone'), pg_catalog.current_setting('application_name', true) FROM typed WHERE id < 3 ORDER BY id");
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
  // ---- issue 128: an emoji, a Thai vowel, a mark in the value, in every form a BI tool orders by -----------------------
  yield q("every value in the database's order", "SELECT id, s FROM coll ORDER BY s, id");
  yield q("every value in the database's order, descending", "SELECT s FROM coll ORDER BY s DESC NULLS FIRST, id");
  yield q("every value's sort by its bytes", `SELECT id FROM coll ORDER BY s COLLATE "C", id`);
  yield q("every value's sort under ICU", `SELECT id FROM coll ORDER BY s COLLATE "und-x-icu", id`);
  yield q("every value grouped, by its ordinal", "SELECT s, count(*) FROM coll GROUP BY 1 ORDER BY 1");
  yield q("every value grouped, by its output name", "SELECT s AS v, count(*) FROM coll GROUP BY 1 ORDER BY v DESC");
  yield q("every value grouped, by the qualified column", "SELECT c.s, count(*) FROM coll c GROUP BY c.s ORDER BY c.s ASC NULLS LAST");
  yield q("a dropdown's values", "SELECT DISTINCT s FROM coll ORDER BY 1");
  yield q("a dropdown's values, limited", "SELECT DISTINCT s FROM coll ORDER BY 1 LIMIT 12");
  yield q("a page of values", "SELECT id, s FROM coll ORDER BY s, id LIMIT 7 OFFSET 40");
  yield q("a field's values past the emoji, as Metabase lists them", "SELECT s FROM coll GROUP BY s ORDER BY s DESC LIMIT 20");
  yield q("min and max of every value", "SELECT min(s), max(s) FROM coll");
  yield q("min and max of each group of values", "SELECT length(s), min(s), max(s) FROM coll GROUP BY 1 ORDER BY 1");
  yield q("every value compared with an emoji's", "SELECT id FROM coll WHERE s > 'Sales \u2764\uFE0F' ORDER BY id");
  yield q("every value compared with a Thai vowel's", "SELECT id FROM coll WHERE s <= '\u0E40\u0E01' ORDER BY id");
  yield q("every value compared with a spelled accent's", "SELECT id FROM coll WHERE s >= 'e\u0301' AND s < 'f' ORDER BY id");
  yield q("every value between two", "SELECT count(*) FILTER (WHERE s BETWEEN '\u{1F44D}' AND 'b'), count(*) FILTER (WHERE s < '\u0378'), count(*) FILTER (WHERE s > '12a') FROM coll");
  yield q("the values equal, an emoji's", "SELECT id FROM coll WHERE s IN ('Sales \u2764\uFE0F', '\u0E40\u0E01', 'e\u0301', '\u33E9') ORDER BY id");
  yield q("every value's greatest and least", "SELECT id, greatest(s, 'Sales'), least(s, 'e\u0301') FROM coll ORDER BY id");
  yield q("every value ranked", "SELECT id, rank() OVER (ORDER BY s), lag(id) OVER (ORDER BY s, id) FROM coll ORDER BY id");
  yield q("every value as a jsonb, sorted", "SELECT id FROM coll ORDER BY to_jsonb(s), id");
  yield q("every value's nulls idiom", "SELECT s FROM coll GROUP BY s ORDER BY s IS NULL, s");
  yield q("a statement over a * ordered by every value", "SELECT * FROM coll ORDER BY 2, 1");
  yield q("a run of marks, of digits and of punctuation", "SELECT s FROM coll WHERE id IN (50, 51, 78, 79, 80, 81, 82, 83, 84, 85, 93, 94, 95, 96) ORDER BY s");
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
  // A TOP N OVER JOINED TABLES (issue 105). Every order total, so Postgres's row order is the answer, but where ties are the point
  const JOINED = "FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id LEFT JOIN top_c c ON b.id = c.b_id";
  const TOTAL = "a.id, b.id NULLS FIRST, c.id NULLS FIRST";
  yield q("top N over joins: the tool's preview, every table's columns", `SELECT a.*, b.*, c.* ${JOINED} ORDER BY (a.made) IS NULL ASC, a.made DESC, ${TOTAL} LIMIT 12 OFFSET 0`);
  yield q("top N over joins: a *", `SELECT * ${JOINED} ORDER BY (a.made) IS NULL ASC, a.made DESC, ${TOTAL} LIMIT 12 OFFSET 5`);
  yield q("top N over joins: a * beside named columns", `SELECT a.id AS key, *, c.label ${JOINED} ORDER BY ${TOTAL} LIMIT 9`);
  yield q("top N over joins: no match, a key NULL on the side the join supplies", `SELECT a.id, b.id, c.id, c.label, c.doc ${JOINED} ORDER BY c.label NULLS FIRST, ${TOTAL} LIMIT 15`);
  yield q("top N over joins: NULLs last in a descending key", `SELECT a.name, b.payload, c.doc ->> 'n' ${JOINED} ORDER BY c.id DESC NULLS LAST, b.id, a.id LIMIT 8`);
  yield q("top N over joins: OFFSET past the end", `SELECT a.*, c.* ${JOINED} ORDER BY ${TOTAL} LIMIT 10 OFFSET 100000`);
  yield q("top N over joins: LIMIT 0", `SELECT a.*, c.* ${JOINED} ORDER BY ${TOTAL} LIMIT 0`);
  yield q("top N over joins: a row the join multiplies", "SELECT b.id, c.id, b.payload ->> 'k', c.doc FROM top_b b JOIN top_c c ON c.b_id = b.id WHERE b.id = 2 ORDER BY c.id DESC LIMIT 4 OFFSET 1");
  yield q("top N over joins: a cross join's multiples, the same row twice in a row's pair", "SELECT x.id, y.id, x.note, y.note FROM top_a x, top_a y WHERE x.id <= 3 AND y.id <= 3 ORDER BY x.id DESC, y.id LIMIT 7");
  yield q("top N over joins: a table joined to itself", "SELECT x.id, x.name, p.id AS parent, p.note, g.name FROM top_a x LEFT JOIN top_a p ON p.id = x.parent LEFT JOIN top_a g ON g.id = p.parent ORDER BY x.id DESC LIMIT 5");
  yield q("top N over joins: RIGHT and FULL joins", "SELECT a.id, a.note, b.id, b.payload FROM top_a a RIGHT JOIN top_b b ON a.id = b.a_id ORDER BY b.id DESC, a.id LIMIT 6");
  yield q("top N over joins: a FULL join", "SELECT a.id, a.note, b.id, b.amount FROM top_a a FULL JOIN top_b b ON a.id = b.a_id ORDER BY a.id NULLS FIRST, b.id NULLS FIRST LIMIT 9");
  yield q("top N over joins: an expression over a wide column, and exact numerics", "SELECT a.id, upper(a.note), length(c.doc::text), (b.payload ->> 'n')::int + 1 AS n, b.amount / 3, round(b.amount * 1.1, 1) " + `${JOINED} ORDER BY ${TOTAL} LIMIT 10`);
  yield q("top N over joins: a sort by an expression, an ordinal and an output's name", `SELECT a.id AS key, b.id, c.label AS tag, b.payload ${JOINED} ORDER BY lower(a.name) NULLS FIRST, 1, tag NULLS FIRST, 2 NULLS FIRST, c.id NULLS FIRST LIMIT 11`);
  yield q("top N over joins: a sort by a computed output", "SELECT a.id, b.id, b.id * 2 AS twice, c.doc FROM top_a a JOIN top_b b ON a.id = b.a_id LEFT JOIN top_c c ON c.b_id = b.id ORDER BY twice DESC, 1, c.id LIMIT 5");
  yield q("top N over joins: bare names", "SELECT note, payload, doc, label FROM top_a a JOIN top_b b ON a.id = b.a_id JOIN top_c c ON b.id = c.b_id ORDER BY made DESC NULLS LAST, c.id LIMIT 6");
  yield q("top N over joins: a jsonb key and a filter on the wide column", `SELECT a.id, b.payload, c.id ${JOINED} WHERE b.payload ->> 'k' <> 'v3' ORDER BY b.payload, ${TOTAL} LIMIT 7`);
  yield q("top N over joins: a date's text, a timestamptz in a session's zone", `SELECT a.made, b.seen, to_char(a.made, 'YYYY-MM-DD HH24') ${JOINED} ORDER BY date_trunc('day', a.made) DESC NULLS LAST, ${TOTAL} LIMIT 12`, "America/New_York");
  yield q("top N over joins: under the database's collation", `SELECT a.name, a.id, b.id, c.doc ${JOINED} ORDER BY a.name NULLS FIRST, ${TOTAL} LIMIT 14`);
  yield q("top N over joins: under C", `SELECT a.name, a.id, b.id, c.doc ${JOINED} ORDER BY a.name COLLATE "C" DESC NULLS LAST, ${TOTAL} LIMIT 14`);
  yield q("top N over joins: under an ICU collation", `SELECT a.name, a.id, b.id, c.doc ${JOINED} ORDER BY a.name COLLATE "unicode", ${TOTAL} LIMIT 14`);
  yield q("top N over joins: a view among the tables stays as it was", "SELECT a.id, a.note, v.id, v.payload FROM top_a a JOIN top_v v ON a.id = v.a_id ORDER BY v.id DESC LIMIT 5");
  yield q("top N over joins: a derived table and a WITH query stay as they were", "WITH w AS (SELECT * FROM top_b WHERE id > 5) SELECT a.note, w.payload, s.doc FROM top_a a JOIN w ON a.id = w.a_id JOIN (SELECT * FROM top_c) s ON s.b_id = w.id ORDER BY w.id, s.id LIMIT 5");
  yield q("top N over joins: a table of a column named rowid stays as it was", "SELECT r.*, a.note FROM top_r r JOIN top_a a ON a.id = r.a_id ORDER BY r.rowid DESC LIMIT 2");
  yield q("top N over joins: a column named rowid in another case stays as it was", "SELECT r.id, r.\"RowId\", a.note FROM top_rc r JOIN top_a a ON a.id = r.a_id ORDER BY r.id DESC LIMIT 2");
  yield q("top N over joins: a *, sorted by a column number", "SELECT a.*, b.seen FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY 2, 1, b.id LIMIT 5");
  yield q("top N over joins: a * first, sorted by its first column", "SELECT *, a.id FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY 1 DESC, 6 LIMIT 5");
  yield q("top N over joins: two *, sorted by numbers", "SELECT a.*, b.* FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY 2, 1, 6 LIMIT 5");
  yield q("top N over joins: a number past the *'s first table", "SELECT *, a.id FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY 7, 1, 6 LIMIT 5");
  yield q("top N over joins: a *'s number output sorted by its name", "SELECT a.id, b.* FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY amount DESC, 1, b.id LIMIT 5");
  // AN OUTPUT OF A `*` SORTED BY ITS NUMBER OR ITS BARE NAME (issue 112): by that column's key, as the column named is.
  // Rows of equal keys stay apart by id, so that each answer is one order
  yield q("star sort: by number, text", "SELECT * FROM star_o ORDER BY 3 NULLS FIRST, 1");
  yield q("star sort: by bare name, text", "SELECT * FROM star_o ORDER BY name NULLS FIRST, id");
  yield q("star sort: by number, a LIMIT chooses the rows", "SELECT * FROM star_o ORDER BY 3 NULLS FIRST, 1 LIMIT 4");
  yield q("star sort: by bare name, a LIMIT chooses the rows", "SELECT * FROM star_o ORDER BY name NULLS FIRST, id LIMIT 4");
  yield q("star sort: descending", "SELECT * FROM star_o ORDER BY 3 DESC, 1");
  yield q("star sort: descending by name, its NULLs last, an OFFSET", "SELECT * FROM star_o ORDER BY name DESC NULLS LAST, id LIMIT 3 OFFSET 2");
  yield q("star sort: a citext by number", "SELECT * FROM star_o ORDER BY 4, 1");
  yield q("star sort: a citext by bare name, descending", "SELECT * FROM star_o ORDER BY ci DESC, id LIMIT 5");
  yield q("star sort: a char(n) by number", "SELECT * FROM star_o ORDER BY 5 NULLS FIRST, 1");
  yield q("star sort: a char(n) by bare name", "SELECT * FROM star_o ORDER BY ch DESC, id LIMIT 5");
  yield q("star sort: a jsonb by number", "SELECT * FROM star_o ORDER BY 6, 1");
  yield q("star sort: a jsonb by bare name", "SELECT * FROM star_o ORDER BY j DESC, id LIMIT 4");
  yield q("star sort: a number that is an integer column", "SELECT * FROM star_o ORDER BY 2 DESC, 1");
  yield q("star sort: t.*", "SELECT t.* FROM star_o t ORDER BY 3 NULLS FIRST, 1");
  yield q("star sort: t.* by bare name, the table by its schema", "SELECT star_o.* FROM public.star_o ORDER BY name NULLS FIRST, id LIMIT 4");
  yield q("star sort: a * and the same column again, by the name both answer to", "SELECT *, name FROM star_o ORDER BY name NULLS FIRST, id");
  yield q("star sort: a target before the *", "SELECT upper(name) AS u, * FROM star_o ORDER BY 4 NULLS FIRST, 2");
  yield q("star sort: a target after the *, by its number", "SELECT *, id FROM star_o ORDER BY 3 NULLS FIRST, 8");
  yield q("star sort: the number of a target past the *, text", "SELECT *, name AS again FROM star_o ORDER BY 8 NULLS FIRST, 1");
  yield q("star sort: the number of a computed target past the *", "SELECT *, lower(name) || 'x' AS low FROM star_o ORDER BY 8 NULLS FIRST, 1");
  yield q("star sort: the second output is the *'s second column, no other target", "SELECT *, id FROM star_o ORDER BY 2, 1");
  yield q("star sort: an output past the * by its alias", "SELECT *, name AS again FROM star_o ORDER BY again NULLS FIRST, id LIMIT 4");
  yield q("star sort: a table's *, a target of a join", "SELECT a.*, b.y FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY 8, 1, b.id");
  yield q("star sort: a table's *, a target of a join, the star's column first", "SELECT a.*, b.y FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY 3, 8");
  yield q("star sort: over a join, the number of its second table's column", "SELECT a.id, b.* FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY 4, 1, 2");
  yield q("star sort: a join's *, numbers", "SELECT * FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY 10 NULLS FIRST, 3, 8");
  yield q("star sort: a join under a LIMIT, by number", "SELECT a.*, b.y FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY 8, 1, b.id LIMIT 2");
  yield q("star sort: a join under a LIMIT, by bare name", "SELECT a.*, b.y FROM star_o a LEFT JOIN star_b b ON b.a_id = a.id ORDER BY ch NULLS FIRST, y NULLS FIRST, a.id LIMIT 3");
  yield q("star sort: a join's two *, under a LIMIT", "SELECT a.*, b.* FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY 10 NULLS FIRST, 3, 8 LIMIT 3");
  yield q("star sort: a join's jsonb by number, under a LIMIT", "SELECT a.*, b.y FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY 6, 8, b.id LIMIT 3");
  yield q("star sort: a table's citext by number, over a join under a LIMIT", "SELECT a.*, b.y FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY 4, 8, b.id LIMIT 3");
  yield q("star sort: a bare name both tables have (42702)", "SELECT * FROM star_o a JOIN star_b b ON b.a_id = a.id ORDER BY name");
  yield q("star sort: a bare name a * and another target answer (42702)", "SELECT *, id AS name FROM star_o ORDER BY name");
  yield q("star sort: a bare name a join's USING merged", "SELECT * FROM star_o a JOIN star_b b USING (name) ORDER BY name NULLS FIRST");
  yield q("star sort: the number of a column a LEFT JOIN's USING merged", "SELECT * FROM star_o a LEFT JOIN star_b b USING (name) ORDER BY 1 NULLS FIRST, 2");
  yield q("star sort: the number of a column a FULL JOIN's USING merged", "SELECT * FROM star_o a FULL JOIN star_b b USING (name) ORDER BY 1 NULLS FIRST, 2, 8");
  yield q("star sort: a named join's columns", "SELECT j.* FROM (star_o a JOIN (SELECT a_id, y FROM star_b) b ON b.a_id = a.id) AS j ORDER BY 3 NULLS FIRST, 8, 1");
  yield q("star sort: a named join's merged column", "SELECT j.* FROM (star_o a FULL JOIN (SELECT name, y FROM star_b) b USING (name)) AS j ORDER BY 1 NULLS FIRST, 2, 7");
  yield q("star sort: an aliased column list", "SELECT * FROM star_o AS x(key, m, label) ORDER BY 3 NULLS FIRST, 1");
  yield q("star sort: an aliased column list, by its new name", "SELECT * FROM star_o AS x(key, m, label) ORDER BY label NULLS FIRST, key LIMIT 4");
  yield q("star sort: an aliased column list hides the old name (42703)", "SELECT * FROM star_o AS x(key, m, label) ORDER BY name");
  yield q("star sort: a view's *", "SELECT * FROM star_v ORDER BY 2 NULLS FIRST, 1");
  yield q("star sort: a view's * by bare name", "SELECT * FROM star_v ORDER BY name NULLS FIRST, id LIMIT 4");
  yield q("star sort: a view's citext and char(n)", "SELECT v.* FROM star_v v ORDER BY 3, 1");
  yield q("star sort: a CTE's *", "WITH w AS (SELECT id, name FROM star_o) SELECT * FROM w ORDER BY 2 NULLS FIRST, 1");
  yield q("star sort: a CTE's * by bare name", "WITH w AS (SELECT * FROM star_o WHERE n > 1) SELECT * FROM w ORDER BY name NULLS FIRST, id LIMIT 4");
  yield q("star sort: a CTE's jsonb and citext by number", "WITH w AS (SELECT * FROM star_o) SELECT w.* FROM w ORDER BY 6, 4, 1");
  yield q("star sort: a derived table's *", "SELECT * FROM (SELECT name, id FROM star_o) s ORDER BY 1 NULLS FIRST, 2");
  yield q("star sort: a derived table's column of byte order", "SELECT s.* FROM (SELECT id, name COLLATE \"C\" AS name FROM star_o) s ORDER BY 2 NULLS FIRST, 1");
  yield q("star sort: a derived table's computed column", "SELECT * FROM (SELECT id, name || '!' AS shout FROM star_o) s ORDER BY shout NULLS FIRST, 1");
  yield q("star sort: a list of VALUES", "SELECT * FROM one, (VALUES ('b'), ('A'), ('a'), ('Z')) AS v ORDER BY 2");
  yield q("star sort: a list of VALUES, its columns named", "SELECT * FROM one, (VALUES (1, 'b'), (2, 'A'), (3, 'a'), (4, 'Z')) AS v(k, s) ORDER BY s, k");
  yield q("star sort: a function's column", "SELECT * FROM one, unnest(ARRAY['b', 'A', 'a', 'Z']) AS u ORDER BY 2");
  yield q("star sort: DISTINCT", "SELECT DISTINCT * FROM (SELECT name, ch FROM star_o) s ORDER BY 1 NULLS FIRST, 2");
  yield q("star sort: DISTINCT over a table, by number", "SELECT DISTINCT id, name FROM star_o ORDER BY 2 NULLS FIRST, 1");
  yield q("star sort: DISTINCT *, by number", "SELECT DISTINCT * FROM star_b ORDER BY 3 NULLS FIRST, 1");
  yield q("star sort: DISTINCT *, by bare name", "SELECT DISTINCT * FROM star_b ORDER BY name NULLS FIRST, id LIMIT 4");
  yield q("star sort: DISTINCT ON a number of the *", "SELECT DISTINCT ON (3) * FROM star_b ORDER BY 3 NULLS FIRST, 1");
  yield q("star sort: DISTINCT ON a jsonb by its number", "SELECT DISTINCT ON (6) * FROM star_o ORDER BY 6, 1");
  yield q("star sort: GROUP BY the key by number", "SELECT * FROM star_o GROUP BY 1 ORDER BY 3 NULLS FIRST, 1");
  yield q("star sort: GROUP BY the key, sorted by a column it decides", "SELECT * FROM star_o GROUP BY id ORDER BY name NULLS FIRST, id LIMIT 4");
  yield q("star sort: GROUP BY every column of a derived table by number", "SELECT * FROM (SELECT name, ch FROM star_o) s GROUP BY 1, 2 ORDER BY 1 NULLS FIRST, 2");
  yield q("star sort: GROUP BY an output past the *", "SELECT *, upper(name) AS u FROM (SELECT name, id FROM star_o) s GROUP BY 1, 2, u ORDER BY 3 NULLS FIRST, 2");
  // the keys not the *'s leading columns in order: its columns stay in their places (a review finding: the GROUP BY's order)
  yield q("star sort: GROUP BY keys in another order", "SELECT * FROM star_b GROUP BY name, id ORDER BY 1");
  yield q("star sort: GROUP BY every column in another order", "SELECT * FROM star_b GROUP BY y, a_id, name, id ORDER BY 1");
  yield q("star sort: t.* and an aggregate, keys in another order", "SELECT b.*, count(*) FROM star_b b GROUP BY b.id, b.name ORDER BY 1");
  yield q("star sort: GROUP BY numbers in another order", "SELECT * FROM star_b GROUP BY 3, 1 ORDER BY 1");
  yield q("star sort: GROUP BY keys in another order, sorted by a key", "SELECT * FROM star_b GROUP BY id, name ORDER BY 3 NULLS FIRST, 1");
  yield q("star sort: GROUP BY a join's keys, the second table's first", "SELECT * FROM star_o a JOIN star_b b ON b.a_id = a.id GROUP BY b.id, a.id ORDER BY 1, 7");
  yield q("star sort: GROUP BY a join's keys", "SELECT * FROM star_o a JOIN star_b b ON b.a_id = a.id GROUP BY a.id, b.id ORDER BY 1, 7");
  yield q("star sort: a target before the *, the key it names", "SELECT id, * FROM star_b GROUP BY id ORDER BY 1");
  yield q("star sort: a target after the *, the key it names", "SELECT *, id AS again FROM star_b GROUP BY name, id ORDER BY 5");
  yield q("star sort: two tables' *, keys of each", "SELECT b.*, a.* FROM star_o a JOIN star_b b ON b.a_id = a.id GROUP BY a.id, b.id ORDER BY 1, 5");
  yield q("star sort: a * twice under a GROUP BY", "SELECT *, * FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 2");
  yield q("star sort: a derived table's *, keys in another order", "SELECT * FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 1");
  // a * in a subquery of a target: that SELECT's own outputs, never the query around it (a review finding)
  for (const [i, sql] of [
    "SELECT *, * FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 2",
    "SELECT s.*, * FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 1",
    "SELECT *, s.* FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 1",
    "SELECT * FROM (SELECT * FROM star_b GROUP BY name, id) s ORDER BY 1",
    "SELECT * FROM (SELECT * FROM star_b GROUP BY y, id) s ORDER BY 1",
    "WITH w AS (SELECT * FROM star_b GROUP BY name, id) SELECT * FROM w ORDER BY 1",
    "WITH w AS (SELECT * FROM star_b GROUP BY name, id) SELECT * FROM w GROUP BY y, name, a_id, id ORDER BY 1",
    "SELECT id, (SELECT count(*) FROM (SELECT * FROM star_b GROUP BY name, id) s) FROM star_o GROUP BY id ORDER BY 1",
    "SELECT o.id, (SELECT s.name FROM (SELECT * FROM star_b GROUP BY name, id) s WHERE s.id = o.id) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT name FROM (SELECT * FROM star_b GROUP BY name, id) s WHERE s.id = o.id) FROM star_o o GROUP BY o.id ORDER BY 1",
    "SELECT o.id, (SELECT ci FROM (SELECT * FROM star_o ORDER BY 4, 1 LIMIT 1) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.ci FROM (SELECT * FROM star_o ORDER BY ci, id LIMIT 1) x) AS first_ci FROM star_o o ORDER BY 1",
    "SELECT o.id FROM star_o o WHERE EXISTS (SELECT * FROM star_b b GROUP BY b.name, b.id HAVING b.id = o.id) ORDER BY 1",
    "SELECT o.id FROM star_o o WHERE o.id IN (SELECT id FROM (SELECT * FROM star_b GROUP BY name, id) s) ORDER BY 1",
    "SELECT *, upper(name) AS u FROM (SELECT id, name FROM star_b) s GROUP BY upper(name), name, id ORDER BY 1",
    "SELECT * FROM (SELECT id, name FROM star_b) s GROUP BY GROUPING SETS ((id, name)) ORDER BY 1",
    "SELECT * FROM (SELECT id, name FROM star_b) s GROUP BY GROUPING SETS ((name, id)) ORDER BY 1",
    "SELECT *, count(*) FROM (SELECT id, name FROM star_b) s GROUP BY CUBE (name, id) ORDER BY 1 NULLS LAST, 2 NULLS LAST, 3",
    "SELECT s.* FROM (SELECT id, name FROM star_b) AS s(k, v) GROUP BY v, k ORDER BY 1",
    "SELECT * FROM (SELECT id, name FROM star_b) AS s(k, v) GROUP BY v, k ORDER BY 1",
    "SELECT * FROM (SELECT id, name FROM star_b) s GROUP BY s.name, s.id ORDER BY 1",
    "SELECT *, count(*) FROM (SELECT id, name FROM star_b) s GROUP BY s.name, s.id ORDER BY 1",
    "SELECT x.* FROM (SELECT * FROM star_b GROUP BY name, id) x JOIN one_c o ON o.id = x.id GROUP BY o.id, x.id ORDER BY 1",
    "SELECT * FROM (SELECT * FROM star_b GROUP BY name, id) x JOIN one_c o ON o.id = x.id GROUP BY o.id, x.id ORDER BY 1",
    "SELECT * FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 1 LIMIT 2 OFFSET 1",
    "SELECT *, (SELECT max(id) FROM star_o) FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 1",
    "SELECT (SELECT max(id) FROM star_o), * FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 2",
    "SELECT s, * FROM (SELECT id, name FROM star_b) s GROUP BY name, id ORDER BY 2",
    "SELECT *, s FROM (SELECT id, name FROM star_b) s GROUP BY s, name, id ORDER BY 1",
    "SELECT upper(name), * FROM (SELECT id, name FROM star_b) s GROUP BY upper(name), name, id ORDER BY 2",
    "SELECT id FROM star_o GROUP BY id ORDER BY (SELECT count(*) FROM (SELECT * FROM star_b GROUP BY name, id) s), id",
    "SELECT id, CASE WHEN id > 3 THEN (SELECT count(*) FROM (SELECT * FROM star_b GROUP BY name, id) s) END FROM star_o GROUP BY id ORDER BY 1",
    "SELECT o.id, (SELECT b.name FROM star_b b WHERE b.id = o.id) FROM star_o o GROUP BY o.id ORDER BY 1",
    "SELECT o.id, (SELECT count(*) FROM star_b b GROUP BY b.id HAVING b.id = o.id) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.name FROM (SELECT * FROM star_o a JOIN star_b b USING (id)) x WHERE x.id = o.id) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.n FROM (SELECT * FROM star_o a NATURAL JOIN one_c c) x WHERE x.id = o.id) FROM star_o o ORDER BY 1",
    "SELECT * FROM (SELECT * FROM star_o a JOIN star_b b ON b.a_id = a.id LIMIT 100) s ORDER BY 1, 7",
    "SELECT * FROM (SELECT a.*, b.* FROM star_o a JOIN star_b b ON b.a_id = a.id LIMIT 100) s ORDER BY 1, 7",
    "SELECT o.id, (SELECT count(*) FROM (SELECT * FROM star_b) s) FROM star_o o GROUP BY o.id ORDER BY 1",
    "SELECT o.id, (SELECT count(*) FROM (SELECT * FROM star_b GROUP BY id) s) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT count(*) FROM (SELECT * FROM star_b GROUP BY id, a_id, name, y) s) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT count(*) FROM (SELECT s.*, 1 FROM (SELECT id, name FROM star_b) s GROUP BY name, id) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT count(*) FROM (SELECT * FROM (SELECT id, name FROM star_b) s GROUP BY 2, 1) x) FROM star_o o ORDER BY 1",
    "SELECT count(*) FROM (SELECT (SELECT max(y) FROM star_b), * FROM (SELECT id, name FROM star_b) s GROUP BY name, id) z",
    "SELECT z.* FROM (SELECT (SELECT max(y) FROM star_b) AS m, * FROM (SELECT id, name FROM star_b) s GROUP BY name, id) z ORDER BY 2",
    "SELECT o.id, o.n, (SELECT count(*) FROM (SELECT *, 1 FROM (SELECT id, name FROM star_b) s GROUP BY name, id) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, o.n, (SELECT x.id FROM (SELECT *, 1 AS one FROM (SELECT id, name FROM star_b) s GROUP BY name, id) x WHERE x.id = o.id) FROM star_o o ORDER BY 1",
    "SELECT o.id, o.n, (SELECT x.name FROM (SELECT *, 1 AS one FROM (SELECT id, name FROM star_b) s GROUP BY name, id) x WHERE x.id = o.id) FROM star_o o ORDER BY 1",
    "SELECT o.name, o.id, (SELECT x.name FROM (SELECT *, 1 AS one FROM (SELECT id, name FROM star_b) s GROUP BY name, id) x WHERE x.id = o.id) FROM star_o o ORDER BY 2",
    "SELECT o.n, o.id, (SELECT x.id FROM (SELECT *, 1 AS one FROM star_b s GROUP BY name, id) x WHERE x.id = o.id) FROM star_o o ORDER BY 2",
    "SELECT o.id, o.n, o.name, o.ci, (SELECT x.name FROM (SELECT *, 1 AS one FROM star_b s GROUP BY name, id) x WHERE x.id = o.id) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT max(x.ci) FROM (SELECT * FROM star_o ORDER BY 4 LIMIT 2) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, o.n, (SELECT x.ci FROM (SELECT *, 1 AS one FROM star_o ORDER BY 4, 1 LIMIT 1) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT b.name FROM star_b b WHERE b.id = o.id ORDER BY 1 LIMIT 1) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT b.* FROM (SELECT name FROM star_b) b ORDER BY 1 LIMIT 1) FROM star_o o ORDER BY 1",
    "SELECT o.id, ARRAY(SELECT x.name FROM (SELECT * FROM star_b GROUP BY name, id) x ORDER BY x.id) FROM star_o o ORDER BY 1",
    "SELECT o.id, EXISTS (SELECT * FROM (SELECT * FROM star_b GROUP BY name, id) x WHERE x.id = o.id) FROM star_o o ORDER BY 1",
    "SELECT o.id, o.id IN (SELECT x.id FROM (SELECT * FROM star_b GROUP BY name, id) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.ci FROM (SELECT * FROM star_o ORDER BY ci LIMIT 1) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.name FROM (SELECT * FROM star_o ORDER BY name NULLS FIRST LIMIT 1) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.name FROM (SELECT * FROM star_o ORDER BY 3 NULLS FIRST LIMIT 1) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.name FROM (SELECT * FROM star_b ORDER BY 1 LIMIT 1) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.id FROM (SELECT * FROM star_b ORDER BY id LIMIT 1) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT DISTINCT ON (1) x.name FROM (SELECT * FROM star_b) x ORDER BY 1 LIMIT 1) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.name FROM (SELECT DISTINCT ON (3) * FROM star_b ORDER BY 3, 1) x LIMIT 1) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.name FROM (SELECT DISTINCT * FROM star_b) x ORDER BY 1 NULLS FIRST LIMIT 1) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.id FROM (SELECT * FROM star_b UNION ALL SELECT * FROM star_b ORDER BY 3 NULLS FIRST, 1 LIMIT 1) x) FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.name FROM (SELECT * FROM star_b ORDER BY 1 LIMIT 1) x) AS top, (SELECT y.name FROM (SELECT * FROM star_b ORDER BY 1 DESC LIMIT 1) y) AS bottom FROM star_o o ORDER BY 1",
    "SELECT o.id, (SELECT x.name FROM (SELECT * FROM star_b ORDER BY 1 LIMIT 1) x), o.ci FROM star_o o ORDER BY 1",
  ].entries()) yield q(`star sort: a subquery of a target, ${i + 1}`, sql);
  yield q("star sort: FETCH … WITH TIES by number", "SELECT * FROM star_o ORDER BY 3 NULLS FIRST FETCH FIRST 4 ROWS WITH TIES");
  yield q("star sort: FETCH … WITH TIES by bare name", "SELECT * FROM star_o ORDER BY ci FETCH FIRST 3 ROWS WITH TIES");
  yield q("star sort: a UNION's *, by bare name", "SELECT * FROM star_b UNION ALL SELECT * FROM star_b ORDER BY name NULLS FIRST, id LIMIT 6");
  yield q("star sort: a UNION's *, by number", "SELECT * FROM star_b UNION SELECT * FROM star_b ORDER BY 3 NULLS FIRST, 1");
  yield q("star sort: a UNION's *, a number of no key", "SELECT id, name FROM star_b UNION SELECT id, name FROM star_b ORDER BY 2 NULLS FIRST, 1");
  yield q("star sort: a UNION of two named columns, the number of a text", "SELECT id, name FROM star_b UNION ALL SELECT id, name FROM star_b ORDER BY 2 NULLS FIRST, id LIMIT 6");
  yield q("star sort: a UNION's *, a citext by number", "SELECT * FROM star_o UNION ALL SELECT * FROM star_o ORDER BY 4, 1");
  yield q("star sort: a UNION's *, a citext by number under a LIMIT", "WITH w AS (SELECT * FROM star_o UNION ALL SELECT * FROM star_o ORDER BY 4, 1 LIMIT 5) SELECT id, ci FROM w ORDER BY 1, 2");
  yield q("star sort: a UNION's *, a citext by bare name", "SELECT * FROM star_o UNION ALL SELECT * FROM star_o ORDER BY ci DESC, id");
  yield q("star sort: a UNION's *, a char(n) by number", "SELECT * FROM star_o UNION ALL SELECT * FROM star_o ORDER BY 5 NULLS FIRST, 1");
  yield q("star sort: a UNION of named columns, a citext by number", "SELECT id, ci FROM star_o UNION ALL SELECT id, ci FROM star_o ORDER BY 2, 1");
  yield q("star sort: a UNION of named columns, a char(n) by number", "SELECT id, ch FROM star_o UNION ALL SELECT id, ch FROM star_o ORDER BY 2 NULLS FIRST, 1");
  yield q("star sort: a citext beside a DISTINCT ON its key, written out over USING", "SELECT DISTINCT ON (1) * FROM star_o a JOIN star_b b USING (id) ORDER BY 1, 2");
  yield q("star sort: an inside of a subquery", "SELECT id FROM (SELECT * FROM star_o ORDER BY 3 NULLS FIRST, 1 LIMIT 4) s ORDER BY id");
  yield q("star sort: an inet by number is the column's refusal", "SELECT * FROM (SELECT ip FROM typed) s ORDER BY 1");
  yield q("star sort: the nulls idiom, its bare name", "SELECT * FROM star_o ORDER BY name IS NULL, name DESC, id");
  yield q("star sort: the nulls idiom beside a number", "SELECT * FROM star_o ORDER BY name IS NULL, 3 DESC, 1 LIMIT 5");
  yield q("star sort: a VALUES of no name", "SELECT * FROM one, (VALUES ('b'), ('A'), ('a')) ORDER BY 2");
  yield q("star sort: a subquery of no name", "SELECT * FROM (SELECT id, name FROM star_o) ORDER BY 2 NULLS FIRST, 1");
  yield q("star sort: a parameter-free filter on the same column", "SELECT * FROM star_o WHERE name <> 'Z' ORDER BY name NULLS FIRST, id");
  yield q("top N over joins: a table's whole row stays as it was", "SELECT row_to_json(a), b.id FROM top_a a JOIN top_b b ON a.id = b.a_id ORDER BY b.id LIMIT 3");
  yield q("top N over joins: USING of two tables, a *", "SELECT * FROM top_a a JOIN top_b b USING (id) ORDER BY id LIMIT 3");
  yield q("top N over joins: DISTINCT takes another path", `SELECT DISTINCT a.id, b.payload ->> 'k' AS k ${JOINED} ORDER BY a.id, k NULLS FIRST LIMIT 6`);
  yield q("top N over joins: GROUP BY takes another path", `SELECT a.id, count(c.id), max(c.label) ${JOINED} GROUP BY a.id ORDER BY 2 DESC, 1 LIMIT 4`);
  yield q("top N over joins: a window takes another path", `SELECT a.id, b.id, row_number() OVER (PARTITION BY a.id ORDER BY b.id, c.id) ${JOINED} ORDER BY a.id, b.id NULLS FIRST, c.id NULLS FIRST LIMIT 6`);
  yield q("top N over joins: a subquery in the list takes another path", "SELECT a.id, (SELECT count(*) FROM top_b x WHERE x.a_id = a.id) FROM top_a a JOIN top_b b ON a.id = b.a_id ORDER BY b.id LIMIT 3");
  // TIES: which of equal rows a LIMIT keeps is defined by neither, so the limit falls where the tie ends (three rows
  // of made = 01:00, four with the NULLs below them), and the rows are held as a set
  yield { ...q("top N over joins: ties, the limit where they end", "SELECT a.id, a.note, p.note FROM top_a a LEFT JOIN top_a p ON p.id = a.parent WHERE a.made IS NOT NULL ORDER BY a.made DESC LIMIT 3"), inOrder: false };
  // FETCH … WITH TIES (issue 192): its keys the sort pass's, its rank in no row at any depth, a set operation, the count
  // and offset Postgres's, numerics exact, and over joins the list fetched after the rank (held as sets: ties have no order)
  const TIES_A = "SELECT a.id, a.made FROM top_a a ORDER BY a.made DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES";
  yield q("with ties: a computed output beside a * by number", "SELECT count(*) FROM (SELECT a.*, a.id % 3 AS m, b.payload FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY 6 FETCH FIRST 2 ROWS WITH TIES) s");
  yield q("with ties: * beside a computed output, one table", "SELECT count(*) FROM (SELECT *, s.n % 2 AS m FROM star_o s ORDER BY 7 FETCH FIRST 1 ROWS WITH TIES) x");
  yield q("with ties: UNION ALL by number", "SELECT count(*) FROM (SELECT a.id % 3 AS m, a.id FROM top_a a UNION ALL SELECT b.id % 3, b.id FROM top_b b ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES) s");
  yield q("with ties: UNION by a text output's name, the database's collation", "SELECT count(*) FROM (SELECT name FROM star_o UNION SELECT name FROM star_b ORDER BY name NULLS FIRST FETCH FIRST 2 ROWS WITH TIES) s");
  yield q("with ties: EXCEPT by number DESC", "SELECT count(*) FROM (SELECT b.a_id FROM top_b b EXCEPT SELECT a.parent FROM top_a a ORDER BY 1 DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES) s");
  // a set operation's column is Postgres's over every arm, never its first SELECT's (setop-column-typed-by-first-arm, PR 233)
  yield q("with ties: a citext beside a text is the set operation's text", "SELECT count(*) FROM (SELECT x.ci FROM typed x UNION ALL SELECT x.t FROM typed x ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) s");
  yield q("with ties: a later arm's COLLATE \"C\" is the set operation's", "SELECT count(*) FROM (SELECT x.t FROM typed x UNION ALL SELECT x.vc COLLATE \"C\" FROM typed x ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES) s");
  yield q("set operation: a citext beside a text sorted as text", "SELECT x.ci FROM typed x UNION ALL SELECT x.t FROM typed x ORDER BY 1 NULLS FIRST");
  yield q("set operation: a citext UNION a text, without ALL", "SELECT count(*) FROM (SELECT x.ci FROM typed x UNION SELECT x.t FROM typed x) s");
  // each arm cast to the set operation's column: a char(n) arm after a text one is its text, unpadded (setop-arm-cast-dropped, PR 233)
  yield { ...q("with ties: a char(n) arm beside a text is the set operation's text", "SELECT * FROM (SELECT s.name AS x FROM star_o s UNION ALL SELECT s.ch FROM star_o s ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) u"), inOrder: false };
  yield q("set operation: a char(n) arm beside a text printed unpadded", "SELECT s.name AS x FROM star_o s UNION ALL SELECT s.ch FROM star_o s ORDER BY 1 NULLS FIRST");
  yield q("set operation: a char(n) arm beside a text, without ALL", "SELECT x || '|' AS y FROM (SELECT s.name AS x FROM star_o s UNION SELECT s.ch FROM star_o s) u ORDER BY 1 NULLS FIRST");
  // a first SELECT that is only a `*` the cast writes out keeps the set operation's types (setop-star-written-loses-location, PR 233 review r2)
  yield q("set operation: a first * written out for the cast, ordered", "SELECT * FROM (SELECT x.i4, x.id FROM typed x) s UNION ALL SELECT x.f8, x.id FROM typed x ORDER BY 2, 1 NULLS FIRST");
  yield q("set operation: a first * of a date beside a timestamptz, ordered", "SELECT * FROM (SELECT x.d, x.id FROM typed x) s UNION ALL SELECT x.tz, x.id FROM typed x ORDER BY 2, 1 NULLS FIRST");
  // a `*` of two columns of one name is never written out by name; a char(n) column is never compared as text (PR 233 review r3)
  yield q("set operation: a first * of two columns of one name, sent as written", "SELECT count(*) FROM (SELECT * FROM (SELECT x.i4 AS id, x.id FROM typed x) s UNION ALL SELECT x.i4, x.id FROM typed x) u");
  yield { ...q("with ties: a char(n) * arm beside a text, ALL", "SELECT * FROM (SELECT s.ch, s.id FROM star_o s) x UNION ALL SELECT s.name, s.id FROM star_o s ORDER BY 1 NULLS FIRST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  yield q("set operation: a char(n) of one length, without ALL", "SELECT s.ch FROM star_o s UNION SELECT s.ch FROM star_o s ORDER BY 1 NULLS FIRST");
  yield q("with ties: a char(n) * arm beside a text, without ALL", "SELECT * FROM (SELECT s.ch, s.id FROM star_o s) x UNION SELECT s.name, s.id FROM star_o s ORDER BY 1 NULLS FIRST FETCH FIRST 1 ROWS WITH TIES");
  yield q("with ties: a * of two columns of one name, cast for the set operation", "SELECT * FROM (SELECT x.i4 AS id, x.id FROM typed x) s UNION ALL SELECT x.f8, x.id FROM typed x ORDER BY 2 DESC FETCH FIRST 2 ROWS WITH TIES");
  yield q("with ties: a first * written out for the cast", "SELECT count(*) FROM (SELECT * FROM (SELECT x.i4, x.id FROM typed x) s UNION ALL SELECT x.f8, x.id FROM typed x ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) u");
  yield q("with ties: its rank in no row (a derived table beside a column)", `SELECT s.*, 1 AS one FROM (${TIES_A}) s ORDER BY s.id`);
  yield q("with ties: joined after", `SELECT s.id, s.made, b.id AS b FROM (${TIES_A}) s JOIN top_b b ON b.a_id = s.id ORDER BY 1, 3`);
  yield q("with ties: in a CTE read beside a column", `WITH t AS (${TIES_A}) SELECT t.*, t.id * 2 AS twice FROM t ORDER BY t.id`);
  yield q("with ties: IN and EXISTS", "SELECT (SELECT count(*) FROM top_b WHERE a_id IN (SELECT a.id FROM top_a a ORDER BY a.made DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES)), EXISTS (SELECT a.id FROM top_a a ORDER BY a.made FETCH FIRST 1 ROWS WITH TIES)");
  yield q("with ties: a UNION ALL arm", `SELECT count(*) FROM ((${TIES_A}) UNION ALL SELECT 1, NULL) u`);
  yield q("with ties: LATERAL", "SELECT a.id, x.id FROM top_a a CROSS JOIN LATERAL (SELECT b.id FROM top_b b WHERE b.a_id = a.id ORDER BY b.amount > 10 FETCH FIRST 1 ROWS WITH TIES) x ORDER BY 1, 2");
  yield { ...q("with ties: numerics exact", "SELECT b.id, b.amount / 3 AS third FROM top_b b ORDER BY b.a_id NULLS FIRST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  yield q("with ties: grouped numerics exact", "SELECT b.a_id, avg(b.amount) AS av, sum(b.amount) / 7 AS s7 FROM top_b b GROUP BY b.a_id ORDER BY 1 NULLS FIRST FETCH FIRST 2 ROWS WITH TIES");
  yield { ...q("with ties: exact numerics passed through", "SELECT * FROM (SELECT b.id, b.amount / 3 AS third FROM top_b b) s ORDER BY 2 DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  yield q("with ties: a NULL count constant", "SELECT a.id FROM top_a a ORDER BY a.id FETCH FIRST (NULL::int) ROWS WITH TIES");
  yield q("with ties: a negative count", "SELECT a.id FROM top_a a ORDER BY a.id FETCH FIRST (-1) ROWS WITH TIES");
  yield q("with ties: a NULL offset", "SELECT a.id FROM top_a a ORDER BY a.id OFFSET NULL FETCH FIRST 2 ROWS WITH TIES");
  yield q("with ties: a fractional count", "SELECT a.id FROM top_a a ORDER BY a.id FETCH FIRST 2.5 ROWS WITH TIES");
  yield q("with ties: OFFSET past the end", "SELECT a.id, b.payload FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY a.made OFFSET 1000 FETCH FIRST 2 ROWS WITH TIES");
  yield q("with ties: FETCH FIRST 0", "SELECT a.id, b.payload FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY a.made FETCH FIRST 0 ROWS WITH TIES");
  yield { ...q("with ties: over joins, every table's columns", "SELECT a.*, b.*, c.* FROM top_a a LEFT JOIN top_b b ON a.id = b.a_id LEFT JOIN top_c c ON b.id = c.b_id ORDER BY a.made DESC NULLS LAST FETCH FIRST 2 ROWS WITH TIES"), inOrder: false };
  yield { ...q("with ties: RIGHT join", "SELECT a.id, a.note, b.id, b.payload FROM top_a a RIGHT JOIN top_b b ON a.id = b.a_id ORDER BY b.a_id NULLS FIRST FETCH FIRST 2 ROWS WITH TIES"), inOrder: false };
  yield { ...q("with ties: a table joined to itself", "SELECT x.id, x.name, p.id AS parent, p.note FROM top_a x LEFT JOIN top_a p ON p.id = x.parent ORDER BY p.id NULLS FIRST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  yield { ...q("with ties: a join that multiplies", "SELECT x.id, y.id AS y, x.payload FROM top_b x JOIN top_b y ON x.a_id = y.a_id ORDER BY x.a_id FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  yield { ...q("with ties: a plain derived side, NULL where no match", "SELECT a.id, d.k, d.one FROM top_a a LEFT JOIN (SELECT a_id, payload ->> 'k' AS k, 1 AS one FROM top_b WHERE id > 20) d ON d.a_id = a.id ORDER BY a.made DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  yield { ...q("with ties: a wrapper of a join folded", "SELECT * FROM (SELECT a.id, a.made, b.payload FROM top_a a JOIN top_b b ON b.a_id = a.id) t ORDER BY t.made DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  yield { ...q("with ties: USING", "SELECT id, a.note, b.payload FROM top_a a JOIN top_b b USING (id) ORDER BY a.made DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  for (const key of ["m", "1", "b.id % 4"]) yield { ...q(`with ties: a computed key by ${key}`, `SELECT b.id % 4 AS m, b.id, c.doc FROM top_b b JOIN top_c c ON c.b_id = b.id ORDER BY ${key} FETCH FIRST 1 ROWS WITH TIES`), inOrder: false };
  // an output named as Mason's own columns are (PR 233: the offset read the user's __mason_row, the wrapper lost its rank)
  // (read through a subquery each output is a column of a FROM item, refused by name: rewrite-name, PR 233 probe 4)
  yield q("with ties: outputs named __mason_row and __mason_rank", "SELECT a.id AS __mason_row, a.name AS __mason_rank FROM top_a a ORDER BY 2 NULLS FIRST, 1 OFFSET 1 FETCH FIRST 1 ROWS WITH TIES");
  // (its shapes that read it through a subquery, `subquery`, `cte` and `named`, meet each output as a column of a FROM
  // item, refused by name: rewrite-name, PR 233 probe 4, which also refuses #239's reads of a cell's name)
  yield { ...q("with ties: outputs named __mason_rank and __mason_cell_0 over a join", "SELECT a.id AS __mason_rank, a.name AS __mason_cell_0, b.payload FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY a.made DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  // a set operation's numeric under WITH TIES: carried by the union's cells, each value its own scale (PR 233 review r1)
  yield { ...q("with ties: a UNION ALL of a numeric and its quotient", "SELECT b.amount AS x FROM top_b b UNION ALL SELECT b.amount / 3 FROM top_b b ORDER BY 1 DESC NULLS LAST FETCH FIRST 2 ROWS WITH TIES"), inOrder: false };
  yield { ...q("with ties: a UNION ALL of a numeric and its quotient, through a *", "SELECT * FROM (SELECT b.amount AS x FROM top_b b UNION ALL SELECT b.amount / 3 FROM top_b b ORDER BY 1 DESC NULLS LAST FETCH FIRST 2 ROWS WITH TIES) s"), inOrder: false };
  yield { ...q("with ties: a subquery in the list", "SELECT a.id, (SELECT count(*) FROM top_b x WHERE x.a_id = a.id) AS n FROM top_a a JOIN top_b b ON a.id = b.a_id ORDER BY a.made DESC NULLS LAST FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
  for (const key of ["a.name COLLATE \"C\"", "a.name COLLATE \"und-x-icu\"", "a.name NULLS FIRST"]) yield { ...q(`with ties: ordered by ${key}`, `SELECT a.id, a.name, b.payload FROM top_a a JOIN top_b b ON b.a_id = a.id ORDER BY ${key} FETCH FIRST 1 ROWS WITH TIES`), inOrder: false };
  yield q("with ties: a citext key, ties by Postgres's equality", "SELECT count(*) FROM (SELECT s.ci, s.id, s.j FROM star_o s ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) x");
  yield q("with ties: a char(n) key", "SELECT count(*) FROM (SELECT s.ch, s.id FROM star_o s ORDER BY s.ch FETCH FIRST 1 ROWS WITH TIES) x");
  yield q("with ties: jsonb equality", "SELECT count(*) FROM (SELECT o.id, o.j FROM jorder o ORDER BY o.j NULLS LAST OFFSET 5 FETCH FIRST 1 ROWS WITH TIES) x");
  for (const key of ["2 DESC", "n DESC", "count(*) DESC", "1 NULLS FIRST", "a.name"]) yield q(`with ties: grouped, by ${key}`, `SELECT a.name, count(*) AS n FROM top_a a JOIN top_b b ON b.a_id = a.id GROUP BY a.name ORDER BY ${key} FETCH FIRST 1 ROWS WITH TIES`);
  yield { ...q("with ties: stays as it was (a whole row)", "SELECT row_to_json(a), b.id FROM top_a a JOIN top_b b ON a.id = b.a_id ORDER BY a.made FETCH FIRST 1 ROWS WITH TIES"), inOrder: false };
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
  // A ROLE'S ROW FILTER AS MASON BINDS IT (src/duck/row-filter.ts bindFilter): a scalar attribute a CAST of a literal, a list
  // attribute a CAST of an ARRAY of literals to the column's array type — integer[] and uuid[] — under = ANY and <> ALL
  yield q("a row filter's bound list: = ANY of a cast array", "SELECT id FROM typed WHERE i4 = ANY (CAST(ARRAY['0', '1', '7'] AS integer[])) OR u = ANY (CAST(ARRAY['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '00000000-0000-0000-0000-000000000001'] AS uuid[])) ORDER BY id");
  yield q("a row filter's bound list: <> ALL of a cast array, a scalar's cast", "SELECT id FROM typed WHERE i4 <> ALL (CAST(ARRAY['2', '3'] AS integer[])) AND (u IS NULL OR u <> CAST('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AS uuid)) AND id >= CAST('1' AS integer) ORDER BY id");
  // ---- date_trunc of a timestamptz in the session's zone and in a zone of its own (src/duck/rewrite.ts truncInstant):
  // the instant's arithmetic in UTC, the offset kept below a day elsewhere, every part Postgres accepts --------------
  const UNITS = ["microseconds", "milliseconds", "second", "minute", "hour", "day", "week", "month", "quarter", "year", "decade", "century", "millennium"];
  for (const zone of ["UTC", "Europe/Berlin", "America/New_York", "Australia/Lord_Howe", "Asia/Kathmandu"]) {
    yield q(`date_trunc of a timestamptz, every part, in ${zone}`, `SELECT id, ${UNITS.map((u) => `date_trunc('${u}', at) AS "${u}"`).join(", ")} FROM instants ORDER BY id`, zone);
    yield q(`date_trunc of a timestamptz grouped (a histogram), in ${zone}`, "SELECT DATE_TRUNC('hour', i.at) AS h, date_trunc('month', i.at) AS m, count(*) FROM instants i GROUP BY 1, 2 ORDER BY 1 DESC NULLS LAST LIMIT 100", zone);
    yield q(`date_trunc of a timestamptz in a zone of its own, in ${zone}`, "SELECT id, date_trunc('hour', at, 'Europe/Berlin'), date_trunc('minute', at, 'Asia/Kathmandu'), date_trunc('day', at, 'America/New_York'), " +
      "date_trunc('month', at, 'UTC'), date_trunc('century', at, 'Europe/Berlin'), date_trunc('week', at, 'utc'), date_trunc('second', at, 'Australia/Lord_Howe'), date_trunc('quarter', at, 'Etc/UTC') FROM instants ORDER BY id", zone);
    yield q(`date_trunc of a date as a timestamptz, in ${zone}`, "SELECT id, date_trunc('week', at::date), date_trunc('hour', at::date) FROM instants WHERE isfinite(at) ORDER BY id", zone);
  }
  // date_trunc is strict and reads its zone before the part: a NULL zone is NULL for every part (an infinite instant's
  // too), a row's zone is read for every row, and a zone it does not know is its error, whichever the part
  const parts = ["microseconds", "milliseconds", "second", "minute", "hour", "day"];
  yield q("date_trunc in a NULL zone, every part", `SELECT id, ${parts.map((u) => `date_trunc('${u}', at, NULL) AS "${u}"`).join(", ")}, date_trunc('second', at, NULL::text) FROM instants ORDER BY id`);
  const rowZone = "CASE WHEN id % 3 = 0 THEN NULL WHEN id % 3 = 1 THEN 'Europe/Berlin' ELSE 'asia/kathmandu' END";
  yield q("date_trunc in a row's zone, NULL in some", `SELECT id, ${parts.map((u) => `date_trunc('${u}', at, ${rowZone}) AS "${u}"`).join(", ")} FROM instants ORDER BY id`);
  for (const u of ["milliseconds", "second", "hour"]) {
    yield q(`date_trunc('${u}') in a zone it does not know (its error)`, `SELECT id, date_trunc('${u}', at, 'Nowhere/Land') FROM instants ORDER BY id`);
    yield q(`date_trunc('${u}') in a row's zone it does not know (its error)`, `SELECT id, date_trunc('${u}', at, CASE WHEN id = 5 THEN 'Nowhere/Land' ELSE 'UTC' END) FROM instants ORDER BY id`);
  }

  // ---- a LEFT JOIN LATERAL of a list's rows ON TRUE (src/duck/rewrite.ts leftLateral): the preview a BI tool sends,
  // limited, its rows and their order Postgres's; and what is NOT so written (an INNER lateral, a lateral sorted,
  // counted) ------------------------------------------------------------------------------------------------------
  const objectJson = "CASE WHEN substring(ltrim(q.j::text), 1, 1) = '{' THEN q.j::json ELSE NULL END";
  const objectJsonb = "CASE WHEN jsonb_typeof(q.jb) = 'object' THEN q.jb ELSE NULL END";
  for (const [limit, label] of [["LIMIT 100 OFFSET 0", "limited"], ["LIMIT 40 OFFSET 23", "limited and offset"], ["", "whole"]] as const) {
    yield q(`json_each LEFT JOIN ON TRUE, guarded, ${label}`, `SELECT q.*, d.key, d.value FROM (SELECT t.id, t.j FROM docs t) AS q LEFT JOIN json_each(${objectJson}) d ON TRUE ${limit}`);
    yield q(`jsonb_each LEFT JOIN ON TRUE, guarded, ${label}`, `SELECT q.id, d.key, d.value::text FROM (SELECT t.id, t.jb FROM docs t) AS q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE ${limit}`);
    yield q(`json_each_text / jsonb_each_text LEFT JOIN LATERAL ON true, ${label}`, `SELECT q.id, a.key, a.value, b.key, b.value FROM docs q LEFT JOIN LATERAL json_each_text(${objectJson}) a ON true LEFT JOIN LATERAL jsonb_each_text(${objectJsonb}) b ON true ${limit}`);
    yield q(`jsonb_each LEFT JOIN ON TRUE over objects and NULLs alone, unguarded, ${label}`, `SELECT q.id, d.key FROM (SELECT t.id, t.jb FROM docs t WHERE t.id % 17 <> 0 AND t.id % 23 <> 0) AS q LEFT JOIN jsonb_each(q.jb) d ON TRUE ${limit}`);
    yield q(`jsonb_array_elements / _text, jsonb_object_keys, unnest LEFT JOIN ON TRUE, ${label}`, "SELECT q.id, e.v::text, x, k, u FROM docs q LEFT JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(q.jb) = 'array' THEN q.jb END) AS e(v) ON TRUE " +
      `LEFT JOIN jsonb_array_elements_text(CASE WHEN jsonb_typeof(q.jb) = 'array' THEN q.jb END) AS x ON TRUE LEFT JOIN jsonb_object_keys(${objectJsonb}) AS k ON TRUE LEFT JOIN unnest(q.tags) AS u ON TRUE ${limit}`);
  }
  yield q("json_each LEFT JOIN ON TRUE, unguarded over arrays (Postgres's error)", "SELECT q.id, d.key FROM docs q LEFT JOIN json_each(q.j) d ON TRUE");
  yield q("json_each LEFT JOIN ON TRUE, sorted by the lateral's key", `SELECT q.id, d.key, d.value FROM (SELECT t.id, t.j FROM docs t) AS q LEFT JOIN json_each(${objectJson}) d ON TRUE ORDER BY d.key NULLS FIRST, q.id, d.value::text LIMIT 60`);
  yield q("jsonb_each LEFT JOIN ON TRUE, filtered by the lateral's value", `SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE WHERE d.value IS NULL OR jsonb_typeof(d.value) = 'number' LIMIT 50`);
  yield q("jsonb_each INNER lateral, limited", `SELECT q.id, d.key, d.value::text FROM docs q CROSS JOIN LATERAL jsonb_each(${objectJsonb}) d LIMIT 30 OFFSET 5`);
  yield q("json_each INNER JOIN ON TRUE, limited", `SELECT q.id, d.key FROM docs q JOIN json_each(${objectJson}) d ON TRUE LIMIT 30`);
  yield q("jsonb_each LEFT JOIN on a condition", `SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON d.key <> 'n' ORDER BY 1, 2`);
  // json(b)_array_elements(_text)'s column is `value` under a FROM name too, and the FROM name alone is the element
  const arrays = "CASE WHEN jsonb_typeof(q.jb) = 'array' THEN q.jb END";
  for (const join of ["JOIN", "LEFT JOIN"]) {
    yield q(`jsonb_array_elements ${join} ON TRUE, e.value and e`, `SELECT q.id, e.value, e, e::text FROM docs q ${join} jsonb_array_elements(${arrays}) e ON TRUE`);
    yield q(`jsonb_array_elements_text ${join} ON TRUE, e.value and e`, `SELECT q.id, e.value, e FROM docs q ${join} jsonb_array_elements_text(${arrays}) e ON TRUE`);
    yield q(`json_array_elements ${join} ON TRUE, unaliased, by its own name`, `SELECT q.id, value::text, json_array_elements::text FROM docs q ${join} json_array_elements(CASE WHEN json_typeof(q.j) = 'array' THEN q.j END) ON TRUE`);
    yield q(`jsonb_array_elements ${join} ON TRUE, its column named, and the FROM name`, `SELECT q.id, e.v, e FROM docs q ${join} jsonb_array_elements(${arrays}) AS e(v) ON TRUE`);
  }
  yield q("jsonb_array_elements in a comma join, e.value and e", `SELECT q.id, e.value, e FROM docs q, jsonb_array_elements(${arrays}) e`);
  // the lateral's whole row, which is NULL on the padding row (a row of key and value elsewhere: refused by name)
  yield q("jsonb_each LEFT JOIN ON TRUE, its whole row", `SELECT q.id, d FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE`);
  // an array of each element type unnested beside a never-empty list: the padding NULL is of the array's element type
  for (const [limit, label] of [["LIMIT 50 OFFSET 7", "limited"], ["", "whole"]] as const) {
    yield q(`unnest of int[], date[], uuid[] LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, a, b, c FROM docs q LEFT JOIN unnest(q.ia) a ON TRUE LEFT JOIN unnest(q.da) b ON TRUE LEFT JOIN unnest(q.ua) c ON TRUE ${limit}`);
  }
  yield q("unnest of an enum array LEFT JOIN ON TRUE", "SELECT m.id, u, u::text FROM moods m LEFT JOIN unnest(m.ms) u ON TRUE ORDER BY 1, 3");
  // ARRAY(SELECT x …): answered where x is a scalar DuckDB holds as Postgres does; a numeric (exact numeric[]), an
  // array (multi-dimensional, 2202E on an empty one, 22004 on a NULL one) and a row (record[]) are refused, and so is
  // = ANY (ARRAY(SELECT …)) (array-subquery-element)
  yield q("ARRAY(subquery) of a numeric quotient", "SELECT ARRAY(SELECT q.id / 3.0 FROM docs q WHERE q.id < 5 ORDER BY q.id)");
  yield q("ARRAY(subquery) of a rounded numeric", "SELECT ARRAY(SELECT round(q.id::numeric / 7, 20) FROM docs q WHERE q.id < 5 ORDER BY q.id)");
  yield q("ARRAY(subquery) of an int[] column", "SELECT ARRAY(SELECT q.ia FROM docs q WHERE q.id IN (3, 4) ORDER BY q.id)");
  yield q("ARRAY(subquery) of a text[] column", "SELECT ARRAY(SELECT q.tags FROM docs q WHERE q.id IN (2, 3) ORDER BY q.id)");
  yield q("ARRAY(subquery) of an int[] column with an empty array", "SELECT ARRAY(SELECT q.ia FROM docs q WHERE q.id IN (1, 3) ORDER BY q.id)");
  yield q("ARRAY(subquery) of an int[] column with a NULL array", "SELECT ARRAY(SELECT q.ia FROM docs q WHERE q.id IN (3, 5) ORDER BY q.id)");
  yield q("ARRAY(subquery) of a row", "SELECT ARRAY(SELECT (q.id, q.id % 3) FROM docs q WHERE q.id < 4 ORDER BY q.id)");
  yield q("= ANY (ARRAY(subquery)), counted", "SELECT count(*) FROM docs q WHERE q.id = ANY (ARRAY(SELECT d.id / 10 FROM docs d))");
  yield q("ARRAY(subquery) of a text with NULLs", "SELECT ARRAY(SELECT q.j ->> 'z' FROM docs q WHERE q.id < 12 ORDER BY q.id)");
  yield q("ARRAY(subquery) of an integer, descending", "SELECT ARRAY(SELECT q.id * 2 FROM docs q WHERE q.id < 8 ORDER BY q.id DESC)");
  yield q("ARRAY(subquery) of a jsonb", "SELECT ARRAY(SELECT q.jb FROM docs q WHERE q.id < 6 ORDER BY q.id)");
  yield q("ARRAY(subquery) of an enum", "SELECT ARRAY(SELECT m.m FROM moods m ORDER BY m.id)");
  yield q("ARRAY(subquery) of a bool", "SELECT ARRAY(SELECT q.id % 2 = 0 FROM docs q WHERE q.id < 6 ORDER BY q.id)");
  yield q("ARRAY(subquery) of a date", "SELECT ARRAY(SELECT q.da[1] FROM docs q WHERE q.id < 6 ORDER BY q.id)");
  yield q("ARRAY(subquery) of a text[]'s element", "SELECT ARRAY(SELECT q.tags[2] FROM docs q WHERE q.id < 9 ORDER BY q.id DESC)");
  yield q("ARRAY(subquery) of an int[] slice", "SELECT ARRAY(SELECT q.ia[1:1] FROM docs q WHERE q.id IN (3, 4) ORDER BY q.id)");
  yield q("ARRAY(subquery) of no rows", "SELECT ARRAY(SELECT q.id FROM docs q WHERE q.id < 0)");
  yield q("array_length and cardinality of an empty ARRAY(subquery)", "SELECT array_length(ARRAY(SELECT q.id FROM docs q WHERE q.id < 0), 1), cardinality(ARRAY(SELECT q.id FROM docs q WHERE q.id < 0))");
  yield q("ARRAY(subquery) correlated, limited inside", "SELECT m.id, ARRAY(SELECT q.id FROM docs q WHERE q.id % 6 = m.id ORDER BY q.id LIMIT 3) FROM moods m ORDER BY 1");
  // an unnest of an EXPRESSION (leftLateral): its list computed once, streamed under a bound in Postgres's order — the
  // first row (1,1), where DuckDB's delimiter join had (1,10); NULL and empty arrays one row each; an array column's
  // list changed (which a step of its own before the lateral would have made DuckDB's delimiter join); read by a `*`
  for (const [limit, label] of [["LIMIT 1", "limited to 1"], ["LIMIT 3", "limited to 3"], ["", "whole"]] as const) {
    yield q(`unnest of ARRAY[o.id, o.id * 10] LEFT JOIN LATERAL ON true, ${label}`, `SELECT o.id, x FROM orders o LEFT JOIN LATERAL unnest(ARRAY[o.id, o.id * 10]) x ON true ${limit}`);
  }
  for (const [limit, label] of [["LIMIT 50 OFFSET 7", "limited"], ["", "whole"]] as const) {
    yield q(`unnest of a NULL or empty array expression LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, x FROM docs q LEFT JOIN unnest(CASE WHEN q.id % 3 = 0 THEN NULL::int[] WHEN q.id % 3 = 1 THEN ARRAY[]::int[] ELSE ARRAY[q.id, q.id % 7] END) x ON TRUE ${limit}`);
    yield q(`unnest of ARRAY[]::int[] LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, x FROM docs q LEFT JOIN unnest(ARRAY[]::int[]) x ON TRUE ${limit}`);
    yield q(`unnest of a NULL array LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, x FROM docs q LEFT JOIN unnest(NULL::text[]) x ON TRUE ${limit}`);
    yield q(`unnest of an array of json paths LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, v FROM docs q LEFT JOIN unnest(ARRAY[q.jb ->> 'event', q.jb #>> '{nested,k}', q.j ->> 'z']) v ON TRUE ${limit}`);
    // (a subquery in the argument: a delimiter join in every form, limit-lateral-argument)
    yield q(`unnest of a json array's elements as an array LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, v FROM docs q LEFT JOIN unnest(ARRAY(SELECT e FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(q.jb) = 'array' THEN q.jb END) e)) v ON TRUE ${limit}`);
    yield q(`unnest(string_to_array(<a list's text>, ',')) LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, p FROM docs q LEFT JOIN unnest(string_to_array(array_to_string(q.tags, ',', '*'), ',')) p ON TRUE ${limit}`);
    yield q(`two unnests of expressions LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, a, b FROM docs q LEFT JOIN unnest(q.ia || q.id) a ON TRUE LEFT JOIN unnest(array_append(q.tags, 'z')) b ON TRUE ${limit}`);
    yield q(`unnest of an expression LEFT JOIN ON TRUE read by a *, ${label}`, `SELECT * FROM (SELECT t.id, t.tags FROM docs t) q LEFT JOIN unnest(array_append(q.tags, 'x')) x ON TRUE ${limit}`);
    yield q(`unnest of an expression LEFT JOIN ON TRUE in a join with a name of its own, ${label}`, `SELECT w.* FROM ((SELECT t.id, t.ia FROM docs t) q LEFT JOIN unnest(ARRAY[q.id, -q.id]) x ON TRUE) AS w ${limit}`);
  }
  // (orders' rows move in Postgres's heap as the rounds change them: sorted, and by the lateral's column after)
  for (const sep of [",", " "]) {
    yield q(`unnest(string_to_array(col, '${sep}')) LEFT JOIN ON TRUE, sorted by the table's column, limited`, `SELECT o.id, p FROM orders o LEFT JOIN unnest(string_to_array(o.notes, '${sep}')) p ON TRUE ORDER BY o.id DESC, p NULLS FIRST LIMIT 50 OFFSET 7`);
    yield q(`unnest(string_to_array(col, '${sep}')) LEFT JOIN ON TRUE, whole`, `SELECT o.id, p FROM orders o LEFT JOIN unnest(string_to_array(o.notes, '${sep}')) p ON TRUE`);
  }
  // a list whose argument reads TWO or more columns of the row: DuckDB's delimiter join, the rows in its order, until
  // the argument was computed by a step of its own before the lateral (leftLateral) — json rows and an unnest alike;
  // an array among them keeps the lateral as it is (DuckDB streams it there, and plans the step as its join)
  for (const [limit, label] of [["LIMIT 40 OFFSET 7", "limited"], ["", "whole"]] as const) {
    yield q(`jsonb_each LEFT JOIN ON TRUE, guarded by two columns, ${label}`, `SELECT q.id, d.key, d.value::text FROM docs q LEFT JOIN jsonb_each(CASE WHEN q.id % 4 <> 1 AND jsonb_typeof(q.jb) = 'object' THEN q.jb END) d ON TRUE ${limit}`);
    yield q(`json_each_text / jsonb_array_elements_text LEFT JOIN ON TRUE, of two columns, ${label}`, "SELECT q.id, a.key, a.value, e FROM docs q LEFT JOIN json_each_text(CASE WHEN q.id > 5 THEN " + objectJson + " END) a ON TRUE " +
      `LEFT JOIN jsonb_array_elements_text(CASE WHEN q.id % 2 = 0 AND jsonb_typeof(q.jb) = 'array' THEN q.jb END) e ON TRUE ${limit}`);
    yield q(`unnest of an array of two columns LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, x FROM docs q LEFT JOIN unnest(ARRAY[q.id, length(q.j::text)]) x ON TRUE ${limit}`);
    yield q(`unnest of two columns and an array LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, x FROM docs q LEFT JOIN unnest(array_append(q.ia, q.id)) x ON TRUE ${limit}`);
  }
  // an enum read beside another column: a column like any other, computed in the step (where an enum array is not)
  for (const [limit, label] of [["LIMIT 6", "limited to 6"], ["LIMIT 40 OFFSET 7", "limited"]] as const) {
    yield q(`jsonb_each LEFT JOIN ON TRUE, guarded by an enum and a jsonb, ${label}`, `SELECT q.id, d.key, d.value::text FROM moodlog q LEFT JOIN jsonb_each(CASE WHEN q.m = 'ok' AND jsonb_typeof(q.jb) = 'object' THEN q.jb END) d ON TRUE ${limit}`);
    yield q(`jsonb_object_keys LEFT JOIN ON TRUE, guarded by an enum and a jsonb, ${label}`, `SELECT q.id, k FROM moodlog q LEFT JOIN jsonb_object_keys(CASE WHEN q.m = 'ok' AND jsonb_typeof(q.jb) = 'object' THEN q.jb END) k ON TRUE ${limit}`);
    yield q(`unnest of an array of an enum and a text LEFT JOIN ON TRUE, ${label}`, `SELECT q.id, x FROM moodlog q LEFT JOIN unnest(ARRAY[q.m::text, q.s]) x ON TRUE ${limit}`);
  }
  // an argument that raises in a row the LIMIT leaves out: Postgres stops before it, DuckDB computes the argument a
  // vector of rows at a time (limit-errors)
  yield q("unnest of an array with a bad integer in row 10 LEFT JOIN ON TRUE, limited to 3", "SELECT q.id, x FROM docs q LEFT JOIN unnest(ARRAY[q.id, (CASE WHEN q.id = 10 THEN 'x' ELSE '1' END)::int]) x ON TRUE LIMIT 3");
  yield q("jsonb_each of an array document in a row the LIMIT leaves out, limited to 3", "SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(CASE WHEN q.id % 1 = 0 AND q.id > 2 THEN q.jb END) d ON TRUE LIMIT 3");
  // (read by a `*`: the step's column would be read too, so DuckDB's delimiter join stays — limit-lateral-argument)
  yield q("jsonb_each LEFT JOIN ON TRUE, guarded by two columns, read by a *, limited", "SELECT * FROM (SELECT t.id, t.jb FROM docs t) q LEFT JOIN jsonb_each(CASE WHEN q.id % 4 <> 1 AND jsonb_typeof(q.jb) = 'object' THEN q.jb END) d ON TRUE LIMIT 40 OFFSET 7");
  yield q("unnest of an expression LEFT JOIN ON TRUE, sorted by the table's column, limited", "SELECT o.id, x FROM orders o LEFT JOIN unnest(ARRAY[o.id, o.id * 10, NULL]) x ON TRUE ORDER BY o.id DESC, x NULLS FIRST LIMIT 7");
  yield q("unnest of an expression LEFT JOIN ON TRUE under string_agg with no ORDER BY", "SELECT q.id, string_agg(x::text, ',') FROM docs q LEFT JOIN unnest(ARRAY[q.id * 10, q.id]) x ON TRUE GROUP BY q.id ORDER BY q.id");
  yield q("unnest of an expression LEFT JOIN ON TRUE in a derived table, limited outside", "SELECT s.x, s.id FROM (SELECT q.id, x FROM docs q LEFT JOIN unnest(ARRAY[q.id * 10, q.id]) x ON TRUE) s LIMIT 9 OFFSET 3");
  yield q("unnest of an expression LEFT JOIN ON TRUE, counted (DuckDB's own join)", "SELECT count(*), count(x) FROM orders o LEFT JOIN unnest(CASE WHEN o.id % 2 = 0 THEN ARRAY[o.id, o.id] END) x ON TRUE");
  yield q("count(*) over a LEFT JOIN json_each expansion", `SELECT count(*), count(s.key), count(DISTINCT s.key) FROM (SELECT q.*, d.key, d.value FROM (SELECT t.id, t.j FROM docs t) AS q LEFT JOIN json_each(${objectJson}) d ON TRUE) s`);
  // where no LIMIT keeps the first rows, DuckDB's own delimiter join (limitBounds): counted over each kind of list, the
  // empty object's and the NULL's one row included; grouped, distinct, windowed, with a LIMIT above those too
  yield q("count(*) over a LEFT JOIN jsonb_each expansion, no LIMIT", `SELECT count(*), count(s.key), count(s.value) FROM (SELECT q.id, d.key, d.value FROM docs q LEFT JOIN LATERAL jsonb_each(${objectJsonb}) d ON TRUE) s`);
  yield q("count(*) over a LEFT JOIN jsonb_array_elements expansion, no LIMIT", "SELECT count(*), count(s.e), count(DISTINCT s.e::text) FROM (SELECT q.id, e FROM docs q LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(q.jb) = 'array' THEN q.jb END) e ON TRUE) s");
  yield q("jsonb_each LEFT JOIN ON TRUE, counted per row (the empty and NULL documents' one row)", `SELECT q.id, count(*), count(d.key) FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE GROUP BY q.id ORDER BY q.id`);
  yield q("json_each LEFT JOIN ON TRUE, GROUP BY its key", `SELECT d.key, count(*), count(DISTINCT q.id) FROM docs q LEFT JOIN json_each(${objectJson}) d ON TRUE GROUP BY 1 ORDER BY 1 NULLS FIRST`);
  yield q("jsonb_each LEFT JOIN ON TRUE, GROUP BY its key, limited", `SELECT d.key, count(*) FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 3`);
  yield q("jsonb_each LEFT JOIN ON TRUE, DISTINCT", `SELECT DISTINCT d.key, jsonb_typeof(d.value) FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE ORDER BY 1 NULLS FIRST, 2 NULLS FIRST`);
  yield q("jsonb_each LEFT JOIN ON TRUE, DISTINCT, limited", `SELECT DISTINCT q.id FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE WHERE d.key IS NULL ORDER BY 1 LIMIT 10`);
  yield q("jsonb_each LEFT JOIN ON TRUE, under a window", `SELECT q.id, d.key, count(*) OVER (PARTITION BY q.id) AS n, row_number() OVER (PARTITION BY q.id ORDER BY d.key) AS r FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE ORDER BY 1, 2 NULLS FIRST`);
  yield q("jsonb_each LEFT JOIN ON TRUE, under a window, limited", `SELECT q.id, d.key, count(*) OVER (PARTITION BY q.id) AS n FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE ORDER BY 1 DESC, 2 LIMIT 25`);
  // a LIMIT outside the SELECT that holds the join (a derived table, a CTE): streamed, Postgres's rows
  for (const [limit, label] of [["LIMIT 100 OFFSET 0", "limited"], ["LIMIT 40 OFFSET 23", "limited and offset"]] as const) {
    yield q(`json_each LEFT JOIN ON TRUE in a derived table, ${label} outside`, `SELECT * FROM (SELECT q.id, d.key, d.value FROM (SELECT t.id, t.j FROM docs t) AS q LEFT JOIN json_each(${objectJson}) d ON TRUE) AS s ${limit}`);
    yield q(`jsonb_each LEFT JOIN ON TRUE in a CTE, ${label} outside`, `WITH s AS (SELECT q.id, d.key, d.value::text AS v FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE) SELECT s.v, s.key, s.id FROM s ${limit}`);
    yield q(`jsonb_array_elements LEFT JOIN ON TRUE two derived tables down, ${label} outside`, `SELECT x.id, x.e FROM (SELECT s.id, s.e::text AS e FROM (SELECT q.id, e FROM docs q LEFT JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(q.jb) = 'array' THEN q.jb END) e ON TRUE) s WHERE s.id > 3) x ${limit}`);
  }
  // the LIMIT reaching the join through CTEs the walk meets before the SELECT that reads them (markBounds): a CTE read
  // by another CTE, and a CTE both arms of a UNION ALL read
  yield q("jsonb_each LEFT JOIN ON TRUE in a CTE another CTE reads, limited and offset outside", `WITH a AS (SELECT q.id, d.key, d.value::text AS v FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE), b AS (SELECT a.v, a.key, a.id FROM a) SELECT * FROM b LIMIT 40 OFFSET 23`);
  yield q("jsonb_each LEFT JOIN ON TRUE in a CTE both arms of a UNION ALL read, limited outside", `WITH s AS (SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE) SELECT s.id, s.key FROM s UNION ALL SELECT s.id, s.key FROM s LIMIT 40 OFFSET 1280`);
  // (a filter in the CTE that reads it: DuckDB plans the streamed lateral as a delimiter join, limit-lateral-filter)
  yield q("jsonb_each LEFT JOIN ON TRUE in a CTE another CTE filters, limited and offset outside", `WITH a AS (SELECT q.id, d.key, d.value::text AS v FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE), b AS (SELECT * FROM a WHERE a.id > 3) SELECT * FROM b LIMIT 40 OFFSET 23`);
  // an aggregate or a window that reads the rows in the order they come, with no ORDER BY of its own: Postgres hands
  // each document's members in their order (readsInOrder)
  yield q("json_each LEFT JOIN ON TRUE under string_agg with no ORDER BY", `SELECT q.id, string_agg(d.key, ',') FROM docs q LEFT JOIN json_each(${objectJson}) d ON TRUE GROUP BY q.id ORDER BY q.id`);
  yield q("jsonb_each LEFT JOIN ON TRUE under array_agg, json_agg, jsonb_agg, json_object_agg with no ORDER BY", `SELECT q.id, array_agg(d.key), json_agg(d.key), jsonb_agg(d.value), json_object_agg(coalesce(d.key, '-'), d.value)::text FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE GROUP BY q.id ORDER BY q.id`);
  yield q("jsonb_each LEFT JOIN ON TRUE under row_number, lag, first_value with no window ORDER BY", `SELECT q.id, d.key, row_number() OVER (PARTITION BY q.id) AS r, lag(d.key) OVER (PARTITION BY q.id) AS l, first_value(d.key) OVER (PARTITION BY q.id) AS f FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE ORDER BY 1, 3`);
  yield q("jsonb_each LEFT JOIN ON TRUE under row_number() OVER ()", `SELECT row_number() OVER () AS r, q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE ORDER BY 1`);
  yield q("jsonb_each LEFT JOIN ON TRUE under a named window with no ORDER BY", `SELECT q.id, d.key, row_number() OVER w AS r FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE WINDOW w AS (PARTITION BY q.id) ORDER BY 1, 3`);
  // a correlated EXISTS and an IN (SELECT …) under the LIMIT
  yield q("jsonb_each LEFT JOIN ON TRUE, a correlated EXISTS, limited", `SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE WHERE EXISTS (SELECT x.id FROM docs x WHERE x.id = q.id AND x.tags IS NOT NULL) LIMIT 40`);
  yield q("jsonb_each LEFT JOIN ON TRUE, IN (SELECT …), limited", `SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE WHERE q.id IN (SELECT x.id FROM docs x WHERE x.ia IS NOT NULL) LIMIT 40`);
  // a filter on the lateral's own column, and one on the base in the join's own SELECT, under a LIMIT: as written
  // (the first differs, DuckDB's delimiter join: limit-lateral-filter; the parameters shape sends each literal as $1)
  yield q("jsonb_each LEFT JOIN ON TRUE, filtered on the lateral's key, limited", `SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE WHERE d.key <> 'n' LIMIT 40`);
  yield q("jsonb_each LEFT JOIN ON TRUE, filtered on the base in its own SELECT, limited", `SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE WHERE q.id > 3 LIMIT 40`);
  // the nulls idiom over the lateral: once folded, one table column the top N's filter reaches the scan by
  yield q("jsonb_each LEFT JOIN ON TRUE, the nulls idiom on the table's column, limited", `SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE ORDER BY (q.id) IS NULL, q.id DESC, d.key NULLS FIRST LIMIT 30`);
  // ORDER BY a column of the table … LIMIT: streamed (the top N's filter reaches the scan), by name, by ordinal,
  // through a derived table, descending; a json's key held twice is ordered by its value too
  yield q("json_each LEFT JOIN ON TRUE, sorted by the table's column, limited", `SELECT q.id, d.key, d.value FROM docs q LEFT JOIN json_each(${objectJson}) d ON TRUE ORDER BY q.id DESC, d.key NULLS FIRST, d.value::text LIMIT 100`);
  yield q("jsonb_each LEFT JOIN ON TRUE over a derived table, sorted by its ordinal, limited", `SELECT q.id, d.key, d.value::text FROM (SELECT t.id, t.jb FROM docs t) AS q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE ORDER BY 1, 2 NULLS FIRST LIMIT 100 OFFSET 40`);
  yield q("jsonb_each LEFT JOIN ON TRUE in a derived table, sorted by the table's column outside, limited", `SELECT * FROM (SELECT q.id, d.key FROM docs q LEFT JOIN jsonb_each(${objectJsonb}) d ON TRUE) s ORDER BY s.id DESC, s.key NULLS LAST LIMIT 100`);

  // ---- the nulls-placement idiom as one key (src/duck/rewrite.ts nullsKeyFolded): `x IS [NOT] NULL, x` in each
  // direction, bare and parenthesised, limited or whole, beside other keys; and what is not the idiom -----------------
  for (const col of ["ts", "t", "n"]) {
    for (const test of ["IS NULL ASC", "IS NULL DESC", "IS NOT NULL ASC", "IS NOT NULL DESC"]) {
      for (const second of ["DESC", "ASC"]) {
        yield q(`ORDER BY (${col}) ${test}, ${col} ${second}, limited`, `SELECT e.id, e.${col} FROM nullish e ORDER BY (e.${col}) ${test}, e.${col} ${second}, e.id LIMIT 7 OFFSET 3`);
        yield q(`ORDER BY ${col} ${test}, ${col} ${second}`, `SELECT e.${col}, e.id FROM nullish e ORDER BY e.${col} ${test}, e.${col} ${second}, e.id`);
      }
    }
    yield q(`ORDER BY a key, then (${col}) IS NULL, ${col} DESC`, `SELECT e.id, e.${col} FROM nullish e ORDER BY e.id % 3, (e.${col}) IS NULL, e.${col} DESC, e.id LIMIT 10`);
  }
  yield q("ORDER BY ts IS NULL, another column", "SELECT e.id FROM nullish e ORDER BY e.ts IS NULL, e.t DESC, e.id");
  yield q("ORDER BY ts IS NULL alone", "SELECT e.id FROM nullish e ORDER BY e.ts IS NULL, e.id");
  yield q("ORDER BY ts IS NULL, ts under DISTINCT ON", "SELECT DISTINCT ON (e.ts IS NULL, e.ts) e.id, e.ts FROM nullish e ORDER BY e.ts IS NULL, e.ts, e.id");
  yield q("SELECT DISTINCT, ORDER BY t IS NULL, t", "SELECT DISTINCT e.t, e.t IS NULL AS missing FROM nullish e ORDER BY e.t IS NULL, e.t LIMIT 5");
  // a bare key Postgres reads as an OUTPUT column, where the same name in the test is the input's: not the idiom
  yield q("ORDER BY n IS NULL, n where the output n is another expression", "SELECT e.id, coalesce(e.n, 0) AS n FROM nullish e ORDER BY n IS NULL, n, e.id");
  yield q("ORDER BY n IS NULL, n DESC where the output n is another column", "SELECT e.id, e.t AS n FROM nullish e ORDER BY n IS NULL, n DESC, e.id");
  yield q("ORDER BY n IS NULL, n where the output n is an unnamed CASE", "SELECT e.id, CASE WHEN e.id > 30 THEN 0 ELSE e.n END FROM nullish e ORDER BY n IS NULL, n, e.id");
  yield q("a subquery's unnamed CASE and cast of a CASE read by Postgres's names for them", "SELECT s.n, s.text, s.case FROM (SELECT e.id, CASE WHEN e.id > 30 THEN 0 ELSE e.n END, (CASE WHEN e.id > 4 THEN 1 END)::text, CASE WHEN e.id > 4 THEN e.n ELSE 0 END FROM nullish e) s ORDER BY s.id");
  yield q("ORDER BY n IS NULL, n DESC where the output n is the column itself", "SELECT id, n FROM nullish ORDER BY n IS NULL, n DESC, id LIMIT 20");
  yield q("ORDER BY n IS NOT NULL, n where the output n is the qualified column", "SELECT e.id, e.n AS n FROM nullish e ORDER BY n IS NOT NULL, n, e.id");
  yield q("ORDER BY n IS NULL, n under SELECT *", "SELECT * FROM nullish ORDER BY n IS NULL, n DESC, id LIMIT 20");
  // an integer constant is an output position bare, a constant inside the test
  yield q("ORDER BY 2 IS NULL, 2 DESC", "SELECT e.id, e.n FROM nullish e ORDER BY 2 IS NULL, 2 DESC, 1");
  yield q("ORDER BY 2 IS NOT NULL, 2", "SELECT e.id, e.n FROM nullish e ORDER BY 2 IS NOT NULL, 2, 1");
  // ---- a count of distinct keys sent as a count (src/duck/distinct-key.ts: a primary key alone, counted, or the other
  // side of a join): an int key, a varchar key joined from a text column; and what keeps its DISTINCT, each of which a
  // count would answer otherwise or which a copy's transient duplicate could: a UNIQUE column that is not the key
  // (counted, and on a join's other side), a citext UNIQUE, a partial unique index, a composite UNIQUE's column, a
  // composite primary key's column named `id`, a join on a non-key -----------------------------------------------------
  yield q("count(DISTINCT) of a primary key, of a UNIQUE column with NULLs that is not the key", "SELECT count(DISTINCT id), count(DISTINCT code), count(code), count(tag), count(*) FROM keyed");
  yield q("count(DISTINCT) of a partial unique index's column, of a composite UNIQUE's", "SELECT count(DISTINCT part), count(part), count(DISTINCT a), count(DISTINCT b) FROM keyed");
  yield q("count(DISTINCT id) of a composite primary key's id", "SELECT count(DISTINCT p.id), count(p.id), count(DISTINCT p.line) FROM pairs p");
  yield q("count(DISTINCT) over a LEFT JOIN on a UNIQUE text column that is not the key", "SELECT r.code, count(DISTINCT k.id) AS n, count(DISTINCT k.code) AS codes FROM keyed k LEFT JOIN keyed r ON r.code = k.ref GROUP BY 1 ORDER BY 1 NULLS FIRST");
  // (a citext grouped, or counted DISTINCT, is citext-forms's refusal: counted ungrouped here)
  yield q("count(DISTINCT) over a JOIN on a citext UNIQUE that is not the key", "SELECT count(DISTINCT k.id), count(k.id) FROM keyed k JOIN keyed r ON r.tag = k.tag_ref");
  yield q("count(DISTINCT) over a FULL JOIN on a UNIQUE text column that is not the key", "SELECT count(DISTINCT k.id), count(DISTINCT r.id), count(*) FROM keyed k FULL JOIN keyed r ON r.code = k.ref");
  yield q("count(DISTINCT) of a varchar primary key, and over a LEFT JOIN on it from a text column", "SELECT v.label, count(DISTINCT k.id) AS n, count(DISTINCT v.id) AS keys FROM keyed k LEFT JOIN vkeys v ON v.id = k.ref GROUP BY 1 ORDER BY 1 NULLS FIRST");
  yield q("count(DISTINCT) of a varchar primary key alone", "SELECT count(DISTINCT v.id), count(v.id) FROM vkeys v");
  yield q("count(DISTINCT id) over a join to a composite key's table (repeated)", "SELECT count(DISTINCT k.id), count(k.id) FROM keyed k JOIN pairs p ON p.id = k.id");
  yield q("count(DISTINCT id) over a join on a partial unique index's column (repeated)", "SELECT count(DISTINCT k.id), count(k.id) FROM keyed k JOIN keyed r ON r.part = k.part");
  yield q("count(DISTINCT id) of a composite key's table joined on the other's key", "SELECT k.code, count(DISTINCT p.id), count(DISTINCT p.line) FROM pairs p LEFT JOIN keyed k ON k.id = p.id GROUP BY 1 ORDER BY 1 NULLS FIRST");
  yield q("window frames", "SELECT id, sum(i4) OVER (ORDER BY id RANGE BETWEEN 2 PRECEDING AND CURRENT ROW), count(*) OVER (ORDER BY ts RANGE BETWEEN interval '1 day' PRECEDING AND interval '1 day' FOLLOWING), sum(i4) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND 2 FOLLOWING), max(i4) OVER (ORDER BY id GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW), sum(i4) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING EXCLUDE CURRENT ROW), sum(i4) OVER (ORDER BY id RANGE UNBOUNDED PRECEDING) FROM typed WHERE id < 100 ORDER BY id");
}

export const TYPE_MATRIX: Matrixed[] = [...matrix(), ...mappedTypes(), ...FROM_ITEMS_SORTED.map((f) => q(f.name, f.sql, f.zone))];
