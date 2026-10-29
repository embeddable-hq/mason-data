/**
 * `mason user`: NAMED, REVOCABLE LOGINS WITH NO EXPIRY (docs/DESIGN.md "On a server", item 1 of the
 * agreed plan). A BI tool stores ONE static password, and the day-long token `mason connect` minted
 * (src/duck/token.ts) killed its connection the next day. A user is what Postgres and every BI tool's form call it: a
 * name and a password (`CREATE USER metabase WITH PASSWORD`), never a "token" (the ClickHouse stack's Query API token was
 * short-lived and scoped: a different thing) nor "credentials".
 *
 * THE PASSWORD is `mason_<id>_<mac>`: `<id>` 16 random hex digits, `<mac>` the first 32 hex digits of an HMAC-SHA256
 * over the user's NAME and id, keyed by the project's API key (`.mason/config.json` `apiKey`, `MASON_API_KEY` under
 * `mason serve`). So the user name a connection sends must be the user's (a token's session may send any), every
 * statement of its session is attributed to that user, and rotating the API key removes every user at once (no MAC
 * verifies under the new key). It never collides with a token: a token's MAC is 43 base64url characters.
 *
 * THE LIST OF USERS is a FILE in the state folder (`.mason/users.json`), never a DuckDB table: `mason user …` runs
 * as a second process beside the run, which holds DuckDB's file lock. It holds each user's name, id, when it was added
 * and the API key's fingerprint at the time (`key`, a MAC of a constant: no secret, it says which key a user was added
 * under) — never a password. A removed user STAYS in it with `removedAt` (so a list can show who was removed, and when):
 * only the entries without one are live, and the listener reads only those. A DISABLED user stays too, with
 * `disabledAt` (`mason user disable`): its password still verifies, but its login is refused as Postgres refuses a role
 * without LOGIN (28000, "is not permitted to log in") and its sessions end at their next statement, until `mason user
 * enable` clears it — the same id, so the same password connects again. A change is made under a lock file (`users.json.lock`, O_EXCL) and written beside and
 * renamed, so a reader sees the old list or the new one, never half of either, and two `mason user add` at once cannot
 * both win a name. The listener RE-READS it (`LiveUsers`: a stat at every connection and before every statement of a
 * user's session, the file read again when its inode, size or mtime moved), so a removal refuses the next connection
 * at once and ends the sessions that user holds at their next statement, without a restart. FAIL CLOSED: a file that
 * cannot be read refuses every user login with the reason (57P03, "could not tell"), never "live"; no file is no users.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiError, USER_DISABLED } from "../api/error.ts";
import type { PgApiOptions, PgToken } from "../api/postgres/server.ts";
import { tokenProblem } from "./token.ts";

export const USERS_FILE = "users.json";

/** A user's name: what a BI tool's form calls the user (Postgres's NAMEDATALEN, 63), lower case so a form that
 *  capitalises it is told so, never another user. */
export const USER_NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
export const USER_NAME_RULE = "1 to 63 lower case letters, digits, \"_\", \".\" or \"-\", starting with a letter or digit (e.g. metabase)";

/** One user, as the file keeps it: no secret. */
export interface MasonUser {
  name: string;
  /** 16 hex digits, the password's middle part */
  id: string;
  /** ISO 8601 UTC */
  addedAt: string;
  /** the API key's fingerprint when it was added (`keyFingerprint`): another one means the key was rotated since */
  key: string;
  /** ISO 8601 UTC; set by `mason user remove`, which keeps the entry: absent for a user that is not removed */
  removedAt?: string;
  /** ISO 8601 UTC; set by `mason user disable`, cleared by `enable`: absent for a user that is not disabled */
  disabledAt?: string;
}

/** Whether a user has not been removed (it may still not connect: see `underKey`). */
export const isActive = (u: MasonUser): boolean => u.removedAt === undefined;

/** Whether a user is disabled (`mason user disable`): kept, its password unchanged, its logins refused until enabled. */
export const isDisabled = (u: MasonUser): boolean => u.disabledAt !== undefined;


const PASSWORD_RE = /^mason_([0-9a-f]{16})_([0-9a-f]{32})$/;

const mac = (apiKey: string, name: string, id: string): string =>
  crypto.createHmac("sha256", apiKey).update(`mason-user:${name}:${id}`).digest("hex").slice(0, 32);

/** Which API key a user was added under, without the key: a MAC of a constant, 16 hex digits. */
export const keyFingerprint = (apiKey: string): string => crypto.createHmac("sha256", apiKey).update("mason-user-key").digest("hex").slice(0, 16);

/** A new user's id: 16 random hex digits. */
export const newUserId = (): string => crypto.randomBytes(8).toString("hex");

/** The user's password: only `mason user add` says it, once. */
export const userPassword = (apiKey: string, name: string, id: string): string => `mason_${id}_${mac(apiKey, name, id)}`;

/** Whether a password is a user's by its shape (else it is read as a token, src/duck/token.ts). */
export const isUserPassword = (password: string): boolean => PASSWORD_RE.test(password);

/** Whether a user was added under this API key (one rotated since is no longer live). */
export const underKey = (u: MasonUser, apiKey: string): boolean => u.key === keyFingerprint(apiKey);

// ------------------------------------------------------------------ the file

export type UsersRead = { users: MasonUser[] } | { problem: string };

/** The users the file lists; none when there is no file; why not, when it cannot be read — never an empty list then. */
export function readUsers(file: string): UsersRead {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { users: [] };
    return { problem: `${file} cannot be read: ${(e as Error).message}` };
  }
  return parseUsers(file, text);
}

function parseUsers(file: string, text: string): UsersRead {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { return { problem: `${file} is not valid JSON (${(e as Error).message})` }; }
  const list = (v as { users?: unknown } | null)?.users;
  if (typeof v !== "object" || v === null || !Array.isArray(list)) return { problem: `${file} is not { "users": [ … ] }` };
  const users: MasonUser[] = [];
  for (const [i, u] of list.entries()) {
    const o = u as Record<string, unknown> | null;
    if (typeof o !== "object" || o === null || typeof o.name !== "string" || !USER_NAME_RE.test(o.name) || typeof o.id !== "string" || !/^[0-9a-f]{16}$/.test(o.id) ||
      typeof o.addedAt !== "string" || typeof o.key !== "string") {
      return { problem: `${file}: users[${i}] is not { name, id, addedAt, key[, removedAt][, disabledAt] } as mason user add writes it` };
    }
    if (o.removedAt !== undefined && typeof o.removedAt !== "string") {
      return { problem: `${file}: users[${i}].removedAt is not a timestamp as mason user remove writes it` };
    }
    if (o.disabledAt !== undefined && typeof o.disabledAt !== "string") {
      return { problem: `${file}: users[${i}].disabledAt is not a timestamp as mason user disable writes it` };
    }
    users.push({ name: o.name, id: o.id, addedAt: o.addedAt, key: o.key, ...(o.removedAt !== undefined ? { removedAt: o.removedAt } : {}),
      ...(o.disabledAt !== undefined ? { disabledAt: o.disabledAt } : {}) });
  }
  return { users };
}

const LOCK_WAIT_MS = 5000;
/** a lock older than this was left by a process that died holding it */
const STALE_LOCK_MS = 30_000;

/**
 * A change to the list, made under the file's lock: `change` is handed the users as they are now and returns the list
 * to write, or a refusal (returned as it is, nothing written). The list is written beside the file and renamed over it.
 * Throws when the lock is held past LOCK_WAIT_MS or the file cannot be read or written: a caller says why.
 */
export function changeUsers<R extends { refused: string }>(file: string, change: (users: MasonUser[]) => MasonUser[] | R): MasonUser[] | R {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { fs.closeSync(fs.openSync(lock, "wx", 0o600)); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age: number;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; }
      catch (s) { if ((s as NodeJS.ErrnoException).code === "ENOENT") continue; throw s; }   // released between the two: try again
      if (age > STALE_LOCK_MS) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() > until) throw new Error(`${lock} is held by another mason user command (for ${Math.round(age / 1000)} s): run it again once that one ends, or remove the lock file if no mason user command runs`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const now = readUsers(file);
    if ("problem" in now) throw new Error(now.problem);
    const next = change(now.users);
    if (!Array.isArray(next)) return next;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify({ users: next }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    return next;
  } finally { fs.rmSync(lock, { force: true }); }
}

// ------------------------------------------------------------------ the listener's view

/** The ApiError a refused user login carries: the user it asked for, so the request log names who still tries. */
function refusal(status: 401 | 503, message: string, user: string, code: string = status === 503 ? "users_unreadable" : "invalid_user"): ApiError {
  const e = new ApiError(status, message, code);
  e.userName = user;
  return e;
}

/**
 * THE LIVE USERS AS THE LISTENER SEES THEM: the file read again whenever it changed (its inode — a rename makes a new
 * one —, size or mtime), so each check costs a stat. `login` is a connection's, `recheck` a session's before each
 * statement; both throw an ApiError, 401 for a password that is no live user's, 503 when the file cannot be read.
 */
export class LiveUsers {
  private readonly file: string;
  private readonly apiKey: string;
  private seen: string | null = null;
  private read: UsersRead = { users: [] };

  constructor(file: string, apiKey: string) { this.file = file; this.apiKey = apiKey; }

  /** the users not removed now (disabled ones included: their login is refused by name); why not, when the file cannot be read */
  now(): UsersRead {
    let stamp: string;
    try { const s = fs.statSync(this.file); stamp = `${s.ino}:${s.size}:${s.mtimeMs}`; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { problem: `${this.file} cannot be read: ${(e as Error).message}` };
      stamp = "none";
    }
    if (stamp !== this.seen || "problem" in this.read) {
      const r = readUsers(this.file);
      // a removed user is kept in the file for the list: it is no user to the listener
      this.read = "problem" in r ? r : { users: r.users.filter(isActive) };
      this.seen = stamp;
    }
    return this.read;
  }

  /** A connection's password, read as a user's: the session's token, or why it is refused. */
  login(user: string, password: string): PgToken {
    const m = PASSWORD_RE.exec(password);
    if (m === null) throw refusal(401, "not a Mason user's password: mason user add <name> makes a user and prints its password", user);
    const [, id, given] = m as unknown as [string, string, string];
    const now = this.now();
    if ("problem" in now) throw refusal(503, `the list of users cannot be read, so no user can connect: ${now.problem}`, user);
    const found = now.users.find((u) => u.id === id);
    const verifies = (name: string): boolean => crypto.timingSafeEqual(Buffer.from(mac(this.apiKey, name, id)), Buffer.from(given));
    if (found === undefined) {
      throw refusal(401, verifies(user) ? `the user "${user}" was removed (mason user list shows the users; mason user add ${user} makes it again, with a new password)`
        : "not a password of this project's users (or the API key was rotated, which removes every user): mason user list shows them", user);
    }
    if (!verifies(found.name)) {
      throw refusal(401, underKey(found, this.apiKey) ? "not a password of this project's users: mason user list shows them"
        : `the API key was rotated since the user "${found.name}" was added, which removes every user: mason user remove ${found.name}, then mason user add ${found.name}`, user);
    }
    // another user's password: refused as a wrong one is. Saying whose it is handed the name — which, with the password,
    // is the login — to anyone holding only the password (found on the test server)
    if (found.name !== user) throw refusal(401, "not a password of this project's users: mason user list shows them", user);
    // disabled: refused only once its password verified (so the state is told to the holder of the login alone), in
    // Postgres's words for a role without LOGIN, 28000 (src/api/postgres/server.ts reads the code)
    if (isDisabled(found)) throw refusal(401, disabledMessage(found.name), user, USER_DISABLED);
    return { filters: [], subject: undefined, user: found.name, jti: found.id };
  }

  /** A held session's user, asked again before a statement: throws as `login` does when it is no longer live. */
  recheck(token: PgToken): void {
    if (token.user === undefined) return;
    const now = this.now();
    if ("problem" in now) throw refusal(503, `the list of users cannot be read: ${now.problem}`, token.user);
    const found = now.users.find((u) => u.id === token.jti && u.name === token.user);
    if (found === undefined) throw refusal(401, `the user "${token.user}" was removed`, token.user);
    if (isDisabled(found)) throw refusal(401, `the user "${token.user}" was disabled`, token.user, USER_DISABLED);
  }
}

/** A disabled user's refused login: Postgres's sentence for a role without LOGIN, then why and the way out. */
export const disabledMessage = (name: string): string =>
  `role "${name}" is not permitted to log in: the user "${name}" is disabled (mason user enable ${name} lets it connect again, with the same password)`;

/**
 * HOW THE DUCKDB RUN'S LISTENER TAKES A PASSWORD (src/cli/dev.ts; the tests wire the same): a user's password (its shape)
 * is the users file's to judge, and its session is asked again before every statement (a stat); anything else is read as a
 * token, the kind `mason connect` minted before `mason user` (src/duck/token.ts: the API key used as a password is refused by name).
 */
export function listenerLogins(users: LiveUsers, apiKey: string): Pick<PgApiOptions, "authenticate" | "recheck" | "recheckMs"> {
  return {
    authenticate: (password, user) => {
      if (isUserPassword(password)) return users.login(user, password);
      const problem = tokenProblem(apiKey, password);
      if (problem !== null) throw new Error(problem);
      return { filters: [], subject: undefined };
    },
    recheck: async (t) => { users.recheck(t); },
    recheckMs: 0,
  };
}
