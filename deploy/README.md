# Deploying Mason

Mason in production is one container, `mason serve`, with its copy on one volume and two ports. A platform fits when it
gives those three things; this folder has a guide for each that does, and says which do not and why.

## Which to choose

Mason has no source-address rule of its own: whoever reaches port 5433 is met by TLS and a password, and nothing else.
For a copy of a production database, what decides the platform is whether something in front of that port can limit it
to addresses you name ([who can reach the Postgres port](#who-can-reach-the-postgres-port)).

- **Your Postgres is in AWS: [EC2](aws-ecs/README.md) in the same VPC.** The database need have no public route, and a
  security group limits 5433 to the addresses you name.
- **Your Postgres is elsewhere, or you have no cloud account: a VM with a provider firewall**, such as DigitalOcean.
  **We have not run Mason on DigitalOcean yet**, so it has no guide here and no "yes, measured" in the table below;
  what follows is from its documentation. A Droplet with a Cloud Firewall, which drops what no rule allows before it
  reaches the Droplet, and the copy and every secret on a Volume, because a Droplet's local disk is not encrypted at
  rest and Volumes are. With [the compose file](mason-data/README.md) that means moving both: its named volume is in
  Docker's data directory, on the local disk unless `data-root` points at the Volume, which moves images and every
  container's writable layer too; and `.env`, which compose reads from the compose file's folder, so keep that whole
  folder on the Volume. A Volume is network-attached block storage, which meets Mason's need for a block device; we
  have not measured it.
- **Fly.io and Railway: for trials on non-sensitive data, or where clients can join the private network.** Neither can
  limit a public port by source address.

## What every platform must give

From [`deploy/mason-data/README.md`](mason-data/README.md) and `mason serve --help`:

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
| [Fly.io](fly/README.md) | **yes, with no source-address limit** | a Fly Volume is NVMe on the Machine's host, one Machine per volume; a raw TCP service with no handler, which needs a dedicated IPv4 (paid) for IPv4 clients; `rolling` on one Machine is stop, update, start |
| [Kubernetes](kubernetes/README.md) ([Helm chart](helm/mason-data/README.md)) | **yes, with a block StorageClass** | a StatefulSet of one replica recreates the pod on its PVC; a TCP LoadBalancer for 5433; a disk class (`kubectl get storageclass`), never a file-share or NFS class |
| [Railway](railway/README.md) | **yes, with no source-address limit** | one volume per service, replicas refused with a volume, the old deployment stopped before the new one; a TCP proxy to 5433; `PORT=4140` for its health check |
| Render | **no** (public) | public traffic reaches "only one HTTP port per web service"; a private service may listen on any protocol but is "not reachable via the public internet", so its TCP serves only tools inside Render's private network; a persistent disk exists (and forbids multiple instances and zero-downtime deploys, which Mason wants anyway) |
| Google Cloud Run | **no** | a service's ingress is HTTP (HTTP/1 or gRPC at the container); the file system is in memory and the volumes it mounts are Cloud Storage FUSE, NFS or in-memory, none a block device |
| Heroku | **no** | the dyno's filesystem is ephemeral ("Any files written get discarded the moment the dyno stops or restarts") and the router lists TCP routing as not supported |
| Vercel | **no** | functions with a read-only filesystem, a 500 MB `/tmp` and a maximum duration: no long-running TCP server, no volume |
| Anything else | **as the rule says** | no persistent block volume, or no public raw TCP port, is no |

Each guide is a runnable configuration with every platform claim cited to the platform's documentation, plus a README of
what to run and what to decide; what it does not verify, it says.

## Who can reach the Postgres port

Whether 5433 can be limited to the source addresses you name is the platform's to give, not Mason's. Where it is
"no", a public port is open to the internet, guarded only by TLS and a password.

| Platform | Limit 5433 by source address? | How |
|---|---|---|
| AWS: EC2 with Compose, or ECS on EC2 | **yes** | a security group on the instance: 5433 in from the tools' CIDRs. A Network Load Balancer in front moves the rule. With no security group of its own it lets all client traffic reach its listeners, and what the instance then sees depends on the target type (instance targets keep an IPv4 client's address; TCP IP targets give the NLB's private address by default). So give the NLB a security group **when you create it** (one cannot be added later), name the clients' CIDRs there, and let the instance's group reference the NLB's on 5433 and the health-check port, which also closes the direct path to the instance |
| Kubernetes | **where the provider honours it** | `loadBalancerSourceRanges` on the `mason-pg` Service (commented in [`service.yaml`](kubernetes/service.yaml); `pgService.loadBalancerSourceRanges` in the [chart](helm/mason-data/README.md)). The field is **ignored** where the provider does not support it, so connect from an unlisted address to prove it. GKE makes it a VPC firewall rule, AKS an NSG rule and a host rule, and DOKS supports it. On EKS the AWS Load Balancer Controller recommends it, but AWS says an NLB in IP mode ignores it unless client IP preservation is on On a dual-stack NLB, a client converted between IPv4 and IPv6 arrives as the NLB's private address and passes the list even with client IP preservation on, so prove it over both. |
| Docker Compose on one machine | **yes, at the provider's firewall** | the compose file publishes 5433 on every address of the machine, and Docker's published ports bypass `ufw` and `firewalld`, so a rule there does not close it. Use the firewall outside the machine: a security group, a Cloud Firewall. On the host itself, a rule in Docker's `DOCKER-USER` chain is what limits it |
| Fly.io | **no** | a public service has no source-address rule, and network policies do not affect traffic through the Fly Proxy, which carries it. The nearest is Flycast with WireGuard: no public address (`fly ips release` each one, skip `fly ips allocate-v4`), `fly ips allocate-v6 --private`, and clients on the organization's private network or on a peer from `fly wireguard create`. We have not run this |
| Railway | **no** | the TCP Proxy has no source-address filter and passes no client address, so nothing behind it can filter either. Edge Rules match client IPs, but HTTP requests only, and the Postgres API is not HTTP. Without a TCP Proxy, only services in the same project environment reach the port. Railway's Tailscale Forwarder is its way in from outside; it needs the service listening on `::`, the image listens on `0.0.0.0` (`MASON_PG_HOST`), and we have not run this |

## Metrics

Every platform gets `GET /metrics` on the health port (4140), beside `/healthz`: Mason's numbers in Prometheus's text
format (tables by phase, the copy's size, the stalest copy's age, the stream's lag, disk free, sessions, statements by
outcome and their p50 / p95). It is numbers only and needs no secret — no table, user, client or host name and no
statement text, not even as a label — so it can stay on the cluster-only port with no auth. A scrape costs your
database nothing: it reads what Mason already holds, never a connection or a query on the source, however often it
is asked. A three-line scrape config:

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

## Where each port limit is from

Each checked 2026-10-30, against the page named.

- AWS: inbound rules decide what reaches an instance https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-security-groups.html;
  an NLB with no security group lets "all client traffic" reach its listeners, a group cannot be added after creation,
  and targets reference it https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-security-groups.html;
  client IP preservation by target type https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html;
  target security groups https://docs.aws.amazon.com/elasticloadbalancing/latest/network/target-group-register-targets.html
- Kubernetes: "If specified and supported by the platform", "ignored if the cloud-provider does not support the feature"
  https://kubernetes.io/docs/reference/kubernetes-api/service-resources/service-v1/; GKE
  https://docs.cloud.google.com/kubernetes-engine/docs/concepts/service-load-balancer-parameters; AKS
  https://learn.microsoft.com/en-us/azure/aks/configure-load-balancer-standard; DOKS
  https://docs.digitalocean.com/notes/2024/kubernetes-loadbalancersourceranges; EKS
  https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/annotations/ and, for IP mode,
  https://repost.aws/knowledge-center/eks-cidr-ip-address-loadbalancer
- Docker: published ports "bypass your firewall rules" with ufw or firewalld https://docs.docker.com/engine/install/ubuntu/,
  and why https://docs.docker.com/engine/network/packet-filtering-firewalls/; all external sources allowed by default,
  and `DOCKER-USER` https://docs.docker.com/engine/network/firewall-iptables/; the data directory and `data-root`
  https://docs.docker.com/engine/daemon/
- Fly.io: no source-address rule in https://docs.fly.io/networking/services; network policies "do not affect traffic
  routed through the Fly Proxy" https://docs.fly.io/machines/guides-examples/network-policies; Flycast
  https://docs.fly.io/networking/flycast; WireGuard peers https://docs.fly.io/networking/private-networking and
  https://docs.fly.io/blueprints/connect-private-network-wireguard
- Railway: no source-address filter in https://docs.railway.com/networking/tcp-proxy, which says nothing of the client's
  address either; both come from a Railway employee's forum answer of 2026-04-13, "no mechanism to retrieve the original
  client IP", allowlisting a tracked request
  (https://station.railway.com/questions/restrict-tcp-proxy-to-specific-ip-addres-c296cf01). Edge Rules "match incoming
  HTTP requests" and "require a public domain" https://docs.railway.com/networking/edge-rules; the private network
  https://docs.railway.com/networking/private-networking/how-it-works; the Forwarder
  https://railway.com/guides/set-up-a-tailscale-forwarder
- DigitalOcean: "not encrypted at rest" for a Droplet's local disk
  https://www.digitalocean.com/security/shared-responsibility-model-droplets; Volumes "encrypted with LUKS",
  "network-attached block storage" https://docs.digitalocean.com/products/volumes/details/features/; Cloud Firewalls
  stop traffic "before it reaches the server" https://docs.digitalocean.com/products/networking/firewalls/details/,
  sources by address or CIDR https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/
