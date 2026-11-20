The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **Mason now sends the server name (SNI) on its TLS connections, as libpq does, so a source behind Neon's proxy, or
  another proxy that routes by SNI, can be synced with the URL the provider gives.** Before, Mason sent the name only
  under `sslmode=verify-full`. Under `sslmode=require`, Neon refused Mason's connections with `Endpoint ID is not
  specified`. Now the name goes out under every sslmode that uses TLS, when the host is a name and not an IP address.
  What Mason checks of the server's certificate is unchanged: only `verify-full` checks that it names the host.
- **A source given by an IP address under `sslmode=verify-full` could not be connected to.** On Node 26, which the
  `mason-data` image runs, every connection failed with `Setting the TLS ServerName to an IP address is not
  permitted`. Mason now sends no server name for an IP address, and still checks that the certificate names it.
