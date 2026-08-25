# Mobile Suica / JRE ID / JRE POINT source assessment

Status: first-pass research, 2026-08-26

Scope: consumer-owned Mobile Suica SF data and the directly related JRE ID / JRE POINT data paths

Non-goals: charging, ticket purchase, card/account changes, migration to JRE ID, or detailed reverse engineering

## Decision

Use the official Mobile Suica member website as the first SF source, with
`pnsk-lab/mnie`'s read-only `provider-mobile-suica` as implementation prior art.
It is already a plain-`fetch` HTML client, works against the legacy Mobile Suica-ID
login flow, and returns the useful transaction fields. Add Kogane's raw-response
capture before adopting its parser.

Treat JRE POINT as a separate reward source, not as a substitute for the SF
history. Its one-year point history is longer-lived than the SF history but is
lossy: it contains only point activity, eligible Suica purchase points are posted
later, and rail points are posted for a week together. It therefore cannot
reconstruct the underlying rides or all Suica purchases.

Do not use an aggregator for either source. The preferred inputs are JR East's
own Mobile Suica and JRE POINT websites/apps.

The important migration caveat is that the existing `mnie` client implements the
legacy Mobile Suica-ID form. JR East now offers a separate JRE ID login, and the
legacy ID/password stop working after migration. A previous read-only account
check found the user's account still on the legacy path, but that was a historical
observation and was **not rechecked in this research**. The collector must detect
the current path before any live test and must not initiate migration.

## What was checked

- JR East's current public Mobile Suica, JRE ID, and JRE POINT documentation.
- The unauthenticated Mobile Suica login response and response headers from WSL,
  using both the default HTTP client user agent and a current Chrome-like user
  agent. No credentials were submitted.
- Unauthenticated response headers and DNS for `www.mobilesuica.com`,
  `id.jreast.co.jp`, `www.jrepoint.jp`, and `app.jrepoint.jp`.
- `pnsk-lab/mnie` at commit
  [`c87e65c`](https://github.com/pnsk-lab/mnie/tree/c87e65c0a04c03c560962f8ead6e77415fb841f4),
  especially `packages/provider-mobile-suica/src/index.ts`.
- Other public implementation references listed below.
- Official Google Play listings. No APK was downloaded or decompiled, and no
  signed-in account page was opened.

No passwords, cookies, full Suica IDs, point IDs, or other personal identifiers
were recorded.

## Official data routes

| Route | Officially available data | Window / limit | Timing and granularity | Automation assessment |
| --- | --- | --- | --- | --- |
| Mobile Suica Android/iOS app | Current SF balance and SF use history | History: within 26 weeks, at most 100 entries | App history includes the current day's use; rail rows show station names where available, bus rows show operator, and auto-charge is labelled | Best user display, but poor cloud collector: tied to a supported device and app state |
| Mobile Suica member website (PC) | SF history, balance after each row, printable history | Official UI says within 26 weeks and at most 100 entries | Through the previous day; available 05:00 to 00:50 JST | Best first collector route; legacy login is already implemented with plain `fetch` |
| Mobile Suica app, JRE POINT menu | JRE POINT current holdings; also write operations that Kogane must never call | Current point balance only is documented | No point-history feature is documented on this route | Low-value balance snapshot; do not use for reward history |
| JRE POINT Web/app | Total point balance and point history | Point history: previous one year | History marks distinguish rail, Suica purchase, View Card, and other sources; exact live columns still need capture | Preferred reward route, but authentication/anti-abuse is materially harder |
| JRE ID | Authentication and SSO only | JR East says SSO persists for an unspecified "certain time" | Passkey, SMS, and password login are supported | Authentication layer, not a financial data source |

Official Mobile Suica details:

- JR East states that the app and PC member site display at most 100 SF history
  entries from the last 26 weeks. The app includes today's entries; the PC site
  is through the previous day. See
  [Suica balance and history](https://www.jreast.co.jp/mobilesuica/use/sf/chk_account.html)
  and [service hours](https://www.jreast.co.jp/mobilesuica/use/time_area.html).
- The underlying JR East rule defines history content as transaction date,
  location or fare section, post-transaction SF balance, and the corresponding
  ride/purchase/charge record. See the
  [IC card rules](https://www.jreast.co.jp/suica/etc/rule/).
- The app shows current balance immediately. The PC route should be treated as
  "last observed balance after the latest posted row", not guaranteed real-time
  balance when there was activity today.
- The PC site's public statement is "maximum 100". `mnie` implements a date
  search and repeatedly requests up-to-100-row snapshots for earlier dates.
  That suggests it may retrieve more than 100 total rows within 26 weeks, but
  this behavior is not promised by the public documentation and must be verified
  with the user's live history. The client deliberately errors if one day alone
  hits 100 rows because completeness cannot then be proved.

Official JRE POINT details:

- The official guide and FAQ say the point history covers the previous one year
  and requires the JRE POINT second password (a separate 4-to-8-digit numeric
  password) after login. See
  [point-history guide](https://app.jrepoint.jp/point/guide/99/) and
  [FAQ 2998](https://faq.jrepoint.jp/faq/show/2998?site_domain=default).
- Rail points are awarded in a later batch for a Sunday-to-Saturday week, not as
  a synchronous one-entry-per-ride feed. See
  [earning points by rail](https://app.jrepoint.jp/point/append/railway/).
- Eligible Suica purchase points are reflected from the day after payment, and
  only participating uses earn them. See
  [earning points with registered Suica](https://www.jrepoint.jp/point/append/suica/).
- Therefore, JRE POINT provides useful reward observations (balance, earned/used
  point entries, category, and expiry-related state) but is not an SF ledger.
  In particular, it omits non-eligible purchases and point-free rides, and the
  batched rail credit destroys trip-level timing and origin/destination detail.
- Since 2026-02-25, the Mobile Suica app can show the current JRE POINT holdings
  and can initiate exchanges. The official release documents balance display,
  not point history. Kogane must expose only the read path. See the
  [JR East release](https://www.jreast.co.jp/press/2025/20260225_ho03.pdf).

## Authentication and session behavior

### Legacy Mobile Suica-ID route

The current public PC page exposes two accordions: legacy "Mobile Suica ID" and
"JRE ID". With a Chrome-like user agent, the legacy form contains:

- email-address Mobile Suica ID;
- password;
- a five-character image CAPTCHA;
- ASP.NET/Infragistics hidden form state.

A default command-line user agent received HTTP 200 but only an unsupported-
browser notice. A Chrome-like user agent received the real CAPTCHA login form.
This is a compatibility/user-agent gate, not proof of a browser-execution
requirement.

`mnie` reproduces this flow without Playwright:

1. GET `/index.aspx` with Chrome-like navigation headers.
2. Parse the legacy form and fetch `WebCaptchaImage.axd`.
3. Ask a callback for the CAPTCHA answer (up to four attempts).
4. POST the email, password, CAPTCHA and both Infragistics hidden states.
5. Parse the per-session `returnId` and POST to `/iq/ir/SuicaDisp.aspx`.
6. Maintain a small cookie jar and support session export/import.

Code evidence:

- credentials and CAPTCHA callback:
  [`index.ts` lines 1-18](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-mobile-suica/src/index.ts#L1-L18)
- cookie jar, manual redirects and Shift_JIS decode:
  [`index.ts` lines 248-334](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-mobile-suica/src/index.ts#L248-L334)
- CAPTCHA state and SF-history link discovery:
  [`index.ts` lines 390-420](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-mobile-suica/src/index.ts#L390-L420)
- login POST:
  [`index.ts` lines 630-700](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-mobile-suica/src/index.ts#L630-L700)
- date search and session import:
  [`index.ts` lines 707-769](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-mobile-suica/src/index.ts#L707-L769)

Session reuse is implemented, not yet validated for a duration. Upstream `mnie`
re-opens an imported cookie jar and checks Mobile Suica availability every five
minutes. JR East does not publish the session lifetime. Test 1 hour, 24 hours and
7 days instead of assuming the keep-alive succeeds indefinitely.

Security change required before reuse: `MobileSuicaSession` currently exports
the username **and password** with cookies. Imported requests only need the
session cookies and per-session history URL; Kogane must not copy a long-lived
password to Cloudflare as part of a session envelope. Bootstrap locally, issue a
source-scoped encrypted session, and keep the password out of raw artifacts,
logs, commits, and cloud runtime secrets wherever session replay suffices.

### JRE ID route

JRE ID supports password, passkey, and SMS authentication. JR East recommends
two-factor protection and publishes supported passkey environments. See
[JRE ID security](https://www.jreast.co.jp/jreid/security/),
[passkey FAQ](https://idfaq.jreast.co.jp/faq/show/38?site_domain=default), and
[SMS FAQ](https://idfaq.jreast.co.jp/faq/show/397?site_domain=default).

The material automation obstacle is officially confirmed: JRE ID uses
**Google Cloud Fraud Defense** against programmatic bulk access. JR East also
warns that VPNs, browser/cookie state and unsupported browser environments can
cause the security check to fail. See
[JRE ID FAQ 650](https://idfaq.jreast.co.jp/faq/show/650?site_domain=default).

JRE ID SSO can suppress repeated login across linked services for an unspecified
period. Logging out of a linked service also logs out JRE ID, while other
already-logged-in services/devices remain active. See
[SSO/logout FAQ](https://idfaq.jreast.co.jp/faq/show/305?site_domain=default).
This supports a browser-issued/session-replay experiment, but not an assumption
that a headless password bootstrap will be reliable.

After Mobile Suica is migrated, JR East states that the legacy ID/password can no
longer be used and the login method cannot be reverted. See
[Mobile Suica migration FAQ 4766](https://msfaq.mobilesuica.com/faq/show/4766?site_domain=default).
The existing `mnie` form client will therefore need a new JRE ID bootstrap/session
path before it can support a migrated account.

### JRE POINT route

JRE POINT Web currently offers both the JRE ID path and a legacy JRE POINT-ID
path for accounts not yet migrated. Point history is additionally protected by
the second password after login. The official JRE POINT app can opt into device
biometric/passcode login, but the second-password requirement for point history
still needs a live read-only check after JRE ID migration.

The important open question is whether an already authenticated JRE POINT
session can replay the history request from a non-browser runtime without
re-running Fraud Defense. That test, not a full API reverse engineering effort,
is the next decision gate.

## WAF / anti-bot observations

Separate facts from attribution:

### Confirmed

- **JRE ID:** official FAQ confirms Google Cloud Fraud Defense. The public
  `id.jreast.co.jp` root responded through `awselb/2.0` during the header check.
- **JRE POINT:** both `www.jrepoint.jp` and `app.jrepoint.jp` returned HTTP 403
  to ordinary command-line GETs, including with a Chrome user agent, from the
  current WSL network. Responses set `BIGipServer...` and opaque `TS...`
  cookies. `www.jrepoint.jp` resolves through `www.jrepoint.jp.cdnga.net`.
  This confirms CDN/load-balancer access controls are in the path, but does not
  prove why this IP/request was rejected.
- **Mobile Suica legacy website:** command-line GET with a current Chrome-like
  user agent reached the CAPTCHA form. Responses set `ASP.NET_SessionId` and an
  opaque `TS...` cookie. The current `mnie` fetch flow is corroborating evidence
  that full browser execution is not inherently required for this legacy path.

### Not confirmed

- No checked host exposed an Akamai hostname or an `AkamaiGHost` response in this
  pass. Do **not** label the source "Akamai-protected" from the present evidence.
- The vendor/function behind Mobile Suica's opaque `TS...` cookie was not
  established. It may be security or traffic-management state; vendor
  attribution would be speculation.
- JRE POINT's 403 may depend on source IP, geography, TLS/browser fingerprint,
  cookies, or another policy. It must be reproduced from the user's normal
  browser and then from the intended OCI/Cloudflare egress before assigning a
  specific cause.
- App API protection, certificate pinning, Play Integrity, and device-attestation
  requirements were not checked.

## Android packages and value of static analysis

Official Google Play packages exist:

- Mobile Suica:
  [`com.mobilesuica.msb.android`](https://play.google.com/store/apps/details?id=com.mobilesuica.msb.android)
- JRE POINT:
  [`jp.co.jreast.jrepoint`](https://play.google.com/store/apps/details?id=jp.co.jreast.jrepoint)

JR East links to Google Play from its own service pages. No official standalone
APK download was found; Google Play is the public official delivery route. A
read-only static analysis should obtain the Play-delivered split APKs from an
owned compatible device (or another authorized Play retrieval flow) and must not
commit or redistribute them.

Static analysis is worthwhile, but second priority:

- useful targets: API hostnames, path names, request schemas, JRE ID redirect
  parameters, certificate pinning, Play Integrity/attestation calls, and whether
  point-history responses are shared by Web and app;
- likely low-value target: emulating the whole Mobile Suica app in cloud. Android
  Mobile Suica is coupled to a supported phone, Osaifu-Keitai/Mobile FeliCa and
  device login state. Even if network endpoints are discovered, running the app
  in a generic Kubernetes or Cloudflare environment is unlikely to be the cheap
  collector path;
- JRE POINT app analysis may be more useful because its rewards data is
  server-side and the app can be reinstalled and logged into on a new phone, but
  the Web route should be characterized first.

No APK analysis is needed before the first website replay test.

## Third-party implementation review

### `pnsk-lab/mnie` — adopt as prior art

Repository: [pnsk-lab/mnie](https://github.com/pnsk-lab/mnie) (MIT)

What is implemented:

- pure `fetch`, no browser, for the legacy Mobile Suica ID flow;
- Chrome-like headers, manual redirect handling and a per-client cookie jar;
- Shift_JIS HTML decode;
- CAPTCHA image callback with four login attempts;
- parsing of the eight-column SF table: date, two type/location pairs,
  post-transaction balance, and amount;
- classification of rail, bus, purchase, card charge, carryover and other rows;
- date-range retrieval by repeatedly searching on or before an earlier date;
- session export/import and logout;
- provider capabilities are read-only (`accounts:read`, `transactions:read`,
  `transit-cards:read`).

The row parser and balance-after mapping are visible in
[`index.ts` lines 493-565](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-mobile-suica/src/index.ts#L493-L565).

Gaps for Kogane:

- it parses directly without preserving byte-exact HTTP evidence;
- session export includes the password;
- it only implements legacy Mobile Suica ID, not JRE ID;
- CAPTCHA inference in the wider repo uses `onnxruntime-node` and `sharp`, which
  are native Node dependencies and are not a Worker-isolate solution;
- session lifetime, cloud egress, and the "more than 100 via date search" claim
  need live validation;
- row identities are snapshot-derived because the site provides no documented
  stable transaction ID.

Required adaptation: inject a raw-capturing transport, store response bytes before
Shift_JIS decoding, record parser/version and raw locator, remove credentials from
the replay envelope, and expose only history reads.

### Other references

- [mattyatea/receipt-extractor](https://github.com/mattyatea/receipt-extractor)
  (MIT, last pushed 2025): Playwright signs in through the JRE ID button, scrapes
  the same eight history cells, and downloads selected history/receipt PDFs. It
  is useful evidence for the JRE ID browser route and PDF controls, but it has no
  session handoff, no Fraud Defense handling, and no JRE POINT support.
- [shinichy/get_statement](https://github.com/shinichy/get_statement) (2018): old
  Selenium code performs interactive CAPTCHA entry, selects an as-of date and
  downloads the printable history. It targets obsolete login selectors and is
  only historical protocol evidence.
- [hikch/SuicaExtract](https://github.com/hikch/SuicaExtract) (MIT, 2022): a
  bookmarklet exports JSON from an already logged-in SF history DOM. It is a
  low-risk manual fallback and parser reference, not a scheduled collector.
- [Jessidhia's userscript](https://gist.github.com/Jessidhia/dc117754ec668421eadb60532646a0a7)
  similarly exports the logged-in table to CSV.

No maintained public JRE POINT history client was found in the targeted GitHub
code/repository searches. This is negative search evidence, not proof that none
exists.

## Runtime suitability

| Runtime | Mobile Suica legacy SF | JRE ID / JRE POINT | Why |
| --- | --- | --- | --- |
| Local Windows/WSL | High | Medium | Best bootstrap and Kuebiko environment; user can solve CAPTCHA/2FA and inspect account state |
| Plain Cloudflare Worker | Medium for replay, low for bootstrap | Low | `fetch`/cookies fit, but Shift_JIS needs an explicit decoder and native ONNX/Sharp CAPTCHA code does not fit; JRE Fraud Defense and current JRE POINT 403 are the larger blockers |
| Cloudflare Container | High after validation | Medium | Full Linux/Node/Bun runtime supports native CAPTCHA dependencies and browser fallback; still must pass source-IP/anti-bot checks |
| Generic OCI / Kubernetes | High after validation | Medium | Easiest controlled test of Node/Bun, browser, cookie replay and scheduled jobs; no guarantee the egress is accepted |
| Android device | High for app UI, low as a server job | Medium-high for point app | Authoritative app data but device/hardware/login state makes unattended orchestration expensive |

Cloudflare's current docs describe Workers as V8 isolates with Web APIs and only
a subset/polyfill set of Node APIs; Containers run a full Linux/container image.
See [Workers Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
and [Containers overview](https://developers.cloudflare.com/containers/).

The recommended deployment sequence is OCI/Cloudflare Container first, then test
whether the reduced, session-only replay client can move to a Worker. Do not start
with a Worker and assume failures are source-side; first separate Shift_JIS/native
dependency issues from egress/fraud-defense issues.

## Cost and automation estimate

Scale: 1 = nearly direct export; 5 = fragile, device-bound or major protocol work.

| Deliverable | Cost | Expected automation | Confidence |
| --- | ---: | --- | --- |
| Legacy Mobile Suica SF history, local/manual CAPTCHA bootstrap | 2/5 | Scheduled reads while cookie session remains valid; manual or model-assisted CAPTCHA on re-login | High that implementation is small; medium on durability |
| Legacy Mobile Suica fully unattended re-login | 3/5 | Possible with existing five-character model, but CAPTCHA accuracy and policy/reliability need testing | Medium |
| Mobile Suica after JRE ID migration | 4/5 | Likely browser-issued session plus replay; pure headless bootstrap uncertain because of Fraud Defense/passkey/SMS | Medium-low |
| JRE POINT balance + one-year point history | 4/5 | Semi-automatic bootstrap, second-password step, then replay if proven; otherwise browser collection | Medium-low |
| App API discovery via APK static analysis | 4/5 | Useful research, not itself an operational collector | Medium |
| Full Mobile Suica app automation in cloud | 5/5 | Not recommended | High |

Overall recommendation: implement the legacy PC SF route now if the account still
uses it; separately characterize JRE POINT Web. Do not couple the first SF
collector to a JRE ID migration project.

## Next validation, in order

1. **Read-only account-path check.** In the user's existing official UI, record
   only whether Mobile Suica and JRE POINT currently use legacy IDs or JRE ID.
   Do not migrate, unlink, edit, charge or purchase.
2. **Kuebiko capture of one manual Mobile Suica login.** Redact credentials,
   CAPTCHA answer, cookies, `returnId`, and Suica IDs in any research artifact.
   Preserve private raw bodies only in the designated evidence store.
3. **Run upstream `mnie` locally with user-reviewed CAPTCHA.** Compare row count,
   oldest/newest dates, types, places, amounts and balance-after values with the
   official page. Verify whether repeated as-of searches really recover more
   than 100 total entries within 26 weeks. Do not print transaction content to
   CI logs.
4. **Session matrix.** Import the same source-scoped session after 1 hour,
   24 hours and 7 days, then from WSL and one OCI container. Record success,
   HTTP status and whether CAPTCHA/JRE reauthentication is requested. Never put
   the password in the replay envelope.
5. **JRE POINT live schema capture.** In the official Web UI, enter the second
   password manually and record field names, filters, row count, oldest date,
   category labels, pending state, point expiry fields and whether export exists.
   Compare at least one rail credit and one eligible Suica purchase with the SF
   history to quantify aggregation/loss.
6. **JRE ID replay gate.** Capture a browser-issued JRE ID/JRE POINT session and
   try one read-only point-history replay from the same machine, then OCI. Stop
   if Fraud Defense requires repeated interactive/browser state; do not work
   around account locks or security challenges.
7. **Only if Web replay fails, inspect APKs.** Extract the official packages from
   an owned device, run static analysis locally, and document endpoints,
   pinning/attestation and shared Web/app APIs. Do not redistribute packages.
8. **Cloudflare last.** Test Cloudflare Container egress, then a minimal Worker
   replay with an explicit Shift_JIS decoder. Promote only a read-only,
   source-allowlisted client with byte-exact raw capture.

## Open questions

- Current live account path: legacy ID or JRE ID for each of Mobile Suica and
  JRE POINT.
- Actual Mobile Suica cookie lifetime and whether five-minute reads extend it.
- Whether the as-of date search returns more than 100 total rows inside 26 weeks
  on the current production account.
- Exact JRE POINT history columns and whether rail points are one weekly row or
  multiple rows grouped under a weekly posting in the current UI.
- Whether the JRE POINT second password is re-requested for every new session,
  after a fixed timeout, or for every history visit.
- Whether a browser-issued JRE ID/JRE POINT session replays from OCI and
  Cloudflare egress without re-running Fraud Defense.
- App API pinning/attestation and whether app history uses the same server
  endpoints as the Web site.
