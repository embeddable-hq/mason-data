/**
 * The Helm chart (deploy/helm/mason-data/), rendered by `helm template` as `helm install` and `helm upgrade` render it.
 *
 * A RENAMED VALUE SET UNDER ITS OLD NAME REFUSES (CLAUDE.md "Every setting an operator or installer sets"): `memory.copy`
 * became `memory.engine` (issue 903), and a values file that still says `copy:` must fail to render, naming the new
 * key — never install with the default in its place, which would hand the engine 4GB whatever the operator chose.
 *
 * Rendering needs the `helm` command, which CI's runner carries; a machine without it skips the rendering tests, says
 * so, and still holds the chart's text below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CHART = path.join(import.meta.dirname, "..", "deploy", "helm", "mason-data");
const REQUIRED = ["--set", "database.url=postgres://mason@db.example.com/shop", "--set", `database.apiKey=${"k".repeat(32)}`];

/** `helm template` of the chart with a values file holding `values`: its exit, stdout and stderr; null with no helm */
function render(values: string): { status: number | null; stdout: string; stderr: string } | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mason-helm-"));
  try {
    const file = path.join(dir, "values.yaml");
    fs.writeFileSync(file, values);
    const r = spawnSync("helm", ["template", "mason", CHART, "-f", file, ...REQUIRED], { encoding: "utf8" });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** the value of MASON_DUCKDB_MEMORY in a rendered StatefulSet */
const engineMemory = (rendered: string): string | undefined => /- name: MASON_DUCKDB_MEMORY\n\s+value: "([^"]*)"/.exec(rendered)?.[1];

test("the chart's memory.engine is the engine's share of the memory (MASON_DUCKDB_MEMORY): its default, and an operator's value", (t) => {
  const byDefault = render("{}\n");
  if (byDefault === null) { t.skip("no helm on this machine"); return; }
  assert.equal(byDefault.status, 0, byDefault.stderr);
  assert.equal(engineMemory(byDefault.stdout), "4GB");
  const chosen = render("memory:\n  limit: 16Gi\n  engine: 8GB\n")!;
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.equal(engineMemory(chosen.stdout), "8GB");
});

test("an old values file setting memory.copy fails to render, naming memory.engine, and never installs with the default", (t) => {
  const old = render("memory:\n  limit: 16Gi\n  copy: 8GB\n");
  if (old === null) { t.skip("no helm on this machine"); return; }
  assert.notEqual(old.status, 0, "rendered with memory.copy set");
  assert.match(old.stderr, /memory\.copy was renamed memory\.engine: in your values file, write `engine:` in place of `copy:` under `memory:`/);
  assert.doesNotMatch(old.stdout, /kind: StatefulSet/, "nothing rendered to install");
  const both = render("memory:\n  copy: 8GB\n  engine: 8GB\n")!;
  assert.notEqual(both.status, 0, "the old key beside the new one is still refused: it says the file was not updated");
});

test("the chart names memory.engine and refuses memory.copy in its text (held where no helm renders it)", () => {
  const values = fs.readFileSync(path.join(CHART, "values.yaml"), "utf8");
  const memory = /^memory:\n((?: {2}.*\n)+)/m.exec(values)?.[1] ?? "";
  assert.match(memory, /^ {2}engine: \S+/m);
  assert.doesNotMatch(memory, /^ {2}copy:/m);
  const set = fs.readFileSync(path.join(CHART, "templates", "statefulset.yaml"), "utf8");
  assert.match(set, /value: \{\{ \.Values\.memory\.engine \| quote \}\}/);
  assert.match(set, /\{\{- if hasKey \(\.Values\.memory \| default dict\) "copy" \}\}\n\{\{- fail "memory\.copy was renamed memory\.engine/);
});
