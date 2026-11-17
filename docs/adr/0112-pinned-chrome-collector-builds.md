# ADR 0112: Pin the branded Stable Chrome payload in collector images

- Status: proposed
- Date: 2026-11-12
- Tracking: [issue 1326](https://github.com/risu729/kogane/issues/1326)

## Context

SBI Shinsei and GLOBAL PASS pin their Playwright Noble base image, then run
`playwright install chrome`. The [same-version installer](https://raw.githubusercontent.com/microsoft/playwright/v1.65.0/packages/playwright-core/bin/reinstall_chrome_stable_linux.sh)
updates Ubuntu APT indexes and downloads Google's mutable current Stable package.
Repeated CI failures at that step were missing Ubuntu indexes after mirror DNS
failures or timeouts, followed by unavailable `xdg-utils`. Retrying unrelated PRs
does not correct this dependency or make the installed browser reproducible.

The collectors' observed runtime uses branded Google Chrome Stable. GLOBAL PASS
normally launches its raw Chrome executable through Playwright's Chrome channel,
headed with a fresh persistent profile. SBI Shinsei launches the package wrapper,
headed, then attaches over CDP; the retained GLOBAL PASS direct-process probe has
another wrapper/CDP configuration. Their provider URLs, flags, proxy conditions,
session logic and delayed attachment behavior must stay unchanged.

## Options considered

1. Change mirrors or retry APT. Retains mutable browser bytes and the unnecessary
   runtime build dependency; rejected.
2. Replace Stable with bundled Chromium or Chrome for Testing. Changes a browser
   choice supported by source-specific observations; rejected for this repair.
3. Verify and extract a versioned official Stable package over the existing base,
   retain its complete runtime and wrapper, and validate the omitted installation
   behavior explicitly. Chosen.
4. Publish another shared base image. Adds artifact ownership, storage and release
   machinery; deferred unless Google's versioned artifact availability requires it.

## Decision

`tasks/_lib/pinned-chrome/manifest.json` pins Google Chrome Stable
`157.0.8103.78-1`, amd64, its exact official HTTPS URL, length and SHA-256. The
committed public provenance snapshot carries Google's key, signed Release and
Packages index. The signature was verified under Google's [documented primary
fingerprint](https://www.google.com/linuxrepositories/), and the Release's index
hash/length and the downloaded package's hash/length matched. The package was
inspected without executing its control scripts. This does not establish which
mutable Stable version an earlier deployment installed.

The Node installer rejects other URL shapes, redirects, non-200/partial responses,
unexpected encodings, oversized/truncated bodies and integrity mismatches. It checks
the package/version/architecture through `dpkg-deb --field`. It reads only the data
tar stream, validates bounded ordinary ustar headers, owners, types, paths, modes
and links, and writes the entire `/opt/google/chrome` subtree into a new private
staging directory. It never executes package scripts, extracts system package
configuration or follows archive links. The reviewed wrapper gets explicit
`/usr/bin/google-chrome` and `google-chrome-stable` links; the Chrome channel still
resolves `/opt/google/chrome/chrome`.

The archive's only privileged mode is `chrome-sandbox` 04755. Extraction deliberately
normalizes it to 0755. Existing launch paths already use `--no-sandbox`; no new
capability, privileged mode, AppArmor relaxation or browser flag is added. Other
runtime file modes are retained. No extended attributes/capabilities are restored;
PAX/special entries and unexpected privilege bits fail closed.

Both service-local build contexts contain generated regular-file copies of the
canonical installer and manifest. `sync.mjs --write` regenerates them; the root test
checks byte equality. All consumed files remain covered by `containerInputDigest`;
the context is not widened and its COPY guard is unchanged.

The launch helpers shared with the offline image test do not navigate. Production
callers still append their existing constant provider URL. No request parameter,
environment URL override or new collector endpoint is added. The image test imports
only those helpers, under Docker's `--network none`, and serves synthetic loopback
pages and a rejecting loopback proxy. It separately tests GLOBAL PASS's headed
persistent Chrome channel and both wrapper/CDP configurations, without running a
collector or contacting a provider.

## Consequences

The browser-install layer no longer contacts an Ubuntu mirror or executes APT.
Google's pinned package URL must remain available; a missing artifact fails the
build. There is no current/Chromium/testing-browser fallback. A browser security
update is an explicit reviewed manifest/provenance change with both image checks,
as described in [the maintenance procedure](../pinned-chrome-builds.md).

Raw extraction is not a general replacement for package installation. The exact
package's post-install script includes icons/MIME defaults, alternatives, APT keys
and repository setup, conditional device-trust group/key/service setup, and
conditional AppArmor profile installation. These are intentionally not executed.
The services request no enterprise enrollment and use fresh collector profiles
with the already selected no-sandbox policy. Image verification must additionally
confirm no device-trust defaults or enrollment policy is present. The package cron
payload remains in the complete Chrome subtree but no `/etc/cron.daily` link is
installed; updates are reviewed image rebuilds. This omission must be rechecked on
every package update rather than summarized as desktop-only work.

The wrapper itself is retained unchanged: it sets `CHROME_WRAPPER`, Stable channel
environment, creates a per-user MIME preferences file, and executes its sibling
Chrome binary. Its commands and the image's fonts/certificates/shared libraries need
actual image verification. An `ldd` pass or a version string alone is insufficient.

The exact package also carries optional Qt5/Qt6 toolkit shims. Qt is absent from
its dependency declaration, whereas GTK3 or GTK4 is required. The [version-matched
Linux UI factory](https://raw.githubusercontent.com/chromium/chromium/157.0.8103.78/ui/linux/linux_ui_factory.cc)
chooses GTK first in the image's default desktop environment; [Qt initialization](https://raw.githubusercontent.com/chromium/chromium/157.0.8103.78/ui/qt/qt_ui.cc)
dynamically loads either shim and can fail back to another toolkit. The image audit
still inspects both shims and requires their exact known Qt-library deficit sets;
any other unresolved library fails. Each actual headed path must additionally show
GTK mapped in the running browser and no Qt modules. No toolkit flag/environment
is forced to satisfy the test, and both complete shims remain in the image.

The base does **not** supply every declared package dependency: `xdg-utils` is
intentionally absent, and raw Chrome is not registered in dpkg's installed package
database. Its package hooks use XDG icon/MIME/desktop integration; the retained
wrapper uses only bash, readlink, dirname, mkdir, touch and cat, all present in the
image. The supported collectors navigate HTTPS pages and fetch/return provider
bytes inside the browser; they do not open desktop URL handlers, install icons,
select a default browser or launch a system PDF viewer. All three actual browser
argument lists retain `--no-default-browser-check` (including Playwright's existing
channel defaults, checked from the running process). These source and synthetic
runtime checks justify this automation-specific omission, not equivalence to a
complete desktop package installation. Desktop integration, external-protocol
handlers and provider acceptance remain unverified and are not offered by this
container contract. Future changes needing them must revisit the omission.

## Verification

The root tests cover fail-closed download/archive/control handling, generated-copy
equality and unchanged launch configurations. The offline image test checks all
bundled ELF dependencies, font selection, a rendered Japanese/Latin page and canvas,
screenshots, rejection of a self-signed HTTPS certificate, expected browser version,
Xvfb readiness, process exit and temporary-profile cleanup. Its network isolation
does not prove public-CA/provider compatibility or production collection acceptance.

Exact-image results and complete workspace/hosted checks are recorded in the PR.
No merge, deployment, provider login or hosted Container experiment is part of
this implementation's local verification.

## Amendment: explicit outbound destinations (2026-11-12 05:54 UTC)

The installer compares the manifest against a literal reviewed package version
and official download URL, then supplies only that URL constant to the download
sink. Updating a payload requires reviewing both constants and the manifest.
File-derived URL data never selects the outgoing request destination.

The offline image proxy admits only the exact synthetic HTTP GET root and exact
locally allocated TLS tunnel. Its HTTP sink uses literal loopback host, path and
method plus the locally allocated port. It never forwards an incoming URL,
headers, credentials or body. Adversarial loopback tests cover rejected origins,
credentials, paths, methods and tunnel authorities without invoking a collector.
The smoke entrypoint remains usable on stdin and can be imported without starting
an image test, so the tests exercise the same proxy implementation.
