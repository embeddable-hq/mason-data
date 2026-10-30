#!/usr/bin/env node
/**
 * MASON AGAINST A POSTGRES READ REPLICA (docs/BENCHMARK.md): why not just use a Postgres read replica, as a) the
 * concurrency increases and b) the size of the underlying rows increases.
 *
 * For each table SIZE and each CLIENT COUNT, the same BI-shaped read statements, written in Postgres's SQL and sent as
 * written, are run against (a) a Postgres holding synthetic `orders` and `customers` tables with a replica's indexes,
 * and (b) Mason serving a copy of the same tables, made from that Postgres by the real copy (src/duck/sync.ts) and
 * served by the real listener (src/api/postgres/server.ts), in this process, wired as `mason start` wires them: the
 * request log on, the stored JSON paths on (as they ship). Every client runs the statements round-robin for a fixed wall
 * time after a warm-up; p50 / p95 are of every statement's wall time, queries/s is completed / seconds. Before a size is
 * measured, every statement's answer from Mason is held equal to Postgres's, so the two are timed on the same answers.
 *
 *   node scripts/bench-replica.ts                          # its own Postgres 18 container (bench-pg), removed at the end
 *   node scripts/bench-replica.ts --postgres postgres://…  # a Postgres someone started (its user needs CREATEDB)
 *     --sizes 1M,10M,50M  --clients 1,8,32,128  --seconds 30  --warmup 5  --runs 2  --timeout 120 (a statement's limit, s)
 *     --memory 8GiB       # DuckDB's limit AND the container's --memory (default MASON_DUCKDB_MEMORY, else half the RAM)
 *     --label "<where>"   # the environment's name, written into the fixture and printed by docs/MEASUREMENTS.md
 *     --out tests/fixtures/bench-replica.json   --work <dir> (Mason's copy; default the OS temp dir)
 *     --reserve-gb 60     # a size whose estimate would leave less free disk than this is skipped, said
 *     --keep-postgres     # leave the bench-pg container (and its data) for the next run
 *
 * A LAYOUT OF THE COPY, MEASURED (bench-only, issue #9's measurement; none of these is in a published run):
 *     --order "<expr>, …" # the copy of public.orders rewritten in this physical order after it lands and its stored
 *                         # JSON path is ready: with Mason's store open by the bench alone (the sync, the request log and
 *                         # the listener closed), CREATE TABLE … AS SELECT * … ORDER BY <expr> and a swap by name, so
 *                         # _mason's bookkeeping is untouched and only the row groups' order changes; recorded in the
 *                         # fixture (environment.mason.order, sizes[].reorder: its time, row groups, bytes)
 *     --mason-only        # Postgres still makes the data and the answers are still compared; only Mason's cells are
 *                         # measured (a grid only: the sweep is Postgres's)
 *     --reuse-postgres    # adopt the bench-pg container a --keep-postgres run left (its URL read from docker), as
 *                         # this run's own: stopped while Mason is measured, as the run that made it did
 *     --keep-copy         # leave Mason's copy (the work dir) at the end, with statements.json beside it: the DuckDB
 *                         # SQL Mason plans for each statement (its EXPLAIN), to time them on the file alone
 *
 * THE SWEEP TO A MINUTE (both the concurrency and the row count are pushed until Postgres takes at least a minute to
 * answer): with `--target-postgres-seconds <n>` (the published run: 60) the
 * sizes and client counts are not a grid but two sweeps, Mason measured at every cell Postgres is:
 *   (a) ROWS, at a dashboard's concurrency (`--sweep-clients`, 8): from the first `--sizes`, about √10 a step (1M, 3M,
 *       10M, 30M, 100M, …) until Postgres's p95 of the mix reaches the target, or the disk or `--max-rows` stops it, said
 *       (the next size's disk is predicted from the bytes a row the last size measured on both engines);
 *   (b) CLIENTS, at the largest size (a) measured under the target (`--clients-rows <n>` to choose): the `--clients`
 *       list, then doubling past its end, until Postgres's p95 reaches the target or `--max-clients` (1024) stops it.
 *     --target-postgres-seconds 60   --sweep-clients 8   --max-clients 1024   --max-rows 1000M   --clients-rows 10M
 * A cell after one whose Postgres p95 was over a tenth of the target is measured for at least 3 × the target, and
 * `--timeout` is at least 5 × the target (its default then). Every cell warms up for `--warmup` and at least one pass of
 * the mix by every client. The container's max_connections is raised past `--max-clients`.
 *
 * EACH ENGINE IS MEASURED WITH THE OTHER STOPPED: while Postgres runs, Mason is closed (its DuckDB memory released, the
 * file kept, opened again as `mason start` does after a stop); while Mason runs, the bench's Postgres container is
 * stopped (`docker stop`: its shared_buffers released). An idle one is not equivalent: its memory stays resident and
 * takes the other's page cache. A `--postgres` server is not this script's to stop, and stays up (said in the fixture).
 *
 * The clients are a separate Node process (this script with --client-worker), N `pg` clients on one event loop, so the
 * load generator never shares Mason's event loop; its event-loop delay and CPU are recorded per run, so a client
 * process that was the bottleneck shows. The data is generated by generate_series, never anyone's data, into databases
 * `bench_replica_<rows>` (kept on a --postgres server for the next run; `COMMENT ON TABLE orders` says what they hold).
 * The copy is not polled while statements are measured (the data does not change; a poll is a scan of the source).
 * The fixture is written after each size and at the end, so an interrupted run keeps what it measured.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), "..");
const CONTAINER = "bench-pg";
const IMAGE = "postgres:18";
/** what the databases hold; a database whose orders' comment differs is made again */
const DATA_VERSION = 1;
/** a size's disk, both engines, by the row (Postgres's heap, its indexes and WAL headroom, and Mason's file): an estimate */
const BYTES_PER_ROW = 700;

// --------------------------------------------------------------------------------------------- the statements

/** The data's two years start here; the windows below are literals, as a BI tool's filter sends them. */
const DATA_START = "2024-10-01 00:00:00+00";
const DATA_DAYS = 730;
const TENANTS = 200;

export interface BenchQuery { name: string; title: string; sql: string; params?: "id" }
export const QUERIES: BenchQuery[] = [
  { name: "status", title: "orders and revenue by status, every row",
    sql: "SELECT status, count(*) AS orders, sum(amount) AS revenue FROM public.orders GROUP BY status ORDER BY status" },
  { name: "daily_tenant", title: "one tenant's orders per day, last 90 days",
    sql: "SELECT date_trunc('day', created_at) AS day, count(*) AS orders, sum(amount) AS revenue FROM public.orders " +
      "WHERE tenant_id = 42 AND created_at >= timestamptz '2026-07-03 00:00:00+00' AND created_at < timestamptz '2026-10-01 00:00:00+00' GROUP BY 1 ORDER BY 1" },
  { name: "top_customers", title: "top 20 customers by amount, joined to customers",
    sql: "SELECT c.id, c.name, sum(o.amount) AS total FROM public.orders o JOIN public.customers c ON c.id = o.customer_id " +
      "GROUP BY c.id, c.name ORDER BY total DESC, c.id LIMIT 20" },
  { name: "json_source", title: "orders by a JSON field (payload ->> 'source')",
    sql: "SELECT payload ->> 'source' AS source, count(*) AS orders FROM public.orders GROUP BY 1 ORDER BY 1" },
  { name: "window_count", title: "paid orders in a 30-day window",
    sql: "SELECT count(*) FROM public.orders WHERE status = 'paid' AND created_at >= timestamptz '2026-09-01 00:00:00+00' AND created_at < timestamptz '2026-10-01 00:00:00+00'" },
  { name: "point_lookup", title: "one order by its primary key",
    sql: "SELECT id, tenant_id, customer_id, status, amount, created_at, payload, note FROM public.orders WHERE id = $1", params: "id" },
];

export const customersOf = (rows: number): number => Math.max(1000, Math.round(rows / 20));

/** The synthetic schema and rows, in Postgres's own generate_series: heap order is insertion order, created_at rising
 *  with it as an append-only orders table's does. */
export function dataSql(rows: number): string[] {
  const nc = customersOf(rows);
  return [
    "SELECT setseed(0.42)",
    `CREATE TABLE public.customers (id bigint PRIMARY KEY, tenant_id integer NOT NULL, name text NOT NULL, email text NOT NULL, created_at timestamptz NOT NULL)`,
    `INSERT INTO public.customers SELECT g, 1 + g % ${TENANTS}, 'Customer ' || g, 'customer' || g || '@example.com', ` +
      `timestamptz '${DATA_START}' + (g::float8 / ${nc}) * interval '${DATA_DAYS} days' FROM generate_series(1, ${nc}) g`,
    `CREATE TABLE public.orders (id bigint NOT NULL, tenant_id integer NOT NULL, customer_id bigint NOT NULL, status text NOT NULL, ` +
      `amount numeric(12,2) NOT NULL, created_at timestamptz NOT NULL, payload jsonb NOT NULL, note text)`,
    `INSERT INTO public.orders SELECT g, 1 + c % ${TENANTS}, c, ` +
      `CASE WHEN r < 0.05 THEN 'pending' WHEN r < 0.45 THEN 'paid' WHEN r < 0.75 THEN 'shipped' WHEN r < 0.93 THEN 'delivered' WHEN r < 0.98 THEN 'cancelled' ELSE 'refunded' END, ` +
      `round((5 + random() * 495)::numeric, 2), ` +
      `timestamptz '${DATA_START}' + ((g - 1)::float8 / ${rows}) * interval '${DATA_DAYS} days' + floor(random() * 600) * interval '1 second', ` +
      `jsonb_build_object('source', (ARRAY['web','ios','android','api','pos','email'])[1 + floor(random() * 6)::int], ` +
      `'campaign', 'cmp-' || floor(random() * 40)::int, ` +
      `'device', jsonb_build_object('os', (ARRAY['ios','android','macos','windows','linux'])[1 + floor(random() * 5)::int], 'version', (10 + floor(random() * 8))::int || '.' || floor(random() * 10)::int), ` +
      `'items', 1 + floor(random() * 9)::int, 'gift', random() < 0.1, 'ref', md5(g::text)), ` +
      `CASE WHEN random() < 0.3 THEN 'customer asked for ' || (ARRAY['gift wrap','a call before delivery','delivery after 5pm','an invoice'])[1 + floor(random() * 4)::int] END ` +
      `FROM (SELECT g, 1 + floor(random() * ${nc})::bigint AS c, random() AS r FROM generate_series(1, ${rows}) g) s`,
    "ALTER TABLE public.orders ADD PRIMARY KEY (id)",
    "CREATE INDEX orders_tenant_created ON public.orders (tenant_id, created_at)",
    "CREATE INDEX orders_status ON public.orders (status)",
    "CREATE INDEX orders_created ON public.orders (created_at)",
    "VACUUM (ANALYZE) public.customers",
    "VACUUM (ANALYZE) public.orders",
    `COMMENT ON TABLE public.orders IS '${marker(rows)}'`,
  ];
}
const marker = (rows: number): string => `bench-replica v${DATA_VERSION}: ${rows} orders, ${customersOf(rows)} customers`;

// --------------------------------------------------------------------------------------------- the fixture

export interface RunStats { p50Ms: number; p95Ms: number; qps: number; completed: number; errors: number; loadAvg?: number[]; clientLoopDelayP99Ms?: number; clientCpuPct?: number }
export interface Cell {
  rows: number; clients: number; engine: "postgres" | "mason"; query: string; p50Ms: number; p95Ms: number; qps: number; completed: number; errors: number; errorCodes: Record<string, number>;
  /** the window each run measured, s */
  seconds: number;
  /** on the mix's cell: its slowest statement by p50 */
  slowest?: { query: string; p50Ms: number };
  runs: RunStats[];
}
/** where a sweep ended: the cell whose Postgres p95 reached the target, or the last one measured when something else stopped it */
export interface SweepVerdict {
  /** the axis swept, and what was held */
  axis: "rows" | "clients"; rows: number | null; clients: number | null;
  /** why the clients sweep is at its size */
  rowsWhy?: string;
  /** every value measured, in order */
  steps: number[];
  /** the cell that reached the target; null when the sweep stopped first */
  reached: { rows: number; clients: number } | null;
  /** what stopped the sweep before the target, in words; null when it reached it */
  stopped: string | null;
  /** the last cell measured (the one that reached it, or the last before the stop): both engines there */
  at: { rows: number; clients: number; postgresP95Ms: number; postgresQps: number; slowest: { query: string; p50Ms: number }; masonP95Ms: number; masonQps: number } | null;
}
export interface SizeResult {
  rows: number; customers: number;
  /** the data's generation in Postgres, s; null when an existing database was reused */
  generatedSeconds: number | null;
  postgresBytes: number;
  /** Mason's copy of both tables: the wall time to served (every copy and its catch-up poll), and each table's copy */
  copySeconds: number; copyTables: Record<string, number | null>;
  masonFileBytes: number;
  /** the stored JSON path (payload ->> 'source'): seconds from its first reads to ready, null if it was not ready */
  jsonPathReadySeconds: number | null;
  /** every statement's answer equal on both before measuring; the differences when not */
  answersEqual: boolean; differences: string[];
  /** --order: the copy of orders rewritten in that order before the answers were compared and the cells measured */
  reorder?: Reordered;
}
/** a copy rewritten in another physical order (--order): what it took and what it changed */
export interface Reordered {
  table: string; order: string;
  /** the rewrite's wall time (the sort, the new table written, the swap and a checkpoint), s */
  seconds: number;
  rows: number; rowGroupsBefore: number; rowGroupsAfter: number;
  /** the file's blocks in use (pragma_database_size: used_blocks × block_size), before and after; the dropped table's
   *  blocks are free after it, so the file itself grows by the new table (fileBytesAfter) */
  usedBytesBefore: number; usedBytesAfter: number; fileBytesAfter: number;
}
export interface Fixture {
  environment: {
    label: string; date: string;
    machine: { cpus: number; cpuModel: string; ramBytes: number; memoryBytes: number; os: string; arch: string; node: string };
    postgres: { version: string; where: string; containerMemoryBytes: number | null; settings: Record<string, string> };
    mason: { commit: string; duckdb: string; memoryLimit: string; memoryLimitBytes: number; copyParallel: number; storeJsonPaths: boolean;
      /** --order: the physical order public.orders was rewritten in (absent: the copy's own, the source's heap order) */
      order?: string };
    method: { sizes: number[]; clients: number[]; seconds: number; warmupSeconds: number; runs: number; statementTimeoutSeconds: number; clientProcess: string;
      /** the sweep to a target (null: the grid of sizes × clients) */
      targetPostgresSeconds: number | null; maxClients: number | null; sweepClients: number | null;
      /** what ran beside each engine's measurement */
      isolation: string;
      /** --mason-only: Postgres made the data and the answers, and no Postgres cell was measured */
      masonOnly?: boolean };
  };
  /** the two sweeps' verdicts, with --target-postgres-seconds */
  sweeps?: { rows: SweepVerdict | null; clients: SweepVerdict | null };
  queries: Array<{ name: string; title: string; sql: string }>;
  sizes: SizeResult[];
  skipped: Array<{ rows: number; why: string }>;
  cells: Cell[];
  complete: boolean;
}

// --------------------------------------------------------------------------------------------- arguments

interface Options {
  sizes: number[]; clients: number[]; seconds: number; warmup: number; runs: number; postgres: string | null; out: string; label: string;
  memory: string | null; work: string; reserveGb: number; keepPostgres: boolean; timeoutSeconds: number | null;
  targetSeconds: number | null; maxClients: number; maxRows: number; clientsRows: number | null; sweepClients: number;
  order: string | null; masonOnly: boolean; reusePostgres: boolean; keepCopy: boolean;
}
export function parseCount(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s.trim());
  if (m === null) throw new Usage(`${JSON.stringify(s)} is not a row count: write 1000000, 1M or 500k`);
  return Math.round(Number(m[1]) * (m[2]!.toLowerCase() === "m" ? 1e6 : m[2]!.toLowerCase() === "k" ? 1e3 : 1));
}
/** an option the run cannot take: said by its message alone (anything else is said with its stack) */
class Usage extends Error {}
function parseArgs(argv: string[]): Options {
  const o: Options = { sizes: [1e6, 1e7, 5e7], clients: [1, 8, 32, 128], seconds: 30, warmup: 5, runs: 2, postgres: null,
    out: path.join(REPO, "tests/fixtures/bench-replica.json"), label: os.hostname(), memory: null, work: os.tmpdir(), reserveGb: 60, keepPostgres: false, timeoutSeconds: null,
    targetSeconds: null, maxClients: 1024, maxRows: 1e9, clientsRows: null, sweepClients: 8, order: null, masonOnly: false, reusePostgres: false, keepCopy: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = (): string => { const x = argv[++i]; if (x === undefined) throw new Usage(`${a} needs a value`); return x; };
    const num = (): number => { const s = v(), n = Number(s); if (!Number.isFinite(n) || n <= 0) throw new Usage(`${a} ${s}: a positive number`); return n; };
    switch (a) {
      case "--sizes": o.sizes = v().split(",").map(parseCount); break;
      case "--clients": o.clients = v().split(",").map((s) => { const n = Number(s); if (!Number.isInteger(n) || n < 1) throw new Usage(`--clients ${s}: a whole number`); return n; }); break;
      case "--seconds": o.seconds = num(); break;
      case "--warmup": o.warmup = num(); break;
      case "--runs": o.runs = Math.round(num()); break;
      case "--postgres": o.postgres = v(); break;
      case "--out": o.out = path.resolve(v()); break;
      case "--label": o.label = v(); break;
      case "--memory": o.memory = v(); break;
      case "--work": o.work = path.resolve(v()); break;
      case "--reserve-gb": o.reserveGb = num(); break;
      case "--timeout": o.timeoutSeconds = num(); break;
      case "--keep-postgres": o.keepPostgres = true; break;
      case "--target-postgres-seconds": o.targetSeconds = num(); break;
      case "--max-clients": o.maxClients = Math.round(num()); break;
      case "--max-rows": o.maxRows = parseCount(v()); break;
      case "--clients-rows": o.clientsRows = parseCount(v()); break;
      case "--sweep-clients": o.sweepClients = Math.round(num()); break;
      case "--order": o.order = v(); reorderSql("public", "orders", o.order); break;
      case "--mason-only": o.masonOnly = true; break;
      case "--reuse-postgres": o.reusePostgres = true; break;
      case "--keep-copy": o.keepCopy = true; break;
      case "--help": case "-h":
        process.stdout.write(fs.readFileSync(SCRIPT, "utf8").split(" */")[0]!.replace(/^#!.*\n\/\*\*\n/, "").replace(/^ \* ?/gm, "") + "\n");
        process.exit(0);
        break;
      default: throw new Usage(`unknown option ${a} (--help lists them)`);
    }
  }
  if (o.targetSeconds !== null && o.timeoutSeconds !== null && o.timeoutSeconds < 5 * o.targetSeconds) {
    throw new Usage(`--timeout ${o.timeoutSeconds} is under 5 × --target-postgres-seconds ${o.targetSeconds}: a statement past the target must be able to finish. ` +
      `Leave --timeout out (it is then ${5 * o.targetSeconds}) or give at least ${5 * o.targetSeconds}`);
  }
  if (o.masonOnly && o.targetSeconds !== null) throw new Usage("--mason-only measures a grid: the sweep to a target is Postgres's (leave out --target-postgres-seconds)");
  if (o.reusePostgres && o.postgres !== null) throw new Usage("--reuse-postgres adopts the bench's own container; --postgres names a server instead: give one of them");
  if (o.targetSeconds !== null && [...o.clients, o.sweepClients].some((c) => c > o.maxClients)) throw new Usage(`--clients ${o.clients.join(",")} or --sweep-clients ${o.sweepClients} goes past --max-clients ${o.maxClients}`);
  return o;
}
/** a statement's limit, s: --timeout, else 120, else 5 × the target */
const timeoutOf = (o: Options): number => o.timeoutSeconds ?? (o.targetSeconds === null ? 120 : 5 * o.targetSeconds);

/**
 * THE COPY REWRITTEN IN ANOTHER PHYSICAL ORDER (--order): a side table made by `CREATE TABLE … AS SELECT * … ORDER BY`
 * (every column, the stored JSON paths' hidden ones too, with the types the copy gave them; no key, as the copy has
 * none), swapped in by name in one transaction, then a checkpoint so the new row groups are on disk. The time zone is
 * UTC so a `date_trunc` of a timestamptz buckets as the data's own instants do. `order` is the ORDER BY list as written
 * (DuckDB's SQL); one statement only.
 */
export function reorderSql(schema: string, table: string, order: string): string[] {
  if (order.trim() === "" || order.includes(";")) throw new Usage(`--order ${JSON.stringify(order)}: an ORDER BY list, e.g. "date_trunc('month', created_at), tenant_id, created_at"`);
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const target = `${q(schema)}.${q(table)}`, side = `${q(schema)}.${q(`${table}__bench_order`)}`;
  return [
    "SET TimeZone = 'UTC'",
    `DROP TABLE IF EXISTS ${side}`,
    `CREATE TABLE ${side} AS SELECT * FROM ${target} ORDER BY ${order}`,
    "BEGIN TRANSACTION",
    `DROP TABLE ${target}`,
    `ALTER TABLE ${side} RENAME TO ${q(table)}`,
    "COMMIT",
    "CHECKPOINT",
  ];
}

/** the rows sweep's next size: about √10 a step, on 1-3-10 (1M, 3M, 10M, 30M, …); another start keeps its own digits */
export function nextSize(n: number): number {
  const mag = 10 ** Math.floor(Math.log10(n)), lead = n / mag;
  if (lead === 1) return 3 * n;
  if (lead === 3) return 10 * mag;
  return Math.round(Math.round(n * Math.sqrt(10) / mag * 10) / 10 * mag);
}
/** the clients sweep: the list as given (sorted), then doubling past its end, up to max (inclusive) */
export function clientSteps(list: readonly number[], max: number): number[] {
  const out = [...new Set(list)].sort((a, b) => a - b).filter((c) => c <= max);
  for (let c = (out[out.length - 1] ?? 1) * 2; c <= max; c *= 2) out.push(c);
  return out;
}

// --------------------------------------------------------------------------------------------- the client process

interface WorkerConfig { conn: pg.ClientConfig; clients: number; warmupMs: number; seconds: number; timeoutMs: number; rows: number; queries: BenchQuery[]; offset: number }
interface WorkerResult { perQuery: Record<string, { latencies: number[]; errors: Record<string, number> }>; windowMs: number; /** from the start to the window's opening */ warmupMs: number; loopDelayP99Ms: number; cpuPct: number; brokenClients: string[] }

const raw = { getTypeParser: () => (v: string) => v };
const queryOf = (q: BenchQuery, rows: number, id?: number): pg.QueryConfig =>
  ({ text: q.sql, ...(q.params === "id" ? { values: [String(id ?? 1 + Math.floor(Math.random() * rows))] } : {}), rowMode: "array", types: raw } as pg.QueryConfig);

/** One cell's clients: connected first, then round-robin through the statements from the warm-up to the window's end.
 *  The window opens once the warm-up's time has passed AND every client has run every statement once (a pass of the
 *  mix: at a cell where one takes a minute, a fixed warm-up would measure cold reads). A statement counts when it
 *  STARTED inside the window; the window ends when the last of those ends. */
async function clientWorker(cfg: WorkerConfig): Promise<WorkerResult> {
  const clients: pg.Client[] = [];
  await Promise.all(Array.from({ length: cfg.clients }, async () => {
    const c = new pg.Client({ ...cfg.conn, application_name: "bench-replica" });
    await c.connect();
    await c.query("SET TimeZone = 'UTC'");
    await c.query(`SET statement_timeout = ${Math.round(cfg.timeoutMs)}`);
    clients.push(c);
  }));
  const perQuery: WorkerResult["perQuery"] = Object.fromEntries(cfg.queries.map((q) => [q.name, { latencies: [], errors: {} }]));
  const broken: string[] = [];
  const loop = monitorEventLoopDelay({ resolution: 5 });
  const t0 = performance.now();
  // open once every client's first pass is done and the warm-up's time has passed: set by the last client to finish its pass
  let windowStart = Infinity, windowEnd = Infinity, passed = 0;
  const open = (): void => { windowStart = Math.max(t0 + cfg.warmupMs, performance.now()); windowEnd = windowStart + cfg.seconds * 1000; };
  if (clients.length === 0) open();
  loop.enable();
  const cpu0 = process.cpuUsage();
  let lastEnd = 0;
  await Promise.all(clients.map(async (c, i) => {
    let k = (i + cfg.offset) % cfg.queries.length, done = 0, inPass = true;
    for (;;) {
      const start = performance.now();
      if (start >= windowEnd) return;
      const q = cfg.queries[k]!;
      k = (k + 1) % cfg.queries.length;
      const counted = start >= windowStart;
      if (inPass && ++done === cfg.queries.length) {
        inPass = false;
        // this statement ends the client's pass: once it ends, the last client's pass opens the window
        const after = (): void => { if (++passed === clients.length) open(); };
        try { await c.query(queryOf(q, cfg.rows)); } catch (e) {
          if ((e as pg.DatabaseError).code === undefined) { broken.push((e as Error).message); after(); return; }
        }
        after();
        continue;
      }
      try {
        await c.query(queryOf(q, cfg.rows));
        const end = performance.now();
        if (counted) { perQuery[q.name]!.latencies.push(end - start); if (end > lastEnd) lastEnd = end; }
      } catch (e) {
        const code = (e as pg.DatabaseError).code ?? (e as Error).message.slice(0, 80);
        const end = performance.now();
        if (counted) { const errs = perQuery[q.name]!.errors; errs[code] = (errs[code] ?? 0) + 1; if (end > lastEnd) lastEnd = end; }
        // no SQLSTATE: the connection broke, and stays broken — this client stops, said in the result (and its pass
        // counts as done, so the window still opens for the others)
        if ((e as pg.DatabaseError).code === undefined) { broken.push((e as Error).message); if (inPass && ++passed === clients.length) open(); return; }
      }
    }
  }));
  const cpu = process.cpuUsage(cpu0);
  loop.disable();
  const wall = performance.now() - t0;
  for (const c of clients) await c.end().catch((e: Error) => broken.push(`end: ${e.message}`));
  return { perQuery, windowMs: Math.max(lastEnd, windowStart + 1) - windowStart, warmupMs: windowStart - t0, loopDelayP99Ms: loop.percentile(99) / 1e6, cpuPct: ((cpu.user + cpu.system) / 1000) / wall * 100, brokenClients: broken };
}

/** a cell's clients in a child process: this script, `--client-worker`, its config on stdin and its result on stdout */
function runWorker(cfg: WorkerConfig): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, "--client-worker"], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { out += d; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) { reject(new Error(`the client process exited ${code}`)); return; }
      try { resolve(JSON.parse(out) as WorkerResult); } catch (e) { reject(new Error(`the client process's answer is not JSON (${(e as Error).message}): ${out.slice(0, 200)}`)); }
    });
    child.stdin.end(JSON.stringify(cfg));
  });
}

// --------------------------------------------------------------------------------------------- statistics

/** the nearest-rank percentile of sorted values */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]!;
}
export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const round = (x: number, d: number): number => Number.isFinite(x) ? Number(x.toFixed(d)) : x;

type Stats = RunStats & { codes: Record<string, number> };
/** one run's statistics: the mix (every statement) and each statement */
function statsOf(r: WorkerResult): Map<string, Stats> {
  const out = new Map<string, Stats>();
  const secs = Math.max(r.windowMs, 1) / 1000;
  const of = (lat: number[], codes: Record<string, number>): Stats => {
    const s = [...lat].sort((a, b) => a - b);
    return { p50Ms: round(percentile(s, 50), 2), p95Ms: round(percentile(s, 95), 2), qps: round(s.length / secs, 2), completed: s.length,
      errors: Object.values(codes).reduce((a, b) => a + b, 0), codes };
  };
  const all: number[] = [], codes: Record<string, number> = {};
  for (const [name, q] of Object.entries(r.perQuery)) {
    out.set(name, of(q.latencies, q.errors));
    all.push(...q.latencies);
    for (const [c, n] of Object.entries(q.errors)) codes[c] = (codes[c] ?? 0) + n;
  }
  out.set("mix", of(all, codes));
  return out;
}

/** runs that disagree by more than 30 % on the mix's qps or p95 */
const disagree = (runs: readonly RunStats[]): boolean => {
  if (runs.length < 2) return false;
  const spread = (xs: number[]): number => { const f = xs.filter((x) => Number.isFinite(x) && x > 0); return f.length < 2 ? 1 : Math.max(...f) / Math.min(...f); };
  return spread(runs.map((r) => r.qps)) > 1.3 || spread(runs.map((r) => r.p95Ms)) > 1.3;
};

// --------------------------------------------------------------------------------------------- Postgres

function docker(args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

/** The settings a read replica would have on this hardware, for a container given `memoryBytes`. */
export function replicaSettings(memoryBytes: number, cpus: number, maxClients = 0): Record<string, string> {
  const mb = (f: number): string => `${Math.floor(memoryBytes * f / 2 ** 20)}MB`;
  return {
    // past the clients sweep's last step, so it is Postgres's answers that are measured, never a refused connection
    max_connections: String(Math.max(300, maxClients + 50)),
    shared_buffers: mb(0.25),
    effective_cache_size: mb(0.75),
    work_mem: "32MB",
    maintenance_work_mem: mb(Math.min(0.125, 2 ** 31 / memoryBytes)),
    max_worker_processes: String(cpus + 8),
    max_parallel_workers: String(cpus),
    max_parallel_workers_per_gather: String(Math.max(2, Math.min(4, Math.floor(cpus / 2)))),
    random_page_cost: "1.1",
    effective_io_concurrency: "200",
    // the load's WAL is bounded so the disk the sweep predicts is the tables' (a replica's own WAL is not measured here)
    max_wal_size: "2GB",
  };
}

async function startContainer(memoryBytes: number, cpus: number, maxClients: number, log: (l: string) => void): Promise<{ url: string; id: string }> {
  const existing = docker(["ps", "-a", "--filter", `name=^/${CONTAINER}$`, "--format", "{{.ID}} {{.Status}}"]);
  if (existing !== "") throw new Error(`a container named ${CONTAINER} exists already (${existing}): a run in progress, or one left by --keep-postgres. ` +
    `Reuse it with --postgres <its url>, or remove it (docker rm -f ${CONTAINER}) if it is yours`);
  const port = await freePort();
  const password = randomBytes(18).toString("hex");
  const settings = replicaSettings(memoryBytes, cpus, maxClients);
  const id = docker(["run", "-d", "--name", CONTAINER, "-p", `127.0.0.1:${port}:5432`, "--memory", `${memoryBytes}b`, "--shm-size", "1g",
    "-e", `POSTGRES_PASSWORD=${password}`, IMAGE, ...Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${v}`])]);
  log(`started ${CONTAINER} (${IMAGE}, ${id.slice(0, 12)}) on 127.0.0.1:${port} with --memory ${(memoryBytes / 2 ** 30).toFixed(1)} GiB`);
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  await waitReady(url, log);
  return { url, id };
}

/** --reuse-postgres: the bench-pg container a --keep-postgres run left, adopted as this run's own (started if stopped);
 *  its URL from its own settings, its memory held to this run's */
async function adoptContainer(memoryBytes: number, log: (l: string) => void): Promise<{ url: string; id: string }> {
  const id = docker(["ps", "-a", "--filter", `name=^/${CONTAINER}$`, "--format", "{{.ID}}"]);
  if (id === "") throw new Usage(`--reuse-postgres: there is no container named ${CONTAINER} (a run with --keep-postgres leaves one)`);
  const info = (JSON.parse(docker(["inspect", id])) as Array<{ Config: { Env: string[]; Image: string }; HostConfig: { Memory: number; PortBindings: Record<string, Array<{ HostPort: string }>> }; State: { Running: boolean } }>)[0]!;
  const password = info.Config.Env.find((e) => e.startsWith("POSTGRES_PASSWORD="))?.slice("POSTGRES_PASSWORD=".length);
  const port = info.HostConfig.PortBindings["5432/tcp"]?.[0]?.HostPort;
  if (password === undefined || port === undefined) throw new Error(`${CONTAINER} (${id}) has no POSTGRES_PASSWORD or no published 5432: not a container this script made`);
  if (info.HostConfig.Memory !== memoryBytes) throw new Usage(`${CONTAINER} was given --memory ${info.HostConfig.Memory} bytes and this run's is ${memoryBytes}: pass the --memory the run that made it had`);
  if (!info.State.Running) docker(["start", id]);
  log(`adopted ${CONTAINER} (${info.Config.Image}, ${id}) on 127.0.0.1:${port}, --memory ${(memoryBytes / 2 ** 30).toFixed(1)} GiB (--reuse-postgres)`);
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  await waitReady(url, log);
  return { url, id };
}

/** until the Postgres at `url` answers (a container started, or started again), at most two minutes */
async function waitReady(url: string, log: (l: string) => void): Promise<void> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const c = new pg.Client({ connectionString: url });
    try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
    catch (e) {
      // the image's init runs a server on its socket alone, then the real one on TCP: refused until then
      await c.end().catch((x: Error) => log(`  (closing a refused probe: ${x.message})`));
      if (Date.now() > deadline) throw new Error(`${CONTAINER} did not accept connections in 120 s: ${(e as Error).message}; docker logs ${CONTAINER} says why`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const withDb = (url: string, db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };
const whereOf = (url: string): string => { const u = new URL(url); return `${u.hostname}:${u.port || "5432"}`; };

/** the database of one size: made by `dataSql`, or reused when its marker says it holds exactly this */
async function ensureData(adminUrl: string, rows: number, log: (l: string) => void): Promise<{ url: string; generatedSeconds: number | null }> {
  const db = `bench_replica_${rows}`;
  const url = withDb(adminUrl, db);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    if ((await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [db])).rowCount === 1) {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      const m = ((await c.query("SELECT obj_description(to_regclass('public.orders'), 'pg_class') AS m")).rows[0]?.m ?? null) as string | null;
      await c.end();
      if (m === marker(rows)) { log(`${db}: reused (${m})`); return { url, generatedSeconds: null }; }
      log(`${db}: holds ${JSON.stringify(m)}, not ${JSON.stringify(marker(rows))}: made again`);
      await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);
    }
    await admin.query(`CREATE DATABASE ${db}`);
  } finally { await admin.end(); }
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const t0 = performance.now();
  try {
    for (const sql of dataSql(rows)) {
      const s0 = performance.now();
      await c.query(sql);
      log(`  ${db}: ${sql.slice(0, 60).replace(/\s+/g, " ")}… ${((performance.now() - s0) / 1000).toFixed(1)} s`);
    }
  } finally { await c.end(); }
  return { url, generatedSeconds: round((performance.now() - t0) / 1000, 1) };
}

async function postgresFacts(url: string): Promise<{ version: string; settings: Record<string, string> }> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const version = String((await c.query("SELECT version() AS v")).rows[0].v);
    const names = ["max_connections", "shared_buffers", "effective_cache_size", "work_mem", "hash_mem_multiplier", "maintenance_work_mem", "max_worker_processes",
      "max_parallel_workers", "max_parallel_workers_per_gather", "random_page_cost", "effective_io_concurrency", "jit"];
    const rows = (await c.query("SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1) ORDER BY name", [names])).rows as Array<{ name: string; setting: string; unit: string | null }>;
    const pretty = (s: string, unit: string | null): string => {
      const m = unit === null ? null : /^(\d+)?(kB|MB)$/.exec(unit);
      if (m === null) return unit ? `${s}${unit}` : s;
      const bytes = Number(s) * Number(m[1] ?? 1) * (m[2] === "MB" ? 2 ** 20 : 1024);
      return bytes >= 2 ** 30 && bytes % 2 ** 30 === 0 ? `${bytes / 2 ** 30}GB` : `${Math.round(bytes / 2 ** 20)}MB`;
    };
    return { version, settings: Object.fromEntries(rows.map((r) => [r.name, pretty(r.setting, r.unit)])) };
  } finally { await c.end(); }
}

// --------------------------------------------------------------------------------------------- Mason

interface MasonServed {
  /** the listener's port while it is up (the same across a suspend and a resume) */
  readonly port: number;
  copySeconds: number; copyTables: Record<string, number | null>; fileBytes: () => number; jsonReady: () => Promise<number | null>;
  /** closes everything (the listener, the request log, the sync, the store), so DuckDB's memory is the system's again
   *  while Postgres is measured; the file stays */
  suspend: () => Promise<void>;
  /** opens the same file again, as `mason start` after a stop does (the source must be up): no copy, said if there was */
  resume: () => Promise<{ seconds: number; copied: boolean }>;
  /** --order: while suspended, the copy of public.orders rewritten in `order` with the store open by the bench alone */
  reorder: (order: string) => Promise<Reordered>;
  close: () => Promise<void>;
}

async function serveMason(sourceUrl: string, database: string, memoryLimit: string, workDir: string, timeoutMs: number, version: string, log: (l: string) => void): Promise<MasonServed> {
  const { DuckStore } = await import("../src/duck/store.ts");
  const { Sync } = await import("../src/duck/sync.ts");
  const { startPostgresApi } = await import("../src/api/postgres/server.ts");
  const { connectSource, parseSource, readSourceFacts } = await import("../src/cli/preflight.ts");
  const { RequestLedger } = await import("../src/duck/requests.ts");
  const { readLibcOrder } = await import("../src/duck/libc-order.ts");
  const { isLibcCollation } = await import("../src/duck/rewrite.ts");
  const { REVIEW_MS: KEEP_REVIEW_MS } = await import("../src/duck/kept.ts");
  const mlog: string[] = [];
  const say = (l: string): void => { mlog.push(l); if (/failed|error/i.test(l)) log(`  [mason] ${l}`); };
  const parsed = parseSource(sourceUrl);
  if ("problem" in parsed) throw new Error(parsed.problem);
  const file = path.join(workDir, "duck.db");
  type Up = { store: Awaited<ReturnType<typeof DuckStore.open>>; sync: InstanceType<typeof Sync>; requests: Awaited<ReturnType<typeof RequestLedger.open>>; server: { port: number; close(): Promise<void> } };
  let port = 0;
  /** the copy's wall time at the last start: setTables to every table served (each copy and its catch-up poll) */
  let syncSeconds = 0;
  /** the run, as mason start opens it: the copy (or the one in the file), the request log, the listener */
  const start = async (): Promise<Up> => {
    const conn = await connectSource(parsed.source);
    if ("failure" in conn) throw new Error(`Mason could not connect to the Postgres: ${conn.failure.message}`);
    const facts = await readSourceFacts(conn.pg);
    conn.pg.close();
    const added = facts.tables.filter((t) => t.schema === "public" && (t.table === "orders" || t.table === "customers"));
    if (added.length !== 2) throw new Error(`the database's tables: ${facts.tables.map((t) => t.source).join(", ")}; orders and customers were expected`);
    const store = await DuckStore.open(file, say, { memoryLimit });
    // poll mode with an hour's interval: the data does not change while it is measured, and a poll is a scan of the source
    const sync = new Sync(store, parsed.source, database, say, 3_600_000, "poll", null, {});
    await sync.open();
    const t = performance.now();
    await sync.setTables(added);
    await sync.once();
    syncSeconds = round((performance.now() - t) / 1000, 1);
    const bad = sync.state().filter((s) => s.phase !== "copied");
    if (bad.length) throw new Error(`Mason's copy: ${bad.map((s) => `${s.source} ${s.phase} ${s.error ?? ""}`).join("; ")}\n${mlog.slice(-20).join("\n")}`);
    // a libc collation's order, read from the database once and kept in the copy (src/duck/libc-order.ts)
    const coll = facts.collation;
    const libc = coll !== undefined && isLibcCollation(coll.provider, coll.collate) ? (await store.libcOrder(coll.collate, coll.version ?? null, async () => {
      const c = await connectSource(parsed.source);
      if ("failure" in c) throw new Error(`connect: ${c.failure.message}`);
      try { return await readLibcOrder(async (sql) => (await c.pg.query(sql)).rows, coll.collate, coll.version ?? null); } finally { c.pg.close(); }
    })).order : undefined;
    const requests = await RequestLedger.open(store, say, { days: 7 });
    const duck = await store.listener(facts.collation, undefined, libc, () => sync.state(), sync.kept.enabled ? sync.kept : undefined);
    const server = await startPostgresApi({
      port, host: "127.0.0.1", tls: null, database, masonVersion: version, product: "mason-data", statementTimeoutMs: timeoutMs,
      // the bench's own listener, on loopback, without a password: a login is not what is measured
      authenticate: () => ({}),
      schema: () => sync.schema(), record: (row) => requests.record(row), log: say, duck,
    });
    port = server.port;
    return { store, sync, requests, server };
  };
  const stop = async (u: Up): Promise<void> => { await u.server.close(); await u.requests.close(); await u.sync.stop(); await u.store.close(); };
  let up: Up | null = await start();
  const copySeconds = syncSeconds;
  const states = up.sync.state();
  // when each table was copied, as instants (the state says it in the ledger's text after a restart, ISO before)
  const copiedAt = (u: Up): string => u.sync.state().map((s) => `${s.source} ${s.copiedAt === null ? "never" : new Date(s.copiedAt).toISOString()}`).join(", ");
  const firstCopy = copiedAt(up);
  const size = (f: string): number => fs.existsSync(f) ? fs.statSync(f).size : 0;
  const served = (): Up => { if (up === null) throw new Error("Mason is suspended (a bench bug)"); return up; };
  return {
    get port() { return port; },
    copySeconds,
    copyTables: Object.fromEntries(states.map((s) => [s.source, s.seconds])),
    fileBytes: () => size(file) + size(`${file}.wal`),
    /** the JSON path read as a dashboard reads it (three statements), then until the keeper has it stored and ready —
     *  read again while the keeper leaves it `waiting` a review after the last read: a larger table's fill is weighed
     *  against the reads' time (src/duck/kept.ts KEEP_FILL_SHARE: at 30 M rows three reads are 14 s against a 6.6-minute
     *  fill), and a dashboard goes on reading it, so the path is stored before the cells, never by a fill beside them */
    jsonReady: async () => {
      const u = served();
      const c = new pg.Client({ host: "127.0.0.1", port, database, user: "bench", password: "bench" });
      await c.connect();
      const sql = QUERIES.find((q) => q.name === "json_source")!.sql;
      const keptPath = (): { state: string } | undefined => u.sync.kept.status().find((p) => p.table === "public.orders" && p.column === "payload");
      const t = performance.now();
      let reads = 0;
      try {
        for (; reads < 3; reads++) await c.query(sql);
        const deadline = Date.now() + 15 * 60_000;
        let lastRead = Date.now();
        while (Date.now() < deadline) {
          const p = keptPath();
          if (p?.state === "ready") {
            if (reads > 3) log(`  (the path was read ${reads} times before the keeper stored it: its fill is weighed against the reads' time)`);
            return round((performance.now() - t) / 1000, 1);
          }
          if ((p === undefined || p.state === "waiting") && Date.now() - lastRead > KEEP_REVIEW_MS + 5_000) { await c.query(sql); reads++; lastRead = Date.now(); }
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally { await c.end(); }
      log(`  the stored JSON path was not ready in 15 minutes (${reads} reads): ${JSON.stringify(u.sync.kept.status())}`);
      return null;
    },
    suspend: async () => { if (up !== null) { const u = up; up = null; await stop(u); } },
    resume: async () => {
      if (up !== null) return { seconds: 0, copied: false };
      const t = performance.now();
      up = await start();
      const copied = copiedAt(up) !== firstCopy;
      if (copied) log(`  Mason copied again at its restart (${copiedAt(up)}; was ${firstCopy}): a restart should resume the copy in the file`);
      if (!up.sync.kept.status().some((p) => p.column === "payload" && p.state === "ready")) log(`  the stored JSON path is not ready after the restart: ${JSON.stringify(up.sync.kept.status())}`);
      return { seconds: round((performance.now() - t) / 1000, 1), copied };
    },
    reorder: async (order) => {
      if (up !== null) throw new Error("the copy is rewritten with Mason suspended (a bench bug)");
      // the store alone: no sync (no poll, no copy, no JSON path's fill), no request log, no listener beside the rewrite
      const store = await DuckStore.open(file, say, { memoryLimit });
      try {
        const w = store.writer;
        const one = async (sql: string): Promise<unknown[]> => (await w.runAndReadAll(sql)).getRowsJS()[0]!;
        const facts = async (): Promise<{ columns: string; rows: number; rowGroups: number; used: number; keys: number }> => ({
          columns: JSON.stringify((await w.runAndReadAll("SELECT column_name, data_type FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = 'public' AND table_name = 'orders' ORDER BY column_index")).getRowsJS()),
          rows: Number((await one("SELECT count(*) FROM public.orders"))[0]),
          rowGroups: Number((await one("SELECT count(DISTINCT row_group_id) FROM pragma_storage_info('public.orders')"))[0]),
          used: Number((await one("SELECT used_blocks * block_size FROM pragma_database_size() WHERE database_name = current_database()"))[0]),
          keys: Number((await one("SELECT count(*) FROM duckdb_constraints() WHERE database_name = current_database() AND schema_name = 'public' AND table_name = 'orders' AND constraint_type IN ('PRIMARY KEY', 'UNIQUE')"))[0]),
        });
        const before = await facts();
        const t = performance.now();
        let open = false;
        try {
          for (const sql of reorderSql("public", "orders", order)) {
            await w.run(sql);
            if (sql === "BEGIN TRANSACTION") open = true; else if (sql === "COMMIT") open = false;
          }
        } catch (e) { if (open) await w.run("ROLLBACK"); throw e; }
        const seconds = round((performance.now() - t) / 1000, 1);
        const after = await facts();
        // only the order may change: the same columns and types, the same rows, still no key (src/duck/sync.ts findRetired)
        if (after.columns !== before.columns || after.rows !== before.rows || after.keys !== 0) {
          throw new Error(`the rewrite changed more than the order: columns ${before.columns} → ${after.columns}; rows ${before.rows} → ${after.rows}; keys ${after.keys}`);
        }
        log(`  rewrote public.orders ORDER BY ${order} in ${seconds} s: ${before.rowGroups} → ${after.rowGroups} row groups, ` +
          `${(before.used / 2 ** 20).toFixed(0)} → ${(after.used / 2 ** 20).toFixed(0)} MiB of the file in use`);
        return { table: "public.orders", order, seconds, rows: after.rows, rowGroupsBefore: before.rowGroups, rowGroupsAfter: after.rowGroups,
          usedBytesBefore: before.used, usedBytesAfter: after.used, fileBytesAfter: size(file) + size(`${file}.wal`) };
      } finally { await store.close(); }
    },
    close: async () => { if (up !== null) { const u = up; up = null; await stop(u); } },
  };
}

// --------------------------------------------------------------------------------------------- the answers

/** every statement's answer, as text: names, type OIDs and rows (the point lookup at one fixed id) */
async function answers(conn: pg.ClientConfig, rows: number): Promise<Map<string, string>> {
  const c = new pg.Client(conn);
  await c.connect();
  try {
    await c.query("SET TimeZone = 'UTC'");
    const out = new Map<string, string>();
    for (const q of QUERIES) {
      try {
        const r = await c.query(queryOf(q, rows, Math.ceil(rows / 3)));
        out.set(q.name, JSON.stringify({ names: r.fields.map((f) => f.name), oids: r.fields.map((f) => f.dataTypeID), rows: r.rows }));
      } catch (e) { out.set(q.name, `error ${(e as pg.DatabaseError).code ?? ""} ${(e as Error).message}`); }
    }
    return out;
  } finally { await c.end(); }
}

/** --keep-copy: the DuckDB SQL Mason plans for each statement (`EXPLAIN (FORMAT JSON)` over its listener, the point
 *  lookup at the answers' id), written beside the copy so the statements can be timed over the file alone */
async function plannedSql(conn: pg.ClientConfig, rows: number, file: string, log: (l: string) => void): Promise<void> {
  const c = new pg.Client(conn);
  await c.connect();
  try {
    await c.query("SET TimeZone = 'UTC'");
    const out: Array<{ name: string; sql: string; params: string[]; duckdb: string; functions: unknown }> = [];
    for (const q of QUERIES) {
      const params = q.params === "id" ? [String(Math.ceil(rows / 3))] : [];
      const r = await c.query({ text: `EXPLAIN (FORMAT JSON) ${q.sql}`, values: params, rowMode: "array", types: raw } as pg.QueryConfig);
      const json = JSON.parse(String((r.rows[0] as unknown[])[0])) as unknown;
      const top = (Array.isArray(json) ? json[0] : json) as { Mason?: { "Sent To Copy"?: string; "Mason Functions Copy Calls"?: unknown } };
      const duckdb = top.Mason?.["Sent To Copy"];
      if (typeof duckdb !== "string") throw new Error(`Mason's EXPLAIN of ${q.name} says no DuckDB SQL: ${JSON.stringify(json).slice(0, 300)}`);
      out.push({ name: q.name, sql: q.sql, params, duckdb, functions: top.Mason?.["Mason Functions Copy Calls"] ?? [] });
    }
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    log(`  wrote the statements' DuckDB SQL, as Mason plans them, to ${file}`);
  } finally { await c.end(); }
}

// --------------------------------------------------------------------------------------------- the run

const fmtRows = (n: number): string => n >= 1e6 && n % 1e6 === 0 ? `${n / 1e6}M` : n >= 1e3 && n % 1e3 === 0 ? `${n / 1e3}k` : String(n);
const ms = (x: number): string => !Number.isFinite(x) ? "-" : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : x >= 10 ? `${x.toFixed(0)} ms` : `${x.toFixed(1)} ms`;
const secs = (x: number): string => x >= 120 ? `${(x / 60).toFixed(0)} min` : `${x.toFixed(0)} s`;

function writeFixture(file: string, f: Fixture): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(f, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Mason's commit, `+dirty` when src/ differs from it */
function commit(): string {
  const r = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO, encoding: "utf8" });
  if (r.status !== 0) return "unknown (not a git checkout)";
  const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no", "--", "src"], { cwd: REPO, encoding: "utf8" }).stdout.trim() !== "";
  return `${r.stdout.trim()}${dirty ? "+dirty" : ""}`;
}

/** one size, served by both: its database and Mason's copy of it */
interface SizeCtx { rows: number; pgConn: pg.ClientConfig; masonConn: pg.ClientConfig; mason: MasonServed; workDir: string }
type Engine = "postgres" | "mason";

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  const log = (l: string): void => { process.stdout.write(`${l}\n`); };
  const { DEFAULT_MEMORY_LIMIT, DUCKDB_VERSION, machineMemoryBytes, memoryLimitBytes } = await import("../src/duck/store.ts");
  const { COPY_PARALLEL } = await import("../src/duck/sync.ts");
  const memoryLimit = (o.memory ?? (process.env.MASON_DUCKDB_MEMORY || DEFAULT_MEMORY_LIMIT)).trim();
  const memoryBytes = memoryLimitBytes(memoryLimit);
  const cpus = os.cpus().length;
  const version = commit();
  const timeoutSeconds = timeoutOf(o);
  const target = o.targetSeconds;
  if (process.env.MASON_COPY_PARALLEL) log(`(MASON_COPY_PARALLEL is set but not read here: the copy reads ${COPY_PARALLEL} chunks at once, as a run without it does)`);

  let container: { url: string; id: string } | null = null;
  const removeContainer = (): void => {
    if (container === null || o.keepPostgres) return;
    const r = spawnSync("docker", ["rm", "-f", container.id], { encoding: "utf8" });
    if (r.status === 0) log(`removed ${CONTAINER} (${container.id.slice(0, 12)})`);
    else log(`could not remove ${CONTAINER} (${container.id.slice(0, 12)}): ${r.stderr.trim()} — docker rm -f ${container.id.slice(0, 12)}`);
    container = null;
  };
  process.on("SIGINT", () => { log("interrupted: the fixture holds the cells completed"); removeContainer(); process.exit(130); });
  process.on("SIGTERM", () => { removeContainer(); process.exit(143); });

  try {
    let adminUrl = o.postgres;
    if (adminUrl === null) { container = o.reusePostgres ? await adoptContainer(memoryBytes, log) : await startContainer(memoryBytes, cpus, target === null ? 0 : o.maxClients, log); adminUrl = container.url; }
    const admin: string = adminUrl;
    const pgFacts = await postgresFacts(admin);
    if (target !== null) {
      const c = new pg.Client({ connectionString: admin });
      await c.connect();
      const max = Number((await c.query("SELECT current_setting('max_connections') AS m")).rows[0].m);
      await c.end();
      if (max <= o.maxClients + 10) throw new Error(`the Postgres allows ${max} connections, and the clients sweep goes to --max-clients ${o.maxClients}: ` +
        `raise its max_connections past ${o.maxClients + 10}, or lower --max-clients`);
    }
    const fixture: Fixture = {
      environment: {
        label: o.label, date: new Date().toISOString(),
        machine: { cpus, cpuModel: os.cpus()[0]?.model.trim() ?? "unknown", ramBytes: os.totalmem(), memoryBytes: machineMemoryBytes(), os: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version },
        postgres: { version: pgFacts.version, where: container !== null ? `Docker (${IMAGE}) on the same machine` : `${whereOf(admin)} (--postgres)`,
          containerMemoryBytes: container !== null ? memoryBytes : null, settings: pgFacts.settings },
        mason: { commit: version, duckdb: DUCKDB_VERSION, memoryLimit, memoryLimitBytes: memoryBytes, copyParallel: COPY_PARALLEL, storeJsonPaths: true, ...(o.order === null ? {} : { order: o.order }) },
        method: { sizes: o.sizes, clients: o.clients, seconds: o.seconds, warmupSeconds: o.warmup, runs: o.runs, statementTimeoutSeconds: timeoutSeconds,
          clientProcess: "one Node process apart from Mason's, N node-postgres clients on its event loop",
          targetPostgresSeconds: target, maxClients: target === null ? null : o.maxClients, sweepClients: target === null ? null : o.sweepClients,
          isolation: o.masonOnly ? (container !== null ? "Mason alone (--mason-only): Postgres's container stopped while Mason ran, Mason open from its first cell to its last"
            : "Mason alone (--mason-only); the --postgres server stayed up while Mason ran (not this script's to stop)")
            : container !== null ? "each engine measured with the other stopped: Mason closed while Postgres ran, Postgres's container stopped while Mason ran"
            : "Mason closed while Postgres ran; the --postgres server stayed up while Mason ran (not this script's to stop)",
          ...(o.masonOnly ? { masonOnly: true } : {}) },
      },
      queries: QUERIES.map((q) => ({ name: q.name, title: q.title, sql: q.sql })),
      sizes: [], skipped: [], cells: [], complete: false,
      ...(target === null ? {} : { sweeps: { rows: null, clients: null } }),
    };
    if (o.order !== null) log(`  the copy of public.orders is rewritten ORDER BY ${o.order} before it is measured (--order)`);
    log(`bench-replica: ${o.label}; ${cpus} CPUs, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB; ${pgFacts.version.split(" on ")[0]}; Mason ${version}, DuckDB ${DUCKDB_VERSION} at ${memoryLimit}`);
    log(`  Postgres settings: ${Object.entries(pgFacts.settings).map(([k, v]) => `${k}=${v}`).join(" ")}`);
    log(target === null ? `  the grid: sizes ${o.sizes.map(fmtRows).join(", ")} × clients ${o.clients.join(", ")}`
      : `  the sweep to ${target} s: rows at ${o.sweepClients} client(s) from ${fmtRows(o.sizes[0]!)}, then clients ${clientSteps(o.clients, o.maxClients).join(", ")}; a statement's limit ${timeoutSeconds} s`);
    log(`  ${fixture.environment.method.isolation}`);
    fs.mkdirSync(o.work, { recursive: true });
    const save = (why: string): void => { writeFixture(o.out, fixture); log(`  wrote ${path.relative(process.cwd(), o.out)} (${why})`); };
    // THE OTHER ENGINE STOPPED: the container is stopped while Mason is measured (an idle Postgres keeps its shared_buffers
    // resident), and started again for the copy, the answers and its own runs; a --postgres server is left as it is
    let pgRunning = true;
    const pgUp = async (): Promise<void> => {
      if (pgRunning || container === null) return;
      docker(["start", container.id]);
      await waitReady(admin, log);
      pgRunning = true;
    };
    const pgDown = (): void => {
      if (!pgRunning || container === null) return;
      docker(["stop", container.id]);
      pgRunning = false;
    };
    /** the bytes a row took the last size measured, both engines (Postgres's tables and indexes, Mason's file): what
     *  the next size is predicted from — the constant only before any size was measured */
    const bytesPerRow = (): { bytes: number; from: string } => {
      const last = fixture.sizes[fixture.sizes.length - 1];
      return last === undefined ? { bytes: BYTES_PER_ROW, from: `${BYTES_PER_ROW} bytes a row (no size measured yet)` }
        : { bytes: (last.postgresBytes + last.masonFileBytes) / last.rows, from: `${((last.postgresBytes + last.masonFileBytes) / last.rows).toFixed(0)} bytes a row, as ${fmtRows(last.rows)} measured` };
    };

    // ---- one size: its data, Mason's copy, the answers compared ------------------------------------------------------
    /** the size served, or why it was skipped (the disk) */
    const openSize = async (rows: number): Promise<SizeCtx | { skipped: string }> => {
      await pgUp();
      const st = fs.statfsSync(o.work);
      // a quarter more for what a load writes beside its tables (the copy's temporary file, the bounded WAL), and 2 GiB
      const per = bytesPerRow(), free = st.bavail * st.bsize, need = rows * per.bytes * 1.25 + 2 * 2 ** 30;
      if (free - need < o.reserveGb * 2 ** 30) {
        const why = `${(need / 2 ** 30).toFixed(1)} GiB predicted (${per.from}, + 25 % + 2 GiB), ${(free / 2 ** 30).toFixed(1)} GiB free where Mason's copy is: less than --reserve-gb ${o.reserveGb} would be left`;
        log(`size ${fmtRows(rows)}: SKIPPED — ${why}`);
        if (!fixture.skipped.some((k) => k.rows === rows)) fixture.skipped.push({ rows, why });
        return { skipped: why };
      }
      log(`\n== ${rows.toLocaleString("en-US")} orders ==`);
      const data = await ensureData(admin, rows, log);
      const db = new URL(data.url).pathname.slice(1);
      const pgc = new pg.Client({ connectionString: data.url });
      await pgc.connect();
      const postgresBytes = Number((await pgc.query("SELECT pg_total_relation_size('public.orders') + pg_total_relation_size('public.customers') AS b")).rows[0].b);
      await pgc.end();
      const workDir = fs.mkdtempSync(path.join(o.work, "bench-replica-"));
      log(`Mason: copying ${db} (DuckDB at ${memoryLimit})…`);
      let mason: MasonServed;
      try { mason = await serveMason(data.url, db, memoryLimit, workDir, timeoutSeconds * 1000, version, log); }
      catch (e) { fs.rmSync(workDir, { recursive: true, force: true }); throw e; }
      log(`  served in ${mason.copySeconds} s (${Object.entries(mason.copyTables).map(([t, s]) => `${t} ${s} s`).join(", ")}); file ${(mason.fileBytes() / 2 ** 20).toFixed(0)} MiB`);
      const jsonReady = await mason.jsonReady();
      log(`  the stored JSON path payload ->> 'source': ${jsonReady === null ? "NOT ready" : `ready ${jsonReady} s after its first reads`}`);
      // --order: the copy rewritten before anything is compared or measured, Mason closed meanwhile and opened again as
      // `mason start` after a stop opens it (no copy: said if there was)
      let reorder: Reordered | undefined;
      if (o.order !== null) {
        await mason.suspend();
        reorder = await mason.reorder(o.order);
        const r = await mason.resume();
        log(`  Mason opened again in ${r.seconds} s${r.copied ? " — and COPIED AGAIN: the rewrite was undone" : ""}`);
        if (r.copied) throw new Error("Mason copied the table again after its rewrite: the layout measured would not be the one asked for");
      }
      const pgConn: pg.ClientConfig = { connectionString: data.url };
      const masonConn: pg.ClientConfig = { host: "127.0.0.1", port: mason.port, database: db, user: "bench", password: "bench" };
      const a = await answers(pgConn, rows), b = await answers(masonConn, rows);
      const differences = QUERIES.filter((q) => a.get(q.name) !== b.get(q.name)).map((q) => `${q.name}: Postgres ${a.get(q.name)!.slice(0, 300)} — Mason ${b.get(q.name)!.slice(0, 300)}`);
      log(differences.length === 0 ? "  every statement's answer is the same on both" : `  ANSWERS DIFFER (a Mason defect; measured anyway):\n    ${differences.join("\n    ")}`);
      if (o.keepCopy) await plannedSql(masonConn, rows, path.join(workDir, "statements.json"), log);
      // a size served again (the clients sweep's) keeps its first record
      if (!fixture.sizes.some((x) => x.rows === rows)) {
        fixture.sizes.push({ rows, customers: customersOf(rows), generatedSeconds: data.generatedSeconds, postgresBytes, copySeconds: mason.copySeconds, copyTables: mason.copyTables,
          masonFileBytes: mason.fileBytes(), jsonPathReadySeconds: jsonReady, answersEqual: differences.length === 0, differences, ...(reorder === undefined ? {} : { reorder }) });
      }
      return { rows, pgConn, masonConn, mason, workDir };
    };
    const closeSize = async (ctx: SizeCtx): Promise<void> => {
      await ctx.mason.close();
      if (o.keepCopy) log(`  kept Mason's copy (--keep-copy): ${path.join(ctx.workDir, "duck.db")}, its statements' DuckDB SQL in ${path.join(ctx.workDir, "statements.json")}`);
      else fs.rmSync(ctx.workDir, { recursive: true, force: true });
      await pgUp();
    };

    // ---- one cell: both engines, --runs times, the median kept -------------------------------------------------------
    /** the cell's window: 3 × the target after a cell whose Postgres p95 was over a tenth of it */
    const windowFor = (prevPgP95Ms: number | null): number =>
      target !== null && prevPgP95Ms !== null && prevPgP95Ms > target * 100 ? Math.max(o.seconds, 3 * target) : o.seconds;
    const mixOf = (rows: number, clients: number, engine: Engine): Cell | undefined =>
      fixture.cells.find((c) => c.rows === rows && c.clients === clients && c.engine === engine && c.query === "mix");
    const measureCell = async (ctx: SizeCtx, clients: number, prevPgP95Ms: number | null): Promise<{ pg: Cell; mason: Cell }> => {
      const rows = ctx.rows, seconds = windowFor(prevPgP95Ms);
      const pass = (prevPgP95Ms ?? 0) / 1000 * QUERIES.length;
      const each = Math.max(o.warmup, pass) + seconds + (prevPgP95Ms ?? 0) / 1000;
      log(`[${fmtRows(rows)} · ${clients} client(s)] about ${secs(2 * o.runs * each)} for this cell: 2 engines × ${o.runs} run(s) × (a warm-up of ≥ ${o.warmup} s and one pass of the mix, ` +
        `a ${seconds} s window, the drain)${seconds > o.seconds ? ` — the window is 3 × the target: Postgres's last cell took ${ms(prevPgP95Ms!)}` : ""}`);
      const runs: Record<Engine, Array<Map<string, Stats>>> = { postgres: [], mason: [] };
      const runOne = async (engine: Engine, n: number): Promise<void> => {
        if (engine === "postgres") { await ctx.mason.suspend(); await pgUp(); }
        else {
          await pgUp();
          const r = await ctx.mason.resume();
          if (r.seconds > 0) log(`  Mason opened again in ${r.seconds} s${r.copied ? " — and COPIED AGAIN" : ""}`);
          pgDown();
        }
        const loadAvg = os.loadavg().map((x) => round(x, 2));
        const r = await runWorker({ conn: engine === "postgres" ? ctx.pgConn : ctx.masonConn, clients, warmupMs: o.warmup * 1000, seconds,
          timeoutMs: timeoutSeconds * 1000, rows, queries: QUERIES, offset: n });
        const s = statsOf(r);
        const mix = s.get("mix")!;
        Object.assign(mix, { loadAvg, clientLoopDelayP99Ms: round(r.loopDelayP99Ms, 1), clientCpuPct: round(r.cpuPct, 0) });
        runs[engine].push(s);
        log(`[${fmtRows(rows)} · ${clients} client(s) · ${engine.padEnd(8)} · run ${n + 1}] load ${loadAvg.join(" ")}; warm-up ${ms(r.warmupMs)} → ${mix.completed} statements, ` +
          `p50 ${ms(mix.p50Ms)}, p95 ${ms(mix.p95Ms)}, ${mix.qps} q/s${mix.errors ? `, ${mix.errors} FAILED ${JSON.stringify(mix.codes)}` : ""}; ` +
          `the clients' loop p99 ${ms(r.loopDelayP99Ms)}, CPU ${round(r.cpuPct, 0)} %` + (r.brokenClients.length ? `; ${r.brokenClients.length} client(s) broke: ${r.brokenClients[0]}` : ""));
      };
      // the engines alternate which goes first, so a drift in the machine's load falls on both (--mason-only: Mason alone)
      const engines: Engine[] = o.masonOnly ? ["mason"] : ["postgres", "mason"];
      for (let n = 0; n < o.runs; n++) for (const e of (n % 2 === 0 ? engines : [...engines].reverse())) await runOne(e, n);
      for (const e of engines) {
        while (disagree(runs[e].map((m) => m.get("mix")!)) && runs[e].length < o.runs + 2) {
          log(`  ${e}'s runs disagree by more than 30 %: another`);
          await runOne(e, runs[e].length);
        }
        const cells = ["mix", ...QUERIES.map((x) => x.name)].map((q): Cell => {
          const rs = runs[e].map((m) => m.get(q)!);
          const codes: Record<string, number> = {};
          for (const r of rs) for (const [c, n] of Object.entries(r.codes)) codes[c] = (codes[c] ?? 0) + n;
          return { rows, clients, engine: e, query: q, seconds,
            p50Ms: round(median(rs.map((r) => r.p50Ms)), 2), p95Ms: round(median(rs.map((r) => r.p95Ms)), 2), qps: round(median(rs.map((r) => r.qps)), 2),
            completed: rs.reduce((x, r) => x + r.completed, 0), errors: rs.reduce((x, r) => x + r.errors, 0), errorCodes: codes,
            runs: rs.map(({ codes: _codes, ...r }) => r) };
        });
        const slowest = cells.slice(1).filter((c) => Number.isFinite(c.p50Ms)).sort((a, b) => b.p50Ms - a.p50Ms)[0];
        if (slowest !== undefined) cells[0]!.slowest = { query: slowest.query, p50Ms: slowest.p50Ms };
        fixture.cells.push(...cells);
      }
      // (--mason-only has no Postgres cell, and measures a grid, which reads neither)
      return { pg: mixOf(rows, clients, "postgres")!, mason: mixOf(rows, clients, "mason")! };
    };
    const verdictAt = (rows: number, clients: number): SweepVerdict["at"] => {
      const p = mixOf(rows, clients, "postgres"), m = mixOf(rows, clients, "mason");
      return p === undefined || m === undefined ? null
        : { rows, clients, postgresP95Ms: p.p95Ms, postgresQps: p.qps, slowest: p.slowest ?? { query: "mix", p50Ms: p.p50Ms }, masonP95Ms: m.p95Ms, masonQps: m.qps };
    };
    const atText = (v: SweepVerdict): string => v.at === null ? "nothing measured" :
      `Postgres p95 ${ms(v.at.postgresP95Ms)} (slowest ${v.at.slowest.query}, p50 ${ms(v.at.slowest.p50Ms)}), ${v.at.postgresQps} q/s; Mason p95 ${ms(v.at.masonP95Ms)}, ${v.at.masonQps} q/s`;

    if (target === null) {
      // ---- THE GRID: every size × every client count ----------------------------------------------------------------
      for (const rows of o.sizes) {
        const ctx = await openSize(rows);
        if ("skipped" in ctx) { save(`${fmtRows(rows)} skipped`); continue; }
        try { for (const clients of o.clients) await measureCell(ctx, clients, null); }
        finally { await closeSize(ctx); }
        save(`${fmtRows(rows)} done`);
      }
    } else {
      const sweeps = fixture.sweeps!;
      // ---- (a) ROWS, at a dashboard's concurrency, about √10 a step until Postgres's p95 reaches the target -----------
      const c0 = o.sweepClients;
      const rowsSweep: SweepVerdict = { axis: "rows", rows: null, clients: c0, steps: [], reached: null, stopped: null, at: null };
      sweeps.rows = rowsSweep;
      let rows = o.sizes[0]!, prev: number | null = null, underTarget: number | null = null, lastRows: number | null = null;
      for (;;) {
        if (rows > o.maxRows) { rowsSweep.stopped = `--max-rows ${fmtRows(o.maxRows)} stopped the sweep before ${rows.toLocaleString("en-US")} rows`; break; }
        const ctx = await openSize(rows);
        if ("skipped" in ctx) {
          rowsSweep.stopped = `the disk stopped the sweep at ${rows.toLocaleString("en-US")} rows` + (prev === null ? "" : `, with Postgres at ${ms(prev)} at ${lastRows!.toLocaleString("en-US")}`);
          break;
        }
        let cell: { pg: Cell; mason: Cell };
        try { cell = await measureCell(ctx, c0, prev); } finally { await closeSize(ctx); }
        rowsSweep.steps.push(rows);
        rowsSweep.at = verdictAt(rows, c0);
        lastRows = rows;
        if (cell.pg.p95Ms >= target * 1000) { rowsSweep.reached = { rows, clients: c0 }; save(`rows sweep: reached at ${fmtRows(rows)}`); break; }
        save(`rows sweep: ${fmtRows(rows)} under ${target} s`);
        // the size before the last one under the target is no longer needed: its database is dropped (its disk is the next size's)
        if (container !== null && underTarget !== null) await dropData(admin, underTarget, log);
        underTarget = rows; prev = cell.pg.p95Ms;
        rows = nextSize(rows);
      }
      log(`ROWS SWEEP: ${rowsSweep.reached !== null ? `Postgres reached ${target} s at ${rowsSweep.reached.rows.toLocaleString("en-US")} rows` : rowsSweep.stopped} — ${atText(rowsSweep)}`);

      // ---- (b) CLIENTS, at the largest size under the target, doubling until Postgres's p95 reaches it -----------------
      const measured = rowsSweep.steps;
      const at = o.clientsRows ?? underTarget ?? measured[0] ?? o.sizes[0]!;
      const rowsWhy = o.clientsRows !== null ? "chosen by --clients-rows" : underTarget !== null ? `the largest size the rows sweep measured under ${target} s`
        : measured.length ? `the rows sweep's first size, already over ${target} s` : "the first --sizes (the rows sweep measured nothing)";
      const clientsSweep: SweepVerdict = { axis: "clients", rows: at, clients: null, rowsWhy, steps: [], reached: null, stopped: null, at: null };
      sweeps.clients = clientsSweep;
      const ctx = await openSize(at);
      if ("skipped" in ctx) clientsSweep.stopped = `the disk could not hold ${at.toLocaleString("en-US")} rows`;
      else {
        try {
          let prevC: number | null = null;
          const steps = clientSteps(o.clients, o.maxClients);
          for (const clients of steps) {
            // a cell the rows sweep measured already is read, not measured again
            const before = mixOf(at, clients, "postgres");
            const cell: { pg: Cell } = before !== undefined ? { pg: before } : await measureCell(ctx, clients, prevC);
            clientsSweep.steps.push(clients);
            clientsSweep.at = verdictAt(at, clients);
            if (cell.pg.p95Ms >= target * 1000) { clientsSweep.reached = { rows: at, clients }; break; }
            prevC = cell.pg.p95Ms;
            save(`clients sweep: ${clients} under ${target} s`);
          }
          if (clientsSweep.reached === null) clientsSweep.stopped = `--max-clients ${o.maxClients} stopped the sweep` + (prevC === null ? "" : `, with Postgres at ${ms(prevC)}`);
        } finally { await closeSize(ctx); }
      }
      log(`CLIENTS SWEEP at ${at.toLocaleString("en-US")} rows (${rowsWhy}): ${clientsSweep.reached !== null ? `Postgres reached ${target} s with ${clientsSweep.reached.clients} clients` : clientsSweep.stopped} — ${atText(clientsSweep)}`);
    }
    fixture.complete = true;
    save("complete");
    printTable(fixture, log);
    if (o.postgres !== null) log(`the databases bench_replica_<rows> are left on ${whereOf(o.postgres)} for the next run (DROP DATABASE … WITH (FORCE) removes them)`);
    return 0;
  } finally { removeContainer(); }
}

/** a size's database, dropped (the container's own, during the rows sweep: its disk is the next size's) */
async function dropData(adminUrl: string, rows: number, log: (l: string) => void): Promise<void> {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try { await c.query(`DROP DATABASE IF EXISTS bench_replica_${rows} WITH (FORCE)`); log(`  dropped bench_replica_${rows} (no longer needed: its disk is the next size's)`); }
  finally { await c.end(); }
}

function printTable(f: Fixture, log: (l: string) => void): void {
  log(`\n${"rows".padStart(6)} ${"clients".padStart(7)}  ${"query".padEnd(14)} ${"PG p50".padStart(9)} ${"PG p95".padStart(9)} ${"PG q/s".padStart(9)}  ${"Mason p50".padStart(9)} ${"Mason p95".padStart(9)} ${"Mason q/s".padStart(9)}`);
  for (const m of f.cells.filter((c) => c.engine === "mason")) {
    // --mason-only: no Postgres cell, its columns "-"
    const p = f.cells.find((c) => c.engine === "postgres" && c.rows === m.rows && c.clients === m.clients && c.query === m.query)
      ?? { ...m, p50Ms: NaN, p95Ms: NaN, qps: NaN };
    log(`${fmtRows(p.rows).padStart(6)} ${String(p.clients).padStart(7)}  ${p.query.padEnd(14)} ${ms(p.p50Ms).padStart(9)} ${ms(p.p95Ms).padStart(9)} ${String(p.qps).padStart(9)}  ${ms(m.p50Ms).padStart(9)} ${ms(m.p95Ms).padStart(9)} ${String(m.qps).padStart(9)}`);
  }
  for (const s of f.sizes) log(`copy of ${fmtRows(s.rows)}: ${s.copySeconds} s; answers ${s.answersEqual ? "equal" : "DIFFER"}`);
  for (const s of f.skipped) log(`skipped ${fmtRows(s.rows)}: ${s.why}`);
}

if (process.argv[2] === "--client-worker") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d: string) => { input += d; });
  process.stdin.on("end", () => {
    clientWorker(JSON.parse(input) as WorkerConfig).then((r) => { process.stdout.write(JSON.stringify(r)); },
      (e: unknown) => { process.stderr.write(`bench-replica client process: ${(e as Error).stack ?? String(e)}\n`); process.exitCode = 1; });
  });
} else if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT) {
  main().then((code) => { process.exitCode = code; }, (e: unknown) => {
    process.stderr.write(`bench-replica: ${e instanceof Usage ? e.message : (e as Error).stack ?? String(e)}\n`);
    process.exitCode = e instanceof Usage ? 2 : 1;
  });
}
