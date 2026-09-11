# Vpass probe cleanup — 2026-08-26

Temporary infrastructure from the Vpass experiments was removed after the
daily collector was deployed.

## Kept

- Worker, Queue, R2 bucket, secrets, and daily Cron named
  `kogane-vpass-collector-poc`.
- The pre-existing `tamia` Tunnel, VPC network, WARP routes, and host.
- Private Kuebiko captures/profiles and Git repositories used as evidence.
- The pre-existing OCI `bots` host, its network, and planned Kubernetes
  infrastructure.

## Deleted

- Workers `kogane-vpass-browser-run-20260825`,
  `kogane-vpass-runtime-probe-20260825`, and
  `kogane-tamia-tcp-bridge-20260825`.
- The runtime probe Durable Object namespace.
- Local Kameleo probe container and volume, Kameleo and Camoufox images, and
  every local tag of the runtime-probe image.
- Exact temporary directories listed in the probe inventories.
- `/opt/kogane-browser-probe`, Chrome, Xvfb, Noto CJK fonts, and the Chrome apt
  source installed on `bots` for the OCI probe. `apt autoremove` was not run.

No Cloudflare Container application or registry image was deleted because the
Free-plan deployment had rejected the image upload before either could be
created.

## Verification

- Account-level Worker inventory contains only `kogane-vpass-collector-poc`
  among names containing `kogane`.
- The three deleted Worker deployment APIs return code `10007` (not found).
- No `RuntimeProbeContainer` Durable Object namespace remains.
- Browser Run has no active sessions.
- Local Docker has no container, image, or volume whose name contains
  `kogane`, `kameleo`, or `camoufox`.
- `bots` has none of the probe directory, packages, apt source, or probe
  processes.
- The collector Queue and private R2 bucket remain, and its Cron remains
  `0 21 * * *` (06:00 JST).
