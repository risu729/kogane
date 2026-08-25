# Mobile Suica / JRE ID / JRE POINT source assessment

Status: first-pass research, 2026-08-26

Scope: consumer-owned Mobile Suica SF data and the directly related JRE ID / JRE POINT data paths

Non-goals: charging, ticket purchase, card/account changes, migration to JRE ID, or detailed reverse engineering

## Decision

Use the official Mobile Suica member website as the primary SF source. The
account owner has confirmed that the current account uses **JRE ID**, not the
legacy Mobile Suica ID, and signs in with a passkey held in Bitwarden. The first
decision gate is therefore a local JRE ID passkey bootstrap followed by
source-scoped session replay. `pnsk-lab/mnie`'s read-only
`provider-mobile-suica` remains valuable for the post-login history protocol and
parser, but its legacy login flow cannot be treated as the shortest path for
this account.

Treat Google Wallet on the owner's Android device as a **secondary first-party
platform view**, not the Suica source of record. JR East and Google both confirm
that it can display SF balance and transaction history, but Google warns that
some details may be omitted when many transactions occur in a short time. No
fixed history count/window or consumer API for extracting a user's Suica was
found. It is useful for a local snapshot/cross-check or possible Takeout
experiment, not as the primary scheduled collector until a live comparison
proves completeness.

Treat JRE POINT as a separate reward source, not as a substitute for the SF
history. Its one-year point history is longer-lived than the SF history but is
lossy: it contains only point activity, eligible Suica purchase points are posted
later, and rail points are posted for a week together. It therefore cannot
reconstruct the underlying rides or all Suica purchases.

Do not use an aggregator for either source. The preferred inputs are JR East's
own Mobile Suica and JRE POINT websites/apps.

The existing `mnie` client implements the legacy Mobile Suica-ID form. JR East
states that the legacy ID/password stop working after JRE ID migration. That
legacy client is consequently protocol prior art only for this account. The main
unknown is whether a browser-issued JRE ID/Mobile Suica session can be replayed
without repeating WebAuthn and Fraud Defense on every collection.

## What was checked

- JR East's current public Mobile Suica, JRE ID, and JRE POINT documentation.
- The unauthenticated Mobile Suica login response and response headers from WSL,
  using both the default HTTP client user agent and a current Chrome-like user
  agent. No credentials were submitted.
- Unauthenticated response headers and DNS for `www.mobilesuica.com`,
  `id.jreast.co.jp`, `www.jrepoint.jp`, and `app.jrepoint.jp`.
- `pnsk-lab/mnie` at commit
  [`c87e65c`](https://github.com/pnsk-lab/mnie/tree/c87e65c0a04c03c560962f8ead6e77415fb841f4),
  especially `packages/provider-mobile-suica/src/index.ts` and the
  `packages/auth-bitwarden` WebAuthn implementation.
- Other public implementation references listed below.
- JR East and Google documentation for Mobile Suica in Google Wallet, Google
  Wallet Takeout, and Google Wallet developer APIs.
- Official Google Play listings. No APK was downloaded or decompiled, no vault
  was opened, and no signed-in account page was opened.

Account-specific facts in this update were supplied by the account owner: the
current Mobile Suica login is JRE ID, a passkey is used and stored in Bitwarden,
and the Android Suica is visible through Google Wallet. The exact Bitwarden
credential RP ID/origin and the live Google Wallet fields were not inspected;
those remain verification items rather than inferred facts.

No passwords, cookies, full Suica IDs, point IDs, or other personal identifiers
were recorded.

## Official data routes

| Route | Officially available data | Window / limit | Timing and granularity | Automation assessment |
| --- | --- | --- | --- | --- |
| Mobile Suica Android/iOS app | Current SF balance and SF use history | History: within 26 weeks, at most 100 entries | App history includes the current day's use; rail rows show station names where available, bus rows show operator, and auto-charge is labelled | Best user display, but poor cloud collector: tied to a supported device and app state |
| Mobile Suica member website (PC), via current JRE ID | SF history, balance after each row, printable history | Official UI says within 26 weeks and at most 100 entries | Through the previous day; available 05:00 to 00:50 JST | Preferred primary route after local JRE ID bootstrap/session replay is proven; post-login legacy parser is reusable, login is not |
| Google Wallet on Android | SF balance and a card transaction-history view; Google documents purchases, card/store charges and gifts for Japanese e-money, and generic transit views expose station names, dates and times | No fixed Suica count/window found; Google warns that details can be omitted after many transactions in a short period | Device-local official platform view; current-day behavior and exact Suica row fields need live capture | Useful secondary snapshot/cross-check. No documented consumer read API; app/UI automation is device-bound and likely brittle |
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

### Google Wallet as a secondary route

Confirmed from public first-party documentation:

- JR East's Android comparison says both Google Wallet and Mobile Suica can show
  SF balance and SF history. It also shows material gaps: Google Wallet does not
  provide commuter-pass or Green Car ticket purchase and cannot receive a JRE
  POINT charge. See
  [JR East's Google Pay / Mobile Suica comparison](https://www.jreast.co.jp/fr/mobilesuica/googlepay/).
- Google's Japan e-money help says the card history includes purchases,
  credit-card or store charges, and gifts. It separately warns that some details
  may be missing after many transactions in a short period and directs users to
  the e-money provider's app/site to manage balance. See
  [add e-money in Japan](https://support.google.com/wallet/answer/13314575?hl=ja).
- Google's general transit-pass help says the app and supported Wallet website
  can show station names, dates and times under recent activity. That page is not
  a Suica-specific completeness guarantee, so the amount, balance-after,
  merchant/bus labels and web availability for this particular Suica must be
  captured live. See
  [use Google Wallet for transportation](https://support.google.com/wallet/answer/12059518?hl=en).
- Google's Suica/PASMO watch help repeats the high-volume omission warning. It
  does not publish a number of rows or retention period. See
  [Suica/PASMO activity on a smartwatch](https://support.google.com/wallet/answer/13145603?hl=ja).

Export/API/device findings:

- Google officially offers Google Wallet export through Google Takeout. The
  export UI allows selection of Wallet data, but the public help does not list
  whether Android Suica balance/history is included or its schema. A one-time
  owner-initiated export and comparison is required before assigning it any
  completeness value. See
  [find and export Google Pay/Wallet data](https://support.google.com/googlepay/answer/9015738?hl=en).
- The public Google Wallet REST API is for a registered pass **issuer** to
  create/manage its own pass classes and objects; requests use an issuer service
  account. It is not documented as a consumer API to enumerate or read the
  signed-in user's Suica, so it is not a Kogane extraction route. See
  [REST API authentication](https://developers.google.com/wallet/tickets/boarding-passes/getting-started/auth/rest).
- Google Wallet's official Android package is
  [`com.google.android.apps.walletnfcrel`](https://play.google.com/store/apps/details?id=com.google.android.apps.walletnfcrel).
  Google Play is the public official distribution path; no official standalone
  APK was found. A locally extracted Play-delivered APK can reveal UI, storage,
  content-provider and service boundaries, but sensitive card state may be held
  by Google Play services, Osaifu-Keitai/Mobile FeliCa or a secure element rather
  than in ordinary Wallet app storage. This is a hypothesis to test, not a
  confirmed storage map.
- Targeted GitHub repository/code searches found no maintained third-party
  client that exports a Google Wallet-hosted Suica history. Public Suica readers
  target physical FeliCa cards, and Mobile Suica exporters target the official
  member-site HTML/PDF; neither demonstrates access to the Wallet-hosted Suica
  on the same Android device. This is negative search evidence, not proof that
  no implementation exists.

Practical trade-off: Google Wallet may be easier for an occasional local visual
capture because the owner already uses it and no JRE ID bootstrap is needed for
the displayed card. It is worse for a reliable cloud ledger: documented omission
risk, unknown retention/count, no supported consumer API, device binding, and
likely private/secure-element boundaries. Mobile Suica remains the primary SF
source; JRE POINT remains the longer-lived but lossy reward source.

## Authentication and session behavior

### Legacy Mobile Suica-ID route (protocol prior art only for this account)

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

### Current JRE ID route

JRE ID supports password, passkey, and SMS authentication. JR East recommends
two-factor protection and publishes supported passkey environments. See
[JRE ID security](https://www.jreast.co.jp/jreid/security/),
[passkey FAQ](https://idfaq.jreast.co.jp/faq/show/38?site_domain=default), and
[SMS FAQ](https://idfaq.jreast.co.jp/faq/show/397?site_domain=default).

For this account, the owner confirms JRE ID login and passkey use, with the
passkey stored in Bitwarden. This research did not open the vault or inspect the
live WebAuthn request. The credential's exact RP ID, origin, credential ID,
algorithm, user-verification policy and whether the observed credential is the
one used by JRE ID are therefore **not yet confirmed**.

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

### Local Bitwarden WebAuthn feasibility

`pnsk-lab/mnie` includes a small, code-level proof that a Bitwarden-stored
passkey can issue WebAuthn assertions outside a browser:

- it opens the local Bitwarden desktop `data.json`, derives the master/user key,
  decrypts FIDO2 credential fields, and filters passkeys by exact RP ID
  ([`vault.ts` lines 59-118](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/vault.ts#L59-L118),
  [`vault.ts` lines 167-211](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/vault.ts#L167-L211));
- the provider further selects an optional exact credential ID and rejects zero
  or ambiguous matches
  ([`provider.ts` lines 16-45](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/provider.ts#L16-L45));
- it builds `clientDataJSON` and authenticator data and signs the challenge with
  the decrypted PKCS#8 private key
  ([`fido2.ts` lines 15-53](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/fido2.ts#L15-L53)).

This is promising but is not a JRE ID implementation. The provider currently
imports the SBI Securities WebAuthn request type, assumes the origin unless
overridden, does not implement JRE ID's challenge-fetch/assertion-submit flow,
and has not been tested against JRE ID Fraud Defense. Its counter bump is also
not persisted back to Bitwarden; whether that matters depends on the registered
credential and server validation. A JRE-specific adapter must preserve the
server's exact RP ID, origin, allowed credential IDs, challenge, extensions and
verification requirements instead of guessing them.

The safe boundary is **local issuer, cloud replay**:

1. On the owner's machine, read the local Bitwarden data and unlock only for the
   short bootstrap operation. Filter to the captured JRE ID RP ID and exact
   credential ID before signing.
2. Complete the official, visible JRE ID login locally and capture only the
   resulting Mobile Suica session material needed for read-only history calls.
3. Encrypt a source-scoped, expiring replay envelope. Do not include the vault,
   vault master password, user key, passkey private key, JRE ID, or raw WebAuthn
   assertion in cloud secrets, raw evidence, logs or commits.
4. Run scheduled reads in OCI/Container/Worker only while replay remains valid;
   require a local bootstrap again when it expires.

This avoids moving the whole Bitwarden vault to cloud infrastructure. A remote
signing RPC would reduce cloud credential exposure but would require the owner's
machine to be online and would expand the threat surface; it is not the first
experiment. If same-host replay fails and every read requires a fresh assertion,
the route should remain local rather than exporting a passkey private key.

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
- Google Wallet:
  [`com.google.android.apps.walletnfcrel`](https://play.google.com/store/apps/details?id=com.google.android.apps.walletnfcrel)

JR East links to Google Play from its own service pages. No official standalone
APK download was found; Google Play is the public official delivery route. A
read-only static analysis should obtain the Play-delivered split APKs from an
owned compatible device (or another authorized Play retrieval flow) and must not
commit or redistribute them.

Static analysis is worthwhile, but second priority:

- useful targets: API hostnames, path names, request schemas, JRE ID redirect
  parameters, certificate pinning, Play Integrity/attestation calls, and whether
  point-history responses are shared by Web and app;
- for Google Wallet, useful targets are exported components, content providers,
  backup rules, history-view data flow and delegation to Google Play services or
  Mobile FeliCa. Expect obfuscation and split-package boundaries; do not assume
  an endpoint found in the APK is a supported consumer export API;
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
- it only implements legacy Mobile Suica ID, not the current account's JRE ID
  login; its fetch client cannot bootstrap this account as-is;
- CAPTCHA inference in the wider repo uses `onnxruntime-node` and `sharp`, which
  are native Node dependencies and are not a Worker-isolate solution;
- session lifetime, cloud egress, and the "more than 100 via date search" claim
  need live validation;
- row identities are snapshot-derived because the site provides no documented
  stable transaction ID.

Required adaptation: obtain a JRE ID-issued Mobile Suica session locally, inject
that session into a raw-capturing transport, store response bytes before Shift_JIS
decoding, record parser/version and raw locator, remove credentials from the
replay envelope, and expose only history reads. Reuse the history parser and
date-navigation logic, not the legacy login flow.

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

| Runtime | Mobile Suica SF through current JRE ID | JRE POINT | Google Wallet secondary view | Why |
| --- | --- | --- | --- | --- |
| Local Windows/WSL | High for bootstrap and replay tests | Medium | Medium for UI/export capture | Best Kuebiko/passkey environment; local Bitwarden can stay local and the owner can complete device verification |
| Plain Cloudflare Worker | Medium only after session replay is proven | Low | Very low | `fetch`/cookies fit and Shift_JIS needs an explicit decoder, but WebAuthn/Fraud Defense bootstrap and Android state do not fit |
| Cloudflare Container | Medium-high after replay validation | Medium | Very low | Full Linux/Node/Bun/browser options; still no Android secure-element/card state and egress may trigger controls |
| Generic OCI / Kubernetes | Medium-high after replay validation | Medium | Very low | Easiest controlled session-replay and scheduled-job test; no guarantee JRE accepts egress |
| Owner's Android device | High for official app view, low as a server job | Medium-high for point app | High for viewing, low-medium for local UI automation | Has the live Osaifu-Keitai/Wallet state; unattended orchestration, screen unlock and upgrades make it fragile |

Cloudflare's current docs describe Workers as V8 isolates with Web APIs and only
a subset/polyfill set of Node APIs; Containers run a full Linux/container image.
See [Workers Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
and [Containers overview](https://developers.cloudflare.com/containers/).

The recommended deployment sequence is local JRE ID/passkey bootstrap, same-host
session replay, then OCI/Cloudflare Container, and only then a minimal Worker.
Keep Google Wallet experiments local to the owned Android device/Takeout. Do not
start with a cloud runtime and assume failures are source-side; first separate
session, encoding and egress/Fraud Defense issues.

## Cost and automation estimate

Scale: 1 = nearly direct export; 5 = fragile, device-bound or major protocol work.

| Deliverable | Cost | Expected automation | Confidence |
| --- | ---: | --- | --- |
| Current Mobile Suica SF, visible local JRE ID/passkey bootstrap + same-host replay | 4/5 | Semi-automatic: owner presence on initial/expired login, scheduled reads while the replay session survives | Medium; WebAuthn signing is feasible prior art, JRE adapter/session lifetime are unknown |
| Current Mobile Suica SF, local Bitwarden assertion issued without browser authenticator UI | 4/5 | Potentially unattended on the owner's machine; still subject to Fraud Defense and exact JRE WebAuthn ceremony | Medium-low until RP ID/request/response are captured |
| Current Mobile Suica SF, cloud session replay | 4/5 | Scheduled if a locally issued session survives host/egress change; rebootstrap remains local | Medium-low |
| Legacy Mobile Suica-ID fetch | 2/5 | Existing CAPTCHA flow and parser, but not applicable to the confirmed current account | High on implementation, irrelevant as the production bootstrap |
| JRE POINT balance + one-year point history | 4/5 | Semi-automatic bootstrap, second-password step, then replay if proven; otherwise browser collection | Medium-low |
| Google Wallet one-time app/Takeout snapshot | 2/5 | Manual or owner-triggered local capture; good for comparison, not scheduling | Medium; exact exported Suica fields are unknown |
| Google Wallet recurring Android UI capture | 4/5 | Device-bound UI automation with screen/device state and undocumented omission risk | Medium-low |
| App/API discovery via APK static analysis | 4/5 | Useful research, not itself an operational collector | Medium |
| Full Mobile Suica app automation in cloud | 5/5 | Not recommended | High |

Overall recommendation: start with a local, visible JRE ID/passkey login and
prove that the resulting official Mobile Suica session can replay one SF-history
read. Adapt `mnie` only after that gate, using its post-login protocol/parser.
Use Google Wallet to inventory/cross-check recent device-visible data and test a
one-time Takeout export, but do not choose it as the ledger source without a
row-for-row completeness result. Characterize JRE POINT separately as the
longer-lived, lossy rewards path.

## Next validation, in order

1. **Bitwarden/JRE credential match, locally only.** With a tool that prints only
   match counts and non-secret metadata, capture the JRE ID WebAuthn request and
   verify the exact RP ID/origin and that exactly one Bitwarden credential ID is
   allowed. Do not print vault items, usernames, IDs, private keys or passwords.
2. **Kuebiko capture of one visible JRE ID login.** Let the owner complete the
   passkey/device verification. Redact credentials, WebAuthn assertion, cookies,
   per-session URLs and Suica IDs in research artifacts; preserve private raw
   bodies only in the designated evidence store.
3. **Same-host read-only replay.** Replay one SF-history request without opening
   the vault again. If successful, adapt `mnie`'s history transport/parser and
   compare row count, oldest/newest dates, types, places, amounts and balance-
   after values with the official page. Verify whether repeated as-of searches
   recover more than 100 total entries within 26 weeks. Do not print transaction
   content to CI logs.
4. **Session matrix.** Import the same encrypted, source-scoped session after 1 hour,
   24 hours and 7 days, then from WSL and one OCI container. Record success,
   HTTP status and whether JRE reauthentication is requested. Never put the
   vault, password or passkey material in the replay envelope.
5. **Google Wallet inventory and cross-check.** On the owned Android device,
   record only field names, visible row count, oldest/newest dates, whether
   amounts/balance-after/station/merchant/charge labels are present, and current
   balance. Compare the same recent transactions against Mobile Suica and list
   every omitted or coarsened field. Do not trigger charge, purchase or changes.
6. **One-time Google Takeout test.** Owner-initiate a Wallet-only export, inspect
   whether Suica rows and balances are present, and record format/window/fields.
   Treat absence as route-specific, not proof Google holds no other device data.
7. **JRE POINT live schema capture.** In the official Web UI, enter the second
   password manually and record field names, filters, row count, oldest date,
   category labels, pending state, point expiry fields and whether export exists.
   Compare at least one rail credit and one eligible Suica purchase with the SF
   history to quantify aggregation/loss.
8. **JRE ID/JRE POINT replay gate.** Capture a browser-issued JRE ID/JRE POINT session and
   try one read-only point-history replay from the same machine, then OCI. Stop
   if Fraud Defense requires repeated interactive/browser state; do not work
   around account locks or security challenges.
9. **Only if Web replay/Takeout is insufficient, inspect APKs.** Extract the
   official Mobile Suica/JRE POINT/Google Wallet packages from an owned device,
   run static analysis locally, and document endpoints, exported components,
   storage boundaries, pinning/attestation and shared Web/app APIs. Do not
   redistribute packages or attempt to extract secure-element secrets.
10. **Cloudflare last.** Test Cloudflare Container egress, then a minimal Worker
   replay with an explicit Shift_JIS decoder. Promote only a read-only,
   source-allowlisted client with byte-exact raw capture.

## Open questions

- Exact JRE ID WebAuthn RP ID/origin, allowed credential ID and extensions, and
  whether the referenced Bitwarden passkey is the matching live credential.
- Whether `mnie`'s Bitwarden assertion builder satisfies JRE ID as-is or needs
  additional client-data/authenticator-data fields and counter handling.
- Actual Mobile Suica cookie lifetime and whether five-minute reads extend it.
- Whether a JRE ID-issued Mobile Suica session is accepted by a plain fetch
  replay, and whether it survives a move from the owner's machine to OCI or
  Cloudflare egress.
- Whether the as-of date search returns more than 100 total rows inside 26 weeks
  on the current production account.
- Exact Google Wallet Suica fields, visible count and oldest date on the owner's
  Android device; whether high-volume use has caused observable omissions.
- Whether a Google Wallet Takeout archive contains Suica balance/history, and if
  so its schema, retention and completeness relative to Mobile Suica.
- Whether the Wallet website exposes this Japanese Suica and the same recent
  activity as the Android app; generic transit documentation is not enough to
  assume it does.
- Exact JRE POINT history columns and whether rail points are one weekly row or
  multiple rows grouped under a weekly posting in the current UI.
- Whether the JRE POINT second password is re-requested for every new session,
  after a fixed timeout, or for every history visit.
- App API pinning/attestation, Google Wallet/Mobile FeliCa storage boundaries,
  and whether app history uses the same server endpoints as the Web site.
