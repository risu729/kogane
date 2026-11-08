# J-Coin Pay source assessment

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26

## 1. Scope / non-goals

Investigate read-only collection feasibility for J-Coin Pay consumer wallet balances, payments, transfers,
top-ups, returns to bank accounts, bank connections, and transaction history. Do not make payments, transfers,
top-ups, bank returns, account additions, identity verification applications, or settings changes. Do not store
secrets, phone numbers, names, account information, device IDs, tokens, actual balances/transactions;
do not bypass security controls.

J-Coin Pay is a wallet provided by みずほ銀行 (Mizuho Bank), but **is not a Mizuho Bank account itself**.
This source covers J-Coin balances/history; ordinary deposit balances, bank passbooks, transfers, and
account-specific statements belong to each bank source. Top-ups/returns involving participating banks may
appear on both sides; reconcile J-Coin wallet events with bank deposit/withdrawal events without double counting.
Use the same boundary for connected banks other than Mizuho.

## 2. Research method and official sources

- Prioritized official J-Coin Pay, Mizuho Bank, participating banks' FAQs, terms, and Google Play listing.
- Observed only public host statuses/headers via unauthenticated HEAD/GET from WSL. No login or app operation.
- Searched GitHub code/repositories by package ID and service name for consumer clients.
- Did not retrieve/decompile APKs or make authenticated dynamic captures; defined concrete follow-up experiments.

Main URLs:

- [Official J-Coin Pay](https://j-coin.jp/)
- [Official usage guide](https://j-coin.jp/user/guide/)
- [Safety initiatives](https://j-coin.jp/security/)
- [User terms](https://j-coin.jp/user/terms/)
- [Mizuho Bank J-Coin Pay](https://www.mizuhobank.co.jp/jcoinpay/index.html)
- [Google Play](https://play.google.com/store/apps/details?id=jp.co.bluelab.jcoin.user&hl=ja)
- [Transaction history up to 10 years back](https://faq.chugin.co.jp/hc/ja/articles/32829869067929)
- [No statement issuance/printing](https://faq.chugin.co.jp/hc/ja/articles/32829848278041)
- [Unreceived transfers: 72 hours](https://faq.chugin.co.jp/hc/ja/articles/32829863762969)
- [When identity verification is required](https://faq.chugin.co.jp/hc/ja/articles/32829863383705)

## 3. Official app/Web and read scope

| Surface                    | Read scope                                                    | Granularity/state                                                                     | Period/count/export                                                              | Tradeoff                                                  |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| J-Coin Pay app home        | J-Coin balance, connected accounts, main feature entry points | Per wallet; not authoritative bank balances                                           | Balance snapshot                                                                 | Official authoritative record, tied to Android/iOS device |
| App transaction history    | Payments, transfers/receipts, top-ups, bank returns, etc.     | Events; exact counterparty/merchant, datetime, amount, state schema not verified live | Participating bank FAQ says up to 10 years; counts/pagination/filters unverified | Strong long-term retention, no CSV/PDF/print              |
| Payment details            | Store payments and cancellation/refund states                 | Appears generally immediate balance deduction; pending/settled fields unverified      | In-app display only                                                              | Separate from merchant/card receipts                      |
| Transfer details           | Transfers, awaiting receipt, received, expiry returns         | Awaiting receipt is pending; unreceived after 72 hours returns to sender balance      | In-app display only                                                              | May track pending → settled/returned                      |
| Top-up/bank return details | Connected bank ↔ J-Coin wallet movements                      | J-Coin-side events, separate from bank posting time                                   | In-app display only                                                              | Deduplication needed across sources                       |
| Official public Web        | Descriptions, guides, terms, campaigns, merchant information  | Not account ledger                                                                    | Public material                                                                  | Consumer account role of `web.jcoin-pay.jp` unverified    |
| Connected bank app/Web     | Deposit balances/passbook statements                          | Bank-side settled/pending rules                                                       | Per bank source                                                                  | Does not replace J-Coin counterparty/merchant details     |

Official participating bank FAQs explicitly allow history up to 10 years back but no transaction statement
issuance/printing. Public information establishes no CSV, PDF, OFX, or API export. Thus 10 years is UI retention,
not proof that all rows can be retrieved in one operation or without pagination.

Pending/settled is not a single state system. Unreceived transfers have an explicit 72-hour pending state,
then return on expiry. Check store payment cancellation/refund, bank top-up/return processing/failed/completed,
and received-transfer status names/timestamps against live schemas. Do not infer settlement solely from
ordering or balance differences.

## 4. Bank connections and identity verification boundary

Participating bank account registration, first top-up, additional accounts, name changes, and limit increases
may require identity verification. Bank selection may lead to bank-specific authentication, registered phone/SMS,
account information, etc.; separate J-Coin sessions from bank credentials/sessions. Kogane reads only general
displays of already registered accounts; do not initiate additions, reauthentication, or first top-ups.

When reconciling J-Coin top-ups/returns with bank passbooks, check existence of wallet event IDs/bank references
as schemas without saving values. Without stable IDs, use datetime/sign/amount candidate matches, not definitive
joins. Do not assume J-Coin app exposes complete balances/passbooks of bank accounts.

## 5. Authentication, MFA, passkeys, and Bitwarden

Public guide/security information suggests phone/SMS authentication, identity verification, app passcodes,
biometrics, and lost-device measures are major boundaries. Exact registration/login flows, SMS re-request
conditions, passcode length, device binding, and token refresh are unverified in the current app.
No official source establishing passkey support was found; record unverified rather than unsupported.

Bitwarden can manage passwords/passkeys, but does not replace J-Coin app SMS, device biometrics, device-bound
keys, or bank authentication. Existing stored J-Coin credentials were not checked either. Do not pass vaults,
OTP seeds, bank logins, app passcodes, or tokens to cloud/runtimes. Authenticate initially/after expiry on
the owner's device; consider source-scoped encrypted envelopes only if read-only session replay is feasible.

## 6. WAF / JS / APK / reverse engineering

WSL observations on 2026-08-26: `j-coin.jp` and Mizuho Bank's J-Coin page returned HTTP 403,
`Server: AkamaiGHost`; `web.jcoin-pay.jp` returned HTTP/2 403, `server: awselb/2.0`. These are public edge
results for the current IP/HTTP client, not proof of app API vendors, block reasons, or shared policies.
First compare ordinary browser/Japan egress differences; do not bypass 403, challenges, or rate limits.

Official Android package: `jp.co.bluelab.jcoin.user`. Obtain base/splits from an owned device or legitimate
Google Play flow; record all APK signatures and versions/hashes. Examine manifest/permissions/components
with `apkanalyzer`/`aapt2`, strings/resources/DEX with JADX/apktool, native libraries with `readelf`/strings.
For R8/ProGuard obfuscation, correlate resource names, Retrofit/OkHttp annotations, JSON/protobuf keys,
certificate/network config, and call graphs. Do not fabricate mappings; symbols not confirmed dynamically
remain hypotheses.

Research targets: read hosts/paths/methods, request/response keys, pagination/cursors, history types/statuses,
access/refresh token lifecycle, device/integrity metadata, pinning/attestation, WebView/native boundaries.
Classify write hosts/paths without generating payloads. During one runtime observation of the owner opening
existing history, retain only hosts/paths/statuses, header names, and redacted keys. If TLS pinning/attestation
prevents observation, do not remove it or hook around it; record the barrier.

## 7. Third-party clients / transport

GitHub searches for `J-Coin Pay`, package ID, and service names found no public consumer balance/history
client, SDK wrapper, or login/session implementation. Package ID results were mainly GrapheneOS compatibility
articles and old app inventories, not transport/auth evidence. This is negative evidence at search time,
not proof of nonexistence.

Merchant J-Coin payment connections, processor CSV/APIs, and bank-side services have separate contracts/auth
from consumer wallet sessions; do not repurpose them as personal wallet history APIs. Without public third-party
clients, concrete transport is established only through official APK static analysis and redacted owner-operated observation.

## 8. Read/write isolation

- Initial collector allowlist: only history lists/details and balance GET equivalents, by host+path. Do not classify reads by HTTP method alone.
- Always deny payment QR generation/scanning, transfers, receipt operations, top-ups, bank returns, account registration, identity verification, settings, membership termination.
- Do not automatically launch app deep links/intents; on entering write screens, stop/discard without even automated back navigation.
- Read endpoints may contain CSRF/nonces or write-scope tokens; provide no generic HTTP client/arbitrary paths.
- Raw captures only in encrypted temporary device storage. Redact PII/actual values; retain only schemas, counts, timestamp ranges.
- Stop immediately on 401/403/409/429, SMS/identity verification, device re-registration, unknown certificates/hosts, schema drift.

## 9. Runtime suitability

| Runtime               | Suitability                         | Assessment                                                                                                       |
| --------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Owned Android device  | Best for research/official displays | Needed for SMS/biometrics/device state, legitimate APKs, read-only observation; routine UI automation is fragile |
| Local Windows/WSL     | Suitable for parsers                | Redacted artifact processing, APK static analysis; cannot bootstrap app/sessions                                 |
| Cloudflare Workers    | Low to conditional                  | Fetch possible for proven token replay; unsuitable for device auth/pinning, binary protocols, secret management  |
| Cloudflare Containers | Conditional                         | Can isolate full Linux parsers/proxies, but provides no Android/device trust                                     |
| OCI container         | Conditional                         | Digest pinning, secret stores, egress allowlists facilitate replay experiments                                   |
| Kubernetes            | Excessive                           | CronJob/Secret/NetworkPolicy possible, but operational cost excessive for one wallet                             |

## 10. PR #5 common A-E / cost

- A: direct documented/export API suitable for scheduled headless use
- B: stable read-only internal API with renewable/reusable session
- C: browser/app bootstrap + headless replay plausible
- D: full browser/device automation probably required
- E: manual capture remains safe default
- Cost: 1 = small wrapper, 5 = device-bound/adversarial

| Route                                                   |       Level | Cost | Assessment                                                                 |
| ------------------------------------------------------- | ----------: | ---: | -------------------------------------------------------------------------- |
| Manually inspect app history, record only schema/counts |           E |    1 | Safe, but no export; insufficient for actual data collection               |
| Local UI capture of app screens                         |           D |    4 | 10-year history useful, but pagination/screen changes/PII redaction costly |
| Read-only API replay after app bootstrap                | C candidate |  4-5 | Transport/token/device binding unverified; C only after verification       |
| Stable read API + renewable session                     | B candidate |    4 | No current evidence; APK/runtime experiments needed                        |
| Documented consumer API/export                          |  No A route |    5 | No CSV/PDF/print/API                                                       |

Overall **D/cost 4**; safe default **E/cost 1**. Raise to C if static/dynamic research establishes
read APIs, renewable sessions, and read/write scopes.

## 11. Read-only live verification and stop conditions

1. On an owned device, check only package/version/signer, app lock method, and registered bank count; retain no values/bank numbers.
2. On home, check only displayed field names, balance update time, and whether connected accounts show bank balances.
3. Record history filters/types/statuses, rows per display, scrolling/cursors, earliest year, detail fields, and how to reach 10 years, without actual values.
4. If existing history includes unreceived/expired/refunded/failed entries, check only status names. Do not create transactions.
5. Recheck absence of export/share/print controls in the current app. Do not execute OS screenshots/sharing either, because actual values would leak.
6. Verify legitimate split APK signatures and analyze statically. Separate candidate read/write endpoints into allow/deny tables.
7. Observe redacted network metadata once while the owner opens existing history. Stop at the first unknown path or write candidate.
8. If replayable reads are found, try once each: same device → same local host → OCI. If device/integrity-bound,
   abandon cloud use and return to local manual/UI routes.

Stop conditions: payment/transfer/top-up/bank return/account addition/settings controls, SMS/identity verification/bank
authentication, PIN/biometrics requests, security warnings, certificate pinning, attestation, 403/429, account locks,
unknown hosts, PII redaction failure, method/schema mismatches. Do not disable security controls; record
inability to observe as the accurate result.

## 12. Established facts, hypotheses, and unverified items

**Established facts:** App package; official app-centered balance/payment/transfer/top-up/bank return routes;
10-year history; no statement issuance/printing; return of unreceived transfers after 72 hours; operations
that may require identity verification; public host Akamai/AWS LB 403s; no public consumer client found.

**Hypotheses:** The app should have balance/history read transport and pagination, but hosts/paths/schemas/token
methods are unverified. Bank top-ups/returns likely have corresponding events in both J-Coin and bank ledgers.

**Unverified:** Complete history types/statuses/fields, page sizes/cursors, settlement timestamps, refunds,
balance update frequency, export/share, passkeys, Bitwarden compatibility, SMS/device binding, token renewal,
API pinning/attestation, WebView boundaries, consumer account role of `web.jcoin-pay.jp`, authentication differences
among participating banks.
