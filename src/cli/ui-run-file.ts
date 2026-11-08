/**
 * `MASON_UI_RUN_FILE` (mason serve): THE RUN'S PAGE PORT AND TOKEN IN A FILE THE OPERATOR NAMES, for a process on the
 * same machine that supervises the run (a supervisor, a local reverse proxy beside MASON_UI_SOCKET) and opens a tunnel
 * (`POST /api/ui/tunnel`) without reading `.mason/config.json`, which is the run's own and holds more.
 *
 * WHAT IT HOLDS: `{ "port", "token" }` and nothing else. The token is the run's: it grants the commands' writes (mason
 * add, mason sync, mason cancel, the users) as well as a tunnel, so the file is held to the bar the page's socket is
 * (src/cli/ui-socket.ts): in a folder only Mason's user can write (`ownFolderProblem`), mode 0600 from the moment it
 * exists, never through a symbolic link. The socket's path is not in it: whoever reads the file named the socket, and
 * /healthz says it.
 *
 * WRITTEN WHOLE, ONCE THE RUN ANSWERS: a 0600 file beside it, written and flushed, then linked to the path (a link
 * never replaces what is there), so a reader finds no file or the whole of it. It is removed when the run stops, and only
 * when it is still the one written. A file already at the path is replaced only when it is a run file of Mason's user
 * (a regular file, 0600, of exactly those two keys) whose run does not answer with its token; anything else — a link,
 * a folder, another user's file, a file of other content, a run that answers — refuses the start and is left as it is.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Failure } from "./command.ts";
import { octal, ownFolderProblem } from "./ui-socket.ts";

export const UI_RUN_FILE_SETTING = "MASON_UI_RUN_FILE";

/** What the file holds: the run's command server's port on 127.0.0.1 (the page's), and the run's token. */
export interface RunFileContent { port: number; token: string }

/** How long the run a stale file names has to answer before whether it runs is taken as unknown. */
const PROBE_MS = 2_000;

/** The file MASON_UI_RUN_FILE names, absolute; null when it is unset (or set empty); or what is wrong with it. */
export function uiRunFileSetting(env: Readonly<Record<string, string | undefined>>, cwd: string, platform: NodeJS.Platform = process.platform): string | null | { problem: string } {
  const set = env[UI_RUN_FILE_SETTING];
  if (!set) return null;
  // a file mode is how the token is kept to Mason's user, and Windows keeps none
  if (platform === "win32") return { problem: `${UI_RUN_FILE_SETTING} is set, and on Windows a file cannot be kept to Mason's user by its mode: unset it` };
  return path.resolve(cwd, set);
}

const refused = (file: string, problem: string, fix: string): Failure =>
  ({ message: `${UI_RUN_FILE_SETTING}=${file}: ${problem}`, code: "refused", why: "the file holds the run's token, which grants the commands' writes as well as a tunnel to the page, so only Mason's user may make or replace it", fix });

/** The content of a run file Mason wrote, or null when `text` is anything else. */
function runFileContent(text: string): RunFileContent | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }   // not JSON: not a run file, which the caller refuses
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "port,token") return null;
  if (typeof o.port !== "number" || !Number.isInteger(o.port) || o.port < 1 || o.port > 65_535 || typeof o.token !== "string") return null;
  return { port: o.port, token: o.token };
}

/** Whether the run a file names answers with its token: true, false (nothing that is that run), or the error that left it unknown. */
async function runAnswers(c: RunFileContent): Promise<boolean | Error> {
  try {
    const res = await fetch(`http://127.0.0.1:${c.port}/api/ping`, { headers: { Authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(PROBE_MS) });
    if (res.status !== 200) { await res.body?.cancel(); return false; }
    let body: { pid?: unknown } | null;
    try { body = await res.json() as { pid?: unknown } | null; }
    catch (e) {
      // a 200 whose body is not JSON is no run's ping (a body cut off midway is not knowing, said as such)
      if (e instanceof SyntaxError) return false;
      throw e;
    }
    return typeof body?.pid === "number";
  } catch (e) {
    const code = ((e as Error).cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ECONNREFUSED") return false;
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * The folder and the path held to the bar (the header): null when the file may be written, after a stale one is
 * removed (`said` is told), or the refusal. Fails closed: a fact it cannot read refuses.
 */
export async function prepareUiRunFile(file: string, said: (line: string) => void, uid: number = process.getuid!()): Promise<Failure | null> {
  const folder = ownFolderProblem(file, "run file", uid);
  if (folder !== null) return refused(file, folder.problem, folder.fix);
  let f: fs.Stats;
  try { f = fs.lstatSync(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return refused(file, `it cannot be read: ${(e as Error).message}`, "name another path");
  }
  const notMine = "remove it yourself if it is not needed, or name another path";
  if (f.isSymbolicLink()) return refused(file, "it is a symbolic link, and Mason never replaces one", notMine);
  if (!f.isFile()) return refused(file, `it is ${f.isDirectory() ? "a folder" : "not a regular file"}, and Mason replaces only a run file a run of its own left`, notMine);
  if (f.uid !== uid) return refused(file, `it is a file of uid ${f.uid}, not of Mason's user (uid ${uid})`, notMine);
  if ((f.mode & 0o777) !== 0o600) return refused(file, `it is a file of mode ${octal(f.mode)}, and a run file Mason writes is 0600`, notMine);
  let text: string;
  try {
    // never through a link that appeared since: O_NOFOLLOW
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { text = f.size > 4096 ? "" : fs.readFileSync(fd, "utf8"); } finally { fs.closeSync(fd); }
  } catch (e) { return refused(file, `it cannot be read: ${(e as Error).message}`, notMine); }
  const content = runFileContent(text);
  if (content === null) return refused(file, "it is a file of other content than a run file Mason writes ({ port, token })", notMine);
  const live = await runAnswers(content);
  if (live === true) return refused(file, "the run it names answers with its token: another Mason writes it now", "stop that Mason, or name another path");
  if (live instanceof Error) return refused(file, `whether the run it names still runs could not be told (${live.message})`, notMine);
  try { fs.unlinkSync(file); }
  catch (e) { return refused(file, `the stale run file could not be removed: ${(e as Error).message}`, notMine); }
  said(`replaced the run file a run that did not stop left at ${file}`);
  return null;
}

/** Whether `file` holds `text`, read never through a link. */
function readsAs(file: string, text: string): boolean {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch { return false; }   // gone, or a link since: not the file written, which the caller leaves
  try { return fs.readFileSync(fd, "utf8") === text; } finally { fs.closeSync(fd); }
}

/** The written file: `remove` removes it, only while it is the file written. */
export interface UiRunFile { file: string; remove: () => void }

/**
 * Writes `content` to `file` whole (the header): a 0600 file beside it, written and flushed, linked to the path, which
 * fails when anything is there, then checked. `said` is told of a removal that failed.
 */
export function writeUiRunFile(file: string, content: RunFileContent, said: (line: string) => void, uid: number = process.getuid!()): UiRunFile | Failure {
  const folder = ownFolderProblem(file, "run file", uid);
  if (folder !== null) return refused(file, folder.problem, folder.fix);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`);
  const text = `${JSON.stringify({ port: content.port, token: content.token })}\n`;
  let fd: number | null = null;
  let linked = false;
  const cleanUp = (): void => {
    if (fd !== null) { try { fs.closeSync(fd); } catch (e) { said(`the run file's descriptor could not be closed: ${(e as Error).message}`); } }
    try { fs.unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") said(`the run file's temporary ${temp} could not be removed: ${(e as Error).message}`); }
  };
  let made: fs.Stats;
  try {
    // made 0600 by open itself (O_EXCL: never a file that was there; O_NOFOLLOW: never through a link), then set
    // exactly 0600 whatever the umask, before a byte is written
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    made = fs.fstatSync(fd);
    fs.closeSync(fd);
    fd = null;
    // a link never replaces what is at the path: EEXIST when something appeared there since the start checked it
    fs.linkSync(temp, file);
    linked = true;
  } catch (e) {
    cleanUp();
    const code = (e as NodeJS.ErrnoException).code;
    return refused(file, code === "EEXIST" && !linked ? "something was put at the path after the start checked it, and Mason writes over nothing" : `it cannot be written: ${(e as Error).message}`,
      code === "EEXIST" ? "remove it yourself if it is not needed, or name another path" : "name a path in a folder only Mason's user can write, on a file system that keeps hard links");
  }
  cleanUp();
  let now: fs.Stats;
  try { now = fs.lstatSync(file); }
  catch (e) { return refused(file, `it cannot be read once written: ${(e as Error).message}`, "name a path in a folder only Mason's user can write"); }
  // the file written: its inode, and its text too, since a file made at the path after it was removed may be handed
  // the same inode number
  const same = (s: fs.Stats): boolean => s.isFile() && s.ino === made.ino && s.dev === made.dev && s.size === Buffer.byteLength(text) && readsAs(file, text);
  if (!same(now) || now.uid !== uid || (now.mode & 0o777) !== 0o600) {
    if (same(now)) { try { fs.unlinkSync(file); } catch (e) { said(`the run file ${file} could not be removed: ${(e as Error).message}`); } }
    return refused(file, `it is not Mason's alone once written (mode ${octal(now.mode)}, uid ${now.uid})`, "name a path in a folder only Mason's user can write");
  }
  let removed = false;
  return {
    file,
    remove: () => {
      if (removed) return;
      removed = true;
      // removed only while it is the file written: another's at the path since is left as it is
      try {
        if (same(fs.lstatSync(file))) fs.unlinkSync(file);
        else return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") said(`the run file ${file} could not be removed: ${(e as Error).message}`);
        return;
      }
      said(`removed the run file ${file}`);
    },
  };
}
