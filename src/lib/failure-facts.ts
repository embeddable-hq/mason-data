/**
 * A FAILURE'S CODE AND ORIGIN (issue 924): what a failed sync event (src/duck/events.ts) and a request answered XX000
 * (src/duck/requests.ts) carry beside their message, so failures can be grouped, and found in the code, without reading
 * and comparing their words.
 *
 * THE CODE (`failureCode`) is ONE value, never empty: the failure's SQLSTATE when it came from Postgres (an error's own
 * `code`, or Postgres's words inside the engine's message, read by `POSTGRES_WORDS`, since the engine's postgres
 * extension passes Postgres's message on without its SQLSTATE), its errno when it came from the system (`ECONNREFUSED`,
 * `ENOSPC`: an error's own `code`, or the system's words in the message, `SYSTEM_WORDS`), the engine's error class
 * when it came from the engine (`conversion_error` for its `Conversion Error: …`), a JavaScript error's class
 * (`TypeError`), and else `unknown` — said plainly, never an empty value that a filter could match by accident.
 *
 * THE ORIGIN (`originOf`) is the first stack frame in Mason's own code, as a file and a line ONLY
 * (`src/duck/sync.ts:1234`), relative to Mason's source root, in a checkout and in the built package alike (there the
 * root is the package's `dist/`, and the file is the compiled one, its `.js` name and line). A frame outside `src/` under that root (node_modules, `node:` internals,
 * a test, any other path) is skipped; so is the frame of the error's own constructor (`new PgError`), which says where
 * errors are built, never where this one was, and a frame of the engine's thread bridge (`BRIDGES`), whose rejection
 * carries the caller's frames (src/duck/executor.ts `call`). No Mason frame: null. It never holds an absolute path, a
 * home directory, a function's name or arguments, or any of the message (the frame's location alone is read).
 * An error wrapped by another (`cause`) is read innermost first: the wrapper says what was being done, the cause where.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** what a failure's code says when nothing tells it */
export const UNKNOWN_CODE = "unknown";

/** Mason's source root: this file is `<root>/src/lib/failure-facts.ts` in a checkout, `<root>/src/lib/failure-facts.js`
 *  under the package's `dist/` (cli/tsconfig.json: rootDir `..`) */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** frames that carry a failure from the engine's thread, never its origin: their rejection holds the caller's frames */
const BRIDGES: ReadonlySet<string> = new Set(["src/duck/executor"]);

/** an SQLSTATE: five of digits and capitals */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** a system error's code as Node names it (`ECONNREFUSED`, `ENOSPC`) */
const ERRNO = /^E[A-Z0-9]{2,}$/;

/** Postgres's own words for its common failures, as the engine passes them on (`ERROR:  relation "t" does not exist`),
 *  each with Postgres's SQLSTATE (src/backend/utils/errcodes.txt). In English: a source under another lc_messages
 *  reads as `unknown`, never a guess. */
const POSTGRES_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^relation .* does not exist/, "42P01"],
  [/^column .* does not exist/, "42703"],
  [/^schema .* does not exist/, "3F000"],
  [/^function .* does not exist/, "42883"],
  [/^permission denied/, "42501"],
  [/^canceling statement due to statement timeout/, "57014"],
  [/^canceling statement due to lock timeout/, "55P03"],
  [/^canceling statement due to user request/, "57014"],
  [/^canceling statement due to conflict with recovery/, "40001"],
  [/^terminating connection due to administrator command/, "57P01"],
  [/^terminating connection due to conflict with recovery/, "40001"],
  [/^the database system is (?:starting up|shutting down|in recovery mode)/, "57P03"],
  [/^(?:sorry, )?too many clients already|^remaining connection slots are reserved/, "53300"],
  [/^password authentication failed/, "28P01"],
  [/^no pg_hba\.conf entry/, "28000"],
  [/^role .* does not exist/, "28000"],
  [/^database .* does not exist/, "3D000"],
  [/^out of memory/, "53200"],
  [/^could not (?:resize shared memory segment|write to file).*No space left on device/, "53100"],
  [/^could not serialize access/, "40001"],
  [/^deadlock detected/, "40P01"],
  [/^invalid input syntax/, "22P02"],
  [/^replication slot .* does not exist/, "42704"],
  [/^publication .* does not exist/, "42704"],
  [/^replication slot .* is active/, "55006"],
  [/^logical decoding requires wal_level >= logical|^logical decoding requires "wal_level" >= "logical"/, "55000"],
  [/^must be superuser or replication role|^permission denied to start WAL sender|^must have REPLICATION/, "42501"],
];
/** the system's words for its errors (strerror), as a driver or the engine passes them on, each with Node's errno name */
const SYSTEM_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bConnection refused\b/, "ECONNREFUSED"],
  [/\bConnection reset by peer\b/, "ECONNRESET"],
  [/\bConnection timed out\b/, "ETIMEDOUT"],
  [/\bNo route to host\b/, "EHOSTUNREACH"],
  [/\bNetwork is unreachable\b/, "ENETUNREACH"],
  [/\bNo space left on device\b/, "ENOSPC"],
  [/\bDisk quota exceeded\b/, "EDQUOT"],
  [/\bToo many open files\b/, "EMFILE"],
  [/\bBroken pipe\b/, "EPIPE"],
  [/\bcould not translate host name\b|\bName or service not known\b|\bnodename nor servname provided\b|\bTemporary failure in name resolution\b/, "ENOTFOUND"],
];

/** the errors of a chain, innermost first (`cause`), bounded: a cycle reads each once */
function chain(e: unknown): unknown[] {
  const out: unknown[] = [];
  for (let x = e; x !== undefined && x !== null && out.length < 8 && !out.includes(x); x = (x as { cause?: unknown }).cause) {
    out.push(x);
    if (typeof x !== "object") break;
  }
  return out.reverse();
}

const own = (x: unknown, key: string): unknown => x !== null && typeof x === "object" ? (x as Record<string, unknown>)[key] : undefined;
const messageOf = (x: unknown): string => x instanceof Error ? x.message : typeof x === "string" ? x : "";

/** An error's code from its own fields: a Postgres error's SQLSTATE (`code`, `fields.code`, `sqlstate`) or a system
 *  error's errno (`code`); else null. */
function fieldCode(x: unknown): string | null {
  for (const v of [own(x, "code"), own(own(x, "fields"), "code"), own(x, "sqlstate")]) {
    if (typeof v === "string" && (SQLSTATE.test(v) || ERRNO.test(v))) return v;
  }
  return null;
}

/** Postgres's message inside the engine's (`ERROR:  …`, `FATAL:  …`), or null when Postgres's words are not there */
function postgresMessage(m: string): string | null {
  return /(?:^|[\s:"])(?:ERROR|FATAL|PANIC): {1,2}([^\n]*)/.exec(m)?.[1] ?? null;
}

/** THE FAILURE'S CODE (the header): an SQLSTATE, an errno, the engine's or JavaScript's error class, else `unknown`. */
export function failureCode(e: unknown): string {
  const errors = chain(e);
  for (const x of errors) { const c = fieldCode(x); if (c !== null) return c; }
  let fromPostgres = false;
  for (const x of errors) {
    const m = messageOf(x);
    const pg = postgresMessage(m);
    if (pg !== null) { fromPostgres = true; const hit = POSTGRES_WORDS.find(([re]) => re.test(pg)); if (hit !== undefined) return hit[1]; }
    const sys = SYSTEM_WORDS.find(([re]) => re.test(m));
    if (sys !== undefined) return sys[1];
  }
  // Postgres's failure, whose SQLSTATE these words do not tell: unknown, never the class of the engine that passed it on
  if (fromPostgres) return UNKNOWN_CODE;
  // the engine's class, as its message begins (`Conversion Error: …`), wherever a wrapper put it in the message
  for (const x of errors) {
    const kind = /(?:^|: )([A-Z][A-Za-z]*(?: [A-Za-z]+)*) Error: /.exec(messageOf(x))?.[1];
    if (kind !== undefined) return `${kind.toLowerCase().replace(/ /g, "_")}_error`;
  }
  for (const x of errors) {
    const name = own(x, "name");
    if (x instanceof Error && typeof name === "string" && name !== "Error" && /^[A-Za-z_$][\w$]{0,63}$/.test(name)) return name;
  }
  return UNKNOWN_CODE;
}

/** the constructors' names of an error's own classes (`PgError`, `Error`): a frame inside one is where errors are made */
function constructorNames(x: unknown): Set<string> {
  const names = new Set<string>();
  for (let p = x !== null && typeof x === "object" ? Object.getPrototypeOf(x) as object | null : null; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    const n = (p as { constructor?: { name?: unknown } }).constructor?.name;
    if (typeof n === "string" && n !== "") names.add(n);
  }
  return names;
}

/** a frame's location in Mason's own source (`src/duck/sync.ts:1234`), or null: outside `src/` under the root,
 *  node_modules, `node:` internals, a bridge */
function masonLocation(frame: string, skip: ReadonlySet<string>): string | null {
  const m = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):\d+\)?$/.exec(frame);
  if (m === null) return null;
  if (m[1] !== undefined && m[1].startsWith("new ") && skip.has(m[1].slice(4))) return null;
  let file = m[2]!;
  if (file.startsWith("node:") || file.startsWith("internal/")) return null;
  if (file.startsWith("file://")) { try { file = fileURLToPath(file); } catch { return null; /* not a path: no origin from it */ } }
  if (!path.isAbsolute(file)) return null;
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (!rel.startsWith("src/") || rel.includes("/node_modules/") || rel.split("/").includes("..")) return null;
  if (BRIDGES.has(rel.replace(/\.(?:ts|js)$/, ""))) return null;
  // a file of Mason's own, as it is on disk: never a name some text made up
  if (!/^[\w./-]+\.(?:ts|js|mjs|cjs)$/.test(rel) || !fs.existsSync(path.join(ROOT, rel))) return null;
  return `${rel}:${m[3]}`;
}

/** the first Mason frame of one error's stack, or null */
function stackOrigin(x: unknown): string | null {
  const stack = own(x, "stack");
  if (typeof stack !== "string") return null;
  const skip = constructorNames(x);
  // THE FRAMES ALONE: the stack begins with the message, whose text (a row, a statement) may hold a line shaped like a
  // frame, so its lines are cut off first — the whole head when the stack begins with it, else as many lines as it has
  const message = messageOf(x);
  const name = own(x, "name");
  const head = `${typeof name === "string" ? name : "Error"}${message === "" ? "" : `: ${message}`}`;
  const lines = (stack.startsWith(head) ? stack.slice(head.length) : stack.split("\n").slice(message.split("\n").length).join("\n")).split("\n");
  for (const line of lines) {
    if (!/^\s+at /.test(line)) continue;
    const at = masonLocation(line, skip);
    if (at !== null) return at;
  }
  return null;
}

/** THE FAILURE'S ORIGIN (the header): the first frame in Mason's own code, innermost error first, else null. */
export function originOf(e: unknown): string | null {
  for (const x of chain(e)) { const at = stackOrigin(x); if (at !== null) return at; }
  return null;
}

/** Where Mason is now (a failure that threw nothing, such as a gap the sync found): the first Mason frame of the
 *  caller of `above` (the function that asks, left out with every frame inside it). */
export function originHere(above: (...args: never[]) => unknown): string | null {
  const here: { stack?: string } = {};
  Error.captureStackTrace(here, above);
  return stackOrigin(here);
}
