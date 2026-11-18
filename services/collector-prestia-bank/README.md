# PRESTIA bank collector

This Worker reads the SMBC Trust Bank PRESTIA account-summary page and stores
it, sanitized, as one `balance.html` artifact in shared DATA. The decision and
its limits are in [ADR 0042](../../docs/adr/0042-prestia-bank-worker.md); the
source notes are in [PRESTIA](../../docs/sources/prestia.md).

## Runtime profile

- **Browser: none.** No Cloudflare Browser Run, Container Chrome/Chromium or
  external browser session is used; `wrangler.jsonc` declares no browser,
  container or Durable Object binding.
- Worker `fetch` posts the mobile login form with the user ID and password,
  reads the balance page and signs off (`src/client.ts`), sending the fixed
  Android WebView User-Agent in `PRESTIA_BANK_USER_AGENT`. That header is not
  a runtime browser. There is no browser-to-`fetch` handoff.
- Execution: entrypoint `src/schedule-entrypoint.ts`, whose
  `ScheduledCollection.runScheduled` accepts only the `prestia-bank` alarm
  job's cron `30 21 * * *`. That job is seeded `enabled: false` in
  [`config/alarm-jobs.json`](../../config/alarm-jobs.json), and the
  [operations API notes](../../docs/ops-api.md) record enabling it as a
  separate, later step. `runOperation` runs an accepted operations request
  the same way; `prestia-bank` is in the Processor's
  `OPS_COLLECTOR_DISPATCH_CONNECTIONS`. Each run holds the `prestia-bank`
  execution lease (`withCollectionLease` in `src/worker.ts`, D1 `SCHEDULE_DB`)
  and writes shared DATA (`kogane-raw-evidence`) with the terminal last
  (`src/storage.ts`). There is no Cron Trigger.
- Retries: the collector never resubmits the password. Its `scheduled`
  handler calls `controller.noRetry()`, but no Cron Trigger invokes it.
- Budgets: `wrangler.jsonc` sets no `limits`; the CPU and subrequest budgets in
  effect are not recorded in the repository.

The Worker serves only `GET /health` (source, schema version and release SHA);
every other path is 404 (`src/worker.ts`).
