# SBI新生銀行 PowerDirect transport investigation — 2026-08-31

## Evidence boundary

This note separates three evidence levels:

1. **Official public documentation**: product coverage, history periods, desktop CSV/PDF availability and documented authentication behavior.
2. **Public login JavaScript**: client transport names, candidate adapter/procedure paths, token rotation and login parameter names visible before authentication.
3. **Authenticated capture**: a user-controlled Kuebiko run completed after the initial skeleton. Login, session bootstrap and selected reads returned 200 without OTP, FIDO or Turnstile. Values remain excluded; exact response schemas still require sanitized validators.

No credential, account number, session token, cookie, customer identity, balance, transaction, screenshot, HAR or bank response is included here or in fixtures.

## Confirmed public transport shape

The current PowerDirect frontend uses an IBM MobileFirst/WLClient-style JSON transport under `https://bk.web.sbishinseibank.co.jp/SFC/`. Public client code constructs JSON `POST` requests as `/SFC/app/{adapter}/{procedure}`. The browser keeps a session token in `sessionStorage`, sends it in the `Authorization` header and accepts a rotated token from the response header `newToken`.

This is transport evidence only. It does not prove that a token can be moved to another runtime or that a route has no side effects. The authenticated run additionally showed `X-CSRF-Token` on session reads.

### Read candidates found in the public bundle

| Operation ID | Exact path | Intended UI family | Current state |
| --- | --- | --- | --- |
| `top.accounts-balance-and-activity` | `/SFC/app/IFTP_TopAdapter/getAccountsBalanceAndActivity` | top-page balances/activity | disabled; response unknown |
| `top.balance-summary-and-stage` | `/SFC/app/IFTP_TopAdapter/getBalanceSummaryAndStage` | summary/stage | disabled; response unknown |
| `common.account-information-list` | `/SFC/app/IFCM_CommonAdapter/getAccountInformationListDisplay` | account information list | disabled; response unknown |
| `common.product-description` | `/SFC/app/IFCM_CommonAdapter/getProductDescription` | product labels/descriptions | disabled; response unknown |
| `account.information-others` | `/SFC/app/IFAI_AccountAdapter/getAccountInformationOthersDisplay` | other account information | disabled; response unknown |
| `account.casa-activity-specific-period` | `/SFC/app/IFAI_AccountAdapter/getCasaAccountActivitySpecificPeriod` | selected-period savings activity | disabled; response unknown |
| `account.account-list` | `/SFC/app/AIAI_AccountInfomationAdapter/getAccountList` | account list | disabled; response unknown |
| `account.inbox-list` | `/SFC/app/AIAI_AccountInfomationAdapter/getInboxList` | inbox/notices | disabled; response unknown |
| `yen-deposit.product-details` | `/SFC/app/AIYD_YenDepositAdapter/getYenProductDetails` | yen deposit holdings | disabled; response unknown |
| `yen-deposit.account` | `/SFC/app/AIYD_YenDepositAdapter/getYenDepositAccount` | yen deposit account | disabled; response unknown |
| `csv.download` | `/SFC/adapters/IFAI_CsvDownloadAdapter/csvDownload/getCsv` | desktop CSV export | disabled; response/body unknown |

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

Observed field names are `fldUserID`, `password`, `langCode`, `mode`, `postubFlag`, `jsc`, `forward` and `userAgentInfo`. The implementation does **not** submit this form. `jsc` is populated from CAFIS Brain `dtokeninfo`, and the login surface also references ThreatMetrix, Transmit Security and Akamai-related sensor/risk components. Reproducing visible field names alone would be guessing and could cause repeated failed authentication or risk scoring.

The credential secret type is deliberately narrow—branch number, account number and PowerDirect password—but is not read yet. FIDO, SMS or telephone values are never collector secrets. Protected-operation approval is out of scope.

The authenticated capture established this symbolic token sequence without retaining values:

1. Login has neither Authorization nor CSRF. Its JSON body contains `responseJSON.authStatus` and `responseJSON.token`; the HTTP response supplies `authorization`.
2. `securityConnect` and `validateToken` use login `responseJSON.token` as `X-CSRF-Token` and the login response authorization as `Authorization`.
3. `validateToken.header.newToken` becomes `X-CSRF-Token` for subsequent reads. The login authorization remains unchanged in the observed batch.
4. No later token rotation was observed in this initial run, so the client must not invent one. A future observed rotation must be handled before enabling concurrency.

`securityConnect`, `validateToken`, both top reads and `getExchangeRate` had no request body. `getYenDepositAccount` had exactly `{requestParam:{screenGroupID}}`; the stable value/source of `screenGroupID` still needs to be derived rather than hardcoded from a live sample.

The PoC models Authorization and CSRF separately, rotates CSRF only from the validated `validateToken` body, and supplies builders for the observed no-body and yen-deposit shapes. It still omits login because generating CAFIS `jsc` outside the accepted browser is unproved.

## Fail-closed implementation

Before `fetch`, the PoC resolves an operation in the static catalog, checks a write denylist, requires exact method/origin/path with no query/hash/URL credentials, then requires authenticated validation, production enablement and a registered response schema. Captured routes are marked `liveValidated: true`; public-bundle-only candidates remain `false`. Every route is still `productionEnabled: false`, and tests assert zero fetch calls.

Once a route is enabled, transport behavior is also bounded:

- `redirect: "manual"`; every 3xx is an authentication boundary;
- stop on 401/403 without credential retry;
- accept only listed JSON media types;
- stream with a 2 MiB limit, not unbounded buffering;
- require strict operation-specific validation before rotating `newToken`;
- never put unknown responses into R2 or logs.

The synthetic normalized fixture is not a claimed bank schema. It only fixes a tentative Kogane model for separate yen savings, Hyper Yokin, foreign savings and deposits while preserving native currency, optional yen equivalent and explicit `asOf`.

## R2 and schedule behavior

The Worker uses a dedicated R2 binding and source prefix. A scheduled or manual run currently writes a sanitized failure manifest and returns/throws failure. This prevents an unvalidated collector from looking healthy because it made no request.

The proposed daily schedule is 21:00 UTC / 06:00 JST. No Worker, R2 bucket, secret or Cron is deployed by this branch.

## Authenticated validation required next

1. Use a dedicated visible Kuebiko/Chrome profile; stop on challenge or access denial.
2. User completes login. Do not commit login body, tokens, cookies or storage values.
3. Open top-page balance, yen activity, Hyper Yokin activity, one foreign-currency activity and yen-deposit holdings separately.
4. Use desktop CSV for a small period. Never use memo edit, transfer, FX, deposit creation/cancellation or settings.
5. Record only method/host/path, sanitized key names, content type, bounded size and UI row count.
6. Produce a synthetic fixture preserving types/optional keys while replacing every identifier, text and amount.
7. Replay at most once in the same authenticated browser context and compare UI/export row count. Stop on redirect, 401, 403 or challenge.
8. Measure token rotation and session expiration without moving the session to cloud infrastructure yet.

Only then should a follow-up change add one exact body builder and validator at a time.

## Android archive boundary

The Play package is `com.shinseibank.powerdirect`. User-authorized split APKs, signing metadata and decompiled output belong in the private Android archive repository, not this public Kogane PR. A parallel archive task handles that provenance. This branch contains only sanitized public-source findings.
