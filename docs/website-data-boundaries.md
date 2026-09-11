# Website data and zero-filter audit (2026-09-08)

## Zero balances

The UI previously inspected only `amount_minor`. Several foreign currencies and crypto assets preserve exact `amount_text` with a null minor-unit value, so their explicit decimal zeros survived the filter. This is a representation issue, not a currency-specific balance override.

The filter now checks an exact decimal-zero string when minor units are absent. It uses no floating-point conversion, exchange rate, currency allowlist or rounding. Missing, ambiguous and nonzero text stays visible, including arbitrarily tiny nonzero amounts. A supplied nonzero or malformed minor-unit value is never overridden by text. Both latest balances and historical rows use the same predicate. The filter does not filter positions or individual activity pages; those are different measures.

## Audited production data path

- `web/src/api.ts`, identity/evidence API modules: same-origin API requests, validated response data, visible errors. No account-balance or activity fallback arrays.
- `web/src/pages/`, organization/product components: row values and account/security labels come from API observations and their interpretation/organization claims.
- `services/app/src/worker.ts`: authentication precedes API and assets. Main observations are queried from D1; original evidence is read from R2.
- `vite.config.ts`, `web/index.html` and the asset tree: the production entrypoint has no imported synthetic snapshot. `demo-worker.ts` is a separate Worker entrypoint and is not imported by the production Worker. Existing offline fixtures remain test/demo data, not production fallback data.

No hardcoded personal balances, activity rows or fabricated holdings were found in this path. Local browser regressions exercise API-supplied values and error behavior rather than relying on screenshots of fixed financial data.

## Static information that deliberately remains

There is static information, so “nothing is hardcoded” would be inaccurate:

- Japanese UI labels, parser-specific semantic rules, page-size and timeout constants.
- `shared/financial-products.ts`: versioned public product codes, names, currency coverage and evidence URLs. These identify a product only against observed evidence; listing a currency here does not create a holding.
- `src/money.ts`: the existing limited minor-unit formatting table (JPY/USD/AUD). Unsupported units preserve the original decimal text. This fix does not change parser meaning or silently assign other currencies a scale.
- Deployment binding names, Access configuration and the legacy Sony-only evidence-browser route scope. These are configuration/security boundaries, not fabricated financial records; no scope expansion is part of this fix.

Current account/instrument organization data remains backend data. Static public catalogues and display rules should not be confused with the user's changing financial observations. No raw observations or credentials were modified by this audit.
