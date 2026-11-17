The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

- **A hosted agent (claude.ai, ChatGPT, a team's agent platform) can query `mason serve` over MCP.** Set
  `MASON_MCP_URL` (the address the agent reaches, through your relay), `MASON_MCP_ISSUER` and `MASON_MCP_JWKS_URL` (your
  OAuth authorization server and its signing keys): `/mcp` on the health port then serves the same tools as `mason mcp`
  (MCP revisions 2025-11-25 and 2026-07-28), each request as the `mason user` its token names by name and id
  (`MASON_MCP_USER_CLAIM`, `MASON_MCP_USER_ID_CLAIM`), looked up every time. A user's address ranges still apply, on the
  peer's address or — from a relay `MASON_MCP_PROXY_FROM` names — the last `X-Forwarded-For` entry it appended; the Users
  page offers Claude's and ChatGPT's published ranges as a choice (a user now takes up to 1,000 ranges). Off loopback,
  `MASON_MCP_PLAIN=1` says TLS is terminated in front. The health port now takes a request's headers within 10 s and its
  body within 30 s, closes idle connections after 5 s and holds at most 1,024 connections.
  Nothing changes until you set them (docs/POSTGRES-API.md "From a hosted agent: MCP over HTTPS").
- **`mason user check <name>` says whether a password is a user's**, for a sign-in page of your own in front of Mason:
  the password on stdin, the answer `ok`, `wrong`, `disabled` or `removed` with the user's id (`--json`), exit 0, 3,
  4 or 5. It never judges the address. A page in front of it must limit attempts — by the browser's address, by
  replica and by user name — since it answers `wrong` as often as it is asked. `mason user list` already shows each
  user's id; a name still bound to the same id is the same user (one removed and added again has a new id).
