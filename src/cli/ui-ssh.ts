/**
 * `mason ui --ssh <user@server>`: A SERVER'S WEB PAGE IN THE DEVELOPER'S BROWSER, WITH NOTHING PUBLIC (docs/WEB-UI.md "On
 * a server"). Two processes, one on each end of the machine's own `ssh` (never a library: `~/.ssh/config`, keys, SSO,
 * hardware tokens and a cloud's private route are then the person's, and Mason knows none of them):
 *
 *   browser ── 127.0.0.1:<free port> ── mason ui --ssh ══ ssh, its stdin and stdout ══ mason ui --bridge ── the run's page
 *              on the laptop                                                           on the server, or in its container
 *
 * THE BRIDGE RUNS WHERE THE RUN RUNS, AND THE TUNNEL IS ITS STDIO, NOT `ssh -L`. The page listens on loopback alone, by
 * construction (src/cli/run-server.ts `listenOnLoopback`), and a container's loopback is not its host's: `-L` from the
 * host reaches a port Docker publishes, and Docker publishes to the container's own network address, so `-L` would need
 * the page off loopback. A process inside the container reaches it as it is, so ONE route serves a host and a container,
 * and needs no `AllowTcpForwarding` on the server and no port published or even known.
 *
 * ONE SSH CONNECTION CARRIES EVERY BROWSER CONNECTION (`FrameLink`): a page opens six at once, and a connection per one
 * would mean a touch of a hardware token per one. After the hello line the two ends speak frames: 1 byte type, 4 bytes
 * connection, 4 bytes length, then that many bytes.
 *
 * THE TOKEN STAYS ON THE SERVER: the bridge reads it from the run's config, as every command does, opens the tunnel
 * with it (`POST /api/ui/tunnel`, its connection IS the tunnel) and sends the laptop a ticket (src/cli/security.ts). The
 * hello line is what crosses: nothing secret is on a command line, in the laptop's output or in a log.
 *
 * WHAT `ssh` PRINTS IS NOT OURS: stdout is scanned for the hello line, as a server's shell may print before it; stderr
 * is passed on as it comes, because a person may be asked for a passphrase or a touch there.
 */
import { spawn } from "node:child_process";
import * as net from "node:net";
import { errorJson, nextJson, type Failure, type NextStep } from "./command.ts";
import { holdRun, RunUnreachable } from "./control.ts";
import { whereIs } from "./state.ts";
import { lastLines } from "./tunnel.ts";
import { version } from "./version.ts";

/** What the laptop looks for on the bridge's stdout: this, a space, then one line of JSON. */
export const HELLO = "MASON-UI-BRIDGE";
/** The frames' version: two ends of another say so, whatever their Mason versions. */
export const BRIDGE_PROTOCOL = 1;

const OPEN = 1, DATA = 2, CLOSE = 3;
const HEADER = 9;
/** No end sends more than a socket's read at once: a length past this is not a frame, it is a broken stream. */
const MAX_FRAME = 1024 * 1024;
const STOP_GRACE_MS = 2_000;
/** How long after ssh exits the end is read: a Ctrl-C reaches ssh and this process together. */
const SETTLE_MS = 200;

/** The hello's answer: the tunnel is open, or why not (a Failure, as `--json` prints one). */
export type Hello = { protocol: number; version: string; project: string; ticket: string }
  | { protocol: number; version: string; error: { code: string; message: string; why?: string; fix?: string }; next: Array<{ command: string; what?: string }> };

/** Why a `--ssh` target cannot be given to ssh, or null: a target opening with `-` would be read as ssh's own option. */
export function targetProblem(target: string): string | null {
  return /^[A-Za-z0-9_][A-Za-z0-9._@%+:[\]-]*$/.test(target) ? null : `${JSON.stringify(target)} is not user@server or a Host of your ssh config`;
}

/** The server-side command: `mason`, as `--mason` says to run it there. */
export const bridgeCommand = (mason: string, localPort: number): string => `${mason} ui --bridge --local-port ${localPort}`;

/**
 * THE `ssh` LINE. No secret in it: `ps` shows it. `BatchMode` where nobody can answer a prompt, so ssh fails rather
 * than waits. A shared connection (`ControlPath`) is left out: a master that persists would be an ssh process left
 * behind by Ctrl-C. Forwards from the person's config are cleared: a tunnel of ours must not fail on theirs.
 */
export function sshArgs(target: string, remote: string, interactive: boolean): string[] {
  const options = ["ConnectTimeout=15", "ServerAliveInterval=15", "ServerAliveCountMax=3", "ControlMaster=no", "ControlPath=none", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no",
    ...(interactive ? [] : ["BatchMode=yes"])];
  return ["-T", "-e", "none", ...options.flatMap((o) => ["-o", o]), "--", target, remote];
}

function frame(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(HEADER);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(id, 1);
  head.writeUInt32BE(payload.length, 5);
  return Buffer.concat([head, payload]);
}

interface Pausable { pause(): unknown; resume(): unknown }

/**
 * ONE END OF THE STREAM: many sockets over one pipe each way. `connect` is the bridge's, which dials the page when the
 * laptop opens a connection; the laptop has none and calls `open`. Backpressure is the pipe's: a socket that cannot take
 * more pauses the pipe, and a pipe that cannot take more pauses the sockets, so memory stays bounded and a browser's
 * slow tab can hold the others back a moment, which a page of small JSON answers does not notice.
 */
export class FrameLink {
  private readonly sockets = new Map<number, net.Socket>();
  private readonly input: Pausable;
  private readonly output: NodeJS.WritableStream;
  private readonly connect: (() => net.Socket) | null;
  private readonly broken: (why: string) => void;
  private kept: Buffer = Buffer.alloc(0);
  private next = 1;
  private waiting = false;

  constructor(o: { input: Pausable; output: NodeJS.WritableStream; connect?: () => net.Socket; broken: (why: string) => void }) {
    this.input = o.input; this.output = o.output; this.connect = o.connect ?? null; this.broken = o.broken;
  }

  /** A connection from this end: the laptop's, one per browser connection. */
  open(socket: net.Socket): void {
    const id = this.next++;
    this.send(frame(OPEN, id));
    this.attach(id, socket);
  }

  /** Bytes from the pipe. */
  read(chunk: Buffer): void {
    this.kept = this.kept.length === 0 ? chunk : Buffer.concat([this.kept, chunk]);
    while (this.kept.length >= HEADER) {
      const type = this.kept.readUInt8(0), id = this.kept.readUInt32BE(1), length = this.kept.readUInt32BE(5);
      if (length > MAX_FRAME || type < OPEN || type > CLOSE) { this.broken(`a frame of type ${type} and ${length} bytes: this is not the bridge's stream`); return; }
      if (this.kept.length < HEADER + length) return;
      this.frameIn(type, id, this.kept.subarray(HEADER, HEADER + length));
      this.kept = this.kept.subarray(HEADER + length);
    }
  }

  /** Every connection dropped: the tunnel is gone. */
  end(): void { for (const s of [...this.sockets.values()]) s.destroy(); this.sockets.clear(); }

  private frameIn(type: number, id: number, payload: Buffer): void {
    if (type === OPEN) { if (this.connect !== null) this.attach(id, this.connect()); return; }
    const socket = this.sockets.get(id);
    // the other end closed it while this frame crossed
    if (socket === undefined) return;
    if (type === CLOSE) { this.sockets.delete(id); socket.destroySoon(); return; }
    if (socket.write(Buffer.from(payload))) return;
    this.input.pause();
    const go = (): void => { socket.off("drain", go); socket.off("close", go); this.input.resume(); };
    socket.once("drain", go);
    socket.once("close", go);
  }

  private attach(id: number, socket: net.Socket): void {
    this.sockets.set(id, socket);
    socket.on("data", (b: Buffer) => { this.send(frame(DATA, id, b)); });
    // a browser or the page dropping a connection is an ordinary end, said to the other side by the close below
    socket.on("error", () => undefined);
    socket.on("close", () => { if (this.sockets.delete(id)) this.send(frame(CLOSE, id)); });
  }

  private send(b: Buffer): void {
    if (this.output.write(b) || this.waiting) return;
    this.waiting = true;
    for (const s of this.sockets.values()) s.pause();
    this.output.once("drain", () => { this.waiting = false; for (const s of this.sockets.values()) s.resume(); });
  }
}

// ------------------------------------------------------------------ the server's end: mason ui --bridge

/**
 * `mason ui --bridge`: the hello line, then the frames, until the laptop's end goes (stdin closes), or the run ends the
 * tunnel. A failure is the hello, in the shape the laptop says; what it prints on stderr reaches the laptop through ssh.
 */
export async function bridge(localPort: number): Promise<number> {
  const hello = (h: Hello): void => { process.stdout.write(`${HELLO} ${JSON.stringify(h)}\n`); };
  const refuse = (f: Failure): number => { hello({ protocol: BRIDGE_PROTOCOL, version: version(), error: errorJson(f), next: nextJson(f.next) }); return 1; };
  const w = await whereIs();
  if (w.state !== "up") return refuse({ ...w.problem, message: w.problem.problem });
  const { run } = w;
  let held: Awaited<ReturnType<typeof holdRun>>;
  try { held = await holdRun(run, "/api/ui/tunnel", { port: localPort }); }
  catch (e) {
    if (e instanceof RunUnreachable) return refuse({ message: e.message, code: "unreachable", next: [["mason logs", "the run's log"]] });
    throw e;
  }
  if (!("first" in held)) {
    if (held.status === 404) {
      return refuse({ message: `Mason for ${run.name} serves no web page through a tunnel`, code: "refused", why: "the run was started by a Mason from before mason ui --ssh",
        fix: "restart it on this Mason's version: mason serve's page needs no other setting" });
    }
    const f = held.body.failure as Failure | undefined;
    return refuse(f ?? { message: String(held.body.error ?? `HTTP ${held.status}`), code: "failed" });
  }
  const { first, ended, close } = held;
  hello({ protocol: BRIDGE_PROTOCOL, version: version(), project: run.name, ticket: String(first.ticket) });
  const page = new URL(run.control.url);
  return await new Promise<number>((resolve) => {
    let over = false;
    const done = (code: number): void => { over = true; close(); link.end(); resolve(code); };
    const link = new FrameLink({ input: process.stdin, output: process.stdout, connect: () => net.connect(Number(page.port), "127.0.0.1"),
      broken: (why) => { process.stderr.write(`mason ui --bridge: ${why}\n`); done(1); } });
    process.stdin.on("data", (b: Buffer) => { link.read(b); });
    process.stdin.once("end", () => { done(0); });
    // the laptop's end gone with bytes still to write: the same end as stdin's, which says it
    process.stdout.on("error", () => { done(0); });
    // settles on this end's own close too, which is no news
    void ended.then(() => { if (over) return; process.stderr.write(`mason ui --bridge: Mason for ${run.name} ended the tunnel: it stopped or restarted\n`); done(1); });
  });
}

// ------------------------------------------------------------------ the laptop's end

export interface SshTunnel {
  url: string; port: number; project: string; serverVersion: string;
  /** settles when the tunnel ended by itself, with why; never when `stop` ended it */
  ended: Promise<string>;
  /** ends ssh, and settles once it is gone and the local port is closed */
  stop(): Promise<void>;
}

/** What a Mason that lacks `--bridge` prints: its parser's refusal of the flag, or its usage. */
const OLDER_MASON = /unknown option\b.*--bridge|^usage: mason ui\b/im;

/** The report for an ssh that exited before the bridge said hello, by what its exit means. */
export function exitFailure(o: { target: string; mason: string; code: number | null; signal: NodeJS.Signals | null; said: string; stderr: string }): Failure {
  const { target, mason, code, signal, said, stderr } = o;
  const how = signal !== null ? `ssh was ended (${signal})` : `ssh exited ${code}`;
  const why = said === "" ? how : `${how}: ${said}`;
  const here: NextStep = [`ssh ${target} true`, "whether ssh reaches it on its own"];
  // 127 is a shell's "command not found", and ssh hands on the remote command's exit
  if (code === 127) {
    return { message: `${JSON.stringify(mason)} is not a command on ${target}`, code: "not_found", why,
      fix: `--mason says how to run Mason there: --mason "docker exec -i <container> mason" for a container (docker ps names it), or --mason "/path/to/mason" where a shell ssh opens lacks it on its PATH`, next: [here] };
  }
  // 2 alone proves nothing (a shell exits 2 when its cd fails): an older Mason says so in its own words, read from the
  // whole of stderr, as what it prints after that line pushes it out of `said`
  if (code === 2 && OLDER_MASON.test(stderr)) {
    return { message: `the Mason on ${target} does not know mason ui --bridge`, code: "refused", why, fix: "it is older than mason ui --ssh: upgrade the server's Mason to this one's version", next: [["mason --version", "this machine's"]] };
  }
  if (code === 255 && /host key|host identification/i.test(stderr)) {
    return { message: `ssh does not trust the host key of ${target}`, code: "failed", why,
      fix: `run ssh ${target} on its own and check the key before you accept it: mason ui --ssh never answers that question for you`, next: [here] };
  }
  if (code === 255) {
    return { message: `ssh could not reach ${target}`, code: "failed", why,
      fix: `run ssh ${target} on its own: this uses your ~/.ssh/config, as that does. A firewall rule that names your old IP address is the common cause`, next: [here] };
  }
  return { message: `the bridge on ${target} ended before it answered`, code: "failed", why, fix: `run ${bridgeCommand(mason, 1)} there to see why`, next: [here] };
}

/** A hello's refusal, in the words of who reads it: on this machine, about that one. */
function refusal(h: Extract<Hello, { error: unknown }>, target: string): Failure {
  const lost = h.error.code === "no_project", stopped = h.error.code === "not_running";
  const fix = lost ? `ssh lands in a folder with no Mason project. --mason says where it is: --mason "cd <MASON_DATA> && mason", or --mason "docker exec -i <container> mason"`
    : stopped ? `start mason serve on ${target}: its service or container` : h.error.fix;
  // these two say mason init and mason start, words for a person at that machine: run here they would do the wrong thing
  const next = lost || stopped ? [] : h.next.map((n): NextStep => n.what === undefined ? [n.command] : [n.command, n.what]);
  return { message: `on ${target}: ${h.error.message}`, code: h.error.code, ...(h.error.why ? { why: h.error.why } : {}), ...(fix ? { fix } : {}), next };
}

/** Starts ssh and the bridge, with a free loopback port before them: the tunnel, or why not. */
export function openSshTunnel(o: { target: string; mason: string; timeoutMs: number; interactive: boolean; stopped: Promise<unknown> }): Promise<SshTunnel | Failure> {
  return new Promise((resolve) => {
    let link: FrameLink | null = null;
    // no link yet: nothing was handed out that names this port, so nothing that connects is ours
    const local = net.createServer((socket) => { if (link === null) socket.destroy(); else link.open(socket); });
    local.once("error", (e) => { resolve({ message: `no local port could be opened: ${e.message}`, code: "failed" }); });
    local.listen(0, "127.0.0.1", () => {
      const port = (local.address() as net.AddressInfo).port;
      const child = spawn("ssh", sshArgs(o.target, bridgeCommand(o.mason, port), o.interactive), { stdio: ["pipe", "pipe", "pipe"] });
      let output = Buffer.alloc(0), said = "", settled = false, stopping = false, finish: (why: string) => void = () => undefined;
      const ended = new Promise<string>((r) => { finish = r; });
      let gone: () => void = () => undefined;
      const exited = new Promise<void>((r) => { gone = r; });
      const stop = (): Promise<void> => {
        stopping = true;
        link?.end();
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, STOP_GRACE_MS).unref();
        }
        return Promise.all([exited, new Promise<void>((r) => { local.close(() => r()); })]).then(() => undefined);
      };
      const settle = (v: SshTunnel | Failure): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const fail = (f: Failure): void => { if (settled) return; settle(f); void stop(); };
      const timer = setTimeout(() => {
        const last = lastLines(said, null);
        fail({ message: `no answer from ${o.target} in ${Math.round(o.timeoutMs / 1000)} s`, code: "failed", ...(last === "" ? {} : { why: `ssh printed: ${last}` }),
          fix: `run ssh ${o.target} on its own to see where it waits; --timeout gives it longer`, next: [[`ssh ${o.target} true`, "whether ssh reaches it on its own"]] });
      }, o.timeoutMs);
      // Ctrl-C before an answer: ssh goes too, a process signalled alone included
      void o.stopped.then(() => { fail({ message: "stopped before the server answered", code: "failed" }); });
      const helloIn = (h: Hello): void => {
        if ("error" in h) { fail(refusal(h, o.target)); return; }
        if (h.protocol !== BRIDGE_PROTOCOL) {
          fail({ message: `the Mason on ${o.target} (${h.version}) and this one (${version()}) speak different bridges`, code: "refused", why: `its bridge is version ${h.protocol}, this one's ${BRIDGE_PROTOCOL}`,
            fix: "run the same Mason version on both ends", next: [["mason --version", "this machine's"]] });
          return;
        }
        // what a later drop repeats is what ssh says from here on, never the login's banner
        said = "";
        settle({ url: `http://127.0.0.1:${port}/?ticket=${encodeURIComponent(h.ticket)}`, port, project: h.project, serverVersion: h.version, ended, stop });
      };
      child.stdout.on("data", (b: Buffer) => {
        if (link !== null) { link.read(b); return; }
        output = Buffer.concat([output, b]);
        const at = output.indexOf(`${HELLO} `);
        const eol = at < 0 ? -1 : output.indexOf("\n", at);
        if (eol < 0) { if (output.length > MAX_FRAME) output = output.subarray(-MAX_FRAME); return; }
        const rest = output.subarray(eol + 1);
        let h: Hello;
        try { h = JSON.parse(output.subarray(at + HELLO.length + 1, eol).toString("utf8")) as Hello; }
        catch (e) { fail({ message: `the bridge on ${o.target} said something that is not its hello`, code: "failed", why: (e as Error).message, fix: "run the same Mason version on both ends" }); return; }
        link = new FrameLink({ input: child.stdout, output: child.stdin, broken: (why) => { finish(why); void stop(); } });
        helloIn(h);
        if (rest.length > 0) link.read(rest);
      });
      child.stderr.on("data", (b: Buffer) => { said = (said + b.toString("utf8")).slice(-16 * 1024); process.stderr.write(b); });
      // ssh gone with bytes still to write: said by its exit
      child.stdin.on("error", () => undefined);
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") {
          fail({ message: "ssh is not on this machine's PATH, and mason ui --ssh runs it", code: "not_found", fix: "install the OpenSSH client (it comes with macOS, Windows 10 and later, and most Linux; apt install openssh-client)" });
          gone();
          return;
        }
        fail({ message: `ssh could not be started: ${e.message}`, code: "failed" });
        gone();
      });
      child.on("exit", (code, signal) => {
        gone();
        // read after a moment: a Ctrl-C reaches ssh and this process together, and `stop` says which end it was
        setTimeout(() => {
          const last = lastLines(said, null);
          if (!settled) { fail(exitFailure({ target: o.target, mason: o.mason, code, signal, said: last, stderr: said })); return; }
          if (stopping) return;
          link?.end();
          local.close();
          finish(last === "" ? `ssh exited ${code ?? signal}` : `ssh exited ${code ?? signal}: ${last}`);
        }, SETTLE_MS).unref();
      });
    });
  });
}
