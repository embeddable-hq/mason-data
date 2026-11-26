The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A table synced with `sync: replication` lost the changes made to it while it was renamed on the database.** A row
  inserted, updated or deleted while the table had another name never reached the synced data, even after the table
  was renamed back and Mason restarted. All the while, `mason status` said the stream was current and `mason sync` said
  there was nothing to sync. Now a table renamed on the database, moved to another schema, or dropped is held. Its line
  in `mason status` says where it is and what to do, and it is never said to be current. Its synced data serves as it
  was. Once it is back under its name, Mason catches it up by one poll, with every change made meanwhile. Two tables
  that swap names are each synced again whole as the table of its name.
- **A polled table renamed on the database failed its poll every few seconds** with the engine's error, and the same
  happened to a table renamed during its first sync, which then waited at least 5 minutes after it was renamed back.
  Now such a table is held and said the same way, and its sync goes on as soon as it is back under its name.
- **A replicated table renamed on the database stopped the stream for every table** when Mason made its own
  publication. Now the other tables stream on.

- **Mason now sends the server name (SNI) on its TLS connections, as libpq does, so a source behind Neon's proxy, or
  another proxy that routes by SNI, can be synced with the URL the provider gives.** Before, Mason sent the name only
  under `sslmode=verify-full`. Under `sslmode=require`, Neon refused Mason's connections with `Endpoint ID is not
  specified`. Now the name goes out under every sslmode that uses TLS, when the host is a name and not an IP address.
  What Mason checks of the server's certificate is unchanged: only `verify-full` checks that it names the host.
- **A source given by an IP address under `sslmode=verify-full` could not be connected to.** On Node 26, which the
  `mason-data` image runs, every connection failed with `Setting the TLS ServerName to an IP address is not
  permitted`. Mason now sends no server name for an IP address, and still checks that the certificate names it.
