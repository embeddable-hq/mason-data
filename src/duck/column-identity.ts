/**
 * WHICH COLUMN IS WHICH, BY ITS IDENTITY ON THE DATABASE (issue 1073): the sources file decides what is synced by a
 * column's NAME (`exclude:`, `columns:`, and the secret-looking columns `mason add` leaves out), so a column it leaves
 * out could be served under another name — two names swapped in one transaction, a rename followed by a restart, or a
 * column renamed to a name `columns:` lists. A column's identity is its table's oid and its `attnum`, which a rename
 * keeps and a drop never gives to another column.
 *
 * What the run took of each table's columns is recorded by identity (`ColumnRecord`, `_mason.column_identity`), so a
 * restart knows it. Each time the run takes the sources file against the catalog (`identityVerdict`):
 * - a column new to the record (an add) is decided by its name, as the file says;
 * - a column the record holds as synced is decided by its name now, as the file says (left out by a rename is no leak);
 * - a column the record holds as LEFT OUT is never synced again on the file's word, under ANY name, the one it was left
 *   out under included. The file is not only the person's: the run writes `exclude:` itself (src/cli/dev.ts, issue 977)
 *   and takes a name out of it when that name is gone, so a column renamed away and back under a name the run took out
 *   was synced by name (the review of PR 1078: `c` renamed `d`, `exclude: [d]` written, a new `c` added, then the new
 *   `c` dropped and `d` renamed `c`). A name proves nothing about which column it is.
 * A column left out that the file would now sync is a CONFLICT. Its table is HELD — not synced, its synced data served
 * as it was — and said with the line that keeps it out, and the command that syncs it. Only a confirmation syncs it
 * again: `mason add` of the table through the running Mason (`confirmed`, which writes its entry against the columns as
 * the database names them now), or its entry removed from the file (the record goes with its synced data).
 *
 * Pure: the sync reads and writes the record (src/duck/sync.ts `setTables`), and says what this decides.
 */
import { shapeTuples } from "../cdc/shape.ts";

/** One column as the run last took it: its number, its name then (for the words only: nothing is decided by it), and
 *  whether it is synced. */
export interface RecordedColumn { attnum: number; name: string; synced: boolean }

/** What the run last took of a table's columns, by identity: the table's oid and every live column of it then. */
export interface ColumnRecord { oid: number; columns: RecordedColumn[] }

/** The entry of the sources file a table is synced by, as the run takes it, for the words of a hold. */
export interface EntryWords {
  /** where the file names it, as a person reads it (`mason/sources/app.yml: tables.orders`) */
  at: string;
  /** the entry's name in the file (`orders`, `billing.invoices`) */
  name: string;
  /** its `columns:`, or null for an entry that syncs every column but its `exclude:` */
  columns: readonly string[] | null;
  exclude: readonly string[];
}

/** What the run decides of a table: nothing to go by (no oid or shape: a test's table), taken with this record, or held. */
export type IdentityVerdict =
  | { kind: "unknown" }
  | { kind: "taken"; record: ColumnRecord }
  | { kind: "held"; why: string; conflicts: Array<{ name: string; was: string }> };

/** What the verdict reads of a table: its oid, its shape now (every live column), the names the file syncs now, and
 *  its entry for the words. */
export interface IdentityInput {
  source: string;
  oid?: number | undefined;
  shape?: string | undefined;
  synced: readonly string[];
  entry?: EntryWords | undefined;
}

const flow = (xs: readonly string[]): string => `[${xs.map((x) => /^[A-Za-z_][A-Za-z0-9_$.]*$/.test(x) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(x) ? x : JSON.stringify(x)).join(", ")}]`;

/**
 * The run's verdict on a table's columns against its record (none: the table is new to this copy, or was synced by a
 * Mason before this record). `confirmed`: the person wrote the entry against the database's columns as they are now.
 */
export function identityVerdict(t: IdentityInput, record: ColumnRecord | undefined, confirmed: boolean): IdentityVerdict {
  const cols = t.shape === undefined ? [] : shapeTuples(t.shape);
  if (t.oid === undefined || !Number.isInteger(t.oid) || cols.length === 0 || cols.some((c) => !Number.isInteger(c.attnum))) return { kind: "unknown" };
  const synced = new Set(t.synced);
  // a table dropped and made again is another table: decided by name, as a new one is
  const was = record !== undefined && record.oid === t.oid && !confirmed ? new Map(record.columns.map((c) => [c.attnum, c])) : new Map<number, RecordedColumn>();
  const conflicts: Array<{ name: string; was: string }> = [];
  // a synced column renamed out of what the entry names (a `columns:` entry): kept in the line a hold says
  const renamedOut: string[] = [];
  const columns: RecordedColumn[] = [];
  for (const c of cols) {
    const r = was.get(c.attnum);
    const syncs = synced.has(c.name);
    if (r === undefined || r.synced) {
      if (r !== undefined && r.name !== c.name && !syncs) renamedOut.push(c.name);
      columns.push({ attnum: c.attnum, name: c.name, synced: syncs });
      continue;
    }
    // LEFT OUT: stays out under any name, its own included; the file syncing it is a conflict, which only a
    // confirmation ends. Recorded under its name now, for the words alone
    if (syncs) conflicts.push({ name: c.name, was: r.name });
    columns.push({ attnum: c.attnum, name: c.name, synced: false });
  }
  if (conflicts.length === 0) return { kind: "taken", record: { oid: t.oid, columns } };
  return { kind: "held", why: heldText(t, cols.map((c) => c.name), conflicts, renamedOut), conflicts };
}

/** What a hold says, in the sources file's words: which column is which, that the synced data serves as it was, the
 *  line that keeps each out (a `columns:` entry's keeps a synced column renamed, `renamedOut`, under its new name), and
 *  the command that syncs each — every column named, since `mason add` writes the entry anew. */
function heldText(t: IdentityInput, names: readonly string[], conflicts: ReadonlyArray<{ name: string; was: string }>, renamedOut: readonly string[]): string {
  const one = conflicts.length === 1;
  const renamed = conflicts.some((c) => c.name !== c.was);
  const which = conflicts.map((c) => c.name === c.was ? `${c.name} is a column the sources file left out` : `${c.name} is the column the sources file left out as ${c.was}`).join("; ");
  const head = `${t.source} is not synced: ${renamed ? "its columns were renamed on the database, and " : ""}${which}. ` +
    `Its entry would sync ${one ? "it" : "them"}. A column the file left out is synced again only once you confirm it, so Mason holds the table and serves its synced data as it was`;
  const e = t.entry;
  if (e === undefined) return `${head}.`;
  const gone = new Set(conflicts.map((c) => c.name));
  const at = e.at;
  const listed = e.columns === null ? [] : renamedOut;
  const line = e.columns === null
    ? `exclude: ${flow([...e.exclude.filter((x) => names.includes(x)), ...conflicts.map((c) => c.name).filter((x) => !e.exclude.includes(x))])}`
    : `columns: ${flow(names.filter((x) => (t.synced.includes(x) && !gone.has(x)) || listed.includes(x)))}`;
  const all = names.filter((x) => t.synced.includes(x) || listed.includes(x));
  return `${head}. To keep ${one ? "it" : "them"} out, write ${line} on ${at}, then run mason stop && mason start. ` +
    `To sync ${one ? "it" : "them"}, run mason add ${e.name} --columns ${all.join(",")} while Mason runs`;
}

/** A record as the ledger holds it (`_mason.column_identity.columns`), or null for one this module did not write. */
export function recordOf(oid: unknown, columns: unknown): ColumnRecord | null {
  const o = Number(oid);
  if (!Number.isInteger(o) || typeof columns !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(columns); }
  catch (e) {
    // written by `setTables` alone, so a text that is not JSON is a bug: read as no record, said by the caller
    if (e instanceof SyntaxError) return null;
    throw e;
  }
  if (!Array.isArray(parsed)) return null;
  const out: RecordedColumn[] = [];
  for (const c of parsed) {
    if (typeof c !== "object" || c === null) return null;
    const { attnum, name, synced } = c as Record<string, unknown>;
    if (!Number.isInteger(attnum) || typeof name !== "string" || typeof synced !== "boolean") return null;
    out.push({ attnum: attnum as number, name, synced });
  }
  return { oid: o, columns: out };
}
