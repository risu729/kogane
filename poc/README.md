# `poc/` is being emptied

Unified plan chapter 07 §1: every directory here is moving to the place its
role belongs to, and this directory disappears when the last one leaves. It
holds no shared content of its own any more — this file is a signpost, and the
mover of the last directory deletes it together with `poc/`.

## Already moved

| was                             | is now                                                                                                  | why                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `poc/collector-diagnostics`     | `packages/collector-diagnostics`                                                                        | shared by seven collector Workers                   |
| `poc/cloudflare-browser-run`    | `experiments/cloudflare-browser-run`                                                                    | open experiment, `EXPERIMENT.md` carries its expiry |
| `poc/cloudflare-runtime-probe`  | `experiments/cloudflare-runtime-probe`                                                                  | open experiment, `EXPERIMENT.md` carries its expiry |
| `poc/camoufox-container-probe`  | [`docs/research/camoufox.md`](../docs/research/camoufox.md)                                             | finished; code removed                              |
| `poc/kameleo-container-probe`   | [`docs/research/kameleo.md`](../docs/research/kameleo.md)                                               | finished; code removed                              |
| `poc/oci-browser-probe`         | [`docs/research/oci-browser.md`](../docs/research/oci-browser.md)                                       | finished; code removed                              |
| `poc/sbi-securities`            | [`docs/research/sbi-securities.md`](../docs/research/sbi-securities.md)                                 | superseded by the SBI Securities collector Worker   |
| `poc/README.md` (the inventory) | [`docs/collector-runtime-profiles.md`](../docs/collector-runtime-profiles.md)                           | it describes collectors, not a directory            |
| `poc/CLEANUP-2026-08-26.md`     | [`docs/research/vpass-probe-cleanup-2026-08-26.md`](../docs/research/vpass-probe-cleanup-2026-08-26.md) | the retired probes' deletion record                 |

A retired directory's code is not gone, only off `main`: each research document
names the commit that carried it and the command to read it back.

## Still here

The collector Workers and the observation pipeline, each waiting for its own
promote-service or split row: `services/collector-<source>` for the collectors,
`apps/web` plus `tests/fixtures` plus `packages/` for the pipeline. Their
runtime resource identities — Worker name, Durable Object class and migration
tag, R2 bucket, Queue, cron, Email route — do not change when they move; that
is what [`infra/resources.md`](../infra/resources.md) is for.
