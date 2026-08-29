# PRESTIA GLOBAL PASS read-only Worker PoC

GLOBAL PASS（Vpassデビット専用サイト）のサーバーレンダリングHTMLを、Cloudflare ContainerのPlaywright Chromiumで取得し、private R2へ保存する独立PoCである。SMBCカード用VpassアプリAPIや`mnie`をruntime依存・設定源・submoduleとして使用しない。

2026-08-27にCloudflareへ実デプロイし、実アカウントでbounded live runまで実施した。Container Chromium/TAMIA経路とCloudflare Browser Run経路はいずれもGLOBAL PASSのログイン画面を200で取得できるが、Turnstile tokenを生成できず、認証情報のPOSTより前で停止する。そのため明細HTMLはまだ取得できていない。失敗を毎日繰り返さないようCronは無効化し、手動`/trigger`、認証付きの`/browser-probe`・`/container-probe`、診断情報だけを残している。

## 現在の実行構成

```text
authenticated POST /trigger
  -> Worker orchestration
  -> Container Playwright Chromium
  -> Container-local SOCKS5
  -> authenticated WebSocket relay on the Worker
  -> tunnel_idでTAMIA Tunnelを直接指定
  -> tamia cloudflared
  -> www.debit.vpass.ne.jp:443

Turnstile hosts
  -> Containerの通常internet egress

authenticated POST /browser-probe
  -> Cloudflare Browser Run Puppeteer
  -> Cloudflare egress（TAMIAは経由しない）
  -> GLOBAL PASS + Turnstile
```

WorkerはTLSを終端せず暗号化済みTCPを中継するため、GLOBAL PASSとのTLS handshakeはChromium自身が行う。relayは次の3 hostの443番だけを許可し、request指定の任意hostや汎用TCP proxyには広げない。

- `www.debit.vpass.ne.jp`
- `challenges.cloudflare.com`
- `brunhild.challenges.cloudflare.com`

VPC bindingは`network_id: "cf1:network"`ではなくTAMIAの`tunnel_id`を直接指定する。このWorkerだけがTAMIA Tunnelを使い、Zero Trustアカウントのhostname routeを追加しないため、個人PCのWARP通信には影響しない。Cloudflareの[VPC Network binding](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks/)と[Cloudflare Tunnel](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/)に沿った構成である。

## 取得・保存の予定

- 手動`mode=daily`: 現在月と直前月を再取得
- 手動`mode=backfill`: 画面のselectorが提示した全月を1 sessionで取得
- private R2: `raw/prestia-globalpass/YYYY/MM/DD/<run-id>/activity-YYYY-MM.html`
- manifest: hash、byte数、提示月、部分失敗を記録

HTMLはContainerからNDJSONとして月ごとにstreamし、Workerは1件ずつR2へ保存する。全月をWorker memoryへまとめて載せない。pendingから確定への更新を取り込むため、日次相当もrun単位でappendする。15分枠を超える実測が出た場合だけ月単位Queueへ分割する。GitHub Actionsのscheduleは使わない。

WebSocket TCP relayは非hibernating接続である。対応するupstream TCP socketを復元できないため、このopaque tunnelをDurable Object WebSocket Hibernationで休止させない。isolate・network・Tunnelが切れたrunは部分失敗として記録し、次回に再取得する。

## Secret

- `GLOBALPASS_ID`
- `GLOBALPASS_PASSWORD`
- `ADMIN_TRIGGER_TOKEN`: `/trigger`、`/browser-probe`、`/container-probe`、`/container-stop`専用
- `RELAY_TOKEN`: WebSocket relay専用

session cookie、Turnstile token、Nablarch hidden stateは保存・再利用せず、毎run新しいbrowser contextで取得する。資格情報JSON、secret、実データはGitへ入れない。remote secretは`wrangler.jsonc`にも生成型にも現れないため、`env.d.ts`は上記4 secret名だけをaugmentationする。

ローカルの必要項目だけを同期する例:

```sh
scripts/sync-local-secrets.sh \
  ~/.local/share/kogane/secrets/globalpass.json
```

入力JSONは`{"username":"...","password":"..."}`だけを持ち、スクリプトは値を表示しない。

## デプロイ済みリソース

- Worker: `kogane-globalpass-collector-poc`
- URL: `https://kogane-globalpass-collector-poc.takuanimal.workers.dev`
- Container app: `kogane-globalpass-collector-poc-globalpasscollectorcontainer`
- Container app ID: `a03ac341-52a7-4e81-9a7c-279a90cc4b0c`
- R2 bucket: `kogane-globalpass-collector-poc`
- Browser Run binding: `BROWSER`
- VPC binding: TAMIA Tunnel `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33`を直接指定
- Cron: blocker解消まで無効

`wrangler deploy`の完了後もContainer appのimage rolloutは非同期で続く。検証時は`wrangler containers info <app-id>`で新image digestとhealthy instanceを確認してから、新しいDurable Object IDで実行する。rollout前に実行すると旧imageを使い、コード不具合のように見えることがある。

## 2026-08-27 live verification

実アカウントを用いたbounded runの結果は次の通り。

1. `cf1:network`だけでは公開宛先の経路がなく、GLOBAL PASSで`ERR_CONNECTION_CLOSED`になった。
2. VPC bindingをTAMIAの`tunnel_id`直接指定へ変更すると、GLOBAL PASSのログイン画面、ID欄、Turnstile hidden inputまで正常に取得できた。`Access Denied`ではない。
3. `cf-turnstile-response`は45秒待っても空のままだった。認証情報の入力・ログインPOSTより前で停止した。
4. network diagnosticでは`brunhild.challenges.cloudflare.com`への失敗とtoken未生成が同時に観測された。この名前はAAAAだけを返し、検証時のTAMIA/home egressには利用可能なIPv6経路がなかった。
5. 同hostをTAMIA relayへ含めると`ERR_CONNECTION_CLOSED`、Container通常egressでは`ERR_ABORTED`になった。ただし後述のBrowser Runでは`brunhild`を一度も呼ばず、Turnstile本体との通信が全て200でもtokenが生成されなかったため、IPv6不足を原因とする仮説は棄却した。
6. Turnstile requestをWorker `fetch()`で代理する案も試したが、helperだけの分離では403、両Turnstile hostの代理でも`/turnstile/v0/api.js`が403になった。browser requestをWorker fetchへ置き換える迂回は採用しない。
7. R2には各runのfailure manifestだけがあり、`activity-YYYY-MM.html`は0件である。代表runは`1fe39ff7-a382-4786-a200-0908f57928ea`。

Cloudflare Containersの[outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)にはHTTP/HTTPSのallow/deny・Worker handler・通常internet egressがあるが、公開設定と現行Wrangler schemaには一般internet出口をIPv6へ切り替える項目がない。これはContainerの経路上の制約であり、今回のTurnstile失敗原因だとは断定しない。

## 2026-08-28 Browser Run verification

既存WorkerにBrowser Run bindingと管理token必須の`POST /browser-probe`を追加し、GLOBAL PASSに対して3回のbounded diagnosticを実施した。全runでTurnstile tokenが未生成だったため、ID/passwordの入力、GLOBAL PASSへのlogin POSTは一度も行っていない。

- ログイン画面はHTTP 200、titleは`ログイン`、formとTurnstile hidden inputが存在し、`Access Denied`ではない。
- network用User-Agent/Client HintsはWindows Chrome 153相当に設定したが、page JavaScriptからは`Cloudflare-Workers`、`Linux x86_64`、`navigator.webdriver=true`、`en-US`に見えた。
- `challenges.cloudflare.com/turnstile/v0/api.js`は302後にbuild版が200。challenge document、2回のXHR POST、imageも全て200だった。
- cross-origin challenge frameは存在したが、30秒後も`cf-turnstile-response`は0文字だった。
- `brunhild.challenges.cloudflare.com`へのrequest、HTTP 4xx/5xx、request failureはいずれも0件だった。
- Cloudflare公式仕様上、Browser RunのPuppeteer/CDP通信には削除不能な識別headerとWeb Bot Auth署名が付き、UA変更はbot protectionを回避しない。この環境だけで完全自動loginを実現できるという結果にはならなかった。

sanitizedな手順、観測値、推論と未確定事項は[`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md)に保存する。

同日、スタートメニューの`kogane capture`から新規起動した通常Chrome/Kuebikoでも同じlogin URLを比較した。資格情報は入力せず、login POSTも行っていない。

- HTTP 200、formあり、`Access Denied`なしはBrowser Runと同じだった。
- page JavaScriptからはWindows Chrome 153、`Win32`、`navigator.webdriver=false`、`en-US`に見えた。
- Turnstile APIは302後にbuild版200、challenge documentも200だった。
- `cf-turnstile-response`は約15秒以内に773文字になった。Browser Runは30秒後も0文字だった。
- structured CDP/Kuebiko metadata上、`brunhild.challenges.cloudflare.com`と対象hostの4xx/5xxはなかった。未使用CSS 1件だけ`ERR_ABORTED`だが、challenge failureはなかった。
- Kuebikoの生capture run `2026-08-27T21-46-51`はcookie等を含み得るためローカルだけに残し、Gitにはsanitized結果だけを保存した。

Kuebikoはremote debugging付きでも`navigator.webdriver=false`でtoken生成に成功した。CDP利用そのものより、Browser Runの`Cloudflare-Workers`/Linux/`webdriver=true` fingerprintと削除不能な識別headerが強い差分である。ただしKuebikoとBrowser Runのegressは同一ではないため、fingerprint単独原因とはまだ断定しない。

## 2026-08-28 Container browser A/B

GLOBAL PASSを同じTAMIA経路に固定し、Playwright Chromiumを`baseline`、`webdriver=false`、Windows相当fingerprint、headed、fresh persistent profileの順で1項目ずつ近づけた。5条件すべてでlogin pageは200、formあり、`Access Denied`なしだったが、30秒後もTurnstile tokenは0文字だった。共通してchallenge fetch 401、Brunhild 204直後の`ERR_ABORTED`が観測された。

追加で、Playwright公式の`channel: "chrome"`を使い、Containerへ導入したブランド版Google Chrome Stable `152.0.7977.64`でも同じ条件を実行した。login pageは200だったがtokenは0文字で、challenge fetch 401とBrunhild 204直後の`ERR_ABORTED`も変わらなかった。したがってPlaywright同梱Chromiumだけが失敗原因ではない。

資格情報の入力、login POST、cookie再利用、R2書き込みは行っていない。旧instance `v9`・`v10`はdestroy済み、Google Chrome検証instance `v11`はstop済みである。詳細な比較表は[`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md)、削除対象は[`docs/cleanup.md`](docs/cleanup.md)に記録した。

## 2026-08-29 same-egress / workaround verification

Cloudflare公式資料を再確認し、PAT endpointの401とBrunhild 204直後のERR_ABORTEDをroot causeとして扱った以前の推論を撤回した。PAT 401は通常fallbackであり、challenge関連subdomainの一部failureも単独では失敗を意味しない。一方、challenge取得とsolve送信のIPが異なると無効になり得るため、従来のsplit経路を最初に再検証した。

新しいbounded probeでは、親pageとTurnstileの全通信をTAMIAへ統一したrun、全通信をContainer直通にしたrun、従来のsplit runを実測した。TAMIA統一は223.223.22.214、JP/KIX、ASN 18144、HTTP/2、Container直通はSG/SIN、ASN 13335のIPv6 Cloudflare egressだった。split runではchallenge imageのHTTP 400も観測したためproductionでは避けるべきだが、同一出口に直してもtokenは生成されなかった。

同時にnative Linux Chrome、webdriver true/false、Patchright 1.62.2、Google Chromeを通常processとして起動して25秒後にだけCDP接続する条件、Chrome 152とversionを一致させたWindows UA・Client Hints・platform・languagesを試した。headed、fresh persistent profile、UA上書きなしも含む全10追加条件でtokenは0だった。資格情報入力、login POST、cookie再利用、R2書き込みは0回である。

## 2026-08-30 OCI `bots` Chrome verification

Cloudflare Containerの外でも比較するため、OCI ARM64 host `bots`に公式Google Chrome
Stable 152を残置し、Xvfb上のheaded ChromeをPlaywrightなしで実行した。通常のfresh
profile、local WSLで認証成功したprofileのcopy、SwiftShader WebGLを有効化した別fresh
profileの3条件すべてで、Sign On画面とTurnstile widgetは表示されたがtokenは0だった。
出口は`138.2.53.208`、JP/KIX、WARPなしで、pageからはnative Linux、
`navigator.webdriver=false`に見えた。token gateにより資格情報入力とlogin POSTは
0回である。導入物、profile、logは再検証用に削除していない。詳細と再実行scriptは
[`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md)を参照する。

Cloudflareも本番challengeに対するPlaywright、Selenium、Puppeteerを公式サポートしていないため、現時点ではこのbrowser方式をproduction collectorへ昇格させない。調査したPatchright、SeleniumBase Pure CDP、その他の第三者workaroundと採否理由はdocs/browser-run-investigation-2026-08-28.mdに集約した。

## 2026-08-29 local Windows / WSL profile A/B

同じ時刻帯に、ローカルWindows Chrome Beta 153とWSL Google Chrome 152で、
fresh profileと既存Kuebiko profileのcopyを比較した。4条件すべてで
`cf-turnstile-response`が生成され、formあり、`Access Denied`なし、
`navigator.webdriver=false`だった。token長はWindows copy 794、Windows fresh
752、WSL copy 773、WSL fresh 730である。token値、資格情報、login POSTは保存・
送信していない。

WSLはWindows profileをcopyしても成功したが、fresh profileも成功したため、
profile copyやDPAPIで保護されたWindows cookieが成功原因とはいえない。native
Linux Chromeもローカルでは通るので、Container失敗をLinux、fresh profile、
CDP利用のいずれか一つへ帰属させない。計測時のCloudflare traceはWindows/WSL
ともWARP有効、JP/NRTだった。詳細な手順と解釈は
[`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md)
に記録した。

続けて同じfresh WSL profileから資格情報を1回だけ送信した。Turnstile token長
730の状態でlogin POSTはHTTP 200となり、title `TOP`、login formなし、利用明細
導線ありへ遷移した。Access Denied、Turnstile error、credential errorはなかった。
したがってlocal WSLでは、手動操作やWindows偽装なしでtokenのserver-side
validationとログインまで自動化できる。明細取得はこのbounded runの対象外とした。

## 次に試す順序

1. GLOBAL PASSの公式mobile appや別の公式提供経路で、利用履歴を取得できるかを優先する。
2. browser routeを再開する場合、個人profile移送やWindows偽装より先に、Containerとlocal native Chromeのruntime・network identity差を測る。
3. split egressは採用せず、同一TAMIA出口または同一Container出口に固定する。
4. PAT 401やBrunhild 204後のabortを、それ単独でblockerと判断しない。
5. Cronはtoken生成、login POST、明細画面、月selectorの順にbounded testが成功するまで有効化しない。

いずれもtoken生成、ログインPOST、明細画面、月selectorの順にbounded testし、成功してから初回backfillと日次Cronを有効化する。

## ローカル検証

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run deploy:dry
```

手動実行:

```sh
scripts/trigger.sh daily
scripts/trigger.sh backfill
scripts/trigger.sh probe ~/.local/share/kogane/secrets/globalpass-worker-admin-token baseline
scripts/trigger.sh probe ~/.local/share/kogane/secrets/globalpass-worker-admin-token chrome-stable-headed-persistent-windows
scripts/trigger.sh probe ~/.local/share/kogane/secrets/globalpass-worker-admin-token patchright-chrome-native-all-tamia
scripts/trigger.sh probe ~/.local/share/kogane/secrets/globalpass-worker-admin-token chrome-direct-process-attach-late-direct
scripts/trigger.sh stop ~/.local/share/kogane/secrets/globalpass-worker-admin-token v14 stop
```

## 残る検証項目

- 通常Chromeと自動化ChromiumでTurnstileが選ぶchallengeとtoken生成条件の差
- login後の「ご利用明細」リンクと月selectorの現行DOM selector
- `select`のchange eventだけで月POSTが実行されるか
- 全月の各HTMLが2 MiB以下か
- 家族カードlabel、pending/confirmed、authorization numberを正規化する安定key
- 非hibernating WebSocket relayが全月のbrowser sessionを維持できるか
