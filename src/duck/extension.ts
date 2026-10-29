/**
 * THE COPY'S `postgres` EXTENSION ON THIS MACHINE: the copy reads the source through DuckDB's `postgres` extension
 * (src/duck/sync.ts attach), which DuckDB keeps under ~/.duckdb/extensions/<version>/<platform>/. The image installs it
 * at build (docker/mason-data.Dockerfile); from npm it is downloaded the first time a machine needs it — so a machine
 * that is offline at its first copy could not copy, and said so only then. Now nothing is a surprise:
 *
 * - `mason init` installs it while it is online (it was online to install Mason from npm), as a step of its checklist,
 *   and fails in the Failure shape with the way out when it cannot (`extensionWayOut`);
 * - `mason doctor` says on a line whether it is installed for this machine (`extensionCheck`, src/cli/doctor.ts);
 * - a copy that cannot load it names `mason doctor` (src/duck/sync.ts attach).
 *
 * Nothing here runs at a statement: the run's instance never downloads (src/duck/store.ts INSTANCE_SETTINGS), and these
 * open an in-memory instance of their own, read or install, and close it.
 */
import { DuckDBInstance } from "@duckdb/node-api";

/** What this machine has of the extension: installed or not, where it is (or would be), and for which platform. */
export interface ExtensionStatus { installed: boolean; path: string; platform: string }

/** The extension's name in DuckDB's catalog (`INSTALL postgres` installs `postgres_scanner`). */
const NAME = "postgres_scanner";

async function withInstance<T>(f: (run: (sql: string) => Promise<Array<Record<string, unknown>>>) => Promise<T>): Promise<T> {
  // an instance of its own that downloads nothing by itself: only an INSTALL asked by name fetches
  const instance = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
  try {
    const c = await instance.connect();
    try { return await f(async (sql) => (await c.runAndReadAll(sql)).getRowObjects() as Array<Record<string, unknown>>); }
    finally { c.closeSync(); }
  } finally { instance.closeSync(); }
}

const statusOf = async (run: (sql: string) => Promise<Array<Record<string, unknown>>>): Promise<ExtensionStatus> => {
  const [row] = await run(`SELECT installed, install_path FROM duckdb_extensions() WHERE extension_name = '${NAME}'`);
  const [p] = await run("PRAGMA platform");
  return { installed: row?.installed === true, path: String(row?.install_path ?? ""), platform: String(p?.platform ?? "") };
};

/** Whether the extension is installed for this machine: read, never downloaded. */
export function postgresExtension(): Promise<ExtensionStatus> {
  return withInstance(statusOf);
}

/** The extension installed for this machine (downloaded once from DuckDB's extension repository); throws when it cannot be. */
export function installPostgresExtension(): Promise<ExtensionStatus> {
  return withInstance(async (run) => {
    await run("INSTALL postgres");
    const s = await statusOf(run);
    // installed by the statement, or it did not take: said, never assumed
    if (!s.installed) throw new Error(`INSTALL postgres answered, and the extension is still not at ${s.path}`);
    return s;
  });
}

/** How a machine is checked and given the extension: the real ones, or a test's. */
export interface ExtensionWay { status: () => Promise<ExtensionStatus>; install: () => Promise<ExtensionStatus> }
export const EXTENSION: ExtensionWay = { status: postgresExtension, install: installPostgresExtension };

/** The way out for a machine without it, in one sentence each: online (`online`, the command that installs it from
 *  where the reader is), or a machine with no internet. */
export function extensionWayOut(s: Pick<ExtensionStatus, "path" | "platform">, online: string): string[] {
  return [
    `connect to the internet and ${online}: the extension is downloaded once a machine`,
    `a machine with no internet: copy ${s.path || "~/.duckdb/extensions/<version>/<platform>/postgres_scanner.duckdb_extension"} from a ${s.platform || "same-platform"} machine that ran mason init, or run the mason-data image, which has it`,
  ];
}

/** What a copy that could not load the extension says (src/duck/sync.ts attach; mason status and wait show it): the
 *  error, that a first copy downloads it, and `mason doctor`, which says whether it is installed and how to get it. */
export function extensionFailure(error: string): string {
  return `Mason could not load the copy's postgres extension: ${error}. The first copy on a machine downloads it (then ~/.duckdb/extensions): ` +
    "connect to the internet, and the copy is tried again at the next pass; mason doctor says whether it is installed, and how to install it on a machine with no internet";
}
