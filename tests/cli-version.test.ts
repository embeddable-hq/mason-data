/**
 * THE VERSION A MASON SAYS (src/cli/version.ts): the CLI package's when installed, else the image's `MASON_VERSION`
 * (images-publish.yml stamps `v<version>` on a release, `main-<sha>` on a merge), else `dev` — so `mason --version`,
 * /healthz and `version()` on the Postgres API of the `mason-data` image name the release it was built from, and a
 * checkout still says `dev`.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

/** `mason --version` from this checkout, with MASON_VERSION as given (absent when undefined) */
function versionOf(image: string | undefined): string {
  const env = { ...process.env };
  delete env.MASON_VERSION;
  if (image !== undefined) env.MASON_VERSION = image;
  return execFileSync(process.execPath, [MAIN, "--version"], { env, encoding: "utf8" }).trim();
}

test("a checkout says dev; the image's release is said as the package says it, a merge's main-<sha> as stamped", () => {
  assert.equal(versionOf(undefined), "dev");
  assert.equal(versionOf(""), "dev");
  assert.equal(versionOf("v0.6.1"), "0.6.1");
  assert.equal(versionOf("main-5eabb5ee0c"), "main-5eabb5ee0c");
  assert.equal(versionOf("dev"), "dev");
});
