# MUFG card family / My Digital Connect source research

調査日: 2026-08-26（公開情報）、live 検証は未実施

## 1. 対象範囲と禁止事項

この記録の単位は、三菱UFJニコスが発行・運営し、カード券面または公式案内で
`My Digital Connect`（以下 MDC）を利用すると確認できるカード群である。銀行口座の
「三菱UFJダイレクト」、JCB 発行カードの MyJCB、NICOS ブランドの Net Branch は別の
認証・データソースとして扱う。

インベントリからは次を候補とする。ただし、インベントリで商品未確認のものを、公開情報
だけでユーザー保有カードと確定してはならない。

| インベントリ上の候補     | 請求・利用明細の正本候補 | 特典残高の正本候補                      | live 確認事項                                                   |
| ------------------------ | ------------------------ | --------------------------------------- | --------------------------------------------------------------- |
| 三菱UFJカード            | MDC                      | MDC のグローバルポイント                | 券面ブランド、MDC マーク、カードごとのログイン ID               |
| JALカード（MUFG発行）    | MDC                      | JMB（マイルはカード明細に表示されない） | Visa / Mastercard / TOKYU POINT ClubQ 等、発行会社と MDC マーク |
| J-WESTカード（MUFG発行） | MDC                      | WESTER                                  | Visa / Mastercard であること。JCB は MyJCB なので本記録の対象外 |

JAL と J-WEST は請求と特典の正本が異なる。MDC の請求データを JMB マイルや WESTER
ポイントの完全な代替にしない。

許可するのは、既存の表示・既存の確定/未確定明細・ポイント照会・既存 PDF/CSV の取得と、
ユーザー管理端末/アカウントに対する read-only な観測である。支払方法変更、あとdeリボ/
分割、繰上返済、キャッシング/カードローン、限度額変更、ポイント交換、カード/追加カード
申込、登録情報変更、WEB 明細や 3D セキュアの登録・解除等は行わない。口座・カード・会員
番号、氏名、生年月、電話番号、メールアドレス、Cookie、トークン、実残高・実請求額を取得物、
ログ、HAR、スクリーンショット、コミットに残さない。security control の回避は行わない。

## 2. 方法と証拠の強さ

- 三菱UFJニコス、JALカード、JR西日本の公式ページ/FAQ、公式アプリストア記載を優先した。
- 2025-12 の旧サービス統合ページを用いて、旧 DC/MUFG カード WEB サービスと MDC の違いを
  確認した。
- 公開 GitHub コード検索で、現行ホスト名、アプリ package、サービス名を検索した。
- 2026-08-26 にログアウト状態の公開 URL へ HEAD リクエストを行い、CDN/WAF の応答ヘッダー
  だけを観測した。ログイン、チャレンジ誘発、負荷試験はしていない。
- 認証済み画面、CSV/PDF の実ファイル、アプリ通信、APK は未取得である。したがって画面項目の
  説明は公式ガイドまで、transport は次段階の検証計画までとし、推測を確認事実と分ける。

## 3. 公式 surface とカード識別

### 3.1 My Digital Connect と旧サービス

確認事実:

- [MDC 利用対象 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=383) は、MDC マークのある旧
  MUFG カード/旧 DC カード（提携カードを含む）を対象とする。会社決済型法人カードや一部
  ETC 専用カード等は対象外である。
- [DC Web サービス統合案内](https://www.integration.cr.mufg.jp/dccardfc/webservice/) によると、
  旧 DC Web サービスは 2025-12-09 に MDC へ統合された。旧サービスは本会員中心の顧客単位、
  MDC は本会員・家族会員を含むカード単位の ID である。
- [旧 MUFG カード WEB サービス統合案内](https://www.integration.cr.mufg.jp/mubank/webservice/)
  により、三菱UFJ銀行のキャッシュカード一体型カードも MDC へ移行し、旧 MUFG
  ダイレクトからの SSO は終了した。銀行ログインと MDC ログインを混同しない。
- [サービス選択案内](https://www.cr.mufg.jp/member/support/webs/change/index.html) は、MDC
  マーク付き旧 MUFG/DC カードを MDC、NICOS ブランドを別の Net Branch に案内する。
- [カードごとの ID FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=396) は、MDC ID に複数カードを
  まとめられず、カードごとに ID が必要とする。カード切替/再発行では原則 ID を引き継ぐが、
  一部商品は再登録が必要である
  （[カード追加](https://faq.cr.mufg.jp/mufgcard/detail?id=221)、
  [切替・再発行](https://faq.cr.mufg.jp/mufgcard/detail?id=2421)）。
- [家族カード FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=395) は家族会員自身の MDC 登録を
  認める一方、登録時に本会員の登録電話番号を使う。公式アプリは原則として個人本会員向けで、
  家族/法人/一部カードを対象外とする
  （[アプリ利用対象 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=3859)）。

したがって「アカウント内カード一覧を 1 回取得する」設計を前提にしない。安全なインベントリは、
利用者が確認したカード表示名、発行会社、国際ブランド、MDC マークの有無、本会員/家族会員、
請求の包含関係を、番号を記録せずカードごとに管理する。本会員の明細には家族/ETC/追加カード
利用が合算される場合があるため、明細の「利用者」欄が得られる場合だけ attribution に使い、
別明細と二重計上しない。

### 3.2 提携ブランド差

- [J-WEST 明細案内](https://wester.jr-odekake.net/j-west/support/meisai/) は、J-WEST の
  Visa/Mastercard を MDC、JCB を MyJCB に案内し、家族/ETC/追加カード分を本会員明細に
  含める。WESTER ID と MDC ID は別である。
- [J-WEST 本人認証案内](https://wester.jr-odekake.net/j-west/support/ec_secure/) も
  Visa/Mastercard と JCB で登録先を分ける。
- [JALカード FAQ](https://jalcardfaq.jal.co.jp/--68fb5e92c8b75b4a1de3daef) は、JAL
  Visa/Mastercard/TOKYU POINT ClubQ の明細を三菱UFJニコス/MDC で確認し、家族カード分を
  本会員側から確認できるとする。[JAL/DC 統合案内](https://www.integration.cr.mufg.jp/dcjalcard/)
  も旧 DC Web/App から MDC への移行を示す。
- JALカード公式の
  [ショッピングマイル案内](https://jalcard.jal.co.jp/sp/merit/shopping.html) は、積算したマイルを
  MyJALCARD で確認し、カード利用代金明細にはマイル/ポイント数を表示しないとする。

MDC の Mastercard/Visa/JCB 用ログインと American Express 用ログインも公式入口が分かれる。
「三菱UFJニコス発行」だけを根拠に全ブランドを同一 URL/DOM/transport とみなさない。

## 4. 残高・明細・export の対象範囲

MDC は預金残高ではなく、カードごとの請求・利用・利用可能額・ポイントを扱う。公式
[MDC 画面ガイド](https://www.cr.mufg.jp/mufgcard/contact/guide/detail_inquiry/index.html) と FAQ から
確認できる範囲は次のとおりである。

| データ             | 粒度/状態                | 確認できる項目                                                              | 制約                                                                    |
| ------------------ | ------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 請求確定分         | 月次請求と利用明細行     | 支払日、請求額、支払口座表示、利用者、利用日、加盟店名、支払区分/回数、金額 | 口座表示・実額は収集しない。カード/利用者識別子は匿名ローカルキーへ変換 |
| 未確定分           | 売上データ到着後の利用行 | 利用日、加盟店、支払区分、金額等                                            | 即時性はない。締日から請求確定まで表示に空白があり得る                  |
| 返金/取消          | 確定明細上のマイナス行等 | 加盟店、調整額、ポイント調整                                                | 未確定段階の取消反映時期や原取引との機械的 link は未確認                |
| 分割/リボ          | 行と月次支払内訳         | 当月支払額、支払総額、手数料等                                              | PC とスマホで表示差がある。支払方法変更は write なので禁止              |
| 利用可能額         | 現在値                   | 利用可能枠/額                                                               | 資産残高ではない。収集対象にする必要性を別途判断                        |
| グローバルポイント | 本会員単位の残高/付与    | 獲得・残高、対応カードでは交換導線                                          | 提携カードの JMB/WESTER を代替しない。交換は write                      |

[明細反映 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=236) は、加盟店から売上データを受信
してから表示するため時期が加盟店ごとに異なるとする。毎月15日の締め後から概ね21日の請求
確定までは、対象取引が未確定一覧から一時的に見えなくなることがある。旧 DC の「速報」は
MDC の「未確定分」に対応する
（[統合後の未確定表示 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4537)）。よって pending を
posted に上書きするのではなく、取得日時・状態・金額・加盟店・利用日から重複を調整し、消失を
削除と即断しない。

[取消・返金 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=3616) は返金をマイナス金額、ポイントを
減算として明細へ反映するとする。[分割明細 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4046)
は当月支払額、支払総額、手数料を示し、完全な詳細は PC 表示を案内する。加盟店名の正規化、
取消と原取引の ID、承認時刻、通貨/為替の CSV 列は公式公開資料だけでは確認できない。

### 4.1 期間・件数・PDF/CSV

- 現行 [明細保存 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=2212&site=NIX1EXYK) と画面ガイドは
  「過去15か月分」を PDF/CSV で保存可能とする。スマートフォンは PDF のみで、CSV は PC
  経路が必要である。期間外は再ダウンロードできないためローカル保存が必要である。
- 一方、[旧 MUFG サービス統合案内](https://www.integration.cr.mufg.jp/mubank/webservice/) と
  [公式 MDC アプリ](https://apps.apple.com/jp/app/%EF%BD%8D%EF%BD%83%E3%82%A2%E3%83%97%E3%83%AA/id1530905195)
  は「最大16か月」と表記する。現月を含む16表示月と「過去15か月」の数え方の差である可能性は
  あるが、公開資料だけでは断定しない。
- 上記 `www.integration.cr.mufg.jp` の3リンクは公式検索結果に内容が残る一方、2026-08-26 の
  reachability check では TLS 証明書の hostname mismatch となった。移行時点の一次資料として
  扱うが、現行の運用仕様は MDC FAQ/画面ガイドと live 表示を優先する。
- 公開公式資料では、画面1ページ当たりの行数、最大明細件数、CSV の厳密なヘッダー/文字コード、
  PDF/CSV が確定月単位か複数月一括かを十分に確認できなかった。live 検証項目とする。

保存設計は月次ファイルを原本として暗号化ストレージへ置き、ファイル hash、カード匿名キー、
請求月、取得時刻、source URL/形式だけを索引化する。帳票に含まれる口座番号断片や氏名等は
取り込み前に redaction するか、原本をアプリ処理領域外へ隔離する。

## 5. ポイント

[グローバルポイント規定](https://www.cr.mufg.jp/member/rule/mufgcard/globalpoint.html) により、
対応カードでは明細/MDC にポイント獲得・残高が表示され、締日後の変更は後続月へ反映される。
通常ポイントの有効期限は獲得月から24か月、プラチナ等は36か月で、本会員に帰属する。

ただし、カード券種別に正本を分ける。

- 三菱UFJカードのグローバルポイント: MDC の read-only 照会を候補にする。
- JALカード: MDC は請求、JMB がマイル正本。MDC からマイル履歴を推定しない。
- J-WEST Visa/Mastercard: MDC は請求、WESTER がポイント正本。WESTER ID と結合する場合も
  別 credential/source とする。

ポイント交換、商品申込、電子ギフト発行は read ではないため自動化対象外である。

## 6. 認証・MFA・passkey・Bitwarden

### 6.1 確認事実

- MDC web はカード単位の ID/パスワードに加え、生年月（年/月）または登録電話番号下4桁の
  追加確認を求める
  （[ログイン不能時案内](https://www.cr.mufg.jp/mufgcard/contact/unable_to_login/index.html)、
  [追加確認 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4069)）。これは PII/知識要素である。
- 公式アプリ初回は MDC ID/パスワードと登録生年月を使う
  （[アプリ初回ログイン FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4088)）。設定後はアプリ用
  パスコードまたは端末生体認証を使える
  （[生体認証 FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4018)）。
- オンライン購入の EMV 3-D Secure は、登録メールまたは SMS に届くワンタイムパスワードを
  使用し、2024-11 以降の旧 ID/パスワード方式を置換した
  （[3-D Secure FAQ](https://faq.cr.mufg.jp/mufgcard/detail?id=4146)）。これはカード決済時の本人認証
  であり、通常の MDC web ログイン MFA と同一とは確認できない。
- MDC web/app の passkey/WebAuthn 対応を示す公式資料は確認できなかった。アプリの「生体認証」
  はローカル unlock として説明され、サーバー passkey とは確認できない。

### 6.2 Bitwarden との関係（推測を分離）

Bitwarden は一般に
[browser autofill](https://bitwarden.com/help/auto-fill-browser/)、
[custom fields](https://bitwarden.com/help/custom-fields/)、
[Android autofill](https://bitwarden.com/help/auto-fill-android/) を提供する。この一般機能から、MDC の
ID/パスワード入力補助と、カード別 URI/item の分離は技術的に可能と推測できる。ただし MDC
固有の公式連携ではない。Android 版は custom field を扱えないという制約もある。

生年月または電話下4桁を custom field に保存すれば web 入力を補助できる可能性はあるが、PII を
保存し、追加知識要素を password と同じ vault item に集約する。これは利便性と防御分離の
トレードオフであり、本実装の必須要件・既定値にはしない。DOM 名を確認しても値を HAR、ログ、
スクリーンショットへ記録しない。passkey が見つからないことを Bitwarden 非対応の根拠にはしない。

セッション寿命、refresh token、Cookie 再利用期間、同時ログイン、IP/端末 binding、通常ログイン
での追加 OTP 発生条件は未確認である。

## 7. CDN、WAF、anti-bot

2026-08-26 のログアウト状態の HEAD 観測では次を確認した。

| 公開入口                    | 観測                                                               | 言えること / 言えないこと                                 |
| --------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `www.cr.mufg.jp/mufgcard/`  | `200`, `Via: ...cloudfront.net`, `X-Cache`, `X-Amz-Cf-*`           | 公開ページは Amazon CloudFront 経由。認証域の構成は未確認 |
| `faq.cr.mufg.jp/mufgcard/`  | `200`, `Server: Apache`                                            | FAQ の公開応答。WAF 不在の証拠ではない                    |
| `www2.cr.mufg.jp/newsplus/` | `200`, `Server: nginx`, `PHPSESSID`, `X-PUBLIS-Status`, CloudFront | 動的 session/redirect がある。Cookie 値は保存しない       |

この範囲では Cloudflare/Akamai 固有ヘッダーを観測しなかった。しかし CDN ヘッダーだけから WAF
製品や bot detection の有無を断定できない。ログイン後の別 origin、JavaScript challenge、
fingerprinting、rate limit、device/IP reputation は未確認である。意図的な challenge 誘発、CAPTCHA
回避、レート上限探索、ヘッダー偽装による security control bypass は行わない。

## 8. 公式アプリ、APK、web の役割

- [公式 MDC アプリ案内](https://www.cr.mufg.jp/mufgcard/service/other/app/002/index.html) は月次
  支払額、明細、ポイント、利用可能額を主な照会機能とする。一方、支払方法変更やポイント交換等の
  write 導線も同居する。
- 公式 Android 誘導先から確認できる Google Play package は `jp.mufg.cr.app4`
  （[Google Play](https://play.google.com/store/apps/details?id=jp.mufg.cr.app4)）。iOS は
  [App Store](https://apps.apple.com/jp/app/%EF%BD%8D%EF%BD%83%E3%82%A2%E3%83%97%E3%83%AA/id1530905195)
  で配布される。公式 standalone APK 配布は確認できなかった。
- web は PC で CSV を取得でき、確定/未確定画面や帳票確認に向く。アプリは日常照会、通知、
  passcode/biometric unlock に向くが、家族/法人/一部カードは対象外で、CSV も公式案内上は PC
  経路が必要である。

APK/アプリ/JS/通信の解析は非目標ではない。公式文書と read-only web 観測で transport/項目が
不足する場合の次段階として、ユーザー管理端末へ Google Play から正規インストールした binary
の静的解析、ユーザー自身のセッションの read-only 動的観測を行える。ただし、再配布 APK、改変
アプリ、certificate pinning/attestation/CAPTCHA の回避、秘密の抽出・永続化、write 操作は行わない。

## 9. 公開第三者実装と transport/auth

2026-08-26 に GitHub code search で `My Digital Connect`、`jp.mufg.cr.app4`、
`www2.cr.mufg.jp/newsplus`、`mufg card scraper` 等を検索したが、現行 MDC 個人口座の認証・明細
取得を実装する公開 client は特定できなかった。これは公開実装が存在しないという証明ではない。

見つかった
[GoodLight999/otoku-checker](https://github.com/GoodLight999/otoku-checker/tree/149fd492139b7e4272ac65695bc20241b502614e)
は、公開されている MUFG ポイント優遇ページを Python `requests.Session.get` + browser-like header で
HTTP GET し、BeautifulSoup/trafilatura で HTML を抽出する実装である。認証なし、個人明細なし、
公開コンテンツだけで、repository に license 表示もない。したがって personal-account transport の
根拠にも、コード再利用の根拠にもならないが、公開 `www.cr.mufg.jp` が通常 HTTP client に応答する
具体例ではある。

現時点で確認済みの personal transport/auth は「TLS 上の web/app、カード別 ID/password、追加
知識確認、session Cookie を使うと見られる」という UI/公開ヘッダーの範囲に留まる。JSON/GraphQL/
form POST、endpoint、CSRF、device binding、token 更新は未確認である。

### 9.1 不足時の read-only transport 特定手順

1. **公式 web の静的観測**: ログアウト公開 HTML/JS の URL、form action、CSP、asset manifest を
   記録し、認証後 URL や secret は記録しない。公開 source map があれば read-only schema 名の
   手掛かりとして見る。非公開 resource へのアクセス制御回避はしない。
2. **認証済み web の動的観測**: ユーザー管理 browser の DevTools で、明細一覧/詳細/PDF/CSV
   ダウンロードという許可済み read 操作だけを行う。method、origin、path template、content-type、
   status、request/response field 名を allowlist で収集する。Cookie、Authorization、CSRF 値、
   カード/会員番号、口座、実額、加盟店実値、PII を capture 前/保存前に redaction する。sanitized
   HAR を共有する前に secret scanner と手動レビューを通す。
3. **公式アプリの静的解析**: 正規入手 APK の manifest、package、min SDK、network security config、
   bundled library、host/path の文字列、protobuf/OpenAPI 相当の型名を調べる。署名確認と binary hash
   を行い、binary は repository に置かない。難読化は不明を増やすだけで、解除や制御回避を目的に
   しない。
4. **公式アプリの動的観測**: ユーザー管理端末/エミュレータで read-only 画面だけを開き、OS が
   許す標準的な network/debug observability を使う。certificate pinning、root/attestation、
   anti-tamper を回避しなければ見えない場合は停止し、UI automation へ戻す。トークン/PII/実値を
   永続化しない。
5. **再現性判定**: read endpoint が分かっても、公開 API と扱わない。read/write endpoint と
   credential scope を列挙し、read-only request の replay を隔離環境で 1 回だけ検討する。認証更新が
   write/OTP/reset/防御回避を要する、または read/write が同一 credential で分離できない場合は
   headless replay を採用しない。

この手順は解析を禁止するものではなく、公式情報で不足する transport の確認を安全な順序で進める
ものとしている。

## 10. read/write 隔離

最小 allowlist:

- login と既存 session の確認（lock/reset/再登録は除外）
- カード別の確定/未確定明細一覧・詳細の表示
- 既存の月次 PDF/CSV download
- 対応カードのポイント残高/付与履歴、利用可能額の表示（必要な場合のみ）

denylist:

- 支払区分変更、あとdeリボ/分割、繰上返済、支払額変更
- キャッシング、カードローン、限度額/利用枠変更
- ポイント交換、商品/ギフト申込、キャンペーン entry
- カード、ETC、家族/追加カード、保険等の申込
- 氏名、住所、電話、メール、口座、暗証、password、通知等の設定変更
- WEB 明細/3-D Secure 登録・解除、ID reset、カード再発行/停止

内部 API が read と write を同じ session credential で許す可能性があるため、HTTP method だけに
依存せず origin+path+schema の allowlist、egress proxy、dry-run、response content-type/size 上限を
組み合わせる。遷移先に「申込」「変更」「確定」「交換」「借入」等が現れたら action せず停止する。

## 11. runtime 適性

| Runtime                | 適性                                                           | 理由                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare Workers     | 手動 export の受領・解析には高い。直接ログインには低い         | Workers の [Fetch API](https://developers.cloudflare.com/workers/runtime-apis/fetch/) で HTTP ingestion は可能。通常 isolate は card別 browser session、追加確認、download UI の保持に向かない                                 |
| Cloudflare Browser Run | web UI 自動化候補                                              | [Browser Run](https://developers.cloudflare.com/browser-run/) は Playwright/Puppeteer/CDP と session reuse を提供する。ただし金融 session/PII を cloud browser に置く設計判断、card別ログイン、追加確認、read/write 混在が残る |
| Cloudflare Containers  | headless browser/解析 worker 候補                              | [Containers](https://developers.cloudflare.com/containers/) は full filesystem と任意 runtime/OCI image を実行できる。秘密配送、persistent profile、地域/IP、sleep/再起動、監査を別設計する必要がある                          |
| 一般 OCI container     | 適する                                                         | Playwright、PDF/CSV parser、sanitizer を再現可能に固定できる。profile/credential は image に入れず、短命 secret mount と暗号化 volume を使う                                                                                   |
| Kubernetes             | 多数 source の運用基盤としては適するが、初期 MUFG 単体には過大 | CronJob、NetworkPolicy、read-only filesystem、Secret CSI、監査を使える。card別 job と egress allowlist は明確になるが運用コストが高い                                                                                          |
| ユーザー管理端末       | 初回 live 検証と app 観測に最適                                | 既存の正規 app/browser と人手追加確認を使え、秘密を外部 runtime へ搬出しない。完全無人化にはならない                                                                                                                           |

推奨構成は、当初はユーザー端末から月次 CSV/PDF を手動取得し、Workers/OCI の read-only parser へ
渡す。web transport が安全に分離できると確認できた場合だけ、ユーザー端末または隔離 OCI/
Browser Run の browser job を追加する。アプリ transport しか十分な粒度を持たない場合は、UI/device
automation として費用を再評価する。

## 12. 自動化レベル A-E と実装コスト

PR #5 共通定義のみを用いる。

- **A**: documented/export API を scheduled headless で使用
- **B**: 安定した read-only internal API と更新/再利用可能 session
- **C**: browser/app bootstrap 後の headless replay が有望
- **D**: full browser/device automation が必要
- **E**: manual capture が安全な既定

| 選択肢                                           | Level  | Cost (1-5) | 判定                                                                                                       |
| ------------------------------------------------ | ------ | ---------: | ---------------------------------------------------------------------------------------------------------- |
| PC から月次 CSV/PDF を手動 export、parser へ投入 | E      |        1-2 | 公式で提供され、最初の実装に推奨。card別ログインとファイル redaction で 2 になり得る                       |
| MDC web の card別 read-only browser automation   | D      |          4 | ID/追加確認、複数カード、状態遷移、write 導線混在、session/WAF 未確認。CSV 取得は可能性が高い              |
| 観測済み read endpoint の bootstrap + replay     | C 候補 |        4-5 | endpoint/session が未確認で B とは評価できない。read/write scope と credential 更新の分離確認が前提        |
| 公式アプリ UI/device automation                  | D      |          5 | 家族/一部カード対象外、端末生体/パスコード、write 導線、transport/attestation 未確認。web より先に選ばない |

**総合評価: D、cost 4。安全な初期経路は E、cost 1-2。** documented personal API は確認できず、
安定した read-only internal API もまだ観測していないため A/B にはしない。将来の静的解析・動的観測
で transport と read/write 分離が実証されれば C へ更新できる。

## 13. read-only live 検証計画と stop 条件

### Phase 0: 人手 inventory（秘密・番号なし）

1. 各候補カードについて表示名、発行会社、国際ブランド、MDC マーク、本会員/家族会員、
   特典正本（MDC/JMB/WESTER）だけを確認する。
2. card別 ID の存在を数えるが ID 自体を記録しない。本会員明細に家族/ETC/追加カードが含まれる
   表示を確認し、二重取得を防ぐ。
3. J-WEST JCB/MyJCB、NICOS/Net Branch、MUFG 銀行口座を本 source から除外する。

### Phase 1: web の 1 回 read-only 検証

1. ユーザー管理 browser で通常ログインし、ID/password/生年月/電話下4桁を automation log に渡さない。
2. 確定/未確定の表示月、月選択数、1ページ行数、pagination、利用者、加盟店、返金マイナス、分割
   内訳の有無を、実値を転記せず schema として確認する。
3. 最古月と最新月を数え、「過去15か月」と「最大16か月」の差を解消する。
4. ダミー生成ではなく既存の1か月について PDF/CSV の download control、単月/一括、MIME、
   filename pattern、encoding、header、row count limit を端末内で確認する。ファイル内容は共有しない。
5. DevTools 観測を行う場合は Section 9.1 の redaction を先に有効化し、read endpoint の method/path
   template/field 名だけを残す。write request は送らない。

### Phase 2: app/transport（web で不足する場合）

1. Google Play の署名済み package `jp.mufg.cr.app4` をユーザー管理端末から取得し、package/version/
   signing certificate/hash だけを記録する。
2. 静的解析で host/schema 候補を確認し、Phase 1 の web host と分ける。
3. read-only 画面の標準的な動的観測を 1 セッションだけ行う。pinning/attestation/anti-tamper 回避が
   必要なら停止する。
4. read/write endpoint、credential scope、session 更新、rate response を整理し、再現 request は
   安全な read のみ、最小1回とする。write capability のない token/scope が確認できなければ B に
   昇格させない。

### 即時 stop

- OTP/3-D Secure、CAPTCHA、追加本人確認、ID reset、account/card lock、再登録を求められる
- 支払/借入/交換/申込/変更/確認送信ページへ遷移する、または read と write endpoint を分離できない
- security control の回避、証明書 pinning/attestation/anti-tamper の迂回が必要になる
- HAR/log/screenshot/download に Cookie、token、カード/会員/口座番号、PII、実額、加盟店実値が
  redaction されず含まれる
- 403/429/異常 redirect/challenge、アクセス拒否、規約/robots の明確な禁止、想定外 origin を観測する
- 再現 request が idempotent read と確認できない、method/path/schema が allowlist 外である

停止時は retry、別 IP、header 偽装、別端末による迂回を行わず、手動 CSV/PDF 経路へ戻す。

## 14. 確認事実・推測・未確認事項

### 確認事実

- MDC は対象カードごとの ID で、家族会員も web 登録可能だがアプリ対象はより狭い。
- 確定/未確定明細、PDF/CSV、加盟店/利用者/支払区分等の表示が公式に案内される。スマホは PDF
  のみ、CSV は PC 経路である。
- 返金はマイナス、分割には手数料/総額等があり、未確定は加盟店売上データ到着依存である。
- web 通常ログインには ID/password と生年月または電話下4桁の追加確認がある。アプリは設定後に
  passcode/biometric unlock を使える。3-D Secure OTP は決済認証である。
- 公開ページで CloudFront を観測した。公式アプリ package は `jp.mufg.cr.app4` である。
- JAL/J-WEST は請求とマイル/ポイントの正本が分かれる。

### 推測（live で検証する）

- 「最大16か月」と「過去15か月」は現月を含むかの数え方の違いである可能性がある。
- Bitwarden は MDC credential の入力補助に使えるが、追加確認値の保存は防御分離を弱める。
- browser bootstrap 後に read endpoint replay が可能な場合があるが、session と write scope が未確認で
  あり、現時点では C 候補に留まる。

### 未確認

- ユーザーの保有カード一覧、券面ブランド、本会員/家族/追加カード関係（値は記録しない）
- CSV の厳密な schema/encoding、PDF/CSV の単月性、pagination/最大件数、返金の原取引 link
- 外貨/換算/手数料列、加盟店 ID、承認/売上時刻、pending の stable ID
- web/app の endpoint/protocol、CSRF/token、session 寿命/更新、device/IP binding、通常 login MFA 条件
- passkey/WebAuthn、認証域の WAF/anti-bot、アプリ pinning/attestation
- 公開されている現行 personal MDC client の有無と license

## 15. 主な公式リンク

- [My Digital Connect](https://www.cr.mufg.jp/mufgcard/)
- [MDC 利用対象](https://faq.cr.mufg.jp/mufgcard/detail?id=383)
- [明細照会ガイド](https://www.cr.mufg.jp/mufgcard/contact/guide/detail_inquiry/index.html)
- [明細 PDF/CSV と期間](https://faq.cr.mufg.jp/mufgcard/detail?id=2212&site=NIX1EXYK)
- [カードごとの MDC ID](https://faq.cr.mufg.jp/mufgcard/detail?id=396)
- [家族カードの MDC 登録](https://faq.cr.mufg.jp/mufgcard/detail?id=395)
- [旧 DC Web サービス統合](https://www.integration.cr.mufg.jp/dccardfc/webservice/)
- [旧 MUFG カード WEB サービス統合](https://www.integration.cr.mufg.jp/mubank/webservice/)
- [MDC アプリ](https://www.cr.mufg.jp/mufgcard/service/other/app/002/index.html)
- [J-WEST 明細案内](https://wester.jr-odekake.net/j-west/support/meisai/)
- [JALカード明細 FAQ](https://jalcardfaq.jal.co.jp/--68fb5e92c8b75b4a1de3daef)
