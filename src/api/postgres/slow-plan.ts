/**
 * THE PLAN OF EACH SLOW STATEMENT, WITH ITS REQUEST-LOG ROW (issue 825): working out why a statement was slow meant
 * rebuilding its plan by hand — a temporary user on the server, an `EXPLAIN ANALYZE` that itself slowed a user's
 * statement — where Mason's plain EXPLAIN (src/duck/explain.ts: the tables and their freshness, the SQL sent to the
 * engine, the engine's plan with its estimated rows) showed the cause at once.
 *
 * So a statement that took SLOW_MS (src/api/request-log.ts) or more, once it ENDED, is explained here: a plain EXPLAIN
 * (planning only, nothing executed) of the plan it ran (`DuckPlan`, never planned again: the catalog Postgres plans
 * every session's statements on one thread, so a plan made twice would take its time from them), held to the session's
 * role as it is NOW, on a DuckDB connection of this module's own, and handed to the request log as a promise its row
 * waits for (src/duck/requests.ts). The answer to the client was sent before any of it starts.
 *
 * AT MOST ONE AT A TIME: a slow statement that ends while another's plan is being recorded gets none — never a queue,
 * which would grow exactly when the machine is struggling — and the dropped ones are said in the log at most once a
 * minute (`DROPS_SAID_EVERY_MS`), each line with how many since the last, and what is left at the close: under a stream
 * of slow statements a line per drop, or per streak, would be a line every few milliseconds. Each is bounded by `PLAN_DEADLINE_MS`; a stop aborts the one in flight.
 * The measurements (what it costs the statements beside it) are docs/OBSERVABILITY.md's "The plan of a slow statement".
 */
import { storedPlan, type StoredPlan } from "../request-log.ts";
import type { DuckRunner } from "./server.ts";

/** How long one plan may take: an EXPLAIN plans and reads the copies' row counts, ~100 ms on a loaded server; past this
 *  it is abandoned (interrupted) and the row is written without one. */
export const PLAN_DEADLINE_MS = 30_000;

/** The dropped plans are said at most this often, with how many since the last line. */
export const DROPS_SAID_EVERY_MS = 60_000;

/** What explains one statement, on the module's connection, under `signal`: its EXPLAIN's lines. Throws the session's
 *  refusal (its role now) or the engine's error. */
export type Explain = (runner: DuckRunner, signal: AbortSignal) => Promise<string[]>;

export class SlowPlans {
  private runner: Promise<DuckRunner> | null = null;
  /** the plan being recorded now: what `close` aborts and waits for */
  private current: { controller: AbortController; done: Promise<StoredPlan | null> } | null = null;
  /** the plans not recorded because another was, since the last line that said so, and when that line was */
  private dropped = 0;
  private droppedSaidAt = -Infinity;
  private closed = false;
  private readonly open: () => Promise<DuckRunner>;
  private readonly log: (line: string) => void;

  constructor(open: () => Promise<DuckRunner>, log: (line: string) => void) { this.open = open; this.log = log; }

  /**
   * The plan of a statement that just ended, recorded in the background: a promise of it (null where none could be
   * recorded: the run stopping, the deadline), or undefined when it is not asked — another plan is being recorded (said
   * at most once a minute, counted), or the listener is closing. `what` names the statement in the log (`session 3`). `hideErrors`: an
   * error's message is not kept (it could quote a bound value the row does not keep). Never throws.
   */
  record(what: string, explain: Explain, hideErrors: boolean): Promise<StoredPlan | null> | undefined {
    if (this.closed) return undefined;
    if (this.current !== null) {
      this.dropped++;
      if (Date.now() - this.droppedSaidAt >= DROPS_SAID_EVERY_MS) this.sayDropped(`the latest ${what}`);
      return undefined;
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error(`it took more than ${PLAN_DEADLINE_MS / 1000} s`)), PLAN_DEADLINE_MS);
    deadline.unref();
    const done = (async (): Promise<StoredPlan | null> => {
      try {
        // opened at the first slow statement, kept for the next; one that failed to open is asked again next time
        const runner = await (this.runner ??= this.open().catch((e: unknown) => { this.runner = null; throw e; }));
        const plan = storedPlan((await explain(runner, controller.signal)).join("\n"));
        return plan;
      } catch (e) {
        // TOLERATED, NARROWLY: the statement was answered and its row is written all the same. An abort is the run
        // stopping or the deadline: no plan, said. A refusal (the session's role now refuses what it ran, a 42501) or the
        // engine's error is the plan's answer, kept on the row in its words — unless it could quote a bound value
        if (controller.signal.aborted) {
          this.log(`request log: the plan of a slow statement (${what}) was not recorded: ${(controller.signal.reason as Error | undefined)?.message ?? "the listener closed"}`);
          return null;
        }
        const code = (e as { fields?: { code?: unknown } }).fields?.code;
        const why = `${typeof code === "string" ? `${code} ` : ""}${hideErrors ? "(its message is not kept: it may quote a value the statement was bound with)" : (e as Error).message}`;
        return storedPlan(`the plan was not recorded: ${why}`);
      } finally {
        clearTimeout(deadline);
        this.current = null;
      }
    })();
    this.current = { controller, done };
    return done;
  }

  /** the dropped plans since the last line, said; `latest` names the last one */
  private sayDropped(latest: string): void {
    this.log(`request log: ${this.dropped} slow statement(s) had no plan recorded (${latest}): another slow statement's plan was being recorded, and Mason records one at a time; said at most once a minute`);
    this.dropped = 0;
    this.droppedSaidAt = Date.now();
  }

  /** The listener closing: the plan in flight aborted and waited for, the connection closed; nothing asked after. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.dropped > 0) this.sayDropped("since the last line");
    const current = this.current;
    if (current !== null) { current.controller.abort(new Error("the listener closed")); await current.done; }
    const runner = this.runner;
    this.runner = null;
    if (runner === null) return;
    let open: DuckRunner;
    // an open that failed has nothing to close; its failure was the plan's to say
    try { open = await runner; } catch (e) { this.log(`request log: the connection slow statements' plans were recorded on did not open: ${(e as Error).message}`); return; }
    await open.close();
  }
}
