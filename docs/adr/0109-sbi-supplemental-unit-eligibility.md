# ADR 0109: Isolate SBI supplementary completeness from core publication

- Status: proposed
- Date: 2026-11-11

## Context

A daily SBI run stores core positions, executions and current cash alongside
retained statements, reported income/gains and weekly assets. Their unobserved
shapes correctly refuse publication, but the default run-scoped eligibility
also withheld complete unrelated core data. See [issue 1296](https://github.com/risu729/kogane/issues/1296).

The existing domestic and foreign units deliberately aggregate their dependent
core captures. An interrupted trade-history chain or main-site acquisition
must still prevent that core unit from publishing a partial result.

## Options considered

1. Keep run-scoped publication: safe refusal with an unnecessarily source-wide
   impact whenever a supplementary shape changes.
2. Give every artifact an independent unit: loses completeness across retained
   source bytes, derived bundles, page chains and weekly year shards.
3. Preserve the two core units and give each independently validated supplement
   one unit, using the existing unit eligibility policy. Selected.

## Decision

Keep `domestic` and `foreign` for core acquisition, including their execution
windows. Introduce these closed supplementary boundaries:

| Unit                    | Contents                                                         |
| ----------------------- | ---------------------------------------------------------------- |
| `cash-history-yen`      | Retained yen statement pages and derived bundle                  |
| `cash-history-foreign`  | Retained foreign statement pages and derived bundle              |
| `income-history-income` | Income controls, rows and complete retained container            |
| `income-history-gains`  | All-product/domestic controls, rows and retained gains container |
| `weekly-assets`         | Original response, inventory and every derived year shard        |

The collector explicitly passes the cash/income kind with a refusal, so a
transport failure has the same boundary as a schema refusal. Recomputed input
inventories run within these boundaries; a missing or changed source refuses
its dependent unit. An unattributed core failure remains attributed to its
original scope. Only actually captured or refused supplements declare a unit.
The run still reports partial when any attempted unit refuses.

Migration 0100 opts the eleven financial datasets into existing unit-scoped
eligibility. Six existing snapshot rows advance only when every field equals
its shipped default, including each row's timestamp and parser pin. Existing
nondefault operator choices survive; an identical manual choice has no separate
provenance. History policies are inserted only when absent and
never enable replacement snapshots. Provider source artifacts have no parser
eligibility policy. Sealed artifact counts and the parse/publication gates
continue to enforce within-unit completeness.

Income and gains were already complete-container snapshots under the old
`domestic` unit. Snapshot ranking maps only that exact legacy source/parser/
dataset/unit combination to its new unit partition. Selected rows and coverage
claims retain their actual unit keys. A complete new capture replaces the old
one, a complete-empty capture clears it, and a refused capture preserves the
last complete snapshot. Historical cutoffs still select the earlier capture.
Other sources, parsers, datasets and unit names are unchanged.

The delivered-document archive retains its separate terminal and per-document
units from [ADR 0108](0108-sbi-delivered-documents.md). No mailbox failure is
moved back into the financial terminal.

## Consequences

Healthy core units and healthy supplementary siblings publish during a refused
supplementary capture. A partial domestic or foreign core still blocks every
dataset in its own core unit. Existing evidence and publication history remain
append-only. Previously partial coarse domestic units remain refused; the
migration does not invent successful historical supplementary acquisition.

This does not accept unobserved foreign cash continuation, non-domestic gains,
fund distributions, larger income pages or iDeCo shapes. Those remain closed
until separately observed and implemented. No provider login, collection request,
deployment or production acceptance follows from these synthetic checks.

## Verification

Synthetic native D1/R2 tests exercise retained capture, terminal persistence,
registration, the shared dispatch eligibility predicate, real parse/publication
jobs and the production reader for each refusal trigger. Negative cases retain domestic and foreign
core refusal. Legacy-to-new income/gains tests cover corrected and empty
containers, refusal fallback and historical cutoff. Migration tests verify
exact scope, idempotence and preservation of every nondefault policy field.
