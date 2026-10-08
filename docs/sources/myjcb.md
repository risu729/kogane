# MyJCB カードファミリー調査

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

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

| 対象                    | 明細の主経路                                                                                      | 追加カード／支払                                          | ポイント・特典経路                                                                                                                                                                             | おまとめ上の注意                                                                                                                                            | 推奨取得                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| JCB W                   | MyJCB Web／アプリ                                                                                 | クレジット。家族・ETC・QUICPay を親明細内で識別           | [JCB W](https://www.jcb.co.jp/ordercard/kojin_card/os_card_w2.html)は 200 円につき 2 J-POINT。MyJCB／確定明細で残高・失効等を確認                                                              | JCB 発行のルート ID。ナンバーレスの初期登録・番号確認はアプリだが、明細取得は Web 可                                                                        | 確定 CSV／OFX 月次。未確定が必要な場合だけ Web 表示  |
| リクルートカード（JCB） | [リクルートカード利用案内](https://recruit-card.jp/guide/)から JCB 会員ページ＝MyJCB              | 本会員明細に家族利用を合算                                | 通常還元 1.2%。[JCB 公式ポイント案内](https://www.jcb.co.jp/myjcb/pop/recruit-point.html)上、リクルートポイントは J-POINT ではなく、残高照会はリクルート側マイページ。MyJCB だけでは完結しない | JCB 版のみ。Visa／Mastercard は別 backend。JCB 発行カードとして候補だが、既存おまとめ状態は live で確認する                                                 | 明細は MyJCB。ポイントは別 connection とし、混ぜない |
| みずほ JCB デビット     | MyJCB、または [みずほ Wallet](https://www.faq.mizuhobank.co.jp/faq/show/3774?site_domain=default) | 即時引落、一回払いのみ。家族カード最大 8 枚、親口座に合算 | [みずほ公式](https://www.mizuhobank.co.jp/jcbdebit/info/index.html)では J-POINT でなく利用額帯別 0.2–0.4% の口座キャッシュバック。Wallet に次回率表示                                          | みずほ **Smart Debit** とは別商品。Smart Debit はおまとめ・パスキー等の公式除外あり。通常のみずほ JCB デビットまで除外と一般化しない                        | MyJCB デビット明細＋差額明細。銀行残高は対象外       |
| 京銀 JCB デビット       | [京都銀行公式](https://www.kyotobank.co.jp/kojin/jcbdebit/)から MyJCB（京銀アプリは deep link）   | 即時引落、一回払いのみ。家族カードあり、ETC なし          | 200 円で 1 J-POINT。MyJCB でポイント照会。2026 年に Oki Doki から J-POINT へ移行                                                                                                               | 京都銀行は [JCB グループ一覧](https://www.jcb.co.jp/pop/group-list.html)に掲載。ただし MyJCB の口座残高表示サービスは京都銀行／京銀カードサービスを明示除外 | MyJCB デビット明細＋差額明細。銀行残高は対象外       |

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

| 対象                    | 公式条件との関係                                                                                        | 現時点の判定                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| JCB W                   | 354 系個人クレジット/JCB 発行の通常対象と整合                                                           | 対象候補。既存 ID の提示で確認                       |
| リクルートカード（JCB） | JCB 発行・番号/契約条件を満たす場合に対象                                                               | 商品名だけでは確定しない。Visa/Mastercard は完全に別 |
| みずほ JCB デビット     | 357 系個人デビット条件と整合。公式除外は「みずほ Smart Debit」で、通常 JCB デビットを一括除外していない | 対象候補だが issuer 実画面で未確認                   |
| 京銀 JCB デビット       | 357 系個人デビットかつ京都銀行は JCB group issuer 一覧に掲載、明示除外なし                              | 対象候補だが issuer 実画面で未確認                   |

passkey 登録済み ID は password login を使えないため、Okura の ID/password flow と排他的になり得る。おまとめ済み複数 ID のうち一つだけ passkey の場合、root login、切替先、再認証要求の組合せを live で確認し、全カードへ一般化しない。

### Bitwarden と自動化に関する確認結果

- **公式情報**: JCB は Bitwarden を対応・非対応のどちらとも記載せず、代表例として Apple／Google だけを挙げる。
- **live確認**: 第一のMyJCB IDでは、Bitwarden CLIが返した一つのdiscoverable passkey（RP ID一致、counter 0）をChrome CDP virtual authenticatorへ一時注入し、Cloudflare Browser Run上でWebAuthn assertionが発生してmypageへ到達した。これは当該ID／時点の相互運用確認であり、全issuer、QR cross-device、アプリ内WebViewへ一般化しない。
- **推測**: ID／パスワードは通常のブラウザ autocomplete の対象なので Bitwarden autofill が機能する可能性は高い。しかし passkey 登録済み ID ではパスワードログイン自体が無効で、headless secret injection の代替にはならない。
- collector は passkey の新規登録・解除、パスワード再設定、OTP 宛先変更を行わない。利用者が既に選んだ認証状態を尊重し、人の操作が必要なら停止する。

### passkey内部通信とBrowser境界（2026-08-31 live）

Browser Run上の成功loginで、同一originの動的通信を値なしで観測した。`PasskeyLogin`開始、`userLoginPasskeyServiceStatusCommunication.html`への`loginRouteId`、NNL Apps SDK 9.2.0、`userLoginPasskeyAuthCheckCommunication.html`へのopaqueな`result`、mypage GETの順だった。すべて200で、動的responseのMIMEは`text/html`だった。challenge、assertion、`result`値、cookie、header、queryは保存していない。

このため、現在確認できた契約は「標準WebAuthn JSON APIを直接呼ぶ」形ではない。Browserを外すには、公式NNL SDKが生成する`result` envelopeとserver-side state/cookie contractを別途再現する必要がある。Workers Web CryptoでP-256署名を行えることだけでは十分でない。現PoCはlogin bootstrapだけBrowser Runを使い、mypage到達後はbrowserを閉じるまでにcookie/User-Agentを取り出し、menu、detail、`detailPastJson`、exportを通常のWorker fetchへ切り替える。このhandoffとprivate R2保存は第一IDのlive runで成功した。

Browserless化は可能性を否定しないが、現在のcaptureだけから`result`をJSON、JWT、暗号文等のどれかへ断定しない。実装は、(1) 複数の成功runでNNL SDK version、WebAuthn request/response、`result`、cookie/relay stateをprivateに対応付け、(2) challenge依存部分と固定envelope、integrity、transaction/SDK metadata、extension/risk signalを差分し、(3) WebAuthn標準部分をbyte-exact test付きでWorkers Web Cryptoへ移し、(4) 観測済みNNL/JCB serializationとendpoint state machineだけを独立adapterへ実装する順序とする。`clientDataJSON`、RP ID hash、UP/UV/BE/BS、counter、extensions、ES256署名表現のいずれも「秘密鍵が同じ」ことから推測しない。

direct clientは既存Browser bootstrapと別modeにし、fresh challenge、一回利用、replay拒否、RP ID/origin不一致、session expiry、連続Cron、NNL version driftを検証する。未知のSDK／response／redirect／追加認証ではfail closedとし、同一runでBrowserへ自動fallbackして認証を二重送信しない。mypage到達後のcookie jar、strict read allowlist、明細client、R2保存は現在の実装を再利用し、Browser版とcard/period/artifact種別が一致することを確認してから別PRでBrowser bindingを除去する。解析用のchallenge、assertion、cookie、`result`、明細値はpublic repo、Worker log、R2へ保存しない。詳細な実装順と完了条件は`services/collector-myjcb/README.md`に置く。

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

| 機能                                | 現時点の具体的候補                                                                                    | 確度と次の確認                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| デビット read                       | Okura の `debitDetailMenu.html?link_id=...` → `debitDetail.html?seq=N`                                | 現行公開 code。みずほ/京銀 issuer と passkey 未登録 ID での live 成功は未確認                                                     |
| クレジット read                     | `/iss-pc/member/details_inquiry/detailMenu.html?link_id=...` → `detail.html?detailMonth=N&output=web` | 2026-08-31 の本人操作で現行 GET を確認。初期 HTML は `0..8`、過去月 API は `9..17` のうち account ごとの available 月だけを返した |
| 過去月 availability                 | `POST /iss-pc/general_json/member/details_inquiry/detailPastJson.json`                                | `detailAPI.js` と本人操作で JSON-RPC contract を確認。hidden discriminator 欠落／API failure では停止し、blind scan しない        |
| PDF export                          | `/iss-pc/member/details_inquiry/detailDbPdf.html?detailMonth=N&output=pdf`                            | 2026-08-31 に確定月の GET と `%PDF-1.4` signature を確認。`detailNewspdf.html` は notice であり statement ではない                |
| CSV export                          | `detail.html?detailMonth=N&output=csv`                                                                | 2026-08-31 に GET、Windows-31J/CP932、metadata 行後の exact 12-column header を確認                                               |
| OFX export                          | `detail.html?detailMonth=N&output=money`                                                              | 2026-08-31 に GET、OFX 1.x credit-card statement group を確認                                                                     |
| おまとめ済みカード列挙              | mypage の「ID切替」→表示カード切替画面                                                                | 公式 UI の存在は確認済み。カード名/ID/番号を保存せず route と一般 issuer/type だけ確認                                            |
| おまとめ済み ID 切替                | 既存切替画面の card-select action                                                                     | 金融取引ではなく session の current-card context 変更候補。method、hidden field、CSRF、戻り先を確認してから 1 回だけ replay       |
| おまとめ設定追加/解除・初期表示変更 | 設定画面                                                                                              | write。transport 調査で見えても呼ばない                                                                                           |

クレジット read/export path は 2026-08-31 に current contract として再確認した。確認は第一 ID の一時点に限るため、別 issuer／ID では link、schema、export control を毎回検査する。`detailMonth` は HTML／availability API に実在する値だけを取得し、card selector や financial value は公開記録へ保存しない。

### CSRF と session renewal の確認点

- login の 6 個以上の動的 field は protection script が生成するが、用途は公開されていない。CSRF、bot signal、integrity data のどれかに決め打ちしない。
- クレジット CSV／PDF／OFX は現行 GET と確認した。ID 切替など未確認 POST は、hidden input/header/cookie の **存在、名称の hash、長さ、rotation timing** だけを確認し、値は保存しない。GET でも state-changing action と同じ token を共有する場合は replay を止める。
- cookie snapshot は authenticated validation 後に限定し、User-Agent を必ず対で再利用する。Okura の固定 Chrome 140 UA は将来古くなるため、保護 script を生成した実 browser/approved UA との一致を live で検証する。
- cookie の Expires/Max-Age、idle timeout、absolute timeout、ID切替前後の cookie rotation、logout 後の invalidation を metadata として確認する。protection cookie の長い Max-Age を authenticated session 寿命とみなさない。
- refresh/renew endpoint は未発見。自動的な silent renewal を仮定せず、session expiry は user-assisted reauthentication とする。passkey 登録済み ID では password replay を試さず、既存 browser/app bootstrap から session capture できるかだけを検討する。

## 公式 APK の入手・静的解析・runtime tracing

[Google Play の公式 listing](https://play.google.com/store/apps/details?id=jp.co.jcb.my) は package `jp.co.jcb.my`、JCB 公式 app、2026-07-27 更新、version 3.11.1 を示す。匿名の Google Play artifact delivery は local/OCI とも HTTP 429、Play 認証済み emulator と owner-controlled Android 実機は未接続だったため、現行 3.11.1 の正規 split APK/app bundle は取得できなかった。

再現可能な静的調査を残すため、2026-08-31 に `apkeep 1.0.0` の APKPure backend から mirror 版 3.9.0（versionCode 3901、20 split）を取得し、raw artifact、hash、certificate、JADX/apktool output、手順を private repository に保存した。20 split は package/versionCode が一致し、同一 signer で検証でき、Google Source Stamp の検証にも成功した。ただし mirror provenance であり、現行 3.11.1 の公式 Play signer と独立照合できていないため、現行 binary と同一 trust chain／実装であるとは扱わない。private archive の raw artifact、certificate、decompiled source は公開 Kogane へ転載しない。

3.9.0 の解析結果は次のとおり。

- JADX 1.5.6 は source 18,085 files、resources 2,758 files を生成した。exit code 3、177 method errors が残ったが、app/API interface は読めた。
- apktool 3.0.3 は 22,195 files を生成し exit 0。base-only decode に由来する split-resource warning 80 件がある。
- DEX は通常の 2 files で、暗号化 DEX の復号・runtime dump は不要だった。
- native WebView wrapper ではなく Retrofit/OkHttp/Moshi の JSON client で、historical primary base URL は `https://imad.jcb.co.jp/v1/`。latest/monthly credit detail、debit detail、point、notification、複数カード切替、security setting の interface があり、monthly detail は target year-month を受ける。retention と authenticated schema は未検証。
- passkey/FIDO は Nok Nok SDK と AndroidX Credential Manager を使い、JCB の registration/authentication endpoint を分離している。Nok Nok の packaged default は server request に応じて Play Integrity、keystore attestation、jailbreak risk、location、Wi-Fi SSID、in-call、metrics、credential-provider 等の signal を扱えるが、MyJCB server が実際に何を要求するかは runtime 未観測である。
- production network-security config は system CA を使い cleartext を無効化する。静的な OkHttp `CertificatePinner` や production trust-all path は見つからなかった。ただし dynamic/native check と現行 3.11.1 は未確認。
- `libsigner.so` は Adjust analytics の component であり、MyJCB API request signing の証拠ではない。

この結果から、Webが成立しない場合のfallbackとしてapp JSON APIを別candidateに残す価値がある。特に年月指定のcredit detailはbackfillに適する可能性がある。ただし優先経路はBitwarden保存済みpasskeyを使うWeb Browser Runであり、app APIへはWeb passkey modeとsession modeが成立しない場合だけ進む。app側は認証bootstrap、server-selected FIDO/Integrity signal、session renewal、response schema、retentionを実機の本人操作で確認するまでscheduled collectorが成立したとは判断しない。

現行の正規 artifact を得られる次の実験は次のとおり。

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

| 環境                             | 適性                                    | 理由                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers（fetch のみ） | 条件付き                                | 旧式な HTTP replay や確定 export 取得は可能だが、現行 protection JS は Node VM／Worker 相当の限定 DOM を要求し、秘密の合い言葉、OTP、passkey を完結できない。金融 session を edge KV やログへ置かない。                                                                                                    |
| Cloudflare Browser Run           | 条件付き                                | [session reuse](https://developers.cloudflare.com/browser-run/features/reuse-sessions/)と Durable Objects、Playwright/Puppeteer、人手介入が使えるため C 経路に合う。ただし session idle 終了、共有 browser の cookie 分離、passkey/QR、金融 PII の運用リスクがある。匿名 dev test 以外は第一候補にしない。 |
| Cloudflare Containers            | 適                                      | [公式](https://developers.cloudflare.com/containers/)は Linux/amd64 の任意 runtime・filesystem を提供。Deno/Node parser、隔離 worker、browser を包装できる。cold start と instance lifecycle を跨ぐ session は外部暗号化 store が必要。                                                                    |
| OCI container                    | 適                                      | parser と browser を固定 digest の image に閉じ込められる。secret は image／環境変数に焼かず、実行時 secret store、tmpfs、egress allowlist を使う。                                                                                                                                                        |
| Kubernetes                       | 過剰だが適                              | [Kubernetes image](https://kubernetes.io/docs/concepts/containers/images/)で digest pin、Secret、NetworkPolicy、CronJob、専用 namespace を構成できる。少数カードには運用費が大きい。rootless、read-only FS、ephemeral volume、1 connection/Pod を推奨。                                                    |
| 管理下 Android 実機              | 調査に適、full UI automation は高コスト | 正規 APK 取得、manifest/host/schema 静的解析、本人操作の read-only tracing、passkey/issuer 境界確認に適する。定常 UI automation は端末拘束、画面変更、attestation、write UI 隣接により D/cost 5。                                                                                                          |

どの cloud runtime でも、session／cookie／OTP／明細実値を application log、trace、crash dump、analytics に出さない。issuer／product も必要最小限の一般名だけを tag にする。

## 共通 rubric による評価

定義は PR #5 `docs/source-research.md` をそのまま使用する。

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| 経路                                                   | Level |  Cost | 判断                                                                                                   |
| ------------------------------------------------------ | ----: | ----: | ------------------------------------------------------------------------------------------------------ |
| 確定 PDF／CSV／OFX を人が月次 download、offline import |     E |     1 | 公式 export だが手動。最も安全。15 か月 retention のため月次保存が必要。                               |
| 既存 Web session から確定 export を自動 download       |     C |     3 | session bootstrap 後の replay は plausible。export endpoint とカード切替は live 確認が必要。           |
| クレジット未確定明細（JCB W／Recruit JCB）HTML         |     C |     4 | export 不可、可変 DOM、カード切替・追加認証・保護 script 依存。                                        |
| みずほ／京銀 JCB デビット HTML＋差額明細               |     C |     4 | 公開実装が transport を具体化したが、issuer・passkey・追加認証互換は未確認。                           |
| Recruit ポイント残高／履歴                             |     C |     4 | MyJCB ではなく Recruit 側 session。別 source として評価・実装する。                                    |
| MyJCB アプリ／銀行アプリ UI 自動化                     |     D |     5 | OTP、生体／passkey、端末、app version、write UI に拘束。                                               |
| MyJCB family 全体の既定                                | **C** | **4** | API ではないが Web bootstrap＋session replay が具体的に plausible。運用上の safe default は E/cost 1。 |

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
- mirror 版 3.9.0 は private archive で静的解析済みだが、公式 version 3.11.1 APK の signing certificate、manifest、host、network security config、app schema、pinning/Integrity 実装は未確認。3.9.0 の runtime headers/cookies、server-selected FIDO extension、login/OTP/passkey flow、authenticated response schema も未検証。

## Worker PoC（2026-08-31）

`services/collector-myjcb`に、`mnie`やOkuraのsourceをreuseしない独立Cloudflare Workers PoCを追加した。Worker自体は**未deploy・未auth test**であり、実credentialを投入していない。一方、利用者のKuebiko sessionでは第一IDへの実passkey loginとread/exportを観測しており、そのroute、field名、DOM shape、formatだけを実装へ反映した。raw credential、WebAuthn assertion、cookie、明細値、取得file、hashはcommitしていない。

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
- 第一IDはpasskeyだったため、password-only unattended loginでは全IDを覆えない。2026-08-31にBitwarden export modelとChrome CDP WebAuthn contractを照合し、P-256 PKCS#8、credential ID、user handleをBrowser Runの一時virtual authenticatorへ注入する`passkey` modeを追加した。counter=0、discoverable、JCB RP IDだけを許可し、鍵/assertion/cookieをartifact/logへ保存しない。live Worker authは未検証である。

### Kuebikoで確認したクレジットread/export

- 初期menuは`detailMenu.html?link_id=...`、明細は`detail.html?detailMonth=N&output=web`。第一IDの初期HTMLは`0..8`を列挙した。このうち 7 と 8 は月ではなく支払予定 page である（下の「credit menu の group と支払予定 page」）。
- `detailAPI.js`はdetail pageの`input:hidden[name=generalJsonShikibetuId]`を読み、`detailPastJson.json`へ`application/json`でJSON-RPC POSTする。request fieldsは`jsonrpc`、`method`、`params`、`id`、contractは`method=execute`、`params=[{generalJsonShikibetuId}]`、IDは`0301006`＋2桁counter（初回`030100601`）。responseは`result.errId`、`errMessage`、`detailPastJsonInfo[]`を持ち、item fieldsは`detailAvailableFlag`、`detailMonth`、`payAmount`、`payAmountDispFlag`、`settlementYM`だった。hidden欠落／API failureでは停止し、推測値や`0..17`をblind scanしない。
- 第一IDの過去月responseは9候補（`detailMonth=9..17`）のうち2件（`10`、`13`）だけがavailableだった。collectorは`detailAvailableFlag=true`だけを初期menu月へ追加する。
- 別の`detailReplaceJson.json`はrequest parameterに`generalJsonShikibetuId`、`simeYmd`、`payAmount`、response itemに`changeOperationLimitDate`、`detailInquiryURL`、`fixFlag`、`newestFlag`、`payAmount`、`payAmountDispFlag`、`payHowChangeEnableFlag`、`settlementDate`を持つUI/payment-display metadataだった。ledger取得には不要なのでallowlistしない。
- **JSON/HTML境界**: 本人操作のnetwork captureで、取引行を返すJSON endpointは確認できなかった。`detailPastJson`は取得可能月、`detailReplaceJson`はUI/payment metadataだけで、未確定取引行はserver-rendered detail HTMLに存在する。確定月は公式CSVを正規sourceとして優先できるが、未確定はexport不可なのでHTML parserが必要である。第一connectionの成功Worker runでもcredit detail 11、ledger 6に対してexport link/artifactは0だったため、このIDはHTMLを捨てると取得不能になる。従ってPoCは全月blind HTML scrapingではなく、JSONでavailable月を絞り、exportがある確定月はCSV/PDF/OFXを優先し、それ以外だけHTML ledgerを使う方向へ最適化する。
- 未確定`detailMonth=0`はexportなしで、`.detail-list-01`の`.head`とrepeated `.content`をparseする。summary labelsは`ご利用日`、`ご利用先など`／`支払区分`、`ご利用金額`、expanded labelsは`今回のお支払い金額`、`摘要`、`今回回数`、`備考`、`訂正サイン`だった。
- 確定月HTMLにも同ledger componentがあり、summary labelsは`ご利用日`、`ご利用先など`／`支払区分`、`今回のお支払い金額`、expanded labelsは`ご利用金額`、`摘要`、`今回回数`、`備考`、`訂正サイン`だった。CSV/OFXと突合できる。
- 確定明細のpageは`<h1>カードご利用代金明細(確定分)</h1>`を一つだけ持つ。production evidenceの集計（read-only、値は記録していない）では、全`credit-detail-01.html` captureがこのh1をちょうど一つ持っていた。position 1は最新の締め済み明細であり、export linkがなくても確定明細である。状態の判定は[明細状態の判定](#明細状態の判定2026-09-24)を参照。
- 確定月のGET exportは`detailDbPdf.html?...&output=pdf`、`detail.html?...&output=csv`、`detail.html?...&output=money`。CSVはCP932で、先頭metadata行ではなく後続行に`ご利用者`、`カテゴリ`、`ご利用日`、`ご利用先など`、`ご利用金額(￥)`、`支払区分`、`今回回数`、`訂正サイン`、`お支払い金額(￥)`、`国内／海外`、`摘要`、`備考`のexact 12-column headerがある。PDFは`%PDF-1.4`、OFXは1.xの`CREDITCARDMSGSRSV1`／`CCSTMTRS`／`BANKTRANLIST`／`LEDGERBAL`を確認した。`detailNewspdf.html`はnoticeなので除外する。
- `/iss-pc/member/detailsinvoice/detailsInvoiceList.html`は別のinvoice surfaceで、第一IDでは上記statement export controlsを持たなかった。明細取得routeとして混同しない。

### credential、R2、schedulerの境界

設定は複数の独立`connections[]`を持ち、IDごとにcredential/session/result/R2 namespaceを分離する。一つのおまとめloginが全IDを含むとは仮定しない。小規模fallbackは`MYJCB_CONNECTIONS_JSON`だが、[Workers limit](https://developers.cloudflare.com/workers/platform/limits/)ではsecret/variable一値が5 KBなので、`MYJCB_CONNECTION_SECRET_NAMES`と一接続一secretの`MYJCB_ACCOUNT_<NAME>_JSON`も実装した。

一接続のfull cookie jarだけで5 KBを超え得るため、`session` modeは5 KB以内だけのPoCである。実用案はlocal sync CLIでclient-side AES-GCM暗号化したsession envelopeをprivate R2へ置き、Worker secretには小さいwrapping keyだけを置く構成だが、本PRでは未実装であり5 KB超sessionはblockerとする。

R2は`raw/myjcb/YYYY/MM/DD/<run-id>/<connection-id>/...`へsanitized provider capture、normalized ledger、manifestをappend-only保存する。login/mypage/protection source、credential、protected POST body、cookie値は保存しない。HTMLはactive/embedded要素、event/data/navigation/form属性、全value/textarea、token/session類似属性、16桁card番号を除去・置換してから保存し、runtime errorはtyped codeと固定public messageに正規化する。discoveryにはcookie名を残さずcountだけを置く。

Layer Aの中央取込は`services/collector-r2-importer`に実装した。source R2を変更せず、manifest/prefix/metadata/checksumとHTML・past-month JSON・ledger・discoveryのmeaningを中央state作成前に検証する。既存HTMLは追加の`myjcb-central-sanitized-v2`変換を行い、active surfaceとtoken/navigation属性を中央へ複製しない。manifestもfailure/blocker自由文を固定codeへ置換した中央専用bytesを作り、source manifestの自由文をそのまま複製しない。最大16 connectionsのterminal reportを残すため、完全inventoryを固定して5 artifactずつstaged transferし、HMAC付きcontinuationから再開する。専用credential、route、source alias、storage policyはmigration `0011`で分離する。2026-09-05時点のprivate R2監査では22 manifests / 142 objectsを確認したが、本文・値・key・個別hashは公開記録へ出していない。最終validatorでは22 manifests全件が通り、72 HTML全件が中央用bytesへ変換された。実例が存在したdatasetはcredit menu、past-month JSON、credit detail、parsed ledger、discoveryだけであり、CSV/PDF/OFX/debitはartifactもR2 failure宣言も受理しない。実例のsafe structureを監査して契約・negative testを追加するまでfail closedを維持する。

同一manifestのbackfill retryは中央で冪等だが、collectorが別run IDで重複収集した場合は別runとして保存する。実R2の6 success runはpayload fingerprintが互いに異なり、content deduplicationで収集runを統合する根拠はない。既知のCron/manual overlapはcollector側lockの課題であり、raw-evidence取込でscheduled実行を追加・変更しない。

## Layer B observation parser（2026-09-07）

中央へ正規化済みの5 datasetのうち、金融観測を作るcanonical routeは`credit-ledger`と`credit-past-months`だけに限定した。`credit-menu`、`credit-detail`、`discovery`はstrictにshapeとmetadataを検証するが、HTMLとnormalized ledgerの二重計上を避けるため観測をemitしない。CSV/PDF/OFXとdebitは実R2成功artifactが未観測であり、Layer A同様Layer Bにも推測parserを登録していない。

`credit-ledger`はmanifestのconnection、filename、statement state、periodとpayloadを相互照合する。実shapeでは日付文字列に内部空白があり、支払区分と金額がsummary cell 2/3のいずれにも現れたため、日付と金額はLayer Aと同じ空白正規化後に厳密検証し、2/3のうちexact JPY表示がちょうど1個であることを要求する。providerの利用額は債務増を正、refundを負で表すので、Layer B取引は支出負・流入正へ明示反転する。元row、採用cell位置、sign contract、period/state、由来detail HTMLを`extra`に保持する。同一行が複数回現れてもfingerprintと出現順で安定identityを作り、欠落placeholderは作らない。current viewは確定明細ごと（支払月）の最新success artifactと、未確定明細ごと（支払月）の最新success artifactのうちそのpositionの最新captureでもあるものだけを選ぶため、別runの重複と後続snapshotから消えたpendingを残さない（[未確定明細のslot](#未確定明細のslot2026-09-26)）。

支払区分の実shape（2026-09-24 本番D1の件数のみの読み取り診断）: 支払区分の文言（`1回払`）は結合セル`ご利用先など／支払区分`（`summaryCells[1]`）の中に加盟店名と並んで現れ、parserがCOREへ書いた全行（confirmed 48行・unconfirmed 514行）の全てで同じで、他の`N回払`や`分割`／`リボ`／`ボーナス`／`キャッシング`を含む行はなかった。parserが支払区分として採るcell（`_kogane.paymentTypeCellIndex`、`description`へ複写）には画面上の2文字のラベルが入り、支払区分ではない。値はevidenceに既にあるため、parserはrelease（version bump）せず、read model（`packages/read-model/src/card-usage.ts`の`payment_type`）が`summaryCells[1]`を読み、card purchase recognitionが`1回払`等の回数がすべて1で`分割`／`リボ`／`ボーナス`／`キャッシング`を含まない行だけを一回払いとする（[single payment, per source](../economic-events.md#single-payment-per-source)）。結合セルは加盟店名を含むため、ruleが読むだけで保存・logしない。

`credit-past-months`はJSON-RPC envelope、最大18件、month重複禁止を要求し、availableかつdisplay対象の`payAmount`だけを`credit_statement_payment_amount`として記録する。これは現金残高でなくprovider表示の月次支払額であり、非表示・利用不可をzeroとして発明しない。`settlementYM`に絶対年月があれば日を発明せずyear-month精度の`asOf`へ正規化する。Layer Aが許す`detailMonth-N`等の相対fallbackはwarning付き・`asOf`なしで保持する。current balance viewは最新complete artifactを先に選び、その中の最小`detailMonth`を採用するため、absolute/fallback混在や空の最新snapshotでも古い値をcurrentに残さない。

相対ラベル`detailMonth-N`は収集時に解決しない（[`docs/observations.md`](../observations.md#relative-period-labels-are-resolved-from-the-capture-time)）。collectorはproviderの表示どおりのlabelを保存し、raw evidenceを書き換えない。暦月はevidenceからの解釈なので、reader/processorが後から、そのlabelを持つartifactの`fetched_at`（Asia/Tokyo）と相対indexで導出する（versioned rule `relative-statement-period-v1`）。取得日`d`が1〜15日なら`P0`＝`d`の月＋1、16日以降なら＋2（15日締め・翌月払い）とし、`detailMonth-0`＝`P0`、`detailMonth-1`＝`P0 − 1`の支払月（`YYYY-MM`、`card_statement_facts.period`と同じ意味）とする。`N ≥ 2`は解決しない（null）。16日での切替はJCBの公表スケジュール（15日締め、24日前後の確定）に基づくもので、12〜30日のcaptureがまだないため未検証である。根拠は第一connectionの本番captureの集計（日付・金額・加盟店は記録しない）で、月境界の両側で`detailMonth-0`／`detailMonth-1`の全行の利用日がそれぞれ`P0`／`P0 − 1`の請求期間に入り、過去月APIが絶対labelを返した`N = 10, 13`は`P0 − 8`、`P0 − 11`だった。menuと過去月の番号は一様な月offsetではなく、menuの2〜8月は行がなく位置を確定できない。同じ集計で、export linkのない`detailMonth=1`はcollectorが`unconfirmed`と記録する一方、ページ見出しは`カードご利用代金明細(確定分)`で、statement parserはこの矛盾を拒否している（collector側の既知の不一致）。このためその月の行はpending扱いでstatement factがなく、当時のcurrent viewは同一connectionのunconfirmed ledgerを最新の1つしか残さなかった（現在は[未確定明細のslot](#未確定明細のslot2026-09-26)）。

checked-in canaryはsource R2をread-onlyで184 objects / 24 manifests監査した。statusはsuccess 8 / failed 16、全manifestがLayer A strict contractを通り、success artifactは全件がLayer B registryでexactly one routeを選択してparse成功した。集計はtransaction 181、statement metric 16で、nonempty ledgerとdisplayed past monthを確認した一方、multiple connectionsは未観測だった。object key、hash、body、connection/account identifier、加盟店、日付、金融値、secretは出力・保存・commitせず、R2 write/deleteも行っていない。

日次実行は`0 21 * * *`のCloudflare CronからWorker `scheduled()`を直接呼び、GitHub Actions cronを使わない。手動`POST /trigger`のBearerはSHA-256で固定長化してから`crypto.subtle.timingSafeEqual`で比較する。ただしCron/manual overlap lockは未実装で、同一IDの同時login/readを防ぐDurable Object lockまたはQueue直列化をdeploy/merge前要件とする。

実装、stop条件、R2 layout、cleanup前提、synthetic test、未確認事項は`services/collector-myjcb/README.md`に集約した。公開AGPL prior artの観測は、PR #24調査時点のOkura commit `afc6057fba78b5bfd6364654548fbfd91c76692a`とPoC照合時点の`bbf11e032aba4a380009508e91954361a3f9d658`を区別し、protocol確認だけに使った。

## 明細状態の判定（2026-09-24）

以前のcollectorは月の明細状態をexport linkの有無から決めていた。`detailMonth<=1`でexport linkがない月は`unconfirmed`、それ以外は`confirmed`とした。調査したconnectionではどの月にもexport linkがない。そのためposition 1の最新の締め済み明細は常に`unconfirmed`として記録された。このpageは`(確定分)`のh1を持つので、`myjcb-credit-statement-total@1.0.1`はmanifestとの矛盾として全position-1 pageを`parser_rejected`にした。また、そのledger行は`unconfirmed`として保存され、card purchase recognitionは締め済みの請求を`authorized`（保留）の購入として扱った。

collectorは状態をpage自身から決める（`services/collector-myjcb/src/parsers.ts`の`creditStatementState`）。pageは状態を二か所で示す。一つは`カードご利用代金明細(確定分)`のh1で、もう一つはledger headerの金額label（確定は`今回のお支払い金額`、未確定は`ご利用金額`。parserの`CONFIRMED_HEADERS`／`UNCONFIRMED_HEADERS`の4番目）である。

`(確定分)` h1だけが「締め済み明細である」というpage自身の表明である。h1、ledger行、金額labelの読み取りは`packages/domain/src/myjcb-statement-page.ts`の`readMyJcbStatementPage`一か所にあり、collectorと明細total parser（`myjcb-credit-statement-total`、1.1.0以降）が共用する。position規則はcollectorだけが加える。

| `(確定分)` h1 | ledger                                          | 記録する状態                                                                                                                                                                          |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1個           | 金額labelが`今回のお支払い金額`／なし           | `confirmed`                                                                                                                                                                           |
| 1個           | 金額labelが`ご利用金額`                         | pageが証明すれば`confirmed`、しなければ停止（`credit-statement-state`、[amendment (d)](#確定分の見出しとご利用金額のheader2026-09-27adr-0005-の-amendment-d)。未観測、amendment (f)） |
| なし          | ledgerなし                                      | `unknown`                                                                                                                                                                             |
| なし          | 行のないledger（labelは問わない）               | `unknown`（ledger artifactは作らない）                                                                                                                                                |
| なし          | 行があり、金額labelが`ご利用金額`               | position 1は`unconfirmed`、position 2以降は`unknown`                                                                                                                                  |
| なし          | 行があり、金額labelが`今回のお支払い金額`／なし | position 1は停止、position 2以降は`unknown`                                                                                                                                           |
| 2個以上       | 任意                                            | 停止                                                                                                                                                                                  |
| 任意          | 一つのheaderに両label、またはledger間で不一致   | 停止                                                                                                                                                                                  |

`detailMonth=0`は常に`unconfirmed`である。position 0のpageが確定を示した場合は停止する。`unknown`のpageはHTMLだけをevidenceとして保存し、ledger artifactを作らない。position 2以降でh1のないpageを停止にしない理由は、production evidenceにある（read-only、件数だけの集計で、値は記録していない）。各runで取得したposition 7と8は、h1のない行0件のledgerを持っていた（manifestは`confirmed`、`myjcb-credit-statement-total@1.0.1`は12 runすべてで`statement_total_not_confirmed`）。これらを停止にすれば日次runが毎回止まる。`unconfirmed`として保存すれば、同じrunでposition 0より後に記録されるため、当時のread modelではconnectionで一つの未確定snapshot slotを空のcaptureが占め、position 0の保留行がcurrentでなくなっていた。締め済み明細はすべてposition 1を通り、そこでh1を持つ（production evidenceでは12 run中12 run）。そのためposition 1では、h1なしで確定labelの行があるpageを停止にする。一方、古いpage一つで日次runを止めることはしない。停止または`unknown`のlogにはh1の個数、ledger数、行数、label codeだけを出し、page本文は出さない。

export linkは状態の根拠にしない。ただし、確定明細でないpageにexport linkがあれば停止する。exportは`confirmed`として記録されるためである。行を持つledgerのheaderは、その状態のheader一式（4 label）を全部表示していなければならない。これにより、ledger artifactの`headers`はpageで確認済みの事実になる。修正後の最初のrunから、position 1は`confirmed`として保存される。そのledgerは、未確定labelでは読めなかった`ご利用金額`も保持する。

既存captureのraw evidenceとmanifestは書き換えない。解釈はversion付きparserで直す。

- 明細total（`myjcb-credit-statement-total@1.1.0`）: 状態をpageから読み、manifestの状態は照合用として`_kogane.manifestStatementState`に記録する。manifestとpageで「確定かどうか」が異なる場合はwarning `statement_state_differs_from_manifest`を出す（`unconfirmed`と`unknown`の違いはwarningにしない）。失敗させるのはpage自身が矛盾する場合（h1が2個以上、一つのheaderに両label、ledger間の不一致、h1と未確定header。1.2.0以降はpageが証明しない未確定headerだけ）だけで、manifestだけが違う場合は失敗させない。h1のないpageは1.0.1と同じくtotalを出さない。1.0.1で`parser_rejected`だったposition-1 pageは、repair laneの再parseまたはbounded replayで、正確な支払日を持つtotalを公開する。1.0.1のerror runは履歴として残る。
- ledger（`myjcb-credit-ledger@1.1.2`）: 同じmoduleのdigest変更によるversion bumpだけで、挙動は変えない。parserは一artifactしか見ない。`credit-ledger-NN.json`の`state`はcollectorの判断であり、`headers`もその判断から書かれていて、pageの証拠を含まない。確定pageを未確定labelで読んだため、`ご利用金額`も保存されていない。さらにread modelのsnapshot区分は、manifestが書いたappend-onlyの`observation_artifact_metadata.statement_state`を使う。したがってparserで行の状態を直すことはできない。既存のposition-1行は、当時collectorが述べた記録として`unconfirmed`のまま残る。
- 既存行は、修正後collectorの最初の成功runでcurrentでなくなる。当時、connectionの未確定captureは一つのsnapshot slotを共有し、その最新は以後position 0になった（現在の規則は[未確定明細のslot](#未確定明細のslot2026-09-26)）（例外は、position 1がh1なしで`ご利用金額`の行を示す場合だけで、production evidenceでは観測していない）。同じ明細はposition 1で`confirmed`として別slot（`detailMonth-1`）に再取得される。以前はposition 0と1が同じslotを奪い合い、片方しかcurrentにならなかった。purchase laneはcurrentでなくなった`authorized` eventを`unknown`へretireし、確定行を`captured`として新しいeventで認識する。状態はfingerprintとexternal idに含まれるため、同じeventのreviseにはならない。retireされた`unknown` eventはlegを持たないので、同じ購入が二重に数えられることはない。

release noteと再parse手順は`docs/observations.md`の「MyJCB statement state from the page (statement parser 1.1.0)」にある。

## 明細の月（2026-09-26）

providerは最新の締め済み明細をposition 1に置き、次の明細が締まるとposition 2へ移す。collectorは過去月APIがlabelしない月のperiodを`detailMonth-N`（position）で記録していた。periodはledger parserの行fingerprint、つまりexternal idとcard purchase recognitionのkeyに入るため、同じ明細の行が毎月新しいkeyになり、purchase laneは同じ購入をretireして認識し直していた。また、read modelは確定captureをperiodごとのslotに分けていたため、同じ明細がposition 1とposition 2の両方のslotでcurrentになり得た（二重計上）。

collectorは確定明細pageが名乗る月をperiodにする（`services/collector-myjcb/src/parsers.ts`の`creditStatementPeriod`）。確定明細pageは`(確定分)` h1を持ち、`<h2>YYYY年M月お支払い分のカードご利用明細</h2>`、または支払日つきの`<h2>YYYY年M月D日(曜)お支払い分のカードご利用明細</h2>`で支払月を名乗る（`myjcb-credit-statement-total`が読むのと同じh2。下の「支払日つきの明細見出し」）。collectorはその月を`YYYY-MM`としてdetail、ledger、exportのperiodに記録する。positionはartifact keyとledgerの`detailMonth`に残る。相対labelを収集時に解決するのではなく、page自身が述べる絶対月を記録する。

- 過去月APIがlabelする月は、従来どおり`settlementYM`をそのまま使う。pageも月を名乗る場合は同じ月でなければ停止する（`credit-statement-period`）。
- それ以外の確定pageは、名乗る月がない、または二つ以上ある場合に停止する（`credit-statement-period`）。statement parserも同じpageを拒否する。
- 未確定のpageは月を名乗らないため、`detailMonth-N`のままである。`unknown`のpageも月を名乗らず、amendment (h)以降はperiodを書かない（下の「同じ page を示す複数の position」）。
- 停止logには`detailMonth`、名乗った月の個数、API labelの有無だけを出し、月そのものは出さない。

ledger parserは変更しない（version bumpなし）。同じ明細の行はどのpositionでも同じexternal idになる。read modelは確定captureのslotを明細（支払月）にする（`packages/read-model/src/sql.ts`の`myjcbStatementMonth`）。絶対period（`YYYY-MM`、`YYYYMM`、`YYYY年M月お支払い分`）はその月、`detailMonth-0`／`detailMonth-1`は`relative-statement-period-v1`で`fetched_at`から解決した月になる。一つの明細のcaptureは一つのslotに入り、最新のものだけがcurrentになる。規則が置けない確定`detailMonth-N`（N ≥ 2）はpositionであって明細を名指さないため、currentにしない。

deploy時、`detailMonth-1`として確定記録された明細（#248以降のcapture）は、月を名乗る最初のcaptureに置き換わる。その明細の認識済み行は一度だけretireされ、新しいkeyで一度だけ認識される。二重計上はない。保留行、API labelの月、それ以降の月のkeyは変わらない。processor（read model）をcollectorと同時かそれより先にdeployする。設計比較（read modelだけのkey、parser release、collector）と理由は`docs/observations.md`の「MyJCB statements keep their identity when their position moves」にある。

## 未確定明細のslot（2026-09-26）

15日の締めから確定（24日前後）までの間、providerは未確定明細を二つ表示する。position 0は利用が続いている周期、position 1は締め済みで未確定の周期であり、collectorはそれぞれ`detailMonth-0`／`detailMonth-1`の`unconfirmed`として記録する。以前のread modelはconnectionの未確定captureをすべて一つのsnapshot slotに入れていたため、二つのうち新しい方しかcurrentにならなかった。もう一方の明細の保留行は一覧にも認識にも出ず、二つのcaptureの公開順が入れ替わるたびにpurchase laneは新しい情報なしにeventをretireして認識し直していた。

read modelは未確定captureも明細（支払月）で区切る（[ADR 0016](../adr/0016-myjcb-pending-statement-slots.md)、`packages/read-model/src/sql.ts`の`myjcbStatementSlot`と`MYJCB_LEDGER_SNAPSHOT_CTES`）。slotは`relative-statement-period-v1`で`fetched_at`から導く支払月（`detailMonth-0`＝`P0`、`detailMonth-1`＝`P0 − 1`）で、状態ごとのpartitionに入る。同じ明細の未確定captureと確定captureは同じ月の別partitionである。未確定captureは、その月の最新の未確定captureであり、かつそのposition（artifact key `<connection>/credit-ledger-NN.json`）の最新ledger capture（状態を問わない）であるときだけcurrentになる。

- 同じ日の二つの未確定明細は両方currentになり、後のcaptureはその明細だけを置き換える。
- 明細が確定し、position 1が`confirmed`として取得されると、同じreadで未確定captureはcurrentでなくなる。二つが同時にcurrentになることはない。状態はexternal idに含まれるため、purchase laneは保留eventを一度retireし、確定行を`captured`として一度認識する。
- 一つのpositionの二つのcaptureは、規則がどの月を与えても同時にcurrentにならない。16日の切替（未検証）が誤っていても、同じpositionの15日と16日のcaptureで同じ明細が二重にcurrentになることはない。ただしposition間を結ぶのは月だけである。切替日が誤っていて、明細がposition 1へ移る日にposition 1がposition 0より先に公開されると、position 0の最後のcaptureとposition 1の新しいcaptureが別の月になり、position 0が再び公開されるまで同じ明細が二重にcurrentになる（逆の場合は同じ遅延の間、明細が隠れる）。二つの切替日の間の未確定captureは誤った月で区切られる。
- 一つのaccountに解決される別connection間でも、保留行はそのpositionのaccount内で最新のrunから来なければならない（card usageのstep 3）。置き換えられたconnectionの未確定captureは新connectionのcaptureと並んでcurrentにならない。

recognition keyは変わらない（keyは行のexternal id）。position 0からposition 1へ移る未確定明細は、labelが行のfingerprintに入るため16日に一度新しいkeyになる。これは既知の制約で、ここでは変えない。保存済みevidenceとlabelは書き換えず、migrationも不要である。deploy時、最新captureでposition 1が未確定なら、position 0の保留行がcurrentになり認識される。testは`packages/read-model/test/card-usage.test.ts`（「two pending MyJCB statements are two slots」）と`services/processor/test/myjcb-statement-identity.test.ts`にある。

## 共通 DATA R2 への切替 (U09)

Collector は `COLLECTION_TARGET` var を持つ。既定の `legacy` は現行どおり
per-source bucket + importer 経由。`shared` にすると run は `packages/collection`
経由で共通 bucket `kogane-raw-evidence` に保存され、terminal manifest を最後に
書く。保存する HTML は collector の `redactedStatementHtml` 済み bytes で、保存前に
中央と同じ redaction 不変条件を再検査する。connection は terminal の unit として
分離され、human-required は unit の状態として記録するだけで再 login はしない。
deploy 順と rollback は `docs/collection.md` の該当節を参照。

### 口座名義（2026-09-27、ADR 0029 の amendment 2）

確定明細の page には 「カード情報」 表（縦の th／td）があり、口座名義の行は provider が一部を `*` で隠した口座名義人の名前である。保存する page はこの行を provider の表示どおりに残す（[ADR 0029 の amendment 2](../adr/0029-data-classification-and-unkeyed-identity.md#amendment-2-2026-09-27-person-names-are-kept-in-stored-evidence)）。`redactedStatementHtml` は sanitizer（script などの要素、URL・session・credential の属性、card 番号の除去）だけを行い、`assertRedactedHtml` は口座名義の cell を検査しない。terminal の redaction step は `myjcb-sanitizer` v3 である。

経緯：[#333](https://github.com/risu729/kogane/pull/333) の merge から amendment 2 までは、口座名義の `td` の中身を `[redacted:name]` に置き換え、manifest の page の entry に `redactedFieldCount` を書き、step は `myjcb-sanitizer` v2 だった。その間に保存した page は marker のままで、書き換えない（append-only。名前は保持していない）。#333 より前に保存した page は口座名義を含む。

### 共通 DATA R2 の manifest と明細メタデータ（2026-09-26、ADR 0025）

ledger と明細 page の parser が使う statement state と period は、run の collector manifest から processor の metadata extractor（`services/processor/src/metadata-extractors/myjcb.ts`）が読む。terminal にはこれらの field がない。importer 時代の中央 manifest は各 artifact に `connectionId` と `filename` を持っており、extractor はその二つで entry を探していた。collector が共通 bucket に書く manifest の entry は `dataset`、`key`（`objects/<2 hex>/<sha256>`）、`mediaType`、`sha256`、`bytes` と、記録した場合の `statementState`／`period` だけを持つ。そのため共通 R2 の run はすべて `manifest_artifact_mismatch` で parse に失敗していた。

extractor は二つの形を読む。importer 形（どれかの entry が `connectionId` か `filename` を持つ manifest）は従来どおり名前で探し、挙動は変えない。変更前の extractor を固定した differential test で同一性を確認している。共通形では、artifact と同じ digest、size、content-addressed key を名指す entry を探し、その entry の `statementState` と `period` を使う。connection は artifact key の先頭で、manifest の `connections` にあるものでなければならない。同じ bytes が複数の entry にある場合、全 entry の値が一致するときだけ使い、一致しなければ `manifest_artifact_ambiguous` で止める。位置や名前から値を推測しない。

共通形の manifest には、importer 形が持っていた `connectionId`、`filename`、`ordinal` がない。extractor はどちらの形でもこれらを出力しない。connection と position は従来どおり artifact key から読む。entry の `mediaType`（parameter 付き）は使わないので、`credit-menu.html` は引き続き parser に届かない（ADR 0022）。

ADR 0026 以前の collector は、成功した connection の unit coverage も `partial` と書いていた（card が見せる明細期間は一部だけのため）。registration はこれを unit outcome `partial` にし、`observation_fetch_runs` ではその run が `partial` になる。run scope でも `unit-independent-v1` でも parse 対象にならないので、その run は metadata extractor に届く前に `not_eligible` で止まる。これは次節で解消した。

### connection の unit coverage（2026-09-26、ADR 0026）

unit の coverage は「この run が集めようとしたものを、この unit が欠けなく取得したか」を表す。card の履歴全体についての主張ではない。履歴についての主張は run の `coverageStatus` が持ち、成功 run でも `partial` のままである（registration は記録するだけで、outcome を導かない）。

成功した connection の unit は `complete` と書く。成功した connection は、credit menu と過去月 response が列挙した月をすべて取得している。各月について redact 済み page と、状態を示す page から作る ledger をすべて保存する。page が示す export は記録するだけで取得しない（下の amendment (b) の節）。状態が `unknown` の page は規則どおり HTML だけを保存する（ADR 0005）。これは欠落ではない。ただし `unknown` の page に ledger 行がある場合（見出しがなく position 2 以降に行がある page）、その行は HTML の中にしかなく、どの parser も読まない。この月は欠けなく取得できていないので、`collectCredit` がその月を数え、`collectConnection` は connection を `partial` と報告する。unit は `collector_partial` 付きの `partial` になり、failure がなくても run は `partial` になる。月、export、parse のどれかが失敗したときの扱いは次節のとおりである。plan は `partial` の unit を広げない。

`complete` の unit は registration で unit outcome `success` になる。importer 時代と同じである。成功 run は `observation_fetch_runs` で `success` になり、parse job が作られ、end to end で parse される（`services/processor/test/myjcb-shared-r2.test.ts`）。

制限：`complete` は、一つの `detail.html?detailMonth=N&output=web` がその月の全行を持つことを前提にしている。行数上限や page 分割は未確認（上の未確認事項）で、collector は page の行と page が示す合計を照合していない。GLOBAL PASS を `partial` のままにしている理由と同じ未確認事項だが、MyJCB は importer 時代から connection を `success` と記録しており、これまでの parse はすべてこの前提に立つ。観測ではなく前提として記録する。

制限：ADR 0026 より前に書かれた terminal は変更できず、processor の eligibility 規則も緩めないので、その run は `partial`／`not_eligible` のまま parse されない。ADR 0022 の contract v2 でも変わらない（unit outcome は同じ terminal から導かれる）。MyJCB の明細は次の取得で再び見える snapshot なので、card がまだ見せている月の確定明細は ADR 0026 後の最初の成功 run で取り戻せる。失われるのは、その期間の未確定だけの履歴である。後の取得までに消えた未確定行（取消、または確定前の変更）は、parse された run のどれにも入らない。最初の対象 run までは importer の取得分が current のままである（ADR 0014）。

### connection の停止と取得済みの月（2026-09-27、ADR 0005 の amendment）

以前は、月の取得、状態判定、ledger parse、export のどれかが失敗すると connection 全体を捨てていた。その connection は artifact を一つも残さず、terminal は `collector_failed`、collector manifest は `collector-failure` としか書かなかった。どの段階で止まったか、どの月まで取れていたかは保存された evidence に残らず、期限のある Worker log にしかなかった。

現在の collector は月を `detailMonth` の昇順に一つずつ取得する。一つの月は丸ごと保存するか、何も保存しないかのどちらかである。page、ledger、export がすべて読めた時点で初めて connection の artifact に加わる。月の取得、状態判定、明細の月、ledger parse、export のどれかが失敗すると、connection はその月で止まる（[ADR 0005 の amendment](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months)）。credit menu、過去月 response、それより前の月、`discovery.json` は保存し、それ以降は何も読まない（後の月もデビットも読まない）。connection は `partial` になり、unit は停止段階の code 付きの `partial` になる。collector manifest の connection には `stopCode`、`stopPosition`（止まった `detailMonth`）、`capturedMonthCount`（保存した月の数）を書き、failure には `{ connectionId, operation: "collect", code, position }` だけを書く。

停止 code は閉じた一覧（`services/collector-myjcb/src/types.ts` の `CONNECTION_STOP_CODES`）である。

| code                                                       | 段階                                                 | 保存するもの                              |
| ---------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `human_required`                                           | 人の操作が必要                                       | なし（unit は `unknown`）                 |
| `login`                                                    | login、passkey、session 復元                         | なし                                      |
| `discovery`                                                | mypage の card 列挙                                  | なし                                      |
| `credit_menu`、`credit_first_detail`、`credit_past_months` | credit menu、最初の明細 page（識別子）、過去月 API   | なし                                      |
| `credit_menu_group_unrecognized`                           | credit menu の見出しが観測した三つのどれでもない     | なし                                      |
| `month_fetch`、`month_parse`                               | 月の page の取得、page の読み取り                    | 止まった月より前の月（unit は `partial`） |
| `credit_statement_state`、`credit_statement_period`        | 状態の矛盾、明細の月                                 | 同上                                      |
| `credit_page_repeated`                                     | 前の position と同じ page が違う状態か period になる | 同上（その page は保存しない）            |
| `ledger_parse`                                             | ledger header、行の cell                             | 同上                                      |
| `export_fetch`                                             | CSV／PDF／OFX の取得と検証                           | 同上                                      |
| `debit`                                                    | デビット明細                                         | なし（共通 bucket はデビットを拒否）      |
| `no_route`                                                 | mypage に credit もデビットもない                    | なし                                      |
| `unclassified`                                             | 段階を名乗らない error                               | なし                                      |

各停止条件（`StopConditionCode`）は `connectionStopCode` の `Record` で一つの段階に対応する。新しい条件は段階を決めない限り compile できない。manifest の connection と failure は閉じた field だけから組み立て直し、一覧外の code（`manifest_stop_code_invalid`）や `detailMonth` でない位置（`manifest_stop_position_invalid`）は plan を拒否する。error message、HTTP body、provider の文言、金額は保存も log もしない。停止 log（`myjcb-credit-month-failed`）は `detailMonth`、条件 code、停止 code、保存した月の数だけを出す。

run のすべての connection が何も保存しなかった場合、run は `failed` で terminal だけを書く（従来どおり）。それでも unit は書くので、各 connection の停止 code は terminal に残る。registration はこの run を従来どおり `provider_run_failed` として記録するだけで、seal しない。止まっていない connection 以外がすべて同じ段階で止まった場合、run の `safeErrorCode` はその停止 code になる（`human_required` と同じ扱い）。

registration と eligibility は変えない。停止 code 付きの `partial` unit は unit report `failed` になり、run は `observation_fetch_runs` で `partial`、parse job は `not_eligible` である。取得済みの月は catalogue され seal されるが、parse されない。変わるのは、evidence と原因が残ることである。

制限：これ以前の terminal は `collector_failed` のままで、月も残っていない（terminal は変更できない）。停止 code は collector 側の段階を示すだけで、provider が何を意味したかは示さない。

`export_fetch` は、下の節のとおり Worker が export を取得しなくなったため、現在の Worker では起きない（`collectCredit` の `exports: "fetch"` でだけ起きる）。`credit_statement_state`、`credit_statement_period`、`ledger_parse` で止まった場合は、止まった月の page も保存する（下の節）。

### ledger header の三種、export link、停止した page（2026-09-27、ADR 0005 の amendment (b)）

2026-09-27 に owner の agent が一つの connection の live page を構造だけ（要素数、header label、link の形。値は記録しない）調べた。menu は `detailMonth` 0..8 の 9 link を持つ。

| `detailMonth` | ledger       | header label                                              | export link                | collector の扱い                              |
| ------------- | ------------ | --------------------------------------------------------- | -------------------------- | --------------------------------------------- |
| 0             | あり、行あり | `ご利用日 / ご利用先など / 支払区分 / ご利用金額`         | なし                       | `unconfirmed`、ledger を作る                  |
| 1、2          | あり、行あり | `ご利用日 / ご利用先など / 支払区分 / 今回のお支払い金額` | PDF、CSV、OFX（相対 href） | `confirmed`、ledger を作る、export は記録だけ |
| 3–6           | なし         | —                                                         | なし                       | `unknown`、page だけ                          |
| 7             | あり、空     | `ご利用日 / ご利用先など / 支払区分 / ご利用金額`         | なし                       | `unknown`、page だけ（欠落なし）              |
| 8             | あり、空     | `ご利用日 / ご利用先など お支払日 / 今後のお支払い金額`   | なし                       | `unknown`、page だけ（欠落なし）              |

確定月（1、2）の 4 番目の label は、保存された確定 page のすべてで `今回の<br class="pc-none">お支払い金額` と `br` で分かれている（round 5、2026-09-28。下の amendment (f)）。position 7 と 8 の「空」は、`content` 行が一つだけで、その `item-cell` に `div.cell.w-100per` 「ご利用明細はございません。」 が一つだけある形である。

同じ日の二度目の構造調査（round 4）で、position 7 と 8 が月ではないと分かった。menu の 9 link はすべて文言 「明細を見る」 で、DOM 順は 0、1、7、8、2、3、4、5、6。月名は link ではなく同じ box の見出しにある。0 と 1 は h2 「最新のご利用明細」、2〜6 は 「過去の明細」 の下にあり、これが月である。7 と 8 は h2 「ボーナス#回払い・ショッピングスキップ払い」 の下にあり、7 は ボーナス払い、8 は ショッピングスキップ払い（box に月名なし）の支払予定 page である。position 8 の page は h1 「ショッピングスキップ払いご利用明細(未確定分)」 を持つ。ledger はどの page でも `div.detail-list-01` の grid で、`<table>` ではない（collector も `<table>` に依存しない）。三つ目の header の live の `div.head` は 3 cell で、2 番目の cell が 「ご利用先など」 と 「お支払日」 を二行で持つ。最初の調査はこれを 4 label と書いた。

amendment (b) の時点の collector は `detailMonth` の position を数え、月と支払予定 page を区別しなかった。7 と 8 も月として取得、保存され、`periodCount` と `capturedMonthCount` に数えられ、読まなければ `unreadMonths` に入った。現在は menu の見出しで区別する（下の「credit menu の group と支払予定 page」、amendment (c)）。period は `detailMonth-7`／`detailMonth-8` の相対 label で、どの reader も暦月に解決しない（解決するのは `detailMonth-0` と `-1` だけ）。

**export link。** 確定月は `detailDbPdf.html?output=pdf`、`detail.html?output=csv`、`detail.html?output=money` を、`detailMonth` を名乗らない相対 href で持つ（月はその link がある page の月である）。以前の `discoverCreditExports` は href を origin だけに対して解決したので `/detail.html` になり、一度も一致しなかった。保存済みのどの run も export を 0 件と記録したのはこの bug で、「調べた connection はどの月にも export link を持たない」（上の明細状態の判定）は誤りだった。現在は detail page 自身の URL（`https://my.jcb.co.jp/iss-pc/member/details_inquiry/detail.html`）に対して解決するので、相対、`./`、root 相対、絶対の href が同じく読める。MyJCB の origin にあり、export の path（`/iss-pc/member/details_inquiry/` の `detail.html` か `detailDbPdf.html`）と `output`（`csv`、`money`、`pdf`）を持つ link を数える。観測どおり `detailMonth` を名乗らない link は、その link がある page の月の export とする。`detailMonth` を名乗る link は、その月をちょうど名乗る場合だけ数える（以前は `Number(null)` により、月のない link を month 0 のものとし、他の月では数えなかった）。

Worker は見つけた export を取得しない。共通 bucket は `credit-csv`／`credit-pdf`／`credit-ofx` を拒否する（`artifact_dataset_unobserved`）ので、取得すれば確定月のある run はすべて plan の段階で失敗し、terminal を書かない。そこで collector manifest の connection に `exportOffers: [{ position, kinds }]`（kind は `csv`、`pdf`、`ofx`）として記録するだけにした。offer は unit を `partial` にしない。確定明細でない page に export link があれば停止する規則（`credit_statement_state`）は変えておらず、発見を直したことで live page でも働くようになった。

**三つ目の header。** `ご利用日 / ご利用先など お支払日 / 今後のお支払い金額` は、読む二種の金額 label のどちらも持たない。ショッピングスキップ払いの支払予定 page でだけ観測されたので、code は `scheduled_payments_page` とした。行の意味は確認されていないので、statement としては読まない（ADR 0004）。header の文字列から空白を除いたものに `ご利用日`、`ご利用先など`、`お支払日`、`今後のお支払い金額` がすべてあり、`支払区分`、`今回のお支払い金額`、`ご利用金額` のどれもない header をこの型とみなす（`scheduledLedgerRowCount`）。cell 単位では比べないので、観測された 3 cell の形も 4 cell の形も同じく読む（どちらも行は読まない）。

- 行があれば、どの position でもその position を「取得したが読まない」ものにする。状態を読む前に判定し、page を `unknown` の evidence として（amendment (h) 以降は period なしで）保存し、ledger を作らず、export も取得せず、次の月へ進む。以前は、position 0 では未確定 header 一式がないので `ledger_parse`、position 1 では見出しなしなら `credit_statement_state`、見出しがあればどの position でも確定 header 一式がないので `ledger_parse` で停止し、見出しのない position 2 以降だけは状態を示さない行として読まずに進んだ（現在の `rows_unstated`）。
- 同じ page に別の ledger があっても、月全体を読まない。
- 空なら何も欠けないので、従来どおり読む（position 8 の観測どおり）。
- 三種のどれでもない header で行があれば、従来どおり停止する。
- 月の position の page にこの header の行があれば、connection は `partial` で、run は parse されない。行が月の明細にも現れるかは観測されていないので、欠落として扱う（INV05）。menu が支払予定 page として示す position は月ではなく、この規則の対象外である（下の amendment (c)）。

読まない月は manifest の connection に `unreadMonths: [{ position, code }]` として書く。code は閉じた一覧（`UNREAD_MONTH_CODES`）で、`scheduled_payments_page`（三つ目の header）と `rows_unstated`（position 2 以降で状態を示さない page の行。以前から数えていたが名前がなかった）である。読まない月のある connection は `partial` になる。読まない月がすべて `scheduled_payments_page` で、connection が止まっていなければ unit の `safeErrorCode` は `scheduled_payments_page`、それ以外は従来どおり `collector_partial` である。manifest の `failures` には書かない（停止ではない）。log は `myjcb-credit-month-unread` に position と code だけを出す。registration と eligibility は変えない。unit report は `failed`、run は `partial`、`not_eligible` で、読まない page は catalogue と seal はされるが、どの parser も読まない。

**停止した page。** `credit_statement_state`、`credit_statement_period`、`ledger_parse` で止まった場合、止まった月の page を redact して `credit-detail`（状態 `unknown`、ledger なし、export なし。amendment (h) 以降は period なし）として保存する。redaction は script や属性を除くが本文は残すので、保存した他の明細 page と同じく、ledger の後の 「カード情報」 の表も残る。`capturedMonthCount` はそれより前の月の数のままで、`stopPosition` がその page の月を示す。停止 log には `stopPageKept` を加えた。statement page として読めなかった page（`month_parse`）は従来どおり保存しない。

**menu が先。** `detailMenu.html` を経ずに `detail.html?detailMonth=N` を取得すると別の page（h1 `カードご利用明細一覧`、ledger なし）が返り、menu を経ると明細 page が返ることが観測された。`collectCredit` は同じ session で `detailMenu.html` を一度読み、最初の月、過去月 API、残りの月の順に読む。この順序は以前からで、test で固定した。

**通信エラー page。** 連続して取得すると 「通信エラーが発生しました」 の page が返ることが観測された（回数や解除の条件は不明）。provider による停止として記録するが、collector は判定しない。page の構造が記録されておらず、通常の page が同じ文言を（隠れた dialog などで）持つかも分からないため、判定規則は推測になる。最初の明細 page として返れば識別子がないので月の前で止まる（`credit_first_detail`）が、それ以降の月に返れば ledger のない `unknown` の月として保存され、欠落なしと読まれる。

制限：

- 2026-09-25 と 09-26 の run は position 1 で `credit-ledger-headers` により止まり、artifact を残さなかった（最初の amendment の前）。09-27 の live の position 1 は確定の形で、通るはずである。position 1 の page の形は時刻か session によって変わる。その夜の page は保存されていないので、原因は確かめられない。以前の run が保存した position 1 の page（round 4 で label の数だけを数えた）は `(確定分)` の見出しを持つが `今回のお支払い金額` をどこにも持たず、`ご利用金額` だけを持つ。この ADR の規則は、行のあるこの形の page で停止する（確定の ledger は確定 header 一式を表示しなければならない、`ledger_parse`）ので、これが最も考えられる原因だが、確認はされていない。次に同じ停止が起きれば、停止した page が保存される。**訂正（2026-09-28、amendment (f)）：** この数え方は文字列一致の誤りだった。`ご利用金額` は各行の展開部（`item-more`）の label で、`今回のお支払い金額` が 0 回だったのは head の label が `br` で分かれていたためである。停止の原因は collector の header 照合（下の amendment (f)）だった。
- 三つ目の header の行の意味、export の中身（2026-08-31 に確認、保存はしない）、menu を月ごとに読み直す必要があるかは未確認である。

### credit menu の group と支払予定 page（2026-09-27、ADR 0005 の amendment (c)）

round 4 の構造調査で、credit menu（`detailMenu.html`）の 9 link は三つの見出しの下の card box にあることが分かった（round 4 はこれを三つの `h2` と記録したが、round 9 で支払予定の見出しは `h3` と分かった。下の amendment (j)）。link の文言はすべて 「明細を見る」 で月名を持たないので、月か支払予定 page かは見出しだけが示す。

| 見出し（空白を除いて比較）                    | position（観測） | collector の扱い                                                                                          |
| --------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| 「最新のご利用明細」                          | 0、1             | 月。unit の coverage に入る                                                                               |
| 「過去の明細」                                | 2–6              | 月。unit の coverage に入る                                                                               |
| 「ボーナス#回払い・ショッピングスキップ払い」 | 7、8             | 支払予定 page。保存する。ショッピングスキップ払いの page だけを読む（amendment (e)）。coverage に入らない |
| 上のどれでもない見出し、見出しの前の link     | —                | `credit_menu_group_unrecognized` で最初の月の前に停止する                                                 |

`#` は数字で、調査は値を記録していない。collector は 1 桁以上の数字（半角か全角）を受け入れ、それ以外の文字は完全一致で比べる。link は文書順でその前にある最後の `h2` か `h3` に属する（amendment (j) から。それまでは `h2` だけを見ていた）。`/iss-pc/member/details_inquiry/detail.html` への `detailMonth`（1–2 桁）付きの link だけを数え、menu の URL に対して解決する（相対、root 相対、絶対の href を同じく読む）。同じ position が両方の group にある場合も停止する。停止 log（`myjcb-credit-menu-groups`）は link の数だけを出し、見出しの文字列は出さない。

- **月**：月の group の position と、過去月 API が available とした position を従来どおり読む。`periodCount` と `capturedMonthCount` は月だけを数える。過去月 API が支払予定 page の position を available とした場合は（観測されていない）、どちらとも決めず `credit_past_months` で停止する。
- **支払予定 page**：最後の月の後に昇順で一度ずつ取得し、何を表示していても redact して丸ごと `credit-schedule-NN.html`（dataset `credit-schedule`、状態 `unknown`、period `detailMonth-N`）として保存する。行、状態、link は読まない。`credit-detail-NN.html` ではないので registration はどの parser dataset も与えず、catalogue と seal だけされ、parse job は作られない。（amendment (e) から、h1 がショッピングスキップ払いの page だけは `credit-skip-payment-NN.html` として保存し、parser が読む。下の節を参照。）collector manifest の connection には `schedulePages: [{ position, code }]`（code は `scheduled_payments_page`＝保存した、`schedule_page_fetch`＝取得か decode に失敗し何も保存しなかった）と `schedulePageCount`（保存した数）を書く。取得の失敗は停止ではなく、`failures` にも `unreadMonths` にも入らない。log は `myjcb-credit-schedule-page-failed` に position と code だけを出す。月で停止した connection は支払予定 page を読まない。
- **coverage**：月をすべて丸ごと読めば connection は `success`、unit は `complete` で、支払予定 page に行があっても、取得に失敗しても変わらない。以前は position 8 に行があるかぎり unit が `partial` になり、MyJCB の run は一つも parse されなかった。

制限：支払予定 page の行の意味は未確認で、amendment (c) の時点ではどの parser も読まなかった（ショッピングスキップ払いの page は amendment (e) で独自の dataset として読む）。position 7（ボーナス払い）は行のある状態では観測されていない。保存される menu は redact で `href` を除くので、保存された menu からはどの link がどの position かは読めない。見出しが変われば、新しい見出しを観測して記録するまで connection は最初の月の前で止まり、何も保存しない。

### 確定分の見出しとご利用金額のheader（2026-09-27、ADR 0005 の amendment (d)）

**訂正（2026-09-28、amendment (f)）：** 次の段落の観測は文字列一致の誤りだった。保存されたどの確定 page も head は `今回の<br class="pc-none">お支払い金額` で、`ご利用金額` の head を持つ確定 page は観測されていない（ADR 0004 では未観測の形）。この節の受け入れ規則は code に残るが、production のどの page も通っていない。残す理由は、削除すると共有 module（`myjcb-statement-page.ts`）の digest が変わり、観測を何も変えずに MyJCB の四つの parser すべての新 release と再 parse が必要になるためである。次に MyJCB の parser を別の理由で release するときに削除する。

round 4 の構造調査（label の数だけ、値は記録しない）で、以前の run が保存した position 1 の page は `(確定分)` の見出しの下に未確定の header 一式（`ご利用日 / ご利用先など / 支払区分 / ご利用金額`）を持ち、`今回のお支払い金額` は 0 回だった。同じ日の live の同じ position は確定の header だった。どちらの label を出すかは夜か session によって変わり、その理由は分からない。page 自身は合計を `div.detail-box-price-01 dl` の dt 「YYYY年M月D日(曜)お支払い金額合計」 と dd 「#,###円」 で示す。

4 番目の label は summary の金額が何かを示す。`今回のお支払い金額` ならその明細の支払額、`ご利用金額` なら利用額である。分割、リボ、ボーナスの行では二つが異なるので、label だけでは `ご利用金額` を支払額と読めない。そこで owner は、page 自身が証明する場合だけ受け入れると決めた（`readMyJcbStatementPage` の `usageHeader`）。

| header の組み合わせ        | 条件                                                | 状態                                      | ledger に保存する header          | 行の金額                                                |
| -------------------------- | --------------------------------------------------- | ----------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| h1 と `今回のお支払い金額` | なし                                                | `confirmed`                               | 確定の一式                        | 今回のお支払い金額（`current-statement-payment`）       |
| h1 と `ご利用金額`         | 全行が1回払い、かつ行の合計がお支払い金額合計に一致 | `confirmed`                               | 未確定の一式（page が示すとおり） | ご利用金額（`confirmed-usage`）。行の支払額は記録しない |
| h1 と `ご利用金額`         | 上記を満たさない                                    | 停止（`credit-statement-state`）          | —                                 | —                                                       |
| h1 なし、`ご利用金額`      | なし                                                | 従来どおり（position 1 は `unconfirmed`） | 未確定の一式                      | ご利用金額（`unconfirmed-usage`）                       |

- **支払区分。** 行の支払区分は、card purchase recognition と同じ規則（`packages/domain/src/myjcb-amounts.ts` の `myjcbSinglePayment`）で、`summaryCells[1]` の 「ご利用先など／支払区分」 の結合 cell から読む。支払回数が一つ以上あり、すべて 1 で、`分割`、`リボ`、`ボーナス`、`キャッシング` を含まないことが条件である。書き方は `1回払`（production の全行）、`1回払い`、`一回払い` と全角数字で、新しい label は加えていない。満たさない行、支払区分のない cell、空の cell、4 cell で読めない行があれば `usage_header_payment_type_unproven` で拒否する。
- **合計。** 行の金額は、3 番目と 4 番目の cell のうち exact な円として読める一つ（ledger parser と同じ読み方）である。`sumQuantities` で exact に足し、page の一つの 「…お支払い金額合計」 と比べる。合計がない、二つ以上ある、読めない場合は `usage_header_total_missing`、行の金額が読めない、または合計と一致しない場合は `usage_header_total_mismatch` で拒否する。返金行は符号付きで足す。行のない ledger は合計 0 だけを証明する。
- **行の場所。** 行はすべて最初の `detail-list-01` になければならない。collector が保存する ledger はそれだけなので、ほかの `detail-list-01` に行があれば、合計が一致しても `usage_header_rows_outside_first_ledger` で拒否する（保存した ledger に行が欠けたまま合計を公開しないため）。行のない二つ目の ledger は影響しない。この確認は支払区分と合計より先に行う。
- 拒否の理由は閉じた code（`USAGE_HEADER_REFUSALS`）で、停止 log に `usageHeader` として出す。金額や provider の文字列は log に出さない。
- `myjcb-credit-ledger@1.2.0` はこの ledger の金額を利用額として読み（`usageAmountText`）、`paymentAmountText` を記録しない。card purchase recognition は利用額と支払額の一致を必要とするので、この行は `payment_split_unknown` で除外され、pending-to-posted の照合にも使われない。明細の支払額は page の合計で、`myjcb-credit-statement-total@1.2.0` が `statementStateBasis: "page-heading-usage-total-proof"` と `ledgerAmountLabel: "ご利用金額"` を付けて公開する。確定の header の page は 1.1.0 と同じに記録する。
- 制限：保存した page の二つ目の `detail-list-01` が明細の一部かは分からない。ledger artifact は従来どおり最初の ledger だけを保存するので、二つ目に行があればその page は証明されず、従来どおり停止する。行ごとの支払額を利用額とみなさない理由は ADR 0005 の amendment (d) にある。この page の展開 label は数えただけで、行ごとには読んでいない。2026-09-25/26 の停止の原因がこの形であることは、可能性が高いが確認されていない。

### ショッピングスキップ払いの支払予定（2026-09-27、ADR 0005 の amendment (e)）

round 4 の構造調査で、position 8 の page は h1 「ショッピングスキップ払いご利用明細(未確定分)」、見出し 「YYYY年M月D日(曜)時点のショッピングスキップ払いご利用明細(YYYY年M月以降のお支払い分)」、`div.detail-list-01` 一つ（`div.head` は 3 cell：「ご利用日」 / 「ご利用先など」と「お支払日」を 2 行で持つ 1 cell / 「今後のお支払い金額」）と本文 2 行を持っていた。本文の cell の中身と数は記録されていない。owner は、行のある状態で観測されたこの page だけを独自の dataset として読むと決めた。

- **保存名。** collector は支払予定 page の h1 だけを見る（`schedulePageKind`）。空白を除いて 「ショッピングスキップ払いご利用明細(未確定分)」 に一致する h1 がちょうど一つなら `credit-skip-payment-NN.html`、それ以外（ボーナス払いの page、見出しがない・二つある・全角括弧など）は従来どおり `credit-schedule-NN.html` として保存する。ボーナス払いの h1 は amendment (j) から種類 `bonus` として認識するが、保存名は `credit-schedule-NN.html` のままである。manifest、code、coverage は変わらない。
- **registration。** `credit-skip-payment-NN.html` だけが dataset `credit-schedule` を得る。`credit-schedule-NN.html` は dataset なしで、parse job は作られない。
- **parser。** `myjcb-skip-payment-schedule@0.1.2`（amendment (f) と (k)、観測は 0.1.0 と同じ）は観測された形だけを読む。h1、行がある場合の as-of 見出し（一つ、暦上の日付と月）、行のある ledger が一つ以下、head が観測どおりの 3 cell、ledger の子要素が head とそれに続く `content` 行だけ（ほかの入れ子の行は空の ledger と読まずに拒否する）、各行が 3 cell の `item-cell` 一つで中央の cell がちょうど 2 行（1 行目がご利用先など、2 行目がお支払日）、日付が `YYYY/MM/DD`、金額が exact な円。本文の配置は記録されていないので、head と同じ配置だけを読む。それ以外は閉じた code（`SKIP_PAYMENT_SCHEDULE_PARSER_CODES`）で拒否し、message はその code だけである。行のない ledger は 0 行で、失敗ではない。空の ledger は、`content` 行が一つだけで、それが観測された空の行（`item-cell` 一つ、その中に `div.cell.w-100per` 一つ、空白を除いて 「ご利用明細はございません。」。または、その `item-cell` が reader の class を持たない `div` 一つに包まれた形。amendment (k)）の場合に限る。空の行がほかの行と並べば、未観測の組み合わせとして `schedule_row_shape_unobserved` で拒否する。kind が `types.ts` の外で宣言されているので、processor が書き込む前に `scheduled_payment` の行を検査する（`scheduledPaymentRows`: このパーサー以外からの行、宣言外の key、暦上でない日付、正準でない整数の金額などは `parse_contract_invalid`）。
- **観測。** 各行は `scheduled_payment` の観測として `scheduled_payment_observations`（migration 0061、append-only）に入る：ご利用日、お支払日（`due_date`）、今後のお支払い金額（exact な整数の decimal 文字列、表示の符号）、ご利用先など（`counterparty`）、page の as-of 日付、`extra_json` に表示 cell と 「YYYY年M月以降のお支払い分」 の月。external id は表示 cell の fingerprint と出現順で、as-of 日付を含まない。
- **読むもの。** 取引でも残高でもないので、read path、card purchase recognition、settlement の候補、identity はこの table を読まない。二重計上はない（INV06）。

制限：行の金額が何を表すか（一回分か残額か）、行の支払いが後の明細月に現れるかは未確認で、明細や支払いと突き合わせない。read model、API、UI はまだ表示しない。この変更の前に保存された skip page は `credit-schedule-NN.html` のままで読まれない。本文の配置が違えば（行ごとの展開 list、4 cell、お支払日が別 cell など）最初の production の parse が `schedule_row_shape_unobserved` で失敗し、構造だけの調査の後に新しい release を出す。position 7（ボーナス払い）は行のある状態で観測されるまで読まない（ADR 0004）。

### ledger header の改行と空の支払予定 page（2026-09-28、ADR 0005 の amendment (f)）

round 5 の構造調査（保存された R2 object を構造と件数だけ読んだ。値は記録しない）と collector の停止 log で、次が分かった。

| page                                          | h1                                                       | head（3 cell）                                                                          | 本文                                                                     |
| --------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 確定月（保存 8 page すべて）                  | 「カードご利用代金明細(確定分)」                         | 「ご利用日」 / 「ご利用先など」+「支払区分」 / `今回の<br class="pc-none">お支払い金額` | 4 cell（日付、中央の 2 行、金額、toggle button）の行、全行に `item-more` |
| 未確定月（position 0）                        | 「…(未確定分)」                                          | 「ご利用日」 / 「ご利用先など」+「支払区分」 / 「ご利用金額」（`br` なし）              | 確定月と同じ形                                                           |
| ボーナス払い（position 7、12 夜同一）         | 「ボーナス#回払いご利用代金明細(未確定分)」（# は 1 桁） | 「ご利用日」 / 「ご利用先など」+「支払区分」 / 「ご利用金額」                           | 空の行だけ                                                               |
| ショッピングスキップ払い（position 8、12 夜） | 「ショッピングスキップ払いご利用明細(未確定分)」         | 「ご利用日」 / 「ご利用先など」+「お支払日」 / 「今後のお支払い金額」                   | 空の行だけ                                                               |

中央の cell は `span.row` 二つである。空の行は `div.content > div.item-cell > div.cell.w-100per` 「ご利用明細はございません。」 で、`item-more` はない。確定月の page の `detail-list-01` は一つだけで、HTML に二度出る文字列の一つは一括表示 button（`ul.list-btn-double.js-toggle-detail-list-01`）の class 名である。

- **停止の原因。** 2026-09-25〜27（UTC）の三夜の run は position 1 で `ledger_parse`（`credit-ledger-headers`）により止まった。collector の `nodeText` は子 node を空白でつなぐので、確定月の header は 「今回の お支払い金額」 と読まれ、`今回のお支払い金額` を含まなかった。collector は label（ledger header、menu と明細月の h2）を、空白をすべて除いた文字列（`compactText`）で比べるようにした。共有の page 読み取り（`readMyJcbStatementPage`）と `myjcb-credit-statement-total` は以前から空白を除いて比べていたので、同じ page を確定と読んでいた。空白以外の違いは従来どおり停止する。ただし `nodeText` は要素の境目に空白を入れるので、境目も除かれ、要素（head の隣り合う cell を含む）をまたいで分かれた label も一致する（共有の page 読み取りと同じ）。cell の値は従来どおり空白でつないだ文字列で保存する。
- **空の支払予定 page。** `myjcb-skip-payment-schedule@0.1.1` は上の空の行だけの ledger を 0 行と読む。collector の行数（`scheduledLedgerRowCount`）も空の行を数えない。ボーナス払いの page は行のある状態で観測されていないので、従来どおり `credit-schedule-07.html` として保存し、読まない。
- **release。** `myjcb-skip-payment-schedule` 0.1.0 は production の `parser_releases` に登録済み（parse run はない）で、同じ version で digest を変えると migration 0028 が登録を拒否するので 0.1.1 とした。MyJCB の四つの parser の digest は変わらない。

制限：行のあるショッピングスキップ払い page の本文は保存されておらず、未観測のままである（amendment (e)）。行と空の行が並ぶ page は観測されていない（並べば拒否する）。

### 支払日つきの明細見出し（2026-09-28、ADR 0005 の amendment (g)）

amendment (f) の後の最初の夜間 run（2026-09-28 21:01Z）は、position 1 で `credit_statement_period` により止まった。round 5 の構造調査（値は記録しない）では、確定月の page の h2 は 「YYYY年MM月DD日(曜)お支払い分のカードご利用明細」 で、お支払い分の前に支払日と括弧つきの曜日一文字がある。ボーナス払い page の h2 も同じ日付つきの形である。collector と明細 total parser は 「YYYY年M月お支払い分のカードご利用明細」 だけを読んでいたので、page は月を名乗らないと読まれ、過去月 API の label がない position 1 で停止した。それ以前に保存された確定 page は日付のない形である（`myjcb-credit-statement-total@1.2.0` の 24 件の `ok` parse はすべてこの形で通った）。二つの形が両方観測されている。

- **読み取り。** `packages/domain/src/myjcb-statement-heading.ts` の `readMyJcbStatementHeading` を collector と parser が共用する。空白をすべて除いた h2 の文字列が、日付のない形か、`YYYY年M月D日(W)お支払い分のカードご利用明細`（W は 月火水木金土日 の一文字、ASCII の括弧）に完全一致する場合だけ見出しとする。page の total label（「YYYY年M月D日(曜)お支払い金額合計」）と同じく NFKC はかけない。月は 1〜12、日はその月に実在する日でなければならない。曜日は形だけを見て、日付との一致は確かめない。全角の括弧、曜日の別表記、ほかの文言は見出しではなく、確定 page なら従来どおり停止する。
- **collector。** 見出しの月を `YYYY-MM` として period に記録する。日付は記録しない。見出しが二つ（日付つきと日付なしを含む）なら停止する。
- **明細 total（`myjcb-credit-statement-total@1.3.0`）。** 日付つきの見出しなら、その日付が total の支払日と一致しなければ parse を失敗させる。日付のない見出しの page は 1.2.0 と同じに記録する。
- **release。** 四つの MyJCB parser は `packages/parsers/src/parsers/myjcb.ts` を共有しているので、ほかの三つも digest だけが変わる：`myjcb-credit-ledger@1.2.1`、`myjcb-credit-past-month-balances@1.1.4`、`myjcb-canonical-evidence-boundary@1.1.4`。観測は変わらない。amendment (d) の未観測の経路はこの release でも残す。

制限：ボーナス払い page の日付つき h2 は読まない（page は `credit-schedule-07.html` のまま）。collector は見出しの日付を何とも比べない。**訂正（2026-10-04、amendment (j)）：** 実際には menu の読み取りが position 7 を月にしていたので、ボーナス払い page は `credit-detail-07.html` として保存され、明細 parser に読まれていた（total は出ていない）。下の amendment (j) を参照。

### 同じ page を示す複数の position と月として読まれたスキップ払い page（2026-09-29、ADR 0005 の amendment (h)）

amendment (g) の後の最初の夜間 run（collection run 561、fetch run 908、2026-09-29 21:03Z）は全月を読み、unit は `success`、ledger 5 件はすべて parse された。production は集計の query だけで読んだ（件数、SQL 内での digest の比較、閉じた code、position 番号。値は記録しない）。

- **四つの position が同じ page。** `credit-detail-NN.html` 11 件の digest は 8 種で、position 3、4、5、6 の page は byte 単位で同じ object だった。`myjcb-credit-statement-total@1.3.0` はこの 4 artifact で `manifest_artifact_ambiguous` の `error` になった（4 artifact × 3 回で 12 件。ほかの 7 page は `ok`）。共通 R2 の manifest は page を bytes で名指す（ADR 0025）。collector は各 page を `unknown`（`(確定分)` の見出しも行もない）と読み、period に position の label（`settlementYM ?? detailMonth-N`）を書いたので、同じ bytes の 4 entry の period が食い違い、extractor は選ばずに止めた。
- **provider が同じ page を示している。** 以前の 12 run（fetch run 215–719、importer 形の manifest は entry を file 名で名指すので曖昧にならなかった）では、どの run でも position 2–6 が一つの object だった（60 artifact、12 run を通じて digest 一つ、状態 `unknown`、period は各 position の label）。run 908 では position 2 が別の確定明細になり、group は 3–6 になった。締まった明細が移ってきた position だけが抜けている。collector は各 position を menu の後に同じ session で、それぞれの `detailMonth` で取得し、同じ run で group の後に読んだ position（7、8、11、14）は別々の page で、11 と 14 は ledger のある確定明細だった。round 4 の調査は position 3–6 を ledger なしと記録し、menu の 「過去の明細」 の box は 「… お支払い分 #円」 か 「ご請求はありません」 だった。したがって collector の遷移の誤りではなく、請求のない過去の position に provider が示す page で、page 自身は月を名乗らない。
- **スキップ払い page が月として読まれた。** MyJCB の `credit-schedule-NN.html`／`credit-skip-payment-NN.html` は一件も登録されていない（0 行）。run 908 では position 7 と 8 が `credit-detail-07.html`／`credit-detail-08.html`（月）として保存され、`credit-schedule` dataset も `myjcb-skip-payment-schedule` の parse run もない。どちらも行のない `unknown` と読まれたので unit は `success` のままで、明細 parser は両方に `statement_total_not_confirmed` を記録した。position 8 は保存された 13 run すべてで digest が違い（スキップ払い page の時点見出しは日付を持つ）、position 7 は以前の 12 run で digest 一つ（ボーナス払い page、amendment (f)）である。deploy された Worker は `readCreditMenuGroups` を含み、menu の group の読み取りも過去月 API との重複の確認も止まらなかった。したがって、その夜の menu が 7 と 8 の link を月の見出しの下に置いた（たとえば支払予定の見出しが `h2` でなく、観測された DOM 順 0、1、7、8、2–6 で前にある 「最新のご利用明細」 の下に入った）か、menu が 7 と 8 を示さず過去月 API が available とした、のどちらかである。保存される menu には `href` がなく、manifest と過去月 response は R2 の bytes で読んでいないので、どちらかは分からない。

collector は page が述べることだけを記録する（`collectCredit`）。

- **`unknown` の page は period を書かない。** `unknown` と記録する `credit-detail`（状態を示さない月、読まない月、停止で保存する page）の manifest entry には `period` がない。position は artifact key に、過去月 API の label は `credit-past-months.json` に残る。状態のある page の period（未確定は `detailMonth-0`／`-1`、確定は名乗る月か過去月 API の label）と ledger は変わらない。`unknown` の page の period を読むものはない（read model は ledger だけを読み、明細 parser は確定 page でだけ period を比べる）。同じ bytes はどの position でも同じことを述べるので、extractor はそのまま読む。
- **一つの page は一つのことを述べる。** connection の中で、前の position で保存した page と redact 後の bytes が同じ月の page は、同じ状態と period でなければならない。違えば（たとえば同じ未確定 page が position 0 と 1 にあり、二つの未確定明細になる場合。観測されていない）その position で `credit_page_repeated`（condition `credit-page-repeated`）により停止し、その page は保存しない。それより前の月は保存する。log は position と code だけを出す。
- **月の position のスキップ払い page。** 月の page の状態を読む前に `schedulePageKind`（amendment (e)）を見る。h1 が観測された 「ショッピングスキップ払いご利用明細(未確定分)」 ちょうど一つなら、menu の支払予定 page と同じく `credit-skip-payment-NN.html`（dataset `credit-schedule`、状態 `unknown`、period `detailMonth-N`）として保存し、`schedulePages` に `scheduled_payments_page` として書き、`schedulePageCount` に数える。月ではないので `periodCount`、`capturedMonthCount`、`unreadMonths` に入らない。log は `myjcb-credit-month-schedule-page` に position と code だけを出す。`schedulePages` は position の昇順で、停止した場合は停止より前の月の position で見つけた支払予定 page を含む（menu の支払予定 position は従来どおり停止の後に読まない）。
- **変えないもの。** metadata extractor、menu の読み取り、ボーナス払い page（月の position では `credit-detail` の `unknown` の月のまま。amendment (j) で支払予定 page とした）、すべての parser。保存済みの run は書き換えない。run 908 の 12 件の `error` は履歴として残る（manifest は固定の evidence なので、再 parse しても同じ）。

制限と、owner の agent に頼む観測（構造と件数、真偽値だけ。値は記録しない）：

1. run 908 の保存済み `credit-detail-03.html`（03–06 は同じ bytes）：h1 の数と、各 h1 が 「カードご利用明細一覧」、「カードご利用代金明細(確定分)」、それ以外のどれか。本文に 「ご請求はありません」、「通信エラーが発生しました」、「ご利用明細はございません」 があるか（真偽値）。`detail-list-01` の数。h2 の数と、`readMyJcbStatementHeading` が読む形の h2 があるか（真偽値）。これで請求のない page か通信エラー page かが決まる。
2. run 908 の保存済み `credit-past-months.json`：`detailPastJsonInfo` の件数、`detailMonth` 7 と 8 の item があるか、ある場合の `detailAvailableFlag` と `payAmountDispFlag`（真偽値）。
3. live の `detailMenu.html`：`detail.html?detailMonth=N` の各 link について、N、文書順でその前にある最後の `h2` が三つの観測済み見出しのどれか（code で。文字列は記録しない）、その link の box の見出し要素の tag 名（`h2`、`h3`、`p` など）。支払予定の box の見出しが `h2` かどうか。

1 で通信エラー page なら、その page を認識する規則を決める（amendment (b) の制限）。2、3 で 7 と 8 が月になった経路が分かれば、menu の読み取りを直す。**回答（2026-10-04、round 9、amendment (j)）：** 1 は通信エラー page ではなく、月を名乗らない請求なしの page だった。3 で支払予定の見出しは `h3` で、`h2` だけを見る読み取りが 7 と 8 を 「最新のご利用明細」 に入れていた。下の amendment (j) を参照。

重複の確認は月の `credit-detail` page だけが対象である。支払予定 page の entry は position の label を period に持つ（`myjcb-skip-payment-schedule` が key と比べる）ので、同じスキップ払い page の bytes が二つの position（月の position 二つ、または月の position と menu の支払予定 position）で保存されると period が二つになり、extractor は両方を `manifest_artifact_ambiguous` で拒否する。観測されていない（position 8 の digest は保存された run ごとに違う）。

### 最初に保存されたスキップ払い page の拒否（2026-10-02、ADR 0005 の amendment (i)）

amendment (h) の後の最初の夜間 run（collection run 612、fetch run 956、2026-10-02 21:00Z）は 19 artifact で `success`、`myjcb-credit-statement-total@1.3.0` は 10 page すべて `ok` だった。初めて `credit-schedule` の artifact（月の position 8 の `credit-skip-payment-08.html`）が登録され、`myjcb-skip-payment-schedule@0.1.1` は `parser_rejected` の `error` になった（parse run 1 件、job は `failed`、`parse_issues` なし）。production は集計の query だけで読んだ。

- **metadata は parser の要求どおり。** key の形、状態 `unknown`、period が key の `detailMonth-N` と一致（metadata projection と artifact の行の両方）、media type、run の `success`。月の position と menu の経路は同じ関数（`schedulePageArtifact`）で同じ entry を書く。collector の不一致ではない。
- **HTML の境界は以前に通っている。** parser の境界の検査は明細 parser と一字一句同じで、明細 parser は以前の position 8 の 15 page（amendment (h) の前に月として保存された同じ page）すべてでそれを通した。
- **空の page である。** 大きさがその 15 page のそれぞれと 2 byte 以内（3 件とは同じ）で、round 5 の調査はそれらを空の page と記録している。

したがって、保存された空の page を reader の構造の検査のどれか（`schedule_head_unobserved`、`schedule_row_shape_unobserved`、空の行が認められない場合の `schedule_as_of_invalid` か `schedule_ledger_ambiguous`）が拒否した。どれかは R2 の bytes にあり、この変更では読んでいない。parser、collector、extractor は変えない（ADR 0004）。

counts-only の replay は MyJCB も選び、processor が読む extractor release（`active_releases` の行、なければ `legacy-metadata-v1`）の最新の完了した（`ok` か `absent`）metadata projection の状態と period を parser に渡し、スキップ払い page の構造（h1 の数、時点見出しの数、各 `detail-list-01` の子要素、head の子要素と三つの cell が期待どおりか、各 `content` 行の構造と件数。tag は閉じた一覧、class は reader が見るものだけ、文字列と属性値は出さない）を出す。

owner に頼む観測（一回の実行。出力は code、真偽値、件数、閉じた名前だけ）：

```sh
mise exec -- bun services/processor/scripts/replay-diagnostics.ts myjcb-skip-payment-schedule 1
```

出力の `category.reason`（閉じた code）と `shape` の行をそのまま共有してもらう。それで reader を観測された形に合わせる次の amendment（`myjcb-skip-payment-schedule` 0.1.2 と parser release の migration）を書く。それまでスキップ払いの `scheduled_payment` 観測はない。月には影響しない。

### menu の h3 見出しとボーナス払い page（2026-10-04、ADR 0005 の amendment (j)）

owner の live 調査（round 9。形、件数、固定の文言、真偽値だけで、値は記録しない）と、production の集計の query（round 7）で、amendment (h) の二つの問いが決まった。

- **menu の見出し。** h1 は二つ（logo と `hdg-H1` 「カードご利用明細一覧」）、h2 は五つ、h3 は四つ。`detail.html?detailMonth=N` の link は 9 個で、DOM 順は 0、1、7、8、2、3、4、5、6、文言はすべて 「明細を見る」。見出し要素の文書順は `h2.hdg-H2` 「最新のご利用明細」、**`h3.hdg-H3` 「ボーナス#回払い・ショッピングスキップ払い」**（# は数字）、`h2.hdg-H2` 「過去の明細」、その後に page 下部の案内の `h2`／`h3`（どの link よりも後）。各 box の前には `p.hdg` がある。最後の `h2` で group を決めると 7 と 8 は 「最新のご利用明細」 に入り、月になる。fetch run 908 で 07／08 が `credit-detail-07/08.html` として保存されたことと一致する。
- **ボーナス払い page（position 7）。** `h1.hdg-H1` は 「ボーナス#回払いご利用代金明細(未確定分)」（# は数字）。h2 は三つで、そのうち一つ（`hdg-H2`）が `YYYY年M月D日(曜)お支払い分のカードご利用明細` の形に完全一致する（amendment (g) の日付つき見出し）。`detail-list-01` 一つ、table 三つ、「ご利用明細はございません」 あり、`form` 一つ（method `get`、action のパス `/iss-pc/member/details_inquiry/detail.html`、hidden input なし）。h2 だけでは月の明細と区別できない。
- **ショッピングスキップ払い page（position 8）。** h1 は 「ショッピングスキップ払いご利用明細(未確定分)」。`hdg-H2` は `YYYY年M月D日(曜)時点のショッピングスキップ払いご利用明細(YYYY年M月以降のお支払い分)` の形で、日付つき見出しには一致しない。`detail-list-01` 一つ、table 二つ、「ご利用明細はございません」 あり、form は position 7 と同じ形。
- **請求なしの page（position 3–6）。** 応答の bytes が同一（SHA-256 が一致）で、月を示す要素がない。`h1.hdg-H1` 「カードご利用代金明細」（「(確定分)」 なし、「カードご利用明細一覧」 でもない）、本文に 「当該月の請求はございません」。h2 0 個、`detail-list-01` なし、table なし、form なし。「ご請求はありません」、「通信エラーが発生しました」、「ご利用明細はございません」 はいずれもない。HTTP 200、redirect なし。run 908、921、940 の 03〜06 の `manifest_artifact_ambiguous`（計 60 件の `error`）の原因はこの同一の内容で、amendment (h) の後の run 956 では明細 parser が 10 page すべて `done` だった。

collector と明細 parser の変更：

- **menu。** `readCreditMenuGroups` は link を文書順でその前にある最後の `h2` か `h3` の group に入れる。三つの見出しと比べ方（空白を除き、# は半角か全角の数字の並び、ほかは完全一致）は変えず、どちらの level でも同じ。見出しの前の link、ほかの `h2`／`h3` の下の link、両方の group にある position は従来どおり `credit_menu_group_unrecognized` で停止し、log は件数だけを出す。案内の見出しは link より後にあるので group に関わらない。すべて `h2` の形（amendment (c) の記録）も同じ group になる。
- **ボーナス払い page の h1。** `packages/domain/src/myjcb-schedule-page-kind.ts` の `myjcbSchedulePageHeadingKind` は、amendment (e) の判定（スキップ払いの h1 ちょうど一つ。先に見る）が当てはまれば `skip-payment`、そうでなく空白を除いた h1 が `ボーナス[0-9０-９]+回払いご利用代金明細\(未確定分\)` に一致するものがちょうど一つなら `bonus`、それ以外は `unobserved` を返す。`myjcb-skip-payment-schedule` の digest を動かさないよう別の module にした。collector の `schedulePageKind` はこれを読む。
- **collector。** `bonus` の page は `credit-schedule-NN.html`（dataset `credit-schedule`、状態 `unknown`、period `detailMonth-N`）として保存する。registration はこの名前に parser dataset を与えないので、どの parser も読まない（ADR 0004）。支払予定の position ではこれまでと同じ。月の position では、amendment (h) のスキップ払い page と同じく状態を読む前に支払予定 page として保存し、`schedulePages` に `scheduled_payments_page` と書き、`schedulePageCount` に数え、`periodCount`、`capturedMonthCount`、`unreadMonths` には入れない。log は `myjcb-credit-month-schedule-page` に position と code だけを出す。
- **明細 total（`myjcb-credit-statement-total@1.4.0`）。** HTML の境界の検査の後、状態を読む前に、h1 の種類が `skip-payment` か `bonus` の page を、h2、`(確定分)` の h1、total が何を示していても、観測なしの `ok` と閉じた warning `schedule_page_not_statement` にする。ほかの page は 1.3.0 と同じに読む。`error` にしないのは、`error` の parse run は以前の version の `ok` run を置き換えないからである。
- **release。** 四つの MyJCB parser は `myjcb.ts` を共有するので、`myjcb-credit-ledger@1.2.2`、`myjcb-credit-past-month-balances@1.1.5`、`myjcb-canonical-evidence-boundary@1.1.5` は digest だけが変わる。`myjcb-skip-payment-schedule@0.1.1` の digest は変わらない。processor が deploy された release を `parser_releases` に自分で登録し、MyJCB の parser version を固定する migration はないので、migration は追加しない（1.3.0 と同じ）。
- **請求なしの page。** 変えない。`(確定分)` の h1 も ledger もないので `unknown` と読まれ、明細 parser は 1.3.0 でも 1.4.0 でも観測なしの `ok` と `statement_total_not_confirmed` を記録する。0 円の total は出さない（INV05）。collector は amendment (h) のとおり、各 position に period なしの `unknown` の page として保存する。

production への影響（制限として）：保存済みの `credit-detail-07.html` はすべてボーナス払い page で、月として登録されている（position 7 を保存した run 215–719 の 12 run、run 908、この deploy までの以後の run。run 956 の 10 明細 page にも含まれる。run 921 と 940 は position 別に数えていない）。amendment (h) の前に保存された `credit-detail-08.html`（スキップ払い page）も同じである。どれも 1.3.0（2026-09-29 以降。それ以前は前の version）で観測なしの `ok` と `statement_total_not_confirmed` になり、total は出ていない（`(確定分)` の h1 がない）。ただし公開されている読みは明細の読みで、ボーナス払い page の日付つき h2 と total の間には h1 の規則しかなかった。deploy は何も書き換えない。repair lane が保存済みの page を 1.4.0 で再 parse し、その `ok` run（`schedule_page_not_statement`）が各 artifact の 1.3.0 の `ok` run を置き換えて公開の pointer を持つ（`publishBatch`）。read model から見える観測は変わらない（どちらも観測なし）。run 908、921、940 の `manifest_artifact_ambiguous` の artifact は、manifest が固定の evidence なので 1.4.0 でも失敗のままである。対象の artifact の数は数えていない。

制限：round 9 の menu は一つの connection の一夜である。支払予定の見出しの level が変わる、または案内の見出しが link より前に移ると、connection は最初の月の前で止まる（推測しない）。ボーナス払い page は行のある状態でまだ観測されていない。請求なしの page を認識する独自の規則はなく、`(確定分)` の h1 も ledger もないので `unknown` になる。

### 一段深い空の行（2026-10-08、ADR 0005 の amendment (k)）

owner は、2026-10-06 の夜間 run で保存されたスキップ払い page 一件（artifact 11644。`myjcb-skip-payment-schedule@0.1.1` が `schedule_row_shape_unobserved` で拒否した）を、SHA-256 と大きさで特定して読み、構造、件数、真偽値だけを共有した。文字列、値、provider の class 名は共有されておらず、ここにも記録しない。

- **page。** スキップ払いの h1 ちょうど一つ、`detail-list-01` 一つ（子要素は `div.head` とそれに続く `content` 行だけ）、head は観測どおりの 3 cell。ここまでは空の page として知られた形である。
- **行。** `content` 行は一つで、`div.content > div > div.item-cell > div.cell.w-100per` である。間の `div` は reader が見る class（`detail-list-01`、`head`、`content`、`item-cell`、`cell`、`w-100per`）をどれも持たない。どの段も子要素はちょうど一つで、cell は子要素を持たない。行から cell までのどの段も、空白を除いた文字列がちょうど 「ご利用明細はございません。」 である。amendment (f) の空の行が一段深くなった形で、0.1.1 は `item-cell` が行の直接の子であることを求めたので、行として数えて拒否した。
- **parser（`myjcb-skip-payment-schedule@0.1.2`）。** `isEmptyLedgerRow` がこの形も空の行と読む。規則は amendment (f) と同じで、ledger の `content` 行が一つだけのときに限り 0 行、ほかの行と並ぶ、または二つあれば `schedule_row_shape_unobserved` で拒否する。包む `div` が二段以上、包む要素が `div` でない、reader の class を持つ、ほかの子要素や文字列を持つ、別の文言、cell の中の要素、データ行を包んだ形は拒否する。データ行は従来どおり、包まれない 3 cell の `item-cell` だけを読む。拒否の code は増やさない。観測は 0.1.1 と同じ。判定は reader の既存の helper（`children`、`hasClass`、`text`、`compact`）で書き、別の module や依存は足さない。
- **release。** reader の module は h1 の判定（amendment (j) の `myjcb-schedule-page-kind.ts`）を通じて四つの MyJCB 明細 parser の digest に含まれる。そのため `myjcb-credit-ledger@1.2.3`、`myjcb-credit-past-month-balances@1.1.6`、`myjcb-credit-statement-total@1.4.1`、`myjcb-canonical-evidence-boundary@1.1.6` は digest だけが変わり、どの page も前の release と同じに読む。processor が release を自分で登録するので migration は追加しない。
- **collector。** 変えない。共有の明細の読み取りは行の下のどの深さの `item-cell` も見るので、この行をすでに 0 行と数えていた。page は h1 で保存される。

deploy は何も書き換えない。repair lane が保存済みの artifact を五つの新しい release で読み直すと、この形のスキップ払い page は観測なしの `ok` になり、明細の artifact は同じ観測の `ok` run が前の run を置き換える（件数は数えていない）。

制限：読んだのは一件だけで、ほかの保存済みスキップ払い page（amendment (i) の最初の一件を含む）がこの形かどうかは確かめていない。round 5 の要約がこの `div` を省いたのか、その後に page が変わったのかも分からない。ほかの形は従来どおり拒否する。行のある page は未観測のままである。production での replay と deploy はこの変更では確かめていない。

## カード情報（引落口座）（2026-09-27、ADR 0032 の amendment）

round 4 の観測（構造と件数のみ）: 確定明細（`detail.html?detailMonth=N`）とショッピングスキップ払いの頁（位置 8）には「カード・お振替情報」という見出しはなく、引落口座は明細グリッドの後の `h3.hdg-H3`「カード情報」の下、`div.detail-lyt-02.border-01 > div.col-01 > table.table-data`（th/td の縦表）にある。行は カード名称、カード発行会社、金融機関名（銀行名）、支店名（支店名。支店番号はない）、科目・口座番号（「普通 ####\*\*\*」の形: 科目、空白、口座番号の**先頭** 4 桁、残りは `*`）、口座名義（一部 `*` の名義）。同じ表は保存済みの redacted HTML（`credit-detail-NN.html`）にも同じ形で残っている。

- 読み取り: `readMyJcbCardInformation`（`packages/domain/src/myjcb-card-information.ts`）が金融機関名、支店名、科目、先頭 4 桁、`*` の数だけを読む。カード名称と口座名義の値は読まない（使う処理がない。保存 HTML は口座名義を表示どおりに残す。ADR 0029 の amendment 2）。表は class 名ではなく、本文が「カード情報」の見出し要素（h1–h6）とその後の最初の table、th の label で探す。他の形は closed code で拒否する。
- 保存: processor の `card_debit_account_sweep` lane が、`myjcb-credit-statement-total` の parse が公開済みの頁を R2 から読み直し、`card_debit_account_statement`（migration 0060、append-only）へ card・raw object・reader version ごとに 1 行書く。
- 利用: 決済照合の候補に evidence として付くだけで、候補の facts・適格性・承認は変わらない（[card-settlements.md](../card-settlements.md#provider-stated-debit-accounts)）。
- collector は変更しない。頁はすでに redacted HTML として保存されており、collector が読む必要はない。
