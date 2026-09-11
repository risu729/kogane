# Experiment: Cloudflare runtime and egress probe

| field    | value                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| Owner    | risu729                                                                                                               |
| Started  | 2026-08-25                                                                                                            |
| Expires  | **2026-12-31**                                                                                                        |
| Status   | Continuing. Nothing is deployed; the config and the container image are kept buildable.                               |
| Question | Which network identity does each Cloudflare runtime path present, and can a Container reach a Japanese egress at all? |

## Why it is still here

This is the only place in the repository that compares five runtimes side by
side under one Worker: plain Worker `fetch`, Container native `fetch`,
Container `impit` with a Chrome profile, VPC Tunnel `fetch` through `tamia`,
and VPC Tunnel raw `connect()` through `tamia`. Two live collectors depend on
answers this probe produced or can re-produce:

- the GLOBAL PASS collector pins its Container browser to the `tamia` exit and
  keeps re-testing direct Cloudflare egress against it. The A/B it runs is the
  same comparison this probe isolates without a browser in the way;
- the TAMIA TCP bridge probe reuses this probe's `connect()` finding.

It also holds `SERVERLESS-VPASS-DESIGN.md`, the written-up design for a
container-hosted collector, which later work on Container-based sources starts
from rather than re-deriving.

## Stop condition

Retire this experiment — move `RESULTS.md` and `SERVERLESS-VPASS-DESIGN.md`
into `docs/research/cloudflare-runtime.md` and delete the code — when **any** of
these becomes true:

1. every source that needs a browser or a fixed egress runs through one agreed
   runtime (Container Chrome pinned to `tamia` today), and no open question
   about a second runtime remains;
2. Cloudflare Containers become available on the account's plan _and_ a real
   collector has used them, so the probe's "Container application could not be
   created on the Free plan" result is superseded by production experience;
3. the expiry date passes without either of the above. Extending means editing
   this file with a new date and a reason, not letting it lapse silently.

## What depends on it

- Nothing in `services/` or `packages/` imports this directory, and the import
  boundary test forbids it from ever doing so.
- No Worker, Durable Object namespace, Container application or registry image
  exists for it: all were deleted on 2026-08-26 and re-verified
  (`RESOURCE_INVENTORY.md`). The Durable Object class `RuntimeProbeContainer`
  and migration tag `v1` stay in `wrangler.jsonc` so that a redeploy would
  address the same state rather than creating a second namespace.
- `tamia` is referenced, never owned. Deleting the Tunnel as cleanup for this
  experiment is forbidden; the GLOBAL PASS collector runs through it.
- CI runs `mise run ci:cloudflare-runtime-probe` (Worker and container
  type-checks) and a `wrangler deploy --dry-run`. That is all this directory
  costs while it is open.

## How to run it

See `README.md`. Deployment is deliberately not automated: the last step ends
in an expected `Unauthorized` when Cloudflare reaches the Container boundary on
the Free plan, and a redeploy re-creates a public probe endpoint that has to be
deleted again afterwards.
