# Mason on a server

One container, `mason serve`: it copies the tables your project names from your Postgres, keeps them current, and
answers the Postgres protocol for BI tools and your app. Wherever your Postgres is, Mason only reads it.

The image is `ghcr.io/embeddable-hq/mason-data` (`main` is every merge, `<version>` a release; `MASON_TAG` in `.env`
pins one), amd64 and arm64, public: nothing to log in to.

This is the one-machine deployment, the one Mason was measured on. Fly.io, Kubernetes, Railway and AWS ECS each have a
guide, and the platforms that cannot run Mason are named with why: [`deploy/README.md`](../README.md).

```bash
mkdir -p mason                  # the project folder the container mounts (else Docker makes it root-owned, and mason add cannot write)
cp .env.example .env            # DATABASE_URL, MASON_API_KEY (openssl rand -hex 24)
docker compose up -d
curl -s localhost:4140/healthz  # 503 while it starts (the first ~15 s: it reads how the database orders text), then 200
docker compose exec mason mason tables
docker compose exec mason mason add public.orders
docker compose exec mason mason user add metabase   # a user for the BI tool: the URL and its password, printed once
```

- **`./mason` is the project folder** (`sources/`, `mason.yml`). `mason add` adds the table to its sources file
  (`sources/<database>.yml`, written at the first start from `DATABASE_URL`); commit it.
  On a server built from your repo, mount the committed folder instead and nothing is added by hand.
- **The volume `mason-data` is the copy and Mason's state.** `docker compose down` keeps it; `down -v` removes it, and
  the next start copies again.
- **One container per volume, never two.** DuckDB lets one process write its file. A platform must run one replica,
  with no autoscaling, and stop the old container before it starts the new one.
- **The Postgres API needs TLS** off the container's loopback: `MASON_PG_SELF_SIGNED_TLS=1` makes a certificate on the
  volume (it encrypts; clients connect with `sslmode=require`), or `MASON_PG_TLS_CERT` / `MASON_PG_TLS_KEY` name one a
  CA signed.
- **The first start takes about 15 seconds** before `/healthz` answers 200 (minutes on a heavily loaded machine; the
  image's health check allows 2), a restart under a second: the run reads how the database orders text once and keeps it.
- **A BI tool or an app connects as a user**: `mason user add <name>` prints its password once (it never expires),
  `mason user list` says the users, `mason user remove <name>` refuses its next connection and ends its sessions at
  their next statement, without a restart. The list is `.mason/users.json` on the volume (no passwords in it).
  **Changing `MASON_API_KEY` removes every user at once**: add each again.

## Your database

- **Polling** (the default) needs a user that can SELECT the tables. Each table is read once, then as the sources
  file's `sync:` says: `off` (the default) only at `mason sync <table>` (`docker compose exec mason mason sync orders`,
  from cron), `poll 5m` every five minutes — each poll a scan of that table on the database. It works on a read replica.
- **Replication** (a table's `sync: replication`) needs `wal_level=logical`, a user with REPLICATION, and either a
  publication you name (`publication: ${PG_PUBLICATION}` at the top of the sources file) or the right to create one. The slot holds the database's WAL while Mason is
  down: cap it with `max_slot_wal_keep_size`.
- **No setting chooses it**: how each table is kept current is the committed sources file's alone. `MASON_CHANGES`
  is gone, and set it refuses the start, naming the `sync:` line to write in the sources file.
- **The network**: the container must reach the database. Run it in the same private network, or allow the server's
  outbound address in the database's firewall.

## Memory

- **The default**: the copy may use half the container's memory limit (cgroup v2 `memory.max`, or v1's), else half
  the machine's RAM. The other half is the page cache, Node and the catalog (about 820 MB while it runs: it starts at
  a tool's first statement and stops when idle). `docker compose exec mason mason doctor` says what the copy may use.
- **How much to give**: enough that the page cache holds the columns your dashboards read. A query over a column it
  does not hold runs at the disk's speed (on an EBS volume at ~125 MB/s, a JSON column of a 28 GB table: 93.5 s for
  22 M rows). The copy is smaller than the tables: the benchmark's was about a fifth of them in Postgres (10.1 GiB →
  1.8 GiB, 3.4 GiB → 0.61 GiB, with a jsonb column), measured on a 15 GiB machine with the copy's limit at 7832 MiB.
  Yours depends on its columns: `mason status` says the copy's size, and each table's.
- **How to set it**: the container's limit, and `MASON_DUCKDB_MEMORY` at about half of it (or leave it unset: the
  default is that half). Compose's key is `deploy.resources.limits.memory` (`compose.yml` sets none):

  ```yaml
  services:
    mason:
      deploy:
        resources:
          limits:
            memory: 8G          # the copy may use 4 GiB of it by default
  ```

- **When it is short**: a sort, a join or an aggregate past the limit spills to disk beside the copy; what cannot spill
  fails its own statement with 53200, naming `MASON_DUCKDB_MEMORY`, and the run goes on. A `MASON_DUCKDB_MEMORY` near
  or above the container's limit is the kernel killing the container instead.
- **A copy beside the queries** costs them the page cache it evicts, not CPU (a 1 s chart took up to 8 s beside
  buffered writes, +85 % beside a CPU-only load): memory is what keeps the queries steady while a table is copied.

## CPU, disk and the instance

- **Memory first, then cores**: the findings above are the disk and the page cache, not the CPU, so prefer more
  memory per core over more cores. The measured machine is an m7g.xlarge: 4 vCPU (Graviton3), 15 GiB, EBS gp3, with
  the benchmark's Postgres beside Mason on it.
- **What it served**: at 10 M rows, 12 statements a second, the same at 8 clients (p95 1.35 s) as at 32 (p95 3.5 s):
  past the cores, more clients wait longer. Take the next size up when the slow statements `mason status` lists are
  slower than your dashboards can wait.
- **One statement can use every core**: Mason leaves DuckDB's threads at its default, and DuckDB has no per-connection
  priority, so a long statement slows the others beside it. A copy's readers are about a core each while it runs
  (`MASON_COPY_PARALLEL`, default 3), and one backend each on your database.
- **The disk** decides a query the page cache does not hold, and a copy's writes: EBS gp3 is the measured one. A
  faster disk helps where the copy outgrows memory (not measured).
- **The image is arm64 and amd64**, the same image; arm64 (Graviton) is the one measured.

## Settings

`docker compose exec mason mason serve --help` has every setting, with its default; this is which to decide.

**A production run sets** (the image sets `MASON_PROJECT=/mason/project`, `MASON_DATA=/mason/data`,
`MASON_PG_HOST=0.0.0.0` and `MASON_PG_PORT=5433`; change them only as your platform needs):

| Setting | |
|---|---|
| `DATABASE_URL` | the database to copy from, as the sources file's `url: ${DATABASE_URL}` names it (the variable the file names is required) |
| `MASON_API_KEY` | what the users' passwords are made with (`mason user add`), at least 32 characters (required); changing it removes every user |
| `MASON_DATA` | the folder whose `.mason/` holds the copy and the state: mount the volume there (the image's `/mason/data`) |
| `MASON_PG_TLS_CERT`, `MASON_PG_TLS_KEY` | its certificate, required off loopback; or `MASON_PG_SELF_SIGNED_TLS=1` for one made in `.mason/`, or `MASON_PG_PLAIN=1` behind a TLS proxy of your own |
| `MASON_PG_HOST`, `MASON_PG_PORT` | the Postgres API's address |

**Worth deciding**:

| Setting | Default | Change it when |
|---|---|---|
| `MASON_DUCKDB_MEMORY` | half the container's memory limit | the container's limit is not what the copy should have half of ("Memory") |
| `MASON_COPY_PARALLEL` | 3 (1 to 8) | each reader is a backend on your database: fewer when the database has little headroom, more when it has plenty and a copy is slow |
| `MASON_STATEMENT_TIMEOUT` | `5min` (0 for none) | a dashboard's statement may rightly take longer, or a runaway one should stop sooner |
| `MASON_REQUEST_LOG_DAYS` | 7 | you want the request log (`mason logs --requests`, kept in the copy) longer or shorter |
| `MASON_STORE_JSON_PATHS` | `on` | you want the copy to hold only the columns you named: `off` stores no JSON path as a column, and drops what was stored at the next start |
