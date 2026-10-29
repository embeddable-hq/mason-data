/**
 * THE COPY'S EXTENSIONS SHIP WITH MASON. The copy reads the source through DuckDB's `postgres` extension
 * (src/duck/sync.ts attach), and a statement that casts a value to inet needs DuckDB's `inet`; DuckDB bundles
 * neither, and by default downloads one from its extension repository at the first statement that needs it. Mason
 * ships both instead, ONE npm PACKAGE PER PLATFORM (`@mason-data/extensions-<platform>`), as DuckDB's node bindings ship
 * their binary: an optional dependency of @mason-data/cli whose `os` / `cpu` / `libc` make npm install the one this
 * machine runs, built by cli/extensions.ts from the files' checksums pinned in cli/extensions.json. The image installs
 * the same package (docker/mason-data.Dockerfile).
 *
 * - A package found (`findExtensions`): the instance's `extension_directory` IS the package's folder and nothing is
 *   ever installed (`extensionSettings`): `LOAD postgres` reads it, an inet cast autoloads it from there, and
 *   autoinstall is off, so no statement downloads anything. DuckDB checks each file's signature at LOAD
 *   (`allow_unsigned_extensions` stays off: the official extensions are signed), and LOAD writes nothing, so the
 *   folder may be read-only (a global npm install, the image's /app).
 * - None (`npm install --omit=optional`, a platform no package is built for — musl, Windows on arm64 — or a checkout):
 *   DuckDB's own way, said with the reason: the first copy installs the extension from the internet into
 *   ~/.duckdb/extensions (src/duck/sync.ts attach). `mason doctor` says which (`probeExtensions`).
 *
 * tests/duck-extensions.test.ts holds the resolver per platform over a fake package; the integration test
 * (tests/integration/extensions.itest.ts) holds a copy and an inet cast to the package with nothing downloaded.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { DuckDBInstance, version } from "@duckdb/node-api";

/** Each platform a package is built for: Node's `<platform>-<arch>` (the package's name) and DuckDB's name for it (the
 *  folder of the extension repository, and of `extension_directory`). Linux is glibc's: musl has no package. */
export const EXTENSION_PLATFORMS = {
  "darwin-arm64": "osx_arm64",
  "darwin-x64": "osx_amd64",
  "linux-arm64": "linux_arm64",
  "linux-x64": "linux_amd64",
  "win32-x64": "windows_amd64",
} as const;
export type ExtensionPlatform = keyof typeof EXTENSION_PLATFORMS;

/** The extensions each package holds, by the name DuckDB installs them under (`INSTALL postgres` is `postgres_scanner`). */
export const EXTENSION_NAMES = ["postgres_scanner", "inet"] as const;

export const packageName = (p: ExtensionPlatform): string => `@mason-data/extensions-${p}`;

/** Where a package keeps the files: `<package>/extensions/<engine>/<DuckDB's platform>/<name>.duckdb_extension`, the
 *  layout DuckDB reads `extension_directory` in. */
export const extensionFile = (root: string, engine: string, platform: ExtensionPlatform, name: string): string =>
  path.join(root, "extensions", engine, EXTENSION_PLATFORMS[platform], `${name}.duckdb_extension`);

/** What this machine has: the package's extensions (`shipped`), or why not (`why`, in a developer's words). */
export type Extensions =
  | { shipped: true; package: string; version: string; directory: string; platform: ExtensionPlatform }
  | { shipped: false; package: string | null; why: string };

/** The machine as npm tells packages apart: Node's platform and arch, and on Linux whether the C library is musl. */
export interface Host { platform: string; arch: string; musl: boolean }

export function thisHost(): Host {
  // Node's own report names glibc's version where glibc runs; musl (Alpine) has none (detect-libc's first check)
  const header = process.platform === "linux" ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header : undefined;
  return { platform: process.platform, arch: process.arch, musl: process.platform === "linux" && header?.glibcVersionRuntime === undefined };
}

/** The platform's key as npm and DuckDB's bindings name it: `linux-x64`, `linux-x64-musl`, `darwin-arm64`. */
export const hostKey = (h: Host): string => `${h.platform}-${h.arch}${h.musl ? "-musl" : ""}`;

const requireHere = createRequire(import.meta.url);

/**
 * THE PACKAGE FOR THIS MACHINE, found where Node would find it from this module (the CLI's node_modules, nested or
 * hoisted; the image's /app/node_modules), holding both files for THIS engine. Reads two files' existence: no engine
 * is opened. `resolve` and `host` are a test's.
 */
export function findExtensions(o: { host?: Host; engine?: string; resolve?: (id: string) => string } = {}): Extensions {
  const host = o.host ?? thisHost();
  const engine = o.engine ?? `v${version().replace(/^v/, "")}`;
  const key = hostKey(host);
  if (!(key in EXTENSION_PLATFORMS)) {
    return { shipped: false, package: null, why: `no package of the copy's extensions is built for ${key} (only ${Object.keys(EXTENSION_PLATFORMS).join(", ")})` };
  }
  const platform = key as ExtensionPlatform;
  const name = packageName(platform);
  let manifest: string;
  try { manifest = (o.resolve ?? requireHere.resolve)(`${name}/package.json`); }
  catch (e) {
    // not installed is the one answer expected here; anything else is said as it is
    if ((e as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw e;
    return { shipped: false, package: name, why: `${name} is not installed beside Mason (npm installs it with @mason-data/cli unless optional dependencies are left out: --omit=optional)` };
  }
  const root = path.dirname(manifest);
  const pkgVersion = String((JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: unknown }).version ?? "");
  const missing = EXTENSION_NAMES.filter((n) => !fs.existsSync(extensionFile(root, engine, platform, n)));
  if (missing.length > 0) {
    const has = fs.existsSync(path.join(root, "extensions")) ? fs.readdirSync(path.join(root, "extensions")) : [];
    return { shipped: false, package: name, why: `${name} ${pkgVersion} holds no ${missing.join(" or ")} for the engine Mason runs (${engine}; it holds ${has.length ? has.join(", ") : "none"}): ` +
      "install @mason-data/cli again, whose packages are released together" };
  }
  return { shipped: true, package: name, version: pkgVersion, directory: path.join(root, "extensions"), platform };
}

/** The instance's settings for what was found: with the package, its folder and no download, ever; without, DuckDB's
 *  defaults (the first copy installs into ~/.duckdb/extensions). */
export function extensionSettings(x: Extensions): Record<string, string> {
  return x.shipped ? { extension_directory: x.directory, autoinstall_known_extensions: "false", autoload_known_extensions: "true" } : {};
}

/** The statement the copy loads its postgres extension with: from the package, a LOAD; without one, DuckDB's INSTALL
 *  first (a download, once a machine). */
export const loadPostgresSql = (x: Extensions): string => x.shipped ? "LOAD postgres" : "INSTALL postgres; LOAD postgres;";

/** What a copy that could not load the postgres extension says (src/duck/sync.ts attach), with the way out. */
export function extensionFailure(x: Extensions, error: string): string {
  return x.shipped
    ? `Mason could not load the copy's postgres extension from ${x.package} ${x.version} (${x.directory}): ${error}. Install @mason-data/cli again; mason doctor checks it`
    : `Mason could not load the copy's postgres extension: ${error}. ${x.why}, so the first copy on a machine downloads it ` +
      "(then ~/.duckdb/extensions): connect to the internet once, and the copy is tried again at the next pass";
}

/** What `probeExtensions` found: `ok` null when it could not tell. */
export interface ExtensionProbe { ok: boolean | null; detail: string }

/**
 * THE PROBE `mason doctor` SAYS (the contract answers a probe, never a file's existence): with the package, both
 * extensions LOADED by an instance of their own with the run's settings — the signature and the platform checked as
 * the run's will be; without one, whether DuckDB has them installed in ~/.duckdb/extensions already, and `ok` null when
 * it has not (the first copy will download them: fine online, which no probe can tell). Downloads nothing.
 */
export async function probeExtensions(x: Extensions = findExtensions()): Promise<ExtensionProbe> {
  let instance: DuckDBInstance;
  try { instance = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", ...extensionSettings(x) }); }
  catch (e) { return { ok: null, detail: `could not open an engine to check them: ${(e as Error).message}` }; }
  try {
    const c = await instance.connect();
    try {
      if (x.shipped) {
        for (const n of EXTENSION_NAMES) {
          try { await c.run(`LOAD ${n}`); }
          catch (e) { return { ok: false, detail: `${x.package} ${x.version} is installed, and its ${n} does not load: ${(e as Error).message.split("\n")[0]}. Install @mason-data/cli again` }; }
        }
        return { ok: true, detail: `postgres and inet ship with Mason (${x.package} ${x.version}): nothing is downloaded` };
      }
      const rows = (await c.runAndReadAll(`SELECT extension_name, installed FROM duckdb_extensions() WHERE extension_name IN (${EXTENSION_NAMES.map((n) => `'${n}'`).join(", ")})`)).getRowObjects();
      const absent = EXTENSION_NAMES.filter((n) => !rows.some((r) => r.extension_name === n && r.installed === true)).map((n) => n.replace("_scanner", ""));
      if (absent.length === 0) return { ok: true, detail: `postgres and inet were downloaded on this machine before (~/.duckdb/extensions), not shipped: ${x.why}` };
      // not a failure: online, the first copy downloads them; whether this machine will be online then, no probe can tell
      return { ok: null, detail: `${absent.join(" and ")} not on this machine yet, so the first copy downloads them and needs the internet once: ${x.why}` };
    } finally { c.closeSync(); }
  } finally { instance.closeSync(); }
}
