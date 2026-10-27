# The web page (`mason ui`)

`mason start` serves a web page beside the commands: what `mason status` says, and the users of `mason user`, in a
browser tab.

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
statements that ran, adding and removing tables with the copy's progress, a sync on demand).
[`.claude/rules/web-ui.md`](../.claude/rules/web-ui.md) has the rules and the table of what each feature reads.
