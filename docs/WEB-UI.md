# The web page (`mason ui`)

`mason start` and `mason serve` serve a web page beside the commands, in a browser tab: a left sidebar of pages (Overview, Tables,
Users, and the Observability group's three views: Queries, Usage and Sync events) over the state `mason status`, `mason tables`,
`mason user`, `mason usage` and `mason logs` read.

```bash
mason ui              # opens the page in your browser
mason ui --no-open    # prints its URL only
mason ui --json       # { url, port, next }

mason ui --ssh deploy@mason.example.com    # a server's page, from your machine ("On a server", below)
mason ui --replica acme/shop               # a hosted replica's page, for its organisation's owner (docs/HOSTED-API.md)
```

## What it shows

The page has a sidebar on the left — the project (the database, a **demo** badge when it is the demo database), a nav of
**Overview · Tables · Users** and, under the **Observability** heading, **Queries · Usage · Sync events**, each a link with its
icon, the one shown a filled row; at its foot how long ago Mason last answered and the version — and shows one view at a
time beside it, chosen by
the address's hash, so a view can be bookmarked and Back goes to the one before:

| Hash | View |
|---|---|
| `#overview` (none, or one it does not know) | the Overview |
| `#tables`, `#tables?show=failed` | Tables (only the tables whose sync failed) |
| `#users`, `#users?show=removed` | Users (its Active tab; the Removed tab) |
| `#observability/queries` (`#observability`) | Observability › Queries; `?slow=1`, `?status=` (`completed`, `refused`, `failed`, `refused-or-failed`, `cancelled`), `?user=`, `?client=` set those filters |
| `#observability/usage` | Observability › Usage |
| `#observability/syncs` | Observability › Sync events; `?failures=1` ticks Failures only, `?table=` chooses the table |

The hashes of before still land on their view: `#status` is the Overview, `#queries` and `#usage` their views, `#logs`
and `#observability/logs` Sync events. In each Observability view's header row, right of its title, is **the time range the three share**: a segmented control — **Last 15 mins** · Last hour · 24 hours · 7 days · 30 days · 90 days, the last 15 minutes unless the hash says (`?range=1h`, `?range=7d`, `?range=90d`); 30 and 90 days only where Mason keeps that much history (`MASON_HISTORY_DAYS`, 7 by default), else shown disabled with that setting as the reason
— kept in the hash, so a link carries it (the sidebar's links to the three keep it too). **Every range is live**, said **Live**
left of the control (the same word at every range, so the control never moves when the range changes). Each is read
again by itself: the last 15 minutes and the hour every few seconds, 24 hours every 30 seconds, and a week or more
every minute, since those reads scan more of the logs. Live's title says how often. Queries reads the request log since then,
Usage the range's statements, clients and samples (a minute a point for the last 15 minutes and the hour, an hour for the day, six hours
for the week, a day for 30 and 90 days), Sync events the sync's events since then; each
view's own filters compose with it. Only the view shown asks Mason anything, each read at the rate its data changes,
and nothing while the tab is hidden. How long ago Mason last answered is at the sidebar's foot.

Below 1000 px the sidebar is a rail of icons, each label its icon's tooltip (on hover and on focus) and still the link's
name to a screen reader; below 640 px it is a top bar — a menu button, Mason, the project — whose button opens the nav as
a sheet over the page: the focus goes to its first link, and Escape, a click outside it, the focus leaving it or a link
followed close it. The icons are Lucide's (ISC), vendored whole under `src/web/vendor/lucide-1.56.0/`, drawn inline at
16 px in the text's colour.

- **Overview** (`#overview`, read only): under the title **mason status**, the run's word (Ready, Under way or Failed)
  beside a big dot, and one line saying what it means for the synced data, from `/api/state` alone (`readiness`,
  `totals`, the tables' `sync.state`): Ready, "Every added table is synced and served" (the sentence `mason status`
  ends on, `READY_TEXT`); Under way, "2 of 3 tables synced, the rest syncing" (or, every one synced, how many are
  being caught up by their one poll); Failed, "1 table's sync failed: see Tables", Tables the failed ones. Under the line,
  `mason status`'s **Source** row: the Postgres Mason syncs from, and whether it is your main database or a read
  replica. Then cards
  for the tables synced, the rows, the last sync, the synced data's file, the last day's statements with their p95,
  and the last day's **Errors** (every failed event: failed syncs, restarts and the web page's own errors,
  `/api/events?failed=1&since=24h`, read up to 1,000: at that, "1,000+") and **Query errors** (the big number the
  queries that failed, the refused ones on the line under it, `/api/queries`' `day`). Each card has a
  24-hour sparkline once there are two hours to draw, and **each is a link** into the view that lists what it counts:
  the tables (the failed ones when a first sync failed), Usage for the synced data's file, Queries for the statements,
  the slow ones for the p95, the refused or failed ones for the query errors, and Sync events' failures over the last
  24 hours for the errors. A count the page could not read is "unknown" with its reason, never 0. Eight cards,
  nine with the host's (`MASON_UI_OVERVIEW_CARD`): four by two and three by three from 641 px up, two a row on a phone.
- **Overview**, Getting started (while setting up is not done): ✓ Mason is running · ✓/○ Sync a table · ✓/○ Create
  a user — each step in the same words done or not (the ✓ or ○ says which), each ○ with its one action (**Add a table**
  → Tables, **Add a user** → Users). It is done while at least one added table is synced and at least one user exists
  (not removed), read from `/api/state` alone (`tables[].copy`, `users.active`); whether a tool has queried Mason does
  not count, so a deployment nobody queried for a week stays done. With every table or every user removed, it is shown
  again. **While it is shown, the word's box and it are the whole Overview**: the cards and the rest appear once both
  are done and it goes. The word's box is always shown once a table is added, so the state of the synced data is never hidden while you set
  up. Not drawn while it cannot tell (`users` unreadable, `{ error }`, or a run that does not say it). On a read-only
  page that adds no user the step shows without its button. How to connect is not on the Overview: it is on Queries'
  empty log, and the Users page.
- **Overview**, the tables not synced yet: a bar each with the line `mason wait` prints (a first sync not begun shimmers,
  with no % beside it), and nothing once every table is synced.
- **Overview**, the facts: one table, **Mason**, in the page's own words: **Source** (the database's name and host, its
  Postgres version, and whether it is your main database or a read replica), the warnings, Mason (its version and how
  long it has been up), the restarts when there were any, the disk (free, and what the synced data uses), and the tools
  connected. Under it, as quiet lines: that the database is on another machine, and how text sorts where it differs from
  the database. In replication mode, a Changes table shows the stream and the WAL its slot holds.
- **Overview**, the unsupported SQL: when a statement used SQL Mason does not support in the last day, one line naming
  the most refused entry of `docs/SQL-SUPPORT.md`, with **See all** (Queries).
- **Tables** (`#tables`): the database's tables, as `mason tables` lists them, in two lists, **Added** over **Not
  added**, each with its count and in the order `mason tables` lists them, with a search box over both and **Failed
  only** (the failed tables alone; `#tables?show=failed` ticks it). A table added or removed while the page is shown
  keeps its row in its list, its state changing in place, and moves to the other list only when the lists are laid out
  again: the page shown again, or the search box's text or Failed only changed (a click moves no other row). With hundreds of tables the first 100 that pass are
  written, then **Show 100 more** and **Show all**; the search is over every table, at once. A long name is never cut: it wraps in its cell.
- **Tables**, an added table: its state (Synced, Syncing, Failed or Waiting) over its bar — every added table has
  one, as `mason status` draws one for each: full at 100% once synced, red when its first sync failed, amber when it is not kept
  current, moving while it syncs, a shimmer while it waits — its rows, its last sync over how long it took, and the
  table's size. What is said at length (the words `mason wait` prints after a bar not yet full, an error, why a table
  cannot be added, its stream state) is its note, a line of its own under the row, across every column — written for
  every row, empty when it says nothing, so a note that comes or goes moves no row. **View events** opens Sync events narrowed
  to that table; **Sync now** runs `mason sync` for it
  (its button says Syncing…, then Synced ✓, in one width), and is shown disabled, with the reason as its title, while
  `mason sync` of the table would be refused: its first sync not finished or failed, being read again whole, being
  caught up (`/api/state` `tables[].syncRefusal`, the sync's own check); **Remove** asks first, then runs `mason remove`.
  **Nothing a click does moves another row or a column**: the columns are fixed widths, a question (Remove's), a form
  (Columns…) and what an action answered are popovers beside the button, over the rows and never between them — an
  answer, like a refusal, stays until it is dismissed (its Dismiss, Escape, or the next action's answer or question in
  its place) — and only an expander the reader opens (a request's details, a first sync's whole error) pushes the rows
  under it down. **What Add or Sync now answered covers no other control** (issue 884): the answer is placed under its
  row's actions, over them or on their left, wherever it covers no button, link or box of any row; where every place
  covers one (a phone's rows, or a long answer beside a narrow list), it is a bar fixed at the window's bottom, beside
  the sidebar, with its Dismiss, still read out (`role="status"`), the page's end given its height so every row can be
  scrolled clear of it. A tap on the answer is always the answer's, never a control's under or near it, with a finger
  too: the answer is itself a target a browser keeps a tap on, and docked, an unseen band of 16 px above it is its own.
  Docked, its Dismiss stays in view at its bottom however long the answer, the rest scrolling above it; what the
  person scrolled in it stays put when the page is written again; and a long table name in its facts wraps rather
  than squeezing the value beside it (`placePops`, src/web/shared.js).
- **Tables**, **the name keeps its room at every width** (issue 884: it was 2 px at 1024 px): measured against the
  list's card, the name gets at least 200 px, and the less important columns give way first: Key below about 1350 px,
  then Size (1250), Last sync (1140) and Rows (1040) beside the full sidebar. A column given way says its fact in the
  row's note instead ("key id", "size 1.2 MiB", "last sync 3 h ago, took 0.2 s", "1,200 rows"). **A table's name and
  its state are never cut with "…"** (the owner: "otherwise we can't see them"): each wraps in its cell — a name after
  its `.` and `_` where it can, anywhere where it must — and the row grows to fit. On a phone the same columns give way,
  the state is narrower and a row's actions are stacked in a column of their own, so the list fits its card and every
  name and state reads whole. The page never scrolls sideways.
- **Tables**, an added table's **columns**, on its note beside its sync: which it syncs in a few words — "All columns",
  "5 of 12 columns" or "All but 1 column", the columns themselves its tooltip (`/api/state` `tables[].entry`,
  `addedColumns`, `columnCount`). It is a button that opens the table's **column form**, a dialog beside it that reads
  `GET /api/tables/<table>/columns` once, as it opens. It has two choices: **All columns, and any added to the table
  later**, chosen for every column (`{}`, or the `exclude:` of secret-looking columns `mason add` writes:
  `everyColumnLeavesOut`, which All names); with columns left out, All starts with the row's own words ("All but 7
  columns. Left out because they look like secrets: …"), its count from the same helper as the row's (`leftOut`,
  issue 960); and **Only these columns**, chosen for a `columns:` list, with its boxes
  under it ticked as the list says. The boxes are hidden while All is chosen (by the radio, in app.css), and are every
  column but what All leaves out, so choosing Only these starts from what is synced. Only these with no box ticked is
  refused on the page, since an empty list would be sent as every column. For a table with no primary key, it also
  ticks its `key:`. Before Save it says what saving costs: the table is synced again in full from
  the database, which takes a while and adds load on a big table, and its synced data can still be queried until the
  new sync finishes; saving the same columns changes nothing and starts no sync. Save sends `POST /api/pick`
  `{ table, picked: true, columns?, key? }`, as `mason add <table> --columns …` does, its sync kept; boxes that say what
  the entry says send the entry's own lists, so the run answers `already` and writes nothing. **An entry the boxes cannot
  show** — an `exclude:` written by hand, or every column with a secret-looking one kept on purpose — is described at
  the top of the form, its boxes the columns synced now, and the form says that saving replaces the entry with the
  columns ticked. Where the page may not edit the sources file, the columns are said alone, with no button.
- **Tables**, an added table's **sync**, first on its note (`Sync: Off`, `Sync: Every 5 minutes`, `Sync: Live
  (replication)`, as the run keeps it now: `/api/state` `tables[].kept`): a button that opens its **Sync choice**, a
  dialog beside it that reads `GET /api/tables/<table>/sync` once, as it opens (never on a timer: it opens a connection
  to the database), and saves with `POST /api/pick` `{ table, picked: true, sync, keep: true }`, as `mason add <table>
  --sync …` does, writing the entry's `sync:` line alone:
  - **Off**, the default: synced once, then only by Sync now. Nothing turns on load on the database unless chosen.
  - **Every 5 minutes, 15 minutes, hour or day** (presets only), each saying it scans the whole table on the database at
    that interval. For a table over 1,000,000 rows, what every interval shares is said once over the choices: the
    table's rows, and how long a scan takes and how that was found (measured, from its first sync, or a guess). Each
    interval then says its own share: how much of the time it keeps one connection busy (in the warning colour at 10 %
    or more), and how often it really runs where a long scan stretches it. The numbers are `pollLoad`'s, the estimate
    `mason add` prints in its own words; the page never shows the CLI's sentence or its flags. Saving one asks first,
    with that cost.
  - **Live (replication)**, the word beside `sync: replication` in the sources file: changes stream from the database's
    change log, with no scans. It can be chosen only when every check passes, else it is shown disabled with each
    failing check in Mason's words and the SQL that fixes it: the table's own (a primary key; not REPLICA IDENTITY
    NOTHING) and the database's — the checks `mason start` holds a replicating sources file to (`wal_level`, a user that
    may replicate, a free replication slot and WAL sender, on a read replica Postgres 16 or newer with
    `hot_standby_feedback`, the WAL cap) and the table in the publication Mason reads. A warning (no
    `max_slot_wal_keep_size`, `hot_standby_feedback` off) refuses nothing, and saving asks first, saying it. The
    dialog says plainly what Live keeps on the database: a replication slot that, while Mason is not reading it, holds
    every byte of WAL written since, until Mason reads it again or the slot is dropped. **Saving reads the database's
    checks again** (`/api/pick`), so a database that changed since the dialog opened is refused, the refusal shown as
    the run words it, and nothing written.

  Where the page may not edit the sources file (`MASON_PROJECT_READONLY=1`, a server's folder it cannot write, or
  `MASON_UI_READ_ONLY=1` without `MASON_UI_READ_ONLY_ALLOW=tables`) the sync is said alone, with no button, the reason
  its title and above the list.
- **Tables**, a table not added: its rows, its key and why it cannot be added as it is. **Add** syncs every column, as
  `mason add <table>` does; **Columns…** opens a form with the same two choices (All columns at first, every box ticked
  under Only these columns); **Name its key…** does the same for a
  table with no primary key.
- **Users** (`#users`), in this order: the list of users, right under the title (and its read-only line), then the add
  box (the add form; and, where it may be opened, a Temporary cloud login) with the card of what it made beside it,
  then Connect, so a card that appears moves nothing above it. A person arriving on the page — its address opened, a
  link of the sidebar or another followed — starts with the cursor in the form's **Name**, once the form is written;
  never at a poll's write after that, never at a hash of the page already shown (a tab of the list, a range), never taken from what the person focused since they arrived, never on a touch
  screen (`(pointer: coarse)`, where it would open the keyboard over the page), and not on a read-only page, which has
  no form (a page's `arrive()`, src/web/app.js). The
  form adds a user by name and, where `mason/roles.yml` names roles and reads as it is, a
  **Role** as `mason user add --role` (the roles from `/api/state` `roles`, `mason status --json`'s): the file's
  `default:` is chosen first, marked (default), and sends no role, so the user follows the default as one added with no
  `--role` does; with no default the first choice is no role. The run judges the role, and its refusal is shown. Then
  **Connects from**, a dropdown in `mason user add --help`'s words: **anywhere**, the default, sends no `from` (as
  `mason user add` with no `--from`), with no second question; **only these addresses** shows the address box beside
  it and sends the ranges typed there, comma-separated as `--from a,b` takes them (`192.0.2.0/24, 2001:db8::/32`),
  split at each comma and trimmed. The box keeps its place, unseen, while anywhere is chosen, so nothing in the form
  moves when the choice changes (From… offers the same dropdown). Name, Role, Connects from and **Add a user** are one
  line where the form's card is wide enough (a container of its own, `#add-user-box`: a 1280 px window with or without
  a Role, 900 px without one, where the sidebar is a rail), the address box growing into the rest of the line; below
  that the form wraps by field, a label never apart from its control, the address box under its dropdown on a phone. The page
  never checks a range: the run reads each, and a refused one is shown as the run's refusal. `--set`
  attributes stay the command's. Its password is shown once, in a modal dialog over the page titled **New user added**
  (index.html's one `<dialog id="once">`, opened with `showModal`: the page behind it dimmed and inert, the focus on the
  URL's **Copy**; as wide as its rows up to the window less its gutters, so each **Copy** sits on its value's line and
  only a value too long for the window breaks inside its box, the Copy still beside it; on a phone a sheet the screen's
  width that scrolls inside itself). It closes **only** by its button,
  **I have copied it** — never by Escape nor a click outside it, since the password is kept nowhere once it closes — and
  the focus then returns to the form's **Name**, the new user in the list above. No poll closes or rewrites it: its
  parts are written when it opens and when its status line changes, never while a pointer is pressed, and it stays
  open whichever page a hash followed shows. A refusal of Add a user is said under the form, as before. It shows URL, **User** and Password, in `mason user add`'s order, the URL and the Password
  each with **Copy** and laid out the same way, the User its name as plain text (a field `mason user add --json` does
  not carry is not shown); "Shown once" in the password's row, right of its **Copy** and of the button's height
  (`--control-sm`); and one line, "The password is only shown once", over **I have copied it**. No Database row: the
  URL already carries the database, and the database, host, port and SSL mode are Connect's on the same page (`mason
  user add` in a terminal still prints all of them). No psql line: the URL is the same thing, pasted after `psql`. Mason
  keeps no copy, so it is never shown again. Under the rows, a status line: "Waiting for its first query…" until Mason
  has seen the user — a session of it open (`/api/state` `sessions`), or a statement of it since it was added
  (`/api/users?lastUsed=1` `lastUsedAt`) — then "Connected", held once seen. While it waits, the state is read every
  5 s instead of 30 s.
- **Users**, Connect: once for the run, where a tool connects — host, port, database and SSL mode, each with **Copy**,
  and the URL with `<user>:<password>` in place, with **Copy** — as `mason status` says it, with no psql line (the URL
  is the same thing, pasted after `psql`). No user's row carries a URL:
  the card shown once when a user is added is the only place its password is copied.
- **Users**, the add box's **Temporary cloud login** (under `mason start` only: never under `mason serve`, whose run
  refuses it, and never on a read-only page, `pageReadOnly`, whatever `MASON_UI_READ_ONLY_ALLOW` still allows; there
  the box is the plain add form, with no segments): `mason share` from the page, for a tool in the cloud that cannot
  reach this machine. It is the same flow as adding a user with another job, so it is the box's second kind: two
  segments on top of the box, **New user** (the form above) and **Temporary cloud login**, a segmented control as the
  time range's, the choice the page's own (not the hash: a form's, not a view's). The two panes sit in one grid cell,
  the one not chosen unseen in its place, so the box keeps the height of the taller and a choice moves nothing on the
  page; each pane is a part of its own (`add-user-box`, `add-share-box`), so a choice rewrites neither, and a name being
  typed stays. The pane: "For a tool in the cloud that can't reach this machine. Opens a public address with a login
  of its own, until you stop it.", a **Role** choice where `mason/roles.yml` offers more than one role a share may
  read as (`GET /api/share/choices`, read beside the state while it is offered, as `mason share --role`; each option
  says what it reads), and **Open a cloud login**, held disabled while one opens or is open (one at a time). The click
  is the person's yes, the pane's sentence what they have read before it, and no question follows: `POST /api/share` `{ from: "page", confirmed: true, role? }` opens the same share the command
  opens (src/cli/page-share.ts): the run makes the password and starts the tunnel's client. What it opened is shown
  once in the same modal dialog as New user added, titled **Temporary cloud login**: URL, **Login** (its own, never a
  `mason user`, and never listed or counted among the users) and **Password**, the URL and the Password each with
  **Copy**, "Shown once" beside the password's Copy; how long it has been public and what it reads; that the password
  is only shown once and is not saved; and **I have copied it**, its only way out, as a new user's. The password is in
  that one answer alone, kept in the page's memory until the dialog closes (or the share is seen ended, when the
  dialog goes with it). Under the add box a card, titled **Temporary cloud login** on its top edge, shows it live: the
  host, port and login, that the password was shown once, how long it has been public and what it reads, "Live until
  you stop it", when a free one ends sooner (within about an hour) and that it ends when the page closes, and **Stop**
  (`DELETE /api/share/<user>`), which takes the focus when the dialog closes. After a reload the card is the same.
  While it opens, the card says so. The page holds it by a beat (`POST
  /api/share/<user>/beat`, every 15 s, hidden or not): two minutes without one (the tab closed, crashed or asleep) and
  it, its sessions and the tunnel's client end. How it ended (Stop, the tunnel dropped, from `/api/state`
  `shareEnded`) is said in the card's place, and a refusal there is the run's Failure; the pane is the form again.
  Connect says, where it is offered, that a tool in the cloud that can't reach this machine uses Temporary public
  login in the box above.
- **Users**, the list: two tabs over the table, a segmented control as the time range's, each with its count —
  **Active** (the default, `#users`: the users not removed, a disabled one among them with its Disabled status) and
  **Removed** (`#users?show=removed`: the removed ones, muted, with Queries alone). The tab is the hash's
  (`parseHash`, `hashOf`), so Back returns to the tab before and nothing is stored; a tab left drops a question, a
  From… or a refusal open beside one of its rows. An empty tab is one quiet line: "No active users. Add one below."
  (on a read-only page "No active users."), "No removed users."; no user at all, the "No users yet" line alone, no
  tabs. Each user's role and, on a line under it, where it connects from ("from" its ranges as `mason
  user list` says them, or "from anywhere": `from` in `mason user list --json`; cut by the column, its whole the
  tooltip), its status (Active, Disabled and when, or Removed), when added, when last
  used, and **Queries**, its statements. A user that no longer connects is flagged with why. **Disable** asks first (in a popover, in `mason
  user disable`'s words), then runs it; a disabled user's button says **Enable** in the same width, and runs `mason user
  enable` at once. The "from …" line is a button: it asks where the user connects from in a popover beside the row's
  actions, the add form's choice opened at its ranges now, and sends `POST /api/users/<name>/from` (`mason user from`:
  the ranges, or `null` for from anywhere, `--any`); the list holds still while it asks, and a refusal is said in the
  popover. **Remove** asks first; a user removed leaves the Active tab at the next write (its own row goes, the
  others keep their order) and is listed under Removed; a refusal beside a user whose row left goes with it. The table keeps its width (no column of its own),
  fits its card in a 1280 px window, and where it scrolls (a narrower window, a phone) a row's actions stay pinned at
  the card's right. A header cell's class (`added`, `status`, `act`, …) is styled only as a cell (`th.added`), never by a
  box's rule of the same name: the New user added card is `.user-added`, so its white and its left border never reach
  the Added header (`tests/web-page.test.ts`, every header class of Users and Tables, and the pinned rule on `.act` alone).
- **Observability › Queries** (`#observability/queries`): the request log, and only that, under one sentence: "Every
  query sent to Mason, newest first." The time range is its only window: no Since box (a `since` in an old hash is
  ignored, the page opening over the range).
- **Queries**, the request log empty: one line, "No queries in the last 15 minutes." (the range's span; "No query passes
  the filters in …" under a filter). Unfiltered, one quiet line under it, "**Create a user** to connect your first
  tool", the words a link to the Users page (`#users`), where the URL is; none where the page makes no user
  (`pageReadOnly`), nor once a filter or an older page is shown. No Connect box.
- **Queries**, the request log: newest first, with a status dot and word per row as `mason logs --requests` says it: Completed,
  Refused (a statement Mason answers as designed, as a Postgres would refuse it: unsupported SQL, a missing relation),
  Failed (Mason's or the machine's fault) or Cancelled. Filter by status (each, or Refused or failed), user, client, a piece of the
  statement's text (**Statement has**) and **Slow (1 s or more)**, with **Filter** and **Clear**. **User** is a dropdown:
  All users (no filter), then the users of `GET /api/users` (`mason user list --json`; read while Queries is shown,
  every 30 s as the Users page reads it, never with `?lastUsed=1`, and on a read-only page too) — the active first,
  then the removed, marked "(removed)", since their statements are still in the log. A choice is sent as `user=<name>`,
  the server's one filter, as a typed name was; a `?user=` the list does not have (a share's own login, a user whose
  record is gone) still filters, the dropdown showing it as one more option, selected; the users not read, the text box
  as before. The filters are one row where they fit (a
  1280 px window), wrapping by field below that; **Older** pages back and **Newest** returns, 40 a page. **Started**, **Duration** and **Rows** sort the page
  shown (said under it: the pages follow the log's order by start). A statement is one or two lines in its row; a row
  opens in place to its whole id, times, bytes sent, statement and error — the first 16 KiB of each, said when cut.
  A statement that reads no synced table (`select 1`, `select now()`, SET, SHOW, a BI tool's catalog queries) is
  answered without the synced data and **not listed** — the protocol's chatter, hundreds a connection from a BI tool — and the
  page says so once, in a small quiet line under the list (empty or not), as `mason logs --requests` says it.
- **Observability › Usage** (`#observability/usage`): every part follows the range. Cards: over the last 15 minutes, the sessions
  connected and the statements running; under any other range, the clients that sent statements in it; then the
  range's statements, failed, p95 and what was sent (bytes, and rows under it), each with a sparkline — the statement
  cards lead to Queries filtered to what they count (all, failed, slow).
- **Usage**, connected: over the last 15 minutes, who is connected now — a row per user and client, the 10 with the most sessions and
  one row for the others; under any other range, who sent statements in it, the most first, with their failed ones,
  sessions and last statement. Each row's **Queries** opens the request log filtered to that user and client.
- **Usage**, running: over the last 15 minutes, each statement running with how long it has run (moving with each poll; when it started is its title) and **Cancel**, which asks first and stops that one statement, as
  `mason cancel` does; under any other range, the slowest statements that completed in it, each with **Queries**.
- **Usage**, unsupported SQL: the statements of the range Mason refused for SQL it does not support, grouped by their
  entry of `docs/SQL-SUPPORT.md` (named, as the page cannot link into the repository), the most refused first — how
  many, when the latest was, who sent them and the latest statement on a line, as `mason status` says them.
- **Usage**, charts and tables: four charts over the range (statements, p95, the size of the synced data, the rows in it), their
  time axis in minutes, hours or days by the range, their values compact (`1.2K`, `3.4 MiB`, `512 ms`) and exact on
  hover; a series with one sample says its value instead. Then each synced table's own size, measured every 10 minutes. The
  samples, newest first (**Time** sorts them), sit behind a closed details, and the process's memory behind another.
- **Observability › Sync events** (`#observability/syncs`): the sync's events of the range — each first sync, each
  failure and recovery, each sync asked by hand (`synced`: `mason sync`, a table's **Sync now**) — newest first (**When**
  turns it round), with when, kind (in words: Manual sync, Full sync, Scheduled sync, Live sync, Scheduled sync failed…;
  the code `mason logs --events` prints is its title), table and reason. The scheduled syncs that succeed (each poll on
  its schedule, and each minute the stream applied changes, a row a table) are listed only while **Scheduled syncs** is
  ticked, or one of their kinds is chosen: Mason is asked for them then (`?scheduled=1`), so they never push a failure
  out of the newest 500 read. **Failures only** asks Mason for the range's failures alone (`?failed=1`), so every failure
  of the range is listed, whatever else is ticked. A **Kind** (every kind of event) and a **Table** (every added table, whether the range has an event of it or not: one with none says so by its name) narrow the list; 100 are
  written at once, then **Show more**.
- **Sync events**, the run's raw log: behind a closed details, for debugging (it has internal tags and paths), newest first. Mason
  is asked for it only while the details is open.

When something is refused, or Mason stops answering, the page says it as the commands do: what is wrong, why, the way
out, and the commands to run next.

## Presentation

The page looks like Mason's own: a mason lays stone and brick course by course, and Mason builds a copy of a Postgres
table by table and keeps it standing. Warm graphite words on a clean stone white, quiet low-contrast surfaces, mortar-grey
hairlines and ONE patina — a desaturated verdigris, the green copper and weathered stone take on — for the accent and
the primary action, used sparingly; in the dark, a calm charcoal slate (never black) with the patina lifted. No big
inverted band: the sidebar's head, the nav's current row, a table's header row and the raw log are tinted surfaces. Mono first —
Geist Mono for the chrome, the labels, the numbers and the tables, Geist Sans for a sentence of prose — under a slab
display face (Zilla Slab) for a page's title, the run's word and a card's number, so the page has a voice of its own
and the data still reads as a tool's printout. Boxes are square, framed in a hairline and lifted by a quiet stone step (a
1 px hairline-tone offset and a soft, low-opacity shadow), a hint of stacked stone and no heavier; a table's header row
is a carved lintel in small capitals on pale stone. The motif stays in the chrome, never on a number: a copy's bar is a
plain line — a thin rounded track and a solid fill to its share, its % at the end as the CLI prints it, a quiet shimmer
while it waits (still under `prefers-reduced-motion`); a state's marker is a small stone block, a page's title stands on a course of bricks, the
Getting-started steps are courses of a wall, an empty state is one quiet line of muted text (`empty`: no box, no
icon, one short sentence, the same on every page), and the mark is an
arch of bricks with its keystone, drawn inline. All of it is borders and boxes: no gradient, no image. A left sidebar
as Vercel's and Supabase's are (Mason, the database's name, a **demo** badge when it is the demo database; the nav,
each link an icon and its label, the one shown a pale stone row with the patina at its edge; at its foot how long ago Mason last
answered — `Updated 3 s ago`, which keeps counting when it stops answering — and the version), the time range as a
segmented control at the top of the Observability views, and on the Overview the run's word beside a big brick, a
grid of KPI cards, then dense tables. While the page's poll fails (Mason stopped, the tunnel closed), what it read
before stays on the page but never reads as current: the shown page's parts are greyed, the Overview's word is grey
with "As of 14:02 UTC. Mason can't be reached." beside it (or "The latest read failed." for a refusal), every other page
says the same line over the banner's Failure, and with nothing read yet the Overview says "Unknown" and why. The
first poll that answers makes it current again (`app.stale()`, src/web/app.js; issue 886). Colour says a state and nothing else — a green, amber, red or gray marker always
beside its word (the failed red a rose, never the accent) — besides the patina accent for focus, links, the current
nav row, a laid brick of the motifs, the primary action and a chart's mark. A copy's bar fills in patina while it copies,
green once served, rose when it failed and amber when not kept current (`--bar-ok/-warn/-bad` on `--bar-track`): tints validated together, in both themes, by the
dataviz skill's `validate_palette.js --pairs all` (each mid-lightness, chroma ≥ 0.10, worst colour-blind ΔE 7.0 light
and 8.5 dark, worst normal-vision ΔE ≥ 17), never colour alone (the copy's word is beside the bar). It follows the system's light or dark theme, and every text colour meets WCAG AA, 4.5:1, on every surface it sits
on in both (the lowest pair 4.63:1 light, 4.64:1 dark; the body text 13.9:1 and 13.1:1).

**The palette, and two alternates.** The accent is a patina because it is a mason's colour that is not brick: the
verdigris on copper and old stone, cool and calm beside the warm stone white, and far in hue from every state (green,
amber, rose). Two alternates are ready as token swaps (both checked for AA; replace these lines in `src/web/app.css`):

| | patina (shipped) | clay rose | bluestone |
|---|---|---|---|
| light `--accent`, `--cta`, `--chart-mark` | `#2b6f70` | `#8d4f4a` | `#41668d` |
| light `--cta-hover` · `--accent-soft` · `--cta-line` | `#235d5e` · `#e2eeed` · `#255f60` | `#79403c` · `#fbeae8` · `#79403c` | `#335578` · `#e7f0f8` · `#335578` |
| light `--brick` (a laid brick) | `#199eaa` | `#199eaa` (kept: a clay brick fails the colour-blind check beside the served green) | `#528ac3` |
| dark `--accent`, `--cta-hover`, `--chart-mark` | `#6cbcb8` | `#e09e97` | `#90b5dc` |
| dark `--cta` · `--accent-soft` · `--cta-fg` | `#5aaba7` · `#1b3434` · `#0d1919` | `#d18882` · `#34211f` · `#1d0e0d` | `#78a3cf` · `#1b2835` · `#0c1520` |
| dark `--brick` | `#1ea2a8` | `#1ea2a8` (kept) | `#528ac3` |

Bluestone's bricks pass the same validator in both themes; clay rose keeps the patina's bricks.

Every colour, space, radius, font and size is a CSS custom property on `:root` in `src/web/app.css` (`--bg`,
`--surface`, `--line`, `--fg`, `--muted`, `--accent`, `--brick`, `--ok`, `--warn`, `--bad`, `--unknown`, `--stone-1/2`,
`--drop`, `--chart-*`, `--font-sans`, `--font-mono`, `--font-display`, `--space-1…7`, `--radius*`, `--text-*`), set again for dark mode, so a page is restyled
by its tokens. The components are helpers of `src/web/shared.js` (`status`, `card`, `cards`, `badge`, `button`,
`panel`, `empty`, `skeleton`, `details`, `sortTh`, `moreRows`, `pop`); the charts, `src/web/charts.js`, each as wide as
its card's content (re-measured whenever that width changes) under its title, inside the card.

**Buttons say what they do**: every button has a visible label (no icon alone); a primary action is filled brick, a
destructive one red-lettered and its confirm filled red; each has hover, focus and disabled states and is at least 28 px
tall; a row's actions sit at its right. **Large data stays bounded**: a list of hundreds writes 100 rows and offers
more, a by-client list shows its top 10 and one row for the rest, a long name is cut with its whole the tooltip, a
statement is two lines at most outside its expanded row and 16 KiB in it. **Charts read at every range**: time ticks in
minutes, hours or days by the span, at least 72 px apart; y labels compact in the commands' units, ticks on whole
numbers (powers of 1024 for bytes); the axis starts at zero and is never cut, so a spike keeps its height and the table
under the chart has every value.

**The vendored files, and why.** People run Mason on machines without internet, so the page fetches nothing from
elsewhere — the policy it is served under (`default-src 'self'`) would refuse it anyway. What it uses that Mason did not
write is copied whole into `src/web/vendor/`, pinned to an exact version, with its licence, and served by Mason itself:
the Geist variable fonts (`geist` 1.7.2, SIL Open Font License 1.1; two woff2 files, 138 KiB), the display face
Zilla Slab (`@fontsource/zilla-slab` 5.3.0, SIL Open Font License 1.1; its bold, Latin only, one woff2 file, 26 KiB), Lucide's
nav icons and uPlot (`uplot` 1.6.32, MIT; its ES module and stylesheet, 144 KiB) for the sparklines and small
time-series charts — about 313 KiB in all. `src/web/vendor/README.md` lists them and how one is updated. A chart only adds to the page: every number it draws
is also written as text, and where uPlot does not load the page reads the same.

## How it is opened, and guarded

The page is served by the run's command server, on 127.0.0.1 only. `mason ui` prints its URL with the run's token;
the first visit trades the token for a cookie (HttpOnly, SameSite=Strict, named for the run's port: two projects
running on one machine each keep their own page signed in) and drops it from the address bar, so the page itself
never holds it. Every request is checked for the server's own Host, every change for the page's own
Origin. Each `mason start` makes a new token: after a restart the page says so, and `mason ui` opens it again.
`mason start` prints `Web UI  mason ui` and `mason status` the page's URL without the token; the token is written
nowhere else.

The page names nothing root-absolute: its files, every answer it asks for and every module it imports are relative
to its own address, and the first visit's redirect is too (`./`). So it works unchanged at `/` and under any prefix a
reverse proxy serves it at, with no setting, as long as that address ends in `/` (`https://example.com/tools/mason/`)
and the proxy sends the run's own Host, and its Origin on a change, which the guard checks (`tests/web-page.test.ts`
refuses a root-absolute path).

## On a server

`mason serve` serves the same page, on the server's loopback and nowhere else: nothing about it is public, and no
firewall rule is added for it. From your own machine:

```bash
mason ui --ssh deploy@mason.example.com
mason ui --ssh deploy@mason.example.com --mason "docker exec -i mason-mason-1 mason"   # in a container
mason ui --ssh deploy@mason.example.com --mason "cd /var/lib/mason && mason"           # a folder, or another path
```

It runs your own `ssh`, so your `~/.ssh/config`, keys and SSO apply, and it needs no project on your machine. It opens a
free local port, starts `mason ui --bridge` on the server, opens your browser at `http://127.0.0.1:<port>/`, and stays
in the foreground: **Ctrl-C closes the tunnel**. A dropped connection is reported, exit 1. `--no-open` prints the URL,
and `--json` prints `{ url, port, server, project, version, next }` once and holds the tunnel, the end on stderr.

**How it is built.** The tunnel is ssh's stdin and stdout, not `ssh -L`. A process beside the run reaches the page where it
listens, and every browser connection crosses that one ssh connection as frames (`src/cli/ui-ssh.ts`). So:

- **A container is the same route as a host.** Docker publishes a port to the container's own network address, never
  its loopback, so `-L` would need the page to listen off loopback. It never does: the run has one way to listen
  (`listenOnLoopback`), which takes no address, no setting names one, and `MASON_UI_HOST` set refuses the start. So
  **publish nothing for the page**: `deploy/mason-data/compose.yml` needs no change.
- **The server need not allow TCP forwarding**, and nobody needs to know the page's port. `MASON_UI_PORT` (default
  4039, the next free one when it is held) names it where another service wants that port; a port named is that port,
  or the start is refused.
- **A process on the same machine can have a socket instead.** `MASON_UI_SOCKET=/mason/data/.mason/ui.sock` makes
  `mason serve` serve the page on that Unix socket as well, for a supervisor or a local reverse proxy that should reach
  it without a port published or a `docker exec` per request. The socket is mode 0600, in a folder only Mason's user can
  write (else the start is refused, with the way out); a stale socket a crashed run left is replaced, anything else at
  the path (a file, a link, another user's socket, one a process answers on) is refused and left as it is; it is removed
  on exit. A request on it is judged by the same guard as one through `mason ui --bridge`: it reaches the page with the
  run's token, or as a tunnel opened with that token (its ticket, then its cookie), never for arriving on the socket.
- **A supervisor finds the run's port and token in a file: `MASON_UI_RUN_FILE`.** With
  `MASON_UI_RUN_FILE=/mason/data/.mason/run.json`, `mason serve` writes `{ "port": …, "token": … }` there once it
  answers (before `/healthz` says ready), and nothing else: the page's port and the run's token, which a process on the
  same machine sends as `Authorization: Bearer` to open a tunnel (`POST /api/ui/tunnel`), without reading
  `.mason/config.json`. The token grants what the token grants: the commands' writes (`mason add`, `mason sync`,
  `mason user`) as well as a tunnel. So the file is held to the socket's bar (`src/cli/ui-run-file.ts`): mode 0600 from
  the moment it exists, in a folder only Mason's user can write, never through a link, written whole (a reader finds no
  file or all of it), never over anything but a stale run file of Mason's own (a link, another user's file, a file of
  other content or mode, a run that still answers: refused and left as it is), and removed on exit. `mason start`
  refuses it.
- **`/healthz` says how the page is served, from the start:** `"page": { "socket": "/mason/data/.mason/ui.sock" | null,
  "readOnly": true | false }`, while it is `starting` too, so a supervisor tells a Mason that serves no socket (`null`;
  an older Mason has no `page`) from one still starting. `mason status --json` says `pageSocket` (the path or `null`)
  beside `pageReadOnly`. Neither ever carries the token.
- **`HEAD` answers as `GET` does**, on every route of the page and the API, without the body: routed as the GET, by rule
  (`src/cli/run-server.ts`).
- **A page that only shows: `MASON_UI_READ_ONLY=1`.** For a page shown to someone who should only look (behind a
  reverse proxy, on the socket), `mason serve` with it set makes the page offer no control that changes anything — no
  Add, Remove, Sync, Disable, Enable, Cancel, Add a user or Share, each page saying
  why — and its server refuses every request
  of the page that is not a GET or a HEAD, whatever its path, with "the web page is read-only here" in the failure shape
  (`src/cli/ui-read-only.ts`). Viewing is unchanged. It covers the page alone: a request with the run's token is the
  `mason` commands' (`mason add`, `mason sync`, `mason cancel` beside the server, and the tunnel `mason ui --ssh`
  opens), served as before; `MASON_PROJECT_READONLY=1` is what refuses the commands' edits of the project's files.
  Anything but `0` or `1` refuses the start; `mason start` refuses it.
- **A read-only page that still edits its tables: `MASON_UI_READ_ONLY_ALLOW=tables`.** For a page embedded in a site
  that does the rest itself (its users, say), `MASON_UI_READ_ONLY=1` beside it keeps the Tables page's Add, Columns…,
  Name its key…, Remove and Sync now, and the Overview's Add a table. The server lets through exactly those routes
  (`POST /api/pick`, `POST /api/remove`, `POST /api/sync`) and refuses every other change of the page as before — a
  user added, disabled, enabled or removed, a statement cancelled, a share, a route added later — with "the web page is
  read-only here" and a `why` that says what is still allowed; the pages for those still say why they offer nothing,
  and `/api/state` says `pageReadOnlyAllow: ["tables"]`. `MASON_PROJECT_READONLY=1` still wins: a project deployed as
  committed offers no Add or Remove and refuses them `409`, as without the allowance (Sync now stays).
- **A read-only page that still manages its users: `MASON_UI_READ_ONLY_ALLOW=users`.** For a site that proxies the page
  and lets its users' changes through its own checks, `MASON_UI_READ_ONLY=1` beside it keeps the Users page's Add a
  user (with its Connects from), its "from …" line, **Disable**, **Enable** and **Remove**, and the Overview's Getting started Add a user. The
  server lets through exactly these routes, each `<name>` exactly one path segment (a user's name, encoded), never a
  prefix:
  - `POST /api/users` (Add a user);
  - `POST /api/users/<name>/disable`, `POST /api/users/<name>/enable`;
  - `POST /api/users/<name>/from` (a user's "from …" line);
  - `DELETE /api/users/<name>` (Remove).

  Every other change of the page is refused as before — a table added, removed or synced, a statement cancelled, a
  share, a route added later — and `/api/state` says `pageReadOnlyAllow: ["users"]`.
- **Both: `MASON_UI_READ_ONLY_ALLOW=tables,users`** (in either order) lets through both lists, and `/api/state` says
  `["tables", "users"]`. The value is a comma list read strictly: `tables`, `users`, or both; set empty, it counts as
  unset. An item that is not one of them (with a `did you mean`, the item named by its place and never quoted), an
  empty item, an area named twice, or the setting beside no `MASON_UI_READ_ONLY=1` refuses the start: an allowance on a
  page that is not read-only says a read-only page was meant and not had. `mason start` refuses it.
- **A link back to the site that links to the page: `MASON_UI_BACK_URL` and `MASON_UI_BACK_LABEL`.** For a page opened
  from another application (a portal, a hosted service's console), `mason serve` with `MASON_UI_BACK_URL` set shows
  "← Back" (or "← " and `MASON_UI_BACK_LABEL`) at the top of the sidebar, above the project, on every page, in the same
  tab; on the icon rail and the phone's bar the arrow alone, the label its name and tooltip. The URL is a path on the
  page's host (`/something`) or an `https://` or `http://` URL with no user or password, printable ASCII, at most 2048
  characters; any other scheme (`javascript:`, `data:`), a `//host`, a backslash, or a path whose dot segments lead to
  `//`, refuses the start, as do a label with a control or format character, of white space alone, past 64
  characters, or set without the URL (`src/cli/ui-back-link.ts`). **A path is read from the host's root, never from the
  path the page is served under**: behind a reverse proxy that serves the page at `https://example.com/mason/`,
  `MASON_UI_BACK_URL=/app` goes to `https://example.com/app`; name the prefix in the path when the link should stay under it. The
  page is given the URL as the URL parser serialises it (`/api/state` `pageBack: { url, label }`, `mason status --json`
  too) and sets it as the link's `href` attribute and the label as its text, never as HTML; the link carries
  `rel="noreferrer"` beside the page's `Referrer-Policy: no-referrer`, so the page's address never reaches the other
  site. It works with `MASON_UI_READ_ONLY=1`; unset, nothing changes. `mason start` refuses both.
- **A sidebar item that links to the host's own page: `MASON_UI_NAV_<ITEM>_URL`.** For a page embedded in a site that
  has its own page for part of what the sidebar shows (its users, say, managed with what Mason does not know), one
  setting per item: `MASON_UI_NAV_OVERVIEW_URL`, `MASON_UI_NAV_TABLES_URL`, `MASON_UI_NAV_USERS_URL`,
  `MASON_UI_NAV_QUERIES_URL`, `MASON_UI_NAV_USAGE_URL`, `MASON_UI_NAV_SYNC_EVENTS_URL`. The item keeps its label and
  icon and links to that URL in the same tab, sending no referrer, on the full sidebar, the icon rail and the phone's
  menu. Every link of Mason's own into that view goes there too — the Overview's Getting started
  step, a card, a client's Queries, a table's sync events, a page's lead — and so does opening the view's address
  (`#users`, `#users?…`, an old one such as `#queries`): the page replaces it with the URL, so Back does not land on it
  again. With the Overview replaced, the page opened with no address shows its first item not replaced. The URL is read
  exactly as `MASON_UI_BACK_URL`'s (`src/cli/ui-back-link.ts`, the one reading): a path from the host's root or an
  `https://` / `http://` URL, printable ASCII, no user or password, at most 2048 characters; anything else refuses the
  start. **A URL whose `#fragment` names a view that is replaced refuses the start too** (`/#tables` beside
  `MASON_UI_NAV_TABLES_URL`, `/?a#queries`, `https://example.com/#status` beside `MASON_UI_NAV_OVERVIEW_URL`, or
  `/#users` as `MASON_UI_NAV_USERS_URL` itself): where the URL is the page itself (a proxy serving it at that path), the
  page would leave one replaced view for another for ever. The fragment is read as the page's router reads the address
  (`src/web/routes.js`, the one list of its hashes, aliases included); a fragment naming a view that is not replaced
  (`/#tables` with Tables kept), or none, is taken. **It is a link, not a refusal**: the run still answers that view's endpoints (`/api/users`), and what a page
  may change is still `MASON_UI_READ_ONLY` and `MASON_UI_READ_ONLY_ALLOW`'s to say — set them beside it when the host's
  page is the only place a change should be made. A `MASON_UI_NAV_*` name that is none of these (`MASON_UI_NAV_USER_URL`)
  refuses the start, with a `did you mean`. `/api/state` and `mason status --json` say `pageNav: { items, links }`
  (`items` by `overview`, `tables`, `users`, `queries`, `usage`, `syncEvents`, each the URL), or `null`.
- **The host's own links in the sidebar: `MASON_UI_NAV_LINKS`.** A JSON list of at most 5 `{ "label", "url" }`, shown
  as a group of their own at the end of the sidebar's nav, each with a link icon, in the same tab, sending no referrer:
  `MASON_UI_NAV_LINKS='[{"label":"Billing","url":"/billing"}]'`. Each URL is read as the link back's, each label as
  `MASON_UI_BACK_LABEL` is (one line of plain text, at most 64 characters, never white space alone) and rendered as
  text, never as HTML. Text that is not JSON, not a list, more than 5 links, an entry that is not an object, has a key
  other than `label` and `url` (named by its place, never quoted) or a key written twice (JSON would keep the last
  silently), or a label or URL that is wrong refuses the start, every problem on one line, naming the entry. `mason start` refuses both settings, as the other `MASON_UI_*` server settings.
  An entry may name a **host view** instead of a link (`{ "label", "view" }`, below): exactly one of `url` and `view`,
  both refused; it counts within the 5.
- **The host's views and card: `MASON_UI_NAV_LINKS`' `view`, `MASON_UI_OVERVIEW_CARD`.** See "Host views" below.
- **In the image, Mason's user is uid 1000, gid 1000 (`node`), and stays so**: an image that changes it names it under
  "Before you upgrade" in its release notes (deploy/mason-data/README.md). A supervisor that creates the folder of the
  socket or the run file makes it owned by `1000:1000`, mode 0700, where the container mounts it (the one folder rule of
  both: owned by Mason's uid, no group or other write, never a link), and checks that the socket or the file is owned by
  uid 1000 before it connects or reads. The run file is 0600 and uid 1000's, so a supervisor reads it as uid 1000 or as
  root, never as another user.
- **Another page's cookie crosses too.** A browser keeps cookies by host, not port, so a local `mason start`'s cookie for
  127.0.0.1 is sent through the tunnel in the Cookie header. Each cookie is named for its port, and the server reads
  only the one for the Host it was asked by, so that one is ignored, though it does reach the server.
- **The bridge ends with your ssh, even when it is stuck.** It ends when its stdin does, and reads stdin on a thread
  of its own (`src/cli/bridge-stdin.ts`): a bridge still running 5 s after its stdin closed, stuck in a call that never
  returned, says so on stderr and is ended (SIGKILL), closing the run's tunnel with it. That thread hands on at most 1
  MiB it has not been told was taken; a bridge stuck 5 s with that much waiting has what follows dropped, so its end is
  still heard, and the tunnel is broken. A bridge that is not stuck but waits for the run's page to take what was sent
  hears the end once the page takes it, or ends with the tunnel when the run ends it.
- **Your access is your SSH access**, then the guard below. There is no new password or login, and ssh carries the
  encryption, so the page needs no TLS of its own.

**The run's token stays on the server.** The bridge reads it as any command there does, opens the tunnel with it, and
sends your machine a ticket: one use, good for 5 minutes, and all the URL carries, because the URL a browser is opened
at is on a command line. The first visit trades it for a cookie holding the tunnel's own session, named for your local
port, and the address loses it. When the tunnel closes, the session is gone, and so is what the guard allowed.

**The guard takes no Host it was not told of.** A tunnel adds `127.0.0.1:<your port>` and `localhost:<your port>`, for as
long as its connection lasts; a DNS-rebinding page still names itself, and is refused by that name. Every change is
checked against that same Origin. The tunnel carries raw TCP to the run's command server, and the guard is what protects
that server: a client chooses its path by the Host it sends, so `Authorization` is refused under a tunnel's Host, and
under the server's own Host it needs the run's token, which never reaches your machine.

**What the page does on a server.** Everything it does under `mason start`, with these differences:

- **Add, Columns…, Name its key… and Remove are absent when the sources file may not or cannot be written** (the
  project deployed as committed, `MASON_PROJECT_READONLY=1`, whose edits `/api/pick` and `/api/remove` refuse; or a
  project folder mounted read-only: `/api/state` `sourcesReadOnly` says why, and the page says it too). Sync now, cancelling a
  statement and the users work as they do on your machine.
- **A closed tunnel says `mason ui --ssh`**, never `mason start`.
- **Connect says what its URL's host is**: the Postgres API's address as the server sees it, often `localhost`, which a
  tool elsewhere replaces with the server's own address. With `MASON_PG_PUBLIC_URL` set (the address a client reaches,
  behind a load balancer or a DNS name: docs/POSTGRES-API.md "The address clients reach"), Connect, the Users page's
  Connect and a user's card print that address, its port and its `sslmode`, and say nothing of the host
  (`/api/state` `postgres.public`).

`mason ui` on the server itself is refused, naming `--ssh`: nobody sits at a browser there. `mason status` says the same line.

**When it does not connect**, it says so in one report with the way out: `ssh` missing here, the server unreachable (a
firewall rule that names your old IP address is the common cause), `mason` not a command there (`--mason`), a server
older than `--ssh`, no project where ssh lands, Mason not running, or two ends whose bridges differ. Two more show as
`ssh could not reach`, with ssh's own words, and neither is Mason's to change: a `RemoteCommand` in your `~/.ssh/config`
for that Host (ssh refuses it beside a command: give the tunnel a Host without one), and a host-key failure (`Host key
verification failed`: run `ssh <user@server>` once on its own, and check the key before you accept it).

**What has been run.** Real OpenSSH to a real sshd, both on one machine: a key, a login banner and a shell profile that
prints on stdout and stderr, with `AllowTcpForwarding no`, a browser through it, and Mason in a container reached with
`docker exec -i`, its page on that container's loopback. Killing ssh ended the bridge on the server.

**Unverified:** it has not been run across a real network or to a cloud server, and not with a passphrase or a hardware
key, where ssh prompts. Routes that are `ssh` to your `~/.ssh/config` should work without Mason knowing, and **none has
been tried**: SSM Session Manager on EC2, IAP on Compute Engine, Azure Bastion. Port 22 need not be open on those, if
that holds.

Kubernetes has no SSH, and Fargate, Cloud Run, Azure Container Apps, Fly and Railway have tooling of their own: none is
covered.

## Host views

A site that embeds the page (a hosted console behind its proxy) often has facts of its own about the server: its
status, the versions it offers, how to connect from outside. It supplies them as **data**, and the page renders them
**in its own look, inside the page**: the sidebar stays, only the content changes, and switching is as fast as between
the Overview and Tables. Unset, nothing on the page changes.

- **A view in the sidebar**: an entry of `MASON_UI_NAV_LINKS` with `view` in place of `url`,
  `MASON_UI_NAV_LINKS='[{"label":"Server","view":"host/status.json"}]'`. Its link is among the host's links, with a
  panel icon, and shows the view at the page's own address `#host/<n>` (`n` the entry's place in the list, from 1), so
  Back, Forward and a bookmark work and the sidebar marks it as the current page. A `#host/<n>` that names no view (an
  older bookmark, or a page with no host's sidebar) lands on the Overview, as an unknown address always has.
- **A card on the Overview**: `MASON_UI_OVERVIEW_CARD=host/card.json`, the same JSON, shown as one more card after
  Mason's own (its title the card's label, its facts as rows, its links under them).

**The path is relative to the page's own address**, and the page reads it with a GET from its own origin, so the CSP's
`default-src 'self'` holds and whatever serves the page answers it: a proxy serving the page at
`https://example.com/mason/` is asked `https://example.com/mason/host/status.json`. On a bare `mason ui` the run's own
server is asked, and answers 404, which the view shows as its failure. The path is read at the start
(`src/cli/ui-host-view.ts` `viewPath`), and refused, naming the setting or the entry and never quoting the value, when
it has a scheme (`https:`, `javascript:`), starts with `//` or `/`, has a `..` segment (written or `%2e`-encoded), a
backslash, a `#fragment`, a character outside printable ASCII, or is past 2048 characters. `mason start` refuses
`MASON_UI_OVERVIEW_CARD`, as the other server settings; `/api/state` and `mason status --json` say `pageNav.links`
(`{ label, view }` among them) and `pageCard` (the path, or null).

**When it is read**: when the view (or the Overview) is shown, and again every `refresh` seconds while it is shown and
the tab is visible, held within 5 s and 1 h; without `refresh`, once each time it is shown. Nothing is cached beyond
that: a view shown again is read again. A read is never awaited by the page's own polling, one is in flight per path at
a time, and one not answered whole within 10 s (headers that never come, a body that drips) is aborted and shown as
the view's failure: a host that hangs holds up neither the run's reads nor another page's.

**The shape** (declared here and held in the page, `src/web/host-view.js` `hostView`):

```json
{
  "title": "Server",
  "refresh": 30,
  "sections": [
    {
      "heading": "Status",
      "facts": [
        { "label": "State", "value": "running", "status": "ok" },
        { "label": "Version", "value": "0.15.0" },
        { "label": "Host", "value": "db.example.com", "copy": true }
      ],
      "text": "Upgrades run in the maintenance window.",
      "links": [
        { "label": "Upgrade available", "url": "/console/upgrade", "primary": true },
        { "label": "Connect from outside", "url": "https://docs.example.com/connect" }
      ]
    }
  ]
}
```

- `title` (one line, at most 200 characters): the view's heading, or the card's label. `sections`: at most 20, each a
  `heading` (one line), and optionally `facts` (at most 50), `text` (at most 8,000 characters, line breaks kept) and
  `links` (at most 20). `refresh`: seconds, optional.
- A fact is `{ label, value }` (one line each; a value at most 2,000 characters), with `copy: true` for a Copy button
  beside it and `status` `ok`, `warn` or `bad` for the page's own marker beside its word (never colour alone).
- A link is `{ label, url }`, with `primary: true` for the page's primary action. Its URL follows `MASON_UI_BACK_URL`'s
  rules (a path from the host's root, or an `https://` / `http://` URL with no user or password), read in the page by
  `hostLinkUrl`, which `tests/web-page.test.ts` holds to accept nothing the server's `linkUrl` refuses, and to write
  what both take the same: the data arrives when the view is shown, never at the start, so the page reads it itself.
  Its host is held to an explicit pattern too (DNS labels or an IPv6 literal, an optional port; never a `%` or a
  space), before and after the URL parser reads it, since a browser's parser takes hosts Node's refuses. A link that fails them is **left out and
  said** ("1 link left out"), never written. It opens in the same tab, sending no referrer.
- **Every string is shown as text, never as HTML**: a `<script>` in a label reads as `<script>`. There are no forms and
  no buttons that change anything (a change is the site's own page's job, behind its own sign-in); Copy is the one
  button a view writes.
- **An answer the page cannot read is the view's own failure**, in the page's Failure shape, never a blank page: nothing
  answered, not answered whole within 10 s, an answer that is not 2xx, more than 256 KiB, not JSON, or outside the shape (a key the shape does not
  take, a string too long or holding a control character, a list too long, a `status` other than the three). The last
  view read stays under the failure. The card says its failure inside the card.

These facts are the host's, not Mason's: `mason status` does not say them, and the page shows them as the host wrote
them.

## An operator's table edits

An *operator* is a process on the same machine as `mason serve` (a supervisor, or a service that hosts Mason and lets a
project's owner pick tables in its own app). It lists the database's tables and adds or removes them by asking the run,
the way `mason add` and `mason remove` do while Mason is up. So the edit goes through the same catalog checks, the
same sources-file grammar and the same refusals. Never write the sources file by hand beside a run, and never through
the page. Within a release line, these routes keep the shapes below. `tests/cli-operator-tables.test.ts` pins every
status, key and refusal listed here, so changing one is a deliberate contract change, said in the release notes.

**How it reaches the run.** Over `MASON_UI_SOCKET` (or the loopback port), with the port and the token from the file
`MASON_UI_RUN_FILE` names (`{ "port", "token" }`). Every request carries:

- `Host: 127.0.0.1:<port>` (or `localhost:<port>`), with the run file's port, on the socket as well;
- `Authorization: Bearer <token>`, the run's token: it grants the commands' writes, so treat it as `.mason/config.json`
  is treated;
- on a POST, a JSON body of at most 64 KiB. It is read as JSON whatever its `Content-Type`, and no `Origin` is
  needed.

The guard answers before any route, in plain text, not JSON:

- `421` for another Host (`this server answers only as 127.0.0.1:<port> …`);
- `403` for another token (`the Authorization header does not carry this run's token`);
- `403` for no token and no cookie (`this is mason start's command server for the mason command: a request carries the
  run's token (Authorization: Bearer, from .mason/config.json)`).

**`MASON_UI_READ_ONLY=1` refuses the page, not the operator.** A request with no `Authorization` (the page's, by its
cookie) that is not a GET or a HEAD is refused `403` with "the web page is read-only here". A request with the run's
token is served, read-only or not. With `MASON_UI_READ_ONLY_ALLOW=tables`, the page's `POST /api/pick`, `/api/remove` and
`/api/sync` are served too; with `users`, its `POST /api/users`, `POST /api/users/<name>/disable`, `/enable` and `/from`
and `DELETE /api/users/<name>`; and every other change of the page refused. `MASON_PROJECT_READONLY=1` refuses the operator's
edits too (below).

**Every refusal** is `{ "error": <message>, "failure": { "code", "message", "why"?, "fix"?, "next": [{ "command",
"what"? }] } }`, the CLI's failure shape, worded by the code `mason add` and `mason remove` call. `why` and `fix` are
there when the refusal has them. Beside the read-only page's `403`, the status follows the code: `400` `usage`,
`404` `not_found`, `409` `refused`, `500` `failed`. A `500` is the run's own failure (a sources file it cannot read
or write, say), with `mason logs` as its next step, and is said once in the run's log. A body that is not JSON is
`400` (`the body is not JSON: …`).

### The table list: `GET /api/state`

The run's state, lean: no table's columns. `?columns=1` adds them, which is most of its bytes. The parts an operator
reads:

- `tables`: every table of the database the source's user can read, added or not. Each has `table` (`schema.table`),
  `rows` (the catalog's estimate, or null), `bytes`, `key` (its primary key's columns, `[]` for none), `comment`,
  `added`, `reason` (why `mason add` without a key cannot add it: no primary key, with the `--key` to name; null for a
  table that can be added and for one added), `addedColumns` and `copyKey` (what its entry syncs, and the key it names;
  null when not added), `columnCount` (how many columns the table has), an added table's `entry` (its entry as the
  sources file says it: `{ columns, exclude, key }`, `columns` null for every column but `exclude`, `key` null for its
  primary key) and `everyColumnLeavesOut` (the columns `mason add <table>` with no `--columns` leaves out: they look
  like secrets), `copy` (its first sync, below, or null) and `error`. An added
  table also has `sync`: `state` (`waiting`, `syncing`, `synced`, `behind`, `failed`), `syncedAt`, `syncSeconds`,
  `syncedBy`, `ageSeconds`, `asOf`, `promisedSeconds`, `behindBySeconds`, `behindWhy`, and `syncRefusal`: why `mason
  sync <table>` (Sync now) is refused now, in the words it refuses with (its first sync not finished or failed, being
  read again whole, being caught up), or null when it would run. Once the sync holds it there are
  also `kept` (how it is kept current now: `by` is `poll`, with its `sync`, or `replication` or `recopy`) and `duck`.
- `copy`, null until the sync reaches the table, is `phase` (`copying`, `done` or `failed`), `rowsCopied` (the rows
  read so far, or the copy's rows once done) and `updatedAt` (when it was copied, `""` before). It also has `progress`
  while its chunks are read (`chunksDone`, `chunksTotal`, `reading`, `readingSeconds`, `rowsReading`, `rowsPerSecond`,
  `bytesPerSecond`, `secondsLeft`, `share`), and `retired` when a done copy is in a layout this Mason no longer keeps
  (it serves as it was until it is synced again).
- `source.sync`: the file's own `sync:` (`default`, and `written`), which every entry follows unless its own says
  otherwise.
- `sourcesReadOnly`: why the page offers no Add or Remove, or null. Either the project is deployed read-only, which
  refuses an edit `409`, or the server cannot write the sources file, which fails an edit `500` `failed`.
- `pageReadOnly`: the page's read-only reason, or null. It does not apply to the operator.
- `pageReadOnlyAllow`: what that page still changes, the areas `MASON_UI_READ_ONLY_ALLOW` names in this order
  (`["tables"]`, `["users"]` or `["tables", "users"]`), else `[]`.
- `pageNav`: the sidebar as the host says it, `{ items, links }` (`MASON_UI_NAV_<ITEM>_URL`, `MASON_UI_NAV_LINKS`; a
  link is `{ label, url }`, a host's view `{ label, view }`), or null. It changes no route the server answers.
- `pageCard`: the path, relative to the page's address, the Overview reads the host's card from
  (`MASON_UI_OVERVIEW_CARD`), or null.

**One table's columns: `GET /api/tables/<table>/columns`**, with `<table>` URL-encoded (`public.orders`). The answer
has `table` and `columns`, each column with `name`, `type`, `nullable`, `comment` and `references` (`{ table, column }`
for a foreign key, else null). A table the catalog lacks is `404` `not_found`. A name that is not properly URL-encoded is
`400` `usage`.

**One table's Sync choice: `GET /api/tables/<table>/sync`** (the Tables page's, read when the choice opens; never part of
the polled `/api/state`), with `<table>` URL-encoded. The answer has `table`; `sync`, its sync now as the sources file
says it (`{ value, from }`, `from` `entry`, `file` or `default`), or null for a table not added; `rows`; `bigRows` (over
1,000,000 rows: the page asks before saving a poll); `polls`, the polls offered (`{ sync, seconds, cost }`: `poll 5m`,
`poll 15m`, `poll 1h`, `poll 1d`, `cost` the estimate for a big table, else null: `{ rows, scanSeconds, everySeconds,
busyPercent, basis: measured | first-sync | assumed, rowsPerSecond }`); and `live`: `allowed` (no check
refused) and `checks`, each `{ name, state, detail, sql? }` with `state` `ok`, `warn` or `refused` — the table's own
(`primary key`, `replica identity`), then the database's (`wal_level`, `standby`, `replication role`, `slot`, `wal
senders`, `WAL cap`, `publication`), read now over one connection that reads settings, the catalog and the statistics
views, never a row, each statement bounded (`SET LOCAL statement_timeout` 10 s, in one read-only transaction: never a session SET, which a pooler would hand on), and is closed. One read at a time for the whole run;
at a save, a named publication is held to the columns of the entry the save will write. A database that cannot be reached, or whose
checks cannot be read, is one refused check, `database`, never Live allowed; the answer never carries the database's
address. A table the catalog lacks is `404` `not_found`.

### Add a table: `POST /api/pick`

`{ "table": "public.orders", "picked": true, "columns"?: [...], "key"?: [...], "sync"?: "poll 5m", "keep"?: true }`:

- `columns`: the columns to sync (the key is always added), or `["*"]` for every one (the default);
- `key`: for a table with no primary key, the NOT NULL columns of a unique index;
- `sync`: `off`, `poll <interval>` or `replication`, in the sources file's grammar;
- `keep: true` changes only the `sync:` of a table already added; its columns and its `key` stay as they are.

`"picked": false` removes the table, as `POST /api/remove` does with a single name.

The answer is `200` with `table`, `file` (the sources file, absolute), `entry` (its key in the file), `columns`, `exclude`,
`key`, `addedKey` (key columns added to `columns`), `skippedSecrets` (columns that look secret, which every-column
left out), `already` (the file said so already, and nothing was written), `sync` (`{ value, from }`, where `from` is
`entry`, `file` or `default`), `bigOff` (a big table under a polling default, written `sync: off`), `notReplicated`
(why a table under a replication default is polled, or null), `pollCost` (what a frequent poll of a big table costs the
database, or null), and `state`, the lean state after the edit. The table's first sync starts at once.

| Status | `code` | When |
|---|---|---|
| 400 | `usage` | the body lacks `table` or `picked` (`send { table, picked, columns?, key?, sync?, keep? }`); `sync`, `columns` or `key` malformed; a column the table lacks; a `key` for a table with a primary key; a `key` that does not tell its rows apart; `sync: replication` for a table that cannot be replicated |
| 404 | `not_found` | `<table> is not a table of <database> that this user can read` |
| 409 | `refused` | no primary key and no `key` (`<table> cannot be added: no primary key: …`); the project's files are read-only (`MASON_PROJECT_READONLY=1`, with `why`, `fix`, `next`); another entry of the file fails against the database (`… fix it first`); the file's `url:` now names another database; a switch to replication the database cannot serve, its checks read again at the save (`<table> cannot be kept current by logical replication from <database>: <checks>`, each with its fix in `why`; nothing written) |

### Remove tables: `POST /api/remove`

`{ "tables": ["orders", "billing.invoices"] }`, each as the file names it or as `schema.table`. The answer is `200`
with `removed` (the tables whose entries were cut, as `schema.table`), `file` (the sources file, absolute) and
`state`, the lean state after the edit. The tables' synced data is dropped at once.

| Status | `code` | When |
|---|---|---|
| 400 | `usage` | `tables` is not a non-empty list of strings (`send { tables: [name, …] }`); a name that is not a table's name |
| 404 | `not_found` | a name the file does not have, with the closest one it has |
| 409 | `refused` | the project's files are read-only; an entry that stays fails against the database; the file's `url:` now names another database |

Nothing an operator asks for is answered or logged with the token. The run logs `added <table> to <file>` and
`removed <table> from <file>`.

## Building it out

The page is plain HTML, CSS and JavaScript modules under `src/web/` — a shell (`app.js`), what the pages share
(`shared.js`), the charts (`charts.js`) and one module per page (`pages/<id>.js`, so pages are built independently) —
with no framework or build step, and its dependencies vendored whole ("Presentation"),
and every page of the full UI renders a command's `--json` shape from an endpoint the server already has (the
statements that ran, the slow and refused statements, a sync on demand).
[`.claude/rules/web-ui.md`](../.claude/rules/web-ui.md) has the rules and the table of what each feature reads.
