# WESTER / J-WEST / Wesmo! source assessment

調査日: 2026-08-26

## 1. Scopeとledger境界

本sourceは、同じWESTER IDと相互導線を使う次のread-only ledgerを分離する。

- **WESTERポイント**: `基本`、`期間・用途限定`、`チャージ専用`の残高、付与・利用履歴、有効期限
- **Wesmo!**: `残高（出金可）`、`残高（出金不可）`、決済、チャージ、送金・受取、出金、取消等のwallet event
- **J-WESTカード**: issuerが持つ未確定/確定利用明細、請求、返金、家族/追加カード明細
- **ICOCA**: SF残高、鉄道/物販利用、チャージ、定期券、ICOCA利用由来ポイント
- **e5489、tabiwa等**: 予約・きっぷledger。ポイント付与根拠にはなり得るが本sourceでは収集しない

支払、チャージ、送金・受取、出金、ポイント利用/交換/ICOCAチャージ、予約、カード・口座追加、eKYC、
profile/認証設定変更を行わない。WESTER ID、ICOCA/card/device ID、氏名、加盟店、token、cookie、OTP、
passkey material、実残高・実額を保存せず、security controlを回避しない。

J-WESTカード明細はポイント明細ではない。JCBブランドはMyJCB、Visa/Mastercardブランドは
MUFG Card / My Digital Connect系の別sourceを参照するだけとし、protocolを本docへ複製しない。
将来のrepository内参照先は [MyJCB family](./myjcb.md) と [MUFG Card](./mufg-card.md) とする。

## 2. 調査方法と公式URL

- JR西日本の公式portal、規約、guide、official app listingを一次sourceとして確認。
- 認証不要の公開page、response header、DNS CNAME、login HTML/JSをread-only観測。
- GitHubをofficial package ID、auth host、WESTER/Wesmo語で検索し、公開third-party clientを調査。
- account login、本人app起動、実データ取得、APK取得・decompile、network interceptionは未実施。

主要公式URL:

- [WESTERポイント](https://wester.jr-odekake.net/point/)
- [WESTERポイント規約](https://wester.jr-odekake.net/terms/point-kiyaku/)
- [WESTERポイント（チャージ専用）規約](https://wester.jr-odekake.net/terms/chargepoint-kiyaku/)
- [WESTER会員support/login](https://wester.jr-odekake.net/member/entrylog/)
- [WESTER Web会員登録・移行](https://wester.jr-odekake.net/service/member/)
- [WESTER Android app](https://play.google.com/store/apps/details?id=jp.co.westjr.wester&hl=ja)
- [J-WESTカードの利用代金明細](https://wester.jr-odekake.net/j-west/support/meisai/)
- [Wesmo!](https://wester.jr-odekake.net/wesmo/)
- [Wesmo! app guide](https://wester.jr-odekake.net/wesmo/user/guide/)
- [Wesmo!会員登録](https://wester.jr-odekake.net/wesmo/user/guide/register/)
- [Wesmo!チャージ](https://wester.jr-odekake.net/wesmo/user/guide/charge/)
- [Wesmo!送金・受取](https://wester.jr-odekake.net/wesmo/user/guide/send/)
- [Wesmo!会員規約](https://wester.jr-odekake.net/assets/pdf/wesmo/terms-member01.pdf)
- [Wesmo!資金決済法に基づく表示](https://wester.jr-odekake.net/assets/pdf/wesmo/money-policy01.pdf)
- [Wesmo! Android app](https://play.google.com/store/apps/details?id=jp.co.westjr.wesmo&hl=ja)
- [WESTERポイントをICOCAへチャージ](https://wester.jr-odekake.net/point/store-use/use-icoca/)
- [モバイルICOCA残高・利用履歴](https://www.jr-odekake.net/icoca/mobileicoca/use/history/)

## 3. 公式経路、粒度、期間、export

| 経路 | read範囲 | 粒度/state | 期間/件数/export | tradeoff |
| --- | --- | --- | --- | --- |
| WESTER portal会員support | point種別残高、付与・利用履歴、期限、紐づけICOCAのpoint履歴 | point event / expiry bucket | 通常pointの履歴期間・row上限・paginationは公開確認できず。CSV/PDF未確認 | Web bootstrap/replay候補。全サービス横断のpoint正本 |
| WESTER app | point残高/利用、キャンペーン、card ICOCA残高、ICOCA app/e5489等への導線 | mobile summary/detail | 履歴期間/件数/export未確認 | 広いfront doorでwrite/予約UIが隣接 |
| Wesmo! app | 出金可/不可残高、決済、charge、send/receive、出金、point利用/付与履歴 | wallet event、送金link/request state | 保持期間・最大件数・pagination・CSV/PDF未確認 | Wesmo!のprimary route。device-bound、多要素認証 |
| J-WEST issuer Web | card利用・請求・返金、家族/追加card | issuerのauthorization/請求event | MyJCBまたはMy Digital ConnectでPDF等 | 別source。WESTER ID/passwordと別credential |
| ICOCA app/member Web | SF残高、鉄道/物販/charge履歴 | ICOCA event | member Webは前日から26週、最大100件。明細/領収PDFは当日から1年前月初まで | ICOCA別source。WESTER point履歴と混ぜない |
| 券売機 | ICOCA SF履歴、ICOCA利用由来point履歴 | device/card上の直近event、月次point | SFは通常20件、係員は最大50件、26週まで。pointは前月から過去6か月を表示/印字 | cloud収集不可、manual evidence |

### WESTERポイント

公式は3種を明示する。

| 種別 | 有効期限 | 主な用途と収集上の注意 |
| --- | --- | --- |
| 基本 | 獲得年度の翌年度末（3月31日） | 店頭/Web、対象商品、ICOCA charge等。年度bucketを保持する |
| 期間・用途限定 | campaign/付与ごと | common期限を推測せず、表示expiryと利用可能scopeをevent/lotに保持する |
| チャージ専用 | 無期限 | ICOCA charge専用。ICOCAごとに付与対象履歴があり、通常pointと用途が異なる |

Wesmo!決済に関するpoint付与・利用履歴はWesmo! app、それ以外を含む横断履歴はWESTER portalで確認すると
公式FAQが案内する。同じWesmo!決済がwallet eventとpoint eventの双方に現れるため、`source_event_id`相当が
判明するまではtimestamp/merchant/amountだけで自動結合しない。

WESTERポイント（チャージ専用）規約は、会員support/ICOCA app/券売機で前月から過去6か月の付与pointと
対象利用履歴を月単位で確認できると定める。これはICOCA利用由来pointの範囲であり、WESTER全体のpoint履歴
保持期間を意味しない。通常/限定pointの履歴期間、明細列、pagination、exportはlive確認が必要。

### Wesmo!

残高は出金可/不可を別bucketにする。本人確認後の銀行口座・セブン銀行ATMchargeは出金可、credit card chargeや
出金不可残高の受取は出金不可となる。公式規約上、Wesmo!残高自体に有効期限はない。totalだけの保存では
送金・出金可否を失う。

規約は残高確認画面で利用可能残高と利用履歴を確認できるとし、公式campaignはapp履歴に記載された日時を判定に
使用する。最低限の候補schemaは `occurred_at/type/status/amount/balance_after/counterparty_or_merchant/
funding_bucket/point_delta` だが、公開情報から確認できた列ではなく、live UI/APIで確定すべき設計仮説である。

送金linkは作成から48時間、請求linkは2週間の期限がある。受取前の取消可能stateと受取後の確定stateがあるため、
link作成をsettled送金として計上しない。決済authorization/売上確定/取消/返金、charge失敗/取消の公式status名は
未確認。pending/settledを残高差から推測しない。履歴期間、件数、filter、pagination、CSV/PDF/printも未確認。

### J-WESTカード / ICOCAとの境界

J-WEST cardの請求額・利用明細はbrand Web serviceのledgerで、JCBはMyJCB、Visa/Mastercardは
My Digital Connect（旧案内にはMUFGカードWeb service表記）を使う。公式もWESTER credentialとは別と明記する。
WESTER側に現れる獲得pointはcard利用明細の代用にならず、1 card eventから複数point eventや後日訂正があり得る。

WESTER appが表示するcard ICOCA残高はconvenience view。ICOCA SF利用履歴・定期券・PDFはICOCA app/member Web、
ICOCA利用由来pointはWESTER側にも現れる別eventである。point→ICOCA chargeはpoint利用とICOCA入金の2 eventを生む
write操作であり、本検証では実行しない。Wesmo!とICOCAも別walletで、片方の残高を他方として扱わない。

## 4. 認証、MFA、passkey、Bitwarden

2026-08-26に公開loginを確認した事実:

- `wester.jr-odekake.net/member/entrylog/`は`https://auth.westjr.co.jp/web/v1/login`へ遷移する。
- ID/password loginは同originの`POST /web/v1/login/do_login`、passkey loginは
  `POST /web/v1/login/do_login_passkey`。CSRF fieldを伴うformであり、account read APIではない。
- 公開HTML/JSはWebAuthn conditional mediation、`userVerification: required`、RP ID
  `auth.westjr.co.jp`を示す。challenge/credential/assertion値は保存しない。
- 旧J-WEST会員移行ではemail宛one-time passwordが使われる。通常login時のOTP trigger条件、trusted device、
  session寿命、renewal/revocationは未確認。

Wesmo!はWESTER ID/passwordを基礎に、登録時のemail OTP（新規WESTER ID）、電話番号認証、場合によりlogin OTPを
使う。公式は多要素認証、登録電話番号からの発信認証、別device access時の再本人認証を明示する。2025-12-24の
更新後、app起動時等の端末passcode/biometric設定は任意になったが、device binding自体が消えたとはいえない。
eKYCは出金可能残高等のwrite/enrollment境界であり、collector bootstrapのために実施しない。

[Bitwarden公式](https://bitwarden.com/help/auto-fill-browser/)はbrowser extensionでWebAuthn passkeyを保存・利用できる。
したがってWESTER Web passkeyの候補providerにはなり得る。ただし、当該credentialがBitwardenに存在すること、
RP ID一致、conditional UIでの実動、Wesmo! app内WebView/native loginへの利用可否は未確認。これは互換性の推測で、
vault、password、passkey private material、OTPを収集基盤へ置く根拠ではない。本人browser/deviceでbootstrapし、
OTP/passkey/recovery/account lockが出たら自動化を停止する。

## 5. WAF / Akamai / public JS

2026-08-26のread-only観測で`wester.jr-odekake.net`と`auth.westjr.co.jp`はいずれも
`san-www.westjr.co.jp.edgekey.net`、さらに`*.akamaiedge.net`へCNAME解決し、Akamai edgeの利用を確認した。
portal公開pageはHTTP 200と`Server: nginx`、anonymous `XSRF-TOKEN`/`wester_session` cookie名、login responseは
`x-azure-ref`を返した。これは公開pathのedge/origin-chain evidenceで、Wesmo! app APIのhost/vendorやBot policyを
証明しない。公開GETでchallengeは出なかったが、認証後も同じとは限らない。

portal/Wesmo!公開pageのJSはstatic navigation、UI、analytics中心で、account balance/history endpointは確認できなかった。
login JSはWebAuthn assertionをbrowserで生成してform POSTする具体的transportを示す。public JS/source mapをさらに
静的解析することは調査対象だが、Akamai cookie/fingerprint/challengeの模倣や迂回はしない。401/403/429やchallengeを
API発見のために反復probeしない。

## 6. APK / deobfuscation / read-only runtime observation

official Android packageはWESTER `jp.co.westjr.wester`、Wesmo! `jp.co.westjr.wesmo`。APKは未取得で、app account
host/path/schema/tokenを公開listingから推測しない。次段階では本人所有端末/正規Google Playからbase/split APKを
取得し、package/version/signer/hashを記録したうえで次を行う。

1. `adb shell pm path`と`adb pull`でbase/splitを取得し、`apksigner`/`aapt2`/`apkanalyzer`でmanifest、signer、SDK、
   exported component、deep link、network security configを確認。
2. JADX/apktool、resource/DEX strings、Retrofit/OkHttp annotation、protobuf/JSON model、WebView bridge、native libraryの
   `strings`/`readelf`でhost/path、method、token store、renewal、pagination、device/integrity metadataを分類。
3. R8等の難読化はresource ID、call graph、serializer field、runtime stack/metadataで追う。存在しないmappingやsymbol名を
   捏造せず、deobfuscationの確度を記録。
4. 本人が既存の残高/履歴を開く1回だけ、端末の標準診断または明示proxyでhost/path/method/status/header名とredacted
   response key/typeを観測。支払/charge/send/point-use/booking controlには触れない。
5. certificate pinning、Play Integrity、root/emulator拒否等で観測不能なら解除/hook/bypassせず、障壁として記録する。

reverse engineeringは本sourceの調査対象である。ただしsecurity control bypassを目的にせず、得られたread routeを
write routeから機械的に隔離できる場合だけcollector候補にする。

## 7. third-party transport/auth

GitHubのpackage ID、auth host、WESTER/Wesmo/API語検索では、WESTER pointまたはWesmo! consumer残高/履歴を取得する
公開client、SDK wrapper、token renewal実装を確認できなかった。package ID hitは広告filter/app inventoryでtransport
evidenceにならない。Wesmo! package IDは該当なしだった。これは2026-08-26時点のnegative evidenceで、非存在の証明ではない。

具体的な公開third-party実装として、[asapoka/userscriptsのWESTER login userscript](https://github.com/asapoka/userscripts/blob/1371b4987a74ac6f4efb341386d10a4c948c9351/odekake.net/WESTER-login-westjr.co.jp.user.js)
のみ確認した。`auth.westjr.co.jp/web/v1/login*`上でID/password formへ値を入れbutton clickするUI automationであり、
balance/history transport、session renewal、read API clientではない。source内にcredential literalを置く設計なので採用しない。

現時点で確認できたconsumer transport/authは公式公開loginのHTTPS form POST + CSRF + passwordまたはWebAuthnのみ。
point/Wesmo read endpointのhost/path/method/schema、app token、refresh、device key、integrity metadataは未確認である。
公開実装がないことを理由に推測pathをprobeしない。

## 8. read/write隔離

- allowlistは観測済みのpoint balance/history/expiry、Wesmo! balance/history list/detailだけ。
- J-WEST card、ICOCA/e5489は別collectorへrouteし、本sourceのsessionで辿らない。
- point use/exchange/ICOCA charge、Wesmo! pay/charge/send/receive/withdraw、bank/card登録、eKYC、limit設定をdeny。
- booking/purchase/cancel、profile、email/phone/passkey/biometric設定、退会をdeny。
- login bootstrap POSTは本人操作の別境界。collectorに汎用POST、任意URL、deep link/intent、write scope tokenを持たせない。
- host/path/method/query/content-type/schemaとredirect先を固定。GETでも副作用が疑われるrouteはdenyする。
- raw response/token/ID/card/ICOCA/phone/merchant/counterparty/実額をlog、trace、crash dump、CI artifactへ出さない。
- 401/403/409/429、Akamai challenge、OTP/passkey/recovery、unknown redirect、schema/app version drift、
  device/integrity要求、PII redaction失敗で停止。

## 9. Runtime適性

| runtime | 適性 | 判断 |
| --- | --- | --- |
| owner browser/device | 最適 | passkey/OTP/電話発信bootstrap、official UI確認、redacted observation |
| Local WSL | 適 | public JS/APK static analysis、sanitized DOM/schema parser |
| Cloudflare Workers | 低〜条件付き | proven GET/token replayなら軽量。WebAuthn/Akamai/device bindingは不向き |
| Cloudflare Containers | 条件付き | browser/parserを隔離可能だがAndroid device trustは提供しない |
| OCI container | 条件付き | digest固定、secret store、read-only FS、egress allowlistでreplay候補を試験可能 |
| Kubernetes | 過剰 | CronJob/Secret/NetworkPolicyは可能だが単一会員collectorには運用cost過大 |
| Android実機 | Wesmo!調査に必須 | 正規app/device state。定常UI automationは更新とwrite UI隣接で脆い |

Workersへcredential/bootstrapを移さず、owner deviceで得たsource-scoped、短命、read-only相当sessionのrenewabilityが
実証された場合だけ検討する。full browserはContainers/OCI、app-only transportはAndroidを調査用に使い、K8sは
複数sourceを運用する段階まで採用しない。

## 10. PR #5共通 A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper、5 = device-bound/adversarial

| route | Level | Cost | 判定 |
| --- | ---: | ---: | --- |
| WESTER portal/appのmanual sanitized capture | E | 1-2 | 安全。履歴保持/exportは未確認 |
| Wesmo! app manual balance/history capture | E | 2 | official primary、残高bucketを保持。外部export未確認 |
| WESTER browser bootstrap + read replay | C候補 | 4 | 公開login transportは確認、read API/session renewalは未確認 |
| WESTER app bootstrap + API replay | C候補 | 5 | APK/host/token/device metadata未確認 |
| Wesmo! app bootstrap + API replay | C候補 | 5 | 多要素・電話発信・別device再認証・device binding |
| full app UI automation | D | 5 | write control隣接、app更新、端末認証で脆い |
| documented consumer/export API | A該当なし | 5 | 公開公式API/CSV/PDF exportを確認できず |

総合は **D/cost 5**、安全な既定は **E/cost 1-2**。WESTER Webで安定したread endpointとrenewable scoped sessionが
実証されればCからB候補へ、Wesmo!はdevice/integrity非依存が確認できるまでC候補に留める。

## 11. read-only live検証 / stop条件

1. 公式domain/package/version/signer、login RP/OTP/電話認証triggerだけを確認。秘密は本人入力し、保存しない。
2. WESTER portalで3種のbalance、lot別expiry、履歴列、最古日、期間filter、件数、pagination、detail、CSV/PDF controlを確認。
3. WESTER appは同一pointの表示差とICOCA convenience viewだけ確認。point利用、coupon、campaign entry、予約へ進まない。
4. Wesmo!で出金可/不可bucket、history type/status/timestamp、最古日、件数、pagination、detail、exportを確認。
5. 既存の送金link/取消/返金/失敗が自然に存在する場合だけstatus名を読む。新しいeventを作らない。
6. J-WEST card明細はbrand別source、ICOCAはICOCA sourceで確認し、WESTER point eventとの重複keyだけ設計する。
7. 正規split APKと公開JSを静的解析し、read/write host/path/token/device/integrity metadataを別表化。
8. 本人が既存残高/履歴を開く1回だけredacted network metadataを観測。unknown/write候補で停止。
9. replay候補は同一device/local hostで各1回。401/403/429やdevice/integrity bindingならcloud化を中止しmanualへ戻す。

stop: 支払/charge/send/receive/withdraw/point-use/ICOCA-charge/booking/cancel、bank/card/eKYC/profile設定、
OTP/passkey/recovery、電話発信要求、Bot challenge、pinning/attestation、unknown host/path/redirect、
POST/PUT/PATCH/DELETE（本人login bootstrap以外）、401/403/409/429、account lock、PII redaction失敗、schema drift。
security controlを無効化しない。

## 12. 事実・推測・未確認

**確認事実:** point 3種と期限、Wesmo!残高2種と残高/履歴画面、送金link/requestの期限・取消state、Wesmo!多要素・
電話発信認証・別device再認証、WESTER WebAuthn RPとlogin POST、Akamai edge、J-WEST issuer境界、ICOCA別履歴期間/export、
公開read client不在。

**推測:** WESTER/Wesmo! app内部にはbalance/historyのstructured read transportとpaginationがある。Bitwarden passkeyは
WESTER Webの候補providerになり得る。公開login sessionをaccount readへ安全にreplayできる可能性はあるが未実証。

**未確認:** WESTER通常/限定point履歴の期間・件数・export、Wesmo!履歴期間/件数/exportと全status、point/wallet APIの
host/path/schema/pagination、token renewal/revocation、device key/pinning/integrity、Bitwarden credential実適合、
WESTER appとportalのschema一致、event間のdedupe key、Cloudflare/OCI replay適性。
