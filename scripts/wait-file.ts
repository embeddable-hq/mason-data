#!/usr/bin/env node
/**
 * A BOUNDED WAIT ON A FILE: exits once <path> exists and is not empty, or when <seconds> pass.
 *
 *   node scripts/wait-file.ts <path> <seconds>
 *
 * An agent runs it on a file `scripts/done-file.ts` writes, to wait on a gate that outlasts one tool call (issue 504);
 * it once waited on a workflow stage's results file (issue 304). It was a shell loop (`for i in $(seq 120); do [ -s <path> ]
 * …`), which Claude Code's worktree guard may refuse in an isolated agent, so it is one plain command (issue 322).
 *
 * Exit codes: 0 the file is there and not empty, 8 the deadline passed without it, 2 usage. Any other exit (1 is
 * Node's own, an uncaught error) is "couldn't tell". WAIT_FILE_INTERVAL_MS sets the pause between looks (15 s); only the
 * tests set it.
 */
import * as fs from "node:fs";

export const MAX_SECONDS = 7200;

const ready = (file: string): boolean => {
  try {
    return fs.statSync(file).size > 0;
  } catch (e) {
    // not there yet is the wait itself; anything else (a permission, a loop of links) is said, and still a wait
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") process.stderr.write(`wait-file: ${(e as Error).message}\n`);
    return false;
  }
};

const [file, secArg, ...rest] = process.argv.slice(2);
if (file === undefined || file === "" || rest.length > 0 || !/^\d+$/.test(secArg ?? "") || Number(secArg) < 1 || Number(secArg) > MAX_SECONDS) {
  process.stderr.write(`usage: node scripts/wait-file.ts <path> <seconds>: <seconds> a whole number from 1 to ${MAX_SECONDS}\n`);
  process.exit(2);
}
const interval = Number(process.env["WAIT_FILE_INTERVAL_MS"] ?? 15_000);
const deadline = performance.now() + Number(secArg) * 1000;
let found = ready(file);
while (!found && performance.now() < deadline) {
  await new Promise((r) => setTimeout(r, Math.max(0, Math.min(Number.isFinite(interval) ? interval : 15_000, deadline - performance.now()))));
  found = ready(file);
}
process.stdout.write(found ? `${file}: there\n` : `${file}: not there after ${secArg} s\n`);
process.exitCode = found ? 0 : 8;
