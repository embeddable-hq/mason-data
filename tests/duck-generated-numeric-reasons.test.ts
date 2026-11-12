/**
 * GENERATED TABLES, OFFLINE (src/duck/generated.ts, src/duck/generated-plan.ts; issue 124), one piece of
 * tests/duck-generated*.test.ts, which issue 338 split into files the unit shards can spread: PR 202's review rounds 3
 * and 4: a made type's OID, a numeric's engine type, its refusal's true reason, a run's session and its failure's
 * words. Each test runs its own world (tests/duck-generated-world.ts). What Postgres answers from the same SQL is
 * tests/integration/duck-generated.itest.ts's.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser } from "../src/api/postgres/parser.ts";
import * as generatedModule from "../src/duck/generated.ts";
import { COUNTS, refusedAt, served } from "./duck-generated-world.ts";
import { LEDGER_COLUMNS, NUMS, KINDS, overLedger, typed } from "./duck-generated-ledger.ts";

after(() => stopParser());

// review round 3 of PR 202, F3: a made type's OID, as a REAL run spells it. The source's catalog read gives an oid as a
// STRING (Postgres's JSON writes only the int, float and numeric types as numbers), and a field carries the SOURCE's OID
// for a made type, which the catalog's pg_type does not have: the enum and the citext were refused by type in a real run
const SOURCE_OIDS = LEDGER_COLUMNS.map((c) => c.name === "mood" ? { ...c, typeOid: "5974240", typeArrayOid: "5974239" } : c.name === "name" ? { ...c, typeOid: "5974250", typeArrayOid: "5974249" } : c);

test("an enum and a citext over a source's own type OIDs, spelled as the source's JSON spells them, are stored, not refused by type", async () => {
  await overLedger({ kinds: KINDS }, async (w) => {
    assert.deepEqual(w.status("public.kinds").refusals, []);
    const r = await typed(w, "SELECT id, mood, name FROM kinds ORDER BY mood, id");
    assert.deepEqual([r.fields[1]![1], r.fields[2]![1]], [5974240, 5974250], "the source's OIDs on the wire, as a synced column sends");
    assert.deepEqual(r.rows.map((x) => x[1]), ["sad", "sad", "ok", "happy"], "the declared order");
    assert.deepEqual((await typed(w, "SELECT id FROM kinds WHERE name = 'ALICE' ORDER BY id")).rows, [["1"], ["9223372036854775806"]]);
  }, SOURCE_OIDS);
});

// issue 858: a made type's SOURCE OID that is, in the catalog, another type (a table's row type). The source and the
// catalog count their made types' OIDs from 16384 alike, so one number can name a citext there and a row type here: the
// generated column was declared as that row type (`ledger`), and its statements were refused 0A000 "input of anonymous
// composite types is not implemented". The catalog's row-type OIDs are read from a first world, then given to the
// source's citext and enum in a second, whose catalog makes its row types there first and then holds the source's types
// at those OIDs (issue 861: checked, so a collision not forced fails as such, not as a pass)
test("a made type whose source OID is a catalog row type's is declared as the source's type, and its statements are answered (issue 858)", async () => {
  let rowTypes: Array<[string, number]> = [];
  const readRowTypes = async (w: Parameters<Parameters<typeof overLedger>[1]>[0]): Promise<Array<[string, number]>> =>
    (await typed(w, "SELECT typname::text, oid::int FROM pg_catalog.pg_type WHERE typtype = 'c' AND typname IN ('ledger', 'events') ORDER BY typname")).rows.map((r) => [r[0] as string, Number(r[1])]);
  await overLedger({ kinds: KINDS }, async (w, restarted) => { if (!restarted) rowTypes = await readRowTypes(w); });
  assert.deepEqual(rowTypes.map(([n]) => n), ["events", "ledger"], "the catalog holds both synced tables' row types");
  const [eventsRow, ledgerRow] = rowTypes.map(([, oid]) => oid) as [number, number];
  const colliding = LEDGER_COLUMNS.map((c) => c.name === "mood" ? { ...c, typeOid: String(eventsRow), typeArrayOid: "5974239" } : c.name === "name" ? { ...c, typeOid: String(ledgerRow), typeArrayOid: "5974249" } : c);
  await overLedger({ kinds: KINDS }, async (w, restarted) => {
    // the collision this test needs: the catalog made its row types at the source's OIDs, and holds the source's types
    // there instead (src/api/postgres/type-oids.ts, issue 861), its row types moved out of the way
    if (!restarted) {
      assert.deepEqual((await typed(w, `SELECT oid::int, typname::text FROM pg_catalog.pg_type WHERE oid IN (${eventsRow}, ${ledgerRow}) ORDER BY oid`)).rows,
        [[eventsRow, "mood"], [ledgerRow, "citext"]].sort((a, b) => Number(a[0]) - Number(b[0])));
      assert.ok((await readRowTypes(w)).every(([, oid]) => oid !== eventsRow && oid !== ledgerRow));
    }
    assert.deepEqual(w.status("public.kinds").refusals, []);
    assert.deepEqual((await typed(w, "SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod) FROM pg_catalog.pg_attribute a " +
      "WHERE a.attrelid = 'public.kinds'::regclass AND a.attnum > 0 ORDER BY a.attnum")).rows, [["id", "bigint"], ["mood", "mood"], ["name", "citext"]], "the generated table's columns are the source's types");
    const r = await typed(w, "SELECT id, mood, name FROM kinds ORDER BY mood, id");
    assert.deepEqual([r.fields[1]![1], r.fields[2]![1]], [eventsRow, ledgerRow], "the source's OIDs on the wire, as a synced column sends");
    assert.deepEqual(r.rows.map((x) => x[1]), ["sad", "sad", "ok", "happy"], "the enum's declared order");
    assert.deepEqual((await typed(w, "SELECT id, name FROM kinds WHERE name = 'ALICE' ORDER BY id")).rows, [["1", "Alice"], ["9223372036854775806", "alice"]], "a citext's case-blind equality");
  }, colliding);
});

// review round 3 of PR 202, F1: a numeric the engine answers itself (no exact program, "as the engine answers it") is
// held to the engine type DuckDB says it computes: a DECIMAL stored, an integer stored as HUGEINT, a double refused
test("a numeric the engine answers itself is held to its engine type: a variance it computes as a double is refused, a sign is stored as HUGEINT", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({ signs: `${lag}sql: SELECT id, sign(amount) AS s FROM ledger\norder_by: id\n` }, async (w, restarted) => {
    const r = await typed(w, "SELECT id, s FROM signs ORDER BY id");
    assert.deepEqual(r.fields.map(([, oid]) => oid), [20, 1700]);
    assert.deepEqual(r.rows.map((x) => x[1]), ["1", null, "-1", "1"]);
    if (restarted) return;
    assert.deepEqual(await w.rows("SELECT data_type FROM duckdb_columns() WHERE table_name = 'signs' AND column_name = 's'"), [["HUGEINT"]]);
    w.write("sb", `${lag}sql: SELECT stddev(big) AS sb FROM ledger\n`);
    w.write("vw", `${lag}sql: SELECT variance(wide) AS vw FROM ledger\n`);
    for (const name of ["sb", "vw"]) await w.until((s) => s.state === "refused", `public.${name}`);
    for (const [name, col] of [["sb", "sb"], ["vw", "vw"]] as const) {
      const refusals = w.status(`public.${name}`).refusals;
      refusedAt(refusals, "sql", new RegExp(`^column ${col} is a (stddev|variance), which Postgres computes as an exact numeric at decimals it picks`));
      assert.ok(refusals[0]!.options.some((o) => o.includes("AS double precision) AS")), JSON.stringify(refusals));
    }
  });
});

// review round 3 of PR 202, F2: each refusal says its true reason. A sqrt, exp, ln or power is computed by the catalog's
// Postgres at decimals it picks per value, never "a double"; one an outer round fixes says what still stands in the way;
// a JSON number's sum an outer round fixes is held at 36 decimals on the way, never "the rows decide its decimals"
test("a numeric's refusal says its true reason: sqrt, exp, ln and power pick their decimals per value; a round over them, or over a JSON number's sum, says what still stands", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  const files: Record<string, [string, RegExp]> = {
    root: ["SELECT sqrt(abs(amount)) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    squared: ["SELECT power(amount, 2) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    squaredsum: ["SELECT power(sum(id), 2) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    grown: ["SELECT exp(amount) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    logged: ["SELECT ln(abs(amount)) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value/],
    rootround: ["SELECT round(sqrt(abs(amount)), 4) AS x FROM ledger", /^column x rounds or casts a numeric Postgres computes for each row at decimals it picks/],
    sdround: ["SELECT round(stddev(amount), 2) AS x FROM ledger", /^column x is a stddev, which Postgres computes as an exact numeric at decimals it picks/],
    textround: ["SELECT round(sum((payload ->> 'a')::numeric), 2) AS x FROM events", /^column x is computed at 36 decimals on the way to its own, more than the 18/],
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(files)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const name of Object.keys(files)) await w.until((s) => s.state === "refused", `public.${name}`);
    for (const [name, [, message]] of Object.entries(files)) {
      const refusals = w.status(`public.${name}`).refusals;
      refusedAt(refusals, "sql", message);
      assert.doesNotMatch(JSON.stringify(refusals), /holds as a double|sync the value as a numeric|rows decide/, name);
    }
  });
});

// review round 3 of PR 202, F4: a numeric past the 38 digits a stored numeric holds, at the write, is a failure that names
// its cause and its way out, run again on the back-off (a change to the rows can bring it back within them), never a
// DuckDB message alone
test("a numeric that overflows the stored numeric at the write fails naming its cause and its way out, on the back-off", async () => {
  await overLedger({ nums: NUMS }, async (w, restarted) => {
    if (restarted) return;
    w.write("squares", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT sum(big) * sum(big) AS sq FROM ledger\n");
    await w.until((s) => s.state === "failed", "public.squares");
    const s = w.status("public.squares");
    assert.deepEqual(s.refusals, [], "data-dependent: a failure, not a refusal of the definition");
    assert.match(s.error ?? "", /^numeric field overflow \(SQLSTATE 22003\)\. The value has more than the 38 digits .* cast it to double precision if it need not be exact/);
    assert.ok(s.retryAt !== null, "run again on the back-off");
  });
});

// review round 4 of PR 202, finding 1: the run's connection is a session's, set up by the ONE set-up (src/duck/store.ts
// `SessionSetup`). Every Mason function reads `__mason_session` (its first argument), and answered NULL on a connection
// without it: a JSON number's cast stored NULL in every row, with no error. `current_setting` reads `__mason_settings`,
// which a generated table has no session to give: refused by its plan ("it reads a session")
test("a generated table's run reads the session variables as a session does: a JSON number's cast, sum and round are stored, a session setting is refused", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  await overLedger({
    bytenant: `${lag}sql: SELECT tenant_id, sum((payload ->> 'a')::numeric(20,4)) AS x FROM events GROUP BY tenant_id\norder_by: tenant_id\n`,
    jsontotal: `${lag}sql: SELECT sum((payload ->> 'a')::numeric(20,4)) AS x, round(sum((payload ->> 'a')::numeric(20,4)), 2) AS r FROM events\n`,
    jsoncast: `${lag}sql: SELECT id, (payload ->> 'a')::numeric(20,4) AS x, ((payload ->> 'a')::numeric)::numeric(20,4) AS y, (payload ->> 'a')::int AS i FROM events\norder_by: id\n`,
  }, async (w, restarted) => {
    assert.deepEqual((await typed(w, "SELECT tenant_id, x FROM bytenant ORDER BY tenant_id")).rows, [[1, "1.0000"], [2, "2.0000"]]);
    assert.deepEqual((await typed(w, "SELECT x, r FROM jsontotal")).rows, [["3.0000", "3.00"]]);
    assert.deepEqual((await typed(w, "SELECT id, x, y, i FROM jsoncast ORDER BY id")).rows,
      [["1", "1.0000", "1.0000", 1], ["2", null, null, null], ["3", "2.0000", "2.0000", 2], ["4", null, null, null]]);
    if (restarted) return;
    w.write("setting", `${lag}sql: SELECT id, current_setting('TimeZone') AS z FROM events\n`);
    await w.until((s) => s.state === "refused", "public.setting");
    refusedAt(w.status("public.setting").refusals, "sql", /^it reads a session/);
  });
});

// review round 4 of PR 202, finding 2: a refusal's reason and way out come from the FORM that was seen, carried with it,
// never from a type several forms share: every reason against every form that reaches it, and each way out stored
test("a numeric's refusal is said from its form: a JSON number's text, the variance family in one wording, sqrt and its round; each way out is stored", async () => {
  const lag = "kind: scheduled\ntarget_lag: 1h\n";
  const files: Record<string, [string, RegExp, string]> = {
    jsonbare: ["SELECT id, (payload ->> 'a')::numeric AS x FROM events", /^column x is a numeric read from text \(a JSON number's ->> cast to numeric\), which keeps the decimals each value's text has/, "CAST(payload ->> 'a' AS numeric(20, 4)) AS x"],
    jsonround: ["SELECT round((payload ->> 'a')::numeric, 2) AS x FROM events", /^column x is a numeric read from text/, "round(CAST(payload ->> 'a' AS numeric(20, 4)), 2) AS x"],
    var1: ["SELECT variance(amount) AS x FROM ledger", /^column x is a variance, which Postgres computes as an exact numeric at decimals it picks by the size of each value, and the engine only as a double/, "CAST(variance(amount) AS double precision) AS x"],
    var2: ["SELECT stddev(n) AS x FROM ledger", /^column x is a stddev, which Postgres computes as an exact numeric at decimals it picks/, "CAST(stddev(n) AS double precision) AS x"],
    var3: ["SELECT stddev(big) AS x FROM ledger", /^column x is a stddev, which Postgres computes as an exact numeric at decimals it picks/, "CAST(stddev(big) AS double precision) AS x"],
    var4: ["SELECT round(stddev(amount), 2) AS x FROM ledger", /^column x is a stddev, which Postgres computes as an exact numeric at decimals it picks/, "CAST(round(stddev(amount), 2) AS double precision) AS x"],
    root: ["SELECT sqrt(abs(amount)) AS x FROM ledger", /^column x is a numeric whose decimals Postgres picks by the size of each value \(sqrt\)/, "CAST(sqrt(abs(amount)) AS double precision) AS x"],
    rootround: ["SELECT round(sqrt(abs(amount)), 4) AS x FROM ledger", /^column x rounds or casts a numeric Postgres computes for each row at decimals it picks \(sqrt\)/, "CAST(round(sqrt(abs(amount)), 4) AS double precision) AS x"],
  };
  // each way out, written over the same columns: stored
  const ways: Record<string, string> = {
    wayjson: "SELECT id, (payload ->> 'a')::numeric(20,4) AS x FROM events",
    wayvar: "SELECT variance(amount)::double precision AS x, stddev(n)::double precision AS y, stddev(big)::double precision AS z FROM ledger",
    wayroot: "SELECT sqrt(abs(amount))::double precision AS x FROM ledger",
  };
  await overLedger({ counts: COUNTS }, async (w, restarted) => {
    if (restarted) return;
    for (const [name, [sql]] of Object.entries(files)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const [name, sql] of Object.entries(ways)) w.write(name, `${lag}sql: ${sql}\n`);
    for (const name of Object.keys(files)) await w.until((s) => s.state === "refused", `public.${name}`);
    for (const [name, [, message, way]] of Object.entries(files)) {
      const refusals = w.status(`public.${name}`).refusals;
      refusedAt(refusals, "sql", message);
      assert.equal(refusals.length, 1, name);
      assert.ok(refusals[0]!.options.some((o) => o.includes(way)), `${name}: ${JSON.stringify(refusals[0]!.options)}`);
      if (!name.startsWith("root")) assert.doesNotMatch(refusals[0]!.message + refusals[0]!.options.join(), /sqrt/, name);
      if (name.startsWith("var")) assert.doesNotMatch(refusals[0]!.message, /picks by the size of each value \(/, name);
    }
    for (const name of Object.keys(ways)) await w.until(served(w.logged), `public.${name}`);
    assert.deepEqual((await typed(w, "SELECT id, x FROM wayjson ORDER BY id")).rows, [["1", "1.0000"], ["2", null], ["3", "2.0000"], ["4", null]]);
    assert.deepEqual((await typed(w, "SELECT x FROM wayroot")).fields.map(([, oid]) => oid), [701]);
    assert.deepEqual((await typed(w, "SELECT x, y, z FROM wayvar")).fields.map(([, oid]) => oid), [701, 701, 701]);
  });
});

// review round 4 of PR 202, finding 3: what a run's failure records names nothing of the engine: every DECIMAL overflow
// spelling DuckDB gives is said in the user's words, and no hidden column's name (`__mason_cell_0`) reaches the record
test("a run's failure says a cast's overflow in the user's words, and no recorded failure carries an engine name", async () => {
  const spellings = [
    'Conversion Error: Casting value "12345678901234567890.123456789" to type DECIMAL(5,2) failed: value is out of range! when casting from source column __mason_cell_0',
    "Out of Range Error: Overflow in multiplication of DECIMAL(38) (99999999999999999999999999999999999999 * 10). You might want to add an explicit cast to a decimal with a smaller scale.",
    "Out of Range Error: Overflow in ROUND of DECIMAL(38)",
    "Out of Range Error: Overflow in HUGEINT multiplication: 99999999999999999999999999999999999999 * 3",
    'Conversion Error: Could not convert string "NaN" to DECIMAL(20,4)',
    "Conversion Error: Could not cast value 1e40 to DECIMAL(38,0)",
    "Binder Error: Referenced column __mason_cell_3 not found",
    // review round 5: what is not a DECIMAL is said through the same one mapping
    "Out of Range Error: Overflow in multiplication of INT64 (9223372036854775807 * 2)!",
    "Invalid Input Error: Division by zero in expression (10 // 0). Use TRY(...) or SET error_on_division_by_zero",
    'Invalid Input Error: mason[22P02]: invalid input syntax for type integer: "abc"',
  ];
  // read through the module, so the file loads where the function is missing and this test fails by name (fails-without)
  const failureWords = (generatedModule as { failureWords?: (error: unknown) => string }).failureWords;
  assert.ok(failureWords !== undefined, "the one function a run's failure is said through");
  for (const m of spellings) {
    const said = failureWords(m);
    assert.doesNotMatch(said, /__mason_|DECIMAL|HUGEINT|INT64|Overflow in|TRY\(|mason\[|Error:|abc/, `${m} -> ${said}`);
    assert.match(said, /\(SQLSTATE [0-9A-Z]{5}\)/, `${m} -> ${said}`);
  }
  assert.match(failureWords(spellings[0]!), /^numeric field overflow \(SQLSTATE 22003\)\. A field with precision 5, scale 2 must round to an absolute value less than 10\^3\./);
  await overLedger({ nums: NUMS }, async (w, restarted) => {
    if (restarted) return;
    w.write("narrow", "kind: scheduled\ntarget_lag: 1h\nsql: SELECT big::numeric(5,2) AS c FROM ledger\n");
    await w.until((s) => s.state === "failed", "public.narrow");
    const s = w.status("public.narrow");
    assert.match(s.error ?? "", /^numeric field overflow \(SQLSTATE 22003\)\. A field with precision 5, scale 2 must round/);
    assert.doesNotMatch(s.error ?? "", /__mason_|DECIMAL/);
    assert.ok(!w.logged.some((l) => l.includes("public.narrow") && /__mason_/.test(l)), "the log names no hidden column");
  });
});
