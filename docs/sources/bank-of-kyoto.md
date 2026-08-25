# 京都銀行（銀行口座）source research

調査日: 2026-08-26（公開情報と、未認証の公式サイトに対する read-only HTTP 観測）

## 結論

- 現時点の初期収集路は、**京銀アプリの「京銀スマート通帳」から利用者が手動で出力する CSV/PDF** が最も安全で安価である。最大 1,000 明細を出力できる。Web の京銀ダイレクトバンキングで公開資料上確認できる普通・貯蓄預金の照会期間は、最長で照会日の前々月 1 日から当日までである。
- 長期的な本命は京都銀行が NTT DATA に委託する公式 Open API である。京都銀行は個人向けに、普通・貯蓄・定期・積立式定期・外貨普通・外貨定期・投資信託まで参照 API の対象を明示している。ただし直接接続には電子決済等代行業者としての契約・審査が前提であり、個人用 Kogane が無契約で利用できる公開 API ではない。
- 認証済み HTML の非公式再生と Android UI 自動化は、認証状態、OTP の端末移行、動的 hidden state、追加認証、サイト変更の影響が大きい。公式 API や手動 export より先に採用しない。
- `www.kyotobank.co.jp` は Akamai 配信である。一方、個人 Web バンキングの `www.parasol.anser.ne.jp` の未認証ログイン画面では CAPTCHA や明示的な bot challenge は観測しなかった。これはログイン後にも anti-bot がないことを意味しない。
- **京銀 JCB デビット、京都カードネオ等のカード利用明細は本資料の対象外で、別の MyJCB family PR の対象である。** 銀行口座に表示されるデビット利用・カード代金等の「口座引落明細」は銀行取引の観測として保持し得るが、加盟店別カード明細と同一視しない。
- 共通評価では、現在利用できる手動 CSV 経路は **E / cost 1**、認証済み browser bootstrap 後の read replay は未検証の **C / cost 4**、直接契約 API は **A / cost 5** である。

## 調査上の安全境界

この調査では公開ページ、公式 FAQ、公式ストア掲載情報、NTT DATA の公開 API 仕様、および未認証ログイン画面だけを確認した。ログイン、口座照会、export、OTP 発行、連携同意、取引は実行していない。口座番号・口座 ID・残高・取引明細・会員番号・パスワード・OTP・氏名・メール・電話番号等の秘密情報または PII は取得・記録していない。

## 1. 列挙できる口座・商品の範囲

### 公式 Open API の対象（京都銀行が明示）

京都銀行の [電子決済等代行業者との連携及び協働に係る方針](https://www.kyotobank.co.jp/api/policy/) は、個人契約者向け API の対象を次のように列挙している。

| 機能 | 対象 |
| --- | --- |
| 残高照会 | 普通預金、貯蓄預金、定期預金、積立式定期預金、外貨普通預金、投資信託 |
| 入出金明細照会 | 普通預金、貯蓄預金、外貨普通預金 |
| 定期明細照会 | 定期預金、積立式定期預金、外貨定期預金 |

キャッシュカード保有者向けの事前登録不要型 API については、普通預金の残高・入出金明細・同一名義口座間振替のみが示されている。Kogane は取引 API を使用しない。

### 京銀ダイレクトバンキング / 京銀アプリで確認できる範囲

- [京銀ダイレクトバンキングのサービス内容](https://www.kyotobank.co.jp/kojin/directb/service/) は、普通・貯蓄預金の残高/入出金明細、定期・積立式定期、外貨普通・外貨定期、投資信託、個人ローン、カードローンを別機能として案内している。
- 投資信託には保有残高、運用損益、取引履歴、源泉徴収・還付、分配金履歴がある。ただし銀行預金取引とは別 observation family として扱うべきである。
- [京銀アプリの金融サービス](https://www.kyotobank.co.jp/kojin/kyoginapp/banking/) は、口座残高/明細、スマート通帳、定期預金、外貨預金、投資信託、カードローン等を提供する。
- 普通・貯蓄口座間の「振替」、外貨売買、定期預入/解約、投信売買、ローン借入/返済は書込み取引であり、collector の対象外とする。

### カード境界

- 京銀 JCB デビットや京都カードネオの加盟店別利用、取消、売上確定、請求明細は **MyJCB family の別 PR** で扱う。
- 京都銀行口座側の「JCB デビット」「カード代金」等の出金は、銀行が表示した口座引落 observation である。カード側 observation と後段で reconciliation し、カード購入として二重計上しない。
- 口座の摘要だけから加盟店、カード明細 ID、確定日を創作しない。

## 2. 明細粒度、期間、件数、export

### 普通・貯蓄預金（Web）

- 公式サービスページと [FAQ K-000740](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000740) は、普通・貯蓄預金の照会期間を「最長で照会日の前々月 1 日から照会日当日まで」とする。
- 公開資料で Web 画面から確認できた出力手段は印刷である。CSV/PDF download の有無は認証済み画面で未確認であり、「ない」とは断定しない。
- [FAQ K-000685](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000685) によれば、窓口/アプリから有料の取引明細表を申し込む場合、依頼日の前日から過去 10 年以内を指定できる。これは即時 download ではなく発行申込であり、read-only collector が実行してはならない。

### 京銀スマート通帳（アプリ）

- [FAQ K-001734](https://faq.kyotobank.co.jp/faq.asp?faqno=K-001734) と [FAQ K-000938](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000938) は、記帳済み入出金明細を最大 **1,000 明細**、CSV または PDF で出力できると明示している。表紙だけの出力も可能である。
- [FAQ K-000773](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000773) は、機種変更後も「通帳記帳」により新端末へ最大 1,000 明細を再表示できるとしている。
- 1,000 は保存/表示件数上限であり、日付範囲の保証ではない。定期的に CSV を保存し、raw evidence として content hash、取得日時、source ID を付ける。
- CSV の列名、文字コード、日付/金額/残高/摘要の厳密な schema は、個人情報を含まない合成または利用者が明示的に提供した redacted sample が得られるまで未確認とする。

### 外貨・定期・投信

- 外貨普通預金は入出金明細、外貨定期預金は預入明細を照会できる。外貨普通預金を本人口座登録した当初は最大過去 6 か月、登録後に範囲が拡大し最大過去 13 か月となる（[サービス内容](https://www.kyotobank.co.jp/kojin/directb/service/#content_service04)）。
- 定期/積立式定期は「保有明細」であり、普通預金の入出金明細とは schema を分ける。
- 投信は保有・損益・取引履歴等を別 endpoint/observation とし、評価額を預金残高に混ぜない。

### NTT DATA AnserParaSOL API の公開上限（京都銀行固有設定とは限らない）

京都銀行は API システムを NTT DATA に委託すると明記し、個人 Web の公式ログイン先も AnserParaSOL である。NTT DATA の [AnserParaSOL API v1.10 公開仕様](https://portal.opencanvas.ne.jp/wp-content/uploads/2026/02/ParaSOL-APISpec_v1.10.yaml) では、取引明細に以下がある。

- 取引 ID、状態（正常/取消/欠番）、取引日、起算日、取引内容、入出金区分、金額、取引後残高、外貨適用相場/取扱、摘要、需要家番号。
- JSON、単一応答（`has_next=false`）、取得件数 `count` の仕様上上限は 9,999 件。
- `date_from` / `date_to` を指定。online は仕様上最大 1 年だが 1 か月以内を推奨、offline の期間は金融機関ごとに異なる。

これらはプラットフォーム共通仕様であり、京都銀行の商用設定・返却項目・実上限を保証しない。京都銀行固有の公開情報として確定できるのは、前述の Web/アプリ/外貨の範囲である。

## 3. 認証、OTP、端末、passkey、Bitwarden

### 確認できた事実

- [セキュリティ対策](https://www.kyotobank.co.jp/kojin/directb/security/) は、会員番号または店番・口座番号、ログインパスワードを基本とし、環境リスクに応じて合言葉を追加する。本人確認にはワンタイムパスワードと届出電話番号認証も使う。
- [ワンタイムパスワード](https://www.kyotobank.co.jp/kojin/directb/security/onetimepass.html) は京銀アプリまたは専用 OTP アプリに表示され、60 秒ごとに更新される。都度振込、民間 Pay-easy、ことら送金、住所/電話変更、カード/通帳再発行等では OTP が必須である。
- 京銀アプリ OTP の初期設定は、[マイナンバーカードの署名用電子証明書＋NFC 読取、または届出電話番号からの発信](https://www.kyotobank.co.jp/kojin/directb/security/onetime_sp.html) で本人認証する。
- 専用 OTP アプリの生体認証ログインは、端末の生体認証と OTP を組み合わせ、会員番号/口座番号とログインパスワードの入力を省略できる。これはアプリ機能であり、WebAuthn passkey との記載はない。
- [FAQ K-000773](https://faq.kyotobank.co.jp/faq.asp?faqno=K-000773) は、機種変更後の新端末でアプリと OTP の利用登録が必要で、旧端末では利用できなくなるとする。新端末で OTP を開始した後、都度振込等には 120 時間の待機がある。これは実質的な端末結び付けとみなせる。
- 京都銀行はパスワード等をスマートフォン、PC、タブレット、クラウドサーバー、ネットワーク上のサービスに保存しないよう明示している。

### 未確認・推測を分離

- **passkey:** 公式サイトと公式 FAQ の「パスキー」検索では対応を確認できなかった。WebAuthn の登録/認証 ceremony は未観測であり、「非対応」と断定せず「公開情報で未確認」とする。アプリ生体認証は passkey と同義ではない。
- **Bitwarden:** ログイン HTML は通常の text/password field であり autofill 自体は技術的に可能そうだが、実動作は未検証である。さらに京都銀行の明示的な保管禁止方針と衝突するため、Kogane の設計として Bitwarden への会員番号/口座番号/ログインパスワード保存を推奨しない。OTP は銀行アプリの proprietary token であり、Bitwarden TOTP へ seed を移せるという根拠はない。
- **端末 fingerprint:** 普段と異なるスマートフォン/PC/ネットワーク環境を総合分析して合言葉を要求する事実はあるが、fingerprint の具体的属性や永続 cookie の仕様は非公開である。

## 4. WAF / Akamai / anti-bot

2026-08-26 の read-only 観測:

- `www.kyotobank.co.jp` は `edgekey.net` → `akamaiedge.net` の CNAME で Akamai edge に到達した。応答には `AWSALB` / `AWSALBCORS` cookie もあり、origin 側に AWS load balancer がある構成と整合する。
- [公式サイト](https://www.kyotobank.co.jp/) の通常 GET は 200。Akamai Bot Manager の sensor endpoint、challenge cookie、CAPTCHA はこの公開ページでは観測しなかった。DNS が Akamai であることだけから WAF/Bot Manager の有効化を断定しない。
- [京銀ダイレクトバンキング未認証入口](https://www.parasol.anser.ne.jp/ib/index.do?PT=BS&CCT0080=0158) は Apache から 200、`Cache-Control: no-store`。公開ログインフォームは動的 hidden state と `BLI001Dispatch` への POST を用いる。未認証 GET では CAPTCHA/明示的 bot challenge は観測しなかった。
- ログイン後、異常頻度、失敗、異環境では追加認証やロックが生じ得る。公開 GET の成功を「自動化可能」の根拠にしない。

## 5. 公式 APK / アプリ / Web の役割

| 面 | 確認できた役割 | collector 観点 |
| --- | --- | --- |
| Android 公式アプリ | Google Play package [`jp.co.kyoto.bankingappli`](https://play.google.com/store/apps/details?id=jp.co.kyoto.bankingappli&hl=ja&gl=JP)。口座照会、スマート通帳、CSV/PDF、振込等、OTP、口座開設、My Number/NFC、スマホ ATM を提供 | 手動 CSV/PDF の正式出口。OTP・生体認証・端末移行が絡むため UI automation は避ける |
| iOS 公式アプリ | App Store ID [`1211133839`](https://apps.apple.com/jp/app/id1211133839) | Android と同じ利用者向け役割。自動 collector の実行基盤にはしない |
| Web | [京銀ダイレクトバンキング](https://www.kyotobank.co.jp/kojin/directb/) から NTT DATA AnserParaSOL へ遷移し、口座/明細/各種取引を提供 | 公開資料で CSV は確認できず、短期照会と印刷は確認。HTML replay は非公式で fragile |
| 公式 Open API | 契約済み電子決済等代行業者へ口座・残高・明細・定期・投信等を JSON 提供 | 最も構造化されるが、契約と審査が必要 |

京都銀行サイトは APK ファイルの直接配布を案内せず、公式 Android 入手先を Google Play としている。本調査では third-party APK mirror を初期経路にせず、binary の reverse engineering も行っていない。

## 6. third-party client の具体的 transport / auth

京都銀行の [API 契約先一覧](https://www.kyotobank.co.jp/api/agreement/api.html) には、マネーフォワード、くふうカンパニー、ソリマチ、freee、弥生、SBI ビジネス・ソリューションズ、マネーツリー、ミロク情報サービス、エメラダ、TKC、TIS が掲載される。これは 京都銀行が API 接続を正式提供している一次証拠である。

公開された AnserParaSOL v1.10 の transport/auth は次の通り。

1. HTTPS の `GET /parasol/v1/banks/{bank_code}/oauth/auth` に `response_type=code`、`client_id`、`redirect_uri`、`state`、`scope=accounts` を付け、利用者を銀行の認証・同意画面へ送る。
2. redirect で得た authorization code を `POST .../oauth/token` へ送る。token endpoint は client の HTTP Basic 認証、body は `application/x-www-form-urlencoded`、grant は `authorization_code` / `refresh_token`。
3. data API は `Authorization: Bearer ...`、JSON 応答。`GET .../accounts`、`GET .../accounts/{account_id}`、`GET .../accounts/{account_id}/transactions`、`GET .../term_deposits` 等を使う。
4. access token の有効秒数と refresh token 有効期限が返る。自動更新と利用者操作による更新を `auto_manual_mode` で区別する。
5. [Moneytree の利用者向け説明](https://help.getmoneytree.com/ja/articles/3701696-%E9%8A%80%E8%A1%8Capi%E3%81%AE%E5%88%A9%E7%94%A8%E6%96%B9%E6%B3%95%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6) も、利用者を銀行 Web へ移動し、銀行側で認証情報を入力して連携を許可する流れを示す。third party が銀行パスワードを自前 collector に渡す方式ではない。

注意: 公開 YAML の host は sample であり、京都銀行の商用 API URL、client credential、選択可能 scope、refresh 期間は契約後資料で確定する。公開 GitHub 検索では京都銀行口座明細を取得する bank-specific OSS client は確認できなかった。店舗検索 spider や銀行コード一覧は口座 client ではない。

## 7. Workers / Containers / OCI / Kubernetes 適性

| 方式 | Workers | Cloudflare Containers | OCI/Kubernetes | 評価 |
| --- | --- | --- | --- | --- |
| 手動 CSV/PDF → upload/import | ◎ upload API、R2、D1、parser に適する | 不要 | 不要 | 認証を cloud に置かない。初期案 |
| 契約済み公式 Open API | ○ HTTPS/OAuth/JSON は適する | 通常不要 | 通常不要 | client secret/refresh token を source-scoped secret として隔離。mTLS、固定 IP、HSM 要件は契約後確認 |
| AnserParaSOL HTML browser automation | × DOM browser と対話認証が必要 | △ Playwright は可能だが、profile/OTP/追加認証/保守が重い | △ 技術的には可能、運用上過剰 | local/manual capture を優先 |
| Android APK/UI automation | × | ×〜△ emulator、Play Integrity、NFC/生体/端末 binding が障害 | △ emulator は可能でも高リスク | 採用しない |

OCI/Kubernetes は長時間 browser/emulator と persistent volume を動かせるが、それは適性ではなく「実行できる」に過ぎない。個人口座の認証秘密を常駐 cluster へ移すコストと攻撃面が利益を上回る。

## 8. 自動化評価 A–E / コスト 1–5

共通評価は、A=documented/export API による scheduled headless、B=renewable/reusable session を使う安定した read-only internal API、C=browser/app bootstrap 後の headless replay、D=full browser/device UI automation、E=manual capture を安全な既定とする。コストは 1=小、5=契約/高保守/高リスク。

| 候補 | 自動化 | コスト | 判断 |
| --- | --- | --- | --- |
| スマート通帳 CSV を手動出力し local importer へ渡す | E | 1 | 今すぐの推奨。最大 1,000 明細を定期保存 |
| 利用者の手動 Web 閲覧を Kuebiko で受動 capture（認証 request/headers 除外） | E | 2 | endpoint/schema discovery 用。raw に PII を残さない今回の検証には使わない |
| 契約済み事業者が提供する公式 API を Kogane が正規利用 | A | 3 | vendor の再提供 API、費用、規約次第。aggregator を初期経路にはしない |
| 京都銀行と直接契約する AnserParaSOL API | A | 5 | transport は最良だが、電子決済等代行業者登録・審査・契約が個人プロジェクトの障壁 |
| 認証済み AnserParaSOL read replay | C | 4 | dynamic state、合言葉、OTP、UI 変更、利用規約確認が必要。full browser 操作が残るなら D |
| Android app reverse engineering / UI automation | D | 5 | 端末 binding、NFC/生体、OTP、ストア更新、規約/セキュリティ上の問題。採用しない |

## 9. read-only live 検証計画と stop 条件

### 許可する検証

1. 利用者が公式 URL と証明書を確認し、自分でログインする。agent は秘密を受け取らない。
2. 残高/明細値、口座番号、名義が見えない状態で、口座種別メニュー、期間 selector、印刷/CSV/PDF control の存在だけを確認する。スクリーンショット、DOM dump、network body は保存しない。
3. export は実行せず、利用者が別途用意した redacted sample または synthetic fixture で parser を作る。
4. 公式 API は契約前には公開 simulator/spec のみ使用し、京都銀行商用 endpoint を推測しない。

### 即時停止

- ログイン ID、口座番号、パスワード、合言葉、OTP、My Number password、cookie、authorization code、access/refresh token の入力・表示・送信を agent に求める画面。
- OTP 利用開始/解除、端末再登録、アプリ account 登録、外部サービス連携同意、スマート通帳切替。
- 振込/振替、Pay-easy、ことら、外貨/定期/投信/ローン取引、住所等変更、再発行、取引明細表の有料発行など、確認画面または書込み operation。
- CAPTCHA、Akamai/その他の challenge、追加合言葉、ロック/失敗回数警告、普段と異なる環境の警告。回避・再試行をしない。
- endpoint の意味が不明な POST。AnserParaSOL は read-only navigation に POST を使う可能性があるため HTTP method だけでなく、画面文言と operation の意味が明確になるまで停止する。
- PII/残高/明細を capture、console、ログ、Git、CI artifact、R2/D1 に保存しそうになった時点。

## 未確認事項

- 認証済み Web の CSV/PDF download 有無、1 回の表示件数、正確な HTML/JSON transport。
- スマート通帳 CSV の列、文字コード、改行、重複 ID、取消/訂正表現、取引後残高の有無。
- 京都銀行商用 Open API の host、京都銀行固有の明細期間/件数、返却 optional field、refresh token 期間、IP allowlist/mTLS 要件、料金。
- passkey/WebAuthn 対応。公開サイト/FAQでは確認できなかった。
- ログイン後の WAF/anti-bot/rate limit と、Akamai が CDN 以外にどの security module を有効化しているか。
- 京銀アプリの binary transport、certificate pinning、Play Integrity/attestation。公式 APK を third-party mirror から取得していないため未分析。

## 主要一次資料

- [京都銀行: 京銀ダイレクトバンキング サービス内容](https://www.kyotobank.co.jp/kojin/directb/service/)
- [京都銀行: 京銀アプリ 金融サービス](https://www.kyotobank.co.jp/kojin/kyoginapp/banking/)
- [京都銀行: セキュリティ対策](https://www.kyotobank.co.jp/kojin/directb/security/)
- [京都銀行: ワンタイムパスワード](https://www.kyotobank.co.jp/kojin/directb/security/onetimepass.html)
- [京都銀行: API 連携方針・提供機能](https://www.kyotobank.co.jp/api/policy/)
- [京都銀行: API 契約済み電子決済等代行業者](https://www.kyotobank.co.jp/api/agreement/api.html)
- [NTT DATA OpenCanvas: AnserParaSOL API 一覧](https://portal.opencanvas.ne.jp/api/parasolapilist/)
- [NTT DATA OpenCanvas: AnserParaSOL API v1.10 OpenAPI](https://portal.opencanvas.ne.jp/wp-content/uploads/2026/02/ParaSOL-APISpec_v1.10.yaml)
