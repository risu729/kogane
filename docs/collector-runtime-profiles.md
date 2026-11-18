# Collector runtime profiles

This table covers only financial-source collectors deployable to Cloudflare (`services/collector-<source>/`). Research-only Browser Run, Camoufox, Kameleo, OCI, runtime probes, the TAMIA bridge and observation-pipeline UI tests are not collectors and are excluded. Fetching/parsing HTML alone does not count as browser use; classification depends on whether Chrome/Chromium is launched at runtime.

The table identifies each collector by its Worker name, which survives directory moves, rather than by directory name. Current configurations, bindings, crons and buckets are in [`../infra/resources.md`](../infra/resources.md).

| Collector                                                                       | Worker name                         | Browser use                    | Runtime                                               | Where and why the browser is used                                                                                                                     | Work outside the browser                                                |
| ------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [SMCC Vpass](../services/collector-vpass/README.md)                             | `kogane-vpass-collector-poc`        | **None**                       | Worker `fetch`                                        | Not needed: reproduces the Android JSON protocol directly                                                                                             | Authentication, card enumeration, month enumeration, statement JSON, R2 |
| [`SBI証券`](../services/collector-sbi-securities/README.md) (SBI Securities)    | `kogane-sbi-collector-poc`          | **None**                       | Worker `fetch` + cryptography                         | Not needed: implements WebAuthn assertions and official web/app communications directly                                                               | Passkey authentication, session establishment, balances/history, R2     |
| [`Sony銀行`](../services/collector-sony-bank/README.md) (Sony Bank)             | `kogane-sony-bank-collector-poc`    | **None**                       | Worker `fetch`                                        | Not needed: Web BFF, WALLET SSO and HTML/CSV are available over ordinary HTTP                                                                         | Authentication, bank API, WALLET month changes, R2                      |
| [`Vポイント`](../services/collector-vpoint/README.md) (V Point)                 | `kogane-vpoint-collector-poc`       | **None**                       | Worker `fetch` + Email Worker + Durable Object        | Not needed: reproduces the form chain/email verification over HTTP and retains the session in a DO                                                    | Authentication, JSON API, session refresh, R2                           |
| [MyJCB](../services/collector-myjcb/README.md)                                  | `kogane-myjcb-collector-poc`        | **Login only**                 | **Browser Run binding** + Worker `fetch`              | Runs the dynamic login-protection script and NNL WebAuthn `result` within the official page to create a mypage session                                | Post-login menus, month enumeration, statement HTML/export, R2          |
| [PRESTIA GLOBAL PASS](../services/collector-globalpass/README.md)               | `kogane-globalpass-collector-poc`   | **Entire collection**          | **Container Playwright Google Chrome**                | Handles Turnstile, JavaScript login, server-rendered statements and month selectors in a real browser                                                 | Worker orchestration, TAMIA relay, NDJSON reception, R2                 |
| [`みずほ銀行`](../services/collector-mizuho/README.md) (Mizuho Bank)            | `kogane-mizuho-collector`           | **None**                       | Worker `fetch`                                        | Not needed: password login, account list and history pages are ordinary HTTP                                                                          | Password login, account list, history HTML, R2                          |
| [Mobile Suica](../services/collector-mobile-suica/README.md)                    | `kogane-mobile-suica-collector-poc` | **Login only**                 | **Browser Run binding** + Worker `fetch`              | Runs JRE ID's own page processing and passkey WebAuthn with a CDP virtual authenticator, then the member menu's JavaScript POST to the history screen | History form POST, sanitizing, R2                                       |
| [Money Forward ME](../services/collector-moneyforward/README.md)                | `kogane-moneyforward-collector-poc` | **None**                       | Worker `fetch` + cryptography                         | Not needed: signs the passkey assertion in the Worker; pages are ordinary HTML responses                                                              | Passkey authentication, account list/details, monthly fragments, R2     |
| [PRESTIA bank](../services/collector-prestia-bank/README.md)                    | `kogane-prestia-bank-collector`     | **None**                       | Worker `fetch`                                        | Not needed: the mobile login form and balance page are ordinary HTTP                                                                                  | Login, balance page, sign-off, R2                                       |
| [`SBI新生銀行`](../services/collector-sbi-shinsei/README.md) (SBI Shinsei Bank) | `kogane-sbi-shinsei-collector-poc`  | **Entire collection**          | **Container Playwright Google Chrome**                | Runs CAFIS generation, the bank page's own login, Authorization/CSRF and reads in one page; login rebuilt with direct `fetch` returned 403            | Worker orchestration, TAMIA relay, handoff validation, R2               |
| [SBI VC Trade](../services/collector-sbi-vc-trade/README.md)                    | `kogane-sbi-vc-session-poc`         | **None**                       | Worker `fetch` + cryptography + Durable Object        | Not needed: passkey login and session keepalive are ordinary HTTP; the session is retained in a DO                                                    | Passkey login, 15-minute keepalive, read allowlist, R2                  |
| [SMBC Direct](../services/collector-smbc-direct/README.md)                      | `kogane-smbc-direct-backfill-poc`   | **None**                       | Worker `fetch` over TAMIA VPC + Durable Object alarms | Not needed: a person approves the QR in the SMBC app; login and monthly reads are ordinary HTTP                                                       | QR session, monthly backfill chunks, R2                                 |
| [St.George](../services/collector-st-george/README.md)                          | `kogane-st-george-collector`        | **Entire collection**          | **Container Playwright Chromium**                     | Submits the bank's normal login form through its own field and button handling, then reads the portfolio and history pages                            | Worker orchestration, TAMIA relay, DO serialization, R2                 |
| [V Point Pay](../services/collector-vpoint-pay/README.md)                       | `kogane-vpoint-pay-collector-poc`   | **None** (collection disabled) | Worker `fetch` + Durable Object, neither reachable    | Not needed: the disabled app-API path is ordinary HTTP, and no route runs it                                                                          | None while disabled; only `GET /health` answers                         |

Each row summarizes the `Runtime profile` section of that collector's README,
which also records its schedule, execution lease, Durable Objects, storage,
retries and budgets as its `wrangler.jsonc`, `cloudflare.config.ts`,
`src/schedule-entrypoint.ts`, `Dockerfile` (where one exists) and
[`config/alarm-jobs.json`](../config/alarm-jobs.json) entry define them. No
collector's `wrangler.jsonc` sets `limits`, so the CPU and subrequest budgets in
effect are not recorded in the repository.

Two rules are shared by every collector that the Processor's `ScheduleAlarm`
calls. The execution lease (`withCollectionLease`,
`packages/collection/src/schedule-lease.ts`) lets one execution per source run
at a time and stops it 13 minutes after its claim. The alarm retries a
collection occurrence at most once, and only one that was never dispatched
(`retryableOccurrence`, `services/processor/src/schedule-store.ts`).

The GLOBAL PASS Worker also has a Browser Run binding, but its former `/browser-probe` entrypoint is retired and the binding is unused. Normal daily collection uses Container Chrome. MyJCB instead closes Browser Run immediately after session bootstrap and uses only ordinary Worker `fetch` afterward.

<a id="新しいcollectorで必ず明記する項目"></a>

## Required information for a new collector

Place `Runtime profile` at the start of each collector README and state:

1. One of `Browser: none / login only / entire collection`.
2. Whether the actual runtime is a Browser Run binding, Container Chrome/Chromium or an external browser.
3. The specific reason a browser is needed. A WAF name alone is insufficient: identify which work it handles, such as WebAuthn, Turnstile, a dynamic script or rendered navigation.
4. The boundary where ordinary `fetch` takes over after obtaining a session, and the data captured in the browser.
5. If only diagnostics/probes use a browser, distinguish them explicitly from production collection.

Using Kogane Capture Chrome during research, parsing HTML, or sending a browser-derived User-Agent alone is not a runtime browser dependency.

<a id="終了した-browser-実験"></a>

## Retired browser experiments

Research browser runtimes absent from this table have their findings and stopping reasons in [`research/`](research/), with their code removed from main. Ongoing experiments have an owner, deadline and stopping conditions in `experiments/<name>/EXPERIMENT.md`.
