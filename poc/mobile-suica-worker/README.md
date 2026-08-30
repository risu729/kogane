# Mobile Suica read-only Worker PoC

JRE IDのパスキー認証を`kogane capture` Chromeで行い、Kuebikoが記録した
Mobile Suica専用セッションをCloudflare Workerへ引き渡して、SF履歴のraw
Shift_JIS HTMLと正規化JSONをprivate R2へ保存するPoCである。

## 2026-08-31 live validation

- `kogane capture`のChrome Beta 153からJRE IDパスキー認証に成功した。
- JRE IDのWebAuthn challengeはRP ID `id.jreast.co.jp`、
  `userVerification: required`、allowed credential 1件だった。
- Mobile Suica履歴は`POST /iq/ir/SuicaDisp.aspx`、Shift_JIS HTMLである。
- Cookieは`ASP.NET_SessionId`、`sc_auth`、`TS0184138d`の3種だった。
- 同じcaptureのCookieとform stateをWSLの通常Node `fetch`へ移し、Chromeを
  介さず200の履歴HTMLを取得できた。TLS fingerprintとChrome processへの
  bindingは、ログイン後の履歴読取には観測されなかった。
- Cloudflare本番Workerからも同じセッションで取得し、15行・1ページ、
  3 artifact、failure 0をprivate R2へ保存した。manifestとsummaryを再取得し、
  Cookie値、`baseVariable`、WebAuthn assertionが含まれないことを確認した。
- 日付検索は「指定日以前」、1ページ最大100件である。100件なら最古日の
  前日を次cursorにする。1日だけで100件に達した場合は完全性を証明できない。

## 収集物

```text
raw/mobile-suica/YYYY/MM/DD/<run-id>/sf-history-page-0001.html
raw/mobile-suica/YYYY/MM/DD/<run-id>/sf-history.json
raw/mobile-suica/YYYY/MM/DD/<run-id>/collection-summary.json
raw/mobile-suica/YYYY/MM/DD/<run-id>/manifest.json
```

HTMLとJSONには本人の交通・購買履歴、残高、金額が含まれる。R2 bucketはpublicに
しない。Cookie値、JRE ID、パスキー秘密鍵、WebAuthn assertionはartifact、ログ、
manifestへ書かない。raw HTMLには公式レスポンスの短命な`baseVariable`が残るため、
セッション失効前は認証素材と同等に扱う。Cookie値はWorker Secretのsource-scoped
session envelopeだけが持つ。

## ローカルbootstrap

Kuebikoを次のcapture機能付きで起動し、JRE IDログイン後にSF履歴を1回検索する。

```text
--capture-cookies --stream-bodies --snapshot-storage --track-storage
```

WSLから、captureを読んで権限600のsource-scoped envelopeを生成する。

```sh
node scripts/build-session-envelope.mjs \
  /mnt/c/Users/risu/AppData/Local/Kuebiko/captures/<run> \
  /tmp/mobile-suica-session.json

wrangler secret put MOBILE_SUICA_SESSION_JSON < /tmp/mobile-suica-session.json
wrangler secret put ADMIN_TRIGGER_TOKEN
```

envelopeはMobile Suica履歴以外に使うJRE ID情報、Bitwarden vault、password、
passkey private keyを含まない。

## 実行

日次Cronは21:10 UTC（日本時間06:10）で、サービス停止時間
00:50〜05:00 JSTを避ける。手動実行はBearer認証付きの
`POST /trigger?asOf=YYYY-MM-DD`である。

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
wrangler r2 bucket create kogane-mobile-suica-collector-poc
wrangler deploy
```

## 現時点の自動化境界

履歴読取自体はplain Worker `fetch`で動く。ただし、今回観測したMobile Suica
Cookieはsession cookie、JRE IDの`sid`系Cookieは`Max-Age=3600`である。画面側も
20分無操作で終了し、毎日00:50〜05:00にサービス停止するため、Cookie keepalive
だけでは日次完全自動化できない。

次の実装gateは、captureで確認したJRE IDの2段階WebAuthn API
（challenge取得、assertion送信）を専用passkeyで再現し、JRE ID bundle内の
Fingerprint2 2.1.5由来32桁hex fingerprintがplain Workerから受理されるかを
検証すること。これが通らない場合のみContainer Chromeをbootstrapに使う。

## resourceとcleanup

- Worker: `kogane-mobile-suica-collector-poc`
- R2 bucket: `kogane-mobile-suica-collector-poc`
- Cron: `10 21 * * *`
- Secrets: `MOBILE_SUICA_SESSION_JSON`, `ADMIN_TRIGGER_TOKEN`

削除時はR2 artifactを確認・退避してからWorker、bucketの順で削除する。
