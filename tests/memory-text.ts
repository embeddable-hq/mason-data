/**
 * DuckDB's `memory_limit` as it prints it ("7.8 GiB", "64.0 MiB"), held to the bytes it was set to
 * (tests/duck-wire.test.ts, "DuckDB's memory is bounded"). DuckDB TRUNCATES the amount to one decimal of its unit:
 * 7.99 GiB prints "7.9 GiB", and 1023.9 MiB "1023.8 MiB" (measured, DuckDB 1.4). So the text is exact only to a tenth
 * of the unit it names — 102.4 MiB in GiB — and a fixed tolerance in MiB passes only where the limit happens to fall
 * on a tenth (half of a 32 GiB Mac's RAM, "16.0 GiB") and fails where it does not (CI's runner: "7.8 GiB" for about
 * 7990 MiB, main's run 40590378916).
 */
const UNIT = { KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40 } as const;

/** `text` is DuckDB's `memory_limit` for a limit of `bytes`: the printed amount at most `bytes`, and `bytes` short of the
 *  next tenth of the unit */
export function withinDuckDBRounding(text: string, bytes: number): boolean {
  const m = /^(\d+)\.(\d) (KiB|MiB|GiB|TiB)$/.exec(text);
  if (m === null) throw new Error(`${JSON.stringify(text)} is not DuckDB's memory_limit (an amount with one decimal and KiB, MiB, GiB or TiB)`);
  const tenth = UNIT[m[3] as keyof typeof UNIT] / 10, tenths = Number(m[1]) * 10 + Number(m[2]);
  return tenths * tenth <= bytes && bytes < (tenths + 1) * tenth;
}
