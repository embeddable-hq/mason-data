---
paths:
  - "src/web/**"
  - "tests/web-*.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

# The web page (`src/web/`, `mason ui`, docs/WEB-UI.md)

`mason start`'s run serves one page from its command server (src/cli/run-server.ts): STATUS (what `mason status`
says), TABLES (what `mason tables`, `mason add` and `mason remove` do) and USERS (what `mason user` does). It is a
foundation: the full UI is built on it, page by page, under these rules.

- **One page per concern, rendered from the command server's JSON exactly as the CLI prints it** (one grammar at
  every entrance): a page's words are the commands' words — "the copy", "added", "a user", the phase lines `mason
  wait` prints — never a vocabulary of its own, and never the engine's name. Where the page re-says a CLI line (a copy's
  progress, the database's rows, a table's line, what an add or a remove did) it is held EQUAL to the CLI's function by
  a test (`tests/web-page.test.ts`: `copyingText`, `tableLines`, `duration`, `sourceRows`, `tableFacts`, `addedLines`,
  `removedReport`), so the two cannot drift.
- **Nothing on the page that `mason status --json` (or the command whose `--json` it renders) cannot also say.** A page
  that needs a fact gets it by adding it to the JSON first, computed ONCE on the server (`readiness` is the run's, in
  `/api/state`, src/cli/readiness.ts): the CLI and the page stay equal, and an agent reads what a person sees.
- **A refusal renders as the CLI's Failure: message, why, fix, next** (`renderFailure`; the server's every error answer
  carries `failure`, `sendFailure` in src/cli/run-server.ts). A refusal the page meets is worded by the code that
  refuses, the same code `mason …` calls (`addUser`, `removeUser`, `listUsers` in src/cli/user.ts) — never re-worded,
  never validated a second time in the page (no `pattern=` mirroring a server rule: one grammar, the server's).
- **Tables are added and removed through the commands' own endpoints** (done: the TABLES section): the list is
  `GET /api/state` `tables` (`mason tables --json`'s), Add is `POST /api/pick` `{ table, picked: true, columns?, key? }`
  (`mason add`, the run's `pick`), Remove is `POST /api/remove` `{ tables }` (`mason remove`), and after either the page
  reads the state again. The columns and the key are TICKED from the table's own columns, never typed: the page sends
  the list as it is, and an empty one as no list (every column; its primary key) — no second grammar of `--columns`.
  Remove asks first, as a user's Remove does. The answer and a refusal are said under their table. While a form is
  open or a Remove asks, the list is FROZEN at the state it opened over (`held`, src/web/app.js: no refresh, however
  long), so a poll never rewrites it under the person; it is written from the latest state again at Add, Cancel or confirm.
- **No framework, no build step, no dependency, no CDN, no fetched font**: plain HTML, CSS and an ES module, served as
  they are (cli/build.ts copies `src/**` that is not TypeScript, cli/beside.ts). The CSP (`default-src 'self'`,
  src/cli/security.ts `SECURITY_HEADERS`) is the detector: a script or font from elsewhere does not load, and
  `tests/web-page.test.ts` refuses any `http(s)://`, `@import` or `url(` in the files.
- **The allowlist is the only way a file is served** (`PAGE_ROUTES`, read once at start by `pageFiles`): a new file is
  a new route there, never a path joined from the URL; `tests/cli-run-server.test.ts` holds every other path, `..` and
  encoded ones included, to the 404 it was.
- **The guard is the auth, and the page never holds the token** (src/cli/security.ts): `mason ui` prints the URL with
  the run's token once, the first request trades it for an HttpOnly, SameSite=Strict cookie and is redirected to a URL
  without it; every change is checked against the page's Origin. So no login page, no token in JavaScript (the script
  reads neither `location`, `document.cookie` nor storage: `tests/web-page.test.ts`), and no change to the guard
  without `tests/cli-security.test.ts` and `tests/cli-run-server.test.ts`.
- **`mason start`'s only, never `mason serve`'s** (`RunContext.page`): the guard's model is loopback, the Host header
  and a cookie from a token printed to the person at the machine. Off loopback the page would need TLS and a login,
  which are not designed; `mason ui` refuses a run that serves no page, by asking it.
- **Polling, not server-sent events, until a page needs fresher than 2 s** (`POLL_MS`): a poll is a request the guard
  already judges, it stops when the tab is hidden (`document.visibilityState`), and a failed poll keeps the last state
  and says, as a Failure, what to do (the run stopped: `mason start`, then `mason ui`; a cookie of an earlier run:
  `mason ui`).
- **A password is shown once and kept nowhere**: an added user's password lives in the page's memory until the person
  dismisses it, never in storage, a URL or a log line (the server logs `user <name> added`, never the password).
- **Tests assert on what a page WROTE, never geometry**: the renderers are pure functions of the JSON returning HTML
  (`renderStatus`, `renderTables`, `renderUsers`, `renderAdded`, `renderFailure`), the app runs over a fake `fetch` (`createApp`),
  and the fixtures are the server's own (`runState` over synthetic copies: running, copying, failed, not kept current;
  a stopped run's answers). The helpers run under `node --test`; the page's text is read through `textOf`.

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
| The slow statements | `GET /api/slow` | `mason status --json` `slowQueries` |
| The refused statements | `GET /api/refused` | `mason status --json` `refusedQueries`, `refusedTotal` |
| The copy's progress | `GET /api/state` `tables[].copy.progress`, `readiness` | `mason wait --json` (`tableLine`, `copyingText` already render it) |
| Sync on demand | `POST /api/sync` `{ tables }` | `mason sync --json` |
