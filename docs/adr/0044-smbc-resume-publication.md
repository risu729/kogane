# ADR 0044: SMBC backfill continuation publication

Status: proposed
Date: 2026-10-09

## Context

SMBC backfills can need a new human-approved authentication session before all
month chunks finish. The collector keeps one cumulative staging run, but publishes
an immutable terminal when a session ends partial. Reusing that terminal identity
after resuming conflicts with the earlier digest; the UI previously showed bank
acquisition success even when shared publication failed.

## Options considered

- Overwrite the partial terminal: violates append-only evidence.
- Publish all cumulative artifacts again under a new identity: duplicates
  normalized observations from completed chunks.
- Publish only additional evidence in continuation terminals: preserves partial
  evidence and does not catalogue a completed normalized chunk twice.

## Decision

Keep the cumulative backfill ID and staging progress. The initial publication
retains that ID. Subsequent publications read the initial terminal and a bounded
list of its continuations, then publish only artifact key/hash pairs absent from
that inventory. Previously published normalized artifacts must still be present
with unchanged hashes. A raw-only chunk may supply the raw input of a later
normalization again; this does not publish normalized observations twice.

Continuation IDs and attempt IDs derive from the cumulative manifest digest.
The initial terminal retains the original session generation even if publication
was delayed until after a resume. Each continuation carries its requested remaining range and current
authenticated session generation, a segment manifest referring to prior terminal
keys, and the exact cumulative collector manifest as a separate non-unit artifact.
All writes use the existing immutable collection writer. A changed failure snapshot
with no new provider bytes gets a manifest-only failed continuation; an exact
snapshot retry is a no-op. Success without new evidence is refused. The processor
records manifest-only failures with `provider_run_failed` and does not seal or
parse them; this preserves the failed attempt without claiming an empty account.

An Access-protected, same-origin empty-body action retries publication from saved
staging data. It does not log in, generate a QR, fetch the bank, or change adopted
financial state. The UI distinguishes bank acquisition, shared publication and
pending central registration/analysis.

## Consequences

The processor registers partial and continuation terminals separately. Their
normalized artifact inventories are disjoint, so the completed backfill's
observations are their union. Corrupt prior terminals, lost or changed normalized
artifacts, missing raw parents, or more than the bounded continuation inventory
refuse publication. These require investigation rather than rewriting history.

A staging manifest remains operational progress; the content-addressed manifest
snapshots attached to terminals preserve each published revision.

## Verification

Workers-runtime R2 tests cover a legacy partial followed by multiple approved
sessions, exact preservation of the initial terminal, complete remaining scope,
session provenance, referenced object verification, disjoint normalized catalogs,
idempotent retries, changed/missing normalized evidence and raw-only recovery.
