# Kameleo Chroma container fingerprint probe (retired)

|                                   |                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                            | **Retired.** The executable probe was removed from `main` by the U04 repository reorganisation.                                                                                                                                  |
| Ran                               | 2026-08-26, bounded controls only                                                                                                                                                                                                |
| Lived at                          | `poc/kameleo-container-probe`                                                                                                                                                                                                    |
| Last commit that changed the code | `5fb143e0f77a492ae9cfdbe0266fe77774b8bd30` (`Host synthetic observation demo behind WARP Access (#104)`, 2026-09-07)                                                                                                             |
| Live resources                    | None. The probe ran against a locally started official image; the container, the Docker volume, the image and the controller virtualenv were deleted ([`vpass-probe-cleanup-2026-08-26.md`](vpass-probe-cleanup-2026-08-26.md)). |

## Purpose

This probe covered the one case the Camoufox probe could not (see
[`camoufox.md`](camoufox.md)): a **Chromium-based** browser with an
engine-level, coherent Windows Chrome fingerprint while the real runtime stays
a Linux container. Kameleo 5.1 starts accountless, Chroma selects a recent
real-device-derived Windows Chrome profile, and the probe pinned Japanese
language and `disable-dev-shm-usage` — the last on purpose, because Wrangler
exposes no Docker `--shm-size` setting, so any future Cloudflare Containers
attempt has to work without it.

A second arm tested profile _continuity_ rather than another randomized
fingerprint: one persistent profile, a warm-up visit to the public SMBC Card
site with ordinary scrolling and pointer movement, then per-character keyboard
input and real mouse movement instead of direct DOM value assignment.

Credentials were read as exactly two lines from standard input after a
`READY_FOR_CREDENTIALS` marker and never printed; no cookie value, response
body or public IP was recorded.

## What was learned

2026-08-26, official Kameleo 5.1 Linux image, accountless mode:

| Arm                                                                                           | Sanitized runtime                                                                   | Login page | Password bootstrap                                                                             |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------- |
| Ephemeral Windows Chrome                                                                      | Chrome 152, `Win32`, Japanese languages, Intel Direct3D 11 WebGL, `webdriver=false` | HTTP 200   | Login POST returned HTTP 403 / Access Denied                                                   |
| New persistent Windows Chrome, public SMBC warm-up, per-character keyboard and mouse movement | Same coherent platform family                                                       | HTTP 200   | The coordinate click did not reach the login control, so no login POST occurred — inconclusive |

The first arm is materially different both from a UA/CDP override and from
Camoufox: the browser product was Chromium-based and the Windows Chrome surface
was coherent across navigator, memory, CPU, screen, language and WebGL. Its 403
shows that a _fresh_ coherent Chrome fingerprint alone was not sufficient. It
does **not** show that a persistent Chroma profile cannot pass; the second arm
never produced a login POST, so profile continuity remains untested.

The useful residue for any later container browser work is the operational
detail, not the verdict: Chroma runs with `disable-dev-shm-usage`, which is the
constraint a Wrangler-managed container imposes, and the failure mode of
coordinate clicking in a headed container is a click that lands nowhere rather
than an error.

## Why it stopped

The probe's own stop condition was never met: it required the same visible
Windows Chrome setup to succeed repeatedly after restart with IP, language,
window state and manual interaction held fixed before any further credentialed
arm. Meanwhile the target became moot — the deployed Vpass collector reproduces
the Android JSON protocol and uses no browser at all — so the retained
container, volume and image were deleted and the code retired instead of being
kept on `main` unexecuted.

## How to reproduce

```sh
git show 5fb143e0f77a492ae9cfdbe0266fe77774b8bd30:poc/kameleo-container-probe/README.md
git restore --source 5fb143e0f77a492ae9cfdbe0266fe77774b8bd30 --worktree -- poc/kameleo-container-probe
```

`README.md` at that commit lists the exact `docker run` line for the official
`kameleo/kameleo-app:latest` image, the controller virtualenv setup, the
`KEEP_PROFILE=1 WARMUP=1` arm and the exact cleanup commands; `RESULTS.md`
holds the bounded controls. Restore it into a scratch checkout only. Resuming a
credentialed arm without the visible-Chrome control first is exactly what the
experiment concluded against, and reviving the line of work means creating an
`experiments/` entry with an owner, an expiry and a stop condition.
