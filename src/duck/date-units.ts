/**
 * THE UNIT OF AN EXTRACT OR A DATE_PART, AS POSTGRES READS IT (issue 1006): the one reader of a field's name, so every
 * spelling Postgres takes for a field (`sec`, `secs`, `s` and `seconds` for `second`) reaches the same code, and every
 * name it refuses is refused in its words.
 *
 * Postgres lowers the name (ASCII letters only, in a UTF-8 database), cuts it to 63 bytes for its message, and looks it
 * up in `deltatktbl`, then in `datetktbl` (src/backend/utils/adt/datetime.c, `DecodeUnits` then `DecodeSpecial`). Each
 * table compares only the first `TOKMAXLEN` (10) characters, so `millisecond` and `milliseconds` both find
 * `millisecon`, and so does `millisecondsxyz`. The tables below are those two, token for token, as Postgres 18 has
 * them (the same in 16). What each type does with a field is its part function's switch (timestamp_part_common,
 * timestamptz_part_common, extract_date, time_part_common, timetz_part_common, interval_part_common).
 */

/** a field as Mason computes it: Postgres's own name for its DTK_* value */
export type DateField =
  | "microseconds" | "milliseconds" | "second" | "minute" | "hour" | "day" | "week" | "month" | "quarter" | "year"
  | "decade" | "century" | "millennium" | "julian" | "isoyear" | "dow" | "isodow" | "doy"
  | "timezone" | "timezone_hour" | "timezone_minute" | "epoch";

/** a token's type in Postgres's tables: UNITS, RESERV (with `epoch` the only field among them), or any other */
type Kind = "units" | "reserv" | "other";
type Token = readonly [token: string, kind: Kind, field?: DateField];

const U = (token: string, field: DateField): Token => [token, "units", field];
const OTHER = (token: string): Token => [token, "other"];
const RESERV = (token: string, field?: DateField): Token => field === undefined ? [token, "reserv"] : [token, "reserv", field];

/** deltatktbl: the units of an interval and of extract, every token (each at most TOKMAXLEN characters) */
const DELTA: readonly Token[] = [
  OTHER("@"), OTHER("ago"),
  U("c", "century"), U("cent", "century"), U("centuries", "century"), U("century", "century"),
  U("d", "day"), U("day", "day"), U("days", "day"),
  U("dec", "decade"), U("decade", "decade"), U("decades", "decade"), U("decs", "decade"),
  U("h", "hour"), U("hour", "hour"), U("hours", "hour"), U("hr", "hour"), U("hrs", "hour"),
  U("m", "minute"), U("microsecon", "microseconds"),
  U("mil", "millennium"), U("millennia", "millennium"), U("millennium", "millennium"), U("millisecon", "milliseconds"), U("mils", "millennium"),
  U("min", "minute"), U("mins", "minute"), U("minute", "minute"), U("minutes", "minute"),
  U("mon", "month"), U("mons", "month"), U("month", "month"), U("months", "month"),
  U("ms", "milliseconds"), U("msec", "milliseconds"), U("msecond", "milliseconds"), U("mseconds", "milliseconds"), U("msecs", "milliseconds"),
  U("qtr", "quarter"), U("quarter", "quarter"),
  U("s", "second"), U("sec", "second"), U("second", "second"), U("seconds", "second"), U("secs", "second"),
  U("timezone", "timezone"), U("timezone_h", "timezone_hour"), U("timezone_m", "timezone_minute"),
  U("us", "microseconds"), U("usec", "microseconds"), U("usecond", "microseconds"), U("useconds", "microseconds"), U("usecs", "microseconds"),
  U("w", "week"), U("week", "week"), U("weeks", "week"),
  U("y", "year"), U("year", "year"), U("years", "year"), U("yr", "year"), U("yrs", "year"),
];

/** datetktbl: the words of a date's input, read when deltatktbl has none (its `m`, `s`, `y`, `d`, `h`, `dec` and `mon`
 *  are never reached for a unit: deltatktbl has each first) */
const DATE: readonly Token[] = [
  RESERV("+infinity"), RESERV("-infinity"), OTHER("ad"), RESERV("allballs"), OTHER("am"), OTHER("apr"), OTHER("april"), OTHER("at"),
  OTHER("aug"), OTHER("august"), OTHER("bc"), U("d", "day"), OTHER("dec"), OTHER("december"), U("dow", "dow"), U("doy", "doy"),
  OTHER("dst"), RESERV("epoch", "epoch"), OTHER("feb"), OTHER("february"), OTHER("fri"), OTHER("friday"), U("h", "hour"),
  RESERV("infinity"), U("isodow", "isodow"), U("isoyear", "isoyear"), U("j", "julian"), OTHER("jan"), OTHER("january"),
  U("jd", "julian"), OTHER("jul"), U("julian", "julian"), OTHER("july"), OTHER("jun"), OTHER("june"), U("m", "month"), OTHER("mar"),
  OTHER("march"), OTHER("may"), U("mm", "minute"), OTHER("mon"), OTHER("monday"), OTHER("nov"), OTHER("november"), RESERV("now"),
  OTHER("oct"), OTHER("october"), OTHER("on"), OTHER("pm"), U("s", "second"), OTHER("sat"), OTHER("saturday"), OTHER("sep"),
  OTHER("sept"), OTHER("september"), OTHER("sun"), OTHER("sunday"), OTHER("t"), OTHER("thu"), OTHER("thur"), OTHER("thurs"),
  OTHER("thursday"), RESERV("today"), RESERV("tomorrow"), OTHER("tue"), OTHER("tues"), OTHER("tuesday"), OTHER("wed"),
  OTHER("wednesday"), OTHER("weds"), U("y", "year"), RESERV("yesterday"),
];

const TOKMAXLEN = 10;
/** NAMEDATALEN - 1: the bytes of the name Postgres keeps (`truncate_identifier`), and says in its message */
const NAME_BYTES = 63;

/** the name as Postgres keeps it (`downcase_truncate_identifier`): ASCII letters lowered, cut to 63 bytes at a whole
 *  character */
export function lowUnits(name: string): string {
  const low = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (Buffer.byteLength(low) <= NAME_BYTES) return low;
  let out = "";
  for (const ch of low) {
    if (Buffer.byteLength(out + ch) > NAME_BYTES) break;
    out += ch;
  }
  return out;
}

/** a token of one table the name finds (`datebsearch`'s `strncmp(key, token, TOKMAXLEN)`) */
function lookUp(table: readonly Token[], key: string): Token | undefined {
  return table.find(([token]) => token.length === TOKMAXLEN ? key.slice(0, TOKMAXLEN) === token : key === token);
}

/** what the name is to Postgres's unit lookup: its lowered text, its kind, and its field where it names one */
export function dateUnit(name: string): { low: string; kind: Kind | "unknown"; field: DateField | null } {
  const low = lowUnits(name);
  const found = lookUp(DELTA, low) ?? lookUp(DATE, low);
  if (found === undefined) return { low, kind: "unknown", field: null };
  return { low, kind: found[1], field: found[2] ?? null };
}

/** the types extract and date_part read a field of */
export type PartType = "timestamp" | "timestamptz" | "date" | "time" | "timetz" | "interval";

const TYPE_NAME: Record<PartType, string> = {
  timestamp: "timestamp without time zone", timestamptz: "timestamp with time zone", date: "date",
  time: "time without time zone", timetz: "time with time zone", interval: "interval",
};

const TIME_OF_DAY: readonly DateField[] = ["microseconds", "milliseconds", "second", "minute", "hour"];
const OF_A_DATE: readonly DateField[] = ["day", "week", "month", "quarter", "year", "decade", "century", "millennium", "julian", "isoyear", "dow", "isodow", "doy"];
const ZONE: readonly DateField[] = ["timezone", "timezone_hour", "timezone_minute"];
/** the UNITS fields each type answers; the rest of the UNITS are "not supported" */
const ANSWERS: Record<PartType, ReadonlySet<DateField>> = {
  timestamp: new Set([...TIME_OF_DAY, ...OF_A_DATE]),
  timestamptz: new Set([...TIME_OF_DAY, ...OF_A_DATE, ...ZONE]),
  date: new Set(OF_A_DATE),
  time: new Set(TIME_OF_DAY),
  timetz: new Set([...TIME_OF_DAY, ...ZONE]),
  interval: new Set([...TIME_OF_DAY, "day", "week", "month", "quarter", "year", "decade", "century", "millennium"]),
};

/**
 * What a type's part function does with the name: the field it answers, or the error it raises at a row, Postgres's
 * SQLSTATE and words. `finiteOnly` is an error an infinite value does not raise: a timestamp's zone fields, which its
 * infinities answer as NULL (`NonFiniteTimestampTzPart`).
 */
export type PartUnit = { field: DateField } | { code: "22023" | "0A000"; message: string; finiteOnly: boolean };

export function partUnit(name: string, type: PartType): PartUnit {
  const { low, kind, field } = dateUnit(name);
  const refused = (code: "22023" | "0A000", finiteOnly = false): PartUnit =>
    ({ code, message: `unit "${low}" ${code === "22023" ? "not recognized" : "not supported"} for type ${TYPE_NAME[type]}`, finiteOnly });
  if (kind === "units" && field !== null) return ANSWERS[type].has(field) ? { field } : refused("0A000", type === "timestamp" && ZONE.includes(field));
  if (kind === "reserv" && field === "epoch") return { field };
  // a reserved word other than epoch: "not supported" where the type's switch reads RESERV, else "not recognized"
  if (kind === "reserv" && (type === "timestamp" || type === "timestamptz" || type === "date")) return refused("0A000");
  return refused("22023");
}
