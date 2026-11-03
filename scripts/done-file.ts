#!/usr/bin/env node
/**
 * A COMMAND'S END, AS A FILE: runs a command, and once it has ended writes its exit code to <file>.
 *
 *   node scripts/done-file.ts <file> <command> [args...]
 *
 * An agent run by the Agent tool, or resumed by SendMessage, is not woken by a background job of its own once its turn
 * has ended (issue 504: two implementers ended their turn on a gate they had started in the background, and nothing
 * woke them). So a gate that can outlast one tool call (`npm run check` waits for a slot, CLAUDE.md "Local gates") is
 * started in the background under this script, and waited on in the same turn by `node scripts/wait-file.ts <file>
 * <seconds>`, a bounded foreground command run again until the file is there. wait-file waits for a non-empty file, so
 * <file> must appear only at the end: a log written as the gate runs would end the wait at its first line.
 *
 * <file> is removed first, so one left by an earlier run never ends the wait, and written whole (a temporary file
 * renamed onto it), so a reader never sees half of it. It holds one line: `exit <code>`, `signal <name>` when the
 * command was killed, or `error <message>` when it could not start. The command's output is this script's: redirect it
 * to a log. The exit code is the command's (128 + the signal's number when it was killed, 127 when it could not start);
 * 2 is a usage error, and then nothing ran and <file> is not written.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

const [file, ...command] = process.argv.slice(2);
if (file === undefined || file === "" || command.length === 0 || command[0] === "") {
  process.stderr.write("usage: node scripts/done-file.ts <file> <command> [args...]: runs the command, then writes its exit code to <file>\n");
  process.exit(2);
}
const target = path.resolve(file);
// ENOENT is the usual case (no earlier run); any other failure to remove it would let a stale file end the wait at once
try {
  fs.rmSync(target);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
    process.stderr.write(`done-file: could not remove ${target}, so a wait on it could end at once: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

function done(line: string, code: number): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${line}\n`);
  fs.renameSync(tmp, target);
  process.exitCode = code;
}

let ended = false;
const child = spawn(command[0]!, command.slice(1), { stdio: "inherit" });
child.on("error", (e) => {
  if (ended) return;
  ended = true;
  done(`error ${e.message}`, 127);
});
child.on("exit", (code, signal) => {
  if (ended) return;
  ended = true;
  if (signal) done(`signal ${signal}`, 128 + (os.constants.signals[signal] ?? 0));
  else done(`exit ${code ?? 1}`, code ?? 1);
});
// a signal sent to this script is passed on, so the command does not run on with no one to write its end
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(s, () => { child.kill(s); });
