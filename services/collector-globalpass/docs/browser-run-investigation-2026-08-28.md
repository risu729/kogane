# GLOBAL PASS Cloudflare Browser Run investigation

<a id="目的"></a>

## Purpose

Cloudflare Container Chromium could not generate GLOBAL PASS Turnstile tokens. This investigation opens the same login screen through a full Cloudflare Browser Run (formerly Browser Rendering) Puppeteer session for bounded testing of token generation and login.

This is separate from the SMBC-card Vpass Browser Run probe on 2026-08-25. That probe received 403 for the Akamai login POST at `www.smbc-card.com`; this one targets Cloudflare Turnstile at `www.debit.vpass.ne.jp`.

<a id="公式仕様から分かる制約"></a>

## Constraints from official specifications

- Browser Run Puppeteer/CDP sessions use Cloudflare egress, without connecting to TAMIA Tunnel.
- Network User-Agent can change, but changing UA does not bypass bot protection.
- Puppeteer/CDP requests carry non-removable identifiers such as `cf-brapi-devtools`, `cf-biso-devtools` and Web Bot Auth signatures.
- Always close the browser in `finally`, without leaving billable usage running.

References:

- [Puppeteer on Browser Run](https://developers.cloudflare.com/browser-run/puppeteer/)
- [Automatic request headers](https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/)
- [Browser Run limits and session cleanup](https://developers.cloudflare.com/browser-run/limits/)

<a id="実装"></a>

## Implementation

The following were added to existing Worker `kogane-globalpass-collector-poc`.

- Browser Run binding `BROWSER`.
- Admin-token-required `POST /browser-probe`.
- Windows Chrome 153-equivalent network User-Agent/Client Hints, `ja-JP` Accept-Language and 1365x768 viewport.
- Network diagnostics returning only hostname, normalized path, method, resource type and HTTP status.
- A gate entering ID/password and clicking login only 1 time when the Turnstile token exceeds 20 characters.

Credentials, cookie values, request/response bodies and dynamic Turnstile identifiers are not returned. Challenge paths normalize to `<redacted>`.

## Bounded live result

Executed 3 times on 2026-08-28 AEST. Separate runs added diagnostics, but no run generated a Turnstile token, so credential entry and login POST to GLOBAL PASS occurred 0 times.

| Item                                 | Observation                                     |
| ------------------------------------ | ----------------------------------------------- |
| GLOBAL PASS login page               | HTTP 200                                        |
| title / form                         | `ログイン` ("login") / form present             |
| Access Denied                        | false                                           |
| cookies                              | Only names `JSESSIONID`, `TS01dfe944` confirmed |
| page JavaScript UA                   | `Cloudflare-Workers`                            |
| platform / webdriver / language      | `Linux x86_64` / `true` / `en-US`               |
| Turnstile API                        | 302 to build 200                                |
| challenge document                   | 200                                             |
| challenge XHR POST                   | 2, both 200                                     |
| challenge image                      | 200                                             |
| cross-origin challenge frame         | Present                                         |
| `cf-turnstile-response` after 30s    | 0 characters                                    |
| `brunhild.challenges.cloudflare.com` | No requests                                     |
| HTTP 4xx/5xx / request failure       | None                                            |
| credential POST                      | None                                            |

<a id="通常chromekuebikoとの比較"></a>

## Comparison with ordinary Chrome/Kuebiko

On 2026-08-28 AEST, the same GLOBAL PASS login URL was opened with a Kuebiko profile freshly launched from Start-menu `kogane capture`. Capture run `2026-08-27T21-46-51` (UTC) used Kuebiko 1.3.0 to save netlog, response metadata, bodies and storage locally. Raw captures may contain cookies or similar data and stay out of Git; only sanitized observations below remain. No credentials were entered and no login POST was sent.

| Item                                 | Cloudflare Browser Run              | Ordinary Chrome/Kuebiko                                      |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------ |
| login page                           | HTTP 200 / `ログイン`               | HTTP 200 / `Sign On`                                         |
| form / Access Denied                 | Form present / false                | 1 form / false                                               |
| page JavaScript UA                   | `Cloudflare-Workers`                | Windows Chrome 153                                           |
| platform                             | `Linux x86_64`                      | `Win32`                                                      |
| `navigator.webdriver`                | `true`                              | `false`                                                      |
| language                             | `en-US`                             | `en-US` (languages also includes `ja`)                       |
| Turnstile API                        | 302 to build 200                    | 302 to build 200                                             |
| challenge document                   | 200                                 | 200                                                          |
| `cf-turnstile-response`              | Still 0 characters after 30 seconds | 773 characters within about 15 seconds                       |
| challenge frame                      | Still present after 30 seconds      | No iframe when token observed                                |
| `brunhild.challenges.cloudflare.com` | No requests                         | No requests in structured CDP/Kuebiko metadata               |
| HTTP 4xx/5xx / request failure       | None                                | No 4xx/5xx; 1 unused CSS `ERR_ABORTED`, no challenge failure |
| credential/login POST                | None                                | None                                                         |

Kuebiko uses Chrome Beta with a remote-debugging port, without `--enable-automation`; the page saw `navigator.webdriver=false`. Thus CDP attachment/traffic capture itself does not prevent Turnstile token generation. In contrast, setting Browser Run's network-header UA to Windows Chrome 153 does not make its page-JavaScript fingerprint or Cloudflare-added non-removable headers/Web Bot Auth signatures ordinary Chrome.

This strengthens the hypothesis of Browser Run-specific browser identity causing failure, but IP/egress is not fully isolated. Client-visible `150.48.6.170` is the GLOBAL PASS destination IP, not Kuebiko's source IP. Kuebiko may be affected by local WARP/hostname routes, whereas Browser Run uses fixed Cloudflare egress; this 1 comparison alone cannot establish browser fingerprint as the sole cause.

<a id="container-browserの段階的ab"></a>

## Incremental Container browser A/B

The same day, every run fixed GLOBAL PASS traffic through the same TAMIA Tunnel, changing browser conditions 1 step at a time. The 2 Turnstile hosts used ordinary Container internet egress. Each run opened login 1 time and waited at most 30 seconds for a token, without credential entry, login POST, cookie reuse or R2 writes.

| variant                                   | Added condition                                               | Main page observations                                                     | token        |
| ----------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| `baseline`                                | None                                                          | Linux / HeadlessChrome 151 / `webdriver=true` / `ja-JP`                    | 0 characters |
| `webdriver-false`                         | Disable AutomationControlled                                  | Linux / HeadlessChrome 151 / `webdriver=false` / `ja-JP`                   | 0 characters |
| `windows`                                 | Windows Chrome 153 UA/Client Hints/platform/languages         | Win32 / Chrome 153-equivalent / `webdriver=false` / `en-US`                | 0 characters |
| `headed-windows`                          | Headed Chromium on Xvfb                                       | Windows information above, headed                                          | 0 characters |
| `headed-persistent-windows`               | Fresh-profile persistent context                              | Windows information above, headed, persistent                              | 0 characters |
| `chrome-stable-headed-persistent-windows` | Change only executable binary to branded Google Chrome Stable | Google Chrome 152.0.7977.64, Windows information above, headed, persistent | 0 characters |

Every run returned login-page HTTP 200 with a form and no `Access Denied`. Turnstile API redirected with 302 to build 200; challenge documents returned 200, both of 2 XHR POSTs returned 200, and images returned 200. However, all observed challenge-fetch 401 and `net::ERR_ABORTED` immediately after `brunhild.challenges.cloudflare.com` 204; no token completed. The first 5 runs used Chromium `151.0.7922.34`, and run 6 used branded Google Chrome `152.0.7977.64`. Windows variants only presented Chrome 153 through JS/Client Hints.

Changing only `navigator.webdriver`, superficial Windows UA/platform/language, headless mode, fresh persistent context or Playwright-bundled Chromium was insufficient. Branded Chrome still had challenge-fetch 401 and `ERR_ABORTED` immediately after Brunhild 204. Persistent contexts were not profiles with saved trusted history, so a requirement for past successful usage remained unverified. Linux Chrome 152 also returned Windows Chrome 153 values, leaving inconsistencies with TLS, GPU, fonts, codecs and OS-specific APIs.

The next useful comparison directly checks source IPs of successful Kuebiko and failed Container runs to separate network identity, rather than adding JS-property patches. Then compare native Linux Chrome without Windows spoofing, Client Hints matched to Chrome 152 and profiles with saved history, in that order. Container instance `v10` was later destroyed; Google Chrome verification instance `v11` was stopped afterward.

<a id="2026-08-29-公式仕様による訂正"></a>

## 2026-08-29 corrections from official specifications

This section supersedes the cause inferences above as of 2026-08-28. Rechecking Cloudflare primary sources corrected earlier diagnostics as follows.

- Private Access Token request 401 is ordinary fallback when a device cannot present PAT; it alone does not mean challenge failure.
- Some request failures under challenges.cloudflare.com can occur as internal challenge control. ERR_ABORTED immediately after Brunhild 204 alone cannot be the root cause.
- Changing IP between challenge retrieval and solve submission may invalidate the solve. The former PoC split GLOBAL PASS through TAMIA and Turnstile through direct Container egress; unifying egress should have come first.
- Cloudflare does not officially support solving production challenges through automated browsers such as Playwright, Selenium or Puppeteer. The following probes are bounded diagnostics to isolate causes, not a guarantee of adoption.

References:

- [Challenge solve issues](https://developers.cloudflare.com/cloudflare-challenges/troubleshooting/challenge-solve-issues/)
- [How Challenges work](https://developers.cloudflare.com/cloudflare-challenges/concepts/how-challenges-work/)
- [Supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)
- [Turnstile client-side error codes](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/)

The diagnostic-path sanitizer also changed to classify only PAT as cdn-cgi/challenge-platform/redacted/pat/redacted without leaking dynamic paths. Console bodies are not stored; only Turnstile 6-digit error codes and broad classifications return. No explicit 6-digit error code appeared in these runs.

<a id="2026-08-29-追加ab"></a>

## 2026-08-29 additional A/B

The parent page/Turnstile on the same TAMIA egress, all-direct Container traffic and the former split path were compared. All used Google Chrome Stable 152.0.7977.64, headed mode and fresh persistent profiles. Each run waited at most 30 seconds for a token; credential entry, login POST, cookie reuse and R2 writes occurred 0 times.

| variant                                          | Browser-side difference                            | egress                         | token |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------ | ----- |
| chrome-stable-no-ua-all-tamia                    | Native Linux, webdriver=false                      | All traffic TAMIA              | 0     |
| chrome-stable-no-ua-all-tamia-default-automation | Playwright default, webdriver=true                 | All traffic TAMIA              | 0     |
| patchright-chrome-native-all-tamia               | Patchright 1.62.2                                  | All traffic TAMIA              | 0     |
| chrome-direct-process-attach-late-all-tamia      | Ordinary Chrome process, CDP only after 25 seconds | All traffic TAMIA              | 0     |
| chrome-stable-windows-matched-all-tamia          | Match Windows/Chrome 152 UA/Client Hints/platform  | All traffic TAMIA              | 0     |
| chrome-stable-no-ua-direct                       | Native Linux, webdriver=false                      | All traffic direct Container   | 0     |
| patchright-chrome-native-direct                  | Patchright 1.62.2                                  | All traffic direct Container   | 0     |
| chrome-direct-process-attach-late-direct         | Ordinary Chrome process, CDP only after 25 seconds | All traffic direct Container   | 0     |
| chrome-stable-windows-matched-direct             | Match Windows/Chrome 152 UA/Client Hints/platform  | All traffic direct Container   | 0     |
| chrome-stable-no-ua-split                        | Native Linux, webdriver=false                      | Parent=TAMIA, Turnstile=direct | 0     |

All-TAMIA runs confirmed source 223.223.22.214, country JP, Cloudflare colo KIX, ASN 18144, HTTP/2. Direct Container runs used Cloudflare IPv6 egress, country SG, colo SIN, ASN 13335. In split runs, the parent-page check endpoint indicated TAMIA while Turnstile was direct; a run received challenge-image HTTP 400. This supports avoiding split egress, but a single egress still generated no token.

All-TAMIA had Brunhild ERR_CONNECTION_CLOSED; direct Container had ERR_ABORTED after 204. Both had token 0, and official material says the latter alone is not a failure signal. Every run had PAT-endpoint 401, also treated as normal fallback.

<a id="既存workaround実装の調査"></a>

### Investigation of existing workaround implementations

Separate subagents cross-checked Cloudflare primary sources and each implementation's public README.

1. Patchright describes Playwright API compatibility with fewer automation signals from Runtime.enable, Console.enable and default flags. A real trial using Google Chrome channel, headed mode, viewport null and no UA override yielded token 0. These are third-party implementation claims, not a Cloudflare guarantee of passage.
2. SeleniumBase Pure CDP Mode disconnects WebDriver and shifts toward Chrome CDP control. Its additional execution was deprioritized because the less intrusive approach, ordinary Chrome running 25 seconds before CDP attachment, already failed.
3. puppeteer-real-browser, rebrowser-patches, puppeteer-extra stealth, undetected-chromedriver and Camoufox were also examined. All are unsupported third-party detection-avoidance implementations; after both Patchright and ordinary Chrome processes failed, no evidence justified adding dependencies.
4. Profile reuse is technically possible, but available fresh profiles had only seen failed challenges and do not reproduce successful usage history. Moving personal Chrome profiles/cookies into Containers worsens secret/revocation management and is not adopted in this PoC.

References:

- [Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright-nodejs)
- [SeleniumBase Pure CDP Mode](https://github.com/seleniumbase/SeleniumBase/blob/master/examples/cdp_mode/ReadMe.md)
- [Playwright Google Chrome channel](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge)
- [Playwright browser launch arguments](https://playwright.dev/docs/api/class-browsertype)

## 2026-08-29 local Windows / WSL profile A/B

To separate the hypotheses that Windows profiles with successful usage history are required and that Linux Chrome cannot pass, 4 local Windows/WSL conditions were compared in the same time window. Each opened GLOBAL PASS login 1 time and used read-only CDP `Runtime.evaluate` to check **token length only**. No credential entry, login POST or token-value storage/output occurred. Every run was captured through Kuebiko; raw captures may contain cookies or similar data and stay out of Git.

Measurements used [`scripts/probe-local-turnstile.mjs`](../scripts/probe-local-turnstile.mjs), run on Node.js 22 or later as `node scripts/probe-local-turnstile.mjs <CDP port>`. It returns no token body, only length and non-secret page state.

| OS / Chrome               | profile                                                  | token | Page observations                                                 |
| ------------------------- | -------------------------------------------------------- | ----: | ----------------------------------------------------------------- |
| Windows / Chrome Beta 153 | Copy of existing Kuebiko profile within the same Windows |   794 | `Win32`, `webdriver=false`, form present, no Access Denied        |
| Windows / Chrome Beta 153 | Completely fresh profile                                 |   752 | Same as above                                                     |
| WSL / Google Chrome 152   | Windows Kuebiko profile copied to WSL ext4               |   773 | `Linux x86_64`, `webdriver=false`, form present, no Access Denied |
| WSL / Google Chrome 152   | Completely fresh profile                                 |   730 | Same as above                                                     |

Measured Cloudflare traces used IPv6 for Windows and IPv4 for WSL, both with WARP enabled, `loc=JP`, `colo=NRT`. This does not prove GLOBAL PASS observed the same values; it records only local-path control information.

The fresh Windows profile initially displayed `chrome://intro/`, so CDP `/json/new` opened the target URL in a new tab. The Kuebiko launch wrapper initially failed to wait for CDP on fresh WSL, but starting ordinary Chrome with the same profile exposed CDP and allowed later Kuebiko attachment. This wrapper failure therefore does not count as Turnstile rejection.

Copying a Windows profile to Linux still generated a token, so Windows-DPAPI-decryptable cookies were unnecessary at least through Turnstile display. Fresh WSL also succeeded, excluding profile copying/past successful usage as the explanation. Linux OS, fresh profiles and CDP attachment are each not sole blockers locally. Remaining differences from failed Cloudflare Containers include Container/browser-automation identity/integrity signals, runtime and network paths; Windows spoofing or personal-profile transfer no longer has evidence to enter production design first.

<a id="fresh-wsl-profileでの認証post"></a>

### Authentication POST from a fresh WSL profile

With the same fresh WSL profile, Google Chrome 152 and WARP JP/NRT, saved GLOBAL PASS credentials were entered only 1 time. Turnstile token length immediately before submission was 730. `POST /p/login/RW1312010101;jsessionid=<redacted>` returned HTTP 200; navigation produced title `TOP`, no login form and an activity-detail entrypoint. No Access Denied, Turnstile error or credential error was observed. This confirmed local WSL can automate not only token generation but server-side validation and authentication POST. This run did not navigate to detail screens or capture data.

Rerun script [`scripts/probe-local-login.mjs`](../scripts/probe-local-login.mjs) reads credentials from 1 JSON line on stdin without displaying values. Dynamic session IDs in results also become `<redacted>`. Raw Kuebiko captures may contain cookies or authentication-POST secrets and stay out of Git.

## 2026-08-30 OCI `bots` official Chrome control

To separate Cloudflare Container-specific runtime from ordinary OCI Chrome, official Google Chrome Stable 152.0.7977.64 ARM64, Xvfb, Noto CJK font and Node.js 24.20.0 were installed on existing SSH host `bots` (OCI ARM64), launching headed Chrome directly. No `--enable-automation`, headless mode or Playwright was used; pages saw `navigator.webdriver=false`, native `Linux x86_64`. CDP read only token length and non-secret page state.

Ordinary OCI internet egress was `138.2.53.208`, `loc=JP`, `colo=KIX`, HTTP/2, `warp=off`. All 4 conditions below showed Sign On, a login form and a 300x68 Turnstile widget without Access Denied, but token length remained 0 after at most 30 seconds.

| profile / graphics                                                                                       | Result                                                     |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Fresh persistent profile on OCI, default Xvfb graphics                                                   | Token 0; Chrome logs blocklisted WebGL 1/2                 |
| Linux-to-Linux copy of local WSL profile successful in token generation/authentication POST              | Login state did not transfer; returned to Sign On, token 0 |
| Another fresh OCI profile, explicitly enabled ANGLE SwiftShader WebGL                                    | Logs confirmed WebGL context creation, but token 0         |
| Another fresh OCI profile, SwiftShader, all browser traffic fixed to TAMIA through existing Worker relay | Token 0                                                    |

The last condition did not use Tailscale. `ssh bots` through Cloudflare Tunnel disallows `forward_tcpip`, so SSH reverse SOCKS was refused at connection. Instead, the existing PoC's host-allowlisted WebSocket/TCP relay was reused with a temporary OCI-localhost SOCKS5 adapter. A separate `/egress` request confirmed browser proxy egress `223.223.22.214`, JP/KIX, ASN 18144, HTTP/2. The adapter read the relay token from stdin into memory without file storage and stopped after the run. Scripts, dependencies, profiles and logs were retained.

This comparison rejects each sole-cause hypothesis: Containers alone, Playwright alone, Linux alone, insufficient profile history or WebGL disabled under Xvfb. Network/ASN, host runtime and Cloudflare-observed integrity signals remain inseparable between local WSL and OCI. However, profile transfer, software WebGL and changing ordinary OCI egress to TAMIA still generated no token; moving ordinary Chrome to OCI Kubernetes alone cannot establish the collector. Credential entry/login POST occurred 0 times across all 4 runs.

Use [`scripts/run-bots-globalpass.sh`](../scripts/run-bots-globalpass.sh) to rerun. By default it retains profiles/logs under `/opt/kogane-globalpass-probe`, stopping only Chrome/Xvfb processes on exit. The TAMIA-comparison localhost SOCKS adapter is [`scripts/run-bots-tamia-socks.mjs`](../scripts/run-bots-tamia-socks.mjs), receiving its relay token through stdin. Installations, profiles, dependencies and logs from this comparison were retained rather than removed.

## 2026-08-30 local WSL same-runtime network A/B

To separate network reputation from server runtime, only egress changed within the same time window, local WSL and Google Chrome Stable 152.0.7977.64, using completely fresh profiles and a 1365x768 window. Neither run used headless mode, Playwright or `--enable-automation`; pages saw native `Linux x86_64`, `navigator.webdriver=false`. CDP read only token length and non-secret page state.

| Local WSL Chrome egress                                                          | profile | token | Page state                                     |
| -------------------------------------------------------------------------------- | ------- | ----: | ---------------------------------------------- |
| Local WARP, `104.28.211.106`, JP/NRT                                             | fresh   |   752 | Sign On, form/widget present, no Access Denied |
| TAMIA through host-allowlisted Worker relay, `223.223.22.214`, JP/KIX, ASN 18144 | fresh   |   794 | Same as above                                  |

The TAMIA run used no Tailscale. [`scripts/run-bots-tamia-socks.mjs`](../scripts/run-bots-tamia-socks.mjs) ran on WSL localhost, sending only GLOBAL PASS and the 2 Turnstile hosts through the existing Worker relay. A separate allowlisted `/egress` request confirmed TAMIA IP/ASN before Chrome received `--proxy-server=socks5://127.0.0.1:11080`. Neither run stored/sent token values, credentials, login POSTs or cookie values. Chrome and temporary SOCKS processes stopped afterward; only profiles/Chrome logs remained locally.

TAMIA IP, ASN, KIX routing or IPv4 is therefore not a sufficient condition for missing token generation. Local WSL succeeded while Cloudflare Container and OCI `bots` failed on the same TAMIA egress, so network reputation alone cannot explain both server-environment failures. At least host/runtime or Cloudflare-observed browser/OS integrity signals must differ. Network interactions may remain, but the hypothesis that TAMIA always fails is rejected.

### Xvfb control

Keeping the same local WSL, Chrome 152, fresh profile and TAMIA egress, only display changed from WSLg to `Xvfb :98 -screen 0 1365x768x24 -nolisten tcp`. No headless mode, Playwright, `--enable-automation` or forced SwiftShader flag was used. Results: token 794, Sign On, form/widget present, no Access Denied, native `Linux x86_64`, `navigator.webdriver=false`. Credential entry/login POST occurred 0 times.

Chrome logs blocklisted WebGL 1/2, but a token was still generated. Xvfb, absence of a physical display and unavailable WebGL are each not sole blockers. OCI `bots` used the same Xvfb geometry and yielded token 0 with or without SwiftShader. The local-WSL/server difference narrows beyond display servers/WebGL to host/container runtime, browser-build execution environment and Cloudflare-observed integrity signals.

### WSL native / local Docker image A/B

Cloudflare Containers local development simulates local Docker Engine rather than remotely connecting to production Container bindings. This comparison therefore isolates deployed-image userland and the Docker boundary on a WSL host rather than reproducing production runtime identically.

To avoid rebuild drift, the unchanged current Cloudflare-deployed image digest `sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c` (local tag `kogane-globalpass-collector-poc-globalpasscollectorcontainer:cd80a6ee`) was used. Variant `chrome-direct-process-attach-late-all-tamia` directly spawns Google Chrome and delays CDP attachment for 25 seconds. Credential entry/login POST occurred 0 times in every run.

| Conditions on the same WSL host                  | token | Interpretation                                          |
| ------------------------------------------------ | ----: | ------------------------------------------------------- |
| Native Chrome, fresh profile, Xvfb, TAMIA        |   794 | current successful control                              |
| Add `--no-sandbox --disable-dev-shm-usage` above |   794 | Container flags are not sole blockers                   |
| Exact image, 0.25 CPU / 1 GiB                    |     0 | Cloudflare `basic` equivalent                           |
| Exact image, unrestricted resources              |     0 | CPU/memory starvation is not the sole blocker           |
| Exact image, UID/GID 1000                        |     0 | Root execution is not the sole blocker                  |
| Exact image, host network                        |     0 | Docker bridge network namespace is not the sole blocker |

Host/image Chrome were both Google Chrome Stable `152.0.7977.64-1`, with identical `/opt/google/chrome/chrome` SHA-256 `44bd90e776ea03a952242b3536d4a10a2e43c64a227c243af2840f07f1f0ed17`. Thus executable-byte differences, not only displayed version differences, are excluded. Both had `LANG` = `C.UTF-8`, native Linux pages, `navigator.webdriver=false`, Sign On/form present and no Access Denied.

The earlier local-Docker attempt on 2026-08-27 encountered WSL `Wsl/Service/E_UNEXPECTED` around reaching the old image's `/health`, never calling Turnstile `/probe`; it is not counted as a prior result of this A/B. This was the first completed token-gate test with the exact deployed image.

These results do not prove a Cloudflare-specific runtime cause. Instead, native success / Container failure was reproduced using local WSL alone. Next, compare small differences in image fonts/fontconfig, speech voices, locale data, D-Bus/audio and shared libraries outside the Chrome bundle. PID namespaces are lower priority because browser JavaScript cannot easily observe them directly. Changing Cloudflare instance type is not prioritized while the unrestricted local image also fails.

<a id="2026-08-30-browser-visible環境差分"></a>

## 2026-08-30 browser-visible environment differences

On the same WSL host, token-generating native Google Chrome and non-generating Chrome inside the exact deployed image were compared on a localhost diagnostic page without GLOBAL PASS access. Both used Chrome 152 and Xvfb `1365x768x24`. Raw font/canvas/audio values stay out of Git; only aggregate differences remain.

| Item                                       | WSL native                    | exact image                                             | Comparison |
| ------------------------------------------ | ----------------------------- | ------------------------------------------------------- | ---------- |
| timezone                                   | `Asia/Tokyo`                  | `UTC`                                                   | Different  |
| font files / families                      | 155 / 32                      | 50 / 20                                                 | Different  |
| font metrics                               | baseline                      | Differences for Latin 16/20, CJK/emoji 20/20 candidates | Different  |
| `enumerateDevices()`                       | audio input 1 / output 1      | All 0                                                   | Different  |
| UA / platform / languages                  | Linux Chrome 152 / `en-US,en` | Identical                                               | Match      |
| `navigator.webdriver`                      | `false`                       | `false`                                                 | Match      |
| CPU / memory / screen / DPR                | 16 / 16 GiB / 1365x768 / 1    | Identical                                               | Match      |
| speech voices / codec / plugins            | baseline                      | Identical                                               | Match      |
| standard canvas / OfflineAudioContext hash | private comparison            | Identical                                               | Match      |
| WebGL                                      | unavailable                   | unavailable                                             | Match      |

Read-only bind mounts of host font directories and `/etc/fonts`, followed by ephemeral-cache refresh, made Container family counts/default font matches equal the host. Yet token remained 0 under the same Chrome/TAMIA conditions. Font-family sets and fontconfig-default differences are not the sole root cause; this does not rule out rendering-library or metric differences generally.

## 2026-08-30 timezone controlled A/B

Without rebuilding current exact image `cd80a6ee`, digest `sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c`, only timezone changed while Chrome 152.0.7977.64, Xvfb, fresh profiles, CDP attachment after 25 seconds and all-TAMIA traffic stayed fixed. Credential entry/login POST occurred 0 times in every run.

| Timezone condition                       | Chrome Intl timezone | token | Result                         |
| ---------------------------------------- | -------------------- | ----: | ------------------------------ |
| image default                            | `UTC`                |     0 | Failed control                 |
| `TZ=Asia/Tokyo` + `/etc/localtime` mount | `Asia/Tokyo`         |   794 | Form present, no Access Denied |
| Only `TZ=Asia/Tokyo` environment         | `Asia/Tokyo`         |   794 | Same as above                  |

No `/etc/localtime` mount was needed: the Container environment variable alone changed length from 0 to 794 characters. In this controlled A/B with the same image, Chrome, display, profile type and TAMIA path, timezone mismatch was a necessary and sufficient failure factor. No reverse test with native Chrome `TZ=UTC` was performed; do not generalize to every environment, including different versions/sitekeys.

A production deployment setting Worker Container class `envVars = { TZ: "Asia/Tokyo" }` also generated token 794 through both `chrome-direct-process-attach-late-all-tamia` and collector-equivalent `chrome-stable-no-ua-all-tamia`. The latter used egress `223.223.22.214`, JP/KIX, ASN 18144, HTTP/2, Chrome 152.0.7977.64, a form and no Access Denied. PAT 401 and Brunhild `ERR_CONNECTION_CLOSED` remained, but the 2 stages of challenge POST returned 200 and generated a token, so these are not sole blockers.

<a id="timezone修正後のcontainer直通ab"></a>

### Direct Container A/B after timezone correction

Earlier direct failures were confounded by `UTC`, so only egress was re-compared in the same production runtime `timezone-collector-v5`. Chrome 152.0.7977.64, Xvfb headed mode, fresh persistent profiles, `TZ=Asia/Tokyo`, native Linux information and `navigator.webdriver=false` stayed fixed. Credential entry, login POST, cookie reuse and R2 writes occurred 0 times.

| egress            |                   Runs | login page                                    | Turnstile token | challenge image | Egress location                     |
| ----------------- | ---------------------: | --------------------------------------------- | --------------: | --------------- | ----------------------------------- |
| Direct Container  |                      2 | Both HTTP 200, form present, no Access Denied |           0 / 0 | Both HTTP 400   | SG/SIN, ASN 13335, Cloudflare IPv6  |
| All traffic TAMIA | 1 (concurrent control) | HTTP 200, form present, no Access Denied      |             794 | HTTP 200        | `223.223.22.214`, JP/KIX, ASN 18144 |

Changing only egress reproduced the result in this controlled A/B: current Container direct Cloudflare egress did not pass Turnstile. Chrome/timezone alone is insufficient; production keeps GLOBAL PASS, Turnstile and helper fixed to the same TAMIA egress. Splitting individual hosts to direct egress is also rejected because it changes egress between challenge retrieval and solve. Fixed diagnostic Container instance `v18` was destroyed after the 2 direct runs to avoid ongoing charges. Cron, R2 and production relay configuration were unchanged.

### NRT Cloudflare Gateway egress

Container placement constraints cannot specify a metro finer than `APAC`. A direct probe giving new Durable Object ID `locationHint: "apac-ne"` was placed in TPE; login returned HTTP 200 but token 0 and challenge-image HTTP 400. The diagnostic instance was destroyed.

To measure NRT, Worker `placement.region: "aws:ap-northeast-1"` and a `CF_EGRESS` binding with `network_id: "cf1:network"` were added separately from TAMIA Tunnel `MESH`. The diagnostic variant sends encrypted TCP from Container Chrome SOCKS through an authenticated WebSocket relay to `CF_EGRESS.connect()`, fixing GLOBAL PASS, Turnstile and helper to the same Cloudflare Gateway egress. The Worker does not terminate TLS, preserving Chrome's TLS handshake. Ordinary collection continues to use only `MESH`.

Both of 2 Gateway runs used JP/NRT, ASN 13335 Cloudflare IPv6 egress; login pages, forms and challenge images returned HTTP 200 without Access Denied, but tokens were 0 / 0. However, an immediately following TAMIA control with the same image/Chrome also had token 0, unlike earlier 794-character successes. Temporary evaluation/rate state from successive challenges over a short interval, or Turnstile time variation, confounds the result; NRT egress is not established as the cause. Treat successful NRT routing separately from Turnstile passage, without switching ordinary collection to NRT. The admin-token-required Gateway variant remains for future sufficiently spaced A/B tests.

## 2026-08-30 Camoufox control

Current [Camoufox](https://github.com/daijro/camoufox) configuration tried `cloverlabs-camoufox==0.6.0`, official prerelease Firefox `152.0.4-beta.29`, a real Windows fingerprint, `ja-JP` and no uBlock Origin. Fresh-install Playwright 1.62.0 produced a Juggler `Browser.setDefaultViewport` schema error, the version skew in [issue #653](https://github.com/daijro/camoufox/issues/653), so Playwright was pinned to 1.60.0.

Both WSL native and non-root Docker/Xvfb based on the current deployed image returned HTTP 200, login form/widget present, no Access Denied, `navigator.webdriver=false` and a 709-character token. Both used TAMIA egress; credential entry/login POST occurred 0 times. This independent control shows the Container boundary is not categorically refused. Ordinary Chrome also succeeded by changing only timezone, so Camoufox is not added as a production dependency and remains a 2nd candidate for future regression.

Temporary Camoufox venv/browser/profiles, Docker image `kogane-camoufox-probe-20260830:one-shot`, containers, temporary scripts and relay ports were removed/stopped, without registry push. Shared BuildKit cache was not pruned because other builds use it.

## 2026-08-30 production collection progression

The first real `daily` returned HTTP 502. Admin-authenticated `GET /latest-manifest?date=YYYY-MM-DD` was added to retrieve the R2 failure manifest without repeating the same login. The old collector used outdated conditions—headless bundled Chromium, ephemeral context and GLOBAL PASS-only TAMIA with separate Turnstile egress—rather than the probe's successful conditions.

The actual collector was aligned to headed Google Chrome Stable, fresh persistent profiles and all-TAMIA traffic. Fixed Container IDs can resume old instances/images even after app-image updates, so responses include a runtime revision and new Durable Object identities verify execution generations. `timezone-collector-v2` passed Turnstile and login POST, progressing to `GLOBAL PASS activity link was not found after login`. This was a selector mismatch searching only Japanese `ご利用明細` ("usage details") on an English post-login screen, rather than Akamai/Turnstile/IP rejection.

Reusing a saved successful Kuebiko capture and inspecting only DOM routes without emitting values showed the activity link POSTs to Nablarch `/p/statementInquiry/RW...`. `timezone-collector-v4` prioritizes that read-only path prefix. After app-image rollout, new Container identity `v18` confirmed runtime revision v4 and token 794 before E2E execution.

`daily` run `93e226f7-30e3-4c94-9270-5b71536539b6` returned HTTP 200, status `success`, 15 available months, 2 HTML artifacts for 2026-08/2026-07 and failure 0. Subsequent initial `backfill` run `f218329f-764e-4fe1-938e-abc5accfba1f` also returned HTTP 200, status `success`, saving 15 captures from 2025-06 through 2026-08 to R2 in about 65 seconds with failure 0. HTML sizes were 27,720–70,958 bytes, within the 2 MiB limit. Credentials, cookies, Turnstile token values and HTML bodies entered neither logs nor Git.

After bounded daily/backfill success, enable Workers Cron `17 18 * * *` (03:17 JST), 1 time per 1 day. No GitHub Actions schedule is used. Fixed identity `v18` serves normal operation; image updates allocate a new identity after the app's active digest changes.

<a id="結論"></a>

## Conclusion

Failures through 2026-08-29 could not be explained solely by TAMIA IP, missing IPv6, Xvfb, WebGL, Linux, Docker, root, CPU/memory, Chrome binary, Playwright/CDP or fresh profiles. Controlled A/B on 2026-08-30 identified `UTC` browser timezone in the exact image; only `TZ=Asia/Tokyo` changed ordinary Chrome Container token length from 0 to 794. Cloudflare production reproduced the result and also completed a real-account login POST.

GLOBAL PASS's first candidate is therefore Cloudflare Container + Google Chrome Stable + Xvfb + fresh persistent profile + source-specific TAMIA allowlist. Windows spoofing, personal-profile copies, Camoufox, Patchright and Browser Run are unnecessary on the current path. Camoufox also generated tokens inside Docker and remains only a control for future ordinary-Chrome regression.

PAT 401, Brunhild abort and missing TAMIA IPv6 may occur even in successful runs and are not sole blockers. Browser Run alone also failed to complete a token and is not adopted. Remaining work is ordinary collector implementation to confirm English/Japanese post-login DOM, month selectors, HTML sizes and R2 storage rather than bot avoidance. Workers Cron was enabled daily at 03:17 JST after end-to-end daily/backfill success.

<a id="2026-08-30-最終成功条件でのchromium-ab"></a>

## 2026-08-30 Chromium A/B under final successful conditions

Earlier Chromium comparisons retained confounders such as `UTC` and split egress. Runtime `timezone-collector-v5` therefore realigned everything except browser binary to final successful conditions: `TZ=Asia/Tokyo`, Xvfb headed mode, fresh persistent profiles, native Linux information, `navigator.webdriver=false` and all GLOBAL PASS/Turnstile/helper traffic through TAMIA.

| binary                       | Runs |            HTTP | Turnstile token      | browser version | elapsed                    |
| ---------------------------- | ---: | --------------: | -------------------- | --------------- | -------------------------- |
| Playwright-bundled Chromium  |    3 | 200 / 200 / 200 | 0 / 0 / 0 characters | 151.0.7922.34   | 38.8 / 40.6 / 41.6 seconds |
| Google Chrome Stable control |    1 |             200 | 794 characters       | 152.0.7977.64   | 32.0 seconds               |

All 4 runs were observed through the same TAMIA Japanese egress and Cloudflare KIX, with Brunhild requests. Each of the 3 Chromium runs used a fresh profile. No token was generated, so Chromium performed no credential entry, login POST, cookie reuse or R2 write. The successful concurrent Chrome control narrows the failure factor to browser binary/version rather than timezone, egress, headless mode or profiles. The 2 browsers, Chromium 151 and Chrome 152, still differ in version, so brand alone is not established; however, there is no evidence to switch to current Playwright-bundled Chromium. Production retains Chrome with end-to-end success.

Dedicated identity `prestia-globalpass-chromium-timezone-probe-v1` and `v18`, recreated for Chrome control, were destroyed after verification and confirmed inactive. `sleepAfter=30s` and successful `stop()` RPC alone left instances running after relay use, so normal post-collection cleanup also uses `destroy()`.

Daily run `251bbae4-007c-4d91-b7e5-9b4385656285` after deploying `destroy()` had runtime v5, status `success`, 2 HTML artifacts and failure 0. After R2 manifest storage, `globalpass-collection-container-destroyed` was recorded; Wrangler's immediately following instance list also showed `v18` as `inactive`. This confirmed ordinary collection success and actual scale-to-zero in the same run.
