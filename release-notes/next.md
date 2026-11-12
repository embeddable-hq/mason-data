The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The Overview is shorter, and says what its word means.** Under the title "mason status", Ready, Under way or
  Failed now has a line saying what it means for the synced data: every added table is synced and served; how many of
  the added tables are synced while the rest sync; or how many tables' syncs failed, with a link to them on Tables.
  Getting started has three steps (Mason is running, a table synced, a user created) and goes once those are done.
- **`mason status` and the web page's Overview say the same rows under new labels.** Source is now Sources file, Disk
  is Free disk, Sessions is Connections open, and the Mason row is two: Version (`dev`, or the version) and Up (how long
  and since when, with the pid in `mason status`; no more "one process"). On the Overview, Database and Changes are under
  the line in the "mason status" box, and the rest is in a table captioned Server. `mason status --json` is unchanged.
- **Two new cards on the Overview: Sync errors and Query errors, the last day.** Each counts the failures of the last
  24 hours and links to them (Sync events, failures only; Queries, the refused or failed statements); a count the page
  could not read says "unknown" and why. They replace the lists of recent errors at the foot of the page. The table of
  the last day's and week's statements is gone too (the Statements and p95 cards stay, and Queries lists every
  statement), and so is the Connect panel, with Connect from anywhere (now Share over the internet, on the Users page): the Postgres URL is still on Queries while its
  log is empty, on the Users page, and in `mason status`; `mason share` opens a share from the command line.
- **The Tables page lists the added tables first**, then the tables not added, so on a database of hundreds of
  tables the ones Mason syncs are at the top under All. A table you add or remove keeps its row, its state changing in
  place, and moves to its group the next time the list is laid out: when you open the page again, or change the search
  or the All / Added / Failed / Not added filter.
- **Every example in a box on the web page now starts with "e.g."**: the Tables and Queries search boxes say
  `e.g. orders`, Queries' since `e.g. 2h`, and a new user's name and where it connects from `e.g. metabase` and
  `e.g. 192.0.2.0/24, 2001:db8::/32`, so an example is never taken for a value already filled in.
- **A user added on the web page's Users page shows only what is its own.** The card shown once is titled "New user
  added" and has the User, then the URL, Password and Database, each with Copy, "Shown once" under the password, and
  one line: the password is only shown once. The host, port and SSL mode are Connect's on the same page, and the card
  no longer repeats them. `mason user add` in a terminal prints every row, as before.
- **Share over the internet is back, on the Users page.** Inside Connect, the box "Share over the internet (for
  testing)" opens what `mason share` opens, for a tool that cannot reach your machine: choose the role it reads as
  (where `mason/roles.yml` offers more than one), click Share, and it shows the public URL and the share's own login
  and password, each with Copy, the password shown once. It is live until you stop it (Stop sharing), until a free
  share's hour is up, or within two minutes of the page closing, and the box says how it ended. It is not offered
  under `mason serve` or on a read-only page.
- **The Users page lists the users first**, under its title, then the form that adds one (with the card of a user just
  added beside it) and Connect.

## What was wrong and is now right

- **The time range on Queries, Usage and Sync events no longer moves when a range is chosen.** Before, choosing any
  range but Now pushed the whole control left (its "as of … UTC" and Refresh are wider than Live), so the range just
  clicked slid away under the pointer. Now Live, or when the range was read and Refresh, sits left of the control in
  room kept for the longest, and the control stays where it is at every width, on a phone too.
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
