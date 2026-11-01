/**
 * What the PreToolUse hooks share (CLAUDE.md "Local gates"): the hook's input, and a Bash command line cut into the simple
 * commands it runs, each as its words with the quotes removed and the leading `VAR=value` / `env` / `time` dropped.
 *
 * It is a reader of the shapes a session types, not a shell: `cd x && node --test …`, `A=1 node --test … | tail`,
 * `a; b`, `(a || b) &`, `2>&1` (a redirection is dropped), `sh -c '…'` (its script is read as a command line of its
 * own). A `$(…)` or a backtick is left inside the word it is in, so a command run only inside one is not seen: the
 * hooks catch a habit, not an adversary.
 *
 * A hook BLOCKS by exiting 2 with one line on stderr, which Claude Code hands the model as the reason
 * (https://code.claude.com/docs/en/hooks, "Exit code 2"); it allows by exiting 0 with nothing printed.
 */
import * as fs from "node:fs";

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: unknown; run_in_background?: unknown };
  transcript_path?: unknown;
  stop_hook_active?: unknown;
  background_tasks?: unknown;
  session_crons?: unknown;
}

/**
 * The hook's JSON on stdin, or `{}` when it is empty or not JSON: such an input names no command to check, so the hook
 * allows (exit 0) rather than print a hook error on every call.
 */
export function readInput(): HookInput {
  try {
    const input: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
    return typeof input === "object" && input !== null ? input as HookInput : {};
  } catch {
    // Narrow by construction: only the read and the parse are inside; what they cannot give is "nothing to check".
    return {};
  }
}

/** The Bash command of a PreToolUse input, or undefined for any other tool. */
export function bashCommand(input: HookInput): string | undefined {
  return input.tool_name === "Bash" && typeof input.tool_input?.command === "string" ? input.tool_input.command : undefined;
}

export interface SimpleCommand {
  /** The words, quotes removed, from the program on (assignments and `env` / `time` dropped). */
  argv: string[];
  /** The text it was cut from, trimmed, for a message that repeats the command. */
  text: string;
}

const SEPARATORS = ["&&", "||", ";", "|", "&", "\n", "(", ")"];
const PREFIXES = new Set(["env", "time", "command", "exec", "nohup"]);

/** Every simple command of a command line, in order, including those of a `sh -c` / `bash -c` script. */
export function simpleCommands(line: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  for (const piece of split(line)) {
    const words = piece.words;
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || PREFIXES.has(words[i]!))) i++;
    const argv = withoutRedirections(words.slice(i));
    if (argv.length === 0) continue;
    out.push({ argv, text: piece.text.trim() });
    const shell = argv[0]!.replace(/^.*\//, "");
    const c = argv.indexOf("-c");
    if ((shell === "sh" || shell === "bash" || shell === "zsh") && c > 0 && argv[c + 1] !== undefined) {
      out.push(...simpleCommands(argv[c + 1]!));
    }
  }
  return out;
}

/** The words less their redirections: `2>&1`, `>out`, and `> out` with its target. */
function withoutRedirections(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^(\d*|&)[<>]+&?$/.test(w)) { i++; continue; }
    if (/^(\d*|&)[<>]/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/** Cuts at the separators outside quotes, and splits each piece into its words with the quotes removed. */
function split(line: string): { words: string[]; text: string }[] {
  const pieces: { words: string[]; text: string }[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let start = 0;
  let i = 0;
  const endWord = (): void => { if (word !== undefined) words.push(word); word = undefined; };
  const endPiece = (at: number): void => { endWord(); pieces.push({ words, text: line.slice(start, at) }); words = []; };
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "'" || ch === '"') {
      const close = line.indexOf(ch, i + 1);
      const end = close < 0 ? line.length : close;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      if (line[i + 1] !== "\n") word = (word ?? "") + line[i + 1];
      i += 2;
      continue;
    }
    const sep = SEPARATORS.find((s) => line.startsWith(s, i));
    const redirect = sep === "&" && (line[i - 1] === ">" || line[i - 1] === "<" || line[i + 1] === ">");
    if (sep !== undefined && !redirect) {
      endPiece(i);
      i += sep.length;
      start = i;
      continue;
    }
    if (ch === " " || ch === "\t") { endWord(); i++; continue; }
    word = (word ?? "") + ch;
    i++;
  }
  endPiece(line.length);
  return pieces;
}

/** Blocks the tool call: one line, which the model reads as the reason. */
export function block(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
