/**
 * THE STATISTICS WALL KEEPS EVERY COLUMN AS IT IS (src/duck/row-filter.ts STATISTICS_WALL): a filtered read's `try(col)` of
 * every column, under each column's own name. Every type a copy can hold, with its edge values and a NULL row, and the
 * column names a table can have, through the wall and without it: the same names, the same types, the same text. `try`
 * is the engine's, so an upgrade that renames or retypes through it fails here before a filtered user reads it.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import { BARRIER, STATISTICS_WALL } from "../src/duck/row-filter.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-roles-try-"));
let store: DuckStore;
before(async () => { store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined); });
after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** each column with a value at an edge of its type (a second row is NULL throughout) */
const COLUMNS: ReadonlyArray<[string, string, string]> = [
  ["i2", "SMALLINT", "-32768"], ["i4", "INTEGER", "2147483647"], ["i8", "BIGINT", "-9223372036854775808"],
  ["h", "HUGEINT", "170141183460469231731687303715884105727"], ["f4", "FLOAT", "'nan'::FLOAT"], ["f8", "DOUBLE", "'inf'::DOUBLE"],
  ["d38", "DECIMAL(38,2)", "'-999999999999999999999999999999999999.99'::DECIMAL(38,2)"], ["d18", "DECIMAL(18,6)", "0.000001"], ["d4", "DECIMAL(4,1)", "999.9"],
  ["s", "VARCHAR", `'it''s "quoted"'`], ["b", "BOOLEAN", "true"], ["dt", "DATE", "'5874897-12-31'"], ["ts", "TIMESTAMP", "'infinity'"],
  ["tstz", "TIMESTAMPTZ", "'-infinity'"], ["tm", "TIME", "'23:59:59.999999'"], ["tmtz", "TIMETZ", "'12:00:00+05:30'"],
  ["iv", "INTERVAL", "INTERVAL '1 year 2 months 3 days 4 hours'"], ["u", "UUID", "'ffffffff-ffff-ffff-ffff-ffffffffffff'"], ["j", "JSON", `'{"a": [1, null]}'`],
  ["bl", "BLOB", "'\\x00\\xFF'::BLOB"], ["ai", "INTEGER[]", "[1, NULL, 3]"], ["sa", "VARCHAR[]", "['x', NULL]"],
  ["au", "UUID[]", "['00000000-0000-0000-0000-000000000000'::UUID]"], ["aj", "JSON[]", `['{"k":1}'::JSON]`], ["ad", "DECIMAL(38,2)[]", "[1.50::DECIMAL(38,2)]"],
  ["ats", "TIMESTAMPTZ[]", "['infinity'::TIMESTAMPTZ]"], ["bt", "BIT", "'1011'"], ["e", "mood", "'happy'"], ["ae", "mood[]", "['sad'::mood, NULL]"],
  ["st", "STRUCT(a INTEGER, b VARCHAR)", "{a: 1, b: 'z'}"], ["m", "MAP(VARCHAR, INTEGER)", "MAP {'k': 1}"], ["nested", "STRUCT(l INTEGER[], j JSON)", `{l: [1, 2], j: '[1]'::JSON}`],
  ["ai2", "INTEGER[][]", "[[1], [2, 3]]"], ["fx", "INTEGER[3]", "[1, 2, 3]"],
];
/** names a column can have, and a statement could trip the regex replacement of `AS "\0"` on */
const NAMES = ["Mixed Case", 'a"b', "select", "a\\0b", "\\1", "$1", "a.b", "ünï", "a b", "*", "COLUMNS", "try", "__mason_barrier", "\\", "(x)", "é"];
const ident = (n: string): string => `"${n.replaceAll('"', '""')}"`;

test("try(COLUMNS(*)) keeps every column's name, type and text, for every type and every odd name", async () => {
  const w = store.writer;
  await w.run("CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')");
  await w.run(`CREATE TABLE t (${[...COLUMNS.map(([n, type]) => `${ident(n)} ${type}`), ...NAMES.map((n) => `${ident(n)} INTEGER`)].join(", ")})`);
  await w.run(`INSERT INTO t VALUES (${[...COLUMNS.map(([, , v]) => v), ...NAMES.map((_, i) => String(i))].join(", ")})`);
  await w.run(`INSERT INTO t VALUES (${[...COLUMNS, ...NAMES].map(() => "NULL").join(", ")})`);
  const read = async (sql: string): Promise<{ names: string[]; types: string[]; text: unknown[][] }> => {
    const described = await w.runAndReadAll(`SELECT * FROM (${sql}) LIMIT 0`);
    const cast = described.columnNames.map((n) => `CAST(${ident(n)} AS VARCHAR)`).join(", ");
    const text = await w.runAndReadAll(`SELECT ${cast} FROM (${sql}) ORDER BY i2 NULLS LAST`);
    return { names: [...described.columnNames], types: described.columnNames.map((_, i) => described.columnType(i).toString()), text: text.getRowsJS() };
  };
  const plain = await read("SELECT * FROM t");
  const wall = await read(`SELECT ${STATISTICS_WALL} AS "\\0" FROM (SELECT * FROM t ${BARRIER}) AS w`);
  assert.equal(plain.names.length, COLUMNS.length + NAMES.length);
  assert.deepEqual(wall.names, plain.names);
  assert.deepEqual(wall.types, plain.types);
  assert.deepEqual(wall.text, plain.text);
});
