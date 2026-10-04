# Implementation and rollout notes through 2026-10-04

Type: historical repository assessment, extracted from the roadmap.
Recorded through: 2026-10-04.

These paragraphs retain the assessment and dated production observations as
written at that time. Present-tense claims below describe that snapshot; they
are not current instructions, current counts or a fresh production check.
Use [current status](../current-status.md), [roadmap](../roadmap.md) and
[rollout controls](../rollout.md) for the maintained references.

Concrete limits in the current code:

- **Shared-R2 registration, 2026-09-12 onwards.** From U09 (#184) until the
  fixes below, no shared-R2 run of any source but Mizuho was catalogued into
  sealed, parseable evidence. Four blockers were found on 2026-09-26: the
  producer a collector names differs from its route's for eight terminal
  sources (fixed by #259, [ADR 0014](../adr/0014-collector-producer-ids.md)); derived artifacts without stated
  lineage (`artifact_lineage_unstated`: sbi-securities, sbi-shinsei, MyJCB,
  V Point, V Point Pay) and run manifests that named a unit without being
  counted in it (`run_inventory_incomplete` at the seal: sbi-vc-trade, GLOBAL
  PASS, SMBC Direct), both fixed in the collectors by
  [ADR 0021](../adr/0021-collector-registration-contract.md), which also fixed
  Vpass statement pages (a provider role with a `redacted` step, refused at
  the seal) and V Point Pay month ranges; and registered artifacts with no
  `dataset` (fixed by #269, [ADR 0022](../adr/0022-registration-artifact-datasets.md),
  for the datasets a registered parser reads). Only terminals written after each
  collector's redeploy carry the fixed shapes. The terminals written before
  it are immutable: the 14 sbi-securities and 14 sbi-shinsei runs blocked
  since U09 (counted on 2026-09-26) stay blocked (a block is write-once), and
  re-registering them under a new registration contract version refuses the
  same bytes again: nothing makes them registrable. The 14 sbi-vc-trade runs
  observed at that time had catalogued but unsealed artifacts. The Processor
  now classifies known permanent seal-trigger refusals as a recorded block,
  retaining the unsealed run reference; unrelated errors remain retryable.
  Repeated scans can answer the recorded verdict rather than retry the same
  immutable terminal under the same registration contract
  ([processor §3](../processor.md#3-idempotency-and-what-blocks),
  [seal refusal handling](../../packages/application/src/collection/register-terminal.ts)).
  This describes the implemented handling, not a new count of historic blocks.

- [Card settlement review](../card-settlements.md) now connects authoritative
  Vpass/MyJCB statement totals to SMBC and SBI Shinsei bank debits
  ([bank adapters](../card-settlements.md#bank-adapters)) through explicit
  operator decisions. Unknown ownership, stale evidence and occupied
  allocations block acceptance. The production investigation recorded in
  [ADR 0028](../adr/0028-sbi-shinsei-observed-capture-shapes.md) found no published
  SBI Shinsei transactions at that time: 0.1.1 rejected the stored activity
  captures because the provider leaves the window's end empty. Version 0.1.2
  accepts that shape and records the end as not stated. Admission requires
  those captures to be successfully re-parsed and published after deploy;
  the current production publication count has not been re-measured here.
  The SBI Shinsei exchange-rate board is parsed from 1.0.2
  (1.0.1 assumed digits where the stored time ends in two letters and matched
  no board; migration 0059), every `customerCategory` tier kept. A board
  row of the 13 currencies the provider's public pages quote per 1 unit is
  promoted only in the stage category the same run's balance summary states
  ([ADR 0031](../adr/0031-sbi-shinsei-stage-category-fx-tier.md); the two were
  observed on 2026-09-27 to use one scheme). A board waits while its run's
  balance-summary parse can still run, and promotes nothing when that page is
  missing, refused or its job failed. A
  debit posted more than three days from the
  due date gets no candidate. Banks whose row ids are fingerprints (Mizuho,
  Sony Bank), partial payments, refunds and complete purchase recognition
  remain extensions; this is not complete event coverage. Which bank account
  a card debits is not configured anywhere: MyJCB's own statement of it (the
  「カード情報」 table: bank name, branch name, 科目 and the first four account
  digits) is read from stored pages into `card_debit_account_statement` and
  attached to MyJCB candidates as proposal-only evidence
  ([ADR 0032](../adr/0032-provider-stated-debit-accounts.md), 2026-09-27
  amendment). [ADR 0034](../adr/0034-card-settlement-automation-prerequisites.md)
  adds authenticated request context to new SMBC normalized artifacts; parser
  1.1.0 retains it without changing the legacy source-account identifier.
  Debit-account policy v3 can compare a candidate only using that debit's own
  published context. Old captures cannot acquire missing digits from a newer
  balance or another run, and agreement remains proposal-only evidence, not
  ownership or acceptance. Remaining rollout requires a new authenticated
  capture, verified retained context and effective account/ownership scope.
  The pure automation evaluator and aggregate shadow command are implemented;
  the production acceptance adapter/lane is not connected. Limits: the
  evidence is not shown on the review page yet; branch names are not compared;
  SBI Shinsei's identifier layout remains unverified; Mizuho is comparable but
  not an adapter; and the observed Vpass statement API supplies no debit
  account, so Vpass candidates keep amount and date only.
- Vpass and MyJCB pending-to-posted candidates come from the purchase lane's
  [candidate pass](../economic-events.md#pending-to-posted-links), which pairs one
  recognised pending event with one posted event per purchase; every pair
  stays a candidate for review. Only a posted row dated on its pending row's
  usage day or up to five days after it is proposed
  ([matching window](../economic-events.md#matching-stages)), and an installment
  payment amount is never compared with a purchase amount. A row the purchase
  lane does not recognise (an unsupported payment type, an amount that is not
  exact, an unresolved account) gets no candidate, a MyJCB pending and
  confirmed row whose usage days straddle a month end are not paired, and a
  refund is never paired with a purchase.
  [The reconciliation job](../../services/processor/src/reconciliation-job.ts)
  runs stage A only for both sources since 2026-09-26: its stage B read every
  published capture, proposed one candidate per capture pair and skipped every
  statement month with more than 200 published rows
  ([where stage B runs](../economic-events.md#matching-stages)). Stage A needs a
  provider-issued row id, which the deployed parsers do not supply. Its page
  query now starts from an index of stored provider-origin identifiers, so an
  empty eligible set does not scan every fingerprint row. Historical, custom
  and future provider-origin evidence still runs through the same matcher;
  stage B remains unchanged ([ADR 0037](../adr/0037-reconciliation-purchase-cost.md)).
  The collector records a
  confirmed MyJCB page by the payment month the page names, so a statement
  keeps its rows' keys while its position moves
  ([release note](../observations.md#myjcb-statements-keep-their-identity-when-their-position-moves-collector-no-parser-release));
  pending pages keep the relative `detailMonth-N`, resolved from their
  capture time
  ([`relative-statement-period-v1`](../observations.md#relative-period-labels-are-resolved-from-the-capture-time)).
  Limits: a confirmed capture stored under `detailMonth-2` or later (only
  before that fix) names no statement and is never current; the collector
  stops (`credit-statement-period`) on a confirmed page that names no month;
  a pending row and its posted row are still two keys, paired by review; and
  a pending statement's rows get new keys once when it moves from position 0
  to position 1. When both positions are unconfirmed (a closed cycle not yet
  confirmed), both pending statements are current, one slot each
  ([ADR 0016](../adr/0016-myjcb-pending-statement-slots.md)).
- [Card purchase recognition](../economic-events.md#card-purchase-recognition)
  turns adopted Vpass/MyJCB single-payment rows with an exact JPY amount and a
  trusted card identity into `purchase` and `refund` events, behind
  `PURCHASE_RECOGNITION_ENABLED` (on in production since 2026-09-24; existing
  rows are worked through in bounded five-minute ticks: at most 100 events
  retired and at most 200 guarded recognition writes, so at most 300 event
  mutations per tick, plus the candidate pass's one proposal batch and at most
  20 provider-linked merges). An unchanged-input proof can skip the retirement
  query after an empty result; input or recognition changes invalidate it,
  and nonempty, failed or deferred work remains eligible for another attempt.
  Recognition and candidate processing still run
  ([ADR 0037](../adr/0037-reconciliation-purchase-cost.md)).
  Installment, revolving and bonus rows, amountless
  rows and rows without a stable card identity are excluded, and so is every
  Vpass web payment-type code but `1` until an installment row shows what the
  others mean, and every Vpass customized `bunkatsuYaku` but `0` (the only
  value observed, a single payment on the owner's confirmation) until another
  value is observed and confirmed
  ([single payment, per source](../economic-events.md#single-payment-per-source)).
  A pending row and its posted row can now be
  [linked as one purchase](../economic-events.md#pending-to-posted-links) by a
  reviewed decision (or by the rule for a pair the provider itself links, which
  no deployed source does yet); candidates are proposed, never merged by
  amount and date. Excluding a row by decision and allocating a refund to a
  purchase are not available yet. The Vpass collector writes a trusted card
  binding with no secret: the token is the unkeyed `vpass-card-v2-` digest of
  the card tuple ([ADR 0029](../adr/0029-data-classification-and-unkeyed-identity.md);
  the owner no longer sets a `VPASS_CARD_BINDING_KEY`, which is removed). It
  binds only if the provider's responses still carry the card tuple, which has
  not been observed since the importer was retired; without one, a parsed
  collector capture would retire the importer-era purchases of its card-month
  and its rows would be skipped as `account_not_resolved`. A card's v2 token
  is never its importer-era v1 token, so the two are different account
  entities unless the one-time identity-value rewrite (below) replaced the v1
  token. The collector's statement
  pages are registered without a parser dataset, so none is parsed today;
  releasing them is a later change, made once the v1 and v2 entities of each
  card are decided
  ([ADR 0023](../adr/0023-vpass-collector-card-binding.md#amendment-option-3-implemented)).
- Money Forward ME collector runs derive their account identity with no
  secret: the unit key is the unkeyed `moneyforward-account-v2-` digest of
  the account/service tuple
  ([ADR 0029](../adr/0029-data-classification-and-unkeyed-identity.md); the owner
  no longer sets a `MONEYFORWARD_ACCOUNT_IDENTITY_KEY`, which is removed). A
  run whose detail pages lack the tuple keeps positional units and every
  account page is `parser_rejected`, as all 52 account pages of the first
  shared-R2 run were before ADR 0027. The importer's v1 identities are never
  equal to the collector's v2 identities, so every collector account is a new
  source account and account entity, and the months both producers captured
  are listed under two source accounts in the transactions read unless the
  one-time identity-value rewrite (below) replaced the v1 identity. Whether
  the provider's detail pages still carry the tuple has not been observed since the importer was retired
  ([ADR 0027](../adr/0027-moneyforward-collector-account-identity.md)).
- A Vpass card or MoneyForward account whose collector value differs from the
  importer's is a second account entity unless the one-time identity-value
  rewrite replaced the importer's `v1` value by the collector's `v2` value in
  the stored rows
  ([ADR 0030's amendment](../adr/0030-identity-crosswalk.md#amendment-2026-09-28-a-one-time-identity-value-rewrite-replaces-the-crosswalk),
  which retired the crosswalk command). Migration 0062 stages the pairs:
  the MoneyForward pairs whose current transaction rows overlap one-to-one,
  and the Vpass pairs the owner inserts
  ([identity operations](../identity-operations.md#one-time-identity-value-rewrite)).
  Migration 0063 rewrites the staged values in the importer's rows, points
  each collector source account of a staged value at the importer-era
  entity and drops the stage; the identity store finds a source account by
  its natural key, so later captures and re-identifications of a rewritten
  value stay on that entity. The owner reported 4 MoneyForward and 6 Vpass
  staged pairs and 0 held mappings before 0063 (counts only); whether 0063
  has applied in production, and the counts after it, have not been read
  here. A card or account that is not staged stays split.
- Vpass, MyJCB, Sony Bank, Money Forward ME, V Point (and its V Point Pay
  email route), V Point Pay and GLOBAL PASS had no registered collector run
  between 2026-09-12 and the release that carries
  [ADR 0014](../adr/0014-collector-producer-ids.md): their collectors named a
  producer no route declares, so every terminal was refused as
  `inactive_ingest_route`. Terminals written before that release keep the old
  producer and stay unregistered in R2; for the snapshot sources the next
  capture shows the provider's state again, but V Point Pay notification
  emails of that period are registered only if a later decision registers
  those runs. The `collection_scan` walk no longer stops at a page of such
  terminals: it answers them from their recorded refusal and retries each at
  most once a day, where the refusal repeats
  ([ADR 0014, registration](../adr/0014-collector-producer-ids.md#consequences),
  [ADR 0024](../adr/0024-collection-scan-judged-terminals.md)).
  Past the route check, registration still stopped for three of them — a
  Vpass run's seal was refused (`run_inventory_incomplete`, a statement page
  was a `provider_response` with a `redacted` step), and MyJCB and V Point
  runs were blocked `artifact_lineage_unstated` — until the collectors
  changed with [ADR 0021](../adr/0021-collector-registration-contract.md), for
  terminals written after that release. Those register with the parser
  datasets of [ADR 0022](../adr/0022-registration-artifact-datasets.md), except
  that Vpass statement pages are withheld from one and MyJCB's runs written
  before [ADR 0026](../adr/0026-collector-unit-coverage.md) are not eligible for
  parsing (below), so for Vpass, and for MyJCB until its first run after ADR
  0026, the importer's captures stay current
  ([ADR 0014, merge safety](../adr/0014-collector-producer-ids.md#merge-safety)).
  Terminals written before ADR 0021 (collector-vpass, and the sbi-vc-trade,
  GLOBAL PASS and SMBC Direct runs whose units miscount their artifacts) are
  still refused at the seal. They used to throw and be attempted again on
  every walk; since the
  [ADR 0024 amendment](../adr/0024-collection-scan-judged-terminals.md#amendment-2026-09-26-a-seal-core-refuses-is-a-verdict)
  each is blocked `run_inventory_incomplete` once, its fetch run stays
  unsealed and is named by the blocked stage, and the walk answers it from
  its row. Those terminals never register. Two limits remain: a row of an
  earlier contract version whose seal was refused before the amendment keeps
  no verdict (that version is never worked again), and the refusal is
  recognised by the D1 message Miniflare produces; production D1's message
  for it has not been observed, and another shape is rethrown and retried
  every walk as before.
  Once collector-vpass runs register and are parsed, the importer's Vpass
  purchase events of every re-captured card-month are retired and recognised
  again once, on the same account, where the collector's run carries a card
  binding, and not recognised again where it does not (ADR 0023). What a
  collector's successful unit declares decides whether its run registers as
  `success` or `partial`, and identity reads no partial run. The Vpass card
  unit is `complete` only when every month's captured rows equal the total
  the provider states for it, otherwise `partial` with a closed code, so a
  card binds only from such a run (ADR 0023); whether production finalized
  pages state that total has not been observed. The other collectors' units
  are ADR 0026's.
- Shared-R2 registration gives an artifact the parser dataset it needs since
  2026-09-26 ([ADR 0022](../adr/0022-registration-artifact-datasets.md); before,
  every registered artifact had none, so only Mizuho's were parsed). The
  registration contract moved to `terminal-registration-v2`: runs sealed
  without a dataset (Mobile Suica since 2026-09-12) register again and are
  parsed once, while a run v2 does not change (Mizuho) is carried over rather
  than parsed a second time. Old terminals are reached only by the scan walk,
  so they drain as the scan cycles through `runs/`. Blocked runs are tried
  once more and block again where their terminal itself is refused. Vpass
  captures are withheld (above). MyJCB's metadata extractor reads the
  collector's shared manifest ([ADR 0025](../adr/0025-myjcb-shared-manifest-metadata.md)).
  A MyJCB terminal written before [ADR 0026](../adr/0026-collector-unit-coverage.md)
  is never parsed: it reports every unit's coverage as `partial`,
  registration turns that into a `partial` unit outcome, and a run with a
  non-success unit is `not_eligible` for parse jobs. Terminals are immutable
  and the eligibility rule is not loosened, so the confirmed statements of
  those days come back with the next successful run, while pending-only rows
  that disappeared before it are lost. GLOBAL PASS's runs so far are all
  `partial` and none has been parsed: since the English pages were admitted
  (2026-09-29) the pages are stored, but the collector kept only page 1 of a
  month and production marked a two-page month `activity_pages_unwalked`.
  The collector now walks every page of a month (at most five) and stores
  page N as `activity-YYYY-MM-pN.html`; a run whose every selected month is
  proven whole against the pager's stated total registers `success` and is
  parsed by `global-pass-activity@1.1.0`
  ([ADR 0026 amendment of 2026-10-04](../adr/0026-collector-unit-coverage.md#amendment-2026-10-04-global-pass-walks-every-page-of-a-month)).
  Open limits: no run has walked a page yet, so the walk is proven on
  synthetic pages only; the Japanese display was observed live but the
  parser reads only English table labels; whether the parser's table model
  matches the production page has not been shown (no shared run has been
  parsed). A Vpass card run is `partial` the same
  way unless every month's captured rows equal the provider's stated total
  (ADR 0026's amendment). Both stated totals were seen on the live site
  (`allCnt` a string, `total` a number) and are read as exact counts, but the
  finalized walk still ends on its first empty page when `allCnt` or
  `nextPageRow` is unreadable, and the page-number fields (`pageNo`,
  `lastPage`) are not read because their meaning is unobserved
  ([ADR 0023's note](../adr/0023-vpass-collector-card-binding.md#note-2026-09-27-both-stated-total-fields-are-on-the-live-site)).
  A MyJCB connection's `complete` unit rests on the same
  unobserved premise (one detail page holds its whole month), and a
  connection whose older month shows rows without a stated state is
  `partial` and its run is not parsed. A MyJCB connection that stops at a
  month keeps the months before it as a `partial` unit with a closed stop
  code ([ADR 0005's amendment](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-a-stop-ends-the-connection-and-keeps-its-captured-months));
  those months are catalogued but not parsed, and no rule yet makes a
  stopped connection's months eligible. A MyJCB position whose ledger shows
  rows under the observed third header (`お支払日 / 今後のお支払い金額`, seen
  on the ショッピングスキップ払い schedule page) is kept unread
  (`scheduled_payments_page`): the connection goes on, but its run is
  `partial` and not parsed, because what those rows mean is unconfirmed
  ([ADR 0005's amendment (b)](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-b-export-links-the-third-ledger-header-and-the-stop-page)).
  The collector reads the credit menu's headings: the two schedule pages
  (positions 7 and 8 of the surveyed connection, under
  「ボーナス#回払い・ショッピングスキップ払い」) are not months. They are
  stored and recorded in the manifest, and they do not make the unit
  `partial`, so a night with an outstanding skip payment parses its months;
  an unobserved menu heading stops the connection before its first month
  ([ADR 0005's amendment (c)](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-c-the-menus-schedule-pages-are-not-months)).
  The ショッピングスキップ払い page, known by its h1, is stored as
  `credit-skip-payment-NN.html` and read by `myjcb-skip-payment-schedule`
  into `scheduled_payment_observations` (a payment still due, not a
  purchase); no read model, API or UI shows those rows yet, and they are not
  matched against statements or settlements. The bonus schedule page stays
  `credit-schedule-NN.html` and unread until it is observed with rows
  ([ADR 0005's amendment (e)](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-27-e-the-skip-payment-schedule-page-is-read-as-scheduled-payments)).
  The menu's schedule heading is an `h3`, which the collector read past
  until amendment (j), so runs read positions 7 and 8 as months (8 is stored
  as the skip page since amendment (h)); it now groups by the last `h2` or `h3`, and stores the bonus page, known by
  its h1, as a schedule page at any position. The bonus page's `h2` has the
  dated statement heading's form, so `myjcb-credit-statement-total@1.4.0`
  never reads a page with a schedule h1 as a statement
  (`schedule_page_not_statement`); its re-parse supersedes the 1.3.0
  readings of the stored pages, which published no total
  ([ADR 0005's amendment (j)](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-10-04-j-the-menus-schedule-heading-is-an-h3-and-the-bonus-page-is-known-by-its-h1)).
  The nightly MyJCB runs of 2026-09-25 to 09-27 (UTC) stopped at position 1 on its ledger
  header (`credit-ledger-headers`): every confirmed page breaks its amount
  label with a `br` (`今回の<br>お支払い金額`), and the collector matched the
  label on space-joined text. It now compares labels with all whitespace
  removed, as the shared page reading already did
  ([ADR 0005's amendment (f)](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-28-f-ledger-labels-match-across-line-breaks)).
  A `(確定分)` page under the 「ご利用金額」 header, which amendment (d) accepts
  when the page proves itself, was a misreading of the same `br` and has
  never been observed; that code is still in the MyJCB parsers after their
  1.3.0 statement release, unobserved. The run of 2026-09-28 21:01Z then
  stopped at position 1 on the page's month (`credit-statement-period`):
  the confirmed page's heading carries the payment day
  (「YYYY年MM月DD日(曜)お支払い分…」). The collector and
  `myjcb-credit-statement-total@1.3.0` read that form and the undated one,
  and the parser requires the heading's day to be the total's payment date
  ([ADR 0005's amendment (g)](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-28-g-the-statement-heading-may-carry-its-payment-day)).
  The run of 2026-09-29 21:03Z read every month, but the provider shows
  one identical page at several past positions without a bill, and the
  collector gave each copy its position's label, so the metadata extractor
  refused them (`manifest_artifact_ambiguous`). An `unknown` page now states
  no period, and one page read as two different things stops the
  connection (`credit_page_repeated`). That run also stored the
  ショッピングスキップ払い page as a month (the `h3` above); a month
  position whose page carries that h1 is now stored as the schedule page;
  the same skip-payment bytes stored at two positions would still carry two
  position labels and be refused as ambiguous (not observed).
  The repeated page is the provider's no-bill page (h1
  「カードご利用代金明細」, no `h2`, no ledger, 「当該月の請求はございません」), not
  the error page below; it is read `unknown` and yields no total, never a
  zero
  ([ADR 0005's amendments (h) and (j)](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-09-29-h-a-stored-page-states-only-what-the-page-states)).
  The empty skip-payment page reads as zero rows
  only when its one row is the provider's empty row; beside real rows it is
  refused. The first stored skip-payment page (run of 2026-10-02 21:00Z,
  position 8) was nonetheless refused by `myjcb-skip-payment-schedule@0.1.1`
  (`parser_rejected`); its size says it is the empty page, and which of the
  reader's structural checks refused it is not known until the owner runs the
  counts-only replay, which now covers MyJCB and prints the page's structure
  ([ADR 0005's amendment (i)](../adr/0005-myjcb-statement-state-from-page.md#amendment-2026-10-02-i-the-first-stored-skip-payment-page-was-refused)).
  No skip-payment observation exists yet. A later stop on a page's own shape now stores that page. The site's 「通信エラーが発生しました」
  page, served after many consecutive fetches, is not recognised; after the
  first month it would be kept as a month with no ledger. MyJCB export links
  are recorded, not fetched, because the shared bucket refuses the export
  datasets.
- [Collector operation dispatch](../../services/processor/src/operations/dispatch.ts)
  leaves collector requests, including unattended session refresh, waiting with
  `awaiting_collector_dispatch`. An accepted request is not a completed capture.
- [`costBasis()`](../../packages/domain/src/calculation.ts) returns
  `needs-policy` on every path. It is a contract and refusal gate, not a lot or
  cost-basis engine. `pnlDecomposition()` does not supply the missing transaction
  reconstruction and cost allocation.
- The [balance read model](../balance-read-model.md) and
  [agent queries](../agent-api.md) expose scoped quantities with unknown liability
  coverage, not a complete net-worth figure.
- [Price and report components](../calculation-and-reports.md) do not fetch market
  prices or FX. [Reward components](../rewards.md) still require activity
  classification and verified offer inputs before they can provide useful
  forecasts and exchanges for actual holdings.
- The [purchase explanation](../card-settlements.md#purchase-explanation-chain)
  shows recognised Vpass/MyJCB purchases through their statement and bank
  debit to an operator, with captured, authorized, refund and unresolved
  figures kept apart. It is not a complete card history: excluded shapes and
  rows the recognition writer has not reached are only counted, a pending row
  and its posted row are separate events until a reviewed link merges them
  (the review screen exists: the purchases page lists the open candidates and
  reviews each purchase's link with accept, reject or withdraw through the
  change lifecycle), and no statement-versus-purchases difference is computed.
  An agent with a whole-store `records.read` grant reads the same page through
  [`kogane.purchases.explain`](../agent-api.md#card-purchase-explanation), without
  the review actions; a grant scoped to some sources or accounts is refused
  because the page cannot yet be recomputed inside that scope.
