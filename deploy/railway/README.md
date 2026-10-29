# Mason on Railway

One service from the image, one volume, the Postgres API through Railway's TCP proxy. `railway.ts` beside this file is
the configuration as Railway's Infrastructure as Code (`.railway/railway.ts` in your repo); the dashboard's steps below
make the same service by hand. Railway's older `railway.json` is deprecated and stops being read on 2026-12-01, so there
is none here.

**In the dashboard** (project canvas):

1. **New service** → deploy a Docker image → `ghcr.io/embeddable-hq/mason-data:main` (GitHub Container Registry is a
   supported source; public, nothing to log in to).
2. **Variables**: `DATABASE_URL`, `MASON_API_KEY` (`openssl rand -hex 24`), `MASON_PG_SELF_SIGNED_TLS=1`,
   `MASON_PROJECT=/mason/data/project`, `MASON_DUCKDB_MEMORY=4GB`, `PORT=4140`, `RAILWAY_RUN_UID=0`,
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60`. Each is explained below.
3. **Volume**: ⌘K → create a volume → attach it to the service → mount path `/mason/data`.
4. **Settings → Networking → TCP Proxy**: the internal port is `5433`. Railway gives a `<host>.proxy.rlwy.net:<port>`;
   that is the address a tool connects to, with `sslmode=require`. Do not generate an HTTP domain: the Postgres API is
   not HTTP.
5. **Settings → Health check**: path `/healthz`, timeout 300 s.
6. **Deploy** the staged changes. Then, in the service's shell (`railway ssh`, or the dashboard's), first `cd` to the
   data folder: every `mason` command means the project of the folder it runs in, and the shell documents no working
   directory.

```bash
cd /mason/data
mason tables
mason add public.orders
mason user add metabase      # the BI tool's user: URL and password, printed once (replace the host and port with the proxy's)
```

- **One replica, never more.** The copy is one file with one writer; Railway agrees: "Replicas cannot be used with
  volumes", and "Each service can only have a single volume".
- **A redeploy is a short downtime, by design.** Railway prevents "multiple deployments from being active and mounted to
  the same service", so the old container stops before the new one starts, as Mason requires, "even with a healthcheck
  endpoint configured". A restart is under a second before `/healthz` answers again.
- **`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=60`.** The old deployment is sent SIGTERM and, by default, "forcefully stopped
  with a SIGKILL" after 0 s. SIGTERM is `mason serve`'s stop (a copy in flight interrupted and rolled back); give it the
  minute.
- **`PORT=4140`.** Railway's health check is sent to the port `PORT` names, and the default `PORT` is not 4140. Setting
  it points the check at `/healthz` while the TCP proxy forwards to 5433; Mason itself does not read `PORT`.
- **`RAILWAY_RUN_UID=0`.** "Volumes are mounted as the root user"; the image runs as `node`, which could not write the
  volume. With it the container runs as root, which is what Railway documents for a non-root image. Everything in the
  container is then root, the server and the shell alike, so a file `mason user add` writes in the shell is one the
  server can read (on a platform whose shell is root and whose server is not, it would not be: `deploy/aws-ecs/README.md`).
- **The TCP proxy forwards the bytes to 5433**; Railway's page does not say it ends TLS, and Mason's own TLS
  (`MASON_PG_SELF_SIGNED_TLS=1`) is what the client sees. The CLI makes the same proxy: `railway tcp-proxy create --port 5433`.
- **The volume holds the copy, Mason's state and the project folder** (`MASON_PROJECT=/mason/data/project`), so a table
  `mason add` adds beside the server survives a redeploy. Its region is the service's, chosen once (a volume does not
  move): the region nearest your database. Default sizes: 5 GB on Hobby, 50 GB on Pro, extendable (live),
  never shrunk; 3,000 read and 3,000 write IOPS whatever the size. To ship your committed `mason/` folder instead, build
  an image that carries it ([`deploy/fly/README.md`](../fly/README.md#the-project-folder) has the two-line Dockerfile)
  and remove `MASON_PROJECT`.
- **Memory**: `MASON_DUCKDB_MEMORY` is said explicitly (4 GB). Left unset, the copy takes half of the limit it reads
  from the container, and what Railway's container shows there is not documented: `mason doctor` in the service's shell
  says what the copy may use; if it shows the machine's RAM rather than the plan's limit, set it to half the plan's
  limit yourself. Pro allows up to 24 GB a replica; raise the copy's share with the plan, keeping about half for the
  page cache ([`deploy/mason-data/README.md`](../mason-data/README.md#memory)).
- **Your database**: what polling and replication each need: [`deploy/mason-data/README.md`](../mason-data/README.md#your-database).
  A Railway service's egress address is shared; a database that allows only known addresses needs Railway's static
  outbound IPs (a plan feature) or a database on Railway's private network.

## Where each claim is from

- Config as Code deprecated, the 2026-12-01 cutoff, what IaC manages: https://docs.railway.com/infrastructure-as-code
- `image(…)`, `env`, `volume(…)`, `volumeMounts`, `healthcheck`, `replicas`: https://docs.railway.com/infrastructure-as-code/reference
- one volume per service, no replicas with a volume, one active deployment, downtime on redeploy, sizes and IOPS:
  https://docs.railway.com/reference/volumes
- mounted as root, `RAILWAY_RUN_UID=0`, `RAILWAY_VOLUME_MOUNT_PATH`: https://docs.railway.com/guides/volumes
- the health check on `PORT`, set `PORT` by hand, 300 s default: https://docs.railway.com/reference/healthchecks
- SIGTERM, 0 s then SIGKILL, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`: https://docs.railway.com/reference/deployments
- TCP proxy, the generated domain and port: https://docs.railway.com/reference/tcp-proxy
- deploying a public image, GitHub Container Registry: https://docs.railway.com/guides/services
- `railway ssh`, `railway tcp-proxy create --port`, `railway variable set`: https://docs.railway.com/reference/cli-api
- 24 GB a replica on Pro: https://docs.railway.com/reference/scaling
