# SBI証券 Bitwarden CLI passkey PoC

`pnsk-lab/mnie` のSBI証券providerとBitwarden署名実装に、Bitwarden CLIが返す復号済みlogin itemを接続する再現用overlayである。国内株の過去約定履歴に必要な最小provider patchも含む。実credential、session、口座番号、金融データはこのディレクトリに含めない。

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
9. 国内現物保有一覧を固定長Shift-JIS responseから解析し、server totalと解析件数の一致を確認
10. 買付余力、国内信用建玉、当日約定、未約定・直近注文をそれぞれ独立して照会
11. 外国株式アプリ用の別passkey channelとSSO sessionを作成し、米国株現物を3市場別に照会
12. 外国株式GraphQLの検索可能期間を取得し、その全期間を90日以下の非重複windowへ分割して取引履歴を照会
13. メインサイトへSSOし、My資産の現在評価JSONと円貨入出金明細JSONを照会
14. 国内・米国株の個別現在値と日足チャート、USD外貨交換レートを任意probeで照会
15. ログイン後ページの生きた「取引履歴」リンクから国内株の過去約定履歴フォームを開き、期間検索結果を構造化
16. 国内株の対象期間を90日以下の非重複windowへ分割して全件走査
17. 外国株式GraphQLからUSD外貨預り金の受渡日別残高、買付可能額、振替可能額を照会

ブラウザを使わないpasskey認証、国内MTS session、外国株式session、メインサイトSSOと、国内・米国現物保有、国内・米国株取引履歴、USD外貨預り金、My資産現在評価、円貨入出金明細のread-only取得まで実口座で確認済みである。注文系method、取引パスワード、device registration、session再利用は使用・検証していない。通常ログへtoken、SID、口座番号、銘柄、数量、金額、入出金摘要を出さず、検証記録にはHTTP status、operation名、件数、日付範囲、残高のpositive／zero／missing状態、エラー型だけを残した。

履歴の全期間走査は90日以下のinclusiveなwindowを、次のwindowが前windowの翌日から始まるように生成する。米国株では検索可能期間queryが返した `pastYears=2` を起点に11区間を走査し、11/11成功、7件、重複0、`hasMore` 0を確認した。2021年から現在までの1リクエストは拒否されたため、分割走査を標準方針とする。国内株では2024-01-01から2026-08-26までを11区間に分割し、11/11成功、一括検索と同じ72件、重複0、上限到達0を確認した。空期間は検索フォームだけを含み結果tableを含まないため、正常な0件として扱う。

USD外貨預り金は外国株式アプリと同じread-only GraphQL queryを使用する。検証時は5営業日分のscheduleが返り、通貨はUSD、全行で預り金と買付可能額が正数だった。金額そのものはログやrepoへ残さない。

円貨入出金明細の配当・分配金行は、検証した5件すべてに発行体を識別できる具体的な摘要があったが、4桁銘柄コードは含まれなかった。現在保有銘柄との名称一致は2件だったため、売却済み銘柄や表記差を含めた厳密な銘柄IDへの正規化には、My資産の「配当金・分配金履歴」または支払通知書を併用する。入出金明細だけでも人間向けの銘柄判別は通常可能だが、コードによる確定照合はできない。

市場データprobeでは、国内現物の保有一覧に全件の現在値があり、個別の板／現在値と日足チャートも成功した。米国株は照会時点で全保有銘柄の前日終値と日足チャートを取得できた一方、`last` は空で、保有一覧にも現在値は入らなかった。市場時間帯と配信条件による挙動を連続観測する必要がある。メインサイトのUSD外貨交換レート照会は同じ試験で失敗したため、現時点ではUI用FXレートの安定したsourceと見なさない。

## 再現手順

1. WSL native filesystemへ対象commitをcheckoutする。

   ```sh
   git clone https://github.com/pnsk-lab/mnie.git
   cd mnie
   git checkout c87e65c0a04c03c560962f8ead6e77415fb841f4
   bun install --frozen-lockfile
   ```

2. 国内株履歴provider patchを適用し、このディレクトリの `scripts/` 4ファイルをcheckoutした `mnie/scripts/` へ配置する。import pathはその配置を前提にしている。

   ```sh
   git apply /path/to/kogane/poc/sbi-securities/patches/mnie-sbi-domestic-history.patch
   cp /path/to/kogane/poc/sbi-securities/scripts/* scripts/
   ```

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

5. 現行endpointを実行時だけ環境変数で指定すると、同じscriptが国内MTS、外国株式、メインサイトのread-only照会を個別に行う。

   ```sh
   SBI_MTS_BASE_URL='<株アプリから検証したHTTPS origin>' \
   SBI_FOREIGN_STOCK_BASE_URL='<外国株式アプリから検証したHTTPS origin>' \
   SBI_MAIN_SITE_BASE_URL='<公式メインサイトのHTTPS origin>' \
   SBI_DOMESTIC_HISTORY_FROM='<YYYY-MM-DD>' \
   SBI_DOMESTIC_HISTORY_TO='<YYYY-MM-DD>' \
   SBI_VERIFY_DOMESTIC_HISTORY_WINDOWS=true \
   SBI_US_HISTORY_FROM='<YYYY-MM-DD>' \
   SBI_US_HISTORY_TO='<YYYY-MM-DD>' \
   SBI_VERIFY_US_HISTORY_WINDOWS=true \
   SBI_VERIFY_MARKET_DATA=true \
     bun scripts/verify-sbi-bitwarden-cli-passkey.ts \
     < ~/.local/share/kogane/secrets/sbi-securities.json
   ```

   `SBI_MTS_BASE_URL`を指定しなければ従来どおりMTS送信前に遮断する。外国株式とメインサイトは各base URLを指定した場合だけ照会する。`SBI_VERIFY_*_HISTORY_WINDOWS=true` は指定期間を90日以下に分割し、成功区間数、件数、重複、上限到達を金額や銘柄を出さず報告する。実originをsource、`.env.example`、通常ログへ保存しない。

6. 初回成功後は、利用者が明示的に許可したローカルPoC credentialを `~/.local/share/kogane/secrets/sbi-securities.json` から読む。ディレクトリは `0700`、ファイルは `0600` とする。保存対象は次だけである。

   - ログインID
   - ログインパスワード
   - RP IDと一致するHTTPS URI
   - assertion生成に必要な単一passkey credential

   Bitwarden itemのcustom fields、取引パスワード、notes、他サービスのitemは出力しない。パスキーitemとパスワードitemが別でも、URI hostがpasskeyのRP IDと一致する候補が1件だけの場合に限り結合する。0件・複数件なら停止する。

## 実装の境界

- `prepare-sbi-bitwarden-cli-secret.ts`: Bitwarden CLI item群からSBI専用の最小credentialを生成する。秘密値はstdout以外へ出さず、呼出側が権限制限した一時fileへ直接redirectする。
- `patches/mnie-sbi-domestic-history.patch`: `orders.inquiry.tradeRecords({ market: 'XTKS', ... })` を国内向けに拡張する。メインサイトSSO後に固定sequence番号を使わず、現在のナビゲーションから生きた取引履歴URLを抽出する。検索formのhidden fieldを保持したまま期間を設定し、Shift-JIS HTMLを `TradeRecordList` に変換する。指定がなければ直近90日を検索し、1回の表示上限は200件である。
- `verify-sbi-bitwarden-cli-passkey.ts`: 既存 `createBitwardenAssertion`、`createPasskeySession`、`loginWithPasskey` を直接利用する。既定ではMTSの予約済みprobe originへのfetchをnetwork送信前に遮断する。実行時に検証済みbase URLを渡した場合だけ、国内MTS、外国株式、メインサイトのread-only methodを呼ぶ。国内・米国履歴の90日分割、外国株式の検索可能期間query、USD外貨預り金queryもここで検証する。各methodは独立して例外を捕捉し、1経路の「データなし」や期間エラーで他経路の結果を失わない。
- `run-sbi-bitwarden-cli-passkey-probe.sh`: 初回unlock、最小credential保存、probe実行、`bw lock`、秘密を含まないstage/status記録を行う。
- 合成test: password同居、別item、別RP除外、曖昧候補拒否、custom field非コピーを確認する。

これはローカルPoCの利便性を優先した平文保存であり、cloud、container image、repo、CI、artifactへコピーしてはならない。Cloudflare ContainersやOCIへ移す前に、SBI証券専用secretの暗号化、実行時だけの復号、read-only bundle、egress allowlistを別途設計する。

## MTS originをrepoへ保存しない理由

`mnie` のrepo ruleは「実endpointのoriginをhardcodeしない。pathは許可」と明記している。このため、安定したprotocol pathとTR codeはsourceにある一方、`SBI_MTS_BASE_URL`は `.env.example` でも空欄で、実行時設定として扱われる。

株アプリは本番／試験環境選択用tableにMTS originを持ち、passkey login classが相対path `/mtsmobile/ssologingate` を結合する。originはアプリ更新や環境切替で変わり得るため、固定値を `mnie` やKoganeへ転記せず、その時点の公式配信物または実行時通信から抽出・検証してローカルsecret/configとして注入する。この分離は「値を発見できなかった」のではなく意図的な設計である。

今回の候補はGoogle Play以外の配布copyから抽出したため、mirrorを単独では信用せず、APK内のJAR署名を検証し、署名者名がSBI SECURITIESであること、MTS hostのTLS証明書がSBI証券名義であること、アプリの環境tableとMTS login classが同じorigin/pathを使うことを照合した。JADX 1.5.6は一部decompile errorを出したが、対象の定数tableとlogin classは復元できた。

## 公式仕様との照合

- SBI証券は2026-08-24の案内で、取引履歴を過去2年分表示でき、10,000件以下は1つのCSVとして出力できるとしている: [「取引履歴」画面リニューアルのお知らせ](https://www.sbisec.co.jp/ETGate/WPLETmgR001Control?OutSide=on&burl=search_home&cat1=home&cat2=info&dir=info&file=home_info111001.html&getFlg=on)
- 国内株配当を証券口座で受け取る場合は円貨入出金明細、外国株配当は外貨入出金明細で確認できる: [配当金の受取方法と確認方法](https://faq.sbisec.co.jp/answer/5f4499c551dbff0012590b3f/)

PoCの90日分割は公式の2年保持期間を走査対象としつつ、1リクエストの期間・件数上限や外国株APIの広範囲拒否を避けるための実装上の選択である。国内株Web画面自体は2年分を一括指定できた。

## 次の一手

国内履歴のHTML parserをfixture test化し、表示文言変更を検知できるようにする。配当はMy資産の配当金・分配金履歴も取得して銘柄コードへ正規化する。続いてread-only buildから注文コード、取引password、device registrationを除外し、session寿命と連続実行を観測する。
