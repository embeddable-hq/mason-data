/**
 * THE DUCKDB PROTOTYPE ON THE WIRE (docs/DESIGN.md): the Postgres listener with `PgApiOptions.duck` over a
 * real DuckDB file, driven by `pg` (node-postgres) as a tool drives it — the simple protocol, the extended protocol with
 * parameters, the catalog Postgres for what reads no table, and DuckDB's errors as Postgres's. Offline: the tables are
 * made in DuckDB by hand (the copy, which needs a source and the postgres extension, is not run here), and the names
 * and types a statement answers with are held to what POSTGRES answers for the same SQL (PGlite).
 */
import { test, after, before } from "node:test";
import { CollationResolver } from "../src/duck/collation.ts";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import * as util from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckStore, DEFAULT_MEMORY_LIMIT, defaultMemoryLimit, machineMemoryBytes, MEMORY_FLOOR_BYTES, memoryLimitBytes, MIN_SHARE_BYTES, OUTSIDE_RESERVE_BYTES, pgErrorOf } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { StatementError } from "../src/duck/statement.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
// (as a namespace: a tree before latest has no LATEST_SQL, and this file still loads there, for scripts/fails-without.ts)
import * as catalogModule from "../src/api/postgres/catalog.ts";
const LATEST_SQL: readonly string[] = (catalogModule as { LATEST_SQL?: readonly string[] }).LATEST_SQL ?? [];
import { wireColumn } from "../src/duck/types.ts";
import { TABLES_SQL } from "../src/cli/preflight.ts";
import { jsonbText } from "../src/duck/jsonb.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { CopyState } from "../src/duck/sync.ts";
import type { ApiLogRow } from "../src/api/request-log.ts";
import type { BackendMessage } from "../src/api/postgres/protocol.ts";
import * as wire from "./postgres-api/wire.ts";
import { withinDuckDBRounding } from "./memory-text.ts";
import { handLibcOrder, lettersOf } from "./libc-order-fixture.ts";
import { libcKey } from "../src/duck/libc-order.ts";
import { catalogDdl } from "../src/api/postgres/catalog.ts";
import { planDuck } from "../src/duck/plan.ts";
import { parseSql } from "../src/api/postgres/parser.ts";
import { mayOrderText } from "../src/api/postgres/translate.ts";
import { DEEP_DEPTHS, deepChains, deepShapes, numericShapes, planTimeBound } from "./deep-chains.ts";

const API_KEY = "k".repeat(48);

/**
 * json documents of every shape a `->>` meets (the native read, src/duck/rewrite.ts jsonGet), each row's as a jsonb (the
 * copy holds Postgres's canonical text: jsonbText) and as a json (the document's own text, a key twice included)
 */
const JDOCS: Array<[number, string | null, string | null]> = [
  [1, String.raw`{"a": "x", "n": 7.00, "o": {"b": "y", "0": "z"}, "e": "", "s": "q\"\\\n\u00e9\ud83d\ude00/", "z": null, "arr": ["p", "q"], "*": "star", "": "empty", "a.b": "dot", "a/b": "slash", "a~b": "tilde", "$": "dollar"}`, String.raw`{"a":"first","a":"last","o":{"k":"1","k":"2"},"e":1}`],
  [2, '{"a": "x"}', '{"a": "one", "o": {"k": "v"}, "e": "ee"}'],
  [3, null, null],
  [4, '["x", 5]', '"s"'],
  [5, '{"a": 1, "t": true, "f": false, "big": 123456789012345678901234567890, "e": 1e2, "o": [{"b": "inner"}]}', '{"a": "five", "o": {"k": null}}'],
  // a `#>` element read as an index of an array, or as a key of an object (`+1`, ` 1` and `01` are indexes, `1 ` a key)
  [6, '["x", "y", "z"]', '["x", "y", "z"]'],
  [7, '{"1": "one", "1 ": "trailing", " 1": "leading", "+1": "plus", "01": "zero-one"}', '{"1": "one", "1 ": "trailing", " 1": "leading", "+1": "plus", "01": "zero-one"}'],
];
/** jq's documents: a key `k` of every jsonb kind, three of them equal numbers spelled apart (1, 1.0, 1.00), a string
 *  twice and once in another case, a JSON null, an empty object, and a NULL row (the class "an output not resolved to
 *  its column": a DISTINCT ON or ORDER BY key named by an alias of `v -> 'k'` is jsonb's equality and order) */
const JQ: Array<[number, string | null]> = [[1, '{"k": 1}'], [2, '{"k": "a"}'], [3, '{"k": 1.0}'], [4, '{"k": [1]}'], [5, '{"k": null}'],
  [6, '{"k": "a"}'], [7, '{"k": {"a": 1}}'], [8, '{"k": {}}'], [9, '{"k": true}'], [10, '{"k": "A"}'], [11, '{"k": 2}'], [12, null],
  [13, '{"k": 1.00}'], [14, '{"k": "b"}']];
const jqInsert = (asHeld: (doc: string) => string): string => `INSERT INTO public.jq VALUES ${JQ.map(([id, v]) => `(${id}, ${v === null ? "NULL" : `'${asHeld(v)}'`})`).join(", ")}`;
/** documents a native `->` and `@>` meet (src/duck/rewrite.ts jsonValueRead, nativeContains), each held as a jsonb (the
 *  copy's canonical text) and as a json: every root kind, numbers DuckDB types as integers and as DOUBLE (a point, an
 *  exponent, past uint64, past a double's range), every scalar kind, nested objects, a key twice (json keeps both),
 *  strings DuckDB writes as Postgres does and one it does not (`\u001f`), and keys a path must escape */
const JNAT: Array<[number, string | null]> = [
  [1, null], [2, "{}"], [3, "[]"], [4, '"s"'], [5, "5"], [6, "true"], [7, "null"], [8, '[{"a": 1}]'],
  [9, '{"a": 1}'], [10, '{"a": 1.0}'], [11, '{"a": 1.50}'], [12, '{"a": 1e2}'], [13, '{"a": 100000000000000000000}'], [14, '{"a": 1.0000000000000000001}'],
  [15, '{"a": 9223372036854775807}'], [16, '{"a": -9223372036854775809}'], [17, '{"a": 18446744073709551616}'], [18, '{"a": "1"}'], [19, '{"a": ""}'],
  [20, '{"a": null}'], [21, '{"a": true}'], [22, '{"a": false}'], [23, '{"a": [1]}'], [24, '{"a": {}}'], [25, '{"a": {"b": 1}}'], [26, '{"a": {"b": {"c": "x"}, "d": 2}}'],
  [27, '{"a": 1, "b": 1}'], [28, '{"a": 1, "a": 2}'], [29, '{"a": "é"}'], [30, String.raw`{"a": "x\ny"}`], [31, String.raw`{"a": "\u0001"}`], [32, String.raw`{"a": "\u001f"}`],
  [33, String.raw`{"a": "q\"uote"}`], [34, String.raw`{"a": "back\\slash"}`], [35, String.raw`{"a": "a/b", "s": "\b\f\r\t` + "\u007f" + String.raw`😀"}`],
  [36, String.raw`{"é": 1, "a\"b": 2, "a/b": 3, "a~b": 4, "": 5, "1": 6, "*": 7, "a.b": 8}`],
  [37, String.raw`{"i": 7, "a": -5, "n": 2.50, "o": {"b": "deep"}, "arr": [1], "s": "x", "z": null, "t": true, "c": "\u0001"}`],
  [38, String.raw`{"a": "\\u00e9"}`], [39, `{"a": 1${"0".repeat(400)}}`], [40, '{"a": -0, "b": 0.1}'],
];
const jnatInsert = (asHeld: (doc: string) => string): string => `INSERT INTO public.jnat VALUES ${JNAT.map(([id, d]) => `(${id}, ${d === null ? "NULL, NULL" : `'${asHeld(d)}', '${d}'`})`).join(", ")}`;
const jdocsInsert = (asHeld: (doc: string) => string): string => `INSERT INTO public.jdocs VALUES ${JDOCS.map(([id, b, j]) => `(${id}, ${b === null ? "NULL" : `'${asHeld(b)}'`}, ${j === null ? "NULL" : `'${j}'`})`).join(", ")}`;
/** instants a truncation meets at its edges: each side of a daylight-saving change (Europe/Berlin's 2026-03-29 02:00
 *  and 2026-10-25 03:00, America/New_York's), a repeated hour's two halves, before 1970, a zone's local mean time
 *  (1880), a week's and a century's first instant, a microsecond, ±infinity and NULL (as UTC text: both sides read it so) */
const INSTANTS: Array<[number, string | null]> = [
  [1, "2026-03-29 00:59:59.999999+00"], [2, "2026-03-29 01:00:00+00"], [3, "2026-03-29 01:30:00+00"], [4, "2026-10-25 00:30:00+00"],
  [5, "2026-10-25 01:00:00+00"], [6, "2026-10-25 01:30:00+00"], [7, "2026-10-25 02:00:00+00"], [8, "2026-03-08 06:59:59+00"],
  [9, "2026-03-08 07:00:00+00"], [10, "2026-11-01 05:30:00+00"], [11, "2026-11-01 06:30:00+00"], [12, "1969-12-31 23:59:59.5+00"],
  [13, "1960-02-29 12:34:56.789+00"], [14, "1880-06-15 12:00:30+00"], [15, "2000-12-31 23:00:00+00"], [16, "2001-01-01 00:00:00+00"],
  [17, "2026-01-04 23:59:59+00"], [18, "2026-01-05 00:00:00+00"], [19, "2026-07-01 12:34:56.123456+00"], [20, "infinity"], [21, "-infinity"], [22, null],
  [23, "1999-12-31 23:59:59.999999+00"], [24, "2262-04-11 23:47:16+00"],
];
/** times of day on each side of New York's clock changes (02:00 local): midnight, the repeated hour's, the skipped
 *  hour's, the afternoon's, the last minute and the end of the day, 24:00 (issue 162) */
const CLOCK_TIMES = "INSERT INTO public.clock_times VALUES (1, '00:00:00'), (2, '01:30:00'), (3, '02:30:00'), (4, '12:30:00.5'), (5, '23:59:00'), (6, '24:00:00')";
const instantsInsert = `INSERT INTO public.instants VALUES ${INSTANTS.map(([id, v]) => `(${id}, ${v === null ? "NULL" : `'${v}'`})`).join(", ")}`;
/** a nullable column of each kind a sort meets, NULLs among the values and ties beside them */
const NULLISH = "INSERT INTO public.nullish VALUES (1, '2026-01-02 03:04:05', 'b', 3), (2, NULL, NULL, NULL), (3, '2025-12-31 00:00:00', 'a', 1), (4, '2026-01-02 03:04:05', NULL, 3), " +
  "(5, NULL, 'c', 2), (6, '2027-06-01 00:00:00', 'b', NULL), (7, '2024-02-29 12:00:00', 'B', 7), (8, NULL, NULL, 1)";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-wire-"));
let store: DuckStore;
let api: PgApiServer;
/** the listener's clock when a test fixes it (`clock` of startPostgresApi): the transaction's start every plan reads,
 *  in microseconds since the epoch (src/lib/instant.ts) */
let fixedNow: number | undefined;
/** a microsecond wall clock of the test's own, beside the listener's (src/lib/instant.ts is not imported, so the file
 *  loads with src/ as it was before it: scripts/fails-without.ts) */
const microsNow = (): number => Math.floor((performance.timeOrigin + performance.now()) * 1000);
const truth = new PGlite({ extensions: { citext } });

// one table in public, one in a schema of its own, as the copy lands them (<schema>.<table>, the key as the source's)
const DDL = [
  "CREATE SCHEMA IF NOT EXISTS sales",
  "CREATE TABLE public.orders (id BIGINT PRIMARY KEY, status VARCHAR, amount DECIMAL(12,2), qty INTEGER, created_at TIMESTAMPTZ, tags VARCHAR[], meta JSON)",
  "INSERT INTO public.orders VALUES (1, 'paid', 120.00, 2, '2026-01-02 03:04:05+00', ['a','b c'], '{\"k\": 1}'), (2, 'paid', 80.50, 1, '2026-06-30 23:30:00+00', NULL, NULL), (3, 'pending', 42.00, 5, '2026-07-01 00:30:00.5+00', [], '[]')",
  "CREATE TABLE sales.invoices (id INTEGER PRIMARY KEY, total DECIMAL(10,3))",
  "INSERT INTO sales.invoices VALUES (1, 1.5), (2, NULL)",
  // a citext and an inet, as the copy holds them: text, the inet with its mask
  "CREATE TABLE public.accounts (id INTEGER PRIMARY KEY, status VARCHAR, ip VARCHAR, team VARCHAR)",
  "INSERT INTO public.accounts VALUES (1, 'finalized', '10.3.6.45/32', ''), (2, 'FINALIZED', '10.0.0.0/8', ' alpha'), (3, 'Finalized', '::1/128', '10'), (4, 'draft', NULL, 'Beta')",
  // the corpus rerun: text Postgres's input functions read, names in two cases, a large answer
  "CREATE TABLE public.texts (id INTEGER PRIMARY KEY, s VARCHAR)",
  "INSERT INTO public.texts VALUES (1, '01/02/2026'), (2, 'January 3, 2026'), (3, ' yes '), (4, '1_000'), (5, 'P1DT2H'), (6, 'NaN'), (7, '12.5')",
  "CREATE TABLE public.ua (id INTEGER PRIMARY KEY, \"givenName\" VARCHAR, email VARCHAR)",
  "INSERT INTO public.ua VALUES (1, 'ann', 'a@x'), (2, 'bob', 'b@x'), (3, 'Ann', NULL)",
  "CREATE TABLE public.ga (id INTEGER PRIMARY KEY, \"Email\" VARCHAR, name VARCHAR)",
  "INSERT INTO public.ga VALUES (1, 'A@X', 'a'), (2, 'B@X', 'A'), (3, NULL, 'b')",
  "CREATE TABLE public.big AS SELECT range::INTEGER AS id, 'v' || range AS v FROM range(150000)",
  // the rerun over BIRD and TPC-DS: quotients alike in Postgres, a NULL date, a team's name
  // quotients equal to a double's 17 digits that Postgres tells apart (PR 207's class round)
  "CREATE TABLE public.bigdec (id INTEGER PRIMARY KEY, x DECIMAL(30,20), y DECIMAL(30,20))",
  "INSERT INTO public.bigdec VALUES (1, 1.00000000000000000001, 1), (2, 1.00000000000000000002, 1), (3, 2.5, 2), (4, 5, 2), (5, 2.5, 1)",
  // issue 214: an unconstrained numeric and a numeric(65,30), held as the copy holds them, DECIMAL(38, the scale their
  // values use) (src/duck/sync.ts "A NUMERIC THE EXTENSION WOULD READ AS A DOUBLE"), a w of 30 integer digits
  "CREATE TABLE public.pnum (id INTEGER PRIMARY KEY, u DECIMAL(38,4), w DECIMAL(38,2))",
  "INSERT INTO public.pnum VALUES (1, 1.2345, 19.99), (2, 7, 123456789012345678901234567890.25), (3, -0.5, 5), (4, NULL, NULL)",
  // issue 244's deep chains executed (#484): `deepShapes`' table, ten rows of NULLs, duplicates, ties, a padded char(4)
  "CREATE TABLE public.deep_t (id INTEGER PRIMARY KEY, a INTEGER, b VARCHAR, c DECIMAL(10,2), d VARCHAR)",
  "INSERT INTO public.deep_t VALUES (1, 5, 'x', 10.00, 'ab  '), (2, -3, 'y', 0.00, 'abcd'), (3, NULL, 'x', -7.25, 'a   '), (4, 7, NULL, 10.00, NULL), (5, 0, 'z', 99999999.99, 'zz  '), " +
    "(6, 2, 'y', NULL, 'b   '), (7, 9, 'x', 1.01, 'ab  '), (8, -1, 'w', 3.33, 'c   '), (9, 4, NULL, 2.50, 'd   '), (10, 1, 'v', -0.01, 'e   ')",
  "CREATE TABLE public.ratios (id INTEGER PRIMARY KEY, a DECIMAL(15,4), b DECIMAL(15,4), d DATE, team VARCHAR, n INTEGER)",
  "INSERT INTO public.ratios VALUES (1, 0.3, 0.1, '2026-01-02', '1st', 3), (2, 0.9, 0.3, NULL, '2nd', 5), (3, 0.7, 0.1, '2025-12-31', 'x', 10), (4, 2.1, 0.3, NULL, '3rd', 11)",
  // the BI-tools test: foreign keys to a unique index and to a UNIQUE constraint
  "CREATE TABLE public.uparent (id INTEGER PRIMARY KEY, code VARCHAR, ref VARCHAR)",
  "CREATE TABLE public.uchild (id INTEGER PRIMARY KEY, parent_code VARCHAR, parent_ref VARCHAR)",
  // the Metabase test: a JSON number and a text read as an unconstrained numeric, summed
  "CREATE TABLE public.jnums (id INTEGER PRIMARY KEY, j JSON, t VARCHAR, g INTEGER)",
  "INSERT INTO public.jnums VALUES (1, '{\"r\": 2.450}', '2.450', 0), (2, '{\"r\": 0.1}', '0.10000000000000000000', 1), (3, '{\"r\": -3}', '-3', 0), (4, '{\"r\": null}', NULL, 1), (5, '{\"r\": 1.25}', '7.125', 0), (6, '{}', '1_000', 1)",
  // the Metabase test: an enum, as the copy holds one (an ENUM of its labels, a list of them)
  "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
  "CREATE TABLE public.moods (id INTEGER PRIMARY KEY, m mood, ms mood[])",
  "INSERT INTO public.moods VALUES (1, 'happy', ['sad', 'ok']), (2, 'sad', NULL), (3, 'ok', []), (4, NULL, ['happy'])",
  // and a source's NOT NULL and defaults, which the copy does not hold (the catalog declares them)
  "CREATE TABLE public.serials (id INTEGER PRIMARY KEY, ib BIGINT, s VARCHAR, n INTEGER)",
  "INSERT INTO public.serials VALUES (1, 1, 'a', 5)",
  // a table's preview through a join (the Metabase test): row 2000's 'x' is no integer
  "CREATE TABLE public.late (id INTEGER PRIMARY KEY, j JSON, k INTEGER, c INTEGER)",
  "INSERT INTO public.late SELECT range::INTEGER, json_object('n', CASE WHEN range = 2000 THEN 'x' ELSE range::VARCHAR END), (2000 - range)::INTEGER, (range % 50)::INTEGER FROM range(1, 2001)",
  "CREATE TABLE public.late_c (id INTEGER PRIMARY KEY, name VARCHAR)",
  // a composite primary key, and a table the catalog declares no key of (keyFirst, and joins of no key)
  "CREATE TABLE public.late_p (c INTEGER, line INTEGER, note VARCHAR, PRIMARY KEY (c, line))",
  "INSERT INTO public.late_p SELECT (range % 50)::INTEGER, (range // 50)::INTEGER, 'n' || range FROM range(200)",
  "CREATE TABLE public.late_n (id INTEGER, c INTEGER)",
  "INSERT INTO public.late_n SELECT range::INTEGER, (range % 50)::INTEGER FROM range(50)",
  // a key the copy holds twice for a moment (a change applied in pieces): the catalog declares it the key, the copy holds row 1 twice
  "CREATE TABLE public.late_d (id INTEGER, w VARCHAR)",
  "INSERT INTO public.late_d VALUES (1, 'one'), (1, 'one'), (2, 'two'), (3, 'three')",
  // jsonb values Postgres equates whose text differs (a DISTINCT ON's jsonb key, PR 207)
  "CREATE TABLE public.jq_on (id INTEGER PRIMARY KEY, v JSON)",
  "INSERT INTO public.jq_on VALUES (1, '{\"k\": 1.0}'), (2, '{\"k\": 1.00}'), (3, '{\"k\": 1}'), (4, '{\"k\": [1, 2]}'), (5, '{\"k\": {\"b\": 1, \"a\": 2}}'), (6, '{\"k\": {\"a\": 2, \"b\": 1.0}}'), (7, NULL), (8, '{\"x\": 3}')",
  'CREATE TABLE public.rowid_cased (id INTEGER PRIMARY KEY, "RowId" INTEGER)',
  'INSERT INTO public.rowid_cased SELECT range::INTEGER, 5 FROM range(1, 7)',
  "INSERT INTO public.late_c SELECT range::INTEGER, 'c' || range FROM range(50)",
  // a char(5) as the copy holds it: Postgres's text of it, padded
  "CREATE TABLE public.chars (id INTEGER PRIMARY KEY, ch VARCHAR)",
  "INSERT INTO public.chars VALUES (1, 'a b  '), (2, 'c0   '), (3, 'c1   ')",
  "CREATE TABLE public.jq (id INTEGER PRIMARY KEY, v JSON)",
  jqInsert(jsonbText),
  "CREATE TABLE public.jdocs (id INTEGER PRIMARY KEY, b JSON, j JSON)",
  jdocsInsert(jsonbText),
  "CREATE TABLE public.jnat (id INTEGER PRIMARY KEY, b JSON, j JSON)",
  jnatInsert(jsonbText),
  // a jsonb column whose name is jdocs.b's in another case: a bare "B" beside b is ambiguous to DuckDB
  "CREATE TABLE public.jcase (id INTEGER PRIMARY KEY, \"B\" JSON)",
  "INSERT INTO public.jcase VALUES (1, '{\"a\": \"upper\"}')",
  "CREATE TABLE public.instants (id INTEGER PRIMARY KEY, \"at\" TIMESTAMPTZ)",
  instantsInsert,
  "CREATE TABLE public.clock_times (id INTEGER PRIMARY KEY, tm TIME)",
  CLOCK_TIMES,
  "CREATE TABLE public.nullish (id INTEGER PRIMARY KEY, ts TIMESTAMP, t VARCHAR, n INTEGER)",
  NULLISH,
  // session state (GitHub issue 63), last: no OID of the others moves
  "CREATE TABLE public.invoices (id INTEGER PRIMARY KEY, total DECIMAL(10,3))",
  "INSERT INTO public.invoices VALUES (7, 70.5)",
  "CREATE TABLE sales.accounts (id INTEGER PRIMARY KEY, owner VARCHAR)",
  "INSERT INTO sales.accounts VALUES (1, 'x')",
  // a synced timetz beside a time, as the copy holds them (issue 664)
  "CREATE TABLE public.timetz_runs (id INTEGER PRIMARY KEY, run_at TIMETZ, t_at TIME, n INTEGER)",
  "INSERT INTO public.timetz_runs SELECT g, TIMETZ '07:30:00+00', TIME '07:30:00', g FROM range(1, 401) r(g)",
  "INSERT INTO public.timetz_runs VALUES (401, '07:30:00.123+05:30', '07:30:00.123', 401), (402, '23:59:59.999999-04', '23:59:59.999999', 402), (403, '24:00:00+00', '24:00:00', 403), (404, NULL, NULL, 404)",
  "CREATE TABLE public.timetz_runs3 (id INTEGER PRIMARY KEY, run_at3 TIMETZ)",
  "INSERT INTO public.timetz_runs3 VALUES (1, '07:30:00.123+05:30'), (2, NULL)",
];
// the same rows in Postgres, typed as the source would type them
const PG_DDL = [
  "CREATE SCHEMA sales",
  "CREATE TABLE public.orders (id bigint PRIMARY KEY, status text, amount numeric(12,2), qty integer, created_at timestamptz, tags text[], meta jsonb)",
  "INSERT INTO public.orders VALUES (1, 'paid', 120.00, 2, '2026-01-02 03:04:05+00', '{a,\"b c\"}', '{\"k\": 1}'), (2, 'paid', 80.50, 1, '2026-06-30 23:30:00+00', NULL, NULL), (3, 'pending', 42.00, 5, '2026-07-01 00:30:00.5+00', '{}', '[]')",
  "CREATE TABLE sales.invoices (id integer PRIMARY KEY, total numeric(10,3))",
  "INSERT INTO sales.invoices VALUES (1, 1.5), (2, NULL)",
  "CREATE EXTENSION citext",
  "CREATE TABLE public.accounts (id integer PRIMARY KEY, status citext, ip inet, team text)",
  "INSERT INTO public.accounts VALUES (1, 'finalized', '10.3.6.45', ''), (2, 'FINALIZED', '10.0.0.0/8', ' alpha'), (3, 'Finalized', '::1', '10'), (4, 'draft', NULL, 'Beta')",
  "CREATE TABLE public.texts (id integer PRIMARY KEY, s text)",
  "INSERT INTO public.texts VALUES (1, '01/02/2026'), (2, 'January 3, 2026'), (3, ' yes '), (4, '1_000'), (5, 'P1DT2H'), (6, 'NaN'), (7, '12.5')",
  "CREATE TABLE public.ua (id integer PRIMARY KEY, \"givenName\" text, email text)",
  "INSERT INTO public.ua VALUES (1, 'ann', 'a@x'), (2, 'bob', 'b@x'), (3, 'Ann', NULL)",
  "CREATE TABLE public.ga (id integer PRIMARY KEY, \"Email\" text, name text)",
  "INSERT INTO public.ga VALUES (1, 'A@X', 'a'), (2, 'B@X', 'A'), (3, NULL, 'b')",
  "CREATE TABLE public.big AS SELECT g AS id, 'v' || g AS v FROM generate_series(0, 149999) g",
  "CREATE TABLE public.bigdec (id integer PRIMARY KEY, x numeric(30,20), y numeric(30,20))",
  "INSERT INTO public.bigdec VALUES (1, 1.00000000000000000001, 1), (2, 1.00000000000000000002, 1), (3, 2.5, 2), (4, 5, 2), (5, 2.5, 1)",
  "CREATE TABLE public.pnum (id integer PRIMARY KEY, u numeric, w numeric(65,30))",
  "INSERT INTO public.pnum VALUES (1, 1.2345, 19.99), (2, 7, 123456789012345678901234567890.25), (3, -0.5, 5), (4, NULL, NULL)",
  "CREATE TABLE public.deep_t (id integer PRIMARY KEY, a integer, b text, c numeric(10,2), d char(4))",
  "INSERT INTO public.deep_t VALUES (1, 5, 'x', 10.00, 'ab'), (2, -3, 'y', 0.00, 'abcd'), (3, NULL, 'x', -7.25, 'a'), (4, 7, NULL, 10.00, NULL), (5, 0, 'z', 99999999.99, 'zz'), " +
    "(6, 2, 'y', NULL, 'b'), (7, 9, 'x', 1.01, 'ab'), (8, -1, 'w', 3.33, 'c'), (9, 4, NULL, 2.50, 'd'), (10, 1, 'v', -0.01, 'e')",
  "CREATE TABLE public.ratios (id integer PRIMARY KEY, a numeric(15,4), b numeric(15,4), d date, team text, n integer)",
  "INSERT INTO public.ratios VALUES (1, 0.3, 0.1, '2026-01-02', '1st', 3), (2, 0.9, 0.3, NULL, '2nd', 5), (3, 0.7, 0.1, '2025-12-31', 'x', 10), (4, 2.1, 0.3, NULL, '3rd', 11)",
  "CREATE TABLE public.uparent (id integer PRIMARY KEY, code text, ref text UNIQUE)",
  "CREATE UNIQUE INDEX uparent_code ON public.uparent (code)",
  // neither backs a foreign key, so neither is read: an expression's and a partial unique index
  "CREATE UNIQUE INDEX uparent_lower ON public.uparent (lower(code))",
  "CREATE UNIQUE INDEX uparent_some ON public.uparent (id) WHERE code IS NOT NULL",
  "CREATE TABLE public.uchild (id integer PRIMARY KEY, parent_code text REFERENCES public.uparent (code), parent_ref text REFERENCES public.uparent (ref))",
  "CREATE TABLE public.jnums (id integer PRIMARY KEY, j jsonb, t text, g integer)",
  "INSERT INTO public.jnums VALUES (1, '{\"r\": 2.450}', '2.450', 0), (2, '{\"r\": 0.1}', '0.10000000000000000000', 1), (3, '{\"r\": -3}', '-3', 0), (4, '{\"r\": null}', NULL, 1), (5, '{\"r\": 1.25}', '7.125', 0), (6, '{}', '1_000', 1)",
  "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
  "CREATE TABLE public.moods (id integer PRIMARY KEY, m mood, ms mood[])",
  "INSERT INTO public.moods VALUES (1, 'happy', '{sad,ok}'), (2, 'sad', NULL), (3, 'ok', '{}'), (4, NULL, '{happy}')",
  "CREATE TABLE public.serials (id serial PRIMARY KEY, ib bigint GENERATED BY DEFAULT AS IDENTITY, s text NOT NULL DEFAULT 'draft', n integer)",
  "INSERT INTO public.serials (s, n) VALUES ('a', 5)",
  "CREATE TABLE public.late (id integer PRIMARY KEY, j jsonb, k integer, c integer)",
  "INSERT INTO public.late SELECT g, jsonb_build_object('n', CASE WHEN g = 2000 THEN 'x' ELSE g::text END), 2000 - g, g % 50 FROM generate_series(1, 2000) g",
  "CREATE TABLE public.late_c (id integer PRIMARY KEY, name text)",
  "CREATE TABLE public.jq_on (id integer PRIMARY KEY, v jsonb)",
  "INSERT INTO public.jq_on VALUES (1, '{\"k\": 1.0}'), (2, '{\"k\": 1.00}'), (3, '{\"k\": 1}'), (4, '{\"k\": [1, 2]}'), (5, '{\"k\": {\"b\": 1, \"a\": 2}}'), (6, '{\"k\": {\"a\": 2, \"b\": 1.0}}'), (7, NULL), (8, '{\"x\": 3}')",
  'CREATE TABLE public.rowid_cased (id integer PRIMARY KEY, "RowId" integer)',
  'INSERT INTO public.rowid_cased SELECT g, 5 FROM generate_series(1, 6) g',
  "INSERT INTO public.late_c SELECT g, 'c' || g FROM generate_series(0, 49) g",
  "CREATE TABLE public.chars (id integer PRIMARY KEY, ch char(5))",
  "INSERT INTO public.chars VALUES (1, 'a b'), (2, 'c0'), (3, 'c1')",
  "CREATE TABLE public.late_p (c integer, line integer, note text, PRIMARY KEY (c, line))",
  "INSERT INTO public.late_p SELECT g % 50, g / 50, 'n' || g FROM generate_series(0, 199) g",
  "CREATE TABLE public.late_n (id integer, c integer)",
  "INSERT INTO public.late_n SELECT g, g % 50 FROM generate_series(0, 49) g",
  "CREATE TABLE public.jq (id integer PRIMARY KEY, v jsonb)",
  jqInsert((doc) => doc),
  "CREATE TABLE public.jdocs (id integer PRIMARY KEY, b jsonb, j json)",
  jdocsInsert((doc) => doc),
  "CREATE TABLE public.jnat (id integer PRIMARY KEY, b jsonb, j json)",
  jnatInsert((doc) => doc),
  "CREATE TABLE public.jcase (id integer PRIMARY KEY, \"B\" jsonb)",
  "INSERT INTO public.jcase VALUES (1, '{\"a\": \"upper\"}')",
  "CREATE TABLE public.instants (id integer PRIMARY KEY, at timestamptz)",
  instantsInsert,
  "CREATE TABLE public.clock_times (id integer PRIMARY KEY, tm time)",
  CLOCK_TIMES,
  "CREATE TABLE public.nullish (id integer PRIMARY KEY, ts timestamp, t text, n integer)",
  NULLISH,
  "ANALYZE public.late",
  // a source's views, as the catalog has them: over the copied tables, one over another
  "CREATE VIEW public.paid_orders AS SELECT id, amount FROM public.orders WHERE status = 'paid'",
  "CREATE VIEW public.big_paid (order_id, amount) AS SELECT id, amount FROM public.paid_orders WHERE amount > 100",
  // views over the late tables (src/duck/late.ts, FROM items): a join, a view of it, one table, one of it, grouped
  "CREATE VIEW public.late_joined AS SELECT l.id, l.j, l.k, c.name FROM public.late l LEFT JOIN public.late_c c ON c.id = l.c",
  "CREATE VIEW public.late_joined_again AS SELECT id, k, upper(name) AS shout FROM public.late_joined WHERE k > 10",
  "CREATE VIEW public.late_read AS SELECT id, name, 1 AS one, id * 2 AS twice FROM public.late_c WHERE id < 30",
  "CREATE VIEW public.late_read_again AS SELECT one, twice, id, name FROM public.late_read WHERE id > 2",
  "CREATE VIEW public.late_counts AS SELECT c, count(*) AS n FROM public.late GROUP BY c",
  // session state (GitHub issue 63), last: no OID of the others moves
  "CREATE TABLE public.invoices (id INTEGER PRIMARY KEY, total DECIMAL(10,3))",
  "INSERT INTO public.invoices VALUES (7, 70.5)",
  "CREATE TABLE sales.accounts (id INTEGER PRIMARY KEY, owner VARCHAR)",
  "INSERT INTO sales.accounts VALUES (1, 'x')",
];
const schema: PgSchema = {
  database: "app",
  tables: [
    { name: "orders", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int8" }, { name: "status", type: "text" }, { name: "amount", type: "numeric", spelled: "numeric(12,2)" }, { name: "qty", type: "int4" },
        { name: "created_at", type: "timestamptz" }, { name: "tags", type: "text", spelled: "text[]" }, { name: "meta", type: "jsonb" }] },
    { name: "invoices", schema: "sales", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "total", type: "numeric", spelled: "numeric(10,3)" }] },
    { name: "accounts", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "status", type: "text", spelled: "citext" }, { name: "ip", type: "text", spelled: "inet" }, { name: "team", type: "text" }] },
    { name: "texts", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "s", type: "text" }] },
    { name: "ua", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "givenName", type: "text" }, { name: "email", type: "text" }] },
    { name: "ga", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "Email", type: "text" }, { name: "name", type: "text" }] },
    { name: "big", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "v", type: "text" }] },
    { name: "bigdec", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "x", type: "numeric", spelled: "numeric(30,20)" }, { name: "y", type: "numeric", spelled: "numeric(30,20)" }] },
    { name: "pnum", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "u", type: "numeric", spelled: "numeric" }, { name: "w", type: "numeric", spelled: "numeric(65,30)" }] },
    { name: "deep_t", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "a", type: "int4" }, { name: "b", type: "text" }, { name: "c", type: "numeric", spelled: "numeric(10,2)" }, { name: "d", type: "text", spelled: "character(4)" }] },
    { name: "ratios", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "a", type: "numeric", spelled: "numeric(15,4)" }, { name: "b", type: "numeric", spelled: "numeric(15,4)" },
        { name: "d", type: "date" }, { name: "team", type: "text" }, { name: "n", type: "int4" }] },
    { name: "uparent", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "code", type: "text" }, { name: "ref", type: "text" }],
      uniqueKeys: [{ name: "uparent_code", columns: ["code"], constraint: false, nullsNotDistinct: false }, { name: "uparent_ref_key", columns: ["ref"], constraint: true, nullsNotDistinct: false }] },
    { name: "uchild", primaryKey: ["id"],
      columns: [{ name: "id", type: "int4" }, { name: "parent_code", type: "text" }, { name: "parent_ref", type: "text" }],
      joins: [{ name: "uparent", table: "public.uparent", on: ["parent_code", "code"], relationship: "many_to_one" },
        { name: "uparent", table: "public.uparent", on: ["parent_ref", "ref"], relationship: "many_to_one" }] },
    { name: "jnums", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "j", type: "jsonb" }, { name: "t", type: "text" }, { name: "g", type: "int4" }] },
    { name: "moods", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "m", type: "text", spelled: "mood", enumLabels: ["sad", "ok", "happy"] },
        { name: "ms", type: "text", spelled: "mood[]", enumLabels: ["sad", "ok", "happy"] }] },
    { name: "serials", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4", notNull: true, default: "nextval('serials_id_seq'::regclass)", sequence: "public.serials_id_seq" },
        { name: "ib", type: "int8", notNull: true, identity: "d", sequence: "public.serials_ib_seq" }, { name: "s", type: "text", notNull: true, default: "'draft'::text" }, { name: "n", type: "int4" }] },
    { name: "late", primaryKey: ["id"], joins: [],
      columns: [{ name: "id", type: "int4" }, { name: "j", type: "jsonb" }, { name: "k", type: "int4" }, { name: "c", type: "int4" }] },
    { name: "late_c", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "name", type: "text" }] },
    { name: "chars", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "ch", type: "text", spelled: "character(5)" }] },
    { name: "late_p", primaryKey: ["c", "line"], joins: [], columns: [{ name: "c", type: "int4" }, { name: "line", type: "int4" }, { name: "note", type: "text" }] },
    { name: "late_n", primaryKey: [], joins: [], columns: [{ name: "id", type: "int4" }, { name: "c", type: "int4" }] },
    { name: "late_d", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "w", type: "text" }] },
    { name: "jq", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "v", type: "jsonb" }] },
    { name: "jq_on", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "v", type: "jsonb" }] },
    { name: "rowid_cased", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "RowId", type: "int4" }] },
    { name: "jdocs", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "b", type: "jsonb" }, { name: "j", type: "jsonb", spelled: "json" }] },
    { name: "jcase", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "B", type: "jsonb" }] },
    { name: "jnat", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "b", type: "jsonb" }, { name: "j", type: "jsonb", spelled: "json" }] },
    { name: "instants", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "at", type: "timestamptz" }] },
    { name: "clock_times", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "tm", type: "timestamptz", spelled: "time" }] },
    { name: "nullish", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "ts", type: "timestamptz", spelled: "timestamp" }, { name: "t", type: "text" }, { name: "n", type: "int4" }] },
    // session state (GitHub issue 63), last: a name in two schemas, of one shape (invoices) and of two (accounts)
    { name: "invoices", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "total", type: "numeric", spelled: "numeric(10,3)" }] },
    { name: "accounts", schema: "sales", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "owner", type: "text" }] },
    // issue 664, after the others: each column as the source spells it (src/duck/sync.ts pgColumn), timetz(3) its typmod
    { name: "timetz_runs", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "run_at", type: "text", spelled: "time with time zone" },
      { name: "t_at", type: "text", spelled: "time without time zone" }, { name: "n", type: "int4" }] },
    { name: "timetz_runs3", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "run_at3", type: "text", spelled: "time(3) with time zone" }] },
  ],
  // as the source prints them under a search_path of pg_catalog alone (src/cli/preflight.ts VIEWS_SQL); `lost` reads a
  // table Mason has not copied, so the catalog leaves it out
  views: [{ schema: "public", name: "paid_orders", definition: " SELECT id, amount FROM public.orders WHERE (status = 'paid'::text);" },
    { schema: "public", name: "big_paid", definition: " SELECT id AS order_id, amount FROM public.paid_orders WHERE (amount > (100)::numeric);" },
    { schema: "public", name: "late_joined", definition: " SELECT l.id, l.j, l.k, c.name FROM public.late l LEFT JOIN public.late_c c ON c.id = l.c;" },
    { schema: "public", name: "late_joined_again", definition: " SELECT id, k, upper(name) AS shout FROM public.late_joined WHERE (k > 10);" },
    { schema: "public", name: "late_read", definition: " SELECT id, name, 1 AS one, (id * 2) AS twice FROM public.late_c WHERE (id < 30);" },
    { schema: "public", name: "late_read_again", definition: " SELECT one, twice, id, name FROM public.late_read WHERE (id > 2);" },
    { schema: "public", name: "late_counts", definition: " SELECT c, count(*) AS n FROM public.late GROUP BY c;" },
    { schema: "public", name: "lost", definition: " SELECT 1 AS one FROM public.nowhere;" }],
};
/** the sync's copy state the listener reads for a table the catalog does not hold (`Sync.state` in a run) */
let copies: CopyState[] = [];
const logged: string[] = [];
/** the request log's rows as the listener built them (src/api/request-log.ts ApiLogRow) */
const recorded: ApiLogRow[] = [];
/** every line, never cleared (a test that reads a line said once, at the catalog's start, cannot know when that was) */
const everLogged: string[] = [];

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => (logged.push(l), everLogged.push(l)));
  for (const s of DDL) await store.writer.run(s);
  // a session starts in UTC on this API, as on a server whose TimeZone is UTC
  await truth.exec("SET TimeZone = 'UTC'");
  for (const s of PG_DDL) await truth.exec(s);
  // latest(x ORDER BY …), Mason's aggregate, declared on the truth from the catalog's own definition
  for (const s of LATEST_SQL) await truth.exec(s);
  // the "source's" OID for citext is the truth's: what the copy records (SourceColumnInfo.typeOid) and the wire sends
  const citextOid = Number((await truth.query<{ oid: number }>("SELECT oid FROM pg_type WHERE typname = 'citext'")).rows[0]!.oid);
  schema.tables[2]!.columns[1]!.typeOid = citextOid;
  // and the enum's, as for any type the source made
  const mood = (await truth.query<{ oid: number; typarray: number }>("SELECT oid, typarray FROM pg_type WHERE typname = 'mood'")).rows[0]!;
  // as the copy records them: the column's own type (an array column's is the array type, with no array of its own)
  const [, m, ms] = schema.tables.find((t) => t.name === "moods")!.columns;
  Object.assign(m!, { typeOid: Number(mood.oid), typeArrayOid: Number(mood.typarray) });
  Object.assign(ms!, { typeOid: Number(mood.typarray) });
  api = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "0.6.1", product: "mason-data",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema,
    record: (r) => { recorded.push(r); }, log: (l) => (logged.push(l), everLogged.push(l)),
    duck: await store.listener(undefined, undefined, undefined, () => copies),
    clock: () => fixedNow ?? microsNow(),
  });
});
after(async () => {
  await api.close();
  await store.close();
  await truth.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const client = async (password = mintToken(API_KEY, 600).token): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password });
  await c.connect();
  return c;
};

/** the result's column names and type OIDs, and its rows as text (`pg`'s parsers off: the wire's own text) */
const raw = { getTypeParser: () => (v: string) => v };
async function answer(c: pg.Client, text: string, values?: unknown[]): Promise<{ fields: Array<[string, number]>; rows: unknown[][] }> {
  const r = await c.query({ text, values, rowMode: "array", types: raw } as pg.QueryConfig);
  return { fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows as unknown[][] };
}
async function postgres(text: string, values?: unknown[]): Promise<{ fields: Array<[string, number]>; rows: unknown[][] }> {
  const r = await truth.query<unknown[]>(text, values, { rowMode: "array", parsers: Object.fromEntries([16, 20, 21, 23, 25, 114, 700, 701, 1009, 1014, 1015, 1022, 1082, 1114, 1184, 1186, 1700, 3802].map((o) => [o, (v: string) => v])) });
  return { fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows };
}

test("a statement over a copied table is answered by DuckDB with Postgres's column names, types and text", async () => {
  const c = await client();
  try {
    for (const sql of [
      "SELECT status, count(*), sum(amount), max(qty) FROM orders GROUP BY status ORDER BY status",
      "SELECT id, amount, created_at, tags, meta FROM orders ORDER BY id",
      "SELECT o.id AS order_id, i.total FROM orders o LEFT JOIN sales.invoices i ON i.id = o.id ORDER BY 1",
      "SELECT *, amount * 2 AS twice FROM sales.invoices JOIN orders USING (id) ORDER BY id",
      "WITH paid AS (SELECT * FROM orders WHERE status = 'paid') SELECT count(*) AS n, min(created_at) FROM paid",
      "SELECT CASE WHEN qty > 1 THEN 'many' ELSE 'one' END, coalesce(meta::text, '-'), qty::text FROM orders ORDER BY id",
      // an integer divided by an integer is an integer, truncated toward zero (DuckDB's default is a DOUBLE: 5 / 2 = 2.5)
      "SELECT id, qty / 2 AS half, -qty / 2 AS neg, qty % 2 AS rest FROM orders ORDER BY id",
    ]) {
      const [got, want] = [await answer(c, sql), await postgres(sql)];
      assert.deepEqual(got.rows, want.rows, sql);
      assert.deepEqual(got.fields.map((f) => f[0]), want.fields.map((f) => f[0]), `names: ${sql}`);
    }
  } finally { await c.end(); }
});

test("a result column is Postgres's type: a sum of an integer is DuckDB's HUGEINT, sent as Postgres's bigint", async () => {
  const c = await client();
  try {
    for (const sql of ["SELECT sum(qty) FROM orders", "SELECT length(status), extract(year from created_at), qty / 2 AS half FROM orders ORDER BY id"]) {
      const [got, want] = [await answer(c, sql), await postgres(sql)];
      assert.deepEqual(got, want, sql);
    }
  } finally { await c.end(); }
});

test("the extended protocol: each parameter is the value Postgres's input function reads for the type Postgres inferred", async () => {
  const c = await client();
  try {
    const got = await answer(c, "SELECT id, status FROM orders WHERE id > $1 AND status = $2 ORDER BY id", [1, "paid"]);
    assert.deepEqual(got.rows, [["2", "paid"]]);
    assert.deepEqual(got.fields, [["id", 20], ["status", 25]]);
    const none = await answer(c, "SELECT count(*) FROM orders WHERE created_at >= $1", ["2026-07-01T00:00:00Z"]);
    assert.deepEqual(none.rows, [["1"]]);
    // a numeric parameter in a numeric Postgres computes exactly: its bound text, at Postgres's scale (bound as a
    // double, it was DuckDB's `300` for Postgres's `300.0000`; a review finding)
    for (const [sql, values] of [["SELECT amount * $1 AS x, $1::numeric / 3 AS third, amount + $2 AS y FROM orders ORDER BY id", ["2.50", "0.1"]],
      ["SELECT round(sum(amount) * $1, 3) AS r FROM orders", ["1.0005"]]] as const) {
      const want = await postgres(sql, [...values]);
      assert.deepEqual(await answer(c, sql, [...values]), want, sql);
    }
    // a value is what Postgres's input function reads for the type it inferred: '1.5' is no integer (22P02), and a
    // date, a timestamp or an interval in any form Postgres reads is that value (DuckDB reads ISO alone)
    await assert.rejects(c.query({ text: "SELECT id FROM orders WHERE qty = $1", values: ["1.5"] }),
      (e: pg.DatabaseError) => e.code === "22P02" && e.message === 'invalid input syntax for type integer: "1.5"');
    for (const [sql, values] of [["SELECT id FROM orders WHERE created_at > $1 ORDER BY id", ["March 1, 2026 12:00"]],
      ["SELECT id, created_at + $1::interval AS later FROM orders ORDER BY id", ["P1DT2H"]],
      ["SELECT id FROM orders WHERE created_at::date < $1 ORDER BY id", ["07/02/2026"]]] as const) {
      assert.deepEqual(await answer(c, sql, [...values]), await postgres(sql, [...values]), sql);
    }
    // the session survives the refusal
    assert.deepEqual((await answer(c, "SELECT count(*) FROM orders")).rows, [["3"]]);
  } finally { await c.end(); }
});

// A PARAMETER IN THE ARGUMENT THE TURN REPEATS (src/duck/rewrite.ts `giveTurns`) is typed by the column beside it, in
// both places, and a statement prepared before a SET still runs after it
test("a prepared statement whose Mason call reads a column beside a parameter runs, and runs again after a SET", async () => {
  const c = await client();
  try {
    for (const [name, text] of [
      ["turn_concat", "SELECT id, initcap(s || $1) AS v FROM texts ORDER BY id"],
      ["turn_case", "SELECT id, initcap(CASE WHEN id = 1 THEN s ELSE $1 END) AS v FROM texts ORDER BY id"],
      ["turn_compare", "SELECT id, to_char(id + $1::int, '999') AS v FROM texts ORDER BY id"],
    ] as const) {
      const value = name === "turn_compare" ? "2" : "x y";
      const first = await c.query({ name, text, values: [value] });
      assert.deepEqual(first.rows, (await truth.query(text, [value])).rows, name);
      await c.query("SET TimeZone = 'Europe/Rome'");
      assert.deepEqual((await c.query({ name, text, values: [value] })).rows, first.rows, `${name}, after a SET`);
      await c.query("SET TimeZone = 'UTC'");
    }
  } finally { await c.end(); }
});

test("a timestamptz is written in the session's zone, and DuckDB computes in it (SET TimeZone reaches DuckDB)", async () => {
  const c = await client();
  try {
    await c.query("SET TimeZone = 'Europe/London'");
    const sql = "SELECT created_at, date_trunc('day', created_at) AS day FROM orders ORDER BY id";
    await truth.exec("SET TimeZone = 'Europe/London'");
    const [got, want] = [await answer(c, sql), await postgres(sql)];
    await truth.exec("SET TimeZone = 'UTC'");
    assert.deepEqual(got.rows, want.rows);
  } finally { await c.end(); }
});

test("what reads no table is the catalog Postgres's; a schema'd table is in the catalog under its schema", async () => {
  const c = await client();
  try {
    // the run's own words (src/cli/dev.ts: mason-data and the release), `PostgreSQL <n>` first since tools parse it, the
    // machine as Postgres names it
    assert.match(String((await answer(c, "SELECT version()")).rows[0]![0]), /^PostgreSQL 18\.6 \(mason-data 0\.6\.1\) on (aarch64|x86_64)-(linux|darwin)$/);
    const tables = await answer(c, "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('public', 'sales') ORDER BY 1, 2");
    assert.deepEqual(tables.rows, [["public", "accounts"], ["public", "big"], ["public", "big_paid"], ["public", "bigdec"], ["public", "chars"], ["public", "clock_times"], ["public", "deep_t"], ["public", "ga"], ["public", "instants"], ["public", "invoices"], ["public", "jcase"], ["public", "jdocs"], ["public", "jnat"], ["public", "jnums"], ["public", "jq"], ["public", "jq_on"], ["public", "late"], ["public", "late_c"], ["public", "late_counts"], ["public", "late_d"], ["public", "late_joined"], ["public", "late_joined_again"], ["public", "late_n"], ["public", "late_p"], ["public", "late_read"], ["public", "late_read_again"], ["public", "moods"], ["public", "nullish"], ["public", "orders"], ["public", "paid_orders"], ["public", "pnum"], ["public", "ratios"], ["public", "rowid_cased"], ["public", "serials"], ["public", "texts"], ["public", "timetz_runs"], ["public", "timetz_runs3"], ["public", "ua"], ["public", "uchild"], ["public", "uparent"], ["sales", "accounts"], ["sales", "invoices"]]);
    const cols = await answer(c, "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'sales' AND table_name = 'invoices' ORDER BY ordinal_position");
    assert.deepEqual(cols.rows, [["id", "integer"], ["total", "numeric"]]);
  } finally { await c.end(); }
});

test("a table ADDED and not yet served is refused with where its copy is, never `mason add`, read from the sync's copy state", async () => {
  const c = await client();
  const hint = async (sql: string): Promise<string> => {
    let got: pg.DatabaseError | undefined;
    try { await c.query(sql); } catch (e) { got = e as pg.DatabaseError; }
    assert.equal(got?.code, "42P01", sql);
    assert.equal(got.message, `relation "${/FROM (\S+)/.exec(sql)![1]}" does not exist`);
    return got.hint ?? "";
  };
  const state = (over: Partial<CopyState>): CopyState => ({ source: "public.customers", phase: "waiting", rows: null, bytes: 8192, seconds: null, copiedAt: null, error: null, ...over });
  try {
    copies = [state({ phase: "copying", rowsSoFar: 1200, rowsEstimate: 4800 })];
    assert.equal(await hint("SELECT * FROM customers"),
      "public.customers is added and being synced (about 1200 of ~4800 rows so far, 25%): it is served once its first sync commits; mason wait waits for it (mason status shows how far it is)");
    // past the source's estimate (Postgres's statistics lag the table), with the chunks' progress: the share is of the
    // heap's pages and the count says it is past the estimate; without the progress, the count alone says so — a share
    // that fell to 0 once past it is the bug mason wait's bar had
    copies = [state({ phase: "copying", rowsSoFar: 21_385_158, rowsEstimate: 20_126_276,
      progress: { chunksDone: 9, chunksTotal: 11, reading: 2, readingSeconds: 40, rowsReading: 100_000, rowsPerSecond: 12_000, bytesPerSecond: 1e6, secondsLeft: 100, share: 0.87 } })];
    assert.equal(await hint("SELECT * FROM customers"),
      "public.customers is added and being synced (87% of its pages read, 21485158 rows so far, past the ~20126276 estimated): it is served once its first sync commits; mason wait waits for it (mason status shows how far it is)");
    copies = [state({ phase: "copying", rowsSoFar: 5000, rowsEstimate: 4800 })];
    assert.equal(await hint("SELECT * FROM customers"),
      "public.customers is added and being synced (5000 rows so far, past the ~4800 estimated): it is served once its first sync commits; mason wait waits for it (mason status shows how far it is)");
    // qualified, as a tool writes it; DuckDB's progress not read yet
    copies = [state({ phase: "copying" })];
    assert.match(await hint("SELECT * FROM public.customers"), /^public\.customers is added and being synced \(its rows are being read\): it is served once its first sync commits/);
    copies = [state({ phase: "waiting" })];
    assert.match(await hint("SELECT * FROM customers"), /^public\.customers is added and waits its turn to be synced: it is served once its first sync commits; mason wait waits for it/);
    copies = [state({ phase: "failed", error: "permission denied for table customers (tried again after 14:05 UTC (failure 1 in a row), …)" })];
    assert.equal(await hint("SELECT * FROM customers"),
      "public.customers is added, but its first sync failed: permission denied for table customers (tried again after 14:05 UTC (failure 1 in a row), …); mason logs says more");
    // another schema's table of that name is not this one
    copies = [state({ source: "sales.customers", phase: "copying" }), state({ phase: "waiting" })];
    assert.match(await hint("SELECT * FROM customers"), /^public\.customers is added and waits its turn/);
    // a table nobody added is the `mason add` away
    copies = [];
    assert.match(await hint("SELECT * FROM customers"), /^a table is in Mason once it is added: mason add customers syncs it/);
  } finally { copies = []; await c.end(); }
});

test("DuckDB's errors are Postgres's: a missing table 42P01 with `mason add`, a missing function 0A000 with its rewrite", async () => {
  const c = await client();
  try {
    await assert.rejects(c.query("SELECT * FROM customers"), (e: pg.DatabaseError) => e.code === "42P01" && e.message === 'relation "customers" does not exist' && /mason add customers/.test(e.hint ?? ""));
    // what Postgres has and the rewrite cannot make DuckDB compute alike is refused by name, with the way out
    await assert.rejects(c.query("SELECT to_char(interval '1 day', 'HH24') FROM orders"),
      (e: pg.DatabaseError) => e.code === "0A000" && /to_char of an interval/.test(e.message) && /extract/.test(e.hint ?? ""));
    // …and what it can is computed as Postgres does: to_char's number templates (src/duck/to-char.ts)
    assert.deepEqual((await answer(c, "SELECT to_char(1234.5, 'FM9,999.00'), to_char(-5, '9999PR')")).rows, [["1,234.50", "   <5>"]]);
    // a function DuckDB lacks, which Postgres has
    await assert.rejects(c.query("SELECT to_tsvector('simple', status) FROM orders"), (e: pg.DatabaseError) => e.code === "0A000" && /to_tsvector/.test(e.message));
    // …unless Mason computes it as Postgres does (src/duck/functions.ts)
    assert.deepEqual((await answer(c, "SELECT initcap('hello wORLD-x2y straße')")).rows, [["Hello World-X2y Straße"]]);
    await assert.rejects(c.query("SELECT nope FROM orders"), (e: pg.DatabaseError) => e.code === "42703");
    // the session survives each refusal
    assert.deepEqual((await answer(c, "SELECT count(*) FROM orders")).rows, [["3"]]);
  } finally { await c.end(); }
});

test("an array of jsonb values made json embeds each element as json, so ->>0 is the value, never its text quoted", async () => {
  const c = await client();
  try {
    // a BI tool's select item: DuckDB's to_json of the list wrote `["\"paid\""]`, and ->>0 kept the quotes
    assert.deepEqual((await answer(c, "SELECT array_to_json(array[(jsonb_build_object('tz', \"o\".\"status\"))->('tz')])->>0 AS tz, array_to_json(array[meta -> 'k'])->>0 AS k, " +
      "to_json(array[meta, meta -> 'k', NULL]) AS a, to_jsonb(array[meta])::text AS b FROM orders o ORDER BY id")).rows,
    [["paid", "1", '[{"k": 1},1,null]', '[{"k": 1}]'], ["paid", null, "[null,null,null]", "[null]"], ["pending", null, "[[],null,null]", "[[]]"]]);
  } finally { await c.end(); }
});

test("what the oracle has not held to Postgres is refused by name (Mason gap unverified), naming each piece", async () => {
  const c = await client();
  try {
    // degrees() is in no statement tests/integration/duck-oracle.itest.ts answered alike: src/duck/verified.ts lacks it
    await assert.rejects(c.query("SELECT degrees(qty) FROM orders"), (e: pg.DatabaseError) => e.code === "0A000" &&
      /has not verified/.test(e.message) && /degrees\(double precision\)/.test(e.message) &&
      /Mason gap unverified/.test(e.detail ?? "") && /SQL-SUPPORT\.md/.test(e.hint ?? ""));
    assert.deepEqual((await answer(c, "SELECT count(*) FROM orders")).rows, [["3"]]);
  } finally { await c.end(); }
});

test("json_each in a LEFT JOIN … ON TRUE over a derived table, guarded by a CASE, is answered as Postgres (a BI tool's statement)", async () => {
  const c = await client();
  try {
    // the statement's shape: it was refused as `json_each(json)` unverified (function:3958); a NULL or a non-object
    // yields no members and the LEFT JOIN keeps the row
    const shape = `SELECT q."t.id", q."t.payload", q.domain, q.domain_if_then, d.key AS payload_key, d.value AS payload_value FROM (` +
      `SELECT "t"."id" AS "t.id", "t"."j" AS "t.payload", substring((("u"."email")::varchar) from ('@(.*)')) AS domain, ` +
      `CASE WHEN ((substring((("u"."email")::varchar) from ('@(.*)')))::varchar) = ('x') THEN ('x') ELSE ('y') END AS domain_if_then ` +
      `FROM "public"."jnums" AS "t" LEFT JOIN "public"."ua" AS "u" ON "u"."id" = "t"."id") AS q ` +
      `LEFT JOIN json_each(CASE WHEN substring(ltrim("t.payload"::text), 1, 1) = '{' THEN "t.payload"::json ELSE NULL END) d ON TRUE ORDER BY 1, 5`;
    // a json's members are its text's: in its order, a duplicate key kept, each value as written
    const doc = `'{"b": 1, "a" : [1,  2.50 ], "a":"s\\u00e9", "n": null}'::json`;
    const order = `SELECT t.id, (SELECT string_agg(e.key || '=' || coalesce(e.value::text, 'NULL'), ', ') FROM json_each(CASE WHEN t.id = 1 THEN ${doc} END) e), ` +
      `(SELECT string_agg(e.key || '=' || coalesce(e.value, 'NULL'), ', ') FROM json_each_text(CASE WHEN t.id = 1 THEN ${doc} END) e), ` +
      `(SELECT string_agg(e.key || '=' || e.value::text, ', ') FROM jsonb_each(CASE WHEN t.id = 1 THEN ${doc}::jsonb END) e) FROM jnums t ORDER BY 1`;
    for (const sql of [shape, order]) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    assert.deepEqual((await answer(c, order)).rows[0], ["1", `b=1, a=[1,  2.50 ], a="s\\u00e9", n=null`, "b=1, a=[1,  2.50 ], a=sé, n=NULL", `a="sé", b=1, n=null`]);
  } finally { await c.end(); }
});

test("a literal is the value Postgres parsed under the session's zone, in every form it reads; a plan is the zone's own", async () => {
  const c = await client();
  try {
    const sql = "SELECT timestamptz '2026-07-01 12:00', date 'March 1, 2026', interval 'P1DT2H', interval '1 day ago' FROM orders WHERE id = 1";
    assert.deepEqual((await answer(c, sql)).rows, (await postgres(sql)).rows);
    // the same text in another zone is another plan: noon in Rome is 10:00 UTC
    await c.query("SET TimeZone = 'Europe/Rome'");
    await truth.exec("SET TimeZone = 'Europe/Rome'");
    try { assert.deepEqual((await answer(c, sql)).rows, (await postgres(sql)).rows); } finally { await truth.exec("SET TimeZone = 'UTC'"); }
    // a relative word combined with anything else is still refused by name (`today 10:00`)
    await assert.rejects(c.query("SELECT 'today 10:00'::timestamptz FROM orders"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap relative-time-literal/.test(e.detail ?? ""));
  } finally { await c.end(); }
});

test("the review's silent differences: citext without regard to case, an inet as Postgres writes it, a derived table's ORDER BY under the collation, a float rounded into numeric as text, an inner column by Postgres's name", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // citext: `=`, `<>`, IN, LIKE and ORDER BY lower-case both sides (3 of 4 rows are 'finalized'); the wire sends the source's OID
    await alike("SELECT count(*) FROM accounts WHERE status = 'finalized'");
    await alike("SELECT id FROM accounts WHERE status LIKE 'FINAL%' OR status IN ('DRAFT') ORDER BY id");
    await alike("SELECT id, status FROM accounts ORDER BY status, id");
    // what Postgres groups without regard to case is refused by name, never grouped by case
    await assert.rejects(c.query("SELECT status, count(*) FROM accounts GROUP BY status"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap citext-forms/.test(e.detail ?? ""));
    // inet: Postgres's text (no /32), its OID (869), its functions; its order refused
    await alike("SELECT ip, ip::text, host(ip), ip = '10.3.6.45' FROM accounts ORDER BY id");
    await assert.rejects(c.query("SELECT ip FROM accounts ORDER BY ip"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap inet-order/.test(e.detail ?? ""));
    // ARRAY(SELECT x …): a scalar answered; a numeric (DuckDB's double), an array (Postgres's multi-dimensional one), a
    // row, and = ANY (ARRAY(SELECT …)) (DuckDB's binder error) refused by name
    await alike("SELECT ARRAY(SELECT status FROM orders ORDER BY id DESC), ARRAY(SELECT tags[1] FROM orders ORDER BY id)");
    for (const sql of ["SELECT ARRAY(SELECT amount FROM orders ORDER BY id)", "SELECT ARRAY(SELECT amount / 3 FROM orders ORDER BY id)",
      "SELECT ARRAY(SELECT tags FROM orders ORDER BY id)", "SELECT ARRAY(SELECT tags[1:1] FROM orders ORDER BY id)", "SELECT ARRAY(SELECT (id, qty) FROM orders ORDER BY id)",
      "SELECT count(*) FROM orders WHERE id = ANY (ARRAY(SELECT qty FROM orders))"]) {
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap array-subquery-element/.test(e.detail ?? ""), sql);
    }
    // a derived table's column sorted through `s.*`: under the collation, as the column itself sorts
    await alike("SELECT s.* FROM (SELECT team AS pod FROM accounts) AS s ORDER BY s.pod");
    await alike("WITH s AS (SELECT team AS pod, id FROM accounts) SELECT * FROM s ORDER BY pod DESC, id");
    // a float rounded into a numeric, cast to text: `25%`, never `25.0%`
    await alike("SELECT round(qty::float8 / 8 * 100)::numeric::text || '%' AS pct, (amount::float8)::numeric::text AS t FROM orders ORDER BY id");
    // an inner query's unnamed columns, read by the names Postgres gives them
    await alike("SELECT s.count, s.\"?column?\", s.status FROM (SELECT count(*), 1 + 1, status::varchar(2) FROM orders GROUP BY status) AS s ORDER BY 1, 3");
  } finally { await c.end(); }
});

test("the corpus rerun: a relative time literal is the transaction's start at the Parse, now() its start at the execution", async () => {
  const c = await client();
  try {
    const one = async (sql: string): Promise<unknown[]> => (await answer(c, sql)).rows[0]!;
    // in one statement, and in one transaction, the literal is now() and current_date
    assert.deepEqual(await one("SELECT 'now'::timestamptz = now(), 'today'::date = current_date, 'tomorrow'::date - 'yesterday'::date FROM orders WHERE id = 1"), ["t", "t", "2"]);
    await c.query("BEGIN");
    const first = await one("SELECT now(), 'now'::timestamptz FROM orders WHERE id = 1");
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(await one("SELECT now(), 'now'::timestamptz FROM orders WHERE id = 1"), first, "a transaction's now() does not move");
    await c.query("COMMIT");
    // a named prepared statement keeps the literal it was parsed with, and now() moves with each execution (Postgres's own)
    const prepared = { name: "frozen", text: "SELECT 'now'::timestamptz AS lit, now() AS fn FROM orders WHERE id = 1", rowMode: "array", types: raw } as pg.QueryConfig;
    const a = (await c.query(prepared)).rows[0] as string[];
    await new Promise((r) => setTimeout(r, 15));
    const b = (await c.query(prepared)).rows[0] as string[];
    assert.equal(b[0], a[0], "the literal is the Parse's");
    assert.notEqual(b[1], a[1], "now() is each execution's");
  } finally { await c.end(); }
});

// GitHub issues 372 and 363: the transaction's instant is microseconds, as Postgres's. A millisecond made a prepared
// statement's 'now' and its run's now() equal whenever both fell in one millisecond (the flaky oracle), and printed
// three fraction digits where Postgres prints six.
test("the transaction's instant is microseconds on both paths: a prepared 'now' and its run's now() inside one millisecond are two instants", async () => {
  const c = await client();
  const AT = Date.UTC(2026, 0, 2, 20, 0, 0) * 1000;
  const rows = async (q: pg.QueryConfig | string): Promise<unknown[][]> =>
    (await c.query(typeof q === "string" ? { text: q, rowMode: "array", types: raw } as pg.QueryConfig : q)).rows as unknown[][];
  try {
    for (const [name, sql] of [["p372", "SELECT $1::int AS n, now() = 'now' AS same"], ["p372duck", "SELECT $1::int AS n, now() = 'now' AS same FROM orders WHERE id = 1"]] as const) {
      const prepared = { name, text: sql, values: ["1"], rowMode: "array", types: raw } as pg.QueryConfig;
      // Parse, Bind, Execute and Sync in one batch: one implicit transaction, one instant
      fixedNow = AT + 123_456;
      assert.deepEqual(await rows(prepared), [["1", "t"]], `${name} parsed and run in one batch`);
      assert.deepEqual(await rows({ text: sql, values: ["1"], rowMode: "array", types: raw } as pg.QueryConfig), [["1", "t"]], `${name} unnamed, in one batch`);
      // its run in a batch of its own, the same millisecond, a later microsecond: the Parse's 'now' is not the run's now()
      fixedNow = AT + 123_789;
      assert.deepEqual(await rows(prepared), [["1", "f"]], `${name} run later in the same millisecond`);
    }
    // the literal is the Parse's microsecond, now() the run's
    fixedNow = AT + 123_456;
    const frozen = { name: "frozen372", text: "SELECT 'now'::timestamptz::text AS lit, now()::text AS fn FROM orders WHERE id = 1", rowMode: "array", types: raw } as pg.QueryConfig;
    assert.deepEqual(await rows(frozen), [["2026-01-02 20:00:00.123456+00", "2026-01-02 20:00:00.123456+00"]]);
    fixedNow = AT + 123_789;
    assert.deepEqual(await rows(frozen), [["2026-01-02 20:00:00.123456+00", "2026-01-02 20:00:00.123789+00"]]);
    // issue 363: the instant prints six digits on the DuckDB path as on the catalog's; the keywords it has not verified
    // stay refused, as before
    fixedNow = AT + 123_456;
    const six = ["2026-01-02 20:00:00.123456+00", "2026-01-02 20:00:00.123456+00", "2026-01-02 20:00:00.123456"];
    assert.deepEqual(await rows("SELECT now()::text, current_timestamp::text, now()::timestamp::text FROM orders WHERE id = 1"), [six]);
    assert.deepEqual(await rows("SELECT now()::text, current_timestamp::text, now()::timestamp::text"), [six]);
    for (const sql of ["SELECT current_time::text FROM orders WHERE id = 1", "SELECT localtime::text FROM orders WHERE id = 1", "SELECT localtimestamp::text FROM orders WHERE id = 1", "SELECT localtimestamp(6)::text FROM orders WHERE id = 1"]) {
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000", sql);
    }
    // the instant's every edge reaches both paths as one microsecond, inside one block, the clock moved on by 3 µs
    for (const [tail, text] of [[0, "20:00:00"], [1, "20:00:00.000001"], [123_456, "20:00:00.123456"], [499_999, "20:00:00.499999"], [500_000, "20:00:00.5"], [999_999, "20:00:00.999999"]] as const) {
      fixedNow = AT + tail;
      await c.query("BEGIN");
      const catalog = await rows("SELECT now()::text");
      fixedNow = AT + tail + 3;
      const duck = await rows("SELECT now()::text FROM orders WHERE id = 1");
      const again = await rows("SELECT now()::text");
      await c.query("COMMIT");
      const want = [[`2026-01-02 ${text}+00`]];
      assert.deepEqual([catalog, duck, again], [want, want, want], `.${String(tail).padStart(6, "0")}`);
    }
    // outside a block, two Queries 3 µs apart are two instants
    fixedNow = AT + 7;
    const first = await rows("SELECT now()::text FROM orders WHERE id = 1");
    fixedNow = AT + 10;
    assert.deepEqual([first, await rows("SELECT now()::text FROM orders WHERE id = 1")], [[["2026-01-02 20:00:00.000007+00"]], [["2026-01-02 20:00:00.00001+00"]]]);
  } finally { fixedNow = undefined; await c.end(); }
});

// review round 9 of PR 202: a WITH query's exact programs are derived once and given to every reader. The first UNION
// ALL arm that read it took its cells, a later reader got none, the arms disagreed and the whole union was the double
test("round 9: a WITH query read by one, two or three UNION ALL arms, directly or through a query, answers Postgres's digits", async () => {
  const c = await client();
  try {
    // the rows' order is the engine's (no ORDER BY, as the case was met): the multiset is held, each value's text exactly
    const sorted = (rows: unknown[][]): unknown[][] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    // every case is run and each that differs named, so one wrong case does not hide the next
    const wrong: Array<{ sql: string; mine: unknown; postgres: unknown; held: string[] }> = [];
    const same = async (sql: string, column: string[]): Promise<void> => {
      const [mine, theirs] = [await answer(c, sql), await postgres(sql)];
      const [m, p] = [{ fields: mine.fields, rows: sorted(mine.rows) }, { fields: theirs.fields, rows: sorted(theirs.rows) }];
      if (!util.isDeepStrictEqual(m, p) || !util.isDeepStrictEqual(m.rows.map((r) => r[0]), [...column].sort())) wrong.push({ sql, mine: m, postgres: p, held: column });
    };
    const THIRDS = ["14.0000000000000000", "26.8333333333333333", "40.0000000000000000"];
    const SEVENTHS = ["11.5000000000000000", "17.1428571428571429", "6.0000000000000000"];
    const T = "WITH t AS (SELECT amount / 3 AS v FROM orders) ";
    // t read by one arm, beside the same program
    await same(`${T}SELECT v AS x FROM t UNION ALL SELECT amount / 3 FROM orders`, [...THIRDS, ...THIRDS]);
    // t read by two arms (the second after an arm that does not read it)
    await same(`${T}SELECT v AS x FROM t UNION ALL SELECT amount / 3 FROM orders UNION ALL SELECT v FROM t`, [...THIRDS, ...THIRDS, ...THIRDS]);
    await same(`${T}SELECT v AS x FROM t UNION ALL SELECT v FROM t`, [...THIRDS, ...THIRDS]);
    // t read by three arms
    await same(`${T}SELECT v AS x FROM t UNION ALL SELECT v FROM t UNION ALL SELECT v FROM t`, [...THIRDS, ...THIRDS, ...THIRDS]);
    // t read through a subquery in FROM, and directly
    await same(`${T}SELECT v AS x FROM (SELECT * FROM t) s UNION ALL SELECT v FROM t`, [...THIRDS, ...THIRDS]);
    await same(`${T}SELECT v AS x FROM t UNION ALL SELECT v FROM (SELECT * FROM t) s`, [...THIRDS, ...THIRDS]);
    // a WITH query read through another WITH query, and directly (either first)
    await same("WITH t AS (SELECT amount / 7 AS v FROM orders), u AS (SELECT v FROM t) SELECT v AS x FROM u UNION ALL SELECT v FROM t", [...SEVENTHS, ...SEVENTHS]);
    await same("WITH t AS (SELECT amount / 7 AS v FROM orders), u AS (SELECT v FROM t) SELECT v AS x FROM t UNION ALL SELECT v FROM u", [...SEVENTHS, ...SEVENTHS]);
    // t with a stored column, read by two arms: the column's own digits
    const AMOUNTS = ["120.00", "42.00", "80.50"];
    await same("WITH t AS (SELECT amount AS v FROM orders) SELECT v AS x FROM t UNION ALL SELECT v FROM t", [...AMOUNTS, ...AMOUNTS]);
    // the round-8 shape: one arm reads a CTE's sqrt, the other computes the same sqrt
    const ROOTS = ["10.954451150103322", "6.480740698407860", "8.972179222463180"];
    await same("WITH t AS (SELECT sqrt(abs(amount)) AS v FROM orders) SELECT v AS x FROM t UNION ALL SELECT sqrt(abs(amount)) FROM orders", [...ROOTS, ...ROOTS]);
    assert.deepEqual(wrong, []);
  } finally {
    await c.end();
  }
});

// review round 10 of PR 202: round 9 gave a WITH query's later readers the programs its first read derived, but derived
// their FIELDS again, from the WITH query as the first read had left it (its cells appended), which cannot be typed: the
// later reader answered none, the arms disagreed, and the union was the engine's double. Everything a later reader is
// given, its fields too, is the one derivation's. Held in every wrapper the oracle puts a statement in (CI's red was its
// union shape), each value's text exactly, Postgres's (the multiset: the rows' order is the engine's where none is asked)
test("round 10: a WITH query read again, through another or in a wrapper, answers Postgres's digits", async () => {
  const c = await client();
  try {
    const sorted = (rows: unknown[][]): unknown[][] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const wrong: Array<{ sql: string; mine: unknown; postgres: unknown; held: string[] }> = [];
    const same = async (sql: string, column: string[]): Promise<void> => {
      const [mine, theirs] = [await answer(c, sql), await postgres(sql)];
      const [m, p] = [{ fields: mine.fields, rows: sorted(mine.rows) }, { fields: theirs.fields, rows: sorted(theirs.rows) }];
      if (!util.isDeepStrictEqual(m, p) || !util.isDeepStrictEqual(m.rows.map((r) => r[0]), [...column].sort())) wrong.push({ sql, mine: m, postgres: p, held: column });
    };
    const THIRDS = ["14.0000000000000000", "26.8333333333333333", "40.0000000000000000"];
    const SEVENTHS = ["11.5000000000000000", "17.1428571428571429", "6.0000000000000000"];
    const ROOTS = ["10.954451150103322", "6.480740698407860", "8.972179222463180"];
    const times = (column: string[], n: number): string[] => Array.from({ length: n }, () => column).flat();
    const T = "WITH t AS (SELECT amount / 3 AS v FROM orders) ";
    const TU = "WITH t AS (SELECT amount / 7 AS v FROM orders), u AS (SELECT v FROM t) ";
    const S = "WITH t AS (SELECT sqrt(abs(amount)) AS v FROM orders) ";
    const round10: Array<[string, string[]]> = [
      // a WITH query read through another, the other read twice; then with the first between; then through a third
      [`${TU}SELECT v AS x FROM u UNION ALL SELECT v FROM u`, times(SEVENTHS, 2)],
      [`${TU}SELECT v AS x FROM u UNION ALL SELECT v FROM t UNION ALL SELECT v FROM u`, times(SEVENTHS, 3)],
      ["WITH t AS (SELECT amount / 7 AS v FROM orders), u AS (SELECT v FROM t), w AS (SELECT * FROM u) SELECT v AS x FROM w UNION ALL SELECT v FROM u UNION ALL SELECT v FROM t", times(SEVENTHS, 3)],
      // a WITH query's sqrt (a text cell) read by two arms
      [`${S}SELECT v AS x FROM t UNION ALL SELECT v FROM t`, times(ROOTS, 2)],
    ];
    const round9: Array<[string, string[]]> = [
      [`${T}SELECT v AS x FROM t UNION ALL SELECT amount / 3 FROM orders`, times(THIRDS, 2)],
      [`${T}SELECT v AS x FROM t UNION ALL SELECT amount / 3 FROM orders UNION ALL SELECT v FROM t`, times(THIRDS, 3)],
      [`${T}SELECT v AS x FROM t UNION ALL SELECT v FROM t`, times(THIRDS, 2)],
      [`${T}SELECT v AS x FROM t UNION ALL SELECT v FROM t UNION ALL SELECT v FROM t`, times(THIRDS, 3)],
      [`${T}SELECT v AS x FROM (SELECT * FROM t) s UNION ALL SELECT v FROM t`, times(THIRDS, 2)],
      [`${T}SELECT v AS x FROM t UNION ALL SELECT v FROM (SELECT * FROM t) s`, times(THIRDS, 2)],
      [`${TU}SELECT v AS x FROM u UNION ALL SELECT v FROM t`, times(SEVENTHS, 2)],
      [`${TU}SELECT v AS x FROM t UNION ALL SELECT v FROM u`, times(SEVENTHS, 2)],
      ["WITH t AS (SELECT amount AS v FROM orders) SELECT v AS x FROM t UNION ALL SELECT v FROM t", times(["120.00", "42.00", "80.50"], 2)],
      [`${S}SELECT v AS x FROM t UNION ALL SELECT sqrt(abs(amount)) FROM orders`, times(ROOTS, 2)],
    ];
    for (const [sql, column] of round10) await same(sql, column);
    // every statement as written with the oracle's ORDER BY x, and in the oracle's wrappers (tests/integration/oracle/shapes.ts)
    for (const [plain, column] of [...round10, ...round9]) {
      const sql = `${plain} ORDER BY x`;
      await same(sql, column);
      await same(`(${sql}) UNION ALL (${sql})`, times(column, 2));
      await same(`SELECT * FROM (${sql}) AS mason_shape`, column);
      await same(`WITH mason_shape AS (${sql}) SELECT * FROM mason_shape`, column);
      await same(`SELECT mason_shape."x" FROM (${sql}) AS mason_shape`, column);
      await same(`SELECT * FROM (${sql}) AS mason_shape ORDER BY mason_shape."x"`, column);
    }
    assert.deepEqual(wrong.map((w) => w.sql), [], util.inspect(wrong, { depth: 5 }));
  } finally {
    await c.end();
  }
});

test("the corpus rerun: what reached DuckDB and failed, answered as Postgres answers", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // a text read by Postgres's own input functions, a chunk at a time
    await alike("SELECT id, s::date FROM texts WHERE id IN (1, 2) ORDER BY id");
    await alike("SELECT id, s::boolean FROM texts WHERE id = 3");
    await alike("SELECT id, s::int, s::numeric FROM texts WHERE id = 4");
    await alike("SELECT id, s::interval FROM texts WHERE id = 5");
    // a numeric NaN as a result
    await alike("SELECT sum(s::numeric) FROM texts WHERE id IN (6, 7)");
    // a column another table has in another case: qualified, and renamed through a derived table
    await alike(`SELECT "givenName", "Email", email FROM ua u JOIN ga g ON g.id = u.id ORDER BY u.id`);
    await alike(`SELECT s."Email", s.email FROM (SELECT "Email", email, u.id FROM ua u JOIN ga g USING (id)) AS s ORDER BY s.id`);
    await alike(`SELECT email FROM ua u WHERE EXISTS (SELECT 1 FROM ga g WHERE g.id = u.id AND "Email" = upper(email)) ORDER BY 1`);
    // GROUP BY an output name another table's column has in another case: the output
    await alike(`SELECT upper(name) AS "Name", count(*) FROM ga GROUP BY "Name" ORDER BY 1`);
    // a derived table ordered by its aggregate's alias, grouped again outside
    await alike("SELECT p, count(*) FROM (SELECT max(status) AS p FROM orders GROUP BY id ORDER BY p DESC) d GROUP BY p ORDER BY 1");
    // zones as Postgres reads them; an abbreviation refused by name (CST is -06 all year there, Chicago's here)
    await alike("SELECT created_at AT TIME ZONE 'UT', created_at AT TIME ZONE 'america/chicago' FROM orders ORDER BY id");
    await assert.rejects(c.query("SELECT created_at AT TIME ZONE 'CST' FROM orders"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap zone-abbreviation/.test(e.detail ?? ""));
    // a regular expression RE2 lacks (a lookbehind), and one built at run time: Postgres's engine
    await alike("SELECT id, status ~ '(?<!x)paid', status ~* ('\\m' || 'PAI') FROM orders ORDER BY id");
    // a match that depends on the engine: Postgres takes the longest
    await alike("SELECT substring(status from 'p|pa'), regexp_match(status, '(p)(x)?') FROM orders ORDER BY id");
    // a time past the year 9999; json_agg's line breaks beside a NULL array
    await alike("SELECT created_at + 3000000 * interval '1 day' FROM orders ORDER BY id");
    await alike("SELECT json_agg(tags ORDER BY id) FROM orders");
    // a DISTINCT aggregate ordered by a division (its zero test is no volatile error() call)
    await alike("SELECT array_agg(DISTINCT qty::float8 / 2 ORDER BY qty::float8 / 2) FROM orders");
    // after an analysis (which sets the session's zone on the catalog Postgres), what reads no table is still answered
    // in the session's zone: the catalog is set back to UTC, never RESET to the machine's zone (fails only on a machine
    // whose zone is not UTC)
    await answer(c, "SELECT id FROM orders WHERE id = 1");
    await alike("SELECT g FROM generate_series('2026-01-30'::date, '2026-01-31'::date, interval '1 day') g");
    // a large answer is sent in parts, never as one spread of every row
    const big = await answer(c, "SELECT id, v FROM big ORDER BY id");
    assert.equal(big.rows.length, 150_000);
    assert.deepEqual(big.rows.at(-1), ["149999", "v149999"]);
  } finally { await c.end(); }
});

test("the rerun over BIRD and TPC-DS: quotients alike, a NULL date, a BETWEEN beside an AND, stddev of integers", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // 0.3 / 0.1 and 2.1 / 0.7 are 3.0000000000000000 in Postgres; as doubles each had its own last bits
    await alike("SELECT count(DISTINCT a / b), count(*) FILTER (WHERE a / b = 3) FROM ratios");
    await alike("SELECT a / b AS r, count(*), rank() OVER (ORDER BY a / b) FROM ratios GROUP BY 1 ORDER BY 1");
    await assert.rejects(c.query("SELECT a / (b - b) FROM ratios"), (e: pg.DatabaseError) => e.code === "22012");
    // a NULL date's year is NULL, never refused as infinite
    await alike("SELECT id, extract(year FROM d), date_part('year', d) FROM ratios ORDER BY id");
    // a text BETWEEN (two comparisons under the collation) inside another AND
    await alike("SELECT count(*) FROM ratios WHERE team BETWEEN '0' AND '9' AND id > 1");
    // stddev of an integer is Postgres's exact numeric, also divided by an average
    await alike("SELECT stddev_samp(n), stddev_samp(n) / avg(n), var_pop(a), stddev(a) FROM ratios");
    await alike("SELECT a FROM ratios INTERSECT SELECT b FROM ratios EXCEPT SELECT 0.1 FROM ratios ORDER BY 1");
    // a date where Postgres chose a timestamptz's function, grouped by the same expression: widened once in each place
    await alike("SELECT date_trunc('week', d) AS w, sum(n) FROM ratios GROUP BY date_trunc('week', d) ORDER BY 1");
  } finally { await c.end(); }
});

test("the rerun at 7957b687: a correlated series of times, a date plus a day count, an outer name in a UNION, a random window", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // one row's series is empty (qty 1: an end before the start): DuckDB's table function of times then answered no
    // rows for every row, silently
    await alike("SELECT id, (SELECT count(*) FROM generate_series(created_at, created_at + (qty - 2) * interval '1 day', interval '1 day') AS g) AS n FROM orders ORDER BY id");
    await alike("SELECT o.id, count(g.g) FROM orders o LEFT JOIN LATERAL generate_series(o.created_at, o.created_at + (o.qty - 2) * interval '1 day', interval '1 day') AS g ON true GROUP BY o.id ORDER BY 1");
    // a date minus a date is an integer, which a date can be added to
    await alike("SELECT id, d + (d - '2026-01-01'::date) FROM ratios ORDER BY id");
    // a bare name the subquery's FROM lacks is the outer query's, never the subquery's own output name
    await alike("SELECT id, (SELECT count(*) FROM (SELECT n FROM orders o WHERE o.id = ratios.id UNION SELECT a) AS u) FROM ratios ORDER BY id");
    // an exact numeric named through a SELECT * of a derived table keeps Postgres's scale (2.0, never 2)
    await alike("SELECT s.c FROM (SELECT * FROM (SELECT round(n::numeric, 1) AS c FROM ratios) q) s ORDER BY 1");
    await alike("WITH base AS (SELECT round(100.0 * (n - 5) / nullif(n, 5), 1) AS pct, id FROM ratios) SELECT b.pct FROM (SELECT * FROM base) AS b ORDER BY b.id");
    // a random row per group is refused by name, with the way out (which answers)
    await assert.rejects(c.query("SELECT row_number() OVER (PARTITION BY team ORDER BY random()) FROM ratios"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap volatile-window/.test(e.detail ?? ""));
    await alike("SELECT count(*) FROM (SELECT row_number() OVER (PARTITION BY team ORDER BY r) AS rn FROM (SELECT *, random() AS r FROM ratios) AS s) AS x WHERE rn = 1");
  } finally { await c.end(); }
});

test("the rerun at ae2c5169: min / max of a numeric quotient keeps the quotient's scale; a FILTER guards its aggregate's argument", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // the picked row's quotient, at its scale (0.00000000000000000000, 3.00), never DuckDB's double (0, 3)
    await alike("SELECT min(extract(epoch FROM n * interval '1 hour') / 3600), round(max(extract(epoch FROM n * interval '1 hour') / 3600), 2), round(min(extract(epoch FROM n * interval '1 hour')::numeric / 3600), 2) FROM ratios");
    await alike("SELECT min(a / b), max(a / b), round(max(a / b), 2) FROM ratios");
    await alike("SELECT team, min(a / b) FILTER (WHERE n > 3), max(coalesce(a / nullif(b - 0.1, 0), 0)) FROM ratios GROUP BY team ORDER BY team");
    await alike("SELECT min(a / b), max(a / b) FROM ratios WHERE false");
    // DuckDB evaluated an aggregate's argument on every row before its FILTER: a division by a row's zero raised
    await alike("SELECT min(a / (b - 0.1)) FILTER (WHERE b <> 0.1), sum(n / (n - 3)) FILTER (WHERE n <> 3), string_agg(team, ',' ORDER BY 10 / (n - 3), id) FILTER (WHERE n <> 3) FROM ratios");
  } finally { await c.end(); }
});

test("the rerun at cc380e8d: a DISTINCT aggregate's FILTER, and a numeric CASE computed arm by arm", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // the FILTER's guard broke a DISTINCT aggregate's ORDER BY (its collation key), 42803
    await alike("SELECT string_agg(DISTINCT team, ', ') FILTER (WHERE n > 3), array_agg(DISTINCT team) FILTER (WHERE n > 3) FROM ratios");
    // a CASE with an integer arm was DuckDB's double: 0 for 0.00
    await alike("SELECT round(min(CASE WHEN id = 1 THEN 0 ELSE id / 3.0 END)::numeric, 2), max(CASE WHEN id = 1 THEN 0 ELSE a / b END) FROM ratios");
    await alike("SELECT id, CASE WHEN id = 1 THEN 0 ELSE a / b END, CASE n WHEN 3 THEN a WHEN 5 THEN b END, CASE WHEN n > 4 THEN sqrt(n - 4)::numeric ELSE a END FROM ratios ORDER BY id");
  } finally { await c.end(); }
});

test("the BI-tools test: a numeric constant with an exponent is a numeric, beside a column too (Grafana's $__timeGroup)", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // `2.5e2` is 250 written positionally, which read back as an INTEGER and was refused ("does not read back")
    await alike("SELECT id, a * 2.5e2, n * 2.5e2, n * 3e9, 2.5e2, -2.5e2, 1.50e1, 0e0, '2.5e2'::numeric, '1.5'::numeric FROM ratios ORDER BY id");
    // a numeric, never DuckDB's integer arithmetic: past an int4 where Postgres's numeric is not
    await alike("SELECT n * 1e9 * 1e9 FROM ratios ORDER BY id");
    // Grafana's $__timeGroup(created_at, '1M')
    await alike("SELECT floor(extract(epoch FROM created_at) / 2.6784e+06) * 2.6784e+06 AS time, count(*) FROM orders GROUP BY 1 ORDER BY 1");
  } finally { await c.end(); }
});

test("a numeric text is read as Postgres 16's numeric_in reads it: underscores, 0x / 0o / 0b (the Fable review of #517)", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // `'1_000'::numeric` reached DuckDB as a double of a text it does not read; answered alone and inside DuckDB's arithmetic
    await alike("SELECT '1_000'::numeric, '0x1F'::numeric, '-0o17'::numeric, '0b_101'::numeric, ' 1_000.50 '::numeric, '1e1_0'::numeric, '1e40'::numeric, 12345678901234567890123456789012345678901234.5");
    await alike("SELECT id, n * '1_000'::numeric, a + '0x1F'::numeric FROM ratios WHERE n < '1_0'::numeric ORDER BY id");
  } finally { await c.end(); }
});

test("the BI-tools test: a sum over a CASE has the scale of the arms its rows took (Metabase's \"sum where\")", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // every row takes `n` (scale 0): 29, never 29.0; some take 0.0: 26.0
    await alike("SELECT sum(CASE WHEN n >= 0 THEN n ELSE 0.0 END), sum(CASE WHEN n > 4 THEN n ELSE 0.0 END), sum(CASE WHEN n > 100 THEN 1.25 ELSE n END) FROM ratios");
    await alike("SELECT team, sum(CASE WHEN n > 4 THEN n ELSE 0.0 END), sum(CASE WHEN n > 4 THEN a ELSE 0 END) FROM ratios GROUP BY team ORDER BY team");
    // a FILTER, a window, a coalesce, arithmetic over the CASE, an average's sum, no rows
    await alike("SELECT sum(CASE WHEN n > 4 THEN n ELSE 0.0 END) FILTER (WHERE n > 4), sum(coalesce(CASE WHEN n > 4 THEN n END, 0.0)), sum(CASE WHEN n > 4 THEN n ELSE 0.0 END * 2), avg(CASE WHEN n >= 0 THEN n ELSE 0.0 END) FROM ratios");
    await alike("SELECT id, sum(CASE WHEN n > 4 THEN n ELSE 0.0 END) OVER (ORDER BY id) FROM ratios ORDER BY id");
    await alike("SELECT sum(CASE WHEN n > 4 THEN n ELSE 0.0 END) FROM ratios WHERE false");
  } finally { await c.end(); }
});

/** One session over a raw socket, its reading in the test's hands (`pg` reads every reply as it comes); `startup` adds
 *  to its startup packet, and `reported` is the ParameterStatus the startup answered. */
async function rawSession(port = api.port, startup: Record<string, string> = {}): Promise<{ socket: net.Socket; pid: number; secret: number; reported: Map<string, string>; untilReady(): Promise<BackendMessage[]>; end(): void; readonly bytes: number; readonly raw: Buffer }> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((r) => socket.once("connect", () => r()));
  let chunks: Buffer[] = [];
  let tail = Buffer.alloc(0);
  let wake: (() => void) | null = null;
  /** the bytes the last untilReady read, ReadyForQuery included */
  let bytes = 0;
  let raw = Buffer.alloc(0);
  socket.on("data", (d: Buffer) => { chunks.push(d); tail = Buffer.concat([tail, d]).subarray(-6); wake?.(); });
  const ready = (): boolean => tail.length === 6 && tail[0] === 0x5a && tail.readInt32BE(1) === 5;
  const untilReady = async (): Promise<BackendMessage[]> => {
    while (!ready()) await new Promise<void>((r) => { wake = r; });
    const all = Buffer.concat(chunks);
    bytes = all.length;
    raw = all;
    const ms = wire.replies(all);
    chunks = []; tail = Buffer.alloc(0);
    return ms;
  };
  socket.write(wire.startup({ user: "mason", database: "app", ...startup }));
  while (chunks.length === 0) await new Promise<void>((r) => { wake = r; });
  chunks = [];
  socket.write(wire.password(mintToken(API_KEY, 600).token));
  const started = await untilReady();
  const key = started.find((m) => m.type === "BackendKeyData") as Extract<BackendMessage, { type: "BackendKeyData" }>;
  const reported = new Map(started.flatMap((m) => m.type === "ParameterStatus" ? [[m.name, m.value] as const] : []));
  return { socket, pid: key.pid, secret: key.secret, reported, untilReady, end: () => { socket.destroy(); }, get bytes() { return bytes; }, get raw() { return raw; } };
}
const dataRows = (ms: BackendMessage[]): Array<Extract<BackendMessage, { type: "DataRow" }>> => ms.filter((m) => m.type === "DataRow") as Array<Extract<BackendMessage, { type: "DataRow" }>>;
const finished = (word: string): boolean => logged.some((l) => l.startsWith("statement:") && l.includes(word));

// a `SELECT *` over a 23 M-row table once held every row three times over before the first was sent, and ran
// the whole run out of heap. A result is now read a chunk at a time, each written before the next is read
test("a result is streamed: a client that reads nothing holds DuckDB's reading back, and every row arrives once it reads", async () => {
  const s = await rawSession();
  try {
    s.socket.pause();
    // 150,000 rows of ~200 bytes: 30 MB, far past any socket's buffers
    s.socket.write(wire.query("SELECT v || repeat('x', 200) AS streamed_wide FROM big"));
    await sleep(500);
    assert.ok(!finished("streamed_wide"), "the statement is still open: Mason read no further than the socket took");
    s.socket.resume();
    const ms = await s.untilReady();
    assert.equal(dataRows(ms).length, 150000);
    assert.equal((ms.find((m) => m.type === "CommandComplete") as Extract<BackendMessage, { type: "CommandComplete" }> | undefined)?.tag, "SELECT 150000");
    assert.ok(finished("streamed_wide"));
  } finally { s.end(); }
});

test("an Execute's row limit pages through a streamed result, another statement of the session between its pages", async () => {
  const s = await rawSession();
  try {
    const text = (m: Extract<BackendMessage, { type: "DataRow" }>): string => String(m.values[0]);
    s.socket.write(Buffer.concat([wire.parse("", "SELECT id FROM big ORDER BY id"), wire.bind("c1", "", [], [0]), wire.execute("c1", 1000), wire.sync()]));
    let ms = await s.untilReady();
    assert.deepEqual([dataRows(ms).length, text(dataRows(ms)[0]!), text(dataRows(ms).at(-1)!), ms.at(-2)!.type], [1000, "0", "999", "PortalSuspended"]);
    // DuckDB starts nothing on a connection whose result is half read: the portal is read aside, and still pages on
    s.socket.write(wire.extended("SELECT count(*) FROM big", [], [0]));
    ms = await s.untilReady();
    assert.equal(text(dataRows(ms)[0]!), "150000");
    s.socket.write(Buffer.concat([wire.execute("c1", 1000), wire.sync()]));
    ms = await s.untilReady();
    assert.deepEqual([dataRows(ms).length, text(dataRows(ms)[0]!), text(dataRows(ms).at(-1)!), ms.at(-2)!.type], [1000, "1000", "1999", "PortalSuspended"]);
    s.socket.write(Buffer.concat([wire.close("P", "c1"), wire.sync()]));
    assert.deepEqual((await s.untilReady()).map((m) => m.type), ["CloseComplete", "ReadyForQuery"]);
  } finally { s.end(); }
});

// ISSUE 664: Metabase read a synced timetz at a network round trip a row, and the extended protocol was suspected. It is
// not Mason's: Metabase reads a TIME column as a LocalTime, which pgJDBC refuses for a timetz on every row (against
// Postgres too), and its c3p0 pool then pings the connection (pgJDBC's isValid, an empty simple Query) before the next
// row. Every exchange of that path is held here to postgres:18's (18.6) own bytes, recorded from a raw session over the
// same rows; the one field Mason does not send as Postgres does, a RowDescription's table OID and column number (0 in
// Mason's), is issue 669's and left out of the comparison on both sides.
const PG18_TIMETZ: Record<string, string[]> = {
  describe: ["1 ", "t 0000", "T 000172756e5f617400000040010002000004f2000cffffffff0000", "Z 49"],
  describeTypmod: ["1 ", "t 0000", "T 000172756e5f61743300000040070002000004f2000c000000030000", "Z 49"],
  text: ["1 ", "2 ", "T 000172756e5f617400000040010002000004f2000cffffffff0000", "D 00010000000b30373a33303a30302b3030",
    "D 00010000001230373a33303a30302e3132332b30353a3330", "D 00010000001232333a35393a35392e3939393939392d3034", "D 00010000000b32343a30303a30302b3030",
    "D 0001ffffffff", "C 53454c454354203500", "Z 49"],
  // timetz_send: the time in microseconds, then the zone in seconds WEST of UTC (+05:30 is -19800, -04 is 14400)
  binary: ["1 ", "2 ", "T 000172756e5f617400000040010002000004f2000cffffffff0001", "D 00010000000c0000000649534e0000000000",
    "D 00010000000c0000000649552e78ffffb2a8", "D 00010000000c000000141dd75fff00003840", "D 00010000000c000000141dd7600000000000",
    "D 0001ffffffff", "C 53454c454354203500", "Z 49"],
  // as pgJDBC asks once a statement is server-prepared: int4, timetz and time each in binary
  binaryColumns: ["1 ", "2 ", "T 0003696400000040010001000000170004ffffffff000172756e5f617400000040010002000004f2000cffffffff0001745f6174000000400100030000043b0008ffffffff0001",
    "D 000300000004000000010000000c0000000649534e0000000000000000080000000649534e00", "D 000300000004000000020000000c0000000649534e0000000000000000080000000649534e00",
    "D 000300000004000000030000000c0000000649534e0000000000000000080000000649534e00", "C 53454c454354203300", "Z 49"],
  mixed: ["1 ", "2 ", "T 000272756e5f617400000040010002000004f2000cffffffff000172756e5f61740000000000000000000019ffffffffffff0000",
    "D 00020000000c0000000649534e00000000000000000b30373a33303a30302b3030", "C 53454c454354203100", "Z 49"],
};
/** each backend message as `<type> <body in hex>` */
function framesOf(raw: Buffer): string[] {
  const out: string[] = [];
  for (let at = 0; at < raw.length;) {
    const len = raw.readInt32BE(at + 1);
    out.push(`${String.fromCharCode(raw[at]!)} ${raw.subarray(at + 5, at + 1 + len).toString("hex")}`);
    at += 1 + len;
  }
  return out;
}
/** a RowDescription with each field's table OID and column number zeroed (issue 669); any other message as it is */
function sansTable(frame: string): string {
  if (!frame.startsWith("T ")) return frame;
  const b = Buffer.from(frame.slice(2), "hex");
  for (let i = 0, n = b.readInt16BE(0), at = 2; i < n; i++) {
    at = b.indexOf(0, at) + 1;
    b.writeInt32BE(0, at);
    b.writeInt16BE(0, at + 4);
    at += 18;
  }
  return `T ${b.toString("hex")}`;
}

test("a synced timetz under the extended protocol is postgres:18's bytes: Describe, text and binary DataRows, the typmod (issue 664)", async () => {
  const s = await rawSession();
  try {
    const exchange = async (...frames: Buffer[]): Promise<string[]> => { s.socket.write(Buffer.concat(frames)); await s.untilReady(); return framesOf(s.raw).map(sansTable); };
    const expect = (name: string): string[] => PG18_TIMETZ[name]!.map(sansTable);
    const some = "SELECT run_at FROM timetz_runs WHERE id IN (1,401,402,403,404) ORDER BY id";
    assert.deepEqual(await exchange(wire.parse("", "SELECT run_at FROM timetz_runs ORDER BY id"), wire.describe("S", ""), wire.sync()), expect("describe"), "Describe of the statement: OID 1266, length 12, typmod -1");
    assert.deepEqual(await exchange(wire.parse("", "SELECT run_at3 FROM timetz_runs3"), wire.describe("S", ""), wire.sync()), expect("describeTypmod"), "a timetz(3) keeps its typmod 3");
    const extended = (sql: string, formats: number[]): Promise<string[]> =>
      exchange(wire.parse("", sql), wire.bind("", "", [], formats), wire.describe("P", ""), wire.execute("", 0), wire.sync());
    assert.deepEqual(await extended(some, [0]), expect("text"), "text: timetz_out, 24:00:00 and a NULL included");
    assert.deepEqual(await extended(some, [1]), expect("binary"), "binary: timetz_send");
    assert.deepEqual(await extended("SELECT id, run_at, t_at FROM timetz_runs ORDER BY id LIMIT 3", [1]), expect("binaryColumns"), "binary per column: int4, timetz, time");
    assert.deepEqual(await extended("SELECT run_at, run_at::text FROM timetz_runs WHERE id = 1", [1, 0]), expect("mixed"), "a format per column: binary, then text");
  } finally { s.end(); }
});

test("a timetz read in pages under the extended protocol, an empty query (pgJDBC's ping) between its pages, is postgres:18's bytes (issue 664)", async () => {
  const s = await rawSession();
  try {
    const exchange = async (...frames: Buffer[]): Promise<string[]> => { s.socket.write(Buffer.concat(frames)); await s.untilReady(); return framesOf(s.raw); };
    // the rows of `SELECT id, run_at` in binary: the id, then 07:30:00+00 as timetz_send writes it
    const rows = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) =>
      `D 000200000004${(from + i).toString(16).padStart(8, "0")}0000000c0000000649534e0000000000`);
    // the simple-protocol ping, outside a transaction and in one
    assert.deepEqual(await exchange(wire.query("")), ["I ", "Z 49"]);
    assert.deepEqual(await exchange(wire.query("BEGIN READ ONLY")), ["C 424547494e00", "Z 54"]);
    assert.deepEqual(await exchange(wire.query("")), ["I ", "Z 54"]);
    assert.deepEqual(await exchange(wire.parse("", "SELECT id, run_at FROM timetz_runs ORDER BY id"), wire.bind("c2", "", [], [1]), wire.execute("c2", 50), wire.sync()),
      ["1 ", "2 ", ...rows(1, 50), "s ", "Z 54"], "the first page, suspended");
    assert.deepEqual(await exchange(wire.query("")), ["I ", "Z 54"], "pgJDBC's isValid between pages: an empty simple Query");
    assert.deepEqual(await exchange(wire.execute("c2", 50), wire.sync()), [...rows(51, 100), "s ", "Z 54"], "the portal goes on where it stopped");
    // an empty query by the extended protocol between pages, the unnamed portal beside the named one
    assert.deepEqual(await exchange(wire.parse("", ""), wire.bind("", "", [], []), wire.describe("P", ""), wire.execute("", 0), wire.sync()), ["1 ", "2 ", "n ", "I ", "Z 54"]);
    assert.deepEqual(await exchange(wire.execute("c2", 50), wire.sync()), [...rows(101, 150), "s ", "Z 54"], "and on again");
    assert.deepEqual(await exchange(wire.query("COMMIT")), ["C 434f4d4d495400", "Z 49"]);
  } finally { s.end(); }
});

test("a cancel stops a streamed statement while Mason waits for the client to read: 57014, and the session goes on", async () => {
  const s = await rawSession();
  try {
    s.socket.pause();
    s.socket.write(wire.query("SELECT v || repeat('y', 200) AS cancelled_wide FROM big"));
    await sleep(300);
    const c = net.connect(api.port, "127.0.0.1");
    await new Promise<void>((r) => c.once("connect", () => r()));
    c.end(wire.cancelRequest(s.pid, s.secret));
    await sleep(100);
    s.socket.resume();
    const ms = await s.untilReady();
    const error = ms.find((m) => m.type === "ErrorResponse") as Extract<BackendMessage, { type: "ErrorResponse" }> | undefined;
    assert.equal(error?.fields.C, "57014");
    assert.ok(dataRows(ms).length < 150000, `${dataRows(ms).length} rows sent`);
    s.socket.write(wire.query("SELECT count(*) FROM big"));
    assert.equal(String(dataRows(await s.untilReady())[0]!.values[0]), "150000");
  } finally { s.end(); }
});

// A CLIENT LEAVING MID-STATEMENT (the test server: a psql killed during a JSON query over 22 M rows hung
// the whole process for good — main thread blocked, every port held, nothing answering). The session's DuckDB connection
// was closed synchronously while its statement still ran: the close waits for the executor, and the executor waits for
// the main thread to run the JavaScript scalar function the statement calls. The statement is interrupted, and the
// connection closed only once it has settled; meanwhile and after, every other session is answered.
test("a client leaving mid-statement: the statement is interrupted, its connection closed after it settles, the process answering throughout", async () => {
  const c = await client();
  c.on("error", () => undefined);   // pg reports the socket we tear down below as an error event; the test does not care
  // 4 M rows through the JSON scalar function (`->` is __mason_json_get; a string's `->>` is DuckDB's own read,
  // src/duck/rewrite.ts jsonGet): seconds, the event loop starved meanwhile
  const sql = "SELECT count(*) FROM late a, late b WHERE (a.j->'n')::text || (b.j->'n')::text <> ''";
  const left = c.query(sql).then(() => "answered", (e: Error) => e.message);
  await sleep(200);
  (c as unknown as { connection: { stream: net.Socket } }).connection.stream.destroy();
  const from = logged.length;
  const t0 = Date.now();
  let other: pg.Client;
  try {
    other = await client();
    try { assert.deepEqual((await answer(other, "SELECT 1")).rows, [["1"]]); }
    finally { await other.end(); }
  } catch (e) {
    throw new Error(`another session after ${Date.now() - t0} ms: ${(e as Error).message}\n${logged.slice(from).join("\n")}`);
  }
  assert.ok(Date.now() - t0 < 20_000, `another session answered in ${Date.now() - t0} ms`);
  assert.match(await left, /Connection terminated|terminated unexpectedly|closed/, "the leaving client's statement ended");
  for (const deadline = Date.now() + 10_000; !logged.some((l) => /closed: closed by the client/.test(l));) {
    if (Date.now() > deadline) throw new Error(`the session was not closed within 10 s\n${logged.slice(-10).join("\n")}`);
    await sleep(50);
  }
  // and the statement ended on the server too (its release is logged), rather than computing on for a client gone
  for (const deadline = Date.now() + 10_000; !logged.slice(from).some((l) => /^statement: \d+ row\(s\) in \d+ ms — SELECT count\(\*\) AS count FROM late AS a, late AS b/.test(l));) {
    if (Date.now() > deadline) throw new Error(`the statement was not released within 10 s of the client leaving\n${logged.slice(from).join("\n")}`);
    await sleep(50);
  }
  assert.ok(!logged.some((l) => /closing its DuckDB connection failed/.test(l)), logged.filter((l) => /closing/.test(l)).join("\n"));
});

// a statement that calls a Mason function is cancelled through its session (its next call raises) and interrupted, and closed once its calls stop:
// the timeout's wording all the same, the session going on, the process answering throughout
test("statement_timeout stops a statement that calls a Mason function: 57014 in the timeout's words, the session goes on", async () => {
  const c = await client();
  try {
    await c.query("SET statement_timeout = 300");
    const t = Date.now();
    await assert.rejects(c.query("SELECT count(*) FROM late a, late b WHERE (a.j->'n')::text || (b.j->'n')::text <> ''"),
      (e: pg.DatabaseError) => e.code === "57014" && e.message === "canceling statement due to statement timeout");
    assert.ok(Date.now() - t < 5000, `stopped after ${Date.now() - t} ms`);
    await c.query("SET statement_timeout = 0");
    assert.deepEqual((await answer(c, "SELECT count(*) FROM late WHERE (j->'n')::text = '\"7\"'")).rows, [["1"]], "the session goes on, its functions answering");
  } finally { await c.end(); }
});

test("DuckDB's memory_limit text is held to the bytes it was set to, to the tenth of the unit it prints", async () => {
  const MiB = 2 ** 20, GiB = 2 ** 30;
  assert.equal(withinDuckDBRounding("64.0 MiB", 64 * MiB), true);
  assert.equal(withinDuckDBRounding("64.0 MiB", 80 * MiB), false, "a wrong value");
  // CI's runner (main's run 40590378916): half its 15.6 GiB, about 7990 MiB, printed "7.8 GiB"
  assert.equal(withinDuckDBRounding("7.8 GiB", 7990 * MiB), true);
  assert.equal(withinDuckDBRounding("7.8 GiB", 7.8 * GiB + 1), true, "a tenth's own bytes");
  assert.equal(withinDuckDBRounding("16.0 GiB", 32 * GiB / 2), true, "half a 32 GiB Mac");
  assert.equal(withinDuckDBRounding("7.9 GiB", 7.99 * GiB), true, "truncated, not rounded");
  assert.equal(withinDuckDBRounding("8.0 GiB", 7.99 * GiB), false, "DuckDB never rounds up");
  assert.equal(withinDuckDBRounding("7.8 GiB", 7.79 * GiB), false, "below the amount printed");
  assert.equal(withinDuckDBRounding("7.8 GiB", 7.95 * GiB), false, "past the next tenth");
  // the rule is DuckDB's own: each limit set on an instance prints as the rule says
  const db = await DuckDBInstance.create(":memory:"), c = await db.connect();
  try {
    for (const bytes of [64 * MiB, Math.floor(64.96 * MiB), Math.floor(1023.9 * MiB), 7990 * MiB, Math.floor(7.99 * GiB), 16 * GiB]) {
      await c.run(`SET memory_limit = '${bytes}B'`);
      const text = String((await c.runAndReadAll("SELECT current_setting('memory_limit')")).getRows()[0]![0]);
      assert.ok(withinDuckDBRounding(text, bytes), `${bytes} bytes printed ${text}`);
    }
  } finally { c.closeSync(); db.closeSync(); }
});

// DuckDB's default is 80% of the machine's RAM, in the process that holds V8's heap, the PGlites and every session
test("DuckDB's memory is bounded: half the RAM, or what leaves the reserve, unless MASON_DUCKDB_MEMORY says, spilling beside the copy", async () => {
  const setting = async (st: DuckStore, name: string): Promise<string> => String((await st.writer.runAndReadAll(`SELECT current_setting('${name}')`)).getRows()[0]![0]);
  const own = await DuckStore.open(path.join(dir, "limited.db"), () => undefined, { memoryLimit: "64MiB" });
  try {
    assert.equal(await setting(own, "memory_limit"), "64.0 MiB");
    assert.equal(await setting(own, "temp_directory"), path.join(dir, "limited.db.tmp"));
    // STRINGS ARE STORED ZSTD: DuckDB's analyzer never picks ZSTD by itself and left a table's JSON text
    // column Uncompressed on the test server (a 194 M-row table: 0.66 GB a million rows, against 0.26 forced); forced
    // on the instance, the other types keep their own methods (BitPacking, RLE)
    assert.equal(await setting(own, "force_compression"), "zstd");
    await own.writer.run("CREATE TABLE packed AS SELECT i, '{\"k\":' || i || ',\"payload\":\"' || repeat(chr(97 + (i % 26)::INTEGER), 200) || md5(i::VARCHAR) || '\"}' AS j FROM range(200000) r(i)");
    await own.writer.run("CHECKPOINT");
    const compression = (await own.writer.runAndReadAll("SELECT column_name, compression FROM pragma_storage_info('packed') WHERE segment_type IN ('VARCHAR', 'BIGINT') GROUP BY 1, 2 ORDER BY 1, 2")).getRowsJS();
    assert.deepEqual(compression, [["i", "BitPacking"], ["j", "ZSTD"]], "the string column ZSTD, the integer its own");
  } finally { await own.close(); }
  // the shared store took the default: half the RAM, or of the container's limit, or what leaves the reserve beside it
  // when that is less (in whole MiB, DEFAULT_MEMORY_LIMIT; issue 301), as DuckDB prints it: to a tenth of its unit
  const total = machineMemoryBytes();
  assert.equal(DEFAULT_MEMORY_LIMIT, defaultMemoryLimit(total));
  const rule = Math.min(total / 2, Math.max(MIN_SHARE_BYTES, total - OUTSIDE_RESERVE_BYTES));
  assert.ok(Math.abs(memoryLimitBytes(DEFAULT_MEMORY_LIMIT) - rule) < 2 ** 20, `${DEFAULT_MEMORY_LIMIT} for ${total} bytes`);
  assert.ok(total < MEMORY_FLOOR_BYTES || total - memoryLimitBytes(DEFAULT_MEMORY_LIMIT) >= OUTSIDE_RESERVE_BYTES, "the reserve is left beside it");
  assert.equal(store.memoryLimitBytes, memoryLimitBytes(DEFAULT_MEMORY_LIMIT));
  assert.ok(withinDuckDBRounding(await setting(store, "memory_limit"), store.memoryLimitBytes), `${await setting(store, "memory_limit")} for ${store.memoryLimitBytes} bytes`);
  await assert.rejects(DuckStore.open(path.join(dir, "bad.db"), () => undefined, { memoryLimit: "lots" }), /^Error: MASON_DUCKDB_MEMORY="lots" is not an amount of memory: it is the memory the synced data's statements may use before they spill to disk — write it as 8GB or 512MiB, or unset it for the default/);
});

test("a statement past DuckDB's memory fails alone, 53200 with the way out, and the session goes on", async () => {
  const before = String((await store.writer.runAndReadAll("SELECT current_setting('memory_limit')")).getRows()[0]![0]);
  const c = await client();
  try {
    await store.writer.run("SET memory_limit = '40MB'");
    await assert.rejects(c.query("SELECT count(*) FROM (SELECT v || repeat('x', 300) AS w FROM big ORDER BY w DESC) s"),
      (e: pg.DatabaseError) => e.code === "53200" && /out of memory/.test(e.message) && /MASON_DUCKDB_MEMORY/.test(e.hint ?? ""));
  } finally {
    await store.writer.run(`SET memory_limit = '${before.replace(" ", "")}'`);
  }
  try { assert.equal((await c.query("SELECT count(*) AS n FROM big")).rows[0].n, "150000"); }
  finally { await c.end(); }
});

// ISSUE 105: a sort's spill took every free byte of a volume. Measured on a small volume: DuckDB's own ceiling is 90% of
// what was free when it first spilled, read once, so a disk that fills afterwards ends in its IO error, XX000 with a path
test("what statements may spill is half of what is free, followed as the disk fills, and never all of it", async () => {
  // read here, so the file loads at a commit without it and this test fails by name (scripts/fails-without.ts)
  const { spillCeiling } = await import("../src/duck/store.ts");
  const GiB = 2 ** 30;
  assert.equal(spillCeiling(20 * GiB, 0, null), 10 * GiB, "half of what is free");
  assert.equal(spillCeiling(10 * GiB, 4 * GiB, null), 7 * GiB, "half of the room: the free bytes exclude what is spilled");
  // a sort that keeps spilling, read again and again, stays at half of the room it started with, never the whole disk
  let spilled = 0;
  for (let i = 0; i < 40; i++) spilled = Math.min(spillCeiling(23 * GiB - spilled, spilled, null), spilled + GiB);
  assert.equal(spilled, 11.5 * GiB);
  assert.equal(spillCeiling(10 * GiB, 10 * GiB, 40 * GiB), 18 * GiB, "the operator's amount, never past 90% of the room");
  assert.equal(spillCeiling(20 * GiB, 0, 4 * GiB), 4 * GiB, "the operator's amount");
  assert.equal(spillCeiling(20 * GiB, 0, 40 * GiB), 18 * GiB, "the operator's amount, never past 90% of what is free");
  assert.equal(spillCeiling(0, 0, null), 2 ** 20, "a full disk: a ceiling all the same, DuckDB reads none as its default");
  const setting = async (st: DuckStore): Promise<string> => String((await st.writer.runAndReadAll("SELECT current_setting('max_temp_directory_size')")).getRows()[0]![0]);
  let free = 8 * GiB;
  const lines: string[] = [];
  const own = await DuckStore.open(path.join(dir, "spill.db"), (l) => lines.push(l), { memoryLimit: "64MiB", diskFree: () => free });
  try {
    assert.equal(own.spillLimitBytes, 4 * GiB);
    assert.equal(await setting(own), "4.0 GiB");
    free = 2 * GiB;   // a copy took the rest
    await own.keepSpillCeiling();
    assert.equal(own.spillLimitBytes, GiB);
    assert.equal(await setting(own), "1.0 GiB");
    free = 2 * GiB + 2 ** 20;   // a move under 1 % is none
    await own.keepSpillCeiling();
    assert.equal(own.spillLimitBytes, GiB);
    assert.deepEqual(lines.filter((l) => /ceiling/.test(l)), []);
    // a connection that failed is said, and asked for again, never kept as the answer
    const fresh = await DuckStore.open(path.join(dir, "spill-lane.db"), (l) => lines.push(l), { memoryLimit: "64MiB", diskFree: () => free });
    try {
      const executor = (fresh as unknown as { executor: { connect(): Promise<unknown> } }).executor;
      const connect = executor.connect.bind(executor);
      executor.connect = () => Promise.reject(new Error("no connection"));
      free = 4 * GiB;
      await fresh.keepSpillCeiling();
      assert.ok(lines.some((l) => /ceiling was not moved: no connection/.test(l)));
      executor.connect = connect;
      await fresh.keepSpillCeiling();
      assert.equal(fresh.spillLimitBytes, 2 * GiB);
    } finally { await fresh.close(); }
  } finally { await own.close(); }
  await own.keepSpillCeiling();   // closed: nothing to move, and no failure
  const set = await DuckStore.open(path.join(dir, "spill-set.db"), () => undefined, { memoryLimit: "64MiB", spillLimit: "1GiB", diskFree: () => 8 * GiB });
  try { assert.equal(await setting(set), "1.0 GiB"); } finally { await set.close(); }
  await assert.rejects(DuckStore.open(path.join(dir, "bad-spill.db"), () => undefined, { spillLimit: "lots" }), /MASON_SPILL_LIMIT="lots" is not an amount of disk: write it as 40GB or 512MiB/);
});

test("past what may spill is 53400 and a full disk 53100, each with the way out, naming no engine and no path", () => {
  for (const [text, code, message] of [
    ["Out of Memory Error: failed to offload data block of size 256.0 KiB (95.1 MiB/95.3 MiB used).\nThis limit was set by the 'max_temp_directory_size' setting.", "53400", /more room on disk than statements may take/],
    ['IO Error: Could not write file "/data/.mason/duck.db.tmp/duckdb_temp_1.tmp": No space left on device', "53100", /No space left on device/],
  ] as const) {
    const e = pgErrorOf(new Error(text), "SELECT 1");
    assert.equal(e.fields.code, code);
    assert.equal(e.gap, "spill-limit");
    assert.match(e.fields.message, message);
    assert.match(e.fields.hint ?? "", /MASON_SPILL_LIMIT/);
    assert.doesNotMatch(JSON.stringify(e.fields), /duckdb|duck\.db|max_temp|\/data|the engine/i);
  }
  assert.equal(pgErrorOf(new Error("Out of Memory Error: could not allocate block of size 256 KiB"), "SELECT 1").fields.code, "53200", "memory stays memory");
  // a commit that could not pin a block is the limit too (issue 96, measured on DuckDB 2.0.0); another commit failure is not
  assert.equal(pgErrorOf(new Error("TransactionContext Error: Failed to commit: failed to pin block of size 1.0 MiB (365.7 MiB/366.2 MiB used)"), "COMMIT").fields.code, "53200");
  // every sentence the engine's buffer manager says the limit in, at a commit as in a statement (issue 829: a chunk's
  // commit said "could not allocate block", read as XX000, and failed the first sync instead of reading on smaller)
  for (const said of ["could not allocate block of size 1.9 KiB (734.2 MiB/732.4 MiB used)", "failed to allocate data of size 4.0 MiB (127.9 MiB/128.0 MiB used)",
    "failed to pin block of size 256.0 KiB (122.0 MiB/122.0 MiB used)", "failed to reserve memory data of size 1.0 MiB (127.5 MiB/128.0 MiB used)"]) {
    assert.equal(pgErrorOf(new Error(`TransactionContext Error: Failed to commit: ${said}\n\nPossible solutions:\n* Reducing the number of threads (SET threads=X)`), "COMMIT").fields.code, "53200", said);
    assert.equal(pgErrorOf(new Error(`Out of Memory Error: ${said}`), "SELECT 1").fields.code, "53200", said);
  }
  // a commit's other failure that merely mentions a size is not the limit
  assert.equal(pgErrorOf(new Error("TransactionContext Error: Failed to commit: could not allocate block of size 1.9 KiB"), "COMMIT").fields.code, "XX000");
  assert.equal(pgErrorOf(new Error("TransactionContext Error: Failed to commit: PRIMARY KEY or UNIQUE constraint violation"), "COMMIT").fields.code, "XX000");
  assert.equal(pgErrorOf(new Error("TransactionContext Error: Current transaction is aborted (please ROLLBACK)"), "COMMIT").fields.code, "XX000");
  // a statement's literal holding the engine's words is that statement's error
  assert.equal(pgErrorOf(new Error("Conversion Error: Could not convert string 'max_temp_directory_size' to INT32"), "SELECT 1").fields.code, "22P02");
  assert.equal(pgErrorOf(new Error("Conversion Error: Could not convert string 'This limit was set by the 'max_temp_directory_size' setting' to INT32"), "SELECT 1").fields.code, "22P02");
  assert.equal(pgErrorOf(new Error("Conversion Error: Could not convert string 'No space left on device' to INT32"), "SELECT 1").fields.code, "22P02");
});

test("a statement past what may spill fails alone, 53400, and the session goes on", async () => {
  const memory = String((await store.writer.runAndReadAll("SELECT current_setting('memory_limit')")).getRows()[0]![0]);
  const spill = String((await store.writer.runAndReadAll("SELECT current_setting('max_temp_directory_size')")).getRows()[0]![0]);
  const c = await client();
  try {
    await store.writer.run("SET memory_limit = '40MB'");
    const spills = "SELECT count(*) AS n FROM (SELECT DISTINCT v || repeat('x', 300) AS w FROM big) d";
    assert.equal((await c.query(spills)).rows[0].n, "150000", "with room on disk it completes in 40MB");
    await store.writer.run("SET GLOBAL max_temp_directory_size = '2MiB'");
    // a DISTINCT that spills and answers one row completes in 40MB with room on disk (above), so only the spill's ceiling
    // can stop it. A sorted result of every row (#221) did not fit in 40MB whatever the disk, so which limit the engine
    // said first followed its threads' timing.
    await assert.rejects(c.query(spills),
      (e: pg.DatabaseError) => e.code === "53400" && /room on disk/.test(e.message) && /MASON_SPILL_LIMIT/.test(e.hint ?? "") && !/duckdb|\.tmp/i.test(`${e.message} ${e.detail ?? ""}`));
  } finally {
    await store.writer.run(`SET memory_limit = '${memory.replace(" ", "")}'`);
    await store.writer.run(`SET GLOBAL max_temp_directory_size = '${spill.replace(" ", "")}'`);
  }
  try { assert.equal((await c.query("SELECT count(*) AS n FROM big")).rows[0].n, "150000"); }
  finally { await c.end(); }
});

// a runaway statement must not hold DuckDB for ever: the session's statement_timeout, or Mason's own, the shorter
const SLOW = "SELECT count(*) FROM big a, big b WHERE (a.id::bigint * b.id) % 7 = 3";
test("statement_timeout stops a DuckDB statement: 57014 'due to statement timeout', and the session goes on", async () => {
  const c = await client();
  try {
    // Postgres's units: a bare number is ms
    await c.query("SET statement_timeout = '0.3s'");
    const t = Date.now();
    await assert.rejects(c.query(SLOW), (e: pg.DatabaseError) => e.code === "57014" && e.message === "canceling statement due to statement timeout" && e.hint === undefined);
    assert.ok(Date.now() - t < 5000, `stopped after ${Date.now() - t} ms`);
    assert.equal((await c.query("SELECT count(*) AS n FROM big")).rows[0].n, "150000");
    await c.query("SET statement_timeout = 300");
    await assert.rejects(c.query(SLOW), (e: pg.DatabaseError) => e.code === "57014");
    // 0 is none: the next statement is not timed out by the last setting
    await c.query("SET statement_timeout = 0");
    assert.equal((await c.query("SELECT count(*) AS n FROM big")).rows[0].n, "150000");
  } finally { await c.end(); }
});

test("Mason's own limit (MASON_STATEMENT_TIMEOUT) holds whatever the session sets, and says itself in the hint", async () => {
  const capped = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", statementTimeoutMs: 300,
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema,
    record: () => undefined, log: (l) => (logged.push(l), everLogged.push(l)),
    duck: await store.listener(undefined),
  });
  const c = new pg.Client({ host: "127.0.0.1", port: capped.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  try {
    await c.query("SET statement_timeout = '1h'");
    await assert.rejects(c.query(SLOW), (e: pg.DatabaseError) => e.code === "57014" && /MASON_STATEMENT_TIMEOUT/.test(e.hint ?? ""));
    // a shorter one of the session's is the session's: no hint, as Postgres says it
    await c.query("SET statement_timeout = 100");
    await assert.rejects(c.query(SLOW), (e: pg.DatabaseError) => e.code === "57014" && e.hint === undefined);
    assert.equal((await c.query("SELECT count(*) AS n FROM big")).rows[0].n, "150000");
  } finally { await c.end(); await capped.close(); }
});

test("a BI tool's sorted preview reads only the winners' columns: ORDER BY the key, LIMIT 1000 (Postico's click on a table)", async () => {
  // the plan's SEMI join on row ids is late materialization; DuckDB's default (50 rows) sorted every column of every row
  const plan = async (n: number): Promise<string> => String((await store!.writer.runAndReadAll(`EXPLAIN SELECT id, v FROM public.big ORDER BY id LIMIT ${n}`)).getRows()[0]![1]);
  assert.match(await plan(1000), /Join Type: SEMI/);
  assert.doesNotMatch(await plan(100000), /Join Type: SEMI/, "a bulk read keeps the plain sort");
  // and it answers as Postgres does
  const c = await client();
  try { assert.deepEqual(await answer(c, "SELECT id, v FROM big ORDER BY id DESC LIMIT 1000"), await postgres("SELECT id, v FROM big ORDER BY id DESC LIMIT 1000")); }
  finally { await c.end(); }
});

test("the log holds each statement DuckDB ran whole, past 160 characters (a slow preview's ORDER BY was cut off)", async () => {
  const c = await client();
  try {
    const sql = `SELECT id, ${Array.from({ length: 20 }, (_, i) => `n + ${i} AS c${i}`).join(", ")} FROM ratios ORDER BY id LIMIT 2`;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: 2 row(s)"));
    assert.ok(line !== undefined && line.length > 300, line);
    // to its end: the select list computed after the limit (src/duck/late.ts), the limit inside, the order again outside
    assert.match(line, /ORDER BY id LIMIT 2 \) AS __mason_late ORDER BY __mason_late\.__mason_o1$/);
  } finally { await c.end(); }
});

test("a timestamptz before year 1 is written in UTC as Postgres does, and refused by name in another zone (Mason gap bc-timestamptz-zone)", async () => {
  const c = await client();
  try {
    const sql = "SELECT timestamptz '0044-03-15 12:00:00+00 BC' FROM orders WHERE id = 1";
    assert.deepEqual((await answer(c, sql)).rows, (await postgres(sql)).rows);
    await c.query("SET TimeZone = 'Europe/Rome'");
    await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap bc-timestamptz-zone/.test(`${e.message} ${e.detail ?? ""}`));
  } finally { await c.end(); }
});

// A TIME AS A TIMETZ takes the session zone's offset on the transaction's date, in that zone, at the value's own time
// of day (time_timetz: GetCurrentDateTime, DetermineTimeZoneOffset), never the current instant's (issue 162: on
// 2026-11-01 at 00:31 EDT the oracle's 12:30 was answered -04 where Postgres has -05). The listener's clock is fixed, so
// the answer is the same on every day the test runs; each day mixes two offsets, which one offset for every row (the
// current instant's, whatever it is) never answers. The expected texts are Postgres's rule: a repeated hour's second
// (standard) half, a skipped hour at the offset before the change with its own time kept.
test("a time as a timetz takes the offset of the transaction's date at the value's own time (issue 162)", async () => {
  const c = await client();
  const cases: Array<[string, string, string[]]> = [
    // 00:31 EDT, before the clocks go back at 02:00
    ["2026-11-01T04:31:00Z", "America/New_York", ["00:00:00-04", "01:30:00-05", "02:30:00-05", "12:30:00.5-05", "23:59:00-05", "24:00:00-05"]],
    // 01:00 EST, before they go forward at 02:00 (02:30 does not exist that day)
    ["2026-03-08T06:00:00Z", "America/New_York", ["00:00:00-05", "01:30:00-05", "02:30:00-05", "12:30:00.5-04", "23:59:00-04", "24:00:00-04"]],
    // 20:00 PDT on 31 October: the date is the zone's, not UTC's (Los Angeles goes back at 09:00 UTC on 1 November)
    ["2026-11-01T03:00:00Z", "America/Los_Angeles", ["00:00:00-07", "01:30:00-07", "02:30:00-07", "12:30:00.5-07", "23:59:00-07", "24:00:00-07"]],
    ["2026-11-01T04:31:00Z", "Asia/Kolkata", ["00:00:00+05:30", "01:30:00+05:30", "02:30:00+05:30", "12:30:00.5+05:30", "23:59:00+05:30", "24:00:00+05:30"]],
  ];
  try {
    for (const [now, zone, times] of cases) {
      fixedNow = Date.parse(now) * 1000;
      await c.query(`SET TimeZone = '${zone}'`);
      const what = `at ${now} in ${zone}`;
      assert.deepEqual(await answer(c, "SELECT id, tm::timetz FROM clock_times ORDER BY id"),
        { fields: [["id", 23], ["tm", 1266]], rows: times.map((t, i) => [String(i + 1), t]) }, what);
      assert.deepEqual((await answer(c, "SELECT id, CAST(tm AS time with time zone) FROM clock_times WHERE id = 4")).rows, [["4", times[3]]], what);
      // the function's spelling, time_timetz called by name (function 2047), is the cast
      assert.deepEqual((await answer(c, "SELECT id, timetz(tm) FROM clock_times ORDER BY id")).rows, times.map((t, i) => [String(i + 1), t]), `timetz(tm) ${what}`);
      // a time[] as a timetz[]: each element by the same rule, a NULL element kept
      assert.deepEqual((await answer(c, "SELECT ARRAY[tm]::timetz[], ARRAY[tm, NULL]::timetz[] FROM clock_times WHERE id = 4")).rows, [[`{${times[3]}}`, `{${times[3]},NULL}`]], `an array ${what}`);
    }
    // 24:00 is its own time, never the next midnight's 00:00: in New York on 2026-11-01 beside 00:00, and in Kolkata (one
    // offset all day) not equal to it
    fixedNow = Date.parse("2026-11-01T04:31:00Z") * 1000;
    await c.query("SET TimeZone = 'America/New_York'");
    assert.deepEqual((await answer(c, "SELECT tm::timetz FROM clock_times WHERE id IN (1, 6) ORDER BY id")).rows, [["00:00:00-04"], ["24:00:00-05"]]);
    await c.query("SET TimeZone = 'Asia/Kolkata'");
    assert.deepEqual((await answer(c, "SELECT a.tm::timetz = b.tm::timetz FROM clock_times a, clock_times b WHERE a.id = 6 AND b.id = 1")).rows, [["f"]]);
    // a time[] VALUE as a timetz[] is refused by name until the oracle verifies it (the rewrite maps each element by the
    // same rule, for when it does)
    await assert.rejects(c.query("SELECT a::timetz[] FROM (SELECT array_agg(tm ORDER BY id) AS a FROM clock_times) s"),
      (e: Error & { code?: string; detail?: string }) => e.code === "0A000" && e.detail === "Mason gap unverified: cast:1183>1270");
    // planned once (at its Parse, in Kolkata) and executed under a later SET TimeZone and clock: the execution's date and zone
    const prepared = { name: "tm_timetz", text: "SELECT tm::timetz FROM clock_times WHERE id = $1", values: [4], rowMode: "array", types: raw } as pg.QueryConfig;
    assert.deepEqual((await c.query(prepared)).rows, [["12:30:00.5+05:30"]]);
    fixedNow = Date.parse("2026-03-08T06:00:00Z") * 1000;
    await c.query("SET TimeZone = 'America/New_York'");
    assert.deepEqual((await c.query(prepared)).rows, [["12:30:00.5-04"]], "a prepared statement executed after a SET TimeZone");
  } finally {
    fixedNow = undefined;
    await c.query("SET TimeZone = 'UTC'");
    await c.end();
  }
});

// A TIME BESIDE A TIMETZ is cast as Postgres casts it implicitly (time_timetz, function 2047, COERCE_IMPLICIT_CAST),
// which the raw tree does not show: an operator's operand, a COALESCE's, a CASE's arm, a set operation's column. Its
// value is the explicit cast's (issue 162's rule), sent as the SAME SQL, one path: before issue 167 a comparison ignored
// the offset (12:30:00.5 equal to both 12:30:00.5-04 and -05), a union's column answered as a time (1083), and a CASE
// or a `<` failed with the engine's error on mixing the two.
test("a time beside a timetz is cast as Postgres casts it, by the explicit cast's own rule (issue 167)", async () => {
  const c = await client();
  const sent = (from: number): string => logged.slice(from).findLast((l) => l.startsWith("statement: "))?.replace(/^statement: [^—]*— /, "") ?? "";
  const sentOf = async (sql: string): Promise<string> => { const from = logged.length; await c.query(sql); return sent(from); };
  // the offset timeAsTimetz writes (src/duck/rewrite.ts), once a cast
  const casts = (duck: string): number => duck.split("%s%02d:%02d:%02d").length - 1;
  const cases: Array<[string, string, string[]]> = [
    ["2026-11-01T04:31:00Z", "America/New_York", ["00:00:00-04", "01:30:00-05", "02:30:00-05", "12:30:00.5-05", "23:59:00-05", "24:00:00-05"]],
    ["2026-03-08T06:00:00Z", "America/New_York", ["00:00:00-05", "01:30:00-05", "02:30:00-05", "12:30:00.5-04", "23:59:00-04", "24:00:00-04"]],
    ["2026-11-01T04:31:00Z", "Asia/Kolkata", ["00:00:00+05:30", "01:30:00+05:30", "02:30:00+05:30", "12:30:00.5+05:30", "23:59:00+05:30", "24:00:00+05:30"]],
  ];
  try {
    for (const [now, zone, times] of cases) {
      fixedNow = Date.parse(now) * 1000;
      await c.query(`SET TimeZone = '${zone}'`);
      const what = `at ${now} in ${zone}`;
      const rows = times.map((t, i) => [String(i + 1), t]);
      // a COALESCE's argument, row for row the explicit cast's, 24:00 kept
      assert.deepEqual(await answer(c, "SELECT id, COALESCE(NULL::timetz, tm) FROM clock_times ORDER BY id"), { fields: [["id", 23], ["coalesce", 1266]], rows }, what);
      assert.deepEqual(await answer(c, "SELECT id, CASE WHEN id > 3 THEN tm::timetz ELSE tm END AS x FROM clock_times ORDER BY id"), { fields: [["id", 23], ["x", 1266]], rows }, `a CASE ${what}`);
      // an operator's operand: the offset compared, one of -04 and -05 equal on each day, never both
      for (const offset of ["-05", "-04", "+05:30"]) {
        const sql = `SELECT id FROM clock_times WHERE tm = '12:30:00.5${offset}'::timetz ORDER BY id`;
        assert.deepEqual((await answer(c, sql)).rows, times[3]!.endsWith(offset) ? [["4"]] : [], `${sql} ${what}`);
      }
      // (a timetz is ordered by its instant: its time less its offset, 03:00:00-05 at 08:00 UTC)
      const utc = (t: string): number => { const [, h, m, s, sign, oh, om] = /^(\d+):(\d+):([\d.]+)([+-])(\d+)(?::(\d+))?$/.exec(t)!; return Number(h) * 3600 + Number(m) * 60 + Number(s) - (sign === "+" ? 1 : -1) * (Number(oh) * 3600 + Number(om ?? 0) * 60); };
      assert.deepEqual((await answer(c, "SELECT id FROM clock_times WHERE tm < '03:00:00-05'::timetz ORDER BY id")).rows,
        times.flatMap((t, i) => utc(t) < 8 * 3600 ? [[String(i + 1)]] : []), `< ${what}`);
      // a set operation's column: a timetz (1266), each time arm cast, whichever comes first
      assert.deepEqual(await answer(c, "SELECT tm FROM clock_times WHERE id IN (1, 4) UNION ALL SELECT NULL::timetz ORDER BY 1"),
        { fields: [["tm", 1266]], rows: [[times[0]], [times[3]], [null]] }, `a union ${what}`);
      assert.deepEqual((await answer(c, "SELECT NULL::timetz AS x UNION ALL SELECT tm FROM clock_times WHERE id = 6 ORDER BY 1")).rows, [[times[5]], [null]], `a union, the timetz arm first ${what}`);
      // the value of a CASE whose every WHEN is a timetz
      assert.deepEqual((await answer(c, "SELECT id, CASE tm WHEN '12:30:00.5-05'::timetz THEN 'a' WHEN '12:30:00.5-04'::timetz THEN 'b' END FROM clock_times WHERE id = 4")).rows,
        [["4", times[3]!.endsWith("-05") ? "a" : times[3]!.endsWith("-04") ? "b" : null]], `CASE tm WHEN ${what}`);
    }
    // GREATEST and LEAST of a timetz by its instant, as `<` orders it (the engine's own put 23:59:59-05, at 04:59:59 UTC
    // the next day, below 23:59:59.999999+05:30), a NULL skipped
    assert.deepEqual((await answer(c, "SELECT GREATEST('23:59:59-05'::timetz, NULL, '23:59:59.999999+05:30'::timetz), LEAST(tm, '23:59:59-05'::timetz) FROM clock_times WHERE id = 6")).rows,
      [["23:59:59-05", "24:00:00+05:30"]]);
    // ONE PATH: the implicit cast sends the SQL the explicit one sends
    assert.equal(await sentOf("SELECT id FROM clock_times WHERE tm = '12:30:00.5-05'::timetz ORDER BY id"), await sentOf("SELECT id FROM clock_times WHERE tm::timetz = '12:30:00.5-05'::timetz ORDER BY id"));
    assert.equal(await sentOf("SELECT id, COALESCE(NULL::timetz, tm) FROM clock_times ORDER BY id"), await sentOf("SELECT id, COALESCE(NULL::timetz, tm::timetz) FROM clock_times ORDER BY id"));
    // an explicit cast once each, never twice, and nothing where no time meets a timetz
    assert.equal(casts(await sentOf("SELECT id, tm::timetz, timetz(tm), CAST(tm AS time with time zone) FROM clock_times ORDER BY id")), 3);
    assert.equal(casts(await sentOf("SELECT id, COALESCE(tm::timetz, NULL::timetz) FROM clock_times ORDER BY id")), 1);
    assert.equal(casts(await sentOf("SELECT id, tm < '12:00'::time, COALESCE(tm, '00:00'::time) FROM clock_times WHERE tm = '12:30:00.5' ORDER BY id")), 0);
    assert.deepEqual((await answer(c, "SELECT tm FROM clock_times UNION ALL SELECT tm FROM clock_times ORDER BY 1 LIMIT 1")).fields, [["tm", 1083]]);
    // an arm Mason cannot write (a `*`) is refused by name, never the engine's own unifying of the two
    await assert.rejects(c.query("SELECT * FROM (SELECT tm FROM clock_times) s UNION ALL SELECT NULL::timetz"),
      (e: Error & { code?: string; detail?: string }) => e.code === "0A000" && /Mason gap time-timetz-coerced/.test(`${e.message} ${e.detail ?? ""}`));
  } finally {
    fixedNow = undefined;
    await c.query("SET TimeZone = 'UTC'");
    await c.end();
  }
});

// DATE_TRUNC OF A TIMESTAMPTZ IS THE INSTANT'S OWN ARITHMETIC where that is Postgres's answer (src/duck/rewrite.ts
// truncInstant): DuckDB's date_trunc of a TIMESTAMPTZ is ICU's calendar, ~45 ns a row a thread even in UTC (a BI tool's
// monthly histogram over 197 M rows took 7.9 s on the test server), and its sub-day parts in another zone re-read the
// wall clock, so an instant in a repeated hour (02:30 CEST on 2026-10-25) was truncated to the OTHER 02:00 (+01).
test("date_trunc of a timestamptz is Postgres's in every zone and part, by the instant's arithmetic where that is Postgres's", async () => {
  const c = await client();
  const units = ["microseconds", "milliseconds", "second", "minute", "hour", "day", "week", "month", "quarter", "year", "decade", "century", "millennium"];
  const sent = (from: number): string => logged.slice(from).findLast((l) => l.startsWith("statement: "))?.replace(/^statement: [^—]*— /, "") ?? "";
  const planned = new Map<string, string>();
  try {
    for (const zone of ["UTC", "Europe/Berlin", "America/New_York", "Australia/Lord_Howe", "Asia/Kathmandu"]) {
      await c.query(`SET TimeZone = '${zone}'`);
      await truth.exec(`SET TimeZone = '${zone}'`);
      for (const unit of units) {
        const sql = `SELECT id, date_trunc('${unit}', at) AS t FROM instants ORDER BY id`;
        const from = logged.length;
        assert.deepEqual(await answer(c, sql), await postgres(sql), `${sql} in ${zone}`);
        const duck = sent(from);
        // every part but the microsecond is the instant's arithmetic: a second or less in every zone; a minute and up
        // under a CASE on the zone the statement EXECUTES in (in UTC the arithmetic; elsewhere a minute or an hour
        // with the offset kept, a day and up DuckDB's own truncation), never the zone it was planned in
        if (unit !== "microseconds") assert.match(duck, /make_timestamptz\(/, `${unit} in ${zone}: ${duck}`);
        if (unit === "milliseconds" || unit === "second") assert.doesNotMatch(duck, /date_trunc\(|current_setting\(/, `${unit} in ${zone}: ${duck}`);
        if (!["microseconds", "milliseconds", "second"].includes(unit)) assert.match(duck, /CASE WHEN current_setting\('TimeZone'\) = 'UTC' OR /, `${unit} in ${zone}: ${duck}`);
        // so what is sent names no session zone: one text in every zone
        const first = planned.get(unit);
        if (first === undefined) planned.set(unit, duck); else assert.equal(duck, first, `${unit} in ${zone}`);
      }
      // the three-argument form, in a zone of its own, whatever the session's
      for (const [unit, z] of [["hour", "Europe/Berlin"], ["minute", "Asia/Kathmandu"], ["day", "America/New_York"], ["month", "UTC"], ["century", "Europe/Berlin"], ["week", "utc"]]) {
        const sql = `SELECT id, date_trunc('${unit}', at, '${z}') AS t FROM instants ORDER BY id`;
        assert.deepEqual(await answer(c, sql), await postgres(sql), `${sql} in ${zone}`);
      }
    }
    // the histogram a BI tool sends, grouped and ordered by the truncation
    await c.query("SET TimeZone = 'UTC'");
    await truth.exec("SET TimeZone = 'UTC'");
    const histogram = "SELECT DATE_TRUNC('month', i.at) AS m, count(*) FROM instants i GROUP BY 1 ORDER BY 1 DESC LIMIT 100";
    assert.deepEqual(await answer(c, histogram), await postgres(histogram));
  } finally {
    await truth.exec("SET TimeZone = 'UTC'");
    await c.end();
  }
});

// A prepared statement is planned at its Parse and executed after any later SET TimeZone: the truncation's zone is the
// one each execution runs in (the arithmetic once read the zone of the Parse, so a statement prepared in UTC truncated
// by UTC's days in Berlin).
test("date_trunc of a timestamptz in a prepared statement truncates in the zone it executes in", async () => {
  const c = await client();
  try {
    for (const unit of ["hour", "day", "month", "week"]) {
      const text = `SELECT id, date_trunc('${unit}', at) AS t FROM instants WHERE id > $1 ORDER BY id`;
      const name = `trunc_${unit}`;
      for (const zone of ["UTC", "Europe/Berlin", "America/New_York", "UTC"]) {
        await c.query(`SET TimeZone = '${zone}'`);
        await truth.exec(`SET TimeZone = '${zone}'`);
        const r = await c.query({ name, text, values: [0], rowMode: "array", types: raw } as pg.QueryConfig);
        assert.deepEqual({ fields: r.fields.map((f) => [f.name, f.dataTypeID]), rows: r.rows }, await postgres(text, [0]), `${name} executed in ${zone}`);
      }
    }
  } finally {
    await truth.exec("SET TimeZone = 'UTC'");
    await c.end();
  }
});

// date_trunc(part, timestamptz, zone) is strict and reads its zone before the part: a second or less never needs the
// zone to compute, so the arithmetic once left it out, and a NULL zone (a literal, a row's) answered the instant, a
// row's unknown zone no error (a review finding)
test("date_trunc in a zone of its own is NULL in a NULL zone and reads a row's zone, whatever the part", async () => {
  const c = await client();
  const rowZone = "CASE WHEN id % 3 = 0 THEN NULL WHEN id % 3 = 1 THEN 'Europe/Berlin' ELSE 'asia/kathmandu' END";
  try {
    for (const unit of ["microseconds", "milliseconds", "second", "minute", "hour", "day"]) {
      for (const zone of ["NULL", "NULL::text", rowZone, "'Europe/Berlin'"]) {
        const sql = `SELECT id, date_trunc('${unit}', at, ${zone}) AS t FROM instants ORDER BY id`;
        assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
      }
      // a row's zone Postgres does not know: its error, though the part never needs the zone
      const bad = `SELECT id, date_trunc('${unit}', at, CASE WHEN id = 5 THEN 'Nowhere/Land' ELSE 'UTC' END) FROM instants ORDER BY id`;
      await assert.rejects(c.query(bad), (e: pg.DatabaseError) => e.code === "22023", bad);
      await assert.rejects(postgres(bad), /time zone "Nowhere\/Land" not recognized/);
    }
  } finally { await c.end(); }
});

// A STATEMENT'S LINE IS IN THE LOG BY THE TIME ITS CLIENT HEARS ITS END (src/duck/store.ts `say`): a failed statement that
// calls a Mason function is released only once its calls have stopped, 50 ms and more after its client was told, and its
// line was said at that release: inside the next test's statements, where a test reading "the last statement since
// `from`" took it for its own (CI, on a pull request's head; 1 run in 100 on main under load). Ordered by the worker's
// port, so this reads the log at once, with no wait and no sleep: without the order the line is not there yet.
test("a failed statement that calls a Mason function is logged before its client is told, once", async () => {
  const c = await client();
  const lines = (from: number): string[] => logged.slice(from).filter((l) => l.startsWith("statement: ") && l.includes("Nowhere/Land"));
  try {
    const from = logged.length;
    const bad = "SELECT id, date_trunc('day', at, CASE WHEN id = 5 THEN 'Nowhere/Land' ELSE 'UTC' END) FROM instants ORDER BY id";
    await assert.rejects(c.query(bad), (e: pg.DatabaseError) => e.code === "22023", bad);
    assert.equal(lines(from).length, 1, `its line is in the log already:\n${logged.slice(from).join("\n")}`);
    // the session's next statement waits for its release: said once, never again there
    await answer(c, "SELECT 1 FROM instants LIMIT 1");
    assert.equal(lines(from).length, 1, `once:\n${logged.slice(from).join("\n")}`);
  } finally { await c.end(); }
});

/** a LEFT lateral whose argument reads an enum and another column (moods): the step, as for two columns of any type */
const ENUM_STEPPED = [
  "SELECT q.id, x FROM moods q LEFT JOIN unnest(ARRAY[q.m::text, q.id::text]) x ON TRUE LIMIT 5",
  "SELECT q.id, k FROM moods q LEFT JOIN jsonb_object_keys(CASE WHEN q.m = 'ok' AND q.id > 0 THEN '{\"a\": 1, \"b\": 2}'::jsonb END) k ON TRUE LIMIT 5",
];

// A LEFT JOIN LATERAL OF A LIST'S ROWS ON TRUE UNDER A LIMIT IS AN INNER LATERAL OF A LIST NEVER EMPTY
// (src/duck/rewrite.ts leftLateral, limitBounds): DuckDB planned the LEFT one as a delimiter join over the whole base
// (a BI tool's "expand the JSON" preview, LIMIT 100 over 22 M rows: 37.9 s), handing its rows back in an order of its
// own, so a LIMIT kept other rows than Postgres's; the INNER one is DuckDB's streaming UNNEST, in the base's order,
// stopping at the LIMIT. Where no LIMIT keeps the first rows (a count, a GROUP BY, a DISTINCT, a window, a whole
// result, a sort by the lateral's own column) every row is read either way, and the delimiter join calls the function
// once per DISTINCT document where the UNNEST calls it once per row: the count over 20 M rows of 2,000 documents took
// 62.5 s streamed, 2.2 s joined (docs/DESIGN.md "A LEFT lateral of a list"), so DuckDB's own plan is kept there.
test("a LEFT JOIN LATERAL of json rows ON TRUE is Postgres's rows; under a LIMIT, in Postgres's order and streamed", async () => {
  const c = await client();
  const sent = (from: number): string => logged.slice(from).findLast((l) => l.startsWith("statement: "))?.replace(/^statement: [^—]*— /, "") ?? "";
  // documents beside NULL, an empty object and an empty array: the rows a LEFT JOIN keeps once, with NULLs (over a
  // copied table: a statement that reads none is never DuckDB's)
  const few = "(SELECT t.id, CASE t.id WHEN 1 THEN '{\"a\": 1, \"b\": [2]}'::jsonb WHEN 3 THEN '{}'::jsonb WHEN 4 THEN '{\"c\": null}'::jsonb WHEN 5 THEN '[]'::jsonb WHEN 6 THEN '[7, {}]'::jsonb END AS b FROM jdocs t) AS v";
  const objects = "CASE WHEN jsonb_typeof(v.b) = 'object' THEN v.b END", arrays = "CASE WHEN jsonb_typeof(v.b) = 'array' THEN v.b END";
  try {
    const streamed = [
      // the preview, over jsonb and json, guarded to objects as the tool guards it, with and without an OFFSET
      "SELECT q.*, d.key, d.value FROM (SELECT t.id, t.b FROM jdocs t) AS q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b ELSE NULL END) d ON TRUE LIMIT 6 OFFSET 0",
      "SELECT q.*, d.key, d.value FROM (SELECT t.id, t.b FROM jdocs t) AS q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b ELSE NULL END) d ON TRUE LIMIT 9 OFFSET 11",
      "SELECT q.*, d.key, d.value FROM (SELECT t.id, t.j FROM jdocs t) AS q LEFT JOIN json_each(CASE WHEN substring(ltrim(q.j::text), 1, 1) = '{' THEN q.j::json ELSE NULL END) d ON TRUE LIMIT 7 OFFSET 2",
      "SELECT t.id, e FROM jdocs t LEFT JOIN jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.b) = 'array' THEN t.b END) AS e ON TRUE LIMIT 4 OFFSET 3",
      "SELECT t.id, k FROM jdocs t LEFT JOIN jsonb_object_keys(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) AS k ON TRUE WHERE t.id > 1 LIMIT 5",
      "SELECT o.id, u FROM orders o LEFT JOIN unnest(o.tags) u ON TRUE LIMIT 3",
      // an unnest of an EXPRESSION, its list computed once (by a step of its own before the lateral; inside it, a
      // list_transform's one element, where it reads an array — DuckDB plans such a step as its delimiter join — or a
      // `*` or a join's name reads the join): Postgres's first rows, (1,1) before (1,10) — DuckDB's delimiter join had
      // (1,10) first; NULL and empty arrays one row each; a text split, an array of a json's values; an array column's
      // list changed; two in one FROM; read by a `*` and by a join's name
      "SELECT o.id, x FROM orders o LEFT JOIN LATERAL unnest(ARRAY[o.id, o.id * 10]) x ON true LIMIT 1",
      "SELECT o.id, t FROM orders o LEFT JOIN unnest(array_append(o.tags, 'z')) AS t ON TRUE LIMIT 4",
      "SELECT o.id, t FROM orders o LEFT JOIN unnest(o.tags[2:]) AS t ON TRUE LIMIT 4",
      "SELECT o.id, x FROM orders o LEFT JOIN LATERAL unnest(ARRAY[o.id, o.id * 10]) x ON true LIMIT 3",
      "SELECT o.id, x FROM orders o LEFT JOIN unnest(CASE o.id WHEN 2 THEN NULL::bigint[] WHEN 3 THEN ARRAY[]::bigint[] ELSE ARRAY[o.id + 1, o.id] END) AS x ON TRUE LIMIT 5",
      "SELECT o.id, p FROM orders o LEFT JOIN unnest(string_to_array(o.status, 'a')) AS p ON TRUE LIMIT 4",
      "SELECT o.id, v FROM orders o LEFT JOIN unnest(ARRAY[o.meta ->> 'k', o.meta #>> '{k}', o.tags[1]]) AS v ON TRUE LIMIT 5",
      "SELECT o.id, x, y FROM orders o LEFT JOIN unnest(ARRAY[o.id, -o.id]) x ON TRUE LEFT JOIN unnest(string_to_array(o.status, 'a')) y ON TRUE LIMIT 7",
      "SELECT * FROM orders o LEFT JOIN unnest(ARRAY[o.id, o.id * 10]) x ON TRUE LIMIT 3",
      "SELECT j.* FROM (orders o LEFT JOIN unnest(ARRAY[o.id, o.id * 10]) x ON TRUE) AS j LIMIT 3",
      // a list that reads TWO columns of the row (DuckDB's delimiter join, the rows in its order, until the argument
      // was computed by a step of its own before the lateral): an unnest, a json document's members, a text split
      "SELECT o.id, x FROM orders o LEFT JOIN unnest(ARRAY[o.id, o.qty::bigint]) x ON TRUE LIMIT 4",
      "SELECT o.id, p FROM orders o LEFT JOIN unnest(string_to_array(o.status || ',' || o.id, ',')) p ON TRUE LIMIT 5",
      "SELECT t.id, d.key, d.value FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN t.id > 1 AND jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE LIMIT 6",
      "SELECT t.id, e FROM jdocs t LEFT JOIN jsonb_array_elements_text(CASE WHEN t.id % 2 = 1 AND jsonb_typeof(t.b -> 'arr') = 'array' THEN t.b -> 'arr' END) e ON TRUE LIMIT 6",
      // two columns and an array: no step (DuckDB plans that step as a delimiter join), the lateral streams as it is
      "SELECT o.id, t FROM orders o LEFT JOIN unnest(array_append(o.tags, o.status)) t ON TRUE LIMIT 4",
      // an enum beside another column: a column like any other, computed in the step (ENUM_STEPPED)
      ...ENUM_STEPPED,
      // an OFFSET alone keeps Postgres's rows after it too
      "SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE OFFSET 20",
      // the LIMIT outside: a derived table, a CTE, two levels down
      "SELECT * FROM (SELECT t.id, d.key, d.value FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE) AS s LIMIT 5 OFFSET 2",
      "WITH s AS (SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE) SELECT s.key, s.id FROM s LIMIT 6",
      "SELECT x.id FROM (SELECT s.id FROM (SELECT t.id, e FROM jdocs t LEFT JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(t.b) = 'array' THEN t.b END) e ON TRUE) s WHERE s.id > 2) x LIMIT 4",
      "SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE WHERE t.id < 3 UNION ALL SELECT t.id, k FROM jdocs t LEFT JOIN jsonb_object_keys(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) AS k ON TRUE LIMIT 20",
      // a CTE another CTE reads, and a CTE both arms of a UNION ALL read: met by the walk before the SELECT that bounds
      // them (markBounds, a pre-pass)
      "WITH a AS (SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE), b AS (SELECT a.key, a.id FROM a) SELECT * FROM b LIMIT 5 OFFSET 2",
      "WITH s AS (SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE) SELECT s.id, s.key FROM s UNION ALL SELECT s.id, s.key FROM s LIMIT 20 OFFSET 30",
      // an aggregate or a window reading the rows in order, with no ORDER BY of its own: Postgres's order of the members
      "SELECT t.id, string_agg(d.key, ','), array_agg(d.key) FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE GROUP BY t.id ORDER BY t.id",
      "SELECT row_number() OVER () AS r, t.id, d.key FROM jdocs t LEFT JOIN json_each(CASE WHEN substring(ltrim(t.j::text), 1, 1) = '{' THEN t.j::json END) d ON TRUE ORDER BY 1",
      // the nulls idiom on the table's column, folded to that one key before the bound is decided
      "SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE ORDER BY (t.id) IS NULL, t.id DESC, d.key LIMIT 6",
      // ORDER BY a column of the table LIMIT: the top N's filter reaches the table's scan (by name, by ordinal, through a
      // derived table), so the rows reaching the lateral are few
      "SELECT t.id, d.key, d.value FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE ORDER BY t.id DESC, d.key LIMIT 6",
      "SELECT q.id, d.key FROM (SELECT t.id, t.b FROM jdocs t) q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b END) d ON TRUE ORDER BY 1, 2 NULLS FIRST LIMIT 7 OFFSET 1",
      // NULL, an empty object, an empty array: the one row each with NULLs, under a LIMIT
      `SELECT v.id, d.key, d.value::text FROM ${few} LEFT JOIN jsonb_each(${objects}) d ON TRUE LIMIT 5`,
      `SELECT v.id, e::text FROM ${few} LEFT JOIN jsonb_array_elements(${arrays}) e ON TRUE LIMIT 9`,
    ];
    const joined = [
      // no LIMIT: a whole result, sorted or not
      "SELECT t.id, d.key, d.value FROM jdocs t LEFT JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(t.b -> 'o') = 'object' THEN t.b -> 'o' END) AS d ON true",
      "SELECT t.id, e.v FROM jdocs t LEFT JOIN jsonb_array_elements(t.b -> 'arr') AS e(v) ON TRUE ORDER BY t.id DESC, e.v::text",
      "SELECT o.id, tag FROM orders o LEFT JOIN unnest(o.tags) AS tag ON TRUE ORDER BY o.id, tag",
      // counted, over each kind of list
      "SELECT count(*), count(d.key) FROM jdocs q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b END) d ON TRUE",
      "SELECT count(*) FROM (SELECT q.id, d.key, d.value FROM (SELECT t.id, t.j FROM jdocs t) AS q LEFT JOIN json_each(CASE WHEN substring(ltrim(q.j::text), 1, 1) = '{' THEN q.j::json ELSE NULL END) d ON TRUE) sub",
      "SELECT count(*), count(e) FROM (SELECT t.id, e FROM jdocs t LEFT JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(t.b) = 'array' THEN t.b END) e ON TRUE) sub",
      // sorted by the lateral's own column: a top N over every row
      "SELECT q.id, d.key FROM jdocs q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b END) d ON TRUE ORDER BY d.key NULLS FIRST, q.id LIMIT 8",
      // sorted by a table's column Mason sorts by an expression (a jsonb's order key, a citext's lower()): no filter
      // reaches the scan, a top N over every row
      "SELECT q.id, d.key FROM jdocs q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b END) d ON TRUE ORDER BY q.b, q.id, d.key LIMIT 6",
      "SELECT a.id, k FROM accounts a LEFT JOIN jsonb_object_keys(CASE WHEN a.id > 1 THEN '{\"x\": 1, \"y\": 2}'::jsonb END) AS k ON TRUE ORDER BY a.status, a.id, k LIMIT 5",
      // WITH TIES: Mason ranks every row for it
      "SELECT q.id, d.key FROM jdocs q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b END) d ON TRUE ORDER BY q.id DESC, d.key FETCH FIRST 3 ROWS WITH TIES",
      // grouped, distinct, windowed — with a LIMIT above too: each reads every row first
      "SELECT d.key, count(*) FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE GROUP BY 1 ORDER BY 1 NULLS FIRST",
      "SELECT d.key, count(*) FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 3",
      "SELECT DISTINCT d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE ORDER BY 1 NULLS LAST",
      "SELECT DISTINCT t.id FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE ORDER BY 1 LIMIT 4",
      "SELECT t.id, d.key, count(*) OVER (PARTITION BY t.id), row_number() OVER (PARTITION BY t.id ORDER BY d.key) FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE ORDER BY 1, 2 LIMIT 9",
      // NULL, an empty object, an empty array: the one row each with NULLs, whole and counted
      `SELECT v.id, d.key, d.value::text FROM ${few} LEFT JOIN jsonb_each(${objects}) d ON TRUE`,
      `SELECT v.id, count(d.key), count(*) FROM ${few} LEFT JOIN jsonb_each(${objects}) d ON TRUE GROUP BY 1 ORDER BY 1`,
      `SELECT count(*), count(e) FROM ${few} LEFT JOIN jsonb_array_elements(${arrays}) e ON TRUE`,
    ];
    for (const sql of streamed) {
      const from = logged.length;
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
      // an INNER lateral of a list never empty: the last argument of each list's function, or the array's CASE (in a
      // lambda where the join is read whole)
      assert.match(sent(from), /CROSS JOIN LATERAL \( SELECT unnest\((CAST\()?(__mason_json_\w+\(__mason_turn\(getvariable\('__mason_session'\), .*, true\)|CASE WHEN len\(|\(list_transform\(list_value\()/, `${sql}\n${sent(from)}`);
      assert.doesNotMatch(sent(from), /LEFT JOIN/, sql);
    }
    // a whole result without an ORDER BY is the same rows, in an order neither promises (the oracle's set comparison)
    const asSet = (r: { fields: Array<[string, number]>; rows: unknown[][] }): { fields: Array<[string, number]>; rows: unknown[][] } =>
      ({ fields: r.fields, rows: r.rows.map((x) => JSON.stringify(x)).sort().map((x) => JSON.parse(x) as unknown[]) });
    for (const sql of joined) {
      const from = logged.length;
      if (/ORDER BY/.test(sql)) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
      else assert.deepEqual(asSet(await answer(c, sql)), asSet(await postgres(sql)), sql);
      // DuckDB's own LEFT lateral: no list padded with a NULL
      assert.match(sent(from), /LEFT JOIN/, `${sql}\n${sent(from)}`);
      assert.doesNotMatch(sent(from), /CROSS JOIN LATERAL|, true\)( AS JSON\[\])?\)|CASE WHEN len\(/, `${sql}\n${sent(from)}`);
    }
    // the enum's statements: the argument computed by a step of its own before the lateral (rewrite.ts rowReads)
    for (const sql of ENUM_STEPPED) {
      const from = logged.length;
      await answer(c, sql);
      assert.match(sent(from), /AS __mason_arg\d+ \) AS __mason_arg\d+ CROSS JOIN LATERAL/, `${sql}\n${sent(from)}`);
    }
    // DuckDB runs the streamed one as its UNNEST, no delimiter join over the base
    for (const sql of streamed) {
      const plan = (await c.query({ text: `EXPLAIN ${sql}`, rowMode: "array" })).rows.map((r) => String(r[0])).join("\n");
      assert.doesNotMatch(plan, /delim/i, `${sql}\n${plan}`);
      assert.match(plan, /unnest/i, plan);
    }
    // not a document's rows the function refuses (an array to jsonb_each): Postgres's error, whichever row it is
    await assert.rejects(c.query("SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(t.b) d ON TRUE"), (e: pg.DatabaseError) => e.code === "22023");
    await assert.rejects(postgres("SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(t.b) d ON TRUE"), /cannot call jsonb_each on a non-object/);
    // what is not a LEFT … ON TRUE of a list keeps its own plan under a LIMIT too: an INNER lateral (a row with no
    // members has none), a condition
    for (const sql of ["SELECT q.id, d.key FROM jdocs q CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b END) d LIMIT 5",
      "SELECT q.id, d.key FROM jdocs q LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(q.b) = 'object' THEN q.b END) d ON d.key <> 'a' ORDER BY 1, 2 LIMIT 20"]) {
      const from = logged.length;
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
      assert.doesNotMatch(sent(from), /, true\)\)/, `${sql}\n${sent(from)}`);
    }
  } finally { await c.end(); }
});

// A ROW COUNT ON THE WIRE IS A BOUND THE PLAN AT PARSE COULD NOT SEE (src/api/postgres/server.ts boundOnWire): an
// Execute's row count (JDBC's setMaxRows or fetch size) arrives after the Parse, so a LEFT lateral of a list with no LIMIT
// in its SQL was planned as DuckDB's delimiter join — the whole base read before the first row, the first rows in its own
// order (the gap row-limit-on-the-wire, closed). Such a plan says so (PlannedSql.unboundedLateral), and an Execute with a
// row count runs the statement planned again with the bound asserted — once, kept — its portal paged on from the same
// result. Where every row is read anyway (an aggregate, a GROUP BY, an ORDER BY of the lateral's column), or a LIMIT
// already bounds it, nothing is planned again.
test("an Execute's row count over a LEFT lateral streams Postgres's first rows: planned again once, kept, the portal paged on", async () => {
  const duck = await store.listener(undefined, undefined, undefined, () => copies);
  const planned: Array<{ text: string; wire: boolean }> = [];
  /** the search_path and TimeZone each plan made again for a row count was made under */
  const under: string[] = [];
  /** held until the test lets a plan made again for a row count go on */
  let gate: Promise<void> = Promise.resolve();
  let skew = false;
  /** a plan made again for a row count is refused, as Postgres or the rewrite refuses one */
  let failWire = false;
  /** the session connections the listener opened on the copy */
  let opened = 0;
  // a view over the lateral, and the same view as a schema moved since would define it
  const members = (where: string): string => `SELECT t.id, d.key, d.value FROM public.jdocs t LEFT JOIN jsonb_each(CASE WHEN (jsonb_typeof(t.b) = 'object'::text) THEN t.b ELSE NULL::jsonb END) d ON true${where}`;
  const viewing = (where: string): PgSchema => ({ ...schema, views: [...schema.views!, { schema: "public", name: "jdoc_members", definition: ` ${members(where)};` }] });
  let current = viewing("");
  const counted = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => current,
    record: () => undefined, log: (l) => (logged.push(l), everLogged.push(l)),
    duck: { ...duck, open: () => { opened++; return duck.open(); }, plan: async (...a: Parameters<typeof duck.plan>) => {
      planned.push({ text: a[1], wire: a[7] === true });
      if (a[7] === true) { under.push(`${a[5].searchPath} | ${a[5].timeZone}`); await gate; }
      if (a[7] === true && failWire) throw new StatementError({ code: "0A000", message: "refused for the test" }, a[1]);
      const p = await duck.plan(...a);
      // a schema moved between the Parse and the Execute: the plan made again answers another column
      return skew && a[7] === true ? { ...p, fields: p.fields!.map((f, i) => i === 0 ? { ...f, name: "moved" } : f) } : p;
    } },
  });
  // a portal's statement is logged once its result is released, a moment after its last rows
  const sent = async (from: number): Promise<string> => {
    for (let i = 0; i < 200; i++) {
      const line = logged.slice(from).findLast((l) => l.startsWith("statement: "));
      if (line !== undefined) return line.replace(/^statement: [^—]*— /, "");
      await sleep(10);
    }
    return "";
  };
  const text = (m: Extract<BackendMessage, { type: "DataRow" }>): string => JSON.stringify(m.values.map((v) => v === null ? null : v.toString("utf8")));
  const asSet = (rows: string[]): string[] => [...rows].sort();
  const tag = (ms: BackendMessage[]): string | undefined => (ms.find((m) => m.type === "CommandComplete") as Extract<BackendMessage, { type: "CommandComplete" }> | undefined)?.tag;
  const s = await rawSession(counted.port);
  /** a portal of the statement executed `maxRows` at a time to its end: every page's rows, and its tag */
  const paged = async (statement: string, portal: string, maxRows: number): Promise<{ pages: string[][]; tag: string | undefined }> => {
    const pages: string[][] = [];
    s.socket.write(Buffer.concat([wire.bind(portal, statement, [], [0]), wire.execute(portal, maxRows), wire.sync()]));
    for (;;) {
      const ms = await s.untilReady();
      const err = ms.find((m) => m.type === "ErrorResponse");
      if (err !== undefined) throw new Error(JSON.stringify(err));
      pages.push(dataRows(ms).map(text));
      if (ms.some((m) => m.type === "PortalSuspended")) { s.socket.write(Buffer.concat([wire.execute(portal, maxRows), wire.sync()])); continue; }
      // closed, as a driver closes its portal
      s.socket.write(Buffer.concat([wire.close("P", portal), wire.sync()]));
      await s.untilReady();
      return { pages, tag: tag(ms) };
    }
  };
  const truthRows = async (sql: string): Promise<string[]> => (await postgres(sql)).rows.map((r) => JSON.stringify(r));
  try {
    const lateral = "SELECT t.id, d.key, d.value FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE";
    const all = await truthRows(lateral);
    assert.ok(all.length > 15, `${all.length} rows: several pages of 5`);
    s.socket.write(Buffer.concat([wire.parse("lat", lateral), wire.sync()]));
    await s.untilReady();
    assert.deepEqual(planned, [{ text: lateral, wire: false }]);
    // a row count of 5: Postgres's first 5 rows in its order, then the NEXT 5 from the same result, to its end
    let from = logged.length;
    const five = await paged("lat", "p1", 5);
    assert.deepEqual(five.pages[0], all.slice(0, 5));
    assert.deepEqual(five.pages[1], all.slice(5, 10));
    assert.deepEqual(five.pages.flat(), all, "the portal resumed reads on: the whole result, once");
    assert.ok(five.pages.slice(0, -1).every((p) => p.length === 5), five.pages.map((p) => p.length).join(" "));
    assert.equal(five.tag, `SELECT ${all.length}`);
    const streamed = await sent(from);
    assert.match(streamed, /CROSS JOIN LATERAL \( SELECT unnest\(/, streamed);
    assert.doesNotMatch(streamed, /LEFT JOIN/, streamed);
    // planned again ONCE, with the bound
    assert.deepEqual(planned, [{ text: lateral, wire: false }, { text: lateral, wire: true }]);
    // the same statement with no row count: DuckDB's own join, the same rows as a set, nothing planned again
    from = logged.length;
    const whole = await paged("lat", "p2", 0);
    assert.deepEqual(asSet(whole.pages.flat()), asSet(all));
    assert.equal(whole.pages.length, 1);
    const joined = await sent(from);
    assert.match(joined, /LEFT JOIN/, joined);
    assert.doesNotMatch(joined, /CROSS JOIN LATERAL/, joined);
    // and with a row count again, after a later SET: the statement's plan kept (no third plan), Postgres's first rows
    s.socket.write(wire.query("SET TimeZone = 'Europe/Berlin'"));
    await s.untilReady();
    from = logged.length;
    assert.deepEqual((await paged("lat", "p3", 7)).pages[0], all.slice(0, 7));
    assert.match(await sent(from), /CROSS JOIN LATERAL/);
    s.socket.write(wire.query("SET TimeZone = 'UTC'"));
    await s.untilReady();
    // the same text in a statement of its own: both plans from the plans kept
    s.socket.write(Buffer.concat([wire.parse("lat2", lateral), wire.sync()]));
    await s.untilReady();
    assert.deepEqual((await paged("lat2", "p4", 3)).pages.flat(), all);
    assert.deepEqual(asSet((await paged("lat2", "p5", 0)).pages.flat()), asSet(all));
    assert.equal(planned.length, 2, JSON.stringify(planned));

    // the bound passes down as a LIMIT's does: through a derived table, a CTE, a UNION ALL's arms
    for (const sql of [`SELECT q.key, q.id FROM (${lateral}) q`, `WITH w AS (${lateral}) SELECT * FROM w`, `${lateral} UNION ALL ${lateral.replace("t.id", "-t.id")}`]) {
      s.socket.write(Buffer.concat([wire.parse("", sql), wire.sync()]));
      await s.untilReady();
      from = logged.length;
      assert.deepEqual((await paged("", "d", 4)).pages.flat(), await truthRows(sql), sql);
      assert.doesNotMatch(await sent(from), /LEFT JOIN/, sql);
      assert.deepEqual(planned.slice(-2), [{ text: sql, wire: false }, { text: sql, wire: true }], sql);
    }
    // an unnest of an EXPRESSION, by a row count of 1 and of 3: Postgres's first rows, (1,1) before (1,10) — DuckDB's
    // delimiter join answered (1,10) first — its list computed once, by a step of its own before the lateral (or
    // inside it, where it reads an array or a `*` reads the join); NULL and empty arrays one row each; a text split; a
    // json document's members over an argument of two columns
    const once = / AS __mason_arg1 \) AS __mason_arg1 CROSS JOIN LATERAL \( SELECT unnest\(CASE WHEN len\(__mason_arg1\.__mason_arg1\)/;
    const inside = /CROSS JOIN LATERAL \( SELECT unnest\(\(list_transform\(list_value\(/;
    for (const [sql, form] of [
      ["SELECT o.id, x FROM orders o LEFT JOIN LATERAL unnest(ARRAY[o.id, o.id * 10]) x ON true", once],
      ["SELECT o.id, t FROM orders o LEFT JOIN unnest(array_append(o.tags, 'z')) AS t ON TRUE", inside],
      ["SELECT o.id, x FROM orders o LEFT JOIN unnest(CASE o.id WHEN 2 THEN NULL::bigint[] WHEN 3 THEN ARRAY[]::bigint[] ELSE ARRAY[o.id + 1, o.id] END) AS x ON TRUE", once],
      ["SELECT o.id, p FROM orders o LEFT JOIN unnest(string_to_array(o.status || ',' || o.id, ',')) AS p ON TRUE", once],
      ["SELECT * FROM orders o LEFT JOIN unnest(ARRAY[o.id, o.id * 10]) x ON TRUE", inside],
      ["SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN t.id > 1 AND jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE", / AS __mason_arg1 \) AS __mason_arg1 CROSS JOIN LATERAL \( SELECT unnest\(__mason_json_keys\(__mason_turn\(getvariable\('__mason_session'\), __mason_arg1\.__mason_arg1\), __mason_arg1\.__mason_arg1, /],
    ] as const) {
      const want = await truthRows(sql);
      if (sql.startsWith("SELECT o.id, x FROM orders o LEFT JOIN LATERAL")) assert.deepEqual(want.slice(0, 2), ['["1","1"]', '["1","10"]'], "Postgres's own first rows");
      s.socket.write(Buffer.concat([wire.parse("", sql), wire.sync()]));
      await s.untilReady();
      for (const n of [1, 3]) {
        from = logged.length;
        const got = await paged("", "u", n);
        assert.deepEqual(got.pages[0], want.slice(0, n), `${sql}: the first ${n}`);
        assert.deepEqual(got.pages.flat(), want, sql);
        const streamedSql = await sent(from);
        assert.doesNotMatch(streamedSql, /LEFT JOIN/, `${sql}\n${streamedSql}`);
        assert.match(streamedSql, form, `${sql}\n${streamedSql}`);
      }
      assert.deepEqual(planned.slice(-2), [{ text: sql, wire: false }, { text: sql, wire: true }], sql);
    }
    planned.length = 2;

    // a LIMIT in the SQL: planned once, the LIMIT's plan, streamed
    const limited = `${lateral} LIMIT 12`;
    s.socket.write(Buffer.concat([wire.parse("lim", limited), wire.sync()]));
    await s.untilReady();
    from = logged.length;
    const lim = await paged("lim", "p6", 5);
    assert.deepEqual(lim.pages.flat(), all.slice(0, 12));
    assert.match(await sent(from), /CROSS JOIN LATERAL/);
    assert.deepEqual(planned.slice(2), [{ text: limited, wire: false }]);

    // every row read anyway — an aggregate, a GROUP BY, an ORDER BY of the lateral's column, a DISTINCT: not planned
    // again, DuckDB's join kept, Postgres's answer (ordered where the SQL orders it)
    for (const sql of [
      "SELECT count(*), count(d.key) FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE",
      "SELECT d.key, count(*) FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE GROUP BY 1 ORDER BY 1 NULLS FIRST",
      "SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE ORDER BY d.key NULLS FIRST, t.id",
      // ORDER BY a table's column with no LIMIT: DuckDB sorts every row first, whichever plan it is given
      "SELECT t.id, d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE ORDER BY t.id DESC, d.key",
      "SELECT DISTINCT d.key FROM jdocs t LEFT JOIN jsonb_each(CASE WHEN jsonb_typeof(t.b) = 'object' THEN t.b END) d ON TRUE",
    ]) {
      const plannedBefore: number = planned.length;
      s.socket.write(Buffer.concat([wire.parse("", sql), wire.sync()]));
      await s.untilReady();
      from = logged.length;
      const got = (await paged("", "q", 2)).pages.flat();
      const want = await truthRows(sql);
      if (/ORDER BY/.test(sql)) assert.deepEqual(got, want, sql); else assert.deepEqual(asSet(got), asSet(want), sql);
      assert.match(await sent(from), /LEFT JOIN/, sql);
      assert.deepEqual(planned.slice(plannedBefore), [{ text: sql, wire: false }], sql);
    }

    // EXPLAIN through the wire is the statement's own plan, a row count or none
    const explained = async (maxRows: number): Promise<string[]> => {
      s.socket.write(Buffer.concat([wire.parse("", `EXPLAIN ${lateral}`), wire.sync()]));
      await s.untilReady();
      return (await paged("", "x", maxRows)).pages.flat();
    };
    const plain = await explained(0);
    assert.deepEqual(await explained(1), plain);
    // the SQL sent is the join's, and DuckDB plans its delimiter join
    assert.match(plain.join("\n"), /Sent to the engine: .* LEFT JOIN LATERAL [\s\S]*__duckdb_delim_/, plain.join("\n"));
    assert.doesNotMatch(plain.join("\n"), /CROSS JOIN LATERAL/, plain.join("\n"));

    // a search_path moved since the Parse: planned again under the session's state now, and the bounded plan under that
    // same state, never a third (GitHub issue 63)
    const zoned = `${lateral} WHERE t.id > 0`;
    s.socket.write(Buffer.concat([wire.parse("zoned", zoned), wire.sync()]));
    await s.untilReady();
    s.socket.write(wire.query("SET TimeZone = 'Europe/Berlin'; SET search_path = sales, public"));
    await s.untilReady();
    assert.deepEqual((await paged("zoned", "z", 3)).pages.flat(), all);
    assert.equal(under.at(-1), 'sales, public | Europe/Berlin');
    s.socket.write(wire.query("SET TimeZone = 'UTC'; SET search_path = DEFAULT"));
    await s.untilReady();

    // a plan made again that answers other columns than the Parse said (the schema moved) is not run: the Parse's is,
    // kept for the next Execute too
    const moved = `${lateral} WHERE t.id > 1`;
    s.socket.write(Buffer.concat([wire.parse("moved", moved), wire.sync()]));
    await s.untilReady();
    skew = true;
    from = logged.length;
    const movedRows = (await paged("moved", "m", 4)).pages.flat();
    skew = false;
    const movedAll = await truthRows(moved);
    assert.deepEqual(asSet(movedRows), asSet(movedAll));
    assert.match(await sent(from), /LEFT JOIN/);
    assert.ok(logged.slice(from).some((l) => /answers other columns than its Parse said/.test(l)), logged.slice(from).join("\n"));
    const plans = planned.length;
    assert.deepEqual(asSet((await paged("moved", "m2", 4)).pages.flat()), asSet(movedAll));
    assert.equal(planned.length, plans, "the Parse's plan kept: nothing planned again");

    // a CancelRequest landing while the statement is planned again is answered: 57014, and the session goes on
    const cancelled = `${lateral} WHERE t.id > 2`;
    s.socket.write(Buffer.concat([wire.parse("cancelled", cancelled), wire.sync()]));
    await s.untilReady();
    let release = (): void => undefined;
    gate = new Promise<void>((r) => { release = r; });
    const replans = under.length;
    s.socket.write(Buffer.concat([wire.bind("k", "cancelled", [], [0]), wire.execute("k", 5), wire.sync()]));
    for (let i = 0; i < 500 && under.length === replans; i++) await sleep(10);
    assert.equal(under.length, replans + 1, "planned again");
    const cancel = net.connect(counted.port, "127.0.0.1");
    await new Promise<void>((r) => cancel.once("connect", () => r()));
    cancel.end(wire.cancelRequest(s.pid, s.secret));
    await sleep(100);
    release();
    gate = Promise.resolve();
    const refused = (await s.untilReady()).find((m) => m.type === "ErrorResponse") as Extract<BackendMessage, { type: "ErrorResponse" }> | undefined;
    assert.deepEqual([refused?.fields.C, refused?.fields.M], ["57014", "canceling statement due to user request"]);
    s.socket.write(Buffer.concat([wire.close("P", "k"), wire.sync()]));
    await s.untilReady();

    // Mason gap limit-lateral-filter, by a row count on the wire: under a filter above the join that DuckDB does not
    // push down, it plans the streamed lateral as its delimiter join again, its rows in an order of its own — the same
    // rows, as a set
    const filtered = `${lateral} WHERE d.key <> 'n'`;
    s.socket.write(Buffer.concat([wire.parse("filtered", filtered), wire.sync()]));
    await s.untilReady();
    from = logged.length;
    assert.deepEqual(asSet((await paged("filtered", "f", 4)).pages.flat()), asSet(await truthRows(filtered)));
    assert.match(await sent(from), /CROSS JOIN LATERAL/);
    assert.deepEqual(planned.slice(-2), [{ text: filtered, wire: false }, { text: filtered, wire: true }]);

    // a plan made again that is refused: said in the log, and the Parse's plan runs, kept for the next Execute
    const refusing = `${lateral} WHERE t.id > 4`;
    s.socket.write(Buffer.concat([wire.parse("refusing", refusing), wire.sync()]));
    await s.untilReady();
    failWire = true;
    from = logged.length;
    const refusingRows = (await paged("refusing", "r", 4)).pages.flat();
    failWire = false;
    const refusingAll = await truthRows(refusing);
    assert.deepEqual(asSet(refusingRows), asSet(refusingAll));
    assert.match(await sent(from), /LEFT JOIN/);
    assert.ok(logged.slice(from).some((l) => /planned again for an Execute's row count was refused \(0A000: refused for the test\)/.test(l)), logged.slice(from).join("\n"));
    const refusedPlans = planned.length;
    assert.deepEqual(asSet((await paged("refusing", "r2", 4)).pages.flat()), asSet(refusingAll));
    assert.equal(planned.length, refusedPlans, "the Parse's plan kept: nothing planned again");

    // a view over the lateral: planned again, the bound reaching into its definition, Postgres's first rows in order
    const viewed = "SELECT * FROM jdoc_members";
    s.socket.write(Buffer.concat([wire.parse("viewed", viewed), wire.sync()]));
    await s.untilReady();
    from = logged.length;
    assert.deepEqual((await paged("viewed", "v", 4)).pages.flat(), await truthRows(members("")));
    assert.match(await sent(from), /CROSS JOIN LATERAL/);
    assert.deepEqual(planned.slice(-2), [{ text: viewed, wire: false }, { text: viewed, wire: true }]);

    // the schema moves between the Parse and the first Execute with a row count: the plan made again is made over the
    // new schema's catalog (the view's new definition), never the Parse's catalog kept under the new schema
    const moving = "SELECT * FROM jdoc_members WHERE id > 0";
    s.socket.write(Buffer.concat([wire.parse("moving", moving), wire.sync()]));
    await s.untilReady();
    current = viewing(" WHERE t.id > 3");
    from = logged.length;
    assert.deepEqual((await paged("moving", "mv", 3)).pages.flat(), await truthRows(`SELECT * FROM (${members(" WHERE t.id > 3")}) v WHERE id > 0`));
    assert.match(await sent(from), /CROSS JOIN LATERAL/);
    assert.deepEqual(planned.slice(-2), [{ text: moving, wire: false }, { text: moving, wire: true }]);

    // the session closing while its statement is planned again: it runs nothing, no connection opened for it
    const leaving = await rawSession(counted.port);
    const closing = `${lateral} WHERE t.id > 5`;
    leaving.socket.write(Buffer.concat([wire.parse("closing", closing), wire.sync()]));
    await leaving.untilReady();
    gate = new Promise<void>((r) => { release = r; });
    const replansBefore = under.length, opens = opened;
    leaving.socket.write(Buffer.concat([wire.bind("c", "closing", [], [0]), wire.execute("c", 5), wire.sync()]));
    for (let i = 0; i < 500 && under.length === replansBefore; i++) await sleep(10);
    assert.equal(under.length, replansBefore + 1, "planned again");
    from = logged.length;
    leaving.end();
    for (let i = 0; i < 500 && !logged.slice(from).some((l) => /closed: closed by the client/.test(l)); i++) await sleep(10);
    release();
    gate = Promise.resolve();
    for (let i = 0; i < 500 && !logged.slice(from).some((l) => /closed while its statement was planned again/.test(l)); i++) await sleep(10);
    assert.ok(logged.slice(from).some((l) => /closed while its statement was planned again/.test(l)), logged.slice(from).join("\n"));
    assert.equal(opened, opens, "no connection opened for a session gone");

    // statement_timeout stops the statement planned again as any other: 57014, and the session goes on
    const slow = "SELECT a.id, d.key FROM late a CROSS JOIN late b LEFT JOIN jsonb_each(a.j) d ON TRUE WHERE d.value::text || (b.j ->> 'n') = 'never'";
    s.socket.write(wire.query("SET statement_timeout = 300"));
    await s.untilReady();
    const t0 = Date.now();
    s.socket.write(Buffer.concat([wire.parse("", slow), wire.bind("", "", [], [0]), wire.execute("", 5), wire.sync()]));
    const err = (await s.untilReady()).find((m) => m.type === "ErrorResponse") as Extract<BackendMessage, { type: "ErrorResponse" }> | undefined;
    assert.equal(err?.fields.C, "57014", JSON.stringify(err));
    assert.equal(err?.fields.M, "canceling statement due to statement timeout");
    assert.ok(Date.now() - t0 < 5000, `stopped after ${Date.now() - t0} ms`);
    assert.deepEqual(planned.slice(-2), [{ text: slow, wire: false }, { text: slow, wire: true }]);
    s.socket.write(wire.query("SET statement_timeout = 0"));
    await s.untilReady();
    assert.deepEqual((await paged("lat", "p7", 4)).pages[0], all.slice(0, 4), "the session goes on");
  } finally { s.end(); await counted.close(); }
});

// THE NULLS-PLACEMENT IDIOM IS ONE KEY (src/duck/rewrite.ts nullsKeyFolded): `ORDER BY (x) IS NULL ASC, x DESC` is
// `x DESC NULLS LAST`; with the expression first DuckDB's top N read and heaped every row of a 197 M-row copy (6.4 s by
// a timestamp), where one key with its nulls placed lets the scan skip what cannot be in the page.
test("ORDER BY x IS [NOT] NULL, x is one key with its nulls placed, as Postgres orders it", async () => {
  const c = await client();
  const sent = (from: number): string => logged.slice(from).findLast((l) => l.startsWith("statement: "))?.replace(/^statement: [^—]*— /, "") ?? "";
  try {
    const folded: Array<[string, RegExp]> = [];
    for (const col of ["ts", "t", "n"]) {
      for (const [test, dir, nulls] of [["IS NULL", "ASC", "LAST"], ["IS NULL", "DESC", "FIRST"], ["IS NOT NULL", "ASC", "FIRST"], ["IS NOT NULL", "DESC", "LAST"]] as const) {
        for (const second of ["DESC", "ASC", ""]) {
          const want = new RegExp(`ORDER BY (e\\.)?${col}${second === "DESC" ? " DESC" : second === "ASC" ? " ASC" : ""} NULLS ${nulls}`);
          folded.push([`SELECT e.id, e.${col} FROM nullish e ORDER BY (e.${col}) ${test} ${dir}, e.${col} ${second}, e.id LIMIT 5 OFFSET 0`, want]);
          folded.push([`SELECT e.id FROM nullish e ORDER BY e.${col} ${test} ${dir}, e.${col} ${second}, e.id`, want]);
        }
      }
      // a key before the pair and one after it stay where they are
      folded.push([`SELECT e.id, e.${col} FROM nullish e ORDER BY e.id % 2, (e.${col}) IS NULL, e.${col} DESC, e.id LIMIT 6`, new RegExp(`ORDER BY e\\.id % 2, e\\.${col} DESC NULLS LAST, e\\.id`)]);
    }
    for (const [sql, want] of folded) {
      const from = logged.length;
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
      assert.match(sent(from), want, `${sql}\n${sent(from)}`);
      assert.doesNotMatch(sent(from), /IS (NOT )?NULL/, `${sql}\n${sent(from)}`);
    }
    // what is not the idiom keeps both keys: another column second, the test alone, under a DISTINCT ON
    for (const sql of ["SELECT e.id FROM nullish e ORDER BY e.ts IS NULL, e.t DESC, e.id", "SELECT e.id FROM nullish e ORDER BY e.ts IS NULL, e.id",
      "SELECT DISTINCT ON (e.ts IS NULL, e.ts) e.id, e.ts FROM nullish e ORDER BY e.ts IS NULL, e.ts, e.id"]) {
      const from = logged.length;
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
      assert.match(sent(from), /ORDER BY e\.ts IS NULL/, `${sql}\n${sent(from)}`);
    }
  } finally { await c.end(); }
});

// json(b)_array_elements(_text)'s column is its OUT parameter's, `value`, under a FROM name too, and the FROM name
// alone is the element (a function of one column that is no row is read whole as that column): Mason named the
// column by the FROM name, so `e.value` was NULL or an error, in the INNER form and the LEFT one alike
test("jsonb_array_elements' column is value under a FROM name, and the FROM name alone is the element", async () => {
  const c = await client();
  const arrays = "CASE WHEN jsonb_typeof(t.b) = 'array' THEN t.b END";
  // the rows as a set: a json text's order is the collation's, which is not what is tested here
  const sorted = (r: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ fields: r.fields, rows: r.rows.map((x) => JSON.stringify(x)).sort() });
  try {
    for (const fn of ["jsonb_array_elements", "jsonb_array_elements_text"]) {
      for (const join of ["JOIN", "LEFT JOIN"]) {
        for (const sql of [
          `SELECT t.id, e.value FROM jdocs t ${join} ${fn}(${arrays}) e ON TRUE`,
          `SELECT t.id, e FROM jdocs t ${join} ${fn}(${arrays}) e ON TRUE`,
          `SELECT t.id, e::text, e IS NULL FROM jdocs t ${join} ${fn}(${arrays}) AS e ON TRUE`,
          `SELECT t.id, e, e.v FROM jdocs t ${join} ${fn}(${arrays}) AS e(v) ON TRUE`,
          `SELECT t.id, value FROM jdocs t ${join} ${fn}(${arrays}) ON TRUE`,
          `SELECT t.id, ${fn}, ${fn}.value FROM jdocs t ${join} ${fn}(${arrays}) ON TRUE`,
        ]) assert.deepEqual(sorted(await answer(c, sql)), sorted(await postgres(sql)), sql);
      }
    }
    // the comma form, the element counted and compared by the FROM name alone
    const comma = `SELECT count(e), count(e.value), count(*) FILTER (WHERE e.value ->> 0 IS NULL), max(e #>> '{}') FROM jdocs t, jsonb_array_elements(${arrays}) e`;
    assert.deepEqual(await answer(c, comma), await postgres(comma), comma);
  } finally { await c.end(); }
});

// A BARE ORDER BY KEY IS READ BY ANOTHER RULE THAN THE SAME TREE INSIDE THE TEST (findTargetlistEntrySQL92): an integer
// is an output position and a one-part name an output column's, where inside `x IS NULL` each is the constant or the
// input column. So the pair is folded only where both read alike (a review finding: `SELECT coalesce(n, 0) AS n …
// ORDER BY n IS NULL, n` was sorted by the coalesce with its NULLs placed).
test("ORDER BY x IS NULL, x is not one key where the bare x is an output column or a position", async () => {
  const c = await client();
  const sent = (from: number): string => logged.slice(from).findLast((l) => l.startsWith("statement: "))?.replace(/^statement: [^—]*— /, "") ?? "";
  try {
    for (const sql of [
      "SELECT e.id, coalesce(e.n, 0) AS n FROM nullish e ORDER BY n IS NULL, n, e.id",
      "SELECT e.id, e.t AS n FROM nullish e ORDER BY n IS NULL, n DESC, e.id",
      "SELECT e.id, CASE WHEN e.id > 4 THEN 0 ELSE e.n END FROM nullish e ORDER BY n IS NULL, n, e.id",
      "SELECT e.id, e.n FROM nullish e ORDER BY 2 IS NULL, 2 DESC, 1",
      "SELECT e.id, e.n FROM nullish e ORDER BY 2 IS NOT NULL, 2, 1",
    ]) {
      const from = logged.length;
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
      assert.match(sent(from), /ORDER BY .*IS (NOT )?NULL/, `${sql}\n${sent(from)}`);
    }
    // where the output column is the input's own tree, or a star's, it is the idiom still
    for (const sql of ["SELECT id, n FROM nullish ORDER BY n IS NULL, n DESC, id", "SELECT * FROM nullish ORDER BY n IS NULL, n DESC, id"]) {
      const from = logged.length;
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
      assert.match(sent(from), /ORDER BY (nullish\.)?n DESC NULLS LAST, (nullish\.)?id/, `${sql}\n${sent(from)}`);
    }
    // an unnamed CASE is named by its ELSE where that name is strong, a cast of a CASE by its type (FigureColname):
    // read by those names from a subquery
    for (const sql of ["SELECT s.n FROM (SELECT e.id, CASE WHEN e.id > 4 THEN 0 ELSE e.n END FROM nullish e) s ORDER BY s.id",
      "SELECT s.text, s.case FROM (SELECT e.id, (CASE WHEN e.id > 4 THEN 1 END)::text, CASE WHEN e.id > 4 THEN e.n ELSE 0 END FROM nullish e) s ORDER BY s.id"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
  } finally { await c.end(); }
});

test("a sum or avg of a text read as an unconstrained numeric is Postgres's exact one, at the most decimals a row's text has (Metabase's JSON numbers)", async () => {
  const c = await client();
  try {
    for (const sql of ["SELECT sum(t::numeric), avg(t::numeric), sum((j ->> 'r')::decimal), avg((j #>> array['r']::text[])::decimal) FROM jnums",
      "SELECT g, sum(t::numeric), avg((j ->> 'r')::numeric) FROM jnums GROUP BY g ORDER BY g",
      "SELECT sum(t::numeric) FILTER (WHERE id < 3), sum(t::numeric) FROM jnums WHERE id > 100",
      "SELECT id, sum((j ->> 'r')::numeric) OVER (ORDER BY id) FROM jnums ORDER BY id",
      // a NaN is summed as Postgres sums it
      "SELECT sum(s::numeric) FROM texts WHERE id IN (6, 7)"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    // a value DuckDB's DECIMAL(38,18) cannot hold is refused by name, never summed as a double
    await truth.exec("INSERT INTO public.jnums VALUES (7, '{}', '123456789012345678901234.5', 0)");
    await store.writer.run("INSERT INTO public.jnums VALUES (7, '{}', '123456789012345678901234.5', 0)");
    try {
      await assert.rejects(c.query("SELECT sum(t::numeric) FROM jnums"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap numeric-exact-sum/.test(e.message));
    } finally {
      await truth.exec("DELETE FROM public.jnums WHERE id = 7");
      await store.writer.run("DELETE FROM public.jnums WHERE id = 7");
    }
  } finally { await c.end(); }
});

test("an EXPLAIN is the statement it explains: a write under EXPLAIN ANALYZE is refused as the write is, never run on DuckDB", async () => {
  const c = await client();
  try {
    const refusal = async (sql: string, values?: unknown[]): Promise<Record<string, unknown>> => {
      try { await c.query(values === undefined ? sql : { text: sql, values }); }
      catch (e) { const x = e as pg.DatabaseError; return { code: x.code, message: x.message, detail: x.detail, hint: x.hint }; }
      throw new Error(`answered: ${sql}`);
    };
    const pairs: Array<[string, string]> = [["DELETE FROM orders WHERE id = 1", "EXPLAIN ANALYZE DELETE FROM orders WHERE id = 1"], ["UPDATE orders SET amount = 0", "EXPLAIN ANALYZE UPDATE orders SET amount = 0"],
      ["CREATE TABLE public.copy AS SELECT * FROM orders", "EXPLAIN ANALYZE CREATE TABLE public.copy AS SELECT * FROM orders"],
      // a statement Mason refuses by name: its EXPLAIN is refused with the same error and gap, never a plan of another
      ["SELECT *, status FROM (SELECT id, status FROM orders) s UNION SELECT id, status, status FROM orders ORDER BY 2, 1", "EXPLAIN ANALYZE SELECT *, status FROM (SELECT id, status FROM orders) s UNION SELECT id, status, status FROM orders ORDER BY 2, 1"],
      ["SELECT nosuch FROM orders", "EXPLAIN SELECT nosuch FROM orders"]];
    for (const [alone, explained] of pairs) {
      const want = await refusal(alone);
      assert.deepEqual(await refusal(explained), want, explained);
      // the extended protocol's Parse too
      assert.deepEqual(await refusal(explained, []), await refusal(alone, []), explained);
    }
    assert.deepEqual((await answer(c, "SELECT count(*), sum(amount) FROM orders")).rows, [["3", "242.50"]]);
    assert.deepEqual((await store.writer.runAndReadAll("SELECT count(*) FROM information_schema.tables WHERE table_name = 'copy'")).getRowsJS(), [[0n]]);
  } finally { await c.end(); }
});

test("a refusal of the statement an EXPLAIN explains is placed where Postgres places it: in the whole text, past EXPLAIN and its options", async () => {
  const c = await client();
  try {
    const position = async (sql: string, values?: unknown[]): Promise<unknown> => {
      try { await c.query(values === undefined ? sql : { text: sql, values }); }
      catch (e) { return (e as pg.DatabaseError).position; }
      throw new Error(`answered: ${sql}`);
    };
    const truthPosition = async (sql: string): Promise<unknown> => {
      try { await truth.query(sql); }
      catch (e) { return String((e as { position?: unknown }).position); }
      throw new Error(`the truth answered: ${sql}`);
    };
    for (const sql of ["EXPLAIN SELECT nosuch FROM orders", "EXPLAIN (ANALYZE) SELECT nosuch FROM orders", "  explain  (FORMAT JSON)\n SELECT 1 FROM nowhere",
      "EXPLAIN SELECT 'héllo', nosuch FROM orders"]) {
      const want = await truthPosition(sql);
      assert.ok(Number(want) > "EXPLAIN".length, `${sql}: the truth's position is the whole text's (${want})`);
      assert.equal(await position(sql), want, sql);
      assert.equal(await position(sql, []), want, `${sql} (Parse)`);
    }
  } finally { await c.end(); }
});

test("the catalog holds a type the source made at the OID the wire sends for it: format_type, pg_type and pg_attribute name it as the source does (issue 861)", async () => {
  const c = await client();
  try {
    // the OIDs the wire sends for an enum, its array, a citext: the source's (here the truth's)
    const r = await c.query({ text: "SELECT m, ms FROM moods LIMIT 0", rowMode: "array" });
    const a = await c.query({ text: "SELECT status FROM accounts LIMIT 0", rowMode: "array" });
    const oids = [...r.fields.map((f) => f.dataTypeID), a.fields[0]!.dataTypeID];
    const sql = `SELECT ${oids.map((o) => `format_type(${o}, -1)`).join(", ")}, format_type(23, -1), format_type(1043, 14)`;
    const truthNames = (await truth.query<unknown[]>(sql, [], { rowMode: "array" })).rows;
    assert.deepEqual(truthNames, [["mood", "mood[]", "citext", "integer", "character varying(10)"]]);
    assert.deepEqual((await answer(c, sql)).rows, truthNames, "format_type of the wire's OIDs: the source's names");
    // a client's lookup of a RowDescription's OID (JDBC's getColumnTypeName) reads the type itself
    assert.deepEqual((await answer(c, `SELECT oid::int, typname::text FROM pg_type WHERE oid IN (${oids.join(", ")}) ORDER BY 2`)).rows,
      [[String(oids[1]), "_mood"], [String(oids[2]), "citext"], [String(oids[0]), "mood"]]);
    // the catalog's own columns hold the same OIDs
    assert.deepEqual((await answer(c, "SELECT attname, atttypid::int, format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid = 'moods'::regclass AND attnum > 0 ORDER BY attnum")).rows,
      [["id", "23", "integer"], ["m", String(oids[0]), "mood"], ["ms", String(oids[1]), "mood[]"]]);
  } finally { await c.end(); }
});

test("EXPLAIN says where the answer comes from, what Mason sent DuckDB and computes after it, and DuckDB's plan in Postgres's layout", async () => {
  const c = await client();
  try {
    const plan = async (sql: string, values?: unknown[]): Promise<{ lines: string[]; fields: Array<[string, number]>; command: string }> => {
      const r = await c.query({ text: sql, values, rowMode: "array" } as pg.QueryConfig);
      return { lines: (r.rows as unknown as string[][]).map((x) => x[0]!), fields: r.fields.map((f) => [f.name, f.dataTypeID] as [string, number]), command: r.command };
    };
    const p = await plan("EXPLAIN SELECT id, status FROM orders ORDER BY id LIMIT 2");
    assert.deepEqual(p.fields, [["QUERY PLAN", 25]]);
    assert.equal(p.command, "EXPLAIN");
    // no sync here (`copies` is empty): how it is kept current is said unknown, never guessed
    assert.equal(p.lines[0], "Mason: answered from the synced table public.orders (about 3 rows; how it is kept current is unknown: the sync has no record of it)");
    assert.equal(p.lines[1], "  Sent to the engine: SELECT id AS id, status AS status FROM orders ORDER BY id LIMIT 2");
    assert.equal(p.lines[2], "  Computed by Mason after the engine: nothing");
    // a preview's late materialization (14a1a831), as DuckDB plans it: the top two by the key, then the other columns
    // read for those rows only
    assert.ok(p.lines.some((l) => /^ +->  Hash Join {2}\(rows=3\)$/.test(l)) && p.lines.some((l) => /^ +Join Type: SEMI$/.test(l)), p.lines.join("\n"));
    assert.ok(p.lines.some((l) => /^ +->  Top N {2}\(rows=2\)$/.test(l)), p.lines.join("\n"));
    assert.ok(p.lines.some((l) => /^ +->  Table Scan on public\.orders {2}\(rows=3\)$/.test(l)), p.lines.join("\n"));
    // DuckDB's names, never Postgres's, and no cost Mason would have to invent
    assert.ok(!p.lines.some((l) => /Seq Scan|cost=/.test(l)), p.lines.join("\n"));
    // VERBOSE adds the projections and filters; COSTS off leaves the estimates out; a parameter is bound (the extended
    // protocol's Describe says the one column); BUFFERS is said to mean nothing here
    const v = await plan("EXPLAIN (VERBOSE, COSTS false, BUFFERS) SELECT id FROM orders WHERE status = $1", ["paid"]);
    assert.ok(v.lines.some((l) => /^\s+Projections: /.test(l)) && v.lines.some((l) => /^\s+Filters: /.test(l)), v.lines.join("\n"));
    assert.ok(!v.lines.some((l) => /rows=/.test(l)), v.lines.join("\n"));
    assert.ok(v.lines.includes("  Note: BUFFERS has no meaning to the engine: ignored"), v.lines.join("\n"));
    // what Mason computes after DuckDB, and its functions DuckDB calls
    const x = await plan("EXPLAIN SELECT sum(amount) / 7 FROM orders");
    assert.match(x.lines[2]!, /^ {2}Computed by Mason after the engine: column 1 "\?column\?": Postgres's exact numeric, from \d of the engine's value\(s\)$/);
    // a function is what DuckDB calls, never the cells Mason computes from (`__mason_cell_0` is a column's name)
    const called = (await plan("EXPLAIN SELECT sum(amount::text::numeric) FROM orders")).lines.find((l) => /^ {2}Mason's functions the engine calls: /.test(l));
    assert.ok(called !== undefined && /__mason_numeric_exact/.test(called) && !/__mason_cell_/.test(called), called);
    // a catalog statement is the catalog Postgres's, said so first
    const k = await plan("EXPLAIN SELECT relname FROM pg_class WHERE relname = 'orders'");
    assert.match(k.lines[0]!, /^Mason: answered by the catalog Postgres \(Mason's own, PGlite\), not the synced data/);
    assert.ok(k.lines.length > 1);
    assert.match((await plan("EXPLAIN SELECT relname FROM pg_class", [])).lines[0]!, /^Mason: answered by the catalog Postgres/);
  } finally { await c.end(); }
});

test("EXPLAIN says how a copy is kept current as the sync says it to mason status: a streamed table by logical replication, never its last poll", async () => {
  // a project switched to logical replication still holds its last poll in the poll's ledger: EXPLAIN read that, and
  // said "kept current by polling, last poll <two days ago>" of a table status said was streamed
  await store.writer.run("CREATE SCHEMA IF NOT EXISTS _mason");
  await store.writer.run("CREATE TABLE IF NOT EXISTS _mason.poll_state (source VARCHAR PRIMARY KEY, snapshot VARCHAR, polled_at TIMESTAMPTZ)");
  await store.writer.run("INSERT OR REPLACE INTO _mason.poll_state VALUES ('public.orders', '100:100:', '2026-10-27 19:58:39+00')");
  const c = await client();
  const header = async (sql = "EXPLAIN SELECT id FROM orders"): Promise<string> => String((await c.query({ text: sql, rowMode: "array" })).rows[0]![0]);
  const json = async (): Promise<Record<string, unknown>> =>
    (JSON.parse(String((await c.query({ text: "EXPLAIN (FORMAT JSON) SELECT id FROM orders", rowMode: "array", types: raw } as pg.QueryConfig)).rows[0]![0])) as Array<{ Mason: { Tables: Array<Record<string, unknown>> } }>)[0]!.Mason.Tables[0]!;
  const copied = (kept: CopyState["kept"]): CopyState => ({ source: "public.orders", phase: "copied", rows: 3, bytes: 8192, seconds: 0.1, copiedAt: "2026-10-27 19:00:00+00", error: null, ...(kept ? { kept } : {}) });
  const head = "Mason: answered from the synced table public.orders (about 3 rows; ";
  // the copy's age is said for a streamed table too: the last moment the stream had everything the database wrote
  const syncedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  const synced = `last synced 3 min ago (${syncedAt.slice(0, 19).replace("T", " ")} UTC)`;
  const streamed = { by: "replication", slot: "mason_shop", state: "streamed", why: null, position: "0/1A2B3C4D", lastCommit: "2026-10-29T08:15:02.512Z", notRunning: null, syncedAt } as const;
  const stream = { Sync: "replication", Slot: "mason_shop", "Applied Through": "0/1A2B3C4D", "Last Synced": syncedAt, "Last Change Committed": "2026-10-29T08:15:02.512Z", "Stream Not Running": null };
  /** the JSON says what the text says, and names a mode only for a copy that mode keeps current now */
  const jsonSays = async (by: string | null, more: Record<string, unknown>): Promise<void> =>
    assert.deepEqual(await json(), { Table: "public.orders", "Estimated Rows": 3, "Kept Current By": by, "Kept Current": (await header()).slice(head.length, -1), ...more });
  try {
    copies = [copied(streamed)];
    const h = await header();
    assert.equal(h, `${head}kept current by logical replication (slot mason_shop), replicated, at 0/1A2B3C4D, ${synced}, last change committed 2026-10-29 08:15:02 UTC)`);
    assert.doesNotMatch(h, /polling|last poll/);
    await jsonSays("logical replication", { ...stream, "Stream State": "streamed" });
    // the stream down, nothing applied yet this run: said with why, NOT kept current now, still never the poll
    copies = [copied({ ...streamed, lastCommit: null, notRunning: "the database closed the connection · it starts again after 08:16 UTC" })];
    assert.equal(await header(), `${head}streamed by logical replication (slot mason_shop), replicated, at 0/1A2B3C4D, ${synced}, no change applied this run; NOT kept current now, the stream is not running: the database closed the connection · it starts again after 08:16 UTC)`);
    await jsonSays(null, { ...stream, "Stream State": "streamed", "Last Change Committed": null, "Stream Not Running": "the database closed the connection · it starts again after 08:16 UTC" });
    // a table being caught up, or left out of the publication, is said as status says it, and no mode is said at work
    copies = [copied({ ...streamed, state: "catching-up", why: "caught up by one poll after its whole read" })];
    assert.equal(await header(), `${head}logical replication (slot mason_shop), not streamed yet: caught up by one poll after its whole read)`);
    await jsonSays(null, { ...stream, "Stream State": "catching-up" });
    copies = [copied({ ...streamed, state: "left-out", why: "the publication mason_pub does not publish public.orders" })];
    assert.equal(await header(), `${head}NOT kept current: left out of logical replication (slot mason_shop): the publication mason_pub does not publish public.orders)`);
    await jsonSays(null, { ...stream, "Stream State": "left-out" });
    copies = [copied({ ...streamed, state: "waiting", why: "its columns changed: it is read again whole, then caught up by one poll" })];
    assert.equal(await header(), `${head}logical replication (slot mason_shop), not streamed yet: its columns changed: it is read again whole, then caught up by one poll)`);
    await jsonSays(null, { ...stream, "Stream State": "waiting" });
    // a polled table: its interval and how long ago its last poll was, from the sync's (issue 33: the age is never hidden)
    const minutesAgo = new Date(Date.now() - 12 * 60_000 - 5_000).toISOString(), daysAgo = new Date(Date.now() - 3 * 86_400_000 - 3_600_000).toISOString();
    const utc = (iso: string): string => `${iso.slice(0, 19).replace("T", " ")} UTC`;
    const every30 = { mode: "poll" as const, every: "30s", seconds: 30 };
    copies = [copied({ by: "poll", sync: every30, syncedAt: minutesAgo, nextAt: "2026-10-27T19:59:09.000Z" })];
    assert.equal(await header(), `${head}polled every 30s, last 12 min ago (${utc(minutesAgo)}))`);
    assert.deepEqual(await json(), { Table: "public.orders", "Estimated Rows": 3, "Kept Current By": "polling", "Kept Current": `polled every 30s, last 12 min ago (${utc(minutesAgo)})`,
      Sync: "poll 30s", "Last Synced": minutesAgo, "Next Poll": "2026-10-27T19:59:09.000Z" });
    copies = [copied({ by: "poll", sync: every30, syncedAt: null, nextAt: null })];
    assert.equal(await header(), `${head}polled every 30s, not polled yet)`);
    // sync: off: nothing keeps it current, and its age and the command that syncs it are said, as status says them
    copies = [copied({ by: "poll", sync: { mode: "off" }, syncedAt: daysAgo, nextAt: null })];
    assert.equal(await header(), `${head}off: last synced 3 days ago (${utc(daysAgo)}); mason sync public.orders syncs it now)`);
    await jsonSays(null, { Sync: "off", "Last Synced": daysAgo, "Next Poll": null });
    // served as copied and skipped by the passes until copied again: NOT kept current, and why
    copies = [copied({ by: "poll", sync: every30, syncedAt: daysAgo, nextAt: null, pending: "its columns changed: it is read again whole, then caught up by one poll" })];
    assert.equal(await header(), `${head}NOT kept current (last synced 3 days ago (${utc(daysAgo)})): its columns changed: it is read again whole, then caught up by one poll)`);
    await jsonSays(null, { Sync: "poll 30s", "Last Synced": daysAgo, "Next Poll": null });
    // a copy under way or failed says so before how it would be kept current
    copies = [{ ...copied(streamed), phase: "copying", rowsSoFar: 1200 }];
    assert.equal(await header(), `${head}being read whole (1,200 rows so far): kept current once synced)`);
    copies = [{ ...copied(streamed), phase: "failed", error: "permission denied for table orders\n(tried again after 14:05 UTC)" }];
    assert.equal(await header(), `${head}its first sync failed: permission denied for table orders)`);
    // a statement over two copies says each on a line of its own
    copies = [copied(streamed), { ...copied({ by: "poll", sync: every30, syncedAt: null, nextAt: null }), source: "sales.invoices" }];
    const two = (await c.query({ text: "EXPLAIN SELECT o.id FROM orders o JOIN sales.invoices i ON i.id = o.id", rowMode: "array" })).rows.map((x) => String((x as unknown[])[0]));
    assert.equal(two[0], "Mason: answered from the synced tables");
    assert.ok(two.includes(`  public.orders (about 3 rows; kept current by logical replication (slot mason_shop), replicated, at 0/1A2B3C4D, ${synced}, last change committed 2026-10-29 08:15:02 UTC)`), two.join("\n"));
    assert.ok(two.some((l) => /^ {2}sales\.invoices \(about \d+ rows; polled every 30s, not polled yet\)$/.test(l)), two.join("\n"));
  } finally {
    copies = [];
    await store.writer.run("DELETE FROM _mason.poll_state WHERE source = 'public.orders'");
    await c.end();
  }
});

test("EXPLAIN ANALYZE runs the statement and sends none of its rows: each step's rows and time, and where the time went", async () => {
  const c = await client();
  try {
    // the session itself is in the log, as it happens (mason logs once showed little)
    assert.ok(logged.some((l) => /^\[postgres\] session \d+ connected: a client with no application_name as "mason" from 127\.0\.0\.1$/.test(l)), logged.join("\n"));
    logged.length = 0;
    const r = await c.query({ text: "EXPLAIN ANALYZE SELECT id, amount FROM orders WHERE qty > 1 ORDER BY id", rowMode: "array" });
    const lines = (r.rows as string[][]).map((x) => x[0]!);
    assert.ok(lines.some((l) => /^ {2}->  Order By {2}\(rows=\d+\) \(actual rows=2, thread time=\d+\.\d{3} ms\)$/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /->  Table Scan on public\.orders {2}\(rows=\d+\) \(actual rows=2, thread time=\d+\.\d{3} ms\)$/.test(l)), lines.join("\n"));
    // the time is DuckDB's thread time, said so once: never Postgres's elapsed `actual time` (the Fable review of #517)
    assert.ok(lines.includes("  Note: an operator's thread time is the engine's, summed over the threads that ran it and the operators under it: a parallel one's exceeds the Execution Time"), lines.join("\n"));
    assert.ok(!lines.some((l) => /actual time=/.test(l)), lines.join("\n"));
    assert.match(lines.at(-2)!, /^Planning Time: \d+\.\d{3} ms \(Postgres's analysis \d+\.\d{3}, Mason's rewrite \d+\.\d{3}, the engine's planning \d+\.\d{3}\)$/);
    assert.match(lines.at(-1)!, /^Execution Time: \d+\.\d{3} ms \(the engine \d+\.\d{3}, Mason's conversion and exact numerics \d+\.\d{3}\)$/);
    // it ran, through the same runner (its log line), and the plan's rows are all the client got
    assert.ok(finished("2 row(s)"), logged.join("\n"));

    // TIMING off: the rows, no times; SUMMARY off: no closing lines
    const t = (await c.query({ text: "EXPLAIN (ANALYZE, TIMING off, SUMMARY off) SELECT id FROM orders", rowMode: "array" })).rows.map((x) => String(x[0]));
    assert.ok(t.some((l) => /\(actual rows=3\)$/.test(l)) && !t.some((l) => /time=|Time:/.test(l)), t.join("\n"));
    // the statement's limits hold under it, and the session goes on (the profiler off again)
    await c.query("SET statement_timeout = '200ms'");
    await assert.rejects(c.query(`EXPLAIN ANALYZE ${SLOW}`), (e: pg.DatabaseError) => e.code === "57014");
    await c.query("RESET statement_timeout");
    assert.deepEqual((await answer(c, "SELECT count(*) FROM orders")).rows, [["3"]]);
  } finally { await c.end(); }
});

test("EXPLAIN ANALYZE reports the statement's own profile, never another statement's: one DuckDB answers while planning has its plan and no times", async () => {
  // DuckDB's profiler writes ONE file, the last profiled statement's on the connection: the settle's probe of the
  // schemas ran under it, and a count(*) of a whole table — which DuckDB answers from the table's row count while
  // planning, writing no profile — was reported as that probe's plan (a scan of duckdb_schemas), "reading none of its
  // copies" (a real deployment's count(*) of a 197 M-row copy)
  const c = await client();
  const lines = async (sql: string): Promise<string[]> => (await c.query({ text: sql, rowMode: "array" })).rows.map((x) => String((x as unknown[])[0]));
  try {
    for (const table of ["orders", "big"]) {
      const l = await lines(`EXPLAIN (ANALYZE) SELECT count(*) FROM ${table}`);
      const plan = l.filter((x) => !/^ |^(Mason|Planning Time|Execution Time):/.test(x));
      assert.ok(!l.some((x) => /schemas/i.test(x)), l.join("\n"));
      // DuckDB's plan of the count (its EXPLAIN: a scan of the one row it computed), the rows it answered, no times
      assert.deepEqual(plan, ["Column Data Scan  (rows=1) (actual rows=1)"], l.join("\n"));
      assert.ok(l.includes("  Note: the engine's profiler recorded no operator of this statement: the engine answered it while planning it (as it answers a count(*) of a whole table from the table's row count), so the plan is its EXPLAIN, with the rows it answered"), l.join("\n"));
      assert.ok(!l.some((x) => /thread time/.test(x)), l.join("\n"));
      assert.match(l.at(-1)!, /^Execution Time: \d+\.\d{3} ms /);
    }
    // FORMAT JSON says the same
    const [doc] = JSON.parse(String((await c.query({ text: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM big", rowMode: "array", types: raw } as pg.QueryConfig)).rows[0]![0])) as Array<{ Plan: Record<string, unknown>; Mason: Record<string, unknown> }>;
    assert.deepEqual([doc!.Plan["Node Type"], doc!.Plan["Actual Rows"], doc!.Plan["Engine Thread Time"]], ["Column Data Scan", 1, undefined]);
    assert.match(String(doc!.Mason.Note), /^the engine's profiler recorded no operator of this statement/);
    // a statement the profiler does time is its own, after one it did not and after one of another table's; one that
    // scans a copy says its scan's rows and time
    for (const [sql, scans] of [["SELECT count(*) FROM big WHERE id > 7", "big"], ["SELECT count(*) FROM orders WHERE qty > 1", "orders"], ["SELECT 1", null], ["SELECT id FROM orders WHERE false", null]] as const) {
      const l = await lines(`EXPLAIN ANALYZE ${sql}`);
      assert.ok(!l.some((x) => /schemas|^ {2}Note: DuckDB's profiler/i.test(x)), `${sql}\n${l.join("\n")}`);
      if (scans !== null) assert.ok(l.some((x) => x.includes(`Table Scan on public.${scans}  (rows=`) && /\(actual rows=\d+, thread time=\d+\.\d{3} ms\)$/.test(x)), `${sql}\n${l.join("\n")}`);
    }
    // the profile names the statement as DuckDB was given it: one with a parameter bound, one calling Mason's functions
    for (const [sql, values] of [["SELECT id FROM orders WHERE status = $1", ["paid"]], ["SELECT sum(amount::text::numeric) FROM orders\nWHERE qty > 0", []]] as const) {
      const l = (await c.query({ text: `EXPLAIN ANALYZE ${sql}`, values: [...values], rowMode: "array" })).rows.map((x) => String((x as unknown[])[0]));
      assert.ok(l.some((x) => /Table Scan on public\.orders {2}\(rows=\d+\) \(actual rows=\d+, thread time=/.test(x)), `${sql}\n${l.join("\n")}`);
    }
  } finally { await c.end(); }
});

test("EXPLAIN (FORMAT JSON) is Postgres's plan document, DuckDB's operators in it and Mason's sections beside: what pgAdmin, DBeaver and DataGrip draw", async () => {
  const c = await client();
  try {
    const r = await c.query({ text: "EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM orders ORDER BY id LIMIT 2", rowMode: "array", types: raw } as pg.QueryConfig);
    assert.deepEqual(r.fields.map((f) => [f.name, f.dataTypeID]), [["QUERY PLAN", 114]]);
    const [doc] = JSON.parse(String((r.rows as unknown[][])[0]![0])) as Array<{ Plan: Record<string, unknown>; Mason: Record<string, unknown>; "Planning Time": number; "Execution Time": number }>;
    assert.equal(doc!.Plan["Node Type"], "Top N");
    assert.equal(doc!.Plan["Actual Rows"], 2);
    assert.equal(typeof doc!.Plan["Engine Thread Time"], "number");
    assert.equal(doc!.Plan["Actual Total Time"], undefined, "a plan viewer draws Actual Total Time as elapsed: DuckDB's is thread time");
    const scan = (doc!.Plan.Plans as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([scan["Node Type"], scan["Relation Name"], scan["Schema"], scan["Plan Rows"]], ["Table Scan", "orders", "public", 3]);
    assert.equal(doc!.Mason["Answered By"], "the engine");
    assert.deepEqual(doc!.Mason.Tables, [{ Table: "public.orders", "Estimated Rows": 3, "Kept Current By": null, "Kept Current": "how it is kept current is unknown: the sync has no record of it" }]);
    assert.ok(typeof doc!["Planning Time"] === "number" && typeof doc!["Execution Time"] === "number");
    // FORMAT XML and YAML are refused by name; Postgres's own errors for an option it does not have, or one that needs ANALYZE
    await assert.rejects(c.query("EXPLAIN (FORMAT XML) SELECT id FROM orders"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap explain-option/.test(e.message));
    await assert.rejects(c.query("EXPLAIN (FORMAT YAML) SELECT id FROM orders"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap explain-option/.test(e.message));
    await assert.rejects(c.query("EXPLAIN (NOSUCH) SELECT id FROM orders"), (e: pg.DatabaseError) => e.code === "42601" && e.message === 'unrecognized EXPLAIN option "nosuch"');
    await assert.rejects(c.query("EXPLAIN (TIMING) SELECT id FROM orders"), (e: pg.DatabaseError) => e.code === "22023" && e.message === "EXPLAIN option TIMING requires ANALYZE");
  } finally { await c.end(); }
});

test("a search_path naming a schema DuckDB lacks is the schemas it has, as Postgres skips one that does not exist", async () => {
  const c = await client();
  try {
    // Supabase's default path names `extensions`; DuckDB refused the SET, and every statement after it
    await c.query("SET search_path TO public, extensions");
    assert.deepEqual((await answer(c, "SELECT count(*) FROM orders")).rows, [["3"]]);
    await c.query("SET search_path TO nowhere, sales");
    assert.deepEqual((await answer(c, "SELECT count(*) FROM invoices")).rows, [["2"]]);
  } finally { await c.end(); }
});

test("an array in binary is array_send's bytes, and its text writes a timestamptz element in the session's zone", async () => {
  // pgjdbc (Metabase's driver) asks for text[], int4[], float8[] … in binary once a statement has run five times
  const r = await store.writer.runAndReadAll("SELECT ['a', NULL, 'b c']::VARCHAR[] AS t, [1, -2]::INTEGER[] AS i, []::BIGINT[] AS e, [1.5, NULL]::DOUBLE[] AS f, " +
    "[TIMESTAMPTZ '2026-01-02 03:04:05+00'] AS z");
  const row = r.getRows()[0]!;
  // Postgres's own bytes, each array asked alone (one type per query)
  const send = async (sql: string): Promise<Buffer> => Buffer.from((await truth.query<{ b: Uint8Array }>(`SELECT array_send(${sql}) AS b`)).rows[0]!.b);
  const want = [await send("ARRAY['a', NULL, 'b c']::text[]"), await send("ARRAY[1, -2]::int4[]"), await send("ARRAY[]::int8[]"), await send("ARRAY[1.5, NULL]::float8[]"),
    await send("ARRAY[timestamptz '2026-01-02 03:04:05+00']")];
  for (let i = 0; i < want.length; i++) {
    assert.deepEqual(wireColumn(`c${i}`, r.columnType(i)).encode(row[i]!, 1, { timeZone: "UTC" }), want[i], `column ${i}`);
  }
  // the text of a timestamptz element is in the session's zone, as array_out writes it
  await truth.exec("SET TimeZone = 'Asia/Kolkata'");
  try {
    const text = (await truth.query<{ t: string }>("SELECT ARRAY[timestamptz '2026-01-02 03:04:05+00']::text AS t")).rows[0]!.t;
    assert.equal(wireColumn("z", r.columnType(4)).encode(row[4]!, 0, { timeZone: "Asia/Kolkata" })!.toString("utf8"), text);
  } finally { await truth.exec("SET TimeZone = 'UTC'"); }
});

test("the token: minted from the API key, refused when it is the key, another project's, or expired", async () => {
  await (await client()).end();
  for (const [password, why] of [[API_KEY, /API key is not a password/], [mintToken("x".repeat(48), 600).token, /not a password or token of this project/],
    [mintToken(API_KEY, 60, Date.now() - 120_000).token, /expired/], ["hunter2", /not a Mason user.s password or token/]] as const) {
    await assert.rejects(client(password), (e: pg.DatabaseError) => e.code === "28P01" && why.test(e.message), String(why));
  }
});

test("a foreign key to a unique index or a UNIQUE constraint is listed, and the index with it (the BI-tools test: BIRD's 57 of 87)", async () => {
  // what mason reads of the source: the unique indexes a foreign key can reference, the expression's and partial left out
  const facts = JSON.parse(String((await truth.query<unknown[]>(TABLES_SQL, [], { rowMode: "array" })).rows[0]![0])) as Array<{ table: string; unique_keys: unknown[] }>;
  assert.deepEqual(facts.find((t) => t.table === "uparent")!.unique_keys, [
    { name: "uparent_code", constraint: false, nulls_not_distinct: false, columns: ["code"] },
    { name: "uparent_ref_key", constraint: true, nulls_not_distinct: false, columns: ["ref"] },
  ]);
  const c = await client();
  try {
    for (const sql of [
      "SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN ('uchild'::regclass, 'uparent'::regclass) ORDER BY conname",
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'uparent' AND indexname IN ('uparent_pkey', 'uparent_code', 'uparent_ref_key') ORDER BY indexname",
    ]) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
  } finally { await c.end(); }
});

test("an enum is ordered, compared and grouped by its declared labels, as Postgres does, a parameter typed as it included", async () => {
  const c = await client();
  try {
    for (const sql of ["SELECT id, m FROM moods ORDER BY m, id", "SELECT id FROM moods WHERE m > 'sad' ORDER BY id",
      "SELECT min(m), max(m) FROM moods", "SELECT m, count(*) FROM moods GROUP BY m ORDER BY m", "SELECT id, ms FROM moods ORDER BY ms, id",
      "SELECT id, m::text < 'p', 'ok'::mood < m FROM moods ORDER BY id"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    // a parameter Postgres types as the enum is read as one: compared by the labels' order, never as text
    const param = "SELECT id FROM moods WHERE m < $1 ORDER BY id";
    assert.deepEqual(await answer(c, param, ["happy"]), await postgres(param, ["happy"]));
    // a label the enum lacks is Postgres's error, from a literal and from a text
    for (const sql of ["SELECT id FROM moods WHERE m = 'nope'", "SELECT id FROM moods WHERE m = ('no' || 'pe')::mood"]) {
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "22P02" && /invalid input value for enum mood: "nope"/.test(e.message), sql);
    }
  } finally { await c.end(); }
});

test("an ANY / ALL over a NULL array is NULL, as Postgres's is (DuckDB reads it as an empty one)", async () => {
  const c = await client();
  try {
    for (const sql of ["SELECT id, 'a' = ANY (tags), 'a' <> ALL (tags), 'z' < ANY (tags) FROM orders ORDER BY id",
      "SELECT id, 'ok' = ANY (ms), (m = ANY (ms)) IS NULL FROM moods ORDER BY id"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
  } finally { await c.end(); }
});

test("a source's NOT NULL, defaults, serials and identities are the catalog's, as a tool reads them (Metabase's sync)", async () => {
  const c = await client();
  try {
    for (const sql of ["SELECT column_name, column_default, is_nullable, is_identity, identity_generation FROM information_schema.columns WHERE table_name = 'serials' ORDER BY ordinal_position",
      "SELECT pg_get_serial_sequence('serials', 'id'), pg_get_serial_sequence('public.serials', 'ib'), pg_get_serial_sequence('serials', 'n')",
      "SELECT a.attname, a.attnotnull, a.atthasdef FROM pg_attribute a WHERE a.attrelid = 'serials'::regclass AND a.attnum > 0 ORDER BY a.attnum"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
  } finally { await c.end(); }
});

test("a source's view is answered by its definition over the copied tables, as Postgres answers it; one over a table Mason lacks is left out, said", async () => {
  const c = await client();
  try {
    for (const sql of ["SELECT * FROM paid_orders ORDER BY id", "SELECT * FROM big_paid", "SELECT count(*), sum(p.amount) FROM paid_orders p JOIN orders o ON o.id = p.id",
      // Metabase qualifies every column by its schema and table
      `SELECT "public"."paid_orders"."id" AS "id", "public"."paid_orders"."amount" AS "amount" FROM "public"."paid_orders" ORDER BY "public"."paid_orders"."id" ASC LIMIT 2000`,
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_name IN ('paid_orders', 'big_paid', 'orders') ORDER BY 1"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    // a view's whole row is a record once it is a subquery: refused by name, never answered as one
    await assert.rejects(c.query("SELECT paid_orders FROM paid_orders"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap view-forms/.test(e.detail ?? ""));
    await assert.rejects(c.query("SELECT * FROM lost"), (e: pg.DatabaseError) => e.code === "42P01");
    // one line naming the view and what it reads, never its definition (tests/postgres-api/catalog.test.ts)
    assert.ok(everLogged.some((l) => l.endsWith("catalog: view public.lost left out: it reads public.nowhere, which is not synced")), everLogged.filter((l) => l.includes("left out")).join("\n"));
  } finally { await c.end(); }
});

test("a sorted, limited select list is computed for the rows the limit keeps, as Postgres's index scan computes it (the Metabase preview through a join)", async () => {
  const c = await client();
  try {
    // through the key's index Postgres stops at the limit: row 2000's 'x' is never read as an integer
    const indexed = ["SELECT l.id, (l.j ->> 'n')::int, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 3",
      "SELECT * FROM (SELECT l.id, (l.j ->> 'n')::int AS n, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 3 OFFSET 2) AS s ORDER BY s.n DESC",
      "SELECT l.id AS key, upper(c.name), l.j ->> 'n' FROM late l JOIN late_c c ON c.id = l.c ORDER BY c.name DESC, key LIMIT 4"];
    for (const sql of indexed) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // the bad row kept: both raise
    const kept = "SELECT l.id, (l.j ->> 'n')::int FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id DESC LIMIT 3";
    await assert.rejects(c.query(kept), (e: pg.DatabaseError) => e.code === "22P02");
    // THE DECIDED DIFFERENCE (gap limit-errors): with no index on k Postgres sorts every row, computing the list for
    // each, and raises; Mason computes it for the rows kept
    const sorted = "SELECT l.id, (l.j ->> 'n')::int FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.k DESC LIMIT 3";
    await assert.rejects(postgres(sorted), /invalid input syntax for type integer: "x"/);
    assert.deepEqual((await answer(c, sorted)).rows, [["1", "1"], ["2", "2"], ["3", "3"]]);
  } finally { await c.end(); }
});

// a sort key written as a bare literal: an output holding a constant, sorted by its name or number, was written into the
// inner ORDER BY as the literal, which DuckDB reads as an ordinal (an integer: the first inner column, a row number) or
// refuses (42804, "non-integer literal"); a constant orders nothing, so it is no key at all
test("a sort key that is an output holding a constant orders nothing: by name and by number, before the real keys", async () => {
  const c = await client();
  try {
    for (const v of ["1 AS v", "'x' AS v", "true AS v", "2::bigint AS v", "'x'::text AS v"]) {
      for (const sql of [
        // the GROUP BY form (keyFirst)
        `SELECT l.id, l.k, ${v}, count(*) AS n FROM late l GROUP BY l.id ORDER BY v, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k, ${v}, count(*) AS n FROM late l GROUP BY l.id ORDER BY 3, 1 DESC LIMIT 3`,
        // the join (joinRows)
        `SELECT l.id, l.k, ${v} FROM late l JOIN late_c c ON c.id = l.c ORDER BY v, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k, ${v}, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY 3, l.k, 1 LIMIT 3`,
        // one table, a computed list (afterLimit) and a plain one
        `SELECT l.id, l.j ->> 'n' AS n, ${v} FROM late l ORDER BY v, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k, ${v} FROM late l ORDER BY 3, l.k LIMIT 2`,
        // no LIMIT: no rewrite of the sort, and the engine's own reading of it
        `SELECT l.id, l.k, ${v} FROM late l WHERE l.id < 5 ORDER BY v, l.id DESC`,
        `SELECT l.id, l.k, ${v}, c.name FROM late l JOIN late_c c ON c.id = l.c WHERE l.id < 5 ORDER BY 3, l.id DESC`,
      ]) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    // a constant cast, written as the key itself: an expression to Postgres, ordering nothing
    for (const sql of ["SELECT l.id, l.k FROM late l ORDER BY 'x'::text, l.id DESC LIMIT 3",
      "SELECT l.id, l.k, count(*) AS n FROM late l GROUP BY l.id ORDER BY 1::int, l.id DESC LIMIT 3",
      "SELECT l.id, l.j ->> 'n' AS n FROM late l JOIN late_c c ON c.id = l.c ORDER BY true::boolean, l.id DESC LIMIT 3"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    // every key a constant: no order at all, so any 3 rows are Postgres's; the written sort never reaches the inner
    for (const sql of ["SELECT l.id, l.k, 1 AS one FROM late l JOIN late_c c ON c.id = l.c ORDER BY one DESC LIMIT 3",
      "SELECT l.id, l.k, 1 AS one FROM late l JOIN late_c c ON c.id = l.c ORDER BY 3 LIMIT 3",
      "SELECT l.id, l.k, 'x' AS t FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY t LIMIT 3",
      "SELECT l.id, l.k, true AS b FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY 3 DESC LIMIT 3"]) {
      assert.equal((await answer(c, sql)).rows.length, 3, sql);
    }
  } finally { await c.end(); }
});

// A SORT KEY WRITTEN AS A BARE LITERAL, its third instance (CI on PR 170): inside a subquery the late rewrites do not
// apply, and the collation's sort key was written over the constant — `ORDER BY one DESC, __mason_libc_key(…, 'x'), 'x'`,
// refused 42804. The rewrite drops a constant key wherever a SELECT's keys are written: at the top and at any depth, by
// name and by number, under each collation kind, with no key left no ORDER BY, the LIMIT kept
test("a constant sort key orders nothing at any depth: by name and by number, under C, ICU and the database's libc collation", async () => {
  const libc = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: (l) => (logged.push(l), everLogged.push(l)),
    duck: await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, undefined,
      handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({})], [" "], { collate: "en_US.utf8" }), () => copies),
  });
  const bytes = await client();
  const onLibc = new pg.Client({ host: "127.0.0.1", port: libc.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await onLibc.connect();
  try {
    for (const [c, database] of [[bytes, "C"], [onLibc, "libc"]] as const) {
      for (const v of ["'x' AS v", `'x' COLLATE "C" AS v`, `'x' COLLATE "und-x-icu" AS v`, "'x'::text AS v", "7 AS v", "true AS v"]) {
        const say = (sql: string): string => `${sql} (the database's collation ${database})`;
        // answered as Postgres answers: the keys left decide the order
        for (const sql of [
          `SELECT l.id, l.k, ${v} FROM late l ORDER BY v DESC, l.id LIMIT 3`,
          `SELECT l.id, l.k, ${v} FROM late l ORDER BY 3, 1 DESC LIMIT 3`,
          `SELECT l.id, l.k, ${v} FROM late l WHERE l.id < 5 ORDER BY v, l.id DESC`,
          `SELECT l.id, l.k, ${v} FROM late l WHERE l.id < 5 ORDER BY 3 DESC, 1`,
          `SELECT s.id FROM (SELECT l.id, ${v} FROM late l ORDER BY v, l.id DESC LIMIT 4) s ORDER BY s.id`,
          `SELECT s.id FROM (SELECT l.id, ${v} FROM late l ORDER BY 2 DESC, 1 LIMIT 4) s ORDER BY s.id`,
          `SELECT count(*) FROM (SELECT l.id, l.k, ${v} FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY v DESC LIMIT 3) s`,
          `SELECT count(*) FROM (SELECT l.id, l.k, ${v} FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY 3 LIMIT 3) s`,
          `SELECT count(*) FROM (SELECT l.id, ${v} FROM late l ORDER BY v) s`,
          `SELECT count(*) FROM (SELECT l.id, ${v} FROM late l ORDER BY 2 DESC) s`,
          // every key a constant, as WITH TIES reads it: every row ties
          `SELECT count(*) FROM (SELECT l.id, ${v} FROM late l ORDER BY v FETCH FIRST 2 ROWS WITH TIES) s`,
        ]) assert.deepEqual(await answer(c, sql), await postgres(sql), say(sql));
        // every key a constant: no order at all, so any 3 rows are Postgres's
        for (const sql of [`SELECT l.id, l.k, ${v} FROM late l ORDER BY v LIMIT 3`, `SELECT l.id, l.k, ${v} FROM late l ORDER BY 3 DESC LIMIT 3`]) {
          assert.equal((await answer(c, sql)).rows.length, 3, say(sql));
        }
      }
      // CI's statement: an integer and a text constant, by name and by number, in a subquery under a LEFT JOIN
      const ci = "SELECT count(*) FROM (SELECT l.id, l.k, 1 AS one, 'x' AS t FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY one DESC, 4 LIMIT 3) s";
      assert.deepEqual(await answer(c, ci), await postgres(ci), `${ci} (${database})`);
      // a derived table's constant read through the table around it: the fold makes `s.one` the literal, an ordinal to the
      // sort below it (the re-check of ca748c6: ids 2000, 1999, 1998 where Postgres answers 1, 2, 3); by name and number too
      for (const k of ["1", "2", "'x'", "true"]) {
        for (const order of ["s.one DESC, s.id", "s.one, s.id DESC", "one DESC, s.id", "2, s.id DESC", "s.one, 2 DESC, s.id"]) {
          const sql = `SELECT s.id, s.one FROM (SELECT l.id, c.name, ${k} AS one FROM late l LEFT JOIN late_c c ON c.id = l.c) s ORDER BY ${order} LIMIT 3`;
          assert.deepEqual(await answer(c, sql), await postgres(sql), `${sql} (${database})`);
        }
      }
      // a chain of casts is no constant: it runs, and raises as Postgres's does
      const chain = "SELECT l.id FROM late l ORDER BY 'abc'::text::int, l.id LIMIT 3";
      await assert.rejects(postgres(chain), /invalid input syntax for type integer: "abc"/);
      await assert.rejects(c.query(chain), (e: pg.DatabaseError) => e.code === "22P02", `${chain} (${database})`);
      // a cast of a typed literal Postgres evaluates at planning, and raises there: no constant, it is evaluated and raises
      for (const sql of ["SELECT l.id FROM late l ORDER BY 2147483648::int, l.id LIMIT 3",
        "SELECT l.id FROM late l ORDER BY (2147483648::int), l.id LIMIT 3",
        "SELECT l.id FROM late l ORDER BY 12345::numeric(3), l.id LIMIT 3",
        "SELECT s.id FROM (SELECT l.id, c.name, 2147483648::int AS one FROM late l LEFT JOIN late_c c ON c.id = l.c) s ORDER BY s.one, s.id LIMIT 3"]) {
        const code = await postgres(sql).then(() => "answered", (e: { code?: string }) => e.code);
        assert.equal(code, "22003", sql);
        await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === code, `${sql} (${database})`);
      }
    }
  } finally { await bytes.end(); await onLibc.end(); await libc.close(); }
});

// THE CLASS ROUND (PR 170, a fact derived in several places: whether a sort key is constant). Five findings in four
// rounds were each a spelling `constantKey` matched or missed (the last: `1.5::numeric`, a CONST to Postgres, written as
// the bare 1.5 DuckDB refuses, 42804). A key is constant where Postgres's ANALYSIS put a Const, read in one place; every
// spelling of the class is held here against Postgres, as the key itself, by output name and by number, under each shape
const constantKeys = [
  // a cast of an untyped literal: folded by the analysis into a Const
  "'x'::text", "'1.5'::numeric", "NULL::int", "NULL::text",
  // a cast of a typed literal to its own type leaves the Const (int, numeric, bool); to another type it is a function
  // Postgres evaluates (at planning: folded there, and it could raise there)
  "1::int", "1::bigint", "1.5::numeric", "0.5::numeric", "1.5::decimal", "1.5::numeric(3,1)", "1.5::float8", "true::bool",
  "'x'::text::text", "'x'::text::varchar",
  // a chain of casts
  "'1.5'::numeric::numeric", "1.5::numeric::float8", "1::int::bigint", "'1.5'::text::numeric", "'2'::text::int",
  // COLLATE, parentheses
  "'x' COLLATE \"C\"", "'x'::text COLLATE \"C\"", "(1.5::numeric)", "((1.5)::numeric)", "('x'::text)",
  // a constant expression: Postgres folds it at planning
  "1 + 0", "1.5::numeric + 0",
];
test("a constant sort key is the analysis's Const, however it is spelled: the key, its output's name and number, under every shape", async () => {
  const c = await client();
  const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((r) => r, (e: { code?: string }) => ({ error: e.code }));
  const wrong: string[] = [];
  const alike = async (sql: string, values?: unknown[]): Promise<void> => {
    const [mason, pg] = [await outcome(answer(c, sql, values)), await outcome(postgres(sql, values))];
    try { assert.deepEqual(mason, pg); } catch { wrong.push(`${sql}${values !== undefined ? ` ${JSON.stringify(values)}` : ""}: Mason ${JSON.stringify(mason)}, Postgres ${JSON.stringify(pg)}`); }
  };
  try {
    for (const k of constantKeys) {
      for (const sql of [
        // the key itself: one table (afterLimit), DESC, the join (joinRows), a computed list, the GROUP BY form
        // (keyFirst), DISTINCT ON, WITH TIES, no LIMIT
        `SELECT l.id, l.k FROM late l ORDER BY ${k}, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k FROM late l ORDER BY ${k} DESC, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k FROM late l JOIN late_c c ON c.id = l.c ORDER BY ${k}, l.id DESC LIMIT 3`,
        `SELECT l.id, l.j ->> 'n' AS n FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY ${k} DESC, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k, count(*) AS n FROM late l GROUP BY l.id ORDER BY ${k}, l.id DESC LIMIT 3`,
        `SELECT DISTINCT ON (l.c) l.c, l.id FROM late l ORDER BY l.c DESC, ${k}, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k FROM late l ORDER BY ${k}, l.k FETCH FIRST 3 ROWS WITH TIES`,
        `SELECT l.id, l.k FROM late l WHERE l.id < 5 ORDER BY ${k}, l.id DESC`,
        // by output name and by number
        `SELECT l.id, l.k, ${k} AS v FROM late l ORDER BY v, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k, ${k} AS v FROM late l ORDER BY 3 DESC, 1 DESC LIMIT 3`,
        `SELECT l.id, l.k, ${k} AS v FROM late l JOIN late_c c ON c.id = l.c ORDER BY v DESC, l.id DESC LIMIT 3`,
        `SELECT l.id, l.k, ${k} AS v, count(*) AS n FROM late l GROUP BY l.id ORDER BY 3, 1 DESC LIMIT 3`,
        `SELECT l.id, l.k, ${k} AS v FROM late l WHERE l.id < 5 ORDER BY 3, l.id DESC`,
        // at depth, and a derived table's constant read through the table around it (late.ts's fold)
        `SELECT s.id FROM (SELECT l.id, ${k} AS v FROM late l ORDER BY v DESC, l.id LIMIT 4) s ORDER BY s.id`,
        `SELECT s.id, s.one FROM (SELECT l.id, c.name, ${k} AS one FROM late l LEFT JOIN late_c c ON c.id = l.c) s ORDER BY s.one, s.id DESC LIMIT 3`,
        `SELECT s.id, s.one FROM (SELECT l.id, c.name, ${k} AS one FROM late l LEFT JOIN late_c c ON c.id = l.c) s ORDER BY 2 DESC, s.id DESC LIMIT 3`,
      ]) await alike(sql);
    }
    // a bare literal or NULL as the key itself is Postgres's own refusal (42601) or an ordinal; by name and number it is a constant
    for (const k of ["1.5", "'x'", "NULL", "true", "(1.5)", "(2)"]) {
      await alike(`SELECT l.id, l.k FROM late l ORDER BY ${k}, l.id DESC LIMIT 3`);
      await alike(`SELECT l.id, l.k, ${k} AS v FROM late l ORDER BY v, l.id DESC LIMIT 3`);
      await alike(`SELECT l.id, l.k, ${k} AS v FROM late l JOIN late_c c ON c.id = l.c ORDER BY 3, l.id DESC LIMIT 3`);
    }
    // a parameter: a Param to the analysis, evaluated, ordering nothing whatever its value
    for (const [k, v] of [["$1", "2"], ["$1::int", 2], ["$1::numeric", "1.5"], ["$1::text", "x"]] as const) {
      await alike(`SELECT l.id, l.k FROM late l ORDER BY ${k}, l.id DESC LIMIT 3`, [v]);
      await alike(`SELECT l.id, l.k FROM late l JOIN late_c c ON c.id = l.c ORDER BY ${k}, l.id DESC LIMIT 3`, [v]);
      await alike(`SELECT l.id, l.k FROM late l WHERE l.id < 5 ORDER BY ${k}, l.id DESC`, [v]);
    }
    // a key Postgres evaluates at planning, and raises there: evaluated, never dropped as a constant nor read as an ordinal
    for (const k of ["2147483648::int", "12345::numeric(3)", "'abc'::text::int", "'abc'::text::numeric", "1 / 0", "(2147483648::int)"]) {
      await alike(`SELECT l.id FROM late l ORDER BY ${k}, l.id LIMIT 3`);
      await alike(`SELECT l.id, ${k} AS v FROM late l JOIN late_c c ON c.id = l.c ORDER BY v, l.id LIMIT 3`);
      await alike(`SELECT s.id FROM (SELECT l.id, c.name, ${k} AS one FROM late l LEFT JOIN late_c c ON c.id = l.c) s ORDER BY s.one, s.id LIMIT 3`);
    }
    assert.deepEqual(wrong, []);
  } finally { await c.end(); }
});

// THE SECOND CLASS ROUND (PR 170, the class widened: a constant key written into the engine as a bare literal, in ANY
// clause). The sixth finding was a DISTINCT ON key (`DISTINCT ON (1.5::numeric)`, a Const to Postgres, written as the
// bare 1.5 the engine refuses, 42804). Every clause where a key can be an analysed Const is held here against Postgres
const constantKeysAnyClause = ["1.5::numeric", "'1.5'::numeric", "(1.5::numeric)", "1::int", "'x'::text", "NULL::int"];
test("a constant key in any clause is the analysis's Const: DISTINCT ON, GROUP BY, grouping sets, a window, a set operation, an aggregate's ORDER BY", async () => {
  const c = await client();
  const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((r) => r, (e: { code?: string }) => ({ error: e.code }));
  const wrong: string[] = [];
  const alike = async (sql: string, values?: unknown[]): Promise<void> => {
    const [mason, pg] = [await outcome(answer(c, sql, values)), await outcome(postgres(sql, values))];
    try { assert.deepEqual(mason, pg); } catch { wrong.push(`${sql}${values !== undefined ? ` ${JSON.stringify(values)}` : ""}: Mason ${JSON.stringify(mason)}, Postgres ${JSON.stringify(pg)}`); }
  };
  try {
    for (const k of constantKeysAnyClause) {
      for (const sql of [
        // A. DISTINCT ON: the key alone (one row), beside a column key, by output number and name, no LIMIT, at depth
        `SELECT DISTINCT ON (${k}) l.id FROM late l ORDER BY ${k}, l.id DESC LIMIT 3`,
        `SELECT DISTINCT ON (${k}) l.id FROM late l ORDER BY ${k}, l.id LIMIT 3`,
        `SELECT DISTINCT ON (${k}, l.c) l.c, l.id FROM late l ORDER BY ${k}, l.c DESC, l.id LIMIT 3`,
        `SELECT DISTINCT ON (l.c, ${k}) l.c, l.id FROM late l ORDER BY l.c, ${k}, l.id DESC LIMIT 3`,
        `SELECT DISTINCT ON (2) l.id, ${k} AS v FROM late l ORDER BY 2, l.id DESC LIMIT 3`,
        `SELECT DISTINCT ON (v, l.c) l.c, ${k} AS v, l.id FROM late l ORDER BY v, l.c DESC, l.id LIMIT 3`,
        `SELECT DISTINCT ON (${k}, l.c) l.c, l.id FROM late l WHERE l.id < 120 ORDER BY ${k}, l.c, l.id DESC`,
        `SELECT count(*) FROM (SELECT DISTINCT ON (${k}) l.id FROM late l) s`,
        // B. GROUP BY: by expression alone (one group) and beside a column, by number, by output name, the key-first form
        `SELECT count(*) AS n FROM late l GROUP BY ${k}`,
        `SELECT l.c, count(*) AS n FROM late l GROUP BY ${k}, l.c ORDER BY l.c DESC LIMIT 3`,
        `SELECT ${k} AS v, count(*) FROM late l GROUP BY 1`,
        `SELECT ${k} AS v, l.c, count(*) FROM late l GROUP BY v, 2 ORDER BY 2 LIMIT 3`,
        `SELECT l.id, l.k FROM late l GROUP BY l.id, ${k} ORDER BY l.id DESC LIMIT 3`,
        // C. grouping sets: ROLLUP, CUBE, GROUPING SETS with a constant key beside a column
        `SELECT l.c, count(*) FROM late l WHERE l.c < 3 GROUP BY ROLLUP (${k}, l.c) ORDER BY 1 NULLS FIRST, 2`,
        `SELECT l.c, count(*) FROM late l WHERE l.c < 3 GROUP BY CUBE (${k}, l.c) ORDER BY 1 NULLS FIRST, 2`,
        `SELECT l.c, count(*) FROM late l WHERE l.c < 3 GROUP BY GROUPING SETS ((${k}), (l.c), ()) ORDER BY 1 NULLS FIRST, 2`,
        // D. a window's ORDER BY: alone (every row a peer) and before a column
        `SELECT l.id, row_number() OVER (ORDER BY ${k}, l.id DESC) AS r FROM late l ORDER BY l.id LIMIT 3`,
        `SELECT l.id, sum(l.k) OVER (ORDER BY ${k}) AS s, rank() OVER (ORDER BY ${k}) AS r FROM late l WHERE l.id < 10 ORDER BY l.id`,
        // E. a window's PARTITION BY: alone, beside a column, a named window
        `SELECT l.id, count(*) OVER (PARTITION BY ${k}) AS n FROM late l WHERE l.id < 5 ORDER BY 1`,
        `SELECT l.id, row_number() OVER (PARTITION BY ${k}, l.c ORDER BY l.id) AS r FROM late l WHERE l.id < 120 ORDER BY 1 DESC LIMIT 3`,
        `SELECT l.id, sum(l.k) OVER w AS s FROM late l WHERE l.id < 5 WINDOW w AS (PARTITION BY ${k} ORDER BY ${k}, l.id) ORDER BY 1`,
        // H. a set operation's ORDER BY, by number and by name of an output each branch makes a constant
        `SELECT l.id, ${k} AS v FROM late l WHERE l.id < 3 UNION ALL SELECT l.id, ${k} FROM late l WHERE l.id > 1998 ORDER BY 2, 1 DESC LIMIT 3`,
        `SELECT l.id, ${k} AS v FROM late l WHERE l.id < 3 UNION SELECT l.id, ${k} FROM late l WHERE l.id > 1998 ORDER BY v DESC, id LIMIT 3`,
        // I. an aggregate's ORDER BY (an integer there is no ordinal to Postgres); J. an ordered-set aggregate's
        `SELECT string_agg(l.id::text, ',' ORDER BY ${k}, l.id DESC) AS s FROM late l WHERE l.id < 5`,
        `SELECT l.c, array_agg(l.id ORDER BY ${k}, l.id DESC)::text AS a FROM late l WHERE l.id < 120 GROUP BY l.c ORDER BY 1 LIMIT 3`,
        `SELECT string_agg(DISTINCT ${k}::text, ',') AS s FROM late l`, `SELECT array_length(array_agg(DISTINCT ${k}), 1) AS a, array_agg(DISTINCT ${k}) IS NULL AS b FROM late l`,
        `SELECT mode() WITHIN GROUP (ORDER BY ${k}) AS m FROM late l`,
        `SELECT l.c, mode() WITHIN GROUP (ORDER BY ${k}) AS m, percentile_disc(0.5) WITHIN GROUP (ORDER BY ${k}) AS p FROM late l WHERE l.id < 120 GROUP BY l.c ORDER BY 1 LIMIT 3`,
        `SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY ${k}) AS p FROM late l WHERE l.id < 0`,
      ]) await alike(sql);
    }
    // a bare literal as a DISTINCT ON or GROUP BY key is Postgres's own refusal (42601), or an ordinal
    for (const k of ["1.5", "'x'", "(1.5)", "NULL"]) {
      await alike(`SELECT DISTINCT ON (${k}) l.id FROM late l ORDER BY l.id LIMIT 3`);
      await alike(`SELECT count(*) FROM late l GROUP BY ${k}`);
    }
    // a parameter: evaluated, partitioning and ordering nothing whatever its value (never an ordinal)
    for (const [k, v] of [["$1::numeric", "1.5"], ["$1::int", 1], ["$1::text", "x"]] as const) {
      await alike(`SELECT DISTINCT ON (${k}, l.c) l.c, l.id FROM late l ORDER BY ${k}, l.c DESC, l.id LIMIT 3`, [v]);
      await alike(`SELECT l.id, count(*) OVER (PARTITION BY ${k}) AS n FROM late l WHERE l.id < 5 ORDER BY 1`, [v]);
      await alike(`SELECT string_agg(l.id::text, ',' ORDER BY ${k}, l.id DESC) AS s FROM late l WHERE l.id < 5`, [v]);
    }
    // F. a window's frame offset spelled as a cast: a value, never a key
    await alike("SELECT l.id, sum(l.k) OVER (ORDER BY l.id ROWS BETWEEN 1::int PRECEDING AND CURRENT ROW) AS s FROM late l WHERE l.id < 5 ORDER BY 1");
    await alike("SELECT l.id, sum(l.k) OVER (ORDER BY l.id::numeric RANGE BETWEEN 1.5::numeric PRECEDING AND CURRENT ROW) AS s FROM late l WHERE l.id < 5 ORDER BY 1");
    assert.deepEqual(wrong, []);
  } finally { await c.end(); }
});

// THE THIRD CLASS ROUND (PR 170; CI's oracle leg 2 and the review): a key Postgres binds to an output, or to another
// clause's key, by EQUALITY OF THE ANALYSED EXPRESSIONS (findTargetlistEntrySQL99) has no node of its own at its offset.
// Spelled unlike the expression it equals (`'1.5'::numeric` beside `1.5::numeric AS v`), a syntactic match missed it, no
// analysis was read there, and the constant was written bare: 42804, or an integer read as an ordinal. The second
// instance of the class "an output not resolved to its column"; the case list is PR 170's (K1-K8, N1-N3)
const equalSpellings = { numeric: ["1.5::numeric", "'1.5'::numeric", "CAST('1.5' AS numeric)", "numeric '1.5'", "CAST(1.5 AS numeric)"], int: ["1::int", "'1'::int", "CAST(1 AS int)", "int '1'"] };
test("a key equal to an output or another key by the analysis is resolved to it, however each is spelled", async () => {
  const c = await client();
  const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((r) => r, (e: { code?: string }) => ({ error: e.code }));
  const wrong: string[] = [];
  const alike = async (sql: string): Promise<void> => {
    const [mason, pg] = [await outcome(answer(c, sql)), await outcome(postgres(sql))];
    try { assert.deepEqual(mason, pg); } catch { wrong.push(`${sql}: Mason ${JSON.stringify(mason)}, Postgres ${JSON.stringify(pg)}`); }
  };
  try {
    for (const spellings of Object.values(equalSpellings)) {
      for (const out of spellings) {
        for (const key of spellings) {
          if (key === out) continue;
          // K1-K3: ORDER BY against an output, plain, under a join, under GROUP BY, at depth
          await alike(`SELECT l.id, ${out} AS v FROM late l ORDER BY ${key}, l.id DESC LIMIT 3`);
          await alike(`SELECT l.id, ${out} AS v FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY ${key}, l.id DESC LIMIT 3`);
          await alike(`SELECT l.c, ${out} AS v, count(*) AS n FROM late l GROUP BY l.c ORDER BY ${key}, l.c DESC LIMIT 3`);
          await alike(`SELECT s.id FROM (SELECT l.id, ${out} AS v FROM late l ORDER BY ${key}, l.id DESC LIMIT 3) s ORDER BY s.id`);
          // K4: a key against a key of the same clause
          await alike(`SELECT l.id FROM late l ORDER BY ${out}, ${key}, l.id DESC LIMIT 3`);
          // K5, K6: DISTINCT ON against an output, against the ORDER BY's key, the ORDER BY by expression and by number
          await alike(`SELECT DISTINCT ON (${key}, l.c) l.c, ${out} AS v, l.id FROM late l ORDER BY ${out}, l.c DESC, l.id LIMIT 3`);
          await alike(`SELECT DISTINCT ON (${key}, l.c) l.c, ${out} AS v, l.id FROM late l ORDER BY 2, l.c DESC, l.id LIMIT 3`);
          await alike(`SELECT DISTINCT ON (${key}, l.c) l.c, l.id FROM late l ORDER BY ${out}, l.c DESC, l.id LIMIT 3`);
          await alike(`SELECT DISTINCT ON (l.c, ${key}) l.c, l.id FROM late l ORDER BY l.c DESC, ${out}, l.id LIMIT 3`);
          // K7: an aggregate's ORDER BY against its argument
          await alike(`SELECT l.c, (array_agg(${out} ORDER BY ${key}, l.id DESC))[1] AS a, count(*) AS n FROM late l GROUP BY l.c ORDER BY 1 LIMIT 3`);
          // K8: the fold, a wrapper's key against its output over a derived table
          await alike(`SELECT s.id, ${out} AS k FROM (SELECT l.id, l.c FROM late l) s ORDER BY ${key}, s.id DESC LIMIT 3`);
          await alike(`SELECT s.id, s.v FROM (SELECT l.id, ${out} AS v FROM late l) s ORDER BY ${key}, s.id DESC LIMIT 3`);
        }
      }
    }
    // N1-N3: an expression equal to an output, no constant: it still orders, as the output it is
    for (const sql of [
      "SELECT c, l.id FROM late l ORDER BY l.c DESC, l.id LIMIT 3",
      "SELECT l.c, id FROM late l ORDER BY c DESC, l.id DESC LIMIT 3",
      "SELECT DISTINCT ON (l.c) c, l.id FROM late l ORDER BY c DESC, l.id DESC LIMIT 3",
      "SELECT DISTINCT ON (c) l.c, l.id FROM late l ORDER BY l.c DESC, l.id LIMIT 3",
      "SELECT l.id, l.id::numeric + 1.5 AS v FROM late l ORDER BY l.id + 1.5 DESC LIMIT 3",
      "SELECT l.id, l.id + 1.5 AS v FROM late l ORDER BY l.id::numeric + 1.5 DESC LIMIT 3",
      "SELECT DISTINCT ON (l.id + 1.5) l.id, l.id::numeric + 1.5 AS v FROM late l ORDER BY l.id::numeric + 1.5 DESC LIMIT 3",
      "SELECT name, c.id FROM late_c c ORDER BY c.name DESC LIMIT 3",
      "SELECT c.name, id FROM late_c c ORDER BY name COLLATE \"C\" DESC, c.id LIMIT 3",
      // a Const output beside an equal-by-analysis column key: the Const is dropped, the column orders
      "SELECT l.id, 1.5::numeric AS v, c FROM late l ORDER BY '1.5'::numeric, l.c DESC, id DESC LIMIT 3",
      // K8, the fold: a derived table's Const column read by a key spelled unlike the wrapper's output (a cast to its own
      // type is the column to Postgres), which the fold makes the literal
      ...["1 AS one", "'x'::text AS one", "1.5::numeric AS one"].flatMap((one) => [
        `SELECT s.id, s.one FROM (SELECT l.id, ${one} FROM late l) s ORDER BY CAST(s.one AS ${one.includes("'") ? "text" : one.includes(".") ? "numeric" : "int"}), s.id DESC LIMIT 3`,
        `SELECT s.id, s.one AS w FROM (SELECT l.id, ${one} FROM late l) s ORDER BY (one), s.id DESC LIMIT 3`,
        `SELECT s.id, one FROM (SELECT l.id, ${one} FROM late l) s ORDER BY s.one, 1 DESC LIMIT 3`,
      ]),
    ]) await alike(sql);
    assert.deepEqual(wrong, []);
  } finally { await c.end(); }
});

// ISSUE 112: an output's number or bare name beside a * reached the engine as written: no rule met the column it is
test("an output of a * is read by its number and its bare name as the column it is", async () => {
  const c = await client();
  try {
    const alike = async (sql: string): Promise<void> => assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // a citext without regard to case, through a * alone or before another target (whose number is past the list's)
    await alike("SELECT * FROM accounts ORDER BY 2, 1");
    await alike("SELECT * FROM accounts ORDER BY status DESC, id LIMIT 2");
    await alike("SELECT *, id FROM accounts ORDER BY 2, 1");
    await alike("SELECT id AS key, * FROM accounts ORDER BY 3, 1");
    await alike("SELECT a.*, b.team FROM accounts a JOIN accounts b ON b.id = a.id ORDER BY 2, 5");
    await alike("SELECT DISTINCT ON (4) * FROM accounts ORDER BY 4, 1");
    await assert.rejects(c.query("SELECT DISTINCT ON (2) * FROM accounts ORDER BY 2, 1"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap citext-forms/.test(e.detail ?? ""));
    await alike("WITH w AS (SELECT id, status FROM accounts) SELECT * FROM w ORDER BY 2, 1");
    // a column USING merged is listed first, whatever the place it has in its table
    await alike("SELECT * FROM accounts a JOIN (SELECT team, id * 2 AS twice FROM accounts) b USING (team) ORDER BY 1, 2");
    await alike("SELECT * FROM accounts a NATURAL JOIN (SELECT team, 1 AS k FROM accounts) b ORDER BY 2");
    // a primary key's GROUP BY decides the *: read column by column, a sort by one of them
    await alike("SELECT * FROM accounts GROUP BY id ORDER BY status, id");
    await alike("SELECT * FROM accounts GROUP BY 1 ORDER BY 2, 1");
    await alike("SELECT *, count(*) FROM accounts GROUP BY id ORDER BY 5, 2, 1");
    // keys that are not the *'s leading columns in order: its columns stay in their places
    await alike("SELECT * FROM accounts GROUP BY team, id ORDER BY 1");
    await alike("SELECT * FROM accounts GROUP BY team, ip, id ORDER BY 1");
    await assert.rejects(c.query("SELECT * FROM accounts GROUP BY team, ip, status, id ORDER BY 1"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap citext-forms/.test(e.detail ?? ""));
    await alike("SELECT a.*, count(*) FROM accounts a GROUP BY a.id, a.team ORDER BY 1");
    await alike("SELECT * FROM accounts GROUP BY 4, 1 ORDER BY 1");
    await alike("SELECT id, * FROM accounts GROUP BY id ORDER BY 1");
    await alike("SELECT *, id AS again FROM accounts GROUP BY team, id ORDER BY 5");
    await alike("SELECT *, * FROM (SELECT id, team FROM accounts) s GROUP BY team, id ORDER BY 2");
    await alike("SELECT b.*, a.* FROM accounts a JOIN accounts b ON b.id = a.id GROUP BY a.id, b.id ORDER BY 1");
    // a set operation's citext by its number, of a * and of a named column
    await alike("SELECT * FROM accounts UNION ALL SELECT * FROM accounts ORDER BY 2, 1");
    await alike("SELECT id, status FROM accounts UNION ALL SELECT id, status FROM accounts ORDER BY 2, 1");
    // a DISTINCT ON compares its keys alone: a citext beside them is only read
    await alike("SELECT DISTINCT ON (1) * FROM accounts a JOIN late_c c USING (id) ORDER BY 1, 2");
    await alike("SELECT DISTINCT ON (id) id, status FROM accounts ORDER BY id");
    // a * in a subquery of a target is its own SELECT's, whatever the outer list holds
    await alike("SELECT o.id, (SELECT x.team FROM (SELECT * FROM accounts ORDER BY 1 LIMIT 1) x) FROM orders o ORDER BY 1");
    await alike("SELECT o.id, (SELECT b.* FROM (SELECT team FROM accounts) b ORDER BY 1 DESC LIMIT 1) FROM orders o ORDER BY 1");
    await alike("SELECT o.id, (SELECT count(*) FROM (SELECT *, 1 FROM (SELECT id, team FROM accounts) s GROUP BY team, id) x) FROM orders o ORDER BY 1");
    await alike("SELECT o.id, ARRAY(SELECT x.team FROM (SELECT * FROM accounts GROUP BY team, id) x ORDER BY x.id) FROM orders o ORDER BY 1");
    await alike("SELECT o.id, EXISTS (SELECT * FROM (SELECT * FROM accounts GROUP BY team, id) x WHERE x.id = o.id), o.id IN (SELECT x.id FROM (SELECT * FROM accounts GROUP BY team, id) x) FROM orders o ORDER BY 1");
    await alike("SELECT o.id, CASE WHEN o.id > 1 THEN (SELECT x.team FROM (SELECT * FROM accounts GROUP BY team, id) x ORDER BY x.id LIMIT 1) END FROM orders o ORDER BY 1");
    await alike("SELECT o.id, (SELECT x.id FROM (SELECT * FROM accounts UNION ALL SELECT * FROM accounts ORDER BY 2, 1 LIMIT 1) x) FROM orders o ORDER BY 1");
    await alike("SELECT o.id, (SELECT x.team FROM (SELECT * FROM accounts a NATURAL JOIN (SELECT team, 1 AS k FROM accounts) b ORDER BY 2 LIMIT 1) x) FROM orders o ORDER BY 1");
    // an output named past the *: the group by its own number
    await alike("SELECT *, length(team) AS size FROM (SELECT team FROM accounts) s GROUP BY team, size ORDER BY 2 DESC, 1");
    // a name two outputs answer to, Postgres's refusal
    await assert.rejects(c.query("SELECT * FROM accounts a JOIN accounts b ON b.id = a.id ORDER BY team"), (e: pg.DatabaseError) => e.code === "42702");
    // two columns of one name a join's own name hides, which no name tells apart
    for (const sql of ["SELECT j.* FROM (accounts a JOIN accounts b ON b.id = a.id) AS j ORDER BY 1", "SELECT j.* FROM (accounts a JOIN accounts b USING (team)) AS j"]) {
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap star-join-twin/.test(e.detail ?? ""), sql);
    }
    // a set operation's number of a *, its name told once: answered; told twice: refused
    await alike("SELECT * FROM (SELECT id, status FROM orders) s UNION SELECT id, status FROM orders ORDER BY 2, 1");
    await assert.rejects(c.query("SELECT *, status FROM (SELECT id, status FROM orders) s UNION SELECT id, status, status FROM orders ORDER BY 2, 1"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap setop-ordinal-star/.test(e.detail ?? ""));
    // a number in a prepared statement run after a SET
    await c.query({ name: "starred", text: "SELECT * FROM accounts ORDER BY 2, 1" });
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual((await c.query({ name: "starred", text: "SELECT * FROM accounts ORDER BY 2, 1", rowMode: "array" })).rows.map((r) => r[0]), (await postgres("SELECT * FROM accounts ORDER BY 2, 1")).rows.map((r) => Number(r[0])));
  } finally { await c.end(); }
});

// ISSUE 105: a table preview over joined tables carried every row's wide columns through the join and the top N to
// choose 100, and its spill filled the disk. The rows are chosen by row number, the columns read for those alone
// ISSUE 134, STEP 3: a merged column is read through Postgres's join alias variables; a computed key is the output it is,
// one value; a volatile value is never computed twice
test("USING and NATURAL choose their rows by row number, and a merged column is read as the join kind reads it", async () => {
  const c = await client();
  const held = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => r.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : v)) });
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  const each = async (form: RegExp, sql: string): Promise<void> => {
    assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
    assert.match(await sent(sql), form, sql);
  };
  const ROWS = /(rowid|__mason_rid) AS __mason_r1.*\) AS __mason_late LEFT JOIN /;
  try {
    // inner and LEFT read the left side, RIGHT the right, FULL both: a fetch of the other side would read NULL
    const merged = [["JOIN", /SELECT l\.id AS id, /], ["LEFT JOIN", /SELECT l\.id AS id, /], ["RIGHT JOIN", /SELECT lc\.id AS id, /], ["FULL JOIN", /SELECT COALESCE\(l\.id, lc\.id\) AS id, /]] as const;
    for (const [join, read] of merged) {
      const sql = `SELECT id, l.k, lc.name FROM late l ${join} late_c lc USING (id) ORDER BY id DESC NULLS LAST, l.k LIMIT 3 OFFSET 40`;
      await each(ROWS, sql);
      assert.match(await sent(sql), read, sql);
      assert.match(await sent(sql), /FROM late AS l .*JOIN late_c AS lc USING \(id\)/, `the join stays as it was written, inside: ${sql}`);
    }
    // the rows come from a side the other has not: NULLs on either side of a FULL join, sorted by the merged column
    await each(ROWS, "SELECT id, l.k, lc.name FROM late l FULL JOIN (SELECT id + 45 AS id, name FROM late_c) lc USING (id) ORDER BY id NULLS FIRST, l.k LIMIT 8 OFFSET 40");
    // a `*` lists the merged column first, once
    await each(ROWS, "SELECT * FROM late l JOIN late_c lc USING (id) ORDER BY id LIMIT 2");
    await each(ROWS, "SELECT * FROM late_p p NATURAL JOIN (SELECT c, k FROM late WHERE id < 5) l ORDER BY c, line LIMIT 2");
    // NATURAL as the columns Postgres found: none in common is every pair, where DuckDB takes it for a mistake
    await each(/JOIN late_n USING \(id, c\)/, "SELECT id, c, k FROM late NATURAL JOIN late_n ORDER BY id LIMIT 2");
    for (const sql of ["SELECT l.id, lc.c, lc.note FROM late_c l NATURAL JOIN late_p lc ORDER BY l.id, lc.c, lc.line LIMIT 3",
      "SELECT l.id, lc.c FROM late_c l NATURAL LEFT JOIN late_p lc ORDER BY l.id DESC, lc.c, lc.line LIMIT 3"]) await each(/late_p AS lc ON true/, sql);
    assert.equal((await answer(c, "SELECT l.id FROM late_c l NATURAL JOIN late_p lc LIMIT 3")).rows.length, 3, "a NATURAL of nothing in common, no sort");
    // two joins of one name: the outer one's, each join kind through the other
    await each(ROWS, "SELECT id, l.k, x.name, p.name AS other FROM late l LEFT JOIN late_c x USING (id) RIGHT JOIN late_c p USING (id) ORDER BY id LIMIT 3");
    // a USING between types: the cast the join adds, and an int's text under a numeric
    await each(/CAST\(lc\.id AS int8\)|lc\.id::int8/, "SELECT id, o.status FROM late_c lc LEFT JOIN orders o USING (id) ORDER BY id LIMIT 2");
    // (an inner join needs none: Postgres reads the side of the type already)
    await each(/SELECT o\.id AS id, /, "SELECT id, o.status FROM late_c lc JOIN orders o USING (id) ORDER BY id LIMIT 2");
    await each(/COALESCE\((CAST\(lc\.id AS int8\)|lc\.id::int8), o\.id\)/, "SELECT id, lc.name, o.status FROM late_c lc FULL JOIN orders o USING (id) ORDER BY id LIMIT 2");
    // an output's name before the merged column it shadows, a column of a side read apart
    await each(ROWS, "SELECT lc.name AS id, l.id AS l FROM late l JOIN late_c lc USING (id) ORDER BY id DESC, l LIMIT 2");
    await each(ROWS, "SELECT id, lc.id AS r, l.id AS l FROM late l RIGHT JOIN late_c lc USING (id) ORDER BY id LIMIT 2");
    // a wrapper and a view of one fold, and a role is held in tests/duck-roles-barrier-wire.test.ts
    await each(ROWS, "SELECT * FROM (SELECT * FROM late l JOIN late_c lc USING (id)) t ORDER BY id LIMIT 2");
    // a join's own name is read by that name: it stays as it was
    for (const sql of ["SELECT j.id FROM (late l JOIN late_c lc USING (id)) AS j ORDER BY j.id LIMIT 2"]) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
      assert.doesNotMatch(await sent(sql), /__mason_r1/, sql);
    }
  } finally { await c.end(); }
});

test("a NATURAL JOIN is the columns Postgres merged in every statement, none in common every pair, with or without a LIMIT", async () => {
  const c = await client();
  const each = async (form: RegExp, sql: string): Promise<void> => {
    assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    assert.match(line, form, sql);
    assert.doesNotMatch(line, /NATURAL/, sql);
  };
  try {
    // nothing in common: DuckDB refused the statement ("No columns found to join on") where Postgres pairs every row
    const NONE = /late_p AS lc ON true/;
    await each(NONE, "SELECT count(*) FROM late_c l NATURAL JOIN late_p lc");
    await each(NONE, "SELECT l.id FROM late_c l NATURAL JOIN late_p lc WHERE l.id < 3 ORDER BY l.id, lc.c, lc.line");
    await each(NONE, "SELECT 1 AS one FROM late_c l NATURAL JOIN late_p lc LIMIT 3");
    await each(NONE, "SELECT l.id, lc.c FROM late_c l NATURAL FULL JOIN late_p lc WHERE l.id < 2 ORDER BY 1, 2, lc.line");
    await each(NONE, "SELECT count(*) FROM late_c WHERE id IN (SELECT l.id FROM late_c l NATURAL JOIN late_p lc)");
    // columns in common, each join kind, and a `*` with the merged columns first
    const SOME = /late_n USING \(id, c\)/;
    for (const join of ["JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN"]) {
      await each(SOME, `SELECT id, c, l.k FROM late l NATURAL ${join} late_n WHERE id < 60 OR id IS NULL ORDER BY id, c`);
    }
    // (the merged columns in the left side's order, as Postgres lists them)
    await each(/late_n USING \(c, id\)/, "SELECT * FROM (SELECT k, c, id FROM late) l NATURAL FULL JOIN late_n ORDER BY id, c");
    await each(SOME, "SELECT count(*) FROM late NATURAL JOIN late_n");
  } finally {
    await c.end();
  }
});

test("a computed sort key is the output it spells, one value through every spelling, read from the key", async () => {
  const c = await client();
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  const FROM = "FROM late l JOIN late_c lc ON lc.id = l.c";
  const SHOWN = /SELECT __mason_late\.__mason_o1 AS x, .*AS __mason_o1, .*\) AS __mason_late LEFT JOIN /;
  try {
    // ONE OUTPUT, THREE SPELLINGS: the same statement inside and out, by name, ordinal and repeated expression
    const value = "l.k + 1";
    const spelled: string[] = [];
    for (const order of ["x", "1", value]) {
      for (const dir of ["", " DESC", " DESC NULLS LAST", " ASC NULLS FIRST"]) {
        const sql = `SELECT ${value} AS x, l.id, l.j ${FROM} ORDER BY ${order}${dir}, l.id LIMIT 3 OFFSET 1`;
        assert.deepEqual((await answer(c, sql)).rows.map((r) => r.slice(0, 2)), (await postgres(sql)).rows.map((r) => r.slice(0, 2)), sql);
        const line = await sent(sql);
        assert.match(line, SHOWN, sql);
        if (dir === "") spelled.push(line.replace(/^statement: [^—]*— /, ""));
      }
    }
    assert.equal(new Set(spelled).size, 1, `one output, one form: ${spelled.join("\n")}`);
    // the key beside a `*`, by a number past it, and a wrapper's output by name and by the qualified column: step 2 left these
    for (const sql of [`SELECT *, l.k + 1 AS x ${FROM} ORDER BY 7, 1 LIMIT 3`, `SELECT *, l.k + 1 AS x ${FROM} ORDER BY x, 1 LIMIT 3`,
      "SELECT t.x, t.id FROM (SELECT l.id, upper(lc.name) AS x, l.j FROM late l JOIN late_c lc ON lc.id = l.c) t ORDER BY x DESC, t.id LIMIT 2",
      "SELECT t.x, t.id FROM (SELECT l.id, upper(lc.name) AS x, l.j FROM late l JOIN late_c lc ON lc.id = l.c) t ORDER BY t.x DESC, t.id LIMIT 2",
      "SELECT id, shout FROM late_joined_again ORDER BY shout, id LIMIT 2"]) {
      assert.deepEqual((await answer(c, sql)).rows.map((r) => JSON.stringify(r)).length, (await postgres(sql)).rows.length, sql);
      assert.match(await sent(sql), /__mason_r1/, sql);
    }
    // a key of a table the list shows through the key alone: the table is not read again
    assert.doesNotMatch(await sent(`SELECT l.k + 1 AS x, lc.name ${FROM} ORDER BY x, 2 LIMIT 2`), /LEFT JOIN late /);
    // over one table a computed output is computed for every row anyway: as it was
    assert.doesNotMatch(await sent("SELECT l.k + 1 AS x, l.j FROM late l ORDER BY x LIMIT 2"), /__mason_late/);
    // a key that raises raises, on a row the LIMIT leaves out too: every row is sorted, as on Postgres
    await assert.rejects(answer(c, `SELECT 1 / (l.id - 2) AS x, l.j ${FROM} ORDER BY x LIMIT 1`), (e: pg.DatabaseError) => e.code === "22012");
    await assert.rejects(answer(c, `SELECT l.j ${FROM} ORDER BY 1 / (l.id - 2) LIMIT 1`), (e: pg.DatabaseError) => e.code === "22012");
  } finally { await c.end(); }
});

test("a volatile value a sort reads is one value: the rows shown are in the order of what they show", async () => {
  const c = await client();
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  const FROM = "FROM late l JOIN late_c lc ON lc.id = l.c";
  try {
    for (const order of ["r", "1", "random()"]) {
      for (const dir of ["", " DESC"]) {
        const sql = `SELECT random() AS r, l.id, l.j ${FROM} ORDER BY ${order}${dir} LIMIT 8`;
        const shown = (await c.query({ text: sql, rowMode: "array" })).rows.map((r: unknown[]) => r[0] as number);
        assert.equal(shown.length, 8, sql);
        assert.deepEqual(shown, [...shown].sort((a, b) => dir === "" ? a - b : b - a), `${sql}: the value shown is the value sorted`);
        const line = await sent(sql);
        assert.match(line, /SELECT __mason_late\.__mason_o1 AS r, /, sql);
        assert.match(line, /ORDER BY __mason_o1( DESC)? LIMIT 8 \) AS __mason_late/, `${sql}: said once, in the inner query`);
      }
    }
    // a key no output shows is sorted by its one value too
    assert.match(await sent(`SELECT l.id ${FROM} ORDER BY random() LIMIT 2`), /random\(\) AS __mason_o1 .*ORDER BY __mason_o1 LIMIT 2/);
    // a volatile output no sort reads is computed once, after the limit
    const list = await sent(`SELECT random() AS r, l.id ${FROM} ORDER BY l.id LIMIT 2`);
    assert.equal(list.match(/random\(\)/g)?.length, 1, list);
    // two of one expression are two values: a number takes the one it names
    const two = (await c.query({ text: `SELECT random() AS a, random() AS b, l.id ${FROM} ORDER BY 2 LIMIT 6`, rowMode: "array" })).rows.map((r: unknown[]) => r[1] as number);
    assert.deepEqual(two, [...two].sort((a, b) => a - b));
    // a volatile key a form cannot show as one value stays as it was: its sort is the collation's key of it, no output
    const stays = `SELECT random()::text COLLATE "und-x-icu" AS r, l.id ${FROM} ORDER BY r LIMIT 2`;
    assert.doesNotMatch(await sent(stays), /__mason_r1/);
    // now() is one value in any case, and the statement's clock
    const now = `SELECT now() AS t, l.id ${FROM} ORDER BY t, l.id LIMIT 3`;
    assert.equal(new Set((await c.query({ text: now, rowMode: "array", types: raw } as pg.QueryConfig)).rows.map((r: unknown[]) => r[0])).size, 1);
    assert.match(await sent(now), /__mason_r1/);
  } finally { await c.end(); }
});

// THE CLASS "AN OUTPUT NOT RESOLVED TO ITS COLUMN", its fourth round: a key bound to an output, by its alias, its number,
// an equal expression, an alias that is also an input column, or over a derived table, IS that output, written through
// the one binding in every clause (src/duck/rewrite.ts `keysBound`)
test("a key bound to an output is that output: by alias, number or an equal expression, in DISTINCT ON and ORDER BY", async () => {
  const c = await client();
  try {
    // (every statement is run, and those that differ named together: one report of the class, not its first case)
    const differ: string[] = [];
    const alike = async (sql: string): Promise<void> => {
      const [got, want] = [await answer(c, sql).catch((e: Error) => e.message), await postgres(sql)];
      if (!util.isDeepStrictEqual(got, want)) differ.push(sql);
    };
    // a jsonb output: DISTINCT ON is jsonb's equality (1, 1.0 and 1.00 one row), ORDER BY its order, however named
    const ON = "SELECT DISTINCT ON (k) q.v -> 'k' AS k, q.id FROM jq q";
    for (const sql of [
      `${ON} ORDER BY k, q.id LIMIT 8`,
      `${ON} ORDER BY k DESC, q.id`,
      `${ON} ORDER BY q.v -> 'k', q.id`,
      `${ON} ORDER BY 1, 2`,
      "SELECT DISTINCT ON (1) q.v -> 'k' AS k, q.id FROM jq q ORDER BY k, q.id",
      "SELECT DISTINCT ON (q.v -> 'k') q.v -> 'k' AS k, q.id FROM jq q ORDER BY k DESC, q.id",
      // an alias that is also an input column: an ORDER BY's and a DISTINCT ON's bare name is the output first
      "SELECT DISTINCT ON (v) q.v -> 'k' AS v, q.id FROM jq q ORDER BY v, q.id",
      "SELECT q.v -> 'k' AS v, q.id FROM jq q ORDER BY v DESC, q.id",
      "SELECT q.id % 3 AS id, q.id AS n FROM jq q ORDER BY id DESC, n",
      "SELECT DISTINCT ON (id) q.id % 3 AS id, q.id AS n FROM jq q ORDER BY id, n DESC",
      // GROUP BY's bare name is the input column, its ORDER BY's the output; and an expression equal to an output
      "SELECT q.id % 3 AS id, count(*) AS n FROM jq q GROUP BY id ORDER BY id DESC, n",
      "SELECT q.id % 3 AS g, count(*) AS n FROM jq q GROUP BY q.id % 3 ORDER BY q.id % 3 DESC",
      "SELECT q.v -> 'k' AS k, count(*) AS n FROM jq q GROUP BY 1 ORDER BY q.v -> 'k' DESC",
      // over a derived table
      "SELECT DISTINCT ON (s.k) s.k, s.id FROM (SELECT v -> 'k' AS k, id FROM jq) s ORDER BY s.k, s.id",
      "SELECT DISTINCT ON (k) s.k AS k, s.id FROM (SELECT v -> 'k' AS k, id FROM jq) s ORDER BY k DESC, s.id",
      // a citext output and a collated one, named by alias and by an equal expression
      "SELECT a.status AS s, a.id FROM accounts a ORDER BY s, a.id",
      "SELECT a.status AS s, a.id FROM accounts a ORDER BY a.status DESC, a.id",
      "SELECT t.s COLLATE \"und-x-icu\" AS s, t.id FROM texts t ORDER BY s, t.id",
      "SELECT t.s COLLATE \"und-x-icu\" AS x, t.id FROM texts t ORDER BY t.s COLLATE \"und-x-icu\" DESC, t.id",
      // EVERY READER OF THE SORT LIST reads a key as the SELECT's ORDER BY does, by name, number or equal expression:
      // WITH TIES's rank window (an ordinal there is a constant, every row a tie), late.ts's fetch under a join
      // (with an OFFSET: withTies read the offset node in two places, the detector below)
      ...["m", "1", "l.k % 5", "l.k % 5 + 0 DESC", "m DESC, 2"].flatMap((key) => [
        `SELECT count(*) FROM (SELECT l.k % 5 AS m, l.id FROM late l ORDER BY ${key} FETCH FIRST 3 ROWS WITH TIES) s`,
        `SELECT count(*) FROM (SELECT l.k % 5 AS m, l.id FROM late l ORDER BY ${key} OFFSET 2 FETCH FIRST 3 ROWS WITH TIES) s`,
        `SELECT l.k % 5 AS m, l.id, lc.name FROM late l JOIN late_c lc ON lc.id = l.c ORDER BY ${key}, l.id LIMIT 6`,
      ]),
      "SELECT count(*) FROM (SELECT l.k, l.id FROM late l ORDER BY 1 FETCH FIRST 3 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT l.k % 5 AS m, count(*) AS n FROM late l GROUP BY 1 ORDER BY 2 DESC, 1 FETCH FIRST 2 ROWS WITH TIES) s",
      // a key built over a grouped output: the collation's keys read the grouped value, by number, name or expression
      "SELECT t.s COLLATE \"und-x-icu\" AS x, count(*) AS n FROM texts t GROUP BY 1 ORDER BY 1",
      "SELECT t.s COLLATE \"und-x-icu\" AS x, count(*) AS n FROM texts t GROUP BY x ORDER BY x DESC",
      "SELECT t.s COLLATE \"und-x-icu\" AS x, count(*) AS n FROM texts t GROUP BY 1 ORDER BY t.s COLLATE \"und-x-icu\" DESC",
      "SELECT t.s AS x, count(*) AS n FROM texts t GROUP BY t.s ORDER BY t.s COLLATE \"und-x-icu\" DESC",
      "SELECT q.v -> 'k' AS k, count(*) AS n FROM jq q GROUP BY k ORDER BY k DESC",
    ]) await alike(sql);
    assert.deepEqual(differ, [], "each of these answers unlike Postgres");
    // a citext output grouped and ordered by its number or name: Postgres's answer, or refused as the citext it is
    for (const sql of ["SELECT a.status AS s, count(*) AS n FROM accounts a GROUP BY 1 ORDER BY 1", "SELECT a.status AS s, count(*) AS n FROM accounts a GROUP BY s ORDER BY s DESC"]) {
      const got = await answer(c, sql).catch((e: pg.DatabaseError) => e);
      if (got instanceof Error) assert.ok((got as pg.DatabaseError).code === "0A000" && /citext-forms/.test((got as pg.DatabaseError).detail ?? ""), `${sql}: ${got.message}`);
      else assert.deepEqual(got, await postgres(sql), sql);
    }
    // a citext output named by its alias in DISTINCT ON: refused as the citext it is, never DISTINCT by its text
    await assert.rejects(answer(c, "SELECT DISTINCT ON (s) a.status AS s, a.id FROM accounts a ORDER BY s, a.id"), (e: pg.DatabaseError) => e.code === "0A000" && /citext-forms/.test(e.detail ?? ""));
    // a volatile output: a key bound to it by equality is it, one value a row, so what is shown is what was sorted
    for (const sql of [
      "SELECT random() AS r, l.id FROM late l ORDER BY random() LIMIT 5",
      "SELECT random() AS r, l.id FROM late l ORDER BY random() DESC LIMIT 5",
      "SELECT random() AS r, l.id FROM late l ORDER BY random(), l.id LIMIT 5",
      "SELECT DISTINCT random() AS r FROM late l ORDER BY random() LIMIT 5",
      "SELECT s.r FROM (SELECT random() AS r, l.id FROM late l ORDER BY random() LIMIT 5) s",
    ]) {
      const shown = (await c.query({ text: sql, rowMode: "array" })).rows.map((r: unknown[]) => r[0] as number);
      assert.equal(shown.length, 5, sql);
      assert.deepEqual(shown, [...shown].sort((a, b) => sql.includes("DESC") ? b - a : a - b), `${sql}: the value shown is the value sorted`);
    }
    // WITH TIES over a volatile key: the key bound to the output is the output's one value (its column, never a second
    // random() in the window), and so is a key no output is (computed once, as a column of its own): no ties, 3 rows,
    // what is shown is what was ranked
    for (const key of ["r", "1", "random()", "r DESC", "1 DESC"]) {
      const sql = `SELECT random() AS r, l.id FROM late l ORDER BY ${key} FETCH FIRST 3 ROWS WITH TIES`;
      const shown = (await c.query({ text: sql, rowMode: "array" })).rows.map((r: unknown[]) => r[0] as number);
      assert.equal(shown.length, 3, sql);
      assert.deepEqual(shown, [...shown].sort((a, b) => sql.includes("DESC") ? b - a : a - b), `${sql}: the value shown is the value ranked`);
    }
    assert.equal((await answer(c, "SELECT count(*) FROM (SELECT l.id FROM late l ORDER BY random() FETCH FIRST 3 ROWS WITH TIES) s")).rows[0]![0], "3");
    // said once: the key is the output's number
    logged.length = 0;
    await c.query("SELECT random() AS r, l.id FROM late l ORDER BY random() LIMIT 5");
    const line = logged.findLast((l) => l.startsWith("statement: ")) ?? "";
    assert.equal(line.match(/random\(\)/g)?.length, 1, line);
  } finally { await c.end(); }
});

// FETCH … WITH TIES (issue 192): every key read through the one resolver, an output by its column; a set operation; the
// limits as Postgres's executor reads them; no rank among the columns a query around it reads. Rows of equal keys are in
// no defined order, here as on Postgres, so each answer is held as a bag, and its order by the statements written to
// say one (an outer ORDER BY, a count)
test("FETCH … WITH TIES answers as Postgres does: every key by its output's column, a set operation, its limits, inside another query", async () => {
  const c = await client();
  try {
    const bag = (r: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ fields: r.fields, rows: r.rows.map((x) => JSON.stringify(x)).sort() });
    const differ: string[] = [];
    const alike = async (sql: string, values?: unknown[]): Promise<void> => {
      const [got, want] = [await answer(c, sql, values).catch((e: pg.DatabaseError) => `${e.code}: ${e.message}`), await postgres(sql, values).catch((e: { code: string; message: string }) => `${e.code}: ${e.message}`)];
      if (!util.isDeepStrictEqual(typeof got === "string" ? got : bag(got), typeof want === "string" ? want : bag(want))) differ.push(`${sql}\n    mason:    ${JSON.stringify(got).slice(0, 300)}\n    postgres: ${JSON.stringify(want).slice(0, 300)}`);
    };
    for (const sql of [
      // AN OUTPUT BY ITS NUMBER BESIDE A *: a computed one, a star's column, after one, over a join (late has 4 columns)
      "SELECT count(*) FROM (SELECT l.*, l.k % 5 AS m FROM late l ORDER BY 5 FETCH FIRST 3 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT *, l.k % 5 AS m FROM late l ORDER BY 5 DESC FETCH FIRST 3 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT l.*, l.k % 5 AS m FROM late l ORDER BY 4 FETCH FIRST 3 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT l.*, l.k % 5 AS m FROM late l ORDER BY m OFFSET 2 FETCH FIRST 3 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT l.k % 5 AS m, l.* FROM late l ORDER BY 1, 5 FETCH FIRST 3 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT l.*, lc.*, l.k % 7 AS m FROM late l JOIN late_c lc ON lc.id = l.c ORDER BY 7 FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT * FROM late l JOIN late_c lc USING (id) ORDER BY 4 FETCH FIRST 1 ROWS WITH TIES) s",
      // A SET OPERATION, by number and by name: UNION ALL, UNION, INTERSECT, EXCEPT ALL, a * of each arm, an arm's own
      "SELECT count(*) FROM (SELECT l.k % 5 AS m, l.id FROM late l WHERE l.id < 10 UNION ALL SELECT l.k % 5, l.id FROM late l WHERE l.id > 1990 ORDER BY 1 FETCH FIRST 3 ROWS WITH TIES) s",
      "SELECT l.k % 5 AS m, l.id FROM late l WHERE l.id < 10 UNION ALL SELECT l.k % 5, l.id FROM late l WHERE l.id > 1990 ORDER BY m, id FETCH FIRST 3 ROWS WITH TIES",
      "SELECT * FROM (SELECT lc.name FROM late_c lc WHERE lc.id < 20 UNION SELECT 'c' || l.c FROM late l WHERE l.id < 30 ORDER BY 1 DESC FETCH FIRST 2 ROWS WITH TIES) s ORDER BY 1",
      "SELECT l.c % 5 AS m FROM late l INTERSECT SELECT l.c % 3 FROM late l ORDER BY m DESC FETCH FIRST 1 ROWS WITH TIES",
      "SELECT count(*) FROM (SELECT l.k % 5 AS m FROM late l EXCEPT ALL SELECT l.k % 5 FROM late l WHERE l.id < 1900 ORDER BY m FETCH FIRST 2 ROWS WITH TIES) s",
      "SELECT count(*), min(id), max(id) FROM (SELECT * FROM late l WHERE l.id < 30 UNION ALL SELECT * FROM late l WHERE l.id > 1990 ORDER BY 4 DESC, 3 FETCH FIRST 3 ROWS WITH TIES) s",
      "SELECT * FROM ((SELECT l.c, l.id FROM late l ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) UNION ALL (SELECT lc.id, lc.id FROM late_c lc WHERE lc.id < 3)) s ORDER BY 1, 2",
      // three SELECTs; one a set operation of its own with a LIMIT; under a WITH; in a WITH query
      "SELECT count(*) FROM (SELECT l.c FROM late l WHERE l.id < 5 UNION ALL SELECT lc.id FROM late_c lc UNION ALL SELECT l.k FROM late l WHERE l.id > 1998 ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT * FROM ((SELECT l.c FROM late l UNION SELECT lc.id FROM late_c lc ORDER BY 1 LIMIT 3) UNION ALL SELECT l.c FROM late l WHERE l.id < 3 ORDER BY 1 DESC FETCH FIRST 2 ROWS WITH TIES) s ORDER BY 1",
      "WITH x AS (SELECT l.c FROM late l WHERE l.id < 5) SELECT x.c FROM x UNION ALL SELECT lc.id FROM late_c lc ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES",
      "WITH t AS (SELECT l.c FROM late l UNION ALL SELECT lc.id FROM late_c lc ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) SELECT count(*) FROM t",
      // a VALUES as an arm, after a SELECT and first (its outputs are column1, …)
      "SELECT count(*) FROM (SELECT l.c FROM late l UNION ALL VALUES (0) ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES) s",
      "VALUES (49), (0), (49) UNION ALL SELECT l.c FROM late l WHERE l.id < 60 ORDER BY 1 DESC FETCH FIRST 2 ROWS WITH TIES",
      "SELECT count(*) FROM (VALUES (1, 'x') UNION ALL SELECT lc.id, lc.name FROM late_c lc ORDER BY column1, 2 FETCH FIRST 1 ROWS WITH TIES) s",
      // AN OUTPUT NEVER COMPUTED TWICE: a window's, a set-returning function's
      "SELECT row_number() OVER (ORDER BY l.id) AS rn, l.id FROM late l ORDER BY rn FETCH FIRST 2 ROWS WITH TIES",
      "SELECT * FROM (SELECT l.id, rank() OVER (ORDER BY l.c) AS r FROM late l WHERE l.id < 120 ORDER BY 2 FETCH FIRST 2 ROWS WITH TIES) s ORDER BY 1",
      "SELECT generate_series(1, 3) AS g, l.id FROM late l WHERE l.id < 3 ORDER BY g FETCH FIRST 2 ROWS WITH TIES",
      // DISTINCT, and a DISTINCT ON whose ORDER BY is shorter than its ON list
      "SELECT DISTINCT l.c FROM late l ORDER BY 1 DESC FETCH FIRST 2 ROWS WITH TIES",
      "SELECT DISTINCT l.c % 7 AS g FROM late l ORDER BY l.c % 7 FETCH FIRST 2 ROWS WITH TIES",
      "SELECT DISTINCT ON (l.c) l.c, l.id FROM late l ORDER BY l.c, l.id FETCH FIRST 2 ROWS WITH TIES",
      "SELECT DISTINCT ON (l.c % 3, l.c % 5) l.c % 3 AS a, l.c % 5 AS b FROM late l ORDER BY l.c % 3 FETCH FIRST 1 ROWS WITH TIES",
      // A KEY NO OUTPUT IS: computed once beside the list; grouped; through a derived table's `s.*`; NULLs placed
      "SELECT * FROM (SELECT l.c % 7 AS g, count(*) AS n FROM late l GROUP BY 1 ORDER BY max(l.k) DESC FETCH FIRST 2 ROWS WITH TIES) s ORDER BY 1",
      "SELECT count(*) FROM (SELECT s.* FROM (SELECT lc.name AS nm, lc.id % 3 AS t FROM late_c lc) s ORDER BY s.t FETCH FIRST 1 ROWS WITH TIES) q",
      "SELECT count(*) FROM (SELECT l.id FROM late l ORDER BY l.c DESC, l.k % 3 FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT n.id FROM nullish n ORDER BY n.t NULLS FIRST, n.id FETCH FIRST 1 ROWS WITH TIES",
      "SELECT count(*) FROM (SELECT n.id FROM nullish n ORDER BY n.t NULLS FIRST FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT n.id FROM nullish n ORDER BY n.t IS NULL DESC, n.t FETCH FIRST 1 ROWS WITH TIES) s",
      // a type's own order and equality: jsonb (1, 1.0 and 1.00 tie), citext (case ties), a collation, an exact numeric
      "SELECT count(*) FROM (SELECT q.v -> 'k' AS k FROM jq q ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT q.id FROM jq q ORDER BY q.v -> 'k' DESC FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT a.status FROM accounts a ORDER BY 1 DESC FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT a.id FROM accounts a ORDER BY a.status FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT a.status FROM accounts a UNION ALL SELECT a.status FROM accounts a ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT a.id, a.status FROM accounts a UNION ALL SELECT a.id, a.team FROM accounts a ORDER BY 2 DESC FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT t.s COLLATE \"und-x-icu\" AS s, t.id FROM texts t ORDER BY 1 DESC FETCH FIRST 2 ROWS WITH TIES",
      "SELECT t.id FROM texts t ORDER BY t.s COLLATE \"und-x-icu\", t.id FETCH FIRST 2 ROWS WITH TIES",
      "SELECT t.id FROM texts t ORDER BY t.s COLLATE \"C\" DESC, t.id FETCH FIRST 2 ROWS WITH TIES",
      "SELECT r.a / r.b AS q, r.id FROM ratios r ORDER BY 1, 2 FETCH FIRST 3 ROWS WITH TIES",
      "SELECT count(*) FROM (SELECT r.a / r.b AS q FROM ratios r ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) s",
      // THE LIMITS, as Postgres's executor reads them: a NULL count none, 0 no rows (ties past an offset too), a
      // fraction rounded, a negative one its error (the offset's first), each read once
      "SELECT count(*) FROM (SELECT l.id FROM late l ORDER BY l.c FETCH FIRST (SELECT NULL::int) ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT l.id FROM late l ORDER BY l.c OFFSET (SELECT NULL::int) FETCH FIRST 1 ROWS WITH TIES) s",
      "SELECT l.id FROM late l ORDER BY l.c FETCH FIRST 0 ROWS WITH TIES",
      "SELECT count(*) FROM (SELECT l.id FROM late l ORDER BY l.c OFFSET 1 FETCH FIRST 0 ROWS WITH TIES) s",
      "SELECT count(*) FROM (SELECT l.id FROM late l ORDER BY l.id FETCH FIRST 2.5 ROWS WITH TIES) s",
      "SELECT l.id FROM late l ORDER BY l.id OFFSET 1.5 FETCH FIRST 1 ROWS WITH TIES",
      "SELECT s.c, count(*) FROM (SELECT l.c FROM late l ORDER BY l.c OFFSET 39 FETCH FIRST 2 ROWS WITH TIES) s GROUP BY 1 ORDER BY 1",
      "SELECT count(*) FROM (SELECT l.c FROM late l ORDER BY l.c OFFSET 1990 FETCH FIRST 5 ROWS WITH TIES) s",
      "SELECT l.id FROM late l ORDER BY l.c FETCH FIRST -1 ROWS WITH TIES",
      "SELECT l.id FROM late l ORDER BY l.c FETCH FIRST (SELECT -1) ROWS WITH TIES",
      "SELECT l.id FROM late l ORDER BY l.c OFFSET -1 FETCH FIRST 2 ROWS WITH TIES",
      "SELECT l.id FROM late l ORDER BY l.c OFFSET -1 FETCH FIRST -1 ROWS WITH TIES",
      // INSIDE ANOTHER QUERY: its columns are the statement's, by Postgres's names, and no rank among them
      "SELECT l.id FROM late l WHERE l.id IN (SELECT l2.id FROM late l2 ORDER BY l2.c FETCH FIRST 2 ROWS WITH TIES) ORDER BY 1",
      "SELECT (SELECT l.id FROM late l ORDER BY l.k FETCH FIRST 1 ROWS WITH TIES) AS a",
      "SELECT array_length(ARRAY(SELECT l.id FROM late l ORDER BY l.c FETCH FIRST 1 ROWS WITH TIES), 1) AS n",
      "SELECT s.*, 1 AS x FROM (SELECT l.c, l.id FROM late l ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) s ORDER BY 2",
      "WITH t AS (SELECT l.c % 3 AS g, count(*) FROM late l GROUP BY 1 ORDER BY 2 DESC FETCH FIRST 1 ROWS WITH TIES) SELECT t.g, t.count FROM t ORDER BY 1",
      "SELECT x.a, x.b FROM (SELECT l.c, l.id FROM late l ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES) AS x(a, b) ORDER BY 2",
    ]) await alike(sql);
    // a count and an offset bound as parameters, a prepared statement's
    await alike("SELECT count(*) FROM (SELECT l.id FROM late l ORDER BY l.c OFFSET $2 FETCH FIRST $1 ROWS WITH TIES) s", [2, 39]);
    await alike("SELECT count(*) FROM (SELECT l.id FROM late l ORDER BY l.c FETCH FIRST $1 ROWS WITH TIES) s", [null]);
    assert.deepEqual(differ, [], "each of these answers unlike Postgres");
    // a row as a key no output is: refused by name, as an ORDER BY of one is
    for (const sql of ["SELECT l.id FROM late l ORDER BY ROW(l.c, l.k) FETCH FIRST 1 ROWS WITH TIES", "SELECT l.id FROM late l ORDER BY l FETCH FIRST 1 ROWS WITH TIES"]) {
      await assert.rejects(answer(c, sql), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap row-value/.test(e.detail ?? ""), sql);
    }
    // in key order: rows of a smaller key before a larger one's
    const keys = (await answer(c, "SELECT l.c FROM late l WHERE l.id < 200 ORDER BY 1 DESC OFFSET 3 FETCH FIRST 6 ROWS WITH TIES")).rows.map((r) => Number(r[0]));
    assert.deepEqual(keys, [...keys].sort((a, b) => b - a));
    assert.ok(keys.length > 6, "the ties of the last row are kept");
    // a key computed in the session's zone, by a statement prepared before a later SET: the zone the Execute's
    const zoned = "SELECT * FROM (SELECT date_trunc('day', i.at) AS d, count(*) AS n FROM instants i GROUP BY 1 ORDER BY 1 DESC FETCH FIRST 2 ROWS WITH TIES) s ORDER BY 1";
    await truth.exec("SET TimeZone = 'UTC'");
    assert.deepEqual((await c.query({ name: "ties_zoned", text: zoned, rowMode: "array", types: raw } as pg.QueryConfig)).rows, (await postgres(zoned)).rows, "in UTC");
    for (const zone of ["Asia/Kathmandu", "America/New_York"]) {
      await c.query(`SET TimeZone = '${zone}'`);
      await truth.exec(`SET TimeZone = '${zone}'`);
      try {
        assert.deepEqual((await c.query({ name: "ties_zoned", text: zoned, rowMode: "array", types: raw } as pg.QueryConfig)).rows, (await postgres(zoned)).rows, `prepared before SET TimeZone = ${zone}`);
      } finally { await truth.exec("SET TimeZone = 'UTC'"); }
    }
  } finally { await c.end(); }
});

test("a set operation's ORDER BY sorts its column as Postgres resolved it, and a row output is never a sort key", async () => {
  const c = await client();
  try {
    // a citext SELECT beside a text one is a text column: sorted as text, never case-insensitively as the first's
    for (const sql of [
      "SELECT a.status AS v FROM accounts a UNION ALL SELECT a.team FROM accounts a ORDER BY 1",
      "SELECT a.status AS v FROM accounts a UNION ALL SELECT a.team FROM accounts a ORDER BY v DESC",
      "SELECT a.team AS v, a.id FROM accounts a UNION ALL SELECT a.status, a.id FROM accounts a ORDER BY 1 DESC, 2 LIMIT 4",
      "SELECT l.c FROM late l WHERE l.id < 5 UNION ALL VALUES (3), (0) ORDER BY 1",
    ]) assert.deepEqual((await answer(c, sql)).rows, (await postgres(sql)).rows, sql);
    // a row output is written as its text, which sorts unlike the row (`(0,100)` before `(0,50)`): a key bound to it,
    // by its number, its name, a DISTINCT ON or a set operation's, is refused by name, as a row written as a key is
    for (const sql of [
      "SELECT ROW(l.c, l.k) AS r FROM late l ORDER BY 1 LIMIT 2",
      "SELECT ROW(l.c, l.k) AS r FROM late l ORDER BY r DESC LIMIT 2",
      "SELECT (l.c, l.k) AS r, l.id FROM late l ORDER BY 1, 2 LIMIT 2",
      "SELECT ROW(l.c, l.k) AS r FROM late l ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES",
      "SELECT DISTINCT ON (1) ROW(l.c, l.k) AS r FROM late l ORDER BY 1 LIMIT 2",
      "SELECT l FROM late l ORDER BY 1 LIMIT 2",
      "SELECT s FROM (SELECT l.c, l.k FROM late l) s ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES",
      "SELECT ROW(l.c, l.k) AS r FROM late l UNION ALL SELECT ROW(l.c, l.k) FROM late l ORDER BY 1 LIMIT 3",
      "SELECT ROW(l.c, l.k) AS r FROM late l UNION ALL SELECT ROW(l.c, l.k) FROM late l ORDER BY r FETCH FIRST 3 ROWS WITH TIES",
    ]) await assert.rejects(answer(c, sql), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap row-value/.test(e.detail ?? ""), sql);
    // the row's text is a text, sorted as one; a row beside the key it is not, answered
    for (const sql of [
      "SELECT ROW(l.c, l.k)::text AS r FROM late l ORDER BY 1 LIMIT 2",
      "SELECT ROW(l.c, l.k) AS r, l.id FROM late l ORDER BY 2 FETCH FIRST 2 ROWS WITH TIES",
    ]) assert.deepEqual((await answer(c, sql)).rows, (await postgres(sql)).rows, sql);
  } finally { await c.end(); }
});

/** each statement's answer against Postgres's (PGlite's), or the error each raises as `code: message`; `bag` compares the
 *  rows as a set, where ties leave their order to each engine; the statements that differ, with both answers. A
 *  statement whose LIMIT cuts inside a tie of distinct rows is one too (`cutInsideATie`): its rows are neither engine's
 *  promise, so comparing them flakes by load (issue 370) */
async function unlike(c: pg.Client, statements: ReadonlyArray<readonly [string, "ordered" | "bag"]>): Promise<string[]> {
  const differ: string[] = [];
  for (const [sql, how] of statements) {
    const as = (r: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ fields: r.fields, rows: how === "bag" ? r.rows.map((x) => JSON.stringify(x)).sort() : r.rows });
    const got = await answer(c, sql).then(as, (e: pg.DatabaseError) => `${e.code}: ${e.message}`);
    const want = await postgres(sql).then(as, (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
    // asked whether the answers agree or not, so the reason is named on every run, beside the rows when they differ
    // (a statement Postgres refuses has no rows to cut: its comparison is the error's)
    const undecided = typeof want === "string" ? undefined : await cutInsideATie(sql);
    if (!util.isDeepStrictEqual(got, want)) differ.push(`${sql}\n    mason:    ${JSON.stringify(got).slice(0, 300)}\n    postgres: ${JSON.stringify(want).slice(0, 300)}${undecided === undefined ? "" : `\n    ${undecided}`}`);
    else if (undecided !== undefined) differ.push(`${sql}\n    ${undecided}`);
  }
  return differ;
}

/** why the rows of `sql` are decided by neither engine, or undefined when they are (or `sql` ends in no `LIMIT n
 *  [OFFSET m]` of literal counts under an ORDER BY). Its OUTERMOST query is read from Postgres's parse; what ties is
 *  Postgres's own sort, asked as `FETCH FIRST j ROWS WITH TIES`, never the keys derived again: `j` rows WITH TIES
 *  return more than `j` exactly when row `j` ties with row `j + 1`, whatever order either engine reads a tie in. A cut
 *  (at the OFFSET and at the end of the LIMIT) inside a tie whose rows are not all the same row leaves which of them
 *  come back to the engine's order. A DISTINCT ON is skipped: its sort holds its ON keys, which WITH TIES does not tie
 *  on, so its ties are not the rows' (none ends in a LIMIT in this file) */
async function cutInsideATie(sql: string): Promise<string | undefined> {
  type Const = { A_Const?: { ival?: { ival?: number }; isnull?: boolean } };
  const top = ((await parseSql(sql)).stmts?.[0]?.stmt as { SelectStmt?: { sortClause?: unknown[]; distinctClause?: unknown[]; limitOption?: string; limitCount?: Const; limitOffset?: Const } } | undefined)?.SelectStmt;
  if (top?.limitOption !== "LIMIT_OPTION_COUNT" || top.limitCount === undefined || !top.sortClause?.length) return undefined;
  // DISTINCT is `[{}]` in the parse, DISTINCT ON its keys
  if (top.distinctClause?.some((k) => Object.keys(k as object).length > 0)) return undefined;
  // a literal count: libpg-query's JSON omits a 0 (`{ ival: {} }`), so a present `ival` with none is 0, never absent
  const literal = (k: Const | undefined): number | undefined => k?.A_Const?.ival !== undefined ? k.A_Const.ival.ival ?? 0 : undefined;
  const count = literal(top.limitCount), offset = top.limitOffset === undefined ? 0 : literal(top.limitOffset);
  if (count === undefined || offset === undefined) return undefined;
  const tail = /\s(?:LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?|OFFSET\s+(\d+)(?:\s+ROWS?)?\s+LIMIT\s+(\d+))\s*$/i.exec(sql);
  // the parse says a trailing LIMIT this does not read: couldn't tell, said as such, never taken as decided
  if (tail === null || Number(tail[1] ?? tail[4]) !== count || Number(tail[2] ?? tail[3] ?? 0) !== offset) return `the LIMIT tie check could not read this statement's LIMIT ${count} OFFSET ${offset}`;
  const head = sql.slice(0, tail.index);
  const withTies = async (j: number): Promise<unknown[][]> => (await postgres(`${head} FETCH FIRST ${j} ROWS WITH TIES`)).rows;
  for (const cut of offset > 0 ? [offset, offset + count] : [count]) {
    if (cut === 0) continue;
    const through = await withTies(cut);
    if (through.length === cut) continue; // row `cut` ties with no row after it
    // the tie runs from its first row (the least j whose rows WITH TIES are all of `through`) to the end of `through`
    let first = cut - 1;
    while (first > 0 && (await withTies(first)).length === through.length) first--;
    const tied = new Set(through.slice(first).map((r) => JSON.stringify(r)));
    if (tied.size > 1) return `the LIMIT cuts inside a tie: its rows are decided by neither engine (rows ${first + 1} to ${through.length} tie, ${tied.size} of them distinct, cut after row ${cut})`;
  }
  return undefined;
}

test("a TABLE statement is found in Postgres's analysis: under FETCH … WITH TIES, and as a set operation's SELECT", async () => {
  const c = await client();
  try {
    // `TABLE t` writes its `*` at no offset: its query is told by what it reads and its own limits
    assert.deepEqual(await unlike(c, [
      ["TABLE late_c ORDER BY name FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT count(*) FROM (TABLE late ORDER BY c FETCH FIRST 1 ROWS WITH TIES) s", "ordered"],
      ["SELECT count(*), min(s.id) FROM (TABLE late ORDER BY c FETCH FIRST 1 ROWS WITH TIES) s UNION ALL SELECT count(*), min(s.id) FROM (TABLE late ORDER BY c DESC FETCH FIRST 2 ROWS WITH TIES) s", "bag"],
      ["SELECT * FROM late_c UNION ALL TABLE late_c ORDER BY 1 LIMIT 3", "ordered"],
      ["SELECT * FROM late_c UNION ALL TABLE late_c ORDER BY 2 DESC LIMIT 3", "ordered"],
      ["TABLE late_c UNION ALL TABLE late_c ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT * FROM late_c UNION ALL TABLE late_c ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT count(*) FROM (TABLE late_c UNION ALL TABLE late_c ORDER BY name FETCH FIRST 3 ROWS WITH TIES) s", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("a set operation's SELECTs are the column Postgres resolved: a char(n) beside a text, an integer beside a quotient", async () => {
  const c = await client();
  try {
    // a char(5) of a text column is its text without the padding, for the ties, a UNION, a GROUP BY and the text; an
    // integer of a numeric column beside a quotient keeps the quotient's every digit
    assert.deepEqual(await unlike(c, [
      ["SELECT lc.name AS x FROM late_c lc WHERE lc.id < 3 UNION ALL SELECT ch.ch FROM chars ch ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT lc.name AS x FROM late_c lc WHERE lc.id < 3 UNION ALL SELECT ch.ch FROM chars ch ORDER BY 1, 1 DESC", "ordered"],
      ["SELECT s.x, count(*) FROM (SELECT lc.name AS x FROM late_c lc WHERE lc.id < 3 UNION ALL SELECT ch.ch FROM chars ch) s GROUP BY 1 ORDER BY 1", "ordered"],
      ["SELECT count(*) FROM (SELECT lc.name AS x FROM late_c lc WHERE lc.id < 3 UNION SELECT ch.ch FROM chars ch) s", "ordered"],
      ["SELECT lc.name AS x FROM late_c lc WHERE lc.id < 3 INTERSECT SELECT ch.ch FROM chars ch ORDER BY 1", "ordered"],
      ["SELECT r.a / r.b AS q FROM ratios r UNION ALL SELECT r.n FROM ratios r ORDER BY 1 NULLS FIRST", "bag"],
      ["SELECT r.a / r.b AS q FROM ratios r UNION ALL SELECT 1 ORDER BY 1 NULLS FIRST FETCH FIRST 2 ROWS WITH TIES", "bag"],
      // read outside the union, compared by its exact value (two quotients equal to 17 digits are two)
      ["SELECT DISTINCT u.q FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT 0) u", "bag"],
      // (an integer equal to a quotient is one group with it, shown in either spelling: `mixed-scale-numeric`)
      ["SELECT u.q, count(*) FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT b.id + 10 FROM bigdec b) u GROUP BY 1", "bag"],
    ]), []);
  } finally { await c.end(); }
});

test("FETCH … WITH TIES reads its count and offset where no row is: a negative one raises", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT l.id FROM late l WHERE false ORDER BY l.c FETCH FIRST -1 ROWS WITH TIES", "ordered"],
      ["SELECT l.id FROM late l WHERE false ORDER BY l.c OFFSET -1 FETCH FIRST 2 ROWS WITH TIES", "ordered"],
      ["SELECT l.id FROM late l WHERE false ORDER BY l.c FETCH FIRST (SELECT -1) ROWS WITH TIES", "ordered"],
      ["SELECT l.id FROM late l WHERE l.c > 1000 ORDER BY l.c FETCH FIRST (SELECT min(l2.c) - 5 FROM late l2) ROWS WITH TIES", "ordered"],
      ["SELECT count(*) FROM (SELECT l.id FROM late l WHERE false ORDER BY l.c FETCH FIRST 2 ROWS WITH TIES) s", "ordered"],
      ["SELECT count(*) FROM (SELECT l.id FROM late l WHERE false ORDER BY l.c FETCH FIRST (SELECT NULL::int) ROWS WITH TIES) s", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("FETCH … WITH TIES over a derived table or a WITH query read by a * keeps the exact numbers' cells it passes through", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT * FROM (SELECT r.id, r.a / r.b AS q FROM ratios r) s ORDER BY 2 DESC, 1 FETCH FIRST 2 ROWS WITH TIES", "bag"],
      ["SELECT * FROM (SELECT r.id, r.a / r.b AS q FROM ratios r) s ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES", "bag"],
      ["WITH s AS (SELECT r.id, r.a / r.b AS q FROM ratios r) SELECT * FROM s ORDER BY 2 DESC, 1 FETCH FIRST 2 ROWS WITH TIES", "bag"],
      ["SELECT * FROM (SELECT r.id, avg(r.a) AS m FROM ratios r GROUP BY 1) s ORDER BY 2 NULLS FIRST, 1 OFFSET 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
    ]), []);
  } finally { await c.end(); }
});

test("FETCH … WITH TIES carries every cell its exact numbers have, in every shape they reach it by", async () => {
  const c = await client();
  try {
    // the cells a statement's exact columns read are recorded once (`exactThrough`), and the wrapper passes that many
    // through after the columns, by whichever shape they reach it: its own outputs, a lone `*` or `s.*`, a `*` beside
    // outputs, a set operation's `*` arms over a WITH query or a subquery, derived tables nested, a WITH TIES query read
    const q = "(SELECT r.id, r.id % 2 AS g, r.a / r.b AS q FROM ratios r)";
    assert.deepEqual(await unlike(c, [
      ["SELECT r.id, r.a / r.b AS q FROM ratios r ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      [`SELECT * FROM ${q} s ORDER BY 3 DESC FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      [`SELECT s.* FROM ${q} s ORDER BY 3 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      [`SELECT s.* FROM ${q} s ORDER BY s.g, 3 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 2, 3 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      // (a key that decides the rows: `ORDER BY 3 LIMIT 3` cuts inside four rows tied at 3, its rows neither engine's
      // promise, issue 370; the rows still tied here are one row twice)
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3, 1 LIMIT 3`, "ordered"],
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3, 1 LIMIT 3 OFFSET 2`, "ordered"],
      [`SELECT * FROM ${q} s UNION ALL SELECT * FROM ${q} s2 ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT r.id, r.id % 2, r.a / r.b FROM ratios r ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      [`SELECT * FROM (SELECT * FROM ${q} s1) s2 ORDER BY 3, 1 FETCH FIRST 2 ROWS WITH TIES`, "bag"],
      [`WITH w AS ${q}, v AS (SELECT * FROM w) SELECT * FROM v ORDER BY 3 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      [`SELECT * FROM (SELECT * FROM ${q} s ORDER BY 3 FETCH FIRST 1 ROWS WITH TIES) t`, "bag"],
      [`SELECT t.q FROM (SELECT r.id, r.a / r.b AS q FROM ratios r ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES) t`, "bag"],
      [`SELECT DISTINCT * FROM ${q} s ORDER BY 3 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      // a WITH TIES arm of a UNION ALL whose other arm computes otherwise: its cells are the union's, in its own slots
      ["(SELECT r.id, r.a / r.b AS q FROM ratios r ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES) UNION ALL SELECT 0, 1", "bag"],
      ["SELECT 0, 1.5 UNION ALL (SELECT r.id, r.a / r.b AS q FROM ratios r ORDER BY 2 DESC FETCH FIRST 1 ROWS WITH TIES)", "bag"],
      // a UNION ALL of its own WITH, ORDER BY and limit is one SELECT of the UNION ALL around it, its cells its own
      [`(WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3, 1 LIMIT 2) UNION ALL (WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3, 1 FETCH FIRST 1 ROWS WITH TIES)`, "bag"],
    ]), []);
    // a `*` beside outputs carries no cells (its quotient is the engine's double, as without WITH TIES: not this PR's);
    // under WITH TIES it answers as the same statement does under LIMIT, where the key ties nowhere
    for (const sql of [
      "SELECT *, r.a / r.b AS q FROM ratios r ORDER BY 1 {limit}",
      "SELECT r.a / r.b AS q, * FROM ratios r ORDER BY 2 {limit}",
      `SELECT *, s.id * 2 AS j FROM ${q} s ORDER BY 1 {limit}`,
    ]) assert.deepEqual((await answer(c, sql.replace("{limit}", "FETCH FIRST 2 ROWS WITH TIES"))).rows, (await answer(c, sql.replace("{limit}", "LIMIT 2"))).rows, sql);
  } finally { await c.end(); }
});

test("a LIMIT that cuts inside a tie of distinct rows is a difference unlike() reports, whatever order either engine reads", async () => {
  const c = await client();
  try {
    const q = "(SELECT r.id, r.id % 2 AS g, r.a / r.b AS q FROM ratios r)";
    // four rows tie at q = 3 ((1,1,3) twice, (2,0,3) twice) and LIMIT 3 cuts inside them: named on every run, from
    // Postgres's answer alone, never only by the runs whose engine order differs (issue 370)
    const undecided = `WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3 LIMIT 3`;
    for (const how of ["bag", "ordered"] as const) {
      const found = await unlike(c, [[undecided, how]]);
      assert.equal(found.length, 1, how);
      assert.match(found[0]!, /the LIMIT cuts inside a tie: its rows are decided by neither engine \(rows 1 to 4 tie, 2 of them distinct, cut after row 3\)/, how);
    }
    // a cut at the OFFSET, in either spelling: rows 2 and 3 of the tie are (1,1,3) and (2,0,3) in some order
    for (const sql of [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3 LIMIT 2 OFFSET 2`, `WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3 OFFSET 2 LIMIT 2`]) {
      const found = await unlike(c, [[sql, "bag"]]);
      assert.equal(found.length, 1, sql);
      assert.match(found[0]!, /cut after row 2\)/, sql);
    }
    // decided: a key that breaks the tie, a tie of one row repeated, no tie at the cut, a LIMIT that takes the whole
    // tie, a LIMIT of 0, a LIMIT that is not the outermost query's, a WITH TIES
    assert.deepEqual(await unlike(c, [
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3, 1 LIMIT 3`, "ordered"],
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3, 1 LIMIT 3 OFFSET 2`, "ordered"],
      ["SELECT * FROM late_c UNION ALL TABLE late_c ORDER BY 1 LIMIT 3", "ordered"],
      ["SELECT * FROM late_c UNION ALL TABLE late_c ORDER BY 2 DESC LIMIT 3", "ordered"],
      ["SELECT r.id, r.a / r.b AS q FROM ratios r ORDER BY 2, 1 LIMIT 3", "ordered"],
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3 LIMIT 4`, "bag"],
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3 LIMIT 0`, "ordered"],
      [`SELECT count(*) FROM (WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3 LIMIT 3) s`, "ordered"],
      [`(WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3, 1 LIMIT 2) UNION ALL (WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3, 1 FETCH FIRST 1 ROWS WITH TIES)`, "bag"],
      [`WITH w AS ${q} SELECT * FROM w UNION ALL SELECT * FROM w ORDER BY 3 FETCH FIRST 3 ROWS WITH TIES`, "bag"],
    ]), []);
    // a row output Mason refuses by name (`row-value`), whose rows Postgres's tie leaves decided: one row repeated
    assert.equal(await cutInsideATie("SELECT ROW(l.c, l.k) AS r FROM late l UNION ALL SELECT ROW(l.c, l.k) FROM late l ORDER BY 1 LIMIT 3"), undefined);
  } finally { await c.end(); }
});

test("FETCH … WITH TIES ties on the ORDER BY Postgres sorts by: never a key a DISTINCT adds", async () => {
  const c = await client();
  try {
    // a DISTINCT over an exact numeric is a DISTINCT ON of every output, and a DISTINCT ON's sort holds its keys: the
    // rows tie on the statement's own ORDER BY all the same (Postgres's sortClause, which neither extends)
    assert.deepEqual(await unlike(c, [
      ["SELECT DISTINCT r.d IS NULL AS z, r.a / 7.0 AS q FROM ratios r ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT DISTINCT r.d IS NULL AS z, r.a / 2 AS h FROM ratios r ORDER BY z FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT DISTINCT r.d IS NULL AS z, r.team FROM ratios r ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT DISTINCT ON (1, 2) r.d IS NULL AS z, r.n FROM ratios r ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT DISTINCT ON (r.d IS NULL, r.a / 7.0) r.d IS NULL AS z, r.a / 7.0 AS q FROM ratios r ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT DISTINCT ON (1, 2) r.d IS NULL AS z, r.n FROM ratios r ORDER BY 1, 2 DESC FETCH FIRST 1 ROWS WITH TIES", "bag"],
    ]), []);
  } finally { await c.end(); }
});

test("a computed key and a merged column in a prepared statement run after a SET, and in two session zones", async () => {
  const c = await client();
  try {
    await truth.exec("SET TimeZone = 'UTC'");
    const statements = [
      ["computed", "SELECT date_trunc('day', i.at) AS d, i.id, n.t FROM instants i LEFT JOIN nullish n ON n.id = i.id ORDER BY d DESC, i.id LIMIT 4"],
      ["ordinal", "SELECT date_trunc('day', i.at) AS d, i.id, n.t FROM instants i LEFT JOIN nullish n ON n.id = i.id ORDER BY 1, 2 LIMIT 4"],
      ["merged", "SELECT id, date_trunc('day', i.at) AS d, n.t FROM instants i JOIN nullish n USING (id) ORDER BY d, id LIMIT 4"],
      ["full", "SELECT id, i.at, n.t FROM instants i FULL JOIN nullish n USING (id) ORDER BY id LIMIT 4"],
    ] as const;
    for (const [name, text] of statements) {
      const first = await c.query({ name, text, rowMode: "array", types: raw } as pg.QueryConfig);
      assert.deepEqual(first.rows, (await postgres(text)).rows, `${name}, in UTC`);
      logged.length = 0;
      await c.query(text);
      assert.match(logged.findLast((l) => l.startsWith("statement: ")) ?? "", /__mason_r1/, `${name}: by row number`);
    }
    for (const zone of ["Asia/Kathmandu", "America/New_York"]) {
      await c.query(`SET TimeZone = '${zone}'`);
      await truth.exec(`SET TimeZone = '${zone}'`);
      try {
        for (const [name, text] of statements) {
          const again = await c.query({ name, text, rowMode: "array", types: raw } as pg.QueryConfig);
          assert.deepEqual(again.rows, (await postgres(text)).rows, `${name}, prepared before SET TimeZone = ${zone}`);
          assert.deepEqual((await answer(c, text)).rows, (await postgres(text)).rows, `${name}, in ${zone}`);
        }
      } finally { await truth.exec("SET TimeZone = 'UTC'"); }
    }
  } finally { await c.end(); }
});

test("a GROUP BY a table's whole primary key with a LIMIT groups on the key and reads that table's columns after the limit (issue 134, step 6)", async () => {
  const c = await client();
  const held = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => r.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : v)) });
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  const KEYED = /any_value\(\w+\.rowid\) AS __mason_r1.*\) AS __mason_late LEFT JOIN \w+ AS (\w+) ON \1\.rowid = __mason_late\.__mason_r1/;
  try {
    const answered = [
      // the key and other columns of its table, sorted, by a column, an aggregate's name and an ordinal
      "SELECT l.id, l.j, l.k, count(c.id) AS n FROM late l LEFT JOIN late_c c ON c.id = l.c GROUP BY l.id ORDER BY l.id DESC LIMIT 4",
      "SELECT l.id, l.j, count(*) AS n FROM late l JOIN late_c c ON c.id = l.c GROUP BY l.id ORDER BY n DESC, l.id LIMIT 3 OFFSET 2",
      "SELECT l.j, l.k, l.id FROM late l GROUP BY l.id ORDER BY 2, 3 LIMIT 3",
      // the other columns grouped beside the key, by their ordinals (a tool groups by every column it shows)
      "SELECT l.id, l.j, l.k, max(c.name) AS m FROM late l LEFT JOIN late_c c ON c.id = l.c GROUP BY 1, 2, 3 ORDER BY 1 LIMIT 3",
      // a key of one table beside a column of another, grouped: a NULL in that grouped column of the outer join
      "SELECT l.id, l.j, c.name, count(*) AS n FROM late l LEFT JOIN late_c c ON c.id = l.c + 40 GROUP BY l.id, c.name ORDER BY c.name NULLS FIRST, l.id LIMIT 5 OFFSET 8",
      // the keyed table on the nullable side: its group of no row reads NULL
      "SELECT c.id, l.id AS l, l.j, count(c.id) AS n FROM late_c c LEFT JOIN late l ON l.c = c.id AND l.id < 0 GROUP BY c.id, l.id ORDER BY c.id DESC LIMIT 3",
      // the nulls idiom over a fetched column, and a HAVING
      "SELECT l.id, l.k, sum(c.id) AS s FROM late l JOIN late_c c ON c.id = l.c GROUP BY l.id HAVING sum(c.id) > 10 ORDER BY (l.k) IS NULL ASC, l.k DESC LIMIT 3",
      // a composite key, whole, grouped with another column of its table
      "SELECT p.c, p.line, p.note FROM late_p p GROUP BY p.c, p.note, p.line ORDER BY 1, 2 LIMIT 3",
    ];
    for (const sql of answered) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
      assert.match(await sent(sql), KEYED, sql);
    }
    // the grouped columns of the table the list alone reads are left out of the grouping: the key decides them
    assert.match(await sent("SELECT l.id, l.j, l.k, max(c.name) AS m FROM late l LEFT JOIN late_c c ON c.id = l.c GROUP BY 1, 2, 3 ORDER BY 1 LIMIT 3"), /GROUP BY l\.id ORDER BY/);
    // unsorted: as many rows, each a group of the whole answer
    const unsorted = await answer(c, "SELECT l.id, l.j, count(*) AS n FROM late l GROUP BY l.id LIMIT 5");
    assert.equal(unsorted.rows.length, 5);
    const whole = held(await postgres("SELECT l.id, l.j, count(*) AS n FROM late l GROUP BY l.id")) as { rows: unknown[][] };
    for (const r of (held(unsorted) as { rows: unknown[][] }).rows) assert.ok(whole.rows.some((w) => JSON.stringify(w) === JSON.stringify(r)), JSON.stringify(r));
    // a key the copy holds twice for a moment is one group, read of one of its rows: never split by a row number
    assert.deepEqual((await answer(c, "SELECT d.id, d.w, count(*) AS n FROM late_d d GROUP BY d.id ORDER BY d.id LIMIT 5")).rows, [["1", "one", "2"], ["2", "two", "1"], ["3", "three", "1"]]);
    assert.match(await sent("SELECT d.id, d.w, count(*) AS n FROM late_d d GROUP BY d.id ORDER BY d.id LIMIT 5"), /any_value\(d\.rowid\) AS __mason_r1.* GROUP BY d\.id /);
    // what stays as it was: a key in part, no key, no LIMIT, grouping sets, a key's column grouped as an expression
    for (const sql of ["SELECT p.c, p.note FROM late_p p GROUP BY p.c, p.note ORDER BY 1, 2 LIMIT 3",
      "SELECT p.c, max(p.note) AS m FROM late_p p GROUP BY p.c ORDER BY 1 LIMIT 3",
      "SELECT n.id, count(*) AS k FROM late_n n GROUP BY n.id ORDER BY 1 LIMIT 3",
      "SELECT l.id, l.j FROM late l GROUP BY l.id ORDER BY l.id",
      "SELECT l.id, count(*) AS n FROM late l GROUP BY ROLLUP (l.id) ORDER BY 1 NULLS FIRST LIMIT 3",
      "SELECT l.id + 0 AS i, count(*) AS n FROM late l GROUP BY l.id + 0 ORDER BY 1 LIMIT 3"]) {
      assert.doesNotMatch(await sent(sql), /__mason_r1/, sql);
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
    }
    // a statement prepared, run after a SET: the same plan
    await c.query({ name: "keyfirst", text: "SELECT l.id, l.j, count(c.id) AS n FROM late l LEFT JOIN late_c c ON c.id = l.c GROUP BY l.id ORDER BY l.id LIMIT $1", values: [2] });
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    logged.length = 0;
    const again = await c.query({ name: "keyfirst", text: "SELECT l.id, l.j, count(c.id) AS n FROM late l LEFT JOIN late_c c ON c.id = l.c GROUP BY l.id ORDER BY l.id LIMIT $1", values: [3], rowMode: "array" });
    assert.equal(again.rows.length, 3);
    assert.match(logged.findLast((l) => l.startsWith("statement: ")) ?? "", KEYED);
  } finally { await c.end(); }
});

test("a SELECT DISTINCT whose list holds a table's whole primary key, with a LIMIT, groups on the key and reads that table's columns after the limit (issue 134, step 6)", async () => {
  const c = await client();
  const held = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => r.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : v)) });
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  const KEYED = /any_value\(\w+\.rowid\) AS __mason_r1.*\) AS __mason_late LEFT JOIN \w+ AS (\w+) ON \1\.rowid = __mason_late\.__mason_r1/;
  try {
    const answered = [
      // the key and other columns of its table (a jsonb among them, its equality the rewrite's key), sorted, with OFFSET
      "SELECT DISTINCT l.id, l.j, l.k FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id DESC LIMIT 4 OFFSET 2",
      "SELECT DISTINCT l.j, l.k, l.id FROM late l ORDER BY 2, 3 LIMIT 3",
      // a key of one table beside a column of another, which stays in the distinct: a NULL in it from the outer join
      "SELECT DISTINCT l.id, l.j, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c + 40 ORDER BY c.name NULLS FIRST, l.id LIMIT 5 OFFSET 8",
      "SELECT DISTINCT c.name, l.id, l.k FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.name, l.id LIMIT 4",
      // the nulls idiom over a fetched column, and a constant in the list
      "SELECT DISTINCT l.id, l.k, (l.k) IS NULL AS nk, 1 AS one FROM late l ORDER BY (l.k) IS NULL ASC, l.k DESC LIMIT 3",
      // a sort by an output holding a constant: it orders nothing, and never reaches the inner sort as an ordinal
      "SELECT DISTINCT l.id, l.k, 1 AS one FROM late l ORDER BY 3, 2 ASC LIMIT 3",
      "SELECT DISTINCT l.id, l.k, 1 AS one FROM late l ORDER BY one, l.id DESC LIMIT 3",
      // a composite key, whole, beside another column of its table
      "SELECT DISTINCT p.line, p.note, p.c FROM late_p p ORDER BY 3, 1 LIMIT 3",
      // over a derived side: the DISTINCT inside it is written, the read around it as it was
      "SELECT * FROM (SELECT DISTINCT l.id, l.j FROM late l ORDER BY l.id LIMIT 3) d ORDER BY d.id DESC",
    ];
    for (const sql of answered) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
      assert.match(await sent(sql), KEYED, sql);
    }
    // Postgres's rows for the constant sorts, written out
    assert.deepEqual((await answer(c, "SELECT DISTINCT l.id, l.k, 1 AS one FROM late l ORDER BY 3, 2 ASC LIMIT 3")).rows, [["2000", "0", "1"], ["1999", "1", "1"], ["1998", "2", "1"]]);
    assert.deepEqual((await answer(c, "SELECT DISTINCT l.id, l.k, 1 AS one FROM late l ORDER BY one, l.id DESC LIMIT 3")).rows.map((r) => r[0]), ["2000", "1999", "1998"]);
    // the columns the key decides are left out of the grouping, the other table's stay in it
    assert.match(await sent("SELECT DISTINCT l.id, l.j, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 3"), /GROUP BY l\.id, c\.name ORDER BY/);
    // unsorted: as many rows, each a row of the whole answer
    const unsorted = await answer(c, "SELECT DISTINCT l.id, l.j FROM late l LIMIT 5");
    assert.equal(unsorted.rows.length, 5);
    const whole = held(await postgres("SELECT DISTINCT l.id, l.j FROM late l")) as { rows: unknown[][] };
    for (const r of (held(unsorted) as { rows: unknown[][] }).rows) assert.ok(whole.rows.some((w) => JSON.stringify(w) === JSON.stringify(r)), JSON.stringify(r));
    // a key the copy holds twice for a moment is one row, never split by a row number
    assert.deepEqual((await answer(c, "SELECT DISTINCT d.id, d.w FROM late_d d ORDER BY d.id LIMIT 5")).rows, [["1", "one"], ["2", "two"], ["3", "three"]]);
    assert.match(await sent("SELECT DISTINCT d.id, d.w FROM late_d d ORDER BY d.id LIMIT 5"), /any_value\(d\.rowid\) AS __mason_r1.* GROUP BY d\.id /);
    // what stays as it was: a key in part, no key, no LIMIT, a DISTINCT over an aggregate or beside a GROUP BY, a UNION
    for (const sql of ["SELECT DISTINCT p.c, p.note FROM late_p p ORDER BY 1, 2 LIMIT 3",
      "SELECT DISTINCT n.id, n.c FROM late_n n ORDER BY 1 LIMIT 3",
      "SELECT DISTINCT l.id, l.k FROM late l ORDER BY l.id",
      "SELECT DISTINCT count(*) AS n FROM late l LIMIT 3",
      "SELECT DISTINCT l.id, count(*) AS n FROM late l GROUP BY l.id ORDER BY 1 LIMIT 3",
      "SELECT l.id, l.k FROM late l WHERE l.id < 3 UNION SELECT l.id, l.k FROM late l WHERE l.id < 5 ORDER BY 1 LIMIT 3"]) {
      assert.doesNotMatch(await sent(sql), /__mason_r1/, sql);
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
    }
    // a statement prepared, run after a SET: the same plan
    await c.query({ name: "keyfirst_distinct", text: "SELECT DISTINCT l.id, l.j, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT $1", values: [2] });
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    logged.length = 0;
    const again = await c.query({ name: "keyfirst_distinct", text: "SELECT DISTINCT l.id, l.j, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT $1", values: [3], rowMode: "array" });
    assert.equal(again.rows.length, 3);
    assert.match(logged.findLast((l) => l.startsWith("statement: ")) ?? "", KEYED);
  } finally { await c.end(); }
});

test("a DISTINCT ON with a LIMIT chooses its rows by row number and reads the columns of the kept rows alone (issue 134, step 6, task E)", async () => {
  const c = await client();
  const held = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => r.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : v)) });
  const sent = async (cl: pg.Client, sql: string): Promise<string> => {
    logged.length = 0;
    await cl.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  // the DISTINCT ON inside, each kept row's numbers chosen there, each table read again by its row number outside
  const BY_ROW = /SELECT DISTINCT ON \(.*\) \w+\.(rowid|__mason_rid) AS __mason_r1.*\) AS __mason_late LEFT JOIN .* ON \w+\.(rowid|__mason_rid) = __mason_late\.__mason_r1/;
  const libc = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: (l) => (logged.push(l), everLogged.push(l)),
    duck: await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, undefined,
      handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({})], [" "], { collate: "en_US.utf8" }), () => copies),
  });
  const onLibc = new pg.Client({ host: "127.0.0.1", port: libc.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await onLibc.connect();
  try {
    // the kept row of each group is the first by a sort total within it, or the list shows the ON table's columns alone
    const answered = [
      "SELECT DISTINCT ON (c.id) c.id, c.name, l.id AS lid, l.j FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id, l.id DESC LIMIT 5",
      "SELECT DISTINCT ON (c.id) c.id, c.name, l.id AS lid, l.j FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id DESC, l.id LIMIT 4 OFFSET 3",
      "SELECT DISTINCT ON (c.id) c.id, c.name FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id LIMIT 5",
      // a NULL key on the nullable side: one group, l's columns NULL
      "SELECT DISTINCT ON (l.id) c.id, c.name, l.id AS lid, l.k FROM late_c c LEFT JOIN late l ON l.c = c.id AND l.id > 1990 ORDER BY l.id NULLS FIRST, c.id LIMIT 6",
      // a key that is no primary key, one table
      "SELECT DISTINCT ON (l.c) l.c, l.id, l.j FROM late l ORDER BY l.c, l.k LIMIT 5",
      // the ON by ordinal and by output name, the sort by output name
      "SELECT DISTINCT ON (1) c.id AS cid, c.name, l.id AS lid FROM late_c c JOIN late l ON l.c = c.id ORDER BY 1, lid DESC LIMIT 3",
      "SELECT DISTINCT ON (cid) c.id AS cid, c.name, l.id AS lid, l.j FROM late_c c JOIN late l ON l.c = c.id ORDER BY cid, lid DESC LIMIT 3",
      // a computed ON expression shown, the ON in another order than the sort; an ON expression the sort lacks (Postgres
      // appends it: a sort key between would be its 42P10)
      "SELECT DISTINCT ON (c.id, l.k % 2) c.id, l.k % 2 AS parity, l.id AS lid, l.j FROM late_c c JOIN late l ON l.c = c.id ORDER BY l.k % 2, c.id, l.id DESC LIMIT 6",
      "SELECT DISTINCT ON (l.id, l.c) l.id, l.c, l.j FROM late l ORDER BY l.id LIMIT 3",
      // a jsonb ON expression: the rewrite's equality key inside
      "SELECT DISTINCT ON (l.j) l.j, l.id FROM late l ORDER BY l.j, l.id LIMIT 3",
      // the nulls idiom after the key
      "SELECT DISTINCT ON (c.id) c.id, c.name, l.k FROM late_c c LEFT JOIN late l ON l.c = c.id AND l.id > 1990 ORDER BY c.id, l.k IS NULL, l.k DESC LIMIT 6",
      // a constant sort key beside the ON: the analysis's Const
      "SELECT DISTINCT ON (l.c) l.c, l.id FROM late l ORDER BY l.c DESC, 1.5::numeric, l.id DESC LIMIT 3",
      // a plain derived side, a view of a join folded first, USING's merged column
      "SELECT DISTINCT ON (c.id) c.id, c.name, d.id AS lid, d.n FROM late_c c JOIN (SELECT id, c, (j->>'n') AS n FROM late WHERE id < 1000) d ON d.c = c.id ORDER BY c.id, d.id DESC LIMIT 4",
      "SELECT DISTINCT ON (v.name) v.name, v.id, v.j FROM late_joined v ORDER BY v.name, v.id DESC LIMIT 4",
      "SELECT DISTINCT ON (id) id, name, l.k FROM late_c c JOIN (SELECT c AS id, k FROM late) l USING (id) ORDER BY id, l.k LIMIT 4",
      // each collation kind on the key that decides the kept row
      'SELECT DISTINCT ON (l.c) l.c, c.name, l.id FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.c, c.name COLLATE "C", l.id DESC LIMIT 4',
      'SELECT DISTINCT ON (l.c) l.c, c.name, l.id FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.c, c.name COLLATE "und-x-icu", l.id DESC LIMIT 4',
      "SELECT DISTINCT ON (l.c) l.c, c.name, l.id FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.c, c.name, l.id DESC LIMIT 4",
    ];
    for (const sql of answered) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
      const line = await sent(c, sql);
      assert.match(line, BY_ROW, sql);
      assert.doesNotMatch(line, /any_value/, sql);
    }
    // the database's libc order: the same rows
    const bare = "SELECT DISTINCT ON (l.c) l.c, c.name, l.id FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.c, c.name, l.id DESC LIMIT 4";
    assert.deepEqual(await answer(onLibc, bare), await postgres(bare), bare);
    assert.match(await sent(onLibc, bare), BY_ROW, bare);
    // the measured shape, written out: both tables' row numbers, each read again outside
    assert.match(await sent(c, answered[0]!), /SELECT DISTINCT ON \(c\.id\) c\.rowid AS __mason_r1, l\.rowid AS __mason_r2, .*\) AS __mason_late LEFT JOIN late_c AS c ON c\.rowid = __mason_late\.__mason_r1 LEFT JOIN late AS l ON l\.rowid = __mason_late\.__mason_r2/);
    // ties with another table's column: as many rows, c.id distinct, each a row of the whole join
    const tied = await answer(c, "SELECT DISTINCT ON (c.id) c.id, l.id AS lid, l.j FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id LIMIT 5");
    assert.deepEqual(tied.rows.map((r) => r[0]), ["0", "1", "2", "3", "4"]);
    const whole = held(await postgres("SELECT c.id, l.id AS lid, l.j FROM late_c c JOIN late l ON l.c = c.id")) as { rows: unknown[][] };
    for (const r of (held(tied) as { rows: unknown[][] }).rows) assert.ok(whole.rows.some((w) => JSON.stringify(w) === JSON.stringify(r)), JSON.stringify(r));
    // the sort does not start with the ON: the catalog's own refusal, as Postgres's
    const odd = "SELECT DISTINCT ON (c.id) c.id, l.id FROM late_c c JOIN late l ON l.c = c.id ORDER BY l.id, c.id LIMIT 3";
    const [ours, theirs] = await Promise.all([c.query(odd).then(() => null, (e: pg.DatabaseError) => [e.code, e.message]), postgres(odd).then(() => null, (e: { code?: string; message: string }) => [e.code, e.message])]);
    assert.deepEqual(ours, ["42P10", "SELECT DISTINCT ON expressions must match initial ORDER BY expressions"]);
    assert.deepEqual(ours, theirs);
    // the copy's transient duplicate key is one row
    assert.deepEqual((await answer(c, "SELECT DISTINCT ON (d.id) d.id, d.w FROM late_d d ORDER BY d.id LIMIT 5")).rows, [["1", "one"], ["2", "two"], ["3", "three"]]);
    assert.match(await sent(c, "SELECT DISTINCT ON (d.id) d.id, d.w FROM late_d d ORDER BY d.id LIMIT 5"), BY_ROW);
    // no ORDER BY: as many rows, l.c distinct, each a row of late
    const unsorted = held(await answer(c, "SELECT DISTINCT ON (l.c) l.c, l.j FROM late l LIMIT 5")) as { rows: unknown[][] };
    assert.equal(new Set(unsorted.rows.map((r) => r[0])).size, 5);
    const all = held(await postgres("SELECT l.c, l.j FROM late l")) as { rows: unknown[][] };
    for (const r of unsorted.rows) assert.ok(all.rows.some((w) => JSON.stringify(w) === JSON.stringify(r)), JSON.stringify(r));
    // what stays as it was: no LIMIT, LIMIT ALL, over a GROUP BY, a window, a column named rowid in any case
    for (const sql of ["SELECT DISTINCT ON (c.id) c.id, c.name, l.id FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id, l.id",
      "SELECT DISTINCT ON (c.id) c.id, c.name FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id, l.id LIMIT ALL",
      "SELECT DISTINCT ON (l.c) l.c, count(*) AS n FROM late l GROUP BY l.c ORDER BY l.c LIMIT 3",
      "SELECT DISTINCT ON (l.c) l.c, l.id, row_number() OVER (ORDER BY l.id) AS rn FROM late l ORDER BY l.c, l.id LIMIT 3",
      'SELECT DISTINCT ON (r.id) r.id, r."RowId" FROM rowid_cased r ORDER BY r.id LIMIT 3']) {
      assert.doesNotMatch(await sent(c, sql), /__mason_r1/, sql);
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
    }
    // WITH TIES: answered as Postgres does (issue 192), its DISTINCT ON keeping its own sort
    const ties = "SELECT DISTINCT ON (c.id) c.id, l.id FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id, l.id FETCH FIRST 3 ROWS WITH TIES";
    assert.deepEqual(held(await answer(c, ties)), held(await postgres(ties)), ties);
    // a statement prepared, run after a SET: the same plan
    const text = "SELECT DISTINCT ON (c.id) c.id, c.name, l.id AS lid, l.j FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id, l.id DESC LIMIT $1";
    await c.query({ name: "distinct_on", text, values: [2] });
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    logged.length = 0;
    const again = await c.query({ name: "distinct_on", text, values: [3], rowMode: "array", types: raw } as pg.QueryConfig);
    assert.deepEqual(held({ fields: [], rows: again.rows }), held({ fields: [], rows: (await postgres(text, [3])).rows }));
    assert.match(logged.findLast((l) => l.startsWith("statement: ")) ?? "", BY_ROW);
  } finally { await c.end(); await onLibc.end(); await libc.close(); }
});

const heldJson = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => r.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : v)) });

test("a DISTINCT ON sorts by the ON expressions its ORDER BY lacks, appended as Postgres does (PR 207's review)", async () => {
  const c = await client();
  try {
    // the ON expressions the ORDER BY lacks are appended, ASC NULLS LAST, and a LIMIT keeps the first groups of that order
    for (const sql of ["SELECT DISTINCT ON (l.c, l.k % 3) l.c, l.k % 3 AS m FROM late l ORDER BY l.c DESC LIMIT 4",
      "SELECT DISTINCT ON (c.id, l.k % 3) c.id, l.k % 3 AS m FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id LIMIT 4",
      "SELECT DISTINCT ON (l.k % 3, l.c) l.c, l.k % 3 AS m FROM late l ORDER BY l.k % 3 LIMIT 4",
      "SELECT DISTINCT ON (c.id, l.k % 3) c.id, c.name, l.k % 3 AS m FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id DESC LIMIT 4 OFFSET 1",
      "SELECT DISTINCT ON (l.c, m) l.c, l.k % 3 AS m FROM late l ORDER BY l.c DESC LIMIT 4",
      "SELECT DISTINCT ON (l.c, 2) l.c, l.k % 3 AS m FROM late l ORDER BY 1 DESC",
      "SELECT DISTINCT ON (l.c) l.c, l.id FROM late l ORDER BY l.c DESC, l.id LIMIT 4",
      // no ORDER BY: Postgres's Unique runs over the ON expressions' order
      "SELECT DISTINCT ON (l.c) l.c FROM late l LIMIT 4 OFFSET 2"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    assert.deepEqual((await answer(c, "SELECT DISTINCT ON (l.c, l.k % 3) l.c, l.k % 3 AS m FROM late l ORDER BY l.c DESC LIMIT 4")).rows,
      [["49", "0"], ["49", "1"], ["49", "2"], ["48", "0"]]);
    // still chosen by row number, the inner query and the outer sorting by the appended key too
    logged.length = 0;
    await c.query("SELECT DISTINCT ON (l.c, l.k % 3) l.c, l.k % 3 AS m FROM late l ORDER BY l.c DESC LIMIT 4");
    const line = logged.findLast((l) => l.startsWith("statement: ")) ?? "";
    assert.match(line, /SELECT DISTINCT ON \(.*\) l\.rowid AS __mason_r1.* ORDER BY l\.c DESC, \(?l\.k % 3\)? LIMIT 4 \) AS __mason_late .* ORDER BY __mason_late\.__mason_o1 DESC, __mason_late\.__mason_o2/);
  } finally { await c.end(); }
});

test("a DISTINCT ON of a jsonb named by its output compares by jsonb's equality (PR 207's review)", async () => {
  const c = await client();
  const held = heldJson;
  try {
    // a jsonb ON named by its output, by its number and as the expression: jsonb's equality each, one statement
    for (const sql of ["SELECT DISTINCT ON (k) q.v -> 'k' AS k, q.id FROM jq_on q ORDER BY k, q.id LIMIT 8",
      "SELECT DISTINCT ON (1) q.v -> 'k' AS k, q.id FROM jq_on q ORDER BY k, q.id LIMIT 8",
      "SELECT DISTINCT ON (q.v -> 'k') q.v -> 'k' AS k, q.id FROM jq_on q ORDER BY q.v -> 'k', q.id LIMIT 8",
      "SELECT DISTINCT ON (v) q.v -> 'k' AS v, q.id FROM jq_on q ORDER BY v, q.id LIMIT 8",
      "SELECT DISTINCT ON (k) q.v -> 'k' AS k, q.id, c.name FROM jq_on q LEFT JOIN late_c c ON c.id = q.id ORDER BY k, q.id LIMIT 8",
      "SELECT DISTINCT ON (k) q.v -> 'k' AS k, q.id FROM jq_on q ORDER BY k, q.id"]) {
      const ours = held(await answer(c, sql)) as { rows: unknown[][] };
      assert.deepEqual(ours, held(await postgres(sql)), sql);
      assert.equal(ours.rows.length, 4, sql);
    }
  } finally { await c.end(); }
});

// ISSUE 212: a jsonb EXPRESSION a GROUP BY names is a grouped expression, by the GROUP BY as Postgres analysed it (each
// item resolved to the expression it groups, recorded before any rule writes the clause for the engine), so every
// reader of it — a cast, an output function, HAVING, ORDER BY, a subquery around it — reads its stored text, per group,
// through ONE any_value of the whole expression, never the column's (`any_value(j.j) -> 'r'` wrote 2.45 for 2.450, and
// `any_value(j.j) #> '{r}'` was the engine's 42601)
test("a jsonb expression's text under a GROUP BY of it is its stored text (issue 212)", async () => {
  const c = await client();
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  try {
    const grouped: Array<[string, "ordered" | "bag"]> = [
      ["SELECT (j.j -> 'r')::text AS k, count(*) AS n FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k, count(*) FROM jnums j GROUP BY j.j -> 'r', j.id ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k FROM jnums j GROUP BY j.id, (j.j -> 'r') ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS t, j.j -> 'r' AS k FROM jnums j GROUP BY j.id, k ORDER BY j.id", "ordered"],
      ["SELECT j.id, j.j -> 'r', (j.j -> 'r')::text FROM jnums j GROUP BY 1, 2 ORDER BY 1", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k, count(*) FROM jnums j GROUP BY j.j -> 'r' ORDER BY 1 NULLS FIRST", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k, count(*) FROM jnums j GROUP BY j.g, j.j -> 'r' ORDER BY 1 NULLS FIRST", "ordered"],
      ["SELECT concat(j.j -> 'r', '|') AS a, format('%s', j.j -> 'r') AS b, (j.j -> 'r')::text || '' AS c FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::varchar(3) AS k, (j.j -> 'r')::varchar AS c FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT jsonb_build_object('x', j.j -> 'r')::text AS a, (j.j -> 'r') ->> 0 AS b, jsonb_typeof(j.j -> 'r') AS d FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k FROM jnums j GROUP BY j.id, j.j -> 'r' HAVING (j.j -> 'r')::text <> 'x' ORDER BY (j.j -> 'r')::text NULLS FIRST, j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k FROM jnums j GROUP BY j.id, j.j -> 'r' HAVING count(*) > 0 ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k, count(*) FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id FETCH FIRST 2 ROWS WITH TIES", "ordered"],
      ["SELECT DISTINCT ON (j.g) j.g, (j.j -> 'r')::text AS k FROM jnums j GROUP BY j.g, j.id, j.j -> 'r' ORDER BY j.g, j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k, row_number() OVER (ORDER BY j.id) FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k, count(*) FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id LIMIT 3", "ordered"],
      ["SELECT s.k FROM (SELECT (j.j -> 'r')::text AS k, j.id FROM jnums j GROUP BY j.id, j.j -> 'r') s ORDER BY s.id", "ordered"],
      ["WITH s AS (SELECT (j.j -> 'r')::text AS k, j.id FROM jnums j GROUP BY j.id, j.j -> 'r') SELECT k FROM s ORDER BY id", "ordered"],
      ["SELECT x.id, (SELECT (y.j -> 'r')::text FROM jnums y WHERE y.id = x.id GROUP BY y.id, y.j -> 'r') AS k FROM jnums x ORDER BY x.id", "ordered"],
      ["SELECT (j.j #> '{r}')::text AS a, jsonb_typeof(j.j #> '{r}') AS b FROM jnums j GROUP BY j.id, j.j #> '{r}' ORDER BY j.id", "ordered"],
      ["SELECT (j.j #> '{r}')::text AS k FROM jnums j GROUP BY j.j #> '{r}' ORDER BY 1 NULLS FIRST", "ordered"],
      ["SELECT (j.j #> ARRAY['r'])::text AS k FROM jnums j GROUP BY j.id, j.j #> ARRAY['r'] ORDER BY j.id", "ordered"],
      // every jsonb kind (1, 1.0 and 1.00 are one group of jsonb's equality: each row its own group here)
      ["SELECT id, (v -> 'k')::text, concat(v -> 'k', '|') FROM jq GROUP BY id, v -> 'k' ORDER BY id", "ordered"],
      ["SELECT id, (v -> 'k' -> 'a')::text FROM jq GROUP BY id, v -> 'k' -> 'a' ORDER BY id", "ordered"],
      // what was right stays so
      ["SELECT j.j -> 'r' AS k, count(*) FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k FROM jnums j GROUP BY 1, j.id ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k FROM jnums j GROUP BY j.id ORDER BY j.id", "ordered"],
      ["SELECT j.j::text AS k, count(*) FROM jnums j GROUP BY j.id, j.j ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k, count(*) FROM jnums j GROUP BY j.g, j.j ORDER BY j.g, 1", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k FROM jnums j ORDER BY j.id", "ordered"],
      ["SELECT (j.j ->> 'r') AS k FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r') = '2.45'::jsonb AS k FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text AS k FROM jnums j WHERE j.id < 0 GROUP BY j.id, j.j -> 'r'", "ordered"],
      ["SELECT x / 1 AS q, count(*) FROM bigdec GROUP BY 1 ORDER BY 2 DESC, 1 FETCH FIRST 1 ROWS WITH TIES", "ordered"],
      ["SELECT x / 1 AS q, count(*) FROM bigdec GROUP BY x / 1 ORDER BY 2 DESC, 1 FETCH FIRST 1 ROWS WITH TIES", "ordered"],
      ["SELECT x / 1 AS q, count(*) FROM bigdec GROUP BY q ORDER BY 2 DESC, 1 FETCH FIRST 1 ROWS WITH TIES", "ordered"],
      ["SELECT t.s COLLATE \"und-x-icu\" AS x, count(*) FROM texts t GROUP BY 1 ORDER BY 1", "ordered"],
    ];
    assert.deepEqual(await unlike(c, grouped), []);
    // jsonb's numeric: Postgres's answer, or refused by the allowlist, which has not verified the cast
    const numeric = "SELECT (j.j -> 'r')::numeric::text AS c FROM jnums j WHERE j.id <> 4 GROUP BY j.id, j.j -> 'r' ORDER BY j.id";
    assert.deepEqual(await answeredOrRefused(c, numeric, "unverified"), [], numeric);
    // a grouping set of a jsonb stays refused, by name
    await assert.rejects(c.query("SELECT (j.j -> 'r')::text AS k, count(*) FROM jnums j GROUP BY ROLLUP (j.id, j.j -> 'r') ORDER BY j.id, 1"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap jsonb-compare\b/.test(`${e.detail ?? ""} ${e.hint ?? ""}`));
    // the text is read by the jsonb text route over ONE any_value of the whole expression, never the column's
    for (const sql of ["SELECT (j.j -> 'r')::text AS k, count(*) AS n FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id",
      "SELECT (j.j #> '{r}')::text AS k FROM jnums j GROUP BY j.j #> '{r}' ORDER BY 1 NULLS FIRST"]) {
      const line = await sent(sql);
      assert.match(line, /__mason_jsonb_text\(.*any_value\(/, line);
      assert.doesNotMatch(line, /any_value\("?j"?\."?j"?\)/, line);
    }
  } finally { await c.end(); }
});

// PR 582's review, round 1: an ORDER BY's bare name is the output it names first (`ORDER BY v` of `v::text` sorts the
// text), never the jsonb column grouped by its key
test("an ORDER BY of an output's name under a GROUP BY of a jsonb sorts the output (PR 582 review r1)", async () => {
  const c = await client();
  try {
    // (1, 1.0 and 1.00 are one group of jsonb's equality, whose text either may print: left out)
    assert.deepEqual(await unlike(c, [
      ["SELECT v::text FROM jq WHERE id NOT IN (3, 13) GROUP BY v ORDER BY v NULLS FIRST", "ordered"],
      ["SELECT v::text FROM jq WHERE id NOT IN (3, 13) GROUP BY id, v ORDER BY v, id", "ordered"],
      ["SELECT max(id), v::text FROM jq WHERE id NOT IN (3, 13) GROUP BY v ORDER BY v", "ordered"],
      ["SELECT v::text FROM jq WHERE id NOT IN (3, 13) GROUP BY v ORDER BY v DESC NULLS LAST", "ordered"],
      ["SELECT DISTINCT ON (v) v::text FROM jq WHERE id NOT IN (3, 13) GROUP BY v, id ORDER BY v, id", "ordered"],
      ["SELECT v::text AS t FROM jq WHERE id NOT IN (3, 13) GROUP BY v ORDER BY v NULLS FIRST", "ordered"],
      ["SELECT v -> 'k' AS v FROM jq WHERE id NOT IN (3, 13) GROUP BY v ORDER BY v NULLS FIRST", "ordered"],
      ["SELECT max(id) FROM jq WHERE id NOT IN (3, 13) GROUP BY v ORDER BY v NULLS FIRST", "ordered"],
      ["SELECT v::text FROM jq WHERE id NOT IN (3, 13) GROUP BY v ORDER BY v NULLS FIRST LIMIT 3", "ordered"],
      ["SELECT x::text AS x FROM (VALUES ('{\"k\": 1}'::jsonb), ('{\"k\": \"a\"}'), ('{\"k\": null}'), (NULL)) s(x) GROUP BY x ORDER BY x", "ordered"],
    ]), []);
    // a grouped jsonb cast to a number or a boolean is refused by name as main refuses it (the allowlist has not verified
    // float8(jsonb), float4(jsonb), numeric(jsonb) or bool(jsonb): #648 holds them), never the engine's 22P02 of 'null'
    for (const ty of ["float8", "real", "numeric(10,2)", "boolean", "int"]) {
      const sql = `SELECT j.id, (j.j -> 'r')::${ty} AS c FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id`;
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap unverified\b/.test(`${e.detail ?? ""} ${e.hint ?? ""}`), sql);
    }
  } finally { await c.end(); }
});

// PR 582's review, round 9: a cast of a grouped jsonb is typed by its RESULT, the text, at every position a key can
// occupy. A key with no analysed node of its own (one folded from `x IS NULL, x DESC`, a window's ORDER BY or PARTITION
// BY) was typed by its argument, the per-group read typed like the jsonb, so the text was sorted in jsonb's order (JSON
// null first, numbers by value). Pinned where the grouped expression is replaced (`decidedByKey`), from Postgres's
// analysis of the same cast. A jsonb cast to character stays refused by name, as main refuses it (#648 holds it).
test("a grouped jsonb's text is sorted as text wherever a key reads it (PR 582 review r9)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      // ORDER BY, folded into one key with its NULLS from `x IS NULL, x DESC`, and its plain spellings
      ["SELECT (j.j -> 'r')::text FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY (j.j -> 'r')::text IS NULL, (j.j -> 'r')::text DESC, j.id", "ordered"],
      ["SELECT (v -> 'k')::text AS k FROM jq GROUP BY id, v -> 'k' ORDER BY (v -> 'k')::text IS NULL, (v -> 'k')::text DESC, id", "ordered"],
      ["SELECT (j.j -> 'r')::varchar FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY (j.j -> 'r')::varchar IS NULL, (j.j -> 'r')::varchar DESC, j.id", "ordered"],
      ["SELECT (j.j #> '{r}')::text FROM jnums j GROUP BY j.id, j.j #> '{r}' ORDER BY (j.j #> '{r}')::text IS NULL, (j.j #> '{r}')::text DESC, j.id", "ordered"],
      ["SELECT j.id FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY (j.j -> 'r')::text NULLS FIRST, j.id", "ordered"],
      ["SELECT j.id FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY (j.j -> 'r')::text DESC, j.id", "ordered"],
      // a window's ORDER BY and PARTITION BY
      ["SELECT (j.j -> 'r')::text, rank() OVER (ORDER BY (j.j -> 'r')::text) FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT j.id, rank() OVER (ORDER BY (j.j -> 'r')::text DESC) FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT (v -> 'k')::text, rank() OVER (ORDER BY (v -> 'k')::text), id FROM jq WHERE id NOT IN (3, 13) GROUP BY id, v -> 'k' ORDER BY id", "ordered"],
      ["SELECT j.g, (j.j -> 'r')::text, rank() OVER (PARTITION BY j.g ORDER BY (j.j -> 'r')::text) FROM jnums j GROUP BY j.g, j.id, j.j -> 'r' ORDER BY j.id", "ordered"],
      ["SELECT id, count(*) OVER (PARTITION BY (v -> 'k')::text) FROM jq GROUP BY id, v -> 'k' ORDER BY id", "ordered"],
      // HAVING, WITH TIES, and the column grouped whole
      ["SELECT j.id, (j.j -> 'r')::text FROM jnums j GROUP BY j.id, j.j -> 'r' HAVING (j.j -> 'r')::text > '1' ORDER BY j.id", "ordered"],
      ["SELECT (j.j -> 'r')::text FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY (j.j -> 'r')::text DESC FETCH FIRST 2 ROWS WITH TIES", "ordered"],
      // (the column grouped whole, its key folded from `v::text IS NULL, v::text DESC`, is the base's 42803 as on main)
      ["SELECT v::text, rank() OVER (ORDER BY v::text) FROM jq WHERE id NOT IN (3, 13) GROUP BY id, v ORDER BY id", "ordered"],
    ]), []);
    // a jsonb cast to character is refused by name as main refuses it, grouped or not
    for (const sql of ["SELECT (j.j -> 'r')::char(6) FROM jnums j GROUP BY j.id, j.j -> 'r' ORDER BY j.id",
      "SELECT nullif((j.j -> 'r')::char(5), '-3') FROM jnums j ORDER BY j.id"]) {
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap unverified\b/.test(`${e.detail ?? ""} ${e.hint ?? ""}`), sql);
    }
  } finally { await c.end(); }
});

test("a numeric quotient under a DISTINCT ON or a DISTINCT shows Postgres's exact text (PR 207's review)", async () => {
  const c = await client();
  const held = heldJson;
  try {
    // a numeric quotient under a DISTINCT ON or a DISTINCT: Postgres's exact text, from the kept row's cells
    for (const sql of ["SELECT DISTINCT ON (o.id) o.id, o.amount / 3 AS third, o.meta FROM orders o ORDER BY o.id DESC LIMIT 2",
      "SELECT DISTINCT ON (o.id) o.id, o.amount / 3 AS third FROM orders o ORDER BY o.id DESC",
      "SELECT DISTINCT ON (l.c) l.c, l.k::numeric / 7 AS q, l.id FROM late l ORDER BY l.c, l.id LIMIT 2",
      "SELECT DISTINCT ON (c.id) c.id, l.k::numeric / 7 AS q FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id, l.id LIMIT 3",
      "SELECT DISTINCT o.amount / 3 AS third FROM orders o ORDER BY 1",
      "SELECT DISTINCT o.status, o.amount / 3 AS third FROM orders o ORDER BY 2 DESC, 1 LIMIT 2"]) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
    }
  } finally { await c.end(); }
});

/** an answer's rows in one order: quotients equal to a double's 17 digits are in no defined order on Mason (the listed
 *  difference numeric-quotient-compare), so a test of their equality reads the rows as a set */
const rowSet = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => JSON.stringify(r)).sort() });

test("a numeric quotient passed through a DISTINCT shows Postgres's exact text (PR 207's class round, P3 P4 C10)", async () => {
  const c = await client();
  try {
    for (const sql of ["SELECT DISTINCT * FROM (SELECT o.amount / 3 AS third FROM orders o) s ORDER BY 1",
      "SELECT DISTINCT s.third FROM (SELECT o.amount / 3 AS third FROM orders o) s ORDER BY 1",
      "SELECT DISTINCT third FROM (SELECT DISTINCT o.amount / 3 AS third FROM orders o) s ORDER BY 1",
      "SELECT DISTINCT * FROM (SELECT o.amount / o.qty AS per FROM orders o) s ORDER BY 1",
      "WITH q AS (SELECT o.status, o.amount / 3 AS third FROM orders o) SELECT DISTINCT * FROM q ORDER BY 2",
      "SELECT DISTINCT * FROM (SELECT * FROM (SELECT o.amount / 3 AS third FROM orders o) a) b ORDER BY 1",
      "SELECT DISTINCT ON (s.status) * FROM (SELECT o.status, o.amount / 3 AS third FROM orders o) s ORDER BY s.status, s.third",
      "SELECT DISTINCT ON (1) s.third, s.status FROM (SELECT o.status, o.amount / 3 AS third FROM orders o) s ORDER BY 1, 2",
      "SELECT DISTINCT ON (third) third, status FROM (SELECT o.status, o.amount / 3 AS third FROM orders o) s ORDER BY third, status",
      // equal to the double's 17 digits, told apart by the inner query's cells
      "SELECT DISTINCT * FROM (SELECT b.x / 1 AS q FROM bigdec b) s ORDER BY 1",
      "SELECT DISTINCT s.q FROM (SELECT b.x / b.y AS q FROM bigdec b) s ORDER BY 1 LIMIT 3"]) {
      assert.deepEqual(rowSet(await answer(c, sql)), rowSet(await postgres(sql)), sql);
    }
  } finally { await c.end(); }
});

test("issue 214: a numeric parameter beside a value the engine holds exactly is compared exactly, natively where its type holds it", async () => {
  const c = await client();
  try {
    const x = "SELECT b.id FROM bigdec b WHERE";
    const shapes: Array<[string, Array<Array<string | null>>]> = [
      [`${x} b.x = $1 ORDER BY 1`, [["1.00000000000000000001"], ["1.00000000000000000002"], ["1.000000000000000000015"], ["1.000000000000000000014"], ["-1.000000000000000000015"],
        ["0.000000000000000000001"], ["2.5"], ["2.50000000000000000000000"], ["12345678901.5"], ["99999999999999999999999999999999999999999.5"], ["NaN"], ["Infinity"], ["-Infinity"], [null]]],
      ["SELECT b.id, b.x = $1, b.x <> $1, b.x IS DISTINCT FROM $1, b.x IS NOT DISTINCT FROM $1, nullif(b.x, $1), CASE b.x WHEN $1 THEN 'hit' ELSE 'miss' END FROM bigdec b ORDER BY 1",
        [["1.00000000000000000001"], ["1.000000000000000000015"], [null], ["NaN"]]],
      [`${x} $1 = b.x ORDER BY 1`, [["1.00000000000000000001"]]],
      [`${x} $1 < b.x ORDER BY 1`, [["1.000000000000000000015"]]],
      [`${x} b.x < $1 ORDER BY 1`, [["1.000000000000000000015"], ["1.00000000000000000002"], ["NaN"], ["Infinity"], ["-Infinity"], ["-99999999999999999999999999999999999999999"], ["99999999999999999999999999999999999999999"]]],
      [`${x} b.x <= $1 ORDER BY 1`, [["1.000000000000000000015"], ["1.00000000000000000002"], ["1.000000000000000000019"]]],
      [`${x} b.x > $1 ORDER BY 1`, [["1.000000000000000000015"], ["1.00000000000000000001"], ["NaN"], ["-Infinity"]]],
      [`${x} b.x >= $1 ORDER BY 1`, [["1.000000000000000000011"], ["2.5"]]],
      [`${x} b.x BETWEEN $1 AND $2 ORDER BY 1`, [["1.000000000000000000005", "1.000000000000000000015"], ["1.00000000000000000001", "1.00000000000000000002"], ["1", null]]],
      [`${x} b.x NOT BETWEEN $1 AND $2 ORDER BY 1`, [["1.000000000000000000005", "1.000000000000000000015"]]],
      [`${x} b.x IN ($1, $2) ORDER BY 1`, [["1.00000000000000000001", "5"], ["1.000000000000000000015", "2.5"], [null, "5"]]],
      [`${x} b.x NOT IN ($1, $2) ORDER BY 1`, [["1.00000000000000000001", "5"], ["1.000000000000000000015", "2.5"]]],
      [`${x} b.x IN ($1, 5) ORDER BY 1`, [["1.00000000000000000001"]]],
      [`${x} b.x = $1::numeric(30,20) ORDER BY 1`, [["1.000000000000000000015"]]],
      [`${x} b.x < $1::numeric(30,20) ORDER BY 1`, [["1.000000000000000000015"]]],
      [`${x} b.x = $1::numeric ORDER BY 1`, [["1.000000000000000000015"], ["1.00000000000000000001"]]],
      [`${x} b.x * 2 = $1 ORDER BY 1`, [["2.00000000000000000002"]]],
      [`${x} b.x + b.y > $1 ORDER BY 1`, [["2.000000000000000000015"]]],
      ["SELECT b.y, sum(b.x) FROM bigdec b GROUP BY b.y HAVING sum(b.x) = $1 ORDER BY 1", [["4.50000000000000000003"], ["4.50000000000000000002"]]],
      [`${x} b.id = $1::numeric ORDER BY 1`, [["1.00000000000000000001"], ["1"]]],
      [`${x} b.id < $1::numeric ORDER BY 1`, [["2.99999999999999999999"], ["3"], ["99999999999999999999"]]],
      [`${x} b.x / 1 = $1 ORDER BY 1`, [["1.00000000000000000001"]]],
      ["SELECT o.id FROM orders o WHERE o.amount = $1 ORDER BY 1", [["42.001"], ["42.00"], ["42"]]],
      ["SELECT o.id FROM orders o WHERE o.amount BETWEEN $1 AND $2 ORDER BY 1", [["41.995", "42.005"]]],
      ["SELECT p.id FROM pnum p WHERE p.u = $1 ORDER BY 1", [["1.2345"], ["1.23450000000000000001"], ["7"]]],
      ["SELECT p.id FROM pnum p WHERE p.w = $1 ORDER BY 1", [["19.99"], ["19.990000000000000000000000000001"], ["123456789012345678901234567890.25"]]],
      ["SELECT p.id FROM pnum p WHERE p.w < $1 ORDER BY 1", [["19.995"], ["123456789012345678901234567890.251"]]],
      ["SELECT p.id, p.w > $1, p.u >= $1 FROM pnum p ORDER BY 1", [["5"], ["5.000000000000000000000000000001"]]],
    ];
    for (const [sql, bindings] of shapes) {
      for (const values of bindings) assert.deepEqual(await answer(c, sql, values), await postgres(sql, values), `${sql} bound ${JSON.stringify(values)}`);
    }
    // the issue's own: Postgres's rows, never the double's
    const ids = async (sql: string, values: Array<string | null>): Promise<unknown[]> => (await answer(c, sql, values)).rows.map((r) => r[0]);
    assert.deepEqual(await ids(`${x} b.x = $1 ORDER BY 1`, ["1.00000000000000000001"]), ["1"]);
    assert.deepEqual(await ids(`${x} b.x <= $1 ORDER BY 1`, ["1.000000000000000000015"]), ["1"]);
    assert.deepEqual(await ids(`${x} b.x = $1::numeric(30,20) ORDER BY 1`, ["1.000000000000000000015"]), ["2"]);
    // = ANY of a numeric[] parameter: Postgres's rows, or an error — never the double's [1, 2, 4] (its element type is
    // issue 583's: unchanged here)
    const any = `${x} b.x = ANY($1::numeric[]) ORDER BY 1`;
    const anyAnswer = await answer(c, any, ["{1.00000000000000000001,5}"]).catch((e: unknown) => e as Error);
    if (!(anyAnswer instanceof Error)) assert.deepEqual(anyAnswer, await postgres(any, ["{1.00000000000000000001,5}"]), any);
    // one Parse's plan, several values (a prepared statement executed again)
    const prepared = `${x} b.x = $1 ORDER BY 1`;
    for (const [value, rows] of [["2.5", ["3", "5"]], ["1.000000000000000000015", []], ["1.00000000000000000001", ["1"]], [null, []]] as Array<[string | null, string[]]>) {
      const r = await c.query({ name: "issue214", text: prepared, values: [value], rowMode: "array", types: raw } as pg.QueryConfig);
      assert.deepEqual(r.rows.map((row) => (row as unknown[])[0]), rows, `prepared, bound ${String(value)}`);
    }
    // the native case: the engine's own comparison, no exact key computed per row — each Mason call over constants only,
    // folded by DuckDB once (the guard, and the keyed branch's parameter key it drops); a value the type does not hold is
    // keyed row by row (150,000 rows: dozens of vectors)
    const counts = async (): Promise<Map<string, number>> => new Map(await store.functionCalls());
    const calledFor = async (sql: string, values: string[]): Promise<Array<[string, number]>> => {
      const before = await counts();
      assert.deepEqual(await answer(c, sql, values), await postgres(sql, values), `${sql} bound ${JSON.stringify(values)}`);
      return [...await counts()].map(([k, v]): [string, number] => [k, v - (before.get(k) ?? 0)]).filter(([, n]) => n > 0);
    };
    for (const [sql, values] of [["SELECT count(*) FROM big WHERE id < $1::numeric", ["100"]], ["SELECT count(*) FROM big WHERE id::numeric = $1", ["99999"]],
      [`${x} b.x = $1 ORDER BY 1`, ["2.5"]], [`${x} b.x BETWEEN $1 AND $2 ORDER BY 1`, ["1", "2.5"]]] as Array<[string, string[]]>) {
      const called = await calledFor(sql, values);
      assert.ok(called.some(([k]) => k === "__mason_numeric_fits") && called.every(([, n]) => n <= values.length), `${sql}: ${JSON.stringify(called)}`);
    }
    const keyed = await calledFor("SELECT count(*) FROM big WHERE id < $1::numeric", ["100.5"]);
    assert.ok(keyed.some(([k, n]) => k === "__mason_numeric_order" && n > 10), `a value an integer does not hold is keyed row by row: ${JSON.stringify(keyed)}`);
  } finally { await c.end(); }
});

test("a numeric quotient is compared by its exact value wherever it is equated (PR 207's class round, C1-C8)", async () => {
  const c = await client();
  try {
    for (const sql of [
      // C1: SELECT DISTINCT, outermost and in a subquery
      "SELECT DISTINCT b.x / 1 AS q FROM bigdec b ORDER BY 1",
      "SELECT DISTINCT b.x / b.y AS q FROM bigdec b ORDER BY 1",
      "SELECT count(*) FROM (SELECT DISTINCT b.x / 1 FROM bigdec b) s",
      // C2: DISTINCT ON, by expression, alias, ordinal; under a LIMIT (the row-number route)
      "SELECT DISTINCT ON (b.x / 1) b.x / 1 AS q, b.id FROM bigdec b ORDER BY b.x / 1, b.id",
      "SELECT DISTINCT ON (q) b.x / 1 AS q, b.id FROM bigdec b ORDER BY q, b.id",
      "SELECT DISTINCT ON (1) b.x / b.y AS q, b.id FROM bigdec b ORDER BY 1, 2",
      "SELECT DISTINCT ON (b.x / 1) b.x / 1 AS q, b.id FROM bigdec b ORDER BY b.x / 1, b.id LIMIT 2",
      // C3: GROUP BY, by ordinal, expression, alias
      "SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY 1 ORDER BY 1",
      "SELECT b.x / 1, count(*) FROM bigdec b GROUP BY b.x / 1 ORDER BY 1",
      "SELECT b.x / b.y AS q, count(*) FROM bigdec b GROUP BY q ORDER BY 1",
      "SELECT a / b AS r, count(*), rank() OVER (ORDER BY a / b) FROM ratios GROUP BY 1 ORDER BY 1",
      // C5: PARTITION BY
      "SELECT b.id, count(*) OVER (PARTITION BY b.x / 1) FROM bigdec b ORDER BY 1",
      // C6: count(DISTINCT)
      "SELECT count(DISTINCT b.x / 1), count(DISTINCT b.x / b.y) FROM bigdec b",
      "SELECT count(DISTINCT a / b) FROM ratios",
      // C8: = and <> in a WHERE, a FILTER and a join's ON
      "SELECT b.id FROM bigdec b WHERE b.x / 1 = 1.00000000000000000001 ORDER BY 1",
      "SELECT b.id FROM bigdec b WHERE b.x / 1 <> 1.00000000000000000001 ORDER BY 1",
      "SELECT count(*) FILTER (WHERE b.x / b.y = 2.5), count(*) FILTER (WHERE a.n = 3) FROM bigdec b, ratios a",
      "SELECT a.id, c.id FROM bigdec a JOIN bigdec c ON a.x / 1 = c.x / c.y ORDER BY 1, 2",
      // the oracle's statements over a VALUES list
      "SELECT count(*) FROM (SELECT DISTINCT v.x / 1 FROM (VALUES (1.00000000000000000001::numeric(30,20)), (1.00000000000000000002), (2.5)) AS v(x)) s",
      "SELECT count(*), max(n) FROM (SELECT count(*) AS n FROM (VALUES (1.00000000000000000001::numeric(30,20)), (1.00000000000000000002), (2.5)) AS v(x) GROUP BY v.x / 1) g",
      "SELECT count(DISTINCT v.x / 1), count(*) FILTER (WHERE v.x / 1 = 1.00000000000000000001) FROM (VALUES (1.00000000000000000001::numeric(30,20)), (1.00000000000000000002), (2.5)) AS v(x)",
      "SELECT max(c) FROM (SELECT count(*) OVER (PARTITION BY v.x / 1) AS c FROM (VALUES (1.00000000000000000001::numeric(30,20)), (1.00000000000000000002), (2.5)) AS v(x)) w"]) {
      assert.deepEqual(rowSet(await answer(c, sql)), rowSet(await postgres(sql)), sql);
    }
    // C4, C6 (an aggregate's DISTINCT but count's), C7 and P6: no key can be placed, refused by name where Postgres answers
    for (const sql of ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY ROLLUP (b.x / 1) ORDER BY 1",
      "SELECT sum(DISTINCT b.x / 1) FROM bigdec b",
      "SELECT b.x / 1 FROM bigdec b INTERSECT SELECT b.x FROM bigdec b",
      "SELECT o.amount / 3 FROM orders o UNION SELECT 1.5 ORDER BY 1"]) {
      await postgres(sql);
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /numeric-quotient-equality/.test(e.detail ?? ""), sql);
    }
    // C9: IN a list of values equates the exact keys, as = does (issue 350); the decided difference
    // numeric-quotient-compare, as listed: = ANY of an array equates the doubles
    const keyed = "SELECT b.id FROM bigdec b WHERE b.x / 1 IN (1.00000000000000000001, 7) ORDER BY 1";
    assert.deepEqual((await answer(c, keyed)).rows, (await postgres(keyed)).rows);
    const listed = "SELECT b.id FROM bigdec b WHERE b.x / 1 = ANY (ARRAY[1.00000000000000000001]) ORDER BY 1";
    assert.deepEqual((await postgres(listed)).rows, [["1"]]);
    assert.deepEqual((await answer(c, listed)).rows, [["1"], ["2"]]);
  } finally { await c.end(); }
});

test("a numeric decided exactly carries its program wherever it is read, compared or printed (PR 207's third round)", async () => {
  const c = await client();
  try {
    for (const sql of [
      // F1 / F2: a subquery's or WITH query's quotient read outside it — grouped, filtered, partitioned, counted, joined
      "SELECT q, count(*) FROM (SELECT b.x / 1 AS q FROM bigdec b) s GROUP BY q ORDER BY 1",
      "WITH q AS (SELECT b.x / 1 AS q FROM bigdec b) SELECT q, count(*) FROM q GROUP BY q ORDER BY 1",
      "SELECT count(*) FROM (SELECT b.x / 1 AS q FROM bigdec b) s WHERE s.q = 1.00000000000000000001",
      "SELECT * FROM (SELECT b.id, b.x / 1 AS q FROM bigdec b) s WHERE s.q = 1.00000000000000000001",
      "SELECT s.q, count(*) OVER (PARTITION BY s.q) FROM (SELECT b.x / 1 AS q FROM bigdec b) s ORDER BY 1",
      "SELECT count(DISTINCT s.q) FROM (SELECT b.x / 1 AS q FROM bigdec b) s",
      "SELECT a.q FROM (SELECT b.x / 1 AS q FROM bigdec b) a JOIN (SELECT b.x / 1 AS q FROM bigdec b WHERE b.id = 1) c ON a.q = c.q",
      "SELECT s.q, count(*) FROM (SELECT o.amount / 3 AS q FROM orders o) s GROUP BY 1 ORDER BY 1",
      "SELECT DISTINCT s.third FROM (SELECT o.amount / 3 AS third FROM orders o) s GROUP BY s.third ORDER BY 1",
      "SELECT DISTINCT s.third FROM (SELECT o.amount / 3 AS third FROM orders o) s JOIN orders o2 ON true ORDER BY 1",
      "SELECT DISTINCT * FROM (SELECT o.amount / 3 AS third FROM orders o) s(t) ORDER BY 1",
      "SELECT DISTINCT t FROM (SELECT o.amount / 3 AS third FROM orders o) s(t) ORDER BY 1",
      "SELECT DISTINCT third FROM (SELECT o.amount / 3 AS third FROM orders o) ORDER BY 1",
      "SELECT max(s.q) FROM (SELECT b.x / 1 AS q FROM bigdec b) s",
      "SELECT s.q * 2, s.q::text FROM (SELECT b.x / 1 AS q FROM bigdec b) s ORDER BY 1",
      "SELECT s.t, count(*) FROM (SELECT (b.x / 1)::text AS t FROM bigdec b) s GROUP BY 1 ORDER BY 1",
      "SELECT g.q FROM (SELECT s.q FROM (SELECT b.x / 1 AS q FROM bigdec b) s GROUP BY s.q) g WHERE g.q = 1.00000000000000000002",
      // F3: a scalar subquery and a parameter on the other side of =
      "SELECT b.id FROM bigdec b WHERE b.x / 1 = (SELECT c.x / 1 FROM bigdec c WHERE c.id = 1) ORDER BY 1",
      "SELECT b.id FROM bigdec b WHERE b.x / 1 = (SELECT 1.00000000000000000001::numeric(30,20)) ORDER BY 1",
      // F4: a quotient's text or a cast of it, equated
      "SELECT (b.x / 1)::text AS t, count(*) FROM bigdec b GROUP BY 1 ORDER BY 1",
      "SELECT count(*) FROM bigdec b WHERE (b.x / 1)::text = '1.00000000000000000001'",
      "SELECT DISTINCT (b.x / 1)::text AS t FROM bigdec b ORDER BY 1",
      "SELECT count(*) FROM bigdec b WHERE (b.x / 1)::numeric(30,20) = 1.00000000000000000001",
      "SELECT DISTINCT (b.x / 1)::numeric(30,20) AS q FROM bigdec b ORDER BY 1",
      // F5: a UNION ALL whose arms are computed otherwise, each arm its own program
      "SELECT b.x FROM bigdec b UNION ALL SELECT b.x / 1 FROM bigdec b ORDER BY 1",
      "SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT 1.5 ORDER BY 1",
      "SELECT DISTINCT b.x / 1 AS q FROM bigdec b UNION ALL SELECT 1.5 ORDER BY 1",
      "SELECT o.amount / 3 AS q FROM orders o UNION ALL SELECT o.amount FROM orders o ORDER BY 1",
      "SELECT u.q, count(*) FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT b.x FROM bigdec b) u GROUP BY 1 ORDER BY 1"]) {
      assert.deepEqual(rowSet(await answer(c, sql)), rowSet(await postgres(sql)), sql);
    }
    // F3: a parameter, bare, cast to numeric, and to numeric(30,20)
    for (const sql of ["SELECT b.id FROM bigdec b WHERE b.x / 1 = $1 ORDER BY 1", "SELECT b.id FROM bigdec b WHERE b.x / 1 = $1::numeric ORDER BY 1",
      "SELECT b.id FROM bigdec b WHERE b.x / 1 = $1::numeric(30,20) ORDER BY 1"]) {
      const answered = await answer(c, sql, ["1.00000000000000000001"]);
      assert.deepEqual(answered, await postgres(sql, ["1.00000000000000000001"]), sql);
      assert.deepEqual(answered.rows, [["1"]], sql);
    }
    // F1: a subquery read by * beside its quotient's equality: the * is written out, and the quotient keyed (issue 252)
    for (const sql of ["SELECT *, 1 AS one FROM (SELECT b.x / 1 AS q FROM bigdec b) s WHERE s.q = 1.00000000000000000001"]) {
      assert.deepEqual(rowSet(await answer(c, sql)), rowSet(await postgres(sql)), sql);
    }
    // F1: no key can be placed (a grouping set): refused by name
    for (const sql of ["SELECT q, count(*) FROM (SELECT b.x / 1 AS q FROM bigdec b) s GROUP BY ROLLUP (q) ORDER BY 1"]) {
      await postgres(sql);
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /numeric-quotient-equality/.test(e.detail ?? ""), sql);
    }
    // F6: a row holding a quotient, compared or written: refused by name
    for (const sql of ["SELECT b.id FROM bigdec b WHERE (b.x / 1, b.y) = (1.00000000000000000001, 1) ORDER BY 1",
      "SELECT b.id FROM bigdec b WHERE (b.x / 1, b.y) IN ((1.00000000000000000001, 1)) ORDER BY 1",
      "SELECT DISTINCT (b.x / 1, b.y) AS r FROM bigdec b ORDER BY 1"]) {
      await postgres(sql);
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /row-value/.test(e.detail ?? ""), sql);
    }
    // an aggregate of the subquery's quotient outside it is summed from its program (issue 252: was the listed
    // nested-exact-numeric, the engine's sum of doubles)
    const summed = "SELECT sum(s.q) FROM (SELECT o.amount / 3 AS q FROM orders o) s";
    assert.deepEqual((await answer(c, summed)).rows, (await postgres(summed)).rows);
  } finally { await c.end(); }
});

// PR 207'S FOURTH ROUND, A CLASS ROUND: "is this value exact" was decided in several places that disagreed (a literal
// past the engine's 38 digits called exact where it is written as a double; a variance's cells called inexact where
// the rewrite's own integer casts hold them; a program skipped over a value written as a double; a carry decided for a
// FROM item whose `*` never exposed the cells). One decider now (`duckExact`, by how each value is WRITTEN for the
// engine), and each case below was a disagreement between two of the old places.
test("a numeric is exact exactly where what is sent computes it exactly, wherever that is asked (PR 207's fourth round)", async () => {
  const c = await client();
  const differ: string[] = [];
  try {
    for (const sql of [
      // D1: a text literal past 38 digits, cast to numeric: the engine's double, never compared as exact
      "SELECT r.id, r.n + '1e-39'::numeric = r.n AS eq FROM ratios r ORDER BY r.id",
      "SELECT count(DISTINCT x) FROM (SELECT r.a + '1e-39'::numeric AS x FROM ratios r UNION ALL SELECT r.a FROM ratios r) s",
      "SELECT r.id FROM ratios r WHERE r.n * '1.000000000000000000000000000000000000001'::numeric = r.n ORDER BY 1",
      "SELECT count(*) FROM (SELECT x FROM (SELECT r.a + '1e-39'::numeric AS x FROM ratios r UNION ALL SELECT r.a FROM ratios r) s GROUP BY x) g",
      "SELECT count(*) FROM (SELECT DISTINCT x FROM (SELECT r.a + '1e-39'::numeric AS x FROM ratios r UNION ALL SELECT r.a FROM ratios r) s) g",
      // D2: the same past 38 digits written as a numeric literal, with and without an exponent
      "SELECT r.id FROM ratios r WHERE r.n * 1.000000000000000000000000000000000000001 = r.n ORDER BY 1",
      "SELECT r.id, r.n + 1e-39 = r.n AS eq FROM ratios r ORDER BY r.id",
      // D3: a cast to numeric(p > 38, s), which is written as the engine's double
      "SELECT DISTINCT s.x FROM (SELECT b.x::numeric(40,20) AS x FROM bigdec b) s ORDER BY 1",
      "SELECT b.id FROM bigdec b WHERE b.x::numeric(40,20) = 1.00000000000000000001 ORDER BY 1",
      // D4: a program skipped because its value was called the engine's: printed, and its min
      "SELECT r.id, r.n + '1e-39'::numeric AS x FROM ratios r ORDER BY r.id",
      "SELECT r.id, r.n + 1e-39 AS x FROM ratios r ORDER BY r.id",
      "SELECT min(r.n + '1e-39'::numeric), max(r.a * 1.000000000000000000000000000000000000001) FROM ratios r",
      "SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT '1e-39'::numeric ORDER BY 1",
      // D5: a variance's cells are the rewrite's integer casts, exact: read beside another exact column of its FROM item
      "SELECT m.a, m.b FROM (SELECT var_pop(o.amount) AS a, avg(o.qty) AS b FROM orders o) m",
      "SELECT m.a, m.b FROM (SELECT var_pop(o.qty::bigint) AS a, var_pop(o.qty) AS b FROM orders o) m",
      "SELECT m.a FROM (SELECT var_pop(o.amount) AS a, avg(o.qty) AS b FROM orders o) m WHERE m.b = 8 / 3.0",
      // (a FROM item's column is the value it is, whether or not its program rides: a recursive WITH query's too)
      "WITH RECURSIVE r(n, v) AS (SELECT 1, 1.5 UNION ALL SELECT r.n + 1, r.v * 2 FROM r WHERE r.n < 3) SELECT x.id, r.v FROM r JOIN ratios x ON x.id = r.n WHERE r.v = 3.0 ORDER BY 1",
      "SELECT m.s, m.q FROM (SELECT sum(r.a) AS s, avg(r.a) AS q FROM ratios r) m WHERE m.s = 4.0",
      "WITH base AS (SELECT b.x / 1 AS q FROM bigdec b) SELECT * FROM base UNION ALL SELECT s.q FROM (SELECT * FROM base) s WHERE s.q = 1.00000000000000000001",
      "WITH base AS (SELECT b.x / 1 AS q FROM bigdec b) SELECT * FROM base UNION ALL SELECT b2.q FROM base b2 WHERE b2.q = 1.00000000000000000001",
      // D6: a function of a FROM item's quotient reads the quotient's program, never its double
      "SELECT sqrt(s.q) FROM (SELECT b.x / 3 AS q FROM bigdec b) s ORDER BY 1",
      // D7: a carry decided from what the FROM item exposes: a `*` of a WITH query, under a UNION ALL
      "SELECT * FROM (WITH base AS (SELECT round(100.0 * (r.n - r.id) / nullif(r.id, 0), 1) AS pct, r.id FROM ratios r) SELECT b.pct, b.id FROM (SELECT * FROM base) AS b) u1 ORDER BY 2, 1",
      "WITH base AS (SELECT round(100.0 * (r.n - r.id) / nullif(r.id, 0), 1) AS pct, r.id FROM ratios r) SELECT b.pct, b.id FROM (SELECT * FROM base) AS b UNION ALL SELECT r.n * 1.0, r.id FROM ratios r ORDER BY 2, 1",
      "SELECT * FROM (WITH base AS (SELECT round(100.0 * (r.n - r.id) / nullif(r.id, 0), 1) AS pct, r.id FROM ratios r) SELECT b.pct, b.id FROM (SELECT * FROM base) AS b) u1 UNION ALL SELECT * FROM (WITH base AS (SELECT round(100.0 * (r.n - r.id) / nullif(r.id, 0), 1) AS pct, r.id FROM ratios r) SELECT b.pct, b.id FROM (SELECT * FROM base) AS b) u2 ORDER BY 2, 1"]) {
      // (every case is asked, and every one that differs named, so a failure reads as the list of cases)
      const pg = rowSet(await postgres(sql));
      const mine = await answer(c, sql).then(rowSet, (e: Error) => e.message);
      if (JSON.stringify(mine) !== JSON.stringify(pg)) differ.push(`${sql}\n  Postgres: ${JSON.stringify(pg)}\n  Mason:    ${JSON.stringify(mine)}`);
    }
    assert.deepEqual(differ, []);
    // D8: a FROM item's quotient beside its `*`: the `*` is written out, so the cells ride and it is keyed (issue 252)
    for (const sql of ["SELECT count(*) FROM (SELECT *, b.x / 1 AS q FROM bigdec b) s WHERE s.q = 1.00000000000000000001",
      "SELECT s.q, count(*) FROM (SELECT b.id, b.x / 1 AS q, b.* FROM bigdec b) s GROUP BY 1 ORDER BY 1"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    // D8: a VALUES list's value written as a double, which no cell can ride: refused by name, never compared as the
    // double (it was called a table's exact column)
    for (const sql of ["SELECT count(DISTINCT v.x) FROM (VALUES (1 + '1e-39'::numeric), (1::numeric)) v(x) JOIN ratios r ON r.id = 1"]) {
      await postgres(sql);
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /numeric-quotient-equality/.test(e.detail ?? ""), sql);
    }
  } finally { await c.end(); }
});

// PR 207'S FIFTH ROUND: two places the one decider did not yet reach (a failure to apply the decision of the fourth
// round, not a new class): an empty list read as "every value exact" for a column nothing decided, and a product's
// widening writing a DECIMAL of its own; and a refusal's words that named what the statement did not hold.
test("unknown is never exact, one writer writes every numeric cast, and a refusal names what was written (PR 207's fifth round)", async () => {
  const c = await client();
  try {
    // the product's widening writes by the cast's one writer: a scale past 38 is no DECIMAL
    for (const sql of ["SELECT r.id, (1e-39)::numeric(45,40) * r.n FROM ratios r ORDER BY 1",
      "SELECT r.id, r.a * (1e-39)::numeric(45,40) FROM ratios r ORDER BY 1"]) {
      assert.deepEqual(await answer(c, sql).catch((e: Error) => e.message), await postgres(sql), sql);
    }
    // a column a `*` lists one FROM item deeper is the value it reads there, never "exact" for want of one: compared or
    // grouped, refused by name — in the words of what was written
    const refused = async (sql: string, words: RegExp[], not: RegExp[] = []): Promise<void> => {
      await postgres(sql);
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => {
        assert.equal(e.code, "0A000", sql);
        assert.match(e.detail ?? "", /numeric-quotient-equality/, sql);
        for (const w of words) assert.match(e.message, w, sql);
        for (const w of not) assert.doesNotMatch(e.message, w, sql);
        return true;
      }, sql);
    };
    // (a `*` beside other columns is written out as Postgres's expansion, so the quotient rides and is keyed: issue 252)
    for (const sql of ["SELECT count(*) FROM (SELECT s.*, 1 AS one FROM (SELECT b.x / 1 AS q FROM bigdec b) s) t WHERE t.q = 1.00000000000000000001",
      "SELECT t.q, count(*) FROM (SELECT s.*, 1 AS one FROM (SELECT b.x / 1 AS q FROM bigdec b) s) t GROUP BY 1 ORDER BY 1",
      "SELECT count(*) FROM (SELECT *, b.x / 1 AS q FROM bigdec b) s WHERE s.q = 1.00000000000000000001"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    void refused;
    // a VALUES list's constant past 38 digits: no quotient, no average and no `*` in the words
    for (const sql of ["SELECT count(*) FROM (VALUES ('1e-39'::numeric), (0)) v(x), ratios r WHERE r.id = 1 AND v.x = 0",
      "SELECT v.x, count(*) FROM (VALUES ('1e-39'::numeric), (0)) v(x), ratios r WHERE r.id = 1 GROUP BY v.x"]) {
      await refused(sql, [/more than 38 digits/, /VALUES list/], [/quotient/, /average/, /\*/]);
    }
  } finally { await c.end(); }
});

// PR 207'S SIXTH ROUND: the class "a hint whose way out was never exercised". round(x, n) is computed exactly, the
// way the quotient is, so it is refused the same way; a USING join reads the double; a DISTINCT over a subquery sums the
// double. Each refusal of numeric-quotient-equality is asked here, and then the way out its HINT names, which must
// answer as Postgres does. The same holds for each way out numeric-quotient-compare's doc names. A numeric's error sends
// Postgres's DETAIL apart from its message, on both the runtime's path and the engine function's path.
test("every way out a numeric refusal names answers as Postgres does; a numeric overflow's DETAIL is Postgres's, apart (PR 207's sixth round)", async () => {
  const c = await client();
  const K = "1.00000000000000000001";
  try {
    const cases: Array<[refused: string, hint: RegExp, wayOut: string]> = [
      // a FROM item's value compared outside it
      [`SELECT count(*) FROM (SELECT b.x / 1 AS q, b.id FROM bigdec b) s NATURAL JOIN ratios r WHERE s.q = ${K}`, /join it with ON/,
        `SELECT count(*) FROM (SELECT b.x / 1 AS q, b.id FROM bigdec b) s JOIN ratios r ON r.id = s.id WHERE s.q = ${K}`],
      [`SELECT s FROM (SELECT b.x / 1 AS q FROM bigdec b) s WHERE s.q = ${K}`, /not its whole row/,
        `SELECT s.q FROM (SELECT b.x / 1 AS q FROM bigdec b) s WHERE s.q = ${K}`],
      // (round(b.x / 1, 2) there is a value at a fixed scale, exact, and answered: PR 415, below)
      [`WITH RECURSIVE r(q, n) AS (SELECT b.x / 1, 1 FROM bigdec b UNION ALL SELECT r.q, r.n + 1 FROM r WHERE r.n < 2) SELECT count(*) FROM r WHERE r.q = ${K}`, /outside the recursive WITH query/,
        `WITH RECURSIVE r(x, n) AS (SELECT b.x, 1 FROM bigdec b UNION ALL SELECT r.x, r.n + 1 FROM r WHERE r.n < 2) SELECT count(*) FROM r WHERE r.x / 1 = ${K}`],
      ["SELECT count(*) FROM (VALUES ('1e-39'::numeric), (0)) v(x), ratios r WHERE r.id = 1 AND v.x = 0", /38 digits or fewer/,
        "SELECT count(*) FROM (VALUES ('1e-37'::numeric), (0)) v(x), ratios r WHERE r.id = 1 AND v.x = 0"],
      ["SELECT count(*) FROM (VALUES (1 / 3.0), (0)) v(x), ratios r WHERE r.id = 1 AND v.x = 0", /compute the value in the query that compares it/,
        "SELECT count(*) FROM (VALUES (1, 3.0), (0, 1)) v(a, b), ratios r WHERE r.id = 1 AND v.a / v.b = 0"],
      // (a UNION ALL of a quotient beside an integer carries the quotient exactly, PR 231: its DISTINCT is answered, in
      // "a set operation's SELECTs are the column Postgres resolved …")
      // a value compared where no exact key can be placed
      ["SELECT b.x / 1 AS q FROM bigdec b UNION SELECT 0 / 1.0", /SELECT DISTINCT over the UNION ALL/,
        "SELECT DISTINCT u.q FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT 0 / 1.0) u"],
      ["SELECT b.x / 1 AS q FROM bigdec b INTERSECT SELECT b.x / 1 FROM bigdec b WHERE b.id = 1", /by EXISTS/,
        "SELECT DISTINCT b.x / 1 AS q FROM bigdec b WHERE EXISTS (SELECT 1 FROM bigdec c WHERE c.id = 1 AND c.x / 1 = b.x / 1)"],
      ["SELECT b.x / 1 AS q FROM bigdec b EXCEPT SELECT b.x / 1 FROM bigdec b WHERE b.id = 1", /by NOT EXISTS/,
        "SELECT DISTINCT b.x / 1 AS q FROM bigdec b WHERE NOT EXISTS (SELECT 1 FROM bigdec c WHERE c.id = 1 AND c.x / 1 = b.x / 1)"],
      ["SELECT b.x / 1 AS q FROM bigdec b INTERSECT ALL SELECT b.x / 1 FROM bigdec b WHERE b.id = 1", /count each value in each query/,
        "SELECT a.q, least(a.n, z.n) AS n FROM (SELECT b.x / 1 AS q, count(*) AS n FROM bigdec b GROUP BY 1) a JOIN (SELECT b.x / 1 AS q, count(*) AS n FROM bigdec b WHERE b.id = 1 GROUP BY 1) z ON z.q = a.q"],
      ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY ROLLUP (1)", /a GROUP BY for each grouping set/,
        "SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY 1 UNION ALL SELECT NULL, count(*) FROM bigdec b"],
      ["SELECT sum(DISTINCT b.x / 1) FROM bigdec b", /count\(DISTINCT …\) of it is answered/, "SELECT count(DISTINCT b.x / 1) FROM bigdec b"],
      ["SELECT DISTINCT * FROM (SELECT b.x / 1 AS q, b.id AS k, b.y AS k FROM bigdec b) s", /name the columns/,
        "SELECT DISTINCT s.q, s.k FROM (SELECT b.x / 1 AS q, b.id AS k, b.y AS k2 FROM bigdec b) s"]];
    const differ: string[] = [];
    for (const [sql, hint, way] of cases) {
      await postgres(sql);
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => {
        assert.equal(e.code, "0A000", sql);
        assert.match(e.detail ?? "", /numeric-quotient-equality/, sql);
        assert.match(e.hint ?? "", hint, sql);
        assert.doesNotMatch(e.hint ?? "", /round\(|USING/, sql);
        return true;
      }, sql);
      const pg = rowSet(await postgres(way));
      const mine = await answer(c, way).then(rowSet, (e: Error) => e.message);
      if (JSON.stringify(mine) !== JSON.stringify(pg)) differ.push(`${way}\n  Postgres: ${JSON.stringify(pg)}\n  Mason:    ${JSON.stringify(mine)}`);
    }
    // numeric-quotient-compare's ways out (docs/SQL-SUPPORT.md): each answered as Postgres answers it
    for (const way of [`SELECT count(*) FROM bigdec b WHERE b.x / 1 = ${K} OR b.x / 1 = 5`,
      `SELECT count(*) FROM (SELECT b.x / 1 AS q FROM bigdec b) t WHERE t.q = ${K} OR t.q = 5`,
      `SELECT count(*) FROM bigdec b WHERE (b.x / 1 = ${K}) IS NOT TRUE`,
      `SELECT b.id, CASE WHEN b.x / 1 = ${K} THEN 'y' ELSE 'n' END FROM bigdec b`]) {
      const pg = rowSet(await postgres(way));
      const mine = await answer(c, way).then(rowSet, (e: Error) => e.message);
      if (JSON.stringify(mine) !== JSON.stringify(pg)) differ.push(`${way}\n  Postgres: ${JSON.stringify(pg)}\n  Mason:    ${JSON.stringify(mine)}`);
    }
    assert.deepEqual(differ, []);
    // a numeric field overflow: Postgres's message and its DETAIL, apart, whichever path raised it
    for (const sql of ["SELECT r.id, r.a::numeric(3,5) FROM ratios r WHERE r.id = 1",
      "SELECT r.id, (r.a / 3)::numeric(3,5) FROM ratios r WHERE r.id = 1",
      "SELECT count(*) FROM (SELECT (r.a / 3)::numeric(3,5) AS v FROM ratios r) s WHERE s.v = 1"]) {
      const want = await postgres(sql).then(() => null, (e: { code?: string; message: string; detail?: string }) => e);
      assert.ok(want !== null, sql);
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => {
        assert.deepEqual({ code: e.code, message: e.message, detail: e.detail }, { code: want.code, message: want.message, detail: want.detail }, sql);
        return true;
      }, sql);
    }
  } finally { await c.end(); }
});

test("a top N over joined tables chooses its rows by row number and reads the columns for those alone", async () => {
  const c = await client();
  // this file's copy holds a jsonb as DuckDB wrote it, where a real copy holds Postgres's text: one spelling for the comparison
  const held = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => r.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : v)) });
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  try {
    const answered = ["SELECT l.*, c.* FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.id DESC LIMIT 4",
      "SELECT * FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.k, l.id LIMIT 3 OFFSET 2",
      "SELECT l.id AS key, *, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c + 1000 ORDER BY l.id LIMIT 2",
      "SELECT l.j, c.name FROM late_c c LEFT JOIN late l ON l.c = c.id AND l.id < 3 ORDER BY c.id, l.id NULLS FIRST LIMIT 5",
      "SELECT x.id, y.id, y.j FROM late x JOIN late y ON y.id = x.id + 1 ORDER BY x.id DESC LIMIT 2",
      "SELECT l.id, c.name FROM late l, late_c c WHERE c.id = l.c ORDER BY l.id DESC LIMIT 2 OFFSET 100000",
      // a column number or a bare name beside a *: the column it resolves to (issue 112), so the fast plan takes it
      "SELECT l.*, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY 3, 1 LIMIT 3",
      "SELECT l.*, c.* FROM late l JOIN late_c c ON c.id = l.c ORDER BY 3 DESC, 1 LIMIT 3",
      "SELECT *, l.id FROM late l JOIN late_c c ON c.id = l.c ORDER BY 1 DESC LIMIT 3",
      "SELECT *, l.k AS last FROM late l JOIN late_c c ON c.id = l.c ORDER BY 7, 1 LIMIT 3",
      "SELECT l.*, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY name DESC, k LIMIT 3"];
    for (const sql of answered) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
      assert.match(await sent(sql), /(rowid|__mason_rid) AS __mason_r1.*\) AS __mason_late LEFT JOIN .* ON .*\.rowid = __mason_late\.__mason_r1/, sql);
    }
    // only the tables the list reads are read again
    const one = await sent("SELECT l.j FROM late l JOIN late_c c ON c.id = l.c ORDER BY c.name, l.id LIMIT 2");
    assert.match(one, /l\.rowid AS __mason_r1,/);
    assert.doesNotMatch(one, /__mason_r2|c\.rowid/);
    // the shapes that stay as they were: a row number exists of a table alone, and a whole row is not listed
    for (const sql of ['SELECT r.id, r."RowId", l.id FROM rowid_cased r JOIN late l ON l.id = r.id ORDER BY r.id DESC LIMIT 2',
      "SELECT l.id FROM late l ORDER BY l.id LIMIT 2",
      "SELECT DISTINCT l.c, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY 1 LIMIT 2",
      "SELECT l.c, count(*) FROM late l JOIN late_c c ON c.id = l.c GROUP BY 1 ORDER BY 1 LIMIT 2",
      "SELECT l.id, row_number() OVER (ORDER BY l.id) FROM late l JOIN late_c c ON c.id = l.c ORDER BY 1 LIMIT 2"]) {
      assert.doesNotMatch(await sent(sql), /__mason_r1/, sql);
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
    }
    // TIES: l.c repeats. Which tied rows are kept is defined by no one, but they are rows of the top keys, whole
    const tied = "SELECT l.c, l.id, l.j, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.c LIMIT 60";
    const rows = (await answer(c, tied)).rows as string[][];
    assert.deepEqual(rows.map((r) => r[0]), [...Array(40).fill("0"), ...Array(20).fill("1")], "the keys in order");
    for (const r of rows) assert.equal(r[3], `c${r[0]}`, "each row whole");
    assert.equal(new Set(rows.map((r) => r[1])).size, 60, "no row twice");
    // a prepared statement run after a SET reads the setting where it runs
    await c.query({ name: "top", text: "SELECT l.id, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT $1", values: [2] });
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual((await c.query({ name: "top", text: "SELECT l.id, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT $1", values: [1], rowMode: "array" })).rows, [[1, "c1"]]);
  } finally { await c.end(); }
});

// ISSUE 134, STEP 2: EVERY FROM ITEM OF A JOIN IS A TABLE, A PLAIN DERIVED READ OR CARRIED (src/duck/late.ts). A view, a WITH
// query, a tool's wrapper and a derived side read their rows by row number too, and what has no row number passes through
test("a join's FROM items: a plain derived read is fetched by its row number, a wrapper folded into its join, anything else carried", async () => {
  const c = await client();
  const held = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => r.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : v)) });
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  /** each statement equal to Postgres's, in the form `form` says */
  const each = async (form: RegExp, sqls: string[], not?: RegExp): Promise<void> => {
    for (const sql of sqls) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
      const line = await sent(sql);
      assert.match(line, form, sql);
      if (not !== undefined) assert.doesNotMatch(line, not, sql);
    }
  };
  const FETCHED = /__mason_rid AS __mason_r\d.*\) AS __mason_late LEFT JOIN .*__mason_rid = __mason_late\.__mason_r\d/;
  const ROWS = /(rowid|__mason_rid) AS __mason_r1.*\) AS __mason_late LEFT JOIN /;
  const CARRIED = /AS __mason_c\d.*\) AS __mason_late LEFT JOIN /;
  try {
    // PLAIN DERIVED READS: each join kind, each spelling of one, the WHERE inside alone
    await each(FETCHED, [
      "SELECT l.id, d.name FROM late l JOIN (SELECT * FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT 2",
      "SELECT l.id, d.name, d.one, d.twice FROM late l LEFT JOIN (SELECT id + 1000 AS id, name, 1 AS one, id * 2 AS twice FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, d.name, d.one FROM late l LEFT JOIN (SELECT id, name, 1 AS one FROM late_c WHERE id > 1) d ON d.id = l.c ORDER BY l.id LIMIT 4",
      "SELECT d.id, d.one, l.id AS l FROM (SELECT id, 1 AS one FROM late_c WHERE id > 47) d RIGHT JOIN late l ON l.id = d.id ORDER BY l.id DESC LIMIT 3",
      "SELECT l.id, d.key, d.up FROM late l RIGHT JOIN (SELECT id + 1995 AS key, upper(name) AS up FROM late_c) d ON d.key = l.id ORDER BY d.key DESC LIMIT 3",
      "SELECT l.id, d.up, d.one FROM late l FULL JOIN (SELECT id + 1995 AS key, upper(name) AS up, 1 AS one FROM late_c) d ON d.key = l.id ORDER BY l.id NULLS FIRST, d.up LIMIT 44 OFFSET 40",
      "SELECT l.id, d.name FROM late l, (SELECT id, name FROM late_c WHERE id < 3) d WHERE d.id = l.c ORDER BY l.id LIMIT 2 OFFSET 1",
      "SELECT d.x, d.y, l.id FROM late l JOIN (SELECT id, name FROM late_c) AS d(x, y) ON d.x = l.c ORDER BY l.id LIMIT 2",
      "SELECT d.a, l.id FROM (SELECT id, c AS a FROM late) d JOIN late l ON l.id = d.id + 1 ORDER BY l.id LIMIT 2",
      "SELECT x.name, y.name AS other FROM (SELECT id, name FROM late_c) x JOIN (SELECT id, name FROM late_c) y ON y.id = x.id + 1 ORDER BY x.id LIMIT 2",
      "SELECT l.id, r.name, r.one, r.twice FROM late l LEFT JOIN late_read r ON r.id = l.c ORDER BY l.id DESC LIMIT 3",
      "SELECT l.id, r.name, r.one FROM late l LEFT JOIN late_read_again r ON r.id = l.c ORDER BY l.id LIMIT 4",
      "WITH w AS (SELECT id, name, 1 AS one FROM late_c WHERE id > 1) SELECT l.id, w.name, w.one FROM late l LEFT JOIN w ON w.id = l.c ORDER BY l.id LIMIT 3",
      "WITH w(key, label) AS (SELECT id, name FROM late_c) SELECT l.id, x.label FROM late l JOIN w AS x ON x.key = l.c ORDER BY l.id LIMIT 3",
      "WITH v AS (SELECT id, name FROM late_c), w AS (SELECT * FROM v WHERE id > 1) SELECT l.id, w.name FROM late l JOIN w ON w.id = l.c ORDER BY l.id LIMIT 2",
      // a sort or a WHERE reads the derived side's own expression, and a bare name finds its owner
      "SELECT l.id, d.twice FROM late l JOIN (SELECT id, id * 2 AS twice FROM late_c) d ON d.id = l.c WHERE d.twice > 2 ORDER BY d.twice DESC, l.id LIMIT 3",
      "SELECT l.id, label FROM late l JOIN (SELECT id AS key, name AS label FROM late_c) d ON d.key = l.c ORDER BY l.id LIMIT 3",
      "SELECT * FROM late_c a JOIN (SELECT id AS key, upper(name) AS up FROM late_c) d ON d.key = a.id + 1 ORDER BY a.id LIMIT 2",
    ]);
    // A SIDE THE LIST DOES NOT READ IS NOT READ AGAIN
    assert.doesNotMatch(await sent("SELECT l.id FROM late l JOIN (SELECT id FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT 2"), /__mason_rid/);
    // WRAPPERS FOLD: a view of a join, of a view, a WITH query, a tool's own, a `*` of columns of one name, its keys read as what they are
    await each(ROWS, [
      "SELECT * FROM late_joined ORDER BY id DESC LIMIT 3",
      "SELECT name, k FROM late_joined WHERE k > 1 ORDER BY k LIMIT 3 OFFSET 1",
      "SELECT id, shout FROM late_joined_again ORDER BY id LIMIT 2",
      "SELECT * FROM (SELECT * FROM late_joined WHERE id > 3) s WHERE s.k > 1 ORDER BY s.id LIMIT 2",
      "WITH j AS (SELECT l.id, l.j, c.name FROM late l JOIN late_c c ON c.id = l.c) SELECT * FROM j ORDER BY id LIMIT 2",
      "WITH j AS (SELECT l.id, c.name FROM late l JOIN late_c c ON c.id = l.c), k AS (SELECT * FROM j) SELECT id, upper(name) FROM k ORDER BY id LIMIT 2",
      "SELECT * FROM (SELECT l.id, l.j, c.id AS key, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c WHERE l.id > 1) t ORDER BY id LIMIT 3",
      "SELECT t.id, t.up FROM (SELECT l.id, upper(c.name) AS up FROM late l JOIN late_c c ON c.id = l.c) AS t ORDER BY t.up DESC, t.id LIMIT 3",
      "SELECT t.x FROM (SELECT l.id, c.name FROM late l JOIN late_c c ON c.id = l.c) AS t(x, y) ORDER BY t.x LIMIT 2",
      "SELECT * FROM (SELECT l.id, l.c, d.id AS d, d.one FROM late l LEFT JOIN (SELECT id, 1 AS one FROM late_c WHERE id > 1) d ON d.id = l.c) t ORDER BY id LIMIT 3",
      "SELECT id FROM (SELECT l.id, l.c AS id2, c.name FROM late l JOIN late_c c ON c.id = l.c) t ORDER BY id2, id LIMIT 3",
    ]);
    // the wrapper's output name before its input column: `ORDER BY name` is the output, and this wrapper's column is another
    await each(ROWS, ["SELECT id AS name FROM (SELECT l.id, c.name FROM late l JOIN late_c c ON c.id = l.c) t ORDER BY name DESC LIMIT 2"]);
    // two columns of one name, read by a `*` alone, in their places
    await each(ROWS, ["SELECT * FROM (SELECT l.k, l.id, c.id, c.name FROM late l JOIN late_c c ON c.id = l.c) t ORDER BY k LIMIT 2"]);
    // CARRIED: what has no row number passes through, a nullable side's NULLs with it
    await each(CARRIED, [
      "SELECT l.id, l.j, s.n FROM late l JOIN (SELECT c, count(*) AS n FROM late GROUP BY c) s ON s.c = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, l.j, s.n, s.one FROM late l LEFT JOIN (SELECT c, count(*) AS n, 1 AS one FROM late WHERE c > 1 GROUP BY c) s ON s.c = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, s.n FROM late l LEFT JOIN late_counts s ON s.c = l.c + 40 ORDER BY l.id LIMIT 12",
      "WITH s AS (SELECT c, count(*) AS n FROM late GROUP BY c) SELECT l.id, s.n FROM late l JOIN s ON s.c = l.c ORDER BY l.id LIMIT 3",
      "WITH m AS MATERIALIZED (SELECT id, name FROM late_c) SELECT l.id, m.name FROM late l JOIN m ON m.id = l.c ORDER BY l.id LIMIT 3",
      "WITH t AS (SELECT id, name FROM late_c) SELECT l.id, x.name, y.name AS other FROM late l JOIN t x ON x.id = l.c JOIN t y ON y.id = l.c + 1 ORDER BY l.id LIMIT 3",
      "SELECT l.id, d.name FROM late l JOIN (SELECT id, name FROM late_c ORDER BY id LIMIT 5) d ON d.id = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, d.name FROM late l JOIN (SELECT DISTINCT id, name FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, d.rn FROM late l JOIN (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, d.name FROM late l JOIN (SELECT id, name FROM late_c UNION ALL SELECT id + 100, name FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, d.name FROM late l JOIN (SELECT c.id, c.name FROM late_c c JOIN late_p p ON p.c = c.id AND p.line = 0) d ON d.id = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, d.n FROM late l, LATERAL (SELECT count(*) AS n FROM late_c c WHERE c.id = l.c) d ORDER BY l.id LIMIT 3",
      "SELECT l.id, d.name FROM late l, LATERAL (SELECT name FROM late_c c WHERE c.id = l.c) d ORDER BY l.id LIMIT 3",
    // (a preserved table limited first exposes its own row number inside; a carried item is fetched by none)
    ], /__mason_rid = __mason_late/);
    // a volatile derived read stays one value: its column carried, never read again
    const random = await sent("SELECT l.id, d.r FROM late l JOIN (SELECT id, random() AS r FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT 3");
    assert.match(random, CARRIED);
    assert.doesNotMatch(random, /__mason_rid/);
    assert.doesNotMatch(await sent("SELECT l.id, d.name FROM late l JOIN (SELECT id, name FROM late_c WHERE random() < 2) d ON d.id = l.c ORDER BY l.id LIMIT 3"), /__mason_rid/);
    assert.doesNotMatch(await sent("SELECT * FROM (SELECT l.id, random() AS r FROM late l JOIN late_c c ON c.id = l.c) t ORDER BY id LIMIT 3"), /__mason_r1/);
    // a derived read's whole row is the rewrite's text of its columns, read as any other list
    await each(FETCHED, ["SELECT l.id, d FROM late l JOIN (SELECT id, 1 AS one FROM late_c WHERE id > 1) d ON d.id = l.c ORDER BY l.id LIMIT 4"]);
    // STAYS AS IT WAS: one item of nothing to fold, a grouped view by its output name, a function, a wrapper's sort inside
    for (const sql of ["SELECT * FROM late_counts ORDER BY n DESC, c LIMIT 2",
      "SELECT c, n AS total FROM late_counts ORDER BY total, c LIMIT 2",
      "SELECT * FROM (SELECT * FROM late_c WHERE id > 1) t ORDER BY id LIMIT 2",
      "SELECT * FROM (SELECT l.id, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id DESC) t LIMIT 2",
      "SELECT count(*) FROM (SELECT l.id FROM late l JOIN late_c c ON c.id = l.c) t LIMIT 2",
      "SELECT l.id, x FROM late l JOIN unnest(ARRAY[1, 2]) x ON x = l.id ORDER BY l.id LIMIT 2"]) {
      assert.doesNotMatch(await sent(sql), /__mason_r(id|\d)/, sql);
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
    }
    // NO ORDER BY, NO SORT (issue 824): a plain read's key through a view, a WITH query and a wrapper, a key computed, a
    // multiplying side, what is carried
    for (const sql of ["SELECT l.id, d.name FROM late l JOIN (SELECT id, name FROM late_c) d ON d.id = l.c LIMIT 3",
      "SELECT l.id, r.name FROM late l JOIN late_read r ON r.id = l.c LIMIT 3",
      "WITH w AS (SELECT id, name FROM late_c) SELECT l.id, w.name FROM late l LEFT JOIN w ON w.id = l.c LIMIT 3",
      "SELECT * FROM (SELECT l.id, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c) t LIMIT 3",
      "SELECT * FROM late_joined LIMIT 3",
      "SELECT l.id, d.name FROM late l JOIN (SELECT id + 1 AS id, name FROM late_c) d ON d.id = l.c LIMIT 3",
      "SELECT x.id, y.c FROM (SELECT id, c FROM late) x JOIN (SELECT id, c FROM late) y ON y.c = x.c LIMIT 3",
      "SELECT * FROM (SELECT x.id, y.j FROM late x JOIN late y ON y.c = x.c) t LIMIT 3",
      "SELECT l.id, s.n FROM late l JOIN late_counts s ON s.c = l.c LIMIT 3"]) {
      assert.match(await sent(sql), /AS __mason_r1(?!.* ORDER BY ).*\) AS __mason_late LEFT JOIN /, sql);
      assert.equal((await answer(c, sql)).rows.length, 3, sql);
    }
    // THE DECIDED DIFFERENCE, WIDER (gap limit-errors): a derived list's value computed for the rows chosen. Row 2000 is the one 'x'
    for (const sql of ["SELECT c.id, d.id AS d, d.n FROM late_c c JOIN (SELECT id, k, c, (j ->> 'n')::int AS n FROM late) d ON d.c = c.id ORDER BY d.k DESC LIMIT 3",
      "SELECT * FROM (SELECT l.id, (l.j ->> 'n')::int AS n, l.k, c.name FROM late l JOIN late_c c ON c.id = l.c) t ORDER BY t.k DESC LIMIT 3"]) {
      await assert.rejects(postgres(sql), /invalid input syntax for type integer: "x"/, sql);
      assert.equal((await answer(c, sql)).rows.length, 3, sql);
    }
    // the bad row chosen: both raise
    await assert.rejects(c.query("SELECT c.id, d.id AS d, d.n FROM late_c c JOIN (SELECT id, k, c, (j ->> 'n')::int AS n FROM late) d ON d.c = c.id ORDER BY d.k LIMIT 3"), (e: pg.DatabaseError) => e.code === "22P02");
    // a parameter in a derived list is one value, in both reads of it
    assert.deepEqual((await c.query({ text: "SELECT l.id, d.p, d.name FROM late l LEFT JOIN (SELECT id, $1::int AS p, name FROM late_c WHERE id > $2) d ON d.id = l.c ORDER BY l.id LIMIT 3", values: [7, 1], rowMode: "array" })).rows,
      (await postgres("SELECT l.id, d.p, d.name FROM late l LEFT JOIN (SELECT id, $1::int AS p, name FROM late_c WHERE id > $2) d ON d.id = l.c ORDER BY l.id LIMIT 3", [7, 1])).rows.map((r) => [Number(r[0]), r[1] === null ? null : Number(r[1]), r[2]]));
    // what is carried has no row number: a keyed WITH query read twice goes unsorted, as every LIMIT with no ORDER BY does
    assert.doesNotMatch(await sent("WITH t AS (SELECT id, name FROM late_c) SELECT l.id, x.name, y.name AS other FROM late l JOIN t x ON x.id = l.c JOIN t y ON y.id = l.c LIMIT 3"), /ORDER BY/);
    // a prepared statement run after a SET reads the setting where it runs
    const prepared = { name: "derived", text: "SELECT l.id, d.name FROM late l JOIN (SELECT id, name FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT $1" };
    await c.query({ ...prepared, values: [2] });
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual((await c.query({ ...prepared, values: [1], rowMode: "array" })).rows, [[1, "c1"]]);
  } finally { await c.end(); }
});

// ISSUE 824, PART 2: a LIMIT with an ORDER BY over a LEFT JOIN whose keys and WHERE read the preserved side alone limits
// that side to its first OFFSET + LIMIT rows before the join (src/duck/late.ts preservedFirst); everything else stays
test("the preserved side of an outer join is limited first where its keys and WHERE are all the sort reads", async () => {
  const c = await client();
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  // the preserved item limited inside, by name, to N rows
  const first = (alias: string, n: number): RegExp => new RegExp(`\\( SELECT \\*.* LIMIT ${n} \\) AS ${alias} (LEFT JOIN|RIGHT JOIN|ON) `);
  const LIMITED = /\( SELECT \*.* LIMIT \d+ \) AS (?!__mason_)\w+ (LEFT JOIN|RIGHT JOIN|ON) /;
  // (this file's truth writes a jsonb's text with a space after each colon)
  const held = (r: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...r, rows: r.rows.map((x) => x.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : v)) });
  try {
    // a join that repeats every row of c forty times, c's columns alone listed (rows of equal keys are alike), and a
    // join of one row at most, every column: each order total, so Postgres's rows are the answer
    for (const [sql, alias, n] of [
      ["SELECT c.id, c.name FROM late_c c LEFT JOIN late l ON l.c = c.id ORDER BY c.name DESC, c.id LIMIT 7 OFFSET 30", "c", 37],
      ["SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id AND l.id < 100 ORDER BY c.id DESC LIMIT 5 OFFSET 3", "c", 8],
      ["SELECT c.id, c.name FROM late_c c LEFT JOIN late l ON l.c = c.id LEFT JOIN late_p p ON p.c = l.c WHERE c.id % 3 = 1 ORDER BY c.id LIMIT 9", "c", 9],
      ["SELECT l.id, l.k, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY l.k, l.id LIMIT 4 OFFSET 2", "l", 6],
      ["SELECT l.*, c.* FROM late l LEFT JOIN late_c c ON c.id = l.c + 40 ORDER BY l.c DESC NULLS LAST, l.id DESC LIMIT 6", "l", 6],
      ["SELECT c.name, l.id FROM late_c c RIGHT JOIN late l ON c.id = l.c ORDER BY l.k DESC, l.id LIMIT 3", "l", 3],
      ["SELECT d.id, d.name, l.k FROM (SELECT id, name FROM late_c WHERE id > 5) d LEFT JOIN late l ON l.id = d.id ORDER BY d.name, d.id LIMIT 4", "d", 4],
      ["SELECT r.id, r.twice, l.k FROM late_read r LEFT JOIN late l ON l.id = r.id ORDER BY r.twice DESC, r.id LIMIT 3 OFFSET 1", "r", 4],
      ["WITH w AS (SELECT id, name FROM late_c) SELECT w.id, w.name, l.k FROM w LEFT JOIN late l ON l.id = w.id ORDER BY w.name DESC, w.id LIMIT 3", "w", 3],
      ["SELECT s.c, s.n, x.name FROM late_counts s LEFT JOIN late_c x ON x.id = s.c ORDER BY s.n, s.c DESC LIMIT 4", "s", 4],
      ["SELECT * FROM (SELECT l.id, l.k, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c) t ORDER BY t.k, t.id LIMIT 3", "l", 3],
      // a tool's spelling: a schema's name on the table and every column it reads, read by the table's name inside
      ['SELECT "public"."late"."id" AS "id", "public"."late"."k" AS "k", "C"."name" AS "C__name" FROM "public"."late" LEFT JOIN "public"."late_c" "C" ON "public"."late"."c" = "C"."id" WHERE "public"."late"."id" > 3 ORDER BY "public"."late"."k" DESC, "public"."late"."id" ASC LIMIT 4', "late", 4],
      // a computed key by its name and by its number, a bare name only the preserved side holds
      ["SELECT l.id, l.k % 7 AS m, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY m DESC, 1 LIMIT 5", "l", 5],
      ["SELECT l.id, j, c.name FROM late l LEFT JOIN late_c c ON c.id = l.c ORDER BY k, l.id LIMIT 2", "l", 2],
    ] as Array<[string, string, number]>) {
      assert.match(await sent(sql), first(alias, n), sql);
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
    }
    // LIMIT 0 and past the end of the preserved side
    for (const sql of ["SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id ORDER BY c.id LIMIT 0",
      "SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id ORDER BY c.id DESC LIMIT 3 OFFSET 2000",
      "SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id AND l.id < 60 ORDER BY c.id LIMIT 100"]) {
      assert.match(await sent(sql), LIMITED, sql);
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    // WHERE IT DOES NOT APPLY: an inner, a FULL or a comma join, a key or a WHERE reading the other side or a merged column,
    // a volatile WHERE, a DISTINCT ON, a LIMIT that is a parameter
    for (const sql of ["SELECT c.id FROM late_c c JOIN late l ON l.c = c.id ORDER BY c.id LIMIT 5",
      "SELECT c.id FROM late_c c FULL JOIN late l ON l.c = c.id ORDER BY c.id LIMIT 5",
      "SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id JOIN late_p p ON p.c = c.id ORDER BY c.id LIMIT 5",
      "SELECT c.id, l.id FROM late_c c LEFT JOIN late l ON l.c = c.id ORDER BY l.k, c.id LIMIT 5",
      "SELECT c.id, l.id FROM late_c c LEFT JOIN late l ON l.c = c.id ORDER BY c.id, l.id NULLS FIRST LIMIT 5",
      "SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id WHERE l.k > 10 ORDER BY c.id LIMIT 5",
      "SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id WHERE l.id IS NULL OR c.id > 3 ORDER BY c.id LIMIT 5",
      "SELECT id, l.k FROM late_c c LEFT JOIN late l USING (id) ORDER BY id LIMIT 5",
      "SELECT DISTINCT ON (c.id) c.id, l.id FROM late_c c LEFT JOIN late l ON l.c = c.id ORDER BY c.id, l.id LIMIT 5"]) {
      assert.match(await sent(sql), /__mason_r1/, sql);
      assert.doesNotMatch(await sent(sql), LIMITED, sql);
    }
    assert.doesNotMatch(await sent("SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id WHERE random() < 2 ORDER BY c.id LIMIT 5"), LIMITED);
    logged.length = 0;
    await c.query({ text: "SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id ORDER BY c.id LIMIT $1", values: [5] });
    assert.doesNotMatch(logged.findLast((l) => l.startsWith("statement: ")) ?? "", LIMITED);
    // no ORDER BY keeps its own path, unsorted (part 1)
    assert.doesNotMatch(await sent("SELECT c.id FROM late_c c LEFT JOIN late l ON l.c = c.id LIMIT 5"), LIMITED);
  } finally { await c.end(); }
});

// ISSUE 134, STEP 5: a subquery in the select list runs for the rows the limit chose, after they are chosen on keys alone;
// one anywhere else (a WHERE, a join, a sort key) keeps the statement as it was
test("a subquery in the select list is computed for the chosen rows alone, and one anywhere else keeps the statement as it was", async () => {
  const c = await client();
  // (this file's truth parses an int4[]: written back as its text)
  const held = (a: { fields: Array<[string, number]>; rows: unknown[][] }): unknown => ({ ...a, rows: a.rows.map((r) => r.map((v) => typeof v === "string" ? v.replaceAll('": ', '":') : Array.isArray(v) ? `{${v.join(",")}}` : v)) });
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  // the subquery stands in the outer list, over the fetch, never inside the rows' choice
  const AFTER = /\) AS __mason_late LEFT JOIN .*__mason_late\.__mason_r1/;
  try {
    for (const sql of [
      // correlated to the wide table and to the narrow one, a scalar, an EXISTS, an ARRAY, an IN
      "SELECT l.id, l.j, (SELECT count(*) FROM late_p p WHERE p.c = l.c) AS n FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.k, l.id LIMIT 4",
      "SELECT l.id, (SELECT max(p.note) FROM late_p p WHERE p.c = c.id) AS top FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id DESC LIMIT 3",
      "SELECT l.id, EXISTS (SELECT 1 FROM late_p p WHERE p.c = l.c AND p.line = 3) AS e FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 5",
      "SELECT l.id, ARRAY(SELECT p.line FROM late_p p WHERE p.c = l.c ORDER BY p.line) AS lines FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 3",
      "SELECT l.id, l.c IN (SELECT p.c FROM late_p p WHERE p.line = 3) AS hit, c.name FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 3",
      // on the nullable side of a LEFT and a FULL join: NULL where nothing matched
      "SELECT c.id, (SELECT count(*) FROM late_p p WHERE p.c = l.c) AS n, l.id AS l FROM late_c c LEFT JOIN late l ON l.c = c.id AND l.id < 3 ORDER BY c.id, l.id NULLS FIRST LIMIT 5",
      "SELECT c.id, (SELECT min(p.note) FROM late_p p WHERE p.c = l.c) AS n FROM late_c c FULL JOIN late l ON l.c = c.id + 1000 ORDER BY c.id NULLS LAST, l.id LIMIT 4",
      // beside a computed key by name and by ordinal, and a plain derived side the subquery reads
      "SELECT l.id * 2 AS x, (SELECT count(*) FROM late_p p WHERE p.c = l.c) AS n FROM late l JOIN late_c c ON c.id = l.c ORDER BY x DESC LIMIT 3",
      "SELECT l.id * 2 AS x, (SELECT count(*) FROM late_p p WHERE p.c = l.c) AS n FROM late l JOIN late_c c ON c.id = l.c ORDER BY 1 LIMIT 3",
      "SELECT l.id, (SELECT count(*) FROM late_p p WHERE p.c = d.id) AS n FROM late l JOIN (SELECT id, name FROM late_c) d ON d.id = l.c ORDER BY l.id LIMIT 3",
      // a merged column of an inner join is its left side's, as Postgres's analysis reads it
      "SELECT id, (SELECT count(*) FROM late_p p WHERE p.c = id) AS n FROM late_c x JOIN late_n y USING (id) ORDER BY id LIMIT 3",
      // one table alone
      "SELECT l.id, l.j, (SELECT count(*) FROM late_p p WHERE p.c = l.c) AS n FROM late l ORDER BY l.k LIMIT 3",
    ]) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
      assert.match(await sent(sql), AFTER, sql);
    }
    // a subquery that would raise on a row the limit leaves out: Postgres's sort computes it for every row, Mason for
    // the rows chosen (limit-errors)
    assert.deepEqual((await answer(c, "SELECT l.id, (SELECT 1 / (p.line - 3) FROM late_p p WHERE p.c = 0 AND p.line = 3 AND l.id = 2000) AS x FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.k DESC LIMIT 2")).rows, [["1", null], ["2", null]]);
    // what stays as it was: a subquery in a WHERE, in a join's condition, a sort key, a subquery read by name as a key,
    // one that reads a FULL join's merged column, a wrapper folded away, and one that reads a WITH query of the statement
    // (the WITH queries no FROM item reads would move into the inner query, below the list that reads them)
    for (const sql of [
      "SELECT l.id, l.j FROM late l JOIN late_c c ON c.id = l.c WHERE l.c IN (SELECT p.c FROM late_p p WHERE p.line = 3) ORDER BY l.id LIMIT 3",
      "SELECT l.id, l.j FROM late l JOIN late_c c ON c.id = l.c AND EXISTS (SELECT 1 FROM late_p p WHERE p.c = c.id) ORDER BY l.id LIMIT 3",
      "SELECT l.id, l.j FROM late l JOIN late_c c ON c.id = l.c ORDER BY (SELECT count(*) FROM late_p p WHERE p.c = l.c), l.id LIMIT 3",
      "SELECT l.id, l.j, (SELECT count(*) FROM late_p p WHERE p.c = l.c) AS n FROM late l JOIN late_c c ON c.id = l.c ORDER BY n, l.id LIMIT 3",
      "SELECT id, (SELECT count(*) FROM late_p p WHERE p.c = id) AS n FROM late_c x FULL JOIN late_n y USING (id) ORDER BY id LIMIT 3",
      "SELECT t.id, (SELECT count(*) FROM late_p p WHERE p.c = t.c) AS n FROM (SELECT l.id, l.c, c.name FROM late l JOIN late_c c ON c.id = l.c) t ORDER BY t.id LIMIT 3",
      "WITH w AS (SELECT c, count(*) AS n FROM late_p GROUP BY c) SELECT l.id, (SELECT w.n FROM w WHERE w.c = l.c) AS n FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 3",
      "WITH w AS (SELECT id, c FROM late_n) SELECT l.id, (SELECT count(*) FROM w x WHERE x.c = l.c) AS n FROM late l JOIN w ON w.c = l.c ORDER BY l.id, w.id LIMIT 3",
    ]) {
      assert.deepEqual(held(await answer(c, sql)), held(await postgres(sql)), sql);
      assert.doesNotMatch(await sent(sql), /__mason_late/, sql);
    }
    assert.deepEqual((await answer(c, "WITH w AS (SELECT c, count(*) AS n FROM late_p GROUP BY c) SELECT l.id, (SELECT w.n FROM w WHERE w.c = l.c) AS n FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 3")).rows, [["1", "4"], ["2", "4"], ["3", "4"]]);
    assert.deepEqual((await answer(c, "WITH w AS (SELECT id, c FROM late_n) SELECT l.id, (SELECT count(*) FROM w x WHERE x.c = l.c) AS n FROM late l JOIN w ON w.c = l.c ORDER BY l.id, w.id LIMIT 3")).rows, [["1", "1"], ["2", "1"], ["3", "1"]]);
    // a prepared statement run after a SET reads the setting where it runs
    const prepared = { name: "listed_subquery", text: "SELECT l.id, (SELECT count(*) FROM late_p p WHERE p.c = l.c AND p.line < $1) AS n FROM late l JOIN late_c c ON c.id = l.c ORDER BY l.id LIMIT 2" };
    await c.query({ ...prepared, values: [2] });
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual((await c.query({ ...prepared, values: [1], rowMode: "array", types: raw } as pg.QueryConfig)).rows, [["1", "1"], ["2", "1"]]);
  } finally { await c.end(); }
});

// ISSUE 105, the same preview with no ORDER BY: which rows a LIMIT keeps is defined by no one, so what is held is what
// is defined: how many, each a row of the whole join, none more often than the join holds it. ISSUE 824 (the owner's
// decision, 2026-11-10): never sorted by row number, a join of keys included, so the statement stops early; its pages
// may overlap, as SQL and Postgres allow
test("a LIMIT with no ORDER BY over joined tables chooses its rows by row number with no sort, and they are rows of the join", async () => {
  const c = await client();
  const one = (v: unknown): unknown => typeof v === "string" ? v.replaceAll('": ', '":') : v;
  const key = (r: unknown[]): string => JSON.stringify(r.map(one));
  const sent = async (sql: string, values?: unknown[]): Promise<string> => {
    logged.length = 0;
    await c.query(sql, values as unknown[]);
    const line = logged.findLast((l) => l.startsWith("statement: "));
    assert.ok(line !== undefined, sql);
    return line;
  };
  /** the rows, each taken from what the whole join holds; what is left of it */
  const within = (rows: unknown[][], whole: unknown[][], sql: string): Map<string, number> => {
    const left = new Map<string, number>();
    for (const r of whole) left.set(key(r), (left.get(key(r)) ?? 0) + 1);
    for (const r of rows) {
      const n = left.get(key(r));
      assert.ok(n !== undefined, `${sql}: ${key(r)} is no row of the join`);
      assert.ok(n > 0, `${sql}: ${key(r)} more often than the join holds it`);
      left.set(key(r), n - 1);
    }
    return left;
  };
  const JOINS = "FROM late l JOIN late_c c ON c.id = l.c";
  const LEFT = "FROM late l LEFT JOIN late_c c ON c.id = l.c";
  /** the statement's rows held, and its form: row numbers chosen with no sort, inside or out */
  const held = async (list: string, from: string, tail: string, values?: unknown[]): Promise<void> => {
    const sql = `SELECT ${list} ${from} ${tail}`;
    const [got, limited, whole] = [await answer(c, sql, values), await postgres(sql, values), await postgres(`SELECT ${list} ${from}`)];
    assert.deepEqual(got.fields, limited.fields, sql);
    assert.equal(got.rows.length, limited.rows.length, sql);
    within(got.rows, whole.rows, sql);
    assert.match(await sent(sql, values), /(rowid|__mason_rid) AS __mason_r1(?!.* ORDER BY ).*\) AS __mason_late LEFT JOIN /, sql);
  };
  try {
    // A JOIN OF KEYS, each outer join's preserved side read first or not, which issue 105 sorted: the issue's own shape,
    // a LEFT join of a small table's key to a big one, first
    await held("l.*, c.*", LEFT, "LIMIT 7 OFFSET 0");
    await held("l.*, c.*", JOINS, "LIMIT 7 OFFSET 0");
    await held("l.id, c.id AS c, c.name", "FROM late l RIGHT JOIN late_c c ON c.id = l.c AND l.id < 20", "LIMIT 60");
    await held("l.id, c.id AS c, c.name", "FROM late l FULL JOIN late_c c ON c.id = l.c", "LIMIT 60 OFFSET 1950");
    await held("l.id, c.name", "FROM late l, late_c c WHERE c.id = l.c", "LIMIT 3");
    await held("c.name, l.id", "FROM late_c c JOIN late l ON l.c = c.id", "LIMIT 9");
    await held("l.id, c.name", "FROM late l RIGHT JOIN late_c c ON c.id = l.c", "LIMIT 9");
    await held("x.note, p.note AS n", "FROM late_p x JOIN late_p p ON p.c = x.c AND p.line = x.line", "LIMIT 9");
    await held("l.id, c.name, m.id AS m", "FROM late l LEFT JOIN late_c c ON c.id = l.c LEFT JOIN late m ON m.id = l.k", "LIMIT 9 OFFSET 4"); // a chain
    await held("l.id, c.name, m.id AS m", "FROM late l JOIN late_c c ON c.id = l.c JOIN late m ON m.id = l.k", "LIMIT 9"); // a star
    await held("d.id, c.name", "FROM (SELECT id, c, k + 1 AS k1 FROM late WHERE id > 3) d LEFT JOIN late_c c ON c.id = d.c", "LIMIT 5 OFFSET 2"); // a plain derived read
    await held("c.name", JOINS, "LIMIT 2000"); // a row number repeated, one table read
    await held("l.id, c.name", JOINS, "LIMIT 0");
    await held("l.id, c.name", LEFT, "LIMIT 3 OFFSET 100000");
    await held("l.id, c.name", `${JOINS} WHERE c.name = 'c7'`, "LIMIT 3");
    await held("l.id, c.name", `${LEFT} WHERE l.k > 5`, "LIMIT 3");
    await held("upper(c.name) AS u, l.j ->> 'n' AS n", JOINS, "LIMIT 3");
    await held("l.id, c.name", JOINS, "FETCH FIRST 2 ROWS ONLY");
    await held("l.id, c.name", LEFT, "LIMIT $1 OFFSET $2", [3, 1]);
    // and what issue 134 left unsorted already: a key equated with an expression, every pair, a join that multiplies,
    // under each join kind, a composite key in part, no key at all, an OR, a chasm
    await held("l.id, l.j, c.name", "FROM late l LEFT JOIN late_c c ON c.id = l.c + 40", "LIMIT 2000");
    await held("l.id, c.id AS c, c.name", "FROM late l FULL JOIN late_c c ON c.id = l.c + 40 AND l.id < 20", "LIMIT 2000 OFFSET 1990");
    await held("l.id, c.name", "FROM late l, late_c c", "LIMIT 5 OFFSET 7");
    await held("l.id, y.id AS y, y.c", "FROM late l JOIN late y ON y.c = l.c", "LIMIT 9");
    for (const kind of ["JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN"]) await held("l.id, y.id AS y", `FROM late l ${kind} late y ON y.c = l.c`, "LIMIT 40 OFFSET 5");
    await held("l.id, p.note", "FROM late l JOIN late_p p ON p.c = l.c", "LIMIT 9");
    await held("l.id, n.id AS n", "FROM late l JOIN late_n n ON n.id = l.c", "LIMIT 9");
    await held("l.id, c.name", "FROM late l JOIN late_c c ON c.id = l.c OR c.id = l.k", "LIMIT 9");
    await held("c.name, a.id, b.id AS b", "FROM late_c c JOIN late a ON a.c = c.id JOIN late b ON b.c = c.id", "LIMIT 9");
    await held("a.j, b.j AS k, c.name", "FROM late_c c LEFT JOIN late a ON a.c = c.id LEFT JOIN late b ON b.c = c.id", "LIMIT 9 OFFSET 3"); // wide columns read after the limit
    await held("*", "FROM late l JOIN late y ON y.c = l.c", "LIMIT 3");
    await held("l.id, y.j", "FROM late l JOIN late y ON y.c = l.c", "LIMIT $1 OFFSET $2", [3, 1]);
    await held("*", "FROM late l LEFT JOIN late_c c ON c.id = l.c + 1000", "LIMIT 3");
    assert.doesNotMatch(await sent("SELECT * FROM (SELECT l.id FROM late l JOIN late_c c ON c.id = l.c LIMIT 3) s, (SELECT l.id AS i FROM late l JOIN late_c c ON c.name = l.j ->> 'n' LIMIT 3) t LIMIT 2"), /ORDER BY \w+\.rowid/);
    // a prepared statement, run again with another LIMIT and after a SET
    const prepared = { name: "unsorted", text: `SELECT l.id, c.name ${LEFT} LIMIT $1`, rowMode: "array" as const };
    assert.equal((await c.query({ ...prepared, values: [2] })).rows.length, 2);
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    assert.equal((await c.query({ ...prepared, values: [5] })).rows.length, 5);
    // PAGES: each page's rows are rows of the join, as many as Postgres's page holds; which rows, and whether two pages
    // overlap, is defined by no one (the owner's decision, issue 824)
    const whole = (await postgres(`SELECT l.id, c.name ${LEFT}`)).rows;
    for (let offset = 0; offset < whole.length; offset += 300) {
      const page = (await answer(c, `SELECT l.id, c.name ${LEFT} LIMIT 300 OFFSET ${offset}`)).rows;
      assert.equal(page.length, Math.min(300, whole.length - offset), `OFFSET ${offset}`);
      within(page, whole, `OFFSET ${offset}`);
    }
    // ONE TABLE'S ROW NUMBERS EACH, no sort inside or out, the LIMIT and OFFSET the statement's own
    assert.match(await sent(`SELECT l.j, c.name ${LEFT} LIMIT 3 OFFSET 2`),
      /^statement: .*\( SELECT l\.rowid AS __mason_r1, c\.rowid AS __mason_r2 FROM late AS l LEFT JOIN late_c AS c ON c\.id = l\.c LIMIT 3 OFFSET 2 \) AS __mason_late LEFT JOIN late AS l ON l\.rowid = __mason_late\.__mason_r1 LEFT JOIN late_c AS c ON c\.rowid = __mason_late\.__mason_r2$/);
    // a row number exists of a table alone, and a statement with no limit in fact has nothing to choose
    for (const sql of [`SELECT l.id, c.name ${JOINS}`, `SELECT l.id, c.name ${JOINS} OFFSET 1990`, `SELECT l.id, c.name ${JOINS} LIMIT ALL`, `SELECT l.id, c.name ${JOINS} LIMIT NULL`,
      `SELECT l.id, c.name ${JOINS} LIMIT NULL::int OFFSET 1990`, "SELECT l.id, l.j ->> 'n' FROM late l LIMIT 3",
      `SELECT DISTINCT l.c ${JOINS} LIMIT 3`, `SELECT 1 ${JOINS} LIMIT 3`]) {
      assert.doesNotMatch(await sent(sql), /__mason_r1/, sql);
      assert.equal((await answer(c, sql)).rows.length, (await postgres(sql)).rows.length, sql);
    }
    // the list after the limit keeps its sort: with none, nothing puts the kept rows back
    assert.doesNotMatch(await sent(`SELECT upper(l.j ->> 'n') FROM late l LIMIT 3`), /__mason_late/);
    // what Postgres refuses is refused (by another SQLSTATE, as a LIMIT -1 of one table is)
    for (const sql of [`SELECT l.id ${JOINS} LIMIT -1`, `SELECT l.id ${JOINS} LIMIT 1 OFFSET -1`]) {
      const refused = async (ask: Promise<unknown>): Promise<string> => { try { await ask; return "answered"; } catch (e) { return (e as { code: string }).code; } };
      assert.notEqual(await refused(answer(c, sql)), "answered", sql);
    }
  } finally { await c.end(); }
});

// A `->>` OF A COLUMN IS DUCKDB'S OWN READ (the test server: every JSON read was a hop to the main thread per
// vector, 98 s over 22 M rows with every other session waiting). Where DuckDB's reader answers as Postgres does (a string,
// a missing path, a JSON null) the statement never reaches the function; the rest (a number's digits, an object, an
// array, a json document holding a key twice, an index) still does. Postgres's answers are PGlite's own.
test("a ->> of a column is DuckDB's own read where it is Postgres's answer, the function's for the rest", async () => {
  const c = await client();
  try {
    const reads = ["b ->> 'a'", "b ->> 'n'", "b ->> 'o'", "b ->> 'e'", "b ->> 's'", "b ->> 'z'", "b ->> 'arr'", "b ->> '*'", "b ->> ''", "b ->> 'a.b'", "b ->> 'a/b'", "b ->> 'a~b'", "b ->> '$'",
      "b ->> 'missing'", "b ->> 't'", "b ->> 'big'", "b -> 'o' ->> 'b'", "b -> 'o' ->> '0'", "b -> 'o' -> 0 ->> 'b'", "b -> 'arr' ->> 0", "b -> 'arr' ->> -1", "b -> 'arr' ->> '0'", "b -> 'o' -> 'b'",
      "b #>> '{o,b}'", "b #>> '{arr,0}'", "b #>> '{arr,-1}'", "b #>> '{o,0}'", "b #>> '{}'", "b #> '{o}' ->> 'b'",
      "j ->> 'a'", "j ->> 'e'", "j ->> 'o'", "j -> 'o' ->> 'k'", "j #>> '{o,k}'", "j ->> 'missing'", "jsonb_extract_path_text(b, 'o', 'b')", "json_extract_path_text(j, 'o', 'k')"];
    const sql = `SELECT id, ${reads.join(", ")} FROM jdocs ORDER BY id`;
    const [got, want] = [await answer(c, sql), await postgres(sql)];
    for (const [i, row] of want.rows.entries()) for (const [k, v] of row.entries()) assert.equal(got.rows[i]![k], v, `row ${row[0]}: ${k === 0 ? "id" : reads[k - 1]}`);
    assert.deepEqual(got.fields, want.fields);
    // the hops: a read of strings alone makes none; a number, an index, the json itself, a json document holding a key
    // twice (row 1's j, at the root and in o: DuckDB reads the first, Postgres the last), a literal's, do
    // (the count is the engine's thread's, where the functions run: src/duck/executor.ts functionCalls)
    const calls = async (): Promise<number> => (await store.functionCalls()).get("__mason_json_get") ?? 0;
    const hops = async (read: string, where = ""): Promise<number> => {
      const before = await calls();
      await answer(c, `SELECT ${read} FROM jdocs ${where}`);
      return (await calls()) - before;
    };
    for (const read of ["b ->> 's'", "b ->> 'missing'", "b ->> 'z'", "b -> 'o' ->> 'b'", "b #>> '{o,b}'", "b ->> ''", "b ->> '*'", "b ->> 'a.b'", "jsonb_extract_path_text(b, 'o', 'b')"]) assert.equal(await hops(read), 0, `${read} reached the function`);
    for (const read of ["j ->> 'a'", "j -> 'o' ->> 'k'", "j ->> 'missing'", "json_extract_path_text(j, 'o', 'k')"]) assert.equal(await hops(read, "WHERE id <> 1"), 0, `${read} reached the function`);
    for (const read of ["b ->> 'n'", "j ->> 'a'", "j -> 'o' ->> 'k'", "b -> 'arr' ->> 0", "b #>> '{arr,0}'", "b -> 'o'", "'{\"a\": \"x\"}'::jsonb ->> 'a'"]) assert.ok(await hops(read) > 0, `${read} never reached the function`);
  } finally { await c.end(); }
});

// A `->` AND AN `@>` OF A COPIED JSONB ARE DUCKDB'S OWN (issue 130: a BI tool's `j @> '{"a": 1}'` and `(j -> 'a') IS
// NOT NULL` over 20 kB documents held every other session's statement 10 s and more, each vector a hop to the executor's
// loop). Where DuckDB's read is Postgres's answer (an integer, a boolean, a JSON null, a string DuckDB writes alike; a
// read's nullness; a template of scalars) no row reaches a function; the rest goes on to it (the CASE's ELSE). Postgres's
// answers are PGlite's own; the hops are every function's, the turn's included.
test("a -> and an @> of a copied jsonb are DuckDB's own read where that is Postgres's answer, the function's for the rest", async () => {
  const c = await client();
  try {
    const reads = ["b -> 'a'", "(b -> 'a')::text", "b -> 'b'", "b -> 'missing'", "b -> 'é'", `b -> 'a"b'`, "b -> 'a/b'", "b -> 'a~b'", "b -> ''", "b -> '1'", "b -> '*'", "b -> 'a.b'",
      "b -> 's'", "b -> 'i'", "b -> 'n'", "b -> 'o'", "b -> 'arr'", "b -> 'z'", "b -> 't'", "b -> 'c'", "b -> 'a' -> 'b'", "b -> 'a' -> 'b' -> 'c'", "b #> '{a,b}'", "b #> '{a,d}'", "b #> '{o,b}'",
      "jsonb_typeof(b -> 'a')", "b -> 'a' ->> 'b'", "j -> 'a'", "(j -> 'a')::text", "j -> '1'",
      "(b -> 'a') IS NULL", "(b -> 'a') IS NOT NULL", "(b -> 'missing') IS NULL", "(b -> '1') IS NOT NULL", "(b #> '{a,b}') IS NOT NULL", "(b -> 'a' -> 'b') IS NULL", "(j -> 'a') IS NOT NULL", "(j -> 'a' -> 'b') IS NULL",
      `b @> '{"a": 1}'`, `b @> '{"a": 1.0}'`, `b @> '{"a": 1.5}'`, `b @> '{"a": 1e2}'`, `b @> '{"a": 100}'`, `b @> '{"a": 0}'`, `b @> '{"a": -0}'`, `b @> '{"a": -5}'`, `b @> '{"b": 0.1}'`,
      `b @> '{"a": 100000000000000000000}'`, `b @> '{"a": 1.0000000000000000001}'`, `b @> '{"a": 9223372036854775807}'`, `b @> '{"a": -9223372036854775809}'`, `b @> '{"a": 18446744073709551616}'`,
      `b @> '{"a": "1"}'`, `b @> '{"a": ""}'`, `b @> '{"a": null}'`, `b @> '{"a": true}'`, `b @> '{"a": false}'`, `b @> '{}'`, `b @> '{"a": 1, "b": 1}'`, `b @> '{"a": 1, "a": 2}'`, `b @> '{"missing": null}'`,
      `b @> '{"a": {}}'`, `b @> '{"a": {"b": 1}}'`, `b @> '{"a": {"b": 1.0}}'`, `b @> '{"a": {"b": {"c": "x"}}}'`, `b @> '{"a": {"d": 2, "b": {"c": "x"}}}'`, `b @> '{"a": [1]}'`, `b @> '{"a": []}'`,
      `b @> '{"é": 1}'`, String.raw`b @> '{"a\"b": 2}'`, `b @> '{"a/b": 3}'`, `b @> '{"a~b": 4}'`, `b @> '{"": 5}'`, `b @> '{"1": 6}'`, `b @> '{"*": 7}'`, `b @> '{"a.b": 8}'`,
      `b @> '{"a": "é"}'`, String.raw`b @> '{"a": "é"}'`, String.raw`b @> '{"a": "x\ny"}'`, String.raw`b @> '{"a": "\u0001"}'`, String.raw`b @> '{"a": "\u001f"}'`, String.raw`b @> '{"a": "q\"uote"}'`,
      String.raw`b @> '{"a": "back\\slash"}'`, `b @> '{"a": "a/b"}'`, String.raw`b @> '{"a": "\\u00e9"}'`, `b @> '[1]'`, `b @> '1'`, `b @> 'null'`, `b @> NULL`, `NULL::jsonb @> '{"a": 1}'`,
      `'{"a": 1}' <@ b`, `'{}' <@ b`, `b <@ '{"a": 1, "b": 1}'`, `b @> '{"a": 1}'::jsonb`, `b @> jsonb '{"a": 1}'`, `b @> CAST('{"a": 1}' AS jsonb)`, `b @> ' { "a" : 1 } '`, `b @> '{"a": 1}'::json::jsonb`,
      `b @> jsonb_build_object('a', 1)`, `(b -> 'a') @> '{"b": 1}'`, `b::text::jsonb @> '{"a": 1}'`];
    const sql = `SELECT id, ${reads.join(", ")} FROM jnat ORDER BY id`;
    const [got, want] = [await answer(c, sql), await postgres(sql)];
    for (const [i, row] of want.rows.entries()) for (const [k, v] of row.entries()) assert.equal(got.rows[i]![k], v, `row ${row[0]}: ${k === 0 ? "id" : reads[k - 1]}`);
    assert.deepEqual(got.fields, want.fields);
    // filtered, counted and grouped as a BI tool asks, and inside a subquery
    for (const statement of [`SELECT count(*) FROM jnat WHERE b @> '{"a": 1}'`, `SELECT count(*) FROM jnat WHERE NOT (b @> '{"a": 1}')`, "SELECT count(*) FROM jnat WHERE (b -> 'a') IS NOT NULL",
      "SELECT (b -> 'a') IS NULL AS m, count(*) FROM jnat GROUP BY 1 ORDER BY 1", `SELECT b @> '{"a": 1}' AS c, count(*) FROM jnat GROUP BY c ORDER BY c`,
      "SELECT id, b -> 'b' AS b FROM jnat c ORDER BY (c.b -> 'a') IS NULL, id", `SELECT id FROM jnat c ORDER BY c.b @> '{"a": 1}', id`,
      `SELECT id, (SELECT count(*) FROM jnat i WHERE i.b @> '{"a": 1}' AND i.id <= o.id), EXISTS (SELECT 1 FROM jnat i WHERE (i.b -> 'a') IS NOT NULL AND i.id = o.id) FROM jnat o ORDER BY id`,
      `SELECT *, b -> 'a' AS v, b @> '{"a": 1}' AS c FROM jnat ORDER BY id`, `SELECT a.id, b.b @> '{"a": 1}', (b.b -> 'a') IS NULL FROM jnat a LEFT JOIN jnat b ON b.id = a.id + 1000 ORDER BY a.id`]) {
      assert.deepEqual((await answer(c, statement)).rows, (await postgres(statement)).rows, statement);
    }
    const calls = async (): Promise<number> => [...(await store.functionCalls()).values()].reduce((a, b) => a + b, 0);
    const hops = async (read: string): Promise<number> => {
      const before = await calls();
      await answer(c, `SELECT ${read} FROM jnat`);
      return (await calls()) - before;
    };
    for (const read of ["b -> 's'", "b -> 'missing'", "b -> 'z'", "b -> 't'", "b -> 'i'", "(b -> 'o') IS NOT NULL", "(b -> 'arr') IS NULL", "b #> '{o,b}'", "(j -> 'a') IS NOT NULL", "(b -> 'a') IS NOT NULL",
      `b @> '{"s": "x"}'`, `b @> '{"i": 7}'`, `b @> '{"n": 7}'`, `b @> '{"o": {"b": "deep"}}'`, `b @> '{}'`, `'{"z": null}' <@ b`]) assert.equal(await hops(read), 0, `${read} reached a function`);
    for (const read of ["b -> 'o'", "b -> 'arr'", "b -> 'n'", "b -> 'c'", "b -> 'a'", `b @> '{"arr": [1]}'`, `b @> '[1]'`, `b @> jsonb_build_object('a', 1)`, "j -> 'a'", `'{"a": "x"}'::jsonb -> 'a'`]) {
      assert.ok(await hops(read) > 0, `${read} never reached a function`);
    }
  } finally { await c.end(); }
});

// A PATH HAS ONE ROUTE HOWEVER IT IS SPELLED (issue 130): a BI tool's `#>> array['k']` was a to_json of the list, every
// row through the function, where `->> 'k'` is DuckDB's own read. Read from the analysis, so a cast that changes the
// text is never read as what was written, and a value only known at the Bind stays computed.
test("a constant path is the read ->> is, however it is spelled: no row reaches the function, answers as Postgres's", async () => {
  const c = await client();
  try {
    const native = ["b #>> ARRAY['o', 'b']", "b #>> ARRAY['o', 'b']::text[]", "b #>> ARRAY['o'::text, 'b'::text]", "b #>> '{o,b}'::text[]", "b #>> ARRAY['o', 'b']::varchar[]", "b #>> ARRAY['a.b']", "b ->> 'a'::text", "b ->> 'a'::varchar",
      "jsonb_extract_path_text(b, 'o'::text, 'b'::text)", "jsonb_extract_path_text(b, VARIADIC ARRAY['o', 'b'])", "jsonb_extract_path_text(b, VARIADIC '{o,b}'::text[])", "b #> ARRAY['o'] #>> ARRAY['b']"];
    const others = ["b #>> ARRAY['arr', '0']", "b #>> ARRAY['arr', '-1']", "b #> ARRAY['o']", "b #>> ARRAY[]::text[]", "b #> '{}'::text[]", "b #>> NULL::text[]", "b #>> ARRAY['o', NULL]", "b #>> '{o,NULL}'", "jsonb_extract_path_text(b, 'o', NULL)", "jsonb_extract_path_text(b, VARIADIC NULL::text[])",
      "b #>> '[2:3]={o,b}'", "b #>> ARRAY[lower('O'), 'b']", "b #>> ARRAY['o', id::text]", "j #>> ARRAY['o', 'k']", "j #> ARRAY['o']", "j #>> ARRAY['a']", "j #>> ARRAY['1']", "j #>> ARRAY[]::text[]"];
    const sql = `SELECT id, ${[...native, ...others].join(", ")} FROM jdocs ORDER BY id`;
    const [got, want] = [await answer(c, sql), await postgres(sql)];
    const named = ["id", ...native, ...others];
    for (const [i, row] of want.rows.entries()) for (const [k, v] of row.entries()) assert.equal(got.rows[i]![k], v, `row ${row[0]}: ${named[k]}`);
    assert.deepEqual(got.fields, want.fields);
    const calls = async (): Promise<number> => (await store.functionCalls()).get("__mason_json_get") ?? 0;
    for (const read of native) {
      const before = await calls();
      await answer(c, `SELECT ${read} FROM jdocs WHERE id <> 5`);
      assert.equal(await calls() - before, 0, `${read} reached the function`);
    }
    // a value the Parse cannot see stays computed, row by row or at the Bind, and is Postgres's
    for (const read of ["b #>> ARRAY['o', id::text]"]) {
      const before = await calls();
      await answer(c, `SELECT ${read} FROM jdocs`);
      assert.ok(await calls() > before, `${read} is computed`);
    }
    // the expression repeated in the GROUP BY and the ORDER BY is the one read: an array's own offsets are no part of it
    for (const statement of ["SELECT b #>> ARRAY['a'] AS v, count(*) AS n FROM jdocs GROUP BY b #>> ARRAY['a'] ORDER BY v", "SELECT b #>> ARRAY['a'], count(*) FROM jdocs GROUP BY b #>> ARRAY['a'] ORDER BY b #>> ARRAY['a']", "SELECT id FROM jdocs ORDER BY b #>> ARRAY['a'], id"]) {
      assert.deepEqual((await answer(c, statement)).rows, (await postgres(statement)).rows, statement);
    }
    // a text[] at the Bind: read by Postgres (a quote, a NULL element, an empty array), the plan made at the Parse
    const list = "SELECT id::text, b #>> $1::text[] AS a, (j #> $1::text[])::text AS b, jsonb_extract_path_text(b, VARIADIC $1::text[]) AS c FROM jdocs ORDER BY id";
    for (const value of ['{o,b}', '{arr,0}', '{"a.b"}', '{}', '{o,NULL}']) {
      const wanted = await postgres(list.replaceAll("$1::text[]", `'${value}'::text[]`));
      assert.deepEqual((await c.query({ text: list, values: [value], rowMode: "array" })).rows, wanted.rows, value);
    }
    // the same binding beside a list read as a list
    for (const value of ["{1,2}", "{}", "{NULL}"]) {
      const statement = "SELECT id::text FROM jdocs WHERE id::text = ANY($1::text[]) ORDER BY id";
      assert.deepEqual((await c.query({ text: statement, values: [value], rowMode: "array" })).rows, (await postgres(statement.replace("$1::text[]", `'${value}'::text[]`))).rows, value);
    }
    // a cast that changes the text is refused by name, never read as what was written
    for (const path of ["ARRAY['kk']::varchar(1)[]", "'{kk}'::char(1)[]", "ARRAY['k']::name[]"]) {
      await assert.rejects(answer(c, `SELECT b #>> ${path} FROM jdocs`), (e: Error & { code?: string; detail?: string }) => e.code === "0A000" && /json-path-type/.test(`${e.message} ${e.detail ?? ""}`), path);
    }
  } finally { await c.end(); }
});

// A TEXT[] PARAMETER IS ONE LIST OF DUCKDB'S (the review of issue 130): a value of two dimensions, or whose subscripts
// do not start at 1, is no such list — read as one it answered wrong (an inner array a string of its JSON, the bounds
// dropped), so it is refused by name, as its literal is. In binary (Npgsql sends every parameter so) it is array_send's
// bytes, decoded to the literal Postgres reads, and refused alike.
test("a text[] parameter of two dimensions or other bounds is refused by name", async () => {
  const c = await client();
  try {
    const named = (gap: string) => (e: Error & { code?: string; detail?: string }): boolean => e.code === "0A000" && new RegExp(`Mason gap ${gap}\\b`).test(e.detail ?? "");
    for (const sql of ["SELECT id::text, id::text = ANY($1::text[]), id::text <> ALL($1::text[]) FROM jdocs WHERE id < 4 ORDER BY id", "SELECT $1::text[], ($1::text[])[1], array_position($1::text[], '1') FROM jdocs WHERE id = 1"]) {
      for (const [value, gap] of [["{{1},{2}}", "multidim-array"], ["[2:3]={1,2}", "array-lower-bound"], ["[1:1][1:1]={{1}}", "multidim-array"]] as const) {
        await assert.rejects(answer(c, sql, [value]), named(gap), `${value}: ${sql}`);
      }
      // a one-dimensional value from 1, its bounds written or not, is answered as Postgres answers it
      for (const value of ["{1,2}", "[1:2]={1,2}"]) assert.deepEqual((await answer(c, sql, [value])).rows, (await postgres(sql, [value])).rows, value);
    }
  } finally { await c.end(); }
});

test("a binary text[] parameter is read as Postgres reads it, refused as it refuses, two dimensions or other bounds by name", async () => {
  const s = await rawSession();
  try {
    // the same Bind to Postgres and to Mason, the same rows
    const sql = "SELECT id::text, b #>> $1::text[] AS a, array_to_string($1::text[], '|', '*') AS s, (id::text = ANY($1::text[]))::text AS k FROM jdocs ORDER BY id";
    const send = async (array: string): Promise<Buffer> => Buffer.from((await truth.query<{ b: Uint8Array }>(`SELECT array_send(${array}) AS b`)).rows[0]!.b);
    const rows = (ms: BackendMessage[]): string[] => ms.flatMap((m) => m.type === "DataRow" ? [JSON.stringify(m.values.map((v) => v === null ? null : String(v)))] : m.type === "ErrorResponse" ? [`error ${m.fields.C} ${m.fields.M}`] : []);
    for (const array of ["ARRAY['o', 'b']::text[]", "ARRAY['a\"b\\c', NULL, 'NULL', '', ' x ', '{,}']::text[]", "ARRAY['1', '3']::varchar[]::text[]", "ARRAY[]::text[]", "ARRAY[NULL]::text[]"]) {
      const bind = wire.extended(sql, [await send(array)], [0], 1);
      const want = rows(wire.replies(await truth.execProtocolRaw(bind)));
      s.socket.write(bind);
      assert.deepEqual(rows(await s.untilReady()), want, array);
      assert.ok(want.length > 0 && !want[0]!.startsWith("error"), array);
    }
    for (const [array, gap] of [["'{{1},{2}}'::text[]", "multidim-array"], ["'[2:3]={1,2}'::text[]", "array-lower-bound"]] as const) {
      s.socket.write(wire.extended(sql, [await send(array)], [0], 1));
      const error = (await s.untilReady()).find((m) => m.type === "ErrorResponse") as Extract<BackendMessage, { type: "ErrorResponse" }> | undefined;
      assert.equal(error?.fields.C, "0A000", array);
      assert.match(error?.fields.D ?? "", new RegExp(`Mason gap ${gap}\\b`), array);
    }
    // bytes that are no text[]: refused as Postgres's array_recv refuses them (too few, too many, another element type)
    for (const bytes of [Buffer.from([0, 0, 0]), await send("ARRAY['a', 'b']::text[]").then((b) => b.subarray(0, b.length - 1)), Buffer.concat([await send("ARRAY['a']::text[]"), Buffer.from([0])]), await send("ARRAY[1]::int4[]")]) {
      const bind = wire.extended(sql, [bytes], [0], 1);
      const want = rows(wire.replies(await truth.execProtocolRaw(bind)));
      s.socket.write(bind);
      assert.deepEqual(rows(await s.untilReady()), want, bytes.toString("hex"));
      assert.match(want[0] ?? "", /^error /, bytes.toString("hex"));
    }
  } finally { s.end(); }
});

// array_recv's own refusals, each of a binary text[] whose bytes array_send never writes (the second review of PR 149):
// an element that is no UTF-8 or holds a NUL (it was decoded with U+FFFD, or truncated the catalog's query), an element
// type other than the parameter's, flags other than 0 or 1, a dimension too large or negative. Each is Postgres's
// SQLSTATE and message, read from the same Bind.
test("a binary text[] parameter's bad element bytes, element type, flags and dimension are refused as Postgres's array_recv refuses them", async () => {
  const s = await rawSession();
  try {
    const sql = "SELECT id::text, array_to_string($1::text[], '|') AS s FROM jdocs ORDER BY id";
    const array = (flags: number, element: number, dims: Array<[number, number]>, items: Buffer[]): Buffer => {
      const int = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
      return Buffer.concat([int(dims.length), int(flags), int(element), ...dims.flatMap(([n, l]) => [int(n), int(l)]), ...items.flatMap((x) => [int(x.length), x])]);
    };
    const errors = (ms: BackendMessage[]): string[] => ms.flatMap((m) => m.type === "ErrorResponse" ? [`${m.fields.C} ${m.fields.M}`] : []);
    const cases: Array<[string, Buffer, string]> = [
      ["not UTF-8", array(0, 25, [[1, 1]], [Buffer.from([0x61, 0xff, 0x62])]), "22021"],
      ["a NUL", array(0, 25, [[1, 1]], [Buffer.from([0x61, 0x00, 0x62])]), "22021"],
      ["a bad three-byte character", array(0, 25, [[2, 1]], [Buffer.from("ok"), Buffer.from([0x78, 0xe2, 0x28, 0xa1])]), "22021"],
      ["a character cut short", array(0, 25, [[1, 1]], [Buffer.from([0x78, 0xe2, 0x82])]), "22021"],
      ["varchar elements", array(0, 1043, [[1, 1]], [Buffer.from("a")]), "42804"],
      ["flags 2", array(2, 25, [[1, 1]], [Buffer.from("a")]), "22P03"],
      ["a dimension past the maximum", array(0, 25, [[268435456, 1]], []), "54000"],
      ["a negative dimension", array(0, 25, [[-1, 1]], []), "54000"],
    ];
    for (const [name, bytes, code] of cases) {
      const bind = wire.extended(sql, [bytes], [0], 1);
      const want = errors(wire.replies(await truth.execProtocolRaw(bind)));
      s.socket.write(bind);
      assert.deepEqual(errors(await s.untilReady()), want, name);
      assert.match(want[0] ?? "", new RegExp(`^${code} `), name);
    }
  } finally { s.end(); }
});

// THE REVIEW OF THE NATIVE READ: two classes it broke, each shape answered as Postgres answers it.
//  - A jsonb VALUE is canonical only where it is a copied table's column (the copy holds jsonbText): a jsonb a statement
//    computes (jsonb_object_agg, jsonb_build_object, in a CTE, a subquery or an arm of a UNION) may hold a key twice,
//    whose ->> is the LAST value, at every level.
//  - The column a read is made off is placed in every arm of the read's CASE: each placement is its own node, so each is
//    qualified (a name another FROM item has in another case) or renamed (a subquery's twin) as the column is.
test("a ->> of a computed jsonb reads a key held twice as Postgres does, and a column read in every arm is named as Postgres resolved it", async () => {
  const c = await client();
  try {
    const statements = [
      `WITH t AS (SELECT jsonb_object_agg('a', "givenName" ORDER BY id) AS d FROM ua) SELECT d ->> 'a' FROM t`,
      `SELECT d ->> 'a' FROM (SELECT jsonb_object_agg('a', "givenName" ORDER BY id) AS d FROM ua) s`,
      `SELECT d ->> 'a' FROM (SELECT jsonb_build_object('a', email, 'a', "givenName") AS d FROM ua) s ORDER BY 1`,
      `SELECT d ->> 'a' FROM (SELECT b AS d FROM jdocs WHERE id = 2 UNION ALL SELECT jsonb_build_object('a', 'p', 'a', 'q') FROM ua WHERE id = 1) s ORDER BY 1`,
      `SELECT d -> 'o' ->> 'k', d #>> '{o,k}' FROM (SELECT jsonb_build_object('o', jsonb_build_object('k', email, 'k', "givenName")) AS d FROM ua) s ORDER BY 1`,
      `WITH t AS (SELECT json_object_agg('a', "givenName" ORDER BY id) AS d FROM ua) SELECT d ->> 'a' FROM t`,
      `SELECT "B" ->> 'a' FROM jdocs, jcase ORDER BY 1`,
      `SELECT "B" ->> 'a', b ->> 'a' FROM jdocs JOIN jcase USING (id) ORDER BY 1`,
      `SELECT "J" ->> 'a', j ->> 'a' FROM (SELECT b AS "J", j AS j FROM jdocs WHERE id = 2) s`,
    ];
    const wrong: string[] = [];
    for (const sql of statements) {
      const want = JSON.stringify(await postgres(sql));
      const got = await answer(c, sql).then((r) => JSON.stringify(r), (e: Error) => `${(e as pg.DatabaseError).code ?? ""} ${e.message}`);
      if (got !== want) wrong.push(`${sql}\n  mason:    ${got}\n  postgres: ${want}`);
    }
    assert.deepEqual(wrong, []);
  } finally { await c.end(); }
});

// SHOW ALL (Postico sends it at every connection, and it was refused by a bare PgError no gap named): Postgres's shape —
// the catalog Postgres's own RowDescription — and a row per setting Postgres lists, in its order, each this session's
// value where the session decides it. ONE reader (server.ts `sessionSetting`) answers SHOW <name>, SHOW ALL's row and
// the startup's ParameterStatus, so the three never part. The values are Mason's, never the source's (Mason gap show-all)
test("SHOW ALL is Postgres's three text columns, a row per setting in Postgres's order, each the string SHOW <name> answers in the session (Mason gap show-all)", async () => {
  const described = (ms: BackendMessage[]): BackendMessage | undefined => ms.find((m) => m.type === "RowDescription");
  const text = (r: Extract<BackendMessage, { type: "DataRow" }>, i: number): string | null => r.values[i]?.toString("utf8") ?? null;
  const errors = (ms: BackendMessage[]): BackendMessage[] => ms.filter((m) => m.type === "ErrorResponse");
  const want = wire.replies(await truth.execProtocolRaw(wire.query("SHOW ALL")));
  const s = await rawSession(api.port, { application_name: "postico-at-startup" });
  try {
    // what the startup reported is what SHOW ALL lists before any SET
    s.socket.write(wire.query("SHOW ALL"));
    const atStart = new Map(dataRows(await s.untilReady()).map((r) => [text(r, 0) ?? "", text(r, 1)]));
    assert.ok(s.reported.has("TimeZone") && s.reported.has("DateStyle"), "the startup reported its parameters");
    for (const [name, value] of s.reported) if (atStart.has(name)) assert.equal(atStart.get(name), value, `${name} as reported`);
    s.socket.write(wire.query("SET TimeZone = 'Europe/Berlin'; SET search_path = sales, public; SET work_mem = '64MB'; SET myapp.flag = 'on'"));
    assert.deepEqual(errors(await s.untilReady()), []);
    s.socket.write(wire.query("SHOW ALL"));
    const simple = await s.untilReady();
    assert.deepEqual(errors(simple), []);
    // the RowDescription is Postgres's, field for field: name, setting, description, each text (25), of no table, typmod -1
    assert.deepEqual(described(simple), described(want));
    const fields = described(simple);
    assert.deepEqual(fields?.type === "RowDescription" ? fields.fields.map((f) => [f.name, f.tableOid, f.typeOid, f.typeModifier, f.format]) : null,
      [["name", 0, 25, -1, 0], ["setting", 0, 25, -1, 0], ["description", 0, 25, -1, 0]]);
    assert.deepEqual(simple.find((m) => m.type === "CommandComplete"), { type: "CommandComplete", tag: "SHOW" });
    const rows = dataRows(simple);
    const names = rows.map((r) => text(r, 0) ?? "");
    // every name Postgres lists, each once, in Postgres's order (by name without regard to case: guc_name_compare)
    assert.deepEqual(names, dataRows(want).map((r) => text(r, 0)));
    assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, "no name twice");
    assert.deepEqual(names, [...names].sort((a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }));
    // left out as Postgres leaves them out, though the session set or reports them: a placeholder, the GUC_NO_SHOW_ALL ones
    for (const hidden of ["myapp.flag", "session_authorization", "is_superuser", "role"]) assert.ok(!names.includes(hidden), `${hidden} is not listed`);
    const setting = new Map(rows.map((r) => [text(r, 0) ?? "", text(r, 1)]));
    assert.equal(setting.get("TimeZone"), "Europe/Berlin", "the session's SET");
    assert.equal(setting.get("search_path"), "sales, public", "the session's SET");
    assert.equal(setting.get("application_name"), "postico-at-startup", "the startup packet's");
    assert.equal(setting.get("DateStyle"), "ISO, MDY");
    assert.equal(setting.get("work_mem"), "64MB", "a SET the catalog Postgres validated, kept by the session");
    assert.equal(setting.get("ssl"), "off", "a plain session on loopback");
    // a row's setting is the string SHOW <name> answers in the same session: every one the session decides, and every
    // 20th of the catalog's own (each SHOW of those is a round trip to the catalog Postgres, ~15 ms)
    const decided = new Set(["TimeZone", "search_path", "application_name", "DateStyle", "IntervalStyle", "work_mem", "ssl", "server_version", "server_version_num",
      "client_encoding", "server_encoding", "extra_float_digits", "transaction_isolation", "default_transaction_isolation", "default_transaction_read_only",
      "transaction_read_only", "in_hot_standby", "integer_datetimes", "standard_conforming_strings", "max_identifier_length"]);
    const asked = names.filter((n, i) => decided.has(n) || i % 20 === 0);
    assert.equal(asked.filter((n) => decided.has(n)).length, decided.size, "every decided name is listed");
    s.socket.write(wire.query(asked.map((n) => `SHOW "${n}"`).join("; ")));
    const shown = await s.untilReady();
    assert.deepEqual(errors(shown), []);
    assert.deepEqual(dataRows(shown).map((r) => text(r, 0)), asked.map((n) => setting.get(n)));
    // the extended protocol (Parse, Bind, Describe the portal, Execute): the same RowDescription and rows
    s.socket.write(wire.extended("SHOW ALL", [], [0]));
    const extended = await s.untilReady();
    assert.deepEqual(errors(extended), []);
    assert.deepEqual(described(extended), described(want));
    assert.deepEqual(dataRows(extended), rows);
  } finally { s.end(); }
});

// THE STARTUP'S ParameterStatus, pinned: made from the REPORTED set through sessionSetting (no longer a literal list),
// each name in Postgres's spelling, in this order, with the session's values (a change-detector: read the diff)
test("the startup reports the fourteen parameters Postgres reports, in Postgres's spelling and order, with the session's values", async () => {
  const version = (await truth.query<{ server_version: string }>("SHOW server_version")).rows[0]!.server_version;
  const s = await rawSession();
  try {
    assert.deepEqual([...s.reported], [
      ["application_name", ""], ["client_encoding", "UTF8"], ["DateStyle", "ISO, MDY"], ["default_transaction_read_only", "on"],
      ["in_hot_standby", "on"], ["integer_datetimes", "on"], ["IntervalStyle", "postgres"], ["is_superuser", "off"],
      ["search_path", '"$user", public'], ["server_encoding", "UTF8"], ["server_version", version], ["session_authorization", "mason"],
      ["standard_conforming_strings", "on"], ["TimeZone", "UTC"],
    ]);
  } finally { s.end(); }
});

// A `#>` PATH ELEMENT IS AN INDEX AS POSTGRES'S strtoint READS IT (jsonfuncs.c): white space before it and a sign are
// read, anything after the digits is not — `{+1}` and `{" 1"}` are index 1 of an array, `{"1 "}` is no index (NULL on
// an array) — and on an object every element is a key. One definition (src/duck/functions.ts pathIndex) for the
// function and the native read, each held to PGlite here: a column's read (native where it can be) and a literal's (the
// function's).
test("a #> path element is an array index exactly where Postgres reads one, on a column and on a literal", async () => {
  const c = await client();
  try {
    const elements = ["{+1}", '{" 1"}', '{"1 "}', "{01}", "{-1}", '{" -1"}', "{+-1}", "{1.0}", "{1}", "{99999999999}"];
    const reads = [...elements.flatMap((e) => [`b #>> '${e}'`, `j #>> '${e}'`, `b #> '${e}'`]),
      "jsonb_extract_path_text(b, '+1')", "jsonb_extract_path_text(b, '1 ')", "json_extract_path_text(j, ' 1')",
      ...elements.flatMap((e) => [`'["x", "y", "z"]'::jsonb #>> '${e}'`, `'["x", "y", "z"]'::json #>> '${e}'`])];
    const sql = `SELECT id, ${reads.join(", ")} FROM jdocs ORDER BY id`;
    const [got, want] = [await answer(c, sql), await postgres(sql)];
    const wrong: string[] = [];
    for (const [i, row] of want.rows.entries()) for (const [k, v] of row.entries()) if (got.rows[i]![k] !== v) wrong.push(`row ${row[0]}: ${k === 0 ? "id" : reads[k - 1]}: ${String(got.rows[i]![k])} where Postgres has ${String(v)}`);
    assert.deepEqual(wrong, []);
    assert.deepEqual(got.fields, want.fields);
  } finally { await c.end(); }
});

// CURRENT_SETTING IS THE SESSION'S (GitHub issue 40): the catalog Postgres's `current_setting()` was a fourth reader of
// the session's parameters and answered its own values after a SET (`TimeZone` UTC, `search_path` the catalog's), and
// beside a copied table DuckDB's own `current_setting` answered DuckDB's settings. Each now answers the string `SHOW`
// answers — in a statement the catalog answers and in one DuckDB does, in a WHERE, a CTE and a prepared statement
// executed after a later SET — and a name the session does not hold is the catalog Postgres's own.
test("current_setting answers the session's value of every name it holds, as SHOW does, in the catalog and beside a copied table", async () => {
  const c = new pg.Client({ host: "127.0.0.1", port: api.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token, application_name: "tool-at-startup" });
  await c.connect();
  const one = async (sql: string, values?: unknown[]): Promise<unknown> => (await answer(c, sql, values)).rows[0]?.[0];
  const code = async (sql: string): Promise<string> => { try { await c.query(sql); return "answered"; } catch (e) { return `${(e as pg.DatabaseError).code} ${(e as pg.DatabaseError).message}`; } };
  try {
    // read before any SET, prepared under a name: executed again after the SETs below, it reads the session of then
    const prepared = { name: "setting_of", text: "SELECT current_setting($1) AS s FROM public.orders LIMIT 1", rowMode: "array" as const, types: raw };
    assert.equal(((await c.query({ ...prepared, values: ["TimeZone"] })).rows[0] as unknown[])[0], "UTC");
    await c.query("SET TimeZone = 'Europe/Berlin'; SET search_path = sales, public; SET work_mem = '64MB'; SET statement_timeout = '5s'; SET myapp.x = 'v1'");
    const names = ["TimeZone", "search_path", "work_mem", "application_name", "statement_timeout", "myapp.x", "DateStyle", "IntervalStyle",
      "server_version", "client_encoding", "is_superuser", "ssl", "standard_conforming_strings", "extra_float_digits"];
    const wrong: string[] = [];
    for (const name of names) {
      const shown = await one(`SHOW "${name}"`);
      const reads: Array<[string, string, unknown[]?]> = [
        ["the catalog", `SELECT current_setting('${name}')`], ["any case", `SELECT current_setting('${name.toUpperCase()}')`],
        ["missing_ok", `SELECT current_setting('${name}', true)`], ["missing_ok false", `SELECT current_setting('${name}', false)`],
        ["a parameter", "SELECT current_setting($1)", [name]],
        ["beside a table", `SELECT current_setting('${name}') FROM public.orders LIMIT 1`],
        ["beside a table, missing_ok", `SELECT current_setting('${name}', true) FROM public.orders LIMIT 1`],
        ["beside a table, a parameter", "SELECT current_setting($1) FROM public.orders LIMIT 1", [name]],
        ["qualified", `SELECT pg_catalog.current_setting('${name}')`], ["qualified, beside a table", `SELECT pg_catalog.current_setting('${name}', false) FROM public.orders LIMIT 1`],
        ["a CTE", `WITH s AS (SELECT current_setting('${name}') AS v) SELECT v FROM s`],
        ["a CTE over a table", `WITH s AS (SELECT id, current_setting('${name}') AS v FROM public.orders) SELECT v FROM s LIMIT 1`],
      ];
      for (const [how, sql, values] of reads) { const got = await one(sql, values); if (got !== shown) wrong.push(`${name} (${how}): ${String(got)} where SHOW says ${String(shown)}`); }
      // a WHERE, in the catalog and over a table
      if (await one(`SELECT count(*) FROM pg_catalog.pg_class WHERE current_setting('${name}') = $1 AND relname = 'pg_class'`, [shown]) !== "1") wrong.push(`${name}: a catalog WHERE`);
      if (await one(`SELECT count(*) > 0 FROM public.orders WHERE current_setting('${name}') = $1`, [shown]) !== "t") wrong.push(`${name}: a WHERE over a table`);
    }
    assert.deepEqual(wrong, []);
    assert.equal(await one("SELECT current_setting('search_path')"), "sales, public");
    assert.equal(await one("SELECT current_setting('timezone') FROM public.orders LIMIT 1"), "Europe/Berlin");
    assert.equal(await one("SELECT current_setting('application_name')"), "tool-at-startup");
    // the prepared statement, executed after the SETs: the session of its Execute
    assert.equal(((await c.query({ ...prepared, values: ["TimeZone"] })).rows[0] as unknown[])[0], "Europe/Berlin");
    await c.query("SET work_mem = '128MB'");
    assert.equal(((await c.query({ ...prepared, values: ["work_mem"] })).rows[0] as unknown[])[0], "128MB");
    // a name the session does not hold: the catalog Postgres's own, in both
    const blockSize = (await postgres("SELECT current_setting('block_size')")).rows[0]![0];
    assert.equal(await one("SELECT current_setting('block_size')"), blockSize);
    assert.equal(await one("SELECT current_setting('block_size') FROM public.orders LIMIT 1"), blockSize);
    // a name nobody holds: Postgres's 42704, or NULL under missing_ok; NULL in, NULL out (strict)
    const unknown = await (async () => { try { await truth.query("SELECT current_setting('no_such_setting')"); return "answered"; } catch (e) { return `${(e as { code: string }).code} ${(e as Error).message}`; } })();
    assert.equal(unknown, '42704 unrecognized configuration parameter "no_such_setting"');
    assert.equal(await code("SELECT current_setting('no_such_setting')"), unknown);
    assert.equal(await code("SELECT current_setting('no_such_setting') FROM public.orders"), unknown);
    assert.equal(await one("SELECT current_setting('no_such_setting', true) IS NULL"), "t");
    assert.equal(await one("SELECT current_setting('no_such_setting', true) IS NULL FROM public.orders LIMIT 1"), "t");
    assert.deepEqual((await answer(c, "SELECT current_setting(NULL), current_setting(NULL, true), current_setting('TimeZone', NULL) FROM public.orders LIMIT 1")).rows, [[null, null, null]]);
    assert.deepEqual((await answer(c, "SELECT current_setting(NULL), current_setting(NULL, true), current_setting('TimeZone', NULL)")).rows, [[null, null, null]]);
    // a placeholder's name is Postgres's to read: two or more simple identifiers, dotted (42602 otherwise)
    assert.equal(await code('SET "my app".x = 1'), '42602 invalid configuration parameter name "my app.x"');
    // DuckDB's own settings are never a session's: a name only DuckDB knows is Postgres's 42704
    assert.match(await code("SELECT current_setting('memory_limit') FROM public.orders"), /^42704 /);
  } finally { await c.end(); }
});

// THE CATALOG IS ONE CONNECTION EVERY SESSION SHARES (src/api/postgres/catalog.ts asSession): each request carries its
// session's settings and RESETs them after, so two sessions interleaved each read their own, and none is left behind —
// after an error too (the RESET follows the Sync the request carries)
test("two sessions' current_setting read their own settings however their requests interleave; none is left in the catalog", async () => {
  const [a, b] = [await client(), await client()];
  try {
    await a.query("SET search_path = alpha_schema, public; SET myapp.who = 'a'");
    await b.query("SET search_path = beta_schema, public; SET myapp.who = 'b'");
    const reads = (c: pg.Client, want: string, who: string): Array<Promise<string | null>> => Array.from({ length: 12 }, async (_, i) => {
      const sql = i % 3 === 0 ? "SELECT current_setting('search_path') || '/' || current_setting('myapp.who')"
        : i % 3 === 1 ? "SELECT current_setting('search_path') || '/' || current_setting('myapp.who') FROM public.orders LIMIT 1"
        : "SELECT current_setting('no_such_setting')";
      try { const v = (await answer(c, sql)).rows[0]?.[0] as string; return v === `${want}/${who}` ? null : `${who}: ${v}`; }
      catch (e) { return i % 3 === 2 && (e as pg.DatabaseError).code === "42704" ? null : `${who}: ${(e as Error).message}`; }
    });
    const wrong = (await Promise.all([...reads(a, "alpha_schema, public", "a"), ...reads(b, "beta_schema, public", "b")])).filter((x) => x !== null);
    assert.deepEqual(wrong, []);
    // nothing of either session stays in the catalog: a third session reads its own default
    const c = await client();
    try {
      assert.deepEqual((await answer(c, "SELECT current_setting('search_path'), current_setting('myapp.who', true)")).rows, [['"$user", public', null]]);
      // a placeholder another session SET is not this one's, however it asks (Postgres's 42704)
      for (const sql of ["SHOW myapp.who", "SELECT current_setting('myapp.who')", "SELECT current_setting('myapp.who') FROM public.orders"]) {
        await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "42704" && e.message === 'unrecognized configuration parameter "myapp.who"', sql);
      }
    } finally { await c.end(); }
  } finally { await a.end(); await b.end(); }
});

// SET_CONFIG IS A SET, AND A SET IS THE SESSION'S (a review finding of #46): forwarded, it ran on the catalog's one
// connection as its superuser and stayed there for every session — A's `set_config('search_path', 'zzz', false)` moved
// the catalog off the overrides (B's `version()` answered the engine's own string, B's current_setting('TimeZone') the
// catalog's UTC after a SET) and A's placeholder was B's. Now alone in a SELECT it is the session's SET, answered as
// the function's row, and any other form is refused by its registry entry; the carrier of a session's settings in the
// catalog is no name a tool writes (`current_setting('mason.session')` answered the carrier's JSON)
test("set_config alone is the session's SET, answered as Postgres answers it; another session never sees it; its other forms are refused by name", async () => {
  const [a, b] = [await client(), await client()];
  const one = async (c: pg.Client, sql: string): Promise<unknown> => (await answer(c, sql)).rows[0]?.[0];
  const code = async (c: pg.Client, sql: string, values?: unknown[]): Promise<string> => {
    try { await c.query(sql, values); return "answered"; } catch (e) { return `${(e as pg.DatabaseError).code} ${(e as pg.DatabaseError).message}`; }
  };
  try {
    assert.deepEqual(await answer(a, "SELECT set_config('search_path', 'zzz', false)"), { fields: [["set_config", 25]], rows: [["zzz"]] });
    assert.deepEqual([await one(a, "SHOW search_path"), await one(a, "SELECT current_setting('search_path')"), await one(a, "SELECT current_setting('search_path') FROM public.orders LIMIT 1")],
      ["zzz", "zzz", "zzz"], "A's own value, however A asks");
    // B is untouched: the catalog's overrides still win, B's own SET is B's
    assert.match(String(await one(b, "SELECT version()")), /^PostgreSQL 18\.6 \(mason-data /);
    await b.query("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual((await answer(b, "SELECT current_setting('TimeZone'), current_setting('search_path')")).rows, [["Asia/Tokyo", '"$user", public']]);
    // a placeholder: A's alone; the value answered as SHOW answers it (the time zone's own spelling), aliased
    assert.deepEqual(await answer(a, "SELECT set_config('myapp.leak', 'from-a', false) AS v"), { fields: [["v", 25]], rows: [["from-a"]] });
    assert.equal(await one(a, "SELECT current_setting('myapp.leak')"), "from-a");
    assert.equal(await one(b, "SELECT current_setting('myapp.leak', true)"), null);
    assert.equal(await one(a, "SELECT pg_catalog.set_config('TimeZone', 'europe/berlin', false)"), "Europe/Berlin");
    assert.equal(await one(a, "SHOW TimeZone"), "Europe/Berlin");
    // the extended protocol, a named statement: Describe and Execute answer alike
    const r = await a.query({ name: "configure", text: "SELECT set_config('work_mem', '64MB', false)", rowMode: "array", types: raw } as pg.QueryConfig);
    assert.deepEqual([r.fields.map((f) => [f.name, f.dataTypeID]), r.rows], [[["set_config", 25]], [["64MB"]]]);
    assert.equal(await one(a, "SHOW work_mem"), "64MB");
    // a name Postgres does not know is its 42704, as SET's; a value it refuses is its refusal
    assert.equal(await code(a, "SELECT set_config('no_such_setting', 'x', false)"), '42704 unrecognized configuration parameter "no_such_setting"');
    assert.match(await code(a, "SELECT set_config('work_mem', 'lots', false)"), /^22023 /);
    // every other form is refused by name, and changes nothing
    for (const sql of ["SELECT set_config('search_path', 'yyy', false), 1", "SELECT set_config('search_path', 'yyy', true), 1", "SELECT set_config('search_path', NULL, false)",
      "SELECT set_config('search_path', 'y' || 'yy', false)", "SELECT x FROM (SELECT set_config('search_path', 'yyy', false) AS x) AS s",
      "SELECT set_config('search_path', 'yyy', false) FROM public.orders LIMIT 1", "SELECT set_config('search_path', 'yyy', false) FROM pg_catalog.pg_class LIMIT 1",
      "EXPLAIN ANALYZE SELECT set_config('search_path', 'yyy', false)", "SELECT 1 WHERE set_config('search_path', 'yyy', false) IS NOT NULL"]) {
      assert.match(await code(b, sql), /^0A000 set_config\(\) is answered by Mason only alone .*Mason gap set-config-forms/, sql);
    }
    assert.match(await code(b, "SELECT set_config($1, 'yyy', false)", ["search_path"]), /^0A000 .*Mason gap set-config-forms/);
    assert.equal(await one(b, "SHOW search_path"), '"$user", public');
    // the carrier of the session's settings in the catalog is none of a tool's names: Postgres's 42704 however asked
    for (const sql of ["SELECT current_setting('mason.session')", "SELECT current_setting('mason.session') FROM public.orders LIMIT 1", "SHOW mason.session"]) {
      assert.equal(await code(a, sql), '42704 unrecognized configuration parameter "mason.session"', sql);
    }
    assert.equal(await one(a, "SELECT current_setting('mason.session', true)"), null);
  } finally { await a.end(); await b.end(); }
  // the ParameterStatus of a reported parameter set_config moved: after its row and its tag, before the ReadyForQuery
  const s = await rawSession();
  try {
    s.socket.write(wire.query("SELECT set_config('application_name', 'via-config', false)"));
    const ms = await s.untilReady();
    assert.deepEqual(ms.map((m) => m.type), ["RowDescription", "DataRow", "CommandComplete", "ParameterStatus", "ReadyForQuery"]);
    assert.deepEqual(ms.find((m) => m.type === "ParameterStatus"), { type: "ParameterStatus", name: "application_name", value: "via-config" });
  } finally { s.end(); }
});

// RESET ALL IS POSTGRES'S (GitHub issue 41): every parameter back to the session's start — the startup packet's
// `application_name` and `options` included, which RESET ALL once kept (application_name) or dropped (`-c`) — and a
// ParameterStatus for each REPORTED parameter that changed, as Postgres reports one (`ReportChangedGUCOptions`: a driver
// that caches them, pgjdbc and npgsql, was left with the SET's values). `RESET <name>` and DISCARD ALL alike; a SET or a
// RESET that changes nothing reports nothing
test("RESET ALL, RESET <name> and DISCARD ALL restore the startup's values and report each reported parameter that changed", async () => {
  const s = await rawSession(api.port, { application_name: "tool-at-startup", options: "-c work_mem=32MB -c search_path=startup_path" });
  const statuses = (ms: BackendMessage[]): Array<[string, string]> => ms.flatMap((m) => m.type === "ParameterStatus" ? [[m.name, m.value] as [string, string]] : []).sort();
  const errors = (ms: BackendMessage[]): BackendMessage[] => ms.filter((m) => m.type === "ErrorResponse");
  const shown = async (sql: string): Promise<Array<string | null>> => {
    s.socket.write(wire.query(sql));
    const ms = await s.untilReady();
    assert.deepEqual(errors(ms), [], sql);
    return dataRows(ms).flatMap((r) => r.values.map((v) => v?.toString("utf8") ?? null));
  };
  const run = async (sql: string): Promise<BackendMessage[]> => { s.socket.write(wire.query(sql)); const ms = await s.untilReady(); assert.deepEqual(errors(ms), [], sql); return ms; };
  try {
    assert.equal(s.reported.get("application_name"), "tool-at-startup");
    assert.equal(s.reported.get("search_path"), "startup_path", "the startup's options reported");
    const set = await run("SET TimeZone = 'Europe/Berlin'; SET application_name = 'after-set'; SET search_path = sales, public; SET work_mem = '64MB'; SET IntervalStyle = postgres; SET myapp.x = 'v'");
    assert.deepEqual(statuses(set), [["TimeZone", "Europe/Berlin"], ["application_name", "after-set"], ["search_path", "sales, public"]], "a SET reports what it changed (IntervalStyle did not)");
    const reset = await run("RESET ALL");
    assert.deepEqual(statuses(reset), [["TimeZone", "UTC"], ["application_name", "tool-at-startup"], ["search_path", "startup_path"]]);
    // where Postgres 14+ sends them (ReportChangedGUCOptions, just before ReadyForQuery): after the RESET's
    // CommandComplete, in Postgres's spelling
    assert.deepEqual(reset.map((m) => m.type), ["CommandComplete", "ParameterStatus", "ParameterStatus", "ParameterStatus", "ReadyForQuery"]);
    // ONCE per parameter per request, its last value; a value moved and moved back within one request is not told;
    // a request that fails half-way undid what its earlier statements moved (its implicit transaction): nothing to tell
    assert.deepEqual(statuses(await run("SET application_name = 'a'; SET application_name = 'b'; SET TimeZone = 'Asia/Tokyo'; SET TimeZone = 'UTC'")), [["application_name", "b"]]);
    s.socket.write(wire.query("SET application_name = 'before-error'; SELECT 1 / 0"));
    const failed = await s.untilReady();
    assert.deepEqual(failed.map((m) => m.type), ["CommandComplete", "ErrorResponse", "ReadyForQuery"]);
    assert.deepEqual(statuses(await run("RESET ALL")), [["application_name", "tool-at-startup"]]);
    assert.deepEqual(await shown("SHOW application_name; SHOW search_path; SHOW TimeZone; SHOW work_mem; SELECT current_setting('work_mem'), current_setting('application_name')"),
      ["tool-at-startup", "startup_path", "UTC", "32MB", "32MB", "tool-at-startup"]);
    // a placeholder the session SET stays defined, '' (Postgres's default of one), however it is asked
    assert.deepEqual(await shown("SHOW myapp.x; SELECT current_setting('myapp.x'), current_setting('myapp.x', true) FROM public.orders LIMIT 1"), ["", "", ""]);
    // RESET <name>: the startup's value, reported where it changed; again, nothing changes and nothing is reported
    assert.deepEqual(statuses(await run("SET TimeZone = 'Asia/Tokyo'; SET work_mem = '1GB'; SET search_path = other")), [["TimeZone", "Asia/Tokyo"], ["search_path", "other"]]);
    assert.deepEqual(statuses(await run("RESET TimeZone")), [["TimeZone", "UTC"]]);
    assert.deepEqual(statuses(await run("RESET TimeZone; SET TimeZone = 'UTC'")), [], "nothing changed: nothing reported");
    assert.deepEqual(statuses(await run("RESET search_path; RESET work_mem")), [["search_path", "startup_path"]]);
    assert.deepEqual(await shown("SHOW search_path; SHOW work_mem"), ["startup_path", "32MB"]);
    // SET … TO DEFAULT is RESET's
    await run("SET application_name = 'x'");
    assert.deepEqual(statuses(await run("SET application_name TO DEFAULT")), [["application_name", "tool-at-startup"]]);
    // DISCARD ALL is RESET ALL too, in the extended protocol as in the simple one
    await run("SET application_name = 'pooled'; SET TimeZone = 'Europe/Berlin'");
    s.socket.write(wire.extended("DISCARD ALL", [], []));
    const discarded = await s.untilReady();
    assert.deepEqual(errors(discarded), []);
    assert.deepEqual(statuses(discarded), [["TimeZone", "UTC"], ["application_name", "tool-at-startup"]]);
    assert.ok(discarded.some((m) => m.type === "CommandComplete" && m.tag === "DISCARD ALL"));
    await run("SET application_name = 'pooled'");
    assert.deepEqual(statuses(await run("DISCARD ALL")), [["application_name", "tool-at-startup"]]);
    // DISCARD PLANS holds nothing here: its own tag, nothing reset
    await run("SET application_name = 'kept'");
    const plans = await run("DISCARD PLANS");
    assert.deepEqual([statuses(plans), plans.find((m) => m.type === "CommandComplete")], [[], { type: "CommandComplete", tag: "DISCARD PLANS" }]);
    assert.deepEqual(await shown("SHOW application_name"), ["kept"]);
  } finally { s.end(); }
});

// A SESSION'S SETTINGS ARE TRANSACTIONAL, as Postgres's GUCs are (GitHub issue 47: `SET LOCAL` was a SET, and a ROLLBACK
// undid none). `vars` stays the one store every reader reads (`sessionSetting`); a transaction keeps what to restore, and
// its end, explicit or implicit, replaces `vars`. Every reply below is the one Postgres 18 sent, message by message, and
// the oracle holds the same shapes to a live Postgres (oracle/setting-scripts.ts).
/** one request's reply, a line a message: what a driver reads of a session's settings */
const replyLines = (ms: BackendMessage[]): string[] => ms.flatMap((m): string[] => {
  switch (m.type) {
    case "NoticeResponse": return [`${m.fields.V} ${m.fields.C} ${m.fields.M}`];
    case "ErrorResponse": return [`${m.fields.V} ${m.fields.C} ${m.fields.M}`];
    case "ParameterStatus": return [`status ${m.name}=${m.value}`];
    case "CommandComplete": return [`tag ${m.tag}`];
    case "DataRow": return [`row ${m.values.map((v) => v?.toString("utf8") ?? "NULL").join(",")}`];
    case "PortalSuspended": return ["suspended"];
    case "ReadyForQuery": return [`ready ${m.status}`];
    default: return [];
  }
});
type Raw = Awaited<ReturnType<typeof rawSession>>;
const onRaw = (s: Raw) => async (sql: string): Promise<string[]> => { s.socket.write(wire.query(sql)); return replyLines(await s.untilReady()); };
/** statements in one extended-protocol batch, up to one Sync */
const inBatch = (s: Raw) => async (...sqls: string[]): Promise<string[]> => {
  s.socket.write(Buffer.concat([...sqls.flatMap((q) => [wire.parse("", q), wire.bind("", "", [], []), wire.execute("")]), wire.sync()]));
  return replyLines(await s.untilReady());
};
const warned = "WARNING 25P01 SET LOCAL can only be used in transaction blocks";

test("SET LOCAL outside a block is Postgres's WARNING, its value gone with its own transaction and nothing reported", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  try {
    assert.deepEqual(await q("SET LOCAL application_name = 'loc'"), [warned, "tag SET", "ready I"]);
    assert.deepEqual(await q("SHOW application_name"), ["row start", "tag SHOW", "ready I"]);
    assert.deepEqual(await q("SELECT current_setting('application_name'), current_setting('application_name') FROM public.orders LIMIT 1"), ["row start,start", "tag SELECT 1", "ready I"]);
    // the warning comes first: a refused value is refused after it
    assert.deepEqual(await q("SET LOCAL no_such_setting = 'x'"), [warned, 'ERROR 42704 unrecognized configuration parameter "no_such_setting"', "ready I"]);
    assert.deepEqual(await q("SET LOCAL work_mem = 'lots'"), [warned, 'ERROR 22023 invalid value for parameter "work_mem": "lots"', "ready I"]);
    assert.deepEqual(await q("SET application_name = 'a'"), ["tag SET", "status application_name=a", "ready I"]);
    assert.deepEqual(await q("SET LOCAL application_name TO DEFAULT"), [warned, "tag SET", "ready I"]);
    assert.deepEqual(await q("SHOW application_name"), ["row a", "tag SHOW", "ready I"]);
    // SET LOCAL ROLE warns as any other; SET TRANSACTION in its own words, however it is spelt; the session's own form never
    assert.deepEqual(await q("SET LOCAL ROLE NONE"), [warned, "tag SET", "ready I"]);
    const transaction = ["WARNING 25P01 SET TRANSACTION can only be used in transaction blocks", "tag SET", "ready I"];
    assert.deepEqual(await q("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"), transaction);
    assert.deepEqual(await q("SET LOCAL TRANSACTION ISOLATION LEVEL READ COMMITTED"), transaction);
    assert.deepEqual(await q("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED"), ["tag SET", "ready I"]);
    assert.deepEqual(await q("SET SESSION TimeZone = 'Asia/Tokyo'"), ["tag SET", "status TimeZone=Asia/Tokyo", "ready I"]);
  } finally { s.end(); }
});

test("in a block SET LOCAL lasts until it ends, a SET is kept by COMMIT and undone by ROLLBACK, and the revert is reported once, at the block's end", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  const app = "SHOW application_name";
  try {
    for (const end of ["COMMIT", "ROLLBACK"]) {
      assert.deepEqual(await q("BEGIN"), ["tag BEGIN", "ready T"]);
      assert.deepEqual(await q("SET LOCAL application_name = 'loc'"), ["tag SET", "status application_name=loc", "ready T"], "no warning in a block");
      assert.deepEqual(await q(app), ["row loc", "tag SHOW", "ready T"]);
      assert.deepEqual(await q("SELECT current_setting('application_name') FROM public.orders LIMIT 1"), ["row loc", "tag SELECT 1", "ready T"]);
      assert.deepEqual(await q(end), [`tag ${end}`, "status application_name=start", "ready I"], end);
      assert.deepEqual(await q(app), ["row start", "tag SHOW", "ready I"]);
    }
    await q("BEGIN");
    assert.deepEqual(await q("SET application_name = 'a'"), ["tag SET", "status application_name=a", "ready T"]);
    assert.deepEqual(await q("ROLLBACK"), ["tag ROLLBACK", "status application_name=start", "ready I"]);
    assert.deepEqual(await q(app), ["row start", "tag SHOW", "ready I"]);
    await q("BEGIN");
    await q("SET application_name = 'a'");
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "ready I"], "what a COMMIT keeps was told at the SET: nothing moved");
    assert.deepEqual(await q(app), ["row a", "tag SHOW", "ready I"]);
    // an unreported parameter, read by every reader, and a value from before the block; a parameter of its own is untouched
    await q("BEGIN");
    await q("SET LOCAL work_mem = '77MB'");
    await q("SET LOCAL statement_timeout = '5s'");
    assert.deepEqual(await q("SELECT current_setting('work_mem'), current_setting('statement_timeout')"), ["row 77MB,5s", "tag SELECT 1", "ready T"]);
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "ready I"]);
    assert.deepEqual(await q("SELECT current_setting('work_mem'), current_setting('statement_timeout')"), ["row 4MB,0", "tag SELECT 1", "ready I"]);
    assert.deepEqual(await q("BEGIN; SET TimeZone = 'Asia/Tokyo'; SET LOCAL application_name = 'b'; COMMIT; SHOW TimeZone; SHOW application_name"),
      ["tag BEGIN", "tag SET", "tag SET", "tag COMMIT", "row Asia/Tokyo", "tag SHOW", "row a", "tag SHOW", "status TimeZone=Asia/Tokyo", "ready I"], "one Query, one report of what moved");
  } finally { s.end(); }
});

test("a SET and a SET LOCAL of one name in one block: COMMIT keeps the SET and ROLLBACK neither, whichever came last", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  const block = async (end: string, ...sets: string[]): Promise<string[]> => {
    await q("BEGIN");
    for (const v of sets) await q(`SET ${v === v.toUpperCase() ? "LOCAL " : ""}application_name = '${v}'`);
    const ending = await q(end);
    const left = (await q("SHOW application_name"))[0]!;
    await q("RESET ALL");
    return [...ending, left];
  };
  try {
    // a lower-case value is a SET, an upper-case one a SET LOCAL
    assert.deepEqual(await block("COMMIT", "a", "B"), ["tag COMMIT", "status application_name=a", "ready I", "row a"]);
    assert.deepEqual(await block("ROLLBACK", "a", "B"), ["tag ROLLBACK", "status application_name=start", "ready I", "row start"]);
    assert.deepEqual(await block("COMMIT", "B", "a"), ["tag COMMIT", "ready I", "row a"]);
    assert.deepEqual(await block("COMMIT", "a", "B", "C"), ["tag COMMIT", "status application_name=a", "ready I", "row a"]);
    assert.deepEqual(await block("COMMIT", "a", "B", "c"), ["tag COMMIT", "ready I", "row c"]);
    // of two names, each its own
    await q("BEGIN");
    await q("SET LOCAL application_name = 'b'");
    await q("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "status application_name=start", "ready I"]);
    assert.deepEqual(await q("SHOW TimeZone"), ["row Asia/Tokyo", "tag SHOW", "ready I"]);
  } finally { s.end(); }
});

test("a failed block has undone what it set at the error, whose ReadyForQuery reports it: not its ROLLBACK", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  const aborted = "ERROR 25P02 current transaction is aborted, commands ignored until end of transaction block";
  try {
    await q("BEGIN");
    await q("SET application_name = 'a'");
    assert.deepEqual(await q("SELECT 1/0"), ["ERROR 22012 division by zero", "status application_name=start", "ready E"]);
    for (const sql of ["SHOW application_name", "SET application_name = 'b'", "RESET ALL", "SELECT set_config('application_name', 'b', true)", "DISCARD ALL"]) {
      assert.deepEqual(await q(sql), [aborted, "ready E"], sql);
    }
    assert.deepEqual(await q("ROLLBACK"), ["tag ROLLBACK", "ready I"]);
    assert.deepEqual(await q("SHOW application_name"), ["row start", "tag SHOW", "ready I"]);
    // a COMMIT of a failed block is its ROLLBACK, a SET LOCAL's value from before the block is what comes back
    await q("SET application_name = 'before'");
    await q("BEGIN");
    await q("SET LOCAL application_name = 'a'");
    assert.deepEqual(await q("SELECT no_such_column FROM public.orders"), ['ERROR 42703 column "no_such_column" does not exist', "status application_name=before", "ready E"]);
    assert.deepEqual(await q("COMMIT"), ["tag ROLLBACK", "ready I"]);
    // the error of a batch, its Sync's ReadyForQuery reporting it
    await q("BEGIN");
    await q("SET application_name = 'a'");
    assert.deepEqual(await inBatch(s)("SELECT 1", "SELECT 1/0", "SELECT 2"), ["row 1", "tag SELECT 1", "ERROR 22012 division by zero", "status application_name=before", "ready E"]);
    await q("ROLLBACK");
  } finally { s.end(); }
});

test("a Query's statements and a Sync's batch are one implicit transaction: an error, a ROLLBACK or a BEGIN among them decides their SETs", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  const batch = inBatch(s);
  const app = "SHOW application_name";
  const none = "WARNING 25P01 there is no transaction in progress";
  try {
    assert.deepEqual(await q("SET LOCAL application_name = 'loc'; SHOW application_name"), ["tag SET", "row loc", "tag SHOW", "ready I"], "in a block already: no warning, and nothing moved by its end");
    assert.deepEqual(await q(app), ["row start", "tag SHOW", "ready I"]);
    assert.deepEqual(await q("SET application_name = 'a'; SELECT 1/0"), ["tag SET", "ERROR 22012 division by zero", "ready I"], "undone: nothing to report");
    assert.deepEqual(await q(app), ["row start", "tag SHOW", "ready I"]);
    assert.deepEqual(await q("SET application_name = 'a'; ROLLBACK"), ["tag SET", none, "tag ROLLBACK", "ready I"]);
    assert.deepEqual(await q("SET application_name = 'a'; COMMIT; SELECT 1/0"), ["tag SET", none, "tag COMMIT", "ERROR 22012 division by zero", "status application_name=a", "ready I"], "committed before the error");
    await q("RESET ALL");
    // a BEGIN takes in what ran before it
    assert.deepEqual(await q("SET application_name = 'a'; BEGIN"), ["tag SET", "tag BEGIN", "status application_name=a", "ready T"]);
    assert.deepEqual(await q("ROLLBACK"), ["tag ROLLBACK", "status application_name=start", "ready I"]);
    assert.deepEqual(await q("SET LOCAL application_name = 'a'; BEGIN"), ["tag SET", "tag BEGIN", "status application_name=a", "ready T"]);
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "status application_name=start", "ready I"]);
    assert.deepEqual(await q("SET LOCAL application_name = 'a'; COMMIT; SHOW application_name"), ["tag SET", none, "tag COMMIT", "row start", "tag SHOW", "ready I"]);
    // a statement after a COMMIT is in the Query's block again
    assert.deepEqual(await q("BEGIN; COMMIT; SET LOCAL application_name = 'x'; SHOW application_name"), ["tag BEGIN", "tag COMMIT", "tag SET", "row x", "tag SHOW", "ready I"]);

    // a batch: the first SET LOCAL warns, one after an Execute does not, and its value lasts to the Sync
    assert.deepEqual(await batch("SET LOCAL application_name = 'p'", "SET LOCAL TimeZone = 'Asia/Tokyo'", app), [warned, "tag SET", "tag SET", "row p", "tag SHOW", "ready I"]);
    assert.deepEqual(await batch("SELECT 1", "SET LOCAL application_name = 'p'", app), ["row 1", "tag SELECT 1", "tag SET", "row p", "tag SHOW", "ready I"]);
    assert.deepEqual(await q(app), ["row start", "tag SHOW", "ready I"]);
    assert.deepEqual(await batch("SET application_name = 'p'", "SELECT 1/0", "SELECT 2"), ["tag SET", "ERROR 22012 division by zero", "ready I"]);
    assert.deepEqual(await batch("SET application_name = 'p'", "ROLLBACK", app), ["tag SET", none, "tag ROLLBACK", "row start", "tag SHOW", "ready I"]);
    assert.deepEqual(await batch("SET application_name = 'p'", "COMMIT", "SELECT 1/0"), ["tag SET", none, "tag COMMIT", "ERROR 22012 division by zero", "status application_name=p", "ready I"]);
    await q("RESET ALL");
    assert.deepEqual(await batch("SET application_name = 'p'", "BEGIN", "SET TimeZone = 'Asia/Tokyo'"), ["tag SET", "tag BEGIN", "tag SET", "status application_name=p", "status TimeZone=Asia/Tokyo", "ready T"]);
    assert.deepEqual(await q("ROLLBACK"), ["tag ROLLBACK", "status application_name=start", "status TimeZone=UTC", "ready I"]);
    assert.deepEqual(await batch("BEGIN", "SET LOCAL application_name = 'x'", "COMMIT", "SET LOCAL TimeZone = 'Asia/Tokyo'", "SELECT 1", "SET LOCAL TimeZone = 'Asia/Tokyo'"),
      ["tag BEGIN", "tag SET", "tag COMMIT", warned, "tag SET", "row 1", "tag SELECT 1", "tag SET", "ready I"], "a COMMIT ends the block: the next SET LOCAL warns, then the batch is a block again");
    // a portal suspended at a row count begins the block as a finished Execute does (a review finding, against Postgres
    // 18.6): no warning, and DISCARD ALL refused, its portal and the session's settings left alone
    const suspended = (then: string): Buffer => Buffer.concat([wire.parse("", "SELECT id FROM public.orders ORDER BY id"), wire.bind("", "", [], []), wire.execute("", 1), wire.parse("q", then), wire.bind("q", "q", [], []), wire.execute("q"), wire.sync()]);
    s.socket.write(suspended("SET LOCAL application_name = 'p'"));
    assert.deepEqual(replyLines(await s.untilReady()), ["row 1", "suspended", "tag SET", "ready I"]);
    await q("SET application_name = 'kept'");
    s.socket.write(Buffer.concat([wire.close("P", "q"), wire.close("S", "q"), suspended("DISCARD ALL")]));
    assert.deepEqual(replyLines(await s.untilReady()), ["row 1", "suspended", "ERROR 25001 DISCARD ALL cannot run inside a transaction block", "ready I"]);
    assert.deepEqual(await q(app), ["row kept", "tag SHOW", "ready I"], "nothing reset");
  } finally { s.end(); }
});

test("RESET and RESET ALL in a block are undone by ROLLBACK and kept by COMMIT; DISCARD ALL is refused in one, implicit or not", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  const batch = inBatch(s);
  const app = "SHOW application_name";
  const refused = "ERROR 25001 DISCARD ALL cannot run inside a transaction block";
  try {
    await q("SET application_name = 'a'");
    await q("BEGIN");
    assert.deepEqual(await q("RESET application_name"), ["tag RESET", "status application_name=start", "ready T"]);
    assert.deepEqual(await q("ROLLBACK"), ["tag ROLLBACK", "status application_name=a", "ready I"]);
    await q("BEGIN");
    await q("RESET application_name");
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "ready I"]);
    assert.deepEqual(await q(app), ["row start", "tag SHOW", "ready I"]);
    // SET … TO DEFAULT is a SET, by its tag, and LOCAL may be it too
    await q("SET application_name = 'a'");
    assert.deepEqual(await q("SET application_name TO DEFAULT"), ["tag SET", "status application_name=start", "ready I"]);
    await q("SET application_name = 'a'");
    await q("BEGIN");
    assert.deepEqual(await q("SET LOCAL application_name TO DEFAULT"), ["tag SET", "status application_name=start", "ready T"]);
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "status application_name=a", "ready I"]);
    // RESET ALL: every parameter, undone or kept as one
    await q("SET work_mem = '64MB'");
    await q("BEGIN");
    assert.deepEqual(await q("RESET ALL"), ["tag RESET", "status application_name=start", "ready T"]);
    assert.deepEqual(await q("ROLLBACK"), ["tag ROLLBACK", "status application_name=a", "ready I"]);
    assert.deepEqual(await q("SHOW work_mem"), ["row 64MB", "tag SHOW", "ready I"]);
    await q("BEGIN");
    await q("RESET ALL");
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "ready I"]);
    assert.deepEqual(await q("SHOW work_mem"), ["row 4MB", "tag SHOW", "ready I"]);
    // a RESET ALL overrides a SET LOCAL before it, as any SET, and a SET LOCAL after it ends with the block
    await q("BEGIN");
    await q("SET application_name = 'a'");
    await q("SET LOCAL TimeZone = 'Asia/Tokyo'");
    await q("RESET ALL");
    await q("SET LOCAL application_name = 'z'");
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "status application_name=start", "ready I"]);
    assert.deepEqual(await q("SHOW TimeZone"), ["row UTC", "tag SHOW", "ready I"]);
    await q("SET application_name = 'a'");
    assert.deepEqual(await q("RESET ALL; SELECT 1/0"), ["tag RESET", "ERROR 22012 division by zero", "ready I"], "an implicit transaction's");
    assert.deepEqual(await q(app), ["row a", "tag SHOW", "ready I"]);

    await q("BEGIN");
    assert.deepEqual(await q("DISCARD ALL"), [refused, "ready E"]);
    assert.deepEqual(await q("SELECT 1"), ["ERROR 25P02 current transaction is aborted, commands ignored until end of transaction block", "ready E"]);
    await q("ROLLBACK");
    assert.deepEqual(await q("SET application_name = 'b'; DISCARD ALL"), ["tag SET", refused, "ready I"]);
    assert.deepEqual(await q("DISCARD ALL; SELECT 1"), [refused, "ready I"]);
    assert.deepEqual(await batch("SELECT 1", "DISCARD ALL"), ["row 1", "tag SELECT 1", refused, "ready I"]);
    assert.deepEqual(await q(app), ["row a", "tag SHOW", "ready I"], "nothing reset");
    // first in a batch it is a transaction of its own, committed before what follows
    assert.deepEqual(await batch("DISCARD ALL", "SET LOCAL TimeZone = 'Asia/Tokyo'", "SELECT 1/0"), ["tag DISCARD ALL", warned, "tag SET", "ERROR 22012 division by zero", "status application_name=start", "ready I"]);
    assert.deepEqual(await batch("SELECT 1", "COMMIT", "DISCARD ALL"), ["row 1", "tag SELECT 1", "WARNING 25P01 there is no transaction in progress", "tag COMMIT", "tag DISCARD ALL", "ready I"], "a COMMIT ended the batch's block");
    await q("BEGIN");
    assert.deepEqual(await q("DISCARD PLANS"), ["tag DISCARD PLANS", "ready T"], "the rest of DISCARD runs in a block");
    await q("COMMIT");
  } finally { s.end(); }
});

test("a placeholder a transaction named stays defined, '', however it ended", async () => {
  const s = await rawSession();
  const q = onRaw(s);
  const unset = 'ERROR 42704 unrecognized configuration parameter "myapp.never"';
  const blank = ["row ", "tag SHOW", "ready I"];
  try {
    assert.deepEqual(await q("SHOW myapp.never"), [unset, "ready I"]);
    assert.deepEqual(await q("BEGIN; SET LOCAL myapp.a = 'v'; SHOW myapp.a; ROLLBACK"), ["tag BEGIN", "tag SET", "row v", "tag SHOW", "tag ROLLBACK", "ready I"]);
    assert.deepEqual(await q("SHOW myapp.a"), blank);
    assert.deepEqual(await q("SELECT current_setting('myapp.a', true) FROM public.orders LIMIT 1"), ["row ", "tag SELECT 1", "ready I"]);
    await q("BEGIN; SET myapp.b = 'v'; ROLLBACK");
    assert.deepEqual(await q("SHOW myapp.b"), blank);
    await q("BEGIN; SET myapp.c = 'v'; COMMIT");
    await q("BEGIN; SET LOCAL myapp.c = 'w'; COMMIT");
    assert.deepEqual(await q("SHOW myapp.c"), ["row v", "tag SHOW", "ready I"]);
    await q("BEGIN; RESET myapp.d; ROLLBACK");
    assert.deepEqual(await q("SHOW myapp.d"), blank);
    await q("BEGIN");
    await q("SET myapp.e = 'v'");
    await q("SELECT 1/0");
    await q("ROLLBACK");
    assert.deepEqual(await q("SHOW myapp.e"), blank);
    await q("SET LOCAL myapp.f = 'v'");
    assert.deepEqual(await q("SHOW myapp.f"), blank);
    await q("SET myapp.g = 'v'; SELECT 1/0");
    assert.deepEqual(await q("SHOW myapp.g"), blank);
    await q("BEGIN; SET LOCAL myapp.h = 'v'; RESET ALL; COMMIT");
    assert.deepEqual(await q("SHOW myapp.h"), blank);
  } finally { s.end(); }
});

test("set_config(name, value, true) alone is SET LOCAL, less the warning; ROLLBACK undoes a set_config as it undoes a SET", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  try {
    assert.deepEqual(await q("SELECT set_config('application_name', 'c', true)"), ["row c", "tag SELECT 1", "ready I"], "no warning, nothing reported");
    assert.deepEqual(await q("SHOW application_name"), ["row start", "tag SHOW", "ready I"]);
    assert.deepEqual(await q("SELECT set_config('application_name', 'c', true); SHOW application_name"), ["row c", "tag SELECT 1", "row c", "tag SHOW", "ready I"]);
    await q("BEGIN");
    assert.deepEqual(await q("SELECT set_config('application_name', 'c', true) AS v"), ["row c", "tag SELECT 1", "status application_name=c", "ready T"]);
    assert.deepEqual(await q("SELECT current_setting('application_name') FROM public.orders LIMIT 1"), ["row c", "tag SELECT 1", "ready T"]);
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "status application_name=start", "ready I"]);
    await q("BEGIN");
    await q("SELECT set_config('application_name', 'c', false)");
    assert.deepEqual(await q("ROLLBACK"), ["tag ROLLBACK", "status application_name=start", "ready I"]);
    await q("BEGIN");
    await q("SELECT set_config('application_name', 'k', false)");
    await q("SELECT set_config('application_name', 'c', true)");
    assert.deepEqual(await q("COMMIT"), ["tag COMMIT", "status application_name=k", "ready I"]);
    assert.deepEqual(await inBatch(s)("SELECT set_config('application_name', 'p', true)", "SHOW application_name"), ["row p", "tag SELECT 1", "row p", "tag SHOW", "ready I"]);
    await q("SELECT set_config('myapp.cl', 'c', true)");
    assert.deepEqual(await q("SHOW myapp.cl"), ["row ", "tag SHOW", "ready I"]);
    assert.deepEqual(await q("SELECT set_config('no_such_setting', 'c', true)"), ['ERROR 42704 unrecognized configuration parameter "no_such_setting"', "ready I"]);
    assert.deepEqual(await q("SELECT set_config('work_mem', 'lots', true)"), ['ERROR 22023 invalid value for parameter "work_mem": "lots"', "ready I"]);
    // its other forms stay the gap's, is_local or not
    assert.match((await q("SELECT set_config('application_name', 'c', true) FROM public.orders"))[0]!, /^ERROR 0A000 set_config\(\) is answered by Mason only alone .*Mason gap set-config-forms/);
  } finally { s.end(); }
});

// A FAILED BLOCK ACCEPTS NOTHING BUT ITS END, ON EVERY MESSAGE (a review finding of #60): the check sat after the
// classifier in a Query and an Execute, none in a Parse or a Bind, and a catalog statement runs whole at its Bind, its
// rows returned by the Execute before the check. So inside a failed block `SELECT 1` and `current_setting` answered.
test("a failed block refuses a Parse, a Bind, an Execute and a Describe of a result, in both protocols, and accepts its end", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  // each message's own answer counts here: one refused and one answered with nothing are the point
  const own = (m: BackendMessage): string[] => ({ ParseComplete: ["parsed"], BindComplete: ["bound"], CloseComplete: ["closed"], NoData: ["no data"] } as Record<string, string[]>)[m.type] ?? replyLines([m]);
  const send = async (...frames: Buffer[]): Promise<string[]> => { s.socket.write(Buffer.concat([...frames, wire.sync()])); return (await s.untilReady()).flatMap(own); };
  const aborted = "ERROR 25P02 current transaction is aborted, commands ignored until end of transaction block";
  const refused = [aborted, "ready E"];
  const fail = async (): Promise<void> => { await q("BEGIN"); await q("SET application_name = 'a'"); await q("SELECT 1/0"); };
  const catalog = "SELECT current_setting('application_name')";
  const table = "SELECT id FROM public.orders LIMIT 1";
  try {
    for (const [name, sql] of [["cat", catalog], ["tab", table], ["sho", "SHOW application_name"], ["set", "SET application_name = 'b'"], ["end", "ROLLBACK"], ["com", "COMMIT"]] as const) await send(wire.parse(name, sql));
    await send(wire.parse("nothing", ""));
    await fail();
    // a Parse: what it holds is read, so a syntax error and two commands stay theirs, and a name taken is no matter
    assert.deepEqual(await send(wire.parse("new", "SELECT 1")), refused);
    assert.deepEqual(await send(wire.parse("cat", "SELECT 1")), refused, "25P02, not 42P05");
    assert.deepEqual(await send(wire.parse("new", "BEGIN")), refused);
    assert.deepEqual(await send(wire.parse("new", "SELEC 1")), ['ERROR 42601 syntax error at or near "SELEC"', "ready E"]);
    assert.deepEqual(await send(wire.parse("new", "SELECT 1; SELECT 2")), ["ERROR 42601 cannot insert multiple commands into a prepared statement", "ready E"]);
    assert.deepEqual(await send(wire.parse("new", "")), ["parsed", "ready E"], "an empty one holds no command");
    // a Bind: never run, the catalog's included
    for (const name of ["cat", "tab", "sho", "set", "new"]) assert.deepEqual(await send(wire.bind("", name, [], [])), refused, name);
    assert.deepEqual(await send(wire.bind("", "no_such", [], [])), ['ERROR 26000 prepared statement "no_such" does not exist', "ready E"]);
    // a Describe: of a result refused, of anything else answered, so a driver can still describe its ROLLBACK
    for (const name of ["cat", "tab", "sho"]) assert.deepEqual(await send(wire.describe("S", name)), refused, name);
    assert.deepEqual(await send(wire.describe("S", "set")), ["no data", "ready E"]);
    assert.deepEqual(await send(wire.describe("S", "end")), ["no data", "ready E"]);
    // a batch stops at the first refusal, the ROLLBACK in it included; a Close always runs
    const batch = inBatch(s);
    assert.deepEqual(await batch(catalog), refused);
    assert.deepEqual(await batch("SELECT 1", "ROLLBACK"), refused, "skipped to the Sync");
    assert.deepEqual(await batch(table), refused);
    assert.deepEqual(await send(wire.close("S", "new")), ["closed", "ready E"]);
    // a Query: 25P02 before the statement is classified, so before Mason's own refusal of it
    for (const sql of ["SELECT 1", catalog, table, "BEGIN", "INSERT INTO public.orders (id) VALUES (9)", "SAVEPOINT s", "EXPLAIN SELECT 1", "SELECT set_config('application_name', 'b', true), 1"]) assert.deepEqual(await q(sql), refused, sql);
    assert.deepEqual(await q("SELECT 1; ROLLBACK"), refused, "the Query stops at the first");
    // its end, by a statement prepared before the failure
    assert.deepEqual(await send(wire.bind("", "end", [], []), wire.execute("")), ["bound", "tag ROLLBACK", "ready I"]);
    assert.deepEqual(await q("SHOW application_name"), ["row start", "tag SHOW", "ready I"]);
    await fail();
    assert.deepEqual(await batch("COMMIT", "SHOW application_name"), ["tag ROLLBACK", "row start", "tag SHOW", "ready I"], "a ROLLBACK's tag, and the block over within the batch");

    // a portal bound before the failure: neither its rows nor its description, the catalog's held since its Bind
    await q("BEGIN");
    await send(wire.bind("c", "cat", [], []));
    await send(wire.bind("t", "tab", [], []));
    await q("SELECT 1/0");
    for (const portal of ["c", "t"]) {
      assert.deepEqual(await send(wire.execute(portal)), refused, portal);
      assert.deepEqual(await send(wire.describe("P", portal)), refused, portal);
    }
    assert.deepEqual(await send(wire.execute("no_such")), ['ERROR 34000 portal "no_such" does not exist', "ready E"]);
    await q("ROLLBACK");
  } finally { s.end(); }
});

test("a prepared statement reads the setting in force when it runs: a reverted one stays neither in its plan nor in its answer", async () => {
  const s = await rawSession(api.port, { application_name: "start" });
  const q = onRaw(s);
  const statement = "SELECT created_at, date_trunc('day', created_at), current_setting('TimeZone'), current_setting('application_name') FROM public.orders WHERE id = 1";
  const parse = (name: string): void => { s.socket.write(Buffer.concat([wire.parse(name, statement), wire.sync()])); };
  const run = async (name: string): Promise<string[]> => {
    s.socket.write(Buffer.concat([wire.bind("", name, [], []), wire.execute(""), wire.sync()]));
    return replyLines(await s.untilReady());
  };
  const utc = ["row 2026-01-02 03:04:05+00,2026-01-02 00:00:00+00,UTC,start", "tag SELECT 1"];
  const tokyo = (app: string): string[] => [`row 2026-01-02 12:04:05+09,2026-01-02 00:00:00+09,Asia/Tokyo,${app}`, "tag SELECT 1"];
  try {
    parse("before");
    await s.untilReady();
    assert.deepEqual(await run("before"), [...utc, "ready I"]);
    await q("BEGIN");
    await q("SET LOCAL TimeZone = 'Asia/Tokyo'");
    await q("SET LOCAL application_name = 'loc'");
    assert.deepEqual(await run("before"), [...tokyo("loc"), "ready T"]);
    await q("COMMIT");
    assert.deepEqual(await run("before"), [...utc, "ready I"], "after a COMMIT");
    await q("BEGIN");
    await q("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual(await run("before"), [...tokyo("start"), "ready T"]);
    await q("ROLLBACK");
    assert.deepEqual(await run("before"), [...utc, "ready I"], "after a ROLLBACK");
    await q("BEGIN");
    await q("SET TimeZone = 'Asia/Tokyo'");
    await q("SELECT 1/0");
    await q("ROLLBACK");
    assert.deepEqual(await run("before"), [...utc, "ready I"], "after a failed block");
    // made under the setting, run after it
    await q("BEGIN");
    await q("SET LOCAL TimeZone = 'Asia/Tokyo'");
    parse("under");
    await s.untilReady();
    assert.deepEqual(await run("under"), [...tokyo("start"), "ready T"]);
    await q("COMMIT");
    assert.deepEqual(await run("under"), [...utc, "ready I"], "parsed under a SET LOCAL");
    await q("BEGIN");
    await q("SET TimeZone = 'Asia/Tokyo'");
    parse("rolled");
    await s.untilReady();
    await q("ROLLBACK");
    assert.deepEqual(await run("rolled"), [...utc, "ready I"], "parsed under a SET rolled back");
  } finally { s.end(); }
});

// ONE PLACE PER NODE (src/duck/rewrite.ts `nodesPlacedTwice`, the walker's detector): the walker rewrites a node at its
// first place only, so a rule that puts one node in two places leaves the second as Postgres wrote it (the json read's
// column, qualified in the first arm of its CASE alone: a review finding). LAST in this file, so it holds every
// statement the tests above answered. (Imported here: the file loads at a commit without the detector.)
test("no rewrite of the statements above placed one of their nodes twice", async () => {
  const rewrite = await import("../src/duck/rewrite.ts") as { nodesPlacedTwice?: () => readonly string[] };
  assert.ok(rewrite.nodesPlacedTwice !== undefined, "the rewrite has no detector of a node placed twice");
  assert.deepEqual(rewrite.nodesPlacedTwice(), [], "a rule placed a node in two places: clone it per use (Rewriter.cp)");
});

// THE BYTES SENT, per statement (src/api/request-log.ts bytesSent): what the client read for it, every frame from its
// first to its CommandComplete or ErrorResponse — the ReadyForQuery after it is the protocol's, not the statement's
test("the request log's bytes are the bytes the client read for the statement: an answer's rows and its tag, a refusal's ErrorResponse, a 150,000-row stream", async () => {
  const s = await rawSession();
  try {
    const READY = 6;
    const asked = async (sql: string): Promise<{ read: number; row: ApiLogRow }> => {
      const from = recorded.length;
      s.socket.write(wire.query(sql));
      await s.untilReady();
      const row = recorded.slice(from).find((r) => r.session === s.pid);
      assert.ok(row !== undefined, `a row for ${sql}`);
      return { read: s.bytes - READY, row };
    };
    for (const sql of ["SELECT count(*) FROM big", "SELECT * FROM nope"]) {
      const { read, row } = await asked(sql);
      assert.equal(row.bytesSent, read, sql);
    }
    const wide = await asked("SELECT v || repeat('z', 200) AS bytes_wide FROM big");
    assert.equal(wide.row.bytesSent, wide.read);
    assert.ok(wide.read > 30_000_000, "the stream's 30 MB, counted whole");
  } finally { s.end(); }
});

// THE REQUEST LOG RECORDS WHICH ENTRY REFUSED A STATEMENT (ApiLogRow.gap, src/duck/gaps.ts): taken from the refusal as
// it was built (StatementError.gap), on each path a refusal takes — the rewrite's and the allowlist's at plan time, a
// view's from the plan of its expansion, a refusal raised inside DuckDB from the worker — and none for any other refusal
test("the request log records the registry entry that refused a statement, on every path a refusal takes; another refusal has none", async () => {
  const c = await client();
  try {
    const refusedBy = async (sql: string): Promise<{ code: string; gap: string | undefined }> => {
      const e = await c.query(sql).then(() => assert.fail(`${sql} was answered`), (x: pg.DatabaseError) => x);
      const rows = recorded.filter((r) => r.payload === sql);
      assert.equal(rows.length, 1, `one row for ${sql}`);
      assert.equal(rows[0]!.sqlstate, e.code);
      return { code: e.code!, gap: rows[0]!.gap };
    };
    assert.deepEqual(await refusedBy("SELECT degrees(qty) FROM orders WHERE id > -1"), { code: "0A000", gap: "unverified" }, "the allowlist's");
    assert.deepEqual(await refusedBy("SELECT paid_orders FROM paid_orders WHERE true"), { code: "0A000", gap: "view-forms" }, "a view's, from the plan of what it expands to");
    assert.deepEqual(await refusedBy("SELECT json_agg(DISTINCT id) FROM orders"), { code: "0A000", gap: "json-agg-distinct" }, "the rewrite's");
    assert.deepEqual(await refusedBy("EXPLAIN (FORMAT XML) SELECT id FROM orders WHERE id > -2"), { code: "0A000", gap: "explain-option" }, "the translation's");
    assert.deepEqual(await refusedBy("SELECT width_bucket(qty, 10, 0, 5) FROM orders"), { code: "0A000", gap: "width-bucket-forms" }, "raised by DuckDB, as its text alone");
    await c.query("SET TimeZone = 'Europe/Rome'");
    assert.deepEqual(await refusedBy("SELECT timestamptz '0044-03-15 12:00:00+00 BC' FROM orders WHERE id = 2"), { code: "0A000", gap: "bc-timestamptz-zone" },
      "raised inside DuckDB, across the executor's worker");
    assert.deepEqual(await refusedBy("SELECT * FROM nope_gapless"), { code: "42P01", gap: undefined }, "a missing table is no entry's");
    assert.deepEqual(await refusedBy("SELEC 1 gapless"), { code: "42601", gap: undefined }, "nor a syntax error");
  } finally { await c.end(); }
});

// A PAGED PORTAL'S BYTES ARE ITS OWN (src/api/postgres/server.ts `bytesFor`, `Portal.bytes`): its pages and its tag,
// however many statements ran between two of its Executes — it was counted as the session's bytes since its first
// Execute, so a portal paged around another statement counted that statement's bytes twice (a review finding)
test("a paged portal's bytes are its own Executes' frames, never those of a statement run between two of them", async () => {
  const s = await rawSession();
  try {
    const READY = 6;
    const PARSE_BIND = 5 + 5;
    s.socket.write(wire.query("BEGIN"));
    await s.untilReady();
    const from = recorded.length;
    // portal a: two rows of five, suspended
    s.socket.write(Buffer.concat([wire.parse("a", "SELECT v FROM big WHERE id < 5"), wire.bind("pa", "a", [], []), wire.execute("pa", 2), wire.sync()]));
    const first = await s.untilReady();
    assert.ok(first.some((m) => m.type === "PortalSuspended"), JSON.stringify(first.map((m) => m.type)));
    let a = s.bytes - READY - PARSE_BIND;
    // portal b, run whole between two Executes of a
    s.socket.write(Buffer.concat([wire.parse("b", "SELECT v || repeat('z', 100) AS w FROM big WHERE id < 50"), wire.bind("pb", "b", [], []), wire.execute("pb", 0), wire.sync()]));
    await s.untilReady();
    const b = s.bytes - READY - PARSE_BIND;
    // the rest of a
    s.socket.write(Buffer.concat([wire.execute("pa", 0), wire.sync()]));
    const rest = await s.untilReady();
    assert.equal(dataRows(rest).length, 3);
    a += s.bytes - READY;
    const rows = recorded.slice(from).filter((r) => r.session === s.pid);
    assert.deepEqual(rows.map((r) => [r.rows, r.bytesSent]), [[50, b], [5, a]], "b's bytes are b's alone, a's its two Executes'");
    s.socket.write(wire.query("COMMIT"));
    await s.untilReady();
  } finally { s.end(); }
});

// THE SESSIONS LOGGED IN NOW (`openSessions`, `/api/state` `sessions`): from the listener's sessions in memory, by user
// and client, with how many run a statement
test("the sessions logged in now, by user and client, and how many of each run a statement; a closed one is gone", async () => {
  const has = (api as unknown as { openSessions?: unknown }).openSessions;
  assert.equal(typeof has, "function", "src/api/postgres/server.ts PgApiServer.openSessions");
  // other tests' sessions may still be closing: these are told apart by their application_name
  const a = await rawSession(), b = await rawSession(), c = await rawSession();
  try {
    for (const [x, name] of [[a, "obs-two"], [b, "obs-two"], [c, "obs-one"]] as const) { x.socket.write(wire.query(`SET application_name = '${name}'`)); await x.untilReady(); }
    const group = (client: string): unknown => api.openSessions().byClient.find((g) => g.client === client);
    const open = api.openSessions();
    assert.ok(open.open >= 3 && open.open === open.byClient.reduce((n, g) => n + g.open, 0), JSON.stringify(open));
    assert.deepEqual(group("obs-two"), { user: "", client: "obs-two", open: 2, running: 0 }, "a token's sessions: no user");
    assert.deepEqual(group("obs-one"), { user: "", client: "obs-one", open: 1, running: 0 });
    a.socket.write(wire.query(SLOW));
    for (const deadline = Date.now() + 10_000; (group("obs-two") as { running: number } | undefined)?.running !== 1;) {
      if (Date.now() > deadline) throw new Error("the statement never showed as running");
      await sleep(20);
    }
    api.cancel(a.pid);
    await a.untilReady();
    c.end();
    for (const deadline = Date.now() + 5_000; group("obs-one") !== undefined;) {
      if (Date.now() > deadline) throw new Error(`a closed session is still counted: ${JSON.stringify(api.openSessions())}`);
      await sleep(20);
    }
  } finally { a.end(); b.end(); c.end(); }
});

// A CANCEL ON A SHARE'S SOCKET (mason share): a public socket, whose CancelRequest arrives in clear, reaches its own sessions alone
test("a CancelRequest on a share's socket does not reach a session of the run's own listener: the statement goes on, and the key on its own socket stops it", async () => {
  const { selfSignedCertificate } = await import("../src/cli/self-signed-cert.ts");
  const pair = selfSignedCertificate("mason-share-cancel");
  const share = await api.openShare({ tls: { cert: Buffer.from(pair.cert), key: Buffer.from(pair.key) }, authenticate: () => ({}), recheck: async () => undefined, loginHint: "" });
  const s = await rawSession();
  const send = async (port: number): Promise<void> => {
    const c = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => c.once("connect", () => r()));
    c.end(wire.cancelRequest(s.pid, s.secret));
    await new Promise<void>((r) => c.once("close", () => r()));
  };
  try {
    s.socket.write(wire.query(SLOW));
    for (const deadline = Date.now() + 10_000; api.running().every((r) => r.session !== s.pid); await sleep(20)) if (Date.now() > deadline) throw new Error("the statement never showed as running");
    await send(share.port);
    await sleep(200);
    assert.ok(api.running().some((r) => r.session === s.pid), "the share's socket cancelled a session of the run's own listener");
    await send(api.port);
    const error = (await s.untilReady()).find((m) => m.type === "ErrorResponse") as Extract<BackendMessage, { type: "ErrorResponse" }> | undefined;
    assert.equal(error?.fields.C, "57014");
  } finally { s.end(); await share.close(); }
});

// THE STATEMENTS RUNNING NOW, AND A CANCEL BY SESSION (`/api/running`, `POST /api/cancel`): the listener's own, and the
// cancel is the CancelRequest's path — the client told 57014 "due to user request", recorded cancelled, the session on
test("the statements running now, by session; a cancel by session stops one as a CancelRequest does, and says when there is nothing to stop", async () => {
  const s = await rawSession();
  try {
    assert.deepEqual(api.running().filter((r) => r.session === s.pid), [], "an idle session runs nothing");
    const from = recorded.length;
    const t0 = Date.now();
    s.socket.write(wire.query(SLOW));
    let running = api.running().find((r) => r.session === s.pid);
    for (const deadline = Date.now() + 10_000; running === undefined; running = api.running().find((r) => r.session === s.pid)) {
      if (Date.now() > deadline) throw new Error("the statement never showed as running");
      await sleep(20);
    }
    assert.deepEqual({ ...running, statement: 0, startedAt: "", runningMs: 0 }, { session: s.pid, statement: 0, user: "", applicationName: "", method: "QUERY", startedAt: "", runningMs: 0, rows: 0,
      query: SLOW, queryTruncated: false });
    assert.ok(Date.parse(running.startedAt) >= t0 - 5 && running.runningMs >= 0);
    assert.ok(Number.isInteger(running.statement) && running.statement >= 1, JSON.stringify(running));
    assert.equal(api.running().find((r) => r.session === s.pid)?.statement, running.statement, "one statement, one number however often it is listed");
    // a cancel naming ANOTHER statement (the one listed ended, and the session began this one): nothing is cancelled
    const other = api.cancel(s.pid, running.statement + 1000);
    assert.ok("other" in other && other.other.statement === running.statement && other.asked === running.statement + 1000, JSON.stringify(other));
    assert.ok(api.running().some((r) => r.session === s.pid), "still running");
    const answer = api.cancel(s.pid, running.statement);
    assert.ok("cancelled" in answer && answer.cancelled.session === s.pid && answer.cancelled.query === SLOW, JSON.stringify(answer));
    const ms = await s.untilReady();
    const error = ms.find((m) => m.type === "ErrorResponse") as Extract<BackendMessage, { type: "ErrorResponse" }> | undefined;
    assert.deepEqual([error?.fields.C, error?.fields.M], ["57014", "canceling statement due to user request"]);
    assert.ok(Date.now() - t0 < 10_000, `stopped after ${Date.now() - t0} ms`);
    const row = recorded.slice(from).find((r) => r.session === s.pid);
    assert.equal(row?.sqlstate, "57014", "recorded, as cancelled");
    assert.ok(logged.some((l) => l === `[postgres] session ${s.pid}: its statement cancelled by mason cancel`), "the log says who cancelled it");
    assert.ok(logged.some((l) => l.startsWith(`[postgres] session ${s.pid} cancelled: 57014 canceling statement due to user request — ${SLOW}`)), "its refusal line says cancelled");
    assert.deepEqual(api.cancel(s.pid), { idle: s.pid }, "nothing running: nothing cancelled");
    assert.deepEqual(api.cancel(s.pid, running.statement), { idle: s.pid }, "its statement ended: nothing to cancel");
    assert.deepEqual(api.cancel(999_999), { unknown: 999_999 });
    s.socket.write(wire.query("SELECT count(*) FROM big"));
    assert.equal(String(dataRows(await s.untilReady())[0]!.values[0]), "150000", "the session goes on");
    // the next statement of the session is another number: a cancel of the first one never stops it
    s.socket.write(wire.query(SLOW));
    let next = api.running().find((r) => r.session === s.pid);
    for (const deadline = Date.now() + 10_000; next === undefined; next = api.running().find((r) => r.session === s.pid)) {
      if (Date.now() > deadline) throw new Error("the second statement never showed as running");
      await sleep(20);
    }
    assert.notEqual(next.statement, running.statement);
    assert.ok("other" in api.cancel(s.pid, running.statement), "the first statement's cancel does not stop the second");
    assert.ok("cancelled" in api.cancel(s.pid));
    await s.untilReady();
  } finally { s.end(); }
});

// THE GROUPED COLLATED INNER ORDER under a libc database (PR 170's oracle statements "a bound key: a collated output
// grouped and ordered by …", mirrored): the keys bound to the output, by number, name or expression, sort by its ICU
// collation (a space counts: ' alpha' before '10'), never the database's. A last key that is no output keeps the
// oracle from re-sorting the derived column outside, which is #213's
test("a grouped collated output ordered by number, name or expression is its collation's order on a libc database", async () => {
  const libc = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: (l) => (logged.push(l), everLogged.push(l)),
    duck: await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, undefined,
      handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({})], [" "], { collate: "en_US.utf8" }), () => copies),
  });
  const c = new pg.Client({ host: "127.0.0.1", port: libc.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  try {
    for (const sql of [
      "SELECT a.team COLLATE \"und-x-icu\" AS n, count(*) AS k FROM accounts a GROUP BY 1 ORDER BY 1, min(a.id) LIMIT 8",
      "SELECT a.team COLLATE \"und-x-icu\" AS n, count(*) AS k FROM accounts a GROUP BY 1 ORDER BY 1 DESC, min(a.id) LIMIT 8",
      "SELECT a.team COLLATE \"und-x-icu\" AS n, count(*) AS k FROM accounts a GROUP BY n ORDER BY a.team COLLATE \"und-x-icu\", n, min(a.id) LIMIT 8",
      "SELECT a.team COLLATE \"und-x-icu\" AS n, count(*) AS k FROM accounts a GROUP BY n ORDER BY n DESC, min(a.id) LIMIT 8",
    ]) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
  } finally { await c.end(); await libc.close(); }
});

// review round 14 of PR 202: the plan of every wire statement computed the generated planner's followed outputs, a walk
// that copied a column's followed expression into each reference to it, so a statement whose levels each read the level
// below more than once grew 3^depth (depth 12 took 880 ms, 16 about 70 s) on the planning thread every session waits
// on, whatever the column's type. The class: work on the wire's path for a reader only another path has, with no bound
// on its size. The decision: the wire never computes what only a generated table reads, and the walk is linear in the
// analysed tree. (An int8 and a float8, which carry no program: a numeric's chains are "issue 244" below, #483 and #484)
test("round 14: a wire statement's plan computes no generated table's outputs, and a deep statement is planned within the bound", async () => {
  const catalogDb = new PGlite();
  try {
    for (const s of catalogDdl({ database: "app", tables: [] })) await catalogDb.exec(s);
    const catalog = (b: Uint8Array): Promise<Uint8Array> => catalogDb.execProtocolRaw(b);
    const plan = async (sql: string) => planDuck({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Parameters<typeof planDuck>[0]["stmt"],
      base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collations: CollationResolver.of({ kind: "bytes" }), verified: null });
    // a first plan pays the catalog's and the parser's start: untimed
    await plan("SELECT 1::numeric AS a");
    for (const bottom of ["1::int8", "1::float8"]) for (const depth of DEEP_DEPTHS) for (const [shape, sql] of Object.entries(deepChains(bottom, depth))) {
      const started = performance.now();
      const planned = await plan(sql);
      const ms = performance.now() - started;
      assert.equal(planned.outputs, undefined, `${shape} over ${bottom}: the wire's plan holds the generated planner's outputs`);
      assert.ok(ms < 500, `${shape} over ${bottom}: planned in ${ms.toFixed(0)} ms at depth ${depth}`);
    }
  } finally { await catalogDb.close(); }
});

/** each hazard-a and NATURAL statement's outcome, as main's (checked by scripts/duck-repro.ts at the base and the head) */
const NATURAL_244 = "refused 0A000: a JOIN … USING or a NATURAL JOIN on a numeric the engine holds as a double";
const EXPECTED_244: Record<string, string> = { 0: "as Postgres: 42804", 1: "as Postgres: 42804", 2: "as Postgres: 42804", 3: "answered", 4: NATURAL_244, 5: NATURAL_244 };

// ISSUE 244, piece 1 (#483): the exact-numeric decisions about a FROM item's column were taken again at every
// REFERENCE to it, so `a + a + a` over the level below asked that level three times a level (3^depth: 1::numeric nested
// 768 ms at depth 8 and 99 s at 12 on main, the WITH chain 3.4 s at 8), on the planning thread every session waits on.
// The class: a fact derived again at every reference. The decision: each is taken once per (query, output index)
// (`decided`, src/duck/rewrite.ts), copied with its query, never recorded from inside an open recursive cycle or from
// the walk's guard, and dropped when a `*` is written out in place. The UNION ALL chain, whose PROGRAM was copied into
// each reference (3^depth: 62 ms at depth 8 on main, a record of 360 KB), is in since #484, which shares it ("issue 484")
test("issue 244: a numeric read three times a level through every level is planned within the bound, and answered as Postgres", async () => {
  const catalogDb = new PGlite();
  try {
    for (const s of catalogDdl({ database: "app", tables: [] })) await catalogDb.exec(s);
    const catalog = (b: Uint8Array): Promise<Uint8Array> => catalogDb.execProtocolRaw(b);
    const plan = async (sql: string) => planDuck({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Parameters<typeof planDuck>[0]["stmt"],
      base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collations: CollationResolver.of({ kind: "bytes" }), verified: null });
    // a first plan pays the catalog's and the parser's start: untimed
    await plan("SELECT 1::numeric AS a");
    for (const depth of DEEP_DEPTHS) for (const shape of ["nested", "with", "union"] as const) {
      const sql = deepChains("1::numeric", depth)[shape]!, started = performance.now();
      await plan(sql);
      const ms = performance.now() - started;
      assert.ok(ms < 500, `${shape} over 1::numeric: planned in ${ms.toFixed(0)} ms at depth ${depth}`);
    }
  } finally { await catalogDb.close(); }
  const c = await client();
  const level = (bottom: string, each: string, depth: number, alias = "s"): string => {
    let s = bottom;
    for (let i = 1; i <= depth; i++) s = `SELECT ${each} FROM (${s}) ${alias}${i}`;
    return s;
  };
  try {
    // a value the engine holds exactly, carried or read through every level, keeps its native plan
    for (const sql of [`${level("SELECT o.amount AS c FROM orders o", "c", 4)} ORDER BY 1`, `${level("SELECT o.amount AS c FROM orders o", "c + 1 AS c", 3)} ORDER BY 1`]) {
      const explained = (await c.query(`EXPLAIN (VERBOSE) ${sql}`)).rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
      assert.doesNotMatch(explained, /__mason_numeric_(order|program|int|double|key)/, sql);
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    const quotient = "SELECT b.x / 1 AS q FROM bigdec b";
    const t = ["t0 AS (SELECT b.x / 1 AS a FROM bigdec b)", ...[1, 2, 3, 4].map((i) => `t${i} AS (SELECT a + a + a AS a FROM t${i - 1})`)];
    assert.deepEqual(await unlike(c, [
      // the depth-4 chains, over values two doubles tie
      [`${level("SELECT b.x / 1 AS a FROM bigdec b", "a + a + a AS a", 4)} ORDER BY 1`, "ordered"],
      [`WITH ${t.join(", ")} SELECT a, a::text FROM t4 ORDER BY 1`, "ordered"],
      [`SELECT DISTINCT q FROM (${level(quotient, "q + 1 AS q", 3)}) s4 ORDER BY 1`, "ordered"],
      // the rewrite's shapes over a quotient carried two levels down: grouped, by name and by number; the nulls idiom
      [`SELECT s2.q, count(*) FROM (${level(quotient, "q + 1 AS q", 1)}) s2 GROUP BY s2.q ORDER BY 1`, "ordered"],
      [`SELECT s2.q, count(*) FROM (${level(quotient, "q + 1 AS q", 1)}) s2 GROUP BY s2.q ORDER BY q`, "ordered"],
      [`SELECT s2.q, count(*) FROM (${level(quotient, "q + 1 AS q", 1)}) s2 GROUP BY s2.q ORDER BY s2.q`, "ordered"],
      [`${level("SELECT NULLIF(b.x, 2.5) / 1 AS q FROM bigdec b", "q + 1 AS q", 2)} ORDER BY q IS NULL, q`, "ordered"],
      [`${level("SELECT NULLIF(b.x, 2.5) / 1 AS q FROM bigdec b", "q + 1 AS q", 2)} ORDER BY 1 NULLS FIRST`, "ordered"],
      // a `*` beside a named column, and written out (hazard b: a decision read after its list was rewritten in place)
      [`SELECT *, q FROM (SELECT q + 1 AS q, id FROM (SELECT b.x / 1 AS q, b.id FROM bigdec b) s1) s2 ORDER BY 2, 1`, "ordered"],
      [`SELECT * FROM (${level(quotient, "q", 1)}) s2 ORDER BY 1`, "ordered"],
      [`SELECT s2.*, 1 AS one FROM (${level(quotient, "q + 1 AS q", 1)}) s2 ORDER BY 1`, "ordered"],
      // an arm exactArms wraps, read through levels; a UNION ALL's scales through levels; a widened reader
      [`SELECT q + 1 AS q FROM (SELECT q FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL VALUES (1.5)) s1) s2 ORDER BY 1`, "ordered"],
      [`SELECT q, q::text FROM (SELECT q FROM (SELECT b.x AS q FROM bigdec b UNION ALL SELECT b.id FROM bigdec b) s1) s2 ORDER BY 1, 2`, "ordered"],
      [`SELECT q + 1.5::float8 AS f, q FROM (${level(quotient, "q", 1)}) s2 ORDER BY 2`, "ordered"],
      // exactArms' trial copies and its real pass read one decision; a WITH query read in both arms after a level
      [`SELECT q FROM (${level(quotient, "q + 1 AS q", 1)}) s2 UNION ALL SELECT q FROM (${level("SELECT b.x / 7 AS q FROM bigdec b", "q + 1 AS q", 1, "t")}) t2 ORDER BY 1`, "ordered"],
      [`WITH w AS (SELECT q + 1 AS q FROM (${quotient}) s) SELECT q FROM w UNION ALL SELECT q + 1 FROM w ORDER BY 1`, "ordered"],
      // hazard c: an ORDER BY 1 of a `*` written out at the walk (issue 252's case) reads what was decided before it
      [`SELECT * FROM (${level(quotient, "q + 1 AS q", 1)}) s2 UNION ALL SELECT b.x FROM bigdec b ORDER BY 1`, "ordered"],
      // (no collation applies: the column is a numeric)
    ]), []);
    // a parameter at a level, executed again after a later SET
    const prepared = { name: "issue244", text: `SELECT q + $1 AS q FROM (${level(quotient, "q", 1)}) s2 ORDER BY 1`, values: ["0.5"], rowMode: "array", types: raw } as pg.QueryConfig;
    const want = (await postgres(prepared.text, ["0.5"])).rows;
    assert.deepEqual((await c.query(prepared)).rows, want);
    await c.query("SET TimeZone = 'Asia/Kolkata'");
    assert.deepEqual((await c.query(prepared)).rows, want);
    // HAZARD A, a recursive WITH's column decided inside its cycle and read outside it, and a NATURAL JOIN written as
    // USING over a level: each answered as Postgres, or refused by its name, exactly as main (scripts/duck-repro.ts at
    // the base and the head). (A quotient its recursive arm computes, read through a subquery, is answered with the
    // engine's digits on main and here alike: issue 497, left out)
    const recursive = "WITH RECURSIVE r(x, n) AS (SELECT b.x, 1 FROM bigdec b UNION ALL SELECT r.x / 1, r.n + 1 FROM r WHERE r.n < 2)";
    const outcome = async (sql: string): Promise<string> => {
      const failed = (e: { code: string; message: string }): string => `${e.code}: ${e.message}`;
      const [got, want] = [await answer(c, sql).catch(failed), await postgres(sql).catch(failed)];
      if (typeof got !== "string") return util.isDeepStrictEqual(got, want) ? "answered" : `differs: ${JSON.stringify(got.rows).slice(0, 200)}`;
      return typeof want === "string" && want.slice(0, 5) === got.slice(0, 5) ? `as Postgres: ${got.slice(0, 5)}` : `refused ${got.slice(0, 81)}`;
    };
    const natural = (q: string, u: string): string => `SELECT count(*) FROM (SELECT q + 1 AS q FROM (SELECT ${q} AS q FROM bigdec b) s1) s NATURAL JOIN (SELECT q FROM (SELECT ${u} AS q FROM bigdec b) u1) u`;
    const outcomes: Record<string, string> = {};
    for (const [i, sql] of [
      `${recursive} SELECT x, x::text, n FROM r ORDER BY 3, 1`,
      `${recursive} SELECT DISTINCT x FROM r ORDER BY 1`,
      `${recursive} SELECT count(*) FROM r WHERE r.x = 1.00000000000000000001`,
      // the sixth round's way out, answered
      "WITH RECURSIVE r(x, n) AS (SELECT b.x, 1 FROM bigdec b UNION ALL SELECT r.x, r.n + 1 FROM r WHERE r.n < 2) SELECT count(*) FROM r WHERE r.x / 1 = 1.00000000000000000001",
      natural("round(b.x / 1, 2)", "round(b.x / 1, 2) + 1"),
      natural("b.x / 1", "b.x / 1 + 1"),
    ].entries()) outcomes[String(i)] = await outcome(sql);
    assert.deepEqual(outcomes, EXPECTED_244);
  } finally { await c.end(); }
});

// ISSUE 244, piece 2 (#484): a carried column's exact-numeric PROGRAM was copied into each reference to it, so a level
// reading the column below k times held k copies of the level below's: k^depth nodes, whatever piece 1 memoised. On
// main #344's statement (every level bounded, over a quotient) sent 1.5 MB at depth 8, the mixed-scale union chain 3.6
// MB, its depth 10 failed to deparse (the program's literal's size: the rewritten tree's depth is two parentheses a
// level at main and here alike) and its depth 32 ran out of memory. The class: a value copied where it is shared. The
// decision: a program read by several references is ONE node they share (`carried`, src/duck/rewrite.ts), and every
// reader is linear in its distinct nodes (src/lib/pg-numeric.ts: the one text, evaluation once a node a row, lazy).
// Executed at depth 32 over `deep_t`, each held to Postgres's answer of the equivalent shallow statement (Postgres is
// never asked the deep one: its own pull-up grows 3^depth), within a bound named from the integer forms' time; at depth
// 4 each held to Postgres directly; and every reader of a shared program over values two doubles tie.
test("issue 484: a numeric's program shared by its references is executed at depth 32 within the bound, and read as Postgres reads it", async (t) => {
  const c = await client();
  const over = (sql: string): string => sql.replace(/\bFROM t\b/g, "FROM deep_t");
  const shapes = (depth: number) => {
    const s = numericShapes(depth);
    return { "c + c - c": s["c + c - c"], "q + q - q": s["q + q - q"], "344": s["344"], "mixed-scale union, nested": s["mixed-scale union, nested"], "mixed-scale union, a chain": s["mixed-scale union, a chain"] };
  };
  try {
    // THE BOUND: the integer forms of `deepShapes` at depth 32 executed here (the review's deep variant form, which no
    // program reads), and the numeric ones within max(2 x the shape's planning-time bound, 2 x the slower integer form's
    // time): `planTimeBound`, its cost curve's, since an answer's time includes its plan's (issue 569). Each
    // statement once, so none is answered from what an earlier one left; the session and the table warmed first
    await answer(c, "SELECT count(*) FROM deep_t");
    const integer = deepShapes(32);
    let integerMs = 0;
    for (const shape of ["order by and limit", "union, a bound at every level"]) {
      const started = performance.now();
      await answer(c, over(integer[shape]!));
      const ms = performance.now() - started;
      t.diagnostic(`${shape} (integers) at depth 32: ${ms.toFixed(0)} ms`);
      integerMs = Math.max(integerMs, ms);
    }
    const boundOf = (shape: string): number => Math.max(2 * planTimeBound(shape), 2 * integerMs);
    const arm = "SELECT a, d FROM deep_t";
    const shallow = (depth: number): Record<keyof ReturnType<typeof shapes>, string> => ({
      "c + c - c": "SELECT c FROM deep_t ORDER BY 1",
      "q + q - q": "SELECT c / 3 AS q FROM deep_t ORDER BY 1",
      "344": "SELECT c / 3 AS a, b FROM deep_t ORDER BY a, b LIMIT 100",
      "mixed-scale union, nested": `SELECT a, b FROM (SELECT c / 3 AS a, b FROM deep_t UNION ALL ${arm}) s ORDER BY a, b LIMIT 100`,
      "mixed-scale union, a chain": `SELECT a, b FROM (SELECT c / 3 AS a, b FROM deep_t${` UNION ALL ${arm}`.repeat(depth)}) s ORDER BY a, b LIMIT 100`,
    });
    // climbing, so a walk that grows with the expansion fails the bound by name at 12 (main: seconds, or a statement it
    // cannot write) instead of running out of memory at 32
    for (const depth of [12, 32]) for (const [shape, sql] of Object.entries(shapes(depth)) as Array<[keyof ReturnType<typeof shapes>, string]>) {
      const started = performance.now();
      const got = await answer(c, over(sql));
      const ms = performance.now() - started;
      t.diagnostic(`${shape} at depth ${depth}: ${ms.toFixed(0)} ms (bound ${boundOf(shape).toFixed(0)} ms, the integer forms ${integerMs.toFixed(0)} ms)`);
      assert.ok(ms < boundOf(shape), `${shape}: answered in ${ms.toFixed(0)} ms at depth ${depth}, past the bound of ${boundOf(shape).toFixed(0)} ms (the integer forms ${integerMs.toFixed(0)} ms)`);
      assert.deepEqual(got, await postgres(shallow(depth)[shape]), `${shape} at depth ${depth}`);
    }
    // depth 4: Postgres answers each itself
    assert.deepEqual(await unlike(c, Object.values(shapes(4)).map((sql) => [over(sql), "ordered"] as const)), []);
    // THE READERS of a shared program: three levels of `q + q - q` over values two doubles tie, each reader of it
    const level = (bottom: string, depth: number): string => {
      let s = bottom;
      for (let i = 1; i <= depth; i++) s = `SELECT q + q - q AS q, id FROM (${s}) s${i}`;
      return s;
    };
    const s3 = `(${level("SELECT b.x / 1 AS q, b.id FROM bigdec b", 2)}) s3`;
    const nullable = `(${level("SELECT NULLIF(b.x, 2.5) / 1 AS q, b.id FROM bigdec b", 2)}) s3`;
    assert.deepEqual(await unlike(c, [
      [`${level("SELECT b.x / 1 AS q, b.id FROM bigdec b", 2)} ORDER BY 1, 2`, "ordered"],
      [`SELECT q, q::text, q::float8, q::int FROM ${s3} ORDER BY 1, 2`, "ordered"],
      [`SELECT DISTINCT q FROM ${s3} ORDER BY 1`, "ordered"],
      [`SELECT q, count(*) FROM ${s3} GROUP BY q ORDER BY 1`, "ordered"],
      [`SELECT q, count(*) FROM ${s3} GROUP BY q ORDER BY q`, "ordered"],
      [`SELECT q, count(*) FROM ${s3} GROUP BY q ORDER BY s3.q`, "ordered"],
      [`SELECT q, count(*) FROM ${s3} GROUP BY 1 ORDER BY 1`, "ordered"],
      [`SELECT q, count(*) FROM ${s3} GROUP BY 1 ORDER BY 2 DESC, 1 FETCH FIRST 1 ROWS WITH TIES`, "ordered"],
      [`SELECT DISTINCT ON (q) q, id FROM ${s3} ORDER BY q, id LIMIT 3`, "ordered"],
      [`SELECT sum(q), min(q), max(q), avg(q) FROM ${s3}`, "ordered"],
      [`SELECT q, rank() OVER (ORDER BY q), sum(q) OVER (ORDER BY id) FROM ${s3} ORDER BY id`, "ordered"],
      [`SELECT count(*) FROM ${s3} WHERE q = 1.00000000000000000001`, "ordered"],
      [`SELECT count(*) FROM ${s3} WHERE q <> 1.00000000000000000001`, "ordered"],
      [`SELECT count(*) FROM ${s3} WHERE q IN (1.00000000000000000001, 2.5)`, "ordered"],
      [`SELECT count(*) FROM ${s3} WHERE q = (SELECT max(q) FROM (${level("SELECT b.x / 1 AS q, b.id FROM bigdec b", 2)}) z)`, "ordered"],
      // the untaken arm of a shared program is never computed (Postgres raises 22012 only for a row that takes it)
      [`SELECT id, CASE WHEN id > 2 THEN q + q ELSE (q + q) / 0 END AS v FROM ${s3} WHERE id > 2 ORDER BY 1`, "ordered"],
      [`SELECT id, coalesce(q, q / 0) FROM ${s3} ORDER BY 1`, "ordered"],
      [`SELECT id, CASE WHEN id > 2 THEN q + q ELSE (q + q) / 0 END AS v FROM ${s3} ORDER BY 1`, "ordered"],
      // the nulls idiom, and NULLS FIRST over a NULL at the bottom
      [`SELECT q FROM ${s3} ORDER BY q IS NULL, q`, "ordered"],
      [`SELECT q FROM ${nullable} ORDER BY q IS NULL, q`, "ordered"],
      [`SELECT q FROM ${nullable} ORDER BY 1 NULLS FIRST`, "ordered"],
      // a `*` beside the shared column
      [`SELECT *, q FROM ${s3} ORDER BY 2, 1`, "ordered"],
      // exactArms over shared arms built apart: equal trees decide as main did; and scales that differ
      [`SELECT q FROM ${s3} UNION ALL SELECT q FROM (${level("SELECT b.x / 7 AS q, b.id FROM bigdec b", 2)}) t3 ORDER BY 1`, "ordered"],
      [`SELECT q FROM ${s3} UNION ALL SELECT q FROM (${level("SELECT b.x / 1 AS q, b.id FROM bigdec b", 2)}) t3 ORDER BY 1`, "ordered"],
      [`SELECT q FROM ${s3} UNION ALL SELECT b.x FROM bigdec b ORDER BY 1`, "ordered"],
      // a VALUES arm beside a shared program
      [`SELECT q FROM ${s3} UNION ALL VALUES (1.5) ORDER BY 1`, "ordered"],
    ]), []);
    // a parameter beside a shared program, executed again after a later SET
    const prepared = { name: "issue484", text: `SELECT q + q - $1 AS q FROM ${s3} ORDER BY 1`, values: ["0.5"], rowMode: "array", types: raw } as pg.QueryConfig;
    const want = (await postgres(prepared.text, ["0.5"])).rows;
    assert.deepEqual((await c.query(prepared)).rows, want);
    await c.query("SET TimeZone = 'Asia/Kolkata'");
    assert.deepEqual((await c.query(prepared)).rows, want);
  } finally { await c.end(); }
});

test("latest(x ORDER BY …) answers the x of the row its ORDER BY sorts last: arg_max_null over a row of keys when every key is ascending with NULLs last, last(x ORDER BY …) otherwise, refused without an ORDER BY", async () => {
  const c = await client();
  const sent = async (sql: string): Promise<string> => {
    logged.length = 0;
    await c.query(sql);
    return logged.findLast((l) => l.startsWith("statement: ")) ?? "";
  };
  // a key with NULLs (every 7th k) and ties (c groups 40 rows): each tie broken by id, as Postgres defines no pick
  const key = "nullif(k % 7, 0)";
  try {
    for (const [order, form] of [
      [`${key}, id`, /arg_max_null\(.*ROW\(/],
      [`${key} ASC NULLS LAST, id ASC`, /arg_max_null\(.*ROW\(/],
      // one key is a row too: a NULL key skipped by arg_max_null(x, k) sorts last in Postgres, and wins
      [key, /arg_max_null\(.*ROW\(/],
      [`${key} DESC, id`, /\blast\(.*ORDER BY .* DESC/],
      [`${key} NULLS FIRST, id`, /\blast\(.*ORDER BY .*NULLS FIRST/],
      [`${key} DESC NULLS LAST, id DESC`, /\blast\(.*ORDER BY .*NULLS LAST/],
      [`${key}, id DESC`, /\blast\(.*ORDER BY/],
    ] as const) {
      // under a single key the tied rows' pick is open: the statement asks for the key itself, which a tie does not change
      const value = order === key ? key : "id";
      for (const sql of [`SELECT c, latest(${value} ORDER BY ${order}) FROM late GROUP BY c ORDER BY c`,
        `SELECT c, latest(${value} ORDER BY ${order}) FILTER (WHERE id % 3 = 0) * 2 FROM late WHERE c < 5 GROUP BY c ORDER BY c`]) {
        assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
        assert.match(await sent(sql), form, sql);
      }
    }
    // no row: NULL; a numeric keeps its column's scale, read through coalesce
    for (const sql of ["SELECT latest(id ORDER BY k, id) FROM late WHERE false",
      "SELECT coalesce(latest(amount ORDER BY qty, id), 0), coalesce(latest(amount ORDER BY qty, id) FILTER (WHERE false), 0) FROM orders"]) {
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
    // refused, each with a way out answered above: no ORDER BY, a constant one, a window, a quotient
    for (const [sql, gap] of [["SELECT latest(id) FROM late", "latest-order"], ["SELECT latest(id ORDER BY 1) FROM late", "latest-order"],
      ["SELECT id, latest(id) OVER (ORDER BY id) FROM late ORDER BY id LIMIT 2", "latest-order"], ["SELECT latest(amount / 3 ORDER BY id) FROM orders", "latest-quotient"]]) {
      await assert.rejects(c.query(sql!), (e: pg.DatabaseError) => e.code === "0A000" && `${e.message} ${e.detail ?? ""}`.includes(gap!) && /latest\(.*ORDER BY/.test(e.hint ?? ""), sql);
    }
    // the engine's functions stay the engine's: a client naming one meets Postgres's 42883
    for (const sql of ["SELECT arg_max_null(id, k) FROM late", "SELECT last(id ORDER BY k) FROM late"]) {
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "42883", sql);
    }
  } finally { await c.end(); }
});

test("session state: a prepared statement whose search_path moved since its Parse is planned again, as Postgres's plancache; a result that moved is 0A000; a zone alone plans nothing again", async () => {
  const c = await client();
  try {
    const ids = async (q: { name: string; text: string }): Promise<number[]> => (await c.query(q)).rows.map((r: { id: number }) => r.id);
    const p = { name: "p63", text: "SELECT id, total FROM invoices ORDER BY id" };
    assert.deepEqual(await ids(p), [7]);
    await c.query("SET search_path = sales, public");
    assert.deepEqual(await ids(p), [1, 2], "the path moved: the statement reads sales.invoices");
    await c.query("RESET search_path");
    assert.deepEqual(await ids(p), [7]);
    // a zone alone: the same plan, the same rows
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual(await ids(p), [7]);
    await c.query("RESET TimeZone");
    // the path names no schema holding it: Postgres's 42P01, then the statement answers again once the path is back
    const n = { name: "n63", text: "SELECT count(*)::int AS id FROM invoices" };
    assert.deepEqual(await ids(n), [1]);
    await c.query("SET search_path = nowhere");
    assert.equal(((await c.query(n).catch((e: unknown) => e)) as { code?: string }).code, "42P01");
    await c.query("RESET search_path");
    assert.deepEqual(await ids(n), [1]);
    // another shape under the new path: Postgres's 0A000
    const a = { name: "a63", text: "SELECT * FROM accounts ORDER BY id" };
    assert.ok((await c.query(a)).rows.length > 0);
    await c.query("SET search_path = sales, public");
    const e = (await c.query(a).catch((x: unknown) => x)) as { code?: string; message?: string };
    assert.deepEqual([e.code, e.message], ["0A000", "cached plan must not change result type"]);
    // an unqualified name beside a qualified one
    await c.query("RESET search_path");
    const j = { name: "j63", text: "SELECT i.id FROM invoices i JOIN public.invoices o USING (id) ORDER BY 1" };
    assert.deepEqual(await ids(j), [7]);
    await c.query("SET search_path = sales, public");
    assert.deepEqual(await ids(j), [], "sales.invoices beside public.invoices share no id");
    await c.query("RESET search_path");
  } finally { await c.end(); }
});

// ISSUE 252, THE CLASS exact-numeric-leaves-exact-path: whether a numeric is exact, and at which scale, was decided by
// each READER of it, so each new reader lost Postgres's digits its own way. Each test below is one reader, over the
// synthetic tables, held to Postgres's answer.
const bound = (sql: string, params: string[]) => [sql, params] as const;
async function unlikeBound(c: pg.Client, statements: ReadonlyArray<readonly [string, readonly string[]]>): Promise<string[]> {
  const differ: string[] = [];
  for (const [sql, params] of statements) {
    const got = await answer(c, sql, [...params]).then((r) => r, (e: pg.DatabaseError) => `${e.code}: ${e.message}`);
    const want = await postgres(sql, [...params]).then((r) => r, (e: { code: string; message: string }) => `${e.code}: ${e.message}`);
    if (!util.isDeepStrictEqual(got, want)) differ.push(`${sql} ${JSON.stringify(params)}\n    mason:    ${JSON.stringify(got).slice(0, 300)}\n    postgres: ${JSON.stringify(want).slice(0, 300)}`);
  }
  return differ;
}

test("exact path: the ORDER reader sorts, ranks and ties a program by its exact value (issues 248, 218)", async () => {
  const c = await client();
  try {
    const sums = "(VALUES (1, 1::numeric, 2::numeric), (2, 3, 0), (3, 2.5, 0.5)) AS v(id, x, y)";
    assert.deepEqual(await unlike(c, [
      ["SELECT s.q FROM (SELECT b.x / 1 AS q FROM bigdec b) s ORDER BY 1 DESC", "ordered"],
      ["SELECT DISTINCT s.q FROM (SELECT b.x / 1 AS q FROM bigdec b) s ORDER BY 1 DESC", "ordered"],
      ["SELECT u.q FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT 0.0) u ORDER BY 1 DESC", "ordered"],
      ["SELECT u.q FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT 0.0) u GROUP BY 1 ORDER BY 1 DESC", "ordered"],
      ["WITH w AS (SELECT b.x / b.y AS q FROM bigdec b) SELECT q FROM w ORDER BY q DESC", "ordered"],
      ["SELECT b.id, b.x / b.y AS q FROM bigdec b ORDER BY q FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT b.id FROM bigdec b ORDER BY b.x / b.y DESC FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT b.id, rank() OVER (ORDER BY b.x / b.y) AS r FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id, dense_rank() OVER (ORDER BY b.x / 1 DESC) FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT max(s.q), min(s.q) FROM (SELECT b.x / 1 AS q FROM bigdec b WHERE b.id < 3) s", "ordered"],
      ["SELECT b.x / b.y AS q, count(*) FROM bigdec b GROUP BY 1 ORDER BY 1 DESC", "ordered"],
      ["SELECT b.x / b.y AS q FROM bigdec b GROUP BY b.x / b.y ORDER BY q DESC", "ordered"],
      ["SELECT b.x / b.y AS q FROM bigdec b GROUP BY b.x, b.y ORDER BY b.x / b.y DESC, b.x", "ordered"],
      ["SELECT u.q FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT NULL) u ORDER BY u.q IS NULL, u.q DESC", "ordered"],
      ["SELECT u.q FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT NULL) u ORDER BY 1 DESC NULLS LAST", "ordered"],
      ["SELECT *, b.x / b.y AS q FROM bigdec b ORDER BY q DESC, b.id", "ordered"],
      [`SELECT v.id, v.x / 10 + v.y / 10 AS s FROM ${sums} ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES`, "bag"],
      [`SELECT v.id, v.x / 10 + v.y / 10 AS s FROM ${sums} ORDER BY 2, 1 LIMIT 3`, "ordered"],
      [`SELECT d.id FROM (SELECT v.id, v.x / 10 + v.y / 10 AS s FROM ${sums}) d ORDER BY d.s, d.id OFFSET 1`, "ordered"],
    ]), []);
    assert.deepEqual(await unlikeBound(c, [bound(`SELECT v.id FROM ${sums} WHERE v.id > $1 ORDER BY v.x / 10 + v.y / 10, v.id`, ["0"])]), []);
  } finally { await c.end(); }
});

// PR 341 review r1, the class exact-key-built-outside-its-group: FETCH … WITH TIES built a grouped query's exact order
// key over the ungrouped column (42803, "must appear in the GROUP BY clause"), where the ORDER BY's rule reads it per
// group; every rule that keys a value now names the query it keys
test("exact path: FETCH … WITH TIES keys a grouped query's quotient per group, as its ORDER BY does", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY 1 ORDER BY 2 DESC, 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT b.x / 3 AS q, count(*) FROM bigdec b GROUP BY 1 ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT b.x / 3 AS q, b.y FROM bigdec b GROUP BY 1, 2 ORDER BY 1, 2 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT b.x / 3 AS q, count(*) FROM bigdec b WHERE false GROUP BY 1 ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY b.x / 1 ORDER BY b.x / 1 DESC FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY q ORDER BY q DESC FETCH FIRST 2 ROWS WITH TIES", "bag"],
      ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY 1 HAVING count(*) > 0 ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT b.x / 1 AS q, rank() OVER (ORDER BY b.x / 1 DESC) FROM bigdec b GROUP BY 1 ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES", "bag"],
      ["SELECT b.y, max(b.x / b.y) FROM bigdec b GROUP BY 1 ORDER BY 2 DESC FETCH FIRST 1 ROWS WITH TIES", "bag"],
      ["SELECT sum(b.x) / 3 AS q FROM bigdec b ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES", "bag"],
    ]), []);
  } finally { await c.end(); }
});

// ISSUE 665: a numeric quotient grouped by its exact key ALONE (one call a row), every reader of it — the list's value,
// its text, a cast, HAVING, the ORDER BY's exact key, a window, WITH TIES, a DISTINCT ON, the printed cells — computed
// per group over the group's columns (src/duck/rewrite.ts keyedGroups, `readPerGroup`): each answer as Postgres's
test("issue 665: a quotient grouped by its exact key alone is read per group by every reader, as Postgres answers", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      // Metabase's week of year and its numeric auto-bin, as it writes them, and the week by ordinal, by name, unordered
      ["SELECT ceil((CAST(extract(doy from o.created_at) AS integer) / 7.0)) AS created_at, count(*) AS count FROM orders o GROUP BY ceil((CAST(extract(doy from o.created_at) AS integer) / 7.0)) ORDER BY ceil((CAST(extract(doy from o.created_at) AS integer) / 7.0)) ASC", "ordered"],
      ["SELECT ceil(cast(extract(doy from o.created_at) as integer) / 7.0), count(*) FROM orders o GROUP BY 1 ORDER BY 1", "ordered"],
      ["SELECT ceil(cast(extract(doy from o.created_at) as integer) / 7.0) AS w, count(*) FROM orders o GROUP BY w ORDER BY w DESC LIMIT 2", "ordered"],
      ["SELECT ceil(cast(extract(doy from o.created_at) as integer) / 7.0) AS w, count(*) FROM orders o GROUP BY 1", "bag"],
      ["SELECT (floor(((o.amount - 0.0) / 12.5)) * 12.5 + 0.0) AS amount, count(*) AS count FROM orders o GROUP BY (floor(((o.amount - 0.0) / 12.5)) * 12.5 + 0.0) ORDER BY (floor(((o.amount - 0.0) / 12.5)) * 12.5 + 0.0) ASC", "ordered"],
      ["SELECT floor(p.u / 2.5) * 2.5 AS b, count(*), sum(p.w) FROM pnum p GROUP BY 1 ORDER BY 1 NULLS FIRST", "ordered"],
      ["SELECT floor(o.qty / 3.0) * 3.0 AS b, count(*) FROM orders o GROUP BY 1 ORDER BY 1", "ordered"],
      // a NULL group, and NULLs placed first
      ["SELECT d.c / 3 AS q, count(*) FROM deep_t d GROUP BY 1 ORDER BY 1 NULLS FIRST", "ordered"],
      // quotients equal to a double's 17 digits: two groups, printed, cast, read as text, ordered, by two columns' cells
      ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY 1 ORDER BY 1 DESC", "ordered"],
      ["SELECT (b.x / 1)::text AS t, (b.x / 1)::numeric(30,20) AS c, (b.x / 1)::float8 AS f, count(*) FROM bigdec b GROUP BY b.x / 1 ORDER BY b.x / 1", "ordered"],
      ["SELECT b.x / b.y AS q, count(*), min(b.id) FROM bigdec b GROUP BY 1 ORDER BY 1", "ordered"],
      ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY 1 HAVING b.x / 1 > 2 ORDER BY (b.x / 1) * 2 DESC, 2", "ordered"],
      ["SELECT b.x / 1 AS q, rank() OVER (ORDER BY b.x / 1 DESC) FROM bigdec b GROUP BY 1 ORDER BY 2, 1", "ordered"],
      ["SELECT DISTINCT ON (b.x / 1) b.x / 1 AS q, count(*) FROM bigdec b GROUP BY 1 ORDER BY b.x / 1, 2", "ordered"],
      ["SELECT b.y, round(b.x / 3, 21) AS q, count(*) FROM bigdec b GROUP BY b.y, round(b.x / 3, 21) ORDER BY q DESC, 1", "ordered"],
      // grouped inside a derived table and a scalar subquery, read outside
      ["SELECT s.q, s.n FROM (SELECT b.x / 1 AS q, count(*) AS n FROM bigdec b GROUP BY 1) s ORDER BY s.q DESC LIMIT 2", "ordered"],
      ["SELECT (SELECT max(s.n) FROM (SELECT count(*) AS n FROM bigdec b GROUP BY b.x / 1) s) AS biggest", "ordered"],
      // equal values of different scales are one group
      ["SELECT v.x / 2 AS q, count(*) FROM orders o CROSS JOIN (VALUES (1.0::numeric), (1.00), (2), (2.000)) AS v(x) WHERE o.id = 1 GROUP BY 1 ORDER BY 1", "ordered"],
      // an empty input
      ["SELECT b.x / 3 AS q, count(*) FROM bigdec b WHERE false GROUP BY 1 ORDER BY 1", "ordered"],
      // a division by zero in the key: Postgres's 22012, raised by the key's one call
      ["SELECT floor(o.amount / (o.qty - o.qty)) AS b, count(*) FROM orders o GROUP BY 1", "bag"],
      // one row's columns compute a group's value, never two rows' (a NULL skipped): the order key and WITH TIES read
      // first() of each column, so (7, NULL) and (NULL, 7) are the group 1, never (7, 7)'s 2
      ["SELECT (coalesce(v.x, 0) + coalesce(v.y, 0)) / 7 AS q, count(*) FROM orders o CROSS JOIN (VALUES (7.00, NULL::numeric(10,2)), (NULL, 7.00), (14.00, NULL)) AS v(x, y) WHERE o.id = 1 GROUP BY 1 ORDER BY 1 DESC FETCH FIRST 1 ROWS WITH TIES", "ordered"],
      ["SELECT count(*) FROM orders o CROSS JOIN (VALUES (7.00, NULL::numeric(10,2)), (NULL, 7.00), (14.00, NULL)) AS v(x, y) WHERE o.id = 1 GROUP BY (coalesce(v.x, 0) + coalesce(v.y, 0)) / 7 ORDER BY (coalesce(v.x, 0) + coalesce(v.y, 0)) / 7", "ordered"],
      // the same program over a cell seen again (the key's cache) and over NULL cells
      ["SELECT ceil(d.a / 7.0) AS w, count(*), sum(d.c) FROM deep_t d GROUP BY 1 ORDER BY 1 NULLS FIRST", "ordered"],
      // GROUPING of an expression grouped by a key in its place reads the engine's own GROUP BY entry, the key (review
      // r1 of PR 674): in the list, beside a second key, in HAVING; a jsonb grouped by its key alike
      ["SELECT d.c / 3 AS q, grouping(d.c / 3), count(*) FROM deep_t d GROUP BY 1 ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, d.a, grouping(d.c / 3, d.a), count(*) FROM deep_t d GROUP BY 1, 2 ORDER BY 1, 2", "ordered"],
      ["SELECT count(*) FROM deep_t d GROUP BY d.c / 3 HAVING grouping(d.c / 3) = 0 ORDER BY 1", "ordered"],
      ["SELECT t.b::text, grouping(t.b), count(*) FROM jdocs t GROUP BY t.b", "bag"],
      // a SubLink's test expression is this query's (review r1 of PR 674): a grouped quotient's column there is read
      // per group, in HAVING, the list and the ORDER BY, IN, = ANY and NOT IN; and a column the group's key decides
      ["SELECT d.c / 3 AS q, count(*) FROM deep_t d GROUP BY 1 HAVING d.c / 3 IN (SELECT e.c / 5 FROM deep_t e) ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, count(*) FROM deep_t d GROUP BY 1 HAVING d.c / 3 = ANY (SELECT e.c / 5 FROM deep_t e) ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, count(*) FROM deep_t d GROUP BY 1 HAVING d.c / 3 NOT IN (SELECT e.c / 5 FROM deep_t e WHERE e.c IS NOT NULL) ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, d.c / 3 IN (SELECT e.c / 5 FROM deep_t e) AS listed, count(*) FROM deep_t d GROUP BY 1 ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, count(*) FROM deep_t d GROUP BY 1 ORDER BY d.c / 3 IN (SELECT e.c / 5 FROM deep_t e), 1", "ordered"],
      ["SELECT o.id, o.status FROM orders o GROUP BY o.id HAVING o.status IN (SELECT 'shipped') ORDER BY 1 LIMIT 3", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("issue 665 class round r2: GROUPING reads the GROUP BY entry Postgres matched, every clause after grouping is read per group, a SubLink compares as Postgres resolved it", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      // GROUPING of a grouped quotient in every clause that holds one: DISTINCT ON, a named WINDOW's ORDER BY and
      // PARTITION BY, and each where Postgres bound the key by equality to an earlier entry (no node at its offset)
      ["SELECT DISTINCT ON (grouping(d.c / 3)) d.c / 3 AS q FROM deep_t d GROUP BY 1 ORDER BY grouping(d.c / 3), 1", "ordered"],
      ["SELECT DISTINCT ON (grouping(ceil(d.c / 7.0))) ceil(d.c / 7.0) AS w FROM deep_t d GROUP BY 1 ORDER BY grouping(ceil(d.c / 7.0)), 1", "ordered"],
      ["SELECT DISTINCT ON (grouping(d.c / 3), d.c / 3) d.c / 3 AS q, count(*) FROM deep_t d GROUP BY 1 ORDER BY grouping(d.c / 3), d.c / 3", "ordered"],
      ["SELECT DISTINCT ON (grouping(d.c / 3) + 1) d.c / 3 AS q FROM deep_t d GROUP BY 1 ORDER BY grouping(d.c / 3) + 1, 1", "ordered"],
      ["SELECT d.c / 3 AS q, rank() OVER w FROM deep_t d GROUP BY 1 WINDOW w AS (ORDER BY grouping(d.c / 3), d.c / 3) ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, rank() OVER w FROM deep_t d GROUP BY 1 WINDOW w AS (ORDER BY grouping(d.c / 3), d.c / 3) ORDER BY grouping(d.c / 3), 1", "ordered"],
      ["SELECT d.c / 3 AS q, rank() OVER (w ORDER BY d.c / 3) FROM deep_t d GROUP BY 1 WINDOW w AS (PARTITION BY grouping(d.c / 3)) ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, grouping(d.c / 3) AS g, rank() OVER (PARTITION BY grouping(d.c / 3) ORDER BY d.c / 3) FROM deep_t d GROUP BY 1 ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, grouping(d.c / 3) AS g FROM deep_t d GROUP BY 1 ORDER BY grouping(d.c / 3), 1", "ordered"],
      ["SELECT d.c / 3 AS q, grouping(t.c / 3) AS g FROM deep_t d, LATERAL (SELECT d.c) t(c) GROUP BY 1, t.c / 3 ORDER BY 1, 2", "ordered"],
      ["SELECT DISTINCT ON (grouping(d.c / 3)) d.c / 3 AS q FROM deep_t d WHERE false GROUP BY 1 ORDER BY grouping(d.c / 3), 1", "ordered"],
      ["SELECT t.b::text AS k, grouping(t.b) AS g FROM jdocs t GROUP BY t.b ORDER BY grouping(t.b), 1", "ordered"],
      // a GROUPING of this query inside a subquery (its agglevelsup), of a grouped quotient and of a grouped jsonb
      ["SELECT q, (SELECT grouping(s.q)) AS g FROM (SELECT d.c / 3 AS q FROM deep_t d) s GROUP BY q ORDER BY 1", "ordered"],
      ["SELECT q FROM (SELECT d.c / 3 AS q FROM deep_t d) s GROUP BY q HAVING EXISTS (SELECT 1 WHERE grouping(s.q) = 0) ORDER BY 1", "ordered"],
      ["SELECT q, (SELECT grouping(s.q) FROM deep_t LIMIT 0) AS g FROM (SELECT d.c / 3 AS q FROM deep_t d) s GROUP BY q ORDER BY 1", "ordered"],
      ["SELECT t.b::text AS k, (SELECT grouping(t.b)) AS g FROM jdocs t GROUP BY t.b ORDER BY 1", "ordered"],
      ["SELECT t.b::text AS k FROM jdocs t GROUP BY t.b HAVING EXISTS (SELECT 1 WHERE grouping(t.b) = 0) ORDER BY 1", "ordered"],
      // a grouped quotient in a named WINDOW's PARTITION BY and ORDER BY is read per group
      ["SELECT d.c / 3 AS q, count(*) OVER w FROM deep_t d GROUP BY 1 WINDOW w AS (PARTITION BY d.c / 3) ORDER BY 1", "ordered"],
      ["SELECT d.c / 3 AS q, count(*) OVER (w ORDER BY d.c / 3) FROM deep_t d GROUP BY 1 WINDOW w AS (PARTITION BY d.c / 3) ORDER BY 1", "ordered"],
      ["SELECT ceil(d.c / 7.0) AS w, sum(count(*)) OVER x FROM deep_t d GROUP BY 1 WINDOW x AS (PARTITION BY ceil(d.c / 7.0)) ORDER BY 1 NULLS FIRST", "ordered"],
      // a WINDOW's bare name is the FROM's column (SQL99), never an output of that name; ORDER BY and DISTINCT ON's is the output
      ["SELECT d.id, max(d.a) AS b, rank() OVER w AS r FROM deep_t d GROUP BY d.id WINDOW w AS (ORDER BY b, d.id) ORDER BY d.id", "ordered"],
      ["SELECT d.id, d.b AS x, max(d.a) AS b, rank() OVER w AS r FROM deep_t d GROUP BY d.id WINDOW w AS (PARTITION BY b ORDER BY d.id) ORDER BY d.id", "ordered"],
      ["SELECT d.id, max(d.a) AS b, rank() OVER w AS r FROM deep_t d GROUP BY d.id WINDOW w AS (ORDER BY 2) ORDER BY d.id", "ordered"],
      ["SELECT DISTINCT ON (b) b, id FROM deep_t GROUP BY id ORDER BY b, id", "ordered"],
      ["SELECT max(a) AS b FROM deep_t GROUP BY id ORDER BY b NULLS FIRST", "ordered"],
      // a char(n) in a SubLink is compared as Postgres resolved the comparison: without its padding
      ["SELECT id, d IN (SELECT 'ab') AS m FROM deep_t GROUP BY id ORDER BY 1", "ordered"],
      ["SELECT id, d IN (SELECT 'ab') AS m FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id FROM deep_t GROUP BY id HAVING (b, d) IN (SELECT 'x', 'ab') ORDER BY 1", "ordered"],
      ["SELECT id, d = ANY (SELECT 'ab') AS m FROM deep_t GROUP BY id ORDER BY 1", "ordered"],
      ["SELECT id, (a, d) = ANY (SELECT 5, 'ab') AS m FROM deep_t GROUP BY id ORDER BY 1", "ordered"],
      ["SELECT id, (SELECT d IN (SELECT 'ab')) AS m FROM deep_t GROUP BY id ORDER BY 1", "ordered"],
      ["SELECT id, d IN (SELECT 'ab'::char(6)) AS m FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, 'ab' IN (SELECT s.d FROM deep_t s WHERE s.id = deep_t.id) AS m FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, d NOT IN (SELECT 'ab') AS m FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, d = ANY (SELECT 'a' UNION ALL SELECT 'zz') AS m FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT d, count(*) FROM deep_t GROUP BY d HAVING d IN (SELECT 'ab') ORDER BY 1", "ordered"],
      ["SELECT id, b IN (SELECT s.d FROM deep_t s) AS m FROM deep_t ORDER BY 1", "ordered"],
      // a char(n) against a char(n): bpchareq and bpcharlt ignore the padding on both sides, in a SubLink and outside
      ["SELECT id, d IN (SELECT s.d::char(9) FROM deep_t s WHERE s.id = deep_t.id) AS m FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, 'ab'::char(2) = ANY (SELECT s.d FROM deep_t s WHERE s.id = deep_t.id) AS m FROM deep_t GROUP BY id ORDER BY 1", "ordered"],
      ["SELECT id, d = 'ab'::char(9) AS e, d <> 'ab '::char(3) AS n, d IN ('ab'::char(6), 'cd') AS i FROM deep_t ORDER BY 1", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("issue 665 class round r3: every coercion Postgres placed on a char(n) is written, and a subquery's output is compared as Postgres resolved it whatever its form", async () => {
  const c = await client();
  try {
    const forms = [
      // VALUES, a star, TABLE, a CTE and every set operation, as the subquery of a char(n) comparison
      "d IN (VALUES ('ab'::char(4)))", "d NOT IN (VALUES ('ab'::char(4)))", "d IN (VALUES ('ab'::char(4)), ('zz'::char(4)))",
      "d IN (SELECT s.* FROM (SELECT d FROM deep_t WHERE id = 1) s)",
      "(a, d) IN (SELECT s.* FROM (SELECT a, d FROM deep_t WHERE id = 1) s)",
      "d IN (TABLE chars)", "d IN (WITH w AS (SELECT d FROM deep_t WHERE id = 1) SELECT * FROM w)", "d IN (WITH w AS (SELECT d FROM deep_t WHERE id = 1) TABLE w)",
      "d IN (SELECT d FROM deep_t WHERE id = 1 UNION SELECT d FROM deep_t WHERE id = 6)", "d IN (SELECT d FROM deep_t WHERE id = 1 UNION ALL SELECT d FROM deep_t WHERE id = 6)",
      "d IN (SELECT d FROM deep_t INTERSECT SELECT d FROM deep_t WHERE id = 1)", "d IN (SELECT 'ab'::char(4) EXCEPT SELECT 'b'::char(4))",
      "d = ANY (SELECT u.d FROM deep_t u WHERE u.id = deep_t.id UNION ALL SELECT 'zz'::char(4))",
      "d IN (SELECT d FROM deep_t WHERE id = 1 UNION SELECT 'zz')", "d IN (SELECT d FROM deep_t WHERE id = 1 UNION ALL SELECT 'zz'::text)",
      "(d, d) IN (SELECT d, d FROM deep_t WHERE id = 1 UNION SELECT 'b', 'b')",
      // a char(n) row or arm Postgres coerced to text inside the subquery: VALUES (a CTE's, a correlated row), CASE, NULLIF
      "d IN (VALUES ('zz'::text), ('ab'::char(4)))", "d IN (SELECT x FROM (VALUES ('zz'::text), ('ab'::char(4))) v(x))",
      "d IN (WITH w(x) AS (VALUES ('zz'::text), ('ab'::char(4))) SELECT x FROM w)", "d IN (SELECT x FROM (VALUES ('zz'::text), (deep_t.d)) v(x))",
      "b IN (VALUES ('x'::char(4)), ('zz'::text))", "b IN (SELECT 'x'::char(4) UNION ALL SELECT 'zz'::text)",
      "d IN (SELECT CASE WHEN u.id = 1 THEN u.d ELSE 'zz'::text END FROM deep_t u)", "d IN (SELECT nullif(u.d, 'qq'::text) FROM deep_t u WHERE u.id = 1)",
      "d IN (SELECT nullif(u.d, 'qq'::text) FROM deep_t u WHERE u.id = 1 UNION ALL SELECT 'qq'::text)",
    ];
    // ALL, and a row under an ordering operator, each pair as Postgres compares it, a NULL member NULL (on a listener
    // that refuses nothing, so the answer is held whatever the allowlist the oracle's legs regenerate)
    const ordered = [
      "d <> ALL (SELECT * FROM (SELECT d FROM deep_t WHERE id = 1) s)", "d < ALL (SELECT d FROM deep_t WHERE id = 6 UNION SELECT d FROM deep_t WHERE id = 5)",
      "(a, d) < ANY (SELECT a, d FROM deep_t WHERE id = 6 UNION SELECT a, d FROM deep_t WHERE id = 5)", "(a, d) >= ANY (VALUES (2, 'b'::char(4)))",
      "(a, d) < ANY (VALUES (2, 'b'::char(4)), (2, 'zz'::char(4)))", "(a, b) < ANY (SELECT 3, d FROM deep_t WHERE id = 1)",
      "(a, d) <= ALL (SELECT a, d FROM deep_t WHERE id IN (1, 6))", "(a, d) > ANY (SELECT a, d FROM deep_t WHERE false)",
      "(a, d) > ALL (WITH w AS (SELECT a, d FROM deep_t WHERE id = 1) SELECT * FROM w)",
    ];
    // (a correlated VALUES row beside a GROUP BY is refused at the base too, 42803: its plain form only)
    const ungrouped = new Set(["d IN (SELECT x FROM (VALUES ('zz'::text), (deep_t.d)) v(x))"]);
    const each = (fs: string[]): Array<[string, "ordered"]> => fs.flatMap((f) => [
      [`SELECT id, ${f} AS m FROM deep_t ORDER BY 1`, "ordered"] as [string, "ordered"],
      ...(ungrouped.has(f) ? [] : [[`SELECT id, ${f} AS m FROM deep_t GROUP BY id ORDER BY 1`, "ordered"] as [string, "ordered"]]),
    ]);
    const statements = each(forms);
    // the coercion outside a subquery, and its GROUP BY twin
    statements.push(
      ["SELECT id, CASE WHEN id = 1 THEN d ELSE 'zz'::text END AS x, nullif(d, 'qq'::text) AS n, upper(d) AS u FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT CASE WHEN a > 0 THEN d ELSE 'zz'::text END AS x, count(*) FROM deep_t GROUP BY CASE WHEN a > 0 THEN d ELSE 'zz'::text END ORDER BY 1 NULLS FIRST", "ordered"],
      ["SELECT d || '|' AS x, string_agg(d, ',' ORDER BY id) OVER () AS s FROM deep_t ORDER BY id", "ordered"],
    );
    assert.deepEqual(await unlike(c, statements), []);
    const { api: a, c: all } = await collsApi(await store.listener(undefined, null, undefined, () => copies, undefined, { collations: PG_COLLATIONS }));
    // the test's columns grouped themselves, or a grouped key first: read by the outer query, never inside the subquery
    const grouped: Array<[string, "ordered"]> = [
      ["SELECT a, d, (a, d) < ANY (SELECT a, d FROM deep_t WHERE id = 6) AS m FROM deep_t GROUP BY a, d ORDER BY 1, 2", "ordered"],
      ["SELECT a, (a, 1) < ANY (SELECT a, 1 FROM deep_t WHERE id = 6) AS m FROM deep_t GROUP BY 1 ORDER BY 1", "ordered"],
      ["SELECT id, (id, a) < ANY (SELECT 5, NULL::int) AS m FROM deep_t GROUP BY id ORDER BY 1", "ordered"],
      ["SELECT id FROM deep_t GROUP BY id HAVING (id, a) >= ALL (SELECT 3, a FROM deep_t WHERE id = 1) ORDER BY 1", "ordered"],
      // a row's <> ANY filtering: a NULL member NULL, never true
      ["SELECT id FROM deep_t WHERE (a, d) <> ANY (SELECT a, d FROM deep_t WHERE id IN (1, 4)) ORDER BY 1", "ordered"],
      ["SELECT id FROM deep_t GROUP BY id HAVING (a, d) <> ANY (SELECT 1, NULL::char(4)) ORDER BY 1", "ordered"],
      ["SELECT id, (a, d) <> ANY (SELECT NULL::int, 'ab'::char(4) UNION ALL SELECT 2, 'cd') AS m FROM deep_t ORDER BY 1", "ordered"],
    ];
    try { assert.deepEqual(await unlike(all, [...each(ordered), ...grouped]), []); } finally { await all.end(); await a.close(); }
  } finally { await c.end(); }
});

// (on a listener that refuses nothing, so the answer is held whatever the allowlist the oracle's legs regenerate)
test("issue 665 CI fix 1 (#284): two rows ordered pair by pair as Postgres orders them, a NULL member NULL, every operand read once", async () => {
  const { api: a, c } = await collsApi(await store.listener(undefined, null, undefined, () => copies, undefined, { collations: PG_COLLATIONS }));
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT id, (a, d) < (2, 'cd') AS m FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, (a, b) <= (2, 'y') AS m, (a, c) > (2, 3.00) AS n, (a, b) >= (NULL::int, 'x') AS o FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, ROW(a, b) < ROW(c::int, b) AS m, (a, b) < (1, b) AS n FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id FROM deep_t WHERE (a, id) > (2, 3) ORDER BY 1", "ordered"],
      ["SELECT id FROM deep_t WHERE NOT ((a, id) < (2, 3)) ORDER BY 1", "ordered"],
      ["SELECT id FROM deep_t ORDER BY (a, id) < (2, 3) NULLS FIRST, id", "ordered"],
      ["SELECT id, (d, id) < (NULL, 3) AS m, ('b'::char(4), 1) < (NULL, 2) AS n FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT (a, b) < (3, 'x') AS m, count(*) FROM deep_t GROUP BY 1 ORDER BY 1 NULLS FIRST", "ordered"],
      // a volatile member read once: the comparison is of the one value the row holds
      ["SELECT count(*) FILTER (WHERE (x, 1) <= (x, 1)) AS n FROM (SELECT random() AS x FROM deep_t) s", "ordered"],
      // a constant beside a column of another type is cast to it, as any comparison's is
      ["SELECT id, (a, b) < ($$2$$::int, 'y'::varchar) AS m, (b, id) >= ('x', 1) AS n FROM deep_t ORDER BY 1", "ordered"],
    ]), []);
    // a citext member is refused by name: Postgres orders it without regard to case
    await assert.rejects(c.query("SELECT id FROM accounts WHERE (status, id) < ('B'::citext, 2)"),(e: Error & { code?: string; detail?: string }) => e.code === "0A000" && /citext-forms/.test(e.detail ?? ""));
  } finally { await c.end(); await a.close(); }
});

// (on the listener production runs, its allowlist the one CI's legs verified: ALL of a subquery and a row comparison
// admitted, so a citext reaching them is answered unless the rewrite refuses it)
test("issue 665 shrink 1: a citext compared by ALL of a subquery, or in a row compared with each of its rows, is refused by name; the rest answered", async () => {
  const { api: a, c } = await collsApi(await store.listener(undefined, undefined, undefined, () => copies, undefined, { collations: PG_COLLATIONS }));
  try {
    // `status` is a citext of 'finalized', 'FINALIZED', 'Finalized' and 'draft': compared by its bytes, each answer differs
    const citext = [
      "SELECT id FROM accounts WHERE status < ALL (SELECT status FROM accounts WHERE id > 1) ORDER BY 1",
      "SELECT id FROM accounts WHERE status >= ALL (SELECT status FROM accounts WHERE id <> 4) ORDER BY 1",
      "SELECT id FROM accounts WHERE status = ALL (SELECT status FROM accounts WHERE id = 1) ORDER BY 1",
      "SELECT id FROM accounts WHERE status <> ALL (SELECT status FROM accounts WHERE id = 1) ORDER BY 1",
      "SELECT id, status <= ALL (SELECT status FROM accounts WHERE id IN (2, 3)) AS m FROM accounts ORDER BY 1",
      "SELECT id FROM accounts WHERE (status, id) < ANY (SELECT status, id FROM accounts WHERE id = 1) ORDER BY 1",
      "SELECT id FROM accounts WHERE (status, id) >= ALL (SELECT status, id FROM accounts WHERE id IN (1, 2)) ORDER BY 1",
      "SELECT id FROM accounts WHERE (id, status) > ANY (SELECT id, status FROM accounts WHERE id = 1) ORDER BY 1",
      "SELECT id FROM accounts WHERE (id, status) <= ALL (SELECT 1, status FROM accounts WHERE id = 2) ORDER BY 1",
      "SELECT id FROM accounts WHERE (status, id) <> ALL (SELECT status, 1 FROM accounts WHERE id = 2) ORDER BY 1",
      "SELECT id FROM accounts WHERE (status, 1) <> ANY (SELECT status, 1 FROM accounts WHERE id = 1) ORDER BY 1",
      "SELECT id FROM accounts GROUP BY id HAVING (status, id) >= ALL (SELECT status, id FROM accounts WHERE id IN (1, 2)) ORDER BY 1",
    ];
    const answered: string[] = [];
    for (const s of citext) {
      try { await c.query(s); answered.push(`answered: ${s}`); } catch (e) {
        const err = e as Error & { code?: string; detail?: string };
        if (err.code !== "0A000" || !/citext-forms/.test(err.detail ?? "")) answered.push(`${err.code} ${err.message}: ${s}`);
      }
    }
    assert.deepEqual(answered, []);
    // text, char(n), numeric and NULL under ANY and ALL, a row without a citext, and a citext beside a text (text's
    // operator), answered as Postgres answers them
    assert.deepEqual(await unlike(c, [
      ["SELECT id, b < ALL (SELECT b FROM deep_t WHERE id IN (1, 3)) AS m, b >= ANY (SELECT b FROM deep_t WHERE id IN (1, 3)) AS n FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, d > ALL (SELECT d FROM deep_t WHERE id IN (1, 3)) AS m, d = ALL (SELECT d FROM deep_t WHERE id = 1) AS n FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, c <= ALL (SELECT c FROM deep_t WHERE id IN (1, 3)) AS m, a <> ALL (SELECT a FROM deep_t WHERE id IN (1, 4)) AS n FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, (a, b) < ALL (SELECT a, b FROM deep_t WHERE id IN (1, 3)) AS m, (d, a) >= ANY (SELECT d, a FROM deep_t WHERE id = 3) AS n FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, (a, d) <> ANY (SELECT a, d FROM deep_t WHERE id = 1) AS m FROM deep_t ORDER BY 1", "ordered"],
      ["SELECT id, status::text < ALL (SELECT team FROM accounts WHERE id > 2) AS m FROM accounts ORDER BY 1", "ordered"],
    ]), []);
  } finally { await c.end(); await a.close(); }
});

// (on the listener production runs; a domain over a citext is synced as the citext it holds, so the catalog never
// holds a domain, and a composite holding one is held as its text, refused before any comparison: both are held
// by CITEXT_HELD run on Postgres below)
test("issue 665 shrink 2: a citext reached through an array, a nested array or a row's array is refused by name under ALL or a row's comparison; CITEXT_HELD names every type holding one", async () => {
  const { api: a, c } = await collsApi(await store.listener(undefined, undefined, undefined, () => copies, undefined, { collations: PG_COLLATIONS }));
  try {
    // `status` is a citext of 'finalized', 'FINALIZED', 'Finalized' and 'draft': compared by its bytes, each answer differs
    const held = [
      "SELECT id, ARRAY[status] = ALL (SELECT ARRAY[status] FROM accounts WHERE id = 1) AS m FROM accounts ORDER BY 1",
      "SELECT id FROM accounts WHERE ARRAY[status] = ALL (SELECT ARRAY[status] FROM accounts WHERE id IN (1, 2)) ORDER BY 1",
      "SELECT id, ARRAY[ARRAY[status]] = ALL (SELECT ARRAY[ARRAY[status]] FROM accounts WHERE id = 1) AS m FROM accounts ORDER BY 1",
      "SELECT id, ARRAY[status, 'x'] = ALL (SELECT ARRAY[status, 'X'] FROM accounts WHERE id = 2) AS m FROM accounts ORDER BY 1",
      "SELECT id, (ARRAY[status], id) = ALL (SELECT ARRAY[status], 2 FROM accounts WHERE id = 1) AS m FROM accounts ORDER BY 1",
      "SELECT id, (ARRAY[status], id) <> ALL (SELECT ARRAY[status], 2 FROM accounts WHERE id = 1) AS m FROM accounts ORDER BY 1",
      "SELECT id, (ARRAY[status], 1) <> ANY (SELECT ARRAY[status], 1 FROM accounts WHERE id = 1) AS m FROM accounts ORDER BY 1",
      "SELECT id, (id, ARRAY[status]) < ANY (SELECT 2, ARRAY[status] FROM accounts WHERE id = 1) AS m FROM accounts ORDER BY 1",
    ];
    const answered: string[] = [];
    for (const s of held) {
      try { await c.query(s); answered.push(`answered: ${s}`); } catch (e) {
        const err = e as Error & { code?: string; detail?: string };
        if (err.code !== "0A000" || !/citext-forms/.test(err.detail ?? "")) answered.push(`${err.code} ${err.message} [${err.detail}]: ${s}`);
      }
    }
    assert.deepEqual(answered, []);
    // an array of a text or an int, under ANY and ALL, answered as Postgres answers it
    assert.deepEqual(await unlike(c, [
      ["SELECT id, ARRAY[team] = ALL (SELECT ARRAY[team] FROM accounts WHERE id = 1) AS m, ARRAY[id] = ALL (SELECT ARRAY[id] FROM accounts WHERE id = 3) AS n FROM accounts ORDER BY 1", "ordered"],
      ["SELECT id, ARRAY[team] = ANY (SELECT ARRAY[team] FROM accounts WHERE id < 3) AS m, (ARRAY[id], team) = ALL (SELECT ARRAY[id], team FROM accounts WHERE id = 1) AS n FROM accounts ORDER BY 1", "ordered"],
    ]), []);
  } finally { await c.end(); await a.close(); }
  // the catalog's structure, to any depth: an array, a domain (of a domain), an array domain, a composite (of an array of
  // one), a range and its multirange; never a type without a citext (imported here, so the file loads at a commit
  // without it and the refusals above are what fails there)
  const { CITEXT_HELD } = await import("../src/duck/plan.ts");
  assert.equal(typeof CITEXT_HELD, "string");
  await truth.exec("BEGIN");
  try {
    await truth.exec("CREATE DOMAIN h_d1 AS citext; CREATE DOMAIN h_d2 AS h_d1; CREATE DOMAIN h_da AS citext[]; CREATE TYPE h_c AS (x int, y h_d2); " +
      "CREATE TYPE h_cc AS (z h_c[]); CREATE TYPE h_r AS RANGE (subtype = citext); CREATE TYPE h_plain AS (x int, y text); CREATE DOMAIN h_t AS text");
    const r = await truth.query<{ t: string }>(`SELECT format_type(oid, NULL) AS t FROM pg_type WHERE oid IN (SELECT oid::oid FROM (${CITEXT_HELD}) s(oid)) ORDER BY 1`);
    // (the table `accounts` too: its row type holds its citext column)
    assert.deepEqual(r.rows.map((x) => x.t), ["accounts", "accounts[]", "citext", "citext[]", "h_c", "h_c[]", "h_cc", "h_cc[]", "h_d1", "h_d1[]", "h_d2", "h_d2[]", "h_da", "h_da[]", "h_r", "h_r[]", "h_r_multirange", "h_r_multirange[]"]);
  } finally { await truth.exec("ROLLBACK"); }
});

test("exact path: the AGGREGATE reader sums and averages a program exactly, through a derived table or a CTE (issue 278)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT sum(o.amount / 7), avg(o.amount / 7) FROM orders o", "ordered"],
      ["SELECT sum(o.amount / 3) FROM orders o", "ordered"],
      ["WITH q AS (SELECT o.amount / 7 AS x FROM orders o) SELECT sum(x), max(x), min(x), avg(x) FROM q", "ordered"],
      ["SELECT sum(x), avg(x) FROM (SELECT o.amount / 7 AS x FROM orders o) q", "ordered"],
      ["WITH q AS (SELECT o.amount / 7 AS x, o.status FROM orders o) SELECT status, sum(x) FROM q GROUP BY status ORDER BY 1 NULLS FIRST", "ordered"],
      ["SELECT avg(l.k / 7.0) FROM late l", "ordered"],
      ["SELECT l.id, sum(l.k / 7.0) OVER (ORDER BY l.id) FROM late l ORDER BY l.id LIMIT 3", "ordered"],
      ["SELECT DISTINCT sum(r.a / '1.5'::numeric) AS s FROM ratios r GROUP BY r.team ORDER BY 1", "ordered"],
      ["SELECT sum(s.q) FROM (SELECT o.amount / 3 AS q FROM orders o) s", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path: the CAST reader reads a program's text, its nearest double and its integer rounded half away from zero (issues 218, 217, 242)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT length((b.x / 1)::text), (b.x / 1)::text || '', left((b.x / 1)::text, 5), (b.x / 1)::varchar(5), (b.x / 1)::text::numeric FROM bigdec b ORDER BY b.id", "ordered"],
      ["SELECT b.id FROM bigdec b WHERE (b.x / 1)::text LIKE '%01' OR (b.x / 1)::text IN ('5.00000000000000000000') ORDER BY 1", "ordered"],
      ["SELECT r.id, power(r.a, 2)::double precision, sqrt(r.a)::double precision FROM ratios r ORDER BY 1", "ordered"],
      ["SELECT o.id, power(o.amount, 2)::double precision FROM orders o ORDER BY 1", "ordered"],
      ["SELECT b.id, (b.x / 1)::int, (b.x / b.y)::int8, (-b.x / 1)::int FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id, (b.x / b.y)::double precision FROM bigdec b ORDER BY 1", "ordered"],
      // issue 242: a NULLIF over a quotient is its operand's program, NULL where it equals the other by the exact keys
      ["SELECT b.id, nullif(b.x / b.y, 0)::int, nullif(b.x / b.y, 0)::int8, nullif(b.x / b.y, 2.5)::int FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id, nullif(b.x / b.y, 0), nullif(b.x / b.y, 2.5), nullif(b.x / 1, 1.00000000000000000001) FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id, (exp(ln(2.5)) * sign(b.x))::int, (exp(ln(2.5)) * sign(-b.x))::int8 FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id, (SELECT nullif(c.x / c.y, 0)::int FROM bigdec c WHERE c.id = b.id) FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT *, nullif(b.x / b.y, 0)::int AS r FROM bigdec b ORDER BY b.id", "ordered"],
      ["SELECT sum(nullif(b.x / b.y, 0)), max(nullif(b.x / b.y, 0))::int FROM bigdec b", "ordered"],
      // what the base answered stays answered: sign's TINYINT, a DECIMAL's own cast, round and trunc, a float8's half to even
      ["SELECT b.id, sign(b.x)::int, sign(b.x / b.y)::int, nullif(b.x, 0)::int, (b.x * 2)::int FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id, trunc(b.x / b.y)::int, round(b.x / b.y)::int, ((b.x / b.y)::float8)::int, (b.x::float8 / b.y)::int8 FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT (sum(o.amount) / nullif(count(*), 0))::int, round(100.0 * sum(o.amount) / nullif(sum(o.qty), 0))::int FROM orders o", "ordered"],
      ["SELECT b.id, ((b.x / b.y)::int)::text, ((b.x / b.y)::int)::numeric(10,2) FROM bigdec b ORDER BY 1", "ordered"],
    ]), []);
    // a parameter in the NULLIF's quotient, prepared and then executed again after a later SET
    const bound = "SELECT b.id, nullif(b.x / $1, 0)::int AS r FROM bigdec b ORDER BY b.id";
    assert.deepEqual(await unlikeBound(c, [[bound, ["2"]]]), []);
    const want = (await postgres(bound, ["2"])).rows;
    assert.deepEqual((await c.query({ name: "nullif_bound", text: bound, values: ["2"], rowMode: "array" })).rows.map((r) => r.map(String)), want.map((r) => r.map(String)));
    await c.query("SET TimeZone = 'Europe/Paris'");
    assert.deepEqual((await c.query({ name: "nullif_bound", text: bound, values: ["2"], rowMode: "array" })).rows.map((r) => r.map(String)), want.map((r) => r.map(String)), "after a SET");
  } finally { await c.end(); }
});

test("exact path: issue 217: a numeric power, exp, ln, log or sqrt cast to float8 is numeric_float8 of Postgres's digits, 22003 past a double's range", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT power(o.amount, 2)::double precision AS x FROM orders o ORDER BY o.id", "ordered"],
      ["SELECT o.id, (o.amount ^ 2)::float8, exp(o.amount)::float8, ln(o.amount)::float8, log(o.amount)::float8, log10(o.amount)::float8, sqrt(o.amount)::float8 FROM orders o WHERE o.amount > 0 ORDER BY 1", "ordered"],
      ["SELECT r.id, (r.a ^ 2)::double precision, power(r.a, 2)::double precision, CAST(exp(r.a) AS double precision) FROM ratios r ORDER BY 1", "ordered"],
      ["SELECT *, power(o.amount, 2)::double precision AS p FROM orders o ORDER BY o.id", "ordered"],
      ["SELECT power(o.amount, 2)::float8 AS p, count(*) FROM orders o GROUP BY 1 ORDER BY 1", "ordered"],
      ["SELECT power(o.amount, 2)::float8 AS p, count(*) FROM orders o GROUP BY p ORDER BY p", "ordered"],
      ["SELECT power(o.amount, 2)::float8, count(*) FROM orders o GROUP BY power(o.amount, 2)::float8 ORDER BY power(o.amount, 2)::float8 NULLS FIRST", "ordered"],
      // past a double's range, and a non-zero value that underflows to 0: Postgres's 22003, the text quoted whole
      ["SELECT power(10::numeric, 400)::double precision", "ordered"],
      ["SELECT ((o.amount * 0 + 10) ^ 400)::float8 FROM orders o WHERE o.amount IS NOT NULL LIMIT 1", "ordered"],
      ["SELECT ((o.amount * 0 + 0.01) ^ 170)::float8 FROM orders o WHERE o.amount IS NOT NULL LIMIT 1", "ordered"],
      ["SELECT exp(o.amount * 0 + 800)::float8 FROM orders o WHERE o.amount IS NOT NULL LIMIT 1", "ordered"],
      ["SELECT (-((o.amount * 0 + 10) ^ 401))::float8 FROM orders o WHERE o.amount IS NOT NULL LIMIT 1", "ordered"],
      // in range, and a subnormal Postgres accepts
      ["SELECT ((o.amount * 0 + 10) ^ 300)::float8, ((o.amount * 0 + 0.1) ^ 310)::float8 FROM orders o ORDER BY o.id", "ordered"],
    ]), []);
    // a parameter for the exponent, prepared and then executed again after a later SET
    const bound = "SELECT o.id, (o.amount ^ $1)::float8, power(o.amount, $1)::double precision FROM orders o ORDER BY o.id";
    assert.deepEqual(await unlikeBound(c, [[bound, ["2"]]]), []);
    const want = (await postgres(bound, ["2"])).rows;
    assert.deepEqual((await c.query({ name: "power_bound", text: bound, values: ["2"], rowMode: "array" })).rows.map((r) => r.map(String)), want.map((r) => r.map(String)));
    await c.query("SET TimeZone = 'Europe/Paris'");
    assert.deepEqual((await c.query({ name: "power_bound", text: bound, values: ["2"], rowMode: "array" })).rows.map((r) => r.map(String)), want.map((r) => r.map(String)), "after a SET");
    // the errors are raised, never answered (an equal answer above could be two equal refusals of another kind)
    await assert.rejects(c.query("SELECT power(10::numeric, 400)::double precision"),
      (e: pg.DatabaseError) => e.code === "22003" && /^"1(0)+" is out of range for type double precision$/.test(e.message));
  } finally { await c.end(); }
});

test("exact path: issue 242: an integer cast of percentile_disc or mode() of a quotient, or of any expression over it, is the picked row's exact value", async () => {
  const c = await client();
  try {
    // review r2 of PR 506 asked these be refused by name, never the engine's 42883 / 42804; PR 506's class round answers
    // them: the aggregate is the picked row's exact value (`pickedByExactKey`), so each cast is Postgres's, half away from zero
    const over = "percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y)";
    assert.deepEqual(await unlike(c, [
      `SELECT (${over})::int FROM bigdec b`, "SELECT (mode() WITHIN GROUP (ORDER BY b.x / b.y))::int AS m FROM bigdec b",
      `SELECT CAST(${over} AS bigint) FROM bigdec b`, `SELECT (${over} * 2)::int FROM bigdec b`, `SELECT (${over} + 0)::int FROM bigdec b`,
      `SELECT round(${over})::int, trunc(${over})::int FROM bigdec b`, `SELECT abs(${over})::int FROM bigdec b`, `SELECT coalesce(${over}, 0)::int FROM bigdec b`,
      `SELECT nullif(${over}, 0)::int FROM bigdec b`, `SELECT greatest(${over}, 0)::int FROM bigdec b`, `SELECT (x * 2)::int FROM (SELECT ${over} AS x FROM bigdec b) s`,
      "WITH q AS (SELECT mode() WITHIN GROUP (ORDER BY b.x / b.y) AS x FROM bigdec b) SELECT (x / 2)::int8 FROM q",
      `SELECT b.id % 2, (${over} * 2)::int FROM bigdec b GROUP BY 1 ORDER BY 1`, `SELECT (${over} * 2)::int FROM bigdec b UNION ALL SELECT 1 ORDER BY 1`,
    ].map((sql) => [sql, "ordered"] as [string, "ordered"])), []);
    assert.deepEqual(await unlike(c, [
      // its old way out answers as Postgres does
      ["SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY (b.x / b.y)::int) FROM bigdec b", "ordered"],
      // review r1 of PR 506, finding 2: what the engine holds as a DECIMAL (percentile_disc / mode of a column, min / max
      // of Postgres's own power) is cast as Postgres casts it, never refused as a double
      ["SELECT (percentile_disc(0.5) WITHIN GROUP (ORDER BY o.amount))::int, (percentile_disc(0.5) WITHIN GROUP (ORDER BY o.amount))::int8 FROM orders o", "ordered"],
      ["SELECT (percentile_disc(0.5) WITHIN GROUP (ORDER BY o.amount) * 2)::int, (percentile_disc(0.5) WITHIN GROUP (ORDER BY o.amount) / 7)::int FROM orders o", "ordered"],
      ["SELECT o.status, (percentile_disc(0.5) WITHIN GROUP (ORDER BY o.amount DESC))::int FROM orders o GROUP BY o.status ORDER BY 1", "ordered"],
      ["SELECT s.x::int FROM (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY o.amount) AS x FROM orders o) s", "ordered"],
      ["SELECT max(sqrt(o.amount))::int, min(sqrt(o.amount))::int8 FROM orders o", "ordered"],
      // review r1 of PR 506, finding 1: a NULLIF's NULL read outside its subquery, regrouped: NULL, never its operand
      ["SELECT x FROM (SELECT nullif(b.x / b.y, 2.5) AS x FROM bigdec b) s GROUP BY x ORDER BY 1", "ordered"],
      ["WITH q AS (SELECT b.id, nullif(b.x / b.y, 2.5) AS x FROM bigdec b) SELECT x, count(*) FROM q GROUP BY x HAVING x IS NULL OR x > 1.1 ORDER BY 1", "ordered"],
      ["SELECT coalesce(x, -1), x::int, x::text, x::float8 FROM (SELECT nullif(b.x / b.y, 2.5) AS x FROM bigdec b) s GROUP BY x ORDER BY 1", "ordered"],
      ["SELECT DISTINCT x FROM (SELECT nullif(nullif(b.x / b.y, 2.5), 1.25) * 2 AS x FROM bigdec b) s ORDER BY 1", "ordered"],
      ["SELECT s.x FROM (SELECT b.id, nullif(b.x / b.y, 2.5) AS x FROM bigdec b) s JOIN bigdec c ON c.id = s.id GROUP BY s.x ORDER BY 1", "ordered"],
      // and a program's cast under an outer GROUP BY reads one row's text per group (the engine's 42803 before)
      ["WITH q AS (SELECT b.x / b.y AS x FROM bigdec b) SELECT x::float8, x::text, x::int FROM q GROUP BY x ORDER BY 2", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path: percentile_disc or mode() ordered by a numeric Mason computes exactly answer the picked row's exact value, wherever it is read (PR 506's class round, issue 538)", async () => {
  const c = await client();
  try {
    // (class refusal-wider-than-the-wrong-answer, and before it order-key-bytes-as-result: the engine answers what it sorts
    // by; the rewrite sorts a row(order key, value) and answers the value, so no reader meets the key's bytes)
    const forms: string[] = [];
    for (const key of ["b.x / b.y", "exp(ln(2.5)) * sign(b.x)", "nullif(b.x / b.y, 0)", "coalesce(b.x / b.y, 0)", "b.x / b.y + 1", "round(b.x / b.y, 2)", "-(b.x / b.y)", "(b.x / b.y)::numeric(10,4)"]) {
      const pd = `percentile_disc(0.5) WITHIN GROUP (ORDER BY ${key})`, md = `mode() WITHIN GROUP (ORDER BY ${key})`;
      forms.push(
        // read as a value: printed, ::text, a cast, arithmetic, grouped, an array of nothing
        `SELECT ${pd}, (${pd})::text, ${md}, ${pd} * 2, (${md})::float8 FROM bigdec b`,
        `SELECT b.id % 3 AS g, ${pd}, ${md} FROM bigdec b GROUP BY 1 ORDER BY 1`,
        `SELECT x, x::text FROM (SELECT ${pd} AS x FROM bigdec b) s`,
        // only ordered (review r4): the SELECT's ORDER BY, WITH TIES, DISTINCT ON, a window's, a derived table's and a CTE's
        `SELECT b.id % 3 AS g FROM bigdec b GROUP BY 1 ORDER BY ${pd} DESC NULLS LAST, 1`,
        `SELECT b.id % 3 AS g FROM bigdec b GROUP BY 1 ORDER BY ${md}, 1 FETCH FIRST 1 ROWS WITH TIES`,
        `SELECT b.id % 3 AS g, rank() OVER (ORDER BY ${pd}) FROM bigdec b GROUP BY 1 ORDER BY 2, 1`,
        `SELECT g FROM (SELECT b.id % 3 AS g, ${pd} AS x FROM bigdec b GROUP BY 1) s ORDER BY x, g`,
        `WITH q AS (SELECT b.id % 3 AS g, ${md} AS x FROM bigdec b GROUP BY 1) SELECT g FROM q ORDER BY x DESC NULLS LAST, g LIMIT 2`,
        // nullness, comparison, grouping, partitioning and joining (review r5, issue 538)
        `SELECT b.id % 3 AS g FROM bigdec b GROUP BY 1 HAVING ${pd} IS NOT NULL ORDER BY 1`,
        `SELECT b.id % 3 AS g, CASE WHEN ${pd} IS NULL THEN 0 ELSE 1 END FROM bigdec b GROUP BY 1 ORDER BY 1`,
        `SELECT b.id % 3 AS g FROM bigdec b GROUP BY 1 HAVING ${pd} = ${md} OR ${pd} > 1 ORDER BY 1`,
        `SELECT count(x), count(DISTINCT x) FROM (SELECT b.id % 3 AS g, ${pd} AS x FROM bigdec b GROUP BY 1) s`,
        `SELECT x, count(*) FROM (SELECT b.id % 3 AS g, ${md} AS x FROM bigdec b GROUP BY 1) s GROUP BY x ORDER BY 1`,
        `SELECT b.id % 3 AS g, count(*) OVER (PARTITION BY ${pd}) FROM bigdec b GROUP BY 1 ORDER BY 1`,
        `SELECT s1.g, s2.g FROM (SELECT b.id % 3 AS g, ${pd} AS x FROM bigdec b GROUP BY 1) s1 JOIN (SELECT b.id % 3 AS g, ${md} AS x FROM bigdec b GROUP BY 1) s2 ON s1.x = s2.x ORDER BY 1, 2`,
      );
    }
    assert.deepEqual(await unlike(c, forms.map((sql) => [sql, "ordered"] as [string, "ordered"])), []);
    // an array of fractions would answer the doubles of a numeric[]: refused by name, its way out answers
    await assert.rejects(c.query("SELECT percentile_disc(ARRAY[0.25, 0.75]) WITHIN GROUP (ORDER BY b.x / b.y) FROM bigdec b"),
      (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap numeric-ordered-set/.test(e.detail ?? "") && /ask for each fraction alone/.test(e.hint ?? ""));
    assert.deepEqual(await unlike(c, [
      ["SELECT percentile_disc(0.25) WITHIN GROUP (ORDER BY b.x / b.y), percentile_disc(0.75) WITHIN GROUP (ORDER BY b.x / b.y) FROM bigdec b", "ordered"],
      ["SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY o.amount), mode() WITHIN GROUP (ORDER BY o.amount), percentile_disc(0.5) WITHIN GROUP (ORDER BY o.amount * 2) FROM orders o", "ordered"],
      ["SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY b.x / b.y) FROM bigdec b", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path: issue 242's NULLIF, sign and picked value through PR 520's shared programs (#484): each read three times a level over a quotient chain, as Postgres", async () => {
  const c = await client();
  try {
    // a node several parents share (src/lib/pg-numeric.ts, PR 520): NULLIF's pick, sign, and a percentile_disc / mode()
    // pick (`pickedByExactKey`) each read three times a level, three levels up, then printed, cast and compared
    const chain = (read: string, bottom: string, depth = 3): string => Array.from({ length: depth }, (_, i) => i + 1).reduce((s, k) => `SELECT id, ${read} AS q FROM (${s}) s${k}`, bottom);
    const quotient = "SELECT b.id, b.x / b.y AS q FROM bigdec b";
    const nz = chain("nullif(q, 0) + nullif(q, 0) - nullif(q, 0)", quotient);
    const n25 = chain("nullif(q, 2.5) + nullif(q, 2.5) - nullif(q, 2.5)", quotient);
    const sg = chain("sign(q) + sign(q) - sign(q)", quotient);
    const pd = "SELECT 1 AS id, percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y) AS q FROM bigdec b";
    const md = "SELECT b.id % 2 AS id, mode() WITHIN GROUP (ORDER BY b.x / b.y) AS q FROM bigdec b GROUP BY 1";
    assert.deepEqual(await unlike(c, [
      `SELECT id, q, q::int, q::text FROM (${nz}) s ORDER BY id`,
      `SELECT id, q, q::int8, q * 2 FROM (${n25}) s ORDER BY id`,
      `SELECT id, q, (q * 2.5)::int FROM (${sg}) s ORDER BY id`,
      `SELECT id, q, q::int, q::text FROM (${chain("q + q - q", pd)}) s ORDER BY id`,
      `SELECT id, q, (q * 2)::int FROM (${chain("q + q - q", md)}) s ORDER BY id`,
      `SELECT id, nullif(q, 0) + nullif(q, 0) - sign(q) * nullif(q, 0) AS v FROM (${chain("q + q - q", quotient, 2)}) s ORDER BY id`,
      `SELECT q, count(*) FROM (${nz}) s GROUP BY q ORDER BY 1`,
      `SELECT count(*) FROM (${n25}) s WHERE q IS NULL`,
    ].map((sql) => [sql, "ordered"] as [string, "ordered"])), []);
  } finally { await c.end(); }
});

test("exact path: issue 217 review r3: percentile_disc or mode() over an exact order key read for its nullness or its value is Postgres's", async () => {
  const c = await client();
  try {
    // (class refusal-at-the-call-not-the-reader, review r3 of PR 519: a nullness read is answered, never refused at the call;
    // since PR 506 the aggregate answers the picked row's exact value, so a reader of the value is Postgres's too)
    const keys = ["b.x / b.y", "b.x ^ 2", "nullif(b.x / b.y, 0)", "coalesce(b.x / b.y, 0)", "exp(ln(2.5)) * sign(b.x)", "b.x / b.y + 1",
      "round(b.x / b.y, 2)", "-(b.x / b.y)", "(b.x / b.y)::numeric(40,4)"];
    assert.deepEqual(await unlike(c, keys.flatMap((k): Array<[string, "ordered"]> => [
      [`SELECT b.id % 3 AS g FROM bigdec b GROUP BY 1 HAVING percentile_disc(0.5) WITHIN GROUP (ORDER BY ${k}) IS NOT NULL ORDER BY 1`, "ordered"],
      [`SELECT b.id % 3 AS g, percentile_disc(0.5) WITHIN GROUP (ORDER BY ${k}) IS NULL, mode() WITHIN GROUP (ORDER BY ${k}) IS NOT NULL FROM bigdec b GROUP BY 1 ORDER BY 1`, "ordered"],
    ]).concat([
      ["SELECT CASE WHEN percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y) IS NULL THEN 'none' ELSE 'some' END FROM bigdec b", "ordered"],
      ["SELECT b.id % 3 AS g FROM bigdec b GROUP BY 1 HAVING NOT (mode() WITHIN GROUP (ORDER BY b.x / b.y) IS NULL) ORDER BY 1", "ordered"],
      // (the ARRAY of fractions is refused at the call on main since PR 506, whatever reads it: #538, not this PR's)
      ["SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y) IS NULL FROM bigdec b WHERE false", "ordered"],
      ["SELECT o.id, (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y) IS NOT NULL FROM bigdec b WHERE b.id > o.id) FROM orders o ORDER BY 1", "ordered"],
      ["SELECT b.id % 3 AS g FROM bigdec b GROUP BY 1 HAVING percentile_disc(0.5) WITHIN GROUP (ORDER BY nullif(b.x / b.y, 2.5)) IS NULL ORDER BY 1", "ordered"],
      // a group whose every key is NULL: IS NULL true, as Postgres answers it
      ["SELECT b.id % 3 AS g, percentile_disc(0.5) WITHIN GROUP (ORDER BY nullif(b.x / b.y, b.x / b.y)) IS NULL, mode() WITHIN GROUP (ORDER BY CASE WHEN b.id > 3 THEN b.x / b.y END) IS NULL FROM bigdec b GROUP BY 1 ORDER BY 1", "ordered"],
    ])), []);
    // a reader of the value beside it, its value under coalesce, ::text and + 1: the picked row's exact value, as Postgres
    assert.deepEqual(await unlike(c, [
      ["SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y) IS NULL, percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y) FROM bigdec b", "ordered"],
      ["SELECT coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y), 0) IS NULL FROM bigdec b", "ordered"],
      ["SELECT (percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y))::text IS NULL FROM bigdec b", "ordered"],
      ["SELECT b.id % 3 FROM bigdec b GROUP BY 1 HAVING percentile_disc(0.5) WITHIN GROUP (ORDER BY b.x / b.y) + 1 IS NOT NULL ORDER BY 1", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path: the PRINT reader prints a program beside a *, through s.* and a.* … JOIN (issue 218)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT s.*, count(*) FROM (SELECT b.x / 1 AS q FROM bigdec b) s GROUP BY s.q ORDER BY 1", "ordered"],
      ["SELECT DISTINCT * FROM (SELECT b.x / 1 AS q FROM bigdec b) s, (SELECT 1 AS one) t ORDER BY 1", "ordered"],
      // (over ratios: late's json column is the unit world's own text, not a synced jsonb's)
      ["SELECT *, r.n / 7.0 AS q FROM ratios r ORDER BY r.team, r.id LIMIT 2", "ordered"],
      ["SELECT *, b.x / 1 AS q FROM bigdec b ORDER BY q DESC, b.id", "ordered"],
      ["SELECT s.*, 1 AS one FROM (SELECT l.id, l.k / 7.0 AS q FROM late l) s ORDER BY s.id LIMIT 3", "ordered"],
      ["SELECT a.*, c.name FROM (SELECT l.id, l.c, l.k / 7.0 AS q FROM late l) a JOIN late_c c ON c.id = a.c ORDER BY a.id LIMIT 3", "ordered"],
      ["SELECT DISTINCT l.id, l.k, l.k / 7.0 AS q FROM late l ORDER BY 1 LIMIT 3", "ordered"],
      ["SELECT DISTINCT j.id, j.j, j.t::numeric AS tn FROM jnums j WHERE j.t <> '1_000' ORDER BY tn LIMIT 3", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path: the EQUALITY reader keys a scalar subquery cast to numeric, and a subquery read by s.* (issue 218)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT b.id FROM bigdec b WHERE b.x / 1 = (SELECT c.x / 1 FROM bigdec c WHERE c.id = 1)::numeric(30,20) ORDER BY 1", "ordered"],
      ["SELECT b.id FROM bigdec b WHERE b.x / 1 = (SELECT c.x / 1 FROM bigdec c WHERE c.id = 2)::numeric ORDER BY 1", "ordered"],
      // a subquery read by s.* beside a comparison of its quotient (was refused, numeric-quotient-equality)
      ["SELECT s.*, s.q = 1.00000000000000000001 AS eq FROM (SELECT b.x / 1 AS q FROM bigdec b) s", "bag"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path: the SET OPERATION reader reads a program through a UNION ALL of a WITH query, aggregated outside it (issue 278)", async () => {
  const c = await client();
  try {
    const t3 = "WITH t AS (SELECT o.amount / 3 AS v, o.amount / 7 AS w FROM orders o)";
    const w7 = "WITH t AS (SELECT o.amount / 7 AS v FROM orders o)";
    assert.deepEqual(await unlike(c, [
      ["SELECT r.a FROM ratios r UNION ALL SELECT r.n FROM ratios r ORDER BY 1", "ordered"],
      ["(SELECT o.id, o.status, o.amount / 3 AS third FROM orders o ORDER BY o.id LIMIT 5) UNION ALL SELECT NULL, NULL, 1", "bag"],
      ["SELECT o.amount / 3 FROM orders o UNION ALL SELECT o.qty FROM orders o ORDER BY 1", "ordered"],
      ["(SELECT o.id, o.amount FROM orders o ORDER BY o.id) UNION ALL SELECT NULL, 1 ORDER BY 1, 2", "ordered"],
      ["SELECT u.q, count(*) FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT b.id + 10 FROM bigdec b) u GROUP BY 1", "bag"],
      [`${t3} SELECT v FROM t UNION ALL SELECT w FROM t`, "bag"],
      [`${t3} SELECT v, w FROM t UNION ALL SELECT w, v FROM t`, "bag"],
      ["WITH t AS (SELECT o.amount / 3 AS v FROM orders o) SELECT v FROM t UNION ALL SELECT o.amount FROM orders o", "bag"],
      [`${w7} SELECT sum(v) FROM t UNION ALL SELECT v FROM t`, "bag"],
      ["WITH t AS (SELECT o.id, o.amount / 7 AS v FROM orders o) SELECT t.* FROM t UNION ALL SELECT id, v FROM t", "bag"],
      [`SELECT sum(u.v) FROM (${w7} SELECT v FROM t UNION ALL SELECT v FROM t) u`, "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path: a subquery's column named like a hidden cell is the user's (issue 239)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT s.__mason_cell_0 FROM (SELECT l.k / 7.0 AS __mason_cell_0, l.id FROM late l) s ORDER BY 1 LIMIT 2", "ordered"],
      ["SELECT s.\"__mason_cell_0\", s.id FROM (SELECT l.id, l.k / 7.0 AS __mason_cell_0 FROM late l ORDER BY l.id LIMIT 2) s", "ordered"],
      ["WITH s AS (SELECT l.id, l.k / 7.0 AS __mason_cell_0 FROM late l) SELECT s.__mason_cell_0 FROM s ORDER BY s.id LIMIT 2", "ordered"],
    ]), []);
  } finally { await c.end(); }
});


test("exact path: a value the engine holds exactly keeps its native plan, with no Mason function (issue 252's cost)", async () => {
  const c = await client();
  try {
    for (const sql of ["SELECT o.amount FROM orders o ORDER BY o.amount DESC LIMIT 10", "SELECT sum(o.amount), avg(o.qty) FROM orders o",
      "SELECT o.amount * 2 AS d FROM orders o ORDER BY 1", "SELECT o.qty FROM orders o UNION ALL SELECT o.qty FROM orders o ORDER BY 1",
      "SELECT o.amount FROM orders o UNION SELECT o.amount FROM orders o ORDER BY 1", "SELECT (o.amount * 2)::int, o.amount::text FROM orders o ORDER BY 1",
      "SELECT o.id, rank() OVER (ORDER BY o.amount DESC) FROM orders o ORDER BY 1"]) {
      const plan = (await c.query(`EXPLAIN (VERBOSE) ${sql}`)).rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
      assert.doesNotMatch(plan, /__mason_numeric_(order|program|int|double|key)/, sql);
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
  } finally { await c.end(); }
});

// ISSUE 358, THE CLASS exact-numeric-leaves-exact-path, ROUND 2: the readers PR 341 did not reach, each routed through
// the same authorities (`duckExact`, `programOf` / `exactText`, `exactOrderKey`, `exactKey`, a set operation's record)
const SET_ORDERED = "SELECT b.x / 1 FROM bigdec b UNION ALL SELECT b.x / b.y FROM bigdec b";
/** a statement answered as Postgres answers it, or refused by the named gap (0A000 naming it) */
async function answeredOrRefused(c: pg.Client, sql: string, gap: string, how: "ordered" | "bag" = "ordered"): Promise<string[]> {
  const refused = await answer(c, sql).then(() => null, (e: pg.DatabaseError) => e.code === "0A000" && `${e.message} ${e.detail ?? ""} ${e.hint ?? ""}`.includes(gap) ? e : null);
  return refused !== null ? [] : unlike(c, [[sql, how]]);
}

test("exact path round 2: a set operation's sort, LIMIT and WITH TIES read the exact order key of its record (#352)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      [`${SET_ORDERED} ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES`, "ordered"],
      [`${SET_ORDERED} ORDER BY 1 LIMIT 2`, "ordered"],
      [`${SET_ORDERED} ORDER BY 1 DESC`, "ordered"],
      [`${SET_ORDERED} ORDER BY 1 DESC LIMIT 10 OFFSET 6`, "ordered"],
      ["SELECT b.id, b.x / 1 FROM bigdec b UNION ALL SELECT b.id, b.x / b.y FROM bigdec b ORDER BY 2 DESC, 1", "ordered"],
      ["SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT b.x / b.y FROM bigdec b ORDER BY q DESC LIMIT 3", "ordered"],
      ["SELECT b.x / 1 AS q, (b.x / 1)::text AS t FROM bigdec b UNION ALL SELECT b.id, b.id::text FROM bigdec b ORDER BY 1 DESC, 2", "ordered"],
      ["WITH s AS (SELECT b.x / 1 AS q FROM bigdec b) SELECT q FROM s UNION ALL SELECT q FROM s ORDER BY 1 FETCH FIRST 2 ROWS WITH TIES", "ordered"],
      ["(SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT b.x / b.y FROM bigdec b ORDER BY 1 LIMIT 3) UNION ALL SELECT b.x / 1 FROM bigdec b ORDER BY 1 DESC", "ordered"],
      ["SELECT * FROM (SELECT b.x / 1 AS q FROM bigdec b UNION ALL SELECT b.x / b.y FROM bigdec b) s ORDER BY q DESC LIMIT 3", "ordered"],
      [`SELECT * FROM (${SET_ORDERED} ORDER BY 1 DESC LIMIT 3) s`, "ordered"],
      [`WITH s AS (${SET_ORDERED} ORDER BY 1 LIMIT 2) SELECT * FROM s`, "ordered"],
      [`${SET_ORDERED} ORDER BY 1 DESC NULLS FIRST FETCH FIRST 3 ROWS WITH TIES`, "ordered"],
      ["SELECT b.x / 1 FROM bigdec b WHERE false UNION ALL SELECT b.x / b.y FROM bigdec b WHERE false ORDER BY 1 LIMIT 2", "ordered"],
    ]), []);
    assert.deepEqual(await unlikeBound(c, [bound(`${SET_ORDERED} ORDER BY 1 LIMIT $1`, ["2"])]), []);
    // (a prepared statement executed after a later SET reads the plan made at its Parse)
    const named = { name: "r2_352", text: `${SET_ORDERED} ORDER BY 1 LIMIT $1`, values: ["2"], rowMode: "array" as const, types: raw };
    await c.query(named as pg.QueryConfig);
    await c.query("SET TimeZone = 'Asia/Tokyo'");
    assert.deepEqual((await c.query(named as pg.QueryConfig)).rows, (await postgres(`${SET_ORDERED} ORDER BY 1 LIMIT $1`, ["2"])).rows);
    await c.query("RESET TimeZone");
    // ARMS OF ONE SCALE KEEP THEIR NATIVE PLAN: no Mason function
    for (const sql of ["SELECT o.amount FROM orders o UNION ALL SELECT o.amount FROM orders o ORDER BY 1 LIMIT 2", "SELECT o.amount FROM orders o UNION ALL SELECT o.amount * 1 FROM orders o ORDER BY 1"]) {
      const plan = (await c.query(`EXPLAIN (VERBOSE) ${sql}`)).rows.map((r: Record<string, string>) => r["QUERY PLAN"]).join("\n");
      assert.doesNotMatch(plan, /__mason_(numeric|float)_/, sql);
      assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    }
  } finally { await c.end(); }
});

test("exact path round 2: a VALUES arm and a nested arm are typed by Postgres's analysis, every arm one width (#342)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["VALUES (0.5) UNION ALL SELECT o.amount / 3 FROM orders o ORDER BY 1", "ordered"],
      ["SELECT o.amount / 3 FROM orders o UNION ALL VALUES (0.5) ORDER BY 1", "ordered"],
      ["(SELECT o.id, o.status, o.amount / 3 AS third FROM orders o ORDER BY o.id LIMIT 5) UNION ALL VALUES (0, 'v', 14::numeric) ORDER BY 1", "ordered"],
      ["(WITH t AS (SELECT o.amount / 7 AS v FROM orders o) SELECT * FROM t UNION ALL SELECT v FROM t) UNION ALL (WITH t AS (SELECT o.amount / 7 AS v FROM orders o) SELECT * FROM t UNION ALL SELECT v FROM t) ORDER BY 1", "ordered"],
      ["((SELECT * FROM (SELECT o.amount / 7 AS v FROM orders o) a UNION ALL SELECT o.amount / 3 FROM orders o) UNION ALL VALUES (1.5)) UNION ALL SELECT o.qty FROM orders o ORDER BY 1, 1::text", "ordered"],
      ["VALUES (0.5), (NULL) UNION ALL SELECT o.amount / 3 FROM orders o", "bag"],
      // (a set operation of its own WITH as an arm beside another: its `*` arm reads its own WITH query's cells)
      ["(WITH t AS (SELECT o.amount / 7 AS v FROM orders o) SELECT * FROM t UNION ALL SELECT v FROM t ORDER BY 1 LIMIT 12) UNION ALL SELECT NULL", "bag"],
      ["SELECT 1 UNION ALL ((WITH t AS (SELECT o.amount / 7 AS v FROM orders o) SELECT * FROM t UNION ALL SELECT v FROM t) ORDER BY 1 LIMIT 12)", "bag"],
      // (a VALUES row's constant past the engine's 38 digits beside a table's column: each row its own text)
      ["SELECT b.x FROM bigdec b UNION ALL VALUES ('0.001250000000000000000000000001'::numeric(65,30)) ORDER BY 1", "ordered"],
      ["SELECT o.amount FROM orders o UNION ALL VALUES ('0.001250000000000000000000000000'::numeric(65,30))", "bag"],
      // (a VALUES-first union read outside by its column1)
      ["SELECT s.column1, s.column1::text FROM (VALUES (0.5) UNION ALL SELECT o.amount / 3 FROM orders o ORDER BY 1 LIMIT 6) AS s ORDER BY 2", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path round 2: each arm of a numeric set operation column prints at its own scale (#227)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT o.amount FROM orders o UNION ALL SELECT o.qty FROM orders o ORDER BY 1, 1::text", "ordered"],
      ["SELECT o.qty FROM orders o UNION ALL SELECT 1.5 ORDER BY 1", "ordered"],
      ["VALUES (0, 0.5) UNION ALL SELECT o.qty, o.amount FROM orders o ORDER BY 1, 2", "ordered"],
      ["(SELECT o.id, o.amount FROM orders o ORDER BY o.id) UNION ALL SELECT NULL, 1 ORDER BY 1, 2", "ordered"],
      ["SELECT o.amount FROM orders o UNION ALL SELECT o.qty FROM orders o", "bag"],
      ["SELECT o.amount::text FROM orders o UNION ALL SELECT o.qty::text FROM orders o", "bag"],
      ["SELECT v FROM (SELECT 1 AS v FROM orders o UNION ALL SELECT 1.5 FROM orders o) AS m ORDER BY v, v::text", "ordered"],
      ["SELECT m.v, m.v::text FROM (SELECT o.qty AS v FROM orders o UNION ALL SELECT o.amount FROM orders o) AS m ORDER BY 2", "ordered"],
      // (read outside the union by every reader: a scalar subquery, its text as a sort key, an aggregate, a WITH query)
      ["SELECT (SELECT ms.p FROM (SELECT o.amount AS p FROM orders o UNION ALL SELECT o.qty FROM orders o) AS ms ORDER BY 1 DESC NULLS LAST, ms.p::text COLLATE \"C\" LIMIT 1), (SELECT ms.p FROM (SELECT o.amount AS p FROM orders o UNION ALL SELECT o.qty FROM orders o) AS ms ORDER BY 1 LIMIT 1)", "ordered"],
      ["WITH ms AS (SELECT o.amount AS p FROM orders o UNION ALL SELECT o.qty FROM orders o) SELECT sum(ms.p), min(ms.p), max(ms.p), count(DISTINCT ms.p) FROM ms", "ordered"],
      ["SELECT ms.p::text, ms.p * 2 FROM (SELECT o.amount AS p FROM orders o UNION ALL SELECT o.qty FROM orders o) AS ms ORDER BY 1", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path round 2: a scalar subquery's column is its program, printed, cast, compared and sorted (#350)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT (SELECT b.x / 1 FROM bigdec b WHERE b.id = 2)", "ordered"],
      ["SELECT (SELECT s.q FROM (SELECT b.x / 1 AS q FROM bigdec b WHERE b.id = 2) s)", "ordered"],
      ["SELECT b.id, (SELECT c.x / c.y FROM bigdec c WHERE c.id = b.id) FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT (SELECT s.q FROM (SELECT b.x / 1 AS q FROM bigdec b ORDER BY 1 DESC LIMIT 1) s)", "ordered"],
      ["SELECT (SELECT max(o.amount / 3) FROM orders o)", "ordered"],
      ["SELECT (SELECT c.x / 1 FROM bigdec c WHERE c.id = 2)::numeric(30,20)", "ordered"],
      ["SELECT b.id FROM bigdec b WHERE b.x / 1 IN ((SELECT c.x / 1 FROM bigdec c WHERE c.id = 2)::numeric(30,20)) ORDER BY 1", "ordered"],
      ["SELECT b.id FROM bigdec b WHERE b.x / 1 = (SELECT c.x / 1 FROM bigdec c WHERE c.id = 2 UNION ALL SELECT 0 WHERE false)::numeric(30,20) ORDER BY 1", "ordered"],
      ["SELECT b.id FROM bigdec b WHERE b.x / 1 = (SELECT c.x / 1 FROM bigdec c WHERE c.id = 2)::text::numeric ORDER BY 1", "ordered"],
      ["SELECT b.id, (SELECT c.x / 1 FROM bigdec c WHERE c.id = b.id)::text FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id, (SELECT c.x / 1 FROM bigdec c WHERE c.id = b.id)::int FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id FROM bigdec b WHERE b.id < 3 ORDER BY (SELECT b.x / 1) DESC", "ordered"],
      ["SELECT b.id FROM bigdec b WHERE b.id < 3 ORDER BY (SELECT c.x / 1 FROM bigdec c WHERE c.id = b.id) DESC", "ordered"],
      ["SELECT b.id, (SELECT c.x / 1 FROM bigdec c WHERE c.id = b.id) * 2 FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT sum((SELECT c.x / 1 FROM bigdec c WHERE c.id = b.id)) FROM bigdec b", "ordered"],
      ["SELECT b.id, (SELECT b.x / 1) = (SELECT c.x / 1 FROM bigdec c WHERE c.id = 1) FROM bigdec b ORDER BY 1", "ordered"],
      // (its own ORDER BY or GROUP BY naming the column by number or name sorts the value, never the text in its place)
      ["SELECT (SELECT b.x / 1 AS q FROM bigdec b ORDER BY q DESC LIMIT 1), (SELECT b.x / b.y FROM bigdec b ORDER BY 1 LIMIT 1), (SELECT o.amount / 3 FROM orders o ORDER BY 1 DESC LIMIT 1)", "ordered"],
      ["SELECT (SELECT o.amount / 3 FROM orders o GROUP BY 1 ORDER BY 1 DESC LIMIT 1)", "ordered"],
      ["SELECT (SELECT o.amount / 3 FROM orders o GROUP BY o.amount / 3 ORDER BY 1 LIMIT 1), (SELECT o.amount / 3 FROM orders o GROUP BY o.id ORDER BY o.id LIMIT 1), (SELECT o.amount / 3 FROM orders o GROUP BY o.amount ORDER BY 1 DESC LIMIT 1)", "ordered"],
    ]), []);
    assert.deepEqual(await answeredOrRefused(c, "SELECT ARRAY(SELECT b.x / 1 FROM bigdec b ORDER BY 1)", "array-subquery-element"), []);
  } finally { await c.end(); }
});

/**
 * THE CLASS OF PR 415's REVIEWS r1 AND r2: a set operation's column Postgres resolved as text, read by an arm as a
 * numeric. Every case the change reaches: each arm kind holding a numeric's text, each set operation, each way a
 * numeric becomes text, the plain text arm (a column, a VALUES row, a literal) first, in the middle and last.
 */
const NUMERIC_TEXTS = ["(o.amount / 3)::text", "(o.amount / 3)::varchar", "(o.amount / 3) || ''", "format('%s', o.amount / 3)", "concat(o.amount / 3)", "to_char(o.amount / 3, 'FM9999990.0000000000')"];
const SET_OPERATORS = ["UNION ALL", "UNION", "INTERSECT", "EXCEPT"];
const ARM_KINDS: ReadonlyArray<(x: string) => string> = [
  (x) => `SELECT ${x} FROM orders o`,
  () => "VALUES ((1.5 / 7)::text), (NULL)",
  (x) => `(WITH w AS (SELECT ${x} AS v FROM orders o) SELECT w.v FROM w)`,
  (x) => `(WITH w AS (SELECT ${x} AS v FROM orders o UNION ALL SELECT o.status FROM orders o) SELECT w.v FROM w)`,
  (x) => `SELECT s.v FROM (SELECT ${x} AS v FROM orders o) AS s`,
  (x) => `(SELECT ${x} FROM orders o UNION ALL SELECT (o.amount / 7)::text FROM orders o)`,
];
const TEXT_ARMS = ["SELECT o.status FROM orders o", "VALUES ('abc'), (NULL)", "VALUES (NULL::text)", "SELECT o.status::char(4) FROM orders o"];
function textColumnCases(): Array<[string, "ordered"]> {
  const out: Array<[string, "ordered"]> = [];
  const three = (op: string, arm: string, text: string, at: number): string => {
    const arms = [arm, "SELECT (o.amount / 7)::text FROM orders o"];
    arms.splice(at, 0, text);
    return `${arms.join(` ${op} `)} ORDER BY 1`;
  };
  for (const x of NUMERIC_TEXTS) for (const op of SET_OPERATORS) for (let at = 0; at < 3; at++) out.push([three(op, `SELECT ${x} FROM orders o`, TEXT_ARMS[0]!, at), "ordered"]);
  for (const kind of ARM_KINDS) for (const op of SET_OPERATORS) for (let at = 0; at < 3; at++) out.push([three(op, kind(NUMERIC_TEXTS[0]!), TEXT_ARMS[at % 2]!, at), "ordered"]);
  for (const kind of ARM_KINDS) for (const text of TEXT_ARMS.slice(1)) for (let at = 0; at < 3; at++) out.push([three("UNION ALL", kind(NUMERIC_TEXTS[0]!), text, at), "ordered"]);
  return out;
}

/**
 * THE CLASS OF PR 415's REVIEW r3, refused-by-type-not-by-program, as narrowed after review r5: a value at a fixed scale
 * (round / trunc(x, n), a cast to numeric(p, s)) of a quotient or an avg is computed as main computes it, the engine's
 * double with its program, and the refusals this PR added for a quotient's double do not refuse it: a JOIN … USING or a
 * NATURAL JOIN on it, and an array_agg of a cast of one (the engine's DECIMAL(p, s), as main's). Where main refuses
 * (a set operation without ALL, a grouping set, sum(DISTINCT), a WITH query's or a subquery's column compared outside
 * it, an array_agg of a round, whose doubles print 40.0 for 40.00), it is refused, never answered otherwise. An array_agg
 * whose elements no reader sees (its length, its bounds) is answered whatever its elements.
 */
const FIXED_SCALES = ["round(o.amount / 3, 2)", "round(o.amount / 4, 2)", "trunc(o.amount / 3, 2)", "round(o.amount / 7)", "(o.amount / 3)::numeric(10,2)", "(o.amount / 4)::numeric(10,2)", "CAST(o.amount / 7 AS decimal(12,4))",
  // (a negative scale is Postgres's 0; a value at a fixed scale of another)
  "round(o.amount / 3, -1)", "trunc(o.amount / 7, -1)", "round((o.amount / 3)::numeric(10,4), 2)", "round(round(o.amount / 7, 4), 2)"];
type FixedScaleCase = readonly [string, "answered" | "numeric-quotient-equality" | "array-subquery-element" | "numeric-exact-sum" | "row-value"];
function fixedScaleCases(): FixedScaleCase[] {
  const out: FixedScaleCase[] = [];
  for (const x of FIXED_SCALES) {
    // (a cast, and a round of one, are the engine's DECIMAL at Postgres's scale, as main writes them)
    const decimal = /^\(|^CAST|^round\(\(/.test(x);
    out.push(
      // (this PR's USING refusal of a quotient's double: never of a value at a fixed scale, answered as main answers it)
      [`SELECT count(*) FROM (SELECT ${x} AS q FROM orders o) s JOIN (SELECT o.amount AS q FROM orders o) u USING (q)`, "answered"],
      [`SELECT q FROM (SELECT ${x} AS q FROM orders o) s JOIN (SELECT ${x} AS q FROM orders o) u USING (q) ORDER BY q`, "answered"],
      [`SELECT count(*) FROM (SELECT ${x} AS q FROM orders o) s NATURAL JOIN (SELECT ${x} AS q FROM orders o) u`, "answered"],
      // (main's refusals: the merged column grouped outside the subquery, a set operation without ALL, a grouping set,
      // sum(DISTINCT), a WITH query's column compared outside it)
      [`SELECT q, count(*) FROM (SELECT ${x} AS q FROM orders o) s NATURAL JOIN (SELECT ${x} AS q FROM orders o) u GROUP BY q ORDER BY q`, "numeric-quotient-equality"],
      [`SELECT ${x} FROM orders o UNION SELECT ${x} FROM orders o WHERE o.id = 1 ORDER BY 1`, "numeric-quotient-equality"],
      [`SELECT ${x} FROM orders o INTERSECT SELECT ${x} FROM orders o ORDER BY 1`, "numeric-quotient-equality"],
      [`SELECT ${x} FROM orders o EXCEPT SELECT ${x} FROM orders o WHERE o.id = 1 ORDER BY 1`, "numeric-quotient-equality"],
      [`SELECT ${x} AS q, count(*) FROM orders o GROUP BY ROLLUP (1) ORDER BY 1`, "numeric-quotient-equality"],
      [`SELECT sum(DISTINCT ${x}), count(DISTINCT ${x}) FROM orders o`, "numeric-quotient-equality"],
      [`WITH RECURSIVE r(q, n) AS (SELECT ${x}, 1 FROM orders o UNION ALL SELECT r.q, r.n + 1 FROM r WHERE r.n < 2) SELECT q, count(*) FROM r WHERE r.q = 6.67 OR r.q > 10 GROUP BY q ORDER BY q`, "numeric-quotient-equality"],
      // (an array_agg of a cast is the engine's DECIMAL(p, s), main's; of a round, this PR's refusal of a double's list)
      [`SELECT array_to_string(array_agg(${x} ORDER BY o.id), ',') FROM orders o`, decimal ? "answered" : "array-subquery-element"],
      // (read by a list or a subquery, beside more decimals or not: main's path, the engine never cuts a scale)
      [`SELECT o.id FROM orders o WHERE ${x} = ANY (ARRAY[0.67, 6.67, 40.00]) ORDER BY 1`, "answered"],
      [`SELECT o.id FROM orders o WHERE ${x} = ANY (ARRAY[0.667, 6.6667, 40.001, 2.5]) ORDER BY 1`, "answered"],
      [`SELECT o.id FROM orders o WHERE ${x} IN (SELECT (u.amount / 3)::numeric(10,4) FROM orders u) ORDER BY 1`, "answered"],
    );
  }
  return out;
}

/**
 * PR 415's reviews r4 and r5 (fixed-scale-whole-digits-cap, widening-reader-off-the-list): a value at a fixed scale past
 * 10^20 (amount × 10^20 / 3), or beside a numeric of more decimals, in every reader the engine widens two numerics in —
 * a row comparison, a comparison with a wider literal or a scalar subquery, BETWEEN, arithmetic, abs / sign / mod, an
 * ORDER BY of a difference, a single-row VALUES, a list, a set operation, COALESCE / CASE / GREATEST — and printed with
 * more whole digits than a DECIMAL holds beside its scale: answered as main answers it (the engine's double with its
 * program), never a 22003 nor a cut scale, or refused where main refuses.
 */
function bigFixedScaleCases(): FixedScaleCase[] {
  const big = "o.amount * 100000000000000000000";
  return [
    [`SELECT o.id, round(${big} / 3, 2), trunc(${big} / 7, 1), round(${big} / 3), (${big} / 3)::numeric(38,2) FROM orders o ORDER BY o.id`, "answered"],
    [`SELECT o.id, round(${big} / 3, 2) FROM orders o WHERE o.id = 2`, "answered"],
    [`SELECT o.id FROM orders o WHERE round(${big} / 3, 2) > 1000000000000000000000 ORDER BY 1`, "answered"],
    [`SELECT round(${big} / 3, 2) AS q, count(*) FROM orders o GROUP BY 1 ORDER BY 1`, "answered"],
    [`SELECT DISTINCT round(${big} / 3, 2) FROM orders o ORDER BY 1`, "answered"],
    [`SELECT round(avg(${big}), 2), round(avg(${big}), 18), round(avg(${big}) / 7, 3), round(sum(${big}) / 7, 2) FROM orders o`, "answered"],
    [`SELECT count(*) FROM (SELECT round(avg(${big}), 2) AS q FROM orders o) s JOIN (SELECT ${big} AS q FROM orders o) u USING (q)`, "answered"],
    [`SELECT o.id, round(${big} / 3, 2) + o.amount / 7, round(${big} / 3, 2) - 0.333333333333333333, abs(round(${big} / 3, 2) - 2.5), sign(round(${big} / 3, 2) - 2.5) FROM orders o ORDER BY 1`, "answered"],
    [`SELECT o.id FROM orders o WHERE round(${big} / 3, 2) = 2.33::numeric(38,18) OR round(${big} / 3, 2) > (SELECT max(u.amount) FROM orders u) ORDER BY 1`, "answered"],
    [`SELECT o.id FROM orders o WHERE round(${big} / 3, 2) BETWEEN 0.333333333333333333 AND 10000000000000000000000 ORDER BY 1`, "answered"],
    [`SELECT o.id FROM orders o ORDER BY round(${big} / 3, 2) - 0.333333333333333333 DESC, o.id`, "answered"],
    [`SELECT o.id, v.x FROM orders o JOIN (VALUES (0.333333333333333333)) v(x) ON round(${big} / 3, 2) = v.x ORDER BY 1`, "answered"],
    // (main's: a sum past 20 whole digits; an array_agg of a round, this PR's)
    [`SELECT sum(round(${big} / 3, 2)), max(round(${big} / 3, 2)) FROM orders o`, "numeric-exact-sum"],
    [`SELECT array_to_string(array_agg(round(${big} / 3, 2) ORDER BY o.id), ',') FROM orders o`, "array-subquery-element"],
  ];
}

/** a row comparison of a value at a fixed scale beside one of more decimals (review r5's wrong answers): main's */
function rowFixedScaleCases(): FixedScaleCase[] {
  const out: FixedScaleCase[] = [];
  for (const x of ["round(o.amount / 3, 2)", "round(o.amount / 3, 4)", "(o.amount / 3)::numeric(10,2)"]) {
    out.push(
      [`SELECT o.id FROM orders o WHERE (${x}, o.id) = ((o.amount / 3)::numeric(10,4), o.id) ORDER BY 1`, "row-value"],
      [`SELECT o.id, row(${x}, o.id) = row(26.8333, o.id), (${x}, o.id) < (o.amount, o.id), (${x}, o.id) <> (26.8333, o.id) FROM orders o ORDER BY 1`, "row-value"],
    );
  }
  return out;
}

/**
 * Where the engine unifies a value at a fixed scale with another type — a list, a subquery's comparison, a set
 * operation's arms, COALESCE / CASE / GREATEST — and the other has more decimals: main's path, so no scale is cut
 */
function widenedFixedScaleCases(): Array<[string, "ordered"]> {
  const out: Array<[string, "ordered"]> = [];
  for (const x of ["round(o.amount / 3, 2)", "round(o.amount / 3)", "(o.amount / 3)::numeric(10,2)"]) {
    const y = x.replaceAll("o.", "u.");
    out.push(
      [`SELECT o.id FROM orders o WHERE ${x} = ANY (ARRAY[26.8333, 40.001, 14.0001, 0.5]) ORDER BY 1`, "ordered"],
      [`SELECT o.id FROM orders o WHERE (o.amount / 3)::numeric(10,4) IN (SELECT ${y} FROM orders u) ORDER BY 1`, "ordered"],
      [`SELECT o.id, ${x} = ANY (SELECT (u.amount / 3)::numeric(10,4) FROM orders u) FROM orders o ORDER BY 1`, "ordered"],
      [`SELECT sum(s.x), count(DISTINCT s.x) FROM (SELECT ${x} AS x FROM orders o UNION ALL SELECT (o.amount / 3)::numeric(10,4) FROM orders o) s`, "ordered"],
      // (each value compared, not printed: a CASE's mixed scales print as the listed mixed-scale-numeric, as main's)
      [`SELECT o.id, coalesce(CASE WHEN o.id = 1 THEN NULL ELSE ${x} END, 0.3333) = 0.3333, greatest(${x}, 26.8333) = 26.8333, (CASE WHEN o.id = 2 THEN 0.3333 ELSE ${x} END) = 0.3333 FROM orders o ORDER BY 1`, "ordered"],
    );
  }
  return out;
}

test("exact path round 2: a value at a fixed scale is answered as main answers it, never refused by its type, and an array whose elements no reader sees is answered (PR 415, refused-by-type-not-by-program)", async () => {
  const c = await client();
  try {
    const cases = [...fixedScaleCases(), ...bigFixedScaleCases(), ...rowFixedScaleCases()];
    assert.deepEqual(await unlike(c, [
      ...cases.filter(([, e]) => e === "answered").map(([s]) => [s, "ordered"] as const),
      ["SELECT count(*) FROM (SELECT round(avg(o.amount), 2) AS q FROM orders o) s JOIN (SELECT o.amount AS q FROM orders o) u USING (q)", "ordered"],
      ["SELECT q FROM (SELECT avg(o.amount)::numeric(12,2) AS q FROM orders o) s JOIN (SELECT avg(o.amount)::numeric(12,2) AS q FROM orders o) u USING (q)", "ordered"],
      ["SELECT array_to_string(array_agg((o.amount / 4)::numeric(10,2) ORDER BY o.id), ',') FROM orders o", "ordered"],
      ["SELECT array_length(array_agg(o.amount / 3), 1), cardinality(array_agg(o.amount / 3)), array_upper(array_agg(o.amount / 7), 1) FROM orders o", "ordered"],
      ["SELECT array_length(array_agg(o.amount / 3), 1) FROM orders o WHERE false", "ordered"],
      ["SELECT o.status, array_length(array_agg(o.amount / 7 ORDER BY o.id), 1) FROM orders o GROUP BY o.status ORDER BY 1", "ordered"],
      ["SELECT array_length(array_agg(round(o.amount / 3, 2)), 1) FROM orders o", "ordered"],
      // (an array_agg of a FROM item's column cast to numeric(p, s), and of a round of a cast, grouped: main's DECIMALs)
      ["SELECT array_to_string(array_agg(s.q ORDER BY s.q), ',') FROM (SELECT o.status, avg(o.amount)::numeric(12,2) AS q FROM orders o GROUP BY o.status) s", "ordered"],
      ["SELECT o.status, array_to_string(array_agg(round((o.amount / 3)::numeric(10,4), 2) ORDER BY o.id), ',') FROM orders o GROUP BY o.status ORDER BY 1", "ordered"],
      // (a text read as numeric, rounded: its program parses a text, so it keeps the path it had, computed after the
      // engine's answer — a generated table's TEXT reason reads it there, tests/duck-generated-round5.test.ts)
      ["SELECT o.id, round((o.meta ->> 'k')::numeric, 2), trunc((o.meta ->> 'k')::numeric / 3, 2) FROM orders o ORDER BY o.id", "ordered"],
      ...widenedFixedScaleCases(),
    ]), []);
    const failures: string[] = [];
    for (const [s, gap] of cases) if (gap !== "answered") failures.push(...await answeredOrRefused(c, s, gap));
    assert.deepEqual(failures, []);
    // (what stays refused, where the engine's double would reach the answer: a plain quotient's and an avg's USING key,
    // a JSON number's text rounded, an array_agg whose elements are read)
    assert.deepEqual(await answeredOrRefused(c, "SELECT count(*) FROM (SELECT o.amount / 3 AS q FROM orders o) s JOIN (SELECT o.amount * (1.0 / 3) AS q FROM orders o) u USING (q)", "numeric-quotient-equality"), []);
    assert.deepEqual(await answeredOrRefused(c, "SELECT array_agg(o.amount / 3 ORDER BY o.id) FROM orders o", "array-subquery-element"), []);
    assert.deepEqual(await answeredOrRefused(c, "SELECT count(*) FROM (SELECT round((o.meta ->> 'k')::numeric, 2) AS q FROM orders o) s JOIN (SELECT o.amount AS q FROM orders o) u USING (q)", "numeric-quotient-equality"), []);
    // (a set operation without ALL of a value at a fixed scale beside one of more decimals: main's refusal)
    for (const op of ["UNION", "INTERSECT", "EXCEPT"]) {
      assert.deepEqual(await answeredOrRefused(c, `SELECT round(o.amount / 3, 2) FROM orders o ${op} SELECT (o.amount / 3)::numeric(10,4) FROM orders o ORDER BY 1`, "numeric-quotient-equality"), []);
    }
    for (const x of ["round(o.amount / 3, 2)", "round(o.amount / 3)", "(o.amount / 3)::numeric(10,2)"]) {
      assert.deepEqual(await answeredOrRefused(c, `SELECT o.id, v.x = 26.8333, v.x > 26.83 FROM orders o, LATERAL (VALUES (${x}), (26.8333)) v(x) ORDER BY o.id, 1`, "numeric-quotient-equality"), []);
    }
  } finally { await c.end(); }
});

test("exact path round 2: a text column of a set operation is never read as a numeric, whatever the arm, the operator, the conversion or the text arm's place (PR 415's class)", async () => {
  const c = await client();
  try {
    // (main's own, never this PR's to fix: UNION, INTERSECT and EXCEPT without ALL of a numeric's text are refused by
    // name, #298; a numeric made text by concat, format or || is the engine's double's text, #421 — answered, never an
    // error)
    const cases = textColumnCases();
    const distinct = cases.filter(([s]) => / (UNION|INTERSECT|EXCEPT) (?!ALL)/.test(s));
    const viaFunction = cases.filter(([s]) => !distinct.some(([d]) => d === s) && /concat\(|format\(|\|\| ''/.test(s));
    const failures: string[] = [];
    for (const [s] of distinct) failures.push(...await answeredOrRefused(c, s, "numeric-quotient-equality"));
    for (const [s] of viaFunction) await answer(c, s).catch((e: Error) => failures.push(`${s}\n    mason: ${e.message}`));
    assert.deepEqual(failures, []);
    assert.deepEqual(await unlike(c, [
      ...cases.filter(([s]) => !distinct.some(([d]) => d === s) && !viaFunction.some(([v]) => v === s)),
      // (review r2: a VALUES arm beside a numeric's text column, the wrapper's width)
      ["SELECT (o.amount / 3)::text FROM orders o UNION ALL VALUES (NULL::text) ORDER BY 1", "ordered"],
      ["SELECT (o.amount / 3)::text FROM orders o UNION ALL VALUES (NULL) ORDER BY 1", "ordered"],
      ["SELECT (o.amount / 3)::text FROM orders o UNION ALL VALUES ((1.5 / 7)::text) ORDER BY 1", "ordered"],
      ["VALUES ((1.5 / 7)::text) UNION ALL SELECT (o.amount / 3)::text FROM orders o ORDER BY 1", "ordered"],
      ["SELECT (o.amount / 3)::text, o.id FROM orders o UNION ALL VALUES ((2.5 / 7)::text, 0), (NULL, 1) ORDER BY 2, 1", "ordered"],
      ["SELECT (o.amount / 3)::text, o.amount / 7 FROM orders o UNION ALL VALUES (NULL::text, 1.5) ORDER BY 2, 1", "ordered"],
      ["SELECT o.amount / 7, (o.amount / 3)::text FROM orders o UNION ALL VALUES (1.5, NULL::text) ORDER BY 1, 2", "ordered"],
      ["VALUES (1.5, NULL::text) UNION ALL SELECT o.amount / 7, (o.amount / 3)::text FROM orders o ORDER BY 1, 2", "ordered"],
      ["SELECT * FROM (SELECT (o.amount / 3)::text AS x, o.amount / 7 AS y FROM orders o) s UNION ALL VALUES (NULL::text, 1.5) ORDER BY 2, 1", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path round 2: a text column of a set operation is a numeric's text only where every arm's is, never a text, a char(n) or a literal parsed as one (PR 415)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT (o.amount / 3)::text FROM orders o UNION ALL SELECT o.status FROM orders o ORDER BY 1", "ordered"],
      ["SELECT (o.amount / 3)::text FROM orders o UNION ALL SELECT o.status FROM orders o", "bag"],
      ["SELECT o.status FROM orders o UNION ALL SELECT (o.amount / 3)::text FROM orders o ORDER BY 1", "ordered"],
      ["SELECT (o.amount / 3)::text FROM orders o UNION ALL SELECT 'abc' ORDER BY 1", "ordered"],
      ["SELECT 'abc' UNION ALL SELECT (o.amount / 3)::text FROM orders o ORDER BY 1", "ordered"],
      ["SELECT (o.amount / 3)::text FROM orders o UNION ALL SELECT o.status::char(4) FROM orders o ORDER BY 1", "ordered"],
      ["SELECT avg(o.amount)::text FROM orders o UNION ALL SELECT o.status FROM orders o ORDER BY 1", "ordered"],
      ["SELECT o.amount::text FROM orders o UNION ALL SELECT o.status FROM orders o ORDER BY 1", "ordered"],
      ["SELECT x FROM (SELECT (o.amount / 3)::text AS x FROM orders o UNION ALL SELECT o.status FROM orders o) s ORDER BY 1", "ordered"],
      ["SELECT x FROM (SELECT (o.amount / 3)::text AS x FROM orders o UNION ALL SELECT 'abc') s ORDER BY 1", "ordered"],
      ["SELECT (o.amount / 3)::text, o.id FROM orders o UNION ALL SELECT o.status, o.id FROM orders o ORDER BY 2, 1", "ordered"],
      // (every arm a numeric's text or a NULL: still the record's, each arm's quotient at Postgres's digits)
      ["SELECT (o.amount / 3)::text FROM orders o UNION ALL SELECT (o.amount / 7)::text FROM orders o UNION ALL SELECT NULL ORDER BY 1", "ordered"],
      ["SELECT (b.x / b.y)::text FROM bigdec b UNION ALL SELECT (b.x / 3)::text FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT (SELECT s.q FROM (SELECT * FROM ((SELECT o.id, o.amount / 7 AS q FROM orders o ORDER BY 2 FETCH FIRST 1 ROWS WITH TIES) UNION ALL SELECT 0, 1) s ORDER BY 1) AS s ORDER BY 1 DESC NULLS LAST, s.q::text COLLATE \"C\" LIMIT 1)", "ordered"],
      ["(SELECT o.id, abs(o.amount), sign(o.amount), -o.amount, +o.amount FROM orders o ORDER BY o.id) UNION ALL SELECT NULL, 1, 1, 1, 1", "ordered"],
      ["SELECT NULL, 1, 1, 1, 1 UNION ALL (SELECT o.id, abs(o.amount), sign(o.amount), -o.amount, +o.amount FROM orders o ORDER BY o.id)", "ordered"],
      ["(SELECT b.id, abs(b.x), sign(b.x), -b.x, +b.x FROM bigdec b ORDER BY b.id) UNION ALL SELECT NULL, 1, 1, 1, 1", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path round 2: a window's min, max, first_value, last_value, nth_value, lag and lead pick the program (#343)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT b.id, max(b.x / 1) OVER (), min(b.x / 1) OVER (ORDER BY b.id) FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT o.id, min(o.amount / 3) OVER (PARTITION BY o.status), max(o.amount / 3) OVER () FROM orders o ORDER BY o.id", "ordered"],
      ["SELECT b.id, first_value(b.x / b.y) OVER (ORDER BY b.id DESC), last_value(b.x / 1) OVER (ORDER BY b.id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING), nth_value(b.x / 1, 2) OVER (ORDER BY b.id) FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT s.id, lead(s.x, 1, 0) OVER (ORDER BY s.id), lag(s.x) OVER (ORDER BY s.id) FROM (SELECT o.id, o.amount / 3 AS x FROM orders o) s ORDER BY 1", "ordered"],
      ["SELECT b.id FROM bigdec b ORDER BY max(b.x / 1) OVER (PARTITION BY b.id) DESC, b.id", "ordered"],
      ["SELECT b.id FROM bigdec b ORDER BY first_value(b.x / 1) OVER (PARTITION BY b.id) DESC, b.id", "ordered"],
      ["SELECT b.y, max(max(b.x / 1)) OVER (), min(min(b.x / b.y)) OVER () FROM bigdec b GROUP BY b.y ORDER BY 1", "ordered"],
      ["SELECT b.id, lag(b.x / b.y, 1, b.x / 3) OVER (ORDER BY b.id) FROM bigdec b ORDER BY 1", "ordered"],
      ["SELECT b.id, (max(b.x / 1) OVER ())::text, max(b.x / 1) OVER () * 2 FROM bigdec b ORDER BY 1", "ordered"],
    ]), []);
    assert.deepEqual(await answeredOrRefused(c, "SELECT array_agg(q ORDER BY q DESC) FROM (SELECT b.x / 1 AS q FROM bigdec b) s", "array-subquery-element"), []);
  } finally { await c.end(); }
});

test("exact path round 2: a grouped query's output key is its analysed expression, whatever the GROUP BY's spelling (#353)", async () => {
  const c = await client();
  try {
    assert.deepEqual(await unlike(c, [
      ["SELECT b.id, b.x / 1 AS q FROM bigdec b WHERE b.id < 3 GROUP BY b.id, b.x ORDER BY q DESC", "ordered"],
      ["SELECT b.id, b.x / 1 AS q FROM bigdec b WHERE b.id < 3 GROUP BY b.id, b.x ORDER BY 2 DESC", "ordered"],
      ["SELECT b.id, b.x / 1 AS q FROM bigdec b GROUP BY b.id, b.x HAVING count(*) > 0 ORDER BY q DESC, 1", "ordered"],
      ["SELECT b.id, b.x / 1 AS q FROM bigdec b WHERE b.id < 3 GROUP BY b.id, b.x ORDER BY q DESC FETCH FIRST 1 ROWS WITH TIES", "ordered"],
      ["SELECT b.id, b.x / 1 AS q, rank() OVER (ORDER BY b.x / 1 DESC) FROM bigdec b GROUP BY b.id, b.x ORDER BY 3, 1", "ordered"],
      ["SELECT b.x / b.y AS q, count(*) FROM bigdec b GROUP BY b.x, b.y ORDER BY q DESC", "ordered"],
      ["SELECT b.id, b.x / 1 AS q FROM bigdec b WHERE b.id < 3 GROUP BY b.id, b.x / b.y, b.x ORDER BY q DESC", "ordered"],
      ["SELECT b.x / 1 AS q, count(*) FROM bigdec b GROUP BY 1 ORDER BY 2 DESC, 1 FETCH FIRST 1 ROWS WITH TIES", "ordered"],
    ]), []);
  } finally { await c.end(); }
});

test("exact path round 2: JOIN … USING and NATURAL JOIN on a carried quotient equate its exact key, or refuse by name (#218)", async () => {
  const c = await client();
  try {
    const s = "(SELECT b.x / 1 AS q FROM bigdec b) s", t = "(SELECT b.x / 1 AS q FROM bigdec b) t";
    for (const [sql, how] of [
      [`SELECT count(*) FROM ${s} JOIN ${t} USING (q)`, "ordered"],
      [`SELECT count(*) FROM ${s} NATURAL JOIN ${t}`, "ordered"],
      [`SELECT q FROM ${s} JOIN ${t} USING (q) ORDER BY 1`, "ordered"],
      ["SELECT * FROM (SELECT b.id, b.x / 1 AS q FROM bigdec b) s LEFT JOIN (SELECT b.x / b.y AS q, b.id AS j FROM bigdec b) t USING (q) ORDER BY 2, 3", "ordered"],
      ["SELECT q FROM (SELECT b.x / 1 AS q FROM bigdec b WHERE b.id < 4) s FULL JOIN (SELECT b.x / b.y AS q FROM bigdec b) t USING (q) ORDER BY 1", "ordered"],
      // (a quotient over a VALUES list's typed constants, and over a value no program is built for: the engine's double either way)
      ["SELECT count(*) FROM (SELECT v.x / 1 AS q FROM orders o, (VALUES (1.00000000000000000001::numeric(30,20))) AS v(x)) s JOIN (SELECT v.x / 1 AS q FROM orders o, (VALUES (1.00000000000000000002::numeric(30,20))) AS v(x)) t USING (q)", "ordered"],
      ["SELECT count(*) FROM (SELECT sqrt(o.amount) AS q FROM orders o) s JOIN (SELECT sqrt(o.amount) AS q FROM orders o) t USING (q)", "ordered"],
    ] as const) assert.deepEqual(await answeredOrRefused(c, sql, "numeric-quotient-equality", how), [], sql);
    assert.deepEqual(await unlike(c, [[`SELECT count(*) FROM ${s} JOIN ${t} ON s.q = t.q`, "ordered"]]), []);
  } finally { await c.end(); }
});

// THE COLLATION RESOLVER (issue 253, decision B; issues 121, 122, 125, 150, 213): which collation orders a text is
// Postgres's analysis, what it means src/duck/collation.ts's, and every reader asks it: a column's own collation, a
// COLLATE on either side of a comparison, a derived table's COLLATE read through the table around it, and a SELECT of no
// table that orders text, each answered as Postgres answers
const COLLS_ROWS = "(1, ''), (2, ' alpha'), (3, '10'), (4, 'Beta'), (5, 'alpha'), (6, 'b'), (7, 'A'), (8, 'a'), (9, 'é'), (10, 'e'), (11, '-x'), (12, 'w'), (13, NULL)";
const collsTable: PgSchema["tables"][number] = { name: "colls", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "d", type: "text" },
  { name: "c", type: "text", collation: { schema: "pg_catalog", name: "C" } }, { name: "i", type: "text", collation: { schema: "pg_catalog", name: "und-x-icu" } }] };
const PG_COLLATIONS = [
  { schema: "pg_catalog", name: "C", provider: "c", collate: "C", locale: null, deterministic: true },
  { schema: "pg_catalog", name: "POSIX", provider: "c", collate: "POSIX", locale: null, deterministic: true },
  { schema: "pg_catalog", name: "und-x-icu", provider: "i", collate: null, locale: "und", deterministic: true },
];
let collsMade = false;
async function makeColls(): Promise<void> {
  if (collsMade) return;
  collsMade = true;
  await store.writer.run("CREATE TABLE public.colls (id INTEGER PRIMARY KEY, d VARCHAR, c VARCHAR, i VARCHAR)");
  await store.writer.run(`INSERT INTO public.colls SELECT id, x, x, x FROM (VALUES ${COLLS_ROWS}) AS s(id, x)`);
  await truth.exec("CREATE TABLE public.colls (id int PRIMARY KEY, d text, c text COLLATE \"C\", i text COLLATE \"und-x-icu\")");
  await truth.exec(`INSERT INTO public.colls SELECT id, x, x, x FROM (VALUES ${COLLS_ROWS}) AS s(id, x)`);
}
async function collsApi(duck: Parameters<typeof startPostgresApi>[0]["duck"], extra: NonNullable<PgSchema["collations"]> = []): Promise<{ api: PgApiServer; c: pg.Client }> {
  await makeColls();
  const withColls: PgSchema = { ...schema, tables: [...schema.tables, collsTable], collations: [...PG_COLLATIONS, ...extra] };
  const a = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => withColls, record: () => undefined, log: (l) => (logged.push(l), everLogged.push(l)), duck,
  });
  const c = new pg.Client({ host: "127.0.0.1", port: a.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  return { api: a, c };
}

test("collation resolver: a column's own collation, a COLLATE on either side, a derived table's and no table's order are Postgres's", async () => {
  const { api: a, c } = await collsApi(await store.listener(undefined, undefined, undefined, () => copies, undefined, { collations: PG_COLLATIONS }));
  try {
    for (const sql of [
      // #121 a column's own collation: a star, by number, a top N, compared, min and max, an aggregate's order, a window
      "SELECT * FROM colls ORDER BY i, id", "SELECT * FROM colls ORDER BY 4 DESC NULLS LAST, 1 LIMIT 5", "SELECT id FROM colls WHERE i > 'b' ORDER BY id",
      "SELECT min(i), max(i), min(c), max(c) FROM colls", "SELECT id, greatest(i, 'b'), least(i, 'B') FROM colls ORDER BY id",
      "SELECT string_agg(i, ',' ORDER BY i) FROM colls", "SELECT id, row_number() OVER (ORDER BY i, id) FROM colls ORDER BY id",
      "SELECT i, count(*) FROM colls GROUP BY i ORDER BY 1", "SELECT DISTINCT ON (i) i, id FROM colls ORDER BY i, id",
      "SELECT a.i, b.id FROM colls a JOIN colls b ON b.id = a.id ORDER BY a.i, b.id LIMIT 4",
      "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY i), mode() WITHIN GROUP (ORDER BY i) FROM colls",
      "SELECT column_name, collation_name FROM information_schema.columns WHERE table_name = 'colls' ORDER BY ordinal_position",
      // #150 a COLLATE on the right, the left, both, in BETWEEN, a row comparison
      "SELECT id FROM colls WHERE d > 'b' COLLATE \"und-x-icu\" ORDER BY id", "SELECT id FROM colls WHERE d COLLATE \"und-x-icu\" > 'b' ORDER BY id",
      "SELECT id FROM colls WHERE i <= 'B' COLLATE \"C\" ORDER BY id", "SELECT id FROM colls WHERE d BETWEEN 'A' AND 'b' COLLATE \"und-x-icu\" ORDER BY id",
      "SELECT id FROM colls WHERE d NOT BETWEEN (' a' COLLATE \"und-x-icu\") AND 'z' ORDER BY id",
      "SELECT id, CASE WHEN d > 'b' COLLATE \"und-x-icu\" THEN 1 ELSE 0 END FROM colls ORDER BY id",
      "SELECT id, greatest(d, 'b' COLLATE \"und-x-icu\") FROM colls ORDER BY id", "SELECT min(d COLLATE \"und-x-icu\") FROM colls",
      // a char(n) ordered without its padding, its value read back whole
      "SELECT id, greatest(d::char(4) COLLATE \"und-x-icu\", 'b'), least(d::char(4), 'B' COLLATE \"und-x-icu\") FROM colls ORDER BY id",
      // two equal char(n) values of another padding: the first argument, as Postgres keeps it
      "SELECT id, least(d::char(6) COLLATE \"und-x-icu\", d::char(2)), greatest(d::char(2) COLLATE \"und-x-icu\", d::char(6)) FROM colls ORDER BY id",
      // ... under byte order too, and a char(n) beside a text, which Postgres compares as a char(n)
      "SELECT id, least(d::char(6) COLLATE \"C\", d::char(2)), greatest(d::char(2) COLLATE \"C\", d::char(6)) FROM colls ORDER BY id",
      "SELECT id, least(d::char(6) COLLATE \"C\", d), greatest(d::char(4), d COLLATE \"C\") FROM colls ORDER BY id",
      // #213 a derived table's COLLATE, read through the table around it
      "SELECT * FROM (SELECT a.d COLLATE \"und-x-icu\" AS n FROM colls a ORDER BY 1 LIMIT 8) s ORDER BY s.n",
      "SELECT * FROM (SELECT d COLLATE \"und-x-icu\" AS n, count(*) AS k FROM colls GROUP BY 1) s ORDER BY s.n",
      "SELECT * FROM (SELECT d COLLATE \"und-x-icu\" AS n, count(*) AS k FROM colls GROUP BY 1) s ORDER BY 1",
      "WITH s AS (SELECT d COLLATE \"und-x-icu\" AS n, id FROM colls) SELECT n FROM s ORDER BY n, id",
      "SELECT n FROM (SELECT i AS n FROM colls UNION ALL SELECT i FROM colls) s ORDER BY n",
      "SELECT max(n) FROM (SELECT d COLLATE \"und-x-icu\" AS n FROM colls) s",
      // #122 no table under a COLLATE that is not byte order
      "SELECT 'a' < 'B' COLLATE \"und-x-icu\", ' alpha' COLLATE \"und-x-icu\" < '10'",
      "SELECT x FROM (VALUES ('b'), ('A'), (' a'), ('10')) AS v(x) ORDER BY x COLLATE \"und-x-icu\"",
      // no table, computing a numeric: the catalog's exact digits (the synced data holds a VALUES list's otherwise)
      "SELECT length((v.x / 1)::text), (v.x / 1)::text || '' FROM (VALUES (1.00000000000000000001::numeric(30,20)), (2.5)) AS v(x) ORDER BY 1, (v.x / 1)::text COLLATE \"und-x-icu\"",
    ]) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
    // no table, as a simple Query, naming a parameter: Postgres's 42P02 from the catalog, never a Bind's protocol error
    await assert.rejects(c.query("SELECT $1::text < $2::text COLLATE \"und-x-icu\""), (e: pg.DatabaseError) => e.code === "42P02");
    // Postgres's errors, from the analysis: two explicit COLLATEs, two implicit ones
    await assert.rejects(c.query("SELECT id FROM colls WHERE c COLLATE \"C\" > i COLLATE \"und-x-icu\""), (e: pg.DatabaseError) => e.code === "42P21");
    await assert.rejects(c.query("SELECT id FROM colls WHERE c > i"), (e: pg.DatabaseError) => e.code === "42P22");
    await assert.rejects(c.query("SELECT c FROM colls UNION ALL SELECT i FROM colls ORDER BY 1"), (e: pg.DatabaseError) => e.code === "42P22");
    // a bound statement: the resolver is asked at Parse, as at Query
    const bound = { text: "SELECT id FROM colls WHERE i > $1 ORDER BY i, id", values: ["b"] };
    assert.deepEqual((await c.query({ ...bound, rowMode: "array" })).rows, (await truth.query(bound.text, bound.values, { rowMode: "array" })).rows);
  } finally { await c.end(); await a.close(); }
});

// (a row comparison is not verified, issue 284, so the listener here refuses nothing: what is held is its keys)
test("collation resolver: a row comparison keys both sides of a column in the type Postgres compared it as", async () => {
  const { api: a, c } = await collsApi(await store.listener(undefined, null, undefined, () => copies, undefined, { collations: PG_COLLATIONS }));
  try {
    for (const sql of [
      // a literal beside a char(n) is a char(n), its padding ignored ('b' equals 'b     ')
      "SELECT id FROM colls WHERE (d::char(6) COLLATE \"und-x-icu\", id) < ('b', 99) ORDER BY id",
      "SELECT id FROM colls WHERE (d::char(6) COLLATE \"und-x-icu\", id) <= ('b', 1) ORDER BY id",
      "SELECT id FROM colls WHERE (i, d::char(6)) <= ('b', 'b') ORDER BY id",
      // a char(n) beside a text is its text, without its padding
      "SELECT id FROM colls WHERE (i, 1) <= (d::char(6), 0) ORDER BY id",
    ]) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
  } finally { await c.end(); await a.close(); }
});

// (the array overload is verified by CI's oracle legs, so the listener here refuses nothing: what is held is its shape)
test("collation resolver: percentile_disc of an array of fractions answers an array whatever text type the key is", async () => {
  const { api: a, c } = await collsApi(await store.listener(undefined, null, undefined, () => copies, undefined, { collations: PG_COLLATIONS }));
  try {
    for (const sql of [
      "SELECT percentile_disc(ARRAY[0.25, 0.75]) WITHIN GROUP (ORDER BY d::char(4) COLLATE \"und-x-icu\") FROM colls",
      "SELECT percentile_disc(ARRAY[0.5]) WITHIN GROUP (ORDER BY i), percentile_disc(ARRAY[0.5]) WITHIN GROUP (ORDER BY i::varchar(8)) FROM colls",
      "SELECT id % 3, percentile_disc(ARRAY[0.5]) WITHIN GROUP (ORDER BY d::char(6) COLLATE \"und-x-icu\") FROM colls GROUP BY 1 ORDER BY 1",
      "SELECT percentile_disc(ARRAY[0.5]) WITHIN GROUP (ORDER BY d::char(6) COLLATE \"und-x-icu\") FROM colls WHERE false",
      "SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY d::char(6) COLLATE \"und-x-icu\") FROM colls",
    ]) assert.deepEqual(await answer(c, sql), await postgres(sql), sql);
  } finally { await c.end(); await a.close(); }
});

test("collation resolver: refuses what it cannot follow by name, and a collation the source lacks is Postgres's 42704", async () => {
  const extra = [{ schema: "public", name: "mason_num", provider: "i", collate: null, locale: "und-u-kn", deterministic: true },
    { schema: "public", name: "mason_ci", provider: "i", collate: null, locale: "und-u-ks-level2", deterministic: false }];
  const { api: a, c } = await collsApi(await store.listener(undefined, undefined, undefined, () => copies, undefined, { collations: [...PG_COLLATIONS, ...extra] }), extra);
  try {
    await assert.rejects(c.query("SELECT id FROM colls ORDER BY d COLLATE mason_num, id"), (e: pg.DatabaseError) => e.code === "0A000" && /mason_num/.test(e.message) && !/duckdb/i.test(e.message));
    // a nondeterministic collation anywhere: its equality is not the engine's
    await assert.rejects(c.query("SELECT id FROM colls WHERE d = 'B' COLLATE mason_ci"), (e: pg.DatabaseError) => e.code === "0A000" && /nondeterministic/.test(e.message));
    // ... a statement of no table's too, though nothing in it orders: the catalog's mason_ci is not the source's
    for (const sql of ["SELECT 'a' = 'A' COLLATE mason_ci", "SELECT 'a' COLLATE mason_ci IN ('A', 'z')",
      "SELECT DISTINCT x COLLATE mason_ci FROM (VALUES ('a'), ('A')) AS v(x)",
      "SELECT count(*) FROM (VALUES ('a'), ('A')) AS v(x) GROUP BY x COLLATE mason_ci",
      "SELECT x FROM (VALUES ('b'), ('A')) AS v(x) WHERE x = 'a' COLLATE mason_ci"]) {
      await assert.rejects(c.query(sql), (e: pg.DatabaseError) => e.code === "0A000" && /nondeterministic/.test(e.message), sql);
    }
    // PGlite has "unicode", a source that lacks it does not
    await assert.rejects(c.query("SELECT id FROM colls ORDER BY d COLLATE \"unicode\""), (e: pg.DatabaseError) => e.code === "42704" && /"unicode"/.test(e.message));
    // unused for an order, an ICU keyword is no refusal: equality is the C key
    assert.deepEqual(await answer(c, "SELECT id FROM colls WHERE d = 'b' COLLATE mason_num"), { fields: [["id", 23]], rows: [["6"]] });
  } finally { await c.end(); await a.close(); }
});

// ISSUE 406: upper, lower and initcap map case under THEIR input collation (Postgres's analysis says which), as that
// collation's ctype says (src/duck/collation.ts caseOf), never the database's by default; a statement of no table that
// calls one is the synced data's, never the catalog's own mapping. Every answer here is Postgres 18's (postgres:18), never
// the unit world's PGlite, whose mapping is its own
const CASE_COLLATIONS = [
  { schema: "pg_catalog", name: "tr-x-icu", provider: "i", collate: null, locale: "tr", deterministic: true },
  { schema: "pg_catalog", name: "en_US", provider: "c", collate: "en_US.utf8", ctype: "en_US.utf8", locale: null, deterministic: true },
  { schema: "pg_catalog", name: "tr_TR", provider: "c", collate: "tr_TR.utf8", ctype: "tr_TR.utf8", locale: null, deterministic: true },
  { schema: "pg_catalog", name: "pg_c_utf8", provider: "b", collate: null, locale: "C.UTF-8", deterministic: true },
  { schema: "pg_catalog", name: "pg_unicode_fast", provider: "b", collate: null, locale: "PG_UNICODE_FAST", deterministic: true },
  { schema: "public", name: "mason_num", provider: "i", collate: null, locale: "und-u-kn", deterministic: true },
];
test("issue 406: upper, lower and initcap map case under their input collation, and a statement of no table calling one is the synced data's", async () => {
  // no table, the database's en_US: glibc keeps ß, the catalog's own mapping made it ẞ
  const plain = await client();
  try {
    assert.deepEqual((await answer(plain, "SELECT initcap('o''neil mcDONALD-smith'), upper('ß'), lower('İ')")).rows, [["O'Neil Mcdonald-Smith", "ß", "i"]]);
    assert.deepEqual((await answer(plain, "SELECT upper('abc'), lower('ABC'), initcap('abc def')")).rows, [["ABC", "abc", "Abc Def"]]);
    assert.deepEqual((await answer(plain, "SELECT initcap(x), upper(x), lower(x) FROM (VALUES ('ǆemal'), ('o''hara'), ('ΟΔΟΣ'), ('ß'), (NULL)) AS v(x)")).rows,
      [["Ǆemal", "ǄEMAL", "ǆemal"], ["O'Hara", "O'HARA", "o'hara"], ["Οδοσ", "ΟΔΟΣ", "οδοσ"], ["ß", "ß", "ß"], [null, null, null]]);
  } finally { await plain.end(); }
  const listener = await store.listener(undefined, undefined, undefined, () => copies, undefined, { collations: [...PG_COLLATIONS, ...CASE_COLLATIONS] });
  const { api: a, c } = await collsApi(listener, CASE_COLLATIONS);
  try {
    for (const [sql, rows] of [
      // a column's own collation: ICU's full mapping and titlecasing, C's ASCII letters, the database's glibc
      ["SELECT upper(i || 'ß'), lower(i || 'İ'), initcap(i || 'o''hara ǆemal') FROM colls WHERE id = 1", [["SS", "i̇", "O'hara ǅemal"]]],
      ["SELECT upper(c || 'é'), lower(c || 'É'), initcap(c || 'élan x2y') FROM colls WHERE id = 1", [["é", "É", "éLan X2y"]]],
      ["SELECT upper(d || 'ß'), lower(d || 'İ'), initcap(d || 'o''hara ǆemal') FROM colls WHERE id = 1", [["ß", "i", "O'Hara Ǆemal"]]],
      // a COLLATE on the argument, never on the result
      ["SELECT upper(d COLLATE \"tr-x-icu\" || 'i'), lower('I' COLLATE \"tr-x-icu\"), initcap('istanbul' COLLATE \"tr-x-icu\") FROM colls WHERE id = 1", [["İ", "ı", "İstanbul"]]],
      ["SELECT upper(d || 'é') COLLATE \"C\", upper((d || 'é') COLLATE \"C\") FROM colls WHERE id = 1", [["É", "é"]]],
      ["SELECT upper('ß' COLLATE pg_unicode_fast), upper('ß' COLLATE pg_c_utf8), initcap('ǆa ßb' COLLATE pg_c_utf8), initcap('ǆa ßb' COLLATE pg_unicode_fast) FROM colls WHERE id = 1", [["SS", "ß", "Ǆa ßb", "ǅa Ssb"]]],
      // an ICU keyword Mason cannot ORDER by maps case as its language does
      ["SELECT upper(d COLLATE mason_num || 'ß') FROM colls WHERE id = 1", [["SS"]]],
      // no table, under a COLLATE
      ["SELECT upper('ß' COLLATE \"und-x-icu\"), lower('İ' COLLATE \"und-x-icu\"), initcap('o''hara' COLLATE \"und-x-icu\"), upper('é' COLLATE \"C\")", [["SS", "i̇", "O'hara", "é"]]],
    ] as const) assert.deepEqual((await answer(c, sql)).rows, rows, sql);
    // two implicit collations: Postgres's 42P22, for the function
    await assert.rejects(c.query("SELECT upper(CASE WHEN id > 3 THEN i ELSE c END) FROM colls"),
      (e: pg.DatabaseError) => e.code === "42P22" && e.message === "could not determine which collation to use for upper() function");
    // a Turkish libc ctype: refused by name, its equality still answered
    await assert.rejects(c.query("SELECT upper(d COLLATE \"tr_TR\") FROM colls"),
      (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap case-mapping-unknown/.test(e.detail ?? "") && /tr_TR/.test(e.message) && /COLLATE "C"/.test(e.hint ?? ""));
    assert.deepEqual((await answer(c, "SELECT id FROM colls WHERE d = 'b' COLLATE \"tr_TR\"")).rows, [["6"]]);
    // the ORDER refusal of an ICU keyword stays
    await assert.rejects(c.query("SELECT id FROM colls ORDER BY upper(d COLLATE mason_num)"), (e: pg.DatabaseError) => e.code === "0A000" && /mason_num/.test(e.message));
  } finally { await c.end(); await a.close(); }

  // THE SQL SENT: the database's glibc maps by the engine's own upper (ß kept) and lower, never a function a row; another
  // collation's mapping is the function's, told its mapping
  const catalogDb = new PGlite({ extensions: { citext } });
  try {
    for (const s of catalogDdl({ ...schema, tables: [...schema.tables, collsTable], collations: [...PG_COLLATIONS, ...CASE_COLLATIONS] })) await catalogDb.exec(s);
    const catalog = (b: Uint8Array): Promise<Uint8Array> => catalogDb.execProtocolRaw(b);
    const sent = async (sql: string, collations = listener.collations) => (await planDuck({ catalog, text: sql, stmt: (await parseSql(sql)).stmts![0]!.stmt as Parameters<typeof planDuck>[0]["stmt"],
      base: 0, paramOids: [], searchPath: "public", timeZone: "UTC", collations, verified: null })).sql.text;
    const native = await sent("SELECT upper(d), lower(d) FROM colls");
    assert.match(native, /replace\(upper\(replace\(/, native);
    assert.match(native, /lower\(/, native);
    assert.doesNotMatch(native, /__mason_/, native);
    assert.match(await sent("SELECT upper(i) FROM colls"), /__mason_case\(.*, true, 'icu:und'\)/);
    assert.match(await sent("SELECT upper(d COLLATE \"C\") FROM colls"), /__mason_case\(.*'ascii'\)/);
    assert.match(await sent("SELECT lower(d COLLATE \"tr-x-icu\") FROM colls"), /__mason_case\(.*false, 'icu:tr'\)/);
    assert.match(await sent("SELECT initcap(d) FROM colls"), /__mason_initcap\(.*'libc'\)/);
    assert.match(await sent("SELECT initcap(i) FROM colls"), /__mason_initcap\(.*'icu:und'\)/);
    // the database's case mapping is its CTYPE's: datcollate C with datctype en_US maps as en_US, en_US with C ASCII only
    const cOrder = await store.listener({ provider: "c", collate: "C", ctype: "en_US.UTF-8", locale: null }, undefined, undefined, () => copies, undefined, { collations: [...PG_COLLATIONS, ...CASE_COLLATIONS] });
    assert.doesNotMatch(await sent("SELECT upper(d) FROM colls", cOrder.collations), /__mason_/);
    const cCtype = await store.listener({ provider: "c", collate: "en_US.utf8", ctype: "C", locale: null }, undefined,
      handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({})], [" "], { collate: "en_US.utf8" }), () => copies, undefined, { collations: [...PG_COLLATIONS, ...CASE_COLLATIONS] });
    assert.match(await sent("SELECT upper(d) FROM colls", cCtype.collations), /__mason_case\(.*'ascii'\)/);
    // an ICU database: its locale's
    const icu = await store.listener({ provider: "i", collate: "und", ctype: "und", locale: "und" }, undefined, undefined, () => copies, undefined, { collations: [...PG_COLLATIONS, ...CASE_COLLATIONS] });
    assert.match(await sent("SELECT upper(d) FROM colls", icu.collations), /__mason_case\(.*'icu:und'\)/);
  } finally { await catalogDb.close(); }

  // NO TABLE: the raw tree may hold a case function, and the analysis says it does ("case"); a numeric, a date, a time or
  // a json keeps it the catalog's (a listed difference, Mason gap fromless-numeric-text-order)
  const catalog = (b: Uint8Array): Promise<Uint8Array> => truth.execProtocolRaw(b);
  const under = { searchPath: "public", timeZone: "UTC", dateStyle: "ISO, MDY" } as Parameters<NonNullable<typeof listener.ordersText>>[3];
  for (const [sql, verdict] of [["SELECT upper('ß')", "case"], ["SELECT initcap('a b'), lower('X')", "case"], ["SELECT 'a' = 'A', version() IS NOT NULL", null],
    ["SELECT upper('ß'), 1.5", null], ["SELECT lower('now')::timestamptz IS NOT NULL", null], ["SELECT upper(x) FROM (VALUES ('ß'), ('b')) v(x) ORDER BY 1", "case"],
    // a value of the server or the session, which the synced data answers with ITS OWN, whatever its allowlist says (a run
    // that succeeds says nothing of it: review r2 of PR 568, fromless-case-route-run-success-read-as-sameness): a session
    // keyword, and a function Postgres does not call immutable (version() and format_type() are stable, the analysis
    // resolving pg_catalog's), keep it the catalog's; an immutable function and an operator move
    ["SELECT upper(version()) LIKE 'POSTGRES%'", null], ["SELECT lower(version()) LIKE 'postgresql %'", null], ["SELECT initcap(version()) LIKE 'Postgresql%'", null],
    ["SELECT position('postgres' IN lower(version())) > 0", null], ["SELECT upper(substr(version(), 1, 10))", null], ["SELECT upper(split_part(version(), ' ', 1))", null],
    ["SELECT count(*) FROM (SELECT upper(version()) AS v) s WHERE v LIKE 'POSTGRES%'", null], ["SELECT upper(format_type(23, NULL))", null],
    ["SELECT lower(current_user)", null], ["SELECT upper(user), lower(session_user)", null], ["SELECT lower(current_catalog)", null], ["SELECT lower(current_database())", null],
    ["SELECT upper(current_setting('TimeZone'))", null], ["SELECT upper(md5('a')), lower('A' || 'ß')", "case"], ["SELECT upper(substr('abc', 1, 2))", "case"]] as const) {
    assert.equal(mayOrderText((await parseSql(sql)).stmts![0]!.stmt) ? await listener.ordersText!(catalog, sql, [], under, true) : null, verdict, sql);
  }
  // ...and is the synced data's only where the synced data's RUN answers it, never its plan alone (review r1 of PR 568,
  // fromless-case-route-plan-not-run): what the rewrite leaves as written and the engine fails on (a pg_catalog-qualified
  // name, a typed literal of a type the engine lacks, an empty select list), and a session's value the synced data would
  // answer with its own, are the catalog's, as before: never the engine's error, never `duckdb`. The same over a simple
  // Query, a Parse (a named statement) and an EXPLAIN. `upper('ß')` beside each says who answered: ß the synced data's
  // glibc, ẞ the catalog's own mapping
  const wire = await client();
  try {
    for (const [sql, rows] of [
      ["SELECT pg_catalog.lower('ABC')", [["abc"]]],
      ["SELECT pg_catalog.upper('abc'), pg_catalog.length('abc')", [["ABC", "3"]]],
      ["SELECT upper('abc'), pg_catalog.length('abc')", [["ABC", "3"]]],
      ["SELECT upper(char 'abc')", [["ABC"]]],
      ["SELECT upper(character 'abc'), initcap(char 'abc')", [["ABC", "Abc"]]],
      ["SELECT upper(x) FROM (VALUES (char 'abc')) v(x)", [["ABC"]]],
      ["SELECT upper('abc' COLLATE \"C\"), upper(n'abc')", [["ABC", "ABC"]]],
      ["SELECT upper('abc'::unknown)", [["ABC"]]],
      ["SELECT upper('abc') FROM (SELECT) s", [["ABC"]]],
      ["SELECT (SELECT pg_catalog.upper(x) FROM (VALUES ('abc')) v(x)), upper('ß')", [["ABC", "ß"]]],
      ["SELECT upper(version()) LIKE 'POSTGRES%', upper('ß')", [["t", "ẞ"]]],
      ["SELECT lower(current_user) = current_user::text, upper('ß')", [["t", "ẞ"]]],
      // what the synced data answers stays its own
      ["SELECT upper('ß'), lower('İ'), initcap('o''neil mcDONALD-smith')", [["ß", "i", "O'Neil Mcdonald-Smith"]]],
    ] as const) {
      assert.deepEqual((await answer(wire, sql)).rows, rows, sql);
      const named = (await wire.query({ name: `p406_${rows.length}_${sql.length}`, text: sql, rowMode: "array", types: raw } as pg.QueryConfig)).rows;
      assert.deepEqual(named, rows, `a Parse of ${sql}`);
      assert.ok((await answer(wire, `EXPLAIN ${sql}`)).rows.length > 0, `EXPLAIN ${sql}`);
    }
    // a parameter has no value before its Bind: the catalog's, as before (the listed difference)
    assert.deepEqual((await answer(wire, "SELECT upper($1::text)", ["abc"])).rows, [["ABC"]]);
    // the statement's timeout during that run is its answer, never a reason to run it again on the catalog
    await wire.query("SET statement_timeout = 300");
    const t = Date.now();
    await assert.rejects(wire.query("SELECT count(upper(x::text)) FROM generate_series(1, 2000000000) x"),
      (e: pg.DatabaseError) => e.code === "57014" && e.message === "canceling statement due to statement timeout");
    assert.ok(Date.now() - t < 5000, `stopped after ${Date.now() - t} ms`);
    await wire.query("SET statement_timeout = 0");
  } finally { await wire.end(); }
});

// ISSUE 666: a top N and an ungrouped min / max under a libc order key their candidates alone (src/duck/libc-bound.ts):
// the rows a native bound of the key cannot rule out. The SQL sent says so (the bounds' regexp_extract, the threshold's
// subquery), under the database's order and a column's own; every form the bound is not proved for is sent as written
test("libc top N: a top N and an ungrouped min / max are bounded natively, the database's order and a column's own; every other form as written", async () => {
  const letters = handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({ e: "é" })], [" ", "-\u0001\u0002\u007f"], { collate: "en_US.utf8" });
  const british = handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({ e: "é" })], [" ", "-\u0001\u0002\u007f"], { collate: "en_GB.utf8" });
  const gb = { schema: "public", name: "mason_gb", provider: "c", collate: "en_GB.utf8", locale: null, deterministic: true };
  const { api: a, c } = await collsApi(await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, undefined, letters, () => copies, undefined,
    { collations: [...PG_COLLATIONS, gb], readLibc: async () => british }), [gb]);
  try {
    const sent = async (sql: string): Promise<string> => String((await answer(c, `EXPLAIN ${sql}`)).rows.map((r) => String(r[0])).find((l) => l.includes("Sent to the engine")) ?? "");
    // the answer by the order itself: the key, then the bytes; NULL last ascending, first descending
    const values = new Map<number, string | null>([[1, ""], [2, " alpha"], [3, "10"], [4, "Beta"], [5, "alpha"], [6, "b"], [7, "A"], [8, "a"], [9, "é"], [10, "e"], [11, "-x"], [12, "w"], [13, null]]);
    const ordered = (desc: boolean, where: (id: number) => boolean = () => true): number[] => [...values].filter(([id]) => where(id)).sort(([i, x], [j, y]) => {
      if (x === null || y === null) return x === y ? i - j : (x === null) === desc ? -1 : 1;
      const [k, l] = [libcKey(letters, x), libcKey(letters, y)];
      const by = k !== l ? (k < l ? -1 : 1) : Buffer.compare(Buffer.from(x), Buffer.from(y));
      return by !== 0 ? (desc ? -by : by) : i - j;
    }).map(([id]) => id);
    const ids = (xs: number[]): string[][] => xs.map((id) => [String(id)]);
    const bounded: Array<[string, unknown[][]]> = [
      ["SELECT id FROM colls ORDER BY d, id LIMIT 3", ids(ordered(false).slice(0, 3))],
      ["SELECT id FROM colls ORDER BY d DESC, id LIMIT 3 OFFSET 1", ids(ordered(true).slice(1, 4))],
      ["SELECT id FROM colls WHERE id > 2 ORDER BY d NULLS FIRST, id LIMIT 4", ids([13, ...ordered(false, (id) => id > 2 && id !== 13)].slice(0, 4))],
      ["SELECT id, upper(d) IS NULL FROM colls ORDER BY d, id LIMIT 2", ordered(false).slice(0, 2).map((id) => [String(id), "f"])],
      ["SELECT id FROM colls ORDER BY d COLLATE mason_gb, id LIMIT 4", ids(ordered(false).slice(0, 4))],
      ["SELECT min(d), max(d) FROM colls", [[values.get(ordered(false)[0]!), values.get(ordered(true)[1]!)]]],
      ["SELECT min(d COLLATE mason_gb), max(d::text) FROM colls WHERE id > 2", [[values.get(ordered(false, (id) => id > 2)[0]!), values.get(ordered(true, (id) => id > 2)[1]!)]]],
      ["SELECT min(d), max(d) FROM colls WHERE id < 0", [[null, null]]],
    ];
    for (const [sql, rows] of bounded) {
      assert.match(await sent(sql), /regexp_extract\(.*\(SELECT (CASE WHEN count\(\*\) >= \d+ THEN )?(min|max)\(__mason_bounds\.__mason_bound\)/, sql);
      assert.deepEqual((await answer(c, sql)).rows, rows, sql);
    }
    // a parameter in the WHERE the threshold reads too: bound once, read in both, and again after the session moved
    const bound = "SELECT id FROM colls WHERE id > $1 ORDER BY d, id LIMIT 3";
    const after = ids(ordered(false, (id) => id > 4).slice(0, 3));
    assert.deepEqual((await answer(c, bound, [4])).rows, after, bound);
    await c.query("SET TimeZone = 'Asia/Kolkata'");
    assert.deepEqual((await answer(c, bound, [4])).rows, after, `${bound}, after SET TimeZone`);
    await c.query("RESET TimeZone");
    for (const sql of ["SELECT d FROM colls GROUP BY d ORDER BY d LIMIT 3", "SELECT DISTINCT d FROM colls ORDER BY 1 LIMIT 3", "SELECT id, d FROM colls ORDER BY d FETCH FIRST 2 ROWS WITH TIES",
      "SELECT id % 2, min(d) FROM colls GROUP BY 1", "SELECT min(d) FILTER (WHERE id > 3) FROM colls", "SELECT id, d FROM colls WHERE random() < 2 ORDER BY d LIMIT 3",
      "SELECT a.id FROM colls a JOIN colls b ON b.id = a.id ORDER BY a.d LIMIT 3", "SELECT id FROM colls ORDER BY d", "SELECT id FROM colls ORDER BY c LIMIT 3",
      "SELECT max(d) OVER () FROM colls LIMIT 1", "SELECT id FROM colls ORDER BY d LIMIT 3 + 0", "SELECT d FROM colls UNION ALL SELECT d FROM colls ORDER BY 1 LIMIT 3",
      "SELECT count(*) FROM (SELECT id FROM colls ORDER BY d LIMIT 3) s", "SELECT min(d) FROM (SELECT d FROM colls LIMIT 5) s"]) {
      const text = await sent(sql);
      assert.ok(text.length > 0 && !text.includes("regexp_extract("), `${sql}: ${text}`);
    }
    // a value holding a control character the order ignores (review r1 of PR 675): U+0002 inside it is not the end of the
    // text, so 'ab' U+0002 'cd' sorts as 'abcd', after 'abc', and U+0002 'zz' as 'zz'
    const control = new Map<number, string>([[100, "abc"], [101, "ab\u0002cd"], [102, "aa"], [103, "a\u0002z"], [104, "aaz"], [105, "\u0002zz"], [106, "b"], [107, "ab\u007f"], [108, "ab\u0001c"]]);
    await store.writer.run(`INSERT INTO public.colls SELECT id, x, x, x FROM (VALUES ${[...control].map(([id, x]) => `(${id}, '${x}')`).join(", ")}) AS s(id, x)`);
    try {
      const sorted = (ids: number[], desc: boolean): number[] => [...ids].sort((i, j) => {
        const [x, y] = [control.get(i)!, control.get(j)!], [k, l] = [libcKey(letters, x), libcKey(letters, y)];
        const by = k !== l ? (k < l ? -1 : 1) : Buffer.compare(Buffer.from(x), Buffer.from(y));
        return by !== 0 ? (desc ? -by : by) : i - j;
      });
      const all = [...control.keys()];
      for (const [sql, rows] of [
        ["SELECT id FROM colls WHERE id >= 100 ORDER BY d, id LIMIT 3", ids(sorted(all, false).slice(0, 3))],
        ["SELECT id FROM colls WHERE id >= 100 ORDER BY d DESC, id LIMIT 2", ids(sorted(all, true).slice(0, 2))],
        ["SELECT id FROM colls WHERE id IN (100, 101) ORDER BY d, id LIMIT 1", ids(sorted([100, 101], false).slice(0, 1))],
        ["SELECT id FROM colls WHERE id IN (103, 104) ORDER BY d, id LIMIT 1", ids(sorted([103, 104], false).slice(0, 1))],
        ["SELECT id FROM colls WHERE id IN (105, 106) ORDER BY d DESC, id LIMIT 1", ids(sorted([105, 106], true).slice(0, 1))],
        ["SELECT min(d), max(d) FROM colls WHERE id IN (100, 101)", [[control.get(sorted([100, 101], false)[0]!), control.get(sorted([100, 101], true)[0]!)]]],
        ["SELECT min(d), max(d) FROM colls WHERE id >= 100", [[control.get(sorted(all, false)[0]!), control.get(sorted(all, true)[0]!)]]],
      ] as Array<[string, unknown[][]]>) {
        assert.match(await sent(sql), /regexp_extract\(/, sql);
        assert.deepEqual((await answer(c, sql)).rows, rows, sql);
      }
      assert.deepEqual(sorted([100, 101], false), [100, 101], "the order itself: 'abc' before 'ab' U+0002 'cd'");
    } finally { await store.writer.run("DELETE FROM public.colls WHERE id >= 100"); }
  } finally { await c.end(); await a.close(); }
});

test("collation resolver: two libc collations in one session, each by its own order, the second read once on its first use", async () => {
  const database = handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({})], [" ", "-"], { collate: "en_US.utf8" });
  const reversed = handLibcOrder(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ...lettersOf({}).reverse()], [" ", "-"], { collate: "rv_RV.utf8" });
  const rev = { schema: "public", name: "mason_rev", provider: "c", collate: "rv_RV.utf8", locale: null, deterministic: true };
  let reads = 0;
  const { api: a, c } = await collsApi(await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, undefined, database, () => copies, undefined,
    { collations: [...PG_COLLATIONS, rev], readLibc: async (sc) => { reads++; assert.equal(sc.collate, "rv_RV.utf8"); return reversed; } }), [rev]);
  try {
    const sql = "SELECT id, d < 'c', d COLLATE mason_rev < 'c' FROM colls WHERE id IN (5, 6, 10, 12) ORDER BY d COLLATE mason_rev";
    assert.deepEqual((await answer(c, sql)).rows, [["12", "f", "t"], ["10", "f", "t"], ["6", "t", "f"], ["5", "t", "f"]], sql);
    const max = "SELECT max(d), max(d COLLATE mason_rev), (SELECT max(x COLLATE mason_rev) FROM (VALUES ('a'), ('z')) v(x)) FROM colls WHERE id IN (5, 6, 10, 12)";
    assert.deepEqual((await answer(c, max)).rows, [["w", "alpha", "a"]], max);
    // no table, under the database's libc order: the synced data's, never the catalog's byte order
    assert.deepEqual((await answer(c, "SELECT 'a' < 'B', 'B' < 'a'")).rows, [["t", "f"]]);
    assert.equal(reads, 1, "the second collation's order is read once, then held");
  } finally { await c.end(); await a.close(); }
});
