The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What was wrong and is now right

- **In a project Mason cannot write, a column `exclude:` names can now be renamed more than once while Mason runs.**
  This is a project run with `MASON_PROJECT_READONLY=1`, or one whose sources file Mason cannot write. Before, a second
  rename of such a column made Mason stop taking column changes for the rest of the run, in every table. A column added
  elsewhere was never synced, and a renamed one failed its table's sync again and again until a restart. The excluded
  column was never served. Now each change is taken, and the renamed column stays out of the synced data. `mason
  status` shows one line for the table: the whole `exclude:` to write in the sources file now. Mason also keeps out a
  column the file excludes when a column of that name is added back, and says so.
