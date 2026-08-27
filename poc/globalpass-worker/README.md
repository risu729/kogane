# PRESTIA GLOBAL PASS read-only Worker PoC

GLOBAL PASS（Vpassデビット専用サイト）のサーバーレンダリングHTMLを、Cloudflare ContainerのPlaywright Chromiumで取得し、private R2へ保存する独立PoCである。SMBCカード用VpassアプリAPIや`mnie`をruntime依存・設定源・submoduleとして使用しない。

2026-08-27にCloudflareへ実デプロイし、実アカウントでbounded live runまで実施した。現在はGLOBAL PASSのログイン画面をTAMIA経由で取得できるが、Turnstile tokenを生成できず、認証情報のPOSTより前で停止する。そのため明細HTMLはまだ取得できていない。失敗を毎日繰り返さないようCronは無効化し、手動`/trigger`と診断情報だけを残している。

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
  -> Containerの通常internet egress（現状IPv6-only helperへ到達不可）
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
- `ADMIN_TRIGGER_TOKEN`: `/trigger`専用
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
- VPC binding: TAMIA Tunnel `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33`を直接指定
- Cron: blocker解消まで無効

`wrangler deploy`の完了後もContainer appのimage rolloutは非同期で続く。検証時は`wrangler containers info <app-id>`で新image digestとhealthy instanceを確認してから、新しいDurable Object IDで実行する。rollout前に実行すると旧imageを使い、コード不具合のように見えることがある。

## 2026-08-27 live verification

実アカウントを用いたbounded runの結果は次の通り。

1. `cf1:network`だけでは公開宛先の経路がなく、GLOBAL PASSで`ERR_CONNECTION_CLOSED`になった。
2. VPC bindingをTAMIAの`tunnel_id`直接指定へ変更すると、GLOBAL PASSのログイン画面、ID欄、Turnstile hidden inputまで正常に取得できた。`Access Denied`ではない。
3. `cf-turnstile-response`は45秒待っても空のままだった。認証情報の入力・ログインPOSTより前で停止した。
4. network diagnosticから`brunhild.challenges.cloudflare.com`が必要と判明した。この名前はAAAAだけを返し、検証時のTAMIA/home egressには利用可能なIPv6経路がなかった。
5. 同hostをTAMIA relayへ含めると`ERR_CONNECTION_CLOSED`、Container通常egressでは`ERR_ABORTED`になった。
6. Turnstile requestをWorker `fetch()`で代理する案も試したが、helperだけの分離では403、両Turnstile hostの代理でも`/turnstile/v0/api.js`が403になった。browser requestをWorker fetchへ置き換える迂回は採用しない。
7. R2には各runのfailure manifestだけがあり、`activity-YYYY-MM.html`は0件である。代表runは`1fe39ff7-a382-4786-a200-0908f57928ea`。

Cloudflare Containersの[outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)にはHTTP/HTTPSのallow/deny・Worker handler・通常internet egressがあるが、公開設定と現行Wrangler schemaには一般internet出口をIPv6へ切り替える項目がない。Workers VPCのIPv6指定はTunnelの向こう側にある宛先service用であり、Containerのpublic egressをIPv6化する設定ではない。

## 次に試す順序

1. TAMIAまたはscraper専用の最小egressに、`brunhild.challenges.cloudflare.com:443`へ到達できるIPv6を用意し、GLOBAL PASS・Turnstileの両方を同一browser/TAMIA経路に載せる。
2. インフラ変更を避ける場合はCloudflare Browser Renderingで、Turnstileだけのfetch代理ではなくログイン画面から同じfull browser sessionでA/Bする。
3. それでも通らなければ、OCI/Kubernetes上のdual-stack Chromiumを比較対象にする。

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
```

## 残る検証項目

- ChromiumがTurnstile tokenとlogin POSTを通過するか
- login後の「ご利用明細」リンクと月selectorの現行DOM selector
- `select`のchange eventだけで月POSTが実行されるか
- 全月の各HTMLが2 MiB以下か
- 家族カードlabel、pending/confirmed、authorization numberを正規化する安定key
- 非hibernating WebSocket relayが全月のbrowser sessionを維持できるか
