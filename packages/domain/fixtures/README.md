# Domain fixtures for the three vertical slices

Every value in these files is synthetic and taken from the design-review
scenarios (addendum 03, 09 and 14). None of it describes a real account,
balance, transaction or program term. The files are validated by
`test/fixtures.test.ts` against the `@kogane/domain` contracts and exercised by
`test/scenarios.test.ts`; later PRs (A03, A07, A10, A11) reuse them as the
expected adopted sets for read models, allocations and reward simulation.

Quantities are written in the full `Quantity` shape (`unitRef`, decimal-v1
`ValueState`). Refs (`scope:…`, `obs:…`, `rev:…`) are opaque identifiers with
no meaning outside the fixture.

## V1 — the same balance visible through several routes

| File | Scenario | Expected adopted set |
| --- | --- | --- |
| `v1/sc01-linked-deposit.json` | SC01 | Target `deposit.balance` / JPY. Variant `mf-confirmed`: adopt savings 60,000 + linked 100,000 = **160,000**; the bank total is excluded as `covered_by_breakdown`, the MoneyForward total as `duplicate_evidence`, the broker buying power as `metric_mismatch`. Variant `mf-unconfirmed`: same 160,000, MoneyForward total `overlap_unknown` (partial). Variant `total-breakdown-mismatch`: nothing adopted, total and parts `total_breakdown_mismatch`, result `unavailable`. |
| `v1/sc06-connection-only.json` | SC06 | `connection_contains` relations are adopted; the `same_account` proposal stays `proposed`. Direct accounts adopt **160,000**; the MoneyForward line with no terminal account id is `overlap_unknown`. |
| `v1/sc15-empty-snapshots.json` | SC15 | Only the complete, membership-complete container snapshot (`complete_empty_container`) replaces the previous holdings; partial pages, failed fetches and an empty complete history window do not. |

## V2 — charge, purchase, settlement

| File | Scenario | Expected result |
| --- | --- | --- |
| `v2/sc02-charge-purchase-settle.json` | SC02 | Bank / wallet / card-debt table: net assets 100,000 → 100,000 → 97,000 → 97,000; cumulative purchases **3,000** from one purchase event, although five observations exist. |
| `v2/sc03-pending-posted-refund.json` | SC03 | Adopted purchase **1,234** (pending 1,200 superseded through `pending_to_posted`); net after the allocated 400 refund **834**; three reports retained. Variant with an unknown refund target keeps the refund visible and the net unresolved. |
| `v2/sc04-installments.json` | SC04 | Remaining principal **8,000** after one 4,000 principal allocation; confirmed fee 100, projected fees 200 kept apart; cash out 4,100 fully allocated. |

## V3 — restricted points and expiry

| File | Scenario | Expected result |
| --- | --- | --- |
| `v3/sc11-wallet-points.json` | SC11 | JPY nominal 6,000 with withdrawable capacity 4,000; point buckets 300 + 500 = 800 nominal with bucket detail; status indicator 100 on its own; JPY + points is `unit_mismatch`; 6,900 is never produced. Carries four synthetic `MetricDefinition`s. |
| `v3/sc12-expiry-activities.json` | SC12 | Last qualifying activity 2026-03-01 → computed expiry **2027-03-01** under the verified rule; the naive `max(date)` answer 2027-08-01 equals the provider display and differs from the computed date, so both are shown. Month-end and leap-year edge cases included; an unverified rule yields `needs_rule_verification`. |
| `v3/sc13-redemption-request.json` | SC13 | Requestable **5,000** (regular bucket only); the wallet does not increase on request; points held + in transit + credited never exceed 8,000 at any stage. |
| `v3/sc14-conversion-offer.json` | SC14 | Offer A→B on 2,500 eligible: use **2,000**, receive **1,000**, keep 500, fee 100 JPY; the naive 1,250 is rejected. A chained A→C→B path is checked hop by hop. |
