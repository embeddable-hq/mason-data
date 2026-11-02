#!/usr/bin/env node
/**
 * PreToolUse hook (Bash): a test run carries its time limit (CLAUDE.md "Local gates", "While working, the tests
 * nearest the change"). A hung test never exits, and a background job reports only when it exits, so `node --test` is
 * blocked unless BOTH `--test-timeout=<ms>` (a positive integer: 0 is no bound) and `--test-force-exit` come before its
 * first file: after the files Node ignores them, and without `--test-force-exit` a test that timed out but holds a
 * handle (an interval, a socket, a worker) keeps its process, and so the run, alive for ever (issue 139).
 *
 * Allowed: `npm test` alone (and `npm run test`, `npm t`, `npm run-script test`), because its script carries the pair
 * before its glob (package.json); `npm test` with anything appended is blocked, since it runs the whole suite and Node
 * ignores what npm appends after the files. `npm run check` and `npm run gate` (bounded by the script and the gate),
 * and scripts/fails-without.ts (it carries the pair itself, TEST_BOUND_ARGS of scripts/gate.ts): for each of those,
 * `node`'s first argument is a script, not `--test`. Anything through scripts/gate-slot.ts, and
 * `npm run test:integration`, still pass through with no per-test bound: a gap, filed as its own issue.
 *
 * The suggested limit is TEST_TIMEOUT_MS of scripts/gate.ts, written here as a literal so that a hook run on every Bash
 * call imports nothing but shell.ts; tests/hooks.test.ts holds the two equal.
 * Exits 2 with the way out on one line (scripts/hooks/shell.ts), 0 otherwise.
 */
import { bashCommand, block, readInput, simpleCommands } from "./shell.ts";

/** Node options that take their value as the next word when written without `=`. */
const TAKES_VALUE = new Set([
  "--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination", "--test-concurrency",
  "--test-shard", "--test-timeout", "--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file",
  "--conditions", "-C", "--test-isolation", "--test-global-setup", "--test-coverage-include", "--test-coverage-exclude",
]);

const WAY_OUT = "node --test --test-timeout=300000 --test-force-exit <files>";
const NODE_MESSAGE = `node --test needs --test-timeout=<ms> and --test-force-exit before the files (Node ignores them after, and without --test-force-exit a hung test holding a handle never exits): ${WAY_OUT}`;
const NPM_MESSAGE = `npm test runs the whole suite, and Node ignores what npm appends after its files: ${WAY_OUT}, or npm test alone for the whole suite`;

/** Why this command runs a test with no limit, or undefined when it does not. */
function unbounded(argv: string[]): string | undefined {
  const program = argv[0]!.replace(/^.*\//, "");
  if (program === "npm") {
    const verb = argv[1];
    const at = verb === "run" || verb === "run-script" ? 2 : 1;
    const script = argv[at];
    // the script carries the pair before its glob; a word after it would land after the files, where Node ignores it
    return (script === "test" || script === "t") && argv.length > at + 1 ? NPM_MESSAGE : undefined;
  }
  if (program !== "node") return undefined;
  let isTest = false;
  let timeout = false;
  let forceExit = false;
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--" || !word.startsWith("-")) break; // the first file, or a script whose arguments are its own
    const name = word.split("=")[0]!;
    const value = word.includes("=") ? word.slice(name.length + 1) : TAKES_VALUE.has(name) ? argv[++i] : undefined;
    if (name === "--test") isTest = true;
    if (name === "--test-timeout") timeout = value !== undefined && /^[1-9]\d*$/.test(value); // 0 means no bound
    if (name === "--test-force-exit") forceExit = true;
  }
  return isTest && !(timeout && forceExit) ? NODE_MESSAGE : undefined;
}

const command = bashCommand(readInput());
if (command !== undefined) {
  for (const { argv } of simpleCommands(command)) {
    const why = unbounded(argv);
    if (why !== undefined) block(why);
  }
}
