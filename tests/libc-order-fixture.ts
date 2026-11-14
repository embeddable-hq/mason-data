/**
 * A LIBC ORDER SMALL ENOUGH TO WRITE BY HAND, the shape of what `readLibcOrder` reads of glibc's en_US.utf8
 * (src/duck/libc-order.ts): the offline tests' stand-in, whose mechanics the oracle holds to a real glibc.
 */
import { emptyLibcOrder, withLookups, type LibcOrder } from "../src/duck/libc-order.ts";

/**
 * `first`: the first-level classes in order, each a string of its characters: the first its plain one, an upper-case
 * letter a case above it, any other a mark's accent above it. `ignored`: the classes with no first-level weight, in the
 * last level's order (each a string of characters sharing a weight). `noLast`: characters with no last-level weight.
 * `expansions`: a character that is a string of others at the first level. Nothing else is covered.
 */
export function handLibcOrder(first: readonly string[], ignored: readonly string[], options: { noLast?: string; expansions?: Readonly<Record<string, string>>; collate?: string; version?: string } = {}): LibcOrder {
  const o = emptyLibcOrder(options.collate ?? "en_US.utf8", options.version ?? "2.41");
  const cp = (c: string): number => c.codePointAt(0)!;
  const last = 2 * ignored.length + 1;
  ignored.forEach((cls, i) => { for (const c of cls) { o.l4[cp(c)] = 2 * (i + 1); o.uncovered[cp(c)] = 0; } });
  first.forEach((cls, i) => {
    [...cls].forEach((c, n) => {
      const g = cp(c), accent = n > 0 && c.toLowerCase() === c;
      o.l1[g] = i + 1; o.l2[g] = 1; o.l3[g] = n > 0 && !accent ? 2049 : 1; o.l4[g] = options.noLast?.includes(c) === true ? 0 : last; o.uncovered[g] = 0;
      if (accent) o.sequences.set(g, { l1: [i + 1], l2: [1, 2], l3: [1, 1], l4: [last], back: false });
    });
  });
  for (const [c, e] of Object.entries(options.expansions ?? {})) {
    const units = [...e].map((u) => o.l1[cp(u)]!);
    o.sequences.set(cp(c), { l1: units, l2: units.map(() => 1), l3: units.map(() => 1), l4: [last], back: false });
    o.uncovered[cp(c)] = 0;
  }
  return withLookups(o);
}

/** the letters a to z with their upper case, and a given letter's accents */
export const lettersOf = (accents: Readonly<Record<string, string>> = {}): string[] =>
  "abcdefghijklmnopqrstuvwxyz".split("").map((x) => x + x.toUpperCase() + (accents[x] ?? ""));

/**
 * THE BOUNDS' PROOF OBLIGATION (src/duck/libc-bound.ts), over `strings`, the bounds computed by THE ENGINE from the
 * module's own expressions (never a copy of them in JavaScript): hi(a) < lo(b) implies libcKey(a) < libcKey(b) at the
 * first level, strictly, for every pair of strings the order keys; lo(s) <= hi(s); equal strings have equal bounds.
 * Every pair is held at once: sorted by the first level, each b against the least hi of every a not below it. What it
 * returns: the failures (none, when it holds), and how many strings a top 1 rules out (it must bound something).
 */
export async function holdBounds(o: LibcOrder, strings: readonly string[]): Promise<{ failures: string[]; ruledOut: number }> {
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const { deparseSync } = await import("pgsql-deparser");
  const { boundOf, lowBound, highBound } = await import("../src/duck/libc-bound.ts");
  const { libcKey } = await import("../src/duck/libc-order.ts");
  const bound = boundOf(o);
  if (bound === null) return { failures: ["the order has no bounds"], ruledOut: 0 };
  const column = (name: string): Record<string, unknown> => ({ ColumnRef: { fields: [{ String: { sval: name } }] } });
  const select = { SelectStmt: { targetList: [{ ResTarget: { val: lowBound(bound, column("s")) } }, { ResTarget: { val: highBound(bound, column("s")) } }, { ResTarget: { val: column("i") } }],
    fromClause: [{ RangeVar: { relname: "w", inh: true, relpersistence: "p" } }], op: "SETOP_NONE" } };
  const sql = deparseSync(select as never, { pretty: false });
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  const bounds: Array<[string, string]> = [];
  try {
    await c.run("CREATE TABLE w (i INTEGER, s VARCHAR)");
    for (let at = 0; at < strings.length; at += 2000) {
      const part = strings.slice(at, at + 2000).map((x, k) => `(${at + k}, '${x.replaceAll("'", "''")}')`);
      await c.run(`INSERT INTO w VALUES ${part.join(", ")}`);
    }
    for (const [lo, hi, i] of (await c.runAndReadAll(`${sql} ORDER BY 3`)).getRowsJson()) bounds[Number(i)] = [String(lo), String(hi)];
  } finally { c.closeSync(); db.closeSync(); }
  const failures: string[] = [];
  const seen = new Map<string, string>();
  strings.forEach((x, i) => {
    const [lo, hi] = bounds[i]!;
    if (!(lo <= hi)) failures.push(`lo > hi for ${JSON.stringify(x)}`);
    const was = seen.get(x);
    if (was !== undefined && was !== `${lo}\u0000${hi}`) failures.push(`unequal bounds for one string ${JSON.stringify(x)}`);
    seen.set(x, `${lo}\u0000${hi}`);
  });
  // the first level of each string the order keys (a string it refuses has no first level to hold the bounds to)
  const keyed: Array<{ first: string; lo: string; hi: string; x: string }> = [];
  strings.forEach((x, i) => {
    let first: string;
    try { first = libcKey(o, x).split(" ")[0]!; } catch (e) { if (/libc-uncovered/.test(String(e))) return; throw e; }
    keyed.push({ first, lo: bounds[i]![0], hi: bounds[i]![1], x });
  });
  keyed.sort((a, b) => a.first < b.first ? -1 : a.first > b.first ? 1 : 0);
  // the least hi of every string whose first level is not below this one's: hi(a) < lo(b) there claims a < b, wrongly
  let least: { hi: string; x: string } | null = null;
  for (let end = keyed.length; end > 0;) {
    let start = end - 1;
    while (start > 0 && keyed[start - 1]!.first === keyed[end - 1]!.first) start--;
    for (let k = start; k < end; k++) if (least === null || keyed[k]!.hi < least.hi) least = { hi: keyed[k]!.hi, x: keyed[k]!.x };
    for (let k = start; k < end; k++) if (least!.hi < keyed[k]!.lo) failures.push(`hi(${JSON.stringify(least!.x)}) < lo(${JSON.stringify(keyed[k]!.x)}), yet the first is not ordered before the second`);
    end = start;
  }
  const top = keyed.reduce<string | null>((m, k) => m === null || k.hi < m ? k.hi : m, null);
  return { failures: failures.slice(0, 20), ruledOut: top === null ? 0 : bounds.filter(([lo]) => lo > top).length };
}

/** letters of Latin a run may fold (src/duck/libc-bound.ts `folds`), beside what it must not: a letter `strip_accents`
 *  takes to ASCII (É, İ), one a `replace` writes (Ø, ł, ŀ, ª, ²), marks it drops (U+0301, U+0306) and one of a weight
 *  of its own (U+0363), letters of two weights (Ǣ, ß) or none of ASCII's (ð, ı), and words of them beside their ASCII */
export const LATIN_PIECES: readonly string[] = ["É", "é", "é", "Ĕ", "Ø", "ø", "o", "Ł", "ł", "ŀ", "Ö", "ö", "İ", "ı", "ª", "²", "́", "̆",
  "ͣ", "Ǣ", "ǣ", "ð", "Đ", "Ħ", "ſ", "ß", "Ǿ", "ḯ", "Ỳ", "Øster", "oster", "Łódź", "lodz", "Émile", "emile", "eͣx", "ŀl", "l·l"];

/** random strings of `pool`'s pieces (each a character or a few), 0 to `most` of them, by a generator of its own */
export function randomStrings(pool: readonly string[], n: number, most: number, seed: number): string[] {
  const next = (k: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % k;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(Array.from({ length: next(most + 1) }, () => pool[next(pool.length)]!).join(""));
  // each value twice now and then, as a column holds it, and near neighbours: one piece changed
  for (let i = 0; i < n / 10; i++) out.push(out[next(out.length)]!);
  return out;
}
