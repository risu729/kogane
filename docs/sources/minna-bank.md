# みんなの銀行 一次調査

調査日: 2026-08-26

## 結論

Kogane の個人口座データ源は、aggregator を初期経路にせず、**公式スマートフォンアプリから
手動で発行する預金取引明細 PDF** を安全な初手とする。公式 FAQ では、個人の取引明細は
アプリで確認し、預金取引明細は一度に1年以内の範囲を PDF 出力できる。個人向け CSV は
見つからなかった。普通預金（Wallet）、貯蓄預金（Saving / Box）の残高、普通預金に記帳
されるデビット利用、振込・振替・入出金は収集候補になる。

みんなの銀行は「スマホ完結」「スマートフォン専用」で、通常の個人向け残高・明細を閲覧する
WEB バンキングは確認できなかった。ただし、技術的にすべてが app-only なのではない。
銀行は REST/JSON の正式 BaaS API を提携事業者へ提供しており、Accounts API は残高と
入出金明細を扱う。Money Forward ME の WEB 連携ではブラウザで ID/パスワードを入力し、
WEB に表示された4桁コードを公式アプリへ入力して認可する経路も公開されている。したがって、
**直接の個人向け操作画面は app-only、提携事業者向け参照経路は API + WEB/アプリ認可**
という区別が正確である。

一次評価は次のとおり。Level は `docs/source-research.md` の共通基準を使う。

| 経路 | Level | コスト (1-5) | 現時点の評価 |
| --- | --- | ---: | --- |
| 公式アプリから預金取引明細 PDF を手動保存 | **E** | **1-2** | 安全な既定。月次または年次で保存し、ローカル parser が取り込む。 |
| 公式 BaaS Accounts API | **A（制度上）** | **4-5** | headless に適するが、提携審査、契約、mTLS クライアント証明書が必要。個人 collector の自己登録経路ではない。 |
| 公式 Android アプリの UI 自動化 | **D** | **5** | 登録端末1台、端末固有情報、生体/パスワード、SMS 端末認証がある。実機常駐が必要になりやすい。 |
| アプリで bootstrap した session の read-only replay | **C（候補）** | **4** | API-first / Apigee 構成から技術的には plausible だが、endpoint、token、端末/IP拘束、pinning は未確認。 |
| 安定した非公開 read API client | **B** | — | 現在は根拠なし。公開クライアントも見つからない。 |

**このソースの現在値は E / cost 1-2** とする。正式 BaaS 契約が成立した場合だけ A に
切り替えられる。APK / 実機の read-only 検証で再利用可能 session と表示 API が確認できれば、
C へ再評価する。公開情報だけで B や C を確定しない。

## 調査範囲と安全境界

- 対象は、みんなの銀行の個人向け公式アプリ、個人向け公開情報、公式 BaaS 公開情報だけ。
- 法人インターネットバンキングは別商品であり、個人口座の可否判断へ混ぜない。
- Money Forward 等の aggregator は、公式 API の具体的な transport / consent flow を確認する
  ための公開実装例としてのみ扱い、Kogane の初期収集経路にはしない。
- ログイン、口座連携、PDF 発行、アプリ導入、APK 取得は行っていない。
- 口座番号、ユーザー ID、残高、明細本文、氏名、電話番号、メールアドレス、秘密、token、
  cookie、端末識別子は取得・記録していない。
- 振込、振替、Box 移動、デビット、ローン、Cover、ポイント交換、設定変更、API consent の
  付与/解除を行っていない。

## 公式の入口と app-only 境界

| 入口 | 確認できる用途 | 判定 |
| --- | --- | --- |
| [公式サービスサイト](https://www.minna-no-ginko.com/) | 商品説明、ユーザーガイド、公式アプリへの導線 | 公開情報。個人残高・明細のログイン入口ではない。 |
| [公式 Google Play (`com.MinnaNoGinko.bankapp`)](https://play.google.com/store/apps/details?id=com.MinnaNoGinko.bankapp&hl=ja) | Android アプリの正規配布 | 個人向け主チャネル。2026-07-22 更新、100万+ downloads 表示を確認。 |
| [公式 App Store (`id1521392854`)](https://apps.apple.com/jp/app/id1521392854) | iPhone アプリの正規配布 | 個人向け主チャネル。iPhone のみ対応表示。 |
| [利用できる端末・機種](https://cs-faq.minna-no-ginko.com/faq/show/613) | iOS 15+ / Android 8+ | スマートフォン向け。タブレットは正常動作しない可能性。 |
| [スマートフォン専用 FAQ](https://cs-faq.minna-no-ginko.com/faq/show/148) | タブレット利用の扱い | 公式がアプリを「スマートフォン専用」と明記。 |
| [複数端末 FAQ](https://cs-faq.minna-no-ginko.com/faq/show/147) | 登録可能端末数 | 利用できるスマートフォンは1台だけ。 |
| [BaaS API 一覧](https://baas.minna-no-ginko.com/service/api/list/) | 提携事業者向け REST/HTTPS/JSON API | 個人のセルフサービス API ではない。 |
| [Money Forward ME 連携手順](https://support.me.moneyforward.com/hc/ja/articles/12172814934425-%E3%81%BF%E3%82%93%E3%81%AA%E3%81%AE%E9%8A%80%E8%A1%8C%E3%81%AE%E9%80%A3%E6%90%BA%E6%96%B9%E6%B3%95) | 実運用中の参照系 API 認可例 | アプリ間遷移、または PC WEB + 4桁コード + 公式アプリ承認。 |

公式トップは「スマホひとつでお金のすべてが完結」、公式 FAQ はスマートフォン専用・1台のみ
と説明する。これは**直接の個人向けチャネル**についての app-only 根拠である。

一方、Money Forward の公開手順では次の2経路がある。

1. Money Forward ME アプリから連携を開始し、みんなの銀行アプリへ遷移してログイン・同意する。
2. PC の Money Forward WEB から連携を開始し、みんなの銀行のサイトで ID/パスワードを入力、
   表示された4桁コードを手元の公式アプリへ入力して完了する。

後者は残高・明細を直接閲覧する WEB バンキングではなく、第三者 API 連携の認可経路である。
「WEB が一切ない」または「アプリ以外からデータを読めない」とは結論しない。

## 取得対象

### 預金残高

公式 FAQ は次を明記する。

- Wallet 画面: 普通預金残高。
- Banking 画面: 普通預金に加え、貯蓄預金の Saving / Box 残高。
- Box は貯蓄預金口座に紐づくバーチャル口座で最大20個。

根拠:

- [現在の預金残高を確認する方法](https://cs-faq.minna-no-ginko.com/faq/show/707)
- [Box とはどのような口座か](https://cs-faq.minna-no-ginko.com/faq/show/312)
- [Box 公式サービス案内](https://www.minna-no-ginko.com/service/box/)

Kogane では Wallet / Saving / 各 Box を別 `source_account` 候補として観測する。ただし Box 名は
利用者が自由入力するため PII になり得る。本調査では名称・残高を取得しない。live 検証でも
個別名称をログへ出さず、`box_count` と構造の yes/no だけを残す。

### 入出金明細と粒度

公式 FAQ による確認済み粒度は次のとおり。

| 項目 | 公開仕様 |
| --- | --- |
| 対象取引 | 振込、振替、入金、出金など |
| 明細の確認項目 | 取引日時、取引金額 |
| 一度に指定できる期間 | 1年以内 |
| 一度に表示できる件数 | 最大1,000件 |
| 複数年 | 1年以内の期間へ分割して表示/出力 |
| 預金取引明細 export | 個人アプリから PDF |
| CSV / OFX / QIF | 個人向け公開情報では確認できず |
| 振込1件の証明 | 対象の振込出金明細から PDF 発行可能 |

根拠:

- [取引明細で確認できる内容・1年・1,000件上限](https://cs-faq.minna-no-ginko.com/faq/show/708)
- [預金取引明細 PDF・1回1年以内](https://cs-faq.minna-no-ginko.com/faq/show/669)
- [振込取引明細書 PDF](https://cs-faq.minna-no-ginko.com/faq/show/670)

振込に限る別 FAQ は「表示期間の制限はないが、一度に最大1,000明細」と説明している。
これは「全履歴が1回で取れる」という意味ではなく、過去を遡れる表示と1回の取得上限を分けた
記述と読む。全取引種別について最古日が無期限であること、1,000件を超えた同一期間の page / cursor
挙動は未確認とする。

- [過去の振込内容（全体の期間制限なし、1回1,000件）](https://cs-faq.minna-no-ginko.com/faq/show/299)

PDF の列、取引後残高、摘要、相手情報、provider transaction ID、page 数、text layer、暗号化、
PDF 内で Wallet / Saving / Box がどう分かれるかは公開 FAQ だけでは確定できない。これらは live
検証項目とする。

### デビット

みんなの銀行デビットは、口座開設と同時に発行されるバーチャルデビットで、利用額は普通預金
から即時に引き落とされ、普通預金の取引明細へ反映される。公式 FAQ は、普通預金の明細を
「デビット」で検索して絞り込む方法を案内する。MyJCB はキャンペーン登録用で、利用明細等は
公式アプリを参照する。

- [デビットの概要・即時反映](https://cs-faq.minna-no-ginko.com/faq/show/457)
- [デビット取引明細の確認方法](https://cs-faq.minna-no-ginko.com/faq/show/441)
- [MyJCB ではなく公式アプリで明細確認](https://cs-faq.minna-no-ginko.com/faq/show/381)

したがって、初期 PDF importer は普通預金明細のデビット記帳を取り込める可能性が高い。ただし、
加盟店名、承認/確定、海外通貨、為替レート、追加引落し、取消/返金の具体的フィールドは PDF 実物で
確認する。デビット専用 CSV/PDF は確認できない。

### キャッシュバック、ポイント、Record

デビット特典はポイント残高ではなく、通常会員0.2%、Premium 会員1%の**現金キャッシュバック**で、
普通預金へ入金される。Kogane では reward point として別計上せず、普通預金の provider-reported
入金 observation として扱い、説明が確認できた場合のみ debit cashback と解釈する。

- [キャッシュバックの公式 FAQ](https://cs-faq.minna-no-ginko.com/faq/show/372)

公式の Record は、みんなの銀行の預金だけでなく、他行預金、ローン、カード、証券、年金、
暗号資産、電子マネー等を集約する PFM である。2024年の公式比較表では Record の連携対象に
「ポイント」を含めず、比較対象の家計簿アプリにはポイントを含めている。DMM 等の提携サービスで
外部ポイントが付与される例はあるが、みんなの銀行固有の汎用ポイント残高とは扱わない。

- [Record ユーザーガイド](https://www.minna-no-ginko.com/guide/record/)
- [Record の対象範囲](https://cs-faq.minna-no-ginko.com/faq/show/246)
- [Record の公式比較表](https://www.minna-no-ginko.com/service/record/column/asset-app/)

Record は Money Forward との協働による aggregator であり、初期データ源にしない。Record 内の
他社資産を取得対象に含めると、みんなの銀行自身が直接主張した値と aggregator の値が混ざるため、
Kogane の source boundary に反する。

### 正式 Accounts API の対象

みんなの銀行の公式公開資料は Accounts API について、口座残高、入出金明細、口座名義人、
口座番号、口座種類、金融機関/支店コード・名称を参照すると説明する。FAQ は、口座情報照会で
認証した普通預金と、それに紐づく貯蓄預金の残高・取引明細等が連携されると明記する。

- [API 開発者ポータル公開と API 一覧](https://corporate.minna-no-ginko.com/information/corporate/2024/06/20/544/)
- [API 連携で提供される情報範囲](https://cs-faq.minna-no-ginko.com/faq/show/77)
- [API サービス利用規定](https://corporate.minna-no-ginko.com/collaboration/term-of-api/)

この scope は Kogane の残高・明細要件に近い。しかし API 開発者ポータルは利用申込みと銀行審査が
あり、提携事業者の mTLS client certificate が必要である。個人が自分の口座用 token を発行する
公開セルフサービス経路は確認できない。

## 認証、端末バインド、生体、passkey、Bitwarden

### 確認済み事実

- 個人アプリのログインは、登録したログイン ID、パスワード（または生体認証）、登録スマートフォン
  端末固有の情報を用いる。
- 利用可能なスマートフォンは1台のみ。
- ログアウトすると生体認証ログイン設定は解除され、次回は ID とパスワードが必要。
- 新端末への移行は ID / パスワード入力に加え、登録電話番号へ届く SMS 認証コードで端末認証する。
- Android では端末の画面ロック、iPhone では端末パスコードを安全利用に使うよう公式 FAQ が案内する。

根拠:

- [個人アプリのログイン認証方式](https://cs-faq.minna-no-ginko.com/faq/show/638)
- [生体認証の設定・ログアウト時の解除](https://cs-faq.minna-no-ginko.com/faq/show/157)
- [機種変更と SMS 端末認証](https://cs-faq.minna-no-ginko.com/faq/show/701)
- [複数端末不可](https://cs-faq.minna-no-ginko.com/faq/show/147)
- [安全利用の15か条](https://corporate.minna-no-ginko.com/for-safebanking/safety-measures/)

### passkey の扱い

個人アプリについて、公開 FAQ とアプリストア記載から passkey / WebAuthn / FIDO credential の採用は
確認できなかった。公式の「法人インターネットバンキング」は passkey を採用するが、これは別商品で
あり、個人アプリへ外挿しない。

- [法人インターネットバンキングの passkey 規定](https://corporate.minna-no-ginko.com/term-of-use/business/)

したがって、「みんなの銀行は passkey 対応」と無条件に記述するのは誤りである。個人アプリの生体
ログインは、公開情報上は端末の生体認証を ID/パスワードログインの代替として使う機能であり、
同期型 passkey と同一とは確認できない。

### Bitwarden の扱い

**事実:** みんなの銀行は ID とパスワードを使う。公式資料には Bitwarden、Android Autofill、
iOS Password AutoFill、第三者 passkey manager の対応可否を示す記述が見つからなかった。

**推測:** 標準のアプリ内 login field が Autofill を許せば Bitwarden に ID / パスワードを保管・入力
できる可能性はある。しかし、secure text field、アプリの Autofill 設定、画面 capture 制限、
端末認証を Bitwarden が代替できるかは未確認である。Bitwarden が SMS、端末固有情報、生体認証を
代替することは期待しない。

Kogane は Bitwarden から資格情報を自動投入する前提を置かない。必要になった場合も、人が登録実機で
ログインする bootstrap に限定し、vault master password、銀行 password、SMS code を collector や
Cloudflare へ渡さない。

## transport、API gateway、Akamai / anti-bot

### 確認済み事実

- 正式 BaaS API は REST、HTTPS、JSON。
- 認可方式は FAPI 1.0 Advanced、profile は `FAPI Adv. OP w/MTLS, JARM`。
- token 発行・利用時に mTLS client certificate を要求し、access token と証明書を結び付ける。
- PKCE、署名された認可 request/response、OAuth 2.0 / OpenID Connect を採用する。
- みんなの銀行の認可基盤は Authlete、API gateway は Google Cloud Apigee を採用したと、銀行担当者を
  含む公開セッションで説明されている。
- 2021年公開の銀行システム全体図には Akamai、Apigee、Firebase、Authlete がフロント側の
  認証/セキュリティ要素として掲載されている。
- 2026-08-26 の匿名 DNS 確認では、`www.minna-no-ginko.com`、`corporate.minna-no-ginko.com`、
  `baas.minna-no-ginko.com` はそれぞれ `*.edgekey.net` → `*.akamaiedge.net` へ CNAME した。

根拠:

- [BaaS API 接続要件](https://baas.minna-no-ginko.com/service/api/list/)
- [FAPI 認可ポリシー](https://corporate.minna-no-ginko.com/collaboration/policy-of-api/)
- [Authlete 導入事例](https://www.authlete.com/ja/customer-stories-jp/minnabank)
- [みんなの銀行担当者を含む API 基盤セッション](https://www.authlete.com/ja/resources/videos-jp/20231212-03)
- [2021年の銀行システム全体像](https://jba-web.jp/cms/wp-content/uploads/2021/07/%E6%96%B0%E3%81%97%E3%81%84%E9%8A%80%E8%A1%8C%E6%B0%B8%E5%90%89%E6%A7%98_20210713_JBA%E5%AE%9A%E4%BE%8B%E4%BC%9A.pdf)

### 未確認 / 言い切らない事項

- Akamai の具体的製品（App & API Protector、Bot Manager、Account Protector 等）。
- public website と mobile API が同じ Akamai property / policy を使うか。
- login、token、残高、明細 endpoint ごとの WAF / bot score / rate limit。
- mobile API host、certificate pinning、Play Integrity、root/emulator detection、attestation。
- access token、refresh token、device key、cookie の形式・寿命・再利用条件。

Akamai edge の利用は確認できるが、匿名 public GET の成功・失敗だけで mobile login の anti-bot を
判定しない。API endpoint の推測、credentialed probe、rate limit 探索は行わない。

## 公開されている第三者実装

### 実運用例: Money Forward ME

Money Forward は、みんなの銀行と最初に正式 API 連携した PFM であり、銀行 ID/パスワードを
Money Forward 側へ預けずに残高と入出金明細を取得すると公表している。

- transport: REST / HTTPS / JSON。
- authorization: FAPI 1.0 Advanced、OAuth 2.0 / OIDC、PKCE、JARM。
- client authentication: mTLS。access token は client certificate に binding。
- user consent: mobile app-to-app、または PC WEB で開始して公式アプリへ4桁コードを入力。
- resource: Accounts API の残高・入出金明細。
- 実装主体: 契約・審査済みの電子決済等代行業者/提携事業者。一般配布 SDK や個人 client ではない。

根拠:

- [みんなの銀行と Money Forward の正式 API 連携](https://corp.moneyforward.com/news/release/service/20221108-mf-press/)
- [Money Forward ME の連携操作](https://support.me.moneyforward.com/hc/ja/articles/12172814934425-%E3%81%BF%E3%82%93%E3%81%AA%E3%81%AE%E9%8A%80%E8%A1%8C%E3%81%AE%E9%80%A3%E6%90%BA%E6%96%B9%E6%B3%95)
- [みんなの銀行 API 提供モデル](https://baas.minna-no-ginko.com/service/api/)

### 公開コード検索の結果

2026-08-26 に GitHub code/repository search で、`com.MinnaNoGinko.bankapp`、
`minna-no-ginko.com`、`みんなの銀行 API` を検索したが、残高・明細を取得する動作可能な非公式
client / scraper は見つからなかった。

検索で見つかる次の公開 JSON は、実装ではない。

- [`not-a-bank/open-banking-tracker-data`](https://github.com/not-a-bank/open-banking-tracker-data/blob/2fa27580debf22652720e486af9315ca0c932db1/data/account-providers/minna-no-ginko.json): provider catalog。API endpoint/spec は空で、現在の公式 developer portal を反映していない。
- [`emadomedher/skyline-api-library`](https://github.com/emadomedher/skyline-api-library/blob/deb3c87b6d83435d6e916551b161a540409d318c/profiles/minna-no-ginko/profile.json): `authType: api-key` とする metadata placeholder。公式の FAPI/mTLS と矛盾し、client code ではない。
- [`2factorauth/twofactorauth`](https://github.com/2factorauth/twofactorauth/blob/6ab81bf8d423957d1495ce4ac5dbc2d933773532/entries/m/minna-no-ginko.com.json): domain directory entry。認証 transport の実装ではない。

公開コードがないことは内部 API が存在しない証拠ではない。公式の API-first 構成から mobile API の
存在自体は確実だが、client の具体的 endpoint/auth/session は APK と live traffic を確認するまで
未確認とする。

## Android APK 入手と静的解析の将来方針

公式 Android package は `com.MinnaNoGinko.bankapp`。銀行自身の standalone APK 配布は確認できず、
正規経路は Google Play である。将来の静的解析は次の順序で行う。

1. ユーザー所有の非 root 実機で Google Play から公式アプリをインストールする。
2. 同一の正規配信物を user-owned device / Play delivery から split APK として取得する。第三者 mirror
   を信頼源にしない。
3. package name、versionName/versionCode、各 split の SHA-256、signing certificate digest を保存し、
   Play 表示と照合する。APK 本体は機密でないが、抽出先を access-controlled にする。
4. `apkanalyzer` / `aapt2` / `apksigner` で manifest、SDK、permission、component、署名を確認する。
5. `jadx` / `apktool` / MobSF の**静的解析だけ**で、network security config、API host/path、
   deep link、OAuth redirect URI、data model、User-Agent、pinning / attestation library の存在を確認する。
6. Flutter 等で Java/Kotlin decompile の情報が薄い場合は、assets、native libraries、Dart snapshot の
   strings を観察する。ただし難読化解除や認証回避を成功条件にしない。
7. endpoint 候補は匿名 DNS/TLS と公式 public metadata だけで確認し、credentialed request を送らない。

静的解析の目的は「何を壊して login を通すか」ではなく、**read-only live 検証で観測すべき host、
schema、端末 binding を限定すること**である。certificate pinning / Play Integrity / root detection が
あれば記録して止まり、Frida hook、patch、署名差替え、attestation bypass は行わない。

## 実行基盤の適性

| 基盤 | 適性 | 評価 |
| --- | --- | --- |
| 登録済み Android 実機 | **最良（bootstrap / manual capture）** | 公式が想定する1台のスマートフォン、SMS、画面ロック、生体を満たす。初期 PDF export と構造確認に使う。 |
| ローカル Android emulator | 低〜条件付き | phone number/SMS、device binding、Play Integrity、Play Services、root/emulator 判定が未確認。実機の代替と仮定しない。 |
| Cloudflare Workers | 正式 API なら技術的候補 | Workers は outbound mTLS certificate binding を持つため、契約済み BaaS client の REST/JSON consumer には適合し得る。個人アプリ login/bootstrap は不可。 |
| Cloudflare Containers | replay の PoC 候補 | Linux/amd64 container と browser/tooling は動かせるが、Android phone、SIM/SMS、生体、登録端末を提供しない。session replay が確認された後だけ検討。 |
| OCI VM / Kubernetes | replay / Android lab の候補 | 永続 volume、egress、browser、ADB、self-hosted emulator を制御できる。端末認証・attestationを満たす保証はなく、初回は物理 Android を使う。 |
| hosted Android device farm | 低 | ephemeral device と電話番号、端末 reputation、秘密の持込みが問題。銀行 login 用の常設 issuer にしない。 |

Cloudflare Workers の outbound mTLS は、証明書 binding の `fetch()` で client certificate を提示できる。
正式 API との protocol fit は良いが、銀行から client credential/certificate を発行される提携関係が
前提である。また Cloudflare の文書は、相手が Cloudflare proxied zone の場合に outbound mTLS が
520 になる制約を記す。みんなの銀行 API host がこの制約に当たるかは endpoint 開示後に確認する。

- [Cloudflare Workers mTLS binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/)
- [Cloudflare Containers の Linux/amd64 runtime](https://developers.cloudflare.com/containers/platform-details/architecture/)

推奨順は、登録 Android 実機で manual PDF → APK 静的解析 → 実機上の metadata-only network 観測 →
session replay 可否の判定 → OCI/k8s または Container PoC である。Workers は正式 BaaS 契約時の
第一候補で、非公開 mobile session の bootstrap 先ではない。

## 推奨実装

### Phase 1: manual PDF + local importer（E / cost 1-2）

1. 利用者が登録済み実機の公式アプリで、過去を1年以下の非重複 window に分ける。
2. 預金取引明細 PDF を利用者自身が暗号化されたローカル intake folder へ保存する。
3. importer は raw bytes の SHA-256、発行対象期間、取得時刻だけを metadata として保存する。
4. parser は text layer を優先し、画像 PDF の場合だけローカル OCR を使う。
5. Wallet / Saving / Box、取引日時、金額、摘要、取引後残高等、実 PDF に存在する列だけを
   observation にする。存在しない列を推測で補わない。
6. 1,000件上限に当たる window はさらに短くして再発行する。自動操作はしない。

本調査の「個人値を記録しない」は研究文書への転記禁止を意味する。将来の Kogane 本番 intake は
ユーザーが明示的に選んだ暗号化 raw evidence store のみで扱い、ログ、PR、test fixture、telemetry
へ実データを出さない。

### Phase 2: app metadata / read API feasibility（D → C 判定）

1. APK を正規取得し、署名・hash を検証して静的解析する。
2. 登録実機でユーザーが手動ログインする。collector は ID/password/SMS/biometric を扱わない。
3. OS の VPN capture または Android Studio tooling が通常機能だけで使える場合、host、method、status、
   MIME、時刻だけを記録する。headers/body/query/token は保存しない。
4. 残高/明細画面の read request と、transfer/Box move/settings の write request を host/path/method 単位で
   分離する。write endpoint は allowlist に入れない。
5. certificate pinning が capture を拒否したら停止する。bypass しない。
6. read-only session envelope の export/replay が公式機能または通常の OS/browser storage だけで可能かを
   一度検証する。401/403/login redirect で終了し、credential login を再試行しない。

### Phase 3: formal API（契約できる場合だけ A）

銀行の developer portal 審査・契約を正規に通過できる場合だけ、Accounts API を実装する。scope は
残高・入出金明細だけに絞り、Payments / 更新系 API は登録しない。mTLS private key は scoped secret
として保管し、token と raw financial payload をログへ出さない。

## read-only live 検証

次の検証は、ユーザー立会い・登録実機・低頻度で行い、個人値を調査記録へ残さない。

1. Google Play の package、version、signing certificate を確認する。
2. 未ログイン状態で、個人向け browser login / statement viewer が存在しないことを再確認する。
3. ユーザーが実機で手動ログインし、パスワード、生体、SMS のどれが発生したかを yes/no で記録する。
4. Wallet / Saving / Box の画面階層と、各残高・各明細の有無だけを確認する。名称・金額・件数は記録しない。
5. 明細 filter の開始/終了日、1年制約、1,000件超時の表示を構造だけ確認する。
6. デビット filter が普通預金明細の一部であること、pending/posted/refund/FX の状態ラベルの有無を確認する。
7. PDF export の選択肢、対象口座、対象期間、format、text layer、page header、列名を確認する。
   実 PDF の内容を PR、chat、screenshot、HAR に貼らない。
8. Saving / Box の振替が PDF で両側にどう表現されるかを既存履歴から確認する。新しい振替は作らない。
9. host/method/status/MIME だけの metadata capture が無改変で可能か確認する。
10. app restart / device restart 後の session 維持を各1回だけ確認する。logout はしない。

成功条件は「ログインできた」ではない。次のすべてを満たすこととする。

- 書込み、送金、振替、Box 移動、consent 変更、設定変更を一度も行わない。
- 個人値・秘密を research artifact / log に残さない。
- PDF の期間・件数・列と API/UI の対象範囲を構造として説明できる。
- read endpoint と write endpoint を安全に分離できる、または分離不能と判断できる。
- 再取得が必要な場合も自動 login retry をしない。

## stop 条件

次のいずれかで即停止する。

- SMS、生体認証、ATM暗証番号、本人確認、電話/ビデオ確認が要求され、ユーザーがその場で手動対応しない。
- 401、403、429、Akamai challenge / Access Denied、maintenance、account lock warning。
- 新端末登録、旧端末解除、logout、password reset、電話番号変更を求められる。
- 振込、振替、Box 移動、デビット、ローン、Cover、A2A payment、consent 付与/解除、設定保存の確認画面。
- request/response body、Authorization/Cookie、token、口座番号、残高、明細、PII が capture/log に入る。
- certificate pinning / attestation / root-emulator detection が通常の観測を拒否する。
- 同一 credential または認証 request の2回目の自動試行が必要になる。
- endpoint、HTTP method、read-only 性を確定できない request を送る必要がある。

停止後は回避策、fingerprint spoof、pinning bypass、root、hook、APK patch、token replay を自動で試さない。

## 未確認事項

- 個人向け預金取引明細 PDF の全列、text layer、暗号化、page layout、最大 page/件数。
- PDF が普通預金だけか、Saving / Box を同時または個別に含むか。
- app UI で確認できる最古日、1,000件超の pagination/cursor、全取引種別の実質保持期間。
- デビット明細の pending/posted、取消、返金、海外通貨、為替、加盟店 descriptor の粒度。
- キャッシュバック入金の摘要と debit transactions への provider ID link の有無。
- mobile API host/path/schema、access/refresh token、session lifetime、device/IP/UA binding。
- certificate pinning、Play Integrity、root/emulator detection、hardware-backed key の使用。
- 個人アプリが Android/iOS Autofill を許可し、Bitwarden が ID/password を入力できるか。
- 個人アプリの passkey / WebAuthn 対応。法人 passkey の存在は個人対応の根拠にしない。
- Akamai の具体的 WAF/bot product と mobile API/login endpoint の policy。
- みんなの銀行 API developer portal の審査を Kogane の個人用途で通過できるか、費用、certificate
  lifecycle、rate limit、consent/token 有効期間。
- Cloudflare Workers outbound mTLS が実際の銀行 API hostname と接続できるか。
- OCI/k8s/Cloudflare Container へ read-only session を移して再利用できるか。

これらは推測で埋めず、APK 静的解析とユーザー立会いの read-only live 検証後に更新する。
