/**
 * scripts/worktree-lock.ts, the lock scripts/fails-without.ts holds around each `git worktree` call (issue 792): one
 * holder at a time, never two, when a holder was killed inside it and several runs waiting take its lock over at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "worktree-lock.ts");
const WORKERS = 10, ROUNDS = 40, PERIOD_MS = 250;

/**
 * A worker, in rounds: before each, worker 0 has a run take the lock and be killed inside it (a stale lock); at the
 * round's instant every worker asks for the lock at once, and holds it making a marker `wx`, which a second holder
 * cannot make.
 */
const WORKER = `
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { underLock } from ${JSON.stringify(MODULE)};
const [lock, marker, doubles, t0, idx] = process.argv.slice(2);
const sleepUntil = (at) => { const ms = at - Date.now() - 2; if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); while (Date.now() < at) {} };
const victim = \`import { underLock } from \${JSON.stringify(${JSON.stringify(MODULE)})}; underLock(\${JSON.stringify(lock)}, () => process.kill(process.pid, "SIGKILL"));\`;
for (let k = 0; k < ${ROUNDS}; k++) {
  const at = Number(t0) + k * ${PERIOD_MS};
  if (idx === "0") {
    sleepUntil(at - ${PERIOD_MS} / 2);
    const v = spawnSync(process.execPath, ["--input-type=module", "-e", victim]);
    if (v.signal !== "SIGKILL") throw new Error("the run was not killed inside the lock: " + v.stderr);
  }
  sleepUntil(at);
  underLock(lock, () => {
    try { fs.writeFileSync(marker, String(process.pid), { flag: "wx" }); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      fs.appendFileSync(doubles, \`round \${k}: \${process.pid} entered while \${fs.readFileSync(marker, "utf8")} held it\\n\`);
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    fs.unlinkSync(marker);
  }, { waitMs: 30_000 });
}
`;

test("one holder at a time, never two, while several runs at once take over the lock of a holder killed inside it", async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktree-lock-test-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worker = path.join(dir, "worker.mjs");
  fs.writeFileSync(worker, WORKER);
  const lock = path.join(dir, "the.lock"), marker = path.join(dir, "marker"), doubles = path.join(dir, "doubles");
  fs.writeFileSync(doubles, "");
  const t0 = Date.now() + 2000; // every worker started and waiting before the first round
  const runs = await Promise.all(Array.from({ length: WORKERS }, (_, i) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const c = spawn(process.execPath, [worker, lock, marker, doubles, String(t0), String(i)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("close", (code) => resolve({ code, out }));
  })));
  assert.equal(fs.readFileSync(doubles, "utf8"), "", "two held the lock at once");
  for (const r of runs) assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(marker), false);
  // free: gone, or (this lock's form) an empty folder; and no run left anything of its own beside it
  assert.ok(!fs.existsSync(lock) || fs.readdirSync(lock).length === 0, "the lock is free");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== "the.lock").sort(), ["doubles", "worker.mjs"]);
});
