# OCI browser probe resource inventory

This ledger covers only resources created for the 2026-08-25 probe. The OCI
host `bots`, its SSH configuration, network, and future Kubernetes cluster are
pre-existing infrastructure and must not be deleted as probe cleanup.

## Cleanup completed on `bots`

| Kind | Path or package | Status | Removal |
| --- | --- | --- | --- |
| Probe root | `/opt/kogane-browser-probe` | deleted `2026-08-26 AEST` | completed |
| Google Chrome | `google-chrome-stable` 151.0.7922.173 | purged `2026-08-26 AEST` | completed |
| Display/font packages | `xvfb`, `fonts-noto-cjk` | purged `2026-08-26 AEST` | completed |
| Chrome apt source | `/etc/apt/sources.list.d/google-chrome.sources` | deleted `2026-08-26 AEST` | completed |

`apt autoremove` was not run: other services on `bots` may use packages that
apt now considers automatic. The host, SSH configuration, network, and future
Kubernetes infrastructure were not changed.

## Cleanup verification

```bash
test ! -e /opt/kogane-browser-probe
dpkg-query -W google-chrome-stable xvfb fonts-noto-cjk
test ! -e /etc/apt/sources.list.d/google-chrome.sources
find /tmp -maxdepth 1 -type d -name 'kogane-chrome-profile.*' -print
```

Three profiles left by early cleanup races were explicitly removed after their
absolute `/tmp/kogane-chrome-profile.*` paths were verified. The final check
returned no remaining probe profile. Browser profiles are always temporary and
the working cleanup waits for browser termination before deleting them.

No Vpass credential or cookie value was stored on `bots`. No Worker, Container,
Tunnel, VPC network, Kubernetes resource, DNS record, firewall rule, or OCI
resource was created or modified by this probe.

## Local Windows fresh-profile control

The Kuebiko run labeled `kogane-fresh-profile-test` is retained only in the
normal private Kuebiko capture root. It contains sensitive Vpass network and
storage evidence and is not committed. The dedicated test profile
`browser-profile-clean-test-20260825` was closed and sent to the Windows Recycle
Bin, so it is recoverable if the profile itself is unexpectedly needed. The
temporary launcher, automation script and cleanup script were deleted. The
existing `browser-profile-beta` was not used or removed by this fresh-profile
control.
