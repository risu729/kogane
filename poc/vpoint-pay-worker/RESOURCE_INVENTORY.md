# Deployed PoC resource inventory

Created 2026-08-31 for the V Point Pay collector validation.

2026-09-05: app API collection disabled. Cron is removed;
manual collection/probe/reset routes return HTTP 410. Existing R2 data, DO state
and secrets are retained. V Point Pay email collection in `poc/vpoint-worker/`
remains active. The retained resources are:

| Resource | Name | Current purpose |
| --- | --- | --- |
| Worker | `kogane-vpoint-pay-collector-poc` | Disabled app API; health and authenticated credential diagnostics |
| R2 bucket | `kogane-vpoint-pay-collector-poc` | Private raw response and manifest storage |
| Durable Object class | `VPointPayCredentialState` | Rotated refresh token and device UUID state |
| Cron | None | Scheduled app collection disabled |

Worker URL: `https://kogane-vpoint-pay-collector-poc.takuanimal.workers.dev`

The original deployment used placeholder credentials. Changing secrets does not
re-enable the retired collector; its provider-capable routes remain disabled.

Cleanup order:

1. Delete Worker `kogane-vpoint-pay-collector-poc` (Cron, secrets, and the
   Durable Object binding are part of it).
2. Delete R2 bucket `kogane-vpoint-pay-collector-poc` after inspecting or
   exporting any retained snapshots.

No Container, Queue, D1 database, KV namespace, Email Routing rule, hostname
route, Tunnel route, or registry image was created for this PoC.
