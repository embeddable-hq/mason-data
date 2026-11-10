The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- The web page's Tables no longer offers Add for a table whose row-level security hides every row from the user Mason
  connects as. The page now says why the table cannot be added, in the same words as `mason tables` and `mason add`:
  the policy the table's owner adds, then the `mason add` to run.
- When the database cannot be reached, `mason doctor`'s next step now says where the URL is: the variable the sources
  file names, in `.env`. Before, it said `.mason/config.json`, which does not hold the URL.

- `mason add` now leaves out a column that looks like a secret however its name is written. Before, only lowercase
  snake_case names were recognised, so camelCase, PascalCase, UPPER_SNAKE or kebab-case columns such as `passwordHash`,
  `apiKey`, `accessToken` or `API_TOKEN` were synced by `mason add <table>` with no `exclude:` and no warning, and any
  user who may read the table could read them. The upgrade does not change an entry already in your sources file:
  `exclude:` is written when a table is added. If your tables have such columns, run `mason tables <table>` for each
  table you sync. A column marked "looks like a secret" is synced unless the table's entry lists it under `exclude:`
  or leaves it out of `columns:`. Add it to `exclude:`, or run `mason add <table>` again, which rewrites the entry
  with the column under `exclude:` (the table is then synced again whole).

## What changes

- `MASON_UI_NAV_LINKS` refuses `mason serve`'s start when an entry has a key written twice (`{"label":"a","label":"b",…}`), naming the entry; it was read as its last value. A key a link does not take is named by its place in the entry, never quoted. `mason start` with a `MASON_UI_NAV_*` name that is no setting now says it is not a setting, with a `did you mean`.
- `MASON_PG_PUBLIC_URL` takes a host name with an underscore (a Docker service's name) and one written with its trailing dot, printed as written; it refuses a host label over 63 characters, an IPv4 address with a number over 255, and an IPv6 address with a zone id (`%eth0`), at the start. Beside it, `mason user add` still gives a self-signed listener certificate's SHA-256.

## What was wrong and is now right

- `mason deploy` could fail with `EPIPE … whether the deploy was made is not known` when it sent a deploy again after a refusal naming thousands of tables: reading that refusal took longer than the service's idle timeout, and the deploy was written onto the connection the service had closed meanwhile. Every request to the service now opens a connection of its own.
