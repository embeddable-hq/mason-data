/**
 * THE COMMAND × STATE MATRIX (item 3 of a retrospective): every `mason`
 * command, run as a real process in every state a project can be in, answers in the failure shape or succeeds — never a
 * stack, never a hang, never prose under --json. Four bugs of two days were a command meeting a state nobody had run it in
 * (`mason query` before the service existed printed a stack; an empty folder reused an older project; …), each found by a
 * person. This is where they are found first.
 *
 * The states a run is not needed for are tests/cli-state-matrix.test.ts's (offline, in npm test); the states with a run
 * up are a run against a real Postgres (no integration test yet). Both use this module, so the
 * assertions are one.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../src/cli/registry.ts";
import { FAILURE_CODES } from "../src/cli/command.ts";

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "main.ts");

/**
 * A command line for each command that leaves the project as it found it, or changes it only as that state allows (a
 * table that does not exist, a wait of a second). EVERY command is here: a new one fails tests/cli-state-matrix.test.ts
 * until it has a line, so it is run in every state by construction.
 */
export const MATRIX_ARGS: Readonly<Record<string, readonly string[]>> = {
  help: [],
  doctor: [],
  init: [],
  start: [],
  tables: ["no_such_table"],
  // with a sync, so the flag is read in every state too (a bad one is a usage error before any state is met)
  add: ["no_such_table", "--sync", "poll 30s"],
  remove: ["no_such_table"],
  wait: ["--timeout", "1"],
  user: ["list"],
  // no URL: refused in every state, with the way out (stdin is closed, so a server would end at once)
  mcp: [],
  // needs a run: below one it answers the state's code, and with no tunnel started
  share: [],
  status: [],
  // never a browser: in a state with no run it is refused before; --no-open whatever happens
  ui: ["--no-open"],
  sync: ["no_such_table"],
  logs: [],
  // a session that is not open: refused by name in every state with a run, and by the state without one
  cancel: ["99999"],
  usage: [],
  stop: [],
  destroy: [],
  serve: [],
};

/**
 * MORE LINES of a command whose modes answer from different places (review: `user disable|enable` and `logs --events|
 * --running|--requests` ran only against a fake run): each run in every state too, with --json alone (the person's
 * form of each is its command's line above; a line a state runs is a process, and the matrix is the suite's slowest).
 */
export const MATRIX_MORE: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  user: [["disable", "no_such_user"], ["enable", "no_such_user"]],
  logs: [["--events"], ["--running"], ["--requests"]],
};

/** Further lines a command is run with in every state, beside MATRIX_ARGS's (a flag of its own that must refuse
 *  before it writes: `--role` names a role the roles file lacks, so no user is ever added). */
export const MATRIX_EXTRA_ARGS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  user: [["add", "nobody", "--role", "no_such_role"]],
};

/** The commands a state may not run in the matrix because they CHANGE it: they are the session's transitions. */
export const TRANSITIONS: ReadonlySet<string> = new Set(["start", "stop"]);

export interface Answer { argv: string[]; code: number | null; signal: string | null; stdout: string; stderr: string; ms: number }

/**
 * The environment a matrix command runs in: the caller's, with every setting that would point it elsewhere taken out —
 * and MASON_DEBUG=1, so an uncaught exception prints its stack and STACK sees it (review of #434: main.ts folds a crash
 * into an ordinary `failed`, which a state that meets the command's need accepted).
 */
export function matrixEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^(PG|CLICKHOUSE_|MASON_|DATABASE_URL$|FORCE_COLOR$|NO_COLOR$|IT_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, MASON_DEBUG: "1", ...extra };
}

/** One `mason` command as a process: its exit, its two streams, how long it took. Killed after `timeoutMs`. */
export function runMason(cwd: string, argv: string[], env: Record<string, string>, timeoutMs = 60_000, main = MAIN): Promise<Answer> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [main, ...argv], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ argv, code, signal, stdout, stderr, ms: Date.now() - t0 }); });
  });
}

const STACK = /^\s+at .+:\d+:\d+\)?$|^(\w*Error|TypeError|SyntaxError|RangeError)(\s\[\w+\])?: |node:internal\//m;

/**
 * What is wrong with one answer, as sentences (none when it is right). `json`: the command was asked for --json.
 * `codes`: the failure codes this state may answer with (an empty list: any of FAILURE_CODES).
 */
export function answerProblems(cmd: string, a: Answer, json: boolean, codes: readonly string[] = []): string[] {
  const p: string[] = [];
  const line = `mason ${a.argv.join(" ")}`;
  if (a.signal) return [`${line}: killed (${a.signal}) after ${a.ms} ms — it hung`];
  if (a.code === null || ![0, 1, 2, 124].includes(a.code)) p.push(`${line}: exit ${a.code}, not 0, 1, 2 or 124`);
  // mason logs prints the service's log, whose lines may carry a child's error: its own stack would be on stderr
  if ((cmd !== "logs" && STACK.test(a.stdout)) || STACK.test(a.stderr)) p.push(`${line}: printed a stack or an uncaught error:\n${(a.stderr || a.stdout).slice(0, 600)}`);
  if (json) {
    let v: unknown;
    try { v = JSON.parse(a.stdout); }
    catch { p.push(`${line}: stdout is not one JSON object:\n${a.stdout.slice(0, 400)}${a.stderr ? `\n(stderr: ${a.stderr.slice(0, 300)})` : ""}`); return p; }
    if (typeof v !== "object" || v === null || Array.isArray(v)) { p.push(`${line}: stdout is JSON but not an object`); return p; }
    const o = v as Record<string, unknown>;
    if (!Array.isArray(o.next)) p.push(`${line}: no "next" list`);
    else for (const n of o.next as unknown[]) {
      const s = n as Record<string, unknown>;
      if (typeof s?.command !== "string" || typeof s?.what !== "string") { p.push(`${line}: a next step is not { command, what }: ${JSON.stringify(n)}`); break; }
    }
    const spec = COMMANDS.find((c) => c.name === cmd);
    // a failure is { error, next } whatever the command; an answer is what its help declares
    const failure = a.code !== 0 && "error" in o && !VERDICTS.has(cmd);
    // (a command that did part of its work keeps its own keys beside error: mason add's tables, mason wait's state)
    const declared = failure ? [...new Set([...(spec?.json ?? []), "error", "next"])] : spec?.json ?? [];
    for (const k of Object.keys(o)) if (!declared.includes(k)) p.push(`${line}: key ${k} is not one its ${failure ? "failure" : "help"} declares (${declared.join(", ")})`);
    if (a.code !== 0 && !VERDICTS.has(cmd)) {
      const e = o.error as Record<string, unknown> | undefined;
      // a crash is never an answer, whatever its code: main.ts's catch-all says it is a bug
      if (typeof e?.fix === "string" && /a bug in mason/.test(e.fix)) p.push(`${line}: crashed (main.ts's catch-all): ${String(e.message)}`);
      if (!e || typeof e.message !== "string" || typeof e.code !== "string") p.push(`${line}: exit ${a.code} without { error: { code, message } }:\n${a.stdout.slice(0, 400)}`);
      else if (!Object.hasOwn(FAILURE_CODES, e.code) && cmd !== "query") p.push(`${line}: error code ${e.code} is not one of FAILURE_CODES`);
      else if (codes.length && !codes.includes(e.code)) p.push(`${line}: error code ${e.code}, where this state answers ${codes.join(" or ")}: ${e.message}`);
    }
  } else if (a.code !== 0 && !VERDICTS.has(cmd)) {
    // the failure's head is a line of its own; progress drawn on stderr before it is a command's right (mason wait's bars,
    // found in CI: a wait that timed out during the loop's own apply)
    // the failure shape (src/cli/command.ts failureText): the checklist's mark, then `mason <cmd>: <what is wrong>`
    if (!a.stderr.split("\n").some((l) => l.startsWith(`✗ mason ${cmd}: `))) {
      p.push(`${line}: exit ${a.code}, and stderr has no "mason ${cmd}: …" line (the failure shape):\n${(a.stderr || a.stdout || "(nothing at all)").slice(0, 600)}`);
    }
    if (codes.length) {
      // the human form carries no code: the state's words are checked by the JSON form beside it
    }
  }
  return p;
}

/**
 * The commands whose answer IS a verdict, exit 1 meaning "no" (mason doctor: not ready, with every check and the way out,
 * in its own declared shape), as `test` answers. Every other exit 1 is a failure, in the failure shape.
 */
export const VERDICTS: ReadonlySet<string> = new Set(["doctor"]);

/** The commands that take --json (every one but help and types). */
export const takesJson = (cmd: string): boolean => Object.hasOwn(COMMANDS.find((c) => c.name === cmd)?.options ?? {}, "json");
