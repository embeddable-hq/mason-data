# Mason on DigitalOcean

One Droplet running [the compose file](../mason-data/README.md), with the copy and every secret on an encrypted Volume,
and a Cloud Firewall so that only the addresses you name can reach the Postgres port. Mason has no source-address rule of
its own, so the firewall is what keeps the port private.

Use this when your Postgres is not in AWS, or you have no cloud account. If it is in AWS, run Mason in the same VPC
([`deploy/README.md`](../README.md#which-to-choose)).

A person does steps 1, 2 and 10; a coding agent can do
the rest with the `doctl` login from step 2.

## Before you start

- A Postgres URL Mason can read with. Point it at a read replica if you have one, as a poll scans whole tables. The
  user needs `SELECT` on the tables, and Mason writes nothing to it.
- The public addresses of the tools that will connect, as CIDRs. Ask the tool's vendor: a hosted BI tool publishes them.
- The size of your database, to choose the machine:

  ```sql
  SELECT pg_size_pretty(sum(pg_table_size(c.oid))) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema');
  ```

- If your provider has no logical replication, as Heroku Postgres does not, tables sync by polling.

**Which machine.** Memory first, then disk, then cores ([how to size it](../mason-data/README.md#memory)). For scale, a
real deployment on `m-2vcpu-16gb` with a 100 GiB Volume synced 52 tables, 310 M rows and about 200 GiB in Postgres in about
an hour, into 64 GiB. A sync ran on both cores throughout, so more cores would shorten it, and a page cache smaller
than the copy makes the first read of a big table slow. We have not measured `m-4vcpu-32gb`.

## 1. Make the account, and see what it allows

Sign up, and add a payment method. **A new account starts on a low tier**: on 2026-10-30 one could make `m-2vcpu-16gb` and
a 100 GiB Volume, but not `m-4vcpu-32gb` or a larger Volume. To go past that, open a support ticket, or prepay
([resource limits](https://docs.digitalocean.com/platform/resource-limits/)). You can start small and resize later:
a Droplet grows with a short restart and a Volume grows in place, and neither syncs again.

## 2. Install `doctl` and log in

Make a token in the control panel, under API, with an expiry and custom scopes if offered: read and write for Droplets,
block storage, firewalls and SSH keys. Keep it out of chats and logs. It is shown once.

```bash
brew install doctl
doctl auth init --context mason     # paste the token at the prompt
doctl auth switch --context mason
doctl account get
```

`doctl` keeps the token in plain text in its config file. Revoke it in the control panel when the server is up.

## 3. Choose the sizes

```bash
doctl compute size list --format Slug,VCPUs,Memory,Disk,PriceMonthly
doctl compute region list --format Slug,Available
```

The size list can be partial: a size in a region's list may still be refused. The real test is step 5.

## 4. Write the first-boot script

Save this as `cloud-init.sh`. It puts Docker's data on the Volume, because a Droplet's local disk is not encrypted at rest
and a compose volume lives in Docker's data directory.

```bash
#!/bin/bash
set -eu
for i in $(seq 1 60); do mountpoint -q /mnt/mason && break; sleep 2; done
mountpoint -q /mnt/mason || { echo "volume not mounted" >&2; exit 1; }
install -d -m 700 /mnt/mason/deploy /mnt/mason/docker
install -d -m 755 /etc/docker
printf '{ "data-root": "/mnt/mason/docker" }\n' > /etc/docker/daemon.json
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y docker.io docker-compose-v2
systemctl enable --now docker
```

## 5. Create the Volume, the Droplet and the firewall

Put the values in one place. `TOOL_CIDRS` are the addresses that may reach Mason, and `MY_IP` is yours, for SSH.

```bash
REGION=nyc3 SIZE=m-2vcpu-16gb VOLUME_GB=100
MY_IP=$(curl -s https://checkip.amazonaws.com)

KEY=$(doctl compute ssh-key import mason-admin --public-key-file ~/.ssh/id_ed25519.pub --format ID --no-header)
VOL=$(doctl compute volume create mason --region $REGION --size ${VOLUME_GB}GiB --fs-type ext4 --fs-label mason \
  --format ID --no-header)
DROP=$(doctl compute droplet create mason --region $REGION --size $SIZE --image ubuntu-24-04-x64 \
  --ssh-keys "$KEY" --volumes "$VOL" --tag-name mason --enable-monitoring \
  --user-data-file cloud-init.sh --wait --format ID --no-header)
doctl compute firewall create --name mason --droplet-ids "$DROP" \
  --inbound-rules "protocol:tcp,ports:5433,address:203.0.113.10/32 protocol:tcp,ports:22,address:$MY_IP/32" \
  --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0"
IP=$(doctl compute droplet get "$DROP" --format PublicIPv4 --no-header)
```

Replace `203.0.113.10/32` with your tool's address, one `protocol:tcp,ports:5433,address:…` for each. Never allow port
4140: `/healthz` and `/metrics` stay on the machine, as the compose file publishes them on loopback. Use Cloud Firewall,
not `ufw`, because Docker's published ports bypass `ufw`.

Wait for the first boot, then check that the Volume is mounted and Docker's data is on it:

```bash
ssh root@$IP 'cloud-init status --wait; df -h /mnt/mason | tail -1; docker info --format "{{.DockerRootDir}}"'
```

## 6. Put Mason on the Volume

Everything goes in `/mnt/mason/deploy`, so `.env` is on the Volume too. **`mason/` must belong to uid 1000**, because the
container runs as `node`.

```bash
curl -fsSL https://raw.githubusercontent.com/embeddable-hq/mason-data/main/deploy/mason-data/compose.yml \
  | ssh root@$IP 'umask 077; cd /mnt/mason/deploy; cat > compose.yml; mkdir -p mason; chown 1000:1000 mason; chmod 755 mason
    { printf "MASON_API_KEY=%s\n" "$(openssl rand -hex 24)"; printf "MASON_PG_SELF_SIGNED_TLS=1\nMASON_TAG=<the release>\n"; } > .env'
```

`MASON_TAG` pins the release you run. Then send the database's URL straight to the server, so it never appears in your
terminal, your shell history or a chat. For a URL with no `?` in it:

```bash
<a command that prints the URL> | ssh root@$IP 'umask 077; read -r URL
  printf "DATABASE_URL=%s?sslmode=require\n" "$URL" >> /mnt/mason/deploy/.env'
```

On Heroku that command is `heroku config:get <THE_FOLLOWER_URL_VAR> -a <app>`; `heroku pg:info -a <app>` names the follower.
Say `sslmode=require` yourself, as Mason's default is `prefer`.

## 7. Start it and choose the tables

```bash
ssh root@$IP
cd /mnt/mason/deploy
docker compose up -d
curl -s localhost:4140/healthz          # 503 for the first ~15 s, then 200
docker compose exec mason mason tables  # what the database has, with each table's rows
docker compose exec mason mason add public.orders public.customers
```

`mason add` starts the copy at once, and takes a list. Add the small tables first, so something is ready early. It leaves
out columns that look like secrets, and says so: name one with `--include` to have it. A table with no primary key needs
`--key <columns>`, which only you can choose.

`mason status` shows the progress. A table that fails does not stop the others, and is tried again.

## 8. Say how each table stays current

Every table starts at `sync: off`. Write the interval at the top of `mason/sources/<name>.yml`, and a slower one for each
big table, since each poll scans the table whole:

```bash
docker compose exec mason mason add public.big_table --sync "poll 1h"
```

Start with `poll 15m` at the top and `poll 1h` for tables over a few GiB, then shorten them once you have seen what a poll
costs. Commit `mason/` to your own repository.

## 9. Make the tool's user, and prove the firewall

Keep the password out of your terminal's history:

```bash
umask 077; docker compose exec -T mason mason user add <tool> --json > <tool>.credentials
```

From a machine that is **not** on the list, the Postgres port must not answer:

```bash
nc -z -G 6 -w 6 $IP 5433; echo $?       # 1: blocked, as it should be
```

Then check a login from the server itself, over TLS, with the `url` in that file.

## 10. Connect the tool

A person does this. Read the password when you need it:

```bash
ssh root@$IP "python3 -c \"import json;print(json.load(open('/mnt/mason/deploy/<tool>.credentials'))['password'])\""
```

Enter host `$IP`, port `5433`, database `mason`, the user, the password, and SSL required (`sslmode=require`). The
certificate is self-signed: it encrypts, and proves nothing about whose server it is.

## 11. Close up

```bash
doctl compute firewall remove-rules <firewall-id> --inbound-rules "protocol:tcp,ports:22,address:$MY_IP/32"
```

Add it back when you need to log in. Revoke the `doctl` token, and keep a note of what `.env` and the Volume hold.

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `This size is currently restricted, please open a ticket to increase your account tier` | The account's tier does not include that size | Open a ticket or prepay ([step 1](#1-make-the-account-and-see-what-it-allows)), or start on a size in the account's list and resize |
| `failed to create volume: invalid size specified` | Usually the tier again, not the format: a new account stopped at about 100 GiB | Create it at 100 GiB, and resize when the tier rises |
| The container restarts, with `EACCES: permission denied, mkdir '/mason/project/sources'` | `mason/` belongs to root | `chown -R 1000:1000 /mnt/mason/deploy/mason`, then `docker compose up -d` |
| `Out of Memory Error: failed to allocate data …` on one table in a first sync | Large JSON documents hold more than the engine's limit, which is half the machine. Fewer readers may not help | Add `MASON_DUCKDB_MEMORY=12GB` to `.env` on a 16 GB machine, `docker compose up -d`, and remove it when the table is in. The other tables carry on meanwhile |
| SSH times out, and the Droplet shows `active` | Your own address changed, so the firewall blocks you | `curl -s https://checkip.amazonaws.com`, then add a rule for it and remove the old one |
| A tool gets `3D000 database … does not exist` | The database name is `mason`, not your source's | Connect with `mason`, or write `database: <name>` at the top of the sources file |
| A tool gets `28000` asking for TLS, or a certificate error | It connected without TLS, or verifies the certificate | Use `sslmode=require`. node-postgres needs `uselibpqcompat=true&sslmode=require` |
| A table is missing from `mason add` | It has no primary key | `mason add <table> --key <columns>` |
| A column is missing from a table | It looks like a secret, and was left out | `mason add <table> --include <column>` |
| Free disk swings by gigabytes during a sync | A big table's temporary data | Watch the trend, not one reading. Grow the Volume if it stays low: `doctl compute volume-action resize <volume-id> --size <GiB> --region <region>`, then `resize2fs /dev/sda` on the server |
| Tables go stale with no error | Their `sync:` is `off`, which is the default | [Step 8](#8-say-how-each-table-stays-current), or `mason sync <table>` from cron |
