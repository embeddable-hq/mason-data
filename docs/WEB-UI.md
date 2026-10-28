# The web page (`mason ui`)

`mason start` serves a web page beside the commands: what `mason status` says, the database's tables to add and
remove (`mason tables`, `mason add`, `mason remove`), and the users of `mason user`, in a browser tab.

```bash
mason ui              # opens the page in your browser
mason ui --no-open    # prints its URL only
mason ui --json       # { url, port, next }
```

## What it shows

The page has a nav — Status · Tables · Queries · Users · Usage · Logs — and shows one page at a time, chosen by the
address's hash (`#tables`; none, or one it does not know, is Status), so a page can be bookmarked and the browser's Back
goes to the page before. Only the page shown asks Mason anything, each thing at the rate it changes, and nothing while
the tab is hidden.

- **Status**, refreshed every 2 s while it is shown (what comes from the request log, every 30 s; the last 24 hours of
  usage, every minute): the word `mason status` ends on (Ready, Under way or Failed) beside a big dot, then cards — the
  tables synced of those added, their rows, the last sync (how long ago, and when), the copy file's size, the last day's
  statements and their p95, each with a sparkline of the last 24 hours once there are two hours to draw — then the
  copies not finished, then ONE table of the other facts — the database (its URL with the password
  masked, its Postgres version), how changes arrive (polling or logical replication), the warnings, Mason's version,
  how long it has been up and its restarts, the free disk where the copy is (and, while a copy runs, what it is projected to add: a warning
  when that is more than is free) and the sessions open. In replication mode a **Changes** table says where the stream
  is as `mason status` does (running, or why not; its position against the database's; the lag; the last batch) and
  what the slot holds on the database's WAL, its status and the room left before the database drops it (`lost`,
  `unreserved` or no cap on the slot are warnings). A fact Mason could not read is said as unknown with its reason, never as 0.
  Then the last day's and week's statements (how many, each outcome, average / p50 / p95, rows and bytes sent) and the
  latest sync errors and statements refused, failed or cancelled. The copies not finished are a bar each, the percent
  and the line `mason wait` prints (rows, chunks, rows a second, the time left, or why it failed — nothing once every
  copy is done). The slow and the refused statements are the Queries page's. How long ago it last heard from Mason is
  in the top bar.
- **Tables**: the database's tables in ONE table, as `mason tables` lists them. An added table shows its copy —
  Synced, Syncing, Failed or Waiting, its rows, when it was last synced and how long ago, how long that took (`<0.1 s`
  when it was quicker), the copy's own size (measured every 10 minutes, as `mason usage` lists it), in replication mode
  its stream state (streamed, being caught up, waiting or left out, and why) and its error — with **Sync**, which makes it
  current now as `mason sync <table>` does and says what it did under it, and **Remove**, which asks first, then takes it
  out of the sources file and drops its copy (`mason remove`). A table not added shows its rows, its key and why it
  cannot be added as it is (no primary key: the columns that tell its rows apart), with **Add**, which copies every
  column as `mason add <table>` does (a column that looks like a secret is left out, and the page says which, as the
  command does), and **Columns…**, a form to tick the columns to copy (`--columns`); a table with no primary key has
  **Name its key…**, the same form with its key to tick (`--key`). A search box filters by name, and All / Added / Not
  added by state. What was added or removed is said under the table in the commands' words, and the Status then shows
  the copy starting. The sources file is edited by the run exactly as the commands edit it — one check-and-write,
  src/cli/source-edit.ts, which `mason add` and `mason remove` also call themselves while Mason is stopped — and refused
  in the same words. While a Columns… form is open or a Remove asks, the list is frozen as it was when it opened (no
  refresh, however long it stays open, so nothing moves under the person's ticks or click); it is written from the
  latest state again once they Add, Cancel or confirm.
- **Queries**: who is connected now (a row per user and client: sessions open, statements running), the statements
  running now with **Cancel** (asks first), and the request log, filtered by status, time, user and client. A request
  shows the first 8 characters of its id; its details hold the whole id, when it ended, the bytes sent, the whole
  statement and the whole error.
- **Users**: each user with when it was added and whether it connects; a form that adds one — its password and the
  URL to paste are shown once, with a copy button, and never again — and a Remove button that asks first. These are
  the same users as `mason user list|add|remove`, in the same file, refused in the same words.
- **Usage**: the last day's and week's statements, the last 24 hours an hour a line (the process's memory is in a closed
  **Memory** details), and each copy's own size.
- **Logs**: the sync's events. The run's raw log — a debugging aid, with internal tags and paths — is behind a closed
  details, and Mason is asked for it only while it is open.

When something is refused, or Mason stops answering, the page says it as the commands do: what is wrong, why, the way
out, and the commands to run next.

## Presentation

The page looks like Vercel's dashboard: Geist Sans for text and Geist Mono for numbers and code, a near-monochrome gray
scale with hairline borders and generous space, a top bar (Mason, the database's name, a **demo** badge when it is the
demo database, and how long ago Mason last answered — `Updated 3 s ago`, which keeps counting when it stops answering),
underlined tabs, and on Status the run's word beside a big dot, a grid of KPI cards, then dense tables. Colour says a
state and nothing else — a green, amber, red or gray dot always beside its word — besides the one blue accent for focus,
links and a chart's mark. It follows the system's light or dark theme.

Every colour, space, radius, font and size is a CSS custom property on `:root` in `src/web/app.css` (`--bg`,
`--surface`, `--line`, `--fg`, `--muted`, `--accent`, `--ok`, `--warn`, `--bad`, `--unknown`, `--chart-*`,
`--font-sans`, `--font-mono`, `--space-1…7`, `--radius*`, `--text-*`), set again for dark mode, so a page is restyled
by its tokens. The components are helpers of `src/web/shared.js` (`status`, `card`, `cards`, `badge`, `button`,
`panel`, `pageHead`, `empty`, `skeleton`, `details`); the charts, `src/web/charts.js`.

**The vendored files, and why.** People run Mason on machines without internet, so the page fetches nothing from
elsewhere — the policy it is served under (`default-src 'self'`) would refuse it anyway. What it uses that Mason did not
write is copied whole into `src/web/vendor/`, pinned to an exact version, with its licence, and served by Mason itself:
the Geist variable fonts (`geist` 1.7.2, SIL Open Font License 1.1; two woff2 files, 138 KiB) and uPlot (`uplot`
1.6.32, MIT; its ES module and stylesheet, 144 KiB) for the sparklines and small time-series charts — about 282 KiB in
all. `src/web/vendor/README.md` lists them and how one is updated. A chart only adds to the page: every number it draws
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
with no framework or build step, and its two dependencies vendored whole ("Presentation"),
and every page of the full UI renders a command's `--json` shape from an endpoint the server already has (the
statements that ran, the slow and refused statements, a sync on demand).
[`.claude/rules/web-ui.md`](../.claude/rules/web-ui.md) has the rules and the table of what each feature reads.
