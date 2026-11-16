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
 * A column left out is its RELATION's, whichever entry names it (issue 1080: two tables, or two schemas, swapped names
 * and the entry that syncs every column served the other entry's left-out column): a table is placed against every
 * record of its oid (`carried`), and a column any of them left out stays out.
 *
 * Pure: the sync reads and writes the record (src/duck/sync.ts `setTables`), and says what this decides.
 */
import { shapeTuples } from "../cdc/shape.ts";

/** One column as the run last took it: its number, its name then (for the words only: nothing is decided by it), and
 *  whether it is synced. */
export interface RecordedColumn { attnum: number; name: string; synced: boolean }

/** What the run last took of a table's columns, by identity: the table's oid and every live column of it then. */
export interface ColumnRecord { oid: number; columns: RecordedColumn[] }

/** A record another entry holds of a relation (issue 1080), with the entry it is that of (`from`: `schema.table`), for
 *  the words of a hold. */
export interface CarriedRecord extends ColumnRecord { from: string }

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

/** What the run decides of a table: nothing to go by (no oid or shape: a test's table), taken with this record, or held
 *  — with the record a hold keeps of it (its columns by number, each one left out kept so), which the sync keeps when
 *  the identity came from another entry's record (src/duck/sync.ts `placeColumns`). */
export type IdentityVerdict =
  | { kind: "unknown" }
  | { kind: "taken"; record: ColumnRecord; replaced?: true }
  | { kind: "held"; why: string; conflicts: Conflict[]; record: ColumnRecord };

/** A column left out that the entry would sync: its name now, the name it was left out under, and the other entry that
 *  left it out when that was not this one (`from`, issue 1080). */
export interface Conflict { name: string; was: string; from?: string }

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
 * The run's verdict on a table's columns against its record (`own`: none when the table is new to this copy, or was
 * synced by a Mason before this record) and the records OTHER entries hold of the same relation (`carried`, issue 1080):
 * two tables, or two schemas, that swap names on the database bring each its relation to the other's entry, and a column
 * one entry left out is that relation's whichever entry names it now. So every record of the table's oid is read, its
 * own and the carried ones, and a column ANY of them left out is left out here (fail closed).
 * `confirmed`: the person wrote the entry against the database's columns as they are now, the very shape this reads
 * (src/duck/sync.ts holds the confirmation to the shape the add saw). `readOnly`: the project's files are deployed
 * read-only (src/cli/project.ts `projectWriteRefusal`), so the sources file is the owner's committed word alone — the
 * run never writes it — and it is how such a project is changed. There a column left out that the file syncs is taken
 * when nothing moved: the same column of the same entry's own record, under the name it was last taken under. A column
 * that moved, or that another entry's record left out, stays held.
 * A table of ANOTHER OID than its own record's (dropped and made again under its name, or another renamed into its
 * place) is another table: its columns are decided by what any record of its own oid says, else by name, and a name the
 * table it replaced left out stays out — a name is all that can tell them apart, so a column of such a name that the
 * file syncs is held (fail closed). Taken, it is `replaced`: its synced data is another table's, read again whole.
 */
export function identityVerdict(t: IdentityInput, own: ColumnRecord | undefined, confirmed: boolean, readOnly = false, carried: readonly CarriedRecord[] = []): IdentityVerdict {
  const cols = t.shape === undefined ? [] : shapeTuples(t.shape);
  if (t.oid === undefined || !Number.isInteger(t.oid) || cols.length === 0 || cols.some((c) => !Number.isInteger(c.attnum))) return { kind: "unknown" };
  const synced = new Set(t.synced);
  const replaced = own !== undefined && own.oid !== t.oid;
  const mine = own !== undefined && !replaced ? own : undefined;
  // every record of this relation, its entry's own first: a column is left out when any of them left it out, and only
  // its own record's left out column is one a read-only project's committed file may confirm (`foreign` otherwise)
  const was = new Map<number, RecordedColumn & { foreign: boolean; from?: string }>();
  if (!confirmed) {
    const records: Array<ColumnRecord & { from?: string }> = [...(mine !== undefined ? [mine] : []), ...carried.filter((x) => x.oid === t.oid)];
    for (const r of records) {
      const foreign = r !== mine;
      for (const c of r.columns) {
        const before = was.get(c.attnum);
        const from = foreign && !c.synced && r.from !== undefined ? { from: r.from } : {};
        if (before === undefined || (before.synced && !c.synced)) was.set(c.attnum, { attnum: c.attnum, name: c.name, synced: c.synced, foreign: foreign && !c.synced, ...from });
        else if (!before.synced && !c.synced && foreign) before.foreign = true;
      }
    }
  }
  // the names the table this one replaced left out, unless the person confirmed the entry
  const outBefore = replaced && !confirmed ? new Set(own.columns.filter((c) => !c.synced).map((c) => c.name)) : new Set<string>();
  const conflicts: Conflict[] = [];
  // a synced column renamed out of what the entry names (a `columns:` entry): kept in the line a hold says
  const renamedOut: string[] = [];
  const columns: RecordedColumn[] = [];
  for (const c of cols) {
    const r = was.get(c.attnum);
    const syncs = synced.has(c.name);
    if (r === undefined && outBefore.has(c.name)) {
      if (syncs) conflicts.push({ name: c.name, was: c.name });
      columns.push({ attnum: c.attnum, name: c.name, synced: false });
      continue;
    }
    if (r === undefined || r.synced) {
      if (r !== undefined && r.name !== c.name && !syncs) renamedOut.push(c.name);
      columns.push({ attnum: c.attnum, name: c.name, synced: syncs });
      continue;
    }
    // A READ-ONLY PROJECT'S COMMITTED FILE confirms a column of its own record that did not move
    if (readOnly && !r.foreign && r.name === c.name) { columns.push({ attnum: c.attnum, name: c.name, synced: syncs }); continue; }
    // LEFT OUT: stays out under any name, its own included; the file syncing it is a conflict, which only a
    // confirmation ends. Recorded under its name now, for the words alone
    if (syncs) conflicts.push({ name: c.name, was: r.name, ...(r.from !== undefined && r.foreign ? { from: r.from } : {}) });
    columns.push({ attnum: c.attnum, name: c.name, synced: false });
  }
  const record = { oid: t.oid, columns };
  if (conflicts.length === 0) return { kind: "taken", record, ...(replaced ? { replaced: true as const } : {}) };
  return { kind: "held", why: heldText(t, cols.map((c) => c.name), conflicts, renamedOut, readOnly), conflicts, record };
}

/** What a hold says, in the sources file's words: which column is which, that the synced data serves as it was, the
 *  line that keeps each out (a `columns:` entry's keeps a synced column renamed, `renamedOut`, under its new name), and
 *  the way that syncs each — `mason add` naming every column, since it writes the entry anew; in a read-only project,
 *  where `mason add` is refused, the entry taken out and put back, each started with. */
function heldText(t: IdentityInput, names: readonly string[], conflicts: readonly Conflict[], renamedOut: readonly string[], readOnly: boolean): string {
  const one = conflicts.length === 1;
  const renamed = conflicts.some((c) => c.from === undefined && c.name !== c.was);
  const which = conflicts.map((c) => c.from !== undefined
    ? `${c.name} is a column the sources file left out of ${c.from}${c.name === c.was ? "" : ` as ${c.was}`}, and ${t.source} is that table now (tables or schemas were renamed on the database)`
    : c.name === c.was ? `${c.name} is a column the sources file left out` : `${c.name} is the column the sources file left out as ${c.was}`).join("; ");
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
  if (readOnly) {
    return `${head}. To keep ${one ? "it" : "them"} out, write ${line} on ${at} in the committed sources file, and start Mason with it. ` +
      `To sync ${one ? "it" : "them"}, take the entry out of the committed file and start Mason with it, then put the entry back and start Mason again: ` +
      "the table is synced again whole";
  }
  return `${head}. To keep ${one ? "it" : "them"} out, write ${line} on ${at}, then run mason stop && mason start. ` +
    `To sync ${one ? "it" : "them"}, run mason add ${e.name} --columns ${all.join(",")} while Mason runs`;
}

/** A RECORD NO ENTRY HOLDS AS ITS OWN (issue 1080), kept by its relation's oid (`_mason.column_identity_former`): the
 *  record of the relation a table named before it named another (two tables swapped, a schema renamed), which may be
 *  on the database under another entry's name, and the record a table is held by that is not its own entry's. `from`:
 *  the entry that left its columns out, for the words; `heldBy`: the entry it holds, whose removal forgets it (as a
 *  removal forgets its own record). Taken as a table's own, it is no longer kept here. */
export interface FormerRecord { columns: RecordedColumn[]; from: string; heldBy: string | null }

/** Two records of one relation as one: a column either left out is left out, under the name it was left out under. */
export function unionOut(a: readonly RecordedColumn[], b: readonly RecordedColumn[]): RecordedColumn[] {
  const out = new Map<number, RecordedColumn>(a.map((c) => [c.attnum, c]));
  for (const c of b) {
    const before = out.get(c.attnum);
    if (before === undefined || (before.synced && !c.synced)) out.set(c.attnum, c);
  }
  return [...out.values()].sort((x, y) => x.attnum - y.attnum);
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
