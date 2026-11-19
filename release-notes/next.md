The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **A group by over a join can work out a smaller table's value once for each of its rows.** In revenue by order month
  and customer signup year, the signup year was worked out once for each order. Now it is worked out once for each
  customer, before the join. On 50 M orders and 2.5 M customers, that query went from 660 ms to 283 ms in
  `Asia/Kathmandu`, and from 383 ms to 331 ms in UTC. The answers are the same.
  - It applies when the smaller table holds at most half the rows of the largest other table in the join, by the rows
    Mason synced. Every table in the join must be a synced table. No filter may limit the other tables. A filter on
    the smaller table itself is fine.
  - It applies only to a value that reads the smaller table alone, can never fail, and is not random. Examples are a
    time cut to its month, year or other unit (`date_trunc`), a time's date (`::date`), a number compared with a
    constant, `IS NULL`, `IN` a list of constants, and a `CASE` or `COALESCE` of these. `lower()` of a text applies
    too, in a database whose locale is a libc one, such as `en_US.UTF-8`.
  - On the side of an outer join that can have no matching row, the value must be NULL where its columns are. So a
    `COALESCE` there is worked out after the join.
  - Anything else is worked out after the join, as before. That includes `upper()`, `extract()`, `date_part()`,
    arithmetic on a number, and `lower()` under a C or ICU locale.
