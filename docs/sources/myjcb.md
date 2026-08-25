# MyJCB カードファミリー調査

- 調査日: 2026-08-26（Australia/Sydney）
- 対象: 同一の MyJCB／関連バックエンドで参照できる個人カード群。現インベントリでは JCB W、リクルートカード（JCB）、みずほ JCB デビット、京銀 JCB デビットを中心とする。
- 対象外: Visa／Mastercard 版リクルートカード、JCB ブランドでも MyJCB 非対応のカード、銀行口座そのものの入出金明細、カード申込・支払・設定変更などの write 操作。
- 調査制約: 未ログインの公式公開情報、公開レスポンス、公開コードだけを使用した。口座 ID、MyJCB ID、カード番号、氏名、残高、利用額、加盟店、Cookie、OTP、秘密の合い言葉等の実値は取得・保存していない。ログイン後の live 検証は未実施。

## 結論

MyJCB はアプリ専用ではなく、Web 版が明細・利用可能額・ポイント・カード情報の基本面を持つ。確定明細は最長 15 か月を PDF／CSV／OFX で月単位にダウンロードでき、未確定を含む画面照会は最長 17 か月である。未確定明細は export できず、確定後（毎月 24 日前後）に取得可能となる。公開された固定の最大行数は見つからなかった。

複数カードは「一つのアカウントにカードを追加」する模型ではない。カードごとに MyJCB ID があり、許可された組み合わせだけを「おまとめログイン」で相互に切り替える。本会員の明細内には家族、ETC、QUICPay 等の追加カード利用がカード単位でまとまる一方、家族カード ID はおまとめ対象外で、家族会員 ID から PDF／CSV をダウンロードできない。したがって、データ模型は `MyJCB ID に対応するルートカード` と `その明細内の追加カード` を分ける必要がある。

公式の口座・明細 API は公開されていない。2026 年に更新された第三者実装は、Web の動的ログイン保護 JavaScript を隔離実行して ID／パスワードのフォームを POST し、Cookie と User-Agent を再利用して JCB デビット明細の HTML を GET する。実装可能性は示すが、非公式 HTML、動的保護、秘密の合い言葉／OTP／パスキー、発行会社差に依存するため、共通 rubric は **C、cost 4** とする。安全な既定値は確定明細の手動 export で **E、cost 1**。アプリ自動化は **D、cost 5** で、採用しない。

## 公式サーフェスとカード列挙

### MyJCB Web／アプリ

- [MyJCB 公式案内](https://www.jcb.co.jp/myjcb/) は、Web で最新明細、利用額・利用可能額、ポイント、カード関連情報を確認できること、カードごとに ID 登録が必要なことを明記する。アプリは生体／アプリ用パスコード、プッシュ通知、J/Secure アプリ認証等を加えるだけで、取得対象は app-only ではない。
- [MyJCB 機能一覧](https://www.jcb.co.jp/myjcb/feature/index.html) には、明細・利用可能額・ポイント・保有する家族カード／ETC／QUICPay 等のカード情報の照会がある。同じ画面群には支払方法変更、キャッシング、限度額、カード追加、ポイント交換等の write 機能もあるため、collector はメニュー全体を自動巡回してはならない。
- [MyJCB アプリ](https://www.jcb.co.jp/myjcb/app/) は明細の金額・日付・キーワード検索、家族カード／ETC 単位の絞り込み、おまとめカード切替を提供する。Android の公式 package は [`jp.co.jcb.my`](https://play.google.com/store/apps/details?id=jp.co.jcb.my)、iOS は [App Store ID 1097001344](https://apps.apple.com/jp/app/myjcb/id1097001344)。Google Play の公開情報では初回アプリログインに ID／パスワードに加え OTP が必要で、公式案内では Android 11 以上が現行サポート対象である。
- [MyJCB 対象カード](https://www.jcb.co.jp/myjcb/pop/available-card-list.html) は原則として番号先頭が 354、355、3573 のカード。ただし一部デビット、提携、法人カードは除外される。番号を収集して適合判定せず、既存 MyJCB 表示と発行会社名で確認する。

### ID、ルートカード、追加カード

- [おまとめログイン](https://www.jcb.co.jp/myjcb/pop/omatome-login.html) は、一つの ID でログイン後、再認証せず別 ID のカード表示へ切り替える機能である。各カードの ID／パスワードは残り、カードごとの明細・利用可能額を別々に表示する。
- 家族カードはおまとめログイン不可。JCB グループ発行カード同士は原則対象だが、デビットは「同一発行会社のデビット／クレジット」または「株式会社ジェーシービー発行のクレジット」との組み合わせに制限される。異なる発行会社のデビット同士（例: みずほと京都銀行）は結合できるとみなさない。セキュリティ判断や契約状態で切替不可になることもある。
- 本会員の[明細の見方](https://www.jcb.co.jp/usage/structure/check/index.html)では、カード番号・カード名称・氏名・小計をカード別に表示し、ETC はカード別、複数 QUICPay は商品別に表示する。QUICPay 搭載型は親カード利用として摘要に表示される場合がある。
- [家族カード公式案内](https://www.jcb.co.jp/ordercard/family_card/family_card.html)では、家族利用分は本会員の支払口座に合算され、本会員の明細に掲載される。家族 ID を root として重複取得せず、本会員明細の `ご利用者`／カード区分を subcard の境界にする。
- 保存用の ID はローカル生成 UUID とする。MyJCB ID、カード番号／下 4 桁、氏名をキー・ログ・メトリクスにしない。カード名称も一般商品名（例: `JCB W`）だけを allowlist し、個人化表示は捨てる。

## 対象カード別の経路と発行会社差

| 対象 | 明細の主経路 | 追加カード／支払 | ポイント・特典経路 | おまとめ上の注意 | 推奨取得 |
|---|---|---|---|---|---|
| JCB W | MyJCB Web／アプリ | クレジット。家族・ETC・QUICPay を親明細内で識別 | [JCB W](https://www.jcb.co.jp/ordercard/kojin_card/os_card_w2.html)は 200 円につき 2 J-POINT。MyJCB／確定明細で残高・失効等を確認 | JCB 発行のルート ID。ナンバーレスの初期登録・番号確認はアプリだが、明細取得は Web 可 | 確定 CSV／OFX 月次。未確定が必要な場合だけ Web 表示 |
| リクルートカード（JCB） | [リクルートカード利用案内](https://recruit-card.jp/guide/)から JCB 会員ページ＝MyJCB | 本会員明細に家族利用を合算 | 通常還元 1.2%。[JCB 公式ポイント案内](https://www.jcb.co.jp/myjcb/pop/recruit-point.html)上、リクルートポイントは J-POINT ではなく、残高照会はリクルート側マイページ。MyJCB だけでは完結しない | JCB 版のみ。Visa／Mastercard は別 backend。JCB 発行カードとして候補だが、既存おまとめ状態は live で確認する | 明細は MyJCB。ポイントは別 connection とし、混ぜない |
| みずほ JCB デビット | MyJCB、または [みずほ Wallet](https://www.faq.mizuhobank.co.jp/faq/show/3774?site_domain=default) | 即時引落、一回払いのみ。家族カード最大 8 枚、親口座に合算 | [みずほ公式](https://www.mizuhobank.co.jp/jcbdebit/info/index.html)では J-POINT でなく利用額帯別 0.2–0.4% の口座キャッシュバック。Wallet に次回率表示 | みずほ **Smart Debit** とは別商品。Smart Debit はおまとめ・パスキー等の公式除外あり。通常のみずほ JCB デビットまで除外と一般化しない | MyJCB デビット明細＋差額明細。銀行残高は対象外 |
| 京銀 JCB デビット | [京都銀行公式](https://www.kyotobank.co.jp/kojin/jcbdebit/)から MyJCB（京銀アプリは deep link） | 即時引落、一回払いのみ。家族カードあり、ETC なし | 200 円で 1 J-POINT。MyJCB でポイント照会。2026 年に Oki Doki から J-POINT へ移行 | 京都銀行は [JCB グループ一覧](https://www.jcb.co.jp/pop/group-list.html)に掲載。ただし MyJCB の口座残高表示サービスは京都銀行／京銀カードサービスを明示除外 | MyJCB デビット明細＋差額明細。銀行残高は対象外 |

カード名だけで issuer を推定しない。カード裏面表示／MyJCB の一般化された発行会社名を利用者が確認し、実値は記録しない。おまとめ済みのカード一覧を read-only に列挙し、未設定カードを collector が追加してはならない。

## 明細の状態、粒度、期間、export

### クレジット明細

- [照会期間拡大の公式案内](https://www.jcb.co.jp/release/myjcb-statement.html)は、未確定 1–2 か月＋確定 1–15 か月、合計最長 17 か月を対象とする。登録時期、利用なし、カード切替等により 7–15 か月しかない場合がある。
- [明細の見方](https://www.jcb.co.jp/usage/structure/check/index.html)では、確定分最長 15 か月を PDF／CSV／OFX でダウンロードでき、未確定は毎月 24 日前後の確定後にのみ download 可。画面は加盟店から JCB に到着した売上データを反映し、到着遅延で翌月以降になる場合がある。
- [CSV 注意事項](https://www.jcb.co.jp/processing/share/csv.html)では、本会員のみ、請求月ごと、確定分のみ。リボ／分割は月々の支払額と新規利用額の双方を含み、原則前日 20:00 までの変更・訂正を反映する。加盟店文字列は切断・文字化けし得る。
- 公式の固定最大行数は確認できない。件数制限を仮定せず、一請求月を一取得単位とし、ファイル末尾・合計・HTTP 完了を検証する。15 か月を超える再取得ができないため、月次で確定ファイルを保存する。
- 最小粒度は、利用日、利用者／カード区分、加盟店、金額、支払方法、摘要・備考。海外は現地通貨額・換算レート・換算日、分割は回数、リボ／キャッシングは種別を持つ。利用可能枠、利用残高、今後 12 か月の分割等の支払予定は別 snapshot であり、取引行と混ぜない。
- 取消／返金は元明細を書き換えるだけとは限らない。[公式説明](https://www.jcb.co.jp/usage/structure/check/index.html)は、取消を表す負額行と「お支払済み分 ご返金額」の行が同時に出る例を示す。加盟店文字列だけで重複排除せず、root/subcard、状態、利用日、金額、支払種別、摘要、同一月内 ordinal を組み合わせる。
- 未確定は可変 snapshot とし、確定データへ昇格させる。未確定行を確定行と同じ恒久 ID で上書きせず、照合結果を保持する。

### デビット明細

- JCB デビットは口座から即時に保留／引落されても、売上確定額、取消、為替等で後日差額が発生する。[JCB デビット規約雛形](https://www.jcb.co.jp/apl/pdf/guest/entry/agree/member/jcb_meigin_db_P1.pdf)は、保留額より売上確定額が少ない場合の返金、加盟店取消後の後日返金を規定する。
- MyJCB のデビット画面には通常明細に加えて「JCB デビット差額取引分・その他ご利用明細」がある。みずほ向け[明細の見方](https://www.jcb.co.jp/myjcb/pop/offlinedebit_meisai_mizuhobk.html)と京銀の[利用ガイド](https://www.kyotobank.co.jp/kojin/jcbdebit/pdf/jcbdebit_guide.pdf)を参照する。
- 2026 年の公開実装が観測した HTML 列は、通常側が `ご利用者／お振替日／ご利用先など／お振替金額／摘要／承認番号`、差額側が `ご利用者／差額発生日／ご利用先など／差額／摘要／お取引結果／承認番号`。これは第三者観測であり公式スキーマではない。
- `銀行振替済` 以外の差額行は進行中として恒久取引へ入れない、という第三者実装の扱いは妥当な保守策だが、公式の全状態一覧は未確認。read-only live 検証で状態集合を匿名化して確認するまでは未知値で停止する。

## 認証、MFA、端末、passkey、Bitwarden

### 確認済み事実

- 標準 Web はカード別の MyJCB ID／パスワードを使用する。[登録方法](https://www.jcb.co.jp/myjcb/how-to-use/)は 6–20 文字とし、普段と異なる環境では[秘密の合い言葉](https://www.jcb.co.jp/myjcb/pop/secret-qa.html)を要求し得る。忘れた場合は登録 SMS／メールへの MyJCB OTP 経路がある。
- アプリ初回は ID／パスワードに加え OTP。以後の指紋／顔／アプリ専用パスコードはアプリの簡単ログインであり、Web の passkey と同一とはみなさない。
- [MyJCB passkey](https://www.jcb.co.jp/myjcb/how-to-use/passkey/) は Web／アプリで利用でき、端末の生体、PIN、パターン等で認証する。登録後はその ID で ID／パスワードログインが使えない。別端末は passkey 保有端末による QR 読取を使い、場合により Bluetooth が必要。登録時に OTP または本人確認書類撮影が入る場合がある。
- passkey の対象は 354 系個人クレジット、条件付き 355、357 系個人デビット等と JCB グループ／一部パートナー発行会社。みずほ Smart Debit は明示除外だが、通常のみずほ JCB デビットまで除外とは書かれていない。
- 生体情報は MyJCB に送信・保存されない。鍵は端末内またはクラウド同期可能。公式例は iCloud キーチェーンと Google パスワードマネージャー。長期間不使用で passkey が解除される場合があり、MyJCB 側で解除しても端末側鍵は残る。
- J/Secure の OTP／MyJCB アプリ認証はオンライン購入の 3-D Secure であり、read-only collector のログイン認証と混同しない。

### Bitwarden と自動化に関する推測

- **事実**: JCB は Bitwarden を対応・非対応のどちらとも記載せず、代表例として Apple／Google だけを挙げる。
- **推測**: WebAuthn 対応ブラウザと同期 passkey provider の組み合わせとして Bitwarden が動く可能性はあるが、JCB の issuer 別フロー、QR cross-device、アプリ内 WebView での互換性は未検証。対応済みと記録しない。
- **推測**: ID／パスワードは通常のブラウザ autocomplete の対象なので Bitwarden autofill が機能する可能性は高い。しかし passkey 登録済み ID ではパスワードログイン自体が無効で、headless secret injection の代替にはならない。
- collector は passkey の新規登録・解除、パスワード再設定、OTP 宛先変更を行わない。利用者が既に選んだ認証状態を尊重し、人の操作が必要なら停止する。

## Web 保護、WAF、Akamai

- 2026-08-26 の未認証 HEAD／DNS 観測では、公開コンテンツ `www.jcb.co.jp` は Cloudflare の CNAME／IP と `server: cloudflare`、`cf-ray` を返した。これは公開サイト edge の事実で、ログイン backend の認証方式を示さない。
- `my.jcb.co.jp/Login` は別 IP で `server: nginx`。`/apl/login-prot.js?init` は動的 cookie、`X-Ion-Hop: 1`、`Via: 1.1 google` を返し、公開実装は init script が示す async script も取得してフォーム保護値を生成する。製品名を示す公式表示はない。
- **Akamai は確認できなかった。** `www` は現在 Cloudflare で、認証 host から Akamai 固有と断定できる十分な証拠もない。`X-Ion-Hop` や動的 cookie だけから F5／Shape／Akamai 等の vendor を推定しない。
- protection script、cookie、要求ヘッダー、リダイレクト、未知の追加認証は変更可能である。403／429、チャレンジ、フォーム構造変更を bypass せず停止条件とする。

## 公開 third-party client の具体的実装

### 現行に近い実装

- [youseiushida/Okura](https://github.com/youseiushida/Okura) は AGPL-3.0 の公開実装で、2026-08-25 に更新されている。JCB adapter は Deno/TypeScript で、既定 origin を `https://my.jcb.co.jp` とする。
- transport/auth は次の通り。
  1. `GET /Login`。
  2. HTML から同一 origin の `/apl/login-prot.js?init...` を抽出し取得。
  3. init script から `/apl/login-prot.js?async...` を抽出し取得。
  4. 両 script を network permission なしの Worker／VM で限定 DOM と共に実行し、`userId`、`password`、`screenId`、`loginRouteId` と少なくとも 6 個の動的 field、cookie 更新を生成。
  5. `POST /iss-pc/member/user_manage/Login` (`application/x-www-form-urlencoded`)。Origin／Referer／browser User-Agent を固定し、同一 origin と期待 path を検証。
  6. `GET /iss-pc/member/mypage/mypage.html` で logout link と debit detail link を確認して session validation。Cookie と User-Agent を暗号化 vault に capture/restore 可能。
  7. `GET /iss-pc/member/debit/details/debitDetailMenu.html?link_id=myj_main_debitDetailMenu`、次いで `GET /iss-pc/member/debit/details/debitDetail.html?seq=N`。15 cycle を HTML parse する。
- この実装は **デビット画面専用**で、JCB W／リクルートカードのクレジット明細、確定 CSV／PDF／OFX、おまとめ ID 切替、passkey、秘密の合い言葉／OTP は実装していない。成功を公式保証や全 issuer 互換性の証拠にしない。

### 古い実装

- [takeruko/gas-myjcb-detail-checker](https://github.com/takeruko/gas-myjcb-detail-checker)（2015）は ID／パスワードを直接 POST し、Set-Cookie を再利用して月次 PDF／CSV を取得する Google Apps Script。現在の動的保護より前の path で、更新停止・ライセンス表示なし。さらにファイルを link editor 公開する設計のため再利用禁止。
- [swdyh/add-to-zaim](https://github.com/swdyh/add-to-zaim)（2013）はログイン済み MyJCB DOM の日付・金額・加盟店を XPath で抽出する Chrome extension。API ではなく画面依存で、現在の DOM 互換性はない。
- 公開実装群は、過去から一貫して「公開 API」ではなく cookie 付き HTML／export／DOM を利用してきたことを示す。

## APK と静的解析の将来方針

- APK は第三者ミラーから取得しない。必要になった場合のみ、管理下 Android 実機の Google Play から公式 package `jp.co.jcb.my` を取得し、split APK と署名証明書 digest、versionCode、取得日を機密を含まない manifest に記録する。
- 初期の静的解析は manifest、exported components、deep links、network security config、同梱ライブラリ、ホスト名、証明書 pinning の有無まで。文字列に token／鍵らしき値があっても使用・公開しない。
- 難読化解除、pinning 回避、runtime hook、root/jailbreak 検知回避、traffic MITM、端末 attest 回避は行わない。Web で対象情報が取得できるため、現時点で APK 解析の費用対効果は低い。

## read/write 隔離

read-only allowlist は、既存 session の検証、カード表示一覧、明細画面、ポイント残高／履歴、利用可能額／残高 snapshot、公式 export の取得だけとする。write 操作が同じ UI に隣接するため、URL だけでなく method、form action、期待 response type も allowlist する。

禁止する操作:

- おまとめログインの追加・解除、初期表示カード変更
- MyJチェック登録・解除
- リボ／分割／スキップへの変更、繰上返済、支払額変更、キャッシング
- 利用限度額、カードロック、通知、住所・電話・メール等の変更
- 家族／ETC／QUICPay 等の申込・解約、カード切替・再発行
- ポイント交換、MyJCB Pay、キャンペーン登録、J/Secure を伴う購入
- passkey 登録／解除、パスワード再設定、OTP 発行（read-only login continuation として利用者が明示操作する場合を除く）

`POST` は原則拒否する。唯一の候補であるログイン POST も、専用 origin・path、field allowlist、no-follow unexpected redirect、利用者が選んだ既存認証方式という条件で別コンポーネントに隔離する。export endpoint が POST の場合は、live 観測で副作用なしと確認するまで自動送信しない。

## 実行環境適性

| 環境 | 適性 | 理由 |
|---|---|---|
| Cloudflare Workers（fetch のみ） | 条件付き | 旧式な HTTP replay や確定 export 取得は可能だが、現行 protection JS は Node VM／Worker 相当の限定 DOM を要求し、秘密の合い言葉、OTP、passkey を完結できない。金融 session を edge KV やログへ置かない。 |
| Cloudflare Browser Run | 条件付き | [session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)と Durable Objects、Playwright/Puppeteer、人手介入が使えるため C 経路に合う。ただし session idle 終了、共有 browser の cookie 分離、passkey/QR、金融 PII の運用リスクがある。匿名 dev test 以外は第一候補にしない。 |
| Cloudflare Containers | 適 | [公式](https://developers.cloudflare.com/containers/)は Linux/amd64 の任意 runtime・filesystem を提供。Deno/Node parser、隔離 worker、browser を包装できる。cold start と instance lifecycle を跨ぐ session は外部暗号化 store が必要。 |
| OCI container | 適 | parser と browser を固定 digest の image に閉じ込められる。secret は image／環境変数に焼かず、実行時 secret store、tmpfs、egress allowlist を使う。 |
| Kubernetes | 過剰だが適 | [Kubernetes image](https://kubernetes.io/docs/concepts/containers/images/)で digest pin、Secret、NetworkPolicy、CronJob、専用 namespace を構成できる。少数カードには運用費が大きい。rootless、read-only FS、ephemeral volume、1 connection/Pod を推奨。 |
| 管理下 Android 実機 | 技術的に可・非推奨 | app-only の初期登録、OTP、passkey／生体には最も適するが、D/cost 5。端末拘束、画面変更、attestation、通知誤操作、write UI 隣接の危険が大きい。 |

どの cloud runtime でも、session／cookie／OTP／明細実値を application log、trace、crash dump、analytics に出さない。issuer／product も必要最小限の一般名だけを tag にする。

## 共通 rubric による評価

定義は PR #5 `docs/source-research.md` をそのまま使用する。

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| 経路 | Level | Cost | 判断 |
|---|---:|---:|---|
| 確定 PDF／CSV／OFX を人が月次 download、offline import | E | 1 | 公式 export だが手動。最も安全。15 か月 retention のため月次保存が必要。 |
| 既存 Web session から確定 export を自動 download | C | 3 | session bootstrap 後の replay は plausible。export endpoint とカード切替は live 確認が必要。 |
| クレジット未確定明細（JCB W／Recruit JCB）HTML | C | 4 | export 不可、可変 DOM、カード切替・追加認証・保護 script 依存。 |
| みずほ／京銀 JCB デビット HTML＋差額明細 | C | 4 | 公開実装が transport を具体化したが、issuer・passkey・追加認証互換は未確認。 |
| Recruit ポイント残高／履歴 | C | 4 | MyJCB ではなく Recruit 側 session。別 source として評価・実装する。 |
| MyJCB アプリ／銀行アプリ UI 自動化 | D | 5 | OTP、生体／passkey、端末、app version、write UI に拘束。 |
| MyJCB family 全体の既定 | **C** | **4** | API ではないが Web bootstrap＋session replay が具体的に plausible。運用上の safe default は E/cost 1。 |

A は公開 API がないため不適、B は非公式 HTML と動的 login protection を「stable internal API」と呼べないため不適。passkey 登録済み ID、未知 challenge、issuer 非対応では C が成立せず、その connection だけ D/E へ downgrade する。

## read-only live 検証計画

実値を保存しない一回限りの対話検証。最初は test fixture ではなく利用者の既存状態を読むが、画面・HAR・HTML・ログを保存しない。

1. `www` ではなく公式 `my.jcb.co.jp` であること、TLS、ログイン画面、認証方式（password/passkey）だけを確認。
2. 利用者が既存方式でログイン。OTP、秘密の合い言葉、passkey/QR が出たら自動入力せず人へ handoff。
3. おまとめ済み表示の一般商品名と issuer、切替可否だけを確認。ID、カード番号、氏名、額を読み上げ・記録しない。未設定カードを追加しない。
4. 各 root で本会員／家族／ETC／QUICPay の表示境界、カード別小計の有無を確認。匿名の `root/subcard/type` schema にのみ反映。
5. クレジットで未確定と確定の月数、月次 export に PDF／CSV／OFX が出るか、family ID で download 不可かを確認。ファイルは一時領域に一件だけ保存し、列名・encoding・行数の型だけ検証後に削除。
6. デビットで通常／差額の section、状態ラベル集合、負額 refund、承認番号有無を型として確認。実値は memory 外へ出さない。
7. JCB W の J-POINT、Recruit の別ポイント導線、みずほ cash back、京銀 J-POINT が source ごとに分離されることを確認。交換・使用画面へ進まない。
8. network は DevTools の request method、origin、path template、status、Content-Type、cookie expiry 属性だけを redacted 集計。request/response body、query 実値、headers、HAR は保存しない。
9. logout は公式 read-only session 終了操作として明示的に行い、一時 file、browser profile、cookie snapshot を破棄。

### stop 条件

以下の一つでも発生したら、その場で自動処理を中止する。

- OTP、秘密の合い言葉、passkey 生体／PIN、QR、本人確認書類、CAPTCHA、risk challenge
- 新規登録、規約同意、passkey 登録／解除、password reset、端末登録を要求
- 支払、申込、限度額、カードロック、ポイント使用、キャンペーン等の write CTA／確認画面
- 期待 allowlist 外の POST／PUT／PATCH／DELETE、cross-origin redirect、未知 download action
- 401／403／409／423／429、ロック・不正検知・アクセス制限警告、連続 login failure
- DOM／CSV schema、issuer、カード切替規則、デビット状態が未知
- PII、カード番号、金額、加盟店、cookie、token、OTP が log／trace／screenshot に出そうになる
- 同一取得の retry が duplicate write または account risk を生み得る不確実状態

## 未確認事項

- 実インベントリ各カードの正確な発行会社表示と、JCB W／Recruit JCB／みずほ JCB デビット／京銀 JCB デビット間で現在設定済みのおまとめ切替グラフ。
- みずほ JCB デビットと京銀 JCB デビットで passkey が実際に提示されるか、Bitwarden passkey が Web／アプリで動作するか。
- クレジット側の現行 internal path、export request method、CSRF、cookie TTL、session の実寿命、おまとめ切替 transport。
- 公式 export のカード別列、OFX の fitid、CSV encoding、行数上限、ゼロ件月の response。
- デビット差額明細の公式な全状態一覧と、負額・取消・cashback の issuer 別表現。
- 公開実装 Okura が本番の各 issuer／passkey 未登録 ID で成功しているか。コードの新しさは live 成功の証明ではない。
- 認証 host の WAF／bot-management vendor。Cloudflare は公開 `www` で確認したが、`my` の製品名と Akamai 利用は未確認。
