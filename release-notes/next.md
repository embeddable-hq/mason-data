The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The web page no longer shows a psql line**: the Users page's Connect card keeps Host, Port, Database, SSL mode and
  URL, and the Overview's Connect (and Queries' when the request log is empty) keeps the URL, each with Copy; Getting
  started's last step no longer has a "Copy the psql line" button. Paste the URL after `psql`. `mason status` and
  `--json`'s `psql` field are unchanged.

- **The web page's card for a user just added shows URL, User and Password only**, each with Copy: the Database, Host,
  Port and SSL mode it repeated are on the Users page's Connect card below it. `mason user add --json` is unchanged.

- **Every example in a box on the web page now starts with "e.g."**: the Tables and Queries search boxes say
  `e.g. orders`, Queries' since `e.g. 2h`, and a new user's name and where it connects from `e.g. metabase` and
  `e.g. 192.0.2.0/24, 2001:db8::/32`, so an example is never taken for a value already filled in.

- **`--remote` is gone.** `mason init` and `mason start` no longer stop for a database on another machine: they go on,
  and say once "Your database is on another machine. Mason will sync the tables you choose to this machine." Drop
  `--remote` from your scripts: `mason init --remote` now fails as an unknown option (exit 2). The `"remote"` key in an
  older `.mason/config.json` is ignored, and `mason serve` no longer writes it.

- **A database that is not a read replica is information, not a warning.** `mason init`, and `mason start` until the
  first sync is done, say "This is your main database, not a read replica. Mason only reads from it and keeps its load
  small. If you have a read replica, you can point Mason there instead." Neither line is a Warning row of `mason
  status` or in `--json`'s `warnings` any more; `--json`'s `source.standby` and `source.remote` still say both.
  `mason init --json` has a new `notes` list for these lines, and the tip about a password given on the command line,
  which is no longer a warning on stderr.

- **`mason doctor` no longer warns about CREATE in schema public on Postgres before 15** when that is only Postgres's
  own default, which every role has: it says so as information. A grant someone made, or a schema the role owns, is
  still a warning.

## What was wrong and is now right

- **A running Mason no longer connects to your database every 10 seconds while idle.** It read the database's tables
  again on a timer, whatever each table's sync, so a serverless database (Neon, Aurora Serverless) never suspended,
  and every database logged about 8,600 connections a day. Mason now reads them only when you ask: `mason tables`,
  `mason status`, `mason add` or `remove`, `mason doctor` or the web page, reusing a read under a minute old. With every
  table `sync: off`, a run that nobody asks opens no connection after its first sync. A table or column added to the
  database shows within about a minute of being asked for.

- **A BI tool names a column of an enum, a citext or a composite as its type.** Mason sent such a column with the
  source database's number for its type, which Mason's own catalog could hold as another type, often a synced table's
  row type. So a tool that looks the number up (Metabase, DBeaver and Tableau through JDBC, .NET and asyncpg clients)
  showed the column as that table, and a prepared statement that named the type by its number was read as the other
  type. Mason now sends its own number for every type, the one its catalog names, so the lookup names the column's type
  and a prepared statement given that number reads it. The number is no longer the source database's. A physical read
  replica shares its primary's numbers, and Mason sent the primary's until now: an application that learned these
  numbers on its primary and decodes Mason's rows by them must now look such types up on Mason. Mason's numbers for
  these types can also change when the synced tables change (its catalog is built again, for example when a table with
  a new enum is added): a tool connected across that change may show stale type names until it reconnects, and a new
  connection is always right. `pg_typeof` of such a column is also Postgres's: `other.level` for an enum of another schema and `mood[]`
  for an array, where Mason said `level` and `_mood`.
- **A database URL naming a database the server does not have no longer lists every database on that server.** The
  failure of `mason init`, `mason start`, `mason doctor`, `mason tables` and every other command that connects to it
  (and their `--json`) named them all: hundreds on a large
  server, and on a shared one other teams' databases. Now it names the closest one when the name is a typo of it
  ("did you mean `shop`?"), and otherwise only how many others there are; the way out is the same: put the right name
  after the port in the URL.
- **The limit on what statements may spill to disk is in force from the start.** Before, the limit (half of the free
  disk under `.mason/`, or `MASON_SPILL_LIMIT`) was not enforced until the free disk moved by 1 % or more, so a heavy
  statement could spill past it and fill the disk. Now a statement past it fails alone with 53400 and Mason's hint.
  This applies at the default too: a statement, or many at once, that used to finish by spilling past half of the free
  disk now fails with 53400. Set `MASON_SPILL_LIMIT` (for example `40GB`) to raise the limit, or ask for less at once.
  Mason also checks every engine setting it gives at the start, and refuses to start, naming the setting, if one is not
  what it gave.
- **A full disk under `.mason/` no longer kills Mason and leaves it down.** When the disk filled, the run died on its
  own log, and the process that restarts it died too, leaving `.mason/restarts.json` empty, so `mason status` said
  `Unexpected end of JSON input` and nothing started Mason again. Now the run goes on, saying once that its log could
  not be written, and writes its log again once there is room. If it stops while the disk is full, it is started
  again once there is room (8 MiB free), its restart recorded whole then; `mason status` reads a record it cannot
  parse as unreadable and says the rest; and a write under `.mason/` that fails for disk space says so, with the way
  out: free disk where `.mason/` is. Nothing synced is lost.
