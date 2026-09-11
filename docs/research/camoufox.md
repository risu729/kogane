# Camoufox container fingerprint probe (retired)

|                                   |                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                            | **Retired.** The executable probe was removed from `main` by the U04 repository reorganisation.                                                                                                                |
| Ran                               | 2026-08-26, bounded controls only                                                                                                                                                                              |
| Lived at                          | `poc/camoufox-container-probe`                                                                                                                                                                                 |
| Last commit that changed the code | `5fb143e0f77a492ae9cfdbe0266fe77774b8bd30` (`Host synthetic observation demo behind WARP Access (#104)`, 2026-09-07)                                                                                           |
| Live resources                    | None. No Worker, Container application, registry image, bucket or cron ever existed for it, and the local Docker image was deleted ([`vpass-probe-cleanup-2026-08-26.md`](vpass-probe-cleanup-2026-08-26.md)). |

## Purpose

Vpass rejected fresh automated logins, and the open question was whether the
rejection was about the _fingerprint_ or about something else: profile
reputation, interaction history, egress, or temporary server-side scoring.
Camoufox runs Firefox inside a Linux container while generating a coherent
Windows or macOS fingerprint at the browser-engine layer, so it tests a
materially stronger condition than a user-agent override — navigator, memory,
languages and WebGL all agree with the claimed platform. It was a candidate
runtime for Cloudflare Containers, never a claim that Vpass authentication
would pass.

The probe performed read-only GETs and printed sanitized runtime metadata. An
optional `--auth` mode read two lines from non-echoed standard input, made one
bounded attempt, emitted status and classification metadata only, and stopped.
No credential, cookie value, response body, profile, HAR or screenshot was
stored.

## What was learned

Two arms, the same Linux Docker image, AU/SYD WARP egress, 2026-08-26:

| Target fingerprint | Sanitized runtime                                                                                 | Login page | Password bootstrap                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| Windows            | Firefox 152, `Win32`, Japanese languages, Microsoft/Intel Direct3D-style WebGL, `webdriver=false` | HTTP 200   | Login POST returned HTTP 403 / Access Denied                            |
| macOS              | Firefox 152, `MacIntel`, Japanese languages, Apple M1-style WebGL, `webdriver=false`              | HTTP 200   | No expected login POST observed; stayed on the login page, inconclusive |

The completed Windows trial is the result that matters: an engine-level
coherent OS fingerprint was **not sufficient** on its own to establish a fresh
Vpass session. It did not isolate browser product, profile reputation, cookie
history, interaction flow or temporary server-side scoring — a coherent Firefox
is still not Chrome, so the arm cannot separate "incoherent fingerprint" from
"wrong browser product" either.

## Why it stopped

The probe's own conclusion was to stop credentialed Camoufox trials until
visible Windows Chrome produced a repeatable control under fixed conditions.
That control was never established for Vpass, and the question was then
overtaken: the deployed Vpass collector reproduces the Android JSON protocol
and uses **no browser at all**. A browser-fingerprint workaround for Vpass has
no consumer left, so the image and the probe were retired rather than carried
on `main` as code nobody runs.

The engine-level fingerprint question is not closed for every source — PRESTIA
GLOBAL PASS still needs a real browser — but it is pursued there with Container
Chrome in the GLOBAL PASS collector, not with Firefox, and its findings are
recorded with that collector.

## How to reproduce

The probe was `probe.py` plus a `Dockerfile` (about 210 lines together). Read
it back out of the commit above, into a scratch checkout:

```sh
git show 5fb143e0f77a492ae9cfdbe0266fe77774b8bd30:poc/camoufox-container-probe/README.md
git restore --source 5fb143e0f77a492ae9cfdbe0266fe77774b8bd30 --worktree -- poc/camoufox-container-probe
docker build -t kogane-camoufox-probe poc/camoufox-container-probe
docker run --rm -e TARGET_OS=windows kogane-camoufox-probe
```

`RESULTS.md` at that commit holds the full bounded controls and `README.md` the
exact safety boundaries. Do not restore it onto `main`: a credentialed arm must
not be resumed before the visible-Chrome control exists, and reviving the line
of work means creating an `experiments/` entry with an owner, an expiry and a
stop condition.
