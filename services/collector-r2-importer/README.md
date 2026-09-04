# Collector R2 importer

各collectorのprivate R2をdurable outboxとして読み、中央`kogane-ingest`へraw-evidence契約に従って転送する内部専用Workerである。現在はSBI証券、SBI VC Trade、Sony銀行、SBI新生銀行に対応する。

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

   `deploy.sh`は`test`、`typecheck`、dry-runの後に`sync-secrets.sh`を実行し、その成功後にだけ`wrangler deploy`へ進む。`sync-secrets.sh`はローカルのsystemd credentialから5 secretを単一bulk requestで作成・更新する。指定外の既存secretは削除せず、検証出力には次の名前だけを含めて値は表示しない。

- `RAW_EVIDENCE_TOKEN`: `collector-r2-sbi`専用Bearer
- `RAW_EVIDENCE_TOKEN_SBI_VC`: `collector-r2-sbi-vc`専用Bearer
- `RAW_EVIDENCE_TOKEN_SONY`: `collector-r2-sony-bank`専用Bearer
- `RAW_EVIDENCE_TOKEN_SBI_SHINSEI`: `collector-r2-sbi-shinsei`専用Bearer
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

他collector側のhistorical outboxも次で再送できる。

```sh
poc/sbi-securities-worker/scripts/backfill-raw-evidence.sh
poc/sbi-vc-trade-worker/scripts/backfill-raw-evidence.sh
poc/sony-bank-worker/scripts/backfill-raw-evidence.sh
poc/sbi-shinsei-worker/scripts/backfill-raw-evidence.sh
```

source R2はbackfill完了後も自動削除しない。

## SBI新生銀行の境界

SBI新生銀行はContainer内の銀行ページ自身のlogin処理を通した後、strict validation済みのcore response 4件とcollector生成の`normalized.json`をprivate R2へ保存する。importerはlogin、cookie、Authorization、CSRF、CAFIS materialを受け取らず、保存済みrunだけを読む。

`sbi-shinsei-worker-poc-v1`専用validatorは、固定5 datasetとfilename・順序、success/partial/failedと`r2:<dataset>`失敗の完全な補集合、prefix内の完全inventory、JSON media type、size、custom metadata、native/計算SHA-256を検証する。raw 4件はcollectorから独立して複製したresponse schemaで再検証し、`normalized.json`はtop responseから再計算した残高・明細とcanonical一致する場合だけ受理する。

top取得後のprovider read失敗は`read:<dataset>`で表し、後続の未実行datasetを含めて保存済みartifactとの完全な補集合にする。これにより、exchange rate等の後半readが失敗しても、それ以前に取得・検証できたtopや残高summaryを捨てず、`provider-read-incomplete`のpartial evidenceとしてsealできる。自由形式のprovider error本文は中央へ渡さない。

導入前に保存されたrunには、現在の型から削除済みの`window`がmanifestに含まれる。互換経路は「windowなしの現行shape」と「windowだけを追加した旧shape」の2種類に限定し、top artifactが保存されている場合は旧windowをactivityの`fromDate`/`toDate`と一致させる。collect失敗またはtopのR2書込み失敗でtop自体がないrunは、windowを取得済み範囲とは扱わず、失敗証拠をそのままcatalogueする。任意fieldの追加は許可しない。

R2 custom metadataは、既存の2/3-key形とこのPR以後のsource/run/hash付き4-key形を、それぞれ完全一致で受理する。manifestのwindow削除とmetadata強化は別時期の変更なので両者を不必要に結合せず、追加keyを含む曖昧なshapeは拒否する。

raw 4件はresponse textへのtransport decode後、top-level `header.newToken`を取り除いて再encodeし、`sanitized_provider_capture / transformed / source_not_retained_for_security`として登録する。normalizedは`collector_derived / transformed`としてtop responseへlineageを張り、manifestは`collector_manifest / generated`として登録する。導入前のR2 objectに一時CSRF値が含まれていても、その値を中央へ複製しない。中央ではcanonical source `sbi-shinsei-bank`へaliasを解決し、`collector-r2-sbi-shinsei`専用credential/routeだけを許可する。元R2は即時import・backfillの成否にかかわらず変更・削除しない。

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
