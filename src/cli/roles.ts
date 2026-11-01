/**
 * THE PROJECT'S ROLES FILE (GitHub issue 30, stages 1a and 1b): `<folder>/roles.yml`, beside the sources file, the
 * project's to commit and review as the sources file is — what each role may READ of what the sources file copies, and
 * the role of a user added without one (`newRolesText` writes the first, `mason init`):
 *
 *   default: everything                                   the role of every user with no role of its own
 *   roles:
 *     everything:
 *       tables: all                                       every synced table and column, those added later included
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
 * src/cli/user.ts). THE FILE DECIDES WHAT A USER WITH NO ROLE READS (stage 1b, never the code): no file, every copied
 * table; `default: <role>`, that role; a file with no `default:`, nothing — every statement that reads a copied table
 * is refused with the two ways out. A token (no user) reads every synced table. The listener enforces it on the analysed tree
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
import { closest, didYouMean } from "../lib/did-you-mean.ts";
import type { Failure } from "./command.ts";
import { entryName, shownPath, sourceOf, tableNameProblem } from "./sources.ts";
import { NO_ROLES, type RoleGrants, type RolesLive, type TableGrant } from "../duck/grants.ts";
import { ATTRIBUTE_NAME_RE, ATTRIBUTE_NAME_RULE, missingAttributes, whereAttributes, whereParts, type AttributeShape, type RowFilter, type WherePart } from "../duck/row-filter.ts";
export { exampleRole, noRoleWayOut } from "../duck/grants.ts";

export const ROLES_FILE = "roles.yml";
/** Where a project's roles file is: `<folder>/roles.yml`, beside `sources/`. */
export const rolesFile = (folder: string): string => path.join(folder, ROLES_FILE);

/** A role's name: a Postgres role name the catalog can make (never one Postgres has: postgres, public, pg_*). */
export const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const ROLE_NAME_RULE = "1 to 63 lower case letters, digits, \"_\" or \"-\", starting with a letter or digit (e.g. agent), not postgres, public or pg_…";
const roleNameProblem = (name: string): string | null =>
  !ROLE_NAME_RE.test(name) ? `is not a role name: ${ROLE_NAME_RULE}` : name === "postgres" || name === "public" || name.startsWith("pg_") ? `is a name Postgres keeps for itself: choose another` : null;

const ROLE_KEYS = ["tables", "attributes"] as const;
const TABLE_KEYS = ["columns", "exclude", "where", "through"] as const;

/** A table of a role, as the file names it. */
export interface RoleTable {
  /** the key as written: `orders` or `billing.invoices` */
  name: string;
  /** `schema.table` */
  table: string;
  /** the columns it may read; null: every copied column but `exclude` */
  columns: string[] | null;
  exclude: string[];
  /** `where:`: the rows it may read, a Postgres boolean expression over the table's columns and the role's `:attributes` */
  where?: { text: string; parts: WherePart[] };
  /** `through:`: a row is visible when the row of `table` (a table of the same role, `name` as written) it references is;
   *  `column` the explicit form's (`through: { orders: order_id }`), null where the foreign key decides */
  through?: { name: string; table: string; column: string | null };
}
/** A role as the file names it: its tables, or `all` (every synced table and column, resolved at every read), and the
 *  attributes its users carry (absent: none declared). */
export interface RoleEntry { name: string; tables: RoleTable[] | "all"; attributes?: Map<string, AttributeShape> }
/** `default`: the role of a user with no role of its own; null where the file names none (such a user reads nothing). */
export interface RolesFile { file: string; roles: RoleEntry[]; default: string | null }

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

/** A role's `attributes:`, or the problem with it: `[tenant]` (every one a scalar) or `{ tenant: scalar, tenants: list }`. */
function attributesOf(v: unknown, at: string): Map<string, AttributeShape> | string | undefined {
  if (v === undefined) return undefined;
  const shape = `is the attributes its users carry: [tenant] (each one value), or { tenant: scalar, tenants: list }`;
  const out = new Map<string, AttributeShape>();
  const entries: Array<[unknown, unknown]> = Array.isArray(v) ? v.map((x) => [x, "scalar"]) : isPlain(v) ? Object.entries(v) : [];
  if (entries.length === 0) return `${at}: ${shape}`;
  for (const [name, kind] of entries) {
    if (typeof name !== "string") return `${at}: ${yamlRead(name)} — ${shape}`;
    if (!ATTRIBUTE_NAME_RE.test(name)) return `${at}: ${name} is not an attribute's name: ${ATTRIBUTE_NAME_RULE}`;
    if (out.has(name)) return `${at}: names ${name} twice`;
    if (kind !== "scalar" && kind !== "list") return `${at}.${name}: is scalar (one value: --set ${name}=42) or list (several: --set ${name}=12 --set ${name}=41)${typeof kind === "string" ? didYouMean(kind, ["scalar", "list"]) : ""}`;
    out.set(name, kind);
  }
  return out;
}

/** A table's `where:` and `through:` (never both), or the problem with them: each `:name` an attribute of the role. */
function rowsOf(e: Record<string, unknown>, tat: string, attributes: ReadonlyMap<string, AttributeShape>): Pick<RoleTable, "where" | "through"> | string {
  if (e.where !== undefined && e.through !== undefined) return `${tat}: where and through together — where: filters this table's rows by its own columns, through: by another table's; keep one`;
  if (e.where !== undefined) {
    if (typeof e.where !== "string" || e.where.trim() === "") return `${tat}.where: is a Postgres condition on the table's columns, quoted: where: "tenant_id = :tenant"`;
    const parts = whereParts(e.where);
    if ("problem" in parts) return `${tat}.where: ${parts.problem}`;
    const declared = [...attributes.keys()];
    for (const a of whereAttributes(parts)) {
      if (!attributes.has(a)) return `${tat}.where: :${a} is not an attribute of the role${didYouMean(a, declared)} — declare it beside tables: attributes: [${[...declared, a].join(", ")}]`;
    }
    return { where: { text: e.where, parts } };
  }
  if (e.through !== undefined) {
    const form = `is the table whose visible rows make this one's visible: through: orders, or through: { orders: order_id } naming the column that references it`;
    let name: string, column: string | null = null;
    if (typeof e.through === "string") name = e.through;
    else if (isPlain(e.through) && Object.keys(e.through).length === 1 && typeof Object.values(e.through)[0] === "string") [name, column] = Object.entries(e.through)[0] as [string, string];
    else return `${tat}.through: ${form}`;
    const bad = tableNameProblem(name);
    if (bad !== null) return `${tat}.through: ${bad}`;
    return { through: { name, table: sourceOf(name), column } };
  }
  return {};
}

/** The file's text read as a roles file: its shape, never the copied tables (that is `resolveRoles`'s). */
export function parseRolesText(text: string, file: string): RolesFile | { problems: string[] } {
  const doc = parseDocument(text, { uniqueKeys: true });
  // the YAML library's first line ends "… at line 1, column 18:" before a snippet of the file: the snippet is dropped,
  // and its colon with it, so the problem reads whole on one line (a tip, a log line)
  if (doc.errors.length) return { problems: [`it is not YAML: ${doc.errors[0]!.message.split("\n")[0]!.replace(/:\s*$/, "")}`] };
  const v: unknown = doc.toJS();
  if (!isPlain(v)) return { problems: [`it is ${v === null || v === undefined ? "empty" : "not a mapping"}: a roles file is roles: { <role>: { tables: { orders: {} } } }`] };
  const problems: string[] = [];
  for (const k of Object.keys(v)) if (k !== "roles" && k !== "default") problems.push(`unexpected key ${k}${didYouMean(k, ["default", "roles"])} — a roles file takes default and roles`);
  // THE DEFAULT: the role of every user added without --role, a role of this file (stage 1b: the file decides it)
  let byDefault: string | null = null;
  if (v.default !== undefined) {
    const names = isPlain(v.roles) ? Object.keys(v.roles) : [];
    if (typeof v.default !== "string" || v.default === "") {
      const what = typeof v.default === "string" ? "" : typeof v.default === "object" && v.default !== null ? " (a list or a map is not a name)" : ` (${yamlRead(v.default)})`;
      problems.push(`default: is a role's name, like default: everything${what}`);
    }
    else if (!names.includes(v.default)) problems.push(`default: there is no role ${v.default} in roles:${didYouMean(v.default, names)} — add it under roles:${names.length ? `, or name one of: ${names.join(", ")}` : ""}`);
    else byDefault = v.default;
  }
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
      for (const k of stray) problems.push(`${at}: unexpected key ${k}${didYouMean(k, ROLE_KEYS)} — a role takes tables and attributes`);
      // ATTRIBUTES: what each of its users carries (mason user add … --set tenant=42), read by its where:s as :tenant
      const attrs = attributesOf(raw.attributes, `${at}.attributes`);
      if (typeof attrs === "string") problems.push(attrs);
      const attributes = typeof attrs === "string" ? undefined : attrs;
      const withAttrs = attributes === undefined || attributes.size === 0 ? {} : { attributes };
      if (raw.tables === undefined) { problems.push(`${at}.tables: missing — write tables: all (every synced table) or tables: { orders: {} }, the tables the role may read (a role with no table reads nothing: remove it instead)`); continue; }
      const tablesShape = `${at}.tables: is all (every synced table and column) or one entry per table the role may read, like tables: { orders: {}, customers: { exclude: [email] } }`;
      // `tables: all`: every synced table and every column, those the sources file adds later included (resolveRoles)
      if (raw.tables === "all") { if (stray.length === 0 && typeof attrs !== "string") roles.push({ name, tables: "all", ...withAttrs }); continue; }
      if (typeof raw.tables === "string") { problems.push(`${tablesShape} — ${raw.tables} is neither${didYouMean(raw.tables, ["all"])}`); continue; }
      if (Array.isArray(raw.tables)) { problems.push(`${tablesShape} — not a list: tables: all, or a key per table`); continue; }
      if (!isPlain(raw.tables) || Object.keys(raw.tables).length === 0) { problems.push(`${tablesShape} — a role with no table reads nothing: remove it instead`); continue; }
      const tables: RoleTable[] = [];
      const seen = new Map<string, string>();
      let ok = stray.length === 0 && typeof attrs !== "string";
      for (const [key, entry] of Object.entries(raw.tables)) {
        const tat = `${at}.tables.${key}`;
        // `all` is the file's word for every table: a key of that name is a mistake either way, said with both meanings
        if (key === "all") { problems.push(`${tat}: all names every table — write tables: all for every synced table, or public.all for a table named all`); ok = false; continue; }
        const badName = tableNameProblem(key);
        if (badName !== null) { problems.push(`${tat}: ${badName}`); ok = false; continue; }
        const table = sourceOf(key);
        const before = seen.get(table);
        if (before !== undefined) { problems.push(`${tat}: ${table} is named twice (as ${before} too) — keep one`); ok = false; continue; }
        seen.set(table, key);
        if (entry !== null && !isPlain(entry)) { problems.push(`${tat}: is {} (every column), { columns: [...] }, { exclude: [...] }, and where: or through: for the rows`); ok = false; continue; }
        const e = entry ?? {};
        const odd = Object.keys(e).filter((k) => !(TABLE_KEYS as readonly string[]).includes(k));
        for (const k of odd) problems.push(`${tat}: unexpected key ${k}${didYouMean(k, TABLE_KEYS)} — a table takes columns or exclude, and where or through`);
        const both = e.columns !== undefined && e.exclude !== undefined;
        if (both) problems.push(`${tat}: columns and exclude together — columns names what the role reads, exclude what it may not read of every column; keep one`);
        const columns = e.columns === undefined ? null : nameList(e.columns, `${tat}.columns`, "the columns the role reads");
        const exclude = e.exclude === undefined ? [] : nameList(e.exclude, `${tat}.exclude`, "the columns the role may not read");
        for (const x of [columns, exclude]) if (typeof x === "string") problems.push(x);
        const rows = rowsOf(e, tat, attributes ?? new Map());
        if (typeof rows === "string") problems.push(rows);
        if (typeof columns === "string" || typeof exclude === "string" || odd.length || both || typeof rows === "string") { ok = false; continue; }
        tables.push({ name: key, table, columns, exclude, ...rows });
      }
      // a through: names a table of this role that has a where: or a through: of its own, and never comes back round
      for (const t of tables) {
        if (t.through === undefined) continue;
        const tat = `${at}.tables.${t.name}.through`;
        const parent = tables.find((x) => x.table === t.through!.table);
        if (parent === undefined) { problems.push(`${tat}: ${t.through.name} is not a table of the role ${name}${didYouMean(t.through.name, tables.map((x) => x.name))} — add it with a where: (a row of ${t.name} is visible when the row of ${t.through.name} it references is)`); ok = false; continue; }
        if (parent.where === undefined && parent.through === undefined) { problems.push(`${tat}: ${t.through.name} has no where: or through: of its own, so every row of it is visible — filter it (where: "…"), or remove the through: (every row of ${t.name} is visible then)`); ok = false; continue; }
        const seen = [t.table];
        for (let p: RoleTable | undefined = parent; p?.through !== undefined; p = tables.find((x) => x.table === p!.through!.table)) {
          if (seen.includes(p.table)) { problems.push(`${tat}: comes back round (${[...seen, p.table].map((x) => tables.find((y) => y.table === x)?.name ?? x).join(" → ")}) — one of them needs a where: instead`); ok = false; break; }
          seen.push(p.table);
        }
      }
      if (ok) roles.push({ name, tables, ...withAttrs });
    }
  }
  if (problems.length) return { problems };
  return { file, roles, default: byDefault };
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
    return { message: `${shownPath(root, file)} cannot be read: ${(e as Error).message}`, code: "bad_roles", fix: "make it readable, or move it aside (no roles file: every user reads every synced table)" };
  }
  const parsed = parseRolesText(text, file);
  return "problems" in parsed ? rolesFailure(file, root, parsed.problems) : parsed;
}

/** A copied table as the roles are resolved against it: its columns, when known (a sources file's entry knows none). */
export interface CopiedTable {
  source: string; columns: ReadonlyArray<{ name: string }> | null;
  /** its foreign keys as the database's catalog reports them (src/cli/preflight.ts), when known: what `through:` follows */
  foreignKeys?: ReadonlyArray<{ column: string; target: string; targetColumn: string }>;
  /** its primary key's columns, when known: what an explicit `through: { orders: order_id }` with no foreign key compares */
  key?: readonly string[];
  /** a generated table not built yet (src/duck/generated.ts): its columns are not known, so a role's `columns:` are not
   *  held to them yet, and it reads nothing of it */
  pending?: true;
}

/**
 * THE COLUMNS A `through:` COMPARES: the child's column and the parent's it references — by the foreign key from the
 * child to the parent as the database's catalog reports it, or the column named (`through: { orders: order_id }`) and
 * the foreign key on it, else the parent's one-column primary key. Null where the foreign keys are not known (a
 * sources file read without the database: the run holds it). One problem, at its key, with the way out otherwise.
 */
export function throughColumns(t: RoleTable, at: string, copied: readonly CopiedTable[]): { column: string; parentColumn: string } | string | null {
  const th = t.through!;
  const child = copied.find((x) => x.source === t.table), parent = copied.find((x) => x.source === th.table);
  if (child === undefined || parent === undefined || child.foreignKeys === undefined) return null;
  const tat = `${at}.through`;
  const fks = child.foreignKeys.filter((f) => f.target === th.table);
  const explicit = `through: { ${th.name}: <column> }`;
  let column: string, parentColumn: string;
  if (th.column !== null) {
    const have = child.columns?.map((c) => c.name);
    if (have !== undefined && !have.includes(th.column)) return `${tat}.${th.name}: the synced ${t.table} has no column ${th.column}${didYouMean(th.column, have)} (its columns: ${have.join(", ")})`;
    column = th.column;
    const fk = fks.find((f) => f.column === th.column);
    if (fk !== undefined) parentColumn = fk.targetColumn;
    else if (parent.key !== undefined && parent.key.length === 1) parentColumn = parent.key[0]!;
    else return `${tat}.${th.name}: ${th.column} references ${th.table} by no foreign key, and ${th.table} has no one-column primary key to compare it with — a through: compares one column with the parent's key`;
  } else {
    if (fks.length === 0) return `${tat}: ${t.table} has no foreign key to ${th.table} (as the database's catalog reports them) — name the column that references it: ${explicit.replace("<column>", `<a column of ${t.name}>`)}`;
    if (fks.length > 1) return `${tat}: ${t.table} references ${th.table} by ${fks.length} foreign keys (${fks.map((f) => f.column).join(", ")}) — name the one: ${fks.map((f) => `through: { ${th.name}: ${f.column} }`).join(" or ")}`;
    column = fks[0]!.column; parentColumn = fks[0]!.targetColumn;
  }
  const childHave = child.columns?.map((c) => c.name), parentHave = parent.columns?.map((c) => c.name);
  if (childHave !== undefined && !childHave.includes(column)) return `${tat}: the synced ${t.table} has no column ${column}, which references ${th.table} — sync it (the sources file's columns: for ${t.name})`;
  if (parentHave !== undefined && !parentHave.includes(parentColumn)) return `${tat}: the synced ${th.table} has no column ${parentColumn}, which ${t.table}.${column} references — sync it (the sources file's columns: for ${th.name})`;
  return { column, parentColumn };
}

/**
 * Why a role's tables are not the copy's, each at its key: a table the sources file does not copy (refused by name:
 * the sources file is the boundary a role narrows), a column the copy does not hold. None when every entry fits.
 */
export function roleProblems(roles: RolesFile, copied: readonly CopiedTable[]): string[] {
  const problems: string[] = [];
  const names = copied.map((t) => entryName(t.source));
  for (const r of roles.roles) {
    // `tables: all` names no table: it is every table copied now, so it cannot name one the sources file lacks
    if (r.tables === "all") continue;
    for (const t of r.tables) {
      const at = `roles.${r.name}.tables.${t.name}`;
      const c = copied.find((x) => x.source === t.table);
      if (c === undefined) {
        problems.push(`${at}: ${t.table} is not a table the sources file syncs${nearestEntry(t.name, names)} — a role reads synced tables only (${names.length ? `synced: ${names.join(", ")}` : "none is synced yet"}; mason add ${t.name} syncs it)`);
        continue;
      }
      if (t.through !== undefined) {
        const th = throughColumns(t, at, copied);
        if (typeof th === "string") problems.push(th);
      }
      // a generated table not built yet: its columns are not known, and the role reads nothing of it until they are
      if (c.columns === null || c.pending === true) continue;
      const have = c.columns.map((x) => x.name);
      for (const [key, list] of [["columns", t.columns ?? []], ["exclude", t.exclude]] as const) {
        for (const col of list.filter((x) => !have.includes(x))) problems.push(`${at}.${key}: the synced ${t.table} has no column ${col}${didYouMean(col, have)} (its columns: ${have.join(", ")})`);
      }
      if (t.exclude.length && t.exclude.length >= have.length && have.every((h) => t.exclude.includes(h))) problems.push(`${at}.exclude: leaves no column of ${t.table} to read — remove the table from the role instead`);
    }
  }
  return problems;
}

/** The closest copied entry to `name`: by the whole name, else — for a bare name — by a qualified entry's own table
 *  part (`invoices` → `billing.invoices`, which the whole-name distance finds too far; a review nit of #35). */
function nearestEntry(name: string, names: readonly string[]): string {
  const whole = didYouMean(name, names);
  if (whole !== "" || name.includes(".")) return whole;
  const byTail = new Map(names.filter((n) => n.includes(".")).map((n) => [n.slice(n.lastIndexOf(".") + 1), n] as const));
  const hit = byTail.has(name) ? name : closest(name, byTail.keys());
  return hit === null ? "" : ` — did you mean \`${byTail.get(hit)!}\`?`;
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
    if (r.tables === "all") {
      // every table copied NOW, every column: resolved again whenever the copied tables move (LiveRoles), so a table
      // the sources file adds later is the role's at the next statement
      for (const c of copied) tables.set(c.source, { table: c.source, all: true, columns: c.columns.map((x) => x.name) });
      out.set(r.name, { name: r.name, file, tables, all: true, ...(r.attributes !== undefined ? { attributes: r.attributes } : {}) });
      continue;
    }
    const filters = new Map<string, RowFilter>();
    for (const t of r.tables) {
      const have = copied.find((x) => x.source === t.table)!.columns.map((x) => x.name);
      const all = t.columns === null && t.exclude.length === 0;
      const columns = all ? have : t.columns !== null ? have.filter((c) => t.columns!.includes(c)) : have.filter((c) => !t.exclude.includes(c));
      tables.set(t.table, { table: t.table, all, columns });
      const at = `roles.${r.name}.tables.${t.name}`;
      if (t.where !== undefined) filters.set(t.table, { table: t.table, at, where: t.where });
      if (t.through !== undefined) {
        // held by roleProblems above; foreign keys not known here are none, so an implicit through: is refused there
        const th = throughColumns(t, at, copied.map((c) => ({ ...c, foreignKeys: c.foreignKeys ?? [] })));
        if (th === null || typeof th === "string") return rolesFailure(roles.file, root, [th ?? `${at}.through: the synced tables are not known`]);
        filters.set(t.table, { table: t.table, at, through: { parent: t.through.table, ...th } });
      }
    }
    out.set(r.name, { name: r.name, file, tables, all: false, ...(r.attributes !== undefined ? { attributes: r.attributes } : {}), ...(filters.size > 0 ? { filters } : {}) });
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
  private lastGoodDefault: string | null = null;

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
    if (read === null) { this.lastGood = new Map(); this.lastGoodDefault = null; this.live = NO_ROLES; return this.live; }
    const shownFile = shownPath(this.root, file);
    if ("message" in read) { this.live = { file: shownFile, grants: this.lastGood, problem: problemText(read), default: this.lastGoodDefault }; return this.live; }
    const resolved = resolveRoles(read, tables, this.root);
    if ("message" in resolved) { this.live = { file: shownFile, grants: this.lastGood, problem: problemText(resolved), default: this.lastGoodDefault }; return this.live; }
    this.lastGood = resolved;
    this.lastGoodDefault = read.default;
    this.live = { file: shownFile, grants: resolved, problem: null, default: read.default };
    return this.live;
  }
}

/** what `mason user list` says (and the web page, held equal) while the roles file cannot be read as it is now */
export const rolesProblemText = (file: string, problem: string): string => `${file} cannot be read as it is now, so every statement of a user held to it is refused: ${problem}`;

/** a failure's text on one line, for a log line or a refusal */
export const problemText = (f: Failure): string => `${f.message}${f.why ? `: ${f.why.replace(/\n/g, "; ")}` : ""}`;

/**
 * The users whose role the file does not name — said at the start, and by `mason user list`: their statements are
 * refused by name until the role is added or the user made again (never silently widened).
 */
export function usersWithoutRole(users: ReadonlyArray<{ name: string; role?: string | undefined }>, roles: ReadonlySet<string>): Array<{ name: string; role: string }> {
  return users.flatMap((u) => u.role !== undefined && !roles.has(u.role) ? [{ name: u.name, role: u.role }] : []);
}

/**
 * THE USERS WITHOUT A VALUE THEIR ROLE'S ROW FILTERS READ (a user added before the file gained the attribute) — said at
 * the start and by `mason user list`, as the listener refuses their every statement (src/api/postgres/server.ts
 * withRows): each with its role, the attributes it lacks, and the commands that make it again with them.
 */
export function usersMissingAttributes(users: ReadonlyArray<{ name: string; role?: string | undefined; attributes?: Readonly<Record<string, unknown>> | undefined }>,
  live: Pick<RolesLive, "file" | "default" | "problem" | "grants">): Array<{ name: string; role: string; missing: string[] }> {
  if (live.problem !== null) return [];
  return users.flatMap((u) => {
    const role = userRole(u, live).role;
    const g = role === undefined ? undefined : live.grants.get(role);
    if (g?.filters === undefined) return [];
    const missing = missingAttributes(g.filters.values(), (u.attributes ?? {}) as Record<string, string>).map((m) => m.attr);
    return missing.length === 0 ? [] : [{ name: u.name, role: g.name, missing }];
  });
}

/** a user without a value its role's filters read, as `mason start` and `mason user list` say it: ONE wording */
export const missingAttributesText = (u: { name: string; role: string; missing: readonly string[] }): string =>
  `the user ${u.name} has no value for ${u.missing.join(", ")}, which the role ${u.role} filters rows by: its statements are refused — ` +
  `mason user remove ${u.name} && mason user add ${u.name} --role ${u.role} ${u.missing.map((a) => `--set ${a}=<value>`).join(" ")}`;

/** How a user's role is decided: its own (`mason user add --role`, "file"), the roles file's `default:` ("default"), or
 *  none ("none": no roles file, where it reads every synced table, or a file with no default, where it reads nothing). */
export type RoleFrom = "file" | "default" | "none";

/**
 * THE ROLE A USER IS HELD TO, as the listener decides it (src/api/postgres/server.ts Session.grants): its own, else the
 * file's default; `readsNothing` where the file names no default for a user with none. One function for `mason user
 * list`, `mason user add`, `mason start` and the web page, so they say what the listener does. A file that cannot be
 * read as it is now (`problem`) says nothing of a default — the listener refuses such a user 57P03 for the FILE, whose
 * way out is to repair it, never to write `default:` — so a roleless user is then neither defaulted nor "reads nothing".
 */
export function userRole(u: { role?: string | undefined }, live: Pick<RolesLive, "file" | "default" | "problem">): { role?: string; roleFrom: RoleFrom; readsNothing: boolean } {
  if (u.role !== undefined) return { role: u.role, roleFrom: "file", readsNothing: false };
  if (live.file === null || live.problem !== null) return { roleFrom: "none", readsNothing: false };
  if (live.default !== null) return { role: live.default, roleFrom: "default", readsNothing: false };
  return { roleFrom: "none", readsNothing: true };
}

/** The users with no role under a roles file that names no default — said at the start and by `mason user list`:
 *  their statements are refused until the file has a `default:` or the user is made again with a role. */
export function usersWithNoRole(users: ReadonlyArray<{ name: string; role?: string | undefined }>, live: Pick<RolesLive, "file" | "default" | "problem">): string[] {
  return users.filter((u) => userRole(u, live).readsNothing).map((u) => u.name);
}

/**
 * THE ROLES LINE `mason start` SAYS ONCE, after the listener's (as `syncDefaultLine` says the sources file's sync): what a
 * user added without --role reads, in the file's three states. `shown`: the roles file as messages name it.
 */
export function rolesDefaultLine(live: RolesLive, shown: string): string {
  if (live.file === null) return `roles: no ${shown}: every user reads every synced table; mason init writes one`;
  if (live.problem !== null) return `roles: ${live.file} cannot be read as it is now, so every user's statements are refused until it is fixed: ${live.problem}`;
  const names = [...live.grants.keys()];
  const head = `${names.length} role${names.length === 1 ? "" : "s"} from ${live.file}${names.length ? ` (${names.join(", ")})` : ""}`;
  return live.default !== null ? `${head}; default: ${live.default} (a user added without --role)` : `${head}; no default: a user with no role reads nothing`;
}

/**
 * THE ROLES FILE `mason init` WRITES (the one writer of its first text, as `newSourceText` is the sources file's): one
 * role reading every synced table, the default — today's access, said in a committed file — and a narrower role as a
 * comment, the shape to copy.
 */
export function newRolesText(): string {
  return `# Who may read what of the tables the sources file syncs. Yours to commit, beside sources/.
default: everything   # the role of a user added without --role (mason user add <name>)

roles:
  everything:
    tables: all       # every synced table and column, tables added to the sources file later included
  # A narrower role: mason user add agent --role agent. A bare name is in public, else schema.table;
  # {} every column, columns: [id, status] those, exclude: [email] every column but those.
  # agent:
  #   tables:
  #     orders: { columns: [id, status, amount] }
  #     customers: { exclude: [email] }
`;
}
