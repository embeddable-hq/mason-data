/**
 * A PLAIN LISTENER OFF LOOPBACK IS A DECISION, NOT A DEFAULT: the token travels as the password in
 * clear, so anyone on the network path reads it and queries as that token until it expires. On loopback nothing
 * travels; elsewhere the operator says which it is — TLS (`MASON_PG_TLS_CERT` / `MASON_PG_TLS_KEY`), or
 * `MASON_PG_PLAIN=1` for a port published on a private network (a compose or Kubernetes network, a loopback publish
 * on the host). Read by the API's listener and by the service's config check alike, so the refusal is said at the
 * start, never as a child crash-looping. docs/POSTGRES-API.md "Connecting".
 */

/** a host on which a plain listener crosses no network */
export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Why a listener cannot start as configured, in parts — what is wrong, why, the way out — so each reader says it in its
 *  own shape: the service as one line (`problemText`), `mason start` as a Failure (src/cli/pg-tls.ts). `kind` lets a
 *  reader add a way out of its own: a plain listener off loopback is one `mason start --self-signed-tls` answers too. */
export interface ListenerProblem { problem: string; why?: string; fix?: string; kind: "port" | "plain" | "plain_value" | "tls_pair" | "tls_read" }

/** A problem as one line: what, why, the way out — the service's refusal and log. */
export function problemText(p: ListenerProblem): string {
  return `${p.problem}${p.why ? `: ${p.why}` : ""}${p.fix ? `. ${p.fix}` : ""}`;
}

/** The problem with listening plain on `host`, or null: TLS set, a loopback host, or `MASON_PG_PLAIN=1` is fine. */
export function plainListener(host: string, plain: string | undefined, tls: boolean): ListenerProblem | null {
  if (tls || isLoopback(host)) return null;
  if (plain === "1" || plain === "true") return null;
  if (plain !== undefined && plain !== "" && plain !== "0" && plain !== "false") return { problem: `MASON_PG_PLAIN=${plain} is not a setting: 1 (a plain listener on a private network) or unset`, kind: "plain_value" };
  return { problem: `the Postgres API would listen PLAIN on ${host}, off loopback`, why: "a token travels as the password in clear on that network", kind: "plain",
    fix: "Set MASON_PG_TLS_CERT and MASON_PG_TLS_KEY (PEM files) to require TLS, or MASON_PG_PLAIN=1 to say the port is published on a private network " +
      "(a compose or Kubernetes network, a 127.0.0.1 publish on the host) — docs/POSTGRES-API.md \"Connecting\"" };
}

/** `plainListener` as one line, as a check at the start prints it. */
export function plainListenerProblem(host: string, plain: string | undefined, tls: boolean): string | null {
  const p = plainListener(host, plain, tls);
  return p === null ? null : problemText(p);
}
