/**
 * THE WEB PAGE'S `mason share` (Connect from anywhere, the Overview's Connect card; docs/WEB-UI.md): the same share the
 * command opens — a login of `RunShares` (src/cli/share-run.ts) on the share's TLS-only socket, a tunnel client of
 * src/cli/tunnel.ts pointed at it, its address probed for the share's own certificate — opened by the RUN, because a page
 * cannot start a process. Nothing here is a second socket, password or tunnel: only who holds the share differs.
 *
 * THE PAGE HOLDS IT BY BEATS, NOT A CONNECTION: the page sends `POST /api/share/<user>/beat` every `BEAT_MS`, and a share
 * not beaten for `BOUND_MS` ends — the login, its sessions, the tunnel's client. A tab closed, crashed, frozen or
 * discarded and a laptop asleep all stop beating; a connection held open would survive a frozen tab (the browser keeps
 * reading its socket) and spends one of the browser's six connections to the run. The page beats while hidden (the
 * person is in their BI tool's tab, pasting), and a hidden tab's timers run at most once a minute (Chrome's intensive
 * throttling), so the bound is two minutes: one late beat never ends a share, two missed ones do. Stop sharing ends it
 * at once, and the page sends it as it closes too (`keepalive`), which a crash does not: the bound is the guarantee.
 *
 * THE PASSWORD IS MADE HERE, by the command's own `newSharePassword`, its hash given to `RunShares` as the command gives
 * it, and the password itself only in the one answer to the page's POST: no field of this class, no log line, no state.
 *
 * THE PAGE'S TUNNEL IS THE FREE ONE, OVER `ssh`: no token (a paid token's reconnect is the command's), so a tunnel that
 * ends ends the share, said by `/api/state` `shareEnded` and the next beat's answer.
 */
import type { Failure } from "./command.ts";
import { newSharePassword, shareSecret, type RunShares, type ShareChoice } from "./share-run.ts";
import { probeShare, startTunnel, tunnelPlan, type OpenTunnel, type TunnelPlan } from "./tunnel.ts";

/** How often the page beats, and how long a share waits for a beat before it ends (the header says why each). */
export const BEAT_MS = 15_000;
export const BOUND_MS = 120_000;
/** How long the tunnel has to give its address: `mason share`'s default. */
const TIMEOUT_MS = 30_000;

/** What the page is answered once, and only once: the password is in this answer alone. */
export interface PageOpened {
  user: string; host: string; port: number; database: string; password: string; sslmode: "require"; fingerprint: string;
  role: string | null; reads: string; openedAt: string; endsAt: string | null; verified: boolean; beatMs: number; boundMs: number;
}

export interface PageShareDeps {
  shares: RunShares;
  /** the run's own folder (.mason/): where the tunnel's ssh config and known hosts are, as the command's */
  home: string;
  log: (line: string) => void;
  /** a test's: the tunnel and the probe, else tunnel.ts's own */
  start?: typeof startTunnel;
  probe?: typeof probeShare;
  boundMs?: number;
  timeoutMs?: number;
}

/** A tunnel's failure in the page's words: what to do there, never a flag of the command's. */
function pageFailure(f: Failure, plan: TunnelPlan): Failure {
  if (f.code === "not_found") {
    return { message: `${plan.bin} is not on this machine, and Connect from anywhere needs it`, code: "not_found", why: "the temporary address is a tunnel opened over ssh",
      fix: `install ${plan.install}, then Connect from anywhere again`, next: [["mason doctor", "checks this machine"]] };
  }
  return { message: f.message, code: f.code, ...(f.why !== undefined ? { why: f.why } : {}),
    fix: f.message.startsWith("the tunnel gave no address") ? "the tunnel's service answered in a way this Mason cannot read: nothing was left open; mason share, in a terminal, offers another tunnel"
      : `${f.fix ?? "is this machine online? Port 443 outbound is all it needs"}; nothing was left open`,
    next: [["mason logs", "the run's log"]] };
}

export class PageShares {
  private readonly deps: PageShareDeps;
  /** the page's share open now: its user, the tunnel once up, and the timer its beats reset */
  private current: { user: string; tunnel: OpenTunnel | null; timer: NodeJS.Timeout } | null = null;

  constructor(deps: PageShareDeps) { this.deps = deps; }

  private get bound(): number { return this.deps.boundMs ?? BOUND_MS; }

  /** The roles the page offers before it asks (`RunShares.choices`). */
  choices(): Promise<{ role: string | null; reads: string } | { failure: Failure; choices?: ShareChoice[] }> { return this.deps.shares.choices(); }

  /** Opens the page's share: the login, the tunnel, the probe; refused, the failure, and nothing left open. */
  async open(o: { role?: string | undefined }): Promise<PageOpened | { failure: Failure; choices?: ShareChoice[] }> {
    const { shares } = this.deps;
    const password = newSharePassword();
    const opened = await shares.open({ secret: shareSecret(password), role: o.role, from: "page" });
    if ("failure" in opened) return opened;
    const user = opened.user;
    const mine = { user, tunnel: null as OpenTunnel | null, timer: this.lapse(user) };
    this.current = mine;
    // however it ends (Stop sharing, no beat, its tunnel, the run stopping), the tunnel's client goes with it
    shares.onEnd(user, () => { clearTimeout(mine.timer); mine.tunnel?.stop(); if (this.current === mine) this.current = null; });
    const plan = tunnelPlan("pinggy", { port: opened.port, home: this.deps.home, token: null });
    const t = await (this.deps.start ?? startTunnel)(plan, { timeoutMs: this.deps.timeoutMs ?? TIMEOUT_MS, onPid: (pid) => { shares.update(user, { pid, via: plan.via, state: "opening" }); } });
    if ("message" in t) { await shares.close(user, "its tunnel did not open"); return { failure: pageFailure(t, plan) }; }
    if (this.current !== mine) { t.stop(); return { failure: this.endedWhileOpening(user) }; }
    mine.tunnel = t;
    const probe = await (this.deps.probe ?? probeShare)(t, opened.fingerprint);
    if (this.current !== mine) { t.stop(); return { failure: this.endedWhileOpening(user) }; }
    if (probe === "other") {
      await shares.close(user, "its address answered with another certificate");
      return { failure: { message: `${t.host}:${t.port} is not this share: something else answers there`, code: "failed", why: "the tunnel gave that address, and the certificate there is not this share's",
        fix: "nothing was left open. Do not connect a tool to that address", next: [["mason logs", "the run's log"]] } };
    }
    shares.update(user, { host: t.host, port: t.port, endsAt: t.endsAt, state: "up", pid: t.pid, via: plan.via });
    void t.ended.then((why) => shares.close(user, `its tunnel closed (${why})`)).catch((e: unknown) => this.deps.log(`share: closing ${user} after its tunnel: ${(e as Error).message}`));
    this.deps.log(`share: ${user} opened from the web page, at ${t.host}:${t.port}`);
    return { user, host: t.host, port: t.port, database: opened.database, password, sslmode: "require", fingerprint: opened.fingerprint, role: opened.role, reads: opened.reads,
      openedAt: new Date().toISOString(), endsAt: t.endsAt, verified: probe === "same", beatMs: BEAT_MS, boundMs: this.bound };
  }

  private endedWhileOpening(user: string): Failure {
    const why = this.deps.shares.ended?.user === user ? this.deps.shares.ended.why : "it was stopped";
    return { message: `the share ended while its tunnel opened: ${why}`, code: "failed", fix: "nothing was left open: Connect from anywhere again" };
  }

  /** The timer a beat resets: past the bound with no beat, the share ends. */
  private lapse(user: string): NodeJS.Timeout {
    const t = setTimeout(() => {
      void this.deps.shares.close(user, `the web page stopped checking in for ${Math.round(this.bound / 1000)} s (closed, asleep or gone)`)
        .catch((e: unknown) => this.deps.log(`share: closing ${user}: ${(e as Error).message}`));
    }, this.bound);
    t.unref();
    return t;
  }

  /** A beat from the page: true when `user` is the page's share and still open. */
  beat(user: string): boolean {
    const c = this.current;
    if (c === null || c.user !== user || this.deps.shares.fromOf(user) !== "page") return false;
    clearTimeout(c.timer);
    c.timer = this.lapse(user);
    return true;
  }

  /** Stop sharing: the page's share ended now. false: no such share of the page's is open. */
  async stop(user: string): Promise<boolean> {
    if (this.deps.shares.fromOf(user) !== "page") return false;
    await this.deps.shares.close(user, "Stop sharing, on the web page");
    return true;
  }
}
