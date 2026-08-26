# OCI browser probe

This PoC compares three browser paths on the ARM64 OCI host `bots` without
persisting Vpass credentials:

- Playwright-launched Google Chrome (headless)
- headed Google Chrome under Xvfb, attached through CDP
- Playwright's bundled Chromium (headless)

Credentials are accepted only as two lines on standard input when `--auth` is
present. They are never accepted through command-line arguments or written to a
file. Probe output deliberately excludes credential values, cookies, browser
profiles, HAR files, screenshots, and page bodies.

The host-local installation root is `/opt/kogane-browser-probe`. Copy
`probe.mjs` and `run-cdp-probe.sh` to its `app` directory and use the exact
Playwright version from `package.json`.

```sh
export PLAYWRIGHT_BROWSERS_PATH=/opt/kogane-browser-probe/ms-playwright
cd /opt/kogane-browser-probe/app
/opt/kogane-browser-probe/node/bin/node probe.mjs chrome-launch
/opt/kogane-browser-probe/node/bin/node probe.mjs chromium-launch
./run-cdp-probe.sh
```

Add `--auth` to one command and provide the ID and password on separate standard
input lines for a single authentication attempt. Stop after a 403, 429, or
post-submit timeout instead of retrying the same configuration.

See `RESULTS.md` for the live comparison,
`AUTH-SESSION-EXPERIMENTS-2026-08-26.md` for the authentication/session
portability matrix and current runtime boundary, and `RESOURCE_INVENTORY.md`
for all retained host changes and exact cleanup commands.
