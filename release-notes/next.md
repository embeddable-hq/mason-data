The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **In UTC, a group by a time's hour, day, week, month, quarter or year is faster on a large table.** Mason already
  grouped such a query by a stored 15-minute number in other time zones. Now it does so in UTC too, for a table of
  10 M rows or more. The answers are the same. On 30 M orders over two years:
  - Revenue by month, joined to customers, went from 226 ms to 166 ms, and from 1.8 to 1.4 CPU-seconds.
  - Orders by month went from 78 ms to 44 ms, and by day from 63 ms to 44 ms.
  - With ten clients at once, revenue by month went from 2.3 s to 1.8 s, and orders by month from 0.80 s to 0.39 s.
  - A table of fewer rows keeps the plan it had, which is faster there. Mason counts a table's rows when it syncs it.
- **A group by over a join can work out a smaller table's value once for each of its rows.** In revenue by order month
  and customer signup year, the signup year was worked out once for each order. Now it is worked out once for each
  customer, before the join. On 50 M orders and 2.5 M customers, that query went from 660 ms to 283 ms in
  `Asia/Kathmandu`, and from 383 ms to 331 ms in UTC. The answers are the same.
  - It applies when the smaller table holds at most half the rows of the largest other table in the join, by the rows
    Mason synced. Every table in the join must be a synced table. No filter may limit the other tables. A filter on
    the smaller table itself is fine.
  - It applies only to a value that reads the smaller table alone, can never fail, and is not random. Examples are a
    time cut to its month, year or other unit (`date_trunc`), a time's date (`::date`), `date_part()` of a time's
    month, day, hour or most other parts, a number compared with a constant, `IS NULL`, `IN` a list of constants,
    and a `CASE` or `COALESCE` of these with plain number or text constants.
    `lower()` of a text applies too, where its collation is a libc one other than C, such as `en_US.UTF-8`.
  - On the side of an outer join that can have no matching row, the value must be NULL where its columns are. So a
    `COALESCE` there is worked out after the join.
  - Anything else is worked out after the join, as before. That includes `upper()`, `extract()`, arithmetic on a
    number, and `lower()` under a C or ICU collation. It includes `date_part()` of a year or a longer unit, an epoch,
    a Julian day, a second or a millisecond.

## What was wrong and is now right

- **A date or time unit could answer differently under another of its spellings.** Postgres reads a unit by any of
  its spellings. For example, `second`, `seconds`, `sec`, `secs` and `s` are one unit. Mason now reads every spelling
  Postgres reads, in `date_part()`, `extract()` and `date_trunc()`, and answers as for the unit's usual name. These
  answered wrong before:
  - `date_part('seconds', t)`, `'sec'` and `'s'` dropped the fraction of a second: 59 where Postgres answers
    59.999999. `date_part('ms', t)` and the other spellings of a millisecond dropped it too. So did `extract()`.
  - `date_part('y', t)` of an infinite time was NULL where Postgres answers Infinity. The same held for other
    spellings of a year, a decade, a century and a millennium.
  - `date_part('hour', d)` of a date was refused, where Postgres answers 0. So were a minute, a second, a millisecond
    and a microsecond.
  - `extract(h FROM d)` of a date answered 0, where Postgres refuses it.
  - `date_trunc('weeks', i)` of an interval answered, where Postgres refuses it.
  - Spellings such as `qtr`, `mm`, `timezone_h` and `extract('dec' FROM t)` were refused, where Postgres
    answers. Each spelling Postgres does not take is refused with Postgres's own error.
  - `extract(julian FROM d)` of a date was refused. Its spelling `jd` answered, but a filter on it dropped an
    infinite date that Postgres keeps. Now it answers Postgres's whole Julian day under every spelling. Of an
    infinite date it is refused, as `extract(year FROM d)` is. Of a timestamp it is still refused.
