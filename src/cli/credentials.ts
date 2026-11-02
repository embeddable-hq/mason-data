/**
 * WHERE A LOGIN TO A HOSTED MASON SERVICE IS KEPT (`mason login`, `mason logout`; docs/HOSTED-API.md "Where the login
 * is kept"): one file of the person's, never a project's — `$XDG_CONFIG_HOME/mason/credentials.json`, else
 * `~/.config/mason/credentials.json` — 0600 in a 0700 folder, written beside and renamed, so a reader never meets half
 * a file. It is keyed by the service's base URL, so a login to a service on this machine never replaces another's:
 *
 *     { "version": 1, "logins": { "<base url>": { "token", "email", "savedAt" } } }
 *
 * IT HOLDS A SECRET, SO IT IS CHECKED BEFORE IT IS READ OR WRITTEN: a folder or file another user may read, or that is
 * another user's, is refused with the exact `chmod` to run; the file is opened without following a link and checked as
 * opened; one that cannot be parsed is refused with its path and never overwritten. Nothing of its content is ever
 * repeated in a failure (a JSON parser's error quotes the text, which holds the token). On Windows the mode bits say
 * nothing of who may read a file (its ACLs do), so the checks are POSIX's; the file is under the user's own profile.
 *
 * `MASON_TOKEN` in the environment comes before the file (CI): `environmentToken`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { Failure } from "./command.ts";
import { shellWord } from "../lib/shell-word.ts";

export interface Login { token: string; email: string; savedAt: string }
export interface Logins { version: 1; logins: Record<string, Login> }

export const TOKEN_ENV = "MASON_TOKEN";

/** The token the environment carries, which every command uses before a saved login; null when unset or empty. */
export function environmentToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = env[TOKEN_ENV];
  return t ? t : null;
}

/** The folder and file a login is kept in (XDG's rule: a relative XDG_CONFIG_HOME is ignored). */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): { dir: string; file: string } {
  const xdg = env.XDG_CONFIG_HOME;
  const config = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  const dir = path.join(config, "mason");
  return { dir, file: path.join(dir, "credentials.json") };
}

const POSIX = process.platform !== "win32";
const NEXT_LOGIN: Failure["next"] = [["mason login", "sign in again, once it is fixed"]];

/** Why a folder or file of ours is not private (another may read it, or it is another's), with the chmod; else null. */
function notPrivate(where: string, st: fs.Stats, kind: "folder" | "file"): Failure | null {
  if (!POSIX) return null;
  const mode = kind === "folder" ? "700" : "600";
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    return { message: `${where} belongs to another user of this machine`, code: "refused", why: "it holds the login of a hosted Mason service, which must be yours alone",
      fix: `remove it (or set XDG_CONFIG_HOME to a folder of your own), then mason login`, next: NEXT_LOGIN };
  }
  if ((st.mode & 0o077) !== 0) {
    return { message: `${where} can be read by other users of this machine (mode ${(st.mode & 0o777).toString(8).padStart(3, "0")})`, code: "refused",
      why: "it holds the login of a hosted Mason service: anyone who reads it can act as you there",
      fix: `chmod ${mode} ${shellWord(where)}`, next: [[`chmod ${mode} ${shellWord(where)}`, `make it yours alone (${mode})`]] };
  }
  return null;
}

/** A file that cannot be used as it is: refused with its path, and never overwritten. */
const unreadable = (file: string, why: string): Failure => ({ message: `${file} cannot be read as Mason's logins`, code: "refused", why,
  fix: `move it aside (mv ${shellWord(file)} ${shellWord(`${file}.bad`)}), then mason login: nothing was changed`, next: NEXT_LOGIN });

/** The folder, checked; null when it does not exist yet. */
function checkedDir(dir: string): Failure | null | "absent" {
  let st: fs.Stats;
  try { st = fs.statSync(dir); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return { message: `${dir} cannot be read`, code: "refused", why: (e as Error).message, next: NEXT_LOGIN };
  }
  if (!st.isDirectory()) return { message: `${dir} is not a folder`, code: "refused", why: "Mason keeps a hosted service's login in a folder of that name", fix: "move it aside, then mason login", next: NEXT_LOGIN };
  return notPrivate(dir, st, "folder");
}

/**
 * THE LOGINS SAVED ON THIS MACHINE: none when the file is not there, else what it holds — or a Failure when the folder
 * or the file is not private, or the file cannot be parsed.
 */
export function readLogins(env: NodeJS.ProcessEnv = process.env): { logins: Logins; file: string } | Failure {
  const { dir, file } = credentialsPath(env);
  const d = checkedDir(dir);
  if (d === "absent") return { logins: { version: 1, logins: {} }, file };
  if (d) return d;
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { logins: { version: 1, logins: {} }, file };
    if (code === "ELOOP") return unreadable(file, "it is a symbolic link, which Mason does not follow to a login");
    return unreadable(file, (e as Error).message);
  }
  let text: string;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return unreadable(file, "it is not a file");
    const loose = notPrivate(file, st, "file");
    if (loose) return loose;
    if (st.size > 1024 * 1024) return unreadable(file, "it is larger than 1 MiB");
    text = fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
  const parsed = parseLogins(text);
  return typeof parsed === "string" ? unreadable(file, parsed) : { logins: parsed, file };
}

/** The file's text as logins, or why it is not (never quoting it: it holds tokens). */
export function parseLogins(text: string): Logins | string {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return "it is not JSON"; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "it is not a JSON object";
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return `its version is ${typeof o.version === "number" ? o.version : "missing"}, where this Mason reads 1`;
  if (typeof o.logins !== "object" || o.logins === null || Array.isArray(o.logins)) return "it has no logins object";
  const logins: Record<string, Login> = {};
  for (const [base, l] of Object.entries(o.logins as Record<string, unknown>)) {
    const e = l as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null || typeof e.token !== "string" || !e.token || typeof e.email !== "string" || typeof e.savedAt !== "string") {
      return `its login for ${JSON.stringify(base.slice(0, 200))} is not { token, email, savedAt }`;
    }
    logins[base] = { token: e.token, email: e.email, savedAt: e.savedAt };
  }
  return { version: 1, logins };
}

/**
 * WRITE THE LOGINS: the folder made 0700 when it is not there (and checked when it is), the file written 0600 beside
 * its name and renamed over it, so a reader meets the old file or the new one, never half of either. A Failure when
 * any of it could not be done (nothing then replaces the file).
 */
export function writeLogins(logins: Logins, env: NodeJS.ProcessEnv = process.env): { file: string } | Failure {
  const { dir, file } = credentialsPath(env);
  let d = checkedDir(dir);
  if (d === "absent") {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
    catch (e) { return { message: `could not make ${dir}`, code: "failed", why: (e as Error).message, next: NEXT_LOGIN }; }
    d = checkedDir(dir);
  }
  if (d) return d === "absent" ? { message: `could not make ${dir}`, code: "failed", next: NEXT_LOGIN } : d;
  const tmp = path.join(dir, `.credentials.json.${process.pid}.${randomBytes(6).toString("hex")}`);
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try { fs.writeSync(fd, `${JSON.stringify(logins, null, 2)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) {
    // the half-written file must not stay beside the logins; its own removal failing is said with the write's failure
    let left = "";
    try { fs.rmSync(tmp, { force: true }); } catch (r) { left = ` (and ${tmp} could not be removed: ${(r as Error).message})`; }
    return { message: `could not write ${file}`, code: "failed", why: `${(e as Error).message}${left}`, next: NEXT_LOGIN };
  }
  return { file };
}
