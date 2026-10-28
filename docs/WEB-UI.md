# The web page (`mason ui`)

`mason start` serves a web page beside the commands: what `mason status` says, the database's tables to add and
remove (`mason tables`, `mason add`, `mason remove`), and the users of `mason user`, in a browser tab.

```bash
mason ui              # opens the page in your browser
mason ui --no-open    # prints its URL only
mason ui --json       # { url, port, next }
```

## What it shows

- **Status**, refreshed every 2 s while the tab is open: the database (its URL with the password masked, its Postgres
  version, how changes arrive — polling or logical replication), the warnings, each added table's copy (its bar, its
  percent, and the line `mason wait` prints: rows, chunks, rows a second, the time left, or why it failed), the
  statements answered slowly and the ones refused in the last day (`mason status` lists them), and whether every added
  table is copied and served. The time it last heard from Mason is beside the title.
- **Tables**: every table of the database, as `mason tables` lists them — its rows, its key, and whether it is added
  or why it cannot be added as it is (no primary key: the columns that tell its rows apart). A table not added has
  **Add**, which copies every column as `mason add <table>` does (a column that looks like a secret is left out, and
  the page says which, as the command does), and **Columns…**, a form to tick the columns to copy (`--columns`); a table
  with no primary key has **Name its key…**, the same form with its key to tick (`--key`). An added table has
  **Remove**, which asks first, then takes it out of the sources file and drops its copy (`mason remove`). What was
  added or removed is said under the table in the commands' words, and the Status above then shows the copy starting.
  The sources file is edited by the run exactly as the commands edit it — one check-and-write, src/cli/source-edit.ts,
  which `mason add` and `mason remove` also call themselves while Mason is stopped — and refused in the same words. While a
  Columns… form is open or a Remove asks, the list is frozen as it was when it opened (no refresh, however long it
  stays open, so nothing moves under the person's ticks or click); it is written from the latest state again once
  they Add, Cancel or confirm.
- **Users**: each user with when it was added and whether it connects; a form that adds one — its password and the
  URL to paste are shown once, with a copy button, and never again — and a Remove button that asks first. These are
  the same users as `mason user list|add|remove`, in the same file, refused in the same words.

When something is refused, or Mason stops answering, the page says it as the commands do: what is wrong, why, the way
out, and the commands to run next.

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

The page is plain HTML, CSS and one JavaScript module under `src/web/`, with no framework, build step or dependency,
and every page of the full UI renders a command's `--json` shape from an endpoint the server already has (the
statements that ran, the slow and refused statements, a sync on demand).
[`.claude/rules/web-ui.md`](../.claude/rules/web-ui.md) has the rules and the table of what each feature reads.
