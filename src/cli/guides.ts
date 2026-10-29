/**
 * THE GUIDES `mason help` PRINTS (once `mason docs`; under `mason help` because help is the more common word): OFFLINE,
 * from the CLI itself, short enough to read whole. An agent using 0.1.7 found what the CLI accepts by grepping the
 * package's compiled code, because the help pointed at docs the package does not ship. So the reference is here, and
 * every list in it is the code's own table (the commands from the registry, the failure codes from src/cli/command.ts):
 * a guide cannot list a command or a code the CLI does not have.
 *
 * A guide's name is never a command's (tests/cli-help.test.ts): one word never means two pages.
 */
import { DEMO_ADDED_TABLES, DEMO_TABLES, DEMO_TABLE_TO_ADD } from "../demo/seed.ts";

/** The guides, by the name `mason help <guide>` takes. */
export const GUIDES = {
  agent: "driving Mason from a coding agent: the commands in order, --json and its shapes, exit codes, failures",
  production: "going to production: the mason-data image, its settings, Docker Compose, logical replication, upgrades",
} as const;

export type Guide = keyof typeof GUIDES;

/** A guide's text: built at run time from the registry's and the commands' own tables. */
export async function guideText(guide: Guide): Promise<string> {
  if (guide === "agent") return agentGuide();
  return productionGuide();
}

/**
 * THE AGENT'S PAGE (two readers: a person wants feedback and short, scannable responses; an agent wants clear,
 * unambiguous context and machine-readable formats; both want the next steps): what a
 * coding agent driving Mason reads first — the commands in the order a project takes them, every answer's shape, the
 * exit codes and the failure codes — built from the registry and src/cli/command.ts, so it cannot list a command or a
 * code the CLI does not have.
 */
async function agentGuide(): Promise<string> {
  // imported here, not at the top: the registry imports this file for the HELP usage
  const { STEPS } = await import("./registry.ts");
  const { FAILURE_CODES } = await import("./command.ts");
  const w = Math.max(...STEPS.flatMap(([, cs]) => cs.map((c) => c.name.length))) + "mason  --json".length;
  const commands = STEPS.map(([step, cs]) => `  ${step}\n${cs.map((c) => `    ${`mason ${c.name}${Object.hasOwn(c.options, "json") ? " --json" : ""}`.padEnd(w)}  ${c.summary}`).join("\n")}`).join("\n");
  const codes = Object.entries(FAILURE_CODES).map(([code, what]) => `    ${code.padEnd(12)} ${what}`).join("\n");
  return `DRIVING MASON FROM A CODING AGENT — the same commands a person runs, answered as data

  Every command prints for a person, or with --json one JSON object for a program. One prints text alone: mason help
  (this reference); mason mcp's stdout is the MCP protocol's, so it takes no --json and says a failure to start on
  stderr; mason logs --json is the log's lines, or with --requests the request log. Nothing a command prints
  refers to a file this package does not ship.

  AN AGENT WITH MCP (Claude Code, Claude Desktop, any MCP client) adds Mason as an MCP server first, then asks with
  its tools rather than through a shell: tables (each copy's rows and how current it is), describe, query (rows with
  their Postgres types, or the refusal with what to write instead) and explain. In the project's folder, Mason running:
    mason user add claude --json              its url, printed once
    claude mcp add mason --env MASON_URL="<url>" -- mason mcp
  (the server's name before --env, which takes every value after it). mason help mcp says the rest: Claude Desktop's
  config, a mason serve elsewhere.

  THE COMMANDS, in the order a project takes them (mason --help lists the same):
${commands}

  EVERY ANSWER is an object with next: [{ command, what }] — the commands to run next, the same a person reads under
  Next. The other keys are each command's; its help names them (mason help <command>, the --json line). Lists are wrapped
  ({ tables: […], next }), never bare. mason wait --json blocks until every added table is copied and kept current, then
  answers once (exit 0), or with error beside the state (exit 1 failed, 124 timed out: nothing stopped, run it again).

  A FAILURE is { "error": { "code", "message", "why", "fix" }, "next": […] } on stdout ("why" and "fix" where there is
  more to say than the message), and the exit code says it — the same code exits the same wherever it is found:
    0  done
    1  failed, with the reason
    2  the command line is wrong (without --json the usage follows)
    124  ran out of time: mason wait
  The codes:
${codes}

  READING THE OUTPUT: the answer is on stdout, progress on stderr (mason wait's bars; nothing under --json). Colour,
  wrapping and the spinner are a terminal's alone: a pipe gets plain text, and NO_COLOR turns colour off anywhere.
  A Postgres tool (psql, a JDBC or ODBC driver, Metabase, Grafana) connects with what mason user add <name> --json
  answers: url, host, port, database, user, password (printed once; it does not expire) — each added table a table.
  Where the Postgres API listens is in mason status --json (postgres.url, host, port); never read .mason/config.json
  for it. A failure that is a bug in mason says so; MASON_DEBUG=1 adds where it happened.

  THE SOURCES FILE, mason/sources/<name>.yml (mason init writes it; one per project for now), is what Mason copies:
    kind: postgres
    url: \${DATABASE_URL}          a variable from .env.local, .env or the shell; a literal URL is allowed for local dev
    sync: off                     how each table is kept current after its first copy: off (the default; mason sync
                                  <table> reads it again) or poll <interval> (poll 5s, poll 5m, poll 1h; 1s to 24h)
    tables:
      orders:                     a bare name is in public; billing.invoices names its schema
        columns: [id, status]     these columns (the primary key is always copied)
        sync: poll 30s            this table's own: polled every 30 seconds (mason add orders --sync "poll 30s")
      customers: {}               every column
      events:
        exclude: [raw_body]       every column but these
      sessions:
        key: [tenant_id, id]      only for a table with no primary key: the unique columns to copy it by (polling only)
  mason add and mason remove edit one entry of it and keep the rest as it was, Mason running or not: with it running
  they take effect at once, else at mason start. An edit by hand is read at the next mason start (or the next add or
  remove). Column types are read from the database at every start. A change of a table's sync: keeps its copy and
  catches it up by one poll. mason status --json says each table's kept: { sync, syncedAt, nextAt } — how old its
  copy is; a copy synced days ago answers today's count(*) as of then.

  A FIRST SESSION, as a shell runs it:
    mason doctor --json && mason init --json
    mason tables --json                       choose the tables (rows, key, whether one can be added)
    mason add orders customers --json         added to the sources file, checked against the database
    mason start --json && mason wait --json   Mason in the background; until every added table is copied
    mason sync orders --json                  read what changed in it since (a table whose sync is off: only so)
    mason user add my-tool --json             the URL and password a tool connects with
    mason status --json                       each table's copy, and the last day's slow and refused statements
  With no database to hand, in a new folder: mason init demo --json && mason start --json — a demo database Mason
  hosts itself (${DEMO_TABLES.join(", ")}), changed every few seconds, polled every 5 s (its sync: poll 5s). Init adds
  ${DEMO_ADDED_TABLES.join(", ")}; ${DEMO_TABLE_TO_ADD} is left to add: mason add ${DEMO_TABLE_TO_ADD} --json && mason wait --json, after mason start.
`;
}

const REPO = "https://github.com/embeddable-hq/mason-data/blob/main";

/**
 * `mason help production` (the journey from running it locally to deploying it, on the mason-data image): the
 * README's "Going to production", offline and short — what travels, what the server needs, how it runs, how it is upgraded.
 */
export function productionGuide(): string {
  return `GOING TO PRODUCTION — the project folder (mason/sources/, mason/mason.yml) is all that travels: its sources file
names the tables the server copies, and its url: names the variable that holds the database's URL. Nothing in .mason/ goes with it; the server makes its own copy and state on its volume.

1. PREPARE THE DATABASE. Mason only reads it. How each table is kept current after its first copy is the sources
   file's sync: — off (the default: read again only by mason sync <table>, from cron or a deploy) or poll <interval>,
   per table — and needs a user that can SELECT the tables; each poll costs the database a scan of its table (a poll
   waits four times its own time, so the polls never take more than a fifth of it), and it works on a read replica.
   Logical replication (MASON_CHANGES=replication)
   needs wal_level = logical, a user with REPLICATION, and either a publication you name (PG_PUBLICATION, read as it is,
   never altered) or the right to create one; the slot holds the database's WAL while Mason is down, so cap it with
   max_slot_wal_keep_size. Try it locally first:
     mason start --replication                      the change log, as the server reads it
     mason start --replication --publication app_pub   through a publication the database's owner made

2. RUN IT: one container, ghcr.io/embeddable-hq/mason-data:<version> (the version mason.yml names), running mason serve:
     DATABASE_URL           the database to copy from (the variable the sources file's url: names)
     MASON_API_KEY          what the users' passwords are made with (openssl rand -hex 24)
     MASON_PROJECT          your mason/ folder, mounted (default ./mason)
     MASON_DATA             the volume whose .mason/ holds the copy and the state (default .)
     MASON_PG_HOST=0.0.0.0 and TLS: MASON_PG_TLS_CERT / MASON_PG_TLS_KEY, or MASON_PG_SELF_SIGNED_TLS=1, or
     MASON_PG_PLAIN=1 behind a TLS proxy of your own
   Docker Compose: ${REPO}/deploy/mason-data/README.md. One container per volume, never two: DuckDB lets one process
   write its file, so run one replica, with no autoscaling, and stop the old container before the new one starts.
   GET /healthz on MASON_HEALTH_PORT (4140) answers 503 while it starts and 200 once it serves; the first start takes
   about 15 seconds before that, then copies the tables.
   MEMORY: the copy may use half the container's memory limit by default (else half the machine's RAM); the other
   half is the page cache, Node and the catalog (~820 MB). Give the container enough that the page cache holds the
   columns your dashboards read: a query over a column it does not hold runs at the disk's speed. The benchmark's copy
   was about a fifth of its tables in Postgres (10.1 GiB to 1.8 GiB, on a 15 GiB machine); mason status says yours.
   To set it, MASON_DUCKDB_MEMORY=4GB with the container's limit about twice that. A statement past it fails alone
   (53200) and the run goes on; a value near the container's limit is an OOM kill.
   CPU: memory first, then cores. The benchmark's machine (4 vCPU Graviton3, 15 GiB) answered 32 clients at 10 M rows,
   12 statements a second at a p95 of 3.5 s, as many a second as at 8 clients: more clients waited longer. A copy's
   readers take about a core each while it runs (MASON_COPY_PARALLEL, default 3). The image is arm64 (the measured
   one) and amd64. Which settings to decide: ${REPO}/deploy/mason-data/README.md#settings

3. CONNECT THE TOOLS: beside the server (docker compose exec mason …), a user is a password a tool keeps:
     mason user add metabase                        its URL and password, printed once
     mason user list
     mason user remove metabase                     ends it at once, without a restart
   The tool connects to the Postgres API (5433) as to a read replica, each added table a table. Changing
   MASON_API_KEY removes every user.

4. CHANGE IT: ship mason/ with your release and restart the container; a table added or removed is copied or dropped
   at the next start, or beside the server:
     mason add public.orders                        copied at once, added to the mounted mason/sources/
     mason remove orders                            taken out of the sources file, its copy dropped
     mason status                                   each table's copy, the slow and refused statements
   Upgrade: read the release notes, then move mason.yml and the image together. Removing Mason for good in replication mode:
   SELECT pg_drop_replication_slot('mason_dev_<name>_<source>') — the slot holds your WAL (mason status names it).

The whole account: ${REPO}/README.md
`;
}
