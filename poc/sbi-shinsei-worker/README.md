# SBI新生銀行 Worker collector PoC

SBI新生銀行 PowerDirect の read-only collector を Kogane 内で独立実装するための骨格です。
`mnie` は dependency にせず、既存 Kogane collector と同じ R2 raw-store / manifest / daily Cron / authenticated manual trigger の境界だけを採用します。

## 現在の重要な制限

**この branch は deploy しません。また、実口座への network request は意図的に無効です。**

公開 login bundle と Kuebiko capture から MobileFirst/WLClient 形式の read route、session/CSRF token topology、core response schema を確認しました。しかし、CAFIS Brain の `jsc` を含む login を direct client で再現できるかはまだ検証していません。そのため:

- production login は未実装です。
- route catalog は exact-origin / exact-path / exact-method です。2026-08-31 の Kuebiko capture で 200 を確認した route は `liveValidated: true`、公開 bundle だけの候補は `false` です。ただし全 entry が `productionEnabled: false` のため実 request は行いません。
- transport は allowlist 判定を fetch より前に行い、現状では必ず fail closed します。
- unknown content type、oversize body、JSON parse failure、未登録 schema は保存・解釈せず停止します。
- transfer、振込、振替、FX、定期預金作成・解約、memo/settings 等の write route は catalog に存在せず、path denylist でも拒否します。

詳細な観測根拠と次の capture 手順は [`INVESTIGATION-2026-08-31.md`](./INVESTIGATION-2026-08-31.md) に記録しています。

## Worker surface

| Trigger | Behavior |
| --- | --- |
| `GET /health` | schema version、source、live-read readiness のみ返す。 |
| `POST /trigger?from=YYYY-MM-DD&to=YYYY-MM-DD` | `Authorization: Bearer <ADMIN_TRIGGER_TOKEN>` 必須。現状は network call なしで failure manifest を R2 に保存して 503。 |
| Cron `0 21 * * *` | 毎日 06:00 JST。現状は failure manifest を保存して invocation を失敗させ、未検証 collector が silent success しないようにする。 |

R2 key:

```text
raw/sbi-shinsei/YYYY/MM/DD/<run-id>/manifest.json
raw/sbi-shinsei/YYYY/MM/DD/<run-id>/<verified artifact>
```

unknown response や authentication response body は R2 に保存しません。artifact 保存は response schema が fixture と authenticated capture の双方で固定された後にのみ有効化します。

Kuebiko capture で得た core response の field-name topology は synthetic fixture と strict validator に反映済みです。1 sample だけなので known field を optional として扱う箇所がありますが、unknown field、unknown nested item、unknown schema は拒否します。validator実装だけでは route を有効化せず、exact request builder と local direct-client success も必要です。

## Secret bindings

deploy 前に Cloudflare secret として設定する想定です。値を repository、`.dev.vars`、log、PR に入れません。

- `SBI_SHINSEI_CREDENTIAL_JSON`
  - `{ "branchNumber": "...", "accountNumber": "...", "powerDirectPassword": "..." }`
- `ADMIN_TRIGGER_TOKEN`

`SBI_SHINSEI_CREDENTIAL_JSON` は login transport が検証されるまで読み取りません。FIDO、SMS、telephone approval の値は collector secret に含めません。

## Local verification

```bash
bun install --frozen-lockfile
bun test
bun run typecheck
bun run cf:check
```

`cf:check` は dry-run だけで、deploy しません。

## Enablement checklist

catalog entry を production で有効にするには、同じ commit/PR で以下が必要です。

1. 専用 Kuebiko/Chrome profile の authenticated capture で exact method/origin/path/body names を確認。
2. read-only UI action と request の一対一対応を確認し、write side effect がないことを確認。
3. response content type、maximum size、required/optional keys、error/login-redirect shapes を sanitized synthetic fixture に落とす。
4. `newToken` rotation と 401/403/challenge/login redirect の stop behavior を test する。
5. credential、token、cookie、account number、customer name、real amount を capture note/fixture/log から除外。
6. same-session で一度だけ replay し、UI/export の行数・意味と一致することを確認。

この checklist を満たさない entry は daily/manual trigger から到達できません。
