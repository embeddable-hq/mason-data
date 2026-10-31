/**
 * TEXT IN A GLIBC LOCALE'S ORDER, MEASURED FROM THE SOURCE (the BI-tools test of #517: Metabase's field lists
 * under en_US.utf8 listed Hangul, `$` / `€` and U+FFFD elsewhere than Postgres, and `s < 'b'` counted other rows). The
 * order was emulated from assumptions until then — ICU's order of the letters and digits, the rest ignored, then the
 * punctuation by its bytes — and glibc differs from each: Hangul has no letter weight in it, `$` and `€` have one where
 * `@` and `~` have none, U+FFFD sorts after the letters. So the order is no longer assumed: it is READ from the source
 * database, once (read-only SELECTs, a few seconds), kept in the copy (`mason.libc_order`, src/duck/store.ts), read again
 * when the database's collation version moves (`pg_database.datcollversion`: glibc's), and every sort key is built from it.
 *
 * What glibc compares, as measured (Postgres 18 / glibc 2.41 en_US.utf8, the disposable server's):
 *  1. the FIRST level: a weight per character that has one (letters, digits, `$`, U+FFFD; not punctuation, Hangul or
 *     spaces), compared in order. Read as CLASSES: the characters in the database's order, two neighbours x < y in one
 *     class when x||'b' > y||'a' (only the second character told them apart). A character equal there to a string of
 *     others (ß = ss, æ = ae, ﬁ = fi) is that string: proposed by its compatibility decomposition, kept only when the
 *     source says it is equal;
 *  2. accents, then 3. case: ICU's second and third levels over the characters of level 1 (the source's own agree
 *     with them over everything the sample below holds; nothing here reads them from the source);
 *  4. the LAST level: for each character that has a weight there (punctuation, spaces, Hangul's one shared weight,
 *     Latin letters; not CJK), the pair (its position in the string, its weight), position first — `三 < :三` (`三` has
 *     none) and `가三 < 三가` both follow. The punctuation's weights are their order (they differ in nothing else); a
 *     character of level 1 is placed among them by binary search (p||x < x exactly when p's weight is below x's), and
 *     one placed below all of them has none when x||chr(1) is not below chr(1)||x;
 *  5. a tie at every level is Postgres's byte order (`varstr_cmp`'s strcmp), which the caller adds.
 * Held against the source's ORDER BY over 30,000 random strings of 17 scripts and symbol sets: 2 out of order, both
 * full-width digits beside Hangul. Not covered, so REFUSED by name when a value holding one is ordered
 * (`libc-uncovered`): a combining mark (glibc weighs `e` + U+0301 otherwise than ICU), a Thai or Lao vowel written
 * before its consonant (glibc reorders them), a code point this Node does not know as assigned, a private use one. A
 * known difference (`libc-symbol-punctuation`): punctuation right after a digit or symbol outranks a case difference
 * after it in glibc (`1-X < 1x`), and not here.
 */
import { gapMark } from "./gaps.ts";
import { PgEvalError } from "./pg-eval.ts";

export interface LibcOrder {
  /** pg_database's datcollate and datcollversion: what the order was read under */
  collate: string;
  version: string | null;
  /** per code point: its first-level class, 0 for a character with no first-level weight */
  l1: Uint32Array;
  /** per code point: its last-level weight, 0 for none */
  l4: Uint32Array;
  /** per code point: 1 when it is not covered (refused when ordered) */
  uncovered: Uint8Array;
  /** a character equal at the first level to these */
  expansions: Map<number, number[]>;
}

const MAX = 0x110000;

/** The code points read from the source: assigned, not private use, not a surrogate (the rest are uncovered). */
export function assignedCodePoints(): number[] {
  const out: number[] = [];
  for (let g = 1; g < MAX; g++) {
    if (g >= 0xd800 && g <= 0xdfff) continue;
    if (/[\p{Cn}\p{Co}]/u.test(String.fromCodePoint(g))) continue;
    out.push(g);
  }
  return out;
}

/** what glibc orders otherwise than this ordering: combining marks, Thai and Lao vowels written before their consonant */
const UNCOVERED = /[\p{M}เ-ไເ-ໄ]/u;

const ints = (xs: readonly number[]): string => `'{${xs.join(",")}}'::int[]`;
const texts = (xs: readonly string[]): string => `ARRAY[${xs.map((x) => `'${x.replaceAll("'", "''")}'`).join(",")}]::text[]`;

/** a read of the source: rows of text (or null) */
export type SourceQuery = (sql: string) => Promise<Array<Array<string | null>>>;

/** Reads the source database's order of text (its default collation), as the module's header says. */
export async function readLibcOrder(query: SourceQuery, collate: string, version: string | null): Promise<LibcOrder> {
  const points = assignedCodePoints();
  const l1 = new Uint32Array(MAX), l4 = new Uint32Array(MAX), uncovered = new Uint8Array(MAX).fill(1);
  // each character: whether it has a first-level weight ('b'||c < 'ba' and c||'b' > 'aa' only for one that has none);
  // those that have one in the database's order, each marked when its neighbour below is of its class; the rest in
  // the database's order, each marked when its neighbour below has the same last-level weight (pp > c only then)
  const rows = await query(`WITH c AS (SELECT g, chr(g) AS ch FROM unnest(${ints(points)}) AS u(g)),
    k AS (SELECT g, ch, ('b' || ch < 'ba') AND (ch || 'b' > 'aa') AS ignored FROM c),
    n AS (SELECT g, ch, lag(ch) OVER (ORDER BY ch) AS prev, row_number() OVER (ORDER BY ch) AS pos FROM k WHERE NOT ignored),
    i AS (SELECT g, ch, lag(ch) OVER (ORDER BY ch) AS prev, row_number() OVER (ORDER BY ch) AS pos FROM k WHERE ignored)
    SELECT 'n', g::text, coalesce(prev || 'b' > ch || 'a', false)::text, pos::text FROM n
    UNION ALL SELECT 'i', g::text, coalesce(prev || prev > ch, false)::text, pos::text FROM i`);
  // each kind in the database's order
  rows.sort((a, b) => a[0] === b[0] ? Number(a[3]) - Number(b[3]) : a[0]! < b[0]! ? -1 : 1);
  const weighted: number[] = [];
  const ignoredClasses: number[] = [];   // one character per last-level weight of the ignored ones, in order
  let k = 0;
  for (const [kind, g0, same] of rows) {
    const g = Number(g0);
    uncovered[g] = UNCOVERED.test(String.fromCodePoint(g)) ? 1 : 0;
    if (kind === "n") { if (same !== "true") k++; l1[g] = k; weighted.push(g); }
    else { if (same !== "true" || ignoredClasses.length === 0) ignoredClasses.push(g); l4[g] = 2 * ignoredClasses.length; }
  }
  if (weighted.length === 0 || ignoredClasses.length === 0) throw new Error(`reading how the database orders text (${collate}) found no ${weighted.length === 0 ? "letters" : "punctuation"}: Mason cannot sort text as it does`);

  // expansions: proposed by each character's compatibility decomposition (its marks dropped) and the letters NFKD keeps
  // whole, kept where the source says the two are equal at the first level (each sorts after the other given a later b)
  const proposed: Array<[number, string]> = [];
  for (const g of weighted) {
    const d = String.fromCodePoint(g).normalize("NFKD").replace(/\p{M}/gu, "");
    if ([...d].length > 1 && !d.includes("\0")) proposed.push([g, d]);
  }
  for (const [ch, e] of [["ß", "ss"], ["ẞ", "SS"], ["æ", "ae"], ["Æ", "AE"], ["œ", "oe"], ["Œ", "OE"], ["þ", "th"], ["Þ", "TH"]] as const) proposed.push([ch.codePointAt(0)!, e]);
  const expansions = new Map<number, number[]>();
  for (let at = 0; at < proposed.length; at += 5000) {
    const part = proposed.slice(at, at + 5000);
    const eq = await query(`SELECT g::text, ((chr(g) || 'b' > e || 'a') AND (e || 'b' > chr(g) || 'a'))::text FROM unnest(${ints(part.map((p) => p[0]))}, ${texts(part.map((p) => p[1]))}) AS u(g, e)`);
    eq.forEach(([g, yes], j) => { if (yes === "true") expansions.set(Number(g), [...part[j]![1]].map((c) => c.codePointAt(0)!)); });
  }

  // each first-level character's last-level weight, among the ignored ones' by binary search
  const lo = new Int32Array(weighted.length), hi = new Int32Array(weighted.length).fill(ignoredClasses.length);
  for (;;) {
    const idx: number[] = [], mid: number[] = [];
    for (let i = 0; i < weighted.length; i++) if (lo[i]! < hi[i]!) { idx.push(i); mid.push((lo[i]! + hi[i]!) >> 1); }
    if (idx.length === 0) break;
    const below = await query(`SELECT (chr(p) || chr(x) < chr(x))::text FROM unnest(${ints(mid.map((m) => ignoredClasses[m]!))}, ${ints(idx.map((i) => weighted[i]!))}) WITH ORDINALITY AS u(p, x, n) ORDER BY n`);
    below.forEach(([b], j) => { const i = idx[j]!; if (b === "true") lo[i] = mid[j]! + 1; else hi[i] = mid[j]!; });
  }
  const bottom: number[] = [];
  weighted.forEach((g, i) => { l4[g] = 2 * lo[i]! + 1; if (lo[i] === 0) bottom.push(g); });
  if (bottom.length) {
    const has = await query(`SELECT x::text, (chr(x) || chr(1) < chr(1) || chr(x))::text FROM unnest(${ints(bottom)}) AS u(x)`);
    for (const [x, yes] of has) if (yes !== "true") l4[Number(x)] = 0;
  }
  return { collate, version, l1, l4, uncovered, expansions };
}

/** The characters ICU's accent and case levels read: those with a first-level weight, in order. */
export function libcKept(o: LibcOrder, s: string): string {
  let kept = "";
  for (const ch of s) if (o.l1[ch.codePointAt(0)!]! > 0) kept += ch;
  return kept;
}

const hex6 = (n: number): string => n.toString(16).padStart(6, "0");

/** ICU's sort key from its accent level on: what follows the first level's terminator (byte 01, at an even offset) */
function afterPrimary(icuKey: string): string {
  for (let i = 0; i < icuKey.length; i += 2) if (icuKey.charCodeAt(i) === 48 && icuKey.charCodeAt(i + 1) === 49) return icuKey.slice(i + 2);
  return "";
}

/**
 * The sort key of `s` as one text that orders as glibc orders (bytewise; a space parts the levels, below every hex digit,
 * so a shorter level sorts first): the first-level classes, ICU's accent and case levels of `libcKept(s)` (`icuKey`),
 * the last level's (position, weight) pairs. A value holding a character not covered is refused, by the gap alone.
 */
export function libcKey(o: LibcOrder, s: string, icuKey: string): string {
  let first = "", last = "", at = 0;
  for (const ch of s) {
    at++;
    const g = ch.codePointAt(0)!;
    if (o.uncovered[g]) {
      // never the value, nor the character: a refusal reaches any user, of a row a role may hide (issue 128)
      throw new PgEvalError("0A000", `a text being ordered holds a character Mason cannot order as the database's collation ${o.collate} does (${gapMark("libc-uncovered")})`);
    }
    if (o.l1[g]! > 0) for (const x of o.expansions.get(g) ?? [g]) if (o.l1[x]! > 0) first += hex6(o.l1[x]!);
    if (o.l4[g]! > 0) last += hex6(at) + hex6(o.l4[g]!);
  }
  return `${first} ${afterPrimary(icuKey)} ${last}`;
}

/** The order as bytes, to keep in the copy: the three arrays and the expansions, as JSON. */
export function encodeLibcOrder(o: LibcOrder): string {
  // only the code points that are not 0 / covered: the arrays are mostly empty
  const sparse = (a: Uint32Array | Uint8Array, skip: number): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let g = 0; g < MAX; g++) if (a[g] !== skip) out.push([g, a[g]!]);
    return out;
  };
  return JSON.stringify({ collate: o.collate, version: o.version, l1: sparse(o.l1, 0), l4: sparse(o.l4, 0), covered: sparse(o.uncovered, 1).map(([g]) => g), expansions: [...o.expansions] });
}

export function decodeLibcOrder(text: string): LibcOrder {
  const v = JSON.parse(text) as { collate: string; version: string | null; l1: Array<[number, number]>; l4: Array<[number, number]>; covered: number[]; expansions: Array<[number, number[]]> };
  const l1 = new Uint32Array(MAX), l4 = new Uint32Array(MAX), uncovered = new Uint8Array(MAX).fill(1);
  for (const [g, x] of v.l1) l1[g] = x;
  for (const [g, x] of v.l4) l4[g] = x;
  for (const g of v.covered) uncovered[g] = 0;
  return { collate: v.collate, version: v.version, l1, l4, uncovered, expansions: new Map(v.expansions) };
}
