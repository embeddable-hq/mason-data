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
