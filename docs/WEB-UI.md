# The web page (`mason ui`)

`mason start` serves a web page beside the commands, in a browser tab: a left sidebar of pages (Overview, Tables,
Users, and the Observability group's three views: Queries, Usage and Syncs) over the state `mason status`, `mason tables`,
`mason user`, `mason usage` and `mason logs` read.

```bash
mason ui              # opens the page in your browser
mason ui --no-open    # prints its URL only
mason ui --json       # { url, port, next }
```

## What it shows

The page has a sidebar on the left — the project (the database, a **demo** badge when it is the demo database), a nav of
**Overview · Tables · Users** and, under the **Observability** heading, **Queries · Usage · Syncs**, each a link with its
icon, the one shown a filled row; at its foot how long ago Mason last answered and the version — and shows one view at a
time beside it, chosen by
the address's hash, so a view can be bookmarked and Back goes to the one before:

| Hash | View |
|---|---|
| `#overview` (none, or one it does not know) | the Overview |
| `#tables`, `#tables?show=failed` | Tables (filtered to the failed copies) |
| `#users` | Users |
| `#observability/queries` (`#observability`) | Observability › Queries; `?slow=1`, `?status=failed`, `?user=`, `?client=` set those filters |
| `#observability/usage` | Observability › Usage |
| `#observability/syncs` | Observability › Syncs; `?failures=1` ticks Failures only, `?table=` chooses the table |

The hashes of before still land on their view: `#status` is the Overview, `#queries` and `#usage` their views, `#logs`
and `#observability/logs` Syncs. In each Observability view's header row, right of its title, is **the time range the three share**: a segmented control — **Now** · Last hour · 24 hours · 7 days · 30 days · 90 days, Now unless the hash says (`?range=1h`, `?range=7d`, `?range=90d`); 30 and 90 days only where Mason keeps that much history (`MASON_REQUEST_LOG_DAYS`, 7 by default), else shown disabled with that setting as the reason
— kept in the hash, so a link carries it (the sidebar's links to the three keep it too). **Now is live**: the last 15
minutes, read every few seconds, said **Live** beside the control. **Every other range is read once**, when it is
chosen, and stays as it was then: beside it, when it was read and **Refresh**. Queries reads the request log since then,
Usage the range's statements, clients and samples (a minute a point for Now and the hour, an hour for the day, six hours
for the week, a day for 30 and 90 days), Syncs the sync's events since then; each
view's own filters compose with it. Only the view shown asks Mason anything, each read at the rate its data changes,
and nothing while the tab is hidden. How long ago Mason last answered is at the sidebar's foot.

Below 1000 px the sidebar is a rail of icons, each label its icon's tooltip (on hover and on focus) and still the link's
name to a screen reader; below 640 px it is a top bar — a menu button, Mason, the project — whose button opens the nav as
a sheet over the page: the focus goes to its first link, and Escape, a click outside it, the focus leaving it or a link
followed close it. The icons are Lucide's (ISC), vendored whole under `src/web/vendor/lucide-1.56.0/`, drawn inline at
16 px in the text's colour.

- **Overview** (`#overview`, read only): the run's word (Ready, Under way or Failed) beside a big dot, then cards for the
  tables synced, the rows, the last sync, the copy's file, and the last day's statements with their p95. Each card has a
  24-hour sparkline once there are two hours to draw, and **each is a link** into the view that lists what it counts:
  the tables (the failed ones when a copy failed), Usage for the copy's file, Queries for the statements, the slow ones
  for the p95.
- **Overview**, Getting started (while setting up is not done): ✓ Mason is running · ✓/○ a table copied · ✓/○ a user
  created · ✓/○ a first statement answered — each ○ with its one action (Add a table → Tables, Create a user → Users,
  Copy the psql line → Connect's), from `/api/state`'s totals, `/api/users` (`mason user list --json`) and the request
  log's week (`/api/queries`). Gone once the four are done; not drawn while a read it needs is unanswered or failed.
- **Overview**, Connect: the Postgres API's URL with `<user>:<password>` in the credentials' place and its psql line —
  the lines `mason status` prints — each with **Copy**, and **Create a user** (the Users page). While nothing has asked
  Mason anything (no statement in the last day or week) it is **Connect your first tool**, right under the cards, saying
  what the URL is for; afterwards a quieter panel after the facts. It is `/api/state` `postgres` (`mason status --json`'s
  `postgres`: `shown`, `psql`).
- **Overview**, the copies not finished: a bar each with the line `mason wait` prints (a copy not begun shimmers, with
  no % beside it), and nothing once every copy is done.
- **Overview**, the facts: one table with the database and how its changes arrive, the warnings, Mason's version, uptime
  and restarts, free disk, and sessions open. In replication mode, a Changes table shows the stream and the WAL its slot holds.
- **Overview**, the statements and errors: the last day and week in one table, then the latest sync errors and the
  refused or failed statements, each with **See all** (Logs, failures only; Queries, the failed ones), and — when a
  statement used SQL Mason does not support in the last day — one line naming the most refused entry of
  `docs/SQL-SUPPORT.md`, with **See all** (Queries).
- **Tables** (`#tables`): the database's tables, as `mason tables` lists them, with a search box by name and an All /
  Added / Failed / Not added filter. With hundreds of tables the first 100 that pass are written, then **Show 100 more**
  and **Show all**; the search is over every table, at once. A long name is cut with an ellipsis, its whole the tooltip.
- **Tables**, an added table: its state (Synced, Syncing, Failed or Waiting) over its copy's bar — every added table has
  one, as `mason status` draws one for each: full at 100% once copied, red when its copy failed, amber when it is not kept
  current, moving while it copies, a shimmer while it waits — its rows, its last sync over how long it took, and the
  copy's size. What is said at length (the words `mason wait` prints after a bar not yet full, an error, why a table
  cannot be added, its stream state) is its note, a line of its own under the row, across every column — written for
  every row, empty when it says nothing, so a note that comes or goes moves no row. **View syncs** opens Syncs narrowed
  to that table; **Sync now** runs `mason sync` for it
  (its button says Syncing…, then Synced ✓, in one width); **Remove** asks first, then runs `mason remove`. **Nothing a
  click does moves another row or a column**: the columns are fixed widths, a question (Remove's), a form (Columns…) and
  what an action answered are popovers beside the button, over the rows and never between them — an answer goes by
  itself after 8 s, a refusal stays until dismissed — and only an expander the reader opens (a request's details, a
  copy's whole error) pushes the rows under it down.
- **Tables**, a table not added: its rows, its key and why it cannot be added as it is. **Add** copies every column, as
  `mason add <table>` does; **Columns…** opens a form to tick the columns to copy; **Name its key…** does the same for a
  table with no primary key.
- **Users** (`#users`): a form that adds a user by name. Its password, URL and psql line are shown once, in a card with
  Copy buttons, with a link to Queries, where its statements will show; Mason keeps no copy, so they are never shown again.
- **Users**, the list: each user's status (Active or Removed), when added, when last used, and its URL with **Copy**. A
  user that no longer connects is flagged with why. **Remove** asks first; a removed user stays listed, muted.
- **Observability › Queries** (`#observability/queries`): the request log, and only that — who is connected, what runs
  and the range's numbers are on Usage.
- **Queries**, the request log empty and unfiltered: its sentence, then Connect your first tool (as the Overview's).
- **Queries**, the request log: newest first, with a status dot per row. Filter by status, **Slow (1 s or more)**, a
  piece of the statement's text (**Statement has**), since (`2h`, `7d`, or a date: used instead of the range), user and
  client; **Older** pages back and **Newest** returns, 40 a page. **Started**, **Duration** and **Rows** sort the page
  shown (said under it: the pages follow the log's order by start). A statement is one or two lines in its row; a row
  opens in place to its whole id, times, bytes sent, statement and error — the first 16 KiB of each, said when cut.
  A statement that reads no copied table (`select 1`, `select now()`, SET, SHOW, a BI tool's catalog queries) is
  answered without the copy and **not listed** — the protocol's chatter, hundreds a connection from a BI tool — and the
  page says so, as `mason logs --requests` does when it lists none; while nothing is listed, Connect offers a first
  statement that is (`select count(*) from <a copied table>;`).
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
- **Usage**, charts and tables: four charts over the range (statements, p95, the copy's size, rows in the copy), their
  time axis in minutes, hours or days by the range, their values compact (`1.2K`, `3.4 MiB`, `512 ms`) and exact on
  hover; a series with one sample says its value instead. Then each copy's own size, measured every 10 minutes. The
  samples, newest first (**Time** sorts them), sit behind a closed details, and the process's memory behind another.
- **Observability › Syncs** (`#observability/syncs`): the sync's events of the range, newest first (**When** turns it
  round), with when, kind, table and reason. **Failures only**, a **Kind** (every kind of event) and a **Table** (every added table, whether the range has an event of it or not: one with none says so by its name) narrow the list; 100 are
  written at once, then **Show more**.
- **Syncs**, the run's raw log: behind a closed details, for debugging (it has internal tags and paths), newest first. Mason
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
grid of KPI cards, then dense tables. Colour says a state and nothing else — a green, amber, red or gray marker always
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
the first visit trades the token for a cookie (HttpOnly, SameSite=Strict) and drops it from the address bar, so the
page itself never holds it. Every request is checked for the server's own Host, every change for the page's own
Origin. Each `mason start` makes a new token: after a restart the page says so, and `mason ui` opens it again.
`mason start` prints `Web UI  mason ui` and `mason status` the page's URL without the token; the token is written
nowhere else.

The page is `mason start`'s alone: `mason serve` serves none. Its guard is the loopback interface and a token printed
to the person at the machine; a page reached from other machines would need TLS and a login, which are not designed.

## Building it out

The page is plain HTML, CSS and JavaScript modules under `src/web/` — a shell (`app.js`), what the pages share
(`shared.js`), the charts (`charts.js`) and one module per page (`pages/<id>.js`, so pages are built independently) —
with no framework or build step, and its dependencies vendored whole ("Presentation"),
and every page of the full UI renders a command's `--json` shape from an endpoint the server already has (the
statements that ran, the slow and refused statements, a sync on demand).
[`.claude/rules/web-ui.md`](../.claude/rules/web-ui.md) has the rules and the table of what each feature reads.
