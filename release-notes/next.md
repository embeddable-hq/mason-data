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
  that name, and it must be `DATABASE_URL`, the one a replica sets: a sources file naming another is refused before the
  URL is asked for. The URL must carry a password and a database name, take no query parameter but `sslmode`, name one
  host, and use a port of 1024 or above; each is refused before anything is sent.

## New

- **A Mason user can be limited to the addresses it connects from**: `mason user add looker --from 203.0.113.0/24
  --from 2001:db8:7::/48`, `mason user from looker 198.51.100.0/24` to replace the list, `mason user from looker --any`
  to remove it; `mason user list` shows each user's list (`from` in `--json`, `null` for any address), and `mason user
  … --replica` carries it. A connection from any other address is refused before its password is checked, as Postgres
  refuses one no `pg_hba.conf` line takes (`28000`, `no entry for host "…", user "…"`), and a session held when the list
  changes ends at its next statement if its address is outside it. Behind a TCP proxy the address is the client its
  PROXY header carries (`MASON_PG_PROXY_FROM`). Users without a list connect as before, and `.mason/users.json` files
  written before are read unchanged.

## What changes

- **A database URL on `mason replica`'s command line is refused** (exit 2), never repeated, with the line to run
  instead: a command line is kept in shell history and shown to every process on the machine, so if it held a real
  password, change it.
- **`mason replica create` prints the replica's page**, where its allowlist (the addresses that may query it) is set,
  and `--json` gives it as `replica.page` (`null` when the service names none); `mason replica status` prints it too.
- **While any user has an address list, a user name that is no user is refused `28000` with the same words as a wrong
  address**, instead of `28P01`, so a connection from outside cannot tell a user with a list from a name that is no
  user. A user without a list still answers a wrong password `28P01`, so its name can be told apart. A project where no
  user has a list answers as before.
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
- **`mason ui --replica <org>/<name>` opens a hosted replica's web page in your browser**, for the organisation's owner:
  the service answers an address that opens the page once, for a few minutes, and the CLI opens it (`--no-open` prints
  it instead, `--json` gives `{ url, replica, expiresAt }`). The page is read-only: a replica's users are still changed
  with `mason user … --replica`. Another login, or a CI token, is refused with the service's
  words; a replica not ready yet is said with when to try again. `MASON_REPLICA` in the environment turns `mason ui` to
  that replica's page too, said on stderr, unless `--ssh` names a server.
- **`not_answering`** (a run that is alive and does not answer, the way out `mason stop`) is now listed among the
  failure codes `mason help agent` names, and a failure never carries a code outside that list.
- **`mason deploy` waits while its replica is being created**: when the service answers that the replica is being
  checked or created, that the machine it runs on is not connected just now, or that too many deploys are being sent
  at once, `mason deploy` waits as the service asks and sends the deploy again, within `--timeout`, saying what it
  waits on and how long it has waited (on stderr; `--json` prints only the answer). Past `--timeout` it exits 124,
  saying no deploy was made. A replica that failed or is being deleted is refused, and the next step is
  `mason replica status <org>/<name>`, no longer `mason login`; a deleted one is answered as a replica that does not
  exist, its next step `mason replica list <org>`.

## What was wrong and is now right

- **`mason usage --since` (and `mason logs --since`/`--until`) with an age too large for a date** (`99999999999d`) crashed
  the command, and the run's HTTP API answered it with a 500. It is now refused as a wrong command line (exit 2), and
  the API answers 400.
- **A sources file can no longer name one of Mason's own settings** (`${MASON_…}`, such as `${MASON_API_KEY}`) in
  `publication:` or `url:`: it is refused when the file is read, with the way out, and the value is never shown. Before,
  `publication: ${MASON_API_KEY}` printed that key in the log as the publication's name and sent it to the source. If
  you run projects written by someone else (CI, a shared server), this closes that path. `url: ${MASON_DATABASE_URL}`,
  which `mason init` writes, still works.
