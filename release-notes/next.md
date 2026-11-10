The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- **A read-only web page can still edit its tables**: `mason serve` with `MASON_UI_READ_ONLY=1` and
  `MASON_UI_READ_ONLY_ALLOW=tables` keeps Add, Columns…, Name its key…, Remove and Sync now on the Tables page, and
  still refuses every other change the page sends (users, cancelling a statement, sharing). `MASON_PROJECT_READONLY=1`
  still refuses an Add or a Remove. Any other value, or the setting without `MASON_UI_READ_ONLY=1`, refuses the start.
  Unset, nothing changes.
- **A web page embedded in another site can send part of its sidebar to that site**: `mason serve` with
  `MASON_UI_NAV_USERS_URL` (or `_OVERVIEW_`, `_TABLES_`, `_QUERIES_`, `_USAGE_`, `_SYNC_EVENTS_`) set makes that item,
  every link of the page into that view and its address go to the site's own page, in the same tab; and
  `MASON_UI_NAV_LINKS`, a JSON list of up to 5 `{"label","url"}`, adds the site's links to the sidebar. URLs and labels
  follow `MASON_UI_BACK_URL`'s rules, and anything else refuses the start, as does an item's URL whose `#fragment`
  names a view that is replaced (the page would go round in a loop). A replaced item is only a link: the server
  still answers it, so set `MASON_UI_READ_ONLY` too if changes should be made on the site alone. Unset, nothing changes.
