/**
 * `.env` UNDER THE ENVIRONMENT: a variable the process already carries wins, and `.env` fills in the rest — the
 * rule docker compose applies to `${VAR}` too, so a value set in the shell means the same everywhere. (Written the
 * other way round, `.env` only, a helper once read one deployment's settings under another's shell: this is the ONE
 * reader, so no copy of it can have the rule backwards.)
 *
 * Lines are `KEY=value`, optionally quoted; blank lines and `#` comments are skipped. Dependency-free.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** The file an app's folder keeps its variables in: the one this module reads and `appendEnvLine` writes. */
export const ENV_FILE = ".env";

/** A `.env` file's text, parsed. */
export function parseDotenv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return env;
}

/** `root/.env` with every variable of `processEnv` laid over it. */
export function readEnv(root: string, processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = path.join(root, ENV_FILE);
  const env = fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined) env[k] = v;
  return env;
}

/**
 * A VARIABLE OF AN APP'S FOLDER (`mason init`'s MASON_DATABASE_URL or DATABASE_URL, and a source file's `url: ${NAME}`,
 * src/cli/sources.ts): `name` from the folder's `.env.local`, then `.env` (an `export ` before a line is
 * allowed, as shells write it), then the environment — the order web frameworks read them in, the app's own files
 * first because they name the database this folder's app uses. A different question from readEnv's "this process's
 * configuration": it reads one key of someone else's files. ONE reader for init and for every later read of the
 * source's URL, so the URL init checked is the one the run connects to. `from` says where it was found; `file` is the
 * folder's file it came from (null from the shell). `shellFirst` reads the environment before the files: a server's order.
 */
export function appEnvValue(root: string, name: string, processEnv: NodeJS.ProcessEnv = process.env, o: { shellFirst?: boolean } = {}):
  { value: string; from: string; file: string | null } | null {
  // a server (mason serve) is configured by its environment alone: a .env in its data folder never overrides the platform's
  if (o.shellFirst && processEnv[name]) return { value: processEnv[name], from: "the environment", file: null };
  for (const file of [`${ENV_FILE}.local`, ENV_FILE]) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, "utf8").split("\n").map((l) => l.replace(/^\s*export\s+/, "")).join("\n");
    const value = parseDotenv(text)[name];
    if (value) return { value, from: file, file };
  }
  const value = processEnv[name];
  return value ? { value, from: "the shell", file: null } : null;
}

/**
 * The variables `mason init` reads a database's URL from when none is given, in the order it reads them: Mason's own
 * first, so a developer whose app's DATABASE_URL names another database can aim Mason elsewhere; then the app's.
 */
export const DATABASE_URL_VARIABLES = ["MASON_DATABASE_URL", "DATABASE_URL"] as const;

/**
 * What `mason init` reads when no URL is given: the first of `DATABASE_URL_VARIABLES` that is set, each read as
 * `appEnvValue` reads it (`.env.local`, `.env`, then the shell). `variable` is the one read — the variable the sources
 * file then names; `from` says it with where it was found (`MASON_DATABASE_URL in .env`, `DATABASE_URL in the shell`).
 */
export function appDatabaseUrl(root: string, processEnv: NodeJS.ProcessEnv = process.env):
  { url: string; variable: string; from: string; file: string | null } | null {
  for (const variable of DATABASE_URL_VARIABLES) {
    const v = appEnvValue(root, variable, processEnv);
    if (v !== null) return { url: v.value, variable, from: `${variable} in ${v.from}`, file: v.file };
  }
  return null;
}

/**
 * `root/.env` with `line` (`NAME=value`) added under a `# comment`, the file made when there is none — owner-only
 * (0600): it holds a database's password. What `mason init` writes for a source file's `url: ${NAME}`.
 */
export function appendEnvLine(root: string, line: string, comment: string): void {
  const file = path.join(root, ENV_FILE);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  fs.writeFileSync(file, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${before === "" ? "" : "\n"}# ${comment}\n${line}\n`, { mode: 0o600 });
}
