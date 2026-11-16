/**
 * ONE ENTRY'S PROBLEM HOLDS ITS TABLE ALONE (issue 1074), end to end against a real Postgres. With `t3: { columns: [id,
 * amount_total] }`, renaming `t3.amount_total` on the database made the run's re-read refuse the whole sources file, so
 * from then on no table took a column change until a restart: a column added to another table was never synced.
 *
 * Two tables polled every second. On the database, `t3.amount_total` is renamed and a row of it changed, then `t1` gains a
 * column. With no restart: `t1`'s new column is synced; `t3` is held, serving what it holds under its old columns, never
 * the renamed one under its new name (fail closed), and its line in `mason status` says why with the line to write;
 * `mason add t3 --columns id,amount_total2` takes it at once, and it is synced again with the column as the database
 * names it now.
 *
 * The same re-read takes two entries written by hand whose tables' names differ only in case from a synced table's, one
 * above the polled `accents` and one below the streamed `bravo` (the review of PR 1091: the one written first was taken,
 * and both shared one synced table, which neither served after). Neither new entry is taken, each said with its way out,
 * and `accents` and `bravo` are kept current throughout.
 *
 * What it needs: IT_POSTGRES_URL, psql on PATH, and DuckDB's postgres extension. It writes only inside a database it
 * creates, `it_entryhold_<random>`, drops it at the end, and runs `mason destroy` on its project.
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
const TAG = "it_entryhold";

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
async function until(what: string, check: () => boolean, ms = 90_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
type Line = { table: string; error: string | null; sync?: { state: string } };

test("a column renamed under a columns: entry holds that table alone: another table's new column is synced, and mason add takes the entry at once (issue 1074)", { skip, timeout: 600_000 }, async () => {
  const tag = `${TAG}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const dbUrl = (() => { const u = new URL(adminUrl!); u.pathname = `/${tag}`; return u.toString(); })();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${TAG}-`)));
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
    if (fs.existsSync(path.join(root, ".mason"))) {
      const s = spawnSync(process.execPath, [MAIN, "destroy", "--json"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
      if (s.status !== 0) console.error(`mason destroy at the end: ${s.stdout}${s.stderr}`);
    }
    psql(adminUrl!, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE t1 (id int PRIMARY KEY, a text); INSERT INTO t1 SELECT g, 'a' || g FROM generate_series(1, 5) g; " +
    "CREATE TABLE t3 (id int PRIMARY KEY, amount_total int, note text); INSERT INTO t3 SELECT g, g * 10, 'n' || g FROM generate_series(1, 5) g; " +
    // two tables synced, polled and streamed, each beside a table whose name differs only in case and holds a secret
    "CREATE TABLE accents (id int PRIMARY KEY, v text); INSERT INTO accents SELECT g, 'lower' || g FROM generate_series(1, 4) g; " +
    "CREATE TABLE \"Accents\" (id int PRIMARY KEY, w text, secret text); INSERT INTO \"Accents\" SELECT g * 100, 'UPPER' || g, 'S' || g FROM generate_series(1, 3) g; " +
    "CREATE TABLE bravo (id int PRIMARY KEY, v text); INSERT INTO bravo SELECT g, 'lower' || g FROM generate_series(1, 4) g; " +
    "CREATE TABLE \"Bravo\" (id int PRIMARY KEY, w text, secret text); INSERT INTO \"Bravo\" SELECT g * 100, 'UPPER' || g, 'S' || g FROM generate_series(1, 3) g");
  ok(mason("init", dbUrl, "--json"), "mason init");
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^sync: off {3}#.*$/m, "sync: poll 1s"));
  ok(mason("add", "t1", "--json"), "mason add t1 (every column)");
  ok(mason("add", "t3", "--columns", "id,amount_total", "--json"), "mason add t3 --columns id,amount_total");
  ok(mason("add", "accents", "--json"), "mason add accents");
  ok(mason("add", "bravo", "--sync", "replication", "--json"), "mason add bravo --sync replication");
  ok(mason("start", "--json"), "mason start");
  ok(mason("wait", "--timeout", "120", "--json"), "mason wait");
  const api = ok(mason("user", "add", "it", "--json"), "mason user add").json.url as string;
  const status = (): Record<string, unknown> => mason("status", "--json").json;
  const line = (table: string): Line | undefined => (status().tables as Line[] | undefined)?.find((x) => x.table === table);
  const t3Before = psqlWithHeader(api, "SELECT * FROM public.t3 ORDER BY id");
  assert.deepEqual(t3Before, { columns: "id\tamount_total", rows: psql(dbUrl, "SELECT id, amount_total FROM t3 ORDER BY id") });
  const servesAsSource = (tbl: string): boolean => JSON.stringify(psqlWithHeader(api, `SELECT * FROM public.${tbl} ORDER BY id`)) === JSON.stringify({ columns: "id\tv", rows: psql(dbUrl, `SELECT id, v FROM ${tbl} ORDER BY id`) });

  // BY HAND, an entry whose table's name differs only in case from a synced one's: above the polled one, below the
  // streamed one (the review of PR 1091: one written first was taken, and the two shared one synced table)
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").replace(/^tables:\n/m, "tables:\n  Accents: {}\n")}  Bravo: {}\n`);
  // t3's listed column renamed, and a row of it changed: its entry names a column the table no longer has
  psql(dbUrl, "ALTER TABLE t3 RENAME COLUMN amount_total TO amount_total2; UPDATE t3 SET amount_total2 = amount_total2 + 1000 WHERE id = 1");
  await until("t3's line to say it is not synced", () => (line("public.t3")?.error ?? null) !== null);

  // ANOTHER TABLE'S COLUMN CHANGE IS TAKEN: t1's new column synced, with no restart
  psql(dbUrl, "ALTER TABLE t1 ADD COLUMN b int DEFAULT 7");
  const t1Expected = { columns: "id\ta\tb", rows: psql(dbUrl, "SELECT id, a, b FROM t1 ORDER BY id") };
  await until("t1's new column to be synced", () => JSON.stringify(psqlWithHeader(api, "SELECT * FROM public.t1 ORDER BY id")) === JSON.stringify(t1Expected));

  // T3 IS HELD: it serves what it holds, under its old columns, never the renamed one under its new name
  assert.deepEqual(psqlWithHeader(api, "SELECT * FROM public.t3 ORDER BY id"), t3Before, "t3 serves what it holds");
  const held = line("public.t3")!;
  assert.match(held.error ?? "", new RegExp(`^public\\.t3 is not synced: mason/sources/${tag}\\.yml: tables\\.t3\\.columns: public\\.t3 has no column amount_total — did you mean \`amount_total2\`\\? .*` +
    "Mason holds the table and serves its synced data as it was\\. To sync its columns as the database names them now, write columns: \\[id, amount_total2\\] on tables\\.t3, " +
    "then run mason stop && mason start\\. Or run mason add t3 --columns id,amount_total2 while Mason runs, which takes it at once\\.$"), held.error ?? "");
  assert.equal(line("public.t1")?.error ?? null, null, "t1 is not held");

  // THE SYNCED TABLES OF A CASE CLASH ARE KEPT CURRENT, whichever entry comes first; the new entries never synced, said
  psql(dbUrl, "INSERT INTO accents VALUES (5, 'lower5'); INSERT INTO bravo VALUES (5, 'lower5')");
  await until("accents (polled) and bravo (streamed) to stay current", () => servesAsSource("accents") && servesAsSource("bravo"));
  for (const t of ["Accents", "Bravo"]) assert.equal(psqlWithHeader(api, `SELECT * FROM public."${t}"`), null, `public."${t}" is never served`);
  const warnings = (status().warnings as string[] | undefined) ?? [];
  for (const [t, other] of [["Accents", "accents"], ["Bravo", "bravo"]]) {
    assert.ok(warnings.includes(`public.${t} is not synced: mason/sources/${tag}.yml: tables.${t}: public.${t} and public.${other} (tables.${other}) have names that differ only in case. ` +
      `The synced data cannot hold both. Remove one of the two entries. Mason does not sync it until that is fixed. Once that is fixed, run mason stop && mason start. Or run mason remove ${t} to take its entry out.`), warnings.join("\n"));
  }
  assert.deepEqual([line("public.accents")?.error ?? null, line("public.bravo")?.error ?? null], [null, null], "the synced tables are not held");
  // the new entries taken out by hand: taken at the next read of the file (mason add below), nothing dropped
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("  Accents: {}\n", "").replace("  Bravo: {}\n", ""));

  // THE WAY OUT IT SAYS, TAKEN AT ONCE: synced again whole, the column as the database names it now
  ok(mason("add", "t3", "--columns", "id,amount_total2", "--json"), "mason add t3 --columns id,amount_total2");
  const t3Expected = { columns: "id\tamount_total2", rows: psql(dbUrl, "SELECT id, amount_total2 FROM t3 ORDER BY id") };
  await until("t3 to be synced with amount_total2", () => JSON.stringify(psqlWithHeader(api, "SELECT * FROM public.t3 ORDER BY id")) === JSON.stringify(t3Expected));
  await until("t3's line to say it is synced", () => { const l = line("public.t3"); return l !== undefined && l.error === null && l.sync?.state === "synced"; });
  assert.ok(servesAsSource("accents") && servesAsSource("bravo"), "accents and bravo still served whole");
});
