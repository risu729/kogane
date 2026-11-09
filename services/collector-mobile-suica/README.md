# Mobile Suica read-only Worker PoC

A PoC that runs daily in a Cloudflare Worker from JRE ID passkey authentication through Mobile Suica SF-history storage. The Worker does not access Bitwarden. Only when authentication material changes does the owner unlock Bitwarden in WSL and copy the necessary JRE ID credential into Worker Secret `JRE_ID_CREDENTIAL_JSON`.

Daily execution uses only this path.

1. Read the source-scoped JRE ID credential from the Worker Secret.
2. Start Cloudflare Browser Rendering and temporarily register the credential in a CDP virtual authenticator.
3. Navigate from the official Mobile Suica entrypoint to JRE ID, running the page's own Fingerprint/Fraud Defense processing and WebAuthn ceremony.
4. Click `SF（電子マネー）利用履歴` ("SF electronic-money usage history") in the member menu, receiving the history screen's short-lived cookies and `baseVariable` only inside the Worker.
5. Fetch only 1 history page with plain Worker `fetch`. After parsing HTML, replace its sole `baseVariable` with `__KOGANE_REDACTED_BASE_VARIABLE__`, re-encode sanitized HTML as CP932, and save it, normalized JSON and summary to shared DATA (`kogane-raw-evidence`).
6. Writes the run's `terminal-v1` manifest last (`src/shared-run.ts`, `packages/collection`);
   the Processor registers the terminal in process. There is no Service Binding import any
   more (see Captured artifacts below).

Bitwarden vaults, master passwords, `BW_SESSION`, JRE ID passwords, cookies and raw WebAuthn assertions are stored in neither R2, logs, manifests nor Git.

## 2026-08-31 live validation

- Locally verified signatures with the P-256 credential for `id.jreast.co.jp` returned by WSL `bw` CLI.
- `bw:sync` copied only username, RP ID, credential ID, user handle, counter and PKCS#8 private key into the source-scoped Worker Secret.
- Worker cryptographic checks succeeded with ES256, a 16-byte credential ID, 37-byte authenticator data, flags `0x1d` and counter 0.
- Direct JRE API calls through both plain Worker and TAMIA VPC returned `CO-AT5000` at `AUTH_FS2`, before the WebAuthn challenge. Copying Fingerprint values from a successful capture did not change this; IP alone did not solve it. This failed path was removed from execution.
- Browser Rendering received JRE challenge `CO-SC0001`, the virtual authenticator returned an assertion, and navigation returned to the Mobile Suica member menu.
- Member-menu `StartApplication` uses a JavaScript-generated POST rather than URL GET. The successful path goes from `POST /ka/lg/SuicaChangeTransfer.aspx` to `POST /iq/ir/SuicaDisp.aspx`.
- Passing the browser session to plain Worker fetch saved 15 records, 1 page, 3 artifacts and failure 0 in private R2. Rereading the R2 manifest also confirmed complete storage.

## 2026-09-05 production raw-evidence verification

- Central `kogane-ingest` schema `0009`, version `cd26355d-36b0-4eb9-b93f-57b588113429`, final Importer version `72067520-54bc-414b-81d7-2861746f96e4` and collector v2 version `dccc680b-f365-4ede-9071-2370a9138baf` were verified. Cron stayed `10 21 * * *`.
- Source R2 had 40 objects / 10 manifests. After a precheck processed 1 page, initial resume processed the remaining 39 pages, reaching 40 pages / 10 manifests. A subsequent full replay also scanned 40 pages / 10 manifests.
- Central state changed from 0 runs before backfill to 10 runs / 10 sealed / 0 unsealed / 40 artifacts. Full replay retained those counts; idempotent resends created no extra run or artifact.
- All 10 central HTML objects were valid CP932, each had 1 fixed sentinel, and `baseVariable` held only that sentinel. Actual object keys, hashes and history bodies are not recorded.
- Source R2's 40 objects were neither changed nor deleted by backfill/replay.
- Only narrow compatibility was added for actual old-v1 shapes: accept `capturedSessionAt` from the same browser session captured before the run only when canonical ISO and no later than `completedAt`; normalize parameterized HTML media types, strictly validated in R2, to `text/html` in the central descriptor.
- A manual live-v2 canary was not run. Without changing the existing schedule, the next scheduled 06:10 JST run is the next canary to check.

<a id="収集物"></a>

## Captured artifacts

```text
objects/<2 hex>/<sha256>                    sf-history-page-0001.html, sf-history.json, collection-summary.json
runs/mobile-suica/<run-id>/terminal.json    run completion record written last (artifact key/object mapping)
```

`packages/collection` writes runs to shared DATA (`kogane-raw-evidence`); the Processor registers terminals in-process ([processor.md](../../docs/processor.md)). The dedicated source bucket, `RAW_EVIDENCE_IMPORTER` Service Binding and backfill script were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)).

HTML and JSON contain the owner's transport/purchase history, balances and amounts. The R2 bucket must not be public. Stored HTML already has `baseVariable` replaced by a fixed sentinel; the original value is not saved to R2. Cookies, passkeys and WebAuthn assertions are not stored either.

Date search uses `指定日以前` ("on or before the specified day"), with at most 100 records per 1 page. v2 captures only 1 page: fewer than 100 records is complete success; exactly 100 saves the 3 artifacts, then returns `partial` / `history_boundary_unproven`. It does not move to a previous-day cursor or claim complete capture.
The alarm entry point (`alarmCollection`, `src/worker.ts`) reports a persisted `partial`
run as completed (`packages/collection/src/schedule-result.ts`); the `partial` status and
its issue code stay on the terminal. A run whose terminal was not written is reported as failed.

Each object's R2 custom metadata contains only `sha256` and `byteSize` written by `packages/collection`.

<a id="bitwardenからのローカル同期"></a>

## Local synchronization from Bitwarden

Synchronize only after passkey registration/update/deletion, a JRE ID change or similar changes. The Worker's daily execution never connects to Bitwarden.

```sh
cd services/collector-mobile-suica
export BW_SESSION="$(bw unlock --raw)"
node scripts/verify-bitwarden-passkey.mjs
node scripts/sync-bitwarden-passkey.mjs
unset BW_SESSION
```

`scripts/sync-bitwarden-passkey.mjs` first checks that exactly 1 credential matches RP ID `id.jreast.co.jp`, then runs `wrangler secret put JRE_ID_CREDENTIAL_JSON`. It sends neither the whole vault nor master password. Local `scripts/verify-bitwarden-passkey.mjs` verifies signatures. The former public `/credential-check` and browser diagnostic entrypoints return 404 and expose no credential state.

<a id="実行"></a>

## Execution

The Worker has no Cron Trigger (`triggers.crons` is empty in `wrangler.jsonc`). The
Processor's `ScheduleAlarm` calls `ScheduledCollection.runScheduled`
(`src/schedule-entrypoint.ts`) for the `mobile-suica` job in
[`config/alarm-jobs.json`](../../config/alarm-jobs.json): daily at 06:10 JST (21:10 UTC),
which avoids the 00:50–05:00 JST service outage. Normal collection uses only the existing fixed-action private RPC path. The old `/trigger?asOf=YYYY-MM-DD` returns 404; arbitrary-date selection is retired.

```sh
mise run install                                  # from the repository root
mise run //services/collector-mobile-suica:test      # bun suite, then the Miniflare R2 suite
mise run //services/collector-mobile-suica:ci
mise run //services/collector-mobile-suica:dry-run
```

Production deployment is the release workflow's, in the order of
[`infra/deploy-order.json`](../../infra/deploy-order.json), with a `/health` postcheck.

No admin bearer is needed. A registered admin secret is deleted only after the matching code is in production and zero remaining dependencies have been confirmed.

<a id="resourceとcleanup"></a>

## Resources and cleanup

- Worker: `kogane-mobile-suica-collector-poc`
- Browser binding: `BROWSER`
- R2 binding: `DATA` → `kogane-raw-evidence` (shared by all collectors; the old dedicated source bucket was deleted on 2026-09-13)
- Schedule: Processor alarm job `mobile-suica` (`config/alarm-jobs.json`, `10 21 * * *` UTC); no Cron Trigger
- D1 binding: `SCHEDULE_DB` → `kogane-raw-evidence` (the execution lease, `packages/collection/src/schedule-lease.ts`)
- Secrets: `JRE_ID_CREDENTIAL_JSON`

The former `MOBILE_SUICA_SESSION_JSON`, `JRE_ID_FINGERPRINT` and TAMIA VPC binding are unnecessary for execution. Cleanup deletes only the Worker. Keep shared DATA because other collectors and the Processor also use it.
