/**
 * WHERE A RUN IS, AND HOW A COPY UNDER WAY IS SAID: what `mason wait`, `mason status` and the run's command server
 * (src/cli/run-server.ts, `/api/state`'s `readiness`) all read, so the web page and the commands say one thing.
 * A module of its own so the command server can import it without importing every command (src/cli/commands.ts
 * re-exports it).
 */
import type { RunState } from "./commands.ts";
import type { CopyProgressView, CopyState, Synced } from "../duck/sync.ts";

const n = (x: number): string => x.toLocaleString("en-US");
const firstLine = (s: string): string => s.split("\n")[0]!.trim();

/** A span of seconds as a person reads it: `45 s`, `12 min`, `2 h 5 min`. */
export function duration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** A duration in milliseconds as a person reads it (src/lib/table-sync.ts, where the sync reads it too). */
export { msText } from "../lib/table-sync.ts";

export interface Readiness {
  /** true: every added table is copied */
  ready: boolean;
  /** what has failed — each a sentence; non-empty means `mason wait` exits 1 */
  failed: string[];
  /** what is still under way */
  waiting: string[];
}

/**
 * WHAT A COPYING TABLE'S LINE SAYS, AND HOW FULL ITS BAR IS (a 20 M-row copy over the internet showed no progress: its
 * first line waited on 0 for minutes, then jumped to 100%). A copy's rows
 * land a chunk at a time, so the count is the committed chunks' rows PLUS what the chunks being read have read by now
 * at the rate the copy measured (`progress.rowsReading`, held under each chunk's expected rows, so a commit that holds them moves it
 * forward), and the text says what is happening: the chunks reading and for how long, the rate, and the time left at
 * it — never from the row estimate alone. Before anything is measured it says the first chunk is being read, never
 * `0 of`. The share is of the heap's PAGES read (`progress.share`: the ranges are exact), and only without the chunks'
 * progress of the table's row estimate (Postgres's own); below 100 until the copy says it is done, and NEVER BACKWARDS:
 * a copy that outruns the estimate (23.7 M rows under an estimate of 20.1 M went back to `0% copying
 * 21,385,158 rows`) stays at its share and says it is past the estimate. Null when nothing gives one.
 */
export function copyingText(copied: number, rowsEstimate: number | null, p?: CopyProgressView): { fraction: number | null; text: string } {
  const shown = copied + (p?.rowsReading ?? 0);
  const estimate = rowsEstimate !== null && rowsEstimate > 0 ? rowsEstimate : null;
  const past = estimate !== null && shown > estimate;
  const fraction = p !== undefined ? p.share : estimate === null ? null : Math.min(0.99, shown / estimate);
  // past the estimate: the count, and that it is past it (the share holds where it was: pages, or capped)
  const of = estimate === null ? "" : past ? ` · past the ~${n(estimate)} estimated` : ` of ~${n(estimate)}`;
  const rowsText = (k: number): string => past ? `${n(k)} rows${of}` : `${n(k)}${of} rows`;
  if (p === undefined) return { fraction, text: rowsText(copied) };
  const since = p.readingSeconds === null ? "" : ` (${duration(p.readingSeconds)})`;
  const chunks = (k: number): string => `${k} chunk${k === 1 ? "" : "s"}`;
  if (p.rowsPerSecond === null) {
    // nothing measured this attempt: its first chunks are being read (a copy resumed has rows from before)
    const first = p.reading === 0 ? "about to read the first chunk" : `reading the first ${p.reading === 1 ? "chunk" : chunks(p.reading)}${since}`;
    return { fraction, text: copied === 0 ? `${first}${estimate === null ? "" : ` · ~${n(estimate)} rows to sync`}` : `${rowsText(copied)} · resumed, ${first}` };
  }
  const parts = [rowsText(shown)];
  const allIn = p.reading === 0 && p.chunksDone >= p.chunksTotal;
  if (allIn) parts.push(`every chunk read (${p.chunksDone}): checking it and swapping it in`);
  else parts.push(`${p.reading === 0 ? "starting the next chunk" : `${chunks(p.reading)} reading${since}`}, ${p.chunksDone} of ~${p.chunksTotal} in`);
  parts.push(`${n(Math.round(p.rowsPerSecond))} rows/s`);
  if (!allIn && p.secondsLeft !== null) parts.push(`~${duration(p.secondsLeft)} left`);
  return { fraction, text: parts.join(" · ") };
}

/** A copy's progress on one line, as `mason wait` lists what it waits for: `public.orders: copying 12% · …` (`copyingText`). */
export function copyProgress(source: string, copied: number, rowsEstimate: number | null, p?: CopyProgressView): string {
  const c = copyingText(copied, rowsEstimate, p);
  return `${source}: ${c.fraction !== null ? `syncing ${Math.floor(c.fraction * 100)}% · ` : /^\d/.test(c.text) ? "syncing " : ""}${c.text}`;
}

/**
 * A TABLE'S SYNC IN ONE WORD, from what the sync has of its copy — the one place it is decided (`/api/state`
 * `tables[].sync.state`, so mason status, the web page and an agent say one thing):
 *  - `waiting`: no copy yet, nor one under way (the sync has not reached it);
 *  - `failed`: its copy failed, or the poll, catch-up or stream keeping it current did (its `error` says why; a table
 *    copied before still serves that copy);
 *  - `syncing`: being copied, copied again, or caught up by its one poll before it is kept current;
 *  - `synced`: its copy is served and kept current — or, for a table over the poll's row limit, served as copied and
 *    NOT kept current (its `unsynced` says so, and `syncedAt` how old the copy is).
 */
export type TableSyncState = "synced" | "syncing" | "failed" | "waiting";
export function syncStateOf(c: CopyState | undefined): TableSyncState {
  if (c === undefined || c.phase === "waiting") return "waiting";
  if (c.phase === "failed" || c.error !== null) return "failed";
  if (c.phase === "copying" || c.rebuilding !== undefined || c.behind !== undefined) return "syncing";
  return "synced";
}

/** A table's sync as `/api/state` says it (`tables[].sync`): its state, when it was last brought current and how
 *  (src/duck/sync.ts `Synced`), and how old that is NOW — the one value here relative to the moment it is asked. */
export interface SyncFacts { state: TableSyncState; syncedAt: string | null; syncSeconds: number | null; syncedBy: Synced["by"] | null; ageSeconds: number | null }
export function tableSync(c: CopyState | undefined, now: number): SyncFacts {
  const s = c?.synced;
  return { state: syncStateOf(c), syncedAt: s?.at ?? null, syncSeconds: s?.seconds ?? null, syncedBy: s?.by ?? null,
    ageSeconds: s === undefined ? null : Math.max(0, Math.round((now - Date.parse(s.at)) / 100) / 10) };
}

/** The run's copies in all (`/api/state` `totals`): the tables added, those copied (served), those whose sync failed,
 *  the copies' rows, and the most recent sync of any (the copy file's size is `engine.bytes`). */
export interface SyncTotals { added: number; copied: number; failed: number; rows: number; syncedAt: string | null }
export function syncTotals(added: number, copies: readonly CopyState[]): SyncTotals {
  const copied = copies.filter((c) => c.phase === "copied");
  const latest = copies.flatMap((c) => c.synced === undefined ? [] : [c.synced.at]).sort().pop() ?? null;
  return { added, copied: copied.length, failed: copies.filter((c) => syncStateOf(c) === "failed").length, rows: copied.reduce((n, c) => n + (c.rows ?? 0), 0), syncedAt: latest };
}

/** THE SYNC'S COPIES BY PHASE: what `/healthz` says (src/cli/serve.ts `healthBody`) and `GET /metrics`' `mason_tables`
 *  (src/cli/metrics.ts, through `usageFacts`) — counts only, one count for both endpoints. */
export interface PhaseCounts { total: number; copied: number; copying: number; waiting: number; failed: number }
export function phaseCounts(copies: readonly CopyState[]): PhaseCounts {
  const counts: PhaseCounts = { total: 0, copied: 0, copying: 0, waiting: 0, failed: 0 };
  for (const c of copies) { counts.total++; counts[c.phase]++; }
  return counts;
}

/** WHERE A RUN IS IN ONE WORD, as `mason status` heads its last line and the web page's Status says it: every added
 *  table copied and served, a failure, or still under way. */
export function readinessWord(r: Readiness): "Ready" | "Failed" | "Under way" {
  return r.ready ? "Ready" : r.failed.length ? "Failed" : "Under way";
}

/**
 * WHERE A RUN IS. Ready when every added table's copy has ended well: `mason add` followed by `mason wait` returns
 * once the table is served. A copy that failed is a failure (the sync tries again by itself, and says so in the log),
 * so an agent is never left waiting for a copy that cannot finish.
 */
export function readiness(s: Pick<RunState, "tables">): Readiness {
  const failed: string[] = [], waiting: string[] = [];
  for (const t of s.tables.filter((t) => t.added)) {
    if (t.error) { failed.push(`${t.table}: ${firstLine(t.error)}`); continue; }
    if (t.copy?.phase === "copying") { waiting.push(copyProgress(t.table, t.copy.rowsCopied, t.rows, t.copy.progress)); continue; }
    if (!t.copy) waiting.push(`${t.table}: waiting for its first sync to start`);
  }
  return { ready: failed.length === 0 && waiting.length === 0, failed, waiting };
}
