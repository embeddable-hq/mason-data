/**
 * THE COLD MODE OF scripts/bench-replica.ts (`--cold`, docs/BENCHMARK.md "The cold mode"): how long one query takes on
 * a Postgres and on Mason the first time, with one client and with ten. It is the published run.
 *
 *   node scripts/bench-replica.ts --cold --label "<the machine>" --disk "<the disk>" --memory 8GiB --out tests/fixtures/bench-replica.json
 *     --sizes 1M,10M,100M   --clients 1,10   --runs 3
 *     --disk "<words>"      the disk both engines read, recorded and published ("EBS gp3, 125 MB/s, 3000 IOPS")
 *     --cpus <n>            each engine's container's CPUs (default this machine's)
 *     --memory <n>GiB       each engine's container's memory, the page cache included, no swap (default half the RAM)
 *     --mason-image <ref>   default ghcr.io/embeddable-hq/mason-data:<this checkout's version>
 *     --postgres-image <ref> default postgres:18 (pgbench, the client, is from it too)
 *     --settle 10           seconds after an engine answers, before the page cache is dropped
 *     --work <dir>          the run's files: secrets in 0600 files, the client's script and logs (default the OS temp dir)
 *     --reserve-gb 60       a size whose disk on both engines would leave less free than this is skipped, said
 *     --keep-postgres       leave the bench-pg container, its data and the bench-replica network for the next run
 *     --reuse-postgres      adopt the bench-pg container a --keep-postgres run left, once that run has ended
 *     --resume              keep the sizes --out finished, measure the rest
 *     --engines mason       measure Mason alone, and keep Postgres's cells from --postgres-from (default postgres,mason)
 *     --mason-commit <sha>  the commit the Mason image was built from, recorded and named for an image that says "dev"
 *     --postgres-from <f>   with --engines mason: the earlier cold run whose Postgres cells are kept
 *                           (default tests/fixtures/bench-replica.json). Give --out another file
 *
 * MASON ALONE (--engines mason) re-measures Mason after a change to Mason only, in about half the time. Postgres still
 * runs, as Mason's source, and is restarted before each of Mason's runs as before. A statement with no per-client
 * literal that the earlier run sent as this one sends it (the count, the revenue) is not measured on Postgres: its
 * Postgres cells are copied unchanged from --postgres-from, once Postgres's answer to it is that run's answer. Its data
 * comes from setseed() and random(), so data made again gives the same answers. The lookup asks for rows sampled in this
 * run (the order ids are random), so it is measured on both engines, and so is a statement the earlier run did not send
 * (the revenue in Asia/Kathmandu, for a run before it). The fixture marks each copied cell (`copied`) and records the run
 * (environment.postgresFrom). The run refuses, before anything with a side effect, an earlier run that is not a
 * complete cold run, or that differs from this one in its data, the statements it sent, clients, runs, settle, limits,
 * Postgres image, disk or label, or lacks a size this run measures. Once its Postgres answers, it refuses one of another
 * version or settings, and a size where Postgres's answer to a statement it would copy is not the earlier run's.
 *
 * THE DATA (COLD_DATA, `coldDataSql`): the warm mode's orders and customers, with random UUID primary keys and no
 * index on status, in databases of their own (`bench_replica_cold_<rows>`). The fixture records it. Mason's sources
 * file (SOURCES_FILE) names the reference orders.customer_id → customers.id, which the data does not declare.
 *
 * MASON'S OWN WORK. After `mason wait` says the first sync is done, the run waits until Mason's log says it built the
 * side table for lookups by orders.id (where one is expected, `sideTableExpected`) and numbered the reference's hidden
 * keys (`backgroundLeft`), at most an hour, and records how long that took (`backgroundSeconds`). Then it restarts Mason
 * once, and fails unless Mason says the keys are numbered again, does not build the side table again, and runs a lookup
 * and the join on them under EXPLAIN (ANALYZE, VERBOSE) (`restartProblems`).
 *
 * WHAT IS MEASURED. Four statements (COLD_STATEMENTS), sent as written to both engines: a count over every row, a sum
 * by month over a join, the same sum in a session whose time zone is Asia/Kathmandu, and one row by its primary key.
 * Each session's time zone is UTC, or the statement's own, set as it starts (libpq's PGTZ). Each size × client count ×
 * statement × engine is run --runs times. In each run every client sends the statement once, all at the same moment, and the run records each client's
 * time. A client's time excludes its connection. The cell's time is the median over the runs of the slowest client:
 * the time until every client has its answer. Each run also records what the measured engine's container read from
 * disk while pgbench ran (and, beside Mason, the idle Postgres's), from its cgroup v2 io.stat; where that cannot be
 * read, the run refuses at its start.
 *
 * COLD. Before every run, the engine is restarted (its own buffers emptied), the run waits until it answers
 * `SELECT 1 FROM orders LIMIT 0`, waits --settle seconds more, and drops the OS page cache (root, by `sudo -n`; the run
 * refuses plainly where it cannot). The probe also makes Mason start its catalog, which its first connection does.
 *
 * FAIR. Each engine runs in a container with the same --cpus, --memory and --memory-swap (no swap). A cgroup v2 limit
 * counts the page cache, so both get the same cache. Mason is the `mason-data` image, which sizes its engine at half
 * the container's limit. Mason is stopped while Postgres is measured. Postgres stays up while Mason is measured,
 * because a Mason start reads its source's catalog, but it is idle and restarted first. Both hold the same rows: Mason
 * syncs them from the bench's Postgres (`sync: off`), and every answer is compared before anything is timed.
 *
 * THE CLIENT is pgbench from the Postgres image, in a container of its own on the host's network:
 * `pgbench -n -c N -j N -t 1 -f <script> --log`. Each client's time is read from its per-transaction log. For the
 * lookup each client asks for a different row, sampled from the data once per size and recorded in the fixture, as a
 * quoted UUID literal chosen by pgbench's `\if :client_id = …`. A literal chosen inside the SQL (`CASE :client_id WHEN 0 THEN …`)
 * stops Mason's engine from pushing the filter down, and makes Mason look many times slower than it is.
 *
 * Secrets (Postgres's password, Mason's API key, the bench user's password) go to 0600 env files in a 0700 folder,
 * never a command line or the log. Mason's project is copied into its container (`docker cp`), so the container's
 * user reads it wherever --work is.
 *
 * ANOTHER RUN IS NEVER TOUCHED. A cold run holds a lock (/tmp/bench-replica-cold.lock, whatever $TMPDIR says: its
 * boot, pid namespace, pid and start tick, from /proc) from its start to its end. Before it drops the page cache it
 * also makes a container, bench-replica-owner, never started, labelled with the same owner: Docker allows one of a name,
 * so it holds the bench's Postgres (one it made, or one it adopted) whatever /tmp it sees. One whose holder may be alive refuses the run, and so does one
 * it cannot check. A warm run refuses too while a cold run holds it. A bench-pg, bench-mason or bench-client container,
 * or a Mason volume of a size to be measured, that is already there is refused too, before anything else (the page
 * cache is not dropped either). --reuse-postgres adopts only a bench-pg whose owner (its label) has ended. A check
 * Docker cannot answer refuses, and only Docker's "no such" means absent. At the end the run removes what
 * it made itself, by the ids Docker gave back: its containers, volumes, network and files. --keep-postgres keeps its
 * Postgres, and a Postgres container adopted with --reuse-postgres is not removed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DATA_DAYS, DATA_START, TENANTS, Usage, commit, customersOf, docker, ensureData, fmtRows, freePort, median, parseCount, postgresFacts, replicaSettings, round } from "./bench-replica.ts";
import type { DataShape } from "./bench-replica.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), "..");
const PG_CONTAINER = "bench-pg";
const MASON_CONTAINER = "bench-mason";
const CLIENT_CONTAINER = "bench-client";
const NETWORK = "bench-replica";
/** the network alias Mason syncs Postgres by */
const PG_ALIAS = "pg";
/** a size's disk on both engines, by the row, before any size was measured here: 1 M rows of the cold data measured
 *  376 bytes a row in Postgres (its tables and indexes) and about 103 in Mason's synced data */
const BYTES_PER_ROW = 500;
/** the label on the Postgres container a cold run made: the run that owns it (`ownerOf`) */
const OWNER_LABEL = "mason-bench.owner";
/**
 * THE OWNER, IN DOCKER: a container never started, named for the run holding the bench's Postgres (its label), made by
 * every cold run before it touches anything, and removed when it ends. Docker refuses a second container of a name, so
 * two runs cannot both hold it, whatever /tmp or $TMPDIR each sees. A label on bench-pg itself cannot say a later run
 * adopted it: Docker cannot change a container's labels.
 */
const OWNER_CONTAINER = "bench-replica-owner";
/** how long an engine may take to answer after its restart, or Mason its first sync */
const READY_TIMEOUT_MS = 30 * 60_000;

// --------------------------------------------------------------------------------------------- the data

/**
 * THE COLD MODE'S DATA: the warm mode's rows (the same orders and customers, from `generate_series`), with random UUID
 * primary keys, and no index on status. It is its own database (`bench_replica_cold_<rows>`), with its own marker, so
 * neither mode reuses the other's. Recorded in the fixture as it is here, so a fixture of other data cannot render as
 * this run's.
 */
export const COLD_DATA = {
  version: 1,
  /** the primary keys' type: orders.id and customers.id, and orders.customer_id */
  keys: "uuid",
  /** every index, as a read replica would have them; none on orders (status), so the count reads every row on both */
  indexes: ["customers (id), its primary key", "orders (id), its primary key", "orders (tenant_id, created_at)", "orders (created_at)"],
} as const;
export type ColdData = { version: number; keys: string; indexes: string[] };

/**
 * The cold data's SQL. orders.id is a random v4 UUID (`gen_random_uuid()`); a customer's id is the md5 of its number as a
 * UUID, so an order's customer_id is computed from the customer's number with no join, uniformly spread and the same in
 * every run. created_at rises with the heap's order, as an append-only table's does. The primary keys are added after
 * the rows, as one sorted build each.
 */
export function coldDataSql(rows: number): string[] {
  const nc = customersOf(rows);
  return [
    "SELECT setseed(0.42)",
    "CREATE TABLE public.customers (id uuid NOT NULL, tenant_id integer NOT NULL, name text NOT NULL, email text NOT NULL, created_at timestamptz NOT NULL)",
    `INSERT INTO public.customers SELECT md5('customer' || g)::uuid, 1 + g % ${TENANTS}, 'Customer ' || g, 'customer' || g || '@example.com', ` +
      `timestamptz '${DATA_START}' + (g::float8 / ${nc}) * interval '${DATA_DAYS} days' FROM generate_series(1, ${nc}) g`,
    "ALTER TABLE public.customers ADD PRIMARY KEY (id)",
    "CREATE TABLE public.orders (id uuid NOT NULL, tenant_id integer NOT NULL, customer_id uuid NOT NULL, status text NOT NULL, " +
      "amount numeric(12,2) NOT NULL, created_at timestamptz NOT NULL, payload jsonb NOT NULL, note text)",
    `INSERT INTO public.orders SELECT gen_random_uuid(), 1 + c % ${TENANTS}, md5('customer' || c)::uuid, ` +
      "CASE WHEN r < 0.05 THEN 'pending' WHEN r < 0.45 THEN 'paid' WHEN r < 0.75 THEN 'shipped' WHEN r < 0.93 THEN 'delivered' WHEN r < 0.98 THEN 'cancelled' ELSE 'refunded' END, " +
      "round((5 + random() * 495)::numeric, 2), " +
      `timestamptz '${DATA_START}' + ((g - 1)::float8 / ${rows}) * interval '${DATA_DAYS} days' + floor(random() * 600) * interval '1 second', ` +
      "jsonb_build_object('source', (ARRAY['web','ios','android','api','pos','email'])[1 + floor(random() * 6)::int], " +
      "'campaign', 'cmp-' || floor(random() * 40)::int, " +
      "'device', jsonb_build_object('os', (ARRAY['ios','android','macos','windows','linux'])[1 + floor(random() * 5)::int], 'version', (10 + floor(random() * 8))::int || '.' || floor(random() * 10)::int), " +
      "'items', 1 + floor(random() * 9)::int, 'gift', random() < 0.1, 'ref', md5(g::text)), " +
      "CASE WHEN random() < 0.3 THEN 'customer asked for ' || (ARRAY['gift wrap','a call before delivery','delivery after 5pm','an invoice'])[1 + floor(random() * 4)::int] END " +
      `FROM (SELECT g, 1 + floor(random() * ${nc})::bigint AS c, random() AS r FROM generate_series(1, ${rows}) g) s`,
    "ALTER TABLE public.orders ADD PRIMARY KEY (id)",
    "CREATE INDEX orders_tenant_created ON public.orders (tenant_id, created_at)",
    "CREATE INDEX orders_created ON public.orders (created_at)",
    "VACUUM (ANALYZE) public.customers",
    "VACUUM (ANALYZE) public.orders",
    `COMMENT ON TABLE public.orders IS '${coldMarker(rows)}'`,
  ];
}
const coldMarker = (rows: number): string =>
  `bench-replica cold v${COLD_DATA.version}: ${rows} orders, ${customersOf(rows)} customers, ${COLD_DATA.keys} keys, no index on status`;
/** a size's cold data: its own database, marker and SQL */
export const coldShape = (rows: number): DataShape => ({ database: `bench_replica_cold_${rows}`, marker: coldMarker(rows), sql: coldDataSql(rows) });

// --------------------------------------------------------------------------------------------- the statements

/** a statement the run sends: its SQL, and the session's time zone it runs in (`timeZone`; absent: UTC) */
export interface ColdStatement { name: string; title: string; sql: string; lookup?: true; timeZone?: string }
/** where the lookup's id goes: each client's own, as a literal */
export const LOOKUP_ID = "<id>";
const REVENUE_SQL = "SELECT date_trunc('month', o.created_at) AS month, date_trunc('year', c.created_at) AS signup_year, sum(o.amount) AS revenue " +
  "FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY 1, 2 ORDER BY 1, 2";
export const COLD_STATEMENTS: readonly ColdStatement[] = [
  { name: "count_by_status", title: "Count by status, every order",
    sql: "SELECT status, count(*) FROM orders GROUP BY status ORDER BY status" },
  { name: "revenue_by_month", title: "Revenue by month, orders joined to customers", sql: REVENUE_SQL },
  // the same SQL in a session whose zone is off the hour by 45 minutes: Mason groups a time's unit by a stored
  // 15-minute bucket outside UTC (src/duck/bucket-column.ts, issue 1146), and in UTC from 10 M rows (issue 1174)
  { name: "revenue_by_month_kathmandu", title: "Revenue by month in Asia/Kathmandu, orders joined to customers", sql: REVENUE_SQL, timeZone: "Asia/Kathmandu" },
  { name: "lookup", title: "One order by its primary key", sql: `SELECT * FROM orders WHERE id = '${LOOKUP_ID}'`, lookup: true },
];
/** the session's time zone a statement runs in: its own, else UTC (both engines, the answers and the timed runs alike) */
export const zoneOf = (st: Pick<ColdStatement, "timeZone">): string => st.timeZone ?? "UTC";
/** what makes a statement the one an earlier run sent: its name, its SQL and its session's time zone */
export const statementKey = (st: Pick<ColdStatement, "name" | "sql" | "timeZone">): string => JSON.stringify([st.name, st.sql, zoneOf(st)]);
/** a statement as the fixture records it */
export const fixtureStatement = (st: ColdStatement): ColdFixture["statements"][number] =>
  ({ name: st.name, title: st.title, sql: st.sql, ...(st.timeZone === undefined ? {} : { timeZone: st.timeZone }) });

/** a UUID as Postgres writes it: 36 characters, lower-case hex in groups of 8, 4, 4, 4 and 12 */
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** the statement as sent: the lookup with its id as a quoted literal, checked to be a UUID's 36 characters first */
export function statementSql(st: ColdStatement, id?: string): string {
  if (st.lookup !== true) return st.sql;
  if (id === undefined || !UUID_TEXT.test(id)) throw new Error(`a lookup's id is a UUID as Postgres writes it: ${JSON.stringify(id)}`);
  return st.sql.replace(LOOKUP_ID, id);
}

/**
 * The pgbench script of one run: the statement, once. For the lookup, each client's own id as a plain literal, chosen
 * by pgbench's meta-commands, so each engine plans a plain `id = <literal>`.
 */
export function coldScript(st: ColdStatement, clients: number, ids: readonly string[]): string {
  // pgbench reads `:name` in SQL as its variable
  if (st.sql.includes(":")) throw new Error(`${st.name}: a colon in the SQL is pgbench's variable`);
  if (st.lookup !== true) return `${st.sql};\n`;
  if (ids.length < clients) throw new Error(`${clients} clients need ${clients} ids, and there are ${ids.length}`);
  if (clients === 1) return `${statementSql(st, ids[0])};\n`;
  const lines: string[] = [];
  for (let i = 0; i < clients; i++) lines.push(`${i === 0 ? "\\if" : "\\elif"} :client_id = ${i}`, `${statementSql(st, ids[i])};`);
  lines.push("\\endif");
  return `${lines.join("\n")}\n`;
}

/** the share of orders' pages to sample, in percent, for about `want` rows of `rows` (at most every page) */
export function samplePercent(rows: number, want: number): number {
  return Math.min(100, Number((want / rows * 100).toPrecision(2)));
}
/**
 * The lookup's ids: `n` orders' ids at random, read from the data. TABLESAMPLE SYSTEM reads a share of the table's pages
 * at random (about `want` rows, never every row at 100 M), and only that sample is shuffled.
 */
export function lookupIdsSql(rows: number, n: number, want = Math.max(2000, 100 * n)): string {
  return `SELECT id::text AS id FROM public.orders TABLESAMPLE SYSTEM (${samplePercent(rows, want)}) ORDER BY random() LIMIT ${n}`;
}
/** `n` different orders' ids at random, from the data; a sample short of `n` (a small table's few pages) is taken again larger */
async function pickLookupIds(conn: pg.ClientConfig, rows: number, n: number): Promise<string[]> {
  const c = new pg.Client(conn);
  await c.connect();
  try {
    for (let want = Math.max(2000, 100 * n); ; want *= 4) {
      const ids = ((await c.query(lookupIdsSql(rows, n, want))).rows as Array<{ id: string }>).map((r) => r.id);
      if (ids.length === n) return ids;
      if (samplePercent(rows, want) >= 100) throw new Error(`${n} different ids from orders, which has ${ids.length}`);
    }
  } finally { await c.end(); }
}

// --------------------------------------------------------------------------------------------- one run's times

export interface ClientTime { client: number; latencyMs: number; endMs: number }
/**
 * pgbench's per-transaction log (every file of one run, joined): `client_id transaction_no time script_no time_epoch
 * time_us`, the time in microseconds, from the transaction's start (after the connection) to its end. One line per
 * client, each client once, or the run is refused: a client that failed or never ran is no time.
 */
export function parsePgbenchLog(text: string, clients: number): ClientTime[] {
  const out: ClientTime[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || !f.slice(0, 2).every((x) => /^\d+$/.test(x)) || !f.slice(3, 6).every((x) => /^\d+$/.test(x))) {
      throw new Error(`pgbench's log has a line it does not write: ${JSON.stringify(line)}`);
    }
    // "failed" or "skipped" where the time is: the statement did not complete
    if (!/^\d+$/.test(f[2]!)) throw new Error(`client ${f[0]}'s statement did not complete (${f[2]}): ${line.trim()}`);
    out.push({ client: Number(f[0]), latencyMs: Number(f[2]) / 1000, endMs: Number(f[4]) * 1000 + Number(f[5]) / 1000 });
  }
  const seen = out.map((c) => c.client).sort((a, b) => a - b);
  if (seen.join(",") !== Array.from({ length: clients }, (_, i) => i).join(",")) {
    throw new Error(`pgbench's log has client(s) ${seen.join(", ") || "none"}; ${clients} were run, each once`);
  }
  return out.sort((a, b) => a.client - b.client);
}

export interface ColdRun {
  /** the slowest client's time: until every client had its answer, ms */
  slowestMs: number;
  /** a client's mean, ms */
  meanMs: number;
  /** from the first client's start to the last client's end, ms */
  spanMs: number;
  /** each client's time, by client_id, ms */
  clientsMs: number[];
  /** from the engine's restart to its first answer to the probe, ms */
  readyMs: number;
  /** the bytes the measured engine's container read from disk while pgbench ran (its cgroup's io.stat, rbytes) */
  readBytes: number;
  /** on Mason's runs: the bytes Postgres's container, idle, read meanwhile */
  idleReadBytes?: number;
  at: string;
}
export interface DiskRead { readBytes: number; idleReadBytes?: number }
export function runOf(times: readonly ClientTime[], readyMs: number, at: string, disk: DiskRead): ColdRun {
  if (times.length === 0) throw new Error("a run with no client");
  const lat = times.map((t) => t.latencyMs);
  const start = Math.min(...times.map((t) => t.endMs - t.latencyMs)), end = Math.max(...times.map((t) => t.endMs));
  return { slowestMs: round(Math.max(...lat), 3), meanMs: round(lat.reduce((a, b) => a + b, 0) / lat.length, 3), spanMs: round(end - start, 3),
    clientsMs: lat.map((x) => round(x, 3)), readyMs: round(readyMs, 0), readBytes: disk.readBytes,
    ...(disk.idleReadBytes === undefined ? {} : { idleReadBytes: disk.idleReadBytes }), at };
}

/** the cgroup v2 path of a process, from its /proc/<pid>/cgroup (the `0::<path>` line); none on a cgroup v1 machine */
export function cgroupOf(procCgroup: string): string {
  const line = procCgroup.split("\n").find((l) => l.startsWith("0::"));
  if (line === undefined) throw new Error(`no cgroup v2 line (0::<path>) in /proc/<pid>/cgroup: ${JSON.stringify(procCgroup.slice(0, 200))}`);
  const p = line.slice(3).trim();
  if (!p.startsWith("/") || p.split("/").includes("..")) throw new Error(`a cgroup path that is not one: ${JSON.stringify(p)}`);
  return p;
}
/** the bytes read, summed over every device, from a cgroup v2 io.stat (`<major>:<minor> rbytes=… wbytes=… …` a line) */
export function readBytesOf(ioStat: string): number {
  let sum = 0;
  for (const line of ioStat.split("\n")) {
    if (line.trim() === "") continue;
    if (!/^\d+:\d+ /.test(line)) throw new Error(`an io.stat line it does not write: ${JSON.stringify(line)}`);
    const m = /\brbytes=(\d+)\b/.exec(line);
    if (m === null) throw new Error(`an io.stat line with no rbytes: ${JSON.stringify(line)}`);
    sum += Number(m[1]);
  }
  return sum;
}

export type ColdEngine = "postgres" | "mason";
export interface ColdCell {
  rows: number; clients: number; engine: ColdEngine; statement: string;
  /** the median over the runs of the slowest client's time, ms: what the README shows */
  slowestMs: number;
  /** the median over the runs of a client's mean, ms */
  meanMs: number;
  runs: ColdRun[];
  /** a Postgres cell copied unchanged from an earlier run (--engines mason): that run's date, and the md5 of the answer
   *  both runs' Postgres gave. Absent: measured in this run */
  copied?: { from: string; answer: string };
}
export function coldCell(rows: number, clients: number, engine: ColdEngine, statement: string, runs: ColdRun[]): ColdCell {
  if (runs.length === 0) throw new Error(`${rows} rows, ${clients} clients, ${engine}, ${statement}: a cell with no run`);
  return { rows, clients, engine, statement, slowestMs: round(median(runs.map((r) => r.slowestMs)), 3), meanMs: round(median(runs.map((r) => r.meanMs)), 3), runs };
}

// --------------------------------------------------------------------------------------------- the fixture

export interface ColdSize {
  rows: number; customers: number;
  /** the data's generation in Postgres, s; null when an existing database was reused */
  generatedSeconds: number | null;
  postgresBytes: number;
  /** Mason's volume once synced (the synced data and its state) */
  masonBytes: number;
  /** from the Mason container's first start to every table synced and served, s */
  syncSeconds: number;
  /** after that, until Mason's own work on the synced data was done, s: the side table for lookups by orders.id, where
   *  one is expected (`sideTableExpected`), and the reference's hidden keys numbered (`backgroundLeft`). Absent from a
   *  run before it was waited for */
  backgroundSeconds?: number;
  /** the lookup's ids, by client */
  lookupIds: string[];
  /** each statement's answer on each engine, as an md5 of its column names, type OIDs and rows (the lookup per id) */
  answers: Record<string, { postgres: string; mason: string }>;
  answersEqual: boolean; differences: string[];
}
export interface ColdFixture {
  mode: "cold";
  environment: {
    label: string; date: string;
    machine: { cpus: number; cpuModel: string; ramBytes: number; os: string; arch: string; node: string };
    /** each engine's container: the same CPUs and memory, no swap */
    limits: { cpus: number; memoryBytes: number };
    postgres: { image: string; version: string; settings: Record<string, string> };
    mason: { image: string; imageId: string; version: string;
      /** the commit the image was built from (--mason-commit), when given */
      commit?: string;
      /** the memory Mason's engine was given, as its log says it ("4096MiB"), or "unknown" */
      engineMemory: string;
      settings: Record<string, string> };
    client: { image: string; pgbench: string; command: string };
    method: { sizes: number[]; clients: number[]; runs: number; settleSeconds: number; timeZone: string };
    /** the disk both engines read, in words (--disk), or null when not said */
    disk: string | null;
    /** the checkout the measuring script ran from (git HEAD, "+dirty" when src/ had changes), when recorded: never Mason's */
    commit?: string;
    /** --engines mason: the earlier run Postgres's cells were copied from, unchanged */
    postgresFrom?: PostgresFrom;
  };
  /** what the data is: its keys and indexes (COLD_DATA) */
  data: ColdData;
  statements: Array<{ name: string; title: string; sql: string; timeZone?: string }>;
  sizes: ColdSize[];
  skipped: Array<{ rows: number; why: string }>;
  cells: ColdCell[];
  complete: boolean;
}

/** where a Mason-alone run's Postgres cells came from: that run's date, its commit when recorded, and its file */
export interface PostgresFrom { date: string; measuredAt: string | null; file: string }

/**
 * The statements of this script a fixture measured, or null when it names one this script does not send as it was sent
 * (another SQL or time zone, or out of order). A fixture made before a statement was added to the script names the
 * others alone: it is a run of those, and has no cell of the one added.
 */
export function fixtureStatements(f: Pick<ColdFixture, "statements">): ColdStatement[] | null {
  const sends = COLD_STATEMENTS.map(statementKey);
  let at = 0;
  for (const s of f.statements) {
    const i = sends.indexOf(statementKey(s), at);
    if (i < 0) return null;
    at = i + 1;
  }
  return f.statements.length === 0 ? null : COLD_STATEMENTS.filter((st) => f.statements.some((s) => statementKey(s) === statementKey(st)));
}

/**
 * What is wrong with a cold run's fixture, in words (none: a run that ended, with every cell its method names): the
 * statements it names sent now as it sent them, every size measured or skipped, and for each size × clients ×
 * statement × engine a cell of --runs runs, each with every client's time, the cell's time the median of the runs'
 * slowest.
 */
export function coldFixtureProblems(f: ColdFixture): string[] {
  const out: string[] = [];
  if (f.mode !== "cold") out.push(`mode is ${JSON.stringify(f.mode)}, not "cold"`);
  const statements = fixtureStatements(f);
  if (statements === null) out.push("its statements are not the ones scripts/bench-replica-cold.ts sends now: run it again");
  if (JSON.stringify(f.data ?? null) !== JSON.stringify(COLD_DATA)) out.push("its data is not the data scripts/bench-replica-cold.ts makes now (COLD_DATA): run it again");
  const m = f.environment.method;
  for (const rows of m.sizes) if (!f.sizes.some((z) => z.rows === rows) && !f.skipped.some((k) => k.rows === rows)) out.push(`${rows} rows: neither measured nor skipped`);
  for (const z of f.sizes) {
    if (z.lookupIds.length < Math.max(...m.clients)) out.push(`${z.rows} rows: ${z.lookupIds.length} lookup ids for ${Math.max(...m.clients)} clients`);
    for (const clients of m.clients) for (const st of statements ?? COLD_STATEMENTS) for (const engine of ["postgres", "mason"] as const) {
      const where = `${z.rows} rows, ${clients} clients, ${st.name}, ${engine}`;
      const c = f.cells.filter((x) => x.rows === z.rows && x.clients === clients && x.statement === st.name && x.engine === engine);
      if (c.length !== 1) { out.push(`${where}: ${c.length} cells`); continue; }
      const cell = c[0]!;
      if (cell.runs.length !== m.runs) out.push(`${where}: ${cell.runs.length} runs, not ${m.runs}`);
      if (cell.runs.some((r) => r.clientsMs.length !== clients || !(r.slowestMs > 0))) out.push(`${where}: a run without every client's time`);
      if (cell.runs.some((r) => !Number.isFinite(r.readBytes) || (engine === "mason") !== (r.idleReadBytes !== undefined))) out.push(`${where}: a run without what it read from disk`);
      if (cell.slowestMs !== round(median(cell.runs.map((r) => r.slowestMs)), 3)) out.push(`${where}: its time is not the median of its runs' slowest`);
      if (cell.copied !== undefined) {
        if (engine !== "postgres" || st.lookup === true || f.environment.postgresFrom?.date !== cell.copied.from) out.push(`${where}: copied, and only a Postgres cell of a statement with no per-client literal, from environment.postgresFrom's run, may be`);
        if (z.answers[st.name]?.postgres !== cell.copied.answer) out.push(`${where}: copied, and Postgres's answer in this run is not the one it had in the run it was copied from`);
      }
    }
  }
  for (const st of statements ?? COLD_STATEMENTS) {
    const pg = f.cells.filter((c) => c.engine === "postgres" && c.statement === st.name);
    const copied = pg.filter((c) => c.copied !== undefined).length;
    if (copied > 0 && copied < pg.length) out.push(`${st.name}: its Postgres cells are copied at some sizes or client counts and measured at others`);
  }
  const from = f.environment.postgresFrom;
  if (from !== undefined && !(Date.parse(from.date) <= Date.parse(f.environment.date))) {
    out.push(`its Postgres cells are from a run dated ${JSON.stringify(from.date)}, not one before this run's ${f.environment.date}`);
  }
  if (!f.complete) out.push("the run did not end (complete: false)");
  return out;
}

/**
 * Why an earlier cold run's Postgres cells cannot stand beside a Mason-alone run with these options, in words (none:
 * they can). Read before anything with a side effect. The live Postgres's version and settings are checked once it
 * answers (`livePostgresProblems`).
 */
export function postgresFromProblems(earlier: ColdFixture, o: ColdOptions): string[] {
  const out: string[] = [];
  const file = o.postgresFrom;
  if (earlier.mode !== "cold") return [`${file} is not a cold run (mode ${JSON.stringify(earlier.mode)})`];
  if (!earlier.complete) out.push(`${file} is of a run that did not end (complete: false)`);
  if (JSON.stringify(earlier.data ?? null) !== JSON.stringify(COLD_DATA)) out.push(`${file} measured other data than this run makes (COLD_DATA)`);
  // a statement this run sends that the earlier run did not is measured on Postgres too (`copiedFrom`); one the earlier
  // run sent otherwise (its SQL or time zone), or that this run no longer sends, refuses it
  if (fixtureStatements(earlier) === null) out.push(`${file} sent other statements than this run sends`);
  const e = earlier.environment, m = e.method;
  const differs = (what: string, was: unknown, now: unknown): void => {
    if (JSON.stringify(was) !== JSON.stringify(now)) out.push(`${file} has ${what} ${JSON.stringify(was)}, and this run ${JSON.stringify(now)}`);
  };
  differs("--clients", m.clients, o.clients);
  differs("--runs", m.runs, o.runs);
  differs("--settle", m.settleSeconds, o.settleSeconds);
  differs("the time zone", m.timeZone, "UTC");
  differs("--cpus", e.limits.cpus, o.cpus);
  differs("--memory (bytes)", e.limits.memoryBytes, o.memoryBytes);
  differs("--postgres-image", e.postgres.image, o.postgresImage);
  differs("--disk", e.disk, o.disk);
  differs("--label", e.label, o.label);
  for (const rows of o.sizes) {
    const z = earlier.sizes.find((x) => x.rows === rows);
    if (z === undefined) { out.push(`${file} did not measure ${fmtRows(rows)} rows, a size this run measures`); continue; }
    for (const clients of o.clients) for (const st of COLD_STATEMENTS.filter((s) => copiedFrom(earlier, s))) {
      if (!earlier.cells.some((c) => c.engine === "postgres" && c.rows === rows && c.clients === clients && c.statement === st.name)) out.push(`${file} has no Postgres cell for ${fmtRows(rows)} rows, ${clients} clients, ${st.name}`);
    }
  }
  return out;
}
/** why the live Postgres is not the one the earlier run measured, in words (none: it is) */
export function livePostgresProblems(earlier: ColdFixture, live: { version: string; settings: Record<string, string> }, file: string): string[] {
  const out: string[] = [];
  const was = earlier.environment.postgres;
  if (was.version !== live.version) out.push(`${file}'s Postgres was ${JSON.stringify(was.version)}, and this run's is ${JSON.stringify(live.version)}`);
  for (const k of [...new Set([...Object.keys(was.settings), ...Object.keys(live.settings)])].sort()) {
    if (was.settings[k] !== live.settings[k]) out.push(`${file}'s Postgres had ${k} ${was.settings[k] ?? "unset"}, and this run's has ${live.settings[k] ?? "unset"}`);
  }
  return out;
}
/** --resume's file: why it is not a run of the engines this one measures, from the same earlier run (null: it is) */
export function resumeEnginesProblem(was: ColdFixture, postgresFrom: PostgresFrom | null, file: string): string | null {
  const had = was.environment.postgresFrom ?? null;
  if (JSON.stringify(had) === JSON.stringify(postgresFrom)) return null;
  const what = (p: PostgresFrom | null): string => p === null ? "both engines" : `Mason alone, with Postgres's cells from the run of ${p.date.slice(0, 10)} (${p.file})`;
  return `--resume: ${file} is a run of ${what(had)}, and this run is of ${what(postgresFrom)}: leave out --resume, or give --out another file`;
}
/** where a Mason-alone run's copied cells come from: the earlier run, or the run it copied its own from */
export function postgresFromOf(earlier: ColdFixture, file: string): PostgresFrom {
  return earlier.environment.postgresFrom ?? { date: earlier.environment.date, measuredAt: earlier.environment.commit ?? null, file: path.relative(REPO, file) };
}

/** a statement whose Postgres cells a Mason-alone run may copy: one with no per-client literal, so its answer proves
 *  the rows are the ones the earlier run measured. The lookup's rows are sampled in each run, so it is measured */
export const copyable = (st: ColdStatement): boolean => st.lookup !== true;
/** a statement whose Postgres cells a Mason-alone run copies from `earlier`: copyable, and sent by that run as this one
 *  sends it (its SQL and time zone). A statement the earlier run did not send has no cell to copy: Postgres's is
 *  measured in this run, as the lookup's is */
export const copiedFrom = (earlier: Pick<ColdFixture, "statements">, st: ColdStatement): boolean =>
  copyable(st) && earlier.statements.some((s) => statementKey(s) === statementKey(st));
/** the statements it copies (`copied`) whose live Postgres answer (an md5, by statement) is not the earlier run's:
 *  none, or their cells cannot be copied */
export function postgresAnswerChanges(earlier: ColdSize, live: Record<string, string>, copied: readonly ColdStatement[]): string[] {
  return copied.map((st) => st.name).filter((k) => earlier.answers[k]?.postgres === undefined || earlier.answers[k]!.postgres !== live[k]);
}
/** the earlier run's Postgres cell, unchanged (every run, each client's time and what it read), marked as copied */
export function earlierPostgresCell(earlier: ColdFixture, rows: number, clients: number, statement: string): ColdCell {
  const c = earlier.cells.find((x) => x.engine === "postgres" && x.rows === rows && x.clients === clients && x.statement === statement);
  const z = earlier.sizes.find((x) => x.rows === rows);
  if (c === undefined || z?.answers[statement] === undefined) throw new Error(`no Postgres cell or answer for ${rows} rows, ${clients} clients, ${statement} in the earlier run`);
  const from = earlier.environment.postgresFrom?.date ?? earlier.environment.date;
  return { ...structuredClone(c), copied: { from: c.copied?.from ?? from, answer: z.answers[statement]!.postgres } };
}

// --------------------------------------------------------------------------------------------- arguments

export interface ColdOptions {
  sizes: number[]; clients: number[]; runs: number; cpus: number; memoryBytes: number; masonImage: string; postgresImage: string;
  settleSeconds: number; work: string; reserveGb: number; label: string; out: string; keepPostgres: boolean; reusePostgres: boolean; resume: boolean;
  /** the disk, in words, for the fixture (--disk) */
  disk: string | null;
  /** the engines measured: both, or Mason alone (--engines mason) */
  engines: ColdEngine[];
  /** with Mason alone: the earlier cold run whose Postgres cells are kept (--postgres-from) */
  postgresFrom: string;
  /** the commit the Mason image was built from (--mason-commit), or null */
  masonCommit: string | null;
}
/** a container's memory: 8GiB, 8g, 8192MiB, 8192m (GiB and MiB, as Docker reads g and m) */
export function memoryBytesOf(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(g|gb|gib|m|mb|mib)$/i.exec(s.trim());
  if (m === null) throw new Usage(`--memory ${JSON.stringify(s)}: write 8GiB, 8g or 8192MiB`);
  return Math.round(Number(m[1]) * (m[2]!.toLowerCase().startsWith("g") ? 2 ** 30 : 2 ** 20));
}
export function parseColdArgs(argv: readonly string[], machine: { cpus: number; ramBytes: number; version: string }): ColdOptions {
  const o: ColdOptions = { sizes: [1e6, 1e7, 1e8], clients: [1, 10], runs: 3, cpus: machine.cpus, memoryBytes: Math.floor(machine.ramBytes / 2 / 2 ** 30) * 2 ** 30,
    masonImage: `ghcr.io/embeddable-hq/mason-data:${machine.version}`, postgresImage: "postgres:18", settleSeconds: 10, work: os.tmpdir(), reserveGb: 60,
    label: "a server", out: path.join(REPO, "tests/fixtures/bench-replica.json"), keepPostgres: false, reusePostgres: false, resume: false, disk: null,
    engines: ["postgres", "mason"], postgresFrom: path.join(REPO, "tests/fixtures/bench-replica.json"), masonCommit: null };
  let fromGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = (): string => { const x = argv[++i]; if (x === undefined) throw new Usage(`${a} needs a value`); return x; };
    const whole = (s: string): number => { const n = Number(s); if (!Number.isInteger(n) || n < 1) throw new Usage(`${a} ${s}: a whole number, 1 or more`); return n; };
    const atLeastZero = (s: string): number => { const n = Number(s); if (s.trim() === "" || !Number.isFinite(n) || n < 0) throw new Usage(`${a} ${s}: a number, 0 or more`); return n; };
    switch (a) {
      case "--sizes": o.sizes = v().split(",").map(parseCount); break;
      case "--clients": o.clients = v().split(",").map(whole); break;
      case "--runs": o.runs = whole(v()); break;
      case "--cpus": o.cpus = whole(v()); break;
      case "--memory": o.memoryBytes = memoryBytesOf(v()); break;
      case "--mason-image": o.masonImage = v(); break;
      case "--postgres-image": o.postgresImage = v(); break;
      case "--settle": o.settleSeconds = atLeastZero(v()); break;
      case "--work": o.work = path.resolve(v()); break;
      case "--reserve-gb": o.reserveGb = atLeastZero(v()); break;
      case "--label": o.label = v(); break;
      case "--disk": o.disk = v().trim(); if (o.disk === "") throw new Usage("--disk: the disk in words, e.g. \"EBS gp3, 125 MB/s, 3000 IOPS\""); break;
      case "--out": o.out = path.resolve(v()); break;
      case "--keep-postgres": o.keepPostgres = true; break;
      case "--reuse-postgres": o.reusePostgres = true; break;
      case "--resume": o.resume = true; break;
      case "--engines": {
        const e = v().split(",").map((x) => x.trim()).filter(Boolean).sort().join(",");
        if (e === "mason") o.engines = ["mason"];
        else if (e === "mason,postgres") o.engines = ["postgres", "mason"];
        else throw new Usage(`--engines ${JSON.stringify(e)}: give postgres,mason (both, the default) or mason (Mason alone, Postgres's cells from --postgres-from)`);
        break;
      }
      case "--postgres-from": o.postgresFrom = path.resolve(v()); fromGiven = true; break;
      case "--mason-commit": {
        const c = v().trim();
        if (!/^[0-9a-f]{7,40}$/i.test(c)) throw new Usage(`--mason-commit ${JSON.stringify(c)}: the commit the image was built from, 7 to 40 hex characters`);
        o.masonCommit = c.toLowerCase();
        break;
      }
      case "--postgres": throw new Usage("--cold restarts its own Postgres before every run, and --postgres names a server it may not restart: leave --postgres out");
      default: throw new Usage(`--cold: unknown option ${a} (--cold --help lists them)`);
    }
  }
  if (o.sizes.length === 0 || o.sizes.some((n) => n < 1)) throw new Usage("--sizes: one row count or more, each 1 or more");
  if (o.memoryBytes < 3 * 2 ** 30) throw new Usage(`--memory ${(o.memoryBytes / 2 ** 30).toFixed(1)} GiB: Mason's container needs 3 GiB or more (deploy/mason-data/README.md "Memory")`);
  if (o.cpus > machine.cpus) throw new Usage(`--cpus ${o.cpus}: this machine has ${machine.cpus}`);
  const masonAlone = o.engines.length === 1;
  if (fromGiven && !masonAlone) throw new Usage("--postgres-from gives Postgres's cells to a run of Mason alone: add --engines mason");
  if (masonAlone && o.out === o.postgresFrom) throw new Usage(`--engines mason: --out is ${o.out}, the run --postgres-from reads. Give --out another file, and copy it there once the run is complete`);
  const most = Math.max(...o.clients);
  if (o.sizes.some((n) => n < most)) throw new Usage(`--sizes ${o.sizes.map(fmtRows).join(",")}: the lookup needs a different row for each of ${most} clients`);
  return o;
}

// --------------------------------------------------------------------------------------------- the machine

/** a command run to its end: its exit status and output (the run's own long steps: Mason's first sync, pgbench) */
function run(cmd: string, args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => { stdout += d; });
    child.stderr.setEncoding("utf8").on("data", (d: string) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** the OS page cache dropped (and dirty pages written first), or the run refused: cold means nothing cached */
function dropPageCache(): void {
  const r = spawnSync("sh", ["-c", "sync && echo 3 | sudo -n tee /proc/sys/vm/drop_caches >/dev/null"], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Usage(`--cold drops the page cache before every run, and could not: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}. ` +
      "It needs Linux and passwordless sudo for `tee /proc/sys/vm/drop_caches`");
  }
}

/** a file only this user may read, in a folder only this user may enter: an env file's secrets */
function writeSecret(file: string, lines: Record<string, string>): void {
  for (const [k, v] of Object.entries(lines)) if (/[\n\r]/.test(v)) throw new Error(`${k} has a line break`);
  fs.writeFileSync(file, Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** whether docker has a container, network or volume of this name. Only docker's own "no such" is no: anything else it
 *  says (its daemon down, permission denied) refuses the run, since a check that cannot tell must not pass */
function exists(kind: "container" | "network" | "volume", name: string): boolean {
  const r = spawnSync("docker", [kind, "inspect", name], { encoding: "utf8" });
  if (r.error !== undefined) throw new Usage(`docker could not be run: ${r.error.message}`);
  if (r.status === 0) return true;
  if (/no such|not found/i.test(r.stderr)) return false;
  throw new Usage(`docker ${kind} inspect ${name} could not tell whether it exists: ${r.stderr.trim() || `exit ${r.status}`}`);
}

/**
 * A PROCESS, NAMED SO A LATER ONE CANNOT BE TAKEN FOR IT: the machine's boot (/proc/sys/kernel/random/boot_id), the
 * pid namespace its pid is counted in (/proc/self/ns/pid), the pid, and the process's start in clock ticks since that
 * boot (/proc/<pid>/stat's 22nd field). None of it depends on a time zone, a clock step or how a tool formats a time.
 * `procRoot` is /proc; a test gives a folder of its own.
 */
export function ownerOf(pid: number, procRoot = "/proc"): string {
  const boot = fs.readFileSync(path.join(procRoot, "sys/kernel/random/boot_id"), "utf8").trim();
  const ns = fs.readlinkSync(path.join(procRoot, "self/ns/pid"));
  return `boot:${boot}/pidns:${ns}/pid:${pid}/start:${startTicksOf(fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"))}`;
}
/** a process's start in clock ticks since the boot: /proc/<pid>/stat's 22nd field, counted after its name's ")",
 *  since the name itself may hold spaces and parentheses */
export function startTicksOf(stat: string): string {
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  // the fields after the name start at the 3rd: the 22nd is the 20th of these
  const start = fields[19];
  if (start === undefined || !/^\d+$/.test(start)) throw new Error(`a /proc/<pid>/stat it cannot read: ${JSON.stringify(stat.slice(0, 120))}`);
  return start;
}
/**
 * Whether the process an owner names may be alive. Only what proves it has ended says no: another boot, no process of
 * its pid in its own pid namespace, or a process of its pid that started at another tick. Anything it cannot tell (an
 * owner it cannot read, a /proc it cannot read, a process in another pid namespace or another user's) says yes, so a
 * run in progress is never taken for an ended one.
 */
export function ownerAlive(owner: string, procRoot = "/proc"): boolean {
  const m = /^boot:([^/\s]+)\/pidns:([^/\s]+)\/pid:(\d+)\/start:(\d+)$/.exec(owner);
  if (m === null) return true;
  let boot: string, ns: string;
  try {
    boot = fs.readFileSync(path.join(procRoot, "sys/kernel/random/boot_id"), "utf8").trim();
    ns = fs.readlinkSync(path.join(procRoot, "self/ns/pid"));
  } catch { return true; } // cannot tell: alive
  if (boot !== m[1]) return false;
  // a pid counted in another namespace (a run in a container, or this one in one) is not one this process can look up
  if (ns !== m[2]) return true;
  const pid = Number(m[3]);
  try { process.kill(pid, 0); } catch (e) {
    // ESRCH: no such process. EPERM: one there, another user's
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
  // a live pid whose start cannot be read (/proc mounted hidepid): cannot tell, so alive
  try { return startTicksOf(fs.readFileSync(path.join(procRoot, String(pid), "stat"), "utf8")) === m[4]; } catch { return true; }
}
const ownerPid = (owner: string): string => /\/pid:(\d+)\//.exec(owner)?.[1] ?? "unknown";

/** where the cold mode's lock is: one path whatever the environment says ($TMPDIR is not read), so every run sees one lock */
export const lockFileOf = (): string => "/tmp/bench-replica-cold.lock";
/** why a lock refuses a run, or null when its holder has ended: one starting, one in progress, or one it cannot read */
function lockHolderRefusal(held: string, file: string, procRoot: string): string | null {
  if (held === "") return `a cold run is starting (its lock ${file} is being written): wait for it, or remove the lock if no run is starting`;
  if (!ownerAlive(held, procRoot)) return null;
  return /^boot:/.test(held)
    ? `a cold run is in progress (process ${ownerPid(held)}; its lock ${file}): wait for it to end`
    : `a cold run may be in progress: its lock ${file} names ${JSON.stringify(held)}, which this version cannot check. Remove the lock if no run is in progress`;
}
/** the refusal a live cold run's lock gives another bench run (a warm one too), or null when no cold run holds it */
export function coldRunRefusal(file = lockFileOf(), procRoot = "/proc"): string | null {
  let held: string;
  try { held = fs.readFileSync(file, "utf8").trim(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return lockHolderRefusal(held, file, procRoot);
}

/**
 * THE LOCK: one cold run on a machine at a time. It holds this run's owner (`ownerOf`), written whole before it is
 * linked into place, so no run reads it half written. A lock whose holder may be alive refuses the run. One whose holder
 * has ended is taken over under a second lock (<lock>.takeover, made with O_EXCL), so of two runs that find it together
 * only one takes it. Released when the run ends, however it ends.
 */
export function takeLock(file: string, procRoot = "/proc"): () => void {
  const me = ownerOf(process.pid, procRoot);
  const mine = `${file}.${process.pid}.new`;
  fs.writeFileSync(mine, `${me}\n`, { mode: 0o644 });
  const link = (): boolean => {
    try { fs.linkSync(mine, file); return true; } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };
  const read = (): string | null => {
    try { return fs.readFileSync(file, "utf8").trim(); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };
  try {
    let got = link();
    if (!got) {
      const held = read();
      if (held === null) got = link();
      else {
        const refusal = lockHolderRefusal(held, file, procRoot);
        if (refusal !== null) throw new Usage(refusal);
        // its run ended without releasing it (killed): taken over by one run alone
        const takeover = `${file}.takeover`;
        let fd: number;
        try { fd = fs.openSync(takeover, "wx", 0o644); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          throw new Usage(`another cold run is taking over the lock ${file} now, or was killed while it did: remove ${takeover} if no run is starting`);
        }
        try {
          fs.writeSync(fd, `${me}\n`);
          fs.closeSync(fd);
          if (read() === held) fs.rmSync(file, { force: true });
          got = link();
        } finally { fs.rmSync(takeover, { force: true }); }
      }
    }
    if (!got) throw new Usage(`another cold run took the lock ${file} as this one did: wait for it to end`);
  } finally { fs.rmSync(mine, { force: true }); }
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // only our own: a lock another run took over after a kill is theirs
    if (read() === me) fs.rmSync(file, { force: true });
  };
  process.on("exit", release);
  return release;
}

/** what a container read from disk so far: its cgroup v2 io.stat's rbytes, its cgroup found from its process */
function containerReadBytes(name: string): number {
  const pid = docker(["inspect", "--format", "{{.State.Pid}}", name]);
  if (!/^[1-9]\d*$/.test(pid)) throw new Error(`${name} has no process (pid ${JSON.stringify(pid)}): it is not running`);
  const cgroup = cgroupOf(fs.readFileSync(`/proc/${pid}/cgroup`, "utf8"));
  return readBytesOf(fs.readFileSync(path.join("/sys/fs/cgroup", cgroup, "io.stat"), "utf8"));
}
/** a docker removal of what may not be there: a missing one is the normal case, anything else is said */
function removeQuietly(args: string[], log: (l: string) => void): boolean {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0 && !/No such|not found/i.test(r.stderr)) log(`could not docker ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.status === 0;
}
function ensureImage(image: string, log: (l: string) => void): string {
  if (spawnSync("docker", ["image", "inspect", image], { encoding: "utf8" }).status !== 0) { log(`pulling ${image}…`); docker(["pull", "-q", image]); }
  return docker(["image", "inspect", "--format", "{{.Id}}", image]);
}

/** until a fresh connection answers `SELECT 1 FROM orders LIMIT 0`: the engine is up and the table served. ms waited */
async function untilAnswers(conn: pg.ClientConfig, what: string, timeoutMs: number): Promise<number> {
  const t0 = performance.now();
  let last = "";
  for (;;) {
    const c = new pg.Client({ ...conn, connectionTimeoutMillis: 5000 });
    try {
      await c.connect();
      await c.query("SELECT 1 FROM orders LIMIT 0");
      await c.end();
      return performance.now() - t0;
    } catch (e) {
      last = (e as Error).message;
      // a refused or reset connection while the engine starts: closed, and asked again
      await c.end().catch((x: Error) => { last += ` (closing: ${x.message})`; });
    }
    if (performance.now() - t0 > timeoutMs) throw new Error(`${what} did not answer SELECT 1 FROM orders LIMIT 0 in ${Math.round(timeoutMs / 1000)} s: ${last}`);
    await sleep(250);
  }
}

/** each statement's answer as one text: column names, type OIDs and rows (the lookup at each id), each in its session's
 *  time zone (`zoneOf`: UTC, or the statement's own) */
async function answersOf(conn: pg.ClientConfig, ids: readonly string[]): Promise<Map<string, string>> {
  const c = new pg.Client(conn);
  await c.connect();
  try {
    const raw = { getTypeParser: () => (v: string) => v };
    const out = new Map<string, string>();
    for (const st of COLD_STATEMENTS) {
      await c.query(`SET TIME ZONE '${zoneOf(st)}'`);
      for (const id of st.lookup === true ? ids : [undefined]) {
        const key = id === undefined ? st.name : `${st.name} ${id}`;
        try {
          const r = await c.query({ text: statementSql(st, id), rowMode: "array", types: raw } as pg.QueryConfig);
          out.set(key, JSON.stringify({ names: r.fields.map((f) => f.name), oids: r.fields.map((f) => f.dataTypeID), rows: r.rows }));
        } catch (e) {
          // an error is an answer too: compared as one, and said where the answers differ
          out.set(key, `error ${(e as pg.DatabaseError).code ?? ""} ${(e as Error).message}`);
        }
      }
    }
    return out;
  } finally { await c.end(); }
}
const md5 = (s: string): string => createHash("md5").update(s).digest("hex");
const secondsText = (ms: number): string => `${(ms / 1000).toFixed(ms < 10_000 ? 3 : 1)} s`;
const gibText = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 2 : 1)} GiB`;

// --------------------------------------------------------------------------------------------- the run

/** --postgres-from's fixture, read and checked against this run's options: refused with every difference named */
function readEarlier(o: ColdOptions): ColdFixture {
  let earlier: ColdFixture;
  try { earlier = JSON.parse(fs.readFileSync(o.postgresFrom, "utf8")) as ColdFixture; } catch (e) {
    throw new Usage(`--postgres-from ${o.postgresFrom}: ${(e as Error).message}`);
  }
  const problems = postgresFromProblems(earlier, o);
  if (problems.length > 0) throw new Usage(`--engines mason: Postgres's cells from ${o.postgresFrom} cannot stand beside this run:\n  ${problems.join("\n  ")}`);
  return earlier;
}

/** the doc comment at the top of this file: --cold --help */
export function coldHelp(): string {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const a = text.indexOf("/**\n"), z = text.indexOf("\n */", a);
  return text.slice(a + 4, z).replace(/^ \* ?/gm, "") + "\n";
}

export async function mainCold(argv: string[], at: { lockFile?: string; procRoot?: string } = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(coldHelp()); return 0; }
  const version = (JSON.parse(fs.readFileSync(path.join(REPO, "cli/package.json"), "utf8")) as { version: string }).version;
  const o = parseColdArgs(argv, { cpus: os.cpus().length, ramBytes: os.totalmem(), version });
  const log = (l: string): void => { process.stdout.write(`${l}\n`); };
  if (process.platform !== "linux") throw new Usage("--cold drops Linux's page cache before every run: run it on a Linux server");
  // Mason alone: the earlier run whose Postgres cells are kept, refused now if it cannot stand beside this one
  const masonAlone = o.engines.length === 1;
  const earlier = masonAlone ? readEarlier(o) : null;
  if (o.resume && fs.existsSync(o.out)) {
    const problem = resumeEnginesProblem(JSON.parse(fs.readFileSync(o.out, "utf8")) as ColdFixture, earlier === null ? null : postgresFromOf(earlier, o.postgresFrom), o.out);
    if (problem !== null) throw new Usage(problem);
  }
  // before anything with a side effect: a refused run must not touch another's containers, nor drop the page cache
  // under its measurement. The lock first: a run in progress holds it whatever it is doing
  const procRoot = at.procRoot ?? "/proc";
  const releaseLock = takeLock(at.lockFile ?? lockFileOf(), procRoot);
  try { refuseRunInProgress(o, procRoot); } catch (e) { releaseLock(); throw e; }
  const info = ((): string => {
    try { return docker(["info", "--format", "{{.CgroupVersion}} {{.DockerRootDir}}"]); } catch (e) { releaseLock(); throw e; }
  })();
  const cgroupVersion = info.split(" ")[0], dockerRoot = info.slice(info.indexOf(" ") + 1);
  if (cgroupVersion !== "2") {
    releaseLock();
    throw new Usage(`--cold records what each engine reads from disk from its container's cgroup v2 io.stat, and Docker says cgroup version ${JSON.stringify(cgroupVersion)}: run it where Docker uses cgroup v2`);
  }
  const ownerId = ((): string => {
    try { return takeOwner(o.postgresImage, ownerOf(process.pid, procRoot), procRoot); } catch (e) { releaseLock(); throw e; }
  })();
  // the Docker owner first, then the lock: what the run holds, given back when it ends, however it ends
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    // -v: the image's anonymous volume, which docker create made for it
    removeQuietly(["rm", "-f", "-v", ownerId], log);
    releaseLock();
  };
  process.on("exit", release);
  dropPageCache();
  const masonImageId = ensureImage(o.masonImage, log);
  ensureImage(o.postgresImage, log);
  const pgbenchVersion = docker(["run", "--rm", o.postgresImage, "pgbench", "--version"]);
  const masonVersion = docker(["run", "--rm", "--entrypoint", "mason", o.masonImage, "--version"]);
  const limits = ["--cpus", String(o.cpus), "--memory", `${o.memoryBytes}b`, "--memory-swap", `${o.memoryBytes}b`];
  const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;

  // the run's files, in a 0700 folder: the secrets, and the client's script and logs (its container runs as this user)
  fs.mkdirSync(o.work, { recursive: true });
  const dir = fs.mkdtempSync(path.join(o.work, "bench-cold-"));
  fs.chmodSync(dir, 0o700);
  const secrets = path.join(dir, "secrets");
  fs.mkdirSync(secrets, { mode: 0o700 });
  const clientDir = path.join(dir, "client");
  fs.mkdirSync(clientDir, { mode: 0o700 });

  let cleaned = false;
  const made: Made = { postgres: null, mason: null, network: null, volumes: new Set(), clientIdFile: path.join(dir, "client.cid"), postgresIdFile: path.join(dir, "postgres.cid") };
  // what THIS run made, removed by the ids docker gave back: never a container, volume or network found by its name,
  // which may be another run's (a run in progress, or the Postgres a --keep-postgres run left)
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    const client = fs.existsSync(made.clientIdFile) ? fs.readFileSync(made.clientIdFile, "utf8").trim() : "";
    if (client !== "") removeQuietly(["rm", "-f", "-v", client], log);
    if (made.mason !== null) removeQuietly(["rm", "-f", "-v", made.mason], log);
    for (const v of made.volumes) removeQuietly(["volume", "rm", v], log);
    // docker run -d's container by its --cidfile too: one made and not started (its port taken) has no id printed
    const postgres = made.postgres ?? (fs.existsSync(made.postgresIdFile) ? fs.readFileSync(made.postgresIdFile, "utf8").trim() || null : null);
    if (o.keepPostgres) {
      if (postgres !== null) log(`kept ${PG_CONTAINER}, its data${made.network !== null ? ` and the ${NETWORK} network` : ""} (--keep-postgres)`);
    } else {
      // -v: the image's anonymous volume, where Postgres's data is
      if (postgres !== null && removeQuietly(["rm", "-f", "-v", postgres], log)) log(`removed ${PG_CONTAINER} and its data`);
      if (made.network !== null && removeQuietly(["network", "rm", made.network], log)) log(`removed the ${NETWORK} network`);
    }
    if (o.reusePostgres) log(`left ${PG_CONTAINER}, adopted with --reuse-postgres: docker rm -f -v ${PG_CONTAINER} removes it and its data`);
    fs.rmSync(dir, { recursive: true, force: true });
    release();
  };
  const onSignal = (code: number) => (): void => { log("interrupted: the fixture holds the sizes finished"); cleanup(); process.exit(code); };
  process.on("SIGINT", onSignal(130));
  process.on("SIGTERM", onSignal(143));

  try {
    // ---- Postgres: its own container, on a network Mason syncs it over (as `pg`), on a loopback port for the clients
    if (!exists("network", NETWORK)) made.network = docker(["network", "create", NETWORK]);
    let pgPort: number, pgPassword: string;
    if (o.reusePostgres) {
      const info = (JSON.parse(docker(["inspect", PG_CONTAINER])) as Array<{ Config: { Env: string[] }; HostConfig: { Memory: number; NanoCpus: number; PortBindings: Record<string, Array<{ HostPort: string }> | null> }; NetworkSettings: { Networks: Record<string, unknown> }; State: { Running: boolean } }>)[0]!;
      const pw = info.Config.Env.find((e) => e.startsWith("POSTGRES_PASSWORD="))?.slice("POSTGRES_PASSWORD=".length);
      const port = info.HostConfig.PortBindings["5432/tcp"]?.[0]?.HostPort;
      if (pw === undefined || port === undefined || !(NETWORK in info.NetworkSettings.Networks)) throw new Usage(`${PG_CONTAINER} is not one a --cold --keep-postgres run left: remove it (docker rm -f -v ${PG_CONTAINER})`);
      if (info.HostConfig.Memory !== o.memoryBytes || info.HostConfig.NanoCpus !== o.cpus * 1e9) throw new Usage(`${PG_CONTAINER} has other limits than --cpus ${o.cpus} --memory ${o.memoryBytes / 2 ** 30}GiB: give the ones the run that made it had`);
      if (!info.State.Running) docker(["start", PG_CONTAINER]);
      pgPort = Number(port); pgPassword = pw;
      log(`adopted ${PG_CONTAINER} on 127.0.0.1:${pgPort} (--reuse-postgres)`);
    } else {
      pgPort = await freePort(); pgPassword = randomBytes(18).toString("hex");
      const env = path.join(secrets, "postgres.env");
      writeSecret(env, { POSTGRES_PASSWORD: pgPassword });
      const settings = replicaSettings(o.memoryBytes, o.cpus);
      made.postgres = docker(["run", "-d", "--cidfile", made.postgresIdFile, "--label", `${OWNER_LABEL}=${ownerOf(process.pid, procRoot)}`, "--name", PG_CONTAINER, "--network", NETWORK, "--network-alias", PG_ALIAS, "-p", `127.0.0.1:${pgPort}:5432`, ...limits,
        "--shm-size", "1g", "--env-file", env, o.postgresImage, ...Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${v}`])]);
      log(`started ${PG_CONTAINER} (${o.postgresImage}) on 127.0.0.1:${pgPort}, --cpus ${o.cpus} --memory ${gibText(o.memoryBytes)}`);
    }
    const admin = `postgres://postgres:${pgPassword}@127.0.0.1:${pgPort}/postgres`;
    const pgConnOf = (db: string): pg.ClientConfig => ({ host: "127.0.0.1", port: pgPort, user: "postgres", password: pgPassword, database: db });
    await untilReady(admin);
    // what each engine reads from disk is part of every run: refused now, before any data, where it cannot be read
    try { containerReadBytes(PG_CONTAINER); } catch (e) {
      throw new Usage(`--cold records what each engine reads from disk, from its container's cgroup v2 io.stat, and could not read ${PG_CONTAINER}'s: ${(e as Error).message}`);
    }
    const pgFacts = await postgresFacts(admin);
    if (earlier !== null) {
      const problems = livePostgresProblems(earlier, pgFacts, o.postgresFrom);
      if (problems.length > 0) throw new Usage(`--engines mason: this run's Postgres is not the one ${o.postgresFrom} measured:\n  ${problems.join("\n  ")}`);
    }
    const pgClientEnv = path.join(secrets, "client-postgres.env");
    // the session's time zone is each statement's, on pgbench's command line (`pgbenchArgs`)
    writeSecret(pgClientEnv, { PGPASSWORD: pgPassword });

    // ---- the fixture: new, or --resume's sizes kept
    const fresh: ColdFixture = {
      mode: "cold",
      environment: {
        label: o.label, date: new Date().toISOString(),
        machine: { cpus: os.cpus().length, cpuModel: cpuModel(), ramBytes: os.totalmem(), os: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version },
        limits: { cpus: o.cpus, memoryBytes: o.memoryBytes },
        postgres: { image: o.postgresImage, version: pgFacts.version, settings: pgFacts.settings },
        mason: { image: o.masonImage, imageId: masonImageId, version: masonVersion, ...(o.masonCommit === null ? {} : { commit: o.masonCommit }), engineMemory: "unknown",
          settings: { sync: "off", MASON_STATEMENT_TIMEOUT: "0", MASON_PG_SELF_SIGNED_TLS: "1", MASON_PROJECT_READONLY: "1" } },
        client: { image: o.postgresImage, pgbench: pgbenchVersion, command: "pgbench -n -c <clients> -j <clients> -t 1 -f <script> --log" },
        method: { sizes: o.sizes, clients: o.clients, runs: o.runs, settleSeconds: o.settleSeconds, timeZone: "UTC" },
        disk: o.disk,
        commit: commit(),
        ...(earlier === null ? {} : { postgresFrom: postgresFromOf(earlier, o.postgresFrom) }),
      },
      data: { version: COLD_DATA.version, keys: COLD_DATA.keys, indexes: [...COLD_DATA.indexes] },
      statements: COLD_STATEMENTS.map(fixtureStatement),
      sizes: [], skipped: [], cells: [], complete: false,
    };
    let fixture = fresh;
    if (o.resume && fs.existsSync(o.out)) {
      const was = JSON.parse(fs.readFileSync(o.out, "utf8")) as ColdFixture;
      if (was.mode !== "cold" || JSON.stringify(was.environment.limits) !== JSON.stringify(fresh.environment.limits) || was.environment.mason.imageId !== masonImageId
        || was.environment.method.runs !== o.runs || JSON.stringify(was.environment.method.clients) !== JSON.stringify(o.clients)
        || JSON.stringify(was.statements) !== JSON.stringify(fresh.statements) || JSON.stringify(was.data ?? null) !== JSON.stringify(fresh.data)) {
        throw new Usage(`--resume: ${o.out} is not a cold run with these limits, image, clients, runs, statements and data: leave out --resume, or give --out another file`);
      }
      fixture = { ...was, environment: { ...was.environment, method: { ...was.environment.method, sizes: o.sizes } }, skipped: was.skipped.filter((k) => !o.sizes.includes(k.rows)), complete: false };
      log(`--resume: ${fixture.sizes.map((z) => fmtRows(z.rows)).join(", ") || "no size"} kept from ${o.out}`);
    }
    const save = (why: string): void => {
      fs.mkdirSync(path.dirname(o.out), { recursive: true });
      const tmp = `${o.out}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(fixture, null, 2) + "\n");
      fs.renameSync(tmp, o.out);
      log(`  wrote ${o.out} (${why})`);
    };
    log(`bench-replica --cold: ${o.label}; ${pgFacts.version.split(" on ")[0]}; Mason ${masonVersion} (${o.masonImage}); each engine --cpus ${o.cpus} --memory ${gibText(o.memoryBytes)}, no swap`);
    log(`  sizes ${o.sizes.map(fmtRows).join(", ")} × clients ${o.clients.join(", ")} × ${COLD_STATEMENTS.length} statements × ${o.runs} runs, each engine cold`);

    for (const rows of o.sizes) {
      if (fixture.sizes.some((z) => z.rows === rows)) { log(`size ${fmtRows(rows)}: kept (--resume)`); continue; }
      // ---- the disk: both engines' data of this size, predicted from the last size measured
      const last = fixture.sizes[fixture.sizes.length - 1];
      const perRow = last === undefined ? BYTES_PER_ROW : (last.postgresBytes + last.masonBytes) / last.rows;
      const st = fs.statfsSync(dockerRoot), free = st.bavail * st.bsize, need = rows * perRow * 1.25 + 2 * 2 ** 30;
      if (free - need < o.reserveGb * 2 ** 30) {
        const why = `${(need / 2 ** 30).toFixed(0)} GiB predicted (${perRow.toFixed(0)} bytes a row, + 25 % + 2 GiB), ${(free / 2 ** 30).toFixed(0)} GiB free where Docker keeps its data: less than --reserve-gb ${o.reserveGb} would be left`;
        log(`size ${fmtRows(rows)}: SKIPPED, ${why}`);
        fixture.skipped.push({ rows, why });
        save(`${fmtRows(rows)} skipped`);
        continue;
      }
      log(`\n== ${rows.toLocaleString("en-US")} orders ==`);
      const data = await ensureData(admin, rows, log, coldShape(rows));
      const db = new URL(data.url).pathname.slice(1);
      const pgConn = pgConnOf(db);
      const sizeClient = new pg.Client(pgConn);
      await sizeClient.connect();
      const postgresBytes = Number((await sizeClient.query("SELECT pg_total_relation_size('public.orders') + pg_total_relation_size('public.customers') AS b")).rows[0].b);
      await sizeClient.end();

      // ---- Mason: a container of the image, syncing this database (sync: off), its synced data on a volume of its own
      const volume = `bench-mason-${rows}`;
      const mason = await startMason(o, { db, pgPassword, limits, secrets, rows, volume }, made, log);
      try {
        if (fixture.environment.mason.engineMemory === "unknown") fixture.environment.mason.engineMemory = mason.engineMemory;
        const masonConn: pg.ClientConfig = { host: "127.0.0.1", port: mason.port, user: "bench", password: mason.password, database: mason.database, ssl: { rejectUnauthorized: false } };
        const ids = await pickLookupIds(pgConn, rows, Math.max(...o.clients));
        // ---- what Mason built after its first sync survives a restart, and a lookup and the join run on it
        await checkRestart(rows, masonConn, ids, log);
        // ---- the answers, before anything is timed
        const a = await answersOf(pgConn, ids), b = await answersOf(masonConn, ids);
        const answers = Object.fromEntries([...a.keys()].map((k) => [k, { postgres: md5(a.get(k)!), mason: md5(b.get(k) ?? "") }]));
        const differences = [...a.keys()].filter((k) => a.get(k) !== b.get(k)).map((k) => `${k}: Postgres ${a.get(k)!.slice(0, 300)}; Mason ${(b.get(k) ?? "none").slice(0, 300)}`);
        log(differences.length === 0 ? "  every statement's answer is the same on both" : `  ANSWERS DIFFER (a Mason defect; measured anyway):\n    ${differences.join("\n    ")}`);
        if (earlier !== null) {
          const copied = COLD_STATEMENTS.filter((st) => copiedFrom(earlier, st));
          const changed = postgresAnswerChanges(earlier.sizes.find((z) => z.rows === rows)!, Object.fromEntries([...a].map(([k, v]) => [k, md5(v)])), copied);
          if (changed.length > 0) throw new Usage(`--engines mason: at ${fmtRows(rows)} rows, Postgres's answer to ${changed.join(" and ")} is not the one ${o.postgresFrom} recorded, so its Postgres cells cannot be copied. Measure both engines`);
          log(`  Postgres's answers to ${copied.map((s) => s.name).join(" and ")} are the ones ${path.relative(REPO, o.postgresFrom)} recorded: their Postgres cells are copied. ` +
            `${COLD_STATEMENTS.filter((st) => !copied.includes(st)).map((s) => s.name).join(" and ")} measured on Postgres too`);
        }
        const size: ColdSize = { rows, customers: customersOf(rows), generatedSeconds: data.generatedSeconds, postgresBytes, masonBytes: mason.bytes, syncSeconds: mason.syncSeconds,
          backgroundSeconds: mason.backgroundSeconds, lookupIds: ids, answers, answersEqual: differences.length === 0, differences };

        // ---- the runs: each cold, the engines alternating which goes first
        const target: Record<ColdEngine, PgbenchTarget> = {
          postgres: { port: pgPort, db, user: "postgres", ssl: "disable", env: pgClientEnv },
          mason: { port: mason.port, db: mason.database, user: "bench", ssl: "require", env: mason.clientEnv },
        };
        const cold = async (engine: ColdEngine): Promise<number> => {
          // Mason stopped whichever is measured: Postgres alone, or Postgres restarted under it and idle
          docker(["stop", "-t", "120", MASON_CONTAINER]);
          const t = performance.now();
          docker(["restart", "-t", "120", PG_CONTAINER]);
          await untilAnswers(pgConn, "Postgres", READY_TIMEOUT_MS);
          let readyMs = performance.now() - t;
          if (engine === "mason") {
            const m = performance.now();
            docker(["start", MASON_CONTAINER]);
            await untilAnswers(masonConn, "Mason", READY_TIMEOUT_MS);
            readyMs = performance.now() - m;
          }
          await sleep(o.settleSeconds * 1000);
          dropPageCache();
          return readyMs;
        };
        const cells: ColdCell[] = [];
        for (const stmt of COLD_STATEMENTS) {
          for (const clients of o.clients) {
            const runs: Record<ColdEngine, ColdRun[]> = { postgres: [], mason: [] };
            fs.writeFileSync(path.join(clientDir, "script.sql"), coldScript(stmt, clients, ids));
            for (let n = 0; n < o.runs; n++) {
              // Mason alone: Postgres is measured only for a statement whose cells cannot be copied (the lookup, and one
              // the earlier run did not send)
              const measured = (e: ColdEngine): boolean => earlier === null || e === "mason" || !copiedFrom(earlier, stmt);
              for (const engine of ((n % 2 === 0 ? ["postgres", "mason"] : ["mason", "postgres"]) as ColdEngine[]).filter(measured)) {
                const readyMs = await cold(engine);
                const at = new Date().toISOString();
                // what the measured engine (and, beside Mason, the idle Postgres) read from disk while pgbench ran
                const measured = engine === "postgres" ? PG_CONTAINER : MASON_CONTAINER;
                const before = { measured: containerReadBytes(measured), idle: engine === "mason" ? containerReadBytes(PG_CONTAINER) : 0 };
                const times = await pgbench(o.postgresImage, clientDir, made.clientIdFile, target[engine], clients, uid, gid, zoneOf(stmt));
                const disk: DiskRead = { readBytes: containerReadBytes(measured) - before.measured,
                  ...(engine === "mason" ? { idleReadBytes: containerReadBytes(PG_CONTAINER) - before.idle } : {}) };
                const r = runOf(times, readyMs, at, disk);
                runs[engine].push(r);
                log(`[${fmtRows(rows)} · ${stmt.name} · ${clients} client${clients === 1 ? "" : "s"} · ${engine.padEnd(8)} · run ${n + 1}] slowest ${secondsText(r.slowestMs)}, mean ${secondsText(r.meanMs)}; read ${(r.readBytes / 1e6).toFixed(1)} MB; answered the probe ${secondsText(r.readyMs)} after its start`);
              }
            }
            for (const e of ["postgres", "mason"] as const) {
              // Mason alone: Postgres's cell as the earlier run measured it, unchanged
              cells.push(earlier !== null && e === "postgres" && copiedFrom(earlier, stmt) ? earlierPostgresCell(earlier, rows, clients, stmt.name) : coldCell(rows, clients, e, stmt.name, runs[e]));
            }
          }
        }
        fixture.sizes.push(size);
        fixture.cells.push(...cells);
        save(`${fmtRows(rows)} done`);
      } finally {
        if (made.mason !== null && removeQuietly(["rm", "-f", "-v", made.mason], log)) made.mason = null;
        if (made.volumes.has(volume) && removeQuietly(["volume", "rm", volume], log)) made.volumes.delete(volume);
      }
      if (!o.keepPostgres) {
        const c = new pg.Client({ connectionString: admin });
        await c.connect();
        try { await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`); log(`  dropped ${db} (its disk is the next size's)`); } finally { await c.end(); }
      }
    }
    fixture.complete = true;
    save("complete");
    log(`\n${"rows".padStart(5)} ${"clients".padStart(7)}  ${"statement".padEnd(17)} ${"Postgres".padStart(10)} ${"Mason".padStart(10)}`);
    for (const c of fixture.cells.filter((x) => x.engine === "mason")) {
      const p = fixture.cells.find((x) => x.engine === "postgres" && x.rows === c.rows && x.clients === c.clients && x.statement === c.statement);
      log(`${fmtRows(c.rows).padStart(5)} ${String(c.clients).padStart(7)}  ${c.statement.padEnd(17)} ${(p === undefined ? "-" : secondsText(p.slowestMs)).padStart(10)} ${secondsText(c.slowestMs).padStart(10)}`);
    }
    for (const k of fixture.skipped) log(`skipped ${fmtRows(k.rows)}: ${k.why}`);
    return 0;
  } finally { cleanup(); }
}

/** the CPU's model: Node's, else lscpu's (an arm64 server's /proc/cpuinfo names none Node reads), else "unknown" */
function cpuModel(): string {
  const node = os.cpus()[0]?.model.trim();
  if (node) return node;
  const r = spawnSync("lscpu", [], { encoding: "utf8" });
  return (r.status === 0 ? /^Model name:\s*(.+)$/m.exec(r.stdout)?.[1]?.trim() : undefined) || "unknown";
}

/** until the Postgres at `url` answers (a container started), at most two minutes */
async function untilReady(url: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const c = new pg.Client({ connectionString: url });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; } catch (e) {
      // the image's init runs a server on its socket alone, then the real one on TCP: refused until then
      await c.end().catch((x: Error) => { (e as Error).message += ` (closing: ${x.message})`; });
      if (Date.now() > deadline) throw new Error(`${PG_CONTAINER} did not accept connections in 120 s: ${(e as Error).message}; docker logs ${PG_CONTAINER} says why`);
      await sleep(500);
    }
  }
}

/** what this run made, by the ids docker gave back: the only things its cleanup removes */
interface Made {
  postgres: string | null; mason: string | null; network: string | null;
  /** Mason's volumes this run made and has not removed yet */
  volumes: Set<string>;
  /** where docker writes the id of pgbench's container while it runs */
  clientIdFile: string;
  /** where docker writes the id of the Postgres container this run makes */
  postgresIdFile: string;
}

/**
 * Another run's containers, or the volumes this run would make, refused before this run does anything: a run in
 * progress (its Postgres, Mason or client), or the Postgres a --keep-postgres run left, which --reuse-postgres adopts.
 */
function refuseRunInProgress(o: ColdOptions, procRoot: string): void {
  for (const name of [MASON_CONTAINER, CLIENT_CONTAINER]) {
    if (exists("container", name)) throw new Usage(`a container named ${name} exists already: a cold run in progress, or one that was killed. Wait for it, or remove it (docker rm -f -v ${name}) if no run is in progress`);
  }
  const pgThere = exists("container", PG_CONTAINER);
  // the run that holds the bench's Postgres now: one that made it, or one that adopted it, whatever lock it took
  if (exists("container", OWNER_CONTAINER)) {
    const held = ownerHeld();
    if (held.owner === "" || ownerAlive(held.owner, procRoot)) {
      throw new Usage(`a cold run may be in progress: ${OWNER_CONTAINER} says process ${held.owner === "" ? "unknown" : ownerPid(held.owner)} holds ${PG_CONTAINER}. Wait for it, or remove it (docker rm -f ${OWNER_CONTAINER}) if no run is in progress`);
    }
  }
  if (o.reusePostgres && !pgThere) throw new Usage(`--reuse-postgres: there is no container named ${PG_CONTAINER} (a run with --keep-postgres leaves one)`);
  if (o.reusePostgres) {
    // the run that made it: alive, it is using it (generating a size's data, or between sizes)
    const owner = docker(["inspect", "--format", `{{index .Config.Labels "${OWNER_LABEL}"}}`, PG_CONTAINER]);
    if (owner === "" || owner === "<no value>") throw new Usage(`${PG_CONTAINER} is not one a --cold --keep-postgres run left (it has no ${OWNER_LABEL} label): remove it (docker rm -f -v ${PG_CONTAINER})`);
    if (ownerAlive(owner, procRoot)) throw new Usage(`${PG_CONTAINER} belongs to a cold run that may be in progress (process ${ownerPid(owner)}): --reuse-postgres adopts it once that run has ended`);
  }
  if (!o.reusePostgres && pgThere) throw new Usage(`a container named ${PG_CONTAINER} exists already: a run in progress, or one --keep-postgres left (--reuse-postgres adopts it; docker rm -f -v ${PG_CONTAINER} removes it)`);
  for (const rows of o.sizes) {
    const volume = `bench-mason-${rows}`;
    if (exists("volume", volume)) throw new Usage(`a volume named ${volume} exists already: a cold run in progress, or one that was killed. Wait for it, or remove it (docker volume rm ${volume}) if no run is in progress`);
  }
}

/** the owner container's id and the run it names */
function ownerHeld(): { id: string; owner: string } {
  const out = docker(["inspect", "--format", `{{.Id}} {{index .Config.Labels "${OWNER_LABEL}"}}`, OWNER_CONTAINER]);
  const id = out.split(" ")[0] ?? "", owner = out.slice(id.length + 1).trim();
  return { id, owner: owner === "<no value>" ? "" : owner };
}
/**
 * This run made the owner container (`OWNER_CONTAINER`), labelled with `me`: its id. One a run that ended left (killed)
 * is removed by its id and made again; if another run made one between, that run holds it, and this one refuses.
 */
function takeOwner(image: string, me: string, procRoot: string): string {
  for (let tries = 0; tries < 2; tries++) {
    const r = spawnSync("docker", ["create", "--name", OWNER_CONTAINER, "--label", `${OWNER_LABEL}=${me}`, image, "true"], { encoding: "utf8" });
    if (r.error !== undefined) throw new Usage(`docker could not be run: ${r.error.message}`);
    if (r.status === 0) return r.stdout.trim().split("\n").pop()!.trim();
    if (!/already in use|conflict/i.test(r.stderr)) throw new Usage(`docker create ${OWNER_CONTAINER}: ${r.stderr.trim()}`);
    const held = ownerHeld();
    if (held.owner === "" || ownerAlive(held.owner, procRoot)) {
      throw new Usage(`a cold run may be in progress: ${OWNER_CONTAINER} says process ${held.owner === "" ? "unknown" : ownerPid(held.owner)} holds ${PG_CONTAINER}. Wait for it to end`);
    }
    // its run ended without removing it: removed by the id read, never by its name, which a run making it now may hold
    const rm = spawnSync("docker", ["rm", "-f", "-v", held.id], { encoding: "utf8" });
    if (rm.status !== 0 && !/no such/i.test(rm.stderr)) throw new Usage(`docker rm -f -v ${held.id} (${OWNER_CONTAINER}, an ended run's): ${rm.stderr.trim()}`);
  }
  throw new Usage(`another cold run took ${OWNER_CONTAINER} as this one did: wait for it to end`);
}

/** what the container logged, both streams: the image logs to stdout, and a warning may go to stderr. `since`: from
 *  that moment (an ISO time) on */
function containerLog(name: string, tail?: number, since?: string): string {
  const r = spawnSync("docker", ["logs", ...(tail === undefined ? [] : ["--tail", String(tail)]), ...(since === undefined ? [] : ["--since", since]), name], { encoding: "utf8", maxBuffer: 256 * 2 ** 20 });
  if (r.status !== 0) throw new Error(`docker logs ${name}: ${r.stderr.trim()}`);
  return `${r.stdout}\n${r.stderr}`;
}

/** the memory Mason's log says its engine was given: "at most 4096MiB of memory (MASON_DUCKDB_MEMORY)" */
export function engineMemoryOf(logText: string): string {
  return /at most (\S+) of memory \(MASON_DUCKDB_MEMORY\)/.exec(logText)?.[1] ?? "unknown";
}

/**
 * The sources file of the bench's project: both tables, never polled; the URL a variable, so the file holds no secret.
 * orders references customers by `customer_id`, written by hand as a user adds a relationship the database does not
 * declare (the cold data declares no foreign key, so `mason add` writes none), so its join reads the hidden integer
 * keys (src/duck/reference-keys.ts, issue 1144).
 */
export const SOURCES_FILE = "kind: postgres\nurl: ${DATABASE_URL}\nsync: off\ntables:\n  orders:\n    references:\n      customer_id: customers.id\n  customers: {}\n";

// --------------------------------------------------------------------------------------------- Mason's own work

/**
 * WHAT MASON DOES AFTER ITS FIRST SYNC, waited for before anything is timed. Mason exposes neither in `mason status
 * --json` or `/api/state`, so the run reads its log, where each says it is done:
 *  - the side table for lookups by orders.id (src/duck/key-lookup.ts, issue 1148), built once orders is synced, its line
 *    `public.orders: its side table for lookups by id built in …` (src/duck/sync.ts `buildLookup`). Lookups' side
 *    tables are built one at a time, the smallest table first, so customers' (if any) is done before orders';
 *  - the reference's hidden keys numbered on both tables (src/duck/reference-keys.ts, issue 1144), its line `public.orders
 *    (customer_id) references public.customers (id): a join on it reads hidden integer keys`, said once a run, when no
 *    row of either table is left unnumbered (`ReferenceNumbers.fill`).
 */
export const ORDERS_LOOKUP_BUILT = /\bpublic\.orders: its side table for lookups by id built in /;
export const REFERENCE_NUMBERED = /\bpublic\.orders \(customer_id\) references public\.customers \(id\): a join on it reads hidden integer keys\b/;
/** a hidden integer key's column, as a plan names it (src/duck/reference-keys.ts `NUMBER_RE`) */
const HIDDEN_KEY = /__mason_ref_[0-9a-f]{12}_[0-9a-f]{12}/;
/** the rows of one of the engine's row groups (src/duck/compact.ts `ROW_GROUP_ROWS`), and the row groups a key's value
 *  must fall in, on average, for Mason to build a table a side table (src/duck/key-lookup.ts `LOOKUP_MIN_ROW_GROUPS`).
 *  Copied, not imported, so the script loads no engine: tests/bench-replica.test.ts holds them equal */
export const ROW_GROUP_ROWS = 122_880;
export const LOOKUP_MIN_ROW_GROUPS = 8;
/**
 * Whether Mason builds orders a side table for lookups by id. A random UUID key's every row group spans nearly every
 * value, so a key's value falls in about every row group, and orders has at least rows / ROW_GROUP_ROWS of them. More
 * than LOOKUP_MIN_ROW_GROUPS: built (1 M orders have 9). At or under it, Mason may decide either way, and says nothing
 * when it builds none: the run does not wait for one. The 100 k smoke has one row group.
 */
export const sideTableExpected = (rows: number): boolean => Math.ceil(rows / ROW_GROUP_ROWS) > LOOKUP_MIN_ROW_GROUPS;
/** what Mason has not finished after its first sync, by its log, in words (none: done) */
export function backgroundLeft(logText: string, rows: number): string[] {
  const left: string[] = [];
  if (sideTableExpected(rows) && !ORDERS_LOOKUP_BUILT.test(logText)) left.push("the side table for lookups by orders.id (its log line: \"public.orders: its side table for lookups by id built in …\")");
  if (!REFERENCE_NUMBERED.test(logText)) {
    left.push("the numbering of the hidden keys of orders.customer_id and customers.id (its log line: \"public.orders (customer_id) references public.customers (id): a join on it reads hidden integer keys\")");
  }
  return left;
}
/** how long Mason may take over that work, after its first sync, and to say its keys are numbered after a restart */
const BACKGROUND_TIMEOUT_MS = 60 * 60_000;
const RESTART_NUMBERS_TIMEOUT_MS = 10 * 60_000;
/** an EXPLAIN ANALYZE's text without the line of the SQL Mason planned: what the engine ran (its profile). A join on the
 *  hidden keys whose rows are not all numbered runs the plain SQL, while that line still names the hidden keys */
const ranPlan = (plan: string): string => plan.split("\n").filter((l) => !/^\s*Sent to the engine:/.test(l)).join("\n");
/**
 * What Mason redid or did not run on after a restart, in words (none: all as it should be): the side table built again,
 * a lookup by orders.id that did not read it, or the join of orders to customers on their keys rather than the hidden
 * numbers. `log` is Mason's log since the restart; the plans are `EXPLAIN (ANALYZE, VERBOSE)`'s text.
 */
export function restartProblems(o: { rows: number; log: string; lookupPlan: string | null; joinPlan: string }): string[] {
  const out: string[] = [];
  if (sideTableExpected(o.rows)) {
    if (ORDERS_LOOKUP_BUILT.test(o.log)) out.push("it built the side table for lookups by orders.id again");
    if (o.lookupPlan === null || !/key_lookup:public\.orders/.test(ranPlan(o.lookupPlan))) out.push(`a lookup by orders.id did not read its side table:\n${o.lookupPlan ?? "(not run)"}`);
  }
  if (!HIDDEN_KEY.test(ranPlan(o.joinPlan))) out.push(`the join of orders to customers ran on customer_id and id, not on their hidden keys:\n${o.joinPlan}`);
  return out;
}

interface MasonUp { port: number; password: string; database: string; clientEnv: string; bytes: number; syncSeconds: number; backgroundSeconds: number; engineMemory: string }

/** until Mason's log says its work after the first sync is done (`backgroundLeft`), at most BACKGROUND_TIMEOUT_MS: ms
 *  waited. A container that stopped, or work not done in time, fails the run, naming what never finished */
async function untilBackgroundDone(rows: number, log: (l: string) => void): Promise<number> {
  const t0 = performance.now();
  let said = "";
  for (;;) {
    const left = backgroundLeft(containerLog(MASON_CONTAINER), rows);
    if (left.length === 0) return performance.now() - t0;
    if (left.join() !== said) { log(`  waiting for Mason to finish ${left.map((l) => l.replace(/ \(its log line.*$/, "")).join(", and ")}…`); said = left.join(); }
    if (docker(["inspect", "--format", "{{.State.Running}}", MASON_CONTAINER]) !== "true") throw new Error(`Mason's container stopped before it finished ${left.join("; and ")}:\n${containerLog(MASON_CONTAINER, 30)}`);
    if (performance.now() - t0 > BACKGROUND_TIMEOUT_MS) {
      throw new Error(`Mason did not finish its work after the first sync in ${BACKGROUND_TIMEOUT_MS / 60_000} minutes. Never finished: ${left.join("; and ")}. ` +
        `An image from before issues 1144 and 1148 does neither. Its log's last lines:\n${containerLog(MASON_CONTAINER, 30)}`);
    }
    await sleep(2000);
  }
}

/**
 * A COLD RESTART REDOES NONE OF IT: Mason restarted once its work after the first sync is done, and once it answers and
 * says its keys are numbered again, a lookup by orders.id and the join of orders to customers run under EXPLAIN
 * (ANALYZE, VERBOSE). The lookup must read the side table, the join the hidden keys (in what the engine ran, not the
 * SQL Mason planned), and the side table must not be built again. Fails the run otherwise: it would measure other work.
 */
async function checkRestart(rows: number, masonConn: pg.ClientConfig, ids: readonly string[], log: (l: string) => void): Promise<void> {
  docker(["stop", "-t", "120", MASON_CONTAINER]);
  const since = new Date().toISOString();
  docker(["start", MASON_CONTAINER]);
  const t0 = performance.now();
  await untilAnswers(masonConn, "Mason", READY_TIMEOUT_MS);
  // the line is said once a run: again in this one once a numbering turn finds every row numbered
  while (!REFERENCE_NUMBERED.test(containerLog(MASON_CONTAINER, undefined, since))) {
    if (performance.now() - t0 > RESTART_NUMBERS_TIMEOUT_MS) {
      throw new Error(`after a restart, Mason did not say the hidden keys of orders.customer_id and customers.id are numbered in ${RESTART_NUMBERS_TIMEOUT_MS / 60_000} minutes. Its log's last lines:\n${containerLog(MASON_CONTAINER, 30)}`);
    }
    await sleep(1000);
  }
  const numberedMs = performance.now() - t0;
  const explain = async (st: ColdStatement, id?: string): Promise<string> => {
    const c = new pg.Client(masonConn);
    await c.connect();
    try {
      await c.query(`SET TIME ZONE '${zoneOf(st)}'`);
      return ((await c.query(`EXPLAIN (ANALYZE, VERBOSE) ${statementSql(st, id)}`)).rows as Array<{ "QUERY PLAN": string }>).map((r) => r["QUERY PLAN"]).join("\n");
    } finally { await c.end(); }
  };
  const statement = (name: string): ColdStatement => COLD_STATEMENTS.find((s) => s.name === name)!;
  const lookupPlan = sideTableExpected(rows) ? await explain(statement("lookup"), ids[0]) : null;
  const joinPlan = await explain(statement("revenue_by_month"));
  const problems = restartProblems({ rows, log: containerLog(MASON_CONTAINER, undefined, since), lookupPlan, joinPlan });
  if (problems.length > 0) throw new Error(`after a restart, Mason did not run on what it built after its first sync:\n  ${problems.join("\n  ")}`);
  log(`  after a restart: the hidden keys numbered ${secondsText(numberedMs)} after its start; ${lookupPlan === null ? "no side table expected at this size; " : "a lookup reads the side table; "}the join reads the hidden keys`);
}
/** Mason for one size: the image, syncing the size's database by the network alias, every table `sync: off`; its first
 *  sync waited for, a bench user made, its password in a 0600 env file and never printed */
async function startMason(o: ColdOptions, s: { db: string; pgPassword: string; limits: string[]; secrets: string; rows: number; volume: string }, made: Made, log: (l: string) => void): Promise<MasonUp> {
  if (exists("container", MASON_CONTAINER)) throw new Usage(`a container named ${MASON_CONTAINER} exists already: remove it (docker rm -f -v ${MASON_CONTAINER}) if it is a bench's`);
  if (exists("volume", s.volume)) throw new Usage(`a volume named ${s.volume} exists already: remove it (docker volume rm ${s.volume}) if it is a bench's`);
  const env = path.join(s.secrets, `mason-${s.rows}.env`);
  writeSecret(env, {
    // the bench's own network, which no one else is on: no TLS to the source
    DATABASE_URL: `postgres://postgres:${s.pgPassword}@${PG_ALIAS}:5432/${s.db}?sslmode=disable`,
    MASON_API_KEY: randomBytes(24).toString("hex"), MASON_NAME: "bench", MASON_PG_SELF_SIGNED_TLS: "1", MASON_PROJECT_READONLY: "1", MASON_STATEMENT_TIMEOUT: "0",
  });
  const port = await freePort(), health = await freePort();
  const t0 = performance.now();
  log(`Mason: syncing ${s.db} in ${MASON_CONTAINER} (${o.masonImage})…`);
  made.volumes.add(docker(["volume", "create", s.volume]));
  made.mason = docker(["create", "--name", MASON_CONTAINER, "--network", NETWORK, ...s.limits, "--env-file", env, "-v", `${s.volume}:/mason/data`,
    "-p", `127.0.0.1:${port}:5433`, "-p", `127.0.0.1:${health}:4140`, o.masonImage]);
  // the project goes into the container, not through a bind mount: the container's user (uid 1000) reads it wherever
  // --work is, whatever this user's folders allow
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cold-project-"));
  try {
    fs.mkdirSync(path.join(project, "sources"), { mode: 0o755 });
    fs.writeFileSync(path.join(project, "sources", "bench.yml"), SOURCES_FILE, { mode: 0o644 });
    docker(["cp", `${project}/.`, `${MASON_CONTAINER}:/mason/project`]);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
  docker(["start", MASON_CONTAINER]);
  // up first: a `mason wait` during the first start's read of how the database orders text says "not running"
  for (;;) {
    const ok = await fetch(`http://127.0.0.1:${health}/healthz`).then((r) => r.ok, () => false);
    if (ok) break;
    const running = docker(["inspect", "--format", "{{.State.Running}}", MASON_CONTAINER]);
    if (running !== "true") throw new Error(`Mason's container stopped before it was up:\n${containerLog(MASON_CONTAINER, 30)}`);
    if (performance.now() - t0 > READY_TIMEOUT_MS) throw new Error(`Mason was not up in ${READY_TIMEOUT_MS / 60_000} minutes:\n${containerLog(MASON_CONTAINER, 30)}`);
    await sleep(1000);
  }
  const w = await run("docker", ["exec", MASON_CONTAINER, "mason", "wait", "--timeout", "12h", "--json"]);
  const waited = ((): { ready?: boolean } | null => { try { return JSON.parse(w.stdout) as { ready?: boolean }; } catch { return null; } })();
  if (w.status !== 0 || waited?.ready !== true) throw new Error(`Mason's first sync did not finish (mason wait exit ${w.status}): ${(w.stdout || w.stderr).slice(0, 2000)}`);
  const syncSeconds = round((performance.now() - t0) / 1000, 1);
  // its own work on the synced data after that, before anything is timed: the lookup's side table, the hidden keys
  const backgroundSeconds = round(await untilBackgroundDone(s.rows, log) / 1000, 1);
  const added = await run("docker", ["exec", MASON_CONTAINER, "mason", "user", "add", "bench", "--json"]);
  // what mason user add said is never printed: it holds the password
  const user = ((): { password?: unknown; database?: unknown } | null => { try { return JSON.parse(added.stdout) as { password?: unknown; database?: unknown }; } catch { return null; } })();
  if (added.status !== 0 || typeof user?.password !== "string") throw new Error(`mason user add bench failed (exit ${added.status}): ${added.stderr.trim().slice(0, 500)}`);
  const database = typeof user.database === "string" ? user.database : "mason";
  const clientEnv = path.join(s.secrets, `client-mason-${s.rows}.env`);
  writeSecret(clientEnv, { PGPASSWORD: user.password });
  const bytes = Number(docker(["exec", MASON_CONTAINER, "du", "-sb", "/mason/data"]).split(/\s/)[0]);
  const engineMemory = engineMemoryOf(containerLog(MASON_CONTAINER));
  log(`  synced and served in ${syncSeconds} s, its work after that done ${backgroundSeconds} s later; its volume ${gibText(bytes)}; its engine at most ${engineMemory} of memory`);
  return { port, password: user.password, database, clientEnv, bytes, syncSeconds, backgroundSeconds, engineMemory };
}

export interface PgbenchTarget { port: number; db: string; user: string; ssl: string; env: string }
/**
 * pgbench's container for one run: on the host's network, as this user, the password from the 0600 env file. The
 * session's time zone is the statement's (`zoneOf`), by libpq's PGTZ, which sets it as the session starts: the same
 * setting `SET TIME ZONE` sets, outside the time pgbench records. A zone is no secret, so it is on the command line.
 */
export function pgbenchArgs(o: { image: string; clientDir: string; idFile: string; target: PgbenchTarget; clients: number; uid: number; gid: number; timeZone: string }): string[] {
  if (!/^[A-Za-z_]+(\/[A-Za-z_+-]+)*$/.test(o.timeZone)) throw new Error(`a time zone is an IANA name: ${JSON.stringify(o.timeZone)}`);
  const t = o.target;
  return ["run", "--rm", "--cidfile", o.idFile, "--name", CLIENT_CONTAINER, "--network", "host", "--user", `${o.uid}:${o.gid}`, "-v", `${o.clientDir}:/work`, "--env-file", t.env,
    "-e", `PGTZ=${o.timeZone}`, o.image, "pgbench", "-n", "-c", String(o.clients), "-j", String(o.clients), "-t", "1", "-f", "/work/script.sql", "--log", "--log-prefix=/work/log",
    `host=127.0.0.1 port=${t.port} dbname=${t.db} user=${t.user} sslmode=${t.ssl}`];
}
/** one run's clients: pgbench in a container of its own (`pgbenchArgs`), its log read back */
async function pgbench(image: string, clientDir: string, idFile: string, t: PgbenchTarget, clients: number, uid: number, gid: number, timeZone: string): Promise<ClientTime[]> {
  for (const f of fs.readdirSync(clientDir)) if (f.startsWith("log")) fs.rmSync(path.join(clientDir, f));
  // docker refuses a --cidfile that exists: the last run's, its container gone with --rm
  fs.rmSync(idFile, { force: true });
  const r = await run("docker", pgbenchArgs({ image, clientDir, idFile, target: t, clients, uid, gid, timeZone }));
  if (r.status !== 0) throw new Error(`pgbench exited ${r.status}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  const text = fs.readdirSync(clientDir).filter((f) => f.startsWith("log")).map((f) => fs.readFileSync(path.join(clientDir, f), "utf8")).join("\n");
  return parsePgbenchLog(text, clients);
}
