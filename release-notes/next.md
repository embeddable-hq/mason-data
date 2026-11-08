The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason doctor`'s warnings about the user Mason connects as end "Mason never writes, but a role that can only read
  is safer"**, and its `--json` gives each warning's parts apart, so a program can show the facts and the SQL and give
  its own next step: `detail` is now the facts alone (the sentence it ended with moved to a new key, `why`; the SECURITY
  DEFINER listing's "We recommend reviewing each…" too), and beside `fix`, unchanged, `fixSql` is the SQL to run on the
  primary and `fixThen` the steps after it. On a terminal the lines read as before but for the new sentence.

- **`mason replica upgrade <org>/<name>` moves a hosted replica to the newest Mason its service offers**, asking for
  the name to be typed back at a terminal (`--yes` elsewhere), since Mason on it restarts and its connections drop; it
  waits for the upgrade within `--timeout`. A newer release line is installed beside the one the replica runs, and
  starts with the first deploy of a project pinned to it. `mason replica status` shows the Mason a replica runs, the
  newest offered and one installed (`replica.mason` in `--json`), where the service says them.
- **`mason deploy` refuses, before it sends, a project the replica would not run**: when the service says the
  replica's Mason and the `mason.yml` pin fits neither the version it runs nor one installed, it names both and the
  ways out (write the project for the replica's version, or `mason replica upgrade`). A service that does not say the
  version, or an answer this version cannot read, leaves the check to the replica, as before.

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
