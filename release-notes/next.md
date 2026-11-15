The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What was wrong and is now right

- **In a project Mason cannot write, a column `exclude:` names can now be renamed more than once while Mason runs.**
  This is a project run with `MASON_PROJECT_READONLY=1`, or one whose sources file Mason cannot write. Before, a second
  rename of such a column made Mason stop taking column changes for the rest of the run, in every table. This also
  happened when the file was refused for another reason during the renames, and was fixed later. A column added
  elsewhere was never synced, and a renamed one failed its table's sync again and again until a restart. The excluded
  column was never served. Now each change is taken, and the renamed column stays out of the synced data. `mason
  status` shows one line for the table: what to write in the sources file now. When nothing is left out, that line
  says to write the entry as `{}`, or to take `exclude:` out of it. It used to say `exclude: []`, which a start refuses. While Mason runs, it also keeps out a column the file excludes when a
  column of that name is added back, and says so.
