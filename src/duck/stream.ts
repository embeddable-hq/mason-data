/**
 * THE DUCKDB COPY KEPT CURRENT BY LOGICAL REPLICATION (replication for the DuckDB case, only to sync the copied tables).
 * `mason start --replication` on Mason's own publication and
 * slot on the developer's database (src/cli/replication-mode.ts), the slot's `pgoutput` stream (src/cdc/pgoutput.ts,
 * over src/cdc/pg-wire.ts) applied to the copied tables (src/duck/sync.ts `applyChanges`) instead of polling them.
 *
 * WHY REPLAYING IS SAFE. Every change of a table with a primary key is a whole row set at its key, or a key removed,
 * so the changes of a key applied in commit order end at the key's state whatever state they started from. The copy
 * and the stream may therefore overlap: a change the copy already holds is applied again, and the row passes back
 * through its older states until the stream reaches the copy's snapshot (a reader may see one of them for that long).
 * What may NOT happen is a gap — and the stream runs WHILE tables are copied (a copy runs beside the
 * stream, never instead of it), acknowledging positions as it goes, so the changes of a table it does not stream yet
 * are skipped and never come again. So a table JOINS the stream only once caught up (Sync `swap`, `catchUp`):
 *   1. at a moment J, between two applied batches (the writer's turn), the stream starts decoding the table's changes
 *      and HOLDING them, applying none;
 *   2. ONE poll from the table's watermark reads, in a source snapshot P taken after J, every row changed since it. The
 *      watermark is at or before the first change the stream could have skipped: a copy's snapshot is pinned before
 *      its rows are read, and the stream skipped the table only from the copy's start (a re-copy: from when it left);
 *      a slot new to the copy carries nothing from before it, and the watermark is the table's last poll. Every skipped
 *      change committed before J, so before P: it is in what the poll writes;
 *   3. the held changes — every change decoded after J — are applied after the poll, in commit order, and from then on
 *      the stream applies the table's changes as they come. Those between J and P are in both, which is the overlap
 *      above: safe.
 * A table being copied again leaves the stream first (its changes are skipped from then on, and its new copy's
 * snapshot is after that), then joins the same way. Every table's lookup is made at each change
 * (`StreamTarget.tables`), so a table joins or leaves without a restart.
 * Held by tests/integration/duck-stream.itest.ts: changes committed while a table copies are in DuckDB once it is
 * caught up, the stream never stopped.
 *
 * EXCEPT AN UNCHANGED TOAST VALUE: an UPDATE that leaves a large value as it was carries no value for it (pgoutput's
 * `u`). The row DuckDB holds keeps its own; a row DuckDB does not hold (the copy had it deleted, or a TRUNCATE in the
 * batch) is read from the source by its key, its value as it is now — later changes in the stream bring it on.
 *
 * WHAT IS ACKNOWLEDGED: a batch of whole transactions is applied in ONE DuckDB transaction with the position it ends
 * at (`_mason.stream_state`), and only then is the position sent to Postgres (`sendStatus`). A run that dies between
 * reads the unacknowledged tail again, and skips the commits its own record says it applied.
 *
 * A LARGE TRANSACTION IS APPLIED IN PIECES (a migration's UPDATE of tens of millions of rows is one
 * transaction). Folded whole, it sat in Node's heap until its commit, then went into DuckDB as one transaction, whose
 * own state grows until the commit (`PIECE_CHANGES` says what was measured). So once `flushRows` changes are folded
 * inside a transaction they are applied and COMMITTED without a position (`apply(batch, null)`), and the fold starts
 * again; the position is recorded, and acknowledged, only with the transaction's last piece. A run that dies between
 * pieces has recorded no commit at or past this one, so it reads the transaction again from its BEGIN and applies it
 * whole: what the earlier pieces wrote is written again, which replaying makes safe (above). A piece's partial row (an
 * unchanged-TOAST update) whose earlier row went in an earlier piece is applied as an UPDATE of the columns it carries,
 * as one whose row the copy holds always is.
 */
import { decode, type RelationColumn, type TupleValue } from "../cdc/pgoutput.ts";
import { PgConnection, formatLsn, pgIdent, pgLiteral } from "../cdc/pg-wire.ts";

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * A DECODED TUPLE AS THE COPY'S COLUMNS (`columns`, the copy's order), from the relation's: a column the publication sends
 * and the copy lacks is dropped; a column of the copy the tuple leaves unchanged (TOAST) is `undefined`, kept by the row
 * DuckDB holds. pgoutput's relation is what ARRIVES, never what is written: the copy's own record decides a write's
 * shape (the test server: a held change written in the shape of the moment named a column its copy did not have).
 */
export function projectTuple(relation: readonly RelationColumn[], tuple: readonly TupleValue[], columns: readonly string[]): Array<string | null | undefined> {
  return columns.map((name) => {
    const at = relation.findIndex((c) => c.name === name);
    if (at < 0) return undefined;
    const v = tuple[at]!;
    return v.kind === "text" ? v.text : v.kind === "null" ? null : undefined;
  });
}

/** the copy's columns a relation does not carry, but for those Postgres never publishes (`generated`, read from the
 *  source instead): what refuses the table (`StreamTarget.refuse`) */
export function missingFrom(relation: readonly RelationColumn[], table: StreamedTable): string[] {
  return table.columns.filter((name) => !relation.some((c) => c.name === name) && !(table.generated ?? []).includes(name));
}

/** A Postgres array's text (`{1,"a b",NULL}`, `{{1,2},{3,4}}`, `[0:1]={…}`) as nested lists of element texts. */
export type PgArray = Array<string | null | PgArray>;
export function pgArrayTree(text: string): PgArray {
  let s = text;
  const eq = s.indexOf("=");
  if (s.startsWith("[") && eq > 0) s = s.slice(eq + 1);
  let i = 0;
  const fail = (): never => { throw new Error(`malformed array literal: ${text}`); };
  const space = (): void => { while (i < s.length && /\s/.test(s[i]!)) i++; };
  const list = (): PgArray => {
    if (s[i] !== "{") fail();
    i++;
    const out: PgArray = [];
    space();
    if (s[i] === "}") { i++; return out; }
    for (;;) {
      space();
      if (s[i] === "{") out.push(list());
      else if (s[i] === '"') {
        i++;
        let v = "";
        while (i < s.length && s[i] !== '"') { if (s[i] === "\\") i++; v += s[i++]; }
        if (s[i] !== '"') fail();
        i++;
        out.push(v);
      } else {
        let v = "";
        while (i < s.length && s[i] !== "," && s[i] !== "}") v += s[i++];
        v = v.trim();
        out.push(v.toUpperCase() === "NULL" ? null : v);
      }
      space();
      if (s[i] === ",") { i++; continue; }
      if (s[i] === "}") { i++; return out; }
      fail();
    }
  };
  space();
  const tree = list();
  space();
  if (i !== s.length) fail();
  return tree;
}

/**
 * A Postgres value's TEXT (as pgoutput sends it) as a DuckDB expression of the copy's column type (`DESCRIBE`'s
 * spelling): what the copy stores for the same value, held by tests/integration/duck-stream.itest.ts against a copy
 * of every type the oracle's type matrix has. A bytea is Postgres's hex output (`\x…`), an array its `{…}` literal.
 */
export function duckValue(text: string | null, type: string): string {
  if (text === null) return "NULL";
  if (type.endsWith("[]")) return duckList(pgArrayTree(text), type);
  if (type === "VARCHAR") return lit(text);
  if (type === "BLOB") {
    if (!text.startsWith("\\x")) throw new Error(`a bytea arrived as ${JSON.stringify(text.slice(0, 20))}, not in hex (bytea_output must be hex)`);
    return `unhex(${lit(text.slice(2))})`;
  }
  if (type === "INTERVAL" && text.startsWith("P")) return `CAST(${lit(intervalWords(text))} AS INTERVAL)`;
  return `CAST(${lit(text)} AS ${type})`;
}

const ISO_INTERVAL = /^P(?:(-?[\d.]+)Y)?(?:(-?[\d.]+)M)?(?:(-?[\d.]+)W)?(?:(-?[\d.]+)D)?(?:T(?:(-?[\d.]+)H)?(?:(-?[\d.]+)M)?(?:(-?[\d.]+)S)?)?$/;

/**
 * An interval as Mason's connections spell it (IntervalStyle iso_8601, src/cdc/pg-wire.ts: `P-10M-3DT-4H-5M-6.789S`) in
 * the words DuckDB's INTERVAL reads (`-10 months -3 days -4 hours -5 minutes -6.789 seconds`), each part with its sign
 */
export function intervalWords(text: string): string {
  const m = ISO_INTERVAL.exec(text);
  if (m === null || text === "P" || text.endsWith("T")) throw new Error(`an interval arrived as ${JSON.stringify(text)}, which is not ISO 8601`);
  const [, y, mo, w, d, h, mi, sec] = m;
  const days = w === undefined ? d : String(Number(w) * 7 + Number(d ?? 0));
  const parts = ([[y, "years"], [mo, "months"], [days, "days"], [h, "hours"], [mi, "minutes"], [sec, "seconds"]] as const)
    .filter(([v]) => v !== undefined).map(([v, unit]) => `${v} ${unit}`);
  return parts.length ? parts.join(" ") : "0 seconds";
}

function duckList(tree: PgArray, type: string): string {
  const element = type.slice(0, -2);
  const items = tree.map((x) => Array.isArray(x) ? duckList(x, element) : duckValue(x, element));
  return `CAST([${items.join(", ")}] AS ${type})`;
}

/** One key's net change in a batch: its whole row, a row whose `undefined` columns kept their value, or gone. A row
 *  marked `refetch` is read from the source by its key: a column the stream does not carry (a generated one) changed
 *  with it. */
export type KeyChange = { kind: "row"; values: Array<string | null | undefined>; refetch?: true } | { kind: "delete" };

/** The changes the stream brought of a table, as the database made them (before they are folded per key): what
 *  `mason status` counts as applied, and the stream's periodic line */
export interface ChangeCounts { inserts: number; updates: number; deletes: number; truncates: number }
export const noCounts = (): ChangeCounts => ({ inserts: 0, updates: 0, deletes: 0, truncates: 0 });
export function addCounts(to: ChangeCounts, from: ChangeCounts): void {
  to.inserts += from.inserts; to.updates += from.updates; to.deletes += from.deletes; to.truncates += from.truncates;
}
/** `1,204 changes (1,000 inserts, 200 updates, 4 deletes)`: what the log and `mason status` say of a table's counts */
export function countsText(c: ChangeCounts): string {
  const n = (x: number): string => x.toLocaleString("en-US");
  const total = c.inserts + c.updates + c.deletes + c.truncates;
  const parts = ([[c.inserts, "insert"], [c.updates, "update"], [c.deletes, "delete"], [c.truncates, "truncate"]] as const)
    .filter(([k]) => k > 0).map(([k, w]) => `${n(k)} ${w}${k === 1 ? "" : "s"}`);
  return `${n(total)} change${total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

/** A table's changes in a batch, folded to one per key, in what they mean once applied in commit order. */
export interface TableChanges {
  /** the columns its rows' values are in: the copy's, as `StreamTarget.tables` gave them when they were decoded (null:
   *  none decoded yet). Changes decoded in another shape — before the table was copied again — are never applied to the
   *  new copy (src/duck/sync.ts `applyStreamed`) */
  columns: readonly string[] | null;
  /** a TRUNCATE in the batch: every row stored before it goes first */
  truncated: boolean;
  /** by the key's JSON, the key's values and its net change */
  keys: Map<string, { key: Array<string | null>; change: KeyChange }>;
  /** the changes folded into it, each as the database made it (a key changed twice is two) */
  counts: ChangeCounts;
}
/** a table's changes, none yet */
export const noChanges = (columns: readonly string[] | null = null): TableChanges => ({ columns, truncated: false, keys: new Map(), counts: noCounts() });

/** The change folded into what the batch holds for its key: a later whole row or delete replaces it, a later partial
 *  row keeps the earlier row's values where it carries none. */
export function fold(t: TableChanges, key: Array<string | null>, change: KeyChange): void {
  const k = JSON.stringify(key);
  const was = t.keys.get(k)?.change;
  if (change.kind === "row" && !change.refetch && change.values.includes(undefined) && was?.kind === "row" && !was.refetch) {
    change = { kind: "row", values: change.values.map((v, i) => v === undefined ? was.values[i] : v) };
  }
  t.keys.set(k, { key, change });
}

/**
 * THE MOST CHANGES ONE DUCKDB TRANSACTION OF THE STREAM APPLIES: a batch is applied once it holds this many, and a
 * transaction of more is applied in pieces of this many (the module's header). In Node's heap, 607,000 changes of one
 * transaction folded whole ran a sync out of 96 MB; in pieces of this many it ran in 48 MB
 * (tests/integration/duck-stream.itest.ts).
 *
 * WHAT A PIECE COSTS DUCKDB (measured on DuckDB 2.0.0, a laptop's NVMe, warm). No copy has an index
 * (src/duck/sync.ts `copy`), so a piece is written by key: its keys deleted by ONE join against the table's
 * key column, then its rows inserted, and its unchanged-TOAST rows set by ONE `UPDATE … FROM` (src/duck/sync.ts
 * `writeByKey`, `updateCarried`) — each a scan of the key column, the price of no index. 10,000 changes into 1 M uuid
 * rows at 64 MB: 4 ms; into 10 M at 2 GB: 20 ms; into 195 M at 2.7 GiB (the test server's table and limit): 0.35–0.86 s to
 * delete, 1.5–1.8 s to update — and on the test server, whose 3 GB key column does not fit DuckDB's 2.7 GiB and whose EBS
 * volume reads 125 MB/s, a scan can be tens of seconds. So a table over the poll's row limit is applied by TIME as well
 * (`applySize`). When the copy had a primary key, the key set this number: a deleted key pinned its part of the index
 * until the commit (at 64 MB on 1 M uuid keys, 50,000 deletes in one transaction ran out after 15,500), and a write of
 * random keys needed the whole index resident.
 */
export const PIECE_CHANGES = 10_000;

/**
 * A BATCH THAT CHANGES A BIG TABLE (one over src/lib/table-sync.ts BIG_TABLE_ROWS, `big` in `StreamTarget.tables`) is
 * applied at most every `BIG_APPLY_MS`, and a transaction's piece holds up to `BIG_PIECE_CHANGES`: each application
 * scans that table's key column (`PIECE_CHANGES` says what that costs), so fewer, larger ones — a 12 M-row migration is
 * 240 scans where it would be 1,200. The other tables in such a batch wait with it (seconds of staleness, said in
 * docs/DESIGN.md); the piece's rows in Node's heap are five times a small table's, which the 48 MB a piece of
 * 10,000 ran in leaves room for.
 */
export const BIG_APPLY_MS = 5_000;
export const BIG_PIECE_CHANGES = 50_000;

/** how long a batch may wait and how many changes it may hold before it is applied (`flushMs` / `flushRows` for one
 *  of small tables; at least `BIG_APPLY_MS` / `BIG_PIECE_CHANGES` once it holds a big table's change) */
export function applySize(big: boolean, flushMs: number, flushRows: number): { ms: number; rows: number } {
  return big ? { ms: Math.max(flushMs, BIG_APPLY_MS), rows: Math.max(flushRows, BIG_PIECE_CHANGES) } : { ms: flushMs, rows: flushRows };
}

/** A later batch's changes of a table folded into what is held of it (Sync `catchUp`): what they mean once applied in
 *  commit order after it, as `fold` does within a batch */
export function foldInto(held: TableChanges, later: TableChanges): void {
  held.columns ??= later.columns;
  if (later.truncated) { held.truncated = true; held.keys.clear(); }
  for (const { key, change } of later.keys.values()) fold(held, key, change);
  addCounts(held.counts, later.counts);
}

/** What a stream's relation (a published table) is to the copy: its source name and columns as they arrive. */
interface Relation { source: string; columns: RelationColumn[] }

/** A streamed table as the stream decodes it: the COPY's columns (never the sources file's of the moment, never the publication's), its key,
 *  and the columns the stream may lack because Postgres publishes none (a generated column before 18: read from the
 *  source by key, `refetch`) */
export interface StreamedTable { columns: readonly string[]; key: readonly string[]; generated?: readonly string[]; big?: boolean }

export interface StreamTarget {
  /** the streamed tables, by source (`schema.table`), each in the copy's own columns. Read at EVERY change: a table joins
   *  (caught up) or leaves (copied again) while the stream runs */
  tables(): ReadonlyMap<string, StreamedTable>;
  /** a streamed table whose relation (pgoutput's, after a DDL on the database or a narrower publication) no longer
   *  carries `missing`, columns its copy holds: its changes are not applied from here on, and the target takes it out of
   *  the stream, saying why and the way out — recorded before the stream goes on, so nothing past the change is
   *  acknowledged without it. Called once per `tables()` entry */
  refuse(source: string, missing: readonly string[]): Promise<void>;
  /** apply the batch in one DuckDB transaction recording `lsn`; the commits at or below `applied()` are not sent. A null
   *  `lsn` is a piece of a transaction still arriving: committed, its position not recorded. `committedAt` is when its
   *  newest transaction committed on the database (pgoutput's commit time, the begin's for a piece) */
  apply(batch: ReadonlyMap<string, TableChanges>, lsn: bigint | null, committedAt: Date): Promise<void>;
  /** the position of the last commit applied (0 when none) */
  applied(): bigint;
  /** told whenever the stream has everything the database wrote up to its position: a keepalive with nothing pending,
   *  or a batch applied and acknowledged — the moment a streamed table's copy is current as of (`kept`'s syncedAt) */
  current?(): void;
}

/**
 * The stream: START_REPLICATION from the slot's confirmed position, each transaction's changes folded per table and
 * key, a batch applied once it has waited `flushMs` (or holds `flushRows` changes) and ends at a commit, its position
 * then acknowledged; a transaction of more than `flushRows` changes is applied in pieces of that many (the module's
 * header). A batch holding a big table's change waits and holds more (`applySize`). The source going away is waited out (a reconnect resumes from the slot); anything else ends the
 * stream with its error (`done`), for the sync to say and act on.
 */
export class ReplicationStream {
  private repl: PgConnection | null = null;
  private stopping = false;
  private acked = 0n;
  /** the furthest the server has said its WAL is, with nothing of ours pending: what `caughtUp` compares with */
  private seen = 0n;
  readonly done: Promise<Error | null>;
  private readonly connect: () => Promise<PgConnection>;
  private readonly slot: string;
  private readonly publication: string;
  private readonly target: StreamTarget;
  private readonly log: (line: string) => void;
  private readonly flushMs: number;
  private readonly flushRows: number;

  constructor(o: { connect: () => Promise<PgConnection>; slot: string; publication: string; target: StreamTarget; log: (line: string) => void; flushMs?: number; flushRows?: number }) {
    this.connect = o.connect; this.slot = o.slot; this.publication = o.publication; this.target = o.target; this.log = o.log;
    this.flushMs = o.flushMs ?? 500; this.flushRows = o.flushRows ?? PIECE_CHANGES;
    this.acked = this.target.applied();
    this.done = this.run();
  }

  /** the stream ended, its changes not yet applied dropped (the slot sends them again at the next start) */
  async stop(): Promise<void> {
    this.stopping = true;
    this.repl?.close();
    await this.done;
  }

  /** the position applied or passed over: everything the source had written at `lsn` is in DuckDB once it is past it */
  position(): bigint { return this.seen > this.acked ? this.seen : this.acked; }

  /** ask the server where it is now: it answers with a keepalive at once (`caughtUp` waits on it) */
  poke(): void {
    try { this.repl?.sendStatus(this.acked, true); }
    catch (e) { this.log(`replication: could not ask the source for its position (${(e as Error).message})`); }
  }

  private async run(): Promise<Error | null> {
    let attempts = 0;
    while (!this.stopping) {
      try { this.repl = await this.connect(); }
      catch (e) {
        if (this.stopping) break;
        const wait = Math.min(30_000, 1_000 * 2 ** Math.min(attempts++, 5));
        this.log(`replication: the source is away (${(e as Error).message}); trying again in ${wait / 1000} s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // a stop that came while connecting closed nothing (there was no connection yet): this one is closed instead
      if (this.stopping) { this.repl.close(); this.repl = null; break; }
      if (attempts) this.log(`replication: the source is back; resuming from ${formatLsn(this.acked)}`);
      attempts = 0;
      try {
        await this.streamOnce(this.repl);
        if (this.stopping) break;
        this.log("replication: the source ended the stream (a shutdown); reconnecting");
      } catch (e) {
        if (this.stopping) break;
        if (!away(e)) { this.repl.close(); this.repl = null; return e as Error; }
        this.log(`replication: the source went away (${(e as Error).message}); reconnecting`);
      } finally { this.repl?.close(); this.repl = null; }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return null;
  }

  private async streamOnce(repl: PgConnection): Promise<void> {
    const relations = new Map<number, Relation>();
    // the streamed tables refused by a relation lacking a copied column, by their `tables()` entry: once each
    const refused = new WeakSet<StreamedTable>();
    let batch = new Map<string, TableChanges>();
    let rows = 0, firstAt = 0;
    // the batch holds a change of a big table: applied by `applySize`'s larger bounds
    let big = false;
    const size = (): { ms: number; rows: number } => applySize(big, this.flushMs, this.flushRows);
    let inTxn = false, skipping = false;
    let lastEnd = this.acked;
    // when the open transaction committed (its begin carries it), and the newest commit folded into the batch
    let txnCommit = new Date(0), lastCommit = new Date(0);
    // the open transaction's pieces applied so far, and its changes by table (for the log line once it commits)
    let pieces = 0;
    const txnChanges = new Map<string, number>();
    const flush = async (): Promise<void> => {
      if (lastEnd <= this.acked) return;
      if (batch.size || pieces) await this.target.apply(batch, lastEnd, lastCommit);
      this.acked = lastEnd;
      repl.sendStatus(this.acked);
      batch = new Map(); rows = 0; firstAt = 0; pieces = 0; big = false;
      this.target.current?.();
    };
    // a piece of the open transaction: applied and committed, the position left where it is
    const piece = async (): Promise<void> => {
      await this.target.apply(batch, null, txnCommit);
      pieces++;
      batch = new Map(); rows = 0; firstAt = 0; big = false;
    };
    // feedback while idle: Postgres drops a walsender it has not heard from in wal_sender_timeout (60 s). A send on a
    // socket that has closed is said here; the stream's own read meets the close and reconnects. It asks for a reply: a
    // walsender that hears from us sends no keepalive of its own, so an idle stream's position would never pass the WAL
    // the database writes for other tables (and the slot would hold it), and `mason status` would read it as behind
    const status = setInterval(() => {
      try { repl.sendStatus(this.acked, true); }
      catch (e) { this.log(`replication: the status update could not be sent (${(e as Error).message})`); }
    }, 10_000);
    const command = `START_REPLICATION SLOT ${pgIdent(this.slot)} LOGICAL 0/0 (proto_version '1', publication_names ${pgLiteral(`"${this.publication.replace(/"/g, '""')}"`)})`;
    try {
      for await (const m of repl.replicate(command)) {
        if (m.kind === "keepalive") {
          // nothing of ours pending: the WAL up to the server's position holds no change we lack, and an idle slot
          // must not hold the database's WAL for tables nobody reads
          if (!inTxn && rows === 0 && lastEnd <= this.acked) {
            if (m.walEnd > this.seen) this.seen = m.walEnd;
            if (m.walEnd > this.acked) { this.acked = m.walEnd; repl.sendStatus(this.acked); }
            this.target.current?.();
          } else if (m.replyRequested) repl.sendStatus(this.acked);
          if (!inTxn && rows > 0 && Date.now() - firstAt >= size().ms) await flush();
          continue;
        }
        const msg = decode(m.data);
        switch (msg.type) {
          case "begin":
            inTxn = true;
            pieces = 0; txnChanges.clear();
            txnCommit = pgTime(msg.commitTime);
            // a commit the copy's own record says it applied (a run that died before its acknowledgement)
            skipping = msg.finalLsn < this.target.applied();
            break;
          case "commit":
            inTxn = false;
            lastEnd = msg.endLsn;
            lastCommit = pgTime(msg.commitTime);
            if (pieces > 0) {
              const n = [...txnChanges.values()].reduce((a, b) => a + b, 0);
              this.log(`replication: ${[...txnChanges.keys()].join(", ")}: ${n.toLocaleString("en-US")} change(s) in one transaction, applied in ${pieces + (rows > 0 ? 1 : 0)} pieces`);
              // its last piece, with its position: at once (the earlier pieces are in, unacknowledged)
              await flush();
            } else if (rows > 0 && (Date.now() - firstAt >= size().ms || rows >= size().rows)) await flush();
            else if (rows === 0) { this.acked = lastEnd > this.acked ? lastEnd : this.acked; this.seen = this.acked; }
            break;
          case "relation":
            relations.set(msg.relid, { source: `${msg.namespace}.${msg.name}`, columns: msg.columns });
            break;
          case "insert": case "update": case "delete": case "truncate": {
            if (skipping) break;
            const changed = msg.type === "truncate" ? msg.relids : [msg.relid];
            for (const relid of changed) {
              const rel = relations.get(relid);
              // looked up at each change: a table caught up since the stream started is streamed from here on
              const table = rel === undefined ? undefined : this.target.tables().get(rel.source);
              if (rel === undefined || table === undefined) continue;   // a table the copy does not hold, or not yet caught up
              // a column the copy holds that the relation does not carry (a DDL on the database, a narrower publication):
              // its changes cannot be written, so the table is refused and leaves the stream; the others go on
              const missing = missingFrom(rel.columns, table);
              if (missing.length) {
                if (!refused.has(table)) { refused.add(table); await this.target.refuse(rel.source, missing); }
                continue;
              }
              if (table.big === true) big = true;
              const t = batch.get(rel.source) ?? noChanges(table.columns);
              batch.set(rel.source, t);
              txnChanges.set(rel.source, (txnChanges.get(rel.source) ?? 0) + 1);
              t.counts[msg.type === "insert" ? "inserts" : msg.type === "update" ? "updates" : msg.type === "delete" ? "deletes" : "truncates"]++;
              if (msg.type === "truncate") { t.truncated = true; t.keys.clear(); continue; }
              // a generated column (Postgres publishes none before 18) is read from the source
              const absent = table.columns.some((name) => !rel.columns.some((c) => c.name === name));
              const values = (tuple: TupleValue[]): Array<string | null | undefined> => projectTuple(rel.columns, tuple, table.columns);
              const keyOf = (vals: Array<string | null | undefined>): Array<string | null> => table.key.map((k) => {
                const v = vals[table.columns.indexOf(k)];
                if (v === undefined) throw new Error(`${rel.source}.${k}: a key value arrived unchanged-TOAST, which the stream cannot place`);
                return v;
              });
              if (msg.type === "delete") fold(t, keyOf(values(msg.key)), { kind: "delete" });
              else {
                const vals = values(msg.tuple);
                if (msg.type === "update" && msg.oldKey) fold(t, keyOf(values(msg.oldKey)), { kind: "delete" });
                fold(t, keyOf(vals), { kind: "row", values: vals, ...(absent ? { refetch: true as const } : {}) });
              }
            }
            if (rows === 0) firstAt = Date.now();
            rows++;
            if (inTxn && rows >= size().rows) await piece();
            break;
          }
          default: break;
        }
      }
    } finally { clearInterval(status); }
  }
}

/** pgoutput's commit time (microseconds since 2000-01-01 UTC) as a date */
export function pgTime(us: bigint): Date {
  return new Date(946_684_800_000 + Number(us / 1000n));
}

/** the source being away — closed, refused, reset, a shutdown — which a reconnect outlasts; anything else is the stream's */
function away(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /connection closed|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|timed out|terminating connection|the database system is (shutting down|starting up)|server closed|is active for PID/i.test(m);
}
