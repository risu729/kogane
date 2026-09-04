# Mobile Suica read-only Worker PoC

JRE IDのパスキー認証からMobile SuicaのSF履歴保存までを、Cloudflare
Workerで日次実行するPoCである。BitwardenはWorkerから参照しない。認証情報を
更新したときだけ、所有者がWSLでBitwardenをunlockし、必要なJRE ID credential
だけを`JRE_ID_CREDENTIAL_JSON` Worker Secretへコピーする。

日次実行は次の経路だけを使う。

1. Worker Secretからsource-scoped JRE ID credentialを読む。
2. Cloudflare Browser Renderingを起動し、CDP virtual authenticatorへcredentialを
   一時的に登録する。
3. 公式Mobile Suica入口からJRE IDへ遷移し、画面自身のFingerprint/Fraud Defense
   処理とWebAuthn ceremonyを実行する。
4. 会員メニューの「SF（電子マネー）利用履歴」をクリックし、履歴画面の短命な
   Cookieと`baseVariable`をWorker内部だけで受け取る。
5. plain Worker `fetch`で履歴を1ページだけ取得する。HTMLをparseした後、唯一の
   `baseVariable`を`__KOGANE_REDACTED_BASE_VARIABLE__`へ置換し、CP932へ再encodeした
   sanitized HTML、正規化JSON、summary、manifestをprivate R2へ保存する。
6. manifest保存直後にService Binding経由で中央raw-evidenceへimportする。

Bitwarden vault、master password、`BW_SESSION`、JRE ID password、Cookie、raw
WebAuthn assertionはR2、ログ、manifest、Gitへ保存しない。

## 2026-08-31 live validation

- WSLの`bw` CLIが返した`id.jreast.co.jp`用P-256 credentialをローカルで署名検証した。
- `bw:sync`でusername、RP ID、credential ID、user handle、counter、PKCS#8 private
  keyだけをsource-scoped Worker Secretへコピーした。
- Worker上のcrypto検査はES256、16-byte credential ID、37-byte authenticator data、
  flags `0x1d`、counter 0で成功した。
- plain WorkerとTAMIA VPC経由の直接JRE APIは、どちらもWebAuthn challenge前の
  `AUTH_FS2`で`CO-AT5000`になった。成功captureのFingerprint値をコピーしても
  変わらず、IPだけでは解決しなかった。この失敗経路は実行系から削除した。
- Browser RenderingはJRE challenge `CO-SC0001`を受け、virtual authenticatorが
  assertionを返し、Mobile Suica会員メニューへ復帰した。
- 会員メニューの`StartApplication`はURL GETではなく、JavaScriptが生成するPOSTを
  使う。成功経路は`POST /ka/lg/SuicaChangeTransfer.aspx`から
  `POST /iq/ir/SuicaDisp.aspx`へ進む。
- Browserから得たsessionをplain Worker fetchへ引き継ぎ、15件・1ページ・3 artifact・
  failure 0をprivate R2へ保存した。R2 manifestを再取得して保存完了も確認した。

## 収集物

```text
raw/mobile-suica/YYYY/MM/DD/<run-id>/sf-history-page-0001.html
raw/mobile-suica/YYYY/MM/DD/<run-id>/sf-history.json
raw/mobile-suica/YYYY/MM/DD/<run-id>/collection-summary.json
raw/mobile-suica/YYYY/MM/DD/<run-id>/manifest.json
```

HTMLとJSONには本人の交通・購買履歴、残高、金額が含まれる。R2 bucketはpublicに
しない。保存するHTMLは`baseVariable`を固定sentinelへ置換済みであり、元の値をR2へ
保存しない。Cookie、passkey、WebAuthn assertionも保存しない。

日付検索は「指定日以前」で、1ページ最大100件である。v2は1ページだけを取得し、
100件未満ならcomplete success、100件ちょうどなら3 artifactを保存した上で
`partial` / `history_boundary_unproven`とする。前日cursorへ進めず、完全取得を主張しない。
manual triggerはpartialをHTTP 502、scheduled runはthrowとして可観測にする。

各artifactのR2 custom metadataは`source`, `runId`, `dataset`, `sha256`の4項目だけである。
manifest metadataは安全な`source`, `status`, `runId`の3項目だけを保存する。

## Bitwardenからのローカル同期

同期はパスキーの登録・更新・削除、JRE ID変更などの後だけ行う。Workerの日次実行は
Bitwardenへ接続しない。

```sh
cd poc/mobile-suica-worker
export BW_SESSION="$(bw unlock --raw)"
bun run bw:verify
bun run bw:sync
unset BW_SESSION
```

`bw:sync`はRP ID `id.jreast.co.jp`に完全一致するcredentialが1件だけであることを
確認してから、`wrangler secret put JRE_ID_CREDENTIAL_JSON`を実行する。Vault全体や
master passwordは送らない。同期後は`POST /credential-check`で秘密値を返さずに
Worker側の署名検査ができる。

## 実行

日次Cronは21:10 UTC（日本時間06:10）で、サービス停止時間00:50〜05:00 JSTを
避ける。手動実行はBearer認証付きの`POST /trigger?asOf=YYYY-MM-DD`である。

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
bun run cf:deploy
```

`ADMIN_TRIGGER_TOKEN`はデプロイ完了後に設定する。Secret変更とcode deployは別version
として反映されるため、診断・手動実行に使うローカル値とWorker側の値を最後に揃える。

過去runはsecure token fileを読み、1回にmanifest 1件だけを中央へ送る。source R2 objectは
削除・移動しない。

```sh
./scripts/backfill-raw-evidence.sh
```

## resourceとcleanup

- Worker: `kogane-mobile-suica-collector-poc`
- Browser binding: `BROWSER`
- R2 bucket: `kogane-mobile-suica-collector-poc`
- Service binding: `RAW_EVIDENCE_IMPORTER` → `kogane-collector-r2-importer`
- Cron: `10 21 * * *`
- Secrets: `ADMIN_TRIGGER_TOKEN`, `JRE_ID_CREDENTIAL_JSON`

旧`MOBILE_SUICA_SESSION_JSON`、`JRE_ID_FINGERPRINT`、TAMIA VPC bindingは実行に不要で
ある。削除時はR2 artifactを確認・退避してからWorker、bucketの順で削除する。
