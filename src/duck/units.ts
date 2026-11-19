/**
 * A DATE AND TIME UNIT, READ AS POSTGRES READS IT (issue 1167). `extract`, `date_part` and `date_trunc` take a unit by
 * any of its spellings: `second`, `seconds`, `sec`, `secs` and `s` are one unit, as are `y`, `yr`, `yrs`, `year` and
 * `years`. The rewrite once matched some spellings only, so `date_part('seconds', t)` took another path than
 * `date_part('second', t)` and lost the fraction of a second. Now a unit is read here, once, at each call's entrance
 * (src/duck/rewrite.ts `funcCall`), into its one name, and every rule after it sees that name alone.
 *
 * The spellings are Postgres 18's own tables, read from src/backend/utils/adt/datetime.c (REL_18_STABLE):
 *  - `deltatktbl`, read by `DecodeUnits`, is every function's;
 *  - `datetktbl`, read by `DecodeSpecial` only where `DecodeUnits` finds nothing, is extract's and date_part's alone
 *    (`dow`, `doy`, `isodow`, `isoyear`, `julian` and `mm`, a minute, and `epoch`). date_trunc never reads it.
 * Postgres lowercases the unit's ASCII letters and cuts it to 63 bytes (`downcase_truncate_identifier`). It trims no
 * space. A table's token is matched on its first TOKMAXLEN (10) characters, so a token of 10 matches any spelling that
 * starts with it (`microsecon` is `microsecond` and `microseconds`, `timezone_h` is `timezone_hour`).
 *
 * Which unit a type takes, and the refusal of one it does not, are Postgres 18's `timestamp_part_common`,
 * `timestamptz_part_common`, `extract_date`, `time_part_common`, `timetz_part_common`, `interval_part_common`,
 * `timestamp_trunc`, `timestamptz_trunc_internal` and `interval_trunc`. A unit a type does not have is 0A000 `unit "…"
 * not supported for type …`, and a spelling no table holds is 22023 `unit "…" not recognized for type …`. The unit is
 * quoted as Postgres quotes it: lowercased, never its one name.
 */
import { callsTo, constTextOf, exprType, type TreeNode, type TreeValue } from "./pgtree.ts";

/** Postgres's units (its DTK_* codes), each by the one name the rewrite and the engine take */
export type Unit = "microseconds" | "milliseconds" | "second" | "minute" | "hour" | "day" | "week" | "month" | "quarter"
  | "year" | "decade" | "century" | "millennium" | "timezone" | "timezone_hour" | "timezone_minute"
  | "dow" | "isodow" | "doy" | "isoyear" | "julian" | "epoch";

/** `deltatktbl`'s UNITS entries, in its order. Its other two ("@" and "ago") are no unit, read as no spelling is */
export const DELTA_UNITS: ReadonlyMap<string, Unit> = new Map<string, Unit>([
  ["c", "century"], ["cent", "century"], ["centuries", "century"], ["century", "century"],
  ["d", "day"], ["day", "day"], ["days", "day"],
  ["dec", "decade"], ["decade", "decade"], ["decades", "decade"], ["decs", "decade"],
  ["h", "hour"], ["hour", "hour"], ["hours", "hour"], ["hr", "hour"], ["hrs", "hour"],
  ["m", "minute"], ["microsecon", "microseconds"],
  ["mil", "millennium"], ["millennia", "millennium"], ["millennium", "millennium"], ["millisecon", "milliseconds"], ["mils", "millennium"],
  ["min", "minute"], ["mins", "minute"], ["minute", "minute"], ["minutes", "minute"],
  ["mon", "month"], ["mons", "month"], ["month", "month"], ["months", "month"],
  ["ms", "milliseconds"], ["msec", "milliseconds"], ["msecond", "milliseconds"], ["mseconds", "milliseconds"], ["msecs", "milliseconds"],
  ["qtr", "quarter"], ["quarter", "quarter"],
  ["s", "second"], ["sec", "second"], ["second", "second"], ["seconds", "second"], ["secs", "second"],
  ["timezone", "timezone"], ["timezone_h", "timezone_hour"], ["timezone_m", "timezone_minute"],
  ["us", "microseconds"], ["usec", "microseconds"], ["usecond", "microseconds"], ["useconds", "microseconds"], ["usecs", "microseconds"],
  ["w", "week"], ["week", "week"], ["weeks", "week"],
  ["y", "year"], ["year", "year"], ["years", "year"], ["yr", "year"], ["yrs", "year"],
]);

/** `datetktbl`'s UNITS entries (`d`, `h`, `m`, `s` and `y` are found in `deltatktbl` first, so its `m`, a month, is never read) */
export const SPECIAL_UNITS: ReadonlyMap<string, Unit> = new Map<string, Unit>([
  ["d", "day"], ["dow", "dow"], ["doy", "doy"], ["h", "hour"], ["isodow", "isodow"], ["isoyear", "isoyear"],
  ["j", "julian"], ["jd", "julian"], ["julian", "julian"], ["m", "month"], ["mm", "minute"], ["s", "second"], ["y", "year"],
]);

/** `datetktbl`'s RESERV entries: `epoch` is a unit, the others a unit no type has */
export const RESERVED: ReadonlySet<string> = new Set(["+infinity", "-infinity", "allballs", "epoch", "infinity", "now", "today", "tomorrow", "yesterday"]);

const TOKMAXLEN = 10;
const NAMEDATALEN = 64;

/** `downcase_truncate_identifier(…, false)`: the ASCII letters lowercased, cut to 63 bytes on a character's boundary */
export function lowUnits(text: string): string {
  const low = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (Buffer.byteLength(low, "utf8") < NAMEDATALEN) return low;
  let out = "";
  for (const ch of low) {
    if (Buffer.byteLength(out + ch, "utf8") > NAMEDATALEN - 1) break;
    out += ch;
  }
  return out;
}

/** `datebsearch`'s key: a token matches the spelling equal to it, and one of TOKMAXLEN characters any spelling it begins */
const tokenOf = (low: string): string => low.length > TOKMAXLEN ? low.slice(0, TOKMAXLEN) : low;

/** what a spelling is: its unit and which table named it (`delta`, read by every function; `special`, by extract and
 *  date_part alone), a reserved word no type has, or nothing Postgres knows */
export type UnitRead = { low: string } & ({ unit: Unit; table: "delta" | "special" } | { unit: null; table: "reserved" | null });

/** a spelling read as `DecodeUnits` and then `DecodeSpecial` read it */
export function readUnit(text: string): UnitRead {
  const low = lowUnits(text), token = tokenOf(low);
  const delta = DELTA_UNITS.get(token);
  if (delta !== undefined) return { low, unit: delta, table: "delta" };
  const special = SPECIAL_UNITS.get(token) ?? (token === "epoch" ? "epoch" : undefined);
  if (special !== undefined) return { low, unit: special, table: "special" };
  return { low, unit: null, table: RESERVED.has(token) ? "reserved" : null };
}

const DATE = 1082, TIMESTAMP = 1114, TIMESTAMPTZ = 1184, TIME = 1083, TIMETZ = 1266, INTERVAL = 1186;
const TYPE_NAME: Record<number, string> = {
  [DATE]: "date", [TIMESTAMP]: "timestamp without time zone", [TIMESTAMPTZ]: "timestamp with time zone",
  [TIME]: "time without time zone", [TIMETZ]: "time with time zone", [INTERVAL]: "interval",
};

const TIME_OF_DAY: Unit[] = ["microseconds", "milliseconds", "second", "minute", "hour"];
const CALENDAR: Unit[] = ["day", "week", "month", "quarter", "year", "decade", "century", "millennium"];
const DAY_PARTS: Unit[] = ["dow", "isodow", "doy", "isoyear", "julian"];
const ZONE: Unit[] = ["timezone", "timezone_hour", "timezone_minute"];

/** the units extract takes of each type (epoch included), and whether a reserved word is 0A000 there or 22023 */
const EXTRACTS: Record<number, { units: ReadonlySet<Unit>; reserved: "0A000" | "22023" }> = {
  [TIMESTAMPTZ]: { units: new Set([...TIME_OF_DAY, ...CALENDAR, ...DAY_PARTS, ...ZONE, "epoch"]), reserved: "0A000" },
  [TIMESTAMP]: { units: new Set([...TIME_OF_DAY, ...CALENDAR, ...DAY_PARTS, "epoch"]), reserved: "0A000" },
  [DATE]: { units: new Set([...CALENDAR, ...DAY_PARTS, "epoch"]), reserved: "0A000" },
  [TIME]: { units: new Set([...TIME_OF_DAY, "epoch"]), reserved: "22023" },
  [TIMETZ]: { units: new Set([...TIME_OF_DAY, ...ZONE, "epoch"]), reserved: "22023" },
  [INTERVAL]: { units: new Set([...TIME_OF_DAY, ...CALENDAR, "epoch"]), reserved: "22023" },
};
/** the units date_trunc takes of each type: `deltatktbl`'s alone */
const TRUNCS: Record<number, ReadonlySet<Unit>> = {
  [TIMESTAMPTZ]: new Set([...TIME_OF_DAY, ...CALENDAR]),
  [TIMESTAMP]: new Set([...TIME_OF_DAY, ...CALENDAR]),
  [INTERVAL]: new Set([...TIME_OF_DAY, ...CALENDAR.filter((u) => u !== "week")]),
};

export type UnitCall = "extract" | "date_part" | "date_trunc";
/**
 * a unit as a call reads it: its one name, or Postgres's refusal (its SQLSTATE and words). Postgres refuses at a row
 * that holds a value, never in its analysis: none of a NULL, and none over no rows. `finiteOnly` is a refusal an
 * infinite value does not raise: a timestamp's zone units, which Postgres answers NULL of an infinity
 * (`NonFiniteTimestampTzPart`)
 */
export type CallUnit = { unit: Unit } | { code: "22023" | "0A000"; message: string; finiteOnly: boolean };
/** a refusal Postgres's planner raises once these parameters are bound, each to a value (a zone unit of a timestamp: a
 *  finite one) */
export type UnitParam = { params: readonly number[]; code: "22023" | "0A000"; message: string; finiteOnly: boolean };

/**
 * THE UNIT `call` READS `text` AS, OF AN ARGUMENT OF `type` (the OID Postgres's analysis chose for the function's
 * argument, not the value's own: a date's date_trunc is date_trunc(text, timestamptz), a time's is the interval's), or
 * Postgres's refusal. null for a type none of the three functions takes. date_part of a date is a SQL function that
 * reads the date as a timestamp (`date_part($1, $2::timestamp)`), so it takes a timestamp's units and is refused as
 * one, where extract of a date is the date's own.
 */
export function callUnit(call: UnitCall, text: string, type: number | null): CallUnit | null {
  const of = call === "date_part" && type === DATE ? TIMESTAMP : type;
  if (of === null) return null;
  const read = readUnit(text);
  const name = TYPE_NAME[of];
  if (name === undefined) return null;
  const unrecognized = (): CallUnit => ({ code: "22023", message: `unit "${read.low}" not recognized for type ${name}`, finiteOnly: false });
  const unsupported = (finiteOnly = false): CallUnit => ({ code: "0A000", message: `unit "${read.low}" not supported for type ${name}`, finiteOnly });
  if (call === "date_trunc") {
    const takes = TRUNCS[of];
    if (takes === undefined) return null;
    if (read.table !== "delta") return unrecognized();
    return takes.has(read.unit) ? { unit: read.unit } : unsupported();
  }
  const takes = EXTRACTS[of];
  if (takes === undefined) return null;
  if (read.unit === null) return read.table === "reserved" && takes.reserved === "0A000" ? unsupported() : unrecognized();
  // (a timestamp's zone unit is NULL of an infinity, its refusal only of a finite value)
  return takes.units.has(read.unit) ? { unit: read.unit } : unsupported(of === TIMESTAMP && ZONE.includes(read.unit));
}

/** each of the three functions by its OID in Postgres 18's catalog (pg_proc.dat): extract's six, date_part's six (a
 *  date's is a SQL function over the date as a timestamp) and date_trunc's four */
export const UNIT_CALL_OIDS: ReadonlyMap<number, UnitCall> = new Map<number, UnitCall>([
  [6199, "extract"], [6200, "extract"], [6201, "extract"], [6202, "extract"], [6203, "extract"], [6204, "extract"],
  [1171, "date_part"], [1172, "date_part"], [1273, "date_part"], [1384, "date_part"], [1385, "date_part"], [2021, "date_part"],
  [1217, "date_trunc"], [1218, "date_trunc"], [1284, "date_trunc"], [2020, "date_trunc"],
]);

/**
 * THE CALLS OF A STATEMENT'S ANALYSIS THAT REFUSE THEIR UNIT (`callUnit`), each with its refusal: what src/duck/plan.ts
 * asks the planner's folding of (`foldedUnits`), since Postgres refuses there, before a row is read, where it folds one.
 */
export function refusedUnitCalls(tree: TreeValue): Array<{ call: TreeNode; value: TreeValue | undefined; refusal: Extract<CallUnit, { code: string }> }> {
  return callsTo(tree, new Set(UNIT_CALL_OIDS.keys())).flatMap(({ call, args }) => {
    const text = constTextOf(args[0]);
    const value = args[1];
    const type = value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value) ? exprType(value)?.type ?? null : null;
    const read = typeof text === "string" ? callUnit(UNIT_CALL_OIDS.get(Number(call.funcid))!, text, type) : null;
    return read !== null && "code" in read ? [{ call, value, refusal: read }] : [];
  });
}
