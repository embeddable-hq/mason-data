/**
 * TEXT IN A LIBC COLLATION'S ORDER (src/duck/libc-order.ts): the order is read from the database, kept in the copy, and
 * every sort key the rewrite writes under a libc collation is built from it. Offline, over a SMALL order written here
 * the way glibc's en_US.utf8 was measured to be (the module's header): Hangul with no letter weight and one shared
 * last-level weight, `$` with a letter-level weight below the letters, `@` and `-` with none, U+FFFD after the letters,
 * ß equal to ss, CJK with no last-level weight. That glibc IS so is the oracle's to hold, against a real one
 * (tests/integration/duck-oracle.itest.ts, the `coll` table); this holds the mechanics and the wiring to it.
 */
import { test, after } from "node:test";
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-libc-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const lib = (): Promise<typeof import("../src/duck/libc-order.ts")> => import("../src/duck/libc-order.ts");

/** the order: first-level classes in order (each a string of the characters in it), the ignored characters' last-level
 *  classes in order, the last-level weight of the first-level characters (by class name: "high" above every ignored
 *  one, "none"), expansions */
function order(): LibcOrder {
  const MAX = 0x110000;
  const l1 = new Uint32Array(MAX), l4 = new Uint32Array(MAX), uncovered = new Uint8Array(MAX).fill(1);
  const cp = (c: string): number => c.codePointAt(0)!;
  const letters = "abcdefghijklmnopqrstuvwxyz".split("").map((x) => x + x.toUpperCase() + (x === "a" ? "á" : x === "e" ? "é" : ""));
  const first = ["$", "0", "1", ...letters, "三", "�"];
  const ignored = ["대지가나", " ", "-", ":", "@", "~"];
  ignored.forEach((cls, i) => { for (const c of cls) { l4[cp(c)] = 2 * (i + 1); uncovered[cp(c)] = 0; } });
  first.forEach((cls, i) => { for (const c of cls) { l1[cp(c)] = i + 1; uncovered[cp(c)] = 0; l4[cp(c)] = c === "三" ? 0 : 2 * ignored.length + 1; } });
  // its class is s's: the expansion makes it ss
  l1[cp("ß")] = l1[cp("s")]!; uncovered[cp("ß")] = 0; l4[cp("ß")] = 2 * ignored.length + 1;
  return { collate: "en_US.utf8", version: "2.41", l1, l4, uncovered, expansions: new Map([[cp("ß"), [cp("s"), cp("s")]]]) };
}

test("a libc key orders as the order read says: the first level, then the last as (position, weight), a value holding an uncovered character refused", async () => {
  const { libcKey, libcKept, encodeLibcOrder, decodeLibcOrder } = await lib();
  const o = decodeLibcOrder(encodeLibcOrder(order()));
  const sorted = (xs: string[]): string[] => [...xs].sort((a, b) => {
    // ICU's accent and case levels are DuckDB's (tested through the wire below): equal here, so they decide nothing
    const [x, y] = [libcKey(o, a, ""), libcKey(o, b, "")];
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
  assert.equal(libcKey(o, "ß", "").split(" ")[0], libcKey(o, "ss", "").split(" ")[0]);
  assert.equal(libcKept(o, "a-b 대"), "ab");
  assert.throws(() => libcKey(o, "é", ""), /holds U\+0301, which Mason cannot order as the database's collation en_US\.utf8 does \(Mason gap libc-uncovered\)/);
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
  } finally { store.close(); }
});

test("ORDER BY, < and min / max under a libc collation follow the order read, through the wire", async () => {
  const store = await DuckStore.open(path.join(dir, "wire.db"), () => undefined);
  let api: PgApiServer | null = null;
  const KEY = "k".repeat(48);
  try {
    await store.writer.run("CREATE TABLE public.coll (id INTEGER PRIMARY KEY, s VARCHAR)");
    await store.writer.run("INSERT INTO public.coll VALUES (1, '대지'), (2, 'Animal'), (3, 'zebra'), (4, 'Dob'), (5, 'Do' || chr(65533) || 'a'), (6, '$x'), (7, '@x'), (99, 'e' || chr(769))");
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
