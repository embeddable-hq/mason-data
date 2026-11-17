The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

- **A hosted agent (claude.ai, ChatGPT, a team's agent platform) can query `mason serve` over MCP.** Set
  `MASON_MCP_URL` (the address the agent reaches, through your relay or proxy) and `MASON_MCP_ISSUER` (your OAuth
  authorization server): `/mcp` on the health port then serves the same tools as `mason mcp`, each request as the
  `mason user` its token names (`MASON_MCP_USER_CLAIM`, default `sub`). A user's address ranges are judged on the
  agent's address unless `MASON_MCP_FROM=token`; off loopback, `MASON_MCP_PLAIN=1` says TLS is terminated in front.
  Nothing changes until you set them (docs/POSTGRES-API.md "From a hosted agent: MCP over HTTPS").
