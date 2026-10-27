/**
 * THE RUN'S POSTGRES LISTENER, REACHABLE FROM ANOTHER MACHINE (docs/POSTGRES-API.md "Connecting"). On
 * a test server a hosted BI tool had to reach the run, which listened on 127.0.0.1 with no TLS, and a TLS proxy was
 * written beside Mason for it. Now `mason start` reads where and how its listener listens with the one reader the
 * ClickHouse stack's Query API used too (`pgListenerSettings`, src/api/postgres/listener.ts): `MASON_PG_HOST` (default
 * 127.0.0.1), the port `mason start` chose (`MASON_PG_PORT`'s, or a free one), `MASON_PG_TLS_CERT` / `MASON_PG_TLS_KEY`, and the plain-listener rule
 * (src/api/postgres/plain.ts): off loopback it needs TLS, or `MASON_PG_PLAIN=1` for a team that terminates TLS in a
 * proxy of its own.
 *
 * `--self-signed-tls` (named for what the developer gets, in the variables' own word, TLS) is a certificate made for
 * the project in its `.mason/` (0600), recorded in its config and reused by every later start with the flag; it is
 * handed to the same reader through the same two variables, never a second path. With TLS the listener requires it of
 * every client (src/api/postgres/server.ts: a plain startup is refused, 28000).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isLoopback } from "../api/postgres/plain.ts";
import { pgListenerSettings, type PgListenerSettings } from "../api/postgres/listener.ts";
import { selfSignedCertificate } from "./self-signed-cert.ts";
import type { Problem } from "./command.ts";
import type { PostgresListener } from "./project.ts";

/** the self-signed certificate's files, in the project's `.mason/` */
export const SELF_SIGNED_FILES = { cert: "postgres-tls.crt", key: "postgres-tls.key" } as const;

/**
 * Where and how the run's listener listens: the shell's `MASON_PG_*` with the port `mason start` chose and, under
 * `--self-signed-tls`, the project's own files as the certificate — or why not, as a Problem (what, why, the way out).
 * Reads no file: `mason start` asks it before it spawns the run, and the run before it connects to the database.
 */
export function runListenerSettings(shell: Readonly<Record<string, string | undefined>>, o: { port: number; selfSigned: boolean; home: string }): PgListenerSettings | Problem {
  if (o.selfSigned && (shell.MASON_PG_TLS_CERT || shell.MASON_PG_TLS_KEY)) {
    return { problem: "--self-signed-tls makes a certificate, and MASON_PG_TLS_CERT / MASON_PG_TLS_KEY name one: one or the other", code: "usage",
      fix: "drop --self-signed-tls to serve your certificate, or unset MASON_PG_TLS_CERT and MASON_PG_TLS_KEY to serve a self-signed one" };
  }
  const s = pgListenerSettings({
    MASON_PG_HOST: shell.MASON_PG_HOST, MASON_PG_PORT: String(o.port), MASON_PG_PLAIN: shell.MASON_PG_PLAIN,
    MASON_PG_TLS_CERT: o.selfSigned ? path.join(o.home, SELF_SIGNED_FILES.cert) : shell.MASON_PG_TLS_CERT,
    MASON_PG_TLS_KEY: o.selfSigned ? path.join(o.home, SELF_SIGNED_FILES.key) : shell.MASON_PG_TLS_KEY,
  }, "127.0.0.1");
  if (!("problem" in s)) return s;
  return { problem: s.problem, code: "refused", ...(s.why ? { why: s.why } : {}),
    // the run makes a certificate where the service cannot: said beside the variables
    ...(s.fix ? { fix: s.kind === "plain" ? `${s.fix}. Or mason start --self-signed-tls: a certificate made for this project in .mason/` : s.fix } : {}),
    ...(s.kind === "plain" ? { next: [["mason start --self-signed-tls", "TLS from a certificate made in .mason/ (clients connect with sslmode=require)"]] } : {}) };
}

/**
 * The project's self-signed certificate: the one in `.mason/` when it is still good (it parses, its key is its own, it
 * has not expired), else a new one, both files 0600. `said` is why a new one was made, for the run to print.
 */
export function ensureSelfSigned(home: string, project: string, now = new Date()): { fingerprint: string; said: string | null } {
  const certFile = path.join(home, SELF_SIGNED_FILES.cert), keyFile = path.join(home, SELF_SIGNED_FILES.key);
  const kept = keptCertificate(certFile, keyFile, now);
  if ("fingerprint" in kept) return { fingerprint: kept.fingerprint, said: null };
  const made = selfSignedCertificate(`mason-${project}`, { now });
  for (const [file, text] of [[keyFile, made.key], [certFile, made.cert]] as const) {
    fs.writeFileSync(file, text, { mode: 0o600 });
    fs.chmodSync(file, 0o600);   // a file that was there keeps its mode through writeFileSync
  }
  return { fingerprint: new crypto.X509Certificate(made.cert).fingerprint256, said: kept.why };
}

function keptCertificate(certFile: string, keyFile: string, now: Date): { fingerprint: string } | { why: string } {
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) return { why: `made a self-signed certificate: .mason/${SELF_SIGNED_FILES.cert}` };
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(certFile));
    if (!x.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(keyFile)))) return { why: `made a new self-signed certificate: .mason/${SELF_SIGNED_FILES.key} was not the key of .mason/${SELF_SIGNED_FILES.cert}` };
    if (new Date(x.validTo).getTime() <= now.getTime()) return { why: `made a new self-signed certificate: the one in .mason/ expired ${x.validTo}` };
    return { fingerprint: x.fingerprint256 };
  } catch (e) {
    return { why: `made a new self-signed certificate: the one in .mason/ could not be read (${(e as Error).message})` };
  }
}

/** The certificate's SHA-256 fingerprint, for a client that checks it by hand; or why it is no certificate. */
export function certificateFingerprint(pem: Buffer): string | { problem: string } {
  try { return new crypto.X509Certificate(pem).fingerprint256; }
  catch (e) { return { problem: `MASON_PG_TLS_CERT is not a PEM certificate: ${(e as Error).message}` }; }
}

/** What the listener serves, one line: its address, then TLS (whose certificate) or plain (and on what network). */
export function listenerText(l: PostgresListener, port: number): string {
  const every = l.host === "0.0.0.0" || l.host === "::";
  const address = `${l.host.includes(":") ? `[${l.host}]` : l.host}:${port}${every ? " (every address of this machine)" : ""}`;
  if (l.tls !== null) {
    return `${address}, TLS required: ${l.tls === "self-signed" ? `a self-signed certificate (.mason/${SELF_SIGNED_FILES.cert})` : "the certificate MASON_PG_TLS_CERT names"}` +
      `${l.fingerprint ? `, SHA-256 ${l.fingerprint}` : ""}`;
  }
  return `${address}, ${isLoopback(l.host) ? "plain: this machine only" : "PLAIN under MASON_PG_PLAIN=1: a password travels in clear on that network"}`;
}

/** Where a tool on another machine reaches it, when the recorded URL's host is not that: every address is localhost here. */
export function elsewhereTip(l: PostgresListener): string | null {
  return l.host === "0.0.0.0" || l.host === "::"
    ? "It listens on every address of this machine: from another machine, put this machine's address or name in place of localhost."
    : null;
}
