# Camoufox container probe results

Observed on 2026-08-26. No ID, password, cookie value, response body, profile,
HAR, screenshot, or public IP is stored here.

| Target fingerprint | Sanitized runtime                                                                                 | Login page | Password bootstrap                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| Windows            | Firefox 152, `Win32`, Japanese languages, Microsoft/Intel Direct3D-style WebGL, `webdriver=false` | HTTP 200   | Login POST returned HTTP 403 / Access Denied.                                                 |
| macOS              | Firefox 152, `MacIntel`, Japanese languages, Apple M1-style WebGL, `webdriver=false`              | HTTP 200   | No expected login POST was observed; remained on the login page, so this arm is inconclusive. |

Both runs used the same Linux Docker image and AU/SYD WARP egress. This is an
engine-level coherent Firefox fingerprint rather than a user-agent override,
but it is not Chrome impersonation. The completed Windows trial shows that the
coherent OS-looking fingerprint alone was not sufficient to establish a fresh
Vpass session. It does not isolate browser product, profile reputation, cookie
history, interaction flow, or temporary server-side scoring.

Stop further credentialed Camoufox trials until visible Windows Chrome produces
a repeatable control under fixed conditions.
