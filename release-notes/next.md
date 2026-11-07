The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason serve` can serve the web page on a Unix socket too: set `MASON_UI_SOCKET`** (for example
  `/mason/data/.mason/ui.sock`), so a supervisor or a local reverse proxy on the same machine reaches the page without a
  published port or a `docker exec` per request. The socket is mode 0600 in a folder only Mason's user can write (else
  the start is refused, saying why), a stale one a crash left is replaced, anything else at the path is refused and left
  alone, and it is removed on exit. A request on it passes the same guard as one through `mason ui --ssh`. Unset,
  nothing changes; `mason start` refuses it.
