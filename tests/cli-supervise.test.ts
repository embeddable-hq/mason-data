/**
 * THE RUN'S SUPERVISOR (src/cli/supervise.ts): a run that dies once it was ready is started again, on the same Postgres
 * port, the restart said in the log and recorded for mason status; a start that fails, a stop, and a signal to the
 * supervisor are never undone. The supervisor runs as `mason start` starts it, over a fake run: a script that does what
 * the run does at its edges (records `running` in the config, prints the ready line, records `running: null` on SIGTERM)
 * and dies as asked.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPERVISE = path.join(ROOT, "src", "cli", "supervise.ts");
const PG_URL = "postgresql://127.0.0.1:54987/sup";

/**
 * NO WAIT HERE IS UNBOUNDED, AND NO FAILED TEST LEAVES A PROCESS BEHIND (CI hung 30 minutes in this file: a test raced
 * the supervisor's one-second wait before a restart, lost it under load, and waited for good on a supervisor that waited
 * on a run that never ends — and a supervisor or a run left alive holds this file's process open, so a failure was a
 * hang too, with no test named). Every wait is bounded and fails by name (`until`, `exitOf`, each test's `timeout`), and
 * `after` ends every supervisor and fake run this file started that is still alive — by its pid, checked to be ours.
 */
const made: string[] = [];
const supervisors: ChildProcess[] = [];
after(() => {
  const left: string[] = [];
  for (const c of supervisors) if (c.exitCode === null && c.signalCode === null) { left.push(`supervisor ${c.pid}`); c.kill("SIGKILL"); }
  for (const d of made) {
    const pids = path.join(d, ".mason", "pids");
    for (const pid of fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []) {
      // checked: a fake run of this file's (its command line names the project's fake), never a pid reused since
      const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      if (ps.status === 0 && ps.stdout.includes(path.join(d, "fake-run.mjs"))) { left.push(`run ${pid}`); process.kill(pid, "SIGKILL"); }
    }
  }
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  // said, never silent: a test that left one running failed on its own bound already, and this names what it left
  if (left.length > 0) process.stderr.write(`cli-supervise: ended what a failed test left running: ${left.join(", ")}\n`);
});

/** the fake run: argv <home> <mode>; each start counted in <home>/starts, the MASON_PG_PORT it was given in <home>/ports,
 *  its pid in <home>/pids (what `after` ends, should a test fail with it running). The config is written whole (a
 *  rename), so the test's reads of it never meet half a file */
const FAKE_RUN = `
import * as fs from "node:fs";
import * as path from "node:path";
const [home, mode] = process.argv.slice(2);
fs.appendFileSync(path.join(home, "pids"), process.pid + "\\n");
const starts = path.join(home, "starts");
const n = (fs.existsSync(starts) ? Number(fs.readFileSync(starts, "utf8")) : 0) + 1;
fs.writeFileSync(starts, String(n));
fs.appendFileSync(path.join(home, "ports"), (process.env.MASON_PG_PORT ?? "-") + "\\n");
if (mode === "fail") { process.stderr.write("mason start: the database refused the password\\n"); process.exit(3); }
const file = path.join(home, "config.json");
const write = (c) => { fs.writeFileSync(file + ".tmp", JSON.stringify(c)); fs.renameSync(file + ".tmp", file); };
const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
cfg.running = { pid: process.pid, apiUrl: "", controlUrl: "http://127.0.0.1:1", token: "t", webUiUrl: "", postgresUrl: "${PG_URL}" };
write(cfg);
// the handler before the ready line, as the run's own: a SIGTERM the test sends on reading the line never finds none
process.on("SIGTERM", () => { cfg.running = null; write(cfg); process.exit(0); });
process.stdout.write("mason start: ready\\n");
const heap = () => { process.stderr.write("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n"); process.exit(134); };
if ((mode === "crash-once" && n === 1) || mode === "crash-always") setTimeout(heap, 30);
else if (mode === "killed-once" && n === 1) setTimeout(() => process.kill(process.pid, "SIGKILL"), 30);
else if (mode === "hang") { process.removeAllListeners("SIGTERM"); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }   // a blocked main thread: SIGTERM never acted on
else setInterval(() => {}, 1000);
`;

function project(): { home: string; log: string; fake: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-supervise-"));
  made.push(root);
  const home = path.join(root, ".mason");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ name: "sup", running: null }));
  const fake = path.join(root, "fake-run.mjs");
  fs.writeFileSync(fake, FAKE_RUN);
  return { home, log: path.join(home, "dev.log"), fake };
}

/** a supervisor over the fake run, as `mason start` starts one; `script`, a stand-in for supervise.ts (`slowSupervisor`) */
function supervisor(p: { home: string; log: string; fake: string }, mode: string, script = SUPERVISE): { child: ChildProcess; exit: Promise<number | null> } {
  const env = { ...process.env };
  delete env.MASON_PG_PORT;
  const child = spawn(process.execPath, [script, p.home, p.log, process.execPath, p.fake, p.home, mode], { stdio: "ignore", env });
  supervisors.push(child);
  return { child, exit: new Promise((r) => child.once("exit", (code) => r(code))) };
}

/** the supervisor's exit code, or a failure naming what it still waits on once `ms` passed */
async function exitOf(s: { child: ChildProcess; exit: Promise<number | null> }, home: string, ms = 15_000): Promise<number | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), ms); });
  try {
    const got = await Promise.race([s.exit, late]);
    if (got !== "late") return got;
  } finally { clearTimeout(timer); }
  throw new Error(`the supervisor (pid ${s.child.pid}) did not exit within ${ms / 1000} s; the config names the run ${runningPid(home) ?? "none"}, ` +
    `and it started ${startsOf(home)} run(s) — a supervisor exits only once its run does (the file's after-hook ends both)`);
}

/**
 * THE SUPERVISOR, ITS WAIT BEFORE A RESTART MADE A MINUTE LONG: a test that must act DURING that wait (a stop) otherwise
 * races its one second, and on a loaded machine lost it. supervise.ts's own `supervise()`, its signals and its record,
 * with only the wait changed; its name ends in supervise.js, so ps knows it for a supervisor (`isSupervisorCommand`).
 */
function slowSupervisor(p: { home: string }): string {
  const file = path.join(path.dirname(p.home), "slow-supervise.js");
  fs.writeFileSync(file, `
    import { spawn } from "node:child_process";
    const { supervise } = await import(${JSON.stringify(SUPERVISE)});
    const [home, logFile, command, ...args] = process.argv.slice(2);
    const timers = new Set();
    const sleep = () => new Promise((r) => { const t = setTimeout(() => { timers.delete(t); r(); }, 60_000); timers.add(t); });
    process.exitCode = await supervise({ home, logFile, sleep, start: (env, fd) => spawn(command, args, { stdio: ["ignore", fd, fd], env: { ...process.env, ...env } }) });
    for (const t of timers) clearTimeout(t);
  `);
  return file;
}

const startsOf = (home: string): number => fs.existsSync(path.join(home, "starts")) ? Number(fs.readFileSync(path.join(home, "starts"), "utf8")) : 0;
const runningPid = (home: string): number | null =>
  (JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as { running: { pid: number } | null }).running?.pid ?? null;

async function until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };   // ESRCH: gone

test("a run that dies once it was ready is started again, on its Postgres port, and the restart is said and recorded", { timeout: 60_000 }, async () => {
  const p = project();
  const s = supervisor(p, "crash-once");
  await until("the second start", () => startsOf(p.home) === 2 && runningPid(p.home) !== null && fs.readFileSync(path.join(p.home, "ports"), "utf8").split("\n").length === 3);
  const ports = fs.readFileSync(path.join(p.home, "ports"), "utf8").trim().split("\n");
  assert.deepEqual(ports, ["-", "54987"], "the first start chose its port; the second is given the same one");
  const restarts = JSON.parse(fs.readFileSync(path.join(p.home, "restarts.json"), "utf8")) as { restarts: Array<{ reason: string; upSeconds: number; at: string }> };
  assert.equal(restarts.restarts.length, 1);
  assert.equal(restarts.restarts[0]!.reason, "it ran out of JavaScript heap (V8: heap out of memory)");
  assert.match(fs.readFileSync(p.log, "utf8"), /mason supervisor: the run stopped \(it ran out of JavaScript heap \(V8: heap out of memory\)\) after \d+ s: starting it again in 1 s/);
  // mason stop: SIGTERM to the run the config names; it records running: null and exits 0, and nothing starts it again
  await until("the restarted run's ready line", () => fs.readFileSync(p.log, "utf8").split("mason start: ready").length === 3);
  process.kill(runningPid(p.home)!, "SIGTERM");
  assert.equal(await exitOf(s, p.home), 0);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(startsOf(p.home), 2, "a stop is never undone");
});

test("a stop BETWEEN restarts stops the supervisor: the dead run is not started again (the Fable review of #517)", { timeout: 60_000 }, async () => {
  const { stopSupervisor, supervisorOf, SUPERVISOR_FILE } = await import(SUPERVISE) as typeof import("../src/cli/supervise.ts");
  const p = project();
  const s = supervisor(p, "crash-once", slowSupervisor(p));
  // the run is dead and the supervisor waits before starting it again: what mason stop meets then
  await until("the wait before the restart", () => fs.existsSync(p.log) && /starting it again in 1 s/.test(fs.readFileSync(p.log, "utf8")));
  assert.equal(supervisorOf(p.home), s.child.pid, "the supervisor recorded its pid, and ps says it is one");
  assert.equal(await stopSupervisor(p.home), s.child.pid);
  assert.equal(await exitOf(s, p.home), 134, "the dead run's own exit code");
  await new Promise((r) => setTimeout(r, 1_500));
  assert.equal(startsOf(p.home), 1, "nothing was started after the stop");
  assert.ok(!fs.existsSync(path.join(p.home, SUPERVISOR_FILE)), "its record went with it");
  assert.equal(await stopSupervisor(p.home), null, "a second stop finds no supervisor");
});

test("a config cleared while the supervisor waits (mason destroy) is read again: the run is not started over it", { timeout: 60_000 }, async () => {
  // the clear lands INSIDE the wait, by construction (`sleep`): racing the real one-second wait, a loaded CI runner
  // lost it — the run started again, the clear went under it, and the test waited on that run for 30 minutes
  const { supervise } = await import(SUPERVISE) as typeof import("../src/cli/supervise.ts");
  const p = project();
  const waits: number[] = [];
  const code = await supervise({ home: p.home, logFile: p.log,
    sleep: async (ms) => { waits.push(ms); fs.writeFileSync(path.join(p.home, "config.json"), JSON.stringify({ name: "sup", running: null })); },
    start: (_env, fd) => spawn(process.execPath, [p.fake, p.home, "crash-once"], { stdio: ["ignore", fd, fd] }) });
  assert.deepEqual(waits, [1_000], "it waited once, before the restart the clear calls off");
  assert.equal(code, 134);
  assert.equal(startsOf(p.home), 1);
});

test("a supervisor is known by its command line under the checkout's name and the package's (supervise.js)", async () => {
  // the test server: the packaged CLI runs the supervisor as dist/src/cli/supervise.js (cli/build.ts), and
  // known by `.ts` alone no packaged mason stop found it, so its SIGKILL was recorded as a crash ("often the system
  // out of memory"). A process whose command line is the package's is a supervisor to supervisorOf.
  const { isSupervisorCommand, supervisorOf, SUPERVISOR_FILE } = await import(SUPERVISE) as typeof import("../src/cli/supervise.ts");
  assert.equal(isSupervisorCommand(`${process.execPath} /home/me/mason/src/cli/supervise.ts /app/.mason /app/.mason/dev.log ${process.execPath} /home/me/mason/src/cli/main.ts start --attach`), true);
  assert.equal(isSupervisorCommand(`${process.execPath} /usr/local/lib/node_modules/@mason-data/cli/dist/src/cli/supervise.js /app/.mason /app/.mason/dev.log ${process.execPath} /usr/local/lib/node_modules/@mason-data/cli/dist/src/cli/main.js start --attach`), true);
  assert.equal(isSupervisorCommand(`${process.execPath} /usr/local/lib/node_modules/@mason-data/cli/dist/src/cli/main.js start --attach`), false, "the run itself");
  assert.equal(isSupervisorCommand("supervise.tsx"), false);
  const p = project();
  const fake = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "dist/src/cli/supervise.js", p.home], { stdio: "ignore" });
  try {
    await until("the fake's start", () => alive(fake.pid!));
    fs.writeFileSync(path.join(p.home, SUPERVISOR_FILE), JSON.stringify({ pid: fake.pid }));
    assert.equal(supervisorOf(p.home), fake.pid, "ps names supervise.js on its command line");
  } finally { fake.kill("SIGKILL"); }
});

test("mason stop of a HUNG run: the supervisor is told first, the run ended, and the supervisor records no crash and starts nothing", { timeout: 60_000 }, async () => {
  // the test server (SIGSTOP on the run): stop killed the run and the supervisor counted it as a crash,
  // "it was killed (SIGKILL: often the system out of memory)". The supervisor waits for the run, so stop cannot wait for
  // the supervisor first: it signals it (stopping), ends the run (endRun), then waits for it to leave (supervisorGone).
  const { signalSupervisor, supervisorGone, supervisorOf, RESTARTS_FILE, SUPERVISOR_FILE } = await import(SUPERVISE) as typeof import("../src/cli/supervise.ts");
  const { endRun } = await import("../src/cli/runs.ts");
  const p = project();
  const s = supervisor(p, "hang");
  await until("the ready line", () => fs.existsSync(p.log) && /mason start: ready/.test(fs.readFileSync(p.log, "utf8")) && runningPid(p.home) !== null);
  const run = runningPid(p.home)!;
  try {
    assert.equal(signalSupervisor(p.home), s.child.pid);
    assert.equal(supervisorOf(p.home), s.child.pid, "still there: it waits for the run, which ignores SIGTERM");
    assert.deepEqual(await endRun(run, { graceMs: 500 }), { killed: true }, "SIGTERM ignored for the grace, then SIGKILL");
    await supervisorGone(p.home, s.child.pid!);
    assert.equal(await exitOf(s, p.home), 1, "the supervisor's exit is the run's: killed, no code");
    assert.equal(startsOf(p.home), 1, "nothing was started after the stop");
    assert.ok(!fs.existsSync(path.join(p.home, RESTARTS_FILE)), "a stop is not a restart: nothing recorded");
    assert.doesNotMatch(fs.readFileSync(p.log, "utf8"), /the run stopped|starting it again|out of memory/, "and not a crash in the log");
    assert.ok(!fs.existsSync(path.join(p.home, SUPERVISOR_FILE)), "its record went with it");
  } finally {
    // a run that ignores SIGTERM outlives a failed test, and with it the supervisor and this test process (a child
    // process holds the event loop): ended here, whatever the verdict
    if (alive(run)) process.kill(run, "SIGKILL");
  }
});

test("a pid in supervisor.json that is no supervisor is never signalled", async () => {
  const { supervisorOf, SUPERVISOR_FILE } = await import(SUPERVISE) as typeof import("../src/cli/supervise.ts");
  const p = project();
  fs.writeFileSync(path.join(p.home, SUPERVISOR_FILE), JSON.stringify({ pid: process.pid }));
  assert.equal(supervisorOf(p.home), null, "this test's own process is alive, and is not a supervisor");
  fs.writeFileSync(path.join(p.home, SUPERVISOR_FILE), "{not json");
  assert.equal(supervisorOf(p.home), null);
});

test("a restarts file that cannot be read never costs the run its restart: said, and written again", { timeout: 60_000 }, async () => {
  const p = project();
  fs.writeFileSync(path.join(p.home, "restarts.json"), "{\"restarts\": [");
  const s = supervisor(p, "crash-once");
  // its ready line, not only its record: the SIGTERM below must find its handler (the record is written before it)
  await until("the restarted run's ready line", () => startsOf(p.home) === 2 && fs.readFileSync(p.log, "utf8").split("mason start: ready").length === 3);
  assert.match(fs.readFileSync(p.log, "utf8"), /mason supervisor: restarts\.json could not be read \(.*\): it is written again from this restart/);
  const restarts = JSON.parse(fs.readFileSync(path.join(p.home, "restarts.json"), "utf8")) as { restarts: unknown[] };
  assert.equal(restarts.restarts.length, 1);
  s.child.kill("SIGTERM");
  assert.equal(await exitOf(s, p.home), 0);
});

test("a start that fails before it is ready is not started again: the supervisor exits with the run's own code", { timeout: 60_000 }, async () => {
  const p = project();
  const s = supervisor(p, "fail");
  assert.equal(await exitOf(s, p.home), 3);
  assert.equal(startsOf(p.home), 1);
  assert.ok(!fs.existsSync(path.join(p.home, "restarts.json")));
  assert.match(fs.readFileSync(p.log, "utf8"), /the database refused the password/, "the run's own words reach the log, as before");
});

test("a run killed by SIGKILL is started again with that reason; a signal to the supervisor goes to the run, and ends it", { timeout: 60_000 }, async () => {
  const p = project();
  const s = supervisor(p, "killed-once");
  await until("the second start", () => startsOf(p.home) === 2 && runningPid(p.home) !== null);
  const restarts = JSON.parse(fs.readFileSync(path.join(p.home, "restarts.json"), "utf8")) as { restarts: Array<{ reason: string }> };
  assert.equal(restarts.restarts[0]!.reason, "it was killed (SIGKILL: often the system out of memory)");
  await until("the restarted run's ready line", () => fs.readFileSync(p.log, "utf8").split("mason start: ready").length === 3);
  const pid = runningPid(p.home)!;
  s.child.kill("SIGTERM");
  assert.equal(await exitOf(s, p.home), 0);
  await until("the run to be gone", () => !alive(pid), 5_000);
  assert.equal(startsOf(p.home), 2);
});

test("a run that keeps dying is given up on after RESTART_LIMIT restarts in the window, and that is said", { timeout: 60_000 }, async () => {
  const { supervise, RESTART_LIMIT } = await import(SUPERVISE) as typeof import("../src/cli/supervise.ts");
  const p = project();
  const waits: number[] = [];
  const code = await supervise({ home: p.home, logFile: p.log, sleep: async (ms) => { waits.push(ms); },
    start: (_env, fd) => spawn(process.execPath, [p.fake, p.home, "crash-always"], { stdio: ["ignore", fd, fd] }) });
  assert.equal(code, 134, "the last run's exit code");
  assert.equal(startsOf(p.home), RESTART_LIMIT + 1);
  assert.deepEqual(waits, [1_000, 2_000, 5_000, 15_000, 30_000], "each restart waits longer than the one before");
  assert.match(fs.readFileSync(p.log, "utf8"), new RegExp(`its ${RESTART_LIMIT + 1}th crash in 10 minutes: not restarting again`));
});

test("mason status says the restarts: how many, and the last one's reason", async () => {
  const p = project();
  const root = path.dirname(p.home);
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  fs.mkdirSync(path.join(root, "mason", "queries"), { recursive: true });
  fs.writeFileSync(path.join(p.home, "config.json"), JSON.stringify({ name: "sup", source: "postgres://mason:secret@127.0.0.1:1/shop", folder: "mason", remote: false,
    apiKey: "k".repeat(48), sourceServer: null, running: null, lastRun: null }), { mode: 0o600 });
  fs.writeFileSync(path.join(p.home, "duck.db"), "");
  const at = new Date(Date.now() - 5 * 60_000).toISOString();
  fs.writeFileSync(path.join(p.home, "restarts.json"), JSON.stringify({ restarts: [
    { at, reason: "it was killed (SIGKILL: often the system out of memory)", upSeconds: 40 },
    { at, reason: "it ran out of JavaScript heap (V8: heap out of memory)", upSeconds: 120 },
  ] }));
  const human = await runMason(root, ["status"], matrixEnv());
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Restarts\s+2, the last 5 min(utes)? ago: it ran out of JavaScript heap \(V8: heap out of memory\), after 120 s up/);
  const json = await runMason(root, ["status", "--json"], matrixEnv());
  assert.equal(json.code, 0, json.stderr);
  const body = JSON.parse(json.stdout) as { engine: { restarts: unknown } };
  assert.deepEqual(body.engine.restarts, { count: 2, last: { at, why: "it ran out of JavaScript heap (V8: heap out of memory)", upSeconds: 120 } },
    "the one fact the run's /api/state says too (src/cli/supervise.ts restartsFact)");
});
