/** `mason doctor`: each check's verdict and words, and the next command it ends with (src/cli/doctor.ts). */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR_USAGE, memoryCheck, NODE_MIN, nextSteps, nodeCheck, portsCheck, PORTS, verdictOf, type Check } from "../src/cli/doctor.ts";
import * as doctorModule from "../src/cli/doctor.ts";
import { defaultMemoryLimit, machineMemoryBytes } from "../src/duck/store.ts";
import type { DevRun } from "../src/cli/runs.ts";
import { newConfig, type Project } from "../src/cli/project.ts";

const project: Project = { root: "/app", dir: "/app/.mason", folder: "/app/mason", config: newConfig("app", "mason", false) };
const run: DevRun = { name: "app", root: "/app", home: "/app/.mason", folder: "/app/mason", pid: 1, apiKey: "k",
  control: { url: "http://127.0.0.1:4039", token: "t" }, postgresUrl: "postgresql://127.0.0.1:5433/app", postgresListener: { host: "127.0.0.1", tls: null } };

test("node: major then minor against the floor, with the way out", () => {
  assert.equal(NODE_MIN, "22.13");
  assert.deepEqual(nodeCheck("22.13.0"), { name: "node", ok: true, detail: "Node 22.13.0" });
  assert.equal(nodeCheck("22.23.4").ok, true);
  assert.equal(nodeCheck("24.1.0").ok, true);
  // 22.12 refuses a module the package loads (src/cli/doctor.ts NODE_MIN)
  const before = nodeCheck("22.12.0");
  assert.equal(before.ok, false);
  assert.equal(before.detail, "Node 22.12.0 is too old: mason needs 22.13 or later (nodejs.org, or nvm install 22)");
  assert.equal(nodeCheck("20.18.0").ok, false);
});

test("the package's engines and every Node the READMEs name for the package are NODE_MIN, so they cannot drift", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "cli", "package.json"), "utf8")) as { engines: { node: string } };
  assert.equal(pkg.engines.node, `>=${NODE_MIN}`);
  // cli/README.md is the package's page: every Node it names is the floor
  const cli = fs.readFileSync(path.join(root, "cli", "README.md"), "utf8");
  const named = [...cli.matchAll(/\bNode (\d+(?:\.\d+)*)/g)].map((m) => m[1]);
  assert.ok(named.length >= 3, "cli/README.md says the floor where it lists what mason needs");
  assert.deepEqual([...new Set(named)], [NODE_MIN]);
  // the repo's README: the package's install line says the floor; its `Node ≥ 23.6` is the checkout's, not the package's
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const install = readme.split("\n").find((l) => l.startsWith("npm i -g @mason-data/cli"));
  assert.match(install ?? "", new RegExp(`needs Node ${NODE_MIN.replace(".", "\\.")}\\+ `));
  assert.deepEqual([...readme.matchAll(/\bNode (\d+(?:\.\d+)*)\+/g)].map((m) => m[1]), [NODE_MIN], "every `Node <n>+` in the README");
  // and what mason prints says it too
  assert.match(DOCTOR_USAGE, new RegExp(`Node ${NODE_MIN.replace(".", "\\.")} or later`));
});

test("the memory the run may use is the container's limit where one is set, else the machine's RAM", () => {
  const gib = 1024 ** 3;
  const files = (m: Record<string, string>) => (f: string): string => { if (f in m) return m[f]!; throw new Error(`ENOENT: ${f}`); };
  assert.equal(machineMemoryBytes(files({}), 32 * gib), 32 * gib, "no cgroup file: the machine's RAM");
  assert.equal(machineMemoryBytes(files({ "/sys/fs/cgroup/memory.max": "max\n" }), 32 * gib), 32 * gib, "v2 with no limit");
  assert.equal(machineMemoryBytes(files({ "/sys/fs/cgroup/memory.max": `${4 * gib}\n` }), 32 * gib), 4 * gib, "v2 limit");
  assert.equal(machineMemoryBytes(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n" }), 32 * gib), 32 * gib, "v1 with no limit");
  assert.equal(machineMemoryBytes(files({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${2 * gib}` }), 32 * gib), 2 * gib, "v1 limit");
  assert.equal(machineMemoryBytes(files({ "/sys/fs/cgroup/memory.max": `${64 * gib}` }), 32 * gib), 32 * gib, "a limit above the RAM is not one");
  assert.equal(defaultMemoryLimit(machineMemoryBytes(files({ "/sys/fs/cgroup/memory.max": `${4 * gib}` }), 32 * gib)), "2048MiB");
});

test("memory: the machine's and the share the copy may use, in one short line; under 2 GiB is a warning", () => {
  const big = memoryCheck(32 * 1024 ** 3, {});
  assert.equal(big.ok, true);
  assert.equal(big.detail, "32.0 GiB; Mason's synced data uses up to 16384MiB (half, the default; MASON_DUCKDB_MEMORY sets it)");
  const set = memoryCheck(32 * 1024 ** 3, { MASON_DUCKDB_MEMORY: "12GiB" });
  assert.equal(set.detail, "32.0 GiB; Mason's synced data uses up to 12GiB (MASON_DUCKDB_MEMORY)");
  const small = memoryCheck(1.5 * 1024 ** 3, {});
  assert.equal(small.ok, false);
  assert.equal(small.detail, "1.5 GiB; Mason's synced data uses up to 768MiB (half, the default; MASON_DUCKDB_MEMORY sets it). Under 2 GiB, a large table's first sync and a query starve each other: expect statements refused for memory");
  const bad = memoryCheck(32 * 1024 ** 3, { MASON_DUCKDB_MEMORY: "lots" });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /^MASON_DUCKDB_MEMORY="lots" is not a size/);
});

test("ports: one line, never a failure nor a \"?\" — all free, or which are in use and by whom, and that Mason moves", async () => {
  const H = { address: "0.0.0.0", code: "EADDRINUSE" };
  const by = (ports: Set<number>) => async (p: number) => ports.has(p) ? H : null;
  assert.deepEqual(PORTS.map(([p]) => p), [4039, 5433]);
  assert.deepEqual(await portsCheck([run], async () => null, {}), { name: "ports", ok: true, detail: "4039, 5433 free" });
  const busy = await portsCheck([run], by(new Set([4039])), {});
  assert.equal(busy.ok, true);
  assert.equal(busy.detail, "4039 in use by Mason for app: mason start will use another free port for the commands (mason status shows them)");
  // the Postgres API's port is a run's too, found by the URL mason start recorded
  const pgHeld = await portsCheck([run], by(new Set([5433])), {});
  assert.equal(pgHeld.detail, "5433 in use by Mason for app: mason start will use another free port for the commands (mason status shows them)");
  const other = await portsCheck([], by(new Set([4039])), {});
  assert.equal(other.detail, "4039 in use by another program: mason start will use another free port for the commands (mason status shows them)");
  // the Postgres API's port held by something that is not a Mason run is a refusal: the project's port never moves by itself
  const pgOther = await portsCheck([], by(new Set([5433])), {});
  assert.equal(pgOther.ok, false);
  assert.match(pgOther.detail, /5433/);
  // a recorded project port is the one probed, in 5433's place
  assert.deepEqual(await portsCheck([], async () => null, {}, 5434), { name: "ports", ok: true, detail: "4039, 5434 free" });
});

test("ports: a NAMED MASON_PG_PORT replaces 5433, and held or not a port it is mason start's refusal, not a move", async () => {
  const named = await portsCheck([], async () => null, { MASON_PG_PORT: "55433" });
  assert.deepEqual(named, { name: "ports", ok: true, detail: "4039, 55433 free" });
  const held = await portsCheck([], async (p) => p === 55433 ? { address: "0.0.0.0", code: "EADDRINUSE" } : null, { MASON_PG_PORT: "55433" });
  assert.equal(held.ok, false);
  assert.equal(held.detail, "MASON_PG_PORT=55433 is in use: something holds port 55433 on 0.0.0.0 (EADDRINUSE), so the Postgres API cannot listen there. " +
    "stop what holds it (lsof -nP -iTCP:55433 -sTCP:LISTEN names it), or set another MASON_PG_PORT (1024-65535), or unset it and mason start picks a free port");
  const zero = await portsCheck([], async () => null, { MASON_PG_PORT: "0" });
  assert.equal(zero.ok, false);
  assert.match(zero.detail, /^MASON_PG_PORT=0 is not a port/);
});

test("the verdict is the first line: ready with the command to run, not ready with the first failure, or the run", () => {
  const ok = (name: string, detail = ""): Check => ({ name, ok: true, detail });
  const bad = (name: string, detail: string): Check => ({ name, ok: false, detail });
  assert.deepEqual(verdictOf([ok("node"), ok("docker")], null, null), { ready: true, verdict: "Ready: mason init, in your app's folder" });
  assert.deepEqual(verdictOf([ok("node"), ok("database")], null, project), { ready: true, verdict: "Ready: mason start (the project app)" });
  assert.deepEqual(verdictOf([ok("node"), bad("docker", "Docker is not running (…). Start Docker Desktop"), bad("memory", "x")], null, null),
    { ready: false, verdict: "Not ready: Docker is not running" });
  assert.deepEqual(verdictOf([ok("mason start"), ok("project"), ok("queries")], run, project), { ready: true, verdict: "Mason is running for app" });
  assert.deepEqual(verdictOf([ok("mason start"), bad("project", "2 problems")], run, project), { ready: false, verdict: "Mason is running for app, with 1 problem" });
});

test("the next command follows the first failing check, in the order a first session meets them", () => {
  const ok = (name: string, detail = ""): Check => ({ name, ok: true, detail });
  const bad = (name: string): Check => ({ name, ok: false, detail: "" });
  const first = (c: Check[], r: typeof run | null, p: typeof project | null): string => nextSteps(c, r, p).map(([cmd]) => cmd).join(" | ");
  assert.equal(first([bad("node"), bad("memory")], null, null), "mason doctor");
  assert.match(nextSteps([ok("node"), bad("database")], null, project)[0]![1]!, /the URL is in \/app\/\.mason\/config\.json/);
  // the demo database is down until its run is up: mason start is the way out, not a URL to fix
  const demoProject = { ...project, config: { ...project.config, demo: true } } as typeof project;
  assert.deepEqual(nextSteps([ok("node"), bad("database")], null, demoProject), [["mason start", "hosts the demo database, then syncs its tables"]]);
  assert.equal(first([ok("node"), ok("memory")], null, null), "mason init | mason init postgres://user:password@localhost:5432/your_app");
  assert.equal(first([ok("node"), ok("database")], null, project), "mason start");
  assert.equal(first([ok("node"), bad("mason start")], run, project), "mason logs | mason stop");
  assert.equal(first([ok("node"), ok("mason start"), bad("project")], run, project), "mason wait");
  assert.equal(first([ok("mason start"), ok("project", "no table added yet (mason tables, then mason add <table>)")], run, project), "mason tables | mason add <table>");
  assert.equal(first([ok("mason start"), ok("project", "applied: 2 table(s)"), bad("queries")], run, project), "mason status");
  assert.equal(first([ok("mason start"), ok("project", "applied: 2 table(s)"), ok("queries")], run, project), "mason user add <name>");
});

test("extensions: the probe's verdict on its own line; not shipped and not downloaded yet is a question, never a failure", async () => {
  // read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
  const { extensionsCheck } = doctorModule as unknown as { extensionsCheck?: (probe: () => Promise<{ ok: boolean | null; detail: string }>) => Promise<Check> };
  assert.equal(typeof extensionsCheck, "function", "src/cli/doctor.ts exports extensionsCheck");
  const shipped = await extensionsCheck!(async () => ({ ok: true, detail: "postgres and inet ship with Mason (@mason-data/extensions-linux-x64 0.7.0): nothing is downloaded" }));
  assert.deepEqual(shipped, { name: "extensions", ok: true, detail: "postgres and inet ship with Mason (@mason-data/extensions-linux-x64 0.7.0): nothing is downloaded" });
  const later = await extensionsCheck!(async () => ({ ok: null, detail: "postgres and inet not on this machine yet, so the first sync downloads them and needs the internet once: …" }));
  assert.equal(later.ok, null);
  const ok: Check[] = [nodeCheck("24.1.0"), later];
  assert.equal(verdictOf(ok, null, project).ready, true, "online, a first copy downloads them: still ready");
  const broken = await extensionsCheck!(async () => ({ ok: false, detail: "@mason-data/extensions-linux-x64 0.7.0 is installed, and its inet does not load: … Install @mason-data/cli again" }));
  assert.equal(verdictOf([nodeCheck("24.1.0"), broken], null, project).ready, false);
  assert.match(DOCTOR_USAGE, /the postgres and inet extensions Mason syncs with/);
});
