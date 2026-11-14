/**
 * tests/test-ports.ts, the port a test uses later: outside the ranges the kernel assigns, so no `listen(0)` and no
 * connection anywhere on the machine can take it between the pick and its use (the race tests/cli-demo-start.test.ts
 * lost in CI: `listen EADDRINUSE … 127.0.0.1:43725`), claimed so no other test picks it, and free when picked. A claim
 * under test is in a lock folder of this test's own; the fixture ports around it are claimed in the shared one, so no
 * other test file picks them meanwhile.
 */
import { after, test } from "node:test";
import * as assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LOWEST, allowedSpans, ephemeralRanges, inRanges, randomCandidate, unassignedPort } from "./test-ports.ts";
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
const said = (ranges: { first: number; last: number }[]): string => ranges.map((r) => `${r.first}-${r.last}`).join(", ");

test("the ranges read are the kernel's: every port listen(0) is handed lies in one", async () => {
  const ranges = ephemeralRanges();
  for (const r of ranges) assert.ok(r.first >= 1 && r.last <= 65_535 && r.first <= r.last, said(ranges));
  const servers: net.Server[] = [];
  try {
    for (let i = 0; i < 50; i++) servers.push(await listen(0));
    for (const s of servers) {
      const port = (s.address() as net.AddressInfo).port;
      assert.ok(inRanges(port, ranges), `listen(0) was handed ${port}, outside the ranges read (${said(ranges)})`);
    }
  } finally { await Promise.all(servers.map(close)); }
});

test("two ephemeral ranges are two, never their hull: an old BSD default (1024-5000, 49152-65535) leaves 10000-49151", () => {
  const bsd = [{ first: 1024, last: 5000 }, { first: 49152, last: 65535 }];
  assert.deepEqual(allowedSpans(bsd), [{ first: 10_000, last: 49_151 }]);
  for (let i = 0; i < 1000; i++) {
    const p = randomCandidate(allowedSpans(bsd));
    assert.ok(p >= 10_000 && p <= 49_151, String(p));
  }
  // Linux's default: below and above it
  assert.deepEqual(allowedSpans([{ first: 32768, last: 60999 }]), [{ first: 10_000, last: 32_767 }, { first: 61_000, last: 65_535 }]);
  // macOS's default, the two ranges the same
  assert.deepEqual(allowedSpans([{ first: 49152, last: 65535 }, { first: 49152, last: 65535 }]), [{ first: 10_000, last: 49_151 }]);
  assert.deepEqual(allowedSpans([{ first: 1024, last: 65535 }]), []);
  assert.throws(() => randomCandidate([]), /the ephemeral ranges cover every port from 10000 to 65535/);
});

test("a candidate in any ephemeral range is a bug in the candidates, refused, never used (the second of two ranges too)", async () => {
  const first = ephemeralRanges()[0]!.first;
  await assert.rejects(unassignedPort({ locks: lockDir(), candidates: () => first }), new RegExp(`candidate ${first} is in the ephemeral ranges`));
  const bsd = [{ first: 1024, last: 5000 }, { first: 49152, last: 65535 }];
  await assert.rejects(unassignedPort({ locks: lockDir(), ranges: bsd, candidates: () => 50_000 }), /candidate 50000 is in the ephemeral ranges 1024-5000, 49152-65535/);
});

test("the port picked is outside the kernel's ranges, free on every address, and claimed by this process", async () => {
  const locks = lockDir();
  const ranges = ephemeralRanges();
  for (let i = 0; i < 20; i++) {
    const port = await unassignedPort({ locks });
    assert.ok(port >= LOWEST && port <= 65_535 && !inRanges(port, ranges), `${port} is out of ${said(ranges)} and at least ${LOWEST}`);
    assert.equal(await portHolder(port), null, `${port} is free`);
    assert.equal(fs.readFileSync(path.join(locks, String(port)), "utf8"), `${process.pid}\n`);
  }
});

test("THE RACE, its contender there first: a port something holds by the time it is picked is skipped for another", async () => {
  const locks = lockDir();
  // fixtures claimed in the shared folder; the claim under test in this test's own
  const [taken, free] = [await unassignedPort(), await unassignedPort()];
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
  const [a, b, c] = [await unassignedPort(), await unassignedPort(), await unassignedPort()];
  fs.writeFileSync(path.join(locks, String(a)), "1\n");
  assert.equal(await unassignedPort({ locks, candidates: these([a], () => b) }), b);
  assert.equal(await unassignedPort({ locks, candidates: these([b, a], () => c) }), c, "b is this process's, a another's");
});

test("every candidate claimed: the pick fails, saying why and where the claims are, never a port in use", async () => {
  const locks = lockDir();
  const a = await unassignedPort();
  fs.writeFileSync(path.join(locks, String(a)), "1\n");
  await assert.rejects(unassignedPort({ locks, candidates: () => a }),
    new RegExp(`^Error: tests/test-ports\\.ts: no free port outside the ephemeral range after 200 tries \\(${a} claimed; .*\\); stale claims are in ${locks.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

/** A child that claims two ports in `locks`, prints them, then `then` (an expression run after the print). */
const claimer = (locks: string, then: string): string =>
  `import { unassignedPort } from ${JSON.stringify(path.join(HERE, "test-ports.ts"))};\n` +
  `const p = await unassignedPort({ locks: ${JSON.stringify(locks)} }); const q = await unassignedPort({ locks: ${JSON.stringify(locks)} });\n` +
  `process.stdout.write(JSON.stringify([p, q]) + "\\n");\n${then}`;

test("a process's claims are let go when it exits", () => {
  const locks = lockDir();
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", claimer(locks, "")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.error, undefined, `the child did not finish in 30 s: ${r.stderr}`);
  assert.equal(r.status, 0, r.stderr);
  const ports = JSON.parse(r.stdout) as number[];
  assert.equal(ports.length, 2);
  assert.notEqual(ports[0], ports[1]);
  assert.deepEqual(fs.readdirSync(locks), [], `the claims on ${ports.join(", ")} are gone`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`a process's claims are let go when ${signal} ends it, and it still dies of ${signal}`, async () => {
    const locks = lockDir();
    // the child stays up after its claims until the signal
    const child = spawn(process.execPath, ["--input-type=module", "-e", claimer(locks, "setInterval(() => undefined, 1000);")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stderr.on("data", (d) => { err += String(d); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, sig) => r({ code, signal: sig })));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (d) => { out += String(d); if (out.includes("\n")) resolve(); });
        void exited.then((e) => reject(new Error(`the child exited before claiming (${JSON.stringify(e)}): ${err}`)));
      });
      const ports = JSON.parse(out) as number[];
      assert.deepEqual(fs.readdirSync(locks).sort(), ports.map(String).sort(), "claimed while it runs");
      child.kill(signal);
      const e = await exited;
      assert.deepEqual(e, { code: null, signal }, `it died of ${signal}: ${err}`);
      assert.deepEqual(fs.readdirSync(locks), [], `the claims on ${ports.join(", ")} are gone`);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  });
}
