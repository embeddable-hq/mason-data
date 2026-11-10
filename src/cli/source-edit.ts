/**
 * `mason add` AND `mason remove`, CHECKED AND WRITTEN — ONE GRAMMAR AT EVERY ENTRANCE. The run's command server
 * (`POST /api/pick`, `/api/remove`, src/cli/run-server.ts: the commands with Mason up, and the web page) and the commands
 * themselves with Mason down (src/cli/commands.ts: the file is the list, so `mason init && mason add orders && mason
 * start` is a natural order) call these functions, so a refusal is worded ONCE and both entrances say it alike
 * (tests/cli-commands.test.ts holds the two equal). What differs is only what each does after: the run starts or drops the
 * copy and reads the file again; the command says the copy begins at `mason start`.
 *
 * Each takes the sources file as it is on disk now (`sourceToEdit`), the database's catalog as `readSourceFacts` reads it
 * (`EditCatalog`), and the request; it checks the entry and the file's other entries against the catalog (an edit is never
 * written over a file the next read would refuse), splices the one entry in or out (`withTable` / `withoutTable`: every
 * other byte as it was), writes the file, and answers what it did — or throws a `Refusal`, the sentence a command shows.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Failure, FailureCode } from "./command.ts";
import type { SourceTable } from "./preflight.ts";
import { addedTables, catalogTable, chooseColumns, effectiveSync, entryFields, entryName, entryProblems, findEntry, looksSecret, parseSourceText, sourceFailure, sourceFileNames, sourcesDir,
  unaddableReason, usableUniqueKey, withEntrySync, withoutTable, withTable, type CatalogColumn, type CatalogTable, type EntryFields, type ProjectSource, type SourceFile,
  type TableEntry, type WrittenEntry } from "./sources.ts";
import { BIG_TABLE_ROWS, COSTLY_POLL_ROWS, COSTLY_POLL_SECONDS, syncText, type TableSync } from "../lib/table-sync.ts";
import { projectWriteRefusal } from "./project.ts";

/** A refusal the command shows as it is; `failure` is how the web page says it (the CLI's Failure: why, fix, next), by
 *  default the message alone under the status's code. */
export class Refusal extends Error {
  readonly status: number;
  readonly failure: Failure;
  constructor(status: number, message: string, failure?: Failure) { super(message); this.status = status; this.failure = failure ?? { message, code: codeOf(status) }; }
}

/** The FAILURE_CODES code (src/cli/command.ts) of a refusal by its HTTP status. */
const codeOf = (status: number): FailureCode => status === 400 ? "usage" : status === 404 ? "not_found" : status >= 500 ? "failed" : "refused";

/** The sources file to edit: where it is, its text, what it says, and the file read as the run reads it (its URL resolved). */
export interface EditTarget { root: string; file: string; text: string; parsed: SourceFile; read: ProjectSource }

/** The database an edit is checked against: its catalog (preflight.ts readSourceFacts) and its name; `measured`, with
 *  Mason up, what the run measured of a table (a poll's cost is estimated from it: `pollCost`). Whether a table can be
 *  replicated is its entry's sync and the catalog's (src/cli/sources.ts entryProblems), never the run's. */
export interface EditCatalog { tables: readonly SourceTable[]; database: string; measured?: (table: string) => PollMeasure | null }

/** What a run measured of a table, for an estimate of its poll's cost (src/duck/sync.ts `Sync.measured`): its last
 *  poll's time, and one reader's rate at its copy (rows a second, the copy's rows over its time and readers) */
export interface PollMeasure { lastPollMs: number | null; copyRowsPerSecond: number | null }

/**
 * A SCAN'S RATE WHEN NOTHING OF THE TABLE IS MEASURED, rows a second on one backend: the test server's production
 * replica scanned a 22 M-row table in 12 s at every poll (docs/DESIGN.md "The poll") — an assumption, said as one.
 */
const ASSUMED_SCAN_ROWS_PER_SECOND = 1_800_000;

/**
 * WHAT A POLL OF A BIG TABLE WOULD COST THE DATABASE, estimated before it runs (issue 33: "a poll never takes more than
 * a fifth of the source's time" bounds the share, not the backend's seconds — a 200 M-row table set to poll 5m is
 * still a standing load): seconds a poll, from the best basis there is — its last poll, measured; else its copy's read
 * rate, a reader's (an upper bound: a poll sends only the changed rows); else the catalog's row estimate at an assumed
 * scan rate — and the basis said. Null for a table under `COSTLY_POLL_ROWS`, or set to poll every minute or slower.
 */
export function pollCost(t: Pick<SourceTable, "source" | "rows">, sync: TableSync, m: PollMeasure | null): string | null {
  if (sync.mode !== "poll" || sync.seconds >= COSTLY_POLL_SECONDS || t.rows === null || t.rows < COSTLY_POLL_ROWS) return null;
  const rows = t.rows.toLocaleString("en-US");
  const [seconds, basis] = m?.lastPollMs != null ? [m.lastPollMs / 1000, "its last poll, measured"]
    : m?.copyRowsPerSecond ? [t.rows / m.copyRowsPerSecond, `its first sync's read rate, ${Math.round(m.copyRowsPerSecond).toLocaleString("en-US")} rows a second a reader (a poll sends only the rows that changed, so it is at most that)`]
    : [t.rows / ASSUMED_SCAN_ROWS_PER_SECOND, `the catalog's ${rows} rows at an assumed ${ASSUMED_SCAN_ROWS_PER_SECOND.toLocaleString("en-US")} rows a second of scan (nothing of it measured yet)`];
  const every = Math.max(sync.seconds, 4 * seconds);
  const s = (x: number): string => x < 90 ? `${Math.round(x)} s` : x < 5400 ? `${Math.round(x / 60)} min` : `${(x / 3600).toFixed(1)} h`;
  return `${entryName(t.source)} has about ${rows} rows, and each poll scans it whole on your database: about ${s(seconds)} a poll, from ${basis}. ` +
    `sync: ${syncText(sync)} is stretched to a poll every ${s(every)} at most (a poll waits four times its own time), one backend of your database ` +
    `busy ${Math.round((seconds / every) * 100)} % of the time — a longer interval (--sync "poll 1h"), or --sync replication (the change log), costs it less`;
}

/**
 * The project's sources file as it is on disk NOW, its text and what it says — or why it cannot be edited: its files are
 * read-only here (src/cli/project.ts `projectWriteRefusal`, the one authority, asked FIRST: nothing is read or checked
 * against the database for an edit that cannot be written), no folder, not exactly one file, a file with mistakes of its
 * own, a URL that cannot be resolved (`read`, the file read as the run reads it: src/cli/sources.ts readSource). An
 * `EditTarget` is made here alone, so every edit `addEntry` and `removeEntries` write has asked.
 */
export function sourceToEdit(folder: string | null, root: string, read: () => ProjectSource | Failure, env: Readonly<Record<string, string | undefined>> = process.env): EditTarget {
  const readOnly = projectWriteRefusal(root, env);
  if (readOnly !== null) throw new Refusal(409, readOnly.message, readOnly);
  if (!folder) throw new Refusal(409, "choose the project's folder first");
  const names = sourceFileNames(folder);
  if (names.length !== 1) throw new Refusal(409, `${path.relative(root, sourcesDir(folder)) || sourcesDir(folder)}/ has ${names.length ? `${names.length} source files` : "no source file"}: one source per project for now`);
  const file = path.join(sourcesDir(folder), names[0]!);
  const text = fs.readFileSync(file, "utf8");
  const parsed = parseSourceText(text, names[0]!.replace(/\.ya?ml$/, ""), file);
  if ("problems" in parsed) {
    const f = sourceFailure(file, root, parsed.problems);
    throw new Refusal(409, `${f.message}${f.why ? `\n${f.why}` : ""} — fix it first`);
  }
  const r = read();
  if ("message" in r) throw new Refusal(409, `${r.message}${r.why ? `\n${r.why}` : ""} — fix it first`);
  return { root, file, text, parsed, read: r };
}

/** The file's other entries against the database: an edit is never written over a file the run would not take. */
function othersHold(at: EditTarget, db: EditCatalog, without: readonly string[], then: string): void {
  const others = { ...at.parsed, tables: at.parsed.tables.filter((e) => !without.includes(e.table)) };
  const held = addedTables(others, db.tables, db.database, at.root);
  if (!Array.isArray(held)) throw new Refusal(409, `${held.message}${held.why ? `\n${held.why}` : ""} — fix it first, then ${then}`);
}

/** What `mason add` did to one table: its entry in the sources file, and what the columns asked for left out. */
export interface PickResult {
  table: string;
  /** the sources file, absolute */
  file: string;
  /** the entry's key (`orders`, `billing.invoices`), and what it copies */
  entry: string; columns: string[] | null; exclude: string[]; key: string[] | null;
  /** the key's columns added to a --columns list (a synced table always has its key) */
  addedKey: string[];
  /** secret-looking columns every-column left out (sources.ts looksSecret) */
  skippedSecrets: string[];
  /** the file named it so already: nothing was written */
  already: boolean;
  /** how it is kept current after its first sync (src/lib/table-sync.ts syncText), and where that is said: its entry's
   *  own `sync:` (written by --sync, or `off` for a big table), the file's top `sync:`, or the default (`off`) */
  sync: { value: string; from: "entry" | "file" | "default" };
  /** the table is over BIG_TABLE_ROWS and the file's default polls: its entry was written `sync: off`, said */
  bigOff: boolean;
  /** the file's default is `replication` and the table cannot be replicated: its entry was written `sync: poll 5m`, and
   *  this is why (no primary key: a `--key` table; REPLICA IDENTITY NOTHING); null otherwise */
  notReplicated: string | null;
  /** a poll every so often of a table this big would cost the database this, estimated (`pollCost`); null otherwise */
  pollCost: string | null;
}

/**
 * ADD A TABLE (`table`: schema.table): its entry in the sources file, written — after the last one, or in place of the
 * table's own (`withTable`): every other byte of the file as it was. `columns` are the ones asked (`["*"]`: every one);
 * `key` the columns a table with no primary key is copied by. The entry and the file's other entries must hold against
 * the database first: an edit is never written over a file the next read would refuse.
 *
 * ITS SYNC (`o.sync`, --sync): written on the entry as its own `sync:`; else an entry's own is kept; else a NEW entry
 * follows the file's default — unless the table is over `BIG_TABLE_ROWS` and that default polls, when the entry is
 * written `sync: off` and said (`bigOff`): a poll scans its table whole — or the default is `replication` and the table
 * cannot be (a `--key` table, REPLICA IDENTITY NOTHING), when it is written `sync: poll 5m` and said why (`notReplicated`;
 * an explicit `--sync replication` of such a table is refused, at its entry). `o.keep`: only the sync is asked of a table
 * already added (`mason add orders --sync "poll 30s"`), so its columns and key stay as they are, and only its `sync:`
 * line is written (`withEntrySync`: its comments too).
 */
export function addEntry(at: EditTarget, db: EditCatalog, table: string, columns: readonly string[] = ["*"], key: readonly string[] | null = null,
  o: { sync?: TableSync; keep?: boolean } = {}): PickResult {
  const t = db.tables.find((x) => x.source === table);
  if (!t) throw new Refusal(404, `${table} is not a table of ${db.database} that this user can read`);
  const p = plannedEntry(at.parsed, db, t, columns, key, o, () => othersHold(at, db, [table], `add ${entryName(table)}`));
  const { entry, was, keep } = p;
  const same = was !== undefined && JSON.stringify([was.columns, was.exclude, was.key, was.sync]) === JSON.stringify([entry.columns, entry.exclude, entry.key, entry.sync]);
  if (!same) {
    const r = keep ? withEntrySync(at.text, was!, entry.sync) : withTable(at.text, entry);
    if ("problem" in r) throw new Refusal(409, `${path.relative(at.root, at.file)} cannot be edited: ${r.problem}`);
    fs.writeFileSync(at.file, r.text);
  }
  const eff = effectiveSync(at.parsed, entry);
  return { table, file: at.file, entry: entry.name, columns: entry.columns, exclude: entry.exclude, key: entry.key, addedKey: p.addedKey, skippedSecrets: p.skipped, already: same,
    sync: { value: syncText(eff.sync), from: eff.from }, bigOff: p.bigOff, notReplicated: p.notReplicated, pollCost: pollCost(t, eff.sync, db.measured?.(table) ?? null) };
}

/** The entry `mason add` decides for a table, before anything is written (`plannedEntry`). */
export interface PlannedEntry {
  entry: WrittenEntry & { sync: TableSync | null };
  /** the file's entry for the table before, and whether only its sync is asked (`o.keep`) */
  was: TableEntry | undefined; keep: boolean;
  /** the key's columns added to a --columns list; the secret-looking columns every-column left out (sources.ts chooseColumns) */
  addedKey: string[]; skipped: string[];
  bigOff: boolean; notReplicated: string | null;
}

/**
 * WHAT `mason add` WRITES FOR A TABLE, DECIDED IN ONE PLACE (issue 794: `mason tables --json` gives the same entry, so a
 * tool that writes the sources file itself writes what `mason add` would): the columns (`chooseColumns`), the key, its
 * sync, and every check of the entry against the database — or the `Refusal` `mason add` says. Nothing is written.
 * `others` checks the file's other entries (`othersHold`), at the point `mason add` always has: after the columns, before
 * the sync is checked.
 */
export function plannedEntry(file: SourceFile, db: EditCatalog, t: SourceTable, columns: readonly string[] = ["*"], key: readonly string[] | null = null,
  o: { sync?: TableSync; keep?: boolean } = {}, others: () => void = () => {}): PlannedEntry {
  const table = t.source;
  if (key !== null && t.key.length) throw new Refusal(400, `${table} has a primary key (${t.key.join(", ")}), which Mason keys it by: leave --key out`);
  if (key === null && !t.key.length) throw new Refusal(409, `${table} cannot be added: ${unaddableReason(t)}`);
  const was = file.tables.find((e) => e.table === table);
  const keep = o.keep === true && was !== undefined;
  const chosen = keep ? { columns: was.columns, exclude: was.exclude, addedKey: [], skipped: [] } : chooseColumns(t, columns, key);
  if ("problem" in chosen) throw new Refusal(400, chosen.problem);
  others();
  // its own sync: asked, else the one its entry has, else none (the file's) — but a new big table under a polling default
  const fileSync = effectiveSync(file, undefined).sync;
  const bigOff = o.sync === undefined && was === undefined && fileSync.mode === "poll" && t.rows !== null && t.rows > BIG_TABLE_ROWS;
  // a table logical replication cannot keep, under a file whose default is replication: polled, said (never refused for
  // the default it did not choose; its own --sync replication is refused at its entry, below)
  const keyed = keep ? was.key !== null : key !== null;
  const unreplicable = keyed ? "it has no primary key, so logical replication cannot apply its changes by its key:"
    : t.replicaIdentity === "n" ? "it has REPLICA IDENTITY NOTHING, and a publication carrying it would make your app's own UPDATEs and DELETEs on it fail" : null;
  const notReplicated = o.sync === undefined && (was?.sync ?? null) === null && fileSync.mode === "replication" ? unreplicable : null;
  // --sync replication asked of one: refused with the COMMAND to run (the person is at it), its own flags kept — the
  // file's words are for an entry written by hand (src/cli/sources.ts entryProblems)
  if (o.sync?.mode === "replication" && unreplicable !== null) {
    const rest = columns.filter((c) => c !== "*");
    const flags = keep ? "" : `${columns.includes("*") ? (rest.length ? ` --include ${rest.join(",")}` : "") : ` --columns ${rest.join(",")}`}${key !== null ? ` --key ${key.join(",")}` : ""}`;
    throw new Refusal(400, `${table} cannot be kept current by logical replication: ${unreplicable} — mason add ${entryName(table)}${flags} --sync "poll 5m" polls it instead`);
  }
  const sync: TableSync | null = o.sync ?? was?.sync ?? (bigOff ? { mode: "off" } : notReplicated !== null ? { mode: "poll", every: "5m", seconds: 300 } : null);
  const entry = { name: was?.name ?? entryName(table), table, columns: chosen.columns, exclude: chosen.exclude, key: keep ? was.key : key === null ? null : [...key], sync };
  // the entry itself, as the run will read it: a --key that does not tell the rows apart is refused here, not at the copy
  const own = entryProblems(t, entry, db.tables, db.database, effectiveSync(file, entry).sync);
  if (own.length) throw new Refusal(400, own.join("; "));
  return { entry, was, keep, addedKey: chosen.addedKey, skipped: chosen.skipped, bigOff, notReplicated };
}

/** A table as `mason tables` lists it: the catalog's and the sources file's facts (sources.ts `catalogTable`), each
 *  column's `secret`, and its `entry` in the sources file's keys. */
export interface ListedTable extends Omit<CatalogTable, "columns"> {
  columns: Array<CatalogColumn & {
    /** it looks like a secret (sources.ts looksSecret) and `mason add` leaves it out of the entry (`exclude:`) unless
     *  named (`--include`); false for a key column, which is always synced */
    secret: boolean }>;
  /** its entry as the sources file's `tables:` map holds it, `{ <name>: {} | { columns | exclude, key, sync } }` (sources.ts
   *  `entryFields`): an added table's as the file says it; else what `mason add <table>` writes — with the `--key` its
   *  `reason` names when it has no primary key —; null when `mason add` would refuse it (`reason` says why) */
  entry: Record<string, EntryFields> | null;
}

/**
 * THE DATABASE'S TABLES AS `mason tables` LISTS THEM, from a catalog already read (`readSourceFacts`) and the sources
 * file — no read of its own, so `mason doctor` can list what it read too. A table not added gets the entry `mason add
 * <table>` writes, decided by `plannedEntry` (never a second copy of its rule), and its refusal as its `reason`: no
 * primary key keeps `unaddableReason`'s words (the entry then carries the `--key` they name, a unique index over NOT NULL
 * columns, when it has one). The file's other entries are not checked here (`mason add` refuses while one fails).
 */
export function listTables(file: SourceFile, db: EditCatalog): ListedTable[] {
  return db.tables.map((t) => {
    const was = file.tables.find((e) => e.table === t.source);
    const catalog = catalogTable(t, was);
    let entry: WrittenEntry | null = was ?? null, reason = catalog.reason;
    if (was === undefined) {
      const key = t.key.length ? null : usableUniqueKey(t)?.columns ?? null;
      try { entry = plannedEntry(file, db, t, ["*"], key).entry; }
      catch (e) {
        // a refusal is the table's answer, said as mason add says it; anything else is a bug, and goes on up
        if (!(e instanceof Refusal)) throw e;
        entry = null;
        // refused with the --key its reason names (row-level security, say): both said, the --key alone would not do
        reason = reason === null ? e.message : key !== null ? `${reason}; with it, ${e.message}` : reason;
      }
    }
    // the columns every-column leaves out, by the same rule against the key it is synced by: its primary key, else the
    // entry's key: — FAIL CLOSED, a key: the file gets wrong (a column the table lacks, a key: beside a primary key)
    // never un-flags a column: the rule is then asked against the table's own key alone, which every column passes
    const asked = chooseColumns(t, ["*"], t.key.length ? null : entry?.key ?? null);
    const chosen = "problem" in asked ? chooseColumns(t, ["*"], null) : asked;
    const skipped = "problem" in chosen ? t.columns.map((c) => c.name).filter(looksSecret) : chosen.skipped;
    return { ...catalog, reason, columns: catalog.columns.map((c) => ({ ...c, secret: skipped.includes(c.name) })),
      entry: entry === null ? null : { [entry.name]: entryFields(entry) } };
  });
}

/** What `mason remove` did: the tables (schema.table) whose entries it cut, and the sources file, absolute. */
export interface RemoveResult { removed: string[]; file: string }

/**
 * REMOVE TABLES from the sources file: each one's entry cut (`withoutTable`), every other byte of the file as it was. A
 * name the file does not have is refused with the closest one it has; the entries that stay must hold against the
 * database — else the run's re-read refuses the file, keeps the removed table and goes on copying it while the command
 * said "Removed".
 */
export function removeEntries(at: EditTarget, db: EditCatalog, names: readonly string[]): RemoveResult {
  const entries = names.map((n) => {
    const e = findEntry(at.parsed, n);
    if ("problem" in e) throw new Refusal(e.usage ? 400 : 404, e.problem);
    return e;
  });
  othersHold(at, db, entries.map((e) => e.table), `remove ${names.join(" ")}`);
  let out = at.text;
  for (const e of entries) {
    const r = withoutTable(out, e.table);
    if (r === null) continue;
    if ("problem" in r) throw new Refusal(409, `${path.relative(at.root, at.file)} cannot be edited: ${r.problem}`);
    out = r.text;
  }
  fs.writeFileSync(at.file, out);
  return { removed: [...new Set(entries.map((e) => e.table))], file: at.file };
}
