/**
 * THE COMMANDS' LINE TO A RUN: `mason status`, `mason tables`, `mason add` and `mason wait` ask the run's
 * command server (src/cli/run-server.ts) — with the
 * run's token as `Authorization: Bearer` (src/cli/security.ts), read from the project's .mason/config.json (src/cli/runs.ts).
 */
import type { DevRun } from "./runs.ts";
import type { Failure } from "./command.ts";

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
export async function callRun(run: DevRun, method: "GET" | "POST", route: string, body?: unknown, timeoutMs = 30_000): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(run.control.url + route, {
      method,
      headers: { Authorization: `Bearer ${run.control.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
  return { status: res.status, body: parsed };
}
