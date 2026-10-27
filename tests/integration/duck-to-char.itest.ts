/**
 * MASON'S to_char IS POSTGRES'S (src/duck/to-char.ts): the same values formatted by Postgres itself and by the
 * JavaScript the DuckDB endpoint calls, compared character by character — every time pattern (each case variant, FM,
 * TH, quoted text) over times chosen for their edges (an ISO year that is not the calendar's, a leap day, midnight and
 * noon, a fraction), and the number templates (9 and 0 places, a point, separators, every sign form, fill mode, a value
 * too wide) over values chosen for theirs (zero, a fraction alone, a carry, a negative that rounds to zero).
 * Needs IT_POSTGRES_URL (it only SELECTs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { toCharNumber, toCharTime } from "../../src/duck/to-char.ts";

const url = process.env.IT_POSTGRES_URL;

const TIMES = [
  "2026-09-15 10:04:05", "2026-01-01 00:00:00", "2027-01-01 12:00:00", "2020-12-31 23:59:59.999999", "2021-01-03 08:30:00.5",
  "2024-02-29 13:07:09.012345", "2026-12-28 00:00:01", "2025-12-29 18:45:00", "2000-03-05 07:00:00", "1999-12-31 11:59:59",
];
const TIME_FORMATS = [
  "YYYY-MM-DD HH24:MI:SS", "FMMonth YYYY", "Month", "MONTH", "month", "Mon", "MON", "mon", "Day", "DAY", "day", "Dy", "DY", "dy",
  "FMDay, FMDD FMMonth", "Dy DD Mon", "IYYY-IW", "IYYY", "IYY", "IY", "I", "IW", "IDDD", "ID", "YYYY-\"Q\"Q", "Q", "YY", "Y", "YYY", "Y,YYY",
  "HH", "HH12", "HH24", "hh24:mi:ss", "HH12:MI AM", "HH12:MI am", "HH12:MI P.M.", "HH12:MI p.m.", "MS", "US", "FF1", "FF3", "FF6",
  "SSSS", "SSSSS", "DDD", "DD", "D", "W", "WW", "CC", "J", "RM", "rm", "FMRM", "DDth", "DDTH", "FMDDth", "Mon FMDDth, YYYY", "AD", "BC",
  "\"week\" IW \"of\" IYYY", "YYYY\"\\\"\"MM", "FMHH12:MI", "FMMM/FMDD/YYYY", "TMMonth",
];
const NUMBERS = ["0", "0.5", "-0.5", "5", "-5", "1234.5", "-1234.5", "1234567.891", "89655199.68", "0.004", "999.995", "-0.0001", "12345", "99.5", "-99.5", "0.06"];
const NUMBER_FORMATS = [
  "9999", "0000", "FM9999", "9.99", "0.99", "FM9.99", "FM0.99", "9,999,999", "FM999,999,990.00", "999", "S9999", "9999S", "9999MI", "FM9999MI",
  "9999PL", "SG9999", "9999PR", "FM9999PR", "\"$\"999.99", "999D99", "9G999", "FM9G999D00", "99.9", "000.000", "FM000.000", "9990.0", "FM99990.09",
  "FM$9,999.00", "FM\"$\"9,999.00", "9,999", "FM9,999", "MI9999", "PL9999", "9999SG", "FM9999PL", "FMS9999", "FM9999S",
];

const quote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

test("Mason's to_char writes every pattern and template as Postgres does", { skip: url ? false : "IT_POSTGRES_URL is not set" }, async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const differ: string[] = [];
    const ask = async (pairs: Array<[string, string]>, sqlOf: (v: string, f: string) => string, ours: (v: string, f: string) => string | null): Promise<void> => {
      const r = await c.query({ text: `SELECT ${pairs.map(([v, f]) => sqlOf(v, f)).join(", ")}`, rowMode: "array" });
      pairs.forEach(([v, f], i) => {
        const want = r.rows[0]![i] as string | null;
        let got: string | null;
        try { got = ours(v, f); } catch (e) { got = `error: ${(e as Error).message}`; }
        if (got !== want) differ.push(`to_char(${v}, ${JSON.stringify(f)}): Mason ${JSON.stringify(got)}, Postgres ${JSON.stringify(want)}`);
      });
    };
    for (const f of TIME_FORMATS) await ask(TIMES.map((v) => [v, f]), (v, fm) => `to_char(${quote(v)}::timestamp, ${quote(fm)})`, toCharTime);
    for (const f of NUMBER_FORMATS) await ask(NUMBERS.map((v) => [v, f]), (v, fm) => `to_char(${quote(v)}::numeric, ${quote(fm)})`, toCharNumber);
    assert.deepEqual(differ, [], `${differ.length} to_char answer(s) differ from Postgres's`);
  } finally { await c.end(); }
});
