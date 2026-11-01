/**
 * THE CATALOG SIDECAR: a real Postgres inside the process answers a BI tool's introspection. A tool's startup is
 * hundreds of lines over `pg_catalog` and `information_schema` — `format_type`, `pg_get_expr`, `obj_description`,
 * regclass casts, CTEs — and emulating that
 * is a second query engine. So nothing is emulated: `@electric-sql/pglite` (Postgres 18.6 as WebAssembly) holds the
 * copied tables' `PgSchema` (src/api/postgres/schema.ts) as EMPTY tables with their Postgres types, primary keys, a
 * foreign key per foreign key between copied tables and a COMMENT per description, and the server hands it a tool's
 * raw protocol message and forwards the raw reply, Postgres's own bytes. The DuckDB plan is made here too (src/duck/plan.ts:
 * Postgres analyses the statement over these tables).
 *
 * Two halves. `catalogDdl` is pure: the statements that create the schema, pinned by tests/postgres-api/catalog.test.ts
 * so a change to what a tool sees is read in a diff. `PgCatalog` owns the instance, under five rules:
 *
 * - OFF THE MAIN THREAD, WITH A DEADLINE. PGlite runs synchronously inside its WebAssembly, so an instance on the
 *   listener's own thread stopped the event loop for the length of any statement — `SELECT pg_sleep(3600)` from any
 *   session froze every other, and PGlite ignores `statement_timeout` (review of #480). The instance lives on a worker
 *   thread (catalog-worker.ts); every call has `statementMs` to answer, and past it the worker is TERMINATED and
 *   discarded (the call rejects saying so; the next call starts a fresh instance). Its ~820 MB is the worker's, not
 *   the API's heap.
 * - LAZY AND IDLE-STOPPED. An instance costs ~0.8 s to start and ~820 MB resident on Linux (1.5 GB on macOS), too much
 *   for a deployment nobody connects a BI tool to, so it starts on the first `run` and stops after `idleMs` without
 *   one. The idle timer is `unref`'d: it never keeps a process alive.
 * - SERIALISED. PGlite is a single connection; every `run`, `query`, `stop` and `replace` is queued on one chain so
 *   two callers never interleave their protocol messages and the DDL is applied exactly once per start.
 * - THE SCHEMA IS THE CATALOG. When the copied tables change the server calls `replace` with the new schema: the running instance is
 *   stopped and the next `run` starts with the new DDL. There is no ALTER path — a fresh instance is cheaper than
 *   diffing two schemas correctly.
 * - A START FAILURE IS THE CALLER'S. When the WASM cannot load or the DDL is refused, `run` rejects with an Error that
 *   says PGlite could not start and why, and the object is left able to try again (nothing is cached half-started).
 *
 * The instance's TimeZone is UTC (the API treats every time as UTC, §4.8); its search_path is Postgres's default, so
 * `public."orders"` and `orders` both resolve, as a tool expects.
 */
import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { runnable } from "../../lib/runnable.ts";
import { NO_ROLE_CATALOG, type RoleGrants } from "../../duck/grants.ts";
import { renderWhere, tableSql } from "../../duck/row-filter.ts";
import { cstr, frame, splitFrames } from "./protocol.ts";
import { HELD_ROW_INPUT, HELD_TYPE_INPUT, madeTypeName, PG_API_TYPE_SPELLING, typeNameParts, type PgJoin, type PgSchema, type PgTable } from "./schema.ts";

/** Ten minutes: long enough to outlive a tool's startup burst and a person's pause between two queries. */
const DEFAULT_IDLE_MS = 10 * 60_000;
/** A catalog statement's deadline (`MASON_PG_CATALOG_TIMEOUT_MS`): a tool's introspection answers in milliseconds; a
 *  statement still running after this is runaway, and the instance is discarded. The start (WASM ~0.8 s, the DDL) has
 *  the same budget. */
export const DEFAULT_STATEMENT_MS = 10_000;
/** the start (PGlite's own boot and the whole DDL, a second or more on a loaded host) gets at least this long, whatever
 *  a statement's deadline is: a short statement deadline is for a statement, not for discarding every start */
export const MIN_START_MS = 30_000;

/** A SQL identifier, double-quoted with an inner quote doubled. */
const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quoteLiteral = (text: string): string => `'${text.replaceAll("'", "''")}'`;
/** A SQL string literal, single-quoted with an inner quote doubled. */
const literal = (text: string): string => `'${text.replaceAll("'", "''")}'`;
/** a table's name in the catalog: its schema (Mason's source schema, else public) and name */
const qualified = (table: PgTable): string => `${table.schema === undefined ? "public" : ident(table.schema)}.${ident(table.name)}`;
/** the table a join names: `<schema>.<table>`, or a bare name in public */
const joinTarget = (schema: PgSchema, table: string): PgTable | undefined =>
  schema.tables.find((t) => `${t.schema ?? "public"}.${t.name}` === table) ?? schema.tables.find((t) => t.schema === undefined && t.name === table);

/**
 * Whether a join can be a FOREIGN KEY in Postgres: a `many_to_one` or `one_to_one` edge (the side that holds the key),
 * to a table in the schema, whose target column is that table's WHOLE primary key or the whole of one of its unique
 * indexes (Postgres refuses a foreign key to a column no unique index covers exactly), from a column this table lists.
 * Any other join is a comment on its column.
 */
function isForeignKey(schema: PgSchema, table: PgTable, join: PgJoin): boolean {
  if (join.relationship !== "many_to_one" && join.relationship !== "one_to_one") return false;
  if (!table.columns.some((c) => c.name === join.on[0])) return false;
  const target = joinTarget(schema, join.table);
  if (target === undefined) return false;
  return [target.primaryKey, ...(target.uniqueKeys ?? []).map((u) => u.columns)].some((k) => k.length === 1 && k[0] === join.on[1]);
}

const joinNote = (join: PgJoin): string => `joins ${join.table} on ${join.on[1]} (${join.relationship})`;

/**
 * THE CATALOG'S DATABASE IS THE ONE A TOOL CONNECTED TO (src/lib/database-name.ts): current_database(), pg_database — pgjdbc's
 * getCatalogs and every TABLE_CAT, DBeaver's navigator — once said the sidecar's own `postgres`. The current
 * database's row is renamed (ALTER DATABASE refuses the current one; the catalog row does not), after moving aside any
 * OTHER database already holding the name — PGlite's `template0` / `template1` — since pg_database's names are unique
 * (#484's review: a name of `template1` failed on pg_database_datname_index and the catalog never started).
 */
export function databaseNameSql(name: string): string[] {
  const q = `'${name.replaceAll("'", "''")}'`;
  return [
    `UPDATE pg_catalog.pg_database SET datname = datname || '_pglite' WHERE datname = ${q} AND datname <> current_database()`,
    `UPDATE pg_catalog.pg_database SET datname = ${q} WHERE datname = current_database()`,
  ];
}

/**
 * The statements that create the schema in Postgres, in the schema's own order: every table (its columns and its
 * primary key), the comments from its descriptions, and — after every table exists, since a constraint may point
 * forward — one foreign key per join that can be one. A join that cannot (a `one_to_many`, a target that is not a whole
 * primary key, a target outside the schema) is a note appended to its column's comment; a join from a column the table
 * does not list has no column to carry it and is noted on the table instead.
 */
export function catalogDdl(schema: PgSchema): string[] {
  const statements: string[] = [];
  const constraints: string[] = [];
  // a constraint's name as Postgres chooses one (ChooseConstraintName): `<table>_<column>_fkey`, and a number appended
  // from 1 when a constraint of the table already has it — two joins from one column (the shop's `customers.id` to
  // `latest_orders` and to `latest_status`) are two constraints, and one name for both was refused
  const named = new Set<string>();
  const constraintName = (base: string): string => {
    let name = base;
    for (let n = 1; named.has(name); n++) name = `${base}${n}`;
    named.add(name);
    return name;
  };
  // an extension's type a column has (Mason copies a citext as itself): its extension, which the worker
  // bundles (catalog-worker.ts), before the tables
  if (schema.tables.some((t) => t.columns.some((c) => c.spelled === "citext"))) statements.push("CREATE EXTENSION IF NOT EXISTS citext;");
  // a source schema the prototype copies from (decision C): created before its tables
  for (const name of [...new Set(schema.tables.map((t) => t.schema).filter((x): x is string => x !== undefined && x !== "public"))]) {
    statements.push(`CREATE SCHEMA IF NOT EXISTS ${ident(name)};`);
  }
  // a source enum a column has: the type, its labels in their declared order, before the tables —
  // spelled as the source's format_type spells it (`mood`, `other.level`, `"Odd"`), its schema made first
  const enums = new Map<string, readonly string[]>();
  // one declaration a type, the FIRST column's: the synced tables come first, and src/duck/sync.ts hands a generated
  // table's column its synced type's labels (one source of an enum's labels), so no later column's can replace them
  for (const t of schema.tables) for (const c of t.columns) if (c.enumLabels !== undefined && c.spelled !== undefined && !enums.has(c.spelled.replace(/\[\]$/, ""))) enums.set(c.spelled.replace(/\[\]$/, ""), c.enumLabels);
  for (const [type, labels] of enums) {
    const qualifier = typeNameParts(type).schema;
    if (qualifier !== null && qualifier !== '"public"' && qualifier !== "public") statements.push(`CREATE SCHEMA IF NOT EXISTS ${qualifier};`);
    statements.push(`CREATE TYPE ${type} AS ENUM (${labels.map(literal).join(", ")});`);
  }
  // a type a database made, held as its text: its name, the text's input and output, and nothing over it
  const made = new Map(schema.tables.flatMap((t) => t.columns.filter((c) => c.made !== undefined).map((c) => [madeTypeName(c.spelled!), c.made] as const)));
  [...made].forEach(([type, kind], i) => {
    const input = kind === "row" ? HELD_ROW_INPUT : HELD_TYPE_INPUT;
    const qualifier = typeNameParts(type).schema;
    if (qualifier !== null && qualifier !== '"public"' && qualifier !== "public") statements.push(`CREATE SCHEMA IF NOT EXISTS ${qualifier};`);
    statements.push(`CREATE TYPE ${type};`,
      `CREATE FUNCTION pg_catalog.${input}${i}(cstring) RETURNS ${type} LANGUAGE internal IMMUTABLE STRICT AS 'textin';`,
      `CREATE FUNCTION pg_catalog.mason_held_out${i}(${type}) RETURNS cstring LANGUAGE internal IMMUTABLE STRICT AS 'textout';`,
      `CREATE TYPE ${type} (INPUT = pg_catalog.${input}${i}, OUTPUT = pg_catalog.mason_held_out${i}, LIKE = text);`);
  });
  for (const table of schema.tables) {
    const lines: string[] = [];
    for (const c of table.columns) lines.push(`${ident(c.name)} ${c.made !== undefined ? `${madeTypeName(c.spelled!)}${c.spelled!.endsWith("[]") ? "[]" : ""}` : c.spelled ?? PG_API_TYPE_SPELLING[c.type]}${c.notNull === true ? " NOT NULL" : ""}`);
    if (table.primaryKey.length > 0) lines.push(`PRIMARY KEY (${table.primaryKey.map(ident).join(", ")})`);
    statements.push(`CREATE TABLE ${qualified(table)} (\n  ${lines.join(",\n  ")}\n);`);
    // the source's unique indexes, under its names: before the foreign keys that may reference them
    for (const u of table.uniqueKeys ?? []) {
      const cols = `(${u.columns.map(ident).join(", ")})`;
      const nulls = u.nullsNotDistinct ? "NULLS NOT DISTINCT" : "";
      // the two spellings put NULLS NOT DISTINCT on either side of the columns
      statements.push(u.constraint ? `ALTER TABLE ${qualified(table)} ADD CONSTRAINT ${ident(u.name)} UNIQUE ${nulls} ${cols};`
        : `CREATE UNIQUE INDEX ${ident(u.name)} ON ${qualified(table)} ${cols} ${nulls};`);
    }

    const notesOn = new Map<string, string[]>();
    const tableNotes: string[] = [];
    for (const join of table.joins) {
      if (isForeignKey(schema, table, join)) {
        constraints.push(
          `ALTER TABLE ${qualified(table)} ADD CONSTRAINT ${ident(constraintName(`${table.name}_${join.on[0]}_fkey`))}` +
            ` FOREIGN KEY (${ident(join.on[0])}) REFERENCES ${qualified(joinTarget(schema, join.table)!)} (${ident(join.on[1])});`,
        );
      } else if (table.columns.some((c) => c.name === join.on[0])) {
        notesOn.set(join.on[0], [...(notesOn.get(join.on[0]) ?? []), joinNote(join)]);
      } else {
        tableNotes.push(`${join.on[0]} ${joinNote(join)}`);
      }
    }

    const tableComment = [table.description, ...tableNotes].filter((s): s is string => s !== undefined && s !== "").join("; ");
    if (tableComment !== "") statements.push(`COMMENT ON TABLE ${qualified(table)} IS ${literal(tableComment)};`);
    for (const c of table.columns) {
      const parts = [c.description, ...(notesOn.get(c.name) ?? [])].filter((s): s is string => s !== undefined && s !== "");
      if (parts.length > 0) statements.push(`COMMENT ON COLUMN ${qualified(table)}.${ident(c.name)} IS ${literal(parts.join("; "))};`);
    }
  }
  return [...statements, ...constraints, ...sourceTypeNames(schema)];
}

/**
 * THE NAME OF A TYPE BY THE OID THE WIRE SENDS FOR IT. A column of a type the source made (an enum, a citext) is
 * sent with the SOURCE's OID (src/duck/plan.ts `userTypes`: what the source's own clients cached), which in this
 * catalog means another type or none (both count from 16384): `format_type(<that oid>, …)` answered `???`, or another
 * table's row type. Two readers ask by two OID spaces, and one OID can be in both:
 *   - `public.mason_wire_type(oid, integer)` names an OID the WIRE sent: a source OID as its type here, every other as
 *     Postgres does. `mason mcp` names a RowDescription's columns by it; this map is the one place a wire OID is named;
 *   - the catalog's `format_type(oid, integer)` — the `version()` override's way, search_path listing pg_catalog after
 *     public — keeps the catalog's meaning for an OID the catalog has (a reader of pg_attribute.atttypid asks by those)
 *     and names any other by the wire's map. `pg_catalog.format_type`, written out, is Postgres's own.
 */
export function sourceTypeNames(schema: PgSchema): string[] {
  const names = new Map<number, string>();
  for (const t of schema.tables) {
    if (t.rowTypeOid !== undefined) names.set(t.rowTypeOid, qualified(t));
    for (const c of t.columns) {
      if (c.typeOid === undefined || c.spelled === undefined) continue;
      // an array column's own OID is its array type's; an element's array type is the element's spelling with []
      const spelled = c.made !== undefined ? `${madeTypeName(c.spelled)}${c.spelled.endsWith("[]") ? "[]" : ""}` : c.spelled;
      names.set(c.typeOid, spelled);
      if (c.typeArrayOid !== undefined && !spelled.endsWith("[]")) names.set(c.typeArrayOid, `${spelled}[]`);
    }
  }
  // with no type the source made, every OID the wire sends is Postgres's: the wire's name is format_type's
  if (names.size === 0) return [`CREATE OR REPLACE FUNCTION public.mason_wire_type(oid, integer) RETURNS text LANGUAGE sql STABLE AS $$ SELECT pg_catalog.format_type($1, $2) $$;`];
  const values = [...names].map(([oid, spelled]) => `(${oid}::oid, ${literal(spelled)})`).join(", ");
  return [`CREATE OR REPLACE FUNCTION public.mason_wire_type(oid, integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT pg_catalog.format_type(pg_catalog.to_regtype(v.spelled), $2) FROM (VALUES ${values}) AS v(source, spelled) WHERE v.source = $1),
    pg_catalog.format_type($1, $2)) $$;`,
  `CREATE OR REPLACE FUNCTION public.format_type(oid, integer) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT FROM pg_catalog.pg_type t WHERE t.oid = $1) THEN pg_catalog.format_type($1, $2) ELSE public.mason_wire_type($1, $2) END $$;`];
}

/**
 * The source's column defaults, one statement each, run after the schema's DDL by
 * `catalogDdl`'s caller one at a time: a default the catalog cannot create (a function or a sequence it does not have,
 * `uuid_generate_v4()` without its extension) is said in the log and leaves the column without one, never the start
 * refused. A serial's sequence is created and OWNED BY its column and an identity column is made one under its own
 * sequence's name, so `pg_get_serial_sequence` and `information_schema.columns` answer as the source's. A generated
 * column is declared as a plain one (its expression is no default, src/cli/preflight.ts).
 */
export function catalogDefaults(schema: PgSchema): string[] {
  const out: string[] = [];
  for (const table of schema.tables) for (const c of table.columns) {
    const column = `${qualified(table)} ALTER COLUMN ${ident(c.name)}`;
    if (c.identity !== undefined) {
      const named = c.sequence !== undefined ? ` (SEQUENCE NAME ${c.sequence})` : "";
      out.push(`ALTER TABLE ${column} ADD GENERATED ${c.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY${named};`);
    } else if (c.default !== undefined && c.sequence !== undefined) {
      // a serial's sequence is its column's integer type (CREATE SEQUENCE's default is bigint)
      const declared = c.spelled ?? PG_API_TYPE_SPELLING[c.type];
      const as = ["smallint", "integer", "bigint"].includes(declared) ? ` AS ${declared}` : "";
      // one statement: the sequence, the default reading it and its owner stand or fall together
      out.push(`CREATE SEQUENCE ${c.sequence}${as}; ALTER TABLE ${column} SET DEFAULT ${c.default}; ALTER SEQUENCE ${c.sequence} OWNED BY ${qualified(table)}.${ident(c.name)};`);
    } else if (c.default !== undefined) {
      out.push(`ALTER TABLE ${column} SET DEFAULT ${c.default};`);
    }
  }
  return out;
}

/**
 * The source's views, one statement each beside `catalogDefaults`'s: a view reading a table
 * Mason has not copied (or a function the catalog lacks) is said in the log and left out. Each definition qualifies
 * every name outside pg_catalog (src/cli/preflight.ts VIEWS_SQL), so it reads the same tables here; a view over a view
 * is created once the other is (the worker runs these in passes). Every role may SEE every view (`catalogRoles`: the
 * grant is in the view's own statement, since the view must exist first): reading one is held to the tables it reads.
 */
export function catalogViews(schema: PgSchema, roles: ReadonlyMap<string, RoleGrants> = new Map()): string[] {
  return (schema.views ?? []).map((v) => {
    const name = `${ident(v.schema)}.${ident(v.name)}`;
    const comment = v.description ? ` COMMENT ON VIEW ${name} IS ${literal(v.description)};` : "";
    // every role of the file may see a view; the catalog's role of a user held to nothing sees none (as a login with no
    // grant on Postgres)
    const granted = [...roles.keys()].filter((r) => r !== NO_ROLE_CATALOG).map((r) => ` GRANT USAGE ON SCHEMA ${ident(v.schema)} TO ${ident(r)}; GRANT SELECT ON ${name} TO ${ident(r)};`).join("");
    return `CREATE SCHEMA IF NOT EXISTS ${ident(v.schema)}; CREATE VIEW ${name} AS ${v.definition.replace(/;\s*$/, "")};${comment}${granted}`;
  });
}

/**
 * THE CATALOG'S ROLES MIRROR THE ROLES FILE (GitHub issue 30; src/cli/roles.ts, src/duck/grants.ts): one Postgres role
 * per Mason role, NOLOGIN, with `GRANT SELECT` on each table the role reads whole and `GRANT SELECT (columns)` on
 * each it reads in part, and USAGE on every schema the copied tables are in. A session with a role runs its catalog
 * statements under `SET ROLE` (`asRole`), so `information_schema.tables` / `.columns`, `has_table_privilege` and
 * `has_column_privilege` answer for the role as Postgres's own do — and `mason mcp`'s `tables` and `describe`, which
 * ask them, list a role what it may read. `pg_catalog` itself (pg_class, pg_attribute) does not filter by privilege
 * on Postgres either; it still lists every synced column, said in docs/POSTGRES-API.md. A table the role names that the
 * schema does not hold yet (added, not copied) is granted at the rebuild its copy brings; a column the copy lacks is
 * left out (the roles file was held to the copy already, src/cli/roles.ts). Rebuilt with the schema: the server
 * replaces the catalog when the roles move, as it does when the tables do. **`set_config` is revoked from PUBLIC
 * while roles exist** (the review of #35): the catalog's one connection is the superuser's with `SET ROLE` on top, so
 * inside one statement `set_config('role', 'none', false)` was a permitted RESET ROLE and the statement's later
 * targets ran as the superuser (`information_schema` listed every hidden column's name); revoked, a role's session is
 * refused it (42501 `permission denied for function set_config`) and the superuser keeps it. A role of `tables: all`
 * (stage 1b) is resolved to a whole-table grant on every copied table (src/cli/roles.ts resolveRoles), so it is written
 * here as per-table `GRANT SELECT`s, never `GRANT SELECT ON ALL TABLES IN SCHEMA`: the catalog is rebuilt from the
 * resolved grants whenever the copied tables move, so a table added later is granted at that rebuild. The file's
 * `default:` role is one of these roles: a user with no role of its own runs its catalog requests under it; under a
 * file with no default it runs them as `NO_ROLE_CATALOG` (src/duck/grants.ts catalogRolesOf), a role with no grant.
 */
export function catalogRoles(schema: PgSchema, roles: ReadonlyMap<string, RoleGrants>): string[] {
  const out: string[] = [];
  if (roles.size === 0) return out;
  out.push("REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;");
  const schemas = [...new Set(schema.tables.map((t) => t.schema ?? "public"))];
  const byName = new Map(schema.tables.map((t) => [`${t.schema ?? "public"}.${t.name}`, t]));
  for (const r of roles.values()) {
    const role = ident(r.name);
    out.push(`CREATE ROLE ${role} NOLOGIN;`);
    for (const s of schemas) out.push(`GRANT USAGE ON SCHEMA ${ident(s)} TO ${role};`);
    for (const g of r.tables.values()) {
      const t = byName.get(g.table);
      if (t === undefined) continue;
      if (g.all) { out.push(`GRANT SELECT ON ${qualified(t)} TO ${role};`); continue; }
      const columns = g.columns.filter((c) => t.columns.some((x) => x.name === c));
      if (columns.length > 0) out.push(`GRANT SELECT (${columns.map(ident).join(", ")}) ON ${qualified(t)} TO ${role};`);
    }
  }
  return out;
}

/**
 * THE ROLES' ROW FILTERS AS THE CATALOG'S OWN ROW SECURITY (src/duck/row-filter.ts): every copied table some role filters
 * gets `ENABLE ROW LEVEL SECURITY` and one permissive SELECT policy per role that reads it — its `where:` with each
 * attribute read as `current_setting('mason.attr.<name>')::<type>` (a list `string_to_array(…, ',')::<type>`), the type
 * Postgres inferred for it (`filterTypes`, carried on the roles as `filterTypes`), each request carrying the session's
 * attributes as settings (`asSession`); a `through:` as `EXISTS (SELECT 1 FROM <parent> …)`, the parent's own policy
 * applying inside; `true` for a role that reads it unfiltered (row security with no policy hides every row). So
 * `pg_policies`, `relrowsecurity` and the catalog's own analysis see what Postgres would. The catalog holds no row: the
 * rows Mason answers are filtered on the copy (src/duck/plan.ts), never here. A filter whose types are not known (its
 * check failed: the roles' problem refuses every user held to them) gets no policy. Idempotent: each policy dropped first.
 */
export function catalogPolicies(schema: PgSchema, roles: ReadonlyMap<string, RoleGrants>): string[] {
  const filtered = new Set([...roles.values()].flatMap((g) => [...(g.filters?.keys() ?? [])]));
  const out: string[] = [];
  for (const t of schema.tables) {
    const name = `${t.schema ?? "public"}.${t.name}`;
    if (!filtered.has(name)) continue;
    out.push(`ALTER TABLE ${qualified(t)} ENABLE ROW LEVEL SECURITY`);
    for (const g of roles.values()) {
      if (!g.tables.has(name)) continue;
      const f = g.filters?.get(name);
      let using: string;
      if (f === undefined) using = "true";
      else if (f.through !== undefined) using = `EXISTS (SELECT 1 FROM ${tableSql(f.through.parent)} AS __mason_parent WHERE __mason_parent.${ident(f.through.parentColumn)} = ${qualified(t)}.${ident(f.through.column)})`;
      else {
        const types = g.filterTypes?.get(name);
        if (types === undefined || f.where === undefined) continue;
        const shapes = g.attributes ?? new Map();
        using = renderWhere(f.where.parts, (a) => {
          const read = `current_setting('mason.attr.${a}')`;
          return shapes.get(a) === "list" ? `string_to_array(${read}, ',')::${types.get(a) ?? "text[]"}` : `${read}::${types.get(a) ?? "text"}`;
        });
      }
      out.push(`DROP POLICY IF EXISTS ${ident(`mason_${g.name}`)} ON ${qualified(t)}`);
      out.push(`CREATE POLICY ${ident(`mason_${g.name}`)} ON ${qualified(t)} AS PERMISSIVE FOR SELECT TO ${ident(g.name)} USING (${using})`);
    }
  }
  return out;
}

/**
 * A SESSION'S CATALOG REQUEST AS ITS ROLE: `SET ROLE` before the request's frames and `RESET ROLE` after, in ONE
 * message — the catalog runs one request at a time (`PgCatalog`'s chain) and a message whole, so no other session's
 * request runs under this role, and none of this session's runs without it. A Sync is added before the RESET where
 * the request has none: after an error Postgres ignores every message until a Sync (ignore_till_sync), the RESET
 * included, and a role left set would be every session's.
 */
export function asRole(message: Uint8Array, role: string): Uint8Array {
  const own = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  const synced = splitFrames(own).some((f) => f.type === "S");
  const set = `SET ROLE ${ident(role)}`;
  return Buffer.concat([frame("Q", cstr(set)), own, ...(synced ? [] : [frame("S")]), frame("Q", cstr("RESET ROLE"))]);
}

/**
 * The reply to an `asRole` message, less the SET's and the RESET's own replies (each a CommandComplete and a
 * ReadyForQuery; the Sync added by `asRole` leaves its ReadyForQuery, which every caller drops). `setRoleRefused`: the
 * SET ROLE's ErrorResponse, when the catalog has no such role (its roles are a rebuild behind the file).
 */
export function unwrapRole(frames: ReadonlyArray<{ type: string; frame: Buffer }>): { frames: Array<{ type: string; frame: Buffer }>; setRoleRefused: Buffer | null } {
  const first = frames[0];
  if (first === undefined) return { frames: [], setRoleRefused: null };
  if (first.type === "E") return { frames: [], setRoleRefused: first.frame };
  // the SET's CommandComplete and ReadyForQuery first; the RESET's CommandComplete and ReadyForQuery last
  const inner = frames.slice(first.type === "C" && frames[1]?.type === "Z" ? 2 : 0);
  const n = inner.length;
  const end = n >= 2 && inner[n - 1]!.type === "Z" && inner[n - 2]!.type === "C" ? n - 2 : n;
  return { frames: inner.slice(0, end), setRoleRefused: null };
}

/** the placeholder parameter a session's settings ride in, for one request of its (`asSession`): named anew by each
 *  process, so no name a tool writes is it — `current_setting('mason.session')` answered the carrier's JSON where
 *  Postgres (and `SHOW`, and the same beside a copied table) answers 42704 (a review finding of #46). A placeholder
 *  stays defined once SET, so the name, not a RESET, is what keeps it out of reach. */
export const SESSION_SETTINGS = `mason_${randomBytes(8).toString("hex")}.session`;

/**
 * LATEST(x ORDER BY k…), THE AGGREGATE MASON ADDS: the x of the row its ORDER BY sorts last, by Postgres's sort rules.
 * Declared in the catalog so that Postgres's analysis types and names it (an AGGREF of its argument's type), and by the
 * oracle's real Postgres from this ONE definition, so the two compare like with like. Its transition keeps the latest
 * row's value, a NULL included (not STRICT); over no rows it is NULL. In pg_catalog, so no search_path hides it. The
 * engine never runs this: src/duck/rewrite.ts `latest` rewrites it, and refuses it without an ORDER BY (`latest-order`).
 */
export const LATEST_SQL: readonly string[] = [
  "CREATE OR REPLACE FUNCTION pg_catalog.mason_latest_step(anyelement, anyelement) RETURNS anyelement LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT $2 $$",
  "CREATE OR REPLACE AGGREGATE pg_catalog.latest(anyelement) (SFUNC = pg_catalog.mason_latest_step, STYPE = anyelement)",
];

/**
 * THE CATALOG'S `current_setting(name[, missing_ok])` IS THE SESSION'S (GitHub issue 40: after `SET TimeZone` it answered
 * the catalog's UTC, where `SHOW TimeZone` answered the session's): the value the session holds under that name, from
 * the request's `SESSION_SETTINGS` (`asSession`: every parameter the listener's `sessionSetting` answers), else
 * Postgres's own (`block_size`; its 42704, or NULL under missing_ok, for a name nobody knows). The `version()`
 * override's way: search_path lists pg_catalog after public, so a statement reading no table and calling it is
 * forwarded as ever; one that writes `pg_catalog.current_setting` is spliced to this one (server.ts
 * userSpliced: Postgres's built-in runs its C function by OID, so its catalog row cannot be replaced). Plain
 * SQL (plpgsql would load its library, and SHOW ALL list its `plpgsql.*`); STRICT, as Postgres's.
 */
export function currentSettingSql(): string[] {
  const held = `nullif(pg_catalog.current_setting('${SESSION_SETTINGS}', true), '')::jsonb ->> lower($1)`;
  return [
    `CREATE OR REPLACE FUNCTION public.current_setting(text) RETURNS text LANGUAGE sql STABLE STRICT AS $$ SELECT coalesce(${held}, pg_catalog.current_setting($1)) $$`,
    `CREATE OR REPLACE FUNCTION public.current_setting(text, boolean) RETURNS text LANGUAGE sql STABLE STRICT AS $$ SELECT coalesce(${held}, pg_catalog.current_setting($1, $2)) $$`,
  ];
}

/**
 * A SESSION'S CATALOG REQUEST WITH ITS SETTINGS: `SET <SESSION_SETTINGS> = '<its settings as JSON>'` before the request's
 * frames and `RESET` after, in ONE message, as `asRole` wraps a role (around it, when the session has one) — the catalog
 * runs one request at a time and a message whole, so no other session's request reads these settings, and none of this
 * session's runs without them. A Sync is added before the RESET where the request has none (ignore_till_sync: a
 * setting left set would be every session's). `settings` are the listener's `sessionSetting`, never read here. The
 * catalog's search_path is pinned in the same SET (`public, pg_catalog`): the overrides of `current_setting` and
 * `version()` win only while public comes first, and the request must never depend on what the catalog was left with.
 */
export function asSession(message: Uint8Array, settings: ReadonlyMap<string, string>): Uint8Array {
  const own = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  const frames = splitFrames(own);
  const synced = frames.some((f) => f.type === "S") || frames.at(-1)?.type === "Q";
  const json = JSON.stringify(Object.fromEntries(settings));
  return Buffer.concat([frame("Q", cstr(`SET search_path = public, pg_catalog; SET ${SESSION_SETTINGS} = ${quoteLiteral(json)}`)), own, ...(synced ? [] : [frame("S")]), frame("Q", cstr(`RESET ${SESSION_SETTINGS}`))]);
}

/** The reply to an `asSession` message, less the SETs' and the RESET's own replies (two CommandCompletes and a
 *  ReadyForQuery first, a CommandComplete and a ReadyForQuery last). A SET the catalog refused is a Mason bug, said. */
export function unwrapSession(frames: ReadonlyArray<{ type: string; frame: Buffer }>): Array<{ type: string; frame: Buffer }> {
  const ok = frames[0]?.type === "C" && frames[1]?.type === "C" && frames[2]?.type === "Z";
  const n = frames.length;
  if (!ok || n < 5 || frames[n - 1]!.type !== "Z" || frames[n - 2]!.type !== "C") {
    throw new Error(`the catalog Postgres did not take the session's settings around a request (${frames.map((f) => f.type).join(", ")}): report it`);
  }
  return frames.slice(3, n - 2);
}

export interface PgCatalogOptions {
  /** how long without a call before the instance is stopped; default ten minutes */
  idleMs?: number;
  /** where a line about a start, a stop or a failed close goes; default stderr */
  log?: (line: string) => void;
  /** statements run after the schema's DDL at every start (the server's `version()` override and its search_path) */
  setup?: string[];
  /** a call's deadline, the start included; past it the instance is discarded. Default DEFAULT_STATEMENT_MS */
  statementMs?: number;
  /** log the whole statement of a default or view left out (`MASON_PG_TRACE=1`, the server's `trace`) */
  trace?: boolean;
  /** the roles the catalog makes (`catalogRoles`), by name; none by default */
  roles?: ReadonlyMap<string, RoleGrants>;
}

/**
 * WHAT A LEFT-OUT DEFAULT OR VIEW IS SAID AS, in one line (the test server's log printed every left-out source
 * view's whole definition at each start of the instance — 7 multi-line entries per start, most of a 190 KB log, their
 * continuation lines without a timestamp, and the views' own columns matched a grep for "error"): the object named,
 * and the reason in the reader's words — a view reading a relation Mason has not copied says so. The statement itself
 * is the trace's (`PgCatalogOptions.trace`).
 */
export function leftOutLine(r: { statement: string; message: string }): string {
  const view = /CREATE VIEW ("(?:[^"]|"")+")\.("(?:[^"]|"")+") AS /.exec(r.statement);
  const unquote = (s: string): string => s.slice(1, -1).replaceAll('""', '"');
  if (view === null) return `catalog: a source default left out (${r.message}): ${r.statement}`;
  const missing = /^relation "([^"]+)" does not exist$/.exec(r.message)?.[1];
  const name = `${unquote(view[1]!)}.${unquote(view[2]!)}`;
  return missing !== undefined ? `catalog: view ${name} left out: it reads ${missing}, which is not synced` : `catalog: view ${name} left out (${r.message})`;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Reply = { id: number; ok: true; bytes?: Uint8Array; rows?: Record<string, unknown>[]; refused?: Array<{ statement: string; message: string }> } | { id: number; ok: false; message: string };

/** One worker thread holding one PGlite: requests one at a time (PgCatalog's chain), each with a deadline. */
class CatalogWorker {
  readonly #worker: Worker;
  #pending: { id: number; resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  #dead: Error | null = null;
  #next = 1;

  constructor() {
    const file = new URL("./catalog-worker.ts", import.meta.url);
    // `execArgv: []`: the worker must not inherit this process's Node flags (src/api/postgres/parser.ts says why)
    this.#worker = new Worker(runnable(fileURLToPath(file)), { execArgv: [], argv: [] });
    this.#worker.unref();
    this.#worker.on("message", (reply: Reply) => {
      const p = this.#pending;
      if (p === null || p.id !== reply.id) return;   // a reply past its deadline: its worker is being terminated
      this.#pending = null;
      clearTimeout(p.timer);
      p.resolve(reply);
    });
    this.#worker.on("error", (e) => this.#die(new Error(`the catalog's worker failed: ${e.message}`)));
    this.#worker.on("exit", (code) => this.#die(new Error(`the catalog's worker exited with code ${code}`)));
  }

  get alive(): boolean { return this.#dead === null; }

  #die(e: Error): void {
    if (this.#dead !== null) return;
    this.#dead = e;
    const p = this.#pending;
    this.#pending = null;
    if (p !== null) { clearTimeout(p.timer); p.reject(e); }
  }

  /** one request; past `ms` the worker is terminated and the request rejects naming the deadline */
  request(message: Record<string, unknown>, ms: number, what: string, transfer: ArrayBuffer[] = []): Promise<Reply> {
    if (this.#dead !== null) return Promise.reject(this.#dead);
    if (this.#pending !== null) return Promise.reject(new Error("the catalog's worker is busy: PgCatalog serialises its calls"));
    return new Promise((resolve, reject) => {
      const id = this.#next++;
      const timer = setTimeout(() => {
        // the message reaches the client on the wire and the request log: Mason's words, never the catalog's engine's name
        this.#die(new Error(`the catalog did not answer ${what} within ${ms / 1000} s, so Mason started it again (the next statement is answered as usual; MASON_PG_CATALOG_TIMEOUT_MS raises the deadline)`));
        void this.#worker.terminate();
      }, ms);
      timer.unref();
      this.#pending = { id, resolve, reject, timer };
      this.#worker.postMessage({ ...message, id }, transfer);
    });
  }

  async terminate(): Promise<void> {
    this.#die(new Error("the catalog was stopped"));
    await this.#worker.terminate();
  }
}

export class PgCatalog {
  #schema: PgSchema;
  #roles: ReadonlyMap<string, RoleGrants>;
  readonly #idleMs: number;
  readonly #statementMs: number;
  readonly #log: (line: string) => void;
  readonly #setup: string[];
  readonly #trace: boolean;
  /** the left-out lines said for this schema (`leftOutLine`): each once, not at every start of the instance; cleared
   *  with the schema (`replace`), so a change is said again */
  #said = new Set<string>();
  #db: CatalogWorker | null = null;
  /** the one queue every call runs on; always resolved, so a failed call never blocks the next (its rejection is the caller's) */
  #chain: Promise<void> = Promise.resolve();
  #idleTimer: NodeJS.Timeout | null = null;
  #lastUsed = 0;
  /** the roles' row security policies (`catalogPolicies`), written once the listener checked the filters: run on the
   *  instance up now and at every start after, until the schema or the roles are replaced */
  #policies: string[] = [];

  constructor(schema: PgSchema, opts: PgCatalogOptions = {}) {
    this.#schema = schema;
    this.#roles = opts.roles ?? new Map();
    this.#idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.#statementMs = opts.statementMs ?? DEFAULT_STATEMENT_MS;
    this.#log = opts.log ?? ((line) => console.error(line));
    this.#setup = opts.setup ?? [];
    this.#trace = opts.trace === true;
  }

  /** whether an instance is running (started and its DDL applied) */
  get started(): boolean {
    return this.#db !== null && this.#db.alive;
  }

  /** Runs raw frontend protocol bytes — one message or several (Parse, Bind, Describe, Execute, Sync in one buffer
   *  works) — and returns the backend's raw reply, starting the instance when needed. */
  run(message: Uint8Array): Promise<Uint8Array> {
    return this.#enqueue(async () => {
      const db = await this.#ensureStarted();
      const copy = new Uint8Array(message);
      const reply = await this.#ask(db, { op: "raw", bytes: copy }, "a statement", [copy.buffer]);
      this.#touch();
      return reply.bytes ?? new Uint8Array(0);
    });
  }

  /** The server's own catalog lookups and the tests: a statement through PGlite's API, its rows as objects. */
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }> {
    return this.#enqueue(async () => {
      const db = await this.#ensureStarted();
      const reply = await this.#ask(db, { op: "query", sql }, "a query");
      this.#touch();
      return { rows: reply.rows ?? [] };
    });
  }

  /** Stops the instance if one is running; the idle timer calls this. Resolves once it is gone. */
  stop(): Promise<void> {
    return this.#enqueue(() => this.#close("stopped"));
  }

  /** Swaps in a new schema (after an apply), and the roles with it (the roles file moved): the running instance is
   *  stopped and the next `run` starts with the new DDL. Resolves once the old instance is gone; a caller need not wait for it. */
  replace(schema: PgSchema, roles: ReadonlyMap<string, RoleGrants> = this.#roles): Promise<void> {
    this.#schema = schema;
    this.#roles = roles;
    this.#policies = [];
    this.#said.clear();
    return this.#enqueue(() => this.#close("replaced"));
  }

  /**
   * THE ROLES' ROW SECURITY POLICIES (`catalogPolicies`), written now (the instance started where needed) and at every
   * start after, until the next `replace`. A statement the catalog refuses is said, never fatal: the rows are the copy's.
   */
  policies(ddl: string[]): Promise<void> {
    return this.#enqueue(async () => {
      this.#policies = ddl;
      if (ddl.length === 0) return;
      const db = await this.#ensureStarted();
      for (const sql of ddl) {
        try { await this.#ask(db, { op: "query", sql }, "a row security policy"); }
        catch (e) { this.#log(`catalog: a row security policy left out (${errorMessage(e)}): ${sql}`); }
      }
      this.#touch();
    });
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(fn);
    // the chain only ORDERS calls: a rejection reaches the caller through `result`, and the next call must still run
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** one request of the worker; a worker that died (the deadline, a crash) is dropped so the next call starts afresh */
  async #ask(db: CatalogWorker, message: Record<string, unknown>, what: string, transfer: ArrayBuffer[] = []): Promise<Extract<Reply, { ok: true }>> {
    let reply: Reply;
    try {
      reply = await db.request(message, message["op"] === "init" ? Math.max(this.#statementMs, MIN_START_MS) : this.#statementMs, what, transfer);
    } catch (e) {
      if (this.#db === db) { this.#db = null; this.#log(`catalog: ${errorMessage(e)}`); }
      throw e;
    }
    if (!reply.ok) throw new Error(reply.message);
    return reply;
  }

  async #ensureStarted(): Promise<CatalogWorker> {
    if (this.#db !== null && this.#db.alive) return this.#db;
    this.#db = null;
    const schema = this.#schema, roles = this.#roles;
    const t0 = Date.now();
    const db = new CatalogWorker();
    try {
      const started = await this.#ask(db, { op: "init", statements: ["SET TimeZone = 'UTC'", ...catalogDdl(schema), ...catalogRoles(schema, roles), ...this.#setup],
        optional: [...catalogDefaults(schema), ...catalogViews(schema, roles), ...this.#policies] }, "its start");
      // each left-out default or view: one line, once per schema (the instance starts again after every idle stop)
      for (const r of started.refused ?? []) {
        const line = leftOutLine(r);
        if (this.#said.has(line)) continue;
        this.#said.add(line);
        this.#log(line);
        if (this.#trace) this.#log(`trace catalog: the statement left out: ${r.statement}`);
      }
    } catch (e) {
      // the half-made worker is discarded so the next `run` tries afresh
      await db.terminate();
      throw new Error(`PGlite could not start: ${errorMessage(e)}`, { cause: e });
    }
    this.#db = db;
    this.#log(`catalog: PGlite started in ${Date.now() - t0} ms with ${schema.tables.length} table(s)${roles.size > 0 ? ` and ${roles.size} role(s)` : ""}`);
    this.#touch();
    return db;
  }

  /** Every call resets the idle timer; the timer stops the instance only when nothing has used it since. */
  #touch(): void {
    this.#lastUsed = Date.now();
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#arm(this.#idleMs);
  }

  #arm(ms: number): void {
    this.#idleTimer = setTimeout(() => { this.#idleTimer = null; void this.#idleStop(); }, ms);
    this.#idleTimer.unref();
  }

  #idleStop(): Promise<void> {
    return this.#enqueue(async () => {
      const idle = Date.now() - this.#lastUsed;
      if (idle < this.#idleMs) {
        // a call queued ahead of this one has touched the timer again (it armed a new one; it decides) — OR the firing
        // was a millisecond early by the wall clock (timers run on the monotonic clock, `lastUsed` on Date.now(), and
        // the two round differently): then nothing is armed, and an instance that returned here stayed up for good
        // (CI: ~820 MB until the next statement). Arm again for what is left, never leave it running.
        if (this.#idleTimer === null && this.#db !== null) this.#arm(Math.max(1, this.#idleMs - idle));
        return;
      }
      await this.#close(`stopped after ${Math.round(this.#idleMs / 1000)} s idle`);
    });
  }

  async #close(why: string): Promise<void> {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    const db = this.#db;
    if (!db) return;
    this.#db = null;
    if (db.alive) {
      try {
        await this.#ask(db, { op: "close" }, "its close");
      } catch (e) {
        // the instance is discarded either way (terminated below); the failure is reported, not hidden
        this.#log(`catalog: PGlite did not close cleanly: ${errorMessage(e)}`);
      }
    }
    await db.terminate();
    this.#log(`catalog: PGlite ${why}`);
  }
}
