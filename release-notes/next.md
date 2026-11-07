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
- **A supervisor on the same machine can find the page's port and the run's token: set `MASON_UI_RUN_FILE`** (for
  example `/mason/data/.mason/run.json`). Once Mason answers, `mason serve` writes `{ "port", "token" }` there, and
  nothing else, to open a tunnel to the page without reading `.mason/config.json`. The token grants the `mason`
  commands' writes as well as a tunnel, so the file is held to the socket's bar: mode 0600, in a folder only Mason's
  user can write (else the start is refused, saying why), written whole, never through a link or over a file that is not
  a stale one of Mason's own, and removed on exit. Unset, nothing changes; `mason start` refuses it.
- **`/healthz` says how the web page is served, while Mason starts too**: `page: { socket, readOnly }` (the socket's
  path or `null`, and whether `MASON_UI_READ_ONLY=1`), so a supervisor can tell a Mason without a socket from one still
  starting. `mason status --json` says `pageSocket` beside `pageReadOnly`. The keys they had are unchanged.
- **`HEAD` on the web page's and the API's routes answers as `GET` does**, without the body, where it answered 404.
