# Money Forward ME Worker collector PoC

Money Forward IDのパスキーを使い、ブラウザなしのCloudflare WorkerからMoney Forward MEを読み取るPoCです。連携先一覧、口座詳細、画面で取得できる直近12か月の明細fragmentを、加工前のHTMLとして非公開R2へ保存します。

## 収集対象

- `/accounts`: 連携先一覧、合計、登録日、最終更新、状態、詳細画面のopaque key
- 一覧から列挙した全 `/accounts/show/<opaque-id>`
- 各詳細画面の `account_id_hash`、`service_id`、CSRF tokenを使った `/cf/fetch`
- 当月を含む直近12か月。送信形式は `from=YYYY/M/1&account_id_hash=...&service_id=...`
- 実行ごとのmanifest（件数、SHA-256、byte数、R2 key、失敗段階）

レスポンスHTMLには残高や明細が含まれるため、本文をWorkerログや手動トリガー応答へ返しません。R2 bucketも公開しません。

## 認証

Workerへ置くのは、正しいMoney Forward IDに保存済みのパスキー1件だけです。Bitwardenのマスターパスワード、`BW_SESSION`、Money ForwardのCookieは置きません。

同じrpIdのパスキーが複数ある場合、アイテム名や配列の先頭だけでは選びません。`auth:select` はBitwarden内の `id.moneyforward.com` 候補を値を表示せず順番に検証し、実際にMEの口座詳細まで取得できた1件だけをローカルmetadataへ記録します。これはパスワード変更時ではなく、パスキーの追加・削除・保存先変更時に再実行します。

```bash
export BW_SESSION="$(bw unlock --raw)"
bun run auth:select
./scripts/sync-local-secrets.sh
unset BW_SESSION
```

`moneyforward-bitwarden-match.json` はitem idとcredential indexだけを持ち、認証秘密は持ちません。`sync-local-secrets.sh` はその指定に従ってBitwardenからパスキーを抽出し、`MONEYFORWARD_CREDENTIAL_JSON`へ直接pipeします。中間の秘密JSONは作りません。

ローカル疎通も同じBitwardenパスキーを標準入力で渡します。

```bash
./scripts/credential-from-bitwarden.sh | bun scripts/live-smoke.ts
```

## Cloudflare

```bash
bun install
bun run test
bun run typecheck
bunx wrangler r2 bucket create kogane-moneyforward-collector-poc
./scripts/sync-local-secrets.sh
bun run cf:deploy
./scripts/trigger.sh https://kogane-moneyforward-collector-poc.takuanimal.workers.dev
```

Cronは毎日 `21:15 UTC`（日本時間06:15）です。GitHub Actionsはスケジューラに使いません。Money Forward側の銀行・カード更新を要求する処理はなく、最後にMoney Forwardへ同期済みの内容だけを保存します。

## 2026-08-31の実データ検証

- Bitwarden内のMoney Forwardパスキー候補: 2件
- 署名自体が受理された候補: 2件
- 実際のME口座へ認可できた候補: 1件
- ローカル収集: 4詳細、月別48 fragment、合計53成果物、失敗0
- Worker収集: 4詳細、月別48 fragment、合計53成果物、失敗0
- R2: manifestの53件すべてにbyte数とSHA-256があり、サンプル本文を再取得してSHA-256一致を確認
- `/health`: 200、tokenなし `/trigger`: 401、tokenあり `/trigger`: success

切り分け中に正しいMFIDへKogane専用パスキーを一時登録したが、Bitwarden内の正しい既存パスキーを特定した後に登録解除した。登録数が2件から1件へ戻り、credential IDが消えたことを確認済み。専用秘密鍵のWindows/WSLコピーも削除済みで、Worker secretはBitwarden由来のパスキーへ差し替えてある。

## Money Forwardから取得できない、または意味が弱くなるデータ

三井住友銀行について、Money Forwardの表示からは次を完全には復元できません。

- 取引後残高、銀行側の取引ID・照会番号、価値日
- 振込相手を構造化した名義・銀行・支店・口座情報
- 銀行公式CSVや公式APIのraw response
- 外貨取引の原通貨額、適用レート、取引後外貨残高
- 定期預金のロット別明細・満期条件
- 銀行公式明細との完全一致・完全性の保証

Vpassについて、Money Forwardの汎用明細だけでは次を完全には取得できません。

- 利用・売上確定・請求確定などの状態
- 1回・分割・リボ、分割回数
- 請求月、支払日、明細書単位のグルーピング
- キャンセル・返金と元取引のリンク
- 海外利用の原通貨額・換算レート
- 承認番号・売上ID、加盟店国・業種
- ポイント付与・利用履歴

Oliveデビットは、銀行連携だけでは加盟店単位の利用履歴を取得できません。Vpass連携の汎用「内容・金額」に現れる場合はあるものの、全件性、確定状態、公式明細固有項目は保証できません。

共通して、Money Forwardがまだ更新していない最新・保留中データ、公式側の過去全期間、取引単位のsource fetch時刻は取得できません。無料プランでは画面上、連携4件、過去1年、更新頻度・一括更新の制限もあります。

## 依存箇所と制約

- 未公開HTMLと `/cf/fetch` に依存するため、画面構造変更時は追従が必要です。
- 保存が成功しても、後段parserはHTML revisionごとに検証します。
- パスキー認証後も、MEのOAuth account selectorでactive accountを選択する必要があります。
- Money ForwardのセッションCookieやChrome profileはWorkerへコピーしません。

## 検証資源と削除対象

PoCを廃止するときは次をまとめて削除します。

- Worker: `kogane-moneyforward-collector-poc`
- R2 bucket: `kogane-moneyforward-collector-poc`
- Worker secrets: `MONEYFORWARD_CREDENTIAL_JSON`、`ADMIN_TRIGGER_TOKEN`
- Cron: `15 21 * * *`
- ローカル管理token: `/home/risu/.local/state/kogane/moneyforward-worker-admin-token`
- ローカル照合metadata: `/home/risu/.local/state/kogane/moneyforward-bitwarden-match.json`

R2には実データが入るため、bucket削除前に必要なsnapshotの保持先を確認します。

## Safe operational diagnostics

Each run logs `collector-stage-started` and `collector-stage-failed` with the same
`runId`. Stages distinguish credential parsing, login entry, passkey options,
local signing, assertion, redirects, account selection, account pages, monthly
fragments, artifact storage, and manifest storage. Failure records retain only
allowlisted error categories, HTTP status and fixed protocol reasons. Partial R2
failures are logged individually; manifest-write failures remain traceable even
when no manifest can be saved. Logging is best effort and cannot stop collection.

Exception messages/stacks, provider response bodies, redirect URLs, cookie names
or values, CSRF/challenge values, account identifiers and passkey material are
excluded from diagnostics. Raw evidence storage and collection status semantics
are unchanged. This branch is based on the existing `poc/moneyforward-worker`
branch, preserving its unmerged collector implementation.
