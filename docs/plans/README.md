# Plans

Plans state proposed work, status and acceptance criteria. A merged plan file
is not approval of its remaining recommendations. Accepted design choices are
recorded separately in [ADRs](../adr/README.md); the current delivery sequence
and limits are in [roadmap](../roadmap.md) and [current status](../current-status.md).

- [2026-09 next-milestone proposal](2026-09-next-milestone.md): proposed,
  partially superseded by later implementation; original migration reservations
  and PR state are historical.

- [2026-10 PRESTIA bank Worker integration](2026-10-prestia-bank-worker.md): implemented
  collector/parser integration, merged in #437; deployment and first production
  verification pending. The seeded schedule remains disabled.

- [2026-10 AI as a delegated operation path, with a common audit log](2026-10-ai-operation-path.md):
  in progress. Slices S1, S2, S3 (declarations and execution) and S4 are
  merged; #660 also carries parts of S5 (instrument history and audit reads)
  and S6 (command, job, maintenance and operations tools; not survey
  acceptance). S7 (#925) and S8 (#923, #926) are merged; survey acceptance
  and a first delegation remain open. Decisions in ADR 0063 and ADR 0064 (accepted);
  each slice is its own pull request.

- [2026-10 publish the integrated MCP execution and maintenance path](2026-10-mcp-maintenance-followups.md):
  integration merged in #660; survey acceptance and real-client write
  activation remain open.

- [2026-10 synthetic remote D1 conformance](2026-10-d1-conformance.md): the
  fixed CORE 0071 remote run is recorded; the later integration has no remote
  evidence.

- [2026-10 instrument resolution after anchor pinning](2026-10-instrument-resolution-remaining.md):
  proposed implementation/test plan; its pure selector and temporal journal
  slices are merged (#637, #652), no temporal command or route is enabled.

- [2026-10 collector refusal and persistence diagnostics](2026-10-collector-refusal-diagnostics.md):
  implemented, merged in #655.

- [2026-10 typed Container image identity verification](2026-10-container-image-identity.md):
  implemented, merged in #658.

- [2026-10 collector admin bearer retirement](2026-10-collector-admin-retirement.md):
  in progress; the first slice (13 of 15 registrations) is merged (#665).

- [2026-10 SBI Shinsei first history acquisition slice](2026-10-sbi-shinsei-history-first-slice.md):
  in progress; offline validation and evidence adapters merged, acquisition
  not enabled.

- [2026-10 collection quality completion and scoped acceptance](2026-10-collection-quality-completion.md):
  implemented, merged in #968; production acceptance pending.
