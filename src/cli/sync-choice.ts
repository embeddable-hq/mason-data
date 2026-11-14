/**
 * A TABLE'S SYNC, AS THE WEB PAGE OFFERS TO CHOOSE IT (issue 840; `GET /api/tables/<table>/sync`, src/cli/run-server.ts):
 * Off, a poll at one of `POLL_PRESETS`, or Live — `sync: replication` — offered only where it can work. The choice is
 * saved by `POST /api/pick` `{ table, picked: true, sync, keep: true }` (`mason add <table> --sync …`), the one writer of
 * the sources file; this module only says what each choice would mean:
 *
 * - each poll's cost on the database, for a table over BIG_TABLE_ROWS, in numbers (`pollLoad`, the estimate `mason add`
 *   prints in its words), which the page says in its own;
 * - the checks logical replication needs, in Mason's words: the table's own (a primary key, not REPLICA IDENTITY
 *   NOTHING: `unreplicableReason`, `mason add`'s refusal) and the database's — `readinessChecks`, the checks `mason
 *   start` holds a replicating sources file to (wal_level, the role, a free slot and WAL sender, a standby on 16+ with
 *   hot_standby_feedback, the WAL cap) — and the table in the publication Mason reads (`namedPublicationVerdict`, the
 *   run's own check of a named one). ONE reader of each: nothing here re-words or re-decides a check.
 *
 * READ-ONLY AND ON DEMAND: settings, the catalog and the statistics views — never a row of the table — over ONE
 * connection, closed when they are read (`sourceLiveChecks` is given it). Never part of `/api/state`, which the page
 * polls: read when the choice opens, and again at save (`/api/pick` refuses what fails then).
 */
import type { PgConnection } from "../cdc/pg-wire.ts";
import type { SourceTable } from "./preflight.ts";
import { readServerFacts, readSlotFacts, type ProductionCheck } from "./replication-checks.ts";
import { checkState, readinessChecks, type ProjectReplication } from "./replication-mode.ts";
import { ownReaderFreed, publicationProblems } from "./source-check.ts";
import { pollLoad, unreplicableReason, type PollLoad, type PollMeasure } from "./source-edit.ts";
import { copiedColumns, effectiveSync, entryName, type SourceFile } from "./sources.ts";
import { namedPublicationVerdict, readNamedPublication } from "../duck/publication.ts";
import { BIG_TABLE_ROWS, parseSync, syncText } from "../lib/table-sync.ts";
import { withLocalSettings } from "../lib/local-settings.ts";

/** How long one of the checks' statements may run (`SET LOCAL statement_timeout` in their read-only transaction): they
 *  read settings and the catalog, milliseconds each, and one that hangs would hold every check queued behind it. */
export const LIVE_CHECKS_TIMEOUT_MS = 10_000;

/** The intervals the page offers a poll at: presets only, never a free interval (issue 840). */
export const POLL_PRESETS = ["5m", "15m", "1h", "1d"] as const;

/** One check of Live, as the page shows it: `refused` keeps Live from being chosen, `warn` is said and acknowledged
 *  before saving, `sql` is what the database's owner runs to fix it. */
export interface LiveCheck { name: string; state: "ok" | "warn" | "refused"; detail: string; sql?: string }

/** `GET /api/tables/<table>/sync`'s answer. */
export interface SyncChoice {
  table: string;
  /** its sync now, as the sources file says it (`effectiveSync`), or null for a table not added */
  sync: { value: string; from: "entry" | "file" | "default" } | null;
  /** the catalog's row estimate, or null */
  rows: number | null;
  /** each poll offered: its sync as the file writes it, its interval, and what it costs the database (`PollLoad`) — for
   *  a table over BIG_TABLE_ROWS (`bigRows`), null otherwise */
  polls: Array<{ sync: string; seconds: number; cost: PollLoad | null }>;
  /** the table is over BIG_TABLE_ROWS: a poll scans it whole, and the page asks before saving one */
  bigRows: boolean;
  /** Live: whether it may be chosen (no check refused), and every check */
  live: { allowed: boolean; checks: LiveCheck[] };
}

const asLive = (c: ProductionCheck): LiveCheck => ({ name: c.name, state: checkState(c), detail: c.detail, ...(c.sql !== undefined ? { sql: c.sql } : {}) });

/** The table's own checks (pure, the catalog's): what `mason add --sync replication` refuses it by. */
export function tableLiveChecks(t: Pick<SourceTable, "key" | "replicaIdentity">): LiveCheck[] {
  const way = "poll it instead, or keep its sync off";
  const keyless = unreplicableReason(t, true)!;
  const nothing = t.replicaIdentity === "n" ? unreplicableReason(t, false) : null;
  return [
    t.key.length ? { name: "primary key", state: "ok", detail: t.key.join(", ") } : { name: "primary key", state: "refused", detail: `${keyless.replace(/:$/, "")} — ${way}` },
    nothing === null ? { name: "replica identity", state: "ok", detail: REPLICA_IDENTITY[t.replicaIdentity ?? "d"] ?? "DEFAULT (its primary key)" }
      : { name: "replica identity", state: "refused", detail: `${nothing} — ${way}` },
  ];
}
const REPLICA_IDENTITY: Record<string, string> = { d: "DEFAULT (its primary key)", f: "FULL", i: "an index", n: "NOTHING" };

/**
 * THE CHECKS AS THE RUN READS THEM: `sourceLiveChecks` with each statement held to `LIVE_CHECKS_TIMEOUT_MS`, the limit
 * LOCAL to one read-only transaction around them (`withLocalSettings`), never a session SET. A session SET stayed on a
 * pooler's server connection in transaction mode, and the application's next clients ran under it (issue 930). The
 * caller closes the connection after.
 */
export function boundedLiveChecks(pg: PgConnection, t: SourceTable, o: Parameters<typeof sourceLiveChecks>[2], log: (m: string) => void): Promise<LiveCheck[]> {
  return withLocalSettings({ query: (sql) => pg.query(sql), settings: [["statement_timeout", LIVE_CHECKS_TIMEOUT_MS]],
    work: () => sourceLiveChecks(pg, t, o), answers: () => !pg.closed, log });
}

/**
 * THE DATABASE'S CHECKS FOR ONE TABLE, over the connection given (read-only: settings, the catalog, the statistics
 * views). `streaming`: this run reads the slot now, so its reader and its WAL sender are this run's own, never "another
 * reader" (`ownReaderFreed`). `columns`: the columns the table's entry syncs — at a save, the entry the edit WILL write —
 * which a named publication must carry, and no more.
 */
export async function sourceLiveChecks(pg: PgConnection, t: SourceTable, o: { repl: ProjectReplication; streaming: boolean; columns: readonly string[]; shown: string }): Promise<LiveCheck[]> {
  const read = { server: await readServerFacts(pg), slot: await readSlotFacts(pg, o.repl.slot) };
  const facts = o.streaming ? ownReaderFreed(read.server, read.slot) : read;
  const out = readinessChecks(facts.server, o.repl.slot, facts.slot, o.repl).map(asLive);
  if (facts.server.standby && o.repl.owned) return out;   // its publication's refusal is above
  if (o.repl.owned) {
    out.push({ name: "publication", state: "ok", detail: `${o.repl.publication}, Mason's own: Mason adds ${entryName(t.source)} to it` });
    return out;
  }
  const keep = new Set(o.columns);
  const copied = [{ source: t.source, columns: t.columns.filter((c) => keep.has(c.name)) }];
  const verdict = namedPublicationVerdict(await readNamedPublication(pg, o.repl.publication, copied), copied, new Map([[t.source, t.replicaIdentity ?? "d"]]));
  const gaps = publicationProblems(verdict, o.repl.publication, o.shown);
  if (!gaps.length) out.push({ name: "publication", state: "ok", detail: `${o.repl.publication} carries ${entryName(t.source)}` });
  for (const p of gaps) out.push({ name: "publication", state: "refused", detail: p.sql === null ? `${p.message} — ${p.fix}` : p.message, ...(p.sql !== null ? { sql: p.sql } : {}) });
  return out;
}

/** The columns a table's entry in the file syncs (`copiedColumns`), every column for a table the file does not name:
 *  what the Sync choice checks a named publication against. A save checks the entry it will write instead. */
export function liveColumns(t: SourceTable, file: Pick<SourceFile, "tables"> | null): string[] {
  const entry = file?.tables.find((e) => e.table === t.source);
  return entry ? copiedColumns(t, entry) : t.columns.map((c) => c.name);
}

/** What the page offers for one table: its sync now, each poll's cost, and Live's checks (`database`: the database's,
 *  read by the caller — `sourceLiveChecks` — or why they could not be). */
export function syncChoice(t: SourceTable, file: SourceFile | null, measured: PollMeasure | null, database: readonly LiveCheck[]): SyncChoice {
  const entry = file?.tables.find((e) => e.table === t.source);
  const now = entry === undefined || file === null ? null : effectiveSync(file, entry);
  const bigRows = t.rows !== null && t.rows > BIG_TABLE_ROWS;
  const polls = POLL_PRESETS.map((every) => {
    const s = parseSync(`poll ${every}`);
    if ("problem" in s || s.mode !== "poll") throw new Error(`POLL_PRESETS holds ${every}, which is no poll: ${"problem" in s ? s.problem : s.mode}`);
    return { sync: syncText(s), seconds: s.seconds, cost: bigRows ? pollLoad(t, s, measured) : null };
  });
  const checks = [...tableLiveChecks(t), ...database];
  return { table: t.source, sync: now === null ? null : { value: syncText(now.sync), from: now.from }, rows: t.rows, polls, bigRows,
    live: { allowed: checks.every((c) => c.state !== "refused"), checks } };
}
