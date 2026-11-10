The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- A `mason serve` run that was alive but no longer answering read as "not running": `mason status` said so, and
  `mason destroy` or a second start treated its project as free while the process still held the synced data. Every
  run now records when its process started, and a silent run is known as hung however it was started (`mason start`,
  `mason serve` in the image, from a checkout or through npx). A run started by an earlier version records no start:
  if it stops answering, `mason status` says it cannot tell whether the process is still Mason's, and `mason stop`
  forgets it without signalling it.
