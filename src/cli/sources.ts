/**
 * THE PROJECT'S SOURCE (models meant nothing in the DuckDB version of Mason, so they gave way to a `sources` folder,
 * each file a source to sync naming the tables and columns it syncs). One file, `<folder>/sources/<name>.yml`, the
 * project's to commit:
 *
 *   kind: postgres
 *   url: ${DATABASE_URL}          an env var from .env.local, .env or the shell; a literal URL for local dev
 *   database: production          the database name a tool connects with (none: mason; src/lib/database-name.ts)
 *   sync: off                     how each table is kept current after its first sync (src/lib/table-sync.ts): off
 *                                 (the default: until mason sync <table>), poll <interval> or replication; an entry's
 *                                 own overrides it
 *   publication: ${PG_PUBLICATION}  the publication `replication` reads, its owner's (never altered); none: Mason's own
 *                                   (the literal `publication: null` says so, past one an earlier start recorded)
 *   tables:
 *     orders:                     a bare name is in `public`; `billing.invoices` names its schema
 *       columns: [id, customer_id, status]
 *       sync: poll 30s            this table polled every 30 seconds
 *     customers: {}               every column
 *     events:
 *       exclude: [raw_body]       every column but these
 *     sessions:
 *       key: [tenant_id, id]      only for a table with no primary key: the unique columns to copy it by
 *
 * The file's name is the source's name; one source per project for now. Types are NOT in it: the run reads them from
 * the source at every start. Every mistake is said with the file, the key, what is wrong and the way out — all of a
 * file's mistakes on ONE report (`sourceFailure`), so a coding agent fixes the file from the message alone.
 *
 * Read in two steps, because the second needs the database: `readSource` (the file alone: its shape, its URL resolved)
 * and `addedTables` (its tables against the database's catalog: what the run copies, `AddedTable`). `withTable` and
 * `withoutTable` are what `mason add` and `mason remove` write: one entry spliced into or out of the text at the YAML
 * node's own position, every other byte — a person's comments and layout — as it was.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isMap, isScalar, parseDocument, type Document, type Pair, type YAMLMap } from "yaml";
import { databaseNameProblem, DEFAULT_DATABASE } from "../lib/database-name.ts";
import { appEnvValue, ENV_FILE } from "../lib/dotenv.ts";
import { closest, didYouMean } from "../lib/did-you-mean.ts";
import { caseClashes } from "../lib/relation-key.ts";
import type { Failure, NextStep } from "./command.ts";
import { maskedUrl, type SourceTable } from "./preflight.ts";
import { pgIdent } from "../cdc/pg-wire.ts";
import type { AddedTable } from "../duck/sync.ts";
import { DEFAULT_SYNC, parseSync, syncText, type SourcesTop, type TableSync } from "../lib/table-sync.ts";

export const SOURCES_DIR = "sources";
const KEYS = ["kind", "url", "database", "sync", "publication", "tables"] as const;
const ENTRY_KEYS = ["columns", "exclude", "key", "sync"] as const;
const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * A `${NAME}` naming one of Mason's own settings (`MASON_*`, such as `MASON_API_KEY`): refused where the file is read,
 * before anything resolves it, because a project may be someone else's and the value would be printed or sent as the
 * publication's name (issue 718). `url:` keeps `${MASON_DATABASE_URL}`, the source's URL `mason init` reads and writes.
 */
const ownSetting = (name: string, key: "url" | "publication"): string | null =>
  !/^MASON_/i.test(name) || (key === "url" && name === "MASON_DATABASE_URL") ? null :
    `${key}: \${${name}} names one of Mason's own settings (MASON_*), which a sources file may not read — ` +
    (key === "url" ? "write url: ${DATABASE_URL} (or ${MASON_DATABASE_URL}), or a postgres:// URL" :
      "write publication: ${PG_PUBLICATION}, the publication's name, or publication: null and Mason makes its own");

/** A table the file names, as it names it. */
export interface TableEntry {
  /** the key as written: `orders` (in public) or `billing.invoices` */
  name: string;
  /** `schema.table` */
  table: string;
  /** the columns it copies; null: every column but `exclude` */
  columns: string[] | null;
  /** the columns it leaves out (with `columns: null` only) */
  exclude: string[];
  /** the columns it is copied by, for a table the source gives no primary key; null: the primary key */
  key: string[] | null;
  /** how it is kept current, as its entry says (null: the file's `sync:`, else the default: `effectiveSync`) */
  sync: TableSync | null;
}

export interface SourceFile {
  /** the file's name without `.yml`: the source's name */
  name: string;
  /** the file, absolute */
  file: string;
  kind: "postgres";
  /** where the URL comes from: `${NAME}` (resolved by `readSource`) or the URL written in the file */
  url: { env: string } | { literal: string };
  /** the database name a tool connects with, as the file writes it; null: none written (src/lib/database-name.ts `connectDatabase`) */
  database: string | null;
  /** every table's sync unless its entry says its own, as the file says it at the top (null: not written, so `off`) */
  sync: TableSync | null;
  /** the publication the `replication` tables are read through, its owner's: `${NAME}` (resolved by `readSource`) or
   *  its name written in the file; null: none named, so Mason makes its own (src/duck/sync.ts ensurePublication) */
  publication: { env: string } | { literal: string } | { own: true } | null;
  tables: TableEntry[];
}

/** The tables a file keeps current by replication, by their effective sync (`effectiveSync`): what streams. */
export function replicatedEntries(src: Pick<SourceFile, "sync" | "tables">): TableEntry[] {
  return src.tables.filter((e) => effectiveSync(src, e).sync.mode === "replication");
}

/** Whether the file says how anything is kept current: a `sync:` at its top or on any entry. A file with none has every
 *  table on the default, by no one's choice: what an older Mason's file looks like. */
export function syncWritten(file: Pick<SourceFile, "sync" | "tables">): boolean {
  return file.sync !== null || file.tables.some((e) => e.sync !== null);
}

/**
 * A FILE THAT HAS GONE SILENT OVER A PROJECT THAT STREAMS: it names tables and no `sync:`, where the config records a
 * slot. Silent is no decision (a file with no table has nothing left to stream). One rule for the start, whose refusal
 * is `recordRefusal` (src/cli/replication-mode.ts), and the run's re-read (`rereadSources`).
 */
export function silentOverSlot(slotRecorded: boolean, file: Pick<SourceFile, "sync" | "tables">): boolean {
  return slotRecorded && file.tables.length > 0 && !syncWritten(file);
}

/** A table's sync: its entry's, else the file's, else the default (`off`) — and which of the three said it. */
export function effectiveSync(src: Pick<SourceFile, "sync">, e: Pick<TableEntry, "sync"> | undefined): { sync: TableSync; from: "entry" | "file" | "default" } {
  if (e?.sync) return { sync: e.sync, from: "entry" };
  if (src.sync) return { sync: src.sync, from: "file" };
  return { sync: DEFAULT_SYNC, from: "default" };
}

/** The file read and its URL resolved: what the run, `mason tables` and `mason doctor` connect with. */
export interface ProjectSource extends SourceFile {
  /** the database's URL, password included (never printed: maskedUrl) */
  resolved: string;
  /** where it was read: `DATABASE_URL in .env`, `DATABASE_URL in the shell`, or the file's own path */
  from: string;
  /** the publication `publication:` names, resolved (null: none named) */
  publicationName: string | null;
}

/** A file as messages name it: relative to the project's root. */
export const shownPath = (root: string, file: string): string => path.relative(root, file) || file;

/** A table as a key of the file: its name alone in public, else schema.table. */
export const entryName = (source: string): string => source.startsWith("public.") ? source.slice("public.".length) : source;
/** The table a key names: `orders` is `public.orders`, `billing.invoices` itself. */
export const sourceOf = (name: string): string => name.includes(".") ? name : `public.${name}`;

/**
 * WHAT A TABLE'S NAME MAY BE, at every entrance — the file's key, mason add, mason remove, mason tables, mason sync: its
 * name alone (in public) or schema.table. A third part is refused by name, never read as a name holding a dot: a
 * project will sync several databases, and `source.schema.table` will name a table of one of them. `near` are the
 * tables (schema.table) it may have meant, its last two parts' closest said as `did you mean`. Null when it is a name.
 */
export function tableNameProblem(name: string, near: Iterable<string> = []): string | null {
  if (name === "" || name.trim() !== name || /^\.|\.$|\.\./.test(name)) return "a table is its name (orders) or schema.table (billing.invoices)";
  const parts = name.split(".");
  if (parts.length <= 2) return null;
  const tail = parts.slice(-2).join("."), all = [...near];
  const hit = all.includes(tail) ? tail : closest(tail, all);
  return `${name} has ${parts.length} parts, and a table is schema.table (billing.invoices) or its name alone in public (orders): ` +
    `this project has one source, so a table's name has at most two${hit ? ` — did you mean \`${entryName(hit)}\`?` : ""}`;
}

/**
 * A FILE'S MISTAKES, ALL OF THEM (CLAUDE.md "An error a developer meets says what to do about it"): each one at its key
 * with what to change, said together as one failure — the one as the message, or a count with each under `why` — so
 * fixing one never uncovers the next only at the next start.
 */
export function sourceFailure(file: string, root: string, problems: readonly string[], next: readonly NextStep[] = []): Failure {
  const f = shownPath(root, file);
  const one = problems.length === 1;
  return {
    message: one ? `${f}: ${problems[0]!}` : `${f} has ${problems.length} mistakes`,
    code: "bad_source",
    ...(one ? {} : { why: problems.map((p) => `- ${p}`).join("\n") }),
    fix: `edit ${f}, then run the command again`,
    ...(next.length ? { next } : {}),
  };
}

/** What YAML read a bare word as, said: `true is read by YAML as a boolean, not a name`. */
const yamlRead = (x: unknown): string =>
  `${x === null ? "null" : String(x)} is read by YAML as ${x === null ? "nothing (null)" : typeof x === "boolean" ? "a boolean" : typeof x === "number" ? "a number" : "a list or a map"}, not a name`;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A list of column names at `at`, or the problem with it. */
function nameList(v: unknown, at: string, what: string): string[] | string {
  if (Array.isArray(v) && v.length) {
    // a name YAML reads as something else (`true`, `null`, `1`): quoted, it is the column's name
    const other = v.find((x) => typeof x !== "string");
    if (other !== undefined) return `${at}: ${yamlRead(other)} — quote it: "${String(other)}"`;
  }
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x !== "")) return `${at}: is ${what}, a list of column names: [id, status]`;
  const twice = v.find((x, i) => v.indexOf(x) !== i);
  if (twice !== undefined) return `${at}: names ${String(twice)} twice`;
  return v as string[];
}

/** The file's `database:`: the name it writes, null when it has no such line, or the problem with it (`text`, the file's). */
function databaseKey(doc: Document, text: string): { database: string | null } | { problem: string } {
  const node = isMap(doc.contents) ? doc.contents.get("database", true) : undefined;
  if (node === undefined) return { database: null };
  const way = `write database: <name>, or take the line out: tools then connect with ${DEFAULT_DATABASE}`;
  if (!isScalar(node)) return { problem: `database: is one name, not a list or a map — ${way}` };
  if (node.value === null) return { problem: `database: is empty — ${way}` };
  if (typeof node.value !== "string") {
    const written = text.slice(node.range![0], node.range![1]);
    return { problem: `database: ${yamlRead(node.value).replace(/^\S+/, written)} — quote it: "${written}"` };
  }
  const bad = databaseNameProblem(node.value);
  return bad === null ? { database: node.value } : { problem: `database: ${bad} — ${way}` };
}

/** A file that is YAML and no mapping, said; `v` is what it read as. */
const notMapping = (v: unknown): string => `it is ${v === null || v === undefined ? "empty" : "not a mapping"}: a source file is kind: postgres, url: \${DATABASE_URL} and tables: {}`;

/**
 * The file's text read as a source file: its shape, never the database (that is `addedTables`'s). `name` is the
 * source's (the file's name); the problems are each at their key, in the order they are in the file.
 */
export function parseSourceText(text: string, name: string, file: string): SourceFile | { problems: string[] } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { problems: [`it is not YAML: ${doc.errors[0]!.message.split("\n")[0]}`] };
  // a document the library parses can still refuse to become values (more aliases than it expands: a file built to
  // exhaust memory), and throws: a problem of the file, never a crash
  let v: unknown;
  try { v = doc.toJS(); }
  catch (e) { return { problems: [`it cannot be read as values: ${(e as Error).message.split("\n")[0]}`] }; }
  if (!isPlain(v)) return { problems: [notMapping(v)] };
  const problems: string[] = [];
  for (const k of Object.keys(v)) {
    if (!(KEYS as readonly string[]).includes(k)) problems.push(`unexpected key ${k}${didYouMean(k, KEYS)} — a source file takes ${KEYS.join(", ")}`);
  }
  let kind: "postgres" | null = null;
  if (v.kind === undefined || v.kind === null) problems.push("kind: missing — write kind: postgres (the kind of database this source is)");
  else if (v.kind === "postgres") kind = "postgres";
  else if (typeof v.kind === "string") problems.push(`kind: ${v.kind} is not supported yet — postgres is the only kind for now`);
  else problems.push("kind: write kind: postgres");

  let url: SourceFile["url"] | null = null;
  if (v.url === undefined || v.url === null) problems.push("url: missing — write url: ${DATABASE_URL} (DATABASE_URL in .env or the shell), or a postgres:// URL");
  else if (typeof v.url !== "string" || v.url.trim() === "") problems.push("url: write url: ${DATABASE_URL}, or a postgres:// URL");
  else {
    const m = ENV_REF.exec(v.url.trim());
    const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(v.url.trim());
    const own = m ? ownSetting(m[1]!, "url") : null;
    if (own !== null) problems.push(own);
    else if (m) url = { env: m[1]! };
    else if (bare) problems.push(`url: $${bare[1]} — write \${${bare[1]}}: a variable is named in braces`);
    else if (v.url.includes("${")) problems.push("url: holds a ${NAME} inside a longer value (not shown: it may hold a password) — write the URL whole, or ${NAME} alone: the whole URL in one variable, like ${DATABASE_URL}");
    else url = { literal: v.url.trim() };
  }

  // the name a tool connects with: written out, the same on every machine (src/lib/database-name.ts)
  const named = databaseKey(doc, text);
  if ("problem" in named) problems.push(named.problem);

  // the publication a replicated table is read through: a name, or ${NAME} as url: takes one (resolved by readSource)
  let publication: SourceFile["publication"] = null;
  // the word `null`, as written: Mason's own, on purpose, past a name a start recorded (src/cli/replication-mode.ts
  // recordRefusal). A key left with no value is a line half-written, never that decision; no line at all says nothing
  const publicationNode = doc.get("publication", true);
  if (v.publication === null && isScalar(publicationNode) && publicationNode.source === "null") publication = { own: true };
  else if (v.publication !== undefined) {
    const p = typeof v.publication === "string" ? v.publication.trim() : "";
    const m = ENV_REF.exec(p);
    if (p === "") problems.push("publication: write publication: ${PG_PUBLICATION}, or a publication's name (publication: null and Mason makes its own)");
    else if (m) {
      const own = ownSetting(m[1]!, "publication");
      if (own !== null) problems.push(own);
      else publication = { env: m[1]! };
    }
    else if (p.includes("$")) problems.push(`publication: ${JSON.stringify(p)} — write \${NAME} alone, like \${PG_PUBLICATION}, or the publication's name`);
    else publication = { literal: p };
  }

  // every table's sync, unless its entry says its own (src/lib/table-sync.ts: one grammar, `mason add --sync` reads it too)
  let sync: TableSync | null = null;
  if (v.sync !== undefined) {
    const s = parseSync(v.sync);
    if ("problem" in s) problems.push(`sync: ${s.problem}`);
    else sync = s;
  }

  const tables: TableEntry[] = [];
  const tablesNode = isMap(doc.contents) ? (doc.contents as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === "tables")?.value : undefined;
  const odd = new Set<string>();
  if (isMap(tablesNode)) {
    for (const p of (tablesNode as YAMLMap).items) {
      if (!isScalar(p.key) || typeof p.key.value === "string") continue;
      const written = (p.key as Ranged).range ? text.slice((p.key as Ranged).range![0], (p.key as Ranged).range![1]) : String(p.key.value);
      problems.push(`tables: ${yamlRead(p.key.value).replace(/^\S+/, written)} — quote it: "${written}"`);
      odd.add(String(p.key.value));
    }
  }
  if (v.tables === undefined) problems.push("tables: missing — write tables: {} (mason add adds a table to it)");
  else if (v.tables !== null && !isPlain(v.tables)) problems.push("tables: is one entry per table, like tables: { orders: {}, customers: { columns: [id, name] } }");
  else {
    const seen = new Map<string, string>();
    for (const [key, raw] of Object.entries(v.tables ?? {})) {
      if (odd.has(key)) continue;
      const at = `tables.${key}`;
      const badName = tableNameProblem(key);
      if (badName !== null) { problems.push(`${at}: ${badName}`); continue; }
      const table = sourceOf(key);
      const before = seen.get(table);
      if (before !== undefined) { problems.push(`${at}: ${table} is named twice (as ${before} too) — keep one`); continue; }
      seen.set(table, key);
      if (raw !== null && !isPlain(raw)) { problems.push(`${at}: is {} (every column), { columns: [...] }, { exclude: [...] }, { key: [...] } or { sync: poll 5m }`); continue; }
      const e = raw ?? {};
      const stray = Object.keys(e).filter((k) => !(ENTRY_KEYS as readonly string[]).includes(k));
      for (const k of stray) problems.push(`${at}: unexpected key ${k}${didYouMean(k, ENTRY_KEYS)} — a table takes columns, exclude, key and sync`);
      const both = e.columns !== undefined && e.exclude !== undefined;
      if (both) problems.push(`${at}: columns and exclude together — columns names what is synced, exclude what is left out of every column; keep one`);
      const columns = e.columns === undefined ? null : nameList(e.columns, `${at}.columns`, "the columns synced");
      const exclude = e.exclude === undefined ? [] : nameList(e.exclude, `${at}.exclude`, "the columns left out");
      const ownKey = e.key === undefined ? null : nameList(e.key, `${at}.key`, "the columns that tell its rows apart");
      for (const x of [columns, exclude, ownKey]) if (typeof x === "string") problems.push(x);
      const ownSync = e.sync === undefined ? null : parseSync(e.sync);
      if (ownSync !== null && "problem" in ownSync) problems.push(`${at}.sync: ${ownSync.problem}`);
      if (typeof columns === "string" || typeof exclude === "string" || typeof ownKey === "string" || stray.length || both || (ownSync !== null && "problem" in ownSync)) continue;
      tables.push({ name: key, table, columns, exclude, key: ownKey, sync: ownSync });
    }
  }
  if (problems.length || kind === null || url === null || "problem" in named) return { problems };
  return { name, file, kind, url, database: named.database, sync, publication, tables };
}

/** Where a project's source files are: `<folder>/sources/`. */
export const sourcesDir = (folder: string): string => path.join(folder, SOURCES_DIR);

/** The names of the source files in `<folder>/sources/` (`.yml`, `.yaml`), sorted; [] when it has none. */
export function sourceFileNames(folder: string): string[] {
  const dir = sourcesDir(folder);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith(".")).sort();
}

/**
 * THE TOP OF A PROJECT'S SOURCES FILE, for a retired setting's way out (src/lib/table-sync.ts `topEdit`): its one file
 * as a person names it from `root`, and the values its top-level `sync:` and `publication:` lines hold as written, so
 * the way out changes the line the file has rather than writing a second. No file (or several): the place every
 * project's file has, and no line. A file that cannot be read or parsed is said by the run in its own words
 * (`readSource`); here it only words the edit, as for a file with no such line.
 */
export function sourcesTop(root: string, folder: string): SourcesTop {
  const names = sourceFileNames(folder);
  if (names.length !== 1) return { shown: `${shownPath(root, sourcesDir(folder))}/<name>.yml`, sync: null, publication: null };
  const file = path.join(sourcesDir(folder), names[0]!);
  const shown = shownPath(root, file);
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    // the run's own read says it, with the file and the error (readSource); the edit is worded as for no line
    if ((e as NodeJS.ErrnoException).code === undefined) throw e;
    return { shown, sync: null, publication: null };
  }
  const doc = parseDocument(text);
  const at = (key: "sync" | "publication"): string | null => {
    if (!isMap(doc.contents)) return null;
    const node = doc.contents.get(key, true);
    if (node === undefined || node === null) return null;
    return isScalar(node) ? String(node.value) : String(node);
  };
  return { shown, sync: at("sync"), publication: at("publication") };
}

/**
 * THE `database:` A PROJECT WRITES, from the file alone and only its one key (src/lib/database-name.ts): what `mason user
 * add` says with Mason stopped, which needs neither the database's URL nor the rest of the file right. No file writes
 * none. A file it cannot read this key from is refused, in the failure shape: guessing `mason` would hand a tool a name
 * the run may not answer to.
 */
export function writtenDatabase(folder: string, root: string): { database: string | null } | Failure {
  const names = sourceFileNames(folder);
  if (names.length === 0) return { database: null };
  if (names.length > 1) return tooManySources(root, sourcesDir(folder), names);
  const file = path.join(sourcesDir(folder), names[0]!);
  const text = fs.readFileSync(file, "utf8");
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return sourceFailure(file, root, [`it is not YAML: ${doc.errors[0]!.message.split("\n")[0]}`]);
  if (!isMap(doc.contents)) {
    // (a document whose values the library refuses to expand throws: said as the file's problem, never a crash)
    let v: unknown;
    try { v = doc.toJS(); }
    catch (e) { return sourceFailure(file, root, [`it cannot be read as values: ${(e as Error).message.split("\n")[0]}`]); }
    return sourceFailure(file, root, [notMapping(v)]);
  }
  const named = databaseKey(doc, text);
  return "problem" in named ? sourceFailure(file, root, [named.problem]) : named;
}

/** The file `mason init` writes: the database, how its tables are kept current (`sync`: `off`, the default; the demo's
 *  `poll 5s`, so it shows a copy keeping up), then its tables — none yet, but for `mason init demo`'s, which names the
 *  demo database's tables (`tables`, each copied whole: `{}`), so its first start copies them and shows something.
 *  `database:` only when one is asked for (`--database`): none written, the default stays a default. */
export function newSourceText(url = "${DATABASE_URL}", tables: readonly string[] = [], sync: TableSync = DEFAULT_SYNC, database: string | null = null): string {
  return "# The database this project syncs from, and which of its tables. Yours to commit; the URL stays out of it.\n" +
    (database === null ? `# Tools connect with the database name ${DEFAULT_DATABASE}; database: <name> here keeps the name a tool already has.\n` : "") +
    "kind: postgres\n" +
    `url: ${url}${ENV_REF.test(url) ? "   # from .env.local, .env or the shell; a literal postgres:// URL works too" : ""}\n` +
    (database === null ? "" : `database: ${yamlName(database)}   # the database name a tool connects with\n`) +
    `sync: ${syncText(sync)}${sync.mode === "off" ? "   # after its first sync, a table is read again only by mason sync <table> (poll 5m: every 5 minutes)"
      : sync.mode === "replication" ? "   # each table kept current from the database's change log after its first sync (poll 5m, or off, on an entry)"
      : `   # each table polled every ${sync.every} after its first sync (off: read again only by mason sync <table>)`}\n` +
    "\n" +
    "# One entry per table, a bare name in public, else schema.table: {} syncs every column, columns: [id, status]\n" +
    "# those, exclude: [payload] every column but those; key: [a, b] names the columns that tell its rows apart, for a\n" +
    "# table with no primary key; sync: poll 30s (or off) keeps that table current its own way. mason add and mason remove\n" +
    "# edit this list; so can you.\n" +
    (tables.length ? `tables:\n${tables.map((t) => `  ${t}: {}\n`).join("")}` : "tables: {}\n");
}

/** A source's name from its database's: the file is named for it, else `app`. */
export function sourceNameFor(database: string): string {
  const n = database.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 48);
  return n || "app";
}

/** The folder an older Mason listed a project's tables in, one file per table: read by nothing, said by `readSource`. */
export const OLD_TABLES_DIR = "models";

/** A second source file, refused: one source per project for now. */
const tooManySources = (root: string, dir: string, names: readonly string[]): Failure => ({
  message: `${shownPath(root, dir)}/ has ${names.length} source files (${names.join(", ")}): one source per project for now`, code: "bad_source",
  fix: `keep the one this project syncs from, and move the others out of ${shownPath(root, dir)}/` });

/**
 * THE PROJECT'S SOURCE FILE, read: the one file in `sources/` (a second is refused by name: one source per project for
 * now), parsed, its URL resolved — `${NAME}` from the project's .env.local or .env, else the shell (src/lib/dotenv.ts
 * `appEnvValue`, the order `mason init` reads MASON_DATABASE_URL and DATABASE_URL in, so the two cannot disagree); `shellFirst` for a server
 * (`mason serve`), configured by its environment alone. A project with no file is told what to write — one an older
 * Mason made (its tables listed in another folder, which nothing reads) that mason init writes it.
 */
export function readSource(folder: string, root: string, env: NodeJS.ProcessEnv = process.env, o: { shellFirst?: boolean } = {}): ProjectSource | Failure {
  const parsed = readSourceFile(folder, root);
  if ("message" in parsed) return parsed;
  const file = parsed.file;
  const where = o.shellFirst ? "the environment, .env.local or .env" : ".env.local, .env or the shell";
  // the publication's name, read as url: is: ${NAME} from the same places, in the same order
  let publicationName: string | null = null;
  if (parsed.publication !== null && "literal" in parsed.publication) publicationName = parsed.publication.literal;
  else if (parsed.publication !== null && "env" in parsed.publication) {
    const v = parsed.publication.env;
    const p = appEnvValue(root, v, env, { shellFirst: o.shellFirst === true });
    if (p === null || p.value.trim() === "") {
      return { message: `${shownPath(root, file)}: publication: \${${v}} is not set — not in ${where}`, code: "bad_source",
        fix: `put ${v}=<the publication's name> in ${shownPath(root, path.join(root, ENV_FILE))} (or export it), or write publication: null and Mason makes its own` };
    }
    publicationName = p.value.trim();
  }
  if ("literal" in parsed.url) return { ...parsed, resolved: parsed.url.literal, from: shownPath(root, file), publicationName };
  const found = appEnvValue(root, parsed.url.env, env, { shellFirst: o.shellFirst === true });
  if (found === null) {
    const v = parsed.url.env;
    return { message: `${shownPath(root, file)}: url: \${${v}} is not set — not in ${where}`, code: "bad_source",
      fix: `put ${v}=postgres://user:password@host:5432/your_app in ${shownPath(root, path.join(root, ENV_FILE))} (or export it), or write the URL in url:` };
  }
  return { ...parsed, resolved: found.value, from: `${parsed.url.env} in ${found.from}`, publicationName };
}

/**
 * THE PROJECT'S SOURCES FILE, ITS TEXT ALONE (the first step of `readSource`, which resolves its URL after): the one file
 * in `sources/`, parsed, or what is wrong with it. What `mason deploy` checks before it sends a project (src/cli/deploy.ts):
 * there the URL is the replica's environment's, never this machine's .env.
 */
export function readSourceFile(folder: string, root: string): SourceFile | Failure {
  const names = sourceFileNames(folder);
  const dir = sourcesDir(folder);
  if (names.length === 0) {
    const old = path.join(folder, OLD_TABLES_DIR);
    if (fs.existsSync(old)) {
      // no backwards compatibility before v1.0 (CLAUDE.md): nothing is migrated, the way out is said
      return { message: `this project names no database: ${shownPath(root, dir)}/ has no source file, and ${shownPath(root, old)}/ is an older Mason's, which this one does not read`, code: "bad_source",
        fix: `mason init writes ${shownPath(root, dir)}/ (then mason add each table again); remove ${shownPath(root, old)}/ afterwards`, next: [["mason init", `write ${shownPath(root, dir)}/<database>.yml`]] };
    }
    const file = path.join(dir, "app.yml");
    return { message: `this project names no database: ${shownPath(root, dir)}/ has no source file`, code: "bad_source",
      fix: `write ${shownPath(root, file)}, with the database's URL in .env as DATABASE_URL:\n${newSourceText().trimEnd()}` };
  }
  if (names.length > 1) return tooManySources(root, dir, names);
  const file = path.join(dir, names[0]!);
  const parsed = parseSourceText(fs.readFileSync(file, "utf8"), names[0]!.replace(/\.ya?ml$/, ""), file);
  return "problems" in parsed ? sourceFailure(file, root, parsed.problems) : parsed;
}

/** The columns a table's copy keeps, in the source's order: the entry's, its key always among them. */
export function copiedColumns(t: SourceTable, e: Pick<TableEntry, "columns" | "exclude" | "key">): string[] {
  const keep = new Set(e.columns ?? t.columns.map((c) => c.name).filter((c) => !e.exclude.includes(c)));
  for (const k of e.key ?? t.key) keep.add(k);
  return t.columns.map((c) => c.name).filter((c) => keep.has(c));
}

/**
 * COLUMNS WHOSE NAMES DIFFER ONLY IN CASE (issue 1019): Postgres keeps `"U"` and `u` apart, and the synced data takes them
 * for one name (`caseClashes`, src/lib/relation-key.ts), so a table synced with both failed its first sync for ever. Each
 * group of such columns among those the entry syncs (`copiedColumns`), with the ones to leave out so one is left: a key
 * column is kept, else the first. `keyed`: two of the group are the table's key, which is always synced, so no entry
 * can sync it.
 */
export function columnClashes(t: SourceTable, e: Pick<TableEntry, "columns" | "exclude" | "key">): Array<{ group: string[]; leaveOut: string[]; keyed: boolean }> {
  const key = e.key ?? t.key;
  return caseClashes(copiedColumns(t, e)).map((group) => {
    const keys = group.filter((c) => key.includes(c));
    const kept = keys[0] ?? group[0]!;
    return { group, leaveOut: group.filter((c) => c !== kept), keyed: keys.length > 1 };
  });
}

/** names in a sentence: `a`, `a and b`, `a, b and c` */
const andList = (xs: readonly string[]): string => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

/**
 * WHY `mason add` CANNOT ADD A TABLE WITH THESE COLUMNS (`chosen`, as `chooseColumns` decided them; `key` the --key
 * asked) for their case alone (`columnClashes`), in the command's words, with the `--columns` that syncs the others; or
 * null. ONE wording: `unaddableReason` says it of every column (`mason tables`, the web page), `plannedEntry` of the
 * columns asked (src/cli/source-edit.ts).
 */
export function clashReason(t: SourceTable, chosen: Pick<TableEntry, "columns" | "exclude">, key: readonly string[] | null): string | null {
  const e = { ...chosen, key: key === null ? null : [...key] };
  const clashes = columnClashes(t, e);
  const keyed = clashes.find((c) => c.keyed);
  if (keyed !== undefined) return `its key columns ${andList(keyed.group)} have names that differ only in case. The synced data cannot hold them all, so Mason cannot sync it`;
  if (!clashes.length) return null;
  const leaveOut = clashes.flatMap((c) => c.leaveOut);
  const rest = copiedColumns(t, e).filter((c) => !leaveOut.includes(c));
  return `${clashes.map((c) => `its columns ${andList(c.group)}`).join(", and ")} have names that differ only in case. The synced data cannot hold them all. ` +
    `mason add ${entryName(t.source)} --columns ${rest.join(",")}${key !== null ? ` --key ${key.join(",")}` : ""} syncs the others, without ${andList(leaveOut)}`;
}

/** What `entryProblems` says of each `columnClashes` group, at the entry's key, with the line that syncs the table. */
function clashProblems(t: SourceTable, e: TableEntry, at: string): string[] {
  return columnClashes(t, e).map(({ group, leaveOut, keyed }) => {
    const what = `${t.source} has columns ${andList(group)}, whose names differ only in case. The synced data cannot hold them all`;
    if (keyed) return `${at}: ${what}, and they are its key, so Mason cannot sync this table. Remove its entry`;
    if (e.columns !== null) return `${at}.columns: ${what}. Take ${andList(leaveOut)} out of columns:`;
    return `${at}: ${what}. Leave ${leaveOut.length === 1 ? "one" : "all but one"} out: exclude: [${[...e.exclude, ...leaveOut].join(", ")}]`;
  });
}

/**
 * TABLES WHOSE NAMES DIFFER ONLY IN CASE (issue 1019): `"Orders"` and `orders` are two tables in Postgres and one in the
 * synced data, which served one under both names. Each entry after the first of such a group, said at its key.
 */
function tableClashProblems(src: Pick<SourceFile, "tables">): Array<{ entry: TableEntry; problem: string }> {
  return caseClashes(src.tables.map((e) => e.table)).flatMap((group) => {
    const entries = group.map((name) => src.tables.find((e) => e.table === name)!);
    const first = entries[0]!;
    return entries.slice(1).map((e) => ({ entry: e, problem: `tables.${e.name}: ${e.table} and ${first.table} (tables.${first.name}) have names that differ only in case. ` +
      "The synced data cannot hold both. Remove one of the two entries" }));
  });
}

/** Why a table cannot be copied as its entry says, each at its key, against the database's catalog; none when it can. */
export function entryProblems(t: SourceTable | undefined, e: TableEntry, all: readonly SourceTable[], database: string, sync: TableSync): string[] {
  const at = `tables.${e.name}`;
  if (t === undefined) {
    const names = all.map((x) => entryName(x.source));
    return [`${at}: ${database} has no table ${e.table} this user can read${didYouMean(e.name, names)}${names.length ? "" : " (it has none this user can read)"}`];
  }
  const have = t.columns.map((c) => c.name);
  const missing = (list: readonly string[], key: string, then = ""): string[] => list.filter((c) => !have.includes(c)).map((c) =>
    `${at}.${key}: ${t.source} has no column ${c}${didYouMean(c, have)} (its columns: ${have.join(", ")})${then}`);
  // a name of columns: no column is close to was dropped on the database: passed over, said (`goneColumns`) — it only
  // narrows. A name of exclude: the table lacks is ALWAYS refused (fail closed): renamed, its column would be synced
  const near = (list: readonly string[]): string[] => list.filter((c) => !have.includes(c) && didYouMean(c, have) !== "");
  const out = [...missing(near(e.columns ?? []), "columns"),
    ...missing(e.exclude, "exclude", " — if it was renamed on the database, write its new name in exclude:; if it was dropped, take it out of exclude:")];
  if (e.key !== null) {
    if (t.key.length) out.push(`${at}.key: ${t.source} has a primary key (${t.key.join(", ")}), which Mason keys it by — remove key`);
    else {
      out.push(...missing(e.key, "key"));
      out.push(...keyProblems(t, e.key, at));
      // its rows have no identity on the database, so logical replication carries no key to apply a change by
      if (sync.mode === "replication") out.push(`${at}: ${t.source} has no primary key, so logical replication cannot apply its changes by its key: (sync: replication) — give its entry sync: poll <interval> (poll 5m), or sync: off`);
    }
  } else if (!t.key.length) {
    const unique = usableUniqueKey(t);
    out.push(`${at}: ${t.source} has no primary key, so Mason cannot tell its rows apart — name the columns that do: key: [${unique ? unique.columns.join(", ") : "…"}]` +
      `${unique ? ` (its unique index ${unique.name})` : ""}`);
  }
  // a SELECT answers no row and no error: the synced table would be empty, said as though it were the table's
  const hidden = rowSecurityHides(t);
  if (hidden !== null) out.push(`${at}: ${hidden}, or remove its entry`);
  for (const k of (e.key ?? t.key).filter((k) => e.exclude.includes(k))) out.push(`${at}.exclude: ${k} is ${t.source}'s key, which is always synced — take it out of exclude`);
  out.push(...clashProblems(t, e, at));
  // a table that identifies no changed row: a publication carrying its updates would make the app's own UPDATEs and
  // DELETEs on it fail (the catalog says so; the file cannot), so it is never replicated
  if (sync.mode === "replication" && t.replicaIdentity === "n" && e.key === null) {
    out.push(`${at}: ${t.source} has REPLICA IDENTITY NOTHING, and a publication carrying it would make your app's own UPDATEs and DELETEs on it fail (sync: replication) — ` +
      `give its entry sync: poll <interval> (poll 5m), or sync: off; or ALTER TABLE ${t.source} REPLICA IDENTITY DEFAULT on the database`);
  }
  return out;
}

/**
 * THE COLUMNS AN ENTRY'S `columns:` NAMES THAT ITS TABLE NO LONGER HAS (issue 977: a column dropped on the database that
 * an entry named refused the whole project at the next start, until the file was edited): each name the table lacks and
 * that no column of it is close to (`didYouMean` finds none). Such a name is passed over — the entry syncs the columns
 * it still names, never one more — and said (`goneNotes`). A name close to a column (a typo, a rename) is still
 * refused with the name it is close to (`entryProblems`). NEVER a name of `exclude:`: passed over, a column renamed
 * from it would be synced (a salary renamed annual_pay, served). The run itself moves a name of `exclude:` that went
 * while it was up (`leftOutArrivals`); one gone while it was down refuses the file, the way out said.
 */
export function goneColumns(t: Pick<SourceTable, "columns">, e: Pick<TableEntry, "columns">): { columns: string[] } {
  const have = t.columns.map((c) => c.name);
  return { columns: (e.columns ?? []).filter((c) => !have.includes(c) && didYouMean(c, have) === "") };
}

/** What the run says of the names its entries pass over (`goneColumns`), a line each, at the key that names them. */
export function goneNotes(src: Pick<SourceFile, "file" | "tables">, tables: readonly SourceTable[], root: string): string[] {
  const out: string[] = [];
  for (const e of src.tables) {
    const t = tables.find((x) => x.source === e.table);
    if (t === undefined) continue;
    const g = goneColumns(t, e);
    const at = `${shownPath(root, src.file)}: tables.${e.name}`;
    const one = (xs: readonly string[]): boolean => xs.length === 1;
    if (g.columns.length) out.push(`${at}.columns: ${t.source} no longer has ${g.columns.join(", ")}, so ${one(g.columns) ? "it is" : "they are"} not synced. Take ${one(g.columns) ? "it" : "them"} out of columns:`);
  }
  return out;
}

/**
 * A `key:` MUST TELL THE ROWS APART, AS THE DATABASE ENFORCES IT (the review of the sources file: a key with
 * duplicates failed the copy's distinct-key check as "Mason bug", retried for ever, and duplicates after the copy made the
 * poll's update and delete by key change both rows): every column NOT NULL, and a unique index of the table over some of
 * them — then no two rows can share the key. Partial, expression and INVALID indexes are not read (src/cli/preflight.ts
 * TABLES_SQL: a failed CREATE UNIQUE INDEX CONCURRENTLY leaves an invalid one, its duplicates still in the table).
 */
function keyProblems(t: SourceTable, key: readonly string[], at: string): string[] {
  const cols = key.filter((c) => t.columns.some((x) => x.name === c));
  if (cols.length !== key.length) return [];
  const out: string[] = [];
  const nullable = cols.filter((c) => t.columns.find((x) => x.name === c)?.notNull !== true);
  if (nullable.length) out.push(`${at}.key: ${nullable.join(", ")} may be NULL in ${t.source}, and rows with NULL there cannot be told apart — a key's columns are NOT NULL`);
  const usable = (t.uniqueKeys ?? []).filter((u) => u.columns.every((c) => t.columns.find((x) => x.name === c)?.notNull === true));
  if (!(t.uniqueKeys ?? []).some((u) => u.columns.every((c) => key.includes(c)))) {
    out.push(`${at}.key: no unique index of ${t.source} is over (${key.join(", ")}), so two of its rows may share them and Mason could not tell them apart — ` +
      (usable.length ? `name the columns of one: ${usable.map((u) => `key: [${u.columns.join(", ")}] (its unique index ${u.name})`).join(", or ")}`
        : `it has no unique index over NOT NULL columns, so Mason cannot sync it until its owner adds one (or a primary key)`));
  }
  return out;
}

/**
 * THE TABLES THE RUN COPIES (`AddedTable`, src/duck/sync.ts): each entry against the database's catalog, narrowed to the
 * columns it copies (`copiedColumns`) and its foreign keys out of them. A `key:` is the key the table is copied by, and
 * `primaryKey` keeps the source's own (none): the catalog declares only what the source does. Every entry's problems on
 * one report (`sourceFailure`): what a start, `mason tables`, `mason add` and `serve` refuse.
 */
export function addedTables(src: SourceFile, tables: readonly SourceTable[], database: string, root: string): AddedTable[] | Failure {
  const e = entryTables(src, tables, database, root);
  return e.problems.length ? sourceFailure(src.file, root, e.problems, [["mason tables", "the database's tables and their columns"]]) : e.tables;
}

/** An entry the catalog refuses as it is, and what is wrong with it, each at its key (`entryProblems`). */
export interface RefusedEntry { entry: TableEntry; problems: string[] }

/**
 * EACH ENTRY AGAINST THE CATALOG, ON ITS OWN (issue 1074: a column renamed under a `columns:` entry refused the whole
 * file at the run's re-read, and from then on no table took a column change until a restart). `tables`: the entries
 * that pass, as the run syncs them. `refused`: each entry that does not, with its problems, in the file's order.
 * `problems`: all of them, in the order a start says them. One entry's problem is that entry's alone: a start refuses
 * the file on them (`addedTables`), and the run's re-read holds that table alone (`rereadSources`).
 */
export function entryTables(src: SourceFile, tables: readonly SourceTable[], database: string, root: string): { tables: AddedTable[]; refused: RefusedEntry[]; problems: string[] } {
  const clashes = tableClashProblems(src);
  const problems: string[] = clashes.map((c) => c.problem);
  const out: AddedTable[] = [];
  const refused: RefusedEntry[] = [];
  for (const e of src.tables) {
    const t = tables.find((x) => x.source === e.table);
    const sync = effectiveSync(src, e).sync;
    const p = entryProblems(t, e, tables, database, sync);
    const clash = clashes.filter((c) => c.entry === e).map((c) => c.problem);
    problems.push(...p);
    if (p.length || clash.length || t === undefined) { refused.push({ entry: e, problems: [...clash, ...p] }); continue; }
    const keep = new Set(copiedColumns(t, e));
    const at = `${shownPath(root, src.file)}: tables.${e.name}`;
    out.push({ ...t, columns: t.columns.filter((c) => keep.has(c.name)), foreignKeys: t.foreignKeys.filter((f) => keep.has(f.column)),
      ...(e.key !== null ? { key: e.key, primaryKey: t.key } : {}), sync, entryAt: at,
      // its entry's words, for the line a hold for its columns says (src/duck/column-identity.ts)
      entry: { at, name: e.name, columns: e.columns, exclude: e.exclude } });
  }
  return { tables: out, refused, problems };
}

/**
 * THE `columns:` THAT FOLLOWS A RENAME ON THE DATABASE, or null: each name of the entry's `columns:` the table lacks
 * taken as the column it is close to (`closest`), a name no column is close to left out (it was dropped: `goneColumns`).
 * Offered only when it differs and the entry would then pass (`entryProblems`). A rename is a guess from the name, so
 * the line is the person's to write: the run never takes it by itself (fail closed).
 */
export function renamedColumns(t: SourceTable | undefined, e: TableEntry, all: readonly SourceTable[], database: string, sync: TableSync): string[] | null {
  if (t === undefined || e.columns === null) return null;
  const have = t.columns.map((c) => c.name);
  const cols: string[] = [];
  for (const c of e.columns) {
    const now = have.includes(c) ? c : closest(c, have);
    if (now !== null && !cols.includes(now)) cols.push(now);
  }
  if (cols.length === 0 || cols.join("\u0000") === e.columns.join("\u0000")) return null;
  return entryProblems(t, { ...e, columns: cols }, all, database, sync).length ? null : cols;
}

/**
 * WHAT THE RUN SAYS OF AN ENTRY IT CANNOT TAKE (issue 1074), one sentence each for the log, the table's line and the
 * run's warnings: what is wrong at its keys (`problems`), whether the table is HELD (`held`: synced before, so it serves
 * what it holds and is not synced) or not synced at all (new to the run), and the way out. `renamed`: the `columns:`
 * that follows a rename (`renamedColumns`). In a project deployed read-only the committed file is the way (`readOnly`):
 * `mason add` is refused there, and the run takes the file at a start.
 */
export function refusedEntryText(o: { entry: TableEntry; problems: readonly string[]; shown: string; held: boolean; readOnly: boolean; renamed: readonly string[] | null }): string {
  const { entry: e, renamed } = o;
  const what = o.problems.map((p) => `${o.shown}: ${p}`).join("; ");
  const head = `${e.table} is not synced: ${what}${/[.?!]$/.test(what) ? "" : "."} ` +
    (o.held ? "Mason holds the table and serves its synced data as it was." : "Mason syncs it once its entry is fixed.");
  const fix = renamed === null ? "Fix its entry" : `To sync its columns as the database names them now, write columns: ${flowList(renamed)} on tables.${e.name}`;
  if (o.readOnly) return `${head} ${fix} in the committed sources file, and start Mason with it.`;
  const add = `mason add ${e.name} --columns ${renamed === null ? "…" : renamed.join(",")}${e.key !== null ? ` --key ${e.key.join(",")}` : ""}`;
  return `${head} ${fix}, then run mason stop && mason start. Or run ${add} while Mason runs, which takes it at once.`;
}

/** What the run copies: the sources file as it last read it, its tables, and what is wrong with the file now (null:
 *  nothing). `refused`: the entries it could not take (issue 1074), each said (`refusedEntryText`); a `held` one's
 *  table is among `tables` as the run took it before, and the sync holds it (src/duck/sync.ts `setTables`). */
export interface RunSources { file: SourceFile; tables: AddedTable[]; problem: string | null; refused?: readonly EntryRefusal[] }

/** An entry the run could not take: its table, whether it is held (synced before), and what the run says of it. */
export interface EntryRefusal { table: string; held: boolean; text: string }

/**
 * THE SOURCES FILE READ AGAIN WHILE THE RUN IS UP (mason add, mason remove, a table's columns changed): its tables now —
 * or, when the FILE cannot be taken as it is, the tables read before, kept (a typo never drops a copy), with what is
 * wrong; `said` is the log line, once per new problem. A `url:` that resolves to another database than the one the run
 * copies (a .env edited) is such a problem: the run's catalog is the old database's, so it is said, and mason stop &&
 * mason start reads the new one. So is a file gone silent on sync: while `slot` is recorded: taken, it would retire the
 * slot. AN ENTRY the catalog refuses is that entry's alone (issue 1074): every other entry is taken as it is now, and
 * that table is HELD as the run took it before (`refused`, `held`), or not synced when the run never took it. Its
 * columns are never taken by a guess: a rename under `columns:` is synced once the file says the new name (fail closed).
 */
export function rereadSources(prev: RunSources, read: ProjectSource | Failure, runUrl: string, catalog: readonly SourceTable[], database: string, root: string,
  o: { replicationChecked?: boolean; slot?: string | null; readOnly?: boolean } = {}): RunSources & { said: string | null } {
  let problem: string | null = null;
  if ("message" in read) problem = `${read.message}${read.why ? `: ${read.why.replace(/\n/g, "; ")}` : ""}`;
  else if (read.resolved !== runUrl) {
    problem = `${shownPath(root, read.file)}: url: now names ${maskedUrl(read.resolved)} (${read.from}), and this run syncs ${maskedUrl(runUrl)}: mason stop && mason start syncs from the new one`;
  } else if (silentOverSlot((o.slot ?? null) !== null, read)) {
    problem = `${shownPath(root, read.file)}: no sync: at its top or on an entry, and this project streams through replication slot ${o.slot}: ` +
      "write sync: replication at its top to keep streaming, or sync: off or sync: poll <interval> to drop the slot";
  } else if (o.replicationChecked === false && replicatedEntries(read).length > 0) {
    // a table set to replication in a run that never checked the database for it (the commands' edits are checked, the
    // run server's checkReplication): kept as it was, never frozen by a slot the database cannot make
    const names = replicatedEntries(read).map((e) => entryName(e.table));
    problem = `${shownPath(root, read.file)}: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} sync: replication, and this run has not checked ${database} for logical replication ` +
      "(no table was replicated when it started): mason stop && mason start checks it and streams them";
  } else {
    const e = entryTables(read, catalog, database, root);
    const taken = new Map(e.tables.map((t) => [t.source, t]));
    const shown = shownPath(root, read.file);
    const tables: AddedTable[] = [];
    const refused: EntryRefusal[] = [];
    for (const entry of read.tables) {
      const t = taken.get(entry.table);
      if (t !== undefined) { tables.push(t); continue; }
      const r = e.refused.find((x) => x.entry === entry);
      if (r === undefined) continue;
      // HELD as the run took it: it serves what it holds, and is synced again once its entry is fixed
      const before = prev.tables.find((x) => x.source === entry.table);
      if (before !== undefined) tables.push(before);
      const now = catalog.find((x) => x.source === entry.table);
      const renamed = renamedColumns(now, entry, catalog, database, effectiveSync(read, entry).sync);
      refused.push({ table: entry.table, held: before !== undefined,
        text: refusedEntryText({ entry, problems: r.problems, shown, held: before !== undefined, readOnly: o.readOnly === true, renamed }) });
    }
    return { file: read, tables, problem: null, refused, said: null };
  }
  return { ...prev, problem, said: problem !== prev.problem ? `the sources file cannot be read as it is now, so the tables read before are kept: ${problem}` : null };
}

// ------------------------------------------------------------------ the columns mason add asks for

/**
 * A COLUMN THAT LOOKS LIKE A SECRET is left out of every-column adds unless named (an agent's every-column
 * add put a table's `password`, `deploy_key_content` and `warehouse_private_key` into a copy anyone with a user's
 * password can query, with no warning). By name alone — the database says nothing about a column's sensitivity — so the
 * words are credentials' own, and a suffix that names an identifier or a time (`token_id`, `secret_count`) is not one.
 * A name's words are read however it is written (issue 797: an ORM's `passwordHash`, `apiKey`, `API_TOKEN` were synced
 * unflagged): split at `_`, `-` or any other character but a letter or digit, and where a lowercase letter or digit
 * meets an uppercase one or an acronym ends (`APIKey` → api, key; `tokenIDs` → token, ids), then compared in lowercase.
 * This one function decides it: `mason add`'s `exclude:`, `mason tables`' note and its `--json` `secret` read it.
 */
const SECRET_WORD = new Set(["password", "passwd", "pwd", "secret", "secrets", "token", "tokens", "apikey", "credential", "credentials", "salt"]);
/** two words in a row that name a secret: `api_key`, `apiKey`, `API_KEY` */
const SECRET_PAIR = new Set(["api key", "access key", "secret key", "private key", "ssh key"]);
/** a last word (or the last two) naming an identifier, a count or a time: `token_id`, `secretCount`, `salt_hash_algo` —
 *  at the name's very end, so `token_id_` stays one (fail closed, as before issue 797) */
const NOT_SECRET_LAST = new Set(["id", "ids", "at", "count", "type", "name", "kind"]);
/** a column name's words, lowercase: an acronym (a trailing `s` its plural), a word with its first letter capital or not, or digits */
export function nameWords(column: string): string[] {
  return (column.match(/[A-Z]{2,}s?(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z0-9]+/g) ?? []).map((w) => w.toLowerCase());
}
export function looksSecret(column: string): boolean {
  const w = nameWords(column);
  const n = w.length;
  const secret = w.some((x, i) => SECRET_WORD.has(x) || (i > 0 && SECRET_PAIR.has(`${w[i - 1]} ${x}`))) ||
    (n >= 2 && w[n - 2] === "key" && w[n - 1] === "content" && (n >= 3 || !/^key/i.test(column)));  // something before it: `deploy_key_content`, never `key_content`
  const exempt = n >= 2 && /[A-Za-z0-9]$/.test(column) && (NOT_SECRET_LAST.has(w[n - 1]!) || (n >= 3 && w[n - 2] === "hash" && w[n - 1] === "algo"));
  return secret && !exempt;
}

/**
 * The entry `mason add` writes for the columns asked: a list (`--columns`) is `columns:`, the key added when left out
 * (`addedKey`); `*` is every column — `{}`, or `exclude:` naming the secret-looking columns it left out (`skipped`)
 * unless `--include` names them beside it (`["*", "password"]`). A column the table lacks is refused with its columns.
 * `key` is `--key`'s: the columns a table with no primary key is copied by.
 */
export function chooseColumns(t: SourceTable, asked: readonly string[], key: readonly string[] | null = null):
  { columns: string[] | null; exclude: string[]; addedKey: string[]; skipped: string[] } | { problem: string } {
  if (asked.length === 0) return { problem: `name ${t.source}'s columns: mason add ${entryName(t.source)} --columns id,status,… — or leave --columns out for every one` };
  const have = t.columns.map((c) => c.name);
  const named = asked.filter((c) => c !== "*");
  const unknown = [...named, ...(key ?? [])].filter((c) => !have.includes(c));
  if (unknown.length) {
    return { problem: `${t.source} has no column ${unknown.map((c) => JSON.stringify(c)).join(", ")}${didYouMean(unknown[0]!, have)}; its columns: ${have.join(", ")}` };
  }
  const keyCols = key ?? t.key;
  if (asked.includes("*")) {
    const skipped = have.filter((c) => looksSecret(c) && !keyCols.includes(c) && !named.includes(c));
    return { columns: null, exclude: skipped, addedKey: [], skipped };
  }
  // the key columns are written into the list, first: the file says every column the copy holds
  const addedKey = keyCols.filter((k) => !named.includes(k));
  return { columns: [...new Set([...addedKey, ...named])], exclude: [], addedKey, skipped: [] };
}

/** What the run leaves out of an every-column entry as the database changes under it (`leftOutArrivals`): the columns
 *  it leaves out, and the names of `exclude:` gone from the table that they take the place of. */
export interface LeftOut { entry: TableEntry; columns: string[]; gone: string[]; back?: string[] }

/**
 * WHAT ARRIVED ON THE DATABASE WHILE THE RUN WAS UP, AND IS LEFT OUT (issue 977), of each entry that syncs every column
 * (no `columns:`), against `before`, the columns each table had when the run's tables were last set:
 * - a column that arrived and looks like a secret (`looksSecret`) is left out, as `mason add` leaves it out (a column
 *   added on the database was synced as soon as the run read it, `api_token` too);
 * - a name of `exclude:` that was there and is gone: FAIL CLOSED. A rename is a name gone and one arrived at once (a
 *   salary renamed annual_pay was served), so EVERY column that arrived with it is left out, in its place, until the
 *   person says otherwise (`mason add <table> --include …`); gone with nothing arrived, it was dropped, and is taken out.
 * A key column is never left out. `edited` are the tables an edit just wrote their columns of (`mason add`, `mason
 * remove`): their entry is the person's choice, read as it is (`mason add <table> --include api_token` syncs it). A
 * table `before` has no columns for is new to the run.
 */
export function leftOutArrivals(file: Pick<SourceFile, "tables">, tables: readonly SourceTable[], before: ReadonlyMap<string, readonly string[]>,
  edited: readonly string[] = []): LeftOut[] {
  const out: LeftOut[] = [];
  for (const e of file.tables) {
    if (e.columns !== null || edited.includes(e.table)) continue;
    const t = tables.find((x) => x.source === e.table), was = before.get(e.table);
    if (t === undefined || was === undefined) continue;
    const key = e.key ?? t.key, have = t.columns.map((c) => c.name);
    const gone = e.exclude.filter((c) => !have.includes(c) && was.includes(c));
    const arrived = have.filter((c) => !was.includes(c) && !key.includes(c) && !e.exclude.includes(c));
    const columns = gone.length ? arrived : arrived.filter(looksSecret);
    if (columns.length || gone.length) out.push({ entry: e, columns, gone });
  }
  return out;
}

/** An entry's `exclude:` once `a` is left out: its gone names taken out, the columns left out added. */
export const excludeOf = (a: LeftOut): string[] => [...a.entry.exclude.filter((c) => !a.gone.includes(c)), ...a.columns];

/** What the run says of what it left out (`leftOutArrivals`): `written`, the sources file it wrote `exclude:` in, or
 *  null when it could not write it (`why`; the line to write, and what a start does without it: `refused`, whether the
 *  file as it is names a column the table lacks — by default, whether a name went now). One sentence each for the log,
 *  the event and `mason status`. */
export function leftOutText(a: LeftOut, written: string | null, why: string | null = null, refused: boolean = a.gone.length > 0): string {
  const cols = a.columns, one = cols.length === 1, name = entryName(a.entry.table);
  const they = one ? "it" : "they", is = one ? "is" : "are";
  const gone = a.gone.join(", "), goneOne = a.gone.length === 1;
  const back = a.back ?? [], backOne = back.length === 1;
  const head = back.length
    ? `${a.entry.table}: ${back.join(", ")}, which exclude: names, ${backOne ? "is" : "are"} back on the database, so ${backOne ? "it is" : "they are"} not synced`
    : a.gone.length === 0
    ? `${a.entry.table}: the new column${one ? "" : "s"} ${cols.join(", ")} ${one ? "looks" : "look"} like ${one ? "a secret" : "secrets"}, so ${they} ${is} not synced`
    : cols.length === 0
      ? `${a.entry.table}: ${gone}, which exclude: names, ${goneOne ? "is" : "are"} gone from the database`
      : `${a.entry.table}: ${gone}, which exclude: names, ${goneOne ? "is" : "are"} gone from the database, and ${cols.join(", ")} arrived at the same time ` +
        `(a rename keeps its data), so ${they} ${is} not synced either`;
  const opt = cols.length ? `. To sync ${one ? "it" : "one"}, run mason add ${name} --include ${cols[0]}` : "";
  const w = writeLine(a.entry, excludeOf(a));
  if (written !== null) return `${head}. Mason ${w.wrote} in ${written}${opt}`;
  return `${head}, in this run${why ? ` (${why})` : ""}. ${w.ask} in the sources file: ` +
    (refused ? "a start refuses the file until then" : `a start syncs what the file says`);
}

/**
 * The line that writes an every-column entry's `exclude:` as the file must say it, as the writer writes it
 * (`entryText`): the list when it names a column; else the entry `name: {}` when nothing else is on it, or the key taken
 * out (a start refuses `exclude: []`: the review of PR 1065). `ask` for a person, `wrote` for what Mason wrote.
 */
export function writeLine(e: Pick<TableEntry, "name" | "columns" | "key" | "sync">, exclude: readonly string[]): { ask: string; wrote: string } {
  if (exclude.length) { const l = `exclude: ${flowList(exclude)}`; return { ask: `Write ${l} on its entry`, wrote: `wrote ${l} on its entry` }; }
  const text = entryText({ ...e, columns: null, exclude: [] }, "").trimEnd();
  if (!text.includes("\n")) return { ask: `Write ${text} as its entry`, wrote: `wrote ${text} as its entry` };
  return { ask: "Take exclude: out of its entry", wrote: "took exclude: out of its entry" };
}

/**
 * WHAT THE RUN LEAVES OUT OF ONE ENTRY WHERE IT COULD NOT WRITE THE SOURCES FILE (`leftOutArrivals`; its files read-only
 * here): `left`, the columns it left out, and `gone`, the names of the file's `exclude:` it took out as gone from the
 * table. ONE NET RECORD, folded by `keepLeftOut` and applied by `withLeftOut` (issue 1026: two lists that only grew were
 * applied after the arrivals were found against the file alone, so a second rename of an excluded column found nothing,
 * and its first new name, gone, refused the file, and every column change of every table after it, for the run).
 */
export interface KeptOut { left: string[]; gone: string[] }

/**
 * The file with each every-column entry's `exclude:` as the run takes it where it could not write it (`kept`, by
 * table), against the tables as they are now: the file's names it took out as gone are taken out while the table lacks
 * them — a column of that name back on the table is left out again, as the file says (fail closed) — and the columns
 * it left out are added. `leftOutArrivals` is asked of THIS file, never the file alone, so each round starts from what
 * the run leaves out now.
 */
export function withLeftOut<F extends Pick<SourceFile, "tables">>(file: F, kept: ReadonlyMap<string, KeptOut>, tables: readonly SourceTable[]): F {
  if (kept.size === 0) return file;
  return { ...file, tables: file.tables.map((e) => {
    const k = kept.get(e.table);
    if (e.columns !== null || k === undefined) return e;
    const have = tables.find((t) => t.source === e.table)?.columns.map((c) => c.name) ?? [];
    const exclude = e.exclude.filter((c) => !k.gone.includes(c) || have.includes(c));
    const add = k.left.filter((c) => !exclude.includes(c));
    return add.length || exclude.length !== e.exclude.length ? { ...e, exclude: [...exclude, ...add] } : e;
  }) };
}

/**
 * Folds what the run just left out of an entry (`a`, found against `withLeftOut`'s file) into `kept`, where it could
 * not write it: a name gone is no longer left out and is taken out of the file's names, and each column that arrived
 * in its place is left out. Asked again with the same arrivals, it changes nothing.
 */
export function keepLeftOut(kept: Map<string, KeptOut>, a: LeftOut): void {
  const k = kept.get(a.entry.table) ?? { left: [], gone: [] }, back = a.back ?? [];
  const left = [...k.left.filter((c) => !a.gone.includes(c)), ...a.columns.filter((c) => !k.left.includes(c))];
  const gone = [...k.gone.filter((c) => !back.includes(c)), ...a.gone.filter((c) => !k.gone.includes(c))];
  kept.set(a.entry.table, { left, gone });
}

/**
 * WHAT A RUN HAS SEEN OF ITS TABLES' COLUMNS, AND WHAT IT LEFT OUT WHERE IT COULD NOT WRITE THE SOURCES FILE: one record,
 * so the two never part (the review of PR 1065: the left-out record was folded at a look whose re-read was then refused,
 * while the columns the arrivals were found against moved only at a re-read taken, so a second rename was never seen as
 * the first new name gone, and the file as the run took it named that name for the run). `look` finds what arrived
 * since the last look, against the file AS THE RUN TAKES IT (`taken`), and the columns it looked at are the next look's
 * at once, whatever the re-read decides; the caller then keeps each arrival (`keep`) or writes it in the file (`written`).
 * A file that cannot be read is no look: what arrives meanwhile is still new at the next.
 */
export class LeftOutRecord {
  private readonly kept = new Map<string, KeptOut>();
  private before: Map<string, string[]>;
  constructor(tables: readonly SourceTable[]) { this.before = LeftOutRecord.columnsOf(tables); }
  private static columnsOf(tables: readonly SourceTable[]): Map<string, string[]> { return new Map(tables.map((t) => [t.source, t.columns.map((c) => c.name)])); }
  /** The file with what the run keeps out (`withLeftOut`). */
  taken<F extends Pick<SourceFile, "tables">>(file: F, tables: readonly SourceTable[]): F { return withLeftOut(file, this.kept, tables); }
  /** What arrived since the last look and is left out (`keptBack`, `leftOutArrivals`), each of the file as the run takes it. */
  look(file: Pick<SourceFile, "tables">, tables: readonly SourceTable[], edited: readonly string[] = []): LeftOut[] {
    const taken = this.taken(file, tables);
    const arrived = [...keptBack(taken, this.kept, tables), ...leftOutArrivals(taken, tables, this.before, edited)];
    this.before = LeftOutRecord.columnsOf(tables);
    return arrived;
  }
  /** An arrival left out for this run (`keepLeftOut`). */
  keep(a: LeftOut): void { keepLeftOut(this.kept, a); }
  /** A table whose whole `exclude:` the file now says: nothing kept for it. */
  written(table: string): void { this.kept.delete(table); }
}

/**
 * The names of an entry's `exclude:` the run took out as gone (`KeptOut.gone`) that its table has again: left out
 * again, as the file says (`withLeftOut`), and said with the line to write now — the line said when they went omits
 * them, and written, it would sync the column back at the next start. One per entry, found against `withLeftOut`'s file.
 */
export function keptBack(file: Pick<SourceFile, "tables">, kept: ReadonlyMap<string, KeptOut>, tables: readonly SourceTable[]): LeftOut[] {
  const out: LeftOut[] = [];
  for (const e of file.tables) {
    const k = kept.get(e.table), t = tables.find((x) => x.source === e.table);
    if (e.columns !== null || k === undefined || t === undefined) continue;
    const back = k.gone.filter((c) => e.exclude.includes(c) && t.columns.some((x) => x.name === c));
    if (back.length) out.push({ entry: e, columns: [], gone: [], back });
  }
  return out;
}

/**
 * THE COLUMNS EVERY COLUMN LEAVES OUT of `t` (`mason add <table>` with no `--columns`: the secret-looking ones, `skipped`),
 * against the key it is synced by — its primary key, else `key` (an entry's `key:`). FAIL CLOSED: a key the file gets
 * wrong (a column the table lacks, a key: beside a primary key) never un-flags a column — the rule is then asked against
 * the table's own key alone, which every column passes. One rule for `mason tables --json`'s `secret` (src/cli/source-edit.ts
 * `listTables`) and the run's state (`everyColumnLeavesOut`, src/cli/run-server.ts), which the web page's column form reads.
 */
export function everyColumnLeavesOut(t: SourceTable, key: readonly string[] | null): string[] {
  const asked = chooseColumns(t, ["*"], t.key.length ? null : key);
  const chosen = "problem" in asked ? chooseColumns(t, ["*"], null) : asked;
  return "problem" in chosen ? t.columns.map((c) => c.name).filter(looksSecret) : chosen.skipped;
}

// ------------------------------------------------------------------ editing the file (mason add, mason remove)

/** A name as YAML writes it: plain when it is an identifier YAML reads as a string, else quoted. */
const yamlName = (n: string): string => /^[A-Za-z_][A-Za-z0-9_$.]*$/.test(n) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(n) ? n : JSON.stringify(n);
const flowList = (xs: readonly string[]): string => `[${xs.map(yamlName).join(", ")}]`;

/** An entry as `mason add` writes it: its columns, key and its own sync (none: it follows the file's) */
export type WrittenEntry = Pick<TableEntry, "name" | "table" | "columns" | "exclude" | "key"> & { sync?: TableSync | null };

/** An entry's value as the sources file holds it, under its name in `tables:` — `{}`, or the keys it writes (`columns`,
 *  `exclude`, `key`, `sync`) — the ONE place an entry's keys are chosen: `entryText` writes them, and `mason tables --json`
 *  gives them as data (src/cli/source-edit.ts `listTables`). */
export type EntryFields = { columns?: string[]; exclude?: string[]; key?: string[]; sync?: string };
export function entryFields(e: Pick<WrittenEntry, "columns" | "exclude" | "key" | "sync">): EntryFields {
  return {
    ...(e.columns !== null ? { columns: [...e.columns] } : e.exclude.length ? { exclude: [...e.exclude] } : {}),
    ...(e.key !== null ? { key: [...e.key] } : {}),
    ...(e.sync ? { sync: syncText(e.sync) } : {}),
  };
}

/** An entry's lines at `indent`: `name: {}` on one line, else its keys a line each under it (`entryFields`). */
export function entryText(e: Omit<WrittenEntry, "table">, indent: string): string {
  const body = Object.entries(entryFields(e)).map(([k, v]) => `${k}: ${typeof v === "string" ? v : flowList(v)}`);
  if (!body.length) return `${indent}${yamlName(e.name)}: {}\n`;
  return `${indent}${yamlName(e.name)}:\n${body.map((b) => `${indent}  ${b}\n`).join("")}`;
}

type Ranged = { range?: [number, number, number] | null };
const FLOW_MAP = "its tables: is written as a { … } map with entries: write it one table per line to have mason add and mason remove edit it";

/** The file parsed for an edit: its `tables:` pair (null when it has none), and the line helpers over its text. */
function forEdit(text: string): { pair: Pair | null; lineStart: (at: number) => number; lineEnd: (at: number) => number } | { problem: string } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { problem: `it is not YAML (${doc.errors[0]!.message.split("\n")[0]})` };
  if (!isMap(doc.contents)) return { problem: "it is not a mapping" };
  const pair = (doc.contents as YAMLMap).items.find((p) => isScalar(p.key) && p.key.value === "tables") ?? null;
  return {
    pair: pair as Pair | null,
    lineStart: (at) => text.lastIndexOf("\n", at - 1) + 1,
    lineEnd: (at) => { if (at > 0 && text[at - 1] === "\n") return at; const n = text.indexOf("\n", at); return n < 0 ? text.length : n + 1; },
  };
}

/** The table entries of a block `tables:` map, with the table each names. */
function entryPairs(map: YAMLMap): Array<{ pair: Pair; table: string; name: string }> {
  return map.items.filter((p) => isScalar(p.key)).map((p) => {
    const name = String((p.key as { value: unknown }).value);
    return { pair: p as Pair, table: sourceOf(name), name };
  });
}

/**
 * The file with `e` as its entry for `e.table` — after the last entry, or in place of the one naming that table (under
 * that one's own name) — and every other byte as it was: spliced into the text at the `tables:` map's own positions
 * (the `yaml` package's node ranges), never re-serialised, so a person's comments, quoting and layout stay theirs. A
 * reason instead when the map cannot be spliced (a `{ … }` flow map with entries, a file that does not parse).
 */
export function withTable(text: string, e: WrittenEntry): { text: string } | { problem: string } {
  return inOwnLineEndings(text, (t) => withTableLf(t, e));
}

/**
 * An edit of a file written with CRLF line endings (a Windows editor's) made in LF and written back in CRLF, so the lines
 * it adds end as the file's do; a file of LF, or of both, is edited as it is.
 */
function inOwnLineEndings<R extends { text: string } | { problem: string } | null>(text: string, edit: (lf: string) => R): R {
  const crlf = text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
  if (!crlf) return edit(text);
  const r = edit(text.replace(/\r\n/g, "\n"));
  return (r !== null && "text" in r ? { ...r, text: r.text.replace(/\n/g, "\r\n") } : r) as R;
}

function withTableLf(text: string, e: WrittenEntry): { text: string } | { problem: string } {
  const r = forEdit(text);
  if ("problem" in r) return r;
  const { pair, lineStart, lineEnd } = r;
  if (pair === null) return { text: `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}tables:\n${entryText(e, "  ")}` };
  const key = pair.key as Ranged;
  const value = pair.value as (Ranged & ({ value?: unknown } | YAMLMap)) | null;
  const emptyMap = isMap(value) && value.items.length === 0;
  if (value === null || (isScalar(value) && (value.value === null || value.value === undefined)) || emptyMap) {
    // `tables:`, `tables: ~` or `tables: {}`: the empty value cut from its line (a comment after it stays), the entry under it
    const end = lineEnd(key.range![1]);
    const v = value?.range;
    const line = v && v[1] > v[0] && v[0] < end
      ? `${text.slice(lineStart(key.range![0]), v[0]).replace(/[ \t]+$/, "")}${text.slice(v[1], end).trim() ? text.slice(v[1], end) : "\n"}`
      : text.slice(lineStart(key.range![0]), end);
    return { text: `${text.slice(0, lineStart(key.range![0]))}${line.endsWith("\n") ? line : `${line}\n`}${entryText(e, "  ")}${text.slice(end)}` };
  }
  if (!isMap(value)) return { problem: "its tables: is not one entry per table" };
  if (value.flow) return { problem: FLOW_MAP };
  const entries = entryPairs(value);
  const first = entries[0]!.pair.key as Ranged;
  const indent = text.slice(lineStart(first.range![0]), first.range![0]);
  const same = entries.find((x) => x.table === e.table);
  if (same) {
    const k = same.pair.key as Ranged, v = same.pair.value as Ranged | null;
    const to = lineEnd(v?.range ? v.range[1] : k.range![1]);
    return { text: `${text.slice(0, lineStart(k.range![0]))}${entryText({ ...e, name: same.name }, indent)}${text.slice(to)}` };
  }
  const last = entries[entries.length - 1]!.pair;
  const lv = last.value as Ranged | null;
  const at = lineEnd(lv?.range ? lv.range[1] : (last.key as Ranged).range![1]);
  return { text: `${text.slice(0, at)}${at > 0 && text[at - 1] !== "\n" ? "\n" : ""}${entryText(e, indent)}${text.slice(at)}` };
}

/**
 * The file with ONE entry's own `sync:` set (`sync`), or taken out (null: it follows the file's again), and every other
 * byte as it was — the entry's columns, key and comments too (`mason add orders --sync "poll 30s"` on a table already
 * added): the value spliced at its node's range, a line of its own under the entry's last key at its keys' indent, or —
 * an entry written as a flow map (`{}`, `{ columns: [...] }`) — the entry written again a key a line, a comment after it
 * on the key's line kept. `e` is the entry as the file reads (its columns and key, for a flow map written again).
 */
export function withEntrySync(text: string, e: Pick<TableEntry, "name" | "table" | "columns" | "exclude" | "key">, sync: TableSync | null): { text: string } | { problem: string } {
  return inOwnLineEndings(text, (t) => withEntrySyncLf(t, e, sync));
}

function withEntrySyncLf(text: string, e: Pick<TableEntry, "name" | "table" | "columns" | "exclude" | "key">, sync: TableSync | null): { text: string } | { problem: string } {
  const r = forEdit(text);
  if ("problem" in r) return r;
  const { pair, lineStart, lineEnd } = r;
  const map = pair?.value;
  if (!isMap(map)) return withTableLf(text, { ...e, sync });
  if ((map as YAMLMap).flow) return { problem: FLOW_MAP };
  const same = entryPairs(map as YAMLMap).find((x) => x.table === e.table);
  if (same === undefined) return withTableLf(text, { ...e, sync });
  const value = same.pair.value as (Ranged & YAMLMap) | null;
  if (isMap(value) && !value.flow && value.items.length > 0) {
    const own = value.items.find((p) => isScalar(p.key) && p.key.value === "sync");
    if (own !== undefined) {
      const k = own.key as Ranged, v = own.value as Ranged | null;
      // its line cut, unless it is the entry's only key: then the entry is `{}` again
      if (sync === null && value.items.length === 1) return withTableLf(text, { ...e, name: same.name, sync: null });
      if (sync === null) return { text: `${text.slice(0, lineStart(k.range![0]))}${text.slice(lineEnd(v?.range ? v.range[1] : k.range![1]))}` };
      if (!v?.range) return { problem: `its ${e.name}.sync: has no value to replace` };
      return { text: `${text.slice(0, v.range[0])}${syncText(sync)}${text.slice(v.range[1])}` };
    }
    if (sync === null) return { text };
    const first = value.items[0]!.key as Ranged;
    const indent = text.slice(lineStart(first.range![0]), first.range![0]);
    const last = value.items[value.items.length - 1]!;
    const lv = last.value as Ranged | null;
    const at = lineEnd(lv?.range ? lv.range[1] : (last.key as Ranged).range![1]);
    return { text: `${text.slice(0, at)}${at > 0 && text[at - 1] !== "\n" ? "\n" : ""}${indent}sync: ${syncText(sync)}\n${text.slice(at)}` };
  }
  if (sync === null) return { text };
  // a flow map (`orders: {}`, `orders: { columns: [id] }`) or nothing: the entry written again, a comment on its line kept
  const k = same.pair.key as Ranged, v = value as Ranged | null;
  // an entry with no value (`orders:   # c`) has an empty scalar placed AT its comment: the comment is read from the key
  const after = v?.range && v.range[1] > v.range[0] ? v.range[1] : k.range![1];
  const end = lineEnd(after);
  const comment = /(\s+#.*)$/.exec(text.slice(after, end).replace(/\n$/, ""))?.[1] ?? "";
  const indent = text.slice(lineStart(k.range![0]), k.range![0]);
  const lines = entryText({ ...e, name: same.name, sync }, indent).split("\n");
  lines[0] = `${lines[0]}${comment}`;
  return { text: `${text.slice(0, lineStart(k.range![0]))}${lines.join("\n")}${text.slice(end)}` };
}

/**
 * The file without its entry for `table`: its lines cut, every other byte as it was; the last entry gone leaves
 * `tables: {}`. Null when no entry names that table.
 */
export function withoutTable(text: string, table: string): { text: string } | { problem: string } | null {
  return inOwnLineEndings(text, (t) => withoutTableLf(t, table));
}

function withoutTableLf(text: string, table: string): { text: string } | { problem: string } | null {
  const r = forEdit(text);
  if ("problem" in r) return r;
  const { pair, lineStart, lineEnd } = r;
  if (pair === null || !isMap(pair.value)) return null;
  const map = pair.value as YAMLMap;
  const entries = entryPairs(map);
  const gone = entries.find((x) => x.table === table);
  if (!gone) return null;
  if (map.flow) return { problem: FLOW_MAP };
  const k = gone.pair.key as Ranged, v = gone.pair.value as Ranged | null;
  let out = `${text.slice(0, lineStart(k.range![0]))}${text.slice(lineEnd(v?.range ? v.range[1] : k.range![1]))}`;
  if (entries.length === 1) {
    // the last one: `tables: {}`, a comment after the key kept on its line
    const colon = text.indexOf(":", (pair.key as Ranged).range![1]);
    out = `${out.slice(0, colon + 1)} {}${out.slice(colon + 1)}`;
  }
  return { text: out };
}

/** The entry naming a table — by its key, or by schema.table — or why there is none, with the closest name; `usage` when
 *  the name is none a table can have (tableNameProblem). */
export function findEntry(src: SourceFile, name: string): TableEntry | { problem: string; usage?: true } {
  const malformed = tableNameProblem(name, src.tables.map((e) => e.table));
  if (malformed !== null) return { problem: malformed, usage: true };
  const hit = src.tables.find((e) => e.name === name || e.table === name || e.table === sourceOf(name));
  if (hit) return hit;
  const names = src.tables.map((e) => e.name);
  const near = closest(name, [...names, ...src.tables.map((e) => e.table)]);
  return { problem: `${path.basename(src.file)} names no table ${name}${near ? ` — did you mean \`${near}\`?` : ""}${names.length ? ` (it names ${names.join(", ")})` : " (it names none yet)"}` };
}

// ------------------------------------------------------------------ a table as the commands say it

/** A column of a table as the commands say it: its type, whether it may be NULL, its COMMENT, what its foreign key reads. */
export interface CatalogColumn { name: string; type: string; nullable: boolean; comment: string | null; references: { table: string; column: string } | null }
/** A table of the database as the commands say it: the catalog's facts and the sources file's, nothing of a run's. */
export interface CatalogTable {
  /** `schema.table` */
  table: string; rows: number | null; bytes: number;
  /** its primary key's columns (none: it has none) */
  key: string[]; comment: string | null; columns: CatalogColumn[];
  /** why `mason add <table>` alone cannot add it (no primary key: --key names the columns), or null */
  reason: string | null;
  /** whether the sources file names it */
  added: boolean;
  /** the columns its copy keeps, as the sources file says (null: not added) */
  addedColumns: string[] | null;
  /** the `key:` the sources file copies it by (null: its primary key, or not added) */
  copyKey: string[] | null;
  /** a table not added: about how many bytes its synced data would take on disk, every column, as estimated when the
   *  catalog was read (src/duck/disk-fit.ts); null for one added (its synced size is measured), or not estimated */
  estimateBytes: number | null;
}

/** The unique index a table with no primary key could be keyed by — its first over NOT NULL columns only — or undefined:
 *  the `--key` `unaddableReason` names, and the `key:` `mason tables --json` gives its entry (src/cli/source-edit.ts
 *  `listTables`). */
export function usableUniqueKey(t: SourceTable): { name: string; columns: string[] } | undefined {
  return (t.uniqueKeys ?? []).find((u) => u.columns.every((c) => t.columns.find((x) => x.name === c)?.notNull === true));
}

/**
 * Row-level security that hides every row of `t` from the user Mason reads as, said once — a SELECT answers no row and
 * no error, so its synced table would be empty — with the policy its owner adds; null when none hides it. An entry
 * (`entryProblems`) ends it with "or remove its entry"; a table not added (`unaddableReason`) with the `mason add` to
 * run once the policy is there.
 */
export function rowSecurityHides(t: SourceTable): string | null {
  if (t.rowSecurityHidesFrom === undefined) return null;
  return `row-level security on ${t.source} hides every row from ${t.rowSecurityHidesFrom} (no SELECT policy for it, and it is not the owner or BYPASSRLS), ` +
    `so its synced table would be empty — the table's owner adds a policy for the rows Mason may read (CREATE POLICY mason_read ON ${t.source} FOR SELECT TO ${pgIdent(t.rowSecurityHidesFrom)} USING (…);)`;
}

/**
 * WHY `mason add <t>` CANNOT ADD `t`, or null: ONE reason for a table not added, read by `mason tables` and the run's
 * state alike (`catalogTable`: the web page's Tables), and by `mason add`'s refusal (src/cli/source-edit.ts
 * `plannedEntry`), so the page never offers an Add the run then refuses (issue 802). Row-level security that hides
 * every row comes first, ending with the `mason add` to run once a policy is there (`key`: the `--key` asked; for a
 * table with no primary key and none asked, the one its unique index names); else no primary key, naming the `--key`.
 */
export function unaddableReason(t: SourceTable, key: readonly string[] | null = null): string | null {
  const unique = t.key.length ? undefined : usableUniqueKey(t);
  const hidden = rowSecurityHides(t);
  if (hidden !== null) {
    const then = key !== null ? ` --key ${key.join(",")}`
      : t.key.length ? ""
      : unique ? ` --key ${unique.columns.join(",")} (no primary key: its unique index ${unique.name} tells its rows apart)`
      : " --key <column>,… (no primary key: name the columns that tell its rows apart)";
    return `${hidden}, then mason add ${entryName(t.source)}${then}`;
  }
  const noKey = noKeyReason(t);
  if (noKey !== null) return noKey;
  // columns whose names differ only in case, as every column would add them (issue 1019)
  const every = chooseColumns(t, ["*"], key);
  return "problem" in every ? null : clashReason(t, every, key);
}

/** Why `mason add <t>` with no `--key` cannot add `t` for its key alone (no primary key: the `--key` to name), or null. */
export function noKeyReason(t: SourceTable): string | null {
  if (t.key.length) return null;
  const unique = usableUniqueKey(t);
  return `no primary key: name the columns that tell its rows apart, mason add ${entryName(t.source)} --key ${unique ? unique.columns.join(",") : "<column>,…"}${unique ? ` (its unique index ${unique.name})` : ""}`;
}

/**
 * A TABLE AS `mason tables` AND THE RUN'S STATE BOTH SAY IT (the hands-on review of #451, item 15: `mason tables` needed
 * Mason running, though all it says is the database's catalog and the project's files): ONE mapping from the catalog
 * (`t`) and the sources file's entry for it (`entry`; undefined: not added).
 */
export function catalogTable(t: SourceTable, entry: TableEntry | undefined): CatalogTable {
  return {
    table: t.source, rows: t.rows, bytes: t.bytes, key: t.key, comment: t.comment,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type, nullable: !c.notNull, comment: c.comment,
      references: ((f) => f ? { table: f.target, column: f.targetColumn } : null)(t.foreignKeys.find((f) => f.column === c.name)) })),
    reason: entry === undefined ? unaddableReason(t) : null,
    added: entry !== undefined, addedColumns: entry === undefined ? null : copiedColumns(t, entry), copyKey: entry?.key ?? null,
    estimateBytes: entry === undefined ? t.estimateBytes ?? null : null,
  };
}
