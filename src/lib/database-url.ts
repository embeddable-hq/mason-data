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

const SSLMODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
const KNOWN_PARAMS = new Set(["sslmode", "application_name"]);

/** Parse a `postgres://` / `postgresql://` URL. Throws on anything it cannot represent faithfully. */
export function parseDatabaseUrl(url: string): PgConnection {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("DATABASE_URL is not a URL (expected postgres://user:password@host:port/database)"); }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") {
    throw new Error(`DATABASE_URL: scheme ${u.protocol.replace(/:$/, "")} is not postgres or postgresql`);
  }
  for (const key of u.searchParams.keys()) {
    if (!KNOWN_PARAMS.has(key)) throw new Error(`DATABASE_URL: parameter ${key} is not supported (only ${[...KNOWN_PARAMS].join(", ")})`);
  }
  const sslmode = u.searchParams.get("sslmode") ?? "prefer";
  if (!SSLMODES.has(sslmode)) throw new Error(`DATABASE_URL: sslmode=${sslmode} is not one of ${[...SSLMODES].join(", ")}`);
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
