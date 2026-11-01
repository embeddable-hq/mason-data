/**
 * GENERATED TABLES: TABLES DECLARED IN SQL, KEPT CURRENT BY MASON (issue 124, docs/DESIGN.md "Generated tables"). A file in
 * `mason/generated_tables/` (src/cli/generated-files.ts) names a table and the SELECT that gives it, and a dashboard reads
 * that table by name instead of repeating the work. This is `kind: scheduled`, by the whole re-run: the SELECT run over
 * one snapshot into a table beside the old one, swapped in, up to `target_lag:` behind its bases. `kind: live` is refused
 * until its write path exists; nothing here ever moves a table from one kind to the other.
 *
 * - WHAT IS CHECKED, AND WHEN: the file's shape when it is read; its SQL (src/duck/generated-plan.ts) once the listener's
 *   catalog holds its bases, again whenever that catalog moves, and before anything is built. A refusal stops nothing
 *   else: the other tables run on, and a table already deployed keeps serving AND being re-run under the definition it
 *   was built from, which the ledger holds (`Deployed`), so a bad edit costs no freshness.
 * - A RUN (`run`), ONE AT A TIME IN THE ONE REBUILD QUEUE, on a connection of its own set up as a session in UTC (a plan
 *   read on a connection with DuckDB's own null order sorts otherwise): its snapshot taken on a writer's turn, the table
 *   beside the old one written there, then swapped in on another writer's turn, as a copy's swap is. The source is never
 *   touched. A failed run leaves the old table serving, says why (never quoting a row: `withoutValues`), and is tried
 *   again after the same back-off as a failed copy.
 * - LAG IS THE AGE OF THE OLDEST BASE CHANGE NOT REFLECTED, never the age of the snapshot: over an idle base nothing is
 *   behind. Each commit that changed a base marks it (`changed`), in memory and after that commit, so nothing is added to
 *   a batch's transaction. A run takes the marks on the same writer's turn it takes its snapshot, so a commit is either
 *   in the snapshot or marked for the next run: DuckDB's snapshot is the transaction's first read of a table, never its
 *   BEGIN (measured). Marks die with the process: at a start, a base last synced after the table was built counts as
 *   changed since then, which at worst costs one re-run. A run starts early enough to end inside its target, by the last
 *   run's length; one that outlasts its target is followed by the next at once, and `mason status` says the target is
 *   missed.
 * - A CATALOG TABLE, A TABLE TO ROLES: in the catalog as a copy of its output's types (`served`), so statements, EXPLAIN and
 *   a role's `tables:` treat it as any other, with no key. Before it is built the catalog has no such relation, and a
 *   statement is told so by name (gap `generated-not-built`, src/duck/plan.ts).
 * - A CHAIN (issue 124 stage 2): a table may read another. Parents are built first, and a run of a parent builds every
 *   child after it in the same transaction, each child planned over its parents' SIDE tables (src/duck/plan.ts
 *   swapRelations), never the served ones, so parent and child are one snapshot; they swap in on ONE writer's turn. A
 *   child that comes due while a parent has changes not in it hands its run to that parent (`rootOf`). A child of a
 *   parent failed, or refused with nothing deployed, is not run, and says why (`blocker`); a deployed parent refused in its
 *   file is re-run from what it was built from, and its children with it. A cycle is refused by name: from the SQL's names when
 *   the folder is read (`findCycles`), else from the plan's reads at the check.
 */
import { createHash } from "node:crypto";
import type { DuckConnection } from "./executor.ts";
import type { Planner, GeneratedColumn, GeneratedRefusal, DefinitionPlan as DefinitionPlanOf } from "./generated-plan.ts";
import { cycleRefusal, planDefinition, readsByName, refusalOf, refusalText } from "./generated-plan.ts";
import { MASON_SCHEMA, type DuckStore } from "./store.ts";
import { StatementError } from "./statement.ts";
import type { SyncEventInput } from "./events.ts";
import type { CopyState } from "./sync.ts";

export const GENERATED_LEDGER = `${MASON_SCHEMA}.generated_tables`;
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${GENERATED_LEDGER} (name VARCHAR PRIMARY KEY, file VARCHAR, sql VARCHAR, order_by VARCHAR, target_every VARCHAR, target_seconds BIGINT, comment VARCHAR, ` +
  `fingerprint VARCHAR, columns VARCHAR, bases VARCHAR, snapshot_at TIMESTAMPTZ, built_at TIMESTAMPTZ, "rows" BIGINT, seconds DOUBLE, bases_synced VARCHAR)`;
/** the table a run writes, beside the one served until the swap */
const SIDE_SUFFIX = "__mason_generated";
/** how often the folder is read and each table's due time looked at */
export const REVIEW_MS = 5_000;

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const literal = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** A table as its file declares it, read and in shape (src/cli/generated-files.ts). */
export interface GeneratedDefinition {
  /** `schema.table` */
  name: string;
  schema: string;
  table: string;
  /** the file, as messages name it */
  file: string;
  sql: string;
  orderBy: string | null;
  targetLag: { every: string; seconds: number };
  comment: string | null;
}
/** A file that is no definition: refused when read, for the reasons it gives. `kind` as it wrote it, where it did. */
export interface GeneratedFileRefused { name: string; schema: string; table: string; file: string; kind: string | null; refusals: GeneratedRefusal[] }
/** The folder as it is now. */
export interface GeneratedRead { definitions: GeneratedDefinition[]; refused: GeneratedFileRefused[] }

/** What a table is doing, in one word (`GeneratedStatus.state`). */
export type GeneratedState = "refused" | "waiting" | "building" | "failed" | "current" | "behind";
/** A generated table as `mason status` says it (`--json`'s `generatedTables`). */
export interface GeneratedStatus {
  /** `schema.table`, as the catalog names it */
  table: string;
  file: string;
  kind: string | null;
  /** how it is kept: `whole`, a re-run of its SQL */
  method: "whole";
  state: GeneratedState;
  /** `target_lag:`, as written; the time behind its bases, seconds, across its chain (the oldest base change, below it
   *  anywhere, not yet in its rows); whether that is past the target */
  targetLag: string | null;
  behindSeconds: number;
  /** when that oldest change was committed (ISO); null: nothing behind. `mason wait <table>` waits until it is null or
   *  after the wait began */
  behindSince: string | null;
  missingTarget: boolean;
  /** a table is served, under the definition it was last built from */
  serving: boolean;
  lastRun: { at: string; seconds: number; rows: number } | null;
  /** the last run's failure, its values taken out, and when it is tried again */
  error: string | null;
  retryAt: string | null;
  /** why its file's definition is refused: what is served is the one before it */
  refusals: Array<GeneratedRefusal & { text: string }>;
  /** what it waits for: a base still being synced */
  waitingFor: string | null;
  /** what its file does that changes nothing: said, never refused */
  warnings: string[];
}

/** what a table was last built from, as the ledger holds it: what it is re-run from while its file is refused */
interface Deployed {
  definition: GeneratedDefinition;
  fingerprint: string;
  columns: GeneratedColumn[];
  bases: string[];
  /** each base's last sync as the sync said it on the snapshot's turn (ms, null: not known): a base whose last sync is
   *  another one at a restart may hold a commit the snapshot missed, whenever that sync began */
  basesSynced: Record<string, number | null>;
  snapshotAt: number;
  builtAt: number;
  rows: number;
  seconds: number;
}
interface Entry {
  name: string;
  /** the file's definition, in shape; null: its file is refused or gone */
  wanted: GeneratedDefinition | null;
  /** the file as refused when read */
  fileRefused: GeneratedFileRefused | null;
  /** what the catalog last said of `wanted`, where it passed, and the tables it reads */
  checked: { definition: GeneratedDefinition; fingerprint: string; bases: string[] } | null;
  /** the tables `wanted`'s SQL names, by name: what a cycle is told from before anything is planned */
  reads: string[];
  /** the cycle its SQL's names make, refused before its check */
  cycle: GeneratedRefusal | null;
  /** the table, a parent or one below it, that kept it from being run because it was refused or its run failed: its
   *  NAME only, said with why as it is when read (`waitingWords`), never as it was when blocked */
  blocked: string | null;
  /** the definition and the catalog `check` last looked at: looked at again when either moves */
  seen: { json: string; schema: unknown } | null;
  refusals: GeneratedRefusal[];
  /** what `refusals` was last said as */
  said: string | null;
  /** `GeneratedStatus.warnings`, as the catalog last said them of `wanted`; what they were last said as */
  warnings: string[];
  warned: string | null;
  /** the table it waits for, by NAME only: a parent's refusal or failure is read when it is said (`waitingWords`), so a
   *  parent fixed since, or refused after this was checked, is said as it is now */
  waitingFor: string | null;
  deployed: Deployed | null;
  /** when the oldest base change no run has taken was committed (ms); null: none */
  dirtySince: number | null;
  /** the same of the changes the run going now took: not in the table until its swap */
  taken: number | null;
  queued: boolean;
  running: boolean;
  failures: number;
  retryAt: number;
  error: string | null;
}

/** What the table needs of the sync (src/duck/sync.ts `Sync`). */
export interface GeneratedHost {
  onWriter<T>(f: () => Promise<T>): Promise<T>;
  /** the run's own connection, opened and closed by the sync so `stop` interrupts it */
  connection(): DuckConnection;
  /** a run of it, queued in the one rebuild queue (it comes back through `run`) */
  enqueue(name: string): void;
  /** `f` as `Sync.interruptible` runs a long statement on the run's connection: `stop` ends it, thrown as Stopping */
  interruptible<T>(f: () => Promise<T>): Promise<T>;
  /** `schema.table` is a table the sources file adds, or a view of the source's */
  added(name: string): "copied" | "adding" | "view" | null;
  /** when `base` was last brought current (ISO), null when not known */
  syncedAt(base: string): string | null;
  /** the catalog's tables made again, now including what changed here */
  rebuildCatalog(): Promise<void>;
  /** the catalog's schema: a new object when it moved */
  schema(): unknown;
  /** how long a failed run waits, as a failed copy does (src/duck/sync.ts `copyRetryDelayMs`) */
  retryDelayMs(failures: number, attemptMs: number): number;
  stopping(e: unknown): boolean;
  log(line: string): void;
  event(e: SyncEventInput): void;
}

export interface GeneratedOptions {
  reviewMs?: number;
  /** a run reached a step, for a test: its snapshot taken, its table written, that committed, it swapped in */
  onStep?: (step: GeneratedStep, name: string) => void | Promise<void>;
}
export type GeneratedStep = "snapshot" | "written" | "committed" | "swapped";

/** A row's values taken out of an error: what a table's failure says is kept and shown, and a value in it would be a row
 *  quoted (`invalid input syntax for type integer: "abc"`): quoted text and every number go. */
export function withoutValues(message: string): string {
  return message.split("\n")[0]!.replace(/'(?:[^']|'')*'/g, "…").replace(/"(?:[^"]|"")*"/g, "…").replace(/\b\d[\d.:,-]*\b/g, "…");
}

export class GeneratedTables {
  private readonly store: DuckStore;
  private readonly host: GeneratedHost;
  private readonly reviewMs: number;
  private readonly onStep: NonNullable<GeneratedOptions["onStep"]>;
  private readonly entries = new Map<string, Entry>();
  private reader: (() => GeneratedRead) | null = null;
  private planner: Planner | null = null;
  private timer: NodeJS.Timeout | null = null;
  private reviewing: Promise<void> | null = null;
  /** a run's planning in flight: it plans on the listener's catalog, so a stop waits for it before the listener closes */
  private planning: Promise<unknown> | null = null;
  private stopped = false;
  /** the run in flight, ended or not (`run`): the next starts after it */
  private runs: Promise<void> = Promise.resolve();

  constructor(store: DuckStore, host: GeneratedHost, options: GeneratedOptions = {}) {
    this.store = store; this.host = host; this.reviewMs = options.reviewMs ?? REVIEW_MS; this.onStep = options.onStep ?? (() => undefined);
  }

  /** the ledger read and what a crash left beside it dropped, before the catalog serves anything */
  async open(): Promise<void> {
    const w = this.store.writer;
    await w.run(LEDGER_DDL);
    const rows = (await w.runAndReadAll(`SELECT name, file, sql, order_by, target_every, target_seconds, comment, fingerprint, columns, bases, epoch_ms(snapshot_at), epoch_ms(built_at), "rows", seconds, bases_synced FROM ${GENERATED_LEDGER}`)).getRowsJS() as
      Array<[string, string, string, string | null, string, bigint, string | null, string, string, string, number | bigint, number | bigint, bigint, number, string | null]>;
    for (const [name, file, sql, orderBy, every, seconds, comment, fingerprint, columns, bases, snapshotAt, builtAt, count, took, basesSynced] of rows) {
      const at = name.indexOf(".");
      this.entry(name).deployed = { definition: { name, schema: name.slice(0, at), table: name.slice(at + 1), file, sql, orderBy, targetLag: { every, seconds: Number(seconds) }, comment },
        fingerprint, columns: JSON.parse(columns) as GeneratedColumn[], bases: JSON.parse(bases) as string[], basesSynced: basesSynced === null ? {} : JSON.parse(basesSynced) as Record<string, number | null>, snapshotAt: Number(snapshotAt), builtAt: Number(builtAt), rows: Number(count), seconds: took };
    }
    // marks die with a run: a base whose last sync is not the one the snapshot saw may have changed since. Never "synced
    // after the snapshot": a poll's time is its start, so one that began before the snapshot and committed after it would
    // be missed. A generated base's "last sync" is its own snapshot (`baseSynced`): a parent swapped in alone since the
    // child's run, a new definition's included, leaves the child stale; one built with the child leaves it current
    for (const entry of this.entries.values()) {
      const d = entry.deployed;
      if (d === null) continue;
      if (d.bases.some((b) => { const s = this.baseSynced(b); return s === null || d.basesSynced[b] === undefined || d.basesSynced[b] !== s; })) entry.dirtySince = d.snapshotAt;
    }
    const left = (await w.runAndReadAll(`SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = current_database() AND ends_with(table_name, '${SIDE_SUFFIX}')`)).getRowsJS() as Array<[string, string]>;
    for (const [schema, table] of left) await w.run(`DROP TABLE ${ident(schema)}.${ident(table)}`);
    const c = this.host.connection();
    // what a session sets (src/duck/store.ts SessionRunner): a plan means what it means under these
    await c.run("SET default_null_order = 'nulls_last_on_asc_first_on_desc'");
    await c.run("SET TimeZone = 'UTC'");
  }

  /** a base's last sync, ms; null: not known */
  private syncedMs(base: string): number | null { const s = this.host.syncedAt(base); return s === null ? null : Date.parse(s); }

  /** what a child's ledger row records of a base: a synced table's last sync, a generated table's snapshot (ms, as served
   *  now); null: not known */
  private baseSynced(base: string): number | null {
    const p = this.host.added(base) === null ? this.entries.get(base) : undefined;
    return p === undefined ? this.syncedMs(base) : p.deployed?.snapshotAt ?? null;
  }

  /** From here on the folder is read (`read`) and each definition held to the listener's catalog (`planner`). Resolves once
   *  they have been looked at, so a start can say what is refused. */
  async start(read: () => GeneratedRead, planner: Planner): Promise<void> {
    this.reader = read; this.planner = planner;
    await this.review();
    this.arm();
  }

  private arm(): void {
    if (this.stopped || this.reviewMs === 0) return;
    this.timer = setTimeout(() => { void this.review().finally(() => this.arm()); }, this.reviewMs);
    this.timer.unref();
  }

  /** the timer stopped, and what it was doing ended: the review, and a run's planning, the two that read the listener's
   *  catalog (a run past its plan sees `stopped` and ends; its build is the sync's stop to interrupt) */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    await this.reviewing;
    // settled, not awaited: its failure is the run's to say, or not, as stopped
    if (this.planning !== null) await Promise.allSettled([this.planning]);
  }

  private entry(name: string): Entry {
    let e = this.entries.get(name);
    if (e === undefined) {
      e = { name, wanted: null, fileRefused: null, checked: null, reads: [], cycle: null, blocked: null, seen: null, refusals: [], said: null, warnings: [], warned: null, waitingFor: null, deployed: null, dirtySince: null, taken: null, queued: false, running: false, failures: 0, retryAt: 0, error: null };
      this.entries.set(name, e);
    }
    return e;
  }

  // ------------------------------------------------------------------------------------------- what the sync reads

  /** the tables served, as the catalog declares them (src/duck/sync.ts `schemaBuilt`), but one a copy holds the name of */
  served(): Array<{ schema: string; table: string; columns: GeneratedColumn[]; comment: string | null }> {
    return [...this.entries.values()].flatMap((e) => e.deployed === null || this.host.added(e.name) !== null ? [] :
      [{ schema: e.deployed.definition.schema, table: e.deployed.definition.table, columns: e.deployed.columns, comment: e.deployed.definition.comment }]);
  }

  /** the tables a role may name, built or not: `columns` none until they are known (src/cli/roles.ts) */
  named(): Array<{ source: string; columns: ReadonlyArray<{ name: string }>; pending?: true }> {
    return [...this.entries.values()].filter((e) => e.wanted !== null || e.deployed !== null).map((e) => e.deployed !== null ? { source: e.name, columns: e.deployed.columns } : { source: e.name, columns: [], pending: true as const });
  }

  /** a base's commit changed its rows: called on the writer's turn, after that commit */
  changed(base: string): void {
    const now = Date.now();
    for (const e of this.entries.values()) if (e.dirtySince === null && e.deployed?.bases.includes(base)) e.dirtySince = now;
  }

  /** how far behind its bases a table is, seconds, across its chain: 0 when nothing is unreflected */
  private behind(e: Entry, now: number): number {
    const oldest = this.chainOldest(e);
    return oldest === null ? 0 : Math.max(0, (now - oldest) / 1000);
  }

  /** LAG ACROSS A CHAIN: the oldest base change not in `e`'s rows, its own or one a table it is built from has not
   *  reflected yet (that one is not in `e` either), anywhere below it; null: none. Measured against the base, never
   *  summed: a `1m` table over a `1m` table aims to be 1 minute behind the base, not 2 */
  private chainOldest(e: Entry, seen = new Set<string>()): number | null {
    seen.add(e.name);
    let oldest = this.oldest(e);
    for (const n of e.deployed?.bases ?? []) {
      const p = this.entries.get(n);
      if (p === undefined || seen.has(n) || this.host.added(n) !== null) continue;
      const o = this.chainOldest(p, seen);
      if (o !== null && (oldest === null || o < oldest)) oldest = o;
    }
    return oldest;
  }

  /** the oldest change not in the table: a run's, until its swap, or one since */
  private oldest(e: Entry): number | null { return e.taken === null ? e.dirtySince : e.dirtySince === null ? e.taken : Math.min(e.taken, e.dirtySince); }

  private stateOf(e: Entry): GeneratedState {
    if (e.fileRefused !== null || e.refusals.length > 0) return "refused";
    if (e.deployed === null) return e.running || e.queued ? "building" : e.error !== null ? "failed" : e.waitingFor !== null || e.blocked !== null ? "waiting" : "building";
    if (e.error !== null) return "failed";
    return this.chainOldest(e) !== null ? "behind" : "current";
  }

  status(now = Date.now()): GeneratedStatus[] {
    return [...this.entries.values()].map((e): GeneratedStatus => {
      const d = e.wanted ?? e.deployed?.definition ?? null;
      const refusals = e.fileRefused?.refusals ?? e.refusals;
      const file = e.fileRefused?.file ?? d?.file ?? e.name;
      const target = e.deployed?.definition.targetLag ?? d?.targetLag ?? null;
      const behindSeconds = this.behind(e, now), since = this.chainOldest(e);
      return { table: e.name, file, kind: e.fileRefused !== null ? e.fileRefused.kind : "scheduled", method: "whole", state: this.stateOf(e), targetLag: target?.every ?? null, behindSeconds,
        behindSince: since === null ? null : new Date(since).toISOString(),
        missingTarget: target !== null && behindSeconds > target.seconds, serving: e.deployed !== null,
        lastRun: e.deployed === null ? null : { at: new Date(e.deployed.builtAt).toISOString(), seconds: e.deployed.seconds, rows: e.deployed.rows },
        error: e.error, retryAt: e.error === null ? null : new Date(e.retryAt).toISOString(), refusals: refusals.map((r) => ({ ...r, text: refusalText(file, r) })), waitingFor: this.waitingWords(e), warnings: e.warnings.map((w) => `${file}: ${w}`) };
    }).sort((a, b) => a.table.localeCompare(b.table));
  }

  /** what `e` waits for, as `GeneratedStatus.waitingFor` says it: the table's name, with why it blocks as that table is
   *  NOW (refused with nothing deployed, or its last run failed), read here and never stored, so `mason wait` decides
   *  from what is so when it reads (src/cli/readiness.ts `generatedReadiness`) */
  private waitingWords(e: Entry): string | null {
    if (e.waitingFor !== null) { const why = this.refusedOrFailed(e.waitingFor); return why === null ? e.waitingFor : `${e.waitingFor}, which ${why}`; }
    if (e.blocked !== null) { const why = this.refusedOrFailed(e.blocked); return why === null ? e.blocked : `${e.blocked} ${why}`; }
    return null;
  }

  /** the tables as the listener takes the sync's states (`Sync.state`): how EXPLAIN says each is kept current, and what a
   *  statement is told of one not built yet (src/duck/plan.ts `missingRelationHint`) */
  copies(now = Date.now()): CopyState[] {
    return this.status(now).map((s) => {
      const lag = s.behindSeconds === 0 ? "nothing behind" : `${Math.round(s.behindSeconds)} s behind`;
      const last = s.lastRun === null ? "never built" : `last re-run ${s.lastRun.at}`;
      const words = s.serving ? `generated from ${s.file}: scheduled, re-run whole, target ${s.targetLag}, ${lag}; ${last}${s.error === null ? "" : `; its last run failed: ${s.error}`}` :
        s.state === "refused" ? `refused: ${s.refusals[0]?.message ?? ""}` : s.state === "failed" ? `its first build failed: ${s.error ?? ""}` : s.state === "waiting" ? `waiting for ${s.waitingFor ?? "a table"}` : "being built";
      return { source: s.table, phase: s.serving ? "copied" : "copying", rows: s.lastRun?.rows ?? null, bytes: null, seconds: s.lastRun?.seconds ?? null, copiedAt: s.lastRun?.at ?? null, error: s.error, kept: { by: "generated", text: words } };
    });
  }

  // ---------------------------------------------------------------------------------------------------- the review

  /** The folder read, each definition held to the catalog, and what is due queued: every `reviewMs`, one at a time. */
  review(): Promise<void> {
    this.reviewing ??= this.reviewed().catch((e: unknown) => {
      this.host.log(`generated tables: the review failed, and runs again (Mason bug: report it): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }).finally(() => { this.reviewing = null; });
    return this.reviewing;
  }

  private async reviewed(): Promise<void> {
    if (this.reader === null || this.stopped) return;
    const read = this.reader();
    const wanted = new Map(read.definitions.map((d) => [d.name, d])), refused = new Map(read.refused.map((r) => [r.name, r]));
    for (const name of new Set([...wanted.keys(), ...refused.keys()])) this.entry(name);
    for (const e of this.entries.values()) {
      e.wanted = wanted.get(e.name) ?? null;
      e.fileRefused = refused.get(e.name) ?? null;
      e.reads = e.wanted === null ? [] : await readsByName(e.wanted.sql);
    }
    this.findCycles();
    for (const e of [...this.entries.values()]) {
      // a stop mid-review: the listener's catalog may be closing, and nothing is planned on it
      if (this.stopped) return;
      this.say(e);
      if (e.wanted === null && e.fileRefused === null) { await this.remove(e); continue; }
      await this.check(e);
      if (!e.running) this.schedule(e);
    }
  }

  /** a refusal said once, when it starts or changes */
  private say(e: Entry): void {
    const file = e.fileRefused?.file ?? e.wanted?.file ?? e.name, list = e.fileRefused?.refusals ?? e.refusals;
    const words = list.length === 0 ? null : list.map((r) => refusalText(file, r)).join("\n");
    if (words !== e.said) {
      if (words !== null) this.host.log(`${words}${e.deployed !== null ? `\n  ${e.name} keeps serving what it was last built from.` : ""}`);
      else this.host.log(`${file}: no longer refused`);
      e.said = words;
    }
    const warned = e.warnings.length === 0 ? null : e.warnings.map((w) => `${file}: ${w}`).join("\n");
    if (warned !== null && warned !== e.warned) this.host.log(warned);
    e.warned = warned;
  }

  /** its file gone: the table goes, unless a run has it (the run's end looks again) or a copy now holds its name */
  private async remove(e: Entry): Promise<void> {
    if (e.running || e.queued) return;
    this.entries.delete(e.name);
    if (e.deployed === null) return;
    const d = e.deployed.definition;
    const copy = this.host.added(e.name) !== null;
    await this.host.onWriter(async () => {
      const w = this.store.writer;
      await w.run("BEGIN TRANSACTION");
      try {
        if (!copy) await w.run(`DROP TABLE IF EXISTS ${ident(d.schema)}.${ident(d.table)}`);
        await w.run(`DELETE FROM ${GENERATED_LEDGER} WHERE name = ${literal(e.name)}`);
        await w.run("COMMIT");
      } catch (x) { await w.run("ROLLBACK"); throw x; }
    });
    this.host.log(`${e.name}: its file is gone, so the generated table is dropped`);
    await this.host.rebuildCatalog();
  }

  /** the generated tables `n` reads: by its SQL's names, and by what the plan said where it was checked; what it was
   *  built from where its file is gone or refused */
  private readsOf(n: string, names: ReadonlySet<string>): string[] {
    const e = this.entries.get(n);
    if (e === undefined) return [];
    // what the plan read, only while `wanted` is the definition it planned: an edit's reads are its names until checked
    const planned = e.checked !== null && e.wanted !== null && e.seen?.json === JSON.stringify(e.wanted) ? e.checked.bases : [];
    return [...new Set([...e.reads, ...planned, ...(e.wanted === null ? e.deployed?.bases ?? [] : [])])].filter((x) => names.has(x));
  }

  /** the shortest way from `self` through what each reads back to `self`, as the tables in order (self first and last) */
  private cycleOf(self: string, reads: (n: string) => readonly string[]): string[] | null {
    const from = new Map<string, string>(), queue = [self];
    while (queue.length > 0) {
      const n = queue.shift()!;
      for (const d of reads(n)) {
        if (d === self) {
          const back: string[] = [];
          for (let at = n; at !== self; at = from.get(at)!) back.push(at);
          return [self, ...back.reverse(), self];
        }
        if (!from.has(d)) { from.set(d, n); queue.push(d); }
      }
    }
    return null;
  }

  /** each definition whose SQL's names read itself, through others or not: refused before its check */
  private findCycles(): void {
    const names = this.names("");
    for (const e of this.entries.values()) {
      const cycle = e.wanted === null || !names.has(e.name) ? null : this.cycleOf(e.name, (n) => this.readsOf(n, names));
      e.cycle = cycle === null ? null : cycleRefusal(cycle);
    }
  }

  /** `wanted` held to the catalog as it is now: once per definition and per catalog */
  private async check(e: Entry): Promise<void> {
    const planner = this.planner, schema = this.host.schema();
    if (planner === null) return;
    const def = e.wanted;
    if (def === null) { e.checked = null; e.seen = null; e.refusals = []; e.waitingFor = null; return; }
    const held = this.host.added(e.name);
    if (held !== null) {
      e.checked = null; e.seen = null; e.waitingFor = null;
      await this.release(e);
      e.refusals = [{ key: null, message: `${e.name} is a ${held === "view" ? "view of the database" : "table the sources file syncs"}`, why: "A name holds one table.", options: ["rename this file", "or take the table out of the sources file"] }];
      this.say(e);
      return;
    }
    if (e.cycle !== null) {
      e.checked = null; e.seen = null; e.waitingFor = null; e.refusals = [e.cycle];
      this.say(e);
      return;
    }
    // a parent's target_lag is held against this one's: looked at again when any table's target moves
    const json = JSON.stringify([def, [...this.entries.values()].map((p) => [p.name, this.targetOf(p)?.seconds ?? null])]);
    if (e.seen?.json === json && e.seen.schema === schema) return;
    e.seen = { json, schema };
    try {
      const r = await planDefinition(planner, def.sql, def.orderBy);
      e.waitingFor = null;
      e.warnings = "refused" in r ? [] : r.definition.warnings;
      // what its names did not show (a name the plan resolved otherwise): a cycle by what the plan reads
      const names = this.names(e.name);
      const cycle = "refused" in r ? null : this.cycleOf(e.name, (n) => n === e.name ? r.definition.bases.filter((x) => names.has(x)) : this.readsOf(n, names));
      if ("refused" in r) { e.checked = null; e.refusals = r.refused; }
      else if (cycle !== null) { e.checked = null; e.refusals = [cycleRefusal(cycle)]; }
      else if (this.fresherThan(def, r.definition.bases, names) !== null) { e.checked = null; e.refusals = [this.fresherThan(def, r.definition.bases, names)!]; }
      else {
        const fingerprint = createHash("sha256").update(JSON.stringify([def.sql, def.orderBy, r.definition.columns.map((c) => [c.name, c.type, c.duck])])).digest("hex");
        e.checked = { definition: def, fingerprint, bases: r.definition.bases };
        e.refusals = [];
      }
    } catch (x) {
      if (!(x instanceof StatementError)) throw x;
      e.checked = null;
      const missing = x.fields.code === "42P01" ? /^relation "([^"]+)" does not exist$/.exec(x.fields.message)?.[1] : undefined;
      const adding = missing === undefined ? null : this.host.added(missing.includes(".") ? missing : `public.${missing}`);
      // a parent not built yet: waited for by name; why it is refused or its build failed is read when it is said
      const parent = x.gap === "generated-not-built" ? /the generated table (\S+) is not built yet/.exec(x.fields.message)?.[1] : undefined;
      if (adding === "adding") { e.waitingFor = missing!; e.refusals = []; }
      else if (parent !== undefined) { e.waitingFor = parent; e.refusals = []; }
      else { e.waitingFor = null; e.refusals = [refusalOf(x)]; }
    }
    this.say(e);
  }

  /** the `target_lag` a table is kept to: its file's, else what it was built from. A table refused in its file but
   *  deployed runs at what it was built from, so that is what a child is held to, never the refused file's */
  private targetOf(e: Entry): { every: string; seconds: number } | null {
    const running = e.fileRefused !== null || e.refusals.length > 0 ? e.deployed?.definition.targetLag : undefined;
    return running ?? e.wanted?.targetLag ?? e.deployed?.definition.targetLag ?? null;
  }

  /** A CHILD'S TARGET AGAINST ITS PARENT'S: a table can be no fresher than a generated table it reads, so a `target_lag`
   *  shorter than a parent's is refused by name, with the way out; null: none is */
  private fresherThan(def: GeneratedDefinition, bases: readonly string[], names: ReadonlySet<string>): GeneratedRefusal | null {
    for (const n of bases) {
      const p = this.entries.get(n), target = p === undefined || !names.has(n) ? null : this.targetOf(p);
      if (target === null || def.targetLag.seconds >= target.seconds) continue;
      return { key: "target_lag", message: `target_lag ${def.targetLag.every} is shorter than that of ${n}, which it reads (${target.every})`,
        why: "A table can be no fresher than a generated table it reads: its rows wait for the parent's run.",
        options: [`set target_lag: ${target.every} or longer`, `or shorten ${n}'s target_lag to ${def.targetLag.every}`] };
    }
    return null;
  }

  /** the generated tables' names, itself among them: a file refused for holding a synced table's name names no generated
   *  table */
  private names(self: string): Set<string> { return new Set([...this.entries.keys(), self].filter((n) => n !== "" && this.host.added(n) === null)); }

  /** why a parent blocks what reads it: refused with nothing deployed, or its last run failed; null: neither. A parent
   *  refused in its file but deployed is re-run from what it was built from, and feeds its children from that */
  private refusedOrFailed(name: string): string | null {
    const p = this.entries.get(name);
    if (p === undefined) return null;
    if ((p.fileRefused !== null || p.refusals.length > 0) && p.deployed === null) return "is refused";
    return p.error === null ? null : "failed its last run";
  }

  /** the generated tables `e` is built from now */
  private parentsOf(e: Entry): string[] {
    const b = this.buildable(e);
    return b === null ? [] : b.bases.filter((x) => this.entries.has(x) && this.host.added(x) === null);
  }

  /** the table that keeps `e` from being run: a parent, or a parent's parent, refused or failed; null: nothing blocks it */
  private blocker(e: Entry, seen = new Set<string>()): string | null {
    seen.add(e.name);
    for (const p of this.parentsOf(e)) {
      if (seen.has(p)) continue;
      if (this.refusedOrFailed(p) !== null) return p;
      const up = this.blocker(this.entries.get(p)!, seen);
      if (up !== null) return up;
    }
    return null;
  }

  /** `e` not run because of the table `by`, said once per table */
  private block(e: Entry, by: string): void {
    if (e.blocked !== by) this.host.log(`${e.name}: not run, because ${by} ${this.refusedOrFailed(by) ?? "is not ready"}`);
    e.blocked = by;
  }

  /** a base is there to read: a synced table synced, or a generated table built */
  private ready(name: string): boolean {
    const held = this.host.added(name);
    return held === "copied" || (held === null && this.entries.get(name)?.deployed != null);
  }

  /** whom a run of `e` belongs to: the farthest parent with changes not in it, which builds `e` after it */
  private rootOf(e: Entry, seen = new Set<string>()): Entry {
    seen.add(e.name);
    for (const n of this.parentsOf(e)) {
      const p = this.entries.get(n)!;
      if (seen.has(n) || p.deployed === null || this.oldest(p) === null || p.running || Date.now() < p.retryAt) continue;
      return this.rootOf(p, seen);
    }
    return e;
  }

  /** what a run of `root` builds, parents before children: `root`, then every table that reads one of them whose other
   *  parents are built and blocked by nothing. Not the children of a new definition: theirs is a plan over what the
   *  catalog says once it is swapped in. A parent refused in its file runs its deployed definition, and carries them */
  private unitOf(root: Entry): Entry[] {
    const now = Date.now(), set = new Map([[root.name, root]]);
    // a table of this run feeds its children unless it is a new definition: refused in its file, it is re-run from what it
    // was built from, which the catalog and its children already hold (its own failure is what this run tries again)
    const feeds = (p: Entry): boolean => p.deployed !== null && p.deployed.fingerprint === this.buildable(p)?.fingerprint;
    for (let grew = true; grew;) {
      grew = false;
      for (const c of this.entries.values()) {
        if (set.has(c.name) || c.running || this.buildable(c) === null || now < c.retryAt) continue;
        const parents = this.parentsOf(c);
        if (!parents.some((x) => set.has(x))) continue;
        if (parents.some((x) => set.has(x) ? !feeds(set.get(x)!) : !this.ready(x) || this.refusedOrFailed(x) !== null)) continue;
        set.set(c.name, c); grew = true;
      }
    }
    const order: Entry[] = [], placed = new Set<string>(), members = [...set.values()];
    for (;;) {
      const next = members.find((m) => !placed.has(m.name) && this.parentsOf(m).every((x) => !set.has(x) || placed.has(x)));
      if (next === undefined) break;
      order.push(next); placed.add(next.name);
    }
    return order;
  }

  /**
   * A NAME A SYNCED TABLE NOW HOLDS (`mason add` of the generated table's name): the synced table wins, so what was deployed
   * is forgotten, its ledger row with it, and the table under that name, now the copy's, is never touched. Not while a run
   * has it: the run's end looks again, and its swap looks on the writer's turn and abandons the run if a synced table
   * holds the name (`swap`).
   */
  private async release(e: Entry): Promise<void> {
    if (e.deployed === null || e.running || e.queued) return;
    e.deployed = null; e.dirtySince = null; e.taken = null; e.error = null;
    await this.host.onWriter(() => this.store.writer.run(`DELETE FROM ${GENERATED_LEDGER} WHERE name = ${literal(e.name)}`));
    this.host.log(`${e.name}: a synced table now holds its name, so the generated table is no longer kept`);
  }

  /** what to build from now: the file's definition where the catalog passed it, else what was deployed; nothing where a
   *  synced table holds the name */
  private buildable(e: Entry): { definition: GeneratedDefinition; fingerprint: string; bases: string[] } | null {
    if (this.host.added(e.name) !== null) return null;
    if (e.checked !== null && e.refusals.length === 0 && e.fileRefused === null) return { definition: e.checked.definition, fingerprint: e.checked.fingerprint, bases: e.checked.bases };
    return e.deployed === null ? null : { definition: e.deployed.definition, fingerprint: e.deployed.fingerprint, bases: e.deployed.bases };
  }

  /** queued when it is due: never built, a new definition, or the oldest change near its target */
  private schedule(e: Entry, now = Date.now()): void {
    const b = this.buildable(e);
    if (b === null || e.queued || e.running || now < e.retryAt || this.stopped) return;
    if (e.deployed === null || e.deployed.fingerprint !== b.fingerprint) { this.queue(e); return; }
    if (e.dirtySince === null || e.deployed.bases.some((x) => !this.ready(x))) return;
    if (now - e.dirtySince >= (b.definition.targetLag.seconds * 1000) - (e.deployed.seconds * 1000)) this.queue(e);
  }

  private queue(e: Entry): void { e.queued = true; this.host.enqueue(e.name); }

  // ------------------------------------------------------------------------------------------------------ the run

  /** ONE RUN, in the rebuild queue: never throws but `Stopping`; its failure is its own to say. A run of a table is its
   *  chain's: a parent's builds its children after it, and a child's is its dirty parent's (`rootOf`, `unitOf`). A table
   *  that fails takes the tables built from it out of the run, which is tried again without them.
   *  ONE RUN AT A TIME, whoever asks: a run asked while another is in flight waits for it to end. `rootOf` and `unitOf`
   *  leave out a table a run has (`running`), so a run beside another would build a parent and leave its child over the
   *  old one; the rebuild queue asks one at a time, and this holds it for any other caller too (issue 195). */
  run(name: string): Promise<void> {
    const ran = this.runs.then(() => this.runAlone(name));
    // the next waits for this one's end, not its outcome: its Stopping is its caller's
    this.runs = ran.then(() => undefined, () => undefined);
    return ran;
  }

  private async runAlone(name: string): Promise<void> {
    const asked = this.entries.get(name), planner = this.planner;
    if (asked === undefined) return;
    asked.queued = false;
    if (this.buildable(asked) === null || planner === null || this.stopped) return;
    const why = this.blocker(asked);
    if (why !== null) { this.block(asked, why); return; }
    const root = this.rootOf(asked);
    let members = this.unitOf(root);
    // a child the run leaves out because a parent in it is refused, or is a new definition: said or looked at again
    for (const c of this.entries.values()) {
      if (members.includes(c) || !this.parentsOf(c).some((x) => members.some((m) => m.name === x))) continue;
      const blocked = this.blocker(c);
      if (blocked !== null) this.block(c, blocked);
    }
    while (members.length > 0) {
      const failed = await this.build(members, planner);
      if (failed === null) return;
      const gone = new Set([failed.name]);
      for (const m of members) if (this.parentsOf(m).some((x) => gone.has(x))) { gone.add(m.name); this.block(m, failed.name); }
      members = members.filter((m) => !gone.has(m.name));
    }
  }

  /** `members` built, parents first, in ONE transaction over one snapshot, each child over its parents' side tables, and
   *  swapped in on ONE writer's turn. The table that failed, its failure said; null when built or abandoned */
  private async build(members: Entry[], planner: Planner): Promise<Entry | null> {
    const started = Date.now();
    let open = false, at = members[0]!;
    // what each builds, read now, before anything awaits: a sources file reloaded while it plans changes nothing of this
    // run. One with nothing to build now (its name taken since the run was asked): nothing is built, the review looks again
    const buildables = members.map((m) => this.buildable(m));
    if (buildables.some((b) => b === null)) return null;
    const c = this.host.connection();
    for (const m of members) m.running = true;
    try {
      const sides = new Map<string, string>();
      const plans: Array<{ e: Entry; b: NonNullable<ReturnType<GeneratedTables["buildable"]>>; plan: DefinitionPlanOf; target: string; side: string }> = [];
      for (const [i, m] of members.entries()) {
        at = m;
        const b = buildables[i]!, d = b.definition;
        // planned now, for what it reads as of now (a stored JSON path may have come or gone since it was checked), a
        // parent built in this run read as its side table
        const relations = new Map(b.bases.filter((x) => sides.has(x)).map((x) => [x, sides.get(x)!]));
        const planning = planDefinition(planner, d.sql, d.orderBy, relations);
        this.planning = planning;
        const planned = await planning.finally(() => { if (this.planning === planning) this.planning = null; });
        // a stop came while it planned: nothing is built, and nothing failed
        if (this.stopped) return null;
        if ("refused" in planned) throw new Error(planned.refused[0]!.message);
        sides.set(m.name, `${d.table}${SIDE_SUFFIX}`);
        plans.push({ e: m, b, plan: planned.definition, target: `${ident(d.schema)}.${ident(d.table)}`, side: `${ident(d.schema)}.${ident(`${d.table}${SIDE_SUFFIX}`)}` });
      }
      at = members[0]!;
      await this.searchPath(c);
      for (const s of new Set(plans.map((p) => p.b.definition.schema))) await c.run(`CREATE SCHEMA IF NOT EXISTS ${ident(s)}`);
      await c.run("BEGIN TRANSACTION");
      open = true;
      const bases = [...new Set(plans.flatMap((p) => p.plan.bases))];
      // THE SNAPSHOT AND THE MARKS, TOGETHER: this read takes the snapshot on the writer's turn, so a commit before it is
      // in the snapshot and a commit after it marks the next run. Every table of the chain reads this one snapshot
      const clock = await this.host.onWriter(async () => {
        await c.runAndReadAll(`SELECT count(*) FROM ${GENERATED_LEDGER}`);
        for (const m of members) { m.taken = m.dirtySince; m.dirtySince = null; }
        // a parent of this run is recorded at this snapshot, one served at its own, read on this turn as its swap is
        const now = Date.now();
        return { at: now, synced: Object.fromEntries(bases.map((x) => [x, members.some((m) => m.name === x) ? now : this.baseSynced(x)])) };
      });
      for (const m of members) await this.onStep("snapshot", m.name);
      const written: Array<{ e: Entry; n: Deployed; side: string; target: string }> = [];
      for (const p of plans) {
        at = p.e;
        const { plan, columns } = p.plan;
        const params: string[] = [];
        if (plan.clock?.exec !== undefined) params[plan.clock.exec - 1] = new Date(clock.at).toISOString();
        const aliases = columns.map((_, i) => `__mason_c${i}`);
        const sql = `CREATE OR REPLACE TABLE ${p.side} (${columns.map((x) => ident(x.name)).join(", ")}) AS SELECT ${columns.map((x, i) => { const v = x.expr ?? aliases[i]!; return x.duck === null ? v : `CAST(${v} AS ${x.duck})`; }).join(", ")} ` +
          `FROM (${plan.sql.text}) AS __mason_output(${aliases.join(", ")})`;
        const { rowsChanged } = await this.host.interruptible(() => c.run(sql, params.length > 0 ? params : undefined));
        await this.onStep("written", p.e.name);
        written.push({ e: p.e, side: p.side, target: p.target, n: { definition: p.b.definition, fingerprint: p.b.fingerprint, columns, bases: p.plan.bases,
          basesSynced: Object.fromEntries(p.plan.bases.map((x) => [x, clock.synced[x] ?? null])), snapshotAt: clock.at, builtAt: 0, rows: Number(rowsChanged), seconds: 0 } });
      }
      at = members[0]!;
      await c.run("COMMIT");
      open = false;
      for (const m of members) await this.onStep("committed", m.name);
      const seconds = (Date.now() - started) / 1000, builtAt = Date.now();
      for (const w of written) { w.n.seconds = seconds; w.n.builtAt = builtAt; }
      if (!await this.host.onWriter(() => this.swap(written))) {
        // a synced table took a name while it ran: what it built is dropped, and the next review lets the name go; what
        // this run took is still not in the table, so it stays dirty should the name come back (the sources file reverted)
        for (const m of members) { m.dirtySince = this.oldest(m); m.taken = null; }
        this.host.log(`${members.map((m) => m.name).join(", ")}: a synced table now holds ${members.length === 1 ? "its name" : "one of their names"}, so what this run built was dropped`);
        return null;
      }
      for (const m of members) await this.onStep("swapped", m.name);
      // what each swap brought, across the run: the oldest change any member at or below it took (parents come first in
      // `written`), so a child left out under a member that took nothing itself is marked at the base change, never at
      // the swap
      const chainTook = new Map<string, number | null>();
      for (const w of written) {
        let t = w.e.taken;
        for (const p of w.n.bases) { const q = chainTook.get(p); if (q !== undefined && q !== null && (t === null || q < t)) t = q; }
        chainTook.set(w.e.name, t);
      }
      for (const w of written) {
        const e = w.e, was = e.error;
        e.deployed = w.n; e.taken = null; e.error = null; e.failures = 0; e.retryAt = 0; e.blocked = null;
        // what reads it and was not built with it is behind it, whatever its definition: a new one, a child this run
        // left out, or one whose own build failed and was taken out of the run (its marks were the parent's)
        this.changedGenerated(e.name, members, chainTook.get(e.name) ?? null);
        if (was !== null) this.host.event({ kind: "recovered", table: e.name, message: `its re-run succeeded (it had failed: ${was})` });
      }
      await this.host.rebuildCatalog();
      for (const w of written) this.host.log(`generated ${w.e.name}: ${w.n.rows.toLocaleString("en-US")} row(s) in ${seconds.toFixed(1)} s`);
      return null;
    } catch (x) {
      if (open) await c.run("ROLLBACK");
      // what this run took is still not in the tables
      for (const m of members) { m.dirtySince = this.oldest(m); m.taken = null; }
      if (this.host.stopping(x)) throw x;
      at.failures++;
      const attempt = Date.now() - started;
      at.retryAt = Date.now() + this.host.retryDelayMs(at.failures, attempt);
      const fields = x instanceof StatementError ? x.fields.message : x instanceof Error ? x.message : String(x);
      at.error = withoutValues(fields);
      const m = `its re-run failed (it serves what it last held; tried again after ${new Date(at.retryAt).toISOString()}): ${at.error}`;
      this.host.log(`${at.name}: ${m}`);
      this.host.event({ kind: "generated_failed", table: at.name, message: m });
      return at;
    } finally {
      for (const m of members) m.running = false;
    }
    // a file gone, or changed, while it ran: the next review looks
  }

  /** a generated table swapped in: what reads it and was not built with it is marked, as a base's commit marks, at the
   *  oldest base change the swap brought (`took`), so its lag is still measured against the base; now for a new
   *  definition, which no base change brought */
  private changedGenerated(name: string, built: readonly Entry[], took: number | null): void {
    const at = took ?? Date.now();
    for (const e of this.entries.values()) {
      if (built.includes(e) || !e.deployed?.bases.includes(name)) continue;
      if (e.dirtySince === null || at < e.dirtySince) e.dirtySince = at;
    }
  }

  /** the search_path a definition is planned under (`public`), once that schema exists */
  private async searchPath(c: DuckConnection): Promise<void> {
    const there = (await c.runAndReadAll("SELECT count(*) FROM duckdb_schemas() WHERE database_name = current_database() AND schema_name = 'public'")).getRowsJS()[0]![0] as bigint;
    await c.run(`SET search_path = '${there > 0n ? "public" : "main"}'`);
  }

  /** THE SWAP, ON THE WRITER'S TURN, as a copy's is: every side table of the run replaces its table, with its ledger
   *  row, in ONE transaction, never beside a write, so a chain swaps in at one moment. The ledger row is what the table
   *  is re-run from after a restart. False, and the side tables dropped, when a synced table now holds a name: on this
   *  turn, so no copy's swap comes between. */
  private async swap(built: ReadonlyArray<{ e: Entry; n: Deployed; side: string; target: string }>): Promise<boolean> {
    const w = this.store.writer;
    if (built.some((b) => this.host.added(b.e.name) !== null)) { for (const b of built) await w.run(`DROP TABLE IF EXISTS ${b.side}`); return false; }
    await w.run("BEGIN TRANSACTION");
    try {
      for (const { e, n, side, target } of built) {
        const d = n.definition;
        await w.run(`DROP TABLE IF EXISTS ${target}`);
        await w.run(`ALTER TABLE ${side} RENAME TO ${ident(d.table)}`);
        await w.run(`INSERT OR REPLACE INTO ${GENERATED_LEDGER} VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::TIMESTAMPTZ, $12::TIMESTAMPTZ, $13, $14, $15)`,
          [e.name, d.file, d.sql, d.orderBy, d.targetLag.every, d.targetLag.seconds, d.comment, n.fingerprint, JSON.stringify(n.columns), JSON.stringify(n.bases),
            new Date(n.snapshotAt).toISOString(), new Date(n.builtAt).toISOString(), n.rows, n.seconds, JSON.stringify(n.basesSynced)]);
      }
      await w.run("COMMIT");
    } catch (x) { await w.run("ROLLBACK"); throw x; }
    return true;
  }
}
