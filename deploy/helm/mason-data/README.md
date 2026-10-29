# mason-data, the Helm chart

The plain manifests of [`deploy/kubernetes/`](../../kubernetes/README.md) as a chart; `values.yaml` holds the decisions
(image, database, project folder, storage class and size, memory, the Postgres API's Service, TLS, further settings) and
nothing else: one replica, the probes and the 60 s grace are fixed, because the copy requires them.

```bash
helm install mason deploy/helm/mason-data \
  --set database.url='postgres://mason_reader:…@db.example.com:5432/app' \
  --set database.apiKey="$(openssl rand -hex 24)" \
  --set-file project.sources=mason/sources/app.yml --set-file project.masonYml=mason/mason.yml \
  --set storage.className=gp3
```

[`deploy/kubernetes/README.md`](../../kubernetes/README.md) is the walkthrough; its "Where each claim is from" covers this chart.
