The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A numeric column of a subquery whose name has a space in it now keeps its exact value.** Metabase names a JSON
  field it unfolds `"meta → n"`, and a custom column can be `"Unit Price"`. When the outer query read such a column, Mason
  could print the subquery's numeric with the wrong digits. `1000000000.00` came back as `1000000000`, and `x / 3` had
  15 digits where Postgres gives 20. Whether a query was hit depended on its length, so a small edit could hide it. Now
  every such name is read exactly, one with a line break or a no-break space in it included.
