# ADR 0116: Reconstruct a scope of up to 20 accounts in one answer, at one cut, never totalled

- Status: proposed
- Date: 2026-11-18
- Issue: [#550](https://github.com/risu729/kogane/issues/550) (state at a date:
  reconstruct balances and holdings from adopted events), the "several accounts
  at once" item that
  [layers 8 + 11](../roadmap.md#layers-8--11--dated-reported-and-reconstructed-state)
  leave open
- Changes: [ADR 0058](0058-knowledge-selector-and-reconstruction-adapter.md)
  (its query and its 2026-10-09 request decision answered one account and
  refused several as `scope_unsupported`); takes up option 2 that
  [ADR 0075](0075-reported-holdings-change-between-dates.md#options-considered)
  deferred
- Carried by: `packages/application/src/query/reconstructed-state.ts`,
  `packages/application/src/query/reconstructed-state-read.ts`,
  `packages/application/src/query/dated-state.ts` (the `accounts` filter),
  `packages/read-model/src/economic-selector.ts` (`ACCOUNTS_SOURCES_SQL`),
  `packages/observation-shared/src/reconstructed-state-contract.ts`,
  `services/app/src/mcp.ts`, `apps/web/src/pages/ReconstructedState.tsx`,
  [reconstructed state](../reconstructed-state.md)

## Context

What the code on main does before this ADR:

- The fold (`reconstructStateWithLate`, ADR 0052) already takes a list of
  accounts: its cells are per (account, unit), it lists each account with
  whether it has a reported container at either end and how many cells it has,
  and it adds nothing across accounts (`netWorth: "not-computed"`). The
  knowledge selector (`loadSelectorRows`, `selectAdopted`, ADR 0058) also takes
  a list. Only the query and the service narrow it to one: `queryReconstructedState`
  takes one `account`, and `readReconstructedState` refuses `accounts`, an
  array under `account` and a repeated `account` parameter as
  `scope_unsupported`.
- A caller who wants several accounts makes several requests. Each one left at
  the default cut resolves "the latest commit" on its own, so a commit landing
  between them gives the accounts different cuts and set versions; nothing ties
  the answers to one moment of knowledge.
- ADR 0075 deferred "reconstruction over several accounts of a selected scope"
  for three reasons: no real account produces a reconstructed figure yet; one
  account costs 1.1–2.0 s at the statement scale and a scope would multiply it;
  and the accounts a scope may name depended on the grant contract.
- The first non-card family the economic plan names is the transfer between
  owned accounts ([ADR 0057](0057-own-transfer-proposals.md)): its two legs sit
  on two accounts, so the fold's own unit of answer is a scope, not an account.

The three deferral reasons, re-read against the code:

1. Still true: no non-card writer is enabled, so a bank account is at best
   `incomplete` and a card account `unavailable`. This ADR does not change
   that; it changes what one request can ask.
2. The cost does not multiply. `queryDatedState` reads the whole store's
   container rows for a date and filters by account in JavaScript, so one read
   per date serves any number of accounts; the selector loads the closure of
   the union of the accounts once; the fold runs once. Measured below.
3. Since [ADR 0084](0084-mcp-operator-authority-without-delegation.md) every
   caller reads with the whole-store grant. The service still refuses a
   narrowed grant (`scope_restricted`) before reading anything, as it did.

## Options considered

1. **Keep one account; callers make one request per account.** Rejected: one
   cut, set version and manifest per account rather than one for the answer,
   and every request repeats the whole-store reads of both dates.
2. **Several accounts, with a status and reasons per account.** Rejected for
   now: the selector's reasons (unlogged revisions, claim and alias conflicts,
   identity changes, inconsistent chains) belong to the loaded closure, which
   is the scope's, not one account's. Splitting them would need a per-account
   selector the fold does not have. The per-account facts that exist are
   already in the answer: each account's containers and cell count, and each
   cell's gaps and explanation.
3. **Several accounts in one query: one cut, one load, one fold, the scope's
   status and reasons, the cells per account.** Chosen.
4. **A total across the scope** (the bounded net worth of #551). Rejected:
   account identity across direct providers and aggregators is unresolved
   ([#545](https://github.com/risu729/kogane/issues/545)), so a total would
   count an account an aggregator mirrors twice (INV06). Nothing is added.

## Decision

1. **Request.** Exactly one of `account` (one id) and `accounts` (a list of 1
   to `RECONSTRUCTION_ACCOUNTS_MAX` = 20 distinct ids, each of the existing id
   pattern). The route takes `account` repeated 1 to 20 times; once is
   `account`, more is `accounts`, in the order given. Refusals, each one closed
   code:
   - more than 20 ids: `too_many_accounts` (400, `invalid_query` category,
     ref `maxAccounts:20`), new;
   - an empty list, a malformed id, an id twice, a list under `account`:
     `invalid_account` (ref `accounts` or `account`);
   - both keys: `invalid_query`;
   - an id with no `accounts` row: `unknown_account` (404), naming the key,
     never the id, checked for the whole list in one statement;
   - `instrument` and `instruments` stay `scope_unsupported`.

   Twenty keeps the page's tables and the route's query string readable; the
   bounds that matter are the selector's and the fold's, which are unchanged
   and refuse the whole scope past them, never a part of it.

2. **Query.** The accounts are sorted, so the order asked in never changes the
   answer. One cut is resolved; one selector load reads the closure of every
   scope account (supersession and claim holders, as for one account); each end
   date is read once with `queryDatedState(..., { accounts })`; one statement
   (`ACCOUNTS_SOURCES_SQL`, replacing the one-account `ACCOUNT_SOURCES_SQL`)
   reads every account's mapped sources with one pass over the mapping table;
   and one fold takes every account. Each account's reported balances, its
   container check and its cells are what its one-account answer has.
3. **The dated read's `accounts` filter** is internal (no route or tool takes
   it). It keeps the rows whose resolved account is in the list, and lists a
   provider account once per resolved account its rows map to, so no
   account's rows are listed under another. A one-account list answers what
   `account` answers, context id included.
4. **Status and reasons are the scope's**: the union of every account's
   reasons under the existing precedence. `no_reported_container` is listed
   when any account has no reported container (the scope is `unavailable`, the
   fold is still computed and shown, and `reconstruction.accounts` says which
   account it is); `nothing_to_reconstruct` when any account has no cell. For
   one account both read as before.
5. **Late part.** One baseline, at the end capture's instant, when every end
   balance of the scope comes from captures of one instant; otherwise
   `end_captures_differ`, as for one account whose balances differ. The
   one-account read gives each account's own late part.
6. **Answer.** `reconstructed-state-query-v2`: `accounts` (sorted) replaces
   `account` in the answer and in the outer manifest; nothing else changes
   shape. The wire contract requires the list sorted, unique, 1 to 20 long,
   and the same in the answer, the fold's `accounts` and the manifest.
7. **One service, both transports (ADR 0081).** The route and the existing
   tool `kogane.reconstructed-state.read` call `readReconstructedState`. The
   tool's closed input schema gains `accounts` (array, 1 to 20 unique ids) and
   requires only `from` and `to`; its description says to give exactly one of
   the two keys, since a root `oneOf` is refused by MCP clients
   (`mcp-input-schema.ts`). No tool, route, catalogue operation or capability
   is added; the parity guard's mapping of the route to the tool is unchanged.
8. **Page.** `残高の再構成` takes several ids in its 口座 ID field, separated by
   spaces or commas (checked before sending: at most 20, none twice). With
   several accounts it adds an account column to the cell and disposition
   tables and a `口座ごとの状況` panel (reported container at each end, cell
   count, family coverage), and says that the status and reasons are the
   scope's. Nothing is totalled; a one-account answer looks as before.

## Consequences

- One answer pins one cut, one set version and one manifest for every account
  it shows, and costs one load and one fold rather than one per account.
- Every one-account answer's context id changes once, with the schema; its
  figures, status and reasons do not.
- A selector reason marks the whole scope; the caller narrows the scope (or
  asks one account) to see which account it concerns.
- A scope whose accounts were captured at different instants has no late part;
  each account's own read still has one.
- A scope whose union passes a bound is refused as a whole, even when a subset
  would fit.
- Still open: positions are not folded (no securities writer), no producer
  declares coverage, so no account is `complete`, and nothing is totalled
  (#551).

## Verification

Synthetic data only; no production data, D1 or Workers deployment.

- `packages/application/test/reconstructed-state-query.test.ts`: two accounts
  at two providers give, per account, the cells their one-account answers
  give; the order asked in changes nothing; a card account in the scope makes
  it `unavailable` while the bank account is still folded; end captures at
  different instants leave no late part; a scope of three accounts runs every
  dated read twice and the sources read once, as one account does; an empty,
  repeated or 21-account scope is refused.
- `packages/application/test/dated-state-query.test.ts`: the `accounts`
  filter lists each account as its one-account read does, a provider account
  mapped to two scope accounts twice, and a one-account list exactly as
  `account`.
- `packages/application/test/reconstructed-state-read.test.ts`: the route's
  repeated `account` and the body's `accounts` give one answer; every new
  refusal and its ref, decided before the store is read.
- `packages/application/test/reconstructed-state-scale.test.ts`: on the
  statement store without table statistics, a scope of every mapped account
  runs each statement no more often than one account does and scans nothing a
  one-account read does not, except the settlement-review read's own key list,
  which a card statement in the scope adds (accepted by
  `dated-state-scale.test.ts`). At `STATEMENT_CI_SCALE` (150 settlements, two
  revisions each) one account and the scope of six mapped accounts each took
  about 0.14 s on `bun:sqlite` locally (median of three, not asserted). At
  `STATEMENT_SCALE` (1,500 settlements, three revisions each) the scope of
  seven mapped accounts is refused (`result_limit_exceeded`, ref
  `events:>2000`): one card account's purchases pass the selector's bound
  alone, and that account is refused alone too, while the other six answer
  alone (one run, printed, not asserted). Not measured on workerd or remote
  D1.
- `packages/read-model/test/economic-selector.test.ts`: `ACCOUNTS_SOURCES_SQL`
  scans the mapping table once for a list, and answers, per account, what the
  frozen one-account text answered.
- `services/app/test/reconstructed-state-api.test.ts`: over the Worker, the
  route with `account` repeated and the MCP tool with `accounts` give the same
  answer; the new refusals; `agent-api.test.ts` pins the tool's input schema.
- Rewrite proofs added by the independent review (AGENTS.md, toolchain):
  `ACCOUNTS_SOURCES_SQL` equals the frozen one-account text per account on 40
  random mapping tables and two scaled ones (2,000 and 4,000 source accounts,
  up to three mapping revisions each, scopes of up to 20 with an unmapped id);
  the one-statement account check (`RECONSTRUCTED_STATE_ACCOUNTS_SQL`) counts
  what the frozen `SELECT 1 … WHERE id=?1` finds for random lists over 3, 40
  and 5,000 accounts, and searches `accounts` by primary key without table
  statistics; the dated read's `accounts` filter equals the `account` read for
  a one-account list and lists each account's rows and payables as its own
  read does, on 100 random stores and on the statement scale store for every
  mapped account. On 60 random stores with economic history, each account's
  cells in a scope are its one-account cells, except `lateRecorded`, which is
  null when the scope has no late part (decision 5), and the scope's reasons
  hold every account's. A one-off differential against `main` (`ae2708b`) on
  200 random stores (687 one-account answers) found every field equal except
  the context id, the schema version and `account` → `accounts`.
- `apps/web/test/reconstructed-state-contract.test.ts`,
  `reconstruction-form.test.ts` and `reconstructed-state.browser.test.ts`: the
  scope rules of the wire contract, the field's parsing and checks, and the
  page with two accounts (columns, panel, no total, accessibility audit).
