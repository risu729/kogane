# OCI and WSL browser probe results

Observed on 2026-08-25. The probe never wrote a Vpass ID, password, cookie
value, request body, response body, browser profile, HAR, or screenshot to the
repository or probe output.

## Results

| Runtime | Browser surface | Egress observed by that browser | Login page | Authentication |
| --- | --- | --- | --- | --- |
| Windows Kuebiko capture | Chrome 153, `Win32`, `webdriver=false` | host route was Cloudflare WARP/Gateway, AU; the capture tab's exact egress could not be queried because Kuebiko blocked the test endpoint | 200 | success; authenticated statement page rendered |
| OCI Playwright launch | official Chrome 151, headless, `Linux x86_64`, `webdriver=true` | `138.2.53.208`, JP | 403 | not attempted |
| OCI headed CDP | official Chrome 151, `Linux x86_64`, `webdriver=false` | `138.2.53.208`, JP | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |
| OCI Playwright launch | bundled Chromium 151, headless, `Linux x86_64`, `webdriver=true` | `138.2.53.208`, JP | 403 | not attempted |
| OCI headed CDP | bundled Chromium 151, `Linux x86_64`, `webdriver=false` | `138.2.53.208`, JP | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |
| local WSL headed CDP | official Chrome 151, `Linux x86_64`, `webdriver=false` | `104.28.196.200`, Cloudflare WARP/Gateway, AU | 200 | 403 from `/memapi/jaxrs/xt_login/agree/v1` |

The Windows host and WSL shared the same Cloudflare WARP/Gateway route and AU
country classification at test time. The Windows browser authenticated while
the Linux browser's login POST was rejected. A Japanese residential egress is
therefore not required for the observed success, and changing only OCI's source
IP to the home route is not a sufficient fix.

## What this isolates

- Headless Playwright launch signals are enough for Akamai to reject even the
  initial page GET. Both official Chrome and Playwright's bundled Chromium had
  `HeadlessChrome` and `webdriver=true` in this configuration.
- Starting a full headed browser under Xvfb and attaching through CDP removes
  those two signals. The login page then loads normally for both Chrome and
  Chromium, but the authentication POST is still rejected.
- Kuebiko is a passive CDP recorder; it is not a stealth-patching layer. The
  successful environment was nevertheless materially different: Windows
  Chrome 153, a Windows JavaScript platform, and an existing dedicated browser
  profile/device history.
- This experiment cannot isolate whether the remaining decisive input is the
  Windows browser/OS network stack, the warmed browser profile and Akamai device
  state, Chrome 153 versus 151, or a combination. It does show that ordinary
  Playwright or bare CDP on a fresh Linux Chrome/Chromium profile is not enough.

## Architecture consequence

The OCI Kubernetes collector remains a reasonable runtime for providers that
accept normal HTTP clients or Linux browser automation. Vpass is not ready to
move there. Do not schedule the current PoC: it would repeatedly send rejected
login requests.

The next bounded Vpass experiment should compare a persistent, collector-owned
profile (created from ID/password, not copied from a personal browser) and a
Windows-consistent browser surface. If that still fails, Vpass needs a real
Windows browser runner or stays on the dedicated Windows/Kuebiko path. Route
through the home Tunnel only after a browser configuration works, because the
current evidence does not support IP-only routing as the remedy.

## References

- [Playwright browser installation and Chrome channels](https://playwright.dev/docs/browsers)
- [Playwright system requirements](https://playwright.dev/docs/intro)
- [Google Chrome for Linux](https://support.google.com/chrome/answer/95346?hl=en-GB)
