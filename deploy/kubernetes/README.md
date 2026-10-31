# Mason on Kubernetes

A StatefulSet of one pod running `mason serve`, its copy on one PersistentVolumeClaim, the Postgres API behind a TCP
LoadBalancer. The manifests beside this file are the configuration; [`deploy/helm/mason-data/`](../helm/mason-data/README.md)
is the same as a chart.

**First, the project folder**, on a laptop, in your own repository: `mason init` (with `DATABASE_URL` in `.env`), then
`mason add public.orders` for each table; it writes `mason/sources/<name>.yml` and `mason/mason.yml`. Commit `mason/`.
The commands below run in that repository, with `MASON_REPO` a checkout of this one for the manifests.

```bash
kubectl get storageclass                            # a disk class, see "The volume"; the manifests use the default
kubectl create secret generic mason \
  --from-literal=DATABASE_URL='postgres://mason_reader:…@db.example.com:5432/app' \
  --from-literal=MASON_API_KEY="$(openssl rand -hex 24)"
kubectl create configmap mason-project \
  --from-file=sources.yml=mason/sources/app.yml --from-file=mason.yml=mason/mason.yml
kubectl apply -f "$MASON_REPO/deploy/kubernetes/statefulset.yaml" -f "$MASON_REPO/deploy/kubernetes/service.yaml"
                                                    # secret.yaml and configmap.yaml there are the shapes of the two above
kubectl rollout status statefulset/mason           # Ready once /healthz answers 200 (~15 s; minutes on a loaded node)
kubectl exec statefulset/mason -- mason tables
kubectl exec statefulset/mason -- mason user add metabase   # the BI tool's user: URL and password, printed once
kubectl get service mason-pg                        # EXTERNAL-IP: the address a tool connects to, port 5433, sslmode=require
```

- **One replica, a StatefulSet, never an autoscaler.** The copy is one file with one writer, so the old pod must be gone
  before the new one starts on the same volume. A StatefulSet's RollingUpdate does exactly that ("delete and recreate
  each Pod … one at a time", waiting for the new one to be Running and Ready), and a pod's identity, its name and its
  PVC, exists at most once. A Deployment can serve too, with `strategy: Recreate` and nothing else: its default
  RollingUpdate starts the new pod beside the old one, and even a Deployment with Recreate replaces a pod deleted by hand
  "even if the old Pod is still in a Terminating state". That is why Recreate is mandatory for a Deployment, and why the
  StatefulSet is preferred.
- **The volume.** A disk, `ReadWriteOnce` from a block StorageClass; the copy is one file written in place and read at
  random, and a network filesystem (EFS, Azure Files, any NFS class) is not supported. The manifests name no
  `storageClassName`, so the cluster's default class is used: on GKE the default is a balanced persistent disk, on AKS
  `default` is `managed-csi`, a managed disk, both right. EKS Auto Mode creates no StorageClass ("You must create a
  StorageClass", AWS's example is `type: gp3` with `provisioner: ebs.csi.eks.amazonaws.com`), and a cluster whose default
  is a file class is wrong: run `kubectl get storageclass`, and when the default is not a disk, or there is none, set
  `storageClassName` in `statefulset.yaml` (the commented line) to a disk class. A missing class leaves the PVC Pending
  and `kubectl rollout status` waits for ever. The class and the size are decided once: a StatefulSet's
  `volumeClaimTemplates` cannot be changed after creation. The PVC stays when the StatefulSet is deleted ("Deleting
  and/or scaling a StatefulSet down will not delete the volumes"): `kubectl delete pvc data-mason-0` to start over; the
  next start copies the tables again.
- **The project folder is a ConfigMap**, mounted read-only at `/mason/project`: the sources file naming the tables, and
  `mason.yml`. `mason serve` writes nothing there, so `mason add` beside the server is refused; change the ConfigMap and
  `kubectl rollout restart statefulset/mason`: the table is copied (or dropped) at the next start. The chart restarts the
  pod itself when the sources file changes. To let `mason add` work beside the server instead, set
  `MASON_PROJECT=/mason/data/project` and drop the mount: the folder then lives on the volume, uncommitted.
- **Two Services.** `mason-pg`, a LoadBalancer on 5433: a cloud's default is a TCP (layer 4) load balancer, which is
  what the Postgres protocol needs; Mason's own TLS is the TLS. An HTTP Ingress cannot carry it; a TCP-capable ingress
  (ingress-nginx's `tcp-services`, for one) can, with the Service as ClusterIP. `loadBalancerSourceRanges` restricts
  who connects where the provider honours it ([which do](../README.md#who-can-reach-the-postgres-port)). `mason-health`, a ClusterIP on 4140, is `/healthz` and `/metrics` for the cluster (annotated for a Prometheus that
  scrapes by `prometheus.io/*`; numbers only, no secret: [Metrics](../README.md#metrics)), and the StatefulSet's `serviceName`.
- **Probes**: a startup probe of 30 × 10 s allows the first start 5 minutes (it takes ~15 s on an idle node, minutes on
  a loaded one; liveness and readiness run only after it has succeeded once); readiness every 10 s, liveness every
  15 s with 3 failures. `/healthz` is 503 while it starts, 200 once it serves.
- **`terminationGracePeriodSeconds: 60`**: SIGTERM is `mason serve`'s stop (a copy in flight interrupted and rolled
  back); the kubelet sends SIGKILL when it expires. The default is 30 s.
- **The pod runs as uid 1000** (the image's `node`), with `fsGroup: 1000` so the volume is writable whoever the
  provisioner made its owner.
- **Commands beside the server**: `kubectl exec statefulset/mason -- mason <command>`; they run as `node`, in the data
  folder (the image's `WORKDIR`, where every `mason` command finds this project), and mean this project.

## Memory

The container's limit is 8 GiB and `MASON_DUCKDB_MEMORY=4GB` is half of it; change the two together (the default reads
the cgroup limit and takes half, said explicitly here). The request equals the limit, so the pod is never evicted for
memory it was promised. CPU has a request and no limit: one statement may use every core, and a CPU limit would
throttle it. Which size: enough that the page cache holds the columns your dashboards read, memory before cores;
[`deploy/mason-data/README.md`](../mason-data/README.md#memory) has the measurements, `kubectl exec statefulset/mason -- mason doctor`
what the copy may use.

## The Helm chart

From your repository, with `mason/` as above:

```bash
helm install mason "$MASON_REPO/deploy/helm/mason-data" \
  --set database.url='postgres://mason_reader:…@db.example.com:5432/app' --set database.apiKey="$(openssl rand -hex 24)" \
  --set-file project.sources=mason/sources/app.yml --set-file project.masonYml=mason/mason.yml
```

`values.yaml` is the list of decisions: the image, the database (or an existing Secret), the project folder's two
files, the StorageClass (`""` is the cluster's default; set a disk class when that is not one) and size, both decided
once at install, memory and CPU, the Postgres API's Service, TLS (self-signed, or a `kubernetes.io/tls` Secret a CA
signed), and `settings:` for anything else `mason serve --help` lists. One replica, the probes and the grace are not
values.

## Your database

What polling and replication each need, and the network: [`deploy/mason-data/README.md`](../mason-data/README.md#your-database).
The pod's egress address is the node's or the cluster's NAT gateway: allow it in the database's firewall.

## Where each claim is from

- StatefulSet RollingUpdate, volumes kept on deletion, `volumeClaimTemplates`:
  https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
- Deployment `Recreate` ("All existing Pods are killed before new ones are created") and the hand-deleted pod:
  https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- startup probe "a maximum of 5 minutes (30 * 10 = 300s)", liveness takes over after it:
  https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
- `terminationGracePeriodSeconds` default 30 s, SIGTERM then SIGKILL: https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/
- storage classes: EKS Auto Mode creates none, the gp3 example: https://docs.aws.amazon.com/eks/latest/userguide/create-storage-class.html;
  GKE's default class is a balanced persistent disk, `standard-rwo`: https://docs.cloud.google.com/kubernetes-engine/docs/concepts/persistent-volumes;
  AKS's `default` is `managed-csi` (a managed disk), `azurefile-*` are SMB/NFS shares: https://learn.microsoft.com/en-us/azure/aks/concepts-storage
