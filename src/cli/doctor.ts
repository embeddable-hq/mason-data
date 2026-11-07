/**
 * `mason doctor` (an agent's report on #409 asked for a one-shot check of what the machine lacks): what this machine
 * has of what mason start needs — Node, memory, the ports — and, when a run is up or a database is named, the
 * database and the run's health. Every failing check says what to do; the report ends with the next command to run.
 * Read-only: nothing is started, written or changed.
 */
import { failed, jsonText, nextBlock, parseCommand, type CommandSpec, type NextStep } from "./command.ts";
import { out as styleOut, wrap, type Style } from "./style.ts";
import { DEFAULT_UI_PORT, heldPgPort, namedPgPort, portHolder, type PortHolder } from "./ports.ts";
import { callRun, RunUnreachable } from "./control.ts";
import { readiness, type RunState } from "./commands.ts";
import { connectSource, maskedUrl, parseSource, readSourceFacts, versionProblem, type ConnectContext } from "./preflight.ts";
import { theRun, type DevRun } from "./runs.ts";
import { projectSource, type Project } from "./project.ts";
import { DEFAULT_PG_PORT } from "../api/postgres/listener.ts";
import { defaultMemoryLimit, machineMemory, memoryLimitBytes, memoryProblems, memoryProblemText, memorySize, memoryWarning, OUTSIDE_RESERVE_BYTES, type MachineMemory } from "../duck/store.ts";
import { probeExtensions, type ExtensionProbe } from "../duck/extensions.ts";
import { readRoleFacts, roleChecks, roleUnknown, ROLE_CODES, type RoleAsk } from "./source-role.ts";
import { replicatedEntries, shownPath, type ProjectSource } from "./sources.ts";
import { namedPublication } from "./replication-mode.ts";
import type { PgConnection } from "../cdc/pg-wire.ts";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

/**
 * THE NODE THE PACKAGE NEEDS, major.minor: cli/package.json's `engines`, this check, `mason --help` and the README read
 * or are held to it (tests/cli-doctor.test.ts). The package is compiled to JavaScript (cli/build.ts), so it needs no
 * type stripping; 22.13 is the floor the published package was measured against (22.12 refuses a module it
 * loads, 22.23 loads every module). A checkout and the image run the TypeScript itself and need 23.6 (the root
 * package.json).
 */
export const NODE_MIN = "22.13";

export const DOCTOR_USAGE = `usage: mason doctor [--json]

  Says whether this machine is ready for Mason — Node ${NODE_MIN} or later, memory (what the engine may use and what it
  leaves beside it; MASON_DUCKDB_MEMORY=4GiB sets it), Mason's postgres and inet extensions (installed with Mason for this
  platform, so nothing is downloaded; else the first sync downloads them), the ports Mason listens on — with the way
  out for anything missing.

    mason doctor

  --json   as data: its shape is at the end

  In a project's folder it checks the project's database too; with Mason running for it, the run in a few lines instead: its
  database, whether every added table is synced, the statements of the last day it refused or answered slowly. Both
  say whether the user Mason connects as could change a synced table's rows (a superuser, BYPASSRLS, an owner of a
  synced table, a write privilege on one or CREATE on its schema; or a write that reaches its rows through a
  partition, an inheritance child or parent, a foreign key's action, a view or a rule; SECURITY DEFINER code it
  reaches; a foreign server; ADMIN OPTION or a server role; directly or through a role it is a member of), with the
  statements that make a role that only reads.

  Exit status: 0 nothing failed — a warning (!) and a check that could not tell (?) are said, and leave it 0; 1
  something failed (said, with the way out).

  The --json answer: { ready, verdict, checks: [{ name, ok, detail, warn, code, fix }], next: [{ command, what }] }; ok
    is true, false, or null when it could not tell; warn (only when true): fine to run, but said loudly; code
    (the role's lines): ${ROLE_CODES.slice(0, 5).join(", ")},
    ${ROLE_CODES.slice(5).join(", ")};
    fix (with code): the statements and the edit that make a role that only reads
`;

export const DOCTOR: CommandSpec = {
  name: "doctor",
  summary: "check this machine for what mason start needs (Node, memory, ports, the database, the run) and say what to do",
  usage: DOCTOR_USAGE,
  options: { json: { type: "boolean" } },
  json: ["ready", "verdict", "checks", "next"],
};

/** One check: what was looked at, whether it is fine (null: could not tell), and the detail — a value, or what to do. */
export interface Check {
  name: string; ok: boolean | null; detail: string;
  /** a start goes on, but the line is said loudly (`!`) */
  warn?: true;
  /** a stable name for what the line found, for an agent (the role's: `ROLE_CODES`) */
  code?: string;
  /** the way out as statements and lines to change, printed under the checks once however many lines share it */
  fix?: string;
}

/** The ports a mason start takes by default, and what listens on each. */
export const PORTS: ReadonlyArray<[port: number, what: string]> = [[DEFAULT_UI_PORT, "the mason commands"], [DEFAULT_PG_PORT, "the Postgres API"]];

/** Node's version against the package's floor, major then minor. */
export function nodeCheck(version: string = process.versions.node): Check {
  const [major, minor] = version.split(".").map(Number) as [number, number];
  const [minMajor, minMinor] = NODE_MIN.split(".").map(Number) as [number, number];
  return major > minMajor || (major === minMajor && minor >= minMinor)
    ? { name: "node", ok: true, detail: `Node ${version}` }
    : { name: "node", ok: false, detail: `Node ${version} is too old: mason needs ${NODE_MIN} or later (nodejs.org, or nvm install ${minMajor})` };
}

/**
 * The machine's memory and what the copy's engine may use of it (src/duck/store.ts DEFAULT_MEMORY_LIMIT,
 * MASON_DUCKDB_MEMORY): what a start refuses is said in the start's own words (`memoryProblems`), and what it warns of
 * under the floor in the run's own words (`memoryWarning`), a warning, never a failure, since the start goes on; so is
 * a share the operator set that leaves less than OUTSIDE_RESERVE_BYTES beside it.
 */
export function memoryCheck(memory: MachineMemory = machineMemory(), env: NodeJS.ProcessEnv = process.env): Check {
  const problems = memoryProblems(env);
  if (problems.length) return { name: "memory", ok: false, detail: problems.map(memoryProblemText).join("; ") };
  const warned = memoryWarning(memory, env);
  const set = env.MASON_DUCKDB_MEMORY || undefined;
  const share = set ?? defaultMemoryLimit(memory.bytes);
  const outside = memory.bytes - memoryLimitBytes(share);
  if (warned !== null) {
    return { name: "memory", ok: true, warn: true,
      detail: `${memoryProblemText(warned)} (the engine uses up to ${share.trim()}, the default, leaving ${memorySize(Math.max(0, outside))} beside it)` };
  }
  return {
    name: "memory", ok: true, ...(outside < OUTSIDE_RESERVE_BYTES ? { warn: true as const } : {}),
    detail: `${memorySize(memory.bytes)}; the engine uses up to ${share.trim()}${set !== undefined ? " (MASON_DUCKDB_MEMORY)" : " (the default; MASON_DUCKDB_MEMORY sets it)"}, ` +
      `leaving ${memorySize(Math.max(0, outside))} for Mason beside it` +
      (outside < OUTSIDE_RESERVE_BYTES ? `, under the ${memorySize(OUTSIDE_RESERVE_BYTES)} it needs (measured, with a margin): the system may stop it in a first sync, ` +
        "a generated table's build or a burst of writes (a smaller MASON_DUCKDB_MEMORY, or more memory)" : ""),
  };
}

/** The copy's extensions (src/duck/extensions.ts): shipped with Mason and loaded by an engine of their own as the run's
 *  will load them, or not shipped, and why. `probe` is a test's. */
export async function extensionsCheck(probe: () => Promise<ExtensionProbe> = () => probeExtensions()): Promise<Check> {
  const p = await probe();
  return { name: "extensions", ok: p.ok, detail: p.detail };
}

/**
 * Mason's ports in one line, decided by the probe mason start uses (`portHolder`, src/cli/ports.ts: every address, so
 * doctor and start agree on a port another program holds on the wildcard). A taken command port only moves Mason to
 * another free one, so the line says that and who holds each (this project's Mason, or another program). The Postgres
 * API's port is the project's (`recorded`, src/cli/ports.ts choosePgPort) or the one the developer NAMED (`MASON_PG_PORT`),
 * and is not moved: held by anything but this project's run, it is the failure mason start will give.
 * The ports line used to confuse: it was a "?" naming each port's role and "something else".
 */
export async function portsCheck(runs: readonly DevRun[], taken: (p: number) => Promise<PortHolder | null> = portHolder, env: NodeJS.ProcessEnv = process.env, recorded: number | null = null): Promise<Check> {
  const named = env.MASON_PG_PORT ? namedPgPort(env.MASON_PG_PORT) : null;
  if (named && "problem" in named) return { name: "ports", ok: false, detail: `${named.problem}: ${named.fix}` };
  const pgPort = named ? named.port : recorded ?? DEFAULT_PG_PORT;
  const ports = PORTS.map(([p]) => p === DEFAULT_PG_PORT ? pgPort : p);
  const byHolder = new Map<string, number[]>();
  for (const port of ports) {
    const held = await taken(port);
    if (!held) continue;
    const holder = runs.find((r) => [r.control.url, r.postgresUrl].some((u) => portOf(u) === port));
    if (port === pgPort && !holder) {
      const refused = heldPgPort(port, held);
      return { name: "ports", ok: false, detail: `${refused.problem}: ${refused.why}. ${refused.fix}` };
    }
    const who = holder ? `Mason for ${holder.name}` : "another program";
    byHolder.set(who, [...(byHolder.get(who) ?? []), port]);
  }
  if (!byHolder.size) return { name: "ports", ok: true, detail: `${ports.join(", ")} free` };
  const used = [...byHolder].map(([who, ps]) => `${ps.join(", ")} in use by ${who}`).join("; ");
  return { name: "ports", ok: true, detail: `${used}: mason start will use another free port for the commands (mason status shows them)` };
}

function portOf(url: string): number | null {
  try { const u = new URL(url); return u.port ? Number(u.port) : null; } catch { return null; }   // not a URL: no port to compare with
}

/**
 * The database a URL names: reachable, its version, what this user can read — and, given `role` (the project's synced
 * tables), whether that user could write to it (src/cli/source-role.ts), on the same connection. `name` says where the
 * URL is (`DATABASE_URL in .env`): a refusal names it, never the value (src/cli/preflight.ts shownUrl).
 */
export async function databaseChecks(url: string, o: ConnectContext & { role?: RoleAsk; name?: string } = {}): Promise<Check[]> {
  const parsed = parseSource(url, o.name);
  if ("problem" in parsed) return [{ name: "database", ok: false, detail: parsed.problem }];
  const connected = await connectSource(parsed.source, o);
  if ("failure" in connected) return [{ name: "database", ok: false, detail: `${maskedUrl(parsed.source.url)}: ${connected.failure.message}${connected.failure.hints.map((h) => `\n    - ${h}`).join("")}` }];
  try {
    const facts = await readSourceFacts(connected.pg);
    const tooOld = versionProblem(facts);
    if (tooOld) return [{ name: "database", ok: false, detail: `${maskedUrl(parsed.source.url)}: ${tooOld}` }];
    const database: Check = { name: "database", ok: true, detail: `${maskedUrl(parsed.source.url)}: Postgres ${facts.versionText}${facts.standby ? " (a read replica)" : ""}, ${facts.tables.length} table(s) this user can read` };
    return o.role ? [database, ...await askRole(connected.pg, o.role)] : [database];
  } finally { connected.pg.close(); }
}

/** The role's lines, from its one catalog read; a read that failed is "could not tell", never "only reads". */
async function askRole(pg: Pick<PgConnection, "query">, ask: RoleAsk): Promise<Check[]> {
  let facts;
  try { facts = await readRoleFacts(pg, ask.tables); } catch (e) { return [roleUnknown((e as Error).message)]; }
  return roleChecks(facts, ask);
}

/** What the role check asks of a project's sources file: its tables, whether one streams, its publication, its URL. */
export function roleAsk(src: ProjectSource, root: string, env: NodeJS.ProcessEnv = process.env): RoleAsk {
  return {
    tables: src.tables.map((e) => { const at = e.table.indexOf("."); return { schema: e.table.slice(0, at), table: e.table.slice(at + 1) }; }),
    replicated: replicatedEntries(src).map((e) => e.table),
    publication: namedPublication(src, env)?.name ?? null,
    urlVariable: "env" in src.url ? src.url.env : null, urlFrom: src.from, file: shownPath(root, src.file), url: src.resolved,
  };
}

/**
 * The role's lines with Mason running (its own checks never connect to the database): the project's sources file read
 * and the database asked, on a connection of its own. What cannot be read is "could not tell".
 */
export async function runRoleChecks(project: Project): Promise<Check[]> {
  if (project.config.demo === true) return [];   // the demo database is Mason's own, inside the run
  const src = projectSource(project);
  if ("message" in src) return [roleUnknown(`${src.message} (mason status)`)];
  const parsed = parseSource(src.resolved);
  if ("problem" in parsed) return [roleUnknown(parsed.problem)];
  const connected = await connectSource(parsed.source);
  if ("failure" in connected) return [roleUnknown(`${maskedUrl(parsed.source.url)}: ${connected.failure.message}`)];
  try { return await askRole(connected.pg, roleAsk(src, project.root)); } finally { connected.pg.close(); }
}

/** The run's health, from its own state: every table copied, failing, or still at work; and what it refused or answered slowly. */
export async function runChecks(run: DevRun): Promise<Check[]> {
  const checks: Check[] = [];
  let state: RunState;
  try {
    const r = await callRun(run, "GET", "/api/state");
    if (r.status !== 200) throw new RunUnreachable(String(r.body.error ?? `HTTP ${r.status}`));
    state = r.body as unknown as RunState;
  } catch (e) {
    if (!(e instanceof RunUnreachable)) throw e;
    return [{ name: "mason start", ok: false, detail: `${run.name}: ${e.message}` }];
  }
  checks.push({ name: "mason start", ok: true, detail: `${run.name} (pid ${run.pid}); Postgres ${state.source.version}${state.source.standby ? " (a read replica)" : ""} at ${state.source.url}` });
  const ready = readiness(state);
  const picked = state.tables.filter((t) => t.added).length;
  if (ready.failed.length) checks.push({ name: "project", ok: false, detail: `${ready.failed.length} problem(s): ${ready.failed.join("; ")} — mason wait prints each with the way out` });
  else if (ready.waiting.length) checks.push({ name: "project", ok: null, detail: `still at work: ${ready.waiting.join("; ")} (mason wait)` });
  else checks.push({ name: "project", ok: true, detail: picked ? `${picked} table(s) synced and kept current` : "no table added yet (mason tables, then mason add <table>)" });
  const slow = await callRun(run, "GET", "/api/slow"), refused = await callRun(run, "GET", "/api/refused");
  const slowN = slow.status === 200 ? (slow.body.slow as unknown[]).length : null, refusedN = refused.status === 200 ? (refused.body.refused as unknown[]).length : null;
  checks.push(slowN === null || refusedN === null
    ? { name: "queries", ok: null, detail: "the last day's statements could not be read (mason status)" }
    : { name: "queries", ok: slowN + refusedN === 0, detail: slowN + refusedN === 0 ? "none refused or slow in the last day" : `last day: ${refusedN} refused, ${slowN} slow (mason status lists each, with what to do)` });
  return checks;
}

/** What to run next, from what the checks found. */
export function nextSteps(checks: readonly Check[], run: DevRun | null, project: Project | null): NextStep[] {
  const bad = (name: string): boolean => checks.some((c) => c.name === name && c.ok === false);
  if (bad("node")) return [["mason doctor", `again, once Node ${NODE_MIN} or later is installed`]];
  if (bad("project") && run === null) return [["mason doctor", "again, once .mason/config.json is repaired or moved aside (the detail above says how)"]];
  // the demo database is hosted by the run itself (src/cli/demo.ts): down until mason start makes it
  if (bad("database") && project?.config.demo === true) return [["mason start", "hosts the demo database, then syncs its tables"]];
  if (bad("database")) return [["mason start", `once the connection works (the detail above says how; the URL is in ${project ? `${project.dir}/config.json` : ".mason/config.json"})`]];
  if (project === null) return [
    ["mason init", "in your app's folder: the database from MASON_DATABASE_URL or DATABASE_URL in .env.local, .env or the shell"],
    ["mason init - < db-url.txt", "or its URL on stdin"],
  ];
  if (run === null) return [["mason start", "Mason in the background, for this folder"]];
  if (bad("mason start")) return [["mason logs", "why Mason does not answer"], ["mason stop", "then mason start, to start it again"]];
  if (bad("project")) return [["mason wait", "each problem, with the way out"]];
  if (checks.some((c) => c.name === "project" && /no table added/.test(c.detail))) return [["mason tables", "the database's tables and their columns"], ["mason add <table>", "sync a table into Mason"]];
  if (bad("queries")) return [["mason status", "the refused and slow statements, each with what to do"]];
  return [["mason user add <name>", "a user for a BI tool or your app: its password and URL, printed once"]];
}

/** The one line a first run reads: ready for the next step, or what is missing. */
export function verdictOf(checks: readonly Check[], run: DevRun | null, project: Project | null): { ready: boolean; verdict: string } {
  const failed = checks.filter((c) => c.ok === false);
  if (run !== null) {
    return failed.length
      ? { ready: false, verdict: `Mason is running for ${run.name}, with ${failed.length} problem${failed.length === 1 ? "" : "s"}` }
      : { ready: true, verdict: `Mason is running for ${run.name}` };
  }
  // the first failure's headline: its sentence before the parenthesis or the way out, which the line below carries whole
  if (failed.length) return { ready: false, verdict: `Not ready: ${failed[0]!.detail.split(/ \(|\. /)[0]!.trim()}` };
  return { ready: true, verdict: project ? `Ready: mason start (the project ${project.config.name})` : "Ready: mason init, in your app's folder" };
}

/** A check's mark: ok, !! a failure, ? could not tell. */
function markOf(c: Check, s: Style): string {
  return c.ok === false ? s.red("!! ") : c.ok === null ? s.yellow("?  ") : c.warn === true ? s.yellow("!  ") : s.green("ok ");
}

export async function doctor(argv: string[], deps: { which?: (cwd: string) => ReturnType<typeof theRun> } = {}): Promise<number> {
  const f = parseCommand(DOCTOR, argv);
  if (typeof f === "number") return f;
  if (f.positionals.length) return failed("doctor", { message: "it takes no URL", code: "usage", fix: "in a project's folder it checks the project's database (mason init makes one)", usage: DOCTOR_USAGE }, { json: f.values.json === true });
  const which = await (deps.which ?? theRun)(process.cwd());
  const run = "run" in which ? which.run : null;
  const project = which.project;
  // THE CHECKS FOR THE MOMENT (the first run's output, every check at once, confused): before a start, whether
  // the machine can run one; with a run up, the run itself — its ports are its own, and the machine is already proven
  const checks: Check[] = [];
  if (run === null) {
    checks.push(nodeCheck());
    checks.push(memoryCheck());
    checks.push(await extensionsCheck());
    checks.push(await portsCheck([], portHolder, process.env, project?.config.pgPort ?? null));
    if (project) {
      // the database the project's sources file names (src/cli/sources.ts): a file that cannot be read is the failing line
      const src = projectSource(project);
      if ("message" in src) checks.push({ name: "database", ok: false, detail: `${src.message}${src.why ? `: ${src.why.replace(/\n/g, "; ")}` : ""}. ${src.fix?.split("\n")[0] ?? ""}`.trim() });
      // the demo database is Mason's own, inside the run: whom it connects as is not the person's to change
      else if (project.config.demo === true) checks.push(...await databaseChecks(src.resolved, { demo: true, name: src.from }));
      else checks.push(...await databaseChecks(src.resolved, { role: roleAsk(src, project.root), name: src.from }));
    }
    // a project here whose config cannot be read: init would refuse, so "Ready: mason init" would send a person nowhere
    if ("code" in which && which.code === "bad_config") checks.push({ name: "project", ok: false, detail: `${which.problem}. ${(which.fix ?? "").replace(/^./, (c) => c.toUpperCase())}`.trim() });
  } else {
    checks.push(...await runChecks(run));
    if (project) checks.push(...await runRoleChecks(project));
  }
  const next = nextSteps(checks, run, project);
  const { ready, verdict } = verdictOf(checks, run, project);
  if (f.values.json) { out(jsonText(DOCTOR, { ready, verdict, checks }, next)); return ready ? 0 : 1; }
  // on a terminal: the verdict green or red, each check's mark by its state, its detail wrapped under its column
  const s = styleOut();
  out(s.bold(ready ? s.green(verdict) : s.red(verdict)));
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    if (run !== null && c.name === "mason start" && c.ok === true) continue;   // the verdict line said it
    const mark = markOf(c, s);
    out(`  ${mark} ${c.name.padEnd(w)}  ${wrap(c.detail, s.width, 2 + 3 + 1 + w + 2)}`);
  }
  // a way out several lines share, once, under them: SQL as what you type, the rest as its words
  for (const fix of new Set(checks.map((c) => c.fix).filter((x): x is string => x !== undefined))) {
    out("");
    for (const line of fix.split("\n")) out(`    ${/;(\s+--.*)?$/.test(line) ? s.cyan(line) : line.startsWith("--") ? s.dim(line) : wrap(line, s.width, 4)}`);
  }
  if (run !== null) out(s.dim(`  its synced data and its state in ${run.home}. mason status for the details`));
  if (run === null || !ready) out(nextBlock(next));
  return ready ? 0 : 1;
}
