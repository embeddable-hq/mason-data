// MASON ON RAILWAY, as Railway's Infrastructure as Code: one service from the image, one volume, the health check.
// Copy to .railway/railway.ts in your repo, then `railway config plan` and `railway config apply` (the Railway CLI).
// deploy/railway/README.md is the walkthrough, with the dashboard's steps for the same.
//
// Why not railway.json: Config as Code is deprecated, new services cannot opt in, and "Existing Config as Code files
// stop being read on 2026-12-01" (https://docs.railway.com/infrastructure-as-code). The syntax below is the reference's
// (https://docs.railway.com/infrastructure-as-code/reference): `source: image(…)`, `env`, `volume(…)` with region and
// sizeMB, `volumeMounts` keyed by mount path, `healthcheck` and `healthcheckTimeout`, `replicas`. The reference shows
// `image(…)` used as a source without showing its import; if `railway config plan` says the import is wrong, take the
// name it gives. The TCP proxy for 5433 is not in the file: the reference does not manage it (README.md).
import { defineRailway, image, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // THE VOLUME: the copy and Mason's state, ONE, attached to one service ("A volume can be attached to one service";
  // "Replicas cannot be used with volumes"). Its region is the service's; sizes by plan: 5 GB on Hobby, 50 GB on Pro
  // by default, extendable, never shrunk.
  const data = volume("mason-data", { region: "europe-west4", sizeMB: 20480 });

  const mason = service("mason", {
    // `main` is every merge, `<version>` a release
    source: image("ghcr.io/embeddable-hq/mason-data:main"),
    env: {
      // DATABASE_URL and MASON_API_KEY: set them on the service in the dashboard or with `railway variable set`,
      // never in a committed file.
      // Off loopback the Postgres API needs TLS: a certificate made on the volume (clients: sslmode=require), or
      // MASON_PG_TLS_CERT / MASON_PG_TLS_KEY naming one a CA signed.
      MASON_PG_SELF_SIGNED_TLS: "1",
      // the project folder (sources/, mason.yml) on the volume, so a table `mason add` adds survives a redeploy
      MASON_PROJECT: "/mason/data/project",
      // the copy's memory, said explicitly: Railway's limit is the plan's, not a cgroup limit the copy can read
      MASON_DUCKDB_MEMORY: "4GB",
      // Railway's health check is sent to PORT ("If your app doesn't listen on PORT … you can set PORT manually"):
      // /healthz is on 4140, while the TCP proxy forwards to 5433
      PORT: "4140",
      // "Volumes are mounted as the root user"; the image runs as node, so it could not write the volume without this
      RAILWAY_RUN_UID: "0",
      // the old deployment gets SIGTERM and, by default, 0 s before SIGKILL: a copy in flight needs the minute
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "60",
    },
    volumeMounts: { "/mason/data": data },
    // 503 while it starts, 200 once it serves; the first start takes ~15 s, minutes on a loaded host
    healthcheck: "/healthz",
    healthcheckTimeout: 300,
    // one, and never more: the copy is one file with one writer (and Railway refuses replicas with a volume)
    replicas: 1,
  });

  return project("mason", { resources: [mason, data] });
});
