# Runtime resource ledger

Generated from the `wrangler*.jsonc` files under `apps/`, `experiments/`, `poc/` and `services/` by
`scripts/resource-ledger.ts`. Do not edit by hand: `scripts/resource-ledger.test.ts`
regenerates it and fails when this file and the configs disagree.

Live column: Cloudflare account `59ea63cc00914b30ca410b062ae2bb7f`, read 2026-09-13.
Queues, Durable Object namespaces, cron triggers and Email routes are not listable through that
API, so they are derived from the configs and are **unverified against the live account**.

Unified plan U01. The directory moves of chapter 07 §1 must not change any identity in this
file: Worker `name`, Durable Object class name and migration tag, R2 bucket name, Queue name,
cron expression, Email route or D1 id (acceptance tests G0-06, G0-07, G0-12).

## Summary

- Wrangler configs: 24
- Distinct Workers that exist in the account: 15
- Live Workers with no config in this repository: —
- Live R2 buckets no config references: —
- Workers with an `email()` handler (Email routes are configured outside this repository): kogane-vpoint-collector-poc

## D1 databases

| database | id | live | bound by |
| --- | --- | --- | --- |
| test | `00000000-0000-0000-0000-000000000001` | no | kogane-evidence-browser-test |
| test-read | `00000000-0000-0000-0000-000000000002` | no | kogane-evidence-browser-test |
| kogane-read | `320ebe31-a031-48a1-985f-0e6fabbd517a` | yes | kogane-evidence-browser<br>kogane-observation-pipeline<br>kogane-read-migrations |
| kogane-raw-evidence | `b335a887-250d-45c9-bd72-af83f35fdc60` | yes | kogane-evidence-browser<br>kogane-observation-pipeline<br>kogane-observation-read-diagnostic |

## R2 buckets

| bucket | live | bound by |
| --- | --- | --- |
| kogane-raw-evidence | yes | kogane-evidence-browser<br>kogane-globalpass-collector-poc<br>kogane-mobile-suica-collector-poc<br>kogane-moneyforward-collector-poc<br>kogane-myjcb-collector-poc<br>kogane-observation-pipeline<br>kogane-observation-read-diagnostic<br>kogane-sbi-collector-poc<br>kogane-sbi-shinsei-collector-poc<br>kogane-sbi-vc-session-poc<br>kogane-smbc-direct-backfill-poc<br>kogane-sony-bank-collector-poc<br>kogane-vpass-collector-poc<br>kogane-vpoint-collector-poc<br>kogane-vpoint-pay-collector-poc |
| test | no | kogane-evidence-browser-test |

## Queues

| queue | producers | consumers | dead letter | exists |
| --- | --- | --- | --- | --- |
| kogane-collection-terminals | — | kogane-observation-pipeline | kogane-collection-terminals-dlq | declared (unverified) |

## Durable Object classes and migration tags

| worker | class | migration tag | storage |
| --- | --- | --- | --- |
| kogane-globalpass-collector-poc | GlobalPassCollectorContainer | v1 | sqlite |
| kogane-sbi-shinsei-collector-poc | SbiShinseiCollectorContainer | v1 | sqlite |
| kogane-sbi-vc-session-poc | SbiVcSessionState | v1 | sqlite |
| kogane-smbc-direct-backfill-poc | SmbcBackfillSession | v1 | sqlite |
| kogane-vpass-runtime-probe-20260825 | RuntimeProbeContainer | v1 | sqlite |
| kogane-vpoint-collector-poc | VPointSession | (declared via exports) | sqlite |
| kogane-vpoint-pay-collector-poc | VPointPayCredentialState | (declared via exports) | sqlite |

## Cron triggers

| worker | cron (UTC) | deployed |
| --- | --- | --- |
| kogane-globalpass-collector-poc | `17 18 * * *` | yes |
| kogane-mobile-suica-collector-poc | `10 21 * * *` | yes |
| kogane-moneyforward-collector-poc | `15 21 * * *` | yes |
| kogane-myjcb-collector-poc | `0 21 * * *` | yes |
| kogane-observation-pipeline | `*/5 * * * *` | yes |
| kogane-sbi-collector-poc | `0 21 * * *` | yes |
| kogane-sbi-shinsei-collector-poc | `0 21 * * *` | yes |
| kogane-sbi-vc-session-poc | `*/15 * * * *` | yes |
| kogane-sbi-vc-session-poc | `5 21 * * *` | yes |
| kogane-sony-bank-collector-poc | `0 21 * * *` | yes |
| kogane-vpass-collector-poc | `0 21 * * *` | yes |
| kogane-vpoint-collector-poc | `15 21 * * *` | yes |

## Executed plan rows that left the table

Directories the plan's dispositions retired, or promoted into `packages/`, where no runtime
resource is declared. They are listed here because they are no longer in the table below; the
commit column is what `git show` needs to read removed code back (acceptance test G0-12: none
of these was retired merely because nothing imported it). A directory promoted *within* the
scanned workspaces keeps its row below with `EXECUTED_U04`.

| was | action | result | last commit | live-resource check |
| --- | --- | --- | --- | --- |
| `services/raw-evidence` | `retire-legacy-service` | packages/application in-process registration; central R2 retirement archive | `bdee142d49f8` | 2026-09-13: old Worker, old queues and per-source buckets deleted and absence verified; 2989 original objects preserved and hash-verified in central R2 |
| `services/collector-r2-importer` | `retire-legacy-service` | packages/application in-process registration; central R2 retirement archive | `bdee142d49f8` | 2026-09-13: old Worker, old queues and per-source buckets deleted and absence verified; 2989 original objects preserved and hash-verified in central R2 |
| `poc/camoufox-container-probe` | `retire-candidate` | docs/research/camoufox.md (code removed) | `5fb143e0f77a` | no wrangler config, no Worker, no bucket, no cron, no container application; local image deleted 2026-08-26 |
| `poc/collector-diagnostics` | `promote-shared` | packages/collector-diagnostics (7 collector Workers; exports createDiagnostics, safeErrorDetails) | `5fb143e0f77a` | no wrangler config of its own; it is a library every collector Worker on the account links into its bundle, so it is promoted rather than retired |
| `poc/kameleo-container-probe` | `retire-candidate` | docs/research/kameleo.md (code removed) | `5fb143e0f77a` | no wrangler config, no Worker, no bucket, no cron; local container, volume and image deleted 2026-08-26 |
| `poc/oci-browser-probe` | `isolate-or-retire` | docs/research/oci-browser.md (code removed; conclusions in docs/authenticated-collectors.md) | `5fb143e0f77a` | retire branch: no wrangler config, no Worker and no OCI relay — the only collector relay is the pre-existing tamia Tunnel (GLOBAL PASS, exit JP/KIX ASN 18144); the probe's own install on host bots was purged and verified on 2026-08-26 |
| `poc/sbi-securities` | `classify-before-delete` | docs/research/sbi-securities.md (code removed; no operational CLI added to the collector) | `5fb143e0f77a` | no wrangler config, Worker, bucket or cron; a local overlay on an external checkout, superseded by services/collector-sbi-securities (kogane-sbi-collector-poc), which reimplements the same read-only paths without mnie |
| `poc/sbi-vc-trade-client` | `promote-shared-if-used` | packages/sbi-vc-trade-client | `5fb143e0f77a` | no wrangler config of its own; services/collector-sbi-vc-trade links it into the bundle of kogane-sbi-vc-session-poc, so it is promoted rather than retired |

## Directories

### `apps/web`

- Disposition (poc_disposition.csv row poc/observation-pipeline + decision D1): `promoted-from-poc` → apps/web (the React client and its frontend tests)
- Required verification: U04 executed the move; the three bundles are byte-identical and the client imports no service internal
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

No wrangler config.

### `experiments/cloudflare-browser-run`

- Disposition (poc_disposition.csv (was poc/cloudflare-browser-run)): `isolate-or-promote` → experiments/cloudflare-browser-run (isolated; promote only on a real consumer)
- Required verification: classified as isolate: no services/, packages/, wrangler config, task or asset outside the directory references it
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

#### `kogane-vpass-browser-run-20260825` — `experiments/cloudflare-browser-run/wrangler.bootstrap.jsonc`

- Role: not-deployed; exists in the account: no
- Entry point: src/bootstrap.ts
- D1: —
- R2: —
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): —

#### `kogane-vpass-browser-run-20260825` — `experiments/cloudflare-browser-run/wrangler.jsonc`

- Role: not-deployed; exists in the account: no
- Entry point: src/index.ts
- D1: —
- R2: —
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: BROWSER
- VPC networks: —
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): PROBE_TOKEN<br>VPASS_ID<br>VPASS_PASSWORD

### `experiments/cloudflare-runtime-probe`

- Disposition (poc_disposition.csv (was poc/cloudflare-runtime-probe)): `isolate` → experiments/cloudflare-runtime-probe
- Required verification: purpose and stop condition recorded in EXPERIMENT.md
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

#### `kogane-vpass-runtime-probe-20260825` — `experiments/cloudflare-runtime-probe/wrangler.jsonc`

- Role: not-deployed; exists in the account: no
- Entry point: src/index.ts
- D1: —
- R2: —
- KV: —
- Queues: —
- Durable Objects: PROBE_CONTAINER → RuntimeProbeContainer
- DO migration tags: v1: RuntimeProbeContainer
- Containers: RuntimeProbeContainer (./Dockerfile, lite, max 1)
- Browser binding: —
- VPC networks: TAMIA → 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): —

### `experiments/observation-pipeline-local`

- Disposition (poc_disposition.csv row poc/observation-pipeline + decision D1): `isolated-as-experiment` → experiments/observation-pipeline-local (EXPERIMENT.md: risu729, 2026-12-31)
- Required verification: U04 executed the move; retire once the App API covers replay and status (docs/research/observation-pipeline-poc.md)
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

No wrangler config.

### `experiments/tamia-tcp-bridge`

- Disposition (poc_disposition.csv (was poc/tamia-tcp-bridge)): `promote-service-if-used` → experiments/tamia-tcp-bridge (not used by any collector; promote to services/tamia-tcp-bridge only when one routes through it)
- Required verification: checked: GLOBAL PASS binds the tamia Tunnel directly by tunnel_id and relays through its own /tcp, no config, binding, var, secret or task names kogane-tamia-tcp-bridge-20260825, and that Worker is not in the account inventory
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

#### `kogane-tamia-tcp-bridge-20260825` — `experiments/tamia-tcp-bridge/wrangler.bootstrap.jsonc`

- Role: not-deployed; exists in the account: no
- Entry point: src/bootstrap.ts
- D1: —
- R2: —
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): —

#### `kogane-tamia-tcp-bridge-20260825` — `experiments/tamia-tcp-bridge/wrangler.jsonc`

- Role: not-deployed; exists in the account: no
- Entry point: src/index.ts
- D1: —
- R2: —
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: TAMIA → 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): BRIDGE_TOKEN

### `services/app`

- Disposition (plan 07 §1 + decision D1): `rename-directory` → services/app
- Required verification: git mv only; Worker names kogane-evidence-browser and kogane-demo stay
- Execution status: EXECUTED_RENAME (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-demo,kogane-evidence-browser; buckets=kogane-raw-evidence)

#### `kogane-demo` — `services/app/wrangler.demo.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/demo-worker.ts
- D1: —
- R2: —
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: —
- Assets: `../../apps/web/dist` → ASSETS
- Vars (names only): ACCESS_AUDIENCE<br>ACCESS_ISSUER<br>AGENT_GRANTS<br>BALANCE_PROJECTION_ENABLED<br>OPERATOR_SUBJECTS<br>OPS_API_ENABLED
- Required secrets (names only): —

#### `kogane-evidence-browser` — `services/app/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: DB → kogane-raw-evidence `b335a887-250d-45c9-bd72-af83f35fdc60`<br>READ → kogane-read `320ebe31-a031-48a1-985f-0e6fabbd517a`
- R2: EVIDENCE → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: PIPELINE → kogane-observation-pipeline
- Crons: —
- Assets: `../../apps/web/dist-production` → ASSETS
- Vars (names only): ACCESS_AUDIENCE<br>ACCESS_ISSUER<br>AGENT_API_GRANTS<br>AGENT_GRANTS<br>BALANCE_PROJECTION_ENABLED<br>COMMANDS_ENABLED<br>EVENTS_V2_ENABLED<br>EVIDENCE_SOURCE_ID<br>HEALTH_PROBE_TOKENS<br>OPERATOR_SUBJECTS<br>OPS_API_ENABLED<br>RELEASE_SHA<br>REWARDS_V2_ENABLED<br>SESSION_REFRESH_POLICY
- Required secrets (names only): —

#### `kogane-evidence-browser-test` — `services/app/wrangler.test.jsonc`

- Role: test-only; exists in the account: no
- Entry point: src/worker.ts
- D1: DB → test `00000000-0000-0000-0000-000000000001` (not live)<br>READ → test-read `00000000-0000-0000-0000-000000000002` (not live)
- R2: EVIDENCE → test (not live)
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: —
- Assets: `test/assets` → ASSETS
- Vars (names only): ACCESS_AUDIENCE<br>ACCESS_ISSUER<br>AGENT_API_GRANTS<br>AGENT_GRANTS<br>BALANCE_PROJECTION_ENABLED<br>COMMANDS_ENABLED<br>EVENTS_V2_ENABLED<br>EVIDENCE_SOURCE_ID<br>HEALTH_PROBE_TOKENS<br>OPERATOR_SUBJECTS<br>OPS_API_ENABLED<br>RELEASE_SHA<br>REWARDS_V2_ENABLED<br>SESSION_REFRESH_POLICY
- Required secrets (names only): —

### `services/collector-globalpass`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-globalpass
- Required verification: keep Container, relay, browser diagnostics and resource identity
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-globalpass-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-globalpass-collector-poc` — `services/collector-globalpass/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: COLLECTOR_CONTAINER → GlobalPassCollectorContainer
- DO migration tags: v1: GlobalPassCollectorContainer
- Containers: GlobalPassCollectorContainer (./Dockerfile, basic, max 2)
- Browser binding: BROWSER
- VPC networks: MESH → 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33<br>CF_EGRESS → cf1:network
- Service bindings: —
- Crons: `17 18 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION<br>RELAY_PUBLIC_URL
- Required secrets (names only): —

### `services/collector-mobile-suica`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-mobile-suica
- Required verification: contract tests, live/secret/resource mapping confirmed
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-mobile-suica-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-mobile-suica-collector-poc` — `services/collector-mobile-suica/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: BROWSER
- VPC networks: —
- Service bindings: —
- Crons: `10 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): ADMIN_TRIGGER_TOKEN<br>JRE_ID_CREDENTIAL_JSON

### `services/collector-moneyforward`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-moneyforward
- Required verification: collector/importer/CORE mapping and resource identity kept
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-moneyforward-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-moneyforward-collector-poc` — `services/collector-moneyforward/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: `15 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-myjcb`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-myjcb
- Required verification: keep the Browser Run login and fetch boundary
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-myjcb-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-myjcb-collector-poc` — `services/collector-myjcb/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: BROWSER
- VPC networks: —
- Service bindings: —
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-sbi-securities`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-sbi-securities
- Required verification: contract tests and resource identity; secret material is not moved
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-sbi-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-sbi-collector-poc` — `services/collector-sbi-securities/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-sbi-shinsei`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-sbi-shinsei
- Required verification: keep the container/relay/credential operation contract
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-sbi-shinsei-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-sbi-shinsei-collector-poc` — `services/collector-sbi-shinsei/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: COLLECTOR_CONTAINER → SbiShinseiCollectorContainer
- DO migration tags: v1: SbiShinseiCollectorContainer
- Containers: SbiShinseiCollectorContainer (./Dockerfile, basic, max 2)
- Browser binding: —
- VPC networks: MESH → 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33
- Service bindings: —
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION<br>RELAY_PUBLIC_URL
- Required secrets (names only): —

### `services/collector-sbi-vc-trade`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-sbi-vc-trade
- Required verification: keep the client dependency and the resource identity
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-sbi-vc-session-poc; buckets=kogane-raw-evidence)

#### `kogane-sbi-vc-session-poc` — `services/collector-sbi-vc-trade/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: SESSION_STATE → SbiVcSessionState
- DO migration tags: v1: SbiVcSessionState
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: `*/15 * * * *`<br>`5 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-smbc-direct`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-smbc-direct
- Required verification: keep the human-required boundary; never turn it into unattended re-authentication
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-smbc-direct-backfill-poc; buckets=kogane-raw-evidence)

#### `kogane-smbc-direct-backfill-poc` — `services/collector-smbc-direct/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: BACKFILL_SESSION → SmbcBackfillSession
- DO migration tags: v1: SmbcBackfillSession
- Containers: —
- Browser binding: —
- VPC networks: TAMIA → 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION<br>DEFAULT_BACKFILL_FROM<br>SMBC_DIRECT_BASE_URL<br>SMBC_DIRECT_LOGIN_BASE_URL
- Required secrets (names only): —

### `services/collector-sony-bank`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-sony-bank
- Required verification: keep the sanitize/HTML/CSV contract and the resource identity
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-sony-bank-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-sony-bank-collector-poc` — `services/collector-sony-bank/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-vpass`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-vpass
- Required verification: keep the Worker name and the R2/cron/auth contract
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-vpass-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-vpass-collector-poc` — `services/collector-vpass/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): —
- Required secrets (names only): —

### `services/collector-vpoint`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-vpoint
- Required verification: keep the Email route and the DO class/tag/storage
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-vpoint-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-vpoint-collector-poc` — `services/collector-vpoint/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts; has an `email()` handler
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: VPOINT_SESSION → VPointSession
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: `15 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION<br>VPOINT_PAY_EMAIL_RECIPIENT
- Required secrets (names only): ADMIN_TRIGGER_TOKEN<br>VPOINT_EMAIL_FORWARD_TO<br>VPOINT_EMAIL_RECIPIENT<br>VPOINT_MEMBER_NUMBER

### `services/collector-vpoint-pay`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-vpoint-pay
- Required verification: confirm the Email/collection entry point and the resource identity
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-vpoint-pay-collector-poc; buckets=kogane-raw-evidence)

#### `kogane-vpoint-pay-collector-poc` — `services/collector-vpoint-pay/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: DATA → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: VPOINT_PAY_STATE → VPointPayCredentialState
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): ADMIN_TRIGGER_TOKEN<br>VPOINT_PAY_DEVICE_UUID<br>VPOINT_PAY_REFRESH_TOKEN

### `services/processor`

- Disposition (plan 07 §1 + decision D1): `rename-directory` → services/processor
- Required verification: git mv only; Worker name kogane-observation-pipeline and cron stay
- Execution status: EXECUTED_RENAME (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-observation-pipeline; buckets=kogane-raw-evidence)

#### `kogane-observation-read-diagnostic` — `services/processor/wrangler.diagnostic.jsonc`

- Role: binding-only; exists in the account: no
- Entry point: —
- D1: DB → kogane-raw-evidence `b335a887-250d-45c9-bd72-af83f35fdc60`
- R2: EVIDENCE → kogane-raw-evidence
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): —

#### `kogane-observation-pipeline` — `services/processor/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: DB → kogane-raw-evidence `b335a887-250d-45c9-bd72-af83f35fdc60` (migrations_dir `../../packages/storage-d1/migrations/core`)<br>READ → kogane-read `320ebe31-a031-48a1-985f-0e6fabbd517a`
- R2: EVIDENCE → kogane-raw-evidence<br>DATA → kogane-raw-evidence
- KV: —
- Queues: consume kogane-collection-terminals (dlq kogane-collection-terminals-dlq)
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: `*/5 * * * *`
- Assets: —
- Vars (names only): BALANCE_PROJECTION_ENABLED<br>COLLECTION_ACCOUNT_ID<br>COLLECTION_DATA_BUCKET<br>COLLECTION_INGEST_CLIENT<br>OPS_DISPATCH_ENABLED<br>RECONCILIATION_ENABLED<br>RELEASE_CANDIDATES_ENABLED<br>RELEASE_SHA<br>REPORTS_ENABLED<br>REWARD_CLAIMS_ENABLED<br>REWARD_READ_PROJECTION_ENABLED<br>SHARED_R2_INGEST_ENABLED
- Required secrets (names only): —

#### `kogane-observation-ops-local` — `services/processor/wrangler.ops.jsonc`

- Role: binding-only; exists in the account: no
- Entry point: —
- D1: —
- R2: —
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: OBSERVATIONS → kogane-observation-pipeline
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): —

#### `kogane-read-migrations` — `services/processor/wrangler.read-migrations.jsonc`

- Role: binding-only; exists in the account: no
- Entry point: —
- D1: READ → kogane-read `320ebe31-a031-48a1-985f-0e6fabbd517a` (migrations_dir `../../packages/storage-d1/migrations/read`)
- R2: —
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: —
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): —
