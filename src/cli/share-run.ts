/**
 * THE RUN'S SIDE OF `mason share` (src/cli/share.ts is the command's; docs/POSTGRES-API.md "From a cloud BI tool"): the
 * second socket of the Postgres listener (src/api/postgres/server.ts `openShare`), and who may log in on it.
 *
 * A SHARE LASTS AS LONG AS THE COMMAND'S CONNECTION TO THE RUN (`POST /api/share`, src/cli/run-server.ts): the answer
 * stays open, and when it goes, however it goes — Ctrl-C, the tunnel's end, a `kill -9` —, the login goes, its sessions
 * end, its tunnel client is stopped, and with the last share the socket closes. A second `mason share` meets the same
 * socket with a login of its own.
 *
 * THE LOGIN IS IN THIS PROCESS'S MEMORY ALONE, AND ONLY ITS HASH: the command makes the password and sends its SHA-256
 * (`shareSecret`), so no state, log line or answer of the run can carry a password the run was never given (a fast hash
 * is enough: the password is 192 random bits, nothing to guess). It is no row of `.mason/users.json`, because that file
 * outlives a process and a share must not: a run that dies takes it along.
 * Only `authenticate` below reads this list, and only the share's socket asks it: the password is refused on the
 * run's own listener by nobody knowing it, and a `mason user` or a token here by the same.
 *
 * A LOGIN REFUSED HERE IS LOGGED WITH NO SOURCE: every connection through a tunnel comes from 127.0.0.1, so naming
 * one would be naming the tunnel's client. The log is written once a minute at most (a scanner's rate is anyone's), with
 * how many it stands for; the counts are `mason status`'s.
 */
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { ApiError } from "../api/error.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import type { Failure } from "./command.ts";
import type { PgApiServer, PgToken, ShareSocket } from "../api/postgres/server.ts";
import type { RoleGrants, RolesLive } from "../duck/grants.ts";
import { ROLE_NAME_RE, ROLE_NAME_RULE, ROLES_FILE } from "./roles.ts";
import { sameSecret } from "./security.ts";

/** What the password is stored and sent as: its SHA-256, hex. */
export const shareSecret = (password: string): string => crypto.createHash("sha256").update(password).digest("hex");

/** The new password `mason share` prints once: 192 random bits, in characters every form and URL takes. */
export const newSharePassword = (): string => crypto.randomBytes(24).toString("hex");

/** How often a refused login is written to the log, at most: the rest are counted. */
const REFUSED_LOG_MS = 60_000;

/** One role to choose between: what `mason share` lists, and asks a person to pick from. */
export interface ShareChoice { role: string; reads: string; default: boolean }

/** The tunnel of a share, as its command tells the run (`POST /api/share/<user>`). */
export interface ShareTunnel {
  via?: string;
  host?: string;
  port?: number;
  /** ISO 8601; null: no end but the command's */
  endsAt?: string | null;
  state?: "opening" | "up" | "reconnecting";
  /** the tunnel client's process: the run stops it when the command is gone */
  pid?: number;
}

export interface OpenedShare { user: string; port: number; fingerprint: string; database: string; role: string | null; reads: string }

/** `/api/state` `share`, `mason status`: nothing in it logs anyone in. */
export interface ShareState {
  port: number; fingerprint: string; sessions: number; refusedLogins: number; droppedConnections: number;
  shares: Array<{ user: string; role: string | null; reads: string; openedAt: string; via: string | null; host: string | null; port: number | null; endsAt: string | null; state: string }>;
}

interface Held { user: string; secret: string; role: string | null; reads: string; openedAt: string; tunnel: ShareTunnel; ended: ((why: string) => void) | null }

export interface ShareDeps {
  listener: Pick<PgApiServer, "openShare">;
  roles: () => RolesLive;
  /** the project's self-signed certificate (src/cli/pg-tls.ts ensureSelfSigned), made when it has none */
  certificate: () => { cert: Buffer; key: Buffer; fingerprint: string } | Failure;
  database: string;
  log: (line: string) => void;
  /** a test's: stops a tunnel client, by its pid, when its command is gone; default `stopTunnelClient` */
  stopTunnel?: (pid: number, port: number) => void;
}

/** What a role reads, in a line. */
function readsText(g: RoleGrants): string {
  if (g.all) return "every synced table";
  const names = [...g.tables.keys()];
  return `${names.length} synced table${names.length === 1 ? "" : "s"}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`;
}

/** The roles a share may read as, the file's default first. */
function choicesOf(live: RolesLive): ShareChoice[] {
  return [...live.grants.values()].map((g) => ({ role: g.name, reads: readsText(g), default: g.name === live.default }))
    .sort((a, b) => Number(b.default) - Number(a.default));
}

/**
 * WHAT A SHARE READS: `--role`'s role; with none named, the one answer the project gives — no roles file, so every synced
 * table, or a file of one role — and otherwise a refusal naming the choices. A file with a `default:` and other roles
 * is refused too: a default says what a local user gets, and a public address is no moment to widen it silently.
 * The refusal is a Failure with `choices` beside it: a person is asked (src/cli/share.ts), and an agent reads the lines.
 */
export function shareRole(asked: string | undefined, live: RolesLive): { role: string | null; reads: string } | { failure: Failure; choices?: ShareChoice[] } {
  const file = live.file ?? `mason/${ROLES_FILE}`;
  if (live.problem !== null) {
    return { failure: { message: `${file} cannot be read as it is now, so nothing is shared: ${live.problem}`, code: "bad_roles", why: "what a share reads is that file's", fix: `repair ${file}, then mason share` } };
  }
  const choices = choicesOf(live);
  const lines = choices.map((c): [string, string] => [`mason share --role ${c.role}`, `reads ${c.reads}`]);
  if (asked !== undefined) {
    if (!ROLE_NAME_RE.test(asked)) return { failure: { message: `${JSON.stringify(asked)} is not a role name: ${ROLE_NAME_RULE}`, code: "usage" } };
    const g = live.grants.get(asked);
    if (g !== undefined) return { role: asked, reads: readsText(g) };
    if (live.file === null) {
      return { failure: { message: `there is no role ${asked}: this project has no roles file`, code: "not_found", why: `a role is a key of ${file}, beside the sources file, naming the tables (and the columns of each) it may read`,
        fix: `write ${file}:\n  roles:\n    ${asked}:\n      tables:\n        <a synced table>: {}\nthen mason share --role ${asked}`, next: [["mason share", "or share every synced table: this project has no roles file"]] } };
    }
    return { failure: { message: `there is no role ${asked} in ${file}${didYouMean(asked, choices.map((c) => c.role))}`, code: "not_found", why: `the roles: ${choices.map((c) => c.role).join(", ")}`, next: lines }, choices };
  }
  if (live.file === null) return { role: null, reads: "every synced table" };
  if (choices.length === 1) return { role: choices[0]!.role, reads: choices[0]!.reads };
  if (choices.length === 0) {
    return { failure: { message: `${file} names no role, so a share would read nothing`, code: "not_found", why: "what a share reads is one role of that file", fix: `add a role to ${file}, then mason share --role <role>` } };
  }
  return { failure: { message: `${file} names ${choices.length} roles: mason share needs to know which one this address reads as`, code: "usage",
    why: "anyone with the address and password reads what that role reads", fix: choices.map((c) => `--role ${c.role}: reads ${c.reads}${c.default ? " (the file's default)" : ""}`).join("\n"), next: lines }, choices };
}

/** Stops a share's tunnel client once its command is gone: by its pid, and only while that pid is still a process
 *  naming the share's port (a pid is reused; never kill by anything broader). */
export function stopTunnelClient(pid: number, port: number, log: (line: string) => void): void {
  execFile("ps", ["-o", "command=", "-p", String(pid)], (err, stdout) => {
    // ps exits 1 for a pid that is gone: its command ended it, the usual case
    if (err !== null || !stdout.includes(String(port))) return;
    try { process.kill(pid, "SIGTERM"); }
    catch (e) { log(`share: stopping its tunnel client (pid ${pid}) failed: ${(e as Error).message}`); }
  });
}

export class RunShares {
  private readonly deps: ShareDeps;
  private readonly held = new Map<string, Held>();
  private socket: { opening: Promise<ShareSocket>; fingerprint: string } | null = null;
  /** the socket once it listens */
  private live: ShareSocket | null = null;
  private refused = 0;
  private dropped = 0;
  private lastSaid = -Infinity;
  private unsaid = 0;

  constructor(deps: ShareDeps) { this.deps = deps; }

  /** Opens a share: the socket when none is open, and a login of its own. Refused: the failure, with the choices when a role is what is missing. */
  async open(ask: { secret: string; role?: string | undefined }): Promise<OpenedShare | { failure: Failure; choices?: ShareChoice[] }> {
    const role = shareRole(ask.role, this.deps.roles());
    if ("failure" in role) return role;
    const user = `share_${crypto.randomBytes(3).toString("hex")}`;
    // in the list before the first wait, so a share ending meanwhile does not close the socket under this one
    this.held.set(user, { user, secret: ask.secret, role: role.role, reads: role.reads, openedAt: new Date().toISOString(), tunnel: { state: "opening" }, ended: null });
    let socket: ShareSocket, fingerprint: string;
    try {
      const made = this.socket ?? this.openSocket();
      if ("message" in made) { this.held.delete(user); return { failure: made }; }
      this.socket = made;
      fingerprint = made.fingerprint;
      socket = await made.opening;
    } catch (e) {
      this.held.delete(user);
      this.socket = null;
      return { failure: { message: `the share's socket could not be opened: ${(e as Error).message}`, code: "failed", next: [["mason logs", "the run's log"]] } };
    }
    this.live = socket;
    this.deps.log(`share: ${user} opened, reading ${role.role === null ? "every synced table (no roles file)" : `as the role ${role.role}`}, TLS required on 127.0.0.1:${socket.port}`);
    return { user, port: socket.port, fingerprint, database: this.deps.database, role: role.role, reads: role.reads };
  }

  private openSocket(): { opening: Promise<ShareSocket>; fingerprint: string } | Failure {
    const cert = this.deps.certificate();
    if ("message" in cert) return cert;
    const opening = this.deps.listener.openShare({
      tls: { cert: cert.cert, key: cert.key },
      authenticate: (password, user) => this.authenticate(password, user),
      recheck: (token) => this.recheck(token),
      loginHint: "the password mason share printed: every run of it makes a new one",
      refused: (user) => { this.refused++; this.note(`a login refused for the user ${JSON.stringify(user.slice(0, 63))}`); },
      dropped: (why) => { this.dropped++; this.note(`a connection dropped before its login: it ${why}`); },
    });
    return { opening, fingerprint: cert.fingerprint };
  }

  private authenticate(password: string, user: string): PgToken {
    const given = shareSecret(password);
    const found = [...this.held.values()].find((h) => sameSecret(h.secret, given));
    if (found === undefined || found.user !== user) {
      const refused = new ApiError(401, "not this share's password", "invalid_share");
      refused.userName = user;
      throw refused;
    }
    return { filters: [], subject: undefined, user: found.user, jti: found.user, ...(found.role !== null ? { role: found.role } : {}) };
  }

  /** a session's login, asked again before a statement: a share closed ends its sessions at once, and this is why none outlives it */
  private async recheck(token: PgToken): Promise<void> {
    if (token.jti === undefined || !this.held.has(token.jti)) throw new ApiError(401, "the share ended", "invalid_share");
  }

  /** the log's line: at most one a minute, saying how many it stands for, with no source (the header says why) */
  private note(what: string): void {
    const now = Date.now();
    if (now - this.lastSaid < REFUSED_LOG_MS) { this.unsaid++; return; }
    const more = this.unsaid > 0 ? ` (and ${this.unsaid} more before it)` : "";
    this.lastSaid = now;
    this.unsaid = 0;
    this.deps.log(`share: ${what}${more}; who cannot be known: every connection through a tunnel comes from 127.0.0.1`);
  }

  /** What a share's command says of its tunnel; false: no such share open. */
  update(user: string, tunnel: ShareTunnel): boolean {
    const h = this.held.get(user);
    if (h === undefined) return false;
    h.tunnel = { ...h.tunnel, ...tunnel };
    return true;
  }

  /** Called once when a share ends by anything but its command's connection (the run stopping). */
  onEnd(user: string, ended: (why: string) => void): void {
    const h = this.held.get(user);
    if (h !== undefined) h.ended = ended;
  }

  /** Ends a share: its login gone first, then its sessions, its tunnel client, and with the last one the socket. */
  async close(user: string, why: string): Promise<void> {
    const h = this.held.get(user);
    if (h === undefined) return;
    this.held.delete(user);
    const opening = this.socket?.opening;
    if (opening === undefined) return;
    const socket = await opening;
    const ended = socket.endSessions(user, "the share ended");
    if (h.tunnel.pid !== undefined) (this.deps.stopTunnel ?? ((pid, port) => stopTunnelClient(pid, port, this.deps.log)))(h.tunnel.pid, socket.port);
    this.deps.log(`share: ${user} closed: ${why}; ${ended} session${ended === 1 ? "" : "s"} ended`);
    h.ended?.(why);
    if (this.held.size > 0) return;
    this.socket = null;
    this.live = null;
    const counts = `${this.refused} login${this.refused === 1 ? "" : "s"} refused, ${this.dropped} connection${this.dropped === 1 ? "" : "s"} dropped before a login`;
    this.refused = 0; this.dropped = 0; this.unsaid = 0; this.lastSaid = -Infinity;
    await socket.close();
    this.deps.log(`share: the share's socket closed (${counts})`);
  }

  /** Every share ended (the run stopping). */
  async closeAll(why: string): Promise<void> { await Promise.all([...this.held.keys()].map((u) => this.close(u, why))); }

  state(): ShareState | null {
    if (this.socket === null || this.live === null) return null;
    return { port: this.live.port, fingerprint: this.socket.fingerprint, sessions: this.live.sessions, refusedLogins: this.refused, droppedConnections: this.dropped,
      shares: [...this.held.values()].map((h) => ({ user: h.user, role: h.role, reads: h.reads, openedAt: h.openedAt, via: h.tunnel.via ?? null, host: h.tunnel.host ?? null, port: h.tunnel.port ?? null,
        endsAt: h.tunnel.endsAt ?? null, state: h.tunnel.state ?? "opening" })) };
  }
}
