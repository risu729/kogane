# ADR 0070: Validate observed SBI Shinsei history offline before enabling acquisition

- Status: proposed
- Date: 2026-10-10
- Related: [#447](https://github.com/risu729/kogane/issues/447),
  [implementation plan](../plans/2026-10-sbi-shinsei-history-first-slice.md)

## Context

The scheduled collector captures four snapshot responses, not complete bank
history. Period activity and CSV existed only as disabled catalog candidates.
A bounded authenticated UI observation now establishes a yen ordinary-savings
explicit-period request, nonempty and provider-reported-empty JSON shapes,
and a matching declared Shift_JIS CSV decoded by Chrome. It does not establish
pagination/truncation, `purgeflag` semantics, token topology for CSV, original
CSV byte capture, monthly reports or a safe unattended acquisition path.

Later public-client-source inspection identified a 30-row display and
on-demand description enrichment, the static CSV token getter/header link,
and the CSV download's decoded-string to UTF-8 BOM Blob transformation. These
are recorded separately in the plan; they do not promote any runtime gate.
The ordinary downloaded file must be classified as a browser-derived artifact,
not as byte-exact preservation of the declared Shift_JIS HTTP response.

## Options considered

1. Enable the routes after the small successful UI sample. Rejected: it would
   promote unverified coverage and authentication/storage assumptions.
2. Keep only prose until every surface is known. Rejected: the observed
   request and validation boundary can already be tested synthetically.
3. Add an offline-only observed contract, retaining every runtime gate.
   Selected for this first slice.

## Decision

Add a local module with no runtime caller, network or persistence. Its period
builder admits only the observed explicit yen ordinary-savings body and an
implementation budget of at most 31 inclusive days. This budget is not a
claim about the bank's maximum. The catalog remains disabled in every profile.

Strict JSON validation accepts observed success `00000` and separately the
UI-observed empty status `30224`. Empty context fields are not an echoed
request period; unknown statuses, fields or context mismatches are refused
with closed error codes. Success validates dates, account/currency, row
identities and auxiliary-row correspondence but does not interpret purge or
pagination semantics. Every inspection returns `coverageStatus: unknown`.

CSV inspection validates the declared charset and decoded six-column schema,
then checks all fields against the peer period response and the observed
request context. It returns `byteExact: false` and `persisted: false`.
It is not a Shift_JIS byte decoder, download writer, CSV replay builder or
registered observation parser. In particular the CSV request's token remains
a future same-page authentication-boundary investigation, not a new secret.

## Consequences

The existing snapshot collector, storage, parser policies, scheduling and
adopted state are unchanged. The module makes the partial observation useful
without claiming a deployable history collector. It rejects unobserved shapes
rather than guessing; additional real shapes require new sanitized evidence
and tests. Amounts are compared as exact provider text, not coerced or summed.

The [plan](../plans/2026-10-sbi-shinsei-history-first-slice.md) separates further
owner-controlled UI observation from offline implementation. Append-only
storage, parser registration, cross-artifact identity/deduplication,
publication/adoption and production acceptance remain explicit later gates.
A current snapshot's completeness never means all bank history was collected.

## Verification

Synthetic tests cover request bounds and invalid dates, strict response
shapes, the observed empty response versus errors, account/period drift,
duplicate/out-of-range rows, auxiliary-row mismatches, declared encoding and
all CSV columns. Existing route tests require zero session access, rotations
and network calls for both candidates in all execution profiles. An
independent reviewer must verify this slice before publication; hosted
acquisition and original-file persistence are not verified by these tests.

## Amendment: offline CSV byte comparisons (2026-10-10)

Public controller source establishes a decoded-string to UTF-8 BOM Blob
transformation, while the actual response declared Shift_JIS. Treating these
representations as interchangeable would lose their lineage. No actual
download or original HTTP byte capture has subsequently been observed.

Options were to leave byte comparison entirely manual, accept normalized
text equality as original-file proof, or add a bounded comparison-only helper.
The last is selected; normalized equality as provenance proof is rejected.

The new local helper reuses the decoded CSV/context/JSON-row checks. Optional
candidate HTTP bytes must decode exactly to that text using the fatal WHATWG
Shift_JIS decoder. Optional browser-artifact bytes must equal a U+FEFF prefix
and UTF-8 encoding of the same text byte for byte. Absent bytes stay absent;
an expected encoding is never returned as a reconstructed original.

The helper rejects malformed encodings, isolated UTF-16 surrogates (which
Blob would otherwise replace), altered bytes, missing/double BOMs, and local
budget overflow. HTTP bytes and UTF-8 text have a 2 MiB local cap; the browser
derivative allows only the additional three-byte BOM. No newline, decimal,
Unicode or quote normalization is performed.

Results contain sizes/counts and fixed classifications only. Successful
comparisons still explicitly leave capture/provider-origin verification,
persistence and registration readiness false and coverage unknown. This
does not produce a terminal, descriptor, invented parent relation or stored
artifact; ADR 0021's registration and append-only evidence rules are unchanged.

Synthetic tests cover valid separate/combined/absent representations, Blob
construction, bounded byte views, invalid Shift_JIS, normalization and BOM
mismatches, lossy Unicode, budgets, context checks and zero network calls.
The source semantics follow the [Encoding Standard](https://encoding.spec.whatwg.org/#interface-textdecoder)
and [File API Blob processing](https://w3c.github.io/FileAPI/#process-blob-parts).
Real capture provenance, token rotation and completeness require later
authorized observation; these tests cannot establish them.

## Amendment: offline decoded-JSON evidence persistence (2026-10-10)

A separate local adapter can now plan, persist and reread a caller-supplied
explicit-period decoded JSON response using the shared terminal-last writer.
It has no runtime caller, provider transport, registration call or live store
connection. Tests use synthetic input and an in-memory bucket only.

The selected option retains two artifacts: the exact decoded string encoded
as UTF-8 (`history-decoded.json`, `collector_derived`, `reencoded`) and a
generated private context manifest (`history-context.json`,
`collector_manifest`, `generated`). Original HTTP bytes were not captured;
there is no fabricated source artifact or parent relation. Existing descriptor
derivation classifies the decoded response as transformed with
`source_bytes_not_available`, and neither artifact matches a registered dataset.
The context includes the private account/period needed to replay the observed
empty response; these values never enter keys, terminal units or public results.

The terminal describes persistence only: `partial`, coverage `unknown`, a
fixed `yen-period` unit and requested/request-based date range, and
`history_capture_origin_unverified`. Echo matching does not prove complete
coverage, capture provenance or provider origin. UUID run IDs and an exact
input envelope exclude arbitrary identifiers, headers and authentication fields.
All metadata primitives are copied before awaiting any digest. Duplicate JSON
keys at every depth (including escaped equivalents), isolated surrogates,
unknown response fields and local budget overflow are refused before storage.
JSON has a 2 MiB/depth-64 budget; the generated context has a 16 KiB budget.

The reader requires the caller's terminal digest, validates the canonical
terminal, retrieves both actual object bodies, checks byte counts and hashes,
and decodes with fatal UTF-8. It rebuilds the plan using fresh strict response
inspection and requires identical terminal digest, binding exact artifact
inventory, roles, transformations, metadata, scope and recomputed context.
A resend also performs this readback. Persistence, readback verification,
incomplete writes and conflicts remain distinct; failures never overwrite,
delete earlier evidence, refetch a provider or automatically retry.

No registration, parsing, publication or seal is performed by this adapter.
This is not a claim that derived-only terminals can never seal: the existing
scanner's no-provider early refusal applies to failed outcomes, not every
partial outcome. Connecting this adapter to shared production DATA would
expose its terminal to that scanner and is a separate, unapproved integration
gate. A future connection must review registration/seal policy explicitly;
this amendment does not change it or label a synthetic result as production
evidence. Routes, catalog, browser, CSV/PDF, snapshot writer and parsers remain
unchanged. All-history completion, original-response capture, deduplication,
and production acceptance remain unproved.

Synthetic verification covers decoded-byte fidelity, secret/shape refusal,
input mutation during awaits, empty-context replay, terminal-last ordering,
idempotent actual-byte readback, conflict/non-overwrite, partial failure
preservation, damaged bytes/metadata/context, tampered canonical manifests,
closed diagnostics, existing descriptor classification and zero provider calls.
