/**
 * TEXT IN A GLIBC LOCALE'S ORDER, MEASURED FROM THE SOURCE (the BI-tools test of #517: Metabase's field lists under
 * en_US.utf8 listed Hangul, `$` / `€` and U+FFFD elsewhere than Postgres; issue 128: one emoji's U+FE0F refused a whole
 * column's sort). The order is never assumed: it is READ from the source database, once (read-only SELECTs over
 * constants, no table, a few seconds), kept in the copy (`_mason.libc_order`, src/duck/store.ts), read again when the
 * database's collation version moves (`pg_database.datcollversion`: glibc's), and every sort key is built from it, in
 * one JavaScript call a row (no real `strcoll` is reachable: not the source's per row, and this machine's glibc, if it
 * has one, is another version of another table).
 *
 * What glibc's strcoll compares (read from its `iso14651_t1_common` and held to Postgres 18 / glibc 2.41 en_US.utf8 over
 * random strings of 15 scripts): each ELEMENT of the string, a character or a contraction (Thai's vowel written before
 * its consonant, `เก`; an NFD spelling of a letter of its own, `И` + U+0306), has weights at four levels, each a
 * sequence, any of them empty, and the levels are compared in turn, each over the whole string:
 *  1. letters, digits, `$`, U+FFFD; not punctuation, spaces, emoji or marks; a ligature is several (`ß` = ss);
 *  2. accents: a letter's BASE, a combining mark's own, `é` = BASE AIGUT, and `e` + U+0301 is the same sequence.
 *     AN ELEMENT OF glibc's <SPECIAL> SECTION (digits, symbols, punctuation, marks) IS `backward` HERE: a run of them is
 *     read in reverse, and a run closed by a forward element SKIPS the element before the run's last (get_next_seq's
 *     `backw` is decremented twice; that is what `1-X < 1x` is: the `1` is not read, so that side is shorter);
 *  3. case and form (MIN, CAP, COMPAT, FONT …);
 *  4. the last: the pairs (its position, its weight) of each element with a weight there, position first — `三 < :三`
 *     (`三` has none) and `가三 < 三가` both follow. What the table does not list (Hangul, an unassigned or a private use
 *     code point) has no other level, and is ONE ELEMENT PER BYTE of its UTF-8, each of one shared weight (findidx
 *     takes its lead byte alone): U+0378 is two of them, U+E000 three, U+F0000 four.
 * A tie at every level is Postgres's byte order (`varstr_cmp`'s strcmp), which the caller adds.
 *
 * HOW IT IS READ, by comparisons alone (`readLibcOrder`), so any table answers, a tailored locale's or another glibc's:
 * the characters sorted once, each neighbour asked which level told it apart; a weight's place by binary search among
 * the marks or the punctuation; every spelling a character could stand for (its NFD, its NFKD, a Thai or Lao reordering)
 * proposed by Unicode's data and KEPT ONLY WHEN THE SOURCE SAYS THE TWO ARE EQUAL.
 *
 * WHAT IS READ IS HELD, AND THE VERDICT IS A BRANCH (`holdLibcOrder`): pairs of strings, ASCII first, compared by the source and
 * by the key, counted, every pair. A locale of the plain table (`isPlainTable`: en_*, glibc's iso14651_t1 as it comes)
 * IS NEVER REFUSED, of any character, on any C library: what differs stays as it was read, and is recorded
 * (`LibcOrder.held`: the log and mason status), and what no level could be read of is left to the bytes. A difference
 * there is a decided one (`libc-rare-letter`, `libc-mark-run-form`). Any other locale has what differs uncovered where it
 * is rare; a pair that differs in ASCII or Latin alone is a table this reading does not follow (tr_TR, sv_SE, cs_CZ;
 * another C library), and the whole order is `unread`.
 * REFUSED BY NAME under such a locale alone, never an exit at the start and never another order: an `unread` order refuses
 * every text it is asked to order (`libc-locale-unread`), a character not covered the values holding it
 * (`libc-uncovered`), and so does every code point not read where a sample of them does not share one weight. A strcoll
 * that is byte order (musl's, macOS's) reads as that (`bytes`), with nothing else to read.
 */
import { Buffer } from "node:buffer";
import { gapMark } from "./gaps.ts";
import { PgEvalError } from "./pg-eval.ts";

/** one element's weights where a level holds more than one (or a contraction's) */
export interface LibcElement {
  l1: number[];
  l2: number[];
  l3: number[];
  l4: number[];
  back: boolean;
}

export interface LibcOrder {
  /** pg_database's datcollate and datcollversion: what the order was read under */
  collate: string;
  version: string | null;
  /** the source's strcoll is byte order (musl's, macOS's): the collation is `bytes`, the rest of this order is empty */
  bytes: boolean;
  /** the read does not follow this table (`holdLibcOrder`): every text ordered under it is refused, `libc-locale-unread` */
  unread: boolean;
  /** `holdLibcOrder`, both rounds: the pairs compared, those the key answers otherwise than the source, and of those the
   *  ones of ASCII or Latin alone */
  held: { pairs: number; differ: number; common: number };
  /** per code point, its weight at each level: 0 for none; 1 at levels 2 and 3 is the common one (BASE, MIN) */
  l1: Uint32Array;
  l2: Uint32Array;
  l3: Uint32Array;
  l4: Uint32Array;
  /** per code point: 1 when glibc reads it backward at the second level */
  back: Uint8Array;
  /** per code point: 1 when it is not covered (refused when ordered) */
  uncovered: Uint8Array;
  /** per code point: 1 when the table does not list it (the module's header): one element per byte of its UTF-8 */
  unlisted: Uint8Array;
  /** per code point: 1 when `sequences`, `contractions` or `unlisted` holds it (the key's fast path, `withLookups`) */
  special: Uint8Array;
  /** a character with more than one weight at a level */
  sequences: Map<number, LibcElement>;
  /** by its first code point: the code points after it, the longest first, and the element they are */
  contractions: Map<number, Array<{ rest: number[]; element: LibcElement }>>;
}

const MAX = 0x110000;
const BATCH = 20000;
/** what a code point not read is: the first of the private use area, which no collation table lists */
const UNLISTED = 0xe000;
/** one in this many of the code points not read is held to `UNLISTED` */
const UNREAD_SAMPLE = 211;
/** the pairs of random strings of each pool (all, ASCII, Latin) a read order is held to (`holdLibcOrder`) */
const HELD_PAIRS = 6000;
/** a ligature's units whose case is searched for: longer ones (Arabic's) are left to `hold` */
const MAX_UNITS = 4;

/** a mark class's place at the second level, and the place just below it of a weight no mark has (the `nth` of its letter) */
const markPlace = (k: number): number => (2 * k + 2) * 4096;
const gapPlace = (k: number, nth: number): number => (2 * k + 1) * 4096 + nth;
/** the third level's weight of a case's rank in its letter (rank 0 is 1, the common one), and of one between two ranks */
const caseOf = (rank: number): number => 2 * rank * 1024 + 1;
const caseBelow = (rank: number, nth: number): number => (2 * rank - 1) * 1024 + nth + 1;

/** The code points read from the source: assigned, not private use, not a surrogate (`UNREAD_SAMPLE` holds the rest). */
export function assignedCodePoints(): number[] {
  const out: number[] = [];
  for (let g = 1; g < MAX; g++) {
    if (g >= 0xd800 && g <= 0xdfff) continue;
    if (/[\p{Cn}\p{Co}]/u.test(String.fromCodePoint(g))) continue;
    out.push(g);
  }
  return out;
}

const ints = (xs: readonly number[]): string => `'{${xs.join(",")}}'::int[]`;
const texts = (xs: readonly string[]): string => `ARRAY[${xs.map((x) => `'${x.replaceAll("'", "''")}'`).join(",")}]::text[]`;
const cps = (s: string): number[] => [...s].map((c) => c.codePointAt(0)!);
const str = (xs: readonly number[]): string => String.fromCodePoint(...xs);

/** a read of the source: rows of text (or null) */
export type SourceQuery = (sql: string) => Promise<Array<Array<string | null>>>;

/** An empty order: nothing covered. */
export function emptyLibcOrder(collate: string, version: string | null): LibcOrder {
  return { collate, version, bytes: false, unread: false, held: { pairs: 0, differ: 0, common: 0 }, l1: new Uint32Array(MAX), l2: new Uint32Array(MAX), l3: new Uint32Array(MAX), l4: new Uint32Array(MAX), back: new Uint8Array(MAX),
    uncovered: new Uint8Array(MAX).fill(1), unlisted: new Uint8Array(MAX), special: new Uint8Array(MAX), sequences: new Map(), contractions: new Map() };
}

/** the order with `special` said from its sequences and contractions */
export function withLookups(o: LibcOrder): LibcOrder {
  o.special.set(o.unlisted);
  for (const g of o.sequences.keys()) o.special[g] = 1;
  for (const g of o.contractions.keys()) o.special[g] = 1;
  return o;
}

/** the element of one character, its sequence or its one weight at each level */
function elementOf(o: LibcOrder, g: number): LibcElement {
  const s = o.sequences.get(g);
  if (s !== undefined) return s;
  const one = (x: number): number[] => x > 0 ? [x] : [];
  return { l1: one(o.l1[g]!), l2: one(o.l2[g]!), l3: one(o.l3[g]!), l4: one(o.l4[g]!), back: o.back[g] === 1 };
}

const joined = (es: readonly LibcElement[]): LibcElement =>
  ({ l1: es.flatMap((e) => e.l1), l2: es.flatMap((e) => e.l2), l3: es.flatMap((e) => e.l3), l4: es.flatMap((e) => e.l4), back: es[0]!.back });

/** Asks the source about pairs of code points (`a`, `b` in `expr`), in batches: its answer to each. */
async function asked(query: SourceQuery, pairs: ReadonlyArray<readonly [number, number]>, expr: string): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let at = 0; at < pairs.length; at += BATCH) {
    const part = pairs.slice(at, at + BATCH);
    const rows = await query(`SELECT (${expr})::text FROM unnest(${ints(part.map((p) => p[0]))}, ${ints(part.map((p) => p[1]))}) WITH ORDINALITY AS u(a, b, n) ORDER BY n`);
    if (rows.length !== part.length) throw new Error(`reading how the database orders text: ${part.length} comparisons asked, ${rows.length} answered`);
    for (const [v] of rows) out.push(v === "true");
  }
  return out;
}

/** Asks the source about pairs of strings (`s`, `t` in `expr`), in batches: its answer to each. */
async function askedText(query: SourceQuery, pairs: ReadonlyArray<readonly [string, string]>, expr: string): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let at = 0; at < pairs.length; at += BATCH / 4) {
    const part = pairs.slice(at, at + BATCH / 4);
    const rows = await query(`SELECT (${expr})::text FROM unnest(${texts(part.map((p) => p[0]))}, ${texts(part.map((p) => p[1]))}) WITH ORDINALITY AS u(s, t, n) ORDER BY n`);
    if (rows.length !== part.length) throw new Error(`reading how the database orders text: ${part.length} comparisons asked, ${rows.length} answered`);
    for (const [v] of rows) out.push(v === "true");
  }
  return out;
}

/** a binary search of many at once: `below(i, mid)` asked of each still open, until each has its lowest mid answering yes */
async function searched(n: number, top: (i: number) => number, ask: (open: ReadonlyArray<{ i: number; mid: number }>) => Promise<boolean[]>): Promise<Int32Array> {
  const lo = new Int32Array(n), hi = new Int32Array(n);
  for (let i = 0; i < n; i++) hi[i] = top(i);
  for (;;) {
    const open: Array<{ i: number; mid: number }> = [];
    for (let i = 0; i < n; i++) if (lo[i]! < hi[i]!) open.push({ i, mid: (lo[i]! + hi[i]!) >> 1 });
    if (open.length === 0) return lo;
    const yes = await ask(open);
    yes.forEach((y, j) => { const { i, mid } = open[j]!; if (y) hi[i] = mid; else lo[i] = mid + 1; });
  }
}

/**
 * A locale that is glibc's table as it comes, so one this reading is held to by design and never refuses: English's,
 * each `en_XX` being `copy "iso14651_t1"` (en_CA moves capitals before small letters, which the read asks of the source;
 * en_AG, en_BW, en_IL and en_ZW copy another of these). Nothing else is, de_DE and fr_FR included, though most hold: a
 * tailoring is not told from a name, so those are held to the measurement alone.
 */
export const isPlainTable = (collate: string): boolean => /^en_[A-Za-z]{2}([.@]|$)/.test(collate);

/** code points in byte order, of each kind a collation moves: what a byte-ordering strcoll keeps in this order */
const BYTE_ORDER_SAMPLE = [0x20, 0x21, 0x2d, 0x30, 0x41, 0x5a, 0x5f, 0x61, 0x7a, 0xc0, 0xe9, 0x100, 0x300, 0x4e00, 0xac00, 0xe000, 0xfffd, 0x1f600];

/** The source's order of text (its default collation), as the module's header says. */
export async function readLibcOrder(query: SourceQuery, collate: string, version: string | null): Promise<LibcOrder> {
  const o = emptyLibcOrder(collate, version);
  const held = (): Promise<void> => holdLibcOrder(o, async (pairs) => {
    const less = await askedText(query, pairs, "s < t");
    const more = await askedText(query, pairs, "s > t");
    return pairs.map((_, i) => less[i] ? -1 : more[i] ? 1 : 0);
  });
  // a strcoll with no level glibc's has, another C library's: not followed, but for the plain table's name, which is
  // never refused: the first level where that is all there is, the bytes for the rest, and what that differs on recorded
  const noLevels = async (): Promise<LibcOrder> => {
    if (!isPlainTable(collate)) { o.unread = true; return o; }
    o.uncovered.fill(0);
    await held();
    return o;
  };
  const inOrder = await asked(query, BYTE_ORDER_SAMPLE.slice(1).map((g, i) => [BYTE_ORDER_SAMPLE[i]!, g]), "chr(a) < chr(b)");
  if (inOrder.every(Boolean)) return { ...o, bytes: true };
  const points = assignedCodePoints();
  points.push(UNLISTED);
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
  const classes: number[][] = [];        // the characters of each first-level class, in the database's order
  const noFirst: Array<{ g: number; same: boolean }> = [];
  for (const [kind, g0, same] of rows) {
    const g = Number(g0);
    if (kind === "n") {
      if (same !== "true" || classes.length === 0) classes.push([]);
      classes.at(-1)!.push(g);
      weighted.push(g);
      o.l1[g] = classes.length;
    } else noFirst.push({ g, same: same === "true" });
  }
  if (weighted.length === 0 || noFirst.length === 0) return noLevels();
  for (const g of points) o.uncovered[g] = 0;
  /** a character's place among those the last level compares it with: its first-level class's, or all the marks */
  const ties = new Map<number, number>();
  const nfd = (g: number): number[] => cps(String.fromCodePoint(g).normalize("NFD"));

  // of the characters with no first-level weight, those with a second-level one: a mark's, above BASE, outranks the case
  // of a later letter. The others sort below them: each last-level class one character, in order
  const isMark = await asked(query, noFirst.map((c) => [c.g, c.g]), "'x' || chr(a) || 'x' > 'xX'");
  const ignoredClasses: number[] = [];
  const marksRead: number[] = [];
  noFirst.forEach(({ g, same }, i) => {
    if (isMark[i]) { marksRead.push(g); return; }
    if (!same || ignoredClasses.length === 0) ignoredClasses.push(g);
    o.l4[g] = 2 * ignoredClasses.length;
  });
  if (ignoredClasses.length === 0) return noLevels();

  // the marks at the second level: in order behind a letter, each class of equal ones, and their case within
  const marks = marksRead.length === 0 ? [] : (await query(`SELECT g::text FROM unnest(${ints(marksRead)}) AS u(g) ORDER BY 'x' || chr(g)`)).map(([g]) => Number(g));
  const pairsOf = (xs: readonly number[]): Array<[number, number]> => xs.slice(1).map((x, i) => [xs[i]!, x]);
  const mark = marks[0];
  /** the two are equal at the first level: and at the second? (only a later mark told them apart) */
  const sameSecond = (x: string, y: string): string => `${x} || 'x' || chr(${mark}) > ${y} || 'x'`;
  const sameCase = (x: string, y: string): string => `${x} || 'X' > ${y} || 'x'`;
  const markClasses: number[][] = [];    // the marks of each second-level class, in order
  if (mark !== undefined) {
    const adjacent = pairsOf(marks);
    const [second, third] = [await asked(query, adjacent, sameSecond("'x' || chr(a)", "'x' || chr(b)")), await asked(query, adjacent, sameCase("'x' || chr(a)", "'x' || chr(b)"))];
    let rank = 0;
    marks.forEach((g, i) => {
      if (i === 0 || !second[i - 1]) { markClasses.push([]); rank = 0; }
      else if (!third[i - 1]) rank++;
      markClasses.at(-1)!.push(g);
      o.l2[g] = markPlace(markClasses.length - 1);
      o.l3[g] = caseOf(rank);
      // (a skipped mark, the module's header, is compared at the last level with a mark of another class: all in one order)
      ties.set(g, i);
    });
  }

  // each class of the first level: which level tells its neighbours apart
  const groupOf = new Map<number, { second: number; third: number }>();
  {
    const adjacent = classes.flatMap(pairsOf);
    const sameSeconds = mark === undefined ? adjacent.map(() => true) : await asked(query, adjacent, sameSecond("chr(a)", "chr(b)"));
    const sameThirds = await asked(query, adjacent, sameCase("chr(a)", "chr(b)"));
    let at = 0;
    for (const cls of classes) {
      let second = 0, third = 0;
      cls.forEach((g, i) => {
        if (i > 0) {
          if (!sameSeconds[at]) { second++; third = 0; }
          else if (!sameThirds[at]) third++;
          at++;
        }
        groupOf.set(g, { second, third });
        // (`é` and `e` + U+0301 are equal down to here: the last level compares a letter with its class's others)
        ties.set(g, i);
      });
    }
  }

  // which elements are read backward at the second level, and which have no second level at all (CJK's, here): a
  // character x then a mark m is [BASE, m], m then x [m, BASE], and they turn round when x is backward; closed by a letter
  // the run of the backward one skips the element before its last (the module's header), which tells it from one with none
  const noSecond = new Set<number>();
  if (mark !== undefined) {
    const each = weighted.map((g): [number, number] => [g, mark]);
    const forward = await asked(query, each, "chr(a) || chr(b) < chr(b) || chr(a)");
    const backward = await asked(query, each, "chr(b) || chr(a) || 'X' < chr(a) || chr(b) || 'x'");
    weighted.forEach((g, i) => { if (!forward[i]) { if (backward[i]) o.back[g] = 1; else noSecond.add(g); } });
    const [low, high] = [markClasses[0]?.[0], markClasses[1]?.[0]];
    if (low !== undefined && high !== undefined) {
      const rest = noFirst.map((c) => c.g);
      const turned = await asked(query, rest.map((g) => [g, g]), `'x' || chr(${low}) || chr(a) || chr(${high}) || 'x' > 'x' || chr(${high}) || chr(a) || chr(${low}) || 'x'`);
      rest.forEach((g, i) => { if (turned[i]) o.back[g] = 1; });
    }
  }

  // a mark of two (U+0344): those two
  for (const g of marks) {
    const parts = nfd(g);
    if (parts.length > 1 && parts.every((p) => o.l2[p]! > 0)) o.sequences.set(g, { ...joined(parts.map((p) => elementOf(o, p))), back: o.back[g] === 1 });
  }

  // the plain ones' second and third levels: the first of a class's accents is BASE, each case its rank
  for (const g of weighted) {
    if (noSecond.has(g)) continue;
    const { second, third } = groupOf.get(g)!;
    o.l2[g] = 1;
    o.l3[g] = second === 0 ? caseOf(third) : 1;
  }

  /** whether each pair of strings is equal at the second level, and at the first three */
  const equalSecond = (ps: ReadonlyArray<readonly [string, string]>): Promise<boolean[]> =>
    mark === undefined ? Promise.resolve(ps.map(() => true)) : askedText(query, ps, `(${sameSecond("s", "t")}) AND (${sameSecond("t", "s")})`);
  const equalAt = (ps: ReadonlyArray<readonly [string, string]>): Promise<boolean[]> =>
    askedText(query, ps, `(s || 'y' > t || 'x') AND (t || 'y' > s || 'x') ${mark === undefined ? "" : `AND (${sameSecond("s", "t")}) AND (${sameSecond("t", "s")})`} AND (${sameCase("s", "t")}) AND (${sameCase("t", "s")})`);

  // a ligature's first level: proposed by its compatibility decomposition (its marks dropped) and the letters NFKD keeps
  // whole, kept where the source says the two are equal at the first level
  const proposed: Array<[number, string]> = [];
  for (const g of weighted) {
    const d = String.fromCodePoint(g).normalize("NFKD").replace(/\p{M}/gu, "");
    if ([...d].length > 1 && !d.includes("\0")) proposed.push([g, d]);
  }
  for (const [ch, e] of [["ß", "ss"], ["ẞ", "SS"], ["æ", "ae"], ["Æ", "AE"], ["œ", "oe"], ["Œ", "OE"], ["þ", "th"], ["Þ", "TH"]] as const) proposed.push([ch.codePointAt(0)!, e]);
  const expansions = new Map<number, number[]>();
  {
    const eq = await askedText(query, proposed.map(([g, e]) => [String.fromCodePoint(g), e]), "(s || 'b' > t || 'a') AND (t || 'b' > s || 'a')");
    // (of the units with a first-level weight: `⅖` is 2, 5, the slash between them weighs nothing there)
    proposed.forEach(([g, e], i) => { const units = cps(e).filter((u) => o.l1[u]! > 0); if (eq[i] && units.length > 1) expansions.set(g, units); });
  }
  // a ligature Unicode does not decompose (ȸ, Ꜷ): sorted among its first letter's words, so below that letter and the
  // highest character; each unit found by binary search among the single letters, kept when the source says equal
  {
    const whole = classes.map((c) => c[0]!);
    const highest = whole.at(-1)!;
    const single = new Set(whole.filter((g) => !expansions.has(g)));
    for (let round = 0; round < 4; round++) {
      const asking: Array<[number, number]> = [];
      let below = whole[0]!;
      for (const g of whole) { if (single.has(g) && g !== below) asking.push([g, below]); if (single.has(g)) below = g; }
      const yes = await asked(query, asking, `chr(a) || 'x' < chr(b) || chr(${highest})`);
      const found = asking.filter((_, i) => yes[i]);
      if (found.length === 0) break;
      for (const [g] of found) single.delete(g);
      const letters = whole.filter((g) => single.has(g));
      const lo = await searched(found.length, () => letters.length - 1, (open) =>
        askedText(query, open.map(({ i, mid }): [string, string] => [String.fromCodePoint(found[i]![0]), str([found[i]![1], letters[mid]!, highest])]), "s < t"));
      const spelled = found.map(([g, first], i): [number, string] => [g, str([first, letters[lo[i]!]!])]);
      const eq = await askedText(query, spelled.map(([g, e]) => [String.fromCodePoint(g), e]), "(s || 'b' > t || 'a') AND (t || 'b' > s || 'a')");
      // (every character of its class is that spelling)
      spelled.forEach(([g, e], i) => { if (eq[i]) for (const c of classes[o.l1[g]! - 1]!) if (!expansions.has(c)) expansions.set(c, cps(e)); });
    }
  }

  // a ligature of several letters whose spelling the source did not confirm has first-level weights no letter has
  // (`㏩`: 10 and a CJK weight of its own): nothing here can say them. Under the plain table it stays, at the one weight
  // it sorted by, a decided difference (`libc-rare-letter`)
  for (const [g, e] of proposed) if (!expansions.has(g) && e === String.fromCodePoint(g).normalize("NFKD").replace(/\p{M}/gu, "") && cps(e).filter((u) => o.l1[u]! > 0).length > 1 && !isPlainTable(collate)) o.uncovered[g] = 1;

  // an accented letter: its NFD's parts, once they are read
  const decomposed = new Set(weighted.filter((g) => !expansions.has(g) && nfd(g).length > 1));

  /** a weight of its own, its place among the marks': after `before`, before `after` (`nth` its letter's accent) */
  const place = async (items: ReadonlyArray<{ g: number; before: string; after: string; nth: number }>): Promise<number[]> => {
    const lo = await searched(items.length, () => markClasses.length, (open) => askedText(query, open.map(({ i, mid }): [string, string] =>
      [String.fromCodePoint(items[i]!.g), `${items[i]!.before}${String.fromCodePoint(markClasses[mid]![0]!)}${items[i]!.after}`]), "s || 'x' < t || 'x'"));
    const same = await equalSecond(items.map((it, i) => [String.fromCodePoint(it.g), `${it.before}${String.fromCodePoint(markClasses[Math.max(lo[i]! - 1, 0)]![0]!)}${it.after}`]));
    return items.map((it, i) => lo[i]! > 0 && same[i] ? markPlace(lo[i]! - 1) : gapPlace(lo[i]!, it.nth));
  };

  // a letter of accents its NFD does not spell (ø: BASE and a weight of its own)
  if (markClasses.length > 0) {
    const variants = weighted.filter((g) => !expansions.has(g) && !decomposed.has(g) && !noSecond.has(g) && groupOf.get(g)!.second > 0);
    const placed = await place(variants.map((g) => ({ g, before: String.fromCodePoint(classes[o.l1[g]! - 1]![0]!), after: "", nth: groupOf.get(g)!.second })));
    variants.forEach((g, i) => o.sequences.set(g, { l1: [o.l1[g]!], l2: [1, placed[i]!], l3: [caseOf(groupOf.get(g)!.third), 1], l4: [], back: o.back[g] === 1 }));
  }

  // a ligature's second level, its letters', or with a weight of its own after the first (ß, æ); its case unit by unit,
  // each searched for among the cases of its letter, the units after it at the highest of theirs
  {
    const list = [...expansions.keys()];
    const units = (g: number): number[] => expansions.get(g)!;
    const plain = await equalSecond(list.map((g) => [String.fromCodePoint(g), str(units(g))]));
    const ladder = (u: number): number[] => {
      const out: number[] = [];
      for (const g of classes[o.l1[u]! - 1] ?? []) { const p = groupOf.get(g)!; if (p.second === 0 && p.third === out.length) out.push(g); }
      return out;
    };
    const flat = list.filter((g, i) => plain[i] && units(g).length <= MAX_UNITS);
    const chosen = new Map<number, number[]>(flat.map((g) => [g, []]));
    for (let unit = 0; unit < MAX_UNITS; unit++) {
      const here = flat.filter((g) => units(g).length > unit);
      const lo = await searched(here.length, (i) => ladder(units(here[i]!)[unit]!).length, (open) => askedText(query, open.map(({ i, mid }): [string, string] => {
        const g = here[i]!, us = units(g);
        const done = chosen.get(g)!.map((r, k) => ladder(us[k]!)[r] ?? ladder(us[k]!).at(-1) ?? us[k]!);
        const top = us.slice(unit + 1).map((u) => ladder(u).at(-1) ?? u);
        return [String.fromCodePoint(g), str([...done, ladder(us[unit]!)[mid] ?? us[unit]!, ...top])];
      }), "s || 'x' < t || 'X'"));
      here.forEach((g, i) => chosen.get(g)!.push(lo[i]!));
    }
    // a case no letter has (a fraction's, a circled digit's) lies between two ranks: those of one spelling in their own order
    const exact = await equalAt(flat.map((g) => [String.fromCodePoint(g), str(chosen.get(g)!.map((r, k) => ladder(units(g)[k]!)[r] ?? ladder(units(g)[k]!).at(-1) ?? units(g)[k]!))]));
    const between = flat.filter((_, i) => !exact[i]);
    const nthOf = new Map<number, number>();
    if (between.length > 0) {
      const spelledAs = (g: number): string => `${units(g).join(",")}/${chosen.get(g)!.join(",")}`;
      const sorted = (await query(`SELECT g::text FROM unnest(${ints(between)}) AS u(g) ORDER BY chr(g)`)).map(([g]) => Number(g));
      const same = await asked(query, pairsOf(sorted), sameCase("chr(a)", "chr(b)"));
      let nth = 0;
      sorted.forEach((g, i) => { if (i > 0 && spelledAs(sorted[i - 1]!) === spelledAs(g) && !same[i - 1]) nth++; else if (i > 0 && spelledAs(sorted[i - 1]!) !== spelledAs(g)) nth = 0; nthOf.set(g, nth); });
    }
    const own = list.filter((_, i) => !plain[i]);
    const placed = new Map(markClasses.length === 0 ? [] : (await place(own.map((g) => ({ g, before: String.fromCodePoint(units(g)[0]!), after: str(units(g).slice(1)), nth: groupOf.get(g)!.second + 1 })))).map((p, i) => [own[i]!, p]));
    list.forEach((g, i) => {
      const es = units(g).map((u) => elementOf(o, u));
      const whole = joined(es);
      if (plain[i]) {
        const cases = chosen.get(g), nth = nthOf.get(g);
        if (cases !== undefined) whole.l3 = es.flatMap((e, k) => e.l3.length === 0 ? [] : [nth === undefined || cases[k]! === 0 ? caseOf(cases[k]!) : caseBelow(cases[k]!, nth), ...e.l3.slice(1)]);
      } else {
        const at = es[0]!.l2.length;
        whole.l2 = [...whole.l2.slice(0, at), placed.get(g) ?? 1, ...whole.l2.slice(at)];
        whole.l3 = [caseOf(groupOf.get(g)!.third), ...whole.l3.map(() => 1)];
      }
      o.sequences.set(g, { ...whole, back: o.back[g] === 1 });
    });
  }

  // an accented letter equal to its spelling is that spelling: the letter of one mark fewer and its last mark, never
  // its NFD whole, whose run of marks is read backward and skipped (the module's header). So the fewest marks first
  {
    const spelling = (g: number): number[] => {
      const d = nfd(g), head = cps(str(d.slice(0, -1)).normalize("NFC"));
      return head.length === 1 ? [head[0]!, d.at(-1)!] : d;
    };
    const ordered = [...decomposed].sort((a, b) => nfd(a).length - nfd(b).length);
    for (let size = 2; ordered.some((g) => nfd(g).length === size); size++) {
      const list = ordered.filter((g) => nfd(g).length === size);
      const spelled = await equalAt(list.map((g) => [String.fromCodePoint(g), str(spelling(g))]));
      list.forEach((g, i) => {
        const parts = joined(spelling(g).map((p) => elementOf(o, p)));
        // (equal to a letter of its own, it is that letter: its spelling is a contraction, below)
        if (spelled[i] && (parts.l1.length > 1 || parts.l1[0] === o.l1[g])) o.sequences.set(g, { ...parts, back: o.back[g] === 1 });
        else if (groupOf.get(g)!.second > 0 && !noSecond.has(g)) o.sequences.set(g, { l1: [o.l1[g]!], l2: [1, gapPlace(markClasses.length, groupOf.get(g)!.second)], l3: [caseOf(groupOf.get(g)!.third), 1], l4: [], back: o.back[g] === 1 });
      });
    }
  }

  // a symbol the first spelling did not confirm, under the plain table, which refuses nothing: `㏩` is 1, 0 and a weight no
  // character has, so its letters and the class that weight lies above, found by binary search after them. Close: it
  // sorts in its place among what a column holds (`libc-rare-letter`, the rest)
  if (isPlainTable(collate)) {
    const whole = classes.map((c) => c[0]!);
    const stuck = proposed.flatMap(([g, e]) => {
      if (expansions.has(g) || o.sequences.has(g) || e !== String.fromCodePoint(g).normalize("NFKD").replace(/\p{M}/gu, "")) return [];
      const units = cps(e).filter((u) => o.l1[u]! > 0);
      const head = units.slice(0, units.findIndex((u) => /\p{Script=Han}|\p{Script=Katakana}|\p{Script=Hiragana}/u.test(String.fromCodePoint(u))));
      return head.length > 0 && head.length < units.length ? [{ g, head }] : [];
    });
    const lo = await searched(stuck.length, () => whole.length - 1, (open) =>
      askedText(query, open.map(({ i, mid }): [string, string] => [String.fromCodePoint(stuck[i]!.g), str([...stuck[i]!.head, whole[mid]!])]), "s < t"));
    stuck.forEach(({ g, head }, i) => {
      const l1 = [...head.map((u) => o.l1[u]!), o.l1[whole[Math.max(lo[i]! - 1, 0)]!]!];
      o.sequences.set(g, { l1, l2: l1.map(() => 1), l3: l1.map(() => 1), l4: [], back: o.back[g] === 1 });
    });
  }

  // the last level: the marks' and the letters' weights, each by binary search among the punctuation's (p||x < x exactly
  // when p's weight is below x's), two of one class and case told apart by their order; one placed below all of them has
  // none when x||chr(1) is not below chr(1)||x
  {
    const placing = [...marks, ...weighted];
    const lo = await searched(placing.length, () => ignoredClasses.length, (open) =>
      asked(query, open.map(({ i, mid }): [number, number] => [ignoredClasses[mid]!, placing[i]!]), "NOT (chr(a) || chr(b) < chr(b))"));
    const bottom = placing.filter((_, i) => lo[i] === 0);
    const yes = await asked(query, bottom.map((x) => [x, x]), "chr(a) || chr(1) < chr(1) || chr(a)");
    const has = new Set(bottom.filter((_, i) => yes[i]));
    // the weights in one order: the punctuation's even, a letter's the odd one above its place, then its tie
    const SCALE = 1 << 13;
    const keyed: Array<[number, number]> = [];
    for (const { g } of noFirst) if (o.l4[g]! > 0) keyed.push([g, o.l4[g]! * SCALE]);
    placing.forEach((g, i) => { if (lo[i]! > 0 || has.has(g)) keyed.push([g, (2 * lo[i]! + 1) * SCALE + Math.min(ties.get(g) ?? 0, SCALE - 1)]); });
    const dense = new Map([...new Set(keyed.map((k) => k[1]))].sort((a, b) => a - b).map((v, i) => [v, i + 1]));
    for (const g of placing) o.l4[g] = 0;
    for (const [g, v] of keyed) o.l4[g] = dense.get(v)!;
    for (const [g, e] of o.sequences) e.l4 = o.l4[g]! > 0 ? [o.l4[g]!] : [];
  }

  // the second level's places made its weights, BASE 1
  {
    const values = new Set<number>([1]);
    for (let g = 0; g < MAX; g++) if (o.l2[g]! > 0) values.add(o.l2[g]!);
    for (const e of o.sequences.values()) for (const v of e.l2) values.add(v);
    const dense = new Map([...values].sort((a, b) => a - b).map((v, i) => [v, i + 1]));
    for (let g = 0; g < MAX; g++) if (o.l2[g]! > 0) o.l2[g] = dense.get(o.l2[g]!)!;
    for (const e of o.sequences.values()) e.l2 = e.l2.map((v) => dense.get(v)!);
  }

  // contractions: a spelling the source says equals what it spells, where its characters read one by one do not
  {
    const proposals: Array<[number[], number[]]> = [];
    const reordered = (vowels: [number, number], consonants: [number, number]): void => {
      for (let v = vowels[0]; v <= vowels[1]; v++) for (let c = consonants[0]; c <= consonants[1]; c++) proposals.push([[v, c], [c, v]]);
    };
    reordered([0x0e40, 0x0e44], [0x0e01, 0x0e2e]);
    reordered([0x0ec0, 0x0ec4], [0x0e81, 0x0eae]);
    reordered([0x0ec0, 0x0ec4], [0x0edc, 0x0edf]);
    for (const g of points) {
      if (g === UNLISTED) continue;
      const ch = String.fromCodePoint(g);
      for (const form of ["NFD", "NFKD"] as const) {
        const d = cps(ch.normalize(form));
        if (d.length < 2 || d.length > 3 || d.includes(0)) continue;
        proposals.push([d, [g]]);
        if (d.length === 3) { const head = cps(str(d.slice(0, 2)).normalize("NFC")); if (head.length === 1) proposals.push([[head[0]!, d[2]!], [g]]); }
      }
    }
    const levels = (e: LibcElement): string => JSON.stringify([e.l1, e.l2, e.l3]);
    const known = (xs: readonly number[]): boolean => xs.every((x) => o.uncovered[x] === 0);
    const seen = new Set<string>();
    const differ = proposals.filter(([p, t]) => {
      const k = p.join(",");
      if (seen.has(k) || !known(p) || !known(t) || levels(joined(p.map((x) => elementOf(o, x)))) === levels(joined(t.map((x) => elementOf(o, x))))) return false;
      seen.add(k);
      return true;
    });
    const equal = await equalAt(differ.map(([p, t]) => [str(p), str(t)]));
    differ.forEach(([p, t], i) => {
      if (!equal[i]) return;
      const list = o.contractions.get(p[0]!) ?? [];
      list.push({ rest: p.slice(1), element: joined(t.map((x) => elementOf(o, x))) });
      list.sort((a, b) => b.rest.length - a.rest.length);
      o.contractions.set(p[0]!, list);
    });
  }

  // what was not read: what the table does not list, one weight at the last level, when a sample says so; else not
  // covered, but under the plain table, where it is that all the same and the sample's differences are recorded
  let unreadDiffer = 0, unreadPairs = 0;
  {
    const read = new Set(points);
    const unread: number[] = [];
    for (let g = 1; g < MAX; g++) if (!(g >= 0xd800 && g <= 0xdfff) && !read.has(g)) unread.push(g);
    // of one length of UTF-8, held to one of them: two lengths differ at the last level by design
    const firstOf = new Map<number, number>([[3, UNLISTED]]);
    for (const g of unread) if (!firstOf.has(utf8Length(g))) firstOf.set(utf8Length(g), g);
    const [p, q] = [ignoredClasses[0]!, ignoredClasses[1] ?? ignoredClasses[0]!];
    const sample = unread.filter((_, i) => i % UNREAD_SAMPLE === 0).map((g): [number, number] => [g, firstOf.get(utf8Length(g))!]);
    const alike = await asked(query, sample, `(chr(a) || 'y' > chr(b) || 'x') AND (chr(b) || 'y' > chr(a) || 'x') AND (chr(a) || 'X' > chr(b) || 'x') AND (chr(b) || 'X' > chr(a) || 'x')
      AND (chr(a) || chr(${q}) > chr(b) || chr(${p})) AND (chr(b) || chr(${q}) > chr(a) || chr(${p}))`);
    const plain = isPlainTable(collate);
    if (plain) { unreadPairs = alike.length; unreadDiffer = alike.filter((x) => !x).length; }
    if (plain || (alike.every(Boolean) && o.l1[UNLISTED] === 0)) {
      const weight = o.l4[UNLISTED]!;
      if (weight > 0) for (const { g } of noFirst) if (o.l4[g] === weight) o.unlisted[g] = 1;
      for (const g of unread) { o.l4[g] = weight; o.back[g] = o.back[UNLISTED]!; o.unlisted[g] = 1; o.uncovered[g] = 0; }
    } else o.uncovered[UNLISTED] = 1;
  }

  withLookups(o);
  await held();
  o.held = { ...o.held, pairs: o.held.pairs + unreadPairs, differ: o.held.differ + unreadDiffer };
  return o;
}

/** Pairs of strings of the covered characters, near each other as a column's values are, by `seed`. */
function heldPairs(o: LibcOrder, seed: number): Array<[string, string]> {
  // a generator of its own, never Math.random: one source's order reads to one result
  const next = (n: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const pool: number[] = [];
  for (let g = 0x21; g < MAX; g++) if (o.uncovered[g] === 0 && (o.unlisted[g] === 0 || g % 4099 === 0)) pool.push(g);
  // (ASCII's own pool: a tailoring of punctuation or of `i` shows there first, in the values every column holds)
  const ascii: number[] = [];
  for (let g = 0x20; g < 0x7f; g++) if (o.uncovered[g] === 0) ascii.push(g);
  const latin = pool.filter((g) => g < 0x250 && /\p{L}/u.test(String.fromCodePoint(g)));
  const pairs: Array<[string, string]> = [];
  const some = (pick: () => number): void => {
    for (let i = 0; i < HELD_PAIRS; i++) {
      const a = Array.from({ length: 1 + next(4) }, pick);
      const b = [...a];
      b[next(b.length)] = pick();
      if (next(2) === 0) b.splice(next(b.length + 1), 0, pick());
      pairs.push([str(a), str(b)]);
    }
  };
  const of = (xs: readonly number[]) => (): number => xs[next(xs.length)]!;
  const asciiOf = of(ascii), poolOf = of(pool);
  some(() => next(3) === 0 ? asciiOf() : poolOf());
  some(asciiOf);
  some(of(latin));
  // every two neighbours of the Latin letters alone, and of one first-level class, alone and between letters: what no
  // random pair is likely to meet
  const sortedLatin = latin.map((g) => String.fromCodePoint(g)).sort(keyOrder(o));
  for (let i = 1; i < sortedLatin.length; i++) pairs.push([sortedLatin[i - 1]!, sortedLatin[i]!]);
  const byFirst = new Map<string, number[]>();
  for (let g = 0x21; g < MAX; g++) {
    if (o.uncovered[g] === 1 || o.unlisted[g] === 1) continue;
    const first = libcKey(o, String.fromCodePoint(g)).split(" ")[0]!;
    if (first === "") continue;
    const list = byFirst.get(first);
    if (list === undefined) byFirst.set(first, [g]); else list.push(g);
  }
  for (const list of byFirst.values()) {
    const sorted = list.map((g) => String.fromCodePoint(g)).sort(keyOrder(o));
    for (let i = 1; i < sorted.length; i++) for (const [before, after] of [["", ""], ["", "x"], ["x", ""]] as const) pairs.push([`${before}${sorted[i - 1]!}${after}`, `${before}${sorted[i]!}${after}`]);
  }
  return pairs;
}

/** below it, the characters most columns hold: ASCII and Latin. A tailoring that moves one is a table not followed */
const COMMON = 0x250;

/**
 * WHAT WAS READ IS HELD, the verdict a branch (the module's header), in two rounds on two sets of pairs, every pair
 * counted. The plain table only records. Under any other locale a pair that differs has its rarest character uncovered
 * when one is not common (with it not covered, the other still is and the pair is gone), and a pair of common characters
 * alone leaves nothing to uncover, so the table is not followed: a difference in ASCII or Latin is in every column.
 */
export async function holdLibcOrder(o: LibcOrder, compare: (pairs: ReadonlyArray<[string, string]>) => Promise<number[]>): Promise<void> {
  const plain = isPlainTable(o.collate);
  const held = { pairs: 0, differ: 0, common: 0 };
  for (const seed of [0x9e3779b9, 0x51ed270b]) {
    const pairs = heldPairs(o, seed);
    const said = await compare(pairs);
    const differ = pairs.filter(([s, t], i) => keyOrder(o)(s, t) !== said[i]);
    held.pairs += pairs.length;
    held.differ += differ.length;
    for (const [s, t] of differ) {
      const told = [...cps(s).filter((x) => !cps(t).includes(x)), ...cps(t).filter((x) => !cps(s).includes(x))];
      const rare = told.filter((x) => x >= COMMON);
      if (rare.length === 0) held.common++;
      if (plain) continue;
      if (rare.length > 0) o.uncovered[Math.max(...rare)] = 1;
      else o.unread = true;
    }
    o.held = held;
    if (o.unread) return;
  }
}

/** how two texts compare by their keys, a tie by their bytes (as Postgres breaks one) */
const keyOrder = (o: LibcOrder) => (s: string, t: string): number => {
  const [x, y] = [libcKey(o, s), libcKey(o, t)];
  return x < y ? -1 : x > y ? 1 : Math.sign(Buffer.compare(Buffer.from(s), Buffer.from(t)));
};

/**
 * What an order's read leaves to say, for mason status and the log: an order not followed, or the pairs that differ,
 * told into rare characters and common ones (the detector of a glibc that moved them). Null: nothing.
 */
export function libcOrderNote(o: LibcOrder): string | null {
  if (o.bytes) return null;
  if (o.unread) return `${o.collate} orders text in a way Mason could not read, so ORDER BY, <, min and max of text are refused (Mason gap libc-locale-unread); add COLLATE "C" or an ICU collation to them`;
  if (o.held.differ === 0) return null;
  const rare = o.held.differ - o.held.common;
  return `${o.collate} read from the database; ${o.held.differ.toLocaleString("en-US")} of ${o.held.pairs.toLocaleString("en-US")} pairs of strings held to it order otherwise: ` +
    `${rare.toLocaleString("en-US")} of rare characters, ${o.held.common.toLocaleString("en-US")} of ASCII or Latin alone (Mason gaps libc-rare-letter, libc-mark-run-form)`;
}

/** The refusal of every text under an order `holdLibcOrder` did not follow: by the gap and the collation, as `libc-uncovered`'s. */
const unreadRefusal = (o: LibcOrder): PgEvalError => new PgEvalError("0A000", `the database's collation ${o.collate} orders text in a way Mason could not read, so text under it is not ordered (${gapMark("libc-locale-unread")})`);

const utf8Length = (g: number): number => g < 0x80 ? 1 : g < 0x800 ? 2 : g < 0x10000 ? 3 : 4;
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
const hex6 = (n: number): string => HEX[(n >>> 16) & 0xff]! + HEX[(n >>> 8) & 0xff]! + HEX[n & 0xff]!;

/**
 * A level of weights as text that orders as the level does, its common weight (1, the lowest) counted, so a value of
 * plain letters costs one token: a run of n of it before another weight w is `1`, the complement of n (a longer run has
 * the lower weight where a shorter one ended) and w; the run the level ends with is `0` and n (below any `1`, the shorter
 * first).
 */
function level(xs: readonly number[]): string {
  let out = "", run = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    if (x === 1) { run++; continue; }
    out += `1${hex6(0xffffff - run)}${hex6(x)}`;
    run = 0;
  }
  return `${out}0${hex6(run)}`;
}

/**
 * The sort key of `s` as one text that orders as glibc orders (bytewise; a space parts the levels, below every hex digit,
 * so a shorter level sorts first): the module's header's four levels. A value holding a character not covered is
 * refused, and every value of an order not followed, by the gap alone.
 */
export function libcKey(o: LibcOrder, s: string): string {
  if (o.unread) throw unreadRefusal(o);
  let first = "", last = "", at = 0;
  const second: number[] = [], third: number[] = [];
  const run: Array<number | LibcElement> = [];
  const push = (e: number | LibcElement): void => {
    if (typeof e !== "number") { for (const x of e.l2) second.push(x); return; }
    const x = o.l2[e]!;
    if (x > 0) second.push(x);
  };
  // glibc's run read in reverse; closed by a forward element, it skips the element before its last
  const flush = (closed: boolean): void => {
    const n = run.length;
    for (let k = n - 1; k >= 0; k--) if (!(closed && n >= 2 && k === n - 2)) push(run[k]!);
    run.length = 0;
  };
  for (let i = 0; i < s.length;) {
    const g = s.codePointAt(i)!;
    i += g > 0xffff ? 2 : 1;
    at++;
    if (o.uncovered[g] === 1) {
      // never the value, nor the character: a refusal reaches any user, of a row a role may hide (issue 128)
      throw new PgEvalError("0A000", `a text being ordered holds a character Mason cannot order as the database's collation ${o.collate} does (${gapMark("libc-uncovered")})`);
    }
    if (o.special[g] === 0) {
      const w = o.l1[g]!;
      if (w > 0) first += hex6(w);
      const c = o.l3[g]!;
      if (c > 0) third.push(c);
      const p = o.l4[g]!;
      if (p > 0) last += hex6(at) + hex6(p);
      if (o.back[g] === 1) run.push(g);
      else { if (run.length > 0) flush(true); push(g); }
      continue;
    }
    if (o.unlisted[g] === 1) {
      if (run.length > 0 && o.back[g] === 0) flush(true);
      for (let n = utf8Length(g); n > 0; n--) {
        last += hex6(at) + hex6(o.l4[g]!);
        if (n > 1) at++;
        if (o.back[g] === 1) run.push(g);
      }
      continue;
    }
    let e = o.sequences.get(g);
    for (const c of o.contractions.get(g) ?? []) {
      let j = i, whole = true;
      for (const r of c.rest) {
        if (s.codePointAt(j) !== r) { whole = false; break; }
        j += r > 0xffff ? 2 : 1;
      }
      if (whole) { e = c.element; i = j; break; }
    }
    if (e === undefined) e = elementOf(o, g);
    for (const w of e.l1) first += hex6(w);
    for (const c of e.l3) third.push(c);
    for (let k = 0; k < e.l4.length; k++) { if (k > 0) at++; last += hex6(at) + hex6(e.l4[k]!); }
    if (e.back) run.push(e);
    else { if (run.length > 0) flush(true); push(e); }
  }
  if (run.length > 0) flush(false);
  return `${first} ${level(second)} ${level(third)} ${last}`;
}

/** an array as its runs of one value, 0 left out: the order is mostly empty, and one value past the assigned code points */
function runsOf(a: Uint32Array | Uint8Array): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let g = 0; g < MAX;) {
    const v = a[g]!;
    let end = g + 1;
    while (end < MAX && a[end] === v) end++;
    if (v !== 0) out.push([g, end - g, v]);
    g = end;
  }
  return out;
}

const fromRuns = (a: Uint32Array | Uint8Array, runs: ReadonlyArray<[number, number, number]>): void => { for (const [g, n, v] of runs) a.fill(v, g, g + n); };

/** what `encodeLibcOrder` says first: an order kept by a release that read less is read again (`isCurrentLibcOrder`) */
const FORM = '{"form":3,';
export const isCurrentLibcOrder = (text: string): boolean => text.startsWith(FORM);

/** The order as bytes, to keep in the copy. */
export function encodeLibcOrder(o: LibcOrder): string {
  return FORM + JSON.stringify({ collate: o.collate, version: o.version, bytes: o.bytes, unread: o.unread, held: o.held, l1: runsOf(o.l1), l2: runsOf(o.l2), l3: runsOf(o.l3), l4: runsOf(o.l4), back: runsOf(o.back), uncovered: runsOf(o.uncovered), unlisted: runsOf(o.unlisted),
    sequences: [...o.sequences], contractions: [...o.contractions] }).slice(1);
}

export function decodeLibcOrder(text: string): LibcOrder {
  type Runs = Array<[number, number, number]>;
  const v = JSON.parse(text) as { collate: string; version: string | null; bytes: boolean; unread: boolean; held: { pairs: number; differ: number; common: number }; l1: Runs; l2: Runs; l3: Runs; l4: Runs; back: Runs; uncovered: Runs; unlisted: Runs;
    sequences: Array<[number, LibcElement]>; contractions: Array<[number, Array<{ rest: number[]; element: LibcElement }>]> };
  const o = { ...emptyLibcOrder(v.collate, v.version), bytes: v.bytes, unread: v.unread, held: v.held };
  o.uncovered.fill(0);
  fromRuns(o.l1, v.l1); fromRuns(o.l2, v.l2); fromRuns(o.l3, v.l3); fromRuns(o.l4, v.l4); fromRuns(o.back, v.back); fromRuns(o.uncovered, v.uncovered); fromRuns(o.unlisted, v.unlisted);
  o.sequences = new Map(v.sequences);
  o.contractions = new Map(v.contractions);
  return withLookups(o);
}
