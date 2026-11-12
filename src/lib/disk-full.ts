/**
 * A WRITE THAT FAILS FOR DISK SPACE (issue 847: the disk holding `.mason/` filled, the run's log stream threw an
 * unhandled ENOSPC and ended the run, its supervisor's record of the restart was left empty and the supervisor died,
 * and a restart met the engine's raw "Could not write file …: No space left on device" with no way out said).
 *
 * The class is a write Mason makes under `.mason/` that is not handled. Its decisions, each one place:
 * - a file Mason REWRITES (the config, the restarts' record, the supervisor's pid) is written beside and renamed over
 *   (`replaceFile`): a write that fails leaves the file as it was, never empty or half written;
 * - a failure for disk space is told by ONE test (`isDiskFull`), and said with ONE way out (`withDiskWayOut`), wherever
 *   it is said: the run's terminal and log (src/cli/dev.ts), the sync's words (src/lib/secret-mask.ts `errorText`), a
 *   command's failure (src/cli/main.ts) and the supervisor's notes (src/cli/supervise.ts).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** the words a full disk is met in: Node's codes (ENOSPC; EDQUOT, a quota) and DuckDB's and the OS's texts */
const DISK_FULL = /No space left on device|\bENOSPC\b|\bEDQUOT\b|Disk quota exceeded|disk is full/i;

/** Whether an error (or a text that carries one) is a write that failed for disk space. */
export function isDiskFull(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | null | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return true;
  return DISK_FULL.test(e instanceof Error ? e.message : String(e));
}

/** The way out of a full disk, in the words every place says it. */
export const DISK_WAY_OUT = "the disk that holds .mason/ is full: free disk there (Mason writes again once there is room, and nothing synced is lost)";

/** A write of Mason's own file that failed, in the words it is said with: what, why, and the disk's way out when it
 *  was the disk. */
export function writeFailureText(what: string, e: unknown): string {
  return `${what} could not be written (${e instanceof Error ? e.message : String(e)})${isDiskFull(e) ? `: ${DISK_WAY_OUT}` : ""}`;
}

/** a path under a `.mason/` folder, as an engine's or the OS's words name the file they could not write */
const UNDER_MASON = /[/\\]\.mason[/\\]/;

/**
 * A text with the disk's way out, when it says a write to a file under `.mason/` failed for disk space and does not say
 * the way out already (src/duck/store.ts `openDuck` and src/duck/executor.ts `invalidatedReason` word their own: "free
 * disk …"); any other text as it is. The file must be named: the source database's own full disk ("could not extend
 * file …: No space left on device", read back through the sync) is ITS disk, never this machine's, and is no way out
 * here. Applied where a text is said, so the same text is never told it twice.
 */
export function withDiskWayOut(text: string): string {
  if (!DISK_FULL.test(text) || !UNDER_MASON.test(text) || /free disk/i.test(text)) return text;
  return `${text} (${DISK_WAY_OUT})`;
}

/**
 * Writes `file` whole or not at all: the text goes to a new file beside it, which is renamed over it. A write that fails
 * (a full disk) removes what it began and throws, and `file` stays as it was — never empty, never half written.
 */
export function replaceFile(file: string, text: string, mode = 0o600): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) {
    // what was begun goes; its own removal failing is said with the write's failure, never instead of it
    try { fs.rmSync(tmp, { force: true }); }
    catch (r) { (e as Error).message += `; ${tmp} could not be removed either (${(r as Error).message})`; }
    throw e;
  }
}
