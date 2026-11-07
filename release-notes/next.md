The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The web page works behind a reverse proxy at any path**, such as `https://example.com/tools/mason/`, with no
  setting: it asks for every file and every answer relative to its own address, and the first visit's redirect (the
  token traded for the cookie) lands back on that address, never the proxy's root. Serve it at an address that ends
  in `/`; the run still checks every request for its own Host and every change for its own Origin, so the proxy sends
  those. `mason ui` opens it at `/` as before.
