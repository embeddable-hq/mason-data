/**
 * THE BRIDGE'S STDIN, READ ON A THREAD OF ITS OWN, AND ITS WATCHDOG (src/cli/ui-ssh.ts `bridge`, `StdinByWorker`).
 *
 * `mason ui --bridge` ends when its stdin ends: the laptop's ssh gone. Heard on the main thread, that end waits on the
 * main event loop, and a loop that is blocked (a synchronous call that never returns, a hung native call, a busy loop)
 * never hears it: the process would live on, holding the run's tunnel, with nobody left who can end it. So this thread
 * owns fd 0, on an event loop of its own (Node's docs, worker_threads: "each Worker has its own event loop"), forwards
 * its bytes to the main thread, and on its end arms a timer here; if the process is still alive when it fires, the main
 * thread did not end it, so this one does, by SIGKILL to the process (`process.kill`, which a worker may call: a signal
 * is delivered by the system, not by a loop, and SIGKILL cannot be caught or delayed by anything the process runs).
 *
 * THE FLOW CONTROL IS THIS THREAD'S, BY CREDIT: it hands the main thread at most `windowBytes` it has not acknowledged
 * (`ack`: consumed, and FrameLink not paused), and stops reading at that bound (`stream.pause()`, so the pipe fills
 * and the laptop's writes wait, as they did on `process.stdin`). Nothing is read into memory past it, whatever the main
 * thread does. A stopped reader cannot hear stdin's end, so the main thread says it is alive (`beat`, every
 * `BEAT_MS`): a main thread that is only waiting (on the run's page taking what was sent) keeps beating and the reader
 * waits with it; one silent for `exitMs` with the window full is STUCK, and this thread then reads on and DROPS what it
 * reads, so that the end is heard and the watchdog can fire. The stream it fed is then broken, which the main thread is
 * told (`dropped`): if it ever runs again it ends the bridge, exit 1, never reads past the hole.
 *
 * fd 0 is opened as Node opens `process.stdin` for its kind (Node's docs, process.stdin, net.Socket `fd`, tty.ReadStream,
 * fs.createReadStream `fd`): a pipe or a socket (ssh's, `docker exec -i`'s) as a `net.Socket`, a terminal (`ssh -t`) as a
 * `tty.ReadStream`, anything else (a file, /dev/null) as a file stream, which always reaches its end. A read error is an
 * end too (a terminal hung up reads EIO). A stdin that cannot be opened at all is said, and ends the bridge.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import type { Readable } from "node:stream";
import * as tty from "node:tty";
import { parentPort, workerData, type MessagePort } from "node:worker_threads";

/** What the main thread sends: bytes it has consumed, or that it is alive. */
export type ToStdin = { ack: number } | { beat: true };
/** What this thread sends: bytes read, the end with why (`null`: an ordinary end), or that bytes were dropped. */
export type FromStdin = { data: Uint8Array } | { end: string | null; failed: boolean } | { dropped: number };

const { exitMs, windowBytes } = workerData as { exitMs: number; windowBytes: number };
if (parentPort === null) throw new Error("src/cli/bridge-stdin.ts is a worker thread's script, started by src/cli/ui-ssh.ts");
const port: MessagePort = parentPort;

let over = false;
/** Bytes handed to the main thread that it has not acknowledged. */
let owed = 0;
let lastHeard = Date.now();
let dropping = false;

/** The end, once: said to the main thread, then the watchdog armed. */
function finish(why: string | null, failed = false): void {
  if (over) return;
  over = true;
  port.postMessage({ end: why, failed } satisfies FromStdin);
  setTimeout(() => {
    try { fs.writeSync(2, `mason ui --bridge: its stdin closed ${exitMs / 1000} s ago and it had not ended (its main thread is blocked): ended now, and the tunnel with it\n`); }
    catch (e) { void e; /* stderr gone too, as the laptop's ssh is: the kill below is what ends the process */ }
    process.kill(process.pid, "SIGKILL");
  }, exitMs);
}

function open(): Readable {
  if (tty.isatty(0)) return new tty.ReadStream(0);
  const kind = fs.fstatSync(0);
  if (kind.isFIFO() || kind.isSocket()) return new net.Socket({ fd: 0, readable: true, writable: false });
  return fs.createReadStream("", { fd: 0, autoClose: false });
}

let input: Readable | null = null;
try { input = open(); }
catch (e) { finish(`its stdin cannot be read: ${(e as Error).message}`, true); }

if (input !== null) {
  const stream = input;
  stream.on("data", (b: Buffer) => {
    if (dropping) return;
    const copy = Uint8Array.from(b);
    port.postMessage({ data: copy } satisfies FromStdin, [copy.buffer]);
    owed += b.length;
    if (owed >= windowBytes) stream.pause();
  });
  stream.once("end", () => { finish(null); });
  stream.once("error", (e: Error) => { finish(`its stdin: ${e.message}`); });
  stream.once("close", () => { finish(null); });
  port.on("message", (m: ToStdin) => {
    lastHeard = Date.now();
    if (!("ack" in m) || dropping) return;
    owed -= m.ack;
    if (owed < windowBytes && stream.isPaused()) stream.resume();
  });
  // a main thread silent for the bound while the window is full is stuck: read on, dropping, so the end is heard
  const look = setInterval(() => {
    if (dropping || over || owed < windowBytes || Date.now() - lastHeard < exitMs) return;
    dropping = true;
    clearInterval(look);
    port.postMessage({ dropped: owed } satisfies FromStdin);
    stream.resume();
  }, Math.min(250, exitMs));
}
