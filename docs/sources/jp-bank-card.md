# JP BANK Card WEB source research

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

Research date: 2026-08-26 (Australia/Sydney)

## Conclusion

- This document covers **JP BANK Card WEB for JP BANK VISA / Mastercard**. JP BANK JCB / EXTAGE leads to MyJCB, a separate source family; do not mix them.
- JP BANK Card WEB is a card ledger, not ゆうちょ銀行 (Japan Post Bank) account balances/deposit-withdrawal statements. Retain merchant-level card statements and the single monthly account debit as separate observations; reconcile downstream.
- Official Web offers next payment amount, available credit, the latest 15 months of usage statements, confirmed WEB statements, points balances, etc. Official pages describe statement data download/printing; past sanitized read-only observations found a CSV control. Native PDF unverified; browser print-to-PDF is not a bank-issued PDF.
- Official login uses ID/password. The old `One Time Pass` app was for online shopping authentication, not evidence of ordinary login MFA. Passkeys/WebAuthn, Bitwarden support, device binding, risk-based extra authentication are unverified.
- Login host is behind Akamai; this non-browser HEAD returned 403. Current common assessment: **D / cost 4**; safe initial route: **manual CSV: E / cost 1**. Advance to **C / cost 4 candidate** only after measuring read-only transport/reusable sessions.
- Do not categorically exclude reverse engineering. Fill gaps in official material through public HTML/JS static analysis, authenticated browser redacted network observation, and official APK static/dynamic analysis if needed. Prohibited: transactions/writes, secrets/PII retention, security-control bypass.

## Research safety boundaries

Used public official pages/terms as main sources; checked unauthenticated HTTP/DNS, GitHub code search,
and public third-party source read-only. No login in this research pass.

Did not retrieve/record secrets, PII, or actual values: account numbers, card/member numbers, card suffixes,
names, email, IDs/passwords, cookies, OTPs, tokens, balances, usage amounts, merchants, transaction statements,
etc. Production collectors must also keep them out of logs, screenshots, HARs, DOM dumps, fixtures, CI artifacts, Git.

Collector permissions are limited to existing session checks, generalized card type enumeration, current/confirmed
statements, available credit, read-only balances, points balance/expiry/history, existing statement download/print,
and logout. No registration, applications, payments, changes, exchanges, cancellation, restriction settings, etc.

Evidence confidence:

- **Established:** explicit official material or direct observation at unauthenticated endpoints.
- **Observed:** past sanitized read-only browser observations; subject to rechecking because not public specifications.
- **Hypothesis:** consistent with adjacent platforms etc., but not demonstrated in JP BANK Card WEB itself.
- **Unverified:** requires bounded read-only live verification.

## 1. Source family and card enumeration

### In/out of scope

The [official JP BANK Card WEB explanation](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb.html)
explicitly targets VISA/Mastercard members. The [Japan Post Bank card home](https://www.jp-bank.japanpost.jp/kojin/card/credit/kj_crd_cdt_top_index.html)
also separates VISA/Mastercard into JP BANK Card WEB and JCB into MyJCB.

| Source                                                                | Scope                                         | Treatment here                             |
| --------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------ |
| JP BANK Card WEB                                                      | JP BANK VISA / Mastercard                     | In scope                                   |
| MyJCB                                                                 | JP BANK JCB / EXTAGE etc.                     | Separate source, out of scope              |
| ゆうちょダイレクト (Yucho Direct) / ゆうちょ通帳 (Yucho Passbook) app | Deposit account balances/deposits-withdrawals | Separate source; debit reconciliation only |

### Primary member root

The [card comparison](https://www.jp-bank.japanpost.jp/kojin/card/credit/lineup/kj_crd_cdt_lu_popup.html)
and [ordinary cards](https://www.jp-bank.japanpost.jp/kojin/card/credit/lineup/ippan/kj_crd_cdt_lu_ipn_index.html)
establish at least the following.

| Product family                          | Brand           | Form                                                                | State       |
| --------------------------------------- | --------------- | ------------------------------------------------------------------- | ----------- |
| JP BANK VISA ALente                     | Visa            | Combined cash/credit or standalone, depending on product conditions | Established |
| JP BANK VISA/Mastercard 一般 (ordinary) | Visa/Mastercard | Combined/standalone                                                 | Established |
| JP BANK VISA/Mastercard ゴールド (Gold) | Visa/Mastercard | Product-specific combined/standalone                                | Established |

Retain only internally generated opaque `card_root_id` and generalized `product_family` / `brand`,
not raw card names/numbers/suffixes/cardholders.

### Family, ETC, and additional cards

- Official ordinary-card pages allow one combined family card for combined-card primary members, and multiple standalone family cards for standalone primary members.
- [Additional cards/services](https://www.jp-bank.japanpost.jp/kojin/card/credit/futai/kj_crd_cdt_fti_index.html) and [VISA/Mastercard services](https://www.jp-bank.japanpost.jp/kojin/card/credit/lineup/vmservice/kj_crd_cdt_lu_vsv_index.html) list family, ETC, iD, PiTaPa, WAON, Plus EX, etc. This source covers their usage only when it appears in the card ledger.
- [WEB statement application guidance](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/wm_mail_top.html) targets primary members; [JP BANK Card WEB special terms](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb05.html) also allow limited use by family members.
- How primary member statements/CSV distinguish family/ETC—dedicated columns, card names, masked numbers, or cardholders—is unverified.

Data model: `instrument_kind = primary | family | etc | other_addon | unknown`. Without a stable non-PII
discriminator, retain `unknown` under the root. Do not derive permanent IDs from display names/suffixes.

## 2. Balances, statements, confirmed/pending, and granularity

### Officially established scope

[Available services](https://wwws.jp-bank.japanpost.jp/credit2/service/cardweb01.html) explicitly list:

- Next payment amount.
- Latest 15 months of usage statements.
- Current available credit.
- Card usage WEB statements.
- JP バンクカードポイント (JP Bank Card Points) balances/exchange requests.
- Revolving/installment inquiry/changes, extra payments, cash advances.

The last group has adjacent reads/writes. Allowlist only balance/expected amount inquiries; do not touch
change/payment/application controls.

### Statement row granularity

The [statement guide](https://wwws.jp-bank.japanpost.jp/credit2/member/meisai_guide.html) describes:

- Usage date, merchant name, usage amount.
- Payment classification, installment count, current installment number.
- Scheduled payments for installments/revolving/cash advances etc.
- Markers such as `#` (eligible for later revolving conversion), `B` (eligible for later installment conversion).
- Points eligibility display.
- Conversion-related information for overseas use.

Usage date is the displayed date for usage whose sales slips/data arrived after the previous notification,
not necessarily the actual authorization timestamp. Retain source semantics as `use_date`; invent no other timestamps.

Recommended schema: `source_cycle`, `source_status`, `use_date`, `merchant_raw`, `amount`, `currency`,
`payment_category`, `installment_count`, `scheduled_payment`, `point_eligible`, `instrument_kind`, `source_row_hash`.
Handle merchants/amounts only in private encrypted stores; use synthetic test fixtures.

### Current, confirmed, cancellations/refunds

- [WEB statement flow](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_flow.html) and [notification timing](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_mail.html) say a notification is sent once per bill after payment confirmation, offering paper-equivalent WEB statements. No notification without a next bill.
- [FAQ](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_faq.html) says later revolving changes etc. can update that statement at the beginning of the next month. Do not treat downloaded statements as unconditionally immutable.
- Separation of current statements and confirmed WEB statements in authenticated screens was observed; recheck current specifications.
- Authorization pending rows, pending/posted labels, keys after sales arrival, merchant name changes, cancellations, refunds, negative/correction rows, original transaction links are unverified.

Conservatively upsert current cycles as provisional; use confirmed cycle snapshots as the billed record basis.
Do not identify refunds solely by signs/merchant names.

## 3. Periods, counts, CSV/PDF/exports

| Item                         | Finding                                               | Confidence                 |
| ---------------------------- | ----------------------------------------------------- | -------------------------- |
| History period               | Latest 15 months                                      | Officially established     |
| Division                     | Per bill/month                                        | Officially established     |
| Rows per display, pagination | Not publicly described                                | Unverified                 |
| Statement data download      | Available                                             | Officially established     |
| CSV                          | Control found in past sanitized logged-in observation | Observed; needs rechecking |
| CSV encoding/schema          | Not publicly described                                | Unverified                 |
| Native PDF download          | No evidence established                               | Unverified                 |
| Printing/browser PDF         | Printing official; PDF is browser rendering           | Printing established       |
| OFX/QIF                      | No official route established                         | No evidence                |

[WEB statement guidance](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_about.html) describes
page printing and statement data download. [Special terms](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb05.html)
say the bank specifies download formats etc., but public guidance does not name the format. CSV is therefore
a strong implementation candidate, not a documented API contract. Label browser print-to-PDF `rendered copy`,
not bank-issued PDF.

During live verification, record only filename patterns, MIME, encoding, headers, quoting, line endings,
date/amount formats, empty months, maximum rows, pagination. Hash raw exports in a private inbox before parsing;
encrypt/delete under retention policy. Do not put them in Git.

## 4. Points

[Points rules](https://wwws.jp-bank.japanpost.jp/credit2/service/point/point.html) and the
[points screen](https://wwws.jp-bank.japanpost.jp/credit2/service/point/index.html) establish:

- Ordinary/ALente: one point per JPY 1,000 shopping; Gold: two points.
- Expiry two years from accrual month.
- Current balance, expiry, and exchanges accepted through JP BANK Card WEB can be queried.
- Statements also include points information.

Points exchange/cashback/transfers to other points are prohibited writes. Attribution of family/ETC usage
by member is unverified; initially observe at card root level.

## 5. Authentication, MFA, devices, passkeys, and Bitwarden

### Established

- [Login](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb02.html) uses registered ID/password.
- [Supported environment](https://wwws.jp-bank.japanpost.jp/credit1/kankyo.html) uses JavaScript/cookies, recommends current Edge/Firefox/Chrome on Windows and current Safari on macOS.
- New registration, re-registration, password recovery/change are write flows involving card/contact information; collectors do not perform them.
- Family members have limited features.
- The [old One Time Pass app](https://wwws.jp-bank.japanpost.jp/credit2/update/otp.html) displays 60-second OTPs for online shopping; guidance says phased unavailability from April 2024, transitioning to email OTP.
- [OTP special terms](https://wwws.jp-bank.japanpost.jp/credit2/update/otp_kiyaku.html) explicitly separate shopping OTP from JP BANK Card WEB login passwords. Do not regard 3-D Secure OTP as read-only login MFA.

### Separating facts and hypotheses

- **Login MFA/device binding:** risk-based email/SMS, extra checks, remembered-device cookies, concurrent session limits, rotation are unverified.
- **Passkeys:** official material did not establish WebAuthn/passkeys. Do not assert future non-support. Apple Pay Face ID/Touch ID is payment authentication, not WEB login passkeys.
- **Bitwarden:** no official relationship. Autofill for ordinary ID/password forms is plausible but untested. Do not assume Bitwarden passkey storage until WebAuthn is established.
- **App biometrics:** no current statement app established, hence no relationship to WEB login either.

Credentials reference existing user-created secret records without logging values. Encrypt session state;
make it host-bound and erasable per source if possible. Unexpected OTP, recovery, device registration require
user handoff/stop, not permission for automated email retrieval or authentication weakening.

## 6. Web/app and next-stage static/dynamic analysis

JP BANK Card WEB is browser-accessible, not app-only. No current first-party statement app was established
from official routes. The old One Time Pass app was for 3-D Secure; legacy JP BANK Card iD app for payment
settings, not statement collection.

Where public material is insufficient, proceed in this order.

1. **Public HTML/JS static analysis:** record loaded scripts' URLs/hashes, module names, form actions, download links, route shapes. Do not discover write endpoints not exposed by pages.
2. **Authenticated browser dynamic observation:** in existing-session DevTools, record only card list, month selection, statements, points reads, CSV download methods/origins/path templates/statuses/content-types/redirects/redacted response shapes. Save no bodies, cookies, tokens, IDs, names, balances, merchants, raw responses.
3. **Read-only replay decision:** try only one request classified idempotent in the same browser session. Stop on CSRF shared with writes, unknown semantics, challenges, or possible state changes.
4. **APK if a current official app is found:** obtain from official store or owner-provided package, record package/version/signing certificate hash/APK hash. Statically inspect manifest, network security config, hostnames, transport libraries, response models with `aapt`, `apkanalyzer`, `jadx`, MobSF etc.; dynamically observe read-only calls on owner-controlled devices. Record certificate pinning/device attestation without bypassing.

Reverse engineering, APK/JS analysis, and traffic observation themselves are neither non-goals nor prohibited.
Security-control modification/bypass, CAPTCHA solving, stealth/fingerprint spoofing, rate-limit bypass,
write calls, and secrets/PII retention are prohibited.

## 7. CDN/WAF/Akamai/anti-bot

Read-only observations on 2026-08-26: HEAD to `https://www.jp-bank-card.jp/` returned `403 Forbidden`,
`Server: AkamaiGHost`, `AKAMAI` edge headers; DNS resolved to `dsca.akamaiedge.net`. Public documentation
hosts returned 200 but likewise resolved to Akamai edge.

This establishes Akamai fronting and rejection of non-browser requests in this environment. One 403 does not
establish Bot Manager, WAF rules, device fingerprints, rate policies, or API gateway products. Independent
API gateway hosts are unverified.

Stop on 403/429, challenges/interstitials, CAPTCHA, redirect loops, extra login verification, device enrollment.
Do not spoof UA, synthesize Akamai cookies, solve challenges, rotate IPs, or otherwise bypass. The next
legitimate route is the officially recommended browser with user handoff.

## 8. Public third-party clients and concrete transport/auth

GitHub code search found no public client targeting JP BANK Card hosts. The two below target adjacent
SMBC/Vpass platforms, not direct JP BANK Card evidence.

### `braineo/smbcCardSpider`

The [GPL-2.0 repository](https://github.com/braineo/smbcCardSpider), last pushed in 2016, uses
`requests.Session`, ID/password, JSON POST. Its [source](https://github.com/braineo/smbcCardSpider/blob/bb3c4798a96c55934ed2a9a58d6cea25f59acb98/SMBC_card.py)
contains these SMBC host endpoints.

- `/memapi/jaxrs/xt_login/agree/v1`: login.
- `/memapi/jaxrs/web_meisai/web_meisai_top/v1`: statements.
- `/memapi/jaxrs/multicard/dropdownlist_init/v1`: card list.
- `/memapi/jaxrs/multicard/operation_card_update/v1`: selected card switching.

Payload envelopes include request timestamps/hashes, retaining cookie sessions. This is old SMBC code;
the same paths need not exist at JP BANK Card origins.

### `4noha/openmoney` Vpass plugin

The [repository](https://github.com/4noha/openmoney) is public 2026 code with no license displayed.
Its [Vpass plugin](https://github.com/4noha/openmoney/blob/21f33ca84bc114c2cfd0e3eacbdfacebc7838abd/plugins/vpass/scraper.py)
uses Playwright to open SMBC `/memx/web_meisai/top/index.html`, select months, download through
`CSV形式で保存する` ("save in CSV format"), parse Shift-JIS CSV, and fall back to HTML tables on failure.
It also implements waiting for Akamai `_abck` cookies and manual OTP.

Do not reuse screenshots, raw environment credentials, automation detection changes, or SMBC selectors in
this collector. Shift-JIS, 13 months, routes/selectors are not JP BANK Card specifications either.

### Assessment

Adjacent Vpass implementations align with the `/memx/web_meisai/top/index.html` route family observed in
authenticated JP BANK Card screens, suggesting related backends. Promoting `/memapi/jaxrs` transport,
session reuse, or card switching to established JP BANK Card facts requires redacted read-only network
observations at JP BANK Card origins.

## 9. Read/write isolation

Use route/action allowlists, not blocklists. Initial allowlist only:

- Session status, generalized card/root lists.
- Current/confirmed statements, month selection confirmed idempotent.
- Known statement data download/print.
- Available credit, read-only balances/schedules.
- Points balance/expiry/exchange history inquiries.
- Logout.

Explicitly deny:

- JP BANK Card WEB / WEB statement registration/cancellation.
- ID/password/email/address/debit account etc. changes.
- Later revolving/installment conversion, extra/early payments, payment plan changes.
- Cash advances.
- Points exchange/cashback/transfers.
- Limit increases, usage restriction settings.
- Family/ETC/iD/PiTaPa/WAON/Plus EX etc. applications.
- 3-D Secure payments, Apple Pay etc. provisioning, campaign entry, purchases/payments.

Reads may use POST; do not classify writes by HTTP method alone. Deny semantically unknown POSTs; if the
same endpoint accepts read/write actions, do not automate until exact read requests can be classified/guarded.

## 10. Workers / Browser Run / Containers / OCI / Kubernetes

| Runtime                              | Suitability             | Assessment                                                                                  |
| ------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------- |
| Cloudflare Workers `fetch` only      | Low                     | Non-browser requests receive Akamai 403; cannot provide ordinary browser/bootstrap          |
| Cloudflare Browser Run               | Verification candidate  | Puppeteer/Playwright/CDP session reuse possible; cloud egress/Akamai acceptance unproven    |
| Cloudflare Containers                | Technically possible    | `linux/amd64` full browsers/parsers run, but login handoff, egress identity, WAF unresolved |
| OCI image on controlled host         | Suitable packaging      | Reproducible browser/parser; sessions need host-bound encrypted stores                      |
| Kubernetes                           | Possible but excessive  | Scheduled Pods possible, with more secret/egress/storage/concurrency operations             |
| Local officially recommended browser | Best initial experiment | Visible handoff, local credentials, CSV download; closest to official environment           |

[Cloudflare Browser Run](https://developers.cloudflare.com/browser-run/features/reuse-sessions/) describes
reconnectable sessions; [session management](https://developers.cloudflare.com/browser-run/cdp/session-management/)
describes keep-alive. [Cloudflare Containers](https://developers.cloudflare.com/containers/platform-details/architecture/)
describes isolated VMs and `linux/amd64` images. [OCI Image Specification](https://specs.opencontainers.org/image-spec/)
and [Kubernetes Images](https://kubernetes.io/docs/concepts/containers/images/) support portable image/container
execution. Runtime capability does not establish that origins accept automation.

## 11. Common A–E / cost assessment

Use PR #5 definitions unchanged.

- **A:** direct documented/export API suitable for scheduled headless use.
- **B:** stable read-only internal API with renewable/reusable session.
- **C:** browser/app bootstrap + headless replay plausible.
- **D:** full browser/device automation probably required.
- **E:** manual capture remains safe default.
- Cost ranges from 1 (small wrapper) to 5 (device-bound/adversarial).

| Route                                                       | Level       | Cost | Assessment                                                                   |
| ----------------------------------------------------------- | ----------- | ---: | ---------------------------------------------------------------------------- |
| Manual confirmed statement data/CSV download → local import | E           |    1 | Current recommendation; recheck CSV format                                   |
| Manual browser print-to-PDF → import                        | E           |    2 | Unstructured fallback, not native bank PDF                                   |
| Visible local browser login + controlled CSV download       | D           |    3 | Requires human handoff, selectors, session challenges, subcard/schema checks |
| Read-only replay after browser bootstrap                    | C candidate |    4 | Adjacent transport exists, but JP BANK Card endpoints/sessions unverified    |
| Unattended login from cloud/containers                      | D           |    5 | Full browser/Akamai handling needed; brittle                                 |

**Current source assessment: D / cost 4.** Unattended collectors likely require full browsers. Update to
**C / cost 4 candidate** only after redacted live observations establish stable read-only transport and
renewable/reusable sessions. No evidence for A/B. Production-first MVP: **manual CSV: E / cost 1**.

## 12. Read-only live verification items

Use an already registered user account and local officially recommended browser for one bounded run.
No registration/changes.

1. Check official URLs, issuer/brand boundaries, and that JCB is not mixed into the same session.
2. Check existing session/fresh login behavior without saving IDs/passwords/cookies/form bodies.
3. Check login MFA/risk confirmation, remembered devices, session lifetime/reuse with redacted metadata only. Do not automate new OTP receipt.
4. Enumerate only generalized root products and `primary/family/etc/other`, without display names/suffixes.
5. Check current/unfinalized and finalized cycle field/status transitions.
6. Check use dates, merchants, amounts, payment categories, installments, refunds/corrections, family/ETC hints, presence of authorization pending layers. Save no actual values.
7. Check month selectors, empty/oldest months, counts, pagination, 15-month boundary.
8. Download existing statements once; record only filename/MIME/encoding/headers/quoting/date/amount formats/limits/hashes. Delete test files after schema checks.
9. Check for native PDF controls. Otherwise call browser PDF rendered output.
10. Check points balance/expiry/history schemas only; do not open exchange flows.
11. Under DevTools redaction, classify only card list, month selection, statement display, download methods/path templates/status/content-types/shapes.
12. After logout, verify settings, applications, payment methods, points, usage restrictions unchanged.

### Stop conditions

- Confirmation of purchases, payments, cash advances, applications, exchanges, registration, cancellation, settings changes.
- Semantically unknown read/write controls/endpoints.
- Unexpected OTP, security questions, device enrollment, passkey creation, password reset/recovery.
- 403/429, CAPTCHA, Akamai challenges, redirect loops, need to weaken/bypass security controls.
- Risk of captures/logs retaining secrets, full identifiers, PII, balances, merchants, actual statements.
- Replay crossing read/write boundaries or requiring pinning/attestation bypass.
- More than one harmless login/download failure.

On stopping, retain only redacted error classes, route templates, timestamps, status codes; return to **manual E / cost 1**.

## Unverified items

- Login MFA/risk/device binding, session lifetime/renewal/concurrency.
- JP BANK Card-specific transport and reusable read-only sessions.
- CSV encoding/schemas, row/page limits, subcard discriminators.
- Exact pending/posted/refund/reversal/installment representations and immutable keys.
- Native PDF download.
- Switching multiple VISA/Mastercard roots in one login.
- Points history granularity and family/ETC attribution.
- Whether Akamai accepts ordinary browser automation in the intended runtime without challenges.

## Main primary sources

- [JP BANK Card WEB overview](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb.html)
- [JP BANK Card WEB available services](https://wwws.jp-bank.japanpost.jp/credit2/service/cardweb01.html)
- [JP BANK Card WEB login](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb02.html)
- [JP BANK Card WEB special terms](https://wwws.jp-bank.japanpost.jp/credit1/service/cardweb05.html)
- [Card usage WEB statements](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_about.html)
- [WEB statement FAQ](https://wwws.jp-bank.japanpost.jp/credit1/oshiharai/web_meisai_faq.html)
- [Usage statement guide](https://wwws.jp-bank.japanpost.jp/credit2/member/meisai_guide.html)
- [Supported site environments](https://wwws.jp-bank.japanpost.jp/credit1/kankyo.html)
- [JP Bank Card Points](https://wwws.jp-bank.japanpost.jp/credit2/service/point/point.html)
- [One Time Pass app migration guidance](https://wwws.jp-bank.japanpost.jp/credit2/update/otp.html)
