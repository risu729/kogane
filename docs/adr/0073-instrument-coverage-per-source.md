# ADR 0073: Count each source's instrument identifiers by their candidate state, in a read beside the account coverage

- Status: proposed (until this PR merges)
- Date: 2026-11-06
- Related: [roadmap, phases 0–5](../roadmap.md#phases-05--coverage-and-cross-source-identity),
  [ADR 0055](0055-instrument-candidates.md) (the candidate read and its
  identifier states), [identity](../identity.md),
  [identity operations](../identity-operations.md)

## Context

The roadmap's phases 0–5 are done when a user can "distinguish resolved
accounts/instruments from unresolved ones for the selected scope".
`GET /api/identity/coverage` and the `整理状況` table on `/identities` serve
half of it: per source, the eligible Layer B observations, how many have a
current Layer C interpretation, and the status of each one's account mapping.
Nothing per source said how many instruments a source's records name, or
which of them a person has resolved.

What "resolved" means for an instrument already exists. ADR 0055 §9 gives
every security, crypto and product identifier that a current published
identity observation uses one state: `unresolved-candidates` (a proposed
candidate waits), `resolved-by-decision` (it shares its instrument and a
manual mapping made that so), `shared-without-decision`, `kept-separate`
(every candidate rejected) or `no-candidate`. The state is computed from the
current mapping revisions and the newest `listed_as` relation, so a later
correction replaces an earlier adoption without either being rewritten. The
candidate page shows it per identifier; no read counts it per source.

The state is a property of the whole store: an identifier at one source is
`unresolved-candidates` because of an identifier at another. It is only
known after the candidate read has walked every current identity
observation, which ADR 0055's amendment measured (about 0.8 to 0.95 s per
100,000 observations on workerd) and bounds (refused above 500,000).

## Options considered

1. **Count mapping statuses of instrument uses in the coverage SQL**, as the
   account columns do (`identified`, `provider-local`, …). Rejected: no
   identity rule writes anything but `provider-local` for a security, so
   every count would be in one column, and a mapping status says nothing
   about whether a person adopted or rejected a candidate. It would look like
   a resolution count without being one.
2. **Add instrument columns to `GET /api/identity/coverage`.** Rejected: the
   coverage rows are computed by one SQL query over the Layer B denominator
   and honour `identityRead=as-recorded`; the states are computed in the
   application from the whole store's current mappings only. One response
   would mix two interpretations, a refusal of the candidate read would fail
   the account coverage with it, and the account counts would wait for the
   slower walk.
3. **A new SQL query that derives the states per source.** Rejected: it would
   restate ADR 0055's evidence, conflict, status and state rules in SQL (a
   second answer to one question), and need its own equality proof and plan
   checks.
4. **A sibling read that runs the existing candidate read and counts its
   identifier states per source.** Chosen.

## Decision

1. **Service.** `readInstrumentCoverage({ grant, sql, source })`
   (`packages/application/src/query/instrument-coverage.ts`) runs
   `queryInstrumentResolution` unchanged and counts, for each source that
   uses at least one in-scope identifier, its distinct identifiers and how
   many are in each of the five ADR 0055 states. An identifier used by two
   sources is counted under each, so the rows have no total and none is
   given. A source whose current organized records use no security, crypto
   or product identifier has no row, which is not a row of zeros.
2. **Grant and bounds.** The capability is `summary.read`, not the
   candidate review's `records.read`, because the answer is counts and names
   no identifier record; the perimeter is the candidate review's: the whole
   store, refused before anything is read otherwise (`unauthorized` /
   `evidence_restricted`), because the counts depend on sources a listed
   grant could not see. As first decided no agent tool served it, so only the
   browser's `readerGrant` (which holds both capabilities) reached it; the
   [2026-11-06 amendment](#amendment-2026-11-06-the-agent-read-on-both-agent-paths)
   adds the agent read under the same rule. The observation count is
   checked first and the read's own bounds refuse the whole answer
   (`budget_exceeded` with `budget:identityObservations=500000` or
   `budget:instrumentResolution`), never a part or zeros.
3. **Answer** `kogane-instrument-coverage-v1`: `policy`
   (`instrument-candidates-v1`), `query.source` (or null) and `rows` of
   `{ source, identifiers, states }`, sorted by source, where `states` has
   exactly the five state keys and adds up to `identifiers`. No identifier,
   label, amount or rate is in it.
4. **Route.** `GET /api/identity/instrument-coverage?source=`
   (`services/app/src/instrument-coverage-api.ts`), registered ahead of the
   identity catalogue, behind Access, under `readerGrant`, GET and HEAD only.
   `source` is the only parameter, with the identity catalogue's limits; any
   other, a repeated one or a malformed value is `400 invalid_query`. A
   filter by a source with no row answers no rows.
5. **Wire check.** `validInstrumentCoverage`
   (`packages/observation-shared/src/instrument-coverage-contract.ts`), used
   by `validApiResponse`: the schema version and policy, one sorted row per
   source, only the filtered source under a filter, the closed state keys,
   non-negative integers, at least one identifier, and states adding up to
   the identifier count.
6. **Page.** `/identities` shows `銘柄の整理状況` as its own panel under
   `整理状況`: per source, `識別子` and one column per state in the candidate
   page's own words (`未判断の候補あり`, `判断により同じ銘柄`,
   `判断の記録なしで同じ銘柄（要確認）`, `別の銘柄と判断済み`, `候補なし`).
   It is its own query, so a refusal is shown as the reason in that panel
   while the account coverage still renders; a refusal is not retried.
   The table scrolls in a region named `取得元ごとの銘柄の識別子`, so no
   two landmarks on the page share a name, and a failed read is titled
   `銘柄の整理状況を読み込めませんでした`, apart from the account
   coverage's `整理状況を読み込めませんでした`.

No migration, index, SQL text or agent tool is added; the existing coverage
response and its contract are unchanged. (The agent tool is added by the
[2026-11-06 amendment](#amendment-2026-11-06-the-agent-read-on-both-agent-paths).)

## Consequences

- The roadmap's "distinguish resolved … instruments from unresolved ones for
  the selected scope" is served per source for securities, crypto and
  products. Money and reward units are not counted: ADR 0055 does not pair
  them, so they have no resolution state.
- Every load of `/identities` now runs the candidate walk once, and again
  whenever the client refetches (it refetches on mount and window focus, as
  for every read), as the candidate page already does. The
  account coverage query already walks every eligible Layer B observation,
  so the page's cost stays linear in captured history; the walk's own figures
  and bound are ADR 0055's, and remote D1 remains unmeasured.
- Old and new clients: the App Worker serves the web assets, so both deploy
  together. A client older than the route never asks for it; a client newer
  than the Worker (a deploy in progress) gets 404 in that panel only.
- Counts are counts of identifiers, not of instruments or holdings. Two
  identifiers adopted onto one instrument are two `resolved-by-decision`
  identifiers. Nothing here is a match rate.

## Verification

Synthetic data only, no production access:

- `packages/application/test/instrument-coverage.test.ts`, over CORE
  migrations with identifiers written by the production identity writer
  and decisions through the change lifecycle: an empty store has no row; an
  unresolved-only store counts its two identifiers as
  `unresolved-candidates`; mixed sources (SBI Securities and a synthetic
  second broker) count each source and agree state by state with the
  candidate read; a source filter and an unknown source; an adoption counts
  both identifiers `resolved-by-decision`, a later manual correction (a
  third mapping revision, the adoption kept in history) counts them
  `unresolved-candidates` again, and a rejection counts them
  `kept-separate`; an identifier two sources use counts under each; the
  capability, perimeter and malformed-source refusals before any read; the
  observation bound and the read bound refused whole; every answer passes
  the wire check; nothing is written.
- `packages/observation-shared/test/instrument-coverage-contract.test.ts`:
  the wire check accepts the shape and refuses counts that do not add up,
  unknown or missing states, unsorted or repeated sources, a foreign source
  under a filter and too many rows.
- `services/app/test/instrument-coverage-api.test.ts`: the route over the
  real Worker and CORE migrations (counts, filter, Access, GET/HEAD only,
  parameter refusals, nothing written).
- `apps/web/test/identity-coverage.browser.test.ts`: Chromium against the
  production build at 1280 and 390 px (the state columns and counts, no
  total, no page-wide horizontal scroll), the source filter, and a refusal
  shown as its reason with no table while the account coverage renders.
- `experiments/observation-pipeline-local/test/identity-browser.test.ts`:
  its synthetic server answers the route in the wire shape, so the panel
  renders counts while only the account list fails (401, 403); when every
  identity read is blocked, stalled or offline, the page shows four
  distinct errors and four retry buttons, one per read.
- `mise run //packages/application:ci`, `//packages/observation-shared:ci`,
  `//services/app:ci`, `//apps/web:ci`,
  `//experiments/observation-pipeline-local:ci`, `mise run ci:root`.

## Amendment 2026-11-06: the agent read on both agent paths

- Status: proposed (until its PR merges)
- Date: 2026-11-06
- Carried by: the `kogane.instruments.coverage` case and schema of
  `services/app/src/read-tools.ts`, its `toolRows` case in
  `services/app/src/audit.ts`, and the `instruments.coverage` entry of
  `packages/application/src/operation-path/catalogue.ts`

### Context

The service above was reachable from the browser only. An agent asking how
much of a source's instrument history a person has resolved had no read of
it: `kogane.instruments.candidates` pages the candidates themselves under
`records.read`, and counting its pages would restate the counts this service
already computes.

### Options considered

1. **No agent read**, leaving the counts to the page. Rejected: the counts
   are the per-source answer of the roadmap's phases 0–5, and an agent would
   have to rebuild them from candidate pages, a second computation of one
   answer.
2. **A coverage intent of `kogane.financial.query`.** Rejected: that query
   honours listed source scopes and its own read model, while this service is
   whole-store or nothing; one tool would carry two perimeter rules.
3. **A read tool beside `kogane.instruments.history`** that calls
   `readInstrumentCoverage` unchanged under the caller's grant. Chosen.

### Decision

1. **Tool and path.** `kogane.instruments.coverage`, served on `/mcp`
   (`tools/call`) and on `POST /api/agent/v1/instruments.coverage`, by one
   implementation (`callReadTool`), the agent path being the tool name
   without `kogane.` as for every agent tool. Its input is a closed object
   with one optional key, `source` (1 to 128 characters, no control
   character: the route's limits). An unknown key or a malformed value is
   `400 invalid_request` before the service runs, on both transports.
2. **Grant.** The service's own rule, applied to the caller's grant (not the
   reader grant): `summary.read`, else `403 unauthorized`
   (`capability:summary.read`); sources and accounts both `"*"`, else
   `403 evidence_restricted` (`scope:source`, `scope:account`); both decided
   before the store is read. Over MCP the refusal is the same body with
   `isError: true`. This is the whole-store-only rule ADR 0063 (decision 10)
   sets for every new read tool, which calls the route's own reader.
3. **Listing.** `tools/list` lists it only to a grant that holds
   `summary.read` over the whole store (`readMcpTools`), as the history tool
   is listed only to `records.read` over the whole store. A grant it is not
   listed to that calls it anyway is refused as in 2, not told the tool is
   unknown.
4. **Answer.** The service's `kogane-instrument-coverage-v1` unchanged, equal
   to the browser route's answer for the same `source`; the bounds and their
   `budget_exceeded` refusals are the service's.
5. **Audit.** One record per call (ADR 0064) under the operation
   `instruments.coverage`: risk R0, result `read`, with the number of source
   rows the answer carried (`toolRows`) and `truncated: false`, never a
   source, a count or an identifier; a refusal records its closed code.

### Consequences

- The committed `AGENT_API_GRANTS` names one MCP reader with `summary.read`
  and `records.read` over `"*"` sources and accounts, so by configuration
  `tools/list` lists this tool to that client. That is a configuration fact,
  not evidence that a client listed or called it.
- Each call runs the candidate walk once, as a page load does; the cost and
  bounds are ADR 0055's. Routine polling would need a written bound first, as
  for `kogane.instruments.candidates`.
- It reads and never writes; the audit record is its only write.

### Verification

Synthetic data only, no production access:

- `services/app/test/instrument-coverage-api.test.ts`, over the real Worker,
  CORE migrations and the production identity writer: listed to whole-store
  `summary.read` (alone and with `records.read`) and to no grant without it
  or with a listed source or account axis; the published schema closed with
  the one optional key; HTTP, MCP and the browser route answer equal bodies
  for no filter, a source filter and an unknown source; the capability,
  source-scope and account-scope refusals and the input refusals equal over
  both transports; no provider text in an answer; one R0 `read` record per
  served call with its row count, a refusal under its code, and no source or
  provider text in a record; nothing but audit records written.
- `services/app/test/agent-api.test.ts` and `mcp-client.test.ts`: the pinned
  tool lists and schema snapshot under each grant shape include the tool
  exactly where the grant holds whole-store `summary.read`.
- `mise run //packages/application:ci`, `//services/app:ci`,
  `mise run ci:root`.
