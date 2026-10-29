---
paths:
  - "src/web/**"
  - "tests/web-*.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

# The web page (`src/web/`, `mason ui`, docs/WEB-UI.md)

`mason start`'s run serves one web page, with six pages in it, from its command server (src/cli/run-server.ts): a SHELL (`src/web/app.js`: a left
sidebar — the project, a nav of links with icons (`renderNav`, `NAV_ICONS`), when it was updated and the version — and one section per page, the one shown chosen by the URL's hash, `#overview` the default) over a module
per page (`src/web/pages/<id>.js`): the OVERVIEW (`status.js`: what `mason status` says), TABLES (what `mason tables`,
`mason add` and `mason remove` do), USERS (what `mason user` does), and OBSERVABILITY's three views, QUERIES, USAGE and
LOGS (docs/OBSERVABILITY.md "Pages" is their spec). All six pages are built on it, under these rules.

- **The hash is the state of the navigation, and an old one never breaks**: a page's `hash` (`overview`,
  `observability/queries`; its id when it says none) and its `?` parameters (`range`, `show`, `slow`, `status`,
  `failures`) are read by ONE function (`parseHash`), written by one (`hashOf`), and a page takes the parameters it knows
  in its `route(params, { doc })`. The hashes of before (`#status`, `#queries`, `#usage`, `#logs`, `#observability`) are
  `ALIASES` of the view they were: a bookmark lands where it did (`tests/web-page.test.ts` holds each).
- **A page with a `parent` is in its group** (`observability`, `GROUPS`): its link is under the group's heading in the
  sidebar (always shown, the current page the view itself, `aria-current`), and its views share
  `ctx.range()` — `RANGES` in src/web/shared.js (Last hour · 24 hours · 7 days, 24 hours by default), each its `since`
  for every endpoint and its usage step — kept in the hash (`?range=`), never in storage, and in the group's links;
  the range control is in the view's header row, right of its title (`renderSubnav`, its section's `range-<id>`), never in the sidebar. A view builds its paths from
  it, so a change of range is a new read of the view shown alone.

- **A page is a module of its own, registered in three places** (the contract is at the top of src/web/app.js): its
  `page = { id, title, hash?, parent?, create(ctx) }` in `PAGES`, its route `/pages/<id>.js` in `PAGE_ROUTES`, its
  `<section id="page-<id>">` in index.html; what every page uses lives in `src/web/shared.js`. So pages are built in
  parallel without touching each other, and the tests hold the three equal (a module that is no route would not load).

- **One page per concern, rendered from the command server's JSON exactly as the CLI prints it** (one grammar at
  every entrance): a page's words are the commands' words — "the copy", "added", "a user", the phase lines `mason
  wait` prints — never a vocabulary of its own, and never the engine's name. Where the page re-says a CLI line (a copy's
  progress, the database's rows, a table's line, what an add or a remove did) it is held EQUAL to the CLI's function by
  a test (`tests/web-page.test.ts`: `copyingText`, `tableLines`, `duration`, `sourceRows`, `tableFacts`, `addedLines`,
  `removedReport`, `readinessWord`, `totalsText`, `fileSize`, `bytesText`, `spanText`, `eventLine`, `requestLine`,
  `queryLines`, `syncedReport`, `streamLines`, `unsupportedLines`, `ago`), so the two cannot drift. A line the page splits into a table's cells is held equal
  cell by cell: its cells, read in order, are the CLI's line (spaces aside).
- **Nothing on the page that `mason status --json` (or the command whose `--json` it renders) cannot also say.** A page
  that needs a fact gets it by adding it to the JSON first, computed ONCE on the server (`readiness` is the run's, in
  `/api/state`, src/cli/readiness.ts): the CLI and the page stay equal, and an agent reads what a person sees.
- **A refusal renders as the CLI's Failure: message, why, fix, next** (`renderFailure`; the server's every error answer
  carries `failure`, `sendFailure` in src/cli/run-server.ts). A refusal the page meets is worded by the code that
  refuses, the same code `mason …` calls (`addUser`, `removeUser`, `listUsers` in src/cli/user.ts) — never re-worded,
  never validated a second time in the page (no `pattern=` mirroring a server rule: one grammar, the server's).
- **A page shows what a person reads, and puts the rest behind a closed `<details>`**: a debugging aid (the run's raw
  log, with internal tags and absolute paths; the process's memory; a request's whole id, bytes and statement) is a
  details, and what only a details shows is read only while it is open (the raw log: `toggle`, the page's own state).
  A fact is in ONE place: the Overview has one table of facts, the Tables page one list of tables. **A fact the run could
  not read is `unknown` with its reason, never 0, and one it does not say is not shown** (`{ error }` fields of
  `/api/state`: `stream.slotWal`, `engine.restarts`, `disk`, `sessions`).
- **Tables are added and removed through the commands' own endpoints** (the Tables page): the list is
  `GET /api/state` `tables` (`mason tables --json`'s, LEAN: no table's columns — the page polls it every 2 s, and the
  columns were most of it, 3.4 MB at 800 tables of 50; `?columns=1` adds them, which `mason status --json` asks), a
  form's columns are `GET /api/tables/<table>/columns`, read once as Columns… or Name its key… opens, Add is `POST /api/pick` `{ table, picked: true, columns?, key? }`
  (`mason add`, the run's `pick`), Remove is `POST /api/remove` `{ tables }` (`mason remove`), and after either the page
  reads the state again. The columns and the key are TICKED from the table's own columns, never typed: the page sends
  the list as it is, and an empty one as no list (every column; its primary key) — no second grammar of `--columns`.
  Remove asks first, as a user's Remove does. The answer and a refusal are said under their table. While a form is
  open or a Remove asks, the list is FROZEN at the state it opened over (`held`, src/web/pages/tables.js: no refresh, however
  long), so a poll never rewrites it under the person; it is written from the latest state again at Add, Cancel or confirm.
  Sync is `POST /api/sync` `{ tables: [name] }` (`mason sync`), said under its copy as `mason sync` says it
  (`syncedReport`, src/cli/sync.ts); the search box filters by name, and All / Added / Not added by state, in the page alone (the endpoint returns every table).
- **No framework, no build step, no CDN, nothing fetched from elsewhere**: plain HTML, CSS and ES modules importing each
  other by relative paths, served as they are (cli/build.ts copies `src/**` that is not TypeScript, subfolders too,
  cli/beside.ts), because Mason runs on boxes without internet and the page must work there whole. **A small dependency
  only vendored whole** — its built file(s) and its LICENSE, pinned to an exact version in `src/web/vendor/<name>-<version>/`,
  listed in `src/web/vendor/README.md`, each file a `PAGE_ROUTES` entry, never edited — and **a font only vendored
  (woff2)**, so what the page runs is reviewed, licensed and the same on every box. The CSP (`default-src 'self'`,
  src/cli/security.ts `SECURITY_HEADERS`) is the detector in the browser: a script, style or font from elsewhere does
  not load; `tests/web-page.test.ts` refuses any `http(s)://` and `@import` in every file under src/web/ outside
  vendor/, and allows `url(` ONLY in an `@font-face`, as a relative path to a woff2 under vendor/ that is a route —
  and holds every vendored file to a route, its folder to `<name>-<x.y.z>` with a LICENSE.txt, and the README to listing it.
- **The allowlist is the only way a file is served** (`PAGE_ROUTES`, read once at start by `pageFiles`): a new file is
  a new route there, never a path joined from the URL; `tests/cli-run-server.test.ts` holds every other path, `..` and
  encoded ones included, to the 404 it was, and `tests/cli-package.test.ts` every file under src/web/ to a route.
- **The guard is the auth, and the page never holds the token** (src/cli/security.ts): `mason ui` prints the URL with
  the run's token once, the first request trades it for an HttpOnly, SameSite=Strict cookie and is redirected to a URL
  without it; every change is checked against the page's Origin. So no login page, no token in JavaScript (the scripts
  read neither `location` — but its hash, the page shown, which never carries the token —, `document.cookie` nor
  storage: `tests/web-page.test.ts`), and no change to the guard
  without `tests/cli-security.test.ts` and `tests/cli-run-server.test.ts`.
- **`mason start`'s only, never `mason serve`'s** (`RunContext.page`): the guard's model is loopback, the Host header
  and a cookie from a token printed to the person at the machine. Off loopback the page would need TLS and a login,
  which are not designed; `mason ui` refuses a run that serves no page, by asking it.
- **Polling, not server-sent events, until a page needs fresher than 2 s** (`POLL_MS`): a poll is a request the guard
  already judges. ONLY THE PAGE SHOWN is asked (and, beside a page that does not read it, the state the sidebar names the project from, once a minute: `SHELL_STATE`), each of its reads at its own rate (`reads()`: `{ path, everyMs }`, the
  rate its data moves; `POLL_MS` or less, every poll), so a page nobody looks at costs the run nothing. A read that
  costs the run a scan is asked as often as it is worth, and the page says so (Queries' `search`, ~0.6 s over 7 days:
  every 30 s, "Refreshed every 30 s while searching", not the newest page's 5 s). It stops when
  the tab is hidden (`document.visibilityState`); no part is written while a pointer is pressed (a row rewritten between
  press and release loses the click); the page's FIRST read failing is the banner, another's is said where it shows;
  and a failed poll keeps the last state
  and says, as a Failure, what to do (the run stopped: `mason start`, then `mason ui`; a cookie of an earlier run:
  `mason ui`).
- **A password is shown once and kept nowhere**: an added user's password lives in the page's memory until the person
  dismisses it, never in storage, a URL or a log line (the server logs `user <name> added`, never the password).
- **Tests assert on what a page WROTE, never geometry**: the renderers are pure functions of the JSON returning HTML
  (`renderStatus`, `renderTables`, `renderUsers`, `renderAdded`, `renderFailure`, `renderNav`), the app runs over a fake
  `fetch` (`createApp`; `show(id)` chooses the page as the hash does), `start` over a fake document and window,
  and the fixtures are the server's own (`runState` over synthetic copies: running, copying, failed, not kept current;
  a stopped run's answers). The helpers run under `node --test`; the page's text is read through `textOf`.

## The presentation (docs/WEB-UI.md "Presentation")

- **The look is Vercel's dashboard's, from tokens**: every colour, space, radius, font and size is a custom property
  on `:root` in src/web/app.css, redefined for dark under `prefers-color-scheme`, so a page restyles by tokens and both
  themes come with it. Never a literal colour in a rule: a literal is the one place the dark theme forgets.
- **The sidebar is the nav at every width, never a second one**: 232 px with labels; below 1000 px an icon rail, each
  label its icon's tooltip and still the link's name; below 640 px a top bar whose menu button (`aria-expanded`,
  `aria-controls`) opens the nav as a sheet — focus to its first link; Escape, a click outside, the focus leaving or a link
  followed close it (`start`, held by `tests/web-page.test.ts` over the fake document). index.html's nav is the one
  `renderNav` writes but its icons, so nothing moves when the script writes it. **An icon is Lucide's, vendored whole**
  (`src/web/vendor/lucide-<version>/`, one `.mjs` per icon, the only `.mjs` a module may import), inline through
  `icon(name)` of src/web/shared.js, 16 px, `currentColor`, `aria-hidden` beside its label: a new icon is its file, its
  route, its line in the README and `ICONS`.
- **Colour says a state or is the accent, nothing else**: green ok (ready, synced), amber warn (syncing, waiting),
  red bad (failed, error), gray unknown — always a dot AND the CLI's word (`status(kind, word)`, src/web/shared.js),
  never colour alone; the one accent is focus, a link and a chart's mark. No gradient, no shadow beyond a hairline:
  the reader's eye goes to what changed state, not to decoration.
- **A component is a helper of src/web/shared.js, not markup copied into a page** (`status`, `card`/`cards`, `badge`,
  `button`, `panel`, `empty`, `skeleton`, `details`): one place to change how a thing looks, and the tests
  assert on what the helper wrote. A section's heading is index.html's own (it reads before the script runs).
- **A number is text first; a chart is an addition** (src/web/charts.js over the vendored uPlot): every value a chart
  draws is also in a card or a table, a holder is hidden until it is drawn, and when uPlot cannot load the page reads
  whole (said once in the console). So a test, a screen reader and a box where the module fails read the same page.
  A chart is one series (no dual axis), from a zero baseline, made and destroyed by its holder's key (`createCharts`:
  no instance outlives its holder), themed from the `--chart-*` tokens.
- **A `<details>` a poll rewrites stays open**: whether it is open is the page's state (`createOpenSet`), keyed by a
  stable id (a request's id, a table's name), written into the HTML by `details(key, …)` — never the element's own,
  which a rewrite replaces. (The raw log's details is the Logs page's own state, as before.)
- **A fact is in ONE place on the Overview**: the cards carry the copies in all, their rows, the last sync and the copy's file,
  and the facts table no longer does; the last day's statements and p95 cards are the request log's summary at a
  glance, its table the day and the week in full.
- **Numbers are mono and right-aligned in a column; a table scrolls inside its card on a phone, never the page**: the
  reader compares down a column, and a page that scrolls sideways hides the nav.
- **Newest first wherever a list is time** (the request log, the sync's events, the raw log, Usage's samples); a chart
  alone reads oldest to newest, left to right. **A column sorts when sorting means something**, by a `sortTh` button
  with `aria-sort`: server-side only where the server pages by that order — the request log's pages follow its cursor
  (start, seq), so Started, Duration and Rows sort THE PAGE SHOWN and the page says so (a sort of the whole log would
  need a cursor per order) — and in the page for a list read whole (the events, the samples).
- **What the page writes is bounded, whatever the data**: a list of hundreds writes a page of rows and `moreRows`
  (Tables 100, the events 100), a by-client list its top 10 and one row for the rest, a long name or value is cut by the
  stylesheet with its whole the `title`, a title is at most `TITLE_MAX` characters (`clip`), a statement is one or two
  lines in its cell and the first `STATEMENT_MAX` in its expanded row (`capped`, which says it was cut and where the
  whole is). The tests render these with large fixtures (800 tables of 60-character names, 200 clients, a 64 KiB
  statement, 10,000 requests paged, 500 events, a week of samples with a spike) and hold the caps.
- **A chart's axes read at every range** (src/web/charts.js, pure helpers the tests hold): time ticks by the span
  (`timeTick`: minutes and hours up to two days, then days), at least 72 px apart; y labels compact in the commands'
  units (`compactCount`, `compactBytes` to TiB, `compactMs`) on whole-number or power-of-1024 steps (`axisIncrs`); the
  read-out on hover is exact (the spec's `format`, as the table says it). The y axis starts at zero and is never cut: a
  spike keeps its height, and the table under the chart has every value.
- **No card alone on a row**: `cards()` writes its count (`cards n5`), and the stylesheet lays each count out (one row
  wide; six as three by two, five as three over two; on a phone the odd last card spans the row).

## What the full UI adds

Each is a page over an endpoint that already exists, rendering the shape the command's `--json` prints: the builder
adds pages, not endpoints.

| Feature | Endpoint (src/cli/run-server.ts) | Renders the shape of |
|---|---|---|
| The statements that ran | `GET /api/requests?since=&outcome=&user=&client=&slow=1&search=&before=` | `mason logs --requests --json` |
| The sync's failures and events | `GET /api/events?limit=&since=&failed=1` | `mason logs --events --json`; the latest failures, `mason status --json` `recentErrors` |
| Usage over time, each copy's own size | `GET /api/usage?since=&until=&step=` | `mason usage --json` (`samples`, re-bucketed by `step`; `copySizes`) |
| The run's log | `GET /api/logs?lines=&since=` | `mason logs --json` (`lines`: `{ at, text }`) |
| Each table's sync, the copies in all | `GET /api/state` `tables[].sync`, `totals` | `mason status --json` |
| The slow statements | `GET /api/requests?slow=1` (Queries' Slow filter; `GET /api/slow` groups them for `mason status`) | `mason logs --requests --slow --json`; `mason status --json` `slowQueries` |
| The refused statements (the same) | `GET /api/refused` | `mason status --json` `refusedQueries`, `refusedTotal` |
| The unsupported SQL (Queries' panel, over the range; the Overview's line, the last day) | `GET /api/unsupported?since=&limit=` | `mason status --json` `unsupported` (`unsupportedLines`) |
| The copy's progress | `GET /api/state` `tables[].copy.progress`, `readiness` | `mason wait --json` (`tableLine`, `copyingText` already render it) |
| Sync on demand | `POST /api/sync` `{ tables }` | `mason sync --json` |
| A table's columns (the Columns… form) | `GET /api/tables/<table>/columns` (`{ table, columns }`; never in the polled `GET /api/state`, whose `?columns=1` has every table's) | `mason tables <table> --json` `columns` |
