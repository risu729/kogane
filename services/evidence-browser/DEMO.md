# Hosted observation demo

URL: https://kogane-demo.takuanimal.workers.dev

The normal observation UI (overview, transactions, balances, positions, artifacts,
and observation details) runs independently of the production parsed-data API.
Every displayed observation and downloadable original is synthetic fixture data.
The UI labels it as a demo. It has no D1, R2, collector, or production API binding.
The existing evidence browser remains the separate real raw-evidence reader.

`local-pipeline:export-demo` (in `experiments/observation-pipeline-local`)
creates a fresh temporary store from committed fixtures, runs parsers, and
exports deterministic API responses. It cannot accept an existing store as
input. The generated `demo-snapshot.json` is ignored by Git and must be
regenerated for each build. Artifact links include
superseded parse observations. Updating the demo requires rebuilding and deploying.

From the repository root:

```sh
mise run install
mise run web:build
mise run local-pipeline:export-demo
cd services/evidence-browser
./node_modules/.bin/wrangler deploy --config wrangler.demo.jsonc --dry-run
./node_modules/.bin/wrangler deploy --config wrangler.demo.jsonc
```

The Access application `Kogane synthetic demo` protects the Worker's production
and preview URLs using the existing `default` policy and Cloudflare One Client
authentication. Preview URLs are disabled. The Worker also validates the Access
JWT before serving any API response or static asset. For a new deployment target,
bootstrap with `workers_dev: false`, configure Worker-scoped Access and its AUD,
then enable routing. An empty AUD fails closed.

Only GET and HEAD are supported. Raw originals are attachments with sandbox CSP.
Responses are not cached. Request logs contain route category, method, status,
duration, request ID, and error code, without tokens or response contents.

CI builds both UI modes, regenerates the snapshot, checks types, runs authenticated
Worker tests, and dry-runs both Worker configurations. Export tests verify stable
output, provenance links, raw hashes, and temporary-store cleanup.
