# MyJCB read-only Worker PoC

MyJCBの公式WebをCloudflare WorkersのScheduled handlerから読み、取得時の公式HTMLと取得manifestをprivate R2へ追記保存する独立PoCである。`mnie`は利用せず、Okuraのコードも取り込んでいない。

これは**未deploy・未実認証**のPoCである。現時点で実装済みの取得経路は、password loginが許されるMyJCB IDのlogin bootstrapと、公開実装で現行性が具体的に示されたJCBデビット通常／差額明細だけである。クレジット確定・未確定明細、公式CSV/PDF/OFX、おまとめカード切替はroute/actionのlive read-only観測が完了するまで明示的に無効である。

## なぜBrowser Runを使うか

`/Login`はloadごとに`/apl/login-prot.js?init`とephemeral seed付き`?async`を読み、公式JavaScriptがlogin formへ動的field/cookieを追加する。Workersは取得した任意JavaScriptを`eval`/`new Function`で実行する環境ではなく、保護scriptを手書きで再実装すると追従性と安全境界が悪化する。このPoCは`src/login-protection.ts`だけでCloudflare Browser Runを起動し、公式page内で公式scriptをそのまま実行する。

login成功後はbrowser cookieとUser-Agentを`CookieJar`へ移し、`src/policy.ts`のmethod/origin/path/query allowlistを通るGETだけを通常のWorker `fetch`で取得する。Browserはconnectionごとに閉じる。動的script source、credential、protected POST body、cookie値、mypage HTMLはR2へ保存しない。

現段階ではContainerを追加しない。Browser Runで公式scriptを実ブラウザ実行でき、Worker内にR2/Cron/read clientを残せるためである。今後、Browser Runからのpassword loginだけが環境要因で拒否され、同一script/profileでContainer Chromeが再現性を持って成功することがsanitized live testで確認された場合に限り、login bootstrapだけを最小Containerへ移す。

## 認証とsecret

Worker secret `MYJCB_CONNECTIONS_JSON`は1〜16 connectionを持つ。

```json
[
  {
    "connectionId": "jcb-w",
    "bootstrapMode": "password",
    "userId": "<MyJCB ID>",
    "password": "<login password>"
  },
  {
    "connectionId": "another-independent-id",
    "bootstrapMode": "session",
    "userAgent": "<the exact bootstrap browser User-Agent>",
    "cookies": [
      {
        "name": "<cookie name>",
        "value": "<cookie value>",
        "domain": "my.jcb.co.jp",
        "path": "/",
        "secure": true
      }
    ]
  }
]
```

各array要素は独立したMyJCB ID/session/R2 namespaceである。最初のIDや一つのおまとめloginが他IDを網羅すると仮定しない。`connectionId`はR2 key用の利用者定義pseudonymであり、MyJCB ID、カード番号、氏名を使わない。`ADMIN_TRIGGER_TOKEN`は手動`POST /trigger`のBearer secretである。

`bootstrapMode=password`は公式password formとlogin protection scriptをBrowser Runで実行する。`bootstrapMode=session`は、本人が別browserで正常loginした後に短命なcookie＋同一User-Agentをsecretとして投入し、mypageを検証してからread-only replayする。session値をR2やmanifestへ保存しない。passkey自体をWorkerから自動操作する実装ではなく、失効時の自動renewalも未解決である。

```sh
wrangler secret put MYJCB_CONNECTIONS_JSON
wrangler secret put ADMIN_TRIGGER_TOKEN
```

secret値をsource、`wrangler.jsonc`、`.dev.vars`のcommit、shell引数、stdout、manifestへ入れない。passkey登録済みIDは公式仕様上ID/password loginを使えないため`bootstrapMode=password`で試行せず、本人bootstrap後の`session`を使う。session expiry後は`human-required`となり、passkeyの完全無人renewalは未解決のままである。

## read-only policy

active allowlistは次だけである。

| operation | method | path/query | 用途 |
|---|---|---|---|
| login page | GET | `/Login` | protection scriptを含む公式login page bootstrap |
| login submit | POST | `/iss-pc/member/user_manage/Login` | Browser内でform actionを検査して一回だけsubmit |
| mypage | GET | `/iss-pc/member/mypage/mypage.html` | login landing/session確認 |
| debit menu | GET | `/iss-pc/member/debit/details/debitDetailMenu.html?link_id=myj_main_debitDetailMenu` | period列挙 |
| debit detail | GET | `/iss-pc/member/debit/details/debitDetail.html?seq=0..14` | 通常／差額明細 |

以下はread candidateだが**無効**である。

- 既存おまとめIDの表示切替POST
- クレジット確定／未確定明細
- 公式CSV/PDF/OFX download

これらはHTTP methodがPOSTだから一律禁止しているのではない。現在のorigin/path、field名と型、CSRF/session token、期待response、redirect、read semanticsが本人操作のsanitized観測で未確認だからである。確認後も個別operationとして固定allowlistへ追加し、未知fieldやredirectでは停止する。

collectorは、おまとめ設定追加・解除、初期表示変更、支払方法変更、リボ／分割、繰上返済、キャッシング、limit/lock/通知/個人情報変更、カード申込・解約、ポイント交換、campaign登録、passkey登録・解除、password resetを実行しない。

## stop condition

次を検出したconnectionはretryせず`human-required`または`failed`としてmanifestへ記録する。

- passkey、生体/PIN、QR、OTP、秘密の合い言葉、CAPTCHA、本人確認
- Access Denied、401、403、429、account lock/risk warning
- login form action、landing origin/path、redirect、response schemaの不一致
- allowlist外のmethod/path/query、cross-origin遷移
- password login無効、規約同意、新規登録、端末登録
- response size上限8 MiB、未知charset、seq範囲外、cookie domain/count/size異常
- token/cookie/credentialを保存しそうな状態

scheduled runは同じconnectionを自動再試行しない。次回の日次runは新規browser/loginで開始する。

## card/month/state/export模型

`parseCardInventory`は各独立connectionのmypage内に存在する既存card candidateをcard番号や氏名ではなく`card-001`等のlocal indexと一般商品名allowlistへ正規化する。現PoCは切替を行わないため、current root以外はdiscovery candidateに留まる。複数connection間の同一性やおまとめ関係を推測しない。

`parseStatementPeriods`はmenuの`seq=0..14`と表示labelを列挙する。menuからseqを得られない場合も、公開実装で観測された15 cycleを0〜14として走査する。これはデビット経路のfallbackで、クレジットの17か月表示や15か月exportへ一般化しない。

保存artifactには`statementState`として`debit`、将来のcredit pathには`confirmed`または`unconfirmed`を付ける。未確定はmutable snapshotであり、確定artifactを上書きしない。CSV/PDF/OFXの種類はpage metadataから発見できても、download actionがlive確認されるまでrequestしない。

## R2 layout

```text
raw/myjcb/YYYY/MM/DD/<run-id>/
  manifest.json
  <connection-id>/
    debit-menu.html
    debit-detail-00.html
    ...
    debit-detail-14.html
    discovery.json
```

HTMLは取得時sourceをUTF-8へdecodeし、token/credentialに見えるhidden input値と16桁card番号をredactしてから保存する。login/mypage HTMLは保存しない。各R2 objectにはSHA-256、dataset、state、periodをmetadataとして持たせる。manifestにはrun/connection/artifact/failureのmetadataだけを入れ、cookie値や実明細値をlogへ出さない。bucketはpublicにしない。

## Cronと手動実行

`wrangler.jsonc`のCron `0 21 * * *`（06:00 JST）からWorkerの`scheduled()`を直接呼ぶ。GitHub Actionsをschedulerとして使わない。

手動runは`POST /trigger`だけで、`ADMIN_TRIGGER_TOKEN`が必要。`GET /health`はsecret不要でsource/schemaだけを返す。

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
```

このPRでは`wrangler deploy`、R2 bucket作成、secret投入、実credential testを行わない。

## synthetic test

`test/fixtures`は架空merchant・架空額・架空token/card番号だけを持つ手書きHTMLであり、MyJCB/Okura/mnieのHTMLをcopyしていない。testはroute allowlist、cross-origin/unknown method拒否、cookie domain/path、card/month parser、token/card番号redactionを検証する。

## public prior art boundary

公開AGPL-3.0実装[youseiushida/Okura](https://github.com/youseiushida/Okura)の2026-08-31時点commit `bbf11e032aba4a380009508e91954361a3f9d658`を、login protectionの存在、origin/path、cookie＋User-Agent維持、デビット15 cycleの現行性を照合するためだけに読んだ。source、DOM runtime、parser、test fixtureは転用していない。詳細は`THIRD_PARTY_NOTICES.md`を参照。

## 未確認事項

- Browser Run egress/profileでpassword loginが完了するか
- 各実IDがpasswordかpasskeyか、秘密の合い言葉/OTPが出る条件
- 現行mypageのcard enumeration DOMとおまとめ切替contract
- credit confirmed/unconfirmedの現行path/schema
- CSV/PDF/OFX action、encoding、field、zero-row response、card/subcard列
- debit menu/detailの全issuer互換性、状態label、0件/取消/差額表現
- session idle/absolute TTLとcookie rotation
- login protection vendorとchange cadence

以上は実値を保存しない一回限りのKuebiko/live observationで更新し、unknown時は実装を推測で拡張しない。
