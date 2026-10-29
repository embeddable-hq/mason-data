#!/usr/bin/env node
/**
 * BUILDS THE PLATFORM PACKAGES `@mason-data/extensions-<platform>` (src/duck/extensions.ts says why they exist): for
 * each platform, the copy's two extensions fetched from DuckDB's extension repository for the engine the CLI pins,
 * each file held to the sha256 and size cli/extensions.json pins — a file that differs fails the build and nothing is
 * written — and laid out as DuckDB reads an `extension_directory`, beside a package.json whose `os` / `cpu` / `libc`
 * make npm install it on that platform alone, at @mason-data/cli's version. DuckDB checks each file's signature again
 * when the run loads it.
 *
 *   node cli/extensions.ts                         every platform, each into cli/platforms/<platform>/ (npm publish there)
 *   node cli/extensions.ts linux-x64 darwin-arm64  those
 *   node cli/extensions.ts --node-modules <dir>    this machine's, installed as <dir>/@mason-data/extensions-<platform>
 *                                                  (the image; a checkout: --node-modules node_modules)
 *   node cli/extensions.ts --pin                   a new engine (the CLI's @duckdb/node-api moved): every platform's
 *                                                  files fetched and their checksums written to cli/extensions.json,
 *                                                  whose diff is read and committed
 *
 * A file already in place with its pinned checksum is not fetched again (CI caches cli/platforms/).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { version } from "@duckdb/node-api";
import { EXTENSION_NAMES, EXTENSION_PLATFORMS, extensionFile, hostKey, packageName, thisHost, type ExtensionPlatform } from "../src/duck/extensions.ts";

const CLI = path.dirname(fileURLToPath(import.meta.url));

export interface Pinned { sha256: string; bytes: number }
export interface Manifest { engine: string; repository: string; files: Record<string, Record<string, Pinned>> }

export const readManifest = (file = path.join(CLI, "extensions.json")): Manifest => JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;

const sha256 = (b: Buffer): string => crypto.createHash("sha256").update(b).digest("hex");

/** The repository's URL of one file, gzipped: `<repository>/<engine>/<DuckDB's platform>/<name>.duckdb_extension.gz`. */
export const fileUrl = (m: Pick<Manifest, "engine" | "repository">, p: ExtensionPlatform, name: string): string =>
  `${m.repository}/${m.engine}/${EXTENSION_PLATFORMS[p]}/${name}.duckdb_extension.gz`;

async function httpFetch(url: string): Promise<Buffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** One file, fetched, unzipped and held to its pin; throws naming the file and both checksums when it differs. */
async function fetchPinned(m: Manifest, p: ExtensionPlatform, name: string, fetchGz: (url: string) => Promise<Buffer>): Promise<Buffer> {
  const pin = m.files[p]?.[name];
  if (pin === undefined) throw new Error(`cli/extensions.json pins no ${name} for ${p}: run node cli/extensions.ts --pin`);
  const url = fileUrl(m, p, name);
  const bytes = zlib.gunzipSync(await fetchGz(url));
  const got = sha256(bytes);
  if (got !== pin.sha256 || bytes.length !== pin.bytes) {
    throw new Error(`${url} is not the file cli/extensions.json pins: sha256 ${got} (${bytes.length} bytes), pinned ${pin.sha256} (${pin.bytes} bytes). ` +
      "Nothing was written. If DuckDB republished it for the same engine, read why before running node cli/extensions.ts --pin");
  }
  return bytes;
}

/** The package's manifest: its name, the CLI's version, the platform npm installs it on, and what it holds. */
export function packageJson(m: Manifest, p: ExtensionPlatform, cliVersion: string): Record<string, unknown> {
  const [os, cpu] = p.split("-") as [string, string];
  return {
    name: packageName(p),
    version: cliVersion,
    description: `The copy's postgres and inet extensions for @mason-data/cli on ${p} (engine ${m.engine}), so Mason downloads nothing after npm install`,
    homepage: "https://masondata.ai",
    // built by this script; the package's own folder is cli/platforms/<platform>/, which is not committed
    repository: { type: "git", url: "git+https://github.com/embeddable-hq/mason-data.git", directory: `cli/platforms/${p}` },
    // the extensions' own (MIT), and what postgres_scanner links: libpq (PostgreSQL) and OpenSSL (Apache-2.0)
    license: "MIT AND PostgreSQL AND Apache-2.0",
    os: [os],
    cpu: [cpu],
    ...(os === "linux" ? { libc: ["glibc"] } : {}),
    files: ["extensions", "LICENSE", "README.md"],
    mason: { engine: m.engine, platform: EXTENSION_PLATFORMS[p], files: m.files[p] },
  };
}

const readme = (m: Manifest, p: ExtensionPlatform): string =>
  `# ${packageName(p)}\n\nThe copy's extensions for [@mason-data/cli](https://www.npmjs.com/package/@mason-data/cli) on ${p}: the ` +
  `\`postgres\` and \`inet\` extensions of the engine Mason runs, ${m.engine} (${EXTENSION_PLATFORMS[p]}), unchanged, as their authors ` +
  "publish them. You do not install this package yourself: npm installs it with `@mason-data/cli` on this platform, and Mason loads the " +
  "extensions from it, so nothing is downloaded after `npm install`. `mason doctor` says whether it found them.\n\nLICENSE says whose they are, and their licences.\n";

/**
 * ONE PLATFORM'S PACKAGE at `dir`, written whole or not at all: built in a folder beside it and renamed into place.
 * A file already at `dir`, or in a package at one of `reuse`, whose checksum is the pin's is kept rather than fetched.
 * `fetchGz` is a test's.
 */
export async function buildPackage(o: { manifest: Manifest; platform: ExtensionPlatform; cliVersion: string; dir: string; reuse?: string[]; fetchGz?: (url: string) => Promise<Buffer> }): Promise<void> {
  const { manifest: m, platform: p, dir } = o;
  const tmp = `${dir}.building-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const name of EXTENSION_NAMES) {
      const pin = m.files[p]?.[name];
      const kept = [dir, ...(o.reuse ?? [])].map((d) => extensionFile(d, m.engine, p, name))
        .find((f) => pin !== undefined && fs.existsSync(f) && fs.statSync(f).size === pin.bytes && sha256(fs.readFileSync(f)) === pin.sha256);
      const bytes = kept !== undefined ? fs.readFileSync(kept) : await fetchPinned(m, p, name, o.fetchGz ?? httpFetch);
      const to = extensionFile(tmp, m.engine, p, name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, bytes);
    }
    fs.writeFileSync(path.join(tmp, "package.json"), `${JSON.stringify(packageJson(m, p, o.cliVersion), null, 2)}\n`);
    fs.writeFileSync(path.join(tmp, "README.md"), readme(m, p));
    fs.copyFileSync(path.join(CLI, "extensions-LICENSE"), path.join(tmp, "LICENSE"));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.renameSync(tmp, dir);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** The engine the CLI runs (its pinned @duckdb/node-api) is the one the manifest pins, or the packages would hold
 *  extensions it cannot load. */
export function engineProblem(m: Manifest, engine = `v${version().replace(/^v/, "")}`): string | null {
  return m.engine === engine ? null : `cli/extensions.json pins the extensions of engine ${m.engine}, and @duckdb/node-api runs ${engine}: run node cli/extensions.ts --pin, and read the diff`;
}

async function pin(m: Manifest, engine: string): Promise<void> {
  const files: Manifest["files"] = {};
  for (const p of Object.keys(EXTENSION_PLATFORMS) as ExtensionPlatform[]) {
    files[p] = {};
    for (const name of EXTENSION_NAMES) {
      const bytes = zlib.gunzipSync(await httpFetch(fileUrl({ ...m, engine }, p, name)));
      files[p][name] = { sha256: sha256(bytes), bytes: bytes.length };
      console.log(`${p} ${name}: ${bytes.length} bytes, sha256 ${files[p][name].sha256}`);
    }
  }
  const out = path.join(CLI, "extensions.json");
  fs.writeFileSync(out, `${JSON.stringify({ engine, repository: m.repository, files }, null, 2)}\n`);
  console.log(`pinned ${engine} in ${out}: read the diff before committing it`);
}

async function main(argv: string[]): Promise<void> {
  const m = readManifest();
  const engine = `v${version().replace(/^v/, "")}`;
  if (argv.includes("--pin")) return pin(m, engine);
  const problem = engineProblem(m, engine);
  if (problem !== null) throw new Error(problem);
  const cliVersion = String((JSON.parse(fs.readFileSync(path.join(CLI, "package.json"), "utf8")) as { version: string }).version);
  const at = argv.indexOf("--node-modules");
  if (at >= 0) {
    const nodeModules = argv[at + 1];
    if (nodeModules === undefined) throw new Error("--node-modules needs the node_modules folder to install into");
    const key = hostKey(thisHost());
    if (!(key in EXTENSION_PLATFORMS)) throw new Error(`no package of the copy's extensions is built for ${key} (only ${Object.keys(EXTENSION_PLATFORMS).join(", ")})`);
    const p = key as ExtensionPlatform;
    const dir = path.join(path.resolve(nodeModules), packageName(p));
    // the platform's package already built in cli/platforms/ (CI builds it first) is copied, not fetched again
    await buildPackage({ manifest: m, platform: p, cliVersion, dir, reuse: [path.join(CLI, "platforms", p)] });
    console.log(`installed ${packageName(p)} ${cliVersion} at ${dir}`);
    return;
  }
  const named = argv.filter((a) => !a.startsWith("--"));
  const unknown = named.filter((a) => !(a in EXTENSION_PLATFORMS));
  if (unknown.length > 0) throw new Error(`no such platform: ${unknown.join(", ")} (the platforms: ${Object.keys(EXTENSION_PLATFORMS).join(", ")})`);
  for (const p of (named.length ? named : Object.keys(EXTENSION_PLATFORMS)) as ExtensionPlatform[]) {
    const dir = path.join(CLI, "platforms", p);
    await buildPackage({ manifest: m, platform: p, cliVersion, dir });
    console.log(`built ${packageName(p)} ${cliVersion} in ${path.relative(process.cwd(), dir) || "."}`);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
