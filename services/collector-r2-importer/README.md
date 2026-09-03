# Collector R2 importer

各collectorのprivate R2をdurable outboxとして読み、中央`kogane-ingest`へraw-evidence契約に従って転送する内部専用Workerである。初期対応sourceはSBI証券だけ。

## SBI証券の境界

1. `kogane-sbi-collector-poc`がdata artifactを保存する。
2. 最後に`manifest.json`を保存し、runの境界を確定する。
3. このWorkerがmanifestのschema、日付/run IDを含むkey、scope、dataset、期間、prefix内の完全なinventory、各objectのsize・custom metadata・SHA-256を検証する。
4. 全source objectの検証後に初めて中央runを作り、元bytesを再serializeせず転送する。
5. data artifactを`collector_derived / transformed / source_bytes_not_available`、manifestを`collector_manifest / generated / not_applicable`として登録し、scope単位のterminal reportとrun terminal reportを記録してsealする。

元R2は中央転送に失敗しても変更・削除しない。次回の手動backfillで同じ`runId`へ冪等に再送できる。中央sealは「provider取得が成功した」ことではなく、「成功・部分成功・失敗を含む、そのrunの保存済み証拠が完全にcatalogueされた」ことを表す。

中央の`sourceRunKey`にはscopeと明示的なingest契約versionを含める。immutableな中央runへdescriptor契約を変更した実装を上書きせず、互換な再送だけを同じrunへ収束させるためである。

Service Bindingは公開URLを経由しない到達経路であり、認証の代用にはしない。中央APIにはSBI専用の`collector-r2-sbi` Bearer credentialを送り、DB registryも`collector-r2-importer → sbi-securities`だけを許可する。このWorker自体は`workers_dev: false`で外部公開しない。

## backfillの分割

SBIの完全な1 runは中央Workerを最大約23回呼ぶ。Cloudflareの1 requestに連なるWorker呼び出し上限へ抵触しないよう、`backfill-page`は1回につきR2 objectを1件だけ走査し、manifestを見つけた場合も1 runだけを転送する。呼出元は返されたcursorで別のtop-level requestを繰り返す。

## 検証とデプロイ

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
```

中央schema `0005`を先にデプロイした後、次を実行する。

```sh
bash scripts/deploy.sh
```

`sync-secrets.sh`はローカルのsystemd credentialから必要な2値だけをWorker secretへ渡す。値は表示しない。

- `RAW_EVIDENCE_TOKEN`: `collector-r2-sbi`専用Bearer
- `ORIGIN_FINGERPRINT_KEY`: storage keyを不可逆HMACへ変換する共通鍵

SBI collector側のhistorical outboxは次で再送する。

```sh
poc/sbi-securities-worker/scripts/backfill-raw-evidence.sh
```

source R2はbackfill完了後も自動削除しない。
