# V Point Worker PoC

Vポイント本体の残高・期限bucket・SMBC由来内訳・最大3年の履歴、およびVマネー残高・
最大3年の履歴を、認証済みVポイントMy Page sessionでfirst-party JSON APIから取得し、
raw responseとmanifestをprivate R2へ保存するPoCである。VポイントPayとVpass明細は別の
サービス・認証・台帳であるため含めない。

保存済みrunはService Bindingで内部`kogane-collector-r2-importer`へ通知し、strict validation後に中央raw-evidenceへsealする。source R2は中央転送用のimmutable outboxであり、成功・失敗・backfill後のいずれも変更または削除しない。中央が失敗した場合、collection自体を成功扱いせず、同じmanifestを冪等に再送できる。

## Runtime profile

- **Browser: なし。** Cloudflare Browser Run、Container Chrome/Chromium、既存browser cookieを使用しない。
- Worker `fetch`でfirst-party form chainを進め、Email Workerで認証コードを受け、SQLite Durable Objectに短命sessionを保持してJSON APIを収集する。
- Kogane Capture Chromeはendpoint/schemaの本人確認に使っただけで、production collectorはbrowserを起動しない。

## Liveで確認したデータソース

2026-08-31、Kogane Capture Chromeのユーザー口座で次を確認した。値、加盟店、Cookie、
会員番号、個人情報はこのrepositoryへ保存していない。

- `POST https://mypage.tsite.jp/api/balance_info`
  - `results.common[]`: `point`, `expiration`, `point_type`
  - `results.store[]`: store限定の期限bucket
  - `results.tmoney`: Vマネー残高・有効期限。live口座では空objectだった
- `POST https://mypage.tsite.jp/api/tpoint_history`
  - multipart `page`, `get_graph`, `sort`と全履歴filter
  - live口座では`total=149`。page 1-4は各30件、page 5は29件、終端のpage 6は0件で、
    すべてHTTP 200 / application status `0000`を確認した。PoCはtotalへ達したpage 5で停止する。
- `POST https://mypage.tsite.jp/api/smfg_point`
  - `results.get_point.point_smbc`, `point_smcc`
- `POST https://mypage.tsite.jp/api/tmoney_history`
  - multipart `page`, `sort`と、利用・チャージ・取消・失効・移行・返金の全履歴filter
  - Vポイント履歴と同じMy Page sessionを使用する
  - live口座ではHTTP 200 / application status `0000`、`total=0`, `history=[]`だった

[Vポイント公式FAQ](https://ssl.help.tsite.jp/faq/show/25463?site_domain=qa-tsite)は、
Vマネー履歴を同じMy Pageで確認でき、履歴上限は過去3年と説明している。また、
[公式チャージ案内](https://t-point.tsite.jp/finance/tmoney/charge/ptcharge/)もVマネーと
三井住友カードのVポイントPayを明確に区別する。Vマネーは別の電子マネー台帳だが、この
collectorの認証境界とデータソースには含まれるため、同じrunで収集する。

## 認証とsession自動更新

My Page APIは未認証でもHTTP 200を返すが、application statusは`0010`となる。認証済みは
`0000`。2026-08-31、Kogane Capture Chromeの通信とブラウザなしのlive requestを照合し、
V会員番号とメール認証からsessionを生成できることを確認した。passwordは使わない。

loginのfirst-party form chainは次のとおり。各画面からhidden fieldとStruts tokenを引き継ぎ、
responseのWindows-31Jをdecodeする。

```text
GET  /tm/pc/login/STKIp0018001.do
POST /tm/pc/login/STKIp0002010.do
POST /tm/pc/login/STKIp0002011.do  (V会員番号)
POST /tm/pc/login/STKIp0002040.do
POST /tm/pc/login/STKIp0002042.do  (メール送信)
POST /tm/pc/login/STKIp0002045.do  (メール認証コード)
POST https://mypage.tsite.jp/api/user_info
```

メール認証コードは連続したlive mailで4桁、5桁、6桁を確認したため、固定長と仮定しない。
メール記載の有効時間は1分である。最後の`POST /api/user_info`は省略できず、ここでMy Page用
`SESSIONID`が発行される。これを呼ばずに`/api/balance_info`へ進むと`0010`となる。

本番PoCでは、SQLite Durable Objectの単一instanceが次を保持する。

- 有効なMy Page session Cookie
- メール待機中だけ、最大2分のserializable challenge state

sessionがない、または`0010`になったrunは新しい認証メールを要求する。対象アドレスだけの
Cloudflare Email Routing ruleが同じWorkerの`email()` handlerへ配送し、handlerは元メールを
従来のGmail宛へ転送したうえでコードを抽出する。Durable Objectがloginを完了すると、email
event内でcollectionを再実行する。通常のcatch-all転送ruleは変更していない。

Cookie、会員番号、認証コード、メール本文、challenge stateをsource、log、R2、manifestへ
保存しない。Cookieとchallenge stateはDurable Object storage内だけに置く。

Web画面のV会員番号はlogin後もmask表示だったが、collection API自体は会員番号をrequest
fieldとして要求しない。会員番号はsession再生成専用のWorker secretである。

ログイン画面はCloudflare越しでも通常表示でき、APIも匿名curlへ`0010`を返すため、今回の
観測ではbot challengeが主障害ではない。標準Workers `fetch()`でlogin、メール認証、JSON
collectionまで完了し、browser、TLS impersonation、Containerは不要だった。

## 保存内容

各runは以下へ保存する。

```text
raw/v-point/YYYY/MM/DD/<run-id>/
  balance-info.json
  smfg-point.json
  history-page-0001.json
  ...
  vmoney-history-page-0001.json
  ...
  collection-summary.json
  manifest.json
```

Vポイント履歴とVマネー履歴は毎run、`filter_date`を空にして公開上限の最大3年を全page
走査する。現在はVポイント149件を5 request、Vマネー0件を1 requestで取得できるため、
Queueは不要である。

## 開発とデプロイ

```bash
bun install
bun test
bun run typecheck
bun run cf:check
```

必要なCloudflare resources/secrets:

- R2 bucket: `kogane-vpoint-collector-poc`
- SQLite Durable Object: `VPointSession`
- Email Routing rule: `kogane-vpoint-auth`（`vpoint@takuk.me`だけをWorkerへ配送）
- Email Routing rule: `kogane-vpoint-pay`（`vpointpay@takuk.me`だけを同じWorkerへ配送）
- secret: `VPOINT_MEMBER_NUMBER`
- secret: `VPOINT_EMAIL_RECIPIENT`
- secret: `VPOINT_EMAIL_FORWARD_TO`
- secret: `ADMIN_TRIGGER_TOKEN`
- Service Binding: `RAW_EVIDENCE_IMPORTER` → `kogane-collector-r2-importer`
- Cron: `15 21 * * *`（毎日06:15 JST）

manual triggerは`POST /trigger`に`Authorization: Bearer <ADMIN_TRIGGER_TOKEN>`を付ける。
認証メール待ちはHTTP 202と`reauthenticationPending: true`、通常収集はHTTP 200、実エラーは
HTTP 502を返す。`GET /health`は秘密値や口座データを返さない。

historical outboxは次で1 objectずつbounded scanする。管理tokenはmode 0600のローカルfileから読み、標準出力にはpage・件数・固定failure codeだけを出す。本文、値、source object key、hash、tokenは出力しない。

```bash
poc/vpoint-worker/scripts/backfill-raw-evidence.sh
```

11件を超えるdata artifactを持つ将来runもskipしない。Importerは完全inventoryを固定し、最大8 artifactずつ転送する。HMAC署名済みcursorにscan位置・処理中manifest・offsetを保持し、sealが完了するまで次のR2 objectへ進まない。実R2 contractの再監査は`services/collector-r2-importer`で`bun run audit:vpoint-r2`を実行する。この監査はR2をread-onlyで走査し、件数だけを出力する。

2026-09-05のread-only contract auditではsource R2のmanifest 24件（v1 5件、v2 19件、成功13件、失敗11件）とreconciliation参照10件がすべてstrict validatorへ適合した。旧reconciliation 3件は旧exact match policy、残り7件は現行exact policyであり、両方を明示的な互換契約として扱う。

2026-08-31のproduction verificationでは、初回triggerが認証メールを要求し、Email Workerが
受信・Gmail転送・session生成・再収集を完了した。成功runは履歴149件を5 pageで走査し、
8 artifactとfailure 0のmanifestをR2へ保存した。続くmanual triggerも追加メールなしで
Durable Objectのsessionを再利用し、同じ149件・5 page・8 artifactで成功した。

同日のVマネー追加後のproduction verificationでは、同じメール認証とMy Page sessionで
`/api/tmoney_history`もHTTP 200 / application status `0000`となった。live口座のVマネー
履歴は0件だったが、空のpage 1 raw responseを欠落させず保存した。Vポイント149件・5 page、
Vマネー0件・1 page、9 artifact、failure 0のv2 manifestをR2から再読して確認した。

検証環境を削除するときは、次を一組として扱う。

1. Email Routing rules `kogane-vpoint-auth`、`kogane-vpoint-pay`
2. Worker `kogane-vpoint-collector-poc`（Cron、secrets、`VPointSession` namespaceを含む）
3. R2 bucket `kogane-vpoint-collector-poc`

先にEmail Routing ruleを削除または無効化し、その後WorkerとR2を削除する。catch-all ruleは
削除対象ではない。

## VポイントPayとapp archive

VポイントPayはプリペイドJPY残高・authorization・settlement・refund・chargeの別台帳で、
正本は`com.smbc_card.vpoint`アプリである。このWeb PoCではAPKを取得・decompileしていない。
将来app解析を行う場合、binary/decompiled/decrypted artifactは既存private Android archive
repositoryへ保存し、Koganeにはprovenance、hash、再現手順、sanitize済みのschemaだけを置く。

## VポイントPay通知メールの取り込みと照合

同じWorkerのVポイントPay専用Email Routing ruleを通知archiveにも使う。Gmailから対象通知を
`vpoint@takuk.me`へ転送すると、Gmailは原本を`message/rfc822`のinline attachmentとして
送る。handlerは`forceRfc822Attachments`で内側の原本を分離し、内側のFromが
`info@prepaid.smbc-card.com`で、subjectが次のいずれかである場合だけ取り込む。

- ご利用のお知らせ
- チャージ受付のお知らせ
- プリペイド残高加算のお知らせ
- ご利用不可のお知らせ／カードがご利用頂けませんでした

原本は`kogane-vpoint-pay-collector-poc` bucketの
`raw/v-point-pay-email/YYYY/MM/DD/<sha256>.eml`、正規化結果は同じprefixの`.json`へ保存する。
原本hashをkeyにするため、同じbackfillを再実行しても原本は増えない。正規化JSONはparserの
修正を反映できるよう再生成する。Gmailから`message/rfc822`添付で転送された通知は元から
Gmailに存在するためWorkerから戻さない。公式送信元から`vpointpay@takuk.me`へ直接届いた通知は、
R2保存後に従来のGmail宛へ転送する。OTPや転送先確認メールなど対象外メールも従来どおり
転送する。この区別により、VポイントPayの登録メールをaliasへ変更してもGmailで通知を読め、
Gmailからのbackfillは転送loopを起こさない。

既存メールのbackfill手順:

1. Gmailで次を検索する。

   ```text
   from:info@prepaid.smbc-card.com (subject:"ご利用のお知らせ" OR subject:"チャージ受付のお知らせ" OR subject:"プリペイド残高加算のお知らせ" OR subject:"ご利用不可のお知らせ" OR subject:"カードがご利用頂けませんでした") -in:spam -in:trash
   ```

2. 検索結果を原本添付のまま`vpoint@takuk.me`へ転送する。Gmail APIを使う場合は
   `message/rfc822`を保持し、1 request最大10通で分割する。
3. Vポイントcollectorを1回実行する。現在runのVポイント履歴と、保存済みの全通知を照合し、
   `derived/v-point-pay-email-reconciliation/YYYY/MM/DD/<run-id>.json`へreportを保存する。
4. reportの件数をGmail検索件数と突き合わせる。再実行は安全だが、欠落分だけ再転送してよい。

`vpoint@takuk.me`はVポイントWeb認証メールと過去メールbackfill専用、
`vpointpay@takuk.me`はVポイントPayアプリの登録先および今後の公式通知専用とする。両routeは
同じWorkerへ届くが、後者はコード抽出には使われない。通常のcatch-all転送ruleは残す。

照合は次のexact ruleだけを使う。

- メールに`内、利用Vポイント数`が明記された場合、その値を使う。
- チャージの`取引内容`が`ポイント`と明記された場合、そのチャージ額を使う。
- JST暦日とVポイント数がVポイント履歴の利用行に完全一致した1件だけを`matched`とする。
- 0件は`unmatched`、複数は`ambiguous`、明示額がない通知は`not-comparable`とする。

加盟店名の近似、前後日へのずらし、金額の補正、候補の自動選択は行わない。reportはsource keyと
row fingerprintを参照するだけで、メール原本、正規化event、Vポイント履歴、VポイントPay app
履歴のいずれも変更・削除・統合しない。appのlive transaction snapshotがまだない場合は
`unavailable-no-live-snapshot`を明示する。

2026-08-31のlive backfillではGmail検索85通、R2 event 85件で一致した。Vポイント履歴149件との
exact照合は、比較可能34件中11件matched、23件unmatched、0件ambiguous、51件not-comparable
だった。不一致23件は推測で修正していない。VポイントPay app履歴はlive credential消失後のため
未取得で、email対appの照合は実行していない。

## 段階別の運用ログ

`collector-stage-started` / `collector-stage-failed`はrunIdで同一実行を関連付け、
残高・SMFGポイント・Vポイント履歴・Vマネー履歴・R2保存・メール照合・manifest保存を
区別する。失敗には固定の`failureCode`、許可した`errorType`、確認できたHTTP status、
4桁のapplication code、ページ不整合の`reasonCode`だけを残す。部分失敗も個別に記録し、
manifest自体が保存できない場合もrunIdをログに残す。

再認証は`vpoint-auth-step`でメール要求・コード送信・session確認までを区別する。
通知メールには独立したrunIdがあり、parse・保存・転送・コード処理を追跡できる。
認証後の収集は`vpoint-post-auth-collection`のparentRunIdでメール処理へ結び付く。

例外message/stack、レスポンス本文、URL、Cookie、token、認証コード、メール宛先・本文は
ログへ流さない。公式raw dataのR2保存、失敗/部分成功、メール再転送防止の挙動は維持する。
VポイントPayのapp API Workerは別途停止されており、このWorkerの通知メール収集は継続する。
