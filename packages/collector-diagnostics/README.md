# Collector operational diagnostics

This module emits structured `collector-diagnostic` events, correlated by an internally generated run ID. Stage outcomes describe individual operations; only `stage=terminal` describes the final collection status. A central-import error can follow successful source collection and must not be confused with a provider failure. SMBC Direct additionally emits `collector-retry` with its existing retry decision; logout has its own stage.

Source and stage names, error types and domain error codes use explicit allowlists. HTTP status is retained only from a numeric error property (100–599) or exact known collector error formats. Arbitrary exception messages, names, stacks, URLs, provider bodies, account identifiers and credentials are never copied into diagnostic events. An unknown error remains unknown rather than being guessed from text. Logging and inspection failures must not replace the provider result or exception.

## Public API

`@kogane/collector-diagnostics` exports exactly two entry points from `src/index.ts`, and the package manifest's `exports` map publishes only that module:

| export                             | purpose                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `createDiagnostics(source, runId)` | The per-run emitter: `stage(...)`, `terminal(...)` and the retry event, with the source and run ID fixed for the whole run. |
| `safeErrorDetails(error)`          | Reduces an unknown thrown value to the allowlisted error type, domain error code and HTTP status, and to nothing else.      |

`SafeErrorDetails` is exported as a type for callers that store the result. Everything else in `src/index.ts` — the source, stage, error-type and error-code allowlists — is deliberately internal: adding a source or a stage is an edit here plus a failure-path test, not a consumer-side string.

## Consumers

Every consumer is a collector Worker; nothing in `services/app`, `services/processor` or `apps/` uses it.

| consumer                            | uses                                    |
| ----------------------------------- | --------------------------------------- |
| `services/collector-globalpass`     | `createDiagnostics`, `safeErrorDetails` |
| `services/collector-mobile-suica`   | `createDiagnostics`, `safeErrorDetails` |
| `services/collector-myjcb`          | `createDiagnostics`, `safeErrorDetails` |
| `services/collector-sbi-securities` | `createDiagnostics`, `safeErrorDetails` |
| `services/collector-sbi-vc-trade`   | `createDiagnostics`                     |
| `services/collector-smbc-direct`    | `createDiagnostics`                     |
| `services/collector-vpass`          | `createDiagnostics`, `safeErrorDetails` |

The API also supports PRESTIA GLOBAL PASS stages that the GLOBAL PASS Worker does not emit yet. Collectors outside this repository are not covered.

## Boundaries

The API does not alter manifest schemas, storage bodies, retry decisions or collection schedules. Changes to source or stage names update the allowlist and the relevant failure-path tests together.

```sh
mise run ci:collector-diagnostics
```
