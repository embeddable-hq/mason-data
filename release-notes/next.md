The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mode() WITHIN GROUP (ORDER BY …)` of a text is faster on a database whose collation is a libc locale**, such as
  `en_US.utf8`. Over a million rows, the most common status per tenant took 2.2 s and now takes under 0.1 s, about a
  fifth of Postgres's time. The answer is the same, ties included. A `mode()` with a `FILTER`, or of a `char(n)`, is
  still slow.
