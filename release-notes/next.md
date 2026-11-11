The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- `mason user add`, beside a `mason start` run on this machine's own address, now ends its tips with the way to a tool
  outside this machine: `mason share` opens an address on the internet, with a login and password of its own (not the
  new user's), for as long as it runs. It is not said beside `mason serve`, nor with `--replica`, nor while Mason is not
  running. `--json` is unchanged.
