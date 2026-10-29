/**
 * `mason start` IN THE BACKGROUND (an interface as good for people as for coding agents).
 * The run is a process of its own (`mason start … --attach`, detached, its terminal the file `dev.log` in the run's
 * folder): this shows the run's start as it happens, and returns once the run says it is ready — or with the run's own
 * exit code when it stops first (a wrong password), its reason already shown. A coding agent's shell can
 * then go on (`mason tables`, `mason add`, `mason wait`), and a person's terminal is theirs again.
 *
 * A second `mason start` for a project whose run is up does not start another: it says so and returns 0, so running it
 * again is always safe.
 *
 * What is detached is the run's SUPERVISOR (src/cli/supervise.ts), which starts the run and starts it again if it dies
 * once it was ready; a start that fails ends the supervisor with the run's own exit code, so this reads it as before.
 */
import { choosePgPort } from "./ports.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runnable } from "../lib/runnable.ts";
import { READY, STEP_MARK } from "./dev.ts";
import { liveRun } from "./runs.ts";
import { projectSource, theProject } from "./project.ts";
import { runListenerSettings } from "./pg-tls.ts";
import { demoChangesRefusal, demoPort } from "./demo.ts";
import type { ChangeSource } from "../cdc/poll.ts";
import { endText, failed, jsonText, nextBlock, type NextStep } from "./command.ts";
import { pollMsRetired } from "../lib/table-sync.ts";
import { historyDaysRenamed } from "../duck/history.ts";
import { DEV } from "./registry.ts";
import { UI } from "./ui.ts";
import { out as styleOut, stepRenderer } from "./style.ts";
import { postgresLink, withoutPlaceholders, type PostgresLink } from "./pg-url.ts";

const say = (m: string): void => { process.stdout.write(`${m}\n`); };
const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts");
const SUPERVISE = path.join(path.dirname(fileURLToPath(import.meta.url)), "supervise.ts");

/** The commands to run next, as `mason start` prints them once the run is up: one a line, what each does beside it
 *  (not `mason status | mason logs | mason stop` on one line). */
export const NEXT_STEPS: NextStep[] = [
  // the web page first: a first-time user's most useful next step (the run serves it; mason ui opens it, signed in)
  ["mason ui", UI.summary],
  ["mason tables", "the database's tables, and what you can add"],
  ["mason add <table>", "copy a table into Mason"],
  ["mason user add <name>", "a user for a BI tool or your app: its password and URL, printed once"],
  ["mason status", "what Mason is doing"],
  ["mason logs", "its log: every copy, poll and statement"],
  ["mason stop", "stop Mason; the next mason start resumes where it stopped"],
];

/** The ports a demo project's database takes (its URL's port, read as the run reads it), for the API's choice to avoid;
 *  none for any other project. A sources file or a URL that cannot be read gives none HERE: the run refuses it in its
 *  own words (its source step, its demo step), shown by this start as every other refusal of the run's is. */
function demoPortsOf(project: Parameters<typeof projectSource>[0]): Set<number> {
  if (project.config.demo !== true) return new Set();
  const src = projectSource(project, process.env);
  if ("message" in src) return new Set();
  const at = demoPort(src.resolved, src.from);
  return new Set("port" in at ? [at.port] : []);
}

/** `args` are `mason start`'s own, passed on to the run with --attach. */
export async function devInBackground(args: readonly string[], o: { json: boolean; selfSignedTls: boolean; changes?: ChangeSource | null }): Promise<number> {
  const t = theProject(process.cwd());
  if ("problem" in t) return failed("start", t, { json: o.json });
  const home = t.project.dir;
  const other = await liveRun(t.project);
  if (other !== null) {
    // running already is what start wants: said, exit 0, the same answer as a start (what is up, and what to run)
    if (o.json) { say(jsonText(DEV, { running: true, pid: other.pid, postgres: postgresLink(other.postgresUrl) }, [["mason status", "what it is doing"], ["mason stop", "stop it"]])); return 0; }
    say(`Mason is already running for ${t.project.config.name} (pid ${other.pid}).`);
    say(nextBlock([["mason status", "what it is doing"], ["mason stop", "stop it"]]));
    return 0;
  }
  // a demo project with --replication (src/cli/demo.ts): refused here too, where it is read, before a run is spawned
  const demoRefused = demoChangesRefusal(t.project.config, o.changes ?? null);
  if (demoRefused) return failed("start", demoRefused, { json: o.json });
  // a setting no longer read (MASON_POLL_MS: each table's sync: says how often it is polled), refused here too, where
  // the person (or --json) reads it, by the run's own check (src/lib/table-sync.ts)
  const pollMs = pollMsRetired(process.env);
  if (pollMs !== null) return failed("start", { code: "refused", ...pollMs }, { json: o.json });
  // MASON_REQUEST_LOG_DAYS is MASON_HISTORY_DAYS now (src/duck/history.ts): refused here as in the run
  const renamed = historyDaysRenamed(process.env);
  if (renamed !== null) return failed("start", { code: "refused", ...renamed }, { json: o.json });
  // a MASON_PG_PORT that is no port, or is held, is refused HERE, where the person (or --json) reads it, before a run is
  // spawned; the run checks again for itself (choosePgPort, src/cli/ports.ts), since a port may be taken in between.
  // A demo project's database port (its URL's, src/cli/demo.ts demoPort) is avoided as the run avoids it
  const pg = await choosePgPort(process.env.MASON_PG_PORT, demoPortsOf(t.project), t.project.config.pgPort ?? null);
  if ("problem" in pg) return failed("start", pg, { json: o.json });
  // and so is a listener off loopback without TLS, by the run's own check (src/cli/pg-tls.ts): read, never written
  const listen = runListenerSettings(process.env, { port: pg.port, selfSigned: o.selfSignedTls, home });
  if ("problem" in listen) return failed("start", listen, { json: o.json });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // the run's terminal: its setup URL carries the run's token and it prints the API key, so only the developer reads it
  const logFile = path.join(home, "dev.log");
  const fd = fs.openSync(logFile, "a", 0o600);
  fs.chmodSync(logFile, 0o600);
  const from = fs.fstatSync(fd).size;
  fs.writeSync(fd, `\n--- mason start ${new Date().toISOString()} ---\n`);
  // the run is started IN the project's root, so it finds the same project
  const run = [process.execPath, runnable(MAIN), "start", ...args.filter((a) => a !== "--json"), "--attach"];
  const child = spawn(process.execPath, [runnable(SUPERVISE), home, logFile, ...run],
    { detached: true, stdio: ["ignore", fd, fd], cwd: t.project.root, env: process.env });
  fs.closeSync(fd);
  let exited: number | null = null;
  child.on("exit", (code, signal) => { exited = code ?? (signal ? 1 : 0); });
  // Ctrl-C while it starts stops the start too: nothing is left running that nobody asked for
  const abort = (): void => { child.kill("SIGTERM"); };
  process.on("SIGINT", abort);
  // what it does, as a checklist (as `mason init` draws its own): the run's steps, drawn as they happen; under
  // --json nothing until it is up (one document), the lines after the last step kept as a failure's why
  const st = styleOut();
  const line = (x: string): void => { if (!o.json) say(x); };
  line(st.bold(`Starting Mason for ${t.project.config.name}`));
  const steps = stepRenderer({ line, live: !o.json && process.stdout.isTTY ? { write: (x) => { process.stdout.write(x); } } : null, style: st });
  let begun = false;
  let offset = from;
  let partial = "";
  let postgres: PostgresLink | null = null;
  const since: string[] = [];   // the run's lines after its last step: a failure's reasons
  try {
    for (;;) {
      const size = fs.statSync(logFile).size;
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        const r = fs.openSync(logFile, "r");
        try { fs.readSync(r, buf, 0, buf.length, offset); } finally { fs.closeSync(r); }
        offset = size;
        const lines = (partial + buf.toString()).split("\n");
        partial = lines.pop() ?? "";
        for (const l of lines) {
          if (l.startsWith("--- mason start ")) continue;
          if (l === "" && steps.open() === null && !begun) continue;   // the log's spacing before the first step
          begun = true;
          if (l === READY) {
            child.unref();
            const next = NEXT_STEPS;
            // the run's pid, as it recorded it (the child is its supervisor), the one mason stop signals
            const pid = (JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as { running?: { pid?: number } | null }).running?.pid ?? null;
            if (o.json) say(jsonText(DEV, { running: true, pid, postgres }, next));
            else say(endText({ next }, st));
            return 0;
          }
          // the run's steps (src/cli/dev.ts STEP_MARK) as a checklist; any other line as it came
          if (l.startsWith(STEP_MARK.begin)) { since.length = 0; steps.begin(l.slice(STEP_MARK.begin.length)); continue; }
          if (l.startsWith(STEP_MARK.done)) { since.length = 0; steps.done(l.slice(STEP_MARK.done.length)); continue; }
          if (l.startsWith(STEP_MARK.fail)) { since.length = 0; steps.fail(l.slice(STEP_MARK.fail.length)); continue; }
          // the run's line (src/cli/dev.ts: "Postgres  <url>", the URL in its shown form, `withPlaceholders`: postgres://<user>:<password>@…)
          const pgLine = /^\s+Postgres\s+(postgres:\/\/<user>:<password>@\S+)/.exec(l);
          if (pgLine) { postgres = postgresLink(withoutPlaceholders(pgLine[1]!)); steps.print(`  ${st.dim("Postgres API")}  ${pgLine[1]!}  ${st.dim("(mason user add <name> makes a user)")}`); continue; }
          if (/^\s+Web UI\s+mason ui\b/.test(l)) { steps.print(`  ${st.dim("Web UI".padEnd("Postgres API".length))}  ${st.cyan("mason ui")}  ${st.dim(`(${UI.summary})`)}`); continue; }
          // a demo project's line (src/cli/dev.ts: "Demo  a new order lands every <n> s: …"), in the same column
          const demoLine = /^\s+Demo\s{2}(.+)$/.exec(l);
          if (demoLine) { steps.print(`  ${st.dim("Demo".padEnd("Postgres API".length))}  ${demoLine[1]!}`); continue; }
          if (l.trim()) since.push(l.trim().replace(/^mason start: /, ""));
          steps.print(l);
        }
      }
      if (exited !== null) {
        if (steps.open() !== null) steps.fail();
        if (partial) since.push(partial.trim());
        // the run's own last words are the reason (a wrong password), already shown line by line to a person
        return failed("start", { message: `the run stopped before it was ready (exit ${exited})`, code: "failed", why: o.json && since.length ? since.join("\n") : undefined,
          fix: `the whole log: ${logFile}`, exit: exited === 0 ? 1 : exited }, { json: o.json });
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    process.off("SIGINT", abort);
  }
}
