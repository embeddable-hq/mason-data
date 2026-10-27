#!/usr/bin/env node
/**
 * A DUCKDB-ENDPOINT REPRO, Postgres beside it: a throwaway database on `IT_POSTGRES_URL`'s server made from a DDL file,
 * its tables copied and served exactly as `mason start` does (src/duck/sync.ts, the listener), then each statement of a
 * second file asked of both and printed side by side — rows, column types, or the error. For reducing a finding to its
 * statement before a test is written for it; nothing here is a test.
 *
 *   IT_POSTGRES_URL=postgres://… node scripts/duck-repro.ts <ddl.sql> <statements.sql>
 *
 * The statements are separated by lines holding only `--`. The database is dropped at the end.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { DuckStore } from "../src/duck/store.ts";
import { Sync } from "../src/duck/sync.ts";
import { connectSource, parseSource, readSourceFacts } from "../src/cli/preflight.ts";
import { startPostgresApi } from "../src/api/postgres/server.ts";
import { readLibcOrder } from "../src/duck/libc-order.ts";
import { isLibcCollation } from "../src/duck/rewrite.ts";

const [ddlFile, stmtFile] = process.argv.slice(2);
const adminUrl = process.env.IT_POSTGRES_URL;
if (ddlFile === undefined || stmtFile === undefined || adminUrl === undefined) {
  process.stderr.write("usage: IT_POSTGRES_URL=postgres://… node scripts/duck-repro.ts <ddl.sql> <statements.sql>\n");
  process.exit(2);
}
const tag = `duck_repro_${process.pid}`;
const dbUrl = (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })();
const psql = (url: string, sql: string): void => {
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", url], { input: sql, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}`);
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duck-repro-"));
psql(adminUrl, `CREATE DATABASE ${tag}`);
let store: DuckStore | null = null, sync: Sync | null = null, server: Awaited<ReturnType<typeof startPostgresApi>> | null = null;
const clients: pg.Client[] = [];
try {
  psql(dbUrl, fs.readFileSync(ddlFile, "utf8"));
  const parsed = parseSource(dbUrl);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const conn = await connectSource(parsed.source);
  if ("failure" in conn) throw new Error(conn.failure.message);
  const facts = await readSourceFacts(conn.pg);
  conn.pg.close();
  const log: string[] = [];
  store = await DuckStore.open(path.join(dir, "duck.db"), (l) => log.push(l));
  sync = new Sync(store, parsed.source, tag, (l) => log.push(l), 3_600_000, "poll");
  await sync.open();
  sync.setTables(facts.tables.filter((t) => t.key.length > 0));
  sync.setViews(facts.views ?? []);
  await sync.once();
  for (const s of sync.state().filter((x) => x.phase !== "copied")) console.log(`NOT COPIED ${s.source}: ${s.error}`);
  const coll = facts.collation;
  const theStore = store;
  const libc = coll !== undefined && isLibcCollation(coll.provider, coll.collate) ? (await theStore.libcOrder(coll.collate, coll.version ?? null, async () => {
    const c = await connectSource(parsed.source);
    if ("failure" in c) throw new Error(c.failure.message);
    try { return await readLibcOrder(async (sql) => (await c.pg.query(sql)).rows, coll.collate, coll.version ?? null); } finally { c.pg.close(); }
  })).order : undefined;
  const theSync = sync;
  server = await startPostgresApi({
    port: 0, host: "127.0.0.1", tls: null, database: tag, masonVersion: "repro",
    authenticate: () => ({ filters: [], subject: undefined }), schema: () => theSync.schema(),
    record: () => undefined, log: (l) => log.push(l), duck: await theStore.listener(facts.collation, null, libc),
  });
  const source = new pg.Client({ connectionString: dbUrl });
  const mason = new pg.Client({ host: "127.0.0.1", port: server.port, database: tag, user: "repro", password: "x" });
  for (const c of [source, mason]) { await c.connect(); clients.push(c); await c.query("SET TimeZone = 'UTC'"); }
  const ask = async (c: pg.Client, sql: string): Promise<string> => {
    try {
      const r = await c.query({ text: sql, rowMode: "array", types: { getTypeParser: () => (v: string) => v } } as pg.QueryConfig);
      return `${r.fields.map((f) => `${f.name}:${f.dataTypeID}`).join(" ")} | ${JSON.stringify(r.rows)}`;
    } catch (e) { return `ERROR ${(e as pg.DatabaseError).code}: ${(e as Error).message}`; }
  };
  for (const sql of fs.readFileSync(stmtFile, "utf8").split(/^--\s*$/m).map((s) => s.trim()).filter(Boolean)) {
    const [p, m] = [await ask(source, sql), await ask(mason, sql)];
    console.log(`${p === m ? "SAME  " : "DIFFER"} ${sql.replace(/\s+/g, " ")}\n  postgres: ${p}${p === m ? "" : `\n  mason:    ${m}`}`);
  }
} finally {
  for (const c of clients) await c.end();
  await server?.close();
  await sync?.stop();
  await store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
  psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
}
