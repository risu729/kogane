# Vpass via Personal-Finance Aggregators

Checked against public documentation on 2026-08-26. This is a feasibility
survey, not a live-account test. In particular, no undocumented web API was
called and no account or developer application was created.

The useful distinction is between two separate hops:

```text
Vpass -> aggregator -> Kogane
```

All four products can do, or publicly document, the first hop. Only freee
currently offers a self-service, documented route for the second hop. Moneytree
offers a technically strong second hop through LINK, but it is a commercial
business integration rather than an API included with the consumer app.

## Shortlist

| Route | Vpass collection | Official unattended output to Kogane | Consumer cost relevant to a PoC | Verdict |
| --- | --- | --- | --- | --- |
| freee Accounting | Supported; up to 15 months for SMCC cards | Yes: OAuth 2.0 JSON `wallet_txns` | Starter: JPY 1,780/month or JPY 11,760/year, tax excluded | Best first PoC |
| Moneytree | Supported with Vpass ID/password; Moneytree reads the SMCC website | Yes only through commercial Moneytree LINK; consumer plans only have interactive CSV/XLSX export | Personal free; Grow JPY 390/month or JPY 3,900/year on web; Work JPY 500/month or JPY 5,400/year | Good API, high commercial barrier |
| Zaim | Supported as `三井住友カード`; documented as website aggregation rather than a card-company API | Public API is promising but public material does not conclusively say whether aggregated Vpass rows are returned; Premium CSV explicitly includes them | Free sync; Premium JPY 440/month or JPY 4,378/year on web | Cheap decisive PoC |
| Money Forward ME | Supports `三井住友カード (VpassID)` and `三井住友カード (SMBC ID)` | No documented ME consumer API; Premium has interactive CSV export. A read-only Kogane PoC nevertheless verified its private web interface on Workers | Free up to four connections; Standard JPY 540/month or JPY 5,940/year on web | Official route is CSV; private-interface PoC is a working but change-prone fallback |

The prices above are the vendors' direct-web prices where available. App-store
prices can be higher.

## freee Accounting

### What is documented

- freee explicitly supports SMCC cards whose statements are visible in Vpass,
  and says that `三井住友VISAカード` can import at most 15 months. The normal
  SMCC integration imports after the issuer fixes the monthly bill; some other
  Vpass-family issuers use a different connector and may import pending rows.
- A private app can access at most five businesses and does not require an app
  review. The special "bank statement access" approval applies to
  `GET /api/1/wallet_txns` only when `walletable_type=bank_account` or the type
  is omitted. A personal private app that requests a specific `credit_card`
  wallet is therefore the intended low-friction route. Offering a financial
  service to other users is a separate review category; this PoC does not do
  that.
- The official Accounting API returns JSON. `GET /api/1/walletables` enumerates
  credit-card wallets and `GET /api/1/wallet_txns` returns their statement
  rows.

There is an important request-shape trap: the schema says
`walletable_type` and `walletable_id` must be supplied together. Supplying only
`walletable_type=credit_card` causes that filter to be ignored. The safe flow
is therefore:

```text
GET /api/1/walletables?company_id=...&type=credit_card
GET /api/1/wallet_txns?company_id=...&walletable_type=credit_card&walletable_id=...
    &start_date=...&end_date=...&limit=100&offset=0
```

Paginate until an empty page. Do not make an untyped `wallet_txns` request: in
addition to returning unrelated data, it falls into freee's documented bank-
statement access policy.

### Authentication and unattended operation

freee uses OAuth 2.0 authorization-code flow. The access token lasts six hours
and the refresh token lasts 90 days, but refresh tokens are one-use and rotate.
freee additionally says the refresh must happen while the preceding access
token is still valid. An unattended collector therefore needs a refresh job
comfortably inside six hours and atomic storage of the newly returned token
pair; retrying with the already-consumed refresh token fails.

This makes the provider-side collection low difficulty once Vpass has been
linked in freee: Kogane uses a stable documented API and does not automate the
freee UI or face Vpass's Akamai layer. The residual risks are freee's own Vpass
sync failures/re-authentication and the requirement to keep a paid accounting
plan. On an uncontracted plan, both account sync and Public API integrations
are stopped.

### Minimum PoC

1. During a free trial, link the Vpass account and confirm that one known SMCC
   statement row appears in freee.
2. Create a private app and authorize exactly one business.
3. Call `walletables?type=credit_card`, identify the Vpass wallet, then call
   `wallet_txns` with both its type and ID.
4. Compare date, description, amount, and available history with the known
   Vpass row, and exercise at least one token rotation.

Sources: [Vpass synchronization and 15-month range](https://support.freee.co.jp/hc/ja/articles/11800453778457-%E4%B8%89%E4%BA%95%E4%BD%8F%E5%8F%8BVISA%E3%82%AB%E3%83%BC%E3%83%89%E3%82%92%E9%80%A3%E6%90%BA-%E5%90%8C%E6%9C%9F-%E3%81%99%E3%82%8B),
[official Accounting OpenAPI schema](https://github.com/freee/freee-api-schema/blob/master/v2020_06_15/open-api-3/api-schema.json),
[app types and approval policy](https://developer.freee.co.jp/reference/application-types),
[token lifetime and rotation](https://developer.freee.co.jp/reference/faq/token_lifetime),
[individual pricing and uncontracted-plan limits](https://support.freee.co.jp/hc/ja/articles/213726523--%E5%80%8B%E4%BA%BA-freee%E4%BC%9A%E8%A8%88%E3%81%AE%E3%83%97%E3%83%A9%E3%83%B3%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6).

## Moneytree and Moneytree LINK

### What is documented

- Moneytree supports SMCC/Olive by asking for the Vpass ID and password and
  explicitly says it aggregates information from the SMCC website, not the
  SMCC applications. This is evidence for web aggregation, not a direct SMCC
  transaction API.
- Consumer Moneytree has no self-service developer token. Grow and Work can
  export transaction data as CSV/XLSX, but export is an interactive app/web
  feature, not a scheduled API. Grow exports from the start of the previous
  calendar year (at most two years); Work and Corporate have no period limit.
- Moneytree LINK is a documented UTF-8 JSON REST API. With `accounts_read` and
  `transactions_read`, it returns accounts and transactions, including credit
  cards. `request_refresh` can request a provider refresh, currently at most
  four times per guest per day. This is the cleanest API shape in the group.

LINK is not bundled with Personal, Grow, or Work. Moneytree issues the
`client_id`/`client_secret` through sales/customer success; a contract has an
initial fee and monthly fee, and pricing is provided after a meeting and NDA.

### Authentication and unattended operation

LINK uses OAuth 2.0 authorization-code flow. Access tokens normally last 3,600
seconds. A 401 is handled with the refresh token, and a successful refresh
returns a new access token and a new refresh token. Public documentation does
not state a fixed refresh-token lifetime; a 401 on refresh means the user must
authorize again. Vpass itself may separately require credential repair or an
interactive challenge inside Moneytree.

Technically, LINK is low difficulty and avoids both Moneytree UI automation and
Vpass's bot layer. Commercial onboarding is the blocker. Automating the
consumer website or its private API instead would add Moneytree session/2FA
handling and an undocumented, changeable interface; public material does not
establish that it is protected by Akamai, so that should not be assumed.

### Minimum PoC

1. First use Personal (free) to confirm that Moneytree imports the expected
   Vpass row; this tests only the first hop.
2. Ask Moneytree whether a single-user/internal LINK evaluation is available
   and obtain a staging client only if the commercial terms are acceptable.
3. Authorize `accounts_read transactions_read request_refresh`, enumerate the
   SMCC account, call `/link/accounts/{account_id}/transactions.json`, and
   compare the known row.
4. Exercise refresh-token rotation and a background-only provider refresh.

Sources: [Vpass/Olive connection method](https://help.getmoneytree.com/ja/articles/7240985-olive%E3%83%95%E3%82%AD%E3%82%B7%E3%83%96%E3%83%AB%E3%83%9A%E3%82%A4%E3%81%AE%E7%99%BB%E9%8C%B2%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6),
[consumer plans and prices](https://getmoneytree.com/jp/app/plans-and-pricing),
[export limits](https://help.getmoneytree.com/ja/articles/3701938-%E9%8A%80%E8%A1%8C%E3%82%84%E3%82%AB%E3%83%BC%E3%83%89%E3%81%AE%E6%98%8E%E7%B4%B0%E3%82%92%E3%83%80%E3%82%A6%E3%83%B3%E3%83%AD%E3%83%BC%E3%83%89%E3%81%A7%E3%81%8D%E3%81%BE%E3%81%99%E3%81%8B),
[LINK overview](https://docs.link.getmoneytree.com/docs/getting-started),
[LINK scopes](https://docs.link.getmoneytree.com/docs/api-scopes),
[transaction endpoint](https://docs.link.getmoneytree.com/reference/get-link-accounts-transactions),
[token handling](https://docs.link.getmoneytree.com/docs/using-access-tokens),
[refresh endpoint](https://docs.link.getmoneytree.com/reference/post-link-profile-refresh),
[commercial pricing model](https://faq.getmoneytree.com/cost).

## Zaim

### What is documented, and what remains unknown

Zaim lists `三井住友カード` and many Vpass-backed cards as supported. Its
general connection guide says card credentials are used to collect the
official website's statement into Zaim; SMCC does not appear in Zaim's list of
providers already migrated to provider APIs. Thus the Vpass-to-Zaim hop is
best treated as website aggregation.

Bank/card synchronization is available on the free plan and normally runs
every few days. Premium permits on-demand refresh and its CSV download
explicitly includes history created by bank/card connections.

Zaim also has a public, JSON `GET /v2/home/money` API using OAuth 1.0a. The
public landing page says it returns "items registered in Zaim." The current
API terms define household data to include transaction history obtained by the
aggregation service and permit API access to household information displayed
through Zaim. Those terms make aggregated rows plausible, but the publicly
visible endpoint documentation does not explicitly guarantee that an
auto-imported Vpass row is included. Conversely, an unofficial client report
that only manual rows are returned is not authoritative enough to close the
question. This is therefore a validation item, not a confirmed capability.

The public documents also do not state a fixed lifetime for the OAuth 1.0a
access token. Persistence and revocation behavior must be measured in the PoC.
The underlying Vpass connector can independently demand credential repair or
an interactive challenge.

If the public API includes aggregated rows, this route is technically low
difficulty and may remain free. If it does not, Premium CSV is a valid manual
fallback. Automating Zaim's private web API is not a sound fallback: it adds
session/CSRF/2FA handling, and Zaim's API terms expressly prohibit reverse
engineering its systems. No public evidence identifies Akamai on Zaim itself.

### Minimum PoC

1. On a free account, connect `三井住友カード` and wait for one known Vpass row
   to appear.
2. Register a developer application, complete OAuth 1.0a authorization, and
   call `GET https://api.zaim.net/v2/home/money` for the row's date range.
3. Compare the response with both a manual test row and the auto-imported Vpass
   row. The route succeeds only if the latter is present.
4. If absent, use a Premium trial to confirm the documented CSV contains the
   Vpass row; retain that route as manual rather than claiming an API.

Sources: [supported Vpass cards](https://content.zaim.net/questions/show/400),
[Vpass naming example](https://content.zaim.net/manuals/show/88),
[website aggregation mechanism](https://content.zaim.net/operations/online),
[provider-API connection list](https://content.zaim.net/questions/show/961),
[public developer landing page](https://dev.zaim.net/),
[API terms](https://dev.zaim.net/portal/tos),
[CSV including connected history](https://content.zaim.net/index.php/manuals/show/37),
[Premium pricing](https://content.zaim.net/questions/show/887).

## Money Forward ME

### What is documented

Money Forward ME currently exposes SMCC connections under both Vpass ID and
SMBC ID names. Its terms describe both credential-based aggregation and
provider-API connections, but the public support material does not identify a
transaction API that SMCC exposes to ordinary ME users. Treat the exact first-
hop connector as vendor-managed rather than assuming either scraping or a
direct SMCC API.

Premium users can export CSV rather than JSON: one year at a time from the mobile app,
or one month at a time per household book or financial institution from the
web app. These are interactive exports. The free plan is limited to four
connections and one year of visible history; Standard removes those limits.

There is no documented self-service API for Money Forward **ME**. The public
developer portal and OAuth/API-key documentation are explicitly for Money
Forward **Cloud**, and their product APIs expose accounting, expenses,
invoices, and related business resources rather than an ME household's
aggregated accounts. Historical Money Forward announcements describe an API
for selected partners, not a consumer developer API that Kogane can register
for. A Cloud token must not be presented as an ME solution.

Consequently the official Kogane path is manual Premium CSV. Automating ME's
private web endpoints may be easier than defeating Vpass directly at the
network layer, but it remains a session/2FA/CSRF-dependent private interface.
More importantly, the current ME terms prohibit use through unpublished
methods and reverse engineering. There is no public evidence that ME itself
uses Akamai, so its bot-control difficulty is unknown rather than confirmed.

### Read-only Kogane PoC observed on 2026-08-31

Separate from the documented official route, an authorized live-account PoC
completed a fresh browserless login and collection from both local WSL and a
Cloudflare Worker. The Bitwarden vault contained two existing passkeys for the
Money Forward ID relying party. Both produced accepted WebAuthn assertions,
but only one reached the intended ME household after the OAuth account
selector. The collector therefore identifies a credential by successful
end-to-end arrival at `/accounts` and account detail pages, never by vault item
name or candidate order.

With that existing Bitwarden passkey, each environment collected four account
detail pages and 48 monthly fragments (12 months for each account), producing
53 artifacts including the manifest with zero failures. The Worker stored raw
responses only in private R2 and exposed counts and the manifest key. Artifact
sizes and hashes, including a re-downloaded sample, were verified. A temporary
dedicated test passkey was removed from Money Forward ID afterward, its local
private-key copies were deleted, and the deployed proof now uses only the
existing Bitwarden credential material synced as a Worker secret.

The PoC does not turn the private interface into an official or complete data
API. In particular, it does not guarantee SMBC post-transaction balances,
bank transaction IDs, value dates, structured transfer counterparties,
official CSV/API bytes, full foreign-currency fields, or term-deposit lots. For
Vpass it does not guarantee lifecycle state, installment/revolving details,
billing grouping and payment date, refund linkage, original foreign amount and
rate, authorization IDs, merchant country/category, or points. The bank-side
Olive debit row lacks merchant detail; a generic Vpass row still does not prove
all-record completeness or official-detail parity. Source refresh lag,
pending rows, backfill completeness, and per-row source fetch time also remain
unknown.

### Minimum PoC

1. Retain the Worker PoC only as a read-only fallback and monitor login, OAuth
   selection, account-detail, and monthly-fragment counts for structural drift.
2. During a Premium trial, export the card's monthly CSV and verify its fields
   and pending/posted behavior against Vpass.
3. Compare both routes with official SMBC/Vpass statements before treating any
   field as complete; the documented official integration path remains CSV.

Sources: [current supported-service list](https://moneyforward.com/active_services),
[CSV export capabilities](https://support.me.moneyforward.com/hc/ja/articles/49505374073497-%E5%AE%B6%E8%A8%88%E7%B0%BF%E3%83%87%E3%83%BC%E3%82%BF%E3%81%AF%E3%83%80%E3%82%A6%E3%83%B3%E3%83%AD%E3%83%BC%E3%83%89%E3%81%A7%E3%81%8D%E3%81%BE%E3%81%99%E3%81%8B),
[plans and limits](https://support.me.moneyforward.com/hc/ja/articles/900004382283-%E3%83%97%E3%83%AC%E3%83%9F%E3%82%A2%E3%83%A0%E3%82%B5%E3%83%BC%E3%83%93%E3%82%B9-%E3%82%B3%E3%83%BC%E3%82%B9%E5%88%A5%E5%AF%BE%E5%BF%9C%E6%A9%9F%E8%83%BD%E4%B8%80%E8%A6%A7),
[current pricing](https://support.me.moneyforward.com/hc/ja/articles/4409828451993-%E3%83%97%E3%83%AC%E3%83%9F%E3%82%A2%E3%83%A0%E3%82%B5%E3%83%BC%E3%83%93%E3%82%B9%E3%81%AE%E6%96%99%E9%87%91%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6%E6%95%99%E3%81%88%E3%81%A6%E3%81%8F%E3%81%A0%E3%81%95%E3%81%84),
[ME terms and restrictions](https://moneyforward.com/terms),
[Cloud-only developer portal](https://developers.biz.moneyforward.com/).

## Recommended order

1. **freee private app**: the second hop is already documented and
   self-service. Validate the exact Vpass wallet and token-rotation schedule.
2. **Zaim public API**: cheapest decisive experiment. Its result resolves the
   only material documentation ambiguity.
3. **Moneytree LINK**: pursue only if Moneytree offers an economical internal
   evaluation/contract. Technically it is excellent; consumer subscriptions
   do not unlock it.
4. **Money Forward ME CSV**: useful as a manual evidence source, not an
   unattended collector.

None of these routes proves that its own website lacks bot protection. The
reason to prefer them is that the supported API routes avoid website
automation entirely; where only CSV exists, the export should remain a manual
ingestion path rather than silently depending on a private API.
