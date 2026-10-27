/**
 * `@mason-data/cli` (cli/): the `mason` command `npm i -g @mason-data/cli` installs. The package ships src/ compiled
 * to JavaScript (cli/build.ts), because Node will not strip types under node_modules; these hold its manifest to
 * that build and to the licensing rule (CLAUDE.md "Licensing": a package that runs the stack is Apache-2.0), and the
 * resolver that lets the same code start `.ts` scripts in a checkout and `.js` ones in the package.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runnable } from "../src/lib/runnable.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "cli", "package.json"), "utf8")) as {
  name: string; license: string; bin: Record<string, string>; files: string[]; dependencies: Record<string, string>; scripts: Record<string, string>;
};

test("the package: `mason`, built from src/cli/main.ts, Apache-2.0, with the dependencies the service imports", () => {
  assert.equal(pkg.name, "@mason-data/cli");
  assert.deepEqual(pkg.bin, { mason: "dist/src/cli/main.js" });
  assert.ok(fs.existsSync(path.join(ROOT, "src", "cli", "main.ts")));
  assert.match(fs.readFileSync(path.join(ROOT, "src", "cli", "main.ts"), "utf8"), /^#!\/usr\/bin\/env node\n/);
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(fs.readFileSync(path.join(ROOT, "cli", "LICENSE"), "utf8"), fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"));
  assert.deepEqual(pkg.files.sort(), ["LICENSE", "README.md", "dist"]);
  assert.equal(pkg.scripts.prepack, "node build.ts", "npm pack and publish build it first");
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.deepEqual(pkg.dependencies, root.dependencies, "the service's own runtime dependencies, no more");
});

test("runnable: the .ts where it is (a checkout), else the .js beside it (the package), else the name as given", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runnable-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "");
    fs.writeFileSync(path.join(dir, "b.js"), "");
    assert.equal(runnable(path.join(dir, "a.ts")), path.join(dir, "a.ts"));
    assert.equal(runnable(path.join(dir, "b.ts")), path.join(dir, "b.js"));
    assert.equal(runnable(path.join(dir, "c.ts")), path.join(dir, "c.ts"), "neither: the .ts, so the error names the source");
    assert.equal(runnable(path.join(dir, "d.yml")), path.join(dir, "d.yml"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

