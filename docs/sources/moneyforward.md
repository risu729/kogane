# MoneyForward ME collector source record

- 調査日: 2026-08-31、2026-09-07（Asia/Tokyo）
- canonical source: `moneyforward-me`
- collector: `poc/moneyforward-worker`
- 対象: 認証済みMoneyForward ME画面の連携先一覧、口座詳細、直近12か月の月別明細fragment
- 対象外: 金融機関側の更新要求、連携追加・削除、振込・支払・取引、MoneyForward設定変更、
  provider公式明細と同等の完全性の主張

## 結論

MoneyForward MEは、公式金融機関sourceへ直接到達できない期間の補助snapshotとして利用する。
MoneyForwardが取得・正規化して画面へ表示した内容であり、各金融機関の公式raw response、全期間、
pending/posted状態、取引ID、更新直後の完全性を保証しない。中央ではcanonical sourceを
`moneyforward-me`のまま保持し、SMBC、Vpass等の公式sourceへ付け替えない。

既存collectorはMoneyForward IDの保存済みpasskeyで毎run新しいsessionを作り、read-only route
だけを取得する。収集bytesはprivate R2へmanifest-lastで保存する。Layer A importerはこのR2を
immutable outboxとしてstrict validationし、中央raw-evidenceへ転送する。source R2へのwrite、
move、deleteは行わない。

## 調査方法と秘匿境界

2026-08-31のcollector検証は、所有者の既存accountとBitwarden保存済みpasskeyを用いて、
ローカルおよびCloudflare Workersのread-only collectionを実行した。2026-09-07のimporter監査は
localhost限定の一時Workerとproduction R2のread-only bindingを使い、全取得可能objectを
走査した。

監査結果とGit記録には件数、schema、固定failure codeだけを残す。object key、個別hash、本文、
残高、取引、口座識別子、CSRF、session、Cookie、passkey material、secretは出力・保存しない。
source R2の前後でwrite/deleteを実行していない。

## 収集surfaceとrun境界

collectorが許可するread surfaceは次の3種類だけである。

1. 連携先一覧の完全HTML 1件
2. 一覧から列挙した各口座の詳細HTML 1件
3. 各口座について当月を含む直近12か月の明細HTML fragment

manifestは`moneyforward-worker-poc-v1`で、日付、run UUID、開始・完了時刻、status、
artifact順序、dataset、media type、byte size、SHA-256、失敗stageを宣言する。manifest自身を
最後に保存することで、prefixだけを見て未完runを成功扱いしない。

完全な収集順序はaccounts index、その後に各口座のdetail、同口座の12か月fragmentである。
R2 write failure時は保存済みartifactがこの順序のsubsequenceで、failureが欠落分の完全な補集合
でなければならない。provider read failureとR2 write failureを混同せず、status、failure stage、
failure code、保存artifact数を相互照合する。

## Layer A strict validation

中央stateを作る前に、Importerは次をすべて検証する。

- manifest keyの日付/run UUIDとmanifest本文の一致、exact field set、固定schema
- manifest objectのcontent type、size、exact custom metadata、native checksum（存在時）、
  再計算SHA-256
- 同一prefixの全object inventoryをcursor付きで走査し、manifestと完全一致すること
- artifactごとのfilename、dataset、media type、size、metadata、native/recomputed SHA-256
- UTF-8 HTML、accounts indexの一意なdetail link数、detailのCSRF・account/service marker
- monthly artifactが完全documentでないfragmentで、宣言年月とfilenameが一致すること
- status、failure、期待dataset、保存artifact、順序、件数の完全な関係

未知field、未知dataset、重複key、過剰account、13か月以上、巨大object、cursor停滞、prefix外key、
宣言外objectはfail closedである。実装上の上限は64 accounts、各12か月、data artifact最大833、
artifact最大8 MiB、manifestを含むrun合計64 MiBである。

## 中央raw-evidence contract

中央routeはmigration `0014_moneyforward_collector_r2.sql`が定義する専用client
`collector-r2-moneyforward`、producer `collector-r2-importer`、source `moneyforward-me`だけを
許可する。storage origin templateは
`raw/moneyforward/{date}/{run-id}/{artifact}`に固定し、具体的なsource keyはHMAC fingerprintへ
変換する。

data artifactはsource R2 bytesを再serializeせず
`provider_response / exact / not_applicable`としてcatalogueする。中央用manifestは自由形式failure
messageを固定codeへ置換した新規生成物なので、source manifestと同一bytesとは扱わない。

中央runは固定`sourceRunKey`とcontract `producerVersion: moneyforward-r2-v1`を使う。
deploymentごとに変わるImporter revisionをterminal reportへ入れず、失敗・中断attemptの診断に
だけ記録する。これにより同じsource runを別deploymentからreplayしてもimmutable descriptor、
terminal report、sealへ収束する。

## Bounded replay

完全inventoryを固定後、1 requestあたり5 data artifactsをstaged inventoryへ転送する。
versioned HMAC continuationはmanifest、中央run/unit、inventory digest、offsetを束縛する。
artifactを各chunkで再読込し、固定inventoryとsize/hashが一致しなければ停止する。最終chunkだけ
unit/run terminal reportを追加してsealする。

backfill scan cursorもversioned HMACで保護し、R2 cursorの最大長、外側cursorの最大長、
最大page数、transfer token長、offset進行を制限する。処理中manifestがsealされるまでsource scan
cursorを進めない。collector側stateにはopaque cursorだけをmode 0600で保存する。

## Production R2 aggregate audit

2026-09-07のread-only full scanでは、manifest 10件とdata artifact 530件を検査した。statusは
success 10 / partial 0 / failed 0、内訳はaccounts index 10、account detail 40、monthly fragment
480だった。全10 manifestと参照artifactがstrict validatorを通過した。

この集計は当時取得可能だったobjectのsnapshotであり、将来のrun数を固定するものではない。
rollout時は同じauditを再実行し、strict failure 0を確認する。source object件数と集約checksumは
backfill前後で比較するが、object key、個別hash、本文、金融値を運用出力へ含めない。

## Runtime feasibility and recommendation

| 経路                      | 評価             | 用途                                           |
| ------------------------- | ---------------- | ---------------------------------------------- |
| MoneyForward ME collector | C / cost 3       | passkey bootstrap後のread-only補助snapshot     |
| private R2 Layer A replay | A / cost 1       | manifest確定済みrunのbounded central ingestion |
| 金融機関公式collector     | sourceごとに評価 | 取得可能なら正本として優先                     |

collectorの非公開HTML routeとfragment構造は将来変更され得る。validatorは推測で緩和せず、新shapeを
本文非公開のfixtureとaggregate監査で確認してからcontract versionを上げる。中央へ既存runを
上書きせず、新しい固定contract namespaceでreplayする。

## 実装・関連記録

- `poc/moneyforward-worker/README.md`: authentication、read-only collection、source limitations
- `services/collector-r2-importer/README.md`: strict validator、chunking、cursor、rollout order
- `docs/sources/smbc-bank.md`: MoneyForward経由で弱化・欠落するSMBC/Vpass固有情報
- `services/raw-evidence/migrations/0014_moneyforward_collector_r2.sql`: central route/policy

## 未確認事項

- 長期運用時のMoneyForward HTML revisionと非公開route変更頻度
- 無料accountにおけるsource側の実更新頻度と更新遅延
- 12か月より古い画面外データの安全な公式export経路
- 連携sourceごとのpending/posted semanticsと公式取引IDへの照合可能性

これらを推測で補完せず、MoneyForward snapshotのprovenanceと取得時刻を保持し、金融機関公式source
と同等の完全性は宣言しない。
