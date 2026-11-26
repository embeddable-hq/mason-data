The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **On a Postgres 19 source, a query that compared a `pg_lsn` column with a value gave wrong answers.** Postgres 19
  writes a `pg_lsn` with 8 hex digits after the slash (`0/016B3748`, where 18 wrote `0/16B3748`). So `=` and `IN`
  found no rows, and `<>` returned every row. A `pg_lsn` value written in a query, such as one in a `VALUES` list,
  came back in 18's form. Now Mason compares and prints a `pg_lsn` as the source writes it, in either spelling. A
  Postgres 18 source answers as before.
- **A mistake in one table's entry no longer stops Mason keeping the other tables current.** Before, if a column that a
  `columns:` entry lists was renamed on your database, Mason stopped taking the sources file while it ran. From then on,
  a column added to any other table was never synced, and a renamed column elsewhere made that table's polls fail, until
  a restart. Now only the table whose entry is wrong is held. It keeps serving the data it holds, and never syncs the
  renamed column under its new name until your file says so. Its line in `mason status` and on the web page says why,
  and gives the line to write. `mason add <table> --columns …` while Mason runs takes the fixed entry at once. A fix
  made by hand is taken the next time Mason reads the file: at `mason stop && mason start`, at a `mason add` or
  `mason remove`, or when a table's columns change on your database. Mason also checks a held table on your database
  again: a polled one at its poll interval, and a replicated one every minute. A `sync: off` one is checked when you
  run `mason sync <table>`. If the problem is gone there, such as a column renamed back or a unique index a `key:`
  needs restored, the table is synced again. Every other table is kept current as before.
  - A new entry whose table's name differs only in case from a synced table's, such as `Accents` beside `accents`, is
    never synced while Mason runs, wherever you write it in the file. The synced table keeps syncing. The new entry's
    warning says to remove one of the two entries.
  - The warning for a sources file Mason cannot read while it runs said "mason start reads the file again". It now says
    to run `mason stop && mason start`, since `mason start` alone only says Mason is already running.
- **Mason now sends the server name (SNI) on its TLS connections, as libpq does, so a source behind Neon's proxy, or
  another proxy that routes by SNI, can be synced with the URL the provider gives.** Before, Mason sent the name only
  under `sslmode=verify-full`. Under `sslmode=require`, Neon refused Mason's connections with `Endpoint ID is not
  specified`. Now the name goes out under every sslmode that uses TLS, when the host is a name and not an IP address.
  What Mason checks of the server's certificate is unchanged: only `verify-full` checks that it names the host.
- **A source given by an IP address under `sslmode=verify-full` could not be connected to.** On Node 26, which the
  `mason-data` image runs, every connection failed with `Setting the TLS ServerName to an IP address is not
  permitted`. Mason now sends no server name for an IP address, and still checks that the certificate names it.
