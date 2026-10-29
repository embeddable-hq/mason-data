/**
 * tests/test-ports.ts, the port a test hands a listener it starts later: outside the range the kernel assigns, so no
 * `listen(0)` and no connection anywhere on the machine can take it between the pick and the bind (the race
 * tests/cli-demo-start.test.ts lost in CI: `listen EADDRINUSE … 127.0.0.1:43725`), claimed so no other test picks it,
 * and free when picked. Each claim here is in a lock folder of this test's own, never the shared one.
 */
import { after, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LOWEST, ephemeralRange, unassignedPort } from "./test-ports.ts";
import { portHolder } from "../src/cli/ports.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
const lockDir = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "mason-test-ports-test-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const listen = (port: number): Promise<net.Server> => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once("error", reject);
  s.listen(port, "127.0.0.1", () => resolve(s));
});
const close = (s: net.Server): Promise<void> => new Promise((r) => s.close(() => r()));
/** Candidates in order, then the fallback's for ever. */
const these = (ports: number[], then: () => number): (() => number) => () => ports.shift() ?? then();

test("the range read is the kernel's: every port listen(0) is handed lies in it", async () => {
  const { first, last } = ephemeralRange();
  assert.ok(first >= 1024 && last <= 65_535 && first <= last, `${first}-${last}`);
  const servers: net.Server[] = [];
  try {
    for (let i = 0; i < 50; i++) servers.push(await listen(0));
    for (const s of servers) {
      const port = (s.address() as net.AddressInfo).port;
      assert.ok(port >= first && port <= last, `listen(0) was handed ${port}, outside the range read (${first}-${last})`);
    }
  } finally { await Promise.all(servers.map(close)); }
});

test("the port picked is outside the kernel's range, free on every address, and claimed by this process", async () => {
  const locks = lockDir();
  const { first, last } = ephemeralRange();
  for (let i = 0; i < 20; i++) {
    const port = await unassignedPort({ locks });
    assert.ok(port >= LOWEST && port <= 65_535 && (port < first || port > last), `${port} is out of ${first}-${last} and at least ${LOWEST}`);
    assert.equal(await portHolder(port), null, `${port} is free`);
    assert.equal(fs.readFileSync(path.join(locks, String(port)), "utf8"), `${process.pid}\n`);
  }
});

test("THE RACE, its contender there first: a port something holds by the time it is picked is skipped for another", async () => {
  const locks = lockDir();
  const [taken, free] = [await unassignedPort({ locks: lockDir() }), await unassignedPort({ locks: lockDir() })];
  const holder = await listen(taken);
  try {
    const port = await unassignedPort({ locks, candidates: these([taken, taken], () => free) });
    assert.equal(port, free);
    assert.ok(!fs.existsSync(path.join(locks, String(taken))), "the held port's claim is let go");
    // and the port picked binds, as the start after the pick does
    await close(await listen(port));
  } finally { await close(holder); }
});

test("a port another process claimed is skipped though nothing listens on it; one process never picks a port twice", async () => {
  const locks = lockDir();
  const [a, b, c] = [await unassignedPort({ locks: lockDir() }), await unassignedPort({ locks: lockDir() }), await unassignedPort({ locks: lockDir() })];
  fs.writeFileSync(path.join(locks, String(a)), "1\n");
  assert.equal(await unassignedPort({ locks, candidates: these([a], () => b) }), b);
  assert.equal(await unassignedPort({ locks, candidates: these([b, a], () => c) }), c, "b is this process's, a another's");
});

test("every candidate claimed: the pick fails, saying why and where the claims are, never a port in use", async () => {
  const locks = lockDir();
  const a = await unassignedPort({ locks: lockDir() });
  fs.writeFileSync(path.join(locks, String(a)), "1\n");
  await assert.rejects(unassignedPort({ locks, candidates: () => a }),
    new RegExp(`^Error: tests/test-ports\\.ts: no free port outside the ephemeral range after 200 tries \\(${a} claimed; .*\\); stale claims are in ${locks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("a candidate in the kernel's range is a bug in the candidates, refused, never used", async () => {
  const { first } = ephemeralRange();
  await assert.rejects(unassignedPort({ locks: lockDir(), candidates: () => first }), new RegExp(`candidate ${first} is in the ephemeral range`));
});

test("a process's claims are let go when it exits", () => {
  const locks = lockDir();
  const script = `import { unassignedPort } from ${JSON.stringify(path.join(HERE, "test-ports.ts"))};\n` +
    `const p = await unassignedPort({ locks: ${JSON.stringify(locks)} }); const q = await unassignedPort({ locks: ${JSON.stringify(locks)} });\n` +
    `process.stdout.write(JSON.stringify([p, q]));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ports = JSON.parse(r.stdout) as number[];
  assert.equal(ports.length, 2);
  assert.notEqual(ports[0], ports[1]);
  assert.deepEqual(fs.readdirSync(locks), [], `the claims on ${ports.join(", ")} are gone`);
});
