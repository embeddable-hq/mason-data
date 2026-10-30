/**
 * THE POSTGRES API'S URL, as the commands print it (`mason connect`'s helpers before it went: `mason user` is the one
 * credential). A run records where its listener is as `postgresql://<host>:<port>/<database>` with no credential
 * (src/cli/dev.ts); `mason user add` prints the URL a tool pastes, with the user and its password in it; `mason start`
 * and `mason status` print it with the credential's PLACE shown, never a credential. WHAT A PERSON SEES BEGINS
 * `postgres://` (a printed `postgresql://` read as inconsistent with everything else the CLI shows): the scheme every
 * example, usage line and `mason init` uses; the recorded form keeps `postgresql://` (both are libpq's), and
 * `withoutPlaceholders` maps the shown form back to it.
 */
import { shellWord } from "../lib/shell-word.ts";
import { elsewhereTip } from "./pg-tls.ts";
import type { PostgresListener } from "./project.ts";

export interface PostgresLink { url: string; host: string; port: number; database: string; sslmode?: "require" }

/** The parts of a recorded `postgresql://<host>:<port>/<database>`. A URL that is not one is a bug in what wrote it, said so. */
export function postgresLink(recorded: string): PostgresLink {
  let u: URL;
  try { u = new URL(recorded); } catch { throw new Error(`the recorded Postgres API ${JSON.stringify(recorded)} is not a URL`); }
  if (u.protocol !== "postgresql:" || !u.port || u.pathname.length < 2) throw new Error(`the recorded Postgres API ${JSON.stringify(recorded)} is not postgresql://<host>:<port>/<database>`);
  // a bracketed IPv6 host is spelled as the driver takes it
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode !== null && sslmode !== "require") throw new Error(`the recorded Postgres API ${JSON.stringify(recorded)} has sslmode=${sslmode}: a run records require or none`);
  return { url: recorded, host: u.hostname.replace(/^\[|\]$/g, ""), port: Number(u.port), database: decodeURIComponent(u.pathname.slice(1)), ...(sslmode ? { sslmode } : {}) };
}

/** The connection URL a tool takes: the link with a user and its password, each escaped for a URL; with `password`
 *  null, the user alone (psql takes the password from PGPASSWORD). */
export function connectionUrl(link: PostgresLink, user: string, password: string | null): string {
  const host = link.host.includes(":") ? `[${link.host}]` : link.host;
  return `postgres://${encodeURIComponent(user)}${password === null ? "" : `:${encodeURIComponent(password)}`}@${host}:${link.port}/${encodeURIComponent(link.database)}` +
    (link.sslmode ? `?sslmode=${link.sslmode}` : "");
}

/** The recorded URL with the credentials' PLACE shown — `postgres://<user>:<password>@host:port/db` — for a line that
 *  must never carry a credential (mason start, mason status). */
export const withPlaceholders = (recorded: string): string => recorded.replace(/^postgresql:\/\//, "postgres://<user>:<password>@");
/** The recorded URL back from its placeholder form (mason start's relay reads its own line). */
export const withoutPlaceholders = (shown: string): string => shown.replace(/^postgres:\/\/<user>:<password>@/, "postgresql://");

/** The psql line for a URL, quoted for a shell. */
export const psqlLine = (url: string): string => `psql ${shellWord(url)}`;

/** WHERE A TOOL CONNECTS, as `mason status --json` and `/api/state` say it (`postgres`): the recorded URL's parts, the
 *  URL with the credentials' place shown (`shown`, what `mason start` and `mason status` print) and its psql line — one
 *  builder, so the web page's Connect panel and the commands print the same line. */
export const postgresFacts = (recorded: string): PostgresLink & { shown: string; psql: string } =>
  ({ ...postgresLink(recorded), shown: withPlaceholders(recorded), psql: psqlLine(withPlaceholders(recorded)) });

/** What a tool connecting to the listener should know: it listens on every address; its certificate is self-signed. */
export function listenerTips(l: PostgresListener | null): string[] {
  if (l === null) return [];
  const elsewhere = elsewhereTip(l);
  return [
    ...(elsewhere ? [elsewhere] : []),
    ...(l.tls === "self-signed" ? [`The certificate is self-signed: sslmode=require encrypts and checks no certificate; to check it by hand, its SHA-256 is ${l.fingerprint ?? "in mason status"}.`] : []),
  ];
}
