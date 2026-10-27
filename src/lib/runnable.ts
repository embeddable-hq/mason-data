/**
 * A SCRIPT'S RUNNABLE FILE. This repo runs its TypeScript directly (Node's type stripping, no build), so
 * every script the service starts, and every template the compiler imports, is named by its `.ts` path. The
 * `@mason-data/cli` package cannot ship it that way — Node refuses to strip types under node_modules — so it ships the
 * same sources compiled to `.js` beside each other (cli/build.ts). This picks whichever is there: the `.ts` in a
 * checkout or the image, the `.js` in the package. Dependency-free.
 */
import * as fs from "node:fs";

export function runnable(file: string): string {
  if (!file.endsWith(".ts") || fs.existsSync(file)) return file;
  const js = `${file.slice(0, -3)}.js`;
  return fs.existsSync(js) ? js : file;
}
