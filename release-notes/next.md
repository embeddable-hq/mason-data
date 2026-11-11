The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

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
