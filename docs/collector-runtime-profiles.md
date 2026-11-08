# Collector runtime profiles

This table covers only financial-source collectors deployable to Cloudflare (`services/collector-<source>/`). Research-only Browser Run, Camoufox, Kameleo, OCI, runtime probes, the TAMIA bridge and observation-pipeline UI tests are not collectors and are excluded. Fetching/parsing HTML alone does not count as browser use; classification depends on whether Chrome/Chromium is launched at runtime.

The table identifies each collector by its Worker name, which survives directory moves, rather than by directory name. Current configurations, bindings, crons and buckets are in [`../infra/resources.md`](../infra/resources.md).

| Collector                                                                    | Worker name                       | Browser use           | Runtime                                        | Where and why the browser is used                                                                                      | Work outside the browser                                                |
| ---------------------------------------------------------------------------- | --------------------------------- | --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [SMCC Vpass](../services/collector-vpass/README.md)                          | `kogane-vpass-collector-poc`      | **None**              | Worker `fetch`                                 | Not needed: reproduces the Android JSON protocol directly                                                              | Authentication, card enumeration, month enumeration, statement JSON, R2 |
| [`SBI証券`](../services/collector-sbi-securities/README.md) (SBI Securities) | `kogane-sbi-collector-poc`        | **None**              | Worker `fetch` + cryptography                  | Not needed: implements WebAuthn assertions and official web/app communications directly                                | Passkey authentication, session establishment, balances/history, R2     |
| [`Sony銀行`](../services/collector-sony-bank/README.md) (Sony Bank)          | `kogane-sony-bank-collector-poc`  | **None**              | Worker `fetch`                                 | Not needed: Web BFF, WALLET SSO and HTML/CSV are available over ordinary HTTP                                          | Authentication, bank API, WALLET month changes, R2                      |
| [`Vポイント`](../services/collector-vpoint/README.md) (V Point)              | `kogane-vpoint-collector-poc`     | **None**              | Worker `fetch` + Email Worker + Durable Object | Not needed: reproduces the form chain/email verification over HTTP and retains the session in a DO                     | Authentication, JSON API, session refresh, R2                           |
| [MyJCB](../services/collector-myjcb/README.md)                               | `kogane-myjcb-collector-poc`      | **Login only**        | **Browser Run binding** + Worker `fetch`       | Runs the dynamic login-protection script and NNL WebAuthn `result` within the official page to create a mypage session | Post-login menus, month enumeration, statement HTML/export, R2          |
| [PRESTIA GLOBAL PASS](../services/collector-globalpass/README.md)            | `kogane-globalpass-collector-poc` | **Entire collection** | **Container Playwright Google Chrome**         | Handles Turnstile, JavaScript login, server-rendered statements and month selectors in a real browser                  | Worker orchestration, TAMIA relay, NDJSON reception, R2                 |

Limit: the table lists only the six collectors whose README carries a
`Runtime profile` section. The other nine deployable collectors
(`kogane-mizuho-collector`, `kogane-mobile-suica-collector-poc`,
`kogane-moneyforward-collector-poc`, `kogane-prestia-bank-collector`,
`kogane-sbi-shinsei-collector-poc`, `kogane-sbi-vc-session-poc`,
`kogane-smbc-direct-backfill-poc`, `kogane-st-george-collector`,
`kogane-vpoint-pay-collector-poc`) have no such section (PRESTIA bank has no
README at all) and are not classified here;
their bindings are in [`../infra/resources.md`](../infra/resources.md).

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
