/**
 * The package's version when installed; else the image's (`MASON_VERSION`, stamped at build by images-publish.yml:
 * `v0.6.1` for a release, said `0.6.1` as the package says it, or `main-<sha>`); a checkout runs as "dev" (and
 * ClickHouse's `main` image).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export function version(): string {
  // src/cli/ in a checkout (the repo's package.json, which is not this one), dist/src/cli/ in the package
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.join(here, "..", "..", "package.json"), path.join(here, "..", "..", "..", "package.json")]) {
    if (!fs.existsSync(p)) continue;
    const pkg = JSON.parse(fs.readFileSync(p, "utf8")) as { name?: string; version?: string };
    if (pkg.name === "@mason-data/cli" && pkg.version) return pkg.version;
  }
  const image = process.env.MASON_VERSION?.trim();
  if (image) return /^v\d+\.\d+\.\d+$/.test(image) ? image.slice(1) : image;
  return "dev";
}
