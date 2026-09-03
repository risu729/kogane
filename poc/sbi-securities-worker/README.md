# SBI証券 read-only Worker PoC

SBI証券の保存済みパスキーから毎回新しいsessionを作り、国内・米国株の残高と履歴を公式のWeb／アプリ通信から取得してprivate R2へ保存する独立Workerである。`mnie`をruntime依存、submodule、設定源として使用しない。必要だった認証・復号・read-only通信だけをこのディレクトリへ移植した。

## Runtime profile

- **Browser: なし。** Cloudflare Browser Run、Container Chrome/Chromium、外部browser sessionを使用しない。
- WebAuthn challenge/assertion、SSO callback、MTS／外国株式／メインサイトsessionをWorker内の暗号処理と`fetch`で直接処理する。
- HTML endpointを読む場合もbrowser renderingは行わず、read-only HTTP responseとして取得・parseする。

## 現在の範囲

- 国内株アプリ: MTS sessionとread-only TR code `F2631`による国内現物・預り金payload
- メインサイト: My資産の現在評価、円貨入出金明細、国内株の90日以下の履歴
- 外国株式アプリ: 米国株現物、USD外貨預り金、90日以下の取引履歴
- 実行: Cloudflare Cron Triggerから毎日21:00 UTC（日本時間06:00）に国内・外国を1 invocationで直列収集、または認証付き手動trigger
- 保存: private R2をdurable outboxとして維持し、manifest確定後に内部Service Binding経由で中央raw-evidenceへ転送する。collector自身はD1を使用しない

注文、訂正、取消、取引パスワード、端末登録は実装にも設定にも含めない。通信が`POST`でも、許可するhost、path、MTS TR code、GraphQL operationを読み取り用途へ固定している。

## 公開接続先とsecret

公式クライアントが使う次の公開接続先はsourceへ固定している。

- passkey: `https://login.sbisec.co.jp/login/entry`
- 国内MTS: `https://apli.sbisec.co.jp`
- 外国株式: `https://fstockapp.sbisec.co.jp`
- メインサイト: `https://www.sbisec.co.jp`

Worker secretは次の3つだけである。

- `SBI_CREDENTIAL_JSON`: `rpId`、`origin`、`credentialId`、`keyValue`、任意の`userHandle`、`counter`だけを持つJSON
- `SBI_HANDSHAKE_KEY_JSON`: SBIが返す一時tokenを復号するRSA-4096 transport key。口座認証鍵ではなく、ローカルで一度生成する
- `ADMIN_TRIGGER_TOKEN`: 手動triggerのBearer token

中央raw-evidenceのBearerやstorage fingerprint鍵はcollectorには置かず、外部非公開の`kogane-collector-r2-importer`だけが保持する。Service Bindingの転送に失敗しても、確定済みmanifestとartifactは元R2に残り、`scripts/backfill-raw-evidence.sh`で再送できる。

Bitwarden item全体、ログインID、ログインパスワード、取引パスワード、master password、vault exportはWorkerへ置かない。SBIのpasskey秘密鍵はこのPoCではCloudflare secretへ複製されるため、通常のpasswordより強いsecretとして扱う。transport鍵は口座認証鍵でもsession鍵でもないため一度だけ生成し、各runで再利用する。sessionとpasskey assertionは毎回作り直す。

ローカルに作成済みのSBI専用Bitwarden item JSONから、必要項目だけをCloudflareへ同期する。管理用tokenは同じGit管理外secret directoryに初回だけ生成する。

```sh
scripts/sync-local-secrets.sh \
  ~/.local/share/kogane/secrets/sbi-securities.json
```

このスクリプトはsecret値を標準出力へ表示しない。SBIのpasswordを更新してもpasskeyが変わらなければ再同期は不要で、passkeyを再登録・削除した場合にだけ再実行する。

## 実行と保存形式

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
```

手動実行は`POST /trigger`だけを受け付ける。

```text
/trigger?scope=domestic&from=2026-06-01&to=2026-08-27
/trigger?scope=foreign&from=2026-06-01&to=2026-08-27
```

ローカルの管理用tokenを表示せずに起動する場合は、`scripts/trigger.sh foreign`のようにscopeを渡す。`scripts/trigger.sh all`はCloudflare Cronと同じく、1 invocation内で国内、外国の順に収集する。

`from`と`to`は同時指定し、1回の範囲はinclusiveで90日以下とする。現在値だけなら省略できる。raw responseは次の形でprivate R2に保存する。

初期取込は、指定期間を重複のない90日以下のwindowへ分けて国内・外国を順番に取得する。

```sh
scripts/backfill.sh 2024-08-28 2026-05-29
```

```text
raw/sbi-securities/YYYY/MM/DD/<run-id>/<dataset>.json
raw/sbi-securities/YYYY/MM/DD/<run-id>/manifest.json
```

manifestには期間、成功・部分成功・失敗、artifactのhashとbyte数、秘密を除いた短い失敗分類を記録する。access token、SID、Cookie、MTSのsession header、口座番号は保存しない。

保存済みrunを中央へ移行する場合は、CloudflareのWorker呼び出し上限を避けるため1 top-level requestにつき1 R2 objectを走査し、cursorで反復する。

```sh
scripts/backfill-raw-evidence.sh
```

再実行は同じ中央runへ冪等に収束する。中央への移行後もsource R2を自動削除しない。

## Workers Paidでの定期実行

Free planの実測では、個別の`scope=foreign`と`scope=domestic`は成功した一方、両方を同じinvocationで実行するとCloudflare Error 1102になった。Queue分割もFreeのCPU制限を解消しなかったため、一時的に外部schedulerからscope別HTTP requestを呼ぶ案を検証した。

2026-08-27にWorkers Paidへ移行したため、定期起動はWorker自身のCloudflare Cron Triggerへ統一した。毎日21:00 UTCの`scheduled()`が`scope=all`を直接実行し、国内と外国を同じinvocation内で直列収集する。日次Cronは1時間以上の間隔なので、Cloudflareの現行制限では最大15分のCPU timeと15分のwall timeが使える。このcollectorの実測（外国約7秒、国内約15秒）には十分である。

Queue、dispatcher、GitHub Actions schedule、D1は使わない。Queueは再試行やscope単位の障害隔離が実際に必要になった場合だけ追加し、Paid化そのものを理由には導入しない。手動・バックフィル用の認証付き`POST /trigger`は残す。

## 出典

一部のprotocol理解と最初の実装は`pnsk-lab/mnie`のcommit `c87e65c0a04c03c560962f8ead6e77415fb841f4`を基にしている。Kogane側のコードはCloudflare Workers向けに独立して書き直し、ファイルシステム、OpenSSL process、Mnie session型、注文APIへの依存を除去した。ライセンス表示は[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)を参照する。
