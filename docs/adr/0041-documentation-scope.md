# ADR 0041: Separate maintained documentation from historical records

Status: proposed until this PR merges; accepted upon merge
Date: 2026-10-05

## Context

The root documentation catalogue mixed current contracts, runbooks, dated
rollout evidence, research and design decisions. Repeated status paragraphs and
old deployment recipes could be mistaken for current behavior after the alarm
cutover. The roadmap accumulated several hundred lines of historical fixes.

## Options considered

1. Convert every stale document into an ADR: loses the distinction between a
   decision and a rollout observation, and leaves operating instructions stale.
2. Move every document into new directories: makes grouping visible but breaks
   many established paths/anchors without improving factual scope.
3. Keep stable reference paths, add a categorized index and current-status
   reference, and explicitly separate dated records: preserves evidence and
   links while making the reading/update boundary visible.

## Decision

Choose option 3. ADRs record decisions, alternatives and rationale at the time
of adoption. Preserve older ADR contents; a changed decision gets an amendment
or a superseding ADR, plus the corresponding living-reference update.

Maintained docs describe current contracts, limitations and operating steps.
The roadmap holds future work and acceptance criteria; current status states
implementation versus configured enablement and verification. Dated research,
acceptance reports and partially superseded proposals are labeled as such, not
converted into decisions. Keep their original paths where they are already
referenced; new long chronological records belong in `docs/history/`.

## Consequences

Documentation has an index, not a second parallel source of runtime truth.
Configs/code and generated ledgers remain authoritative; a date/base revision
bounds status assessments. Implementation PRs update their relevant living docs
and current limits. Past evidence is not silently rewritten as current proof.
The cleanup itself changes no runtime, grant, schedule or production data.

## Verification

Check local Markdown targets/anchors and catalogue coverage, formatting and
patch whitespace. An independent reviewer verifies status and operational claims
against current code/configs and confirms existing ADRs retain their contents.
