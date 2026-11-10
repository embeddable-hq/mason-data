/**
 * `MASON_PG_PUBLIC_URL` (mason serve; issue 501): THE POSTGRES API'S ADDRESS AS A CLIENT REACHES IT. Behind a load
 * balancer, a proxy or a DNS name, the address the listener records (`running.postgresUrl`, `127.0.0.1:5433`) is the
 * server's own view of itself, and a person or an agent who pastes it gets a connection that fails. With this set, every
 * URL Mason prints for a client to paste — `mason status` (text and `--json`), `mason user add`, the web page's Connect
 * panels and its psql line — is built from it by ONE builder (src/cli/pg-url.ts `clientLink`, then `connectionUrl`), and
 * the note to replace the host is not shown. Unset, nothing changes.
 *
 * WHAT IT MAY HOLD, and nothing else (refused at the start, the value never quoted: an operator who pasted a URL with a
 * password must not see it in a log):
 *   - the scheme `postgres://` or `postgresql://`;
 *   - a host: a name or an IPv4 address (letters, digits, `.` and `-`; a name outside ASCII in its `xn--` form) or an
 *     IPv6 address in brackets;
 *   - a port (1-65535); none is 5432, libpq's own default, written out in every URL Mason prints;
 *   - a database, optional: none is the one the run answers as; one named is printed as it is (a proxy that maps names);
 *   - `?sslmode=` disable, require, verify-ca or verify-full, REQUIRED: whether a client uses TLS on the way to the
 *     address it reaches is the operator's to say (the proxy's TLS, not the listener's); `allow` and `prefer` are refused,
 *     a client that falls back to plain sending a password in clear.
 * NO USER AND NO PASSWORD: a secret never goes in a setting that every page and command prints. No other parameter, no
 * fragment.
 *
 * TLS: the listener's own TLS (MASON_PG_TLS_CERT, MASON_PG_SELF_SIGNED_TLS, MASON_PG_PLAIN) is not checked against the
 * `sslmode` here: what sits between the client and the listener (a TLS-terminating proxy in front of a plain listener,
 * a TCP pass-through to a TLS one) cannot be known from inside. `sslmode=disable` in front of a listener that requires
 * TLS works only through a proxy that encrypts on its side; docs/POSTGRES-API.md "The address clients reach" says so.
 */
import * as net from "node:net";
import { databaseNameProblem } from "../lib/database-name.ts";

export const PG_PUBLIC_URL_SETTING = "MASON_PG_PUBLIC_URL";

/** The `sslmode` values the setting takes: each one a client keeps to (never one that falls back to plain). */
export const PUBLIC_SSLMODES = ["disable", "require", "verify-ca", "verify-full"] as const;
export type PublicSslmode = typeof PUBLIC_SSLMODES[number];

/** The longest value taken, in characters: far past any real address. */
export const PUBLIC_URL_MAX = 2048;

/** libpq's port when a URL names none. */
const LIBPQ_PORT = 5432;

/** The address a client reaches: `database` null is the run's own. */
export interface PublicPostgres { host: string; port: number; database: string | null; sslmode: PublicSslmode }

/**
 * THE ONE READING of a public address, the setting's and the run's record of it (`running.postgresPublicUrl`, written
 * by `publicUrlText`) alike: the parts, or what is wrong with it in words that never quote the value.
 */
export function readPublicUrl(v: string): PublicPostgres | { problem: string } {
  const at = `${PG_PUBLIC_URL_SETTING} is set`;
  const shape = "postgres://<host>:<port>/<database>?sslmode=<mode>";
  if (v.length > PUBLIC_URL_MAX) return { problem: `${at} to ${v.length} characters, and an address is at most ${PUBLIC_URL_MAX}: ${shape}` };
  if (!/^[\x21-\x7e]*$/.test(v)) return { problem: `${at} to a URL with a control character, a space or a character outside ASCII: write a host in its xn-- form and a database %-encoded` };
  // read part by part, by hand: a URL parser resolves what it reads (dot segments, a default port), and the address must
  // be what was written
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(v);
  const scheme = m?.[1]?.toLowerCase();
  if (m === null || (scheme !== "postgres" && scheme !== "postgresql")) return { problem: `${at} to ${scheme === undefined ? "no URL" : `a URL of the scheme ${scheme}://`}: ${shape}` };
  const [, , authority = "", path = "", query = "", fragment] = m;
  // a user or a password is refused before anything else is read: the authority's `@` alone says there is one
  if (authority.includes("@")) return { problem: `${at} to a URL with a user or a password in it, which every page and command would print: remove them (a user's name and password are mason user add's)` };
  if (fragment !== undefined) return { problem: `${at} to a URL with a #fragment: remove it` };
  const hp = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(authority)!;
  const hostText = hp[1]!, portText = hp[2];
  const ipv6 = hostText.startsWith("[");
  const name = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
  if (hostText === "" || (ipv6 ? !net.isIPv6(hostText.slice(1, -1)) : !name.test(hostText))) {
    return { problem: `${at} to a URL with ${hostText === "" ? "no host" : "a host that is not a name or an address"}: a name (db.example.com), an IPv4 address, or an IPv6 one in brackets` };
  }
  let port = LIBPQ_PORT;
  if (portText !== undefined) {
    port = Number(portText);
    if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65_535) return { problem: `${at} to a URL whose port is not 1-65535: name it, or leave out the : for ${LIBPQ_PORT}` };
  }
  let database: string | null = null;
  if (path !== "" && path !== "/") {
    let decoded: string;
    try { decoded = decodeURIComponent(path.slice(1)); } catch { return { problem: `${at} to a URL whose database is not %-encoded right` }; }
    if (path.slice(1).includes("/")) return { problem: `${at} to a URL whose path is more than a database: postgres://<host>:<port>/<database>` };
    // the name's own problem quotes it: the rule here is one, the value is never quoted
    if (databaseNameProblem(decoded) !== null) return { problem: `${at} to a URL whose database is not a name a tool can connect with` };
    database = decoded;
  }
  const params = new URLSearchParams(query.slice(1));
  const others = [...new Set([...params.keys()].filter((k) => k !== "sslmode"))];
  if (others.length > 0) return { problem: `${at} to a URL with ${others.length === 1 ? "a parameter" : `${others.length} parameters`} other than sslmode: the address takes sslmode alone; leave the rest out (a user and its password are mason user add's)` };
  const modes = params.getAll("sslmode");
  if (modes.length === 0) return { problem: `${at} to a URL with no sslmode: add ?sslmode= ${PUBLIC_SSLMODES.join(", ")} — whether a client uses TLS to reach that address` };
  if (modes.length > 1) return { problem: `${at} to a URL with sslmode twice: name it once` };
  const mode = modes[0]!;
  if (!(PUBLIC_SSLMODES as readonly string[]).includes(mode)) {
    return { problem: `${at} to a URL whose sslmode is not one of ${PUBLIC_SSLMODES.join(", ")}${mode === "allow" || mode === "prefer" ? " (a client that falls back to plain would send a password in clear)" : ""}` };
  }
  return { host: ipv6 ? hostText.slice(1, -1).toLowerCase() : hostText.toLowerCase(), port, database, sslmode: mode as PublicSslmode };
}

/** The address as the environment says it: null when unset (or set empty), the parts, or what is wrong. */
export function pgPublicUrlSetting(env: Readonly<Record<string, string | undefined>>): PublicPostgres | null | { problem: string } {
  const v = env[PG_PUBLIC_URL_SETTING] ?? "";
  return v === "" ? null : readPublicUrl(v);
}

/** The address in the one form the run records (`running.postgresPublicUrl`), read back by `readPublicUrl`. */
export function publicUrlText(p: PublicPostgres): string {
  return `postgresql://${p.host.includes(":") ? `[${p.host}]` : p.host}:${p.port}/${p.database === null ? "" : encodeURIComponent(p.database)}?sslmode=${p.sslmode}`;
}
