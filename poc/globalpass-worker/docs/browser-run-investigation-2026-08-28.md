# GLOBAL PASS Cloudflare Browser Run investigation

## 目的

Cloudflare Container ChromiumがGLOBAL PASSのTurnstile tokenを生成できなかったため、Cloudflare Browser Run（旧Browser Rendering）のfull Puppeteer sessionで同じログイン画面を開き、token生成とlogin可否をbounded testする。

これは2026-08-25に実施したSMBCカード用Vpass Browser Run probeとは別の検証である。前者は`www.smbc-card.com`のAkamai login POSTが403になった。今回は`www.debit.vpass.ne.jp`のCloudflare Turnstileを対象にする。

## 公式仕様から分かる制約

- Browser RunのPuppeteer/CDP sessionはCloudflare egressを使い、TAMIA Tunnelには接続しない。
- network User-Agentは変更できるが、UA変更はbot protectionを回避しない。
- Puppeteer/CDPのrequestには`cf-brapi-devtools`、`cf-biso-devtools`、Web Bot Auth署名などの削除不能な識別情報が付く。
- browserは必ず`finally`でcloseし、利用時間を残さない。

References:

- [Puppeteer on Browser Run](https://developers.cloudflare.com/browser-run/puppeteer/)
- [Automatic request headers](https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/)
- [Browser Run limits and session cleanup](https://developers.cloudflare.com/browser-run/limits/)

## 実装

既存の`kogane-globalpass-collector-poc` Workerへ次を追加した。

- Browser Run binding `BROWSER`
- 管理token必須の`POST /browser-probe`
- Windows Chrome 153相当のnetwork User-Agent、Client Hints、`ja-JP` Accept-Language、1365x768 viewport
- hostname、正規化済みpath、method、resource type、HTTP statusだけを返すnetwork diagnostic
- Turnstile tokenが20文字を超えた場合だけID/passwordを入力し、login buttonを1回clickするgate

credential、cookie value、request/response body、Turnstileの動的識別子は返さない。challenge pathは`<redacted>`へ正規化する。

## Bounded live result

2026-08-28 AESTに3回実行した。追加診断のためrunを分けたが、全runでTurnstile tokenが未生成だったため、資格情報の入力とGLOBAL PASSへのlogin POSTは0回である。

| 項目 | 観測値 |
| --- | --- |
| GLOBAL PASS login page | HTTP 200 |
| title / form | `ログイン` / formあり |
| Access Denied | false |
| cookies | `JSESSIONID`、`TS01dfe944`の名前だけ確認 |
| page JavaScript UA | `Cloudflare-Workers` |
| platform / webdriver / language | `Linux x86_64` / `true` / `en-US` |
| Turnstile API | 302からbuild版200 |
| challenge document | 200 |
| challenge XHR POST | 2回、どちらも200 |
| challenge image | 200 |
| cross-origin challenge frame | あり |
| `cf-turnstile-response` after 30s | 0文字 |
| `brunhild.challenges.cloudflare.com` | requestなし |
| HTTP 4xx/5xx / request failure | なし |
| credential POST | なし |

## 通常Chrome/Kuebikoとの比較

2026-08-28 AESTに、スタートメニューの`kogane capture`から新規起動したKuebikoプロファイルで同じGLOBAL PASS login URLを開いた。capture runは`2026-08-27T21-46-51`（UTC）で、Kuebiko 1.3.0がnetlog、response metadata、body、storageをローカルに保存した。生captureにはcookie等が含まれ得るためGitには入れず、以下のsanitized観測値だけを残す。資格情報は入力せず、login POSTも行っていない。

| 項目 | Cloudflare Browser Run | 通常Chrome/Kuebiko |
| --- | --- | --- |
| login page | HTTP 200 / `ログイン` | HTTP 200 / `Sign On` |
| form / Access Denied | formあり / false | form 1件 / false |
| page JavaScript UA | `Cloudflare-Workers` | Windows Chrome 153 |
| platform | `Linux x86_64` | `Win32` |
| `navigator.webdriver` | `true` | `false` |
| language | `en-US` | `en-US`（languagesには`ja`も含む） |
| Turnstile API | 302後にbuild版200 | 302後にbuild版200 |
| challenge document | 200 | 200 |
| `cf-turnstile-response` | 30秒後も0文字 | 約15秒以内に773文字 |
| challenge frame | 30秒後も存在 | token観測時にはiframeなし |
| `brunhild.challenges.cloudflare.com` | requestなし | structured CDP/Kuebiko metadata上はrequestなし |
| HTTP 4xx/5xx / request failure | なし | 4xx/5xxなし。未使用CSS 1件が`ERR_ABORTED`、challenge failureなし |
| credential/login POST | なし | なし |

Kuebiko側はremote debugging port付きのChrome Betaだが、`--enable-automation`は使わず、pageからは`navigator.webdriver=false`に見えた。つまりCDP接続や通信capture自体がTurnstile token生成を妨げるわけではない。一方Browser Runはnetwork headerのUAをWindows Chrome 153相当にしても、page JavaScript fingerprintとCloudflareが付与する削除不能header/Web Bot Auth署名は通常Chromeにならない。

この比較は「Browser Run固有のbrowser identityが失敗要因」という仮説を強くするが、IP/egressは完全には分離していない。clientから確認できた`150.48.6.170`はGLOBAL PASS側の接続先IPであり、Kuebikoの送信元IPではない。KuebikoはローカルWARP/hostname routeの影響を受け得る一方、Browser RunはCloudflare egress固定なので、この1比較だけでbrowser fingerprintを単独原因とは断定しない。

## Container browserの段階的A/B

同日、Cloudflare ContainerのGLOBAL PASS通信を全runで同じTAMIA Tunnel経路に固定し、browser側だけを1段階ずつ変更した。Turnstileの2 hostはContainerの通常internet egressを使う。各runはログイン画面を1回開き、tokenを最大30秒待つだけで、資格情報の入力、login POST、cookieの再利用、R2への書き込みは行っていない。

| variant | 追加した条件 | page上の主な観測値 | token |
| --- | --- | --- | --- |
| `baseline` | なし | Linux / HeadlessChrome 151 / `webdriver=true` / `ja-JP` | 0文字 |
| `webdriver-false` | AutomationControlledを無効化 | Linux / HeadlessChrome 151 / `webdriver=false` / `ja-JP` | 0文字 |
| `windows` | Windows Chrome 153 UA・Client Hints・platform・languages | Win32 / Chrome 153相当 / `webdriver=false` / `en-US` | 0文字 |
| `headed-windows` | Xvfb上のheaded Chromium | 上記Windows情報、headed | 0文字 |
| `headed-persistent-windows` | fresh profileのpersistent context | 上記Windows情報、headed、persistent | 0文字 |
| `chrome-stable-headed-persistent-windows` | 実行binaryだけをブランド版Google Chrome Stableへ変更 | Google Chrome 152.0.7977.64、上記Windows情報、headed、persistent | 0文字 |

全runでlogin pageはHTTP 200、formあり、`Access Denied`なしだった。Turnstile APIは302からbuild版200、challenge documentは200、XHR POSTは2回とも200、imageも200だった。一方で共通してchallenge fetchが401、`brunhild.challenges.cloudflare.com`が204の直後に`net::ERR_ABORTED`となり、tokenは完成しなかった。最初の5 runはChromium `151.0.7922.34`、6 run目はブランド版Google Chrome `152.0.7977.64`である。Windows variantではいずれもJS/Client Hints上だけChrome 153に見せている。

このA/Bから、`navigator.webdriver`、表面的なWindows UA/platform/language、headless、fresh persistent context、Playwright同梱Chromiumのいずれか一つを直すだけでは不十分と分かった。ブランド版Chromeでもchallenge fetch 401とBrunhild 204直後の`ERR_ABORTED`は変わらなかった。persistent contextは保存済みの信頼履歴を持つprofileではないため、「過去の正常利用履歴が必要か」は未検証である。また、Linux上のChrome 152にWindows Chrome 153の値を返させているため、TLS、GPU、font、codec、OS固有APIなどとの不整合は残る。

次に価値があるのは、JS property patchを増やすことではなく、Kuebiko成功runとContainer失敗runの送信元IPを直接確認してnetwork identityを分離することである。その次に、Windows偽装なしのnative Linux Chrome、Chrome 152と一致させたClient Hints、保存履歴のあるprofileの順で比較する。今回作成したContainer instance `v10`は後にdestroyし、Google Chrome検証用の`v11`は検証後にstopした。

## 2026-08-29 公式仕様による訂正

この節は上にある2026-08-28時点の原因推定を上書きする。Cloudflareの一次資料を再確認し、過去の診断を次のように訂正した。

- Private Access Token requestの401は、端末がPATを提示できない場合の通常のfallbackであり、それ自体はchallenge失敗を意味しない。
- challenges.cloudflare.com配下の一部request failureは、challengeの内部制御として発生し得る。Brunhildの204直後のERR_ABORTEDだけをroot causeにはできない。
- challengeを取得したIPとsolveを送るIPが変わると、solveが無効になる場合がある。従来PoCはGLOBAL PASSをTAMIA、TurnstileをContainer直通に分けていたため、最初に同一出口化すべきだった。
- CloudflareはPlaywright、Selenium、Puppeteerなどの自動化browserで本番challengeを解くことを公式サポートしていない。以下のprobeは採用保証ではなく、原因を切り分けるbounded diagnosticである。

References:

- [Challenge solve issues](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/)
- [How Challenges work](https://developers.cloudflare.com/cloudflare-challenges/concepts/how-challenges-work/)
- [Supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)
- [Turnstile client-side error codes](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/)

diagnostic path sanitizerも変更し、動的pathを漏らさずにPATだけはcdn-cgi/challenge-platform/redacted/pat/redactedと分類できるようにした。console本文は保存せず、Turnstileの6桁error codeと大分類だけを返す。今回のrunでは明示的な6桁error codeは出なかった。

## 2026-08-29 追加A/B

親pageとTurnstileを同一TAMIA出口へ統一した条件、全通信をContainer直通にした条件、従来のsplit条件を比較した。すべてGoogle Chrome Stable 152.0.7977.64、headed、fresh persistent profileである。各runはtokenを最大30秒待つだけで、資格情報入力、login POST、cookie再利用、R2書き込みは0回である。

| variant | browser側差分 | egress | token |
| --- | --- | --- | --- |
| chrome-stable-no-ua-all-tamia | native Linux、webdriver=false | 全通信TAMIA | 0 |
| chrome-stable-no-ua-all-tamia-default-automation | Playwright既定、webdriver=true | 全通信TAMIA | 0 |
| patchright-chrome-native-all-tamia | Patchright 1.62.2 | 全通信TAMIA | 0 |
| chrome-direct-process-attach-late-all-tamia | Chromeを通常process起動、25秒後だけCDP接続 | 全通信TAMIA | 0 |
| chrome-stable-windows-matched-all-tamia | Windows/Chrome 152 UA・Client Hints・platformを一致 | 全通信TAMIA | 0 |
| chrome-stable-no-ua-direct | native Linux、webdriver=false | 全通信Container直通 | 0 |
| patchright-chrome-native-direct | Patchright 1.62.2 | 全通信Container直通 | 0 |
| chrome-direct-process-attach-late-direct | Chromeを通常process起動、25秒後だけCDP接続 | 全通信Container直通 | 0 |
| chrome-stable-windows-matched-direct | Windows/Chrome 152 UA・Client Hints・platformを一致 | 全通信Container直通 | 0 |
| chrome-stable-no-ua-split | native Linux、webdriver=false | 親page=TAMIA、Turnstile=直通 | 0 |

TAMIA統一runの送信元は223.223.22.214、国JP、Cloudflare colo KIX、ASN 18144、HTTP/2と確認した。Container直通runは国SG、colo SIN、ASN 13335、IPv6のCloudflare egressだった。split runでは親pageの確認endpointはTAMIAを示した一方、Turnstileは直通であり、challenge imageがHTTP 400になったrunがある。これはsplitを避ける根拠になるが、同一出口に直してもtokenは生成されなかった。

TAMIA統一ではBrunhildがERR_CONNECTION_CLOSED、Container直通では204後にERR_ABORTEDだった。しかし両経路ともtoken 0であり、公式資料上も後者は単独のfailure signalではない。PAT endpointは全runで401だったが、これも通常fallbackとして扱う。

### 既存workaround実装の調査

subagentを分け、Cloudflare一次資料と各実装の公開READMEを相互確認した。

1. PatchrightはPlaywright API互換で、Runtime.enableやConsole.enable、既定flagなどautomation signalを減らすと説明している。実際にGoogle Chrome channel、headed、viewport null、UA上書きなしで試したがtoken 0だった。これは第三者実装の主張であり、Cloudflare公式の通過保証ではない。
2. SeleniumBase Pure CDP Modeは、WebDriver接続を切ってChromeのCDP操作へ寄せる実装である。ただし今回、それより介入の少ない「Chromeを通常processとして25秒動作させ、後からCDP接続」が失敗したため、追加実行の優先度を下げた。
3. puppeteer-real-browser、rebrowser-patches、puppeteer-extra stealth、undetected-chromedriver、Camoufoxも候補として確認した。いずれも第三者の検知回避実装で、公式サポート外であり、Patchrightと通常Chrome processの双方が失敗した後に依存を増やす根拠は得られなかった。
4. profile再利用は技術的には可能だが、今回作れるのは失敗challengeを見ただけのfresh profileであり、正常利用履歴の再現にならない。個人Chrome profile/cookieをContainerへ持ち込む方式はsecret管理と失効管理を悪化させるため、このPoCでは採用しない。

References:

- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)
- [SeleniumBase Pure CDP Mode](https://github.com/seleniumbase/SeleniumBase/blob/master/examples/cdp_mode/ReadMe.md)
- [Playwright Google Chrome channel](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)
- [Playwright browser launch arguments](https://playwright.dev/docs/api/class-browsertype)

## 2026-08-29 local Windows / WSL profile A/B

「正常利用履歴のあるWindows profileが必要」「Linux Chromeでは通らない」
という仮説を分けるため、同じ時刻帯のローカルWindowsとWSLで4条件を
比較した。GLOBAL PASS login URLを1回開き、CDPのread-only
`Runtime.evaluate`でtokenの**長さだけ**を確認した。資格情報の入力、login
POST、token値の保存・出力は行っていない。全runをKuebikoでcaptureし、生の
captureはcookie等を含み得るためGitには入れない。

計測には[`scripts/probe-local-turnstile.mjs`](../scripts/probe-local-turnstile.mjs)
を使用した。Node.js 22以降で`node scripts/probe-local-turnstile.mjs <CDP port>`
として実行する。scriptはtoken本文を返さず、長さと非機密のpage状態だけを出す。

| OS / Chrome | profile | token | page上の観測 |
| --- | --- | ---: | --- |
| Windows / Chrome Beta 153 | 既存Kuebiko profileの同一Windows内copy | 794 | `Win32`、`webdriver=false`、formあり、Access Deniedなし |
| Windows / Chrome Beta 153 | 完全なfresh profile | 752 | 同上 |
| WSL / Google Chrome 152 | Windows Kuebiko profileをWSL ext4へcopy | 773 | `Linux x86_64`、`webdriver=false`、formあり、Access Deniedなし |
| WSL / Google Chrome 152 | 完全なfresh profile | 730 | 同上 |

計測時のCloudflare traceはWindowsがIPv6、WSLがIPv4だったが、どちらも
WARP有効、`loc=JP`、`colo=NRT`だった。これはGLOBAL PASS originが同じ値を
見たことの証明ではなく、ローカル経路のcontrol情報としてのみ記録する。

Windows fresh profileは初回の`chrome://intro/`を表示したため、CDPの
`/json/new`で対象URLを新規tabに開いた。WSL fresh profileではKuebikoの
launch wrapperが最初のCDP待機に失敗したが、同じprofileをChromeの通常process
として起動するとCDPが公開され、Kuebikoを後からattachできた。したがって、
このwrapper failureはTurnstile rejectionとして数えない。

Windows profileをLinuxへcopyしてもtokenは生成されたため、少なくとも
Turnstile表示までにはWindows DPAPIで復号可能なcookieは必須ではなかった。
さらにfresh WSLでも成功したため、今回の成功をprofile copyや過去の正常利用
履歴へ帰属できない。Linux OS、fresh profile、CDP接続のいずれもローカル環境では
単独blockerではない。Cloudflare Containerでの失敗との差として残るのは、
Container/browser automation固有のidentity・integrity signal、runtime、network
経路などであり、Windows偽装や個人profile移送を先にproduction設計へ入れる根拠は
なくなった。

### Fresh WSL profileでの認証POST

同じfresh WSL profile、Google Chrome 152、WARP JP/NRTの条件で、保存済みの
GLOBAL PASS資格情報を1回だけ入力した。送信直前のTurnstile token長は730だった。
`POST /p/login/RW1312010101;jsessionid=<redacted>`はHTTP 200となり、遷移後は
title `TOP`、login formなし、利用明細導線ありになった。Access Denied、
Turnstile error、credential errorは観測されなかった。これにより、local WSLでは
token生成だけでなくserver-side validationと認証POSTまで自動実行できることを
確認した。明細画面への遷移やデータ取得はこのrunでは行っていない。

再実行用の[`scripts/probe-local-login.mjs`](../scripts/probe-local-login.mjs)は、
資格情報をstdinの1行JSONから読み、値を出力しない。結果の動的session IDも
`<redacted>`へ置換する。raw Kuebiko captureにはcookieやPOST由来の機密情報が
含まれ得るためGitへ入れない。

## 2026-08-30 OCI `bots` official Chrome control

Cloudflare Container固有のruntimeとOCI上の通常Chromeを分けるため、既存SSH host
`bots`（OCI ARM64）へ公式Google Chrome Stable 152.0.7977.64 ARM64、Xvfb、
Noto CJK fontとNode.js 24.20.0を導入し、headed Chromeを直接起動した。
`--enable-automation`、headless、Playwrightはいずれも使用せず、pageからは
`navigator.webdriver=false`、native `Linux x86_64`として見えた。CDPはtokenの
長さと非機密なpage状態を読むためだけに使用した。

OCIの通常internet出口は`138.2.53.208`、`loc=JP`、`colo=KIX`、HTTP/2、
`warp=off`だった。次の4条件はすべてSign On画面、login form、300x68のTurnstile
widgetを表示し、Access Deniedではなかったが、最大30秒待ってもtokenは0文字だった。

| profile / graphics | 結果 |
| --- | --- |
| OCI上のfresh persistent profile、Xvfb既定graphics | token 0。Chrome logでWebGL 1/2がblocklistされた |
| local WSLでtoken生成・認証POSTに成功したprofileのLinux-to-Linux copy | login状態は移送されずSign Onへ戻り、token 0 |
| OCI上の別fresh profile、ANGLE SwiftShader WebGLを明示的に有効化 | WebGL context生成をlogで確認したがtoken 0 |
| OCI上の別fresh profile、SwiftShader、全browser通信を既存Worker relay経由でTAMIAへ固定 | token 0 |

最後の条件はTailscaleを使用していない。Cloudflare Tunnel経由の`ssh bots`は
`forward_tcpip`を許可しないため、SSH reverse SOCKSは接続時点で拒否された。
代わりに既存PoCのhost allowlist付きWebSocket/TCP relayを再利用し、OCI localhostに
一時SOCKS5 adapterを起動した。browserが使うproxy経路は別の`/egress` requestで
`223.223.22.214`、JP/KIX、ASN 18144、HTTP/2と確認した。adapterはrelay tokenを
stdinからmemoryへ読むだけでfileへ保存せず、run後に停止した。script、dependency、
profileとlogは保持した。

この比較により、Containerだけの問題、Playwrightだけの問題、Linuxだけの問題、
profile履歴不足、XvfbでWebGLが無効という各単独仮説は棄却できる。local WSLと
OCIの差としてnetwork/ASN・host runtime・Cloudflareが観測するintegrity signalは
まだ分離できない。ただしOCIでprofileを移し、software WebGLを有効化し、さらに
生OCI出口からTAMIA出口へ変更してもtokenが生成されなかったため、OCI Kubernetesへ
通常Chromeを移すだけではcollectorを成立させられない。4 runとも資格情報入力と
login POSTは0回である。

再実行には[`scripts/run-bots-globalpass.sh`](../scripts/run-bots-globalpass.sh)を使う。
既定では`/opt/kogane-globalpass-probe`配下のprofileとlogを保持し、終了時にChromeと
Xvfb processだけを停止する。TAMIA比較用のlocalhost SOCKS adapterは
[`scripts/run-bots-tamia-socks.mjs`](../scripts/run-bots-tamia-socks.mjs)であり、relay
tokenをstdinから受け取る。今回のinstall、profile、dependency、logは比較用に削除せず
保持した。

## 2026-08-30 local WSL same-runtime network A/B

network reputationとserver runtimeを分離するため、同じ時刻帯、同じlocal WSL、同じ
Google Chrome Stable 152.0.7977.64、完全なfresh profile、1365x768 windowで、出口だけを
変えた。どちらもheadless、Playwright、`--enable-automation`を使わず、pageからは
native `Linux x86_64`、`navigator.webdriver=false`に見えた。CDPはtokenの長さと
非機密なpage状態を読むためだけに使った。

| local WSL Chromeの出口 | profile | token | page状態 |
| --- | --- | ---: | --- |
| local WARP、`104.28.211.106`、JP/NRT | fresh | 752 | Sign On、form/widgetあり、Access Deniedなし |
| host allowlist付きWorker relay経由のTAMIA、`223.223.22.214`、JP/KIX、ASN 18144 | fresh | 794 | 同上 |

TAMIA runはTailscaleを使わず、[`scripts/run-bots-tamia-socks.mjs`](../scripts/run-bots-tamia-socks.mjs)
をWSL localhostで起動し、GLOBAL PASSと2個のTurnstile hostだけを既存Worker relayへ流した。
別のallowlist済み`/egress` requestでTAMIA IP/ASNを確認してからChromeへ
`--proxy-server=socks5://127.0.0.1:11080`を渡した。両runともtoken値、資格情報、login POST、
cookie値を保存・送信していない。Chromeと一時SOCKS processはrun後に停止し、profileと
Chrome logだけをローカルに保持した。

このA/Bにより、TAMIAのIP、ASN、KIX経路またはIPv4であることはtoken未生成の十分条件では
ない。同じTAMIA出口でlocal WSLは成功し、Cloudflare ContainerとOCI `bots`は失敗したため、
両server環境の失敗をnetwork reputationだけでは説明できない。少なくともhost/runtimeまたは
Cloudflareが観測するbrowser/OS integrity signalの差が必要であり、networkとの相互作用が
残る可能性はあっても「TAMIAだから常に失敗する」という仮説は棄却する。

### Xvfb control

同じlocal WSL、Chrome 152、fresh profile、TAMIA出口を保ち、表示先だけをWSLgから
`Xvfb :98 -screen 0 1365x768x24 -nolisten tcp`へ変更した。headless、Playwright、
`--enable-automation`、SwiftShader強制flagは使っていない。結果はtoken 794、Sign On、
form/widgetあり、Access Deniedなし、native `Linux x86_64`、`navigator.webdriver=false`
だった。資格情報入力とlogin POSTは0回である。

Chrome logではWebGL 1/2がblocklistされたが、それでもtokenは生成された。したがって、
Xvfb、physical displayなし、WebGL unavailableのいずれも単独blockerではない。OCI `bots`
でも同じXvfb geometryを使い、SwiftShader有効化の有無にかかわらずtoken 0だったため、
local WSLとserver環境の残差はdisplay serverやWebGLより下のhost/container runtime、
browser buildの実行環境、Cloudflareが観測するintegrity signalへさらに絞られる。

### WSL native / local Docker image A/B

Cloudflare Containersのlocal developmentはCloudflare本番Container bindingへのremote接続
ではなく、local Docker Engine上のsimulationである。このため本番runtimeの同一再現とは
扱わず、deploy imageのuserlandとDocker境界をWSL host上で分離する比較として実施した。

再buildによるdriftを避け、Cloudflareへdeploy済みの現行image digest
`sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c`
（local tag `kogane-globalpass-collector-poc-globalpasscollectorcontainer:cd80a6ee`）をそのまま
使った。variantはGoogle Chromeを直接spawnし25秒後までCDP attachしない
`chrome-direct-process-attach-late-all-tamia`で、資格情報入力とlogin POSTは全runで0回である。

| 同一WSL host上の条件 | token | 解釈 |
| --- | ---: | --- |
| native Chrome、fresh profile、Xvfb、TAMIA | 794 | current successful control |
| 上記へ`--no-sandbox --disable-dev-shm-usage`を追加 | 794 | Container用flagは単独blockerではない |
| exact image、0.25 CPU / 1 GiB | 0 | Cloudflare `basic`相当 |
| exact image、resource制限なし | 0 | CPU/memory starvationは単独blockerではない |
| exact image、UID/GID 1000 | 0 | root実行は単独blockerではない |
| exact image、host network | 0 | Docker bridge network namespaceは単独blockerではない |

hostとimage内のChromeはどちらもGoogle Chrome Stable `152.0.7977.64-1`であり、実体
`/opt/google/chrome/chrome`のSHA-256は同じ
`44bd90e776ea03a952242b3536d4a10a2e43c64a227c243af2840f07f1f0ed17`だった。したがって
表示versionだけでなくChrome executable byte差も除外できる。両者の`LANG`は`C.UTF-8`、
pageはnative Linux、`navigator.webdriver=false`、Sign On/formあり、Access Deniedなしだった。

以前の2026-08-27 local Docker試行は旧imageの`/health`到達前後にWSLが
`Wsl/Service/E_UNEXPECTED`となり、Turnstile `/probe`を一度も呼べていなかったため、この
A/Bの既実施結果には数えない。今回初めてexact deploy imageでtoken gateまで完了した。

この結果はCloudflare固有runtimeが原因だと証明するものではない。むしろlocal WSLだけで
native成功 / Container失敗を再現できたため、次はimage内のfont/fontconfig、speech voices、
locale data、D-Bus/audio、Chrome同梱外shared libraryを小さく比較する。PID namespaceは
browser JavaScriptから直接観測しにくいため後順位とする。Cloudflare instance type変更は、
local unlimited imageも失敗した現時点では優先しない。

## 2026-08-30 browser-visible環境差分

同一WSL host上でtokenを生成できるnative Google Chromeと、tokenを生成できなかったexact
deploy image内Chromeを、GLOBAL PASSへ接続しないlocalhost診断pageで比較した。両方とも
Chrome 152、Xvfb `1365x768x24`である。raw font/canvas/audio値はGitへ入れず、差分の
集計だけを残す。

| 項目 | WSL native | exact image | 比較 |
| --- | --- | --- | --- |
| timezone | `Asia/Tokyo` | `UTC` | 差あり |
| font files / families | 155 / 32 | 50 / 20 | 差あり |
| font metrics | baseline | Latin 16/20、CJK/emoji 20/20候補で差 | 差あり |
| `enumerateDevices()` | audio input 1 / output 1 | すべて0 | 差あり |
| UA / platform / languages | Linux Chrome 152 / `en-US,en` | 同一 | 一致 |
| `navigator.webdriver` | `false` | `false` | 一致 |
| CPU / memory / screen / DPR | 16 / 16 GiB / 1365x768 / 1 | 同一 | 一致 |
| speech voices / codec / plugins | baseline | 同一 | 一致 |
| standard canvas / OfflineAudioContext hash | private comparison | 同一 | 一致 |
| WebGL | unavailable | unavailable | 一致 |

hostのfont directoryと`/etc/fonts`をread-only bind mountし、ephemeral cacheを更新すると、
Containerのfamily数とdefault font matchはhostと一致した。しかし同じChrome/TAMIA条件の
tokenは0のままだった。font family集合とfontconfig defaultの差は単独root causeではない。
rendering libraryやmetric差一般を否定する試験ではない。

## 2026-08-30 timezone controlled A/B

現行exact image `cd80a6ee`、digest
`sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c`
を再buildせず、Chrome 152.0.7977.64、Xvfb、fresh profile、25秒後CDP attach、全通信TAMIA
を固定してtimezoneだけを変更した。各runで資格情報入力とlogin POSTは0回である。

| timezone条件 | Chrome Intl timezone | token | 結果 |
| --- | --- | ---: | --- |
| image default | `UTC` | 0 | 失敗control |
| `TZ=Asia/Tokyo` + `/etc/localtime` mount | `Asia/Tokyo` | 794 | formあり、Access Deniedなし |
| `TZ=Asia/Tokyo` envだけ | `Asia/Tokyo` | 794 | 同上 |

`/etc/localtime` mountは不要で、Container環境変数だけで0文字から794文字へ変化した。同一
image、Chrome、display、profile種別、TAMIA経路のcontrolled A/Bではtimezone不一致が
必要十分な失敗要因だった。native Chromeへ`TZ=UTC`を設定する逆向き試験は行っておらず、
別version/sitekeyを含む全環境へ一般化しない。

Worker Container classへ`envVars = { TZ: "Asia/Tokyo" }`を設定した本番deployでも、
`chrome-direct-process-attach-late-all-tamia`とcollector相当の
`chrome-stable-no-ua-all-tamia`がともにtoken 794を生成した。後者のegressは
`223.223.22.214`、JP/KIX、ASN 18144、HTTP/2で、Chrome 152.0.7977.64、formあり、
Access Deniedなしだった。PAT 401とBrunhildの`ERR_CONNECTION_CLOSED`は残ったが、2段階の
challenge POSTは200でtoken生成に成功したため、これらは単独blockerではない。

## 2026-08-30 Camoufox control

[Camoufox](https://github.com/daijro/camoufox)の現行構成として
`cloverlabs-camoufox==0.6.0`、official prerelease Firefox `152.0.4-beta.29`、real Windows
fingerprint、`ja-JP`、uBlock Originなしを試した。fresh installのPlaywright 1.62.0は
Jugglerの`Browser.setDefaultViewport` schema errorとなり、[issue #653](https://github.com/daijro/camoufox/issues/653)
と同じversion skewだったためPlaywright 1.60.0へpinした。

WSL nativeと、現行deploy imageをbaseにしたnon-root Docker/Xvfbの両方でHTTP 200、
login form/widgetあり、Access Deniedなし、`navigator.webdriver=false`となり、tokenは709文字
だった。出口はいずれもTAMIAで、資格情報入力とlogin POSTは0回である。これはContainer境界
一般が拒否されたわけではないことを示す独立controlである。ただし通常Chromeもtimezoneだけで
成功したため、Camoufoxはproduction依存へ追加せず、将来のregression時の第2候補とする。

Camoufox一時venv/browser/profile、Docker image
`kogane-camoufox-probe-20260830:one-shot`、container、一時script、relay portは削除・停止済みで、
registry pushはしていない。共有BuildKit cacheは他buildへ影響するためpruneしていない。

## 2026-08-30 production collection progression

最初のreal `daily`はHTTP 502だったが、管理者認証付き`GET /latest-manifest?date=YYYY-MM-DD`
を追加して、同じloginを再実行せずR2のfailure manifestを回収した。旧collectorがheadless
bundled Chromium、ephemeral context、GLOBAL PASSだけTAMIA・Turnstileは別出口という古い
条件を使っており、probeの成功条件と一致していなかったことが原因だった。

実collectorをheaded Google Chrome Stable、fresh persistent profile、全通信TAMIAへ統一した。
固定Container IDはapp image更新後も旧instance/imageを再開し得たため、runtime revisionを応答へ
付け、新しいDurable Object identityへ切り替えて実行世代を検証する。`timezone-collector-v2`では
Turnstileとlogin POSTが成功し、失敗点は`GLOBAL PASS activity link was not found after login`まで
進んだ。これはAkamai/Turnstile/IP rejectionではなく、英語表示のログイン後画面に対して日本語の
「ご利用明細」だけを探していたselector不一致である。

保存済みの成功Kuebiko captureを再利用し、値を出力せずDOM routeだけを確認すると、利用明細は
Nablarchの`/p/statementInquiry/RW...`へPOSTするlinkだった。`timezone-collector-v4`でこの
read-only path prefixを優先selectorにした。app image rollout完了後、新しいContainer identity
`v18`でruntime revisionがv4であることとtoken 794を確認してからE2Eを実行した。

`daily` run `93e226f7-30e3-4c94-9270-5b71536539b6`はHTTP 200、status `success`、
available months 15、2026-08と2026-07のHTML 2件、failure 0だった。続く初回`backfill` run
`f218329f-764e-4fe1-938e-abc5accfba1f`もHTTP 200、status `success`で、2025-06から
2026-08まで15件を約65秒でR2へ保存し、failure 0だった。各HTMLは27,720〜70,958 bytesで
2 MiB上限内だった。資格情報、cookie、Turnstile token値、HTML本文はlogやGitへ入れていない。

bounded dailyとbackfillが成功したため、Workers Cronを`17 18 * * *`（03:17 JST）で1日1回
有効化する。GitHub Actions scheduleは使わない。固定identity `v18`を通常運用に使い、image更新時は
appのactive digestが切り替わってから新しいidentityを採番する。

## 結論

2026-08-29までの失敗は、TAMIAのIP、IPv6不足、Xvfb、WebGL、Linux、Docker、root、
CPU/memory、Chrome binary、Playwright/CDP、fresh profileのいずれか単独では説明できなかった。
2026-08-30のcontrolled A/Bで、exact imageのbrowser timezoneが`UTC`であることを特定し、
`TZ=Asia/Tokyo`だけで通常Chrome Containerのtokenを0から794へ変えられた。Cloudflare本番でも
同じ結果を再現し、さらに実アカウントのlogin POSTまで成功した。

したがって、GLOBAL PASSの第一候補はCloudflare Container + Google Chrome Stable + Xvfb +
fresh persistent profile + source専用TAMIA allowlistである。Windows偽装、個人profile copy、
Camoufox、Patchright、Browser Runは現行経路に不要である。CamoufoxはDocker内でもtokenを生成
できたため、通常Chromeの将来regression時のcontrolとしてのみ残す。

PAT 401、Brunhild abort、TAMIAのIPv6不足は、成功runでも観測され得るため単独blockerとして
扱わない。Browser Run単独もtokenを完成できなかったため採用しない。残る作業はbot回避ではなく、
英語/日本語のlogin後DOM、月selector、HTMLサイズ、R2保存を確定する通常のcollector実装である。
Cronはdailyとbackfillのend-to-end成功を確認するまで無効のままにする。
