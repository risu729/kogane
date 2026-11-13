# ADR 0108: SBI delivered-document evidence and bounded continuation

- Status: proposed
- Date: 2026-11-11

## Context

[Issue 1248](https://github.com/risu729/kogane/issues/1248) requests scheduled
archival of electronically delivered reports. The
[dated observations](../sources/sbi-securities.md#2026-11-11-observed-bootstrap-producer-and-current-mailbox-contract)
establish the new mailbox's literal bootstrap grammar, counted current list,
eight representative single-PDF detail shapes and selected native PDF
responses. They do not prove an HTTP-only session or a scheduled archive.

The existing source already has an HTTP-only session, a private DATA binding,
a source execution lease and terminal-last persistence. Original documents
must remain immutable evidence without creating duplicate financial facts.
An unbounded in-memory walk would compete with existing financial collection
and the thirteen-minute lease-holder deadline.

## Options considered

1. Execute provider JavaScript or use a browser in production. This adds an
   execution surface and runtime absent from the existing collector.
2. Require every report to finish in each run. This can indefinitely starve a
   suffix after a memory or execution bound.
3. Extract only witnessed DOM/AST shapes, archive independently validated PDFs,
   and resume a bounded round-robin walk after durable terminal persistence.

## Decision

Use option 3. Existing domestic and foreign collection runs first. The mailbox
uses the remaining budget until collection start plus eleven minutes, leaving
time for terminal persistence within the existing holder limit.
The existing financial terminal is persisted before mailbox work begins.
Mailbox artifacts, failures, units and ranges belong to a separate terminal
with run ID `<financial-run-id>-mailbox`, sharing the acquisition reference and
start time. A mailbox refusal therefore cannot change financial run-scope
eligibility. The operation reports every known durable run ID even if mailbox
collection, persistence, cursor commit or the enclosing lease later fails.
This prevents a new instance of
[issue 1296](https://github.com/risu729/kogane/issues/1296); existing financial
supplementary-unit isolation remains that issue's separate scope, and a failed
financial core remains ineligible.

Only exact observed navigation destinations and POST forms are admitted.
Redirects are manual, bounded and never replay a secret-bearing POST. HTML
follows HTTP/meta charset declarations; parse5 extracts forms and Acorn checks
the entire observed bootstrap grammar without evaluation. Cookies are scoped
by origin/domain/path/secure, and invalid-domain responses are refused. All
handoff material remains request-local and is excluded from artifacts and logs.

The current list needs closed schemas, unique row identities, an exact stated
count and independent issued-summary agreement. Supported single-PDF details
are checked individually; unsupported kinds and sibling failures remain visible
without suppressing verified documents. Multiple files and non-PDF formats
remain unsupported. Null/string detail variants are limited to the observed
fields; no document field receives a financial interpretation.

Each original PDF has its own unit and kind/date/stable-row/content-hash
artifact locator. The stable row hash includes the provider's business/user,
kind, base date and sequence fields, independently of read state, title and
PDF bytes. Raw identifiers and titles remain private metadata. Identical bytes
reuse one content-addressed DATA object, distinct identities keep separate
references, and changed bytes create another immutable revision.

The operational-mutable `sbi_mailbox_progress` table stores only a next-identity
hash and the last persisted run ID. Under the existing source lease, a current
list is sorted by identity hash, starts at the pointer and wraps once. The
pointer is updated only after terminal persistence, including a persisted
partial provider outcome, with a previous-run comparison and idempotent retry.
A failed persistence never advances it. A missing cursor target chooses its
sorted successor, wrapping if needed. Completed cycles refetch earlier PDFs;
no provider identity is assumed to imply immutable bytes.
The original lease abort signal gates every mailbox request and loop iteration,
cancels response streaming, and is checked again before cursor commit. Early
lease loss leaves the pointer unchanged while already verified evidence may
still be persisted. Unrelated financial transports retain their existing behavior.

Responses are bounded before buffering: 256 KiB HTML, 2 MiB JSON, 4 MiB per PDF,
and 48 MiB retained PDF bytes per run. Reaching the whole-run byte/deadline
budget stops further downloads and records partial units, with the first
unretained identity as the next pointer. An oversized individual response fails
only that document, preserving progress to valid siblings. No request window
or new public operation is added.

Registration v11 adds only `delivered-document-pdf`, freezing v1–v10 meanings.
Migration 0099 grants its metadata parser independent unit eligibility on
partial parents. The parser emits evidence-only coverage and no observations,
economic events or replacement financial snapshots. The catalogue stays partial.

## Consequences

The new mailbox can progress across bounded runs without overwriting evidence
or claiming unsupported legacy coverage. Cursor storage adds operational state
to the collector's existing D1 lease usage. A failed cursor commit is an
operational error after durable archival; the prior pointer remains safe to
repeat. Only a successful scheduled run can establish the actual HTTP session,
current archive coverage, publication and execution budget. Multi-group, legacy,
multi-file and other-format behavior remains unproved or unsupported.

## Verification

Synthetic tests cover whole-AST/form refusal, scoped redirects and cookies,
token rotation, stream bounds, count corroboration, sibling preservation,
round-robin continuation, cursor comparisons, native byte persistence, duplicate
object reuse, metadata registration/publication and absence of financial facts.
Required workspace/root and repository checks validate the implementation;
no provider collector execution or deployment is part of these checks.
