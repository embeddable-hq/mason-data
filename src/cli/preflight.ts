/**
 * BEFORE `mason start` STARTS ANYTHING: can it read the database, and should it? Every failure says what to change,
 * because the landing page's command is meant to be pasted and edited — a wrong password, a
 * database that does not exist, nothing listening, a URL whose password needs encoding. Then, for a database that is
 * not on this machine, what polling it would cost and where (src/cdc/poll.ts): a copy over the network, a scan of
 * every table each poll, a serverless compute kept awake. Read-only: nothing here writes to the database.
 *
 * The connection is the change reader's own (src/cdc/pg-wire.ts: TCP, password / md5 / SCRAM, TLS by sslmode), so
 * what passes here is what the service will use.
 */
import * as os from "node:os";
import { PgConnection, PgError } from "../cdc/pg-wire.ts";
import { parseDatabaseUrl, type PgConnection as UrlParts } from "../lib/database-url.ts";
import type { Failure, NextStep } from "./command.ts";

/** What `mason start` was given, completed the way libpq completes a URL: the user defaults to the OS user. */
export interface Source extends UrlParts { url: string; remote: boolean }

/** A host on this machine: polling it costs nothing that leaves the machine. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "::1" || h === "0.0.0.0" || /^127\./.test(h) || h === "host.docker.internal" || h.endsWith(".localhost");
}

/** The URL with its password masked: what is printed and shown, never the secret. */
export function maskedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    // not a URL: everything from the user's colon to the LAST @ is the password, whatever it holds (a / or an @ that
    // was not encoded) — a host never holds an @
    return url.replace(/:\/\/([^:@/]*):.*@/, "://$1:****@");
  }
}

/**
 * Parse the URL `mason start` was given. The user defaults to the OS user (libpq's default, and Homebrew's and
 * Postgres.app's superuser); the database never defaults — guessing it would read the wrong one.
 */
export function parseSource(url: string): { source: Source } | { problem: string } {
  let u: URL;
  try { u = new URL(url); } catch {
    // its password masked: the problem is printed (and, under mason mcp, kept in the MCP client's log)
    return { problem: `${JSON.stringify(maskedUrl(url))} is not a URL. The form is postgres://user:password@localhost:5432/your_app — a password ` +
      `containing @ : / # ? or % must be URL-encoded (encodeURIComponent; @ is %40).` };
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return { problem: `the URL's scheme is ${u.protocol.replace(/:$/, "")}; it must be postgres:// or postgresql://` };
  if (!u.username) u.username = encodeURIComponent(os.userInfo().username);
  if (!u.pathname.replace(/^\//, "")) {
    return { problem: `the URL names no database. Add it after the port: postgres://${decodeURIComponent(u.username)}@${u.host || "localhost:5432"}/your_app ` +
      `(the one your app uses — its DATABASE_URL usually says).` };
  }
  try {
    const parts = parseDatabaseUrl(u.toString());
    const remote = !isLocalHost(parts.host);
    // a database elsewhere is read over the network: never in the clear unless the URL says so outright
    if (remote && !u.searchParams.has("sslmode")) parts.sslmode = "require";
    return { source: { ...parts, url: u.toString(), remote } };
  } catch (e) {
    return { problem: (e as Error).message.replace(/^DATABASE_URL/, "the URL") };
  }
}

export interface ConnectFailure { message: string; hints: string[] }

/** How a connection is explained: `demo` when the project's database is the demo database mason start hosts
 *  (ProjectConfig.demo, from the project's config, never guessed from the URL), which nothing serves while it is down. */
export interface ConnectContext { demo?: boolean }

/** What a failed connection means, and what to change. */
export function explainConnectError(e: unknown, s: Source, o: ConnectContext = {}): ConnectFailure {
  const where = `${s.host}:${s.port}`;
  const msg = (e as Error)?.message ?? String(e);
  if (e instanceof PgError) {
    if (e.code === "28P01" || e.code === "28000") {
      return {
        message: `${where} refused user ${s.user}: ${msg}`,
        hints: [
          "Homebrew and Postgres.app: the user is your macOS username, with no password — postgres://" + os.userInfo().username + "@localhost:5432/your_app",
          "Docker's postgres image: the user is postgres (or POSTGRES_USER), the password POSTGRES_PASSWORD in your docker-compose.yml",
          "A Linux package (apt, dnf): the postgres user has no password until you set one (sudo -u postgres psql -c \"\\password postgres\"); Mason connects over TCP, so peer authentication does not apply",
          "Your app's DATABASE_URL (in .env) is a URL that works: pass that",
        ],
      };
    }
    if (e.code === "3D000") return { message: `${where} has no database ${JSON.stringify(s.database)}`, hints: [] };
    return { message: `${where}: ${msg}`, hints: [] };
  }
  if (/ECONNREFUSED/.test(msg)) {
    // the demo database is served by the project's own run: nothing else could be listening there
    if (o.demo) return { message: `the demo database is not running on ${where}`, hints: ["the demo database runs inside mason start: start it first"] };
    return {
      message: `nothing is listening on ${where}`,
      hints: [
        "Is Postgres running? (brew services list, docker ps, or Postgres.app's window)",
        "Supabase's local stack listens on 54322; a second Postgres on a machine is often on 5433",
      ],
    };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return { message: `the host ${s.host} does not resolve`, hints: ["Check the host name in the URL"] };
  if (/timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(msg)) {
    return {
      message: `${where} did not answer`,
      hints: s.remote
        ? ["A database in a private network (a VPC) is not reachable from this machine without a tunnel: ssh -L 5433:<db host>:5432 <bastion>, then postgres://…@localhost:5433/…"]
        : ["Is Postgres running, and listening on that port?"],
    };
  }
  if (/does not accept TLS/.test(msg)) {
    return { message: msg, hints: ["A database on another machine is read over TLS by default; add ?sslmode=disable to the URL only on a network you trust"] };
  }
  return { message: `${where}: ${msg}`, hints: [] };
}

/** Connect as the service will. The failure is explained; for a missing database, the ones that exist are listed. */
export async function connectSource(s: Source, o: ConnectContext = {}): Promise<{ pg: PgConnection } | { failure: ConnectFailure }> {
  const opts = { host: s.host, port: s.port, database: s.database, user: s.user, password: s.password, sslmode: s.sslmode, connectTimeoutMs: 10_000, applicationName: "mason-dev" };
  try {
    return { pg: await PgConnection.connect(opts) };
  } catch (e) {
    const failure = explainConnectError(e, s, o);
    if (e instanceof PgError && e.code === "3D000") {
      try {
        const pg = await PgConnection.connect({ ...opts, database: "postgres" });
        try {
          const names = (await pg.query("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname")).rows.map((r) => r[0]!);
          failure.hints.push(`The databases on ${s.host}:${s.port}: ${names.join(", ")}`);
        } finally { pg.close(); }
      } catch (inner) {
        // listing is a courtesy: the refusal above stands either way, and says why the list is missing
        failure.hints.push(`(could not list the databases there: ${(inner as Error).message})`);
      }
    }
    return { failure };
  }
}

export interface SourceTable {
  /** `schema.table` */
  source: string;
  schema: string;
  table: string;
  /** the primary key's columns, in key order; empty when it has none (and cannot be replicated) */
  key: string[];
  /** `pg_class.reltuples`, or an exact count where the table was never analysed; null when neither is known */
  rows: number | null;
  bytes: number;
  comment: string | null;
  columns: SourceColumnInfo[];
  /** single-column foreign keys out of this table, to another table's single-column primary key or unique index */
  foreignKeys: Array<{ column: string; target: string; targetColumn: string }>;
  /** its unique indexes over plain columns, the primary key's aside (an expression's or a partial one backs no foreign
   *  key): Mason's catalog has them, so a foreign key to one is listed (the BI-tools test of #517) */
  uniqueKeys?: UniqueKey[];
  /** the table's row type's OID in the SOURCE (pg_class.reltype): the wire's type for a whole row of it */
  rowTypeOid?: number;
  /** what identifies a changed row to logical replication (pg_class.relreplident): `d` its primary key, `f` the whole
   *  row, `i` an index, `n` NOTHING — a table that cannot be under `sync: replication` (src/cli/sources.ts entryProblems) */
  replicaIdentity?: "d" | "n" | "f" | "i";
}
export interface UniqueKey {
  /** the index's name, as pg_indexes lists it */
  name: string;
  columns: string[];
  /** a UNIQUE constraint made it (pg_constraint lists it too), not a CREATE UNIQUE INDEX */
  constraint: boolean;
  nullsNotDistinct: boolean;
}
export interface SourceColumnInfo {
  name: string;
  /** as `format_type` spells it; a domain's column its base type's (`domain`) */
  type: string; notNull: boolean; comment: string | null;
  /** pg_type.typtype of the type, or of an array's element (`b`, `e`, `c`, `r`, `m`, `d`): src/duck/held-types.ts */
  typeKind?: string;
  /** a column of a domain, read and declared as its base type (gap `domain-column`) */
  domain?: true;
  /** the type's OID in the SOURCE (pg_type), for a type an extension made (citext): the wire sends the source's OID,
   *  which differs between databases; absent for a built-in type, and in copies recorded before it was read */
  typeOid?: number;
  /** that type's array type's OID in the source (pg_type.typarray), for the same reason */
  typeArrayOid?: number;
  /** the column's DEFAULT as the source prints it (`pg_get_expr`: `nextval('orders_id_seq'::regclass)`), never a
   *  generated column's expression; absent for none. Mason's catalog declares it */
  default?: string;
  /** an identity column's kind (pg_attribute.attidentity: `a` ALWAYS, `d` BY DEFAULT) */
  identity?: "a" | "d";
  /** a STORED generated column (pg_attribute.attgenerated) */
  generated?: true;
  /** the sequence a serial or identity column owns, qualified and quoted as `pg_get_serial_sequence` returns it */
  sequence?: string;
}

export interface SourceFacts {
  version: number;
  versionText: string;
  /** a read replica: what polling a database elsewhere should read */
  standby: boolean;
  tables: SourceTable[];
  /**
   * the server's identity (`pg_control_system().system_identifier`): the same on every connection to one server, new
   * on a server the database was restored to. null when this user may not read it (a function revoked from PUBLIC)
   */
  systemIdentifier: string | null;
  /** how the database orders text (pg_database: `provider` c libc, i ICU, b builtin; `locale` ICU's or builtin's):
   *  Mason sorts as it does (src/duck/rewrite.ts DuckCollation) */
  collation?: { provider: string; collate: string; locale: string | null; version?: string | null };
  /** the views this user can read (Mason serves them over the copied tables, src/duck/views.ts) */
  views?: SourceView[];
}

/** A view of the source: its definition with every name outside pg_catalog qualified (VIEWS_SQL), so it means the
 *  same under any search_path */
export interface SourceView { schema: string; name: string; definition: string; comment: string | null }

/** The source's plain views (never a materialized one: that is a table of its own), each definition printed under a
 *  search_path of pg_catalog alone, which qualifies every table, type and function a view reads (`public.orders`):
 *  `SET LOCAL` holds for the rest of this one Query and ends with it, whatever happens */
export const VIEWS_SQL = `SET LOCAL search_path = pg_catalog; SELECT coalesce(json_agg(v ORDER BY v.oid), '[]'::json)::text FROM (
  SELECT c.oid, n.nspname AS schema, c.relname AS name, pg_get_viewdef(c.oid) AS definition, obj_description(c.oid, 'pg_class') AS comment
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'v' AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    AND has_table_privilege(c.oid, 'SELECT')
) v`;

/** One catalog read: every ordinary or partitioned table outside the system schemas, its key, size, comments and FKs. */
export const TABLES_SQL = `SELECT json_agg(t ORDER BY t.schema, t.table)::text FROM (
  SELECT n.nspname AS schema, c.relname AS table, c.oid, c.reltype AS row_type_oid, c.relreplident AS replica_identity,
    -- a PARTITIONED table's rows and bytes are its leaves' (its own are -1 / 0 and ~0 bytes); "never analysed" is
    -- relpages = 0 AND reltuples <= 0 on any leaf, which Postgres 13 (reltuples 0) and 14+ (-1) both read
    CASE WHEN c.relkind = 'p'
      THEN (SELECT coalesce(sum(greatest(l.reltuples, 0)), 0)::bigint FROM pg_partition_tree(c.oid) pt JOIN pg_class l ON l.oid = pt.relid WHERE pt.isleaf)
      ELSE greatest(c.reltuples, 0)::bigint END AS reltuples,
    CASE WHEN c.relkind = 'p'
      THEN coalesce((SELECT bool_or(l.relpages = 0 AND l.reltuples <= 0) FROM pg_partition_tree(c.oid) pt JOIN pg_class l ON l.oid = pt.relid WHERE pt.isleaf), false)
      ELSE c.relpages = 0 AND c.reltuples <= 0 END AS unanalysed,
    CASE WHEN c.relkind = 'p'
      THEN (SELECT coalesce(sum(pg_total_relation_size(pt.relid)), 0) FROM pg_partition_tree(c.oid) pt WHERE pt.isleaf)
      ELSE pg_total_relation_size(c.oid) END AS bytes,
    obj_description(c.oid, 'pg_class') AS comment,
    -- the primary key: only a valid index enforces it
    (SELECT coalesce(json_agg(a.attname ORDER BY k.n), '[]'::json)
      FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = c.oid AND i.indisprimary AND i.indisvalid) AS key,
    (SELECT coalesce(json_agg(json_build_object('name', ic.relname, 'constraint', EXISTS (SELECT FROM pg_constraint u WHERE u.conindid = i.indexrelid AND u.contype = 'u'),
        -- indnullsnotdistinct is Postgres 15's: read through the row, which an older server's lacks
        'nulls_not_distinct', coalesce((to_jsonb(i) ->> 'indnullsnotdistinct')::boolean, false),
        'columns', (SELECT json_agg(a.attname ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, n)
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum)) ORDER BY ic.relname), '[]'::json)
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      -- an INVALID index (a CREATE UNIQUE INDEX CONCURRENTLY that failed, its duplicates still in the table) enforces
      -- nothing: never declared to the catalog, never a key: Mason accepts
      WHERE i.indrelid = c.oid AND i.indisunique AND i.indisvalid AND NOT i.indisprimary AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnkeyatts = i.indnatts) AS unique_keys,
    (SELECT coalesce(json_agg(json_build_object('name', a.attname, 'type', format_type(b.oid, b.mod), 'domain', b.oid <> a.atttypid,
        'not_null', a.attnotnull, 'comment', col_description(c.oid, a.attnum), 'type_oid', b.oid,
        'type_array_oid', (SELECT typarray FROM pg_type WHERE oid = b.oid),
        'type_kind', (SELECT coalesce(e.typtype, t.typtype) FROM pg_type t LEFT JOIN pg_type e ON e.typarray = t.oid WHERE t.oid = b.oid),
        'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity, 'generated', a.attgenerated,
        -- the sequence a serial or identity column owns: asked only of a column with a default or an identity
        'sequence', CASE WHEN d.adbin IS NOT NULL OR a.attidentity <> '' THEN pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) END) ORDER BY a.attnum), '[]'::json)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      -- a domain's column is read and declared as its base type (a domain of a domain too)
      CROSS JOIN LATERAL (WITH RECURSIVE base(oid, mod) AS (SELECT a.atttypid, a.atttypmod UNION ALL
          SELECT t.typbasetype, t.typtypmod FROM base JOIN pg_type t ON t.oid = base.oid WHERE t.typtype = 'd')
        SELECT base.oid, base.mod FROM base JOIN pg_type t ON t.oid = base.oid WHERE t.typtype <> 'd') b
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped) AS columns,
    (SELECT coalesce(json_agg(json_build_object('column', a.attname, 'target', tn.nspname || '.' || tc.relname, 'target_column', ta.attname)), '[]'::json)
      FROM pg_constraint f
      JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = f.conkey[1]
      JOIN pg_class tc ON tc.oid = f.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
      JOIN pg_attribute ta ON ta.attrelid = f.confrelid AND ta.attnum = f.confkey[1]
      WHERE f.conrelid = c.oid AND f.contype = 'f' AND cardinality(f.conkey) = 1) AS foreign_keys
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
    AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'
    AND has_table_privilege(c.oid, 'SELECT')
) t`;

interface TableRow {
  schema: string; table: string; oid: number; row_type_oid: number | string; replica_identity: string; reltuples: number; unanalysed: boolean; bytes: number; comment: string | null; key: string[];
  unique_keys: Array<{ name: string; constraint: boolean; nulls_not_distinct: boolean; columns: string[] }>;
  columns: Array<{ name: string; type: string; domain: boolean; type_kind: string; not_null: boolean; comment: string | null; type_oid: number | string; type_array_oid: number | string;
    default: string | null; identity: string; generated: string; sequence: string | null }>;
  foreign_keys: Array<{ column: string; target: string; target_column: string }>;
}

/** What a never-analysed table counted to, by oid: `mason start` reads the catalog every 10 s, and a table is counted
 *  once per run, never per read (review of #404: a remote one over the network each time). */
const COUNTED = new Map<number, number>();

/** the server_version_num from which `pg_database_collation_actual_version` exists */
const COLLATION_ACTUAL_VERSION_NUM = 150000;
const COLLATION_ACTUAL_VERSION_SQL = "SELECT pg_database_collation_actual_version(oid) FROM pg_database WHERE datname = current_database()";

/** The collation library's version now, else what the database recorded (`recorded`, datcollversion; before Postgres 15, none). */
export async function collationVersion(pg: Pick<PgConnection, "query">, versionNum: number, recorded: string | null): Promise<string | null> {
  if (versionNum < COLLATION_ACTUAL_VERSION_NUM) return recorded;
  return (await pg.query(COLLATION_ACTUAL_VERSION_SQL)).rows[0]?.[0] ?? recorded;
}

/** The database's facts: its version, whether it is a standby, and every table this user can read. */
export async function readSourceFacts(pg: PgConnection, counted: Map<number, number> = COUNTED): Promise<SourceFacts> {
  const r = (await pg.query("SELECT current_setting('server_version_num'), current_setting('server_version'), pg_is_in_recovery()::text")).rows[0]!;
  const rows = JSON.parse((await pg.query(TABLES_SQL)).rows[0]?.[0] ?? "null") as TableRow[] | null;
  const tables: SourceTable[] = [];
  for (const t of rows ?? []) {
    let count: number | null = t.unanalysed ? counted.get(t.oid) ?? null : Number(t.reltuples);
    // never analysed: count it when it is small enough to count in a moment, once; a larger one's size is unknown (null)
    if (count === null && t.unanalysed && Number(t.bytes) < 64 * 1024 * 1024) {
      count = Number((await pg.query(`SELECT count(*) FROM ${pgQualified(t.schema, t.table)}`)).rows[0]?.[0] ?? "0");
      counted.set(t.oid, count);
    }
    tables.push({
      source: `${t.schema}.${t.table}`, schema: t.schema, table: t.table, key: t.key, rows: count, bytes: Number(t.bytes), comment: t.comment,
      columns: t.columns.map((c) => ({ name: c.name, type: c.type, typeKind: c.type_kind, ...(c.domain ? { domain: true as const } : {}), notNull: c.not_null, comment: c.comment,
        // an oid is a STRING in Postgres's JSON (only the int, float and numeric types are numbers): one spelling, here
        ...(Number(c.type_oid) >= 16384 ? { typeOid: Number(c.type_oid), ...(Number(c.type_array_oid) > 0 ? { typeArrayOid: Number(c.type_array_oid) } : {}) } : {}),
        // a generated column's pg_attrdef row is its expression, never a default
        ...(c.default !== null && c.generated === "" ? { default: c.default } : {}), ...(c.identity === "a" || c.identity === "d" ? { identity: c.identity } : {}),
        ...(c.generated === "s" ? { generated: true as const } : {}), ...(c.sequence !== null ? { sequence: c.sequence } : {}) })),
      foreignKeys: t.foreign_keys.map((f) => ({ column: f.column, target: f.target, targetColumn: f.target_column })),
      uniqueKeys: t.unique_keys.map((u) => ({ name: u.name, columns: u.columns, constraint: u.constraint, nullsNotDistinct: u.nulls_not_distinct })),
      ...(Number(t.row_type_oid) > 0 ? { rowTypeOid: Number(t.row_type_oid) } : {}),
      ...(t.replica_identity === "d" || t.replica_identity === "n" || t.replica_identity === "f" || t.replica_identity === "i" ? { replicaIdentity: t.replica_identity } : {}),
    });
  }
  // the columns differ by version (datlocprovider from 15, daticulocale 15–16, datlocale from 17): read the row whole
  const db = JSON.parse((await pg.query("SELECT to_jsonb(d)::text FROM pg_database d WHERE datname = current_database()")).rows[0]?.[0] ?? "{}") as Record<string, string | null>;
  // the library's version of it NOW (Postgres 15+; glibc's for libc): datcollversion is what the database was created or
  // last refreshed under, so it stays where it was through an OS upgrade, which is what must read the order again
  const collation = { provider: db.datlocprovider ?? "c", collate: db.datcollate ?? "C", locale: db.datlocale ?? db.daticulocale ?? null, version: await collationVersion(pg, Number(r[0]), db.datcollversion ?? null) };
  const views = (JSON.parse((await pg.query(VIEWS_SQL)).rows[0]?.[0] ?? "[]") as Array<SourceView & { oid: number }>)
    .map((v) => ({ schema: v.schema, name: v.name, definition: v.definition, comment: v.comment }));
  return { version: Number(r[0]), versionText: r[1] ?? "", standby: r[2] === "true", tables, systemIdentifier: await systemIdentifier(pg), collation, views };
}

/** The server's system identifier, or null when this user may not read it (only that refusal: any other error is real). */
export async function systemIdentifier(pg: PgConnection): Promise<string | null> {
  try { return (await pg.query("SELECT system_identifier::text FROM pg_control_system()")).rows[0]?.[0] ?? null; }
  catch (e) {
    // 42501 insufficient_privilege: a server that revoked pg_control_system from PUBLIC. The identity is then unknown,
    // which mason start says it cannot check; it is never guessed
    if (e instanceof PgError && e.code === "42501") return null;
    throw e;
  }
}

const pgQualified = (schema: string, table: string): string => `"${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;

/** Hosts whose compute sleeps when idle and bills while awake: polling keeps it awake. */
export function serverlessHost(host: string): string | null {
  if (/\.neon\.tech$/i.test(host)) return "Neon";
  if (/\.aws\.neon\.build$/i.test(host)) return "Neon";
  if (/\.supabase\.(co|com)$/i.test(host)) return null;   // always on: no sleep to keep awake
  if (/serverless/i.test(host) && /\.rds\.amazonaws\.com$/i.test(host)) return "Aurora Serverless";
  return null;
}

/** Why a table cannot be picked, or null: no primary key (a row version needs one). Its size is never a reason, here or
 *  on a database elsewhere (the tables worth copying are the big ones). */
export function unpickableReason(t: SourceTable): string | null {
  if (t.key.length === 0) return "no primary key: Mason keeps one row per key, so it can only sync a table that has one";
  return null;
}

/** The warnings `mason start` prints, and `mason status` shows, before anything is copied. */
export function sourceWarnings(s: Source, f: SourceFacts): string[] {
  const out: string[] = [];
  if (!s.remote) return out;
  out.push(remoteWarning(s));
  if (!f.standby) out.push("this is a PRIMARY (pg_is_in_recovery() = false): the database your app writes to. A read replica takes the reads instead");
  const sleeper = serverlessHost(s.host);
  if (sleeper) out.push(`${sleeper} suspends an idle compute and bills while it runs: polling every few seconds, or an open replication connection, keeps it running`);
  return out;
}

/** The warning a database on another machine gets at every start: what the copy is and how it is kept current (true of
 *  both modes — the mode is the start's, not known here: a poll scans each table, replication reads the change log). */
export function remoteWarning(s: Source): string {
  return `${s.host} is not this machine. mason start will sync the tables you pick to this machine (into its synced data's file, ` +
    "with no access control beyond this machine's), and keep them current while it runs: a scan of each table at every poll, or its change log for a table whose sync: is replication";
}

/**
 * THE CONFIRMATION A DATABASE ON ANOTHER MACHINE NEEDS (the refusal read as a failed connection and then a fix: only a
 * careful reading showed it was a warning that wanted a yes, and what the risks were). It is not
 * a failed step — the check passed — but a stop before anything is written or started, said as one failure a reader
 * scans: what stopped (the message), what would happen and the risk (why), the one way to say yes (fix, next).
 */
export function remoteConfirmation(host: string, o: { cmd: "mason init" | "mason start"; wayOut: string; next: readonly NextStep[] }): Failure {
  return { code: "failed", exit: 1,
    message: `stopped before ${o.cmd === "mason init" ? "writing anything" : "starting"}: ${host} is on another machine, and syncing from it needs your say-so`,
    why: "mason start would sync the tables you pick to this machine: a file under .mason/, with no access control beyond this machine's\n" +
      "and keep them current while it runs by reading that database: a scan of each table at every poll, or its change log for a table whose sync: is replication",
    fix: o.wayOut, next: o.next };
}

/** `pg_current_snapshot()` and xid8, which polling reads, arrived in Postgres 13. */
export function versionProblem(f: SourceFacts): string | null {
  return f.version >= 130000 ? null : `mason start needs Postgres 13 or later (pg_current_snapshot, which it polls with); this is ${f.versionText}`;
}

/** A database that passed the check `mason init` and `mason start` both make. */
export interface CheckedSource { source: Source; facts: SourceFacts; warnings: string[] }
/** One that passed it but is on another machine, which the caller has not confirmed: said with `remoteConfirmation`,
 *  after the check's own facts — never as a failed connection. */
export interface NeedsRemote { needsRemote: CheckedSource }

/**
 * THE ONE CHECK OF A DATABASE (init checks the Postgres connection too, and fails when it cannot connect): connect as
 * the service will, read its version and tables, say the warnings, and refuse a database on another machine unless
 * `remote` says it is meant — `mason init` before it writes anything, `mason start` before it starts anything. Every
 * refusal is said through `say`, with the way out; the result is the exit code then. A database elsewhere that only
 * lacks the confirmation is answered as `NeedsRemote`: the caller says the confirmation, in its own command's words,
 * after the check's facts.
 */
export async function checkSource(url: string, o: { remote: boolean; cmd: string; say: (m: string) => void; progress?: (m: string) => void }): Promise<CheckedSource | NeedsRemote | { exit: number }> {
  const parsed = parseSource(url);
  if ("problem" in parsed) { o.say(`${o.cmd}: ${parsed.problem}`); return { exit: 2 }; }
  const source = parsed.source;
  // progress, not a finding: a caller with a checklist of its own (mason start) says it there
  (o.progress ?? o.say)(`${o.cmd}: connecting to ${maskedUrl(source.url)} …`);
  const connected = await connectSource(source);
  if ("failure" in connected) {
    o.say(`${o.cmd}: could not connect: ${connected.failure.message}`);
    for (const h of connected.failure.hints) o.say(`  - ${h}`);
    return { exit: 1 };
  }
  let facts: SourceFacts;
  try { facts = await readSourceFacts(connected.pg); } finally { connected.pg.close(); }
  const tooOld = versionProblem(facts);
  if (tooOld) { o.say(`${o.cmd}: ${tooOld}`); return { exit: 1 }; }
  const warnings = sourceWarnings(source, facts);
  o.say(`  Postgres ${facts.versionText}${facts.standby ? " (a read replica)" : ""}, ${facts.tables.length} table(s) this user can read. ` +
    "Mason only reads it: no setting, slot or publication is needed or made.");
  for (const w of warnings) o.say(`  ! ${w}`);
  if (source.remote && !o.remote) return { needsRemote: { source, facts, warnings } };
  return { source, facts, warnings };
}
