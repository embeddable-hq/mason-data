/**
 * A RUN THAT IS ALIVE AND DOES NOT ANSWER, as the commands meet it (the test server, SIGSTOP on the run):
 * `mason status` said "not running (last ran 2 min ago)" while the run held its ports; `mason stop` killed it, and the
 * only record of that stop was the supervisor's "crash". The run here is a process that recorded its own start as a run
 * does (src/cli/runs.ts processStart, masonProcess), whatever its command line — `start --attach`, or `mason serve`'s,
 * which read as not running (issue 798) — and whose control URL answers nothing. The commands run as processes
 * (tests/cli-matrix.ts). The stop's SIGKILL after 15 s is endRun's own test (tests/cli-project.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { newConfig, readProject, writeConfig } from "../src/cli/project.ts";
import * as runs from "../src/cli/runs.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };   // ESRCH: gone
/** what a run records of its own start (read through the namespace: a tree without it still loads, and records none) */
const startOf = (pid: number): { started?: string } => {
  const s = (runs as { processStart?: (pid: number) => string | null }).processStart?.(pid) ?? null;
  return s === null ? {} : { started: s };
};

/** A project whose config names `pid` as its run (as a run writes it), last started 2 min ago; its root. */
function hungProject(pid: number, recorded: { started?: string }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-hung-"));
  fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
  const cfg = newConfig("shop", "mason", false);
  cfg.lastRun = new Date(Date.now() - 120_000).toISOString();
  cfg.running = { pid, ...recorded, controlUrl: "http://127.0.0.1:1", token: "t", postgresUrl: "postgresql://127.0.0.1:54988/shop", postgresListener: { host: "127.0.0.1", tls: null } };
  writeConfig(path.join(root, ".mason"), cfg);
  return root;
}

// every way a run is started: mason start's background run, and mason serve as the image, a checkout and npx run it
for (const [how, args] of [["mason start (--attach)", ["start", "--attach"]], ["mason serve", ["serve"]],
  ["mason serve from a checkout", ["/app/src/cli/main.ts", "serve"]], ["mason serve from the package", ["/root/.npm/_npx/0/node_modules/@mason-data/cli/dist/mason.cjs", "serve"]]] as const) {
test(`${how}: mason status says hung, and mason stop ends the run and records the stop for the next status`, async () => {
  // a run that recorded its start, leaving on SIGTERM as a run whose main thread is free would (the kill is endRun's test)
  const run = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore" });
  const root = hungProject(run.pid!, startOf(run.pid!));
  try {
    const env = matrixEnv();
    const st = await runMason(root, ["status"], env);
    assert.equal(st.code, 1, st.stderr);
    assert.match(st.stdout, /^Status: hung\n/);
    assert.match(st.stdout, new RegExp(`Mason +\\S+, pid ${run.pid} · running but does not answer its commands: a statement may be holding its main thread`));
    assert.match(st.stdout, /Postgres API +postgres:\/\/<user>:<password>@127\.0\.0\.1:54988\/shop {2}\(held by the hung run; it may not answer\)/);
    assert.doesNotMatch(st.stdout, /not running/);
    assert.match(st.stdout, /\n {2}mason stop {2}.*SIGKILL after 15 s/);
    const js = await runMason(root, ["status", "--json"], env);
    assert.equal(js.code, 1);
    const data = JSON.parse(js.stdout) as { running: boolean; hung: { pid: number; problem: string; why: string } };
    assert.equal(data.running, false);
    assert.equal(data.hung.pid, run.pid);
    assert.match(data.hung.problem, /does not answer its commands/);
    // stop: SIGTERM, the run leaves, the stop recorded (the run could not record it)
    const stop = await runMason(root, ["stop"], env);
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stderr, new RegExp(`Mason for shop \\(pid ${run.pid}\\) does not answer: stopping it \\(SIGKILL after 15 s\\)`));
    assert.match(stop.stdout, /^Stopped shop\n {2}how +it did not answer its commands and left on SIGTERM\n {2}kept +its synced data/);
    assert.equal(alive(run.pid!), false);
    const after = readProject(root);
    assert.ok(after !== null && "config" in after);
    assert.equal(after.config.running, null);
    assert.equal(after.config.lastStop?.how, "stopped by mason stop (SIGTERM): it did not answer its commands and left on SIGTERM");
    const again = await runMason(root, ["status"], env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /^Status: not running\n/);
    assert.match(again.stdout, /Mason +\S+ · not running \(last started 2 min ago; \d+s ago: stopped by mason stop \(SIGTERM\): it did not answer its commands and left on SIGTERM\)/);
  } finally {
    if (run.pid !== undefined && alive(run.pid)) run.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

test("a hung mason serve run: mason destroy removes nothing and mason start starts no second run beside it", async () => {
  const run = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "serve"], { stdio: "ignore" });
  const root = hungProject(run.pid!, startOf(run.pid!));
  const duck = path.join(root, ".mason", "duck.db");
  fs.writeFileSync(duck, "the synced data");
  try {
    const env = matrixEnv();
    const destroy = await runMason(root, ["destroy"], env);
    assert.equal(destroy.code, 1, destroy.stdout);
    assert.match(destroy.stderr, new RegExp(`Mason for shop is running \\(pid ${run.pid}\\) but does not answer its commands, so nothing was removed: mason stop ends it`));
    const plan = await runMason(root, ["destroy", "--dry-run", "--json"], env);
    assert.match(plan.stdout, /would remove nothing: mason stop ends it/);
    assert.equal(fs.readFileSync(duck, "utf8"), "the synced data");
    const start = await runMason(root, ["start", "--json"], env);
    assert.equal(start.code, 1, start.stdout);
    const refused = JSON.parse(start.stdout) as { error: { code: string; message: string } };
    assert.equal(refused.error.code, "not_answering");
    assert.match(refused.error.message, new RegExp(`^Mason for shop is running \\(pid ${run.pid}\\) but does not answer its commands`));
    assert.equal(alive(run.pid!), true, "nothing signalled it");
    assert.equal(fs.readFileSync(duck, "utf8"), "the synced data");
  } finally {
    if (run.pid !== undefined && alive(run.pid)) run.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a pid another process holds now (it started after the run recorded its start) is no run: not running, never signalled", async () => {
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "serve"], { stdio: "ignore" });
  // the start a run recorded before a reboot: never this process's
  const root = hungProject(other.pid!, { started: "linux:a-boot-before:1" });
  try {
    const env = matrixEnv();
    const st = await runMason(root, ["status", "--json"], env);
    assert.equal(st.code, 0, st.stdout);
    const data = JSON.parse(st.stdout) as { running: boolean; hung?: unknown };
    assert.equal(data.running, false);
    assert.equal(data.hung, undefined);
    const stop = await runMason(root, ["stop"], env);
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /^Mason is not running for shop\./);
    assert.equal(alive(other.pid!), true, "another process's pid is never signalled");
  } finally {
    if (other.pid !== undefined && alive(other.pid)) other.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A RECORD AN EARLIER MASON WROTE (no start: the upgrade's path) is judged at least as well as that Mason judged it
// (the review of PR 806): its run, `start --attach` or `serve`, is hung and mason stop ends it before mason destroy;
// a pid another program holds is no run
for (const [how, args] of [["mason start (--attach)", ["start", "--attach"]], ["mason serve", ["/app/src/cli/mason.cjs", "serve"]]] as const) {
test(`a run an earlier Mason recorded (${how}, no start), stopped by SIGSTOP: mason stop kills it, then mason destroy removes the synced data`, { timeout: 120_000 }, async () => {
  const run = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", ...args], { stdio: "ignore" });
  const root = hungProject(run.pid!, {});
  fs.writeFileSync(path.join(root, ".mason", "duck.db"), "the synced data");
  try {
    process.kill(run.pid!, "SIGSTOP");
    const env = matrixEnv();
    const st = await runMason(root, ["status", "--json"], env);
    assert.equal(st.code, 1, st.stdout);
    const data = JSON.parse(st.stdout) as { hung: { pid: number; problem: string; why: string } };
    assert.equal(data.hung.pid, run.pid);
    assert.match(data.hung.problem, new RegExp(`^Mason for shop is running \\(pid ${run.pid}\\) but does not answer its commands`));
    const refused = await runMason(root, ["destroy", "--json"], env);
    assert.equal(refused.code, 1, refused.stdout);
    assert.equal(fs.readFileSync(path.join(root, ".mason", "duck.db"), "utf8"), "the synced data");
    const stop = await runMason(root, ["stop", "--json"], env);
    assert.equal(stop.code, 0, stop.stdout);
    const said = JSON.parse(stop.stdout) as { stopped: string[]; killed: boolean };
    assert.deepEqual([said.stopped, said.killed], [["shop"], true]);
    assert.equal(alive(run.pid!), false, "the run is gone before anything is removed");
    const destroy = await runMason(root, ["destroy", "--json"], env);
    assert.equal(destroy.code, 0, destroy.stdout);
    assert.equal(fs.existsSync(path.join(root, ".mason", "duck.db")), false);
  } finally {
    if (run.pid !== undefined && alive(run.pid)) run.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

test("a record an earlier Mason wrote (no start) whose pid another program holds now: not running, and start and destroy go on", async () => {
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const root = hungProject(other.pid!, {});
  try {
    const env = matrixEnv();
    const st = await runMason(root, ["status", "--json"], env);
    assert.equal(st.code, 0, st.stdout);
    const data = JSON.parse(st.stdout) as { running: boolean; hung?: unknown };
    assert.equal(data.running, false);
    assert.equal(data.hung, undefined);
    // the project has nothing to start (no sources file): start fails on that, never on the pid
    const start = await runMason(root, ["start", "--json"], env);
    assert.doesNotMatch(start.stdout, /not_answering/);
    const destroy = await runMason(root, ["destroy", "--json"], env);
    assert.equal(destroy.code, 0, destroy.stdout);
    assert.equal(alive(other.pid!), true, "another program's pid is never signalled");
  } finally {
    if (other.pid !== undefined && alive(other.pid)) other.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
