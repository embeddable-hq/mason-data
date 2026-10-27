/**
 * WHAT `@mason-data/cli` SHIPS BESIDE ITS COMPILED CODE (cli/build.ts): every file under src/ that is not TypeScript —
 * the files the code reads at run time, the web page's (src/web/: index.html, app.js, app.css) among them. A module of
 * its own so tests/cli-package.test.ts holds the rule without building.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** Every file under `dir` (relative paths). */
function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]);
}

/** The files under `src` (relative to it) that the build copies as they are: everything but the TypeScript it compiles. */
export function besideCode(src: string): string[] {
  return walk(src).filter((f) => !f.endsWith(".ts")).sort();
}
