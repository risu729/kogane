# SBI VCトレード（VCTRADE）調査

- 調査日: 2026-08-26（Australia/Sydney）
- 対象: SBI VCトレード株式会社が提供する **VCTRADE** の日本円・暗号資産口座データ取得面
- 対象外: 同社の別サービス、SBI証券、カード、外部アグリゲーター
- 制約: 公開情報、公開Web artifact、正規配布アプリのread-only静的解析、および本人操作によるread-only動的観測を対象とする。口座識別子、氏名、メールアドレス、電話番号、実残高、取引内容、Cookie値、token、パスワード、TOTPシード、OTP、passkeyを取得・記録しない。注文、取消、入出金、暗号資産の入出庫、貸コイン申込、認証・口座設定変更、security control bypassは実施しない。

## 結論

SBI VCトレードには、暗号資産・日本円の資産状況、残高履歴、注文履歴、約定履歴、入出金・入出庫履歴、損益・報告書、ステーキング、貸コインの読み取り面がある。一方、顧客向け公開APIは現時点で未提供で、公式FAQは将来の公開予定としている。認証済みCookieと`secureKey`を使う内部Web gatewayのbrowser外replayに加え、既存Bitwarden passkeyからCloudflare Workerだけで新規sessionを作る無人再認証も2026-08-31に実証できた。固定read allowlistによるcollectorをブラウザーなしで運用できる見込みである。

総合評価は、手動エクスポート + ローカル解析が **E / コスト1**、無人passkey再認証を含むWeb collectorが **B / コスト3** である。標準Bun/Workers `fetch`によるread-only collectorとWorkers Web Cryptoによるpasskey loginは実データで成功し、Cloudflare IP、browser TLS fingerprint、Chrome、Turnstileはpasskey経路の必須条件ではなかった。完全ブラウザーまたはアプリ自動化は不要になった。残る作業は取得eventのWorker統合、R2への原文保存、失効・仕様変更時の運用検証である。

## 1. 口座・商品と列挙できる情報

### 公式に確認できた事実

- 「資産状況」は日本円と全銘柄の保有状況を表示する。
- 「残高履歴」は基準日時点の日本円および全銘柄の残高を表示する。
- 「ポジションサマリー」はレバレッジ取引の建玉を銘柄・売買方向ごとに集約し、「ポジション照会」は個別建玉を表示する。
- 「口座詳細」は純資産、注文中証拠金、建玉必要証拠金、証拠金維持率、出金・出庫可能額等を表示する。
- 公式の現行ツールは、ブラウザー向けの「VCTRADE（シンプルモード）」「VCTRADE（トレーダーモード）」と、iOS/Androidの「SBI VCトレードアプリ」である。アプリは保有資産の前日比・推移グラフ、チャート、注文、ステーキング情報を扱う。
- ステーキングは対象暗号資産を保有することで原則自動参加となり、各営業日06:59:59時点の保有数量を基に平均数量を算出し、報酬は原則翌月15日までに入金履歴へ反映される。対象銘柄・料率は変動する。
- 貸コインは数量を指定して申し込む別サービスであり、履歴・状況照会面がある。ステーキングと異なり申込、数量条件、貸出期間がある。

一次資料:

- [照会機能一覧](https://www.sbivc.co.jp/guide/1-14)
- [取引ツール・アプリ](https://www.sbivc.co.jp/services/tools-apps)
- [報告書の項目説明](https://www.sbivc.co.jp/faqs/content/w6w84vhcjqwi)
- [ステーキング](https://www.sbivc.co.jp/services/staking)
- [貸コイン](https://home.sbivc.co.jp/services/lending)
- [貸コインの申込・履歴](https://www.sbivc.co.jp/faqs/content/ktg3vu85rt7)

### 推測しない事項

- 対象暗号資産の全銘柄リストと料率は頻繁に更新されるため、この文書へ固定列挙しない。
- 貸コインの現行履歴カラム完全一覧は、公開された現行一次資料から確定できない。
- 資産総額の報告値では、未決済レバレッジ建玉の評価損益が除外される。画面上の別の評価額と同一と仮定してはならない。

## 2. 明細粒度、期間、件数、CSV/PDF

### 画面上の粒度

- 注文履歴: 現物（販売所・取引所）およびレバレッジの新規・決済注文。未約定も含む。
- 約定履歴: 約定済みの取引のみ。未約定・取消済み注文は含まない。
- 入出金・入出庫履歴: 日本円入金・出金、暗号資産入庫・出庫、取引損益等。
- 残高履歴: 基準日時点の日本円・暗号資産残高。
- 報告書: 年次・月次・日次を選択しPDFをダウンロードできる。個人には年間取引報告書も用意される。
- 年間損益報告書は、現物について銘柄別の取引・実現損益、年初・年末評価と差額を、レバレッジについて建玉損益とファンディングレート等を扱う。

### エクスポート

- 「損益計算用データ」はZIPで、約定履歴 `TRADE_RECORD_LIST` とウォレット/取引口座の資金移動 `CASHFLOW` の2 CSVを含む。
- 年間損益報告書等は電子交付PDFであり、郵送交付ではない。
- 2022年9月以降のCSVで文字化けする場合、公式FAQはUTF-8 BOM付きでの再保存を案内している。ZIPは先に展開が必要な場合がある。
- 新アプリで公式に列挙されるのは年次・月次・日次報告書であり、CSV/ZIP取得は列挙されていない。PCのトレーダーモードは年次・月次・日次・損益計算用データ、シンプルモードは年次・月次・損益計算用データを扱う。

### 期間と件数

- 税務・年間報告上の1年は、1月1日07:00:00から翌年1月1日06:59:59まで。日次の区切りも07:00から翌06:59である。
- 注文履歴・約定履歴のガイドは「直近4か月」と「4か月以前の履歴」を分け、期間・銘柄等による絞り込みを案内する。
- 公開一次資料からは、4か月以前を含む最大保存年数、1回の取得上限、総件数上限、ページサイズ、CSVの完全な列定義を確定できない。

一次資料:

- [報告書の表示・PDF取得](https://www.sbivc.co.jp/guide/4-63)
- [ツール別に確認できる報告書](https://www.sbivc.co.jp/faqs/content/e6vz-8vae19)
- [年間損益報告書と損益計算用CSV](https://www.sbivc.co.jp/faqs/content/apvc2fpgs6)
- [年間の集計期間](https://www.sbivc.co.jp/faqs/content/jt0lgp_bl5gv)
- [報告書はPDF電子交付](https://www.sbivc.co.jp/faqs/content/wcl7k4f45k)
- [CSV文字コード](https://www.sbivc.co.jp/faqs/content/mtjuaeit_5ib)
- [注文履歴](https://www.sbivc.co.jp/guide/4-21)
- [約定履歴](https://www.sbivc.co.jp/guide/4-49)

## 3. pending / settled の区別

- 取引所の未約定注文は専用一覧に表示される。FASの指値注文は一部約定後の残数量が有効なまま残り、FAKの成行注文は一部約定後の残数量が失効する。
- 未約定注文は毎週水曜日の定期メンテナンスで取消・失効する。これ以外の絶対的な注文期限はないと公式FAQが説明する。
- 約定履歴はsettledという会計用語ではなく「約定済み」を表し、未約定・取消済みは除外される。暗号資産入出庫のブロックチェーン上の確定数や会計上の最終確定時点は、公開画面仕様から一律に断定できない。
- 報告書の「出金・出庫予定額」は、依頼済みだが手続未完了の金額である。受付済み出金・出庫は移動可能額から控除される。
- 暗号資産の出庫予約は同時に1件のみで、完了後に次を受け付ける。この画面は読み取り調査でも進入禁止とする。

一次資料:

- [未約定注文一覧](https://www.sbivc.co.jp/guide/4-89)
- [約定履歴に含まれない状態](https://www.sbivc.co.jp/guide/4-22)
- [取引所ルール（FAS/FAK）](https://www.sbivc.co.jp/auction)
- [未約定注文の有効期限](https://www.sbivc.co.jp/faqs/content/ohdsqdyigx)
- [暗号資産出庫予約](https://www.sbivc.co.jp/guide/1-16)
- [受付済み出金・出庫と移動可能額](https://www.sbivc.co.jp/faqs/content/dokbb1fmd)

## 4. 認証、MFA、passkey、Bitwarden

### 確認できた事実

- 従来ログインは登録メールアドレスまたは口座番号とパスワードを使い、認証アプリ設定時は6桁コードを続けて入力する。
- 2025-09-03から多要素認証が必須。認証アプリまたはSMSを使い、どちらも未設定の場合は登録メールアドレスへコードが送られる。
- 認証アプリはQRコードまたはアカウントキーで登録するTOTP型である。シード/キーとコードは秘密として一切取得しない。
- passkeyは2026-03-18にWebのトレーダー/シンプル/マイページへ導入され、同年6月から現行アプリにも対応した。FIDO2を用い、生体情報は端末内に留まる。passkeyログインでは追加の二要素認証を省略できる一方、ID/パスワード + MFAも残る。
- 公式の対応プロバイダー列挙はiCloudキーチェーン、Googleパスワードマネージャー、Windows Hello。最大5件のpasskeyを登録できる。同一OS内のクラウド同期はあり得るが、異なるOS間での同期は保証されない。
- ログイン失敗を繰り返すとロックされ、パスワード再設定が必要になる。

### Bitwardenとの関係

Bitwarden自体はWebサイト・アプリのpasskey保存と利用に対応する。SBI VCトレードの公式対応プロバイダー一覧にBitwardenはないものの、2026-08-31に本人の既存Bitwarden passkeyを選択して現行VCTRADEへ正常loginできた。最初に誤って開いた通常Chromeでもlogin成功を見たが、そのtabは閉じた。後述する認証済み通信・schema evidenceの正本は、その後に本人がloginを完了した**Kogane Capture Chrome**で取得した。したがってBitwardenとの相互運用性はlive確認済みである。

同日、WSLのBitwarden CLI 2026.8.0を本人がmaster passwordでunlockし、`SBI VCトレード` itemが1件のFIDO2 credentialを持つことを確認した。値を表示せずfield名だけを検査した結果、`credentialId`、P-256の`keyValue`、`rpId`、`userHandle`、`counter`等、WebAuthn assertionに必要な構造をCLIから取得できる。Kogane専用credentialは新設せず、この既存credentialを無人再認証候補とする。credential値、master password、vault sessionはGit、PR、標準出力へ保存しない。

Bitwarden公式はexport済みpasskeyのcounterがservice側と一致しない場合に拒否され得ると一般論として説明する。一方、このcredentialの保存値と成功したbrowser assertionはいずれもcounter `0`だった。Bitwarden 2026.8.0の実装も保存counterが0より大きい場合だけincrementするため、このcredentialではBitwarden本体とのcounter分岐は起きない。Workerはcounter `0`だけを受理し、将来non-zeroへ変化した場合は自動更新を推測せず停止する。

一次資料:

- [通常ログイン](https://www.sbivc.co.jp/guide/1-1)
- [多要素認証の必須化と方式](https://www.sbivc.co.jp/faqs/content/fychc8w9x)
- [認証アプリの設定](https://www.sbivc.co.jp/faqs/content/mmiani3gx8)
- [passkeyの仕様・対応環境](https://www.sbivc.co.jp/guide/5-1)
- [passkey導入案内](https://www.sbivc.co.jp/faqs/content/ym7cngjgatqv)
- [passkey登録上限](https://www.sbivc.co.jp/guide/5-6)
- [ログインロック](https://www.sbivc.co.jp/faqs/content/m9howuvxidze)
- [Bitwarden公式: passkey保存・自動入力](https://bitwarden.com/help/storing-passkeys/)
- [Bitwarden公式: vault exportとpasskey counterの注意](https://bitwarden.com/help/export-your-data/)

### 未確認

セッション有効期間、refresh tokenの有無、端末信頼の具体的期限、証明書ピンニング、端末attestation、非公開APIの署名方式は公開資料から確認できない。

## 5. WAF / anti-bot

2026-08-26に公開ホストへDNS解決とHEAD/GETのみを行った受動的観測では、次を確認した。Cookieの**値**は保存していない。

- `www.sbivc.co.jp`: Amazon CloudFrontの応答・キャッシュヘッダーを確認。
- `simple.sbivc.co.jp`: CloudflareのCNAME、`server: cloudflare`、`cf-ray`、`__cf_bm` Cookie名を確認。
- `account.sbivc.co.jp`: CloudflareのCNAME、同ヘッダー/Cookie名に加え、背後のCloudFrontを示す応答を確認。
- Cloudflare公式資料によれば `__cf_bm` はBot ManagementまたはBot Fight Modeで使われる。したがってbot対策の存在を示す一次的な技術信号はあるが、適用中のWAFルール、botモード、チャレンジ条件、ログイン後の挙動は不明。
- 公開ルートでCAPTCHAが出なかったことは、ログイン後や反復アクセスでチャレンジがない証拠にはならない。Akamaiの利用を示す信号は今回観測しなかった。

資料:

- [CloudflareのCookie説明](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/)

## 6. 公式アプリとWebの役割

- 現行Androidアプリの公式packageは `co.jp.sbivc.trade.app`、iOS App Store IDは `6639604109`。
- 公式サイトから遷移するGoogle Playの公式listingは開発者を `SBI VC Trade Co., Ltd.` とし、2026-08-05更新を表示する。2026-08-26に同じGoogle Play公開payloadを `google-play-scraper` で構造化した結果、versionNameは `3.2.4` だった。versionCodeは公開listingから取得できなかったため未確認である。
- 旧モバイルアプリは2026-01-28に終了し、2026-01-29から現行アプリへ一本化された。旧APK/旧マニュアルから現在のtransportや認証を推測しない。
- シンプルモードはPC/スマートフォン向けの簡易UI、トレーダーモードはPC向け高機能UI、現行アプリは保有推移、TradingViewチャート、スピード注文、ステーキング表示を統合する。
- 正規split APKの取得、署名確認、逆コンパイル、deobfuscation、静的解析、runtime tracing、通信メタデータ観測は調査対象である。ただし、改変APKの実行、証明書pinning/attestation/root検知/Cloudflare challengeの回避、秘密・PII・実値の保存、write操作は行わない。

### 6.1 正規split APKの取得状況とprovenance

今回のWSL/Windows環境には、Playから当該アプリを正規インストール済みのAndroid端末、ADB、Android SDK build-tools、認可済みGoogle Play delivery clientがなかった。Google Playの公開listingはAPK download URLを提供しない。このため、第三者APK mirrorへ切り替えず、split APK、manifest、signing certificate、versionCode、native library、pinning/integrity実装の実解析は未実施である。

次回は本人所有端末へGoogle Playから正規インストールした同packageを使い、Git管理外の一時領域へsplitをpullする。`pm path`が返すbase/config splitをすべて保存し、単一APKだけを完全artifactと誤認しない。

```bash
export SBI_VC_APK_DIR="$(mktemp -d)"
adb devices -l
adb shell dumpsys package co.jp.sbivc.trade.app \
  | rg 'versionName|versionCode|firstInstallTime|lastUpdateTime'
adb shell pm path co.jp.sbivc.trade.app \
  | sed 's/^package://' > "$SBI_VC_APK_DIR/device-paths.txt"
while IFS= read -r remote_apk; do
  adb pull "$remote_apk" "$SBI_VC_APK_DIR/"
done < "$SBI_VC_APK_DIR/device-paths.txt"
sha256sum "$SBI_VC_APK_DIR"/*.apk
for apk in "$SBI_VC_APK_DIR"/*.apk; do
  apksigner verify --verbose --print-certs "$apk"
done
```

Play listingのpackage/developer/version、端末のpackage/version、base APK manifest、全splitのhash、全splitで一貫するsigner certificate digestをprovenance recordにする。APK、certificate、解析出力はrepositoryへcommitしない。更新前後を比較する場合は同じ取得方法とcertificate digestを用いる。

### 6.2 静的解析の次実験

正規artifactを得たら、最初にmanifest/resources/native libraryを分け、次にdecompiled codeを見る。

```bash
for apk in "$SBI_VC_APK_DIR"/*.apk; do
  apktool d -f "$apk" -o "$SBI_VC_APK_DIR/apktool-$(basename "$apk" .apk)"
done
jadx --log-level ERROR -d "$SBI_VC_APK_DIR/jadx" "$SBI_VC_APK_DIR"/*.apk
rg -n -i \
  'https?://|wss://|/api/|graphql|retrofit|okhttp|certificatepinner|network_security_config|play.?integrity|safetynet|attestation|refresh.?token|access.?token|session' \
  "$SBI_VC_APK_DIR/jadx" "$SBI_VC_APK_DIR"/apktool-*
```

MobSFはlocal-onlyで起動し、image digestを記録してからbaseとsplitsを同一versionのartifact setとして確認する。結果HTML/JSONは秘密・PII scan後もGitへ入れない。

```bash
docker pull opensecurity/mobile-security-framework-mobsf:latest
docker image inspect opensecurity/mobile-security-framework-mobsf:latest \
  --format '{{index .RepoDigests 0}}'
docker run --rm -it -p 127.0.0.1:8000:8000 \
  opensecurity/mobile-security-framework-mobsf:latest
```

調べる対象はhost/path、request/response model名、WebSocket/REST/GraphQL、token/session更新、secure storage、network security config、certificate pinning、Play Integrity/attestation候補、root/anti-tamper候補である。文字列やクラスの存在は「実行時に有効」の証明ではなく候補として記録する。難読化解除と制御回避を混同しない。

一次資料:

- [公式ツール一覧とストアリンク](https://www.sbivc.co.jp/services/tools-apps)
- [旧アプリ終了と現行アプリへの移行](https://www.sbivc.co.jp/newsview/r1rbpq2ec0)
- [Google Play公式掲載](https://play.google.com/store/apps/details?id=co.jp.sbivc.trade.app)
- [Apple App Store公式掲載](https://apps.apple.com/jp/app/6639604109)

## 7. 公開APIとthird-party client

### 確認できた事実

- SBI VCトレード公式FAQと取引所説明は、APIを「今後公開予定」としている。2026-08-26時点で、顧客向けの公開API仕様、APIキー、scope、read-only endpointは見つからない。
- 公開GitHubをサービス名、公式ホスト、Android packageで検索したが、現在の認証済みVCTRADEへ接続する維持された公開クライアントは確認できなかった。
- [`kittyflip-zig/crypto-ledger-tools`](https://github.com/kittyflip-zig/crypto-ledger-tools) はMITライセンスのローカルCSV正規化ツールで、READMEにSBI VC Trade adapterの初期項目がある。APIキーを使うネットワーククライアントではなく、現在のSBI CSVへの完全対応も未確認である。

第三者実装として確認できるtransport/authは「利用者が手動取得したローカルファイルを読む / 認証なし」に限られる。一方、公式の公開Web bundle/source mapは現行Web client自身のtransportを具体化しており、次節のとおり静的解析した。endpoint/schemaの確認自体を禁止せず、秘密値の保存とwrite eventの送信を禁止する。

### 7.1 公開Web JavaScript / source mapの観測

2026-08-26、`https://simple.sbivc.co.jp/` はNuxt clientとして4つの公開bundleを配信し、main bundle `/_nuxt/f89914f.js` のSHA-256は `ff7856cdbd3080d87c8bfba7f45fb6b2982fdf26699114a57bd7089a3f87582f` だった。対応する [`f89914f.js.map`](https://simple.sbivc.co.jp/_nuxt/f89914f.js.map) も公開され、TypeScriptのsource filenameと`sourceContent`を含む。source mapは調査時点でHTTP 200、882,355 bytes、`Last-Modified: 2026-08-05`だった。bundle hashとファイル名はdeployで変わるため固定API versionではない。

公開source `plugins/api/serverAPIClient.ts` から確認したWeb transportは次のとおり。

- 同一originへJSON POSTし、bodyは概ね `{ event, data }`、responseは `{ meta, body }`。timeoutは15秒。
- loginは `/api/cccmdipresen/gw/login`、追加認証は `/api/cccmdipresen/gw/loginSecondAuth`、passkey開始/完了は専用path、market dataは `/api/cccmdipresen/gw/market`。
- 認証後の資産、注文、約定、cashflow、報告書、貸コイン、設定、注文/出金等は同じ `/api/cccmdipresen/gw/trade` に送られ、`event`で機能を振り分ける。
- read候補eventには `cashBalanceList`、`orderList`、`executionList`、`accountMargin`、`getCashflowList`、`tradeReportList`、`monthlyTradeReport`、`yearlyPlReport`、`plCalcData`、`lendingStatusList` がある。
- 同一path/sessionのwrite eventには `exStreamingOrder`、`requestWithdrawal`、`executeNetDeposit`、`applyReserveRequest`、`lendingRequest`、MFA/passkey/customer設定変更がある。HTTP path/methodだけではread/writeを隔離できず、event allowlistが必須である。
- `executionList`は`historical=true/false`の結果をclient側でmergeする実装を持ち、直近/過去データが別backend viewであることを示す。
- Vuexの`loginId`、wallet、report状態を`sessionStorage`へpersistするコードがある。別のWeb3/NFT wallet moduleは`accessToken`/`refreshToken`とAuthorization headerを使うが、VCTRADE取引口座sessionと同一と扱わない。
- bundleはCloudflare Turnstile script/site-key設定を含み、login requestにchallenge response fieldがある。さらにsecret-likeなclient config値も公開bundleに見えるが、値は取得記録・転載・有効性試験をしていない。security control bypassへ使用しない。
- `sessionTimeoutTime: 14400`というclient定数があるが、server sessionの実寿命が4時間だとはまだ確認できない。

core trade callには明示的Authorization headerが見えないため、same-origin browser session/Cookieを使う可能性が高いという**推測**に留める。Cookie名、CSRF、server側session更新、passkey後のsession確立は本人操作のsanitized network metadataで確認する。公開source mapの存在はAPIが公開・安定・利用許諾済みであることを意味しない。

### 7.2 Web/app transport差

Web側は上記のsame-origin event gatewayまで確認できた。アプリ側はsplit APK未取得のため、host、protocol、request model、token storage、pinning/integrity、Webと同じgatewayを使うかを確認できていない。アプリがWebView、native REST、WebSocket等のどれかを推測で決めない。正規APKのhost/schema候補をWebの一覧とdiffし、本人のread-only画面操作時に実際に使われる候補だけを動的観測で昇格する。

一次資料:

- [API公開予定の公式FAQ](https://www.sbivc.co.jp/faqs/content/5c0nv5540jm3)
- [取引所サービス説明](https://www.sbivc.co.jp/auction)

## 8. read / write endpointの隔離

### 推奨境界

最も安全な構成では、認証済みネットワーク接続そのものを解析器から除外する。利用者が公式画面でPDF/ZIPを手動取得し、ローカル解析器は読み取り専用でマウントされた入力だけを処理する。生ファイル、PII、金額、アドレス、口座IDはGit、ログ、クラウドへ送らない。

将来公式API、または観測済み内部transportを使う場合も、次を満たすまで接続しない。

1. 公式APIなら読み取り専用scopeとendpointが文書化されている。内部transportなら本人操作の1回観測で副作用のないevent/schemaが確認できている。
2. 書き込み権限を持たないcredentialが最善。現行Webのように同一sessionへread/writeが混在する場合は、collector側egress proxyでorigin+path+eventを固定し、write eventを構造的に送信不能にする。
3. 確認済みread eventだけをallowlistに置く。HTTP GET/POSTという理由だけで安全とはみなさない。
4. deny-by-default、外向き通信先制限、レスポンスログの値マスク、少量の合成試験を行う。

### UIを観察する場合のallowlist

資産状況、残高履歴、注文履歴、約定履歴、入出金・入出庫履歴、報告書、貸コイン履歴、ステーキング表示だけを候補とする。ただし未約定注文一覧やポジション照会には取消・決済操作が隣接するため、一覧表示後はクリックしない。

### denylist

注文、スピード注文、取消・変更、クイック決済、日本円入出金、暗号資産入出庫、出庫アドレス追加・削除、貸コイン申込・取消、積立、パスワード/MFA/passkey/個人情報/銀行口座設定、規約同意は全面禁止とする。JavaScriptアプリ内でread/writeが同一セッションに混在する以上、ブラウザー自動化だけでは強いtransport分離を証明できない。

## 9. Workers / Containers / OCI / Kubernetes適性

- **ローカルOCIコンテナ: 適合。** ZIP/CSV/PDFのオフライン解析器をOCI imageとして再現可能にできる。入力はread-only mount、出力はローカル、network none、非root、固定digestが望ましい。単一利用者には通常のローカルCLIでも十分。
- **Cloudflare Workers: 適合。** 標準Bun/Workers `fetch`でCookie + `secureKey` replayが成功し、15分Cron、暗号化Durable Object状態、`Set-Cookie`追従を実装した。Workers Web Cryptoと既存Bitwarden passkeyによる新規session bootstrapも実証した。
- **Cloudflare Containers: 不要。** Worker-onlyのpasskey loginが成功したため、full Chrome/WebAuthn用Containerを追加する理由はない。
- **Cloudflare Browser Rendering: 不要。** 認証・read transportの両方をWorkerだけで実証した。
- **Kubernetes: 単一口座には過剰。** 組織内で多数の手動エクスポートを処理する場合に限りCronJob、Secret、NetworkPolicy等を検討できるが、まず認証済み取得を行わない設計を維持する。

基盤の一次資料:

- [Cloudflare Workers Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/)
- [Cloudflare Browser Rendering CDP](https://developers.cloudflare.com/changelog/post/2026-04-10-browser-rendering-cdp-endpoint/)
- [OCI Image Specification](https://specs.opencontainers.org/image-spec/)
- [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

## 10. 共通A–E / cost評価

[PR #5](https://github.com/risu729/kogane/pull/5) の共通尺度だけを使用する。

- A: 定期的なheadless実行に適した、文書化された直接export/API
- B: 更新・再利用可能なsessionを使う安定したread-only内部API
- C: browser/app bootstrap後のheadless replayが現実的
- D: 完全なbrowser/device自動化が必要と思われる
- E: 手動captureが安全な既定
- cost 1: 小さなwrapper程度 ～ cost 5: 端末拘束・対botを伴う自動化

| 方式 | 評価 | 判断 |
|---|---:|---|
| 手動PDF/ZIP取得 + ローカル解析 | **E / 1** | 公式exportを使い、秘密を処理系から隔離できる。推奨。 |
| 将来の公式read-only API | 未評価（A候補） | 現在は仕様未公開。scope・endpoint・rate limit確認後に再調査。 |
| 非公開Web API + passkey無人再認証 | **B / 3** | Bun/Workersから実データ取得、新規passkey session、15分rolling更新に成功。残課題はcollector統合と長期運用。 |
| Web完全自動化 | **D / 5（不採用）** | Worker-only経路が成立したため不要。書き込み隣接の危険も増える。 |
| アプリ静的解析 + read-only動的観測 | **C候補 / 4-5** | 正規split取得、署名、host/schema、token/session、pinning/integrity候補を確認する次段階。 |
| アプリ/端末完全自動化 | **D / 5** | 端末認証とread/write操作面の混在。解析結果に基づき再評価する。 |

## 11. read-only live検証計画とstop条件

### 段階的検証

1. 公開ガイド、FAQ、公式ストア、DNS/HTTPヘッダー、公開HTML/JS/source mapを取得し、URL、hash、日時を記録する。bundle内のtoken/secret-like値は転載・試験しない。
2. 正規Play install済み本人端末からsplit APKをpullし、package/version/hash/signing certificateを確認する。jadx/apktool/MobSFでhost/path/schema/token/session/pinning/integrity候補を抽出するが、artifact・解析出力はGitへ置かない。
3. Webは利用者が自分でログインし、DevToolsで許可済みread画面1回分のmethod、origin、path、event名、status、content-type、timingだけを観測する。request/response body、header、Cookie、token、ID、実値を保存しない。HARを使うならcapture時点でbody/headerを除外し、共有前にsecret/PII scanする。
4. アプリは本人端末で資産・残高履歴・約定履歴・報告書等のread画面だけを操作し、標準ADB/logcat/Perfettoまたは通常のローカルVPN captureでhost/path/status等のmetadataだけを観測する。TLS pinningで内容が見えない場合は迂回せず、静的候補とUI automationの評価に留める。logcatに実値が出る場合は収集を即停止する。
5. Web/appで確認したread eventを比較し、同じschemaか、app固有API/tokenがあるかを区別する。read-only replayを行う場合は、bodyを合成できず実sessionが必要なら本人端末内、1 event、1回、deny-by-default egress proxyの条件に限定する。
6. 利用者が報告書/ZIPを自分で一度ダウンロードし、Git管理外のローカル一時領域へ置く。最初は値を読み込まず、列名、ファイル名、文字コード、期間表現だけをマスク済みで確認する。生ファイルはcommit・ログ・クラウド送信しない。
7. 確認できたschemaだけから合成fixtureを作り、オフラインparserを検証する。実値をfixtureへ転記しない。最大期間・件数が不明でも反復取得で探索しない。

### 即時停止条件

- ログイン、MFA、passkey、メール/SMSコード、QR、TOTPシード、秘密鍵、Cookie/token値の入力・表示・保存が調査者側に必要になる。本人が通常操作し、調査者が値を見ずmetadataだけを観測できる場合を除く。
- 追加規約への同意、端末登録、認証設定変更、パスワード再設定が要求される。
- 403、429、Cloudflare challenge、CAPTCHA、アクセス制限、ログイン失敗またはロック警告が出る。反復再試行、別IP、header偽装を行わない。
- 注文、取消、決済、入出金、入出庫、アドレス登録、貸コイン申込、積立、設定変更へ進む必要がある。
- certificate pinning、Play Integrity/attestation、root/anti-tamper、難読化が存在すること自体は停止条件ではないが、それらのsecurity controlを迂回しなければ観測・実行できない。
- allowlist外event、write event、method/path/schema不明のrequestを送る必要がある。
- ファイルや画面にPII、実残高、実取引、暗号資産アドレス等が見え、マスク前にログ・保存される可能性がある。

このstop条件に達した経路は中止し、E / cost 1の手動export方式を維持する。別のread-only静的解析や、制御回避を伴わない観測まで一律に禁止するものではない。

## 12. 2026-08-31 現行Webの再検証

PR #23で調べた公開artifactが現行deployでも使われているか、認証情報を入力せず再確認した。ファイル名はNuxt deployごとに変わり得る観測値であり、collectorの固定契約にしない。

### ブラウザー観測

- 公開login UIの最初の確認は誤って通常Windows Chrome 151で行い、HTTP 200、メールアドレス/口座番号、password、`パスキーでログイン`を確認した。このtabは閉じた。以降の認証済みnetwork/schema観測はKogane Capture Chromeだけを正本とする。
- 初期表示時に`/libs/simplewebauthn-browser.min.js`とCloudflare Turnstileのscript/iframeを読み込んだ。
- credential操作前に、browserは`POST /api/cccmdipresen/gw/initiateLoginWithPasskey`を1回送り、HTTP 200 `application/json`を受けた。秘密capture内のresponseは`challenge`、RP ID、timeout、`userVerification`を持ち、RP IDは`sbivc.co.jp`、user verificationは`required`だった。値はGitやPRへ保存しない。このeventはWebAuthn challenge bootstrapで、POSTであっても資産・設定を変更するwriteではない。HTTP methodだけでread/writeを分類できない具体例である。
- Bitwarden vaultには本人のSBI VCトレードitemとpasskey sectionが存在することだけを確認した。username、password、passkey material、TOTP、Cookie、response bodyは表示・複製・保存していない。live bootstrapではKogane Capture Chromeで既存passkeyを使い、ID/password + MFAは公式に残るfallbackとする。

### 公開bundle/source map

`/login`から直接または実行時に観測した現行chunkは次の5件だった。

| artifact | bytes | SHA-256 |
|---|---:|---|
| `b21877a.js` | 33,499 | `d68fba0d820170d325466a639f2aa2e52a8b95e9b0ca015561d38dca3e9fe3c5` |
| `138abe1.js` | 4,128 | `21f1333fc473cab7db5d1bacb4627919fc9e6ea756bc13b003342e9df19cb602` |
| `70aeb42.js` | 300,940 | `78e0f0c8a551be815eeafc77133f10ce1e77545bf1af5466bb57b8802e020ad4` |
| `85a3155.js` | 1,564,956 | `4bf32b912ad1b72cfab6e9a2bfde4601d53ccac45b06966dae6b97775ca3dbf6` |
| `f89914f.js` | 496,749 | `ff7856cdbd3080d87c8bfba7f45fb6b2982fdf26699114a57bd7089a3f87582f` |

全5件の`.map`もHTTP 200だった。`f89914f.js.map`は882,355 bytes、SHA-256 `2c7c20685a71b1e9748e48e7cd8cb7d9e00271a9f68a4feccf22e5a3f69492fe`で、PR #23時点と同じmain bundle/source内容だった。`serverAPIClient.ts`から再確認した最小read schemaは次のとおり。

login page map `b21877a.js.map`は91,166 bytes、SHA-256 `d5c3e578f302981163acf19289631468cb0185b4229c231cd5c5c69a7fe2935a`、配布`simplewebauthn-browser.min.js`は9,234 bytes、SHA-256 `7597a071cdf7634156e2185a61b6e3f535fe544c23d3bad1be7f599c0a3b4cfa`だった。sourceは`@simplewebauthn/browser@13.2.2`に対応する。ここに記録した主要artifactの`Last-Modified`はすべて2026-08-05だった。

| event | path | request dataの必須要素 | 用途 |
|---|---|---|---|
| `cashBalanceList` | `/api/cccmdipresen/gw/trade` | `secureKey` | 日本円・暗号資産残高 |
| `accountMargin` | 同上 | `secureKey` | 純資産、証拠金等の口座詳細 |
| `positionSummaryList` | 同上 | `secureKey` | 保有ポジションsummary |
| `executionList` | 同上 | `secureKey`, page, sort, `historical` | 約定履歴。recent/historicalが別view |
| `getCashflowList` | 同上 | `secureKey`, page, `historical`, currency/type filters | 日本円入出金等のcashflow |

約定履歴pageの実行時chunkは`32085e8.js`（23,308 bytes、SHA-256 `5669689931bf53e76a3cd98d4f4144ce70e5fb70e7feef9a74722085bee867c3`）、mapは61,277 bytes、SHA-256 `78b0bcfdaf5c37d72a8b79220c784286fe5dd5363e520e5187e6248d369867aa`だった。source `pages/trade-history.vue`は`sortKey: "executionDatetime"`、`sortAsc: "false"`、page size 30を使う。最初にhistorical pageを取得し、page 0だけrecent viewも取得してclient側でmergeする。page 1以降はhistorical viewだけである。PoCもこの順序と値へ合わせ、推測のsort keyやrecent全page走査を行わない。

入出金履歴pageのchunkは`12ae015.js`（10,317 bytes、SHA-256 `d2a77c40f3a80e68010be78f14eec395c9fbddc7562ff4d65673b15242d5e706`）、mapのSHA-256は`4746882930a46470b5042c68ca9b3482afc3c92d745b8964dc50e904a6032269`だった。source `pages/account-activity/history.vue`はpage size 30で`historical: "true"`を1回ずつpage走査し、recent/old mergeをしない。default filterは`currency: ["JPY"]`、`cashflowType: ["REMITTANCE_DEPOSIT", "REMITTANCE_WITHDRAW"]`である。公開UIはdate fieldを送らないため、PoCもformatを推測した任意date filterを送らない。

`secureKey`はpublic source上の`store.state.loginId`であり、Authorization bearerとは確認できない。Cookie名、CSRFの有無、Cookieと`secureKey`の結合、server session TTL、refresh方法、Turnstile通過後に通常HTTP replayが許可されるかは、まだlive sessionで未確認である。client定数`sessionTimeoutTime: 14400`をserver側4時間保証と解釈しない。

### login transportと境界

- password login: `POST /api/cccmdipresen/gw/login`, `{event: "login", data: {accountId, password, response}}`。`response`はTurnstile token。
- second auth: `POST /api/cccmdipresen/gw/loginSecondAuth`, `{event: "loginSecondAuth", data: {accountId, authCode}}`。
- passkey開始: `POST /api/cccmdipresen/gw/initiateLoginWithPasskey`, dataは`channel: "SIMPLE_MODE"`。
- passkey完了: `POST /api/cccmdipresen/gw/loginWithPasskey`。challenge、credential ID、authenticator data、client data JSON、signature、user handleを送る。

password login requestにはTurnstile tokenの`response`があるが、公開source上のpasskey開始・完了request DTOにはTurnstile token fieldがない。2026-08-31のKogane Capture Chromeで開始・完了が200となり、後述のWorker新規sessionでも同じ2 requestが成功した。したがって今回のpasskey経路ではTurnstile token、browser Cookie、Cloudflare bot cookieを必要としないことまで実証した。

second authの`authType`は`0`がemail、`1`がauthenticator/TOTP、`2`がSMSである。password loginが失敗した場合、clientはTurnstile tokenを再利用せずwidgetをresetする。Turnstile tokenはCloudflare仕様上5分・single-useであり、保存・再利用するsession credentialではない。passkey completion後はsecond-auth endpointを通らずlogin成功処理へ進む。

login resultの`isAgreed`がfalseの場合、現行UIは`setAgreement` write eventへ進む。collectorは規約同意を自動実行せず、即停止して本人操作へhandoffする。

### 認証済みlive検証

2026-08-31、本人が**Kogane Capture Chrome profile**でBitwardenに保存していた既存passkeyを選択しloginに成功した。以下の認証済みnetwork/schema evidenceはすべてこのprofileで取得した。秘密、request/response bodyの実値、Cookie値、口座ID、残高、IPは保存していない。

| 順序 | sanitized metadata | 結果 |
|---:|---|---|
| 1 | 未認証`accountMargin` / `positionSummaryList` | HTTP 403 `text/html` |
| 2 | `initiateLoginWithPasskey` | HTTP 200 JSON |
| 3 | WebAuthn assertionを本人が承認し`loginWithPasskey` | HTTP 200 JSON |
| 4 | 認証後`accountMargin` | HTTP 200 JSON |
| 5 | `informationTitle`, `getAuthStatus`, `getPasskeyList` | すべてHTTP 200 JSON |
| 6 | read-onlyの保有資産画面 | `positionSummaryList`と`accountMargin`がHTTP 200 JSON |
| 7 | read-onlyの取引履歴画面 | `executionList`をrecent/historical各1回、どちらもHTTP 200 JSON |
| 8 | read-onlyの取引報告書一覧 | `tradeReportList`を2回、どちらもHTTP 200 JSON |
| 9 | page reload | `/login#verifyGa`へredirect |

liveの`loginWithPasskey` request keyは公開DTOどおりchallenge、credential ID、authenticator data、client data JSON、signature、user handleで、Turnstile fieldはなかった。全fieldはpaddingなしbase64urlだった。`clientDataJSON`は`webauthn.get`、origin `https://simple.sbivc.co.jp`、`crossOrigin: false`、authenticator dataは37 bytes、RP ID hash一致、flags `0x1d`（UP/UV/BE/BS）、counter 0、signatureはP-256 ECDSAのASN.1 DERだった。Bitwarden保存credential IDはUUIDをraw 16 bytesへ変換するとrequest値と一致し、user handleも一致した。

`accountMargin` bodyには`cashBalance`、`receivedMarginList`（46件）、`lendingLimitList`（33件）、`withdrawalLimitList`（23件）、`restrictedWithdrawalAmountList`（23件）と関連margin fieldが存在した。件数とfield名だけを記録し、各item・金額・銘柄等は保存していない。`getAuthStatus` bodyは`isIdentified`と`isTotpIdentified`、`getPasskeyList` itemはchannel、credential ID、last-used datetime、label、register datetime/source IP fieldを持ち、list lengthは1だった。値は保存していない。

保有資産画面では`positionSummaryList`が`{secureKey}`だけを送りHTTP 200 JSONとなった。この口座のlive response bodyは空objectだったため、position item shapeはlive確認できておらず、公開bundle DTOの構造を暫定とする。残高collectorでは`cashBalanceList`、`accountMargin`と併せてこのeventを固定allowlistに含める。

取引履歴画面は公開sourceどおり`executionList`を2回送り、request keyは`historical`、`isCloseOrder`、`isExOrder`、page number/size、`secureKey`、sort ascending/keyだった。両方HTTP 200で、一方は6 item、他方は0 itemだった。recent/historicalの対応をresponse値から推測せず、requestの`historical` fieldで区別する。live item keyにはexecution ID/sub-number、currency pair、product ID、約定数量・価格・日時、commission amount/currency、trade/order price、order/buy-sell/close/ex-order type、settle/swap/base-currency PL、trade channel、public/internal memo、value dateがあった。envelopeにはpage number/size/total pages/total sizeとmetaの`secureKey`、session update time、status、timestampがあった。field名と件数だけを保存し、実値は破棄した。

取引報告書一覧は`tradeReportList`を2回送り、request keyはbasis date from/to、unread-only、page number/size、`secureKey`、statement typeだった。どちらもHTTP 200で各7 itemを返し、item keyはbasis date、read status/name、report title、statement type、pagination fieldはstringだった。値は破棄した。list eventはtyped allowlistへ加えるが、report detail/downloadはread statusを更新する可能性が未確認なのでクリック・実装しない。

最初のhome表示とread APIは成功したが、reload後は`/login#verifyGa`へ戻った。原因はpasskey後sessionの短期性、reload時の追加検証、Cookie/sessionStorageの組合せ、Kogane Capture条件等のいずれか未確定である。このため「sessionが通常reloadで永続する」「Cookieと`secureKey`をBunへ移せる」「daily cronで再利用できる」はまだ証明されていない。

passkeyはSMBC Safety Passのように特定bank appの登録端末で毎回生体承認させる独自方式ではない。既存Bitwarden credentialでlive loginでき、CLIからWebAuthn credential構造も取得できた。利用者方針によりKogane専用credentialは作成せず、同じ既存credentialをWorker側の無人再認証に使う。private key、credential ID、user handle、counterは金融credentialとしてGitやDurable Objectへ置かずWorker Secretだけに限定し、生成後のsessionだけを暗号化Durable Object状態にする。

Cloudflare Workers Web Cryptoで、上記browser assertionと同じRP ID/origin、flags、counter、credential ID変換、P1363→DER署名変換を実装した。Bitwarden CLIから既存credentialの必要fieldだけをWorker Secretへ投入し、Cloudflare Workerからの実loginに成功した。credentialのcounterは0のためBitwarden本体との分岐は観測されず、専用passkeyもContainer/browser handoffも不要である。

## 13. read-only gateway PoC

[`poc/sbi-vc-trade-client`](../../poc/sbi-vc-trade-client/)に、認証済みsessionから上記4 eventだけを呼ぶローカルBun clientを追加した。

設計上の制限:

1. generic event senderをexportしない。同じ`trade` pathにある注文、取消、出金・出庫、貸コイン申込、積立、MFA/passkey変更を呼ぶAPIは実装しない。
2. browser loginとread replayを分離する。PoCはpassword、TOTP、SMS/email OTP、Turnstile token、passkey secretを受け取らない。
3. 一時session fileはCookie headerと`secureKey`だけを持ち、mode 600を強制する。値をargument、stdout、errorへ出さない。
4. recentとhistoricalを別々に取得する。1回だけの`historical=true`で全期間を得たと仮定しない。
5. responseはHTTP success、JSON content type、`meta.status === "OK"`を確認する。maintenance HTMLやvalidation errorをraw dataとして保存しない。
6. paginationは`list`と`totalSize`が確認できた場合だけ続行し、100 pageの既定上限を設ける。schema不明時に無限走査しない。
7. outputには実残高・履歴が含まれるためlocal private directoryだけに置き、Git、CI artifact、stdout、Cloudflareへ送らない。

synthetic testでは、request shape、recent/historical分離、pagination停止、non-JSON/error拒否、error textにsession値を含めないことを確認した。さらにKogane Capture Chromeの認証済みsessionをmode 600のtmpfs file経由でlocal Bun clientへ渡し、固定allowlistの全collectorを実データで完走した。直接HTTP replay、pagination、session rolling更新、無人passkey再認証まで実証済みで、server absolute TTLだけが未確認である。

### 完了したlive検証

1. 既存passkeyによるKogane Capture Chrome loginに成功した。
2. Kuebikoのraw captureを秘密artifactとして扱い、Cookieと`secureKey`をstdoutへ出さずmode 600のtmpfs fileへ渡した。
3. Cookieなしreplayがapplication側の「ログインしていません」403になることを1回確認した。
4. Cookie + `secureKey`ではBun clientの`cashBalanceList`、`accountMargin`、`positionSummaryList`、`executionList` recent/historical、`getCashflowList` historicalがすべてHTTP 200 JSON、gateway `OK`になった。
5. pagination停止とprivate output modeを確認し、session tmpfs fileを削除した。実値・実件数・秘密はGit/PRへ記録していない。
6. Workers Cronを複数回発火させ、暗号化sessionと8 Cookieのrolling更新を確認した。
7. 既存Bitwarden passkeyをWorker Secretへ最小化投入し、Worker-onlyの新規loginと直後のread-only keepaliveに成功した。

認証済みsessionのdirect replayと、失効後に使う新規bootstrapの両方をWorker-onlyで実証した。password経路のTurnstile、browser TLS fingerprint、Chrome、Container、TAMIAは採用しない。残る実装課題は、既存Bun collectorの固定read allowlistをWorkerへ統合し、原responseをR2へ安全に保存することである。

### runtime候補の優先順位

| runtime | 現時点の判断 | 次に証明すること |
|---|---|---|
| Worker-only + 既存Bitwarden passkey | **採用** | Cloudflare IPから新規login、8 Cookie/`secureKey`構築、read確認まで成功 |
| Worker keepalive | **採用** | 15分CronとCookie rotation成功。実際のabsolute expiry到達時fallbackを長期観測 |
| Container + full Chrome | 不採用 | Worker-only認証が成立したため不要 |
| Worker-only + password | 非推奨 | DOM Turnstileとsingle-use tokenを別runtimeへ渡す不安定性が大きい |
| Browser Rendering | 後順位 | current CDP schemaでWebAuthn virtual authenticatorを使えるか未確認 |

### third-party client再調査

2026-08-31にGitHub code searchを`simple.sbivc.co.jp`、`co.jp.sbivc.trade.app`、`cashBalanceList`で再実行したが、現行VCTRADEへloginしてnetwork取得するmaintained public clientは見つからなかった。CCXTの2026-08-29 snapshotにもSBI VCトレードimplementationは確認できない。

`kittyflip-zig/crypto-ledger-tools`はnetwork clientではなくMITのlocal CSV normalizerである。2026-06 snapshotの`sbivc_trade_record` adapterは`trade_record_list`または`約定日時/銘柄/売買/数量`列を認識し、数量、約定rate、手数料等をJPY quoteの共通recordへ変換する。一方、SBI専用fixture/testと`CASHFLOW` parserは確認できない。offline importの参考にはなるが、auth/session automationの先例ではない。

追加の技術資料:

- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [現行login page source map](https://simple.sbivc.co.jp/_nuxt/b21877a.js.map)
- [約定履歴page source map](https://simple.sbivc.co.jp/_nuxt/32085e8.js.map)
- [入出金履歴page source map](https://simple.sbivc.co.jp/_nuxt/12ae015.js.map)
- [`crypto-ledger-tools` SBI adapter](https://github.com/kittyflip-zig/crypto-ledger-tools/blob/33758391c2b93ce99812257b2e4c1c82b67c6a1d/src/crypto_ledger_tools/exchange_adapters.py)

残る未確認事項は、server absolute TTL、passkey credential失効時のerror schema、rate limit、report取得によるread status更新、最大page size、history retention、アプリ固有transport/pinning/integrityである。

## 14. 2026-08-31 認証済みWeb sessionの直接replay

本人がKogane Capture ChromeでBitwarden passkey loginを完了した後、read-only eventだけを使ってbrowser外replayを1回ずつ検証した。Kogane Captureは`--net-log-capture-mode=Everything`で起動していたため、raw capture自体はCookie等を含み得る秘密artifactとして扱う。Cookie値、`secureKey`、口座識別子、金額、銘柄、取引内容、response bodyは標準出力、Git、PR本文へ出していない。

### 認証とsession境界

- `initiateLoginWithPasskey`と`loginWithPasskey`はKogane Capture ChromeでHTTP 200 JSONだった。live `loginWithPasskey` requestのtop-level fieldはWebAuthn assertion一式で、Turnstile response fieldはなかった。
- 認証前の`trade` callはHTTP 403 HTML、認証後の`accountMargin`、`positionSummaryList`、`executionList`、`tradeReportList`はHTTP 200 JSONだった。
- KuebikoのNetLogでは、認証済み`trade` requestに`cookie` headerがあり、responseには複数の`set-cookie` headerがあった。公開bundleだけから推測していたCookie session利用をlive確認できた。
- Kuebikoが保存した最新`secureKey`だけを使い、Cookieを付けずWSL/Bunから`accountMargin`を送るとHTTP 403、HTML titleは`ログインしていません`だった。Cloudflare challenge pageではなくapplication session拒否である。
- 同じWSL/Bun、同じrequest bodyへ認証済みCookieを付けるとHTTP 200 `application/json`、gateway status `OK`になった。したがって、この試験ではbrowser TLS fingerprintやbrowser process自体はreplayの必須条件ではなく、Cookieと`secureKey`の組が必要だった。
- Cookieと`secureKey`のserver側absolute TTLは未確認である。一度reloadで`/login#verifyGa`へ戻った観測もあるため、client定数だけからsession lifetimeを決めない。別IP/regionへの移送とpasskeyからの完全無人bootstrapは後続Worker試験で成功した。

### Cookie最小化とrotation

認証後の19回の`trade` requestについて、Cookie値と`secureKey`を出力せずSHA-256同値比較だけを行った。`secureKey`、`vct_bff_sid`、`JSESSIONID`、`AWSALBAPP-0`から`AWSALBAPP-3`は全期間で同一だった。一方、`AWSALB`、`AWSALBCORS`、2個の`__cf_bm`は繰り返し変化し、完全なCookie headerは19回中ほぼ毎回異なった。

login responseの属性では、`vct_bff_sid`と`__cf_bm`の`Expires`が約30分後、`AWSALB`、`AWSALBCORS`、`AWSALBAPP-0..3`が約7日後だった。`JSESSIONID`には`Expires`/`Max-Age`がなくsession cookieだった。後続の認証済み`trade` responseも同じcookie名を`Set-Cookie`し、`vct_bff_sid`は同じ値のまま約30分先へ、AWS routing cookieは約7日先へ期限を延長していた。したがって30分は固定login寿命ではなくrolling idle windowの可能性が高い。再認証を避ける常駐collectorは30分未満のread-only keepaliveと`Set-Cookie`追従が必要になる。server側absolute lifetimeは引き続き不明である。

`accountMargin`だけを使ったleave-one-out試験では次の結果になった。

| Cookie subset | 結果 |
|---|---|
| `vct_bff_sid` + `JSESSIONID`だけ | application側403 |
| 上記2個 + `AWSALBAPP-0..3` | 初回は200、後の再試験では403。routing先依存で再現性なし |
| 上記成功集合から`AWSALBAPP` fragmentを1個ずつ除外 | 4通りすべてapplication側403 |
| `AWSALBAPP-0..3` + `JSESSIONID`（`vct_bff_sid`なし） | application側403 |
| `AWSALBAPP-0..3` + `vct_bff_sid`（`JSESSIONID`なし） | application側403 |
| 完全headerから`__cf_bm`を除外 | HTTP 200 / gateway `OK` |
| 完全headerから`AWSALB`/`AWSALBCORS`/`AWSALBAPP-*`を除外 | application側403 |

6 cookieだけで通った試行はあったが再現しなかったため、production入力から`AWSALB`と`AWSALBCORS`を除外してはならない。今回再現できた集合は、`vct_bff_sid`、`JSESSIONID`、分割された`AWSALBAPP-0..3`、`AWSALB`、`AWSALBCORS`の8 cookieである。`__cf_bm`は除外しても成功し、Bun既定User-AgentとChrome User-Agentの両方で完全headerは成功した。したがってCloudflare Bot Management cookieやChrome UAは同一host replayの必須条件ではない。一方、AWS routing cookieは頻繁にrotationするため、長時間collectorではresponseの`Set-Cookie`を追従するcookie jarが必要になる可能性がある。別IP/regionでも同じとはまだ断定しない。

### read-only collectorの実データ検証

`poc/sbi-vc-trade-client`へCookieと`secureKey`をmode 600のtmpfs fileで渡し、次の固定allowlistだけを実行した。

- `cashBalanceList`
- `accountMargin`
- `positionSummaryList`
- `executionList`のrecent page 0とhistorical pagination
- `getCashflowList`のhistorical pagination（JPY入出金filter）

全eventがHTTP 200 JSON、gateway status `OK`となり、collectorは6個のlocal artifactを生成して正常終了した。さらにsession inputを上記8 cookieへ型付けした後も、`__cf_bm`を送らずcollector全体が再度成功した。実件数と実値は公開文書へ記録しない。paginationは`list`と`totalSize`で停止し、最大100 pageの上限を維持した。最初の出力directoryはmode 700、各JSONはmode 600で、Git管理外の`~/.local/share/kogane/sbi-vc-trade/<timestamp>/`へ保存した。8-cookie再検証のoutputとsession fileはtmpfs上で確認後に削除した。Cookie/`secureKey`はartifactへ含めていない。

この結果により、transport部分は標準的なWorkers/Bun `fetch`へ移植した。さらに既存Bitwarden passkeyをWorker Web Cryptoで利用し、Cookie/`secureKey`の新規bootstrapにも成功した。write eventと同じgateway/sessionを共有するため、今後もgeneric event senderを作らず、compile-time read allowlistを維持する。

## 15. Cloudflare Workers session・passkey PoC

[`poc/sbi-vc-trade-worker`](../../poc/sbi-vc-trade-worker/)へ、一時Worker `kogane-sbi-vc-session-poc`を追加した。Cloudflareの有料plan上でDurable Objectと15分Cronを使う。GitHub Actionsはtriggerに使わない。

### 構成

- `SESSION_SEED` Worker Secretに、実測で必要だった8 Cookieと`secureKey`を初期投入する。
- `SESSION_ENCRYPTION_KEY` Worker SecretをAES-256-GCM keyとし、rotation後のsessionをDurable Objectへ暗号化保存する。
- `PASSKEY_CREDENTIAL` Worker Secretには、既存Bitwarden credentialのcredential ID、PKCS#8 P-256 private key、RP ID、user handle、counter、algorithm/curveだけを投入する。master passwordとBitwarden session keyは投入しない。
- Cronは`*/15 * * * *`で、公式UI自身が10分ごとに使う軽いread-only event `informationTitle`を1回だけ送る。
- responseは64 KiB上限でJSON envelopeと`meta.status === "OK"`だけを確認し、bodyを保存しない。
- `Set-Cookie`は8 Cookieだけを追従し、`__cf_bm`は無視する。`meta.secureKey`が変化した場合も暗号化状態へ反映する。
- 平文healthはlast attempt/success、HTTP/gateway status、Cookie更新数、連続失敗数、固定error codeだけで、残高・履歴・Cookie値・response bodyを含まない。
- 手動`/run`、`/reauth`、`/health`はrandom bearer tokenのWorker Secretで保護する。
- keepaliveがHTTP 401/403、gateway拒否、seed欠落になった場合だけ再認証する。6時間cooldownで反復loginを抑止し、同種の同時実行を単一Promiseへ畳み込み、keepaliveと再認証のsession変更はDurable Object内で直列化する。
- passkey完了responseの`body.accountId`は直後のread APIの`secureKey`と一致したため、新規sessionの`secureKey`として使う。`isAgreed !== true`なら`setAgreement`を送らず停止する。

### live結果

2026-08-31 JST、Kuebiko NetLog末尾256 MiBから直近の認証済み`trade` requestを構造化し、値を標準出力へ出さず8 Cookieを抽出した。最新`informationTitle` requestから`secureKey`も取得し、mode 600のtmpfsを経由して`wrangler secret put`の標準入力へ渡した。seed tmpfs fileは投入直後に削除した。

初回実行はHTTP 200 JSON、gateway `OK`となり、3件のsession更新を暗号化状態へ反映した。したがって現在の認証済みsessionはCloudflare Workers egressへ移送可能で、少なくともこの経路では日本の家庭IP、TAMIA、browser TLS fingerprint、Chrome User-Agent、`__cf_bm`は必要ない。後続試験ではCloudflare IPからのlogin/passkey bootstrapにも成功した。

Workers runtimeで`redirect: "error"`を指定したsubrequestはresponseを返さずTypeErrorになった。同じrequestを`redirect: "manual"`（追従なし）へ変えると200になったため、SBI側3xxを観測したとは記録せず、Workers fetchのredirect mode差として扱う。

Cronは複数回実発火し、少なくとも2026-08-31 02:00 UTCの時点でもHTTP 200、gateway `OK`、連続失敗0だった。

同日、WSLでBitwarden CLIをunlockし、`SBI VCトレード` itemの既存FIDO2 credentialから必要7 fieldだけをtmpfsへ抽出した。Worker Secret投入後に`/reauth`を1回実行し、Cloudflare Workerから`initiateLoginWithPasskey`、P-256 WebAuthn assertion生成、`loginWithPasskey`、新sessionでの`informationTitle`まで連続成功した。healthは再認証成功、HTTP 200、gateway `OK`、Cookie更新3件、連続失敗0を示した。Chrome、TAMIA、日本家庭IP、Turnstile token、過去session Cookie、`__cf_bm`は使っていない。

これによりrolling keepaliveとabsolute/session失効後の無人復旧経路の両方を実証した。未確認なのは、実際にabsolute expiryへ達した瞬間の自動fallback、credential revoke、backend schema変更、長期rate limitである。手動`/reauth`成功だけでCron fallbackの全failure modeまで証明したとは扱わない。

### cleanup対象

- Worker: `kogane-sbi-vc-session-poc`
- Durable Object class: `SbiVcSessionState`
- Cron: `*/15 * * * *`
- Secrets: `SESSION_SEED`, `SESSION_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `PASSKEY_CREDENTIAL`

検証終了時は`poc/sbi-vc-trade-worker`から`npx wrangler delete --name kogane-sbi-vc-session-poc`でまとめて削除する。現時点ではCron継続検証のため残す。
