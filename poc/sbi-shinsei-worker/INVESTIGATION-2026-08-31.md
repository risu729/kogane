# SBI新生銀行 PowerDirect transport investigation — 2026-08-31

## Evidence boundary

This note separates three evidence levels:

1. **Official public documentation**: product coverage, history periods, desktop CSV/PDF availability and documented authentication behavior.
2. **Public login JavaScript**: client transport names, candidate adapter/procedure paths, token rotation and login parameter names visible before authentication.
3. **Authenticated capture/local execution**: a user-controlled Kuebiko run and the corrected same-page local collector completed login, session bootstrap and four core reads with 200 responses, without OTP, FIDO or Turnstile. Browser Run and Linux Container trials are recorded separately and have not established an unattended cloud success. Values remain excluded; captured response shapes are represented by sanitized strict validators.

No credential, account number, session token, cookie, customer identity, balance, transaction, screenshot, HAR or bank response is included here or in fixtures.

## Confirmed public transport shape

The current PowerDirect frontend uses an IBM MobileFirst/WLClient-style JSON transport under `https://bk.web.sbishinseibank.co.jp/SFC/`. Public client code constructs JSON `POST` requests as `/SFC/app/{adapter}/{procedure}`. The browser keeps a session token in `sessionStorage`, sends it in the `Authorization` header and accepts a rotated CSRF token from JSON `header.newToken`.

This is transport evidence only. It does not prove that a token can be moved to another runtime or that a route has no side effects. The authenticated run additionally showed `X-CSRF-Token` on session reads.

### Read candidates found in the public bundle

| Operation ID                            | Exact path                                                          | Intended UI family               | Current state                                                    |
| --------------------------------------- | ------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `top.accounts-balance-and-activity`     | `/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity`            | top-page balances/activity       | authenticated 200; strict schema; enabled in same-page collector |
| `top.balance-summary-and-stage`         | `/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage`                | summary/stage                    | authenticated 200; strict schema; enabled in same-page collector |
| `common.account-information-list`       | `/SFC/app/IFCM_CommonAdapter/getAccountInformationListDisplay`      | account information list         | disabled; response unknown                                       |
| `common.product-description`            | `/SFC/app/IFCM_CommonAdapter/getProductDescription`                 | product labels/descriptions      | disabled; response unknown                                       |
| `account.information-others`            | `/SFC/app/IFAI_AccountAdapter/getAccountInformationOthersDisplay`   | other account information        | disabled; response unknown                                       |
| `account.casa-activity-specific-period` | `/SFC/app/IFAI_AccountAdapter/getCasaAccountActivitySpecificPeriod` | selected-period savings activity | disabled; response unknown                                       |
| `account.account-list`                  | `/SFC/app/AIAI_AccountInfomationAdapter/getAccountList`             | account list                     | disabled; response unknown                                       |
| `account.inbox-list`                    | `/SFC/app/AIAI_AccountInfomationAdapter/getInboxList`               | inbox/notices                    | disabled; response unknown                                       |
| `yen-deposit.product-details`           | `/SFC/app/AIYD_YenDepositAdapter/getYenProductDetails`              | yen deposit holdings             | disabled; response unknown                                       |
| `yen-deposit.account`                   | `/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount`              | yen deposit account              | authenticated 200; strict schema; enabled in same-page collector |
| `csv.download`                          | `/SFC/adapters/IFAI_CsvDownloadAdapter/csvDownload/getCsv`          | desktop CSV export               | disabled; response/body unknown                                  |

`AIAI_AccountInfomationAdapter` retains the spelling observed in the public client. It is not corrected because the catalog requires exact paths.

These route names are enough to design a deny-by-default client boundary, but not enough to make a production call. A `get...` name is not proof of read-only behavior; request bodies may carry workflow state; and CSV content type, encoding, maximum size and errors have not been captured.

### Authenticated 200 observations

The same-session Kuebiko capture confirmed 200 responses for:

- bootstrap: `IFCM_CommonAdapter/securityConnect`, `IFCM_CommonAdapter/validateToken`;
- core reads: `IFTP_TopAdapter/getAccountsBalanceAndActivity`, `IFTP_TopAdapter/getBalanceSummaryAndStage`, `IFCM_CommonAdapter/getExchangeRate`, `AIYD_YenDepositAdapter/getYenDepositAccount`;
- ancillary reads: `IFCM_CommonAdapter/getApplicationInformationList`, `AIAI_AccountInfomationAdapter/getInboxList`, `AICM_CommonAdapter/getUiuxFlag`, `IFEM_EmailAdapter/getEmailAddress`.

`IFCM_CommonAdapter/sendActivityLog` also returned 200, but it is telemetry/write-like and is deliberately absent from the allowlist. A 200 is evidence that a route was exercised, not permission to schedule it.

## Login and bot/risk boundary

The public login client targets:

```text
POST /SFC/app/ShinseiAuthenticatorRealm/login_auth_request_url
```

Observed field names are `fldUserID`, `password`, `langCode`, `mode`, `postubFlag`, `jsc`, `forward` and `userAgentInfo`. The authenticated capture confirms the Japanese adapter language code is `JAP` (not the tempting but incorrect `JPN`). `jsc` is populated from CAFIS Brain `dtokeninfo`, and the login surface also references ThreatMetrix, Transmit Security and Akamai-related sensor/risk components.

The credential secret type is deliberately narrow—branch number, account number and PowerDirect password. The local CLI accepts it through stdin, an environment variable or a mode-0600 local file; it never accepts credential values as CLI arguments. FIDO, SMS or telephone values are never collector secrets. Protected-operation approval is out of scope.

The authenticated capture established this symbolic token sequence without retaining values:

1. Login has neither Authorization nor CSRF. Its JSON body contains `responseJSON.authStatus` and `responseJSON.token`; the HTTP response supplies `authorization`.
2. `securityConnect` and `validateToken` use login `responseJSON.token` as `X-CSRF-Token` and the login response authorization as `Authorization`.
3. `validateToken.header.newToken` becomes `X-CSRF-Token` for subsequent reads. The login authorization remains unchanged in the observed batch.
4. No later token rotation was observed in this initial run, so the client must not invent one. A future observed rotation must be handled before enabling concurrency.

The accepted browser also supplied the risk/session cookie jar. The initial
login/index navigation created the Akamai cookies `_abck`, `ak_bmsc`, `bm_mi`,
`bm_sv` and `bm_sz`; successful login added `AWSELB` and `JSESSIONID`. The
official client created `_sb.pcd` on the bank domain after `securityConnect` and
before later bootstrap traffic. The response did not set that cookie, so it is a
client-side action in the observed run. The application also calls
`sendActivityLog`, but that telemetry/write-like procedure remains outside this
collector's allowlist. The same-context path intentionally reuses the accepted
page's existing Akamai/browser jar. If later validation proves `_sb.pcd` is
mandatory, the next step is to invoke the official read bootstrap that creates
it—not to synthesize a cookie value or expose a generic telemetry caller.

`securityConnect`, `validateToken`, both top reads and `getExchangeRate` had no request body. `getYenDepositAccount` had exactly `{requestParam:{screenGroupID:"CTYD0004"}}`; it is represented by a fixed request builder rather than a generic procedure caller.

The diagnostic HTTP transport models Authorization and CSRF separately and rotates CSRF from any validated root `header.newToken`. The preferred local collector keeps CAFIS generation, credential submission, Authorization/CSRF state and all reads inside one Chrome target. Only the four validated final read JSON bodies cross CDP into the local artifact writer.

### Bounded automated login result

The first same-Chrome-context automated login made exactly one credential POST and stopped at HTTP 200 / application error `CME0001`. Sanitized comparison against the successful Kuebiko request showed identical credential fields, mode, post-login flag, forward value and user agent. The only fixed-field mismatch was the implementation's guessed `langCode=JPN`; the successful client uses `JAP`. The code and synthetic test were corrected to `JAP`, the failed CAFIS value is cleared from `#dtokeninfo`, and no automatic retry was made. This result does not establish an Akamai or browser-integrity rejection.

The corrected local same-page run then completed login, `securityConnect`, `validateToken` and all four core reads with HTTP 200 and stored only validated raw/normalized artifacts. This proves the orchestration and schema boundary in the accepted local Chrome context; it does not prove that an unattended Cloudflare runtime has the same risk acceptance.

## Fail-closed implementation

Before browser launch, the PoC resolves each required operation in the static catalog, checks a write denylist, requires exact method/origin/path with no query/hash/URL credentials, authenticated validation, a registered response schema and production enablement. Only two bootstrap and four core routes pass. The generic direct-HTTP transport remains disabled and tests assert zero direct fetch calls.

The current Worker delegates the browser boundary to one Cloudflare Container per run. CAFIS, credential submission and all session reads remain in one page inside the Container. The page returns one bounded JSON envelope containing only the four final raw response texts; Worker code parses it, applies the operation-specific strict validators and then writes R2. Container destruction is in `finally`, and 401/403/429, redirects, challenges, rejected auth and unknown shapes stop without retry. The earlier Browser Run implementation is investigation history, not the current runtime.

Once a route is enabled, transport behavior is also bounded:

- `redirect: "manual"`; every 3xx is an authentication boundary;
- stop on 401/403 without credential retry;
- accept only listed JSON media types;
- stream with a 2 MiB limit, not unbounded buffering;
- require strict operation-specific validation before atomically adopting an optional root `header.newToken` from any known response;
- never put unknown responses into R2 or logs.

The synthetic normalized fixture is not a claimed bank schema. It only fixes a tentative Kogane model for separate yen savings, Hyper Yokin, foreign savings and deposits while preserving native currency, optional yen equivalent and explicit `asOf`.

## Cloud runtime validation status

The corrected Kuebiko same-context collector is the positive control: it completed login, both bootstrap calls and all four core reads in one accepted local Chrome context.

The bounded Cloudflare Browser Run trials opened both the official public entry route and the direct login route. In both cases navigation timed out before the CAFIS object became ready. No credential-bearing login POST was made, so these trials do not show a credential rejection or a login HTTP status. Browser Run was removed from the active runtime rather than retried indefinitely.

The first deployed Container image did not listen on its service port because `xvfb-run` was used as the startup wrapper and the Node server never became available. This was a Container startup defect, not a bank response. The image was changed to run Node as PID 1 and start Xvfb internally before browser work.

After that startup fix, local Container trials reached the login request with stable Google Chrome. The following direct-fetch configurations each received HTTP 403 at login:

1. plain Linux Chrome;
2. Chrome with Windows-matched UA, platform and client hints;
3. the same Windows-facing values plus `navigator.webdriver` hidden and `--disable-blink-features=AutomationControlled`.

The final local comparison used Docker, stable Google Chrome, its native Linux fingerprint and a Japanese egress while NRT/WARP was connected. A direct-fetch login remained HTTP 403 both before and after attaching CDP late. Patchright did not produce a login result because its main-world execution differed in a way that left the CAFIS collector unavailable.

The successful local topology kept the same late-CDP Chrome but did not reconstruct login with direct fetch. It filled the real form fields continuously and activated the real submit control, causing the bank page's own `login()` path to run. Login returned HTTP 200. The resulting page automatically issued `securityConnect`; Container code then retained the login Authorization and initial CSRF inside the same page, explicitly ran `validateToken`, adopted the validated rotated token, and issued the four allowlisted core reads. All four reads succeeded and only their validated response envelope crossed the page boundary.

This result rejects two stronger hypotheses as sole explanations. Windows fingerprinting was not required in this accepted run, and network location alone cannot explain the 403/200 split because both local paths shared the same Japanese egress. This does not establish that an overseas egress would be accepted. It also narrows the implementation contract: late CDP alone is insufficient, while passing through the bank page's own form/login processing is required by the currently successful topology. The exact internal difference between that path and the rejected direct fetch is not yet isolated.

### Deployed egress comparison and accepted live run

The APAC-placed Container was first deployed with direct Internet egress and no TAMIA path. After the new image was running, that topology still reached HTTP 403 at login. The accepted deployment reuses the already bounded GLOBAL PASS relay topology rather than adding a new proxy protocol:

1. Chrome sends HTTPS through an HTTP CONNECT listener bound only inside the Container;
2. the listener opens an authenticated WebSocket to the Worker's `/tcp` endpoint;
3. the Worker validates the relay bearer and exact destination allowlist;
4. the Worker opens the TCP socket through its VPC binding, configured with TAMIA's explicit `tunnel_id`.

Because the VPC binding names the tunnel directly, this collector path does not add or change a public hostname route and does not force the user's personal WARP traffic through TAMIA. The relay permits only TCP port 443 to these exact hosts:

- `bk.web.sbishinseibank.co.jp`;
- `www.sbishinseibank.co.jp`;
- `distribute.cafisbrain.com`;
- `diproxy.cafisbrain.com`;
- `platform-websdk.transmitsecurity.io`.

Cloudflare live run `0e999a32-6994-450e-a495-2daff0e7aeb1` completed with `status=success`, zero failures and five artifacts: four validated raw responses plus one normalized artifact. Independent metadata checks found every recorded hash valid and every byte count greater than zero. The run's Container instance was inactive afterward. Verification did not read artifact bodies, balances, transactions, credentials, cookies, Authorization or CSRF/token values.

The preceding failure manifests remain as rollout evidence rather than being rewritten: two cold/listen failures during Container rollout, one direct-Container login HTTP 403, and two failures that reached an older response shape while the TAMIA image revision was still rolling out.

## R2 and schedule behavior

The Worker uses dedicated Container, VPC and R2 bindings plus a source prefix. A scheduled or manual run launches one isolated Container, stores five validated artifacts plus a manifest on success, or a sanitized failure manifest on failure. The Worker, three secrets, R2 bucket, Cron, Container application/image revisions and explicit-tunnel VPC configuration are deployed. The successful live manifest above proves one complete run, not long-term reliability.

The daily schedule is 21:00 UTC / 06:00 JST. The accepted live run used the TAMIA relay path; direct APAC Container egress remains rejected at login.

## Further validation remaining

1. Measure repeat scheduled-run reliability and session timing without falling back to direct-fetch login or adding automatic credential retries.
2. Separately validate the top-page, yen activity, Hyper Yokin activity, one foreign-currency activity and yen-deposit holdings against their user-visible meaning without recording values.
3. Use desktop CSV for a small period and verify only sanitized schema, row-count and range behavior. Never use memo edit, transfer, FX, deposit creation/cancellation or settings.
4. Verify one current and one older electronic report through metadata/schema notes only; do not commit the PDF.
5. Continue to stop on redirect, 401, 403, 429, challenge or non-success auth state and retain sanitized failure manifests.

## Cleanup inventory

The active PoC resources are intentionally retained for the scheduled collector and validation history. A later teardown must remove the Worker and `0 21 * * *` Cron, the SBI credential/admin-trigger/relay secrets, the R2 bucket including success/failure manifests and artifacts, the Container application and image revisions, and the explicit-tunnel VPC binding configuration. The local Docker test Container/image should also be removed after local validation is no longer needed.

Any additional route still requires one exact body builder, one strict validator and an accepted-browser-context validation before schedule enablement.

## Android archive boundary

The Play package is `com.shinseibank.powerdirect`. User-authorized split APKs, signing metadata and decompiled output belong in the private Android archive repository, not this public Kogane PR. A parallel archive task handles that provenance. This branch contains only sanitized public-source findings.
