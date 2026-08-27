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

## 結論

Browser RunはGLOBAL PASSのlogin pageとTurnstile challenge transportを正常に200で取得したが、tokenを完成できなかった。少なくとも今回のBrowser Run失敗は`brunhild.challenges.cloudflare.com`のIPv6到達性では説明できない。したがって「TAMIAにIPv6がないことが既知のblocker」という以前の推論は撤回する。

現時点で区別できない候補は次の通り。

- Browser Runと明示するheader/Web Bot Auth署名を含むbot判定
- `navigator.webdriver=true`、Linux、`Cloudflare-Workers`などのbrowser fingerprint
- challengeが対話または追加のbrowser signalを要求したが、headless probeが完了できなかった
- ContainerではGLOBAL PASSとTurnstileのegressが分離し、Browser Runでは全通信がCloudflare egressになるというnetwork identity差

Browser Run単独をproduction collectorへ採用する根拠は得られなかった。Containerではブランド版Google Chrome Stableを含む6条件すべてでtokenを生成できず、表面的なfingerprint調整やbrowser binaryの差し替えでは通常Chrome/Kuebikoとの差を埋められなかった。次はKuebiko成功runとContainer失敗runの送信元IPの直接確認を優先する。IPv6追加は成功runでも`brunhild`が必須だと確認できるまで優先しない。
