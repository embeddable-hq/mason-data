# Mason on a server

One container, `mason serve`: it copies the tables your project names from your Postgres, keeps them current, and
answers the Postgres protocol for BI tools and your app. Wherever your Postgres is, Mason only reads it.

The image is `ghcr.io/embeddable-hq/mason-data` (`main` is every merge, `<version>` a release; `MASON_TAG` in `.env`
pins one), amd64 and arm64, public: nothing to log in to.

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

- **Polling** (the default) needs a user that can SELECT the tables, and costs the database a scan of each table per
  poll. It works on a read replica.
- **Replication** (`MASON_CHANGES=replication`) needs `wal_level=logical`, a user with REPLICATION, and either a
  publication you name (`PG_PUBLICATION`) or the right to create one. The slot holds the database's WAL while Mason is
  down: cap it with `max_slot_wal_keep_size`.
- **The network**: the container must reach the database. Run it in the same private network, or allow the server's
  outbound address in the database's firewall.

Every setting, with its default: `docker compose exec mason mason serve --help`.
