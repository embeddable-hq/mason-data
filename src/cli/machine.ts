/**
 * `mason destroy` — WHAT MASON HAS ON THIS MACHINE FOR A PROJECT, REMOVED (it was not clear how to purge everything, or
 * even what still existed; named `destroy` so the CLI works more like docker's): the project's copy of the data (its
 * DuckDB file) and its state in .mason/ — never its files, never .mason/config.json and never its users, so `mason
 * start` begins again from the files and every tool connects as before. It means the project of the folder it runs in:
 * a project is its folder (`mason list` was dropped; nothing on the machine lists them).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { STDIO, failed, jsonText, parseCommand, reportText, withEnd, type CommandSpec, type Io, type NextStep } from "./command.ts";
import { alive, END_GRACE_MS, runState } from "./runs.ts";
import { stopSupervisor } from "./supervise.ts";
import { STATE_DIR, isProject, projectSource, readProject, theProject, writeConfig, type Project } from "./project.ts";
import { parseSource } from "./preflight.ts";
import { USERS_FILE } from "../duck/users.ts";
import { SELF_SIGNED_FILES } from "./pg-tls.ts";
import { dropOwnReplication, dropStatements, madeReplication } from "./replication-mode.ts";
import { sourceFileNames } from "./sources.ts";

export const DESTROY_USAGE = `usage: mason destroy [--json]

  Removes this folder's project's copy of your data from this machine — its file — and Mason's state in its
  .mason/ (the logs, the request log). Mason is stopped first if it runs. Your files (mason/sources/), .mason/config.json and
  the users (mason user) stay: the next mason start copies the tables again, and every tool connects as before.

    mason destroy                this folder's project

  mason stop keeps the copy and the state, and the next mason start resumes in seconds; mason destroy frees the disk, and
  the next mason start begins again. In replication mode the slot (and Mason's own publication) are dropped from the
  database too: they hold its WAL for as long as they exist.

  --json   as data: { removed: [{ name, removed: [what], error }], next }

  Exit status: 0 removed (or nothing to remove); 1 something could not be removed (said); 2 a wrong command line.
`;

export const DESTROY: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "destroy",
  summary: "remove this project's copy of the data and Mason's state from this machine (your files and users stay)",
  usage: DESTROY_USAGE,
  options: { json: { type: "boolean" } },
  json: ["removed", "next"],
};

/** Wait for `pid` to exit after SIGTERM; throws when it does not within 90 s. */
async function stopPid(pid: number, what: string, isAlive: (pid: number) => boolean, kill: (pid: number) => void = (p) => process.kill(p, "SIGTERM")): Promise<void> {
  kill(pid);
  const until = Date.now() + 90_000;
  while (isAlive(pid) && Date.now() < until) await new Promise((res) => setTimeout(res, 250));
  if (isAlive(pid)) throw new Error(`${what} (pid ${pid}) is still running after 90 s: mason logs shows what it is doing`);
}

/** Stop the project's run if it is up, drop its replication objects, and empty its .mason/ but for the config and the users. */
export async function removeProject(p: Project, o: { isAlive?: (pid: number) => boolean; state?: typeof runState; kill?: (pid: number) => void; dropReplication?: typeof dropOwnReplication; stopSupervisor?: typeof stopSupervisor } = {}): Promise<string[]> {
  const isAlive = o.isAlive ?? alive;
  const removed: string[] = [];
  const st = await (o.state ?? runState)(p);
  // A RUN THAT IS ALIVE AND DOES NOT ANSWER (src/cli/runs.ts "alive and silent"; on the test server the copy
  // was deleted under it, and the hung process kept the 58 GB file open): nothing is removed; mason stop ends it first
  if (st.kind === "hung") {
    throw new Error(`Mason for ${p.config.name} is running (pid ${st.run.pid}) but does not answer its commands, so nothing was removed: mason stop ends it (SIGKILL after ${END_GRACE_MS / 1000} s), then mason destroy`);
  }
  const run = st.run;
  if (run) { await stopPid(run.pid, `Mason for ${p.config.name}`, isAlive, o.kill); removed.push(`stopped Mason (pid ${run.pid})`); }
  else {
    // between restarts the run is dead and its supervisor waits to start it again over what is removed here
    const sup = await (o.stopSupervisor ?? stopSupervisor)(p.dir);
    if (sup !== null) removed.push(`stopped its supervisor (pid ${sup}), which was about to start it again`);
  }
  // REPLICATION MODE made a publication and a slot on the database (src/cli/replication-mode.ts): the slot holds its WAL
  // for as long as it exists, so it goes with the copy — and when it cannot, the rest goes and the failure says how
  let replication: string | null = null;
  let objects = "publication and replication slot";
  if (p.config.changes === "replication") {
    // the slot, and the publication only when it is Mason's own: one the operator named is its owner's, left as it is
    const src = projectSource(p);
    // what the start that made them recorded (madeReplication); a project with no record names them by its one sources file
    const own = madeReplication(p.config, "message" in src ? (sourceFileNames(p.folder)[0] ?? "app.yml").replace(/\.ya?ml$/, "") : src.name);
    if (!own.owned) objects = "replication slot";
    const parsed = "message" in src ? { problem: `the database's URL cannot be read: ${src.message}` } : parseSource(src.resolved);
    try {
      if ("problem" in parsed) throw new Error(parsed.problem);
      // the slot is on the database the copy came from: a url: edited since names another, where dropping finds nothing
      // and the real slot goes on holding its WAL (the review of the sources file)
      const from = p.config.sourceServer ?? null;
      if (from !== null && from.database !== parsed.source.database) {
        throw new Error(`the sources file names ${parsed.source.database} now, and the copy came from ${from.database}, where the slot is: ` +
          `put that database's URL back in the sources file and run mason destroy again, or drop them on ${from.database} by hand`);
      }
      for (const d of await (o.dropReplication ?? dropOwnReplication)(parsed.source, own, from)) removed.push(`${d} from ${parsed.source.database}`);
    } catch (e) { replication = `${(e as Error).message}. They hold the database's WAL while they exist: drop them by hand — ${dropStatements(own)}`; }
  }
  // the users (src/duck/users.ts) are logins a BI tool keeps, like the API key their passwords are made with, and the
  // self-signed certificate is the fingerprint a tool pinned (the review of the cut: a new one at the next
  // start, and config.selfSignedTls stale): the next start copies again, and every tool connects as before
  const kept = new Set(["config.json", USERS_FILE, SELF_SIGNED_FILES.cert, SELF_SIGNED_FILES.key]);
  const gone = fs.existsSync(p.dir) ? fs.readdirSync(p.dir).filter((x) => !kept.has(x)) : [];
  for (const x of gone) fs.rmSync(path.join(p.dir, x), { recursive: true, force: true });
  if (gone.length) removed.push(`${path.join(p.root, STATE_DIR)}/ (${gone.join(", ")})`);
  // the copy is gone: the next start records the database's server again, and nothing is running
  const fresh = readProject(p.root);
  // the slot and publication dropped, nothing names them; when they could not be, the record stays for the next destroy
  if (isProject(fresh)) { fresh.config.running = null; fresh.config.sourceServer = null; if (replication === null) fresh.config.replication = null; writeConfig(p.dir, fresh.config); }
  if (replication) throw new Error(`removed ${removed.join(", ")}; but not its ${objects}: ${replication}`);
  return removed;
}

export async function destroy(argv: string[], deps: { removeProject?: typeof removeProject; io?: Io; cwd?: string } = {}): Promise<number> {
  const io = deps.io ?? STDIO;
  const { out } = io;
  const f = parseCommand(DESTROY, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  if (f.positionals.length) return failed("destroy", { message: `it takes no name (${f.positionals.join(" ")}): a project is its folder`, code: "usage", usage: DESTROY_USAGE, fix: "cd into the project's folder, then mason destroy" }, { json, io });
  const t = theProject(deps.cwd ?? process.cwd());
  if ("problem" in t) return failed("destroy", t, { json, io });
  const name = t.project.config.name;
  let result: { name: string; removed: string[]; error?: string };
  try { result = { name, removed: await (deps.removeProject ?? removeProject)(t.project) }; }
  catch (e) { result = { name, removed: [], error: (e as Error).message }; }
  const next: NextStep[] = result.error ? [] : [["mason start", "copies the tables again"]];
  if (json) { out(jsonText(DESTROY, { removed: [result] }, next)); return result.error ? 1 : 0; }
  if (result.error) return failed("destroy", { message: `${name}: ${result.error}`, code: "failed" }, { json: false, io });
  out(withEnd(reportText({
    headline: result.removed.length ? `Removed ${name}` : `Nothing was left of ${name} to remove`,
    details: [...(result.removed.length ? [["removed", result.removed.join(", ")] as const] : []), ["kept", `your files in ${t.project.folder}, .mason/config.json and the users`]],
  }), { next }));
  return 0;
}
