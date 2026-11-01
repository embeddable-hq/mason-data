#!/usr/bin/env node
/**
 * PreToolUse hook (Bash): a test run carries its time limit (CLAUDE.md "Local gates", "While working, the tests nearest the change"). A hung test never
 * exits, and a background job reports only when it exits, so `node --test` without `--test-timeout=<ms>` BEFORE its
 * first file is blocked: after the files Node ignores the flag. `npm test` is blocked too, because its script names the
 * files and anything npm appends lands after them (issue 139).
 *
 * Allowed: `npm run check` and `npm run gate` (each step bounded by the gate), anything through scripts/gate-slot.ts,
 * and scripts/fails-without.ts (it sets its own): for each of those, `node`'s first argument is a script, not `--test`.
 * Exits 2 with the way out on one line (scripts/hooks/shell.ts), 0 otherwise.
 */
import { bashCommand, block, readInput, simpleCommands } from "./shell.ts";

/** Node options that take their value as the next word when written without `=`. */
const TAKES_VALUE = new Set([
  "--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination", "--test-concurrency",
  "--test-shard", "--test-timeout", "--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file",
  "--conditions", "-C", "--test-isolation", "--test-global-setup", "--test-coverage-include", "--test-coverage-exclude",
]);

const NODE_MESSAGE = "node --test needs --test-timeout=<ms> before the files (Node ignores it after them): node --test --test-timeout=120000 <files>";
const NPM_MESSAGE = "npm test runs node --test with no time limit (Node ignores one after the files): node --test --test-timeout=120000 <files>, or npm run check for the whole suite";

/** Why this command runs a test with no limit, or undefined when it does not. */
function unbounded(argv: string[]): string | undefined {
  const program = argv[0]!.replace(/^.*\//, "");
  if (program === "npm") {
    const verb = argv[1];
    const script = verb === "run" || verb === "run-script" ? argv[2] : verb;
    return script === "test" || script === "t" ? NPM_MESSAGE : undefined;
  }
  if (program !== "node") return undefined;
  let isTest = false;
  let timeout = false;
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--" || !word.startsWith("-")) break; // the first file, or a script whose arguments are its own
    const name = word.split("=")[0]!;
    if (name === "--test") isTest = true;
    if (name === "--test-timeout") timeout = true;
    if (!word.includes("=") && TAKES_VALUE.has(name)) i++;
  }
  return isTest && !timeout ? NODE_MESSAGE : undefined;
}

const command = bashCommand(readInput());
if (command !== undefined) {
  for (const { argv } of simpleCommands(command)) {
    const why = unbounded(argv);
    if (why !== undefined) block(why);
  }
}
