# Collector operational diagnostics

This module emits structured `collector-diagnostic` events, correlated by an internally generated run ID. Stage outcomes describe individual operations; only `stage=terminal` describes the final collection status. A central-import error can follow successful source collection and must not be confused with a provider failure. SMBC Direct additionally emits `collector-retry` with its existing retry decision; logout has its own stage.

Source and stage names, error types and domain error codes use explicit allowlists. HTTP status is retained only from a numeric error property (100–599) or exact known collector error formats. Arbitrary exception messages, names, stacks, URLs, provider bodies, account identifiers and credentials are never copied into diagnostic events. An unknown error remains unknown rather than being guessed from text. Logging and inspection failures must not replace the provider result or exception.

Current integrations: Mobile Suica, MyJCB, SBI Securities, SBI VC Trade, Vpass and SMBC Direct backfill; the API also supports PRESTIA GLOBAL PASS. The API does not alter manifest schemas, storage bodies, retry decisions or collection schedules. Existing source collectors outside this repository are not covered.

Run tests with `bun test poc/collector-diagnostics/test`. Changes to source or stage names should update the allowlist and relevant failure-path tests together.
