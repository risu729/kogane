# TAMIA TCP bridge resource inventory

This is the deletion ledger for the temporary resources created by the raw TCP
bridge experiment. The temporary Worker and its already-disabled secret were
removed on `2026-08-26 AEST`.

## Owned by this probe

| Kind          | Name                               | ID                                                    | Status                                           | Delete command     |
| ------------- | ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ------------------ |
| Worker        | `kogane-tamia-tcp-bridge-20260825` | active version `a700afb3-4de3-4e0e-b36f-3a18a487816d` | deleted; API now reports code `10007`            | completed          |
| Worker secret | `BRIDGE_TOKEN`                     | none retained                                         | deleted and verified with `wrangler secret list` | no action required |

Public URL:

`https://kogane-tamia-tcp-bridge-20260825.takuanimal.workers.dev`

The former URL now returns `404`. Re-running
`scripts/bridge_proxy.py` creates a random temporary secret and deletes it on a
normal SIGINT/SIGTERM shutdown. If the process is killed uncleanly, verify and
delete only this exact secret:

```bash
bunx wrangler secret list --name kogane-tamia-tcp-bridge-20260825
bunx wrangler secret delete BRIDGE_TOKEN \
  --name kogane-tamia-tcp-bridge-20260825
```

## Worker versions

All versions belong to the one Worker above and are removed with that Worker:

- `4bf67f63-d679-4ff1-98ba-6235479ae9c7` (bootstrap)
- `031dc4ae-6ca5-4ba6-888b-71f915477a67` (initial fixed bridge)
- `a700afb3-4de3-4e0e-b36f-3a18a487816d` (active diagnostics allowlist)

## Referenced but not owned

| Kind                            | Name / ID                                        | Purpose                                                | Cleanup                                                                       |
| ------------------------------- | ------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Cloudflare Tunnel / VPC network | `tamia` / `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33` | Fixed raw TCP egress through the Japanese home network | **Never delete from this probe.** It is pre-existing personal infrastructure. |

## Local-only artifacts

The following were temporary local test directories and are not Cloudflare
resources:

- `/tmp/impit-main-20260825`: pinned upstream build of unreleased Chrome 151.
- `/tmp/kogane-impit151-test-20260825`: test-only client wired to the local
  bridge.
- `/tmp/kogane-curl-cffi-20260825`: Python environment for `curl_cffi 0.16.1`.

No Vpass credentials or session cookies were written to those directories.
All three directories were removed on `2026-08-26 AEST`.
