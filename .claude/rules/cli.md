---
paths:
  - "src/cli/**"
  - "cli/**"
  - "tests/cli-*.test.ts"
  - "src/lib/did-you-mean.ts"
---

# The `mason` command (`@mason-data/cli`)

**One interface for people and coding agents**, as good for one as for the other. Most people will ask Claude or Codex
to install and use Mason, so every command is driven from a shell. **The two readers are owed different things**
(CLAUDE.md "Two readers, one interface"): a person at a terminal gets feedback (a spinner, a checklist, a bar) and
short, scannable output; a coding agent gets unambiguous, complete context and a machine-readable form (`--json`,
declared shapes, exit codes); both get what to run next, from the same list. The reader is told apart by the stream
(`isTTY`) and `--json` only — never by an environment variable naming an agent. `mason help agent` is the agent's page
(src/cli/guides.ts `agentGuide`, built from the registry and `FAILURE_CODES`, so it cannot list a command or a code the
CLI lacks).

- **Every command documents itself, by construction**: every command, present and future, is self-documenting. A command
  is a `CommandSpec` (src/cli/command.ts: name, summary, usage, options) in src/cli/registry.ts, and its parser reads
  the spec's options, so an option cannot exist without it. `mason --help` is generated from the registry;
  `tests/cli-help.test.ts` holds every command to its own `--help` and `mason help <name>`, a usage with an example,
  every option named in it, and a wrong option answered with the usage. A new command is added to the registry, or it
  does not run. **The list is the runbook** (the commands in the order a user will likely need them): `STEPS`
  (src/cli/registry.ts) names each command's step — Learn (`help` first), Set up (`doctor`, `init`, `start`), Add your
  tables (`tables`, `add`, `remove`, `wait`), Connect (`user`, `mcp`, `share`), Run (`status`, `ui`, `sync`, `logs`, `cancel`, `usage`, `stop`, `destroy`), Go to
  production (`serve`, `login`, `logout`, `replica`, `token`, `deploy`) — and `mason --help` prints the steps as headings, and under Learn the guides too, a line each
  beside `mason help`; `COMMANDS` is derived from it. A command's old name (`dev`, `purge`, `rm`, `connect`, `list`, …)
  answers with the new one and exit 2 (src/cli/main.ts), never runs. Nothing a command prints refers to a repository
  path.
- **`mason start` returns.** It starts the run as a process of its own (`--attach` keeps the foreground) and returns once
  the run prints `READY`; an agent cannot wait on a command that never ends. Running it again for a project whose run is
  up says so and exits 0. The run's terminal is `dev.log` in the project's `.mason/` (`mason logs --start`); `mason logs`
  is the run's log, `mason.log`. The run is kept up by a supervisor (src/cli/supervise.ts) that starts it again after a
  crash and records each restart (`mason status` `engine.restarts`).
  **A full disk under `.mason/` ends neither** (issue 847: the log stream's unhandled ENOSPC killed the run, and the
  supervisor's record write killed it, leaving `restarts.json` empty): the run's log and terminal say a failed write
  once and go on (src/cli/run-output.ts), a file Mason rewrites is replaced whole or left as it was (`replaceFile`,
  src/lib/disk-full.ts: the config, the record, the users), the supervisor holds a note and a record it could not write
  until it can and starts a run that could not get ready on a full disk again once there is room (`ROOM_BYTES`), and a
  write under `.mason/` that failed for disk space is said with ONE way out (`withDiskWayOut`).
  **A log file has ONE reader, which masks as it reads** (src/lib/log-read.ts `LogReader`; issue 621: an older Mason's lines held the source's password in a `password=` value): `mason logs` in
  every form, `mason start`'s watch of `dev.log` and the supervisor's scan read through it, and the files are named only
  there (`logPath`); it releases a line only whole, whatever its chunks, holds nothing of a line between them
  (its bytes are read again once it ends: work linear in the file), and `-f` shows the unended last line as it stands, masked. The mask is #620's (`PasswordLineMask`, the
  `password=` value alone, never a substring of the password). `/api/logs`' buffer is masked by it as an entry is kept.
  `tests/conventions.test.ts` refuses a log file named or read anywhere else.
- **Every command's output has one shape**, the same format for every command so it is easy to scan. A command that
  changes something prints `reportText` (src/cli/command.ts): one line saying what happened, its facts as aligned
  `label  value` rows, then its tips (`Tip: …`, a line each), then a blank line and `Next:` with each command and what
  it does in a column. A command that lists data (tables, status) prints the data in its own layout and ends the same
  way (`endText` / `withEnd`). Progress goes to stderr; `--json` prints none of it; an error carries its way out in its
  own words. `tests/conventions.test.ts` refuses a `Next:`, `Try:` or `Tip:` written anywhere else, and a `Next:` block
  spliced onto the end of a line.
- **Colour, width and the spinner are for a person at a terminal, and src/cli/style.ts's alone**. One palette — bold for
  a heading, `Next:` and a headline; cyan for what you can type; dim for a description or tip; green / red / yellow for
  a state only — and lines wrapped at the terminal's width under their own column. Only when the stream is a terminal
  and `NO_COLOR` is unset (`FORCE_COLOR` forces it): a pipe, a file, `--json` and a coding agent's shell get plain,
  unwrapped text, so what an agent parses never changes. Every command runs under `spinUntilOutput` (src/cli/main.ts):
  quiet for 300 ms on a terminal, a spinner turns on stderr until its first output — on a worker thread writing to the
  terminal's fd, so a command blocked in a synchronous call cannot starve it. `tests/conventions.test.ts` refuses a
  colour code anywhere else in src/cli.
- **One thing a line, never a paragraph**. A list is a line per item with its detail aligned beside it;
  a command that does several things prints them as a checklist (`checklist` / `stepRenderer`, src/cli/style.ts: `mason
  init`, `mason add`, `mason start`); a list command lists names first and says the rest for one (`mason tables`; `--all`
  for every one at once). `mason` alone says where you are and what to run next; `mason help` is every command.
- **Every command but `help` and `mcp` takes `--json`, and every `--json` answer is ONE OBJECT WITH `next`** (both readers
  benefit from next steps): `jsonText(spec, value, next)` (src/cli/command.ts) prints it, adds `next: [{ command,
  what }]` from the SAME `NextStep` list the human output prints, and refuses a key the spec does not declare —
  `CommandSpec.json` names the answer's top-level keys, its usage's `--json` line names each (`tests/cli-help.test.ts`),
  so the help and the answer cannot drift. A list is wrapped (`{ tables: […], next }`), never printed bare. The EXIT CODE
  is part of the contract: 0 done, 1 failed (said), 2 a wrong command line, 124 a command ran out of time (`TIMEOUT_COMMANDS`: `wait`, `deploy`, `replica create`, `replica delete`, `replica upgrade`, `login`, `share`, `ui --ssh`). Every `--timeout` and `--step` is ONE duration grammar (`parseDuration`, src/lib/table-sync.ts: a bare number is seconds, `<n>s|m|h|d`), `<duration>` in each usage; a wrong option is answered with `did you mean` over the spec's options and the synopsis alone (`synopsis`). Human output goes
  to stdout, progress to stderr. **The answer reaches a pipe whole**: a pipe takes writes asynchronously and
  `process.exit` drops what is queued, so the process exits only through `exitWhenWritten` (src/cli/main.ts), once both
  streams are written (`tests/cli-pipe.test.ts`; `tests/conventions.test.ts` refuses another `process.exit` in src/cli).
- **Every failure is one shape, for both readers** (an error is three lines: what is wrong, why, the way out): a
  `Failure` (src/cli/command.ts: `message`, `code`, `why?`, `fix?`, `next?`, `exit?`, `usage?`) said by `failed(cmd,
  f, { json })` — for a person `mason <cmd>: <message>`, then `why` and `fix` as rows, then Next, then a wrong line's usage
  (stderr); under `--json` `{ "error": { code, message, why, fix }, "next": […] }` on stdout, the exit code the same. A
  lookup returns the same fields with the message under `problem` (`Problem`: `theProject`, `theRun`); `RunUnreachable`
  carries one; a command may throw `CommandFailed` for main.ts to say. **A failure's exit code is its CODE's** (`exitOf`:
  `usage` 2, `timeout` 124, else 1), never chosen where it is found. The codes are the closed set `FAILURE_CODES`.
  `tests/conventions.test.ts` refuses a `mason <cmd>: …` written to stderr and a `JSON.stringify` printed to stdout
  anywhere else: a command's own error or JSON is the class come back.
- **Every state a command can meet is src/cli/state.ts's, and every command is run in every one** (a
  retrospective's item 3, after four bugs in two days were a command meeting a state no one had run it in). The states,
  in order — `no_project`, `bad_config` (a `.mason/config.json` that cannot be read: a RESULT of the lookup,
  `BrokenProject`, never an exception), `stopped` (a run recorded that does not answer is stopped), `up` — each with the
  code a command that needs more answers with (`PROJECT_STATES`). A command declares what it needs (`CommandSpec.needs`:
  `project` or `run`) and answers a state below it with that state's CODE. Most ask `reach`, the gate, and say the
  state's own words; `status`, `stop` (exit 0 where Mason is not running: that is their answer), `logs`, `start` and
  `doctor` word their own answer for a state they handle and keep the state's code where they fail.
  tests/cli-state-matrix.test.ts runs every command, as a person and with `--json`, in every state without a run (a
  stale pid, a reused one, a broken config included). **A command needs only what it reads**: `mason tables` reads the
  database's catalog and the project's sources file itself (`readCatalog`, src/cli/commands.ts), so it needs the
  project, not a run; so do `mason add` and `mason remove`, which edit that file (below); `mason user` edits
  `.mason/users.json` beside the run. Both read `MATRIX_ARGS` (tests/cli-matrix.ts),
  which must name every command: a new one is in the matrix by construction. They run with `MASON_DEBUG=1`, so a crash
  prints its stack and is caught whatever the state accepts.
- **A project is a folder**, as with docker's or supabase's CLI: `mason init` writes `<root>/.mason/config.json` (0600,
  gitignored by init: the name and the API key, never the URL) and the project's sources file (`mason/` unless
  `--folder`); it checks the database first (`checkSource`, the one check `mason start` makes too) and writes nothing
  when it fails. **A command means the nearest `.mason/` at or above the folder it runs in** (`theProject`,
  src/cli/project.ts, as git finds `.git`). Nothing of a project is kept in the home folder (a hosted service's login is
  the person's, below). Never a guess at "the only run on the
  machine".
- **`mason init demo` is an ordinary project on a database Mason hosts** (src/cli/demo.ts; the database is
  src/demo/source.ts): the files init always writes — `url: ${DATABASE_URL}`, here with three of the demo's four tables
  added (`DEMO_ADDED_TABLES`; `order_items` is left for the person's first `mason add`, so they see a first sync begin — one
  list, src/demo/seed.ts), its URL in `.env` — and `demo: true` in the config; `mason start` hosts it in `.mason/demo/`
  before it connects, reads it over the wire as any Postgres, and changes it every `MASON_DEMO_CHANGE_MS`; `mason
  destroy` removes it with the synced data.
  Why: a first try must need nothing installed, and must run the read path production runs. **Its port is in the URL
  alone** (chosen free at init, read back by `demoPort`): a second record would disagree with an edited `.env`, which the
  run refuses with the way out. **Poll only**: the demo database has no change log, so a file with `sync: replication`
  is refused before anything starts (`demoChangesRefusal`). A command that connects while the run is down (`tables`, `add`, `remove`, `doctor`) says the
  demo database runs inside mason start — told by the config's `demo`, never by sniffing the URL.
- **Up means it answers** (what a reboot does to a run): a run is up only when its command server answers
  `/api/ping` with the run's token and its own pid (`answers`, src/cli/runs.ts); a pid in the config that is alive is
  not proof — after a reboot the number belongs to someone else.
- **The commands ask the run's command server** (`src/cli/control.ts` → src/cli/run-server.ts: `/api/state?columns=1` (the page polls it lean), `/api/slow`,
  `/api/refused`, `/api/unsupported`, `/api/requests`, `/api/queries`, `/api/running`, `/api/events`, `/api/usage`, `/api/logs`, `/api/users`, `POST /api/pick|remove|sync|cancel`), with the run's token as `Authorization:
  Bearer` from the project's `.mason/config.json` (0600). It listens on 127.0.0.1 only and checks the `Host` header.
  It serves the web page too (`mason ui`, src/web/; `.claude/rules/web-ui.md`), under `mason serve` as well, listening only through `listenOnLoopback`, which takes no address (and, under `mason serve` with `MASON_UI_SOCKET`, a Unix socket made 0600 in a folder only Mason's user can write, whose requests reach the same handler behind the same guard: src/cli/ui-socket.ts), a `PageTunnel` opened with the run's token (`mason ui --ssh`, src/cli/ui-ssh.ts) being the guard's only way to add a Host; its users are
  `mason user`'s own functions (`addUser`, `listUsers`, `removeUser`, `disableUser`, `enableUser`), so the page and the CLI cannot disagree.
  **The run reads the database's catalog only when asked** (issue 890: a 10-second timer kept a serverless compute awake
  with every table `sync: off`): `/api/state`, a table's columns or Sync choice, `/api/pick` and `/api/remove` ask
  `RunContext.freshFacts` (`sourceCatalog`, src/cli/source-catalog.ts: what shows it, `SHOW_ASK`, a read under
  `CATALOG_FRESH_MS` reused and never waited for past `STATE_WAIT_MS`; what acts on it, `ACT_ASK` and `mason add`'s
  `/api/state?fresh=1`, a read made after it asked; the read's lock wait `CATALOG_LOCK_TIMEOUT_MS`, its whole
  `CATALOG_READ_TIMEOUT_MS`; a failure keeping the last and said in the log); a usage sample and `/metrics` read `facts()` as it is. No
  timer reads it (tests/integration/cli-catalog-read.itest.ts counts an idle run's connections).
  **The request log's filters are read by ONE parser** (`requestFilter`, src/cli/request-filter.ts) at both entrances
  — `mason logs --requests`' options and `/api/requests`' query string — so a filter means one thing and a mistake is
  worded once (its key spelled as the entrance spells it). `mason status`'s query summary is its own endpoint
  (`/api/queries`, one scan of the ledger, shared for 30 s: `SUMMARY_TTL_MS`), never part of `/api/state`, which the page asks every 2 s. `mason cancel`
  cancels through the listener's one path, the CancelRequest's (`interrupt`, src/api/postgres/server.ts); what it
  names is the statement `mason logs --running` listed (`--statement`, `RunningStatement.statement`), refused 409 when
  the session runs another by then — a session's number alone is whatever it runs at the moment. **A time is read by ONE
  grammar** (`timeOf`, src/cli/request-filter.ts: an age 30m / 2h / 7d, or an ISO 8601 time WITH its zone; none without one)
  for `--since` / `--until` of `mason logs` and `mason usage` and the `since` / `until` of `/api/requests`, `/api/events`,
  `/api/usage` and `/api/logs`; `/api/users` reads the request log only with `?lastUsed=1` (`mason user list`), because the
  web page polls it every 2 s.
- **`mason wait` shows every added table and is exact** (after `mason add a b c` where `a` and `c` were quick, it showed
  only `b`): a line each (`tableLines`), its bar, percent and state — the finished first, in the order
  they finished, the ones still syncing at the bottom — redrawn in place on a terminal, printed when it changes
  elsewhere; ready only when every added table is synced and served, its one catch-up poll after a whole read over too
  (`catching-up`: said on its line as being caught up, at work in cyan, never "not kept current", issue 834) (`readiness`, src/cli/readiness.ts, which reads each
  table's state in one word, `tables[].sync.state`, never its error or phase a second way: a synced table whose poll,
  catch-up, stream or publication check failed is failed there and here, issue 100; `behind` is said on its line and
  never fails it); a first sync that
  failed is said with its error and that Mason tries it again; each synced table says its sync and when it was last synced on
  its line (`keptAge`: `sync: off, last synced 3 h ago — mason sync <table>`, `polled every 30s, last 4 s ago`), and a
  table in the old layout that it is being read again whole.
- **What a project syncs is ONE sources file** (a `sources` folder, each file a source to sync, naming the tables and
  columns to sync): `mason/sources/<name>.yml`, its name the
  source's — `kind: postgres` (any other kind refused by name, "not yet"), `url:` a literal URL or `${NAME}` (read by
  `appEnvValue`, src/lib/dotenv.ts: `.env.local`, `.env`, the shell; unset is refused with the way out), `database:` the
  name a tool connects with (optional, written out, none is `mason`: `src/lib/database-name.ts`), `tables:` a MAP
  of entries: `{}` every column, `columns:` those (the key always copied), `exclude:` every column but those (never
  both), `sync:` how it is kept current (`off`, `poll <interval>`, `replication`; the file's top `sync:` is every entry's
  default, and none written is `off`, said at `mason start`), `key:` only for a table with no primary key (refused on
  one that has one; refused under `sync: replication`, whose changes the stream applies by key), and `publication:` at
  the top (the publication replication reads, `${PG_PUBLICATION}` allowed; the literal `publication: null` is Mason's own, on purpose). Types are never in the file: the run reads them at every start. A
  second file is refused ("one source per project for now"). ONE reader (`readSource`, `parseSourceText`, then
  `addedTables` against the catalog, src/cli/sources.ts) for the run, `mason tables`, `mason add` and `serve`; every
  mistake of a file on ONE report (`sourceFailure`, code `bad_source`), each with its key, a `did you mean` and the
  way out. A file that cannot be read mid-run keeps the tables read before: a typo never drops a copy.
- **`mason add` and `mason remove` work before `mason start` as after it** (`needs: "project"`): the sources file is
  the list, and `mason init demo` already writes entries before any run, so `mason init && mason add orders && mason
  start` is a natural order. With Mason up they ask the run (`/api/pick`, `/api/remove`: the copy starts or is dropped
  now, and the run's own re-read never races the file's write); with it down they read the catalog themselves
  (`readCatalog`, as `mason tables`), write the file, and their `Next:` is `mason start`. Both entrances call ONE
  check-and-write (src/cli/source-edit.ts `sourceToEdit`, `addEntry`, `removeEntries`), so a refusal is worded once
  (tests/cli-commands.test.ts holds the run's and the commands' answers equal, as a person and with `--json`). A hung
  run is refused (`unreachable`, mason stop); a demo project stopped answers `mason tables`' unreachable, naming
  mason start.
- **`mason add` and `mason remove` edit one entry and keep every other byte** (`withTable` / `withoutTable`, spliced at
  the `yaml` document's node ranges, never re-serialised: a person's comments survive). `mason add` writes what
  `chooseColumns` decides — `columns:` when a subset was named, the key columns written first; every column as `{}`,
  or `exclude:` naming the secret-looking ones it left out, which `--include` names (`--columns`
  instead of a DSL); `--key` for a table with no primary key — and refuses while another entry of the file fails
  against the database ("fix it first"). Never add boilerplate a coding agent would have to delete. `mason remove`
  cuts the entry (the last one leaves `tables: {}`) and the run drops the copy (at once, or at the next start). No `--json` answer names a model
  (`tests/conventions.test.ts`, `tests/cli-help.test.ts`, the state matrix).
- **A project an older Mason made is refused, and nothing is migrated** (no backwards compatibility before v1.0): a
  folder with `models/` and no sources file stops `mason start` (and `serve`, `tables`, `doctor`) in the failure shape,
  the way out `mason init`, which in a project with no sources file writes that file alone (its config, key and copy
  kept); the person adds the tables again and removes `models/`. `OLD_TABLES_DIR` (src/cli/sources.ts) is the one name of
  that folder (`tests/conventions.test.ts`).
- **An edit is checked before it is written, against the database the run copies** (the run's catalog, or with Mason
  down the one the command reads): `mason add` checks its own entry
  (a `--key` must be NOT NULL columns over a unique index: `keyProblems`) and the file's other entries; `mason remove` the
  entries that stay — else the run's re-read would refuse the file, keep the removed table and go on copying it while
  the command said "Removed". A `url:` that now resolves to another database (a `.env` edited) refuses both, and the
  run's own re-read (`rereadSources`) keeps the tables read before and says mason stop && mason start.
- **A server reads its URL from its environment first** (`shellFirst`: `mason serve` is configured by the environment
  alone, a `.env` in its data folder never overrides the platform's), and the variable the sources file names is a
  setting like the others, on `serveSettings`' one report.
- **What the machine lacks is said first, by one command**: `mason doctor` (src/cli/doctor.ts) checks Node, memory,
  Mason's ports, the project's database and the run's health — read-only, every failing line with the way out, ending
  with the next command; `mason --help` and the README open with the requirements.
- **`mason destroy` removes the copy and the state, never the files or the users** (what still exists afterwards must
  be clear; src/cli/machine.ts `removeProject`): stops the run, removes `.mason/` but for `config.json` and
  `users.json` — never the project's files — and in replication mode drops the slot and Mason's own publication,
  verified gone; the next `mason start` copies again. `mason stop` keeps all of it.
- **Alive and silent is a third state, never "not running"** (the test server: a hung run; `mason stop`
  said it was not running and `mason destroy` deleted the 58 GB copy under it, which the process kept open). A pid
  that is alive, is still the process the run recorded (`masonProcess`: after a reboot the number is another process's)
  and does not answer `/api/ping` is HUNG (`runState`, src/cli/runs.ts): every command says so with the way out
  (`not_answering`), `mason status` says `hung` (exit 1), `mason start` refuses before it spawns a run, `mason stop` ends it — its supervisor is TOLD first and
  waited for LAST (`signalSupervisor` … `endRun`: SIGTERM, then SIGKILL after 15 s … `supervisorGone`: the supervisor
  waits for the run, so a kill it was not told of is a crash to it, recorded as "often the system out of memory" and
  restarted from) — and records the stop in `config.lastStop` as the run does for its own, and `mason destroy` removes
  nothing under it. **Which process is the run is what the run records** (issue 798: `mason serve`'s command line did
  not match `start … --attach`, and a hung server read as not running): the run writes its own start beside its pid
  (`running.started`, src/cli/dev.ts; `processStart`: /proc's boot id and start ticks on Linux, `ps -o lstart` in UTC
  elsewhere, none on Windows), and where a start is recorded and can be read the pid is the run only while it is the
  same. A record with no start (an earlier Mason's, or one written on Windows) and a start that cannot be read now (a
  /proc this user may not read) are judged by the earlier check, unchanged (`earlierCheck`: `ps -o command=` matching
  `start … --attach`), so a `mason serve` an earlier Mason started reads as not running when it hangs, as it did. The supervisor is known by its command line under BOTH its names (`supervise.ts` in a checkout,
  `supervise.js` in the package: `isSupervisorCommand`); a process known by the checkout's name alone is never found
  by the package, which is what every user runs.
- **A database is the project's, and a moved one is noticed** (a database that moves to a different host is the same
  database): the first start records the server's `system_identifier` and the database's name
  (`sourceServer`); the same name on another server resets the poll's watermarks (the old server's transaction ids mean
  nothing there), so every row is read and compared and only the changed ones written; another name is refused
  (`sourceMove`: `mason destroy`, then `mason start`). An identifier this user may not read (42501) is said, never guessed.
- **The database name is read by ONE rule, and never from the project's name** (src/lib/database-name.ts; `.claude/rules/postgres-api.md`):
  the run derives it once (`connectDatabase`, src/cli/dev.ts) and records it in `running.postgresUrl`, which every command
  reads (`postgresLink`); with Mason stopped, `projectDatabase` (src/cli/project.ts) reads the sources file's one key,
  so `mason user add` needs neither the URL nor the rest of the file, and a file that cannot say it is refused, never
  guessed. A name is read at the start: `mason status` warns when the file has moved since (`databaseMoved`). `MASON_PG_DATABASE` is
  `mason serve`'s (the sources file's first, the two refused when they disagree) and `mason start` refuses it. **A setting a
  start refuses is on ONE list** (`startSettingRefusal`, src/cli/project.ts), asked by the parent and by the run: a check in
  the run alone reaches a background start as "the run stopped", its way out in a log. Keep
  `mason init` writing no key: the default stays a default.
- **`mason user add|list|disable|enable|remove` is the login a tool keeps** (src/cli/user.ts, src/duck/users.ts, the rules
  in .claude/rules/duck-users.md "Users"): a BI tool stores ONE password that does not expire. `add` prints the password
  ONCE with the URL (one builder, `connectionUrl`), when the run is up; the command needs the project, never the run (it
  edits `.mason/users.json` beside it, `mason serve`'s data folder included). "User" is the word in everything it
  prints, never "token" or "credentials". `mason connect` (a token for a day) is gone: `mason user`
  is enough. `disable` keeps the user and its password and refuses its logins until `enable`; a no-op (disabled
  already, not disabled) is said, `already: true`, exit 0. **With `--replica <org>/<name>` (else `MASON_REPLICA`) it is a
  replica's users on a hosted service** (src/cli/user-hosted.ts; docs/HOSTED-API.md "The users of a replica"): one
  request each, the run's own `/api/users` body, under `/v1/replicas/{org}/{name}/users`; needs no project; the answer
  held to the run's answer shape, every printed value to its grammar (a table in the module's header: the password
  `mason_<its id>_…`, the URL rebuilt by `connectionUrl` and equal to the service's), then printed by the local
  command's own renderers (`listText`, `addedReport`, …) in serviceStyle, its next steps naming the replica
  (`onReplica`). The replica and the token are src/cli/replica.ts's (`replicaOf`, `tokenFor`), deploy's too.
- **A roles file is read by ONE module, in the sources file's words** (`src/cli/roles.ts`: `mason/roles.yml`,
  `default: <role>` and `roles: { <role>: { tables: all | { <table>: {} | { columns: [...] } | { exclude: [...] } } } }`;
  `tables: all` is every copied table, resolved at every read), validated at `mason
  start` against the tables the sources file copies and by `mason user add --role` (the listener's roles while the
  run is up, `/api/state`'s `roles`; the file with Mason stopped), every mistake at its key with a `did you mean`, code
  `bad_roles`; a role the file does not name is `not_found` with the lines to add. `LiveRoles` re-reads it when it
  changes, so an edit applies without a restart, and a file edited into a mistake keeps the last good grants for the
  catalog and refuses every statement of a user with a role (`.claude/rules/postgres-api.md`). `mason user list`,
  `mason start` and the web page say which users carry a role the file no longer names. **`mason init` (and `init
  demo`) writes the file** when the folder has none (`newRolesText`, its one writer: `default: everything`, `tables:
  all`), and keeps one that is there. What a user with no role reads is the FILE's (`userRole`, one function for `mason
  user add` / `list`, `mason start`'s line `rolesDefaultLine` and the web page; `roleFrom`, `readsNothing` in `--json`).
- **`mason share` holds its share in the foreground, and its connection to the run IS the share** (src/cli/share.ts,
  src/cli/share-run.ts, src/cli/tunnel.ts; docs/POSTGRES-API.md "From a cloud BI tool"): `POST /api/share`'s answer stays
  open (`holdRun`, src/cli/control.ts, never fetch, which gives up on a silent body), so a `kill -9` closes the share as
  Ctrl-C does, and the run stops the tunnel client by its checked pid (`stopTunnelClient`). **The password is the command's,
  printed once; the run receives its SHA-256 alone**, in memory, so nothing the run logs or answers can carry it, and it is
  no row of `.mason/users.json`. A free tunnel's end ends the share (exit 1, `Next:` mason share: a new address and a new
  password); a paid token's reconnects, the password unchanged, said. **A secret never reaches a command line**
  (`ps`): the token is in a 0600 config file named by `-F`, removed once the tunnel is up, and masked in whatever a failure
  repeats of the client's output. **ssh never prompts** (`detached`: no terminal; `accept-new` into `.mason/share-known-hosts`;
  `SSH_ASKPASS=true`, forced). **The client's output is not ours**: a time limit, a shape, and a probe of the address
  for the share's own certificate (`probeShare`: `other` is a Failure, `unknown` a tip, "couldn't tell" kept apart
  from "no"). What `--json` prints is one object, once; everything after it is on stderr, so stdout stays one
  document. **Its roles are the listener's** (`checkRoles`, each row filter read by the catalog), so a filter Postgres
  refuses stops it at its start, and a role whose filters read an attribute is refused and left out of the choices
  (`attributesOf`, the rule a session is refused by): a share's login carries no values. `mason serve`'s run refuses it. The vendor's name is in `--via` and the `via` row alone, never a headline.
- **`mason mcp` is an MCP server on stdio, a client of the Postgres API as a `mason user`** (src/cli/mcp.ts, docs/DESIGN.md
  "An MCP server"): stdout is the protocol's (JSON-RPC frames alone), every log line goes to stderr, and so does a
  failure to start — it takes no `--json` (`CommandSpec.stdout: "protocol"`; tests/cli-help.test.ts); a tool's failure is
  Mason's refusal (SQLSTATE, message, DETAIL, HINT) as an MCP tool error, never a stack; it never makes a user by itself
  (no URL: refused, naming `mason user add claude`); its tools read only the wire, so a remote `mason serve` answers as a
  local run does (tests/cli-mcp.test.ts).
- **Where the listener is comes from ONE reader** (`pgListenerAddress`, src/api/postgres/listener.ts: `MASON_PG_PORT`
  default 5433, `MASON_PG_HOST` default 127.0.0.1), read by the listener, by `mason serve`'s config check and by
  `mason start`, which picks a port free on every address (src/cli/ports.ts, `mason doctor`'s probe too) or takes
  `MASON_PG_PORT` when the shell names it — refused in the Failure shape when held, never swapped — and records
  `running.postgresUrl`. **The port is the project's** (a BI tool's saved connection must not change at every restart,
  on a laptop too): the first start records its choice as `config.json`'s `pgPort`, every later start
  listens on it or REFUSES naming the holder (`heldProjectPort`), never walks to another port; `MASON_PG_PORT` in the
  shell moves the project, said as a move. `mason start` and `mason status` print the URL with `<user>:<password>` as
  placeholders, never a credential.
- **Whether the listener is TLS is the same reader's, and off loopback it is TLS or refused** (the run once fixed
  its host to 127.0.0.1 and its TLS to none, and a TLS proxy had to be written beside Mason for a hosted BI tool).
  `mason start` reads `MASON_PG_HOST`, `MASON_PG_TLS_CERT` / `_KEY` and `MASON_PG_PLAIN` through `pgListenerSettings`
  (src/api/postgres/listener.ts) and refuses a plain listener off loopback in the Failure shape before it spawns or
  connects (src/cli/pg-tls.ts `runListenerSettings`, background and attached alike); `--self-signed-tls` hands its own
  `.mason/` files (src/cli/self-signed-cert.ts) to the same reader through the same two variables, never a second
  path. The recorded URL carries `sslmode=require`, so every line that prints it is right; `running.postgresListener`
  is how it listens (address, TLS, fingerprint), which `mason status` says (tests/pg-tls.test.ts).
- **`mason serve` is the run for a server, configured by the environment alone** (deployed to a server or to a managed
  infrastructure platform; src/cli/serve.ts, docs/DESIGN.md "On a server"): it writes
  `MASON_DATA/.mason/config.json` from the environment at every start and runs `mason start --attach`'s run through
  its `serve` hooks (src/cli/dev.ts `ServeHooks`), never a second run. Every setting missing or wrong is ONE report; a
  project `mason init` made is never taken over; `/healthz` takes no credential, so it says counts, never a name. **`GET
  /metrics` beside it (src/cli/metrics.ts) serves numbers only** — counts, lag, ages, sizes, never a table's, user's,
  client's or host's name nor a statement, as a value or a label — for the same reason, rendered from the facts the state
  and the usage sampler already compute (`metricsFacts`), never a second computation, and **a scrape never reaches the
  source** (its rate is anyone's: the stream's position and the slot as cached, `streamStatus({ refresh: false })`,
  absent when older than two samples). Detectors: `MetricLabel` (a label of another name does not compile) and
  tests/conventions.test.ts (every label key literal); tests/cli-metrics.test.ts holds the renderer's reads to a closed
  list of numbers; tests/duck-sync-facts.test.ts counts the connections a cached status opens (none).
- **Whether the project's files may be written is ONE function's** (`projectWriteRefusal`, src/cli/project.ts; issue
  473): a deployment that ships its committed folder sets `MASON_PROJECT_READONLY=1`, which the run records in the config
  at its start (`projectReadOnly`, removed at a start without), and EVERY writer of a project file asks it first and
  writes nothing on its refusal — `sourceToEdit` (so `mason add`, `mason remove` and `/api/pick|remove`), the commands
  before they reach the run, `serveSource`, `ensurePin`, `mason init` — either the environment or the record refusing,
  so a command beside the run cannot un-say it; `/api/state` `sourcesReadOnly` is its answer, and the page offers no Add
  or Remove. A value not 0 or 1 refuses the start (`startSettingRefusal`, `serveSettings`) and every edit. A new writer
  of a project file asks it (tests/cli-project-readonly.test.ts, the state matrix's "deployed" state).
- **`sync: replication` is the production change path on a laptop, per table** (src/cli/replication-mode.ts): the
  sources file alone decides — `mason start --replication`, `--poll` and `--publication` are gone, each answered with
  the line to write and exit 2 before anything starts (`removedStartFlags`, src/lib/table-sync.ts), and `MASON_CHANGES`
  set refuses `mason serve` on its settings report and `mason start` by `startSettingRefusal` (`changesRetired`).
  **What the config records and the file does not say is refused, never acted on** (`recordRefusal`,
  src/cli/replication-mode.ts: the start, its run and `serveRecordRefusal`, before anything is written or connected): a
  recorded slot or an older Mason's `changes: "replication"` under a file naming tables with no `sync:` at its top or on
  an entry (any `sync:` is the file saying so: `replication` keeps the slot, `off` or `poll <interval>` confirms the
  drop), and a recorded `publication` that a replicating file and `PG_PUBLICATION` do not name (`publication: <name>`,
  or the literal `publication: null` for Mason's own), both on one report; `publication: null` beside a set
  `PG_PUBLICATION` is refused too, and a bare `publication:` is a mistake in the file. With the run up, a file gone
  silent keeps the tables read before (`silentOverSlot`, `rereadSources`). Settings are asked first at both entrances. A start that replicates any table holds the developer's database to the production checks' own rules
  (`replicationChecks`, src/cli/replication-checks.ts: `wal_level`, the role, a free slot and WAL sender, the WAL cap
  said, not refused; a slot held by another run named with the way out). A switch keeps the copies and catches each
  table up by one poll. What it made is recorded (`config.json` `replication`) and dropped, VERIFIED gone, when the
  file says no table is replicated any more and at `mason destroy`; when they cannot be, the rest goes and the failure prints the
  statements. A slot outlives the run: `mason stop` says it stays and holds WAL. **A publication the operator names
  (`publication:` in the sources file, else `PG_PUBLICATION`) is never created, altered or dropped** — only
  the slot goes — and a read replica needs one, refused by name before any slot is made (`readinessVerdict`;
  `.claude/rules/duck-sync.md`).
- **`mason login` and `mason logout` are a client of a hosted Mason service, by its documented API alone**
  (docs/HOSTED-API.md; src/cli/login.ts, src/cli/hosted.ts): no project needed. The service is `MASON_CLOUD_URL`, else
  `DEFAULT_SERVICE_URL`, its one constant, read by ONE function (`serviceOf`): https, or http to this machine, the
  address alone, refused before any byte is sent. Every answer is untrusted: held to its documented shape, a redirect
  never followed, every token masked; every string of a device code's answer and of who signed in, keys included, put
  to the exact test first (`carriesNoSecret`, with the login it replaces; its own stack, an answer deeper than
  `MAX_ANSWER_DEPTH` refused), and an OAuth refusal's code too, an answer that carries a token refused whole (issue 627);
  a page is tested as the URL parser prints it (`pageUrl`: dot segments removed, a host in its `xn--` form), and a token
  granted is revoked on every failure before it is saved, a crash included (PR 645). **What is tested is what is
  written**: every hosted command (login, logout, deploy, `user --replica`) holds its secrets in the output's gate
  (src/cli/output-gate.ts `holdOutput`, installed by main.ts before the spinner wraps the streams), which reads each
  write to stdout and stderr as written — after styling, line breaks, `JSON.stringify`, a cut — eight ways and across
  writes and streams, and on `ECHO_RUN` of a held secret's body in a row (or a shape) writes the command's refusal
  instead and exits 1; the per-value tests stay the first line (PR 645's class round). **A service's value is data, never structure and never an instruction**
  (src/cli/hosted.ts's header, PR 481): every string it sends leaves that module as ONE line (`serviceText`, applied at
  the boundary: no line break, control, format or bidi character), so it sits inside a line the CLI writes and never
  starts one — no forged `Next:`, tip, row or failure, for a person or in `--json`; and what to run next, the code and
  the exit, and the page a person is sent to are the CLI's own: the code by HTTP status (`codeOfStatus`, never `usage`
  or `timeout`, the service's code kept in `why`), the next step by status (`serviceNext`, the service's `next` never
  read), the page on the service's own origin (`pageUrl`, refused naming both). **On a terminal the visual lines too**:
  `serviceText` collapses white space, and a command whose output holds a service's text draws it in `serviceStyle`
  (src/cli/command.ts), under which the CLI breaks every line itself at the terminal's own width, whatever it is
  (`Style.columns`, set under the 40 columns where `width` is null; `strictWrap`, then `strictLines` as every
  renderer's last pass: the headline, a long word, a label and a step too, a character outside ASCII as two columns),
  never the terminal, and starts every continuation at `continuationAt(width)` (4; 1 under 9 columns; 0 under 3). tests/hosted-fake.ts `mason` holds every run of tests/cli-login.test.ts and
  tests/cli-login-service.test.ts to it: every line a person sees, logical on a pipe and visual on a terminal of the
  run's width (a preload, `terminal`; tests/cli-login-terminal.test.ts runs 12 to 80 columns), is one the CLI begins
  and none the terminal broke (`seenProblems`), and no `--json` string has a line break. **The login is the person's, never a project's**
  (src/cli/credentials.ts: `$XDG_CONFIG_HOME/mason/credentials.json`, else `~/.config/mason/`, 0600 in 0700, renamed
  over, keyed by the base URL): a file or folder others can read is refused with the chmod, one that cannot be parsed
  with its path, both checked before the device code is asked for. **A token never reaches a command line, the output
  or `--json`**; `MASON_TOKEN` comes first, so login refuses while it is set and logout says it stays. Login says the
  page and the code on stderr at once (an agent passes them on), its answer once, when it ends; logout removes the
  login even when the revoke did not reach the service, and says it was NOT revoked (tests/cli-login.test.ts, against
  a fake service on 127.0.0.1; every run's output held to carrying no token).
- **`mason deploy` sends the project folder's files to a replica of that service and waits for the outcome**
  (src/cli/deploy.ts; docs/HOSTED-API.md "Deploying a project"; needs the project). It checks the project first with the
  readers `mason start` uses before it connects (`checkProject`: the pin, `readSourceFile` — `readSource`'s first half,
  never its URL —, `roleProblems` against the tables the sources file names, `readGenerated`'s refusals said), connects
  to no database, and refuses what a start would refuse, sending nothing. The files are `projectFiles` alone, held to
  the contract's bounds (`deployFiles`), and every file the check read is among them. A literal `url:` with its password
  is refused: the service keeps the files. The wait is bounded by `--timeout` (`parseDuration`, the one duration grammar, 1s to 24h);
  an answer that cannot say is a wait, never an outcome; exit 0 only on `running`, a refusal is the replica's failure's
  words as they came, each one line, its code the CLI's (`failureShape`: `refused` / `failed`, the service's in `why`,
  its next step the CLI's: the service's `next` is never read), exit 1, a status or phase outside the closed sets a failure, the deploy's id held to its
  grammar before it is in a path, and before any grammar every string of each answer, keys included, put to the exact
  test (`carriesNoSecret`, src/cli/hosted.ts: a grammar is no mask, issue 627), an answer that carries the token refused
  whole, a timeout 124 with the deploy's id (tests/cli-deploy.test.ts, against a fake
  service on 127.0.0.1; every run's output held to carrying no token).
- **`mason replica create | list | status | delete | upgrade` and `mason token create | list | revoke` are clients of the same service**
  (src/cli/replica-hosted.ts, src/cli/token-hosted.ts; docs/HOSTED-API.md "Replicas", "CI tokens"), with deploy's and
  `user --replica`'s decisions, never new ones: `replicaOf` (the argument, else `--replica`, else `MASON_REPLICA`, said on stderr when it chose) / `orgOf` (the argument or `--org`) / `tokenFor` (src/cli/replica.ts), every
  string of an answer to `carriesNoSecret` before its grammar (a check's and a pending change's words alone are free
  text, masked), the code by status, the next step the CLI's (naming the role that may), the output's gate held from
  the login on. **The database's URL is read from the person or the pipe alone** (issue 720; src/cli/secret-input.ts:
  a hidden prompt on a terminal, raw mode put back on every way out, else stdin whole, bounded), never from argv, `.env`
  or the shell: a command line holding a URL is refused before anything else reads it (`urlInArgs`, exit 2, never
  repeated); the sources file gives only the variable's name (`readSourceFile`), and a `url:` written in it is refused; it is sent once, in the creation's body, and its password held
  as a secret of the command in the ONE list every boundary reads (`urlPassword`; the exact test, the masks, the gate),
  each comparing it with a text by ONE READING of both (`readUnits`, src/cli/hosted.ts: case, `%XX`, NFKD, accents,
  format and control characters, escapes, white space; PR 660's class round); one under `MIN_PASSWORD`, or one the
  CLI's own words hold (`ownWordsHold` over `printedCorpus`, every builder create prints with), is not sent. **A CI token made is
  printed ONCE**: alone on the first line, never broken by the CLI (a value to copy), or `token.value` under `--json`;
  the gate's `once` lets that exact value through one time, holding it as a secret beside the login. An account's first replica is the web app's (a person is asked
  there), said by the help and by a 403's next step. `create` waits for `ready` within `--timeout` (124 past it)
  (tests/cli-replica.test.ts, tests/cli-token.test.ts). **`delete` is asked for twice**: on the line, and typed back
  exactly by a person at a terminal (what was typed never printed), else `--yes`; without either, a wrong line (exit 2)
  before a byte is sent. It waits for the deletion's stage `finished` within `--timeout` (124 past it), each step said
  once in the service's words, then each source's slot: dropped and verified gone, none there, or confirmed by a person
  (exit 0). **A slot NOT verified gone is stage `needs_person`**: the service keeps the replica until the slot is seen
  gone or a person confirms it, so the wait stops AT ONCE (waiting brings nothing), the statement is printed and the
  failure says what the person does then (`failed`, exit 1: not deleted); a `finished` deletion with a slot not
  verified gone is outside the contract. **The statement a person runs by hand is Mason's own** (`byHandOf`: `dropStatements`,
  src/cli/replication-mode.ts, the one authority; `listSlotsStatement` when the slot's name is not known), rendered from the
  names the service gives, each held to `PG_NAME` first (a name outside it refuses the answer); a service's `byHand` is
  advisory, a string put to the exact test and never printed, compared or depended on (PR 687's review, B1: a text
  compared on two sides was a fact derived twice). Every statement a person pastes is written by `pasteLines` alone, on
  its own line, indented, never broken by the CLI and never inside a failure's words (a value to paste, as a CI token
  is: PR 687's N1, PR 660's B2). A deletion is carried only while the state is `deleting` or `deleted`, always while
  `deleted`, its stage the state's (`heldDeletion`); a replica `deleting` may carry none (deleted another way), said as
  being deleted and nothing invented, and one present but malformed refuses the answer; `status` shows it the same way
  (`deletionReport`), exit 0 (tests/cli-replica-delete.test.ts). **`upgrade` is asked for as `delete` is** (typed back,
  else `--yes`) and waits within `--timeout` until the replica carries no pending `upgrade`; a replica's `mason`
  (`version`, `latest`, `next`, each `x.y.z`, in order) is held whole or refuses the answer, and `mason deploy` refuses a
  pin that fits neither `version` nor `next` (`pinRefusal`, by `pinFits`, the image's rule) before it sends, where a 200
  says them; a service that says none, or an answer it cannot read (unless it carries a secret), leaves the pin to the replica (tests/cli-replica-upgrade.test.ts).
- **The road to production is commands too** (the journey from running it locally to deploying it in production; the
  README's "Going to production", `mason help production` offline). Only the project folder
  travels. **`mason.yml` pins the version** the project is written for (src/lib/project-version.ts: init writes it,
  start adds it to an older project; the image refuses another release line or a newer patch, as `mason serve`'s own
  failure before it writes anything (`servePin`, src/cli/serve.ts), and what it says follows from where the version was
  read (`runningVersion`, src/cli/version.ts): the image names the image to run, the npm package the npm line; one rule,
  `pinProblem`, in each reader's words; `dev` and `main-<sha>` check nothing).

## Errors

**Every error says what to do about it** (CLAUDE.md "Conventions"). A message a developer or an agent meets names the
file and the key, says what is wrong in their words, and gives the way out, on ONE report:

- the closest valid name for a misspelling (`didYouMean`, src/lib/did-you-mean.ts: a case, a letter or two, a prefix
  — never a guess at a different word, which is worse than none);
- the choices when there are a few, and what can be read when a column is not there;
- the exact line to add when something is missing (a join's other side);
- the step in the developer's words ("its first sync failed", not "failed at copy"), and what Mason does to a table's data
  is *sync* — the first sync, the synced table, the synced data — never "copy" (CLAUDE.md "Vocabulary";
  `tests/conventions.test.ts` reads every literal in src/ for it).

**A source's URL is shown only through `shownUrl` (src/cli/preflight.ts), which fails closed**: a value that reads whole
as a postgres:// URL, with no part the parse does not read (a fragment, or a query `queryProblem` in
src/lib/database-url.ts refuses: a parameter not read, one given twice, a value the reading does not accept), is shown
with its password masked, and any other value is never shown. Its refusal names the
variable and what the value looks like, and never quotes it (issue 541: a mask that recognised one shape returned the
others whole). Detectors: `tests/cli-security.test.ts` feeds every command a value in each such shape;
`tests/conventions.test.ts` refuses a mask written anywhere else.

A new refusal a developer can meet gets a test asserted on its whole text (`tests/cli-project.test.ts`, `tests/cli-commands.test.ts`).

## What review probes

Run each probe that applies: the implementer before each push, and the fresh reviewer at each review (CLAUDE.md
"How work is done here", steps 3 and 4). A new probe is proposed to the owner; each bullet names the PR or issue it was met in.

- An operator setting given junk (`abc`, `0`, `-1`, `1.5`, `2000`): refused naming the variable and its range, never run
  on a library's reading of it (PR 148).
- Every entrance with a new setting or start-up step (`npx`, the package's bin, the image's `mason`, the run `mason
  start` spawns, its supervisor, Windows): one entrance skipped (PR 148).
- `mason wait <table>` in each state (refused before it was built, a parent refused, deployed but refused, failed with
  the old table serving, a wait past 30 s): an exit code `mason status` contradicts, or output that goes quiet (PR 171).
- A usage text, guide or release-note line beside the code's branches (an exit-1 list, a thread count measured only at 2
  to 10 CPUs): a claim wider or narrower than the code (PR 146, 148, 171).
- A field added to `mason status --json`: on the web page too, carried by a test fixture, and said once, not as a row
  and a warning (PR 135).
- A README or docs command block run top to bottom on a clean machine: a command that holds the terminal, needs ssh or
  the internet, or prints other than the text says (PR 136, 138).
- A source file the convention scans skip (a `.cjs` beside the `.ts`): outside every convention test (PR 148).
