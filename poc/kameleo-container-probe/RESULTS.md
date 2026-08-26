# Kameleo Chroma container probe results

Observed on 2026-08-26. No ID, password, cookie value, response body, profile,
HAR, screenshot, or public IP is stored here.

The official Kameleo 5.1 Linux Docker image started in accountless mode. Chroma
selected a recent real-device-derived Windows Chrome fingerprint and ran with
`disable-dev-shm-usage`, which is compatible with a runtime that cannot set
Docker's `--shm-size` option.

| Arm | Sanitized runtime | Login page | Password bootstrap |
| --- | --- | --- | --- |
| Ephemeral Windows Chrome | Chrome 152, `Win32`, Japanese languages, Intel Direct3D 11 WebGL, `webdriver=false` | HTTP 200 | Login POST returned HTTP 403 / Access Denied. |
| New persistent Windows Chrome, public SMBC warm-up, per-character keyboard and mouse movement | Same coherent platform family | HTTP 200 | The coordinate click did not reach the login control, so no login POST occurred. Inconclusive; no rejection or success is claimed. |

The first arm is materially different from a simple UA/CDP override and from
Camoufox: the browser product was Chromium-based Chroma and the Windows Chrome
surface was coherent across navigator, memory, CPU, screen, language and WebGL.
Its 403 shows that this fresh fingerprint alone was not sufficient. It does not
show that a persistent Chroma profile cannot pass after the Windows control is
made repeatable.

The persistent profile, official image, container and Docker volume are retained
for a later controlled comparison. Do not resume credentialed trials until the
same visible Windows Chrome setup succeeds repeatedly after restart with IP,
language, window state and manual interaction held fixed.
