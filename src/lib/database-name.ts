/**
 * THE DATABASE NAME A TOOL CONNECTS WITH, the one place it is decided: what the listener accepts, what `current_database()`
 * and `pg_database` answer, and what every URL Mason prints ends in. It is `mason` (it shows in every connection string),
 * unless the source says otherwise: `database:` in the sources file, committed, so a tool that says `database=production`
 * keeps saying it. On a server whose sources file has no such line, `MASON_PG_DATABASE` says it instead.
 *
 * It is NOT the project's name, which stays what names the replication slot and publication (src/cli/replication-mode.ts
 * `deploymentOf`): a fixed name in that place would give two projects on one source one slot, each reading away the
 * other's changes. Nothing else may derive this name: a run records it in its URL (`postgresApiUrl`), and a command reads
 * that URL (`postgresLink`) or, with Mason stopped, asks here (`projectDatabase`, src/cli/project.ts).
 *
 * When a project has more than one source, a second source with no `database:` would clash on `mason`: it is refused,
 * with the exact line to add.
 */

/** The name a tool connects with when nothing says another. */
export const DEFAULT_DATABASE = "mason";

/** The setting a server names it with, when its sources file does not. */
export const DATABASE_SETTING = "MASON_PG_DATABASE";

/** Postgres's longest name (NAMEDATALEN - 1): `pg_database.datname` would cut a longer one, and a tool's would not match. */
const MAX_NAME_BYTES = 63;

/**
 * WHY `name` CANNOT BE A DATABASE NAME, or null. As wide as Postgres's, because the point is a tool keeping the name it
 * has: capitals, dashes, dots and spaces are all real databases' (`postgres` and `template1` too: `databaseNameSql` makes
 * room for them). What is refused is what could not be served: nothing, past Postgres's length, a control character,
 * what no URL can carry (`.` and `..` are path steps, whatever their escaping) and a variable, since the name is written
 * out (it is the same on every machine that runs the project).
 */
export function databaseNameProblem(name: string): string | null {
  if (name === "") return "it is empty: a tool must have a name to connect with";
  const bytes = Buffer.byteLength(name);
  if (bytes > MAX_NAME_BYTES) return `${JSON.stringify(name)} is ${bytes} bytes, and a Postgres database name is at most ${MAX_NAME_BYTES}`;
  if (/\p{Cc}/u.test(name)) return `${JSON.stringify(name)} holds a control character, which no tool's connection form can carry`;
  if (name === "." || name === "..") return `${JSON.stringify(name)} cannot be the last part of a connection URL, which reads it as a step in a path`;
  if (name.includes("${")) return `${JSON.stringify(name)} is a variable, and the name is written out: it is the same on every machine that runs this project`;
  return null;
}

/**
 * THE RULE: the sources file's `database:`, else on a server `MASON_PG_DATABASE`, else `mason`. `mason serve` refuses
 * the two when they disagree, on its settings' one report (src/cli/serve.ts), so a run never has to choose.
 */
export function connectDatabase(written: { database: string | null }, config: { served?: boolean }, env: Readonly<Record<string, string | undefined>>): string {
  return written.database ?? (config.served === true ? env[DATABASE_SETTING] || null : null) ?? DEFAULT_DATABASE;
}

/** The setting where it means nothing (`mason start`, a project's sources file being what names it): refused, never ignored. */
export const databaseSettingRefusal = (env: Readonly<Record<string, string | undefined>>, shown: string): { message: string; fix: string } | null => {
  const set = env[DATABASE_SETTING];
  if (!set) return null;
  return { message: `${DATABASE_SETTING} is mason serve's setting, and mason start ignores no setting silently`,
    fix: `write database: ${set} in ${shown} (it is committed, so every machine answers as it), and unset ${DATABASE_SETTING}` };
};

/**
 * THE HINT OF A `3D000`: the right name, how a tool says it, and where the name is set. A client reads it before any
 * password, so it never names the sources file by its path: that file is named for the source's own database.
 */
export const wrongDatabaseHint = (database: string): string =>
  `this Mason answers as the database "${database}": connect with database=${database}, the last part of a postgres:// URL. ` +
  `It is set by database: in the project's sources file (sources/<name>.yml), or ${DATABASE_SETTING} on a server`;
