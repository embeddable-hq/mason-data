The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

- **A sources file can no longer name one of Mason's own settings** (`${MASON_…}`, such as `${MASON_API_KEY}`) in
  `publication:` or `url:`: it is refused when the file is read, with the way out, and the value is never shown. Before,
  `publication: ${MASON_API_KEY}` printed that key in the log as the publication's name and sent it to the source. If
  you run projects written by someone else (CI, a shared server), this closes that path. `url: ${MASON_DATABASE_URL}`,
  which `mason init` writes, still works.
