<a id="dbでの金額数量の正規化"></a>

# Normalizing amounts and quantities in the database

<a id="責務と保存形式"></a>

## Responsibility and storage format

Original amount text in Layer A evidence and Layer B parser results is unchanged. For balances, transactions, valuations and held quantities, `observation_decimal_values` stores derived `decimal-v1` values. This neither erases source/currency differences nor combines balances with usage activity.

A value is `coefficient × 10^(-scale)`. The coefficient is an arbitrary-precision integer string and the scale is an integer. For example, `-0012.3400` has coefficient `-1234` and scale `2`. Both `0.00` and `-0` normalize to coefficient `0`, scale `0`. Amounts are never converted to floating point. The string representation preserves precision and is distinct from free-form provider text.

The following states remain distinct.

- `exact`: a normalized value. Zero exclusion applies only to coefficient `0` in this state.
- `missing`: both original fields are absent.
- `unparsed`: a value exists but this policy cannot interpret it.
- `conflict`: the integer representation and decimal text disagree. Neither is adopted arbitrarily.

Original text stays visible; details also show normalization state, coefficient, scale and policy version. The API supplies stored values, and the screen does not reparse original text. Old demos without normalized values are not treated as zero either.

<a id="入力契約"></a>

## Input contract

`amount_scale` is the precision of decimal text, not necessarily the unit exponent of `amount_minor`. Integer values are converted only for JPY=0 and USD/AUD=2, as already defined by the parser contracts. No exponent is guessed for unknown currencies. Zero and sign do not depend on an exponent, however, and are used to detect conflicts. Held quantities use `quantity_text`.

Decimal text accepts only ASCII digits, an optional leading sign, 1 decimal point and surrounding ASCII whitespace. `.001` is valid; exponents, separators, currency suffixes and a trailing decimal point are unsupported. A separately valid integer value can still be used. Input is limited to 4096 characters. Missing and empty strings are distinct. Matching valid representations store `agreement`; a single valid representation stores `decimal_text` / `minor_units`; unknown or disagreeing values store `none`.

<a id="移行と今後の取り込み"></a>

## Migration and future ingestion

`0024_observation_decimals.sql` processes every historical parser result once. `AFTER INSERT` triggers on the 4 original tables normalize later additions within the same transaction. No per-parser fix is needed. On failure, original and derived rows roll back together. Derived rows cannot be updated or deleted.

SQL views define the policy. `scripts/generate-decimal-triggers.ts` expands that SQL into triggers using only the new row `NEW`. Filtering an aggregate view by ID is avoided because it can scan all history. After a change, run the generator and `--check`. Retain whitespace that lets Wrangler's SQL splitter recognize `CASE` / `END`. Actual D1 migration tests also apply every migration.

In production, apply database migrations before deploying API/UI. The API reads only the requested page's IDs by primary key, in batches of at most 80. Missing or invalid normalized values are not hidden. Local SQLite applies the same migration once within a transaction.

Rollback restores the old Worker. Added database tables and triggers stay because they are compatible with the old API. Restoring the whole database is not a normal rollback method: it could lose captures made after migration. A policy change uses another version in an additive migration; applied migrations are not edited.

<a id="方針の選択と追加手順"></a>

## Policy selection and addition

`InterpretationContext.decimalPolicyRelease` admits only names with an existing projection. `DECIMAL_POLICY_PROJECTIONS` in `services/app/src/decimal-policy.ts` owns that decision, and `decimalPolicySelection(url)` resolves the `decimalPolicy` query parameter. With no selection, it uses `decimal-v1`. An invalid format returns 400 `invalid_query`; a well-formed name without a projection returns 400 `unsupported_semantics`. Neither silently falls back to the default `decimal-v1`. `decimalRows()` reads the projection for the selected `policy_version`.

Only `GET /api/v2/reports/{id}` currently exposes this contract, returning the selection in `interpretationContext.decimalPolicyRelease`. Existing list APIs (such as `/api/transactions`) derive their parameter sets from shared-schema capabilities, so extending selection to them also requires changes to `LIST_REQUEST_SCHEMA` and `ApiCapabilities` (owned by D14/A08). The server must not silently accept extra parameters on its own.

To add a second policy (fundamental review 07 §6), follow these steps. Do not edit `0024_observation_decimals.sql`.

1. Add a migration creating a projection keyed by `policy_version`. A new table or compatible view is acceptable, but `decimal-v1` rows are not rewritten.
2. Separate historical backfill from DDL and make it resumable. Do not scan a large table in one migration.
3. Register the name in `DECIMAL_POLICY_PROJECTIONS`. The API cannot select a name absent from it.
4. Add tests comparing both policies and verify that existing `decimal-v1` results remain unchanged.
5. Deploy in database-migration → API/UI order. The old Worker does not know the new name and continues using its default.

<a id="検証"></a>

## Verification

Checks cover arbitrary precision, scale, negative zero, unknown currencies, conflicts, missingness, original-row immutability and insert atomicity. Adding 3,000 rows also checks for regressions that scan all history. Automated tests include the API contract, the D1 runtime and zero exclusion for foreign currencies/cryptoassets on screen. Rehearsal with real data is in memory, without storing amounts or account information in logs or public materials.
