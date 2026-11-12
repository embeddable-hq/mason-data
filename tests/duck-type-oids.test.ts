/**
 * A TYPE THE SOURCE MADE IS SENT WITH THE CATALOG'S OWN OID (issue 861). The wire sends an enum's, a citext's and a
 * table's whole row's column with an OID, and a client names the column by looking that OID up in pg_type (JDBC's
 * getColumnTypeName, npgsql, asyncpg) or sends it back as a Parse's parameter type. The OID is the catalog's, which its
 * pg_type names: the source's OID for the type, which the wire once sent, is in the catalog another type or none, since
 * both count from 16384. Here that collision is FORCED: the source's OID counter is advanced (`lo_create`) until its
 * enums take the OIDs the catalog gives two tables' row types. Every lookup must name the source's type, every Parse
 * with an OID Mason sent must bind, pg_typeof must say what the source says, and a restart must keep the OIDs. The
 * source is a PGlite of its own (`truth`), whose answers are the expected ones.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import pg from "pg";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { DuckStore } from "../src/duck/store.ts";
import { startPostgresApi, type PgApiServer } from "../src/api/postgres/server.ts";
import { stopParser } from "../src/api/postgres/parser.ts";
import { mintToken, tokenProblem } from "../src/duck/token.ts";
import type { PgSchema } from "../src/api/postgres/schema.ts";
import type { BackendMessage } from "../src/api/postgres/protocol.ts";
import * as wire from "./postgres-api/wire.ts";

const API_KEY = "k".repeat(48);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-type-oids-"));
const truth = new PGlite({ extensions: { citext } });
let store: DuckStore;
let api: PgApiServer;
const logged: string[] = [];

const MOOD = ["sad", "ok", "happy"], LEVEL = ["low", "high"];
const DUCK_DDL = [
  `CREATE TYPE mood AS ENUM (${MOOD.map((l) => `'${l}'`).join(", ")})`,
  `CREATE TYPE level AS ENUM (${LEVEL.map((l) => `'${l}'`).join(", ")})`,
  "CREATE TABLE public.pad (id INTEGER)",
  "CREATE TABLE public.people (id INTEGER, name VARCHAR)",
  "INSERT INTO public.people VALUES (1, 'ann'), (2, 'bob')",
  "CREATE TABLE public.moods (id INTEGER, m mood, ms mood[], l level, c VARCHAR, cs VARCHAR[])",
  "INSERT INTO public.moods VALUES (1, 'happy', ['sad', 'ok'], 'high', 'Alice', ['A', 'b']), (2, 'sad', NULL, 'low', 'bob', NULL), (3, NULL, [], NULL, 'ALICE', [])",
];
/** the source's tables, in the source's order of creation (the enums first, each where its OID is forced) */
const SOURCE_TABLES = [
  "CREATE TABLE public.people (id integer PRIMARY KEY, name text)",
  "INSERT INTO public.people VALUES (1, 'ann'), (2, 'bob')",
  "CREATE TABLE public.moods (id integer PRIMARY KEY, m mood, ms mood[], l other.level, c citext, cs citext[])",
  "INSERT INTO public.moods VALUES (1, 'happy', '{sad,ok}', 'high', 'Alice', '{A,b}'), (2, 'sad', NULL, 'low', 'bob', NULL), (3, NULL, '{}', NULL, 'ALICE', '{}')",
];

/** the schema the copy records, every made type's OID the source's (`oids`) */
function schemaOf(oids: Record<string, number | undefined>): PgSchema {
  return {
    database: "app",
    tables: [
      // a table the catalog makes first, so its row types come later than the source's counter after citext
      { name: "pad", primaryKey: ["id"], joins: [], columns: [{ name: "id", type: "int4" }] },
      { name: "people", primaryKey: ["id"], joins: [], rowTypeOid: oids.people, columns: [{ name: "id", type: "int4" }, { name: "name", type: "text" }] },
      { name: "moods", primaryKey: ["id"], joins: [], rowTypeOid: oids.moods, columns: [{ name: "id", type: "int4" },
        { name: "m", type: "text", spelled: "mood", enumLabels: MOOD, typeOid: oids.mood, typeArrayOid: oids._mood },
        { name: "ms", type: "text", spelled: "mood[]", enumLabels: MOOD, typeOid: oids._mood },
        { name: "l", type: "text", spelled: "other.level", enumLabels: LEVEL, typeOid: oids.level, typeArrayOid: oids._level },
        { name: "c", type: "text", spelled: "citext", typeOid: oids.citext, typeArrayOid: oids._citext },
        { name: "cs", type: "text", spelled: "citext[]", typeOid: oids._citext }] },
    ],
  };
}

async function listen(schema: PgSchema): Promise<PgApiServer> {
  return startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: "app", masonVersion: "test", product: "mason-data",
    authenticate: (password) => { const p = tokenProblem(API_KEY, password); if (p !== null) throw new Error(p); return { filters: [], subject: undefined }; },
    schema: () => schema, record: () => undefined, log: (l) => { logged.push(l); },
    duck: await store.listener(undefined, undefined, undefined, () => []),
  });
}

const connect = async (on: PgApiServer): Promise<pg.Client> => {
  const c = new pg.Client({ host: "127.0.0.1", port: on.port, database: "app", user: "mason", password: mintToken(API_KEY, 600).token });
  await c.connect();
  return c;
};
const asText = { getTypeParser: () => (v: string) => v };
async function mason(sql: string): Promise<{ oids: number[]; rows: unknown[][] }> {
  const c = await connect(api);
  try {
    const r = await c.query({ text: sql, rowMode: "array", types: asText } as pg.QueryConfig);
    return { oids: r.fields.map((f) => f.dataTypeID), rows: r.rows as unknown[][] };
  } finally { await c.end(); }
}
async function source(sql: string): Promise<{ oids: number[]; rows: unknown[][] }> {
  const r = await truth.query<unknown[]>(sql, [], { rowMode: "array", parsers: Object.fromEntries([16, 20, 21, 23, 25, 26].map((o) => [o, (v: string) => v])) });
  return { oids: r.fields.map((f) => f.dataTypeID), rows: r.rows };
}
const one = async (sql: string): Promise<number> => Number((await truth.query<{ o: number }>(sql)).rows[0]!.o);

/** the source's OIDs, as the copy records them (src/cli/preflight.ts) */
let oids: Record<string, number> = {};

before(async () => {
  store = await DuckStore.open(path.join(dir, "duck.db"), () => undefined);
  for (const s of DUCK_DDL) await store.writer.run(s);
  // the catalog's row types of people and moods, as it makes them over this schema (the same whatever the source's OIDs)
  const far = { people: 900020, moods: 900021, mood: 900001, _mood: 900000, level: 900003, _level: 900002, citext: 900005, _citext: 900004 };
  api = await listen(schemaOf(far));
  const rowTypes = Object.fromEntries((await mason("SELECT typname::text, oid::int FROM pg_catalog.pg_type WHERE typrelid IN ('people'::regclass, 'moods'::regclass)")).rows.map((r) => [r[0], Number(r[1])]));
  await api.close();
  // the source: citext and the schema first, then its OID counter advanced so that each enum takes a catalog row type's
  // OID (an enum's array type is allocated first, the type the next)
  await truth.exec("SET TimeZone = 'UTC'; CREATE EXTENSION citext; CREATE SCHEMA other");
  const advanceTo = async (next: number): Promise<void> => {
    for (;;) {
      const got = await one("SELECT lo_create(0)::int8 AS o");
      assert.ok(got <= next - 1, `the source's counter (${got}) is already past ${next}: the collision cannot be forced`);
      if (got === next - 1) return;
    }
  };
  await advanceTo(rowTypes.people! - 1);
  await truth.exec(`CREATE TYPE public.mood AS ENUM (${MOOD.map((l) => `'${l}'`).join(", ")})`);
  await advanceTo(rowTypes.moods! - 1);
  await truth.exec(`CREATE TYPE other.level AS ENUM (${LEVEL.map((l) => `'${l}'`).join(", ")})`);
  for (const s of SOURCE_TABLES) await truth.exec(s);
  const typeOid = (name: string): Promise<number> => one(`SELECT '${name}'::regtype::oid::int8 AS o`);
  oids = { mood: await typeOid("mood"), _mood: await typeOid("mood[]"), level: await typeOid("other.level"), _level: await typeOid("other.level[]"),
    citext: await typeOid("citext"), _citext: await typeOid("citext[]"), people: await typeOid("people"), moods: await typeOid("moods") };
  assert.deepEqual([oids.mood, oids.level], [rowTypes.people, rowTypes.moods], "the source's enums are at the catalog's row types' OIDs (the collision this test needs)");
  api = await listen(schemaOf(oids));
});
after(async () => {
  await api.close();
  await store.close();
  await truth.close();
  stopParser();
  fs.rmSync(dir, { recursive: true, force: true });
});

const COLUMNS = "SELECT id, m, ms, l, c, cs FROM moods ORDER BY id";
/** a type by its OID as a server names it: schema-qualified, as pgjdbc's TypeInfoCache reads it */
const NAMED = (oid: number): string => "SELECT n.nspname::text, t.typname::text, t.typtype::text, format_type(t.oid, NULL), t.oid::regtype::text " +
  `FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON t.typnamespace = n.oid WHERE t.oid = ${oid}`;
/** Mason's OIDs for the columns of COLUMNS, as its RowDescription sends them */
const sentOids = async (): Promise<number[]> => (await mason(COLUMNS)).oids;

test("the wire sends the catalog's own OID for a made type, which pg_type names as the source names its own: JDBC's getColumnTypeName lookup", async () => {
  const sent = await sentOids(), theirs = (await source(COLUMNS)).oids;
  assert.deepEqual(theirs.slice(1), [oids.mood, oids._mood, oids.level, oids.citext, oids._citext], "the source's OIDs, the collided ones");
  // the source's own OID for the enum is, in Mason's catalog, a table's row type: never sent
  assert.deepEqual((await mason(`SELECT typname::text, typtype::text FROM pg_type WHERE oid = ${oids.mood}`)).rows, [["people", "c"]], "the collision this test needs");
  assert.notEqual(sent[1], oids.mood);
  assert.equal(sent[0], theirs[0], "a built-in type is sent with Postgres's OID");
  for (const [i, oid] of sent.entries()) {
    // what a client reads when it looks the column's OID up, on each side: the same type
    assert.deepEqual((await mason(NAMED(oid))).rows, (await source(NAMED(theirs[i]!))).rows, `column ${i}: OID ${oid} here, ${theirs[i]} on the source`);
    assert.deepEqual((await mason(`SELECT typname::text, typnamespace::regnamespace::text FROM pg_type WHERE oid = ${oid}`)).rows,
      (await source(`SELECT typname::text, typnamespace::regnamespace::text FROM pg_type WHERE oid = ${theirs[i]}`)).rows);
  }
  // one OID for a type wherever Mason says it: the RowDescription, pg_attribute, a ::regtype
  const attributes = "SELECT attname::text, atttypid::int FROM pg_attribute WHERE attrelid = 'moods'::regclass AND attnum > 0 ORDER BY attnum";
  assert.deepEqual((await mason(attributes)).rows.map((r) => Number(r[1])), sent);
  const regtypes = "SELECT 23, 'mood'::regtype::oid::int, 'mood[]'::regtype::oid::int, 'other.level'::regtype::oid::int, 'citext'::regtype::oid::int, 'citext[]'::regtype::oid::int";
  assert.deepEqual((await mason(regtypes)).rows[0]!.map(Number), sent);
});

test("a table's whole row is sent with the catalog's row type, which pg_type names as the table", async () => {
  const sql = "SELECT p FROM people p ORDER BY p.id";
  const got = await mason(sql), want = await source(sql);
  assert.deepEqual(got.rows, want.rows);
  assert.deepEqual((await mason(NAMED(got.oids[0]!))).rows, (await source(NAMED(want.oids[0]!))).rows);
  assert.deepEqual((await mason(`SELECT typname::text, typrelid::regclass::text FROM pg_type WHERE oid = ${got.oids[0]}`)).rows, [["people", "people"]]);
});

test("pg_typeof names a made type as the source does: an enum of another schema qualified, an array as its element's []", async () => {
  const sql = "SELECT pg_typeof(m)::text, pg_typeof(ms)::text, pg_typeof(l)::text, pg_typeof(c)::text, pg_typeof(cs)::text, pg_typeof(id)::text, pg_typeof(cs[1])::text, pg_typeof(coalesce(l, 'low'))::text FROM moods WHERE id = 1";
  const want = await source(sql);
  assert.deepEqual(want.rows, [["mood", "mood[]", "other.level", "citext", "citext[]", "integer", "citext", "other.level"]]);
  assert.deepEqual(await mason(sql), want);
  // an element of a made type's array, in a statement that reads no column of the element's type (the oracle's
  // `pg_typeof of a citext[]`: the element was named by its OID)
  const element = "SELECT pg_typeof(cs[1])::text, pg_typeof(ms[1])::text FROM moods WHERE id = 1";
  assert.deepEqual(await mason(element), await source(element));
  assert.deepEqual((await source(element)).rows, [["citext", "mood"]]);
  // under a search_path that holds the schema, its name alone
  const c = await connect(api);
  try {
    // a prepared statement parsed before the SET and executed after it is planned again, as Postgres's plancache
    const prepared = { name: "typed", text: sql, rowMode: "array" as const };
    assert.deepEqual((await c.query(prepared)).rows, want.rows);
    await c.query("SET search_path = other, public");
    await truth.exec("SET search_path = other, public");
    const r = await c.query({ text: sql, rowMode: "array" });
    assert.deepEqual(r.rows, (await source(sql)).rows);
    assert.deepEqual(r.rows, [["mood", "mood[]", "level", "citext", "citext[]", "integer", "citext", "level"]]);
    assert.deepEqual((await c.query(prepared)).rows, r.rows);
  } finally { await c.end(); await truth.exec("RESET search_path"); }
});

test("a literal cast to a made type is sent with the catalog's OID, over a synced table and in a statement the catalog answers", async () => {
  const [, mood, moods, level, citextOid] = await sentOids();
  for (const [sql, made] of [["SELECT 'happy'::mood AS x, 'high'::other.level AS y, 'Q'::citext AS z, '{ok}'::mood[] AS w", [mood, level, citextOid, moods]],
    ["SELECT 'happy'::mood AS x, id FROM moods ORDER BY id", [mood, 23]], ["SELECT 'high'::other.level AS x, c FROM moods WHERE id = 1", [level, citextOid]],
    ["SELECT ARRAY['ok'::mood] AS x FROM moods WHERE id = 1", [moods]]] as Array<[string, number[]]>) {
    const got = await mason(sql), want = await source(sql);
    assert.deepEqual(got.rows, want.rows, sql);
    assert.deepEqual(got.oids, made, `${sql}: the catalog's OIDs, as a column of each type sends`);
  }
});

test("citext's functions with a SQL body answer as Postgres's: the catalog's own citext is whole", async () => {
  const sql = "SELECT strpos('aXb'::citext, 'x'), replace('aXbx'::citext, 'x', 'y'), regexp_match('aXb'::citext, 'x')::text, split_part('aXb'::citext, 'x', 2), " +
    "translate('aXb'::citext, 'x', 'y'), regexp_replace('aXb'::citext, 'x', 'y'), regexp_matches('aXbx'::citext, 'x', 'g')::text";
  const want = await source(sql);
  assert.deepEqual(want.rows[0]![0], "2");
  assert.deepEqual((await mason(sql)).rows, want.rows);
});

/** one session over a raw socket: a Parse with declared parameter types, which `pg` cannot send */
async function rawSession(): Promise<{ exchange(...frames: Buffer[]): Promise<BackendMessage[]>; end(): void }> {
  const socket = net.connect(api.port, "127.0.0.1");
  await new Promise<void>((r) => socket.once("connect", () => r()));
  let chunks: Buffer[] = [];
  let wake: (() => void) | null = null;
  socket.on("data", (d: Buffer) => { chunks.push(d); wake?.(); });
  const ready = (): boolean => { const all = Buffer.concat(chunks); return all.length >= 6 && all[all.length - 6] === 0x5a && all.readInt32BE(all.length - 5) === 5; };
  const untilReady = async (): Promise<BackendMessage[]> => {
    while (!ready()) await new Promise<void>((r) => { wake = r; });
    const ms = wire.replies(Buffer.concat(chunks));
    chunks = [];
    return ms;
  };
  socket.write(wire.startup({ user: "mason", database: "app" }));
  while (chunks.length === 0) await new Promise<void>((r) => { wake = r; });
  chunks = [];
  socket.write(wire.password(mintToken(API_KEY, 600).token));
  await untilReady();
  return { exchange: async (...frames) => { socket.write(Buffer.concat(frames)); return untilReady(); }, end: () => { socket.destroy(); } };
}
const rowsOf = (ms: BackendMessage[]): unknown[][] => ms.flatMap((m) => m.type === "DataRow" ? [m.values.map((v) => v === null ? null : v.toString("utf8"))] : []);
const errorOf = (ms: BackendMessage[]): string | undefined => { const e = ms.find((m) => m.type === "ErrorResponse"); return e?.type === "ErrorResponse" ? `${e.fields.C} ${e.fields.M}` : undefined; };

/** a Parse naming the OIDs Mason sent (`mine`), bound and run, its ParameterDescription those OIDs; the same statement
 *  on the source with ITS OIDs answers alike */
async function parsesBind(mine: number[]): Promise<void> {
  const [, mood, , level, citextOid] = mine;
  const s = await rawSession();
  try {
    for (const [sql, types, theirs, values, want] of [
      ["SELECT id FROM moods WHERE m = $1 ORDER BY id", [mood!], [oids.mood!], ["happy"], [["1"]]],
      ["SELECT id FROM moods WHERE m < $1 ORDER BY id", [mood!], [oids.mood!], ["happy"], [["2"]]],
      ["SELECT id FROM moods WHERE l = $1 ORDER BY id", [level!], [oids.level!], ["low"], [["2"]]],
      ["SELECT id FROM moods WHERE c = $1 ORDER BY id", [citextOid!], [oids.citext!], ["alice"], [["1"], ["3"]]],
      // a statement the catalog answers
      ["SELECT pg_typeof($1)::text, $1::text", [level!], [oids.level!], ["high"], [["other.level", "high"]]],
    ] as Array<[string, number[], number[], string[], unknown[][]]>) {
      const ms = await s.exchange(wire.parse("", sql, types), wire.describe("S", ""), wire.bind("", "", values, [0]), wire.execute("", 0), wire.sync());
      assert.equal(errorOf(ms), undefined, sql);
      const described = ms.find((m) => m.type === "ParameterDescription");
      assert.deepEqual(described?.type === "ParameterDescription" ? described.oids : null, types, `${sql}: the ParameterDescription is the OIDs the Parse named`);
      assert.deepEqual(rowsOf(ms), want, sql);
      const t = await truth.query<unknown[]>(sql, values, { rowMode: "array", paramTypes: theirs, parsers: { 23: (v: string) => v } });
      assert.deepEqual(t.rows, want, `${sql}: the source's answer`);
    }
  } finally { s.end(); }
}

test("a Parse whose parameter types are the OIDs Mason sent binds them as those types", async () => {
  await parsesBind(await sentOids());
});

test("after a restart the catalog sends the same OIDs, and they name and bind the same types", async () => {
  const before = await sentOids();
  await api.close();
  api = await listen(schemaOf(oids));
  assert.deepEqual(await sentOids(), before);
  for (const oid of before) assert.equal((await mason(NAMED(oid))).rows.length, 1);
  await parsesBind(before);
});
