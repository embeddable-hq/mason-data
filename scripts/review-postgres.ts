#!/usr/bin/env node
/**
 * A THROWAWAY POSTGRES FOR A PROBE OR A REVIEW: the postgres:18 a stage runs scripts/duck-repro.ts against when it was
 * given no itEnv, started and removed by one plain command each.
 *
 *   node scripts/review-postgres.ts start         prints the container's name and its env file's path
 *   node scripts/review-postgres.ts stop <name>   removes it, checks it is gone, and deletes the env file
 *
 * Load the env file with Node's own `--env-file=<path>` (`node --env-file=<path> <tree>/scripts/duck-repro.ts …`).
 * It was a shell line in the harness's prompts (`$(openssl rand …)`, `$pw`, `"$n"`), which Claude Code's worktree guard
 * refuses in an isolated agent, so each agent improvised its own (issue 322).
 *
 * Every rule of issue 246 holds here: the password is passed to docker by the environment, never argv (`ps` shows
 * argv), and is never printed; the env file is written under umask 077, mode 0600, in the system temp dir; the
 * container ends itself after two hours should the stage die first (`timeout` as its entrypoint, as scripts/gate.ts's
 * does); `docker inspect` is only ever run with a --format naming one field, since its Config.Env holds the password.
 * wal_level=logical, so the stream can be tested too; the port is a free loopback one.
 *
 * Exit codes: 0 done, 2 usage, 3 it failed (no Docker, the image, the port, not ready in 60 s, or still there after
 * stop), with one line saying what and the way out.
 */
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const NAME = /^mason-review-[0-9a-f]{8}$/;
/** How long the container lives, whatever becomes of the stage that started it. */
export const LIFETIME_S = 7200;
const READY_MS = 60_000;
const envFileOf = (name: string): string => path.join(os.tmpdir(), `${name}.env`);
const docker = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync("docker", args, { encoding: "utf8", env, timeout: 120_000 });
function fail(line: string): never {
  process.stderr.write(`review-postgres: ${line}\n`);
  process.exit(3);
}
const pause = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Removes the container and its env file; true when `docker inspect` then fails, as it must for a container gone. */
function remove(name: string): { gone: boolean; why: string } {
  const rm = docker(["rm", "-f", "-v", name]);
  fs.rmSync(envFileOf(name), { force: true });
  const inspect = docker(["inspect", "--format", "{{.State.Status}}", name]);
  if (inspect.error !== undefined) return { gone: false, why: `could not run docker inspect: ${inspect.error.message}` };
  if (inspect.status === 0) return { gone: false, why: `docker inspect still finds it (${inspect.stdout.trim()}); docker rm said: ${(rm.stderr || rm.stdout).trim()}` };
  return { gone: true, why: "" };
}

function start(): void {
  process.umask(0o077);
  const name = `mason-review-${crypto.randomBytes(4).toString("hex")}`;
  const password = crypto.randomBytes(16).toString("hex");
  const run = docker(["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD", "-p", "127.0.0.1:0:5432",
    "--entrypoint", "timeout", "postgres:18", "--kill-after=30", String(LIFETIME_S), "docker-entrypoint.sh", "postgres", "-c", "wal_level=logical"],
  { ...process.env, POSTGRES_PASSWORD: password });
  if (run.error !== undefined) {
    fail(`could not run docker (${run.error.message}): start Docker and put \`docker\` on PATH, or give the stage itEnv, a file that holds IT_POSTGRES_URL`);
  }
  if (run.status !== 0) fail(`docker run failed (exit ${run.status}): ${run.stderr.trim()}: is Docker running, and can it pull postgres:18?`);
  function undo(line: string): never {
    const r = remove(name);
    return fail(`${line}; the container ${r.gone ? "was removed" : `may still be there (${r.why}): remove it with \`docker rm -f -v ${name}\``}`);
  }
  const port = docker(["port", name, "5432/tcp"]);
  const portNo = /:(\d+)\s*$/m.exec(port.stdout ?? "")?.[1];
  if (port.status !== 0 || portNo === undefined) undo(`docker port gave no port (exit ${port.status}): ${(port.stderr ?? "").trim()}`);
  fs.writeFileSync(envFileOf(name), `export IT_POSTGRES_URL=postgres://postgres:${password}@127.0.0.1:${portNo}/postgres\n`, { mode: 0o600 });
  const pollMs = Number(process.env["REVIEW_POSTGRES_POLL_MS"] ?? 1000);
  const until = performance.now() + READY_MS;
  for (;;) {
    // over TCP: during its first start the image runs a server on the socket only, which is not yet the real one
    const ready = docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
    if (ready.status === 0) break;
    if (performance.now() > until) undo(`Postgres was not ready within ${READY_MS / 1000} s: ${(ready.stdout + ready.stderr).trim()}`);
    pause(pollMs);
  }
  process.stdout.write(`container ${name}\nenv file ${envFileOf(name)}\n`
    + `Load it with \`node --env-file=${envFileOf(name)} <tree>/scripts/duck-repro.ts …\`; remove it with \`node scripts/review-postgres.ts stop ${name}\`.\n`);
}

function stop(name: string): void {
  const r = remove(name);
  if (!r.gone) fail(`${name} is not gone: ${r.why}`);
  process.stdout.write(`removed ${name}, and deleted its env file\n`);
}

const [cmd, name, ...rest] = process.argv.slice(2);
const usage = "usage: node scripts/review-postgres.ts start | stop <name>: <name> is what start printed, mason-review-<8 hex digits>";
if (cmd === "start" && name === undefined) start();
else if (cmd === "stop" && name !== undefined && NAME.test(name) && rest.length === 0) stop(name);
else {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
}
