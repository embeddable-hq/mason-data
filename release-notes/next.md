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
  `(tenant_id, customer_id): customers (tenant_id, id)`. A join on one reads less (the next item).
  - `mason add` writes the foreign keys your database declares between tables the file syncs. When you add the table a
    foreign key points to, it writes that key on the table that holds it. It says each foreign key it left out, and why.
  - `mason remove` takes the references to a removed table out of the other entries, and says so.
  - `mason add`, `mason remove` and the `exclude:` Mason writes for a new secret-looking column now change only the
    lines they must, and keep every comment in the sources file. Before, adding a table again with other columns, or
    giving a sync to a table written as `{ … }`, wrote its entry again and lost its comments.
  - A reference to a table the file doesn't sync, or to a column it doesn't sync, stops `mason start` with the file, the
    key and the way out. `mason tables --json` shows each table's references in its `entry`.
- **A join on a reference reads small numbers in place of its key.** For each reference in the sources file whose key
  is a UUID, a text, several columns, or a sparse integer, Mason gives each key value a number. It stores the number in
  a hidden column of both tables. A query that joins the two tables on the reference's columns joins on the numbers.
  The answers are the same.
  - On a benchmark of 100 M orders and 5 M customers, the orders' key column a join reads went from 1.60 GiB to
    0.31 GiB for a UUID key, and from 1.20 GiB to 0.31 GiB for a text key. On a laptop, a join on a text key went from
    1.42 s to 0.83 s. A join on a UUID key read from disk went from about 1.1 s to 0.85 s. On a slower disk, such as a
    cloud volume, the saving is larger: a query reads up to 1.3 GiB less.
  - The synced data grows. The hidden columns took about 310 MiB for each reference on the 100 M orders, so the synced
    data went from 4.04 GiB to 5.19 GiB with three references. Its first sync took 53 s instead of 41 s.
  - A dense integer key, such as a serial, gets no number. The key is already as small.
  - The upgrade syncs no table again. Mason numbers the tables it has synced in the background, a part at a time.
    Until a table is numbered, a join on it reads the keys, as before.
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
- **`mason login` and `mason logout` name the hosted service Mason Cloud** in their help, with its address
  (https://app.masondata.ai) and `MASON_CLOUD_URL` for another service. What they do is unchanged.

## What was wrong and is now right

- **The web page's Users list cut "not used in the last 7 days" short, with no way to read it.** Its Last used column
  is narrower than those words. Now a hover shows them whole, as it does for every other value a list cuts.
