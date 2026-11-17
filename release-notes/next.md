The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

- **A hosted agent (claude.ai, ChatGPT, a team's agent platform) can query `mason serve` over MCP.** Set
  `MASON_MCP_URL` (the address the agent reaches, through your relay), `MASON_MCP_ISSUER` and `MASON_MCP_JWKS_URL` (your
  OAuth authorization server and its signing keys): `/mcp` on the health port then serves the same tools as `mason mcp`
  (MCP revision 2025-11-25, and 2026-07-28 as published), each request as the `mason user` its token names by name and id
  (`MASON_MCP_USER_CLAIM`, `MASON_MCP_USER_ID_CLAIM`), looked up every time. A user's address ranges still apply, on the
  peer's address or — from a relay `MASON_MCP_PROXY_FROM` names — the last `X-Forwarded-For` entry it appended; the Users
  page offers Claude's and ChatGPT's published ranges as a choice (a user now takes up to 1,000 ranges). Off loopback,
  `MASON_MCP_PLAIN=1` says TLS is terminated in front. The health port now takes a request's headers within 10 s and its
  body within 30 s, closes idle connections after 5 s and holds at most 1,024 connections. A person adds the endpoint by
  pasting only its URL; a desktop app (Claude Code, Cursor) connects from their own computer, so its user needs that
  address, or anywhere. If the issuer's keys cannot be fetched for more than 5 minutes, every request is 503 until they
  can: check that `MASON_MCP_JWKS_URL` is reachable from the replica.
  Nothing changes until you set them (docs/POSTGRES-API.md "From a hosted agent: MCP over HTTPS").
