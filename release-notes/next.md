The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

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
