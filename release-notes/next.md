The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## New

- **A Mason user can be limited to the addresses it connects from**: `mason user add looker --from 203.0.113.0/24
  --from 2001:db8:7::/48`, `mason user from looker 198.51.100.0/24` to replace the list, `mason user from looker --any`
  to remove it; `mason user list` shows each user's list (`from` in `--json`, `null` for any address), and `mason user
  … --replica` carries it. A connection from any other address is refused before its password is checked, as Postgres
  refuses one no `pg_hba.conf` line takes (`28000`, `no entry for host "…", user "…"`), and a session held when the list
  changes ends at its next statement if its address is outside it. Behind a TCP proxy the address is the client its
  PROXY header carries (`MASON_PG_PROXY_FROM`). Users without a list connect as before, and `.mason/users.json` files
  written before are read unchanged.

## What changes

- **While any user has an address list, a user name that is no user is refused `28000` with the same words as a wrong
  address**, instead of `28P01`, so a connection from outside cannot tell a user with a list from a name that is no
  user. A user without a list still answers a wrong password `28P01`, so its name can be told apart. A project where no
  user has a list answers as before.
- **A sources file can no longer name one of Mason's own settings** (`${MASON_…}`, such as `${MASON_API_KEY}`) in
  `publication:` or `url:`: it is refused when the file is read, with the way out, and the value is never shown. Before,
  `publication: ${MASON_API_KEY}` printed that key in the log as the publication's name and sent it to the source. If
  you run projects written by someone else (CI, a shared server), this closes that path. `url: ${MASON_DATABASE_URL}`,
  which `mason init` writes, still works.
