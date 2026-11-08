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
 *     holding a route's privilege), not the role's own, that it reaches as Postgres decides (measured on 16, PR 572's
 *     third review): by EXECUTE, wherever it is called from (a view, a policy, a default, a CHECK, an index, a cast, an
 *     operator); by a trigger on a relation it may write; and with no EXECUTE asked, by an event trigger (any DDL, even
 *     one refused), an aggregate it may call (its support functions), a type (its I/O), an operator's estimators, an
 *     operator class's, a range's or a conversion's function. Volatility bounds nothing (a STABLE definer calling a
 *     VOLATILE writer writes). What such a function writes is in its body, which the catalog does not read: it is its own
 *     finding (`role_may_run_definer_code`), LISTED for a person to review, and the role is never said to "only read"
 *     while one is reached. Code of invoker's rights runs with the role's own privileges, which the rest asks.
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
import { shownUrl } from "./preflight.ts";

/** The privileges on a table that write or change it (SELECT is the one Mason needs), in their bit order (`mask`). */
export const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

/** Each warning's code, stable for an agent: one per thing the role should not have (`role_unknown`: could not tell). */
export const ROLE_CODES = ["role_superuser", "role_bypassrls", "role_owns_table", "role_writes_table", "role_creates_in_schema",
  "role_may_run_definer_code", "role_reaches_foreign_server", "role_may_become_another", "role_unknown"] as const;
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
  /** Postgres calls it without asking EXECUTE, for another object (an aggregate it may call, a type, an operator, …) */
  unchecked: boolean;
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
-- SECURITY DEFINER code (not the role's own) whose owner may write a synced table's rows: each owner asked once
sd AS (SELECT f.oid, f.proowner, f.prorettype NOT IN ('trigger'::regtype, 'event_trigger'::regtype) AS direct FROM pg_proc f, su
  WHERE f.prosecdef AND NOT su.any AND f.proowner NOT IN (SELECT oid FROM r)),
writer AS (SELECT o.oid, o.rolname, o.rolsuper FROM pg_roles o WHERE o.oid IN (SELECT proowner FROM sd)
  AND (o.rolsuper OR EXISTS (SELECT FROM asks a WHERE ${holds("o.rolname", "a.oid", "a.p")}))),
definer AS (SELECT sd.oid, sd.direct, w.rolname AS owner, w.rolsuper AS owner_super FROM sd JOIN writer w ON w.oid = sd.proowner),
-- the relations it may write whose enabled trigger calls one (pg_trigger read once, joined: never once per function)
dtrig AS (SELECT DISTINCT t.tgfoid, tn.nspname || '.' || tc.relname AS rel FROM pg_trigger t JOIN definer d ON d.oid = t.tgfoid
    JOIN pg_class tc ON tc.oid = t.tgrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
    AND EXISTS (SELECT FROM who w, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS u(p) WHERE ${holds("w.role::name", "t.tgrelid", "u.p")})),
-- what Postgres calls without asking the caller's EXECUTE: an event trigger's function, an aggregate's support
-- functions (when it may call the aggregate), a type's input, output, receive, send, typmod and analyze functions, an
-- operator's estimators, an operator class's support functions, a range's, a conversion's
unchecked AS (SELECT evtfoid AS fn FROM pg_event_trigger WHERE evtenabled <> 'D'
  UNION SELECT a.fn FROM (SELECT aggfnoid, unnest(ARRAY[aggtransfn::oid, aggfinalfn::oid, aggcombinefn::oid, aggserialfn::oid, aggdeserialfn::oid,
      aggmtransfn::oid, aggminvtransfn::oid, aggmfinalfn::oid]) AS fn FROM pg_aggregate) a
    WHERE a.fn IN (SELECT oid FROM definer) AND EXISTS (SELECT FROM who w WHERE has_function_privilege(w.role::name, a.aggfnoid, 'EXECUTE'))
  UNION SELECT unnest(ARRAY[typinput::oid, typoutput::oid, typreceive::oid, typsend::oid, typmodin::oid, typmodout::oid, typanalyze::oid]) FROM pg_type
  UNION SELECT unnest(ARRAY[oprrest::oid, oprjoin::oid]) FROM pg_operator
  UNION SELECT amproc::oid FROM pg_amproc
  UNION SELECT unnest(ARRAY[rngcanonical::oid, rngsubdiff::oid]) FROM pg_range
  UNION SELECT conproc::oid FROM pg_conversion)
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
      SELECT quote_ident(n.nspname) || '.' || quote_ident(f.proname) || '(' || pg_get_function_identity_arguments(f.oid) || ')' AS name, x.owner, x.owner_super,
        -- reached through a view, a policy, a default, a CHECK, an index, a cast or an operator only by EXECUTE, a
        -- trigger's function only by its trigger
        x.direct AND EXISTS (SELECT FROM who w WHERE has_function_privilege(w.role::name, x.oid, 'EXECUTE')) AS callable,
        x.direct AND has_function_privilege('public'::name, x.oid, 'EXECUTE') AS public_callable,
        (SELECT coalesce(json_agg(t.rel ORDER BY t.rel), '[]'::json) FROM dtrig t WHERE t.tgfoid = x.oid) AS triggers,
        EXISTS (SELECT FROM pg_event_trigger e WHERE e.evtfoid = x.oid AND e.evtenabled <> 'D') AS event_trigger,
        x.oid IN (SELECT fn FROM unchecked) AS unchecked
      FROM definer x JOIN pg_proc f ON f.oid = x.oid JOIN pg_namespace n ON n.oid = f.pronamespace) d
    WHERE d.callable OR json_array_length(d.triggers) > 0 OR d.unchecked),
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
  definers: Array<{ name: string; owner: string; owner_super: boolean; callable: boolean; public_callable: boolean; triggers: string[]; event_trigger: boolean; unchecked: boolean }>;
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
      triggers: d.triggers, eventTrigger: d.event_trigger, unchecked: d.unchecked && !d.event_trigger })),
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

/** Why a role warning is said: its `why`, after its facts on a terminal. */
const WHY = "Mason never writes, but a role that can only read is safer";
/** The SECURITY DEFINER listing's own `why`: what it writes is in each function's body, for a person to review. */
const DEFINER_WHY = "We recommend reviewing each: whether it writes a synced table, and who may call it";

/**
 * The checks of the role, from its facts: one warning per code that applies, else one line saying it only reads. A
 * warning's parts stay apart for a tool (`detail` the facts, `why`, `fix` whole and as `fixSql` and `fixThen`); a
 * terminal prints `detail. why` (src/cli/doctor.ts `checkText`).
 */
export function roleChecks(f: RoleFacts, ask: RoleAsk): Check[] {
  const way = readOnlyWayOut(f, ask);
  const fix = fixText(way);
  const warn = (code: RoleCode, detail: string): Check => ({ name: "role", ok: true, warn: true, code, detail, why: WHY, fix, fixSql: way.sql, fixThen: way.then });
  const out: Check[] = [];
  const supers = f.roles.filter((r) => r.superuser);
  if (supers.length) {
    // a superuser may do everything: what else it holds follows from it, and is not said again
    const self = supers.some((r) => r.self);
    out.push(warn("role_superuser", self ? `${f.user} is a superuser`
      : `${f.user} is a member of ${list(supers.map((r) => r.name))}, a superuser`));
    return out;
  }
  const bypass = f.roles.filter((r) => r.bypassrls);
  if (bypass.length) {
    out.push(warn("role_bypassrls", `${f.user} has BYPASSRLS${route(bypass.filter((r) => !r.self).map((r) => r.name))}`));
  }
  const owned = f.relations.filter((x) => x.owned);
  if (owned.length) {
    const others = [...new Set(owned.map((x) => x.owner).filter((o) => o !== f.user))];
    out.push(warn("role_owns_table", `${f.user} owns ${list(owned.map((x) => `${x.name}${via(x)}`))}${route(others)}`));
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
    const held = creates.map((s) => `CREATE in schema ${s.name}${s.owned ? ` (${s.owner === f.user ? "it owns the schema" : `${s.owner}, which owns the schema`})` : route([...s.create.filter((r) => r !== f.user), ...(s.publicCreate ? ["PUBLIC"] : [])])}`);
    out.push(warn("role_creates_in_schema", `${f.user} may ${held.join("; ")}`));
  }
  if (f.foreignTables.length || f.mappedServers.length) {
    const held = [...(f.foreignTables.length ? [`may write the foreign table(s) ${list(f.foreignTables)}`] : []),
      ...(f.mappedServers.length ? [`has a user mapping (its own or PUBLIC's) on ${list(f.mappedServers)}`] : [])];
    out.push(warn("role_reaches_foreign_server", `${f.user} ${held.join(", and ")}`));
  }
  if (f.adminOf.length || f.createRole || f.serverRoles.length) {
    const held = [...(f.adminOf.length ? [`has ADMIN OPTION on ${list(f.adminOf)}`] : []),
      ...(f.createRole ? ["has CREATEROLE"] : []),
      ...(f.serverRoles.length ? [`holds ${list(f.serverRoles)}`] : [])];
    out.push(warn("role_may_become_another", `${f.user} ${held.join("; ")}`));
  }
  // SECURITY DEFINER code: what it writes is in its body, which the catalog does not say, so it is LISTED for a person
  // to review, never "fixed" by a statement that changes another role's privileges, and never taken for "only reads"
  const definers = definerLine(f);
  if (out.length) return definers === null ? out : [...out, { name: "role", ok: true, warn: true, code: "role_may_run_definer_code", detail: `${f.user} ${definers}`, why: DEFINER_WHY }];
  const unread = f.missing.length ? ` (not asked of ${list(f.missing)}, which the database does not have: mason start says so)` : "";
  const synced = f.relations.filter((x) => x.kind === "table").length;
  const itself = "not a superuser, no BYPASSRLS, no ADMIN OPTION, no server roles, no foreign server" + (synced ? `, and it neither owns nor may write to the ${synced} synced table(s) — ` +
    "nor to their partitions, inheritance children or parents, the tables their foreign keys act on, or the views and rules that write them — " +
    "nor CREATE in their schemas" : ", and no table is added yet (the tables are asked once one is)");
  if (definers !== null) return [{ name: "role", ok: true, warn: true, code: "role_may_run_definer_code", detail: `${f.user} may not write the synced tables itself: ${itself}. But it ${definers}${unread}`, why: DEFINER_WHY }];
  return [{ name: "role", ok: true, detail: `${f.user} only reads: ${itself}, and it reaches no SECURITY DEFINER code whose owner may write${unread}` }];
}

/** "may run 2 SECURITY DEFINER function(s) of roles that may write the synced tables — …", or null (its `why` is DEFINER_WHY) */
function definerLine(f: RoleFacts): string | null {
  if (!f.definers.length) return null;
  const each = f.definers.map((d) => {
    const how = [...(d.callable ? [d.publicCallable ? "every role may call it (PUBLIC's EXECUTE)" : "it may call it"] : []),
      ...(d.triggers.length ? [`a trigger on ${list(d.triggers)}, which it may write, calls it`] : []),
      ...(d.eventTrigger ? ["an event trigger calls it on any DDL, even one refused, never asking EXECUTE"] : []),
      ...(d.unchecked ? ["Postgres calls it for an aggregate, a type, an operator or the like, never asking EXECUTE"] : [])];
    return `${d.name} runs as ${d.owner}${d.ownerSuperuser ? ", a superuser" : ", which may write the synced tables"}: ${how.join("; ")}`;
  });
  return `may run ${f.definers.length} SECURITY DEFINER function(s) of roles that may write the synced tables — ${each.join("; ")}`;
}

/** The line a check is when the role could not be asked: said, never taken for "only reads". */
export function roleUnknown(why: string): Check {
  return { name: "role", ok: null, code: "role_unknown", detail: `could not tell whether the user Mason connects as may write to the database: ${why}` };
}

/**
 * The URL `url` with `role` as its user and a placeholder for its password, nothing else of it changed: built from what
 * `shownUrl` shows (src/cli/preflight.ts, issue 541), so no part the URL is not read with is ever printed; a value it
 * does not show is said in words.
 */
export function readerUrl(url: string, role: string): string {
  const shown = shownUrl(url);
  if (shown === null) return `the database's URL with ${role} and its password as the user and password`;
  const u = new URL(shown);
  return `${u.protocol}//${role}:<its password>@${u.host}${u.pathname}${u.search}`;
}

/**
 * THE WAY OUT, as the statements the database's owner runs, then the line of the project to change: a role that may
 * LOGIN and SELECT the synced tables and nothing else — REPLICATION where a table streams, and the publication made by
 * the owner when Mason would make its own (CREATE PUBLICATION … FOR TABLE needs the tables' owner); a policy for it where
 * a table has row-level security (the new role would read no row of it). It NEVER prints a statement that changes any
 * role's privileges but the new one's (PR 572's review: a REVOKE … FROM PUBLIC of a policy's function, run as printed,
 * broke the application's own reads): what PUBLIC holds, and the SECURITY DEFINER code every role reaches, the new role
 * holds and reaches too, and is SAID in a comment, for the database's owner to decide.
 */
export function readOnlyFix(f: RoleFacts, ask: RoleAsk): string {
  return fixText(readOnlyWayOut(f, ask));
}

/** The way out whole, as a terminal prints it: the SQL, then the steps after it. */
const fixText = (way: { sql: string; then: string }): string => `${way.sql}\nthen: ${way.then}`;

/** The way out's two parts: the SQL to run on the primary (its comments included), and the steps after it. */
function readOnlyWayOut(f: RoleFacts, ask: RoleAsk): { sql: string; then: string } {
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
  // PUBLIC's privileges are every role's, the new one's too: said for the database's owner to decide, never revoked here
  const publicCreate = f.schemas.filter((s) => s.publicCreate);
  if (publicCreate.length) lines.push(`-- PUBLIC may CREATE in schema ${list(publicCreate.map((s) => s.name))} (the default before Postgres 15), so the new role may too: whether PUBLIC should is the owner's to decide, for every role`);
  for (const x of f.relations) {
    const pub = x.privileges.find((g) => g.role === "PUBLIC");
    if (pub) lines.push(`-- PUBLIC holds ${pub.privileges.join(", ")} on ${x.name}, so the new role does too: whether PUBLIC should is the owner's to decide, for every role`);
  }
  // what Mason's own would carry (src/duck/sync.ts ensurePublication): the replicated tables, every change
  const published = tables.filter((x) => ask.replicated.includes(x.entry));
  const ownPublication = ask.publication === null && published.length > 0;
  if (ownPublication) {
    lines.push(`CREATE PUBLICATION ${role} FOR TABLE ${published.map((x) => x.sql).join(", ")} WITH (publish = 'insert, update, delete, truncate');   -- Mason's own needs the tables' owner`);
  }
  // what every role reaches, the new one too, is SAID, never changed: a statement that changed PUBLIC's would change
  // every role's, the application's included (PR 572's review: a REVOKE of a policy's function broke the app's reads)
  const everyone = f.definers.filter((d) => d.publicCallable || d.eventTrigger || d.unchecked);
  if (everyone.length) lines.push(`-- the new role may still run ${list(everyone.map((d) => d.name))}, as every role may (SECURITY DEFINER): mason doctor lists them to review`);
  if (f.mappedServers.length) lines.push(`-- a user mapping FOR PUBLIC on ${list(f.mappedServers)} would serve it too: map the roles that need it by name`);
  lines.push("-- and GRANT SELECT ON each view Mason should serve: it serves the views the role it connects as may read");
  // the app's own DATABASE_URL stays the app's: Mason's gets a variable of its own
  const variable = ask.urlVariable === null || ask.urlVariable === "DATABASE_URL" ? "MASON_DATABASE_URL" : ask.urlVariable;
  const own = variable !== ask.urlVariable;
  const then = `set ${variable}=${readerUrl(ask.url, role)} ${own ? "in .env" : `where it is set now (${ask.urlFrom})`}` +
    `${own ? ` and write url: \${${variable}} in ${ask.file}` : ""}${ownPublication ? `${own ? "," : " and"} publication: ${role} at its top` : ""}` +
    "; mason doctor checks it again, and a running Mason reads it at its next start (mason stop, then mason start)";
  return { sql: lines.join("\n"), then };
}
