/**
 * THE DEMO PROJECT, THE CLI'S SIDE (`mason init demo`; the database itself is src/demo/source.ts): a project whose
 * database is one Mason hosts itself — a Postgres in this process, persisted in `.mason/demo/`, served on a loopback
 * port over the Postgres wire protocol and seeded with a small shop schema — so a person tries Mason with nothing to
 * install. The project stays an ordinary one: its sources file names `url: ${DATABASE_URL}` and three of the four
 * tables (the fourth, `DEMO_TABLE_TO_ADD`, is the person's to add), `.env` the demo's URL, and `mason start` reads it
 * over the wire as it reads any Postgres, so the demo runs the read path production runs (docs/DESIGN.md "The demo
 * database").
 *
 *   - THE PORT LIVES IN THE URL ALONE: `mason init demo` picks one free and writes it into `.env`; `mason start` reads
 *     it back from the resolved URL (`demoPort`), never from a second record that could disagree with it.
 *   - POLL ONLY: the demo database has no change log (no WAL sender), so `--replication` is refused before anything
 *     starts (`demoChangesRefusal`).
 *   - A WRITER: every MASON_DEMO_CHANGE_MS (`demoSettings`) the run makes one round of changes (`demoChanges`), so the
 *     copy is seen keeping current.
 *
 * The demo's module is imported when it is used (`demoModule`): a command that never hosts it never loads its database;
 * its URL and names are src/demo/seed.ts's, which loads none.
 */
import * as path from "node:path";
import type { DemoSource } from "../demo/source.ts";
import type { Failure } from "./command.ts";
import type { ChangeSource } from "../cdc/poll.ts";
import { parseSource, isLocalHost } from "./preflight.ts";
import { changesOf } from "./replication-mode.ts";
import { heldText, portHolder } from "./ports.ts";
import { DEMO_DIR, STATE_DIR, type ProjectConfig } from "./project.ts";
import { DEMO_DATABASE, DEMO_USER, demoUrl } from "../demo/seed.ts";

/** What `mason init` takes in the URL's place to make a demo project. */
export const DEMO_ARG = "demo";

/** The port `mason init demo` prefers for the demo database (the next free one when it is held): beside Mason's 5433. */
export const DEMO_PORT = 5434;

/** The demo database's tables (the seed's own list), the ones `mason init demo` adds to the sources file and the one it
 *  leaves for the person to add, and its URL (src/demo/seed.ts: no PGlite is loaded by it, so `mason init demo` and
 *  `demoPort` never load the database). */
export { DEMO_ADDED_TABLES, DEMO_SYNC, DEMO_TABLES, DEMO_TABLE_TO_ADD, demoUrl } from "../demo/seed.ts";

/** How often the run changes the demo database by default (MASON_DEMO_CHANGE_MS). */
export const DEMO_CHANGE_MS = 5000;
const DEMO_CHANGE_MIN_MS = 100;

/** The demo database's module (`DemoSource`, and PGlite with it), loaded when the run hosts it, never to build or read
 *  its URL (src/demo/seed.ts has those). */
export const demoModule = (): Promise<typeof import("../demo/source.ts")> => import("../demo/source.ts");

/** What the run reads of the demo from its environment: how often it changes the database. Throws on a value that is no
 *  number of milliseconds, said with the way out (as src/duck/sync.ts copyParallelOf). */
export function demoSettings(env: NodeJS.ProcessEnv): { changeMs: number } {
  const v = env.MASON_DEMO_CHANGE_MS;
  if (v === undefined || v === "") return { changeMs: DEMO_CHANGE_MS };
  const n = Number(v);
  if (!/^\d+$/.test(v.trim()) || n < DEMO_CHANGE_MIN_MS) {
    throw new Error(`MASON_DEMO_CHANGE_MS=${JSON.stringify(v)} is not a number of milliseconds: how often the demo database changes (a new order, an older one's status moved on); ` +
      `set it to ${DEMO_CHANGE_MIN_MS} or more, or unset it for ${DEMO_CHANGE_MS}`);
  }
  return { changeMs: n };
}

/**
 * THE DEMO DATABASE'S PORT, READ FROM THE URL THE SOURCES FILE RESOLVED (`from` says where: `DATABASE_URL in .env`) — or
 * why that URL is not the demo's, with the way out: a host off this machine (the demo database listens on 127.0.0.1
 * alone), or any other change to `postgres://demo@127.0.0.1:<port>/demo`. The port is the one fact that may differ.
 */
export function demoPort(url: string, from: string): { port: number } | { problem: string } {
  const wayOut = "mason destroy and mason init demo again in a new folder, or put the URL back";
  const parsed = parseSource(url);
  if ("problem" in parsed) return { problem: `${from} was changed: ${parsed.problem}. The demo database is postgres://${DEMO_USER}@127.0.0.1:<port>/${DEMO_DATABASE}; ${wayOut}` };
  const s = parsed.source;
  // loopback alone: the demo database listens on nothing else (0.0.0.0 or a container's host name is not it)
  if (!isLocalHost(s.host) || s.host === "0.0.0.0" || s.host === "host.docker.internal") {
    return { problem: `${from} names ${s.host}, which is not this machine's loopback: the demo database is hosted by mason start on 127.0.0.1 alone (${demoUrl(s.port)}); ${wayOut}` };
  }
  if (s.url !== demoUrl(s.port)) return { problem: `${from} was changed: the demo database is ${demoUrl(s.port)}; ${wayOut}` };
  return { port: s.port };
}

/** The refusal of logical replication for a demo project (the flag, or a mode the config was edited to): before
 *  anything starts, with the way out; null for any other project, or a demo one polled. */
export function demoChangesRefusal(cfg: Pick<ProjectConfig, "demo" | "changes">, flag: ChangeSource | null): Failure | null {
  if (cfg.demo !== true || changesOf(flag, cfg.changes) !== "replication") return null;
  return { message: "the demo database is read by polling only: --replication does not apply to it", code: "refused",
    why: "the demo database has no change log for logical replication to read; mason start polls it with SELECTs, every few seconds",
    fix: flag === "replication" ? "mason start, without --replication" : `remove "changes": "replication" from ${STATE_DIR}/config.json, then mason start`,
    next: [["mason start", "the demo database and Mason, polled"]] };
}

/** The demo database's handle as the run uses it (a test's fake has these alone). */
export type HostedDemo = Pick<DemoSource, "port" | "seeded" | "change" | "close">;

/** The step's done line: where the demo database listens, and whether it was seeded now or kept from the last run. */
export function demoDoneLine(port: number, seeded: boolean): string {
  return `Demo database on 127.0.0.1:${port} (Postgres, hosted by this process in ${STATE_DIR}/${DEMO_DIR}; ${seeded ? "seeded with the shop schema" : "kept from the last run"})`;
}

/**
 * THE DEMO DATABASE OPENED for the run in `home`/demo (`home` the project's `.mason/`), its events to `log`: the handle and
 * the step's done line, or why it did not open — its own message (what failed), and when something holds the port, the
 * way out ONCE, with its choices: mason stop for a run of this project's that may still hold it, stop what does, or move
 * the demo database by changing the port in its URL, where `from` says the URL is (`DATABASE_URL in .env`: the port
 * lives there alone). The port is free for every other reason, so the probe tells a held port apart without reading
 * the message.
 */
export async function openDemo(o: { home: string; port: number; from: string; log: (line: string) => void; open?: (o: { dir: string; port: number; log: (line: string) => void }) => Promise<HostedDemo> }):
  Promise<{ demo: HostedDemo; done: string } | { problem: string }> {
  const open = o.open ?? (async (a) => (await demoModule()).DemoSource.open(a));
  try {
    const demo = await open({ dir: path.join(o.home, DEMO_DIR), port: o.port, log: o.log });
    return { demo, done: demoDoneLine(demo.port, demo.seeded) };
  } catch (e) {
    const problem = `the demo database did not start: ${(e as Error).message}`;
    const held = await portHolder(o.port);
    if (held === null) return { problem };
    const move = `move the demo database: change the port in ${o.from} (postgres://${DEMO_USER}@127.0.0.1:<another>/${DEMO_DATABASE}) and mason start again`;
    return { problem: held.code === "EACCES"
      ? `${problem} (${heldText(o.port, held)}): ${move}`
      : `${problem}: mason stop ends a run that may still hold it, else stop what does (lsof -nP -iTCP:${o.port} -sTCP:LISTEN names it), or ${move}` };
  }
}

/**
 * THE WRITER: one round of changes every `ms`, each said to `log` as the demo says it; a round that fails is said and
 * the next one tried, and a round is never begun while the last one runs. Returns what stops it (idempotent).
 */
export function demoChanges(demo: Pick<HostedDemo, "change">, ms: number, log: (line: string) => void): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    demo.change().then((line) => log(line), (e: unknown) => log(`a change failed (the next one is tried in ${ms / 1000} s): ${(e as Error).message}`))
      .finally(() => { busy = false; });
  }, ms);
  return () => clearInterval(timer);
}

/** The demo database closed once, however often it is asked: null when it closed, else what went wrong (said by the
 *  caller, never swallowed). */
export function closingOnce(demo: Pick<HostedDemo, "close">): () => Promise<string | null> {
  let closing: Promise<string | null> | null = null;
  return () => closing ??= demo.close().then(() => null, (e: unknown) => (e as Error).message);
}

/** What the crash path says of a demo database still closing when it stops waiting (`closedWithin`). */
export const DEMO_STILL_CLOSING = (ms: number): string =>
  `closing the demo database: still closing after ${ms / 1000} s; its data may need seeding again at the next start`;

/**
 * A close waited for `ms` at most, and SAID when it is not done by then (`late`), never left silent: the crash path
 * stops waiting so the supervisor can start the run again. The timer is cleared when the close wins, and is not
 * unref'd, so a close that hangs is said before the process ends. A close that rejects rejects this.
 */
export async function closedWithin(closing: Promise<unknown>, ms: number, late: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), ms); });
  try {
    if (await Promise.race([closing.then(() => false as const), timedOut])) late();
  } finally {
    clearTimeout(timer);
  }
}
