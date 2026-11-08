The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason doctor`'s warnings about the user Mason connects as end "Mason never writes, but a role that can only read
  is safer"**, and its `--json` gives each warning's parts apart, so a program can show the facts and the SQL and give
  its own next step: `detail` is now the facts alone (the sentence it ended with moved to a new key, `why`; the SECURITY
  DEFINER listing's "We recommend reviewing each…" too), and beside `fix`, unchanged, `fixSql` is the SQL to run on the
  primary and `fixThen` the steps after it. On a terminal the lines read as before but for the new sentence.
