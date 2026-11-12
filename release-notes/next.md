The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Every example in a box on the web page now starts with "e.g."**: the Tables and Queries search boxes say
  `e.g. orders`, Queries' since `e.g. 2h`, and a new user's name and where it connects from `e.g. metabase` and
  `e.g. 192.0.2.0/24, 2001:db8::/32`, so an example is never taken for a value already filled in.

## What was wrong and is now right

- **A generated table over a `citext` or enum column could be given the wrong type, and its statements refused.**
  Mason named such a column's type by the number your database gives the type, read in Mason's own catalog, where the
  same number can be another type: a synced table's row type. The generated table's column was then declared as that
  row type, and a statement Postgres answers, such as `SELECT id, name FROM kinds WHERE name = 'ALICE'`, was refused
  with `0A000 input of anonymous composite types is not implemented`. Whether it happened depended on your database's
  type numbers, so it could appear after any restart. The column is now always declared as your database's type
  (`citext`, the enum's name), and the table is built again at the next start.
