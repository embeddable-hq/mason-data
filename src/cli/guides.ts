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
  generated: "generated tables: a table declared in SQL, kept current by Mason, read by name",
} as const;

export type Guide = keyof typeof GUIDES;

/** A guide's text: built at run time from the registry's and the commands' own tables. */
export async function guideText(guide: Guide): Promise<string> {
  if (guide === "agent") return agentGuide();
  if (guide === "generated") return generatedGuide();
  return productionGuide();
}

/** THE GENERATED TABLES' PAGE: its keys are the reader's own table (src/cli/generated-files.ts `GENERATED_KEYS`), so it
 *  cannot name a key the file does not take. */
async function generatedGuide(): Promise<string> {
  const { GENERATED_DIR, GENERATED_KEYS } = await import("./generated-files.ts");
  const w = Math.max(...Object.keys(GENERATED_KEYS).map((k) => k.length));
  const keys = Object.entries(GENERATED_KEYS).map(([k, what]) => `    ${k.padEnd(w)}  ${what}`).join("\n");
  return `GENERATED TABLES — a table declared in SQL, kept current by Mason, read by name

  A statement that repeats expensive work on every read can read a table that holds its answer instead. One file per
  table in mason/${GENERATED_DIR}/, committed beside the sources file. The file's name is the table's: requests.yml is
  public.requests, reports.daily.yml is reports.daily.

    kind: scheduled
    target_lag: 5m
    sql: |
      SELECT tenant_id, date_trunc('day', created_at, 'UTC') AS day, count(*) AS orders
      FROM orders
      GROUP BY 1, 2
    order_by: day, tenant_id

  THE KEYS
${keys}

  HOW IT STAYS CURRENT
    A scheduled table runs its whole SQL over one snapshot, into a table beside the old one, and swaps it in. The old
    table serves until then. It runs again once a base has changed and target_lag comes due; nothing runs over idle
    bases. A run shares the queue that first syncs use, one at a time, and reads nothing from your database.
    A run that fails leaves the table serving what it held, and mason status says why.
    A table may read another generated table. Parents are built first; a base's change re-runs the whole chain above
    it over one snapshot, and the chain swaps in at once. A table that reads itself, through others or not, is refused.
    A parent whose run failed, or that was refused before it was ever built, holds back its children, and mason status
    says why; a parent already built whose file is then refused keeps being re-run from what it was built from, and
    carries its children. A table's lag is measured against the base, across the chain: the oldest change below it not
    yet in it. So a child's target_lag can't be shorter than its parent's, and is refused if it is.
    mason wait <table> waits until a table holds every change synced when the wait began.

  WHAT IS REFUSED, WITH THE WAY OUT
    A file with a mistake, or SQL Mason cannot store, is refused by file, key and reason. Nothing else stops, and a
    table already built keeps serving and being re-run from what it was built with. A table has no session, so SQL that
    reads a time zone or a setting is refused: name the zone (t AT TIME ZONE 'UTC', date_trunc('day', t, 'UTC')).
    A daily table in one zone doesn't serve a dashboard in another.
    A numeric column is stored exactly, with Postgres's digits: one passed through, its min or max, a sum of an integer
    or of a numeric(p,s) column (s up to 18). One whose digits Postgres works out from the values (avg, a division, a sum
    of values of differing scales) is refused: cast it, avg(x)::double precision, or sum whole numbers. An enum and a
    citext are stored as themselves: an enum sorts in its declared order, a citext compares without case.
    Not available yet: kind: live, and a domain or a composite type's column.

  WHO READS IT
    A role with tables: all reads it. A role with a list of tables reads it once it names it, as mason/roles.yml names
    any table. It inherits no limits from the tables it reads: carry a tenant column and filter it in the role's where:.

  SEEING IT
    mason start               reads the folder, says what is refused, builds what is new, and keeps looking
    mason status              each table's kind, method, state and lag
    mason status --json       the same as generatedTables, with each refusal's key, reason and options
    mason logs                each run: its rows and seconds, or why it failed

  EXPLAIN says how a generated table is kept current on its first line, as it does for any table.
`;
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
  stderr; mason logs --json is the log's entries ({ at, text }), or with --requests the request log, --events the sync's
  events, --running the statements running now. Nothing a command prints
  refers to a file this package does not ship.

  AN AGENT WITH MCP (Claude Code, Claude Desktop, any MCP client) adds Mason as an MCP server first, then asks with
  its tools rather than through a shell: tables (each synced table's rows and how current it is), describe, query (rows with
  their Postgres types, or the refusal with what to write instead) and explain. In the project's folder, Mason running:
    mason user add claude --json              its url, printed once
    claude mcp add mason --env MASON_URL="<url>" -- mason mcp
  (the server's name before --env, which takes every value after it). mason help mcp says the rest: Claude Desktop's
  config, a mason serve elsewhere.

  THE COMMANDS, in the order a project takes them (mason --help lists the same):
${commands}

  EVERY ANSWER is an object with next: [{ command, what }] — the commands to run next, the same a person reads under
  Next. The other keys are each command's; its help names them (mason help <command>, the --json line). Lists are wrapped
  ({ tables: […], next }), never bare. mason wait --json blocks until every added table is synced and kept current, then
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

  THE SOURCES FILE, mason/sources/<name>.yml (mason init writes it; one per project for now), is what Mason syncs:
    kind: postgres
    url: \${DATABASE_URL}          a variable from .env.local, .env or the shell; a literal URL is allowed for local dev
    database: production          optional: the database name a tool connects with (none: mason), to keep the name it has
    sync: off                     how each table is kept current after its first sync: off (the default; mason sync
                                  <table> reads it again), poll <interval> (poll 5s, poll 5m, poll 1h; 1s to 24h) or
                                  replication (the change log: a primary key, wal_level = logical)
    publication: \${PG_PUBLICATION}  optional: the publication replication reads, its owner's, never altered
                                     (publication: null: Mason's own, past one an earlier start recorded)
    tables:
      orders:                     a bare name is in public; billing.invoices names its schema
        columns: [id, status]     these columns (the primary key is always synced)
        sync: poll 30s            this table's own: polled every 30 seconds (mason add orders --sync "poll 30s")
      customers: {}               every column
      events:
        exclude: [raw_body]       every column but these
      sessions:
        key: [tenant_id, id]      only for a table with no primary key: the unique columns to key it by (polling only)
  mason add and mason remove edit one entry of it and keep the rest as it was, Mason running or not: with it running
  they take effect at once, else at mason start. An edit by hand is read at the next mason start (or the next add or
  remove). Column types are read from the database at every start. A change of a table's sync: keeps its synced data and
  catches it up by one poll. mason status --json says each table's kept: { sync, syncedAt, nextAt } — how old its
  synced data is; a table synced days ago answers today's count(*) as of then.

  A FIRST SESSION, as a shell runs it:
    mason doctor --json && mason init --json
    mason tables --json                       choose the tables (rows, key, whether one can be added)
    mason add orders customers --json         added to the sources file, checked against the database
    mason start --json && mason wait --json   Mason in the background; until every added table is synced
    mason sync orders --json                  read what changed in it since (a table whose sync is off: only so)
    mason user add my-tool --json             the URL and password a tool connects with
    mason status --json                       each synced table, and the last day's slow, refused and unsupported statements
  WATCHING IT, once it runs (every one with --json; --since and --until take an age, 30m or 2h or 7d, or an ISO 8601 time WITH
  its zone):
    mason status --json                       recentErrors: the sync's latest failures and the statements latest refused, failed or cancelled
    mason logs --requests --failed --json     every statement a tool sent that was not answered, with its SQLSTATE and message
    mason logs --events --failed --json       the sync's failures: a first sync, a poll, the stream, the database out of reach, a restart
    mason logs --running --json               the statements running now, one per session
    mason cancel <session> --json             stops that session's statement, as a client's cancel does (its client gets a "canceling statement" error)
    mason usage --since 7d --step 1h --json  the statements, the synced data's size and age, the memory over time, a sample a minute
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
names the tables the server syncs, and its url: names the variable that holds the database's URL. Nothing in .mason/ goes with it; the server makes its own synced data and state on its volume.

1. PREPARE THE DATABASE. Mason only reads it, as a user that can SELECT the tables. How each table is kept current
   after its first sync is the sources file's sync:, committed with it, so the server runs what you ran — at the top
   for every table, and on an entry for that one:
     sync: off                                      the file's default for every table
     tables:
       orders: { sync: replication }                this one from the change log, within seconds
       customers: { sync: poll 5m }                 this one polled every 5 minutes
       events: {}                                   off, as the top says
   off (the default mason init writes): after the first sync Mason reads the table again only when you run mason sync
   <table> (before a report, from cron, at the end of a deploy) — nothing Mason does to your database is a hidden
   default. poll <interval> (1s to 24h): a SELECT that scans the table whole, at that interval, stretched to four
   times the last poll's own time, so the polls never take more than a fifth of the database's time; it works on a
   read replica. replication: the change log, through one slot and one publication for the project; it needs
   wal_level = logical, a user with REPLICATION (or rds_replication), a primary key (a key: table is polled), and
   either a publication you name (publication: \${PG_PUBLICATION} at the top of the sources file, read as it is, never
   altered: it must carry every replicated table; a read replica needs one) or the right to create Mason's own, which
   carries the replicated tables alone. The slot holds the database's WAL while Mason is down, so cap it on the
   database with max_slot_wal_keep_size (Postgres 13+); it is dropped, verified gone, when no table's sync is
   replication any more, and at mason destroy. The flags --replication, --poll and --publication of mason start, and
   MASON_CHANGES, are gone: each answers with the line to write in the sources file. A project that streams, under a
   file with no sync: anywhere, is refused rather than dropped (sync: replication keeps the slot; sync: off or
   sync: poll <interval> confirms the drop), and so is one with a recorded publication that nothing names now
   (publication: <name>, or publication: null for Mason's own, with PG_PUBLICATION unset). Try it locally first:
     mason add orders --sync replication             that table from the change log, as the server reads it
     mason sync customers                           any table read again now, whatever its sync:

2. RUN IT: one container, ghcr.io/embeddable-hq/mason-data:<version> (the version mason.yml names), running mason serve:
     DATABASE_URL           the database to sync from (the variable the sources file's url: names)
     MASON_API_KEY          what the users' passwords are made with (openssl rand -hex 24)
     MASON_PROJECT          your mason/ folder, mounted (default ./mason)
     MASON_DATA             the volume whose .mason/ holds the synced data and the state (default .)
     MASON_PG_HOST=0.0.0.0 and TLS: MASON_PG_TLS_CERT / MASON_PG_TLS_KEY, or MASON_PG_SELF_SIGNED_TLS=1, or
     MASON_PG_PLAIN=1 behind a TLS proxy of your own
   Docker Compose: ${REPO}/deploy/mason-data/README.md. One container per volume, never two: the synced data lets one process
   write its file, so run one replica, with no autoscaling, and stop the old container before the new one starts.
   THE WEB PAGE stays on the server's loopback, so publish nothing for it: mason ui --ssh <user@server> on your machine
   opens it through your own ssh (--mason "docker exec -i <container> mason" for a container), until Ctrl-C.
   GET /healthz on MASON_HEALTH_PORT (4140) answers 503 while it starts and 200 once it serves; the first start takes
   about 15 seconds before that, then syncs the tables. GET /metrics on the same port is for Prometheus: numbers only
   (tables by phase, lag, ages, sizes, statements), never a table's or a user's name, so it needs no secret.
   MEMORY: the engine may use half the container's memory limit by default (else half the machine's RAM); the other
   half is the page cache, Node and the catalog (~820 MB). Give the container enough that the page cache holds the
   columns your dashboards read: a query over a column it does not hold runs at the disk's speed. The benchmark's synced data
   was about a fifth of its tables in Postgres (10.1 GiB to 1.8 GiB, on a 15 GiB machine); mason status says yours.
   To set it, MASON_DUCKDB_MEMORY=4GB with the container's limit about twice that. A statement past it fails alone
   (53200) and the run goes on; a value near the container's limit is an OOM kill. What spills past memory takes at most
   half of what is free on the disk (MASON_SPILL_LIMIT sets it); a statement past that fails alone (53400).
   CPU: memory first, then cores. The benchmark's machine (4 vCPU Graviton3, 15 GiB) answered 32 clients at 10 M rows,
   12 statements a second at a p95 of 3.5 s, as many a second as at 8 clients: more clients waited longer. A first sync's
   readers take about a core each while it runs (MASON_COPY_PARALLEL, default 3). The image is arm64 (the measured
   one) and amd64. Which settings to decide: ${REPO}/deploy/mason-data/README.md#settings

3. CONNECT THE TOOLS: beside the server (docker compose exec mason …), a user is a password a tool keeps:
     mason user add metabase                        its URL and password, printed once
     mason user add agent --role agent              a user held to a role of mason/roles.yml: the tables and columns it reads
     mason user add acme --role tenant --set tenant=42   and the rows: a role whose where: reads :tenant
     mason user list
     mason user remove metabase                     ends it at once, without a restart
   The tool connects to the Postgres API (5433) as to a read replica, each added table a table, in the database
   mason: a tool moving from your Postgres changes its host, port and database name, or database: <name> in the sources
   file keeps its name (MASON_PG_DATABASE on a server whose sources file has no such line). Changing
   MASON_API_KEY removes every user. mason/roles.yml ships with mason/ (mason help user shows the file): a user with
   a role is refused anything past it as Postgres refuses it (42501), and information_schema and mason mcp list it only
   what it may read; a user added without --role reads as the file's default: (mason init writes default:
   everything, tables: all — every synced table), and nothing when the file names no default. A role's where: and
   through: filter its tables' rows by the values each user carries (--set), every read of them filtered; a user
   missing a value is refused at every statement, never answered with no rows. A roles file from before this release
   names no default: write default: <role> at its top before upgrading, or its roleless users read nothing.

4. CHANGE IT: ship mason/ with your release and restart the container; a table added or removed is synced or dropped
   at the next start, or beside the server:
     mason add public.orders                        synced at once, added to the mounted mason/sources/
     mason remove orders                            taken out of the sources file, its synced data dropped
     mason status                                   each synced table, the statements, the recent errors
   Upgrade: read the release notes, then move mason.yml and the image together. Removing Mason for good in replication mode:
   SELECT pg_drop_replication_slot('mason_dev_<name>_<source>') — the slot holds your WAL (mason status names it).

The whole account: ${REPO}/README.md
`;
}
