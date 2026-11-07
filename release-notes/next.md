The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **A script that reads the exit code of `mason share` or `mason ui --ssh` sees 124, not 1, when the tunnel gives no
  address or the server does not answer within `--timeout`** (as `mason wait`, `mason deploy`, `mason replica create`
  and `mason login` already exit when they run out of time). Every other failure of both still exits 1.
- **`mason start --port <n>` is now `mason start --ui-port <n>`**: it was always the web page's and the commands' port
  (`MASON_UI_PORT` on a server), never the Postgres API's. The old flag starts nothing: it answers with the line to run
  and exit 2.
- **`mason status`, `mason stop` and `mason logs` refuse an argument** (exit 2): `mason stop myproject` stopped the
  project of the folder it ran in, whatever it named. Run them in the project's folder, or with `mason -C <folder>`.
- **`mason ui` opens a browser only when its output is a terminal**, as `mason login` does; in a pipe or a coding
  agent's shell it prints the address alone, as `--no-open` does.

## What changes

- **`mason -C <folder> <command>`** runs any command as if started in that folder, as `git -C` and `make -C` do; a
  folder that is missing or cannot be read is a wrong command line (exit 2).
- **Every list flag takes a comma list or the flag repeated, meaning the same**: `mason add orders --columns id
  --columns status` is `--columns id,status`, and so for `--include`, `--key`, `mason logs --outcome` and `mason token
  create --scope` (`--scope deploy,users`). `mason user add --set` stays one value a flag: a value may hold a comma.
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
- **A sources file can no longer name one of Mason's own settings** (`${MASON_…}`, such as `${MASON_API_KEY}`) in
  `publication:` or `url:`: it is refused when the file is read, with the way out, and the value is never shown. Before,
  `publication: ${MASON_API_KEY}` printed that key in the log as the publication's name and sent it to the source. If
  you run projects written by someone else (CI, a shared server), this closes that path. `url: ${MASON_DATABASE_URL}`,
  which `mason init` writes, still works.
