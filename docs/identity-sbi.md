# SBI securities identity interpretation

Layer C consumes the seven existing SBI parser shapes without changing Layer B. The caller scopes every account by source and producer. A producer identifies the collector implementation, not a verified login identity; this currently assumes one login per producer/source. Provider account references alone do not establish equality across separate logins.

Display labels distinguish domestic custody categories (retaining the exact code), foreign securities custody, foreign cash account kind, yen cash, and aggregate assets. Security names reported by the provider are display-only; renaming a security does not change its identifier or account mapping key.

Domestic deposit-type references retain their exact codes; domestic transaction account labels remain a separate discriminator. Foreign securities use `specificAccountCode`, while foreign cash uses `accountKind`. Matching text across these fields does not prove the same subaccount. Missing discriminators remain unresolved. Portfolio summaries use an aggregate account role, and portfolio categories never become instruments.

Domestic positions and valuations use the provider code and existing parser MIC mapping. Trades use the exact issue code and recognized market label. Four-character alphanumeric and five-digit codes remain intact. Unknown venues retain provider-local code identity. Foreign RICs are provider-reported identifiers; absent RICs use country-scoped provider codes. No ISIN, exchange, security-master match, tax-account equivalence, or current listing validity is invented. Identity does not imply that reported valuations are additive or holdings are complete.

Monetary units retain their role: a foreign transaction can have a JPY settlement unit and USD trade unit. Foreign cash uses the balance instrument. Position and valuation currencies retain their original denomination. A security reference remains independent of these monetary units.

Synthetic identifier example: foreign `specificAccountCode=SPECIFIC`, `securitiesCode=SYN`, `countryCode=US`, `ric=SYN.O` produces the exact provider account discriminator and provider-reported RIC `SYN.O`; global instrument matching remains unconfirmed. Foreign cash `accountKind=SPECIFIC` produces a different account key.

Remaining evidence needed for stronger reconciliation: a verified foreign account codebook, foreign cash account-kind semantics, venue aliases, cross-provider instrument identifiers with validity dates, and explicit connection identity. Raw amounts and personal account values are not required in this documentation or test assertions.
