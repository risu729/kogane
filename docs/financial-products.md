# Financial product identity

A financial institution, a comprehensive account relationship, and an individual
deposit product are separate entities. The catalogue in
`poc/observation-pipeline/shared/financial-products.ts` gives them separate stable
IDs. The [PowerFlex account](https://faq.sbishinseibank.co.jp/faq_detail.html?category=702&id=102&page=1)
is the umbrella; it must not replace the identity of an ordinary deposit, Hyper
deposit, Power deposit or currency-specific foreign ordinary deposit.

## Verified product bindings

The sources below were retrieved on 2026-09-08. They establish current catalogue
identity, not an observation-date interest rate, eligibility rule or historical
contract. The catalogue and deterministic resolver each have independent
version strings in every returned claim.

| Provider code                     | Currency                                       | Product                                                  | Evidence chain                                                                                                                                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 601                               | JPY                                            | パワーフレックス円普通預金                               | The bank's account controller explicitly selects 601 for ordinary yen savings; its utility maps 601 to CH. The official product page supplies the formal name.                                                                                                                                                                   |
| 603                               | JPY                                            | SBIハイパー預金                                          | The account controller and view handle 603 specifically as Hyper deposit; utility maps it to HY. The official launch description identifies the securities-linked deposit product.                                                                                                                                               |
| 605                               | JPY                                            | ボーナス利息付特別預金（パワー預金）                     | Utility maps 605 to PY. The view assigns transfer-limit changes exclusively to 605; the official Power-deposit FAQ documents this distinct operation. The official product notice supplies the full name. This is a public-UI-plus-product-description inference, not a downloaded authenticated product-description dictionary. |
| 621, 622, 623, 624, 625, 626      | USD, EUR, CAD, AUD, GBP, NZD respectively      | パワーフレックス外貨普通預金, currency-specific variant  | Utility maps these codes to SA. The controller classifies non-JPY savings as foreign ordinary accounts; the official product page defines the family.                                                                                                                                                                            |
| 627, 628, 629, 630, 631, 632, 633 | SGD, HKD, ZAR, NOK, CNY, TRY, BRL respectively | Same foreign ordinary family, distinct currency variants | Same public UI classification; each code/currency pair is explicitly allowlisted. CNY is not rewritten to CNH.                                                                                                                                                                                                                   |

Official product definitions:

- [Yen ordinary deposit](https://www.sbishinseibank.co.jp/retail/yen/en_futsu.html)
- [Hyper deposit introduction](https://corp.sbishinseibank.co.jp/ja/news/news/20250918a.html)
- [Power-deposit product notice](https://www.sbishinseibank.co.jp/info/news2607_poweryokin.html?intcid=yen_power_17)
- [Power-deposit transfer limits](https://faq.sbishinseibank.co.jp/faq_detail.html?category=1169&id=111725&page=1)
- [Foreign ordinary deposit](https://www.sbishinseibank.co.jp/retail/gaika/fx_saving/)

Official public UI code and descriptions:

- [Code-to-module classification](https://bk.web.sbishinseibank.co.jp/SFC/apps/services/www/SFC/desktopbrowser/default/js/service/utility.js), `getShotDepositCode`.
- [Account controller](https://bk.web.sbishinseibank.co.jp/SFC/apps/services/www/SFC/desktopbrowser/default/js/controller/AI0001_account_info.js), ordinary/Hyper/foreign grouping.
- [Account view](https://bk.web.sbishinseibank.co.jp/SFC/apps/services/www/SFC/desktopbrowser/default/view/PAI0001_account_info.html), 605 transfer-limit operation and 603 Hyper operations.
- [Japanese UI messages](https://bk.web.sbishinseibank.co.jp/SFC/apps/services/www/SFC/desktopbrowser/default/js/messages/message_jp.json), `TTAI01` and `TTAI02` explain the yen product group and thirteen foreign ordinary currencies. Both groups include zero-balance entries.

Power deposit is scheduled to end in January 2028 according to the official
notice. The resolver does not mark it already closed or erase historical
product identity. No interest rates or user-specific terms are inferred.

## Evidence boundary

The initial resolver accepts only a balance or valuation from the
`top-accounts-balance-and-activity` dataset with its own `top_overview` metadata,
matching savings-row locator, `extra.productCode`, `extra.currency` and
`extra.accountNo`. The source-account reference must agree with that same row.
Duplicated product/currency fields must agree. Known code with the wrong
currency is a conflict; unknown code is unresolved. There is no default mapping
of non-603 products to ordinary yen savings.

A JPY valuation uses the native currency named by `subject` and/or
`_kogane.subjectCurrency`, checked against the row's native currency. Its JPY
measurement does not turn an FX deposit into a yen deposit. The initial rule
does not infer transaction products from sibling observations, another parse,
another fetch run, or another collection route. It never modifies source
evidence, source account IDs, measurements, or account mappings.

The saved provider response supports code/currency account references, including
zero-balance slots. A resolved product means the **type of an observed account**
is identified; it does not mean funds are held. Product lists such as yen-deposit
`productDetails` describe offered products and do not establish ownership.
Aggregates remain explicitly unresolved as individual products. SMBC's current
ordinary-yen collection scope does not prove a particular interest-rate/product
variant. Other collectors remain unresolved until their own product bindings
have evidence and tests.

Every claim retains observation/parse/artifact/row origin, bounded public source
references, its code and native currency, and an explicit current-catalogue
temporal basis. Original private identifiers and amounts are not copied into
the catalogue or this document.

# Catalogue revision 2026-09-08.2 / own-row-v2

## Persistence boundary

This change does not attach product_id to accounts or instruments. The catalogue and resolver are Git-versioned; each eligible B observation receives a current runtime interpretation, not a stored historical decision. Exact replay requires the same A/B evidence, catalogue/resolver revisions and financial-evidence eligibility state. Future manual product corrections or a published-decision audit would require append-only claims with their own provenance. No database migration or backfill is required here. Manual nicknames remain independent. Account catalogues and filters describe acquisition/account scope, while official product identification is presented per record.

Currency-specific IDs represent catalogue variants, not separately invented marketed names. Shinsei FX variants all retain the exact official name パワーフレックス外貨普通預金; nativeCurrency is separate. PowerFlex is an umbrella family, not a substitute product. Claims include the trusted parser name and nullable observation timestamps in origin; they interpret current catalogue definitions, not historical contract terms.

Sony identification is limited to audited `sony-bank-history-json` and `sony-bank-history-csv` ordinary-history paths: dedicated yen-history / foreign-history currency dataset, matching `sony-bank:deposit:{currency}`, exact transaction or after-transaction-balance locator, and the own row's currency. Transaction rows additionally require provider-json / official-csv metadata. Balance rows have no such metadata; their trusted parser, dataset, locator and original currency establish scope. JPY maps to 円普通預金 and supported foreign currencies to 外貨普通預金, with currency variants. Sony supports CNH, not Shinsei's CNY. Gross asset/loan category codes never establish a product.

The dedicated `sony-bank-wallet-history` transaction parser additionally requires wallet-history-YYYYMM, `sony-bank:wallet`, HTML table/row locator and wallet-monthly-html metadata. It establishes Sony Bank WALLET only: no deposit linkage, native deposit currency, design or tier. Official source definitions, verified 2026-09-08: [円普通預金](https://sonybank.jp/products/yen/03.html), [外貨普通預金](https://sonybank.jp/products/fc/03.html), [Sony Bank WALLET](https://sonybank.jp/products/sbw/03.html).

Other source boundaries remain explicit unresolved results: SMBC ordinary-yen does not select its interest variant or Olive; GLOBAL PASS activity cannot choose standard/ANA or a PRESTIA deposit; Vpass identity tokens and MyJCB inventory hints do not prove marketed card products on individual ledger rows. Securities custody/tax regimes remain distinct from instrument identity and bank products. SBI VC exchange categories, Suica SF, VポイントPay prepaid balances and Vポイント reward buckets require their own audited rules before catalogue binding. MoneyForward connection correspondence never distributes a product to every calendar row. PayPay and unknown sources have no generic fallback.
