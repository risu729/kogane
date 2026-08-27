# PRESTIA GLOBAL PASS read-only Worker PoC

GLOBAL PASS（Vpassデビット専用サイト）の15か月分のサーバーレンダリングHTMLを、Cloudflare ContainerのPlaywright Chromiumで取得し、private R2へ保存する独立PoCである。SMBCカード用VpassアプリAPIや`mnie`をruntime依存・設定源・submoduleとして使用しない。

## 実行構成

```text
Cloudflare Cron / authenticated POST
  -> Worker orchestration
  -> Container Playwright Chromium
  -> Container-local SOCKS5
  -> authenticated WebSocket relay on the Worker
  -> cf1:network VPC binding
  -> scraper専用 hostname route
  -> tamia cloudflared
  -> www.debit.vpass.ne.jp:443
```

WorkerはTLSを終端せず暗号化済みTCPを中継するため、宛先とのTLS handshakeはChromium自身が行う。relayは`www.debit.vpass.ne.jp:443`だけを許可する。Container側でも同hostとTurnstile以外のリクエストを中止する。

この2 host固定は、Kuebikoの成功captureで認証・明細の中核通信として確認できた最小集合をPoCの初期値にしたもので、完全なproduction asset inventoryの確定ではない。初回live runの前にsanitized HARからhostname集合を再抽出し、login/明細表示に必須の別CDN・認証assetがあればexact hostname単位で追加する。wildcard、request指定host、汎用TCP proxyには広げない。

`challenges.cloudflare.com`は既定ではhostname routeへ追加しない。2026-08-27のKuebiko検証ではSydney WARPからTurnstile tokenを生成してGLOBAL PASS loginでき、広範に共有されるTurnstile hostをtamiaへ固定する必要性は確認されていない。またこのhostをrouteへ加えるとGLOBAL PASS以外の個人WARP通信にも影響する。PoCはChromiumのproxy bypassでTurnstileだけContainerの通常egressへ出す。このIP分離でproduction tokenが拒否されるかは未検証なので、実ログイン時は次の順でA/Bする。

1. 既定: GLOBAL PASSだけtamia、TurnstileはContainer egress
2. 同一IPが必要と判明した場合だけ、scraper専用WARP profileの分離を確認してからTurnstile routeを追加

個人PC側は別device profileのLocal Domain Fallback（必要ならSplit Tunnel Exclude）でGLOBAL PASSを通常egressへ戻す。hostname route単体には「Worker由来だけ」という条件がないため、このprofile分離がデプロイ前提である。

## 取得と保存

- 日次Cron: 毎日21:15 UTC（日本時間06:15）に、現在月と直前月を再取得
- 手動`mode=backfill`: 画面のselectorが実際に提示した全月（検証時15か月）を1 sessionで取得
- private R2: `raw/prestia-globalpass/YYYY/MM/DD/<run-id>/activity-YYYY-MM.html`
- manifest: hash、byte数、画面が提示した月、部分失敗を記録

HTMLはContainerからNDJSONとして月ごとにstreamし、Workerは1件ずつR2へ保存する。全15か月をWorker memoryへまとめて載せない。pendingから確定への更新を取り込むため日次は2か月を上書きではなくrun単位でappendする。初回に`mode=backfill`を1回実行し、その後日次へ移る。

Workers Paidの15分枠内でContainer browserを1回起動して15ページを直列取得する設計で、現段階ではQueueを使わない。実測でtimeoutや部分再試行が必要になった場合のみ月単位Queueへ分割する。GitHub Actionsのscheduleは使わない。

WebSocket TCP relayは通常Workerの非hibernating接続である。Durable Object WebSocket Hibernationはclient側WebSocketを休止できても、対応するupstream TCP socketを復元できないため、このopaque tunnelをそのままhibernateする設計にはしていない。数分の1回の収集中にisolate・network・Tunnelが切れればrunは部分失敗または失敗になり、次回runで再取得する。15か月backfillの実測で中断が出る場合は、月単位Queue/短命relayへ分割する。

## Secret

- `GLOBALPASS_ID`
- `GLOBALPASS_PASSWORD`
- `ADMIN_TRIGGER_TOKEN`: `/trigger`専用
- `RELAY_TOKEN`: WebSocket relay専用

session cookie、Turnstile token、Nablarch hidden stateは保存・再利用せず、毎run新しいbrowser contextで取得する。資格情報JSON、secret、実データはGitへ入れない。ローカルの必要項目だけを同期する例:

R2、VPC、Container、通常varsの`Env`は`wrangler types`で生成する。remote secretは`wrangler.jsonc`にも生成型にも現れないため、`env.d.ts`は上記4 secret名だけをaugmentationし、値や他binding型は手書きしない。

```sh
scripts/sync-local-secrets.sh \
  ~/.local/share/kogane/secrets/globalpass.json
```

入力JSONは`{"username":"...","password":"..."}`だけを持つ。スクリプトは値を表示しない。

## 検証

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run deploy:dry
```

手動の日次相当と初回backfill:

```sh
scripts/trigger.sh daily
scripts/trigger.sh backfill
```

## 未検証ゲート

- Container Linux Chromiumが本番Turnstile tokenとlogin POSTを通過するか
- Turnstileを別egressにした状態でtokenが受理されるか
- login後の「ご利用明細」リンクと月selectorの現行DOM selector
- `select`のchange eventだけで月POSTが実行されるか（現PoCはその挙動を前提にする）
- 15か月の各HTMLが2 MiB以下か
- 家族カードlabel、pending/confirmed、authorization numberを正規化する安定key
- 非hibernating WebSocket relayが全15か月のbrowser sessionを安定して維持できるか

このPRではroute追加、Cloudflare deploy、credential POST、実データ取得を行わない。まずdry-runまで通し、上記selectorをKuebikoのsanitized captureと1回のbounded live runで校正してから初回backfillする。
