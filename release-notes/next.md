The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A whole row of a table an outer join leaves unmatched is now NULL, as in Postgres.** In `a LEFT JOIN b`, a row of
  `a` with no match read `row_to_json(b)` as `{"id":null,…}` and `b::text` as `(,)`. Both are now NULL. So are
  `to_json(b)`, `to_jsonb(b)`, `b` itself, and the element `json_agg(b)` adds. It holds for a RIGHT and a FULL JOIN, a
  nested join, and a subquery or a WITH query that selects its table's primary key, a count or a constant. A subquery
  whose every column may be NULL in a matched row is now refused by name, since Mason cannot tell its unmatched rows.
  Select its primary key too, or name its columns. Such a subquery is still answered where no row can be left
  unmatched, as Postgres decides it. That is a WHERE or an inner join above that is never true for an unmatched row,
  such as `WHERE d.v = 'x' OR d.v = 'y'` or `JOIN o ON o.id = d.a_id`. It is also a subquery that gives one row and is
  joined `ON true`.
- **The whole row of a subquery that names two columns alike now reads each column.** In
  `(SELECT v AS id, a_id, id FROM d) x`, `x::text` and `row_to_json(x)` read the first `id` twice. Now each column
  reads its own value, as in Postgres.
- **Two subqueries with the same name in one query no longer break each other.** This covers a subquery that names
  two columns alike, or two in different case, such as `"T"` and `t`. Another subquery with its name, in a `UNION ALL`
  arm or an `EXISTS`, failed with 42703 or 42804. Now each reads its own columns.
