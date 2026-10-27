/**
 * DuckDB's `memory_limit` as it prints it ("7.8 GiB", "64.0 MiB"), held to the bytes it was set to
 * (tests/duck-wire.test.ts, "DuckDB's memory is bounded").
 */
const UNIT = { KiB: 2 ** 10, MiB: 2 ** 20, GiB: 2 ** 30, TiB: 2 ** 40 } as const;

/** `text` is DuckDB's `memory_limit` for a limit of `bytes` */
export function withinDuckDBRounding(text: string, bytes: number): boolean {
  const m = /^([\d.]+) (KiB|MiB|GiB|TiB)$/.exec(text);
  if (m === null) throw new Error(`${JSON.stringify(text)} is not DuckDB's memory_limit`);
  return Math.abs(Number(m[1]) * UNIT[m[2] as keyof typeof UNIT] - bytes) < 2 * 2 ** 20;
}
