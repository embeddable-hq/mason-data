/**
 * THE PROJECT'S ROLES FILE (GitHub issue 30, stage 1): `<folder>/roles.yml`, beside the sources file, the project's to
 * commit and review as the sources file is — what each role may READ of what the sources file copies:
 *
 *   roles:
 *     agent:
 *       tables:
 *         orders: { columns: [id, status, amount] }     those columns
 *         customers: { exclude: [email, phone] }         every copied column but these
 *         regions: {}                                     every column
 *     finance:
 *       tables:
 *         billing.invoices: {}                            a table named as the database names it
 *
 * The sources file's own words (`tables`, `columns`, `exclude`; a bare name is in public), so a software engineer who
 * wrote the sources file reads this one. A role names copied tables only: the sources file is the outer boundary (what
 * is copied at all), a role narrows within it. A `mason user` carries a role (`mason user add <name> --role <role>`,
 * src/cli/user.ts); a user with none reads everything copied, as before. The listener enforces it on the analysed tree
 * (src/duck/grants.ts) and the catalog Postgres mirrors it as real roles and GRANTs (src/api/postgres/catalog.ts), so
 * `information_schema` and `mason mcp` list a role only what it may read.
 *
 * Read in two steps, as the sources file is (src/cli/sources.ts): `parseRolesText` (the file alone: its shape) and
 * `resolveRoles` (each role's tables against the tables the run copies: an unknown table or column is refused by name,
 * every mistake of the file on ONE report, `rolesFailure`). `LiveRoles` is the run's reader: the file read again when
 * it changes, resolved against the tables copied now.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseDocument } from "yaml";
import { didYouMean } from "../lib/did-you-mean.ts";
import type { Failure } from "./command.ts";
import { entryName, shownPath, sourceOf, tableNameProblem } from "./sources.ts";
import { NO_ROLES, type RoleGrants, type RolesLive, type TableGrant } from "../duck/grants.ts";

export const ROLES_FILE = "roles.yml";
/** Where a project's roles file is: `<folder>/roles.yml`, beside `sources/`. */
export const rolesFile = (folder: string): string => path.join(folder, ROLES_FILE);

/** A role's name: a Postgres role name the catalog can make (never one Postgres has: postgres, public, pg_*). */
export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const ROLE_NAME_RULE = "1 to 63 lower case letters, digits, \"_\" or \"-\", starting with a letter or digit (e.g. agent), not postgres, public or pg_…";
const roleNameProblem = (name: string): string | null =>
  !ROLE_NAME_RE.test(name) ? `is not a role name: ${ROLE_NAME_RULE}` : name === "postgres" || name === "public" || name.startsWith("pg_") ? `is a name Postgres keeps for itself: choose another` : null;

const ROLE_KEYS = ["tables"] as const;
const TABLE_KEYS = ["columns", "exclude"] as const;

/** A table of a role, as the file names it. */
export interface RoleTable {
  /** the key as written: `orders` or `billing.invoices` */
  name: string;
  /** `schema.table` */
  table: string;
  /** the columns it may read; null: every copied column but `exclude` */
  columns: string[] | null;
  exclude: string[];
}
export interface RoleEntry { name: string; tables: RoleTable[] }
export interface RolesFile { file: string; roles: RoleEntry[] }

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const yamlRead = (x: unknown): string =>
  `${x === null ? "null" : String(x)} is read by YAML as ${x === null ? "nothing (null)" : typeof x === "boolean" ? "a boolean" : typeof x === "number" ? "a number" : "a list or a map"}, not a name`;

/** A list of column names at `at`, or the problem with it. */
function nameList(v: unknown, at: string, what: string): string[] | string {
  if (Array.isArray(v) && v.length) {
    const other = v.find((x) => typeof x !== "string");
    if (other !== undefined) return `${at}: ${yamlRead(other)} — quote it: "${String(other)}"`;
  }
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string" && x !== "")) return `${at}: is ${what}, a list of column names: [id, status]`;
  const twice = v.find((x, i) => v.indexOf(x) !== i);
  if (twice !== undefined) return `${at}: names ${String(twice)} twice`;
  return v as string[];
}

/** The file's text read as a roles file: its shape, never the copied tables (that is `resolveRoles`'s). */
export function parseRolesText(text: string, file: string): RolesFile | { problems: string[] } {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) return { problems: [`it is not YAML: ${doc.errors[0]!.message.split("\n")[0]}`] };
  const v: unknown = doc.toJS();
  if (!isPlain(v)) return { problems: [`it is ${v === null || v === undefined ? "empty" : "not a mapping"}: a roles file is roles: { <role>: { tables: { orders: {} } } }`] };
  const problems: string[] = [];
  for (const k of Object.keys(v)) if (k !== "roles") problems.push(`unexpected key ${k}${didYouMean(k, ["roles"])} — a roles file takes roles alone`);
  const roles: RoleEntry[] = [];
  if (v.roles === undefined) problems.push("roles: missing — write roles: {} and one entry per role: agent: { tables: { orders: {} } }");
  else if (v.roles !== null && !isPlain(v.roles)) problems.push("roles: is one entry per role, like roles: { agent: { tables: { orders: {}, customers: { columns: [id, name] } } } }");
  else {
    for (const [name, raw] of Object.entries(v.roles ?? {})) {
      const at = `roles.${name}`;
      const bad = roleNameProblem(name);
      if (bad !== null) { problems.push(`${at}: ${name} ${bad}`); continue; }
      if (!isPlain(raw)) { problems.push(`${at}: is { tables: { … } }, the tables the role may read`); continue; }
      const stray = Object.keys(raw).filter((k) => !(ROLE_KEYS as readonly string[]).includes(k));
      for (const k of stray) problems.push(`${at}: unexpected key ${k}${didYouMean(k, ROLE_KEYS)} — a role takes tables`);
      if (raw.tables === undefined) { problems.push(`${at}.tables: missing — write tables: { orders: {} }, the tables the role may read (a role with no table reads nothing: remove it instead)`); continue; }
      if (!isPlain(raw.tables) || Object.keys(raw.tables).length === 0) { problems.push(`${at}.tables: is one entry per table the role may read, like tables: { orders: {}, customers: { exclude: [email] } } — a role with no table reads nothing: remove it instead`); continue; }
      const tables: RoleTable[] = [];
      const seen = new Map<string, string>();
      let ok = stray.length === 0;
      for (const [key, entry] of Object.entries(raw.tables)) {
        const tat = `${at}.tables.${key}`;
        const badName = tableNameProblem(key);
        if (badName !== null) { problems.push(`${tat}: ${badName}`); ok = false; continue; }
        const table = sourceOf(key);
        const before = seen.get(table);
        if (before !== undefined) { problems.push(`${tat}: ${table} is named twice (as ${before} too) — keep one`); ok = false; continue; }
        seen.set(table, key);
        if (entry !== null && !isPlain(entry)) { problems.push(`${tat}: is {} (every column), { columns: [...] } or { exclude: [...] }`); ok = false; continue; }
        const e = entry ?? {};
        const odd = Object.keys(e).filter((k) => !(TABLE_KEYS as readonly string[]).includes(k));
        for (const k of odd) problems.push(`${tat}: unexpected key ${k}${didYouMean(k, TABLE_KEYS)} — a table takes columns or exclude`);
        const both = e.columns !== undefined && e.exclude !== undefined;
        if (both) problems.push(`${tat}: columns and exclude together — columns names what the role reads, exclude what it may not read of every column; keep one`);
        const columns = e.columns === undefined ? null : nameList(e.columns, `${tat}.columns`, "the columns the role reads");
        const exclude = e.exclude === undefined ? [] : nameList(e.exclude, `${tat}.exclude`, "the columns the role may not read");
        for (const x of [columns, exclude]) if (typeof x === "string") problems.push(x);
        if (typeof columns === "string" || typeof exclude === "string" || odd.length || both) { ok = false; continue; }
        tables.push({ name: key, table, columns, exclude });
      }
      if (ok) roles.push({ name, tables });
    }
  }
  if (problems.length) return { problems };
  return { file, roles };
}

/** A roles file's mistakes, all of them, as one failure (the sources file's `sourceFailure`, code bad_roles). */
export function rolesFailure(file: string, root: string, problems: readonly string[]): Failure {
  const f = shownPath(root, file);
  const one = problems.length === 1;
  return {
    message: one ? `${f}: ${problems[0]!}` : `${f} has ${problems.length} mistakes`,
    code: "bad_roles",
    ...(one ? {} : { why: problems.map((p) => `- ${p}`).join("\n") }),
    fix: `edit ${f}, then run the command again`,
  };
}

/** The project's roles file, read: null when it has none (no roles: every user reads everything copied). */
export function readRoles(folder: string, root: string): RolesFile | null | Failure {
  const file = rolesFile(folder);
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { message: `${shownPath(root, file)} cannot be read: ${(e as Error).message}`, code: "bad_roles", fix: "make it readable, or move it aside (no roles file: every user reads every copied table)" };
  }
  const parsed = parseRolesText(text, file);
  return "problems" in parsed ? rolesFailure(file, root, parsed.problems) : parsed;
}

/** A copied table as the roles are resolved against it: its columns, when known (a sources file's entry knows none). */
export interface CopiedTable { source: string; columns: ReadonlyArray<{ name: string }> | null }

/**
 * Why a role's tables are not the copy's, each at its key: a table the sources file does not copy (refused by name:
 * the sources file is the boundary a role narrows), a column the copy does not hold. None when every entry fits.
 */
export function roleProblems(roles: RolesFile, copied: readonly CopiedTable[]): string[] {
  const problems: string[] = [];
  const names = copied.map((t) => entryName(t.source));
  for (const r of roles.roles) {
    for (const t of r.tables) {
      const at = `roles.${r.name}.tables.${t.name}`;
      const c = copied.find((x) => x.source === t.table);
      if (c === undefined) {
        problems.push(`${at}: ${t.table} is not a table the sources file copies${didYouMean(t.name, names)} — a role reads copied tables only (${names.length ? `copied: ${names.join(", ")}` : "none is copied yet"}; mason add ${t.name} copies it)`);
        continue;
      }
      if (c.columns === null) continue;
      const have = c.columns.map((x) => x.name);
      for (const [key, list] of [["columns", t.columns ?? []], ["exclude", t.exclude]] as const) {
        for (const col of list.filter((x) => !have.includes(x))) problems.push(`${at}.${key}: the copy of ${t.table} has no column ${col}${didYouMean(col, have)} (its columns: ${have.join(", ")})`);
      }
      if (t.exclude.length && t.exclude.length >= have.length && have.every((h) => t.exclude.includes(h))) problems.push(`${at}.exclude: leaves no column of ${t.table} to read — remove the table from the role instead`);
    }
  }
  return problems;
}

/**
 * Each role's grants, resolved against the tables the run copies (`exclude:` written out as the columns kept, in the
 * copy's order), or the file's mistakes as one failure. `root`: how messages name the file.
 */
export function resolveRoles(roles: RolesFile, copied: readonly (CopiedTable & { columns: ReadonlyArray<{ name: string }> })[], root: string): Map<string, RoleGrants> | Failure {
  const problems = roleProblems(roles, copied);
  if (problems.length) return rolesFailure(roles.file, root, problems);
  const file = shownPath(root, roles.file);
  const out = new Map<string, RoleGrants>();
  for (const r of roles.roles) {
    const tables = new Map<string, TableGrant>();
    for (const t of r.tables) {
      const have = copied.find((x) => x.source === t.table)!.columns.map((x) => x.name);
      const all = t.columns === null && t.exclude.length === 0;
      const columns = all ? have : t.columns !== null ? have.filter((c) => t.columns!.includes(c)) : have.filter((c) => !t.exclude.includes(c));
      tables.set(t.table, { table: t.table, all, columns });
    }
    out.set(r.name, { name: r.name, file, tables });
  }
  return out;
}

/**
 * THE RUN'S ROLES, read again when the file changes (its inode, size or mtime: a stat per ask) or the copied tables do,
 * and resolved against those tables; the same `RolesLive` object until one of them moves, so the listener knows when
 * to rebuild the catalog. A file that cannot be read as it is now keeps the last good grants for the catalog and says
 * the problem, which refuses every statement of a session with a role (src/duck/grants.ts RolesLive): fail closed.
 */
export class LiveRoles {
  private readonly folder: string;
  private readonly root: string;
  private readonly tables: () => readonly (CopiedTable & { columns: ReadonlyArray<{ name: string }> })[];
  private seen: string | null = null;
  private seenTables: string | null = null;
  private live: RolesLive = NO_ROLES;
  private lastGood: ReadonlyMap<string, RoleGrants> = new Map();

  constructor(folder: string, root: string, tables: () => readonly (CopiedTable & { columns: ReadonlyArray<{ name: string }> })[]) {
    this.folder = folder; this.root = root; this.tables = tables;
  }

  /** the roles now (one object until the file or the tables change) */
  now(): RolesLive {
    const file = rolesFile(this.folder);
    let stamp: string;
    try { const s = fs.statSync(file); stamp = `${s.ino}:${s.size}:${s.mtimeMs}`; }
    catch (e) { stamp = (e as NodeJS.ErrnoException).code === "ENOENT" ? "none" : `error:${(e as Error).message}`; }
    const tables = this.tables();
    // the tables by CONTENT, never by the array's identity: a caller that maps a fresh array per ask (a test did) would
    // otherwise make a new RolesLive at every statement, and the listener rebuilds the catalog at each new one
    const tablesKey = tables.map((t) => `${t.source}(${t.columns.map((c) => c.name).join(",")})`).join(";");
    if (stamp === this.seen && tablesKey === this.seenTables) return this.live;
    this.seen = stamp; this.seenTables = tablesKey;
    const read = readRoles(this.folder, this.root);
    if (read === null) { this.lastGood = new Map(); this.live = NO_ROLES; return this.live; }
    const shownFile = shownPath(this.root, file);
    if ("message" in read) { this.live = { file: shownFile, grants: this.lastGood, problem: problemText(read) }; return this.live; }
    const resolved = resolveRoles(read, tables, this.root);
    if ("message" in resolved) { this.live = { file: shownFile, grants: this.lastGood, problem: problemText(resolved) }; return this.live; }
    this.lastGood = resolved;
    this.live = { file: shownFile, grants: resolved, problem: null };
    return this.live;
  }
}

/** a failure's text on one line, for a log line or a refusal */
export const problemText = (f: Failure): string => `${f.message}${f.why ? `: ${f.why.replace(/\n/g, "; ")}` : ""}`;

/**
 * The users whose role the file does not name — said at the start, and by `mason user list`: their statements are
 * refused by name until the role is added or the user made again (never silently widened).
 */
export function usersWithoutRole(users: ReadonlyArray<{ name: string; role?: string | undefined }>, roles: ReadonlySet<string>): Array<{ name: string; role: string }> {
  return users.flatMap((u) => u.role !== undefined && !roles.has(u.role) ? [{ name: u.name, role: u.role }] : []);
}
