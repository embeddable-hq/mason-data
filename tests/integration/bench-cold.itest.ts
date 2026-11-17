/**
 * THE COLD MODE'S SMOKE (`node scripts/bench-replica.ts --cold`, docs/BENCHMARK.md "The cold mode"), end to end at
 * 1 M rows: a Postgres container and a `mason-data` container of the same limits, Mason's first sync from it, the
 * answers held equal, then every statement once at 1 and at 10 clients on each engine, each run after a restart and a
 * dropped page cache; the fixture it writes holds every run, and nothing is left behind (no container, volume,
 * network, or file of secrets).
 *
 * Needs Docker and a page cache this user can drop (root, or `sudo -n tee /proc/sys/vm/drop_caches`): CI's runner
 * has both, and on CI it runs whatever this machine says. No IT_POSTGRES_URL: the run makes its own Postgres.
 * IT_BENCH_MASON_IMAGE names the image (default the `main` one: every merge publishes it, where a release's
 * version is published only by its merge). IT_BENCH_COLD_ROWS runs it at another size, on a machine whose disk is
 * short of 1 M rows' (about 1 GiB on both engines).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ColdFixture } from "../../scripts/bench-replica-cold.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const image = process.env.IT_BENCH_MASON_IMAGE || "ghcr.io/embeddable-hq/mason-data:main";
const rows = Number(process.env.IT_BENCH_COLD_ROWS || 1e6);

/** why this machine cannot run it, or null; on CI nothing is skipped, so a runner that lost either fails here */
function cannot(): string | null {
  if (process.env.CI) return null;
  if (process.platform !== "linux") return "the cold mode drops the page cache, which only Linux lets it do";
  if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) return "Docker does not answer";
  const drop = process.getuid?.() === 0 ? spawnSync("test", ["-w", "/proc/sys/vm/drop_caches"]) : spawnSync("sudo", ["-n", "true"]);
  return drop.status === 0 ? null : "this user cannot drop the page cache (root, or sudo -n)";
}
const why = cannot();

const left = (): string => spawnSync("docker", ["ps", "-a", "--filter", "name=^/bench-cold-", "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.trim() +
  spawnSync("docker", ["volume", "ls", "--filter", "name=^bench-cold-", "--format", "{{.Name}}"], { encoding: "utf8" }).stdout.trim() +
  spawnSync("docker", ["network", "ls", "--filter", "name=^bench-cold$", "--format", "{{.Name}}"], { encoding: "utf8" }).stdout.trim();
const workDirs = (): string[] => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("bench-cold-"));

test("--cold at 1 M rows: both engines in containers of the same limits, the answers held equal, each statement once at 1 and 10 clients after a restart and a dropped cache, every run in the fixture, nothing left behind",
  { skip: why ?? false, timeout: 1_500_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "it-bench-cold-"));
    const out = path.join(dir, "cold.json");
    const before = workDirs();
    try {
      const args = ["scripts/bench-replica.ts", "--cold", "--sizes", String(rows), "--clients", "1,10", "--runs", "1", "--settle", "1", "--cpus", "2", "--memory", "2g",
        "--reserve-gb", "0", "--mason-image", image, "--label", "the cold smoke", "--out", out];
      const r = await new Promise<{ code: number | null; text: string }>((resolve) => {
        const child = spawn(process.execPath, args, { cwd: ROOT });
        let text = "";
        child.stdout.on("data", (d: Buffer) => { text += d; });
        child.stderr.on("data", (d: Buffer) => { text += d; });
        child.on("close", (code) => resolve({ code, text }));
      });
      assert.equal(r.code, 0, r.text);
      assert.match(r.text, /every statement's answer is the same on both/);
      for (const secret of ["POSTGRES_PASSWORD", "MASON_API_KEY", "PGPASSWORD", "\"password\""]) assert.ok(!r.text.includes(secret), `the output names ${secret}`);
      const f = JSON.parse(fs.readFileSync(out, "utf8")) as ColdFixture;
      assert.ok(f.complete);
      assert.equal(f.kind, "cold");
      assert.deepEqual([f.environment.limits.cpus, f.environment.limits.memoryBytes, f.environment.limits.memorySwapBytes], [2, 2 * 2 ** 30, 2 * 2 ** 30]);
      assert.equal(f.environment.mason.image, image);
      assert.match(f.environment.mason.serverVersion, /mason-data/);
      const size = f.sizes[0]!;
      assert.equal(size.rows, rows);
      assert.equal(new Set(size.lookupIds).size, 10, "ten clients, ten rows");
      assert.ok(size.lookupIds.every((id) => id >= 1 && id <= rows));
      for (const [n, a] of Object.entries(size.answers)) assert.equal(a.postgres, a.mason, n);
      assert.equal(f.runs.length, 3 * 2 * 2, "3 statements × 1 and 10 clients × 2 engines");
      for (const run of f.runs) {
        assert.equal(run.latenciesMs.length, run.clients, `${run.statement} ${run.engine} ${run.clients}`);
        assert.ok(run.latenciesMs.every((x) => x > 0) && run.slowestMs === Math.max(...run.latenciesMs), `${run.statement} ${run.engine} ${run.clients}`);
      }
      assert.equal(left(), "", "the run removed its containers, volumes and network");
      assert.deepEqual(workDirs().filter((d) => !before.includes(d)), [], "the run removed its folder of secrets");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
