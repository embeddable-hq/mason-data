/**
 * A COLUMN THE SOURCES FILE LEAVES OUT IS NEVER SERVED UNDER ANOTHER NAME (issue 1073), end to end against a real
 * Postgres, under `poll 1s` and under `replication`. Mason decided what to leave out by a column's name alone, so a
 * left-out column was served under another name. Each form has a table of its own in one writable project, a test a
 * sync:
 * - `s_t`: two names swapped in one transaction (`exclude: [salary]`, then `salary` and `a` swapped): the salary was
 *   served as `a`. Beside it, `s_u`: two synced columns swapped are synced again whole, each value under its new name.
 * - `l_t`: a `columns:` entry, a column renamed to a name it lists: synced under that name. Confirmed by `mason add`.
 * - `i_t`: a synced column dropped and the excluded one renamed into its name: the stream's relation reads as the
 *   excluded one dropped. `i_w`: a drop, then renames shifting every name back into place, then an add. Beside them,
 *   `i_u`: an excluded column dropped alone is applied, the table syncing on.
 * - `n_t`: while Mason runs, `salary` renamed `pay` and a new `salary` added in one transaction (the re-check of PR
 *   1065): `pay` was synced at once, and nothing said.
 * - `b_t`: the review of PR 1078, in a writable project. `c` renamed `d` (the run writes `exclude: [d]`), a new `c`
 *   added and synced, then the new `c` dropped and `d` renamed `c`: the run took the gone `d` out of `exclude:`, and the
 *   file synced `c`, the secret, at every look and after a restart.
 * - `r_t`: a rename while Mason was stopped, then a start from the file as it was (`salary` renamed `pay2`, a new
 *   `salary` added): the start synced `pay2`.
 * Each change is followed by an update of every row, so a poll or the stream reads each one again. At every look no value
 * marked SECRET is served, and each held table's line in `mason status` says why with the line to write. The ways out
 * the lines name sync the tables again without the secret.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the replication test), psql on PATH, and DuckDB's postgres
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
async function until(what: string, check: () => boolean, ms = 180_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}`);
}

type Mode = "poll 1s" | "replication";
interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }

const TABLES = ["s_t", "s_u", "l_t", "i_t", "i_w", "i_u", "n_t", "b_t", "r_t"];
const SQL = [
  "CREATE TABLE s_t (id int PRIMARY KEY, a text, salary text, b text); INSERT INTO s_t SELECT g, 'p_a' || g, 'SECRET_' || g, 'p_b' || g FROM generate_series(1, 4) g",
  "CREATE TABLE s_u (id int PRIMARY KEY, v text, w text); INSERT INTO s_u SELECT g, 'p_v' || g, 'p_w' || g FROM generate_series(1, 4) g",
  "CREATE TABLE l_t (id int PRIMARY KEY, amount_total text, z text); INSERT INTO l_t SELECT g, 'p_at' || g, 'SECRET_' || g FROM generate_series(1, 4) g",
  "CREATE TABLE i_t (id int PRIMARY KEY, a text, salary text, b text); INSERT INTO i_t SELECT g, 'p_a' || g, 'SECRET_' || g, 'p_b' || g FROM generate_series(1, 4) g",
  "CREATE TABLE i_w (id int PRIMARY KEY, a text, salary text, b text); INSERT INTO i_w SELECT g, 'p_a' || g, 'SECRET_' || g, 'p_b' || g FROM generate_series(1, 4) g",
  "CREATE TABLE i_u (id int PRIMARY KEY, v text, note text); INSERT INTO i_u SELECT g, 'p_v' || g, 'p_note' || g FROM generate_series(1, 4) g",
  "CREATE TABLE n_t (id int PRIMARY KEY, a text, salary text); INSERT INTO n_t SELECT g, 'p_a' || g, 'SECRET_' || g FROM generate_series(1, 4) g",
  "CREATE TABLE b_t (id int PRIMARY KEY, a text, c text, b text); INSERT INTO b_t SELECT g, 'p_a' || g, 'SECRET_' || g, 'p_b' || g FROM generate_series(1, 4) g",
  "CREATE TABLE r_t (id int PRIMARY KEY, a text, salary text); INSERT INTO r_t SELECT g, 'p_a' || g, 'SECRET_' || g FROM generate_series(1, 4) g",
].join("; ");
const ENTRIES = "  s_t:\n    exclude: [salary]\n  s_u: {}\n  l_t:\n    columns: [id, amount_total]\n  i_t:\n    exclude: [salary]\n  i_w:\n    exclude: [salary]\n" +
  "  i_u:\n    exclude: [note]\n  n_t:\n    exclude: [salary]\n  b_t:\n    exclude: [c]\n  r_t:\n    exclude: [salary]\n";

/** a table held, its line as `mason status` says it: the column it would sync, the column it was left out as (the same
 *  when it was not renamed), and the line that keeps it out */
const held = (table: string, column: string, was: string, line: string): RegExp => new RegExp(`^public\\.${table} is not synced: ` +
  (column === was ? `${column} is a column the sources file left out\\. ` : `its columns were renamed on the database, and ${column} is the column the sources file left out as ${was}\\. `) +
  `.*To keep it out, write ${line.replace(/[[\]]/g, "\\$&")} on mason/sources/[^ ]+\\.yml: tables\\.${table}, then run mason stop && mason start\\. To sync it, run mason add ${table} --columns `);

async function identity(mode: Mode): Promise<void> {
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
  psql(dbUrl, SQL);
  ok(mason("init", dbUrl, "--json"), "mason init");
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  const text = fs.readFileSync(file, "utf8").replace(/^sync: off {3}#.*$/m, `sync: ${mode}`).replace(/^tables:.*$[\s\S]*/m, `tables:\n${ENTRIES}`);
  assert.match(text, new RegExp(`^sync: ${mode}$`, "m"), text);
  fs.writeFileSync(file, text);
  ok(mason("start", "--json"), "mason start");
  ok(mason("wait", "--timeout", "180", "--json"), "mason wait");
  const api = ok(mason("user", "add", "it", "--json"), "mason user add").json.url as string;

  const served = (table: string): { columns: string; rows: string } | null => psqlWithHeader(api, `SELECT * FROM public.${table} ORDER BY id`);
  /** no value marked SECRET served by any table, at this look */
  const neverSecret = (when: string): void => {
    for (const t of TABLES) {
      const s = served(t);
      assert.ok(s === null || !s.rows.includes("SECRET"), `${mode}: ${when}: ${t} served a value of a column the file leaves out:\n${s?.columns}\n${s?.rows}`);
    }
  };
  /** the source's rows of `columns`, as SELECT * over the Postgres API must answer them */
  const source = (table: string, columns: readonly string[]): { columns: string; rows: string } =>
    ({ columns: columns.join("\t"), rows: psql(dbUrl, `SELECT ${columns.join(", ")} FROM ${table} ORDER BY id`) });
  const equal = (table: string, columns: readonly string[]): boolean => JSON.stringify(served(table)) === JSON.stringify(source(table, columns));
  /** each table's line in mason status --json, read once */
  const lines = (): Map<string, { error: string | null; state: string | undefined }> => new Map(
    ((mason("status", "--json").json.tables as Array<{ table: string; error: string | null; sync?: { state: string } }> | undefined) ?? [])
      .map((t) => [t.table.replace(/^public\./, ""), { error: t.error, state: t.sync?.state }]));
  /** the stream sees a definition change only with a row change after it */
  const bump = (): void => { if (mode === "replication") psql(dbUrl, TABLES.map((t) => `UPDATE ${t} SET id = id WHERE id = 1`).join("; ")); };
  /** waits until every check holds at one look, holding that no secret is served at each */
  const all = async (what: string, checks: Record<string, (l: ReturnType<typeof lines>) => boolean>): Promise<void> => {
    let failing: string[] = [];
    await until(`${mode}: ${what} (still failing: ${failing.join(", ")})`, () => {
      neverSecret(what);
      bump();
      const l = lines();
      failing = Object.entries(checks).filter(([, c]) => !c(l)).map(([k]) => k);
      return failing.length === 0;
    }).catch((e: unknown) => { throw new Error(`${(e as Error).message}; still failing: ${failing.join(", ")}; lines: ${JSON.stringify(Object.fromEntries(lines()))}`); });
  };
  const errorOf = (l: ReturnType<typeof lines>, t: string): string => l.get(t)?.error ?? "";
  const synced = (l: ReturnType<typeof lines>, t: string): boolean => l.get(t)?.error === null && l.get(t)?.state === "synced";

  // ONE TRANSACTION A TABLE, every form at once
  psql(dbUrl, "BEGIN; ALTER TABLE s_t RENAME a TO tmp; ALTER TABLE s_t RENAME salary TO a; ALTER TABLE s_t RENAME tmp TO salary; COMMIT");
  psql(dbUrl, "BEGIN; ALTER TABLE s_u RENAME v TO tmp; ALTER TABLE s_u RENAME w TO v; ALTER TABLE s_u RENAME tmp TO w; COMMIT");
  psql(dbUrl, "BEGIN; ALTER TABLE l_t RENAME amount_total TO amount_total2; ALTER TABLE l_t RENAME z TO amount_total; COMMIT");
  psql(dbUrl, "BEGIN; ALTER TABLE i_t DROP COLUMN a; ALTER TABLE i_t RENAME salary TO a; COMMIT");
  psql(dbUrl, "BEGIN; ALTER TABLE i_w DROP COLUMN a; ALTER TABLE i_w RENAME salary TO a; ALTER TABLE i_w RENAME b TO salary; ALTER TABLE i_w ADD COLUMN b text DEFAULT 'p_new'; COMMIT");
  psql(dbUrl, "ALTER TABLE i_u DROP COLUMN note");
  psql(dbUrl, "BEGIN; ALTER TABLE n_t RENAME salary TO pay; ALTER TABLE n_t ADD COLUMN salary text DEFAULT 'p_new'; COMMIT");
  psql(dbUrl, "ALTER TABLE b_t RENAME c TO d");
  psql(dbUrl, TABLES.filter((t) => t !== "r_t").map((t) => `UPDATE ${t} SET id = id`).join("; "));
  await all("every form held, said on its line", {
    s_t: (l) => held("s_t", "a", "salary", "exclude: [salary, a]").test(errorOf(l, "s_t")),
    // two synced columns swapped: synced again whole, each value under its new name (never the old copy's)
    s_u: () => equal("s_u", ["id", "w", "v"]),
    l_t: (l) => held("l_t", "amount_total", "z", "columns: [id, amount_total2]").test(errorOf(l, "l_t")),
    i_t: (l) => held("i_t", "a", "salary", "exclude: [a]").test(errorOf(l, "i_t")),
    i_w: (l) => /^public\.i_w is not synced: its columns were renamed on the database, and a is the column the sources file left out as salary\. /.test(errorOf(l, "i_w")),
    // the excluded column dropped alone: the table syncs on, its changes applied
    i_u: () => equal("i_u", ["id", "v"]),
    n_t: (l) => held("n_t", "pay", "salary", "exclude: [salary, pay]").test(errorOf(l, "n_t")),
    b_t: () => /^ {2}b_t:\n {4}exclude: \[d\]\n/m.test(fs.readFileSync(file, "utf8")),
  });
  assert.equal(served("s_t")?.columns, "id\ta\tb", "a held table serves its synced data as it was");
  assert.match(served("s_t")!.rows, /^1\tp_a1\tp_b1$/m, "its old values, never the salary");
  // said in the log and as an event too, not only on its line
  const events = ok(mason("logs", "--events", "--json"), "mason logs --events").json.events as Array<{ kind: string; table: string | null; message: string }>;
  assert.ok(events.some((e) => e.kind === "columns_changed" && e.table === "public.n_t" && held("n_t", "pay", "salary", "exclude: [salary, pay]").test(e.message)), JSON.stringify(events));

  // b_t, THE REVIEW OF PR 1078: a new c, synced; then the new c dropped and d renamed c
  psql(dbUrl, "ALTER TABLE b_t ADD COLUMN c text DEFAULT 'p_new'");
  await all("the new c synced", { b_t: () => equal("b_t", ["id", "a", "b", "c"]) });
  psql(dbUrl, "BEGIN; ALTER TABLE b_t DROP COLUMN c; ALTER TABLE b_t RENAME d TO c; COMMIT; UPDATE b_t SET a = a || ''");
  await all("b_t held", { b_t: (l) => held("b_t", "c", "d", "exclude: [c]").test(errorOf(l, "b_t")) });

  // l_t CONFIRMED by mason add while Mason runs: the entry written against the columns as they are now
  ok(mason("add", "l_t", "--columns", "id,amount_total2", "--json"), "mason add l_t --columns id,amount_total2");
  await all("l_t synced as the entry now says", { l_t: (l) => equal("l_t", ["id", "amount_total2"]) && synced(l, "l_t") });
  for (let i = 0; i < 6; i++) { neverSecret("while held"); await sleep(500); }

  // STOPPED: r_t's salary renamed pay2 and a new salary added; s_t's line written as said
  ok(mason("stop", "--json"), "mason stop");
  psql(dbUrl, "ALTER TABLE r_t RENAME salary TO pay2; ALTER TABLE r_t ADD COLUMN salary text DEFAULT 'p_new'; UPDATE r_t SET a = a || ''");
  const before = fs.readFileSync(file, "utf8");
  assert.ok(before.includes("  s_t:\n    exclude: [salary]\n"), before);
  fs.writeFileSync(file, before.replace("  s_t:\n    exclude: [salary]\n", "  s_t:\n    exclude: [salary, a]\n"));
  ok(mason("start", "--json"), "mason start from the file as it was, s_t's line written");
  await all("after the restart", {
    r_t: (l) => held("r_t", "pay2", "salary", "exclude: [salary, pay2]").test(errorOf(l, "r_t")),
    // still held after a restart from the file as the run left it
    b_t: (l) => held("b_t", "c", "d", "exclude: [c]").test(errorOf(l, "b_t")),
    n_t: (l) => held("n_t", "pay", "salary", "exclude: [salary, pay]").test(errorOf(l, "n_t")),
    // the said line written: synced again, neither the salary nor the column now named salary served
    s_t: (l) => equal("s_t", ["id", "b"]) && synced(l, "s_t"),
  });
  for (let i = 0; i < 6; i++) { neverSecret("after the restart"); await sleep(500); }
  ok(mason("stop", "--json"), "mason stop");
}

test("sync: poll — a column the file leaves out is never served under another name, its old one included: a swap, a rename into a listed name, a drop with a rename into its name, a rename with an add, a rename away and back, a rename while stopped; each held, said with the line to write", { skip, timeout: 900_000 }, () => identity("poll 1s"));
test("sync: replication — a column the file leaves out is never served under another name, its old one included: a swap, a rename into a listed name, a drop with a rename into its name, a rename with an add, a rename away and back, a rename while stopped; each held, said with the line to write", { skip, timeout: 900_000 }, () => identity("replication"));
