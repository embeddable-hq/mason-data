/**
 * `mason init demo` END TO END: every command a real process (tests/cli-matrix.ts `runMason`), against the real demo
 * database the run hosts (PGlite on a loopback port, src/demo/source.ts) — init, a command while the run is down, the
 * background start with its demo step, the copy of the three tables init adds, the fourth added by the person with
 * `mason add order_items` while the run is up and copied, the writer's orders reaching the copy and the
 * Postgres API, the stop that keeps the demo database, a second start that opens it again (and answers --json with its
 * Postgres API), the three refusals before a run (a held port, an edited URL, a table set to sync: replication), and the destroy that
 * removes it and the start that seeds it again.
 * The pieces' own tests are tests/cli-demo.test.ts, tests/demo-source.test.ts and tests/cli-project.test.ts; this is
 * the one that runs them together, as a person does.
 *
 * The steps share one project and run in order (each `test` of the `describe` waits for the one before). The run is
 * ALWAYS ended: `after` runs `mason stop`, and a run that is still alive after it — found by its recorded pid, checked
 * by its command line as mason stop checks it — is killed with its supervisor, said on stderr. The Postgres API listens
 * on a port chosen here outside the kernel's ephemeral range (MASON_PG_PORT, tests/test-ports.ts), never 5433, and the
 * demo's port is moved to another such port in .env's URL, so nothing else on the machine is handed either. Needs
 * DuckDB's `postgres` extension: installed on the first use (the network), then read from ~/.duckdb/extensions; where
 * it cannot load (offline, never installed) the suite is SKIPPED with the reason (`postgresExtension`).
 */
import { after, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import pg from "pg";
import { DuckDBInstance } from "@duckdb/node-api";
import { matrixEnv, runMason, type Answer } from "./cli-matrix.ts";
import { alive, masonProcess } from "../src/cli/runs.ts";
import { supervisorOf } from "../src/cli/supervise.ts";
import { unassignedPort } from "./test-ports.ts";

/**
 * WHETHER THIS MACHINE CAN COPY AT ALL: the copy loads DuckDB's `postgres` extension (src/duck/sync.ts), which INSTALL
 * downloads the first time on a machine. A throwaway in-memory DuckDB asks the same; null when it loads, else why not —
 * so an offline machine without it is a visible SKIP with the reason ("couldn't tell"), never a failure or a silent pass.
 */
async function postgresExtension(): Promise<string | null> {
  const instance = await DuckDBInstance.create(":memory:");
  const c = await instance.connect();
  try { await c.run("INSTALL postgres; LOAD postgres;"); return null; }
  catch (e) { return (e as Error).message; }
  finally { c.closeSync(); instance.closeSync(); }
}
const noExtension = await postgresExtension();
const skip = noExtension === null ? false
  : `DuckDB's postgres extension did not load (${noExtension}); the first copy on a machine with network installs it (then ~/.duckdb/extensions), and this runs`;

/** What a failed command said, for an assertion's message. */
const said = (a: Answer): string => `exit ${a.code}\n--- stdout\n${a.stdout}\n--- stderr\n${a.stderr}`;

// the real path: the run names its folders by it (macOS: /var is /private/var)
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mason-demo-start-")));
const home = path.join(root, ".mason");
const demoDir = path.join(home, "demo");
// BOTH PORTS OUT OF THE KERNEL'S REACH (tests/test-ports.ts): each is bound by every mason start below, minutes after
// it is picked, and a port probed free from the ephemeral range (a listen(0) let go) was taken in between in CI by
// whatever else drew from that pool (another test file, the run's own command server): a port probed free and used
// later is a race. A port outside the range the kernel assigns, claimed for this process, is handed to no one else
const pgPort = await unassignedPort();
// the writer quick (a round every 0.3 s), and the poll too (the sources file's sync: poll 1s, written below), so the copy
// is seen keeping up within seconds
const env = matrixEnv({ MASON_PG_PORT: String(pgPort), MASON_DEMO_CHANGE_MS: "300" });
const mason = (argv: string[], timeoutMs = 120_000): Promise<Answer> => runMason(root, argv, env, timeoutMs);
const config = (): { name: string; demo?: boolean; running?: { pid: number } | null } => JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
const envUrl = (): string => /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(path.join(root, ".env"), "utf8"))?.[1] ?? "";
let demoPort = 0;
let demoUrl = "";

/** `body` (a start and what it checks), then `mason stop` whatever happened in it, so a step that fails leaves no run
 *  up for the next: the stop's own failure is the step's when the body passed, else said beside the body's. */
async function thenStop(body: () => Promise<void>): Promise<void> {
  let passed = false;
  try { await body(); passed = true; }
  finally {
    const stop = await mason(["stop"]);
    if (passed) assert.equal(stop.code, 0, said(stop));
    else if (stop.code !== 0) process.stderr.write(`cli-demo-start: mason stop after a failed step failed too:\n${said(stop)}\n`);
  }
}

after(async () => {
  // the run ended whatever happened above: mason stop first, as a person stops it
  if (fs.existsSync(path.join(home, "config.json"))) {
    const stop = await mason(["stop"]);
    if (stop.code !== 0) process.stderr.write(`cli-demo-start: mason stop at the end failed:\n${said(stop)}\n`);
    // a run mason stop did not end: its supervisor first (so it starts nothing again), then the run, each a pid
    // checked by its command line (a number alone may be another process's)
    const sup = supervisorOf(home);
    if (sup !== null) { process.stderr.write(`cli-demo-start: killing the supervisor left behind (pid ${sup})\n`); process.kill(sup, "SIGKILL"); }
    const pid = config().running?.pid;
    if (pid !== undefined && alive(pid) && masonProcess(pid)) { process.stderr.write(`cli-demo-start: killing the run left behind (pid ${pid})\n`); process.kill(pid, "SIGKILL"); }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// a skipped suite counts no test in the runner's summary: one skipped test carries the reason to `ℹ skipped`
if (skip !== false) test("mason init demo end to end, as a person drives it", { skip }, () => undefined);
describe("mason init demo, then the run as a person drives it", { timeout: 150_000, skip }, () => {
  test("mason init demo writes the demo's URL to .env, three of its four tables to the sources file (order_items left to add), demo: true to the config", async () => {
    const init = await mason(["init", "demo"]);
    assert.equal(init.code, 0, said(init));
    demoUrl = envUrl();
    const m = /^postgres:\/\/demo@127\.0\.0\.1:(\d+)\/demo$/.exec(demoUrl);
    assert.ok(m, `.env's DATABASE_URL is the demo's: ${demoUrl}`);
    demoPort = Number(m[1]);
    assert.notEqual(demoPort, pgPort);
    const sources = fs.readFileSync(path.join(root, "mason", "sources", "demo.yml"), "utf8");
    assert.match(sources, /^url: \$\{DATABASE_URL\}/m);
    for (const t of ["customers", "products", "orders"]) assert.match(sources, new RegExp(`^ {2}${t}: \\{\\}$`, "m"));
    assert.doesNotMatch(sources, /order_items/, "order_items is the person's to add");
    // the demo's tables are polled every 5 s (its sync: at the file's top); here every second, as a person would edit it
    assert.match(sources, /^sync: poll 5s {3}# /m, "mason init demo polls every table");
    const sourcesFile = path.join(root, "mason", "sources", "demo.yml");
    fs.writeFileSync(sourcesFile, sources.replace(/^sync: poll 5s /m, "sync: poll 1s "));
    assert.equal(config().demo, true);
    // the roles file every project starts with (stage 1b): every user reads every copied table, said in a committed file
    assert.match(fs.readFileSync(path.join(root, "mason", "roles.yml"), "utf8"), /^default: everything {3}# [^\n]*\n\nroles:\n {2}everything:\n {4}tables: all /m);
    assert.ok(!fs.existsSync(demoDir), "nothing is hosted before mason start");
    // THE DEMO ON A PORT THE OS NEVER HANDS OUT (out of its ephemeral range, claimed: tests/test-ports.ts), never the 5434 init prefers (src/cli/demo.ts DEMO_PORT): init takes 5434
    // whenever it is free at that moment, and another run of this file (a second worktree's check), another test's demo
    // or the developer's own demo in another folder may hold it by the time this one starts or is asked "not
    // running". The port lives in .env's URL alone by design (demoPort), so the URL is the place to move it
    // (never pgPort: one process is never handed a port twice)
    const own = await unassignedPort();
    fs.writeFileSync(path.join(root, ".env"), fs.readFileSync(path.join(root, ".env"), "utf8").replace(demoUrl, `postgres://demo@127.0.0.1:${own}/demo`));
    demoUrl = envUrl();
    demoPort = own;
    assert.equal(demoUrl, `postgres://demo@127.0.0.1:${own}/demo`, "the demo's URL moved to the port picked out of the OS's range");
  });

  test("mason tables before any start: the failure shape, the demo database runs inside mason start", async () => {
    const t = await mason(["tables"]);
    assert.equal(t.code, 1, said(t));
    assert.match(t.stderr, new RegExp(`^✗ mason tables: could not connect to postgres://demo@127\\.0\\.0\\.1:${demoPort}/demo: the demo database is not running on 127\\.0\\.0\\.1:${demoPort}$`, "m"));
    assert.match(t.stderr, /^ {2}fix +the demo database runs inside mason start: start it first$/m);
    assert.match(t.stderr, /^Next:\n {2}mason start +the demo database and Mason, in the background$/m);
    const j = await mason(["tables", "--json"]);
    assert.equal(j.code, 1, said(j));
    const v = JSON.parse(j.stdout) as { error: { code: string; fix: string }; next: { command: string }[] };
    assert.equal(v.error.code, "unreachable");
    assert.match(v.error.fix, /the demo database runs inside mason start/);
    assert.deepEqual(v.next.map((n) => n.command), ["mason start"]);
  });

  test("mason start: the demo database first, seeded, then connected to, then the demo's line; again, already running", async () => {
    const s = await mason(["start"]);
    assert.equal(s.code, 0, said(s));
    const step = s.stdout.indexOf(`✓ Demo database on 127.0.0.1:${demoPort} (Postgres, hosted by this process in .mason/demo; seeded with the shop schema)`);
    const connected = s.stdout.search(new RegExp(`✓ Connected to postgres://demo@127\\.0\\.0\\.1:${demoPort}/demo: Postgres 18[.\\d]*, 4 table\\(s\\)`));
    assert.ok(step >= 0, `the demo step: ${said(s)}`);
    assert.ok(connected > step, `connected after the demo step: ${said(s)}`);
    // the roles line, once, after the listener's: what a user added without --role reads (src/cli/roles.ts rolesDefaultLine)
    assert.match(s.stdout, /^ {2}1 role from mason\/roles\.yml \(everything\); default: everything \(a user added without --role\)$/m, said(s));
    // the run's lines in one column (src/cli/background.ts relays them)
    assert.match(s.stdout, new RegExp(`^ {2}Postgres API {2}postgres://<user>:<password>@127\\.0\\.0\\.1:${pgPort}/${config().name} {2}\\(mason user add <name> makes a user\\)$`, "m"));
    assert.match(s.stdout, /^ {2}Demo {10}a new order lands every 0\.3 s: mason status shows the copy keeping up$/m);
    // what to run next, the web page first: a first-time user's most useful next step
    assert.match(s.stdout.slice(s.stdout.lastIndexOf("Next:")), /^Next:\n {2}mason ui +the status, tables, users and statements, in your browser\n {2}mason tables +the database's tables, and what you can add\n {2}mason add <table> +copy a table into Mason\n {2}mason user add <name> +a user for a BI tool or your app: its password and URL, printed once\n {2}mason status +what Mason is doing\n {2}mason logs +its log: every copy, poll and statement\n {2}mason stop +stop Mason; the next mason start resumes where it stopped\n?$/, said(s));
    assert.ok(fs.existsSync(demoDir), ".mason/demo/ is made");
    const again = await mason(["start", "--json"]);
    assert.equal(again.code, 0, said(again));
    const v = JSON.parse(again.stdout) as { running: boolean; pid: number };
    assert.equal(v.running, true);
    assert.equal(v.pid, config().running?.pid);
  });

  test("mason wait, then mason status: the three added tables copied, the demo database polled", async () => {
    const w = await mason(["wait", "--timeout", "60"]);
    assert.equal(w.code, 0, said(w));
    assert.match(w.stdout, /^Ready: every added table is copied and served\.$/m);
    const j = await mason(["status", "--json"]);
    assert.equal(j.code, 0, said(j));
    const st = JSON.parse(j.stdout) as { source: { demo: boolean; changes: string }; tables: { table: string; added: boolean; copy: { phase: string } | null }[] };
    assert.equal(st.source.demo, true);
    assert.equal(st.source.changes, "poll");
    // the database's four, the three init added copied, order_items there and not added: no copy
    assert.deepEqual(st.tables.map((t) => [t.table, t.added, t.copy?.phase ?? null]).sort(),
      [["public.customers", true, "done"], ["public.order_items", false, null], ["public.orders", true, "done"], ["public.products", true, "done"]]);
    const text = await mason(["status"]);
    assert.equal(text.code, 0, said(text));
    assert.match(text.stdout, new RegExp(`the demo database Mason hosts \\(postgres://demo@127\\.0\\.0\\.1:${demoPort}/demo · Postgres 18[.\\d]*\\)`));
    assert.match(text.stdout, /^ {2}Changes +each table as its sync: says \(a SELECT of its changed rows\) · sync: poll 1s for every table without its own · the demo database is checked this way only$/m);
    assert.match(text.stdout, /^Tables \(3 of 4 added\):$/m);
    for (const t of ["customers", "products", "orders"]) assert.match(text.stdout, new RegExp(`^ {2}public\\.${t} +█+ 100% +[\\d,]+ rows · copied · polled every 1s, (last \\d+ s ago|not polled yet)$`, "m"));
  });

  test("mason add order_items while the run is up, then mason wait: the fourth table lands in the sources file and is copied", async () => {
    const a = await mason(["add", "order_items"]);
    assert.equal(a.code, 0, said(a));
    assert.match(fs.readFileSync(path.join(root, "mason", "sources", "demo.yml"), "utf8"), /^ {2}order_items: \{\}$/m);
    const w = await mason(["wait", "--timeout", "60"]);
    assert.equal(w.code, 0, said(w));
    assert.match(w.stdout, /^Ready: every added table is copied and served\.$/m);
    const j = await mason(["status", "--json"]);
    assert.equal(j.code, 0, said(j));
    const st = JSON.parse(j.stdout) as { tables: { table: string; added: boolean; copy: { phase: string } | null; duck: { rows: number } | null }[] };
    assert.deepEqual(st.tables.map((t) => [t.table, t.added, t.copy?.phase ?? null]).sort(),
      [["public.customers", true, "done"], ["public.order_items", true, "done"], ["public.orders", true, "done"], ["public.products", true, "done"]]);
    const items = st.tables.find((t) => t.table === "public.order_items");
    assert.ok((items?.duck?.rows ?? 0) > 12_000, `about 15,000 order items copied: ${JSON.stringify(items)}`);
    const text = await mason(["status"]);
    assert.equal(text.code, 0, said(text));
    assert.match(text.stdout, /^Tables \(4 of 4 added\):$/m);
    assert.match(text.stdout, /^ {2}public\.order_items +█+ 100% +[\d,]+ rows · copied · polled every 1s, (last \d+ s ago|not polled yet)$/m);
  });

  test("the writer: its orders in the log, in the copy and through the Postgres API", async () => {
    const log = fs.readFileSync(path.join(home, "mason.log"), "utf8");
    assert.match(log, /\[demo\] order \d+ placed by customer \d+ /);
    const rows = async (): Promise<number> => {
      const j = await mason(["status", "--json"]);
      assert.equal(j.code, 0, said(j));
      const orders = (JSON.parse(j.stdout) as { tables: { table: string; duck: { rows: number } | null }[] }).tables.find((t) => t.table === "public.orders");
      assert.ok(orders?.duck, `orders is copied: ${j.stdout.slice(0, 400)}`);
      return orders.duck.rows;
    };
    const u = await mason(["user", "add", "t", "--json"]);
    assert.equal(u.code, 0, said(u));
    const user = JSON.parse(u.stdout) as { user: string; password: string; host: string; port: number; database: string };
    assert.equal(user.port, pgPort);
    const client = new pg.Client({ host: user.host, port: user.port, database: user.database, user: user.user, password: user.password });
    await client.connect();
    try {
      const count = async (): Promise<number> => Number((await client.query<{ n: string }>("SELECT count(*) AS n FROM orders")).rows[0]!.n);
      const [copied, served] = [await rows(), await count()];
      // a round every 0.3 s, a poll every second: three seconds are several orders
      await new Promise((r) => setTimeout(r, 3_000));
      const [copied2, served2] = [await rows(), await count()];
      assert.ok(copied2 > copied, `the copy's orders grew: ${copied} then ${copied2}`);
      assert.ok(served2 > served, `the Postgres API's orders grew: ${served} then ${served2}`);
    } finally { await client.end(); }
  });

  test("mason stop: exit 0, the demo database closed and kept in .mason/demo", async () => {
    const s = await mason(["stop"]);
    assert.equal(s.code, 0, said(s));
    assert.match(s.stdout, new RegExp(`^Stopped ${config().name}\\n {2}kept +its copy of the data and its state and the demo database \\(\\.mason/demo\\)$`, "m"));
    assert.ok(fs.existsSync(demoDir), ".mason/demo/ stays");
    // the run's own words, at its stop (its terminal: mason logs --start)
    const l = await mason(["logs", "--start"]);
    assert.equal(l.code, 0, said(l));
    assert.ok(l.stdout.includes(`closed the demo database (it stays in ${demoDir}; mason destroy removes it)`), said(l));
  });

  test("a second mason start keeps the demo database from the last run; with --json, where its Postgres API is", async () => {
    await thenStop(async () => {
      const s = await mason(["start"]);
      assert.equal(s.code, 0, said(s));
      assert.ok(s.stdout.includes(`✓ Demo database on 127.0.0.1:${demoPort} (Postgres, hosted by this process in .mason/demo; kept from the last run)`), said(s));
    });
    await thenStop(async () => {
      // the answer an agent reads (its help: { running, pid, postgres: { url, host, port, database, sslmode }, next })
      const j = await mason(["start", "--json"]);
      assert.equal(j.code, 0, said(j));
      const v = JSON.parse(j.stdout) as { running: boolean; postgres: { host: string; port: number; database: string } | null; next: { command: string }[] };
      assert.equal(v.running, true);
      assert.equal(v.next[0]?.command, "mason ui", "the web page is the first thing to run next, for an agent too");
      assert.deepEqual(v.postgres && { host: v.postgres.host, port: v.postgres.port, database: v.postgres.database }, { host: "127.0.0.1", port: pgPort, database: config().name });
    });
  });

  test("the demo's port held by something else: mason start refuses, naming the port and mason stop", async () => {
    const holder = net.createServer();
    await new Promise<void>((res, rej) => { holder.once("error", rej); holder.listen(demoPort, "127.0.0.1", () => res()); });
    try {
      const s = await mason(["start"]);
      assert.notEqual(s.code, 0, said(s));
      const all = s.stdout + s.stderr;
      assert.match(all, /the demo database did not start: /);
      assert.match(all, new RegExp(`${demoPort}.*mason stop ends a run that may still hold it`));
    } finally { await new Promise<void>((res) => holder.close(() => res())); }
  });

  test("DATABASE_URL in .env edited to another URL: mason start refuses, saying what the demo's is", async () => {
    const file = path.join(root, ".env");
    const was = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, was.replace(demoUrl, `postgres://demo@localhost:${demoPort}/demo`));
    try {
      const s = await mason(["start"]);
      assert.notEqual(s.code, 0, said(s));
      assert.match(s.stdout + s.stderr, new RegExp(`DATABASE_URL in \\.env was changed: the demo database is postgres://demo@127\\.0\\.0\\.1:${demoPort}/demo; mason destroy and mason init demo again`));
      // an agent reads the reason in the failure's why
      const j = await mason(["start", "--json"]);
      assert.equal(j.code, 1, said(j));
      assert.match((JSON.parse(j.stdout) as { error: { why?: string } }).error.why ?? "", /DATABASE_URL in \.env was changed: the demo database is /);
    } finally { fs.writeFileSync(file, was); }
    assert.equal(envUrl(), demoUrl);
  });

  test("a table set to sync: replication: refused in the failure shape before anything starts", async () => {
    const file = path.join(root, "mason", "sources", "demo.yml");
    const was = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, was.replace(/^ {2}orders: \{\}$/m, "  orders: { sync: replication }"));
    try {
      const s = await mason(["start"]);
      assert.equal(s.code, 1, said(s));
      assert.match(s.stderr, /^✗ mason start: the demo database is read by polling only: sync: replication does not apply to it \(orders\)$/m);
      assert.match(s.stderr, /^ {2}fix +write sync: poll 5s for it in mason\/sources\/demo\.yml, then mason start$/m);
      const j = await mason(["start", "--json"]);
      assert.equal(j.code, 1, said(j));
      assert.equal((JSON.parse(j.stdout) as { error: { code: string } }).error.code, "refused");
      assert.equal(config().running ?? null, null, "no run was started");
    } finally { fs.writeFileSync(file, was); }
  });

  test("mason destroy removes the demo database with the copy, and the next mason start seeds it again", async () => {
    const d = await mason(["destroy"]);
    assert.equal(d.code, 0, said(d));
    assert.match(d.stdout, /not the demo database, which went with the copy: the next mason start seeds it again/);
    assert.ok(!fs.existsSync(demoDir), ".mason/demo/ is gone");
    assert.equal(config().demo, true);
    await thenStop(async () => {
      const s = await mason(["start"]);
      assert.equal(s.code, 0, said(s));
      assert.ok(s.stdout.includes(`✓ Demo database on 127.0.0.1:${demoPort} (Postgres, hosted by this process in .mason/demo; seeded with the shop schema)`), said(s));
    });
  });
});
