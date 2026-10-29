# Mason on AWS

**The simplest, and what Mason was measured on: one EC2 instance running [`deploy/mason-data/compose.yml`](../mason-data/README.md).**
An m7g.xlarge (4 vCPU Graviton3, 15 GiB) with an EBS gp3 volume, Docker installed, the compose file and its `.env`
copied in, `docker compose up -d`; the copy is the compose volume on the instance's EBS disk, a block device. For one
container on one machine, a scheduler adds nothing. Put the instance in an Auto Scaling group of one if you want it
replaced when it dies (the data volume, a second EBS volume, is re-attached and mounted by `user-data.sh` below), and
give it an Elastic IP or a Network Load Balancer with a TCP listener on 5433 for the tools.

The rest of this folder is the same container as an ECS task on that instance, for a team that runs everything on ECS.

## Why ECS on EC2, not Fargate

The copy needs a persistent block device. Fargate has none: its storage is ephemeral (20 to 200 GiB of bind-mount
space that ends with the task), EFS is NFS (file locking and random reads the copy cannot work on), and the EBS volumes
ECS attaches to tasks "must be a new volume … You can't attach an existing Amazon EBS volume to a task", and for a
service they "aren't preserved and are always deleted upon task termination". A redeploy would copy every table again.
On EC2 the instance mounts an EBS volume and the task bind-mounts it (`host.sourcePath`): the data is "tied to the
lifecycle of the host Amazon EC2 instance", which is what Mason wants.

## The ECS task

```bash
cd deploy/aws-ecs
aws ssm put-parameter --name /mason/DATABASE_URL --type SecureString --value 'postgres://mason_reader:…@db.example.com:5432/app'
aws ssm put-parameter --name /mason/MASON_API_KEY --type SecureString --value "$(openssl rand -hex 24)"
aws ecs create-cluster --cluster-name mason
# an Auto Scaling group of ONE ECS-optimized instance (arm64 for an m7g) with a second gp3 volume at /dev/sdf and
# user-data.sh as its user data: it joins the cluster and mounts the volume at /mnt/mason
aws ecs register-task-definition --cli-input-json file://task-definition.json     # edit the ARNs and region first
aws ecs create-service --cli-input-json file://service.json
aws ecs execute-command --cluster mason --task <task-id> --container mason --interactive --command "mason tables"
aws ecs execute-command --cluster mason --task <task-id> --container mason --interactive --command "mason add public.orders"
aws ecs execute-command --cluster mason --task <task-id> --container mason --interactive --command "mason user add metabase"
```

A tool connects to the instance's address (Elastic IP, or an NLB with a TCP listener on 5433 to the instance) with
`sslmode=require`, as the user `mason user add` printed.

- **One task, and the old one stops before the new one starts.** `desiredCount: 1` with `minimumHealthyPercent: 0` and
  `maximumPercent: 100`: the scheduler may run zero tasks during a deployment and never more than one, so it stops the
  running task, then starts the new one on the same bind mount. The defaults (50 and 200) would start the new task
  beside the old one, on the same volume. The circuit breaker rolls back a task that never becomes healthy.
- **The volume is the instance's.** `/mnt/mason` is an EBS volume the instance mounts (`user-data.sh`), the task
  bind-mounts it at `/mason/data`. One instance in the cluster, so the task has one place to run; a cluster of several
  instances would need a placement constraint on the one with the volume (not shown). A Docker volume with a third-party
  EBS driver (`dockerVolumeConfiguration`, EC2 only) is the other route; none is named here because none was verified.
- **`stopTimeout: 60`** in the task definition and `ECS_CONTAINER_STOP_TIMEOUT=60s` on the instance: SIGTERM is
  `mason serve`'s stop (a copy in flight interrupted and rolled back); the default is 30 s, after which the container is
  killed. (Fargate caps it at 120 s; EC2 reads the agent's setting.)
- **The health check** runs `fetch` inside the container, as the image's own `HEALTHCHECK` does (the image has no curl):
  every 15 s, 5 s timeout, 3 retries, and a `startPeriod` of 120 s for the first start (~15 s on an idle instance,
  minutes on a loaded one; 300 is the maximum). `/healthz` is 503 while it starts, 200 once it serves.
- **Memory**: the container's hard limit is 12288 MiB and `MASON_DUCKDB_MEMORY=6GB` is half of it; on an instance of its
  own, the task may have most of the instance (the measured machine ran with no limit on 15 GiB). Change the two
  together; [`deploy/mason-data/README.md`](../mason-data/README.md#memory) says how much.
- **Secrets** come from SSM Parameter Store (`secrets` with `valueFrom`); the execution role needs `ssm:GetParameters`
  on them. `enableExecuteCommand` needs the task role to allow `ssmmessages:*`; ECS Exec runs commands as root, so a file
  it writes in the volume is root's (`mason user add` rewrites an existing file and is fine; prefer adding tables to the
  committed project folder).
- **The project folder** is on the volume (`MASON_PROJECT=/mason/data/project`), so a table `mason add` adds survives a
  deployment. To ship your committed `mason/` instead, build an image that carries it
  ([`deploy/fly/README.md`](../fly/README.md#the-project-folder) has the two-line Dockerfile) and drop `MASON_PROJECT`.
- **The network**: `bridge` mode with host ports 5433 and 4140 on the instance; its security group allows 5433 from the
  tools and 4140 from nothing outside (the NLB's health check, if one). The database allows the instance's address.

## Where each claim is from

- `minimumHealthyPercent`, `maximumPercent`, the circuit breaker: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html
- ECS-managed EBS volumes: new only, deleted when a service's task stops; Fargate storage:
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html
- bind mounts, `host.sourcePath`, "tied to the lifecycle of the host": https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html
- Docker volumes EC2 only, `dockerVolumeConfiguration`: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/docker-volumes.html
  and https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specify-volume-config.html
- `stopTimeout` (default 30 s; Fargate max 120; EC2 reads `ECS_CONTAINER_STOP_TIMEOUT`), `memory`, `healthCheck`
  (interval 5–300, timeout 2–60, retries 1–10, startPeriod 0–300), `secrets`:
  https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html and
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
- `ECS_CONTAINER_STOP_TIMEOUT` (default 30s): https://github.com/aws/amazon-ecs-agent/blob/master/README.md
- ECS Exec: `--enable-execute-command`, `execute-command`, runs as root, the task role's SSM permissions:
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html
- the measured instance (m7g.xlarge, EBS gp3): [`deploy/mason-data/README.md`](../mason-data/README.md#cpu-disk-and-the-instance)
