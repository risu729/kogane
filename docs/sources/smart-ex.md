# Smart EX source research

調査日: 2026-08-26（公開情報、ログアウト状態の公開 endpoint/JavaScript、公開第三者実装）、
ユーザー会員情報を使う live 検証は未実施

## 1. 対象範囲と安全境界

この記録の単位は、個人向け **スマートEX** の予約、利用、払戻、購入履歴、領収書、乗車用
交通系 IC カード指定である。同じ EX アプリが扱うエクスプレス予約、EX旅パック、e5489、WESTER、
各交通系 IC カード発行者、クレジットカード発行会社の台帳は、連携境界を説明する場合を除き対象外
である。

許可するのは、既存予約、既存の購入/変更/払戻履歴、既存領収書/払戻明細/払戻手数料、既存の
乗車用 IC カード指定状態を read-only で表示・取得することと、公開 JavaScript、正規アプリの静的
解析/deobfuscation、read-only runtime tracing、通信メタデータ観測である。

次の操作は厳格に禁止する。

- 新規予約、購入、変更、人数減、取消/払戻、再購入、座席/列車/区間変更
- 乗車用 IC カードの追加/指定/変更/削除、同行者 IC リストの編集
- 決済用カード、会員情報、外部 ID 連携、password、OTP 受信方法、簡単 login、biometric 等の設定変更
- きっぷ受取 code 発行、campaign/ポイント利用、外部サービスへの新規登録/同意

会員 ID、氏名、生年月日、住所、電話、email、決済カード/交通系 IC カード番号、予約番号、
お預かり番号、Cookie、OTP、session/token、passkey private key、実際の予約、乗車日、区間、列車、
座席、金額、宛名を、HAR、screenshot、HTML、PDF、log、repository に残さない。WAF/CAPTCHA、rate
limit、certificate pinning、端末 integrity/attestation 等の security control は回避しない。

## 2. 調査方法と証拠の強さ

- [スマートEX公式サイト](https://smart-ex.jp/)、[公式FAQ](https://faq.expy.jp/?site_domain=smart-ex)、
  [公式 Google Play listing](https://play.google.com/store/apps/details?id=jp.co.jr_central.exreserve)
  を主な根拠にした。検索 aggregator は根拠にしていない。
- 2026-08-26 にログアウト状態で、公開 URL の status/header/redirect とログイン HTML/JavaScript を
  低頻度で観測した。credential 入力、login、OTP 発行、private page/API replay、challenge 誘発、
  負荷試験は行っていない。
- 公開 GitHub/Gist 実装は commit/revision を固定し、transport、auth、DOM selector、出力範囲と
  security/privacy 上の欠点を確認した。公開済みの領収書 PDF は開いていない。
- Google Play から正規 install した APK/split APK はこの環境では取得していない。package/version
  までを公式 listing で確認し、binary transport は再現可能な次実験とした。
- 以下では **確認事実**、そこからの **推測/設計判断**、**未確認** を分ける。

## 3. 正本と境界

| 記録 | 正本候補 | 主な read surface | 強み | 境界/欠落 |
| --- | --- | --- | --- | --- |
| 発車前の有効予約 | スマートEX予約台帳 | Web/EXアプリの「予約確認/変更/払戻」 | 商品、乗車日、区間、列車、設備/座席、人数、IC指定、決済カードの識別を確認 | 変更/払戻 button が同居し最も危険。過去全履歴の代替ではない |
| 購入・変更・払戻 | スマートEX利用履歴 | Web「ご利用履歴・領収書の発行」、app「購入履歴・領収書」 | 予約、変更、払戻を別 event として照合。最大15か月 | きっぷ受取後の駅払戻等が表示されない場合がある。公式 CSV/API なし |
| 領収書/払戻明細/手数料 | スマートEX表示文書 | Web/app の領収書表示 | インボイス対応、購入と払戻/手数料をお預かり番号で照合 | 1枚の net statement ではない。PDFは端末依存。宛名/実値を含む |
| 実際のカード請求/返金 | カード発行会社 | カード確定明細 | authorization/settlement、締め日を跨ぐ返金の最終正本 | スマートEXの乗車日とカードの利用日は一致しない場合がある |
| 新幹線の乗車権/改札利用 | スマートEX運送/改札記録 | 予約詳細、改札のEXご利用票 | IC指定と乗車時の列車/座席案内 | 公開UIで独立したgate入出場履歴/exportは未確認 |
| IC残高・在来線利用 | IC発行者 | Suica/ICOCA等のapp/履歴 | 在来線運賃・IC残高の正本 | スマートEX代金はIC残高から引かれない。Smart EX履歴と混ぜない |

`reservation`、`purchase_event`、`refund_event`、`receipt_document`、`boarding_assignment`、
`card_settlement`、`transit_ic_event` を別 object とする。お預かり番号は Smart EX 内の照合候補だが、
秘密/PII と同様に扱い、repository key にしない。保存にはランダム local source key を使う。

## 4. 予約、利用、払戻の履歴

### 4.1 発車前の予約

[予約確認の公式手順](https://www.smart-ex.jp/reservation/guide/referral/) による確認事実:

- Web/EXアプリの「予約確認/変更/払戻」から予約一覧と詳細を開く。
- 詳細には決済に使ったカードの下4桁と国際ブランドを表示する。
- 乗車用交通系 IC カードの指定状態を確認できる。番号が表示されれば指定済みである。

公式画面例は乗車日、列車名、発着時刻、区間、設備/座席等を示す。live 検証では、往復/乗継を一つの
予約として扱うか、同行者、自由席、早特、変更済み、きっぷ受取済み、入場済みの state field を確認
する。ただし予約詳細には「変更」「払戻」「IC指定」が隣接するため、取得 route は利用履歴より危険
である。

予約一覧は現在/将来の運送契約状態の source であり、過去15か月の決済 event ledger ではない。
予約が一覧から消えたことだけで、乗車、払戻、失効を断定せず、利用履歴/払戻明細と照合する。

### 4.2 利用履歴の粒度と期間

[ブラウザ版利用履歴FAQ](https://faq.expy.jp/faq/show/244?site_domain=smart-ex) と
[EXアプリ版FAQ](https://faq.expy.jp/faq/show/245?site_domain=smart-ex) は、予約日の翌日から
**最大15か月分**の利用履歴を照会できるとする。Web は照会期間を選び「再検索」、app は期間を選ぶ。

[領収書表示サービス](https://smart-ex.jp/reservation/reserve_smart/receipt/) は利用履歴に予約、変更、
払戻が表示され、カード明細との照合に使えるとする。したがって履歴1行を「乗車1回」と解釈せず、
少なくとも次を別 event として扱う。

- 予約/購入
- 変更後商品の新規決済
- 変更前商品の払戻
- 会員操作による払戻
- 発車時刻経過、未使用、遅延/運休等による自動・特定額払戻
- 払戻手数料/未使用手数料

[カード請求FAQ](https://faq.expy.jp/faq/show/319?site_domain=smart-ex) によると、原則として予約日が
購入決済日、払戻操作完了日が払戻日で、カード請求書の「利用日」は乗車日ではない。
[変更時の返金FAQ](https://faq.expy.jp/faq/show/276?site_domain=smart-ex) は、原則として変更後商品を
新たに決済してから変更前商品を払戻すとする。一時的な二重表示を重複購入として消去しない。

[二重請求の確認FAQ](https://faq.expy.jp/faq/show/389?site_domain=smart-ex) は、Smart EXからカード会社
へ購入/返金 data を速やかに送る一方、締め日や確定処理で反映が遅れ、きっぷ受取後の駅払戻等は
Smart EX利用履歴に表示されない場合があるとする。Smart EX履歴は transport/order event の正本、
カード確定明細は実際の settlement の正本として照合する。

公開公式資料には、1 page 件数、全体の最大件数、pagination token、stable row ID、CSV/JSON/API、
変更前後や原取引/払戻を結ぶ machine-readable ID の説明を確認できなかった。公開第三者実装は
`div.pager` の「次へ」が存在し得ることを示すが、件数仕様の根拠にはしない。

### 4.3 領収書、払戻明細、払戻手数料、PDF/export

[領収書表示サービス](https://smart-ex.jp/reservation/reserve_smart/receipt/) による確認事実:

- 表示期間は予約完了日の翌日5:30から最大15か月後23:30まで。予約当日は表示できない。
- 「領収書表示」、払戻時の「払戻明細」、手数料がある場合の「払戻手数料」は別 document である。
  最終的な net 負担は、同じお預かり番号の document を組み合わせて算出する。
- 宛名を入力して印刷するとインボイス対応画面になる。表示期間内なら発行回数に制限はない。
- 2023-04-08購入分以降は、未使用/2時間以上の遅延等による特定額払戻にも対応範囲が拡張された。

[PDF FAQ](https://faq.expy.jp/faq/show/1298?site_domain=smart-ex) は、表示した領収書をPDF保存できるかは
端末依存とし、WEBフォーム申請分は紙郵送でPDF発行しない。したがって「公式 PDF download API」
ではなく、公式 HTML/print view を端末の印刷機能でPDF化する route である。CSV、bulk export、
machine-readable receipt schema は公開公式資料で確認できない。

領収書だけを集めると払戻/手数料を落とす。collector は document type を持ち、`領収書表示`、
`払戻明細`、`払戻手数料` の件数を別々に照合する。PDFは乗車日、区間、金額、宛名、お預かり番号等を
含み得るため、原本はrepository外の暗号化保管とし、この調査のlive検証では保存せずfield名だけを
確認する。

### 4.4 発車後・未使用・自動払戻

[払戻条件](https://smart-ex.jp/reservation/guide/cancel/) は、原則として改札入場前/きっぷ受取前かつ
発車時刻前に会員操作で払戻できる一方、結果はemailで通知されず、乗車日の翌々日以降に利用履歴で
確認するとする。[未使用FAQ](https://faq.expy.jp/faq/show/267?site_domain=smart-ex) は、乗車日の翌日
以降に手数料を引いた自動払戻を行い、翌々日以降に履歴/文書を確認するとする。

本 collector は払戻を実行しない。予約時点で `unused`/`cancelled` と決めず、公式 ledger に自動払戻
event が現れるまで provisional とする。運休/遅延時の特別取扱い banner も操作誘導であり、読むだけに
留める。

## 5. 交通系 IC カードと乗車履歴の境界

[交通系ICカード乗車案内](https://www.smart-ex.jp/entraining/iccard/) は、Smart EX代金が登録した
決済カードから予約時に決済され、交通系 IC カード残高からは引かれないと明記する。新幹線改札では
ICを乗車権の識別に使い、改札機から乗車日、区間、列車、座席等を記した「EXご利用票（座席のご案内）」
が出る。この紙は乗車案内であり、決済領収書ではない。

[登録・変更案内](https://www.smart-ex.jp/reservation/other/ic_card/) によると、全国相互利用対象10種類、
モバイルSuica/PASMO/ICOCA等を指定できる。1名/複数名、本人/同行者により指定方法が異なる。
[IC指定FAQ](https://faq.expy.jp/faq/show/592?site_domain=smart-ex) は、詳細画面に17桁番号を表示する。
この番号は取得/保存せず、`specified=true/false` と座席への割当数だけを観測する。

[在来線乗継FAQ](https://faq.expy.jp/faq/show/259?site_domain=smart-ex) によると、在来線区間には別運賃が
必要である。したがって同じ IC で連続して改札を通っても、Smart EX新幹線代金、在来線IC運賃、IC残高
を一つの取引へ統合しない。

公開資料では、Smart EX UI に独立した改札入場/出場時刻、実乗車 flag、gate ID、EXご利用票のdigital
copy、乗車実績CSV/APIがあることを確認できなかった。予約/購入履歴は「予約/決済の履歴」であり、
実乗車を常に証明する「gate履歴」とは見なさない。[privacy page](https://www.smart-ex.jp/privacy/) は
運営者が予約情報や乗車実績を扱うとするが、それが会員向けにexportされるとは限らない。

IC登録/指定/解除はすべて account/booking write で、read-only検証では実行しない。2:00～3:00等の
指定/照会制限にも自動retryせず、時間を改める。

## 6. 認証、MFA、passkey、Bitwarden

### 6.1 Smart EXの直接login

[公式ブラウザ操作](https://smart-ex.jp/reservation/reserve_smart/sp/) は、会員ID（10桁）と
password（4～8桁）で login するとする。[2025年の公式案内](https://www.smart-ex.jp/topics/detail/?id=834)
と [OTP FAQ](https://faq.expy.jp/faq/show/1174?site_domain=smart-ex) は、2025-09-27以降、端末/browserの
変更や複数環境など普段と異なるアクセスと判断された場合に login OTP を要求することがあるとする。

[OTP受取方法FAQ](https://faq.expy.jp/faq/show/323?site_domain=smart-ex) による確認事実:

- 2022-05-21以降の新規会員は電話番号へのSMSまたは自動音声案内を使う。
- それ以前からの会員にはemail設定が残る場合がある。
- emailから電話へ変更するとemailに戻せないなど、受信方法変更は不可逆性を含む。

OTP送信/入力が必要なら人へhandoffし、値をfile/log/clipboard historyへ残さない。受信方法変更、電話/
email変更、account再登録はwriteのため行わない。3D Secureは予約/変更時のカード決済認証で、read-only
login MFAと混同しない。

### 6.2 簡単login、EXアプリbiometric、passkey

[簡単login案内](https://smart-ex.jp/reservation/reserve_smart/access/) は、会員別・端末別の専用画面を
bookmarkし、passwordだけでloginする機能である。これはpasskey/WebAuthnでも、MFAでもない。
専用URLは会員を識別し得るためsecretと同様に扱い、log/screenshot/repositoryへ残さない。設定作成・
削除はwriteなので行わない。

[EXアプリ公式listing](https://play.google.com/store/apps/details?id=jp.co.jr_central.exreserve) は
指紋/Face ID loginを案内する。これはappのlocal credential unlock/device認証であり、Smart EXの
WebAuthn passkey対応を示さない。Smart EX直接loginのpasskey公式案内は今回確認できなかった。

### 6.3 WESTER外部ID

[外部ID利用サービス](https://smart-ex.jp/reservation/other/id_link/) は、事前に紐付けたWESTER IDで
Smart EX Web/EXアプリへloginでき、紐付け時にはWESTER password、OTP、情報提供同意を行うとする。
既に連携済みならWESTER loginはread入口候補だが、新規連携/解除/同意はwriteで行わない。

JR西日本の[passkey FAQ](https://faq-support.westjr.co.jp/hc/ja/articles/55648108612761-%E3%83%91%E3%82%B9%E3%82%AD%E3%83%BC%E3%81%AE%E7%99%BB%E9%8C%B2-%E5%89%8A%E9%99%A4%E6%96%B9%E6%B3%95%E3%82%92%E6%95%99%E3%81%88%E3%81%A6%E3%81%8F%E3%81%A0%E3%81%95%E3%81%84)
はWESTER会員supportでpasskeyを登録/削除できることを確認する。ただしWESTER passkeyが、既存連携済み
Smart EXへのfederated loginで常に利用可能かはSmart EX公式資料で確認できない。**WESTERのpasskey対応
をSmart EX直接loginのpasskey対応と読み替えない。**

### 6.4 Bitwarden: 確認と推測

Bitwardenは一般に[browser autofill](https://bitwarden.com/help/auto-fill-browser/)、
[Android autofill](https://bitwarden.com/help/auto-fill-android/)、
[passkey保存](https://bitwarden.com/help/storing-passkeys/)を提供する。したがってSmart EX ID/password
のautofill、またはWESTERが受け付ける環境でpasskey providerになる可能性はある。

Smart EX/EXアプリとの公式Bitwarden連携・互換性は確認できない。EXアプリbiometricはBitwarden
passkeyではなく、簡単loginはsecret-bearing URL + passwordである。会員ID、password、簡単login URL、
OTP受信先、card/IC番号を一つのruntime secretへ集約しない。

未確認: session寿命/refresh、device/IP binding、OTP risk判定、WESTER federationのtoken/session、
WESTER passkeyからSmart EXへの実際のlogin、EXアプリbiometricのcredential保存方式。

## 7. CDN、WAF、anti-bot

2026-08-26のログアウト状態の低頻度観測:

| 公開入口 | 結果 | 言えること / 言えないこと |
| --- | --- | --- |
| `https://smart-ex.jp/` | `301`後`200`、HSTS、public HTML | marketing/help surface。auth originと同じ防御とは限らない |
| `https://shinkansen2.jr-central.co.jp/RSV_P/S_smart_index.htm` | `200`、`X-Akamai-Transformed`、`_abck`/`bm_sz` cookie | Smart EX auth surfaceにAkamai介在。bot-management系cookieの強い候補 |
| `https://shinkansen2.jr-central.co.jp/RSV_P/smart_index.htm` | 同じく`200`、Akamai header/cookie | smartphone loginも同じclassic form backend候補 |
| `https://faq.expy.jp/?site_domain=smart-ex` | `200`、`Server: nginx` | FAQは別surface。auth protectionの根拠にならない |

Akamaiの[bot管理説明](https://techdocs.akamai.com/cloud-security/docs/about-bots) はlogin/transactional path
をbehavioral detectionで保護する用途を説明する。今回のheader/cookie観測はAkamaiとbot管理の介在候補
を示すが、Bot Manager/Account Protector/WAFの契約product、policy、score、challenge条件、native app
保護を確定しない。Cloudflare固有headerはauth入口で観測しなかったが、Cloudflare/WAF不在の証拠には
しない。

401/403/429、CAPTCHA/challenge/interstitial、認証loop、予想外のOTP、Akamai denialが出たら停止する。
cookie合成、telemetry偽装、fingerprint spoofing、CAPTCHA solver、rate-limit探索、proxy rotation、
pinning/integrity bypassを行わない。Cloud providerのheadless browserはIP/device変化でOTP/bot判定を
増やし得る。

## 8. 公開Web JavaScriptと具体的transport

### 8.1 ログインtransport

2026-08-26に公開login pageとJavaScriptを静的解析した確認事実:

- login formは `POST https://shinkansen2.jr-central.co.jp/RSV_P/ClientService`。
- 会員ID/password input名はそれぞれ`01`/`02`。値は入力・取得していない。
- formは`_PageID`、`_ActionID`、`_DataStoreID`、`_SeqNo`、`_ControlID`、`_WBSessionID`、
  `AppSessionID`等のhidden fieldを持つ。値はsessionごとに変わり、記録しない。
- login pageの`_PageID`は`RSWP100P211`、login actionは`RSWP100AIDP312`。WESTER login導線も同じ
  form/action frameworkを使う。
- `cfEXPY_common.js`の`cfEXPY_doAction(argsAid)`は`_ActionID`を設定し、form全体をsubmitする。
  JSON REST/GraphQLではなく、server-side page stateをhidden fieldで往復するclassic HTML POSTである。

provenance:

- `/_javascript/cfEXPY_common.js?20260824`: SHA-256
  `b4371b3107a1eabbbcbfbe678a501817cef78e3671b218399a6a624e24847e82`
- `/_javascript/common_func.js?20260824`: SHA-256
  `b6cef7849910306a2d1efd87bc98b823f1bec0b88897366f5f61327230409fb7`
- login page固有`RSWP100P211.js?20260824`: SHA-256
  `7ab1638e790ece608db76fad27678d2df6ae61014ceb5c6bf35ec8cbe8038ba0`

### 8.2 read/write隔離への含意

`/RSV_P/ClientService`という同一path、同一POST methodがlogin、read、予約、変更、払戻、設定変更を
dispatchし得る。**origin + method + path allowlistだけでは安全にならない。** 少なくとも`_PageID`、
`_ActionID`、画面title、期待するbutton label、response pageを組み合わせ、liveで確認したread action
だけをallowlistにする必要がある。

匿名pageだけでは、利用履歴一覧、詳細、領収書表示、払戻明細、paginationの`_PageID/_ActionID`を確認
できなかった。認証後のread-only動的観測でfield名だけを取得し、値を保存しない。action IDを推測して
POSTしない。

現時点のtransport証拠は、browser sessionを保ったHTML navigationのC/D候補を強く支持するが、安定
renewable sessionを持つB clientの証拠ではない。

## 9. 公式EXアプリ、APK、静的/動的解析

### 9.1 appとwebの役割

[公式Google Play listing](https://play.google.com/store/apps/details?id=jp.co.jr_central.exreserve) を
2026-08-26に直接確認した情報:

- package: `jp.co.jr_central.exreserve`
- version: `10.0.0`
- Play表示の最終更新日: `2026-08-10`
- Smart EXとエクスプレス予約の共用app。予約、確認、変更/払戻、購入履歴/領収書、会員情報、IC指定、
  biometric loginを提供する。

同じpackageが複数サービスを扱うため、解析/collectorではservice=`smart-ex`を明示し、エクスプレス
予約のaccount/host/page/schemaを混ぜない。appはbiometric/device-bound authとapp固有transportの同定に
向くが、予約/変更/払戻writeが中心に同居する。Webはclassic formのfield/actionを観測しやすく、
receipt printにも向くため初期routeはWebを優先する。

公式standalone APK配布は確認できない。第三者mirrorは初期provenanceに使わず、ユーザー管理Androidへ
Google Playから正規installしたartifactを使う。

### 9.2 正規APK/split APKの次実験

この環境にはGoogle Play install済みのユーザー管理Android、`adb`、`apksigner`、`bundletool`、`jadx`、
`apktool`、MobSFが揃っていないためbinaryを取得しなかった。次の手順で、repository外の暗号化一時領域
に取得する。

```bash
PKG=jp.co.jr_central.exreserve
adb shell dumpsys package "$PKG" | grep -E 'version(Name|Code)|firstInstallTime|lastUpdateTime'
adb shell pm path "$PKG"
# 上で得たbase.apkと全split_config*.apkを一つずつadb pullする
sha256sum artifact/*.apk
apksigner verify --verbose --print-certs artifact/*.apk
jadx -d jadx-out artifact/*.apk
apktool d -f artifact/base.apk -o apktool-out
rg -a -n 'https?://|wss://|ClientService|RSWP|retrofit|okhttp|webview|oauth|saml|bearer|cookie|session|pin|certificate|integrity|attestation|akamai' jadx-out apktool-out
```

- 全splitのsigner digest一致を確認し、package/version/signer/hash/取得日時だけをprovenance recordに残す。
  APK/decompiled codeはcommit/第三者cloudへuploadしない。
- Manifest、network security config、WebView/native境界、host/path/action ID定数、serializer/model、
  session/cookie更新、biometric key storage、Akamai mobile module、pinning/integrity候補を列挙する。
- R8/ProGuard/string encryptionのdeobfuscation、URL builder/serializer/read methodのruntime tracingは
  対象にできる。ただしtoken/cookie/key/OTP/PII/実値をlogせず、pinning/integrity判定を変更するhookは
  作らない。
- MobSFはlocal static scanのみ。自動dynamic action、第三者cloud upload、binary再配布をしない。

### 9.3 read-only app動的観測

1. 既存install/既存sessionがあればSmart EX serviceを選び、予約一覧、購入履歴、既存文書表示だけを開く。
2. bodyを保存せず、DNS/SNI、host、method、path template、status、content-type、field名のみを観測する。
3. user-installed CAをappが通常受理する場合だけlocal proxyを使う。拒否/pinning/integrity errorならpatch/
   hookで回避せず、encrypted metadata観測へ戻る。
4. runtime tracingはread page/serializerだけに限定し、予約検索/購入/変更/払戻/IC/設定methodは呼ばない。
5. write endpointとのscope/session分離を確認できなければdirect replayせず、UI/manual routeに戻す。

## 10. 公開third-party implementation

### 10.1 `hhhryoma/smartex-receipt`

[hhhryoma/smartex-receipt](https://github.com/hhhryoma/smartex-receipt) のcommit
[`7ba77bedc4749369e1cf589501878b4d45ecd641`](https://github.com/hhhryoma/smartex-receipt/blob/7ba77bedc4749369e1cf589501878b4d45ecd641/index.js)
（2026-08-02、license表示なし）は、Playwright 1.52 + persistent ChromiumでWeb UIを操作する具体的な
第三者実装である。

transport/auth実装:

- `https://shinkansen2.jr-central.co.jp/RSV_P/smart_index.htm`へ移動し、`input[name="01"]`/`02`へ
  `.env`の会員ID/passwordを入力する。
- OTP pageを本文文字列で検出し、SMS送信buttonをclickする。OTPを`output/otp.txt`から読み、input
  `tx01`等へ入れる。persistent profileを`output/.browser-profile`へ保存する。
- login後、`cfEXPY_doAction`を持つmenu linkの「利用履歴/領収書/購入履歴」を文字列検索し、
  `input[name="b1"][value="領収書表示"]`をpageごとに処理する。
- print popupをPlaywright `page.pdf()`でPDF化し、`div.pager`の「次へ」を辿る。直接API clientではなく、
  Smart EX HTML/form sessionを使うC/D型である。

そのまま採用できない理由:

- passwordをplain `.env`、sessionをpersistent browser profile、OTPをplain fileへ置き、OTP値をconsole
  logする。debug modeは認証後HTML/screenshot、通常実行は実日付/区間/金額を含み得るPDFを保存する。
- public repository自身にroute/date名のPDF出力がcommitされている。PDF本文は調査で開いていないが、
  privacy設計の反例であり、fork/実行/再配布しない。
- `force: true`、汎用「戻る/OK/次へ」selector、body text fallbackはDOM変更時に予期しないbuttonを押す
  危険がある。strict read-only collectorでgeneric clickを使わない。
- `領収書表示`だけを対象にし、`払戻明細`/`払戻手数料`を収集しないためnet costを完全に再現しない。
- SMS送信を自動clickし最大3回retryする。strict routeではOTPはhuman handoffし、失敗時に自動retryしない。
- LINE pushという外部write/秘密追加を含むため除外する。

この実装はPlaywright browser routeで領収書を取得できる実例だが、B型internal API、current stability、
利用規約適合、完全な履歴取得を証明しない。

### 10.2 予約通知emailの公開Gist

[dora1998のGist](https://gist.github.com/dora1998/5a626f20797bd305fd93c76faab9da1b/8ba79dde474131fe4a20e12107467302d4b201b7)
（revision `8ba79dde474131fe4a20e12107467302d4b201b7`、2019、license表示なし）は、Google Apps Scriptで
`yoyaku@expy.jp`からの予約emailを検索し、お預かり番号、乗車日、駅、時刻、列車を正規表現で抽出して
Google Calendar eventを作る。

これはemailという二次通知transportの具体例であり、login/sessionを扱わない。一方、変更/払戻/自動
払戻/領収書/IC指定/カードsettlementの完全性を保証せず、calendar作成はwriteである。本collectorでは
実行しない。emailを補助sourceにする場合も、Smart EX利用履歴を正本とし、本文/PIIを保存しない。

GitHub code/repository検索では、現行のdocumented personal API/SDK、Smart EXのrenewable read API
client、EXアプリ10.0.0の公開署名検証済みdecompilationを確認できなかった。不在を証明するものではない。

## 11. read/write隔離

最小allowlist:

- 通常loginと既存WESTER federation login（新規連携、reset、設定変更を除外）
- 予約一覧/詳細の表示。ただしbutton押下は「詳細」「戻る」の厳密selectorのみ
- 「ご利用履歴・領収書の発行」/「購入履歴・領収書」の期間指定、再検索、read pagination
- 既存「領収書表示」「払戻明細」「払戻手数料」の表示/print view
- 乗車用ICの`指定済/指定なし`と割当数の表示。番号値は取得しない

denylist:

- 「新幹線予約」「予約を続ける」「購入」「変更」「払戻」「取消」「人数を減らす」
- 「乗車用ICカードを指定」「新しいカードを登録」、IC追加/編集/削除/並替
- 「お客様情報の変更・退会」「パスワード変更」「簡単login設定」「外部ID利用サービスの管理」
- OTP受信方法/電話/email/card変更、biometric/passkey登録、退会、規約同意
- 受取code、ticket発券、EXポイント利用、旅パック/旅先予約、LINE/calendar通知

実装gate:

1. origin/path/methodに加え`_PageID + _ActionID + page title + exact label`をallowlistにする。
2. form actionが`ClientService`でもunknown action IDならsubmit前に停止する。
3. selectorはbutton name/valueと親pageを固定し、`force:true`、generic `OK/次へ/戻る`、座標clickを使わない。
4. click前に全form/buttonを分類し、deny語または未知actionが1つでもtarget候補なら人へhandoffする。
5. responseのpage ID/titleが期待と異なる、利用履歴から予約操作画面へredirectした場合は停止する。
6. receipt addressee入力はaccount writeではないがPIIを生成するため、この検証では空欄のままにする。

## 12. Workers / Browser Run / Containers / OCI / Kubernetes適性

- **Cloudflare Workers**: [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) はHTTP
  POST、HTML parser、schedule、normalizationには使える。しかしSmart EXはmutable hidden sessionと
  action IDを同一`ClientService`へPOSTし、Akamai/OTPもある。renewable sessionとread actionの完全分離を
  live証明するまではcollector本体に不向き。sanitized parser/後段変換には向く。
- **Cloudflare Browser Run**: [公式概要](https://developers.cloudflare.com/browser-run/) はPlaywright/CDP
  browser sessionを提供し、[Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/)
  はMFA/秘密入力で人へhandoffできる。C候補だが、cloud IP/device変化がAkamai/OTPを増やし得る。
  Session Recording/Live ViewにPIIが残るためrecordingを無効化し、remote secret policyを別途確認する。
- **Cloudflare Containers**: [公式Containers](https://developers.cloudflare.com/containers/) はfull filesystem、
  任意runtime、既存OCI imageに対応する。Playwright、PDF print、local parser、jadx/apktool等にWorkersより
  適するが、Android device/Play provenance/Akamai受容を解決しない。
- **OCI/local container**: pinned Playwright/browser/parserをread-only rootfs、ephemeral `/tmp`、暗号化
  profile volume、egress allowlistで動かす現実的候補。profile/receipt/debugをimage layerやrepositoryへ
  入れず、処理後secure deleteではなくephemeral volume破棄を使う。
- **Kubernetes**: 多数sourceのCronJob、per-source NetworkPolicy、external secret、retry/observabilityには
  向くがSmart EX単体には過剰。未知DOM/OTP/401/403/429/writeをretryしないcontrollerが必要。
- **Android device automation**: EXアプリ routeは実機/managed emulatorが必要でWorkers/ordinary OCI
  単体には不向き。pinning/integrity bypassを前提にしない。

## 13. PR #5共通の自動化レベルA-Eとcost 1-5

共通定義:

- **A**: 公式/documented read-only APIまたは機械取得用公式export
- **B**: 安定したinternal read APIとrenewable/reusable sessionを直接利用
- **C**: 人のbrowser/app login bootstrap後にheadless HTTP/browser replay
- **D**: full browser/device UI automationが継続的に必要
- **E**: 手動capture/import

| route | 現時点の判定 | cost | 根拠/昇格条件 |
| --- | --- | ---: | --- |
| 公式領収書/払戻文書の手動print | **E** | **1** | 最大15か月、回数制限なし。PDF化は端末依存、bulk/CSV/APIなし |
| Web利用履歴・領収書Playwright | **C候補** | **3-4** | 公開第三者実装でsession付きUI/PDFを具体化。Akamai/OTP、hidden action、privacy hardening、払戻文書追加が必要 |
| Web予約一覧/IC指定状態 | **D** | **4** | 変更/払戻/IC writeが隣接し、pathも共通。read actionの厳密allowlistをlive確認できればC/4 |
| internal `ClientService`直接replay | **C候補、B未達** | **4** | classic form/session/action IDは確認。renewal、read-only action、schema stability、Akamai受容は未確認 |
| EXアプリ | **D** | **5** | shared service app、device/biometric、APK transport未確認、write隣接 |
| email通知parse | **C補助** | **2** | login不要にできるが二次通知で不完全。正本/領収書/IC/settlementを置換しない |
| Smart EX全体 | **D** | **4** | receiptはC候補だが、予約/IC/実乗車境界と安全なwrite隔離にfull browser確認が残る |

Aは選ばない。公式にHTML/print viewはあるが、documented machine API/CSV/bulk exportではない。Bへの
昇格は、利用履歴/receipt専用read action ID、renewable session、Akamaiに許容される低頻度replay、
変更/払戻actionとの構造的分離をlive証明した後に限定する。

## 14. read-only live検証チェックリストとstop条件

read-only live検証:

- [ ] Smart EX serviceだけが選択され、エクスプレス予約/旅パック/e5489 dataを混ぜていない
- [ ] 予約一覧/詳細のfield名、state、往復/乗継/同行者構造。値は保存しない
- [ ] 利用履歴の最古15か月境界、照会期間、1 page件数、pagination、総件数、stable ID有無
- [ ] 予約/変更/払戻/未使用/遅延/手数料のevent typeと、変更前後/原取引link field有無
- [ ] 「領収書表示」「払戻明細」「払戻手数料」の件数、HTML/print/PDF fieldとお預かり番号link
- [ ] CSV/JSON/export導線の有無。公開資料にない機能を存在しないと決めつけない
- [ ] 乗車用ICは`specified`/割当数だけ確認し、17桁番号をcaptureしない
- [ ] 実乗車/gate履歴の有無と、予約/購入履歴との区別。IC残高/在来線履歴は開かない
- [ ] login/OTP/WESTER/biometric/session timeoutとhuman handoff点。設定変更はしない
- [ ] 各read画面のorigin/method/path/page ID/action ID/field名/response pageを値なしで観測
- [ ] Akamai/401/403/429/CAPTCHA時のretry無効、secret/PII redaction、unknown action default deny

即時stop:

- 予約、購入、変更、払戻/取消、人数減、IC指定/編集、ticket受取、設定変更の確認/実行buttonがtargetに
  なった
- OTP送信、3D Secure、本人確認、WESTER連携/同意、passkey/biometric登録、password resetを要求された
- 会員/card/IC/予約/お預かり番号、Cookie/token/OTP、実日付/区間/列車/座席/金額/宛名がlog/HAR/
  screenshot/HTML/PDFへ残り得る
- 401/403/429、CAPTCHA/bot/interstitial、Akamai denial、認証loop、pinning/integrity errorが出た
- unknown`_ActionID/_PageID`、unexpected redirect、generic selector、write/read session分離不能がある
- Smart EXとエクスプレス予約、card settlement、IC transit ledgerのsource boundaryを判定できない

## 15. 結論、推測、未確認

### 確認できたこと

- Smart EX利用履歴は予約翌日から最大15か月で、予約/変更/払戻を表示する。領収書、払戻明細、払戻
  手数料は別documentで、お預かり番号を合わせてnet負担を求める。
- 公式CSV/public API/bulk PDFは確認できない。領収書のPDF保存は端末print機能依存である。
- Smart EX代金は予約時にcard決済され、乗車用IC残高から引かれない。ICは新幹線乗車権の識別で、
  在来線運賃/IC残高は別台帳である。
- 直接loginはID/passwordとrisk-based OTP。簡単loginはpassword-only専用URLでpasskeyではない。
  Smart EX直接passkeyは未確認。WESTER側passkeyをSmart EX固有対応と読み替えない。
- auth WebはAkamai介在を示し、公開JSはhidden session/page/actionを同一`ClientService`へPOSTするclassic
  transportである。path/methodだけでread/writeを隔離できない。
- 公開Playwright実装はreceipt取得のC可能性を具体化するが、secret/OTP/PII保存、generic click、払戻
  document欠落、public PDF commitのため採用できない。

### 推測/設計判断

- 購入/払戻の正本はSmart EX利用履歴、実settlementはcard確定明細、乗車権/IC指定は予約/改札、在来線
  IC利用はIC発行者として分けるのが最も二重計上を防ぎやすい。
- receipt/history限定ならC/3-4候補だが、Smart EX全体はdangerous adjacent actionsのためD/4。安全な
  初期routeはE/1である。
- `ClientService`のread action IDとsession renewalをliveで固定できれば限定的Bへ進める可能性はある。

### 未確認

- 利用履歴のpage size/最大件数、stable ID、変更前後/原取引と払戻のlink、CSV/JSON/export。
- actual boarding/gate eventの会員向け表示/export、EXご利用票digital copy。
- authenticated read画面の`_PageID/_ActionID`、session lifetime/refresh、Akamai challenge/rate条件。
- EXアプリ10.0.0のhost/path/schema、WebView/native境界、signer、pinning/integrity候補。
- Smart EXへのWESTER passkey federated loginとBitwarden固有互換。
