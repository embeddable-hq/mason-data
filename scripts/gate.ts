#!/usr/bin/env node
/**
 * THE READY LOCAL GATE (issue 78; tests/integration/README.md "The ready local gate"): one command that gives a session
 * the Node and the Postgres CI uses, and runs what is nearest the change. It is a subset, and says so: CI is the full gate.
 *
 *   npm run gate                              typecheck, the two always-files, what imports the change
 *   npm run gate -- tests/duck-wire.test.ts   and these files, named by hand
 *   npm run gate -- --oracle '<regex>'        and the oracle's statements the regex names (IT_ORACLE_ONLY)
 *   npm run gate -- --timeout 900             a bound, in seconds, on each test file instead of the defaults
 *
 * Node: a pinned official tarball, its sha256 held in NODE_PIN, unpacked once under the repository's git folder
 * (`<git common dir>/mason-gate/`): git ignores it and every worktree shares it, so a session downloads nothing a former
 * one fetched, and nothing global changes, because Node 26 is only put first on the PATH of the gate's own children.
 * A container would run Linux on this Mac: a second node_modules and a slower, smaller VM beside the Postgres. A tarball
 * of the same OS runs the same node_modules (the engine's binding is Node-API, so it does not follow Node's ABI).
 *
 * The one place: `.github/workflows/ci.yml`. Its `node-version` and its Postgres `image` are read at every run; a
 * NODE_PIN of another major refuses the gate, and a test holds the same.
 *
 * Postgres: a container named `mason-gate-<pid>-<random>` whose port Docker picks at the bind (nothing to race), with a
 * random password, removed by that name when the gate ends or is signalled, and the removal verified. `timeout` is its
 * entrypoint, so even a gate killed with SIGKILL leaves a stopped container, never a running one.
 *
 * Every process has a bound: each runs in a process group of its own, stopped with SIGTERM and then SIGKILL, by its PID.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The exact Node the gate fetches. Its major must be ci.yml's; a bump is a new version and four lines of SHASUMS256.txt. */
export const NODE_PIN = {
  version: "26.13.0",
  sha256: {
    "darwin-arm64": "d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6",
    "darwin-x64": "525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e",
    "linux-arm64": "439e9c438acdf6a6ffe47418da709153d66c4bed812e30a473faacb107dd2791",
    "linux-x64": "5848553868b402d3fabb5b09270649977780a390f832155721025a08b5104455",
  } as Record<string, string>,
};
export const ALWAYS = ["tests/conventions.test.ts", "tests/cli-state-matrix.test.ts"];
export const ORACLE = "tests/integration/duck-oracle.itest.ts";
export const CI_FILE = ".github/workflows/ci.yml";

/** The bounds, in ms. A test file's bound is generous: the machine is shared, and a false HUNG costs a whole run. */
export const BOUNDS = { install: 600_000, typecheck: 600_000, unit: 600_000, integration: 900_000, oracle: 1_800_000, docker: 300_000, postgresReady: 180_000, grace: 10_000 };

/** A failure the gate can say on one report: what is wrong and the way out. */
export class GateRefusal extends Error {}

// ---- the one place ------------------------------------------------------------------------------------------------

/** ci.yml's Node major and Postgres image. It says each once in value, or the gate cannot tell which it should run. */
export function ciFacts(yaml: string): { nodeMajor: string; postgresImage: string } {
  const one = (what: string, values: string[]): string => {
    const distinct = [...new Set(values)];
    if (distinct.length !== 1 || distinct[0] === undefined) throw new GateRefusal(`${CI_FILE} names ${distinct.length === 0 ? "no" : distinct.join(" and ")} ${what}: the gate needs exactly one to run what CI runs. Fix ${what} in ${CI_FILE}, or fix scripts/gate.ts ciFacts if the file's shape changed.`);
    return distinct[0];
  };
  const nodeMajor = one("node-version", [...yaml.matchAll(/^\s*node-version:\s*['"]?([^'"\s#]+)['"]?/gm)].map((m) => m[1] ?? ""));
  if (!/^\d+$/.test(nodeMajor)) throw new GateRefusal(`${CI_FILE} node-version is ${nodeMajor}: the gate reads a major, such as 26.`);
  return { nodeMajor, postgresImage: one("Postgres image", [...yaml.matchAll(/^\s*image:\s*['"]?(postgres:[^'"\s#]+)['"]?/gm)].map((m) => m[1] ?? "")) };
}

/** A regex that names no statement passes the oracle by asking nothing, and an empty pass is not a pass. */
export function oracleAskedNothing(regex: string): (output: string) => string | null {
  return (output) => {
    const asked = /^duck oracle: (\d+) statements asked/m.exec(output)?.[1];
    return asked === undefined ? "the oracle never said how many statements it asked"
      : Number(asked) === 0 ? `--oracle ${regex} named no statement, so nothing was held to Postgres: IT_ORACLE_ONLY matches a statement's name (tests/integration/oracle/)` : null;
  };
}

/** A pin of another major than CI's never runs: the local answer would be the Node CI does not use. */
export function pinProblem(nodeMajor: string, pin: { version: string } = NODE_PIN): string | null {
  return pin.version.split(".")[0] === nodeMajor ? null
    : `${CI_FILE} runs Node ${nodeMajor} and scripts/gate.ts pins ${pin.version}. Set NODE_PIN in scripts/gate.ts to a ${nodeMajor}.x release, with the four sha256 lines from https://nodejs.org/dist/v<version>/SHASUMS256.txt.`;
}

// ---- which files ----------------------------------------------------------------------------------------------------

/** The relative modules a source imports, statically or with `import()`, as repository paths. */
export function importsOf(file: string, src: string): string[] {
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'`](\.{1,2}\/[^"'`]+)["'`]/g;
  return [...new Set([...src.matchAll(re)].map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1] ?? ""))))];
}

export interface Chosen { file: string; why: string }
export interface Choice { unit: Chosen[]; integration: Chosen[]; oracleLeftOut: string | null; nothingNear: string[] }

/**
 * Nearest is one rule: a test file a change touched, or one that imports a changed file directly. The oracle is minutes
 * of thousands of statements, so a change never picks it: `--oracle <regex>` takes a subset, naming the file the whole.
 */
export function chooseTests(input: { tests: Map<string, string>; changed: string[]; named: string[]; oracle: boolean }): Choice {
  const why = new Map<string, string>();
  for (const f of ALWAYS) why.set(f, "always");
  for (const f of input.named) if (!why.has(f)) why.set(f, "named by hand");
  if (input.oracle && !why.has(ORACLE)) why.set(ORACLE, "--oracle");
  const changed = new Set(input.changed);
  const near = new Set<string>();
  let oracleLeftOut: string | null = null;
  for (const [test, src] of [...input.tests].sort(([a], [b]) => a.localeCompare(b))) {
    const reason = changed.has(test) ? { hit: test, why: "changed" } : importsOf(test, src).filter((i) => changed.has(i)).map((hit) => ({ hit, why: `imports ${hit}` }))[0];
    if (reason === undefined) continue;
    near.add(reason.hit);
    if (test === ORACLE && !why.has(ORACLE)) oracleLeftOut = reason.why;
    else if (!why.has(test)) why.set(test, reason.why);
  }
  for (const f of [...why.keys()]) near.add(f);
  const entries = [...why].map(([file, reason]) => ({ file, why: reason }));
  return {
    unit: entries.filter((e) => !e.file.endsWith(".itest.ts")),
    integration: entries.filter((e) => e.file.endsWith(".itest.ts")),
    oracleLeftOut,
    nothingNear: input.changed.filter((f) => !near.has(f)),
  };
}

function walkTests(root: string, dir = "tests", out = new Map<string, string>()): Map<string, string> {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!e.name.startsWith(".tmp-")) walkTests(root, rel, out); }
    else if (/\.(test|itest)\.ts$/.test(e.name)) out.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
  }
  return out;
}

const git = (root: string, ...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** What this checkout changed since it left origin/main: committed, staged, unstaged and untracked. */
export function changedFiles(root: string): { base: string; changed: string[] } {
  let base: string;
  try { base = git(root, "merge-base", "origin/main", "HEAD"); }
  catch (e) { throw new GateRefusal(`no merge base with origin/main (${String((e as { stderr?: unknown }).stderr ?? e).trim()}): run git fetch origin main, then the gate again.`); }
  const lines = (s: string): string[] => s.split("\n").filter(Boolean);
  return { base, changed: [...new Set([...lines(git(root, "diff", "--name-only", base)), ...lines(git(root, "ls-files", "--others", "--exclude-standard"))])].sort() };
}

// ---- what to run --------------------------------------------------------------------------------------------------

export interface Step {
  label: string; cmd: string; args: string[]; boundMs: number;
  /** a step the rest cannot run without: its failure ends the gate there */
  required?: boolean;
  env?: Record<string, string>;
  /** read the output of a step that exited 0: what makes the pass empty, or null */
  verify?: (output: string) => string | null;
}
export interface Plan { first: Step[]; integration: Step[] }

export function buildPlan(choice: Choice, opts: { nodeBin: string; hasNodeModules: boolean; oracleOnly: string | null; timeoutMs: number | null; platform: string }): Plan {
  const node = path.join(opts.nodeBin, "node");
  const testStep = (file: string, boundMs: number): Step => ({
    label: file, cmd: node, args: ["--test", "--test-concurrency=1", "--test-reporter=spec", file], boundMs: opts.timeoutMs ?? boundMs,
  });
  const integration = choice.integration.map(({ file }) => file !== ORACLE ? testStep(file, BOUNDS.integration)
    : opts.oracleOnly === null ? testStep(file, BOUNDS.oracle)
    : { ...testStep(file, BOUNDS.oracle), env: { IT_ORACLE_ONLY: opts.oracleOnly }, verify: oracleAskedNothing(opts.oracleOnly) });
  return {
    first: [
      ...(opts.hasNodeModules ? [] : [{ label: "npm ci", cmd: path.join(opts.nodeBin, "npm"), args: ["ci"], boundMs: BOUNDS.install, required: true }]),
      { label: "typecheck", cmd: node, args: ["node_modules/typescript/bin/tsc"], boundMs: BOUNDS.typecheck },
      ...choice.unit.map(({ file }) => testStep(file, BOUNDS.unit)),
    ],
    integration: integration.length === 0 ? [] : [
      // as CI does: this platform's package built, then installed, so every file runs what a user's install runs
      { label: `the copy's extensions (${opts.platform})`, cmd: node, args: ["cli/extensions.ts", opts.platform], boundMs: BOUNDS.install, required: true },
      { label: "the copy's extensions in node_modules", cmd: node, args: ["cli/extensions.ts", "--node-modules", "node_modules"], boundMs: BOUNDS.install, required: true },
      ...integration,
    ],
  };
}

// ---- Node ----------------------------------------------------------------------------------------------------------

/** The pinned Node's bin folder, fetched and held to its sha256 the first time. Two sessions at once: the first rename wins. */
export async function ensureNode(input: { dir: string; pin: { version: string; sha256: Record<string, string> }; platform: string; fetchTarball: (url: string) => Promise<Buffer> }): Promise<string> {
  const { dir, pin, platform } = input;
  const name = `node-v${pin.version}-${platform}`;
  const bin = path.join(dir, name, "bin");
  const verify = (at: string): boolean => {
    try { return execFileSync(path.join(at, "node"), ["--version"], { encoding: "utf8", timeout: 60_000 }).trim() === `v${pin.version}`; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new GateRefusal(`${path.join(at, "node")} does not answer --version (${String(e)}): delete ${path.join(dir, name)} and run the gate again.`);
    }
  };
  if (verify(bin)) return bin;
  const want = pin.sha256[platform];
  if (want === undefined) throw new GateRefusal(`scripts/gate.ts pins no Node for ${platform} (only ${Object.keys(pin.sha256).join(", ")}). Add its line of https://nodejs.org/dist/v${pin.version}/SHASUMS256.txt to NODE_PIN, or point IT_POSTGRES_URL at a Postgres and run npm run test:integration on a Node ${pin.version.split(".")[0]} of your own.`);
  const url = `https://nodejs.org/dist/v${pin.version}/${name}.tar.gz`;
  let tarball: Buffer;
  try { tarball = await input.fetchTarball(url); }
  catch (e) { throw new GateRefusal(`could not fetch ${url} (${String(e)}): it is needed once per clone. Check the network and run the gate again.`); }
  const got = crypto.createHash("sha256").update(tarball).digest("hex");
  if (got !== want) throw new GateRefusal(`${url} is not the file scripts/gate.ts pins: sha256 ${got}, pinned ${want}. Nothing was installed. Read why it changed before touching the pin.`);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, "fetch-"));
  try {
    const file = path.join(tmp, `${name}.tar.gz`);
    fs.writeFileSync(file, tarball);
    execFileSync("tar", ["-xzf", file, "-C", tmp], { timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    try { fs.renameSync(path.join(tmp, name), path.join(dir, name)); }
    catch (e) {
      // another session finished first: its copy is checked below, so losing the race is only tolerated if it works
      if ((e as NodeJS.ErrnoException).code !== "ENOTEMPTY" && (e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (!verify(bin)) throw new GateRefusal(`${path.join(bin, "node")} is not v${pin.version} after unpacking ${url}: delete ${path.join(dir, name)} and run the gate again.`);
  return bin;
}

// ---- running, with a bound ------------------------------------------------------------------------------------------

export interface Result { code: number | null; hung: boolean; ms: number; log: string; spawnError: string | null }

/**
 * Signal a whole group, by the PID that leads it. Its absence is the wanted state: ESRCH, and EPERM, which macOS gives
 * for a group of ours whose members have all exited. Anything else is said and not thrown: this runs in a timer and an
 * exit handler, where a throw would end the gate before it removes its container.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); }
  catch (e) {
    const { code } = e as NodeJS.ErrnoException;
    if (code !== "ESRCH" && code !== "EPERM") console.error(`gate: could not send ${signal} to process group ${pid}: ${String(e)}`);
  }
}

export interface Config {
  root: string; nodeBin: string; docker: string; psql: string; postgresImage: string;
  out?: (line: string) => void;
  postgresReadyMs?: number; pollMs?: number; graceMs?: number; dockerBoundMs?: number;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const summary = (log: string): string => {
  const text = fs.readFileSync(log, "utf8");
  const tests = /^ℹ tests (\d+)$/m.exec(text)?.[1];
  return tests === undefined ? "" : ` (${tests} tests, ${/^ℹ skipped (\d+)$/m.exec(text)?.[1] ?? "0"} skipped)`;
};
const tail = (log: string, lines = 40): string => fs.readFileSync(log, "utf8").trimEnd().split("\n").slice(-lines).map((l) => `    ${l}`).join("\n");
/** The test runner's own list of failures when it has one (it repeats each with its message), else the output's end. */
const excerpt = (log: string): string => {
  const text = fs.readFileSync(log, "utf8");
  const at = text.indexOf("✖ failing tests:");
  if (at < 0) return tail(log);
  return text.slice(at).trimEnd().split("\n").slice(0, 60).map((l) => `    ${l}`).join("\n");
};
const load = (): string => os.loadavg().map((n) => n.toFixed(1)).join(" ");

/**
 * Run the plan and return the process's exit code: 0 passed, 1 failed, 128+n stopped by a signal. Every step is run
 * even when one fails, as CI does (a `required` one ends it); the verdict is every step's exit code, never the output.
 */
export async function runGate(plan: Plan, cfg: Config): Promise<number> {
  const out = cfg.out ?? ((l: string) => { console.log(l); });
  const grace = cfg.graceMs ?? BOUNDS.grace;
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "mason-gate-"));
  const name = `mason-gate-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  // only --oracle sets the first, and only CI's shards the rest: a stale one would make the whole oracle silently a part
  const { IT_ORACLE_ONLY: _only, IT_ORACLE_LEG: _leg, IT_ORACLE_LEG_REPORT: _report, ...inherited } = process.env;
  const env = { ...inherited, PATH: `${cfg.nodeBin}${path.delimiter}${process.env.PATH ?? ""}` };
  const failures: string[] = [];
  let current: ChildProcess | null = null;
  let stopped: NodeJS.Signals | null = null;
  let cleaning = false;
  let sequence = 0;
  const started = Date.now();
  const loadBefore = load();

  const stopChild = (child: ChildProcess): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    signalGroup(pid, "SIGTERM");
    const kill = setTimeout(() => { signalGroup(pid, "SIGKILL"); }, grace);
    child.once("close", () => { clearTimeout(kill); });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopped !== null) return; // the cleanup is running: a second ^C must not cut it short
    stopped = signal;
    out(`gate: ${signal}: stopping`);
    if (current !== null && !cleaning) stopChild(current);
  };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => { const h = (): void => { onSignal(s); }; process.on(s, h); return [s, h] as const; });

  const run = (step: Omit<Step, "required" | "verify">): Promise<Result> => new Promise((resolve) => {
    const t0 = Date.now();
    const log = path.join(logs, `${String(++sequence).padStart(3, "0")}-${step.label.replace(/[^\w.-]+/g, "_").slice(-80)}.log`);
    const fd = fs.openSync(log, "a");
    // a file, never a pipe: a stray grandchild holding a pipe open would hang the gate past the process it bounds
    const child = spawn(step.cmd, step.args, { cwd: cfg.root, env: { ...env, ...step.env }, detached: true, stdio: ["ignore", fd, fd] });
    fs.closeSync(fd);
    current = child;
    let hung = false;
    const bound = setTimeout(() => { hung = true; stopChild(child); }, step.boundMs);
    let settled = false;
    const done = (code: number | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      current = null;
      if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL"); // what the step left behind in its group
      resolve({ code, hung, ms: Date.now() - t0, log, spawnError });
    };
    child.once("error", (e) => { done(null, e.message); });
    child.once("close", (code, signal) => { done(code ?? (signal === null ? null : 128), null); });
  });

  const report = (step: Step, r: Result): boolean => {
    const { label } = step;
    const exited0 = r.spawnError === null && r.code === 0 && !r.hung;
    const empty = exited0 ? step.verify?.(fs.readFileSync(r.log, "utf8")) ?? null : null;
    if (exited0 && empty === null) { out(`gate: ok   ${seconds(r.ms).padStart(8)}  ${label}${summary(r.log)}`); return true; }
    if (stopped !== null && !r.hung) { out(`gate: stopped  ${label}`); return false; }
    const what = empty ?? (r.hung ? `HUNG: no end within its bound, stopped after ${seconds(r.ms)}` : r.spawnError !== null ? `could not start: ${r.spawnError}` : `exit ${r.code ?? "unknown"}`);
    failures.push(`${label}: ${what}`);
    out(`gate: FAIL ${seconds(r.ms).padStart(8)}  ${label}: ${what}\n${excerpt(r.log)}\n  whole output: ${r.log}`);
    return false;
  };
  const dockerBound = cfg.dockerBoundMs ?? BOUNDS.docker;
  const docker = (...args: string[]): Promise<Result> => run({ label: `docker-${args[0] ?? ""}`, cmd: cfg.docker, args, boundMs: dockerBound });
  const text = (r: Result): string => fs.readFileSync(r.log, "utf8").trim();

  /** Docker and psql answer, or the one report says what to do, before any time is spent. */
  const preflight = async (): Promise<boolean> => {
    const other = "Or run these files on a Postgres of your own: IT_POSTGRES_URL=postgres://... npm run test:integration.";
    const version = await docker("version", "--format", "{{.Server.Version}}");
    if (version.spawnError !== null) failures.push(`no Docker: \`${cfg.docker}\` could not be run (${version.spawnError}). The gate needs it for the throwaway Postgres: install Docker Desktop, start it, and run the gate again. ${other}`);
    else if (version.code !== 0) failures.push(`Docker does not answer (${version.hung ? "no reply within its bound" : text(version).split("\n").at(-1) ?? `exit ${version.code}`}): start Docker Desktop, wait for it, and run the gate again. ${other}`);
    const psql = await run({ label: "psql-version", cmd: cfg.psql, args: ["--version"], boundMs: dockerBound });
    if (psql.spawnError !== null || psql.code !== 0) failures.push(`no psql: \`${cfg.psql}\` could not be run (${psql.spawnError ?? `exit ${psql.code}`}). The integration files and the gate's readiness probe need it on PATH: install Postgres.app or brew install libpq, and add its bin folder to PATH.`);
    return failures.length === 0;
  };

  /** Up, answering a password over the mapped port, with wal_level = logical; or a failure, never a pass. */
  const startPostgres = async (lifetimeMs: number): Promise<string | null> => {
    const password = crypto.randomBytes(16).toString("hex");
    const fail = (why: string): null => { failures.push(`Postgres did not start: ${why}`); out(`gate: FAIL  Postgres (${cfg.postgresImage}): ${why}`); return null; };
    const lifetime = Math.ceil(lifetimeMs / 1000);
    const up = await run({
      label: "docker-run", cmd: cfg.docker, boundMs: dockerBound,
      // -e NAME takes the value from this process's child's env, so the password is in no process's argv
      env: { POSTGRES_PASSWORD: password },
      args: ["run", "--detach", "--name", name, "--label", "mason-gate=1", "--env", "POSTGRES_PASSWORD", "--publish", "127.0.0.1:0:5432", "--entrypoint", "timeout", cfg.postgresImage, "--kill-after=30", String(lifetime), "docker-entrypoint.sh", "postgres", "-c", "wal_level=logical"],
    });
    if (stopped !== null) return null;
    if (up.spawnError !== null || up.code !== 0 || up.hung) return fail(`docker run: ${up.spawnError ?? (up.hung ? "no end within its bound" : `exit ${up.code}: ${text(up).split("\n").at(-1) ?? ""}`)}`);
    const port = await docker("port", name, "5432/tcp");
    const mapped = parseMappedPort(text(port));
    if (port.code !== 0 || mapped === null) return fail(`docker port said ${JSON.stringify(text(port))} (exit ${port.code})`);
    const url = `postgres://postgres:${password}@127.0.0.1:${mapped}/postgres`;
    const probeUrl = `postgres://postgres@127.0.0.1:${mapped}/postgres`; // the password goes by PGPASSWORD: argv is what `ps` shows
    const deadline = Date.now() + (cfg.postgresReadyMs ?? BOUNDS.postgresReady);
    while (stopped === null) {
      const probe = await run({ label: "psql-probe", cmd: cfg.psql, args: ["-X", "-A", "-t", probeUrl, "-c", "SHOW wal_level"], boundMs: 30_000, env: { PGCONNECT_TIMEOUT: "5", PGPASSWORD: password } });
      const said = text(probe);
      if (probe.code === 0 && said === "logical") { out(`gate: Postgres ${cfg.postgresImage} up on 127.0.0.1:${mapped} as ${name} (password auth, wal_level=logical)`); return url; }
      if (probe.code === 0) return fail(`wal_level is ${said}, and the stream's files need logical`);
      // a probe that fails means "not yet"; only the container's own state or the deadline says "no"
      const state = await docker("inspect", "--format", "{{.State.Running}}", name);
      if (state.code === 0 && text(state) === "false") {
        const logged = await docker("logs", "--tail", "20", name);
        return fail(`the container exited during startup:\n${tail(logged.log, 20)}`);
      }
      if (Date.now() >= deadline) return fail(`it did not answer within ${seconds(cfg.postgresReadyMs ?? BOUNDS.postgresReady)}. Its last probe: ${said.split("\n").at(-1) ?? ""}`);
      await new Promise((r) => { setTimeout(r, cfg.pollMs ?? 1000); });
    }
    return null;
  };

  /** By its exact name, and the removal checked: `docker inspect` must say it is gone. */
  const removePostgres = async (): Promise<void> => {
    await docker("rm", "--force", "--volumes", name);
    const after = await docker("inspect", "--format", "{{.Id}}", name);
    const gone = after.code !== 0 && /no such/i.test(text(after));
    if (gone) { out(`gate: removed ${name}`); return; }
    failures.push(`${name} may still exist (${after.code === 0 ? "docker inspect still finds it" : `docker inspect could not tell: exit ${after.code}`}). Remove it with: docker rm --force --volumes ${name}`);
  };

  let postgresTouched = false;
  try {
    const needPostgres = plan.integration.length > 0;
    if (!needPostgres || await preflight()) {
      let go = true;
      for (const step of plan.first) {
        if (stopped !== null || !go) break;
        const passed = report(step, await run(step));
        if (!passed && step.required === true) go = false;
      }
      if (needPostgres && go && stopped === null) {
        postgresTouched = true;
        const lifetime = plan.integration.reduce((sum, s) => sum + s.boundMs, 0) + (cfg.postgresReadyMs ?? BOUNDS.postgresReady) + 300_000;
        const url = await startPostgres(lifetime);
        if (url !== null) {
          for (const step of plan.integration) {
            if (stopped !== null || !go) break;
            const passed = report(step, await run({ ...step, env: { ...step.env, IT_POSTGRES_URL: url } }));
            if (!passed && step.required === true) go = false;
          }
        }
      }
    }
  } catch (e) {
    failures.push(`the gate itself: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  } finally {
    cleaning = true;
    if (postgresTouched) {
      try { await removePostgres(); }
      catch (e) { failures.push(`removing ${name}: ${String(e)}. Remove it with: docker rm --force --volumes ${name}`); }
    }
    for (const [s, h] of handlers) process.off(s, h);
  }

  const took = `${seconds(Date.now() - started)}, load ${loadBefore} then ${load()}`;
  if (stopped !== null) { out(`gate: STOPPED by ${stopped} after ${took}. Nothing is proved.`); for (const f of failures) out(`  ${f}`); return 128 + os.constants.signals[stopped as NodeJS.Signals]; }
  if (failures.length > 0) {
    out(`gate: FAILED after ${took}.`);
    for (const f of failures) out(`  ${f}`);
    return 1;
  }
  fs.rmSync(logs, { recursive: true, force: true });
  out(`gate: PASSED in ${took}. This is a subset: CI is the full gate.`);
  return 0;
}

/** `docker port` prints one line per address family, `127.0.0.1:49153`; we publish on 127.0.0.1 alone. */
export function parseMappedPort(said: string): number | null {
  const m = /^127\.0\.0\.1:(\d+)$/m.exec(said);
  const port = m?.[1] === undefined ? NaN : Number(m[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// ---- the command ----------------------------------------------------------------------------------------------------

const USAGE = "usage: npm run gate -- [test-file ...] [--oracle <regex>] [--timeout <seconds>]";

export function parseArgs(argv: string[], knownTests: Map<string, string>, root: string): { named: string[]; oracleOnly: string | null; timeoutMs: number | null } {
  const usage = (problem: string): never => { throw new UsageError(`${problem}\n${USAGE}`); };
  const named: string[] = [];
  let oracleOnly: string | null = null;
  let timeoutMs: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === "--oracle") {
      const v = argv[++i];
      if (v === undefined || v === "") return usage("--oracle needs a regex of statement names, passed as IT_ORACLE_ONLY (the whole oracle: name its file instead)");
      try { new RegExp(v); } catch (e) { return usage(`--oracle ${v}: ${String(e)}`); }
      oracleOnly = v;
    } else if (a === "--timeout") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) return usage("--timeout needs a number of seconds above 0");
      timeoutMs = v * 1000;
    } else if (a.startsWith("-")) return usage(`unknown option ${a}`);
    else {
      const rel = path.relative(root, path.resolve(a));
      if (!knownTests.has(rel)) return usage(`${a} is not a test file: name a tests/**/*.test.ts or tests/**/*.itest.ts`);
      named.push(rel);
    }
  }
  return { named, oracleOnly, timeoutMs };
}
export class UsageError extends Error {}

async function main(): Promise<number> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.includes("--help") || process.argv.includes("-h")) { console.log(USAGE); return 0; }
  const tests = walkTests(root);
  const { named, oracleOnly, timeoutMs } = parseArgs(process.argv.slice(2), tests, root);
  const { nodeMajor, postgresImage } = ciFacts(fs.readFileSync(path.join(root, CI_FILE), "utf8"));
  const problem = pinProblem(nodeMajor);
  if (problem !== null) throw new GateRefusal(problem);
  const { base, changed } = changedFiles(root);
  const choice = chooseTests({ tests, changed, named, oracle: oracleOnly !== null });

  const platform = `${process.platform}-${process.arch}`;
  const nodeBin = await ensureNode({
    dir: path.join(path.resolve(root, git(root, "rev-parse", "--git-common-dir")), "mason-gate"), pin: NODE_PIN, platform,
    fetchTarball: async (url) => {
      console.log(`gate: fetching ${url} (once per clone)`);
      const r = await fetch(url, { signal: AbortSignal.timeout(BOUNDS.install) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
  });

  console.log(`gate: Node ${NODE_PIN.version} (${CI_FILE} says ${nodeMajor}), ${postgresImage} (${CI_FILE})`);
  console.log(`gate: ${changed.length} file(s) changed since ${base.slice(0, 7)}, the merge base with origin/main`);
  console.log("gate: typecheck: always");
  for (const { file, why } of [...choice.unit, ...choice.integration]) console.log(`gate: ${file}: ${why}${file === ORACLE && oracleOnly !== null ? ` (IT_ORACLE_ONLY=${oracleOnly})` : ""}`);
  if (choice.oracleLeftOut !== null) console.log(`gate: left out: ${ORACLE} (${choice.oracleLeftOut}): use --oracle '<regex>' for the statements this change touches`);
  if (choice.nothingNear.length > 0) console.log(`gate: nothing imports: ${choice.nothingNear.join(", ")}`);
  console.log("gate: this is a subset chosen by direct imports. CI is the full gate.");

  const plan = buildPlan(choice, { nodeBin, hasNodeModules: fs.existsSync(path.join(root, "node_modules")), oracleOnly, timeoutMs, platform });
  return runGate(plan, { root, nodeBin, docker: "docker", psql: "psql", postgresImage });
}

if (process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e: unknown) => {
    if (e instanceof UsageError) { console.error(e.message); process.exitCode = 2; }
    else if (e instanceof GateRefusal) { console.error(`gate: FAILED: ${e.message}`); process.exitCode = 1; }
    else { console.error(`gate: FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`); process.exitCode = 1; }
  });
}
