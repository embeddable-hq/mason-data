/**
 * THE SOURCE'S PASSWORD NEVER REACHES WHAT MASON SAYS when a sync's connection fails (issue 599), against a real
 * Postgres. The run reaches the database through a TCP relay this test holds, so "the server stops" is the relay
 * closing, never the test server's own stop. Three tests:
 * - the engine alone, no mask: the secret path's ATTACH failing (a wrong password, nothing listening) says no
 *   credential, as the extension words it (src/duck/sync.ts `attachPath`, `sourceSecretSql`);
 * - the mask alone, the secret path disabled (`attachSeamForTest`: the old keyword string, password inside): every exit
 *   of the sync — its log, its events, its ledger rows, its state, mason sync's answer — holds no password, and a store
 *   an earlier Mason left with `password='…'` in its ledger is scrubbed at open;
 * - a password too short or plain to mask (`e`, `dev`): the sync's structure — table names, phases, times, the slot's
 *   name — is never rewritten (mason wait ready, mason sync naming the table whole), and an error whose words hold it is
 *   withheld with its code (the review of PR 620: a mask over whole answers left `public.devices` waiting for ever);
 * - the whole run (`mason start`): a table polled every 2 s, one streamed, one added while the database is away; the
 *   password changed under the run, then the relay closed; every log file, the ledger, mason status / logs / wait /
 *   sync in each form and the command server's /api/state, /api/events and /api/logs searched for the password in
 *   every form it could be written in. The store itself (`duck.db`) is read by SQL, never searched byte for byte: the
 *   engine compresses its strings, so a search of the file finds nothing either way.
 *
 * What it needs: IT_POSTGRES_URL (its user may CREATE DATABASE and CREATE ROLE; wal_level = logical for the stream,
 * else that part is left out), psql on PATH. It writes only inside a database and a role it creates, and drops both.
 */
import { test, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { DuckStore } from "../../src/duck/store.ts";
import { Sync, type AddedTable } from "../../src/duck/sync.ts";
import * as syncModule from "../../src/duck/sync.ts";
import { loadPostgresSql } from "../../src/duck/extensions.ts";
import { parseSource } from "../../src/cli/preflight.ts";

// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { attachPath, sourceSecretSql, attachSeamForTest, SRC } = syncModule as unknown as {
  attachPath?: (s: { sslmode: string }) => string;
  attachSeamForTest?: { set(f: (() => string) | null): void };
  sourceSecretSql?: (s: { host: string; port: number; database: string; user: string; password: string }) => string;
  SRC: string;
};

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli", "main.ts");
const adminUrl = process.env.IT_POSTGRES_URL;
const rand = `${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const tag = `it_secret_${rand}`;
const role = `it_secret_${rand}`;
// a password with libpq's, a URL's, SQL's and JSON's specials, and one no message could hold by chance
const PASSWORD = `It'S3cr\\et @%:${rand}"x`;
const NEW_PASSWORD = `rotated_${rand}`;
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "it-secret-")));

function psql(url: string, sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-A", "-t", "-F", "\t", "-v", "ON_ERROR_STOP=1", url, "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql: ${r.stderr.trim()}\n  in: ${sql}`);
  return r.stdout.trim();
}
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const admin = adminUrl ? new URL(adminUrl) : null;
const dbAdmin = admin ? (() => { const u = new URL(admin.href); u.pathname = `/${tag}`; return u.toString(); })() : "";
const logical = adminUrl ? psql(adminUrl, "SHOW wal_level") === "logical" : false;
const skip = adminUrl ? false : "IT_POSTGRES_URL is not set";

/** Every form a message, a file or an answer could hold the password in. */
const FORMS = [...new Set([PASSWORD, encodeURIComponent(PASSWORD), PASSWORD.replace(/\\/g, "\\\\").replace(/'/g, "\\'"),
  PASSWORD.replace(/'/g, "''"), JSON.stringify(PASSWORD).slice(1, -1), JSON.stringify(JSON.stringify(PASSWORD)).slice(3, -3)])];
/** where in `text` the password is, in any form: the offending forms (empty: none) */
const leaks = (text: string): string[] => FORMS.filter((f) => text.includes(f));
const noLeak = (text: string, what: string): void => {
  const found = leaks(text);
  assert.deepEqual(found, [], `${what} holds the source's password (${found.map((f) => JSON.stringify(f)).join(", ")}):\n${text.slice(0, 4000)}`);
};

/** A TCP relay to the test server: Mason reaches the database through it, and its close is the database going away. */
async function relay(host: string, port: number): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    for (const s of [client, upstream]) { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => s.destroy()); }
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(0, "127.0.0.1", () => res()); });
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () => new Promise<void>((res) => { server.close(() => res()); for (const s of sockets) s.destroy(); }),
  };
}

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  s.on("error", reject);
});

/** the role's URL through `port` (the relay), its password encoded as a URL carries it */
const roleUrl = (port: number): string => `postgres://${role}:${encodeURIComponent(PASSWORD)}@127.0.0.1:${port}/${tag}?sslmode=disable`;

let made = false;
async function makeDatabase(): Promise<void> {
  if (made) return;
  psql(adminUrl!, `CREATE DATABASE ${tag}`);
  psql(adminUrl!, `CREATE ROLE ${role} LOGIN REPLICATION PASSWORD ${lit(PASSWORD)}`);
  psql(adminUrl!, `GRANT CONNECT, CREATE ON DATABASE ${tag} TO ${role}`);
  psql(dbAdmin, `CREATE TABLE polled (id int PRIMARY KEY, v text); CREATE TABLE streamed (id int PRIMARY KEY, v text); CREATE TABLE later (id int PRIMARY KEY, v text); ` +
    `INSERT INTO polled SELECT g, 'p' || g FROM generate_series(1, 200) g; INSERT INTO streamed SELECT g, 's' || g FROM generate_series(1, 50) g; ` +
    `INSERT INTO later SELECT g, 'l' || g FROM generate_series(1, 20) g; ` +
    `ALTER TABLE polled OWNER TO ${role}; ALTER TABLE streamed OWNER TO ${role}; ALTER TABLE later OWNER TO ${role}; ANALYZE polled; ANALYZE streamed; ANALYZE later`);
  made = true;
}
const setPassword = (pw: string): void => { psql(adminUrl!, `ALTER ROLE ${role} PASSWORD ${lit(pw)}`); };

after(() => {
  if (adminUrl && made) {
    for (const s of psql(dbAdmin, `SELECT slot_name FROM pg_replication_slots WHERE database = '${tag}'`).split("\n").filter(Boolean)) {
      psql(dbAdmin, `SELECT pg_terminate_backend(active_pid) FROM pg_replication_slots WHERE slot_name = '${s}' AND active_pid IS NOT NULL`);
      psql(dbAdmin, `SELECT pg_drop_replication_slot('${s}')`);
    }
    psql(adminUrl, `DROP DATABASE IF EXISTS ${tag} WITH (FORCE)`);
    psql(adminUrl, `DROP ROLE IF EXISTS ${role}_dev`);
    psql(adminUrl, `DROP ROLE IF EXISTS ${role}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const POLLED: AddedTable = {
  source: "public.polled", schema: "public", table: "polled", key: ["id"], bytes: 0, rows: null, foreignKeys: [],
  columns: [{ name: "id", type: "integer", notNull: true, comment: null }, { name: "v", type: "text", notNull: false, comment: null }],
};

test("the engine alone, no mask: the ATTACH a failed connection repeats holds no credential, a wrong password or nothing listening", { skip }, async () => {
  assert.equal(typeof attachPath, "function", "src/duck/sync.ts attachPath");
  assert.equal(typeof sourceSecretSql, "function", "src/duck/sync.ts sourceSecretSql");
  await makeDatabase();
  const r = await relay(admin!.hostname, Number(admin!.port || 5432));
  const store = await DuckStore.open(path.join(dir, "engine.db"), () => undefined);
  const inst = await DuckDBInstance.create(":memory:", { extension_directory: store.extensions.shipped ? store.extensions.directory : path.join(os.homedir(), ".duckdb", "extensions") });
  const c = await inst.connect();
  await store.close();
  try {
    await c.run(loadPostgresSql(store.extensions));
    const source = { host: "127.0.0.1", port: r.port, database: tag, user: role, password: PASSWORD, sslmode: "disable" };
    const attachSql = `ATTACH '${attachPath!(source).replace(/'/g, "''")}' AS ${SRC} (TYPE postgres, SECRET mason_source_credentials, READ_ONLY)`;
    // it works: the right password through the secret
    await c.run(sourceSecretSql!(source));
    await c.run(attachSql);
    assert.deepEqual((await c.runAndReadAll(`SELECT count(*)::INT FROM ${SRC}.public.polled`)).getRowsJS(), [[200]]);
    noLeak(JSON.stringify((await c.runAndReadAll("SELECT path FROM duckdb_databases()")).getRowsJS()), "duckdb_databases()");
    noLeak(JSON.stringify((await c.runAndReadAll("SELECT secret_string FROM duckdb_secrets()")).getRowsJS()), "duckdb_secrets()");
    await c.run(`DETACH ${SRC}`);
    // a wrong password, then nothing listening: the engine's own words, unmasked
    for (const [what, given] of [["a wrong password", { ...source, password: `${PASSWORD}-wrong` }], ["nothing listening", { ...source, port: await freePort() }]] as const) {
      await c.run(sourceSecretSql!(given));
      let said = "";
      try { await c.run(attachSql); } catch (e) { said = (e as Error).message; }
      assert.match(said, /Unable to connect to Postgres/, `${what}: the ATTACH failed`);
      noLeak(said, `the engine's error, ${what}`);
      assert.ok(!said.includes("password="), `${what}: ${said}`);
    }
  } finally { c.closeSync(); inst.closeSync(); await r.close(); }
});

test("the mask alone, the secret path disabled: no exit of the sync holds the password, and an earlier Mason's ledger rows are scrubbed at open", { skip, timeout: 300_000 }, async () => {
  await makeDatabase();
  const r = await relay(admin!.hostname, Number(admin!.port || 5432));
  const parsed = parseSource(roleUrl(r.port));
  if ("problem" in parsed) throw new Error(parsed.problem);
  const source = parsed.source;
  assert.equal(source.password, PASSWORD);
  // THE OLD KEYWORD STRING, password inside: what the engine repeats when the secret path is not taken
  const q = (x: string | number): string => `'${String(x).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const keywords = `host=${q(source.host)} port=${q(source.port)} dbname=${q(source.database)} user=${q(source.user)} password=${q(PASSWORD)} sslmode=${q(source.sslmode)}`;
  const legacyAttach = `ATTACH '${keywords.replace(/'/g, "''")}' AS ${SRC} (TYPE postgres, READ_ONLY)`;
  const file = path.join(dir, "mask.db");
  // A STORE AN EARLIER MASON LEFT: its ledger holds the old string in a table's error and in an event
  {
    const store = await DuckStore.open(file, () => undefined);
    const w = store.writer;
    await w.run("CREATE SCHEMA IF NOT EXISTS _mason");
    await w.run(`CREATE TABLE _mason.copy_state (source VARCHAR PRIMARY KEY, phase VARCHAR, "rows" BIGINT, bytes BIGINT, seconds DOUBLE, copied_at TIMESTAMPTZ, error VARCHAR, columns JSON)`);
    await w.run(`INSERT INTO _mason.copy_state VALUES ('public.gone', 'failed', NULL, NULL, NULL, NULL, $1, NULL)`, [`could not attach the database: IO Error: Unable to connect to Postgres at "${keywords}": Connection refused`]);
    await w.run("CREATE TABLE _mason.sync_events (happened_at TIMESTAMPTZ, seq BIGINT, kind VARCHAR, table_name VARCHAR, message VARCHAR)");
    await w.run(`INSERT INTO _mason.sync_events VALUES (now(), 1, 'source_unreachable', NULL, $1)`, [`could not attach the database: IO Error: Unable to connect to Postgres at "host='h' password='an-old\\'one' sslmode='prefer'": FATAL`]);
    await store.close();
  }
  const logged: string[] = [];
  const events: string[] = [];
  const store = await DuckStore.open(file, (l) => logged.push(l));
  // the test's seam, never a run's: at a commit without it, that commit's own ATTACH is the old string anyway
  attachSeamForTest?.set(() => legacyAttach);
  const sync = new Sync(store, source, tag, (l) => logged.push(l), 3_600_000, "poll", null, { onEvent: (e) => events.push(JSON.stringify(e)) });
  try {
    await sync.open();
    const ledger = async (): Promise<string> => JSON.stringify([
      ...(await store.writer.runAndReadAll("SELECT source, error FROM _mason.copy_state ORDER BY 1")).getRowsJS(),
      ...(await store.writer.runAndReadAll("SELECT kind, message FROM _mason.sync_events ORDER BY seq")).getRowsJS()]);
    const scrubbed = await ledger();
    noLeak(scrubbed, "the ledger an earlier Mason left, once opened");
    assert.ok(!scrubbed.includes("an-old"), `a password since rotated, in the keyword form, is scrubbed too: ${scrubbed}`);
    assert.ok(logged.some((l) => /^removed the database's password from 2 error row\(s\)/.test(l)), logged.join("\n"));
    // it syncs through the old string: the test's ATTACH is the one taken
    sync.setTables([POLLED]);
    await sync.once();
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase]), [["public.polled", "copied"]], logged.slice(-5).join("\n"));
    // THE PASSWORD CHANGED, then THE DATABASE AWAY: every pass fails with the engine repeating the string
    setPassword(NEW_PASSWORD);
    await sync.once();
    await r.close();
    await sync.once();
    let polled = "";
    try { await sync.pollNow(["public.polled"]); } catch (e) { polled = `${(e as Error).message}\n${(e as Error).stack ?? ""}`; }
    assert.match(polled, /could not|Unable to connect|refused/, "mason sync's failure");
    const exits = { log: logged.join("\n"), events: events.join("\n"), state: JSON.stringify(sync.state()), polled, ledger: await ledger() };
    assert.match(exits.log, /password authentication failed/, "the wrong password was met (else this proves nothing)");
    assert.match(exits.log, /Connection refused|could not connect|ECONNREFUSED/, "the database away was met");
    assert.match(exits.log, /password=\*\*\*\*/, "the engine repeated the string, and the mask fired");
    for (const [what, text] of Object.entries(exits)) noLeak(text, `the sync's ${what}`);
  } finally { attachSeamForTest?.set(null); await sync.stop(); await store.close(); setPassword(PASSWORD); }
});

test("a password too short or plain to mask: the sync's structure is never rewritten, and an error whose words hold it is withheld with its code", { skip, timeout: 300_000 }, async () => {
  await makeDatabase();
  const r = await relay(admin!.hostname, Number(admin!.port || 5432));
  // `e`: in every phase's name (copied), the table's (polled), and the words of most errors
  setPassword("e");
  const parsed = parseSource(`postgres://${role}:e@127.0.0.1:${r.port}/${tag}?sslmode=disable`);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const logged: string[] = [];
  const events: string[] = [];
  const store = await DuckStore.open(path.join(dir, "short.db"), (l) => logged.push(l));
  const sync = new Sync(store, parsed.source, tag, (l) => logged.push(l), 3_600_000, "poll", null, { onEvent: (e) => events.push(JSON.stringify(e)) });
  try {
    await sync.open();
    sync.setTables([POLLED]);
    await sync.once();
    const [st] = sync.state();
    const ledger = (await store.writer.runAndReadAll("SELECT source, phase, epoch_ms(copied_at) FROM _mason.copy_state")).getRowsJS() as [string, string, number | bigint][];
    assert.deepEqual([st?.source, st?.phase, st?.copiedAt], [ledger[0]![0], ledger[0]![1], new Date(Number(ledger[0]![2])).toISOString()], "the state as the ledger holds it, nothing rewritten");
    assert.deepEqual([st?.source, st?.phase, st?.kept?.by], ["public.polled", "copied", "poll"]);
    assert.ok(!Number.isNaN(Date.parse(st!.copiedAt!)));
    const polled = await sync.pollNow(["public.polled"]);
    assert.deepEqual(polled.tables.map((t) => t.table), ["public.polled"], "mason sync names the table whole");
    // THE PASSWORD CHANGED: the engine's error says the user's name and the database's, which hold `e`
    setPassword(NEW_PASSWORD);
    psql(adminUrl!, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`);
    await sync.once();
    let refused = "";
    try { await sync.pollNow(["public.polled"]); } catch (e) { refused = (e as Error).message; }
    const failures = events.filter((e) => /"kind":"(source_unreachable|poll_failed)"/.test(e)).join("\n");
    assert.match(failures, /an error( \([^)]+\))? whose words are not shown: they hold the database user's password, or a word equal to it/, failures);
    assert.match(refused, /an error( \([^)]+\))? whose words are not shown/, refused);
    assert.doesNotMatch(`${failures}\n${refused}\n${logged.join("\n")}`, /\*\*\*\*/, "nothing masked inside words: withheld whole");
    assert.deepEqual(sync.state().map((s) => [s.source, s.phase]), [["public.polled", "copied"]], "the table as it was, its name whole");
  } finally { await sync.stop(); await store.close(); await r.close(); setPassword(PASSWORD); }
});

test("mason start under the password `dev` beside a table named devices: mason wait ready, mason sync and status name it whole, the slot's name unchanged, and an error holding it withheld", { skip, timeout: 900_000 }, async () => {
  await makeDatabase();
  const devRole = `${role}_dev`;
  psql(adminUrl!, `CREATE ROLE ${devRole} LOGIN REPLICATION PASSWORD 'dev'`);
  psql(adminUrl!, `GRANT CONNECT, CREATE ON DATABASE ${tag} TO ${devRole}`);
  psql(dbAdmin, `CREATE TABLE devices (id int PRIMARY KEY, v text); INSERT INTO devices SELECT g, 'device ' || g FROM generate_series(1, 100) g; ` +
    `CREATE TABLE devlog (id int PRIMARY KEY, v text); INSERT INTO devlog SELECT g, 'd' || g FROM generate_series(1, 10) g; ` +
    `ALTER TABLE devices OWNER TO ${devRole}; ALTER TABLE devlog OWNER TO ${devRole}; ANALYZE devices; ANALYZE devlog`);
  const r = await relay(admin!.hostname, Number(admin!.port || 5432));
  const root = path.join(dir, "devapp"), home = path.join(dir, "devhome");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  const machineExtensions = path.join(os.homedir(), ".duckdb");
  if (fs.existsSync(machineExtensions)) fs.cpSync(machineExtensions, path.join(home, ".duckdb"), { recursive: true });
  const env = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(await freePort()) };
  const mason = (...args: string[]): Promise<{ status: number | null; out: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, out }); });
  });
  const ok = (x: { status: number | null; out: string }, what: string): string => { assert.equal(x.status, 0, `${what}:\n${x.out}`); return x.out; };
  try {
    ok(await mason("init", `postgres://${devRole}:dev@127.0.0.1:${r.port}/${tag}?sslmode=disable`, "--name", "devsecret", "--json"), "mason init");
    const file = fs.readdirSync(path.join(root, "mason", "sources")).map((f) => path.join(root, "mason", "sources", f))[0]!;
    fs.writeFileSync(file, `kind: postgres\nurl: \${DATABASE_URL}\ntables:\n  devices: { sync: poll 2s }\n${logical ? "  devlog: { sync: replication }\n" : ""}`);
    ok(await mason("start", "--json"), "mason start");
    const waited = JSON.parse(ok(await mason("wait", "--timeout", "120", "--json"), "mason wait")) as { ready: boolean; tables: { table: string }[] };
    assert.equal(waited.ready, true);
    assert.deepEqual(waited.tables.map((t) => t.table).sort(), logical ? ["public.devices", "public.devlog"] : ["public.devices"]);
    const synced = ok(await mason("sync", "devices", "--json"), "mason sync");
    assert.match(synced, /"table": ?"public\.devices"/, synced);
    const status = JSON.parse(ok(await mason("status", "--json"), "mason status")) as Record<string, unknown>;
    const text = JSON.stringify(status);
    assert.match(text, /"public\.devices"/);
    // the source's URL is shown with its password masked (src/cli/preflight.ts maskedUrl): nothing else is
    assert.doesNotMatch(text, /\*\*\*\*(?!@)/, "nothing in the status is masked but the URL's password");
    if (logical) {
      const slot = psql(dbAdmin, `SELECT slot_name FROM pg_replication_slots WHERE database = '${tag}' AND slot_name LIKE '%devsecret%'`);
      assert.match(slot, /dev/, "the slot's name holds the password's letters (else this proves nothing)");
      assert.ok(text.includes(`"${slot}"`), `the status names the slot ${slot} whole`);
    }
    // THE PASSWORD CHANGED UNDER THE RUN: the error's words name the user (dev…), so they are withheld, its code kept
    psql(adminUrl!, `ALTER ROLE ${devRole} PASSWORD ${lit(NEW_PASSWORD)}`);
    psql(adminUrl!, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${devRole}'`);
    const until = Date.now() + 180_000;
    let events = "";
    while (!/whose words are not shown/.test(events)) {
      if (Date.now() > until) assert.fail(`no failure seen in 180 s:\n${events.slice(-3000)}`);
      await new Promise((res) => setTimeout(res, 1000));
      events = ok(await mason("logs", "--events", "--json"), "mason logs --events");
    }
    for (const [what, out] of [["events", events], ["logs", (await mason("logs", "-n", "1000")).out], ["status", (await mason("status", "--json")).out]] as const) {
      assert.doesNotMatch(out, /password='?dev'?\b|:dev@|public\.\*\*\*\*ices/, `${what} holds the password or a masked name:\n${out.slice(-3000)}`);
    }
  } finally {
    await mason("stop", "--json");
    await r.close();
  }
});

test("mason start: the password changed under the run, then the database away — no log file, ledger row, mason output or command-server answer holds it", { skip, timeout: 900_000 }, async () => {
  await makeDatabase();
  const r = await relay(admin!.hostname, Number(admin!.port || 5432));
  const root = path.join(dir, "app"), home = path.join(dir, "home");
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  // DuckDB's postgres extension where the machine has it (the run downloads nothing it has: src/duck/extensions.ts)
  const machineExtensions = path.join(os.homedir(), ".duckdb");
  if (fs.existsSync(machineExtensions)) fs.cpSync(machineExtensions, path.join(home, ".duckdb"), { recursive: true });
  const env = { PATH: process.env.PATH ?? "", HOME: home, MASON_PG_PORT: String(await freePort()) };
  // never spawnSync: the relay is this process's, and a blocked event loop relays nothing
  const mason = (...args: string[]): Promise<{ status: number | null; out: string }> => new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.once("close", (status) => { clearTimeout(timer); resolve({ status, out }); });
  });
  const ok = (x: { status: number | null; out: string }, what: string): string => { assert.equal(x.status, 0, `${what}:\n${x.out}`); return x.out; };
  ok(await mason("init", roleUrl(r.port), "--name", "secret", "--json"), "mason init");
  const file = fs.readdirSync(path.join(root, "mason", "sources")).map((f) => path.join(root, "mason", "sources", f))[0]!;
  fs.writeFileSync(file, `kind: postgres\nurl: \${DATABASE_URL}\ntables:\n  polled: { sync: poll 2s }\n${logical ? "  streamed: { sync: replication }\n" : ""}`);
  const mhome = path.join(root, ".mason");
  try {
    ok(await mason("start", "--json"), "mason start");
    ok(await mason("wait", "--json"), "mason wait, before");
    const running = (JSON.parse(fs.readFileSync(path.join(mhome, "config.json"), "utf8")) as { running: { controlUrl: string; token: string } }).running;
    const api = async (route: string): Promise<string> => {
      const res = await fetch(running.controlUrl + route, { headers: { Authorization: `Bearer ${running.token}` }, signal: AbortSignal.timeout(60_000) });
      return `${res.status} ${await res.text()}`;
    };
    /** the run's events, until `pattern` is among them (bounded) */
    const eventually = async (pattern: RegExp, what: string): Promise<void> => {
      const until = Date.now() + 180_000;
      for (;;) {
        const seen = await api("/api/events?limit=1000");
        if (pattern.test(seen)) return;
        if (Date.now() > until) assert.fail(`${what}: not seen in 180 s:\n${seen.slice(-3000)}`);
        await new Promise((res) => setTimeout(res, 1000));
      }
    };
    // THE PASSWORD CHANGED UNDER THE RUN: the next poll's attach fails, and the stream's next connection
    setPassword(NEW_PASSWORD);
    // and the stream's connection now ended, so it connects again (with the old password)
    psql(adminUrl!, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`);
    await eventually(/password authentication failed/, "the poll's failure with the wrong password");
    // A TABLE ADDED WHILE THE DATABASE REFUSES: its first sync fails at the attach
    await mason("add", "later", "--json");
    // THEN THE DATABASE AWAY
    await r.close();
    await eventually(/Connection refused|ECONNREFUSED|could not connect/, "the failure with the database away");
    if (logical) await eventually(/"kind":"stream_failed"/, "the stream's failure");
    // every exit, each form
    const outputs: Record<string, string> = {};
    for (const args of [["status"], ["status", "--json"], ["logs"], ["logs", "--json"], ["logs", "-n", "1000"], ["logs", "--start"], ["logs", "--start", "--json"],
      ["logs", "--events"], ["logs", "--events", "--json"], ["logs", "--events", "--failed"], ["logs", "--events", "--failed", "--json"],
      ["wait", "--timeout", "3"], ["wait", "--timeout", "3", "--json"], ["sync", "polled"], ["sync", "polled", "--json"], ["sync", "later", "--json"]]) {
      outputs[`mason ${args.join(" ")}`] = (await mason(...args)).out;
    }
    for (const route of ["/api/state", "/api/events?limit=10000", "/api/events?limit=10000&failed=1", "/api/logs"]) outputs[`GET ${route}`] = await api(route);
    assert.match(outputs["mason logs -n 1000"]!, /password authentication failed/, "the run met the wrong password (else this proves nothing)");
    assert.match(outputs["GET /api/state"]!, /later/, "the table added while the database was away is in the state");
    for (const [what, text] of Object.entries(outputs)) noLeak(text, what);
  } finally {
    await mason("stop", "--json");
    await r.close();
    setPassword(PASSWORD);
  }
  // EVERY FILE THE RUN WROTE, byte for byte (the logs, the config), but the store: the engine compresses its strings, so
  // the ledger is read by SQL below
  const files: string[] = [];
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(mhome);
  assert.ok(files.some((f) => f.endsWith("mason.log")) && files.some((f) => f.endsWith("dev.log")), files.join("\n"));
  for (const f of files.filter((f) => !/duck\.db(\.wal)?$/.test(f))) noLeak(fs.readFileSync(f).toString("latin1") + fs.readFileSync(f, "utf8"), f);
  const inst = await DuckDBInstance.create(path.join(mhome, "duck.db"), { access_mode: "READ_ONLY" });
  const c = await inst.connect();
  try {
    const rows = JSON.stringify([...(await c.runAndReadAll("SELECT source, error FROM _mason.copy_state")).getRowsJS(),
      ...(await c.runAndReadAll("SELECT kind, table_name, message FROM _mason.sync_events")).getRowsJS()]);
    assert.match(rows, /password authentication failed/, "the ledger recorded the failure");
    noLeak(rows, "the ledger");
  } finally { c.closeSync(); inst.closeSync(); }
});
