The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## What was wrong and is now right

- **A refused connection over TLS is told why.** Behind a TCP proxy over TLS, a refused connection (a wrong password,
  a protocol error) sometimes saw "connection closed unexpectedly" instead of the refusal, and a client that sent its
  statements and Terminate together sometimes lost the last answers: Mason closed the connection before what it had
  just sent had left. It now closes once that has left, and a client that reads nothing holds the connection five
  seconds at most.
