# OCI and WSL browser comparison for Vpass (retired)

|                                   |                                                                                                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                            | **Retired.** The probe harness was removed from `main` by the U04 repository reorganisation; its conclusions live on in `docs/authenticated-collectors.md`. |
| Ran                               | 2026-08-25 and 2026-08-26                                                                                                                                   |
| Lived at                          | `poc/oci-browser-probe`                                                                                                                                     |
| Last commit that changed the code | `5fb143e0f77a492ae9cfdbe0266fe77774b8bd30` (`Host synthetic observation demo behind WARP Access (#104)`, 2026-09-07)                                        |
| Live resources                    | None, and no relay. See "Why it stopped" below.                                                                                                             |

## Purpose

Three browser paths on the ARM64 OCI host `bots`, compared against Windows and
WSL controls, to find out which runtime can bootstrap a Vpass session:
Playwright-launched Google Chrome (headless), headed Google Chrome under Xvfb
attached through CDP, and Playwright's bundled Chromium (headless). The probe
took credentials only as two lines on standard input, made one bounded attempt,
and deliberately excluded credential values, cookies, profiles, HAR files,
screenshots and page bodies from its output.

## What was learned

The conclusions are already carried by the product design document
[`../authenticated-collectors.md`](../authenticated-collectors.md), which is
where a collector author should look. The findings that originated here:

- **Headless launch is rejected before the page.** Playwright-launched Chrome
  and bundled Chromium (`HeadlessChrome`, `webdriver=true`) got HTTP 403 on the
  initial login-page GET. A full headed browser under Xvfb attached through CDP
  removes both signals: the login page then loads with HTTP 200 for both
  browsers — and the authentication POST is still rejected.
- **A Japanese source IP is not the missing requirement.** The successful
  Windows control and the failing WSL control shared one Cloudflare WARP/Gateway
  route and AU classification; OCI failed from JP `138.2.53.208`. Changing only
  the egress does not fix it, which is why routing through the home Tunnel is
  the _last_ thing to try, not the first.
- **Nor is profile continuity strictly required.** A completely fresh Windows
  profile succeeded once the initial browser surface changed (Japanese locale
  and language headers, a normal 1920x1080 outer window from the first page
  load, 1.0 device scale, OS-level input). The first Akamai pixel of the failed
  fresh captures reported a _minimized_ geometry — outer 160x28 at screen
  position -25600,-25600 — against 1920x1080 at 10,10 for the successful one.
- **Dwell time matters but is not a threshold.** Eight one-login controls:
  successes at 157.3 s, 203.8 s, 490.5 s and 210.7 s (minimized window),
  failures at 30.1 s, 94.5 s, 139.4 s and 171.1 s. A 157-second run succeeded
  while a later 171-second run failed, so **a collector must never treat a fixed
  sleep as an authorization guarantee**.
- **Sensor ingestion and authorization are separate decisions.** Every one of
  the 24 `sensor_data` posts was accepted with `201`, including bursts
  immediately before both rejected logins. Script build is not decisive either:
  identical helper and main-script hashes appear in both successful and rejected
  runs. What remains is a probabilistic session-level score.
- **The telemetry reads field identity, not field values.** Static expansion of
  the 26 KiB helper recovered navigator, screen, plugin, capability, canvas,
  storage, permission, automation-artifact, battery, timezone and timing probes.
  The 564 KiB Bot Manager build uses a control-flow VM and runtime string
  decryption and was not fully recovered; in an isolated run it registered
  capture-phase listeners for autofill/focus/blur/input/paste/keyboard, mouse and
  pointer, touch, and device motion/orientation, classified password inputs
  separately, and read input attributes. Dummy values of different lengths did
  not appear verbatim in the payload and did not change its length. Treat
  `sensor_data` as an opaque versioned format, never a stable API.
- **Operational rule that came out of it:** stop after the first login `403`.
  Repeating a rejected login in the same profile adds no control and may move
  server-side state.
- **Session transport works.** A valid Windows session imported into OCI ARM64
  Linux Chrome passed the authenticated My Page; an expired one returned to
  login, matching its source profile. Fresh Linux login, Akamai-cookie-only
  login and password re-login from a seeded persistent Linux profile were all
  rejected. That asymmetry — transport yes, bootstrap no — is the design input
  that survives this experiment.

## Why it stopped

The plan's row was `isolate-or-retire`, to be decided by whether a production
path still depends on the OCI relay. It does not:

1. **No OCI relay exists.** The only relay a collector uses is the pre-existing
   `tamia` Cloudflare Tunnel, which GLOBAL PASS binds by tunnel id
   `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33` and whose exit measured as JP/KIX
   ASN 18144, not OCI. No wrangler config, var or required secret in this
   repository names an OCI host.
2. **The probe cannot run.** Its whole installation on `bots` —
   `/opt/kogane-browser-probe`, `google-chrome-stable`, `xvfb`,
   `fonts-noto-cjk`, the Chrome apt source and the leftover profile directories
   — was purged on 2026-08-26 and verified absent. The host, its SSH
   configuration, network and future Kubernetes infrastructure were pre-existing
   and were not touched.
3. **Nothing references it.** No source file, wrangler config, test or asset
   outside the directory imported it; it was a hand-run `probe.mjs` with a
   shell wrapper.
4. **Its subject is gone.** The probe existed to find a Vpass bootstrap
   runtime. The deployed Vpass collector reproduces the Android JSON protocol
   and needs no browser at all.
5. **The one OCI line of work still open belongs elsewhere.** GLOBAL PASS keeps
   its own retained OCI installation (`/opt/kogane-globalpass-probe`, its own
   Chrome, Xvfb, Node and profiles) with its own scripts and its own records;
   that is a different install this retirement does not touch, and it is the
   harness a future OCI comparison for GLOBAL PASS would use.

## How to reproduce

The directory held four experiment records — `RESULTS.md` (the runtime matrix,
the fresh-profile dwell matrix, the traffic forensics and the deobfuscation
notes), `AUTH-SESSION-EXPERIMENTS-2026-08-26.md` (the session-transfer matrix
and the Cloudflare Container gate), `AKAMAI-COMPARISON-2026-08-25.md` and
`CLEANUP-2026-08-25.md` — plus `probe.mjs`, `run-cdp-probe.sh` and a pinned
Playwright:

```sh
git show 5fb143e0f77a492ae9cfdbe0266fe77774b8bd30:poc/oci-browser-probe/RESULTS.md
git restore --source 5fb143e0f77a492ae9cfdbe0266fe77774b8bd30 --worktree -- poc/oci-browser-probe
```

Re-running it means reinstalling Chrome, Xvfb and the CJK fonts on a host, which
is what `README.md` and `RESOURCE_INVENTORY.md` at that commit describe, cleanup
commands included. Do not restore it onto `main`, and do not spend a credentialed
trial on a fresh Linux password login: the experiment's own conclusion is that
another 403 there cannot be attributed to egress, browser implementation,
profile history or transient server-side state.
