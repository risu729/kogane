# OCI and WSL browser probe results

Observed on 2026-08-25. The probe never wrote a Vpass ID, password, cookie
value, request body, response body, browser profile, HAR, or screenshot to the
repository or probe output.

## Results

| Runtime | Browser surface | Egress observed by that browser | Login page | Authentication |
| --- | --- | --- | --- | --- |
| Windows Kuebiko, existing dedicated profile | Chrome 153, `Win32`, `webdriver=false`, five configured languages | host route was Cloudflare WARP/Gateway, AU; the capture tab's exact egress could not be queried because Kuebiko blocked the test endpoint | 200 | success; authenticated statement page rendered |
| Windows Kuebiko, completely new profile | same Chrome 153, `Win32`, `webdriver=false`, default `en-US` language | same host and route class as the successful run | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |
| Windows Kuebiko, new `ja-JP` profile, normal 1920x1080 window | same Chrome 153, `Win32`, `webdriver=false`; OS-level input | same Windows host and route class | 200 | success; native form returned 302 and the authenticated My Page loaded |
| OCI Playwright launch | official Chrome 151, headless, `Linux x86_64`, `webdriver=true` | `138.2.53.208`, JP | 403 | not attempted |
| OCI headed CDP | official Chrome 151, `Linux x86_64`, `webdriver=false` | `138.2.53.208`, JP | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |
| OCI Playwright launch | bundled Chromium 151, headless, `Linux x86_64`, `webdriver=true` | `138.2.53.208`, JP | 403 | not attempted |
| OCI headed CDP | bundled Chromium 151, `Linux x86_64`, `webdriver=false` | `138.2.53.208`, JP | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |
| local WSL headed CDP | official Chrome 151, `Linux x86_64`, `webdriver=false` | `104.28.196.200`, Cloudflare WARP/Gateway, AU | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |

The Windows host and WSL shared the same Cloudflare WARP/Gateway route and AU
country classification at test time. A Japanese residential egress is therefore
not required for the observed success, and changing only OCI's source IP to the
home route is not a sufficient fix. The later fresh-profile success also shows
that prior cookie/profile continuity is not strictly required when the initial
browser surface and page interaction are accepted.

## Controlled fresh-profile matrix

The operator later noticed that the Tailscale `tamia` exit node had been marked
active during part of the work. Both before and after disabling that exit node,
independent IPv4 and IPv6 checks reported Cloudflare Sydney/AU egress. Tailscale
was left running without an exit node and WARP remained connected. The observed
Vpass success therefore did not require Japanese residential egress.

Each row below used a distinct profile and exactly one real login POST. Aborted
runs with no login POST are excluded. Dwell is measured from the saved login-page
response to the saved form request.

| Capture | Locale | Initial window | Dwell | Result |
| --- | --- | --- | ---: | --- |
| `11-23-06` | `ja-JP,ja,en-US,en` | normal | 157.3 s | 302 success |
| `12-02-09` | `ja-JP,ja,en-US,en` | normal | 203.8 s | 302 success |
| `12-07-07` | `en-US,en` | normal | 490.5 s | 302 success |
| `12-19-53` | `en-US,en` | normal | 30.1 s | Akamai 403 |
| `12-22-45` | `en-US,en` | minimized, `outer=0x0` | 210.7 s | 302 success |
| `12-27-24` | `en-US,en` | normal | 94.5 s | Akamai 403 |
| `12-31-27` | `en-US,en` | normal | 139.4 s | Akamai 403 |
| `12-34-58` | `en-US,en` | normal | 171.1 s | Akamai 403 |

This rules out Japanese locale, normal initial geometry and the Tailscale exit
node as individually necessary conditions. Longer dwell strongly improves the
result, and elapsed time is part of the sensor input, but it is not a sufficient
fixed threshold: 157 seconds succeeded while a later 171-second fresh run
failed. Script build is also not decisive. The same helper and main-script
hashes occurred in both successful and rejected runs. The remaining result is a
probabilistic/session-level Akamai score involving warm-up, generated cookie
state, interaction timing, rotating configuration and recent server-side state.

## What this isolates

- Headless Playwright launch signals are enough for Akamai to reject even the
  initial page GET. Both official Chrome and Playwright's bundled Chromium had
  `HeadlessChrome` and `webdriver=true` in this configuration.
- Starting a full headed browser under Xvfb and attaching through CDP removes
  those two signals. The login page then loads normally for both Chrome and
  Chromium, but the authentication POST is still rejected.
- Kuebiko is a passive CDP recorder; it is not a stealth-patching layer. It
  adds the profile, localhost CDP and NetLog flags, but does not inject
  JavaScript, override browser APIs, add `--enable-automation`, or change the
  user agent.
- A completely fresh Kuebiko profile failed even with the same Windows Chrome
  153 binary, `Win32`, `webdriver=false`, host and route as the successful
  profile. This rules out Windows, Chrome 153 and bare Kuebiko/CDP as sufficient
  conditions.
- A later fresh profile succeeded after changing the initial browser surface:
  Japanese locale and language headers, a normal 1920x1080 outer window from the
  first page load, 1.0 device scale, and Windows OS-level input. Subsequent
  one-variable runs showed that locale and normal geometry are helpful controls,
  not strict requirements. The successful request was the same native form
  encoding as the failed requests.
- The failed fresh captures' first Akamai pixel reported a minimized Windows
  geometry: outer size 160x28 and screen position -25600,-25600. The successful
  fresh run reported outer size 1920x1080 and position 10,10 from its first
  pixel. Both physical screens were 16:10, so aspect ratio itself is not the
  observed difference; initial minimized state is the stronger geometry signal.
- Locale also changed from `en-US` only to `ja-JP,ja,en-US,en`, consistently in
  both `Accept-Language` and the Navigator surface. Login dwell time changed
  from about 30 seconds to about 157 seconds. These variables were changed
  together, so the capture cannot assign causality to only one of them.
- Successful and failed runs each made nine sensor posts before the login. Event
  count alone is not the explanation. The experiment deliberately did not
  extract or compare cookie/storage values.
- A 30-second normal-window control failed, as did 94-, 139- and 171-second
  fresh controls. Successful controls ranged from 157 to 490 seconds. The
  collector must not interpret a fixed sleep as an authorization guarantee.

## Fresh-profile traffic forensics

A second manual bootstrap in a new persistent Windows/Kuebiko profile produced
two native HTML form submissions to `/memapi/jaxrs/xt_login/agree/v1`. Both were
rejected with an HTML `403` from `AkamaiGHost`; no authenticated Vpass API call
followed. An older successful established-profile capture used the same native
form encoding and endpoint, so form encoding by itself does not explain the
difference. A separate successful JSON request seen in another capture was an
internal API-style call and is not the right control for the native login form.

The failed run did collect and transmit substantial Akamai telemetry:

- the page loaded `/akam/13/1129fc33` and posted the 24 named fields
  `ap,av,bp,br,bt,crc,cv,dp,fh,fonts,fp,ieps,jsv,lt,nap,nav,ps,sp,sr,t,timing,u,z,zh`
  to `/akam/13/pixel_1129fc33`;
- it loaded a rotating, obfuscated first-party Bot Manager script and made 24
  unique posts whose JSON body had the sole top-level key `sensor_data`;
- every sensor post was accepted with `201`, including bursts immediately
  before both rejected login requests. Sensor ingestion and authorization of a
  protected endpoint are therefore separate decisions;
- the current script directly references the active element, its `id`, `name`,
  `for`, `placeholder`, ARIA labels and input type. This proves field identity
  and field-type collection, not collection of the entered value;
- the script and pixel probes inspect browser, navigator, display, storage,
  capability, font, canvas and timing surfaces. Akamai's published material
  additionally describes mouse, click, scroll, key, touch and session-flow
  telemetry. The opaque `sensor_data` value prevents a field-by-field decode of
  the current payload without reversing that script build.

The page also called Vpass's own `UAService/getDevice/v1`, independently of the
Akamai collector, and Adobe Experience Edge received ordinary analytics and
screen/browser fields. Those calls should not be conflated with the Akamai
decision.

Both the successful candidate and failed profile used cookie names including
`_abck`, `bm_sz`, `ak_bmsc`, `bm_sv` and `bm_mi`. Values were intentionally not
captured or compared, and the failed run had not yet emitted its shutdown-time
storage snapshot. Cookie-name presence alone therefore says nothing about the
validity of the state. The evidence remains consistent with differences in
cookie value/age/update order, server-side score, rotating sensor build, profile
continuity or a combination of those factors. It is not consistent with the
simple explanation that the manual run generated too few events.

For future probes, stop after the first login `403`. Repeating a rejected login
in the same profile adds no useful control and may change server-side state.

## Current-script deobfuscation notes

Static expansion of the 26 KiB `/akam/13` helper recovered its navigator,
screen, plugin, capability, canvas, storage, permission, automation-artifact,
battery, timezone and timing probes. It URL-encodes those results into the
named pixel fields and posts them after page load, retrying automation probes
for roughly 500 ms first.

The 564 KiB Bot Manager build uses a control-flow VM and runtime string
decryption, so its complete schema was not recovered. Running the saved script
only in an isolated blank page with networking replaced by a local sink showed
capture-phase listeners for:

- autofill, focus, blur, input, paste and keyboard events;
- click, mouse move/down/up and pointer down/up;
- touch start/move/end/cancel;
- device motion and orientation.

No scroll listener appeared in that isolated run, although Akamai describes
scroll telemetry as a platform capability. The script classifies password
inputs separately from text/search/URL/email/telephone/number inputs. It reads
input attributes and invokes the input value getter. Controlled dummy values of
different lengths did not appear verbatim in the emitted payload and did not
change its length, but that does not rule out fixed-size or transformed value
features.

The emitted request remains JSON with only `sensor_data` at the top level. The
observed generation path uses custom transforms followed by `TextEncoder` and
Base64; WebCrypto was not invoked in the isolated probe. Treat the payload as an
opaque versioned format rather than a stable public API.

## Public automation precedents

- `braineo/smbcCardSpider` used `requests.Session` and the same internal login,
  statement and card-selection JSON endpoints in 2016. It predates the current
  Akamai client telemetry and is evidence for endpoint continuity, not a current
  bypass.
- `hdemon/vpass-scraper` used ordinary Chrome, Selenium, Xvfb and a maximized
  1366x768 display in 2017.
- the archived 2026 `risu729/smcc-meisai-scraper` did not automate password
  login. It reused an established Windows Chrome profile after manual login.
- no reproducible 2024-2026 public implementation was found that performs a new
  Vpass password login using only Playwright, curl-cffi or impit. A contemporary
  Akamai case study for another site found that the same cookies failed through
  Playwright's HTTP client but succeeded through `fetch()` in the browser page,
  showing why cookie transplant alone is not a sufficient design assumption.

## Architecture consequence

The OCI Kubernetes collector remains a reasonable runtime for providers that
accept normal HTTP clients or Linux browser automation. The current OCI Vpass
probe is still not schedulable, but a one-time human bootstrap is no longer a
proven requirement: a new Windows profile succeeded with a coherent locale and
normal initial window state.

The next implementation should retain one successful collector-owned profile,
wait at least three minutes before its first login attempt, stop on the first
403, and call the internal JSON APIs through `fetch()` inside that Chrome page.
Three minutes is an engineering safety margin, not a proven threshold. Reusing
the profile avoids repeatedly gambling on a new Akamai score. OCI should repeat
the same full-browser warm-up and page-local fetch pattern under headed Chrome.
Route through the home Tunnel only after that browser configuration works,
because the evidence does not support IP-only routing as the remedy.

## References

- [Playwright browser installation and Chrome channels](https://playwright.dev/docs/browsers)
- [Playwright system requirements](https://playwright.dev/docs/intro)
- [Google Chrome for Linux](https://support.google.com/chrome/answer/95346?hl=en-GB)
- [braineo/smbcCardSpider](https://github.com/braineo/smbcCardSpider)
- [hdemon/vpass-scraper](https://github.com/hdemon/vpass-scraper)
- [risu729/smcc-meisai-scraper](https://github.com/risu729/smcc-meisai-scraper)
- [Akamai detection methods](https://techdocs.akamai.com/cloud-security/docs/detection-methods)
- [Akamai cookie-versus-page-fetch case study](https://github.com/imoonkey/openweb/blob/ccd701290930045fd1a5746a7a6820548d09e1e5/src/sites/costco/DOC.md)
