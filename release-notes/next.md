The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

- **Listing a JSON column's keys is now about as fast as on Postgres.** `jsonb_object_keys` and `json_object_keys` of a
  column took 16 to 70 times as long as on Postgres, grouped as Metabase sends it, with `DISTINCT`, or in a `LEFT JOIN
  LATERAL`. Over about 5 million rows they timed out. While one ran, a small query in another session waited up to 8
  seconds. Over 3 million rows they now take 3 to 5 seconds, a little less than Postgres, and other queries no longer
  wait. The answers are the same as before.
