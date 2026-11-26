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
- **Mason now sends the server name (SNI) on its TLS connections, as libpq does, so a source behind Neon's proxy, or
  another proxy that routes by SNI, can be synced with the URL the provider gives.** Before, Mason sent the name only
  under `sslmode=verify-full`. Under `sslmode=require`, Neon refused Mason's connections with `Endpoint ID is not
  specified`. Now the name goes out under every sslmode that uses TLS, when the host is a name and not an IP address.
  What Mason checks of the server's certificate is unchanged: only `verify-full` checks that it names the host.
- **A source given by an IP address under `sslmode=verify-full` could not be connected to.** On Node 26, which the
  `mason-data` image runs, every connection failed with `Setting the TLS ServerName to an IP address is not
  permitted`. Mason now sends no server name for an IP address, and still checks that the certificate names it.
