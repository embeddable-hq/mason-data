/**
 * WHERE A RUN IS, AND HOW A COPY UNDER WAY IS SAID: what `mason wait`, `mason status` and the run's command server
 * (src/cli/run-server.ts, `/api/state`'s `readiness`) all read, so the web page and the commands say one thing.
 * A module of its own so the command server can import it without importing every command (src/cli/commands.ts
 * re-exports it).
 */
import type { RunState } from "./commands.ts";
import type { CopyProgressView, CopyState, KeptCurrent, Synced } from "../duck/sync.ts";
import type { GeneratedStatus } from "../duck/generated.ts";

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
export { msText, statementMsText } from "../lib/table-sync.ts";

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
 *  - `syncing`: being copied, or copied again (a table copied before serves that copy meanwhile);
 *  - `catching-up`: served, and caught up by its ONE poll from its watermark before it is kept current — after its
 *    whole read (a `sync: off` table's too), a change of its sync, or a slot new to it — queued, polling or ending
 *    (issue 834: until it ends, its synced data is as of before what that poll reads, so `mason wait` is not ready);
 *  - `behind`: served and being kept current, but its synced data is older than its `sync:` promises (`behindOf`:
 *    measured from the ledger's time, at the moment asked — issue 106);
 *  - `synced`: its copy is served and kept current as its sync promises — or, `sync: off`, served as of its last sync
 *    (never behind: it promises nothing past it).
 */
export type TableSyncState = "synced" | "syncing" | "catching-up" | "failed" | "waiting" | "behind";
export function syncStateOf(c: CopyState | undefined, now: number = Date.now()): TableSyncState {
  if (c === undefined || c.phase === "waiting") return "waiting";
  if (c.phase === "failed" || c.error !== null) return "failed";
  if (c.phase === "copying" || c.rebuilding === "copy") return "syncing";
  if (c.behind !== undefined || c.rebuilding === "catch-up") return "catching-up";
  return (behindOf(c.kept, now).behindBySeconds ?? 0) > 0 ? "behind" : "synced";
}

/**
 * IS A SERVED TABLE BEHIND WHAT ITS `sync:` PROMISES, NOW — the one comparison (`syncStateOf`, `tableSync`): the age of
 * its synced data as the ledger has it (`kept.syncedAt`, src/duck/sync.ts `keptOf`: a poll's start, the stream's last
 * moment with everything; a recopy's watermark, else its copy) against the age its sync promises
 * (`kept.promisedSeconds`, `keptPromise`), never a schedule or a phase. `asOf` null: nothing measured;
 * `promisedSeconds` null: nothing promised (`off`, or a run before it was said), and `behindBySeconds` null with it;
 * `behindWhy` the sync's reason (`kept.lateWhy`) while behind, else null.
 */
export interface Behind { asOf: string | null; promisedSeconds: number | null; behindBySeconds: number | null; behindWhy: string | null }
export function behindOf(k: KeptCurrent | undefined, now: number): Behind {
  if (k === undefined || k.by === "generated") return { asOf: null, promisedSeconds: null, behindBySeconds: null, behindWhy: null };
  const asOf = k.by === "recopy" ? k.syncedAt ?? k.copiedAt : k.syncedAt;
  const promisedSeconds = k.promisedSeconds ?? null;
  if (promisedSeconds === null || asOf === null) return { asOf, promisedSeconds, behindBySeconds: null, behindWhy: null };
  const over = (now - Date.parse(asOf)) / 1000 - promisedSeconds;
  return over > 0 ? { asOf, promisedSeconds, behindBySeconds: Math.round(over * 10) / 10, behindWhy: k.lateWhy ?? "its next sync is late" }
    : { asOf, promisedSeconds, behindBySeconds: 0, behindWhy: null };
}

/** A table's sync as `/api/state` says it (`tables[].sync`): its state, when it was last brought current and how
 *  (src/duck/sync.ts `Synced`), and how old that is NOW — the one value here relative to the moment it is asked — and
 *  whether it is behind what its sync promises (`behindOf`). */
export interface SyncFacts extends Partial<Behind> { state: TableSyncState; syncedAt: string | null; syncSeconds: number | null; syncedBy: Synced["by"] | null; ageSeconds: number | null }
export function tableSync(c: CopyState | undefined, now: number): SyncFacts {
  const s = c?.synced;
  return { state: syncStateOf(c, now), syncedAt: s?.at ?? null, syncSeconds: s?.seconds ?? null, syncedBy: s?.by ?? null,
    ageSeconds: s === undefined ? null : Math.max(0, Math.round((now - Date.parse(s.at)) / 100) / 10), ...behindOf(c?.kept, now) };
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

/** WHAT A TABLE IN ITS CATCH-UP SAYS (state `catching-up`): its line in `mason wait` and `mason status` (`keptAge`; the
 *  web page's, src/web/pages/status.js, held equal) and what `mason wait` waits for. Never "NOT kept current": a
 *  `sync: off` table is never kept current by design, and the poll is at work, not at fault (issue 834). */
export const CATCHING_UP = "being caught up by one poll for what changed since it was synced";

/**
 * WHERE A RUN IS. Ready when every added table's copy has ended well, its one catch-up poll included (issue 834): `mason add` followed by `mason wait` returns
 * once the table is served. A copy that failed is a failure (the sync tries again by itself, and says so in the log),
 * so an agent is never left waiting for a copy that cannot finish.
 */
export function readiness(s: Pick<RunState, "tables">): Readiness {
  const failed: string[] = [], waiting: string[] = [];
  for (const t of s.tables.filter((t) => t.added)) {
    // the table's state in one word (`syncStateOf`), never a second reading of its error or phase: a copied table whose
    // poll, catch-up, stream or publication check failed is failed here as it is there (issues 100, 82). Behind is said
    // on its line, never a failure: it is served and being kept. A run from before `sync` was said: its error and phase.
    const state = t.sync?.state ?? (t.error ? "failed" : t.copy?.phase === "copying" ? "syncing" : !t.copy ? "waiting" : "synced");
    if (state === "failed") { failed.push(`${t.table}: ${firstLine(t.error ?? "its sync failed (mason status says why)")}`); continue; }
    if (t.copy?.phase === "copying") { waiting.push(copyProgress(t.table, t.copy.rowsCopied, t.rows, t.copy.progress)); continue; }
    if (!t.copy) { waiting.push(`${t.table}: waiting for its first sync to start`); continue; }
    // served, its one catch-up poll not over (issue 834): its synced data is as of before what that poll reads
    if (state === "catching-up") waiting.push(`${t.table}: ${CATCHING_UP}`);
  }
  return { ready: failed.length === 0 && waiting.length === 0, failed, waiting };
}

/**
 * WHERE A GENERATED TABLE IS, for `mason wait <table>`: ready once it is served and holds every base change Mason had
 * synced when the wait began (`since`, ms), across its chain — nothing behind (`behindSince` null), or only changes
 * committed after it began. A last run that failed, or a parent that blocks it, is a failure, so an agent is never left
 * waiting for a run that cannot come. The marks are the run's clock and `since` this machine's: `mason wait` reads a run
 * on this machine.
 */
export function generatedReadiness(g: GeneratedStatus, since: number): Readiness {
  const caught = g.serving && (g.behindSince === null || Date.parse(g.behindSince) > since);
  if (caught) return { ready: true, failed: [], waiting: [] };
  const fail = (why: string): Readiness => ({ ready: false, failed: [`${g.table}: ${why}`], waiting: [] });
  if (g.error !== null) return fail(`its last run failed: ${firstLine(g.error)}`);
  if (g.state === "refused" && !g.serving) return fail(`refused: ${g.refusals[0]?.message ?? "mason status says why"}`);
  if (g.waitingFor !== null && /(failed its last run|is refused)$/.test(g.waitingFor)) return fail(`not run, because ${g.waitingFor}`);
  return { ready: false, failed: [], waiting: [`${g.table}: ${!g.serving ? g.waitingFor === null ? "being built" : `waiting for ${g.waitingFor}` :
    `${Math.round(g.behindSeconds)} s behind its bases; its next run brings in what was synced before the wait`}`] };
}
