# J-Coin Pay source assessment

調査日: 2026-08-26

## 1. Scope / non-goals

J-Coin Pay consumer walletの残高、支払、送金、チャージ、銀行口座への戻し、銀行接続、取引履歴の
read-only収集可能性を調査する。支払、送金、チャージ、口座への戻し、口座追加、本人確認申込、
設定変更は行わない。秘密、電話番号、氏名、口座情報、端末ID、token、実残高・実取引を保存せず、
security controlを回避しない。

J-Coin Payはみずほ銀行が提供するwalletだが、**みずほ銀行口座そのものではない**。J-Coin残高と
J-Coin取引履歴を本source、普通預金残高・銀行通帳・振込・口座固有明細を各銀行sourceとする。
参加銀行からのチャージ/口座戻しは両側に現れ得るため重複計上せず、J-Coin側のwallet eventと
銀行側の入出金eventをreconciliationする。みずほ以外の接続銀行も同じ境界で扱う。

## 2. 調査方法と公式source

- 公式J-Coin Pay、みずほ銀行、参加銀行FAQ、利用規約、Google Play listingを優先。
- WSLから認証不要HEAD/GETで公開hostのstatus/headerだけを観測。loginやapp操作はしていない。
- GitHub code/repositoryをpackage IDとservice名で検索し、consumer clientの有無を確認。
- APK取得、decompile、認証済みdynamic captureは未実施し、具体的再実験を定義した。

主要URL:

- [J-Coin Pay公式](https://j-coin.jp/)
- [公式の使い方](https://j-coin.jp/user/guide/)
- [安全への取り組み](https://j-coin.jp/security/)
- [ユーザー利用規約](https://j-coin.jp/user/terms/)
- [みずほ銀行 J-Coin Pay](https://www.mizuhobank.co.jp/jcoinpay/index.html)
- [Google Play](https://play.google.com/store/apps/details?id=jp.co.bluelab.jcoin.user&hl=ja)
- [取引履歴は10年前まで](https://faq.chugin.co.jp/hc/ja/articles/32829869067929)
- [明細発行・print不可](https://faq.chugin.co.jp/hc/ja/articles/32829848278041)
- [未受取送金は72時間](https://faq.chugin.co.jp/hc/ja/articles/32829863762969)
- [本人確認が必要な場合](https://faq.chugin.co.jp/hc/ja/articles/32829863383705)

## 3. 公式app/webとread範囲

| surface               | readできる範囲                          | 粒度/state                                                       | 期間・件数・export                                          | tradeoff                                          |
| --------------------- | --------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------- |
| J-Coin Pay app home   | J-Coin残高、接続口座、主要機能入口      | wallet単位。銀行残高の正本ではない                               | 残高snapshot                                                | 公式正本だがAndroid/iOS端末に拘束                 |
| app取引履歴           | 支払、送金/受取、チャージ、口座戻し等   | event単位。相手/加盟店、日時、額、状態のexact schemaはlive未確認 | 参加銀行FAQは10年前まで確認可。件数/pagination/filter未確認 | 長期retentionは強いがCSV/PDF/printなし            |
| 支払detail            | 店舗支払と取消/返金状態                 | 即時残高減算が基本とみられるがpending/settled fieldは未確認      | app内表示のみ                                               | merchant/card receiptとは別                       |
| 送金detail            | 送金、受取待ち、受取、期限切れ返戻      | 受取待ちはpending。72時間未受取なら送金者残高へ戻る              | app内表示のみ                                               | pending→settled/returnedを追える可能性            |
| charge/口座戻しdetail | 接続銀行↔J-Coin wallet移動              | J-Coin側event。銀行側posting時刻とは別                           | app内表示のみ                                               | 両sourceで重複排除が必要                          |
| 公式公開web           | 説明、guide、規約、campaign、加盟店情報 | account ledgerではない                                           | 公開資料                                                    | `web.jcoin-pay.jp`のconsumer account roleは未確認 |
| 接続銀行app/web       | 預金残高と通帳明細                      | 銀行側settled/pending規則                                        | 銀行sourceごと                                              | J-Coinの相手/加盟店detailを代替しない             |

公式参加銀行FAQは履歴を10年前まで表示できる一方、取引明細の発行・print機能はないと明記する。
公開情報からCSV、PDF、OFX、API exportは確認できない。したがって「10年」はUI retentionであり、
1回で全件を取得できることやpagination不要を意味しない。

pending/settledは一種類ではない。未受取送金は72時間の明確なpending stateを持ち、期限後は返戻。
店舗支払の取消/返金、銀行チャージ/戻しの処理中・失敗・完了、受取済送金のstatus名とtimestampは
live schemaで確認する。表示順や残高差だけからsettledを推測しない。

## 4. 銀行接続と本人確認境界

参加銀行口座の登録、初回チャージ、追加口座、氏名変更、利用上限引上げでは本人確認を要求し得る。
銀行選択後は各銀行固有の認証、届出電話/SMS、口座情報等へ遷移する可能性があり、J-Coin sessionと
銀行credential/sessionを分離する。Koganeは既登録口座の一般表示だけを読み、追加・再認証・初回
チャージを開始しない。

J-Coin履歴のチャージ/戻しと銀行通帳を照合する場合、wallet側event IDや銀行referenceの存在を
schemaとして確認するが値は保存しない。安定IDがなければ日時/符号/額による候補matchとし、確定join
にしない。銀行口座の全残高・全通帳をJ-Coin appから取得できるとは仮定しない。

## 5. 認証、MFA、passkey、Bitwarden

公開guide/security情報から、電話番号/SMS認証、本人確認、app passcode、生体認証、端末紛失時の
対策が主要境界とみられる。exactな登録/login flow、SMS再要求条件、passcode桁、device binding、
token refreshは現行appで未確認。公式sourceにpasskey対応を確認できなかったため「非対応」と断定せず
未確認とする。

Bitwardenはpassword/passkey管理には使えるが、J-Coin appのSMS、端末生体、device-bound key、銀行
認証を代替しない。保存済みJ-Coin credentialの存在も確認していない。vault、OTP seed、銀行login、
app passcode、tokenをcloud/runtimeへ渡さない。初回/失効時は本人の所有端末で認証し、read-only
session replayが成立する場合だけsource-scoped暗号化envelopeを検討する。

## 6. WAF / JS / APK / reverse engineering

2026-08-26のWSL観測では `j-coin.jp` とみずほ銀行J-Coin pageはHTTP 403、`Server: AkamaiGHost`。
`web.jcoin-pay.jp`はHTTP/2 403、`server: awselb/2.0`だった。これは現在のIP/HTTP clientに対する公開
edge結果であり、app APIのvendor、block理由、同一policyを証明しない。通常browser/日本egressとの差を
先に比較し、403、challenge、rate limitを迂回しない。

公式Android packageは `jp.co.bluelab.jcoin.user`。所有端末または正規Google Play flowからbase/splitを
取得し、全APK署名とversion/hashを記録する。`apkanalyzer`/`aapt2`でmanifest・permission・component、
JADX/apktoolでstrings/resources/DEX、`readelf`/stringsでnative libsを調査する。R8/ProGuard難読化には
resource名、Retrofit/OkHttp annotation、JSON/protobuf key、certificate/network config、call graphを
対応付ける。mappingを捏造せず、動的観測で確認できないsymbolは推測とする。

調査対象はread host/path/method、request/response key、pagination/cursor、履歴type/status、access/
refresh token lifecycle、device/integrity metadata、pinning/attestation、WebView/native境界。write host/pathは
分類だけ行いpayloadを生成しない。本人が既存履歴を開く1回のruntime観測ではhost/path/status/header名と
redacted keyだけ残す。TLS pinning/attestationで見えなければ解除・hookせず障壁として記録する。

## 7. 第三者client / transport

GitHubで`J-Coin Pay`、package ID、service名を検索したが、consumer残高/履歴を取得する公開client、
SDK wrapper、login/session実装は確認できなかった。package IDの検索結果はGrapheneOS互換性記事と古い
app一覧が中心で、transport/auth evidenceにならない。これは検索時点のnegative evidenceであり、非存在の
証明ではない。

加盟店向けJ-Coin決済接続、決済代行CSV/API、銀行側サービスはconsumer wallet sessionとは別契約・別
authであり、本人wallet履歴APIとして転用しない。公開third-party clientがないため、具体的transportは
公式APK静的解析と本人操作のredacted observationで初めて確定する。

## 8. read/write隔離

- 初期collectorは履歴一覧/detailと残高GET相当だけのhost+path allowlist。HTTP methodだけでread判定しない。
- 支払QR生成/scan、送金、受取操作、charge、口座戻し、口座登録、本人確認、設定、退会は常時deny。
- app deep link/intentを自動起動せず、write画面へ遷移したらbackも自動化せず停止・破棄。
- read endpointにもCSRF/nonceやwrite scope tokenが含まれ得るため、汎用HTTP clientや任意pathを提供しない。
- raw captureは端末の暗号化一時領域のみ。PII/実値をredactし、schema、count、timestamp範囲だけ残す。
- 401/403/409/429、SMS/本人確認、端末再登録、未知certificate/host、schema driftで即停止。

## 9. Runtime適性

| runtime               | 適性                 | 判断                                                                                    |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------- |
| 所有Android端末       | 調査・公式表示に最適 | SMS/生体/device state、正規APK、read-only観測に必要。定常UI automationは脆い            |
| Local Windows/WSL     | parserに適           | redacted artifact処理、APK静的解析。app/session bootstrapは不可                         |
| Cloudflare Workers    | 低〜条件付き         | proven token replayならfetch可能。端末認証/pinning、binary protocol、secret運用に不向き |
| Cloudflare Containers | 条件付き             | full Linux parser/proxyを隔離可能。Android/device trustは提供しない                     |
| OCI container         | 条件付き             | digest固定、secret store、egress allowlistでreplay実験しやすい                          |
| Kubernetes            | 過剰                 | CronJob/Secret/NetworkPolicyは可能だが単一walletに運用cost過大                          |

## 10. PR #5共通 A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| 経路                                      |     Level | Cost | 判定                                                      |
| ----------------------------------------- | --------: | ---: | --------------------------------------------------------- |
| app履歴を人手で確認しschema/countだけ記録 |         E |    1 | 安全だがexport不可、実データ収集には不十分                |
| app画面のlocal UI capture                 |         D |    4 | 10年履歴は有用だがpagination/画面変更/PII redactionが重い |
| app bootstrap後のread-only API replay     |     C候補 |  4-5 | transport/token/device binding未確認。確認後のみC         |
| stable read API + renewable session       |     B候補 |    4 | 現時点で証拠なし。APK/runtime実験が必要                   |
| documented consumer API/export            | A該当なし |    5 | CSV/PDF/print/APIなし                                     |

総合評価は **D/cost 4**、安全な既定は **E/cost 1**。static/dynamic調査でread APIと更新可能session、
read/write scopeが確認できればCへ上げる。

## 11. read-only live検証とstop条件

1. 所有端末でpackage/version/signer、app lock方式、登録済み銀行の件数だけ確認し値・銀行番号を残さない。
2. homeで表示field名、残高更新時刻、接続口座に銀行残高が出るか否かだけを確認。
3. 履歴filter/type/status、1回表示件数、scroll/cursor、最古年、detail field、10年到達方法を実値なしで記録。
4. 未受取/期限切れ/返金/失敗が既存履歴にあればstatus名だけ確認。新しい取引を作らない。
5. export/share/print controlがないことを現行appで再確認。OS screenshot/shareも実値漏えいのため実行しない。
6. 正規split APKを署名検証して静的解析。read/write endpoint候補を別allow/deny表にする。
7. 本人が既存履歴を開く1回だけredacted network metadataを観測。最初の未知pathまたはwrite候補で停止。
8. replay可能なreadが見つかった場合、同一端末→同一local host→OCIの順に各1回。device/integrity bindingなら
   cloud化を中止しlocal manual/UI routeへ戻す。

stop条件: 支払/送金/charge/口座戻し/口座追加/設定control、SMS/本人確認/銀行認証、PIN/生体要求、
security warning、certificate pinning、attestation、403/429、account lock、未知host、PII redaction失敗、
method/schema不一致。security controlを無効化せず、観測不能を正確な結果として残す。

## 12. 確認事実・推測・未確認

**確認事実:** app package、公式app中心の残高/支払/送金/charge/口座戻し、履歴10年、明細発行/printなし、
未受取送金72時間後返戻、本人確認を求め得る操作、公開hostのAkamai/AWS LB 403、公開consumer client不在。

**推測:** app内部には残高/履歴用read transportとpaginationがあるはずだが、host/path/schema/token方式は
未確認。銀行charge/戻しはJ-Coinと銀行の両ledgerに対応eventがある可能性が高い。

**未確認:** 履歴の全type/status/field、1ページ件数/cursor、settlement timestamp、refund、残高更新頻度、
export/share、passkey、Bitwarden適合、SMS/device binding、token renewal、API pinning/attestation、WebView境界、
`web.jcoin-pay.jp`のconsumer account role、各参加銀行ごとの認証差。
