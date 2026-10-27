/**
 * TIME ZONES, as a request names them (`timezone: "Asia/Kolkata"`, issue #435: "today" or "per day" has to mean the
 * customer's day). An IANA name, checked against the zone names this product accepts, exactly as spelled
 * (src/lib/zone-names.ts) and the zones this runtime can do arithmetic in (`Intl`), and the calendar arithmetic a
 * range and a bucket need in it: the UTC instant of a local wall-clock time, and the local parts of an instant.
 *
 * Pure, and free of any dependency: the API's grammar, the fill and the SDK-side generator use it. The zone a
 * ClickHouse function takes is the same name, spliced only after `isZone` accepted it (the name is from a closed
 * set, so it cannot carry SQL).
 */
import { ZONE_NAMES } from "./zone-names.ts";

/** The name a request writes for UTC: no zone at all, as every bucket and range was before zones. */
export const UTC = "UTC";

const NAME_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/;
const known = new Map<string, boolean>();

/** Whether `z` is a zone of ZONE_NAMES as written AND this runtime can compute in: `Europe/London`, `Asia/Kolkata`,
 *  `UTC` — never `asia/kolkata` or `utc` (ZONE_NAMES is case-sensitive, `Intl` is not). */
export function isZone(z: unknown): z is string {
  if (typeof z !== "string" || !NAME_RE.test(z) || !ZONE_NAMES.has(z)) return false;
  let ok = known.get(z);
  if (ok === undefined) {
    try { new Intl.DateTimeFormat("en-US", { timeZone: z }); ok = true; }
    catch (err) {
      // the one way Intl says "no such zone": a RangeError; anything else is not a verdict on the name
      if (!(err instanceof RangeError)) throw err;
      ok = false;
    }
    known.set(z, ok);
  }
  return ok;
}

let lowered: Map<string, string> | undefined;
/** The zone as ZONE_NAMES spells it, from a name in any case (`utc`, `europe/london`: the review of #443 met a 400
 *  `unknown_timezone` for "utc"); null for a name no spelling of which is a zone. */
export function canonicalZone(z: unknown): string | null {
  if (typeof z !== "string") return null;
  const name: string = z;
  const exact: boolean = isZone(name);
  if (exact) return name;
  lowered ??= new Map([...ZONE_NAMES].map((n) => [n.toLowerCase(), n]));
  const c = lowered.get(name.toLowerCase());
  return c !== undefined && isZone(c) ? c : null;
}

/** UTC and its aliases, in any case: a zone that changes nothing. */
export const isUtc = (z: string): boolean => /^(UTC|Etc\/UTC|Etc\/GMT|GMT|Etc\/Universal|Universal|Zulu|Etc\/Zulu)$/i.test(z);

/**
 * THE ZONE OF A POSTGRES `AT TIME ZONE '<name>'`, as ClickHouse spells it, where Postgres and ClickHouse read the name
 * alike (Cube's zoned bucket): an Area/Location name (`Europe/London`, `America/Sao_Paulo`, in any case) or
 * a UTC alias. Postgres reads a name as a zone ABBREVIATION first (`CET` is a fixed +01 there, tzdata's `CET` keeps a
 * summer time; `EST`, `MST`, `EET`, `MET` likewise) and a POSIX string (`+02`, `<-03>+3`) with its own sign rule, so a
 * name of neither form is refused, never read as tzdata reads it. A name nobody knows is Postgres's own 22023.
 * The rewrite and the functions of the copy (src/duck/rewrite.ts, src/duck/functions.ts) read it here.
 */
export function atTimeZoneOf(name: string): { zone: string } | { problem: string; sqlstate: "22023" | "0A000" } {
  const zone = canonicalZone(name);
  const examples = "Europe/London, America/Sao_Paulo, UTC";
  // Postgres's abbreviations for UTC itself (offset 0, no summer time): UTC, whatever tzdata calls them
  if (/^(UT|Z|ZULU)$/i.test(name)) return { zone: UTC };
  if (isUtc(name) && zone !== null) return { zone };
  if (name.includes("/") && zone !== null) return { zone };
  if (zone !== null || /^[A-Za-z]{3,5}$/.test(name) || /^[<+\-0-9]/.test(name) || /^[A-Za-z]{3,}[+-]?\d/.test(name)) {
    return { problem: `time zone "${name}": Postgres reads a name without a "/" as an abbreviation or a POSIX zone first, with a fixed offset, where the IANA zone of that name may move; write an IANA name (${examples})`, sqlstate: "0A000" };
  }
  return { problem: `time zone "${name}" not recognized: write an IANA name (${examples})`, sqlstate: "22023" };
}

/** A few zones every app serves, for a message that lists choices. */
export const COMMON_ZONES = ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Australia/Adelaide"];

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(z: string): Intl.DateTimeFormat {
  let f = formatters.get(z);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: z, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(z, f);
  }
  return f;
}

/** The wall-clock parts of the instant `ms` in zone `z` (month 1-12; weekday 1 = Monday .. 7 = Sunday). */
export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number }
export function localParts(ms: number, z: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const p of formatter(z).formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  const { year, month, day, hour, minute, second } = parts as Record<string, number>;
  const weekday = ((new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay() + 6) % 7) + 1;
  return { year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second!, weekday };
}

/** The zone's offset from UTC at the instant `ms`, in SECONDS: a historic offset has them (Monrovia was −0:44:30 until
 *  1972, Amsterdam +0:19:32 until 1937), Intl keeps them and so does Postgres, so a reading of a time keeps them too. */
export function offsetSeconds(ms: number, z: string): number {
  const p = localParts(ms, z);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 1000);
}

/** The zone's offset from UTC at the instant `ms`, in whole minutes (Kolkata +330, New York -240 in summer): what the
 *  hour arithmetic of a range and a bucket reads, which is only asked in a zone a whole number of hours from UTC. */
export function offsetMinutes(ms: number, z: string): number {
  return Math.round(offsetSeconds(ms, z) / 60);
}

/**
 * The instants a wall clock (`wall`: its fields written as if UTC) could mean in `z`: `candidates`, one per offset the
 * zone has around the time (a zone changes at most once in three days), and `valid`, those of them at which the zone's
 * offset puts the clock there — one for an ordinary time, two in the hour a clock falls back over, none in the hour it
 * springs forward over.
 */
function readings(z: string, wall: number): { valid: number[]; candidates: number[] } {
  const offsets = new Set([offsetSeconds(wall - 129_600_000, z), offsetSeconds(wall, z), offsetSeconds(wall + 129_600_000, z)]);
  const candidates = [...offsets].map((o) => wall - o * 1000);
  return { valid: candidates.filter((t) => offsetSeconds(t, z) * 1000 === wall - t), candidates };
}

/**
 * The UTC instant of a local wall-clock TIME in zone `z`: the one reading of a time with no offset, as Postgres reads
 * `timestamp '…' AT TIME ZONE z` (an app's SQL is Postgres SQL, the Postgres API is held to Postgres, and the oracle
 * resolves every window bound there), on every path alike — the Postgres API's literals, and in the ClickHouse stack
 * this was cut from its HTTP API's ranges, buckets, fill and compare — to the second of a historic offset
 * (`offsetSeconds`: 1970-01-01 00:00 in Monrovia is 00:44:30Z, as Postgres has it). A time that does not exist there
 * (the hour a clock springs forward over) is moved forward by the gap (02:30 on a 02:00 -> 03:00 night is 03:30); a time that happens twice (the hour it falls back over)
 * is the LATER of the two, the offset in force after the change (2026-11-01 01:30 in New York is 06:30Z, 01:30 EST).
 * The doubled hour was once read at the offset in force at the wall clock taken as UTC: the earlier instant
 * west of UTC (05:30Z) and the later east of it, so the HTTP API and Postgres disagreed on the same body for every zone
 * west of UTC. ClickHouse's own `toDateTime64(text, 3, z)` reads the doubled hour as the EARLIER instant and moves a
 * gap BACK, so no path hands it a zone-less literal in a zone: every bound is resolved here and sent as an instant.
 * A DATE is not a time: its first instant is `dayStart`. Pinned against Postgres by the dashboard tests of the
 * ClickHouse stack this was cut from.
 * `ms` is the rest of the minute (seconds and fraction), which never changes which reading applies.
 */
export function utcOf(z: string, year: number, month: number, day: number, hour = 0, minute = 0, ms = 0): number {
  // AS POSTGRES READS IT (`DetermineTimeZoneOffset`, verified on Postgres 18.6), so the Postgres API reads a
  // wall-clock time with this one function too (it once had a twin, `postgresUtcOf`, written when this one
  // met a doubled time on whichever pass came first)
  const { valid, candidates } = readings(z, Date.UTC(year, month - 1, day, hour, minute) + ms);
  // twice: the later; never: the offset before the gap, which is also the later reading
  return Math.max(...(valid.length > 0 ? valid : candidates));
}

/**
 * The first instant of the local DATE in `z`: what a date bound (`{"from": "2026-11-01"}`), `today`, the edges of a
 * day, a week and a month, and a `.day` bucket's start mean. Its midnight; the EARLIER one where a clock falls back
 * over midnight (Havana, the Azores: the local date begins at the first 00:00, and a `.day` bucket — ClickHouse's
 * `toDate(col, z)`, Postgres's `(col AT TIME ZONE z)::date` — holds every row from it, so a range starting an hour
 * later would miss rows its own bucket holds; Postgres's `date::timestamptz` cast reads midnight as a wall-clock TIME,
 * the later one, which is why this is not `utcOf`); and the first instant after a midnight a clock skips (Santiago,
 * 2026-09-06: 01:00). Decided in the review of #495; that stack's oracle said it in Postgres's words.
 */
export function dayStart(z: string, year: number, month: number, day: number): number {
  const { valid, candidates } = readings(z, Date.UTC(year, month - 1, day));
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

const wholeHours = new Map<string, boolean>();
/**
 * Whether every offset `z` has had since 1970 and will have over the next two years is a whole number of hours, so a
 * UTC hour is a local hour there: what lets an hour stored in UTC be re-bucketed in the zone (Kolkata, +5:30, and
 * Adelaide, +9:30, are not). Since 1970, not a recent window: an `all_time` query reaches every stored hour, and
 * Caracas was −4:30 until 2016 (review of #443). Daily, so no half-hour season is stepped over; once per zone.
 */
export function isWholeHourZone(z: string, now = Date.now()): boolean {
  let ok = wholeHours.get(z);
  if (ok === undefined) {
    ok = true;
    for (let t = 0; t < now + 2 * 365 * 86_400_000; t += 86_400_000) {
      if (offsetMinutes(t, z) % 60 !== 0) { ok = false; break; }
    }
    wholeHours.set(z, ok);
  }
  return ok;
}

/** Why no time stored in UTC can be re-bucketed in `z`, or null when hours can: the finest grain anything stores is an
 *  hour, so a zone that is not a whole number of hours from UTC is answered from the table's own rows, never from storage.
 *  ONE sentence for the compiler's classification, its coverage and `mason status` (the hands-on review of #451). */
export function hourFoldProblem(z: string): string | null {
  return isWholeHourZone(z) ? null : `${z} is not a whole number of hours from UTC, so a stored UTC hour is not one of its hours`;
}

/** A change of a zone's offset: from the instant `at` on it is `after` minutes from UTC, where it was `before`. */
export interface OffsetChange { at: number; before: number; after: number }
const WEEK = 7 * 86_400_000;
/** The years a change is looked for in: the times a DateTime64 holds (1900 to 2299), as every range and row is. */
const FIRST_YEAR = 1900, LAST_YEAR = 2299;
const changesByYear = new Map<string, OffsetChange[]>();
/** A zone's changes in one UTC year: its offset read once a week, and a week it moved in bisected to the second.
 *  Once per zone and year. A change undone within the same week is not seen: the tz database has no such week. */
function changesInYear(z: string, year: number): OffsetChange[] {
  const key = `${z}\u0000${year}`;
  let out = changesByYear.get(key);
  if (out !== undefined) return out;
  out = [];
  const end = Date.UTC(year + 1, 0, 1);
  let t = Date.UTC(year, 0, 1), off = offsetMinutes(t, z);
  while (t < end) {
    const u = Math.min(t + WEEK, end);
    if (offsetMinutes(u, z) === off) { t = u; continue; }
    let lo = t, hi = u;
    while (hi - lo > 1000) { const mid = lo + Math.floor((hi - lo) / 2000) * 1000; if (offsetMinutes(mid, z) === off) lo = mid; else hi = mid; }
    const after = offsetMinutes(hi, z);
    out.push({ at: hi, before: off, after });
    t = hi; off = after;
  }
  changesByYear.set(key, out);
  return out;
}
/** The changes of `z`'s offset after `from` and before `to`, in order (none for UTC; none outside 1900 to 2299). */
export function offsetChanges(z: string, from: number, to: number): OffsetChange[] {
  if (isUtc(z) || !(to > from)) return [];
  const out: OffsetChange[] = [];
  const y0 = Math.max(FIRST_YEAR, new Date(Math.max(from, Date.UTC(FIRST_YEAR, 0, 1))).getUTCFullYear());
  const y1 = Math.min(LAST_YEAR, new Date(Math.min(to, Date.UTC(LAST_YEAR, 11, 31))).getUTCFullYear());
  for (let y = y0; y <= y1; y++) for (const c of changesInYear(z, y)) if (c.at > from && c.at < to) out.push(c);
  return out;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
/** A local date as the API writes a Date: `2026-09-01`. */
export const dateText = (y: number, m: number, d: number): string => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
/** An instant as ClickHouse's ISO output writes a DateTime: `2026-09-01T10:30:00Z`. */
export const instantText = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

