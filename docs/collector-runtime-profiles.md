# Collector runtime profiles

この表は、Cloudflareへdeploy可能な金融source collectorだけを対象にする。調査専用のBrowser Run、Camoufox、Kameleo、OCI、runtime probeと、observation pipelineのUI testはcollectorではないため含めない。HTMLを取得・parseするだけでは「browser使用」と数えず、実行時にChrome／Chromiumを起動するかで分類する。

collectorは`poc/`から`services/collector-<source>`へ順に移動している最中なので、この表はdirectory名ではなく変わらないWorker nameで各collectorを指す。configとbinding、cron、bucketの現在地は[`../infra/resources.md`](../infra/resources.md)にある。

| Collector           | Worker name                       | Browser使用      | Runtime                                        | 使用区間と目的                                                                               | Browser外の処理                                   |
| ------------------- | --------------------------------- | ---------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| SMCC Vpass          | `kogane-vpass-collector-poc`      | **なし**         | Worker `fetch`                                 | Android JSON protocolを直接再現するため不要                                                  | 認証、card列挙、月列挙、明細JSON、R2              |
| SBI証券             | `kogane-sbi-collector-poc`        | **なし**         | Worker `fetch` + 暗号処理                      | WebAuthn assertionと公式Web／app通信を直接実装するため不要                                   | passkey認証、session確立、残高・履歴、R2          |
| Sony銀行            | `kogane-sony-bank-collector-poc`  | **なし**         | Worker `fetch`                                 | Web BFF、WALLET SSO、HTML/CSVを通常HTTPで取得できるため不要                                  | 認証、銀行API、WALLET月切替、R2                   |
| Vポイント           | `kogane-vpoint-collector-poc`     | **なし**         | Worker `fetch` + Email Worker + Durable Object | form chainとメール認証をHTTPで再現し、sessionをDOに保持するため不要                          | 認証、JSON API、session更新、R2                   |
| MyJCB               | `kogane-myjcb-collector-poc`      | **ログインのみ** | **Browser Run binding** + Worker `fetch`       | 動的login protection scriptとNNL WebAuthn `result`を公式page内で実行し、mypage sessionを作る | login後のmenu、月列挙、明細HTML/export、R2        |
| PRESTIA GLOBAL PASS | `kogane-globalpass-collector-poc` | **全収集区間**   | **Container Playwright Google Chrome**         | Turnstile、JavaScript login、server-rendered明細、月selectorを実ブラウザで処理する           | Worker orchestration、TAMIA relay、NDJSON受信、R2 |

GLOBAL PASSのWorkerには別にBrowser Run bindingがあるが、これは認証付き`/browser-probe`専用で、通常のdaily/backfill collectorはContainer Chromeを使う。MyJCBは逆に、Browser Runをsession bootstrap直後に閉じ、それ以降は通常のWorker `fetch`だけを使う。

## 新しいcollectorで必ず明記する項目

各collectorのREADME冒頭に`Runtime profile`を置き、次を明記する。

1. `Browser: なし / ログインのみ / 全収集区間`のいずれか。
2. 実体がBrowser Run binding、Container Chrome/Chromium、外部browserのどれか。
3. browserが必要な具体的理由。WAF名だけで済ませず、WebAuthn、Turnstile、動的script、rendered navigation等のどの処理を任せるかを書く。
4. session取得後に通常`fetch`へ切り替える境界と、browserで取得するデータ範囲。
5. diagnostic/probeだけがbrowserを使う場合は、production collectionから明確に分離する。

調査時にKogane Capture Chromeを使ったこと、HTMLをparseすること、browser由来のUser-Agentを送ることだけをruntime browser依存と記載しない。

## 終了した browser 実験

この表に載らない調査用のbrowser runtimeは、[`research/`](research/)に成果と停止理由を残してcodeをmainから除いた。継続中のものは`experiments/<name>/EXPERIMENT.md`にowner、期限、停止条件がある。
