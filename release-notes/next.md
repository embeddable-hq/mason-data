The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- **A script that reads the exit code of `mason share` or `mason ui --ssh` sees 124, not 1, when the tunnel gives no
  address or the server does not answer within `--timeout`** (as `mason wait`, `mason deploy`, `mason replica create`
  and `mason login` already exit when they run out of time). Every other failure of both still exits 1.

## What changes

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
- **`mason destroy --dry-run` and `mason remove --dry-run` say what would go and change nothing**: destroy lists Mason
  stopped, the replication slot and Mason's own publication on your database (named from what Mason recorded: the dry
  run never connects to the database) and the synced data and state; remove lists the sources file's entries. Both
  prompt for nothing, and `--json` answers with `dryRun: true`.
- **`mason init -` reads the database's URL from stdin**, so its password stays off the command line (`ps`, your
  shell's history). A URL with a password given as the argument to `mason init`, or to `mason mcp --url`, still works,
  with a warning on stderr naming the safer way.
- **`mason wait orders customers` waits for those synced tables alone** (until each one's first sync is done); a
  generated table is still waited for by its name alone. **`mason sync --all`** syncs every table the sources file names.
- **`--json` keys that meant different things in different commands have names of their own beside the old ones**:
  `removedTables` (`mason remove`), `destroyed` (`mason destroy`), `removedUser` (`mason user remove`), `revokedToken`
  (`mason token revoke`) and `loginRevoked` (`mason logout`). The old keys (`removed`, `revoked`) stay until 1.0.
