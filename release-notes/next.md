The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason doctor`'s warnings about the user Mason connects as end "Mason never writes, but a role that can only read
  is safer"**, and its `--json` gives each warning's parts apart, so a program can show the facts and the SQL and give
  its own next step: `detail` is now the facts alone (the sentence it ended with moved to a new key, `why`; the SECURITY
  DEFINER listing's "We recommend reviewing each…" too), and beside `fix`, unchanged, `fixSql` is the SQL to run on the
  primary and `fixThen` the steps after it. On a terminal the lines read as before but for the new sentence.
- **A process beside `mason serve` can rely on the table list and on adding and removing tables.** `GET /api/state`
  (its `tables`), `GET /api/tables/<table>/columns`, `POST /api/pick` and `POST /api/remove`, reached over
  `MASON_UI_SOCKET` with the token from `MASON_UI_RUN_FILE`, are now a documented contract: their bodies, answers and
  refusals keep their shape within a release line (docs/WEB-UI.md "An operator's table edits"). `MASON_UI_READ_ONLY=1`
  refuses the page's edits, never a request with the run's token. Nothing about them changed.

## What was wrong and is now right

- **A refused connection over TLS is told why.** Behind a TCP proxy over TLS, a refused connection (a wrong password,
  a protocol error) sometimes saw "connection closed unexpectedly" instead of the refusal, and a client that sent its
  statements and Terminate together sometimes lost the last answers: Mason closed the connection before what it had
  just sent had left. It now closes once that has left, and a client that reads nothing holds the connection five
  seconds at most.
- **A tunnel client is gone before `mason share` says nothing was left open.** When the tunnel gave no address in
  the time given, or Mason stopped under a share, `mason share` sent its client SIGTERM and exited at once, so a
  client that ignored SIGTERM kept running after it. The client is now waited for, and killed if it is still there
  2 seconds later.
- **A first sync whose chunk ran out of memory now goes on with one reader at once.** It promised to, but while the
  chunk that ran out was rolled back, another reader could take a new chunk of full size beside it, at the moment memory
  was shortest; a test saw it in about 1 run in 25. No rows were lost or read twice: the range that ran out was read
  again, by smaller chunks.
