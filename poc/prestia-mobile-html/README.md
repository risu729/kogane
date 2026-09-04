# PRESTIA Mobile HTML PoC

SMBC信託銀行アプリ 1.4.0 の静的解析結果を、ブラウザなしのread-onlyクライアントとして最小再現するPoCです。独立したJSON APIではなく、モバイルIBのHTML、hidden form、cookieを順番に処理します。

## 安全境界

- 初期GETが正常なときだけID・パスワードを1回送信する
- 資格情報POST後のredirectは追跡せず、ID・パスワードを再送しない
- 資格情報なしのbootstrapだけ同一host内redirectを許可し、各hopのcookieを保存する
- OTP要求、拒否、ログインフォーム再表示時は再試行せず停止する
- 取引、振込、設定変更のendpointは実装しない
- レスポンス本文、cookie、token、口座番号、残高、ID・パスワードを保存・表示しない
- 成功時は口座一覧を1回読み、可能なら明示的にsignoffする

資格情報なしの確認:

```bash
bun install --frozen-lockfile
bun run probe --bootstrap-only
```

実アカウント確認は対話式で実行します。自動実行では、資格情報を引数や環境変数ではなくstdinのJSONで渡せます。

```bash
read -rsp 'one-shot credential JSON: ' one_shot_json
printf '%s' "$one_shot_json" | bun run probe --stdin-json
unset one_shot_json
```

stdoutにはstatus、フォーム名、cookie受信数、口座行数など値を含まない要約だけを出します。実データ収集を実装する前段階なので、このPoCは認証条件とHTML schemaの検証に限定しています。

## 静的解析との対応

| 処理 | endpoint |
|---|---|
| 初期フォーム | `GET /ib/portal/POSNIN1prestiatop.prst` |
| ID・パスワード | `POST /ib/portal/POSNIN1next.prst` |
| OTP（検出のみ） | `POST /ib/authentication/AUOTIN1next1.prst` |
| 認証後home | `GET /ib/portal/POSNIN1prestiatop.prst` |
| 残高一覧 | `POST /ib/top/TOMETOPaccountinfokozazandaka.prst` |
| signoff | `POST /ib/top/TOMETOPportalsignoff.prst` |

アプリはAndroid WebView UAに加え、`X-FORWARDED-UA` header/cookie、Caulis FraudAlert、host別Basic認証を持ちます。このPoCはまず公開モバイル入口で必要な最小条件を検証します。初期GETまたは認証で拒否される場合だけ、アプリ埋め込み条件とAndroid相当TLSを段階的に追加します。
