/**
 * A LOCK BETWEEN PROCESSES THAT A KILLED HOLDER CANNOT KEEP (issue 792), for scripts/fails-without.ts: one run at a
 * time calls `git worktree` in a repository.
 *
 * The lock is a DIRECTORY at <lock> that always holds its owner's file, `owner-<pid>-<nonce>`:
 * - to take it, a run makes a directory of its own with its owner file in it, and renames that onto <lock>. A rename
 *   onto a directory succeeds only when that directory is missing or EMPTY, and fails (ENOTEMPTY/EEXIST) while it holds
 *   an owner, atomically, so two runs never both hold it;
 * - to release it, the owner removes its own file: an empty <lock> is a free one;
 * - a lock whose owner's pid is dead (a run killed while it held it) is taken over by removing THAT owner's file, by
 *   its whole name. A name is never a test of what is there now: a second run that saw the same dead owner gets ENOENT,
 *   and an owner file of a lock taken since is another name, in another directory, so it is never removed. (Taking a
 *   dead holder's lock over by renaming the lock path away, the first form of this fix, could take a live holder's.)
 *
 * A lock still held after `waitMs` throws an error that names the owner's pid and the folder.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const OWNER = /^owner-(\d+)-[0-9a-f]+$/;
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
};
const code = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

export class LockTimeout extends Error {}

/** Runs `fn` holding <lock>; `onTakeOver` hears of each dead owner's lock taken over. */
export function underLock<T>(lock: string, fn: () => T, opts: { waitMs?: number; onTakeOver?: (pid: number) => void } = {}): T {
  const waitMs = opts.waitMs ?? 120_000;
  const me = `owner-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const mine = `${lock}.${me}`;
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, me), "");
  const until = Date.now() + waitMs;
  let taken = false;
  try {
    for (;;) {
      try { fs.renameSync(mine, lock); taken = true; break; }
      catch (e) { if (code(e) !== "ENOTEMPTY" && code(e) !== "EEXIST") throw e; }
      let entries: string[];
      try { entries = fs.readdirSync(lock); }
      catch (e) { if (code(e) === "ENOENT") continue; throw e; } // released and removed between the two
      const owners = entries.map((f) => ({ f, pid: Number(OWNER.exec(f)?.[1] ?? NaN) })).filter((o) => o.pid > 0);
      const dead = owners.find((o) => !alive(o.pid));
      if (dead !== undefined) {
        try { fs.unlinkSync(path.join(lock, dead.f)); opts.onTakeOver?.(dead.pid); }
        catch (e) { if (code(e) !== "ENOENT") throw e; } // another run took it over first
        continue;
      }
      if (Date.now() > until) {
        const who = owners.length > 0 ? `by pid ${owners.map((o) => o.pid).join(", ")}` : `with no owner in it (${entries.join(", ") || "empty"})`;
        throw new LockTimeout(`${lock} is held ${who} for over ${waitMs / 1000} s: run again once that run ends, or remove the folder if no fails-without run is running`);
      }
      pause(10);
    }
    return fn();
  } finally {
    if (taken) fs.rmSync(path.join(lock, me), { force: true }); // what is left, an empty folder, is a free lock
    else fs.rmSync(mine, { recursive: true, force: true });
  }
}
