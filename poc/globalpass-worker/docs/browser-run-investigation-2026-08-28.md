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

## 結論

Browser RunはGLOBAL PASSのlogin pageとTurnstile challenge transportを正常に200で取得したが、tokenを完成できなかった。少なくとも今回のBrowser Run失敗は`brunhild.challenges.cloudflare.com`のIPv6到達性では説明できない。したがって「TAMIAにIPv6がないことが既知のblocker」という以前の推論は撤回する。

現時点で区別できない候補は次の通り。

- Browser Runと明示するheader/Web Bot Auth署名を含むbot判定
- `navigator.webdriver=true`、Linux、`Cloudflare-Workers`などのbrowser fingerprint
- challengeが対話または追加のbrowser signalを要求したが、headless probeが完了できなかった
- ContainerではGLOBAL PASSとTurnstileのegressが分離し、Browser Runでは全通信がCloudflare egressになるというnetwork identity差

Browser Run単独をproduction collectorへ採用する根拠は得られなかった。次は成功する通常Chrome/Kuebiko captureと、同じ項目を比較する。IPv6追加は成功runでも`brunhild`が必須だと確認できるまで優先しない。
