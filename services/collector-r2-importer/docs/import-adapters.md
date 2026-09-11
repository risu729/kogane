# Import adapters

## Purpose

Every collector outbox reaches central raw evidence through the same application command. Before this change the importer's `fetch` handler carried one hand-written branch per source (JSON read, allowed keys, key and continuation budgets, 200/202 mapping) while the Queue reconciler carried a second, separately maintained switch over the same sources. The two entry points could drift without any test noticing.

`src/adapters/` now holds one `ImportAdapter` per reconciler source. The HTTP import-run routes, the backfill cursors, and the Queue reconciler all call `executeImport`; the registry check in CI fails when an adapter and the reconciler's source table disagree. Public URLs, request and response bodies, status codes, error codes, and the Queue message schema (`kogane-r2-outbox-reconciler-v1`) are unchanged, so no collector is redeployed and in-flight Queue messages from the previous importer still terminate.

## Contract

```ts
interface ImportCommand {
  source: ImportSource; // a RECONCILER_SOURCES key
  terminalKey: string; // manifest key, Vpass record key, or normalized pair key
  mode: "immediate" | "staged";
}

type ResumeState =
  | { kind: "none" }
  | { kind: "token"; token: string } // opaque signed or encrypted transfer state
  | { kind: "offset"; offset: number }; // artifact offset into a staged inventory

interface ImportAdapter<TResult> {
  id: ImportSource;
  contractVersion: string; // the source's INGEST_CONTRACT_VERSION
  resumeKind: "none" | "token" | "offset"; // must equal RECONCILER_SOURCES[id].resume
  http: { importRun: string; backfillPage: { path: string; cursorBudget: number } } | null;
  validateCommand(input: unknown): ImportCommand; // HTTP body -> command
  validateResume(input: unknown, command: ImportCommand): ResumeState; // HTTP body -> resume
  step(env: Env, command: ImportCommand, resume: ResumeState): Promise<TResult>;
  repairPolicy: { outbox(env: Env): R2Bucket };
}

executeImport(env, source, command, resume): Promise<{ result: TResult; status: "sealed" | "deferred" }>;
reconcilerOutcome(result): ImportOutcome; // Queue continuation, fails closed on non-progress
```

`mode` records who is calling. `immediate` is a synchronous collector call that cannot resume by offset, so an offset-resumed source (GLOBAL PASS, Sony Bank, SMBC Direct, V Point) may answer `202 deferred` before creating central state, exactly as before. `staged` is the Queue reconciler or a backfill cursor, which resumes with the offset or token the source returned. Token-resumed sources (MyJCB, MoneyForward, Vpass, SBI VC Trade) behave the same in both modes; sources that never defer (Mobile Suica, SBI Securities, SBI Shinsei, V Point Pay email) ignore it.

`ResumeState` is internal only. On the wire the HTTP body still carries `continuation` as a string and the Queue message still carries `resume` as `string | number | null`; `resumeFromWire` in `src/adapters/contract.ts` converts a Queue value using the reconciler's declared resume kind, and each adapter's `validateResume` converts an HTTP body using that source's own budget.

## Entry points

| Entry                                | Validation                                                                       | Mode        | Result mapping                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/<source>/import-run`       | `adapter.validateCommand`, then `adapter.validateResume`                         | `immediate` | `202` when the source result is `deferred`, otherwise `200`; the body is the source result unchanged |
| `POST /v1/<source>/backfill-page`    | shared `cursor`/`limit` keys, source `cursorBudget`, source cursor decoding      | `staged`    | source-specific page summary, unchanged                                                              |
| Queue message or R2 notification     | `parseMessage` (schema, terminal key pattern, resume kind) then `resumeFromWire` | `staged`    | `reconcilerOutcome`: `sealed` acks; `deferred` re-enqueues step+1 only when `nextOffset` advanced    |
| `POST /v1/vpass/import-card-binding` | `recordKey` only                                                                 | n/a         | Vpass identity sidecar; not an import command, kept as a dedicated route                             |

Errors keep their codes: `unknown_field`, `manifest_key_invalid`, `record_key_invalid`, `normalized_key_invalid`, `continuation_invalid`, `cursor_invalid`, `backfill_limit_must_be_one`, `json_invalid`, `json_shape_invalid`, `json_too_large`; unknown paths and methods answer `404 not_found`. Two new `500` codes name programming errors that no wire input can reach: `import_command_source_mismatch` and `import_resume_kind_mismatch`.

## Shared versus per source

| Shared                                                             | Kept in the source module or its adapter                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| sealed / deferred outcome contract and 200/202 mapping             | manifest shape, artifact validation, origin fingerprinting, card binding derivation         |
| Queue continuation (`reconcilerOutcome`, progress and step limits) | continuation token encoding and verification (HMAC or AES-GCM), offset chunk sizes          |
| body reading, JSON budget, error code sanitization                 | allowed request keys, terminal key field name, key and continuation budgets, cursor budgets |
| registry consistency check, route index                            | immediate deferral thresholds, partial-run rules, per-source backfill cursor state          |
| repair listing through `repairPolicy.outbox`                       | bucket binding, credential, `INGEST_CONTRACT_VERSION`                                       |

Budgets were transcribed one to one. MyJCB, MoneyForward, and SBI VC Trade accept a continuation up to 8,000 characters; Vpass up to 16,000; backfill cursors range from 4,096 (Mobile Suica, SBI Securities, SBI Shinsei, SBI VC Trade, V Point Pay email) to 24,000 (Vpass). The Queue path still validates `resume` at the reconciler-wide 16,000 character limit before the source decoder applies its own bound, as before.

## Adding a source

1. Implement `import<Source>Run` in `src/<source>.ts` and export its `INGEST_CONTRACT_VERSION`. Its result must expose `status`, `nextOffset`, and `continuation` when it can defer, or `sealed: true` when it cannot.
2. Add `src/adapters/<source>.ts` using `httpCommand`, `httpTokenResume` or `httpNoResume`, and `resumeToken`, `resumeOffset`, or `assertNoResume`, and declare `repairPolicy.outbox` with the R2 binding.
3. Register the adapter in `IMPORT_ADAPTERS` (`src/adapters/index.ts`) and the queue spec (bucket name, prefix, terminal pattern, resume kind) in `RECONCILER_SOURCES` (`src/reconciler.ts`).
4. Add the backfill cursor handler to `BACKFILL_HANDLERS` in `src/worker.ts`.
5. Add the R2 binding and credential to `wrangler.jsonc`, `env.d.ts`, `scripts/sync-secrets.sh`, and the notification rule to `scripts/r2-reconciler-notifications.ts`; update the table in `docs/r2-outbox-reconciler.md`.
6. Add a synthetic fixture under `test/synthetic/` and a parity case in `test/import-parity.test.ts` (legacy expectations, adapter HTTP, Queue), plus the frozen route in `test/import-adapters.test.ts`.

Nothing else needs to change: the route index, the Queue dispatch, the weekly repair seeds, and the log source allowlist derive from the registry.

## What CI checks

`bun test` runs `test/import-adapters.test.ts`, and `bun scripts/check-import-adapters.ts` runs the same `checkImportAdapterRegistry` as a standalone exit status. Together they assert:

- every `RECONCILER_SOURCES` entry has an adapter whose `id` and `resumeKind` match, and every adapter has a reconciler entry;
- each declared `import-run` and `backfill-page` path is a versioned `/v1/<source>/...` route, is unique, and is routed to its own adapter; every declared route answers a malformed POST with `400 json_invalid`, and unknown paths, other methods, or a query string answer `404`;
- the frozen list of 24 public URLs plus the Vpass sidecar route has not changed;
- each `repairPolicy.outbox` binding resolves, through `wrangler.jsonc`, to the bucket named in `RECONCILER_SOURCES`;
- the weekly repair seeds cover exactly the registered adapters;
- the check itself reports a removed adapter, a resume-kind change, an unrouted or unversioned path, and an orphan adapter.

`test/import-parity.test.ts` drives the same synthetic MyJCB, MoneyForward, and Vpass runs through the previous HTTP branch (copied into the test), the adapter route, and the Queue reconciler, and requires identical central calls, HTTP statuses and bodies, outcomes, and continuations (decoded offsets for MoneyForward's encrypted token). It also compares request validation for all twelve import-run and backfill-page routes against the previous per-source parameters. `test/reconciler.test.ts` covers in-flight messages from the previous deployment, a deferred step that makes no progress, a duplicated notification, and a duplicated repair page.

## Invariants, deploy order, rollback

- Wire compatibility: URLs, bodies, status and error codes, and the Queue schema are byte-for-byte those of the previous deployment (verified by the parity and registry tests with synthetic data; not verified against production traffic).
- No change to descriptor hashing, `central.ts`, `raw-evidence`, migrations, queues, bindings, or secrets. No feature flag: the change is a refactor with identical observable behaviour.
- Deploy order: the importer Worker alone (`./node_modules/.bin/wrangler deploy` after `bun test`, `mise run importer:typecheck`, `mise run importer:dry-run`). Collectors and central are untouched.
- Rollback: redeploy the previous importer version. In-flight Queue messages are readable by both versions because the schema is unchanged; per-source rollback is not needed because every source keeps its previous validation and import module.
