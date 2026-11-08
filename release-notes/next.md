The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A first sync whose chunk ran out of memory now goes on with one reader at once.** It promised to, but while the
  chunk that ran out was rolled back, another reader could take a new chunk of full size beside it, at the moment memory
  was shortest; a test saw it in about 1 run in 25. No rows were lost or read twice: the range that ran out was read
  again, by smaller chunks.
