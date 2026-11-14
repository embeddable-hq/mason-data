/**
 * THE SYNCS ASKED BY HAND (`POST /api/sync`: `mason sync`, the page's Sync now), each from its start to its end (issue
 * 1007). A sync scans each table whole on the database, which takes minutes for a big one: longer than a reverse proxy
 * in front of `mason serve` keeps a request open. So the run answers as soon as a sync has started, and the page follows
 * it through `/api/state` (`tables[].syncByHand`): syncing while it runs, then what it did or why it failed.
 *
 * ONE SYNC AT A TIME A TABLE: a second ask for the very tables of a sync running joins it (its answer is that sync's),
 * and one naming a table a sync covers beside others is refused, naming it — two never run at once.
 *
 * What a sync did is the sync's ledger's record too (src/duck/events.ts `synced`, `sync_failed`, written by
 * `Sync.pollNow`): this holds only what the run is doing now and the last outcome a table had in this run, for the
 * page to say as `mason sync` says it. A sync by hand never outlives its run, so a run started again has none running.
 */
import type { PolledTable, StreamedAnswer } from "../duck/sync.ts";

/** What `POST /api/sync` answers when the sync ends: the poll's answer (src/duck/sync.ts `pollNow`). */
export interface SyncAnswer { at: string; tables: PolledTable[]; streamed?: StreamedAnswer[] }

/** A sync that failed: its reason in Mason's words, and the CLI's failure code (`refused`, `nothing_yet` for a refusal
 *  met once the pass ahead of it ended, `failed` otherwise). */
export interface SyncFailure { code: "not_found" | "nothing_yet" | "refused" | "failed"; message: string }

/**
 * ONE SYNC BY HAND, as `/api/state` carries it on each table it covers (`syncByHand`) and `POST /api/sync` answers it:
 * `id` (a number, new for each sync of this run), `tables` (every table it covers, in the order asked), `state`
 * (`syncing`, `synced`, `failed`), `startedAt`, `endedAt` (null while it runs), and once ended `answer` (what it did,
 * `mason sync --json`'s facts) or `failure`.
 */
export interface SyncByHand {
  id: number;
  tables: string[];
  state: "syncing" | "synced" | "failed";
  startedAt: string;
  endedAt: string | null;
  answer?: SyncAnswer;
  failure?: SyncFailure;
}

/** A second ask while a sync covers one of its tables: the sync running, and whether the ask is that very sync. */
export type Running = { same: true; sync: SyncByHand; done: Promise<SyncByHand> } | { same: false; sync: SyncByHand };

export class SyncsByHand {
  private next = 1;
  /** each table's last sync by hand in this run, running or ended */
  private readonly last = new Map<string, SyncByHand>();
  /** each sync running: its end */
  private readonly ends = new Map<number, Promise<SyncByHand>>();

  /** the last sync by hand of this table in this run, running or ended, or null */
  of(table: string): SyncByHand | null { return this.last.get(table) ?? null; }

  /** a sync running that covers one of these tables, or null: the same tables (joined), or others beside (refused) */
  running(tables: readonly string[]): Running | null {
    for (const t of tables) {
      const s = this.last.get(t);
      if (s?.state !== "syncing") continue;
      const done = this.ends.get(s.id)!;
      const same = s.tables.length === new Set(tables).size && tables.every((x) => s.tables.includes(x));
      return same ? { same: true, sync: s, done } : { same: false, sync: s };
    }
    return null;
  }

  /**
   * Start a sync of these tables: `poll` is the sync's own (`Sync.pollNow`), its rejection the failure (a `PollRefused`
   * keeps its code). Returns the sync as it starts, and its end, which never rejects: the outcome is on the record.
   */
  start(tables: readonly string[], poll: () => Promise<SyncAnswer>, failureOf: (e: unknown) => SyncFailure, now = (): Date => new Date()): { sync: SyncByHand; done: Promise<SyncByHand> } {
    const sync: SyncByHand = { id: this.next++, tables: [...tables], state: "syncing", startedAt: now().toISOString(), endedAt: null };
    for (const t of tables) this.last.set(t, sync);
    // a new object at its end, so what an answer already holds of it never changes under it
    const ended = (e: Omit<SyncByHand, "id" | "tables" | "startedAt" | "endedAt">): SyncByHand => {
      const done: SyncByHand = { id: sync.id, tables: sync.tables, startedAt: sync.startedAt, endedAt: now().toISOString(), ...e };
      for (const t of tables) if (this.last.get(t)?.id === sync.id) this.last.set(t, done);
      this.ends.delete(sync.id);
      return done;
    };
    const done = (async () => {
      try { return ended({ state: "synced", answer: await poll() }); }
      catch (e) { return ended({ state: "failed", failure: failureOf(e) }); }
    })();
    this.ends.set(sync.id, done);
    return { sync, done };
  }
}
