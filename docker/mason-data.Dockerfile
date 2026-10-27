# THE `mason-data` IMAGE: Mason as one container, `mason serve` (src/cli/serve.ts). One process: the copy of the
# database's tables, kept current, and the Postgres API BI tools connect to. Nothing else inside. Configured by the
# environment (`mason serve --help`), its state on ONE volume at /mason/data, the project folder (sources/, mason.yml)
# at /mason/project.
#
#   docker build -f docker/mason-data.Dockerfile -t mason-data .
#   docker compose -f deploy/mason-data/compose.yml up -d            (deploy/mason-data/README.md)
#
# ONE container per data volume, never two: DuckDB lets one process write a file, so a platform must run one replica
# and stop the old one before starting the new (a recreate, never a rolling deploy).
FROM node:24-slim

# tini as PID 1: it passes SIGTERM on (Node as PID 1 ignores a signal it has no handler for yet, so a `docker stop`
# during the start would wait out its timeout) and reaps what it leaves
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# the mason command whole (src/cli/ and what it imports)
COPY src/ src/
COPY LICENSE ./
RUN printf '#!/bin/sh\nexec node /app/src/cli/main.ts "$@"\n' > /usr/local/bin/mason && chmod 755 /usr/local/bin/mason \
 && mkdir -p /mason/project /mason/data && chown node:node /mason/project /mason/data

USER node
# DuckDB's postgres extension IN THE IMAGE: the copy reads the source through it, and a server whose egress is
# closed could never fetch it at its first copy (src/duck/sync.ts attach; ~/.duckdb/extensions)
RUN node --input-type=module -e "import { DuckDBInstance } from '@duckdb/node-api'; const c = await (await DuckDBInstance.create(':memory:')).connect(); await c.run('INSTALL postgres'); await c.run('LOAD postgres');"

# the release it is (images-publish.yml: `v<version>`, `main-<sha>` for a merge), which `mason --version`, /healthz and
# `version()` on the Postgres API say (src/cli/version.ts); `dev` for a local build
ARG MASON_VERSION=dev
# off loopback the Postgres API needs TLS (MASON_PG_TLS_CERT / _KEY, MASON_PG_SELF_SIGNED_TLS=1) or MASON_PG_PLAIN=1
ENV MASON_VERSION=$MASON_VERSION \
    MASON_PROJECT=/mason/project \
    MASON_DATA=/mason/data \
    MASON_PG_HOST=0.0.0.0 \
    MASON_PG_PORT=5433 \
    MASON_HEALTH_PORT=4140
# the commands beside it (`docker compose exec mason mason status`) mean the project of the folder they run in
WORKDIR /mason/data
VOLUME ["/mason/data"]
# 5433: the Postgres API; 4140: GET /healthz
EXPOSE 5433 4140
# the first start reads how the database orders text before it listens: healthy after ~16 s on an idle machine (13 s of
# it one query on the database sorting every code point under its collation), a restart after 0.5 s (the order is kept
# in the copy). A machine at load 31 took ~2.5 minutes, which 2 minutes of start period and three failed checks 15 s
# apart (2m45s before `unhealthy`) still cover
HEALTHCHECK --interval=15s --timeout=5s --start-period=2m --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.MASON_HEALTH_PORT || 4140) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# SIGTERM is mason serve's stop: a copy in flight interrupted and rolled back, DuckDB closed
STOPSIGNAL SIGTERM
ENTRYPOINT ["tini", "--"]
CMD ["mason", "serve"]
