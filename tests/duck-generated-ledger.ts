/**
 * WHAT THE PIECES OF tests/duck-generated*.test.ts SHARE beyond the world (tests/duck-generated-world.ts): the chains'
 * `scheduled`, stage 3's `ledger` and `overLedger`, and the reasons PR 202's review rounds hold a refusal to, and round 11's nodes, which round 12 reads too. Moved here
 * from tests/duck-generated.test.ts when issue 338 split it into files the unit shards can spread; each value is as it was.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type pg from "pg";
import { MASON_SCHEMA } from "../src/duck/store.ts";
import type { AddedTable } from "../src/duck/sync.ts";
import { built, served, withWorld } from "./duck-generated-world.ts";

export const scheduled = (sql: string, orderBy?: string): string => `kind: scheduled\ntarget_lag: 1s\nsql: ${sql}\n${orderBy === undefined ? "" : `order_by: ${orderBy}\n`}`;

// stage 3 (issue 175): a numeric, an enum and a citext stored as the engine answers them, as a copy of the column holds them
export const LEDGER_COLUMNS = [{ name: "id", type: "bigint" }, { name: "n", type: "integer" }, { name: "small", type: "smallint" }, { name: "amount", type: "numeric(12,2)" },
  { name: "big", type: "numeric" }, { name: "wide", type: "numeric(65,30)" }, { name: "mood", type: "mood", typeKind: "e" }, { name: "name", type: "citext" }].map((c) => ({ ...c, notNull: false, comment: null }));
export const ledger: AddedTable = { source: "public.ledger", schema: "public", table: "ledger", key: ["id"], columns: LEDGER_COLUMNS, foreignKeys: [], bytes: 0, rows: 4 };
export const LEDGER_SEED = [
  "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
  "CREATE TABLE public.ledger (id BIGINT, n INTEGER, small SMALLINT, amount DECIMAL(12,2), big DECIMAL(38,9), wide DECIMAL(38,2), mood mood, name VARCHAR)",
  "INSERT INTO public.ledger VALUES (1, 10, 1, 1.10, 12345678901234567890.123456789, 1.25, 'happy', 'Alice'), (9223372036854775806, 2147483647, 2, -2.50, -0.000000001, -0.50, 'sad', 'alice'), " +
    "(3, NULL, 3, NULL, NULL, NULL, 'ok', 'Bob'), (9223372036854775807, 2147483647, 32767, 4.00, 1.100000000, 2.00, 'sad', 'BOB')",
  `INSERT INTO ${MASON_SCHEMA}.copy_state VALUES ('public.ledger', 'copied', 4, 0, 1.0, now(), NULL, '${JSON.stringify(LEDGER_COLUMNS)}')`,
  `INSERT INTO ${MASON_SCHEMA}.poll_state (source, snapshot, polled_at, sync) VALUES ('public.ledger', '100:100:', now(), 'off')`,
];
export const NUMS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, amount, big FROM ledger\norder_by: id\n";
export const SUMS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT mood, sum(small) AS s2, sum(n) AS s4, sum(id) AS s8, sum(amount) AS sa, max(big) AS mb FROM ledger GROUP BY mood\n";
export const KINDS = "kind: scheduled\ntarget_lag: 1h\nsql: SELECT id, mood, name FROM ledger\n";
/** a world over `ledger`: the base made in a first world, the tables declared in the second, `use`d there and after a restart */
export async function overLedger(files: Record<string, string>, use: (w: Parameters<Parameters<typeof withWorld>[1]>[0], restarted: boolean) => Promise<void>, columns: readonly object[] = LEDGER_COLUMNS): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-generated-numeric-"));
  try {
    await withWorld({}, async (w) => { for (const sql of LEDGER_SEED) await w.store.writer.run(sql.replace(JSON.stringify(LEDGER_COLUMNS), JSON.stringify(columns))); }, { dir });
    // served, not built (#205): `use` queries each table over the wire at once
    await withWorld(files, async (w) => { for (const name of Object.keys(files)) await w.until(served(w.logged), `public.${name}`); await use(w, false); }, { dir, again: true, tables: [{ ...ledger, columns } as AddedTable] });
    await withWorld({}, async (w) => { for (const name of Object.keys(files)) assert.ok(built(w.status(`public.${name}`))); await use(w, true); }, { dir, again: true, tables: [{ ...ledger, columns } as AddedTable] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
export const typed = async (w: { client(): Promise<pg.Client> }, sql: string): Promise<{ fields: Array<[string, number, number]>; rows: unknown[][] }> => {
  const c = await w.client();
  try { const r = await c.query({ text: sql, rowMode: "array" }); return { fields: r.fields.map((f) => [f.name, f.dataTypeID, f.dataTypeModifier]), rows: r.rows }; } finally { await c.end(); }
};

export const VAR = (fn: string): RegExp => new RegExp(`^column x is a ${fn}, which Postgres computes as an exact numeric at decimals it picks`);
export const PER = (fn: string): RegExp => new RegExp(`^column x is a numeric whose decimals Postgres picks by the size of each value \\(${fn}\\)`);
export const PERFIX = (fn: string): RegExp => new RegExp(`^column x rounds or casts a numeric Postgres computes for each row at decimals it picks \\(${fn}\\)`);
export const TEXT = /^column x is a numeric read from text \(a JSON number's ->> cast to numeric\)/;
export const DIV = /^column x divides a numeric, which the engine computes as a double$/;
export const SCALE = (n: number): RegExp => new RegExp(`^column x has ${n} decimals, more than the 18`);
export const HELD = (n: number): RegExp => new RegExp(`^column x is computed at ${n} decimals on the way to its own`);
export const ROWS = /^column x sums values Postgres keeps at differing scales, so the rows decide its decimals$/;
export const PICKS = /^column x is whichever value a GREATEST, LEAST, COALESCE or CASE takes/;
export const DOUBLE = /^column x is a numeric cast from a double precision value/;

export const TEXT_JSON = /^column x is a numeric read from text \(a JSON number's ->> cast to numeric\), which keeps the decimals each value's text has$/;

export type R11Node = { fn: string; agg: boolean; sql: (x: string) => string; reason: (column: string, fixed: boolean) => RegExp };
export const R11_VARIANCE = (fn: string): R11Node => ({ fn, agg: true, sql: (x) => `${fn}(${x})`,
  reason: (c) => new RegExp(`^column ${c} is a ${fn}, which Postgres computes as an exact numeric at decimals it picks`) });
export const R11_DIVIDES = (fn: string, agg: boolean, sql: (x: string) => string): R11Node => ({ fn, agg, sql,
  reason: (c) => new RegExp(`^column ${c} divides a numeric, which the engine computes as a double$`) });
export const R11_PER_VALUE = (fn: string, sql: (x: string) => string): R11Node => ({ fn, agg: false, sql,
  reason: (c, fixed) => fixed ? new RegExp(`^column ${c} rounds or casts a numeric Postgres computes for each row at decimals it picks \\(${fn}\\)`)
    : new RegExp(`^column ${c} is a numeric whose decimals Postgres picks by the size of each value \\(${fn}\\)`) });
export const R11_NODES: R11Node[] = [
  ...["stddev", "stddev_samp", "stddev_pop", "variance", "var_samp", "var_pop"].map(R11_VARIANCE),
  R11_DIVIDES("avg", true, (x) => `avg(${x})`), R11_DIVIDES("quotient", false, (x) => `${x} / 3`),
  R11_PER_VALUE("sqrt", (x) => `sqrt(abs(${x}))`), R11_PER_VALUE("exp", (x) => `exp(${x})`), R11_PER_VALUE("ln", (x) => `ln(abs(${x}))`),
  R11_PER_VALUE("log", (x) => `log(abs(${x}))`), R11_PER_VALUE("power", (x) => `power(${x}, 2)`),
];
