/**
 * `mason`'s answer reaches a reader through a pipe whole (#435: `mason status --json | jq` read 65,536 bytes of 138,668,
 * because the process exited while a pipe still held the rest). The reader here is slow on purpose: it reads nothing
 * until well after the command is done, so a process that exits on its last write loses everything past the pipe's
 * buffer. The long answer is a failure that repeats what it was given (an unknown command), the one way to make any
 * answer that long without a project.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { matrixEnv } from "./cli-matrix.ts";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");
// a control character is written as six (\u0001) wherever the name is quoted, so 100,000 of them make an answer of
// 600 KB: far past the pipe's buffer AND the 64 KB a paused reader's stream still takes in (a plain 100 KB name passed
// with the bug in place)
const LONG = "\u0001".repeat(100_000);
const QUOTED = JSON.stringify(LONG).slice(1, -1);

/** Runs mason with both streams piped and read only after `delayMs`; resolves with what was read and the exit code. */
function slowRead(argv: string[], delayMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [MAIN, ...argv], { env: matrixEnv(), stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pause(); child.stderr.pause();
  const out: Buffer[] = [], err: Buffer[] = [];
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    setTimeout(() => {
      // a stream paused by hand is not resumed by a data listener
      child.stdout.on("data", (b: Buffer) => out.push(b)).resume(); child.stderr.on("data", (b: Buffer) => err.push(b)).resume();
    }, delayMs);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() }));
  });
}

test("a --json answer longer than a pipe's buffer reaches a slow reader whole", async () => {
  const a = await slowRead([LONG, "--json"], 1500);
  assert.equal(a.code, 2);
  const body = JSON.parse(a.stdout) as { error: { message: string } };
  assert.ok(body.error.message.includes(QUOTED), "the message carries the whole name, quoted");
  assert.ok(a.stdout.length > 500_000, `${a.stdout.length} bytes`);
});

test("a person's failure longer than a pipe's buffer reaches a slow reader whole, on stderr", async () => {
  const a = await slowRead([LONG], 1500);
  assert.equal(a.code, 2);
  assert.ok(a.stderr.includes(QUOTED), `stderr has ${a.stderr.length} characters`);
});

test("a reader that goes away early ends the wait: mason exits with its own code, no hang and no stack", async () => {
  const child = spawn(process.execPath, [MAIN, LONG, "--json"], { env: matrixEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
  child.stdout.once("data", () => child.stdout.destroy());
  const giveUp = new AbortController();
  const code = await Promise.race([
    new Promise<number | null>((resolve) => child.on("close", resolve)),
    sleep(20_000, undefined, { signal: giveUp.signal }).then(() => { child.kill(); return "hung" as const; }, () => "settled" as const),
  ]);
  giveUp.abort();
  assert.equal(code, 2);
  assert.doesNotMatch(stderr, /\n\s+at /, "no stack trace");
});
