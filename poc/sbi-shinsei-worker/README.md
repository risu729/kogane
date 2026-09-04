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
