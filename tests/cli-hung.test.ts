/**
 * A RUN THAT IS ALIVE AND DOES NOT ANSWER, as the commands meet it (the test server, SIGSTOP on the run):
 * `mason status` said "not running (last ran 2 min ago)" while the run held its ports; `mason stop` killed it, and the
 * only record of that stop was the supervisor's "crash". The run here is a node process started with a Mason entry's
 * arguments (`<dir>/src/cli/mason.cjs serve`, …: a file of this test's that waits), that recorded its own start as a run
 * does (src/cli/runs.ts processStart, masonProcess) or, as an earlier Mason's record, none — `start --attach`, or `mason
 * serve`'s, which read as not running (issue 798) — and whose control URL answers nothing. The commands run as
 * processes (tests/cli-matrix.ts). The stop's SIGKILL after 15 s is endRun's own test (tests/cli-project.test.ts).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { newConfig, readProject, writeConfig } from "../src/cli/project.ts";
import * as runs from "../src/cli/runs.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };   // ESRCH: gone
/** what a run records of its own start (read through the namespace: a tree without it still loads, and records none) */
const startOf = (pid: number): { started?: string } => {
  const s = (runs as { processStart?: (pid: number) => string | null }).processStart?.(pid) ?? null;
  return s === null ? {} : { started: s };
};

const ENTRIES = fs.mkdtempSync(path.join(os.tmpdir(), "mason-hung-entries-"));
after(() => fs.rmSync(ENTRIES, { recursive: true, force: true }));
/** A node process whose arguments are `node <ENTRIES>/<entry> ...args`, as a run's are (its node named `argv0` when
 *  given, as a binary of another name is); it waits until killed. */
function fakeRun(entry: string, args: readonly string[], argv0?: string): ReturnType<typeof spawn> {
  const file = path.join(ENTRIES, entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "setInterval(() => {}, 1000);\n");
  return spawn(process.execPath, [file, ...args], { stdio: "ignore", ...(argv0 === undefined ? {} : { argv0 }) });
}
/** A process that is no run, named `argv0`, its arguments `args` (after node's own -e and --): another program's pid */
const otherProgram = (argv0: string, args: readonly string[]): ReturnType<typeof spawn> =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { stdio: "ignore", argv0 });

/** The environment of a mason whose src/cli/runs.ts alone sees `platform` (the rest still loads this machine's engine). */
function seenAs(platform: string, extra: Record<string, string> = {}): Record<string, string> {
  const preload = path.join(ENTRIES, `${platform}.mjs`);
  fs.writeFileSync(preload, `const real = process.platform;
Object.defineProperty(process, "platform", { get: () => /src[\\\\/]cli[\\\\/]runs\\.ts/.test(new Error().stack ?? "") ? ${JSON.stringify(platform)} : real });
`);
  return matrixEnv({ NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, ...extra });
}

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
const WAYS = [["mason start (--attach)", "src/cli/mason.cjs", ["start", "--attach"]], ["mason serve in the image", "src/cli/mason.cjs", ["serve"]],
  ["mason serve from a checkout", "src/cli/main.ts", ["serve"]], ["mason serve from the package", "dist/src/cli/main.js", ["serve"]], ["mason serve on the PATH", "bin/mason", ["serve"]]] as const;
for (const [how, entry, args] of WAYS) {
test(`${how}: mason status says hung, and mason stop ends the run and records the stop for the next status`, async () => {
  // a run that recorded its start, leaving on SIGTERM as a run whose main thread is free would (the kill is endRun's test)
  const run = fakeRun(entry, args);
  const root = hungProject(run.pid!, startOf(run.pid!));
  try {
    const env = matrixEnv();
    const st = await runMason(root, ["status"], env);
    assert.equal(st.code, 1, st.stderr);
    assert.match(st.stdout, /^Status: hung\n/);
    assert.match(st.stdout, new RegExp(`Version +\\S+\\n {2}Up +pid ${run.pid} · running but does not answer its commands: a statement may be holding its main thread`));
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
    assert.match(again.stdout, /Version +\S+\n {2}Up +not running \(last started 2 min ago; \d+s ago: stopped by mason stop \(SIGTERM\): it did not answer its commands and left on SIGTERM\)/);
  } finally {
    if (run.pid !== undefined && alive(run.pid)) run.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

test("a hung mason serve run: mason destroy removes nothing and mason start starts no second run beside it", async () => {
  const run = fakeRun("src/cli/mason.cjs", ["serve"]);
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
  const other = fakeRun("src/cli/mason.cjs", ["serve"]);
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

// A RECORD AN EARLIER MASON WROTE (no start: the upgrade's path) is judged EXACTLY as that Mason judged it (the
// reviews of PR 806: a narrower reading let mason destroy delete the synced data under a live run), by ps's command
// line and `start … --attach`: its background run is hung, whatever its node is named or wherever it lives, mason stop
// ends it, and only then does mason destroy remove the synced data
for (const [how, entry, argv0, platform] of [["as an earlier mason start ran it", "src/cli/mason.cjs", undefined, null],
  ["its node binary named node-26", "src/cli/mason.cjs", "node-26", null],
  ["from a folder with a space, read through ps as on macOS", "main sp/src/cli/mason.cjs", undefined, "darwin"]] as const) {
test(`a run an earlier Mason recorded (no start), ${how}, stopped by SIGSTOP: hung, mason stop kills it, then mason destroy removes the synced data`, { timeout: 120_000 }, async () => {
  const run = fakeRun(entry, ["start", "--attach"], argv0);
  const root = hungProject(run.pid!, {});
  fs.writeFileSync(path.join(root, ".mason", "duck.db"), "the synced data");
  try {
    process.kill(run.pid!, "SIGSTOP");
    const env = platform === null ? matrixEnv() : seenAs(platform);
    const st = await runMason(root, ["status", "--json"], env);
    assert.equal(st.code, 1, st.stdout + st.stderr);
    const data = JSON.parse(st.stdout) as { hung: { pid: number; problem: string; why: string } };
    assert.equal(data.hung.pid, run.pid);
    assert.match(data.hung.problem, new RegExp(`^Mason for shop is running \\(pid ${run.pid}\\) but does not answer its commands`));
    const refused = await runMason(root, ["destroy", "--json"], env);
    assert.equal(refused.code, 1, refused.stdout);
    assert.equal(fs.readFileSync(path.join(root, ".mason", "duck.db"), "utf8"), "the synced data");
    const stop = await runMason(root, ["stop", "--json"], env);
    assert.equal(stop.code, 0, stop.stdout + stop.stderr);
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

test("a mason serve an earlier Mason recorded (no start) reads as that Mason reads it: not running (the release note says so)", async () => {
  const run = fakeRun("src/cli/mason.cjs", ["serve"]);
  const root = hungProject(run.pid!, {});
  try {
    const st = await runMason(root, ["status", "--json"], matrixEnv());
    assert.equal(st.code, 0, st.stdout);
    assert.equal((JSON.parse(st.stdout) as { hung?: unknown }).hung, undefined);
  } finally {
    if (run.pid !== undefined && alive(run.pid)) run.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a record an earlier Mason wrote (no start) whose pid another program holds now: not running, and start and destroy go on", async () => {
  const other = otherProgram("node", []);
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

// A PROGRAM THAT IS NOT MASON whose command line holds Mason's words (B4, the review of PR 806: the words joined by
// spaces read as a serve, and mason stop SIGTERMed a tail): it is no run, and nothing signals it
for (const [argv0, args] of [["tail", ["-f", "mason serve notes.txt"]], ["vim", ["mason serve notes"]], ["grep", ["-r", "mason serve", "."]],
  ["docker", ["compose", "exec", "mason", "mason", "serve"]]] as const) {
test(`a record with no start whose pid is \`${argv0} ${args.join(" ")}\`: not running, and mason stop signals nothing`, async () => {
  const other = otherProgram(argv0, args);
  const root = hungProject(other.pid!, {});
  try {
    const env = matrixEnv();
    const st = await runMason(root, ["status", "--json"], env);
    assert.equal(st.code, 0, st.stdout);
    assert.equal((JSON.parse(st.stdout) as { hung?: unknown }).hung, undefined);
    const stop = await runMason(root, ["stop", "--json"], env);
    assert.equal(stop.code, 0, stop.stdout);
    assert.deepEqual((JSON.parse(stop.stdout) as { stopped: string[] }).stopped, []);
    assert.equal(alive(other.pid!), true, "another program is never signalled");
  } finally {
    if (other.pid !== undefined && alive(other.pid)) other.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
}

// WHERE NOTHING CAN BE READ (B3, the review of PR 806: every command refused, the way out an edit of the config):
// Windows, which has neither /proc nor ps — as the earlier check read it, no run
test("on Windows (no /proc, no ps), a record with no start whose pid is another program: not running, stop stops nothing, destroy goes on", async () => {
  const other = otherProgram("node", []);
  const root = hungProject(other.pid!, {});
  try {
    const env = seenAs("win32", { PATH: path.dirname(process.execPath) });
    const st = await runMason(root, ["status", "--json"], env);
    assert.equal(st.code, 0, st.stdout + st.stderr);
    assert.equal((JSON.parse(st.stdout) as { hung?: unknown }).hung, undefined);
    const stop = await runMason(root, ["stop", "--json"], env);
    assert.equal(stop.code, 0, stop.stdout);
    assert.deepEqual((JSON.parse(stop.stdout) as { stopped: string[] }).stopped, []);
    const start = await runMason(root, ["start", "--json"], env);
    assert.doesNotMatch(start.stdout, /not_answering/);
    const destroy = await runMason(root, ["destroy", "--json"], env);
    assert.equal(destroy.code, 0, destroy.stdout);
    assert.equal(alive(other.pid!), true);
  } finally {
    if (other.pid !== undefined && alive(other.pid)) other.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a recorded start this system cannot read now (hidepid, Windows): the earlier check decides, as it did before", () => {
  type Read = { start: (pid: number) => string | null; earlier: (pid: number) => boolean };
  const isMason = runs.masonProcess as (pid: number, started: string | null, read: Read) => unknown;
  assert.equal(isMason(process.pid, "linux:a-boot:1", { start: () => null, earlier: () => false }), false);
  assert.equal(isMason(process.pid, "linux:a-boot:1", { start: () => null, earlier: () => true }), true);
});
