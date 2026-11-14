The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A polled table no longer costs an extra connection to your database now and then.** On some machines, Mason's
  timer for the next poll woke a moment early. Mason then connected to your database, found no table due yet, and
  connected again a moment later to poll it. Now every timer waits until its time has come.
