/**
 * THE NODE VERSIONS THE REPOSITORY NAMES, held to their authorities (issue 67). Three facts, each read in one place:
 * - the FLOOR the package needs: NODE_MIN in src/cli/doctor.ts (the caller passes it);
 * - CI's major: `ciFacts(ci.yml).nodeMajor` in scripts/gate.ts, the one reader of ci.yml's `node-version`;
 * - the majors whose V8 aborts a process now and then: NODE_WITHOUT_THE_FIX below, the one list.
 * tests/conventions.test.ts holds every workflow and the image to them; tests/cli-doctor.test.ts holds the READMEs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { CI_FILE, ciFacts } from "../scripts/gate.ts";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/**
 * THE NODE CI RUNS ON (docs/DESIGN.md "The Node CI runs on", 2026-10-30): never Node 24. Its V8 (13.6) shares
 * WebAssembly import wrappers across every isolate of a process and can free one twice when an instance dies on one
 * thread while another thread's wasm calls out (`# Check failed: jit_page_->allocations_.erase(addr) == 1`,
 * nodejs/node#66366, fixed in V8 by 9b8ca54d5a and not released in any Node 24). The catalog, the parser and the
 * function worker each hold WebAssembly on a thread of their own, so a test file's process died of it at exit after
 * every test passed (five CI runs in two days). Node 26 carries the fix; a `node-version` of 24 in any workflow brings
 * the crash back for every process CI starts. Lift this when a Node 24 release carries nodejs/node#66376.
 */
export const NODE_WITHOUT_THE_FIX: ReadonlySet<number> = new Set([24]);

/** CI's Node major, as scripts/gate.ts reads it from .github/workflows/ci.yml (never a literal here). */
export function ciNodeMajor(root: string = ROOT): string {
  return ciFacts(fs.readFileSync(path.join(root, CI_FILE), "utf8")).nodeMajor;
}

/** A Dockerfile's instructions, each with the line it starts on: comments dropped, `\` continuations joined. */
function dockerInstructions(src: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let open: { line: number; text: string } | null = null;
  src.split("\n").forEach((raw, i) => {
    // a `#` that starts a line is a comment, inside a continuation too (Docker drops it there as well)
    if (/^\s*#/.test(raw)) return;
    const continued = /\\\s*$/.test(raw);
    const part = continued ? raw.replace(/\\\s*$/, "") : raw;
    if (open === null) open = { line: i + 1, text: part };
    else open.text += ` ${part}`;
    if (!continued) { if (open.text.trim() !== "") out.push(open); open = null; }
  });
  if (open !== null && (open as { text: string }).text.trim() !== "") out.push(open);
  return out;
}

/**
 * Every `FROM` of a Node image in a Dockerfile against CI's major: a problem for each whose major is not CI's, and for
 * each that names no major at all (`node:slim`, `node:lts-slim`, `node:current`, `node`, an `ARG` in the tag or the
 * image's name): "cannot tell" is never a pass. Instructions are case-insensitive; `--platform=` and other flags, an
 * `AS <stage>` and an `@sha256:` digest may appear. A stage of another image (`debian:bookworm-slim`) is not a Node.
 */
export function imageNodeProblems(file: string, src: string, ciMajor: string): { nodeFroms: number; problems: string[] } {
  let nodeFroms = 0;
  const problems: string[] = [];
  const wayOut = `set it to FROM node:${ciMajor}-slim, or change ${CI_FILE}'s node-version and the image together (docs/DESIGN.md "The Node CI runs on")`;
  for (const { line, text } of dockerInstructions(src)) {
    const m = /^\s*FROM\s+(.*)$/i.exec(text);
    if (m === null) continue;
    const image = (m[1] ?? "").trim().split(/\s+/).find((w) => !w.startsWith("--")) ?? "";
    const ref = image.split("@")[0] ?? "";
    const slash = ref.lastIndexOf("/");
    const colon = ref.indexOf(":", slash + 1);
    const name = colon === -1 ? ref : ref.slice(0, colon);
    const tag = colon === -1 ? "" : ref.slice(colon + 1);
    const where = `${file}:${line} FROM ${image}`;
    if (name.includes("$")) { nodeFroms++; problems.push(`${where}: the image's name is a variable, so which Node it runs cannot be told; ${wayOut}`); continue; }
    if (!/^(?:(?:[^/]+\/)?library\/)?node$/.test(name)) continue;
    nodeFroms++;
    const major = tag.includes("$") ? undefined : /^v?(\d+)(?=$|[.-])/.exec(tag)?.[1];
    if (major === undefined) problems.push(`${where}: the tag names no Node major, so which Node it runs cannot be told; ${wayOut}`);
    else if (major !== ciMajor) problems.push(`${where}: the image runs Node ${major} and CI runs Node ${ciMajor}; ${wayOut}`);
  }
  return { nodeFroms, problems };
}

/**
 * Every `Node <n>` a document names, against the authorities: the floor (`Node <n>+`, `Node <n> or later`) is only ever
 * NODE_MIN, and any other `Node <n>` is NODE_MIN, CI's major or a major in NODE_WITHOUT_THE_FIX. A version no authority
 * holds (a Node 25 nobody measured) is a problem, as is a floor written as anything but NODE_MIN (`Node 26+`).
 */
export function docNodeProblems(file: string, src: string, floor: string, ciMajor: string): { floorMentions: number; problems: string[] } {
  const allowed = new Set([floor, ciMajor, ...[...NODE_WITHOUT_THE_FIX].map(String)]);
  let floorMentions = 0;
  const problems: string[] = [];
  for (const m of src.matchAll(/\bNode (\d+(?:\.\d+)*)(\+| or later)?/g)) {
    const version = m[1] ?? "";
    const where = `${file}:${src.slice(0, m.index).split("\n").length} "${m[0]}"`;
    if (version === floor) floorMentions++;
    if (m[2] !== undefined && version !== floor) problems.push(`${where}: a floor is NODE_MIN (${floor}, src/cli/doctor.ts)`);
    else if (!allowed.has(version)) problems.push(`${where}: names a Node no authority holds (the floor ${floor}, CI's ${ciMajor}, or one without the fix: ${[...NODE_WITHOUT_THE_FIX].join(", ")})`);
  }
  return { floorMentions, problems };
}
