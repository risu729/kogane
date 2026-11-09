<a id="sbi新生銀行-worker-collector-poc"></a>

# `SBI新生銀行` (SBI Shinsei Bank) Worker collector PoC

A PoC independently implementing an SBI Shinsei Bank PowerDirect read-only collector in Kogane. It does not depend on `mnie`; it adopts only the shared DATA raw-store / terminal-manifest / Processor-alarm-schedule boundaries used by existing Kogane collectors.

<a id="現在の重要な制限"></a>

## Current important limitations

**The Cloudflare Containers path has successfully completed unattended collection in a live run explicitly using TAMIA.**

The public login bundle and Kuebiko captures confirmed MobileFirst/WLClient-style read routes, session/CSRF-token topology and core response schemas. The local CLI serially performs CAFIS generation, login, Authorization/CSRF and core reads within the same Kuebiko Chrome target; only 4 validated read JSON responses leave the browser.

- The production Worker starts a Cloudflare Container per 1 run. Chrome inside it serially performs CAFIS generation, login, Authorization/CSRF and core reads within 1 page. The Worker handles only scheduling, secret handoff, strict validation and R2 storage.
- The route catalog uses exact origins, paths and methods. Only the 2 bootstrap and 4 core-read routes successful in the 2026-08-31 Kuebiko capture and local automated run have `productionEnabled: true`. Candidates based only on the public bundle are unreachable.
- Direct HTTP transport is always refused, even for production routes. Only a single JSON string wrapping the 4 raw JSON responses leaves the page for the Worker; credentials, CAFIS `jsc`, cookies, Authorization, CSRF and sessionStorage do not leave it.
- The Container/browser is stopped and discarded after success, refusal or unknown responses, without credential retries.
- If a later core read fails after a successful top read, successful responses and top-derived normalized data remain in a partial manifest; failed and unattempted datasets use fixed codes. Failure of top itself still produces a failed manifest with no artifacts.
- Unknown content types, oversized bodies, JSON parse failures and unregistered schemas stop processing without storage or interpretation.
- Write routes for transfers, remittances, account transfers, FX, time-deposit creation/cancellation and memo/settings are absent from the catalog and also refused by the path denylist.

The first bounded automated login stopped at HTTP 200 / `CME0001`. The cause was implementation-guessed `langCode=JPN`; the successful capture's exact value was `JAP`. Credentials, mode, postub flag, forward and user agent matched. The code was corrected to `JAP`, without an automatic retry. This is not evidence of Akamai rejection.

After correction, local same-page execution completed login, bootstrap and all 4 core reads with HTTP 200, saving raw/normalized artifacts to a private local directory after strict validation. This demonstrates the local Chrome path, not successful unattended execution on Cloudflare.

Bounded Cloudflare Browser Run validation timed out in navigation before CAFIS became available through either the official entrypoint or direct login. It never reached a credential-bearing login POST. The Browser Run path is therefore excluded from the current runtime.

The initial Cloudflare Container image used `xvfb-run` as its startup wrapper, leaving the Node server unable to listen and the Worker unable to connect. This was a container-startup bug rather than bank rejection; Node is now PID 1 and starts Xvfb inside the server.

Local Docker verification after correction used stable Google Chrome, a native Linux fingerprint and Japanese egress while connected through NRT/WARP. Login through page-internal direct fetch returned HTTP 403; the same direct fetch still returned 403 after delayed CDP attachment to Chrome. The Patchright path could not use the CAFIS collector because of main-world execution differences. In contrast, after delayed CDP attachment, sequentially filling the actual form and invoking the bank page's own `login()` through its submit control returned HTTP 200. After the page automatically issued `securityConnect`, login Authorization and initial CSRF were passed within the same page without leaving the Container; explicit `validateToken` and all 4 core reads succeeded.

This success disproves a mandatory Windows fingerprint. The differing 403/200 results through the same Japanese egress also disprove an explanation of 403 based solely on foreign IPs. It does not prove acceptance through foreign egress. At least in the current implementation, using the bank page's own form/login processing, rather than reconstructing login with direct fetch, is necessary.

## Cloudflare live validation

A direct Container with APAC placement (without TAMIA) still received HTTP 403 at login after the new image started. The path was changed to reuse the existing GLOBAL PASS PoC approach: a Container-local HTTP CONNECT proxy connects to authenticated WebSocket `/tcp`, and the Worker's VPC binding specifies TAMIA's `tunnel_id` directly. This sends only SBI Shinsei collector traffic through TAMIA without changing hostname routes for the personal PC's WARP.

The relay fixes destination ports to 443 and refuses everything outside this SBI-specific allowlist.

- `bk.web.sbishinseibank.co.jp`
- `www.sbishinseibank.co.jp`
- `distribute.cafisbrain.com`
- `diproxy.cafisbrain.com`
- `platform-websdk.transmitsecurity.io`

TAMIA-path Cloudflare live run `0e999a32-6994-450e-a495-2daff0e7aeb1` had `status=success`, failure 0 and 5 artifacts (4 raw + 1 normalized). Every artifact hash matched, sizes were greater than 0, and the Container instance was inactive after the run. Verification did not read artifact bodies, balances, transactions, credentials, cookies, Authorization or CSRF/tokens.

Earlier failure manifests remain as verification history: 2 cold/listen failures during Container rollout, 1 direct-Container login 403 and 2 failures encountering the old response shape during TAMIA image rollout.

Detailed evidence and next capture steps are recorded in [`INVESTIGATION-2026-08-31.md`](./INVESTIGATION-2026-08-31.md).

## Worker surface

| Trigger                           | Behavior                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                     | Returns only schema version, source and live-read readiness.                                                                                                                                                   |
| Private `ScheduledCollection` RPC | Collects the current snapshot through the existing fixed action. Public `/trigger` returns 404.                                                                                                                |
| Processor alarm `sbi-shinsei`     | The Processor's `ScheduleAlarm` calls `runScheduled` daily at 06:00 JST (`config/alarm-jobs.json`). Total failure saves a failure terminal and returns `failed`; partial capture is saved as partial evidence. |

R2 keys (shared DATA bucket `kogane-raw-evidence`):

```text
objects/<2 hex>/<sha256>                    manifest.json and each verified artifact
runs/sbi-shinsei/<run-id>/terminal.json     run completion record written last (artifact key/object mapping)
```

Unknown responses and authentication-response bodies are not stored in R2. The 4 core responses were verified by authenticated capture and local execution and are stored only after passing strict schemas. Top-level `header.newToken`, used to continue reads, is rotated within the same page, removed before leaving the Container, and the JSON is re-encoded.

The current 4 reads are top-page snapshots. Manifest `startedAt` / `completedAt` record execution times, without claiming past-period capture. Adding period history requires separate verification of a read route that actually sends a period and of its capture range.

Period-selected history and CSV remain unapproved candidate routes in the catalog; every execution profile refuses them before session access or communication. Based on ordinary UI observation on 2026-10-10, `src/local/history-observation.ts` provides an explicit-period yen ordinary-deposit request (locally limited to 31 days) and **offline validation only** of already captured JSON/CSV. It distinguishes normal JSON details, provider-reported empty responses and unverified errors, checking period/account context and all 6 CSV columns. CSV is browser-decoded text declaring `Shift_JIS`, not confirmation of original bytes or downloaded-file storage. Every result retains `coverageStatus: unknown`.

This module is not called by the Worker, Container or existing parser; it neither communicates, stores, adopts nor enables production behavior. The existing 4 raw + 1 normalized snapshot is unchanged. CSV session-token acquisition/rotation, original-byte storage, paging/limits/`purgeflag` meaning and electronic transaction-report routes/schemas remain unverified. [ADR 0070](../../docs/adr/0070-sbi-shinsei-observed-history-boundary.md) and the [next capture-slice plan](../../docs/plans/2026-10-sbi-shinsei-history-first-slice.md) record the conditions remaining before production capture is extended.

`packages/collection` writes runs directly to shared DATA, retaining the 4 provider responses and normalized snapshot in memory until the terminal is written. The Processor registers DATA terminals in-process ([processor.md](../../docs/processor.md)). Private Service Binding calls to the central importer, `POST /backfill-raw-evidence`, `scripts/backfill-raw-evidence.sh` and the dedicated source bucket were retired on 2026-09-13 ([legacy-retirement.md](../../docs/legacy-retirement.md)).

Core-response field-name topology from Kuebiko captures is reflected in synthetic fixtures and strict validators. Some known fields are optional because only 1 sample exists; unknown fields, unknown nested items and unknown schemas are refused. A validator implementation alone does not enable a route: an exact request builder and successful execution in an accepted browser context are also required.

## Secret bindings

Configure these as Cloudflare secrets. Keep values out of the repository, `.dev.vars`, logs and PRs.

- `SBI_SHINSEI_CREDENTIAL_JSON`
  - `{ "branchNumber": "...", "accountNumber": "...", "powerDirectPassword": "..." }`
- `RELAY_TOKEN`

The public admin entrypoint and dedicated token-synchronization script are retired. `RELAY_TOKEN` and bank credentials are unchanged.

The local CLI reads credentials in this order.

1. Standard input with `--credential-stdin` (for verification handoff from capture without disk).
2. `SBI_SHINSEI_CREDENTIAL_JSON`.
3. `/home/risu/.local/share/kogane/secrets/sbi-shinsei.json` with mode 0600.

FIDO, SMS and telephone-approval values are not collector secrets. Do not pass credential values as CLI arguments.

## Local verification

```bash
mise run install                                 # from the repository root
mise run //services/collector-sbi-shinsei:test
mise run //services/collector-sbi-shinsei:ci       # typecheck, cf-typecheck, test, container
mise run //services/collector-sbi-shinsei:dry-run
bun src/local/cli.ts --dry-run
bun src/local/check-jsc.ts
```

`dry-run` and `cf-build` only build and validate; neither deploys.

For real capture, place dedicated Kuebiko Chrome on the official login screen and use this form. Pipe stdin JSON from a producer that displays it in neither the terminal nor shell history.

```bash
credential_producer |
  bun src/local/cli.ts -- \
    --credential-stdin \
    --output-dir /home/risu/.local/share/kogane/raw/sbi-shinsei
```

Output directories/files use 0700/0600. CLI logs contain only status, artifact counts, balance/transaction counts and destination, excluding credentials, CAFIS material, Authorization, CSRF and account values. The hybrid WSL-fetch implementation remains for diagnostics, outside the main path.

## Enablement checklist

Production enablement of a catalog entry requires all of the following in the same commit/PR.

1. Confirm exact method/origin/path/body names in an authenticated capture with a dedicated Kuebiko/Chrome profile.
2. Confirm the one-to-one mapping between a read-only UI action and request, without write side effects.
3. Represent response content type, maximum size, required/optional keys and error/login-redirect shapes in sanitized synthetic fixtures.
4. Test `newToken` rotation and stopping on 401/403/challenge/login redirects.
5. Exclude credentials, tokens, cookies, account numbers, customer names and real amounts from capture notes, fixtures and logs.
6. Replay only once within the same session and confirm row counts/meaning match the UI/export.

Entries not meeting this checklist cannot be reached from daily alarms or operations requests.

## Cleanup inventory

When retiring this PoC, remove the following together. It currently remains active to retain live-verification results.

- deployed Worker (its schedule is the Processor's `sbi-shinsei` alarm job; the Worker has no Cron Trigger);
- the two Cloudflare secrets `SBI_SHINSEI_CREDENTIAL_JSON` and `RELAY_TOKEN` (the admin trigger secret is no longer read);
- (the old dedicated source R2 bucket was deleted on 2026-09-13; keep shared DATA because other collectors and the Processor also use it);
- Container application and image revisions;
- VPC binding configuration specifying TAMIA's `tunnel_id` directly;
- local Docker test container/image (remove after verification).

### Failure diagnostics

Collection failures emit a structured `*-collection-failure` event before teardown
or the DATA write. Join on `runId`; use `phase` to distinguish collection from
teardown, relay and shared-persist events. The event carries the safe stage and
available HTTP status as `diagnostics` fields. The collector manifest stored in
DATA keeps the three failure fields (`operation`, `errorType`, `message`), but its
`message` is an allowlisted code (`safeFailureMessage` in
`src/shared-collection.ts`) without the stage or HTTP status, so use the Worker
logs for diagnosis.

No exception message, stack, cause, request URL, credential, response body, or
unrecognized provider text is logged. Sony logs only fixed operation IDs/currencies
and the count of provider errors (no provider codes are currently approved for
logging). Shinsei accepts only known browser stages and records whether authentication
was attempted. Relay events include `runId`, a relay-specific `relayId`, stage,
duration, and close reason. A transport error observed before close remains an
error. Socket/stream rejections after peer or upstream closure are informational
`expected-close` cleanup events, rather than collection failures. Every socket and
stream lifecycle promise is observed, and cleanup releases readers and writers.
An unknown stage stays `unknown-browser-stage`; a failed read is separate from
subsequent `NotAttempted` reads. No retries or collection requests are added.

Worker `sbi-shinsei-stage` and Container `sbi-shinsei-container-stage` events provide
stage start/end durations, including browser login, authenticated reads, storage
(`shared-persist`) and teardown. A validated partial handoff logs `partial`, and the
source terminal outcome remains distinct from storage and cleanup. The
Container image must be rebuilt to include `stage-diagnostics.mjs`; deploying only
the Worker updates relay cleanup but does not update browser-side stage logging.

The Container CONNECT proxy now sends a normal WebSocket close (code 1000) on
local TCP closure and waits for all active relay handshakes before returning
from shutdown, including relays whose TCP socket has already disappeared. Only
connection failures or a two-second close timeout force termination. Abrupt
termination can otherwise appear as a runtime `Network connection lost` exception
in the Cloudflare response pump even after application cleanup promises settle.
`sbi-shinsei-container-relay-closed` records the bounded close code and outcome.
TCP EOF retains the stream's existing data flush, then sends explicit close code
1000 through the relay's public WebSocket close method. Explicit peer close codes
pass through unchanged. An unexpected code 1006 remains `abnormal-close`
even if the WebSocket did not emit a separate error event.
Chrome-side TCP resets retain `failureStage=local-tcp`, but an already established
Worker WebSocket still completes a normal close handshake. Worker relay events
include only the bounded peer close code and `wasClean` flag, never close reason
text, so platform-level disconnections can be distinguished from application
cleanup without exposing connection details.
Every local CONNECT socket keeps an `error` listener for its whole life, so a
Chrome reset ends that tunnel, never the Container process. A refused CONNECT
(a host outside the allowlist, or a port other than 443) is answered 403 and
then drained so its close is seen. Before 2026-11-08 a reset on such a socket
was an unhandled `read ECONNRESET` (the crash seen in the GLOBAL PASS copy of
this relay). On shutdown the proxy logs one `sbi-shinsei-container-relay-summary`
line: `connects`, `refused`, `refusedWhileClosing`, `established`,
`upstreamFailed` (502), `upstreamTimeout` (504), `abandoned` (Chrome reset it
before any answer), `serverErrors` and `socketErrors` by closed code, with the
run id and no host. The outcome counts add up to `connects`.
Run `node --test container/relay-lifecycle.node-test.mjs container/child-lifecycle.node-test.mjs` for loopback WebSocket tests of normal closure, delayed
handshakes, shutdown, and timeout fallback; these require only the root dev dependency.

Container lifecycle hooks retain bounded exit codes and fixed stop/error reasons.
HTTP 500 diagnostics distinguish the SDK's startup, disconnected-transport and
proxy-error envelopes using a maximum 2 KiB, one-second read; response text is
discarded. Unknown or unreadable responses stay unclassified. A 500 alone does
not prove that the Node process crashed; source completion and storage
remain separate outcomes. These diagnostic changes do not retry collection.

### Correlate relay activity and unused preconnections

The Container sends one empty binary WebSocket data frame when the relay opens,
before acknowledging CONNECT or forwarding TLS data. `initial-frame-queued`
records this zero-byte frame; it adds one queued frame and no queued bytes, and
does not count as a closing event. The Worker ignores empty payloads for upstream
connection creation, so an unused preconnection still creates no VPC socket.
Initial send failures remain visible and bounded by the connection deadline.
This preserves TLS byte order and addresses the observed zero-message close
case; collection success and runtime-error absence still need live verification.

Join Container and Worker relay logs using `runId` and `relayId`: each CONNECT
relay generates a UUID that the Worker accepts only after validation. Container
events record fixed target labels, sent/received data-message counts and bytes,
sampled buffer sizes, requested/received close codes, and an ordered close timeline.
`firstCloseEvent` is the first observed closing event, not proof of which remote
component initiated shutdown; later stage events may follow the terminal record.
Worker counters distinguish WebSocket receipt, completed upstream writes,
upstream reads, and queued WebSocket replies, with pending-write counts, sequence
numbers and activity/cleanup timings. Queued bytes do not prove peer delivery,
and completed socket writes do not prove that the bank processed those bytes.

The HTTPS relay creates its upstream VPC socket only when the first non-empty
client data reaches the write queue. An unused browser preconnection can therefore
close normally with `socketCreated=false` and zero upstream traffic; no VPC socket
was created for that connection. `socketCreated=true` distinguishes a connection
that reached the upstream transport. The destination allowlist and port443 policy
remain unchanged. Use these fields to locate a failure boundary; they do not by
themselves establish the cause of a platform runtime exception. Payloads, tokens,
URLs and arbitrary exception text remain excluded from diagnostics.

### Verify the Container rollout before a manual smoke run

A completed Worker deployment does not mean the Container image rollout has
finished. A newly assigned Durable Object can receive an older prewarmed image
while that rollout is replacing instances. The platform can then stop that image
during an authenticated read, producing an SDK HTTP 500 even when the bank login
succeeded. Do not attribute an unclassified Container HTTP 500 to the bank.

Before a smoke run, wait until the latest Container rollout
is `completed`, its target version/image matches the application's current
version/image, and any available prewarmed instances match that image. Do not
deploy another Container revision while the smoke run is in progress. After the
run, verify the actual assigned instance image as well; a successful run on an
older image does not validate the newly deployed code.

These read-only Cloudflare API endpoints expose the required metadata. Paths are
relative to `https://api.cloudflare.com/client/v4`; use the existing authenticated
operator session and substitute the relevant IDs:

| GET endpoint                                                                                 | Verification                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/accounts/<ACCOUNT_ID>/containers/applications/<APP_ID>`                                    | Current application `version` and `configuration.image`.                                                                                                                                                  |
| `/accounts/<ACCOUNT_ID>/containers/applications/<APP_ID>/rollouts`                           | Latest rollout by `created_at`: `status`, `target_version`, and `target_configuration.image`.                                                                                                             |
| `/accounts/<ACCOUNT_ID>/containers/dash/applications/<APP_ID>/instances`                     | Available instances and assigned `durable_objects`; resolve the run's `run-<RUN_ID>` name to its Durable Object ID.                                                                                       |
| `/accounts/<ACCOUNT_ID>/containers/dash/applications/<APP_ID>/instances/<DURABLE_OBJECT_ID>` | Actual `instance.app_version`, `instance.image`, and historical `placements[].events` / `placements[].status`. This endpoint also retains stopped-instance details omitted from the active instance list. |

For a stopped instance, inspect the `VMStopped` event's `statusChange` fields,
especially `runtime_reason` and `container_exit_code`, and compare its timestamp
with the collection failure and teardown logs. A recorded `runtime_reason=rollout`
identifies replacement by a deployment; a missing exit code is unknown, not zero.
Memory usage near the instance limit alone does not establish an OOM failure.

Keep inspection output to version/image, event name/time, health, runtime reason,
and exit code. Instance responses can also contain environment variables and
secret configuration: never dump the full response into logs, tickets or fixtures.
