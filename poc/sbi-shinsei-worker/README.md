# SBI新生銀行 Worker collector PoC

SBI新生銀行 PowerDirect の read-only collector を Kogane 内で独立実装する PoC です。
`mnie` は dependency にせず、既存 Kogane collector と同じ R2 raw-store / manifest / daily Cron / authenticated manual trigger の境界だけを採用します。

## 現在の重要な制限

**Cloudflare Containers 経路は、TAMIAを明示指定したlive runでunattended収集まで成功しています。**

公開 login bundle と Kuebiko capture から MobileFirst/WLClient 形式の read route、session/CSRF token topology、core response schema を確認しました。ローカルCLIはCAFIS生成、login、Authorization/CSRF、core readsを同一Kuebiko Chrome target内で直列実行し、ブラウザ外へ返すのは4件のvalidated read JSONだけです。

- production Worker は Cloudflare Container を1 runごとに起動し、Container内のChromeでCAFIS生成、login、Authorization/CSRF、core readsを1つのpage内で直列実行する構成です。Workerはschedule、secret受け渡し、strict validation、R2保存だけを担当します。
- route catalog は exact-origin / exact-path / exact-method です。2026-08-31 の Kuebiko captureとローカル自動実行で成功したbootstrap 2件とcore read 4件だけが `productionEnabled: true` です。公開 bundle だけの候補は到達不能です。
- direct HTTP transport はproduction routeでも常に拒否します。Workerからpage外へ出るのは4件のraw JSONを包む単一JSON stringだけで、credential、CAFIS `jsc`、cookie、Authorization、CSRF、sessionStorageは出しません。
- Container/browserは成功・拒否・unknown responseの全経路で終了・破棄し、credential retryを行いません。
- top read成功後に後続core readが失敗した場合は、成功済みresponseとtop由来normalizedをpartial manifestへ残し、失敗したdatasetと未実行datasetを固定コードで記録します。top自体の失敗は従来どおりartifactなしのfailed manifestです。
- unknown content type、oversize body、JSON parse failure、未登録 schema は保存・解釈せず停止します。
- transfer、振込、振替、FX、定期預金作成・解約、memo/settings 等の write route は catalog に存在せず、path denylist でも拒否します。

最初のbounded automated loginはHTTP 200 / `CME0001`で停止しました。原因は実装が推測した`langCode=JPN`で、成功captureのexact値は`JAP`でした。credential、mode、postub flag、forward、user agentは一致していました。コードは`JAP`へ修正し、自動再試行は行っていません。これはAkamai拒否の証拠ではありません。

修正後のローカルsame-page実行はlogin、bootstrap、core read 4件をすべてHTTP 200で完了し、strict validation後のraw/normalized artifactをprivate local directoryへ保存しました。これはlocal Chrome経路の実証であり、Cloudflare上のunattended経路の成功証明ではありません。

Cloudflare Browser Run のbounded validationでは、公式入口とlogin直行の両方でCAFISが利用可能になる前にnavigation timeoutとなり、credentialを含むlogin POSTには到達しませんでした。そのためBrowser Run経路は現在のruntimeから外しています。

Cloudflare Containerでは、最初のimageに`xvfb-run`を起動wrapperとして使ったためNode serverがlistenせず、Workerから接続できませんでした。これはbank側の拒否ではなくcontainer startup bugで、NodeをPID 1にしてserver内からXvfbを起動する形へ修正済みです。

修正後のlocal Docker検証はstable Google Chrome、native Linux fingerprint、NRT/WARP接続中の日本出口で実施しました。page内direct fetchによるloginはHTTP 403で、Chromeへ遅延CDP接続した後に同じdirect fetchを行っても403でした。Patchright経路はmain-worldの実行差によりCAFIS collectorを利用できませんでした。一方、遅延CDP接続後に実フォームへ連続入力し、そのsubmit controlから銀行ページ自身の`login()`を実行するとloginはHTTP 200でした。画面が自動発行した`securityConnect`の後、login Authorizationと初期CSRFをContainer外へ出さずに同じpage内で受け渡し、`validateToken`とcore read 4件を明示実行して全件成功しました。

したがって、Windows fingerprint必須説はこの成功例で否定され、403を海外IPだけで説明する説も同じ日本出口で403/200が分かれたため否定されます。これは海外出口でも受理されることの証明ではありません。少なくとも現在の実装では、loginをdirect fetchで再構成せず、銀行ページ自身のフォーム/login処理を通すことが必要条件です。

## Cloudflare live validation

APAC placementのdirect Container（TAMIAなし）は、新しいimageの起動後もloginでHTTP 403になりました。そこでGLOBAL PASS PoCの既存方式を再利用し、Container-local HTTP CONNECT proxyから認証済みWebSocket `/tcp`へ接続し、WorkerのVPC bindingからTAMIAの`tunnel_id`を直接指定する経路へ変更しました。これは個人PC向けWARPのhostname routeを変更せず、SBI新生collectorの通信だけをTAMIAへ流します。

relayは宛先portを443に固定し、次のSBI専用allowlist以外を拒否します。

- `bk.web.sbishinseibank.co.jp`
- `www.sbishinseibank.co.jp`
- `distribute.cafisbrain.com`
- `diproxy.cafisbrain.com`
- `platform-websdk.transmitsecurity.io`

TAMIA経路のCloudflare live run `0e999a32-6994-450e-a495-2daff0e7aeb1` は `status=success`、failure 0、artifact 5件（raw 4件 + normalized 1件）でした。全artifactのhashは一致し、sizeは0より大きく、run後のContainer instanceはinactiveでした。確認時にartifact本文、残高、取引、credential、cookie、Authorization、CSRF/tokenは読み取っていません。

先行failure manifestも削除せず検証履歴として残しています。内訳はContainer rollout時のcold/listen failure 2件、direct Containerのlogin 403が1件、TAMIA image rollout中に旧response shapeへ当たったfailure 2件です。

詳細な観測根拠と次の capture 手順は [`INVESTIGATION-2026-08-31.md`](./INVESTIGATION-2026-08-31.md) に記録しています。

## Worker surface

| Trigger | Behavior |
| --- | --- |
| `GET /health` | schema version、source、live-read readiness のみ返す。 |
| `POST /trigger` | `Authorization: Bearer <ADMIN_TRIGGER_TOKEN>` 必須。実行時点のsnapshotを1回収集し、validated artifactとmanifestをR2へ保存。期間指定は受け付けない。 |
| `POST /backfill-raw-evidence?limit=1&cursor=...` | 同じadmin認証でprivate Service Bindingへ1ページだけ転送する。cursorは任意、limitは1固定。 |
| Cron `0 21 * * *` | 毎日 06:00 JSTに同じContainer収集を1回実行。全失敗はfailure manifestを保存した上でinvocationを失敗させ、部分取得はpartial evidenceとして保存・中央sealする。 |

R2 key:

```text
raw/sbi-shinsei/YYYY/MM/DD/<run-id>/manifest.json
raw/sbi-shinsei/YYYY/MM/DD/<run-id>/<verified artifact>
```

unknown response や authentication response body は R2 に保存しません。4件のcore responseはauthenticated captureとローカル実行で検証し、strict schemaを通過した場合だけ保存します。read継続に使うtop-level `header.newToken`は同一page内でrotationした後、Containerから出す前に削除してJSONを再encodeします。

現在の4 readはtop page由来のsnapshotです。manifestの`startedAt` / `completedAt`は実行時刻を表し、過去期間を取得済みとは記録しません。期間履歴を追加する場合は、期間を実際に送るread routeと取得範囲を別途検証してから導入します。

manifestを最後に不変条件付きで保存した後、private Service Binding経由で中央raw-evidenceへ即時importする。中央側は元bytes、hash、metadata、schema、normalizedの再計算結果を検証してからsealする。中央が失敗してもsource R2はoutboxとして残るため、次でcursor付き再送できる。

```bash
poc/sbi-shinsei-worker/scripts/backfill-raw-evidence.sh
```

初回本番確認は1 manifestだけで停止する。

```bash
KOGANE_STOP_AFTER_MANIFEST=1 \
  poc/sbi-shinsei-worker/scripts/backfill-raw-evidence.sh
```

スクリプトはR2 objectを1件ずつ走査し、失敗manifestでは停止する。canaryと通常完了の出力は件数だけで、object key、hash、本文を含めない。canaryはmanifest page後のcursorを保存しないため、その後のfull backfillで同じmanifestを冪等再送する。完了してもsource R2を削除しない。

backfillのadmin token fileは、current user所有のregular file、非symlink、mode 0600でなければ拒否する。file descriptorを`O_NOFOLLOW`で開き、同じdescriptorを`fstat`してから読み取る。

Kuebiko capture で得た core response の field-name topology は synthetic fixture と strict validator に反映済みです。1 sample だけなので known field を optional として扱う箇所がありますが、unknown field、unknown nested item、unknown schema は拒否します。validator実装だけでは route を有効化せず、exact request builder とaccepted browser-contextでの実行成功も必要です。

## Secret bindings

Cloudflare secret として設定します。値を repository、`.dev.vars`、log、PR に入れません。

- `SBI_SHINSEI_CREDENTIAL_JSON`
  - `{ "branchNumber": "...", "accountNumber": "...", "powerDirectPassword": "..." }`
- `ADMIN_TRIGGER_TOKEN`
- `RELAY_TOKEN`

`ADMIN_TRIGGER_TOKEN`はCloudflareから値を読み戻せないため、collector専用スクリプトでローカルfileとWorker secretを同じ値へ同期する。初回作成またはrotationは次を実行する。このスクリプトは32-byteの乱数を生成し、current user所有・mode 0600のregular non-symlink fileだけを使用する。token値はstdout、stderr、Wrangler引数へ出さない。

```bash
bash poc/sbi-shinsei-worker/scripts/sync-admin-trigger-token.sh --rotate
```

rotationは保護されたtemporary fileから同じdirectoryの`.pending`を原子的に作り、その値をstdinで`ADMIN_TRIGGER_TOKEN`へ同期する。Wrangler成功後だけ`.pending`を既定pathへatomic renameする。同期結果が不明または失敗した場合は、既存のlocal tokenを変更せず`.pending`を残す。新しいtokenを生成せず、次で同じ値を再送して回復する。

```bash
bash poc/sbi-shinsei-worker/scripts/sync-admin-trigger-token.sh --resume
```

既存local tokenをrotationせずWorkerへ再同期する場合だけ`--sync`を使う。`.pending`が存在する間は`--sync`と新しい`--rotate`を拒否する。成功出力はsecret名とlocal pathだけであり、直後にcanaryを実行する。

```bash
bash poc/sbi-shinsei-worker/scripts/sync-admin-trigger-token.sh --sync
KOGANE_STOP_AFTER_MANIFEST=1 \
  poc/sbi-shinsei-worker/scripts/backfill-raw-evidence.sh
```

ローカルCLIは次の順でcredentialを読みます。

1. `--credential-stdin` の標準入力（captureからdiskを介さず引き渡す検証用）
2. `SBI_SHINSEI_CREDENTIAL_JSON`
3. mode 0600の `/home/risu/.local/share/kogane/secrets/sbi-shinsei.json`

FIDO、SMS、telephone approval の値は collector secret に含めません。CLI引数へcredential値を渡しません。

## Local verification

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
bun run local:check
bun run local:check-jsc
```

`cf:check` は dry-run だけで、deploy しません。

実収集は、専用Kuebiko Chromeを公式login画面に置いた状態で次の形です。stdin JSONは画面やshell historyへ出さないproducerからpipeします。

```bash
credential_producer |
  bun run local:collect -- \
    --credential-stdin \
    --output-dir /home/risu/.local/share/kogane/raw/sbi-shinsei
```

出力directory/fileは0700/0600です。CLI logはstatus、artifact数、balance/transaction件数、保存先だけで、credential、CAFIS material、Authorization、CSRF、account valueを出しません。hybrid WSL-fetch実装は診断用に残しますが、主経路ではありません。

## Enablement checklist

catalog entry を production で有効にするには、同じ commit/PR で以下が必要です。

1. 専用 Kuebiko/Chrome profile の authenticated capture で exact method/origin/path/body names を確認。
2. read-only UI action と request の一対一対応を確認し、write side effect がないことを確認。
3. response content type、maximum size、required/optional keys、error/login-redirect shapes を sanitized synthetic fixture に落とす。
4. `newToken` rotation と 401/403/challenge/login redirect の stop behavior を test する。
5. credential、token、cookie、account number、customer name、real amount を capture note/fixture/log から除外。
6. same-session で一度だけ replay し、UI/export の行数・意味と一致することを確認。

この checklist を満たさない entry は daily/manual trigger から到達できません。

## Cleanup inventory

PoCを廃止するときは、次をまとめて削除します。現在はlive検証結果を保持するためactiveのままです。

- deployed WorkerとCron `0 21 * * *`;
- Cloudflare secrets 3件（SBI credential、admin trigger、relay）;
- success/failure manifestとartifactを含むR2 bucket;
- Container applicationとimage revisions;
- TAMIAの`tunnel_id`を直接指定するVPC binding設定;
- local Docker test container/image（検証終了後に削除）。


### Failure diagnostics

Collection failures emit a structured `*-collection-failure` event before teardown,
manifest storage, or central import. Join on `runId`; use `phase` to distinguish
collection from manifest-write, raw-evidence-import, teardown, and relay events.
The source R2 manifest retains the same three failure fields (`operation`,
`errorType`, `message`). Its bounded message includes the safe stage and available
HTTP status; structured logs expose these as `diagnostics` fields. The central
importer continues to normalize failure messages, so use the source manifest or
Worker logs for diagnosis.

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
stage start/end durations, including browser login, authenticated reads, storage,
central import and teardown. A validated partial handoff logs `partial`, and the
source terminal outcome remains distinct from central import and cleanup. The
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
Run `bun run test:relay` for loopback WebSocket tests of normal closure, delayed
handshakes, shutdown, and timeout fallback; these require only the root dev dependency.

Container lifecycle hooks retain bounded exit codes and fixed stop/error reasons.
HTTP 500 diagnostics distinguish the SDK's startup, disconnected-transport and
proxy-error envelopes using a maximum 2 KiB, one-second read; response text is
discarded. Unknown or unreadable responses stay unclassified. A 500 alone does
not prove that the Node process crashed; source completion and central import
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

Before manually triggering a smoke run, wait until the latest Container rollout
is `completed`, its target version/image matches the application's current
version/image, and any available prewarmed instances match that image. Do not
deploy another Container revision while the smoke run is in progress. After the
run, verify the actual assigned instance image as well; a successful run on an
older image does not validate the newly deployed code.

These read-only Cloudflare API endpoints expose the required metadata. Paths are
relative to `https://api.cloudflare.com/client/v4`; use the existing authenticated
operator session and substitute the relevant IDs:

| GET endpoint | Verification |
| --- | --- |
| `/accounts/<ACCOUNT_ID>/containers/applications/<APP_ID>` | Current application `version` and `configuration.image`. |
| `/accounts/<ACCOUNT_ID>/containers/applications/<APP_ID>/rollouts` | Latest rollout by `created_at`: `status`, `target_version`, and `target_configuration.image`. |
| `/accounts/<ACCOUNT_ID>/containers/dash/applications/<APP_ID>/instances` | Available instances and assigned `durable_objects`; resolve the run's `run-<RUN_ID>` name to its Durable Object ID. |
| `/accounts/<ACCOUNT_ID>/containers/dash/applications/<APP_ID>/instances/<DURABLE_OBJECT_ID>` | Actual `instance.app_version`, `instance.image`, and historical `placements[].events` / `placements[].status`. This endpoint also retains stopped-instance details omitted from the active instance list. |

For a stopped instance, inspect the `VMStopped` event's `statusChange` fields,
especially `runtime_reason` and `container_exit_code`, and compare its timestamp
with the collection failure and teardown logs. A recorded `runtime_reason=rollout`
identifies replacement by a deployment; a missing exit code is unknown, not zero.
Memory usage near the instance limit alone does not establish an OOM failure.

Keep inspection output to version/image, event name/time, health, runtime reason,
and exit code. Instance responses can also contain environment variables and
secret configuration: never dump the full response into logs, tickets or fixtures.
