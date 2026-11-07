The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **A script that reads the exit code of `mason share` or `mason ui --ssh` sees 124, not 1, when the tunnel gives no
  address or the server does not answer within `--timeout`** (as `mason wait`, `mason deploy`, `mason replica create`
  and `mason login` already exit when they run out of time). Every other failure of both still exits 1.

- **`mason replica create` no longer reads the database's URL from `.env`, `.env.local` or the shell.** On a terminal
  it asks for the URL and reads it without showing it; otherwise it reads it from stdin. A script that relied on
  `DATABASE_URL` being set pipes it instead: `printf '%s\n' "$DATABASE_URL" | mason replica create acme/shop --region
  <region> --size 50`, or `... < url.txt`, or from your secret store's command. With nothing on stdin it now stops,
  sending nothing. The sources file still names the variable (`url: ${DATABASE_URL}`): the replica reads the URL by
  that name.

## What changes

- **A database URL on `mason replica`'s command line is refused** (exit 2), never repeated, with the line to run
  instead: a command line is kept in shell history and shown to every process on the machine, so if it held a real
  password, change it.
- **`mason replica create` prints the replica's page**, where its allowlist (the addresses that may query it) is set,
  and `--json` gives it as `replica.page` (`null` when the service names none); `mason replica status` prints it too.

- **Every `--timeout`, and `mason usage --step`, takes one form of duration**: a bare number is seconds, as before for
  `wait`, `share` and `ui --ssh`, and `30s`, `10m`, `1h` or `1d` (`5 minutes`, `2 days` too). So `mason wait --timeout 10m`
  and `mason deploy --timeout 600` now work; nothing that worked before stops working. `--since` and `--until` take the
  same units as an age (`2 hours` too) and still refuse a bare number, which as a time could be a timestamp. A `sync:`
  interval and a `target_lag:` take `d` (`poll 1d`); a bare number in the sources file is still refused, now with the
  line to write (`poll 30s`).
- **A mistyped option is answered with the closest one and the command's synopsis** (`there is no option --jsn — did you
  mean --json?`), not with the whole usage; `mason <command> --help` still prints all of it.
- **The commands that name a hosted replica all take it the same ways**: `mason replica create` and `status` take
  `--replica <org>/<name>` or `MASON_REPLICA` as well as the argument, and `mason replica list` and `mason token list`
  take `--org` as well as the argument. When `MASON_REPLICA` chose the replica, every such command says so on stderr
  (`using MASON_REPLICA=acme/shop`), and `mason user … --replica` names the replica in its headline and in a `replica`
  key of its `--json` answer.
- **`not_answering`** (a run that is alive and does not answer, the way out `mason stop`) is now listed among the
  failure codes `mason help agent` names, and a failure never carries a code outside that list.
