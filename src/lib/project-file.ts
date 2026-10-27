/**
 * A PROJECT'S `mason.yml` (issue #435): beside its `sources/`, what holds for the whole project — today one key:
 *
 *   version: 0.6.0                       the Mason version it is written for (src/lib/project-version.ts)
 *
 * Read here, once, by everything that needs it — the image's pin check and the CLI's — so the two cannot read it
 * differently. A key it does not know is refused by name, never ignored. (`timezones:`, `calendar:` and `scope:` — the
 * zones a screen offered, its weeks and named periods, a token's tenant through a join — went with the files an older
 * Mason wrote per table: the run reads none of them.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";
import { didYouMean } from "./did-you-mean.ts";

export const PROJECT_FILE = "mason.yml";

export interface Version { major: number; minor: number; patch: number }

/** `0.5.1` or `v0.5.1` (the image's MASON_VERSION); null for anything else (`dev`, `main-<sha>`). */
export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

export interface ProjectSettings {
  /** the version the project is written for; null when the file names none (no mason.yml at all) */
  pin: Version | null;
  file: string;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The project's settings, or the problem with its mason.yml (a project with none has none of them). */
export function readProjectSettings(project: string): ProjectSettings | { problem: string; file: string } {
  const file = path.join(project, PROJECT_FILE);
  if (!fs.existsSync(file)) return { pin: null, file };
  const fail = (problem: string): { problem: string; file: string } => ({ problem: `${file}: ${problem}`, file });
  let doc: unknown;
  try { doc = parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return fail(`is not YAML: ${(e as Error).message.split("\n")[0]}`); }
  const noVersion = { problem: `${file} names no version: write version: <x.y.z>, the Mason version the project is written for`, file };
  if (doc === null || doc === undefined) return noVersion;
  if (!isPlain(doc)) return fail(`write version: <x.y.z>, the Mason version the project is written for`);
  const stray = Object.keys(doc).filter((k) => k !== "version");
  if (stray.length) return fail(`unexpected key ${stray[0]}${didYouMean(stray[0]!, ["version"])} — mason.yml takes version alone (the tables are the sources file's, sources/<name>.yml)`);
  if (doc.version === undefined || doc.version === null) return noVersion;
  const pin = parseVersion(String(doc.version));
  if (pin === null) return fail(`version ${JSON.stringify(String(doc.version))} is not a version (x.y.z, e.g. 0.5.1)`);
  return { pin, file };
}
