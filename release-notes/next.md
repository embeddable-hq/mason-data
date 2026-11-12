The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **Every example in a box on the web page now starts with "e.g."**: the Tables and Queries search boxes say
  `e.g. orders`, Queries' since `e.g. 2h`, and a new user's name and where it connects from `e.g. metabase` and
  `e.g. 192.0.2.0/24, 2001:db8::/32`, so an example is never taken for a value already filled in.

## What was wrong and is now right

- **The limit on what statements may spill to disk is in force from the start.** Before, `MASON_SPILL_LIMIT` (and the
  default, half of the free disk) was shown by the engine but not enforced until the free disk moved by 1 % or more, so
  with `MASON_SPILL_LIMIT` set, or on a disk whose free space held still, a heavy statement could spill past it and fill
  the disk under `.mason/`. Now a statement past it fails alone with 53400 from the first statement on. If you set
  `MASON_SPILL_LIMIT` low, a statement that used to finish by spilling past it now fails with 53400: raise it, or ask
  for less at once. Mason also checks every engine setting it gives at the start, and refuses to start, naming the
  setting, if one is not what it gave.
