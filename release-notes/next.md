The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The Overview is shorter, and says what its word means.** Under the title "mason status", Ready, Under way or
  Failed now has a line saying what it means for the synced data: every added table is synced and served; how many of
  the added tables are synced while the rest sync; or how many tables' syncs failed, with a link to them on Tables.
  Getting started has three steps (Mason is running, Sync a table, Connect a tool), each in the same words done or not,
  and goes once those are done. Connect a tool is done once a tool has used Mason (it has logged in, or run a query),
  no longer as soon as a user exists; its button, "Create a user first", goes to the Users page.
- **`mason status` and the web page's Overview say the same rows under new labels.** Source is now Sources file, Disk
  is Free disk, Sessions is Connections open, and the Mason row is two: Version (`dev`, or the version) and Up (how long
  and since when, with the pid in `mason status`; no more "one process"). On the Overview, Database and Changes are under
  the line in the "mason status" box, and the rest is in a table captioned Server, in place of the "Mason" card. `mason status --json` is unchanged.
- **Two new cards on the Overview: Sync errors and Query errors, the last day.** Each counts the failures of the last
  24 hours and links to them (Sync events, failures only; Queries, the refused or failed statements); a count the page
  could not read says "unknown" and why. They replace the lists of recent errors at the foot of the page. The table of
  the last day's and week's statements is gone too (the Statements and p95 cards stay, and Queries lists every
  statement), and so is the Connect panel, with Connect from anywhere (now Share over the internet, on the Users page): the Postgres URL is on the Users page and in
  `mason status`; `mason share` opens a share from the command line.
- **The Tables page lists the added tables first**, then the tables not added, so on a database of hundreds of
  tables the ones Mason syncs are at the top under All. A table you add or remove keeps its row, its state changing in
  place, and moves to its group the next time the list is laid out: when you open the page again, or change the search
  or the All / Added / Failed / Not added filter.
- **A user added on the web page's Users page shows only what is its own.** The card shown once is titled "New user
  added" and has the User, then the URL, Password and Database, each with Copy, "Shown once" beside the password's Copy, and
  one line: the password is only shown once. The host, port and SSL mode are Connect's on the same page, and the card
  does not repeat them. `mason user add` in a terminal prints every row, as before.
- **Connect from anywhere moves to the Users page, as Share over the internet.** Inside Connect, the box "Share over the internet (for
  testing)" opens what `mason share` opens, for a tool that cannot reach your machine: choose the role it reads as
  (where `mason/roles.yml` offers more than one), click Share, and it shows the public URL and the share's own login
  and password, each with Copy, the password shown once. It is live until you stop it (Stop sharing), until a free
  share's hour is up, or within two minutes of the page closing, and the box says how it ended. It is not offered
  under `mason serve` or on a read-only page.
- **An empty list on the web page is one quiet line**, no longer a big box: "No users yet. Create a user for a service
  like a BI tool or your app: add one below.", "No table added yet. Add one from the list below.", and the same on Queries, Usage and Sync events. Queries with no statement yet no longer shows the
  "Connect your first tool" box: one line, "Create a user to connect your first tool", leads to the Users page.
- **Queries is shorter.** Its lead is one sentence, "Every query sent to Mason, newest first."; the time range is its
  only window (the Since box and its help are gone; a bookmark that carried one opens over the range); the line on
  what is not listed (select 1, SET, SHOW, a BI tool's catalog queries) is said once, small, under the list; an empty
  log says "No queries in the last 15 minutes." (the range's span); and the filters are one row where the page is wide
  enough. The User filter is a dropdown of your users, All users first, then the active ones, then the removed ones
  marked "(removed)", whose queries are still in the log; a link to a user not in the list (a share's login, say) still
  filters and shows that name. `mason logs --requests` is unchanged.
- **Connects from is a dropdown again** on the Users page (adding a user, and a user's From…): "anywhere" or "only these
  addresses", which shows the box for the addresses beside it. Nothing in the form moves when you change it, and what
  is sent is as before. The form (Name, Role, Connects from and Add a user) is one line where the page is wide enough,
  and wraps by field below that.
- **The New user added card says when the user has connected.** Under its rows, "Waiting for its first query…"
  until a tool or app logs in with the user (or runs a query), then "Connected".
- **The Users page lists the users first** (Connect is last now), under its title, then the form that adds one (with the card of a user just
  added beside it) and Connect. Its intro now reads "Create and manage Users that you can connect to tools and
  services".

## What was wrong and is now right

- **The time range on Queries, Usage and Sync events no longer moves when a range is chosen.** Before, choosing any
  range but Now pushed the whole control left (its "as of … UTC" and Refresh are wider than Live), so the range just
  clicked slid away under the pointer. Now Live, or when the range was read and Refresh, sits left of the control in
  room kept for the longest, and the control stays where it is at every width, on a phone too.
