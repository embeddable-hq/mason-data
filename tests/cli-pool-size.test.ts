/**
 * THE SIZE OF LIBUV'S POOL (src/cli/pool-size.cjs, issue 88), offline: what it sets, proved by a probe of a real pool,
 * and that every way Mason starts goes through it. tests/integration/duck-pool.itest.ts holds it in real runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = path.join(ROOT, "src", "cli", "pool-size.cjs");
const { sizePool } = createRequire(import.meta.url)(SIZE) as { sizePool(o: { env: Record<string, string>; platform: string; cpus: number; announce?: boolean; say?(line: string): void; refuse?(line: string): void; cgroupFiles?: string[]; processLimits?: string }): number | null };
const read = (...p: string[]): string => fs.readFileSync(path.join(ROOT, ...p), "utf8");

/** Counts a pool by parking its threads: opening a FIFO with no writer holds a thread with no CPU, and the count stops
 *  where a stat, which needs one thread, no longer comes back. Runs in a process of its own, CommonJS, so the pool
 *  starts here and nowhere earlier. */
const PROBE = `
require(${JSON.stringify(SIZE)});
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { execFileSync } = require("node:child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-size-"));
(async () => {
  const held = [];
  for (let n = 0; n <= 100; n++) {
    const free = await Promise.race([new Promise((r) => fs.stat(dir, () => r(true))), new Promise((r) => setTimeout(r, 1000, false))]);
    if (!free) { console.log(n); break; }
    const f = path.join(dir, "f" + n);
    execFileSync("mkfifo", [f]);
    held.push(f);
    fs.open(f, "r", () => {});
  }
  for (const f of held) fs.openSync(f, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})();
`;

function poolOf(size: string | undefined): number {
  const env = { ...process.env };
  delete env.UV_THREADPOOL_SIZE;
  if (size !== undefined) env.UV_THREADPOOL_SIZE = size;
  const r = spawnSync(process.execPath, ["-e", PROBE], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout.trim());
}

test("the pool is 32 threads unset or empty, and an operator's own UV_THREADPOOL_SIZE is left as it is", { timeout: 120_000 }, () => {
  assert.equal(poolOf(undefined), 32);
  assert.equal(poolOf(""), 32, "libuv would read an empty one as 1");
  assert.equal(poolOf("7"), 7);
});

test("a size that is no number of threads from 1 to 1024 refuses: one line, naming the variable, the value, the range and the default", () => {
  for (const bad of ["abc", "-1", "0", "1025", "8x", " 8"]) {
    const r = spawnSync(process.execPath, [SIZE], { env: { ...process.env, UV_THREADPOOL_SIZE: bad }, encoding: "utf8" });
    assert.equal(r.status, 1, bad);
    assert.equal(r.stderr, `UV_THREADPOOL_SIZE=${JSON.stringify(bad)} is not a number of threads from 1 to 1024: set one, or unset it for Mason's 32\n`);
  }
});

/** `sizePool` under a limit written to a file, on a machine of `cpus`: the size, the env and what it said */
function underLimit(limit: string, own: string | undefined, cpus = 2, file: "cgroup" | "limits" = "cgroup"): { size: number | null; env: Record<string, string>; said: string[]; refused: string | null } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-limit-"));
  try {
    const fake = path.join(dir, "limit");
    fs.writeFileSync(fake, limit);
    const missing = path.join(dir, "none");
    const env: Record<string, string> = own === undefined ? {} : { UV_THREADPOOL_SIZE: own };
    const said: string[] = [];
    let refused: string | null = null;
    const size = sizePool({ env, platform: "linux", cpus, announce: true, say: (l) => said.push(l), refuse: (l) => { refused = l; },
      cgroupFiles: file === "cgroup" ? [missing, fake] : [missing], processLimits: file === "limits" ? fake : missing });
    return { size, env, said, refused };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("a thread limit below what Mason needs lowers the default to fit, says so once, and never goes under 4", () => {
  // 32 + 20 + 5 a CPU: 62 at 2 CPUs
  const lowered = underLimit("60\n", undefined);
  assert.equal(lowered.size, 30);
  assert.equal(lowered.env.UV_THREADPOOL_SIZE, "30");
  assert.deepEqual(lowered.said, ["this machine allows 60 threads and Mason wants about 62, so it uses a pool of 30: set UV_THREADPOOL_SIZE=30 to choose it, or another that fits"]);
  assert.equal(underLimit("10\n", undefined).size, 4, "never below Node's own");
  const fits = underLimit("62\n", undefined);
  assert.deepEqual([fits.size, fits.said], [32, []]);
  assert.equal(underLimit("max\n", undefined).size, 32, "cgroup's word for no limit");
  assert.equal(underLimit("60\n", undefined, 4).size, 20, "five a CPU");
  assert.equal(underLimit("Limit  Soft Limit  Hard Limit  Units\nMax processes  60  70  processes\n", undefined, 2, "limits").size, 30, "/proc/self/limits: the soft limit");
  assert.equal(underLimit("Max processes  unlimited  unlimited  processes\n", undefined, 2, "limits").size, 32);
});

test("an operator's size that does not fit refuses, naming one that does; one that fits is kept, and what a run inherits from a lowered start is never refused", () => {
  const refused = underLimit("60\n", "64");
  assert.equal(refused.size, null);
  assert.match(refused.refused ?? "", /^UV_THREADPOOL_SIZE=64 does not fit: this machine allows 60 threads, Mason would need about 94, .*set UV_THREADPOOL_SIZE=30$/);
  assert.equal(underLimit("60\n", "30").size, 30);
  assert.equal(underLimit("10\n", "4").size, 4);
});

test("a limit is Linux's: another platform reads none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pool-limit-"));
  try {
    fs.writeFileSync(path.join(dir, "limit"), "10\n");
    assert.equal(sizePool({ env: {}, platform: "darwin", cpus: 2, cgroupFiles: [path.join(dir, "limit")] }), 32);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("every way Mason starts goes through the entry that sizes the pool", () => {
  const pkg = JSON.parse(read("cli", "package.json")) as { bin: Record<string, string> };
  assert.deepEqual(pkg.bin, { mason: "dist/src/cli/mason.cjs" }, "the published CLI");
  assert.match(read("cli", "build.ts"), /chmodSync\(path\.join\(DIST, "src", "cli", "mason\.cjs"\)/, "the build makes it executable");
  assert.match(read("docker", "mason-data.Dockerfile"), /exec node \/app\/src\/cli\/mason\.cjs "\$@"/, "the image");
  assert.doesNotMatch(read("docker", "mason-data.Dockerfile"), /cli\/main\.ts/, "and nothing in the image starts around it");
  assert.match(read("src", "cli", "background.ts"), /const MAIN = .*"mason\.cjs"\);/, "the run mason start starts");
  const entry = read("src", "cli", "mason.cjs");
  assert.match(entry, /^#!\/usr\/bin\/env node\n/);
  assert.ok(entry.indexOf('require("./pool-size.cjs")') > 0 && entry.indexOf('require("./pool-size.cjs")') < entry.indexOf("import("), "sized before the command loads");
  const firstImport = /^import .*$/m.exec(read("src", "cli", "main.ts"))?.[0];
  assert.match(firstImport ?? "", /^import "\.\/pool-size\.cjs";$/, "a checkout's node src/cli/main.ts: the first import, before anything can use the pool");
});
