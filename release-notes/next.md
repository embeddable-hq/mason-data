The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **`GET /metrics` names two metrics and the table phases in sync's words; change your dashboards and alerts.**
  `mason_copy_bytes` is now `mason_synced_bytes` and `mason_copy_rows` is now `mason_synced_rows`; `mason_tables`'
  `phase` label says `synced` where it said `copied` and `syncing` where it said `copying` (`waiting` and `failed` are
  unchanged). A query or alert on an old name finds no series after the upgrade, so it reads as absent, not as zero:
  rename it in the same step. `/healthz`'s `tables` counts keep their keys.
- **The Helm chart's `memory.copy` is now `memory.engine`.** Rename it in your values file before `helm upgrade`:
  a values file that still sets `memory.copy` fails to render, naming `memory.engine`, and nothing is installed (it is
  never run with the default in its place).
- **EXPLAIN (FORMAT JSON)'s `Kept Current By` says `syncing again in full` where it said `copying again`**, for a table
  read again whole at its interval; `mason mcp`'s `kept_current_by` says the same. A tool that matched the old words
  matches the new ones.

## What changes

- **On the web page's Tables, an added table says which columns it syncs, and you can change them there.** Its note
  says "All columns", "5 of 12 columns" or "All but 1 column". Click it to tick the columns to sync, as
  `mason add <table> --columns …` does. Before you save, the form says what it costs: the table is synced again in full
  from your database, and its synced data can still be queried until that finishes. Saving the same columns changes
  nothing. An entry the form can't show as ticks (an `exclude:` written by hand) is described, and the form says that
  saving replaces it. A read-only page shows the columns with no way to change them. `mason status --json` gains
  `columnCount`, and for an added table `entry` and `everyColumnLeavesOut`.

- **The web page no longer shows a psql line**: the Users page's Connect card keeps Host, Port, Database, SSL mode and
  URL, and the Overview's Connect (and Queries' when the request log is empty) keeps the URL, each with Copy; Getting
  started's last step no longer has a "Copy the psql line" button. Paste the URL after `psql`. `mason status` and
  `--json`'s `psql` field are unchanged.

- **The web page's card for a user just added shows URL, User and Password only**, each with Copy: the Database, Host,
  Port and SSL mode it repeated are on the Users page's Connect card above it. `mason user add --json` is unchanged.

- **Every example in a box on the web page now starts with "e.g."**: the Tables and Queries search boxes say
  `e.g. orders`, Queries' since `e.g. 2h`, and a new user's name and where it connects from `e.g. metabase` and
  `e.g. 192.0.2.0/24, 2001:db8::/32`, so an example is never taken for a value already filled in.

- **On the web page's Users, Connect comes first and the cursor starts in the new user's Name.** The page reads
  Connect, then the Add a user form, then the users; arriving on it (from the sidebar or a link) puts the cursor in
  Name, ready to type, except on a touch screen, on a read-only page, or when you have already clicked into something.

- **The web page speaks plain English.** Its words are whole, short sentences, and it says "query" where it said
  "statement". It tells you how to do things on the page (Sync now, a table's Sync button, Enable, Users) and names a
  `mason` command or a file only where the page can't do it. For example, a table just added says what its sync is and
  that its Sync button changes it, where it named the sources file and `mason add --sync`. `mason status` and the other
  commands keep their own words.
- **"Catching up" is now "Finishing sync".** A table whose first sync is done while Mason gets the changes made during
  it says "Finishing sync" on the Tables page, and "Getting the changes made since it was last synced. You can query it
  meanwhile." under it. `mason status` and `mason wait` say that sentence too, and a streamed table's line says
  "getting the changes made since 09:00 UTC: reading the changes". `--json`'s `catching-up` is unchanged.
- **The Overview's "Mason" card shows only what you can use.** It keeps Database (its name, host, Postgres version, and
  whether it is your main database or a read replica), Mason (version and uptime), Disk (free space beside what the
  synced data uses) and Connected tools; restarts show only when there were some. The sources file, the sync settings
  and the page's socket are no longer on it: the Tables page shows each table's sync. A database on another machine is
  now a quiet line, "Your database is on another machine. Mason will sync the tables you choose to this machine.", not a
  warning, and a primary is no longer a warning on the page. How text sorts shows only when it differs from your
  database, as one line.
- **A synced table with no size says why, instead of "—".** On the web page's Tables, a table whose rows are not in
  the main file yet shows `< 3 MiB` (all its rows are in the write-ahead log, so it takes less than the log's size); one
  not measured since it was synced, since data was written to disk, or since Mason started shows `Measuring…`; and one
  whose first sync is not done shows nothing. Each says why on hover. `mason usage`
  lists those tables the same way under the sizes, and `--json` adds `sizedAt`, `walBytes` and `unsized`.

## What was wrong and is now right

- **Changing the publication a project replicates through no longer loses or freezes changes.** When the sources
  file's `publication:` (or `PG_PUBLICATION`) changed between two starts — from Mason's own to one you named, from one
  you named back to Mason's own, or from one named publication to another — Mason kept reading its replication slot
  with the new publication. A write transaction that was open while the new publication was created, and committed
  after, was then skipped: on Postgres 18 its rows never reached the synced tables, with only a warning in the
  database's log; on Postgres 16 the stream stopped and never moved again, holding the database's WAL. Now such a
  start drops the slot (and Mason's own publication, when that was the one read), verified gone, makes a new one, and
  catches each table whose sync is `replication` up by one poll. That poll is one full read of each of those tables on
  your database, once: `mason start` says so when it makes the switch. If you switched publication with an earlier
  Mason while your application was writing, a replicated table may be missing those changes: `mason remove <table>`
  then `mason add <table> --sync replication` syncs it whole again.
- **Table names are readable on the web page's Tables at laptop widths.** At 1024 px the name column was 2 px wide. Now
  it always keeps room for a typical `schema.table` name, and a table's name and its state are never cut with "…": a
  long one wraps onto more lines. In a narrower window the Key, Size, Last sync and Rows columns give way, in that
  order, and the row's note says what they said. On a phone a row's buttons are stacked, so the names fit beside them.
- **What Add or Sync now says on the web page's Tables no longer covers the next row's buttons.** It is placed where it
  covers no other button. Where there is no such place (on a phone, say), it is a bar at the bottom of the window, and
  the page leaves room under its last row so nothing stays hidden behind it. A tap on the message, even near its edge
  on a touch screen, never presses a button under or next to it, and its Dismiss is always in view.
- **The web page no longer shows old data as current while Mason can't be reached.** When the page lost Mason (the
  run stopped, or the tunnel closed), it kept what it had read, its big "Ready" and the cards, under the failure
  message, and they read as current. Now the page greys what it read before and says when it was read: "As of 14:02
  UTC. Mason can't be reached." With nothing read yet, the Overview says "Unknown". The page is current again as soon
  as Mason answers.
- **The web page's Users table no longer shows its Added header in a framed box.** The style of a new user's
  password card also caught the column's header, giving it a border and a colored bar.
- **On a phone, a new user's password card is scrolled into view.** After Add a user it was written at the bottom edge
  of the screen.
- **The Overview's "Connect from anywhere" heading no longer overlaps the tip above it**, and on Users › Connect the
  full stop after `<password>` no longer wraps onto a line of its own.
- **The Remove button is back on the web page's Tables.** Each added table showed "View events", "Sync now" and then
  only "…". The button was cut off because its column was too narrow. Now the column fits all three buttons at every
  window width.
- **A site's own links in the web page's sidebar now line up with the page's own.** These are the links set by
  `MASON_UI_NAV_LINKS`. In a narrow window their icons sat left of the others, and the current one's highlight was cut
  short. In a wide window and on a phone, their rows were shorter than the others. Now they look the same as the page's
  own links at every width.
- **The web page's Add a user form no longer jumps when "Connects from" is toggled.** Ticking "Only from these
  addresses" showed the address box and pushed Add a user onto a line of its own; From anywhere pulled it back. Now the
  box keeps its place whichever is ticked, saying "any address" under From anywhere, so nothing in the form moves; the
  same in a user's From… box.
- **The web page's radio choices line up.** Where a choice wrapped, "Only from these addresses" started under the
  "Connects from" label rather than under "From anywhere". Now every choice of radio buttons (where a user connects
  from, in the add form and in From…; a table's sync) is one a line with the buttons in one column, or, in the add
  form where there is the room, one row.
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
