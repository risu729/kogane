# Collector R2 importer

各collectorのprivate R2をdurable outboxとして読み、中央`kogane-ingest`へraw-evidence契約に従って転送する内部専用Workerである。現在はSBI証券、SBI VC Trade、Sony銀行、SBI新生銀行、Mobile Suica、GLOBAL PASSに対応する。

## GLOBAL PASSの境界

GLOBAL PASSはprivate R2の`prestia-globalpass`を、中央canonical source `global-pass`として取り込む。専用credential `collector-r2-global-pass`以外からこのrouteは利用できない。`POST /v1/prestia-globalpass/import-run`はmanifest 1件、`POST /v1/prestia-globalpass/backfill-page`は`raw/prestia-globalpass/`を1 objectだけ走査し、source R2を変更・削除しない。

旧`globalpass-browser-poc-v1`はactivity pageのNablarch動的stateと自由形式failure messageをsource R2へ保存していた。Importerはsource objectのkey、size、metadata、SHA-256、prefix inventoryを検証した後、監査済み2種類のHTML構造だけを受理する。非空の`nablarch_hidden`を固定sentinel `__KOGANE_REDACTED_DYNAMIC_VALUE__`へ置換し、元値を含まないUTF-8 bytesへ再encodeする。さらにcurrent-document fragmentの`href`を`#`へ、許可された`onclick`/`onchange`の値全体を`return false;`へ固定し、元fragmentやhandler引数を中央へ残さない。このinteractive属性の固定値はhidden sentinelとは別の変換である。自由形式messageも中央manifestへコピーせず、検証済みの固定error codeへ再生成する。

新`globalpass-browser-poc-v2`は同じsanitizationをsource R2保存前に行う。Importerはsentinel、空値の維持、DOCTYPE、activity marker、login/password control不在、静的form action、fragmentとevent handlerのcanonical固定値、2種類の入力/form件数を再検証し、bytesがcanonical UTF-8として不変である場合だけ受理する。`srcset`、`ping`、CSSの`url()`/`@import`、meta refresh、SVG URL属性、`base`/`object`/`embed`/`iframe`を含む未監査のnetwork/navigation sinkはfail closedとし、`href`/`src`/`action`も要素種別ごとのexact inventory以外を拒否する。中央HTMLは両versionとも`sanitized_provider_capture / transformed / source_not_retained_for_security`であり、provider-original exact bytesとは扱わない。

v2はavailable/selected month、daily先頭2か月またはbackfill全月、保存artifactと月別failureの補集合、status/captureCompleteを完全一致で検証する。v1のsuccessも期待月の完全一致を要求する一方、既存のpartial/failed runは成功へ昇格させず、manifestが宣言した観測inventoryとしてsealする。failed manifest-only runも0件のprovider artifactを持つ失敗証拠としてcatalogueする。dailyのHTML 2件とmanifestはdirect sealする。最大15か月のHTMLとmanifestの計16 artifactは中央Worker呼出上限を超えるため、完全inventoryを先に固定し、10 artifactずつ転送してoffset cursorから再開し、最終chunkだけterminal reportとsealを行う。Queueは使用しない。

## Sony銀行の空明細と取り込みログ

v2の円明細CSVは、保存済みの公式JSONで取引件数0を検証できる場合だけ省略を許容する。manifestの件数だけでは省略を認めず、件数・実際の行数・ページ数の整合も確認する。以前のCSVを含む0件runとlegacy v1の既存契約は引き続き受け付ける。

`sony-bank-import-diagnostic`は収集run IDと取り込みattempt IDを相関キーに、処理段階、所要時間、予定・新規転送・再利用件数、保留理由、次の転送位置を記録する。例外本文、認証情報、storage key、取引本文はログに出さない。ログ出力の失敗は取り込み結果に影響しない。

`deferred / worker_invocation_limit / nextOffset:0`は取り込み失敗ではなく、同期呼び出し上限を超えるrunの分割待ちを表す。既存のSony backfillは別requestごとに最大10 objectを転送し、最後にsealする。同じ収集を再実行してもこの保留は解消しないため、保存済みmanifestのbackfillを再開する。

## Mobile Suicaの境界

Mobile Suicaは1 runにつきSF履歴HTML 1 page、normalized JSON、collection summary、manifestの最大4 objectだけを扱う。100行未満の1 pageはcompleteなsuccessとして、v2のちょうど100行は`history_boundary_unproven`を伴うpartial evidenceとして取り込む。v1の100行success、複数page、期間coverageの推測は中央state作成前に拒否する。

旧`mobile-suica-worker-poc-v1`のShift_JIS/CP932 HTMLには短命な`baseVariable`が残る。Importerはsource R2の元bytes/hashを検証した後、正確に1つの非空hidden valueを固定sentinelへ置換し、CP932へ再encodeした派生物だけを中央へ送る。新`mobile-suica-worker-poc-v2`は同じsanitizerをR2保存前に実行し、Importerはsentinel済みであることを再検証する。どちらも中央では`sanitized_provider_capture / transformed / source_not_retained_for_security`であり、provider-original exact bytesとは扱わない。normalized JSONはHTMLが保存されたrunではsanitized HTMLへのinput lineageを持つ。HTMLのR2保存だけが失敗したrunではnormalized JSONを独立に厳密検証し、入力関係を捏造せず`source_not_retained_for_security`として登録する。

`POST /v1/mobile-suica/import-run`はmanifestを1件importし、`POST /v1/mobile-suica/backfill-page`は`raw/mobile-suica/`を1 objectだけ走査する。最大4 artifactなのでchunk/Queueは不要で、32 Worker invocation上限内で同期sealできる。source R2は成功後も削除しない。

## SBI証券の境界

1. `kogane-sbi-collector-poc`がdata artifactを保存する。
2. 最後に`manifest.json`を保存し、runの境界を確定する。
3. このWorkerがmanifestのschema、日付/run IDを含むkey、scope、dataset、期間、prefix内の完全なinventory、各objectのsize・custom metadata・SHA-256を検証する。
4. 全source objectの検証後に初めて中央runを作り、元bytesを再serializeせず転送する。
5. data artifactを`collector_derived / transformed / source_bytes_not_available`、manifestを`collector_manifest / generated / not_applicable`として登録し、scope単位のterminal reportとrun terminal reportを記録してsealする。

元R2は中央転送に失敗しても変更・削除しない。次回の手動backfillで同じ`runId`へ冪等に再送できる。中央sealは「provider取得が成功した」ことではなく、「成功・部分成功・失敗を含む、そのrunの保存済み証拠が完全にcatalogueされた」ことを表す。

中央の`sourceRunKey`にはscopeと明示的なingest契約versionを含める。immutableな中央runへdescriptor契約を変更した実装を上書きせず、互換な再送だけを同じrunへ収束させるためである。

Service Bindingは公開URLを経由しない到達経路であり、認証の代用にはしない。中央APIにはSBI専用の`collector-r2-sbi` Bearer credentialを送り、DB registryも`collector-r2-importer → sbi-securities`だけを許可する。このWorker自体は`workers_dev: false`で外部公開しない。

## SBI VC Tradeの境界

SBI VC TradeのmanifestはSBI証券とは共有せず、`sbi-vc-trade-worker-poc-v1`専用validatorで扱う。固定4 datasetの順序、約定履歴とJPY入出金履歴の1始まり連番、各pageの`list`/`totalSize`終了条件、最大100 page、失敗時の保存済みprefixと次datasetの補集合を検証する。さらにmanifestと全artifactについてkey、size、完全一致custom metadata、JSON content type、SHA-256、prefix内の完全inventoryを確認する。

最大runは4 MiB artifactを204個含み得るため、全runをmemoryへ保持しない。中央run作成前に1 objectずつ全件検証してpage metadataだけを保持し、中央転送時に同じobjectを再読込・再検証して元bytesをそのまま送る。同期経路はService Bindingの32 Worker invocation上限からdata artifact 11件までに制限し、それを超えるrunは中央stateを一切作らず後続Queue reconcilerへ委ねる。R2 outboxは成功時も失敗時も削除しない。

中央では`collector-r2-sbi-vc`専用credentialを使い、registryも`collector-r2-importer → sbi-vc-trade`だけを許可する。SBI証券credentialをSBI VC Trade routeへ流用できない。

## backfillの分割

SBI証券の完全な1 runは中央Workerを最大約23回呼ぶ。Cloudflareの1 requestに連なるWorker呼び出し上限へ抵触しないよう、`backfill-page`は1回につきR2 objectを1件だけ走査し、manifestを見つけた場合も1 runだけを転送する。SBI VC Tradeはdata artifact 11件を超えるmanifestを`sync_import_worker_chain_limit`で中央state作成前に停止する。backfillではこの既知の上限を失敗でなくdeferredとして数え、R2 cursorを先へ進めるため、後続runをpoison pillとして遮断しない。大きなrun自体は後続Queue reconcilerがartifact単位で処理する。

SBI新生銀行はmanifest込み最大6 objectで、中央呼び出しは最大17回に収まる。`backfill-page`は他sourceと同様にR2 objectを1件ずつ走査し、manifestを見つけたページだけ同期転送する。cursorはcollector側のローカルstateへ原子的に保存し、失敗manifestでは進めない。

GLOBAL PASSのdaily小runは同期転送する。12 artifactを超える即時importは中央stateを作らず`202 deferred`を返す。backfillはmanifestを見つけたページでstaged inventoryを開始し、1回につき10 artifactを転送する。cursorはR2のscan cursorにmanifest keyとoffsetを加えたopaque値で、同じmanifestの続きではR2を再走査せず、最終chunkをsealしてから次のsource objectへ進む。scriptは`deferredManifestCount`を正常な進捗として数え、cursorが進まない応答を拒否する。

## 検証とデプロイ

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
```

SBI新生銀行を有効化する本番作業は、必ず次の順で直列実行する。Service Bindingのtargetをcallerより先にdeployし、collector deployが有効化するdaily cronより前に依存先を検証する。

1. 中央raw-evidenceへremote D1 migration `0008`を適用してWorkerをdeployする。

   ```sh
   (
     cd services/raw-evidence
     bash scripts/deploy.sh
   )
   ```

   このscriptは不変のdatabase名`kogane-raw-evidence`を指定し、deploy後にhealth、synthetic round trip、SBI新生route/policyが各1件であることを件数だけで検証する。D1確認でrun ID、object key、hash、本文、金額は出力しない。

2. importerのpreflight後、secretを先に同期・名前だけ検証してからimporterをdeployする。

   ```sh
   (
     cd services/collector-r2-importer
     bash scripts/deploy.sh
   )
   ```

   `deploy.sh`は`test`、`typecheck`、dry-runの後に`sync-secrets.sh`を実行し、その成功後にだけ`wrangler deploy`へ進む。`sync-secrets.sh`はローカルのsystemd credentialから各source専用tokenとfingerprint keyを単一bulk requestで作成・更新する。指定外の既存secretは削除せず、検証出力には次の名前だけを含めて値は表示しない。

- `RAW_EVIDENCE_TOKEN`: `collector-r2-sbi`専用Bearer
- `RAW_EVIDENCE_TOKEN_SBI_VC`: `collector-r2-sbi-vc`専用Bearer
- `RAW_EVIDENCE_TOKEN_SONY`: `collector-r2-sony-bank`専用Bearer
- `RAW_EVIDENCE_TOKEN_SBI_SHINSEI`: `collector-r2-sbi-shinsei`専用Bearer
- `RAW_EVIDENCE_TOKEN_MOBILE_SUICA`: `collector-r2-mobile-suica`専用Bearer
- `RAW_EVIDENCE_TOKEN_GLOBAL_PASS`: `collector-r2-global-pass`専用Bearer
- `ORIGIN_FINGERPRINT_KEY`: storage keyを不可逆HMACへ変換する共通鍵

3. target importerのdeploy成功後にSBI新生collectorをdeployする。これはService Bindingとdaily cronを有効化するため、`0 21 * * *`の直前を避け、次回cronまでに以降の確認を完了する。

   ```sh
   (
     cd poc/sbi-shinsei-worker
     bun install --frozen-lockfile
     bun test
     bun run typecheck
     bun run cf:check
     npx wrangler deploy
   )
   curl --fail-with-body --silent --show-error \
     https://kogane-sbi-shinsei-collector-poc.takuanimal.workers.dev/health
   ```

4. historical outboxは、最初に1 manifestだけcanary importする。canaryはobject key、hash、本文を出力せず、manifest件数だけを返す。canaryはmanifest page後のcursorを保存しないため、full backfillは同じmanifestを意図的に冪等再送する。

   ```sh
   KOGANE_STOP_AFTER_MANIFEST=1 \
     poc/sbi-shinsei-worker/scripts/backfill-raw-evidence.sh
   ```

5. canary後に中央D1のSBI新生run数、seal数、artifact数を`COUNT`だけで記録し、full backfillを実行する。

   ```sh
   poc/sbi-shinsei-worker/scripts/backfill-raw-evidence.sh
   ```

6. cursorが完了時に削除された後、full backfillをもう一度実行する。中央のrun数、seal数、artifact数が不変であることを確認する。再送attempt数は増えてよい。2回のscan page数も比較し、途中に新規収集がなければ同数であることを確認する。

### GLOBAL PASSの本番適用

GLOBAL PASSは次の順序で直列に適用する。backfill中はdaily cronの時刻を避け、legacy source R2の事前・事後inventoryを件数と集約checksumだけで記録する。object key、個別hash、HTML、manifest本文、認証値は出力しない。

適用開始前に、現行collectorのWorker version、Container image digest、runtime revision、cron一覧、Service Binding、R2、TAMIA Tunnel bindingを運用記録へ保存する。rollback可能性を担保するため、v19相当のWorker codeとContainer imageを特定できる情報を残す。secret値、object key、個別hash、取得本文は記録しない。この時点でcronが`17 18 * * *`の1件だけ、GLOBAL PASSのVPC経路がTAMIA Tunnel直接指定、旧Container instanceがinactiveであることも確認する。

1. 中央raw-evidenceのmigration `0010`をremote D1へ適用し、中央Workerを先にdeployする。

   ```sh
   (
     cd services/raw-evidence
     bash scripts/deploy.sh
   )
   ```

   deploy後にhealthのschemaが`0010`であること、`collector-r2-global-pass → collector-r2-importer → global-pass`のactive routeと`raw/prestia-globalpass/{date}/{run-id}/{artifact}` policyが各1件であることを`verify-global-pass-route.sh`で確認する。

2. `RAW_EVIDENCE_TOKEN_GLOBAL_PASS`を他source tokenと共有せず同期し、`collector-r2-importer-v8`をdeployする。

   ```sh
   (
     cd services/collector-r2-importer
     bash scripts/deploy.sh
   )
   ```

   secret確認では名前だけを扱う。値、長さ、fingerprintをCI outputや作業記録へ残さない。healthがv8を返し、Service Binding targetが新しいdeployであることをcollectorより先に確認する。

3. importer成功後にGLOBAL PASS collector v20をdeployする。Container image rolloutは非同期なので、deploy出力だけで完了とせず、新image digestがhealthyになったことを確認する。deploy出力でdaily cron `17 18 * * *`が1件だけで、GitHub Actions scheduleがないことも確認する。

   ```sh
   (
     cd poc/globalpass-worker
     bun install --frozen-lockfile
     bun test
     bun run typecheck
     bun run deploy:dry
     bun run deploy
   )
   ```

4. legacy v1は、空のscan cursorから管理token付き`POST /backfill-raw-evidence?limit=1`を1 pageずつ呼び、最初のmanifestだけをcanaryにする。`deferredManifestCount: 1`なら返されたopaque cursorで同じmanifestの次chunkを続け、`importedManifestCount: 1`とsealed resultを得た時点で停止する。このcanaryではcursor fileを保存しないため、full backfillが同じmanifestを先頭から冪等再送する。失敗時はfull backfillへ進まない。

5. canary前後の中央件数を次の集約queryだけで記録し、run 1件がsealedされ、artifact数がmanifest宣言数だけ増えたことを確認する。

   ```sh
   (
     cd services/raw-evidence
     npx wrangler d1 execute kogane-raw-evidence --remote --command \
       "SELECT
          (SELECT COUNT(*) FROM fetch_runs WHERE source_id = 'global-pass') AS run_count,
          (SELECT COUNT(*) FROM fetch_run_seals s JOIN fetch_runs r ON r.id = s.fetch_run_id WHERE r.source_id = 'global-pass') AS seal_count,
          (SELECT COUNT(*) FROM fetch_artifacts a JOIN fetch_runs r ON r.id = a.fetch_run_id WHERE r.source_id = 'global-pass') AS artifact_count;"
   )
   ```

6. canary成功後にfull backfillを完走する。

   ```sh
   poc/globalpass-worker/scripts/backfill-raw-evidence.sh
   ```

   完了時にcursor fileが削除されること、`failedManifestCount`が常に0であること、全manifestが最終的にsealedされたことを確認する。事前・事後のlegacy source R2 inventoryの件数と集約checksumは同一でなければならない。

7. cursorが消えた状態から同じscriptをもう一度実行し、先頭からreplayする。中央の`run_count`、`seal_count`、`artifact_count`がすべて不変であることを上のqueryで確認する。attempt数とreused判定は増えてよい。source R2 inventoryも不変でなければならない。

8. historical replay後にv2 live canaryを手動dailyで1回だけ実行する。

   ```sh
   poc/globalpass-worker/scripts/trigger.sh daily
   ```

   公開結果がcollection successかつcentral sealedであること、保存manifestが`globalpass-browser-poc-v2`、selected monthが最大2件、HTMLがsanitized済みであることを値や本文を出さず確認する。daily小runがdeferredになった場合は運用開始せず調査する。

9. 次のcron `17 18 * * *`後に、新しいv2 manifestが1件作られ、同じrunが中央でsealedされ、失敗ログがないことを確認する。cronによる意図した新規object増加と、historical backfillによるsource R2変更を混同しない。ここまで完了してGLOBAL PASS rolloutを完了とする。

v20のmanual live canaryまたは次回cronが失敗した場合は、新しい収集を止め、collector WorkerとContainer imageだけを適用前に記録したv19相当へrollbackする。加算migration `0010`と`collector-r2-importer-v8`は後方互換の中央受入境界として残し、rollbackしない。source R2 objectも変更・削除しない。rollback後はcronが1件だけであること、TAMIA Tunnel bindingが維持されていること、不要な旧・失敗Container instanceがinactiveであることを再確認してからdailyを再開する。

v20のmanual live canaryと次回cronが成功した後は、運用記録の現行値を実際のWorker version、新Container image digest、runtime revision `timezone-collector-v7`へ更新する。更新時もdigest以外のsource object情報や認証値は記録しない。

他collector側のhistorical outboxも次で再送できる。

```sh
poc/sbi-securities-worker/scripts/backfill-raw-evidence.sh
poc/sbi-vc-trade-worker/scripts/backfill-raw-evidence.sh
poc/sony-bank-worker/scripts/backfill-raw-evidence.sh
poc/sbi-shinsei-worker/scripts/backfill-raw-evidence.sh
poc/mobile-suica-worker/scripts/backfill-raw-evidence.sh
poc/globalpass-worker/scripts/backfill-raw-evidence.sh
```

source R2はbackfill完了後も自動削除しない。

### 2026-09-05 本番検証

canary後に旧captureとの互換不一致を修正し、中断地点から再開したfull backfillと、完了後に先頭から行った再走査はいずれも完走した。中断地点からの再開は32 pagesで12 manifests、先頭からの再走査は37 pagesで17 manifestsを処理した。最終D1集計は17 runs、17 sealed、0 unsealed、37 artifactsで、再走査の前後で件数は変化しなかった。source R2のobjectは変更・削除していない。

## SBI新生銀行の境界

SBI新生銀行はContainer内の銀行ページ自身のlogin処理を通した後、strict validation済みのcore response 4件とcollector生成の`normalized.json`をprivate R2へ保存する。importerはlogin、cookie、Authorization、CSRF、CAFIS materialを受け取らず、保存済みrunだけを読む。

`sbi-shinsei-worker-poc-v1`専用validatorは、固定5 datasetとfilename・順序、success/partial/failedと`r2:<dataset>`失敗の完全な補集合、prefix内の完全inventory、JSON media type、size、custom metadata、native/計算SHA-256を検証する。raw 4件はcollectorから独立して複製したresponse schemaで再検証し、`normalized.json`はtop responseから再計算した残高・明細とcanonical一致する場合だけ受理する。

top取得後のprovider read失敗は`read:<dataset>`で表し、後続の未実行datasetを含めて保存済みartifactとの完全な補集合にする。これにより、exchange rate等の後半readが失敗しても、それ以前に取得・検証できたtopや残高summaryを捨てず、`provider-read-incomplete`のpartial evidenceとしてsealできる。自由形式のprovider error本文は中央へ渡さない。

導入前に保存されたrunには、現在の型から削除済みの`window`がmanifestに含まれる。互換経路は「windowなしの現行shape」と「windowだけを追加した旧shape」の2種類に限定する。top artifactのactivity `toDate`がある旧runは、従来どおり`fromDate`/`toDate`をwindowと完全一致させる。deployed旧variantが`toDate: ""`を返す場合だけ、window終端がstarted/completed日の双方と一致し、raw `fromDate`がwindow開始以前で、全posting dateがraw開始以上かつwindow終端以下である場合に限って受理する。この旧windowはproviderが宣言した完全な取得範囲ではないため、中央artifactに`ranges`は発行しない。collect失敗またはtopのR2書込み失敗でtop自体がないrunも、windowを取得済み範囲とは扱わず、失敗証拠をそのままcatalogueする。任意fieldの追加は許可しない。

R2 custom metadataは、既存の2/3-key形とこのPR以後のsource/run/hash付き4-key形を、それぞれ完全一致で受理する。manifestのwindow削除とmetadata強化は別時期の変更なので両者を不必要に結合せず、追加keyを含む曖昧なshapeは拒否する。

raw 4件はresponse textへのtransport decode後、top-level `header.newToken`を取り除いて再encodeし、`sanitized_provider_capture / transformed / source_not_retained_for_security`として登録する。normalizedは`collector_derived / transformed`としてtop responseへlineageを張り、manifestは`collector_derived / transformed / source_not_retained_for_security`として登録する。導入前のR2 objectに一時CSRF値が含まれていても、その値を中央へ複製しない。中央ではcanonical source `sbi-shinsei-bank`へaliasを解決し、`collector-r2-sbi-shinsei`専用credential/routeだけを許可する。元R2は即時import・backfillの成否にかかわらず変更・削除しない。

## Sony銀行の境界

`sony-bank-worker-poc-v2`専用validatorはmanifest、prefix inventory、R2 metadata、保存bytesとSHA-256、JSON/CSV/HTML media typeを検証する。円と10外貨の3件単位page連番、外貨CSVの件数条件、1〜15か月のWALLET selector、collection summary、`r2:<dataset>`失敗との補集合まで一致した場合だけ中央状態を作る。

導入前に保存された`sony-bank-worker-poc-v1`は、総残高・円履歴page・円CSV・v1 summaryだけを許す別契約として検証し、v1 namespace/format versionのまま取り込む。v1に外貨・WALLETなどv2 datasetが混在する場合は拒否する。

R2書込み失敗で欠けたhistory pageやWALLET HTMLも、manifestの順序付きfailureが保存済みartifactとの完全な補集合で、page番号・summary件数・statusが整合する場合はpartial/failed evidenceとしてcatalogueする。欠けたprovider bytesを成功扱いせず、terminal reportの固定failure codeに残す。

- BFF JSONはresponse textをUTF-8へ再encodeしたため`provider_response / transport_decoded`。
- 公式CSVは受信bytesをそのまま保存するため`provider_export / exact`。
- WALLET HTMLはJSESSIONIDとhidden値を除去してUTF-8へ再encodeするため`sanitized_provider_capture / transformed / source_not_retained_for_security`。
- collection summaryとmanifestはcollector生成物である。

Cloudflareは1 requestあたりWorker invocationを32回に制限する。Sony銀行の正常runは最小でもmanifest込み16 objectなので即時要求はsource全体の検証後に`202 deferred`を返し、source R2保存を成功のまま保つ。backfillは毎回source全体を再検証してから、staged inventoryへ最大10 objectずつ冪等転送する。cursorはR2走査位置とrun内offsetを保持し、最終chunkだけterminal reportとsealを行う。

reconciler導入前は、通常収集後に上記backfill scriptを実行してsealまで進める必要がある。各chunkの応答に含まれる`finalChunkAllObjectsReused`は、run全体ではなくsealした最後のchunk内だけの再利用判定である。新規manifestのfailure messageは固定コードだけを保存する。既存v2 manifestは互換のため検証後に取り込めるが、自由形式messageを中央のfailure codeには転記しない。
