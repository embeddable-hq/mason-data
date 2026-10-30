# tests/integration — the real thing against a real Postgres

`npm test` covers the pure logic offline. These tests run the real copy, the real poll and stream, the real listener
and `mason serve` against a Postgres of yours, and hold every answer to what that Postgres answers.

```bash
export IT_POSTGRES_URL=postgres://postgres:<password>@localhost:5432/postgres   # wal_level=logical for the stream
npm run test:integration
```

**Once per checkout, `node cli/extensions.ts --node-modules node_modules`**: it installs this platform's package of the
copy's extensions into `node_modules`, as `npm install -g @mason-data/cli` installs it for a user, so every file runs
with nothing downloaded (`src/duck/extensions.ts`). The oracle refuses to run without it: what it holds equal must be
what a user's install answers, and a regression to downloading must fail it, never pass on the engine's own install.

`IT_POSTGRES_URL` is a libpq URL to a Postgres — locally Postgres.app or a container, in CI a `postgres:18` service
switched to `wal_level=logical`. `psql` must be on PATH. **Every file writes only inside a database it creates on that
server (`it_<name>_<random>`) and drops at the end**, so point it at a throwaway server, never a shared one: its user
needs CREATEDB, and REPLICATION for the stream. DuckDB's `postgres` extension is downloaded once per machine.

**One file at a time** (`--test-concurrency=1` in `npm run test:integration`): each file runs a listener on a port and a
store of its own, and two at once double the machine's load and the chance of a port clash. CI runs the suite as two
jobs, each with a Postgres of its own (`.github/workflows/ci.yml`, `integration`): the oracle, and every other file — a
new file joins the second by itself.

## The ready local gate

```bash
npm run gate                                 # typecheck, conventions, the state matrix, what imports the change
npm run gate -- tests/duck-wire.test.ts      # and files named by hand
npm run gate -- --oracle '^type matrix: '    # and the oracle's statements that regex names (IT_ORACLE_ONLY)
npm run gate -- --timeout 900                # another bound, in seconds, on each test file
```

**It is a subset, and CI is the full gate.** It prints what it chose and why, and exits 0 only when every step did;
1 when any failed; 2 on a bad argument; 128+n when a signal stopped it. It needs Docker and `psql` only when an
integration file is chosen, and says what to do on one report when one is missing.

- **Node** is the one CI runs. `.github/workflows/ci.yml` is the one place: its `node-version` and Postgres `image` are
  read at every run, and a `NODE_PIN` (`scripts/gate.ts`) of another major refuses the gate. The pin adds the exact
  release and its sha256, fetched once from nodejs.org into `<git common dir>/mason-gate/`, which git ignores and every
  worktree of the clone shares. Nothing global changes: Node 26 is first on the PATH of the gate's own children only.
  A tarball, not a container: a Linux Node on a Mac needs a second `node_modules`, and the `node_modules` a Mac has runs
  on it unchanged. CI's Node is the latest 26 and the pin is one 26, so a release apart is possible; bump the pin as
  ci.yml moves.
- **Postgres** is `ci.yml`'s image, only when an integration file is chosen, in a container `mason-gate-<pid>-<random>`
  on a port Docker picks, with a random password and `wal_level=logical`, held by a probe over that port. It is removed
  by that exact name on a pass, a failure or a signal, and the removal is checked; one that cannot be confirmed fails
  the gate with the command to run. A SIGKILL cannot be caught: the container then stops at its own bound (`timeout` is
  its entrypoint), and stays stopped until `docker rm --volumes <name>`.
- **Nearest** is one rule: a test file a change touched, or one that imports a changed file directly (`git diff` against
  the merge base with `origin/main`, untracked files included). A test that reaches a change through another module, or
  that spawns it, is not near: name it by hand. A change never picks the oracle: it is said left out, `--oracle` takes a
  subset, and naming its file runs all of it. A regex that names no statement fails: an empty oracle proves nothing.
- **Every process has a bound**: a file at a time, each in a process group of its own, stopped with SIGTERM and then
  SIGKILL; the report names the file and keeps its output (a unit file 600 s, an integration file 900 s, the oracle 1800 s).

| file | what it proves |
|---|---|
| The copy's extensions (`extensions.itest.ts`) | with this platform's `@mason-data/extensions-<platform>` installed read-only (built by `node cli/extensions.ts`, kept in `cli/platforms/`) and HOME an empty folder, a copy of a table with inet columns and a text cast to inet work, and nothing is downloaded: HOME stays empty, the package unchanged, autoinstall off. Needs `IT_POSTGRES_URL`, and the internet once to build the package |
| The copy and the poll (`duck-poll.itest.ts`) | the copy equals the source, row for row, after every kind of change an app makes — an insert, an update, a delete, a primary-key change, a savepoint's row, a transaction open across several polls, a TRUNCATE — and after a restart over the same file (the watermarks are kept); the chunked copy resumes with exactly the ranges no chunk committed, with one, two or three readers. Nothing is created on the source. Needs `IT_POSTGRES_URL` (any `wal_level`) |
| The stream (`duck-stream.itest.ts`) | the copy kept current by logical replication after the same changes, an UPDATE that leaves a large (TOASTed) value unchanged, a restart (the slot resumes; nothing is copied again), a table added while streaming, a project that polled before (caught up by one poll), and every type of the copy arriving through the stream as the copy stores it. Needs `wal_level = logical`; makes and drops its own slots |
| `mason serve` (`duck-serve.itest.ts`) | the server's whole life as a platform sees it: started with its settings in the environment and nothing else, `/healthz` turns 200 once it answers; a table added beside it with `mason add` is copied and counted; the Postgres API answers a token minted from `MASON_API_KEY`; SIGTERM stops it with exit 0, the copy kept; a second serve over the same data folder resumes |
| `to_char` (`duck-to-char.itest.ts`) | Mason's `to_char` is Postgres's: every time pattern and number template over values chosen for their edges, formatted by Postgres itself and by Mason, compared character by character |
| `mason start`'s catalog read (`cli-preflight.itest.ts`) | a partitioned table is listed once with its leaves' rows and size; a never-analysed table is counted, once per run; an analysed one is read from the catalog |
| THE ORACLE (`duck-oracle.itest.ts`, `oracle/`) | every statement Mason answers is held EXACTLY equal to what the Postgres it copies from answers — the same column names, type OIDs, text, rows in the same order, the same refusal (SQLSTATE) — because a BI tool sends Mason the SQL it sends Postgres and reads the answer as Postgres's. Adversarial data (`oracle/data.ts`: NULL beside '' beside a value, case variants, ties, bucket boundaries, 1970 and the far future, negatives, float-unfriendly decimals) is copied by the real copy and served by the real listener; thousands of statements (`postgres-cases.ts`: every construct a tool writes; `oracle/bi-shapes.ts`: what BI tools send, in six shapes (`oracle/shapes.ts`); `oracle/type-matrix.ts`: every type through every path; `oracle/gap-cases.ts`: every documented refusal, which must still be refused; `oracle/setting-scripts.ts`: a session's settings across its transactions, each step's whole reply) are sent to both and diffed — after the copy and after two rounds of changes. It regenerates the allowlist of what is verified (`src/duck/verified.ts`, `UPDATE_VERIFIED=1`). `IT_ORACLE_ONLY=<regex>` runs a subset |
