The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

- **`mason user check <name>` says whether a password is a user's**, for a sign-in page of your own in front of Mason:
  the password on stdin, the answer `ok`, `wrong`, `disabled` or `removed` with the user's id (`--json`), exit 0, 3,
  4 or 5. It never judges the address. A page in front of it must limit attempts — by the browser's address, by
  replica and by user name — since it answers `wrong` as often as it is asked. `mason user list` already shows each
  user's id; a name still bound to the same id is the same user (one removed and added again has a new id).
