# Security

Mason holds a database URL and serves the data of the tables it syncs, so a vulnerability in it is a vulnerability in
your data's access control. Please report one privately.

**Report it through GitHub's private vulnerability reporting**: the repository's Security tab → "Report a
vulnerability" ([direct link](https://github.com/embeddable-hq/mason-data/security/advisories/new)). You will get an
acknowledgement within a few days, and the fix is released with a note in the release notes before the advisory is
published. Please do not open a public issue for it.

**What counts**: a way to read data without a valid token or user, to reach a table the project did not sync, to run a
write on the source database, to read the source URL or a token from the API or the logs, or to make Mason execute
something it should not. The listener is on 127.0.0.1 unless configured otherwise; a report about that default is a
discussion, not a vulnerability.

**Supported versions**: the latest release only, until v1.0.
