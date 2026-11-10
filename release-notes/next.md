The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- `mason add` now leaves out a column that looks like a secret however its name is written. Before, only lowercase
  snake_case names were recognised, so camelCase, PascalCase, UPPER_SNAKE or kebab-case columns such as `passwordHash`,
  `apiKey`, `accessToken` or `API_TOKEN` were synced by `mason add <table>` with no `exclude:` and no warning, and any
  user who may read the table could read them. The upgrade does not change an entry already in your sources file:
  `exclude:` is written when a table is added. If your tables have such columns, run `mason tables <table>` for each
  table you sync. A column marked "looks like a secret" is synced unless the table's entry lists it under `exclude:`
  or leaves it out of `columns:`. Add it to `exclude:`, or run `mason add <table>` again, which rewrites the entry
  with the column under `exclude:` (the table is then synced again whole).

## What changes

- `MASON_PG_PUBLIC_URL` takes a host name with an underscore (a Docker service's name) and one written with its trailing dot, printed as written; it refuses a host label over 63 characters, an IPv4 address with a number over 255, and an IPv6 address with a zone id (`%eth0`), at the start. Beside it, `mason user add` still gives a self-signed listener certificate's SHA-256.
