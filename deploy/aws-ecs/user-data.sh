#!/bin/bash
# THE CONTAINER INSTANCE for deploy/aws-ecs/task-definition.json: an ECS-optimized Amazon Linux 2023 AMI (arm64 for an
# m7g), in an Auto Scaling group of exactly one, whose launch template maps a second EBS volume (gp3) at /dev/sdf for
# the copy. It joins the cluster, gives a stopping container 60 s, mounts that volume at /mnt/mason and hands it to
# uid 1000, the image's `node` user.
#
# The volume is the instance's: a REPLACED instance gets a new, empty one from the launch template and the next start
# copies every table again (README.md "The volume is the instance's"). Keeping one volume across replacements means
# attaching a tagged volume by instance id here (ec2:DescribeVolumes and ec2:AttachVolume on the instance role, the
# volume in the group's one Availability Zone, a wait for the device): not done by this script.
set -euo pipefail

cat >> /etc/ecs/ecs.config <<'ECS'
ECS_CLUSTER=mason
ECS_CONTAINER_STOP_TIMEOUT=60s
ECS
# https://github.com/aws/amazon-ecs-agent/blob/master/README.md: ECS_CONTAINER_STOP_TIMEOUT, "time to wait for the
# container to exit normally before being forcibly killed", default 30s. It applies to a container whose task
# definition sets no stopTimeout; ours sets 60, so this is the same answer for a task that forgets it.

# On a Nitro instance the volume attached as /dev/sdf is /dev/nvme1n1; Amazon Linux's udev rules make /dev/sdf a link
# to it, which readlink follows.
dev=$(readlink -f /dev/sdf)
# blkid exits 2 when the device has no filesystem yet (a new volume): make one. 0 is a filesystem to keep. Anything
# else is a real error (no such device, no permission) and stops the script: never a reformat. The status is captured
# before any test of it: `if ! cmd; then … $?` would read the negation's status, always 0.
rc=0
blkid -p "$dev" > /dev/null || rc=$?
case "$rc" in
  0) ;;
  2) mkfs.xfs "$dev" ;;
  *) echo "blkid $dev exited $rc: not formatting, not mounting" >&2; exit 1 ;;
esac
mkdir -p /mnt/mason
uuid=$(blkid -s UUID -o value "$dev")
grep -q " /mnt/mason " /etc/fstab || echo "UUID=$uuid /mnt/mason xfs defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /mnt/mason || mount /mnt/mason
chown 1000:1000 /mnt/mason
