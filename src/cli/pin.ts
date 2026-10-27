/**
 * THE PROJECT'S VERSION PIN, as the mason command holds it (src/lib/project-version.ts has the rule and the image's
 * side): `mason init` writes `mason.yml` with this command's version, `mason start` writes it into a project made
 * before there was one, and `mason init` and `mason start` refuse a command of another release line — what the
 * developer runs is then what production's image is held to.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseVersion, pinFileText, pinProblem, readPin, versionText, PIN_FILE } from "../lib/project-version.ts";

/** Why this mason command may not run the project in `folder`, or null (a checkout's `dev` checks nothing). */
export function cliPinProblem(folder: string, cliVersion: string): string | null {
  const running = parseVersion(cliVersion);
  if (running === null) return null;
  const read = readPin(folder);
  if ("problem" in read) return read.problem;
  if (read.pin === null) return null;
  const p = versionText(read.pin);
  return pinProblem(read.pin, running, read.file, "this mason command", `Run the mason command it names: npm i -g @mason-data/cli@${p} (or npx @mason-data/cli@${p} …).`);
}

/**
 * Write `folder`'s mason.yml with this command's version when it has none; the file written, or null when there was one
 * already (or this is a checkout's `dev`, which has no version to write).
 */
export function ensurePin(folder: string, cliVersion: string): string | null {
  if (parseVersion(cliVersion) === null) return null;
  const file = path.join(folder, PIN_FILE);
  if (fs.existsSync(file)) return null;
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(file, pinFileText(cliVersion));
  return file;
}
