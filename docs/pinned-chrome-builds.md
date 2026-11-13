# Pinned Google Chrome Stable builds

[ADR 0112](adr/0112-pinned-chrome-collector-builds.md) owns the decision. Both
SBI Shinsei and GLOBAL PASS consume the same reviewed official Stable `.deb` over
their existing digest-pinned Playwright Noble image. The installer and manifest
live in `tasks/_lib/pinned-chrome/`; `sync.mjs` copies them into each service's
`container/` directory so Cloudflare keeps the existing local build context.
`package-audit.json` records the exact inspected control-script/wrapper hashes,
entry counts, dependency declarations and deliberate sandbox-mode normalization;
the signed public metadata is retained under `fixtures/provenance/`.

## Updating the payload

1. Start a normal reviewed dependency PR. Read the current official
   [Google key documentation](https://www.google.com/linuxrepositories/), package
   repository and browser release notes. A new signing primary key needs a separate
   explicit trust review. Do not learn the trust anchor solely from the downloaded
   key. Keep Stable; switching browser distribution is a separate decision.
2. Download the public key, `Release`, `Release.gpg` and `main/binary-amd64/Packages`
   from `https://dl.google.com/linux/chrome/deb/dists/stable/` into an isolated
   temporary directory. Convert the key there with `gpg --dearmor`; run `gpgv`
   against the detached signature with that isolated keyring. Require a valid
   signature under the reviewed primary fingerprint, not just any key in the file.
   Never import it into a personal/system keyring for this task.
3. Check Release's SHA-256 and size for the exact Packages bytes. Select only the
   `google-chrome-stable` amd64 stanza; validate its version, filename, size and
   SHA-256. Record Release date and signing fingerprint, and retain those exact
   signed public provenance files beside the manifest. A mutable index selects a
   version only during this reviewed update, never during ordinary image builds.
4. Download that versioned official `.deb`, reject redirects/oversized/partial
   responses, and verify its exact length/hash before inspection. Inspect control
   fields, all maintainer scripts, data entry paths/links/modes, dependencies and
   helper binaries without running scripts. Reassess omitted device-trust,
   AppArmor, alternatives, desktop and update configuration; new package contents
   must fail existing archive assumptions until explicitly reviewed. Preserve the
   complete runtime and original wrapper, without enabling a sandbox helper.
5. Update the manifest and the literal `pinnedVersion` and `downloadUrl` in the canonical
   installer together. The download sink consumes that fixed official URL, never
   file-derived URL data; a changed manifest alone fails closed. Run
   `mise exec -- node tasks/_lib/pinned-chrome/sync.mjs --write`.
   Run the root guards and both owning service checks. Build both exact local
   contexts without APT fallback, then run the offline image test below and inspect
   the exact base's dependencies, files/modes and skipped-hook conditions. Test both
   raw-channel and wrapper paths; no provider navigation/login is required.
6. Include payload provenance, image identities, all check results and limitations
   in the PR. Obtain a fresh implementation review and required final-head CI and
   CodeQL. A passing synthetic image test is not provider or deployment acceptance.

Google can retire versioned package URLs. A 404 or integrity failure is a failed
build, never permission to use `_current`, another mirror, Chromium or Chrome for
Testing. An immutable mirror/base-image proposal needs separate resource and
retention ownership. Browser security updates require ongoing reviewed version
bumps; this pin does not make an old browser indefinitely suitable.

## Offline image test

Build each service's Dockerfile with its service-local context. Feed
`tasks/_lib/pinned-chrome/image-smoke.mjs` on stdin to:

```sh
docker run --rm --network none -i --entrypoint node IMAGE --input-type=module < tasks/_lib/pinned-chrome/image-smoke.mjs
```

Do not call `/collect` or `/probe` for this test: their normal behavior navigates
to providers. The script imports `/app/browser-launch.mjs`, starts the same Xvfb
configuration and browser launch paths, and appends only a loopback synthetic URL.
The proxy admits only an exact synthetic HTTP GET root and the exact TLS tunnel;
its upstream destination and request method/path are constructed locally. Incoming
URLs, headers, credentials and request bodies are never forwarded to the HTTP
upstream. No host mount, privilege, extra capability or certificate-error bypass is needed.
It generates its own short-lived self-signed localhost certificate and requires
the browser to reject it. It checks the base certificate bundle, but no successful
public-CA connection is established under network isolation.

All three launch paths retain `--no-sandbox`. The extracted `chrome-sandbox` has
0755 instead of the package's 04755; no setuid helper is enabled. The package
wrapper remains distinct from the raw executable used by Playwright's channel.
The local image checks do not change production configuration or activate a
collector.

`xdg-utils` is intentionally not installed, although the official desktop package
declares it. The unchanged wrapper's shell commands are available; supported
collection uses browser navigation/HTTP byte capture and no OS desktop URL/MIME,
icon, default-browser or PDF-viewer integration. The smoke checks the actual
`--no-default-browser-check` argument on the channel and both wrapper paths. This
is an automation runtime, not a complete desktop package installation; any new
external-protocol or desktop feature must reassess that missing dependency.
