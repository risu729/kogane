# Deployed PoC resource inventory

Created 2026-08-31 for the V Point Pay collector validation:

| Resource | Name | Current purpose |
| --- | --- | --- |
| Worker | `kogane-vpoint-pay-collector-poc` | Daily collector and public-origin probe |
| R2 bucket | `kogane-vpoint-pay-collector-poc` | Private raw response and manifest storage |
| Durable Object class | `VPointPayCredentialState` | Rotated refresh token and device UUID state |
| Cron | `30 21 * * *` | Daily 06:30 JST trigger |

Worker URL: `https://kogane-vpoint-pay-collector-poc.takuanimal.workers.dev`

The initial deployment contains placeholder app credentials because owner-app
bootstrap is not complete. `POST /trigger` is not a successful collector check
until both secrets are replaced and `/reset-credentials` is called.

Cleanup order:

1. Delete Worker `kogane-vpoint-pay-collector-poc` (Cron, secrets, and the
   Durable Object binding are part of it).
2. Delete R2 bucket `kogane-vpoint-pay-collector-poc` after inspecting or
   exporting any retained snapshots.

No Container, Queue, D1 database, KV namespace, Email Routing rule, hostname
route, Tunnel route, or registry image was created for this PoC.
