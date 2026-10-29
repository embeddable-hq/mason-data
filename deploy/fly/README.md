# Mason on Fly.io

One Machine running `mason serve`, its copy on one Fly Volume, the Postgres API as a raw TCP service on 5433.
`fly.toml` beside this file is the configuration; every key in it is cited to Fly's reference.

```bash
cd deploy/fly
fly launch --no-deploy --copy-config --name <app> --region <region>   # the app from fly.toml, nothing started yet
fly secrets set DATABASE_URL=postgres://mason_reader:…@db.example.com:5432/app MASON_API_KEY=$(openssl rand -hex 24)
fly deploy --ha=false                     # creates the volume (20 GB, [[mounts]]) and the one Machine
fly checks list                           # /healthz passing once it serves (~15 s; minutes on a loaded host); 4140 is not published
fly ssh console -u node -C "mason tables"
fly ssh console -u node -C "mason add public.orders"
fly ssh console -u node -C "mason user add metabase"   # the BI tool's user: URL and password, printed once
```

A tool connects to `<app>.fly.dev:5433` with `sslmode=require`, as the user `mason user add` printed.

- **One Machine, one volume, never two.** The copy is one file with one writer. `fly deploy` "creates and starts only
  one Machine if the process group has volumes mounted", and `--ha=false` says so twice; `fly scale count 1` is the
  only count. A second Machine would get its own empty volume and its own copy, and the TCP service would send each
  connection to either. Fly's advice to run two Machines with volumes is for apps that replicate between them; Mason
  does not.
- **A deploy is downtime, by design.** With one Machine and a volume, the `rolling` strategy (the default; `canary`
  and `bluegreen` "cannot be used for Machines with attached volumes") stops the Machine, updates it, and starts it on
  the same volume: the old container stops before the new one starts, which is what Mason requires. A restart is under
  a second before `/healthz` answers again; the tables are not copied again.
- **The volume is the copy and Mason's state** (`.mason/`, the users, the self-signed certificate). It is a slice of an
  NVMe drive on the Machine's host: a block device, local, in one region. Fly snapshots it daily (kept 5 days by default);
  losing it means the next start copies the tables again, nothing else.
  It can be extended, never shrunk: `fly volumes extend`, or the `auto_extend_size_*` keys of `[[mounts]]`.
- **Raw TCP, Mason's TLS.** The `[[services.ports]]` entry has no `handlers`, so Fly's edge passes the bytes through and
  Mason's own TLS (`MASON_PG_SELF_SIGNED_TLS=1`, or `MASON_PG_TLS_CERT` / `MASON_PG_TLS_KEY` for one a CA signed) is
  the TLS the client sees. Do not add a `tls` handler: it would end TLS at the edge, and the Postgres protocol's own
  handshake would fail.
- **`kill_timeout = 60`**: SIGTERM is `mason serve`'s stop (a copy in flight interrupted and rolled back); Fly's default
  is 5 s, the maximum 300.
- **The health check is Fly's top-level `[checks]`**, on 4140, not a `[[services.http_checks]]`: a service check runs
  against the service's `internal_port`, and 5433 speaks Postgres, not HTTP. 4140 is not published; `fly checks list`
  reads it.
- **Commands beside the server**: `fly ssh console -u node -C "<command>"`. `-u node` matters: the console is root by
  default, and a file root writes into the volume is one the server (user `node`) cannot write afterwards.

## The project folder

`fly.toml` sets `MASON_PROJECT=/mason/data/project`: the project folder lives on the volume, so a table `mason add` adds
beside the server stays added across deploys (a Machine's root filesystem is new at every deploy). The first start
writes `sources/<database>.yml` from `DATABASE_URL`, with no table.

To ship the committed folder with your release instead, build an image that carries it and remove the `MASON_PROJECT`
line:

```dockerfile
FROM ghcr.io/embeddable-hq/mason-data:main
COPY mason/ /mason/project/
```

with `[build]` naming the `dockerfile` instead of `image`. `mason serve` writes nothing in a project folder that has a
sources file, so the folder may be read-only; a table added or removed in it is copied or dropped at the next deploy.

## Memory and size

`[[vm]]` is `performance`, 2 CPUs, 8 GB, and `MASON_DUCKDB_MEMORY=4GB` is half of it; change the two together. A
performance size takes memory in 2048 MB steps, up to 8 GB per CPU (`fly platform vm-sizes`). Which size: enough that the
page cache holds the columns your dashboards read, memory before cores — [`deploy/mason-data/README.md`](../mason-data/README.md#memory)
has the measurements. `fly ssh console -u node -C "mason doctor"` says what the copy may use.

## Your database

What polling and replication each need, and the network: [`deploy/mason-data/README.md`](../mason-data/README.md#your-database).
A Machine reaches the internet; a database that allows only known addresses needs the app's dedicated IPv4
(`fly ips allocate-v4`, which you pay for), or a database inside your Fly private network (6PN) by its `.internal` name.

## Where each claim is from

- `kill_timeout`, `[deploy] strategy` and volumes, `[[mounts]]`, `[[services]]` and `auto_stop_machines`, `[checks]`,
  `[[vm]]`: https://docs.fly.io/reference/configuration
- one Machine for a process group with volumes, `--ha=false`: https://docs.fly.io/reference/app-availability
- a volume is NVMe on the Machine's host, one Machine per volume, downtime on deploy with one Machine, snapshots:
  https://docs.fly.io/volumes/overview
- `fly deploy --ha --strategy --image`: https://docs.fly.io/flyctl/deploy; `fly ssh console -u -C`:
  https://docs.fly.io/flyctl/ssh-console; `fly scale count --max-per-region`: https://docs.fly.io/flyctl/scale-count
- memory steps and limits per CPU kind: https://docs.fly.io/machines/guides-examples/machine-sizing
