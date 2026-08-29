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
`warp=off`だった。次の3条件はすべてSign On画面、login form、300x68のTurnstile
widgetを表示し、Access Deniedではなかったが、最大30秒待ってもtokenは0文字だった。

| profile / graphics | 結果 |
| --- | --- |
| OCI上のfresh persistent profile、Xvfb既定graphics | token 0。Chrome logでWebGL 1/2がblocklistされた |
| local WSLでtoken生成・認証POSTに成功したprofileのLinux-to-Linux copy | login状態は移送されずSign Onへ戻り、token 0 |
| OCI上の別fresh profile、ANGLE SwiftShader WebGLを明示的に有効化 | WebGL context生成をlogで確認したがtoken 0 |

この比較により、Containerだけの問題、Playwrightだけの問題、Linuxだけの問題、
profile履歴不足、XvfbでWebGLが無効という各単独仮説は棄却できる。local WSLと
OCIの差としてnetwork/ASN・host runtime・Cloudflareが観測するintegrity signalは
まだ分離できない。ただしOCIでprofileを移してsoftware WebGLまで有効化しても
tokenが生成されなかったため、OCI Kubernetesへ通常Chromeを移すだけでは
collectorを成立させられない。3 runとも資格情報入力とlogin POSTは0回である。

再実行には[`scripts/run-bots-globalpass.sh`](../scripts/run-bots-globalpass.sh)を使う。
既定では`/opt/kogane-globalpass-probe`配下のprofileとlogを保持し、終了時にChromeと
Xvfb processだけを停止する。今回のinstall、profile、logは比較用に削除せず保持した。

## 結論

2026-08-29の追加検証により、送信元IPはTAMIA統一とContainer直通の両方で直接確認できた。split解消、Brunhild到達可能な同一出口、Patchright、Chrome通常processの後付けCDP、Windows Chrome 152と整合させた表層fingerprintを個別・組合せで試してもtokenは0だった。したがって、Cloudflare Containers上のbrowser routeをproduction collectorとして追い続ける優先度は下げる。残る可能性は実Windows browser、正常利用履歴を持つprofile、または公開情報から観測できないbrowser/OS integrity signalだが、どれもserverless collectorの単純な構成から外れる。

ただし同日のlocal A/Bでは、fresh Windows、copied Windows、fresh WSL、
Windows profileをcopyしたWSLの全条件でtoken生成に成功した。この結果により、
「実Windowsまたは正常利用履歴profileが必須」という候補は弱くなった。native
Linux ChromeもローカルJP/WARP経路では成功するため、Containerとの差をLinux
OSだけで説明しない。

Browser RunはGLOBAL PASSのlogin pageとTurnstile challenge transportを正常に200で取得したが、tokenを完成できなかった。少なくとも今回のBrowser Run失敗は`brunhild.challenges.cloudflare.com`のIPv6到達性では説明できない。したがって「TAMIAにIPv6がないことが既知のblocker」という以前の推論は撤回する。

現時点で区別できない候補は次の通り。

- local WSLのJP/WARP経路と、OCI・Container各出口のIP/ASN reputation差
- OCI/Containerとlocal WSLのhost runtimeまたはCloudflareが観測するintegrity signal差
- Browser Run固有の識別header/Web Bot Auth署名を含むbot判定
- challengeが追加のbrowser signalを要求したが、OCI/Containerでは完了できなかった可能性

Browser Run単独をproduction collectorへ採用する根拠は得られなかった。Containerではブランド版Google Chrome Stableを含む各条件、OCIではPlaywrightなしの公式Chromeでもtokenを生成できず、表面的なfingerprint調整、browser binaryの差し替え、profile移送、software WebGLでは通常Chrome/Kuebikoとの差を埋められなかった。送信元はContainer直通、TAMIA、OCI、local WSLで直接記録済みだが、IP/ASNとhost runtimeを同時に変えているため両者はまだ分離できない。IPv6追加は成功runでも`brunhild`が必須だと確認できるまで優先しない。
