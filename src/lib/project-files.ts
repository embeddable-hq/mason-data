/**
 * A PROJECT'S OWN FILES: the YAML under a project folder (its sources file, mason.yml) — what the run fingerprints into
 * its state (src/cli/run-server.ts `runState`), which `mason status` and `mason wait` read (src/cli/commands.ts). In
 * the ClickHouse stack this was cut from, its `mason` service watched them and re-applied on a change in dev.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, type Hash } from "node:crypto";

/** Files whose change means a re-apply: the project's YAML (its sources file, mason.yml). */
export function isProjectFile(rel: string): boolean {
  if (rel.split(path.sep).some((p) => p.startsWith("."))) return false;
  return /\.ya?ml$/.test(rel);
}

/** Every project file (`isProjectFile`) under `project`, as full paths, sorted. */
export function projectFiles(project: string): string[] {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith(".") && e.name !== "node_modules") walk(p); }
      else if (isProjectFile(path.relative(project, p))) files.push(p);
    }
  };
  walk(project);
  return files.sort();
}

/** The project's own files (`isProjectFile`), hashed with their paths. */
export function hashProjectFiles(project: string): Hash {
  const h = createHash("sha256");
  for (const f of projectFiles(project)) h.update(`== ${path.relative(project, f)}\n`).update(fs.readFileSync(f));
  return h;
}

/**
 * The project's files as one hash: the run's state's `project` (`RunState`, src/cli/commands.ts) — an edit, an added
 * file and a deleted one each change it; an editor's swap file does not.
 */
export function projectFingerprint(project: string): string { return hashProjectFiles(project).digest("hex"); }
