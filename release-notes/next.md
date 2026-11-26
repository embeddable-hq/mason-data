The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A whole row of a table an outer join leaves unmatched is now NULL, as in Postgres.** In `a LEFT JOIN b`, a row of
  `a` with no match read `row_to_json(b)` as `{"id":null,…}` and `b::text` as `(,)`. Both are now NULL. So are
  `to_json(b)`, `to_jsonb(b)`, `b` itself, and the element `json_agg(b)` adds. It holds for a RIGHT and a FULL JOIN, a
  nested join, and a subquery or a WITH query that selects its table's primary key, a count or a constant. A subquery
  whose every column may be NULL in a matched row is now refused by name, since Mason cannot tell its unmatched rows.
  Select its primary key too, or name its columns. Such a subquery is still answered where no row can be left
  unmatched, as Postgres decides it. That is a WHERE or an inner join above that is never true for an unmatched row,
  such as `WHERE d.v = 'x' OR d.v = 'y'`, `JOIN o ON o.id = d.a_id` or `WHERE EXISTS (…)`. A subquery that gives one
  row is answered too when it is joined `ON true`. It is also answered in a LEFT or RIGHT JOIN on a condition that reads
  none of its columns and calls no volatile function such as `random()`, for example `ON a.id = 1`. In a FULL JOIN on
  any other condition, it is refused by name.
- **The whole row of a subquery that names two columns alike now reads each column.** In
  `(SELECT v AS id, a_id, id FROM d) x`, `x::text` and `row_to_json(x)` read the first `id` twice. Now each column
  reads its own value, as in Postgres.
- **Two subqueries with the same name in one query no longer break each other.** This covers a subquery that names
  two columns alike, or two in different case, such as `"T"` and `t`. Another subquery with its name, in a `UNION ALL`
  arm or an `EXISTS`, failed with 42703 or 42804. Now each reads its own columns.
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
