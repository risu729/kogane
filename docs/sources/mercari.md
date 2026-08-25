# Mercari / Merpay / Mercoin 個人口座ソース評価

調査日: 2026-08-26

## スコープと安全境界

本資料は、日本の個人向けメルカリアカウントから直接確認できる次の三系統だけを対象とする。

- メルカリの出品取引、売上金、販売履歴
- メルペイ残高、メルカリポイント、メルペイのクレジット（あと払い・メルカードを含む）の利用履歴
- メルコインが提供する暗号資産の保有・入出金・取引履歴・取引報告書

同じメルカリアカウントと公式アプリから到達できても、運営主体、資産種別、正本となる履歴、帳票を混同しない。特に、本人確認前の「売上金」と本人確認後の「メルペイ残高」、ポイント、クレジット債務、暗号資産、暗号資産取引用の日本円は別フィールドとして保持する。コインチェック連携口座で媒介される暗号資産も、メルコイン自身が扱う BTC / ETH / XRP と同じ台帳だと仮定しない。

アカウントアグリゲータは初期経路にしない。実験は残高・履歴・帳票の読み取りだけに限定し、出品、購入、支払い、チャージ、振込申請、送金、ポイント購入、あと払いの清算、暗号資産の購入・売却・入出金・つみたて、申込、設定変更を行わない。口座 ID、氏名、メール、電話番号、住所、注文・取引 ID、実残高、取引額、暗号資産数量、Cookie、トークン、パスキー、OTP、端末識別子、認証・完全性情報を、ログ、fixture、Issue、PR、コミットへ保存しない。

## 調査方法

メルカリ、メルペイ、メルコインの現行ヘルプと公式 Google Play 掲載を一次情報として使用した。公開 Web/API 面には匿名の `HEAD` だけを送り、応答ヘッダーを確認した。第三者実装は公開ソースを静的に読み、通信先・要求署名・実装範囲を確認した。ログイン、APK 取得、アカウント画面閲覧、実値取得、認証済み通信、取引・設定変更は行っていない。

以下では「公式確認事実」「公開面の直接観測」「第三者実装の証拠」「推測・未確認」を分ける。

## 結論

三系統を一括で無人収集する公開個人 API は確認できず、初期実装は **E / cost 1–2**（公式画面・公式 CSV の手動取り込み）が安全である。メルコインの月間取引報告書 CSV は、月内取引と月末残高を含む唯一の明示的な構造化エクスポートなので最優先で取り込む。メルカリ販売履歴は公式 Web の印刷、メルペイ残高・ポイント・クレジットは公式アプリの各履歴画面を別々に保存する。

完全無人化は **D / cost 5**。金融データの多くがアプリ中心で、パスキー・SMS・本人確認・サービス別申込があり、公開面には Cloudflare Bot Management Cookie が見える。公開されている第三者クライアントは、匿名の商品検索・商品詳細を DPoP 署名付きで読む実装であって、個人の残高、クレジット、暗号資産台帳のクライアントではない。内部 API の存在を、そのまま安定した個人金融 API と評価してはならない。

## 正本と対象範囲

| 系統 | 現在値の正本候補 | 履歴の正本候補 | 確定・未確定の境界 |
| --- | --- | --- | --- |
| メルカリ販売 | Web の残高（または売上）画面 | Web の販売履歴と個別取引 | 取引中は売上未確定。通常は取引完了時に販売利益が売上金または残高へ反映される |
| 売上金 | 本人確認前に表示される売上金 | 売上履歴 | 振込申請期限は取得日から 180 日。本人確認後は残高表示へ移行する |
| メルペイ残高 | アプリ「おさいふ＞残高」 | 残高履歴 | 本人確認後の残高には有効期限がない。チャージ、売上反映、支払い、返金等を残高台帳で見る |
| メルカリポイント | アプリ「おさいふ＞ポイント」 | 履歴と有効期限 | 購入ポイントは購入日から 365 日、無償ポイントはキャンペーン別。誤付与取消もあり得る |
| メルペイのクレジット | アプリ「○月の請求」 | 月別請求内訳、毎月の利用状況 | 店舗データ受領前は「処理中」。加盟店から売上データが届き請求が確定するまで変更され得る |
| メルコイン直接取扱 | アプリ「おさいふ＞ビットコイン等」 | 資産別取引履歴、入出金履歴、月間取引報告書 CSV | BTC / ETH / XRP を直接取扱。運用額は保有数量と現在価格による時価評価であり、日本円残高や取得原価とは別 |
| 連携口座暗号資産 | アプリ内の連携口座表示 | 連携口座の取引履歴・取引報告書 | コインチェック社の現物取引をメルコインが媒介する別サービス。資産・報告を直接取扱分と区別する |

公式根拠:

- [販売利益が反映される時点](https://help.jp.mercari.com/guide/articles/95/)
- [商品が売れた後の取引完了まで](https://help.jp.mercari.com/guide/articles/63/)
- [売上金の 180 日の振込申請期限](https://help.jp.mercari.com/guide/articles/96/)
- [本人確認後の売上金・残高表示](https://help.jp.mercari.com/guide/articles/560/)
- [メルペイ残高と本人確認](https://help.jp.mercari.com/guide/articles/551/)
- [ポイントの種類、履歴、有効期限](https://help.jp.mercari.com/guide/articles/40/)
- [クレジット利用履歴の「処理中」](https://help.jp.mercari.com/guide/articles/1234/)
- [暗号資産の直接取扱と連携口座](https://help.jp.mercari.com/guide/articles/1336/)
- [取扱暗号資産一覧](https://help.jp.mercari.com/guide/articles/2036/)
- [暗号資産の運用額・評価損益表示](https://help.jp.mercari.com/guide/articles/1352/)

## 履歴の粒度・期間・エクスポート

### メルカリ販売

公式 Web の「おさいふ＞残高（または売上）＞残高履歴（または売上履歴）」には、販売した商品の取引情報一覧がある。公式ガイドは、販売履歴を iOS / Android アプリでは提供せず、CSV 出力も提供しないと明記し、保存には Web ページの印刷を案内している。PDF は専用帳票ではないが、ブラウザの印刷先を PDF にすれば画面保存できる。

公式ガイドは、一覧の最古日、保持年数、1 ページ件数、総件数上限、ページング仕様を公表していない。したがって「全期間取得可能」とは扱わず、live 検証で最古表示・件数・ページ境界を測る。

- [販売履歴、Web 限定、CSV 非対応](https://help.jp.mercari.com/guide/articles/97/)

### メルペイ残高・ポイント・クレジット

公式アプリの支払手段別履歴は、クレジットが「○月の請求＞内訳を見る」、残高が「残高＞残高履歴」、ポイントが「ポイント＞履歴と有効期限」である。「最近の利用＞毎月のご利用状況」は、ポイント、残高、クレジットを使ったメルカリ・加盟店での買い物を一か月単位でまとめるが、チャージ、返金、売上金反映、振込申請、クレジット利用分の支払出金を含まない。統合表示を完全な台帳として使ってはならない。

紙の利用明細は発行されず、公式案内は画面保存・印刷である。個人向けの残高・ポイント・クレジット履歴について CSV、PDF 帳票、年間利用報告書を提供する一次情報は確認できなかった。保持期間、最古月、ページ件数、総件数上限も公表されていない。おさいふの最近の利用には反映遅延があり得る。

キャンセル時の残高・ポイント返金は通常同時に反映され、各履歴で確認する。クレジットは加盟店から後着したデータで請求・返金表示が変わる場合があるため、`processing` と `settled` を同一行の状態遷移として保存し、初見値を確定値として固定しない。

- [支払手段別・月別の利用履歴と紙明細なし](https://help.jp.mercari.com/guide/articles/578/)
- [月別利用履歴の対象外イベント](https://help.jp.mercari.com/guide/articles/746/)
- [おさいふ画面と履歴反映の時間差](https://help.jp.mercari.com/guide/articles/2037/)
- [残高・ポイント払いの返金履歴と時期](https://help.jp.mercari.com/guide/articles/466/)
- [キャンセル後に加盟店データで再請求される場合](https://help.jp.mercari.com/guide/articles/2093/)

### メルコイン

アプリの取引履歴は資産を選択して確認し、個別詳細には取引種別（購入、つみたて購入、売却、支払いのための売却、受取等）、日時、注文 ID 等がある。ID や実値は収集記録に残さない。別の「チャージ・移した履歴」は、暗号資産取引用日本円の入出金を日付・金額・種別で保持するため、暗号資産売買履歴と分ける。

法令に基づく月間取引報告書は、月内の取引履歴と月末残高を CSV で交付する。取引がない月にも交付され、前月分の作成完了後にメール通知される。アプリから対象月ごとにダウンロードする。退会月と翌月分も交付され、退会後に過去分が必要なら事務局へ依頼できる。

公式の年間損益説明は、1 月から 12 月までの月間 CSV の値を利用者が合算する方法であり、単一の年間 CSV / PDF を示していない。CSV には取引種別、取引ペア、暗号資産数量の増減、約定金額等があり、取引単位の損益計算材料になる。画面履歴の保持期間・件数上限は公表されていないが、月次 CSV があるので表示履歴を長期正本にしない。

- [資産別取引履歴と個別詳細](https://help.jp.mercari.com/guide/articles/1368/)
- [暗号資産取引用日本円の入出金履歴](https://help.jp.mercari.com/guide/articles/1361/)
- [月間取引報告書 CSV、月末残高、退会後の扱い](https://help.jp.mercari.com/guide/articles/1369/)
- [月間 CSV を使う年間損益計算](https://help.jp.mercari.com/guide/articles/1513/)
- [手数料なし・提示価格にスプレッドを含む](https://help.jp.mercari.com/guide/articles/1473/)

## 認証、MFA、パスキー、Bitwarden

### 公式に確認できる事実

- メルカリは 2026-05-29 以降、ログイン方法の更新を段階導入している。パスキー登録済みアカウントではメルカリサービスへのログインにパスキーを使用し、状況により Apple / Google / Facebook / LINE、メールのマジックリンクと SMS の代替経路が案内される。未登録アカウントではメールアドレスまたは電話番号とパスワード等の経路が残る。
- Web の「パスキーでログイン」は QR コードを表示し、メルカリアプリで登録したパスキーを持つスマートフォン等で読み取る方法が案内される。登録端末交換後も、登録済みならパスキー認証が要求される。
- SMS 認証では 6 桁の認証番号を使う。ログインやメルペイ利用時に本人確認を要求されることがある。
- メルコイン利用開始には、メルカリアカウント、パスキー登録、本人確認、サービス申込が必要である。共通ログインは、メルコインの利用資格や台帳がメルカリ販売と同一であることを意味しない。
- メルカリのガイドは「デジタル認証アプリ」による問題をサポート対象外としているが、これは Bitwarden の WebAuthn パスキー対応可否を直接述べたものではない。

公式根拠:

- [ログイン方法アップデート](https://help.jp.mercari.com/guide/articles/1860/)
- [パスキーありのログインと Web QR](https://help.jp.mercari.com/guide/articles/1875/)
- [SMS 6 桁認証とパスキー推奨](https://help.jp.mercari.com/guide/articles/1043/)
- [SMS による本人確認](https://help.jp.mercari.com/guide/articles/687/)
- [機種変更後のパスキー](https://help.jp.mercari.com/guide/articles/243/)
- [メルコインの利用条件](https://help.jp.mercari.com/guide/articles/1336/)

### Bitwarden との関係

Bitwarden は一般にブラウザ拡張から WebAuthn パスキーを保存・使用でき、パスワードや TOTP の自動入力もできる。これは Bitwarden の機能として確認できる事実である。

- [Bitwarden のパスキー・資格情報自動入力](https://bitwarden.com/help/auto-fill-browser/)

一方、メルカリアプリで登録したパスキーが Bitwarden を資格情報プロバイダーとして選べるか、Bitwarden 保存パスキーが公式アプリと Web QR フローの双方で受理されるか、OS・端末に束縛されるかは未確認である。よって「Bitwarden で無人ログイン可能」と推測しない。live 検証では秘密を表示・出力せず、登録済みパスキーのプロバイダー名と、Web ログイン時に選択肢が提示されるかだけを人手で確認する。

## 公式アプリ、APK、Web の役割

日本向け公式 Android アプリは Google Play の package [`com.kouzoh.mercari`](https://play.google.com/store/apps/details?id=com.kouzoh.mercari&hl=ja)、publisher `Mercari, Inc` である。同じアプリ内にメルカリ、メルペイ、メルコイン機能が集約され、公式掲載は暗号資産取引もメルカリアプリ内と説明する。メルペイ残高・ポイント・クレジット、メルコイン保有・履歴・月次 CSV はアプリ中心である。

Web は商品閲覧・取引画面に加え、販売履歴の一覧と印刷を提供する。販売履歴は逆にアプリ非対応である。Web ログインはアプリ登録済みパスキーを使う QR フローを持つため、ブラウザ単独のパスワード自動入力だけで全画面へ到達できるとは限らない。

メルカリ配布の standalone APK は確認できなかった。APK ミラーを取得経路にせず、静的解析が必要なら利用者が Google Play から正規導入した端末の split APK を、別途明示許可を得て抽出する。静的解析は API host、read-only request model、ページング、トークン更新、端末・完全性ヘッダー、certificate pinning の探索には有用だが、サーバー再生可能性の証明ではない。

## 公開 API と第三者実装

個人の販売・残高・ポイント・クレジット・暗号資産台帳を取得する、公開・自己申込可能な公式 API は確認できなかった。メルカリShops の GraphQL API と Personal Access Token はショップ事業者用であり、本資料の個人口座ソースではない。メルペイ加盟店向け API も決済受付側の契約 API であり、消費者の個人台帳エクスポートではない。

- [メルカリShops API reference](https://api.mercari-shops.com/docs/index.html)
- [メルペイ加盟店規約のオンライン API](https://www.merpay.com/merchant/terms/)

公開第三者実装 [`take-kun/mercapi`](https://github.com/take-kun/mercapi/tree/9455cf167d4a3eff5674612631a6e88e72424c7f) は、Python `httpx.AsyncClient` から次を行う。

- 起動時に P-256 鍵とランダム UUID を生成する。
- `X-Platform: web` を付け、各 request の URL・method・UUID を ES256 の DPoP JWT に署名する。
- `POST https://api.mercari.jp/v2/entities:search` で商品検索し、page token を扱う。
- `GET /items/get`、`/users/get_profile`、`/items/get_items` で公開商品・出品者情報を読む。

[`marvinody/mercari`](https://github.com/marvinody/mercari/tree/8aa38587a7905d62cadaf4cfb35bb555eefa7d96) も `requests` と ES256 DPoP で公開検索・商品取得を実装する。[`enemy732/mercari-jp-wrapper`](https://github.com/enemy732/mercari-jp-wrapper/tree/bd87146c39c839901ac58f689a16dcba98b018cf) は `accounts.mercari.com` への事前 request で Authorization / DPoP header を得て `api.mercari.jp` の検索へ送る形を示す。

これらは公開商品面の transport / request-signing の具体例であり、ログイン、セッション更新、個人販売履歴、メルペイ、メルコインを実装していない。第三者実装の DPoP 生成成功を、金融データへの認可や長期セッション再利用の証拠にしない。発見した内部 endpoint を片端から呼ぶ探索も行わない。

## WAF・anti-bot の観測

2026-08-26 に WSL から匿名 `HEAD` を行った範囲では、`jp.mercari.com`、`help.jp.mercari.com`、`auth.mercari.com`、`api.mercari.jp`、`accounts.mercari.com` は `server: cloudflare`、`cf-ray`、`__cf_bm` を返した。`__cf_bm` は Cloudflare Bot Management 系 Cookie である。`jp.mercari.com` と help は背後に `via: 1.1 google` も見えた。`api.mercari.jp/v2/entities:search` への method 不一致の匿名 HEAD は Cloudflare 403、auth/accounts の root または未対応 path は 404 だった。

これは「観測した host の edge が Cloudflare であり bot 管理 Cookie を設定した」証拠である。ログイン後の金融 API が同じ policy であること、403 が bot 判定だけを理由とすること、rate limit、challenge 条件、地理制限、端末 attestation、certificate pinning は確認していない。Akamai を示す CNAME、`AkamaiGHost`、拒否マーカーは今回の応答に見つからず、現時点で Akamai 採用を肯定しない。

反復 403 / 429、challenge、CAPTCHA、パスキー再認証、アプリのセッション失効を回避するために IP rotation、fingerprint 偽装、challenge bypass を行わない。

## read / write の隔離

収集器は「同じ API host だから安全」ではなく、意味上の操作を allowlist する。

| 許可候補 | 禁止 |
| --- | --- |
| 残高・ポイント・保有資産の current snapshot | 出品・価格変更・削除 |
| 販売、残高、ポイント、クレジット、暗号資産の list/detail | 購入、支払い、送金、受取操作 |
| 既存の月間取引報告書 CSV の list/download | チャージ、振込申請、残高移動、ポイント購入 |
| 既存帳票・履歴画面の印刷/保存 | クレジット清算、自動引落し設定、暗号資産売買・つみたて |

HTTP `POST` でも検索のように read-only なものがあり、`GET` でも署名 URL 生成等の副作用があり得るため method だけで分類しない。最初は固定された read-only route と response schema だけを許可し、未知 route、未知 field、write verb を deny する。第三者 library は read/write method が混在し得るので直接依存せず、必要なら read model だけを別実装する。

## 実行環境適性

| Runtime | 適性 | 理由 |
| --- | --- | --- |
| Cloudflare Workers | **手動 export 取込には高、認証 bootstrap には低** | Fetch API で通常の HTTP を送れ、CSV/PDF/HTML の受領・正規化に向く。一方、ローカル filesystem や公式 Android アプリを持たず、パスキー QR、SMS、端末状態を生成できない。Cloudflare edge からの replay は別 WAF policy を受け得る |
| Cloudflare Containers | **後処理は中、アプリ自動化は低** | 任意言語・Linux filesystem の処理はできるが、Play 導入済み端末、パスキー、SMS、端末完全性を再現しない。Worker から on-demand 起動される構成も、長期の人間向けアプリ session 保持には不向き |
| OCI VM / 固定 egress | **read-only replay が証明された後は中** | 暗号化 session、常駐 process、固定 egress、ブラウザを管理しやすい。だが公式アプリ境界や bot/端末拘束を解消せず、未確認 endpoint の安定性も上げない |
| Kubernetes | **多数ソース運用には中、初期単独 collector には過剰** | CronJob、secret 分離、network policy、監査に向く。Mercari 一件の手動 export 取込だけなら運用コストが上回る。write route を network / code policy で拒否できる場合に採用価値がある |
| 利用者管理の公式 Android + ブラウザ | **一次確認に最適** | 既存の正規 session と対応パスキーを持つ。人が read-only 画面・既存 CSV を選び、秘密や実値を外へ出さず検証できる |

Cloudflare の現行仕様根拠:

- [Workers Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/)
- [Workers security model と filesystem 非対応](https://developers.cloudflare.com/workers/reference/security-model/)
- [Cloudflare Containers overview](https://developers.cloudflare.com/containers/)

## PR #5 共通 A–E / cost 評価

共通定義は、A = 公開・文書化 API / export API で scheduled headless、B = 安定した read-only internal API と更新可能 session、C = browser/app bootstrap 後の headless replay、D = full browser/device automation、E = manual capture。cost は 1（小さな wrapper）から 5（端末拘束・対抗的自動化）である。

| 経路 | Level | Cost | 判断 |
| --- | --- | ---: | --- |
| メルコイン月間 CSV の手動 download + import | **E** | **1** | 最初に実装。公式、構造化、月末残高付き。毎月保存して長期正本にする |
| メルカリ販売履歴の Web 印刷 + import | **E** | **1–2** | CSV なし。印刷 HTML/PDF の schema drift を許容し、原本を保持する |
| メルペイ各履歴の画面保存 + manual normalization | **E** | **2** | 残高・ポイント・クレジットを別 capture。統合月次画面だけでは不足 |
| Web の販売履歴を browser automation | **D** | **4** | パスキー QR / fallback と Cloudflare policy を越える有人 bootstrap が必要。印刷が安いので優先しない |
| 公式 Android の全履歴・月次 CSV UI automation | **D** | **5** | 端末、パスキー、サービス別画面、非同期帳票、誤操作防止が必要 |
| 未公開 API の session replay | **C 候補、未採用** | **5** | 認証済み read-only capture がなく、金融 endpoint・refresh・端末拘束・WAF が未確認。現時点では B と評価しない |

総合評価は **D / cost 5**、安全な初期経路は **E / cost 1–2** である。A/B の根拠はなく、公開商品検索 client を根拠に C へ昇格させない。

## read-only live 検証計画

1. 利用者の既存公式アプリと Web session を使用し、サービス名、画面見出し、表示フィールド名だけを記録する。実値、ID、通知本文、メール、QR、Cookie、token は記録しない。
2. Web 販売履歴を開き、最古表示日ではなく「最古まで到達できたか」、page / infinite scroll、1 page 件数、印刷時の列と改ページだけを確認する。個別取引の操作 button は押さない。
3. アプリで残高履歴、ポイント履歴・有効期限、月別利用状況、クレジット請求内訳を順に閲覧し、重複・包含関係、処理中 / 確定 / 返金状態名、最古月、ページングだけを redacted checklist に記録する。
4. メルコインで保有資産一覧、資産別取引履歴、入出金履歴、取引報告書一覧を閲覧する。取引画面の購入・売却・チャージ導線には進まない。
5. 既に発行済みの月間 CSV 一件だけを利用者が手動 download し、隔離したローカル環境で header、encoding、行種別、月末残高行、asset symbol、訂正行の有無を確認する。実データを Git や診断ログに残さない。
6. Web のパスキー login は、登録済み端末で通常の QR 読取を一度観察し、Bitwarden provider が選択肢に現れるかだけ確認する。再登録、削除、パスキー設定変更をしない。
7. 認証済み network capture を行う場合は別の明示許可を得て、残高 snapshot、history list、detail、既存 report list/download 各一回だけに限定する。request を保存する前に Authorization、Cookie、DPoP、device / integrity header、query / body の ID と実値を破棄する。
8. replay は local で一回だけ試し、成功しても cloud へ session を移す前に、token 更新、同時 session、write route 隔離、失効時の挙動を再審査する。

## 即時 stop 条件

次のいずれかでその経路を停止し、再試行・回避を行わない。

- 出品、購入、支払い、チャージ、送金、振込、清算、暗号資産取引、つみたて、申込、同意、設定保存の確認画面へ遷移した。
- パスキー登録・削除、SMS / OTP 入力、本人確認、口座連携、利用枠変更を要求された。
- request が read-only allowlist 外、または response の意味が不明である。
- 401 / 403 / 429、Cloudflare challenge、CAPTCHA、追加本人確認、異常ログイン通知、アプリ session 失効が発生した。
- certificate pinning、device attestation、root / emulator 拒否を回避する必要が生じた。
- 実値、PII、ID、秘密が URL、画面、ログ、exception、telemetry に残りそうである。
- 利用履歴の取得が、規約で禁止される自動化・過剰負荷・security control 回避を必要とする。

## 未確認事項 / acceptance gate

- [ ] 販売履歴、残高履歴、ポイント履歴、クレジット請求内訳の最古日・最古月、件数上限、page size。
- [ ] 「処理中」から確定・取消・返金への状態名と、訂正時に同一 ID が更新されるか別行が追加されるか。
- [ ] 月間取引報告書 CSV の全 header、encoding、直接取扱と連携口座の区別、訂正・再発行時の同一性。
- [ ] 取引報告書のアプリ内保持期間。退会後の問い合わせ提供は確認済みだが、在会中に一覧から全月を取得できる保証は未確認。
- [ ] 公式 Web / Android の金融 read endpoint、pagination、token lifetime / refresh、DPoP、device / integrity binding、certificate pinning。
- [ ] Mercari app 登録パスキーを Bitwarden provider に保存・利用できるか。一般的 WebAuthn 対応から推定しない。
- [ ] Cloudflare 403 の理由、rate limit、地域・egress 差、認証後 API host の CDN / WAF。
- [ ] 個人口座向け read-only API / data portability route の有無。Shops・加盟店 API は代替にならない。
