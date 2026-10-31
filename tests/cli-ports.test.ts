/**
 * The ports `mason start` picks and `mason doctor` reports (src/cli/ports.ts): a port is free only when it is free on
 * every address a client may use (#499 finding 5), and `MASON_PG_PORT` is the developer naming the Postgres API's port,
 * so a held one is refused in the Failure shape, never swapped for another.
 *
 * WHERE EACH CASE CAN FAIL: Linux already refuses 127.0.0.1 beside a 0.0.0.0 or dual-stack listener, so the wildcard
 * case fails without the fix only on macOS; the v6only `::` case fails without the `::` probe on Linux too (CI), and the
 * `::1` case fails without the `::1` probe only on macOS (on Linux the `::` probe already sees ::1). The IPv6 cases are
 * skipped on a machine with no IPv6, and say so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { choosePgPort, freePort, heldPgPort, pickPort, portHolder } from "../src/cli/ports.ts";
import * as ports from "../src/cli/ports.ts";
import { readProject } from "../src/cli/project.ts";
import { DEFAULT_PG_PORT } from "../src/api/postgres/listener.ts";
import type { PortHolder } from "../src/cli/ports.ts";
import type { Problem } from "../src/cli/command.ts";

// read from the module, not imported by name: the file loads at a commit without it (scripts/fails-without.ts)
const { heldProjectPort } = ports as unknown as { heldProjectPort: (port: number, held: PortHolder) => Problem };

type Held = { port: number; close: () => Promise<void> };
function hold(host: string, ipv6Only = false): Promise<Held | null> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (e: NodeJS.ErrnoException) => e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT" ? resolve(null) : reject(e));
    srv.listen({ port: 0, host, ipv6Only }, () => resolve({ port: (srv.address() as net.AddressInfo).port, close: () => new Promise((r) => srv.close(() => r())) }));
  });
}

/**
 * A port only this test holds, by what `portHolder` answers for it (issue 80): the file runs beside others that bind
 * ephemeral ports, and IPv4 and v6only sockets share a number without clashing, so a port the OS gave `host` can be
 * someone else's on 127.0.0.1, which the probe asks first. An answer on an IPv4 address says exactly that, and is asked
 * again of another port; a probe that does not see the holder answers null, which is returned for the test to fail on.
 */
async function heldAlone(host: string, ipv6Only: boolean): Promise<{ held: PortHolder | null } | null> {
  for (let tries = 0; ; tries++) {
    const h = await hold(host, ipv6Only);
    if (!h) return null;
    try {
      const held = await portHolder(h.port);
      if (held === null || held.address.includes(":") || tries >= 20) return { held };
    } finally { await h.close(); }
  }
}

test("a port held on the wildcard is taken, though 127.0.0.1 would bind beside it (macOS)", async () => {
  const h = (await hold("0.0.0.0"))!;
  try {
    assert.ok(await portHolder(h.port), "the wildcard listener is seen");
    const picked = await pickPort(h.port);
    assert.notEqual(picked.port, h.port);
    assert.ok(picked.skipped);
    assert.notEqual(await freePort(h.port), h.port);
  } finally { await h.close(); }
});

test("a port held on :: alone (v6only) is taken: 127.0.0.1 and 0.0.0.0 both bind beside it, on Linux too", async (t) => {
  const h = await heldAlone("::", true);
  if (!h) { t.skip("no IPv6 on this machine"); return; }
  assert.deepEqual(h.held, { address: "::", code: "EADDRINUSE" });
});

test("a port held on ::1 alone is taken (Node's `localhost` on macOS; a driver tries ::1 first)", async (t) => {
  const h = await heldAlone("::1", false);
  if (!h) { t.skip("no IPv6 loopback on this machine"); return; }
  assert.ok(h.held, "the ::1 listener is seen");
  assert.match(h.held.address, /^::1?$/);
});

test("a free port is kept; one this start already chose is not taken twice", async () => {
  const h = (await hold("0.0.0.0"))!;
  const port = h.port;
  await h.close();
  assert.equal(await portHolder(port), null);
  assert.deepEqual(await pickPort(port), { port });
  assert.notEqual((await pickPort(port, new Set([port]))).port, port);
  // a NAMED port the start chose for another listener is refused
  const clash = await choosePgPort(String(port), new Set([port]));
  assert.ok("problem" in clash);
  assert.equal(clash.problem, `MASON_PG_PORT=${port} is in use`);
});

test("MASON_PG_PORT names the port: used when free, refused in the Failure shape when held", async () => {
  const h = (await hold("0.0.0.0"))!;
  const taken = h.port;
  try {
    const refused = await choosePgPort(String(taken));
    assert.ok("problem" in refused);
    assert.equal(refused.problem, `MASON_PG_PORT=${taken} is in use`);
    assert.equal(refused.code, "refused");
    assert.match(refused.why!, new RegExp(`^something holds port ${taken} on (127\\.0\\.0\\.1|0\\.0\\.0\\.0) \\(EADDRINUSE\\), so the Postgres API cannot listen there$`));
    assert.equal(refused.fix, `stop what holds it (lsof -nP -iTCP:${taken} -sTCP:LISTEN names it), or set another MASON_PG_PORT (1024-65535), or unset it and mason start picks a free port`);
  } finally { await h.close(); }
  assert.deepEqual(await choosePgPort(String(taken)), { port: taken, said: `Postgres API: port ${taken} (from MASON_PG_PORT)` });
  const bad = await choosePgPort("x");
  assert.ok("problem" in bad);
  assert.match(bad.problem, /MASON_PG_PORT=x is not a port/);
  assert.equal(bad.code, "refused");
});

test("MASON_PG_PORT=0 is refused (the system would pick, and the URL would say :0); EACCES is said as needing root, not in use", async () => {
  const zero = await choosePgPort("0");
  assert.ok("problem" in zero);
  assert.equal(zero.problem, "MASON_PG_PORT=0 is not a port the Postgres API can be reached on");
  assert.deepEqual(heldPgPort(80, { address: "127.0.0.1", code: "EACCES" }), {
    problem: "MASON_PG_PORT=80 needs root", code: "refused",
    why: "port 80 needs root here (a bind on 127.0.0.1 answered EACCES): a port below 1024 is the system's",
    fix: "set another MASON_PG_PORT (1024-65535), or unset it and mason start picks a free port",
  });
});

test("the recorded port is the project's: used when free, refused by name when held, moved only by MASON_PG_PORT", async () => {
  // the port does not change at a restart, on a laptop too: otherwise the credentials in a BI tool would need updating
  // after every restart
  const h = (await hold("0.0.0.0"))!;
  const recorded = h.port;
  try {
    const refused = await choosePgPort(undefined, new Set(), recorded);
    assert.ok("problem" in refused, "a held recorded port is refused, never swapped for a free one");
    assert.equal(refused.problem, `this project's Postgres API port ${recorded} is in use`);
    assert.equal(refused.code, "refused");
    assert.match(refused.why!, new RegExp(`^something holds port ${recorded} on (127\\.0\\.0\\.1|0\\.0\\.0\\.0) \\(EADDRINUSE\\), so the Postgres API cannot listen there; the port is the project's since its first start, so a tool's saved connection keeps working$`));
    assert.equal(refused.fix, `stop what holds it (lsof -nP -iTCP:${recorded} -sTCP:LISTEN names it), or MASON_PG_PORT=<n> mason start moves this project to another port (every tool's saved connection must change with it)`);
  } finally { await h.close(); }
  assert.deepEqual(await choosePgPort(undefined, new Set(), recorded), { port: recorded }, "free again: the same port, nothing to say");
  // a port this start chose for another listener counts as held too
  const clash = await choosePgPort(undefined, new Set([recorded]), recorded);
  assert.ok("problem" in clash);
  assert.equal(clash.problem, `this project's Postgres API port ${recorded} is in use`);
  // MASON_PG_PORT moves the project, and says so; the same port named is no move
  const other = (await hold("0.0.0.0"))!;
  await other.close();
  assert.deepEqual(await choosePgPort(String(other.port), new Set(), recorded),
    { port: other.port, said: `Postgres API: port ${other.port} (from MASON_PG_PORT), moved from ${recorded}: every tool's saved connection must change to it` });
  assert.deepEqual(await choosePgPort(String(recorded), new Set(), recorded), { port: recorded, said: `Postgres API: port ${recorded} (from MASON_PG_PORT)` });
  assert.deepEqual(heldProjectPort(80, { address: "127.0.0.1", code: "EACCES" }), {
    problem: "this project's Postgres API port 80 needs root", code: "refused",
    why: "port 80 needs root here (a bind on 127.0.0.1 answered EACCES): a port below 1024 is the system's",
    fix: "MASON_PG_PORT=<n> mason start moves this project to another port (every tool's saved connection must change with it)",
  });
});

test("a config whose pgPort is no port is a broken project, said with the way out; null or absent is a project before its first start", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-pgport-"));
  try {
    const write = (pgPort: unknown): void => {
      fs.mkdirSync(path.join(dir, ".mason"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".mason", "config.json"), JSON.stringify({ name: "x", source: "postgres://x", folder: "mason", remote: false, apiKey: "k", running: null, ...(pgPort === undefined ? {} : { pgPort }) }));
    };
    for (const ok of [undefined, null, 5433, 65_535]) { write(ok); const p = readProject(dir); assert.ok(p !== null && !("broken" in p), `pgPort ${String(ok)} reads`); }
    for (const bad of ["5433", 0, 70_000, 1.5]) {
      write(bad);
      const p = readProject(dir);
      assert.ok(p !== null && "broken" in p, `pgPort ${JSON.stringify(bad)} is broken`);
      assert.equal(p.broken, `its "pgPort" ${JSON.stringify(bad)} is not a port number (1-65535, the Postgres API's port mason start recorded; remove it and the next start chooses one)`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unset, 5433 is preferred, and a skipped 5433 says who held it", async () => {
  const held = await portHolder(DEFAULT_PG_PORT);
  const r = await choosePgPort(undefined);
  assert.ok(!("problem" in r));
  if (held === null) assert.deepEqual(r, { port: DEFAULT_PG_PORT });
  else {
    assert.notEqual(r.port, DEFAULT_PG_PORT);
    assert.match(r.said!, new RegExp(`^Postgres API: something holds port 5433 on ${held.address.replace(/\./g, "\\.")} \\(${held.code}\\), often another Postgres, so using ${r.port}, this project's port from now on \\(MASON_PG_PORT=<n> mason start moves it\\)$`));
  }
});
