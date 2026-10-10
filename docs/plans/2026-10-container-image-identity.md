# Typed Container image identity verification

Status: implemented locally; independent review and hosted CI pending.

Date: 2026-10-10

## Scope and decision

Amend ADR 0060 to distinguish Docker classic config IDs from containerd
manifest/index IDs at capture time. The failure in Deploy 38021451233 is an
identity-type mismatch after successful GlobalPass publication, not evidence
that the remaining Workers were released.

## Implemented

- Parse one standard Docker inspect JSON image, explicitly accepting an omitted
  classic Descriptor and refusing malformed/ambiguous responses. Never log the
  unrelated image metadata. CLI regressions check exact arguments and raw shape.
- Record the daemon-declared kind before publication and bind it into the
  existing Container manifest.
- Require exact digest and kind on local rechecks and prepared restore.
- Select one registry proof by the recorded kind; verify immutable parent and
  selected child bytes and preserve the linux/amd64 selection rule.
- Preserve omitted-kind config semantics without retrospectively adopting the
  failed run's untyped manifest ID.
- Add synthetic typed positive and strict-negative tests, including native Node
  capture/precheck, publication receipt and postcheck coverage.

## Remaining

- Independent reviewer must read the diff and rerun targeted and root checks.
- Hosted CI and an explicitly authorized new release are separate gates.
- Do not patch old artifacts, fabricate receipts, rerun the failed deployment,
  roll back, change credentials or invoke collectors as part of this fix.
