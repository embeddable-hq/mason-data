# The web page (`mason ui`)

`mason start` serves a web page beside the commands, in a browser tab: six pages (Status, Tables, Queries, Users,
Usage and Logs) over the state `mason status`, `mason tables`, `mason user`, `mason usage` and `mason logs` read.

```bash
mason ui              # opens the page in your browser
mason ui --no-open    # prints its URL only
mason ui --json       # { url, port, next }
```

## What it shows

The page has a nav (Status · Tables · Queries · Users · Usage · Logs) and shows one page at a time, chosen by the
address's hash (`#tables`; none, or one it does not know, is Status), so a page can be bookmarked and Back goes to the
page before. Only the page shown asks Mason anything, each read at the rate its data changes, and nothing while the tab
is hidden. How long ago Mason last answered is in the top bar.

- **Status** (`#status`, read only): the run's word (Ready, Under way or Failed) beside a big dot, then cards for the
  tables synced, the rows, the last sync, the copy's file, and the last day's statements with their p95. Each card has a
  24-hour sparkline once there are two hours to draw.
- **Status**, the copies not finished: a bar each with the line `mason wait` prints, and nothing once every copy is done.
- **Status**, the facts: one table with the database and how its changes arrive, the warnings, Mason's version, uptime and
  restarts, free disk, and sessions open. In replication mode, a Changes table shows the stream and the WAL its slot holds.
- **Status**, the statements and errors: the last day and week in one table, then the latest sync errors and the refused
  or failed statements.
- **Tables** (`#tables`): the database's tables, as `mason tables` lists them, with a search box by name and an All /
  Added / Not added filter.
- **Tables**, an added table: its state (Synced, Syncing, Failed or Waiting), rows, last sync, how long the sync took, the
  copy's size and any error. **Sync** runs `mason sync` for it; **Remove** asks first, then runs `mason remove`.
- **Tables**, a table not added: its rows, its key and why it cannot be added as it is. **Add** copies every column, as
  `mason add <table>` does; **Columns…** opens a form to tick the columns to copy; **Name its key…** does the same for a
  table with no primary key.
- **Queries** (`#queries`): cards for sessions open, statements running, the last day's statements, failed and p95, then
  who is connected now, a row per user and client.
- **Queries**, running now: each statement with **Cancel**, which asks first and stops that one statement, as
  `mason cancel` does.
- **Queries**, the request log: newest first, with a status dot per row. Filter by status, since (`2h`, `7d`, or a date),
  user and client; **Older** pages back and **Newest** returns. A row opens in place to its whole id, times, bytes sent,
  statement and error.
- **Users** (`#users`): a form that adds a user by name. Its password and URL are shown once, in a card with Copy buttons;
  Mason keeps no copy, so they are never shown again.
- **Users**, the list: each user's status (Active or Removed), when added, when last used, and its URL with **Copy**. A
  user that no longer connects is flagged with why. **Remove** asks first; a removed user stays listed, muted.
- **Usage** (`#usage`): cards for the last 24 hours (statements, failed, p95, rows sent, bytes sent), each with a sparkline.
- **Usage**, charts and tables: four charts by the hour (statements, p95, the copy's size, rows in the copy), the last day
  and week side by side, and each copy's own size, measured every 10 minutes. The hourly numbers sit behind a closed
  details, and the process's memory behind another.
- **Logs** (`#logs`): the sync's events, newest last, with when, kind, table and reason. **Failures only** narrows the list.
- **Logs**, the run's raw log: behind a closed details, for debugging (it has internal tags and paths). Mason is asked for
  it only while the details is open.

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
