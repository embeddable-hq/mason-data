The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **On a Postgres 19 source, a query that compared a `pg_lsn` column with a value gave wrong answers.** Postgres 19
  writes a `pg_lsn` with 8 hex digits after the slash (`0/016B3748`, where 18 wrote `0/16B3748`). So `=` and `IN`
  found no rows, and `<>` returned every row. A `pg_lsn` value written in a query, such as one in a `VALUES` list,
  came back in 18's form. Now Mason compares and prints a `pg_lsn` as the source writes it, in either spelling. A
  Postgres 18 source answers as before.

- **Mason now sends the server name (SNI) on its TLS connections, as libpq does, so a source behind Neon's proxy, or
  another proxy that routes by SNI, can be synced with the URL the provider gives.** Before, Mason sent the name only
  under `sslmode=verify-full`. Under `sslmode=require`, Neon refused Mason's connections with `Endpoint ID is not
  specified`. Now the name goes out under every sslmode that uses TLS, when the host is a name and not an IP address.
  What Mason checks of the server's certificate is unchanged: only `verify-full` checks that it names the host.
- **A source given by an IP address under `sslmode=verify-full` could not be connected to.** On Node 26, which the
  `mason-data` image runs, every connection failed with `Setting the TLS ServerName to an IP address is not
  permitted`. Mason now sends no server name for an IP address, and still checks that the certificate names it.
