# Mobile Suica / JRE ID / JRE POINT source assessment

Status: unattended Browser Rendering login, Worker collection, and private R2 storage validated, 2026-08-31

Scope: consumer-owned Mobile Suica SF data and the directly related JRE ID / JRE POINT data paths

Non-goals: charging, ticket purchase, card/account changes, migration to JRE ID,
security-control bypass, or retention of secrets, PII, and real account values

## Decision

Use the official Mobile Suica member website as the primary SF source. The
account owner has confirmed that the current account uses **JRE ID**, not the
legacy Mobile Suica ID, and signs in with a passkey held in Bitwarden. The
implemented route copies only the source-scoped JRE ID credential into a Worker
Secret, uses Cloudflare Browser Rendering for each fresh login, and switches to
plain Worker replay for the history pages. Bitwarden is read only by an explicit
local sync command after credential changes; the scheduled Worker never connects
to Bitwarden. `pnsk-lab/mnie`'s read-only
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
legacy client is consequently protocol prior art only for this account. The
post-login session can be replayed from plain WSL Node and Cloudflare Workers.
Unattended renewal is also live-validated: Browser Rendering executes the
official JRE page, while a CDP virtual authenticator uses the stored P-256
credential. Remaining work is operational hardening, retention policy and
repeat-run observation rather than an authentication feasibility gate.

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
- Official Google Play listings, a separately obtained Mobile Suica 6.6.0 XAPK,
  its split signatures, ordinary DEX files, native .NET Android assembly store,
  and selected first-party managed assemblies. The package and extracted files
  stayed under `/tmp` and were not committed or redistributed.
- Public, unauthenticated JavaScript from `www.mobilesuica.com`; the JRE ID
  redirect target was also requested without credentials and returned an
  Akamai access-denied response from this WSL network.
- A live `kogane capture` Chrome Beta 153 login with the owner's Bitwarden
  passkey, followed by one SF-history search. Kuebiko retained the private raw
  traffic; only paths, field names, cookie names, counts and protocol metadata
  are recorded here.
- Source-scoped session replay from WSL Node and a deployed Cloudflare Worker,
  plus unattended Browser Rendering login using a virtual WebAuthn authenticator,
  with successful private R2 storage and no credential values in the manifest
  or collection summary.

Account-specific facts in this update were supplied by the account owner: the
current Mobile Suica login is JRE ID, a passkey is used and stored in Bitwarden,
and the Android Suica is visible through Google Wallet. The local `bw` CLI
confirmed RP ID `id.jreast.co.jp`, origin `https://id.jreast.co.jp`, ECDSA P-256
and the exact allowed credential. The live Google Wallet fields remain a
separate verification item.

No passwords, cookies, full Suica IDs, point IDs, or other personal identifiers
were recorded.

## Official data routes

| Route                                                | Officially available data                                                                                                                                                                      | Window / limit                                                                                                        | Timing and granularity                                                                                                                        | Automation assessment                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Mobile Suica Android/iOS app                         | Current SF balance and SF use history                                                                                                                                                          | History: within 26 weeks, at most 100 entries                                                                         | App history includes the current day's use; rail rows show station names where available, bus rows show operator, and auto-charge is labelled | Best user display, but poor cloud collector: tied to a supported device and app state                                        |
| Mobile Suica member website (PC), via current JRE ID | SF history, balance after each row, printable history                                                                                                                                          | Official UI says within 26 weeks and at most 100 entries per search                                                   | Through the previous day; available 05:00 to 00:50 JST                                                                                        | Preferred primary route; unattended Browser Rendering login and plain Worker replay are both live-proven                     |
| Google Wallet on Android                             | SF balance and a card transaction-history view; Google documents purchases, card/store charges and gifts for Japanese e-money, and generic transit views expose station names, dates and times | No fixed Suica count/window found; Google warns that details can be omitted after many transactions in a short period | Device-local official platform view; current-day behavior and exact Suica row fields need live capture                                        | Useful secondary snapshot/cross-check. No documented consumer read API; app/UI automation is device-bound and likely brittle |
| Mobile Suica app, JRE POINT menu                     | JRE POINT current holdings; also write operations that Kogane must never call                                                                                                                  | Current point balance only is documented                                                                              | No point-history feature is documented on this route                                                                                          | Low-value balance snapshot; do not use for reward history                                                                    |
| JRE POINT Web/app                                    | Total point balance and point history                                                                                                                                                          | Point history: previous one year                                                                                      | History marks distinguish rail, Suica purchase, View Card, and other sources; exact live columns still need capture                           | Preferred reward route, but authentication/anti-abuse is materially harder                                                   |
| JRE ID                                               | Authentication and SSO only                                                                                                                                                                    | JR East says SSO persists for an unspecified "certain time"                                                           | Passkey, SMS, and password login are supported                                                                                                | Authentication layer, not a financial data source                                                                            |

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

For this account, the local `bw` CLI returned exactly one matching JRE ID FIDO2
credential. The inspected metadata and successful live ceremony confirmed RP ID
`id.jreast.co.jp`, origin `https://id.jreast.co.jp`, ECDSA P-256, one exact
allowed credential and `userVerification: required`. No vault export or custom
`data.json` decryption was required.

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

### Live JRE ID and Mobile Suica replay, 2026-08-31

The account owner completed the official passkey flow in the dedicated
`kogane capture` profile. The captured read-only protocol established:

- JRE ID first posts `AUTH_THREEKEY` plus a 32-character hexadecimal browser
  fingerprint to `/idcs/account_custom/login`.
- The passkey branch posts `AUTH_FS2` and a JSON `username` field to
  `/idcs/account/login`; the response challenge uses RP ID
  `id.jreast.co.jp`, `userVerification: required`, a 60-second timeout and one
  allowed `public-key` credential.
- A standard WebAuthn assertion is returned in `Fs2AuthenticationResponse`,
  with `id`, `rawId`, `authenticatorData`, `clientDataJSON`, `signature` and
  `userHandle`. No values from those fields are retained in this document.
- The current JRE ID bundle includes Fingerprint2 2.1.5 and sends its
  32-character hexadecimal result as `Fingerprint`.
- The Mobile Suica history endpoint is
  `POST /iq/ir/SuicaDisp.aspx`, with `baseVariable`, `specifyYearMonth`,
  `specifyDay` and the Shift_JIS search-button value. It returns Shift_JIS HTML.
  The authenticated request carried only `ASP.NET_SessionId`, `sc_auth` and
  `TS0184138d` cookies for this host.

The exact captured history POST was replayed from ordinary WSL Node `fetch` and returned
the authenticated history page with HTTP 200. A separate deployed Worker then
patched the search date, fetched the same endpoint from Cloudflare egress, parsed
15 rows, and stored three private R2 artifacts with failure count zero. This
rules out a Chrome-process, TLS-fingerprint and source-IP binding for the
post-login SF-history read. It does not prove that the JRE ID login itself is
browserless.

The observed JRE ID `sid`, `sid_fs2` and `sid_risk_fs2` cookies have
`Max-Age=3600`; Mobile Suica's cookies are session cookies and its UI expires
after 20 minutes of inactivity. The daily 00:50–05:00 JST service stop also
prevents keepalive from bridging one day to the next. Daily unattended
collection therefore performs a fresh Browser Rendering bootstrap on every run;
session replay alone is intentionally treated as short-lived.

Direct Worker login was also tested and rejected before the WebAuthn challenge.
Both standard Worker `fetch` and the TAMIA Workers VPC path returned
`resultCode=CO-AT5000` for `AUTH_FS2`. Supplying the exact successful browser
Fingerprint2 value did not change the result. This demonstrates that copying the
fingerprint string or changing only the egress path is insufficient; it does not
identify which Fraud Defense signal caused the rejection. Browser Rendering
then succeeded with the same account and stored credential.

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

The chosen boundary is **occasional local credential sync, cloud execution**:

1. After a passkey or JRE ID update, the owner unlocks Bitwarden in WSL and runs
   `bw:verify` followed by `bw:sync`.
2. The sync command filters to exactly one `id.jreast.co.jp` credential and
   copies only username, RP ID, credential ID, user handle, counter and PKCS#8
   private key into the source-scoped `JRE_ID_CREDENTIAL_JSON` Worker Secret.
3. It never copies the vault, master password, `BW_SESSION`, unrelated items or
   a captured assertion. Scheduled runs never contact Bitwarden.
4. Browser Rendering loads the official JRE page and supplies that credential
   through a temporary CDP virtual authenticator. Browser-generated page signals
   remain in the browser; the resulting Mobile Suica session stays in memory and
   is handed to the read-only history transport.
5. Cookie values, `baseVariable`, IDs, private keys and assertion bytes never
   enter logs, manifests or Git. Only the private raw history evidence contains
   the official page's short-lived form state.

This intentionally stores one exportable source credential in Cloudflare rather
than the whole Bitwarden vault. Registering a separate Kogane-only passkey would
reduce coupling to the owner's general Bitwarden credential, but it is an
optional account-security change, not required for the working PoC.

### JRE POINT route

JRE POINT Web currently offers both the JRE ID path and a legacy JRE POINT-ID
path for accounts not yet migrated. Point history is additionally protected by
the second password after login. The official JRE POINT app can opt into device
biometric/passcode login, but the second-password requirement for point history
still needs a live read-only check after JRE ID migration.

The important open question is whether an already authenticated JRE POINT
session can replay the history request from a non-browser runtime without
re-running Fraud Defense. Static and read-only dynamic transport analysis are
appropriate next steps when the official UI does not answer that question.

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
- **JRE ID redirect target:** `https://id.jreast.co.jp/` redirected to
  `https://www.jreast.co.jp/jreid/`; the latter returned HTTP 403 with
  `server: AkamaiGHost` and an `edgesuite.net` reference from this WSL network.
  This confirms Akamai on that public path, not that the authenticated API or
  Mobile Suica app API uses the same edge policy.

### Not confirmed

- The vendor/function behind Mobile Suica's opaque `TS...` cookie was not
  established. It may be security or traffic-management state; vendor
  attribution would be speculation.
- JRE POINT's 403 may depend on source IP, geography, TLS/browser fingerprint,
  cookies, or another policy. It must be reproduced from the user's normal
  browser and then from the intended OCI/Cloudflare egress before assigning a
  specific cause.
- The inspected app configuration explicitly enables public-key pinning. No
  direct Play Integrity or SafetyNet binding was found in the manifest or
  selected managed assemblies, but absence from this static search does not
  prove that runtime attestation is absent.

## Android package reverse-engineering follow-up

Official Google Play packages exist:

- Mobile Suica:
  [`com.mobilesuica.msb.android`](https://play.google.com/store/apps/details?id=com.mobilesuica.msb.android)
- JRE POINT:
  [`jp.co.jreast.jrepoint`](https://play.google.com/store/apps/details?id=jp.co.jreast.jrepoint)
- Google Wallet:
  [`com.google.android.apps.walletnfcrel`](https://play.google.com/store/apps/details?id=com.google.android.apps.walletnfcrel)

JR East links to Google Play from its own service pages. No official standalone
APK download was found; Google Play remains the official public delivery route.
The workspace, local private repositories, GitHub repositories/branches/gists,
Downloads, Documents, Desktop and prior temporary trees were searched for the
previously mentioned Mobile Suica decompile, but no preserved APK, extracted
tree, hash manifest or reproduction note was found. A private Vpass decompile
was present but is unrelated and was not treated as Mobile Suica evidence.

### Reproduction and package facts

The direct Google Play retrieval helper stopped at Google's Terms-of-Service
acceptance boundary; no acceptance was automated. As a reproducible fallback,
`apkeep -a com.mobilesuica.msb.android -d apk-pure <output-directory>` retrieved
an [APKPure](https://apkpure.com/mobile-suica/com.mobilesuica.msb.android) XAPK.
APKPure is a third-party redistribution source, so this proves the contents of
that signed package, not byte identity with a package delivered to this
account/device by Google Play. Re-run against an owned device as the provenance
upgrade.

The XAPK identified package `com.mobilesuica.msb.android`, version name 6.6.0,
version code 80, minimum SDK 23, and target/compile SDK 36. It contained base,
`config.en`, `config.xxhdpi`, and `config.arm64_v8a` splits. `apksigner verify
--verbose --print-certs` succeeded for every split with the same JR East signer
subject (`Mobile Suica Group`, East Japan Railway Company), signer SHA-256
`94d62e9e47ecf2a961e9b5a2f6761ca9085ae78d65e4e6f86b0513a6a5508f9b`, and a
Google source stamp. These checks establish signer continuity and package
structure; they do not make APKPure an official origin.

The base APK contains two ordinary, extractable DEX files (`classes.dex` and
`classes2.dex`); no DEX decryption step was required and no hidden/encrypted DEX
was found. Most first-party logic is instead in the arm64 split's .NET Android
assembly-store ELF, `libassemblies.arm64-v8a.blob.so`. The reproducible static
pipeline is: unzip XAPK; verify every APK signature; inspect base and splits with
`aapt2`; unzip DEX/assets; use the upstream
[dotnet/android](https://github.com/dotnet/android) assembly-store format or
[`pymauistore`](https://github.com/mwalkowski/pymauistore) to extract managed
assemblies; and disassemble selected DLLs with `monodis` or ILSpy. Relevant
assemblies include `MobileSuicaNGAPI.dll`,
`Suica.Model.dll`, `Suica.ViewModel.dll`, `Suica.Droid.dll`,
`MFCBindingLibrary.dll`, and `MFCCommonLibrary.dll`. Do not commit APK, DEX,
native blobs, DLLs, IL, tokens, or account payloads.

### Confirmed static transport and schema

The packaged `assets/Property.json` names `https://ssl.mobilesuica.com/` as the
app Web API base, `https://id.jreast.co.jp/` as the JRE ID base, and separate
`rfd.mobilesuica.com`/`regist.mobilesuica.com` JSON resources. Configuration in
an app build can be stale, test-oriented, or remotely overridden; dynamic
capture is still required before treating these as live production contracts.

The read-only SF-history method is an HTTP JSON `POST` to
`/frna/iq/ir/getSuicaSfHistory` (API ID `NAIQIR01`, business type `00`). The
request has a common header (`apiID`, `businessType`, `optimist`, `session`) and
a card list whose static builder accepts `idm`, `cid`, and an `sfLog` array. The
response has a common result header (`resultCode`, `messageID`, `message`,
`optimist`) and a card list containing `IDm`, `Cid`, and `SfHistoryInfoList`.
Each history item contains `Order`, `Valid`, `Message`, and a `Record` with
`Date`, `Type1`, `Type2`, `Place1`, `Place2`, `Balance`, and `Amount`.

No cursor, page, offset or limit field appears in this request/response model.
The app's `StoredFareHistoryService` calls the Mobile FeliCa provider for card
histories and passes `sfLog` into the request. The best current inference is
that this endpoint validates or enriches device-read FeliCa log records rather
than paginating a server-side account ledger. The exact `sfLog` encoding,
maximum count, and whether the response adds server-only rows remain unconfirmed
until a consented read-only runtime capture.

Other statically confirmed read candidates are
`/frna/iq/ci/getSuicaCardInfo`, `/frna/iq/ci/getJrePointAmount`,
`/frna/ka/en/getJreidUserInfo`, and `/frna/va/sp/getAppStartUpInfo`. Authentication
uses `User-Agent`, `X-Suica-Header`, `Accept-Language`, and
`Authorization: Bearer ...` headers. The client stores access and refresh-token
state, uses `/frna/ka/lg/getAccessToken` for renewal, and retries an authorized
request once after HTTP 401. Static types show refresh-token input and a rotated
authentication result, but exact live expiry units and renewal policy are not
proven. Never log or persist token values during validation.

The same client library contains charge, ticket purchase/refund, registration,
update, delete and migration methods. Their presence is why a collector must use
an explicit host+path allowlist and fail closed: only the five read candidates
above may be explored, while every other `/frna/` path is rejected before any
network call. Merely relying on HTTP method is insufficient because reads and
writes both use POST.

### Device, integrity and Google Wallet boundary

The package declares Mobile FeliCa access and biometric capabilities, and the
managed code has device-ID, encrypted local token and fingerprint-check provider
types. Packaged build/default identifiers are fixture placeholders and are not
evidence of a runtime device identity. `PublicKeyPinningEnabled` is `true` in
configuration. No direct Play Integrity/SafetyNet symbol was found in this
bounded static pass; a runtime handshake may still enforce device, app, key,
FeliCa, TLS-client, or integrity state.

The package includes the Xamarin Google Play Services Wallet binding, the deep
link `suicaapp://startwallet`, and wallet-link status values for API and Wallet
linkage. It also separately calls the Mobile FeliCa provider (`GetSFLog`,
`GetAmount`, `GetIdm`, and `GetICCode`). This supports a launch/linkage boundary,
not a claim that Mobile Suica can read Google Wallet's consumer transaction
history through a Wallet API. Google Wallet remains a separate device-visible
cross-check route.

### Version boundary and public Web JavaScript

The inspected 6.6.0 build contains JRE ID base configuration, JRE ID user-info
types, and token/login paths, whereas `mnie` and the legacy PC form implement a
Mobile Suica ID/password flow. A historical owner snapshot also pre-dated JRE ID
migration, while the owner now confirms JRE ID/passkey use. These are distinct
version/account-state boundaries; static 6.6.0 evidence must not be projected
onto the legacy Web form or assumed to reproduce the current live JRE ID
ceremony.

Unauthenticated `www.mobilesuica.com` loaded only small legacy presentation
scripts (`hf.js`, `main.js`, `Common.js`). They exposed no `fetch`, XHR, JRE ID,
WebAuthn, OAuth, token, or `/frna/` transport. The JRE ID root redirected to the
public JR East JRE ID page, which Akamai denied to this WSL client, so no JRE ID
bundle or ceremony schema was obtained. This is an observation barrier, not a
reason to bypass it: the next step is a visible browser capture on the owner's
normal network, limited to non-secret request names and schemas.

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

| Runtime                               | Mobile Suica SF through current JRE ID             | JRE POINT                 | Google Wallet secondary view                         | Why                                                                                                                                |
| ------------------------------------- | -------------------------------------------------- | ------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Local Windows/WSL                     | High for credential sync, capture and replay tests | Medium                    | Medium for UI/export capture                         | Bitwarden is unlocked only for occasional source-scoped sync; no daily local job is needed                                         |
| Cloudflare Worker + Browser Rendering | High                                               | Low                       | Very low                                             | Fresh JRE passkey login, Mobile Suica session bootstrap, plain fetch history collection and private R2 storage are all live-proven |
| Cloudflare Container                  | Unnecessary for this source                        | Medium                    | Very low                                             | Full Linux browser adds operational cost without improving the proven Browser Rendering path                                       |
| Generic OCI / Kubernetes              | Unnecessary for this source                        | Medium                    | Very low                                             | Useful only as a fallback experiment; the working collector is serverless                                                          |
| Owner's Android device                | High for official app view, low as a server job    | Medium-high for point app | High for viewing, low-medium for local UI automation | Has the live Osaifu-Keitai/Wallet state; unattended orchestration, screen unlock and upgrades make it fragile                      |

Cloudflare's current docs describe Workers as V8 isolates with Web APIs and only
a subset/polyfill set of Node APIs; Containers run a full Linux/container image.
See [Workers Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
and [Containers overview](https://developers.cloudflare.com/containers/).

The deployed sequence is occasional WSL `bw:sync`, then a serverless Worker that
uses Browser Rendering for fresh authentication and plain fetch for history.
Container Chrome is not part of the operational path.
Keep Google Wallet experiments local to the owned Android device/Takeout. Do not
start with a cloud runtime and assume failures are source-side; first separate
session, encoding and egress/Fraud Defense issues.

## Cost and automation estimate

Scale: 1 = nearly direct export; 5 = fragile, device-bound or major protocol work.

| Deliverable                                                                     | Cost | Expected automation                                                                                 | Confidence                                                                  |
| ------------------------------------------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Current Mobile Suica SF, Worker + Browser Rendering + stored passkey credential |  2/5 | Fully unattended daily collection; local `bw:sync` only after credential changes                    | High; live login, 15-row collection and R2 manifest retrieval succeeded     |
| Current Mobile Suica SF, direct Worker JRE API                                  |  4/5 | Rejected at `AUTH_FS2` with `CO-AT5000`, both direct and TAMIA VPC                                  | High for the observed rejection; exact Fraud Defense signal remains unknown |
| Current Mobile Suica SF, imported short-lived session replay                    |  2/5 | Useful for diagnostics only; not the daily bootstrap                                                | High for replay, deliberately superseded by fresh Browser Rendering login   |
| Legacy Mobile Suica-ID fetch                                                    |  2/5 | Existing CAPTCHA flow and parser, but not applicable to the confirmed current account               | High on implementation, irrelevant as the production bootstrap              |
| JRE POINT balance + one-year point history                                      |  4/5 | Semi-automatic bootstrap, second-password step, then replay if proven; otherwise browser collection | Medium-low                                                                  |
| Google Wallet one-time app/Takeout snapshot                                     |  2/5 | Manual or owner-triggered local capture; good for comparison, not scheduling                        | Medium; exact exported Suica fields are unknown                             |
| Google Wallet recurring Android UI capture                                      |  4/5 | Device-bound UI automation with screen/device state and undocumented omission risk                  | Medium-low                                                                  |
| App/API discovery via APK static analysis                                       |  4/5 | Useful research, not itself an operational collector                                                | Medium                                                                      |
| Full Mobile Suica app automation in cloud                                       |  5/5 | Not recommended                                                                                     | High                                                                        |

Overall recommendation: use the now-proven Worker + Browser Rendering collector.
Keep Bitwarden access local and occasional, but accept that the selected
source-scoped passkey private key is copied to a Worker Secret. A Kogane-only
passkey is an optional isolation improvement. Do not revive the direct JRE API,
TAMIA or imported-session workaround unless Browser Rendering regresses.
Use Google Wallet to inventory/cross-check recent device-visible data and test a
one-time Takeout export, but do not choose it as the ledger source without a
row-for-row completeness result. Characterize JRE POINT separately as the
longer-lived, lossy rewards path.

## Next validation, in order

1. **Repeat-run matrix.** Observe at least seven scheduled runs across the daily
   service stop and record only success/failure stage, duration, Browser usage,
   row count and manifest key. Do not keep sessions alive between runs.
2. **Credential rotation drill.** After the next owner-initiated JRE ID/passkey
   change, run `bw:verify` and `bw:sync`, verify `/credential-check`, then confirm
   one collection. Ensure the old secret version is no longer deployed.
3. **Optional Kogane-only passkey.** If isolation is worth another account
   credential, register a dedicated passkey through the official UI and switch
   the local sync selector after explicit owner review. The current credential
   already works, so this is not a production gate.
4. **Browser cost and failure telemetry.** Record Browser duration and acquisition
   errors without URLs, credential values or cookies. Alert on a failed manifest;
   do not automatically retry authentication many times.
5. **Pagination boundary.** The live account currently fits on one 15-row page.
   Retain the implemented earlier-date cursor and fail closed if one day alone
   reaches 100 rows; a synthetic parser test is not proof of the server limit.
6. **Google Wallet inventory and cross-check.** On the owned Android device,
   record only field names, visible row count, oldest/newest dates, whether
   amounts/balance-after/station/merchant/charge labels are present, and current
   balance. Compare the same recent transactions against Mobile Suica and list
   every omitted or coarsened field. Do not trigger charge, purchase or changes.
7. **One-time Google Takeout test.** Owner-initiate a Wallet-only export, inspect
   whether Suica rows and balances are present, and record format/window/fields.
   Treat absence as route-specific, not proof Google holds no other device data.
8. **JRE POINT live schema capture.** In the official Web UI, enter the second
   password manually and record field names, filters, row count, oldest date,
   category labels, pending state, point expiry fields and whether export exists.
   Compare at least one rail credit and one eligible Suica purchase with the SF
   history to quantify aggregation/loss.
9. **JRE ID/JRE POINT replay gate.** Capture a browser-issued JRE ID/JRE POINT session and
   try one read-only point-history replay from the same machine, then OCI. Stop
   if Fraud Defense requires repeated interactive/browser state; do not work
   around account locks or security challenges.
10. **Provenance and read-only app transport experiment.** Pull Mobile Suica 6.6.0
    or the then-current version from an owned device with `adb shell pm path` and
    `adb pull`, verify the JR East signer, and compare split names/hashes with the
    third-party XAPK. On that same device, perform one already-intended history
    refresh while recording only host, path, method, status, header names and
    redacted JSON keys. First allow only `ssl.mobilesuica.com` plus the five
    static read paths; abort before any unmatched path. If TLS pinning prevents
    observation, record that barrier and stop rather than disabling or bypassing
    the control. Determine whether `sfLog` is device input, its item count, and
    whether 401 causes exactly one token renewal/retry. Never record IDm, Cid,
    tokens, device identifiers, balances or transaction values.

## Open questions

- Whether JRE ID will continue to accept the Browser Rendering virtual
  authenticator over long-term scheduled use and after future browser/JRE bundle
  updates. The current P-256 credential, flags `0x1d` and counter 0 succeeded.
- Which specific Fraud Defense signal caused direct Worker and TAMIA VPC
  `AUTH_FS2` requests to return `CO-AT5000`. Copying the successful 32-character
  Fingerprint2 result was insufficient; further direct-API work is not required
  for the selected architecture.
- Exact server-side Mobile Suica idle lifetime and whether authenticated reads
  extend it; the UI states 20 minutes, but no overnight survival is expected.
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
- Whether pinning is enforced on the five read calls, whether any unobserved
  integrity/device proof is attached, the exact `sfLog` encoding/count and
  response relationship, and whether the current Google Play package is
  byte-identical to the signed third-party XAPK inspected here.
- Whether app history is solely device/FeliCa-derived plus server enrichment,
  and whether any app endpoint shares transport or records with the PC member
  website. Static path similarity is not sufficient evidence.
