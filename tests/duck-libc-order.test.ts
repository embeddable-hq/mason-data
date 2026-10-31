/**
 * TEXT IN A LIBC COLLATION'S ORDER (src/duck/libc-order.ts): the order is read from the database, kept in the copy, and
 * every sort key the rewrite writes under a libc collation is built from it. Offline, over a SMALL order written here
 * the way glibc's en_US.utf8 was measured to be (the module's header): Hangul with no letter weight and one shared
 * last-level weight, `$` with a letter-level weight below the letters, `@` and `-` with none, U+FFFD after the letters,
 * ß equal to ss, CJK with no last-level weight. That glibc IS so is the oracle's to hold, against a real one
 * (tests/integration/duck-oracle.itest.ts, the `coll` table); this holds the mechanics and the wiring to it.
 */
import { test, after } from "node:test";
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { LibcOrder } from "../src/duck/libc-order.ts";
import { handLibcOrder, lettersOf } from "./libc-order-fixture.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-libc-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const lib = (): Promise<typeof import("../src/duck/libc-order.ts")> => import("../src/duck/libc-order.ts");

/** the order: `handLibcOrder`'s first-level classes, the ignored characters' last-level classes, an expansion */
function order(): LibcOrder {
  return handLibcOrder(["$", "0", "1", ...lettersOf({ a: "á", e: "é" }), "三", "�"], ["대지가나", " ", "-", ":", "@", "~"], { noLast: "三", expansions: { "ß": "ss" } });
}

test("a libc key orders as the order read says: the first level, then the last as (position, weight), a value holding an uncovered character refused", async () => {
  const { libcKey, encodeLibcOrder, decodeLibcOrder } = await lib();
  const o = decodeLibcOrder(encodeLibcOrder(order()));
  const sorted = (xs: string[]): string[] => [...xs].sort((a, b) => {
    const [x, y] = [libcKey(o, a), libcKey(o, b)];
    return x !== y ? (x < y ? -1 : 1) : Buffer.compare(Buffer.from(a), Buffer.from(b));
  });
  // Hangul has no first-level weight (before the letters), U+FFFD sorts after them, $ has one below them, @ none
  assert.deepEqual(sorted(["zebra", "대지", "Animal", "Do�a", "Dob"]), ["대지", "Animal", "Dob", "Do�a", "zebra"]);
  assert.deepEqual(sorted(["@x", "$x", "ax"]), ["$x", "ax", "@x"]);
  // the last level, position first: 三 has none there, so it sorts first, and :三 (a weight at 1) before 三가 (at 2), as
  // glibc sorts them; Hangul before the punctuation
  assert.deepEqual(sorted([":三", "三", "三가", "가三"]), ["三", "가三", ":三", "三가"]);
  assert.deepEqual(sorted(["-", "가", "--", "-@", "@"]), ["가", "-", "--", "-@", "@"]);
  // ß is ss at the first level
  assert.equal(libcKey(o, "ß").split(" ")[0], libcKey(o, "ss").split(" ")[0]);
  assert.throws(() => libcKey(o, "e\u0301"), /a text being ordered holds a character Mason cannot order as the database's collation en_US\.utf8 does \(Mason gap libc-uncovered\)/);
});

test("what glibc's strcoll does beyond the letters, in the key: a run read backward and its skip, marks spelling an accent, contractions, what the table does not list", async () => {
  const { libcKey, encodeLibcOrder, decodeLibcOrder, withLookups } = await lib();
  const made = handLibcOrder(["1", "2", "$", "xX", "e" + "E", "\u0E01", "\u0E40"], [" ", "-", "\uFE0F"]);
  const cp = (c: string): number => c.codePointAt(0)!;
  // digits, symbols and punctuation are read backward at the second level; two marks, above BASE, backward too
  for (const c of "12$- \uFE0F") made.back[cp(c)] = 1;
  const [acute, grave] = [0x301, 0x300];
  made.l2[acute] = 2; made.l2[grave] = 3;
  for (const g of [acute, grave]) { made.l3[g] = 1; made.l4[g] = 9; made.back[g] = 1; made.uncovered[g] = 0; }
  // é is e and the acute, at the last level one weight of its own
  made.sequences.set(0xe9, { l1: [made.l1[cp("e")]!], l2: [1, 2], l3: [1, 1], l4: [10], back: false });
  made.uncovered[0xe9] = 0;
  // เก is the two swapped, one element of two last-level weights
  const [ko, sara] = [0xe01, 0xe40];
  made.contractions.set(sara, [{ rest: [ko], element: { l1: [made.l1[ko]!, made.l1[sara]!], l2: [1, 1], l3: [1, 1], l4: [made.l4[ko]!, made.l4[sara]!], back: false } }]);
  // not listed: one element per byte of its UTF-8
  for (const g of [0x378, 0xe000, 0xf0000]) { made.l4[g] = 8; made.unlisted[g] = 1; made.uncovered[g] = 0; }
  const o = decodeLibcOrder(encodeLibcOrder(withLookups(made)));
  const sorted = (xs: string[]): string[] => [...xs].sort((a, b) => {
    const [x, y] = [libcKey(o, a), libcKey(o, b)];
    return x !== y ? (x < y ? -1 : 1) : Buffer.compare(Buffer.from(a), Buffer.from(b));
  });
  // a run closed by a forward element skips the one before its last, so `1-X` has one BASE fewer: the case does not reach it
  assert.deepEqual(sorted(["1x", "1-X"]), ["1-X", "1x"]);
  assert.deepEqual(sorted(["xx", "x-X"]), ["xx", "x-X"], "no run: the case first");
  assert.deepEqual(sorted(["12x", "1-2x"]), ["12x", "1-2x"], "the skip takes a digit from one, the hyphen from the other");
  // read backward: the mark before the BASE of the digit it follows, and the skip takes the first of two marks
  assert.deepEqual(sorted(["1\u0301", "1\u0300"]), ["1\u0301", "1\u0300"]);
  assert.equal(libcKey(o, "e\u0301\u0300x").split(" ")[1], libcKey(o, "e\u0300x").split(" ")[1], "the acute is skipped");
  // the accent, by its mark or in its letter: one sequence, told apart at the last level
  assert.deepEqual(libcKey(o, "e\u0301").split(" ").slice(0, 3), libcKey(o, "\u00e9").split(" ").slice(0, 3));
  // the Thai vowel sorts after its consonant, by a contraction; alone it is itself
  assert.equal(libcKey(o, "\u0E40\u0E01").split(" ")[0], libcKey(o, "\u0E01\u0E40").split(" ")[0]);
  assert.notEqual(libcKey(o, "\u0E40x").split(" ")[0], libcKey(o, "x\u0E40").split(" ")[0]);
  // U+0378 is two elements, U+E000 three, U+F0000 four; the same pairs up to the shorter one's end
  assert.deepEqual(sorted(["\u{F0000}", "\u0378", "\uE000"]), ["\u0378", "\uE000", "\u{F0000}"]);
  assert.equal(libcKey(o, "\u0378x").split(" ")[3]!.length, 3 * 12);
});

test("the order is read from the database once, kept in the copy, and read again when its collation version moves", async () => {
  const store = await DuckStore.open(path.join(dir, "kept.db"), () => undefined);
  try {
    let reads = 0;
    const read = async (): Promise<LibcOrder> => { reads++; return order(); };
    const first = await store.libcOrder("en_US.utf8", "2.41", read);
    const again = await store.libcOrder("en_US.utf8", "2.41", read);
    assert.deepEqual([first.read, again.read, reads], [true, false, 1]);
    assert.equal(again.order.l1["a".codePointAt(0)!], first.order.l1["a".codePointAt(0)!]);
    // an OS upgrade's glibc: the order may have moved, so it is read again
    assert.equal((await store.libcOrder("en_US.utf8", "2.42", read)).read, true);
    assert.equal(reads, 2);
    // an order kept by a release that read fewer levels (issue 128) is read again, never decoded
    await store.writer.run(`UPDATE _mason.libc_order SET data = '{"collate":"en_US.utf8","version":"2.42","l1":[],"l4":[],"covered":[],"expansions":[]}'`);
    assert.equal((await store.libcOrder("en_US.utf8", "2.42", read)).read, true);
    assert.equal(reads, 3);
  } finally { store.close(); }
});

test("ORDER BY, < and min / max under a libc collation follow the order read, through the wire", async () => {
  const store = await DuckStore.open(path.join(dir, "wire.db"), () => undefined);
  let api: PgApiServer | null = null;
  const KEY = "k".repeat(48);
  try {
    await store.writer.run("CREATE TABLE public.coll (id INTEGER PRIMARY KEY, s VARCHAR)");
    await store.writer.run("INSERT INTO public.coll VALUES (1, '대지'), (2, 'Animal'), (3, 'zebra'), (4, 'Dob'), (5, 'Do' || chr(65533) || 'a'), (6, '$x'), (7, '@x'), (99, chr(13289))");
    const schema: PgSchema = { database: "app", tables: [{ name: "coll", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }, { name: "s", type: "text" }] }] };
    const duck = await store.listener({ provider: "c", collate: "en_US.utf8", locale: null }, null, order());
    api = await startPostgresApi({
      port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test",
      authenticate: (password) => { const p = tokenProblem(KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
      schema: () => schema,
      record: () => undefined, log: () => undefined, duck,
    });
    const c = new pg.Client({ host: "127.0.0.1", port: api.port, user: "me", password: mintToken(KEY, 600).token, database: "app" });
    await c.connect();
    try {
      const rows = async (sql: string): Promise<unknown[][]> => (await c.query({ text: sql, rowMode: "array" })).rows;
      assert.deepEqual((await rows("SELECT s FROM coll WHERE id < 90 ORDER BY s")).flat(), ["대지", "$x", "Animal", "Dob", "Do�a", "@x", "zebra"]);
      assert.deepEqual(await rows("SELECT count(*) FILTER (WHERE s < 'b'), min(s), max(s) FROM coll WHERE id < 90"), [["3", "대지", "zebra"]]);
      await assert.rejects(c.query("SELECT s FROM coll ORDER BY s"), (e: pg.DatabaseError) => e.code === "0A000" && /Mason gap libc-uncovered/.test(e.message));
      // ISSUE 112: an output of a * sorted by its number or its bare name is that column, under the collation's key
      const sorted = ["대지", "$x", "Animal", "Dob", "Do�a", "@x", "zebra"];
      for (const sql of ["SELECT * FROM coll WHERE id < 90 ORDER BY 2, 1", "SELECT * FROM coll WHERE id < 90 ORDER BY s, id", "SELECT t.* FROM coll t WHERE id < 90 ORDER BY 2, 1",
        "SELECT *, id FROM coll WHERE id < 90 ORDER BY 2, 3", "WITH w AS (SELECT * FROM coll WHERE id < 90) SELECT * FROM w ORDER BY 2, 1", "SELECT * FROM coll AS x(key, label) WHERE key < 90 ORDER BY label, key",
        "SELECT * FROM (SELECT * FROM coll WHERE id < 90) s UNION ALL SELECT * FROM coll WHERE id < 0 ORDER BY 2, 1", "SELECT * FROM (SELECT * FROM coll WHERE id < 90) s UNION ALL SELECT * FROM coll WHERE id < 0 ORDER BY s, id"]) {
        assert.deepEqual((await rows(sql)).map((r) => r[1]), sorted, sql);
      }
      // a set operation in a WITH query: which rows its own LIMIT keeps
      assert.deepEqual((await rows("WITH w AS (SELECT * FROM coll WHERE id < 90 UNION ALL SELECT * FROM coll WHERE id < 0 ORDER BY s, id LIMIT 3) SELECT s FROM w")).flat().sort(), sorted.slice(0, 3).sort());
      // which rows a LIMIT keeps; a number past the *, of a target's own
      assert.deepEqual((await rows("SELECT * FROM coll WHERE id < 90 ORDER BY 2, 1 LIMIT 3")).map((r) => r[1]), sorted.slice(0, 3));
      assert.deepEqual((await rows("SELECT *, s AS again FROM coll WHERE id < 90 ORDER BY 3, 1")).map((r) => r[2]), sorted);
      assert.deepEqual((await rows("SELECT *, lower(s) AS low FROM coll WHERE id IN (2, 3) ORDER BY 3 DESC")).map((r) => r[1]), ["zebra", "Animal"]);
      // a list of VALUES read through its number: `a` before `B` under the collation, after it in bytes
      assert.deepEqual((await rows("SELECT * FROM coll, (VALUES ('a'), ('B')) AS v WHERE id = 2 ORDER BY 3")).map((r) => r[2]), ["a", "B"]);
      assert.deepEqual((await rows("SELECT * FROM coll, (VALUES ('B', 1), ('a', 2)) AS v WHERE id = 2 ORDER BY column1")).map((r) => r[2]), ["a", "B"]);
    } finally { await c.end(); }
  } finally { await api?.close(); store.close(); }
});
