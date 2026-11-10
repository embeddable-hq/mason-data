The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What changes

- `MASON_PG_PUBLIC_URL` takes a host name with an underscore (a Docker service's name) and one written with its trailing dot, printed as written; it refuses a host label over 63 characters, an IPv4 address with a number over 255, and an IPv6 address with a zone id (`%eth0`), at the start. Beside it, `mason user add` still gives a self-signed listener certificate's SHA-256.

## What was wrong and is now right

- `mason deploy` could fail with `EPIPE … whether the deploy was made is not known` when it sent a deploy again after a refusal naming thousands of tables: reading that refusal took longer than the service's idle timeout, and the deploy was written onto the connection the service had closed meanwhile. Every request to the service now opens a connection of its own.
