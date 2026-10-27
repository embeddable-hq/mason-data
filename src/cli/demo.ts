/**
 * THE DEMO PROJECT, THE CLI'S SIDE (`mason init demo`; the database itself is src/demo/source.ts): a project whose
 * database is one Mason hosts itself — a Postgres in this process, persisted in `.mason/demo/`, served on a loopback
 * port over the Postgres wire protocol and seeded with a small shop schema — so a person tries Mason with nothing to
 * install. The project stays an ordinary one: its sources file names `url: ${DATABASE_URL}` and the four tables, `.env`
 * the demo's URL, and `mason start` reads it over the wire as it reads any Postgres, so the demo runs the read path
 * production runs (docs/DESIGN.md "The demo database").
 *
 *   - THE PORT LIVES IN THE URL ALONE: `mason init demo` picks one free and writes it into `.env`; `mason start` reads
 *     it back from the resolved URL (`demoPort`), never from a second record that could disagree with it.
 *   - POLL ONLY: the demo database has no change log (no WAL sender), so `--replication` is refused before anything
 *     starts (`demoChangesRefusal`).
 *   - A WRITER: every MASON_DEMO_CHANGE_MS (`demoSettings`) the run makes one round of changes (`demoChanges`), so the
 *     copy is seen keeping current.
 *
 * The demo's module is imported when it is used (`demoModule`): a command that never hosts it never loads its database.
 */
import * as path from "node:path";
import type { DemoSource } from "../demo/source.ts";
import type { Failure } from "./command.ts";
import type { ChangeSource } from "../cdc/poll.ts";
import { parseSource, isLocalHost } from "./preflight.ts";
import { changesOf } from "./replication-mode.ts";
import { heldText, portHolder } from "./ports.ts";
import { DEMO_DIR, STATE_DIR, type ProjectConfig } from "./project.ts";

/** What `mason init` takes in the URL's place to make a demo project. */
export const DEMO_ARG = "demo";

/** The port `mason init demo` prefers for the demo database (the next free one when it is held): beside Mason's 5433. */
export const DEMO_PORT = 5434;

/** The demo database's tables (src/demo/source.ts seeds them), which `mason init demo` adds to the sources file. */
export const DEMO_TABLES = ["customers", "products", "orders", "order_items"] as const;

/** How often the run changes the demo database by default (MASON_DEMO_CHANGE_MS). */
export const DEMO_CHANGE_MS = 5000;
const DEMO_CHANGE_MIN_MS = 100;

/** The demo database's module, loaded when it is needed. */
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
export async function demoPort(url: string, from: string): Promise<{ port: number } | { problem: string }> {
  const { demoUrl, DEMO_USER, DEMO_DATABASE } = await demoModule();
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
 * the step's done line, or why it did not open — its own message, and when something holds the port, who, with the way
 * out (the port is free for every other reason, so the probe tells a held port apart without reading the message).
 */
export async function openDemo(o: { home: string; port: number; log: (line: string) => void; open?: (o: { dir: string; port: number; log: (line: string) => void }) => Promise<HostedDemo> }):
  Promise<{ demo: HostedDemo; done: string } | { problem: string }> {
  const open = o.open ?? (async (a) => (await demoModule()).DemoSource.open(a));
  try {
    const demo = await open({ dir: path.join(o.home, DEMO_DIR), port: o.port, log: o.log });
    return { demo, done: demoDoneLine(demo.port, demo.seeded) };
  } catch (e) {
    const held = await portHolder(o.port);
    return { problem: `the demo database did not start: ${(e as Error).message}` +
      (held ? ` (${heldText(o.port, held)}: mason stop ends a run that may still hold it, else stop what does — lsof -nP -iTCP:${o.port} -sTCP:LISTEN names it)` : "") };
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
