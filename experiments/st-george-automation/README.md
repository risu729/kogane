# St.George browser automation PoC

This experiment drives normal St.George Internet Banking pages after manual
authentication. It does not import statements or exports. The bounded milestone
is an automated portfolio GET and, optionally, a GET of the first existing account
summary link, with only DOM counts and field presence printed.

**Status:** synthetic browser tests exercise the implementation. Authentication,
current account selectors, transaction semantics, pagination, session renewal, and
API collection are not proven by those tests. See the current live-attempt outcome
in [source research](../../docs/sources/st-george.md).

## Kuebiko request/response discovery

Start the existing Kuebiko shortcut or the separately prepared local launcher
first. Use its ordinary Chrome profile, complete the normal bank login yourself,
and leave exactly one St.George Internet Banking tab open. Kuebiko supplies the
request/response capture; this PoC attaches to that browser's local CDP endpoint
and performs the bounded read navigation.

The existing local Kuebiko setup may capture cookies and streamed response bodies.
Those files can contain bank credentials, session secrets, account identifiers,
balances, and transactions. Keep that capture in its existing private local
location, outside this repository. Do not attach raw captures to issues, print
them in agent output, commit them, or treat a capture as an import file. Use a
St.George domain filter and disable unfiltered netlog. No storage snapshot is
needed. Kuebiko is an external runtime prerequisite; this workspace does not
install, launch, or reconfigure it.

From this workspace after the locked repository install:

```sh
bun src/cli.ts --cdp http://127.0.0.1:9222 --transactions
```

The command only accepts an unauthenticated loopback HTTP CDP endpoint. Run it
where that browser's localhost endpoint is reachable. Windows/WSL localhost
sharing depends on the machine's networking mode; do not expose a debugging port
on a public interface to work around it. If necessary, copy this experiment into a local Windows runtime directory and
install its pinned dependencies there before running Windows Bun. Windows Bun
cannot resolve this WSL workspace's Linux dependency symlinks directly over UNC.
Keep the source of record in the WSL worktree. The separately prepared Windows
runner refreshes that local runtime from the WSL sources.

The terminal asks for Enter before automation. Enter means the user has completed
normal login and the browser has no challenge or warning. Never type credentials
into the terminal. The CLI navigates the fixed portfolio URL, checks the layout,
then follows at most one existing account-details anchor when
`--transactions` is supplied. It does not click export or payment controls.
CDP mode disconnects on completion and leaves the user's Chrome running.

## Fresh browser modes

To test public login reachability without credentials or an existing session:

```sh
CHROMIUM_PATH=/opt/google/chrome/chrome bun src/cli.ts --probe
```

This performs one normal, fresh headless-browser GET of the public login page.
It prints only route classification and visible login field presence. It does
not attempt authentication or account URLs. A successful public probe proves
only login-page reachability.

For a separate normal headed browser with ephemeral session state:

```sh
CHROMIUM_PATH=/opt/google/chrome/chrome bun src/cli.ts --headed --transactions
```

This mode is useful for DOM automation alone; it does not provide Kuebiko's
network capture. Complete authentication in the browser, then press Enter in the
terminal. A display is required. The browser closes when the run ends. No
persistent profile, cookie jar, storage-state file, credentials, screenshot, HAR,
or trace is saved by the PoC. Browser installation is explicit; local tasks never
download a browser automatically.

## What the output means

Output is JSON with fixed labels, booleans, and counts. It never includes a URL,
query, account value, transaction value, browser exception text, response body,
cookie, or token. Do not enable `DEBUG` or `PWDEBUG`; the CLI rejects them.

| Status                         | Meaning                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `manual-login-required`        | Recognizable login inputs exist, including when HTTP 200 or the URL resembles a portfolio.                                                       |
| `portfolio-observed`           | Known account-list/card structure exists; output counts current/available balance field presence without reading values.                         |
| `transaction-layout-candidate` | The historical export control exists on the account-details route. Table/row counts are generic DOM candidates, not verified transaction counts. |
| `unknown-layout`               | Evidence is insufficient. Empty account lists are not called successful collection.                                                              |
| `stopped`                      | A challenge, denied response, unknown route, download, invalid option, timeout, or browser failure stopped the experiment.                       |

Exit code 0 means the requested milestone was observed: recognizable public
login for `--probe`, portfolio structure by default, or a transaction layout
candidate with `--transactions`. It never means a production collector or
complete transaction history was verified. Other outcomes exit 2. Browser
launch/navigation timeouts are 15–30 seconds; manual login waits at most five
minutes. There is no retry loop.

The official bank page observed on 2026-09-13 displayed a visible “Request error”
heading instead of login controls. That exact heading now produces
`stopped / bank-request-error`, including on an otherwise recognizable login or
portfolio layout. The report contains no diagnostic message, IP address, or
reference. The PoC stops without retrying or changing network settings.

## Evidence and boundaries

The allowlist is the exact HTTPS origin `ibanking.stgeorge.com.au` and the
known `/ibank/loginPage.action`, `/ibank/viewAccountPortfolio.html`, and
`/ibank/accountDetails.action` paths. The account-details URL comes only from an
existing visible `#acctSummaryList > li h2 a` anchor, including its original query
in transient process memory. No account parameter is invented or logged.
Unknown paths are not inspected. Automatic navigation submits no forms and never
replays POST/PUT/PATCH/DELETE requests. Bank JavaScript and human authentication
still perform their own normal network activity; this is not a network sandbox.

The portfolio selector and balance-field structures are from
[cashgrab's public St.George implementation](https://github.com/tekumara/cashgrab/blob/main/src/stgeorge-balances.js).
The account-details route and `#transHistExport` are historical evidence in
[the source research](../../docs/sources/st-george.md), traced to the older
[ynab-sync implementation](https://github.com/geofflamrock/ynab-sync/tree/main/packages/st-george-au).
Selectors are labeled historical until inspected in a current authenticated
session. The generic transaction-table counts cannot establish pending/posted
status, schema, date coverage, pagination, or a reliable API endpoint.

Stop if the bank asks for Secure Code, CAPTCHA, device enrollment, push approval,
or shows a lock/session warning. The experiment does not solve challenges,
change fingerprints, disable protections, or retry denied requests. Known
challenge DOM markers and same-bank HTTP 401/403/429 stop subsequent automation,
but detection is conservative and cannot recognize every possible future layout.
Do not navigate payment, card, settings, consent, or statement-request flows
during the run.

## Validation

From the repository root:

```sh
CHROMIUM_PATH=/opt/google/chrome/chrome mise run //experiments/st-george-automation:ci
```

Tests route every browser request to synthetic HTML and do not contact the bank.
They cover bank-origin/route constraints, HTTP-200 login masquerading as a
portfolio, challenge/expiry precedence, rejected HTTP responses, unknown layouts,
automated GET sequencing, disallowed account links, and absence of synthetic
private values in reports.

The redirect regression uses a local HTTP server and verifies zero requests reach
the forbidden redirect destination. Chromium document interception guards every
automatic navigation hop, rather than relying on Playwright route matching alone.

## Lifecycle

Owner: the Kogane source-collection experiment. Keep this local and opt-in; it has
no deployed worker or schedule. Review or retire it after the first authenticated
Kuebiko session, or by 2026-10-13 if that session is still unavailable. Promotion
requires current selectors, request/response schema evidence, verified read
semantics, pagination/session behavior, and separate decisions on secret handling.
Unknown layouts, rejected browser control, or missing user authentication are
stop conditions rather than a reason to substitute a statement import.
