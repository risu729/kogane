# Layer C source identity boundaries

Identity plans classify existing Layer B observations. They do not assert holdings,
sum balances, deduplicate transactions, identify people, or create cross-provider
account aliases. The enclosing identity engine scopes account keys by source and
producer. Exact provider references stay in key material; labels are not identity.
The planning snapshot in `data/account-inventory.csv` cannot prove a product is held.

| Source       | Accepted source account                            | Meaning and boundary                                                                                                         |
| ------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Vpass        | `vpass:card-NNN`                                   | Verified importer sidecar HMAC gives provider-local card identity; absent/ambiguous evidence stays run-scoped                |
| GLOBAL PASS  | `global-pass:card`                                 | Debit activity, separate from PRESTIA bank deposits                                                                          |
| MyJCB        | `myjcb:{connection}:root`                          | Statement aggregate without physical/subcard assignment                                                                      |
| SMBC         | `smbc-bank:ordinary-yen`                           | Audited ordinary JPY deposit only; not Olive credit liability or AUD deposit                                                 |
| Sony         | `sony-bank:deposit:{currency}`                     | Currency-specific deposit scope                                                                                              |
| Sony         | `sony-bank:wallet`                                 | Debit-card activity; not another stored-value deposit                                                                        |
| Sony         | `sony-bank:gross`, asset 001–011, loan 012–015     | Provider totals/categories, not established product holdings                                                                 |
| SBI Shinsei  | `sbi-shinsei:{accountNo}`                          | Provider account reference and native unit; source ID is `sbi-shinsei-bank`                                                  |
| SBI VC Trade | `sbi-vc-trade:main`                                | Exchange account; separate from SBI Securities and Shinsei                                                                   |
| V Point      | common bucket indices                              | Provider-local semantic bucket from explicit point type and expiration; missing/conflicting evidence falls back to fetch run |
| V Point      | store-limited group-item indices                   | Fetch-run-scoped reward buckets, unresolved durable binding                                                                  |
| V Point      | `v-point:smfg:smbc`, `v-point:smfg:smcc`           | Display aggregates potentially overlapping common points                                                                     |
| V Point      | `v-point:member`                                   | Member history scope                                                                                                         |
| V Point Pay  | notification-events / prepaid-yen                  | Separate notification and historical event-balance roles, denominated in yen                                                 |
| Mobile Suica | `mobile-suica:sf`                                  | SF scope, no physical card binding inferred                                                                                  |
| MoneyForward | `moneyforward-me:moneyforward-account-v1-{64 hex}` | Verified account/service HMAC, aggregator mirror, never mapped by name                                                       |
| PayPay CSV   | `paypay`                                           | Export scope; does not distinguish money, money-lite or reward buckets                                                       |

The classifier accepts exact patterns from the checked-in parser registry.
Unknown source/pattern combinations remain unresolved. Vpass ordinals without trusted sidecars and reward buckets
without complete semantic evidence include fetch-run ID because enumeration is
not durable identity. Common V Point buckets use the exact provider point type
and expiration tuple, independent of index. Provider enum meanings are not
inferred. The parser's duplicated metadata must agree if present. Empty expiry
is preserved as a provider value; it does not assert that points never expire.
This groups source observations without merging rows or adding balances.
MoneyForward HMAC identity is stable across ordinal changes; changing an alias
secret does not authorize a merge. Coarse single-account source scopes remain
provider-local, not globally identified accounts.

Money uses an explicit currency catalog. `CNH` is an offshore-renminbi variant,
not an ISO 4217 synonym for `CNY`. `V_POINT` is its own reward program. Unknown
codes are unresolved and source-scoped. SBI VC explicit asset codes are
provider-local crypto identities; provider products such as `BTCJPY` remain
products. Product suffixes never imply base/quote, spot holdings, networks or
global token identity. Only parser-preserved explicit execution currency pairs
produce trade-unit and quote-unit identities. Sony's usage currency is separate
from settlement currency. Shinsei's provider yen equivalent stays a JPY valuation
of the native currency account, not additional yen cash.

Provider-local classification is not authorization to add every metric together.
Sony category totals, MyJCB statement payments, SBI VC margin/withdrawal limits,
overlapping reward displays and post-transaction historical balances retain
their existing measurement semantics. Notification evidence does not establish
settlement. Existing current-snapshot selection and provenance remain unchanged.

Evidence: `packages/parsers/src/parsers/registry.ts` and each source parser;
`docs/sources/moneyforward.md` documents HMAC verification. Synthetic boundary
tests in `packages/identity/test/identity-other.test.ts` cover accepted and
rejected scopes, changing ordinals, currency roles and product separation.
