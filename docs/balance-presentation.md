<a id="残高請求額の表示方針"></a>

# Balance and billed-amount presentation policy

`financial-measures-v2` is a read-only projection that organizes observation meanings and normal presentation; it changes no original evidence, parser result or account mapping. Responses using the old `balance-view-v1` remain readable, but the screen reclassifies them under the current rules.

<a id="保有量と期間実績の分離"></a>

## Separate holdings from period activity

`/balances` shows point-in-time balances, their aggregates and reference amounts; `/summaries` shows period activity and bills. The latter are added to neither individual transactions nor balances. The server's `view=balances|summaries` applies classification before pagination. For compatibility, an API request without it returns the previous storage format.

Classification carries `measurementKind` (balance / aggregate balance / period activity / billed amount / available capacity / unconfirmed), `assetClass` (cash / prepaid / points, etc.) and `timeBasis` separately. Held points are a balance, but not a currency. Usage restrictions and expiry are separate from the earning period; expiry does not establish the target month.

MyJCB's period list returns every billing month displayed in the latest complete capture, rather than only the old single (1-row) "latest balance" entry. A billing month is neither a usage period nor evidence of payment. Period activity for `Vポイント` (V Point) continues to be selected by complete capture.

`VポイントSMFG` (V Point SMFG) fields `point_smcc` / `point_smbc` are displayed on the official member page as `連携しているVポイントサービスの獲得ポイント（先月分）` ("points earned through linked V Point services, last month"). They are not holdings. On 2026-09-08, the public UI's [state module](https://mypage.tsite.jp/_nuxt/64c5c08.js) field-to-getter mapping was checked against the [display component](https://mypage.tsite.jp/_nuxt/d7645f4.js) getter-to-heading mapping. This is evidence for the current interpretation rule; it does not rewrite historical Layer B `not-inferred` or `displayed_point_balance` values.

The SMFG API retains no absolute year and month, so the display is `先月分（対象年月は未特定）` ("last month; target year and month unidentified"). `observed_at` can be a copy of the capture time; it is not used to fabricate the target month as a fact. The precise meanings of VPoint `point_type` / `get_month` are also unconfirmed. Common/store-limited bucket array positions are not permanent identifiers across captures.

<a id="意味を分ける"></a>

## Keep meanings separate

- Deposit and custody-cash balances are displayed as records on the asset side.
- Monthly card bills appear in a separate `請求額` ("billed amount") section. MyJCB `credit_statement_payment_amount` includes historical bills that have already been paid and does not prove current outstanding debt. The original sign is retained rather than mechanically made negative.
- Outstanding debt is separate from a billed amount. It is not estimated until the remaining amount, reflected payments/refunds and reference time can be captured. If reflected in net assets later, that remaining debt is deducted without counting the bill twice.
- Aggregates, available capacity and limits are separate from individual balances. Points remain holdings in their original unit, without conversion to yen. A prepaid balance in a notification is the amount reported at notification time, not proof of its current value or final settlement. Unsupported information remains semantically unconfirmed.
- A type classification alone does not make quantities additive. Every field in this change has `netAssetEligible: false`. No net-asset total ignores differing reference times or aggregation scopes.

Classification is determined by the source, parser and field together. A same-named field is not generalized to another source.

<a id="同じ残高の根拠をまとめる"></a>

## Group evidence for the same balance

Only the pair `yen_deposit_account_balance` and `yen_deposit_savings_balance` returned by the same `SBI新生銀行` (SBI Shinsei Bank) capture is eligible. Matching product names alone do not justify grouping.

Grouping requires the current organized account and valid product evidence tied to each row itself. A pair becomes 1 row only when the source, source account, account reference and organized destination, original evidence, parse, product, currency, reference time and observation time match; there are exactly 2 complementary rows; and both the integer amount strings and original amount text agree. Integer comparison uses no floating point.

Normal presentation uses the representative row's amount unchanged rather than adding the 2 amounts. Links and field names for both observations remain. Disagreeing amounts or ambiguous candidates are both displayed with a warning. Insufficient evidence leaves the rows separate.

History is not grouped: each observation is displayed unchanged. This rule does not merge observations at different times, different products/accounts/captures, or overlaps with overall aggregates.

<a id="絞り込みとページング"></a>

## Filtering and pagination

The server applies account, source and currency conditions to the original valid latest candidates, obtains the complete candidate set of at most 5,000 rows, then builds display groups. Beyond the bound it returns 413 rather than presenting a subset as the correct whole. Filters can narrow the scope for another request.

Field conditions are applied after grouping, matching either evidence field. Searching either field returns the same group with both pieces of evidence. Normal presentation is then paged in groups of 500 rows. History pagination is independent and retains the original observation unit.

The screen uses 1 set of 50-row pages across classifications; rows within a page are arranged by type. The displayed count is the received window's count, not the total number of held accounts.

`残高0を除外` ("exclude zero balances") is a display condition applied to both received latest and history lists. It hides only rows whose amount in minor units is established as integer zero, retaining unrecorded/unparsed values and negative amounts. It is applied before screen pagination and returns to the first page when toggled. The condition survives a return from details, but is not persisted. Unreceived server pages are not scanned automatically.

<a id="互換性と保護"></a>

## Compatibility and protection

Existing balance fields, amounts and signs remain unchanged; the API adds optional `interpretation`. Old data is only classified for display, without partial client-side deduplication. API validation rejects evidence arrays that do not include the original row.

No database migration or reparse is needed. Existing Cloudflare Access protection, original-evidence publication restrictions and read bounds remain.

<a id="読み取りモデルv2"></a>

## Read model (v2)

The classification and grouping rules above are unchanged. `/api/v2/balances/latest` returns the same `interpretation` and groups evidence under the same strict matching conditions. What changed is **when** this is computed: once per input context, with the result stored as a projection, rather than on every request. See [Balance read model](balance-read-model.md).

A v2 row also carries adopted state (`adopted` / `excluded` / `unresolved` / `conflict` / `stale`) and reason codes, a normalized value usable in calculations (`ObservedQuantity`), a metric definition (`metricId` and version), an evidenced reference time (`TemporalReference`) and freshness. **An evidence count is not a balance count**, so the screen shows them separately.

Subtotals are returned as per-unit `knownAssetsSubtotal` together with `liabilitiesCoverage: 'unknown'`. No `netWorth` field exists; response validation rejects it. Because some liabilities are uncaptured, the partial asset total is not even a lower bound.
