/**
 * A RUN THAT IS ALIVE AND DOES NOT ANSWER, as the commands meet it (the test server, SIGSTOP on the run):
 * `mason status` said "not running (last ran 2 min ago)" while the run held its ports; `mason stop` killed it, and the
 * only record of that stop was the supervisor's "crash". The run here is a process whose command line is a run's
 * (`… start --attach`, src/cli/runs.ts masonProcess) and whose control URL answers nothing. The commands run as
 * processes (tests/cli-matrix.ts). The stop's SIGKILL after 15 s is endRun's own test (tests/cli-project.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { newConfig, readProject, writeConfig } from "../src/cli/project.ts";
import { matrixEnv, runMason } from "./cli-matrix.ts";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };   // ESRCH: gone

test("mason status says hung, and mason stop ends the run and records the stop for the next status", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mason-hung-"));
  // a run by its command line, leaving on SIGTERM as a run whose main thread is free would (the kill is endRun's test)
  const run = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "start", "--attach"], { stdio: "ignore" });
  try {
    fs.mkdirSync(path.join(root, "mason", "sources"), { recursive: true });
    const cfg = newConfig("shop", "mason", false);
    cfg.lastRun = new Date(Date.now() - 120_000).toISOString();
    cfg.running = { pid: run.pid!, controlUrl: "http://127.0.0.1:1", token: "t", postgresUrl: "postgresql://127.0.0.1:54988/shop", postgresListener: { host: "127.0.0.1", tls: null } };
    writeConfig(path.join(root, ".mason"), cfg);
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
    assert.match(stop.stdout, /^Stopped shop\n {2}how +it did not answer its commands and left on SIGTERM\n {2}kept +its copy of the data/);
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
