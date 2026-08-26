# Akamai comparison and Vpass cookie-portability notes

Observed on 2026-08-25. No credential, cookie value, account response, card
identifier, or public IP address is included in this document.

## Source quality

The referenced Qiita post about operating an Expedia collector is useful as a
single operator's field report, not as an Akamai specification. Its broad
claims that IP, cookies, TLS impersonation, and headed Chrome are not each
sufficient agree with Akamai documentation, patents, and independent tests.
The post's fixed 24-hour cycle, detection of CDP merely being present, and
claims about a universal human-only remainder are not independently established
and must not be generalized to Vpass.

The strongest corroborating sources are:

- Akamai's detection-method documentation and privacy white paper, which list
  header consistency, browser/device fingerprinting, TCP/TLS, URL/timestamp,
  and mouse, touch, and keyboard telemetry.
- Akamai patents describing `_abck`, `bm_sz`, behavioral autoposts, cookie
  replay controls, dynamic JavaScript variants, and compound browser/network
  fingerprints.
- A reproducible Costco comparison where the same browser and cookies yielded
  403 through Playwright's HTTP client but 200 through DOM `fetch()`.
- Counterexamples where cookie portability works only when paired with a
  compatible transport fingerprint, including the Dell warranty collector.

Cookie portability is therefore conditional rather than impossible. The
protected endpoint and policy matter, as do cookie freshness, TLS/HTTP2,
header order, browser execution, and server-side session state.

## Cross-site static comparison

Public, unauthenticated pages were fetched at low volume. ANA, Uniqlo JP,
Amtrak, Best Buy, Costco, Delta, Domain AU, and Sony all exposed the classic
`/akam/13/<id>` helper plus a larger random-looking first-party script path.

All helper files were about 26.6-26.7 KiB and exposed the same broad collection
categories after mechanical string-table expansion:

- navigator, User-Agent, platform, vendor, and hardware concurrency;
- languages;
- screen, viewport, window geometry, and color depth;
- plugins and MIME types;
- canvas;
- permissions and storage APIs;
- battery, timezone, touch, and motion capability; and
- `webdriver` and Selenium-style automation artifacts.

They use XHR to POST form-encoded data to `/akam/13/pixel_<id>`. No direct CDP
protocol probe or WebCrypto use was identified in these helpers. Each file had
a different SHA-256, and helper IDs changed on short re-fetches. Code must
discover the current paths from HTML instead of pinning a path or hash.

The larger main scripts were roughly 539-632 KiB and VM-obfuscated. Vpass
isolation showed listeners for focus, blur, autofill, input, paste, keyboard,
mouse, click, pointer, touch, device motion, and orientation. The Vpass main
payload used a custom transform, `TextEncoder`, and Base64, not WebCrypto.
Static similarity alone does not prove that every customer build collects the
same fields.

The Vpass helper and main files fall into these same size and loader families,
but successful and rejected Vpass sessions have used both matching and
different script builds. Script hash is not a sufficient explanation for the
login result.

Initial denial responses also varied across public sites. American Airlines,
Adidas, and Home Depot returned 403 to a plain client, but with different body,
header, cookie-name, and branding patterns. A Vpass-style short Access Denied
page is not unique to Vpass, and a top-page 200 does not imply that a login
endpoint uses the same policy.

## Kuebiko cookie-portability experiment

The long-running owner capture used `--snapshot-storage`, which writes its
snapshot only when the run ends. To preserve the owner browser, a second
short-lived Kuebiko process attached to the same CDP endpoint with
`--snapshot-storage` and `--capture-cookies`; only the second logger was
stopped. Cookie values remained local and were never printed.

Seventeen `smbc-card.com` cookies were mapped from CDP `Cookie` records to the
allowed `CookieParam` fields and installed into a fresh Chrome process with a
separate profile. The target page was unauthenticated. A direct HTTP client and
page-local `web_meisai_top/v1` calls also returned 401.

This is not yet a valid proof that cookies alone are insufficient. The source
page still displayed its old authenticated DOM, but a new page-local API call
in the source process also returned 401. Earlier in the same capture the API
returned 200. The most likely confounder is that the Vpass application session
expired or rotated before the transfer trial.

No `Secure-Session-Registration` or `Secure-Session-Challenge` response header
name was found in the saved 2026-08-25 metadata. That provides no current
evidence that Vpass uses Chrome Device Bound Session Credentials, although the
absence of a saved header is not a general proof of absence.

## Valid follow-up matrix

A transfer trial is valid only when the source API is 200 immediately before
the snapshot, immediately after it, and after the target request. Stop after
the first 401 or 403.

1. Same Chrome and same tab, page-local `fetch()` (positive control).
2. Same Chrome context and a new tab.
3. Fresh Chrome process with cookies only, before its first Vpass navigation.
4. Fresh Chrome with cookies plus localStorage, then sessionStorage as a
   separate arm.
5. External HTTP client with the same cookie jar, only after a separate Chrome
   process succeeds.

Each arm should start from a separate newly valid source session because a
target request can rotate or revoke session state. Compare cookie jars and
wire cookie headers only through a local keyed HMAC equality result; never log
the values or a reusable unkeyed digest.

Kuebiko remains passive: it uses the CDP Network domain and does not enable
Playwright routing or Fetch interception. This matters because independent
wire diffs show that merely enabling Playwright `page.route()` can alter cache
headers and header order.

The missing Kuebiko capability is a point-in-time storage snapshot without
ending a long-running owner capture. It is tracked in
<https://github.com/risu729/kuebiko/issues/233>. Snapshot restoration is an
active downstream automation concern and is intentionally not part of that
issue.

## References

- <https://qiita.com/swimple/items/d7b3296e70a267e54a53>
- <https://techdocs.akamai.com/cloud-security/docs/detection-methods>
- <https://www.akamai.com/site/en/documents/white-paper/compliance-through-privacy-by-design-white-paper.pdf>
- <https://patents.google.com/patent/US11374945B1/en>
- <https://patents.google.com/patent/US12470598B2/en>
- <https://patents.google.com/patent/US12212598B2/en>
- <https://github.com/imoonkey/openweb/blob/main/src/sites/costco/DOC.md>
- <https://github.com/stanford-rc/dell_warranty/commit/965972a>
- <https://github.com/daijro/camoufox/issues/554>
- <https://github.com/daijro/camoufox/pull/675>
- <https://arxiv.org/abs/2606.14525>
