/**
 * THE PROJECT'S SOURCE (models meant nothing in the DuckDB version of Mason, so they gave way to a `sources` folder,
 * each file a source to sync naming the tables and columns it syncs). One file, `<folder>/sources/<name>.yml`, the
 * project's to commit:
 *
 *   kind: postgres
 *   url: ${DATABASE_URL}          an env var from .env.local, .env or the shell; a literal URL for local dev
 *   tables:
 *     orders:                     a bare name is in `public`; `billing.invoices` names its schema
 *       columns: [id, customer_id, status]
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
import { isMap, isScalar, parseDocument, type Pair, type YAMLMap } from "yaml";
import { appEnvValue, ENV_FILE } from "../lib/dotenv.ts";
import { closest, didYouMean } from "../lib/did-you-mean.ts";
import type { Failure, NextStep } from "./command.ts";
import { maskedUrl, type SourceTable } from "./preflight.ts";
import type { AddedTable } from "../duck/sync.ts";

export const SOURCES_DIR = "sources";
const KEYS = ["kind", "url", "tables"] as const;
const ENTRY_KEYS = ["columns", "exclude", "key"] as const;
const ENV_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

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
}

export interface SourceFile {
  /** the file's name without `.yml`: the source's name */
  name: string;
  /** the file, absolute */
  file: string;
  kind: "postgres";
  /** where the URL comes from: `${NAME}` (resolved by `readSource`) or the URL written in the file */
  url: { env: string } | { literal: string };
  tables: TableEntry[];
}

/** The file read and its URL resolved: what the run, `mason tables` and `mason doctor` connect with. */
export interface ProjectSource extends SourceFile {
  /** the database's URL, password included (never printed: maskedUrl) */
  resolved: string;
  /** where it was read: `DATABASE_URL in .env`, `DATABASE_URL in the shell`, or the file's own path */
  from: string;
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

/**
 * The file's text read as a source file: its shape, never the database (that is `addedTables`'s). `name` is the
 * source's (the file's name); the problems are each at their key, in the order they are in the file.
 */
export function parseSourceText(text: string, name: string, file: string): SourceFile | { problems: string[] } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { problems: [`it is not YAML: ${doc.errors[0]!.message.split("\n")[0]}`] };
  const v: unknown = doc.toJS();
  if (!isPlain(v)) return { problems: [`it is ${v === null || v === undefined ? "empty" : "not a mapping"}: a source file is kind: postgres, url: \${DATABASE_URL} and tables: {}`] };
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
    if (m) url = { env: m[1]! };
    else if (bare) problems.push(`url: $${bare[1]} — write \${${bare[1]}}: a variable is named in braces`);
    else if (v.url.includes("${")) problems.push(`url: ${JSON.stringify(v.url)} — write the URL whole, or \${NAME} alone: the whole URL in one variable, like \${DATABASE_URL}`);
    else url = { literal: v.url.trim() };
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
      if (raw !== null && !isPlain(raw)) { problems.push(`${at}: is {} (every column), { columns: [...] }, { exclude: [...] } or { key: [...] }`); continue; }
      const e = raw ?? {};
      const stray = Object.keys(e).filter((k) => !(ENTRY_KEYS as readonly string[]).includes(k));
      for (const k of stray) problems.push(`${at}: unexpected key ${k}${didYouMean(k, ENTRY_KEYS)} — a table takes columns, exclude and key`);
      const both = e.columns !== undefined && e.exclude !== undefined;
      if (both) problems.push(`${at}: columns and exclude together — columns names what is copied, exclude what is left out of every column; keep one`);
      const columns = e.columns === undefined ? null : nameList(e.columns, `${at}.columns`, "the columns copied");
      const exclude = e.exclude === undefined ? [] : nameList(e.exclude, `${at}.exclude`, "the columns left out");
      const ownKey = e.key === undefined ? null : nameList(e.key, `${at}.key`, "the columns that tell its rows apart");
      for (const x of [columns, exclude, ownKey]) if (typeof x === "string") problems.push(x);
      if (typeof columns === "string" || typeof exclude === "string" || typeof ownKey === "string" || stray.length || both) continue;
      tables.push({ name: key, table, columns, exclude, key: ownKey });
    }
  }
  if (problems.length || kind === null || url === null) return { problems };
  return { name, file, kind, url, tables };
}

/** Where a project's source files are: `<folder>/sources/`. */
export const sourcesDir = (folder: string): string => path.join(folder, SOURCES_DIR);

/** The names of the source files in `<folder>/sources/` (`.yml`, `.yaml`), sorted; [] when it has none. */
export function sourceFileNames(folder: string): string[] {
  const dir = sourcesDir(folder);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && !f.startsWith(".")).sort();
}

/** The file `mason init` writes: the database, then its tables (none yet). */
export function newSourceText(url = "${DATABASE_URL}"): string {
  return "# The database this project copies from, and which of its tables. Yours to commit; the URL stays out of it.\n" +
    "kind: postgres\n" +
    `url: ${url}${ENV_REF.test(url) ? "   # from .env.local, .env or the shell; a literal postgres:// URL works too" : ""}\n` +
    "\n" +
    "# One entry per table, a bare name in public, else schema.table: {} copies every column, columns: [id, status]\n" +
    "# those, exclude: [payload] every column but those; key: [a, b] names the columns that tell its rows apart, for a\n" +
    "# table with no primary key. mason add and mason remove edit this list; so can you.\n" +
    "tables: {}\n";
}

/** A source's name from its database's: the file is named for it, else `app`. */
export function sourceNameFor(database: string): string {
  const n = database.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "").slice(0, 48);
  return n || "app";
}

/** The folder an older Mason listed a project's tables in, one file per table: read by nothing, said by `readSource`. */
export const OLD_TABLES_DIR = "models";

/**
 * THE PROJECT'S SOURCE FILE, read: the one file in `sources/` (a second is refused by name: one source per project for
 * now), parsed, its URL resolved — `${NAME}` from the project's .env.local or .env, else the shell (src/lib/dotenv.ts
 * `appEnvValue`, the order `mason init` reads DATABASE_URL in, so the two cannot disagree); `shellFirst` for a server
 * (`mason serve`), configured by its environment alone. A project with no file is told what to write — one an older
 * Mason made (its tables listed in another folder, which nothing reads) that mason init writes it.
 */
export function readSource(folder: string, root: string, env: NodeJS.ProcessEnv = process.env, o: { shellFirst?: boolean } = {}): ProjectSource | Failure {
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
  if (names.length > 1) {
    return { message: `${shownPath(root, dir)}/ has ${names.length} source files (${names.join(", ")}): one source per project for now`, code: "bad_source",
      fix: `keep the one this project copies from, and move the others out of ${shownPath(root, dir)}/` };
  }
  const file = path.join(dir, names[0]!);
  const parsed = parseSourceText(fs.readFileSync(file, "utf8"), names[0]!.replace(/\.ya?ml$/, ""), file);
  if ("problems" in parsed) return sourceFailure(file, root, parsed.problems);
  if ("literal" in parsed.url) return { ...parsed, resolved: parsed.url.literal, from: shownPath(root, file) };
  const found = appEnvValue(root, parsed.url.env, env, { shellFirst: o.shellFirst === true });
  if (found === null) {
    const v = parsed.url.env;
    return { message: `${shownPath(root, file)}: url: \${${v}} is not set — not in ${o.shellFirst ? "the environment, .env.local or .env" : ".env.local, .env or the shell"}`, code: "bad_source",
      fix: `put ${v}=postgres://user:password@host:5432/your_app in ${shownPath(root, path.join(root, ENV_FILE))} (or export it), or write the URL in url:` };
  }
  return { ...parsed, resolved: found.value, from: `${parsed.url.env} in ${found.from}` };
}

/** The columns a table's copy keeps, in the source's order: the entry's, its key always among them. */
export function copiedColumns(t: SourceTable, e: Pick<TableEntry, "columns" | "exclude" | "key">): string[] {
  const keep = new Set(e.columns ?? t.columns.map((c) => c.name).filter((c) => !e.exclude.includes(c)));
  for (const k of e.key ?? t.key) keep.add(k);
  return t.columns.map((c) => c.name).filter((c) => keep.has(c));
}

/** Why a table cannot be copied as its entry says, each at its key, against the database's catalog; none when it can. */
export function entryProblems(t: SourceTable | undefined, e: TableEntry, all: readonly SourceTable[], database: string, o: { replication: boolean }): string[] {
  const at = `tables.${e.name}`;
  if (t === undefined) {
    const names = all.map((x) => entryName(x.source));
    return [`${at}: ${database} has no table ${e.table} this user can read${didYouMean(e.name, names)}${names.length ? "" : " (it has none this user can read)"}`];
  }
  const have = t.columns.map((c) => c.name);
  const missing = (list: readonly string[], key: string): string[] => list.filter((c) => !have.includes(c)).map((c) =>
    `${at}.${key}: ${t.source} has no column ${c}${didYouMean(c, have)} (its columns: ${have.join(", ")})`);
  const out = [...missing(e.columns ?? [], "columns"), ...missing(e.exclude, "exclude")];
  if (e.key !== null) {
    if (t.key.length) out.push(`${at}.key: ${t.source} has a primary key (${t.key.join(", ")}), which Mason copies it by — remove key`);
    else {
      out.push(...missing(e.key, "key"));
      out.push(...keyProblems(t, e.key, at));
      // its rows have no identity on the database, so logical replication carries no key to apply a change by
      if (o.replication) out.push(`${at}: ${t.source} has no primary key, and logical replication cannot apply its changes by key: — copy it by polling (mason start --poll), or remove it`);
    }
  } else if (!t.key.length) {
    const unique = (t.uniqueKeys ?? []).find((u) => u.columns.every((c) => t.columns.find((x) => x.name === c)?.notNull === true));
    out.push(`${at}: ${t.source} has no primary key, so Mason cannot tell its rows apart — name the columns that do: key: [${unique ? unique.columns.join(", ") : "…"}]` +
      `${unique ? ` (its unique index ${unique.name})` : ""}`);
  }
  for (const k of (e.key ?? t.key).filter((k) => e.exclude.includes(k))) out.push(`${at}.exclude: ${k} is ${t.source}'s key, which is always copied — take it out of exclude`);
  return out;
}

/**
 * A `key:` MUST TELL THE ROWS APART, AS THE DATABASE ENFORCES IT (the review of the sources file: a key with
 * duplicates failed the copy's distinct-key check as "Mason bug", retried for ever, and duplicates after the copy made the
 * poll's update and delete by key change both rows): every column NOT NULL, and a unique index of the table over some of
 * them — then no two rows can share the key. Partial and expression indexes are not read (src/cli/preflight.ts).
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
        : `it has no unique index over NOT NULL columns, so Mason cannot copy it until its owner adds one (or a primary key)`));
  }
  return out;
}

/**
 * THE TABLES THE RUN COPIES (`AddedTable`, src/duck/sync.ts): each entry against the database's catalog, narrowed to the
 * columns it copies (`copiedColumns`) and its foreign keys out of them. A `key:` is the key the table is copied by, and
 * `primaryKey` keeps the source's own (none): the catalog declares only what the source does. Every entry's problems on
 * one report (`sourceFailure`).
 */
export function addedTables(src: SourceFile, tables: readonly SourceTable[], database: string, root: string, o: { replication: boolean }): AddedTable[] | Failure {
  const problems: string[] = [];
  const out: AddedTable[] = [];
  for (const e of src.tables) {
    const t = tables.find((x) => x.source === e.table);
    const p = entryProblems(t, e, tables, database, o);
    if (p.length || t === undefined) { problems.push(...p); continue; }
    const keep = new Set(copiedColumns(t, e));
    out.push({ ...t, columns: t.columns.filter((c) => keep.has(c.name)), foreignKeys: t.foreignKeys.filter((f) => keep.has(f.column)),
      ...(e.key !== null ? { key: e.key, primaryKey: t.key } : {}) });
  }
  return problems.length ? sourceFailure(src.file, root, problems, [["mason tables", "the database's tables and their columns"]]) : out;
}

/** What the run copies: the sources file as it last read it, its tables, and what is wrong with the file now (null: nothing). */
export interface RunSources { file: SourceFile; tables: AddedTable[]; problem: string | null }

/**
 * THE SOURCES FILE READ AGAIN WHILE THE RUN IS UP (mason add, mason remove): its tables now — or, when the file cannot be
 * taken as it is, the tables read before, kept (a typo never drops a copy), with what is wrong; `said` is the log line,
 * once per new problem. A `url:` that resolves to another database than the one the run copies (a .env edited) is such a
 * problem: the run's catalog is the old database's, so it is said, and mason stop && mason start reads the new one.
 */
export function rereadSources(prev: RunSources, read: ProjectSource | Failure, runUrl: string, catalog: readonly SourceTable[], database: string, root: string,
  o: { replication: boolean }): RunSources & { said: string | null } {
  let problem: string | null = null;
  let next: AddedTable[] | null = null;
  if ("message" in read) problem = `${read.message}${read.why ? `: ${read.why.replace(/\n/g, "; ")}` : ""}`;
  else if (read.resolved !== runUrl) {
    problem = `${shownPath(root, read.file)}: url: now names ${maskedUrl(read.resolved)} (${read.from}), and this run copies ${maskedUrl(runUrl)}: mason stop && mason start copies from the new one`;
  } else {
    const t = addedTables(read, catalog, database, root, o);
    if (Array.isArray(t)) next = t;
    else problem = `${t.message}${t.why ? `: ${t.why.replace(/\n/g, "; ")}` : ""}`;
  }
  if (next !== null && !("message" in read)) return { file: read, tables: next, problem: null, said: null };
  return { ...prev, problem, said: problem !== prev.problem ? `the sources file cannot be read as it is now, so the tables read before are kept: ${problem}` : null };
}

// ------------------------------------------------------------------ the columns mason add asks for

/**
 * A COLUMN THAT LOOKS LIKE A SECRET is left out of every-column adds unless named (an agent's every-column
 * add put a table's `password`, `deploy_key_content` and `warehouse_private_key` into a copy anyone with a user's
 * password can query, with no warning). By name alone — the database says nothing about a column's sensitivity — so the
 * words are credentials' own, and a suffix that names an identifier or a time (`token_id`, `secret_count`) is not one.
 */
export const SECRET_WORDS = /(^|_)(password|passwd|pwd|secret|secrets|token|tokens|api_key|apikey|access_key|secret_key|private_key|ssh_key|credential|credentials|salt)(_|$)|_key_content$/;
export function looksSecret(column: string): boolean {
  return SECRET_WORDS.test(column) && !/_(id|ids|at|count|type|name|kind|hash_algo)$/.test(column);
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

// ------------------------------------------------------------------ editing the file (mason add, mason remove)

/** A name as YAML writes it: plain when it is an identifier YAML reads as a string, else quoted. */
const yamlName = (n: string): string => /^[A-Za-z_][A-Za-z0-9_$.]*$/.test(n) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(n) ? n : JSON.stringify(n);
const flowList = (xs: readonly string[]): string => `[${xs.map(yamlName).join(", ")}]`;

/** An entry's lines at `indent`: `name: {}` on one line, else its keys a line each under it. */
export function entryText(e: Pick<TableEntry, "name" | "columns" | "exclude" | "key">, indent: string): string {
  const body: string[] = [];
  if (e.columns !== null) body.push(`columns: ${flowList(e.columns)}`);
  else if (e.exclude.length) body.push(`exclude: ${flowList(e.exclude)}`);
  if (e.key !== null) body.push(`key: ${flowList(e.key)}`);
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
export function withTable(text: string, e: Pick<TableEntry, "name" | "table" | "columns" | "exclude" | "key">): { text: string } | { problem: string } {
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

function withTableLf(text: string, e: Pick<TableEntry, "name" | "table" | "columns" | "exclude" | "key">): { text: string } | { problem: string } {
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
}

/** Why `mason add <t>` with no `--key` cannot add `t`, or null. */
export function unaddableReason(t: SourceTable): string | null {
  if (t.key.length) return null;
  const unique = (t.uniqueKeys ?? []).find((u) => u.columns.every((c) => t.columns.find((x) => x.name === c)?.notNull === true));
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
  };
}
