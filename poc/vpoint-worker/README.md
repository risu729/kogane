# V Point Worker PoC

Vポイント本体の残高・期限bucket・SMBC由来内訳・最大3年の履歴を、認証済み
VポイントMy Page sessionでfirst-party JSON APIから取得し、raw responseとmanifestを
private R2へ保存するPoCである。VポイントPay、Vマネー、Vpass明細は別台帳のため含めない。

## Liveで確認したデータソース

2026-08-31、Kogane Capture Chromeのユーザー口座で次を確認した。値、加盟店、Cookie、
会員番号、個人情報はこのrepositoryへ保存していない。

- `POST https://mypage.tsite.jp/api/balance_info`
  - `results.common[]`: `point`, `expiration`, `point_type`
  - `results.store[]`: store限定の期限bucket
- `POST https://mypage.tsite.jp/api/tpoint_history`
  - multipart `page`, `get_graph`, `sort`と全履歴filter
  - live口座では`total=149`。page 1-4は各30件、page 5は29件、終端のpage 6は0件で、
    すべてHTTP 200 / application status `0000`を確認した。PoCはtotalへ達したpage 5で停止する。
- `POST https://mypage.tsite.jp/api/smfg_point`
  - `results.get_point.point_smbc`, `point_smcc`

`/api/tmoney_history`はVマネーであり、VポイントPayではないため呼ばない。

## 認証境界

My Page APIは未認証でもHTTP 200を返すが、application statusは`0010`となる。認証済みは
`0000`。現時点のPoCは`VPOINT_SESSION_COOKIE` Worker secretとして与えたCookie headerを使う。
Cookie値をsource、`.dev.vars`、log、R2、manifestへ保存しない。

Web画面のV会員番号はlogin後もmask表示だったが、上記APIは会員番号をrequest fieldとして
要求しない。そのためcollectorの入力にはV会員番号を含めない。

ログイン画面はCloudflare越しでも通常表示でき、APIも匿名curlへ`0010`を返すため、今回の
観測ではbot challengeが主障害ではない。一方、ID/passwordからのsession生成とsession寿命は
まだ再現できていない。このPoCを完全無人運用とみなさず、`0010`時はsession更新が必要である。

## 保存内容

各runは以下へ保存する。

```text
raw/v-point/YYYY/MM/DD/<run-id>/
  balance-info.json
  smfg-point.json
  history-page-0001.json
  ...
  collection-summary.json
  manifest.json
```

履歴は毎run、`filter_date`を空にして公開上限の最大3年を全page走査する。現在の149件なら
5 requestなのでQueueは不要である。

## 開発とデプロイ

```bash
bun install
bun test
bun run typecheck
bun run cf:check
```

必要なCloudflare resources/secrets:

- R2 bucket: `kogane-vpoint-collector-poc`
- secret: `VPOINT_SESSION_COOKIE`
- secret: `ADMIN_TRIGGER_TOKEN`
- Cron: `15 21 * * *`（毎日06:15 JST）

manual triggerは`POST /trigger`に`Authorization: Bearer <ADMIN_TRIGGER_TOKEN>`を付ける。
`GET /health`は秘密値や口座データを返さない。

## VポイントPayとapp archive

VポイントPayはプリペイドJPY残高・authorization・settlement・refund・chargeの別台帳で、
正本は`com.smbc_card.vpoint`アプリである。このWeb PoCではAPKを取得・decompileしていない。
将来app解析を行う場合、binary/decompiled/decrypted artifactは既存private Android archive
repositoryへ保存し、Koganeにはprovenance、hash、再現手順、sanitize済みのschemaだけを置く。
