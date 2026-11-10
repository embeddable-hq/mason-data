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
import { readPublicUrl, type PublicSslmode } from "./pg-public-url.ts";
import type { PostgresListener } from "./project.ts";

/** Where a tool connects. `public`: the address is MASON_PG_PUBLIC_URL's (src/cli/pg-public-url.ts), the one a client
 *  reaches, not the listener's own; absent for the listener's. A recorded listener's sslmode is `require` or none. */
export interface PostgresLink { url: string; host: string; port: number; database: string; sslmode?: PublicSslmode; public?: true }

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
  return urlWith(link, `${encodeURIComponent(user)}${password === null ? "" : `:${encodeURIComponent(password)}`}`);
}

/** THE ONE BUILDER of a URL a client pastes: the link's host, port, database and sslmode, behind `credential`. */
function urlWith(link: PostgresLink, credential: string): string {
  const host = link.host.includes(":") ? `[${link.host}]` : link.host;
  return `postgres://${credential}@${host}:${link.port}/${encodeURIComponent(link.database)}` + (link.sslmode ? `?sslmode=${link.sslmode}` : "");
}

/**
 * WHERE A CLIENT CONNECTS TO A RUN, the one place it is decided: the address MASON_PG_PUBLIC_URL gave the run (recorded
 * as `running.postgresPublicUrl`, src/cli/pg-public-url.ts) when there is one — its host, port and sslmode, and its
 * database, else the run's — and else the listener's own, recorded (`postgresUrl`). Every command and the run's server
 * read a run's link here, so no line prints the listener's address where a client reaches another.
 */
export function clientLink(run: { postgresUrl: string; postgresPublicUrl?: string | null | undefined }): PostgresLink {
  const own = postgresLink(run.postgresUrl);
  if (run.postgresPublicUrl === undefined || run.postgresPublicUrl === null) return own;
  const p = readPublicUrl(run.postgresPublicUrl);
  if ("problem" in p) throw new Error(`the recorded public address of the Postgres API cannot be read: ${p.problem}`);
  const link: PostgresLink = { url: "", host: p.host, port: p.port, database: p.database ?? own.database, sslmode: p.sslmode, public: true };
  return { ...link, url: urlWith(link, "").replace(/^postgres:\/\/@/, "postgresql://") };
}

/** The link with the credentials' PLACE shown — `postgres://<user>:<password>@host:port/db` — for a line that must never
 *  carry a credential (mason start, mason status, the web page). */
export const shownUrl = (link: PostgresLink): string => urlWith(link, "<user>:<password>");
/** The recorded URL with the credentials' place shown: `shownUrl` of the listener's own link. */
export const withPlaceholders = (recorded: string): string => shownUrl(postgresLink(recorded));
/** The recorded URL back from its placeholder form (mason start's relay reads its own line). */
export const withoutPlaceholders = (shown: string): string => shown.replace(/^postgres:\/\/<user>:<password>@/, "postgresql://");

/** The psql line for a URL, quoted for a shell. */
export const psqlLine = (url: string): string => `psql ${shellWord(url)}`;

/** WHERE A TOOL CONNECTS, as `mason status --json` and `/api/state` say it (`postgres`): the recorded URL's parts, the
 *  URL with the credentials' place shown (`shown`, what `mason start` and `mason status` print) and its psql line — one
 *  builder, so the web page's Connect panel and the commands print the same line. `public: true`: the parts are
 *  MASON_PG_PUBLIC_URL's (`clientLink`), and no note to replace the host is shown; absent without it, so a run with
 *  none says what it said before. */
export const postgresFacts = (run: { postgresUrl: string; postgresPublicUrl?: string | null | undefined }): PostgresLink & { shown: string; psql: string } => {
  const link = clientLink(run);
  return { ...link, shown: shownUrl(link), psql: psqlLine(shownUrl(link)) };
};

/** What a tool connecting to the listener should know: it listens on every address; its certificate is self-signed.
 *  None where the client reaches a public address (`link.public`): that address is the operator's, its TLS the sslmode's. */
export function listenerTips(l: PostgresListener | null, link: PostgresLink | null = null): string[] {
  if (l === null || link?.public === true) return [];
  const elsewhere = elsewhereTip(l);
  return [
    ...(elsewhere ? [elsewhere] : []),
    ...(l.tls === "self-signed" ? [`The certificate is self-signed: sslmode=require encrypts and checks no certificate; to check it by hand, its SHA-256 is ${l.fingerprint ?? "in mason status"}.`] : []),
  ];
}
