/**
 * TEXT THAT STARTS WITH A BYTE-ORDER MARK, OFFLINE (issue 991, src/duck/text.ts): every string Mason reads out of the
 * synced data keeps a leading U+FEFF (a value, the text inside a list or a struct, a name from DESCRIBE), and an
 * array's or a row's text is written and read with Postgres's white space, never JavaScript's (which takes U+FEFF and
 * U+00A0). tests/integration/duck-bom.itest.ts holds the same through the wire against a real Postgres.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import { arrayText, recordText } from "../src/duck/functions.ts";
import { pgArrayTree } from "../src/duck/stream.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-text-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const BOM = "\uFEFF", NBSP = "\u00A0";
const show = (v: unknown): string => JSON.stringify(v).replaceAll(BOM, "<BOM>");

test("every string read out of the synced data keeps a leading U+FEFF: a value, a list's and a struct's text, a name from DESCRIBE", async () => {
  const store = await DuckStore.open(path.join(dir, "bom.db"), () => undefined, { memoryLimit: "64MB" });
  try {
    const sql = `SELECT chr(65279) AS only, chr(65279) || 'a' AS one, chr(65279) || chr(65279) || 'a' AS two, 'x' || chr(65279) || 'a' AS mid, ` +
      `[chr(65279) || 'a', 'b', chr(65279)] AS list, {'k': chr(65279) || 'v'} AS struct`;
    const want = [BOM, `${BOM}a`, `${BOM}${BOM}a`, `x${BOM}a`, [`${BOM}a`, "b", BOM], { k: `${BOM}v` }];
    const read = await store.writer.runAndReadAll(sql);
    assert.equal(show(read.getRowsJS()[0]), show(want), "getRowsJS");
    assert.equal(show(read.getRowsJson()[0]), show(want), "getRowsJson");
    // a column whose name starts with a mark: DESCRIBE names it whole, so the copy finds its type (a numeric stays one)
    await store.writer.run(`CREATE TABLE public.t ("${BOM}amount" DECIMAL(10,2), plain VARCHAR)`);
    const described = (await store.writer.runAndReadAll(`DESCRIBE SELECT "${BOM}amount", plain FROM public.t`)).getRowsJS().map((r) => [r[0], r[1]]);
    assert.equal(show(described), show([[`${BOM}amount`, "DECIMAL(10,2)"], ["plain", "VARCHAR"]]));
  } finally { await store.close(); }
});

test("an array's and a row's text quote what Postgres quotes, and the stream reads an element whole: U+FEFF and U+00A0 are no white space", () => {
  // each as Postgres 16 and 18 write it (array_out, record_out)
  assert.equal(show(arrayText([`${BOM}a`, `a${NBSP}b`, BOM, "a\vb", "a b", ""], false)), show(`{${BOM}a,a${NBSP}b,${BOM},"a\vb","a b",""}`));
  assert.equal(show(recordText([`${BOM}a`, `a${NBSP}b`, "a\fb", null])), show(`(${BOM}a,a${NBSP}b,"a\fb",)`));
  // array_in: white space around an element is skipped, a mark or a non-breaking space is the element's
  assert.equal(show(pgArrayTree(`{${BOM}a,b,${BOM}}`)), show([`${BOM}a`, "b", BOM]));
  assert.equal(show(pgArrayTree(`{ ${BOM}a , ${NBSP}b ,\vc\v}`)), show([`${BOM}a`, `${NBSP}b`, "c"]));
  assert.equal(show(pgArrayTree(`{${BOM}}`)), show([BOM]));
});
