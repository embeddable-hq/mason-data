/**
 * THE COMMANDS' LINE TO A RUN: `mason status`, `mason tables`, `mason add` and `mason wait` ask the run's
 * command server (src/cli/run-server.ts) — with the
 * run's token as `Authorization: Bearer` (src/cli/security.ts), read from the project's .mason/config.json (src/cli/runs.ts).
 */
import * as http from "node:http";
import type { DevRun } from "./runs.ts";
import type { Failure } from "./command.ts";
import { CATALOG_READ_HEADER, CATALOG_READ_TIMEOUT_MS } from "./source-catalog.ts";

/** The run does not answer: a failure with the reason as `why` and mason logs as the way out (`failure` is what a command
 *  hands src/cli/command.ts failed). */
export class RunUnreachable extends Error {
  readonly failure: Failure;
  constructor(message: string, why?: string) {
    super(message);
    this.failure = { message, code: "unreachable", why, next: [["mason logs", "why it does not answer"], ["mason status", "whether it runs at all"]] };
  }
}

/** One request to the run. A reply with an error status is returned (its `error` is the sentence to show). `timeoutMs`
 *  is for a request that does work on the database (mason sync scans a table whole): the others answer in moments. */
export async function callRun(run: DevRun, method: "GET" | "POST", route: string, body?: unknown, timeoutMs = 30_000,
  headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown>; read: number | null }> {
  let res: Response;
  try {
    res = await fetch(run.control.url + route, {
      method,
      headers: { ...headers, Authorization: `Bearer ${run.control.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = (e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message;
    throw new RunUnreachable(`Mason for ${run.name} (pid ${run.pid}) does not answer at ${run.control.url}`, why);
  }
  const text = await res.text();
  let parsed: Record<string, unknown>;
  // the setup server answers JSON; anything else is an error to show as it came
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: text.trim() || `HTTP ${res.status}` }; }
  // the number of the read of the database's tables the run acted on, when it says one (src/cli/source-catalog.ts)
  const read = res.headers.get(CATALOG_READ_HEADER);
  return { status: res.status, body: parsed, read: read !== null && /^[1-9][0-9]{0,15}$/.test(read) ? Number(read) : null };
}

/**
 * A REQUEST THAT ACTS ON THE DATABASE'S TABLES (an add, a remove; src/cli/source-catalog.ts): it carries the number of
 * the read an earlier request of the same command was given (`read`), so one read serves the whole command, and while
 * that read still runs (a 503 saying `catalogRead`: a large catalog takes longer than one request may wait) it asks
 * again carrying it — waiting on the same read, never a new one — until the read ends or fails, or `CATALOG_READ_TIMEOUT_MS`
 * passes (the re-check of PR 900: an add of a 10,000-table catalog, 44 s a read, failed ten times as "still being read").
 */
export async function callRunReading(run: DevRun, method: "GET" | "POST", route: string, body: unknown, read: number | null = null,
  o: { progress?: (said: string) => void } = {}): Promise<{ status: number; body: Record<string, unknown>; read: number | null }> {
  let carried = read;
  const until = Date.now() + CATALOG_READ_TIMEOUT_MS;
  for (;;) {
    const r = await callRun(run, method, route, body, 30_000, carried !== null ? { [CATALOG_READ_HEADER]: String(carried) } : {});
    const again = r.status === 503 && typeof r.body.catalogRead === "number" && Number.isInteger(r.body.catalogRead);
    if (!again || Date.now() > until) return { ...r, read: r.read ?? carried };
    // a person sees the wait go on (the run's own words: how long the read has run), never a silence or a failure
    o.progress?.(String(r.body.error));
    carried = r.body.catalogRead as number;
  }
}

/** A request whose answer stays open (`POST /api/share`): its first line, while the connection is the thing held. */
export interface HeldAnswer {
  first: Record<string, unknown>;
  /** settles when the run ended the answer or the connection went: what it said, or null */
  ended: Promise<string | null>;
  /** lets go of the connection: the run takes that as the end */
  close(): void;
}

/**
 * ONE REQUEST HELD OPEN (src/cli/share.ts): the run answers a line of JSON and keeps the answer open, so the end of the
 * connection is the end of what was asked, however this process ends. On node:http, not fetch: fetch gives up on a body
 * silent for five minutes, and here silence is the normal state. A refusal is answered whole, as `callRun` returns it.
 */
export function holdRun(run: DevRun, route: string, body: unknown, timeoutMs = 30_000): Promise<HeldAnswer | { status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const unreachable = (why: string): RunUnreachable => new RunUnreachable(`Mason for ${run.name} (pid ${run.pid}) does not answer at ${run.control.url}`, why);
    const text = JSON.stringify(body);
    const req = http.request(`${run.control.url}${route}`, { method: "POST", headers: { Authorization: `Bearer ${run.control.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) } }, (res) => {
      let got = "", first: Record<string, unknown> | null = null, said: string | null = null;
      let finish: (why: string | null) => void = () => undefined;
      const ended = new Promise<string | null>((r) => { finish = r; });
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        got += chunk;
        if (res.statusCode !== 200) return;
        for (let at = got.indexOf("\n"); at >= 0; at = got.indexOf("\n")) {
          const line = JSON.parse(got.slice(0, at)) as Record<string, unknown>;
          got = got.slice(at + 1);
          if (first === null) {
            first = line;
            clearTimeout(timer);
            resolve({ first, ended, close: () => req.destroy() });
          } else if (typeof line.ended === "string") said = line.ended;
        }
      });
      res.on("close", () => {
        clearTimeout(timer);
        if (res.statusCode === 200) {
          if (first === null) reject(unreachable("it closed the answer before it said anything"));
          finish(said);
          return;
        }
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(got) as Record<string, unknown>; } catch { parsed = { error: got.trim() || `HTTP ${res.statusCode}` }; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(unreachable(`no answer in ${timeoutMs / 1000} s`)); }, timeoutMs);
    req.on("error", (e: NodeJS.ErrnoException) => { clearTimeout(timer); reject(unreachable(e.code ?? e.message)); });
    req.end(text);
  });
}
