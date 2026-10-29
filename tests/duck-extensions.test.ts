/**
 * THE COPY'S EXTENSIONS SHIP WITH MASON (src/duck/extensions.ts, cli/extensions.ts): the resolver finds this platform's
 * package over a fake node_modules for every platform a package is built for, says why when it cannot, and gives the
 * instance a setting that downloads nothing; the build holds every file to its pinned checksum and lays the package
 * out as DuckDB reads an extension_directory; cli/extensions.json pins every platform for the engine the CLI runs.
 * Offline: the real files' load, a copy and an inet cast with nothing downloaded are tests/integration/extensions.itest.ts.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { version } from "@duckdb/node-api";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = `v${version().replace(/^v/, "")}`;
// imported when the tests run: at a commit without the modules the file still loads, and each test fails by name
type X = typeof import("../src/duck/extensions.ts");
type B = typeof import("../cli/extensions.ts");
// only a module that is not there is absent: any other failure to load it is thrown
const absent = (e: unknown): null => { if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return null; throw e; };
const x = await import("../src/duck/extensions.ts" as string).catch(absent) as X | null;
const b = await import("../cli/extensions.ts" as string).catch(absent) as B | null;
const mod = (): X => { assert.ok(x, "src/duck/extensions.ts exists"); return x; };
const build = (): B => { assert.ok(b, "cli/extensions.ts exists"); return b; };

const PLATFORMS: Record<string, string> = { "darwin-arm64": "osx_arm64", "darwin-x64": "osx_amd64", "linux-arm64": "linux_arm64", "linux-x64": "linux_amd64", "win32-x64": "windows_amd64" };
const hostOf = (key: string): { platform: string; arch: string; musl: boolean } => {
  const [platform, arch, libc] = key.split("-") as [string, string, string?];
  return { platform, arch, musl: libc === "musl" };
};

/** A node_modules in a temp folder, and a resolve that finds a package there as Node would, or throws as Node does. */
function fakeModules(): { dir: string; resolve: (id: string) => string; add: (key: string, o?: { engine?: string; omit?: string }) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-modules-"));
  const resolve = (id: string): string => {
    const f = path.join(dir, "node_modules", id);
    if (!fs.existsSync(f)) throw Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
    return f;
  };
  const add = (key: string, o: { engine?: string; omit?: string } = {}): string => {
    const root = path.join(dir, "node_modules", "@mason-data", `extensions-${key}`);
    const at = path.join(root, "extensions", o.engine ?? ENGINE, PLATFORMS[key]!);
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: `@mason-data/extensions-${key}`, version: "9.8.7" }));
    for (const n of ["postgres_scanner", "inet"]) if (n !== o.omit) fs.writeFileSync(path.join(at, `${n}.duckdb_extension`), "");
    return root;
  };
  return { dir, resolve, add };
}

test("the resolver finds each platform's package and hands the instance its folder, with nothing ever downloaded", () => {
  const { findExtensions, extensionSettings, loadPostgresSql, EXTENSION_PLATFORMS } = mod();
  assert.deepEqual({ ...EXTENSION_PLATFORMS }, PLATFORMS, "the platforms a package is built for, by Node's name and DuckDB's");
  const m = fakeModules();
  try {
    for (const key of Object.keys(PLATFORMS)) {
      const root = m.add(key);
      const found = findExtensions({ host: hostOf(key), engine: ENGINE, resolve: m.resolve });
      assert.deepEqual(found, { shipped: true, package: `@mason-data/extensions-${key}`, version: "9.8.7", directory: path.join(root, "extensions"), platform: key }, key);
      assert.deepEqual(extensionSettings(found), { extension_directory: path.join(root, "extensions"), autoinstall_known_extensions: "false", autoload_known_extensions: "true" });
      assert.equal(loadPostgresSql(found), "LOAD postgres", "a LOAD from the package, never an INSTALL");
    }
  } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
});

test("without the package the resolver says why, and the instance keeps DuckDB's own install", () => {
  const { findExtensions, extensionSettings, loadPostgresSql } = mod();
  const m = fakeModules();
  try {
    const none = findExtensions({ host: hostOf("linux-x64"), engine: ENGINE, resolve: m.resolve });
    assert.deepEqual(none, { shipped: false, package: "@mason-data/extensions-linux-x64",
      why: "@mason-data/extensions-linux-x64 is not installed beside Mason (npm installs it with @mason-data/cli unless optional dependencies are left out: --omit=optional)" });
    assert.deepEqual(extensionSettings(none), {});
    assert.equal(loadPostgresSql(none), "INSTALL postgres; LOAD postgres;");
    // a platform no package is built for: musl, Windows on arm64
    for (const [key, host] of [["linux-x64-musl", { platform: "linux", arch: "x64", musl: true }], ["win32-arm64", { platform: "win32", arch: "arm64", musl: false }]] as const) {
      assert.deepEqual(findExtensions({ host, engine: ENGINE, resolve: m.resolve }), { shipped: false, package: null,
        why: `no package of the copy's extensions is built for ${key} (only darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64)` });
    }
    // a package for another engine (a mismatched install), and one missing a file
    m.add("darwin-arm64", { engine: "v1.9.0" });
    assert.deepEqual(findExtensions({ host: hostOf("darwin-arm64"), engine: ENGINE, resolve: m.resolve }), { shipped: false, package: "@mason-data/extensions-darwin-arm64",
      why: `@mason-data/extensions-darwin-arm64 9.8.7 holds no postgres_scanner or inet for the engine Mason runs (${ENGINE}; it holds v1.9.0): install @mason-data/cli again, whose packages are released together` });
    m.add("linux-arm64", { omit: "inet" });
    const half = findExtensions({ host: hostOf("linux-arm64"), engine: ENGINE, resolve: m.resolve });
    assert.equal(half.shipped, false);
    assert.match(half.shipped ? "" : half.why, /holds no inet for the engine Mason runs/);
    // a resolve that fails otherwise is said as it is, never taken for "not installed"
    assert.throws(() => findExtensions({ host: hostOf("linux-x64"), engine: ENGINE, resolve: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } }), /EACCES/);
  } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
});

test("this machine's key is npm's: Node's platform and arch, -musl on a musl Linux", () => {
  const { thisHost, hostKey } = mod();
  const h = thisHost();
  assert.equal(h.platform, process.platform);
  assert.equal(h.arch, process.arch);
  if (process.platform !== "linux") assert.equal(h.musl, false);
  assert.equal(hostKey(h), `${process.platform}-${process.arch}${h.musl ? "-musl" : ""}`);
  assert.equal(hostKey({ platform: "linux", arch: "arm64", musl: true }), "linux-arm64-musl");
});

test("cli/extensions.json pins both files of every platform, for the engine the CLI runs", () => {
  const { EXTENSION_PLATFORMS, EXTENSION_NAMES } = mod();
  const { readManifest, engineProblem, fileUrl } = build();
  const m = readManifest();
  assert.equal(engineProblem(m), null, "the manifest's engine is @duckdb/node-api's");
  assert.equal(m.repository, "https://extensions.duckdb.org");
  assert.deepEqual(Object.keys(m.files).sort(), Object.keys(EXTENSION_PLATFORMS).sort());
  for (const p of Object.keys(EXTENSION_PLATFORMS)) {
    assert.deepEqual(Object.keys(m.files[p]!).sort(), [...EXTENSION_NAMES].sort(), p);
    for (const n of EXTENSION_NAMES) {
      assert.match(m.files[p]![n]!.sha256, /^[0-9a-f]{64}$/);
      assert.ok(m.files[p]![n]!.bytes > 1_000_000, `${p} ${n} is a real file's size`);
    }
  }
  assert.equal(fileUrl(m, "linux-x64", "inet"), `https://extensions.duckdb.org/${m.engine}/linux_amd64/inet.duckdb_extension.gz`);
  assert.match(engineProblem({ ...m, engine: "v0.0.1" }) ?? "", /pins the extensions of engine v0\.0\.1, and @duckdb\/node-api runs v.*: run node cli\/extensions\.ts --pin/);
});

test("a platform's package is built from files held to their pinned checksums, whole or not at all, and packs as npm publishes it", async () => {
  const { findExtensions } = mod();
  const { buildPackage, packageJson } = build();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-build-"));
  try {
    const files: Record<string, Buffer> = { postgres_scanner: Buffer.from("the postgres extension's bytes"), inet: Buffer.from("the inet extension's bytes") };
    const pins = Object.fromEntries(Object.entries(files).map(([n, f]) => [n, { sha256: crypto.createHash("sha256").update(f).digest("hex"), bytes: f.length }]));
    const manifest = { engine: ENGINE, repository: "https://repo.test", files: { "linux-x64": pins } };
    const asked: string[] = [];
    const fetchGz = async (url: string): Promise<Buffer> => { asked.push(url); return zlib.gzipSync(files[path.basename(url).split(".")[0]!]!); };
    const out = path.join(dir, "node_modules", "@mason-data", "extensions-linux-x64");
    await buildPackage({ manifest, platform: "linux-x64", cliVersion: "1.2.3", dir: out, fetchGz });
    assert.deepEqual(asked.sort(), [`https://repo.test/${ENGINE}/linux_amd64/inet.duckdb_extension.gz`, `https://repo.test/${ENGINE}/linux_amd64/postgres_scanner.duckdb_extension.gz`]);
    for (const [n, f] of Object.entries(files)) assert.deepEqual(fs.readFileSync(path.join(out, "extensions", ENGINE, "linux_amd64", `${n}.duckdb_extension`)), f);
    const pkg = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(pkg, packageJson(manifest, "linux-x64", "1.2.3"));
    assert.equal(pkg.name, "@mason-data/extensions-linux-x64");
    assert.equal(pkg.version, "1.2.3", "the CLI's version: they are released together");
    assert.deepEqual([pkg.os, pkg.cpu, pkg.libc], [["linux"], ["x64"], ["glibc"]], "npm installs it on glibc Linux x64 alone");
    assert.deepEqual([packageJson(manifest, "darwin-arm64", "1.2.3").os, packageJson(manifest, "darwin-arm64", "1.2.3").cpu, packageJson(manifest, "darwin-arm64", "1.2.3").libc], [["darwin"], ["arm64"], undefined]);
    assert.equal(fs.readFileSync(path.join(out, "LICENSE"), "utf8"), fs.readFileSync(path.join(ROOT, "cli", "extensions-LICENSE"), "utf8"));
    // what the resolver finds in it, as installed
    const found = findExtensions({ host: { platform: "linux", arch: "x64", musl: false }, engine: ENGINE, resolve: (id) => path.join(dir, "node_modules", id) });
    assert.equal(found.shipped, true);
    // what npm would publish: the two files, the manifest, the README and the LICENSE, nothing else
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: out, encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const [listing] = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }> }>;
    assert.deepEqual(listing!.files.map((f) => f.path).sort(), ["LICENSE", "README.md", `extensions/${ENGINE}/linux_amd64/inet.duckdb_extension`, `extensions/${ENGINE}/linux_amd64/postgres_scanner.duckdb_extension`, "package.json"]);
    // built again: the files in place with their pins are kept, not fetched
    asked.length = 0;
    await buildPackage({ manifest, platform: "linux-x64", cliVersion: "1.2.4", dir: out, fetchGz });
    assert.deepEqual(asked, []);
    assert.equal((JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8")) as { version: string }).version, "1.2.4");
    // a file that is not the pinned one fails the build, and nothing is written
    const other = path.join(dir, "other");
    await assert.rejects(buildPackage({ manifest, platform: "linux-x64", cliVersion: "1.2.3", dir: other, fetchGz: async () => zlib.gzipSync(Buffer.from("something else")) }),
      /is not the file cli\/extensions\.json pins: sha256 [0-9a-f]{64} \(14 bytes\), pinned [0-9a-f]{64} \(\d+ bytes\)\. Nothing was written/);
    assert.equal(fs.existsSync(other), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["node_modules"], "no half-built folder left beside it");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the copy that cannot load its extension says where it looked and the way out", () => {
  const { extensionFailure } = mod();
  assert.equal(extensionFailure({ shipped: true, package: "@mason-data/extensions-linux-x64", version: "1.2.3", directory: "/app/node_modules/@mason-data/extensions-linux-x64/extensions", platform: "linux-x64" }, "IO Error: bad file"),
    "Mason could not load the copy's postgres extension from @mason-data/extensions-linux-x64 1.2.3 (/app/node_modules/@mason-data/extensions-linux-x64/extensions): IO Error: bad file. Install @mason-data/cli again; mason doctor checks it");
  assert.equal(extensionFailure({ shipped: false, package: null, why: "no package of the copy's extensions is built for linux-x64-musl (only …)" }, "HTTP Error: no route"),
    "Mason could not load the copy's postgres extension: HTTP Error: no route. no package of the copy's extensions is built for linux-x64-musl (only …), " +
    "so the first copy on a machine downloads it (then ~/.duckdb/extensions): connect to the internet once, and the copy is tried again at the next pass");
});

test("mason doctor's probe loads the package's files as the run would: a file that is not an extension is said", async () => {
  const { probeExtensions, hostKey, thisHost } = mod();
  const m = fakeModules();
  try {
    // this machine's platform, so the engine looks where the files are and finds them, empty
    const key = hostKey(thisHost()) in PLATFORMS ? hostKey(thisHost()) as import("../src/duck/extensions.ts").ExtensionPlatform : "linux-x64";
    const root = m.add(key);
    const probe = await probeExtensions({ shipped: true, package: `@mason-data/extensions-${key}`, version: "9.8.7", directory: path.join(root, "extensions"), platform: key });
    assert.equal(probe.ok, false);
    assert.match(probe.detail, new RegExp(`^@mason-data/extensions-${key} 9\\.8\\.7 is installed, and its postgres_scanner does not load: .+\\. Install @mason-data/cli again$`));
    if (key === hostKey(thisHost())) assert.doesNotMatch(probe.detail, /not found|does not exist/i, `the empty file was read: ${probe.detail}`);
  } finally { fs.rmSync(m.dir, { recursive: true, force: true }); }
});
