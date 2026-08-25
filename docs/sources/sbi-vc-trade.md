# SBI VCトレード（VCTRADE）調査

- 調査日: 2026-08-26（Australia/Sydney）
- 対象: SBI VCトレード株式会社が提供する **VCTRADE** の日本円・暗号資産口座データ取得面
- 対象外: 同社の別サービス、SBI証券、カード、外部アグリゲーター
- 制約: 公開情報と受動的な通信確認のみ。口座識別子、氏名、メールアドレス、電話番号、実残高、取引内容、Cookie値、パスワード、TOTPシード、OTP、passkeyを取得・記録していない。注文、取消、入出金、暗号資産の入出庫、貸コイン申込、認証・口座設定変更は実施していない。

## 結論

SBI VCトレードには、暗号資産・日本円の資産状況、残高履歴、注文履歴、約定履歴、入出金・入出庫履歴、損益・報告書、ステーキング、貸コインの読み取り面がある。一方、顧客向け公開APIは現時点で未提供で、公式FAQは将来の公開予定としている。したがって、安全な初期実装は、利用者が公式画面から手動取得したPDFまたはZIP内CSVを、ネットワーク通信を持たないローカル処理へ渡す方式である。

総合評価は **E / コスト1**（手動エクスポート + ローカル解析）。認証済みWebの非公開通信再生は **C候補 / コスト4**、完全ブラウザーまたはアプリ自動化は **D / コスト5** だが、MFA/passkey、Cloudflareのbot対策、同一セッション内の書き込み機能、非公開仕様変更のため推奨しない。公開APIが実際に提供され、読み取り専用scopeと安定した仕様が確認できた場合に限りAを再評価する。

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

Bitwarden自体はWebサイト・アプリのpasskey保存と利用に対応する。しかし、SBI VCトレードの公式対応プロバイダー一覧にBitwardenはなく、同サービスとの互換性は**未確認**である。「一般にWebAuthn対応だから使える」とは断定しない。パスワード、TOTPシード、passkeyを同一自動化プロセスへ渡す設計も採用しない。

一次資料:

- [通常ログイン](https://www.sbivc.co.jp/guide/1-1)
- [多要素認証の必須化と方式](https://www.sbivc.co.jp/faqs/content/fychc8w9x)
- [認証アプリの設定](https://www.sbivc.co.jp/faqs/content/mmiani3gx8)
- [passkeyの仕様・対応環境](https://www.sbivc.co.jp/guide/5-1)
- [passkey導入案内](https://www.sbivc.co.jp/faqs/content/ym7cngjgatqv)
- [passkey登録上限](https://www.sbivc.co.jp/guide/5-6)
- [ログインロック](https://www.sbivc.co.jp/faqs/content/m9howuvxidze)
- [Bitwarden公式: passkey保存・自動入力](https://bitwarden.com/help/storing-passkeys/)

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
- 旧モバイルアプリは2026-01-28に終了し、2026-01-29から現行アプリへ一本化された。旧APK/旧マニュアルから現在のtransportや認証を推測しない。
- シンプルモードはPC/スマートフォン向けの簡易UI、トレーダーモードはPC向け高機能UI、現行アプリは保有推移、TradingViewチャート、スピード注文、ステーキング表示を統合する。
- APKのダウンロード、逆コンパイル、計測、証明書ピンニング回避は行わない。公開ストアメタデータと公式Webだけを利用する。

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

したがって、確認できる第三者transport/authは「利用者が手動取得したローカルファイルを読む / 認証なし」に限られる。非公開APIのURL、Cookie、CSRF token、リクエスト署名をブラウザーバンドルから抽出・再生しない。

一次資料:

- [API公開予定の公式FAQ](https://www.sbivc.co.jp/faqs/content/5c0nv5540jm3)
- [取引所サービス説明](https://www.sbivc.co.jp/auction)

## 8. read / write endpointの隔離

### 推奨境界

最も安全な構成では、認証済みネットワーク接続そのものを解析器から除外する。利用者が公式画面でPDF/ZIPを手動取得し、ローカル解析器は読み取り専用でマウントされた入力だけを処理する。生ファイル、PII、金額、アドレス、口座IDはGit、ログ、クラウドへ送らない。

将来公式APIが提供された場合も、次を満たすまで接続しない。

1. 公式文書に読み取り専用scopeとendpointが明記されている。
2. 書き込み権限を持たない別credentialを発行できる。
3. 公式に副作用なしとされた操作だけをroute allowlistに置く。HTTP GETという理由だけで安全とはみなさない。
4. deny-by-default、外向き通信先制限、レスポンスログの値マスク、少量の合成試験を行う。

### UIを観察する場合のallowlist

資産状況、残高履歴、注文履歴、約定履歴、入出金・入出庫履歴、報告書、貸コイン履歴、ステーキング表示だけを候補とする。ただし未約定注文一覧やポジション照会には取消・決済操作が隣接するため、一覧表示後はクリックしない。

### denylist

注文、スピード注文、取消・変更、クイック決済、日本円入出金、暗号資産入出庫、出庫アドレス追加・削除、貸コイン申込・取消、積立、パスワード/MFA/passkey/個人情報/銀行口座設定、規約同意は全面禁止とする。JavaScriptアプリ内でread/writeが同一セッションに混在する以上、ブラウザー自動化だけでは強いtransport分離を証明できない。

## 9. Workers / Containers / OCI / Kubernetes適性

- **ローカルOCIコンテナ: 適合。** ZIP/CSV/PDFのオフライン解析器をOCI imageとして再現可能にできる。入力はread-only mount、出力はローカル、network none、非root、固定digestが望ましい。単一利用者には通常のローカルCLIでも十分。
- **Cloudflare Workers: 自動取得には不適合。** Cronとファイル処理能力はあるが、公式APIがなく認証ソースを安全に定期取得できない。手動アップロード解析は技術上可能でも、金融PIIをクラウドへ送る理由がないため既定案にしない。
- **Cloudflare Containers: 技術上可能だが非推奨。** Linux/amd64のフルランタイムやブラウザー処理を実行できても、MFA/passkey、bot対策、read/write混在を解決しない。オフライン解析だけならローカルOCIで足りる。
- **Cloudflare Browser Rendering: 技術上はCDP/Playwright対応だが非推奨。** ブラウザー能力はサービス側の許可、認証安全性、書き込み隔離を意味しない。
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
| 非公開Web通信の再生 | **C候補 / 4** | 技術的推測は可能でも、session/MFA/bot/副作用境界が非公開。採用しない。 |
| Web完全自動化 | **D / 5** | passkey/MFA、Cloudflare bot対策、書き込み隣接により危険。 |
| アプリ/端末自動化 | **D / 5** | 端末認証と操作面の混在。APK解析も対象外。 |

## 11. read-only live検証計画とstop条件

### 段階的検証

1. 公開ガイド、FAQ、公式ストア、受動的DNS/HTTPヘッダーだけを確認する。
2. 追加検証が明示的に許可された場合も、利用者が自分でログインし、調査者は画面名と導線だけを見る。資格情報、OTP、QR、passkey prompt、実残高・実取引をキャプチャしない。
3. 利用者が報告書/ZIPを自分で一度ダウンロードし、Git管理外のローカル一時領域へ置く。最初は値を読み込まず、列名、ファイル名、文字コード、期間表現だけをマスク済みで確認する。生ファイルはcommit・ログ・クラウド送信しない。
4. 確認できたschemaだけから合成fixtureを作り、オフラインparserを検証する。実値をfixtureへ転記しない。
5. 最大期間・件数・カラムが不明なら「不明」のまま残し、反復ダウンロードや過去全期間取得で探索しない。

### 即時停止条件

- ログイン、MFA、passkey、メール/SMSコード、QR、TOTPシード、秘密鍵、Cookie値の入力・表示・保存が調査者側に必要になる。
- 追加規約への同意、端末登録、認証設定変更、パスワード再設定が要求される。
- 403、429、Cloudflare challenge、CAPTCHA、アクセス制限、ログイン失敗またはロック警告が出る。再試行しない。
- 注文、取消、決済、入出金、入出庫、アドレス登録、貸コイン申込、積立、設定変更へ進む必要がある。
- 公式に文書化されたread-only APIがなく、非公開endpoint、Cookie replay、アプリ解析が必要になる。
- ファイルや画面にPII、実残高、実取引、暗号資産アドレス等が見え、マスク前にログ・保存される可能性がある。

このstop条件に達した場合、E / cost 1の手動export方式を維持し、それ以上の自動化を行わない。
