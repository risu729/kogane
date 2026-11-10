# ADR 0097: SBI Shinsei monthly reports are immutable documents with metadata-only coverage

Status: proposed
Date: 2026-11-09
Issue: [#1247](https://github.com/risu729/kogane/issues/1247)

## Context

Ordinary authenticated PowerDirect navigation exposed a report list and a JSON
PDF-download response. The inspected account offered eight unique months; the
public retention description of 60 months does not establish that every account
has 60 files. Reports contain personal data. The issue requests private capture
and month/size/hash metadata, with no transaction parsing.

## Options considered

1. Parse financial rows from PDFs: outside the issue and unobserved semantics.
2. Keep only PDF bytes: loses explicit parser coverage and leaves the catalogue
   unable to truthfully name the document capability.
3. Register immutable documents and validate metadata with zero financial
   observations (chosen).

## Decision

The existing scheduled Container session reads `getStatementReport`, then calls
`downloadStatement` for each offered month that CORE has not registered and for
the newest offered month. Request year/month strings come directly from the
strictly validated list; no personal date or fixed 60-month window is generated.
The existing CORE binding supplies sealed, successful document-unit months as a checkpoint;
it writes no cursor, second index, setting or new resource. Registration lag may
cause another download; content-addressed DATA storage still writes identical
PDF bytes once. The full currently offered list is re-enumerated on every run, including older
late-issued or previously missing months. The newest month is checked again so a revised file is appended.
Older registered months are not re-downloaded; historical revisions are outside
this policy and need a separate requested change if the provider starts making
them.

The Worker validates the exact observed JSON schema, success code, canonical
base64, request/response month equality, declared byte size and `%PDF-` prefix.
It retains the decoded PDF, not the JSON's provider filename, posting date,
mail identifier or report-registration settings. PDF contents are opaque and
remain private. Limits are one MiB per PDF, 120 offered periods, two MiB per
provider JSON response and an eight MiB collection-handoff budget below the
existing ten MiB transport ceiling. These are refusal limits, not provider
retention claims. A failed read stops later report reads; budget exhaustion and
invalid reports make the run partial while retaining valid sibling documents.
Each report request is bounded to 30 seconds, with a ten-minute report-loop
deadline inside the existing lease. The next scheduled run resumes missing
periods from registered evidence.

Each document uses the run-relative artifact key
`monthly-report-YYYY-MM-<sha256>.pdf`, a `monthly-report-YYYY-MM` document unit,
and a source-based month coverage range. Its DATA object remains
`objects/<prefix>/<sha256>`. The shared terminal records an extraction/base64-decoding
step whose transient JSON input is not retained. The descriptor says transformed\nprovider bytes; this does not claim original browser-downloaded file provenance. No append-only evidence is
rewritten, including when the newest month's bytes change.

Parser `sbi-shinsei-monthly-report-metadata` 1.0.0 validates the PDF prefix and
size bounds, artifact-key hash against the pipeline-verified digest, and the
month/unit identity. It returns zero financial observations and a complete
`evidence-only` claim for one document, with `membershipComplete: false`.
This proves the captured document's presence, not PDF semantic validity,
transaction coverage or all-time report availability. The document catalogue
entry names this real parser; the existing status vocabulary and its version
are unchanged. The capability does not by itself prove production collection.

A `unit` eligibility policy with `snapshot_selection = 0` lets valid sibling
PDFs receive metadata coverage in a partial run. Evidence-only claims cannot
replace holdings, and no existing container-snapshot rule changes.

## Consequences

- A first bounded run attempts every offered missing month; subsequent runs
  request only missing months and the latest. No report is invented for a month
  absent from the provider's list.
- Month, byte size and hash are available through existing artifact/unit/range
  evidence and parser coverage. No transaction, balance, price or account
  observation is manufactured for a document.
- Operational failures use fixed dataset operations and closed codes, never a
  provider filename, report period, JSON body or document contents.
- Report failures make the parent run partial. Existing run-success-only core
  snapshots then retain their previous current capture; independent PDF units
  can still publish metadata. This change does not relax that boundary.
- A report larger than the supported limits remains uncollected with a partial
  result; the limits are never silently truncated or labelled complete.

## Verification

Synthetic tests cover observed list/download shapes, unsupported fields and
codes, month echo, PDF/base64/size bounds, missing-month selection and actual
in-page request ordering. Shared-DATA and Processor tests cover month/hash keys,
immutable deduplication, metadata publication with zero financial rows and
successful document units in partial runs. No production collection or deployment
is part of this pull request; post-deploy report coverage remains pending.
