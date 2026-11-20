/**
 * EVERY SPELLING OF A DATE AND TIME UNIT POSTGRES TAKES (issue 1167), copied from Postgres 18's own tables in
 * src/backend/utils/adt/datetime.c (REL_18_STABLE), never from Mason's (src/duck/units.ts): `tests/duck-units.test.ts`
 * holds Mason's reading to them, and the oracle sends each unit under each spelling (oracle/type-matrix.ts).
 */

/** Postgres's unit codes (datetime.h), each by the name the type matrix and Mason's rewrite give it */
export const DTK = {
  DTK_MICROSEC: "microseconds", DTK_MILLISEC: "milliseconds", DTK_SECOND: "second", DTK_MINUTE: "minute", DTK_HOUR: "hour",
  DTK_DAY: "day", DTK_WEEK: "week", DTK_MONTH: "month", DTK_QUARTER: "quarter", DTK_YEAR: "year", DTK_DECADE: "decade",
  DTK_CENTURY: "century", DTK_MILLENNIUM: "millennium", DTK_TZ: "timezone", DTK_TZ_HOUR: "timezone_hour",
  DTK_TZ_MINUTE: "timezone_minute", DTK_DOW: "dow", DTK_ISODOW: "isodow", DTK_DOY: "doy", DTK_ISOYEAR: "isoyear",
  DTK_JULIAN: "julian", DTK_EPOCH: "epoch",
} as const;
export type DtkName = keyof typeof DTK;

/** `deltatktbl`, every entry, in its order: [token, type, value] (DecodeUnits reads it, for every function) */
export const DELTATKTBL: ReadonlyArray<readonly [string, "UNITS" | "IGNORE_DTF" | "AGO", DtkName | null]> = [
  ["@", "IGNORE_DTF", null], ["ago", "AGO", null],
  ["c", "UNITS", "DTK_CENTURY"], ["cent", "UNITS", "DTK_CENTURY"], ["centuries", "UNITS", "DTK_CENTURY"], ["century", "UNITS", "DTK_CENTURY"],
  ["d", "UNITS", "DTK_DAY"], ["day", "UNITS", "DTK_DAY"], ["days", "UNITS", "DTK_DAY"],
  ["dec", "UNITS", "DTK_DECADE"], ["decade", "UNITS", "DTK_DECADE"], ["decades", "UNITS", "DTK_DECADE"], ["decs", "UNITS", "DTK_DECADE"],
  ["h", "UNITS", "DTK_HOUR"], ["hour", "UNITS", "DTK_HOUR"], ["hours", "UNITS", "DTK_HOUR"], ["hr", "UNITS", "DTK_HOUR"], ["hrs", "UNITS", "DTK_HOUR"],
  ["m", "UNITS", "DTK_MINUTE"], ["microsecon", "UNITS", "DTK_MICROSEC"],
  ["mil", "UNITS", "DTK_MILLENNIUM"], ["millennia", "UNITS", "DTK_MILLENNIUM"], ["millennium", "UNITS", "DTK_MILLENNIUM"],
  ["millisecon", "UNITS", "DTK_MILLISEC"], ["mils", "UNITS", "DTK_MILLENNIUM"],
  ["min", "UNITS", "DTK_MINUTE"], ["mins", "UNITS", "DTK_MINUTE"], ["minute", "UNITS", "DTK_MINUTE"], ["minutes", "UNITS", "DTK_MINUTE"],
  ["mon", "UNITS", "DTK_MONTH"], ["mons", "UNITS", "DTK_MONTH"], ["month", "UNITS", "DTK_MONTH"], ["months", "UNITS", "DTK_MONTH"],
  ["ms", "UNITS", "DTK_MILLISEC"], ["msec", "UNITS", "DTK_MILLISEC"], ["msecond", "UNITS", "DTK_MILLISEC"], ["mseconds", "UNITS", "DTK_MILLISEC"], ["msecs", "UNITS", "DTK_MILLISEC"],
  ["qtr", "UNITS", "DTK_QUARTER"], ["quarter", "UNITS", "DTK_QUARTER"],
  ["s", "UNITS", "DTK_SECOND"], ["sec", "UNITS", "DTK_SECOND"], ["second", "UNITS", "DTK_SECOND"], ["seconds", "UNITS", "DTK_SECOND"], ["secs", "UNITS", "DTK_SECOND"],
  ["timezone", "UNITS", "DTK_TZ"], ["timezone_h", "UNITS", "DTK_TZ_HOUR"], ["timezone_m", "UNITS", "DTK_TZ_MINUTE"],
  ["us", "UNITS", "DTK_MICROSEC"], ["usec", "UNITS", "DTK_MICROSEC"], ["usecond", "UNITS", "DTK_MICROSEC"], ["useconds", "UNITS", "DTK_MICROSEC"], ["usecs", "UNITS", "DTK_MICROSEC"],
  ["w", "UNITS", "DTK_WEEK"], ["week", "UNITS", "DTK_WEEK"], ["weeks", "UNITS", "DTK_WEEK"],
  ["y", "UNITS", "DTK_YEAR"], ["year", "UNITS", "DTK_YEAR"], ["years", "UNITS", "DTK_YEAR"], ["yr", "UNITS", "DTK_YEAR"], ["yrs", "UNITS", "DTK_YEAR"],
];

/** `datetktbl`'s UNITS and RESERV entries (DecodeSpecial reads it where DecodeUnits finds nothing: extract and
 *  date_part only). Its months, days of the week, AM/PM, AD/BC, `dst`, `at`, `on` and `t` are no unit, read as no
 *  spelling is; RESERV's value is the unit only for `epoch` */
export const DATETKTBL: ReadonlyArray<readonly [string, "UNITS" | "RESERV", DtkName | null]> = [
  ["+infinity", "RESERV", null], ["-infinity", "RESERV", null], ["allballs", "RESERV", null],
  ["d", "UNITS", "DTK_DAY"], ["dow", "UNITS", "DTK_DOW"], ["doy", "UNITS", "DTK_DOY"], ["epoch", "RESERV", "DTK_EPOCH"],
  ["h", "UNITS", "DTK_HOUR"], ["infinity", "RESERV", null], ["isodow", "UNITS", "DTK_ISODOW"], ["isoyear", "UNITS", "DTK_ISOYEAR"],
  ["j", "UNITS", "DTK_JULIAN"], ["jd", "UNITS", "DTK_JULIAN"], ["julian", "UNITS", "DTK_JULIAN"],
  ["m", "UNITS", "DTK_MONTH"], ["mm", "UNITS", "DTK_MINUTE"], ["now", "RESERV", null], ["s", "UNITS", "DTK_SECOND"],
  ["today", "RESERV", null], ["tomorrow", "RESERV", null], ["y", "UNITS", "DTK_YEAR"], ["yesterday", "RESERV", null],
];

/** spellings a table matches without holding them: a token of TOKMAXLEN (10) characters matches any spelling it
 *  begins, and the unit is lowercased first */
export const ALSO_READ: ReadonlyArray<readonly [string, DtkName]> = [
  ["microsecond", "DTK_MICROSEC"], ["microseconds", "DTK_MICROSEC"], ["millisecond", "DTK_MILLISEC"], ["milliseconds", "DTK_MILLISEC"],
  ["timezone_hour", "DTK_TZ_HOUR"], ["timezone_minute", "DTK_TZ_MINUTE"], ["millenniums", "DTK_MILLENNIUM"],
  ["SECONDS", "DTK_SECOND"], ["Year", "DTK_YEAR"], ["MicroSeconds", "DTK_MICROSEC"],
];

/** each unit's every spelling extract and date_part take (date_trunc reads `deltatktbl`'s alone), the table's own
 *  first: what the oracle sends */
export function spellings(): Map<string, { all: string[]; trunc: string[] }> {
  const out = new Map<string, { all: string[]; trunc: string[] }>();
  const add = (token: string, dtk: DtkName, delta: boolean): void => {
    const unit = DTK[dtk];
    const s = out.get(unit) ?? { all: [], trunc: [] };
    out.set(unit, s);
    if (!s.all.includes(token)) s.all.push(token);
    if (delta && !s.trunc.includes(token)) s.trunc.push(token);
  };
  const inDelta = new Set(DELTATKTBL.map(([t]) => t));
  for (const [token, type, dtk] of DELTATKTBL) if (type === "UNITS" && dtk !== null) add(token, dtk, true);
  for (const [token, , dtk] of DATETKTBL) if (dtk !== null && !inDelta.has(token)) add(token, dtk, false);
  for (const [token, dtk] of ALSO_READ) add(token, dtk, DELTATKTBL.some(([t, , d]) => d === dtk && (t === token.toLowerCase() || (t.length === 10 && token.toLowerCase().startsWith(t)))));
  return out;
}
