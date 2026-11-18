/**
 * A TIMESTAMPTZ'S 15-MINUTE BUCKET (issue 1146; docs/DESIGN.md "A time's 15-minute bucket"). A dashboard groups by the
 * month, week, day or hour of a time in the session's zone, and working out each row's local month costs more than
 * reading the row (ICU's calendar, about 45 ns a row; 96.3 s against 39.8 s in UTC at 100 M orders, 10 clients). Every
 * zone the engine knows has been offset from UTC by a multiple of 15 minutes since 1980-01-01, and all but a few
 * (`OFF_BOUNDARY_ZONES`) have changed their offset only on a 15-minute boundary of UTC since then
 * (tests/duck-bucket-zones.test.ts holds both over every zone). So in every other zone each local hour, day, week, month,
 * quarter and year since then begins on a 15-minute boundary of UTC, and the 15 minutes of UTC a row is in decide its
 * local unit.
 *
 * So beside each timestamptz column the copy holds one more, hidden, an INTEGER a row: the 15 minutes of UTC its value
 * is in (`epoch / 900 s`). A GROUP BY of `date_trunc(unit, x)` then groups by the bucket first, a few hundred thousand
 * groups, and works out each bucket's local unit once (src/duck/bucket-group.ts). The bucket is NULL for a NULL, an
 * infinite value, a value before 1980-01-01 UTC and one from year 10000 on, and such a row is truncated as before.
 *
 * The one module that names the hidden column and computes its value, in the engine (`bucketSql`: the copy's chunks, the
 * poll's stage, the stream's rows).
 */
import { createHash } from "node:crypto";

/** a bucket's length: 15 minutes, in seconds and in microseconds */
export const BUCKET_SECONDS = 900;
export const BUCKET_MICROS = 900_000_000;
/** the first instant a bucket is held for: 1980-01-01 00:00 UTC, in microseconds from the epoch. Before it some zones
 *  were offset by other than 15 minutes (the last, Pacific/Kiritimati's -10:40, ended 1979-10-01) */
export const BUCKET_FROM_MICROS = 315_532_800_000_000;
/** the first instant no bucket is held for: year 10000, so every bucket is an INTEGER */
export const BUCKET_UNTIL_MICROS = 253_402_300_800_000_000;

/**
 * THE ZONES WHOSE BUCKET DOES NOT DECIDE THEIR LOCAL UNITS: the zones the engine knows that changed their offset at an
 * instant off a 15-minute boundary of UTC since 1980 — each at a minute past midnight local time (America/St_Johns and
 * its names until 2011, America/Goose_Bay until 2011, America/Moncton until 2006, Asia/Gaza and Asia/Hebron in 2010 and
 * 2011, Antarctica/Casey until 2022). Around such a change one bucket holds two local hours, or two local days. A session
 * in one of them keeps the plan it had (src/duck/bucket-group.ts). Held to the engine's zone data by
 * tests/duck-bucket-zones.test.ts, every name the engine knows, in lower case as a session's zone is compared.
 */
export const OFF_BOUNDARY_ZONES: readonly string[] = ["america/goose_bay", "america/moncton", "america/st_johns", "antarctica/casey", "asia/gaza", "asia/hebron",
  "canada/newfoundland", "cnt"];

/** a source column whose copy holds its bucket: `format_type`'s timestamptz. A timestamp without a zone has none: its
 *  truncation is the engine's arithmetic on the value, the same in every session zone */
export const bucketed = (type: string): boolean => type === "timestamp with time zone";

/** the hidden column's name prefix */
export const BUCKET_PREFIX = "__mason_bucket_";
/** a hidden bucket column's name pattern: what tells its kind among the columns the copy's record does not name
 *  (src/duck/hidden-columns.ts), never alone whether a column is hidden — a source column may be named so */
export const BUCKET_RE = /^__mason_bucket_[0-9a-f]{12}$/;

/** the hidden column holding `column`'s bucket: its name hashed, so any column name gives one plain identifier, and
 *  hashed again with a count where the table (`columns`, the source's column names) holds a column of that name itself.
 *  Every reader computes it the same way from the same columns (the copy's own, as recorded) */
export function bucketColumn(column: string, columns: readonly string[]): string {
  // (compared as the engine compares names: case-insensitively)
  const taken = new Set(columns.map((c) => c.toLowerCase()));
  for (let n = 0; ; n++) {
    const name = `${BUCKET_PREFIX}${createHash("sha256").update(n === 0 ? column : `${column}\u0000${n}`).digest("hex").slice(0, 12)}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** the bucket of a timestamptz `ts` (a SQL expression of the engine's TIMESTAMPTZ), as the engine computes it: its
 *  microseconds from the epoch divided by a bucket's, for a value in [1980, 10000); NULL for anything else (NULL,
 *  ±infinity, whose `epoch_us` is NULL, and a value outside). Every value held is positive, so the engine's integer
 *  division, which truncates, is the floor */
export const bucketSql = (ts: string): string =>
  `CAST(CASE WHEN epoch_us(${ts}) >= ${BUCKET_FROM_MICROS} AND epoch_us(${ts}) < ${BUCKET_UNTIL_MICROS} THEN epoch_us(${ts}) // ${BUCKET_MICROS} END AS INTEGER)`;

/** how the listener tells the plan a column holds its buckets (`userTypes`, src/api/postgres/server.ts): this prefix,
 *  then the JSON of [schema, table, column, its hidden bucket column's name] (`bucketKey`, `bucketOf`) */
export const BUCKET_KEY = "bucket:";
export const bucketKey = (schema: string, table: string, column: string, hidden: string): string => `${BUCKET_KEY}${JSON.stringify([schema, table, column, hidden])}`;
/** a `bucketKey`'s parts, or null for any other key */
export function bucketOf(key: string): { schema: string; table: string; column: string; hidden: string } | null {
  if (!key.startsWith(BUCKET_KEY)) return null;
  const parts = JSON.parse(key.slice(BUCKET_KEY.length)) as unknown;
  if (!Array.isArray(parts) || parts.length !== 4 || !parts.every((x) => typeof x === "string")) return null;
  const [schema, table, column, hidden] = parts as [string, string, string, string];
  return { schema, table, column, hidden };
}
