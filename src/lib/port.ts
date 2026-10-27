/**
 * A port setting (MASON_API_PORT, MASON_HEALTH_PORT, MASON_WEB_UI_PORT, PG_PORT) is a whole number from 0 to 65535,
 * or the process refuses to start naming the variable and its value — never `parseInt`'s NaN reaching `listen()`.
 * PG_PORT matters most: set, it wins over DATABASE_URL's port (src/lib/database-url.ts), and a Service named `pg`
 * would set it.
 *
 * Kubernetes injects `<SERVICE>_PORT=tcp://<ip>:<port>` into every pod for each Service in its namespace, so a
 * Service named `mason-api` sets MASON_API_PORT (0.1.4 on EKS crash-looped on it). That value is
 * named for what it is, with the fix: `enableServiceLinks: false` on the pod (deploy/k8s/).
 */

/** The port `raw` names, or the problem with it; `undefined` or empty is the default. */
export function parsePort(name: string, raw: string | undefined, fallback: number): { port: number; problem?: never } | { problem: string } {
  if (raw === undefined || raw === "") return { port: fallback };
  if (/^\d{1,5}$/.test(raw) && Number(raw) <= 65535) return { port: Number(raw) };
  const serviceLink = /^tcp:\/\//.test(raw)
    ? " — that is a Kubernetes service link (a Service in the namespace is named after the variable): " +
      "set `enableServiceLinks: false` on the pod"
    : "";
  return { problem: `${name}=${raw} is not a port (a whole number from 0 to 65535)${serviceLink}` };
}
