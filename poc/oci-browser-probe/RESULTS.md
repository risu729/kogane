# OCI and WSL browser probe results

Observed on 2026-08-25. The probe never wrote a Vpass ID, password, cookie
value, request body, response body, browser profile, HAR, or screenshot to the
repository or probe output.

## Results

| Runtime | Browser surface | Egress observed by that browser | Login page | Authentication |
| --- | --- | --- | --- | --- |
| Windows Kuebiko, existing dedicated profile | Chrome 153, `Win32`, `webdriver=false`, five configured languages | host route was Cloudflare WARP/Gateway, AU; the capture tab's exact egress could not be queried because Kuebiko blocked the test endpoint | 200 | success; authenticated statement page rendered |
| Windows Kuebiko, completely new profile | same Chrome 153, `Win32`, `webdriver=false`, default `en-US` language | same host and route class as the successful run | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |
| OCI Playwright launch | official Chrome 151, headless, `Linux x86_64`, `webdriver=true` | `138.2.53.208`, JP | 403 | not attempted |
| OCI headed CDP | official Chrome 151, `Linux x86_64`, `webdriver=false` | `138.2.53.208`, JP | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |
| OCI Playwright launch | bundled Chromium 151, headless, `Linux x86_64`, `webdriver=true` | `138.2.53.208`, JP | 403 | not attempted |
| OCI headed CDP | bundled Chromium 151, `Linux x86_64`, `webdriver=false` | `138.2.53.208`, JP | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |
| local WSL headed CDP | official Chrome 151, `Linux x86_64`, `webdriver=false` | `104.28.196.200`, Cloudflare WARP/Gateway, AU | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |

The Windows host and WSL shared the same Cloudflare WARP/Gateway route and AU
country classification at test time. More importantly, the successful and
failed Windows runs used the same Chrome Beta binary and launch flags on the
same host; only the browser profile and its prior interaction/state differed.
A Japanese residential egress is therefore not required for the observed
success, and changing only OCI's source IP to the home route is not a sufficient
fix.

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
- The strongest remaining explanation is continuity in the existing profile:
  previously validated Akamai cookies, local/session storage, service worker or
  cache state, browser preferences, and prior human interaction history. The
  language list also differed (`en-US` only in the fresh profile versus five
  configured languages in the existing profile), so that profile-level
  fingerprint is not perfectly controlled.
- The experiment does not identify one decisive persisted value. It deliberately
  did not extract or compare cookie/storage values. It does show that ordinary
  Playwright or bare CDP over a fresh profile is insufficient on both Windows
  and Linux.

## Architecture consequence

The OCI Kubernetes collector remains a reasonable runtime for providers that
accept normal HTTP clients or Linux browser automation. Vpass is not ready to
move there. Do not schedule the current PoC: it would repeatedly send rejected
login requests.

The next bounded Vpass experiment should create a persistent, collector-owned
profile from ID/password, perform a one-time human bootstrap in that profile,
and then test a later automated login without copying any personal browser
cookie. If that continuity works, only the Windows browser runner must persist;
the user need not remain involved in scheduled runs. If it does not, Vpass stays
on the already validated dedicated Windows/Kuebiko profile. Route through the
home Tunnel only after a browser configuration works, because the current
evidence does not support IP-only routing as the remedy.

## References

- [Playwright browser installation and Chrome channels](https://playwright.dev/docs/browsers)
- [Playwright system requirements](https://playwright.dev/docs/intro)
- [Google Chrome for Linux](https://support.google.com/chrome/answer/95346?hl=en-GB)
