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
7. `/mtsmobile/ssologingate` に復号済みtokenを渡す直前まで到達

最後のMTS requestはprobe内で遮断した。従って、この結果が証明するのはブラウザを使わないpasskey認証とaccess token復号までであり、MTS session確立、残高照会、My資産取得、session寿命はまだ証明しない。注文系method、取引パスワード、device registrationは使用していない。

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

5. 初回成功後は、利用者が明示的に許可したローカルPoC credentialを `~/.local/share/kogane/secrets/sbi-securities.json` から読む。ディレクトリは `0700`、ファイルは `0600` とする。保存対象は次だけである。

   - ログインID
   - ログインパスワード
   - RP IDと一致するHTTPS URI
   - assertion生成に必要な単一passkey credential

   Bitwarden itemのcustom fields、取引パスワード、notes、他サービスのitemは出力しない。パスキーitemとパスワードitemが別でも、URI hostがpasskeyのRP IDと一致する候補が1件だけの場合に限り結合する。0件・複数件なら停止する。

## 実装の境界

- `prepare-sbi-bitwarden-cli-secret.ts`: Bitwarden CLI item群からSBI専用の最小credentialを生成する。秘密値はstdout以外へ出さず、呼出側が権限制限した一時fileへ直接redirectする。
- `verify-sbi-bitwarden-cli-passkey.ts`: 既存 `createBitwardenAssertion` と `createPasskeySession` を直接利用する。MTSの予約済みprobe originを指定し、その宛先へのfetchをnetwork送信前に遮断する。
- `run-sbi-bitwarden-cli-passkey-probe.sh`: 初回unlock、最小credential保存、probe実行、`bw lock`、秘密を含まないstage/status記録を行う。
- 合成test: password同居、別item、別RP除外、曖昧候補拒否、custom field非コピーを確認する。

これはローカルPoCの利便性を優先した平文保存であり、cloud、container image、repo、CI、artifactへコピーしてはならない。Cloudflare ContainersやOCIへ移す前に、SBI証券専用secretの暗号化、実行時だけの復号、read-only bundle、egress allowlistを別途設計する。

## 次の一手

現行MTS base URLを公式アプリの配信物または実行時通信から確認し、最初は `/mtsmobile/ssologingate` だけを許可してsession確立を検証する。その後、注文コードと取引passwordをbundleから除いたread-only buildで、最小の残高照会を1件だけ実行する。
