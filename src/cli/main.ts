#!/usr/bin/env node
/**
 * `mason` — the command line of `@mason-data/cli`: its commands for people AND coding agents, a project per folder.
 *
 *     mason init postgres://user:password@localhost:5432/your_app
 *     mason start
 *
 * makes the folder a project, then reads that database with SELECTs alone and serves a copy of the tables you add over
 * the Postgres protocol, in the background (src/cli/dev.ts, src/cli/background.ts); the other commands work with the
 * project of the folder they run in. Every command is in src/cli/registry.ts, described once (src/cli/command.ts).
 * Apache-2.0: it runs the stack (CLAUDE.md "Licensing").
 */
import { COMMANDS, orientation, topUsage, version } from "./registry.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { spinUntilOutput } from "./style.ts";
import { CommandFailed, failed, wantsJson } from "./command.ts";
import { RunUnreachable } from "./control.ts";
import { exitWhenWritten } from "../lib/exit-when-written.ts";

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  // mason alone: where you are and the next command; mason help / --help: every command
  if (command === undefined) { process.stdout.write(await orientation(process.cwd())); return 0; }
  if (command === "--help" || command === "-h") { process.stdout.write(topUsage()); return 0; }
  if (command === "--version" || command === "-v" || command === "version") { process.stdout.write(`${version()}\n`); return 0; }
  const cmd = COMMANDS.find((c) => c.name === command);
  const json = wantsJson(args, cmd);
  // the commands' old names: said, never run as different ones
  const RENAMED: Record<string, { message: string; next: Array<[string, string]> }> = {
    dev: { message: "mason dev is now mason start", next: [["mason init <postgres url>", "once, in your app's folder"], ["mason start", "Mason in the background"]] },
    docs: { message: "mason docs is now mason help", next: [["mason help agent", "driving Mason from a coding agent"], ["mason help production", "running Mason on a server"]] },
    // named for what it does to the copy, never for the mechanism
    poll: { message: "mason poll is now mason sync", next: [["mason sync <table>", "make the copy of a table current now"], ["mason status", "each table's copy, and which the sync leaves out"]] },
    purge: { message: "mason purge is now mason destroy", next: [["mason destroy", "this folder's project: its copy and state, never its files"]] },
    // mason rm read as the opposite of mason add: it removed a project's copy and state, never a table;
    // the opposite of mason add is mason remove, so both are offered
    rm: { message: "mason rm is gone: mason remove takes a table out of the project, mason destroy removes the project's copy", next: [["mason remove <table>", "a table, and its copy"], ["mason destroy", "this folder's project: its copy and state, never its files"]] },
    // a user's password does not expire, so mason user is enough and mason connect was dropped
    connect: { message: "mason connect is gone: mason user add <name> makes a user whose password does not expire, and prints the URL to paste", next: [["mason user add <name>", "a user for a BI tool or your app"], ["mason status", "where the Postgres API listens"]] },
    // a project is its folder (mason list was dropped): nothing on the machine lists them
    list: { message: "mason list is gone: a project is its folder, and a command means the project of the folder it runs in", next: [["mason status", "this folder's project"]] },
  };
  if (!cmd && Object.hasOwn(RENAMED, command)) return failed("", { ...RENAMED[command]!, code: "usage" }, { json });
  if (!cmd) return failed("", { message: `there is no command ${JSON.stringify(command)}${didYouMean(command, COMMANDS.map((c) => c.name))}`, code: "usage", usage: json ? undefined : topUsage() }, { json });
  // a command quiet for a moment shows a spinner on a terminal until it prints (src/cli/style.ts spinUntilOutput)
  const stop = spinUntilOutput(`mason ${cmd.name}`);
  try { return await cmd.run(args); }
  catch (e) {
    // a failure a command threw instead of returning (src/cli/command.ts CommandFailed), or a run that stopped answering
    // mid-command: said as every failure is, in JSON under --json
    if (e instanceof CommandFailed) return failed(cmd.name, e.failure, { json });
    if (e instanceof RunUnreachable) return failed(cmd.name, e.failure, { json });
    throw e;
  } finally { stop(); }
}

main(process.argv.slice(2)).then(exitWhenWritten, (e: unknown) => {
  // an error no command said in its own words: its message, never a stack trace (CLAUDE.md: a message that needs a
  // stack to be understood is a bug — mason query orders printed one when Mason's API was not up yet).
  // MASON_DEBUG=1 prints where it happened, for the bug report it deserves. The same shape as every failure, JSON under --json.
  const message = e instanceof Error ? e.message : String(e);
  const [command, ...args] = process.argv.slice(2);
  const code = failed(command ?? "", { message, code: "failed", fix: process.env.MASON_DEBUG ? undefined : "this is a bug in mason: MASON_DEBUG=1 prints where it happened, for the report" },
    { json: wantsJson(args, COMMANDS.find((c) => c.name === command)) });
  if (process.env.MASON_DEBUG) process.stderr.write(`${(e as Error).stack ?? ""}\n`);
  exitWhenWritten(code);
});
