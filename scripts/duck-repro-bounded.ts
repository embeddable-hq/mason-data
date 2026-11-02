#!/usr/bin/env node
/**
 * ONE TIMED, BOUNDED RUN OF scripts/duck-repro.ts: what a probe or a review times its DEEP statements with, at the head
 * and at the base (issue 264).
 *
 *   node --env-file=<env file> scripts/duck-repro-bounded.ts <seconds> <tree> <ddl.sql> <statements.sql>
 *
 * It runs `<tree>/scripts/duck-repro.ts <ddl.sql> <statements.sql>` (the tree's own, so a base too old to have this
 * script is timed the same way) and prints `pid <n>` first, on stderr: the run's own pid, as duck-repro names its
 * database `duck_repro_<pid>` by it. Its `real <seconds>` is printed last, as `/usr/bin/time -p` prints it. Past the
 * bound it kills the run, says so, drops that run's database `duck_repro_<pid>` (by its pid, never by a pattern) and
 * exits 124; a run that died by a signal (out of memory) is dropped the same way and exits 128 + the signal. Otherwise
 * it exits as duck-repro did. psql is given the URL by the environment, never argv.
 *
 * It was a shell line in the harness's prompts (`( . <env> && … perl -e '…alarm…' …)`), which Claude Code's worktree
 * guard refuses in an isolated agent (issue 322).
 *
 * Exit codes: duck-repro's own, 124 killed past the bound, 128 + n died by signal n, 2 usage.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const MAX_SECONDS = 3600;
const say = (line: string): void => { fs.writeSync(2, `${line}\n`); };

/** libpq's environment for a postgres:// URL, so no password reaches argv. */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres" };
  const ssl = u.searchParams.get("sslmode");
  if (ssl !== null) env["PGSSLMODE"] = ssl;
  return env;
}

/** Drops the database a run left behind: `duck_repro_<pid>`, that pid's and no other. */
function drop(url: string, pid: number): void {
  const db = `duck_repro_${pid}`;
  const r = spawnSync("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`], { env: pgEnv(url), encoding: "utf8", timeout: 60_000 });
  if (r.error === undefined && r.status === 0) say(`dropped ${db}`);
  else say(`could not drop ${db} (${r.error !== undefined ? r.error.message : r.stderr.trim() || `exit ${r.status}`}): drop it by that name before the next run`);
}

const [secArg, tree, ddl, stmts, ...rest] = process.argv.slice(2);
const url = process.env["IT_POSTGRES_URL"];
const usage = `usage: node --env-file=<env file> scripts/duck-repro-bounded.ts <seconds> <tree> <ddl.sql> <statements.sql>: <seconds> a whole number from 1 to ${MAX_SECONDS}, <tree> a checkout holding scripts/duck-repro.ts, IT_POSTGRES_URL in the env file`;
if (!/^\d+$/.test(secArg ?? "") || Number(secArg) < 1 || Number(secArg) > MAX_SECONDS || tree === undefined || ddl === undefined || stmts === undefined
  || rest.length > 0 || url === undefined || url === "" || !fs.existsSync(path.join(tree, "scripts", "duck-repro.ts"))) {
  say(usage);
  process.exit(2);
}
const seconds = Number(secArg);
const t0 = performance.now();
const child = spawn(process.execPath, [path.join(tree, "scripts", "duck-repro.ts"), ddl, stmts], { stdio: "inherit", cwd: tree });
if (child.pid === undefined) {
  say("could not start node for duck-repro");
  process.exit(1);
}
const pid = child.pid;
say(`pid ${pid}`);
let killed = false;
const timer = setTimeout(() => {
  killed = true;
  say(`killed: past the bound of ${seconds} s`);
  child.kill("SIGKILL");
}, seconds * 1000);
// a bound from outside (the Bash tool's) ends the run too, never leaving it orphaned
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { killed = true; say(`stopped by ${sig}`); child.kill("SIGKILL"); });
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  const real = ((performance.now() - t0) / 1000).toFixed(2);
  let exit = code ?? 1;
  if (killed || signal !== null) {
    if (!killed) say(`died by ${signal}`);
    drop(url!, pid);
    exit = killed ? 124 : 128 + (os.constants.signals[signal!] ?? 0);
  }
  say(`real ${real}`);
  process.exit(exit);
});
