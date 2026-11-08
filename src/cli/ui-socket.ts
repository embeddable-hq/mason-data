/**
 * `MASON_UI_SOCKET` (mason serve): THE WEB PAGE ON A UNIX SOCKET THE OPERATOR NAMES, beside its loopback port, for a
 * process on the same machine (a supervisor, a local reverse proxy) that should reach the page without a port published
 * or a `docker exec` per request.
 *
 * WHO CAN CONNECT is who can write the socket, so the socket is made mode 0600 in a folder only Mason's user can write
 * (owned by it, no group or other write), never through a symbolic link: anything else refuses the start, with the way
 * out. A path that is already there is replaced only when it is a socket of Mason's user that nobody answers on (a run
 * that crashed left it); a file of any other kind, a link, another user's socket, or one a process answers on is never
 * removed. The socket is removed when the run stops.
 *
 * WHAT A REQUEST ON IT IS TRUSTED WITH: exactly what one through `mason ui --bridge` is, because it reaches the run's own
 * request handler (src/cli/run-server.ts), behind the same guard (src/cli/security.ts): its Host, the run's token or a
 * tunnel's ticket and cookie, its Origin. Arriving on the socket proves nothing: no request is taken for a local
 * browser, or let in at all, for where it came from.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import type { Failure } from "./command.ts";

export const UI_SOCKET_SETTING = "MASON_UI_SOCKET";

/** The longest path a Unix socket may have: `sun_path` holds 108 bytes on Linux, 104 on macOS, each with its NUL. */
const maxSocketBytes = (platform: NodeJS.Platform): number => platform === "darwin" ? 103 : 107;

/** How long a socket at the path has to answer before it is taken for one nobody serves: a live run answers at once. */
const PROBE_MS = 1_000;

/** The socket MASON_UI_SOCKET names, absolute; null when it is unset (or set empty); or what is wrong with it. */
export function uiSocketSetting(env: Readonly<Record<string, string | undefined>>, cwd: string, platform: NodeJS.Platform = process.platform): string | null | { problem: string } {
  const set = env[UI_SOCKET_SETTING];
  if (!set) return null;
  if (platform === "win32") return { problem: `${UI_SOCKET_SETTING} is set, and Windows has no Unix socket for the page: unset it (mason ui --ssh <user@server> opens the page from your machine)` };
  const file = path.resolve(cwd, set);
  const bytes = Buffer.byteLength(file);
  if (bytes > maxSocketBytes(platform)) return { problem: `${UI_SOCKET_SETTING}=${JSON.stringify(set)} is ${bytes} bytes as a full path, and a Unix socket's path is at most ${maxSocketBytes(platform)}: name a shorter one` };
  return file;
}

const refused = (file: string, problem: string, fix: string): Failure =>
  ({ message: `${UI_SOCKET_SETTING}=${file}: ${problem}`, code: "refused", why: "the socket is how a process on this machine reaches the web page, so only Mason's user may make or replace it", fix });

export const octal = (mode: number): string => `0${(mode & 0o777).toString(8)}`;

/** Whether a process answers on the socket at `file`: true, false (nothing listens), or the error that left it unknown. */
function answers(file: string): Promise<boolean | Error> {
  return new Promise((resolve) => {
    const c = net.connect(file);
    const timer = setTimeout(() => { c.destroy(); resolve(new Error(`it neither accepted nor refused a connection in ${PROBE_MS} ms`)); }, PROBE_MS);
    c.once("connect", () => { clearTimeout(timer); c.destroy(); resolve(true); });
    c.once("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(e.code === "ECONNREFUSED" ? false : e); });
  });
}

/**
 * THE FOLDER OF A FILE ONLY MASON'S USER MAY MAKE (the page's socket, the run's file, src/cli/ui-run-file.ts): a folder,
 * not a link to one, owned by Mason's user, which no group or other can write; null, or what is wrong and the way out.
 * Fails closed: a folder it cannot read is refused. `what` names the file in the way out ("socket", "run file").
 */
export function ownFolderProblem(file: string, what: string, uid: number): { problem: string; fix: string } | null {
  const dir = path.dirname(file);
  const ownFolder = `mkdir -m 700 ${dir} as Mason's user, or name a ${what} in a folder that is only its own (the data folder's .mason/ is)`;
  let d: fs.Stats;
  try { d = fs.lstatSync(dir); }
  catch (e) { return { problem: `its folder ${dir} cannot be read: ${(e as NodeJS.ErrnoException).code === "ENOENT" ? "it does not exist" : (e as Error).message}`, fix: ownFolder }; }
  if (d.isSymbolicLink()) {
    let real: string;
    try { real = fs.realpathSync(dir); } catch (e) { real = `it names nothing that can be read: ${(e as Error).message}`; }
    return { problem: `its folder ${dir} is a symbolic link`, fix: `name the ${what} in the folder itself (${real}), not through a link to it` };
  }
  if (!d.isDirectory()) return { problem: `${dir} is not a folder`, fix: ownFolder };
  if (d.uid !== uid) return { problem: `its folder ${dir} is owned by uid ${d.uid}, not Mason's user (uid ${uid})`, fix: ownFolder };
  if ((d.mode & 0o022) !== 0) return { problem: `its folder ${dir} can be written by others than Mason's user (mode ${octal(d.mode)})`, fix: `chmod go-w ${dir}, or ${ownFolder}` };
  return null;
}

/**
 * The folder and the path held to the bar (the header): null when the socket may be made, after a stale one is removed
 * (`said` is told), or the refusal. Fails closed: a fact it cannot read refuses.
 */
export async function prepareUiSocket(file: string, said: (line: string) => void, uid: number = process.getuid!()): Promise<Failure | null> {
  const folder = ownFolderProblem(file, "socket", uid);
  if (folder !== null) return refused(file, folder.problem, folder.fix);
  let f: fs.Stats;
  try { f = fs.lstatSync(file); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return refused(file, `it cannot be read: ${(e as Error).message}`, "name another path");
  }
  const notMine = "remove it yourself if it is not needed, or name another path";
  if (f.isSymbolicLink()) return refused(file, "it is a symbolic link, and Mason never replaces one", notMine);
  if (!f.isSocket()) return refused(file, `it is ${f.isDirectory() ? "a folder" : "a file"}, not a socket, and Mason removes only a socket a run of its own left`, notMine);
  if (f.uid !== uid) return refused(file, `it is a socket of uid ${f.uid}, not of Mason's user (uid ${uid})`, notMine);
  const live = await answers(file);
  if (live === true) return refused(file, "a process answers on it: another Mason, or something else, serves it now", "stop that process, or name another path");
  if (live instanceof Error) return refused(file, `whether a process answers on it could not be told (${live.message})`, notMine);
  try { fs.unlinkSync(file); }
  catch (e) { return refused(file, `the stale socket could not be removed: ${(e as Error).message}`, notMine); }
  said(`replaced the socket a run that did not stop left at ${file}`);
  return null;
}

/** The page on its socket: `attach` gives it the run's server, whose requests it then serves; `close` removes it. */
export interface UiSocket { file: string; attach: (run: http.Server) => void; close: () => void }

/**
 * Listens on `file` (`prepareUiSocket` first) with mode 0600 from the moment it exists (the umask around the bind),
 * checked after. Until `attach`, a request is answered 503, as /healthz says starting; then each one is the run's
 * server's own request, behind its guard.
 */
export async function listenOnUiSocket(file: string, said: (line: string) => void, uid: number = process.getuid!()): Promise<UiSocket | Failure> {
  let run: http.Server | null = null;
  const server = http.createServer((req, res) => {
    if (run !== null) { run.emit("request", req, res); return; }
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }).end("Mason is starting: the page answers once it does\n");
  });
  const before = process.umask(0o177);
  let listening: Promise<Error | null>;
  try {
    listening = new Promise((resolve) => { server.once("error", resolve); server.listen(file, () => resolve(null)); });
  } finally { process.umask(before); }
  const err = await listening;
  if (err !== null) return refused(file, `the socket cannot be made: ${err.message}`, "name a path in a folder only Mason's user can write");
  let made: fs.Stats;
  try {
    fs.chmodSync(file, 0o600);
    made = fs.lstatSync(file);
  } catch (e) {
    server.close();
    return refused(file, `the socket's mode cannot be set: ${(e as Error).message}`, "name a path in a folder only Mason's user can write");
  }
  if (!made.isSocket() || made.uid !== uid || (made.mode & 0o777) !== 0o600) {
    server.close();
    return refused(file, `the socket is not Mason's alone once made (mode ${octal(made.mode)}, uid ${made.uid})`, "name a path in a folder only Mason's user can write");
  }
  let closed = false;
  return {
    file,
    attach: (r) => { run = r; },
    close: () => {
      if (closed) return;
      closed = true;
      server.close();
      server.closeAllConnections();
      // the listening socket is unlinked as it closes; whatever is still at the path is removed only when it is this one
      try {
        const now = fs.lstatSync(file);
        if (now.isSocket() && now.ino === made.ino && now.dev === made.dev) fs.unlinkSync(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") said(`the web page's socket ${file} could not be removed: ${(e as Error).message}`);
        return;
      }
      said(`removed the web page's socket ${file}`);
    },
  };
}
