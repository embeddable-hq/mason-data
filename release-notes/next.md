The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **The synced data no longer grows without bound on a busy server: Mason compacts a synced table by itself.** Since
  0.17.0 a table kept current by the poll or the stream kept the space of every row it updated or deleted, and every
  table written to between two of the synced data's checkpoints kept a block of at least 256 KiB, so the disk under
  `.mason/` grew and reads slowed. Now Mason reads each synced table's space a minute after it starts and every 10
  minutes after, and when a table's deleted rows and small blocks make up half of its space, it rewrites that table
  from the synced data alone, never reading your database. Measured: a table whose rows are updated over and over (5 %
  of them a round) stays within about 2.5 times the size and the read time of a just-compacted one, where without it
  it kept growing, to 5.4 times its size and 4.6 times its read time after 60 rounds; a table appended to a little at
  every checkpoint stays within about twice its size. **The workaround in 0.17.0's notes (`mason remove`, wait, `mason add`) is no longer needed.**
  - A table is read and served the whole time it is compacted. While it is, its polls wait and a `mason sync` of it
    is refused; a streamed table's changes are written beside it, in the synced data, and applied right after (a
    stop or a crash meanwhile catches the table up by one poll at the next start). It takes about as long as reading the table:
    measured, about 2 s for 6 million narrow rows and 5 s for 650,000 rows of 1 KB on a laptop. One table is
    compacted at a time, and never beside a first sync.
  - It works in the memory `MASON_DUCKDB_MEMORY` gives it, a piece at a time; one that runs out of memory fails
    alone, the table served and kept current as it was, and is tried again later. It starts only with room on disk
    for the rewrite and a margin (a quarter of the table, at least 64 MiB), checked again before each piece; without
    it the table waits and its line says how much room it needs. A table with a column named `rowid` is never
    compacted, and says so.
  - `mason status` and the web page say a table's share of deleted rows from 10 % up, or when it was last compacted,
    that it waits for disk, or that its compaction failed and when it is tried again; `mason status --json` has it under `copy.compaction`,
    and a failure is a `compact_failed` event in `mason logs --events`. The file itself does not shrink: later
    writes reuse the space a compaction gives back.
