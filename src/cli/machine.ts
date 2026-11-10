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
import { alive, END_GRACE_MS, notAnswering, runState, type DevRun } from "./runs.ts";
import { stopSupervisor, supervisorOf } from "./supervise.ts";
import { STATE_DIR, isProject, projectSource, readProject, theProject, writeConfig, type Project } from "./project.ts";
import { parseSource, type Source } from "./preflight.ts";
import { USERS_FILE } from "../duck/users.ts";
import { SELF_SIGNED_FILES } from "./pg-tls.ts";
import { dropOwnReplication, dropStatements, madeReplication } from "./replication-mode.ts";
import { sourceFileNames } from "./sources.ts";

export const DESTROY_USAGE = `usage: mason destroy [--dry-run] [--json]

  Removes this folder's project's synced data from this machine — its file — and Mason's state in its
  .mason/ (the logs, the request log). Mason is stopped first if it runs. Your files (mason/sources/), .mason/config.json and
  the users (mason user) stay: the next mason start syncs the tables again, and every tool connects as before.

    mason destroy                this folder's project
    mason destroy --dry-run      what it would remove, changing nothing

  --dry-run  list what would go — Mason stopped, the replication slot and Mason's own publication on the database, the
             synced data and state in .mason/ — and change nothing: it stops nothing and never connects to the
             database (the slot and publication are named from what the start that made them recorded)
  --json     as data: { dryRun, destroyed: { project, removedItems: [what, in words], replication (null: nothing on
             the database; else { database, slot, publication (null: one the operator named, never dropped) }), error },
             removed (the same as [{ name, removed: [what], error }], kept until 1.0; not on a dry run), next }

  mason stop keeps the synced data and the state, and the next mason start resumes in seconds; mason destroy frees the disk, and
  the next mason start begins again. In replication mode the slot (and Mason's own publication) are dropped from the
  database too: they hold its WAL for as long as they exist. A demo project's database (mason init demo, in .mason/demo/)
  goes with the synced data: the next mason start makes and seeds it again.

  Exit status: 0 removed (or nothing to remove, or a dry run that found nothing in the way); 1 something could not be
  removed, or on a dry run would not be (said); 2 a wrong command line.
`;

export const DESTROY: CommandSpec & { needs: "project" } = {
  needs: "project",
  name: "destroy",
  summary: "remove this project's synced data and Mason's state from this machine (your files and users stay)",
  usage: DESTROY_USAGE,
  options: { json: { type: "boolean" }, "dry-run": { type: "boolean" } },
  json: ["dryRun", "destroyed", "removed", "next"],
};

/** Wait for `pid` to exit after SIGTERM; throws when it does not within 90 s. */
/** A silent pid Mason cannot tell is its run, in notAnswering's words (why, then the person's way out), on one line. */
function unsureText(p: Project, run: DevRun, unsure: string): string {
  const said = notAnswering(p, run, unsure);
  return `${said.why ?? ""}; ${said.fix ?? ""}`;
}

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
    // a pid Mason cannot tell is its run (src/cli/runs.ts masonProcess): the way out is the person's, never mason stop's SIGKILL
    if (st.unsure !== undefined) throw new Error(`Mason for ${p.config.name} may be running (pid ${st.run.pid}): ${unsureText(p, st.run, st.unsure)}, so nothing was removed`);
    throw new Error(`Mason for ${p.config.name} is running (pid ${st.run.pid}) but does not answer its commands, so nothing was removed: mason stop ends it (SIGKILL after ${END_GRACE_MS / 1000} s), then mason destroy`);
  }
  const run = st.run;
  if (run) { await stopPid(run.pid, `Mason for ${p.config.name}`, isAlive, o.kill); removed.push(`stopped Mason (pid ${run.pid})`); }
  else {
    // between restarts the run is dead and its supervisor waits to start it again over what is removed here
    const sup = await (o.stopSupervisor ?? stopSupervisor)(p.dir);
    if (sup !== null) removed.push(`stopped its supervisor (pid ${sup}), which was about to start it again`);
  }
  // REPLICATION made a publication and a slot on the database (src/cli/replication-mode.ts), recorded by the start or
  // the run that made them (an older start recorded its mode, `changes`): the slot holds its WAL for as long as it
  // exists, so it goes with the copy — and when it cannot, the rest goes and the failure says how
  let replication: string | null = null;
  const target = replicationTarget(p);
  if (target !== null) {
    try {
      if ("problem" in target.on) throw new Error(target.on.problem);
      const source = target.on.source;
      for (const d of await (o.dropReplication ?? dropOwnReplication)(source, target.own, target.from)) removed.push(`${d} from ${source.database}`);
    } catch (e) { replication = `${(e as Error).message}. They hold the database's WAL while they exist: drop them by hand — ${dropStatements(target.own)}`; }
  }
  const gone = stateEntries(p);
  for (const x of gone) fs.rmSync(path.join(p.dir, x), { recursive: true, force: true });
  if (gone.length) removed.push(`${path.join(p.root, STATE_DIR)}/ (${gone.join(", ")})`);
  // the copy is gone: the next start records the database's server again, and nothing is running
  const fresh = readProject(p.root);
  // the slot and publication dropped, nothing names them; when they could not be, the record stays for the next destroy
  if (isProject(fresh)) { fresh.config.running = null; fresh.config.sourceServer = null; if (replication === null) fresh.config.replication = null; writeConfig(p.dir, fresh.config); }
  if (replication) throw new Error(`removed ${removed.join(", ")}; but not its ${target!.objects}: ${replication}`);
  return removed;
}

/**
 * WHAT REPLICATION MADE ON THE DATABASE, AND WHERE IT IS — read from the config and the sources file alone, never by
 * connecting (`mason destroy --dry-run` says it; `removeProject` drops it): null when the project made none. `on` is the
 * database to drop them on, or why it cannot be named.
 */
export function replicationTarget(p: Project): { own: ReturnType<typeof madeReplication>; objects: string; from: { systemIdentifier: string | null; database: string } | null; on: { source: Source } | { problem: string } } | null {
  if ((p.config.replication ?? null) === null && p.config.changes !== "replication") return null;
  // the slot, and the publication only when it is Mason's own: one the operator named is its owner's, left as it is
  const src = projectSource(p);
  // what the start that made them recorded (madeReplication); a project with no record names them by its one sources file
  const own = madeReplication(p.config, "message" in src ? (sourceFileNames(p.folder)[0] ?? "app.yml").replace(/\.ya?ml$/, "") : src.name);
  const objects = own.owned ? "publication and replication slot" : "replication slot";
  const from = p.config.sourceServer ?? null;
  const parsed = "message" in src ? { problem: `the database's URL cannot be read: ${src.message}` } : parseSource(src.resolved, src.from);
  if ("problem" in parsed) return { own, objects, from, on: { problem: parsed.problem } };
  // the slot is on the database the copy came from: a url: edited since names another, where dropping finds nothing
  // and the real slot goes on holding its WAL (the review of the sources file)
  if (from !== null && from.database !== parsed.source.database) {
    return { own, objects, from, on: { problem: `the sources file names ${parsed.source.database} now, and the synced data came from ${from.database}, where the slot is: ` +
      `put that database's URL back in the sources file and run mason destroy again, or drop them on ${from.database} by hand` } };
  }
  return { own, objects, from, on: { source: parsed.source } };
}

/**
 * WHAT `.mason/` HOLDS THAT DESTROY REMOVES. The users (src/duck/users.ts) are logins a BI tool keeps, like the API key
 * their passwords are made with, and the self-signed certificate is the fingerprint a tool pinned (the review of the
 * cut: a new one at the next start, and config.selfSignedTls stale): the next start copies again, and every tool
 * connects as before. A demo project's database (`.mason/demo/`, src/cli/demo.ts) is state like the copy: it goes, and
 * config.demo stays, so the next start makes and seeds it again.
 */
function stateEntries(p: Project): string[] {
  const kept = new Set(["config.json", USERS_FILE, SELF_SIGNED_FILES.cert, SELF_SIGNED_FILES.key]);
  return fs.existsSync(p.dir) ? fs.readdirSync(p.dir).filter((x) => !kept.has(x)).sort() : [];
}

/** What replication made, as `--json` names it: the database it is on (the one the synced data came from when the
 *  sources file cannot say it; null when neither can), the slot, and the publication when it is Mason's own. */
function replicationFacts(t: NonNullable<ReturnType<typeof replicationTarget>>): NonNullable<DestroyPlan["replication"]> {
  return { database: "source" in t.on ? t.on.source.database : t.from?.database ?? null, slot: t.own.slot, publication: t.own.owned ? t.own.publication : null };
}

/** What `mason destroy` would do, as `--dry-run` says it: `items` in words, `replication` what it would drop on the
 *  database (null: nothing), `error` why it would remove nothing or not all of it (null: it would go whole). */
export interface DestroyPlan {
  items: string[];
  replication: { database: string | null; slot: string; publication: string | null } | null;
  error: string | null;
}

/**
 * `mason destroy --dry-run`: WHAT WOULD GO, CHANGING NOTHING. It reads the run's state (`/api/ping`, which changes nothing),
 * the supervisor's record, the config, the sources file and `.mason/`'s names — never the database: what replication
 * made there is named from the config's record, exactly what `removeProject` would drop.
 */
export async function destroyPlan(p: Project, o: { state?: typeof runState; supervisor?: (home: string) => number | null } = {}): Promise<DestroyPlan> {
  const st = await (o.state ?? runState)(p);
  if (st.kind === "hung") {
    if (st.unsure !== undefined) return { items: [], replication: null, error: `Mason for ${p.config.name} may be running (pid ${st.run.pid}): ${unsureText(p, st.run, st.unsure)}, so mason destroy would remove nothing` };
    return { items: [], replication: null, error: `Mason for ${p.config.name} is running (pid ${st.run.pid}) but does not answer its commands, so mason destroy would remove nothing: mason stop ends it (SIGKILL after ${END_GRACE_MS / 1000} s), then mason destroy` };
  }
  const items: string[] = [];
  if (st.run) items.push(`Mason (pid ${st.run.pid}), stopped first`);
  else {
    const sup = (o.supervisor ?? supervisorOf)(p.dir);
    if (sup !== null) items.push(`its supervisor (pid ${sup}), stopped first: it is about to start Mason again`);
  }
  let replication: DestroyPlan["replication"] = null, error: string | null = null;
  const target = replicationTarget(p);
  if (target !== null) {
    replication = replicationFacts(target);
    const on = replication.database === null ? "" : ` on ${replication.database}`;
    items.push(`replication slot ${target.own.slot}${on}`);
    if (target.own.owned) items.push(`publication ${target.own.publication}${on}`);
    if ("problem" in target.on) error = `the rest would go, but not its ${target.objects}: ${target.on.problem}`;
  }
  const gone = stateEntries(p);
  if (gone.length) items.push(`${path.join(p.root, STATE_DIR)}/ (${gone.join(", ")})`);
  return { items, replication, error };
}

export async function destroy(argv: string[], deps: { removeProject?: typeof removeProject; destroyPlan?: typeof destroyPlan; io?: Io; cwd?: string } = {}): Promise<number> {
  const io = deps.io ?? STDIO;
  const { out } = io;
  const f = parseCommand(DESTROY, argv);
  if (typeof f === "number") return f;
  const json = f.values.json === true;
  const dryRun = f.values["dry-run"] === true;
  if (f.positionals.length) return failed("destroy", { message: `it takes no name (${f.positionals.join(" ")}): a project is its folder`, code: "usage", usage: DESTROY_USAGE, fix: "cd into the project's folder, then mason destroy" }, { json, io });
  const t = theProject(deps.cwd ?? process.cwd());
  if ("problem" in t) return failed("destroy", t, { json, io });
  const name = t.project.config.name;
  const kept = `your files in ${t.project.folder}, .mason/config.json and the users` +
    // the demo database is state like the copy (src/cli/demo.ts): it goes, and config.demo stays to make it again
    (t.project.config.demo === true ? ` — not the demo database, which ${dryRun ? "would go" : "went"} with the synced data: the next mason start seeds it again` : "");
  if (dryRun) {
    const plan = await (deps.destroyPlan ?? destroyPlan)(t.project);
    const next: NextStep[] = plan.error ? [] : [["mason destroy", "remove them"]];
    if (json) { out(jsonText(DESTROY, { dryRun: true, destroyed: { project: name, removedItems: plan.items, replication: plan.replication, error: plan.error } }, next)); return plan.error ? 1 : 0; }
    if (plan.error) {
      return failed("destroy", { message: `${name}: ${plan.error}`, code: "failed", why: plan.items.length ? `mason destroy would remove: ${plan.items.join(", ")}` : undefined,
        fix: "nothing was changed (a dry run)" }, { json: false, io });
    }
    out(withEnd(reportText({
      headline: plan.items.length ? `mason destroy would remove ${name}'s synced data and state; nothing was changed` : `Nothing is left of ${name} to remove; nothing was changed`,
      details: [...(plan.items.length ? [["would remove", plan.items.join(", ")] as const] : []), ["would keep", kept]],
    }), { next }));
    return 0;
  }
  // what replication made on the database, named before it goes (read from the config: nothing is connected for it)
  const target = replicationTarget(t.project);
  const replication = target === null ? null : replicationFacts(target);
  let result: { name: string; removed: string[]; error?: string };
  try { result = { name, removed: await (deps.removeProject ?? removeProject)(t.project) }; }
  catch (e) { result = { name, removed: [], error: (e as Error).message }; }
  const next: NextStep[] = result.error ? [] : [["mason start", "syncs the tables again"]];
  if (json) {
    out(jsonText(DESTROY, { dryRun: false, destroyed: { project: name, removedItems: result.removed, replication, error: result.error ?? null }, removed: [result] }, next));
    return result.error ? 1 : 0;
  }
  if (result.error) return failed("destroy", { message: `${name}: ${result.error}`, code: "failed" }, { json: false, io });
  out(withEnd(reportText({
    headline: result.removed.length ? `Removed ${name}` : `Nothing was left of ${name} to remove`,
    details: [...(result.removed.length ? [["removed", result.removed.join(", ")] as const] : []), ["kept", kept]],
  }), { next }));
  return 0;
}
