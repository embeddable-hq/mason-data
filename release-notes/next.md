The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The web page works behind a reverse proxy at any path**, such as `https://example.com/tools/mason/`, with no
  setting: it asks for every file and every answer relative to its own address, and the first visit's redirect (the
  token traded for the cookie) lands back on that address, never the proxy's root. Serve it at an address that ends
  in `/`; the run still checks every request for its own Host and every change for its own Origin, so the proxy sends
  those. `mason ui` opens it at `/` as before.
- **`mason serve` can serve the web page on a Unix socket too: set `MASON_UI_SOCKET`** (for example
  `/mason/data/.mason/ui.sock`), so a supervisor or a local reverse proxy on the same machine reaches the page without a
  published port or a `docker exec` per request. The socket is mode 0600 in a folder only Mason's user can write (else
  the start is refused, saying why), a stale one a crash left is replaced, anything else at the path is refused and left
  alone, and it is removed on exit. A request on it passes the same guard as one through `mason ui --ssh`. Unset,
  nothing changes; `mason start` refuses it.
- **`mason serve` can serve a web page that only shows: set `MASON_UI_READ_ONLY=1`.** The page then offers no Add,
  Remove, Sync, Disable, Enable, Cancel, Add a user or Connect from anywhere, and refuses every change it is sent,
  through `mason ui --ssh` or the socket alike, saying the page is read-only here. What it shows is unchanged. The
  `mason` commands beside the server are unchanged too (`MASON_PROJECT_READONLY=1` refuses their edits of the project's
  files). Anything but `0` or `1` refuses the start; `mason start` refuses it.
