/**
 * ROLES: WHAT A USER MAY READ, HELD ON THE ANALYSED TREE (GitHub issue 30, stage 1: table and column grants per role).
 * A role is an entry of the project's roles file (`mason/roles.yml`, src/cli/roles.ts): for each copied table, every
 * column (`{}`), `columns:` or `exclude:`, the sources file's own words. A `mason user` carries a role
 * (src/duck/users.ts `MasonUser.role`); a user with none reads every copied table, as before.
 *
 * ENFORCED ON THE TREE POSTGRES ANALYSED, NEVER ON SQL TEXT: Postgres puts one `RTEPERMISSIONINFO` per relation in the
 * query tree it analyses (src/duck/analyze.ts), with `selectedCols` as its own bitmap of the columns the statement
 * reads — a column read inside a CTE, a subquery, a join's USING, a window, a WHERE or a CASE is in it; `SELECT *` lists
 * every column; `count(*)` reads none; a whole-row reference (`SELECT t FROM t`) is the bit for attnum 0, which means
 * every column. This is the information Postgres's own executor checks privileges with (ExecCheckPermissions), so an
 * alias, a subquery or a view cannot get around it: a view is expanded by Mason itself before the check
 * (src/duck/views.ts), so the check sees the tables it reads — stricter than Postgres, where a grant on the view
 * suffices, and said so in docs/POSTGRES-API.md.
 *
 * THE REFUSAL IS POSTGRES'S: 42501 `permission denied for table orders`, the words Postgres 18 answers whether the
 * table or one of its columns is missing from the grants (its executor names the table only), so a tool handles it as
 * it handles Postgres's. The DETAIL names the role and the first hidden column, the HINT what the role may read. The
 * rules are Postgres's too: `count(*)` over a table is answered when the role has any column of it; `SELECT *` over a
 * table the role has only part of is refused, never narrowed (a narrowed `*` would change the result's columns); a
 * system column (xmin, ctid) needs the whole table.
 */
import { StatementError } from "../api/postgres/server.ts";
import { catalogRows } from "./analyze.ts";
import type { TreeNode, TreeValue } from "./pgtree.ts";

/** What one role may read of one table: every column (`all`, the table's own grant), or `columns` alone. */
export interface TableGrant {
  /** `schema.table` */
  table: string;
  all: boolean;
  /** the columns it may read, resolved against the copy (an `exclude:` entry is written out); every column when `all` */
  columns: readonly string[];
}

/** One role's grants, resolved against the copied tables (src/cli/roles.ts `resolveRoles`). */
export interface RoleGrants {
  name: string;
  /** the roles file, as messages name it */
  file: string;
  /** by `schema.table` */
  tables: ReadonlyMap<string, TableGrant>;
}

/**
 * THE ROLES AS THE LISTENER READS THEM (`PgApiOptions.roles`): the SAME object until the roles file or the copied
 * tables change — the listener rebuilds the catalog Postgres (its roles and GRANTs) when it moves, as it does for the
 * schema. `problem`: the file cannot be read as it is now; `grants` is then the last good read (the catalog keeps
 * it), and every statement of a user whose session carries a role is refused until it is fixed: fail closed.
 */
export interface RolesLive {
  /** the roles file, as messages name it; null when the project has none */
  file: string | null;
  grants: ReadonlyMap<string, RoleGrants>;
  problem: string | null;
}

/** no roles file: every session reads every copied table, as before; one object, so the listener sees no change */
export const NO_ROLES: RolesLive = { file: null, grants: new Map(), problem: null };

/** `FirstLowInvalidHeapAttributeNumber` is -7: a column's bit in `selectedCols` is its attnum + 7 */
const ATTNUM_OFFSET = 7;
/** ACL_SELECT in `requiredPerms` */
const ACL_SELECT = 2;

/** A table read of the analysed tree: the catalog's OID of the relation and the columns Postgres says it reads. */
export interface TableRead {
  relid: number;
  /** the attnums read (> 0); a whole-row reference adds `wholeRow` */
  attnums: number[];
  /** `SELECT t FROM t`: every column */
  wholeRow: boolean;
  /** a system column (xmin, ctid …): the whole table's privilege, as Postgres asks it */
  system: boolean;
}

const isNode = (v: TreeValue | undefined): v is TreeNode => v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v);

/** Every RTEPERMISSIONINFO of the tree that asks SELECT, with its bitmap read as attnums. */
export function tableReads(tree: TreeValue): TableRead[] {
  const out: TableRead[] = [];
  const visit = (v: TreeValue | undefined): void => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (!isNode(v)) return;
    if (v._node === "RTEPERMISSIONINFO") {
      const perms = Number(v.requiredPerms ?? 0);
      const relid = Number(v.relid ?? 0);
      if ((perms & ACL_SELECT) !== 0 && relid > 0) {
        // a bitmapset prints as `(b 8 9)`: the `b` first, then each member
        const bits = Array.isArray(v.selectedCols) ? v.selectedCols.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x)).map(Number) : [];
        const read: TableRead = { relid, attnums: [], wholeRow: false, system: false };
        for (const b of bits) {
          const attnum = b - ATTNUM_OFFSET;
          if (attnum === 0) read.wholeRow = true;
          else if (attnum < 0) read.system = true;
          else read.attnums.push(attnum);
        }
        out.push(read);
      }
    }
    for (const [k, x] of Object.entries(v)) if (k !== "_node") visit(x);
  };
  visit(tree);
  return out;
}

/** A table read, named: the copied table (`schema.table`), the columns the statement reads of it, and all of its columns. */
export interface ResolvedRead {
  table: string;
  /** the columns read, in attnum order; every column of the table for a whole-row reference */
  columns: string[];
  /** every column the catalog holds for it */
  all: string[];
  system: boolean;
}

/**
 * The reads named through the catalog Postgres's own pg_class and pg_attribute (dropped columns left out, as Postgres
 * leaves them): the copied tables only (relkind r) — a view is never here, since Mason expands it before the plan is
 * made (src/duck/views.ts), and a catalog relation is not a copy.
 */
export async function resolveReads(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, reads: readonly TableRead[]): Promise<ResolvedRead[]> {
  if (reads.length === 0) return [];
  const relids = [...new Set(reads.map((r) => Math.trunc(r.relid)))];
  const rows = await catalogRows(catalog, `SELECT c.oid::text, n.nspname, c.relname, a.attnum::text, a.attname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
    `LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped WHERE c.oid IN (${relids.join(", ")}) AND c.relkind = 'r' ORDER BY c.oid, a.attnum`);
  const tables = new Map<number, { table: string; columns: Map<number, string> }>();
  for (const [oid, schema, name, attnum, attname] of rows) {
    const t = tables.get(Number(oid)) ?? { table: `${schema}.${name}`, columns: new Map<number, string>() };
    if (attnum !== null && attnum !== undefined && attname !== null && attname !== undefined) t.columns.set(Number(attnum), attname);
    tables.set(Number(oid), t);
  }
  const out: ResolvedRead[] = [];
  for (const r of reads) {
    const t = tables.get(r.relid);
    if (t === undefined) continue;
    const all = [...t.columns.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    const named = r.wholeRow ? all : [...r.attnums].sort((a, b) => a - b).map((n) => t.columns.get(n)).filter((n): n is string => n !== undefined);
    out.push({ table: t.table, columns: named, all, system: r.system });
  }
  return out;
}

/** a table as a tool writes it: its name alone in public, else schema.table (the sources file's own spelling) */
const shown = (table: string): string => table.startsWith("public.") ? table.slice("public.".length) : table;

/** The 42501 of a read the role does not cover, Postgres's words first; null when the role covers every read. */
export function grantRefusal(reads: readonly ResolvedRead[], role: RoleGrants): StatementError | null {
  const tablesOf = (): string => { const names = [...role.tables.keys()].map(shown); return names.length ? names.join(", ") : "none"; };
  for (const r of reads) {
    const g = role.tables.get(r.table);
    const denied = (detail: string, hint: string): StatementError =>
      new StatementError({ code: "42501", message: `permission denied for table ${r.table.replace(/^[^.]+\./, "")}`, detail, hint });
    if (g === undefined) {
      return denied(`the role ${role.name} has no grant on ${shown(r.table)}`, `the role ${role.name} reads: ${tablesOf()} (${role.file} names what each role reads; Mason gap roles)`);
    }
    if (g.all) continue;
    const may = `the role ${role.name} reads these columns of ${shown(r.table)}: ${g.columns.join(", ")} (${role.file} names what each role reads; Mason gap roles)`;
    if (r.system) return denied(`the role ${role.name} may read columns of ${shown(r.table)}, and a system column needs the whole table`, may);
    const hidden = r.columns.find((c) => !g.columns.includes(c));
    if (hidden !== undefined) return denied(`the role ${role.name} may not read column ${hidden} of ${shown(r.table)}`, may);
    // no column read (count(*)): any column of the table is enough, as Postgres rules it, and a grant names at least one
  }
  return null;
}

/**
 * The statement's table reads held to the role: the tree's reads named through the catalog, then refused where the role
 * does not cover one. Called by the plan (src/duck/plan.ts) after Postgres's analysis and the views' expansion, before
 * the rewrite — so Postgres's own refusal (an unknown column) comes first, and a role's before a Mason gap.
 */
export async function enforceGrants(catalog: (bytes: Uint8Array) => Promise<Uint8Array>, tree: TreeValue, role: RoleGrants | null): Promise<ResolvedRead[]> {
  const reads = await resolveReads(catalog, tableReads(tree));
  if (role !== null) {
    const refused = grantRefusal(reads, role);
    if (refused !== null) throw refused;
  }
  return reads;
}
