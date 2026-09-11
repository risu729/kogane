# Runtime resource ledger

Generated from the `wrangler*.jsonc` files under `apps/`, `experiments/`, `poc/` and `services/` by
`scripts/resource-ledger.ts`. Do not edit by hand: `scripts/resource-ledger.test.ts`
regenerates it and fails when this file and the configs disagree.

Live column: Cloudflare account `59ea63cc00914b30ca410b062ae2bb7f`, read 2026-09-11.
Queues, Durable Object namespaces, cron triggers and Email routes are not listable through that
API, so they are derived from the configs and are **unverified against the live account**.

Unified plan U01. The directory moves of chapter 07 §1 must not change any identity in this
file: Worker `name`, Durable Object class name and migration tag, R2 bucket name, Queue name,
cron expression, Email route or D1 id (acceptance tests G0-06, G0-07, G0-12).

## Summary

- Wrangler configs: 40
- Distinct Workers that exist in the account: 17
- Live Workers with no config in this repository: kogane-globalpass-container-probe-20260827
- Live R2 buckets no config references: —
- Workers with an `email()` handler (Email routes are configured outside this repository): kogane-vpoint-collector-poc

## D1 databases

| database | id | live | bound by |
| --- | --- | --- | --- |
| test | `00000000-0000-0000-0000-000000000001` | no | kogane-evidence-browser-test |
| test-read | `00000000-0000-0000-0000-000000000002` | no | kogane-evidence-browser-test |
| kogane-read | `320ebe31-a031-48a1-985f-0e6fabbd517a` | yes | kogane-evidence-browser<br>kogane-observation-pipeline<br>kogane-read-migrations |
| kogane-raw-evidence | `b335a887-250d-45c9-bd72-af83f35fdc60` | yes | kogane-evidence-browser<br>kogane-ingest<br>kogane-observation-pipeline<br>kogane-observation-read-diagnostic |

## R2 buckets

| bucket | live | bound by |
| --- | --- | --- |
| kogane-globalpass-collector-poc | yes | kogane-collector-r2-importer<br>kogane-global-pass-layer-b-audit-local<br>kogane-globalpass-collector-poc |
| kogane-mobile-suica-collector-poc | yes | kogane-collector-r2-importer<br>kogane-mobile-suica-collector-poc |
| kogane-moneyforward-collector-poc | yes | kogane-collector-r2-importer<br>kogane-moneyforward-collector-poc<br>kogane-moneyforward-layer-b-audit-local<br>kogane-moneyforward-r2-contract-audit-local |
| kogane-myjcb-collector-poc | yes | kogane-collector-r2-importer<br>kogane-myjcb-collector-poc<br>kogane-myjcb-r2-layer-b-audit-local |
| kogane-raw-evidence | yes | kogane-evidence-browser<br>kogane-ingest<br>kogane-observation-pipeline<br>kogane-observation-read-diagnostic |
| kogane-sbi-collector-poc | yes | kogane-collector-r2-importer<br>kogane-sbi-collector-poc |
| kogane-sbi-shinsei-collector-poc | yes | kogane-collector-r2-importer<br>kogane-sbi-shinsei-collector-poc<br>kogane-sbi-shinsei-r2-layer-b-audit-local |
| kogane-sbi-vc-trade-poc | yes | kogane-collector-r2-importer<br>kogane-sbi-vc-r2-layer-b-audit-local<br>kogane-sbi-vc-session-poc |
| kogane-smbc-direct-backfill-poc | yes | kogane-collector-r2-importer<br>kogane-smbc-direct-backfill-poc<br>kogane-smbc-direct-r2-contract-audit-local<br>kogane-smbc-direct-r2-layer-b-audit-local |
| kogane-sony-bank-collector-poc | yes | kogane-collector-r2-importer<br>kogane-sony-bank-collector-poc<br>kogane-sony-bank-r2-layer-b-audit-local |
| kogane-vpass-collector-poc | yes | kogane-collector-r2-importer<br>kogane-vpass-collector-poc<br>kogane-vpass-identity-backfill-local<br>kogane-vpass-r2-layer-b-audit-local |
| kogane-vpoint-collector-poc | yes | kogane-collector-r2-importer<br>kogane-vpoint-collector-poc<br>kogane-vpoint-r2-contract-audit-local |
| kogane-vpoint-pay-collector-poc | yes | kogane-collector-r2-importer<br>kogane-vpoint-collector-poc<br>kogane-vpoint-pay-collector-poc<br>kogane-vpoint-pay-email-r2-contract-audit-local<br>kogane-vpoint-pay-r2-layer-b-audit-local<br>kogane-vpoint-r2-contract-audit-local |
| test | no | kogane-evidence-browser-test |

## Queues

| queue | producers | consumers | dead letter | exists |
| --- | --- | --- | --- | --- |
| kogane-collection-terminals | — | kogane-observation-pipeline | kogane-collection-terminals-dlq | to be created by the first deploy (U08) |
| kogane-r2-outbox-reconciler | kogane-collector-r2-importer | kogane-collector-r2-importer | kogane-r2-outbox-reconciler-dlq | declared (unverified) |
| kogane-vpass-raw-evidence-import | kogane-vpass-collector-poc | kogane-vpass-collector-poc | kogane-vpass-raw-evidence-import-dlq | declared (unverified) |

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
| kogane-collector-r2-importer | `23 19 * * SUN` | yes |
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

## Directories

### `apps/web`

- Disposition (poc_disposition.csv row poc/observation-pipeline + decision D1): `promoted-from-poc` → apps/web (the React client and its frontend tests)
- Required verification: U04 executed the move; the three bundles are byte-identical and the client imports no service internal
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

No wrangler config.

### `experiments/observation-pipeline-local`

- Disposition (poc_disposition.csv row poc/observation-pipeline + decision D1): `isolated-as-experiment` → experiments/observation-pipeline-local (EXPERIMENT.md: risu729, 2026-12-31)
- Required verification: U04 executed the move; retire once the App API covers replay and status (docs/research/observation-pipeline-poc.md)
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

No wrangler config.

### `poc/camoufox-container-probe`

- Disposition (poc_disposition.csv): `retire-candidate` → docs/research/camoufox.md
- Required verification: stopped, zero references, source retired after the result is saved
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

No wrangler config.

### `poc/cloudflare-browser-run`

- Disposition (poc_disposition.csv): `isolate-or-promote` → experiments/browser-run
- Required verification: classify after checking product code and resource dependencies
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

#### `kogane-vpass-browser-run-20260825` — `poc/cloudflare-browser-run/wrangler.bootstrap.jsonc`

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

#### `kogane-vpass-browser-run-20260825` — `poc/cloudflare-browser-run/wrangler.jsonc`

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

### `poc/cloudflare-runtime-probe`

- Disposition (poc_disposition.csv): `isolate` → experiments/cloudflare-runtime
- Required verification: set the experiment's purpose and stop condition
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

#### `kogane-vpass-runtime-probe-20260825` — `poc/cloudflare-runtime-probe/wrangler.jsonc`

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

### `poc/kameleo-container-probe`

- Disposition (poc_disposition.csv): `retire-candidate` → docs/research/kameleo.md
- Required verification: stopped, zero references, source retired after the result is saved
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

No wrangler config.

### `poc/oci-browser-probe`

- Disposition (poc_disposition.csv): `isolate-or-retire` → experiments/oci-browser; docs/research/oci-browser.md
- Required verification: confirm no production use of the OCI relay
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

No wrangler config.

### `poc/sbi-securities`

- Disposition (poc_disposition.csv): `classify-before-delete` → docs/research/sbi-securities.md; services/collector-sbi-securities
- Required verification: check the overlap with the worker version; diagnostics to API/source, finished research to docs, no new operational CLI
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

No wrangler config.

### `poc/tamia-tcp-bridge`

- Disposition (poc_disposition.csv): `promote-service-if-used` → services/tamia-tcp-bridge
- Required verification: do not delete before checking whether Globalpass and others depend on it
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: NO_LIVE_RESOURCE

#### `kogane-tamia-tcp-bridge-20260825` — `poc/tamia-tcp-bridge/wrangler.bootstrap.jsonc`

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

#### `kogane-tamia-tcp-bridge-20260825` — `poc/tamia-tcp-bridge/wrangler.jsonc`

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

### `services/collector-globalpass`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-globalpass
- Required verification: keep Container, relay, browser diagnostics and resource identity
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-globalpass-collector-poc; buckets=kogane-globalpass-collector-poc)

#### `kogane-globalpass-collector-poc` — `services/collector-globalpass/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-globalpass-collector-poc
- KV: —
- Queues: —
- Durable Objects: COLLECTOR_CONTAINER → GlobalPassCollectorContainer
- DO migration tags: v1: GlobalPassCollectorContainer
- Containers: GlobalPassCollectorContainer (./Dockerfile, basic, max 2)
- Browser binding: BROWSER
- VPC networks: MESH → 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33<br>CF_EGRESS → cf1:network
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `17 18 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION<br>RELAY_PUBLIC_URL
- Required secrets (names only): —

### `services/collector-mobile-suica`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-mobile-suica
- Required verification: contract tests, live/secret/resource mapping confirmed
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-mobile-suica-collector-poc; buckets=kogane-mobile-suica-collector-poc)

#### `kogane-mobile-suica-collector-poc` — `services/collector-mobile-suica/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-mobile-suica-collector-poc
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: BROWSER
- VPC networks: —
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `10 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): ADMIN_TRIGGER_TOKEN<br>JRE_ID_CREDENTIAL_JSON

### `services/collector-moneyforward`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-moneyforward
- Required verification: collector/importer/CORE mapping and resource identity kept
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-moneyforward-collector-poc; buckets=kogane-moneyforward-collector-poc)

#### `kogane-moneyforward-collector-poc` — `services/collector-moneyforward/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-moneyforward-collector-poc
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `15 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-myjcb`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-myjcb
- Required verification: keep the Browser Run login and fetch boundary
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-myjcb-collector-poc; buckets=kogane-myjcb-collector-poc)

#### `kogane-myjcb-collector-poc` — `services/collector-myjcb/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-myjcb-collector-poc
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: BROWSER
- VPC networks: —
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-r2-importer`

- Disposition (plan 07 §1 + decision D2): `absorb-into-processor` → services/processor (queue consumer and adapters, U08)
- Required verification: the Worker keeps running until U15; old protocol still readable; no double cron
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-collector-r2-importer; buckets=kogane-globalpass-collector-poc,kogane-mobile-suica-collector-poc,kogane-moneyforward-collector-poc,kogane-myjcb-collector-poc,kogane-sbi-collector-poc,kogane-sbi-shinsei-collector-poc,kogane-sbi-vc-trade-poc,kogane-smbc-direct-backfill-poc,kogane-sony-bank-collector-poc,kogane-vpass-collector-poc,kogane-vpoint-collector-poc,kogane-vpoint-pay-collector-poc)

#### `kogane-global-pass-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-global-pass-layer-b.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/global-pass-layer-b-audit-worker.ts
- D1: —
- R2: GLOBAL_PASS_SNAPSHOTS → kogane-globalpass-collector-poc
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

#### `kogane-moneyforward-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-moneyforward-layer-b.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/moneyforward-layer-b-audit-worker.ts
- D1: —
- R2: MONEYFORWARD_SNAPSHOTS → kogane-moneyforward-collector-poc
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

#### `kogane-moneyforward-r2-contract-audit-local` — `services/collector-r2-importer/wrangler.audit-moneyforward.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/moneyforward-audit-worker.ts
- D1: —
- R2: MONEYFORWARD_SNAPSHOTS → kogane-moneyforward-collector-poc
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

#### `kogane-myjcb-r2-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-myjcb.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/myjcb-audit-worker.ts
- D1: —
- R2: MYJCB_SNAPSHOTS → kogane-myjcb-collector-poc
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

#### `kogane-sbi-shinsei-r2-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-sbi-shinsei.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/sbi-shinsei-audit-worker.ts
- D1: —
- R2: SBI_SHINSEI_SNAPSHOTS → kogane-sbi-shinsei-collector-poc
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

#### `kogane-sbi-vc-r2-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-sbi-vc.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/sbi-vc-audit-worker.ts
- D1: —
- R2: SBI_VC_SNAPSHOTS → kogane-sbi-vc-trade-poc
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

#### `kogane-smbc-direct-r2-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-smbc-direct-layer-b.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/smbc-direct-layer-b-audit-worker.ts
- D1: —
- R2: SMBC_DIRECT_SNAPSHOTS → kogane-smbc-direct-backfill-poc
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

#### `kogane-smbc-direct-r2-contract-audit-local` — `services/collector-r2-importer/wrangler.audit-smbc-direct.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/smbc-direct-audit-worker.ts
- D1: —
- R2: SMBC_DIRECT_SNAPSHOTS → kogane-smbc-direct-backfill-poc
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

#### `kogane-sony-bank-r2-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-sony-layer-b.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/sony-layer-b-audit-worker.ts
- D1: —
- R2: SONY_SNAPSHOTS → kogane-sony-bank-collector-poc
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

#### `kogane-vpoint-pay-email-r2-contract-audit-local` — `services/collector-r2-importer/wrangler.audit-v-point-pay-email.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/v-point-pay-email-audit-worker.ts
- D1: —
- R2: VPOINT_PAY_SNAPSHOTS → kogane-vpoint-pay-collector-poc
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

#### `kogane-vpoint-pay-r2-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-v-point-pay-layer-b.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/v-point-pay-layer-b-audit-worker.ts
- D1: —
- R2: VPOINT_PAY_SNAPSHOTS → kogane-vpoint-pay-collector-poc
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

#### `kogane-vpoint-r2-contract-audit-local` — `services/collector-r2-importer/wrangler.audit-v-point.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/v-point-audit-worker.ts
- D1: —
- R2: VPOINT_SNAPSHOTS → kogane-vpoint-collector-poc<br>VPOINT_PAY_SNAPSHOTS → kogane-vpoint-pay-collector-poc
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

#### `kogane-vpass-r2-layer-b-audit-local` — `services/collector-r2-importer/wrangler.audit-vpass-layer-b.jsonc`

- Role: local-audit; exists in the account: no
- Entry point: src/vpass-layer-b-audit-worker.ts
- D1: —
- R2: VPASS_SNAPSHOTS → kogane-vpass-collector-poc
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

#### `kogane-vpass-identity-backfill-local` — `services/collector-r2-importer/wrangler.identity-backfill.jsonc`

- Role: binding-only; exists in the account: no
- Entry point: —
- D1: —
- R2: VPASS_SNAPSHOTS → kogane-vpass-collector-poc
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: IMPORTER → kogane-collector-r2-importer
- Crons: —
- Assets: —
- Vars (names only): —
- Required secrets (names only): —

#### `kogane-collector-r2-importer` — `services/collector-r2-importer/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SBI_SNAPSHOTS → kogane-sbi-collector-poc<br>SBI_VC_SNAPSHOTS → kogane-sbi-vc-trade-poc<br>SONY_SNAPSHOTS → kogane-sony-bank-collector-poc<br>SBI_SHINSEI_SNAPSHOTS → kogane-sbi-shinsei-collector-poc<br>MOBILE_SUICA_SNAPSHOTS → kogane-mobile-suica-collector-poc<br>GLOBAL_PASS_SNAPSHOTS → kogane-globalpass-collector-poc<br>MYJCB_SNAPSHOTS → kogane-myjcb-collector-poc<br>MONEYFORWARD_SNAPSHOTS → kogane-moneyforward-collector-poc<br>VPOINT_SNAPSHOTS → kogane-vpoint-collector-poc<br>VPOINT_PAY_SNAPSHOTS → kogane-vpoint-pay-collector-poc<br>VPASS_SNAPSHOTS → kogane-vpass-collector-poc<br>SMBC_DIRECT_SNAPSHOTS → kogane-smbc-direct-backfill-poc
- KV: —
- Queues: produce OUTBOX_RECONCILER_QUEUE → kogane-r2-outbox-reconciler<br>consume kogane-r2-outbox-reconciler (dlq kogane-r2-outbox-reconciler-dlq)
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: RAW_EVIDENCE → kogane-ingest
- Crons: `23 19 * * SUN`
- Assets: —
- Vars (names only): IMPORTER_VERSION<br>RECONCILER_ACCOUNT_ID
- Required secrets (names only): GLOBAL_PASS_LEGACY_EMPTY_SHA256_ALLOWLIST<br>ORIGIN_FINGERPRINT_KEY<br>RAW_EVIDENCE_TOKEN<br>RAW_EVIDENCE_TOKEN_GLOBAL_PASS<br>RAW_EVIDENCE_TOKEN_MOBILE_SUICA<br>RAW_EVIDENCE_TOKEN_MONEYFORWARD<br>RAW_EVIDENCE_TOKEN_MYJCB<br>RAW_EVIDENCE_TOKEN_SBI_SHINSEI<br>RAW_EVIDENCE_TOKEN_SBI_VC<br>RAW_EVIDENCE_TOKEN_SMBC_DIRECT<br>RAW_EVIDENCE_TOKEN_SONY<br>RAW_EVIDENCE_TOKEN_VPASS<br>RAW_EVIDENCE_TOKEN_VPOINT<br>RAW_EVIDENCE_TOKEN_VPOINT_PAY_EMAIL

### `services/collector-sbi-securities`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-sbi-securities
- Required verification: contract tests and resource identity; secret material is not moved
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-sbi-collector-poc; buckets=kogane-sbi-collector-poc)

#### `kogane-sbi-collector-poc` — `services/collector-sbi-securities/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-sbi-collector-poc
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-sbi-shinsei`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-sbi-shinsei
- Required verification: keep the container/relay/credential operation contract
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-sbi-shinsei-collector-poc; buckets=kogane-sbi-shinsei-collector-poc)

#### `kogane-sbi-shinsei-collector-poc` — `services/collector-sbi-shinsei/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-sbi-shinsei-collector-poc
- KV: —
- Queues: —
- Durable Objects: COLLECTOR_CONTAINER → SbiShinseiCollectorContainer
- DO migration tags: v1: SbiShinseiCollectorContainer
- Containers: SbiShinseiCollectorContainer (./Dockerfile, basic, max 2)
- Browser binding: —
- VPC networks: MESH → 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION<br>RELAY_PUBLIC_URL
- Required secrets (names only): —

### `services/collector-sbi-vc-trade`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-sbi-vc-trade
- Required verification: keep the client dependency and the resource identity
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-sbi-vc-session-poc; buckets=kogane-sbi-vc-trade-poc)

#### `kogane-sbi-vc-session-poc` — `services/collector-sbi-vc-trade/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-sbi-vc-trade-poc
- KV: —
- Queues: —
- Durable Objects: SESSION_STATE → SbiVcSessionState
- DO migration tags: v1: SbiVcSessionState
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `*/15 * * * *`<br>`5 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-smbc-direct`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-smbc-direct
- Required verification: keep the human-required boundary; never turn it into unattended re-authentication
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-smbc-direct-backfill-poc; buckets=kogane-smbc-direct-backfill-poc)

#### `kogane-smbc-direct-backfill-poc` — `services/collector-smbc-direct/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-smbc-direct-backfill-poc
- KV: —
- Queues: —
- Durable Objects: BACKFILL_SESSION → SmbcBackfillSession
- DO migration tags: v1: SmbcBackfillSession
- Containers: —
- Browser binding: —
- VPC networks: TAMIA → 6b0ccf30-68b2-494e-baa8-f4f9f3e46b33
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: —
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION<br>DEFAULT_BACKFILL_FROM<br>SMBC_DIRECT_BASE_URL<br>SMBC_DIRECT_LOGIN_BASE_URL
- Required secrets (names only): —

### `services/collector-sony-bank`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-sony-bank
- Required verification: keep the sanitize/HTML/CSV contract and the resource identity
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-sony-bank-collector-poc; buckets=kogane-sony-bank-collector-poc)

#### `kogane-sony-bank-collector-poc` — `services/collector-sony-bank/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-sony-bank-collector-poc
- KV: —
- Queues: —
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION
- Required secrets (names only): —

### `services/collector-vpass`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-vpass
- Required verification: keep the Worker name and the R2/cron/auth contract
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-vpass-collector-poc; buckets=kogane-vpass-collector-poc)

#### `kogane-vpass-collector-poc` — `services/collector-vpass/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-vpass-collector-poc
- KV: —
- Queues: produce RAW_EVIDENCE_QUEUE → kogane-vpass-raw-evidence-import<br>consume kogane-vpass-raw-evidence-import (dlq kogane-vpass-raw-evidence-import-dlq)
- Durable Objects: —
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `0 21 * * *`
- Assets: —
- Vars (names only): —
- Required secrets (names only): —

### `services/collector-vpoint`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-vpoint
- Required verification: keep the Email route and the DO class/tag/storage
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-vpoint-collector-poc; buckets=kogane-vpoint-collector-poc,kogane-vpoint-pay-collector-poc)

#### `kogane-vpoint-collector-poc` — `services/collector-vpoint/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts; has an `email()` handler
- D1: —
- R2: SNAPSHOTS → kogane-vpoint-collector-poc<br>VPOINT_PAY_SNAPSHOTS → kogane-vpoint-pay-collector-poc
- KV: —
- Queues: —
- Durable Objects: VPOINT_SESSION → VPointSession
- DO migration tags: —
- Containers: —
- Browser binding: —
- VPC networks: —
- Service bindings: RAW_EVIDENCE_IMPORTER → kogane-collector-r2-importer
- Crons: `15 21 * * *`
- Assets: —
- Vars (names only): COLLECTOR_SCHEMA_VERSION<br>VPOINT_PAY_EMAIL_RECIPIENT
- Required secrets (names only): ADMIN_TRIGGER_TOKEN<br>VPOINT_EMAIL_FORWARD_TO<br>VPOINT_EMAIL_RECIPIENT<br>VPOINT_MEMBER_NUMBER

### `services/collector-vpoint-pay`

- Disposition (poc_disposition.csv): `promote-service` → services/collector-vpoint-pay
- Required verification: confirm the Email/collection entry point and the resource identity
- Execution status: EXECUTED_U04 (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-vpoint-pay-collector-poc; buckets=kogane-vpoint-pay-collector-poc)

#### `kogane-vpoint-pay-collector-poc` — `services/collector-vpoint-pay/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: —
- R2: SNAPSHOTS → kogane-vpoint-pay-collector-poc
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

### `services/evidence-browser`

- Disposition (plan 07 §1 + decision D1): `rename-directory` → services/app
- Required verification: git mv only; Worker names kogane-evidence-browser and kogane-demo stay
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-demo,kogane-evidence-browser; buckets=kogane-raw-evidence)

#### `kogane-demo` — `services/evidence-browser/wrangler.demo.jsonc`

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
- Vars (names only): ACCESS_AUDIENCE<br>ACCESS_ISSUER<br>BALANCE_PROJECTION_ENABLED<br>OPS_API_ENABLED<br>READ_PROJECTION_ENABLED
- Required secrets (names only): —

#### `kogane-evidence-browser` — `services/evidence-browser/wrangler.jsonc`

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
- Vars (names only): ACCESS_AUDIENCE<br>ACCESS_ISSUER<br>AGENT_API_GRANTS<br>AGENT_GRANTS<br>BALANCE_PROJECTION_ENABLED<br>COMMANDS_ENABLED<br>EVENTS_V2_ENABLED<br>EVIDENCE_SOURCE_ID<br>OPS_API_ENABLED<br>READ_PROJECTION_ENABLED<br>REWARDS_V2_ENABLED<br>SESSION_REFRESH_POLICY
- Required secrets (names only): —

#### `kogane-evidence-browser-test` — `services/evidence-browser/wrangler.test.jsonc`

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
- Vars (names only): ACCESS_AUDIENCE<br>ACCESS_ISSUER<br>AGENT_API_GRANTS<br>AGENT_GRANTS<br>BALANCE_PROJECTION_ENABLED<br>COMMANDS_ENABLED<br>EVENTS_V2_ENABLED<br>EVIDENCE_SOURCE_ID<br>OPS_API_ENABLED<br>READ_PROJECTION_ENABLED<br>SESSION_REFRESH_POLICY
- Required secrets (names only): —

### `services/observation-pipeline`

- Disposition (plan 07 §1 + decision D1): `rename-directory` → services/processor
- Required verification: git mv only; Worker name kogane-observation-pipeline and cron stay
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-observation-pipeline; buckets=kogane-raw-evidence)

#### `kogane-observation-read-diagnostic` — `services/observation-pipeline/wrangler.diagnostic.jsonc`

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

#### `kogane-observation-pipeline` — `services/observation-pipeline/wrangler.jsonc`

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
- Vars (names only): BALANCE_PROJECTION_ENABLED<br>COLLECTION_ACCOUNT_ID<br>COLLECTION_DATA_BUCKET<br>COLLECTION_INGEST_CLIENT<br>OPS_DISPATCH_ENABLED<br>READ_PROJECTION_ENABLED<br>RECONCILIATION_ENABLED<br>RELEASE_CANDIDATES_ENABLED<br>REPORTS_ENABLED<br>REWARD_CLAIMS_ENABLED<br>SHARED_R2_INGEST_ENABLED
- Required secrets (names only): —

#### `kogane-observation-ops-local` — `services/observation-pipeline/wrangler.ops.jsonc`

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

#### `kogane-read-migrations` — `services/observation-pipeline/wrangler.read-migrations.jsonc`

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

### `services/raw-evidence`

- Disposition (plan 07 §1 + decision D2/D3): `keep-as-legacy-adapter` → packages/storage-d1 + packages/application (U05); migrations move in U05
- Required verification: kogane-ingest stays deployed until U15; migration filenames and bytes unchanged
- Execution status: PLANNED_NOT_EXECUTED (plan recorded `NOT_VERIFIED`)
- Live resources: LIVE(workers=kogane-ingest; buckets=kogane-raw-evidence)

#### `kogane-ingest` — `services/raw-evidence/wrangler.jsonc`

- Role: deployed; exists in the account: yes
- Entry point: src/worker.ts
- D1: DB → kogane-raw-evidence `b335a887-250d-45c9-bd72-af83f35fdc60` (migrations_dir `../../packages/storage-d1/migrations/core`)
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
