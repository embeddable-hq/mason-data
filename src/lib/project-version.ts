/**
 * THE VERSION A PROJECT IS WRITTEN FOR (the journey from a laptop to production). A project's
 * `mason.yml`, beside its `sources/` and committed with it, names the Mason version the project was
 * written and checked with:
 *
 *   version: 0.5.1
 *
 * Before 1.0 a minor version may change the project's format with no compatibility (CLAUDE.md "No backwards
 * compatibility before v1.0"), so a project written for 0.5 and run by 0.6 would fail on whatever key moved, in words
 * that never say the versions differ. The pin turns that into one refusal that does: the image refuses to start on a
 * project of another release line, or of a newer patch than itself (`imagePinProblem` below, `mason serve`'s check,
 * src/cli/serve.ts), and `mason init` / `mason start` refuse a CLI that is (src/cli/pin.ts). ONE rule (`pinProblem`), in
 * each reader's words. The way out is always the same pair: run the version the project names, or read the release notes
 * and move the pin.
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

/** Why a project may not run: what is wrong, and the way out; null way out when the file itself is the problem, which
 *  says what to write. A person's `mason start` says them as one line, `mason serve` as a Failure's message and fix. */
export interface PinRefusal { problem: string; wayOut: string | null }

/** What reads the project: `what` names it in the message ("this mason image", "this mason command"), `run` says how to
 *  run the pinned version instead. */
export interface PinReader { what: string; run: (pinned: string) => string }

/**
 * Why `running` (what reads the project: the image, or the CLI) may not run a project pinned to `pin`, or null.
 * Allowed: the same release line, at the pin's patch or later.
 */
function pinProblem(pin: Version, running: Version, file: string, reader: PinReader): PinRefusal | null {
  if (sameLine(pin, running) && !older(running, pin)) return null;
  const p = versionText(pin), r = versionText(running), { what } = reader, run = reader.run(p);
  if (sameLine(pin, running)) {
    return { problem: `${file} pins Mason ${p}, and ${what} is ${r}, older than it: the project may use a fix or a key ${r} does not have`, wayOut: run };
  }
  const line = pin.major > 0 ? `${pin.major}.x` : `${pin.major}.${pin.minor}.x`;
  return older(running, pin)
    ? { problem: `${file} pins Mason ${p}, and ${what} is ${r}: the project is written for a newer Mason`, wayOut: run }
    : { problem: `${file} pins Mason ${p}, and ${what} is ${r}, a newer release line than ${line}, which may read the project differently`,
        wayOut: `${run} Or upgrade the project: read the release notes of every version after ${p} up to ${r} (their "Before you upgrade"), ` +
          `change what they say, then set version: ${r} in ${path.basename(file)}.` };
}

/**
 * THE ONE CHECK: the project's pin against the version of what reads it, or null. A build that is no release (`dev`,
 * `main-<sha>`) holds no project to a version, and reads no mason.yml.
 */
export function projectPinProblem(project: string, version: string, reader: PinReader): PinRefusal | null {
  const running = parseVersion(version);
  if (running === null) return null;
  const read = readPin(project);
  if ("problem" in read) return { problem: read.problem, wayOut: null };
  return read.pin === null ? null : pinProblem(read.pin, running, read.file, reader);
}

/** The image's check, its version what `mason serve` runs as (src/cli/version.ts): the words of someone running a container. */
export function imagePinProblem(project: string, imageVersion: string): PinRefusal | null {
  return projectPinProblem(project, imageVersion, { what: "this mason image", run: (p) => `Run the image the project names (ghcr.io/embeddable-hq/mason-data:${p}).` });
}
