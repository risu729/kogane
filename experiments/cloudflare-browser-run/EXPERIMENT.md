# Experiment: Cloudflare Browser Run probe

| field    | value                                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner    | risu729                                                                                                                                            |
| Started  | 2026-08-25                                                                                                                                         |
| Expires  | **2026-12-31**                                                                                                                                     |
| Status   | Continuing. Nothing is deployed; the Worker, its secrets and its sessions were deleted on 2026-08-26.                                              |
| Question | What can a real remote Chromium do that transport impersonation cannot, and where does Cloudflare's identifiable browser egress stop being usable? |

## Why it is still here

Browser Run is a runtime two live collectors already use — MyJCB bootstraps its
session in it, and the GLOBAL PASS Worker keeps an authenticated
`/browser-probe` route on it — so the boundary this probe measured is an
operational question, not a closed one: Browser Run traffic leaves from
Cloudflare ranges, carries Cloudflare browser-identification headers, and
**cannot** be routed through the `TAMIA.connect()` adapter. Any proposal to move
a source onto Browser Run is decided against that limit.

The probe is the smallest harness that re-measures it: one authenticated Worker
with two fixed actions (`/inspect`, `/login`), a bootstrap config that deploys
it disabled, and a one-shot runner that creates a random token, calls exactly
one action and deletes the token in `finally`.

Note that `packages/` and `services/` do **not** import this directory, and the
plan's `isolate-or-promote` row was decided as _isolate_ on that evidence: no
product code, wrangler config, task or asset outside this directory references
`cloudflare-browser-run` (the `BROWSER` bindings in the MyJCB and GLOBAL PASS
configs are the Cloudflare platform binding, not this package). If a collector
ever needs this code, promote it to `packages/browser-run` then — do not let a
service reach into `experiments/`.

## Stop condition

Retire this experiment — fold `RESULTS.md` into
`docs/research/cloudflare-browser-run.md` and delete the code — when **any** of
these becomes true:

1. no collector uses Browser Run any more (MyJCB moves its login off it and the
   GLOBAL PASS `/browser-probe` route is removed), so the egress limit stops
   mattering;
2. Cloudflare gives Browser Run a configurable egress, which would invalidate
   the recorded result and require a fresh probe rather than this one;
3. the expiry date passes without either of the above. Extending means editing
   this file with a new date and a reason.

## What depends on it

- Nothing in `services/` or `packages/` imports it; the import boundary test
  forbids it.
- No live Worker, secret or Browser Run session: `kogane-vpass-browser-run-20260825`
  was deleted on 2026-08-26 and the API reports code `10007`
  (`RESOURCE_INVENTORY.md`). The Worker name is kept in `wrangler.jsonc` and
  `wrangler.bootstrap.jsonc` so a redeploy reuses the same identity.
- CI runs `mise run ci:cloudflare-browser-run` (type-check) and a
  `wrangler deploy --dry-run` of `wrangler.jsonc`.

## Rules for running it

`scripts/run_once.py login` fills the real Vpass form and clicks submit once.
Do not loop it, do not run it unattended, and delete both credential secrets and
return the Worker to its disabled bootstrap version afterwards — the exact
commands are in `RESOURCE_INVENTORY.md`.
