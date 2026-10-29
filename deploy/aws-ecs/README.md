# Mason on AWS

**The simplest, and what Mason was measured on: one EC2 instance running [`deploy/mason-data/compose.yml`](../mason-data/README.md).**
An m7g.xlarge (4 vCPU Graviton3, 15 GiB) with an EBS gp3 volume, Docker installed, the compose file and its `.env`
copied in, `docker compose up -d`; the copy is the compose volume on the instance's EBS disk, a block device. For one
container on one machine, a scheduler adds nothing. Give the instance an Elastic IP, or a Network Load Balancer with a
TCP listener on 5433, for the tools.

The rest of this folder is the same container as an ECS task on such an instance, for a team that runs everything on ECS.

## Why ECS on EC2, not Fargate

The copy needs a persistent block device. Fargate has none: its storage is ephemeral (20 to 200 GiB of bind-mount
space that ends with the task), EFS is NFS (a network filesystem, which the copy does not support), and the EBS volumes
ECS attaches to tasks "must be a new volume … You can't attach an existing Amazon EBS volume to a task", and for a
service they "aren't preserved and are always deleted upon task termination". A redeploy would copy every table again.
On EC2 the instance mounts an EBS volume and the task bind-mounts it (`host.sourcePath`): the data is "tied to the
lifecycle of the host Amazon EC2 instance", which is what Mason wants.

## The ECS task

What to make, in order; each step is AWS's own page, cited, because the console or your Terraform makes it:

1. **Secrets** in SSM Parameter Store, read by the task at start:

   ```bash
   aws ssm put-parameter --name /mason/DATABASE_URL --type SecureString --value 'postgres://mason_reader:…@db.example.com:5432/app'
   aws ssm put-parameter --name /mason/MASON_API_KEY --type SecureString --value "$(openssl rand -hex 24)"
   ```

2. **Roles**: the container instance role `ecsInstanceRole` with `AmazonEC2ContainerServiceforEC2Role`, as an instance
   profile ([instance IAM role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/instance_IAM_role.html)); the
   task execution role (`executionRoleArn`) with `AmazonECSTaskExecutionRolePolicy` plus `ssm:GetParameters` on the two
   parameters and `kms:Decrypt` on their key when it is not the default
   ([secrets from Parameter Store](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specifying-sensitive-data-parameters.html));
   the task role (`taskRoleArn`) with the four `ssmmessages:*` actions ECS Exec needs
   ([ECS Exec permissions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html#ecs-exec-required-iam-permissions)).
3. **A security group** for the instance: 5433 in from the tools (or from the NLB), 4140 in from the VPC only (the
   NLB's health check, if one), nothing else in; out to the database and to AWS's endpoints.
4. **The cluster**, a **launch template** and an **Auto Scaling group of one**: `aws ecs create-cluster --cluster-name mason`;
   the template is the ECS-optimized Amazon Linux 2023 AMI (arm64 for an m7g), the instance profile from step 2, the
   security group, a second gp3 EBS volume mapped at `/dev/sdf` for the copy, and [`user-data.sh`](user-data.sh) as its
   user data ([launching a container instance](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/launch_container_instance.html);
   the group as the cluster's [capacity provider](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/asg-capacity-providers.html),
   or plain instances that join through user data, both work). Min, max and desired are 1, in one Availability Zone.
5. **The task definition and the service**, from this folder after editing the account, region and role ARNs:

   ```bash
   cd deploy/aws-ecs
   aws ecs register-task-definition --cli-input-json file://task-definition.json
   aws ecs create-service --cli-input-json file://service.json
   ```

6. **Commands beside the server**, through ECS Exec. It runs as root, and every `mason` command means the project of
   the folder it runs in, so each command changes to the data folder and drops to `node`:

   ```bash
   TASK=$(aws ecs list-tasks --cluster mason --service-name mason-data --query 'taskArns[0]' --output text)
   aws ecs execute-command --cluster mason --task "$TASK" --container mason --interactive \
     --command "sh -c 'cd /mason/data && runuser -u node -- mason tables'"
   aws ecs execute-command --cluster mason --task "$TASK" --container mason --interactive \
     --command "sh -c 'cd /mason/data && runuser -u node -- mason add public.orders'"
   aws ecs execute-command --cluster mason --task "$TASK" --container mason --interactive \
     --command "sh -c 'cd /mason/data && runuser -u node -- mason user add metabase'"   # the BI tool's user: URL and password, printed once
   ```

A tool connects to the instance's address (its Elastic IP, or the NLB) on 5433 with `sslmode=require`, as the user
`mason user add` printed.

- **One task, and the old one stops before the new one starts.** `desiredCount: 1` with `minimumHealthyPercent: 0` and
  `maximumPercent: 100`: the scheduler may run zero tasks during a deployment and never more than one, so it stops the
  running task, then starts the new one on the same bind mount. With the defaults (50 and 200) the scheduler would try to
  start the new task first; on one instance with a static host port 5433 it cannot place it, so the deployment stalls
  rather than overlapping. Min 0 / max 100 is what makes it stop the old task first. The circuit breaker rolls back a
  task that never becomes healthy.
- **The volume is the instance's.** `/mnt/mason` is the second EBS volume of the launch template, mounted by
  `user-data.sh` (formatted when blank, left alone when not), and the task bind-mounts it at `/mason/data`. A replaced
  instance gets a new, empty volume from the template, so the next start copies every table again: Mason loses no data
  by it, only the time of a copy. Keeping one volume across replacements means attaching a tagged volume by instance id
  in the user data (`ec2:DescribeVolumes`, `ec2:AttachVolume` on the instance role, the volume in the group's one zone, a
  wait for the device); this folder does not do it. One instance in the cluster, so the task has one place to run; a
  cluster of several instances would need a placement constraint on the one with the volume (not shown). A Docker volume
  with a third-party EBS driver (`dockerVolumeConfiguration`, EC2 only) is the other route; none is named here because
  none was verified.
- **Why `runuser -u node`**: ECS Exec runs commands as root whatever user the container sets. `mason user add` writes a
  new `users.json` (a temporary file renamed over it), so run as root it would leave a root-owned file the server, which
  runs as `node`, cannot read, and every login would then fail. `runuser` is in the image (util-linux). The same goes for
  `mason add`, which writes the sources file. Fly's console takes `-u node`, Kubernetes runs `kubectl exec` as the pod's
  user 1000, and on Railway the container itself is root (`RAILWAY_RUN_UID=0`), so none of the three has this problem.
- **`cd /mason/data`**: every `mason` command means the project of the folder it runs in (the nearest `.mason/`), and
  ECS Exec documents no working directory. The data folder is the image's `WORKDIR`, which `docker compose exec` and
  `kubectl exec` start in; a shell that does not needs the `cd`.
- **`stopTimeout: 60`** in the task definition is what applies: SIGTERM is `mason serve`'s stop (a copy in flight
  interrupted and rolled back), and the default is 30 s, after which the container is killed. The instance's
  `ECS_CONTAINER_STOP_TIMEOUT=60s` applies only to a container whose task definition sets none; it is set so a task
  definition that forgets gets the same answer. (Fargate caps `stopTimeout` at 120 s; EC2 reads the agent's setting.)
- **The health check** runs `fetch` inside the container, as the image's own `HEALTHCHECK` does (the image has no curl):
  every 15 s, 5 s timeout, 3 retries, and a `startPeriod` of 120 s for the first start (~15 s on an idle instance,
  minutes on a loaded one; 300 is the maximum). `/healthz` is 503 while it starts, 200 once it serves.
- **Memory**: the container's hard limit is 12288 MiB and `MASON_DUCKDB_MEMORY=6GB` is half of it; on an instance of its
  own, the task may have most of the instance (the measured machine ran with no limit on 15 GiB). Change the two
  together; [`deploy/mason-data/README.md`](../mason-data/README.md#memory) says how much.
- **The project folder** is on the volume (`MASON_PROJECT=/mason/data/project`), so a table `mason add` adds survives a
  deployment. To ship your committed `mason/` instead, build an image that carries it
  ([`deploy/fly/README.md`](../fly/README.md#the-project-folder) has the two-line Dockerfile) and drop `MASON_PROJECT`.
- **The network**: `bridge` mode with host ports 5433 and 4140 on the instance. The database allows the instance's
  address.

## Where each claim is from

- `minimumHealthyPercent`, `maximumPercent`, the circuit breaker: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html
- ECS-managed EBS volumes: new only, deleted when a service's task stops; Fargate storage:
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ebs-volumes.html
- bind mounts, `host.sourcePath`, "tied to the lifecycle of the host", Fargate's 20 to 200 GiB:
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/bind-mounts.html
- Docker volumes EC2 only, `dockerVolumeConfiguration`: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/docker-volumes.html
  and https://docs.aws.amazon.com/AmazonECS/latest/developerguide/specify-volume-config.html
- `stopTimeout` (default 30 s; Fargate max 120; on EC2 the agent's `ECS_CONTAINER_STOP_TIMEOUT` applies when it is
  unset), `memory`, `healthCheck` (interval 5–300, timeout 2–60, retries 1–10, startPeriod 0–300), `secrets`:
  https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html and
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html
- `ECS_CONTAINER_STOP_TIMEOUT` (default 30s): https://github.com/aws/amazon-ecs-agent/blob/master/README.md
- ECS Exec: `--enable-execute-command`, `execute-command`, "these commands are run as the `root` user":
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html
- the instance role, the task role's ECS Exec permissions, secrets from Parameter Store, launching an instance, capacity
  providers: linked at each step above
- the measured instance (m7g.xlarge, EBS gp3): [`deploy/mason-data/README.md`](../mason-data/README.md#cpu-disk-and-the-instance)
