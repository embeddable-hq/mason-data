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
import { closest } from "../lib/did-you-mean.ts";

/**
 * A LINE THAT HOLDS A HOSTED SERVICE'S TEXT IS BROKEN BY THE CLI, NEVER BY THE TERMINAL, AT EVERY WIDTH (PR 481's
 * class rounds: a value sized to the terminal's width made the terminal start a visual line at column 0 with a forged
 * `Next` heading, a step or a row; then the same under 40 columns, where no style wraps). src/cli/hosted.ts makes every
 * value one line with no run of spaces (`serviceText`); the style a command gives its output when that output holds
 * such a value (`serviceStyle`) makes every renderer here break every line it writes, at the terminal's own width
 * (`Style.columns`, read when the output is drawn, whatever it is), so no line ever reaches the terminal's edge:
 *
 *   - a line takes at most width - 1 columns (one column at width 1), a character outside ASCII counted as two;
 *   - it breaks at a space where one is in reach, else within the word; the headline, a row's label and a step's
 *     command are broken as any text is (`strictLines`, the last pass of every renderer: `strict`);
 *   - every continuation starts at `continuationAt(width)`: CONTINUATION (4) wherever the width leaves 4 columns after
 *     it, else 1 (3 to 8 columns), else 0 (1 or 2 columns, where one character is a line). The CLI's own lines start at
 *     0 (a heading, a failure, a tip) or 2 (a row, a step), never at 1 or 4, so a continuation can never be taken for
 *     one; at 1 or 2 columns nothing the CLI starts a line with fits in a line, so none can be forged either;
 *   - a value's own column (a row's, a step's description) is kept while it leaves `MIN_ROOM` columns, else its lines
 *     continue at continuationAt(width), never one character a line under an indent wider than the terminal.
 *
 * So what a person sees begin a line is always the CLI's own. A pipe, a file and `--json` are unwrapped as ever (no
 * terminal width): what an agent parses never changes.
 */
export const CONTINUATION = 4;
/** The fewest columns a value's own column must leave it before its lines continue there. */
const MIN_ROOM = 12;
export const serviceStyle = (s: Style): Style => ({ ...s, untrusted: true });

/** The columns a word takes, counted so a line never takes more than the terminal has: a character outside ASCII as two. */
const columns = (w: string): number => { let n = 0; for (const ch of w) n += ch.codePointAt(0)! <= 0x7e ? 1 : 2; return n; };

/** Where a continuation starts on a terminal `width` columns wide (above). */
export const continuationAt = (width: number): number => lineLimit(width) - CONTINUATION >= 4 ? CONTINUATION : width >= 3 ? 1 : 0;
/** The most columns one line may take on a terminal `width` wide: one short of its edge, never none. */
const lineLimit = (width: number): number => Math.max(1, width - 1);

/** The terminal width a style that holds a service's text breaks at; null when it is no terminal (or holds none). */
const strictWidth = (s: Style): number | null => s.untrusted ? s.columns ?? s.width : null;

/** `text` broken at `width` as `serviceStyle` asks (above), its first line after `firstUsed` columns of prefix: every
 *  line within the limit, a long word broken within, every line after the first at `indent` while that leaves MIN_ROOM,
 *  else at continuationAt(width). */
export function strictWrap(text: string, width: number, indent: number, firstUsed: number): string {
  const limit = lineLimit(width);
  const cont = Math.max(indent, CONTINUATION) + MIN_ROOM <= limit ? Math.max(indent, CONTINUATION) : continuationAt(width);
  const lines: string[] = [];
  let line = "", taken = 0, used = firstUsed;
  const room = (): number => Math.max(1, limit - used);
  const breakLine = (): void => { lines.push(line); line = ""; taken = 0; used = cont; };
  // a prefix that leaves no room: the text starts on the next line
  if (limit - used < 1) breakLine();
  for (const word of text.split(" ")) {
    if (word === "") continue;
    const wc = columns(word);
    if (line && taken + 1 + wc <= room()) { line += ` ${word}`; taken += 1 + wc; continue; }
    if (line) breakLine();
    if (wc <= room()) { line = word; taken = wc; continue; }
    for (const ch of word) {
      const cc = columns(ch);
      if (taken + cc > room() && line) breakLine();
      line += ch; taken += cc;
    }
  }
  lines.push(line);
  return lines.join(`\n${" ".repeat(cont)}`);
}

/** A colour code, which takes no column. */
const SGR = /^\x1b\[[0-9;]*m/;

/**
 * THE LAST PASS OF EVERY RENDERER under serviceStyle: each line of `text` that would reach the terminal's edge broken
 * (above) — at its last space in reach, else within a word — its continuations at continuationAt(width), its colour codes
 * taking no column and never split. A line within the limit is left as it is.
 */
export function strictLines(text: string, width: number): string {
  const limit = lineLimit(width), cont = continuationAt(width);
  const out: string[] = [];
  for (const whole of text.split("\n")) {
    const tokens: Array<{ t: string; w: number }> = [];
    for (let i = 0; i < whole.length;) {
      const sgr = SGR.exec(whole.slice(i));
      if (sgr) { tokens.push({ t: sgr[0], w: 0 }); i += sgr[0].length; continue; }
      const ch = String.fromCodePoint(whole.codePointAt(i)!);
      tokens.push({ t: ch, w: columns(ch) }); i += ch.length;
    }
    if (tokens.reduce((n, k) => n + k.w, 0) <= limit) { out.push(whole); continue; }
    // the line's own indent, kept while it leaves room for a word, else the continuation's
    let lead = 0;
    while (tokens[lead]?.t === " ") lead++;
    const indent = (n: number): Array<{ t: string; w: number }> => Array.from({ length: n }, () => ({ t: " ", w: 1 }));
    let line = indent(lead + MIN_ROOM <= limit ? lead : Math.min(lead, cont));
    let taken = line.length, start = line.length;
    // each token placed in turn; past the limit the line is broken at its last space past the indent, and what followed
    // the space is placed again from there (so it is broken again if it must), else broken here, within the word
    let placed: number[] = [];   // the source index of each of line's tokens past its indent
    for (let i = lead; i < tokens.length; i++) {
      const k = tokens[i]!;
      if (taken + k.w > limit && taken > start) {
        let at = -1;
        for (let j = placed.length - 1; j > 0; j--) if (tokens[placed[j]!]!.t === " ") { at = j; break; }
        const kept = at >= 0 ? line.slice(0, start + at) : line;
        while (kept.length > start && kept[kept.length - 1]!.t === " ") kept.pop();
        out.push(kept.map((x) => x.t).join(""));
        if (at >= 0) i = placed[at]!;   // the loop's i++ places what followed the space
        else i--;                       // this token begins the next line
        line = indent(cont); taken = cont; start = cont; placed = [];
        continue;
      }
      if (k.t === " " && taken === start && start > 0) continue;   // no space at a continuation's start
      line.push(k); placed.push(i); taken += k.w;
    }
    // a continuation with nothing after its indent (the line ended in spaces) is no line
    if (taken > start || start === 0) out.push(line.map((x) => x.t).join(""));
  }
  return out.join("\n");
}

/** A renderer's output, as serviceStyle asks it on a terminal (strictLines), else as it is. */
export const strict = (text: string, s: Style): string => { const w = strictWidth(s); return w === null ? text : strictLines(text, w); };

/** A renderer's wrap: the strict one for a style that holds a service's text on a terminal, else style.ts's. */
const fit = (text: string, s: Style, indent: number, firstUsed = indent): string => {
  const w = strictWidth(s);
  return w === null ? wrap(text, s.width, indent, firstUsed) : strictWrap(text, w, indent, firstUsed);
};

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
 * printing the usage for `--help` (its spec as data for `--help --json`), 2 after saying what is wrong with the line,
 * then the usage.
 */
export function parseCommand(spec: CommandSpec, argv: string[]): { values: Record<string, string | boolean | string[] | boolean[] | undefined>; positionals: string[] } | number {
  if (specAsked(spec, argv)) { process.stdout.write(`${specAnswer(spec)}\n`); return 0; }
  let parsed;
  try { parsed = parseArgs({ args: argv, options: { ...spec.options, ...HELP }, allowPositionals: true }); }
  catch (e) { return failed(spec.name, { ...parseProblem(spec, e as Error & { code?: string }), code: "usage", usage: synopsis(spec), next: [[`mason ${spec.name} --help`, "its usage, with every option"]] }, { json: wantsJson(argv, spec) }); }
  if (parsed.values.help) { process.stdout.write(spec.usage); return 0; }
  return { values: parsed.values as Record<string, string | boolean | string[] | boolean[] | undefined>, positionals: parsed.positionals };
}

/** A LIST FLAG's value, one comma list however it was written (`multiple: true` in the spec): `--columns id,status`
 *  and `--columns id --columns status` mean the same, `id,status`; undefined when it was not given. */
export function listFlag(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join(",") : undefined;
}

/** A command that takes no argument, given one (`mason stop myproject` stopped this folder's project, not that one):
 *  a wrong line, its usage's synopsis. Null when there is none. */
export function noArguments(spec: Pick<CommandSpec, "name" | "usage">, positionals: readonly string[], json: boolean): number | null {
  if (!positionals.length) return null;
  return failed(spec.name, { message: `it takes no argument (${positionals.join(" ")}): a project is its folder`, code: "usage",
    fix: `run it in the project's folder: cd <folder> && mason ${spec.name}, or mason -C <folder> ${spec.name}`, usage: synopsis(spec),
    next: [[`mason ${spec.name} --help`, "its usage, with every option"]] }, { json });
}

/** Whether a line asks for the command's spec as data: `--help` (or `-h`) and `--json` on a line that parses — every
 *  command, whether or not it takes --json itself (mason help, mason mcp): the spec is what an agent reads first. A line
 *  that does not parse is no such question: parseCommand's own parse says what is wrong with it. */
function specAsked(spec: CommandSpec, argv: readonly string[]): boolean {
  if (!argv.includes("--json") || !(argv.includes("--help") || argv.includes("-h"))) return false;
  try {
    const options: Options = { ...spec.options, ...HELP, json: { type: "boolean" } };
    const p = parseArgs({ args: [...argv], options, allowPositionals: true });
    return p.values["help"] === true && p.values["json"] === true;
  } catch (e) {
    // not swallowed: the same line goes on to parseCommand's own parse, which says this error in the CLI's words
    if (!(e instanceof TypeError)) throw e;
    return false;
  }
}

/** The keys of a command's spec as data (`mason <name> --help --json`, `mason help <name> --json`). */
export const SPEC_ANSWER_KEYS: readonly string[] = ["command", "next"];
/** What follows a command's spec as data. */
export const SPEC_NEXT: readonly NextStep[] = [["mason help --json", "every command's spec, the guides and the failure codes"]];
/** A command's spec as its --json answer: `{ command: <spec>, next }`. */
export const specAnswer = (spec: CommandSpec): string => jsonText({ ...spec, json: SPEC_ANSWER_KEYS }, { command: specJson(spec) }, SPEC_NEXT);

/**
 * THE EXIT CODES, a closed set (`mason help agent` lists them, and each command's spec as data names those it can
 * exit with): 124 only for a command TIMEOUT_COMMANDS names.
 */
export const EXIT_CODES = {
  0: "done",
  1: "failed, with the reason",
  2: "the command line is wrong (without --json the usage follows)",
  124: "ran out of time (nothing stopped)",
} as const;

/** Whether a command can run out of time (exit 124): TIMEOUT_COMMANDS names it. */
const timesOut = (name: string): boolean => new RegExp(`\\bmason ${name}\\b`).test(TIMEOUT_COMMANDS);

/**
 * A COMMAND'S SPEC AS DATA — the declared, stable shape `mason <name> --help --json` and `mason help --json` answer with
 * (`mason help agent` documents it), read from the one `CommandSpec`, never restated:
 *
 *   name, summary, usage   the spec's own text (usage is what --help prints)
 *   forms                  each form of its synopsis: { synopsis, positionals }, positionals the words that are no
 *                          option, as the synopsis writes them (`<table>…`, `[<postgres url> | demo]`, `add`, `<name>`)
 *   options                each option its parser takes, --help included: { name, short, type, multiple, default,
 *                          value }: short and default null when it has none, value the synopsis' placeholder for a
 *                          string option (`<column>,…`), else null
 *   json                   the top-level keys of its --json answer, next included; null when it takes no --json
 *   needs                  "project", "run" or null (what it needs to do its work)
 *   stdout                 "protocol" when its stdout is a protocol's (mason mcp), else null
 *   exitCodes              [{ code, meaning }]: 0, 1 and 2 for every command, 124 for one that can run out of time
 */
export interface SpecJson {
  name: string;
  summary: string;
  usage: string;
  forms: Array<{ synopsis: string; positionals: string[] }>;
  options: Array<{ name: string; short: string | null; type: "string" | "boolean"; multiple: boolean; default: string | boolean | string[] | boolean[] | null; value: string | null }>;
  json: string[] | null;
  needs: "project" | "run" | null;
  stdout: "protocol" | null;
  exitCodes: Array<{ code: number; meaning: string }>;
}

export function specJson(spec: CommandSpec): SpecJson {
  const lines = spec.usage.split("\n");
  const end = lines.findIndex((l) => l.trim() === "");
  const forms = lines.slice(0, end < 0 ? lines.length : end).map((l) => l.replace(/^usage:\s*/, "").trim());
  const options = Object.entries({ ...spec.options, ...HELP }).map(([name, d]) => {
    // the placeholder the synopsis writes after it, else the first the usage does
    const placeholder = new RegExp(`--${name}[ =]([^\\s\\[\\]]+)`);
    const value = d.type === "string" ? (forms.map((f) => placeholder.exec(f)?.[1]).find((v) => v !== undefined) ?? placeholder.exec(spec.usage)?.[1] ?? null) : null;
    return { name: `--${name}`, short: d.short ? `-${d.short}` : null, type: d.type, multiple: d.multiple === true, default: d.default ?? null, value };
  });
  const exitCodes = Object.entries(EXIT_CODES).filter(([code]) => code !== "124" || timesOut(spec.name)).map(([code, meaning]) => ({ code: Number(code), meaning }));
  return { name: spec.name, summary: spec.summary, usage: spec.usage, forms: forms.map((f) => ({ synopsis: f, positionals: positionalsOf(f, spec.name) })), options,
    json: spec.json ? [...spec.json] : null, needs: spec.needs ?? null, stdout: spec.stdout ?? null, exitCodes };
}

/** The words of a synopsis form that are no option: split at the spaces outside brackets, `mason <name>` and every
 *  option dropped — a bracketed group that starts with `-` (`[--json]`, `[-n <lines>]`), and a bare option with its
 *  value (`--ssh <user@server>`). */
function positionalsOf(form: string, name: string): string[] {
  const words: string[] = [];
  let word = "", depth = 0;
  for (const ch of form) {
    if (ch === "[" || ch === "<") depth++;
    if (ch === "]" || ch === ">") depth = Math.max(0, depth - 1);
    if (ch === " " && depth === 0) { if (word) words.push(word); word = ""; continue; }
    word += ch;
  }
  if (word) words.push(word);
  const rest = words[0] === "mason" && words[1] === name ? words.slice(2) : words;
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i]!;
    // an option is a dash and a letter (`[--json]`, `-n`); a lone `-` (`mason init -`, stdin) is a positional
    if (/^\[--?[A-Za-z]/.test(w)) continue;
    if (/^--?[A-Za-z]/.test(w)) { if (rest[i + 1]?.startsWith("<")) i++; continue; }
    out.push(w);
  }
  // an alternative whose other side was an option (`<org>/<name> | --replica <org>/<name>`) leaves no `|` behind
  return out.filter((w, i) => w !== "|" || (i > 0 && i < out.length - 1));
}

/** A command's synopsis: its usage's first lines, up to the first blank one (`usage: mason <name> …` and its other
 *  forms), then where the rest is. What a wrong line is answered with: the whole usage is for `--help` (94 lines for
 *  `mason status`, and the mistake scrolled away above it). */
export function synopsis(spec: Pick<CommandSpec, "name" | "usage">): string {
  const lines = spec.usage.split("\n");
  const end = lines.findIndex((l) => l.trim() === "");
  return `${lines.slice(0, end < 0 ? lines.length : end).join("\n")}\n\nmason ${spec.name} --help for more\n`;
}

/** What is wrong with a line the parser refused, in the CLI's words (never Node's, whose advice about `--` misleads):
 *  an option it does not take, with the closest it does (`didYouMean` over the spec's options and `--help`); one that
 *  needs a value and has none; one that takes none and was given one. */
function parseProblem(spec: CommandSpec, e: Error & { code?: string }): { message: string; fix?: string } {
  const options = { ...spec.options, ...HELP };
  const names = Object.keys(options).map((n) => `--${n}`);
  const shorts = Object.entries(options).flatMap(([n, d]) => d.short ? [[`-${d.short}`, `--${n}`] as const] : []);
  const said = /'(-[^'\s,]*)/.exec(e.message)?.[1];
  const flag = said === undefined ? undefined : said.startsWith("--") ? said.replace(/=.*$/, "") : said;
  if (e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && flag !== undefined) {
    const near = closest(flag, [...names, ...shorts.map(([s]) => s)]);
    return { message: `there is no option ${flag}${near !== null ? ` — did you mean \`${near}\`?` : ""}`,
      fix: `its options are ${names.join(", ")}` };
  }
  if (e.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && flag !== undefined) {
    const long = shorts.find(([s]) => s === flag)?.[1] ?? flag;
    const named = long === flag ? long : `${flag} (${long})`;
    const takes = options[long.slice(2)]?.type === "string";
    return takes ? { message: `${named} needs a value: ${flag} <value>` } : { message: `${named} takes no value: write ${flag} alone` };
  }
  return { message: e.message };
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
    // a terminal too narrow for the column under serviceStyle: what it does on the next line, at the continuation
    const w = strictWidth(s);
    if (w !== null && 2 + NEXT_WIDTH + 2 + MIN_ROOM > lineLimit(w)) return `  ${s.cyan(command)}\n${" ".repeat(continuationAt(w))}${s.dim(fit(what, s, continuationAt(w)))}`;
    return `  ${s.cyan(command.padEnd(NEXT_WIDTH))}  ${s.dim(fit(what, s, 2 + NEXT_WIDTH + 2, used))}`;
  };
  return strict(["", s.bold("Next:"), ...steps.map(step)].join("\n"), s);
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
  // a headline is a terminal's to wrap, unless it holds a service's text: then the CLI breaks it (above)
  const lines = [s.bold(strictWidth(s) !== null ? fit(r.headline, s, CONTINUATION, 0) : r.headline)];
  const w = Math.max(0, ...(r.details ?? []).map(([label]) => label.length));
  for (const [label, value] of r.details ?? []) lines.push(`  ${s.dim(label.padEnd(w))}   ${fit(value, s, 2 + w + 3)}`);
  return strict(withEnd(lines.join("\n"), r, s), s);
}
/**
 * The end of a command's output, to print on its own (out(endText(…))): its tips, then what to run next, each part after
 * a blank line; "" when it has neither. withEnd puts it after text a command has not printed yet.
 */
export function endText(r: { tips?: readonly string[] | undefined; next?: readonly NextStep[] | undefined }, s: Style = styleOut()): string {
  const tips = r.tips?.length ? `\n${r.tips.map((t) => s.dim(`Tip: ${fit(t, s, 5)}`)).join("\n")}` : "";
  const next = r.next?.length ? nextBlock(r.next, s) : "";
  return strict(tips && next ? `${tips}\n${next}` : tips || next, s);
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

/** The commands that can run out of time, exit 124 (code `timeout`): the one list the codes and the agent's guide say. */
export const TIMEOUT_COMMANDS = "mason wait, mason deploy, mason replica create, mason login (its code expired), mason share and mason ui --ssh (no address or answer in time)";

/**
 * THE CODES A FAILURE CARRIES, a closed set a program can branch on (`mason help agent` lists them): `Failure.code` is
 * one of them, so a code outside the set does not compile.
 */
export const FAILURE_CODES = {
  usage: "the command line is wrong: a flag, an argument, a value (exit 2; the usage follows for a person)",
  no_project: "no Mason project here or above (mason init makes one)",
  bad_config: "this folder is a Mason project whose .mason/config.json cannot be read: repair it, or move .mason/ aside and mason init",
  bad_source: "the project's sources file (mason/sources/<name>.yml) is missing or names something wrong: the file, the key and the way out are said",
  bad_roles: "the project's roles file (mason/roles.yml) names something wrong: a table the sources file does not sync, a column the synced table lacks, a role with no table; the file, the key and the way out are said",
  not_running: "Mason is not running for the project (mason start)",
  unreachable: "Mason is running but does not answer (mason logs says why)",
  not_answering: "Mason's process is alive and does not answer its commands, hung: mason stop ends it (its synced data stays)",
  not_found: "a name nothing has: a table, a column, a user",
  nothing_yet: "nothing to work on yet: no table added (the next steps say what adds one)",
  refused: "Mason refused what was asked, with the reason",
  failed: "the command tried and could not finish: the reason, and what to do",
  timeout: `ran out of time — ${TIMEOUT_COMMANDS}; nothing stopped (exit 124)`,
} as const;
export type FailureCode = keyof typeof FAILURE_CODES;

/** A code another process sent (the run's refusal, the server's Mason over ssh) as one of ours: its own when it is in
 *  the set, else `otherwise` — a code outside it never reaches a program that branches on the set. */
export const failureCode = (code: unknown, otherwise: FailureCode): FailureCode =>
  typeof code === "string" && Object.hasOwn(FAILURE_CODES, code) ? code as FailureCode : otherwise;

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
  /** the CLI's code (FAILURE_CODES), the closed set */
  code: FailureCode;
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
  const lines = [`${s.red(mark)} ${s.red(head)} ${s.bold(fit(f.message, s, 2, (strictWidth(s) === null ? mark.length : columns(mark)) + 1 + head.length + 1))}`];
  const rows: Array<[string, string]> = [...(f.why ? [["why", f.why] as [string, string]] : []), ...(f.fix ? [["fix", f.fix] as [string, string]] : [])];
  // a value of several lines (a list of failures, an entry to paste) keeps its lines, each under the first
  for (const [label, value] of rows) lines.push(`  ${s.dim(label)}   ${value.split("\n").map((l, i) => i ? `${" ".repeat(8)}${fit(l, s, 8)}` : fit(l, s, 8)).join("\n")}`);
  let text = lines.join("\n");
  if (f.next?.length) text += `\n${nextBlock(f.next, s)}`;
  if (f.usage) text += `\n\n${f.usage.replace(/\n$/, "")}`;
  return strict(text, s);
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
  const n = usageWayOut(cmd, asFailure(f));
  const io = o.io ?? STDIO;
  if (o.json) io.out(failureJson(n)); else io.err(failureText(cmd, n, o.style ?? failureStyle(io)));
  return exitOf(n);
}

/**
 * A WRONG COMMAND LINE ALWAYS SAYS WHERE ITS USAGE IS, whatever raised it (the parse, or a command's own check, many of
 * which answered with `next: []`): its next steps end with `mason <cmd> --help` (`mason --help` for no command), and it
 * carries a fix, its own, else the way to its usage. Decided here, where every failure is said, so a usage failure added
 * later cannot leave it out.
 */
export function usageWayOut(cmd: string, f: Failure): Failure {
  if (f.code !== "usage") return f;
  const help = cmd ? `mason ${cmd} --help` : "mason --help";
  // `mason help <cmd>` is the same page, so a failure that names it already says where the usage is
  const said = (c: string): boolean => c === help || (cmd !== "" && c === `mason help ${cmd}`);
  const next: readonly NextStep[] = f.next?.some(([c]) => said(c)) ? f.next : [...(f.next ?? []), [help, cmd ? "its usage, with every option" : "every command"]];
  return { ...f, next, fix: f.fix ?? (cmd ? `write the line as its usage says (mason ${cmd} --help)` : "name a command mason --help lists") };
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
