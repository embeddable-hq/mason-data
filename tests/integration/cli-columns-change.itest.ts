/**
 * A SOURCE TABLE'S COLUMNS CHANGED WHILE MASON RUNS (issue 977), end to end against a real Postgres, once for each sync:
 * `off` (read again at `mason sync`), `poll 1s` and `replication`. A running Mason never saw a column added (only a
 * restart did), failed every poll for ever on a column renamed or dropped, and synced a new `api_token` without a word
 * when it finally saw it.
 *
 * Each test adds a table with every column, then on the database: adds columns (one with a default, one without, and a
 * secret-looking one), renames a column, and drops one. After each, with no restart, the synced data and `SELECT *`
 * over the Postgres API equal the source's columns but the secret-looking one, which is left out and said — written as
 * `exclude:` on its entry, as `mason add` would have, in the events and among `mason status`'s warnings — and the
 * table's line in `mason status` ends synced, with no error. A column `exclude:` names, renamed, is never served, live or
 * after a restart: its new name takes its place in `exclude:`; dropped, it is taken out, so the next start never refuses
 * the project. A synced column dropped while Mason is stopped: the start syncs the table again with its columns now.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the replication test), psql on PATH, and DuckDB's postgres
 * extension. Each test writes only inside a database it creates, `it_columns_<random>`, drops it at the end, and runs
 * `mason destroy` on its project, so no replication slot is left behind.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");
const adminUrl = process.env.IT_POSTGRES_URL;
const skip = adminUrl ? false : "IT_POSTGRES_URL is not set";

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
/** a query's column names and rows, as an answer reads them; null when it fails */
function psqlWithHeader(url: string, sql: string): { columns: string; rows: string } | null {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-F", "\t", "-P", "footer=off", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const [columns = "", ...rows] = r.stdout.trim().split("\n");
  return { columns, rows: rows.join("\n") };
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}
async function until(what: string, check: () => boolean, ms = 120_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
/** A project of its own, on a database of its own. */
async function project(mode: string): Promise<{ root: string; dbUrl: string; tag: string; mason: (...args: string[]) => Ran; ok: (r: Ran, what: string) => Ran }> {
  const tag = `it_columns_${mode.replace(/\W/g, "")}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const dbUrl = (() => { const u = new URL(adminUrl!); u.pathname = `/${tag}`; return u.toString(); })();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-columns-")));
  const root = path.join(dir, "app"), home = path.join(dir, "home");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(await freePort()) };
  const mason = (...args: string[]): Ran => {
    const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 300_000 });
    let json: Record<string, unknown> = {};
    if (args.includes("--json")) {
      try { json = JSON.parse(r.stdout) as Record<string, unknown>; } catch { throw new Error(`mason ${args.join(" ")}: not JSON (exit ${r.status}):\n${r.stdout}${r.stderr}`); }
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  after(() => {
    // the run and its slot first: a slot left behind holds the database's WAL for ever
    if (fs.existsSync(path.join(root, ".mason"))) {
      const s = spawnSync(process.execPath, [MAIN, "destroy", "--json"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
      if (s.status !== 0) console.error(`mason destroy at the end: ${s.stdout}${s.stderr}`);
    }
    psql(adminUrl!, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  return { root, dbUrl, tag, mason, ok: (r, what) => { assert.equal(r.status, 0, `${what}:\n${r.stdout}${r.stderr}`); return r; } };
}

/**
 * The whole story for one sync: `bump` makes the run read the table again as that sync does (mason sync for `off`; a
 * write for the stream, whose relation message follows a change of the table's definition; nothing for a poll).
 */
async function columnsChange(mode: "off" | "poll 1s" | "replication"): Promise<void> {
  const p = await project(mode);
  const { dbUrl, mason, ok } = p;
  psql(adminUrl!, `CREATE DATABASE ${p.tag}`);
  psql(dbUrl, "CREATE TABLE t (id int PRIMARY KEY, a text, b int); INSERT INTO t SELECT g, 'a' || g, g * 10 FROM generate_series(1, 5) g");
  ok(mason("init", dbUrl, "--json"), "mason init");
  const file = path.join(p.root, "mason", "sources", `${p.tag}.yml`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^sync: off {3}#.*$/m, `sync: ${mode}`));
  ok(mason("add", "t", "--json"), "mason add t (every column)");
  ok(mason("start", "--json"), "mason start");
  ok(mason("wait", "--timeout", "120", "--json"), "mason wait");
  const api = ok(mason("user", "add", "it", "--json"), "mason user add").json.url as string;

  /** the names the entry's exclude: holds now, as the file says them */
  const excluded = (): string[] => (/^ {2}t:\n {4}exclude: \[([^\]]*)\]/m.exec(fs.readFileSync(file, "utf8"))?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  /** the source's columns and rows but those exclude: names, as SELECT * over the Postgres API must answer them */
  const expected = (): { columns: string; rows: string } => {
    const out = ["api_token", ...excluded()];
    const cols = psql(dbUrl, "SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 't'::regclass AND attnum > 0 AND NOT attisdropped")
      .split(",").filter((c) => !out.includes(c));
    return { columns: cols.join("\t"), rows: psql(dbUrl, `SELECT ${cols.join(", ")} FROM t ORDER BY id`) };
  };
  const served = (): { columns: string; rows: string } | null => psqlWithHeader(api, "SELECT * FROM public.t ORDER BY id");
  const same = (): boolean => JSON.stringify(served()) === JSON.stringify(expected());
  const bump = (): void => {
    if (mode === "off") {
      // a sync by hand reads its columns first: synced, or refused while it is read again whole with its new columns
      const r = mason("sync", "t", "--json");
      if (r.status !== 0) assert.match(JSON.stringify(r.json), /read again whole|columns changed|being caught up/, `mason sync t:\n${r.stdout}${r.stderr}`);
    } else if (mode === "replication") psql(dbUrl, "UPDATE t SET id = id WHERE id = 1");
  };
  /** the table's line in mason status --json: synced, no error */
  const settled = (): boolean => {
    const s = mason("status", "--json");
    const t = (s.json.tables as Array<{ table: string; error: string | null; sync?: { state: string }; columnsPending?: string[] }> | undefined)?.find((x) => x.table === "public.t");
    return t !== undefined && t.error === null && t.sync?.state === "synced" && t.columnsPending === undefined;
  };
  /** `check` is held at every look while it waits: what must never be served meanwhile */
  const step = async (what: string, sql: string, check: () => void = () => undefined): Promise<void> => {
    psql(dbUrl, sql);
    if (mode === "replication") await new Promise((r) => setTimeout(r, 300));
    await until(`${mode}: ${what}: SELECT * to equal the source`, () => { check(); bump(); return same(); });
    await until(`${mode}: ${what}: mason status to say it is synced`, () => { check(); bump(); return settled(); });
  };

  // ADDED: one column with a default, one without, and one that looks like a secret
  await step("columns added", "ALTER TABLE t ADD COLUMN c int DEFAULT 7, ADD COLUMN d text, ADD COLUMN api_token text; UPDATE t SET d = 'd' || id, api_token = 'tok' || id WHERE id <= 3");
  assert.match(served()!.columns, /^id\ta\tb\tc\td$/, "the new columns, the secret-looking one left out");
  // LEFT OUT AND SAID: exclude: written on its entry, as mason add writes it; an event; a warning of mason status
  assert.match(fs.readFileSync(file, "utf8"), /^ {2}t:\n {4}exclude: \[api_token\]\n/m, fs.readFileSync(file, "utf8"));
  const left = /public\.t: the new column api_token looks like a secret, so it is not synced\. Mason wrote exclude: \[api_token\] on its entry in mason\/sources\/.*\.yml\. To sync it, run mason add t --include api_token/;
  const events = ok(mason("logs", "--events", "--json"), "mason logs --events").json.events as Array<{ kind: string; table: string | null; message: string }>;
  assert.ok(events.some((e) => e.kind === "columns_changed" && e.table === "public.t" && left.test(e.message)), JSON.stringify(events));
  assert.ok(events.some((e) => e.kind === "columns_changed" && e.table === "public.t" && /its columns changed on the database \(.*c, d.* added\)/.test(e.message)), JSON.stringify(events));
  assert.ok((ok(mason("status", "--json"), "mason status").json.warnings as string[]).some((w) => left.test(w)), "said among mason status's warnings");

  // RENAMED
  await step("a column renamed", "ALTER TABLE t RENAME COLUMN a TO a2; UPDATE t SET b = b + 1 WHERE id = 2");
  assert.match(served()!.columns, /^id\ta2\tb\tc\td$/);

  // DROPPED (Mason's own publication names each table whole, #978: the database never refuses the drop)
  await step("a column dropped", "ALTER TABLE t DROP COLUMN b");
  assert.match(served()!.columns, /^id\ta2\tc\td$/);

  // AN EXCLUDED COLUMN RENAMED (the review of PR 995: a salary renamed annual_pay was served at once, and after a
  // restart): its data is never served, live or after a restart. A rename is a name gone and one arrived at once, so the
  // new name is left out in its place, written in exclude:, and said
  const never = (): void => { const s = served(); assert.ok(s === null || !s.columns.split("\t").includes("pay_note"), `pay_note served: ${s?.columns}`); };
  await step("an excluded column renamed", "ALTER TABLE t RENAME COLUMN api_token TO pay_note; UPDATE t SET d = 'renamed' WHERE id = 1", never);
  await until(`${mode}: exclude: to name pay_note`, () => { never(); bump(); return excluded().join(",") === "pay_note"; });
  assert.match(served()!.columns, /^id\ta2\tc\td$/);
  const renamed = /public\.t: api_token, which exclude: names, is gone from the database, and pay_note arrived at the same time \(a rename keeps its data\), so it is not synced either\. Mason wrote exclude: \[pay_note\]/;
  assert.ok((ok(mason("status", "--json"), "mason status").json.warnings as string[]).some((w) => renamed.test(w)), "said among mason status's warnings");
  ok(mason("stop", "--json"), "mason stop");
  ok(mason("start"), "mason start after an excluded column was renamed");
  await until(`${mode}: after the restart: SELECT * to equal the source`, () => { never(); bump(); return same(); });
  assert.match(served()!.columns, /^id\ta2\tc\td$/, "never pay_note after a restart");

  // AN EXCLUDED COLUMN DROPPED: taken out of exclude:, so the next start never refuses the project (#993's review)
  await step("an excluded column dropped", "ALTER TABLE t DROP COLUMN pay_note");
  await until(`${mode}: exclude: emptied`, () => { bump(); return /^ {2}t: \{\}\n/m.test(fs.readFileSync(file, "utf8")); });

  // WHILE MASON IS STOPPED, a synced column dropped: the start syncs the table again with its columns now
  ok(mason("stop", "--json"), "mason stop");
  psql(dbUrl, "ALTER TABLE t DROP COLUMN c");
  ok(mason("start"), "mason start after a synced column was dropped");
  await until(`${mode}: after the restart: SELECT * to equal the source`, () => { bump(); return same(); });
  assert.match(served()!.columns, /^id\ta2\td$/);
  await until(`${mode}: after the restart: mason status to say it is synced`, () => { bump(); return settled(); });
  ok(mason("stop", "--json"), "mason stop");
}

test("sync: off — a column added, renamed or dropped is picked up at mason sync, a secret-looking one left out and said", { skip, timeout: 900_000 }, () => columnsChange("off"));
test("sync: poll — a column added, renamed or dropped is picked up at the next poll, a secret-looking one left out and said", { skip, timeout: 900_000 }, () => columnsChange("poll 1s"));
test("sync: replication — a column added, renamed or dropped is picked up at the stream's relation message, a secret-looking one left out and said", { skip, timeout: 900_000 }, () => columnsChange("replication"));
