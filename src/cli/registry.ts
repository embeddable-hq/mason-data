/**
 * EVERY `mason` COMMAND, AND THE HELP MADE FROM THEM. `mason --help` is generated from this list — each
 * command's summary, in this order — so a command cannot exist without being listed, and tests/cli-help.test.ts holds
 * each one to src/cli/command.ts's rules (its own --help, an example, every option documented).
 */
import { failed, parseCommand, reportText, type Command, type CommandSpec, type NextStep } from "./command.ts";
import { dev } from "./dev.ts";
import { devInBackground } from "./background.ts";
import { ADD, LOGS, REMOVE, STATUS, STOP, TABLES, WAIT, add, logs, remove, status, stop, tables, wait } from "./commands.ts";
import { USER, user } from "./user.ts";
import { UI, ui } from "./ui.ts";
import { GUIDES, guideText, type Guide } from "./guides.ts";
import { DOCTOR, NODE_MIN, doctor } from "./doctor.ts";
import { DESTROY, destroy } from "./machine.ts";
import { INIT, init } from "./init.ts";
import { SYNC, sync } from "./sync.ts";
import { USAGE, usage } from "./usage.ts";
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
  usage: `usage: mason start [--attach] [--replication [--publication <name>] | --poll] [--self-signed-tls] [--port <n>] [--json]

  Starts Mason for the project of this folder (mason init made it): one process, which copies the tables you add
  (mason add) from the project's database into its own file, keeps them current, and answers the Postgres protocol
  for BI tools and your app. It only reads the database (SELECT): no wal_level, replication slot or publication is
  needed or made. It returns once Mason is up; run it again any time (it says so when Mason is already running). The
  copy and Mason's state stay between runs: the next start resumes.

  With --replication it reads the database's change log instead: it needs wal_level = logical and a user that may
  replicate, and makes its own publication and replication slot on the database (mason destroy, or mason start --poll,
  drops them). The project keeps the mode until --poll; a switch keeps the copies and catches each table up by one
  poll. --publication <name> (else PG_PUBLICATION) names a publication that is the database owner's: it is read as it
  is, verified to carry every added table and column, and never created, altered or dropped — Mason makes only its
  slot. A read replica needs one (it takes no CREATE PUBLICATION). The name is kept with the project, so the next
  mason start --replication reads it again.

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
    mason start --replication read the change log, as production does
    mason start --replication --publication app_pub   through the database owner's publication
    MASON_PG_HOST=0.0.0.0 mason start --self-signed-tls   the Postgres API for other machines, over TLS

  --attach            stay in the foreground (Ctrl-C stops Mason)
  --replication       read the database's changes from its change log (logical replication), as production does
  --publication <name>  with --replication: the publication to read, the owner's, never altered (PG_PUBLICATION;
                      default: Mason's own, mason_dev_<project>_<source>)
  --poll              read them with SELECTs (the default; takes back --replication)
  --self-signed-tls   the Postgres API requires TLS, from a certificate made for this project in .mason/ (kept and
                      served again by every later start with the flag); not with MASON_PG_TLS_CERT / _KEY
  --port <n>          the port the mason commands reach it on (default 4039, or the next free one)
  --json              as data, once it is up: { running, pid, postgres: { url, host, port, database, sslmode }, next }
`,
  options: {
    port: { type: "string" }, attach: { type: "boolean", default: false }, json: { type: "boolean", default: false },
    replication: { type: "boolean", default: false }, poll: { type: "boolean", default: false }, publication: { type: "string" },
    "self-signed-tls": { type: "boolean", default: false },
  },
  json: ["running", "pid", "postgres", "next"],
};

async function runDev(argv: string[]): Promise<number> {
  const f = parseCommand(DEV, argv);
  if (typeof f === "number") return f;
  const v = f.values as { port?: string; attach: boolean; json: boolean; replication: boolean; poll: boolean; publication?: string; "self-signed-tls": boolean };
  if (v.replication && v.poll) return failed("start", { message: "--replication or --poll, not both", code: "usage", usage: DEV.usage }, { json: v.json });
  if (v.publication !== undefined && v.poll) return failed("start", { message: "--publication goes with --replication, not --poll", code: "usage", usage: DEV.usage }, { json: v.json });
  if (v.publication !== undefined && !/^\S+$/.test(v.publication)) return failed("start", { message: `--publication must name a publication, not ${JSON.stringify(v.publication)}`, code: "usage", usage: DEV.usage }, { json: v.json });
  if (f.positionals.length) {
    // the database is the project's now: a URL here is the old habit, answered with the new way
    return failed("start", { message: "it takes no database URL: the project has one", code: "usage", why: "mason init <url> made it; .mason/config.json holds it", usage: DEV.usage }, { json: v.json });
  }
  const port = v.port === undefined ? 4039 : Number(v.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return failed("start", { message: `--port must be a port number (1-65535), not ${JSON.stringify(v.port)}`, code: "usage" }, { json: v.json });
  if (!v.attach) return devInBackground(argv, { json: v.json, selfSignedTls: v["self-signed-tls"], changes: v.replication ? "replication" : v.poll ? "poll" : null });
  return dev({ port, version: version(), changes: v.replication ? "replication" : v.poll ? "poll" : null, publication: v.publication ?? null, selfSignedTls: v["self-signed-tls"] });
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
  ["Connect", [{ ...USER, run: user }]],
  ["Run", [{ ...STATUS, run: status }, { ...UI, run: ui }, { ...SYNC, run: sync }, { ...LOGS, run: logs }, { ...USAGE, run: (argv) => usage(argv) }, { ...STOP, run: stop }, { ...DESTROY, run: (argv) => destroy(argv) }]],
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
export async function orientation(cwd: string, s: Style = styleOut()): Promise<string> {
  const t = theProject(cwd);
  const project = "project" in t ? t.project : null;
  const run = project ? await liveRun(project) : null;
  const rows: Array<[string, string]> = project
    ? [["Project", `${project.config.name}, files in ${project.folder}`], ["Mason", run ? `running (pid ${run.pid})` : "not running"]]
    : [["Project", "none here: mason init makes this folder one"]];
  const next: NextStep[] = !project
    ? [["mason init", "make this folder a project (DATABASE_URL from .env, or mason init postgres://…)"],
      ["mason init demo", "or try it on a demo database Mason makes itself: nothing to install"],
      ["mason doctor", "what this machine needs for Mason, and whether it has it"]]
    : !run ? [["mason start", "start Mason for this project, in the background"], ["mason status", "the project and its tables"]]
    : [["mason status", "what Mason is doing: its tables, and the last day's slow and refused statements"], ["mason user add <name>", "a user for a BI tool or your app: its password and URL, printed once"]];
  return `${reportText({ headline: "Mason: your Postgres tables, copied and served to BI tools and your app.", details: rows,
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
    para("Mason: your Postgres tables, copied and served to BI tools and your app. Make your app's folder a project (mason init), " +
      `add tables (mason add, before or after the start), start Mason (mason start), connect a tool (mason user add). It needs Node ${NODE_MIN} or later; mason doctor checks.`),
    para(PROJECT_LINE),
    "",
    listed.map(([step, es]) => `  ${s.bold(step)}\n${block(es)}`).join("\n\n"),
    "",
    para("mason <command> --help (or mason help <command>) says how to use one, with examples; the guides are offline and short enough to read whole."),
    para("A command means the project of the folder it runs in (or above it)."),
    para("Every command but help takes --json: one JSON object for a program, always with next (what to run " +
      "next); a failure is { error: { code, message, why, fix }, next }. The exit code says how it went: 0 done, 1 failed " +
      "with the reason, 2 a wrong command line, 124 mason wait timed out. Driving Mason from a coding agent: mason help agent."),
    "",
  ].join("\n");
}
