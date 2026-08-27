# Amazon.co.jp card / gift card / Points source assessment

調査日: 2026-08-26

## 1. Scope と境界

本 source は Amazon.co.jp consumer account の次の read-only 情報だけを扱う。

- 注文、商品行、配送・キャンセル・返品・返金状態、注文合計、領収書等の表示
- Amazon ギフトカード残高、有効期限、残高増減履歴
- Amazon ポイントの利用可能・獲得予定・期間限定残高、有効期限、増減履歴
- 上記表示に必要な Amazon account の認証/session と公式 shopping app

**Amazon Mastercard のカード利用明細は対象外である。** Amazon の注文画面は「何を注文し、
どの支払手段を指定し、Amazon がどう返金したか」の commerce record であり、カード利用日、加盟店、
未確定/確定、締め、請求額、支払日、分割等の issuer ledger ではない。Amazon Mastercard は三井住友
カード発行で、明細正本は [Vpass](https://www.smbc-card.com/mem/oshiharai/index.jsp) 側の別 source とする。
Amazon 注文と Vpass の `AMAZON.CO.JP` 等を額だけで自動同一視せず、複数商品、分割発送、与信、
返金時差、ポイント/ギフト併用を考慮した reconciliation に限定する。

購入、注文確定、再注文、キャンセル、返品申請、レビュー、ギフトカード登録/購入/使用、ポイント使用、
支払方法・住所・認証・profile変更は禁止する。秘密、cookie、OTP、passkey material、注文番号、住所、
商品名、実残高・実額を保存しない。security control の回避を目的にしない。

## 2. 調査方法

- Amazon、三井住友カード、Google Play の公式公開ページを優先した。
- 未ログインで注文履歴、ギフト残高、Privacy Central の入口を Chrome-like GET し、redirect、header、
  script host、OpenID parameter 名だけを観測した。cookie値は採用・保存していない。
- 公開 GitHub 実装は公式UIの具体的transport/paginationを補う二次資料としてコードを確認した。
- login、account page、APK取得/decompile、本人データのlive captureは実施していない。

公開入口:

- [注文履歴](https://www.amazon.co.jp/your-orders/orders)
- [ギフトカード残高](https://www.amazon.co.jp/gc/balance)
- [ギフトカード細則](https://www.amazon.co.jp/gp/help/customer/display.html?nodeId=GNG9PXYZUMQT72QK)
- [Amazonポイント](https://www.amazon.co.jp/gp/aw/help/id=200041560)
- [Privacy Central data request](https://www.amazon.co.jp/hz/privacy-central/data-requests/preview.html)
- [パスキーについて](https://www.amazon.co.jp/gp/help/customer/display.html?nodeId=TPphmhSWBgcI9Ak87p)
- [Amazon Shopping Android](https://play.google.com/store/apps/details?id=com.amazon.mShop.android.shopping)
- [Amazon Mastercard](https://www.amazon.co.jp/credit/landing)
- [Vpass 明細](https://qa.smbc-card.com/mem/detail?site=4H4A00IO&category=163&id=40)

## 3. 公式経路とデータ比較

| 経路 | 取得できる情報 | 粒度・状態 | 期間/件数/export | tradeoff |
| --- | --- | --- | --- | --- |
| Amazon Web 注文履歴 | 注文日、注文単位合計、商品行、配送/キャンセル/返品/返金状態、領収書等 | 注文→商品→配送/返金。カード請求行ではない | UIは期間filterとpaginationを持つ。consumer向け一括CSV/APIは公開確認できず、領収書等は注文別print/PDF相当 | 最も詳細だがPIIが多く、write導線が隣接 |
| Amazon Shopping app | Webに近い注文、配送、返品/返金、ギフト/ポイント残高 | mobile UI。通知や配送状態は便利 | 固定retention/全件exportは未確認 | 端末/session/画面変更に拘束。最初のcollectorにしない |
| ギフトカード残高ページ | 現在残高、チャージ/登録/注文利用/返金等の増減、期限 | 残高ledger。注文内訳とは別 | 公式固定件数、pagination、CSV/PDFは公開確認できず。細則上、有効期限は原則発行から10年 | reconciliationに有用だが登録・購入導線が同居 |
| Amazonポイントページ | 利用可能、獲得予定、期間限定、履歴、期限 | point増減。注文確定/発送/取消で予定と確定が変化し得る | standard point は原則、最後の購入または獲得から1年で期限更新。期間限定pointは個別期限。CSV/PDF/APIは未確認 | reward ledgerであり現金・カードledgerではない |
| 注文別領収書/購入明細 | 注文番号、日付、商品、税、支払内訳等 | 注文別document | 個別print/download。全注文一括exportとは別 | evidenceは強いが一件ずつで高コスト |
| Privacy Central request | Amazonが保有するaccount dataの請求 | 非同期snapshot。カテゴリ/schemaはlive確認が必要 | scheduled incremental APIではない。生成時間・形式・retention未確認 | 最も包括的な公式export候補だが低頻度/manual |
| Vpass | Amazon Mastercardを含むカード未確定/確定明細・請求 | issuer/card ledger | Vpass family sourceで調査 | 本sourceへ混ぜない |

### 注文・返金と残高の関係

確認事実として、Amazonは注文履歴、ギフト残高、ポイントを別画面に分ける。推測を含む照合キーは
日時範囲、符号、一般化した支払種別、注文単位/配送単位であり、注文番号や商品名を恒久保存しない。
返品受付は返金settledではない。返金先がカード、ギフト残高、ポイントのどれか、部分返金か、Vpassに
いつ反映したかを別々の状態として扱う。pending/postedはAmazon共通の一軸ではなく、注文状態、
ポイント獲得予定→利用可能、返金処理→各残高反映、カード未確定→確定の別state machineである。

## 4. 認証、MFA、passkey、Bitwarden

未ログインGETでは注文履歴が Amazon sign-in へ OpenID 2.0 `checkid_setup` redirectし、
`openid.return_to`、`openid.assoc_handle`、`openid.identity`/`claimed_id`を使用した。注文履歴、ギフト残高、
Privacy Centralは別 `assoc_handle` と異なる `max_auth_age` を持ち、同じsessionでも再認証強度が異なり得る。
これは公開redirectの確認事実であり、内部authorization APIの仕様ではない。

Amazon公式はpasswordに加えてpasskeyと2段階認証を提供する。具体的な challenge、RP ID、extension、
OTP再要求条件、trusted-device寿命はlive captureしていない。Bitwardenは一般にpasskeyを保持・提示できるが、
当該Amazon accountのcredentialがBitwardenにあること、Amazon.co.jpの実RP IDと一致すること、headless
assertionが可能なことは未確認であり推測しない。

推奨境界は「本人の通常browserで初回/再認証、暗号化したsource-scoped sessionでread replay」。vault、
password、OTP seed、passkey private keyをcloudへ移さない。challenge、OTP、account recovery、CAPTCHA、
異常login確認が出たら自動処理を停止して本人へhandoffする。認証設定の変更や新passkey登録はしない。

## 5. WAF / anti-bot と公開 JS

今回のWSLから公式account入口はbot blockではなくsign-in HTMLへ到達し、`x-amz-rid`、Amazon固有session
cookie、`m.media-amazon.com`のAUI bundles、`unagi.amazon.co.jp` telemetryを確認した。`server: Server`だけ
ではCloudFront/Akamai等のvendorを断定できない。地域cookieがAustraliaを示したため、region/egressで
表示・challengeが変わる可能性がある。

未認証HTML/JSからはOpenID redirectと汎用AUI runtimeまでは確認できたが、注文/ギフト/pointのread
endpointやschemaは取得できなかった。公開bundleの静的解析、本人browserのredacted network観測、所有
端末から取得した公式APKの静的解析は次段階の正当な調査である。ただし、CAPTCHA解答自動化、fingerprint
偽装、rate-limit回避、暗号化/難読化を無効化するparameter、TLS pinning/attestation bypassは採用しない。

公式Android packageは `com.amazon.mShop.android.shopping`。APKを所有端末から split込みで取得し、
署名、manifest、deep link、network security config、host/path/schema、WebView/native境界を調べる価値がある。
見つけたwrite endpointは名前だけ分類し、payloadを生成・送信しない。Amazon app全体のcloud emulationは
device trust、巨大bundle、頻繁な更新に対し費用が高い。

## 6. 第三者clientの具体的transport/auth

### `furyutei/amzOrderHistoryFilter`

[repository](https://github.com/furyutei/amzOrderHistoryFilter) はamazon.co.jp注文履歴上で動くuserscript。
既存browser cookieをambient authorityとして同一origin HTMLを`fetch`し、`/your-orders/orders`を
`startIndex` 0,10,20...で巡回、DOMのorder cardと領収書画面をparse/printする。1ページ10注文という
具体的実装証拠になるが、公式APIでもtoken authでもない。repositoryに明確なlicenseを確認できず、codeを
取り込まない。また同scriptの`disableCsd=missing-library`提案は表示保護を弱める意図が読めるため、
security-control bypass禁止によりKoganeでは使用しない。

### `yossyl3oy/amazon2mfcloud`

[repository](https://github.com/yossyl3oy/amazon2mfcloud) はログイン済み注文履歴DOMを読むbrowser extension。
`GET /your-orders/orders?timeFilter=year-YYYY&startIndex=N`を`fetch(...,{credentials:'include'})`し、
HTMLを`DOMParser`で解析する。専用API tokenやpassword loginを実装せず、browser sessionに依存する。
注文番号、商品名、額を外部会計へ渡す設計はKoganeの最小保持方針に合わず、licenseも確認できないため、
transport evidenceのみ採用する。

Amazon Selling Partner API、Product Advertising API、Amazon Pay APIはseller/広告/Amazon Pay merchant向けで、
個人buyerの注文・ギフト・point履歴を読むconsumer APIとして転用しない。公開third-party実装にもギフト残高・
ポイントを安定取得するmaintained consumer clientは確認できなかった。

## 7. read/write 隔離

- allowlistは原則 `GET www.amazon.co.jp/your-orders/orders` と観測後に確定したread-only detail/exportだけ。
- browser bootstrap中のsign-in POSTは本人操作の認証境界でありcollector transportへ含めない。
- cancel、return、buy-again、checkout、gift-card redeem/reload、point use、address/payment/profile/securityは
  methodを問わずdenylistとし、該当controlをclickしない。
- CSRF tokenはwrite可能性を示す機密session materialとして保存・送信しない。read clientに汎用POST機能を持たせない。
- rateは1 connection、逐次、十分な間隔、conditional/incremental read。403/429、CAPTCHA、challenge、schema不一致で停止。
- raw evidenceが必要なら本人端末の暗号化一時領域だけに置き、PII redaction後のschema/hash/countのみ残す。

## 8. Runtime 適性

| Runtime | 適性 | 判断 |
| --- | --- | --- |
| Local browser/WSL | 最適 | passkey/MFA handoffと同一origin session観測、manual exportに適する |
| Cloudflare Workers | 条件付き | 確立済みGET replayとparserは可能。browser/passkey、cookie運用、Amazon egress差に不向き |
| Cloudflare Containers | 適 | browser/parserを隔離できる。sessionはimage/logに置かずsecret store+tmpfs、egress allowlist |
| OCI container | 適 | digest固定browser、Cron、encrypted session、read-only FSを組みやすい。egress再認証を検証 |
| Kubernetes | 過剰 | CronJob/Secret/NetworkPolicyは適合するが単一accountには運用costが大きい |
| Android実機 | 調査に適 | 公式app表示/APK/本人操作のread-only tracingに必要。定常UI automationは脆い |

## 9. PR #5共通 A-E / Cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| 経路 | Level | Cost | 判定 |
| --- | ---: | ---: | --- |
| 注文別領収書/Privacy Centralを人手取得してoffline import | E | 1-2 | 公式で安全。incremental自動化ではない |
| ログイン済みbrowserで注文HTMLを同一origin巡回 | D | 3 | 公開実装あり。PII/write UI/session変化に注意 |
| local bootstrap後、注文GETをheadless replay | C候補 | 3-4 | endpointは具体的。session renewal/WAF/再認証をlive確認するまでBではない |
| ギフト残高/ポイント internal read replay | C候補 | 4 | endpoint/schema/pagination未確認。残高変動stateの検証が必要 |
| Amazon Shopping app UI/device automation | D | 5 | device trust、画面変更、write導線、広い権限 |
| buyer向け公式scheduled API | A該当なし | 5 | consumer注文/ギフト/points APIを確認できない |

総合は **C候補/cost 4**、安全な初期経路は **E/cost 1-2**。注文履歴だけは公開実装によりCへの道筋が
具体的だが、gift/pointsはまだD寄りである。

## 10. read-only live 検証と stop 条件

1. 通常browserでAmazon.co.jpのdomain、TLS、login方式だけ確認。passkey/OTPは本人が処理し値を記録しない。
2. 注文履歴でfilter選択肢、最古年、1ページ件数、pagination、注文/商品/配送/返金field名だけを記録。
3. 既存注文1件で領収書/購入明細のcontrolとformatを確認するが、ファイル内容・注文番号・実額を保存しない。
4. ギフト残高ページで残高履歴の列名、期間filter、件数、pagination、期限field、export有無だけ確認。
5. ポイントページで利用可能/予定/期間限定、履歴列、個別期限、pagination/export有無だけ確認。
6. DevToolsはhost/path/method/status、header名、redacted JSON key/DOM selectorだけ残す。最初はGETのみ。
7. 注文GETを同一browserで1回再読し、次に暗号化sessionを同一hostから1回replay。成功後だけOCIで試す。
8. appがWebにない粒度を持つ場合だけ、所有端末の公式splitを署名検証し静的解析、本人操作中のread-only
   refreshを観測する。pinning/attestationで見えなければ回避せず障壁として記録する。

即時stop: 購入/注文確定/再注文/ギフト使用/point使用/設定変更の可能性、POST/PUT/PATCH/DELETE、未知host、
OTP/CAPTCHA/recovery、403/429、account lock警告、schema drift、PII redaction失敗、sessionが端末/egressにbinding、
規約/技術controlが自動取得を明示的に拒む場合。停止後はmanual exportへ戻す。

## 11. 確認事実・推測・未確認

**確認事実:** Amazon注文履歴/ギフト残高/Privacy Centralは未認証時にAmazon sign-inへOpenID redirectする。
注文履歴の公開実装はambient browser cookieと同一origin HTML、`timeFilter`/`startIndex`を使う。Amazon
Mastercard明細はSMBC/Vpass境界。公式buyer向けscheduled APIは確認できない。

**推測:** 注文GET session replayはlocal bootstrap後に成立する可能性が高い。gift/pointsも同じaccount
sessionを共有し得るが、異なる`assoc_handle`/再認証強度のため個別検証が必要。注文とカード明細の照合は
確定的joinではなく候補matchingになる。

**未確認:** 現行UIの最古年/全件数、gift/pointsの保持期間・pagination・export、Privacy Centralのschema、
passkey RP ID/Bitwarden適合、2SV/trusted-device/session寿命、内部read endpoint、WAF vendor、app pinning/
attestation、refundの各残高への正確な遷移、Amazon MastercardとAmazon accountのlinkage表示範囲。
