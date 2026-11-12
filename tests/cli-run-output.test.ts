/**
 * WHAT THE RUN WRITES ON A DISK THAT FILLS (src/cli/run-output.ts, issue 847): the run's log stream and its terminal
 * (dev.log under its supervisor) met ENOSPC as an unhandled 'error', and the run died — once with a native abort. Here
 * the log fails (a stream that fails as a full disk's does, and the real /dev/full on Linux) and the terminal is
 * /dev/full: each failure is said once with the way out, the run goes on, and the log is written again once there is
 * room, saying what it missed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { RunLog } from "../src/cli/run-output.ts";
import { DISK_WAY_OUT } from "../src/lib/disk-full.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enospc = (): Error => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
/** Linux's device whose every write fails with ENOSPC: a full disk, for real; absent elsewhere, so those tests are the run's to skip */
const devFull = fs.existsSync("/dev/full") ? false : "no /dev/full on this platform (Linux has it): a write that fails for disk space is not made here";

test("the run's log on a full disk: said once with the way out, its lines counted, and written again once there is room", async () => {
  const lines: string[] = [];
  let full = false;
  const said: string[] = [];
  let clock = 0;
  const open = (): Writable => new Writable({ write(chunk, _e, cb) { if (full) cb(enospc()); else { lines.push(String(chunk)); cb(); } } });
  const log = new RunLog("/p/.mason/mason.log", { open, said: (t) => said.push(t), now: () => clock, retryMs: 1_000 });
  log.write("one\n");
  await tick();
  full = true;
  log.write("two\n");
  await tick();
  assert.deepEqual(said, [`the run's log /p/.mason/mason.log could not be written (ENOSPC: no space left on device, write): ${DISK_WAY_OUT}; ` +
    "the run goes on, and its log is written again once it can be"]);
  assert.equal(log.writing, false);
  log.write("three\n");
  log.write("four\n");
  // tried again while the disk is still full: the outage goes on, said once
  clock += 1_000;
  log.write("five\n");
  await tick();
  assert.equal(said.length, 1, "one outage, said once");
  full = false;
  clock += 1_000;
  log.write("six\n");
  await tick();
  assert.equal(said[1], "/p/.mason/mason.log is written again (at least 4 line(s) were not written)");
  assert.equal(lines[0], "one\n");
  assert.match(lines[1]!, /^\S+ \[log\] \/p\/\.mason\/mason\.log is written again: at least 4 line\(s\) before this one were not written\n$/);
  assert.equal(lines[2], "six\n");
  await log.end();
});

test("the run's log on Linux's /dev/full: the real ENOSPC said, never thrown, and the file written once it is a file again", { skip: devFull }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-output-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "mason.log");
  fs.symlinkSync("/dev/full", file);
  const said: string[] = [];
  let clock = 0;
  const log = new RunLog(file, { said: (s) => said.push(s), now: () => clock, retryMs: 1_000 });
  log.write("lost\n");
  for (let i = 0; i < 50 && said.length === 0; i++) await tick();
  assert.match(said[0] ?? "", /could not be written \(ENOSPC: no space left on device, write\): the disk that holds \.mason\/ is full: free disk there/);
  // room again: the file is a file
  fs.rmSync(file);
  clock += 1_000;
  log.write("kept\n");
  await log.end();
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /is written again: at least 1 line\(s\) before this one were not written\nkept\n$/);
});

test("the run's terminal on a full disk (stdout to /dev/full): the failure said once on stderr with the way out, the run goes on to its end", { skip: devFull }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-output-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "run.mjs");
  const out = path.join(dir, "said.json");
  fs.writeFileSync(script, `
    import * as fs from "node:fs";
    const { guardTerminal, terminalLine } = await import(${JSON.stringify(path.join(ROOT, "src", "cli", "run-output.ts"))});
    const said = [];
    guardTerminal((t) => said.push(t));
    terminalLine("stdout", "a step\\n");
    setTimeout(() => {
      terminalLine("stdout", "FATAL ERROR: Mason: the engine stopped\\n");
      setTimeout(() => fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ said })), 50);
    }, 100);
  `);
  const full = fs.openSync("/dev/full", "w");
  const child = spawn(process.execPath, [script], { stdio: ["ignore", full, "pipe"] });
  fs.closeSync(full);
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => { stderr += String(c); });
  const code = await new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  assert.equal(code, 0, `the run went on to its end: ${stderr}`);
  const want = `the run's stdout (mason logs --start) could not be written (ENOSPC: no space left on device, write): ${DISK_WAY_OUT}; the run goes on`;
  assert.equal(stderr, `${want}\n`, "said once, on the other stream");
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), { said: [want] }, "said once to the log, though a later line failed too");
});
