/**
 * A `mason` COMMAND, DESCRIBED ONCE (every command, present and future, is and stays self-documenting, and that is
 * checked). Each command is a `CommandSpec`: its name, the one line `mason --help` lists it with, its usage
 * (what `mason <name> --help` prints), and the options its parser accepts — the SAME object the parser reads, so an
 * option cannot exist without its spec. src/cli/main.ts builds the command table and the top-level help from the
 * specs, and tests/cli-help.test.ts holds every one to the rules below, a command added later included:
 *
 *   - `mason <name> --help` and `mason help <name>` print its usage and exit 0;
 *   - the usage starts `usage: mason <name>`, and shows at least one example (an indented `mason <name> …` line);
 *   - every option the parser takes is in the usage, by its `--name` (and `-x` when it has one);
 *   - `mason --help` lists it with its summary;
 *   - a wrong option prints what is wrong, then the usage, and exits 2.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";
import { err as styleErr, out as styleOut, PLAIN, wrap, type Style } from "./style.ts";

export type Options = NonNullable<ParseArgsConfig["options"]>;

export interface CommandSpec {
  name: string;
  /** one line: what `mason --help` says the command does */
  summary: string;
  /** what `mason <name> --help` prints: `usage: mason <name> …`, what it does, an example, every option */
  usage: string;
  /** what its parser accepts (`--help` / `-h` is added to every command) */
  options: Options;
  /** the top-level keys of its --json answer, `next` included (jsonText holds the command to them, tests/cli-help.test.ts
   *  the usage to naming each): a command with a `json` option declares them, so what a program reads is what the help says */
  json?: readonly string[];
  /** what it needs to do its work (src/cli/state.ts): a project, a run, or the service; nothing when absent. Its gate
   *  (`reach`) reads it, and tests/cli-state-matrix.test.ts holds it to the code it answers in each state below it */
  needs?: "project" | "run";
  /** "protocol": its stdout is a protocol's (`mason mcp`'s MCP frames), so it takes no --json and every failure — a
   *  wrong line, a refusal, a crash — is said on stderr, `--json` on the line or not: one JSON object on stdout would
   *  be a frame the client cannot read */
  stdout?: "protocol";
}

export interface Command extends CommandSpec { run: (argv: string[]) => Promise<number> }

const HELP: Options = { help: { type: "boolean", short: "h" } };

/**
 * A command line read by its spec: the values and positionals; or the exit code when it answered itself — 0 after
 * printing the usage for `--help`, 2 after saying what is wrong with the line, then the usage.
 */
export function parseCommand(spec: CommandSpec, argv: string[]): { values: Record<string, string | boolean | string[] | boolean[] | undefined>; positionals: string[] } | number {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: { ...spec.options, ...HELP }, allowPositionals: true }); }
  catch (e) { return failed(spec.name, { message: (e as Error).message, code: "usage", usage: spec.usage, next: [[`mason ${spec.name} --help`, "its usage, with every option"]] }, { json: wantsJson(argv, spec) }); }
  if (parsed.values.help) { process.stdout.write(spec.usage); return 0; }
  return { values: parsed.values as Record<string, string | boolean | string[] | boolean[] | undefined>, positionals: parsed.positionals };
}

/** Where a command prints: stdout for what it answers, stderr for what went wrong. A test passes its own, never
 *  replacing process.stdout — the test runner reports through it, and a swallowed report is a failure nobody sees. */
export interface Io { out: (m: string) => void; err: (m: string) => void }

/** A command to run next, and what it does (left out when the command says it). */
export type NextStep = readonly [command: string, what?: string];
/** The column a step's `what` starts in, after the two-space indent: wide enough for `mason add orders --columns …`. */
const NEXT_WIDTH = 44;
/**
 * WHAT TO RUN NEXT, in one shape for every command (some commands showed Next as one line, some without the Next
 * prefix and some as a kind of table; the table won): a blank line, `Next:`, then each command with what
 * it does in a column, after everything else a command prints — a failure's way out included (failureText). With --json the
 * same steps are the answer's `next` (nextJson). tests/conventions.test.ts refuses a `Next` or `Try` written any other way.
 */
export function nextBlock(steps: readonly NextStep[], s: Style = styleOut()): string {
  // on a terminal: `Next:` bold, each command cyan, what it does dim and wrapped under its own column (src/cli/style.ts)
  const step = ([command, what]: NextStep): string => {
    if (!what) return `  ${s.cyan(command)}`;
    const used = 2 + Math.max(command.length, NEXT_WIDTH) + 2;
    return `  ${s.cyan(command.padEnd(NEXT_WIDTH))}  ${s.dim(wrap(what, s.width, 2 + NEXT_WIDTH + 2, used))}`;
  };
  return ["", s.bold("Next:"), ...steps.map(step)].join("\n");
}

/**
 * WHAT A COMMAND DID, in one shape for every command that changes something (`mason add` said it in four sentences;
 * one format for every command is easier to scan): one line saying
 * what happened, the facts under it as aligned `label  value` rows, its tips (a line each), then what to run next.
 *
 *   Added public.orders
 *     file         mason/sources/shop.yml
 *     copy         starts now
 *
 *   Tip: …
 *
 *   Next:
 *     mason wait                                    until it is copied
 *
 * A command that lists data (tables, status, the request log) prints the data in its own layout and ends the same
 * way: endText (its tips, then nextBlock).
 */
export interface Report {
  headline: string;
  details?: ReadonlyArray<readonly [label: string, value: string]>;
  tips?: readonly string[] | undefined;
  next?: readonly NextStep[] | undefined;
}
export function reportText(r: Report, s: Style = styleOut()): string {
  const lines = [s.bold(r.headline)];
  const w = Math.max(0, ...(r.details ?? []).map(([label]) => label.length));
  for (const [label, value] of r.details ?? []) lines.push(`  ${s.dim(label.padEnd(w))}   ${wrap(value, s.width, 2 + w + 3)}`);
  return withEnd(lines.join("\n"), r, s);
}
/**
 * The end of a command's output, to print on its own (out(endText(…))): its tips, then what to run next, each part after
 * a blank line; "" when it has neither. withEnd puts it after text a command has not printed yet.
 */
export function endText(r: { tips?: readonly string[] | undefined; next?: readonly NextStep[] | undefined }, s: Style = styleOut()): string {
  const tips = r.tips?.length ? `\n${r.tips.map((t) => s.dim(`Tip: ${wrap(t, s.width, 5)}`)).join("\n")}` : "";
  const next = r.next?.length ? nextBlock(r.next, s) : "";
  return tips && next ? `${tips}\n${next}` : tips || next;
}
export function withEnd(text: string, r: { tips?: readonly string[] | undefined; next?: readonly NextStep[] | undefined }, s: Style = styleOut()): string {
  const end = endText(r, s);
  return end ? `${text}\n${end}` : text;
}
export const STDIO: Io = { out: (m) => { process.stdout.write(`${m}\n`); }, err: (m) => { process.stderr.write(`${m}\n`); } };

/** The steps as a program reads them: `[{ command, what }]`, the same list the human output prints under Next. */
export function nextJson(steps: readonly NextStep[] = []): Array<{ command: string; what?: string }> {
  return steps.map(([command, what]) => what ? { command, what } : { command });
}

/** Whether a command line asked for data: `--json` anywhere on it (read before the line is parsed, so a wrong line
 *  is answered in JSON too) — never for a command whose stdout is a protocol's (`CommandSpec.stdout`), whose every
 *  failure is said on stderr. */
export const wantsJson = (argv: readonly string[], spec?: Pick<CommandSpec, "stdout">): boolean => spec?.stdout !== "protocol" && argv.includes("--json");

/**
 * A COMMAND'S --json ANSWER (an agent wants clear, unambiguous context and a machine-readable format, and a person
 * and an agent both want the next steps): one JSON object on stdout, always with `next` — the same steps the human
 * output prints — and only the keys the command's spec declares (`CommandSpec.json`), so the help's shape and the answer
 * cannot drift: a key the spec does not name is a bug here, said as one. A list is wrapped in an object for the same
 * reason (`{ tables: […], next }`), never printed bare.
 */
export function jsonText(spec: CommandSpec, value: Record<string, unknown>, next: readonly NextStep[] = []): string {
  const declared = spec.json;
  if (declared === undefined) throw new Error(`mason ${spec.name} prints JSON, and its spec declares no json keys (src/cli/command.ts CommandSpec.json)`);
  const stray = Object.keys(value).filter((k) => !declared.includes(k));
  if (stray.length) throw new Error(`mason ${spec.name} --json: ${stray.join(", ")} ${stray.length === 1 ? "is" : "are"} not in its spec's json keys (${declared.join(", ")}): add ${stray.length === 1 ? "it" : "them"} there and to its usage`);
  if (!declared.includes("next")) throw new Error(`mason ${spec.name}: its json keys must end with next (every --json answer carries what to run next)`);
  return JSON.stringify({ ...value, next: nextJson(next) }, null, 2);
}

/**
 * THE CODES A FAILURE CARRIES, a closed set a program can branch on (`mason help agent` lists them).
 */
export const FAILURE_CODES = {
  usage: "the command line is wrong: a flag, an argument, a value (exit 2; the usage follows for a person)",
  no_project: "no Mason project here or above (mason init makes one)",
  bad_config: "this folder is a Mason project whose .mason/config.json cannot be read: repair it, or move .mason/ aside and mason init",
  bad_source: "the project's sources file (mason/sources/<name>.yml) is missing or names something wrong: the file, the key and the way out are said",
  bad_roles: "the project's roles file (mason/roles.yml) names something wrong: a table the sources file does not copy, a column the copy lacks, a role with no table; the file, the key and the way out are said",
  not_running: "Mason is not running for the project (mason start)",
  unreachable: "Mason is running but does not answer (mason logs says why)",
  not_found: "a name nothing has: a table, a column, a user",
  nothing_yet: "nothing to work on yet: no table added (the next steps say what adds one)",
  refused: "Mason refused what was asked, with the reason",
  failed: "the command tried and could not finish: the reason, and what to do",
  timeout: "ran out of time — mason wait; nothing stopped (exit 124)",
} as const;
export type FailureCode = keyof typeof FAILURE_CODES;

/**
 * ONE SHAPE FOR EVERY FAILURE (a person wants short, scannable responses; an agent wants clear, unambiguous context and
 * machine-readable formats): what is wrong, why, the way out, and what to run next —
 * each its own field, so a person reads three short lines and a program reads the same four fields.
 *
 *   mason add: there is no table "ordrs" this user can read          ← message (what is wrong), red
 *     why   the database has orders, customers, …                    ← why, when the message does not make it plain
 *     fix   name it as mason tables lists it                         ← fix, the way out in words
 *
 *   Next:
 *     mason tables          the database's tables                    ← next, the commands to run
 *
 * With --json: {"error": {"code", "message", "why", "fix"}, "next": [{command, what}]} on stdout (`next` at the top, where
 * every --json answer has it), the exit code unchanged.
 * An error never shows a stack (CLAUDE.md: a message that needs one is a bug); MASON_DEBUG=1 adds it for a bug report.
 */
export interface Failure {
  /** what is wrong, in the developer's words: one line, no "error:", no stack */
  message: string;
  /** the CLI's code (FAILURE_CODES), or a code the run answered with */
  code: FailureCode | (string & {});
  /** why it is wrong, when the message alone does not say */
  why?: string | undefined;
  /** the way out in words, when it is more than a command */
  fix?: string | undefined;
  /** the commands to run */
  next?: readonly NextStep[] | undefined;
  /** 1 failed (default), 2 a wrong command line, 124 a timeout */
  exit?: number | undefined;
  /** a wrong command line's usage, printed after it for a person */
  usage?: string | undefined;
}

/** A failure as a lookup returns it (src/cli/project.ts theProject, src/cli/runs.ts theRun): the same fields, the
 *  message under `problem` — what a caller tests for ("problem" in r). */
export interface Problem extends Omit<Failure, "message"> { problem: string }

/** A failure thrown from deep in a command, for main.ts to print: the one way a failure leaves a command without a return code. */
export class CommandFailed extends Error {
  readonly failure: Failure;
  constructor(f: Failure | Problem) { const n = asFailure(f); super(n.message); this.failure = n; }
}

export const asFailure = (f: Failure | Problem): Failure => "problem" in f ? { ...f, message: f.problem } : f;

/** The failure as a person reads it (above): a red ✘ (wherever a step fails, as a green tick shows wherever one
 *  succeeds — the checklist's own mark, ✗ where nothing is styled), the command's name and the
 *  message in bold, then why and fix as rows, then Next, then a wrong line's usage. */
export function failureText(cmd: string, f: Failure, s: Style = styleErr()): string {
  const head = cmd ? `mason ${cmd}:` : "mason:";
  // the checklist's marks: ✘ on a terminal (beside its ✔), ✗ in plain text (beside its ✓); a style that colours is one
  const mark = s.red("x") === "x" ? "✗" : "✘";
  const lines = [`${s.red(mark)} ${s.red(head)} ${s.bold(wrap(f.message, s.width, 2, mark.length + 1 + head.length + 1))}`];
  const rows: Array<[string, string]> = [...(f.why ? [["why", f.why] as [string, string]] : []), ...(f.fix ? [["fix", f.fix] as [string, string]] : [])];
  // a value of several lines (a list of failures, an entry to paste) keeps its lines, each under the first
  for (const [label, value] of rows) lines.push(`  ${s.dim(label)}   ${value.split("\n").map((l, i) => i ? `${" ".repeat(8)}${wrap(l, s.width, 8)}` : wrap(l, s.width, 8)).join("\n")}`);
  let text = lines.join("\n");
  if (f.next?.length) text += `\n${nextBlock(f.next, s)}`;
  if (f.usage) text += `\n\n${f.usage.replace(/\n$/, "")}`;
  return text;
}

/** A failure's `error` as --json carries it: on its own (failureJson), or beside a command's own keys when it did part of
 *  its work (mason add: the tables added; mason wait: the tables' state). */
export function errorJson(f: Failure): { code: string; message: string; why?: string; fix?: string } {
  return { code: f.code, message: f.message, ...(f.why ? { why: f.why } : {}), ...(f.fix ? { fix: f.fix } : {}) };
}

/** The failure as a program reads it: `{"error": {code, message, why?, fix?}, "next": […]}`. */
export function failureJson(f: Failure): string {
  return JSON.stringify({ error: errorJson(f), next: nextJson(f.next) }, null, 2);
}

/**
 * SAY A FAILURE AND RETURN ITS EXIT CODE — the one way a command reports that it could not do what was asked: for a
 * person on stderr (failureText), under --json as one JSON document on stdout (failureJson), so a program that asked for
 * data never has to read prose. tests/conventions.test.ts refuses a `mason <cmd>: …` written to stderr any other way.
 */
export function failed(cmd: string, f: Failure | Problem, o: { json: boolean; io?: Io; style?: Style }): number {
  const n = asFailure(f);
  const io = o.io ?? STDIO;
  if (o.json) io.out(failureJson(n)); else io.err(failureText(cmd, n, o.style ?? failureStyle(io)));
  return exitOf(n);
}

/** The style a failure is drawn in: stderr's own when it goes to stderr, plain for an io a test or a caller supplied.
 *  By the STREAM, never by "was an io passed" (CLAUDE.md "Two readers, one interface"): mason init defaults its io to
 *  STDIO and passed it on, and every failure it drew was plain — no red head, no dim labels — on a terminal. */
export const failureStyle = (io: Io): Style => io === STDIO ? styleErr() : PLAIN;

/** A failure's exit code: its code's (2 a wrong command line; 124 anything that ran out of time, a wait or a query Mason
 *  did not answer in time; else 1), unless it names one. The one place it is decided, so the same refusal exits the
 *  same wherever it is found. */
export function exitOf(f: Failure): number {
  return f.exit ?? (f.code === "usage" ? 2 : f.code === "timeout" ? 124 : 1);
}
