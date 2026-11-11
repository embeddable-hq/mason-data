The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason share` opens with the URL to paste**: its first line is now `Try mason with your favorite postgres client:
  postgres://<user>:<password>@<host>:<port>/<database>?sslmode=require`, the share's own login and address, so a
  client that takes a connection string connects from that one line. The host, port, database, user and password rows
  below it stay, for a tool that asks for each field, and `mason share --json` carries the same URL as `share.url`.
  The password is still made for this run alone and kept nowhere.
