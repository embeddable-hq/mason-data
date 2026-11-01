/**
 * The oracle's shape multiplier (tests/integration/oracle/shapes.ts), offline: each shape's exact text and comparison
 * mode from a stubbed Postgres answer (RowDescription's names, OIDs, typmods, the rows) and a stubbed `format_type`,
 * where it reaches and where it does not, and a text that does not read back as its tree never asked (unspellable).
 * The oracle (tests/integration/duck-oracle.itest.ts) asks them of a real Postgres and Mason.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { stopParser } from "../src/api/postgres/parser.ts";
import { shapes, type SourceAnswer, type TypeOf } from "./integration/oracle/shapes.ts";
import { NEW_SHAPES, shapeProblems, sumShapeTallies, emptyShapeCount, type ShapeCount } from "./integration/oracle/shape-names.ts";

after(async () => { await stopParser(); });

// format_type's spelling of the OIDs the stubs use, and typtype ('p' for record)
const NAMES: Record<number, string> = { 20: "bigint", 21: "smallint", 23: "integer", 25: "text", 701: "double precision", 1007: "integer[]", 1043: "character varying", 1184: "timestamp with time zone", 1700: "numeric", 2249: "record", 114: "json" };
const typeOf: TypeOf = async (oid, typmod) => oid === 1042 ? { name: `character(${typmod - 4})`, typtype: "b" } : oid === 1700 && typmod > 0 ? { name: `numeric(${(typmod - 4) >> 16},${(typmod - 4) & 0xffff})`, typtype: "b" } : NAMES[oid] === undefined ? null : { name: NAMES[oid]!, typtype: oid === 2249 ? "p" : "b" };
const answer = (names: string[], oids: number[], rows: (string | null)[][] = [], typmods: number[] = oids.map(() => -1)): SourceAnswer => ({ names, oids, typmods, rows });
const of = async (sql: string, a: SourceAnswer, group = "BI shape", inOrder = true) => {
  const r = await shapes(sql, inOrder, group, a, typeOf);
  return { r, by: (name: string) => r.shaped.filter((s) => s.shape === name).map((s) => [s.sql, s.inOrder] as const), names: new Set<string>(r.shaped.map((s) => s.shape)) };
};

const S = "SELECT o.id, o.status, o.amount / 3 AS third FROM orders o ORDER BY o.id LIMIT 5";
const SA = answer(["id", "status", "third"], [20, 25, 1700], [["1", "paid", "40.0000000000000000"]]);

test("the first six shapes keep their texts and modes", async () => {
  const { r } = await of(S, SA);
  assert.deepEqual(r.shaped.slice(0, 5).map((s) => [s.shape, s.sql, s.inOrder]), [
    ["subquery", `SELECT * FROM (${S}) AS mason_shape`, false],
    ["cte", `WITH mason_shape AS (${S}) SELECT * FROM mason_shape`, false],
    ["union", `(${S}) UNION ALL (${S})`, false],
    ["named", `SELECT mason_shape."id", mason_shape."status", mason_shape."third" FROM (${S}) AS mason_shape`, false],
    ["ordered", `SELECT * FROM (${S}) AS mason_shape ORDER BY mason_shape."id"`, true],
  ]);
  const p = (await of("SELECT id FROM orders WHERE status = 'paid' ORDER BY id", answer(["id"], [20], [["1"]]))).r.shaped.find((s) => s.shape === "parameters");
  assert.deepEqual(p, { shape: "parameters", sql: "SELECT id FROM orders WHERE status = $1 ORDER BY id", values: ["paid"], inOrder: true });
});

test("the arms: the first row's values, bare NULLs, padded characters and integers, on either side", async () => {
  const { by } = await of(S, SA);
  assert.deepEqual(by("values-arm"), [[`(${S}) UNION ALL VALUES ('1'::bigint, 'paid'::text, '40.0000000000000000'::numeric)`, false]]);
  assert.deepEqual(by("values-arm-first"), [[`VALUES ('1'::bigint, 'paid'::text, '40.0000000000000000'::numeric) UNION ALL (${S})`, false]]);
  assert.deepEqual(by("null-arm"), [[`(${S}) UNION ALL SELECT NULL, NULL, NULL`, false]]);
  assert.deepEqual(by("null-arm-first"), [[`SELECT NULL, NULL, NULL UNION ALL (${S})`, false]]);
  assert.deepEqual(by("char-arm"), [[`(${S}) UNION SELECT NULL, 'paid'::character(6), NULL`, false]]);
  assert.deepEqual(by("char-arm-first"), [[`SELECT NULL, 'paid'::character(6), NULL UNION (${S})`, false]]);
  assert.deepEqual(by("integer-arm"), [[`(${S}) UNION ALL SELECT 1, NULL, 1`, false]]);
  assert.deepEqual(by("integer-arm-first"), [[`SELECT 1, NULL, 1 UNION ALL (${S})`, false]]);
  // a typmod, a NULL and a bpchar's padded text, from RowDescription and format_type
  const star = "SELECT s.id, s.ch, s.name FROM star_o s ORDER BY s.id";
  const st = await of(star, answer(["id", "ch", "name"], [23, 1042, 25], [["1", "ab  ", null]], [-1, 8, -1]));
  assert.deepEqual(st.by("values-arm"), [[`(${star}) UNION ALL VALUES ('1'::integer, 'ab  '::character(4), NULL::text)`, false]]);
  assert.deepEqual(st.by("char-arm"), [[`(${star}) UNION SELECT NULL, 'ab  '::text, 'ab'::character(4)`, false]]);
  const vc = "SELECT id, vc FROM typed ORDER BY id";
  const v = await of(vc, answer(["id", "vc"], [20, 1043], [["1", "a"]]));
  assert.deepEqual(v.by("char-arm"), [[`(${vc}) UNION SELECT NULL, 'a'::character(3)`, false]]);
  assert.deepEqual(v.by("char-arm-first"), [[`SELECT NULL, 'a'::character(3) UNION (${vc})`, false]]);
  const fl = "SELECT id, f8, i2 FROM typed ORDER BY id";
  assert.deepEqual((await of(fl, answer(["id", "f8", "i2"], [23, 701, 21], [["1", "1.5", "2"]]))).by("integer-arm"), [[`(${fl}) UNION ALL SELECT NULL, 1, 1`, false]]);
});

test("the arms reach only where Postgres's answer says", async () => {
  assert.ok(!(await of("SELECT id FROM orders WHERE false ORDER BY id", answer(["id"], [20]))).names.has("values-arm"), "no rows: no values arm");
  const rec = await of("SELECT ROW(o.id, o.status) FROM orders o ORDER BY o.id LIMIT 3", answer(["row"], [2249], [["(1,paid)"]]));
  assert.ok(!rec.names.has("values-arm") && !rec.names.has("values-arm-first"), "a record (typtype p): no values arm");
  const noChar = await of("SELECT o.id, o.amount FROM orders o ORDER BY o.id LIMIT 5", answer(["id", "amount"], [20, 1700], [["1", "2.00"]]));
  assert.ok(!noChar.names.has("char-arm"));
  assert.ok(!(await of("SELECT o.id::int, o.status FROM orders o ORDER BY 1 LIMIT 5", answer(["id", "status"], [23, 25], [["1", "a"]]))).names.has("integer-arm"), "int4 alone: no integer arm");
});

test("TABLE in place of SELECT * FROM t, alone with its tail and as a set operation's arm", async () => {
  const copy = 'SELECT * FROM public.orders ORDER BY id COLLATE "C"';
  const c = await of(copy, answer(["a", "b", "c", "d", "e", "f", "g", "h"], [20, 20, 25, 1700, 1184, 25, 25, 25]), "copy");
  assert.deepEqual(c.r.shaped.map((s) => [s.shape, s.sql, s.inOrder]), [
    ["table", 'TABLE public.orders ORDER BY id COLLATE "C"', true],
    ["table-arm", 'SELECT * FROM "public"."orders" UNION ALL TABLE "public"."orders" ORDER BY 1, 2, 3, 4, 5, 6, 7, 8 LIMIT 2', true],
  ], "the copy group gets table and table-arm, and nothing else");
  const tail = "SELECT * FROM star_o ORDER BY name DESC NULLS LAST, id LIMIT 3 OFFSET 2";
  const t = await of(tail, answer(["id", "name"], [23, 25], [["1", "a"]]));
  assert.deepEqual(t.by("table"), [["TABLE star_o ORDER BY name DESC NULLS LAST, id LIMIT 3 OFFSET 2", true]]);
  assert.deepEqual(t.by("table-arm"), [['SELECT * FROM "star_o" UNION ALL TABLE "star_o" ORDER BY 1, 2 LIMIT 2', true]]);
  // a json column: Postgres refuses the sort (42883), which table-arm declares
  assert.deepEqual((await of("SELECT * FROM docs ORDER BY id", answer(["id", "j"], [20, 114], [["1", "{}"]]))).by("table-arm"), [['SELECT * FROM "docs" UNION ALL TABLE "docs" ORDER BY 1, 2 LIMIT 2', true]]);
  for (const sql of ["SELECT * FROM orders o ORDER BY o.id", "SELECT * FROM orders WHERE id > 3 ORDER BY id", "SELECT * FROM (SELECT * FROM orders) s", "SELECT o.* FROM orders o", "SELECT id FROM orders", "SELECT * FROM star_o AS x(key, m, label) ORDER BY key"]) {
    const n = await of(sql, answer(["id"], [20], [["1"]]));
    assert.ok(!n.names.has("table") && !n.names.has("table-arm"), `no TABLE: ${sql}`);
  }
});

test("empty: false as, or ANDed onto, the outermost WHERE, printed by the engine's printer", async () => {
  assert.deepEqual((await of(S, SA)).by("empty"), [["SELECT o.id, o.status, o.amount / 3 AS third FROM orders AS o WHERE false ORDER BY o.id LIMIT 5", true]]);
  assert.deepEqual((await of("SELECT id FROM orders WHERE status = 'paid' ORDER BY id", answer(["id"], [20], [["1"]]))).by("empty"), [["SELECT id FROM orders WHERE status = 'paid' AND false ORDER BY id", true]]);
  assert.deepEqual((await of("SELECT a FROM t WHERE a > 1 AND b < 2 ORDER BY a", answer(["a"], [23], [["2"]]))).by("empty"), [["SELECT a FROM t WHERE a > 1 AND b < 2 AND false ORDER BY a", true]]);
  assert.deepEqual((await of("WITH t AS (SELECT * FROM orders) SELECT count(*) FROM t", answer(["count"], [20], [["5"]]), "BI shape", false)).by("empty"), [["WITH t AS (SELECT * FROM orders) SELECT count(*) FROM t WHERE false", false]]);
  const agg = "SELECT count(*), sum(amount), max(created_at), string_agg(status, ',' ORDER BY id), array_agg(id), avg(amount) FROM orders";
  assert.deepEqual((await of(agg, answer(["count"], [20], [["5"]]), "BI shape", false)).by("empty").map(([s]) => s), ["SELECT count(*), sum(amount), max(created_at), string_agg(status, ',' ORDER BY id), array_agg(id), avg(amount) FROM orders WHERE false"]);
  assert.deepEqual((await of("SELECT status, count(*) FROM orders GROUP BY status HAVING count(*) > 0 ORDER BY status", answer(["status", "count"], [25, 20], [["a", "1"]]))).by("empty").map(([s]) => s), ["SELECT status, count(*) FROM orders WHERE false GROUP BY status HAVING count(*) > 0 ORDER BY status"]);
  for (const sql of ["SELECT 1 + 1", "VALUES (1), (2)", "(SELECT id FROM orders) UNION ALL (SELECT id FROM customers)"]) assert.ok(!(await of(sql, answer(["x"], [23], [["2"]]))).names.has("empty"), `no empty: ${sql}`);
});

test("the bounds of the outermost query, each read back through the printer", async () => {
  const B = "SELECT c.id, c.name, count(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id DESC LIMIT 7 OFFSET 3";
  const head = "SELECT c.id, c.name, count(o.id) AS n FROM customers AS c LEFT JOIN orders AS o ON o.customer_id = c.id GROUP BY c.id ORDER BY c.id DESC";
  const b = await of(B, answer(["id", "name", "n"], [20, 25, 20], [["1", "a", "0"]]));
  assert.deepEqual(["count-zero", "count-negative", "count-null", "offset-negative", "bound-expression"].map((s) => b.by(s)[0]), [
    [`${head} LIMIT 0 OFFSET 3`, false], [`${head} LIMIT -1 OFFSET 3`, false], [`${head} LIMIT NULL OFFSET NULL`, false], [`${head} LIMIT 7 OFFSET -1`, false], [`${head} LIMIT 7 + 0 OFFSET 3 + 0`, true]]);
  assert.ok(!b.names.has("offset-zero"), "an offset is written: no offset-zero");
  assert.deepEqual((await of("SELECT o.id, o.status FROM orders o ORDER BY o.id LIMIT 20", answer(["id", "status"], [20, 25], [["1", "a"]]))).by("offset-zero"), [["SELECT o.id, o.status FROM orders AS o ORDER BY o.id LIMIT 20 OFFSET 0", true]]);
  const set = await of("(SELECT id FROM orders) UNION ALL (SELECT id FROM customers) ORDER BY 1 LIMIT 4 OFFSET 2", answer(["id"], [20], [["1"]]));
  const arms = "SELECT id FROM orders UNION ALL SELECT id FROM customers ORDER BY 1";
  assert.deepEqual(["count-zero", "count-negative", "count-null", "offset-negative", "bound-expression"].map((s) => set.by(s)[0]?.[0]), [
    `${arms} LIMIT 0 OFFSET 2`, `${arms} LIMIT -1 OFFSET 2`, `${arms} LIMIT NULL OFFSET NULL`, `${arms} LIMIT 4 OFFSET -1`, `${arms} LIMIT 4 + 0 OFFSET 2 + 0`]);
  // an inner bound is not reached
  const inner = await of("SELECT * FROM (SELECT c.id, c.name AS who, count(o.id) AS n FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY who, c.id LIMIT 6) g ORDER BY who, id", answer(["id", "who", "n"], [20, 25, 20], [["1", "a", "0"]]));
  assert.deepEqual(["count-zero", "count-negative", "count-null", "offset-negative", "bound-expression", "offset-zero"].filter((s) => inner.names.has(s) || inner.r.unspellable.includes(s as never)), []);
  // an ARRAY[…] beside: the printer's list offsets are not a difference
  const arr = await of("SELECT a, ARRAY[1, 2] AS arr FROM t ORDER BY a LIMIT 5", answer(["a", "arr"], [23, 1007], [["1", "{1,2}"]]));
  assert.deepEqual(arr.r.unspellable, []);
  assert.ok(["empty", "count-zero", "count-negative", "count-null", "offset-negative", "bound-expression", "offset-zero"].every((s) => arr.names.has(s)));
});

test("FETCH … WITH TIES: the printer drops WITH TIES, so every bound and empty is unspellable and not asked", async () => {
  const t = await of("SELECT o.id FROM orders o ORDER BY 1.5::numeric, o.id FETCH FIRST 3 ROWS WITH TIES", answer(["id"], [20], [["1"]]));
  assert.deepEqual(t.r.unspellable, ["empty", "count-zero", "count-negative", "count-null", "offset-negative", "bound-expression", "offset-zero"]);
  assert.ok(!["empty", "count-zero", "count-null", "bound-expression"].some((s) => t.names.has(s)));
});

test("the numeric readers: every numeric output by Postgres's name, over a derived table or a CTE", async () => {
  const { by } = await of(S, SA);
  assert.deepEqual(by("numeric-distinct"), [[`SELECT DISTINCT mason_shape."third" FROM (${S}) AS mason_shape`, false]]);
  assert.deepEqual(by("numeric-text"), [[`SELECT mason_shape."third"::text FROM (${S}) AS mason_shape`, false]]);
  assert.deepEqual(by("numeric-aggregate"), [[`WITH mason_shape AS (${S}) SELECT sum(mason_shape."third"), min(mason_shape."third"), max(mason_shape."third"), count(DISTINCT mason_shape."third") FROM mason_shape`, false]]);
  assert.deepEqual(by("numeric-ordered"), [[`SELECT mason_shape."third" FROM (${S}) AS mason_shape ORDER BY mason_shape."third", mason_shape."third"::text COLLATE "C"`, true]]);
  const two = "SELECT i.unit_price, i.unit_price / 7 AS q FROM order_items i ORDER BY i.id LIMIT 20";
  const t = await of(two, answer(["unit_price", "q"], [1700, 1700], [["1.00", "0.14"]], [786438, -1]));
  assert.deepEqual(t.by("numeric-distinct"), [[`SELECT DISTINCT mason_shape."unit_price", mason_shape."q" FROM (${two}) AS mason_shape`, false]]);
  assert.deepEqual(t.by("numeric-ordered"), [[`SELECT mason_shape."unit_price", mason_shape."q" FROM (${two}) AS mason_shape ORDER BY mason_shape."unit_price", mason_shape."unit_price"::text COLLATE "C", mason_shape."q", mason_shape."q"::text COLLATE "C"`, true]]);
  const star = "SELECT * FROM order_items ORDER BY id LIMIT 5";
  assert.deepEqual((await of(star, answer(["id", "unit_price"], [20, 1700], [["1", "2.00"]]))).by("numeric-distinct"), [[`SELECT DISTINCT mason_shape."unit_price" FROM (${star}) AS mason_shape`, false]]);
  assert.ok(!(await of("SELECT i.id, (i.unit_price / 3)::text AS third FROM order_items i ORDER BY i.id LIMIT 20", answer(["id", "third"], [20, 25], [["1", "1"]]))).names.has("numeric-distinct"));
  assert.ok(!(await of("SELECT o.amount, i.unit_price AS amount FROM orders o JOIN order_items i ON i.order_id = o.id", answer(["amount", "amount"], [1700, 1700], [["1", "1"]]))).names.has("numeric-distinct"), "duplicate names");
});

test("no shape at all, and a spliced text that does not read back as the statement is unspellable", async () => {
  for (const sql of ["SHOW TimeZone", "EXPLAIN SELECT 1", "SELECT id FROM orders FOR UPDATE"]) assert.deepEqual((await of(sql, answer(["x"], [25], [["a"]]))).r, { shaped: [], unspellable: [] }, sql);
  // a trailing line comment swallows the rest of each splice: none of them reads back, none is asked
  const c = await of("SELECT o.id FROM orders o ORDER BY o.id LIMIT 5 -- a comment", answer(["id"], [20], [["1"]]));
  assert.deepEqual(c.r.shaped.filter((s) => s.shape in NEW_SHAPES && s.shape.endsWith("arm")).map((s) => s.shape), []);
  assert.ok(["values-arm", "null-arm", "integer-arm"].every((s) => c.r.unspellable.includes(s as never)), c.r.unspellable.join());
});

test("a dead or misspelt new shape is said by name; the first six are not held to it", () => {
  const alive = (c: Partial<ShapeCount>): ShapeCount => ({ ...emptyShapeCount(), asked: 1, answeredAlike: 1, ...c });
  const all = Object.fromEntries(Object.keys(NEW_SHAPES).map((s) => [s, alive({})]));
  all["count-negative"] = alive({ answeredAlike: 0, refusedAlike: { "2201W": 3 }, postgresRefused: { "2201W": 3 } });
  all["offset-negative"] = alive({ answeredAlike: 0, refusedAlike: { "2201X": 3 }, postgresRefused: { "2201X": 3 } });
  assert.deepEqual(shapeProblems(all), [], "every new shape alive");
  assert.match(shapeProblems({ ...all, "char-arm": alive({ asked: 40, answeredAlike: 0, refusedByGap: 40 }) }).join("\n"), /the shape char-arm is dead/);
  const misspelt = shapeProblems({ ...all, "values-arm": alive({ asked: 30, answeredAlike: 0, refusedAlike: { "42804": 30 }, postgresRefused: { "42804": 30 } }) });
  assert.match(misspelt.join("\n"), /the shape values-arm is dead/);
  assert.match(misspelt.join("\n"), /the shape values-arm is misspelt: Postgres refused it 30 time\(s\) with 42804/);
  assert.deepEqual(shapeProblems({ ...all, "table-arm": alive({ answeredAlike: 5, refusedAlike: { "42883": 2 }, postgresRefused: { "42883": 2 } }) }), [], "a declared refusal beside answers");
  assert.deepEqual(shapeProblems({ ...all, "integer-arm": alive({ answeredAlike: 0, decided: 4 }) }), [], "a shape whose every ask meets a recorded decision still lives");
  assert.match(shapeProblems({ ...all, "count-negative": alive({ answeredAlike: 3 }) }).join("\n"), /count-negative is dead: no statement's shape was refused alike with 2201W/);
  // summed across legs: alive in either
  const legA = { ...all, "char-arm": alive({ answeredAlike: 0 }) }, legB = { "char-arm": alive({ answeredAlike: 1 }) };
  assert.deepEqual(shapeProblems(sumShapeTallies([legA, legB])), []);
  assert.deepEqual(shapeProblems({ ...all, subquery: alive({ answeredAlike: 0, postgresRefused: { "42601": 1 } }) }), [], "the first six are tallied, not held");
});
