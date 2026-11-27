/**
 * A REPLICATED TABLE DROPPED, OR MADE AGAIN UNDER ITS NAME, IS NOTICED WITH NOTHING ELSE TO KICK A PASS (issue 1208), end
 * to end against a real Postgres, under `sync: replication`. A DROP or a CREATE sends the stream no change, and a pass
 * ran only when something kicked it, so nothing looked at the table's name again. The table stayed `synced`, served the
 * old table's rows, and the new table's rows never arrived, while `mason status` said it was current. The same with a
 * table renamed away with no write, and an unsynced table renamed into its name.
 *
 * Now the run looks at every replicated table's name and oid on a schedule, in one catalog query, and when `mason status`
 * or `mason sync` asks. A name that is another table now is read again whole as that table (Mason's own publication
 * carries the new table; a named one that does not is said as a gap), and a name that is no table is held by its entry.
 * Meanwhile the table is never said to be current.
 *
 * Each case is a subtest of one project, run one after the other, each only once the one before has settled, so no
 * pass is pending when its change is made. The project replicates its tables alone: nothing is polled, and nothing
 * else runs a pass.
 * - `d1`: dropped, made again and written to, in one transaction. Waited for with no `mason status` asked, so only the
 *   run's own schedule can notice it.
 * - `d2`: dropped alone. Held, said on its line. Made again with rows later: synced as the new table.
 * - `d3`: dropped and made again empty, then written to later.
 * - `d4`: made again and committed, then written to.
 * - `rn`: renamed away with no write, then an unsynced table renamed into its name and written to.
 * With a named publication that lists its tables, the new table is not in it: said as a gap with the line to run, never
 * current, and synced once the publication carries it.
 *
 * What it needs: IT_POSTGRES_URL (`wal_level = logical`), psql on PATH, and DuckDB's postgres extension. Each test
 * writes only inside a database it creates, `it_tdrop_<random>`, drops it at the end, and runs `mason destroy` on its
 * project, so no replication slot is left behind.
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
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const skip = !adminUrl ? "IT_POSTGRES_URL is not set" : !logical ? "IT_POSTGRES_URL's server has no wal_level = logical" : false;

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

interface Ran { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> }
interface Line { error: string | null; state: string | undefined; stream: string | undefined }

/** how long a case may take to settle: the run's look (30 s), a re-read and a whole read, or a held table's look (60 s) */
const SETTLE_MS = 150_000;

async function project(publication: "own" | "named") {
  const tag = `it_tdrop_${publication}_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
  const dbUrl = (() => { const u = new URL(adminUrl!); u.pathname = `/${tag}`; return u.toString(); })();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-tdrop-")));
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
  // at the end of the file, as the other end-to-end tests clean up: a test that fails or times out still drops its run
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
  const tables = ["d1", "d2", "d3", "d4", "rn"];
  psql(dbUrl, [...tables.map((n) => `CREATE TABLE ${n} (id int PRIMARY KEY, v text); INSERT INTO ${n} SELECT g, 'old ${n} ' || g FROM generate_series(1, 5) g`),
    // a table no entry names, renamed into rn's name later
    "CREATE TABLE rn_new (id int PRIMARY KEY, v text); INSERT INTO rn_new SELECT g, 'new rn ' || g FROM generate_series(10, 12) g"].join("; "));
  const pub = `${tag}_pub`;
  if (publication === "named") psql(dbUrl, `CREATE PUBLICATION ${pub} FOR TABLE ${tables.join(", ")}`);
  ok(mason("init", dbUrl, "--json"), "mason init");
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  fs.writeFileSync(file, `kind: postgres\nurl: \${DATABASE_URL}\nsync: replication\n${publication === "named" ? `publication: ${pub}\n` : ""}tables:\n${tables.map((n) => `  ${n}: {}\n`).join("")}`);
  ok(mason("start", "--json"), "mason start");
  ok(mason("wait", "--timeout", "180", "--json"), "mason wait");
  const api = ok(mason("user", "add", "it", "--json"), "mason user add").json.url as string;

  /** a table's rows as the Postgres API serves them, and as the source holds them */
  const served = (n: string): string | null => {
    const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", api, "-c", `SELECT id, v FROM public.${n} ORDER BY id`], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const source = (n: string): string => psql(dbUrl, `SELECT id, v FROM ${n} ORDER BY id`);
  const line = (n: string): Line => {
    const j = mason("status", "--json").json;
    const row = (j.tables as Array<{ table: string; error: string | null; sync?: { state: string } }> | undefined)?.find((x) => x.table === `public.${n}`);
    const stream = (j.stream as { tables?: Array<{ table: string; state: string }> } | undefined)?.tables?.find((x) => x.table === `public.${n}`);
    return { error: row?.error ?? null, state: row?.sync?.state, stream: stream?.state };
  };
  /** synced and current: said synced and streamed, and serving the source's rows */
  const current = (n: string, l: Line): boolean => l.error === null && l.state === "synced" && l.stream === "streamed" && served(n) === source(n);
  /**
   * UNTIL `n` IS CURRENT, and at every look before, NEVER SAID CURRENT WHILE IT SERVES OTHER ROWS than the source's. The
   * first look waits 6 s after the change, so the run's last look at the database (at most every 5 s) is after it.
   * `lags`: an ordinary write to a table already current, which the stream applies a moment later, said current
   * meanwhile as any streamed table is (its lag is the stream's to say): only waited for.
   */
  const settles = async (n: string, what: string, lags = false): Promise<void> => {
    await sleep(6_000);
    for (const end = Date.now() + SETTLE_MS; Date.now() < end; await sleep(1_000)) {
      const l = line(n), rows = served(n), want = source(n);
      if (rows === want && l.error === null && l.state === "synced" && l.stream === "streamed") return;
      assert.ok(lags || rows === want || (l.state !== "synced" && l.stream !== "streamed"), `${what}: said current while it serves other rows: ${JSON.stringify(l)}\nserved:\n${rows}\nsource:\n${want}`);
    }
    throw new Error(`${what}: never current: ${JSON.stringify(line(n))}\nserved:\n${served(n)}\nsource:\n${source(n)}`);
  };
  /** until `check` holds of `n`'s line */
  const until = async (n: string, what: string, check: (l: Line) => boolean): Promise<Line> => {
    for (const end = Date.now() + SETTLE_MS; Date.now() < end; await sleep(1_000)) { const l = line(n); if (check(l)) return l; }
    throw new Error(`${what}: timed out: ${JSON.stringify(line(n))}`);
  };
  const heldLine = (n: string): RegExp => new RegExp(`^public\\.${n} is not synced: mason/sources/[^ ]+\\.yml: tables\\.${n}: \\S+ has no table public\\.${n} this user can read`);
  return { dbUrl, pub, served, source, line, current, settles, until, heldLine, mason, ok };
}

test("sync: replication, Mason's own publication — a table dropped, made again or renamed into is noticed with nothing else running a pass: never said current while it serves the old rows, and synced as the new table (issue 1208)", { skip, timeout: 1_800_000 }, async (t) => {
  const p = await project("own");

  await t.test("d1: dropped, made again and written to in one transaction, noticed by the run's own schedule", async () => {
    psql(p.dbUrl, "BEGIN; DROP TABLE d1; CREATE TABLE d1 (id int PRIMARY KEY, v text); INSERT INTO d1 VALUES (100, 'new d1 100'), (101, 'new d1 101'); COMMIT");
    // nothing asked of the run, not even mason status: only its own look can notice the change
    for (const end = Date.now() + SETTLE_MS; p.served("d1") !== p.source("d1"); await sleep(1_000)) {
      if (Date.now() > end) throw new Error(`d1 never served the new table's rows: ${p.served("d1")}`);
    }
    await p.settles("d1", "d1");
    // and kept current by the stream from then on
    psql(p.dbUrl, "INSERT INTO d1 VALUES (102, 'new d1 102')");
    await p.settles("d1", "d1 after a write", true);
  });

  await t.test("d2: dropped alone, held and said on its line, then made again with rows and synced as the new table", async () => {
    const before = p.served("d2");
    psql(p.dbUrl, "DROP TABLE d2");
    await sleep(6_000);
    const held = await p.until("d2", "d2 held", (l) => p.heldLine("d2").test(l.error ?? ""));
    assert.notEqual(held.state, "synced", JSON.stringify(held));
    assert.notEqual(held.stream, "streamed", JSON.stringify(held));
    assert.equal(p.served("d2"), before, "a held table serves its synced data as it was");
    const wait = p.mason("wait", "d2", "--timeout", "3", "--json");
    assert.notEqual(wait.status, 0, `mason wait never says a dropped table is ready:\n${wait.stdout}${wait.stderr}`);
    psql(p.dbUrl, "CREATE TABLE d2 (id int PRIMARY KEY, v text); INSERT INTO d2 VALUES (200, 'new d2 200')");
    await p.settles("d2", "d2 made again");
  });

  await t.test("d3: dropped and made again empty, then written to later", async () => {
    psql(p.dbUrl, "BEGIN; DROP TABLE d3; CREATE TABLE d3 (id int PRIMARY KEY, v text); COMMIT");
    await p.settles("d3", "d3 made again empty");
    assert.equal(p.served("d3"), "");
    psql(p.dbUrl, "INSERT INTO d3 VALUES (300, 'new d3 300')");
    await p.settles("d3", "d3 written to", true);
  });

  await t.test("d4: made again and committed, then written to", async () => {
    psql(p.dbUrl, "DROP TABLE d4; CREATE TABLE d4 (id int PRIMARY KEY, v text)");
    psql(p.dbUrl, "INSERT INTO d4 VALUES (400, 'new d4 400')");
    await p.settles("d4", "d4 made again");
    const sync = p.ok(p.mason("sync", "d4", "--json"), "mason sync d4").json;
    assert.match(JSON.stringify(sync), /"state":"streamed"/, JSON.stringify(sync));
  });

  await t.test("rn: renamed away with no write, then an unsynced table renamed into its name and written to", async () => {
    psql(p.dbUrl, "ALTER TABLE rn RENAME TO rn_old");
    psql(p.dbUrl, "ALTER TABLE rn_new RENAME TO rn; INSERT INTO rn VALUES (13, 'new rn 13')");
    await p.settles("rn", "rn");
    assert.match(p.served("rn")!, /^13\tnew rn 13$/m);
    // Mason's own publication carries the table of that name now, and no other
    assert.equal(psql(p.dbUrl, "SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_publication_tables WHERE pubname LIKE 'mason%'"), "d1,d2,d3,d4,rn");
  });
});

test("sync: replication, a named publication — a table made again under its name is said as the publication's gap, never current, and synced once the publication carries it; one dropped alone is held (issue 1208)", { skip, timeout: 1_800_000 }, async (t) => {
  const p = await project("named");
  /** said as the publication's gap: not synced, with the line that adds it */
  const gap = (n: string) => p.until(n, `${n} said as the publication's gap`, (l) => l.error !== null && l.error.replace(/\s+/g, " ").includes(`ALTER PUBLICATION ${p.pub} ADD TABLE public.${n};`) && l.state !== "synced" && l.stream !== "streamed");

  await t.test("d1: dropped, made again and written to in one transaction: said as the gap, then synced once the publication carries it", async () => {
    const before = p.served("d1");
    psql(p.dbUrl, "BEGIN; DROP TABLE d1; CREATE TABLE d1 (id int PRIMARY KEY, v text); INSERT INTO d1 VALUES (100, 'new d1 100'); COMMIT");
    await gap("d1");
    assert.equal(p.served("d1"), before, "the old rows serve as they were, said as not synced");
    psql(p.dbUrl, `ALTER PUBLICATION ${p.pub} ADD TABLE d1`);
    psql(p.dbUrl, "INSERT INTO d1 VALUES (101, 'new d1 101')");
    await p.settles("d1", "d1 in the publication");
  });

  await t.test("d2: dropped alone, held and said on its line", async () => {
    psql(p.dbUrl, "DROP TABLE d2");
    await sleep(6_000);
    const held = await p.until("d2", "d2 held", (l) => p.heldLine("d2").test(l.error ?? ""));
    assert.notEqual(held.state, "synced", JSON.stringify(held));
  });

  await t.test("rn: renamed away with no write, then an unsynced table renamed into its name: said as the gap", async () => {
    psql(p.dbUrl, "ALTER TABLE rn RENAME TO rn_old");
    psql(p.dbUrl, "ALTER TABLE rn_new RENAME TO rn; INSERT INTO rn VALUES (13, 'new rn 13')");
    await gap("rn");
    psql(p.dbUrl, `ALTER PUBLICATION ${p.pub} ADD TABLE rn`);
    psql(p.dbUrl, "INSERT INTO rn VALUES (14, 'new rn 14')");
    await p.settles("rn", "rn in the publication");
  });
});
