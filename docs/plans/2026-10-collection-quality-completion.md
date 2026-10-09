# Collection quality completion and scoped acceptance

Status: implementation for review; production acceptance pending
Date: 2026-10-09
Issue: [#542](https://github.com/risu729/kogane/issues/542)
Design: [ADR 0045](../adr/0045-collection-quality-read.md)

## Implemented scope

The page reads configured collector jobs, their actual reservation read state,
attempts, terminal registration and per-source/unit/dataset/period capture,
parse and publication states. It preserves missing and unknown reasons and
shows exact stored times. The read does not prove undeclared accounts, periods
or provider histories, judge an age threshold, infer retention-cap failures,
resolve an identity or repair a collector. Missing R2 bytes are detected by the
existing download route, rather than by the CORE reference count.

## Review and integration gates

Freeze a commit and have a fresh reviewer read it and run the relevant tests.
Verify the scope gate precedes schema/source/Alarm enumeration, the quality
read writes no financial or operational state, the actual Alarm path only calls
`alarmTime`, empty and unavailable states are not successes, all continuation
pages are accessible, and current membership remains equal to the shipped
financial reads. Check all touched workspace types, scoped Worker tests,
browser behavior and the no-statistics plan guard. Keep changes to common
audit and rewards writers outside this PR. Integration and deployment are
separate authorized steps; this plan and local tests do not imply either.

## Production read-only acceptance

After an authorized release of the reviewed commit:

1. Confirm the hosted release identity and the authenticated reader authority.
   Record the exact named source scope, read time and release identity. A scope
   restricted to some accounts cannot enumerate quality and must be refused.
2. Read the summary. Derive configured/enabled/disabled/unsupported job counts
   from the returned configuration; read actual reservation states separately.
   Do not substitute historical service or Alarm counts.
3. Read every page for each selected source until `coverage.nextOffset` is null.
   Count cells by closed state/reason, including declared units with no artifact,
   published parses with no observation, unresolved identity and unavailable
   reservations. A refused page or incomplete traversal leaves verification open.
4. For the selected bounded scope, verify the links from attempt to registered
   run, original file metadata, parse and current publication. A stored CORE
   reference alone is not proof of R2 object availability. Inspect authorized
   originals only where needed; do not record their contents.
5. Store only the verification scope, observation time, aggregate counts,
   release identity and closed codes in the acceptance note. Never save response
   bodies, unit/account keys, amounts, merchants, provider labels, financial
   periods, authentication material or raw captures in public artifacts.
6. Connect individual unresolved collection failures to existing #440 issues.
   Report remaining unknowns and do not mark #542 complete for an unverified
   whole-source scope, partial pagination or a local/synthetic demonstration.

This change does not perform this production run, deploy, alter authentication,
enable collection, change provider resources, or close #542.
