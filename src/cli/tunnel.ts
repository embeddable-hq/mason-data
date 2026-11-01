/**
 * THE TUNNEL OF `mason share`: a client of a free service that forwards raw TCP, run as a child process and pointed at the
 * share's socket (src/cli/share-run.ts). What crosses is TLS between the BI tool and Mason, so a service that only
 * forwards reads nothing; a hostile one could sit in the handshake (docs/POSTGRES-API.md says so). Which one is `--via`:
 * Pinggy over the `ssh` every machine has, or `bore`, a binary to install. The address is the client's OUTPUT, a format
 * Mason does not own, so reading it is held three ways: a time limit (`timeoutMs`), a shape it must have
 * (`tunnelAddress`), and a probe of the address it gave (`probeShare`): the share's own certificate must answer there.
 *
 * `ssh` NEVER PROMPTS, because nothing stands behind a prompt (an agent, a pipe, a terminal that went on to something
 * else): it runs in a session of its own with no terminal (`detached`), stdin a pipe this process holds. The first
 * connection's host key is taken and kept in `.mason/share-known-hosts` (`accept-new`: a key that CHANGES later fails, said
 * by the file's name), never the developer's own `~/.ssh`; their keys, agent and config are left out (`-F`, no
 * `PubkeyAuthentication`), so nothing can ask for a passphrase or a touch and nothing of theirs is offered to a
 * service. Pinggy's free route asks for a password that is empty (its docs: "just press enter"), so a password
 * question is answered by `true`, which prints nothing (`SSH_ASKPASS`, forced): that is the one answer any question gets.
 *
 * A PINGGY TOKEN NEVER REACHES A COMMAND LINE: `ps` shows every process's arguments to every user, and the service takes the
 * token as the ssh user. So the user is written in a config file of ours, 0600 in `.mason/`, named by `-F`, and
 * removed as soon as the tunnel is up (ssh has read it), or when it fails. `MASON_PINGGY_TOKEN` is read from the
 * shell or `.env`, never a flag, and is masked in whatever of the client's output a failure repeats.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import { stripVTControlCharacters } from "node:util";
import type { Failure } from "./command.ts";

export const TUNNELS = ["pinggy", "bore"] as const;
export type Via = (typeof TUNNELS)[number];

/** A free tunnel's limit where its client does not say one: Pinggy's, measured in docs/DESIGN.md "mason share". */
const FREE_MINUTES = 60;
/** How much of the client's output is kept to read an address from, and how many lines a failure repeats. */
const KEPT_BYTES = 64 * 1024;
const SAID_LINES = 3;
const STOP_GRACE_MS = 2_000;
/** How long the address is given to answer: long enough for a relay on another continent, short enough to wait for. */
export const PROBE_MS = 8_000;

/** How one tunnel client is started. */
export interface TunnelPlan {
  via: Via;
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** what to tell a person who lacks `bin` */
  install: string;
  /** a tunnel that keeps its address across connections, so it is opened again when it drops */
  reconnects: boolean;
  /** when it ends with no word of its own */
  free: boolean;
  /** the secret to keep out of anything repeated from its output */
  token: string | null;
  /** the file to write before it starts, and to remove once it is up or has failed */
  file: { path: string; text: string } | null;
}

/** The ssh user and host: a free tunnel, or a token's (`<token>+tcp@`, Pinggy's own form). */
const pinggyTarget = (token: string | null): { user: string; host: string } => token === null ? { user: "tcp", host: "free.pinggy.io" } : { user: `${token}+tcp`, host: "pro.pinggy.io" };

/** A token as it may stand in a config file: anything else would be a line of it. */
export const TOKEN_RE = /^[A-Za-z0-9._~-]+$/;

const quoted = (file: string): string => `"${file.replaceAll("%", "%%")}"`;

/** The ssh config of a tunnel (the header says why each line): every option here, so the command line carries none. */
export function pinggyConfig(o: { token: string | null; knownHosts: string }): string {
  const t = pinggyTarget(o.token);
  return `Host mason-share
  HostName ${t.host}
  Port 443
  User ${t.user}
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ${quoted(o.knownHosts)}
  GlobalKnownHostsFile none
  PubkeyAuthentication no
  IdentityAgent none
  NumberOfPasswordPrompts 1
  ExitOnForwardFailure yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ConnectTimeout 15
  ConnectionAttempts 1
  RequestTTY no
  LogLevel ERROR
`;
}

export function tunnelPlan(via: Via, o: { port: number; home: string; token: string | null }): TunnelPlan {
  if (via === "bore") {
    return { via, bin: "bore", args: ["local", String(o.port), "--local-host", "127.0.0.1", "--to", "bore.pub"], env: process.env, install: "cargo install bore-cli, or brew install bore-cli",
      reconnects: false, free: false, token: null, file: null };
  }
  const file = path.join(o.home, `share-tunnel-${process.pid}.ssh`);
  return { via, bin: "ssh", args: ["-F", file, "-T", `-R0:127.0.0.1:${o.port}`, "mason-share"],
    env: { ...process.env, SSH_ASKPASS: "true", SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY ?? ":0" }, install: "the OpenSSH client (it comes with macOS and most Linux; apt install openssh-client)",
    reconnects: o.token !== null, free: o.token === null, token: o.token,
    file: { path: file, text: pinggyConfig({ token: o.token, knownHosts: path.join(o.home, "share-known-hosts") }) } };
}

/** A `share-tunnel-<pid>.ssh` a `kill -9` left behind (it may hold a token): removed unless its process is alive. */
export function sweepTunnelFiles(home: string, isAlive: (pid: number) => boolean): void {
  for (const name of fs.readdirSync(home)) {
    const m = /^share-tunnel-(\d+)\.ssh$/.exec(name);
    if (m !== null && !isAlive(Number(m[1]))) fs.rmSync(path.join(home, name), { force: true });
  }
}

const PINGGY_ADDRESS = /\btcp:\/\/([a-z0-9][a-z0-9.-]*):(\d{1,5})(?![\d.])/i;
const BORE_ADDRESS = /\blistening at ([a-z0-9][a-z0-9.-]*):(\d{1,5})(?![\d.])/i;

/** The public address in what a client printed so far, or null: a shape, and a real port. */
export function tunnelAddress(via: Via, output: string): { host: string; port: number } | null {
  const m = (via === "pinggy" ? PINGGY_ADDRESS : BORE_ADDRESS).exec(stripVTControlCharacters(output));
  if (m === null) return null;
  const port = Number(m[2]);
  return port >= 1 && port <= 65_535 ? { host: m[1]!.toLowerCase(), port } : null;
}

/** When a free tunnel ends: what its client says, else its known limit; null when it has none. */
export function tunnelEnds(plan: Pick<TunnelPlan, "free">, output: string, now: number): string | null {
  if (!plan.free) return null;
  const said = /expires?\s+in\s+(\d+)\s*min/i.exec(stripVTControlCharacters(output));
  return new Date(now + (said === null ? FREE_MINUTES : Number(said[1])) * 60_000).toISOString();
}

/** The last lines a client printed, on one line, its token masked: what a failure repeats. */
export function lastLines(output: string, token: string | null): string {
  const lines = stripVTControlCharacters(output).split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l !== "");
  const text = lines.slice(-SAID_LINES).join(" / ");
  return token === null ? text : text.replaceAll(token, "<token>");
}

export interface OpenTunnel {
  host: string; port: number; endsAt: string | null; pid: number;
  /** settles when the client ended, with what it last said */
  ended: Promise<string>;
  /** ends the client (a `kill -9` of this command leaves that to the run: src/cli/share-run.ts) */
  stop(): void;
}

/** Starts a tunnel client and reads its address: the tunnel, or why not. `onPid`: as soon as there is a process. */
export function startTunnel(plan: TunnelPlan, o: { timeoutMs: number; onPid?: (pid: number) => void }): Promise<OpenTunnel | Failure> {
  return new Promise((resolve) => {
    const forget = (): void => { if (plan.file !== null) fs.rmSync(plan.file.path, { force: true }); };
    if (plan.file !== null) fs.writeFileSync(plan.file.path, plan.file.text, { mode: 0o600 });
    // detached: a session of its own, so no terminal to prompt on, and Ctrl-C reaches this process alone, which ends it.
    // stdin a pipe held open: the end of stdin would end the session the service prints on
    const child: ChildProcess = spawn(plan.bin, plan.args, { stdio: ["pipe", "pipe", "pipe"], env: plan.env, detached: true });
    let output = "", settled = false, finished: (why: string) => void = () => undefined;
    const ended = new Promise<string>((r) => { finished = r; });
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, STOP_GRACE_MS).unref();
    };
    const settle = (v: OpenTunnel | Failure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      forget();
      resolve(v);
    };
    const timer = setTimeout(() => {
      stop();
      const said = lastLines(output, plan.token);
      settle({ message: `the tunnel gave no address in ${Math.round(o.timeoutMs / 1000)} s`, code: "failed", why: said === "" ? `${plan.bin} printed nothing` : `${plan.bin} printed: ${said}`,
        fix: `its output is the service's, and may have changed: this Mason cannot read it${plan.via === "pinggy" ? ", and --via bore is another tunnel" : ""}. Nothing was left open` });
    }, o.timeoutMs);
    const read = (b: Buffer): void => {
      output = (output + b.toString("utf8")).slice(-KEPT_BYTES);
      if (settled) return;
      const address = tunnelAddress(plan.via, output);
      if (address === null) return;
      settle({ ...address, endsAt: tunnelEnds(plan, output, Date.now()), pid: child.pid!, ended, stop });
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    // the end of stdin would be a command's end, and EPIPE from a client gone is that end, said by its exit
    child.stdin!.on("error", () => undefined);
    child.on("spawn", () => o.onPid?.(child.pid!));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") { settle({ message: `${plan.bin} could not be started: ${e.message}`, code: "failed" }); return; }
      settle({ message: `${plan.bin} is not on this machine's PATH, and --via ${plan.via} needs it`, code: "not_found", fix: `install ${plan.install}${plan.via === "pinggy" ? ", or use --via bore" : ", or use --via pinggy, which needs only ssh"}`,
        next: [[`mason share --via ${plan.via === "pinggy" ? "bore" : "pinggy"}`, "the other tunnel"]] });
    });
    const over = (code: number | null, signal: NodeJS.Signals | null): void => {
      const said = lastLines(output, plan.token);
      const how = signal !== null ? `it was ended (${signal})` : `${plan.bin} exited ${code}`;
      finished(said === "" ? how : `${how}: ${said}`);
      settle({ message: "the tunnel ended before it gave an address", code: "failed", why: said === "" ? how : `${how}: ${said}`,
        fix: plan.via === "pinggy" && /REMOTE HOST IDENTIFICATION|Host key verification failed/i.test(said) ? "the service's host key changed: remove .mason/share-known-hosts if you expected that" : "is this machine online? Port 443 outbound is all it needs" });
    };
    // 'close' waits for its pipes, which a grandchild can hold for ever: 'exit' ends the wait
    let code: number | null = null, signal: NodeJS.Signals | null = null;
    child.on("exit", (c, s) => { code = c; signal = s; setTimeout(() => over(c, s), 200).unref(); });
    child.on("close", () => over(code, signal));
  });
}

/**
 * WHETHER THE ADDRESS IS THIS SHARE: an SSLRequest and a handshake through the tunnel, its certificate read, no login.
 * `other`: something else answered there, a wrong address or something in the way. `unknown`: nothing answered in time
 * (a firewall may keep this machine from a port the BI tool can reach): no verdict, and said so.
 */
export function probeShare(address: { host: string; port: number }, fingerprint: string, timeoutMs = PROBE_MS): Promise<"same" | "other" | "unknown"> {
  return new Promise((resolve) => {
    const socket = net.connect(address.port, address.host);
    let secure: tls.TLSSocket | null = null;
    // the TLS socket owns the connection once it wraps it: destroying the one under it segfaults Node (measured, 24.18)
    const answer = (v: "same" | "other" | "unknown"): void => { clearTimeout(timer); (secure ?? socket).destroy(); resolve(v); };
    const timer = setTimeout(() => answer("unknown"), timeoutMs);
    socket.once("error", () => answer("unknown"));
    socket.once("close", () => answer("unknown"));
    socket.once("connect", () => socket.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
    socket.once("data", (b: Buffer) => {
      if (b[0] !== 0x53 /* S */) { answer("other"); return; }
      socket.removeAllListeners("close");
      secure = tls.connect({ socket, rejectUnauthorized: false, ALPNProtocols: ["postgresql"] });
      secure.once("error", () => answer("unknown"));
      secure.once("secureConnect", () => answer(secure?.getPeerX509Certificate()?.fingerprint256 === fingerprint ? "same" : "other"));
    });
  });
}

/**
 * A TUNNEL OPENED AND ITS ADDRESS CHECKED: the client started (`startTunnel`), then the address it gave probed for this
 * share's certificate (`probeShare`). `verified` false: nothing answered there from this machine (no verdict); an
 * address where something else answers is the Failure, and its client is stopped. ONE way for `mason share` and the
 * web page's share (src/cli/share-page.ts), so the two cannot drift.
 */
export async function openVerifiedTunnel(plan: TunnelPlan, fingerprint: string, o: { timeoutMs: number; onPid?: (pid: number) => void }): Promise<{ tunnel: OpenTunnel; verified: boolean } | Failure> {
  const t = await startTunnel(plan, o);
  if ("message" in t) return t;
  const probe = await probeShare(t, fingerprint);
  if (probe === "other") {
    t.stop();
    return { message: `${t.host}:${t.port} is not this share: something else answers there`, code: "failed", why: "the tunnel printed that address, and the certificate there is not this share's: its output may have changed, or something stands in the way",
      fix: "nothing was left open. Do not connect a tool to that address", next: [["mason share --via bore", "another tunnel"]] };
  }
  return { tunnel: t, verified: probe === "same" };
}
