/**
 * A PORT FOR A LISTENER A TEST STARTS LATER, in another process (a `mason start` with MASON_PG_PORT, the demo
 * database's port in .env, a `mason serve`'s MASON_HEALTH_PORT).
 *
 * The class: A PORT PROBED FREE AND USED LATER IS A RACE. A probe that binds port 0 and lets go hands back a port from
 * the kernel's EPHEMERAL range, the pool every other `listen(0)` and every outgoing connection's source port is drawn
 * from too. Under `node --test` the files run in parallel and draw from that pool all the time (each test's listeners,
 * each run's command server, each pg client), so the port is taken before the later bind as often as the pool turns
 * over: CI saw `listen EADDRINUSE: address already in use 127.0.0.1:43725` at tests/cli-demo-start.test.ts's first
 * mason start, and every later step failed with it. A retry does not end the class, only makes it rarer.
 *
 * The decision that makes it impossible: the port is chosen OUTSIDE the ephemeral range, which the kernel reads from
 * `ip_local_port_range` (Linux) or `net.inet.ip.portrange.*` (macOS) here, so the kernel never hands it to anyone — no
 * `listen(0)`, no connect. What could still take it is a process that binds that fixed port by name, so:
 *   - every caller of this module CLAIMS the port it picked, by a lock file `<tmpdir>/mason-test-ports/<port>` created
 *     exclusively (O_EXCL) and removed when its process exits: two test files of one check, or two worktrees' checks on
 *     one machine, never pick the same port, and one process never picks a port twice;
 *   - the port is probed free on every address a client may use (src/cli/ports.ts `portHolder`, the probe mason start
 *     uses), so a service already running on it (a developer's own) is skipped;
 *   - the range starts at 10000, above the ports services are given by name (Postgres 5432, Mason 5433, the demo 5434).
 * A process outside the test suite that starts during the run and binds exactly this port by name is the one thing a
 * test cannot rule out; nothing in the suite or the kernel does that.
 *
 * A lock file left by a run that was killed (no exit handler ran) only takes its port out of the thousands of
 * candidates; it is never taken over, because two processes taking over one stale lock at once would both own it.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { portHolder } from "../src/cli/ports.ts";

/** The lowest port chosen: below are the ports services are given by name (5432, 5433, 5434, 8080, …). */
export const LOWEST = 10_000;
const HIGHEST = 65_535;
const TRIES = 200;

/** The ports the kernel assigns to `listen(0)` and to a connection's source port, as this machine is configured. */
export function ephemeralRange(): { first: number; last: number } {
  if (process.platform === "linux") {
    const file = "/proc/sys/net/ipv4/ip_local_port_range";
    const text = fs.readFileSync(file, "utf8");
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
    if (!m) throw new Error(`tests/test-ports.ts: ${file} is not "<first> <last>": ${JSON.stringify(text)}`);
    return { first: Number(m[1]), last: Number(m[2]) };
  }
  if (process.platform === "darwin") {
    // the default range (first..last) and the one a socket asking IP_PORTRANGE_HIGH gets (hifirst..hilast): both excluded
    const keys = ["net.inet.ip.portrange.first", "net.inet.ip.portrange.last", "net.inet.ip.portrange.hifirst", "net.inet.ip.portrange.hilast"];
    const out = execFileSync("sysctl", ["-n", ...keys], { encoding: "utf8" });
    const n = out.trim().split(/\s+/).map(Number);
    if (n.length !== 4 || n.some((x) => !Number.isInteger(x))) throw new Error(`tests/test-ports.ts: sysctl -n ${keys.join(" ")} did not answer four ports: ${JSON.stringify(out)}`);
    const [first, last, hifirst, hilast] = n as [number, number, number, number];
    return { first: Math.min(first, hifirst), last: Math.max(last, hilast) };
  }
  throw new Error(`tests/test-ports.ts reads the kernel's ephemeral port range on Linux and macOS, not ${process.platform}: add how this platform says it`);
}

/** A port in [LOWEST, 65535] outside the ephemeral range, at random. */
function randomCandidate(range: { first: number; last: number }): number {
  const ports: Array<[number, number]> = [[LOWEST, Math.min(range.first - 1, HIGHEST)], [Math.max(range.last + 1, LOWEST), HIGHEST]];
  const spans = ports.filter(([a, b]) => b >= a);
  const total = spans.reduce((s, [a, b]) => s + (b - a + 1), 0);
  if (total === 0) throw new Error(`tests/test-ports.ts: the ephemeral range ${range.first}-${range.last} covers every port from ${LOWEST} to ${HIGHEST}, so none is out of the kernel's reach`);
  let i = Math.floor(Math.random() * total);
  for (const [a, b] of spans) { if (i <= b - a) return a + i; i -= b - a + 1; }
  throw new Error("unreachable: the index is below the total");
}

const DEFAULT_LOCKS = path.join(os.tmpdir(), "mason-test-ports");
const claimed = new Set<string>();
let releasing = false;

/** Claim `port` for this process: true when this process created its lock file, false when another holds it. */
function claim(locks: string, port: number): boolean {
  fs.mkdirSync(locks, { recursive: true });
  const file = path.join(locks, String(port));
  try { fs.writeFileSync(file, `${process.pid}\n`, { flag: "wx" }); }
  catch (e) {
    // EEXIST is the answer "another holds it"; anything else is a failure to say
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  claimed.add(file);
  if (!releasing) {
    releasing = true;
    // force: a lock file someone removed by hand is already released
    process.on("exit", () => { for (const f of claimed) fs.rmSync(f, { force: true }); });
  }
  return true;
}

function release(file: string): void {
  claimed.delete(file);
  fs.rmSync(file, { force: true });
}

/**
 * A port no other process can be handed while this one runs: outside the kernel's ephemeral range, claimed for this
 * process, and free on every address now. `candidates` and `locks` are for this module's own test.
 */
export async function unassignedPort(opts: { candidates?: () => number; locks?: string } = {}): Promise<number> {
  const range = ephemeralRange();
  const next = opts.candidates ?? (() => randomCandidate(range));
  const locks = opts.locks ?? DEFAULT_LOCKS;
  const seen: string[] = [];
  for (let i = 0; i < TRIES; i++) {
    const port = next();
    if (port >= range.first && port <= range.last) throw new Error(`tests/test-ports.ts: candidate ${port} is in the ephemeral range ${range.first}-${range.last}`);
    const file = path.join(locks, String(port));
    if (claimed.has(file) || !claim(locks, port)) { seen.push(`${port} claimed`); continue; }
    const held = await portHolder(port);
    if (held === null) return port;
    release(file);
    seen.push(`${port} held on ${held.address} (${held.code})`);
  }
  throw new Error(`tests/test-ports.ts: no free port outside the ephemeral range after ${TRIES} tries (${seen.slice(-5).join("; ")}); stale claims are in ${locks}`);
}
