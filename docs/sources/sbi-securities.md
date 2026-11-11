# SBI証券 (SBI Securities): initial assessment of official data sources

> Dated source research and implementation notes. Earlier runtime/schedule
> claims may be superseded by later changes. See the [research scope](README.md),
> [current status](../current-status.md) and [schedules](../schedules.md) before
> using these notes as operational instructions.

- Research date: 2026-08-26
- Scope: SBI Securities' comprehensive securities account only
- Excluded: SBI新生銀行 (SBI Shinsei Bank), 住信SBIネット銀行 (Sumishin SBI Net Bank), SBI VCトレード (SBI VC Trade), household-finance/asset-management aggregators, placing/amending/cancelling orders
- Purpose: an initial assessment of implementation cost and automation feasibility, rather than detailed API implementation

## Conclusion

SBI Securities is rated **implementation cost 3/5, conditionally suitable for scheduled automation (currently B, with A achievable after consecutive validation)**. Using real credentials for the current account, the browserless WebAuthn challenge, assertion, SSO callback, access-token decryption, MTS session establishment, and read-only retrieval of domestic cash-equity holdings all succeeded. Technical uncertainty from authentication through primary data retrieval has been resolved; the main remaining issues are session lifetime, consecutive runs, changes in execution origin, and reduction to a read-only bundle.

The recommended route is a read-only client that calls the MTS transport used by the official stock app directly, from passkey authentication onward, without a browser. Use this as the primary route for frequent cash-equity holdings retrieval, with the official website's `My資産` (My Assets) as a secondary route for cross-product valuations, history, realized gains/losses, and dividends. For Kogane integration, extract only the required authentication, MTS login, and read TR codes rather than depending on all of `mnie`.

Existing implementations have already demonstrated unattended login using a stored passkey and direct calls to internal Web/app transport. In the real-account test on 2026-08-26, only the minimum credentials required by SBI Securities were passed from Bitwarden CLI into the process, connecting `mnie`'s existing signing function and passkey session. Results were entry 200, challenge 200, assertion 302, callback 200, MTS login 200, and cash-equity holdings inquiry 200; the server total matched the parsed count. Other than counts, no account data were recorded; tokens, SIDs, and credential identifiers were not recorded either. However, authentication changed in June 2026, and the login entrypoint has Everspin defenses. Browserless HTTP was accepted at this point, but stable operation requires session-expiry detection and ongoing comparison with values on official screens.

The executable code for this `mnie` overlay was removed from main during the repository cleanup in 2026-09. The confirmed coverage, evidence for the 90-day window, limitation that yen deposit/withdrawal statements lack security codes, reasons and verification procedure for keeping the MTS origin out of the repo, and decision rules for extracting only SBI-specific minimum credentials from Bitwarden CLI remain in [`../research/sbi-securities.md`](../research/sbi-securities.md).

Kogane must never enable trading functionality. The SBI provider in `pnsk-lab/mnie` is useful specification material, but exposes order placement, amendment, and cancellation and must not be used or registered as-is. Extract only the read components into a separate package, never configure or store a trading password, and exclude order code and destinations from the build.

### 2026-08-27: independent Cloudflare Worker PoC

This policy was implemented as an independent Workers-only implementation in [`services/collector-sbi-securities`](../../services/collector-sbi-securities/). It does not reuse Mnie as a runtime dependency, submodule, or configuration source; only the necessary passkey signing, SBI-specific RSA token decryption, domestic MTS, foreign-equity REST/GraphQL, and main-site SSO read-only components were ported. Public destinations are hardcoded on the Kogane side; Mnie's repo rule of making base URLs runtime variables was not carried over.

This PoC stores only the six minimum fields for an SBI-specific passkey and the fixed RSA transport key for token decryption in Cloudflare secrets. It does not store the login ID/password, trading password, or entire Bitwarden item. Access tokens, SIDs, Cookies, MTS session headers, and account numbers are not saved to R2 or normal logs; only data artifacts and redacted manifests go to private R2. D1 is not used. On actual Cloudflare infrastructure, foreign scope succeeded in about 7 seconds and domestic scope in about 15 seconds, but running both in the same invocation produced Error 1102.

Queue splitting was also measured, but authentication and collection exceeded the CPU limits applied to Free-plan consumers and service-binding targets. Even after moving RSA-4096 key generation out of runtime, a normal foreign-scope request used about 0.94 seconds of CPU time; fitting within the official Free limit of 10ms through optimization alone was unrealistic. After moving to Workers Paid on 2026-08-27, through 2026-10-05 a Cloudflare Cron Trigger starts `scope=all` once daily at 06:00 JST, collecting domestic and foreign scopes sequentially without GitHub Actions or Queue. The daily Cron's maximum CPU time and wall time are both 15 minutes, sufficient for the measured approximately 7-second plus 15-second processing.

Since [#430](https://github.com/risu729/kogane/pull/430) (2026-10-05) the
Worker has no Cron trigger: the Processor's alarm job `sbi-securities`
(06:00 JST, `0 21 * * *` in `config/alarm-jobs.json`) calls its private
`ScheduledCollection` entrypoint, which runs `scope=all` once, and the run holds
the source's execution lease in D1 (`SCHEDULE_DB`). Runs are stored in the
shared `DATA` bucket, not a private one ([below](#addendum-switch-to-shared-data-r2-u09)).

For the initial backfill, 2024-08-28–2026-05-29 was split into eight non-overlapping intervals of at most 90 days. All runs succeeded, domestic 8/8 and foreign 8/8, with failure 0, and were saved to private R2. The recent 2026-05-30–2026-08-27 interval also succeeded for both domestic and foreign scopes. R2 therefore currently holds about two years of domestic/US equity transaction history, plus raw snapshots at each run of domestic/US equity holdings, yen/USD cash deposits, My Assets, and yen deposit/withdrawal statements.

### 2026-11-09: two-year execution windows

For [#1225](https://github.com/risu729/kogane/issues/1225), the owner's existing
browser session supplied these read observations. Dates below are search
parameters, not personal transaction dates; no tokens or provider row values
were retained.

- Domestic: `POST /ETGate/`, `_PageID=WPLETacR007Rlst10`,
  `_ControlID=WPLETacR007Control`, `_ActionID=search`, `sec_kbn` two spaces
  for all products, and `ref_from_yyyy/mm/dd`, `ref_to_yyyy/mm/dd`. The form
  offers `max_cnt` 50/100/150/200. The 90-day query 2024-11-10 through
  2025-02-07 was retained and accepted. Its empty response had the search
  form, no result table, and the fixed message
  `指定された条件での約定履歴は見つかりませんでした。` (no executions matched
  the selected conditions).
- Foreign: the observed read navigation reaches
  `member.c.sbisec.co.jp/foreign/account/trade-history`.
  `GET /foreign/api/account/trade-history` returns exactly
  `{ nextBusinessDate: string }`, in `YYYY-MM-DD` form. The request includes
  `x-csrf-token`; its page has `meta[name=_csrf]`, with no CSRF input.
  The two-year button selected 2024-11-12 through 2026-11-11. A manual
  2024-11-10 start was cleared without a history request, while 2024-11-12
  through 2025-02-07 was retained and returned HTTP 200. The foreign cutoff
  therefore comes from the provider's next business date, not JST today.
- The corroborating web execution query is
  `GET /foreign/api/account/trade-histories`, with `pageNumber`, `dateFrom`,
  `dateTo`, `productType=stock`, `countryCode=us`, `stockMarginType=order`.
  The full two-year search had 11 rows and `totalCount=11`, `pageNum=1`,
  `pageSize=50`, `firstPage=true`, `lastPage=true`, and both next/previous
  flags false. No next-page request was observed. The response has
  `accountTradeHistories` and page metadata; its row schema is
  `executionDate`, `productType`, `priceType`, `depositType`, `tradeType`,
  `settlementCurrency`, `quantity`, `price`, `deliveryDate`, `amount`,
  `exchangeRate`, `countryCode`, `currencyCode`, `name`, `shortName`, `code`,
  `marketCode`, `listedStatus` (strings), and `marginLimitType` (null).

These web observations describe the web retention boundary. They do not
establish the mobile lower bound or re-observe its GraphQL protocol. The
[retained successful mobile probe](../research/sbi-securities.md) resolves
the difference: it actually queried `/graphql/bff` with
`GetSearchingDuration($input: GetSearchingDurationRequest!)`, input
`countryCode=US`, `searchFunction=EXECUTION_HISTORY`,
`searchDateType=TRADE_DATE_BASE`, `dateType=MONTH`, `quantity=1`, and selected
`getSearchingDuration { pastYears searchDateFrom searchDateTo }`. It used
January 1 of `year(to) - pastYears`, not a rolling anniversary, as the scan
start; this explains the eleven successful January-to-August windows for
`pastYears=2`. The returned default-period dates were not treated as the
earliest retained dates.

The scheduled collector restores that historically observed BFF read using
its existing authenticated mobile foreign session, with the same header
names (`authorization`, `account-id`, `accept`, `content-type`, `user-agent`).
It supports only the observed `pastYears=2` and expected response shape;
anything else keeps the scope partial. The January-start policy covers the
historically scanned interval and may require thirteen windows at year end,
rather than nine rolling two-year windows. The execution query input fields
are unchanged. This change has no new live-mobile verification: no mobile
credentials were obtained, no extra mobile session was created and no manual
collector was invoked. The authenticated Chrome web session is not a mobile
session. Current BFF behavior and retained coverage still need a scheduled
production run; historical success is not presented as new live proof.

A read-only CORE aggregate on 2026-11-09 counted distinct external execution
IDs across published parses, rather than counting repeated captures as new
executions. The cutoff for the last column is the documented start of daily
collection, 2026-08-27, not a private transaction date:

| Scope    | Trade quarter | Distinct IDs | IDs before daily collection |
| -------- | ------------- | -----------: | --------------------------: |
| Domestic | 2026-Q1       |           42 |                          42 |
| Domestic | 2026-Q2       |           29 |                          29 |
| Domestic | 2026-Q3       |            1 |                           1 |
| Domestic | 2026-Q4       |            7 |                           0 |
| US       | 2026-Q2       |            6 |                           6 |
| US       | 2026-Q3       |            1 |                           1 |

No counted observation lacked an external ID. The historical backfill had
therefore already published 72 domestic and seven US executions before daily
collection. These counts do not prove present two-year completeness; the web
US total and published execution count still differ, with the independent
parser refusal tracked in [#1220](https://github.com/risu729/kogane/issues/1220).

The domestic historical requests also began January 1 of year minus two.
The scheduled collector uses that same lower-bound policy for domestic
history, with all six returned date-form controls checked against the
requested window. A stricter current form that clears or clamps a date is
partial, never confirmation of that old window. Those requests historically
succeeding is not proof that every earlier requested date had data or that
today's retained period is unchanged.

The scheduled collector now walks at most thirteen disjoint windows per scope,
newest first, keeping the newest 90-day artifact's prior key and existing row
identities. Each older window has a dated artifact key and a matching requested
range in the terminal and CORE descriptor under registration v4
([ADR 0096](../adr/0096-sbi-scheduled-execution-history.md)). Empty domestic
windows require the observed message. A window failure retains other windows
but marks the scope incomplete. Foreign retention discovery failure falls back
to the old 90-day request as partial evidence. Deployment, a completed scheduled
walk within the time limit, publication of every window and provider-count
equality remain unverified; no manual collector invocation was performed.

### 2026-11-10: foreign trade price precision and empty cash metrics

Read-only in-memory replay of stored evidence for [#1220](https://github.com/risu729/kogane/issues/1220),
with each object's SHA-256 and byte size verified, named the following
categories without returning provider values:

- One distinct rejected `foreign-trade-records` object failed at
  `pages[].listTradeRecords.tradeRecords[].price`: the exact decimal was not
  representable in the trade currency's minor units. Parser `1.0.2` validates
  unit prices as exact decimals and preserves them unchanged in `extra`.
  Settlement `amount` still requires exact currency minor units. The canonical
  provider-row fingerprint and duplicate occurrence suffix are unchanged, so
  previously accepted executions retain their `externalId` on replay.
  A second in-memory replay using `1.0.2` accepted the same object and returned
  five observations with no rejection; it did not publish them.
- Among the five newest distinct incomplete `foreign-cash-balances` objects,
  `transferPossibleAmount` had 25 empty-string cells and `amountPayValue` had
  five. These remain `row_unreadable` membership issues and keep coverage
  incomplete. An empty string has not been established to mean zero,
  unavailable or inapplicable; no replacement value or completeness claim is
  inferred. The fields and their closed shape class are the named remaining
  provider limitation.

This was diagnosis of stored evidence, with no collector invocation or SBI
login. It does not establish deployed parser version, publication of corrected
observations, or current coverage after the next scheduled run; those remain
the rollout checks for #1220.

### 2026-11-09 and 2026-11-10: delivered-document observations

Dates in this section are UTC. For
[issue 1248](https://github.com/risu729/kogane/issues/1248), normal read
navigation in the owner's authenticated browser reached the new electronic
mailbox and the legacy mailbox. The current HTTP-only collector does not
collect either mailbox. The `document` catalogue entry remains
`not_collected`; these observations do not establish a scheduled archive.

#### New electronic mailbox: one current list and one PDF response

The main-site `取引報告書等(電子交付)` entry uses ETGate
`sw_page=Edeliv`, then `m.sbisec.co.jp/switchnaviMain`.
The first report group covers domestic stocks, investment trusts, bonds,
foreign stocks and SBI Wrap in specific/general custody. Its normal button
opened `https://m.sbisec.co.jp/edeliv/deisw070.jsp?ePoboxFlag=true`,
then `/deisw081`, and finally the
[electronic mailbox](https://plus.e-shishobako.ne.jp/dp_apl/usr/),
titled `電子ポスト`. The futures/options report button used the same entry
route. Other derivatives, FX, CFD and metals have separate entries and were
not established as supported document routes.

An ordinary mailbox reload made the following form POST requests on
`plus.e-shishobako.ne.jp`. Common response keys are
`ctt:null,code:string,message:string`. No opaque form value, identifier,
document date, title, notification prose or document bytes are recorded here.

| Path                      | Form fields    | Additional response shape                                                                  |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------ |
| `/dp-uw/v1/DPAW010501030` | `_csrf,riyoCd` | `summaryList:[{busiSys:string,userTokuteiId:string,kofuKensu:number,mikaifuKensu:number}]` |
| `/dp-uw/v1/DPAW010601020` | `_csrf,riyoCd` | `doiFlg:string`; consent/status only, with no acceptance action performed                  |
| `/dp-uw/v1/DPAW010501010` | `_csrf,riyoCd` | `outlist:object[],allCountKen:number`                                                      |

The list returned **66 rows**. Its `allCountKen=66` matched the visible
`全66件` and the separately requested issued-document summary count of 66.
There was no initial pagination parameter; the current list arrived at once.
These equalities establish the captured current list's row count, not the
number of PDF files, complete historical retention or completed archival.

Each `outlist` row has these observed fields and types:

- Strings: `readSts,sBaseDate,sName,sType,kofuInfoKtitle,busiSys,kofuHms,
  etsuranKigen,sIntFileId,sOriFileId,sCount,sCd,sCdSeq,userTokuteiId,sTypeCd,
  starSts,sDoiyoKbn,rDoiyoKbn`. `sBaseDate` has the `YYYYMMDD` shape.
- Nulls: `kofuInfoKinfo,kofuDetailList,kakuninFlg`.
- `sType` included the literal string `"NULL"`; that is not JSON null.

Expanding one visible `投資信託取引報告書（特定投信等）` item sent
POST `/dp-uw/v1/DPAW010501080` with form fields
`_csrf,riyoCd,userTokuteiId,sCd,sBaseDate,sCdSeq`. In addition to the common
response keys, the detail response contains:

- Strings: `kofuInfoKinfo,kofuInfo,readSts,readHms,tsuchiInfo,tsuchiInfoKinfo,
  torizanKbn,sDoiyoKbn,rDoiyoKbn,sTypeCd`.
- `kofuDetailList:[{sOriFileId:string,sIntFileId:string}]`.
- Nulls: `doiHms,doiCreateSts,doiHonbun,doiComment,kakuninFlg`.

The normal UI also sent the mark-read POST
`/dp-uw/v1/DPAW010501040`, with
`_csrf,userTokuteiId,sCd,sBaseDate,sCdSeq,updateFlag`, and refreshed the
summary. Opening a document with this side effect is explicitly allowed by
issue 1248. No consent, agreement, enrollment or authentication setting was
changed.

Clicking the expanded item's PDF control sent POST
`/dp-uw/v1/DPAW010501020` with form fields
`_csrf,sCd,sTypeCd,sBaseDate,sCdSeq,userTokuteiId,sIntFileIds,xmlPreviewFlg,
riyoCd`. The observed literal is `xmlPreviewFlg="0"`;
`sIntFileIds` is a string, not a JSON array. Other values came from the
selected list/detail rows and authenticated session. The response was HTTP
200 with `application/pdf`, and its decoded body began with `%PDF-`.
Only the response type and magic were verified in memory. No PDF content,
raw bytes, identifiers or private document dates were persisted. Multiple
document types, multiple detail files and any concatenation semantics remain
unverified; identifier splitting or a one-row/one-file rule must not be
inferred.

#### Legacy mailbox: empty visible folders without a proved zero total

The visible `2022年4月22日以前の取引報告書等` link opened
`https://m.sbisec.co.jp/edeliv/deisw070.jsp` without `ePoboxFlag`,
then the [legacy mailbox](https://sbisec.postub.mypot.jp/web/DocumentListInitAction.do),
titled `POSTUB`. The default `電子ポスト` view showed no rows or document
links, and month selectors offered only `すべて=-1`. The visible status
options were all `-1`, unread `10`, needs consent `50`, consented `60`
and read `30`.

The `保存箱` link advertised
`goNext('/web/TrashDisplayAction.do',document.f_sub03)` and reached the same
final `DocumentListInitAction.do` path. It likewise showed no rows, document
links or selection checkboxes, with only the all-month option.
Neither view showed an explicit zero total or empty-result message.
This is a scoped observation of two empty-looking views, not independent
evidence of zero retained documents or complete legacy coverage.

Forms advertised POST `DocumentListSearchAction.do` and the paging action
`ChangePageDisplayAction.do`. Their visible field names were
`rcpt_month_sel_from,rcpt_month_sel_to,rcpt_sts_sel,subjectText,ACT_doRefresh,
cur_page_sel,msg_folder_type_cur,line_per_page_sel,rcpt_month_sel,company_sel,
category_sel,category_gp_sel,search_order,searchFlg,_csrf`.
No nonempty result, continuation request or legacy download route was
observed.

#### 2026-11-10 follow-up: SSO and session bootstrap remain unverified

Normal navigation in the existing authenticated browser again reached
`/deisw081` and the new mailbox. Across the origin changes, the observation
retained only the initial `deisw070.jsp` GET and final application GET,
both HTTP 200. The intermediate SSO request chain and secret carrier were
not retained or established. A separate browser profile intended for further
handoff observation remains at provider authentication; it has not verified
an alternative handoff. This is an authentication/observation blocker, not
evidence of a mailbox service outage.

The new mailbox DOM had no CSRF meta element or hidden input. Its publicly
loaded `/dp_apl/usr/main.js` reads sessionStorage keys `dp-csrf` and
`dp-riyoCd` to supply form `_csrf` and `riyoCd`, and updates
`dp-csrf` from response header `x-csrf-token`. It also reads
`urlParamMap`, whose bootstrap producer was not observed. No sessionStorage
value was read or recorded. Public mock-mode code was visible but was not
used; it is not evidence of the authenticated provider protocol.

The existing collector's HTTP sessions do not establish how to bootstrap this
separate mailbox context. No HTTP-only SSO implementation, hardcoded token,
new secret, collector route, feature flag or publication was added. The
handoff/bootstrap and target allowlists need evidence before implementation
can establish scheduled document coverage. The issue's requirements to store
all listed documents once, retain metadata and update the catalogue remain
unfulfilled.

#### 2026-11-10 later follow-up: observed SSO form; bootstrap still unverified

Later normal navigation on 2026-11-10 UTC used the already observed
`https://m.sbisec.co.jp/edeliv/deisw070.jsp?ePoboxFlag=true` entry. An
immediate read-only DOM inspection caught the connecting page at
`https://m.sbisec.co.jp/deisw081` before its ordinary automatic submission.
The page contained a form with method `POST`, action
`https://plus.e-shishobako.ne.jp/dp-uw/v1/SSO`, an empty target and seven
hidden fields: `sfn,ric,ked,epr,itv,hav,spm`. No field value was read or
recorded. All seven values remain opaque runtime handoff material; their
names do not establish meanings or reusable constants.

The ordinary navigation subsequently reached `/dp_apl/usr/`. The network
observation still retained only the final application GET, not the SSO POST
or its response. The connecting-page form establishes the handoff carrier
and its exact destination, superseding the earlier lack of carrier evidence.
It does not establish the response status, redirect sequence, response
headers, response HTML or script processing that produces `dp-csrf` and
`dp-riyoCd`. The producer of those sessionStorage values remains the precise
HTTP-only implementation gap. No token extraction rule can be inferred from
the final static application page or the downstream API request fields.

No mailbox SSO implementation or scheduled archive was added. A future
transport must constrain form submission to the observed exact HTTPS SSO
destination and refuse unobserved handoff or bootstrap shapes. The existing
66-row list and one PDF observation still do not fulfill the issue's
scheduled archival, metadata or deduplication acceptance criteria.

## Assessment scale

Automation levels are defined as follows.

- A: normally runs unattended on a schedule after initial registration
- B: scheduled execution is possible, but authentication changes, risk decisions, or session expiry may require manual recovery
- C: user interaction is required every time or frequently
- D: currently impractical

SBI Securities is currently B. Confirmation of passkey use and Bitwarden storage for the current account improves the prospect of reaching A compared with the initial assessment. It may be raised to A after passing tests with a fixed Japanese IP, secure use through a local issuer, and consecutive runs over multiple days.

## Official entrypoints and available information

No official public API for general individual users to retrieve balances, holdings, or history through OAuth or similar mechanisms was found in the SBI Securities official material checked in this research. An official futures/options API exists, but it is a trading connection requiring external-tool configuration and API-key issuance beforehand, and is not used for the comprehensive securities account's read collector. Thus, API in this assessment means undocumented internal transport used by the official website/apps, without a public specification or compatibility guarantee.

### 1. Main site (PC/smartphone) and My Assets

The login entrypoint is `https://login.sbisec.co.jp/login/entry`; the authenticated main site uses the `ETGate` family. Since October 2025, the public top-page ID/password fields have been removed in favor of navigation to a dedicated login domain.

`My資産` is the official asset-management feature on PC and smartphone sites, displaying the following cross-product data.

| Item                                                   | Granularity                                                                            | Period/updates                                                                                                                              | Value for Kogane                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Current assets                                         | Overall assets, product category, security                                             | Domestic equities are generally real-time for both post-execution updates and prices. Funds, bonds, etc. have product-specific update times | Primary route for daily snapshots                                               |
| Acquisition amount, valuation, unrealized gains/losses | Overall, product, security                                                             | Current values and official calculation results                                                                                             | Avoids errors from reconstructing acquisition values                            |
| Asset trends                                           | Overall/product; valuation, acquisition amount, unrealized gains/losses and percentage | Since 2021-08; normally based on 7:00 every Saturday                                                                                        | Useful for initial import of past snapshots, but not daily                      |
| Realized gains/losses                                  | By security, product, custody category; execution/settlement date selection            | Since 2021-08; arbitrary periods selectable                                                                                                 | Retrieves post-sale gains/losses without recalculation from transaction history |
| Dividends, distributions, interest                     | By security, product, account category; per-payment unit amounts, etc.                 | Since 2021-08-01                                                                                                                            | Useful for cash-flow detail                                                     |
| Cash deposits                                          | Yen/US dollars                                                                         | Generally real-time                                                                                                                         | Cash balance                                                                    |
| Sweep-only bank account                                | Total balance                                                                          | Generally real-time                                                                                                                         | Purchase funding, separate from bank-side transaction history                   |

Officially covered products are domestic equities (cash/margin), US equities (cash), domestic investment trusts, foreign-currency MMFs, yen/USD-denominated bonds, SBIラップ (SBI Wrap), iDeCo, yen/USD cash deposits, and sweep-only bank accounts. Official material focuses primarily on USD-denominated foreign-currency assets.

Public client code confirms that the following can be read from the main site's asset-valuation JSON.

- Total valuation, previous-day change/percentage, previous-month change/percentage, unrealized gains/losses and percentage, acquisition amount
- Totals including/excluding cash deposits and including/excluding iDeCo
- The same fields by product category, plus composition percentages

The same code also retrieves date, deposit/withdrawal category, statement category, description, amount, and stable ID from internal yen deposit/withdrawal statement JSON. The Kogane collector validates the initial response's page metadata and row cardinality, saving a page bundle without dropping provider fields only when a single page contains all rows. The next-page request contract has not yet been observed, so responses indicating multiple pages fail closed rather than count as success.

### 2. Account management, transaction history, and electronic delivery

The official website provides the following history.

| History                                                   | Official retention/display                                             | Granularity                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Execution history                                         | Past 2 years                                                           | Transaction details; CSV download available                                               |
| Yen deposit/withdrawal statements                         | Past 2 years                                                           | Date, category, description, amount, etc.                                                 |
| Capital-gains tax statements                              | Past 2 years                                                           | Individual specific-custody details, total tax, total gains/losses; maximum 200 rows/page |
| Electronically delivered trade reports/account statements | Normally past 5 years                                                  | Official documents such as PDFs                                                           |
| Disclosure requests                                       | Up to past 10 years                                                    | Request procedure, not automated collection                                               |
| Bond order history                                        | Past 2 years                                                           | Order history                                                                             |
| Bond transaction/redemption/interest-payment summaries    | Past 5 years                                                           | Summaries; documents provide detail                                                       |
| Foreign equities                                          | Execution history/account summary on the foreign-currency trading site | Holdings, executions, FX order history; retention period not established in this research |

For initial backfill, combine My Assets (weekly assets, realized gains/losses, dividends, etc. since 2021-08), two-year CSVs, and five-year electronically delivered documents. CSVs/documents retrieved directly from the official site are not an aggregator route.

### 3. Buying power and holdings

The official website and stock-app transport provide at least the following.

- Cash/margin buying power, withdrawable amount
- Collateral securities valuation, margin maintenance ratio, balance equivalent to SBIハイブリッド預金 (SBI Hybrid Deposit)
- Domestic cash equities: security, market, custody category, quantity, sellable quantity, unexecuted quantity, acquisition/average unit price, current price, market valuation, unrealized gains/losses and percentage
- Domestic margin: position ID, buy/sell category, quantity, closeable quantity, opening price, current price, market valuation, unrealized gains/losses and percentage, opening date, maturity date, charges
- US equities: security/ticker, quantity, acquisition amount/valuation/gains and losses in local currency and yen equivalents

The official `取得単価` (acquisition unit price) for domestic equities is a moving-average price including fees, and is not always identical to general-custody `参考単価` (reference unit price) or a specific account's tax acquisition value. Kogane preserves the meaning and source screen and must not collapse `取得単価`, `参考単価`, `平均取得価額` (average acquisition value), and `税務上取得価額` (tax acquisition value) into one field.

### Additional products checked on 2026-11-09 UTC

For [issue 1237](https://github.com/risu729/kogane/issues/1237), read-only
navigation in the owner's authenticated Chrome session checked the offered
fund, foreign-currency MMF, bond and domestic-margin holdings pages. None
displayed a current holding. This is dated evidence for this account, not a
permanent absence claim or a parser contract for an unseen holding.

- **Foreign-currency MMF:** the ordinary menu led through ETGate to
  `/fmmf/account/assets`. The `保有銘柄` page displayed
  `現在、お客さまの預り情報はございません。`. Its GET
  `/fmmf/holdings-list/api?baseUrl=https://www.sbisec.co.jp` returned
  `status: SUCCESS`, `messages: null` and `data` with
  `foreignCurrencyAccountOpened: boolean`, `holdingFundList: []`,
  `messageCode: null`, `messageParameterList: null`, `warningMessageCode: null`.
- **Investment funds:** the `保有ファンド` menu led to `/fund/account/assets`,
  with `口数指定` and `金額指定` sections and the same explicit empty message.
  GET `/fund/api/account/assets?accountGetType=2` returned `status: SUCCESS`,
  `messages: []` and `data.totalCount: 0`. Both `amountHoldings` and
  `unitHoldings` contained null values for `specificDeposit`, `normalDeposit`,
  `nisaDeposit`, `juniornisaSpecificDeposit`, `juniornisaNormalDeposit`,
  `juniornisaNisaDeposit`, `tnisaDeposit`, `nisaGrowth`, `nisaReserve` and
  `juniorNisaContinuous`. Summary amount/cost/profit/change fields were strings,
  summary rate fields numbers, and account-open/admin flags booleans. The
  explicit UI empty state and zero total corroborate the null containers;
  null alone is never a numeric-zero rule.
- **Bonds:** the holdings menu led to `/bond/account/assets`, with the same
  explicit empty message. POST `/bond/bond-balance/api` first sent `{}`, then
  `exchangeRates: [{currencyCode: string, exchangeRate: number}]` and ascending
  `sortConditions` for `bond.currencyCode`, `bond.remainingPeriod.years`,
  `bond.remainingPeriod.months`, `specificAccountCode`,
  `bond.securities.productCode`, `bond.securities.securitiesCode`. Both reads
  returned `status: SUCCESS`, `messages: null`, `data.bondBalances: null`,
  `currencyEvaluationProfitLosses: null`, `maintenanceServiceIds: []` and a
  `page` object: `pageNum`, `pageSize`, `totalCount` were zero; `firstPage`,
  `lastPage`, `hasPreviousPage`, `hasNextPage` were false. No currency/product
  filter was applied. The whole displayed list was empty; no nonempty yen or
  USD bond contract is inferred.
- **Domestic margin:** the visible `信用建玉` link opened GET `/ETGate/` with
  `OutSide=on`, `getFlg=on`, `_ControlID=WPLETstT007Control`,
  `_PageID=DefaultPID`, `_ActionID=DefaultAID`,
  `_DataStoreID=DSWPLETstT007Control`. The HTML heading was `信用建玉一覧` and
  the fixed empty text was `現在、お客さまの建玉情報はございません。`.

The issue instructs that products without holdings are recorded as offered but
empty and no collection is built for them. These observations therefore add
no collector, sanitizer or parser. Existing domestic/US spot positions remain
the existing datasets' responsibility. The provider-wide `position` catalogue
stays `partial`, now linked to issue 1237: a current empty account does not make
unimplemented product schemas supported. Its version is unchanged because
neither types nor statuses change. Reobserve a nonempty product before adding
its fields, price meanings, completeness checks and parser.

Only route/query shapes, closed statuses, types and empty counts are recorded.
No account IDs, provider amounts, security names, session material or raw
responses are retained, and no order or account-opening action was submitted.

## Channel tradeoffs

| Route                                                          | Advantages                                                                                                    | Disadvantages                                                                                    | Cost | Automation prospects |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---: | -------------------- |
| PC/smartphone My Assets JSON                                   | Official cross-product totals, rich history, easy browser value comparison; public JSON retrieval example     | Login SSO/internal endpoints undocumented; affected by screen/authentication changes             |  4/5 | B→A candidate        |
| PC-site CSV/electronic delivery                                | Official exports, historical data, strong audit evidence                                                      | Retrieval/parsing per CSV/PDF; unsuitable for daily current values                               |  3/5 | B                    |
| PC/smartphone browser scraping                                 | Existing Go implementation has operational examples; quick initial validation                                 | Headless detection, DOM changes, Chromium size, wait times                                       |  3/5 | B                    |
| SBI証券Plus (SBI Securities Plus) app                          | Assets, realized gains/losses, dividends, etc. together in a read-oriented interface; similar to PC My Assets | API undocumented; APK/transport analysis and tracking authentication/app updates required        |  4/5 | B (unvalidated)      |
| SBI証券 株アプリ (SBI Securities Stock App) internal transport | Detailed buying power, domestic holdings, order book/prices, etc.; direct HTTP implementation example         | Proprietary fixed-length Shift-JIS protocol; shares API surface with orders, requiring isolation |  4/5 | B→A candidate        |
| Foreign-equity app REST/GraphQL                                | Detailed US equity holdings, orders, executions                                                               | Separate SSO/session, hashes, etc.; separate implementation from domestic scope                  |  4/5 | B                    |

Officially, PC and smartphone My Assets have the same coverage and aggregation periods. Access to internal JSON matters more than screen width. SBI Securities Plus provides similar cross-product information to My Assets, making it worth examining before the trading-oriented Stock App when analyzing APKs. However, existing implementations provide stronger evidence for stock-app transport for buying power and domestic equity details.

## Authentication, devices, and sessions

### Official specifications as of August 2026

- Passkey authentication has been required in principle since 2026-06-30, although username/login-password login remains available.
- Passkeys allow login without password entry or additional login authentication.
- Password login on the PC/smartphone main site, smartphone-only site, or SBI Securities Plus requires an email authentication code when risk is detected.
- The previous email-URL-based device authentication ended on 2026-06-13.
- Password login in the Stock App and similar apps requires FIDO or phone-number authentication.
- Trading has a separate risk decision and may require phone authentication. Kogane does not trade and must not activate this route.
- The apps' former automatic login can continue, but requires additional phone-number or FIDO authentication. Creating fresh sessions with a passkey is structurally clearer for scheduled collection.

### Confirmed for the current account

- The user logs in to SBI Securities with a passkey.
- That passkey is already stored in the user's Bitwarden vault.
- Bitwarden CLI returns the item's FIDO2 credential metadata and private key as decrypted JSON. Actual values have not been exposed in logs, the repo, or PRs.
- The passkey uses ECDSA P-256, is discoverable, and had one candidate for the same RP. Actual RP ID, credential ID, user handle, and counter values are not recorded.
- SBI Securities accepted the assertion generated by `mnie`'s existing `createBitwardenAssertion`, returning an SSO callback and decryptable access token.
- Passing the decrypted token to the stock app's MTS login established a session, and read-only TR code `F2631` retrieved domestic cash-equity holdings. All HTTP responses were 200, and server total matched parsed count.
- The same authentication flow created a separate passkey channel and SSO session for the foreign-equity app, retrieving US cash-equity holdings through official REST/GraphQL. Separate NASDAQ, NYSE, and NYSE Arca queries classified all actual account holdings without omissions.
- SSO to the main site through ETGate retrieved current valuation JSON for `My資産`. The presence of product categories and valuations was confirmed without putting security names, quantities, or amounts in normal logs.
- Yen deposit/withdrawal statement JSON was retrieved successfully. Only the initial list's row count and oldest/newest dates went to validation logs; descriptions and amounts did not.
- Foreign-equity transaction-history GraphQL succeeded for a 90-day range. A single request for over five years was rejected, so implementation must retrieve the server's searchable period and split it.
- Domestic order inquiry retrieved same-day executions, unexecuted orders, and recent orders. Complete past domestic execution history is not implemented in the current PoC/`mnie` high-level API.
- For domestic cash equities, current holdings-list prices, individual order books/current prices, and daily charts were retrieved from the real account. For US equities, previous closing prices and daily charts were retrieved for all holdings at test time, but `last` and holdings-list current prices were empty.
- USD foreign-exchange input-rate inquiry failed with the same main-site session. Saving official My Assets valuations for account reconciliation and using an independent market-data source for generic UI FX conversion is more stable.
- For the local PoC, only the login ID, login password, RP-matching URI, and single passkey were saved outside Git management in WSL. No trading password or Bitwarden custom fields were saved. Directory permissions are `0700` and file permissions `0600`.

Thus, CLI exportability of existing credentials, local signing, WebAuthn compatibility with SBI Securities, domestic MTS and foreign-equity sessions, domestic/US cash-equity holdings, current My Assets valuations, yen deposit/withdrawal statements, and US equity transaction-history read-only retrieval are confirmed. Unconfirmed areas are consecutive counter-use decisions, assertion-reuse rejection, session lifetime, IP/UA changes, historical domestic executions, My Assets trends/realized gains and losses/dividends, and full-period history pagination.

### Session mechanisms confirmed from public implementations

`pnsk-lab/mnie` generates signatures from stored WebAuthn credentials and implements FIDO challenge/assertion, app-channel SSO-token acquisition, and stock-app session establishment without a browser. It also supports session export/import, but caches main-site SSO authentication for 20 minutes. Rather than reusing the same cookie for long periods, the safer assumption is that passkeys can reauthenticate when required.

The same repo's `auth-bitwarden` decrypts Bitwarden Desktop's local `data.json` with the master password, handling PBKDF2-SHA256/Argon2id KDFs, item keys, and FIDO2 credentials. For a retrieved challenge, `createBitwardenPasskeyProvider` selects a credential with an exactly matching RP ID, builds `clientDataJSON` containing the specified origin and `authenticatorData`, and signs with the private key. The SBI provider accepts a generic `PasskeyAssertionProvider`, allowing direct connection. The real-account PoC minimized a decrypted item returned by official Bitwarden CLI and passed it to the same signing function rather than decrypting `data.json` directly.

Implementation caveats follow.

- Multiple credentials for the same RP ID require explicit selection; ambiguous selection is rejected. Credential IDs and private keys must remain within SBI-specific Cloudflare secrets and must not go to the repo, GitHub Actions, R2, or normal logs.
- The `userVerification` option sets the authenticator-data UV flag, but does not perform OS/Bitwarden UI biometric authentication or user verification. The real account accepted this assertion once; how the server evaluates actual UV, or whether it remains accepted over consecutive runs or after authentication changes, is unconfirmed.
- A positive stored counter is incremented by one for signing by default, but the updated value is not written back to the vault. Repeated logins may therefore use the same value; behavior for a stored zero and SBI Securities' decision need verification. Actual values are not recorded.
- The current default `data.json` path targets macOS. Using Bitwarden CLI 2026.8.0 in the WSL PoC avoided direct dependence on this path and vault format.
- In addition to synthetic credential tests, real SBI Securities credentials confirmed passkey callback, access-token decryption, MTS session, and domestic cash-equity holdings retrieval. Orders, device registration, and trading passwords were not invoked.

`createBitwardenAuthManager().credentials()` can return a `portableCredential` containing a FIDO2 private key as private JWK in addition to username/password. This generic export route is prohibited in Kogane. Only minimum fields for an SBI Securities passkey extracted from a Bitwarden CLI-decrypted item are synchronized to the Worker; the entire vault, master password, derived key, and login password are not placed in the cloud.

`azuki774/myscrapers` restores a stored passkey private key into a Chromium virtual WebAuthn authenticator and uses Playwright through the official login screen. It demonstrates login without user interaction, but exports the passkey private key to a server, so Kogane must treat it as a stronger secret than a normal password.

The currently adopted PoC extracts minimum SBI-specific credentials from an existing Bitwarden-stored passkey into WSL and synchronizes them to Cloudflare encrypted secrets. They do not go into container images, the repo, GitHub Actions, or CI artifacts. Credential IDs, private keys, user handles, session IDs, cookies, account numbers, and financial data are not recorded in normal logs, the repo, or PRs. If a design without cloud passkey duplication is required, return to the local issuer described next.

### Security-first alternative: local issuer and source-scoped envelope

The safest design has a scheduler pass collection requests to a local agent on the user's device. The agent completes Bitwarden decryption, WebAuthn signing, SBI Securities login, and read-only retrieval within the same trust boundary, sending only encrypted official raw evidence or normalized results to the cloud. The vault and SBI session never leave the device.

If authentication must be separated, make the issuer SBI Securities-specific and satisfy the following.

1. Fix requests to `source=sbi-sec`, `purpose=read-only`, a one-time nonce, short expiry, and permitted RP ID/origin.
2. Verify the RP ID/origin locally against the actual challenge returned by SBI Securities and official login screen; do not hardcode guesses.
3. Pass assertions only to the local SBI auth component as challenge responses; do not persist, relay through the cloud, or put them in normal logs.
4. If passing a session, use a short-lived `source-scoped session envelope` referencing an opaque handle inside the local agent rather than the cookie itself. The envelope contains only source, read-only purpose, audience, issue/expiry times, and allowed hosts/paths/TR codes, with no trading routes.
5. Avoid a permanently public inbound endpoint from the cloud scheduler to the local agent. Have the agent pull signed short-lived jobs, with rate limits, single execution, and reuse rejection.
6. Audit logs retain only success/failure, source, time, and failure category, with no credential IDs, user handles, challenges, assertions, cookies, or financial data.

This alternative passes neither assertions nor session cookies to the cloud. For operational simplicity, the current Worker PoC stores only minimum SBI-specific passkey secrets in Cloudflare secrets, without the Bitwarden vault/master password/derived key.

## WAF, anti-bot, and delivery infrastructure

### Confirmed facts

- Public responses from `www.sbisec.co.jp` passed through CloudFront and returned AWS ALB cookies and `JSESSIONID`.
- DNS for `login.sbisec.co.jp` CNAMEs to `*.sbi-everspin.com`; observed responses had `server: evfw` and passed through CloudFront/API Gateway.
- Public static images are served from `sbisec.akamaized.net`. This proves Akamai CDN use, but not Akamai WAF protection of authentication.
- SBI Securities' official material explains that EVERSPIN technology in the Stock App and similar apps assigns a different token per login to check authentication and the communication environment.
- Ordinary unauthenticated curl retrieved the public top page; no CAPTCHA/reCAPTCHA/Turnstile references were found.
- During research, a simple HTTP request to the login URL redirected 302 to maintenance. This observation alone cannot determine whether actual maintenance, UA detection, or missing request elements caused it.

### Third-party observations and inferences

- `myscrapers` records in code comments that the login API redirects 302 to maintenance for a `HeadlessChrome` UA, so it uses a normal Chrome UA. This third-party observation requires reproduction.
- The main automation cost is inferred to be the combination of Everspin tokens, browser/device information, risk-based authentication, execution IP, and channel-specific sessions, rather than CAPTCHA-centered protection.
- The official FAQ says some services may be stopped for access from overseas. Prefer a fixed Japanese IP over overseas/variable egress.

Thus, this does not establish that Akamai protects login. The current finding is **Akamai for static assets; CloudFront/AWS/Everspin for public/login routes; anti-bot details unconfirmed**.

## APK and static analysis

Android apps are distributed through official Google Play. No raw standalone APK published by SBI Securities was confirmed; the official acquisition route is Google Play. Obtain analysis files from a legitimate installation on the user's device or Google Play distribution under its terms. Do not trust unofficial APK mirrors.

| Official app     | Package ID                | Priority | Static-analysis aim                                                                          |
| ---------------- | ------------------------- | -------: | -------------------------------------------------------------------------------------------- |
| SBI証券Plus      | `jp.co.sbisec.sbiapp`     |        1 | My Assets-equivalent endpoints, history/pagination, response schemas, authentication channel |
| SBI証券 株アプリ | `jp.co.sbisec.hyperkabu2` |        2 | MTS base URL, TR codes, device registration, buying-power/holdings inquiries                 |

APK analysis is useful, particularly for current auth/MTS/foreign-equity endpoints that `mnie` externalizes as environment variables, SBI Securities Plus history APIs, and app schemas. However, official material describes EVERSPIN source/URL encryption and tamper detection, so static analysis alone may be insufficient. Defer detailed analysis and first check only strings, manifest, network security config, hostnames, and the presence of read-only methods.

On 2026-08-26, a distributed copy of the stock-app package was obtained, and its JAR signature was verified rather than trusting the mirror alone. The signer name was SBI SECURITIES, and the target MTS host's TLS certificate was also in SBI Securities' name. JADX 1.5.6 confirmed an MTS origin in a production/test environment table and a passkey login class that appends the relative path `/mtsmobile/ssologingate`. The actual origin itself is not saved to the repo.

The absence of an actual `SBI_MTS_BASE_URL` value in `mnie` does not mean it is undiscovered. That repo's `AGENTS.md` explicitly requires keeping actual endpoint origins out of hardcoded source, storing only paths. The app also separates origins in an environment table from relative MTS method paths; origins may change with app updates/environment switching. Accordingly, `.env.example` stays blank, and runtime injects values verified against current official distributions or transport.

TLS pinning, root/emulator detection, and the scope of EVERSPIN in the Plus app are unconfirmed.

## Third-party client code research

### `pnsk-lab/mnie` (`c87e65c0a04c03c560962f8ead6e77415fb841f4`)

TypeScript implementation as of 2026-08-05. It connects directly to SBI Securities' official Web/app internal transport rather than through an aggregator.

Main implementation:

- Retrieves WebAuthn challenges and generates assertions with stored credentials
- Obtains app-channel SSO tokens and establishes sessions at `/mtsmobile/ssologingate`
- Retrieves domestic-equity buying power, holdings, prices, orders, etc. with the fixed-length Shift-JIS protocol at `/mtsmobile/commgate`
- Performs main-site SSO and retrieves JSON from `/account/api/assets/valuations/current`
- Retrieves yen deposit/withdrawal statement JSON from `member.c.sbisec.co.jp`
- Uses REST/GraphQL, `Set-Session`, `Account-Id`, etc. for foreign equities
- Browser cookie jar, session export/import, 20-minute main-site authentication cache

Code-level assessment of `auth-bitwarden`:

- `vault.ts`/`crypto.ts` decrypt Bitwarden Desktop's local vault and expand FIDO2 credentials in-process.
- `provider.ts` filters credentials by RP ID and signs the SBI provider's requested challenge locally. It does not implicitly select among multiple candidates.
- `fido2.ts` generates the RP ID hash, UV/UP/BE/BS flags, counter, and client data containing the origin.
- `auth-manager.ts` has a generic portable private-JWK export function, so it is not adopted. Use only an SBI Securities-specific provider/issuer as the boundary.
- This demonstrates technical feasibility of assertion generation, but is not an official Bitwarden SDK. Kogane is responsible for verifying current vault-format compatibility, safe master-password entry, and SBI Securities acceptance.

Problems:

- Provider capabilities include `investments:trade`, implementing placement, amendment, and cancellation for cash/margin/IFD/theme-investment/FX orders.
- It can accept trading passwords, device ID registration, and phone-authentication callbacks during trading.
- Reads and writes share the same provider/session surface.
- Some endpoint hosts require environment variables, so the repo alone is insufficient for reproduction.

Adoption policy:

- Do not register this code in Kogane as-is.
- Port or fork only read methods and parsers into a separate module.
- Fix public capabilities to `accounts:read`, `balances:read`, `transactions:read`, and `investments:read` only.
- Exclude `tradePassword`, trading-authentication callbacks, device registration, order payload builders, and order-placement endpoints from the dependency graph and distribution.
- Allow only known read-only destinations/operations through runtime egress and method allowlists.

The reproduction overlay for real-account tests, synthetic tests, and secret-management boundaries are recorded in [`docs/research/sbi-securities.md`](../research/sbi-securities.md) (the overlay code has been removed from main; that document identifies the commit to read). This PoC was placed in the target commit's `mnie/scripts/`, and is not Kogane's production collector.

### `azuki774/myscrapers` (`e58339122eef9273fb2566f0a867057d3219b2f6`)

Go/Playwright implementation as of 2026-08-23. It reads SBI Securities' official login screen and five fixed pages without an aggregator.

Main implementation:

- Noninteractive login through CDP `WebAuthn.addVirtualAuthenticator` and a stored passkey
- Headless Chromium with a normal Chrome UA
- Visits official portfolio, NISA, foreign-equity holdings, and domestic/foreign account-summary pages at fixed URLs
- Parses body text into JSON for cash, NISA/old NISA, investment trusts, domestic/US equities, and USD cash deposits
- Outputs quantity, unit cost, unit price, valuation, unrealized gains/losses, previous-day/month changes, etc.

Limitations:

- DOM/display-text parsing is vulnerable to HTML changes.
- It does not cover all realized gains/losses, dividends, transaction history, or deposit/withdrawal history.
- Chromium and Playwright are required; it does not fit a Workers isolate.
- The design reads passkey private keys as plaintext JSON and needs better secret management.
- The old Python Selenium version in the repo assumes password login and has its execution route disabled; it is not evidence for current specifications.

This implementation suits the quickest connectivity check and value comparison against official screens. Reducing the final collector to read-only JSON confirmed from the screens would reduce maintenance cost.

### Others

SBI Securities clients and order bots using `requests`/Selenium from around 2017–2018 are also public, but assume the old login form and trading passwords. They are outdated for current authentication implementation and include ordering functionality, so Kogane does not reuse them.

## Strict separation of reading and trading

Kogane's SBI Securities collector is not complete until all the following conditions hold.

1. Never enter, store, put in environment variables, or log a trading password.
2. Do not register order preview/place/replace/cancel or foreign-exchange conversion in public APIs, CLI, or MCP.
3. Exclude order-related source files from the collector image/bundle.
4. Allowlist official read hosts and paths for runtime egress. For read protocols requiring `POST`, allowlist paths and TR codes too.
5. Verify zero order-related routes in fixtures/schema tests for retrieval routes.
6. In real-account tests, check only login history and official screen values; do not navigate to trading screens.
7. Store raw responses encrypted and never put them in the repo/CI artifacts/PRs. Fixtures must be fully synthetic data preserving structure.

The HTTP method `POST` alone cannot identify trading: passkey challenges and MTS read inquiries also use POST. Layered host/path/TR-code/capability allowlists are required.

## Execution-environment suitability

| Environment                             | Suitability | Reason                                                                                                                                                                               |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Local agent on user's device            | High        | Signs/retrieves without taking the Bitwarden vault, derived key, assertion, or SBI session off-device; first choice                                                                  |
| k8s CronJob/small VM in OCI Tokyo, etc. | Medium–high | Easy fixed Japanese IP, Chromium/direct HTTP, and timing control. No vault; restrict it to scheduler/processor receiving encrypted results from a local agent                        |
| General OCI container                   | Medium      | Supports both `mnie`-style HTTP and `myscrapers`-style Playwright, but no Bitwarden secrets. Generally avoid passing sessions from the local agent too                               |
| Cloudflare Containers                   | Low–medium  | Linux images and outbound controls available; fixed Japanese egress and persistence need actual verification. No vault/derived key/passkey                                           |
| Cloudflare Workers                      | High        | Independent HTTP implementation, encrypted secrets, and private R2 succeeded for real domestic/foreign account retrieval. Paid daily Cron can collect sequentially in one invocation |
| Cloudflare Browser Rendering            | Low–medium  | CDP endpoint available, but virtual WebAuthn credential support and persistent secret management unconfirmed. Not the first implementation target                                    |

Recent Workers runtimes have improving Node.js API compatibility, but `node:child_process` is a nonfunctional stub. Thus, instead of using Mnie as-is, the necessary parts, including RSA mixed OAEP, were implemented independently using only `node:crypto`. The entire vault is not placed in the cloud; only minimum SBI-specific passkey fields go into encrypted secrets. After moving to Workers Paid, daily invocation through R2 storage completes within Cloudflare Cron. GitHub Actions, Queue, and dispatcher used in Free testing are not adopted.

## Recommended architecture

1. **Minimize into an SBI-specific secret**: synchronize only RP ID, origin, credential ID, private key, user handle, and counter from the Bitwarden-stored passkey to Cloudflare secrets. No vault, master password, derived key, login/trading password; recreate sessions each run without persistence.
2. **Official Web as primary data source**: retrieve My Assets current valuations, weekly asset trends, realized gains/losses, dividends, and distributions.
3. **Supplement with official Web CSV/documents**: use two-year transaction/deposit-withdrawal CSVs and five-year electronically delivered documents for initial backfill and audit evidence.
4. **Supplement with stock-app read-only transport**: retrieve only fields absent from cross-product Web JSON, such as buying power and domestic holdings details.
5. **Separate foreign-equity adapter**: keep REST/GraphQL sessions separate from the domestic adapter and save US equity holdings/executions as a separate source.
6. **Preserve official values as raw evidence**: save the meanings of acquisition unit price, reference unit price, valuation, and gains/losses with source and timestamp; integrate in downstream normalization.
7. **No aggregators**: do not use Money Forward, Moneytree, etc. for login, retrieval, or fallback.

## Next validation procedure

1. Authenticate to SBI Securities with the official passkey flow in the user's normal browser; open My Assets, holdings, realized gains/losses, dividends/distributions, transaction history, and yen deposit/withdrawal statements in order. Network logs record only host, path, method, status, and schema, never tokens/cookies/account numbers/actual data.
2. **Complete**: retrieved the SBI Securities item using Bitwarden CLI 2026.8.0 only on the user's device, verifying RP match, unique candidate, and passkey metadata without displaying secrets.
3. **Complete**: matched the RP ID returned by the official challenge to the Bitwarden credential and generated an assertion containing the origin. Actual values, credential IDs, and user handles are not recorded in the repo.
4. **Complete**: a one-time HTTP test connecting existing `createBitwardenAssertion` and the SBI provider completed passkey callback, access-token decryption, MTS login, and domestic cash-equity holdings `F2631` entirely without a browser. Server total matched parsed count.
5. Only if HTTP assertions are not accepted, try a local Playwright/CDP virtual authenticator. Compare resident/discoverable credentials, user verification, conditional UI, `allowCredentials`, and passkey-button route differences; do not export private keys to plaintext fixtures.
6. After successful login, observe idle/absolute session lifetimes, concurrent sessions, reuse after restart, IP/UA changes, daytime/night/weekend behavior, 429/403/302, and additional email/phone authentication for at least 7 days. Save no session cookies or identifiers, only lifetimes and failure categories.
7. Obtain SBI Securities Plus legitimately from Google Play and statically check only the manifest, hostnames, network security config, and My Assets-equivalent read endpoints. The Stock App is second priority.
8. Build a minimal prototype completely excluding order code, device registration, trading passwords, and generic `credentials()`/`portableCredential` export from `mnie`. Initially allowlist only MTS login and cash-equity holdings `F2631`; then add buying power, My Assets current JSON, and yen deposits/withdrawals individually.
9. Implement local-agent pull jobs, one-time nonces, short-lived envelopes, egress allowlists, prevention of duplicate runs, exponential backoff, failure-only notifications, raw encryption, and redacted schema logs. Send only encrypted results to OCI/Cloudflare.
10. Once stable, compare Cloudflare Containers, then pure-fetch Workers as scheduling/result-processing layers. Reject them if overseas/variable egress increases additional authentication.
11. Retrieve two-year CSVs, five-year electronic delivery, and My Assets history since 2021-08 once, visualizing duplicates and period gaps.

## Unconfirmed items

- Server decisions on consecutive signature-counter use, assertion-reuse rejection, compatibility after authentication changes
- FIDO2 credential JSON schema compatibility on Bitwarden CLI updates
- Whether passwords can be disabled, phone-number authentication, conditional UI versus passkey-button route differences
- Current idle/absolute session lifetimes, reuse conditions, additional authentication after IP/UA changes
- All current My Assets endpoints, pagination, rate limits, session lifetime
- Next-page request endpoint/parameters for internal yen deposit/withdrawal APIs and conditions returning all two years shown in UI (do not guess/send unobserved requests; currently fail closed on multiple-page detection)
- Exact online retention periods for foreign-equity order/execution/deposit-withdrawal history
- SBI Securities Plus endpoints and backend sharing with PC My Assets
- Plus/Stock App TLS pinning, emulator/root detection, scope of EVERSPIN
- Practicality of Japanese egress and virtual WebAuthn authenticators from Cloudflare Containers/Browser Rendering
- Whether server-side use of stored passkeys complies with SBI Securities' latest terms/conditions
- Official-screen maintenance periods and the direct cause of simple HTTP access being redirected to maintenance

## Evidence

### Official SBI Securities sources

- [Passkey support across all channels and website login changes](https://www.sbisec.co.jp/ETGate/?OutSide=on&_ActionID=DefaultAID&_ControlID=WPLETmgR001Control&_PageID=WPLETmgR001Mdtl30&burl=search_home&cat1=home&cat2=info&dir=info&file=home_info260430_passkey.html&getFlg=on)
- [Whether passkey authentication becomes mandatory](https://faq.sbisec.co.jp/answer/6937e6e3b14749ed0cd6062a/)
- [Website login navigation changes](https://www.sbisec.co.jp/ETGate/?OutSide=on&_ActionID=DefaultAID&_ControlID=WPLETmgR001Control&_DataStoreID=DSWPLETmgR001Control&_PageID=WPLETmgR001Mdtl20&burl=search_home&cat1=home&cat2=none&dir=info&file=home_info251022_login_modification.html&getFlg=on)
- [Measures against unauthorized access](https://faq.sbisec.co.jp/answer/67e65898faf45f7a65208b67/)
- [Transaction and deposit/withdrawal history](https://faq.sbisec.co.jp/answer/5eba63cc171ba70012b8feb0/)
- [Transaction statements older than two years](https://faq.sbisec.co.jp/answer/5eba698b1149dd0011cbefa2/)
- [Capital-gains tax statements](https://faq.sbisec.co.jp/answer/5ee8737d144d40001145db62)
- [My Assets launch material](https://search.sbisec.co.jp/v2/popwin/info/home/irpress/prestory210826_011500.pdf)
- [SBI Securities Plus features](https://search.sbisec.co.jp/v2/popwin/guide/tool/sbi_app/01_first/feature.html)
- [Historical asset trends](https://search.sbisec.co.jp/v2/popwin/guide/tool/sbi_app/04_assets/balance_02.html)
- [Realized gains/losses](https://search.sbisec.co.jp/v2/popwin/guide/tool/sbi_app/04_assets/profits_loss.html)
- [Asset-information update timing](https://search.sbisec.co.jp/v2/popwin/guide/tool/assets/06_update/update_assets.html)
- [Acquisition/reference unit prices](https://faq.sbisec.co.jp/answer/5eafd3ef171ba70012b8fb35/)
- [Valuation and unrealized gains/losses calculations](https://faq.sbisec.co.jp/answer/5f191f5329ee940011749926/)
- [Foreign-equity transactions/balances](https://faq.sbisec.co.jp/answer/5ee9c598144d40001145dcc5/)
- [Bond transaction/interest-payment history](https://faq.sbisec.co.jp/answer/5ee1df0050df500012207449/)
- [Futures/options API](https://www.sbisec.co.jp/ETGate/?OutSide=on&_ActionID=DefaultAID&_ControlID=WPLETmgR001Control&_PageID=WPLETmgR001Mdtl20&burl=search_op&cat1=op&cat2=none&dir=service&file=op_service_05.html&getFlg=on)
- [Access from overseas](https://faq.sbisec.co.jp/answer/5ecb87e7d31ea500111ec9e1)
- [SBI Securities Plus Google Play](https://play.google.com/store/apps/details?id=jp.co.sbisec.sbiapp&hl=ja)
- [SBI Securities Stock App Google Play](https://play.google.com/store/apps/details?id=jp.co.sbisec.hyperkabu2&hl=ja)
- [EVERSPIN introduction explanation](https://www.sbisec.co.jp/ETGate/WPLETmgR001Control?OutSide=on&burl=search_home&cat1=home&cat2=none&dir=info&file=home_info201230_01.html&getFlg=on)

### Public clients (referenced as specification material)

- [`pnsk-lab/mnie` SBI provider](https://github.com/pnsk-lab/mnie/tree/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-sbi-sec)
- [`mnie` passkey session](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-sbi-sec/src/session/index.ts)
- [`mnie` read/write operations](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/provider-sbi-sec/src/provider.ts)
- [`mnie` Bitwarden passkey provider](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/provider.ts)
- [`mnie` Bitwarden WebAuthn assertion generation](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/fido2.ts)
- [`mnie` Bitwarden vault decryption](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/vault.ts)
- [`mnie` portable credential export path (not used in Kogane)](https://github.com/pnsk-lab/mnie/blob/c87e65c0a04c03c560962f8ead6e77415fb841f4/packages/auth-bitwarden/src/auth-manager.ts)
- [`azuki774/myscrapers` SBI implementation](https://github.com/azuki774/myscrapers/tree/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi)
- [`myscrapers` Playwright passkey session](https://github.com/azuki774/myscrapers/blob/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi/session_playwright.go)
- [`myscrapers` fixed-page collector](https://github.com/azuki774/myscrapers/blob/e58339122eef9273fb2566f0a867057d3219b2f6/myscraper/internal/sbi/fetch.go)

### Execution infrastructure

- [Cloudflare Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Cloudflare Containers outbound controls](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/)
- [Cloudflare Containers overview](https://developers.cloudflare.com/containers/get-started/)
- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

## Addendum: switch to shared DATA R2 (U09)

`services/collector-sbi-securities` does not read `COLLECTION_TARGET`. Its only
storage destination is binding `DATA` (`kogane-raw-evidence`). Switching and the
importer were retired on 2026-09-13 (`docs/collection.md`). The same
`JSON.stringify(body)` bytes are saved to `objects/<2hex>/<sha256>`, and
`runs/sbi-securities/<runId>/terminal.json` is written last.

All artifacts have role `collector_derived` and are assigned to
`domestic`/`foreign` units by the dataset name's `foreign-` prefix (the same rule
as the Importer). The terminal has a unit per requested scope and records each
scope's artifact count, coverage, and safe code separately. Failure in one scope
does not make the other look incomplete; a scope with 0 artifacts is `unknown`,
not an observation of zero balance. The `requested-window` range and `date_range`
are recorded only when the trigger specifies a period.

Passkey credentials, handshake keys, and session IDs appear in neither artifacts
nor terminals; failures retain only machine codes derived from `safeErrorDetails`.
Worker names and secrets are unchanged. The Processor's
`SHARED_R2_INGEST_ENABLED` gates registration, rather than switching the collector's
storage destination. See `docs/collection.md` for details.

## 2026-11-09 weekly asset history

Observed read-only in an authenticated ordinary Chrome session, following the
main site's My Assets link and clicking `資産推移情報を読み込む` (load asset
trends). `GET /account/api/assets/valuations` returned HTTP 200 without a query
or body. Request header names included Accept, Referer, User-Agent and browser
client hints; no CSRF header was present. Selecting `全期間` (all periods)
issued no additional account API request: it changed the client-side range.
No new login or collector invocation was performed for this observation.

The full response contained 44 consecutive seven-day points anchored at
Saturday 00:00 JST. This timestamp labels a weekly point, not its retrieval
or the provider's background update time. The general August 2021 product
retention description does not prove this account has points back to that
month. No actual dates, amounts or account identifiers are recorded here.

The response had exactly 16 root keys: `holdCategories`,
`valuationsTransitions`, `acquisitionCosts`, `balances`, and the same four
with suffixes `WithoutDeposit`, `WithoutIdeco`, `WithoutDepositAndIdeco`.
Transitions were keyed by 13-digit epoch milliseconds. Each category point
had valuation/acquisitionCost numbers and nullable profitLoss/profitLossRate
numbers. Native series were timestamp/value pairs. There was no pagination
or provider count field.

Further value-free comparisons established:

- Full holdCategories listed five categories: DOMESTIC_DEPOSIT,
  DOMESTIC_STOCK_SPOT, FOREIGN_DEPOSIT, SBI_HYBRID_DEPOSIT, FOREIGN_STOCK_US.
  The transitions contained those five plus ALL at every point.
- WithoutDeposit listed only the two stock categories, while every transition
  still contained all six keys. Excluded deposits included nonzero values.
  Only the listed categories participate in that profile's aggregate.
- For both available profiles, every native timestamp set matched the
  transitions. Native balances/acquisitionCosts matched ALL valuation and
  acquisitionCost at all 44 points, and sums of the listed categories matched
  ALL for both monetary fields at every point.
- Every non-null monetary value examined (660 per available profile) and
  native monetary tuple value was a safe integer. Deposit profitLoss and
  profitLossRate were null; stock and ALL values were numeric.
- Both iDeCo-related profiles had null transitions and empty category/native
  arrays. This is an unavailable shape, not a zero financial position. Their
  positive-data shape has not been observed.

[ADR 0098](../adr/0098-sbi-weekly-asset-history.md) implements only this observed
route and retains the catalogue as partial. Scheduled collection, publication,
returned earliest/latest keys and count, freshness, execution budget and any
account-specific earlier history remain unverified. A different retention
route or positive iDeCo shape requires observation before implementation.

## 2026-11-10 retained cash statements

Read-only observations used the owner's ordinary Chrome session and official
statement links. Search dates below are UI request parameters, never personal
transaction dates. No provider amounts, row ids, names, accounts, cookies or
tokens were recorded. These reads did not run a collector or modify an account.

The yen statement is `/banking/yen/detail-history` on the member site. Selecting
the two-year preset issued `GET /banking/api/yen/detail/query` with
`depositDateFrom=20241111`, `depositDateTo=20261110`,
`payDepKbnList=1,2,5`, `detailKbnList=11,12,13,14,15,16,17,18,21,22,23,24`,
`sortDateType=1`, `pageNumber=1`, `pageSize=10`, `totalCountKbn=1`.
The UI offers page sizes 10/20/50/100/150/200 and sort types 0 ascending /
1 descending. Clicking page 2 issued the same query with only `pageNumber=2`.

Each response had exactly these fields:

- `totalDepositAmount`, `totalDepositCount`, `totalPaymentAmount`,
  `totalPaymentCount`, `totalTransDepositAmount`, `totalTransDepositCount`,
  `totalTransPaymentAmount`, `totalTransPaymentCount`: strings.
- `totalCount`, `pageCount`, `pageNumber`, `pageSize`: numbers.
- `detailsConditions`: the fixed filter labels `['入金：すべて','出金：すべて']`.
- `exceededMaxCount`, `isExceededMaxCount`: booleans, both false.
- `depositRecordList`: rows with exactly `payDepDate`, `payDepKbn`, `detailKbn`,
  `dispAbstract`, `payAmount` strings and numeric `did`.

There was no `nextBusinessDate` field in this query response; historical init
artifacts have a different shape. Both pages declared total 20, two pages and
size 10, each returned ten rows, and all twenty `did` values were distinct.
The controls stayed identical across pages. Direction strings were `入金` and
`出金`; the observed detail labels were `その他`, `利金・配当金`,
`金融機関への出金`, `金融機関からの入金`. Exact value-free checks established that
each direction's count and sum of unsigned amounts matched its deposit/payment
controls. Both transfer counts were zero, so their relationship to the other
controls was not established.

The official foreign-cash link reaches `/banking/fc/detail-history`. Selecting
the five-year preset issued `GET /banking/api/fc/detail-history/search` with
`startDate=2021/11/11`, `endDate=2026/11/10`, `tradeKind=''`,
`currencyCode=''`, `pageNumber=1`, `pageSize=10`, `termKind=1`, `sortType=1`.
Opening detailed conditions, selecting the USD radio and querying issued the
same request with `currencyCode=011`. Both returned HTTP 200 and exactly
`{pageCount:number,totalCount:number,items:array,businessErrorMessage:null}`.
The observed filtered response had one page, total ten and ten rows, all code
`011`, whose fixed currency name was `米ドル`. Each row had exactly
`valueDate`, `tradeType`, `cometCurrencyCode`, `cometCurrencyName`, `description`,
`amount` strings and nullable/string `cashType`. Trade types were `入金` and
`出金`; cash types were null, `分配金`, `配当金`; all amount text was unsigned
decimal. No stable row-id field was present. A foreign second-page request
was not observable with the current one-page data and remains unsupported.

[ADR 0102](../adr/0102-sbi-retained-cash-history.md) uses only these request
shapes and exact labels. The normal collector requests all retained yen pages
and the retained USD statement, preserving per-page raw inputs. Unknown labels,
positive transfer controls, unknown currencies, changed totals or missing pages
keep coverage partial. The catalogue remains partial under #1226 until foreign
continuation/transfer semantics and actual scheduled retained publication,
freshness and the execution budget are verified. Dividend-labelled cash rows
publish settlement cash only; they establish no separate income dataset.

## 2026-11-10: My Assets income and realised gains

Normal signed-in UI reads on 2026-11-09/10 established the following request
shapes. Only schema, counts and in-memory equality predicates were retained;
no provider amounts, personal dates, security names, account identifiers or
authentication material were copied.

The visible `/account/assets/dividends` page states retention since August 2021. Setting the normal date inputs to `2021/08/01`–`2026/11/10` made:

- `GET /account/api/assets/dividends` with `category=''`, `accountType=''`,
  `dispositionDateFrom=2021/08/01`, `dispositionDateTo=2026/11/10`, `offset=1`,
  `limit=30`.
- `GET /account/api/assets/dividends/category/summary` with the same filters
  and dates, without offset or limit.

Rows are `{dividends:[...]}`. Each row has string `category`, `dispositionDate`
(`YYYYMMDD`), `accountType`, `productCode`, `productName`; numeric `quantity`
and `receivedAmount`; nullable numeric `interestAmount`, `dividendUnitCost`,
`dividendTotal`, `specialDividend`, `taxTotal`, `incomeTax`, `residentTax` and
their `Lc` counterparts, plus `receivedAmountLc`; `currencyCode` is string/null.
Observed categories were `DOMESTIC_STOCK_SPOT` and `FOREIGN_STOCK_US`, accounts
`SPECIFIC_NORMAL` and `NISA_GROWTH`, and currency codes null/domestic or USD/US.

Summary keys are `dividendsSummaries`, numeric `receivedTotal` and `countTotal`.
Each category has numeric `receivedTotal`, `dividendTotal`, `taxTotal`, `count`,
nullable numeric `receivedTotalLc`, `dividendTotalLc`, `taxTotalLc`, and
string/null `currencyCode` plus string `category`. The summary count of 14
matched all 14 rows and the visible total; category counts were 11 domestic
and 3 US rows. No row response count/header or continuation control was observed.

Expanded US detail's six USD-labelled values matched `dividendUnitCostLc`,
`dividendTotalLc`, `taxTotalLc`, `incomeTaxLc`, `residentTaxLc`, `receivedAmountLc`
exactly. Expanded domestic detail's six JPY-labelled values matched the same
unsuffixed fields; all 11 domestic rows had numeric values there and null
`interestAmount`, `specialDividend`, `currencyCode`. The final label is
`受取額(税引後)` (after-tax received amount); preceding detail labels establish
dividend per unit, gross dividend, total tax, income tax and resident tax.
The main table shows received amounts in yen. A US payment's `Lc` amount and
its unsuffixed yen equivalent are two representations of one payment.
Null gross/tax domestic semantics and a universal precision bound were not observed.

The visible realised-gains detail leads to `/account/assets/profits`, also
stating retention since August 2021. The same date inputs made
`GET /account/api/assets/profit-loss/summary` with `baseDateFrom=2021/08/01`,
`baseDateTo=2026/11/10`, `baseDateType=CONTRACT`, `accountType=''`, `product=ALL`,
`domesticCategory=''`, `countryCode=''`, `bondCategory=''`, `fundCategory=''`.
Its response is `{profitLossSummary,profitLossSummaryDetails:[...]}`. The
aggregate has null `assetsErrorType` and numeric `total`, `profitLoss`, `profit`,
`loss`, `profitLossLc`, `profitLc`, `lossLc`. Details have null `assetsErrorType`,
string `assetsBalanceCategory`, numeric `total`, `profitLoss`, `profit`, `loss`,
and null `profitLossLc`, `profitLc`, `lossLc`, `currencyCode`.

The domestic detail link uses `product=DOMESTIC_STOCK&category=SPOT`. Opening it
made the summary request with `product=DOMESTIC_STOCK&domesticCategory=SPOT`
and `GET /account/api/assets/profit-loss` with those same filters plus
`offset=1&limit=30`. Rows are `{profitLosses:[...]}` with string `category`,
`contractDate`, `dispositionDate` (dates `YYYYMMDD`), `accountType`, `productCode`,
`productName`, `transactionType`, and numeric `quantity`, `amount`, `price`,
`acquisitionCost`, `profitLoss`. Observed codes were `DOMESTIC_STOCK_SPOT`,
`NISA_GROWTH`, `SELL`. The one row matched summary total 1 and the visible total.
Headers establish contract date, account/transaction, security, quantity,
sale/settlement proceeds, unit price, **average acquisition unit cost**, and
realised gain/loss **before tax**. Do not treat the acquisition unit cost as
total cost or calculate a gain from trades.

Other menu product/account codes do not prove response semantics. Foreign
gains, interest/fund/bond income, offset values beyond 1 and totals over 30
remain unobserved. Production collection/publication was not performed.
