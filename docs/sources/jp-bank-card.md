# JP BANK Card WEB source research

調査日: 2026-08-26（Australia/Sydney）

## 結論

- 本資料の対象は **JP BANK VISA / Mastercard の JP BANK Card WEB** である。JP BANK JCB / EXTAGE は MyJCB に遷移する別 source family であり、混在させない。
- JP BANK Card WEB はカード台帳であり、ゆうちょ銀行口座の残高・入出金明細ではない。カード側の加盟店別明細と、口座側の月次引落 1 行を別 observation として保持し、後段で照合する。
- 公式 Web では次回支払額、利用可能額、最新から過去 15 か月分の利用明細、確定 WEB 明細、ポイント残高等を照会できる。公式ページは明細データ download と印刷を案内し、過去の sanitized read-only 観測では CSV control を確認した。native PDF は未確認で、browser print-to-PDF は銀行発行 PDF ではない。
- 公式の login は ID/password。旧 `One Time Pass` app はネットショッピング認証用で、通常 login MFA の証拠ではない。passkey/WebAuthn、Bitwarden 対応、端末 binding、risk-based 追加認証は未確認である。
- login host は Akamai 配下で、今回の非 browser HEAD は 403 になった。現時点の共通評価は **D / cost 4**、安全な初期経路は **手動 CSV: E / cost 1**。read-only transport と reusable session を実測できた場合だけ **C / cost 4 candidate** に進める。
- reverse engineering を一律に除外しない。公式資料で不足する項目は、公開 HTML/JS 静的解析、認証済み browser の redacted network 観測、必要なら公式 APK の静的/動的解析で確認する。禁止するのは取引/write、秘密・PII 保存、security control bypass である。

## 調査上の安全境界

公開公式ページ・規約を主資料とし、未認証 HTTP/DNS、GitHub code search、公開 third-party source を read-only で確認した。この調査回では login していない。

口座番号、カード/会員番号、カード suffix、氏名、メール、ID/password、cookie、OTP、token、残高、利用額、加盟店、取引明細等の秘密・PII・実値を取得または記録していない。production collector でもログ、screenshot、HAR、DOM dump、fixture、CI artifact、Git に残さない。

collector が許可するのは、既存 session の確認、カード種別の一般化された列挙、現在/確定明細、利用可能額、read-only balance、ポイント残高/期限/履歴、既存明細 download/print、logout に限る。登録、申込、支払、変更、交換、解除、制限設定等は行わない。

記述の確度は次のとおり。

- **確認済み:** 公式資料に明記、または未認証 endpoint で直接観測。
- **観測済み:** 過去の sanitized read-only browser 観測。公開仕様ではないため再確認対象。
- **推測:** adjacent platform 等と整合するが、JP BANK Card WEB 自体では未実証。
- **未確認:** bounded read-only live 検証が必要。

## 1. source family とカード列挙

### 対象・対象外

[JP BANK Card WEB の公式説明](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb.html) は VISA/Mastercard 会員向けと明記する。[ゆうちょ銀行のカード top](https://www.jp-bank.japanpost.jp/kojin/card/credit/kj_crd_cdt_top_index.html) も、VISA/Mastercard を JP BANK Card WEB、JCB を MyJCB に分けている。

| source | 対象 | 本資料での扱い |
| --- | --- | --- |
| JP BANK Card WEB | JP BANK VISA / Mastercard | 対象 |
| MyJCB | JP BANK JCB / EXTAGE 等 | 別 source、対象外 |
| ゆうちょダイレクト / ゆうちょ通帳 app | 預金口座残高・入出金 | 別 source、引落照合だけ |

### 本会員 root

[カード比較表](https://www.jp-bank.japanpost.jp/kojin/card/credit/lineup/kj_crd_cdt_lu_popup.html) と [一般カード](https://www.jp-bank.japanpost.jp/kojin/card/credit/lineup/ippan/kj_crd_cdt_lu_ipn_index.html) から、少なくとも次を列挙できる。

| product family | brand | 形態 | 状態 |
| --- | --- | --- | --- |
| JP BANK VISA ALente | Visa | product 条件に応じキャッシュカード一体型/単体型 | 確認済み |
| JP BANK VISA/Mastercard 一般 | Visa/Mastercard | 一体型/単体型 | 確認済み |
| JP BANK VISA/Mastercard ゴールド | Visa/Mastercard | product 固有の一体型/単体型 | 確認済み |

raw card 名、番号、suffix、名義を保存せず、内部で生成した opaque `card_root_id` と一般化した `product_family` / `brand` だけを保持する。

### 家族・ETC・追加カード

- 一般カードの公式ページは、一体型本会員に一体型家族カード 1 枚、単体型本会員に複数の単体型家族カードを発行可能としている。
- [追加カード・サービス](https://www.jp-bank.japanpost.jp/kojin/card/credit/futai/kj_crd_cdt_fti_index.html) と [VISA/Mastercard サービス](https://www.jp-bank.japanpost.jp/kojin/card/credit/lineup/vmservice/kj_crd_cdt_lu_vsv_index.html) は、家族、ETC、iD、PiTaPa、WAON、Plus EX 等を列挙する。本 source では、これらの利用が card ledger に現れる場合だけ対象にする。
- [WEB 明細申込案内](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/wm_mail_top.html) は本会員を申込対象とする。一方、[JP BANK Card WEB 特約](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb05.html) は家族会員にも制限付き利用を認める。
- 本会員明細/CSV が家族・ETC を専用列、カード名、masked number、名義のどれで区別するかは未確認。

data model は `instrument_kind = primary | family | etc | other_addon | unknown` とし、安定した非 PII discriminator がない場合は root 配下の `unknown` のままにする。表示名や suffix から永続 ID を作らない。

## 2. 残高・明細・確定/未確定・粒度

### 公式に確認できる対象

[利用可能サービス](https://wwws.jp-bank.japanpost.jp/credit2/service/cardweb01.html) は次を明記する。

- 次回支払額。
- 最新から過去 15 か月分の利用明細。
- 現在の利用可能額。
- カード利用代金 WEB 明細。
- JP バンクカードポイント残高と交換受付。
- リボ/分割内容の照会・変更、臨時支払、キャッシング。

最後の項目群は read と write が隣接する。残高/予定額の照会だけを allowlist にし、変更・支払・申込 control は触らない。

### 明細行の粒度

[明細の見方](https://wwws.jp-bank.japanpost.jp/credit2/member/meisai_guide.html) は次の line-level 情報を説明する。

- 利用日、利用店名、利用金額。
- 支払区分、分割回数、今回回数。
- 分割・リボ・キャッシング等の支払予定額。
- `#`（あとからリボ対象）、`B`（あとから分割対象）等の表示。
- ポイント対象表示。
- 海外利用時の換算関連情報。

利用日は、前回案内後に売上票/data が到着した利用の表示日であり、現実の authorization timestamp と同一とは限らない。`use_date` として source semantics を保持し、別 timestamp を創作しない。

推奨 schema は `source_cycle`, `source_status`, `use_date`, `merchant_raw`, `amount`, `currency`, `payment_category`, `installment_count`, `scheduled_payment`, `point_eligible`, `instrument_kind`, `source_row_hash`。加盟店・金額は private encrypted store のみで扱い、test fixture は synthetic にする。

### 現在・確定・取消/返金

- [WEB 明細 flow](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_flow.html) と [通知時期](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_mail.html) は、支払額確定後に 1 請求 1 回の通知を送り、紙相当の WEB 明細を確認できるとする。次回請求がなければ通知しない。
- [FAQ](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_faq.html) は、あとからリボ等により翌月初めに当該明細が更新され得るとする。download 済み明細も無条件に immutable としない。
- 認証済み画面に現在明細と確定 WEB 明細が分かれていることは観測済みだが、現行仕様を再確認する。
- authorization 未確定行の有無、pending/posted label、売上到着後の key、加盟店名変更、取消、返金、negative/correction 行、元取引との link は未確認。

現在 cycle は provisional として保守的に upsert し、確定 cycle snapshot を billed record の基準とする。符号や加盟店名だけで refund と決めない。

## 3. 期間・件数・CSV/PDF/export

| 項目 | 調査結果 | 確度 |
| --- | --- | --- |
| 履歴期間 | 最新から過去 15 か月 | 公式確認済み |
| 区切り | 請求/月単位 | 公式確認済み |
| 画面 1 回の件数、pagination | 公開記載なし | 未確認 |
| 明細 data download | あり | 公式確認済み |
| CSV | 過去の sanitized login 済み観測で control を確認 | 観測済み、再確認要 |
| CSV encoding/schema | 公開記載なし | 未確認 |
| native PDF download | 根拠を確認できず | 未確認 |
| 印刷/browser PDF | 印刷は公式、PDF は browser rendering | 印刷確認済み |
| OFX/QIF | 公式経路を確認できず | 根拠なし |

[WEB 明細案内](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_about.html) は page 印刷と明細 data download を案内する。[特約](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb05.html) は download data の形式等を銀行が指定するとするが、公開案内では形式を明記していない。したがって CSV は強い実装候補だが documented API contract ではない。browser print-to-PDF は `rendered copy` と表示し、銀行発行 PDF と呼ばない。

live 検証では、filename pattern、MIME、encoding、header、quote、改行、日付/金額 format、empty month、最大行数、pagination だけを記録する。raw export は private inbox で hash 後に parse し、retention policy に従い暗号化または削除する。Git へ入れない。

## 4. ポイント

[ポイント規則](https://wwws.jp-bank.japanpost.jp/credit2/service/point/point.html) と [ポイント画面](https://wwws.jp-bank.japanpost.jp/credit2/service/point/index.html) から次を確認できる。

- 一般/ALente は shopping 1,000 円ごとに 1 point、ゴールドは 2 point。
- 獲得月から 2 年で失効。
- 現在残高、有効期限、JP BANK Card WEB で受け付けた交換履歴を照会可能。
- 明細書にも point 情報がある。

point 交換、cashback、他社 point 移行は write であり禁止。家族/ETC 利用分を member 別に配分できるかは未確認なので、当初は card root level の observation とする。

## 5. 認証・MFA・端末・passkey・Bitwarden

### 確認済み

- [login 方法](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb02.html) は登録済み ID/password を使う。
- [利用環境](https://wwws.jp-bank.japanpost.jp/credit1/kankyo.html) は JavaScript と cookie を利用し、Windows の current Edge/Firefox/Chrome、macOS の current Safari を推奨する。
- 新規登録、再登録、password recovery/change は card/contact 情報を伴う write flow であり、collector は行わない。
- 家族会員の利用機能には制限がある。
- [旧 One Time Pass app](https://wwws.jp-bank.japanpost.jp/credit2/update/otp.html) は 60 秒 OTP を表示するネットショッピング認証用 app で、2024 年 4 月以降順次利用不可、現在はメール通知 OTP に移行すると案内する。
- [OTP 特約](https://wwws.jp-bank.japanpost.jp/credit2/update/otp_kiyaku.html) は shopping OTP と JP BANK Card WEB login password を明確に分離する。したがって 3-D Secure OTP を read-only login MFA とみなさない。

### 事実と推測の分離

- **login MFA/device binding:** risk-based email/SMS、追加確認、remembered-device cookie、同時 session 制約、session rotation の有無は未確認。
- **passkey:** 公式資料で WebAuthn/passkey を確認できなかった。将来も非対応とは断定しない。Apple Pay の Face ID/Touch ID は決済認証で、WEB login passkey ではない。
- **Bitwarden:** 公式な関係はない。通常の ID/password form なら autofill 可能と推測できるが未検証。WebAuthn が確認できるまで Bitwarden passkey 保管を前提にしない。
- **app 生体認証:** current statement app を確認していないため、WEB login との関係もない。

credential は利用者が既に作成した secret record を参照し、値を log しない。session state は暗号化し、可能なら host-bound、source 単位で消去可能にする。予期しない OTP、recovery、端末登録は user handoff/stop であり、メール自動取得や認証弱体化の許可ではない。

## 6. Web/app と次段階の静的・動的解析

JP BANK Card WEB は browser で利用でき、app-only ではない。明細取得用の現行 first-party app は公式 route から確認できなかった。旧 One Time Pass app は 3-D Secure 用、legacy JP BANK Card iD app は決済設定用であり、カード明細 collector ではない。

公開資料で不足する場合は次の順序で具体化する。

1. **公開 HTML/JS 静的解析:** loaded page の script URL/hash、module 名、form action、download link、route shape を記録する。page が露出していない write endpoint の探索は行わない。
2. **認証済み browser の動的観測:** 既存 session の DevTools で、card list、月選択、明細照会、point read、CSV download の method、origin、path template、status、content-type、redirect、redacted response shape だけを記録する。body、cookie、token、ID、氏名、残高、加盟店、raw response は保存しない。
3. **read-only replay 判定:** idempotent と分類できた 1 request だけを同一 browser session で試す。CSRF state が write と共用、semantics 不明、challenge 発生、state 変更の可能性があれば停止する。
4. **現行公式 app が見つかった場合の APK:** 公式 store または owner 提供 package から入手し、package/version/signing certificate hash/APK hash を記録する。`aapt`、`apkanalyzer`、`jadx`、MobSF 等で manifest、network security config、hostname、transport library、response model を静的解析し、owner-controlled 実機で read-only call を動的観測する。certificate pinning/device attestation は記録対象であり、bypass しない。

reverse engineering、APK/JS 解析、通信観測自体は非目標でも禁止でもない。security control の改変・回避、CAPTCHA 解決、stealth/fingerprint 偽装、rate-limit 回避、write call、秘密/PII 保存は禁止する。

## 7. CDN/WAF/Akamai/anti-bot

2026-08-26 の read-only 観測では、`https://www.jp-bank-card.jp/` の HEAD は `403 Forbidden`、`Server: AkamaiGHost`、`AKAMAI` edge header を返し、DNS は `dsca.akamaiedge.net` に解決した。公開資料 host は 200 を返したが、DNS は同様に Akamai edge である。

以上から Akamai fronting と、この環境の非 browser request 拒否は確認できる。ただし 1 回の 403 から Bot Manager、WAF rule、device fingerprint、rate policy、API gateway 製品の有効化を断定しない。独立した API gateway host は未確認。

403/429、challenge/interstitial、CAPTCHA、redirect loop、追加 login 検証、device enrollment で停止する。UA 偽装、Akamai cookie 合成、challenge solve、IP rotation 等の bypass は行わない。次の正当な手段は、利用者 handoff を伴う公式推奨 browser である。

## 8. public third-party client と具体的 transport/auth

GitHub code search では JP BANK Card host を対象にした公開 client を確認できなかった。次の 2 件は adjacent な SMBC/Vpass platform 用であり、JP BANK Card の直接証拠ではない。

### `braineo/smbcCardSpider`

[GPL-2.0 repository](https://github.com/braineo/smbcCardSpider) は 2016 年に最終 push された旧実装で、`requests.Session`、ID/password、JSON POST を使用する。[source](https://github.com/braineo/smbcCardSpider/blob/bb3c4798a96c55934ed2a9a58d6cea25f59acb98/SMBC_card.py) には次の SMBC host endpoint がある。

- `/memapi/jaxrs/xt_login/agree/v1`: login。
- `/memapi/jaxrs/web_meisai/web_meisai_top/v1`: 明細。
- `/memapi/jaxrs/multicard/dropdownlist_init/v1`: card list。
- `/memapi/jaxrs/multicard/operation_card_update/v1`: selected card 切替。

payload envelope は request timestamp/hash を含み、cookie session を維持する。古い SMBC code であり、JP BANK Card origin に同じ path があるとは限らない。

### `4noha/openmoney` Vpass plugin

[repository](https://github.com/4noha/openmoney) は 2026 年の public code だが license 表示がない。[Vpass plugin](https://github.com/4noha/openmoney/blob/21f33ca84bc114c2cfd0e3eacbdfacebc7838abd/plugins/vpass/scraper.py) は Playwright で SMBC host の `/memx/web_meisai/top/index.html` を開き、月を選び、`CSV形式で保存する` control を download し、Shift-JIS CSV を parse、失敗時は HTML table に fallback する。Akamai `_abck` cookie 待機と人手 OTP も実装する。

screenshot、raw env credential、automation detection 変更、SMBC selector は本 collector に流用しない。Shift-JIS、13 か月、route/selector も JP BANK Card の仕様とはみなさない。

### 評価

adjacent Vpass 実装と認証済み JP BANK Card 画面で `/memx/web_meisai/top/index.html` route family が整合するため、関連 backend は推測できる。しかし `/memapi/jaxrs` transport、session 再利用、card switch を JP BANK Card の確認済み事実に昇格するには、JP BANK Card origin の redacted read-only network 観測が必要である。

## 9. read/write 隔離

blocklist ではなく route/action allowlist を使う。初期 allowlist は次のみ。

- session status、一般化した card/root list。
- 現在/確定明細、idempotent と確認済みの月選択。
- 既知の明細 data download/print。
- 利用可能額、read-only balance/schedule。
- point 残高・期限・交換履歴の照会。
- logout。

次は明示的に deny する。

- JP BANK Card WEB / WEB 明細の登録・解除。
- ID/password/email/address/引落口座等の変更。
- あとからリボ/分割、臨時・早期支払、支払 plan 変更。
- cash advance。
- point 交換/cashback/移行。
- limit 増額、利用制限設定。
- 家族/ETC/iD/PiTaPa/WAON/Plus EX 等の申込。
- 3-D Secure 決済、Apple Pay 等の provisioning、campaign entry、購入・支払。

read に POST を使う可能性はあるため HTTP method だけで write と決めない。ただし semantics 不明の POST は deny し、同じ endpoint が read/write action を受ける場合は正確な read request を分類・guard できるまで自動化しない。

## 10. Workers / Browser Run / Containers / OCI / Kubernetes

| runtime | 適性 | 判断 |
| --- | --- | --- |
| Cloudflare Workers `fetch` のみ | 低い | 非 browser request が Akamai 403。通常 browser/bootstrap を提供できない |
| Cloudflare Browser Run | 検証候補 | Puppeteer/Playwright/CDP session 再利用は可能だが、cloud egress と Akamai acceptance は未証明 |
| Cloudflare Containers | 技術的には可能 | `linux/amd64` full browser/parser は動くが、login handoff、egress identity、WAF は解決しない |
| controlled host の OCI image | packaging に適する | browser/parser を再現可能にする。session は host-bound encrypted store が必要 |
| Kubernetes | 可能だが過剰 | scheduled Pod は可能でも secret/egress/storage/concurrency の運用面が増える |
| local 公式推奨 browser | 初回実験に最適 | visible handoff、local credential、CSV download が可能で、公式環境に最も近い |

[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/features/reuse-sessions/) は reconnectable session を、[session management](https://developers.cloudflare.com/browser-run/cdp/session-management/) は keep-alive を案内する。[Cloudflare Containers](https://developers.cloudflare.com/containers/platform-details/architecture/) は isolated VM と `linux/amd64` image を案内する。[OCI Image Specification](https://specs.opencontainers.org/image-spec/) と [Kubernetes Images](https://kubernetes.io/docs/concepts/containers/images/) は portable image/container 実行の根拠である。runtime capability は origin が自動化を許容する根拠ではない。

## 11. 共通 A–E / cost 評価

PR #5 の共通定義を変更せず使用する。

- **A:** direct documented/export API suitable for scheduled headless use。
- **B:** stable read-only internal API with renewable/reusable session。
- **C:** browser/app bootstrap + headless replay plausible。
- **D:** full browser/device automation probably required。
- **E:** manual capture remains safe default。
- cost は 1（small wrapper）から 5（device-bound/adversarial）。

| 経路 | level | cost | 判断 |
| --- | --- | ---: | --- |
| 確定明細 data/CSV の手動 download → local import | E | 1 | 現時点の推奨。CSV format は再確認 |
| 手動 browser print-to-PDF → import | E | 2 | 非構造で native bank PDF ではない fallback |
| visible local browser login + controlled CSV download | D | 3 | human handoff、selector、session challenge、subcard/schema 検証が必要 |
| browser bootstrap 後の read-only replay | C candidate | 4 | adjacent transport はあるが JP BANK Card endpoint/session は未確認 |
| cloud/container から unattended login | D | 5 | full browser と Akamai 対応が必要で brittle |

**現時点の source 評価は D / cost 4。** unattended collector には full browser が必要と考えられる。安定した read-only transport と renewable/reusable session を redacted live 観測で確認できた場合に限り **C / cost 4 candidate** へ更新する。A/B の根拠はない。production-first MVP は **manual CSV: E / cost 1** とする。

## 12. read-only live 検証項目

既に登録済みの利用者 account と local 公式推奨 browser を使い、1 回の bounded run を行う。登録・変更はしない。

1. 公式 URL、issuer/brand boundary、JCB が同 session に混ざらないことを確認。
2. existing session と fresh login の挙動を確認し、ID/password/cookie/form body を保存しない。
3. login MFA/risk confirmation、remembered device、session lifetime/reuse を redacted metadata だけで確認。新 OTP receipt は自動化しない。
4. root product と `primary/family/etc/other` の一般化だけを列挙し、表示名・suffix は記録しない。
5. current/unfinalized と finalized cycle の field/status transition を確認。
6. use date、merchant、amount、payment category、installment、refund/correction、family/ETC hint、authorization pending layer の有無を確認。実値は保存しない。
7. month selector、empty/oldest month、件数、pagination、15 か月境界を確認。
8. 既存明細を 1 回 download し、filename/MIME/encoding/header/quote/date/amount format/limit/hash だけを記録。schema 確認後に test file を削除。
9. native PDF control の有無を確認。なければ browser PDF を rendered output とする。
10. point 残高/期限/履歴の schema だけを確認し、交換 flow を開かない。
11. DevTools redaction 下で card list、月選択、明細表示、download の method/path template/status/content-type/shape だけを分類。
12. logout 後、設定、申込、支払方法、point、利用制限が変更されていないことを確認。

### stop 条件

- 購入、支払、cash advance、申込、交換、登録、解除、設定変更の confirmation。
- read/write semantics が不明な control/endpoint。
- 予期しない OTP、security question、device enrollment、passkey 作成、password reset/recovery。
- 403/429、CAPTCHA、Akamai challenge、redirect loop、security control 弱体化/回避が必要な状態。
- secret、full identifier、PII、残高、加盟店、実明細が capture/log に入りそうな状態。
- replay が read/write 境界を越える、または pinning/attestation bypass が必要な状態。
- harmless な login/download 失敗が 1 回を超える状態。

停止時は redacted error class、route template、timestamp、status code だけを残し、**manual E / cost 1** に戻る。

## 未確認事項

- login MFA/risk/device binding、session lifetime/renewal/concurrency。
- JP BANK Card 固有 transport と reusable read-only session。
- CSV encoding/schema、row/page limit、subcard discriminator。
- pending/posted/refund/reversal/installment の正確な表現と immutable key。
- native PDF download。
- 1 login で複数 VISA/Mastercard root を切替可能か。
- point 履歴の粒度と家族/ETC 帰属。
- intended runtime の通常 browser automation を Akamai が challenge なしで許容するか。

## 主要一次資料

- [JP BANK Card WEB overview](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb.html)
- [JP BANK Card WEB 利用可能サービス](https://wwws.jp-bank.japanpost.jp/credit2/service/cardweb01.html)
- [JP BANK Card WEB login](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb02.html)
- [JP BANK Card WEB 特約](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb05.html)
- [カード利用代金 WEB 明細](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_about.html)
- [WEB 明細 FAQ](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_faq.html)
- [利用代金明細の見方](https://wwws.jp-bank.japanpost.jp/credit2/member/meisai_guide.html)
- [サイト利用環境](https://wwws.jp-bank.japanpost.jp/credit1/kankyo.html)
- [JP バンクカードポイント](https://wwws.jp-bank.japanpost.jp/credit2/service/point/point.html)
- [One Time Pass app 移行案内](https://wwws.jp-bank.japanpost.jp/credit2/update/otp.html)
