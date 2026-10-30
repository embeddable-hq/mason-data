# Deploying Mason

Mason in production is one container, `mason serve`, with its copy on one volume and two ports. A platform fits when it
gives those three things; this folder has a guide for each that does, and says which do not and why.

**What every platform must give**, from [`deploy/mason-data/README.md`](mason-data/README.md) and `mason serve --help`:

- **One container, ever.** The copy is one file with one writer: one replica, no autoscaling, and the old container
  stopped before the new one starts (a recreate, never a rolling or blue-green deploy).
- **A persistent block volume** at `/mason/data`: a disk (EBS, NVMe, a cloud's block StorageClass). The copy is one
  file written in place and read at random, and Mason was measured on a block device only; a network filesystem (NFS,
  EFS, Azure Files) is not supported. Losing the volume costs a new copy of the tables, not data.
- **Two ports**: raw TCP 5433 for the Postgres API, public, with Mason's own TLS (`MASON_PG_SELF_SIGNED_TLS=1`, or a
  certificate a CA signed); HTTP 4140 for `GET /healthz`, 503 while it starts (~15 s; the first start can take minutes
  on a loaded machine) and 200 once it serves, and `GET /metrics` ("Metrics", below). A platform that routes only HTTP
  cannot carry the Postgres protocol.
- **SIGTERM with 60 s of grace**, `DATABASE_URL` and `MASON_API_KEY` (at least 32 characters) in the environment, and a
  memory limit with `MASON_DUCKDB_MEMORY` at about half of it ([memory](mason-data/README.md#memory)).

| Platform | Fits | Why |
|---|---|---|
| [Docker Compose on one machine](mason-data/README.md) | **yes, the measured one** | an m7g.xlarge with EBS gp3 is what the numbers in `docs/MEASUREMENTS.md` were taken on; one compose file |
| [AWS: EC2 with Compose, or ECS on EC2](aws-ecs/README.md) | **yes** | an EBS volume the instance mounts, bind-mounted into the task; `minimumHealthyPercent: 0, maximumPercent: 100` stops the old task first. **Fargate: no** — ECS-managed EBS volumes are new at each task and deleted when it stops, EFS is NFS |
| [Fly.io](fly/README.md) | **yes** | a Fly Volume is NVMe on the Machine's host, one Machine per volume; a raw TCP service with no handler, which needs a dedicated IPv4 (paid) for IPv4 clients; `rolling` on one Machine is stop, update, start |
| [Kubernetes](kubernetes/README.md) ([Helm chart](helm/mason-data/README.md)) | **yes, with a block StorageClass** | a StatefulSet of one replica recreates the pod on its PVC; a TCP LoadBalancer for 5433; a disk class (`kubectl get storageclass`), never a file-share or NFS class |
| [Railway](railway/README.md) | **yes** | one volume per service, replicas refused with a volume, the old deployment stopped before the new one; a TCP proxy to 5433; `PORT=4140` for its health check |
| Render | **no** (public) | public traffic reaches "only one HTTP port per web service"; a private service may listen on any protocol but is "not reachable via the public internet", so its TCP serves only tools inside Render's private network; a persistent disk exists (and forbids multiple instances and zero-downtime deploys, which Mason wants anyway) |
| Google Cloud Run | **no** | a service's ingress is HTTP (HTTP/1 or gRPC at the container); the file system is in memory and the volumes it mounts are Cloud Storage FUSE, NFS or in-memory, none a block device |
| Heroku | **no** | the dyno's filesystem is ephemeral ("Any files written get discarded the moment the dyno stops or restarts") and the router lists TCP routing as not supported |
| Vercel | **no** | functions with a read-only filesystem, a 500 MB `/tmp` and a maximum duration: no long-running TCP server, no volume |
| Anything else | **as the rule says** | no persistent block volume, or no public raw TCP port, is no |

Each guide is a runnable configuration with every platform claim cited to the platform's documentation, plus a README of
what to run and what to decide; what it does not verify, it says.

## Metrics

Every platform gets `GET /metrics` on the health port (4140), beside `/healthz`: Mason's numbers in Prometheus's text
format (tables by phase, the copy's size, the stalest copy's age, the stream's lag, disk free, sessions, statements by
outcome and their p50 / p95). It is numbers only and needs no secret — no table, user, client or host name and no
statement text, not even as a label — so it can stay on the cluster-only port with no auth. A three-line scrape config:

```yaml
scrape_configs:
  - job_name: mason
    static_configs: [{ targets: ["mason-health:4140"] }]
```

The Kubernetes Service and the Helm chart carry the `prometheus.io/scrape`, `/port` and `/path` annotations
(`metrics.annotations` in the chart's values). Per-table or per-user detail would need a credential and is not served
there: `mason status` and `mason usage` beside the server say it.

## Where each "no" is from

- Render: web services forward "only _one_ HTTP port" (https://render.com/docs/web-services); private services "aren't
  reachable via the public internet" (https://render.com/docs/private-services); disks: "You can't scale a service to
  multiple instances if it has a disk attached", "Adding a disk to a service prevents zero-downtime deploys"
  (https://render.com/docs/disks). Checked 2026-10-29: no public TCP in these pages.
- Cloud Run: the container contract (HTTP/1 or gRPC at the container, in-memory file system)
  https://docs.cloud.google.com/run/docs/container-contract; volume types (GCS, NFS, EmptyDir, secrets)
  https://docs.cloud.google.com/run/docs/reference/rest/v2/Volume
- Heroku: https://devcenter.heroku.com/articles/dynos (ephemeral filesystem), https://devcenter.heroku.com/articles/http-routing
  ("TCP Routing" under Not Supported)
- Vercel: https://vercel.com/docs/functions/runtimes (file system support, maximum duration)
- Fargate: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html ("must be a new volume",
  "always deleted upon task termination")
