# MyJCB カードファミリー調査

- 調査日: 2026-08-26（Australia/Sydney）
- 対象: 同一の MyJCB／関連バックエンドで参照できる個人カード群。現インベントリでは JCB W、リクルートカード（JCB）、みずほ JCB デビット、京銀 JCB デビットを中心とする。
- 対象外: Visa／Mastercard 版リクルートカード、JCB ブランドでも MyJCB 非対応のカード、銀行口座そのものの入出金明細、カード申込・支払・設定変更などの write 操作。
- 調査制約: 2026-08-26 の初期調査は未ログインの公式公開情報、公開レスポンス、公開コードだけを使用した。2026-08-31 に利用者が専用 Kuebiko Chrome で第一の MyJCB ID へ通常の passkey login を行い、read-only route と response schema／format を sanitization して追記した。口座 ID、MyJCB ID、カード番号、氏名、残高、利用額、加盟店、Cookie、WebAuthn assertion、OTP、秘密の合い言葉等の実値は Git／公開文書へ保存していない。

## 結論

MyJCB はアプリ専用ではなく、Web 版が明細・利用可能額・ポイント・カード情報の基本面を持つ。確定明細は最長 15 か月を PDF／CSV／OFX で月単位にダウンロードでき、未確定を含む画面照会は最長 17 か月である。未確定明細は export できず、確定後（毎月 24 日前後）に取得可能となる。公開された固定の最大行数は見つからなかった。

複数カードは「一つのアカウントにカードを追加」する模型ではない。カードごとに MyJCB ID があり、許可された組み合わせだけを「おまとめログイン」で相互に切り替える。本会員の明細内には家族、ETC、QUICPay 等の追加カード利用がカード単位でまとまる一方、家族カード ID はおまとめ対象外で、家族会員 ID から PDF／CSV をダウンロードできない。したがって、データ模型は `MyJCB ID に対応するルートカード` と `その明細内の追加カード` を分ける必要がある。

公式の口座・明細 API は公開されていない。2026 年に更新された第三者実装は、Web の動的ログイン保護 JavaScript を隔離実行して ID／パスワードのフォームを POST し、Cookie と User-Agent を再利用して JCB デビット明細の HTML を GET する。実装可能性は示すが、非公式 HTML、動的保護、秘密の合い言葉／OTP／パスキー、発行会社差に依存するため、共通 rubric は **C、cost 4** とする。安全な既定値は確定明細の手動 export で **E、cost 1**。full app UI automation は **D、cost 5** だが、公式 APK の静的解析、deobfuscation、本人操作中の read-only runtime tracing／通信観測は transport と issuer 差を特定する有効な調査段階であり、一律に除外しない。

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

対象カードごとの passkey 境界は次のとおり。カード番号自体は取得せず、既存画面が passkey を提示するかで最終確認する。

| 対象 | 公式条件との関係 | 現時点の判定 |
|---|---|---|
| JCB W | 354 系個人クレジット/JCB 発行の通常対象と整合 | 対象候補。既存 ID の提示で確認 |
| リクルートカード（JCB） | JCB 発行・番号/契約条件を満たす場合に対象 | 商品名だけでは確定しない。Visa/Mastercard は完全に別 |
| みずほ JCB デビット | 357 系個人デビット条件と整合。公式除外は「みずほ Smart Debit」で、通常 JCB デビットを一括除外していない | 対象候補だが issuer 実画面で未確認 |
| 京銀 JCB デビット | 357 系個人デビットかつ京都銀行は JCB group issuer 一覧に掲載、明示除外なし | 対象候補だが issuer 実画面で未確認 |

passkey 登録済み ID は password login を使えないため、Okura の ID/password flow と排他的になり得る。おまとめ済み複数 ID のうち一つだけ passkey の場合、root login、切替先、再認証要求の組合せを live で確認し、全カードへ一般化しない。

### Bitwarden と自動化に関する推測

- **事実**: JCB は Bitwarden を対応・非対応のどちらとも記載せず、代表例として Apple／Google だけを挙げる。
- **推測**: WebAuthn 対応ブラウザと同期 passkey provider の組み合わせとして Bitwarden が動く可能性はあるが、JCB の issuer 別フロー、QR cross-device、アプリ内 WebView での互換性は未検証。対応済みと記録しない。
- **推測**: ID／パスワードは通常のブラウザ autocomplete の対象なので Bitwarden autofill が機能する可能性は高い。しかし passkey 登録済み ID ではパスワードログイン自体が無効で、headless secret injection の代替にはならない。
- collector は passkey の新規登録・解除、パスワード再設定、OTP 宛先変更を行わない。利用者が既に選んだ認証状態を尊重し、人の操作が必要なら停止する。

## Web 保護、WAF、Akamai

- 2026-08-26 の未認証 HEAD／DNS 観測では、公開コンテンツ `www.jcb.co.jp` は Cloudflare の CNAME／IP と `server: cloudflare`、`cf-ray` を返した。これは公開サイト edge の事実で、ログイン backend の認証方式を示さない。
- `my.jcb.co.jp/Login` は別 IP で `server: nginx`。2026-08-26 の公開 GET は `200`、HTML は Windows-31J、login form は `POST /iss-pc/member/user_manage/Login`、static field は `userId`、`password`、`screenId=0102001`、`loginRouteId=0102001` だった。passkey 用 JavaScript も同じ未認証 HTML から読み込まれる。
- login HTML は `/apl/login-prot.js?init` を最初に load する。今回の init response は約 22 KB、`no-cache/no-store`、`X-Ion-Hop: 1`、`Via: 1.1 google` と JCB domain cookie を返し、query に一時 seed を含む `/apl/login-prot.js?async...` を追加 load した。async response は約 303 KB だった。seed、cookie、生成 field の実値は記録していない。
- init script の公開内容は対象 origin/path の POST を instrument し、async script の初期化後に form submit を処理する構造と整合する。Okura は init/async の両方と cookie を同一 HTTP session で取得し、限定 DOM 内で実行して form action/body と cookie update を得る。動的 field は少なくとも 6 種あることだけを検証し、field 名・値を固定仕様とみなしていない。
- **Akamai は確認できなかった。** `www` は現在 Cloudflare で、認証 host から Akamai 固有と断定できる十分な証拠もない。`X-Ion-Hop` や動的 cookie だけから F5／Shape／Akamai 等の vendor を推定しない。
- protection script、cookie、要求ヘッダー、リダイレクト、未知の追加認証は変更可能である。403／429、チャレンジ、フォーム構造変更を bypass せず停止条件とする。公開 script の整形・deobfuscation、control-flow/DOM/API dependency の静的把握は許可するが、bot 判定値の改変や security control の無効化には使わない。

## 公開 third-party client の具体的実装

### 現行に近い実装

- [youseiushida/Okura](https://github.com/youseiushida/Okura) は AGPL-3.0 の公開実装で、調査時点の main は commit [`afc6057f`](https://github.com/youseiushida/Okura/commit/afc6057fba78b5bfd6364654548fbfd91c76692a)（2026-08-25）である。JCB adapter は Deno/TypeScript で、既定 origin を `https://my.jcb.co.jp` とする。
- 根拠 code は [`login.ts`](https://github.com/youseiushida/Okura/blob/afc6057fba78b5bfd6364654548fbfd91c76692a/app/internal/adapter/jcb/login.ts)、[`protection_runtime.js`](https://github.com/youseiushida/Okura/blob/afc6057fba78b5bfd6364654548fbfd91c76692a/app/internal/adapter/jcb/protection_runtime.js)、[`authentication.ts`](https://github.com/youseiushida/Okura/blob/afc6057fba78b5bfd6364654548fbfd91c76692a/app/internal/adapter/jcb/authentication.ts)、[`adapter.ts`](https://github.com/youseiushida/Okura/blob/afc6057fba78b5bfd6364654548fbfd91c76692a/app/internal/adapter/jcb/adapter.ts) である。
- transport/auth は次の通り。
  1. `GET /Login`。
  2. HTML から同一 origin の `/apl/login-prot.js?init...` を抽出し、同じ cookie jar と browser User-Agent で取得。
  3. init script が動的に示す `/apl/login-prot.js?async...` を同じ session で取得。
  4. 両 script を Deno permission `none` の Worker 内で Node `vm` と限定 DOM により実行する。runtime は `navigator.userAgent`、screen、Web Crypto、document cookie、form/event API 等を提供する一方、host network/file/env permission を与えない。
  5. script が submit した form から `userId`、`password`、`screenId`、`loginRouteId`、少なくとも 6 個の動的 field、cookie update を回収。action が同一 origin の login path であることと、credential が改変されていないことを検証する。
  6. `POST /iss-pc/member/user_manage/Login` (`application/x-www-form-urlencoded`)。Origin／Referer／生成時と同じ User-Agent を付け、MyJCB mypage 以外への response を拒否する。
  7. `GET /iss-pc/member/mypage/mypage.html` で logout link と debit detail link を確認して session validation。
  8. validation 後だけ、cookie の name/value/domain/path/expiry/security 属性と User-Agent を session snapshot として capture/restore する。restore 後は mypage GET で再検証し、expired/unexpected/403 を同一視しない。
  9. `GET /iss-pc/member/debit/details/debitDetailMenu.html?link_id=myj_main_debitDetailMenu`、次いで `GET /iss-pc/member/debit/details/debitDetail.html?seq=N`。15 cycle を HTML parse する。
- この実装は **デビット画面専用**で、JCB W／リクルートカードのクレジット明細、確定 CSV／PDF／OFX、おまとめ ID 切替、passkey、秘密の合い言葉／OTP は実装していない。成功を公式保証や全 issuer 互換性の証拠にしない。
- Okura の authenticated-session validator は logout link と`toNaviDebitDetailMenu`を成功条件に含むため、credit-only valid sessionを失敗扱いにする。クレジット専用 ID の validator としてそのまま一般化できない。また protection runtime は Deno Worker の隔離に加えて`node:vm`と手製 DOM shim を使う。[Cloudflare公式のNode.js compatibility表](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#non-functional-stub-modules)では`node:vm`はimportできてもunderlying APIが動作しないnon-functional stubである。したがってplain Workerへそのまま移植できず、本PoCは公式pageをBrowser Runで実行し、必要時のみContainerを検討する境界を選んだ。
- Okura に refresh/renew endpoint はない。cookie＋User-Agent を再利用できる間だけ session を restore し、失効時は再 login が必要である。login protection の動的 field を CSRF token と断定せず、post-login form の hidden token/local state も snapshot していない。

### 古い実装

- [takeruko/gas-myjcb-detail-checker](https://github.com/takeruko/gas-myjcb-detail-checker)（2015）は ID／パスワードを直接 POST し、Set-Cookie を再利用して月次 PDF／CSV を取得する Google Apps Script。現在の動的保護より前の path で、更新停止・ライセンス表示なし。さらにファイルを link editor 公開する設計のため再利用禁止。
- [swdyh/add-to-zaim](https://github.com/swdyh/add-to-zaim)（2013）はログイン済み MyJCB DOM の日付・金額・加盟店を XPath で抽出する Chrome extension。API ではなく画面依存で、現在の DOM 互換性はない。
- 公開実装群は、過去から一貫して「公開 API」ではなく cookie 付き HTML／export／DOM を利用してきたことを示す。

### read/export/おまとめ切替の transport 候補

| 機能 | 現時点の具体的候補 | 確度と次の確認 |
|---|---|---|
| デビット read | Okura の `debitDetailMenu.html?link_id=...` → `debitDetail.html?seq=N` | 現行公開 code。みずほ/京銀 issuer と passkey 未登録 ID での live 成功は未確認 |
| クレジット read | `/iss-pc/member/details_inquiry/detailMenu.html?link_id=...` → `detail.html?detailMonth=N&output=web` | 2026-08-31 の本人操作で現行 GET を確認。初期 HTML は `0..8`、過去月 API は `9..17` のうち account ごとの available 月だけを返した |
| 過去月 availability | `POST /iss-pc/general_json/member/details_inquiry/detailPastJson.json` | `detailAPI.js` と本人操作で JSON-RPC contract を確認。hidden discriminator 欠落／API failure では停止し、blind scan しない |
| PDF export | `/iss-pc/member/details_inquiry/detailDbPdf.html?detailMonth=N&output=pdf` | 2026-08-31 に確定月の GET と `%PDF-1.4` signature を確認。`detailNewspdf.html` は notice であり statement ではない |
| CSV export | `detail.html?detailMonth=N&output=csv` | 2026-08-31 に GET、Windows-31J/CP932、metadata 行後の exact 12-column header を確認 |
| OFX export | `detail.html?detailMonth=N&output=money` | 2026-08-31 に GET、OFX 1.x credit-card statement group を確認 |
| おまとめ済みカード列挙 | mypage の「ID切替」→表示カード切替画面 | 公式 UI の存在は確認済み。カード名/ID/番号を保存せず route と一般 issuer/type だけ確認 |
| おまとめ済み ID 切替 | 既存切替画面の card-select action | 金融取引ではなく session の current-card context 変更候補。method、hidden field、CSRF、戻り先を確認してから 1 回だけ replay |
| おまとめ設定追加/解除・初期表示変更 | 設定画面 | write。transport 調査で見えても呼ばない |

クレジット read/export path は 2026-08-31 に current contract として再確認した。確認は第一 ID の一時点に限るため、別 issuer／ID では link、schema、export control を毎回検査する。`detailMonth` は HTML／availability API に実在する値だけを取得し、card selector や financial value は公開記録へ保存しない。

### CSRF と session renewal の確認点

- login の 6 個以上の動的 field は protection script が生成するが、用途は公開されていない。CSRF、bot signal、integrity data のどれかに決め打ちしない。
- クレジット CSV／PDF／OFX は現行 GET と確認した。ID 切替など未確認 POST は、hidden input/header/cookie の **存在、名称の hash、長さ、rotation timing** だけを確認し、値は保存しない。GET でも state-changing action と同じ token を共有する場合は replay を止める。
- cookie snapshot は authenticated validation 後に限定し、User-Agent を必ず対で再利用する。Okura の固定 Chrome 140 UA は将来古くなるため、保護 script を生成した実 browser/approved UA との一致を live で検証する。
- cookie の Expires/Max-Age、idle timeout、absolute timeout、ID切替前後の cookie rotation、logout 後の invalidation を metadata として確認する。protection cookie の長い Max-Age を authenticated session 寿命とみなさない。
- refresh/renew endpoint は未発見。自動的な silent renewal を仮定せず、session expiry は user-assisted reauthentication とする。passkey 登録済み ID では password replay を試さず、既存 browser/app bootstrap から session capture できるかだけを検討する。

## 公式 APK の入手・静的解析・runtime tracing

[Google Play の公式 listing](https://play.google.com/store/apps/details?id=jp.co.jcb.my) は package `jp.co.jcb.my`、JCB 公式 app、2026-07-27 更新、version 3.11.1 を示す。今回の環境には ADB と owner-controlled Android 実機がなく、Google Play が配布する正規 split APK/app bundle を取得できなかった。third-party mirror で代替せず、binary artifact 未取得のまま manifest/host/pinning を確定しない。

正規 artifact を得られる次の実験は次のとおり。

1. 管理下 Android 実機で Google Play の developer/package 表示を確認して app を install/update する。
2. read-only に `adb shell pm path jp.co.jcb.my` で base/split package path を列挙し、所有者の許可した解析 host へ pull する。APK、signing certificate、各 split の SHA-256、versionName/versionCode、取得日時だけを evidence manifest に残す。
3. `apksigner verify --print-certs`、`apkanalyzer manifest print`/`aapt2 dump` で署名、SDK、permission、exported component、deep link、provider/service/receiver、`android:networkSecurityConfig`、debuggable/backup flag を確認する。
4. `jadx --deobf`、resource table、native library symbol/string を使い、難読化された class 名を読みやすい局所名に変換しつつ、official host、WebView route、OkHttp/Retrofit 等の transport、request/response model、Room/SQLite schema、export model、issuer feature flag を特定する。deobfuscation 自体は許可する。
5. `network_security_config.xml`、`CertificatePinner`/TrustManager/hostname verifier、Play Integrity/attestation API、root/hook detection の **存在と call site** を記録する。pinning/attestation の無効化、return 値改変、検知回避は行わない。

本人が通常操作する一回限りの read-only runtime tracing も調査対象とする。

- Android Studio profiler/Network Inspector が正規 app に attach できる場合、process/thread/class/method、host、HTTP method、path template、status、content-type、schema field 名の hash だけを観測する。
- attach 可能な Java/native method hook は、read path の呼出しと引数/戻り値の **型・長さ・field 名** だけを記録し、値を保存せず、return 値や control flow を変更しない。hook のために root、debug flag 改変、anti-hook/Integrity 回避が必要なら停止する。
- app が user-installed CA を通常設定として信頼する場合だけ、owner-controlled proxy で redacted HTTPS metadata を観測できる。certificate pinning が拒否した場合は bypass せず、DNS/SNI/IP/TLS timing 等の暗号化外 metadata と静的 call graph に戻る。
- logcat、crash dump、screenshot、HAR/pcap、analytics export は secret/PII/実明細を含み得るため原則保存しない。必要な route/schema metadata はその場で redact し、raw artifact を破棄する。

静的解析と no-op tracing の目的は Web と app の host/schema/issuer 差、passkey bootstrap、カード切替、read/export route を特定することにある。write endpoint を実行せず、security control を bypass しない範囲では、Web で取得可能という理由だけで費用対効果を低いと決めない。

## read/write 隔離

read-only allowlist は、既存 session の検証、カード表示一覧、明細画面、ポイント残高／履歴、利用可能額／残高 snapshot、公式 export の取得、おまとめ設定済みカード間の一時的な表示切替だけとする。write 操作が同じ UI に隣接するため、URL だけでなく method、form action、field 名、期待 response type、遷移後 page class も allowlist する。

禁止する操作:

- おまとめログインの追加・解除、初期表示カード変更
- MyJチェック登録・解除
- リボ／分割／スキップへの変更、繰上返済、支払額変更、キャッシング
- 利用限度額、カードロック、通知、住所・電話・メール等の変更
- 家族／ETC／QUICPay 等の申込・解約、カード切替・再発行
- ポイント交換、MyJCB Pay、キャンペーン登録、J/Secure を伴う購入
- passkey 登録／解除、パスワード再設定、OTP 発行（read-only login continuation として利用者が明示操作する場合を除く）

HTTP method だけで read/write を決めない。login POST、公式 export POST、既存おまとめ ID の表示切替 POST は read-only workflow の候補になり得るが、専用 origin/path、field allowlist、CSRF/session state、expected redirect/response、no-follow unexpected redirect を本人操作の観測で確定してから別コンポーネントに隔離する。おまとめ **設定** の追加/解除や初期表示変更とは route/action を分ける。semantics 未確認の POST／PUT／PATCH／DELETE は拒否する。

## 実行環境適性

| 環境 | 適性 | 理由 |
|---|---|---|
| Cloudflare Workers（fetch のみ） | 条件付き | 旧式な HTTP replay や確定 export 取得は可能だが、現行 protection JS は Node VM／Worker 相当の限定 DOM を要求し、秘密の合い言葉、OTP、passkey を完結できない。金融 session を edge KV やログへ置かない。 |
| Cloudflare Browser Run | 条件付き | [session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)と Durable Objects、Playwright/Puppeteer、人手介入が使えるため C 経路に合う。ただし session idle 終了、共有 browser の cookie 分離、passkey/QR、金融 PII の運用リスクがある。匿名 dev test 以外は第一候補にしない。 |
| Cloudflare Containers | 適 | [公式](https://developers.cloudflare.com/containers/)は Linux/amd64 の任意 runtime・filesystem を提供。Deno/Node parser、隔離 worker、browser を包装できる。cold start と instance lifecycle を跨ぐ session は外部暗号化 store が必要。 |
| OCI container | 適 | parser と browser を固定 digest の image に閉じ込められる。secret は image／環境変数に焼かず、実行時 secret store、tmpfs、egress allowlist を使う。 |
| Kubernetes | 過剰だが適 | [Kubernetes image](https://kubernetes.io/docs/concepts/containers/images/)で digest pin、Secret、NetworkPolicy、CronJob、専用 namespace を構成できる。少数カードには運用費が大きい。rootless、read-only FS、ephemeral volume、1 connection/Pod を推奨。 |
| 管理下 Android 実機 | 調査に適、full UI automation は高コスト | 正規 APK 取得、manifest/host/schema 静的解析、本人操作の read-only tracing、passkey/issuer 境界確認に適する。定常 UI automation は端末拘束、画面変更、attestation、write UI 隣接により D/cost 5。 |

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

公開 login JS/公式 APK の静的解析と本人操作中の redacted tracing は acquisition route ではなく、C candidate を判定するための実験なので A–E level を別途付けない。これらを実施しても transport/session の安定性が確認できなければ、source 評価は変えない。

## read-only live 検証計画

実値を保存しない一回限りの対話検証。最初は test fixture ではなく利用者の既存状態を読むが、画面・HAR・HTML・ログを保存しない。

1. `www` ではなく公式 `my.jcb.co.jp` であること、TLS、ログイン画面、認証方式（password/passkey）だけを確認。
2. 利用者が既存方式でログイン。OTP、秘密の合い言葉、passkey/QR が出たら自動入力せず人へ handoff。
3. おまとめ済み表示の一般商品名と issuer、切替可否だけを確認。ID、カード番号、氏名、額を読み上げ・記録しない。未設定カードを追加しない。
4. 各 root で本会員／家族／ETC／QUICPay の表示境界、カード別小計の有無を確認。匿名の `root/subcard/type` schema にのみ反映。
5. クレジットで未確定と確定の月数、月次 export に PDF／CSV／OFX が出るか、family ID で download 不可かを確認。ファイルは一時領域に一件だけ保存し、列名・encoding・行数の型だけ検証後に削除。
6. デビットで通常／差額の section、状態ラベル集合、負額 refund、承認番号有無を型として確認。実値は memory 外へ出さない。
7. JCB W の J-POINT、Recruit の別ポイント導線、みずほ cash back、京銀 J-POINT が source ごとに分離されることを確認。交換・使用画面へ進まない。
8. DevTools で login HTML → `login-prot.js?init` → `?async` → login form POST の順序を確認し、script hash/size、method、origin/path template、status、Content-Type、cookie 名の hash/属性、User-Agent 一致だけを集計。seed、dynamic field、body、cookie value は保存しない。
9. クレジット read、PDF/CSV/OFX export、デビット read、既存おまとめ ID 切替をそれぞれ一回だけ本人が操作し、method/path template、parameter 名と型、hidden/header token の有無・rotation、response type、cookie rotation を確認。おまとめ設定画面へは進まない。
10. session を閉じずに短時間再接続し、mypage validation と同一カード表示を確認する。idle/absolute timeout、refresh endpoint、silent renewal は観測された事実だけを記録し、失効時は再 login する。
11. 正規 APK を管理下実機から取得できる場合、署名/manifest/network config/host/schema/pinning/integrity call site を静的解析し、通常操作中の no-op hook または profiler で型・route metadata だけを観測。attach/pinning/attestation が拒否したら回避せず停止。
12. logout は公式 read-only session 終了操作として明示的に行い、一時 file、browser profile、cookie snapshot、APK 以外の raw trace を破棄。

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
- APK/runtime 観測に root/debug flag 改変、pinning/attestation/anti-hook 回避、return 値改変、decrypted raw traffic の保存が必要

## 未確認事項

- 実インベントリ各カードの正確な発行会社表示と、JCB W／Recruit JCB／みずほ JCB デビット／京銀 JCB デビット間で現在設定済みのおまとめ切替グラフ。
- みずほ JCB デビットと京銀 JCB デビットで passkey が実際に提示されるか、Bitwarden passkey が Web／アプリで動作するか。
- 別 issuer／ID でも同じ `details_inquiry` path、ledger DOM、PDF/CSV/OFX schema が使えるか。post-login cookie TTL、idle/absolute timeout、renewal、既存おまとめ ID 切替 transport。
- 公式 export のカード別列、OFX の fitid、行数上限、ゼロ件月の response。第一 ID の CSV encoding と 12 列 header は確認済み。
- デビット差額明細の公式な全状態一覧と、負額・取消・cashback の issuer 別表現。
- 公開実装 Okura が本番の各 issuer／passkey 未登録 ID で成功しているか。コードの新しさは live 成功の証明ではない。
- 認証 host の WAF／bot-management vendor。Cloudflare は公開 `www` で確認したが、`my` の製品名と Akamai 利用は未確認。
- 公式 version 3.11.1 APK の signing certificate、manifest、host、network security config、app schema、pinning/Integrity 実装。現環境では正規 artifact を取得できず未解析。

## Worker PoC（2026-08-31）

`poc/myjcb-worker`に、`mnie`やOkuraのsourceをreuseしない独立Cloudflare Workers PoCを追加した。Worker自体は**未deploy・未auth test**であり、実credentialを投入していない。一方、利用者のKuebiko sessionでは第一IDへの実passkey loginとread/exportを観測しており、そのroute、field名、DOM shape、formatだけを実装へ反映した。raw credential、WebAuthn assertion、cookie、明細値、取得file、hashはcommitしていない。

構成は次の二段階である。

1. `login-protection.ts`だけがCloudflare Browser Runを使って公式`/Login`を開き、公式`login-prot.js`をpage内で実行する。`form[name=loginForm]`内のnamed `userId`/`password`だけを入力し、submit直前にmethod/origin/pathを検査する。passkey、OTP、秘密の合い言葉、CAPTCHA、Access Deniedではretryせず`human-required`とする。
2. 既知mypageへ到達したらcomplete cookie jarと同じUser-Agentをmemoryへ移し、通常Worker `fetch`でstrict allowlistのreadだけを行う。クレジットmenu/detail/過去月JSON-RPC/CSV/PDF/OFXとデビットmenu/detailを対象とし、Browserはconnectionごとの`finally`で閉じる。

Workers内でdownloadした任意JavaScriptを`eval`せず、保護scriptを手書き移植しない。Browser Runで公式scriptを実行できるため、現段階でContainerは追加しない。Browser Runだけが環境判定で失敗し、同じ公式flowがContainer Chromeで再現性を持って成功した場合に限りlogin bootstrapの最小Container化を再検討する。

### Kuebikoで確認したlogin境界

- URLは`https://my.jcb.co.jp/Login`。password formは`POST /iss-pc/member/user_manage/Login`で、named controlsは`userId`、`password`、`screenId`、`loginRouteId`、`un`、`pcSpScreenSwitchUrl`だった。
- rendered DOMにはnameのないtext/password decoy candidateもあったため、input typeやindexでは選ばない。
- `/apl/login-prot.js?init`、loadごとに変わるseed付き`?async`、version付きpasskey/NNL SDK assetsがloadされた。source/version/seedはhard-codeしない。
- 初期画面の通常選択肢にpasskeyがあるため、その文字だけではchallengeと判定しない。第一IDの本人loginは`POST /iss-pc/member/user_manage/PasskeyLogin`（200）、`POST .../userLoginPasskeyServiceStatusCommunication.html`（200）、`POST .../userLoginPasskeyAuthCheckCommunication.html`（200）、`POST .../userPasskeyLoginRelay.html`（302）、`GET /iss-pc/member/mypage/mypage.html`（200）の順だった。WebAuthn assertionはprivate captureにのみ存在する。
- passkey flowのcookieはstable application cookie、`rp1..rp33`型、random-looking per-session名が混在した。完全なjarと属性を扱う必要はあるが、個々の名前は相関telemetryになるためdiscovery、manifest、logへ保存しない。
- 第一IDはpasskeyだったため、password-only unattended loginでは全IDを覆えない。PoCの`session` modeは本人bootstrap後の短命cookie＋User-Agent replayであり、passkey renewalの自動化ではない。

### Kuebikoで確認したクレジットread/export

- 初期menuは`detailMenu.html?link_id=...`、明細は`detail.html?detailMonth=N&output=web`。第一IDの初期HTMLは`0..8`を列挙した。
- `detailAPI.js`はdetail pageの`input:hidden[name=generalJsonShikibetuId]`を読み、`detailPastJson.json`へ`application/json`でJSON-RPC POSTする。request fieldsは`jsonrpc`、`method`、`params`、`id`、contractは`method=execute`、`params=[{generalJsonShikibetuId}]`、IDは`0301006`＋2桁counter（初回`030100601`）。responseは`result.errId`、`errMessage`、`detailPastJsonInfo[]`を持ち、item fieldsは`detailAvailableFlag`、`detailMonth`、`payAmount`、`payAmountDispFlag`、`settlementYM`だった。hidden欠落／API failureでは停止し、推測値や`0..17`をblind scanしない。
- 第一IDの過去月responseは9候補（`detailMonth=9..17`）のうち2件（`10`、`13`）だけがavailableだった。collectorは`detailAvailableFlag=true`だけを初期menu月へ追加する。
- 別の`detailReplaceJson.json`はrequest parameterに`generalJsonShikibetuId`、`simeYmd`、`payAmount`、response itemに`changeOperationLimitDate`、`detailInquiryURL`、`fixFlag`、`newestFlag`、`payAmount`、`payAmountDispFlag`、`payHowChangeEnableFlag`、`settlementDate`を持つUI/payment-display metadataだった。ledger取得には不要なのでallowlistしない。
- 未確定`detailMonth=0`はexportなしで、`.detail-list-01`の`.head`とrepeated `.content`をparseする。summary labelsは`ご利用日`、`ご利用先など`／`支払区分`、`ご利用金額`、expanded labelsは`今回のお支払い金額`、`摘要`、`今回回数`、`備考`、`訂正サイン`だった。
- 確定月HTMLにも同ledger componentがあり、summary labelsは`ご利用日`、`ご利用先など`／`支払区分`、`今回のお支払い金額`、expanded labelsは`ご利用金額`、`摘要`、`今回回数`、`備考`、`訂正サイン`だった。CSV/OFXと突合できる。
- 確定月のGET exportは`detailDbPdf.html?...&output=pdf`、`detail.html?...&output=csv`、`detail.html?...&output=money`。CSVはCP932で、先頭metadata行ではなく後続行に`ご利用者`、`カテゴリ`、`ご利用日`、`ご利用先など`、`ご利用金額(￥)`、`支払区分`、`今回回数`、`訂正サイン`、`お支払い金額(￥)`、`国内／海外`、`摘要`、`備考`のexact 12-column headerがある。PDFは`%PDF-1.4`、OFXは1.xの`CREDITCARDMSGSRSV1`／`CCSTMTRS`／`BANKTRANLIST`／`LEDGERBAL`を確認した。`detailNewspdf.html`はnoticeなので除外する。
- `/iss-pc/member/detailsinvoice/detailsInvoiceList.html`は別のinvoice surfaceで、第一IDでは上記statement export controlsを持たなかった。明細取得routeとして混同しない。

### credential、R2、schedulerの境界

設定は複数の独立`connections[]`を持ち、IDごとにcredential/session/result/R2 namespaceを分離する。一つのおまとめloginが全IDを含むとは仮定しない。小規模fallbackは`MYJCB_CONNECTIONS_JSON`だが、[Workers limit](https://developers.cloudflare.com/workers/platform/limits/)ではsecret/variable一値が5 KBなので、`MYJCB_CONNECTION_SECRET_NAMES`と一接続一secretの`MYJCB_ACCOUNT_<NAME>_JSON`も実装した。

一接続のfull cookie jarだけで5 KBを超え得るため、`session` modeは5 KB以内だけのPoCである。実用案はlocal sync CLIでclient-side AES-GCM暗号化したsession envelopeをprivate R2へ置き、Worker secretには小さいwrapping keyだけを置く構成だが、本PRでは未実装であり5 KB超sessionはblockerとする。

R2は`raw/myjcb/YYYY/MM/DD/<run-id>/<connection-id>/...`へsource-preserving artifact、normalized ledger、manifestをappend-only保存する。login/mypage/protection source、credential、protected POST body、cookie値は保存しない。HTMLはtoken候補と16桁card番号をredactしてから保存し、runtime errorはtyped codeと固定public messageに正規化する。discoveryにはcookie名を残さずcountだけを置く。

日次実行は`0 21 * * *`のCloudflare CronからWorker `scheduled()`を直接呼び、GitHub Actions cronを使わない。手動`POST /trigger`のBearerはSHA-256で固定長化してから`crypto.subtle.timingSafeEqual`で比較する。ただしCron/manual overlap lockは未実装で、同一IDの同時login/readを防ぐDurable Object lockまたはQueue直列化をdeploy/merge前要件とする。

実装、stop条件、R2 layout、cleanup前提、synthetic test、未確認事項は`poc/myjcb-worker/README.md`に集約した。公開AGPL prior artの観測は、PR #24調査時点のOkura commit `afc6057fba78b5bfd6364654548fbfd91c76692a`とPoC照合時点の`bbf11e032aba4a380009508e91954361a3f9d658`を区別し、protocol確認だけに使った。
