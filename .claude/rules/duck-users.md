---
paths:
  - "src/duck/token.ts"
  - "src/duck/users.ts"
  - "tests/duck-roles-*.test.ts"
  - "tests/duck-users-wire.test.ts"
  - "tests/duck-users.test.ts"
---

<!-- Loaded only when a matching file is read or edited (the paths above). CLAUDE.md lists every rules file. -->

## Users (`mason user`, src/duck/users.ts)

- **A user's password is `mason_<id>_<mac>`, the MAC over its NAME and id keyed by the API key** (the
  server plan's item 1): the startup packet's user name must be the user's (28P01 with the reason otherwise), so every
  statement is attributed (`user_name` in `_mason.requests`); rotating the API key removes every user. A password of
  another shape is a token's, read as before (`listenerLogins`, the one wiring the run and the tests use).
  ("On a server")
- **A user's `role` is a field of its row** (`MasonUser.role`, `mason user add --role`; the roles file is `src/cli/roles.ts`,
  its enforcement `.claude/rules/postgres-api.md`), read with the user before every statement, so a role given or taken
  applies at the next statement.
- **The live users are a FILE, `.mason/users.json`, never DuckDB** (`mason user` runs beside the process holding
  DuckDB's file lock): no secret in it; changed under a lock file and renamed into place; the listener stats it at every
  connection and before EVERY statement of a user's session (`recheckMs: 0`), so a removal takes effect without a
  restart. Fail closed: a file that cannot be read refuses every user (57P03), never "live"; no file is no users.
- **A removed user is KEPT in the file with `removedAt`** (the list shows Active / Removed): only entries without one are live,
  and the listener (`LiveUsers`) reads only those, so a removal refuses as before; a removed name can be added again (a new
  id); `mason user list` gives each user `lastUsedAt` (`RequestLedger.lastUsed`, within the user's own window) and its URL
  without the password (`connectionUrl`, the one builder).
- **A disabled user is KEPT with `disabledAt` and its id** (`mason user disable`): `LiveUsers` still holds it, so its
  login is judged whole first — a wrong password stays 28P01 — and only then refused `user_disabled` (the listener's
  28000); its sessions end at their next statement; `enable` deletes the field, so the same password connects again.

## What review probes

Run each probe that applies before a push; the harness's Learn step adds to this list.

- A share's password on the run's port, a user's password or a token on a share, a share whose role the roles file changes while it is open: a refusal that names what it was given and its way out (PR 142; issue 91).
