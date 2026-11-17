/**
 * THE BENCHMARK'S COLD MODE, RUN FOR REAL (scripts/bench-replica-cold.ts, docs/BENCHMARK.md "The cold mode"): a smoke
 * of `node scripts/bench-replica.ts --cold` at 1 M rows, 1 and 10 clients, one run. It starts its own Postgres and a
 * Mason of the `mason-data` image, each in a container, and the fixture it writes must have every cell, the same
 * answers on both, Mason's engine memory read from its log, no secret in its output, and nothing of it left behind.
 *
 * What it needs: IT_BENCH_COLD=1, Linux, Docker (the images are pulled when missing: the `mason-data` image of this
 * checkout's version and postgres:18), passwordless sudo to drop the page cache, and several minutes. It is not in CI
 * by default: it would add about ten minutes to every PR, on a runner shared with other jobs. IT_POSTGRES_URL is not
 * read. IT_BENCH_COLD_SIZES (default 1M) and IT_BENCH_COLD_MEMORY (default the script's, half the RAM) change its size.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ColdFixture } from "../../scripts/bench-replica-cold.ts";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "bench-replica.ts");
const on = process.env.IT_BENCH_COLD === "1";

/** the script's run, its output streamed to this test's stderr as it comes and kept */
function runCold(args: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, "--cold", ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (d: Buffer): void => { output += d.toString("utf8"); process.stderr.write(d); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

/** what a docker listing names, one a line */
const names = (args: string[]): string[] => {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
};

test("--cold at 1 M rows: every cell measured on both engines, the same answers, no secret printed, nothing left behind",
  { skip: on ? false : "IT_BENCH_COLD=1 runs it (Linux, Docker, passwordless sudo for the page cache, minutes)", timeout: 2 * 60 * 60_000 }, async () => {
    const { coldFixtureProblems } = await import("../../scripts/bench-replica-cold.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-bench-cold-"));
    // Postgres's data is an anonymous volume, and Mason's a named one: every volume the run made must be gone at its end
    const volumesBefore = names(["volume", "ls", "-q"]);
    try {
      const out = path.join(dir, "cold.json");
      const memory = process.env.IT_BENCH_COLD_MEMORY;
      const r = await runCold(["--sizes", process.env.IT_BENCH_COLD_SIZES ?? "1M", "--clients", "1,10", "--runs", "1", "--settle", "2", "--label", "itest",
        "--work", dir, "--out", out, ...(memory === undefined ? [] : ["--memory", memory])]);
      assert.equal(r.status, 0, `the cold run failed:\n${r.output.slice(-4000)}`);
      const f = JSON.parse(fs.readFileSync(out, "utf8")) as ColdFixture;
      assert.deepEqual(coldFixtureProblems(f), []);
      assert.equal(f.skipped.length, 0, `a size was skipped: ${JSON.stringify(f.skipped)}`);
      for (const z of f.sizes) assert.deepEqual(z.differences, [], `${z.rows} rows: every answer the same on both`);
      assert.ok(f.cells.every((c) => c.slowestMs > 0 && c.runs.every((run) => run.readyMs > 0)), "every run timed, after its engine answered");
      assert.match(f.environment.mason.engineMemory, /^\d+(\.\d+)?[MG]iB$/, "Mason's engine memory, read from its log");
      assert.match(f.environment.postgres.version, /^PostgreSQL 1\d/);
      // no URL with its password, no env file's line: the secrets stay in their 0600 files
      assert.doesNotMatch(r.output, /postgres(ql)?:\/\/[^:/\s]+:[^@\s]+@/, "a URL with its password was printed");
      assert.doesNotMatch(r.output, /PGPASSWORD|POSTGRES_PASSWORD|MASON_API_KEY=/, "an env file's line was printed");
      // everything the run made is gone, its files too
      assert.deepEqual(names(["ps", "-a", "--format", "{{.Names}}"]).filter((n) => ["bench-pg", "bench-mason", "bench-client"].includes(n)), [], "a bench container is left");
      assert.deepEqual(names(["volume", "ls", "-q"]).filter((n) => !volumesBefore.includes(n)), [], "a volume the run made is left");
      assert.deepEqual(names(["network", "ls", "--format", "{{.Name}}"]).filter((n) => n === "bench-replica"), [], "the bench network is left");
      assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith("bench-cold-")), [], "the run's files are left");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
