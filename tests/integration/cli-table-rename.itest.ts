/**
 * A TABLE RENAMED ON THE DATABASE LOSES NO CHANGE, AND IS NEVER SAID TO BE CURRENT WHILE IT IS MISSING ANY (issue 1199),
 * end to end against a real Postgres, under `sync: replication` and under `poll 1s`. The stream knew a table by its name
 * alone: a table renamed away arrived under its new name, matched no synced table, and its changes were passed over and
 * acknowledged, so a row inserted while it was renamed never reached the synced data, even after it was renamed back and
 * Mason restarted. Meanwhile `mason status` said the stream was 0 bytes behind and `mason sync` said nothing was to sync.
 * Under the poll, a renamed table failed its poll every interval with the engine's Binder Error.
 *
 * Mason knows a table by its oid, and the sources file names it. The stream refuses a table it carries under another name,
 * marked behind before anything past the change is acknowledged. A table whose name is no table is read again, and the
 * run holds its entry (issue 1074): said on its line with what to do, and where it is in the log and an event, never
 * synced and never said current. It is looked at again on the database, and caught up by one poll, with every change
 * made meanwhile, once it is back under its name. Each form has a table of its own in one project:
 * - `ev`: renamed away, written to (an insert, an update, a delete), renamed back, written to again.
 * - `mv`: moved to another schema and back, written to meanwhile.
 * - `sa` and `sb`: their names swapped in one transaction, each written to after. Each name is the sources file's, so each
 *   entry is the table of that name now: synced again whole, never held, every row the source's.
 * - `gn`: dropped. Held; the others sync on. Its way out, `mason remove`, drops its hold.
 * - `ev` again with Mason stopped: renamed away, written to, renamed back, written to, then started.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical` for the replication test), psql on PATH, and DuckDB's postgres
 * extension. Each test writes only inside a database it creates, `it_rename_<random>`, drops it at the end, and runs
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
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Mode = "poll 1s" | "replication";
interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
interface Line { error: string | null; state: string | undefined }

const SQL = [
  "CREATE TABLE ev (id int PRIMARY KEY, v text); INSERT INTO ev SELECT g, 'ev' || g FROM generate_series(1, 5) g",
  "CREATE TABLE mv (id int PRIMARY KEY, v text); INSERT INTO mv SELECT g, 'mv' || g FROM generate_series(1, 5) g",
  "CREATE TABLE sa (id int PRIMARY KEY, v text); INSERT INTO sa SELECT g, 'sa' || g FROM generate_series(1, 3) g",
  "CREATE TABLE sb (id int PRIMARY KEY, v text); INSERT INTO sb SELECT g, 'sb' || g FROM generate_series(1, 4) g",
  "CREATE TABLE gn (id int PRIMARY KEY, v text); INSERT INTO gn SELECT g, 'gn' || g FROM generate_series(1, 2) g",
  "CREATE SCHEMA elsewhere",
].join("; ");
const TABLES = ["ev", "mv", "sa", "sb", "gn"];

async function renamed(mode: Mode): Promise<void> {
  const tag = `it_rename_${mode.replace(/\W/g, "")}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const dbUrl = (() => { const u = new URL(adminUrl!); u.pathname = `/${tag}`; return u.toString(); })();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-rename-")));
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
  const text = fs.readFileSync(file, "utf8").replace(/^sync: off {3}#.*$/m, `sync: ${mode}`).replace(/^tables:.*$[\s\S]*/m, `tables:\n${TABLES.map((t) => `  ${t}: {}\n`).join("")}`);
  assert.match(text, new RegExp(`^sync: ${mode}$`, "m"), text);
  fs.writeFileSync(file, text);
  ok(mason("start", "--json"), "mason start");
  ok(mason("wait", "--timeout", "180", "--json"), "mason wait");
  const api = ok(mason("user", "add", "it", "--json"), "mason user add").json.url as string;

  /** a table's rows as the Postgres API serves them, and as the source holds them under `at` */
  const served = (t: string): string | null => {
    const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", api, "-c", `SELECT id, v FROM public.${t} ORDER BY id`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const source = (at: string): string => psql(dbUrl, `SELECT id, v FROM ${at} ORDER BY id`);
  const lines = (): Map<string, Line> => new Map(
    ((mason("status", "--json").json.tables as Array<{ table: string; error: string | null; sync?: { state: string } }> | undefined) ?? [])
      .map((t) => [t.table.replace(/^public\./, ""), { error: t.error, state: t.sync?.state }]));
  const synced = (l: Map<string, Line>, t: string): boolean => l.get(t)?.error === null && l.get(t)?.state === "synced";
  const current = (l: Map<string, Line>, t: string, at = `public.${t}`): boolean => synced(l, t) && served(t) === source(at);
  const errorOf = (l: Map<string, Line>, t: string): string => l.get(t)?.error ?? "";
  /** waits until every check holds at one look */
  const all = async (what: string, checks: Record<string, (l: Map<string, Line>) => boolean>, ms = 90_000): Promise<void> => {
    let failing: string[] = [];
    for (const end = Date.now() + ms; Date.now() < end;) {
      const l = lines();
      failing = Object.entries(checks).filter(([, c]) => !c(l)).map(([k]) => k);
      if (failing.length === 0) return;
      await sleep(400);
    }
    throw new Error(`${mode}: timed out waiting for ${what}; still failing: ${failing.join(", ")}; lines: ${JSON.stringify(Object.fromEntries(lines()))}`);
  };
  /** a table held by its entry, whose name is no table now (issue 1074's hold): its line in mason status */
  const heldLine = (t: string): RegExp => new RegExp(`^public\\.${t} is not synced: mason/sources/[^ ]+\\.yml: tables\\.${t}: \\S+ has no table public\\.${t} this user can read` +
    "( — did you mean `[^`]+`\\?)?\\.? Mason holds the table and serves its synced data as it was\\. ");
  /** what the log and its event say when its name is found to be no table: where it is now */
  const goneLine = (t: string, how: string, now: string): RegExp => new RegExp(`^it was ${how} on the database, and is ${now.replace(".", "\\.")} now: its catalog is read again, and the sources file names it as public\\.${t}, `);

  // AWAY: renamed, moved, swapped and dropped, each written to while away
  psql(dbUrl, "ALTER TABLE ev RENAME TO ev_away; INSERT INTO ev_away VALUES (100, 'while away'); UPDATE ev_away SET v = 'updated away' WHERE id = 2; DELETE FROM ev_away WHERE id = 3");
  psql(dbUrl, "ALTER TABLE mv SET SCHEMA elsewhere; INSERT INTO elsewhere.mv VALUES (100, 'while moved'); DELETE FROM elsewhere.mv WHERE id = 4");
  psql(dbUrl, "BEGIN; ALTER TABLE sa RENAME TO s_tmp; ALTER TABLE sb RENAME TO sa; ALTER TABLE s_tmp RENAME TO sb; COMMIT; " +
    "INSERT INTO sa VALUES (50, 'sa after the swap'); INSERT INTO sb VALUES (50, 'sb after the swap')");
  psql(dbUrl, "DROP TABLE gn");
  await all("each table away held, said on its line, and the swapped ones synced as the tables of their names now", {
    ev: (l) => heldLine("ev").test(errorOf(l, "ev")) && l.get("ev")?.state !== "synced",
    mv: (l) => heldLine("mv").test(errorOf(l, "mv")),
    gn: (l) => heldLine("gn").test(errorOf(l, "gn")),
    sa: (l) => current(l, "sa"),
    sb: (l) => current(l, "sb"),
  });
  // held: its synced data serves as it was, and nothing says it is current
  assert.equal(served("ev"), "1\tev1\n2\tev2\n3\tev3\n4\tev4\n5\tev5", "a held table serves its synced data as it was");
  const sync = mason("sync", "ev", "--json");
  assert.equal(sync.status, 1, `mason sync of a held table is refused:\n${sync.stdout}${sync.stderr}`);
  assert.match(JSON.stringify(sync.json), /has no table public\.ev this user can read/);
  const wait = mason("wait", "ev", "--timeout", "3", "--json");
  assert.notEqual(wait.status, 0, `mason wait never says a held table is ready:\n${wait.stdout}${wait.stderr}`);
  if (mode === "replication") {
    const stream = (mason("status", "--json").json.stream as { tables?: Array<{ table: string; state: string }> } | undefined)?.tables ?? [];
    assert.notEqual(stream.find((t) => t.table === "public.ev")?.state, "streamed", `the stream never says it streams a held table: ${JSON.stringify(stream)}`);
  }
  // said in the log and as events too: where it is now (once), and its hold (again only when its words change)
  const events = ok(mason("logs", "--events", "--json"), "mason logs --events").json.events as Array<{ kind: string; table: string | null; message: string }>;
  assert.equal(events.filter((e) => e.table === "public.ev" && goneLine("ev", "renamed", "public.ev_away").test(e.message)).length, 1, JSON.stringify(events));
  assert.equal(events.filter((e) => e.table === "public.mv" && goneLine("mv", "moved to another schema", "elsewhere.mv").test(e.message)).length, 1, JSON.stringify(events));
  assert.ok(events.some((e) => e.table === "public.ev" && heldLine("ev").test(e.message)), JSON.stringify(events));
  if (mode === "poll 1s") {
    // the poll is held, never failing at every interval with the engine's error
    for (let i = 0; i < 4; i++) { await sleep(1_000); assert.match(errorOf(lines(), "ev"), heldLine("ev")); }
    assert.ok(!events.some((e) => e.kind === "poll_failed" && e.table === "public.ev"), JSON.stringify(events));
  }

  // BACK under their names, and written to again: caught up, every change made while away included
  psql(dbUrl, "ALTER TABLE ev_away RENAME TO ev; INSERT INTO ev VALUES (101, 'after it was back')");
  psql(dbUrl, "ALTER TABLE elsewhere.mv SET SCHEMA public; UPDATE mv SET v = 'after it was back' WHERE id = 1");
  await all("ev and mv caught up once back", { ev: (l) => current(l, "ev"), mv: (l) => current(l, "mv"), sa: (l) => current(l, "sa"), sb: (l) => current(l, "sb") });
  assert.match(served("ev")!, /^100\twhile away$/m);
  assert.match(served("mv")!, /^100\twhile moved$/m);

  // the dropped one's way out: removed, its hold with it (a start refuses an entry that names no table)
  ok(mason("remove", "gn", "--json"), "mason remove gn");
  await all("gn removed", { gn: (l) => !l.has("gn") || served("gn") === null });

  // STOPPED: renamed away, written to, renamed back, written to, then started
  ok(mason("stop", "--json"), "mason stop");
  psql(dbUrl, "ALTER TABLE ev RENAME TO ev_off; INSERT INTO ev_off VALUES (200, 'while stopped and away'); ALTER TABLE ev_off RENAME TO ev; INSERT INTO ev VALUES (201, 'while stopped')");
  ok(mason("start", "--json"), "mason start");
  await all("ev caught up after the start", { ev: (l) => current(l, "ev"), mv: (l) => current(l, "mv") });
  assert.match(served("ev")!, /^200\twhile stopped and away$/m);
  ok(mason("stop", "--json"), "mason stop");
}

test("sync: replication — a table renamed, moved to another schema or dropped on the database is held and said on its line, and caught up with every change made meanwhile once it is back; two tables that swap names are each synced as the table of its name", { skip: skip || (!logical && "IT_POSTGRES_URL's server has no wal_level = logical"), timeout: 900_000 }, () => renamed("replication"));
test("sync: poll — a table renamed, moved to another schema or dropped on the database is held and said on its line, never failing every poll, and caught up once it is back; two tables that swap names are each synced as the table of its name", { skip, timeout: 900_000 }, () => renamed("poll 1s"));
