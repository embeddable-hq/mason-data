/**
 * WHAT A TIME'S 15-MINUTE BUCKET RESTS ON, HELD TO THE ENGINE (issue 1146, src/duck/bucket-column.ts,
 * src/duck/bucket-group.ts), so an engine upgrade that changes it fails here by name:
 *  - every zone the engine knows has been offset from UTC by a multiple of 15 minutes since 1980-01-01 UTC, and all but
 *    the ones named (`OFF_BOUNDARY_ZONES`) have changed their offset only on a 15-minute boundary of UTC, so there the
 *    15 minutes of UTC a row is in decide its local hour, day, week, month, quarter and year (the zone data's own, ICU's,
 *    read through the engine's `timezone`);
 *  - every aggregate the engine has is named, so none is ever read as a row's value (`ENGINE_AGGREGATES`);
 *  - the bucket of each edge: NULL before 1980, from year 10000, for ±infinity and for NULL.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DuckStore } from "../src/duck/store.ts";
import { BUCKET_FROM_MICROS, BUCKET_SECONDS, bucketSql, OFF_BOUNDARY_ZONES } from "../src/duck/bucket-column.ts";
import { ENGINE_AGGREGATES } from "../src/duck/bucket-group.ts";
import { ZONE_NAMES } from "../src/lib/zone-names.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-bucket-zones-"));
let store: DuckStore;
before(async () => { store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined); });
after(async () => { await store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const rows = async (sql: string): Promise<unknown[][]> => (await store.writer.runAndReadAll(sql)).getRowsJS() as unknown[][];

test("every zone the engine knows is a multiple of 15 minutes from UTC since 1980, and all but the ones named change only on a 15-minute boundary", async () => {
  // the zones: the engine's own, and every name a session may set (src/lib/zone-names.ts) that the engine reads
  const known = new Set((await rows("SELECT name FROM pg_timezone_names()")).map((r) => String(r[0])));
  for (const z of ZONE_NAMES) {
    if (known.has(z)) continue;
    try { await store.writer.runAndReadAll(`SELECT timezone('${z.replaceAll("'", "''")}', TIMESTAMPTZ '2000-01-01 00:00:00+00')`); known.add(z); }
    // (a name the engine does not know is no zone a session reaches it in: SET TimeZone fails there first)
    catch (e) { if (!/Unknown TimeZone|time zone/i.test(String(e))) throw e; }
  }
  assert.ok(known.size > 500, `the engine knows ${known.size} zones`);
  // (a day and 15 minutes stepped in UTC: the engine adds an interval to a timestamptz in the session's zone)
  await store.writer.run("SET TimeZone = 'UTC'");
  await store.writer.run("CREATE TEMP TABLE zones (z VARCHAR)");
  await store.writer.run(`INSERT INTO zones VALUES ${[...known].map((z) => `('${z.replaceAll("'", "''")}')`).join(", ")}`);
  // each zone's offset (seconds) at each day's first instant, 1970 to 2040; then at each 15 minutes' first and last
  // microsecond of every day whose next day's offset differs: an offset that is no multiple of 15 minutes, or one that
  // changes inside 15 minutes of UTC, is an instant whose bucket does not decide its local units
  const offset = (t: string): string => `((epoch_us(timezone(z, ${t})) - epoch_us(${t})) // 1000000)`;
  await store.writer.run(`CREATE TEMP TABLE daily AS SELECT z, range AS t, ${offset("range")} AS o FROM zones, range(TIMESTAMPTZ '1970-01-01 00:00:00+00', TIMESTAMPTZ '2041-01-01 00:00:00+00', INTERVAL 1 DAY)`);
  const wrong = await rows(`
    WITH changed AS (SELECT z, t FROM (SELECT z, t, o, lead(o) OVER (PARTITION BY z ORDER BY t) AS next FROM daily) WHERE next <> o),
    quarters AS (SELECT c.z, q.range AS t FROM changed c, range(c.t, c.t + INTERVAL 1 DAY, INTERVAL 15 MINUTE) q),
    bad AS (
      SELECT z, t FROM daily WHERE o % ${BUCKET_SECONDS} <> 0
      UNION ALL SELECT z, t FROM quarters WHERE ${offset("t")} % ${BUCKET_SECONDS} <> 0 OR ${offset("t")} <> ${offset("t + INTERVAL 899999999 MICROSECOND")})
    SELECT z, max(t) AS last FROM bad GROUP BY z ORDER BY last DESC`);
  const cutoff = BUCKET_FROM_MICROS / 1000;
  const after1980 = wrong.filter(([, t]) => new Date(t as string | number | Date).getTime() >= cutoff);
  // a zone whose bucket is wrong since 1980 is named, and keeps its plan; no other is
  assert.deepEqual(after1980.map(([z]) => String(z).toLowerCase()).sort(), [...OFF_BOUNDARY_ZONES].sort(),
    `the zones whose bucket is wrong from 1980-01-01 UTC on: ${after1980.map(([z, t]) => `${String(z)} ${new Date(t as Date).toISOString()}`).join(", ")}`);
  // the check sees the exception it is drawn just after: Pacific/Kiritimati at -10:40 until 1979-10-01
  assert.ok(wrong.some(([z, t]) => z === "Pacific/Kiritimati" && new Date(t as Date).getUTCFullYear() === 1979), `Kiritimati's 1979 is seen: ${JSON.stringify(wrong.slice(0, 5))}`);
});

test("every aggregate the engine has, and every macro over one, is named in ENGINE_AGGREGATES", async () => {
  const aggregates = (await rows("SELECT DISTINCT function_name FROM duckdb_functions() WHERE function_type = 'aggregate'")).map((r) => String(r[0]));
  const names = aggregates.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const macros = (await rows(`SELECT DISTINCT function_name FROM duckdb_functions() WHERE function_type = 'macro' AND regexp_matches(macro_definition, '\\b(${names})\\(')`)).map((r) => String(r[0]));
  assert.deepEqual([...aggregates, ...macros].filter((n) => !ENGINE_AGGREGATES.has(n)).sort(), []);
});

test("a timestamptz's bucket: its 15 minutes of UTC from 1980 to year 10000, NULL anywhere else", async () => {
  const at = (v: string): string => `${bucketSql(`TIMESTAMPTZ '${v}'`)}`;
  const got = (await rows(`SELECT ${[
    "1979-12-31 23:59:59.999999+00", "1980-01-01 00:00:00+00", "1980-01-01 00:14:59.999999+00", "1980-01-01 00:15:00+00",
    "2024-03-31 01:00:00+00", "9999-12-31 23:59:59.999999+00", "infinity", "-infinity", "1880-06-15 12:00:30+00",
  ].map(at).join(", ")}, ${bucketSql("NULL::TIMESTAMPTZ")}`))[0];
  assert.deepEqual(got, [null, 350_592, 350_592, 350_593, 1_902_052, 281_558_111, null, null, null, null]);
});
