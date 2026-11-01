/**
 * THE WEB PAGE'S SHARE: Connect from anywhere, on the Overview's Connect card (src/web/pages/status.js `renderAnywhere`),
 * the page's equivalent of `mason share`. ONE MECHANISM: the same share `mason share` opens — its login and socket
 * (`RunShares`, src/cli/share-run.ts: TLS required, the password held as its hash), its password (`newSharePassword`),
 * its tunnel and the check of its address (`openVerifiedTunnel`, src/cli/tunnel.ts). What differs is who holds it: the
 * command's process holds its share in a terminal, and here THE RUN starts the tunnel's client, for the page that asked.
 *
 * THE PAGE HOLDS IT BY A HEARTBEAT (`POST /api/share/page/beat`, every BEAT_MS): a share nobody is watching is a public
 * login nobody is watching, so a share whose page has not checked in for BEAT_BOUND_MS is closed — a tab closed or
 * crashed, a page reloaded, a laptop put to sleep (on waking, the first beat or the run's own check finds the gap, and
 * whichever comes first closes it). A held connection would miss the last two: a frozen tab and a sleeping laptop keep
 * their loopback connection. The page also says goodbye on `pagehide` (a beacon to `stop`), so a closed tab usually ends
 * it at once; the bound is what holds when it cannot.
 *
 * THE PASSWORD IS IN ONE ANSWER ALONE: made here, sent once as the open's answer, and kept by the run only as its hash
 * (`RunShares`); no log line, ledger row or later `/api/state` carries it.
 *
 * ONE SHARE AT A TIME between the page and `mason share`, in either order: the page refuses while any share is open,
 * and the command is refused while the page's is (src/cli/run-server.ts `openShare`), each naming the open one and how to
 * end it. The run stopping ends it (src/cli/dev.ts `closeAll`, through `RunShares.close` → `onEnd`); a `kill -9` of the
 * run ends its socket and closes the client's stdin, which ends the client (src/cli/tunnel.ts), and the next start sweeps
 * the tunnel file a kill left (`sweepTunnelFiles`). A paid token's reconnect is the command's alone: the page's share is
 * a free tunnel, and ends when it ends.
 */
import type { Failure } from "./command.ts";
import { newSharePassword, shareSecret, type RunShares, type ShareChoice } from "./share-run.ts";
import { openVerifiedTunnel, tunnelPlan, type OpenTunnel } from "./tunnel.ts";

/** How often the page checks in, and how long the run waits for it: a hidden tab's timers run once a minute at worst
 *  (a browser's throttling), so the bound is two of those. */
export const BEAT_MS = 20_000;
export const BEAT_BOUND_MS = 120_000;
/** How long the tunnel has to give its address (`mason share`'s default). */
const TUNNEL_TIMEOUT_MS = 30_000;

/** The share as the page shows it, once: the only answer that carries the password. */
export interface PageShareOpened {
  host: string; port: number; database: string; user: string; password: string; sslmode: "require"; fingerprint: string;
  role: string | null; reads: string; endsAt: string | null; openedAt: string; verified: boolean; beatMs: number; boundMs: number;
}

export type PageAnswer = { status: number; body: Record<string, unknown> } | { status: number; failure: Failure };

export interface PageShareDeps {
  shares: RunShares;
  /** the run's .mason/: the tunnel's config file and known hosts, as `mason share`'s */
  home: string;
  log: (line: string) => void;
  /** a test's: the tunnel, opened and checked; default the free tunnel over ssh (`openVerifiedTunnel`) */
  openTunnel?: (port: number, fingerprint: string, onPid: (pid: number) => void) => Promise<{ tunnel: OpenTunnel; verified: boolean } | Failure>;
  boundMs?: number;
  beatMs?: number;
  now?: () => number;
}

const refused = (status: number, f: Failure): PageAnswer => ({ status, failure: f });
const AGAIN: [string, string] = ["mason share", "or, from a terminal, the same share"];

/** The web page's share (the header says how it is held). */
export class PageShare {
  private readonly d: PageShareDeps;
  private readonly boundMs: number;
  private readonly beatMs: number;
  private readonly now: () => number;
  /** the share this page holds: its user once the run made it */
  private current: { user: string | null; lastBeat: number; tunnel: OpenTunnel | null } | null = null;
  /** why the last page share ended, for a beat that comes after it */
  private ended: { user: string; why: string } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(d: PageShareDeps) {
    this.d = d;
    this.boundMs = d.boundMs ?? BEAT_BOUND_MS;
    this.beatMs = d.beatMs ?? BEAT_MS;
    this.now = d.now ?? Date.now;
  }

  /** The user of the page's share open now, or null. */
  user(): string | null { return this.current?.user ?? null; }

  /** `POST /api/share/page` { confirmed: true, role? }: the share opened, its password in this answer alone; or
   *  `{ choices }` when the roles file names several and none was chosen (the page then asks which). */
  async open(body: unknown): Promise<PageAnswer> {
    const b = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as { confirmed?: unknown; role?: unknown };
    if (b.confirmed !== true) {
      return refused(400, { message: "nothing was opened: a public address is opened only once the page has asked", code: "usage",
        why: "send { confirmed: true, role? }: the page asks the person first that this opens a temporary public address" });
    }
    if (b.role !== undefined && typeof b.role !== "string") return refused(400, { message: "role is a role's name, or left out", code: "usage" });
    const open = this.openNow();
    if (open !== null) return refused(409, open);
    const cur: { user: string | null; lastBeat: number; tunnel: OpenTunnel | null } = { user: null, lastBeat: this.now(), tunnel: null };
    this.current = cur;
    const password = newSharePassword();
    const opened = await this.d.shares.open({ secret: shareSecret(password), role: b.role as string | undefined, from: "page" });
    if ("failure" in opened) {
      this.current = null;
      // several roles and none chosen: a question for the person, not a failure (`mason share` asks it the same way)
      if (opened.choices !== undefined && b.role === undefined) return { status: 200, body: { choices: opened.choices, why: opened.failure.why ?? null } };
      return refused(statusFor(opened.failure), opened.failure);
    }
    const user = opened.user;
    cur.user = user;
    this.d.shares.onEnd(user, (why) => this.onEnded(user, why));
    const plan = tunnelPlan("pinggy", { port: opened.port, home: this.d.home, token: null });
    const openTunnel = this.d.openTunnel ?? ((_port, fingerprint, onPid) => openVerifiedTunnel(plan, fingerprint, { timeoutMs: TUNNEL_TIMEOUT_MS, onPid }));
    const t = await openTunnel(opened.port, opened.fingerprint, (pid) => { this.d.shares.update(user, { pid, via: plan.via, state: "opening" }); });
    if (this.current !== cur) {
      // stopped, or the run stopping, while its tunnel opened: the tunnel, if it came, goes at once
      if ("tunnel" in t) t.tunnel.stop();
      return refused(409, { message: `the share ended while its tunnel opened: ${this.ended?.user === user ? this.ended.why : "it was stopped"}`, code: "failed", fix: "Connect from anywhere gives a new address and a new password" });
    }
    if (!("tunnel" in t)) {
      await this.d.shares.close(user, `its tunnel did not open: ${t.message}`);
      return refused(statusFor(t), pageWords(t, plan.install));
    }
    const tunnel = t.tunnel;
    cur.tunnel = tunnel;
    cur.lastBeat = this.now();
    this.d.shares.update(user, { host: tunnel.host, port: tunnel.port, endsAt: tunnel.endsAt, state: "up", pid: tunnel.pid });
    void tunnel.ended.then((why) => this.d.shares.close(user, `its tunnel closed (${why})`)).catch((e: unknown) => this.d.log(`share: closing ${user} after its tunnel closed failed: ${(e as Error).message}`));
    this.timer ??= setInterval(() => this.check(), Math.max(50, Math.min(5_000, this.boundMs / 4)));
    this.timer.unref();
    this.d.log(`share: ${user} opened from the web page at ${tunnel.host}:${tunnel.port}; it ends when the page stops checking in (${Math.round(this.boundMs / 1000)} s)`);
    const share: PageShareOpened = { host: tunnel.host, port: tunnel.port, database: opened.database, user, password, sslmode: "require", fingerprint: opened.fingerprint,
      role: opened.role, reads: opened.reads, endsAt: tunnel.endsAt, openedAt: new Date(this.now()).toISOString(), verified: t.verified, beatMs: this.beatMs, boundMs: this.boundMs };
    return { status: 200, body: { share } };
  }

  /** `POST /api/share/page/beat` { user }: the page is still there. A beat after the bound has passed ends the share
   *  (a laptop woken from sleep), and a beat for a share that ended is told why. */
  async beat(body: unknown): Promise<PageAnswer> {
    const user = userOf(body);
    if (user === null) return refused(400, { message: "send { user }: the share's user, as the page was given it", code: "usage" });
    const cur = this.current;
    if (cur !== null && cur.user === user) {
      const gap = this.now() - cur.lastBeat;
      if (gap <= this.boundMs) { cur.lastBeat = this.now(); return { status: 200, body: { ok: true, user, boundMs: this.boundMs } }; }
      await this.d.shares.close(user, lapsed(gap));
    }
    return refused(410, this.endedFailure(user));
  }

  /** `POST /api/share/page/stop` { user }: Stop sharing (and the page's goodbye on `pagehide`). Answered once the share
   *  is closed: its login gone, its sessions ended, its tunnel's client stopped. */
  async stop(body: unknown): Promise<PageAnswer> {
    const user = userOf(body);
    if (user === null) return refused(400, { message: "send { user }: the share's user, as the page was given it", code: "usage" });
    if (this.current?.user === user) {
      const tunnel = this.current.tunnel;
      await this.d.shares.close(user, "stopped from the web page");
      if (tunnel !== null) await Promise.race([tunnel.ended, new Promise((r) => setTimeout(r, 2_500).unref())]);
      return { status: 200, body: { ended: "stopped from the web page", user } };
    }
    const command = this.d.shares.state()?.shares.find((s) => s.user === user && s.from === "command");
    if (command !== undefined) {
      return refused(409, { message: `${user} is held by mason share, not by this page`, code: "refused", fix: "Ctrl-C in the terminal that runs mason share ends it" });
    }
    return refused(410, this.endedFailure(user));
  }

  /** Why a share cannot be opened now, or null: one at a time, the page's or the command's. */
  private openNow(): Failure | null {
    if (this.current !== null) {
      return { message: `a share is open already, from the web page${this.current.user === null ? "" : ` (${this.current.user})`}: one share at a time`, code: "refused",
        fix: "Stop sharing, on the Overview's Connect card, ends it (closing that page does too); then Connect from anywhere again" };
    }
    const open = this.d.shares.state()?.shares ?? [];
    if (open.length > 0) {
      return { message: `mason share is holding a share now (${open.map((s) => s.user).join(", ")}): one share at a time`, code: "refused",
        fix: "Ctrl-C in the terminal that runs mason share ends it; then Connect from anywhere again" };
    }
    return null;
  }

  private check(): void {
    const cur = this.current;
    if (cur === null || cur.user === null || cur.tunnel === null) return;
    const gap = this.now() - cur.lastBeat;
    if (gap > this.boundMs) void this.d.shares.close(cur.user, lapsed(gap)).catch((e: unknown) => this.d.log(`share: closing ${cur.user} failed: ${(e as Error).message}`));
  }

  private onEnded(user: string, why: string): void {
    this.ended = { user, why };
    if (this.current?.user !== user) return;
    this.current.tunnel?.stop();
    this.current = null;
    if (this.timer !== null) { clearInterval(this.timer); this.timer = null; }
  }

  private endedFailure(user: string): Failure {
    const why = this.ended?.user === user ? this.ended.why : null;
    return { message: why === null ? `no share ${user} is open from this page` : `the share ended: ${why}`, code: "ended",
      fix: "its address no longer answers, and its password no longer works: Connect from anywhere gives a new address and a new password", next: [AGAIN] };
  }
}

const userOf = (body: unknown): string | null => {
  const u = typeof body === "object" && body !== null ? (body as { user?: unknown }).user : undefined;
  return typeof u === "string" && /^share_[0-9a-f]{6}$/.test(u) ? u : null;
};

const lapsed = (gap: number): string => `the page stopped checking in (nothing for ${Math.round(gap / 1000)} s): a share nobody is watching is closed`;

const statusFor = (f: Failure): number => f.code === "usage" ? 400 : f.code === "not_found" ? 404 : f.code === "refused" || f.code === "bad_roles" ? 409 : 502;

/** A tunnel's failure in the page's words: the command's own, but a way out the page has (the command's flags are a
 *  terminal's, said as such). */
function pageWords(f: Failure, install: string): Failure {
  if (f.code === "not_found") {
    return { message: "ssh is not on this machine's PATH, and Connect from anywhere needs it", code: "not_found", fix: `install ${install}, then Connect from anywhere again`,
      next: [["mason share --via bore", "from a terminal: a tunnel that needs no ssh"]] };
  }
  return { ...f, fix: f.fix === undefined ? "Connect from anywhere again" : `${f.fix}; then Connect from anywhere again` };
}

export type { ShareChoice };
