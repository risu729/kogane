# Rakuten Card / Rakuten Point / Rakuten Cash source research

調査日: 2026-08-26（公開情報およびログアウト状態の公開 endpoint）、live 検証は未実施

## 1. 対象範囲と禁止事項

この記録の単位は、個人向けの楽天カード、楽天ポイント、楽天キャッシュである。請求の正本は
楽天カード会員向けの楽天 e-NAVI、ポイント/キャッシュ履歴の正本は楽天 PointClub、現在の
キャッシュ残高と日常利用の surface は楽天ペイアプリとして分ける。楽天銀行、楽天証券、
楽天 Edy、楽天市場の注文履歴、加盟店向け楽天ペイ、法人向けサービスは対象外である。

許可するのは、既存の残高、既存の確定/未確定明細、ポイント/キャッシュ履歴、期限、既存の
PDF/CSV の表示・取得と、ユーザー管理端末/アカウントに対する read-only な静的解析・動的観測
である。支払、チャージ、送付/受取、出金、ポイント利用/交換/運用、リボ/分割変更、キャンペーン
entry、カード申込、登録・通知・認証設定変更等の write は行わない。

口座・カード・会員番号、氏名、生年月日、電話、メール、Cookie、OTP、passkey private key、
session/token、実残高、実請求額、実加盟店名を取得物、HAR、スクリーンショット、ログ、commit に
残さない。正規アプリ/公開 JavaScript の deobfuscation、静的解析、runtime tracing、通信メタデータ
観測自体は対象であるが、certificate pinning、端末 integrity/attestation、WAF/CAPTCHA、rate limit
等の security control は回避しない。

## 2. 方法と証拠の強さ

- 楽天カード、楽天 PointClub、楽天キャッシュ、楽天ペイ、楽天 ID、Google Play の公式ページを
  主な根拠にした。aggregator は探索にも根拠にも使っていない。
- 2026-08-26 にログアウト状態で公開 URL の status/header/redirect だけを低頻度で観測した。
  認証、challenge 誘発、負荷試験、credential 入力は行っていない。
- GitHub の公開コードを具体的な commit で読み、transport/auth/DOM の実装を確認した。第三者実装の
  現行動作は live 検証していない。
- Google Play が配信する APK/split APK はこの環境では取得していない。package/version/provenance は
  Play の公式 listing まで、private app API は次実験までとする。
- 以下では **確認事実**、そこからの **推測/設計判断**、**未確認** を分ける。

## 3. 正本と取得経路の trade-off

| 資産/記録 | 正本候補 | 主な read surface | 強み | 主な欠落/危険 |
| --- | --- | --- | --- | --- |
| カード請求・利用 | 楽天 e-NAVI | PC web、楽天カードアプリ | 確定月は PC で CSV/PDF。家族/ETC を利用者別に確認可能 | 通知は未確定かつ項目不足。アプリには支払調整等の write が同居 |
| 楽天ポイント | 楽天 PointClub | PointClub web/app | 通常/期間限定、利用可能/獲得予定、期限、増減履歴を分離 | 公開資料に公式 CSV/PDF なし。履歴は 1 年 |
| 楽天キャッシュ | PointClub の履歴 + 楽天ペイの現在残高 | PointClub web、楽天ペイアプリ | PointClub でポイントと Cash の状態別履歴、Pay で現在残高 | Pay は支払/チャージ/送付/出金と密接。公式 CSV/PDF は未確認 |

カードアプリの「総保有ポイント」を PointClub のポイント/Cash 台帳の代替にしない。逆に
PointClub のポイント履歴からカード請求明細を再構成しない。カード CSV/PDF、PointClub 履歴、
Pay 残高は、取得時刻を持つ別 source record として後段で照合する。

## 4. 楽天カード / e-NAVI

### 4.1 カード、本会員、家族、ETC の識別

確認事実:

- [複数カードの明細確認 FAQ](https://support.rakuten-card.jp/faq/show/27896?site_domain=guest)
  は、e-NAVI で表示カードを切り替え、カードごとの明細を見る方式を案内する。未登録カードは
  追加登録が必要な場合がある。
- [e-NAVI 登録 FAQ](https://support.rakuten-card.jp/faq/show/136?site_domain=guest) によると、
  家族カード会員は本会員の ID ではなく、自分の楽天 ID/password で登録する。ETC カード単体は
  e-NAVI に登録できず、利用分は紐付く本カードの明細に合算される。
- [家族カード明細 FAQ](https://support.rakuten-card.jp/faq/show/124165?site_domain=guest) は、本会員が
  家族分を含む明細と「利用者」を確認でき、家族会員は自分の利用分だけを確認できるとする。
- [ETC 明細 FAQ](https://support.rakuten-card.jp/faq/show/226?site_domain=guest) は、ETC 利用が
  e-NAVI に届くまで 2 週間から 1 か月程度かかる場合があり、それ以前は ETC 利用照会サービスを
  案内する。
- [WEB 明細サービス](https://www.rakuten-card.co.jp/service/bill/) は、家族カード/ETC カード
  ごとに明細を印刷・download できると案内する。

設計判断:

- 本会員明細は家族/ETC を既に含むため、本会員 CSV と家族会員側 CSV を単純結合すると二重計上
  する。請求正本は本会員側を優先し、「利用者」またはカード種別は attribution にだけ使う。
- 番号下4桁を repository key にしない。画面上のカード表示名、券種、本会員/家族/ETC、包含関係を
  人手で確認し、ローカルのランダム source key に対応させる。
- ETC の遅延は欠落と同義ではない。ETC 利用照会を追加 source にするかは、同一行の照合キーと
  二重計上防止を別に検証してから決める。

### 4.2 確定、未確定、取消/返金、分割/リボ

| 状態 | 公式 surface で確認できる粒度 | 解釈上の注意 |
| --- | --- | --- |
| 利用通知/速報 | 楽天カードアプリの利用金額・利用日時等 | 正式な明細ではなく、店名がまだない場合がある |
| 売上データ待ち | 加盟店データ到着前の通知 | 通知から明細反映まで 2 日以上かかる場合がある |
| 請求予定/確定明細 | 利用日、利用先、利用者、支払方法、利用金額を中心とする明細行 | 加盟店送信時期に依存し、利用日直後の完全性はない |
| 取消/返金/調整 | キャンセル、返金額、`金額調整あり` 等 | 原取引との安定 ID は公開資料で確認できない |
| 分割/ボーナス | 初月は元の利用金額と当月請求額、後続月は当月請求額 | 元金、各月請求、手数料を一つの金額列へ潰さない |

[利用通知 FAQ](https://support.rakuten-card.jp/faq/show/5535?site_domain=guest) と
[通知と明細の違い](https://support.rakuten-card.jp/faq/show/179048?site_domain=guest) は、通知が
確定明細ではなく、楽天カードが売上情報を受け取って初めて利用先を含む「正式に請求予定」の明細に
なるとする。[キャンセル/返金 FAQ](https://support.rakuten-card.jp/faq/show/15916?site_domain=guest)
は取消、返金、税還付、金額調整を別表示し、到着時期に差があるとする。
[分割払いの明細 FAQ](https://support.rakuten-card.jp/faq/show/199797?site_domain=guest) は、初回と
2 回目以降で「利用金額」「当月請求額」の表示が異なることを説明する。

したがって、通知/pending と posted を同じ行へ破壊的に上書きしない。各 snapshot に
`observed_at` と source state を持たせ、利用日・金額・利用者・merchant の正規化候補で照合する。
通知の消失を取消と断定せず、確定行または調整行が現れるまで provisional とする。公開資料だけでは
authorization ID、原取引と返金の link ID、承認時刻、外貨原額/換算 rate の全列を確認できない。

### 4.3 期間、件数、CSV/PDF

- [過去明細 FAQ](https://support.rakuten-card.jp/faq/show/4184?site_domain=guest) は、確定した
  過去 15 か月分を e-NAVI で確認でき、16 か月以上前は確認できないとする。CSV/PDF を定期保存する
  必要がある。
- 同 FAQ と [WEB 明細サービス](https://www.rakuten-card.co.jp/service/bill/) は PDF/CSV を提供する。
  CSV は PC の e-NAVI だけ、PDF は PC/スマートフォンから利用できる。
- [CSV download 注意事項](https://www.rakuten-card.co.jp/e-navi/p/rc/e-navi/statement/popup2.html)
  によると、CSV は確定済みの月ごとに取得し、明細 1 件が 2 行になる場合がある。リボ手数料、
  支払回数、当月支払額、次月繰越残高等は含まれず、利用店名が途中で切れる場合もある。
- [明細 download FAQ](https://support.rakuten-card.jp/faq/show/2385?site_domain=guest) は、当月 PDF
  が原則 12 日以降に表示され、アプリからも e-NAVI の PDF 導線を利用すると案内する。

経路別 trade-off:

- **CSV**: 機械処理しやすく月次 archive の初期 route に最適。ただし 2 行化、merchant truncation、
  リボ/分割内訳欠落を parser で明示し、行数=取引数としない。公式案内には UTF-8 への文字コード
  変換が必要な場合がある旨もある。
- **PDF**: 請求書として表示忠実度が高く、CSV が落とす支払内訳の確認用 evidence に向く。一方、
  text extraction/表復元が難しく、氏名・支払口座表示等の PII を含み得るため原本を暗号化隔離する。
- **画面/アプリ通知**: 未確定の早期発見に向くが、export は確認できず、通知項目も不完全。月次 CSV
  の代替ではない。

公開公式資料では、1 ページ当たりの行数、月当たり最大件数、pagination、CSV の完全な header/
encoding、同一明細 2 行の link 仕様、外貨/返金の厳密な列を確認できなかった。live 検証項目とする。

## 5. 楽天 Point / PointClub

### 5.1 通常、期間限定、獲得予定、期限

[ポイントルール](https://point.rakuten.co.jp/guidance/rule/) は、通常ポイントの期限を獲得月を含む
1 年とし、期間内に通常ポイントを獲得すると期限が延長されると説明する。期間限定ポイントの獲得は
通常ポイントの期限を延長しない。同ページは「獲得予定」と「利用可能」を分け、総保有表示には
利用可能ポイントと楽天キャッシュが関係することも示す。

[ポイント利用規約](https://point.rakuten.co.jp/guidance/terms/) と
[用語説明](https://point.rakuten.co.jp/guidance/definition/) によると、期間限定ポイントは付与ごとの
固有期限を持ち、期限の近いものから利用される。cancel 後に戻る時点ですでに期限切れなら戻らない
場合がある。

保存する概念は少なくとも次のとおりである。

- 通常ポイントの利用可能残高と表示期限
- 期間限定ポイントの expiry bucket（期限日別）
- 獲得予定ポイント、利用可能予定日、状態
- ポイント増減 ledger（獲得、利用、失効、取消、交換/運用等の状態）
- 楽天キャッシュをポイント残高に混ぜない別 asset type

期限は snapshot ごとに再取得する。通常ポイントの延長ルールを、各ポイント lot の永久保存期限と
誤解しない。期間限定の最短期限だけでなく、取得可能なら全 expiry bucket を保存する。

### 5.2 履歴粒度、期間、export

[ポイント実績の見方](https://point.rakuten.co.jp/guidance/historycheck/?l-id=point_nav_historycheck_sp)
は、PointClub のポイント実績に楽天ポイントと楽天キャッシュの両方を表示し、期間/対象で絞込、
並替できるとする。確認できる列は反映日、サービス、内容、状態と増減数、備考で、内容には店舗/
商品/価格または campaign/service の説明が入り得る。ポイントには利用、獲得、失効、取消、交換の
受付/処理/取消/完了、運用関連の状態がある。

公式に確認できる履歴期間は **過去 1 年** である。公開公式資料には PointClub 履歴の CSV/PDF
download、API、最大件数、1 ページ件数の説明を確認できなかった。「公式 export がない」と断定せず、
「公開資料で未確認」とする。1 年を超える保存が必要なら、まず月次の read-only 手動 capture または
監査済みローカル exporter を検討する。

[PointClub 公式アプリ](https://point.rakuten.co.jp/guidance/app/) は現在/獲得予定、履歴や期限通知の
日常確認に向くが、くじ、campaign、ポイント運用等の write/状態変更導線も同居する。網羅的な台帳
抽出は web の実績表の方が観測しやすい候補である。

## 6. 楽天 Cash / 楽天ペイ

[楽天キャッシュ基本ルール](https://cash.rakuten.co.jp/Guidance/GuidanceCashRule/) は、利用履歴を
楽天 PointClub で確認する導線を示す。[ポイント実績の見方](https://point.rakuten.co.jp/guidance/historycheck/?l-id=point_nav_historycheck_sp)
は Cash について、チャージ、送付（処理中/完了）、受取辞退、送付取消戻し、出金申請/完了/取消等の
状態を列挙する。したがって単一の signed amount だけでなく、asset=`rakuten_cash` と state を保存する。

[楽天ペイの Cash 案内](https://pay.rakuten.co.jp/guide/cash/) は、楽天ペイアプリで現在の
楽天キャッシュ残高を確認できるとする。アプリは支払、チャージ、送付/受取、出金等の write surface
でもあるため、残高表示以外へ遷移しない。[楽天キャッシュ利用規約](https://cash.rakuten.co.jp/Guidance/GuidanceCashAgreement/)
では基本型/プレミアム型が定義され、残高変動から 10 年の期限がある。live では基本型/プレミアム型の
表示分離と、PointClub 履歴の asset/state を確認する。

Cash の履歴期間は PointClub の公開説明上 1 年で、Cash 専用 CSV/PDF/API は公開公式資料で未確認で
ある。Pay の現在残高 snapshot と PointClub の過去増減を足し戻して「正しい全期間残高」を作る
ことは、期間外取引や取消があるため行わない。

## 7. 認証、MFA、passkey、Bitwarden

### 7.1 確認事実

- [e-NAVI の ID/password FAQ](https://support.rakuten-card.jp/faq/show/186?site_domain=guest) は、
  楽天 ID/password を使う。e-NAVI には一部手続用の「第2パスワード」もあるが、reset/設定は write
  なので行わない。
- [楽天 ID の対応 FAQ](https://support.rakuten-card.jp/faq/show/41365?site_domain=guest) は、複数の
  楽天 ID がある場合、カード申込時に紐付いた ID が必要とする。
- [e-NAVI メール認証 FAQ](https://support.rakuten-card.jp/faq/show/192408?site_domain=guest) は、
  login 時に楽天 ID 登録メールへ確認 code を送る場合がある。発生条件や常時必須性は非公開である。
- [e-NAVI OTP FAQ](https://support.rakuten-card.jp/faq/show/169605?site_domain=guest) は SMS OTP を使う
  場面を案内するが、通常 login と sensitive write の境界は公開資料だけでは確定しない。
- [楽天カードアプリ生体認証 FAQ](https://support.rakuten-card.jp/faq/show/10507?site_domain=guest) の
  Face ID/指紋はアプリ login/unlock の機能であり、WebAuthn passkey と同一とは確認できない。
- [3D セキュア FAQ](https://support.rakuten-card.jp/faq/show/127259?site_domain=guest) の SMS OTP は
  online 購入時の本人認証で、e-NAVI/PointClub の通常 login MFA と混同しない。
- [楽天ペイ初期設定](https://pay.rakuten.co.jp/guide/howtouse/) は楽天 ID/password と電話発信による
  電話番号認証を使う。[楽天ペイ passkey 案内](https://pay.rakuten.co.jp/topics/fido2/) は FIDO2
  passkey を password の代わりに使え、作成時に email code を確認し、対応する楽天 ID サービス間で
  共有されると説明する。
- 2026-08-26 の匿名アクセスで PointClub 履歴は
  `login.account.rakuten.com/sso/authorize` へ `client_id=point_club_web`、`scope=openid profile`、
  `response_type=code` で 302 した。楽天 ID の
  [公開 OIDC discovery](https://login.account.rakuten.com/.well-known/openid-configuration) は
  authorization/token/userinfo/JWKS endpoint、authorization code、refresh token、device code、
  token exchange、PKCE S256 等を列挙する。

OIDC discovery は楽天 ID の identity transport を示すが、カード明細、ポイント、Cash を読む
public API/scopes を示してはいない。`point_club_web` の client credential/token を流用できるとも、
e-NAVI/Pay が同じ client/session だとも推測しない。

### 7.2 passkey と Bitwarden（確認と推測を分離）

楽天ペイでは passkey 対応が公式確認できた。一方、e-NAVI と PointClub が passkey login を受け付ける
かは今回確認できなかった。「楽天 ID サービス間で共有」は、各 relying service の対応を自動的に
保証しない。楽天カードアプリの生体認証も passkey の証拠にしない。

Bitwarden は一般に [browser autofill](https://bitwarden.com/help/auto-fill-browser/)、
[Android autofill](https://bitwarden.com/help/auto-fill-android/)、
[passkey 保存](https://bitwarden.com/help/storing-passkeys/) を提供する。この一般機能から、楽天 ID/
password 入力や、対応サイトでの passkey provider として使える可能性はあるが、楽天固有の公式連携・
互換性は確認できない。楽天公式案内の cloud sync 例は Apple/Google/Microsoft であり、Bitwarden を
明示していない。

ID/password、第2パスワード、メール/SMS OTP、電話番号を一つの vault item や automation runtime に
集約しない。passkey private key を export/HAR/log の対象にしない。OTP/manual approval が出たら
人へ handoff し、自動 retry しない。

未確認: session 寿命、refresh token が各 service client に発行されるか、同時 login、端末/IP binding、
メール/SMS challenge の頻度、app device key、e-NAVI/PointClub の passkey availability。

## 8. CDN、WAF、anti-bot

2026-08-26 のログアウト状態の低頻度 HTTP 観測:

| 公開入口 | 結果 | 言えること / 言えないこと |
| --- | --- | --- |
| `www.rakuten-card.co.jp/` | browser-like UA を含め `403`; `X-Akamai-Transformed` | 公開カード入口で Akamai の介在を確認。login 後判定や bot product/score は未確認 |
| `support.rakuten-card.jp/` | `200`, `Server: nginx` | FAQ origin の公開応答。e-NAVI auth origin と同じ保護とは限らない |
| `point.rakuten.co.jp/` | `200`, `Server: Apache`, HSTS/CSP | 公開 PointClub。履歴は楽天 ID OIDC authorization へ 302 |
| `pay.rakuten.co.jp/` | `200`, `Server: Apache`, HSTS/CSP | 公開 Pay content。app API/WAF は不明 |
| `cash.rakuten.co.jp/` | `200`, `Server: nginx`, HSTS/CSP | 公開 Cash content。残高/history auth origin は不明 |
| `login.account.rakuten.com` discovery | `200`, `Server: istio-envoy` | OIDC metadata は取得可能。authorization/login 防御は未評価 |

Card 公開 root の 403 は、単純な Worker `fetch()`/curl collector が e-NAVI に適する根拠がないことを
示す。ただし、これだけで browser automation も拒否される、Akamai が全 Rakuten surface を守る、
特定 cookie/header を付ければ通る、とは言えない。Cloudflare 固有 header は今回観測していないが、
Cloudflare/WAF 不在の証拠にはしない。

challenge/CAPTCHA を意図的に誘発せず、401/403/429、challenge/interstitial、認証 loop が出たら停止
する。cookie 合成、fingerprint spoofing、CAPTCHA solver、rate-limit 探索、pinning/attestation 回避を
行わない。

## 9. 公式 web/app/APK と公開実装

### 9.1 公式 app と web の役割

| 公式 app | Google Play package | 2026-08-26 に Play metadata で確認した version | 主な read 役割 |
| --- | --- | --- | --- |
| [楽天カード](https://play.google.com/store/apps/details?id=jp.co.rakuten.kc.rakutencardapp.android) | `jp.co.rakuten.kc.rakutencardapp.android` | `7.76.0` | 請求/明細、通知、利用可能額、総保有ポイント。支払調整等 write も同居 |
| [楽天 PointClub](https://play.google.com/store/apps/details?id=jp.co.rakuten.pointclub.android) | `jp.co.rakuten.pointclub.android` | `6.6.0` | ポイント残高/実績/予定/期限。獲得/運用/campaign 導線も同居 |
| [楽天ペイ](https://play.google.com/store/apps/details?id=jp.co.rakuten.pay) | `jp.co.rakuten.pay` | `9.17.0` | Point/Cash 現在残高。支払/チャージ/送付/出金 write が中心に同居 |

version は可変なので、解析 artifact ごとに package、versionCode/versionName、取得日時、SHA-256、
signer certificate digest を記録する。公式 standalone APK 配布は確認できない。この環境には
Google Play で正規 install 済みの Android device、`adb`、`apksigner`、`jadx`、`apktool`、MobSF が
なく、Play listing から binary を取得する認証済み経路もないため APK artifact を取得しなかった。
再配布 site は provenance を弱めるため利用しない。

web はカード CSV/PDF と PointClub 表の機械可読化に向く。app は通知、device-bound 認証、現在残高
と app-only transport の確認に向くが、write との近さと binary/端末依存が強い。最初から app UI を
自動化せず、公式 export/web を先に使う。

### 9.2 正規 split APK の次実験

ユーザー管理 Android へ Google Play から正規 install した後、各 package について次を行う。
binary/解析結果は repository 外の暗号化された一時領域に置き、共有しない。

```bash
PKG=jp.co.rakuten.kc.rakutencardapp.android  # PointClub/Pay は上表の package に変更
adb shell dumpsys package "$PKG" | grep -E 'version(Name|Code)|firstInstallTime|lastUpdateTime'
adb shell pm path "$PKG"
# 上で得た base.apk と全 split_config*.apk を一つずつ adb pull する
sha256sum artifact/*.apk
apksigner verify --verbose --print-certs artifact/base.apk
jadx -d jadx-out artifact/*.apk
apktool d -f artifact/base.apk -o apktool-out
rg -a -n 'https?://|wss://|retrofit|okhttp|graphql|grpc|protobuf|oauth|dpop|bearer|cookie|pin|certificate|integrity|attestation|safetynet' jadx-out apktool-out
```

- 全 split の signer digest が一致することを確認し、package/version/signer/hash のみを provenance
  record に残す。APK や decompiled code は commit しない。
- Manifest、network security config、host/path 定数、Retrofit/OkHttp/gRPC/GraphQL/protobuf schema
  候補、session/token の型名と更新 call、Play Integrity/attestation/pinning library 候補を列挙する。
- R8/ProGuard の難読化は deobfuscation の対象にできる。文字列復号や runtime tracing も read host/
  schema の同定目的なら対象だが、秘密値の出力や integrity/pinning bypass の hook は作らない。
- MobSF は local static scan に限定し、自動 dynamic action、第三者 cloud upload、binary 再配布をしない。

### 9.3 公開第三者 client の具体的 transport/auth

1. [mrkn/rakuten_card `fetch_latest.rb`](https://github.com/mrkn/rakuten_card/blob/91083b4943db9bb24f9b82afd906a2b206bbecf8/bin/fetch_latest.rb)
   （2016、license 表示なし）は Ruby Capybara + PhantomJS/Poltergeist で `http://rakuten-card.co.jp`
   から e-NAVI link をたどり、form `u`/`p` に環境変数/対話 password を入れる。HTML の
   `#latestSortForm` と `#nextLatestSortForm` table から先頭 5 cell を抽出する。JSON API、MFA、
   multi-card、CSV/PDF は扱わず、HTTP 起点と旧 DOM のため現行 transport の再利用根拠にしない。
2. [woinary/scraping_rakuten_point_py](https://github.com/woinary/scraping_rakuten_point_py/blob/97e43c267d13a82b2419deb803229aad20a0012a/scraping_rakuten_point.py)
   （2022）は Selenium/Chrome で PointClub 履歴へ進み、local `.config` の ID/password を login form
   へ入力する。`tr.get`/`tr.use` と `NEXT` pagination の HTML DOM を読み、日付、service、内容、
   通常/期間限定、増減、備考を UTF-8 BOM CSV にする。credential 平文 config、固定 selector、
   MFA/passkey 未対応のため production 採用しない。
3. [yuki-gu/ExportRakutenPointHistory](https://github.com/yuki-gu/ExportRakutenPointHistory/blob/ee5f61fc235ee9fb12ed0839cc6db4ea1ac6fb6d/main.js)
   （2026、MIT）は既に login 済みの PointClub page で動く bookmarklet である。同一 origin の
   `fetch(next href)` で `NEXT` 全 page の HTML を取得し、DOMParser で `tr.get`/`tr.use` を抽出して
   UTF-8 BOM CSV を browser download する。password/token を要求しないが、mutable な GitHub Pages
   script を認証済み page origin に注入する README 手順は supply-chain risk がある。採用するなら
   commit 固定コードを監査して local bookmarklet/bundle とし、network egress を PointClub だけに
   制限する。また `get/use` 以外の Cash 状態行を網羅するか live DOM で確認が必要である。

これらは web HTML/session-cookie 型の実装例であり、公式 API ではない。app transport、現行 e-NAVI
transport、楽天 ID token の financial scope の証拠にもならない。一方、PointClub の現在 DOM が
同一 origin GET + HTML pagination で読める可能性を示す、具体的な C 候補の材料ではある。

### 9.4 read-only 動的観測

1. **web**: ユーザー管理 browser で通常 login し、カード表示切替、確定月 1 件、未確定一覧、
   PointClub 履歴 1 page、Pay/Cash 残高表示だけを開く。DevTools で origin、method、path template、
   status、content-type、field 名だけを allowlist 収集する。
2. **sanitization**: Cookie/Authorization/CSRF/OTP、query 値、request/response 値、カード/会員番号、
   実額/merchant/PII は capture 前または直後に削除する。HAR は既定で保存せず、必要なら field 名
   だけの合成 schema を作る。secret scanner と手動 review を通すまで共有しない。
3. **app metadata**: user-installed CA を app が通常受理する場合だけ、body/secret を保存しない proxy
   で host/method/path/status/content-type を観測する。拒否、pinning、attestation/integrity error が
   出たら patch/hook で回避せず停止する。暗号化通信を解かず DNS/SNI/IP/timing だけを観測する経路も
   有効である。
4. **runtime tracing**: 正規 app process の URL builder、serializer 型名、read method 呼出を対象に
   できるが、token/cookie 値、crypto key、OTP、PII/実値を log しない。pinning/integrity判定を変更する
   hook、write request の発火は行わない。
5. **replay gate**: method/path/schema が read-only と確認でき、既存 session で再現可能な場合だけ、
   1 件の idempotent read を隔離環境で試す。login/refresh と read/write scope が分離できない場合は
   B とせず browser/device automation または manual capture に戻す。

## 10. read/write 隔離

最小 allowlist:

- 既存 session の確認と通常 login（reset、登録、設定変更を除外）
- e-NAVI のカード表示切替、確定/未確定明細一覧・詳細、既存 PDF/CSV download
- PointClub の通常/期間限定/予定ポイント、期限 bucket、過去履歴の表示
- Pay の既存 Point/Cash 残高表示、PointClub の Cash 履歴表示

denylist:

- カード支払、あとからリボ/分割、支払額/口座/限度額変更、キャッシング
- 楽天ペイのコード表示/支払、Cash チャージ、送付/受取、出金、Suica/Edy 操作
- ポイント利用、交換、運用、利息/増加 mode、campaign/くじ/mission entry
- カード/家族/ETC 申込、紛失停止、再発行、3D Secure/WEB明細/通知/認証設定変更
- ID/password/passkey/第2 password/連絡先の登録、reset、変更

同一 session/credential が read と write の両方を許す前提で、HTTP method だけで分離しない。
origin+method+path+request-schema の allowlist、egress proxy、read-only UI selector allowlist、download
content-type/size 上限を併用する。`POST` が query/read に使われる場合も、静的/動的観測で read と
確認できるまで許可しない。遷移先や button に「支払う」「変更」「申込」「チャージ」「送る」
「受け取る」「出金」「交換」「運用」「エントリー」が現れたら action せず停止する。

## 11. Workers / Browser Run / Containers / OCI / Kubernetes 適性

| Runtime | 適性 | 理由 |
| --- | --- | --- |
| Cloudflare Workers | export 受領/parser には高い。直接 login は低い | [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) で download/parser orchestration は可能。Akamai、interactive MFA、browser profile、APK/toolchain には不向き |
| Cloudflare Browser Run | e-NAVI/PointClub web の C/D 実験候補 | [Browser Run](https://developers.cloudflare.com/browser-run/) は browser session と CDP を扱える。金融 session/PII の cloud 搬出、Akamai acceptance、human OTP、write 混在を別途解決する必要がある |
| Cloudflare Containers | headless browser/解析 worker 候補 | [Containers](https://developers.cloudflare.com/containers/) は full filesystem/任意 runtime/OCI image を実行できる。Paid、secret 配送、persistent profile、egress/reputation、監査が必要 |
| 一般 OCI container | CSV/PDF/HTML parser と web replay に適する | Playwright、sanitizer、PDF parser、secret scanner を version 固定できる。正規 Android app/device identity は通常 container だけでは再現できない |
| Kubernetes | 多 source 運用には適するが楽天単体の初期 capture には過大 | CronJob、NetworkPolicy、read-only FS、Secret CSI、監査、source 別 job を使えるが、MFA/Akamai/device binding は解決しない |
| ユーザー管理 PC/Android | 初回 live/静的・動的観測に最適 | 正規 browser/app、human MFA、Play provenance を保ち、秘密の外部搬出を避けやすい。完全無人化にはならない |

推奨初期構成は、PC からカード月次 CSV/PDF を手動 export し、ユーザー端末上の監査済み
PointClub exporter で 1 年履歴を保存し、parser/sanitizer だけを Worker/OCI に置く。transport と
session reuse、read/write 分離が実証されてから Browser Run/Container replay を追加する。Pay app は
write proximity が最も高いため、現在残高の spot check を超える自動化を最後に評価する。

## 12. 自動化レベル A-E と実装コスト

PR #5 の共通定義のみを使う。

- **A**: documented/export API を scheduled headless で使用
- **B**: 安定した read-only internal API と更新/再利用可能 session
- **C**: browser/app bootstrap 後の headless replay が有望
- **D**: full browser/device automation が必要
- **E**: manual capture が安全な既定

| 経路 | Level | Cost (1-5) | 判定 |
| --- | --- | ---: | --- |
| e-NAVI PC 月次 CSV/PDF を手動取得 | E | 1 | 公式で最も安全。15 か月 rolling archive、CSV 欠落を PDF で補う |
| PointClub web 履歴を人手/監査済み local bookmarklet で保存 | E | 1-2 | 公式 export は未確認。1 年、pagination、Cash 状態の live 確認が必要 |
| e-NAVI/PointClub full browser automation | D | 4 | 共通 ID、MFA、Akamai、複数カード、write 導線、session 未確認 |
| 観測済み web read endpoint の bootstrap + replay | C 候補 | 4 | PointClub は OIDC + HTML pagination の公開実装があるが、session 更新/read scope/e-NAVI は未実証 |
| 公式 app transport replay/UI automation | D | 5 | Play artifact、device binding、integrity/pinning、write proximity、token scope が未確認 |
| Cash 現在残高の手動 spot check | E | 1 | Pay app の read 画面だけ。履歴は PointClub を使う |

**総合評価: E（C 候補）、cost 1-2（replay 研究は 4、app/device は 5）。** カードは公式月次
export があるが scheduled API ではないため A ではない。Point/Cash は公式 public export/API を確認
できず、現時点の安全な family 全体既定は manual capture である。PointClub の同一 origin HTML
pagination と OIDC は C 候補を支えるが、安定した renewable read-only session を実証していないため
B にしない。

## 13. read-only live 検証計画

### Phase 0: source inventory（番号・実値なし）

1. e-NAVI に表示されるカード数、券種、本会員/家族、ETC の包含関係だけを記録する。
2. 家族会員側 account の存在を数えるが、楽天 ID、氏名、card suffix は記録しない。
3. PointClub の通常/期間限定/獲得予定/Cash 表示の有無、Pay の基本型/プレミアム型表示だけを確認する。

### Phase 1: 公式 export/UI の 1 回確認

1. ユーザー管理 PC browser で通常 login し、challenge は人が処理する。秘密/OTP を automation に渡さない。
2. e-NAVI で表示月数、1 page 行数、pagination、利用者、ETC、通知/pending/posted、取消/返金、
   分割/リボ、外貨の**項目名と状態**だけを確認する。実値は記録しない。
3. test 用に実値を含まない synthetic row を別途作り、CSV header/encoding、1 明細 2 行化、PDF text layer、
   月次 download 単位、ファイル命名だけを記録する。実ファイルは暗号化隔離し commit しない。
4. PointClub で過去 1 年の filter、pagination、1 page 件数、通常/期間限定、expiry bucket、獲得予定、
   Cash の全 state class を確認する。公式 download button の有無も確認する。
5. Pay app は Point/Cash 残高表示と基本/プレミアム区分だけを開き、支払/チャージ/送付/出金に触れない。

### Phase 2: transport/RE（Phase 1 の不足がある場合）

1. 公開 web HTML/JS、asset manifest/source map、form action、CSP、OIDC redirect の host/path/schema 名を
   収集する。非公開 resource や source map の access control は回避しない。
2. 認証済み read 操作の DevTools 観測で、card list、statement month/list/detail/download、PointClub
   history/balance/expiry、Cash balance/history の method/path/schema を redacted field-name map にする。
3. 正規 Play split APK を上記手順で取得/署名確認し、3 package を別々に解析する。共通楽天 ID auth と
   card/point/cash ledger host を混同しない。
4. 既存 session の read replay を 1 回だけ試し、401/403/429、login redirect、OTP、device/integrity
   challenge、unexpected write method/path が出たら停止する。自動 login retry はしない。
5. 2 回の独立取得で schema、pagination、重複排除、session renewal が安定し、write denylist が egress
   で強制できた場合だけ C/B 再評価を行う。

## 14. stop 条件

次のいずれかで当該 run を即時停止し、cookie jar/session/artifact を破棄または暗号化隔離する。

- CAPTCHA、Akamai/access denied、401/403/429、login loop、account lock 警告
- password/passkey/OTP の reset/登録/変更、電話発信の再登録、追加本人確認が必要
- 支払、リボ/分割、チャージ、送付/受取、出金、交換/運用、申込/entry/設定変更の confirmation 画面
- `POST/PUT/PATCH/DELETE` または未知 path/schema を、read-only と確認できないまま発火しそうになる
- Cookie/token/OTP/passkey/PII/実値が log/HAR/screenshot/trace に残った、または redaction を検証できない
- app が user CA/debugger を拒否し、pinning/integrity/attestation bypass が必要になる
- APK signer/package/version/provenance が一致しない、第三者 APK しか入手できない
- pagination が循環する、同一月/同一利用者の二重計上を解消できない、公式表示と件数が一致しない
- 利用規約/robots/公式案内の変更、または source owner から automation 停止の指示がある

停止後は credentialed retry、fingerprint/cookie 合成、防御回避を行わず、manual export/spot check に戻す。

## 15. 確認済み結論、推測、未確認

### 確認済み

- カード確定明細は e-NAVI で過去 15 か月、PC CSV/PDF が公式 route。CSV は月次、確定分のみで、
  2 行化/merchant truncation/リボ内訳欠落がある。
- 本会員明細は家族/ETC を含み、家族会員側は自分の利用だけを見る。単純結合は二重計上になる。
- PointClub は通常/期間限定/獲得予定/期限と Point/Cash 履歴を扱い、公開説明上の履歴は 1 年。
- Pay app は Cash 現在残高を表示する一方、支払/チャージ/送付/出金 write が同居する。
- PointClub 履歴は楽天 ID の OIDC authorization code endpoint へ redirect する。公開 discovery は
  identity scopes を示すが、financial read scope/API は示さない。
- 楽天カード公開 root で Akamai header と 403 を観測した。3 公式 Android package/version を Play で
  確認したが、APK artifact/署名/transport は未取得。
- 公開 PointClub bookmarklet は同一 origin HTML pagination を `fetch` する。公式 API ではない。

### 推測/設計判断

- 初期 production はカード月次 CSV/PDF + PointClub local capture + Pay 残高 spot check が最も安全。
- PointClub は browser bootstrap 後 HTML replay の C 候補だが、session renewal と Cash row 網羅性を
  live で確認する必要がある。
- e-NAVI/app が internal JSON API を持つ可能性はあるが、公開資料/今回 artifact からは断定できない。

### 未確認

- e-NAVI/PointClub の passkey 対応、Bitwarden 固有互換性、MFA 発生条件、session/refresh/device binding
- e-NAVI の pagination/最大件数、CSV 完全 schema/encoding、返金/原取引 link、外貨列、pending export
- PointClub/Cash の公式 export button、最大件数/page size、全 Cash DOM/API state と expiry bucket schema
- 3 app の signer、split 構成、host/path/schema、token/session renewal、integrity/pinning、web/app 差
- Akamai が e-NAVI login/authenticated API で行う判定、Worker/Browser Run/Container の受入可否
