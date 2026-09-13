# Local synthetic test snapshots

The hosted `kogane-demo` Worker has been retired. There is no deployment config
or release target for a synthetic snapshot, and the browser does not display
sources classified as synthetic.

`//experiments/observation-pipeline-local:export-demo` (in `experiments/observation-pipeline-local`)
creates a fresh temporary store from committed synthetic fixtures, runs parsers,
and exports the resulting observation API responses. It takes no production
store as input. The generated `demo-snapshot.json` is ignored by Git and remains
an input to local API conformance tests only.

`test/snapshot-worker.ts` is a test adapter for those responses. It has no
Cloudflare resource, D1, R2, collector, or production API binding. Keep this
adapter and its generated input under test use; do not restore a public Worker
or add the snapshot to the production frontend.
