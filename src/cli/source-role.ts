/**
 * WHETHER THE ROLE MASON CONNECTS AS COULD WRITE TO THE SOURCE (issue 524), for `mason doctor`. Mason only reads the
 * database it syncs (CLAUDE.md "The source database is production"), so the role it connects as need not be able to
 * write either: one that can lets a Mason bug, or a stolen URL, change production. Said as WARNINGS, never a refusal:
 * a start goes on, and the way out is the statements that make a role that only reads.
 *
 * ONE catalog read (`ROLE_FACTS_SQL`), no write ever attempted, and every privilege decided by Postgres itself:
 * `has_table_privilege`, `has_any_column_privilege` (a column's INSERT, UPDATE or REFERENCES is a write too) and
 * `has_schema_privilege`, asked for the role and for every role it is a member of (`pg_has_role … 'MEMBER'`, the widest
 * membership: a role it may SET ROLE to without inheriting is counted too), and for PUBLIC, which every role holds; never
 * an ACL read by hand. A partitioned table's partitions are asked too: a partition can be written to directly.
 */
import { pgLiteral, type PgConnection } from "../cdc/pg-wire.ts";
import type { Check } from "./doctor.ts";

/** The privileges on a table that write or change it (SELECT is the one Mason needs). */
export const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

/** Each warning's code, stable for an agent: one per thing the role should not have (`role_unknown`: could not tell). */
export const ROLE_CODES = ["role_superuser", "role_bypassrls", "role_owns_table", "role_writes_table", "role_creates_in_schema", "role_unknown"] as const;
export type RoleCode = typeof ROLE_CODES[number];

/** The name the way out gives the role that only reads, or the first of `mason_reader2`, … not taken. */
export const READER_ROLE = "mason_reader";

/** What the doctor asks about: the synced tables, and what the way out must give the role besides SELECT. */
export interface RoleAsk {
  /** the sources file's tables, as the database names them */
  tables: ReadonlyArray<{ schema: string; table: string }>;
  /** the tables whose `sync:` is replication, `schema.table`: the role needs REPLICATION, and a publication carries them */
  replicated: readonly string[];
  /** the publication the file names (null: Mason makes its own, which needs a table's owner) */
  publication: string | null;
  /** the variable `url:` names (null: a URL written in the file), and where it was read (`DATABASE_URL in .env`) */
  urlVariable: string | null;
  urlFrom: string;
  /** the sources file, as messages name it */
  file: string;
  /** the database's URL (its password never printed: only its host, port and database are) */
  url: string;
}

/** A role the connected one is, or is a member of. */
export interface RoleFact { name: string; self: boolean; superuser: boolean; bypassrls: boolean }
/** A synced table, or a partition of one, and who may write to it. */
export interface RelationFact {
  /** `schema.table`, and as SQL names it (quote_ident's) */
  name: string; sql: string;
  /** a partition of a synced table (the entry it is under is `entry`) */
  partition: boolean; entry: string;
  schemaSql: string;
  owner: string;
  /** the owner is the role or one it is a member of */
  owned: boolean;
  rowSecurity: boolean;
  /** each role of `roles` (and PUBLIC) holding a write privilege on it, with those it holds; empty under a superuser */
  privileges: Array<{ role: string; privileges: string[] }>;
}
/** A schema a synced table is in. */
export interface SchemaFact { name: string; sql: string; owner: string; owned: boolean; create: string[]; publicCreate: boolean }

export interface RoleFacts {
  user: string; userSql: string; databaseSql: string;
  roles: RoleFact[];
  relations: RelationFact[];
  schemas: SchemaFact[];
  /** tables the file names that the database does not have (mason start says so): nothing to write to */
  missing: string[];
  /** role names taken that the way out would use */
  taken: string[];
  /** the managed Postgres whose role `rds_replication` replicates (REPLICATION cannot be granted there) */
  rdsReplication: boolean;
}

/**
 * Everything the checks read, in ONE statement, for the tables `tables` names (a JSON list of {schema, table}).
 * A superuser holds every privilege: what else it holds is not asked.
 */
export function roleFactsSql(tables: RoleAsk["tables"]): string {
  const want = pgLiteral(JSON.stringify(tables.map((t) => ({ schema: t.schema, table: t.table }))));
  const writes = WRITE_PRIVILEGES.map((p) => `'${p}'`).join(", ");
  return `WITH me AS (SELECT oid, rolname, rolsuper FROM pg_roles WHERE rolname = current_user),
r AS (SELECT p.oid, p.rolname, p.rolsuper, p.rolbypassrls, p.oid = me.oid AS self FROM pg_roles p, me
  WHERE p.oid = me.oid OR (NOT me.rolsuper AND pg_has_role(me.oid, p.oid, 'MEMBER'))),
su AS (SELECT EXISTS (SELECT FROM r WHERE rolsuper) AS any),
want AS (SELECT w.schema, w."table" FROM json_to_recordset(${want}::json) AS w(schema text, "table" text)),
rel AS (SELECT w.schema, w."table", c.oid, c.relkind FROM want w JOIN pg_namespace n ON n.nspname = w.schema
  JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = w."table" AND c.relkind IN ('r', 'p')),
part AS (SELECT schema || '.' || "table" AS entry, oid, false AS partition FROM rel
  UNION SELECT rel.schema || '.' || rel."table", pt.relid, true FROM rel CROSS JOIN LATERAL pg_partition_tree(rel.oid) pt WHERE rel.relkind = 'p' AND pt.relid <> rel.oid),
who AS (SELECT rolname AS role, CASE WHEN self THEN 0 ELSE 1 END AS ord FROM r UNION ALL SELECT 'public', 2)
SELECT json_build_object(
  'user', me.rolname, 'user_sql', quote_ident(me.rolname), 'database_sql', quote_ident(current_database()),
  'roles', (SELECT json_agg(json_build_object('name', rolname, 'self', self, 'superuser', rolsuper, 'bypassrls', rolbypassrls) ORDER BY NOT self, rolname) FROM r),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', n.nspname || '.' || c.relname, 'sql', quote_ident(n.nspname) || '.' || quote_ident(c.relname),
      'partition', x.partition, 'entry', x.entry, 'schema_sql', quote_ident(n.nspname), 'owner', pg_get_userbyid(c.relowner),
      'owned', c.relowner IN (SELECT oid FROM r), 'row_security', c.relrowsecurity,
      'privileges', CASE WHEN su.any THEN '[]'::json ELSE (SELECT coalesce(json_agg(json_build_object('role', CASE WHEN g.ord = 2 THEN 'PUBLIC' ELSE g.role END, 'privileges', g.privs) ORDER BY g.ord, g.role), '[]'::json)
        FROM (SELECT w.role, w.ord, (SELECT coalesce(array_agg(u.p ORDER BY u.o), '{}') FROM unnest(ARRAY[${writes}]) WITH ORDINALITY AS u(p, o)
            -- a column's INSERT, UPDATE or REFERENCES writes too: has_any_column_privilege asks the table's and every column's
            WHERE CASE WHEN u.p IN ('INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege(w.role::name, c.oid, u.p) ELSE has_table_privilege(w.role::name, c.oid, u.p) END) AS privs
          FROM who w) g WHERE cardinality(g.privs) > 0) END) ORDER BY x.partition, x.entry, n.nspname, c.relname), '[]'::json)
    FROM part x JOIN pg_class c ON c.oid = x.oid JOIN pg_namespace n ON n.oid = c.relnamespace),
  'schemas', (SELECT coalesce(json_agg(json_build_object('name', n.nspname, 'sql', quote_ident(n.nspname), 'owner', pg_get_userbyid(n.nspowner),
      'owned', n.nspowner IN (SELECT oid FROM r),
      'create', CASE WHEN su.any THEN '[]'::json ELSE (SELECT coalesce(json_agg(rr.rolname ORDER BY NOT rr.self, rr.rolname), '[]'::json) FROM r rr WHERE has_schema_privilege(rr.rolname, n.oid, 'CREATE')) END,
      'public_create', has_schema_privilege('public'::name, n.oid, 'CREATE')) ORDER BY n.nspname), '[]'::json)
    FROM pg_namespace n WHERE n.oid IN (SELECT c.relnamespace FROM part JOIN pg_class c ON c.oid = part.oid)),
  'missing', (SELECT coalesce(json_agg(w.schema || '.' || w."table"), '[]'::json) FROM want w WHERE NOT EXISTS (SELECT FROM rel WHERE rel.schema = w.schema AND rel."table" = w."table")),
  'taken', (SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]'::json) FROM pg_roles WHERE rolname LIKE '${READER_ROLE.replace(/_/g, "\\_")}%'),
  'rds_replication', EXISTS (SELECT FROM pg_roles WHERE rolname = 'rds_replication')
)::text FROM me, su`;
}

interface FactsRow {
  user: string; user_sql: string; database_sql: string;
  roles: Array<{ name: string; self: boolean; superuser: boolean; bypassrls: boolean }>;
  relations: Array<{ name: string; sql: string; partition: boolean; entry: string; schema_sql: string; owner: string; owned: boolean; row_security: boolean; privileges: Array<{ role: string; privileges: string[] }> }>;
  schemas: Array<{ name: string; sql: string; owner: string; owned: boolean; create: string[]; public_create: boolean }>;
  missing: string[]; taken: string[]; rds_replication: boolean;
}

/** The role's facts, read in the one statement; a role with no row of pg_roles (it was dropped while connected) throws. */
export async function readRoleFacts(pg: Pick<PgConnection, "query">, tables: RoleAsk["tables"]): Promise<RoleFacts> {
  const row = JSON.parse((await pg.query(roleFactsSql(tables))).rows[0]?.[0] ?? "null") as FactsRow | null;
  if (row === null) throw new Error("pg_roles has no row for the user connected");
  return {
    user: row.user, userSql: row.user_sql, databaseSql: row.database_sql,
    roles: row.roles,
    relations: row.relations.map((x) => ({ name: x.name, sql: x.sql, partition: x.partition, entry: x.entry, schemaSql: x.schema_sql, owner: x.owner, owned: x.owned,
      rowSecurity: x.row_security, privileges: x.privileges })),
    schemas: row.schemas.map((s) => ({ name: s.name, sql: s.sql, owner: s.owner, owned: s.owned, create: s.create, publicCreate: s.public_create })),
    missing: row.missing, taken: row.taken, rdsReplication: row.rds_replication,
  };
}

const list = (xs: readonly string[]): string => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)!}`;

/** "through writers", "granted to PUBLIC": how a role came to hold something it holds by another */
function route(others: readonly string[]): string {
  const roles = others.filter((r) => r !== "PUBLIC");
  const parts = [...(roles.length ? [`through ${list(roles)}, which it is a member of`] : []), ...(others.includes("PUBLIC") ? ["granted to PUBLIC, which every role is"] : [])];
  return parts.length ? ` (${parts.join("; ")})` : "";
}

const WHY = "Mason only reads, so a role that may write lets a Mason bug or a stolen URL change your database";

/** The checks of the role, from its facts: one warning per code that applies, else one line saying it only reads. */
export function roleChecks(f: RoleFacts, ask: RoleAsk): Check[] {
  const fix = readOnlyFix(f, ask);
  const warn = (code: RoleCode, detail: string): Check => ({ name: "role", ok: true, warn: true, code, detail: `${detail}. ${WHY}: sync as a role that only reads`, fix });
  const out: Check[] = [];
  const supers = f.roles.filter((r) => r.superuser);
  if (supers.length) {
    // a superuser may do everything: what else it holds follows from it, and is not said again
    const self = supers.some((r) => r.self);
    out.push(warn("role_superuser", self ? `${f.user} is a superuser: it may write to, alter or drop anything on this database`
      : `${f.user} is a member of ${list(supers.map((r) => r.name))}, a superuser: it may SET ROLE to it and write to, alter or drop anything on this database`));
    return out;
  }
  const bypass = f.roles.filter((r) => r.bypassrls);
  if (bypass.length) {
    out.push(warn("role_bypassrls", `${f.user} has BYPASSRLS${route(bypass.filter((r) => !r.self).map((r) => r.name))}: row-level security does not apply to it, on any table`));
  }
  const owned = f.relations.filter((x) => x.owned);
  if (owned.length) {
    const others = [...new Set(owned.map((x) => x.owner).filter((o) => o !== f.user))];
    out.push(warn("role_owns_table", `${f.user} owns ${list(owned.map((x) => x.partition ? `${x.name} (a partition of ${x.entry})` : x.name))}${route(others)}: ` +
      "an owner may write to, alter or drop a table whatever is granted"));
  }
  const writable = f.relations.filter((x) => x.privileges.length > 0);
  if (writable.length) {
    const held = writable.map((x) => {
      const privs = WRITE_PRIVILEGES.filter((p) => x.privileges.some((g) => g.privileges.includes(p)));
      const others = x.privileges.filter((g) => g.role !== f.user).map((g) => g.role);
      return `${privs.join(", ")} on ${x.name}${x.partition ? ` (a partition of ${x.entry})` : ""}${route(others)}`;
    });
    out.push(warn("role_writes_table", `${f.user} may ${held.join("; ")}`));
  }
  const creates = f.schemas.filter((s) => s.create.length > 0 || s.publicCreate);
  if (creates.length) {
    const held = creates.map((s) => `CREATE in schema ${s.name}${s.owned ? ` (${s.owner === f.user ? "it owns the schema" : `${s.owner}, which owns the schema`}: it may drop what is in it too)` : route([...s.create.filter((r) => r !== f.user), ...(s.publicCreate ? ["PUBLIC"] : [])])}`);
    out.push(warn("role_creates_in_schema", `${f.user} may ${held.join("; ")}: it may make tables and functions beside the synced ones`));
  }
  if (out.length) return out;
  const unread = f.missing.length ? ` (not asked of ${list(f.missing)}, which the database does not have: mason start says so)` : "";
  const what = f.relations.some((x) => !x.partition) ? `the ${f.relations.filter((x) => !x.partition).length} synced table(s)` : "no synced table yet";
  return [{ name: "role", ok: true, detail: `${f.user} only reads: no superuser or BYPASSRLS, and owns, may write to or CREATE beside ${what === "no synced table yet" ? "none of the synced tables (none added yet: asked again once one is)" : what}${unread}` }];
}

/** The line a check is when the role could not be asked: said, never taken for "only reads". */
export function roleUnknown(why: string): Check {
  return { name: "role", ok: null, code: "role_unknown", detail: `could not tell whether the user Mason connects as may write to the database: ${why}` };
}

/** The URL `url` with `role` as its user and a placeholder for its password, nothing else of it changed. */
export function readerUrl(url: string, role: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${role}:<its password>@${u.host}${u.pathname}${u.search}`;
  } catch {
    return `the database's URL with ${role} and its password as the user and password`;   // not a URL: said in words
  }
}

/**
 * THE WAY OUT, as the statements the database's owner runs, then the line of the project to change: a role that may
 * LOGIN and SELECT the synced tables and nothing else — REPLICATION where a table streams, and the publication made by
 * the owner when Mason would make its own (CREATE PUBLICATION … FOR TABLE needs the tables' owner); a policy where a
 * table has row-level security (the new role would read no row of it); PUBLIC's write privileges revoked, which every
 * role holds, the new one too.
 */
export function readOnlyFix(f: RoleFacts, ask: RoleAsk): string {
  let role: string = READER_ROLE;
  for (let n = 2; f.taken.includes(role); n++) role = `${READER_ROLE}${n}`;
  const tables = f.relations.filter((x) => !x.partition);
  const schemas = [...new Set(tables.map((x) => x.schemaSql))];
  const replication = ask.replicated.length > 0;
  const replicating = replication && !f.rdsReplication;
  const lines: string[] = [`-- as the database's owner (on the primary):`,
    `CREATE ROLE ${role} LOGIN${replicating ? " REPLICATION" : ""} PASSWORD '<a new password>';`];
  if (replication && f.rdsReplication) lines.push(`GRANT rds_replication TO ${role};`);
  lines.push(`GRANT CONNECT ON DATABASE ${f.databaseSql} TO ${role};`);
  if (tables.length) {
    lines.push(`GRANT USAGE ON SCHEMA ${schemas.join(", ")} TO ${role};`, `GRANT SELECT ON ${tables.map((x) => x.sql).join(", ")} TO ${role};`);
  } else {
    lines.push(`-- and GRANT USAGE ON SCHEMA <schema>, SELECT ON <table> TO ${role}, for each table you add`);
  }
  for (const x of tables.filter((t) => t.rowSecurity)) lines.push(`CREATE POLICY ${role}_reads ON ${x.sql} FOR SELECT TO ${role} USING (true);   -- row-level security: else it reads no row`);
  const publicCreate = f.schemas.filter((s) => s.publicCreate);
  if (publicCreate.length) lines.push(`REVOKE CREATE ON SCHEMA ${publicCreate.map((s) => s.sql).join(", ")} FROM PUBLIC;   -- PUBLIC's, which every role holds (the default before Postgres 15)`);
  for (const x of f.relations) {
    const pub = x.privileges.find((g) => g.role === "PUBLIC");
    if (pub) lines.push(`REVOKE ${pub.privileges.join(", ")} ON ${x.sql} FROM PUBLIC;   -- PUBLIC's, which every role holds`);
  }
  // what Mason's own would carry (src/duck/sync.ts ensurePublication): the replicated tables, every change
  const published = tables.filter((x) => ask.replicated.includes(x.entry));
  const ownPublication = ask.publication === null && published.length > 0;
  if (ownPublication) {
    lines.push(`CREATE PUBLICATION ${role} FOR TABLE ${published.map((x) => x.sql).join(", ")} WITH (publish = 'insert, update, delete, truncate');   -- Mason's own needs the tables' owner`);
  }
  lines.push("-- and GRANT SELECT ON each view Mason should serve: it serves the views the role it connects as may read");
  // the app's own DATABASE_URL stays the app's: Mason's gets a variable of its own
  const variable = ask.urlVariable === null || ask.urlVariable === "DATABASE_URL" ? "MASON_DATABASE_URL" : ask.urlVariable;
  const own = variable !== ask.urlVariable;
  lines.push(`then: set ${variable}=${readerUrl(ask.url, role)} ${own ? "in .env" : `where it is set now (${ask.urlFrom})`}` +
    `${own ? ` and write url: \${${variable}} in ${ask.file}` : ""}${ownPublication ? `${own ? "," : " and"} publication: ${role} at its top` : ""}` +
    "; mason doctor checks it again, and a running Mason reads it at its next start (mason stop, then mason start)");
  return lines.join("\n");
}
