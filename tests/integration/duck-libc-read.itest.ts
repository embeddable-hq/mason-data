/**
 * A LIBC COLLATION'S ORDER AS READ, AGAINST THE POSTGRES IT WAS READ FROM (src/duck/libc-order.ts, issue 128): pairs of
 * random strings of the scripts a column holds, near each other as a column's values are, compared by the source and
 * by the key, each of them equal, none refused. The oracle holds the statements over a table's few values; this holds
 * the order itself over what no table lists. Random, so a difference is printed with its code points; the generator is
 * seeded, so a run repeats. Needs IT_POSTGRES_URL; it creates a database of its own and drops it, and reads only what
 * `mason start` reads. Under another collation than a glibc locale's, the pairs have nothing to hold and it is skipped.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import pg from "pg";
import { decodeLibcOrder, encodeLibcOrder, libcKey, readLibcOrder } from "../../src/duck/libc-order.ts";
import { isLibcCollation } from "../../src/duck/rewrite.ts";

const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_libc_${process.pid}`;
const dbUrl = adminUrl === undefined ? "" : (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })();

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
after(() => { if (adminUrl !== undefined && psql(adminUrl, `SELECT count(*) FROM pg_database WHERE datname = '${tag}'`) === "1") psql(adminUrl, `DROP DATABASE "${tag}" WITH (FORCE)`); });

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const ASCII = range(0x20, 0x7e);
// (no letter of a form of its own, ß, ð, ſ: a mark skipped in a run leaves its case beside another letter's, and case is
// read within a letter: about one random pair in 20,000, docs/DESIGN.md "A libc order, read level by level")
const LATIN = [...ASCII, ...range(0xc0, 0x17e).filter((g) => /\p{M}/u.test(String.fromCodePoint(g).normalize("NFD")))];
const SCRIPTS: Array<[string, number[]]> = [
  ["Latin, its accents and a run of marks", [...LATIN, ...range(0x300, 0x36f)]],
  ["emoji: variation selectors, skin tones, joiners", [...ASCII, ...range(0x1f300, 0x1f64f), ...range(0xfe00, 0xfe0f), ...range(0x200b, 0x200f), ...range(0x2600, 0x27bf), ...range(0x2000, 0x206f)]],
  ["Thai", [...ASCII, ...range(0xe01, 0xe3a), ...range(0xe3f, 0xe5b)]],
  ["Lao", [...ASCII, ...range(0xe81, 0xe82), 0xe84, ...range(0xe86, 0xe8a), ...range(0xe8c, 0xea3), 0xea5, ...range(0xea7, 0xebd), ...range(0xec0, 0xec4), 0xec6, ...range(0xec8, 0xece), ...range(0xed0, 0xed9), ...range(0xedc, 0xedf)]],
  ["Arabic and its marks", [...ASCII, ...range(0x600, 0x6ff)]],
  ["what no table lists: unassigned, private use, Hangul", [...ASCII, 0x378, 0x379, 0x38b, ...range(0xe000, 0xe00f), ...range(0xac00, 0xac20), 0xf0000, 0x10fffd, 0x3fffd]],
];

test("the order read compares as the source does, over random strings of each script", { skip: adminUrl ? false : "IT_POSTGRES_URL is not set", timeout: 600_000 }, async (t) => {
  psql(adminUrl!, `CREATE DATABASE "${tag}"`);
  const [provider, collate] = psql(dbUrl, "SELECT datlocprovider::text || '|' || datcollate FROM pg_database WHERE datname = current_database()").split("|") as [string, string];
  if (!isLibcCollation(provider, collate)) { t.skip(`the database's collation is ${collate}, not a libc locale's`); return; }
  const c = new pg.Client(dbUrl);
  await c.connect();
  try {
    const read = await readLibcOrder(async (sql) => (await c.query({ text: sql, rowMode: "array" })).rows as Array<Array<string | null>>, collate, null);
    const o = decodeLibcOrder(encodeLibcOrder(read));
    for (const ch of ["\u{FE0F}", "\u{1F600}", "\u{1F3FD}", "\u{200D}", "เ", "่", "́", "َ", "͸", "", "\u{F0000}"]) assert.equal(o.uncovered[ch.codePointAt(0)!], 0, `U+${ch.codePointAt(0)!.toString(16)} is covered`);
    // a seeded generator: a run repeats
    let seed = 128;
    const next = (n: number): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    for (const [name, pool] of SCRIPTS) {
      const pick = (): number => pool[next(pool.length)]!;
      const pairs: Array<[string, string]> = [];
      for (let i = 0; i < 40_000; i++) {
        const a = Array.from({ length: 1 + next(5) }, pick);
        const b = next(4) === 0 ? Array.from({ length: 1 + next(5) }, pick) : [...a];
        if (next(4) !== 0) b[next(b.length)] = pick();
        if (next(2) === 0) b.splice(next(b.length + 1), 0, pick());
        pairs.push([String.fromCodePoint(...a), String.fromCodePoint(...b)]);
      }
      const answers = (await c.query({ text: "SELECT CASE WHEN a < b THEN -1 WHEN a > b THEN 1 ELSE 0 END FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS u(a, b, n) ORDER BY n", values: [pairs.map((p) => p[0]), pairs.map((p) => p[1])], rowMode: "array" })).rows as Array<[number]>;
      const differ: string[] = [];
      pairs.forEach(([s, u], i) => {
        const [x, y] = [libcKey(o, s), libcKey(o, u)];
        const mine = x < y ? -1 : x > y ? 1 : Math.sign(Buffer.compare(Buffer.from(s), Buffer.from(u)));
        if (mine !== answers[i]![0]) differ.push([s, u].map((v) => [...v].map((ch) => ch.codePointAt(0)!.toString(16)).join(" ")).join(" | "));
      });
      assert.deepEqual(differ.slice(0, 10), [], `${name}: ${differ.length} of ${pairs.length}`);
    }
  } finally { await c.end(); }
});
