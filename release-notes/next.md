The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason share` opens with the URL to paste**: its first line is now `Try mason with your favorite postgres client:
  postgres://<user>:<password>@<host>:<port>/<database>?sslmode=require`, the share's own login and address, so a
  client that takes a connection string connects from that one line. The host, port, database, user and password rows
  below it stay, for a tool that asks for each field, and `mason share --json` carries the same URL as `share.url`.
  The password is still made for this run alone and kept nowhere.

- `mason user add`, beside a `mason start` run on this machine's own address, now ends its tips with the way to a tool
  outside this machine: `mason share` opens an address on the internet, with a login and password of its own (not the
  new user's), for as long as it runs. It is not said beside `mason serve`, nor with `--replica`, nor while Mason is not
  running. `--json` is unchanged.

## What was wrong and is now right

- **A table of large values could fail its first sync under a small `MASON_DUCKDB_MEMORY`**, now and then, with
  `Failed to commit: could not allocate block of size …` in `mason status` and the log, and wait for its retry (at
  least 5 minutes later). When a chunk of the first sync runs out of memory as it commits, it is now rolled back and
  the sync reads on one chunk at a time, smaller, as it already did when the out-of-memory came in other words.

- **A run whose synced data met a fatal error stayed "running" and answered nothing.** When a write to the synced data
  fails in a way it cannot recover from inside the run (a checkpoint on a full disk, an I/O error), every statement
  was refused with `XX000 … database has been invalidated`, `mason status` still said `running`, the request log
  stopped, and nothing restarted it. Now the run ends as a crash does, with the cause and the way out in its log:
  sessions are told `57P02` and to reconnect, `mason start`'s supervisor starts it again (`mason status` shows the
  restart and its reason), and `mason serve` exits 1, `/healthz` saying `failed` until it does, for the platform to
  start it again. Starting again opens the synced data again; nothing synced is lost. When the restart meets the same
  cause (the disk still full), the supervisor says it is the same as the last restart, and gives up after five restarts in
  ten minutes as for any crash; a full disk that stops the synced data from opening is said as the disk's, never with
  `mason destroy` as the way out.
