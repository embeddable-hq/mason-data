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
import type { Failure } from "./command.ts";
import type { SourceTable } from "./preflight.ts";
import { addedTables, chooseColumns, entryName, entryProblems, findEntry, parseSourceText, sourceFailure, sourceFileNames, sourcesDir, unaddableReason,
  withoutTable, withTable, type ProjectSource, type SourceFile } from "./sources.ts";

/** A refusal the command shows as it is; `failure` is how the web page says it (the CLI's Failure: why, fix, next), by
 *  default the message alone under the status's code. */
export class Refusal extends Error {
  readonly status: number;
  readonly failure: Failure;
  constructor(status: number, message: string, failure?: Failure) { super(message); this.status = status; this.failure = failure ?? { message, code: codeOf(status) }; }
}

/** The FAILURE_CODES code (src/cli/command.ts) of a refusal by its HTTP status. */
const codeOf = (status: number): string => status === 400 ? "usage" : status === 404 ? "not_found" : status >= 500 ? "failed" : "refused";

/** The sources file to edit: where it is, its text, what it says, and the file read as the run reads it (its URL resolved). */
export interface EditTarget { root: string; file: string; text: string; parsed: SourceFile; read: ProjectSource }

/** The database an edit is checked against: its catalog (preflight.ts readSourceFacts), its name, and whether its changes
 *  are read by logical replication (a `--key` table cannot be). */
export interface EditCatalog { tables: readonly SourceTable[]; database: string; replication: boolean }

/**
 * The project's sources file as it is on disk NOW, its text and what it says — or why it cannot be edited: no folder, not
 * exactly one file, a file with mistakes of its own, a URL that cannot be resolved (`read`, the file read as the run reads
 * it: src/cli/sources.ts readSource).
 */
export function sourceToEdit(folder: string | null, root: string, read: () => ProjectSource | Failure): EditTarget {
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
  const held = addedTables(others, db.tables, db.database, at.root, { replication: db.replication });
  if (!Array.isArray(held)) throw new Refusal(409, `${held.message}${held.why ? `\n${held.why}` : ""} — fix it first, then ${then}`);
}

/** What `mason add` did to one table: its entry in the sources file, and what the columns asked for left out. */
export interface PickResult {
  table: string;
  /** the sources file, absolute */
  file: string;
  /** the entry's key (`orders`, `billing.invoices`), and what it copies */
  entry: string; columns: string[] | null; exclude: string[]; key: string[] | null;
  /** the key's columns added to a --columns list (a copy always has its key) */
  addedKey: string[];
  /** secret-looking columns every-column left out (sources.ts looksSecret) */
  skippedSecrets: string[];
  /** the file named it so already: nothing was written */
  already: boolean;
}

/**
 * ADD A TABLE (`table`: schema.table): its entry in the sources file, written — after the last one, or in place of the
 * table's own (`withTable`): every other byte of the file as it was. `columns` are the ones asked (`["*"]`: every one);
 * `key` the columns a table with no primary key is copied by. The entry and the file's other entries must hold against
 * the database first: an edit is never written over a file the next read would refuse.
 */
export function addEntry(at: EditTarget, db: EditCatalog, table: string, columns: readonly string[] = ["*"], key: readonly string[] | null = null): PickResult {
  const t = db.tables.find((x) => x.source === table);
  if (!t) throw new Refusal(404, `${table} is not a table of ${db.database} that this user can read`);
  if (key !== null && t.key.length) throw new Refusal(400, `${table} has a primary key (${t.key.join(", ")}), which Mason copies it by: leave --key out`);
  if (key === null && !t.key.length) throw new Refusal(409, `${table} cannot be added: ${unaddableReason(t)}`);
  if (key !== null && db.replication) throw new Refusal(409, `${table} has no primary key, and logical replication cannot apply its changes by --key: copy it by polling (mason start --poll), then add it`);
  const chosen = chooseColumns(t, columns, key);
  if ("problem" in chosen) throw new Refusal(400, chosen.problem);
  othersHold(at, db, [table], `add ${entryName(table)}`);
  const was = at.parsed.tables.find((e) => e.table === table);
  const entry = { name: was?.name ?? entryName(table), table, columns: chosen.columns, exclude: chosen.exclude, key: key === null ? null : [...key] };
  // the entry itself, as the run will read it: a --key that does not tell the rows apart is refused here, not at the copy
  const own = entryProblems(t, entry, db.tables, db.database, { replication: db.replication });
  if (own.length) throw new Refusal(400, own.join("; "));
  const same = was !== undefined && JSON.stringify([was.columns, was.exclude, was.key]) === JSON.stringify([entry.columns, entry.exclude, entry.key]);
  if (!same) {
    const r = withTable(at.text, entry);
    if ("problem" in r) throw new Refusal(409, `${path.relative(at.root, at.file)} cannot be edited: ${r.problem}`);
    fs.writeFileSync(at.file, r.text);
  }
  return { table, file: at.file, entry: entry.name, columns: entry.columns, exclude: entry.exclude, key: entry.key, addedKey: chosen.addedKey, skippedSecrets: chosen.skipped, already: same };
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
