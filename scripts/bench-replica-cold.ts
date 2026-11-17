/**
 * THE COLD MODE OF THE BENCHMARK (docs/BENCHMARK.md "The cold mode"): how long one statement takes on each engine the
 * first time, with one client and with ten.
 *
 *   node scripts/bench-replica.ts --cold --label "<the machine>"                    # 1M, 10M and 100M rows: 18 cells
 *   node scripts/bench-replica.ts --cold --sizes 1M --runs 1 --settle 1             # a smoke
 *     --sizes 1M,10M,100M   --clients 1,10   --runs 3 (each cell; every run is kept)
 *     --cpus 4   --memory 8g  # each engine's container: --cpus, and --memory and --memory-swap (the page cache counts)
 *     --mason-version 0.23.0  # the image ghcr.io/embeddable-hq/mason-data:<version> (default cli/package.json's)
 *     --mason-image <ref>     # another image instead (a local build: mason-data:dev)
 *     --postgres-image postgres:18   # the bench's Postgres, and the pgbench and psql the clients run
 *     --settle 10             # seconds after an engine answers before the page cache is dropped
 *     --reserve-gb 10         # a size whose data would leave less free disk where Docker keeps its volumes is refused
 *     --label "<where>"   --out tests/fixtures/bench-replica-cold.json   --keep (leave the containers and volumes)
 *
 * THE STATEMENTS, sent as written to both engines (`COLD_STATEMENTS`): a count over every row, a sum by month over a
 * join, and one row by its primary key. The session's TimeZone is UTC on both (PGOPTIONS), since date_trunc of a
 * timestamptz depends on it.
 *
 * EACH ENGINE IN A CONTAINER OF ITS OWN, with the same --cpus, --memory and --memory-swap: under cgroup v2 the limit
 * counts the page cache, so it caps both engines' cache alike. Postgres is `postgres:<ver>` with a replica's settings
 * for that memory (scripts/bench-replica.ts `replicaSettings`); Mason is the `mason-data` image, `mason serve`, which
 * sizes its engine at half the container's limit, syncing the same rows from that Postgres over a Docker network, with
 * `sync: off` on both tables. Its listener is off loopback, so it serves TLS (MASON_PG_SELF_SIGNED_TLS=1); the bench
 * logs in as a user `mason user add` made. Every secret (Postgres's password, MASON_API_KEY, the user's password) is in
 * a 0600 file, given to Docker as --env-file, never on a command line or in the output.
 *
 * A RUN (one statement, one client count, one engine): the other engine's container stopped (Mason's) or idle
 * (Postgres's: a Mason start reads its source's catalog, so it stays up, restarted first); the engine's container
 * restarted; waited until it answers `SELECT 1 FROM orders LIMIT 0`, then --settle seconds; the OS page cache dropped
 * (`sync; echo 3 > /proc/sys/vm/drop_caches`, as root or by `sudo -n`: refused plainly where it cannot be); then pgbench,
 * from the matching postgres image on the host's network, `-n -c N -j N -t 1 -f <script> --log`: each client sends the
 * statement once, all at the same moment, and a client's time is its transaction's latency from pgbench's log (its
 * connection excluded). For the lookup each client asks for a different row, picked at random once per size and kept in
 * the fixture, and sends it as a plain literal: pgbench's \if on :client_id chooses the line, since a literal chosen
 * inside the SQL (`CASE :client_id WHEN …`) stops Mason's engine pushing the filter down.
 *
 * Before anything is timed, each statement's answer from both engines (psql's text, every lookup id) is held equal by
 * its md5; a difference stops the run. The fixture records the machine, the limits, each engine's version and
 * settings, every answer's md5 and every run; it is written after each size and at the end.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Usage, commit, customersOf, dropData, ensureData, fmtRows, parseCount, postgresFacts, replicaSettings, round, writeFixture } from "./bench-replica.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SCRIPT), "..");
/** the containers, the network and the volumes the cold mode makes: a run refuses to start beside any of them */
const PREFIX = "bench-cold";
const PG_CONTAINER = `${PREFIX}-pg`, MASON_CONTAINER = `${PREFIX}-mason`, NETWORK = PREFIX, PG_VOLUME = `${PREFIX}-pg`;
const masonVolume = (rows: number): string => `${PREFIX}-mason-${rows}`;
/** a size's disk, both engines (Postgres's tables and indexes, Mason's file): an estimate, half as much again held free for
 *  what a load writes beside them (an index's sort, the WAL, the first sync's temporary file) */
const BYTES_PER_ROW = 700;
/** the database name the bench connects to on Mason (MASON_PG_DATABASE's default) */
const MASON_DATABASE = "mason";

// --------------------------------------------------------------------------------------------- the statements

export interface ColdStatement { name: string; title: string; sql: string; lookup?: true }
/** The three statements, as the issue writes them (#1121); the lookup's `$id` is each client's literal. */
export const COLD_STATEMENTS: readonly ColdStatement[] = [
  { name: "count", title: "a count over every row", sql: "SELECT status, count(*) FROM orders GROUP BY status ORDER BY status" },
  { name: "sum_by_month", title: "a sum by month over a join",
    sql: "SELECT date_trunc('month', o.created_at) AS month, date_trunc('year', c.created_at) AS signup_year, sum(o.amount) AS revenue " +
      "FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY 1, 2 ORDER BY 1, 2" },
  { name: "lookup", title: "one row by its primary key", sql: "SELECT * FROM orders WHERE id = $id", lookup: true },
];
/** a statement's SQL for one client: the lookup with that client's id as a plain literal */
export const statementSql = (s: ColdStatement, id?: number): string => {
  if (s.lookup !== true) return s.sql;
  if (id === undefined || !Number.isSafeInteger(id) || id < 1) throw new Error(`the lookup needs a positive id, got ${String(id)}`);
  return s.sql.replace("$id", String(id));
};

/**
 * pgbench's script for one statement at `clients` clients: each client sends its own line once. The lookup's line is
 * chosen by pgbench's \if on :client_id, so what reaches the engine is a plain literal; the other statements are the
 * same for every client.
 */
export function pgbenchScript(s: ColdStatement, clients: number, ids: readonly number[]): string {
  if (!Number.isInteger(clients) || clients < 1) throw new Error(`clients: a whole number, got ${clients}`);
  if (s.lookup !== true) return `${s.sql};\n`;
  if (ids.length < clients) throw new Error(`the lookup has ${ids.length} id(s) for ${clients} client(s)`);
  if (clients === 1) return `${statementSql(s, ids[0])};\n`;
  const lines: string[] = [];
  for (let c = 0; c < clients; c++) lines.push(`${c === 0 ? "\\if" : "\\elif"} :client_id = ${c}`, `${statementSql(s, ids[c])};`);
  lines.push("\\endif");
  return `${lines.join("\n")}\n`;
}

/** `n` distinct row ids in [1, rows], picked at random */
export function pickIds(rows: number, n: number, rand: (max: number) => number = (max) => randomInt(max)): number[] {
  if (n > rows) throw new Error(`${n} distinct ids from ${rows} rows`);
  const out = new Set<number>();
  while (out.size < n) out.add(1 + rand(rows));
  return [...out];
}

/** one line of pgbench's per-transaction log: `client_id transaction_no time script_no time_epoch time_us` (time in µs) */
export interface PgbenchTx { client: number; latencyUs: number; endEpochUs: number }
export function parsePgbenchLog(text: string): PgbenchTx[] {
  const out: PgbenchTx[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const f = line.trim().split(/\s+/);
    const [client, , time, , epoch, us] = f.map(Number);
    if (f.length < 6 || ![client, time, epoch, us].every((x) => Number.isFinite(x))) throw new Error(`not a line of pgbench's log: ${JSON.stringify(line)}`);
    out.push({ client: client!, latencyUs: time!, endEpochUs: epoch! * 1e6 + us! });
  }
  return out;
}

/** a run's times: each client's latency (by client id), the slowest, the mean, and from the first client's start to the
 *  last one's end; refused unless every client answered exactly once */
export interface RunTimes { latenciesMs: number[]; slowestMs: number; meanMs: number; spanMs: number }
export function runTimes(txs: readonly PgbenchTx[], clients: number): RunTimes {
  const by = new Map<number, PgbenchTx>();
  for (const t of txs) {
    if (by.has(t.client)) throw new Error(`pgbench's log has client ${t.client} twice: each client sends the statement once`);
    by.set(t.client, t);
  }
  const missing = Array.from({ length: clients }, (_, c) => c).filter((c) => !by.has(c));
  if (missing.length > 0 || by.size !== clients) throw new Error(`pgbench's log has ${by.size} of ${clients} client(s)${missing.length ? ` (none from ${missing.join(", ")})` : ""}`);
  const ordered = Array.from({ length: clients }, (_, c) => by.get(c)!);
  const latenciesMs = ordered.map((t) => round(t.latencyUs / 1000, 3));
  const starts = ordered.map((t) => t.endEpochUs - t.latencyUs), ends = ordered.map((t) => t.endEpochUs);
  return { latenciesMs, slowestMs: Math.max(...latenciesMs), meanMs: round(latenciesMs.reduce((a, b) => a + b, 0) / clients, 3),
    spanMs: round((Math.max(...ends) - Math.min(...starts)) / 1000, 3) };
}

// --------------------------------------------------------------------------------------------- the fixture

export type ColdEngine = "postgres" | "mason";
export interface ColdRun extends RunTimes {
  rows: number; clients: number; statement: string; engine: ColdEngine; run: number; at: string;
  /** from the restart to the engine answering `SELECT 1 FROM orders LIMIT 0`, s */
  readySeconds: number;
}
export interface ColdSize {
  rows: number; customers: number;
  /** the lookup's ids, client 0's first: one client asks for the first */
  lookupIds: number[];
  /** the data's generation in Postgres, s (null: a database made before was reused) */
  generatedSeconds: number | null;
  postgresBytes: number;
  /** Mason's first sync of both tables: from its container's start to `mason wait` answering ready, s */
  syncSeconds: number;
  masonBytes: number;
  /** each statement's answer on both engines: the md5 of psql's text (every lookup id's, in order) */
  answers: Record<string, { postgres: string; mason: string }>;
}
export interface ColdFixture {
  kind: "cold";
  environment: {
    label: string; date: string;
    machine: { cpus: number; cpuModel: string; ramBytes: number; os: string; arch: string; docker: string; cgroup: string };
    /** what each engine's container was given, the same for both */
    limits: { cpus: number; memoryBytes: number; memorySwapBytes: number };
    postgres: { image: string; version: string; settings: Record<string, string> };
    mason: { image: string; version: string; serverVersion: string; settings: Record<string, string>; engineMemory: string };
    client: { image: string; pgbench: string; how: string };
    method: { sizes: number[]; clients: number[]; runs: number; settleSeconds: number; timeZone: string; cold: string; isolation: string; commit: string };
  };
  statements: Array<{ name: string; title: string; sql: string }>;
  sizes: ColdSize[];
  runs: ColdRun[];
  complete: boolean;
}

// --------------------------------------------------------------------------------------------- arguments

export interface ColdOptions {
  sizes: number[]; clients: number[]; runs: number; cpus: number; memoryBytes: number; masonImage: string; postgresImage: string;
  settle: number; reserveGb: number; label: string; out: string; keep: boolean;
}
/** a container's memory as Docker writes it (8g, 512m, 8GiB): binary units */
export function parseMemory(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt])(?:i?b)?$/i.exec(s.trim());
  if (m === null) throw new Usage(`--memory ${JSON.stringify(s)}: a size as Docker takes it, e.g. 8g or 512m`);
  return Math.round(Number(m[1]) * 1024 ** (1 + "kmgt".indexOf(m[2]!.toLowerCase())));
}
const cliVersion = (): string => (JSON.parse(fs.readFileSync(path.join(REPO, "cli/package.json"), "utf8")) as { version: string }).version;
export const masonImageOf = (version: string): string => `ghcr.io/embeddable-hq/mason-data:${version}`;

export function parseColdArgs(argv: readonly string[]): ColdOptions | "help" {
  const o: ColdOptions = { sizes: [1e6, 1e7, 1e8], clients: [1, 10], runs: 3, cpus: 4, memoryBytes: 8 * 2 ** 30, masonImage: "", postgresImage: "postgres:18",
    settle: 10, reserveGb: 10, label: os.hostname(), out: path.join(REPO, "tests/fixtures/bench-replica-cold.json"), keep: false };
  let version: string | null = null, image: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = (): string => { const x = argv[++i]; if (x === undefined) throw new Usage(`${a} needs a value`); return x; };
    const whole = (min: number): number => { const s = v(), n = Number(s); if (!Number.isInteger(n) || n < min) throw new Usage(`${a} ${s}: a whole number, at least ${min}`); return n; };
    switch (a) {
      case "--sizes": o.sizes = v().split(",").map(parseCount); if (o.sizes.some((n) => n < 1000)) throw new Usage(`--sizes: at least 1000 rows a size (the data has a customer for every 20 orders, and at least 1000)`); break;
      case "--clients": o.clients = v().split(",").map((s) => { const n = Number(s); if (!Number.isInteger(n) || n < 1) throw new Usage(`--clients ${s}: a whole number, at least 1`); return n; }); break;
      case "--runs": o.runs = whole(1); break;
      case "--cpus": { const s = v(), n = Number(s); if (!Number.isFinite(n) || n <= 0) throw new Usage(`--cpus ${s}: a positive number, as docker run --cpus takes it`); o.cpus = n; break; }
      case "--memory": o.memoryBytes = parseMemory(v()); break;
      case "--mason-version": version = v(); if (!/^[\w][\w.-]*$/.test(version)) throw new Usage(`--mason-version ${JSON.stringify(version)}: a release (0.23.0) or main`); break;
      case "--mason-image": image = v(); break;
      case "--postgres-image": o.postgresImage = v(); break;
      case "--settle": { const s = v(), n = Number(s); if (!Number.isFinite(n) || n < 0) throw new Usage(`--settle ${s}: seconds, 0 or more`); o.settle = n; break; }
      case "--reserve-gb": { const s = v(), n = Number(s); if (!Number.isFinite(n) || n < 0) throw new Usage(`--reserve-gb ${s}: GiB, 0 or more`); o.reserveGb = n; break; }
      case "--label": o.label = v(); break;
      case "--out": o.out = path.resolve(v()); break;
      case "--keep": o.keep = true; break;
      case "--help": case "-h": return "help";
      default: throw new Usage(`unknown option for --cold: ${a} (--cold --help lists them)`);
    }
  }
  if (version !== null && image !== null) throw new Usage("--mason-version names the published image and --mason-image another: give one of them");
  o.masonImage = image ?? masonImageOf(version ?? cliVersion());
  if (o.memoryBytes < 2 ** 30) throw new Usage("--memory: at least 1g (Mason's engine is given half of it)");
  o.sizes = [...new Set(o.sizes)].sort((a, b) => a - b);
  o.clients = [...new Set(o.clients)].sort((a, b) => a - b);
  return o;
}

// --------------------------------------------------------------------------------------------- the machine

interface Spawned { status: number | null; stdout: string; stderr: string }
const run = (cmd: string, args: readonly string[], input?: string): Spawned => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 2 ** 20, ...(input === undefined ? {} : { input }) });
  if (r.error !== undefined) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
function docker(args: readonly string[]): string {
  const r = run("docker", args);
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** The OS page cache dropped: `sync`, then 3 into /proc/sys/vm/drop_caches, as root or by `sudo -n tee`. */
export function dropCaches(): void {
  const s = run("sync", []);
  if (s.status !== 0) throw new Error(`sync: ${s.stderr.trim()}`);
  const asRoot = process.getuid?.() === 0;
  const r = asRoot ? run("tee", ["/proc/sys/vm/drop_caches"], "3\n") : run("sudo", ["-n", "tee", "/proc/sys/vm/drop_caches"], "3\n");
  if (r.status !== 0) {
    throw new Usage(`the cold mode drops the OS page cache before every run, and this machine would not let it: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}. ` +
      `Run it on Linux as root, or as a user that may run \`sudo -n tee /proc/sys/vm/drop_caches\` (a container or a Mac's Docker cannot drop the host's cache)`);
  }
}

/** Docker answers, the page cache can be dropped, and nothing of an earlier run is left: else a plain refusal */
function preflight(): { docker: string; cgroup: string } {
  if (process.platform !== "linux") throw new Usage(`the cold mode drops the OS page cache, which only Linux lets it do here (this is ${process.platform})`);
  const v = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (v.status !== 0) throw new Usage(`the cold mode runs each engine in a Docker container, and Docker did not answer: ${(v.stderr || v.stdout).trim()}`);
  dropCaches();
  const left = docker(["ps", "-a", "--filter", `name=^/${PREFIX}-`, "--format", "{{.Names}}"]);
  const vols = docker(["volume", "ls", "--filter", `name=^${PREFIX}-`, "--format", "{{.Name}}"]);
  const nets = docker(["network", "ls", "--filter", `name=^${NETWORK}$`, "--format", "{{.Name}}"]);
  const found = [...left.split("\n"), ...vols.split("\n"), ...nets.split("\n")].filter((x) => x !== "");
  if (found.length > 0) {
    throw new Usage(`an earlier cold run left ${found.join(", ")} (a run in progress, or one with --keep). If it is yours: ` +
      `docker rm -f ${PG_CONTAINER} ${MASON_CONTAINER}; docker volume rm $(docker volume ls -q --filter name=^${PREFIX}-); docker network rm ${NETWORK}`);
  }
  return { docker: v.stdout.trim(), cgroup: docker(["info", "--format", "{{.CgroupVersion}}"]) || "unknown" };
}

/** free bytes on the filesystem a Docker volume is on, as `df` inside a container sees it */
function volumeFreeBytes(volume: string, image: string): number {
  const out = docker(["run", "--rm", "-v", `${volume}:/d`, "--entrypoint", "df", image, "-B1", "--output=avail", "/d"]);
  const n = Number(out.split("\n").pop());
  if (!Number.isFinite(n)) throw new Error(`df did not say the free space of the volume ${volume}: ${out}`);
  return n;
}

/** a file only this user reads, written whole */
function secretFile(file: string, lines: Record<string, string>): void {
  for (const [k, v] of Object.entries(lines)) if (/[\n\r]/.test(v)) throw new Error(`${k}: an environment file's value is one line`);
  fs.writeFileSync(file, Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

// --------------------------------------------------------------------------------------------- the run

export async function coldMain(argv: readonly string[]): Promise<number> {
  const parsed = parseColdArgs(argv);
  if (parsed === "help") {
    process.stdout.write(fs.readFileSync(SCRIPT, "utf8").split(" */")[0]!.replace(/^\/\*\*\n/, "").replace(/^ \* ?/gm, "") + "\n");
    return 0;
  }
  const o = parsed;
  const log = (l: string): void => { process.stdout.write(`${l}\n`); };
  const machine = preflight();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cold-"));
  fs.chmodSync(work, 0o700);
  const uid = process.getuid?.() ?? 0, gid = process.getgid?.() ?? 0;
  const pgPassword = randomBytes(18).toString("hex"), apiKey = randomBytes(24).toString("hex");
  const pgEnv = path.join(work, "postgres.env");
  secretFile(pgEnv, { POSTGRES_PASSWORD: pgPassword });
  const limits = ["--cpus", String(o.cpus), "--memory", `${o.memoryBytes}b`, "--memory-swap", `${o.memoryBytes}b`];
  const made: { containers: string[]; volumes: string[]; network: boolean } = { containers: [], volumes: [], network: false };
  const cleanup = (): void => {
    if (o.keep) { log(`left (--keep): ${[...made.containers, ...made.volumes, ...(made.network ? [NETWORK] : [])].join(", ")}`); fs.rmSync(work, { recursive: true, force: true }); return; }
    for (const c of made.containers) { const r = run("docker", ["rm", "-f", "-v", c]); if (r.status !== 0 && !/No such container/.test(r.stderr)) log(`could not remove ${c}: ${r.stderr.trim()}`); }
    for (const v of made.volumes) { const r = run("docker", ["volume", "rm", "-f", v]); if (r.status !== 0) log(`could not remove the volume ${v}: ${r.stderr.trim()}`); }
    if (made.network) { const r = run("docker", ["network", "rm", NETWORK]); if (r.status !== 0) log(`could not remove the network ${NETWORK}: ${r.stderr.trim()}`); }
    // the secrets' files and the clients' scripts and logs
    fs.rmSync(work, { recursive: true, force: true });
  };
  const onSignal = (code: number) => (): void => { log("interrupted: the fixture holds the sizes completed"); cleanup(); process.exit(code); };
  process.once("SIGINT", onSignal(130));
  process.once("SIGTERM", onSignal(143));
  try {
    log(`bench-replica --cold: ${o.label}; each engine in a container of ${o.cpus} CPUs and ${(o.memoryBytes / 2 ** 30).toFixed(1)} GiB (Docker ${machine.docker}, cgroup ${machine.cgroup})`);
    log(`  sizes ${o.sizes.map(fmtRows).join(", ")} × clients ${o.clients.join(", ")} × ${COLD_STATEMENTS.length} statements × ${o.runs} run(s), each engine; Mason ${o.masonImage}, ${o.postgresImage}`);
    for (const image of [o.postgresImage, o.masonImage]) {
      if (run("docker", ["image", "inspect", image]).status !== 0) { log(`  pulling ${image}…`); docker(["pull", "-q", image]); }
    }
    docker(["network", "create", NETWORK]); made.network = true;
    docker(["volume", "create", PG_VOLUME]); made.volumes.push(PG_VOLUME);

    // ---- Postgres: a replica's settings for the container's memory, on the network and on a loopback port -----------
    const settings = replicaSettings(o.memoryBytes, Math.max(1, Math.floor(o.cpus)));
    // a port of its own, fixed: a port Docker picks may change at each restart
    const pgPort = await freePort();
    made.containers.push(PG_CONTAINER);
    docker(["run", "-d", "--name", PG_CONTAINER, "--network", NETWORK, ...limits, "--shm-size", "1g", "--env-file", pgEnv,
      "-p", `127.0.0.1:${pgPort}:5432`, "-v", `${PG_VOLUME}:/var/lib/postgresql`, o.postgresImage, ...Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${v}`])]);
    const admin = `postgres://postgres:${pgPassword}@127.0.0.1:${pgPort}/postgres`;
    await answersWithin(() => probe({ connectionString: admin }, "SELECT 1"), 180_000, `${PG_CONTAINER} did not answer in 3 minutes (docker logs ${PG_CONTAINER} says why)`);
    const pgFacts = await postgresFacts(admin);
    const pgbenchVersion = docker(["run", "--rm", "--entrypoint", "pgbench", o.postgresImage, "--version"]);

    const fixture: ColdFixture = {
      kind: "cold",
      environment: {
        label: o.label, date: new Date().toISOString(),
        machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model.trim() ?? "unknown", ramBytes: os.totalmem(), os: `${os.type()} ${os.release()}`, arch: os.arch(),
          docker: machine.docker, cgroup: machine.cgroup },
        limits: { cpus: o.cpus, memoryBytes: o.memoryBytes, memorySwapBytes: o.memoryBytes },
        postgres: { image: o.postgresImage, version: pgFacts.version, settings: pgFacts.settings },
        mason: { image: o.masonImage, version: "", serverVersion: "", settings: { MASON_PG_SELF_SIGNED_TLS: "1", MASON_PROJECT_READONLY: "1", MASON_NAME: "bench", "sync:": "off" },
          engineMemory: "half the container's --memory (the image's default: MASON_DUCKDB_MEMORY unset)" },
        client: { image: o.postgresImage, pgbench: pgbenchVersion,
          how: "pgbench -n -c N -j N -t 1 on the host's network: each client sends the statement once, all at once; a client's time is its transaction's latency in pgbench's log, its connection excluded" },
        method: { sizes: o.sizes, clients: o.clients, runs: o.runs, settleSeconds: o.settle, timeZone: "UTC",
          cold: `before every run the engine's container was restarted, waited for until it answered SELECT 1 FROM orders LIMIT 0, then ${o.settle} s more, and the OS page cache dropped (sync; echo 3 > /proc/sys/vm/drop_caches)`,
          isolation: "Mason's container stopped while Postgres was measured; Postgres's container up but idle (restarted first) while Mason was measured, since a Mason start reads its source's catalog",
          commit: commit() },
      },
      statements: COLD_STATEMENTS.map((s) => ({ name: s.name, title: s.title, sql: s.sql })),
      sizes: [], runs: [], complete: false,
    };
    const save = (why: string): void => { writeFixture(o.out, fixture); log(`  wrote ${path.relative(process.cwd(), o.out)} (${why})`); };
    log(`  ${pgFacts.version.split(" on ")[0]}; ${Object.entries(pgFacts.settings).map(([k, v]) => `${k}=${v}`).join(" ")}`);

    let previous: number | null = null;
    for (const rows of o.sizes) {
      // the size before is measured: its database dropped first, so its disk is this size's
      if (previous !== null && !o.keep) await dropData(admin, previous, log);
      // ---- the disk: this size's data on both engines, where Docker keeps its volumes -------------------------------
      const free = volumeFreeBytes(PG_VOLUME, o.postgresImage), need = rows * BYTES_PER_ROW * 1.5;
      if (free - need < o.reserveGb * 2 ** 30) {
        throw new Usage(`${fmtRows(rows)} rows need about ${(need / 2 ** 30).toFixed(0)} GiB on both engines, and ${(free / 2 ** 30).toFixed(0)} GiB is free where Docker keeps its volumes: ` +
          `less than --reserve-gb ${o.reserveGb} would be left. Free the disk, or leave this size out of --sizes`);
      }
      log(`\n== ${rows.toLocaleString("en-US")} orders ==`);
      const data = await ensureData(admin, rows, log);
      const db = new URL(data.url).pathname.slice(1);
      const pgConn: pg.ClientConfig = { connectionString: data.url };
      const postgresBytes = Number((await one(pgConn, "SELECT pg_total_relation_size('public.orders') + pg_total_relation_size('public.customers') AS b")).b);
      const ids = pickIds(rows, Math.max(...o.clients));
      log(`  the lookup's ids: ${ids.join(", ")}`);

      // ---- Mason: a project of one source, sync: off, its first sync from that Postgres ----------------------------
      const project = path.join(work, `project-${rows}`);
      fs.mkdirSync(path.join(project, "sources"), { recursive: true, mode: 0o755 });
      fs.chmodSync(project, 0o755); fs.chmodSync(path.join(project, "sources"), 0o755);
      fs.writeFileSync(path.join(project, "sources", "bench.yml"), "kind: postgres\nurl: ${DATABASE_URL}\nsync: off\ntables:\n  orders: {}\n  customers: {}\n", { mode: 0o644 });
      const masonEnv = path.join(work, "mason.env");
      // plain over the bench's own Docker network: its Postgres serves no TLS
      secretFile(masonEnv, { DATABASE_URL: `postgres://postgres:${pgPassword}@${PG_CONTAINER}:5432/${db}?sslmode=disable`, MASON_API_KEY: apiKey, MASON_NAME: "bench",
        MASON_PG_SELF_SIGNED_TLS: "1", MASON_PROJECT_READONLY: "1" });
      const vol = masonVolume(rows);
      docker(["volume", "create", vol]); made.volumes.push(vol);
      made.containers.push(MASON_CONTAINER);
      const masonPort = await freePort();
      const t0 = performance.now();
      docker(["run", "-d", "--name", MASON_CONTAINER, "--network", NETWORK, ...limits, "--env-file", masonEnv, "-p", `127.0.0.1:${masonPort}:5433`,
        "-v", `${vol}:/mason/data`, "-v", `${project}:/mason/project:ro`, o.masonImage]);
      fs.rmSync(masonEnv);
      log(`Mason: syncing ${db} in ${MASON_CONTAINER}…`);
      await masonSynced(log);
      const syncSeconds = round((performance.now() - t0) / 1000, 1);
      log(`  synced and served in ${syncSeconds} s`);
      fixture.environment.mason.version = docker(["exec", MASON_CONTAINER, "mason", "--version"]);
      const masonPassword = userPassword(docker(["exec", MASON_CONTAINER, "mason", "user", "add", "bench", "--json"]));
      const masonBytes = Number(docker(["exec", MASON_CONTAINER, "du", "-sb", "/mason/data"]).split(/\s/)[0]);
      const pgClientEnv = path.join(work, "client-postgres.env"), masonClientEnv = path.join(work, "client-mason.env");
      secretFile(pgClientEnv, { PGHOST: "127.0.0.1", PGPORT: String(pgPort), PGUSER: "postgres", PGPASSWORD: pgPassword, PGDATABASE: db, PGOPTIONS: "-c TimeZone=UTC", PGSSLMODE: "disable" });
      secretFile(masonClientEnv, { PGHOST: "127.0.0.1", PGPORT: String(masonPort), PGUSER: "bench", PGPASSWORD: masonPassword, PGDATABASE: MASON_DATABASE, PGOPTIONS: "-c TimeZone=UTC", PGSSLMODE: "require" });
      const masonConn: pg.ClientConfig = { host: "127.0.0.1", port: masonPort, user: "bench", password: masonPassword, database: MASON_DATABASE, ssl: { rejectUnauthorized: false } };
      const envOf: Record<ColdEngine, string> = { postgres: pgClientEnv, mason: masonClientEnv };
      const connOf: Record<ColdEngine, pg.ClientConfig> = { postgres: pgConn, mason: masonConn };
      fixture.environment.mason.serverVersion = String((await one(masonConn, "SELECT version() AS v")).v);

      // ---- the answers, held equal before anything is timed ---------------------------------------------------------
      const answers: ColdSize["answers"] = {};
      for (const s of COLD_STATEMENTS) {
        const sqls = s.lookup === true ? ids.map((id) => statementSql(s, id)) : [statementSql(s)];
        const text = (e: ColdEngine): string => psql(o.postgresImage, envOf[e], uid, gid, sqls);
        const a = text("postgres"), b = text("mason");
        answers[s.name] = { postgres: md5(a), mason: md5(b) };
        if (a !== b) {
          throw new Error(`the answers differ at ${fmtRows(rows)} rows, ${s.name} (${s.title}): Postgres's md5 ${md5(a)}, Mason's ${md5(b)}; nothing is timed over different answers.\n` +
            `Postgres:\n${a.split("\n").slice(0, 8).join("\n")}\nMason:\n${b.split("\n").slice(0, 8).join("\n")}`);
        }
      }
      log("  every statement's answer is the same on both (psql's text, by its md5)");
      const size: ColdSize = { rows, customers: customersOf(rows), lookupIds: ids, generatedSeconds: data.generatedSeconds, postgresBytes, syncSeconds, masonBytes, answers };
      fixture.sizes.push(size);

      // ---- the runs: each one cold ---------------------------------------------------------------------------------
      const restart = async (e: ColdEngine): Promise<number> => {
        if (e === "postgres") {
          docker(["stop", MASON_CONTAINER]);
          docker(["restart", PG_CONTAINER]);
        } else {
          // Postgres idle and restarted first, since a Mason start reads its source's catalog
          docker(["restart", PG_CONTAINER]);
          await answersWithin(() => probe(pgConn, "SELECT 1 FROM orders LIMIT 0"), 180_000, `${PG_CONTAINER} did not answer in 3 minutes after its restart`);
          docker(["restart", MASON_CONTAINER]);
        }
        const t = performance.now();
        await answersWithin(() => probe(connOf[e], "SELECT 1 FROM orders LIMIT 0"), 600_000,
          `${e === "postgres" ? PG_CONTAINER : MASON_CONTAINER} did not answer SELECT 1 FROM orders LIMIT 0 in 10 minutes after its restart (docker logs ${e === "postgres" ? PG_CONTAINER : MASON_CONTAINER} says why)`);
        return round((performance.now() - t) / 1000, 1);
      };
      const runDir = path.join(work, "run");
      fs.mkdirSync(runDir, { recursive: true, mode: 0o755 });
      fs.chmodSync(runDir, 0o777);
      for (let r = 1; r <= o.runs; r++) {
        for (const clients of o.clients) {
          for (const s of COLD_STATEMENTS) {
            // the engines alternate which goes first, so a drift in the machine falls on both
            for (const e of (r % 2 === 1 ? ["postgres", "mason"] : ["mason", "postgres"]) as ColdEngine[]) {
              const readySeconds = await restart(e);
              await sleep(o.settle * 1000);
              dropCaches();
              for (const f of fs.readdirSync(runDir)) fs.rmSync(path.join(runDir, f));
              fs.writeFileSync(path.join(runDir, "script.sql"), pgbenchScript(s, clients, ids), { mode: 0o644 });
              const at = new Date().toISOString();
              const b = run("docker", ["run", "--rm", "--network", "host", "--user", `${uid}:${gid}`, "--env-file", envOf[e], "-v", `${runDir}:/w`, "--entrypoint", "pgbench", o.postgresImage,
                "-n", "-c", String(clients), "-j", String(clients), "-t", "1", "-f", "/w/script.sql", "--log", "--log-prefix=/w/log"]);
              if (b.status !== 0) throw new Error(`pgbench on ${e} (${fmtRows(rows)} rows, ${clients} client(s), ${s.name}, run ${r}) exited ${b.status}: ${(b.stderr || b.stdout).trim().split("\n").slice(-6).join("\n")}`);
              const logText = fs.readdirSync(runDir).filter((f) => f.startsWith("log.")).map((f) => fs.readFileSync(path.join(runDir, f), "utf8")).join("\n");
              const times = runTimes(parsePgbenchLog(logText), clients);
              fixture.runs.push({ rows, clients, statement: s.name, engine: e, run: r, at, readySeconds, ...times });
              log(`[${fmtRows(rows)} · ${clients} client(s) · ${s.name.padEnd(12)} · ${e.padEnd(8)} · run ${r}] slowest ${secondsText(times.slowestMs)} s, mean ${secondsText(times.meanMs)} s (ready ${readySeconds} s after its restart)`);
            }
          }
        }
        save(`${fmtRows(rows)}: run ${r} of ${o.runs}`);
      }

      // ---- this size's Mason removed (its volume too), so the next size's disk is free ------------------------------
      if (!o.keep) {
        docker(["rm", "-f", "-v", MASON_CONTAINER]); made.containers = made.containers.filter((c) => c !== MASON_CONTAINER);
        docker(["volume", "rm", vol]); made.volumes = made.volumes.filter((v) => v !== vol);
      } else if (rows !== o.sizes[o.sizes.length - 1]) {
        docker(["rm", "-f", "-v", MASON_CONTAINER]); made.containers = made.containers.filter((c) => c !== MASON_CONTAINER);
      }
      // Postgres up again for the next size's data (it was stopped by nothing, but Mason's runs restarted it)
      await answersWithin(() => probe({ connectionString: admin }, "SELECT 1"), 180_000, `${PG_CONTAINER} did not answer in 3 minutes`);
      previous = rows;
    }
    fixture.complete = true;
    save("complete");
    printMedians(fixture, log);
    return 0;
  } finally { cleanup(); }

  /** until `mason wait` says the run's tables are synced and served: before the run is up (its first start reads how
   *  the database orders text) `mason wait` answers that nothing runs, so it is asked again until it waits */
  async function masonSynced(say: (l: string) => void): Promise<void> {
    const deadline = Date.now() + 12 * 3600_000;
    let asked = 0;
    for (;;) {
      const r = run("docker", ["exec", MASON_CONTAINER, "mason", "wait", "--timeout", "12h", "--json"]);
      if (r.status === 0) return;
      const state = run("docker", ["inspect", "--format", "{{.State.Running}}", MASON_CONTAINER]).stdout.trim();
      if (state !== "true") {
        // the container is removed at the end, so its log is said here (Mason's log names no secret)
        const tail = run("docker", ["logs", "--tail", "25", MASON_CONTAINER]);
        throw new Error(`${MASON_CONTAINER} stopped before its first sync was served; the end of its log:\n${(tail.stdout + tail.stderr).trim()}`);
      }
      let code = "";
      try { code = String((JSON.parse(r.stdout) as { error?: { code?: string } }).error?.code ?? ""); } catch { code = `not JSON: ${r.stdout.slice(0, 200)}`; }
      // before `mason serve` has made its state (no_project) and while it reads how the database orders text (not_running)
      const notUp = code === "no_project" || code === "not_running";
      if (!notUp) throw new Error(`Mason's first sync did not finish (mason wait exited ${r.status}, ${code}): ${(r.stdout || r.stderr).slice(0, 600)}`);
      if (Date.now() > deadline) throw new Error(`Mason did not start in 12 hours: ${(r.stdout || r.stderr).slice(0, 300)}`);
      if (++asked % 30 === 1) say(`  (the run is not up yet: mason wait says ${code || `exit ${r.status}`}; asked again every 2 s)`);
      await sleep(2000);
    }
  }
}

/** the password `mason user add <name> --json` printed: read, never shown */
export function userPassword(json: string): string {
  let v: unknown;
  try { v = JSON.parse(json); } catch { throw new Error("mason user add --json did not answer JSON"); }
  const p = (v as { password?: unknown }).password;
  if (typeof p !== "string" || p === "") throw new Error(`mason user add --json has no password: its keys are ${Object.keys(v as object).join(", ")}`);
  return p;
}

/** psql's text of `sqls` in turn (headers, rows and the row count), from the client image on the host's network */
function psql(image: string, envFile: string, uid: number, gid: number, sqls: readonly string[]): string {
  const r = run("docker", ["run", "--rm", "--network", "host", "--user", `${uid}:${gid}`, "--env-file", envFile, "--entrypoint", "psql", image,
    "-X", "-A", "-v", "ON_ERROR_STOP=1", ...sqls.flatMap((s) => ["-c", s])]);
  if (r.status !== 0) throw new Error(`psql: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

async function one(conn: pg.ClientConfig, sql: string): Promise<Record<string, unknown>> {
  const c = new pg.Client(conn);
  await c.connect();
  try { return (await c.query(sql)).rows[0] as Record<string, unknown>; } finally { await c.end(); }
}
/** whether `sql` answers on `conn` now: the error when it does not */
async function probe(conn: pg.ClientConfig, sql: string): Promise<Error | null> {
  const c = new pg.Client({ ...conn, connectionTimeoutMillis: 5000 });
  try { await c.connect(); await c.query(sql); return null; }
  catch (e) { return e as Error; }
  // a client that never connected may fail to end: the probe's answer is the error above, or null
  finally { await c.end().catch((x: Error) => x); }
}
async function answersWithin(p: () => Promise<Error | null>, ms: number, failure: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const e = await p();
    if (e === null) return;
    if (Date.now() > deadline) throw new Error(`${failure}: ${e.message}`);
    await sleep(250);
  }
}

const secondsText = (ms: number): string => (ms / 1000).toFixed(ms >= 10_000 ? 1 : 3);

/** the median of each cell's slowest client, both engines: what the README shows */
export function coldMedians(f: Pick<ColdFixture, "runs">): Array<{ rows: number; clients: number; statement: string; postgresMs: number; masonMs: number; runs: number }> {
  const med = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };
  const keys = [...new Map(f.runs.map((r) => [`${r.rows} ${r.clients} ${r.statement}`, r])).values()];
  return keys.map((k) => {
    const of = (e: ColdEngine): number[] => f.runs.filter((r) => r.rows === k.rows && r.clients === k.clients && r.statement === k.statement && r.engine === e).map((r) => r.slowestMs);
    return { rows: k.rows, clients: k.clients, statement: k.statement, postgresMs: med(of("postgres")), masonMs: med(of("mason")), runs: Math.min(of("postgres").length, of("mason").length) };
  });
}

function printMedians(f: ColdFixture, log: (l: string) => void): void {
  log(`\n${"rows".padStart(6)} ${"clients".padStart(7)}  ${"statement".padEnd(12)} ${"Postgres (s)".padStart(12)} ${"Mason (s)".padStart(10)}`);
  for (const m of coldMedians(f)) log(`${fmtRows(m.rows).padStart(6)} ${String(m.clients).padStart(7)}  ${m.statement.padEnd(12)} ${secondsText(m.postgresMs).padStart(12)} ${secondsText(m.masonMs).padStart(10)}`);
}
