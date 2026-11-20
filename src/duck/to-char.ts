/**
 * POSTGRES'S to_char (formatting.c), in JavaScript: what the rewrite calls for `to_char(time, fmt)` and
 * `to_char(number, fmt)` (src/duck/functions.ts registers it), because DuckDB's strftime has neither Postgres's
 * patterns (Q, IYYY, FMMonth, a name padded to nine) nor its number templates (`FM999,999,990.00`). Held to Postgres
 * itself by tests/integration/duck-to-char.itest.ts, which formats the same values both ways.
 *
 * English names only (Postgres's TM prefix translates, and is read as English here); a pattern this does not write
 * (TZ's abbreviation, SP, EEEE, RN, V) raises an error naming it rather than writing something else.
 */

export class ToCharError extends Error {}

// ------------------------------------------------------------------------------------------------- times

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

/** a wall-clock time and its zone offset, read from DuckDB's text of a date, a timestamp or a timestamptz */
interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number; micro: number; offset: number | null }

function readWall(text: string): Wall | null {
  if (/infinity/i.test(text)) return null;
  const m = /^(-?\d+)-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?(?:([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?( \(BC\))?$/.exec(text.trim());
  if (m === null) throw new ToCharError(`to_char cannot read the time ${JSON.stringify(text)}: report it (Mason)`);
  const bc = m[12] !== undefined;
  const year = Number(m[1]);
  return {
    year: bc ? 1 - year : year, month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4] ?? 0), minute: Number(m[5] ?? 0), second: Number(m[6] ?? 0), micro: Number((m[7] ?? "").padEnd(6, "0")),
    offset: m[8] === undefined ? null : (m[8] === "-" ? -1 : 1) * (Number(m[9]) * 3600 + Number(m[10] ?? 0) * 60 + Number(m[11] ?? 0)),
  };
}

/** days from 1970-01-01 of a proleptic Gregorian date */
function epochDay(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045 - 2440588;
}
const dayOfWeek = (y: number, m: number, d: number): number => ((epochDay(y, m, d) % 7) + 7 + 4) % 7;   // 0 = Sunday
const dayOfYear = (y: number, m: number, d: number): number => epochDay(y, m, d) - epochDay(y, 1, 1) + 1;

/** the ISO 8601 year and week of a date, and its day of the ISO year */
function isoWeek(y: number, m: number, d: number): { year: number; week: number; yday: number } {
  const day = epochDay(y, m, d);
  const isoDow = ((dayOfWeek(y, m, d) + 6) % 7) + 1;   // 1 = Monday
  const thursday = day - isoDow + 4;
  const thursdayYear = yearOf(thursday);
  const week1Monday = (yy: number): number => { const jan4 = epochDay(yy, 1, 4); const dow = ((dayOfWeekOf(jan4) + 6) % 7) + 1; return jan4 - dow + 1; };
  const start = week1Monday(thursdayYear);
  return { year: thursdayYear, week: Math.floor((day - start) / 7) + 1, yday: day - start + 1 };
}
const dayOfWeekOf = (epoch: number): number => ((epoch % 7) + 7 + 4) % 7;
function yearOf(epoch: number): number {
  let y = Math.floor(epoch / 365.2425) + 1970;
  while (epochDay(y, 1, 1) > epoch) y--;
  while (epochDay(y + 1, 1, 1) <= epoch) y++;
  return y;
}

/** the template's patterns, longest first where one is another's prefix (formatting.c's DCH_keywords) */
const TIME_PATTERNS = [
  "A.D.", "A.M.", "AD", "AM", "B.C.", "BC", "CC", "DAY", "DDD", "DD", "DY", "Day", "Dy", "D", "FF1", "FF2", "FF3", "FF4", "FF5", "FF6",
  "HH24", "HH12", "HH", "IDDD", "ID", "IW", "IYYY", "IYY", "IY", "I", "J", "MI", "MM", "MONTH", "MON", "MS", "Month", "Mon", "OF",
  "P.M.", "PM", "Q", "RM", "SSSSS", "SSSS", "SS", "TZH", "TZM", "TZ", "US", "WW", "W", "Y,YYY", "YYYY", "YYY", "YY", "Y",
  "a.d.", "a.m.", "ad", "am", "b.c.", "bc", "cc", "day", "ddd", "dd", "dy", "d", "ff1", "ff2", "ff3", "ff4", "ff5", "ff6",
  "hh24", "hh12", "hh", "iddd", "id", "iw", "iyyy", "iyy", "iy", "i", "j", "mi", "mm", "month", "mon", "ms", "of",
  "p.m.", "pm", "q", "rm", "sssss", "ssss", "ss", "tzh", "tzm", "tz", "us", "ww", "w", "y,yyy", "yyyy", "yyy", "yy", "y",
];

/** an ordinal's suffix (TH / th) */
function ordinal(n: number, upper: boolean): string {
  const t = n % 100, u = n % 10;
  const s = t >= 11 && t <= 13 ? "th" : u === 1 ? "st" : u === 2 ? "nd" : u === 3 ? "rd" : "th";
  return upper ? s.toUpperCase() : s;
}

/** a name in the pattern's case (MONTH, Month, month), padded to nine unless FM */
function named(name: string, pattern: string, fm: boolean, width: number): string {
  const cased = pattern === pattern.toUpperCase() ? name.toUpperCase() : pattern[0] === pattern[0]!.toUpperCase() ? name : name.toLowerCase();
  return fm ? cased : cased.padEnd(width, " ");
}

/** to_char(timestamp | timestamptz | date, fmt): `text` is DuckDB's text of the value (in the session's zone) */
export function toCharTime(text: string, fmt: string): string | null {
  // an empty template is NULL (timestamp_to_char)
  if (fmt === "") return null;
  const w = readWall(text);
  if (w === null) return null;
  const { year, month, day, hour, minute, second, micro } = w;
  let out = "", i = 0;
  while (i < fmt.length) {
    // FM (fill mode) or TM (translation: English here, and, as Postgres does, never padded) prefixes the next pattern:
    // ONE prefix an item, as parse_format reads it, so a second is the text it spells (`FMFM` writes `FM`, `FMTMMonth`
    // writes `T03onth`), and a prefix with nothing after it writes nothing (`FM` writes '')
    let fm = false;
    if (fmt.startsWith("FM", i) || fmt.startsWith("fm", i) || fmt.startsWith("TM", i) || fmt.startsWith("tm", i)) { fm = true; i += 2; }
    if (i >= fmt.length) break;
    // FX is a pattern that writes nothing
    if (fmt.startsWith("FX", i) || fmt.startsWith("fx", i)) { i += 2; continue; }
    const c = fmt[i]!;
    if (c === '"') {
      // a quoted literal; a backslash escapes the next character in it
      i++;
      while (i < fmt.length && fmt[i] !== '"') { if (fmt[i] === "\\" && i + 1 < fmt.length) i++; out += fmt[i]; i++; }
      i++;
      continue;
    }
    if (c === "\\" && fmt[i + 1] === '"') { out += '"'; i += 2; continue; }
    const pattern = TIME_PATTERNS.find((p) => fmt.startsWith(p, i));
    if (pattern === undefined) { out += c; i++; continue; }
    i += pattern.length;
    const th = fmt.startsWith("TH", i) ? "TH" : fmt.startsWith("th", i) ? "th" : null;
    if (th !== null) i += 2;
    if (fmt.startsWith("SP", i) || fmt.startsWith("sp", i)) throw new ToCharError(`the to_char suffix SP is not supported`);
    const num = (n: number, width: number): string => {
      const neg = n < 0;
      const digits = String(Math.abs(n));
      const body = fm ? digits : digits.padStart(width, "0");
      return (neg ? "-" : "") + body + (th === null ? "" : ordinal(Math.abs(n), th === "TH"));
    };
    // a fraction of the second is zero-padded under FM too, as Postgres writes it (`%03d` and the like, whatever the prefix)
    const fraction = (n: number, width: number): string => String(n).padStart(width, "0") + (th === null ? "" : ordinal(n, th === "TH"));
    const P = pattern.toUpperCase();
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    const pm = hour >= 12;
    const iso = (): { year: number; week: number; yday: number } => isoWeek(year, month, day);
    switch (P) {
      case "HH": case "HH12": out += num(h12, 2); break;
      case "HH24": out += num(hour, 2); break;
      case "MI": out += num(minute, 2); break;
      case "SS": out += num(second, 2); break;
      case "MS": out += fraction(Math.floor(micro / 1000), 3); break;
      case "US": out += fraction(micro, 6); break;
      case "FF1": case "FF2": case "FF3": case "FF4": case "FF5": case "FF6": {
        const n = Number(P[2]);
        out += fraction(Math.floor(micro / 10 ** (6 - n)), n); break;
      }
      case "SSSS": case "SSSSS": out += num(hour * 3600 + minute * 60 + second, 0); break;
      case "AM": case "PM": out += pattern === P ? (pm ? "PM" : "AM") : (pm ? "pm" : "am"); break;
      case "A.M.": case "P.M.": out += pattern === P ? (pm ? "P.M." : "A.M.") : (pm ? "p.m." : "a.m."); break;
      case "AD": case "BC": out += pattern === P ? (year <= 0 ? "BC" : "AD") : (year <= 0 ? "bc" : "ad"); break;
      case "A.D.": case "B.C.": out += pattern === P ? (year <= 0 ? "B.C." : "A.D.") : (year <= 0 ? "b.c." : "a.d."); break;
      // TH is the ordinal of the whole year, as Postgres reads the text it wrote
      case "Y,YYY": { const y = year <= 0 ? 1 - year : year; out += `${Math.floor(y / 1000)},${String(y % 1000).padStart(3, "0")}${th === null ? "" : ordinal(y, th === "TH")}`; break; }
      case "YYYY": out += num(year <= 0 ? 1 - year : year, 4); break;
      case "YYY": out += num((year <= 0 ? 1 - year : year) % 1000, 3); break;
      case "YY": out += num((year <= 0 ? 1 - year : year) % 100, 2); break;
      case "Y": out += num((year <= 0 ? 1 - year : year) % 10, 1); break;
      case "IYYY": out += num(iso().year, 4); break;
      case "IYY": out += num(iso().year % 1000, 3); break;
      case "IY": out += num(iso().year % 100, 2); break;
      case "I": out += num(iso().year % 10, 1); break;
      case "MONTH": out += named(MONTHS[month - 1]!, pattern, fm, 9); break;
      case "MON": out += named(MONTHS[month - 1]!.slice(0, 3), pattern, true, 3); break;
      case "MM": out += num(month, 2); break;
      case "DAY": out += named(DAYS[dayOfWeek(year, month, day)]!, pattern, fm, 9); break;
      case "DY": out += named(DAYS[dayOfWeek(year, month, day)]!.slice(0, 3), pattern, true, 3); break;
      case "DDD": out += num(dayOfYear(year, month, day), 3); break;
      case "IDDD": out += num(iso().yday, 3); break;
      case "DD": out += num(day, 2); break;
      case "D": out += num(dayOfWeek(year, month, day) + 1, 1); break;
      case "ID": out += num(((dayOfWeek(year, month, day) + 6) % 7) + 1, 1); break;
      case "W": out += num(Math.floor((day - 1) / 7) + 1, 1); break;
      case "WW": out += num(Math.floor((dayOfYear(year, month, day) - 1) / 7) + 1, 2); break;
      case "IW": out += num(iso().week, 2); break;
      case "CC": { const cc = year > 0 ? Math.floor((year + 99) / 100) : -Math.floor((99 - year) / 100); out += num(cc, 2); break; }
      case "J": out += num(epochDay(year, month, day) + 2440588, 0); break;
      case "Q": out += num(Math.floor((month - 1) / 3) + 1, 0); break;
      case "RM": { const r = ROMAN[month - 1]!; const cased = pattern === P ? r : r.toLowerCase(); out += fm ? cased : cased.padEnd(4, " "); break; }
      case "TZH": case "TZM": case "OF": {
        if (w.offset === null) break;
        const sign = w.offset < 0 ? "-" : "+", a = Math.abs(w.offset);
        const hh = String(Math.floor(a / 3600)).padStart(2, "0"), mm = String(Math.floor((a % 3600) / 60)).padStart(2, "0");
        out += P === "TZH" ? `${sign}${hh}` : P === "TZM" ? mm : `${sign}${hh}${mm === "00" ? "" : `:${mm}`}`;
        break;
      }
      case "TZ": throw new ToCharError("the to_char pattern TZ (the zone's abbreviation) is not supported: use OF for the offset");
      default: out += pattern;
    }
  }
  return out;
}

/** an integer a template's number is written from, which the engine reads from the value (src/duck/rewrite.ts `toChar`
 *  writes each): the year and the ISO year whole and in their last three, two and one digits, the month, the day of the
 *  month and of the year, the day of the ISO year, the day of the week (Sunday 0) and of the ISO week (Monday 1), the
 *  week of the month and of the year, the ISO week, the century, the Julian day, the quarter, the hour of 24 and of 12,
 *  the minute, the second and the second of the day */
export type NativeInt = "year" | "year3" | "year2" | "year1" | "isoyear" | "isoyear3" | "isoyear2" | "isoyear1" | "month" | "day" | "doy" | "isoyday"
  | "dow" | "isodow" | "monthweek" | "yearweek" | "isoweek" | "century" | "julian" | "quarter" | "hour" | "hour12" | "minute" | "second" | "daysecond";

/** one piece of the text a template writes, in a form the engine computes natively (issue 464) */
export type NativePiece =
  /** written as it is */
  | { kind: "text"; text: string }
  /** a strftime specifier: DuckDB's own text of the value */
  | { kind: "spec"; spec: string }
  /** a number, zero-padded to `width` digits (0: as it is) */
  | { kind: "number"; of: NativeInt; width: number }
  /** a number's ordinal suffix (TH: ST, ND, RD, TH; th: st, nd, rd, th) */
  | { kind: "ordinal"; of: NativeInt; upper: boolean }
  /** an English name of strftime's (`%B` the month's, `%A` the day's, `%b` / `%a` their first three letters) in upper or
   *  lower case, padded with spaces to `pad` characters (0: not padded) */
  | { kind: "name"; spec: "%B" | "%A" | "%b" | "%a"; letters: "as" | "upper" | "lower"; pad: number }
  /** `am` before noon, `pm` from noon */
  | { kind: "meridiem"; am: string; pm: string }
  /** the month in Roman numerals, padded with spaces to `pad` characters */
  | { kind: "roman"; lower: boolean; pad: number }
  /** the first `digits` digits of the six of the microsecond */
  | { kind: "fraction"; digits: number }
  /** the year with a comma after its thousands (`Y,YYY`) */
  | { kind: "thousands" };

/** the number patterns, as `toCharTime` writes them for a year 1 to 9999 AD (their lower case writes the same): the integer, its
 *  width, the strftime specifier that writes it padded and the one that writes it unpadded (FM), where one does. A
 *  pattern of the time of day is a time's only: a date's would be the midnight of a zone, which a day of daylight saving
 *  may not have */
const NUMBERS: ReadonlyMap<string, { of: NativeInt; width: number; spec?: string; fm?: string; time?: true }> = new Map([
  ["YYYY", { of: "year", width: 4, spec: "%Y" }], ["YYY", { of: "year3", width: 3 }], ["YY", { of: "year2", width: 2, spec: "%y", fm: "%-y" }], ["Y", { of: "year1", width: 1 }],
  ["IYYY", { of: "isoyear", width: 4, spec: "%G" }], ["IYY", { of: "isoyear3", width: 3 }], ["IY", { of: "isoyear2", width: 2 }], ["I", { of: "isoyear1", width: 1 }],
  ["MM", { of: "month", width: 2, spec: "%m", fm: "%-m" }], ["DD", { of: "day", width: 2, spec: "%d", fm: "%-d" }], ["DDD", { of: "doy", width: 3, spec: "%j", fm: "%-j" }],
  ["IDDD", { of: "isoyday", width: 3 }], ["D", { of: "dow", width: 1 }], ["ID", { of: "isodow", width: 1, spec: "%u", fm: "%u" }],
  ["W", { of: "monthweek", width: 1 }], ["WW", { of: "yearweek", width: 2 }], ["IW", { of: "isoweek", width: 2, spec: "%V" }],
  ["CC", { of: "century", width: 2 }], ["J", { of: "julian", width: 0 }], ["Q", { of: "quarter", width: 0 }],
  ["HH", { of: "hour12", width: 2, spec: "%I", fm: "%-I", time: true }], ["HH12", { of: "hour12", width: 2, spec: "%I", fm: "%-I", time: true }],
  ["HH24", { of: "hour", width: 2, spec: "%H", fm: "%-H", time: true }], ["MI", { of: "minute", width: 2, spec: "%M", fm: "%-M", time: true }],
  ["SS", { of: "second", width: 2, spec: "%S", fm: "%-S", time: true }], ["SSSS", { of: "daysecond", width: 0, time: true }], ["SSSSS", { of: "daysecond", width: 0, time: true }],
]);

/** the named patterns: strftime's name, and whether it is padded to nine unless FM (a three-letter name never is) */
const NAMES: ReadonlyMap<string, { spec: "%B" | "%A" | "%b" | "%a"; pad: number }> = new Map([
  ["MONTH", { spec: "%B", pad: 9 }], ["DAY", { spec: "%A", pad: 9 }], ["MON", { spec: "%b", pad: 0 }], ["DY", { spec: "%a", pad: 0 }],
]);

/**
 * The pieces that write `toCharTime(text, fmt)` natively for every value whose year is 1 to 9999 AD, or null where they
 * are not proven to (issue 464: the function a row was ×8–18 of Postgres for a grouped month, ×8 for a quarter or a padded
 * month's name). The template is read as `toCharTime` reads it — its prefixes, its quoted literals, its patterns longest
 * first. Each number, name, meridiem, era, Roman month and fraction is written as Postgres writes it in each case and
 * under FM, and a number's TH / th as its ordinal. What stays the function's: TM (a translated name) and FX, a zone's
 * TZ, TZH, TZM and OF, SP, TH on a pattern that is not a whole number (a name, a meridiem, an era, a Roman month, a
 * fraction), FM before a literal, and a backslash. `date` is whether the value is a date (no pattern of the time of
 * day then). A template that writes nothing is null too: DuckDB refuses an empty strftime format as it binds the
 * statement, whichever rows reach it (the review of PR 955).
 */
export function nativeTemplate(fmt: string, date: boolean): NativePiece[] | null {
  const out: NativePiece[] = [];
  let i = 0;
  while (i < fmt.length) {
    // one prefix an item, as `toCharTime` reads it
    let fm = false;
    if (fmt.startsWith("FM", i) || fmt.startsWith("fm", i)) { fm = true; i += 2; }
    if (fmt.startsWith("TM", i) || fmt.startsWith("tm", i) || fmt.startsWith("FX", i) || fmt.startsWith("fx", i)) return null;
    if (i >= fmt.length) break;
    const c = fmt[i]!;
    if (c === "\\") return null;
    if (c === '"') {
      if (fm) return null;
      i++;
      let text = "";
      while (i < fmt.length && fmt[i] !== '"') { if (fmt[i] === "\\") return null; text += fmt[i]!; i++; }
      i++;
      out.push({ kind: "text", text });
      continue;
    }
    const pattern = TIME_PATTERNS.find((p) => fmt.startsWith(p, i));
    if (pattern === undefined) { if (fm) return null; out.push({ kind: "text", text: c }); i++; continue; }
    i += pattern.length;
    const th = fmt.startsWith("TH", i) ? "TH" : fmt.startsWith("th", i) ? "th" : null;
    if (th !== null) i += 2;
    if (fmt.startsWith("SP", i) || fmt.startsWith("sp", i)) return null;
    const P = pattern.toUpperCase();
    const upper = pattern === P;
    const number = NUMBERS.get(P);
    if (number !== undefined) {
      if (number.time === true && date) return null;
      const spec = fm ? number.fm : number.spec;
      if (spec !== undefined) out.push({ kind: "spec", spec });
      else out.push({ kind: "number", of: number.of, width: fm || number.width < 2 ? 0 : number.width });
      if (th !== null) out.push({ kind: "ordinal", of: number.of, upper: th === "TH" });
      continue;
    }
    // the ordinal of Y,YYY is the whole year's
    if (P === "Y,YYY") { out.push({ kind: "thousands" }); if (th !== null) out.push({ kind: "ordinal", of: "year", upper: th === "TH" }); continue; }
    if (th !== null) return null;
    const name = NAMES.get(P);
    if (name !== undefined) {
      // a pattern's case is the name's: MONTH, Month, month
      const letters = upper ? "upper" : pattern[0] === P[0] ? "as" : "lower";
      const pad = fm ? 0 : name.pad;
      out.push(letters === "as" && pad === 0 ? { kind: "spec", spec: name.spec } : { kind: "name", spec: name.spec, letters, pad });
      continue;
    }
    switch (P) {
      case "AM": case "PM": if (date) return null; out.push(upper ? { kind: "spec", spec: "%p" } : { kind: "meridiem", am: "am", pm: "pm" }); continue;
      case "A.M.": case "P.M.": if (date) return null; out.push(upper ? { kind: "meridiem", am: "A.M.", pm: "P.M." } : { kind: "meridiem", am: "a.m.", pm: "p.m." }); continue;
      // every year the pieces write is AD
      case "AD": case "BC": out.push({ kind: "text", text: upper ? "AD" : "ad" }); continue;
      case "A.D.": case "B.C.": out.push({ kind: "text", text: upper ? "A.D." : "a.d." }); continue;
      case "RM": out.push({ kind: "roman", lower: !upper, pad: fm ? 0 : 4 }); continue;
      case "MS": case "US": case "FF1": case "FF2": case "FF3": case "FF4": case "FF5": case "FF6": {
        // zero-padded under FM too
        if (date) return null;
        const digits = P === "MS" ? 3 : P === "US" ? 6 : Number(P[2]);
        out.push(digits === 3 ? { kind: "spec", spec: "%g" } : digits === 6 ? { kind: "spec", spec: "%f" } : { kind: "fraction", digits });
        continue;
      }
      default: return null;
    }
  }
  return out.some((p) => p.kind !== "text" || p.text !== "") ? out : null;
}

// ------------------------------------------------------------------------------------------------- numbers

/** a decimal text rounded half away from zero to `scale` decimals: its sign, integer digits and fraction digits */
function roundDecimal(text: string, scale: number): { neg: boolean; int: string; frac: string } {
  const m = /^\s*([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?\s*$/.exec(text);
  if (m === null) {
    if (/^\s*-?inf/i.test(text) || /^\s*nan/i.test(text)) throw new ToCharError(`to_char of ${text.trim()} is not supported`);
    throw new ToCharError(`to_char cannot read the number ${JSON.stringify(text)}: report it (Mason)`);
  }
  let digits = `${m[2] ?? ""}${m[3] ?? ""}`;
  let point = (m[2] ?? "").length + Number(m[4] ?? 0);
  if (point < 0) { digits = "0".repeat(-point) + digits; point = 0; }
  if (point > digits.length) digits = digits.padEnd(point, "0");
  const keep = point + scale;
  let kept = digits.slice(0, Math.max(0, keep)).padEnd(Math.max(0, keep), "0");
  if (keep >= 0 && Number(digits[keep] ?? "0") >= 5) {
    // carry the rounding up through the kept digits
    const arr = kept.split("");
    let k = arr.length - 1;
    for (; k >= 0; k--) { if (arr[k] === "9") arr[k] = "0"; else { arr[k] = String(Number(arr[k]) + 1); break; } }
    kept = (k < 0 ? "1" : "") + arr.join("");
    if (k < 0) point++;
  }
  const int = kept.slice(0, kept.length - scale).replace(/^0+/, "");
  const frac = scale > 0 ? kept.slice(kept.length - scale) : "";
  const neg = m[1] === "-" && /[1-9]/.test(int + frac);
  return { neg, int, frac };
}

type NumToken = { t: "9" | "0" | "." | "," | "S" | "MI" | "PL" | "SG" | "PR" | "lit"; text: string };

/** to_char(number, fmt): `text` is the number's decimal text */
export function toCharNumber(text: string, fmt: string): string {
  const tokens: NumToken[] = [];
  let fm = false, i = 0;
  while (i < fmt.length) {
    const rest = fmt.slice(i);
    const word = ["FM", "fm", "MI", "mi", "PL", "pl", "SG", "sg", "PR", "pr", "EEEE", "eeee", "RN", "rn", "TH", "th", "V", "v", "S", "s", "D", "d", "G", "g", "B", "b", "L", "l"].find((w) => rest.startsWith(w));
    if (word === "FM" || word === "fm") { fm = true; i += 2; continue; }
    const W = word?.toUpperCase();
    if (W === "EEEE" || W === "RN" || W === "TH" || W === "V" || W === "B" || W === "L") throw new ToCharError(`the to_char number pattern ${W} is not supported`);
    if (W === "MI" || W === "PL" || W === "SG" || W === "PR" || W === "S") { tokens.push({ t: W, text: W }); i += W.length; continue; }
    if (W === "D") { tokens.push({ t: ".", text: "." }); i++; continue; }
    if (W === "G") { tokens.push({ t: ",", text: "," }); i++; continue; }
    const c = fmt[i]!;
    if (c === "9" || c === "0" || c === "." || c === ",") { tokens.push({ t: c, text: c }); i++; continue; }
    if (c === '"') { i++; let lit = ""; while (i < fmt.length && fmt[i] !== '"') { if (fmt[i] === "\\") i++; lit += fmt[i] ?? ""; i++; } i++; tokens.push({ t: "lit", text: lit }); continue; }
    tokens.push({ t: "lit", text: c }); i++;
  }
  const pointAt = tokens.findIndex((x) => x.t === ".");
  const intTokens = pointAt < 0 ? tokens : tokens.slice(0, pointAt);
  const fracTokens = pointAt < 0 ? [] : tokens.slice(pointAt + 1);
  const intDigits = intTokens.filter((x) => x.t === "9" || x.t === "0").length;
  const fracDigits = fracTokens.filter((x) => x.t === "9" || x.t === "0").length;
  const { neg, int, frac } = roundDecimal(text, fracDigits);
  // the first `0` of the integer part prints every digit place after it, zero or not
  const firstZero = intTokens.findIndex((x) => x.t === "0");
  const digitPlaces = intTokens.map((x, k) => x.t === "9" || x.t === "0" ? k : -1).filter((k) => k >= 0);
  const zeroFrom = firstZero < 0 ? Infinity : digitPlaces.indexOf(firstZero);
  // a value with no integer digits shows its 0 only in the last place, and only without a fraction place (Postgres:
  // to_char(0, '999') is '0', to_char(0.5, '9.99') is ' .50')
  const intText = int === "" && pointAt < 0 ? "0" : int;
  const overflow = intText.length > intDigits;
  const padded = intText.padStart(intDigits, " ");
  const firstDigit = tokens.findIndex((x) => x.t === "9" || x.t === "0");
  const sTrailing = tokens.some((x, k) => x.t === "S" && k > firstDigit && firstDigit >= 0);
  const has = (t: NumToken["t"]): boolean => tokens.some((x) => x.t === t);
  // the fixed-place signs (SG, MI, PL, a trailing S) are written where the template has them; a placeholder until then
  const fixed = (t: NumToken["t"]): string => {
    switch (t) {
      case "SG": return neg ? "-" : "+";
      case "MI": return neg ? "-" : fm ? "" : " ";
      case "PL": return neg ? (fm ? "" : " ") : "+";
      case "S": return sTrailing ? (neg ? "-" : "+") : "";
      default: return "";
    }
  };
  let body = "", place = 0, started = false;
  for (const x of intTokens) {
    if (x.t === "9" || x.t === "0") {
      let ch = overflow ? "#" : padded[place]!;
      if (ch === " " && place >= zeroFrom) ch = "0";
      if (ch !== " ") started = true;
      // fill mode writes no padding at all (a blank a digit place would have held)
      if (!(fm && ch === " ")) body += ch;
      place++;
    } else if (x.t === ",") body += started ? "," : fm ? "" : " ";
    else if (x.t === "lit") body += x.text;
    else body += fixed(x.t);
  }
  if (pointAt >= 0) {
    let fraction = "", fp = 0;
    const places: Array<"9" | "0"> = [];
    for (const x of fracTokens) {
      if (x.t === "9" || x.t === "0") { fraction += overflow ? "#" : frac[fp] ?? "0"; places.push(x.t); fp++; }
      else if (x.t === ",") fraction += ",";
      else if (x.t === "lit") fraction += x.text;
      else fraction += `\u0000${fixed(x.t)}\u0000`;
    }
    if (fm && !overflow) {
      // fill mode drops the trailing zeros of the 9 places after the point
      let cut = 0;
      for (let k = places.length - 1; k >= 0 && places[k] === "9" && frac[k] === "0"; k--) cut++;
      for (let removed = 0, k = fraction.length - 1; removed < cut && k >= 0; k--) {
        if (/\d/.test(fraction[k]!)) { fraction = fraction.slice(0, k) + fraction.slice(k + 1); removed++; }
      }
      // a value with no digit left is written 0 before the point (to_char(0, 'FM9.99') is `0.`)
      if (!/\d/.test(body + fraction)) body = `${body.replace(/ +$/, "")}0`;
    }
    body += `.${fraction.replace(/\u0000/g, "")}`;
  }
  // the floating sign: just before the number's first digit, point or # (after the padding blanks and any text before
  // it) — the default's (a blank for a positive number), a leading S's (+ or -), PR's < (a blank for a positive number)
  const pr = has("PR");
  const floating = pr ? (neg ? "<" : fm ? "" : " ")
    : has("S") && !sTrailing ? (neg ? "-" : "+")
    : !has("S") && !has("SG") && !has("MI") ? (neg ? "-" : fm ? "" : " ")
    : "";
  const lead = Math.max(0, body.search(/[0-9#.]/));
  let out = `${body.slice(0, lead)}${floating}${body.slice(lead)}`;
  if (pr) out += neg ? ">" : fm ? "" : " ";
  return out;
}
