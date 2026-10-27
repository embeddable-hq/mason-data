#!/usr/bin/env node
/**
 * BUILDS `@mason-data/cli` (cli/dist/): the repo's src/ compiled to JavaScript, file for file (`tsc -p cli`, which
 * rewrites every relative `./x.ts` import to `./x.js`), and beside it what the code reads at run time (a file under
 * src/ that is not TypeScript). The repo itself never builds: it runs its TypeScript directly; a package must not,
 * because Node refuses to strip types under node_modules. Where the code starts a script by its `.ts` path,
 * src/lib/runnable.ts finds the `.js`.
 *
 *   node cli/build.ts        (npm pack / npm publish in cli/ run it as `prepack`)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CLI);
const DIST = path.join(CLI, "dist");

fs.rmSync(DIST, { recursive: true, force: true });
const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tsc)) throw new Error(`no TypeScript compiler at ${tsc}: run npm install at the repo's root first`);
execFileSync(process.execPath, [tsc, "-p", CLI], { stdio: "inherit" });

/** Every file under `dir` (relative paths), for the copies below. */
function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]);
}
let copied = 0;
const copy = (from: string, to: string): void => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); copied++; };
// what src/ reads beside its code (none today; a .yml or .html added under src/ rides along)
for (const f of walk(path.join(ROOT, "src"))) {
  if (!f.endsWith(".ts")) copy(path.join(ROOT, "src", f), path.join(DIST, "src", f));
}
fs.chmodSync(path.join(DIST, "src", "cli", "main.js"), 0o755);
console.log(`built ${DIST}: src/ compiled, ${copied} file(s) copied beside it`);
