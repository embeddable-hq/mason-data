/**
 * A COLUMN THE SOURCES FILE LEAVES OUT IS NEVER SERVED UNDER ANOTHER NAME (issue 1073), end to end against a real
 * Postgres, under `poll 1s` and under `replication`. Mason decided what to leave out by a column's name alone, so the
 * review of PR 1065 saw a left-out column served three ways:
 * - two names swapped in one transaction (`exclude: [salary]`, then `salary` and `a` swapped): the salary served as `a`;
 * - a rename while Mason was stopped, then a start from the file as it was (`salary` renamed `pay2`, a new `salary`
 *   added): the start synced `pay2`, the salary;
 * - a `columns:` entry: the column renamed to a name it lists was synced under that name.
 * Each test makes the change, then updates every row (so a poll or the stream reads each one again), and holds that no
 * value marked SECRET is served at any look, that the table's line in `mason status` says why it is held and the line to
 * write, and that the way out it names syncs the table again without the secret. A swap of two synced columns, beside
 * it, is synced again whole with each value under its new name.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the replication tests), psql on PATH, and DuckDB's postgres
 * extension. Each test writes only inside a database it creates, `it_identity_<random>`, drops it at the end, and runs
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(what: string, check: () => boolean, ms = 120_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Mode = "poll 1s" | "replication";
interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }

/** A project of its own, on a database of its own, its tables made by `tables` and its entries `entries`, started. */
async function started(mode: Mode, tables: string, entries: string) {
  const tag = `it_identity_${mode.replace(/\W/g, "")}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const dbUrl = (() => { const u = new URL(adminUrl!); u.pathname = `/${tag}`; return u.toString(); })();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-identity-")));
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
  const ok = (r: Ran, what: string): Ran => { assert.equal(r.status, 0, `${what}:\n${r.stdout}${r.stderr}`); return r; };
  after(() => {
    // the run and its slot first: a slot left behind holds the database's WAL for ever
    if (fs.existsSync(path.join(root, ".mason"))) {
      const s = spawnSync(process.execPath, [MAIN, "destroy", "--json"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
      if (s.status !== 0) console.error(`mason destroy at the end: ${s.stdout}${s.stderr}`);
    }
    psql(adminUrl!, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, tables);
  ok(mason("init", dbUrl, "--json"), "mason init");
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  const text = fs.readFileSync(file, "utf8").replace(/^sync: off {3}#.*$/m, `sync: ${mode}`).replace(/^tables:.*$[\s\S]*/m, `tables:\n${entries}`);
  assert.match(text, new RegExp(`^sync: ${mode}$`, "m"), text);
  fs.writeFileSync(file, text);
  ok(mason("start", "--json"), "mason start");
  ok(mason("wait", "--timeout", "120", "--json"), "mason wait");
  const api = ok(mason("user", "add", "it", "--json"), "mason user add").json.url as string;

  const served = (table: string): { columns: string; rows: string } | null => psqlWithHeader(api, `SELECT * FROM public.${table} ORDER BY id`);
  /** no value marked SECRET served by any table, at this look */
  const neverSecret = (when: string, tablesNow: readonly string[]): void => {
    for (const t of tablesNow) {
      const s = served(t);
      assert.ok(s === null || !s.rows.includes("SECRET"), `${mode}: ${when}: ${t} served a value of a column the file leaves out:\n${s?.columns}\n${s?.rows}`);
    }
  };
  /** the source's rows of `columns`, as SELECT * over the Postgres API must answer them */
  const source = (table: string, columns: readonly string[]): { columns: string; rows: string } =>
    ({ columns: columns.join("\t"), rows: psql(dbUrl, `SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`) });
  /** the table's line in mason status --json */
  const line = (table: string): { error: string | null; state: string | undefined } | undefined => {
    const t = (mason("status", "--json").json.tables as Array<{ table: string; error: string | null; sync?: { state: string } }> | undefined)?.find((x) => x.table === `public.${table}`);
    return t === undefined ? undefined : { error: t.error, state: t.sync?.state };
  };
  /** a change the stream sends with its relation message: the stream sees a definition change only with a row change */
  const bump = (table: string): void => { if (mode === "replication") psql(dbUrl, `UPDATE ${table} SET id = id WHERE id = 1`); };
  return { mode, dbUrl, file, mason, ok, served, neverSecret, source, line, bump };
}

const holds = /^public\.t is not synced: its columns were renamed on the database, and /;

/** TWO NAMES SWAPPED IN ONE TRANSACTION: the excluded salary and a synced `a`; and, beside it, two synced columns */
async function swap(mode: Mode): Promise<void> {
  const p = await started(mode,
    "CREATE TABLE t (id int PRIMARY KEY, a text, salary text, b text); INSERT INTO t SELECT g, 'p_a' || g, 'SECRET_' || g, 'p_b' || g FROM generate_series(1, 4) g; " +
    "CREATE TABLE u (id int PRIMARY KEY, v text, w text); INSERT INTO u SELECT g, 'p_v' || g, 'p_w' || g FROM generate_series(1, 4) g",
    "  t:\n    exclude: [salary]\n  u: {}\n");
  assert.equal(p.served("t")?.columns, "id\ta\tb");
  psql(p.dbUrl, "BEGIN; ALTER TABLE t RENAME a TO tmp; ALTER TABLE t RENAME salary TO a; ALTER TABLE t RENAME tmp TO salary; " +
    "ALTER TABLE u RENAME v TO tmp; ALTER TABLE u RENAME w TO v; ALTER TABLE u RENAME tmp TO w; COMMIT");
  // every row read again: by the next poll (its xmin moved), or sent by the stream after its relation message
  psql(p.dbUrl, "UPDATE t SET b = b || ''; UPDATE u SET v = v || ''");
  // HELD, SAID WITH THE LINE TO WRITE, never serving the salary meanwhile
  const want = new RegExp(`${holds.source}a is the column the sources file left out as salary\\. .*write exclude: \\[salary, a\\] on mason/sources/.*\\.yml: tables\\.t, then run mason stop && mason start\\. ` +
    "To sync it, run mason add t --columns id,a,b while Mason runs");
  await until(`${mode}: the swap to hold t, said on its line`, () => { p.neverSecret("after the swap", ["t", "u"]); p.bump("t"); return want.test(p.line("t")?.error ?? ""); });
  // the two synced columns swapped: synced again whole, each value under its new name (never the old copy's)
  await until(`${mode}: u to equal the source after its swap`, () => { p.neverSecret("after the swap", ["t", "u"]); p.bump("u"); return JSON.stringify(p.served("u")) === JSON.stringify(p.source("u", ["id", "w", "v"])); });
  for (let i = 0; i < 10; i++) { p.neverSecret("while t is held", ["t", "u"]); await sleep(500); }
  assert.equal(p.served("t")?.columns, "id\ta\tb", "a held table serves its synced data as it was");
  assert.match(p.served("t")!.rows, /^1\tp_a1\tp_b1$/m, "its old values, never the salary");
  // the said line written, and a start: synced again, neither the salary nor the column now named salary served
  p.ok(p.mason("stop", "--json"), "mason stop");
  fs.writeFileSync(p.file, fs.readFileSync(p.file, "utf8").replace("exclude: [salary]", "exclude: [salary, a]"));
  p.ok(p.mason("start", "--json"), "mason start with the line written");
  await until(`${mode}: t synced again without them`, () => { p.neverSecret("after the line was written", ["t", "u"]); p.bump("t"); return JSON.stringify(p.served("t")) === JSON.stringify(p.source("t", ["id", "b"])); });
  await until(`${mode}: t's line to say it is synced`, () => { p.neverSecret("after the line was written", ["t"]); p.bump("t"); const l = p.line("t"); return l?.error === null && l.state === "synced"; });
  p.ok(p.mason("stop", "--json"), "mason stop");
}

/** A RENAME WHILE MASON IS STOPPED, then a start from the file as it was: `salary` renamed `pay2`, a new `salary` */
async function renameThenStart(mode: Mode): Promise<void> {
  const p = await started(mode,
    "CREATE TABLE t (id int PRIMARY KEY, a text, salary text); INSERT INTO t SELECT g, 'p_a' || g, 'SECRET_' || g FROM generate_series(1, 4) g",
    "  t:\n    exclude: [salary]\n");
  p.ok(p.mason("stop", "--json"), "mason stop");
  psql(p.dbUrl, "ALTER TABLE t RENAME salary TO pay2; ALTER TABLE t ADD COLUMN salary text DEFAULT 'p_new'; UPDATE t SET a = a || ''");
  p.ok(p.mason("start", "--json"), "mason start from the file as it was");
  const want = new RegExp(`${holds.source}pay2 is the column the sources file left out as salary\\. .*write exclude: \\[salary, pay2\\] on mason/sources/.*\\.yml: tables\\.t`);
  await until(`${mode}: the start to hold t, said on its line`, () => { p.neverSecret("after the start", ["t"]); p.bump("t"); return want.test(p.line("t")?.error ?? ""); });
  for (let i = 0; i < 10; i++) { p.neverSecret("while t is held", ["t"]); await sleep(500); }
  // the said line written: synced again, neither pay2 nor the new salary
  p.ok(p.mason("stop", "--json"), "mason stop");
  fs.writeFileSync(p.file, fs.readFileSync(p.file, "utf8").replace("exclude: [salary]", "exclude: [salary, pay2]"));
  p.ok(p.mason("start", "--json"), "mason start with the line written");
  await until(`${mode}: t synced as the file says`, () => { p.neverSecret("after the line was written", ["t"]); p.bump("t"); return JSON.stringify(p.served("t")) === JSON.stringify(p.source("t", ["id", "a"])); });
  await until(`${mode}: t's line to say it is synced`, () => { p.neverSecret("after the line was written", ["t"]); p.bump("t"); const l = p.line("t"); return l?.error === null && l.state === "synced"; });
  p.ok(p.mason("stop", "--json"), "mason stop");
}

/** WHILE MASON RUNS, ONE TRANSACTION: `salary` renamed `pay` and a new `salary` added (the re-check of PR 1065). The
 *  excluded name is still there, so nothing by name says the salary moved: Mason synced `pay` at once, and said nothing */
async function renameAndAdd(mode: Mode): Promise<void> {
  const p = await started(mode,
    "CREATE TABLE t (id int PRIMARY KEY, a text, salary text); INSERT INTO t SELECT g, 'p_a' || g, 'SECRET_' || g FROM generate_series(1, 4) g",
    "  t:\n    exclude: [salary]\n");
  psql(p.dbUrl, "BEGIN; ALTER TABLE t RENAME salary TO pay; ALTER TABLE t ADD COLUMN salary text DEFAULT 'p_new'; COMMIT");
  psql(p.dbUrl, "UPDATE t SET a = a || ''");
  const want = new RegExp(`${holds.source}pay is the column the sources file left out as salary\\. .*write exclude: \\[salary, pay\\] on mason/sources/.*\\.yml: tables\\.t`);
  await until(`${mode}: t held, said on its line`, () => { p.neverSecret("after the rename and the add", ["t"]); p.bump("t"); return want.test(p.line("t")?.error ?? ""); });
  for (let i = 0; i < 10; i++) { p.neverSecret("while t is held", ["t"]); await sleep(500); }
  // said in the log and as an event too, not only on its line
  const events = p.ok(p.mason("logs", "--events", "--json"), "mason logs --events").json.events as Array<{ kind: string; table: string | null; message: string }>;
  assert.ok(events.some((e) => e.kind === "columns_changed" && e.table === "public.t" && want.test(e.message)), JSON.stringify(events));
  p.ok(p.mason("stop", "--json"), "mason stop");
}

/** THE EXCLUDED COLUMN RENAMED AWAY AND BACK, IN A WRITABLE PROJECT (the review of PR 1078): `c` renamed `d` (the run
 *  writes `exclude: [d]`), a new `c` added and synced, then in one transaction the new `c` dropped and `d` renamed `c`.
 *  The run takes the gone `d` out of `exclude:` (the file becomes `{}`), so by name the file syncs `c`, the secret: it
 *  was served at every look, and after a restart */
async function renamedBack(mode: Mode): Promise<void> {
  const p = await started(mode,
    "CREATE TABLE t (id int PRIMARY KEY, a text, c text, b text); INSERT INTO t SELECT g, 'p_a' || g, 'SECRET_' || g, 'p_b' || g FROM generate_series(1, 4) g",
    "  t:\n    exclude: [c]\n");
  const all = ["t"];
  psql(p.dbUrl, "ALTER TABLE t RENAME c TO d");
  await until(`${mode}: exclude: [d] written`, () => { p.neverSecret("after the rename", all); p.bump("t"); return /^ {2}t:\n {4}exclude: \[d\]\n/m.test(fs.readFileSync(p.file, "utf8")); });
  psql(p.dbUrl, "ALTER TABLE t ADD COLUMN c text DEFAULT 'p_new'");
  await until(`${mode}: the new c synced`, () => { p.neverSecret("after the add", all); p.bump("t"); return JSON.stringify(p.served("t")) === JSON.stringify(p.source("t", ["id", "a", "b", "c"])); });
  psql(p.dbUrl, "BEGIN; ALTER TABLE t DROP COLUMN c; ALTER TABLE t RENAME d TO c; COMMIT");
  psql(p.dbUrl, "UPDATE t SET a = a || ''");
  const want = new RegExp(`${holds.source}c is the column the sources file left out as d\\. .*write exclude: \\[c\\] on mason/sources/.*\\.yml: tables\\.t`);
  await until(`${mode}: t held, said on its line`, () => { p.neverSecret("after the drop and the rename back", all); p.bump("t"); return want.test(p.line("t")?.error ?? ""); });
  for (let i = 0; i < 10; i++) { p.neverSecret("while t is held", all); await sleep(500); }
  // AND AFTER A RESTART from the file as the run left it: still held, never served
  p.ok(p.mason("stop", "--json"), "mason stop");
  p.ok(p.mason("start", "--json"), "mason start");
  await until(`${mode}: after the restart, t held`, () => { p.neverSecret("after the restart", all); p.bump("t"); return want.test(p.line("t")?.error ?? ""); });
  for (let i = 0; i < 10; i++) { p.neverSecret("after the restart", all); await sleep(500); }
  p.ok(p.mason("stop", "--json"), "mason stop");
}

/** A `columns:` ENTRY: a column renamed to a name it lists, the listed one renamed away in the same transaction */
async function listedRename(mode: Mode): Promise<void> {
  const p = await started(mode,
    "CREATE TABLE t (id int PRIMARY KEY, amount_total text, z text); INSERT INTO t SELECT g, 'p_at' || g, 'SECRET_' || g FROM generate_series(1, 4) g",
    "  t:\n    columns: [id, amount_total]\n");
  assert.equal(p.served("t")?.columns, "id\tamount_total");
  psql(p.dbUrl, "BEGIN; ALTER TABLE t RENAME amount_total TO amount_total2; ALTER TABLE t RENAME z TO amount_total; COMMIT");
  psql(p.dbUrl, "UPDATE t SET amount_total2 = amount_total2 || ''");
  const want = new RegExp(`${holds.source}amount_total is the column the sources file left out as z\\. .*write columns: \\[id, amount_total2\\] on mason/sources/.*\\.yml: tables\\.t`);
  await until(`${mode}: the rename to hold t, said on its line`, () => { p.neverSecret("after the rename", ["t"]); p.bump("t"); return want.test(p.line("t")?.error ?? ""); });
  for (let i = 0; i < 10; i++) { p.neverSecret("while t is held", ["t"]); await sleep(500); }
  // RE-CONFIRMED by mason add while Mason runs: the entry written against the columns as they are now
  p.ok(p.mason("add", "t", "--columns", "id,amount_total2", "--json"), "mason add t --columns id,amount_total2");
  await until(`${mode}: t synced as the entry now says`, () => { p.neverSecret("after mason add", ["t"]); p.bump("t"); return JSON.stringify(p.served("t")) === JSON.stringify(p.source("t", ["id", "amount_total2"])); });
  await until(`${mode}: t's line to say it is synced`, () => { p.neverSecret("after mason add", ["t"]); p.bump("t"); const l = p.line("t"); return l?.error === null && l.state === "synced"; });
  p.ok(p.mason("stop", "--json"), "mason stop");
}

/** A SYNCED COLUMN DROPPED AND THE EXCLUDED ONE RENAMED INTO ITS NAME: the stream's relation reads as the excluded one
 *  dropped (`id, a, b`), so its names alone cannot tell; the catalog does. And a drop, then renames that shift every
 *  name back into place, then an add (`w`): the relation's names are the old ones in the old order. Beside them, a
 *  plain drop of an excluded column of another table is applied, the stream going on */
async function dropRenameInto(mode: Mode): Promise<void> {
  const p = await started(mode,
    "CREATE TABLE t (id int PRIMARY KEY, a text, salary text, b text); INSERT INTO t SELECT g, 'p_a' || g, 'SECRET_' || g, 'p_b' || g FROM generate_series(1, 4) g; " +
    "CREATE TABLE w (id int PRIMARY KEY, a text, salary text, b text); INSERT INTO w SELECT g, 'p_a' || g, 'SECRET_' || g, 'p_b' || g FROM generate_series(1, 4) g; " +
    "CREATE TABLE u (id int PRIMARY KEY, v text, note text); INSERT INTO u SELECT g, 'p_v' || g, 'p_note' || g FROM generate_series(1, 4) g",
    "  t:\n    exclude: [salary]\n  w:\n    exclude: [salary]\n  u:\n    exclude: [note]\n");
  psql(p.dbUrl, "BEGIN; ALTER TABLE t DROP COLUMN a; ALTER TABLE t RENAME salary TO a; COMMIT; " +
    "BEGIN; ALTER TABLE w DROP COLUMN a; ALTER TABLE w RENAME salary TO a; ALTER TABLE w RENAME b TO salary; ALTER TABLE w ADD COLUMN b text DEFAULT 'p_new'; COMMIT; " +
    "ALTER TABLE u DROP COLUMN note");
  psql(p.dbUrl, "UPDATE t SET b = b || ''; UPDATE w SET b = b || ''; UPDATE u SET v = v || '!'");
  const want = (table: string): RegExp => new RegExp(`^public\\.${table} is not synced: its columns were renamed on the database, and a is the column the sources file left out as salary\\. `);
  const all = ["t", "w", "u"];
  for (const table of ["t", "w"]) {
    await until(`${mode}: ${table} held, said on its line`, () => { p.neverSecret("after the drop and the renames", all); p.bump(table); return want(table).test(p.line(table)?.error ?? ""); });
  }
  // the excluded column dropped alone: the table synced on, its changes applied
  await until(`${mode}: u to equal the source`, () => { p.neverSecret("after the drop", all); p.bump("u"); return JSON.stringify(p.served("u")) === JSON.stringify(p.source("u", ["id", "v"])); });
  for (let i = 0; i < 10; i++) { p.neverSecret("while t and w are held", all); await sleep(500); }
  p.ok(p.mason("stop", "--json"), "mason stop");
}

test("sync: poll — a synced column dropped and the excluded one renamed into its name never serve the excluded column", { skip, timeout: 600_000 }, () => dropRenameInto("poll 1s"));
test("sync: replication — a synced column dropped and the excluded one renamed into its name never serve the excluded column", { skip, timeout: 600_000 }, () => dropRenameInto("replication"));
test("sync: poll — two names swapped in one transaction never serve the excluded column: the table is held, said with the line to write", { skip, timeout: 600_000 }, () => swap("poll 1s"));
test("sync: replication — two names swapped in one transaction never serve the excluded column: the table is held, said with the line to write", { skip, timeout: 600_000 }, () => swap("replication"));
test("sync: poll — an excluded column renamed while Mason is stopped is never served after a start from the file as it was", { skip, timeout: 600_000 }, () => renameThenStart("poll 1s"));
test("sync: replication — an excluded column renamed while Mason is stopped is never served after a start from the file as it was", { skip, timeout: 600_000 }, () => renameThenStart("replication"));
test("sync: poll — the excluded column renamed and a new column of its name added in one transaction: the renamed one is never served, the table held", { skip, timeout: 600_000 }, () => renameAndAdd("poll 1s"));
test("sync: replication — the excluded column renamed and a new column of its name added in one transaction: the renamed one is never served, the table held", { skip, timeout: 600_000 }, () => renameAndAdd("replication"));
test("sync: poll — the excluded column renamed away and back over a dropped column of its first name, in a writable project: never served, held, and after a restart", { skip, timeout: 600_000 }, () => renamedBack("poll 1s"));
test("sync: replication — the excluded column renamed away and back over a dropped column of its first name, in a writable project: never served, held, and after a restart", { skip, timeout: 600_000 }, () => renamedBack("replication"));
test("sync: poll — a column renamed to a name columns: lists is not synced under it until mason add confirms the entry", { skip, timeout: 600_000 }, () => listedRename("poll 1s"));
test("sync: replication — a column renamed to a name columns: lists is not synced under it until mason add confirms the entry", { skip, timeout: 600_000 }, () => listedRename("replication"));
