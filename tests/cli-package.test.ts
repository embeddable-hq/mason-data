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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runnable } from "../src/lib/runnable.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "cli", "package.json"), "utf8")) as {
  name: string; version: string; license: string; bin: Record<string, string>; files: string[]; dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>; scripts: Record<string, string>;
};

test("the package: `mason`, src/cli/mason.cjs over the built src/cli/main.ts, Apache-2.0, with the dependencies the service imports", () => {
  assert.equal(pkg.name, "@mason-data/cli");
  assert.deepEqual(pkg.bin, { mason: "dist/src/cli/mason.cjs" });
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


test("the package ships the web page: every file the command server serves is under src/web/ and copied beside the code", async () => {
  // imported when the test runs: at a commit without the rule's module the file still loads, and this test fails by name
  const beside = await import(path.join(ROOT, "cli", "beside.ts") as string).catch(() => ({})) as { besideCode?: (src: string) => string[] };
  assert.equal(typeof beside.besideCode, "function", "cli/beside.ts exports besideCode, cli/build.ts's copy rule");
  const shipped = beside.besideCode!(path.join(ROOT, "src"));
  // the routes the server reads its page from (src/cli/run-server.ts PAGE_ROUTES), from src/web/ beside src/cli/
  const server = await import("../src/cli/run-server.ts") as { PAGE_ROUTES?: Record<string, readonly [string, string]> };
  assert.ok(server.PAGE_ROUTES, "src/cli/run-server.ts exports PAGE_ROUTES");
  const files = Object.values(server.PAGE_ROUTES).map(([f]) => path.join("web", f)).sort();
  assert.deepEqual(files, ["app.css", "app.js", "charts.js", "index.html", "pages/queries.js", "pages/status.js", "pages/syncs.js", "pages/tables.js", "pages/usage.js", "pages/users.js", "shared.js",
    // vendored whole, with its licence (src/web/vendor/README.md): shipped and served like the page's own files
    "vendor/README.md", "vendor/geist-1.7.2/Geist-Variable.woff2", "vendor/geist-1.7.2/GeistMono-Variable.woff2", "vendor/geist-1.7.2/LICENSE.txt",
    "vendor/lucide-1.56.0/LICENSE.txt", "vendor/lucide-1.56.0/chart-column.mjs", "vendor/lucide-1.56.0/layout-dashboard.mjs", "vendor/lucide-1.56.0/logs.mjs",
    "vendor/lucide-1.56.0/menu.mjs", "vendor/lucide-1.56.0/square-terminal.mjs", "vendor/lucide-1.56.0/table.mjs", "vendor/lucide-1.56.0/users.mjs", "vendor/lucide-1.56.0/x.mjs",
    "vendor/uplot-1.6.32/LICENSE.txt", "vendor/uplot-1.6.32/uPlot.esm.js", "vendor/uplot-1.6.32/uPlot.min.css",
    "vendor/zilla-slab-5.3.0/LICENSE.txt", "vendor/zilla-slab-5.3.0/zilla-slab-latin-700-normal.woff2"]
    .map((f) => path.join("web", f)));
  for (const f of files) assert.ok(shipped.includes(f), `${f} is copied into dist/src/ (a page module in a subfolder too)`);
  // a module of the page that is no route would not load in the browser: every file under src/web/ is served
  assert.deepEqual(shipped.filter((f) => f.startsWith(`web${path.sep}`)), files, "every file under src/web/ is a route of PAGE_ROUTES");
  assert.ok(shipped.every((f) => !f.endsWith(".ts")), "TypeScript is compiled, never copied");
  assert.match(fs.readFileSync(path.join(ROOT, "cli", "build.ts"), "utf8"), /for \(const f of besideCode\(path\.join\(ROOT, "src"\)\)\) copy\(/, "cli/build.ts copies what the rule names");
});

test("the copy's extensions reach a user as the package's optional dependencies, one a platform, at its version, never inside it", () => {
  // the platforms a package is built for (src/duck/extensions.ts EXTENSION_PLATFORMS), each pinned to the CLI's version:
  // they are published together (.github/workflows/release.yml), and npm installs the one this machine runs
  const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
  assert.deepEqual(pkg.optionalDependencies, Object.fromEntries(platforms.map((p) => [`@mason-data/extensions-${p}`, pkg.version])));
  // the engine is pinned exactly: a range could install an engine whose extensions the packages do not hold
  const installed = (JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules", "@duckdb", "node-api", "package.json"), "utf8")) as { version: string }).version;
  assert.equal(pkg.dependencies["@duckdb/node-api"], installed);
  // npm would publish dist/, the README and the LICENSE — never an extension, even with the platform packages built
  // beside it (cli/platforms/, which a decoy stands for when none is)
  const decoy = path.join(ROOT, "cli", "platforms", `decoy-${process.pid}`, "extensions", "postgres_scanner.duckdb_extension");
  fs.mkdirSync(path.dirname(decoy), { recursive: true });
  fs.writeFileSync(decoy, "");
  try {
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: path.join(ROOT, "cli"), encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const [listing] = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = listing!.files.map((f) => f.path);
    assert.deepEqual(files.filter((f) => f.endsWith(".duckdb_extension") || f.startsWith("platforms/")), []);
    assert.deepEqual(files.filter((f) => !f.startsWith("dist/")).sort(), ["LICENSE", "README.md", "package.json"]);
  } finally { fs.rmSync(path.join(ROOT, "cli", "platforms", `decoy-${process.pid}`), { recursive: true, force: true }); }
});
