/**
 * THE SIZE OF LIBUV'S POOL (src/cli/pool-size.cjs, issue 88), offline: what it sets, proved by a probe of a real pool,
 * and that every way Mason starts goes through it. tests/integration/duck-pool.itest.ts holds it in real runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = path.join(ROOT, "src", "cli", "pool-size.cjs");
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

test("the pool is 64 threads unset or empty, and an operator's own UV_THREADPOOL_SIZE is left as it is", { timeout: 120_000 }, () => {
  assert.equal(poolOf(undefined), 64);
  assert.equal(poolOf(""), 64, "libuv would read an empty one as 1");
  assert.equal(poolOf("7"), 7);
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
  assert.equal(firstImport, 'import "./pool-size.cjs";', "a checkout's node src/cli/main.ts: the first import, before anything can use the pool");
});
