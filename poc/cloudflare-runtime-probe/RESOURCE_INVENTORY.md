# Cloudflare Runtime Probe Inventory

This file is the deletion ledger for the temporary resources created by the
Vpass runtime experiment. Keep the probe deployed for follow-up comparisons,
but update this file whenever a resource is added, replaced, or deleted.

## Owned by this probe

| Kind | Name | ID / digest | Created | Status | Delete command |
| --- | --- | --- | --- | --- | --- |
| Worker | `kogane-vpass-runtime-probe-20260825` | version `99fea156-df18-4b3c-83e3-58113a298b8a` | `2026-08-25T08:59:21.377Z` | deployed; workers.dev enabled | `bunx wrangler delete kogane-vpass-runtime-probe-20260825` |
| Durable Object namespace | `RuntimeProbeContainer` migration `v1` | `eeaa4940178541ab95d64100fdaedf6f` | `2026-08-25` | binding exists; no Container application assigned | removed with the Worker; verify after deletion |
| Container application | `RuntimeProbeContainer` | none | `2026-08-25` | not created: Workers Paid is required | no Cloudflare cleanup required |
| Container image | deployment-generated | none | `2026-08-25` | local build only; Cloudflare upload rejected | no Cloudflare cleanup required |

## Referenced but not owned

| Kind | Name | Purpose | Cleanup |
| --- | --- | --- | --- |
| Cloudflare Tunnel | `tamia` | Compare VPC `fetch()` and raw `connect()` egress | **Never delete from this probe.** Pre-existing personal routing infrastructure. |

## Public probe URL

`https://kogane-vpass-runtime-probe-20260825.takuanimal.workers.dev`

The public endpoints expose only network fingerprints and SHA-256 IP hashes.
They accept no credentials and store no data.

## Worker version history

The failed Container upload happens after Worker version upload. All three
versions belong to this one temporary Worker and are removed by deleting it:

- `3b0ebd09-801b-48cc-8ad5-dbc9792f3b70`
- `97df6ab4-5204-42d5-8988-8eafce461602`
- `99fea156-df18-4b3c-83e3-58113a298b8a` (active)

The Workers.dev trigger was enabled through the Cloudflare API after the first
Wrangler deployment stopped at the unavailable Container product boundary.

## Fixed toolchain

- Wrangler `4.125.0`
- `@cloudflare/containers` `0.3.7`
- `impit` `0.14.3`
- Bun `1.4.0`
- Worker compatibility date `2026-08-25`
- Container instance type `lite`, maximum one instance, APAC constraint

## Inventory before cleanup

Run from this directory with the pinned local Wrangler:

```bash
bunx --bun wrangler versions list
bunx --bun wrangler deployments list
bunx --bun wrangler containers list
bunx --bun wrangler containers images list
```

Before deletion, replace every `pending` value above with the live ID/digest.
After deleting the Worker, repeat the inventory commands and delete only the
remaining resources whose exact names/IDs are recorded in **Owned by this
probe**. Never delete `tamia` or any other pre-existing Tunnel.

The local Docker image is not a Cloudflare resource. If it is no longer useful,
it can be removed independently with:

```bash
docker image rm kogane-vpass-runtime-probe-20260825-runtimeprobecontainer:worker
```
