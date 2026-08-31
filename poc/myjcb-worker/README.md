# MyJCB read-only Worker PoC

MyJCBの公式WebをCloudflare WorkersのScheduled handlerから読み、取得時の公式HTMLと取得manifestをprivate R2へ追記保存する独立PoCである。`mnie`は利用せず、Okuraのコードも取り込んでいない。

Worker PoCは2026-08-31にdeployし、第一のMyJCB IDで実auth testまで完了した。Bitwardenから一項目だけをlocal syncし、Browser Runの一時virtual authenticatorでpasskey assertionを生成してmypageへ到達した後、cookieとUser-Agentを通常のWorker `fetch`へ移管した。過去月JSONによるavailable月列挙、credit detail取得、private R2への20 artifactとmanifest保存が1 runで成功し、failureは0だった。raw credential、WebAuthn assertion、cookie、明細値、file hashはcommit／logしていない。

## なぜBrowser Runを使うか

`/Login`はloadごとに`/apl/login-prot.js?init`とephemeral seed付き`?async`を読み、公式JavaScriptがlogin formへ動的field/cookieを追加する。Workersは取得した任意JavaScriptを`eval`/`new Function`で実行する環境ではなく、保護scriptを手書きで再実装すると追従性と安全境界が悪化する。このPoCは`src/login-protection.ts`だけでCloudflare Browser Runを起動し、公式page内で公式scriptをそのまま実行する。

login成功後はbrowser cookieとUser-Agentを`CookieJar`へ移し、`src/policy.ts`のmethod/origin/path/query allowlistを通るGETと過去月列挙JSON-RPC POSTだけを通常のWorker `fetch`で取得する。Browserはconnectionごとの`finally`で閉じる。動的script source、credential、protected login POST body、cookie値、mypage HTMLはR2へ保存しない。

### Browser Runを外せるか

passkey成功時のsanitized network shapeでは、同一origin内で次の順序を確認した。query、header、cookie、request/response body、challenge、assertion、`result`値は保存していない。

1. `POST /iss-pc/member/user_manage/PasskeyLogin`
2. `POST /iss-pc/member/user_manage/userLoginPasskeyServiceStatusCommunication.html`（field名は`loginRouteId`）
3. NNL Apps SDK 9.2.0のUI resource取得
4. `POST /iss-pc/member/user_manage/userLoginPasskeyAuthCheckCommunication.html`（field名は`result`）
5. `GET /iss-pc/member/mypage/mypage.html`

これは標準WebAuthn assertionを単一JSON endpointへ直接送る契約ではなく、公式NNL SDKがchallenge／assertionをopaqueな`result`へ組み立てるflowである。P-256署名自体はWorkers Web Cryptoでも可能だが、NNL `result` contractを観測・再実装・追従する必要があるため、現時点のworking implementationではlogin bootstrapだけBrowser Runを使う。Browser Runが原理的に必須と証明されたわけではなく、将来のcost最適化候補としてdirect passkey clientを分離調査する。ログイン後のmenu、過去月JSON、detail、export、R2保存にはBrowser Runを使わないことはlive runで確認済みである。

### Browserless passkey clientの実装計画

Browserless化は明細clientを書き換える作業ではなく、`loginWithBitwardenPasskey`だけをdirect bootstrapへ置き換える作業とする。既存のcookie jar、strict read allowlist、parser、R2保存はそのまま利用する。現時点では`result`の実値を保存していないため、次の順序を飛ばして署名だけを実装しない。

1. 所有者自身のaccountで成功loginを複数回private captureし、NNL SDK resourceのversion/hash、`navigator.credentials.get()`へ渡る`PublicKeyCredentialRequestOptions`、返る`PublicKeyCredential`、直後の`result`、cookie rotation、relayを同一run内で対応付ける。challenge、assertion、cookie、`result`の値はpublic repo、Worker log、R2へ置かず、必要な解析中だけprivate evidenceとして扱う。
2. 二つ以上のfresh challengeを比較し、`result`が単なるJSON/Base64か、SDK固有envelope、MAC／暗号化、transaction ID、SDK metadata、risk/device signalを持つかを切り分ける。一標本からfieldを固定仕様と推定せず、NNL assetのversion変更も別caseとして扱う。
3. 標準WebAuthn部分をWorkers Web Cryptoで生成する。入力はcredential ID、P-256 private key、RP ID、user handle、server challengeで、`clientDataJSON`のorigin/type/challenge、`authenticatorData`のRP ID hash・UP/UV・BE/BS・counter・extensions、`authenticatorData || SHA-256(clientDataJSON)`へのES256署名、必要ならWeb Crypto出力からWebAuthn署名表現への変換をbyte単位でtest vector化する。
4. 観測で確認したNNL/JCB serializationだけを独立adapterに実装する。`PasskeyLogin`、service-status、auth-check、relayのmethod/origin/path、CSRFまたは動的field、完全なcookie jarをstate machineとして扱い、未知redirect、SDK version、response shape、追加認証では停止する。取得したSDKをWorker内で`eval`／`new Function`して代用しない。
5. `bootstrapMode: "passkey-direct"`のようにBrowser版と分離して導入し、fresh challengeの一回利用、replay拒否、RP ID/origin不一致拒否、連続run、Cron実行元、session expiry、NNL version driftを検証する。mypage到達後は既存fetch clientへhandoffし、同じaccount・同じ時点でBrowser版とcard/period/artifact種別を照合する。秘密値、明細値、assertionを差分logへ出さない。
6. direct版が複数回のlive runとversion-drift停止試験を通るまではBrowser版を既定値として残す。失敗時に同一runで自動Browser fallbackして認証を二重送信せず、次回runで明示設定されたbootstrapだけを使う。

完了条件は「署名が作れた」ではなく、fresh server stateからauth-checkとrelayを通り、mypage sessionを取得し、既存read-only collectionが同等の範囲を回収でき、古いchallenge／未知SDKではfail closedになることである。Browser Runの削除とbinding除去は、この条件を満たした後の別変更とする。

現段階ではContainerを追加しない。Browser Runで公式scriptを実ブラウザ実行でき、Worker内にR2/Cron/read clientを残せるためである。今後、Browser Runからのpassword loginだけが環境要因で拒否され、同一script/profileでContainer Chromeが再現性を持って成功することがsanitized live testで確認された場合に限り、login bootstrapだけを最小Containerへ移す。

## 認証とsecret

小規模PoCではWorker secret `MYJCB_CONNECTIONS_JSON`に1〜16 connectionを置ける。

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

`bootstrapMode=password`は公式password formとlogin protection scriptをBrowser Runで実行する。`bootstrapMode=passkey`はBitwarden JSONの単一`fido2Credentials`からP-256 PKCS#8鍵、credential ID、user handleを一接続一secretへ同期し、Browser RunのCDP virtual authenticatorへ一時注入して公式「パスキーでログイン」を実行する。Browserを閉じるとvirtual authenticatorも消え、鍵、assertion、cookieをR2やmanifestへ保存しない。`bootstrapMode=session`は、本人が別browserで正常loginした後に短命なcookie＋同一User-Agentをsecretとして投入し、mypageを検証してからread-only replayする。

Bitwarden自身の実装は`keyValue`をbase64url PKCS#8、credential IDをUUIDまたは`b64.`形式として扱う。Chrome CDPはPKCS#8とraw credential IDをstandard base64で要求するため、PoCはlocal conversionだけを行い秘密鍵を再生成しない。Bitwarden exportのsignature counterが非zeroの場合は、serverとのcounter同期を壊し得るため拒否する。MyJCBのpasswordless flowに必要なdiscoverable credentialと、RP ID `my.jcb.co.jp`/`jcb.co.jp`以外も拒否する。

全vault exportは作らず、unlocked WSL terminalで第一項目だけを取得・検査する。既定はcheck-onlyで、秘密値をstdoutへ出さない。`--put`時だけ生成JSONをstdinでWranglerへ渡す。

```sh
bun run bw:passkey -- \
  --item-id '<Bitwarden item UUID>' \
  --connection-id first-card \
  --secret-name MYJCB_ACCOUNT_FIRST_JSON

bun run bw:passkey -- \
  --item-id '<Bitwarden item UUID>' \
  --connection-id first-card \
  --secret-name MYJCB_ACCOUNT_FIRST_JSON \
  --put
```

```sh
wrangler secret put MYJCB_CONNECTIONS_JSON
wrangler secret put ADMIN_TRIGGER_TOKEN
```

Cloudflare Workersのenvironment variable/secretは1値5 KB上限である。複数IDやcomplete cookie jarを一つのJSONへ集約すると超過するため、実装は`MYJCB_CONNECTION_SECRET_NAMES`にcomma区切りのsecret binding名を置き、各`MYJCB_ACCOUNT_<NAME>_JSON`へ一接続ずつ分割する経路も持つ。

```sh
wrangler secret put MYJCB_CONNECTION_SECRET_NAMES
wrangler secret put MYJCB_ACCOUNT_JCB_W_JSON
wrangler secret put MYJCB_ACCOUNT_RECRUIT_JSON
```

ただし一接続のpasskey session cookie jar自体が5 KBを超える可能性がある。現`session` modeはJSON全体が5 KB以内の場合だけのPoCで、確実に動くとは断言しない。実用案は、local sync CLIがcookie envelopeをclient-side AES-GCMで暗号化してprivate R2へ置き、Worker secretには小さいwrapping keyだけを置く構成である。このencrypted-envelope実装とkey rotationは本PRに含まず、5 KB超sessionはblockerとして停止する。

secret値をsource、`wrangler.jsonc`、`.dev.vars`のcommit、shell引数、stdout、manifestへ入れない。passkey登録済みIDは公式仕様上ID/password loginを使えないため`bootstrapMode=password`で試行しない。まず`passkey` modeを使い、exportされたcredentialが非discoverable、counter非zero、RP mismatch、またはMyJCB/Browser Runで拒否された場合だけ本人bootstrap後の`session`へdowngradeする。Android APIはWeb passkey modeとsession modeが成立しない場合だけのfallbackである。

## read-only policy

active allowlistは次だけである。

| operation | method | path/query | 用途 |
|---|---|---|---|
| login page | GET | `/Login` | protection scriptを含む公式login page bootstrap |
| login submit | POST | `/iss-pc/member/user_manage/Login` | Browser内でform actionを検査して一回だけsubmit |
| mypage | GET | `/iss-pc/member/mypage/mypage.html` | login landing/session確認 |
| credit menu | GET | `/iss-pc/member/details_inquiry/detailMenu.html?link_id=<observed>` | 初期`detailMonth`列挙 |
| credit detail | GET | `/iss-pc/member/details_inquiry/detail.html?detailMonth=0..17&output=web` | 確定／未確定HTML snapshot |
| older availability | POST JSON-RPC | `/iss-pc/general_json/member/details_inquiry/detailPastJson.json` | hidden discriminatorを使いavailable月だけ列挙 |
| credit CSV/OFX | GET | `detail.html?detailMonth=N&output=csv|money` | 確定月の公式export |
| credit PDF | GET | `detailDbPdf.html?detailMonth=N&output=pdf` | 確定月の公式statement PDF |
| debit menu | GET | `/iss-pc/member/debit/details/debitDetailMenu.html?link_id=myj_main_debitDetailMenu` | period列挙 |
| debit detail | GET | `/iss-pc/member/debit/details/debitDetail.html?seq=0..14` | 通常／差額明細 |

以下はread candidateだが**無効**である。

- 既存おまとめIDの表示切替POST
- `detailReplaceJson`（read-likeだがledger取得に不要）
- notice用`detailNewspdf.html`（statement PDFではない）

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

デビットはmenuに実在する`seq=0..14`だけを列挙する。parse不能時は停止し、0〜14をblind走査しない。

クレジット初期menuでは観測された月だけを取得し、`detailPastJson`の9〜17候補は`detailAvailableFlag=true`だけを追加する。例ではolder 9候補中10/13だけがavailableだったため、全offset総当たりをしない。API failureやhidden `generalJsonShikibetuId`欠落時は停止する。JSON-RPCは`method=execute`、`params=[{generalJsonShikibetuId}]`、official JSと同じ`0301006`＋2桁counter形のIDを使う。

`detailMonth=0`はmutable `unconfirmed` snapshotで、exportなしの`.detail-list-01`をHTML＋parsed JSONとして保存する。確定月も同ledger componentを持ち、CSV/OFXと突合できる。export linkがその月のHTMLに実在する場合だけCSV/PDF/OFXを取得し、notice PDFは除外する。CSVはmetadata行の後に現れるexact 12-column headerを探し、CP932 bytesをそのまま保存する。

## R2 layout

```text
raw/myjcb/YYYY/MM/DD/<run-id>/
  manifest.json
  <connection-id>/
    credit-menu.html
    credit-past-months.json
    credit-detail-00.html
    credit-ledger-00.json
    credit-detail-10.html
    credit-ledger-10.json
    credit-10.csv
    credit-10.pdf
    credit-10.ofx
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

live PoCでは`wrangler deploy`、private R2 bucket作成、secret投入、第一connectionの実credential testまで行った。成功runは1 connection、20 artifact、failure 0で、内訳はcredit detail 11、parsed ledger 6、menu 1、過去月JSON 1、discovery 1だった。このrunでは公式CSV/PDF/OFX linkが提示されず、export artifactは0だった。従ってこのconnectionではHTML ledgerが実データsourceとして必要であり、別IDでexportが存在する場合だけ確定月をCSV中心へ最適化する。manifestとsource-preserving artifactはprivate R2へ保存し、実値やsecretはPRへ含めない。

作成済みpersistent resourceはWorker `kogane-myjcb-collector-poc`、private R2 bucket同名、Cron `0 21 * * *`、admin/connection secret群である。Browser Run sessionはconnection完了時にcloseし、永続profileを作らない。廃棄対象一覧はこの4分類と、debug中にR2へ作られたfailed/success manifests以下のobjectsである。廃棄時は先にR2 object一覧と必要artifactの退避を確認してからWorkerを削除し、最後にR2 bucketを削除する。bucket削除は金融sourceを回復不能にするため自動cleanup scriptにはしない。

Cronとmanual triggerのoverlap lockは未実装である。同一IDの同時login/readを避けるため、Durable Object lockまたはQueueによる一接続一実行の直列化をdeploy/merge前要件とする。本PRのPoCをそのままscheduled運用しない。

## synthetic test

`test/fixtures`は架空merchant・架空額・架空token/card番号だけを持つ手書きHTMLであり、MyJCB/Okura/mnieのHTMLをcopyしていない。testはroute allowlist、cross-origin/unknown method拒否、cookie domain/path、card/month parser、token/card番号redactionを検証する。

## public prior art boundary

公開AGPL-3.0実装[youseiushida/Okura](https://github.com/youseiushida/Okura)は、PR #24の2026-08-26調査時点commit `afc6057fba78b5bfd6364654548fbfd91c76692a`と、PoC実装時の2026-08-31 commit `bbf11e032aba4a380009508e91954361a3f9d658`を区別して記録する。後者をlogin protection、origin/path、cookie＋User-Agent維持、デビット15 cycleの現行性照合にだけ使った。Okuraのvalidatorはlogout link＋`toNaviDebitDetailMenu`を要求するためcredit-only valid sessionを失敗扱いにし得る。またprotection runtimeの`node:vm`は[Cloudflare Workersではnon-functional stub](https://developers.cloudflare.com/workers/runtime-apis/nodejs/#non-functional-stub-modules)なので、plain Workerへ移植せずBrowser Runを使う。source、DOM runtime、parser、test fixtureは転用していない。詳細は`THIRD_PARTY_NOTICES.md`を参照。

## 未確認事項

- Browser Run egress/profileでpassword loginが完了するか
- 各実IDがpasswordかpasskeyか、秘密の合い言葉/OTPが出る条件
- 現行mypageのcard enumeration DOMとおまとめ切替contract
- 複数の実ID/issuerでcredit path、ledger DOM、CSV/PDF/OFX schemaが同一か
- zero-row CSV/PDF/OFX response、card/subcard列、取消/返金表現
- debit menu/detailの全issuer互換性、状態label、0件/取消/差額表現
- session idle/absolute TTLとcookie rotation
- Browser Runで得たcookieを通常Worker `fetch`へ移した際、TLS/connection/egress差によってsession replayが拒否されないか
- login protection vendorとchange cadence
- encrypted R2 session envelope、key rotation、overlap lock/Queue

以上は実値を保存しない一回限りのKuebiko/live observationで更新し、unknown時は実装を推測で拡張しない。

## 2026-08-31 public login observationの反映

専用Kuebiko Chromeのlogged-out pageで、`loginForm`のnamed `userId`/`password`に加え、nameのないtext/password decoy candidateが存在することを確認した。このためPoCはinputのtypeや位置でfieldを選ばず、form名とcontrol名を併用する。form actionもsubmit直前にallowlist検査する。

初期画面にはpasswordとpasskeyの両方が通常の選択肢として出るため、初回pageに`passkey`という文字があるだけでは停止しない。password submit後に既知mypageへ到達せず、遷移先でpasskey/OTP/秘密の合い言葉等を検出した場合だけ`human-required`にする。

`login-prot.js?async`のseedはloadごとに変わり、passkey/NNL SDK assetにもversion付きscriptがある。PoCはscript source/version/seedをhard-codeせず、raw captureもcommitしない。観測したversionとprivacy境界は`docs/sources/myjcb.md`へ記録した。
