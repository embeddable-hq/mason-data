/**
 * WHETHER A PORT IS FREE, DECIDED IN ONE PLACE (#499 finding 5): `mason start` picks its ports here and
 * `mason doctor` reports them from here, so the two cannot disagree.
 *
 * A port is free only when no address a client may use is held. A probe of 127.0.0.1 alone binds beside a process on
 * the wildcard (macOS allows it; OrbStack publishes a container's port on *:5433), and `::` (v6only) binds beside one on
 * ::1 alone (macOS again: Node binds `localhost` there) — so 127.0.0.1:5433 reached Mason while a container, or a driver
 * trying ::1 first, reached another server. An address family the machine lacks (no IPv6) holds nothing.
 *
 * A probe binds and lets go: it says who holds a port NOW, never that it stays free until the service listens on it.
 */
import * as net from "node:net";
import type { Problem } from "./command.ts";
import { DEFAULT_PG_PORT, pgListenerAddress } from "../api/postgres/listener.ts";

/** The port the commands and the web page reach a run on, unless a flag or a setting says another. */
export const DEFAULT_UI_PORT = 4039;

export const PROBE_ADDRESSES = ["127.0.0.1", "0.0.0.0", "::", "::1"] as const;

/** Who holds a port: the address a bind was refused on, and the error (EADDRINUSE, or EACCES for a port needing root). */
export interface PortHolder { address: string; code: string }

/** The address that holds `port`, or null when every address binds. */
export async function portHolder(port: number): Promise<PortHolder | null> {
  for (const address of PROBE_ADDRESSES) {
    const code = await new Promise<string | null>((resolve) => {
      const srv = net.createServer();
      srv.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "ERROR"));
      srv.listen({ port, host: address, ipv6Only: address === "::" }, () => srv.close(() => resolve(null)));
    });
    if (code === null || code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") continue;
    return { address, code };
  }
  return null;
}

/** Why a held port cannot be listened on, in a developer's words. */
export function heldText(port: number, held: PortHolder): string {
  return held.code === "EACCES"
    ? `port ${port} needs root here (a bind on ${held.address} answered EACCES): a port below 1024 is the system's`
    : `something holds port ${port} on ${held.address} (${held.code})`;
}

/**
 * A port free on every address, preferring `want`; `avoid` are ports already chosen for another listener of the same
 * start (probed and let go, so a probe would call them free). `skipped` says who held `want` when another was chosen.
 */
export async function pickPort(want: number, avoid: ReadonlySet<number> = new Set()): Promise<{ port: number; skipped?: PortHolder }> {
  const held = avoid.has(want) ? { address: "this mason start", code: "chosen for another listener" } : await portHolder(want);
  if (!held) return { port: want };
  for (let attempt = 0; attempt < 20; attempt++) {
    // the OS picks on the wildcard, so the port it returns is free there; the probe then checks the other addresses
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "0.0.0.0", () => { const a = srv.address() as net.AddressInfo; srv.close(() => resolve(a.port)); });
    });
    if (!avoid.has(port) && !(await portHolder(port))) return { port, skipped: held };
  }
  throw new Error(`no free TCP port found on this machine after 20 tries (${heldText(want, held)}). Free some ports, then run mason start again`);
}

/** A free port, preferring `want` (`pickPort`). */
export async function freePort(want: number, avoid?: ReadonlySet<number>): Promise<number> {
  return (await pickPort(want, avoid)).port;
}

const PG_PORT_WAY_OUT = "set another MASON_PG_PORT (1024-65535), or unset it and mason start picks a free port";

/** `MASON_PG_PORT` as the shell gives it, before any probe: a port to listen on, or why it is not one. */
export function namedPgPort(named: string): { port: number } | Problem {
  const parsed = pgListenerAddress({ MASON_PG_PORT: named }, "127.0.0.1");
  if ("problem" in parsed) return { problem: parsed.problem, code: "refused", fix: PG_PORT_WAY_OUT };
  if (parsed.port === 0) return { problem: "MASON_PG_PORT=0 is not a port the Postgres API can be reached on", code: "refused",
    why: "0 asks the system for any free port, and mason start would record port 0", fix: PG_PORT_WAY_OUT };
  return { port: parsed.port };
}

/** The refusal for a named `MASON_PG_PORT` that is held: what, why (who holds it), the way out. */
export function heldPgPort(port: number, held: PortHolder): Problem {
  return held.code === "EACCES"
    ? { problem: `MASON_PG_PORT=${port} needs root`, code: "refused", why: heldText(port, held), fix: PG_PORT_WAY_OUT }
    : { problem: `MASON_PG_PORT=${port} is in use`, code: "refused", why: `${heldText(port, held)}, so the Postgres API cannot listen there`,
      fix: `stop what holds it (lsof -nP -iTCP:${port} -sTCP:LISTEN names it), or ${PG_PORT_WAY_OUT}` };
}

/** The refusal for the PROJECT'S recorded port that is held: it is never swapped, because every tool's saved connection names it. */
export function heldProjectPort(port: number, held: PortHolder): Problem {
  const moved = `MASON_PG_PORT=<n> mason start moves this project to another port (every tool's saved connection must change with it)`;
  return held.code === "EACCES"
    ? { problem: `this project's Postgres API port ${port} needs root`, code: "refused", why: heldText(port, held), fix: moved }
    : { problem: `this project's Postgres API port ${port} is in use`, code: "refused",
      why: `${heldText(port, held)}, so the Postgres API cannot listen there; the port is the project's since its first start, so a tool's saved connection keeps working`,
      fix: `stop what holds it (lsof -nP -iTCP:${port} -sTCP:LISTEN names it), or ${moved}` };
}

/**
 * THE POSTGRES API'S PORT, THE PROJECT'S OWN (it must not change at every restart, even on a laptop, or every BI
 * tool's saved credentials need updating each time). `recorded` is
 * the port the project's first start chose (`ProjectConfig.pgPort`): every later start uses it, or is REFUSED by name
 * when it is held (`heldProjectPort`), never moved to another port by itself. `MASON_PG_PORT` set in the shell is the
 * developer naming it, or moving the project to it: used if free on every address, else REFUSED by name, and said as a
 * move when it differs from the recorded one. With neither, 5433 is preferred and the next free port taken, and `said`
 * names the address that held 5433 (often a second Postgres: an application's own stack); the caller records the choice.
 * `avoid`: ports this start has already chosen. Free at the probe, not reserved (above): a later holder is the
 * service's EADDRINUSE to say.
 */
export async function choosePgPort(named: string | undefined, avoid: ReadonlySet<number> = new Set(), recorded: number | null = null): Promise<{ port: number; said?: string } | Problem> {
  if (named !== undefined && named !== "") {
    const n = namedPgPort(named);
    if ("problem" in n) return n;
    const held = avoid.has(n.port) ? { address: "this mason start", code: "chosen for another listener" } : await portHolder(n.port);
    if (held) return heldPgPort(n.port, held);
    const moved = recorded !== null && recorded !== n.port ? `, moved from ${recorded}: every tool's saved connection must change to it` : "";
    return { port: n.port, said: `Postgres API: port ${n.port} (from MASON_PG_PORT)${moved}` };
  }
  if (recorded !== null) {
    const held = avoid.has(recorded) ? { address: "this mason start", code: "chosen for another listener" } : await portHolder(recorded);
    if (held) return heldProjectPort(recorded, held);
    return { port: recorded };
  }
  const { port, skipped } = await pickPort(DEFAULT_PG_PORT, avoid);
  return skipped
    ? { port, said: `Postgres API: ${heldText(DEFAULT_PG_PORT, skipped)}, often another Postgres, so using ${port}, this project's port from now on (MASON_PG_PORT=<n> mason start moves it)` }
    : { port };
}
