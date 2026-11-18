The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Heavy queries take turns, so many at once no longer spill to disk.** A heavy query keeps many rows in memory: a
  join of two large tables, or a group by, distinct or sort that keeps many rows. A few heavy queries run at
  once, and the rest wait their turn. Before, ten clients that each sent a join of 100 M orders to 5 M customers at once
  took 11 minutes. Together the joins did not fit in memory, so Mason wrote 48.7 GB to disk and read most of it back.
  Four at a time took about 40 s.
  - A light query never waits. A lookup by key, a filter, a count and a group by into a few groups are light, however
    many rows they read.
  - By default one heavy query runs for each GiB of `MASON_DUCKDB_MEMORY`, at most one for each CPU and at least one.
    `MASON_HEAVY_QUERIES` sets the number. `mason start` and `mason serve` say it as they start.
  - A query can be cancelled while it waits. Its `statement_timeout` counts the wait. Either ends it with SQLSTATE
    57014, as Postgres does.
  - The request log has a new column, `waited_ms`: how long a heavy query waited for its turn. It is empty for a
    light query. `mason logs --requests --id <request>` shows it.
- **The sources file says how tables join: `references:`.** Each table's entry can list its foreign keys, on the table
  that holds them: `customer_id: customers.id`. A foreign key of several columns is written as in SQL:
  `(tenant_id, customer_id): customers (tenant_id, id)`. Queries don't use them yet.
  - `mason add` writes the foreign keys your database declares between tables the file syncs. When you add the table a
    foreign key points to, it writes that key on the table that holds it. It says each foreign key it left out, and why.
  - `mason remove` takes the references to a removed table out of the other entries, and says so.
  - `mason add`, `mason remove` and the `exclude:` Mason writes for a new secret-looking column now change only the
    lines they must, and keep every comment in the sources file. Before, adding a table again with other columns, or
    giving a sync to a table written as `{ … }`, wrote its entry again and lost its comments.
  - A reference to a table the file doesn't sync, or to a column it doesn't sync, stops `mason start` with the file, the
    key and the way out. `mason tables --json` shows each table's references in its `entry`.
- **Short text columns are stored many times smaller, so a dashboard that groups or filters on them reads less.** When
  Mason syncs a table, it now chooses how to compress each text column from a sample of its values. A column of short
  or repeated values, such as a status, a type, a country code or a name, is stored with a dictionary. Values of 64 bytes
  or more that do not repeat, such as JSON documents, are stored as before. On a benchmark of 100 M orders, a status column of six
  values went from 645 MB to 41 MB. On the README's cold benchmark at that size, a count by status with one client went
  from 4.03 s to 0.45 s, and the synced data went from 8.29 GiB to 7.11 GiB. The answers are the same.
  - The upgrade reads no table again. A table synced before keeps how it is stored until it is synced again whole, or
    until Mason compacts it. Mason compacts a table by itself once much of its space is deleted rows.
  - To apply it to a table now, sync it again whole. With Mason running, run `mason remove <table>`. Wait until
    `mason logs` shows `dropped <table>'s synced data`, then run `mason add <table>`. The table is not served in
    between.
  - Generated tables are stored as before.
- **A lookup by a random key reads a few megabytes, not the whole key column.** A synced table has no index. Before,
  `WHERE id = $1` on a table keyed by a random UUID read every value of its key. One order of 100 M took 13 s on the
  README's cold benchmark. Now Mason keeps a sorted list of such a table's keys beside it, and a lookup by key reads
  that list. Measured at 100 M rows, a lookup read 2 MiB of the synced data where it read 1.6 GiB.
  - Mason chooses the tables by how scattered their keys are, not by the key's type. A table whose keys arrive in order
    needs no list. A serial key that heavy updates have scattered gets one.
  - The list costs disk: about 19 bytes a row for a UUID key (1.8 GiB at 100 M rows). It is made after a table's first
    sync, in the background. At 100 M rows that took about 9 s. Lookups read the table as before until it is ready.
  - It is sorted again once 1 % of the table's rows were written since. Queries are answered meanwhile.
  - It applies to `WHERE key = …` and `WHERE key IN (…)` on one table, with a key of one column.
- **`mason login` and `mason logout` name the hosted service Mason Cloud** in their help, with its address
  (https://app.masondata.ai) and `MASON_CLOUD_URL` for another service. What they do is unchanged.

## What was wrong and is now right

- **The web page's Users list cut "not used in the last 7 days" short, with no way to read it.** Its Last used column
  is narrower than those words. Now a hover shows them whole, as it does for every other value a list cuts.
- **A first sync could fail with `Duplicate key "source: <table>, first_page: <n>"` after it ran out of memory.** It
  happened when the synced data reported running out of memory as a part of the table was saved, though that part
  was saved. Mason then read that part again and stopped there. The table was not synced at that pass, and was only
  tried again later. Now Mason checks its own record of what was saved, and goes on. No row was lost or doubled.
