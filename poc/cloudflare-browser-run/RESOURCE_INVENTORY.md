# Cloudflare Browser Run resource inventory

This is the deletion ledger for the Browser Run experiment.

## Owned by this probe

| Kind | Name | ID | Status | Delete command |
| --- | --- | --- | --- | --- |
| Worker | `kogane-vpass-browser-run-20260825` | active version `b1c16e46-a5b2-4fdf-9907-93b6a5c71e8f` | retained as disabled bootstrap; workers.dev enabled | `bunx wrangler delete kogane-vpass-browser-run-20260825` |
| Browser Run sessions | account-scoped | none active after test | verified with `wrangler browser list --json` | no action required |
| Worker secrets | `PROBE_TOKEN`, `VPASS_ID`, `VPASS_PASSWORD` | none retained | all deleted and verified with `wrangler secret list` | no action required |

Public URL:

`https://kogane-vpass-browser-run-20260825.takuanimal.workers.dev`

The active bootstrap does not have a Browser Run binding and cannot launch a
browser. Its only response reports that the probe is disabled.

## Cleanup verification

```bash
bunx wrangler secret list --name kogane-vpass-browser-run-20260825
bunx wrangler browser list --json
curl -i https://kogane-vpass-browser-run-20260825.takuanimal.workers.dev/
```

All intermediate secret-change and test versions belong to the one Worker and
are removed by deleting that exact Worker. This probe did not create or modify
`tamia`, a Tunnel, a VPC network, KV, R2, D1, a Container, or a Durable Object.
