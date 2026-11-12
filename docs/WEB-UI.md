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
| `#users` | Users |
| `#observability/queries` (`#observability`) | Observability › Queries; `?slow=1`, `?status=` (`completed`, `refused`, `failed`, `refused-or-failed`, `cancelled`), `?user=`, `?client=` set those filters |
| `#observability/usage` | Observability › Usage |
| `#observability/syncs` | Observability › Sync events; `?failures=1` ticks Failures only, `?table=` chooses the table |

The hashes of before still land on their view: `#status` is the Overview, `#queries` and `#usage` their views, `#logs`
and `#observability/logs` Sync events. In each Observability view's header row, right of its title, is **the time range the three share**: a segmented control — **Now** · Last hour · 24 hours · 7 days · 30 days · 90 days, Now unless the hash says (`?range=1h`, `?range=7d`, `?range=90d`); 30 and 90 days only where Mason keeps that much history (`MASON_HISTORY_DAYS`, 7 by default), else shown disabled with that setting as the reason
— kept in the hash, so a link carries it (the sidebar's links to the three keep it too). **Now is live**: the last 15
minutes, read every few seconds, said **Live** beside the control. **Every other range is read once**, when it is
chosen, and stays as it was then: beside it, when it was read and **Refresh**. Queries reads the request log since then,
Usage the range's statements, clients and samples (a minute a point for Now and the hour, an hour for the day, six hours
for the week, a day for 30 and 90 days), Sync events the sync's events since then; each
view's own filters compose with it. Only the view shown asks Mason anything, each read at the rate its data changes,
and nothing while the tab is hidden. How long ago Mason last answered is at the sidebar's foot.

Below 1000 px the sidebar is a rail of icons, each label its icon's tooltip (on hover and on focus) and still the link's
name to a screen reader; below 640 px it is a top bar — a menu button, Mason, the project — whose button opens the nav as
a sheet over the page: the focus goes to its first link, and Escape, a click outside it, the focus leaving it or a link
followed close it. The icons are Lucide's (ISC), vendored whole under `src/web/vendor/lucide-1.56.0/`, drawn inline at
16 px in the text's colour.

- **Overview** (`#overview`, read only): the run's word (Ready, Under way or Failed) beside a big dot, then cards for the
  tables synced, the rows, the last sync, the synced data's file, and the last day's statements with their p95. Each card has a
  24-hour sparkline once there are two hours to draw, and **each is a link** into the view that lists what it counts:
  the tables (the failed ones when a first sync failed), Usage for the synced data's file, Queries for the statements, the slow ones
  for the p95.
- **Overview**, Getting started (while setting up is not done): ✓ Mason is running · ✓/○ a table synced · ✓/○ a user
  created · ✓/○ a first statement answered — each ○ with its one action (Add a table → Tables, Create a user → Users,
  connect with Connect's URL below), from `/api/state`'s totals, `/api/users` (`mason user list --json`) and the request
  log's week (`/api/queries`). Gone once the four are done; not drawn while a read it needs is unanswered or failed.
- **Overview**, Connect: the Postgres API's URL with `<user>:<password>` in the credentials' place — the line `mason
  status` prints — with **Copy** and no psql line (the URL is the same thing, pasted after `psql`), and **Create a
  user** (the Users page). While nothing has asked
  Mason anything (no statement in the last day or week) it is **Connect your first tool**, right under the cards, saying
  what the URL is for; afterwards a quieter panel after the facts. It is `/api/state` `postgres` (`mason status --json`'s
  `postgres`: `shown`; its `psql` is not shown).
- **Overview**, Connect from anywhere (under `mason start` only): `mason share` from the page, for a tool in the cloud.
  It asks once that this opens a temporary public address (`GET /api/share/choices`: a role picker where
  `mason/roles.yml` offers more than one role, as `mason share --role`), then `POST /api/share` `{ from: "page",
  confirmed: true, role? }` opens the same share the command opens (src/cli/page-share.ts): the run makes the password
  and starts the tunnel's client, and the card shows host, port, user and the password, each with **Copy**, how long it
  has been shared, when a free share ends (within about an hour), and **Stop sharing** (`DELETE /api/share/<user>`).
  The password is in that one answer alone, kept in the page's memory: after a reload the card says it was shown once.
  The page holds the share by a beat (`POST /api/share/<user>/beat`, every 15 s, hidden or not): two minutes without
  one (the tab closed, crashed or asleep) and the share, its sessions and the tunnel's client end, said by `/api/state`
  `shareEnded`. One share at a time between the page and `mason share`, refused naming the open one. Under `mason serve`
  (and so through `mason ui --ssh`) it is absent, and every one of those endpoints refuses.
- **Overview**, the tables not synced yet: a bar each with the line `mason wait` prints (a first sync not begun shimmers,
  with no % beside it), and nothing once every table is synced.
- **Overview**, the facts ("Mason"): one table with the database (its name and host, the Postgres version, and whether
  it is your main database or a read replica), the warnings, Mason's version and uptime, its restarts when there were
  any, the free disk beside what the synced data uses, and the tools connected. Under it, quiet lines: that the database
  is on another machine, and how text sorts when that differs from the database. `mason status` keeps its fuller rows
  (the sources file, the sync settings); the page shows each table's sync on Tables. In replication mode, a Changes
  table shows the stream and the WAL its slot holds.
- **Overview**, the statements and errors: the last day and week in one table, then the latest sync errors and the
  refused or failed statements, each with **See all** (Logs, failures only; Queries, the refused or failed ones), and — when a
  statement used SQL Mason does not support in the last day — one line naming the most refused entry of
  `docs/SQL-SUPPORT.md`, with **See all** (Queries).
- **Tables** (`#tables`): the database's tables, as `mason tables` lists them, with a search box by name and an All /
  Added / Failed / Not added filter. With hundreds of tables the first 100 that pass are written, then **Show 100 more**
  and **Show all**; the search is over every table, at once. A long name is cut with an ellipsis, its whole the tooltip.
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
  under it down.
- **Tables**, an added table's **sync**, first on its note (`Sync: Off`, `Sync: Every 5 minutes`, `Sync: Live
  (replication)`, as the run keeps it now: `/api/state` `tables[].kept`): a button that opens its **Sync choice**, a
  dialog beside it that reads `GET /api/tables/<table>/sync` once, as it opens (never on a timer: it opens a connection
  to the database), and saves with `POST /api/pick` `{ table, picked: true, sync, keep: true }`, as `mason add <table>
  --sync …` does, writing the entry's `sync:` line alone:
  - **Off**, the default: synced once, then only by Sync now. Nothing turns on load on the database unless chosen.
  - **Every 5 minutes, 15 minutes, hour or day** (presets only), each saying it scans the whole table on the database at
    that interval. For a table over 1,000,000 rows each says what a poll costs the database (`pollEstimate`, the estimate
    `mason add` prints), and saving one asks first, with that cost.
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
  `mason add <table>` does; **Columns…** opens a form to tick the columns to sync; **Name its key…** does the same for a
  table with no primary key.
- **Users** (`#users`) reads, under its title: Connect, then the add form with what it answered beside it (the card of
  the user added, or its refusal), then the users (issue 887). A person arriving on the page — its address opened, a
  link of the sidebar or another followed — starts with the cursor in the form's **Name**, once the form is written;
  never at a poll's write after that, never taken from what the person focused since they arrived, never on a touch
  screen (`(pointer: coarse)`, where it would open the keyboard over the page), and not on a read-only page, which has
  no form (a page's `arrive()`, src/web/app.js). The add form adds a user by name and, where `mason/roles.yml` names roles and reads as it is, a
  **Role** as `mason user add --role` (the roles from `/api/state` `roles`, `mason status --json`'s): the file's
  `default:` is chosen first, marked (default), and sends no role, so the user follows the default as one added with no
  `--role` does; with no default the first choice is no role. The run judges the role, and its refusal is shown. Then
  **Connects from**, in `mason user add --help`'s words: **From anywhere**, the default, sends no `from` (as `mason user
  add` with no `--from`), with no second question; **Only from these addresses** sends the ranges typed in one box,
  comma-separated as `--from a,b` takes them (`192.0.2.0/24, 2001:db8::/32`), split at each comma and trimmed. The box
  keeps its place whichever is ticked, so a toggle moves nothing (issue 875): under From anywhere its place is a quiet
  dashed slot saying "any address", the box itself hidden from Tab and from a screen reader. Its two choices are a
  radio group as every one on the page is (`.radios`, src/web/app.css: Connects from here and in From…, a table's
  Sync choice): one choice a line, every radio at one left edge with its words beside it; the add form lays the two in
  one row only where its card has the room for the label, both and the box (800 px). The page
  never checks a range: the run reads each, and a refused one is shown as the run's refusal. `--set`
  attributes stay the command's. Its password is shown once, in a card of the user's own fields — URL, User and
  Password, each with **Copy**, laid out the same way (a field `mason user add --json` does not carry is not shown;
  Database, Host, Port and SSL mode are the run's, on the Connect card above it) —
  with no psql line (the URL is the same thing, pasted after `psql`), and a link to Queries, where its statements will
  show; Mason keeps no copy, so it is never shown again.
- **Users**, Connect: once for the run, where a tool connects — host, port, database and SSL mode, each with **Copy**,
  and the URL with `<user>:<password>` in place, with **Copy** — as `mason status` says it, with no psql line (the URL
  is the same thing, pasted after `psql`). No user's row carries a URL:
  the card shown once when a user is added is the only place its password is copied.
- **Users**, the list: each user's role and, on a line under it, where it connects from ("from" its ranges as `mason
  user list` says them, or "from anywhere": `from` in `mason user list --json`; cut by the column, its whole the
  tooltip), its status (Active, Disabled and when, or Removed), when added, when last
  used, and **Queries**, its statements. A user that no longer connects is flagged with why. **Disable** asks first (in a popover, in `mason
  user disable`'s words), then runs it; a disabled user's button says **Enable** in the same width, and runs `mason user
  enable` at once. The "from …" line is a button: it asks where the user connects from in a popover beside the row's
  actions, the add form's choice opened at its ranges now, and sends `POST /api/users/<name>/from` (`mason user from`:
  the ranges, or `null` for from anywhere, `--any`); the list holds still while it asks, and a refusal is said in the
  popover. **Remove** asks first; a removed user stays listed, muted. The table keeps its width (no column of its own),
  fits its card in a 1280 px window, and where it scrolls (a narrower window, a phone) a row's actions stay pinned at
  the card's right.
- **Observability › Queries** (`#observability/queries`): the request log, and only that — who is connected, what runs
  and the range's numbers are on Usage.
- **Queries**, the request log empty and unfiltered: its sentence, then Connect your first tool (as the Overview's).
- **Queries**, the request log: newest first, with a status dot and word per row as `mason logs --requests` says it: Completed,
  Refused (a statement Mason answers as designed, as a Postgres would refuse it: unsupported SQL, a missing relation),
  Failed (Mason's or the machine's fault) or Cancelled. Filter by status (each, or Refused or failed), **Slow (1 s or more)**, a
  piece of the statement's text (**Statement has**), since (`2h`, `7d`, or a date: used instead of the range), user and
  client; **Older** pages back and **Newest** returns, 40 a page. **Started**, **Duration** and **Rows** sort the page
  shown (said under it: the pages follow the log's order by start). A statement is one or two lines in its row; a row
  opens in place to its whole id, times, bytes sent, statement and error — the first 16 KiB of each, said when cut.
  A statement that reads no synced table (`select 1`, `select now()`, SET, SHOW, a BI tool's catalog queries) is
  answered without the synced data and **not listed** — the protocol's chatter, hundreds a connection from a BI tool — and the
  page says so, as `mason logs --requests` does when it lists none; while nothing is listed, Connect offers a first
  statement that is (`select count(*) from <a synced table>;`).
- **Observability › Usage** (`#observability/usage`): every part follows the range. Cards: under Now, the sessions
  connected and the statements running; under any other range, the clients that sent statements in it; then the
  range's statements, failed, p95 and what was sent (bytes, and rows under it), each with a sparkline — the statement
  cards lead to Queries filtered to what they count (all, failed, slow).
- **Usage**, connected: under Now, who is connected now — a row per user and client, the 10 with the most sessions and
  one row for the others; under any other range, who sent statements in it, the most first, with their failed ones,
  sessions and last statement. Each row's **Queries** opens the request log filtered to that user and client.
- **Usage**, running: under Now, each statement running with how long it has run (moving with each poll; when it started is its title) and **Cancel**, which asks first and stops that one statement, as
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
  turns it round), with when, kind, table and reason. A scheduled poll that succeeds is not listed (one every few
  seconds would bury the failures): the last one's result is each table's **Last sync** on Tables. **Failures only**, a **Kind** (every kind of event) and a **Table** (every added table, whether the range has an event of it or not: one with none says so by its name) narrow the list; 100 are
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
Getting-started steps are courses of a wall, an empty state is a footing with nothing on it yet, and the mark is an
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
  Add, Remove, Sync, Disable, Enable, Cancel, Add a user, Create a user or Connect from anywhere, each page saying
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
  user (with its Connects from), its "from …" line, **Disable**, **Enable** and **Remove**, and the Overview's Create a user. The
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
  menu. Every link of Mason's own into that view goes there too — the Overview's Create a user and its Getting started
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
  null when not added), `copy` (its first sync, below, or null) and `error`. An added
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
`poll 15m`, `poll 1h`, `poll 1d`, `cost` the estimate for a big table, else null); and `live`: `allowed` (no check
refused) and `checks`, each `{ name, state, detail, sql? }` with `state` `ok`, `warn` or `refused` — the table's own
(`primary key`, `replica identity`), then the database's (`wal_level`, `standby`, `replication role`, `slot`, `wal
senders`, `WAL cap`, `publication`), read now over one connection that reads settings, the catalog and the statistics
views, never a row, each statement bounded (`statement_timeout` 10 s), and is closed. One read at a time for the whole run;
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
