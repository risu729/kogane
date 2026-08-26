# SBI証券 Bitwarden CLI passkey PoC

`pnsk-lab/mnie` の既存SBI証券providerとBitwarden署名実装を変更せず、Bitwarden CLIが返す復号済みlogin itemを薄いadapterで接続する再現用overlayである。実credential、session、口座番号、金融データはこのディレクトリに含めない。

## 検証済み範囲

2026-08-26、`pnsk-lab/mnie` の `c87e65c0a04c03c560962f8ead6e77415fb841f4` をWSL上で使用し、実口座の保存済みBitwarden passkeyで次を確認した。

1. ログインentryの取得: HTTP 200
2. FIDO2 challenge取得: HTTP 200
3. Bitwarden保存済みECDSA P-256 credentialによるassertion生成
4. assertion送信: HTTP 302
5. SSO callback取得: HTTP 200
6. callback内tokenのRSA復号
7. 公式株アプリから抽出した現行MTS originへ `/mtsmobile/ssologingate` をPOST: HTTP 200
8. MTS sessionを使い、`/mtsmobile/commgate` のread-only TR code `F2631` をPOST: HTTP 200
9. 現物保有一覧を固定長Shift-JIS responseから解析し、server totalと解析件数の一致を確認

ブラウザを使わないpasskey認証、MTS session確立、国内現物保有のread-only取得まで実口座で確認済みである。注文系method、取引パスワード、device registration、My資産、session再利用は使用・検証していない。通常ログへtoken、SID、口座番号、銘柄、数量、金額を出さず、検証記録にはHTTP status、operation名、件数一致、エラー有無だけを残した。

## 再現手順

1. WSL native filesystemへ対象commitをcheckoutする。

   ```sh
   git clone https://github.com/pnsk-lab/mnie.git
   cd mnie
   git checkout c87e65c0a04c03c560962f8ead6e77415fb841f4
   bun install --frozen-lockfile
   ```

2. このディレクトリの `scripts/` 4ファイルを、checkoutした `mnie/scripts/` へ配置する。import pathはその配置を前提にしている。

3. 合成credential adapter、既存署名実装、shell、bundleを検証する。

   ```sh
   bun fmt
   bun test scripts/prepare-sbi-bitwarden-cli-secret.bun.test.ts
   node_modules/.bin/vp test run packages/auth-bitwarden/src/fido2.test.ts
   bash -n scripts/run-sbi-bitwarden-cli-passkey-probe.sh
   shellcheck scripts/run-sbi-bitwarden-cli-passkey-probe.sh
   bun build \
     scripts/prepare-sbi-bitwarden-cli-secret.ts \
     scripts/verify-sbi-bitwarden-cli-passkey.ts \
     --target=bun \
     --outdir=/tmp/mnie-sbi-build-check
   ```

4. 初回だけ対話的にBitwarden CLIをunlockして実行する。

   ```sh
   bash scripts/run-sbi-bitwarden-cli-passkey-probe.sh
   ```

   CLIのsession key、master password、credential値は表示・保存しない。対象itemの絞り込みには、Bitwarden CLI 2026.8.0の `bw list items --url` と、既に実vaultで候補1件を返したSBI証券名検索を使う。

5. 現行MTS originを実行時だけ環境変数で指定すると、同じscriptがMTS loginと現物保有照会を1回行う。

   ```sh
   SBI_MTS_BASE_URL='<APKから検証したHTTPS origin>' \
     bun scripts/verify-sbi-bitwarden-cli-passkey.ts \
     < ~/.local/share/kogane/secrets/sbi-securities.json
   ```

   `SBI_MTS_BASE_URL`を指定しなければ従来どおりMTS送信前に遮断する。実originをsource、`.env.example`、通常ログへ保存しない。

6. 初回成功後は、利用者が明示的に許可したローカルPoC credentialを `~/.local/share/kogane/secrets/sbi-securities.json` から読む。ディレクトリは `0700`、ファイルは `0600` とする。保存対象は次だけである。

   - ログインID
   - ログインパスワード
   - RP IDと一致するHTTPS URI
   - assertion生成に必要な単一passkey credential

   Bitwarden itemのcustom fields、取引パスワード、notes、他サービスのitemは出力しない。パスキーitemとパスワードitemが別でも、URI hostがpasskeyのRP IDと一致する候補が1件だけの場合に限り結合する。0件・複数件なら停止する。

## 実装の境界

- `prepare-sbi-bitwarden-cli-secret.ts`: Bitwarden CLI item群からSBI専用の最小credentialを生成する。秘密値はstdout以外へ出さず、呼出側が権限制限した一時fileへ直接redirectする。
- `verify-sbi-bitwarden-cli-passkey.ts`: 既存 `createBitwardenAssertion`、`createPasskeySession`、`loginWithPasskey` を直接利用する。既定ではMTSの予約済みprobe originへのfetchをnetwork送信前に遮断する。実行時に検証済みの `SBI_MTS_BASE_URL` を渡した場合だけ、MTS session作成と `account.positions.cash` を許可する。
- `run-sbi-bitwarden-cli-passkey-probe.sh`: 初回unlock、最小credential保存、probe実行、`bw lock`、秘密を含まないstage/status記録を行う。
- 合成test: password同居、別item、別RP除外、曖昧候補拒否、custom field非コピーを確認する。

これはローカルPoCの利便性を優先した平文保存であり、cloud、container image、repo、CI、artifactへコピーしてはならない。Cloudflare ContainersやOCIへ移す前に、SBI証券専用secretの暗号化、実行時だけの復号、read-only bundle、egress allowlistを別途設計する。

## MTS originをrepoへ保存しない理由

`mnie` のrepo ruleは「実endpointのoriginをhardcodeしない。pathは許可」と明記している。このため、安定したprotocol pathとTR codeはsourceにある一方、`SBI_MTS_BASE_URL`は `.env.example` でも空欄で、実行時設定として扱われる。

株アプリは本番／試験環境選択用tableにMTS originを持ち、passkey login classが相対path `/mtsmobile/ssologingate` を結合する。originはアプリ更新や環境切替で変わり得るため、固定値を `mnie` やKoganeへ転記せず、その時点の公式配信物または実行時通信から抽出・検証してローカルsecret/configとして注入する。この分離は「値を発見できなかった」のではなく意図的な設計である。

今回の候補はGoogle Play以外の配布copyから抽出したため、mirrorを単独では信用せず、APK内のJAR署名を検証し、署名者名がSBI SECURITIESであること、MTS hostのTLS証明書がSBI証券名義であること、アプリの環境tableとMTS login classが同じorigin/pathを使うことを照合した。JADX 1.5.6は一部decompile errorを出したが、対象の定数tableとlogin classは復元できた。

## 次の一手

read-only buildから注文コード、取引password、device registrationを除外する。続いて同じMTS sessionで買付余力など必要な読取だけを個別allowlistし、session寿命と連続実行を観測する。
