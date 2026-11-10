/** `mason doctor`: each check's verdict and words, and the next command it ends with (src/cli/doctor.ts). */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTOR_USAGE, memoryCheck, NODE_MIN, nextSteps, nodeCheck, portsCheck, PORTS, verdictOf, type Check } from "../src/cli/doctor.ts";
import * as doctorModule from "../src/cli/doctor.ts";
import * as storeModule from "../src/duck/store.ts";
// read from the module, not imported by name: the file loads at a commit without them (scripts/fails-without.ts)
const { defaultMemoryLimit, machineMemory, machineMemoryBytes, MEMORY_FLOOR_BYTES, memoryLimitBytes, memoryProblems, memoryProblemText, memoryWarning, MIN_SHARE_BYTES, OUTSIDE_RESERVE_BYTES } = storeModule as unknown as typeof import("../src/duck/store.ts");
import type { DevRun } from "../src/cli/runs.ts";
import { newConfig, type Project } from "../src/cli/project.ts";
import { ciNodeMajor, docNodeProblems, NODE_WITHOUT_THE_FIX } from "./node-versions.ts";

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
  // cli/README.md is the package's page: it says the floor where it lists what mason needs, and every other Node it
  // names is held to an authority (tests/node-versions.ts): CI's major, or one without V8's fix (issue 67)
  const ci = ciNodeMajor(root);
  const cli = docNodeProblems("cli/README.md", fs.readFileSync(path.join(root, "cli", "README.md"), "utf8"), NODE_MIN, ci);
  assert.ok(cli.floorMentions >= 3, "cli/README.md says the floor where it lists what mason needs");
  assert.deepEqual(cli.problems, []);
  // the repo's README: the package's install line says the floor; its `Node ≥ 23.6` is the checkout's, not the package's
  const src = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const install = src.split("\n").find((l) => l.startsWith("npm i -g @mason-data/cli"));
  assert.match(install ?? "", new RegExp(`needs Node ${NODE_MIN.replace(".", "\\.")}\\+ `));
  assert.deepEqual([...src.matchAll(/\bNode (\d+(?:\.\d+)*)\+/g)].map((m) => m[1]), [NODE_MIN], "every `Node <n>+` in the README");
  assert.deepEqual(docNodeProblems("README.md", src, NODE_MIN, ci).problems, []);
  // and what mason prints says it too
  assert.match(DOCTOR_USAGE, new RegExp(`Node ${NODE_MIN.replace(".", "\\.")} or later`));
});

test("the READMEs' Node guard catches the real thing: each Node a doc names is the floor, CI's, or one without the fix", () => {
  const of = (src: string) => docNodeProblems("R", src, "22.13", "26").problems;
  assert.deepEqual(of("It needs Node 22.13 or later, Node 22.13+ too. CI runs Node 26. On Node 24 it can abort."), []);
  assert.deepEqual(of("On Node 23 it can abort."), ["R:1 \"Node 23\": names a Node no authority holds (the floor 22.13, CI's 26, or one without the fix: 24)"]);
  assert.deepEqual(of("\nOn Node 25 it can abort."), ["R:2 \"Node 25\": names a Node no authority holds (the floor 22.13, CI's 26, or one without the fix: 24)"]);
  assert.deepEqual(of("It needs Node 26+."), ["R:1 \"Node 26+\": a floor is NODE_MIN (22.13, src/cli/doctor.ts)"], "CI's major is no floor");
  assert.deepEqual(of("It needs Node 24 or later."), ["R:1 \"Node 24 or later\": a floor is NODE_MIN (22.13, src/cli/doctor.ts)"]);
  assert.deepEqual(of("It needs Node 22 and up."), ["R:1 \"Node 22\": names a Node no authority holds (the floor 22.13, CI's 26, or one without the fix: 24)"], "a major alone is not the floor");
  assert.equal(docNodeProblems("R", "Node 22.13 or later; Node 22.13+; Node 22.13.", "22.13", "26").floorMentions, 3);
  // the majors without the fix are the one list, so a sentence naming Node 24 passes only through it
  assert.ok(NODE_WITHOUT_THE_FIX.has(24));
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
  assert.deepEqual(machineMemory(files({ "/sys/fs/cgroup/memory.max": `${4 * gib}` }), 32 * gib), { bytes: 4 * gib, from: "container" });
  assert.deepEqual(machineMemory(files({ "/sys/fs/cgroup/memory.max": "max\n" }), 32 * gib), { bytes: 32 * gib, from: "machine" });
});

// issue 301: the default is half, or what leaves OUTSIDE_RESERVE_BYTES beside it, never under MIN_SHARE_BYTES; under the
// floor a start goes on and warns (Tom's decision on PR 382: a warning, never a refusal)
const GIB = 1024 ** 3, MIB = 1024 ** 2;
const cgroup = (m: Record<string, string>) => (f: string): string => { if (f in m) return m[f]!; throw new Error(`ENOENT: ${f}`); };
const container = (bytes: number) => ({ bytes, from: "container" as const });

test("memory: the default limit is half, or what leaves the measured reserve beside it, in whole MiB; never under the least share, nor past half", () => {
  assert.equal(OUTSIDE_RESERVE_BYTES, 2560 * MIB, "the room measured outside the engine's limit, with its margin (docs/DESIGN.md)");
  assert.equal(MEMORY_FLOOR_BYTES, 3 * GIB, "the smallest container the whole path ran in under the default");
  assert.equal(MIN_SHARE_BYTES, 128 * MIB, "the share that let the run last longest under the floor, measured");
  // cgroup v2 memory.max, each size to its number
  const v2 = (bytes: number): string => defaultMemoryLimit(machineMemoryBytes(cgroup({ "/sys/fs/cgroup/memory.max": `${bytes}\n` }), 32 * GIB));
  assert.equal(v2(0.25 * GIB), "128MiB", "never past half");
  assert.equal(v2(1 * GIB), "128MiB", "under the floor: the least share, the most room for the rest");
  assert.equal(v2(1.5 * GIB), "128MiB");
  assert.equal(v2(2 * GIB), "128MiB");
  assert.equal(v2(2.5 * GIB), "128MiB");
  assert.equal(v2(2.625 * GIB), "128MiB", "the reserve leaves exactly the least share");
  assert.equal(v2(2.75 * GIB), "256MiB", "the reserve leaves more than it");
  assert.equal(v2(3 * GIB), "512MiB", "3 GiB less the reserve, under half");
  assert.equal(v2(4 * GIB), "1536MiB", "4 GiB less the reserve, under half");
  assert.equal(v2(5 * GIB), "2560MiB", "where the two meet");
  assert.equal(v2(8 * GIB), "4096MiB", "half again");
  for (const g of [3, 3.5, 4, 5, 6, 8, 12, 16, 64]) {
    const limit = memoryLimitBytes(v2(g * GIB));
    assert.ok(g * GIB - limit >= OUTSIDE_RESERVE_BYTES, `${g} GiB: ${limit} leaves the reserve`);
    assert.ok(limit <= g * GIB / 2, `${g} GiB: never past half`);
  }
  // cgroup v1: the same default as v2 at 2 GiB
  assert.equal(defaultMemoryLimit(machineMemoryBytes(cgroup({ "/sys/fs/cgroup/memory/memory.limit_in_bytes": `${2 * GIB}` }), 32 * GIB)), v2(2 * GIB));
  // no cgroup file: a big machine's default is still half
  for (const [g, half] of [[16, "8192MiB"], [32, "16384MiB"], [64, "32768MiB"]] as const) assert.equal(defaultMemoryLimit(machineMemoryBytes(cgroup({}), g * GIB)), half, `${g} GiB`);
});

test("memory: under the floor with MASON_DUCKDB_MEMORY unset a start is never refused; the one warning says the size, where it was read, what Mason needs and both ways out", () => {
  const at1 = machineMemory(cgroup({ "/sys/fs/cgroup/memory.max": "1073741824\n" }), 32 * GIB);
  assert.deepEqual(at1, container(GIB));
  assert.deepEqual(memoryProblems({}), [], "nothing refused");
  assert.deepEqual(memoryWarning(at1, {}), {
    message: "1.0 GiB of memory is under the 3.0 GiB Mason needs",
    why: "1.0 GiB is the container's memory limit; beside what the synced data's statements may use, Mason itself needs up to 2.5 GiB (measured, with a margin), " +
      "and with less the system may stop the whole run, every session with it, when a first sync, a burst of writes or a statement needs the memory",
    fix: "give it 3.0 GiB or more (the container's memory limit), or set MASON_DUCKDB_MEMORY=<n> to choose the statements' share yourself, the rest left to Mason (mason doctor says what it leaves)",
  });
  assert.match(memoryWarning({ bytes: 2 * GIB, from: "machine" }, {})!.why, /^2\.0 GiB is the machine's RAM; /);
  assert.equal(memoryWarning(container(MEMORY_FLOOR_BYTES), {}), null, "exactly the floor: no warning");
  assert.notEqual(memoryWarning(container(MEMORY_FLOOR_BYTES - MIB), {}), null, "a MiB under it warns");
  assert.notEqual(memoryWarning(container(GIB), { MASON_DUCKDB_MEMORY: "" }), null, "set empty is unset, as the run reads it");
  // set, it is the operator's word at any size: no warning of the floor
  assert.equal(memoryWarning(container(GIB), { MASON_DUCKDB_MEMORY: "256MiB" }), null);
  assert.equal(memoryWarning(container(2 * GIB), { MASON_DUCKDB_MEMORY: "1900MiB" }), null);
  // not an amount: refused as on main, at any size
  for (const bytes of [GIB, 32 * GIB]) assert.deepEqual(memoryProblems({ MASON_DUCKDB_MEMORY: "lots" }).map((p) => p.message), ['MASON_DUCKDB_MEMORY="lots" is not an amount of memory'], `${bytes}`);
});

test("memory: mason doctor warns under the floor in the run's own words (never a failure), says the room a set share leaves, and has no threshold of its own", () => {
  const big = memoryCheck({ bytes: 32 * GIB, from: "machine" }, {});
  assert.deepEqual(big, { name: "memory", ok: true, detail: "32.0 GiB; the engine uses up to 16384MiB (the default; MASON_DUCKDB_MEMORY sets it), leaving 16.0 GiB for Mason beside it" });
  assert.equal(memoryCheck(container(4 * GIB), {}).detail, "4.0 GiB; the engine uses up to 1536MiB (the default; MASON_DUCKDB_MEMORY sets it), leaving 2.5 GiB for Mason beside it");
  const set = memoryCheck({ bytes: 32 * GIB, from: "machine" }, { MASON_DUCKDB_MEMORY: "12GiB" });
  assert.deepEqual(set, { name: "memory", ok: true, detail: "32.0 GiB; the engine uses up to 12GiB (MASON_DUCKDB_MEMORY), leaving 20.0 GiB for Mason beside it" });
  // under the floor: a warning, ok, in the one text the run says
  for (const bytes of [GIB, 1.5 * GIB, 2 * GIB, MEMORY_FLOOR_BYTES - MIB]) {
    const c = memoryCheck(container(bytes), {});
    assert.equal(c.ok, true, `${bytes}: never a failure`);
    assert.equal(c.warn, true, `${bytes}: said loudly`);
    assert.ok(c.detail.startsWith(memoryProblemText(memoryWarning(container(bytes), {})!)), c.detail);
  }
  assert.equal(memoryCheck(container(GIB), {}).detail, `${memoryProblemText(memoryWarning(container(GIB), {})!)} (the engine uses up to 128MiB, the default, leaving 896 MiB beside it)`);
  assert.equal(verdictOf([memoryCheck(container(GIB), {})], null, null).ready, true, "a warning leaves doctor ready");
  assert.equal(memoryCheck(container(MEMORY_FLOOR_BYTES), {}).warn, undefined);
  // a share the operator set: honoured, the room it leaves said, and a warning under the reserve
  const low = memoryCheck(container(GIB), { MASON_DUCKDB_MEMORY: "256MiB" });
  assert.deepEqual([low.ok, low.warn], [true, true]);
  assert.equal(low.detail, "1.0 GiB; the engine uses up to 256MiB (MASON_DUCKDB_MEMORY), leaving 768 MiB for Mason beside it, under the 2.5 GiB it needs (measured, with a margin): " +
    "the system may stop it in a first sync, a generated table's build or a burst of writes (a smaller MASON_DUCKDB_MEMORY, or more memory)");
  const tight = memoryCheck(container(2 * GIB), { MASON_DUCKDB_MEMORY: "1900MiB" });
  assert.deepEqual([tight.ok, tight.warn], [true, true]);
  assert.match(tight.detail, /^2\.0 GiB; the engine uses up to 1900MiB \(MASON_DUCKDB_MEMORY\), leaving 148 MiB for Mason beside it, under the 2\.5 GiB it needs \(measured, with a margin\)/);
  const bad = memoryCheck({ bytes: 32 * GIB, from: "machine" }, { MASON_DUCKDB_MEMORY: "lots" });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /^MASON_DUCKDB_MEMORY="lots" is not an amount of memory: /);
  // the floor is store.ts's: doctor keeps no size of its own
  const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "doctor.ts"), "utf8");
  assert.doesNotMatch(source, /\d\s*\*\s*1024\s*\*\*\s*3|2 GiB/, "no GiB constant in doctor.ts");
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
  // where the URL really is: the sources file's variable in .env, never .mason/config.json (issue 802)
  assert.deepEqual(nextSteps([ok("node"), bad("database")], null, project, "DATABASE_URL in .env"),
    [["mason start", "once the connection works (the detail above says how; its URL: DATABASE_URL in .env)"]]);
  assert.deepEqual(nextSteps([ok("node"), bad("database")], null, project), [["mason start", "once the connection works (the detail above says how)"]]);
  // the demo database is down until its run is up: mason start is the way out, not a URL to fix
  const demoProject = { ...project, config: { ...project.config, demo: true } } as typeof project;
  assert.deepEqual(nextSteps([ok("node"), bad("database")], null, demoProject), [["mason start", "hosts the demo database, then syncs its tables"]]);
  assert.equal(first([ok("node"), ok("memory")], null, null), "mason init | mason init - < db-url.txt", "the URL on stdin, never a password on the command line");
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
  assert.match(DOCTOR_USAGE, /Mason's postgres and inet extensions/);
});
