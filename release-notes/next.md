The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **The web page links to how to change a deployed project.** When a deployed project's Tables page says it is
  read-only, its link now goes to the README's new "Change a deployed project" section. A host that runs Mason for
  others can link to its own steps instead: set `MASON_UI_DEPLOY_DOCS_URL` on `mason serve` to a path on the page's
  host or an `https://` or `http://` URL. It follows `MASON_UI_BACK_URL`'s rules, and a value Mason cannot use stops the start with
  a message that says what is wrong.
