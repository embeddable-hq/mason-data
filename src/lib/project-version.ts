/**
 * THE VERSION A PROJECT IS WRITTEN FOR (the journey from a laptop to production). A project's
 * `mason.yml`, beside its `sources/` and committed with it, names the Mason version the project was
 * written and checked with:
 *
 *   version: 0.5.1
 *
 * Before 1.0 a minor version may change the project's format with no compatibility (CLAUDE.md "No backwards
 * compatibility before v1.0"), so a project written for 0.5 and run by 0.6 would fail on whatever key moved, in words
 * that never say the versions differ. The pin turns that into one refusal that does: the image of the ClickHouse stack
 * this was cut from refused to start on a project of another minor version, or of a newer patch than itself
 * (`imagePinProblem` below), and `mason init` / `mason start` refuse a CLI that is (src/cli/pin.ts). The way out is
 * always the same pair: run the version the project names, or read the release notes and move the pin.
 *
 * A build that is no release (`dev` from a checkout, `main-<sha>` from main) checks nothing: it has no version to hold
 * a project to. A project with no `mason.yml` (made by an older `mason init`) is unpinned and runs; `mason start` writes one.
 */
import * as path from "node:path";
import { PROJECT_FILE, parseVersion, readProjectSettings, type Version } from "./project-file.ts";

export { parseVersion, type Version };
export const PIN_FILE = PROJECT_FILE;

export const versionText = (v: Version): string => `${v.major}.${v.minor}.${v.patch}`;

/** The line a project's mason.yml is: what `mason init` writes. */
export function pinFileText(version: string): string {
  return "# The Mason version this project is written for. The mason image and the mason command refuse another\n" +
    "# minor version (before 1.0 a minor version may change the project's format): to upgrade, read that release's\n" +
    "# notes, change what they say, then change this line.\n" +
    `version: ${version}\n`;
}

/** The project's pin: its version, null when it has no mason.yml, or the problem with the file (src/lib/project-file.ts
 *  reads it whole: a key it does not know is a problem here too). */
export function readPin(project: string): { pin: Version | null; file: string } | { problem: string; file: string } {
  const read = readProjectSettings(project);
  return "problem" in read ? read : { pin: read.pin, file: read.file };
}

/** Same release line: before 1.0 the minor version, from 1.0 the major. */
export function sameLine(a: Version, b: Version): boolean {
  return a.major === b.major && (a.major > 0 || a.minor === b.minor);
}

const older = (a: Version, b: Version): boolean =>
  a.major !== b.major ? a.major < b.major : a.minor !== b.minor ? a.minor < b.minor : a.patch < b.patch;

/**
 * Why `running` (what reads the project: the image, or the CLI) may not run a project pinned to `pin`, or null.
 * Allowed: the same release line, at the pin's patch or later. `what` names the reader in the message ("the mason
 * image", "this mason command"); `run` says how to run the pinned version instead.
 */
export function pinProblem(pin: Version, running: Version, file: string, what: string, run: string): string | null {
  if (sameLine(pin, running) && !older(running, pin)) return null;
  const p = versionText(pin), r = versionText(running);
  if (sameLine(pin, running)) {
    return `${file} pins Mason ${p}, and ${what} is ${r}, older than it: the project may use a fix or a key ${r} does not have. ${run}`;
  }
  const line = pin.major > 0 ? `${pin.major}.x` : `${pin.major}.${pin.minor}.x`;
  return older(running, pin)
    ? `${file} pins Mason ${p}, and ${what} is ${r}: the project is written for a newer Mason. ${run}`
    : `${file} pins Mason ${p}, and ${what} is ${r}, a newer release line than ${line}, which may read the project differently. ` +
      `${run} Or upgrade the project: read the release notes of every version after ${p} up to ${r} (their "Before you upgrade"), ` +
      `change what they say, then set version: ${r} in ${path.basename(file)}.`;
}

/**
 * The image's check, as the ClickHouse stack's service ran it at its start: the project's pin against the image's
 * MASON_VERSION, or null.
 * An image that is no release (`dev`, `main-<sha>`) holds no project to a version.
 */
export function imagePinProblem(project: string, imageVersion: string | undefined): string | null {
  const running = parseVersion(imageVersion ?? "");
  if (running === null) return null;
  const read = readPin(project);
  if ("problem" in read) return read.problem;
  if (read.pin === null) return null;
  const p = versionText(read.pin);
  return pinProblem(read.pin, running, read.file, "this mason image", `Run the image the project names (ghcr.io/embeddable-hq/mason-data:${p}).`);
}
