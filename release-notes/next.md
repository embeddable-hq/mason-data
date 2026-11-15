The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What changes

- **The web page links to how to change a deployed project.** When a deployed project's Tables page says it is
  read-only, its link now goes to the README's new "Change a deployed project" section. A host that runs Mason for
  others can link to its own steps instead. Set `MASON_UI_DEPLOY_DOCS_URL` on `mason serve` to a path on the page's
  host or an `https://` or `http://` URL. It follows `MASON_UI_BACK_URL`'s rules. A value Mason cannot use stops the
  start with a message that says what is wrong.

## What was wrong and is now right

- **A numeric column of a subquery whose name has a space in it now keeps its exact value.** Metabase names a JSON
  field it unfolds `"meta → n"`, and a custom column can be `"Unit Price"`. When the outer query read such a column, Mason
  could print the subquery's numeric with the wrong digits. `1000000000.00` came back as `1000000000`, and `x / 3` had
  15 digits where Postgres gives 20. Whether a query was hit depended on its length, so a small edit could hide it. Now
  every such name is read exactly, one with a no-break space, quotes or backslashes included.
- **A name with a line break is now refused by name.** Such a name could be read as another name, and a query could
  then read the wrong column. It might be an alias, a table's name, or a column of a table, a view or a row type. Now a
  query that reads one is refused with the name (`name-line-break`). Give the column an alias without a line break. A
  role's row filter on such a table still applies, and the role's other queries are answered.
- **A table rewritten on your database while Mason read it is no longer served empty or partial.** A rewrite is a
  `TRUNCATE`, `VACUUM FULL`, `CLUSTER`, an `ALTER TABLE` that rewrites the table (such as a column's type change), or
  a tool that swaps its file, such as pg_repack. Before, a first sync or a table synced again whole could read none of
  the table's rows, and serve them as 0 rows until its catch-up a few seconds later. A poll could also delete every row
  until the next poll. Now Mason keeps serving the table's previous data. A sync that meets a rewrite starts again at
  once. A poll that meets one writes nothing, and the next poll reads the table again. A rewrite after a transaction
  that is still open on your database began is different. No read can see the table's rows until that transaction
  ends. So Mason waits for it and checks again every 30 seconds. The table's line in `mason status` says so, with the
  transaction's pid. A `VACUUM FULL` or `CLUSTER` keeps each row as it was, so its sync goes on at once.
