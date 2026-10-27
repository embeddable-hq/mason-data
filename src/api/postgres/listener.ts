/**
 * WHERE THE POSTGRES API LISTENS, READ IN ONE PLACE: `MASON_PG_PORT` (default 5433) and `MASON_PG_HOST`
 * (default: the host its caller names, 127.0.0.1 for a run). `mason start` reads it to listen and to record where its run's listener is for
 * `mason user` and `mason status` (src/cli/dev.ts); in the ClickHouse stack this was cut from, its Query API's
 * listener read it too, and its service's config check, to refuse a bad port at the start instead of a child
 * crash-looping — one reader, one default, so what the CLI prints is where the API listens (CLAUDE.md "Fix the
 * class": a fact derived in several places is one module's).
 *
 * WHETHER IT IS TLS, READ HERE TOO (the DuckDB run once fixed its host to 127.0.0.1 and its TLS to none, and on
 * the test server a TLS proxy had to be written beside Mason for a hosted BI tool): `MASON_PG_TLS_CERT` / `MASON_PG_TLS_KEY`
 * (PEM files, both or neither) and the plain-listener rule (src/api/postgres/plain.ts) are `pgListenerSettings`'s, read
 * by `mason start` and `mason serve` alike (src/cli/pg-tls.ts `runListenerSettings`) — `mason start --self-signed-tls` names its own files through
 * the same two variables (src/cli/pg-tls.ts), never a second reader.
 */
import * as fs from "node:fs";
import { parsePort } from "../../lib/port.ts";
import { plainListener, type ListenerProblem } from "./plain.ts";

export const DEFAULT_PG_PORT = 5433;

export interface PgListenerAddress { host: string; port: number }

/** The listener's address from `env`, or the problem with its port (`parsePort`'s words). */
export function pgListenerAddress(env: Readonly<Record<string, string | undefined>>, apiHost: string): PgListenerAddress | { problem: string } {
  const port = parsePort("MASON_PG_PORT", env.MASON_PG_PORT, DEFAULT_PG_PORT);
  if (port.problem !== undefined) return { problem: port.problem };
  return { host: env.MASON_PG_HOST || apiHost, port: port.port };
}

/** The listener's address and TLS, as configured: the certificate and key as FILES, read by `readPgTls` when it starts. */
export interface PgListenerSettings extends PgListenerAddress { tls: { cert: string; key: string } | null }

/** Where and how the listener listens, from `env` (`MASON_PG_HOST`, `MASON_PG_PORT`, `MASON_PG_TLS_CERT`,
 *  `MASON_PG_TLS_KEY`, `MASON_PG_PLAIN`), or why it cannot: a bad port, half a certificate, plain off loopback. Reads no
 *  file, so a start can be refused before anything is made. */
export function pgListenerSettings(env: Readonly<Record<string, string | undefined>>, apiHost: string): PgListenerSettings | ListenerProblem {
  const address = pgListenerAddress(env, apiHost);
  if ("problem" in address) return { problem: address.problem, kind: "port" };
  const cert = env.MASON_PG_TLS_CERT || undefined, key = env.MASON_PG_TLS_KEY || undefined;
  if ((cert && !key) || (key && !cert)) return { problem: "MASON_PG_TLS_CERT and MASON_PG_TLS_KEY go together (PEM files): set both, or neither for a plain listener", kind: "tls_pair" };
  const plain = plainListener(address.host, env.MASON_PG_PLAIN, Boolean(cert && key));
  if (plain !== null) return plain;
  return { ...address, tls: cert && key ? { cert, key } : null };
}

/** The certificate and key the settings name, read; or why not. */
export function readPgTls(files: { cert: string; key: string }): { cert: Buffer; key: Buffer } | ListenerProblem {
  try {
    return { cert: fs.readFileSync(files.cert), key: fs.readFileSync(files.key) };
  } catch (err) {
    return { problem: `cannot read MASON_PG_TLS_CERT / MASON_PG_TLS_KEY: ${err instanceof Error ? err.message : String(err)}`, kind: "tls_read" };
  }
}

/**
 * The Postgres API's address as a URL without credentials — `postgresql://<host>:<port>/<database>` — the form
 * `mason start` records in the project's config and `mason status` prints; `mason user add` puts a user and its
 * password in it (src/cli/pg-url.ts `connectionUrl`). A host of every interface (0.0.0.0, ::) is written as
 * localhost: that is where a tool on the machine reaches it. A TLS listener's ends `?sslmode=require`, the libpq word every driver takes:
 * it refuses a plain connection, so the URL a tool is handed says so.
 */
export function postgresApiUrl(address: PgListenerAddress, database: string, o: { tls?: boolean } = {}): string {
  const host = address.host === "0.0.0.0" || address.host === "::" ? "localhost" : address.host;
  return `postgresql://${host.includes(":") ? `[${host}]` : host}:${address.port}/${encodeURIComponent(database)}${o.tls ? "?sslmode=require" : ""}`;
}
