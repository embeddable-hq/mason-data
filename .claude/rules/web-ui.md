---
paths:
  - "src/web/**"
  - "tests/web-*.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

# The web page (`src/web/`, `mason ui`, docs/WEB-UI.md)

`mason start`'s run serves one page from its command server (src/cli/run-server.ts): a SHELL (`src/web/app.js`: a nav
and one section per page, the one shown chosen by the URL's hash, `#status` the default) over a module per page
(`src/web/pages/<id>.js`): STATUS (what `mason status` says), TABLES (what `mason tables`, `mason add` and `mason
remove` do), USERS (what `mason user` does), QUERIES, USAGE and LOGS (docs/OBSERVABILITY.md "Pages" is their spec).
The full UI is built on it, page by page, under these rules.

- **A page is a module of its own, registered in three places** (the contract is at the top of src/web/app.js): its
  `page = { id, title, create(ctx) }` in `PAGES`, its route `/pages/<id>.js` in `PAGE_ROUTES`, its
  `<section id="page-<id>">` in index.html; what every page uses lives in `src/web/shared.js`. So pages are built in
  parallel without touching each other, and the tests hold the three equal (a module that is no route would not load).

- **One page per concern, rendered from the command server's JSON exactly as the CLI prints it** (one grammar at
  every entrance): a page's words are the commands' words — "the copy", "added", "a user", the phase lines `mason
  wait` prints — never a vocabulary of its own, and never the engine's name. Where the page re-says a CLI line (a copy's
  progress, the database's rows, a table's line, what an add or a remove did) it is held EQUAL to the CLI's function by
  a test (`tests/web-page.test.ts`: `copyingText`, `tableLines`, `duration`, `sourceRows`, `tableFacts`, `addedLines`,
  `removedReport`, `readinessWord`, `totalsText`, `fileSize`, `bytesText`, `spanText`, `eventLine`, `requestLine`,
  `queryLines`, `syncedReport`, `streamLines`), so the two cannot drift. A line the page splits into a table's cells is held equal
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
  A fact is in ONE place: the Status has one table of facts, the Tables page one list of tables. **A fact the run could
  not read is `unknown` with its reason, never 0, and one it does not say is not shown** (`{ error }` fields of
  `/api/state`: `stream.slotWal`, `engine.restarts`, `disk`, `sessions`).
- **Tables are added and removed through the commands' own endpoints** (done: the TABLES section): the list is
  `GET /api/state` `tables` (`mason tables --json`'s), Add is `POST /api/pick` `{ table, picked: true, columns?, key? }`
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
  already judges. ONLY THE PAGE SHOWN is asked, each of its reads at its own rate (`reads()`: `{ path, everyMs }`, the
  rate its data moves; `POLL_MS` or less, every poll), so a page nobody looks at costs the run nothing. It stops when
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
- **Colour says a state or is the accent, nothing else**: green ok (ready, synced), amber warn (syncing, waiting),
  red bad (failed, error), gray unknown — always a dot AND the CLI's word (`status(kind, word)`, src/web/shared.js),
  never colour alone; the one accent is focus, a link and a chart's mark. No gradient, no shadow beyond a hairline:
  the reader's eye goes to what changed state, not to decoration.
- **A component is a helper of src/web/shared.js, not markup copied into a page** (`status`, `card`/`cards`, `badge`,
  `button`, `panel`, `pageHead`, `empty`, `skeleton`, `details`): one place to change how a thing looks, and the tests
  assert on what the helper wrote.
- **A number is text first; a chart is an addition** (src/web/charts.js over the vendored uPlot): every value a chart
  draws is also in a card or a table, a holder is hidden until it is drawn, and when uPlot cannot load the page reads
  whole (said once in the console). So a test, a screen reader and a box where the module fails read the same page.
  A chart is one series (no dual axis), from a zero baseline, made and destroyed by its holder's key (`createCharts`:
  no instance outlives its holder), themed from the `--chart-*` tokens.
- **A `<details>` a poll rewrites stays open**: whether it is open is the page's state (`createOpenSet`), keyed by a
  stable id (a request's id, a table's name), written into the HTML by `details(key, …)` — never the element's own,
  which a rewrite replaces. (The raw log's details is the Logs page's own state, as before.)
- **A fact is in ONE place on Status**: the cards carry the copies in all, their rows, the last sync and the copy's file,
  and the facts table no longer does; the last day's statements and p95 cards are the request log's summary at a
  glance, its table the day and the week in full.
- **Numbers are mono and right-aligned in a column; a table scrolls inside its card on a phone, never the page**: the
  reader compares down a column, and a page that scrolls sideways hides the nav.

## What the full UI adds

Each is a page over an endpoint that already exists, rendering the shape the command's `--json` prints: the builder
adds pages, not endpoints.

| Feature | Endpoint (src/cli/run-server.ts) | Renders the shape of |
|---|---|---|
| The statements that ran | `GET /api/requests?limit=&failed=1` | `mason logs --requests --json` |
| The sync's failures and events | `GET /api/events?limit=&since=&failed=1` | `mason logs --events --json`; the latest failures, `mason status --json` `recentErrors` |
| Usage over time, each copy's own size | `GET /api/usage?since=&until=&step=` | `mason usage --json` (`samples`, re-bucketed by `step`; `copySizes`) |
| The run's log | `GET /api/logs?lines=&since=` | `mason logs --json` (`lines`: `{ at, text }`) |
| Each table's sync, the copies in all | `GET /api/state` `tables[].sync`, `totals` | `mason status --json` |
| The slow statements (not yet on a page: the Queries page's request log lists them) | `GET /api/slow` | `mason status --json` `slowQueries` |
| The refused statements (the same) | `GET /api/refused` | `mason status --json` `refusedQueries`, `refusedTotal` |
| The copy's progress | `GET /api/state` `tables[].copy.progress`, `readiness` | `mason wait --json` (`tableLine`, `copyingText` already render it) |
| Sync on demand | `POST /api/sync` `{ tables }` | `mason sync --json` |
