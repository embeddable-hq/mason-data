The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **On a Postgres 19 source, a query that compared a `pg_lsn` column with a value gave wrong answers.** Postgres 19
  writes a `pg_lsn` with 8 hex digits after the slash (`0/016B3748`, where 18 wrote `0/16B3748`). So `=` and `IN`
  found no rows, and `<>` returned every row. A `pg_lsn` value written in a query, such as one in a `VALUES` list,
  came back in 18's form. Now, in a query that reads a synced table, a `pg_lsn` value or parameter is compared and
  printed as your database writes it, whichever form you write it in. A Postgres 18 source answers as before. Some
  gaps remain:
  - A `pg_lsn[]` parameter is still read as you send it.
  - A query that reads no table is answered as before, by Mason's own Postgres 18. On Postgres 19, one that would
    print a `pg_lsn` value with fewer than 8 digits after the slash, such as `SELECT '0/1'::pg_lsn`, is refused with
    an error that says how to write it instead. Comparisons, the difference of two values, and values with 8 digits
    after the slash are answered.
  - In a query that reads no table, a `pg_lsn` bound as a parameter, or computed (`'0/1'::pg_lsn + 16`), still prints
    in 18's form when it has fewer than 8 digits after the slash.
  - If you upgrade your database from 18 to 19 in place, restart Mason afterwards. Rows synced before the upgrade
    keep 18's form until they change, and no `mason sync` reads an unchanged row again. To sync every table again
    from the start, run `mason destroy` and then `mason start`.
- **A table synced with `sync: replication` lost the changes made to it while it was renamed on the database.** A row
  inserted, updated or deleted while the table had another name never reached the synced data, even after the table
  was renamed back and Mason restarted. All the while, `mason status` said the stream was current and `mason sync` said
  there was nothing to sync. Now a table renamed on the database, or moved to another schema, is held, as an entry
  Mason cannot take is held (below). Its line in `mason status` says it is not synced and what to do, and it is never
  said to be current. Its synced data serves as it was. Once it is back under its name, Mason catches it up by one
  poll, with every change made meanwhile. Two tables that swap names are each synced again whole as the table of its
  name.
- **A polled table renamed or dropped on the database failed its poll every few seconds** with the engine's error. A
  table renamed during its first sync waited at least 5 minutes after it was renamed back. Now both are held the same
  way, and their sync goes on soon after the table is back under its name.
- **A replicated table renamed on the database stopped the stream for every table** when Mason made its own
  publication. Now the other tables stream on.
- **A table renamed or dropped on the database left `mason status`' list of tables** once Mason read the catalog
  again, so the count read like "3 of 2 added synced". Now it stays on the list, with why it is not synced.
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
- **On Postgres 19, one table with a column of a type new in 19 (`oid8`, `regdatabase` or their arrays) stopped every
  query on every table.** Each statement failed with an error that named an internal engine, and `mason status` and
  `mason wait` still said every table was synced and served. Now that table alone is not served, and the others are.
  `mason status`, `mason wait` and the log name its columns and the line to add: `exclude: [<columns>]` on its entry in
  the sources file. A query of it is told the same. Any other type the source has and Mason cannot serve is handled the
  same way.
