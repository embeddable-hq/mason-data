# mason-data, the Helm chart

The plain manifests of [`deploy/kubernetes/`](../../kubernetes/README.md) as a chart; `values.yaml` holds the decisions
(image, database, project folder, storage class and size, memory, the Postgres API's Service, TLS, further settings) and
nothing else: one replica, the probes and the 60 s grace are fixed, because the copy requires them.

From your own repository, where `mason/` is the project folder `mason init` and `mason add` wrote on a laptop
(`MASON_REPO` a checkout of this repository):

```bash
kubectl get storageclass          # a disk class; storage.className may stay "" when the default is one (README "The volume")
helm install mason "$MASON_REPO/deploy/helm/mason-data" \
  --set database.url='postgres://mason_reader:…@db.example.com:5432/app' \
  --set database.apiKey="$(openssl rand -hex 24)" \
  --set-file project.sources=mason/sources/app.yml --set-file project.masonYml=mason/mason.yml
```

`storage.className` and `storage.size` are decided once, at install: a StatefulSet's volume claim cannot change, and a
`helm upgrade` that changes them fails.

[`deploy/kubernetes/README.md`](../../kubernetes/README.md) is the walkthrough; its "Where each claim is from" covers this chart.
