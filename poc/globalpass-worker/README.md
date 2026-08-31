# PRESTIA GLOBAL PASS read-only Worker PoC

GLOBAL PASS（Vpassデビット専用サイト）のサーバーレンダリングHTMLを、Cloudflare ContainerのPlaywright Google Chromeで取得し、private R2へ保存する独立PoCである。SMBCカード用VpassアプリAPIや`mnie`をruntime依存・設定源・submoduleとして使用しない。

2026-08-30に、Cloudflare Containerのtimezoneを`Asia/Tokyo`へ合わせるだけでTurnstile token生成を再現し、実アカウントのlogin、daily、15か月backfillをend-to-endで完了した。HTMLとmanifestはprivate R2へ保存済みで、Workers Cronを1日1回だけ有効化している。GitHub Actionsのscheduleは使わない。手動`/trigger`と認証付きの`/browser-probe`・`/container-probe`・`/latest-manifest`は運用診断用に残す。

## Runtime profile

- **Browser: 全収集区間。** 通常のdaily/backfillはCloudflare Container内のheaded Google Chrome StableをPlaywrightで起動する。
- browserの目的はTurnstile token生成、公式JavaScript login、server-rendered明細の表示、利用可能月selectorによる月切替である。login後にWorker `fetch`へ切り替えず、明細HTMLまで同じbrowser sessionで取得する。
- Worker側のBrowser Run bindingは認証付き`/browser-probe`専用の診断経路であり、production collectionには使わない。Worker本体はContainer orchestration、TAMIAへのopaque relay、NDJSON受信、R2保存を担当する。

## 現在の実行構成

```text
authenticated POST /trigger
  -> Worker orchestration
  -> Container Playwright Google Chrome Stable
  -> Container-local HTTP CONNECT proxy
  -> authenticated WebSocket relay on the Worker
  -> tunnel_idでTAMIA Tunnelを直接指定
  -> tamia cloudflared
  -> www.debit.vpass.ne.jp:443

GLOBAL PASS + Turnstile hosts
  -> 同じTAMIA出口へ固定

authenticated POST /browser-probe
  -> Cloudflare Browser Run Puppeteer
  -> Cloudflare egress（TAMIAは経由しない）
  -> GLOBAL PASS + Turnstile
```

WorkerはTLSを終端せず暗号化済みTCPを中継するため、GLOBAL PASSとのTLS handshakeはChromium自身が行う。Container内ではNode.js標準HTTP serverの`connect` eventでChromeのCONNECT要求を受け、`ws.createWebSocketStream()`のbackpressure付きstreamへ接続する。Worker側のVPC relayとContainer側の両方で、次のproduction 3 host（および出口診断用Worker host）の443番だけを許可し、request指定の任意hostや汎用TCP proxyには広げない。

- `www.debit.vpass.ne.jp`
- `challenges.cloudflare.com`
- `brunhild.challenges.cloudflare.com`

Container runtimeはNode.jsを維持する。Bun 1.4.0では`ws.createWebSocketStream()`が`Not supported yet in Bun`となることを境界テストで確認した。Google Chromeが起動時間とresource使用の大半を占めるこのContainerではBunへ替える実利が小さく、Bun native WebSocket/TCP APIへの書き換えは手動のqueue・backpressure制御を再導入するため、現時点では採用しない。Bunはpackage managerと既存test runnerとして引き続き使用する。

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
- `ADMIN_TRIGGER_TOKEN`: `/trigger`、`/browser-probe`、`/container-probe`、`/container-stop`、`/latest-manifest`専用
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
- Container上限: 2（通常収集は固定ID 1個、image rollout時の旧instance退避用に1枠）
- R2 bucket: `kogane-globalpass-collector-poc`
- Browser Run binding: `BROWSER`
- VPC binding: TAMIA Tunnel `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33`を直接指定
- Cron: `17 18 * * *`（毎日03:17 JST、Workers Cron）

現行Containerは`TZ=Asia/Tokyo`を起動環境へ明示し、Google Chrome StableをXvfb上のheaded persistent contextとして起動する。GLOBAL PASS、Turnstile本体、helperを同じTAMIA出口へ固定する。NRT Gateway診断variantを含む現行imageはdigest `sha256:195ebaa959f2676e08e8c6d40335b5984e64e36e905efc957a4061070835e6b1`、runtime revision `timezone-collector-v6`である。v6はContainer-local relayを独自SOCKS5からNode.js HTTP CONNECTへ置換しただけで、通常collectorのbrowser条件はv4から変更していない。

timezone修正後に出口だけを変えたcontrolled A/Bでは、Container直通（SG/SINのCloudflare IPv6 egress）は2回ともlogin pageがHTTP 200でもTurnstile token 0、同時刻の全通信TAMIA controlはtoken 794だった。したがって現行productionはTAMIA固定を維持する。詳細は[`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md)に記録した。

追加のCloudflare Gateway診断では、WorkerをTokyo近傍へplacementし、`cf1:network`経由でJP/NRTのCloudflare IPv6 egressを実現した。NRTは2回ともtoken 0だったが、直後のTAMIA controlもtoken 0になったため、短時間の連続challengeまたは時系列変動が交絡している。通常collectorはTAMIAのままとし、NRT variantは十分な間隔を空けた再検証専用に残す。

現行Worker versionは`2abc1133-83db-4c8d-b593-c82ec8ca4dcf`で、deploy出力上もschedule `17 18 * * *`を確認した。

daily/backfillはR2へのmanifest保存を含む処理の成否にかかわらず、最後にephemeralな固定Container instanceへ`destroy()`を送る。破棄要求自体の失敗は収集結果へ混ぜず、構造化logへ記録する。`30s`のidle timeoutも残すが、relay使用後は`stop()` RPCがoutcome `ok`でもinstanceが`running`のまま残ることをlive確認したため、課金停止は`destroy()`で保証する。

2026-08-30のdeploy後daily run `8d498b19-dda5-4dfb-84b6-1239c4d9e765`は約52秒でstatus `success`、2026-08と2026-07のHTML 2件、failure 0だった。ただし同runの`stop` RPCがoutcome `ok`、app状態が`assigned: 0`でも、後のinstance一覧では`v18`が`running`だった。Chromium A/B rollout時にこの差を発見して旧`v18`を明示destroyし、収集後処理を`destroy()`へ変更した。

修正後daily run `251bbae4-007c-4d91-b7e5-9b4385656285`もruntime v5、status `success`、HTML 2件、failure 0だった。R2 manifest保存直後に`globalpass-collection-container-destroyed`が記録され、Wranglerのinstance一覧でも`v18`が`inactive`になったことを確認した。

HTTP CONNECTへ置換したruntime v6は、新しいidentity `v19`でbounded probeを実行し、GLOBAL PASS HTTP 200、Turnstile token 794文字、TAMIA JP/KIX出口を確認した。続くdaily run `8101b4c8-170d-400a-9e27-7823dce9cf28`は約42秒でstatus `success`、利用可能15か月を検出し、2026-08と2026-07のHTML 2件、failure 0だった。`/latest-manifest`から同じmanifestを再取得し、instance一覧でも`v19`が`inactive`になったことを確認した。

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
profile、同じOCI Chromeを既存Worker relayでTAMIA出口へ固定した条件のすべてで、
Sign On画面とTurnstile widgetは表示されたがtokenは0だった。
出口は`138.2.53.208`、JP/KIX、WARPなしで、pageからはnative Linux、
`navigator.webdriver=false`に見えた。TAMIA比較時のbrowser出口は
`223.223.22.214`、JP/KIX、ASN 18144だったが結果は変わらなかった。token gateにより
資格情報入力とlogin POSTは0回である。導入物、profile、dependency、logは再検証用に
削除していない。詳細と再実行scriptは
[`docs/browser-run-investigation-2026-08-28.md`](docs/browser-run-investigation-2026-08-28.md)を参照する。

続けてlocal WSLの同じGoogle Chrome 152を使い、fresh profileを2個作って出口だけを
同時刻帯に比較した。WARP JP/NRT (`104.28.211.106`)ではtoken 752、既存Worker relay経由の
TAMIA JP/KIX (`223.223.22.214`, ASN 18144)ではtoken 794となり、どちらもSign On、form、
widgetあり、Access Deniedなしだった。資格情報入力とlogin POSTは0回である。同じTAMIA
出口でlocal WSLは成功し、ContainerとOCIは失敗したため、TAMIAのnetwork reputationは
単独root causeではない。server host/runtimeまたはbrowser/OS integrity signalを次の
主要差分として扱う。

さらにlocal WSLの表示先だけをWSLgからXvfb (`1365x768x24`)へ変更した。TAMIA出口、
fresh profile、通常Chrome 152、`webdriver=false`のままtoken 794を生成した。Chrome log
ではWebGL 1/2がblocklistされていたため、XvfbとWebGL unavailableも単独root causeでは
ない。server環境固有のhost/container runtimeまたは公開されないintegrity signalへ焦点を
移す。

Cloudflareへdeploy済みの現行Container image digest
`sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c`
を再buildせず、local WSLのDocker Engineでも実行した。通常Chromeを直接起動して25秒後
までCDP attachしない`chrome-direct-process-attach-late-all-tamia`を使い、Cloudflare
`basic`相当の0.25 CPU / 1 GiBとresource制限なしの両方でtokenは0だった。対して同じ
WSL hostでnative Chromeを起動するとtoken 794であり、Containerと同じ
`--no-sandbox --disable-dev-shm-usage`を追加しても794だった。hostとimage内のChromeは
version `152.0.7977.64`、package、実体`/opt/google/chrome/chrome`のSHA-256まで一致した。
さらにimageをUID 1000で実行した条件と`--network=host`条件もtoken 0だった。これにより、
CPU/memory、2起動flag、Chrome binary、root、Docker bridge networkを各単独root cause
から除外し、image内のfont・speech/locale・shared libraryなどbrowser-visible userland差を
次の比較対象とする。local ContainerはCloudflare本番runtimeではなくDocker上のlocal
simulationなので、この結果をCloudflare固有host signalの再現とは扱わない。

同じChrome、Xvfb、TAMIA条件でTurnstileのOOPIFとworkerへCDPでattachし、成功WSLと
失敗OCIの2段階POST、response body、compile済みscript sourceを比較した。両方とも
84,236-byte `api.js`は同一だったが、session-specific `rch` runtime、2本目POST、2本目
responseは異なった。特に2本目responseは成功4,288 bytes、失敗127,724 bytesで、両方
HTTP 200だった。runtimeは標準WebCryptoではなくcustom bytecode VMとbitwise codecで
API名とpayloadを実行時に解決している。確認できたAPI語彙、難読化解除手順、safe analyzer、
targeted breakpointの限界は
[`docs/turnstile-local-analysis.md`](docs/turnstile-local-analysis.md)に記録した。raw body、
cookie、challenge IDはGitへ入れていない。

2026-08-30のtimezone A/Bでこの結論は更新した。通常Chrome Containerでもtokenを生成できるため、browser方式をPoCの第一候補として継続する。調査したCamoufox、Patchright、SeleniumBase Pure CDP、その他の第三者workaroundと採否理由はdocs/browser-run-investigation-2026-08-28.mdに集約した。

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

1. 英語表示を含むlogin後の利用明細導線と月selectorをbounded live runで確定する。
2. `daily`で現在月・前月のHTMLとmanifestがR2へ保存されることを確認する。
3. `backfill`はdaily成功後に1回だけ実行し、提示された15か月を保存する。
4. split egressは採用せず、GLOBAL PASSとTurnstileを同一TAMIA出口へ固定する。
5. PAT 401やBrunhild abortを、それ単独でblockerと判断しない。
6. Cronはtoken生成、login POST、明細画面、月selector、R2保存の順にbounded testが成功するまで有効化しない。

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
scripts/trigger.sh stop ~/.local/share/kogane/secrets/globalpass-worker-admin-token v19 stop
scripts/trigger.sh manifest ~/.local/share/kogane/secrets/globalpass-worker-admin-token 2026-08-29
```

## 残る検証項目

- login後の「ご利用明細」リンクと月selectorの現行DOM selector
- `select`のchange eventだけで月POSTが実行されるか
- 全月の各HTMLが2 MiB以下か
- 家族カードlabel、pending/confirmed、authorization numberを正規化する安定key
- 非hibernating WebSocket relayが全月のbrowser sessionを維持できるか
