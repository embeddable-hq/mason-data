/**
 * WHETHER THE ROLE MASON CONNECTS AS COULD WRITE TO THE SOURCE (issue 524), for `mason doctor`. Mason only reads the
 * database it syncs (CLAUDE.md "The source database is production"), so the role it connects as need not be able to
 * write either: one that can lets a Mason bug, or a stolen URL, change production. Said as WARNINGS, never a refusal:
 * a start goes on, and the way out is the statements that make a role that only reads.
 *
 * ONE catalog read (`roleFactsSql`), no write ever attempted, and every privilege decided by Postgres itself:
 * `has_table_privilege`, `has_any_column_privilege` (a column's INSERT, UPDATE or REFERENCES is a write too),
 * `has_schema_privilege` and `has_function_privilege`, asked for the role, for every role whose privileges it holds or
 * may SET ROLE to (`pg_has_role … 'USAGE'` or `'SET'` from Postgres 16; `'MEMBER'` before, when any membership could
 * SET ROLE), and for PUBLIC, which every role holds; never an ACL read by hand.
 *
 * THE CLASS (PR 572's review, two rounds): every way Postgres lets a role change a synced table's rows WITHOUT a
 * privilege on that table, each read from its catalog. The "only reads" line is true by construction because each is
 * asked, and over-approximated where the catalog cannot say more (a warning too many, never one too few):
 *   - DECLARATIVE ROUTES, followed transitively (`reach`): a descendant by `pg_inherits` (a partition, or an INHERITS
 *     child, whose rows ARE the synced table's: every privilege); an INHERITS ancestor (an UPDATE, DELETE or TRUNCATE
 *     on it reaches its children's rows, Postgres asking only the parent's privilege); a relation whose rules depend on
 *     a route (`pg_rewrite` through `pg_depend`: a view at any depth, or another table's rule), for the INSERT, UPDATE
 *     and DELETE `pg_relation_is_updatable` says it takes; and a table a route's foreign key references with an ON
 *     DELETE or ON UPDATE action that writes (`pg_constraint` `confdeltype` / `confupdtype` CASCADE, SET NULL or SET
 *     DEFAULT), whose action runs as the referencing table's owner. TRUNCATE … CASCADE is no route: Postgres asks
 *     TRUNCATE on every table it cascades to (measured on 16).
 *   - CODE THAT RUNS AS ANOTHER ROLE: a SECURITY DEFINER function whose owner may write a route (a superuser, or one
 *     holding a route's privilege), not the role's own, that it may reach — it may EXECUTE it, a trigger calls it on a
 *     relation it may write, an event trigger calls it (on any DDL, even one refused), or any other catalog object
 *     calls it (an aggregate, a type, an operator, …: Postgres calls those without asking EXECUTE). Code of invoker's
 *     rights runs with the role's own privileges, which the rest asks.
 *   - ANOTHER IDENTITY BY CONNECTION: a foreign table it may write, or a user mapping on a server it may use (postgres_fdw,
 *     dblink): what it sends runs as the mapping's user, maybe on this very database.
 *   - BECOMING ANOTHER ROLE: ADMIN OPTION on a role (it may grant itself that role), CREATEROLE before Postgres 16 (any
 *     role but a superuser), and pg_execute_server_program, pg_write_server_files or pg_read_server_files (the server's
 *     programs and files as its operating-system user).
 * Not routes: COPY … FROM needs INSERT, which is asked; a large object is not a table's rows; a publication only reads;
 * a subscription writes as its owner, with that owner's privileges, and a table it fills is written from another
 * database, which this database cannot see.
 *
 * The statement runs under `search_path = pg_catalog` (`SET LOCAL`, ending with it, as VIEWS_SQL does), so no function,
 * operator or table of the role's own schemas can stand in for the catalog's.
 */
import { pgLiteral, type PgConnection } from "../cdc/pg-wire.ts";
import type { Check } from "./doctor.ts";

/** The privileges on a table that write or change it (SELECT is the one Mason needs), in their bit order (`mask`). */
export const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

/** Each warning's code, stable for an agent: one per thing the role should not have (`role_unknown`: could not tell). */
export const ROLE_CODES = ["role_superuser", "role_bypassrls", "role_owns_table", "role_writes_table", "role_creates_in_schema",
  "role_runs_definer_code", "role_reaches_foreign_server", "role_may_become_another", "role_unknown"] as const;
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

/** A role the connected one is, or holds the privileges of, or may SET ROLE to. */
export interface RoleFact { name: string; self: boolean; superuser: boolean; bypassrls: boolean }
/** How a relation reaches a synced table's rows: it IS one; a partition or INHERITS child of one; an INHERITS parent of
 *  one; a table one's foreign key acts on; a view over one; another relation whose rules write one (at any depth). */
export type RelationKind = "table" | "partition" | "child" | "parent" | "referenced" | "view" | "rule";
/** A synced table, or a relation that reaches its rows, and who may write to it. */
export interface RelationFact {
  /** `schema.table`, and as SQL names it (quote_ident's) */
  name: string; sql: string;
  /** how it reaches the synced table `entry` */
  kind: RelationKind; entry: string;
  schemaSql: string;
  owner: string;
  /** a table, partition or child whose owner is the role or one of `roles` (any other route's owner writes through it
   *  only what its privileges say: those are asked) */
  owned: boolean;
  rowSecurity: boolean;
  /** each role of `roles` (and PUBLIC) holding a privilege that reaches the synced rows through it, with those it holds:
   *  every write privilege of a table, partition or child; UPDATE, DELETE, TRUNCATE of a parent; the DELETE or UPDATE a
   *  foreign key acts on; the INSERT, UPDATE, DELETE a view or rule takes. Empty under a superuser */
  privileges: Array<{ role: string; privileges: string[] }>;
}
/** A schema a synced table is in. */
export interface SchemaFact { name: string; sql: string; owner: string; owned: boolean; create: string[]; publicCreate: boolean }
/** A SECURITY DEFINER function whose owner may write a synced table's rows, and how the role reaches it. */
export interface DefinerFact {
  /** `schema.name(args)`, as SQL names it */
  name: string; owner: string; ownerSuperuser: boolean;
  /** the role (or a role of `roles`, or PUBLIC) may EXECUTE it */
  callable: boolean; publicCallable: boolean;
  /** relations it may write whose enabled trigger calls it */
  triggers: string[];
  /** an enabled event trigger calls it */
  eventTrigger: boolean;
  /** another catalog object calls it (an aggregate, a type, an operator, …), never asking EXECUTE */
  used: boolean;
}

export interface RoleFacts {
  user: string; userSql: string; databaseSql: string;
  roles: RoleFact[];
  relations: RelationFact[];
  schemas: SchemaFact[];
  definers: DefinerFact[];
  /** foreign tables it may write; servers with a user mapping for it (or PUBLIC) that it may use */
  foreignTables: string[]; mappedServers: string[];
  /** roles it holds ADMIN OPTION on; CREATEROLE before Postgres 16; the server's predefined roles among `roles` */
  adminOf: string[]; createRole: boolean; serverRoles: string[];
  /** tables the file names that the database does not have (mason start says so): nothing to write to */
  missing: string[];
  /** role names taken that the way out would use */
  taken: string[];
  /** the managed Postgres whose role `rds_replication` replicates (REPLICATION cannot be granted there) */
  rdsReplication: boolean;
}

/** Whether `role` holds privilege `p` on relation `rel` (SQL expressions): a column's INSERT, UPDATE or REFERENCES counts */
const holds = (role: string, rel: string, p: string): string =>
  `CASE WHEN ${p} IN ('INSERT', 'UPDATE', 'REFERENCES') THEN has_any_column_privilege(${role}, ${rel}, ${p}) ELSE has_table_privilege(${role}, ${rel}, ${p}) END`;

/** The predefined roles that reach the server's programs or files (a superuser's, in effect) */
export const SERVER_ROLES = ["pg_execute_server_program", "pg_write_server_files", "pg_read_server_files"] as const;

/**
 * Everything the checks read, in ONE statement under the catalog's search_path, for the tables `tables` names (a JSON
 * list of {schema, table}). A superuser holds every privilege: what else it holds is not asked.
 */
export function roleFactsSql(tables: RoleAsk["tables"]): string {
  const want = pgLiteral(JSON.stringify(tables.map((t) => ({ schema: t.schema, table: t.table }))));
  const writes = WRITE_PRIVILEGES.map((p) => `'${p}'`).join(", ");
  const all = (1 << WRITE_PRIVILEGES.length) - 1, ins = 1, upd = 2, del = 4, trunc = 8;
  return `SET LOCAL search_path = pg_catalog; WITH RECURSIVE me AS (SELECT oid, rolname, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user),
-- the roles whose privileges it holds or that it may switch to (Postgres 16 split the two, before it any membership was both)
r AS (SELECT p.oid, p.rolname, p.rolsuper, p.rolbypassrls, p.oid = me.oid AS self FROM pg_roles p, me
  WHERE p.oid = me.oid OR (NOT me.rolsuper AND CASE WHEN current_setting('server_version_num')::int >= 160000
    THEN pg_has_role(me.oid, p.oid, 'USAGE') OR pg_has_role(me.oid, p.oid, 'SET') ELSE pg_has_role(me.oid, p.oid, 'MEMBER') END)),
su AS (SELECT EXISTS (SELECT FROM r WHERE rolsuper) AS any),
want AS (SELECT w.schema, w."table" FROM json_to_recordset(${want}::json) AS w(schema text, "table" text)),
rel AS (SELECT w.schema, w."table", c.oid FROM want w JOIN pg_namespace n ON n.nspname = w.schema
  JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = w."table" AND c.relkind IN ('r', 'p')),
-- how a write on one relation reaches another's rows. need: the modes it leaves from (S a synced table, R its rows'
-- relation, A an ancestor, F a referenced table, V a view or rule), gives: the mode it reaches, mask: the privileges
-- (bits in WRITE_PRIVILEGES' order) that reach, a view's or rule's read from pg_relation_is_updatable below
edge AS (SELECT inhparent AS src, inhrelid AS dst, 'SR' AS need, 'R' AS gives, ${all} AS mask FROM pg_inherits
  UNION ALL SELECT inhrelid, inhparent, 'SRAF', 'A', ${upd | del | trunc} FROM pg_inherits
  UNION ALL SELECT d.refobjid, rw.ev_class, 'SRAFV', 'V', 0 FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid
    WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND rw.ev_class <> d.refobjid
  UNION ALL SELECT conrelid, confrelid, 'SRF', 'F', CASE WHEN confdeltype IN ('c', 'n', 'd') THEN ${del} ELSE 0 END | CASE WHEN confupdtype IN ('c', 'n', 'd') THEN ${upd} ELSE 0 END
    FROM pg_constraint WHERE contype = 'f' AND (confdeltype IN ('c', 'n', 'd') OR confupdtype IN ('c', 'n', 'd'))),
-- each synced table and every relation that reaches its rows, at any depth: UNION stops at what it has seen
reach AS (SELECT schema || '.' || "table" AS entry, oid, 'S' AS mode, ${all} AS mask FROM rel
  UNION SELECT x.entry, e.dst, e.gives, e.mask FROM reach x JOIN edge e ON e.src = x.oid AND position(x.mode IN e.need) > 0),
route AS (SELECT x.entry, x.oid, min(position(x.mode IN 'SRAFV')) AS rank,
    bit_or(CASE WHEN x.mode <> 'V' THEN x.mask ELSE CASE WHEN k.u & 8 <> 0 THEN ${ins} ELSE 0 END | CASE WHEN k.u & 4 <> 0 THEN ${upd} ELSE 0 END | CASE WHEN k.u & 16 <> 0 THEN ${del} ELSE 0 END END) AS mask
  FROM reach x CROSS JOIN LATERAL (SELECT CASE WHEN x.mode = 'V' THEN pg_relation_is_updatable(x.oid, true) ELSE 0 END AS u) k GROUP BY x.entry, x.oid),
-- each privilege that reaches a synced table's rows through a route
asks AS (SELECT x.entry, x.oid, u.p, u.o FROM route x CROSS JOIN unnest(ARRAY[${writes}]) WITH ORDINALITY AS u(p, o) WHERE x.mask & (1 << (u.o::int - 1)) <> 0),
who AS (SELECT rolname AS role, CASE WHEN self THEN 0 ELSE 1 END AS ord FROM r UNION ALL SELECT 'public', 2),
-- SECURITY DEFINER code whose owner (not the role's own) may write a synced table's rows
definer AS (SELECT f.oid, f.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype) AS direct, quote_ident(n.nspname) || '.' || quote_ident(f.proname) || '(' || pg_get_function_identity_arguments(f.oid) || ')' AS name,
    o.rolname AS owner, o.rolsuper AS owner_super
  FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace JOIN pg_roles o ON o.oid = f.proowner, su
  WHERE f.prosecdef AND NOT su.any AND f.proowner NOT IN (SELECT oid FROM r)
    AND (o.rolsuper OR EXISTS (SELECT FROM asks a WHERE ${holds("o.rolname", "a.oid", "a.p")})))
SELECT json_build_object(
  'user', me.rolname, 'user_sql', quote_ident(me.rolname), 'database_sql', quote_ident(current_database()),
  'roles', (SELECT json_agg(json_build_object('name', rolname, 'self', self, 'superuser', rolsuper, 'bypassrls', rolbypassrls) ORDER BY NOT self, rolname) FROM r),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', n.nspname || '.' || c.relname, 'sql', quote_ident(n.nspname) || '.' || quote_ident(c.relname),
      'kind', CASE x.rank WHEN 1 THEN 'table' WHEN 2 THEN CASE WHEN c.relispartition THEN 'partition' ELSE 'child' END WHEN 3 THEN 'parent' WHEN 4 THEN 'referenced'
        ELSE CASE WHEN c.relkind = 'v' THEN 'view' ELSE 'rule' END END,
      'entry', x.entry, 'schema_sql', quote_ident(n.nspname), 'owner', pg_get_userbyid(c.relowner),
      'owned', x.rank <= 2 AND c.relowner IN (SELECT oid FROM r), 'row_security', c.relrowsecurity,
      'privileges', CASE WHEN su.any THEN '[]'::json ELSE (SELECT coalesce(json_agg(json_build_object('role', CASE WHEN g.ord = 2 THEN 'PUBLIC' ELSE g.role END, 'privileges', g.privs) ORDER BY g.ord, g.role), '[]'::json)
        FROM (SELECT w.role, w.ord, (SELECT coalesce(array_agg(a.p ORDER BY a.o), '{}') FROM asks a WHERE a.entry = x.entry AND a.oid = x.oid AND ${holds("w.role::name", "a.oid", "a.p")}) AS privs
          FROM who w) g WHERE cardinality(g.privs) > 0) END) ORDER BY x.rank, x.entry, n.nspname, c.relname), '[]'::json)
    FROM route x JOIN pg_class c ON c.oid = x.oid JOIN pg_namespace n ON n.oid = c.relnamespace),
  'schemas', (SELECT coalesce(json_agg(json_build_object('name', n.nspname, 'sql', quote_ident(n.nspname), 'owner', pg_get_userbyid(n.nspowner),
      'owned', n.nspowner IN (SELECT oid FROM r),
      'create', CASE WHEN su.any THEN '[]'::json ELSE (SELECT coalesce(json_agg(rr.rolname ORDER BY NOT rr.self, rr.rolname), '[]'::json) FROM r rr WHERE has_schema_privilege(rr.rolname, n.oid, 'CREATE')) END,
      'public_create', has_schema_privilege('public'::name, n.oid, 'CREATE')) ORDER BY n.nspname), '[]'::json)
    FROM pg_namespace n WHERE n.oid IN (SELECT c.relnamespace FROM route x JOIN pg_class c ON c.oid = x.oid WHERE x.rank <= 2)),
  'definers', (SELECT coalesce(json_agg(d ORDER BY d.name), '[]'::json) FROM (
      SELECT df.name, df.owner, df.owner_super,
        -- a trigger's function is called only by its trigger, whatever EXECUTE says
        df.direct AND EXISTS (SELECT FROM who w WHERE has_function_privilege(w.role::name, df.oid, 'EXECUTE')) AS callable,
        df.direct AND has_function_privilege('public'::name, df.oid, 'EXECUTE') AS public_callable,
        (SELECT coalesce(json_agg(DISTINCT tn.nspname || '.' || tc.relname), '[]'::json) FROM pg_trigger t JOIN pg_class tc ON tc.oid = t.tgrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
          WHERE t.tgfoid = df.oid AND NOT t.tgisinternal AND t.tgenabled <> 'D'
            AND EXISTS (SELECT FROM who w, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS u(p) WHERE ${holds("w.role::name", "t.tgrelid", "u.p")})) AS triggers,
        EXISTS (SELECT FROM pg_event_trigger e WHERE e.evtfoid = df.oid AND e.evtenabled <> 'D') AS event_trigger,
        EXISTS (SELECT FROM pg_depend dd WHERE dd.refclassid = 'pg_proc'::regclass AND dd.refobjid = df.oid
          AND dd.classid NOT IN ('pg_trigger'::regclass, 'pg_event_trigger'::regclass)) AS used
      FROM definer df) d WHERE d.callable OR json_array_length(d.triggers) > 0 OR d.event_trigger OR d.used),
  'foreign_tables', CASE WHEN su.any THEN '[]'::json ELSE (SELECT coalesce(json_agg(n.nspname || '.' || c.relname ORDER BY n.nspname, c.relname), '[]'::json)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'f'
      AND EXISTS (SELECT FROM who w, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS u(p) WHERE ${holds("w.role::name", "c.oid", "u.p")})) END,
  'mapped_servers', CASE WHEN su.any THEN '[]'::json ELSE (SELECT coalesce(json_agg(DISTINCT m.srvname), '[]'::json) FROM pg_user_mappings m
    WHERE (m.umuser = 0 OR m.umuser IN (SELECT oid FROM r)) AND EXISTS (SELECT FROM who w WHERE has_server_privilege(w.role::name, m.srvid, 'USAGE'))) END,
  'admin_of', CASE WHEN su.any THEN '[]'::json ELSE (SELECT coalesce(json_agg(p.rolname ORDER BY p.rolname), '[]'::json) FROM pg_roles p
    WHERE p.oid <> me.oid AND pg_has_role(me.oid, p.oid, 'MEMBER WITH ADMIN OPTION')) END,
  'create_role', NOT su.any AND me.rolcreaterole AND current_setting('server_version_num')::int < 160000,
  'server_roles', (SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]'::json) FROM r WHERE NOT su.any AND rolname IN (${SERVER_ROLES.map((x) => `'${x}'`).join(", ")})),
  'missing', (SELECT coalesce(json_agg(w.schema || '.' || w."table"), '[]'::json) FROM want w WHERE NOT EXISTS (SELECT FROM rel WHERE rel.schema = w.schema AND rel."table" = w."table")),
  'taken', (SELECT coalesce(json_agg(rolname ORDER BY rolname), '[]'::json) FROM pg_roles WHERE rolname LIKE '${READER_ROLE.replace(/_/g, "\\_")}%'),
  'rds_replication', EXISTS (SELECT FROM pg_roles WHERE rolname = 'rds_replication')
)::text FROM me, su`;
}

interface FactsRow {
  user: string; user_sql: string; database_sql: string;
  roles: Array<{ name: string; self: boolean; superuser: boolean; bypassrls: boolean }>;
  relations: Array<{ name: string; sql: string; kind: RelationKind; entry: string; schema_sql: string; owner: string; owned: boolean; row_security: boolean; privileges: Array<{ role: string; privileges: string[] }> }>;
  schemas: Array<{ name: string; sql: string; owner: string; owned: boolean; create: string[]; public_create: boolean }>;
  definers: Array<{ name: string; owner: string; owner_super: boolean; callable: boolean; public_callable: boolean; triggers: string[]; event_trigger: boolean; used: boolean }>;
  foreign_tables: string[]; mapped_servers: string[]; admin_of: string[]; create_role: boolean; server_roles: string[];
  missing: string[]; taken: string[]; rds_replication: boolean;
}

/** The role's facts, read in the one statement; a role with no row of pg_roles (it was dropped while connected) throws. */
export async function readRoleFacts(pg: Pick<PgConnection, "query">, tables: RoleAsk["tables"]): Promise<RoleFacts> {
  const row = JSON.parse((await pg.query(roleFactsSql(tables))).rows[0]?.[0] ?? "null") as FactsRow | null;
  if (row === null) throw new Error("pg_roles has no row for the user connected");
  return {
    user: row.user, userSql: row.user_sql, databaseSql: row.database_sql,
    roles: row.roles,
    relations: row.relations.map((x) => ({ name: x.name, sql: x.sql, kind: x.kind, entry: x.entry, schemaSql: x.schema_sql, owner: x.owner, owned: x.owned,
      rowSecurity: x.row_security, privileges: x.privileges })),
    schemas: row.schemas.map((s) => ({ name: s.name, sql: s.sql, owner: s.owner, owned: s.owned, create: s.create, publicCreate: s.public_create })),
    definers: row.definers.map((d) => ({ name: d.name, owner: d.owner, ownerSuperuser: d.owner_super, callable: d.callable, publicCallable: d.public_callable,
      triggers: d.triggers, eventTrigger: d.event_trigger, used: d.used })),
    foreignTables: row.foreign_tables, mappedServers: row.mapped_servers, adminOf: row.admin_of, createRole: row.create_role, serverRoles: row.server_roles,
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

/** " (a partition of public.events)": how a relation that is not a synced table reaches one */
function via(x: Pick<RelationFact, "kind" | "entry">): string {
  const said: Record<RelationKind, string> = { table: "", partition: ` (a partition of ${x.entry})`, child: ` (a child of ${x.entry}, by INHERITS: its rows are ${x.entry}'s)`,
    parent: ` (an INHERITS parent of ${x.entry}: an UPDATE, DELETE or TRUNCATE of it reaches ${x.entry}'s rows)`,
    referenced: ` (a foreign key's ON DELETE or ON UPDATE action carries its changes to ${x.entry}, as its owner)`,
    view: ` (a view that writes ${x.entry})`, rule: ` (its rules write ${x.entry})` };
  return said[x.kind];
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
    out.push(warn("role_owns_table", `${f.user} owns ${list(owned.map((x) => `${x.name}${via(x)}`))}${route(others)}: ` +
      "an owner may write to, alter or drop a table whatever is granted"));
  }
  // an owner holds every privilege on its table: the owner's line said it
  const writable = f.relations.filter((x) => !x.owned && x.privileges.length > 0);
  if (writable.length) {
    const held = writable.map((x) => {
      const privs = WRITE_PRIVILEGES.filter((p) => x.privileges.some((g) => g.privileges.includes(p)));
      const others = x.privileges.filter((g) => g.role !== f.user).map((g) => g.role);
      return `${privs.join(", ")} on ${x.name}${via(x)}${route(others)}`;
    });
    out.push(warn("role_writes_table", `${f.user} may ${held.join("; ")}`));
  }
  const creates = f.schemas.filter((s) => s.create.length > 0 || s.publicCreate);
  if (creates.length) {
    const held = creates.map((s) => `CREATE in schema ${s.name}${s.owned ? ` (${s.owner === f.user ? "it owns the schema" : `${s.owner}, which owns the schema`}: it may drop what is in it too)` : route([...s.create.filter((r) => r !== f.user), ...(s.publicCreate ? ["PUBLIC"] : [])])}`);
    out.push(warn("role_creates_in_schema", `${f.user} may ${held.join("; ")}: it may make tables and functions beside the synced ones`));
  }
  // code that runs as another role, whose owner may write the synced rows
  if (f.definers.length) {
    const held = f.definers.map((d) => {
      const how = [...(d.callable ? ["it may call it"] : []), ...(d.triggers.length ? [`a trigger on ${list(d.triggers)}, which it may write, calls it`] : []),
        ...(d.eventTrigger ? ["an event trigger calls it on any DDL it runs, even one refused"] : []),
        ...(d.used ? ["another object of the database calls it (an aggregate, a type, an operator or the like), never asking EXECUTE"] : [])];
      return `${d.name} runs as ${d.owner}${d.ownerSuperuser ? ", a superuser" : ", which may write a synced table's rows"} (SECURITY DEFINER), and ${how.join("; ")}`;
    });
    out.push(warn("role_runs_definer_code", `${f.user} reaches code that runs as another role: ${held.join("; ")}`));
  }
  if (f.foreignTables.length || f.mappedServers.length) {
    const held = [...(f.foreignTables.length ? [`may write the foreign table(s) ${list(f.foreignTables)}`] : []),
      ...(f.mappedServers.length ? [`has a user mapping (its own or PUBLIC's) on ${list(f.mappedServers)}, which it may use`] : [])];
    out.push(warn("role_reaches_foreign_server", `${f.user} ${held.join(", and ")}: what it sends there runs as the mapping's user, and the server may be this very database`));
  }
  if (f.adminOf.length || f.createRole || f.serverRoles.length) {
    const held = [...(f.adminOf.length ? [`has ADMIN OPTION on ${list(f.adminOf)}: it may grant itself that role and its privileges`] : []),
      ...(f.createRole ? ["has CREATEROLE, which before Postgres 16 lets it grant itself any role but a superuser"] : []),
      ...(f.serverRoles.length ? [`holds ${list(f.serverRoles)}: the server's programs or files, as its operating-system user`] : [])];
    out.push(warn("role_may_become_another", `${f.user} ${held.join("; ")}`));
  }
  if (out.length) return out;
  const unread = f.missing.length ? ` (not asked of ${list(f.missing)}, which the database does not have: mason start says so)` : "";
  const synced = f.relations.filter((x) => x.kind === "table").length;
  return [{ name: "role", ok: true, detail: `${f.user} only reads: not a superuser, no BYPASSRLS, no ADMIN OPTION, no server roles, no foreign server, ` +
    "no SECURITY DEFINER code it reaches whose owner may write" + (synced ? `, and it neither owns nor may write to the ${synced} synced table(s) — ` +
      "nor to their partitions, inheritance children or parents, the tables their foreign keys act on, or the views and rules that write them — " +
      "nor CREATE in their schemas" : ", and no table is added yet (the tables are asked once one is)") + unread }];
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
  const tables = f.relations.filter((x) => x.kind === "table");
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
  // what every role reaches, the new one too: PUBLIC's EXECUTE is revoked; what no grant decides is said
  for (const d of f.definers.filter((x) => x.publicCallable)) lines.push(`REVOKE EXECUTE ON FUNCTION ${d.name} FROM PUBLIC;   -- runs as ${d.owner}: GRANT it to the roles that call it`);
  for (const d of f.definers.filter((x) => x.eventTrigger || x.used)) {
    lines.push(`-- ${d.name} runs as ${d.owner} for any role (${d.eventTrigger ? "an event trigger calls it" : "another object calls it"}): ALTER FUNCTION ${d.name} SECURITY INVOKER, if it may`);
  }
  if (f.mappedServers.length) lines.push(`-- a user mapping FOR PUBLIC on ${list(f.mappedServers)} would serve it too: map the roles that need it by name`);
  lines.push("-- and GRANT SELECT ON each view Mason should serve: it serves the views the role it connects as may read");
  // the app's own DATABASE_URL stays the app's: Mason's gets a variable of its own
  const variable = ask.urlVariable === null || ask.urlVariable === "DATABASE_URL" ? "MASON_DATABASE_URL" : ask.urlVariable;
  const own = variable !== ask.urlVariable;
  lines.push(`then: set ${variable}=${readerUrl(ask.url, role)} ${own ? "in .env" : `where it is set now (${ask.urlFrom})`}` +
    `${own ? ` and write url: \${${variable}} in ${ask.file}` : ""}${ownPublication ? `${own ? "," : " and"} publication: ${role} at its top` : ""}` +
    "; mason doctor checks it again, and a running Mason reads it at its next start (mason stop, then mason start)");
  return lines.join("\n");
}
