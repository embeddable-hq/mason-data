/**
 * A PROJECT 0.7.0 STREAMED, STARTED BY THIS MASON, AGAINST A REAL POSTGRES (src/cli/replication-mode.ts recordRefusal).
 * 0.7.0 chose replication on the command line and recorded it in `.mason/config.json`; the sources file says it now, and
 * a file that is silent must cost the source nothing: refused with the slot, the publication and the config untouched.
 * Each way through is then run, `mason start` and `mason serve` both. The 0.7.0 config is this run's own with the one key
 * only 0.7.0 wrote (`changes`, read from the v0.7.0 tag's src/cli/dev.ts) put back, its file as 0.7.0 wrote it: no `sync:`.
 *
 * What it needs: IT_POSTGRES_URL with wal_level = logical (skipped otherwise), psql on PATH, and DuckDB's postgres
 * extension. It writes only inside a database it creates, `it_upgrade_<random>`, and drops it (and its slots) at the end.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");
const adminUrl = process.env.IT_POSTGRES_URL;
const tag = `it_upgrade_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const dbUrl = adminUrl ? (() => { const u = new URL(adminUrl); u.pathname = `/${tag}`; return u.toString(); })() : "";
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-upgrade-")));
const KEY = "u".repeat(48);

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const skip = !adminUrl ? "IT_POSTGRES_URL is not set" : logical ? false : "wal_level is not logical";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

const slots = (): string => psql(dbUrl, `SELECT string_agg(slot_name, ',' ORDER BY slot_name) FROM pg_replication_slots WHERE database = '${tag}'`);
const publications = (): string => psql(dbUrl, "SELECT string_agg(pubname, ',' ORDER BY pubname) FROM pg_publication");
/** rows read from `table` by any scan since the counters were reset, its statistics flushed by the backends that ended */
const rowsRead = async (table: string): Promise<number> => {
  await new Promise((r) => setTimeout(r, 1500));
  return Number(psql(dbUrl, `SELECT coalesce(seq_tup_read, 0) FROM pg_stat_user_tables WHERE relname = '${table}'`));
};

after(() => {
  if (adminUrl && logical) {
    // a slot nobody dropped would hold the test server's WAL
    for (const s of psql(dbUrl, `SELECT slot_name FROM pg_replication_slots WHERE database = '${tag}'`).split("\n").filter(Boolean)) psql(dbUrl, `SELECT pg_drop_replication_slot('${s}')`);
    psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Ran { status: number | null; out: string; json: Record<string, unknown> }
function ranOf(args: string[], root: string, env: Record<string, string>): Ran {
  const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: root, env, encoding: "utf8", timeout: 300_000 });
  let json: Record<string, unknown> = {};
  if (args.includes("--json")) {
    try { json = JSON.parse(r.stdout) as Record<string, unknown>; } catch { throw new Error(`mason ${args.join(" ")}: not JSON (exit ${r.status}):\n${r.stdout}${r.stderr}`); }
  }
  return { status: r.status, out: r.stdout + r.stderr, json };
}
const errorOf = (r: Ran): { code: string; message: string; fix: string } => r.json.error as { code: string; message: string; fix: string };
/** what 0.7.0 left: the file with no `sync:` line, `changes` in the config, a slot and a publication on the database */
const asV07 = (config: string): void => {
  fs.writeFileSync(config, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")) as object, changes: "replication" }, null, 2)}\n`);
};
const SOURCE = (lines: string): string => `kind: postgres\nurl: \${DATABASE_URL}\n${lines}tables:\n  items: {}\n  notes: {}\n`;

test("mason start over a project 0.7.0 streamed: refused with nothing touched; sync: replication keeps the slot with no scan; a named publication refused until said; sync: poll confirms the drop; mason destroy still drops", { skip, timeout: 600_000 }, async () => {
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(dbUrl, "CREATE TABLE items (id int PRIMARY KEY, v text); CREATE TABLE notes (id int PRIMARY KEY, v text); " +
    "INSERT INTO items SELECT g, 'v' || g FROM generate_series(1, 200) g; INSERT INTO notes SELECT g, 'n' || g FROM generate_series(1, 50) g; " +
    "CREATE PUBLICATION owner_pub FOR TABLE items, notes");
  // analysed, as a real table is: a start counts a table that never was (src/cli/preflight.ts), which is a scan of its own
  psql(dbUrl, "ANALYZE items");
  psql(dbUrl, "ANALYZE notes");
  const root = path.join(dir, "app"), home = path.join(dir, "home");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const pgPort = await freePort();
  const env = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(pgPort) };
  const mason = (...args: string[]): Ran => ranOf(args, root, env);
  const ok = (r: Ran, what: string): Ran => { assert.equal(r.status, 0, `${what}:\n${r.out}`); return r; };
  ok(mason("init", dbUrl, "--name", "upgrade", "--json"), "mason init");
  const file = path.join(root, "mason", "sources", `${tag}.yml`);
  const config = path.join(root, ".mason", "config.json");
  const start = (what: string): void => { ok(mason("start", "--json"), what); ok(mason("wait", "--json"), `${what}: mason wait`); };
  const stop = (): void => { ok(mason("stop", "--json"), "mason stop"); };

  // a project streaming through Mason's own, as 0.7.0's start --replication left it
  fs.writeFileSync(file, SOURCE("sync: replication\n"));
  start("the first start");
  stop();
  const slot = slots();
  assert.match(slot, /^mason_dev_upgrade_/);
  const ownPublications = publications();
  assert.equal(ownPublications, `${slot},owner_pub`, "Mason's own beside the owner's");
  fs.writeFileSync(file, SOURCE(""));
  asV07(config);
  const was = fs.readFileSync(config, "utf8");

  // REFUSED: as one Failure, with the source and the machine as they were
  const refused = mason("start", "--json");
  assert.equal(refused.status, 1, refused.out);
  assert.equal(errorOf(refused).code, "refused");
  assert.match(errorOf(refused).message, /^this project streams, and mason\/sources\/.*\.yml does not say so/);
  assert.match(errorOf(refused).fix, /write sync: replication at the top of .*confirm it with sync: off or sync: poll <interval> there$/);
  assert.equal(fs.readFileSync(config, "utf8"), was, "the config untouched");
  assert.deepEqual([slots(), publications()], [slot, ownPublications], "the slot and the publication untouched");
  const attached = mason("start", "--attach");
  assert.equal(attached.status, 1, attached.out);
  assert.equal(fs.readFileSync(config, "utf8"), was, "the run wrote nothing either");
  assert.deepEqual([slots(), publications()], [slot, ownPublications]);

  // WAY THROUGH: sync: replication keeps the slot, reads no table whole, and what changed meanwhile arrives by the stream
  psql(dbUrl, "SELECT pg_stat_reset()");
  psql(dbUrl, "INSERT INTO items VALUES (1001, 'while it was stopped')");
  fs.writeFileSync(file, SOURCE("sync: replication\n"));
  start("sync: replication");
  assert.equal(slots(), slot, "the same slot");
  const api = ok(mason("user", "add", "it", "--json"), "mason user add").json.url as string;
  let seen = "";
  for (let i = 0; i < 60 && seen !== "201"; i++) { seen = psql(api, "SELECT count(*) FROM public.items"); if (seen !== "201") await new Promise((r) => setTimeout(r, 500)); }
  assert.equal(seen, "201", "the row inserted while stopped, by the stream");
  stop();
  assert.equal(await rowsRead("items"), 0, "no scan of the source's table: nothing copied again");
  assert.equal(await rowsRead("notes"), 0);
  assert.equal("changes" in (JSON.parse(fs.readFileSync(config, "utf8")) as object), false, "the older record goes once the file said it");

  // A RECORDED PUBLICATION: the owner's named at 0.7.0's --publication, then the line left out
  fs.writeFileSync(file, SOURCE("sync: replication\npublication: owner_pub\n"));
  start("publication: owner_pub");
  stop();
  assert.equal(publications(), "owner_pub", "Mason's own dropped by the switch to a named one");
  fs.writeFileSync(file, SOURCE("sync: replication\n"));
  asV07(config);
  const named = fs.readFileSync(config, "utf8");
  assert.equal((JSON.parse(named) as { publication: string }).publication, "owner_pub");
  const unnamed = mason("start", "--json");
  assert.equal(unnamed.status, 1, unnamed.out);
  assert.match(errorOf(unnamed).message, /^this project reads publication owner_pub, and .* does not name it$/);
  assert.match(errorOf(unnamed).fix, /write publication: owner_pub at the top of .*; for a publication of Mason's own, write publication: null there$/);
  assert.equal(fs.readFileSync(config, "utf8"), named, "the config untouched");
  assert.deepEqual([slots(), publications()], [slot, "owner_pub"], "nothing made on the source");
  // the two ways through: the line, then Mason's own on purpose
  fs.writeFileSync(file, SOURCE("sync: replication\npublication: owner_pub\n"));
  start("publication: owner_pub again");
  stop();
  assert.deepEqual([slots(), publications()], [slot, "owner_pub"]);
  fs.writeFileSync(file, SOURCE("sync: replication\npublication: null\n"));
  start("publication: null");
  stop();
  assert.deepEqual([slots(), publications()], [slot, ownPublications], "Mason's own made, on purpose; the owner's left");
  assert.equal((JSON.parse(fs.readFileSync(config, "utf8")) as { publication: string | null }).publication, null, "the record follows the file");
  fs.writeFileSync(file, SOURCE("sync: replication\n"));
  start("the line taken out once the record has followed");
  stop();

  // WAY THROUGH: sync: poll says it does not stream, and the drop runs, verified
  fs.writeFileSync(file, SOURCE(""));
  asV07(config);
  assert.equal(mason("start", "--json").status, 1);
  fs.writeFileSync(file, SOURCE("sync: poll 1h\n"));
  start("sync: poll 1h");
  stop();
  assert.deepEqual([slots(), publications()], ["", "owner_pub"], "the slot and Mason's own gone, the owner's left");
  const after_ = JSON.parse(fs.readFileSync(config, "utf8")) as Record<string, unknown>;
  assert.deepEqual([after_.replication, "changes" in after_], [null, false]);

  // mason destroy is no start: a refused project still drops what it made
  fs.writeFileSync(file, SOURCE("sync: replication\n"));
  start("streaming again");
  stop();
  assert.notEqual(slots(), "");
  fs.writeFileSync(file, SOURCE(""));
  asV07(config);
  assert.equal(mason("start", "--json").status, 1);
  ok(mason("destroy", "--json"), "mason destroy");
  assert.deepEqual([slots(), publications()], ["", "owner_pub"], "mason destroy drops the slot and Mason's own");
});

test("mason serve over a volume 0.7.0 streamed: refused with nothing touched; sync: replication keeps the slot; sync: off confirms the drop", { skip, timeout: 600_000 }, async () => {
  const name = `${tag}_s`;
  const url = (() => { const u = new URL(adminUrl!); u.pathname = `/${name}`; return u.toString(); })();
  psql(adminUrl!, `CREATE DATABASE ${name}`);
  const data = path.join(dir, "serve-data"), project = path.join(dir, "serve-project");
  const file = path.join(project, "sources", "app.yml");
  fs.mkdirSync(data);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const [health, pgPort] = [await freePort(), await freePort()];
  const env = { PATH: process.env.PATH ?? "", HOME: dir, DATABASE_URL: url, MASON_API_KEY: KEY, MASON_DATA: data, MASON_PROJECT: project, MASON_NAME: "upserve",
    MASON_HEALTH_PORT: String(health), MASON_HEALTH_HOST: "127.0.0.1", MASON_PG_PORT: String(pgPort) };
  const slotsHere = (): string => psql(url, `SELECT string_agg(slot_name, ',') FROM pg_replication_slots WHERE database = '${name}'`);
  const pubsHere = (): string => psql(url, "SELECT string_agg(pubname, ',') FROM pg_publication");
  /** a serve up, until /healthz answers 200, then stopped by SIGTERM */
  const serveOnce = async (): Promise<void> => {
    const child = spawn(process.execPath, [MAIN, "serve"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    let exited: number | null | undefined;
    const exit = new Promise<void>((r) => child.once("exit", (c) => { exited = c; r(); }));
    let up = false;
    for (let i = 0; i < 480 && !up && exited === undefined; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try { up = (await fetch(`http://127.0.0.1:${health}/healthz`)).status === 200; }
      catch (e) { if ((e as { cause?: { code?: string } }).cause?.code !== "ECONNREFUSED") throw e; }   // not listening yet: keep waiting
    }
    assert.ok(up, `mason serve did not come up:\n${out}`);
    child.kill("SIGTERM");
    await exit;
    assert.equal(exited, 0, out);
  };
  try {
    psql(url, "CREATE TABLE items (id int PRIMARY KEY, v text); INSERT INTO items SELECT g, 'v' || g FROM generate_series(1, 100) g");
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: replication\ntables:\n  items: {}\n");
    await serveOnce();
    const slot = slotsHere();
    assert.match(slot, /^mason_dev_upserve_/);
    const pub = pubsHere();
    const config = path.join(data, ".mason", "config.json");
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  items: {}\n");
    asV07(config);
    const was = fs.readFileSync(config, "utf8");
    const refused = ranOf(["serve", "--json"], dir, env);
    assert.equal(refused.status, 1, refused.out);
    assert.equal(errorOf(refused).code, "refused");
    assert.match(errorOf(refused).message, /^this project streams, and .*does not say so/);
    assert.equal(fs.readFileSync(config, "utf8"), was, "the config untouched");
    assert.deepEqual([slotsHere(), pubsHere()], [slot, pub]);

    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: replication\ntables:\n  items: {}\n");
    await serveOnce();
    assert.deepEqual([slotsHere(), pubsHere()], [slot, pub], "the same slot, kept");
    assert.equal("changes" in (JSON.parse(fs.readFileSync(config, "utf8")) as object), false);

    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\ntables:\n  items: {}\n");
    asV07(config);
    assert.equal(ranOf(["serve", "--json"], dir, env).status, 1);
    fs.writeFileSync(file, "kind: postgres\nurl: ${DATABASE_URL}\nsync: off\ntables:\n  items: {}\n");
    await serveOnce();
    assert.deepEqual([slotsHere(), pubsHere()], ["", ""], "the file said off: the drop ran");
  } finally {
    for (const s of slotsHere().split(",").filter(Boolean)) psql(url, `SELECT pg_drop_replication_slot('${s}')`);
    psql(adminUrl!, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
});
