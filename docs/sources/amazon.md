# Amazon.co.jp card / gift card / Points source assessment

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## 1. Scope and boundaries

This source covers only the following read-only information from Amazon.co.jp consumer accounts.

- Displays of orders, item rows, delivery/cancellation/return/refund states, order totals, receipts, etc.
- Amazon ギフトカード (Amazon gift cards) balance, expiry dates, and balance change history
- Amazon ポイント (Amazon Points) available/pending/limited-time balances, expiry dates, and change history
- Amazon account authentication/sessions and the official shopping app needed for those displays

**Amazon Mastercard card usage statements are out of scope.** Amazon order screens are commerce records
of what was ordered, the specified payment methods, and how Amazon refunded it; they are not the issuer ledger
of card usage dates, merchants, pending/confirmed states, closing dates, billed amounts, payment dates,
installments, etc. Amazon Mastercard is issued by 三井住友カード (Sumitomo Mitsui Card); its authoritative
statements are a separate source on [Vpass](https://www.smbc-card.com/mem/oshiharai/index.jsp).
Do not automatically identify Amazon orders with Vpass entries such as `AMAZON.CO.JP` by amount alone.
Limit this to reconciliation considering multiple items, split shipments, authorization, refund delays,
and combined points/gift card payments.

Purchases, order confirmation, reordering, cancellation, return requests, reviews, gift card registration/purchase/use,
points use, and payment method/address/authentication/profile changes are prohibited. Do not store secrets,
cookies, OTPs, passkey material, order numbers, addresses, product names, or actual balances/amounts.
Do not aim to bypass security controls.

## 2. Research method

- Prioritized official public pages from Amazon, Sumitomo Mitsui Card, and Google Play.
- Made Chrome-like GETs to order history, gift balance, and Privacy Central entry points while logged out,
  observing only redirects, headers, script hosts, and OpenID parameter names. Cookie values were neither adopted nor saved.
- Inspected public GitHub implementations as secondary evidence supplementing the official UI's concrete transport/pagination.
- Did not log in, access account pages, retrieve/decompile APKs, or capture the owner's data live.

Public entry points:

- [Order history](https://www.amazon.co.jp/your-orders/orders)
- [Gift card balance](https://www.amazon.co.jp/gc/balance)
- [Gift card terms](https://www.amazon.co.jp/gp/help/customer/display.html?nodeId=GNG9PXYZUMQT72QK)
- [Amazon Points](https://www.amazon.co.jp/gp/aw/help/id=200041560)
- [Privacy Central data request](https://www.amazon.co.jp/hz/privacy-central/data-requests/preview.html)
- [About passkeys](https://www.amazon.co.jp/gp/help/customer/display.html?nodeId=TPphmhSWBgcI9Ak87p)
- [Amazon Shopping Android](https://play.google.com/store/apps/details?id=com.amazon.mShop.android.shopping)
- [Amazon Mastercard](https://www.amazon.co.jp/credit/landing)
- [Vpass statements](https://qa.smbc-card.com/mem/detail?site=4H4A00IO&category=163&id=40)

## 3. Official routes and data comparison

| Route                                  | Available information                                                                                | Granularity/state                                                                        | Period/count/export                                                                                                                                   | Tradeoff                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Amazon Web order history               | Order dates, per-order totals, item rows, delivery/cancellation/return/refund states, receipts, etc. | Order → item → delivery/refund; not card billing rows                                    | UI has period filters and pagination. No bulk consumer CSV/API established publicly; receipts etc. are printed/PDF equivalents per order              | Most detailed, but extensive PII and adjacent write paths                  |
| Amazon Shopping app                    | Orders, deliveries, returns/refunds, gift/points balances similar to Web                             | Mobile UI; notifications and delivery status are convenient                              | Fixed retention/full export unverified                                                                                                                | Tied to devices/sessions/screen changes; do not use as the first collector |
| Gift card balance page                 | Current balance; changes from top-ups/registration/order use/refunds, etc.; expiry                   | Balance ledger, separate from order breakdowns                                           | Official fixed counts, pagination, and CSV/PDF not established publicly. Terms generally give expiry 10 years from issuance                           | Useful for reconciliation, but adjacent registration/purchase paths        |
| Amazon Points page                     | Available, pending, limited-time, history, expiry                                                    | Points changes; pending/confirmed may change at order confirmation/shipment/cancellation | Standard points generally renew expiry for one year from last purchase or accrual. Limited-time points have individual expiry. CSV/PDF/API unverified | Reward ledger, not a cash/card ledger                                      |
| Per-order receipts/purchase statements | Order number, date, items, tax, payment breakdown, etc.                                              | Per-order document                                                                       | Individual print/download; separate from bulk export of all orders                                                                                    | Strong evidence, but costly one at a time                                  |
| Privacy Central request                | Request for account data held by Amazon                                                              | Asynchronous snapshot; categories/schema require live verification                       | Not a scheduled incremental API; generation time/format/retention unverified                                                                          | Most comprehensive official export candidate, but infrequent/manual        |
| Vpass                                  | Pending/confirmed card statements and billing, including Amazon Mastercard                           | Issuer/card ledger                                                                       | Researched in the Vpass family source                                                                                                                 | Keep separate from this source                                             |

### Relationship between orders/refunds and balances

As established fact, Amazon separates order history, gift balance, and points into different screens.
Reconciliation keys, including hypotheses, are datetime ranges, signs, generalized payment types, and
order/shipment units; do not permanently store order numbers or product names. Return acceptance is not
settled refund. Treat whether the destination is a card, gift balance, or points, whether it is a partial
refund, and when it appears in Vpass as separate states. Pending/posted is not one common Amazon axis:
order states, pending → available points, refund processing → reflection in each balance, and pending →
confirmed card entries are separate state machines.

## 4. Authentication, MFA, passkeys, and Bitwarden

Logged-out GETs redirected order history to Amazon sign-in via OpenID 2.0 `checkid_setup`, using
`openid.return_to`, `openid.assoc_handle`, and `openid.identity`/`claimed_id`. Order history, gift balance,
and Privacy Central had separate `assoc_handle` and different `max_auth_age` values, so reauthentication
strength may differ even in the same session. This is an observed public redirect fact, not an internal
authorization API specification.

Amazon officially offers passkeys and two-step verification in addition to passwords. No live capture
was made of concrete challenges, RP IDs, extensions, OTP re-request conditions, or trusted-device lifetimes.
Bitwarden can generally store/present passkeys, but whether this Amazon account's credential is in Bitwarden,
whether it matches Amazon.co.jp's actual RP ID, and whether headless assertions are possible are unverified;
do not infer them.

The recommended boundary is initial/renewed authentication in the owner's ordinary browser, then read replay
using an encrypted source-scoped session. Do not move vaults, passwords, OTP seeds, or passkey private keys
to the cloud. Stop automation and hand off to the owner on challenges, OTP, account recovery, CAPTCHA,
or suspicious login confirmation. Do not change authentication settings or register new passkeys.

## 5. WAF / anti-bot and public JS

In this observation from WSL, official account entry points reached sign-in HTML rather than bot blocks.
Observed `x-amz-rid`, Amazon-specific session cookies, AUI bundles from `m.media-amazon.com`, and telemetry
at `unagi.amazon.co.jp`. `server: Server` alone cannot identify CloudFront/Akamai or another vendor.
A region cookie indicated Australia, so displays/challenges may vary by region/egress.

Unauthenticated HTML/JS established OpenID redirects and generic AUI runtime, but did not yield order/gift/points
read endpoints or schemas. Static analysis of public bundles, redacted network observation in the owner's browser,
and static analysis of official APKs obtained from an owned device are legitimate next research stages.
However, do not adopt automated CAPTCHA solving, fingerprint spoofing, rate-limit bypass, parameters disabling
encryption/obfuscation, or TLS pinning/attestation bypass.

The official Android package is `com.amazon.mShop.android.shopping`. Obtaining APKs including splits from
an owned device and examining signatures, manifests, deep links, network security config, hosts/paths/schemas,
and WebView/native boundaries is worthwhile. Classify discovered write endpoints by name only; do not generate
or send payloads. Cloud emulation of the entire Amazon app is expensive given device trust, large bundles,
and frequent updates.

## 6. Concrete third-party client transport/auth

### `furyutei/amzOrderHistoryFilter`

The [repository](https://github.com/furyutei/amzOrderHistoryFilter) is a userscript running on amazon.co.jp
order history. It uses existing browser cookies as ambient authority, `fetch`es same-origin HTML,
iterates `/your-orders/orders` with `startIndex` 0,10,20..., and parses/prints DOM order cards and receipt
screens. This is concrete implementation evidence of 10 orders per page, not an official API or token auth.
No clear repository license was found; do not import the code. Its `disableCsd=missing-library` proposal also
appears intended to weaken display protection, so Kogane does not use it under the prohibition on security-control bypass.

### `yossyl3oy/amazon2mfcloud`

The [repository](https://github.com/yossyl3oy/amazon2mfcloud) is a browser extension reading logged-in order
history DOM. It `fetch(...,{credentials:'include'})`s
`GET /your-orders/orders?timeFilter=year-YYYY&startIndex=N` and parses HTML with `DOMParser`.
It implements neither a dedicated API token nor password login, relying on the browser session. Its design
of forwarding order numbers, product names, and amounts to external accounting conflicts with Kogane's
minimal retention policy, and its license is unverified; adopt only the transport evidence.

Amazon Selling Partner API, Product Advertising API, and Amazon Pay API target sellers/advertising/Amazon Pay
merchants; do not repurpose them as consumer APIs for personal buyers' order/gift/points history. No maintained
consumer client reliably retrieving gift balances/points was found among public third-party implementations either.

## 7. Read/write isolation

- The allowlist is generally `GET www.amazon.co.jp/your-orders/orders` and read-only details/exports established after observation.
- Sign-in POSTs during browser bootstrap are an owner-operated authentication boundary, outside collector transport.
- Deny cancel, return, buy-again, checkout, gift-card redeem/reload, point use, address/payment/profile/security
  regardless of method, and do not click the corresponding controls.
- Do not save/send CSRF tokens: they are confidential session material indicating potential writes. Give the read client no generic POST capability.
- Rate: one connection, sequential requests, ample intervals, conditional/incremental reads. Stop on 403/429, CAPTCHA, challenges, or schema mismatches.
- If raw evidence is needed, keep it only in an encrypted temporary area on the owner's device, retaining only schemas/hashes/counts after PII redaction.

## 8. Runtime suitability

| Runtime                 | Suitability           | Assessment                                                                                                                          |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Local browser/WSL       | Best                  | Suitable for passkey/MFA handoff, same-origin session observation, and manual export                                                |
| Cloudflare Workers      | Conditional           | Established GET replay and parsing are possible; unsuitable for browsers/passkeys, cookie management, and Amazon egress differences |
| Cloudflare Containers   | Suitable              | Can isolate browser/parser. Keep sessions out of images/logs; use secret store + tmpfs and egress allowlists                        |
| OCI container           | Suitable              | Easy to assemble digest-pinned browsers, Cron, encrypted sessions, and read-only FS. Verify egress reauthentication                 |
| Kubernetes              | Excessive             | CronJob/Secret/NetworkPolicy fit, but operational cost is high for a single account                                                 |
| Physical Android device | Suitable for research | Needed for official app displays/APKs/owner-operated read-only tracing. Routine UI automation is fragile                            |

## 9. PR #5 common A-E / Cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper, 5 = device-bound/adversarial

| Route                                                                 |       Level | Cost | Assessment                                                                            |
| --------------------------------------------------------------------- | ----------: | ---: | ------------------------------------------------------------------------------------- |
| Manually obtain per-order receipts/Privacy Central and import offline |           E |  1-2 | Official and safe; not incremental automation                                         |
| Iterate same-origin order HTML in a logged-in browser                 |           D |    3 | Public implementation exists; watch PII/write UI/session changes                      |
| Headless order GET replay after local bootstrap                       | C candidate |  3-4 | Concrete endpoint; not B until session renewal/WAF/reauthentication are verified live |
| Gift balance/points internal read replay                              | C candidate |    4 | Endpoints/schema/pagination unverified; balance change states need verification       |
| Amazon Shopping app UI/device automation                              |           D |    5 | Device trust, screen changes, write paths, broad permissions                          |
| Official scheduled API for buyers                                     |  No A route |    5 | No consumer order/gift/points API established                                         |

Overall **C candidate/cost 4**; safe initial route **E/cost 1-2**. Public implementations make the path to C
concrete for order history alone, but gift/points remain closer to D.

## 10. Read-only live verification and stop conditions

1. Check only Amazon.co.jp domain, TLS, and login method in an ordinary browser. The owner handles passkeys/OTPs; do not record values.
2. In order history, record only filter options, earliest year, rows per page, pagination, and order/item/delivery/refund field names.
3. Check receipt/purchase statement controls and formats for one existing order, without saving file contents, order numbers, or actual amounts.
4. On the gift balance page, check only history column names, period filters, counts, pagination, expiry fields, and export availability.
5. On the points page, check only available/pending/limited-time categories, history columns, individual expiry dates, and pagination/export availability.
6. Retain only hosts/paths/methods/statuses, header names, and redacted JSON keys/DOM selectors from DevTools. Initially GET only.
7. Reread one order GET in the same browser, then replay once from the same host with an encrypted session. Try OCI only after success.
8. Only if the app offers granularity absent on Web, verify signatures of official splits from an owned device,
   analyze them statically, and observe read-only refresh during owner operation. If pinning/attestation hides it,
   record the barrier without bypassing it.

Immediate stop: possible purchase/order confirmation/reordering/gift use/point use/settings changes,
POST/PUT/PATCH/DELETE, unknown hosts, OTP/CAPTCHA/recovery, 403/429, account lock warnings, schema drift,
PII redaction failure, device/egress-bound sessions, or terms/technical controls explicitly rejecting automated
retrieval. Return to manual export after stopping.

## 11. Established facts, hypotheses, and unverified items

**Established facts:** Amazon order history/gift balance/Privacy Central redirect unauthenticated requests
to Amazon sign-in through OpenID. Public order history implementations use ambient browser cookies,
same-origin HTML, and `timeFilter`/`startIndex`. Amazon Mastercard statements belong to the SMBC/Vpass
boundary. No official scheduled buyer API established.

**Hypotheses:** Order GET session replay is likely feasible after local bootstrap. Gift/points may share
the same account session, but require individual verification because `assoc_handle`/reauthentication strength
differ. Reconciliation of orders and card statements is candidate matching rather than a deterministic join.

**Unverified:** Earliest year/total rows in the current UI; gift/points retention, pagination, exports;
Privacy Central schemas; passkey RP ID/Bitwarden compatibility; 2SV/trusted-device/session lifetimes;
internal read endpoints; WAF vendor; app pinning/attestation; precise refund transitions in each balance;
and the scope of Amazon Mastercard/Amazon account linkage displays.
