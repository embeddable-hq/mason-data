/**
 * A DATE AND TIME UNIT, READ AS POSTGRES READS IT (issue 1167, src/duck/units.ts): every spelling of Postgres 18's own
 * tables (tests/integration/oracle/unit-spellings.ts, copied from its datetime.c) read into its unit, a spelling a
 * table matches by its first ten characters or in another case too; each function's refusal of a unit a type does not
 * have, or of a spelling no table holds, in Postgres's SQLSTATE and words. The answers under each spelling are the
 * oracle's (oracle/type-matrix.ts `unitSpellings`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callUnit, readUnit } from "../src/duck/units.ts";
import { ALSO_READ, DATETKTBL, DELTATKTBL, DTK } from "./integration/oracle/unit-spellings.ts";

const DATE = 1082, TIMESTAMP = 1114, TIMESTAMPTZ = 1184, TIME = 1083, INTERVAL = 1186;

test("every spelling in Postgres's tables is read as its unit, deltatktbl's before datetktbl's", () => {
  const delta = new Set<string>();
  for (const [token, type, dtk] of DELTATKTBL) {
    delta.add(token);
    const read = readUnit(token);
    if (type === "UNITS") assert.deepEqual([read.unit, read.table], [DTK[dtk!], "delta"], token);
    else assert.deepEqual([read.unit, read.table], [null, null], `${token}: no unit`);
  }
  for (const [token, type, dtk] of DATETKTBL) {
    if (delta.has(token)) continue;
    const read = readUnit(token);
    if (dtk !== null) assert.deepEqual([read.unit, read.table], [DTK[dtk], "special"], token);
    else assert.deepEqual([read.unit, read.table], [null, type === "RESERV" ? "reserved" : null], `${token}: reserved`);
  }
  // `m` is a minute and `mon` a month (deltatktbl's), never datetktbl's month and Monday; `dec` a decade, not December
  assert.equal(readUnit("m").unit, "minute");
  assert.equal(readUnit("mon").unit, "month");
  assert.equal(readUnit("dec").unit, "decade");
});

test("a token of ten characters reads every spelling it begins; the unit is lowercased, never trimmed", () => {
  for (const [token, dtk] of ALSO_READ) assert.equal(readUnit(token).unit, DTK[dtk], token);
  assert.equal(readUnit("microsecondsxyz").unit, "microseconds");
  assert.equal(readUnit("TIMEZONE_HOURS").unit, "timezone_hour");
  // a token shorter than ten matches itself alone
  for (const s of ["seconds2", "secss", "yearz", "isoyears", "quarters", "millenium", " second", "second ", "é"]) assert.equal(readUnit(s).unit, null, s);
  assert.equal(readUnit("SECONDS").low, "seconds");
  // the ASCII letters alone are lowercased, and the unit is cut to 63 bytes, on a character's boundary
  assert.equal(readUnit("ÉPOCH").low, "Époch");
  assert.equal(readUnit("x".repeat(80)).low, "x".repeat(63));
  assert.equal(readUnit(`${"x".repeat(62)}é`).low, "x".repeat(62));
});

test("each call refuses a unit its type has not, and a spelling no table holds, as Postgres 18 does", () => {
  const refusal = (call: "extract" | "date_part" | "date_trunc", text: string, type: number): string => {
    const r = callUnit(call, text, type);
    return r === null ? "null" : "code" in r ? `${r.code} ${r.message}` : r.unit;
  };
  // every spelling of a unit is its one name
  assert.equal(refusal("date_part", "secs", TIMESTAMP), "second");
  assert.equal(refusal("extract", "MSEC", TIMESTAMPTZ), "milliseconds");
  assert.equal(refusal("date_trunc", "hrs", TIMESTAMPTZ), "hour");
  assert.equal(refusal("extract", "mm", TIME), "minute");
  // date_part of a date is the timestamp's (a SQL function that casts it); extract of a date is the date's own
  assert.equal(refusal("date_part", "hour", DATE), "hour");
  assert.equal(refusal("date_part", "timezone", DATE), `0A000 unit "timezone" not supported for type timestamp without time zone`);
  assert.equal(refusal("extract", "h", DATE), `0A000 unit "h" not supported for type date`);
  assert.equal(refusal("extract", "Seconds", DATE), `0A000 unit "seconds" not supported for type date`);
  // a time has the time of day and the epoch, an interval no day of the week or Julian day
  assert.equal(refusal("date_part", "cent", TIME), `0A000 unit "cent" not supported for type time without time zone`);
  assert.equal(refusal("extract", "jd", INTERVAL), `0A000 unit "jd" not supported for type interval`);
  // a reserved word is a unit no timestamp or date has, and one a time or an interval does not know
  assert.equal(refusal("date_part", "infinity", TIMESTAMP), `0A000 unit "infinity" not supported for type timestamp without time zone`);
  assert.equal(refusal("extract", "now", DATE), `0A000 unit "now" not supported for type date`);
  assert.equal(refusal("date_part", "infinity", TIME), `22023 unit "infinity" not recognized for type time without time zone`);
  assert.equal(refusal("extract", "today", INTERVAL), `22023 unit "today" not recognized for type interval`);
  assert.equal(refusal("extract", " second", TIMESTAMPTZ), `22023 unit " second" not recognized for type timestamp with time zone`);
  assert.equal(refusal("date_part", "Jan", TIMESTAMP), `22023 unit "jan" not recognized for type timestamp without time zone`);
  // date_trunc reads deltatktbl alone: the epoch, a day of the week, `mm` and a Julian day are spellings it does not know
  for (const s of ["epoch", "dow", "isoyear", "mm", "j", "infinity", "foo"]) assert.equal(refusal("date_trunc", s, TIMESTAMP), `22023 unit "${s}" not recognized for type timestamp without time zone`, s);
  assert.equal(refusal("date_trunc", "timezone_m", TIMESTAMPTZ), `0A000 unit "timezone_m" not supported for type timestamp with time zone`);
  assert.equal(refusal("date_trunc", "weeks", INTERVAL), `0A000 unit "weeks" not supported for type interval`);
  assert.equal(refusal("date_trunc", "w", TIMESTAMP), "week");
  // PR 1106: a timestamp's zone unit is refused of a finite value alone (NULL of an infinity), date_part of a date's
  // too; no other refusal is
  const finiteOnly = (call: "extract" | "date_part" | "date_trunc", text: string, type: number): boolean | null => {
    const r = callUnit(call, text, type);
    return r !== null && "code" in r ? r.finiteOnly : null;
  };
  assert.equal(finiteOnly("date_part", "timezone", TIMESTAMP), true);
  assert.equal(finiteOnly("extract", "timezone_h", TIMESTAMP), true);
  assert.equal(finiteOnly("date_part", "timezone_m", DATE), true);
  assert.equal(finiteOnly("extract", "timezone", DATE), false);
  assert.equal(finiteOnly("date_part", "now", TIMESTAMP), false);
  assert.equal(finiteOnly("date_trunc", "timezone", TIMESTAMP), false);
  assert.equal(finiteOnly("extract", "day", TIME), false);
  // a type none of them takes is left to the call's own rules
  assert.equal(refusal("date_part", "second", 25), "null");
  assert.equal(refusal("date_trunc", "second", DATE), "null");
});
