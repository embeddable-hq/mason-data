/**
 * WHETHER MASON IS RUNNING FOR A PROJECT, and how a command reaches it (one run per project).
 * `mason start` writes what its commands need into the project's config (`.mason/config.json` `running`, src/cli/project.ts):
 * its pid, its Postgres API, and the command server it answers on with the run's token.
 *
 * UP MEANS IT ANSWERS: a pid alone is not proof — after a reboot the operating system hands the number to
 * another process, and a `mason start` then refused as "already running" a run that did not exist. A run is up when
 * its command server answers `/api/ping` with the run's own token and pid (`answers`).
 *
 * ALIVE AND SILENT IS A THIRD STATE (on the test server a run hung — its main thread blocked — with every port
 * held; `mason stop` read the silence as "not running" and `mason destroy` deleted the copy under it, which the hung
 * process kept open). A pid that is alive, that is still the process the run recorded (`masonProcess`: after a reboot
 * the number is another process's), and that does not answer is HUNG (`runState`): a command says so and names the way
 * out, `mason stop` ends it (`endRun`: SIGTERM, then SIGKILL), and `mason destroy` removes nothing under it.
 *
 * WHICH PROCESS IS THE RUN is what the run itself records where the process can be read (issue 798: a `mason serve`
 * run's command line did not match `start … --attach`, so a hung server read as not running and its project as free).
 * Every run, however it was started (`mason start`, `mason serve` in the image or by hand, under a supervisor, through
 * npx or a checkout), records its own pid and its own start (`processStart`) in `running`, and the pid is that run only
 * while the process holding it started at that same moment. Where that start cannot be read, or the record has none (an
 * earlier Mason wrote it, or a platform that cannot say), the pid is a run when its arguments are a run's
 * (`runArguments`: node, Mason's entry, then `serve` or `start … --attach`); a process neither can read is no run, as
 * before (Windows, a /proc this user may not read).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { theProject, type PostgresListener, type Project } from "./project.ts";
import type { Problem } from "./command.ts";

export interface DevRun {
  /** the project's name */
  name: string;
  /** the folder `mason init` ran in */
  root: string;
  /** `<root>/.mason`: the run's settings, state and logs */
  home: string;
  /** the project's files (sources/, mason.yml) */
  folder: string;
  pid: number;
  /** what the users' passwords are made with (src/duck/users.ts) */
  apiKey: string;
  control: { url: string; token: string };
  /** when the run's process started, as the run recorded it (`processStart`), or null when the config has none */
  started?: string | null;
  /** the Postgres API without credentials (`postgresql://<host>:<port>/<database>`; mason user add prints the URL a
   *  tool pastes) */
  postgresUrl: string;
  /** the address a client reaches, MASON_PG_PUBLIC_URL's (src/cli/pg-url.ts `clientLink`), or null */
  postgresPublicUrl?: string | null;
  /** how it listens (src/cli/pg-tls.ts): its address and TLS */
  postgresListener: PostgresListener;
}

/** Whether process `pid` is alive (signal 0 tests without signalling). */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }   // alive, and someone else's: still running
}

/** The run a project's config says is up (its pid alive), or null. Whether it ANSWERS is `answers`'. */
export function runOf(p: Project, isAlive: (pid: number) => boolean = alive): DevRun | null {
  const r = p.config.running;
  if (!r || !isAlive(r.pid)) return null;
  return { name: p.config.name, root: p.root, home: p.dir, folder: p.folder, pid: r.pid, apiKey: p.config.apiKey,
    control: { url: r.controlUrl, token: r.token }, started: r.started ?? null, postgresUrl: r.postgresUrl, postgresPublicUrl: r.postgresPublicUrl ?? null, postgresListener: r.postgresListener };
}

/** What the run's command server says of itself (`/api/ping`: its pid), or null when nothing answers with the run's token. */
export async function ping(run: DevRun): Promise<{ pid: unknown } | null> {
  try {
    const res = await fetch(`${run.control.url}/api/ping`, { headers: { Authorization: `Bearer ${run.control.token}` }, signal: AbortSignal.timeout(3_000) });
    if (res.status !== 200) return null;
    return await res.json() as { pid: unknown };
  } catch {
    // nothing listening, a timeout, a body that is not JSON: not this run (whatever holds the port now). "Not up" is
    // the answer the question wants: a command then says Mason is not running, with mason start as the way out
    return null;
  }
}

/** Whether the run answers with its own token and pid: the only proof it is up. */
export async function answers(run: DevRun): Promise<boolean> {
  return (await ping(run))?.pid === run.pid;
}

/** What a command that needs Mason running says when it is not. */
export function notRunning(p: Project): Problem {
  return { problem: `Mason is not running for ${p.config.name} (${p.root})`, code: "not_running", next: [["mason start", "start it, in the background"]] };
}

/** How long a hung run is given to leave on SIGTERM before SIGKILL (the test server's ignored SIGTERM for 15 s). */
export const END_GRACE_MS = 15_000;

/** What a command says of a run that is alive and does not answer: what to run, since nothing else reaches it. */
export function notAnswering(p: Project, run: DevRun): Problem {
  return { problem: `Mason for ${p.config.name} is running (pid ${run.pid}) but does not answer its commands (${run.control.url}, 3 s)`, code: "not_answering",
    why: "a statement may be holding its main thread",
    next: [["mason stop", `end it (SIGTERM, then SIGKILL after ${END_GRACE_MS / 1000} s); its synced data stays and the next mason start resumes`], ["mason logs", "what it was doing"]] };
}

/**
 * WHEN PROCESS `pid` STARTED, in a form two readings of one process always agree on and another process holding the
 * number later (after a reboot, or a container's restart) never shares; null when this platform cannot say. Linux: the
 * boot's id and the start in clock ticks since that boot, from /proc (the image has no ps, and a clock step moves
 * neither); elsewhere (macOS, the BSDs) ps's start, read in UTC and the C locale so the reader's zone changes nothing.
 */
export function processStart(pid: number): string | null {
  if (process.platform === "linux") {
    let boot: string, stat: string;
    try {
      boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      // gone, or /proc not readable here (hidepid): not said, and the arguments are asked instead (`masonProcess`)
      return null;
    }
    // field 2 is the command's name in parentheses, which may hold anything: the fields after its LAST ")" are fixed
    const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];   // field 22, starttime (index 0 is field 3)
    return boot !== "" && ticks !== undefined && /^\d+$/.test(ticks) ? `linux:${boot}:${ticks}` : null;
  }
  if (process.platform === "win32") return null;
  const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } });
  const at = ps.status === 0 ? ps.stdout.trim() : "";
  return at === "" ? null : `ps:${at}`;
}

/** The arguments process `pid` was started with: /proc's own fields on Linux; elsewhere ps's line split at its spaces
 *  (an argument holding a space is read as two: the best ps can say); null when this system does not say
 *  (gone, a /proc this user may not read, no ps). */
export function commandArgs(pid: number): string[] | null {
  if (process.platform === "linux") {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0$/, "").split("\0"); }
    catch {
      // gone, or not readable here: not said, which `masonProcess` reads as no run, as before
      return null;
    }
  }
  if (process.platform === "win32") return null;
  const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const line = ps.status === 0 ? ps.stdout.trim() : "";
  return line === "" ? null : line.split(/\s+/);
}

/** Whether `args` are a Mason run's, field by field: node, then Mason's entry (`mason`, `mason.cjs`, a checkout's
 *  `main.ts`, the package's `main.js`), then `serve`, or `start` with `--attach` among the rest (src/cli/background.ts). */
export function runArguments(args: readonly string[]): boolean {
  const base = (a: string | undefined): string => (a ?? "").split(/[\\/]/).pop() ?? "";
  if (!/^node(\.exe)?$/.test(base(args[0])) || !["mason", "mason.cjs", "main.ts", "main.js"].includes(base(args[1]))) return false;
  return args[2] === "serve" || (args[2] === "start" && args.slice(3).includes("--attach"));
}

/** Whether `pid` is the run that recorded `started` (`processStart`): its start where it can be read; else, or where the
 *  record has none (an earlier Mason's), its arguments (`runArguments`); a process neither says is no run, as before. */
export function masonProcess(pid: number, started: string | null,
  read: { start: (pid: number) => string | null; args: (pid: number) => string[] | null } = { start: processStart, args: commandArgs }): boolean {
  const now = started === null ? null : read.start(pid);
  if (now !== null) return now === started;
  const args = read.args(pid);
  return args !== null && runArguments(args);
}

export type RunState = { kind: "up"; run: DevRun } | { kind: "hung"; run: DevRun } | { kind: "none"; run: null };

/** The project's run: up (it answers), hung (alive, still the process the run recorded, and silent), or none. */
export async function runState(p: Project, isAlive: (pid: number) => boolean = alive, ask: (r: DevRun) => Promise<boolean> = answers,
  isMason: (pid: number, started: string | null) => boolean = masonProcess): Promise<RunState> {
  const r = runOf(p, isAlive);
  if (r === null) return { kind: "none", run: null };
  if (await ask(r)) return { kind: "up", run: r };
  return isMason(r.pid, r.started ?? null) ? { kind: "hung", run: r } : { kind: "none", run: null };
}

/** The project's run when it is up and answers; null when Mason is not running for it (a hung run is not up). */
export async function liveRun(p: Project, isAlive: (pid: number) => boolean = alive, ask: (r: DevRun) => Promise<boolean> = answers): Promise<DevRun | null> {
  const st = await runState(p, isAlive, ask);
  return st.kind === "up" ? st.run : null;
}

/**
 * ENDS A RUN THAT DOES NOT ANSWER: SIGTERM, then SIGKILL once `graceMs` has passed with it still alive (a blocked main
 * thread never sees SIGTERM), and the pid waited for. `killed` says whether SIGKILL was needed; a pid alive after it
 * is said, never reported ended.
 */
export async function endRun(pid: number, deps: { kill?: (pid: number, signal: NodeJS.Signals) => void; isAlive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void>; graceMs?: number } = {}): Promise<{ killed: boolean }> {
  const kill = deps.kill ?? ((p, sig) => process.kill(p, sig));
  const isAlive = deps.isAlive ?? alive;
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const grace = deps.graceMs ?? END_GRACE_MS;
  kill(pid, "SIGTERM");
  const until = Date.now() + grace;
  while (isAlive(pid) && Date.now() < until) await sleep(250);
  if (!isAlive(pid)) return { killed: false };
  kill(pid, "SIGKILL");
  const gone = Date.now() + 10_000;
  while (isAlive(pid) && Date.now() < gone) await sleep(250);
  if (isAlive(pid)) throw new Error(`pid ${pid} is still running after SIGKILL: it may be another user's, or the system is not reaping it (ps -p ${pid})`);
  return { killed: true };
}

/** The run a command means: its project's (src/cli/project.ts theProject), up and answering; else why there is none. */
export async function theRun(cwd: string): Promise<{ run: DevRun; project: Project } | (Problem & { project: Project | null; hung?: DevRun })> {
  const t = theProject(cwd);
  if ("problem" in t) return { ...t, project: null };
  const st = await runState(t.project);
  if (st.kind === "up") return { run: st.run, project: t.project };
  if (st.kind === "hung") return { ...notAnswering(t.project, st.run), project: t.project, hung: st.run };
  return { ...notRunning(t.project), project: t.project };
}

