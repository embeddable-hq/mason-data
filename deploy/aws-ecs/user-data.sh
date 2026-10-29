#!/bin/bash
# THE CONTAINER INSTANCE for deploy/aws-ecs/task-definition.json: an ECS-optimized Amazon Linux 2023 AMI (arm64 for an
# m7g), in an Auto Scaling group of exactly one, with a second EBS volume (gp3) attached as /dev/sdf for the copy.
# It joins the cluster, gives a stopping container 60 s, mounts the data volume at /mnt/mason and hands it to uid 1000,
# the image's `node` user. Idempotent: a replaced instance re-attaches the same volume and finds its filesystem.
set -euo pipefail

cat >> /etc/ecs/ecs.config <<'ECS'
ECS_CLUSTER=mason
ECS_CONTAINER_STOP_TIMEOUT=60s
ECS
# https://github.com/aws/amazon-ecs-agent/blob/master/README.md: ECS_CONTAINER_STOP_TIMEOUT, "time to wait for the
# container to exit normally before being forcibly killed", default 30s; the task definition's stopTimeout says 60 too.

# On a Nitro instance the volume attached as /dev/sdf is /dev/nvme1n1; Amazon Linux's udev rules make /dev/sdf a link
# to it, which readlink follows.
dev=$(readlink -f /dev/sdf)
# blkid exits 2 when the device has no filesystem yet (a new volume): make one. Any other exit is a real error and stops
# the script (set -e), not a reformat.
if ! blkid -p "$dev" > /dev/null; then
  [ $? -eq 2 ] || exit 1
  mkfs.xfs "$dev"
fi
mkdir -p /mnt/mason
uuid=$(blkid -s UUID -o value "$dev")
grep -q " /mnt/mason " /etc/fstab || echo "UUID=$uuid /mnt/mason xfs defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /mnt/mason || mount /mnt/mason
chown 1000:1000 /mnt/mason
