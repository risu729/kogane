# ADR 0068: Preserve provider expiry subsets apart from reward holdings

- Status: proposed
- Date: 2026-10-10
- Issue: #444

## Context

Authenticated MyJCB structural observation confirmed a J-POINT section with a total and a separately displayed expiring quantity/date. The normal, special and total containers each have display flags. The total label does not establish that its full amount expires on the displayed subset date, and the two component labels do not establish regular/time-limited semantics. The captured response structure is recorded in docs/sources/myjcb.md; personal values and identifiers are excluded. Synthetic fixtures use unrelated values.

## Options considered

1. Put total and expiring portion in holding buckets: same-kind summaries would double count.
2. Subtract the portion and invent a remainder bucket: that remainder was not observed.
3. Attach the subset date to the total bucket: would present the full total as expiring.
4. Keep one observed total holding and separate non-additive provider display sections fixed to that same source fact and READ snapshot.

## Decision

Choose option 4. The observed total is one connection-scoped unclassified bucket, points:j-point, with no observedExpiry attached to the full balance. No computed expiry policy, conversion offer, financial adoption or remainder is created. Normal/special names remain provider text in original evidence; dated points do not become a confirmed time-limited kind.

The generic RewardProviderExpiryDisplayMetadata contract records coverage, closed reason and provider-displayed portions; it is carried in the total balance's normalized metadata beside the preserved provider fields. Partial portions never participate in holding summary, consumption or conversion. Exact Quantity and provider TemporalValue retain missing/unparsed/unknown states. Not-displayed means the provider section is not displayed, never zero or no expiry. Date parsing does not infer month-end from a year-month.

Promotion remains reward-promotion-v2: it adds a new source mapping without changing existing source interpretation. CORE 0080 seeds the observed programme and only the new independently sealed jpoint-balance unit policy (snapshot_selection=0). Existing statement policies are unchanged. The common unit eligibility predicate admits a successful reward unit of a partial run, with collector-error guards; absent, failed or run-level error evidence cannot rescue it.

READ 0005 stores one provider display SECTION per selected parent total. A section persists empty not-displayed/unknown state without inventing an expiry row. The section references the exact parent balance source fact, parse and capture; supplemental metadata never selects a separate newest response. Inputs are captured under the existing source/visibility/epoch revision sandwich. Provider sections enter the fixed input digest and claim-window reference digest. reward-projection-input-v3 and reward-projection-v4 identify the changed input/output. Compatible resumed builds load their original input; incompatible builds are retired.

Provider sections have their own bounded checkpoint stream under the common write budget. Each chunk and checkpoint are one batch guarded by writer lease/fence. Exact count, dense sequence and every digest of all three streams are verified before sealing and moving the pointer in one batch. The output digest includes provider section digests; sealed snapshot section count and rows are immutable. Retiring a snapshot removes its companion rows/checkpoint. Rule-bound estimate rows retain their existing rule-ref guards; provider-only facts do not name a fake expiry rule.

The expiry response adds optional providerDisplaySections from the same resolved sealed snapshot, filtered by programme and bounded by the full fixed claim-set limit. Existing estimate pagination is unchanged; the companion sections are a complete bounded set, not another independently paged context. The UI identifies the quantities as portions of the total and states that they are not added or policy-computed. Empty coverage is explicitly unconfirmed. No live CORE facts are appended to sealed READ answers.

## Consequences and limits

Acquisition is limited to the active card whose public `JCBカードW` token appears in one `SPAN.txt` immediately under `P.user-stage`. Private label adornments are excluded from the gate. Browser inspection verified the token/tag structure and adornment lengths; a separate boundary-category inspection timed out and the tab later became unavailable. Changed or unsupported boundaries therefore fail closed and can remain unsupported. No card switch is attempted.

The collector reads points only after statement-history collection finishes without a stop outcome. It makes one fixed POST to the observed pointJson route, without query parameters, redirects or retries. It bounds the request at 30 seconds and the response stream at 1 MiB and validates JSON-RPC schema and echoed request ID before retaining private R2 evidence. The closed `jpointCode` distinguishes collected, unsupported, stopped and unavailable; the independent reward unit exists only for eligible products. Unavailable/stopped remain unknown and do not alter history coverage. Authentication structure and synthetic tests establish this implementation's basis; they do not prove a collector run against the provider or a post-deployment live capture.

Only the currently authenticated, confirmed supported connection is acquired. Card switching, other products, history, stable lot identity, complete expiry partitions, activity semantics and policy calculation remain unsupported. Provider display dates are observations and cannot establish those meanings. Failed/unknown collection preserves prior eligible evidence without pretending that it is a successful new capture. Missing observed total quantity is a new missing balance, never zero.

## Verification

Synthetic contract tests refuse additional keys, different scope/units, duplicate slots, invalid/policy dates and false-to-observed widening. Synthetic total 1000 and expiring portion 200 retain total 1000 without 1200 aggregation or an invented 800 remainder. Storage tests verify missing coverage persistence, idempotence, conflicts, stale lease/fence, exact output verification, no fake rules and sealed immutability. Processor tests bind sections to selected parent facts, test bounded build/resume, new missing/not-displayed captures, and preserve publication gates. Shared/app/web tests verify same-snapshot response and explicit provider-only/unknown labels. Native workspace CI and independent review are required before merge; local tests do not prove a hosted or production capture.

Post-deployment acceptance remains open: a natural scheduled collection must show a successful independent reward unit and a registered J-POINT artifact through closed counts/codes, followed by a published parse and the matching sealed READ section. No raw label, financial value or selector text is logged. A gate mismatch remains unsupported/unknown and preserves statement-history coverage; it is not a provider failure, zero balance or no expiry. Browser structure and synthetic gate cases are not proof of this production acceptance.

### Candidate query scope and cost proof

The promotion query is an additive source extension. A frozen fixture preserves the exact mapping, binding construction and candidate SQL shipped at `f6fb5bdd0294140a88b064794653290ec8b34692`. Differential tests compare complete legacy candidate rows, including decimal state, extra metadata and both observation/as-of times, on scaled and eight deterministic random stores. The mixed result must equal the frozen legacy result plus independently specified J-POINT candidates, sorted before each page limit. Savepoint-based claim drains prove paging and idempotent completion without confusing the original legacy limit with the extended limit. The fixtures use every CORE migration, real sealed-run/unit views, foreign keys and publication guards; they cover run failures, absent/failed units, unit/run/sibling errors, wrong source/parser/metric/account/instrument, unpublished/excluded/unsealed facts, previous/current claim releases, missing/unparsed/conflicting decimals and disabled unit policy.

The unanalysed seeded query plan retains the shipped ordered outer `SCAN b`; this extension does not remove that inherited balance-driver cost. Its one added scan, `unit_policy`, visits the small shared policy configuration table. Claims and the new per-unit collector-error, terminal-report and seal checks use the shipped keyed indexes. The plan test refuses any additional data-table scan or automatic index. It does not claim a scan-free query, D1 runtime timing, or hosted performance proof.
