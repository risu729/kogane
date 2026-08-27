# Epos / Epos Visa Prepaid family 調査

- 調査日: 2026-08-26（Australia/Sydney）
- 対象: エポスカード、エポスVisaプリペイドカード、エポスNet、エポスアプリ、および同じ明細に入る追加カード
- 対象外: 他社カード、外部アグリゲーターを初期データ源とする経路、決済代行・加盟店向けサービス
- 安全条件: 公開情報と受動的な公開ホスト観測のみ。会員ID、カード番号、セキュリティコード、氏名、連絡先、実残高、実利用額、Cookie値、パスワード、OTPを取得・記録していない。支払い、チャージ、返金、リボ・分割変更、ポイント利用、カード設定、個人情報変更等のwrite操作は実施していない。

## 結論

クレジットカードの履歴取得は、PC版エポスNetの「月別ご利用履歴照会」が最も情報量と保存期間に優れ、2006年3月以降を月単位でPDF/CSV出力できる。請求書相当の「ご利用代金明細書」はPDF、支払結果は過去12カ月を画面/印刷で確認できる。アプリは未確定通知、月次グラフ、カテゴリ分け、過去24カ月の明細書閲覧に強いが、一括CSV exportの公式記載はない。

エポスVisaプリペイドはエポスNet/アプリで現在残高と月指定の利用履歴を確認できるが、公開一次資料には最大保存期間、件数上限、CSV/PDF exportが記載されていない。クレジットと同じCSVに入るとは仮定しない。

初期実装は **E / cost 1–2**（PC版で利用者が手動取得するクレジットCSV/PDF + ローカル解析）。プリペイドとポイントは **E / cost 2** の手動記録を安全な既定とする。公式APIは確認できない。次段階として、公開Web JavaScript・正規入手した公式APKのread-only静的解析、および本人が操作するセッションの通信メタデータ動的観測を **C候補 / cost 3–4** として行う価値がある。取引/write、秘密・PII保存、認証・WAF・証明書ピンニング等のsecurity control bypassは行わない。

## 1. familyとデータ所有境界

### 本会員のクレジットカード

- エポスNetは支払予定額、利用履歴、支払履歴、利用可能額、キャッシング明細、ポイント等を扱う。
- クレジットカードに「預金残高」はなく、収集対象は利用可能額、請求予定額、利用/支払履歴である。利用可能額は支払日の直後ではなく、金融機関の引落結果をエポスが確認した後に戻る。

### 家族

- エポスファミリーゴールドは一般的な従属型家族カードではない。各人に独立したエポスゴールドカード、利用限度額、明細、引落口座が設定される。
- 個別利用内容を閲覧できるのはカード名義人本人だけ。代表者が家族個人の明細を取得する経路として扱わない。
- ファミリー登録者はアプリ/エポスNetで「現在の家族合計利用金額」を確認できるが、これは個別取引明細ではなく集計値である。

### 追加カード

- エポスETCカードは親カード1枚につき1枚。利用は親カードのショッピング等と同じ明細へ入り、ETCだけのエポス発行明細書は作れない。データ到着は道路事業者次第で、目安は利用後約3週間。
- エポスバーチャルカードは親カードへ追加され、利用可能枠を親カードの範囲内で設定し、利用分は親カードと合わせて請求される。
- エポスVisaプリペイドは会員本人専用で、クレジット明細とは別の残高・利用履歴照会導線を持つ。

一次資料:

- [エポスNetの機能](https://www.eposcard.co.jp/eposnet/index.html)
- [照会・登録メニュー](https://www.eposcard.co.jp/eposnetuse/index.html)
- [ファミリーゴールドの所有・明細境界](https://www.eposcard.co.jp/family_gold/index.html)
- [家族の個別利用内容は名義人のみ](https://faq.eposcard.co.jp/faq/show/1625)
- [ETCカード](https://www.eposcard.co.jp/eposcard/etc_use.html)
- [ETCだけの明細書は発行不可](https://faq.eposcard.co.jp/faq/show/3418)
- [バーチャルカード](https://www.eposcard.co.jp/virtual/index_01.html)
- [Visaプリペイド](https://www.eposcard.co.jp/prepaid/index.html)

## 2. 経路別の粒度・期間・export・trade-off

| 経路 | 粒度・状態 | 公開された期間 | export | trade-off |
|---|---|---:|---|---|
| PCエポスNet「月別ご利用履歴」 | 利用日、利用場所、利用金額、支払区分、支払開始月。返金は元の利用月で取消日と負額を表示 | 2006年3月以降 | PDF / CSV | 最長・構造化。月選択が必要で、未確定の早期通知とは意味が異なる |
| エポスNet「ご利用代金明細書」 | 利用日、利用先、利用金額、支払回数、今回支払額、リボ/分割 | アプリFAQは過去24カ月を案内。Webの別上限は未確認 | PDF | 請求書相当で支払回数を含むが、CSVではない |
| エポスNet/アプリ「支払履歴」 | 支払日、支払額、支払方法と、その内訳 | 過去12カ月 | PC印刷。CSV/PDFの公式記載なし | 実際の支払確認に向くが、利用履歴より保持期間が短い |
| エポスアプリ「お支払照会」 | 未確定通知、確定明細、月額グラフ、カテゴリ、支払変更導線 | 明細書は過去24カ月、支払履歴は12カ月 | 画面/PDF閲覧。CSV記載なし | タイムリーで見やすいがwrite導線が近く、構造化exportに弱い |
| Visaプリペイド残高 | 現在の利用可能残高 | 現在値 | 公式export記載なし | 即時把握に向く。履歴スナップショットではない |
| Visaプリペイド利用履歴 | 年月を指定する利用履歴。加盟店データ反映は通常2–14日 | 最大過去期間・件数は未確認 | CSV/PDFの公式記載なし | クレジット履歴と分離。手動転記または後段transport調査が必要 |
| エポスポイント | 現在残高、期限が近いポイント、利用可能日 | 通常ポイントは付与日から2年 | 公式export/完全履歴期間の記載なし | 期限監視には十分だが、増減台帳の機械取得仕様はない |

PC向けPDF/CSVの項目と形式は、エポスカード自身の個人情報開示案内にも明記される。公開情報からは、各CSVの最大行数、ページサイズ、文字コード、ファイル命名、同月再取得時の安定性、プリペイド履歴の完全な列定義を確定できない。

一次資料:

- [利用明細・履歴の期間と形式](https://faq.eposcard.co.jp/faq/show/90)
- [公式開示案内にある明細項目・出力形式](https://www.eposcard.co.jp/pdf/release_application.pdf)
- [アプリで過去24カ月の明細書](https://faq.eposcard.co.jp/faq/show/3607)
- [支払履歴は過去12カ月](https://faq.eposcard.co.jp/faq/show/3505)
- [プリペイド履歴の確認経路](https://faq.eposcard.co.jp/faq/show/809)

## 3. 未確定・確定・返金・分割

### クレジット

- アプリの「未確定」は、利用先から正式な利用情報が未着で請求未確定の状態。通知到着後、通常2–14日で正式情報が反映され、未確定表示が消えて利用先名が表示される。
- 利用通知は利用を試みただけでも届く場合があり、請求確定を意味しない。通知、未確定明細、確定明細を同一イベントとして重複計上してはならない。
- 27日払いでは前月28日～当月27日分が翌月6日に確定、27日支払。4日払いでは前月5日～当月4日分が当月11日に確定、翌月4日支払。確定後に到着した利用データは次回請求へ入る。
- 返金/取消データの到着は1～4週間程度かかり得る。月別利用履歴では元の利用月を選ぶと、備考に取消日、利用金額に負額で表示される。締切後到着なら一度引き落とした後に返金され得る。
- ご利用代金明細書は支払回数、今回支払額、リボ/分割を持つ。あとから分割/リボは正式情報到着後から変更期限まで可能だが、これはwrite操作であり調査対象画面から実行しない。

### Visaプリペイド

- 原則は利用時に残高から即時減算。ただし通販の発送時処理、通信状況、海外為替等で遅延や金額変更があり得る。
- ホテル/レンタカーのデポジットや有効性確認の少額利用では一時的に二重/余分な減算となり、即時～最長45日後に返金され、最終額だけが残る場合がある。
- 返品/取消は加盟店から取消データが到着した時点で残高へ反映される。クレジットの「未確定」表示と同じ状態機械とは仮定しない。
- カード残高の有効期限はカード表面の有効期限で、利用者都合の払戻しはできない。

一次資料:

- [アプリの「未確定」](https://faq.eposcard.co.jp/faq/show/2690)
- [利用通知は請求確定ではない](https://faq.eposcard.co.jp/faq/show/2679)
- [明細反映と締め・確定日](https://faq.eposcard.co.jp/faq/show/138)
- [クレジット返金の表示](https://faq.eposcard.co.jp/faq/show/2429)
- [あとから分割/リボの開始条件](https://faq.eposcard.co.jp/faq/show/3629)
- [プリペイドの即時減算・デポジット・返金](https://www.eposcard.co.jp/prepaid/index.html)
- [プリペイド返品時の残高反映](https://faq.eposcard.co.jp/faq/show/828)

## 4. エポスポイントと有効期限

- 通常ポイントは加算日から2年間で、2年後の加算日の前日まで有効。期限が近いものから使われる。
- 3カ月以内に失効するポイントがある場合、エポスNet/アプリに延長操作が表示され、全ポイントを24カ月後まで延長できる。ただし延長はwriteなので実施しない。
- ゴールド/プラチナのエポスポイントは無期限。退会・資格喪失時等の失効条件は残る。
- 残高と期限間近のポイントはエポスNetで確認できる。ポイントの加算日は支払日により異なり、加盟店売上データ到着が遅いと加算も遅れる。
- ポイントからVisaプリペイドへ移行できるが、チャージはwriteであり禁止。プリペイド利用額の0.5%は翌月中旬にカード残高へキャッシュバックされる。

一次資料:

- [ポイントの加算日・期限・確認方法](https://www.eposcard.co.jp/point/use.html)
- [現行ポイント規約](https://www.eposcard.co.jp/rule/rule_point.html)
- [ポイント期限FAQ](https://faq.eposcard.co.jp/faq/show/53)

## 5. 認証、MFA、passkey、Bitwarden

### 確認できた事実

- エポスNetの通常ログイン画面はエポスNet IDとパスワードを要求する。ログインIDはメールアドレスではない。
- リスクベースの追加確認として、必要に応じカード裏面の3桁セキュリティコードを求める場合がある。これは機密情報であり、自動化へ渡さない。
- エポスNet/アプリへのログインごとにメール通知する任意サービスがある。公式FAQは家計簿等の連携サービスが不定期にエポスNetへログインする場合にも通知が出ると説明する。
- エポスアプリは初回にエポスNet ID/パスワードを入力した後、対応端末でFace ID、生体認証、オートログインを利用できる。機種変更後は再インストールし、ログイン時に追加認証を求められる場合がある。
- Visa Secure 3-D Secure 2.0はオンライン**決済**用で、必要時に登録携帯へ8桁SMS OTPを送り、有効時間は2分。これはエポスNetの通常ログインMFAと混同しない。

### passkey / Bitwarden

2026-08-26時点の公式サイト・FAQ・ログイン画面で、エポスNetのWebAuthn/passkey対応を確認できなかった。アプリのFace IDは端末上の便利なログイン方式だが、公開資料だけから同期型passkeyやFIDO2 credentialと同一とは言えない。

BitwardenはID/パスワードのURIベース自動入力とpasskey保存に一般対応する。ただしエポス固有の公式互換性は確認できず、エポス側passkeyも未確認である。利用する場合もURI matchは公式HTTPSホストへ厳密化し、カード番号、セキュリティコード、SMS OTPは保管・自動入力対象にしない。

未確認事項は、通常ログイン時の追加認証判定、session TTL、refresh機構、端末信頼の期限、アプリtokenの保存方式、device attestation、証明書ピンニングである。

一次資料:

- [公式ログイン画面](https://www.eposcard.co.jp/memberservice/pc/login/login_certify_advertised.do)
- [ログイン時の追加セキュリティコード](https://faq.eposcard.co.jp/faq/show/1709)
- [ログイン通知と連携サービス](https://faq.eposcard.co.jp/faq/show/844)
- [Face ID初回登録](https://faq.eposcard.co.jp/faq/show/2443)
- [機種変更時の認証](https://faq.eposcard.co.jp/faq/show/2485)
- [Visa Secure 3-D Secure 2.0](https://faq.eposcard.co.jp/faq/show/3408)
- [SMS OTP](https://faq.eposcard.co.jp/faq/show/1547)
- [Bitwarden URI match](https://bitwarden.com/help/uri-match-detection/)
- [Bitwarden autofill/passkey](https://bitwarden.com/help/auto-fill-browser/)

## 6. CDN / WAF / anti-bot の受動観測

2026-08-26に公開URLへDNS、HEAD/GETのみを実行した。Cookie値は保存していない。

- `www.eposcard.co.jp` は `www.eposcard.co.jp.edgekey.net`、さらに `*.akamaiedge.net` へCNAME解決し、Akamai edge配下であることを確認した。
- 公開トップとログイン画面で `Akamai-GRN`、`_abck`、`ak_bmsc`、`bm_sz` のCookie名を確認した。Akamai公式資料は `edgekey.net` をAkamai edge hostnameとして説明し、Bot Manager関連Cookieが人と自動処理の識別に使われる例を示す。
- 静的トップの背後にはAmazon S3/CloudFrontを示す応答も見え、ログインはApache/JSESSIONID系だった。これは受動観測であり、origin構成を断定しない。
- `faq.eposcard.co.jp` は別のFAQ基盤へCNAME解決し、会員サイトと同じ防御・sessionとは仮定しない。
- Akamai利用とbot対策信号は確認済みだが、Kona Site Defender等の製品名、WAF rule、bot score、rate limit、challenge条件は未確認。公開画面でchallengeが出ないことは認証後も出ない証拠ではない。

一次資料:

- [Akamai edge hostnameの説明](https://techdocs.akamai.com/property-mgr/docs/key-concepts-terms)
- [AkamaiのBot Manager cookie説明例](https://techdocs.akamai.com/identity-cloud/docs/hosted-login-cookies-and-local-storage-1)

## 7. 公式アプリ / APK / Web

- 公式Android packageは `jp.co.eposcard.epossupportapp`、iOS App Store IDは `1489130153`。アプリ利用にはエポスNet登録が必要。
- Webは長期月別履歴とPDF/CSV、支払/ポイント/プリペイドの照会に強い一方、各種変更手続きも同居する。
- アプリは即時通知、未確定表示、グラフ、カテゴリ、明細書閲覧、ポイント/プリペイド導線に強い一方、支払方法変更を支援するwrite UIも同居する。

公式経路で不明なtransportを補う次段階として、以下のread-only解析を許容する。

1. 公式ストアから正規に入手したAPKのhashを記録し、Manifest、権限、exported component、network security config、公開文字列、endpoint hostname、schema/model名、証明書ピンニング設定の有無を静的確認する。
2. 公開Web JavaScript bundleのURL/hash、source map公開有無、endpoint文字列、read/write route名、CSRF/session処理を静的確認する。
3. 本人が操作するテストセッションでDevToolsまたは端末の標準プロキシ設定を使い、HTTP method、hostname、path template、content type、status、呼出元画面だけを動的観測する。request/response body、Cookie、token、カード/会員番号、実値は保存しない。
4. TLS/pinning等により観測できない場合はそこで停止し、無効化・hook・root化等のsecurity control bypassは行わない。

一次資料:

- [公式アプリ案内](https://www.eposcard.co.jp/appli/index.html)
- [Google Play公式掲載](https://play.google.com/store/apps/details?id=jp.co.eposcard.epossupportapp)
- [Apple App Store公式掲載](https://apps.apple.com/jp/app/%E3%82%A8%E3%83%9D%E3%82%B9%E3%82%A2%E3%83%97%E3%83%AA/id1489130153)

## 8. 公開API / third-party client のtransportとauth

- 顧客向けに文書化された公開API、API key、OAuth、read-only scopeは公式サイトで確認できなかった。
- 公式FAQは家計簿等の連携サービスが「不定期にエポスNetにログイン」する場合があると説明する。少なくとも一部連携がログインsession型であることを示すが、credentialの保管主体、MFA処理、endpoint、契約APIの有無は公開していない。
- GitHubを公式host、login path、Android package、サービス名で検索したが、維持された公開クライアントや具体的な認証実装は確認できなかった。phishing list、bookmark、単なるリンクはclientとして数えていない。
- よって現時点で再現可能な第三者transport/authはない。上記の静的/動的観測で、first-party Web/appのread transportを特定することが次の実験となる。非公開仕様を特定できても、利用規約、技術的安定性、write分離を別途評価する。

## 9. read / write隔離

### 安全な既定

手動CSV/PDF export後の解析器には認証済みネットワーク機能を持たせない。入力はread-only、外向き通信なし、原本はGit外、ログには列名・件数・期間だけを残し、値は残さない。

### 画面allowlist

- お支払予定額照会、月別ご利用履歴照会、お支払履歴照会、ご利用代金明細書照会
- 利用可能額照会、ポイント照会
- Visaプリペイド残高照会、利用履歴照会
- ファミリー合計利用金額（個別明細ではない）

### denylist

支払、チャージ、ポイント利用/移行/延長、リボ/分割変更、いつでもリボ、キャッシング、返済、カード申込/停止/再発行、利用可能額変更、バーチャルカード設定、プリペイドPIN、通知設定、住所/口座/ID/パスワード変更はwriteとして禁止する。

### transport特定後の隔離条件

- UI操作とnetwork callを対応付け、read endpoint候補をhost + method + path templateでallowlist化する。
- `GET`だけを自動的にsafeとはみなさず、公式動作または合成/空データで副作用なしを確認する。readがPOSTの場合もbodyの操作種別を固定する。
- 最初は観測だけでreplayしない。replayする場合も1件の明示的read、低頻度、同一利用者、response値非保存から始める。
- write host/path/actionは明示deny。CSRF tokenやsession credentialをログへ出さず、read-only credential/scopeを発見できない限り強い分離は未達と表示する。

## 10. Workers / Containers / OCI / Kubernetes適性

- **ローカルCLI / OCI: 適合。** CSV/PDF parserをOCI imageとして固定し、read-only input、network none、non-root、固定digestで実行できる。単一利用者では最も小さい構成。
- **Cloudflare Workers: export解析には技術上可能、自動取得には時期尚早。** Scheduled handlerはあるが、公式API/read-only credentialがない。金融PIIをクラウドへ送る必要もないため、既定はローカル。将来、文書化されたread-only APIが出れば再評価する。
- **Cloudflare Containers: 静的解析やブラウザー依存処理を動かせるが、認証・bot・write分離は解決しない。** 公開APK/JSの再現可能な静的解析環境には使えるが、個人の実データは投入しない。
- **Cloudflare Browser Run: 技術的にはブラウザー操作・CDPが可能。** read-only観測の再現実験には候補だが、Akamai challengeや追加認証で止め、回避しない。認証済み定期取得は安全境界の検証後に限る。
- **Kubernetes: 単一利用者には過剰。** 組織的な多数exportのオフライン処理ならCronJob、Secret、NetworkPolicyを使えるが、cluster導入はAPI/認証問題を解決しない。

基盤の一次資料:

- [Cloudflare Workers Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- [Cloudflare Containers](https://developers.cloudflare.com/containers/get-started/)
- [Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/)
- [OCI Image Specification](https://specs.opencontainers.org/image-spec/)
- [Kubernetes CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)

## 11. PR #5 共通A–E / cost

[PR #5](https://github.com/risu729/kogane/pull/5) の共通尺度だけを用いる。

- A: scheduled headlessに適した文書化済みの直接export/API
- B: 更新/再利用できるsessionを使う安定したread-only内部API
- C: browser/app bootstrap後のheadless replayが現実的
- D: 完全なbrowser/device automationが必要と思われる
- E: manual captureが安全な既定
- cost 1: 小さなwrapper ～ cost 5: device-bound/adversarial automation

| 対象経路 | Level / cost | 判断 |
|---|---:|---|
| クレジット月別CSV/PDF手動export | **E / 1–2** | 長期・公式・構造化。月単位選択と手動取得が必要 |
| 請求PDF / 支払履歴印刷 | **E / 1** | 容易だがCSVより解析コスト、保持期間に差 |
| プリペイド残高/履歴、ポイント手動capture | **E / 2** | 公式export不明、値の手動マスクが必要 |
| 公開JS/APK静的解析 | **C候補の調査 / 3** | endpoint/auth/write境界を具体化できる。実データ不要 |
| 本人操作sessionの動的観測/replay | **C候補 / 4** | Akamai、追加認証、session、write混在。観測から段階化 |
| アプリ完全自動化 | **D / 5** | device-bound。read-only境界を先に証明する必要 |
| 公式read-only API | 未評価（A候補） | 現時点で仕様を確認できない |

## 12. read-only live検証とstop条件

### 次の実験

1. PC版エポスNetで利用者が手動ログインし、調査者はメニュー名、年月selector、exportボタンだけを確認する。実値は表示・撮影・記録しない。
2. 利用者が合意した1カ月分のCSV/PDFをGit外一時領域へ手動保存する。値を即時マスクし、header、文字コード、日付形式、支払区分、返金行の表現だけを確認する。原本はcommitしない。
3. プリペイド画面は年月selectorと履歴列名だけを確認し、残高/明細値を記録しない。CSV/PDFボタンの有無を確認するが、チャージ導線には進まない。
4. 公式APK/公開JSをhash固定して静的解析し、host/path候補とread/write分類を作る。secret、難読化解除キー、個人データは対象にしない。
5. 必要なら本人操作中のDevTools/標準プロキシで通信メタデータだけを観測する。生HAR、body、header値、Cookie/tokenを保存せず、画面操作とmethod/path templateの対応だけを残す。
6. synthetic fixtureでローカルparserとdedupeを検証する。通知、未確定、確定、取消負額を別状態として用意し、実利用を転記しない。

### 即時停止条件

- ID、パスワード、カード番号、セキュリティコード、SMS OTP、session/Cookie/token、PII、実値を調査者が入力・保存する必要がある。
- CAPTCHA、Akamai challenge、403、429、アクセス制限、ログイン失敗/ロック警告が出る。反復試行や回避をしない。
- TLS interception、証明書ピンニング無効化、root/jailbreak、hook、WAF回避等のsecurity control bypassが必要になる。
- 支払、チャージ、返金、ポイント利用、リボ/分割、キャッシング、カード/個人/口座/認証/通知設定のwriteが必要になる。
- readとwriteをtransportで識別できず、副作用なしを確認できない。
- export/通信captureに実値・秘密が入り、マスク前にログ・Git・クラウドへ残る可能性がある。

stop後は、既に確認済みの手動CSV/PDFまたは画面captureへ戻し、不明点を不明のまま記録する。

## 13. 事実・推測・未確認の整理

### 事実

- PC月別履歴は2006年3月以降、PDF/CSV。支払履歴は12カ月、アプリ明細書は24カ月。
- クレジット未確定、確定、取消負額には公式に説明された異なる表示がある。
- プリペイド残高/履歴は別導線で、原則即時減算だが遅延・訂正・返金がある。
- 通常ポイントは2年、ゴールド/プラチナは無期限。
- WebはID/パスワードと条件付きカードセキュリティコード、アプリは初回後の生体/オートログイン、決済はVisa Secure SMS OTPを使う。
- Akamai edgeとbot対策Cookie名を受動観測した。

### 推測

- 公開Web/appは認証済みHTTP transportを持つため、read routeの特定自体は静的/動的解析で可能と思われる。
- 家計簿連携の公式記述からsession型連携の実在は分かるが、第三者が同じ方式を安全に再現できるとは限らない。
- 月別CSVが最も安定したcollector入力になりそうだが、schema安定性はlive sampleで未検証。

### 未確認

- 公開/契約API、OAuth、read-only scopeの有無。
- CSVの完全schema、文字コード、最大件数、ページング、同一取引ID、未確定行のCSV収録。
- プリペイド履歴の最大期間・件数・列、CSV/PDF export、返金行表現。
- ポイント増減履歴の期間/export。
- session/token lifecycle、端末binding、passkey、アプリpinning/attestation。
- family合計値の更新頻度とexport。
- Akamaiの具体的WAF/Bot Manager設定とrate limit。
