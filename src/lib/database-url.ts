/**
 * `DATABASE_URL`, THE ONE CONNECTION STRING A MASON DEPLOYMENT IS GIVEN. An application's
 * Postgres is almost always described by one URL (`postgres://user:password@host:5432/db?sslmode=require`),
 * while every script here reads the `PG_*` variables. This turns
 * the first into the second, once, at the top of the `mason` service, so every child it starts — the
 * change reader, bootstrap's `source_pg` collection, the source-type reader — sees the same connection.
 *
 * An explicit `PG_*` variable WINS over the URL: it is the more specific of the two, and a deployment's `.env`
 * may already set them. Unknown query parameters are refused rather than ignored, so a `sslrootcert=` that
 * would have been silently dropped fails at start instead of connecting without it.
 *
 * Pure; dependency-free.
 */

export interface PgConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** libpq's sslmode; `prefer` when the URL names none, as libpq does. */
  sslmode: "disable" | "allow" | "prefer" | "require" | "verify-ca" | "verify-full";
}

export const SSLMODES: ReadonlySet<string> = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
/** The query parameters a URL may carry: the only ones read, and so the only ones a URL is shown with (src/cli/preflight.ts shownUrl). */
export const KNOWN_PARAMS: ReadonlySet<string> = new Set(["sslmode", "application_name"]);
/** application_name's value as a URL may give it: what is shown of it, so it can hold nothing else (a `password=…`). */
const APPLICATION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The parameters a refusal may NAME: libpq's documented connection keywords and a few drivers' own (Prisma's, node-postgres's),
 * a fixed list, so a key said is Mason's word, never an arbitrary part of the value (issue 541).
 */
const NAMED_PARAMS: ReadonlySet<string> = new Set([
  "host", "hostaddr", "port", "dbname", "user", "password", "passfile", "require_auth", "channel_binding", "connect_timeout",
  "client_encoding", "options", "fallback_application_name", "keepalives", "keepalives_idle", "keepalives_interval",
  "keepalives_count", "tcp_user_timeout", "replication", "gssencmode", "requiressl", "sslnegotiation", "sslcompression",
  "sslcert", "sslkey", "sslpassword", "sslcertmode", "sslrootcert", "sslcrl", "sslcrldir", "sslsni", "requirepeer",
  "ssl_min_protocol_version", "ssl_max_protocol_version", "min_protocol_version", "max_protocol_version", "krbsrvname",
  "gsslib", "gssdelegation", "service", "target_session_attrs", "load_balance_hosts", "scram_client_key",
  "scram_server_key", "oauth_issuer", "oauth_client_id", "oauth_client_secret", "oauth_scope",
  "pgbouncer", "schema", "connection_limit", "pool_timeout", "socket_timeout", "statement_cache_size", "ssl", "sslaccept",
]);
/** The parameters that carry a password: where the URL puts it instead is said. */
const PASSWORD_PARAMS: ReadonlySet<string> = new Set(["password", "sslpassword"]);

/**
 * THE ONE READING OF A URL'S QUERY (issue 541): null when every parameter is one the URL is read with, given once, its
 * value one the reading accepts — `sslmode` one of SSLMODES, `application_name` letters, digits, `.`, `_` and `-` (at
 * most 64) — else what is wrong, in words that NAME a parameter only from Mason's own lists and never repeat a value.
 * `parseDatabaseUrl` refuses by it, and `shownUrl` shows a URL only when it is null, so no part shown is one not read.
 */
export function queryProblem(params: URLSearchParams): string | null {
  const keys = [...params.keys()];
  const unread = keys.filter((k) => !KNOWN_PARAMS.has(k));
  if (unread.length) {
    const named = [...new Set(unread.map((k) => k.toLowerCase()).filter((k) => NAMED_PARAMS.has(k)))];
    const others = unread.some((k) => !NAMED_PARAMS.has(k.toLowerCase()));
    const what = named.length === 0 ? "a parameter Mason does not read"
      : `${named.length === 1 ? "the parameter" : "the parameters"} ${named.join(", ")}${others ? ", and another," : ","} which Mason does not read`;
    const way = named.some((k) => PASSWORD_PARAMS.has(k)) ? "a password goes before the host, postgres://user:password@host:5432/your_app"
      : "leave it out of the URL";
    return `it has ${what} (it reads ${[...KNOWN_PARAMS].join(" and ")} alone): ${way}`;
  }
  for (const k of KNOWN_PARAMS) if (params.getAll(k).length > 1) return `it gives ${k} more than once: give it once`;
  const sslmode = params.get("sslmode");
  if (sslmode !== null && !SSLMODES.has(sslmode)) return `its sslmode is not one of ${[...SSLMODES].join(", ")}`;
  const name = params.get("application_name");
  if (name !== null && !APPLICATION_NAME.test(name)) return "its application_name is not letters, digits, . _ and - (at most 64): give it in those, or leave it out";
  return null;
}

/** Parse a `postgres://` / `postgresql://` URL. Throws on anything it cannot represent faithfully, never repeating a part of it. */
export function parseDatabaseUrl(url: string): PgConnection {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("DATABASE_URL is not a URL (expected postgres://user:password@host:port/database)"); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL: its scheme is not postgres or postgresql");
  }
  const query = queryProblem(u.searchParams);
  if (query !== null) throw new Error(`DATABASE_URL: ${query}`);
  const sslmode = u.searchParams.get("sslmode") ?? "prefer";
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!u.hostname) throw new Error("DATABASE_URL has no host");
  if (!database) throw new Error("DATABASE_URL has no database name (the path after the host)");
  if (!u.username) throw new Error("DATABASE_URL has no user");
  return {
    // `new URL` keeps IPv6 brackets; libpq and ClickHouse's postgresql() want the bare address
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port ? Number(u.port) : 5432,
    database,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    sslmode: sslmode as PgConnection["sslmode"],
  };
}

/**
 * Lay `DATABASE_URL` under `env`'s own `PG_*` variables: each one the environment does not already set is
 * filled from the URL. Returns the names it filled, so the caller can log where the connection came from
 * (never the values: the password is among them).
 */
export function applyDatabaseUrl(env: NodeJS.ProcessEnv): string[] {
  const url = env.DATABASE_URL;
  if (!url) return [];
  const c = parseDatabaseUrl(url);
  const values: Record<string, string> = {
    PG_HOST: c.host, PG_PORT: String(c.port), PG_DATABASE: c.database, PG_USER: c.user,
    PG_PASSWORD: c.password, PG_SSLMODE: c.sslmode,
  };
  const filled: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (env[k]) continue;
    env[k] = v;
    filled.push(k);
  }
  return filled;
}
