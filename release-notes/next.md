The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **`mason share`'s password now reads `mason_share_` and 48 hex digits**, where it was 48 bare hex digits, so a secret
  scanner or a person reading a saved connection can tell it is Mason's. It is as strong as before, and it logs in only
  on the share it was printed for. Nothing to do on upgrade, unless a script of yours checks the old shape.
- **A LIMIT with no ORDER BY over a many-to-many join is back to milliseconds**, where it had taken tens of seconds or
  minutes: it ran the whole join to pick its rows. Nothing to do on upgrade.
- **A small statement no longer waits tens of seconds beside a heavy one**: a statement that computes something per row
  (`to_char`, a numeric bin, jsonb `@>`) held every other session, up to 57 s on one deployment. A small statement now
  answers in under about a second or two, with up to about four such statements running at once. Nothing to do on
  upgrade.

## Known

- **Five or more heavy statements at once can still stall a small one**, for tens of seconds in the worst case measured
  ([issue 88](https://github.com/embeddable-hq/mason-data/issues/88)).

- **Pages of such a statement may overlap**: `LIMIT n OFFSET m` with no ORDER BY over a join that can multiply rows has no
  stable order, so a tool paging one can see a row twice and miss another. Add an ORDER BY where the pages matter.
