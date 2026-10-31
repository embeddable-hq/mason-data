/**
 * EVERY `mason` COMMAND, AND THE HELP MADE FROM THEM. `mason --help` is generated from this list — each
 * command's summary, in this order — so a command cannot exist without being listed, and tests/cli-help.test.ts holds
 * each one to src/cli/command.ts's rules (its own --help, an example, every option documented).
 */
import { failed, parseCommand, reportText, wantsJson, type Command, type CommandSpec, type NextStep } from "./command.ts";
import { removedStartFlags, type SourcesTop } from "../lib/table-sync.ts";
import { sourcesTop } from "./sources.ts";
import { dev } from "./dev.ts";
import { devInBackground } from "./background.ts";
import { ADD, LOGS, REMOVE, STATUS, STOP, TABLES, WAIT, add, logs, remove, status, stop, tables, wait } from "./commands.ts";
import { USER, user } from "./user.ts";
import { MCP, mcp } from "./mcp.ts";
import { SHARE, share } from "./share.ts";
import { DEFAULT_UI_PORT } from "./ports.ts";
import { UI, ui } from "./ui.ts";
import { GUIDES, guideText, type Guide } from "./guides.ts";
import { DOCTOR, NODE_MIN, doctor } from "./doctor.ts";
import { DESTROY, destroy } from "./machine.ts";
import { INIT, init } from "./init.ts";
import { SYNC, sync } from "./sync.ts";
import { USAGE, usage } from "./usage.ts";
import { CANCEL, cancel } from "./cancel.ts";
import { SERVE, serve } from "./serve.ts";
import { PROJECT_LINE } from "./dev.ts";
import { version } from "./version.ts";
import { didYouMean } from "../lib/did-you-mean.ts";
import { out as styleOut, wrap, type Style } from "./style.ts";
import { theProject } from "./project.ts";
import { liveRun } from "./runs.ts";

export { version } from "./version.ts";

export const DEV: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "start",
  summary: "start Mason for this folder's project, in the background (mason init makes the project)",
  usage: `usage: mason start [--attach] [--self-signed-tls] [--port <n>] [--json]

  Starts Mason for the project of this folder (mason init made it): one process, which syncs the tables you add
  (mason add) from the project's database into its own file, keeps them current as the sources file says, and answers
  the Postgres protocol for BI tools and your app. It only reads the database (SELECT, and a table's change log when
  its sync: says replication). It returns once Mason is up; run it again any time (it says so when Mason is
  already running). The synced data and Mason's state stay between runs: the next start resumes.

  After its first sync, each table is kept current as the sources file's sync: says — at the top for every table, or
  on a table's entry: off (the default, which mason init writes) reads it again only when you run mason sync <table>;
  poll <interval> (poll 5s, poll 5m, poll 1h) polls it with SELECTs at that interval; replication reads its changes
  from the database's change log, as they are made. Each poll scans its table whole
  on your database, and the next waits at least four times as long as that poll took, so the polls never take more
  than a fifth of your database's time. The start says the file's default once; mason status says how each table is
  kept current and when it was last synced. A table whose sync: changed keeps its synced data and is caught up by one poll.

  A table under sync: replication needs wal_level = logical, a user that may replicate, and a primary key (a key:
  table is polled): Mason makes one replication slot for the project and its own publication, carrying the replicated
  tables alone, and drops them, verified gone, when no table's sync is replication any more (and at mason destroy).
  publication: <name> at the top of the sources file (\${PG_PUBLICATION} reads it from .env) names a publication that
  is the database owner's: it is read as it is, verified to carry every replicated table and column, and never
  created, altered or dropped — Mason makes only its slot. A read replica needs one (it takes no CREATE PUBLICATION).

  --replication, --poll and --publication are gone: each answers with the line to write at the top of the sources
  file (sync: replication, sync: poll 5m, publication: <name>) and exit 2, and starts nothing.

  The Postgres API's port is the project's: the first start takes 5433, or the next port free on every address when a
  second Postgres holds it, and records it; every later start listens on the same port, so a BI tool's saved connection
  keeps working, and refuses, naming what holds it, rather than move. MASON_PG_PORT=<n> in your shell names the port,
  or moves the project to it (said): that port is used, or start refuses, naming what holds it.

  The Postgres API listens on 127.0.0.1 unless MASON_PG_HOST names another address (0.0.0.0: every address of this
  machine). Off this machine a password travels on the connection, so it then needs TLS: MASON_PG_TLS_CERT and
  MASON_PG_TLS_KEY (PEM files), or --self-signed-tls, which makes a certificate for the project in .mason/ and serves
  it again at every later start with the flag. Every client then connects with sslmode=require. A team whose own proxy
  or load balancer terminates TLS keeps it on 127.0.0.1, or sets MASON_PG_PLAIN=1 for a private network.

  ${PROJECT_LINE}

    mason start
    mason start --attach      in the foreground: Ctrl-C stops it
    MASON_PG_HOST=0.0.0.0 mason start --self-signed-tls   the Postgres API for other machines, over TLS

  --attach            stay in the foreground (Ctrl-C stops Mason)
  --self-signed-tls   the Postgres API requires TLS, from a certificate made for this project in .mason/ (kept and
                      served again by every later start with the flag); not with MASON_PG_TLS_CERT / _KEY
  --port <n>          the port the mason commands reach it on (default ${DEFAULT_UI_PORT}, or the next free one)
  --json              as data, once it is up: { running, pid, postgres: { url, host, port, database, sslmode }, next }
`,
  options: {
    port: { type: "string" }, attach: { type: "boolean", default: false }, json: { type: "boolean", default: false },
    "self-signed-tls": { type: "boolean", default: false },
  },
  json: ["running", "pid", "postgres", "next"],
};

async function runDev(argv: string[]): Promise<number> {
  // --replication, --poll and --publication are gone (issue 33): each answered with the edit to make in the sources
  // file, exit 2, before the options are parsed (it would be an unknown option there) and before anything starts. The
  // file is read only when one is given. A decision: `mason start --replication --help` answers the refusal, not the
  // usage — the flag is wrong whatever else the line asks
  const removed = removedStartFlags(argv, () => startSourcesTop(process.cwd()));
  if (removed !== null) return failed("start", { code: "usage", ...removed, next: [["mason start", "each table kept current as its sync: says"], ["mason help production", "sync: and publication:, and what each needs"]] }, { json: wantsJson(argv, DEV) });
  const f = parseCommand(DEV, argv);
  if (typeof f === "number") return f;
  const v = f.values as { port?: string; attach: boolean; json: boolean; "self-signed-tls": boolean };
  if (f.positionals.length) {
    // the database is the project's now: a URL here is the old habit, answered with the new way
    return failed("start", { message: "it takes no database URL: the project has one", code: "usage", why: "mason init <url> made it; .mason/config.json holds it", usage: DEV.usage }, { json: v.json });
  }
  const port = v.port === undefined ? DEFAULT_UI_PORT : Number(v.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return failed("start", { message: `--port must be a port number (1-65535), not ${JSON.stringify(v.port)}`, code: "usage" }, { json: v.json });
  if (!v.attach) return devInBackground(argv, { json: v.json, selfSignedTls: v["self-signed-tls"] });
  return dev({ port, version: version(), selfSignedTls: v["self-signed-tls"] });
}

/** The project's sources file as a person names it (`mason/sources/app.yml`), for a removed flag's answer: the one file
 *  of the project of this folder, else the name every project's has. */
function startSourcesTop(cwd: string): SourcesTop {
  const t = theProject(cwd);
  return "problem" in t ? { shown: "mason/sources/<name>.yml", sync: null, publication: null } : sourcesTop(t.project.root, t.project.folder);
}

export const HELP: CommandSpec = {
  name: "help",
  summary: "the commands by step, or one command's usage: mason help add",
  usage: `usage: mason help [<command> | <guide>]

  The commands by step (mason help), how to use one (mason help add — the same as mason add --help), or a guide,
  offline, short enough to read whole and listing exactly what Mason accepts:

    mason help
    mason help add
${Object.entries(GUIDES).map(([k, v]) => `    mason help ${k.padEnd(14)} ${v}`).join("\n")}
`,
  options: {},
};

async function runHelp(argv: string[]): Promise<number> {
  const f = parseCommand(HELP, argv);
  if (typeof f === "number") return f;
  const [asked, ...rest] = f.positionals;
  if (rest.length) return failed("help", { message: "one command or guide at a time", code: "usage", usage: HELP.usage }, { json: false });
  if (asked === undefined) { process.stdout.write(topUsage()); return 0; }
  if (asked === "version") { process.stdout.write("usage: mason version (or --version, -v): the CLI's version\n"); return 0; }
  if (Object.hasOwn(GUIDES, asked)) { process.stdout.write(await guideText(asked as Guide)); return 0; }
  const cmd = COMMANDS.find((c) => c.name === asked);
  if (cmd) { process.stdout.write(cmd.usage); return 0; }
  return failed("help", { message: `there is no command or guide ${JSON.stringify(asked)}${didYouMean(asked, [...COMMANDS.map((c) => c.name), ...Object.keys(GUIDES)])}`, code: "usage",
    why: `the guides: ${Object.keys(GUIDES).join(", ")}`, next: [["mason help", "every command"]] }, { json: false });
}

/**
 * EVERY COMMAND, IN THE ORDER A FIRST SESSION NEEDS THEM (listed in the order a developer will likely need them, the
 * reference, `mason help`, first because it is read first), under the step each belongs to: `mason --help` prints the
 * steps as headings, so the list reads as the runbook it is. A new command goes into its step here; COMMANDS is
 * derived, so the order is written once.
 */
export const STEPS: ReadonlyArray<[step: string, commands: readonly Command[]]> = [
  ["Learn", [{ ...HELP, run: runHelp }]],
  ["Set up", [{ ...DOCTOR, run: (argv) => doctor(argv) }, { ...INIT, run: (argv) => init(argv) }, { ...DEV, run: runDev }]],
  ["Add your tables", [{ ...TABLES, run: tables }, { ...ADD, run: add }, { ...REMOVE, run: remove }, { ...WAIT, run: wait }]],
  ["Connect", [{ ...USER, run: user }, { ...MCP, run: mcp }, { ...SHARE, run: share }]],
  ["Run", [{ ...STATUS, run: status }, { ...UI, run: ui }, { ...SYNC, run: sync }, { ...LOGS, run: logs }, { ...CANCEL, run: cancel }, { ...USAGE, run: (argv) => usage(argv) }, { ...STOP, run: stop }, { ...DESTROY, run: (argv) => destroy(argv) }]],
  ["Go to production", [{ ...SERVE, run: serve }]],
];

/** Every command, in the order `mason --help` lists them. */
export const COMMANDS: readonly Command[] = STEPS.flatMap(([, commands]) => commands);

/**
 * `mason` ALONE: where you are and what to run next (`mason help` once showed the same as `mason` alone, and read as
 * broken). One line on what Mason is, whether this folder is a project and whether Mason runs for
 * it, then the next command for that moment — and mason help, every command. `mason help` and `mason --help` are the
 * whole list (topUsage).
 */
/** WHAT MASON IS, in one line: the first `mason` alone and `mason --help` print, in the words its reader was told it
 *  in ("a drop-in read replica for analytics"). */
export const TAGLINE = "Mason: a drop-in read replica of your Postgres, for analytics — the tables you add, synced, kept current and served to psql, BI tools and your app.";

export async function orientation(cwd: string, s: Style = styleOut()): Promise<string> {
  const t = theProject(cwd);
  const project = "project" in t ? t.project : null;
  const run = project ? await liveRun(project) : null;
  const rows: Array<[string, string]> = project
    ? [["Project", `${project.config.name}, files in ${project.folder}`], ["Mason", run ? `running (pid ${run.pid})` : "not running"]]
    : [["Project", "none here: mason init makes this folder one"]];
  const next: NextStep[] = !project
    ? [["mason init", "make this folder a project (MASON_DATABASE_URL or DATABASE_URL from .env, or mason init postgres://…)"],
      ["mason init demo", "or try it on a demo database Mason makes itself: nothing to install"],
      ["mason doctor", "what this machine needs for Mason, and whether it has it"]]
    : !run ? [["mason start", "start Mason for this project, in the background"], ["mason status", "the project and its tables"]]
    : [["mason status", "what Mason is doing: its tables, and the last day's slow and refused statements"], ["mason user add <name>", "a user for a BI tool or your app: its password and URL, printed once"]];
  return `${reportText({ headline: TAGLINE, details: rows,
    next: [...next, ["mason help", "every command, and the guides"]] }, s)}\n`;
}

/** `mason --help`: what Mason is, every command with its summary, and where each one's help is. On a terminal the steps are
 *  bold, the commands cyan and every line wrapped at its width under its own column (src/cli/style.ts); anywhere else,
 *  plain and unwrapped. */
export function topUsage(s: Style = styleOut()): string {
  // what each step lists: its commands, and under Learn the guides too (`mason help` shows the guides listed under
  // Learn), so the pages a session reads first are a line each, not a paragraph after the list
  const entries = (step: string, commands: readonly Command[]): Array<[name: string, summary: string]> => [
    ...commands.map((c): [string, string] => [c.name, c.summary]),
    ...(step === "Learn" ? Object.entries(GUIDES).map(([g, what]): [string, string] => [`help ${g}`, what]) : []),
  ];
  const listed = STEPS.map(([step, commands]): [string, Array<[string, string]>] => [step, entries(step, commands)]);
  // the commands' column is the longest COMMAND's, everywhere; a guide's longer name widens Learn alone, so it never
  // pushes every other step's summaries right
  const commandWidth = Math.max(...COMMANDS.map((c) => c.name.length));
  const para = (text: string): string => `  ${wrap(text, s.width, 2)}`;
  const block = (es: Array<[string, string]>): string => {
    const w = Math.max(commandWidth, ...es.map(([name]) => name.length));
    // the column a summary starts in: "    mason " + the longest name + 3
    const col = 4 + "mason ".length + w + 3;
    return es.map(([name, summary]) => `    ${s.cyan(`mason ${name.padEnd(w)}`)}   ${s.dim(wrap(summary, s.width, col))}`).join("\n");
  };
  return [
    `${s.bold("usage:")} mason <command> [options]`,
    "",
    para(`${TAGLINE} Make your app's folder a project (mason init), ` +
      `add tables (mason add, before or after the start), start Mason (mason start), connect a tool (mason user add). It needs Node ${NODE_MIN} or later; mason doctor checks.`),
    para("Try it first with nothing to install: mason init demo, then mason start and mason ui (a demo shop database, hosted by Mason itself)."),
    para(PROJECT_LINE),
    "",
    listed.map(([step, es]) => `  ${s.bold(step)}\n${block(es)}`).join("\n\n"),
    "",
    para("mason <command> --help (or mason help <command>) says how to use one, with examples; the guides are offline and short enough to read whole."),
    para("A command means the project of the folder it runs in (or above it)."),
    para("Every command but help and mcp (whose stdout is the MCP protocol's) takes --json: one JSON object for a program, always with next (what to run " +
      "next); a failure is { error: { code, message, why, fix }, next }. The exit code says how it went: 0 done, 1 failed " +
      "with the reason, 2 a wrong command line, 124 mason wait timed out. Driving Mason from a coding agent: mason help agent."),
    "",
  ].join("\n");
}
