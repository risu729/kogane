# SBI Shinsei: first history acquisition slice

Status: in progress; offline validation implemented, acquisition not enabled.
Date: 2026-10-10.
Issue: [#447](https://github.com/risu729/kogane/issues/447).
Decision: [ADR 0070](../adr/0070-sbi-shinsei-observed-history-boundary.md), proposed.

## Current boundary

The shipped collector still reads two bootstrap operations and four snapshot
operations. Its shared terminal uses `full_snapshot` with no date bounds,
units, ranges or reports. The two history/CSV catalog entries retain
`liveValidated: false`, `productionEnabled: false` and `responseSchema:
"unknown"`: a small UI observation does not approve scheduled acquisition.
Monthly reports have no catalog entry. No existing snapshot, persistence,
parser, adoption or schedule path changes in this slice.

## Observation completed

The owner logged in, then the agent used only the ordinary yen-savings
activity screen: recent rows, current month, previous month, and an explicit
period equal to that previous month. No new credential, OTP, permission,
transaction, memo edit or settings change was performed.

- `getCasaAccountActivitySpecificPeriod`: POST with `requestParam` containing
  `accountNo`, `type`, `fromDate`, `toDate`, `eventType`. Recent rows used
  `type=0`, `eventType=0` and empty dates. Both month presets and the explicit
  period used `type=1`, `eventType=3`, with `YYYYMMDD` dates. Only the explicit
  period contract is implemented offline.
- Nonempty period response: HTTP 200, adapter code `0`, activity status
  `00000`; two rows, one visible page, matching account and requested dates
  (response dates and posting dates use `YYYY/MM/DD`). Auxiliary memo and
  transformed-description arrays refer to the same row IDs. `purgeflag=Y`
  was seen but its meaning was not established.
- Empty current-month response: HTTP 200 and adapter `0` are not sufficient
  to call a response successful. The UI reported no matching activity and
  the activity status was `30224`, all context fields empty, zero rows and no
  auxiliary blocks or CSV control. This is a provider-reported empty result,
  not a verified echo of the requested account/period. Other error statuses
  remain unsupported, not empty.
- `csvDownload/getCsv`: ordinary CSV-button POST, HTTP 200,
  `text/csv;charset=Shift_JIS`, six header columns and two rows. The decoded
  CSV's posting dates, descriptions, debit, credit, balance and memo matched
  the period response in the same order. The browser network interface
  returned decoded text; no byte-exact file or completed browser-download
  event was verified. Do not call this a saved original.
- CSV request fields include `token`, `refineCd`, `beginDate`, `endDate`,
  `nationalId`, `langCode`, `systemCode`, `accountNo`, `productCode`, `type`,
  `fromDate`, `toDate`. The explicit period used `refineCd=range`, display
  dates `YYYY / MM / DD`, effective dates `YYYY/MM/DD`, with matching bounds.
  The previous-month preset used `refineCd=5` and its display end date did not
  equal the effective end date, although its CSV was identical. Do not
  conflate these two date pairs or invent a preset builder.

Only shapes, protocol codes, counts and match results belong in repository
evidence. No live capture, account identifier, name, amount or transaction
text belongs in fixtures. Tokens never belong in an artifact or log.

## Follow-up public-source evidence and stopped observation

On the same date, the already-loaded public client files
`js/controller/AI0002_account_activity.js` and `js/service/utility.js` were
read without evaluating their functions or reading live storage/token values.
This is static client evidence, not a successful acquisition or pagination run:

- Activity display uses a 30-row client page. Its `changeAbstract` path can
  request memo/description enrichment from the same period endpoint with
  `eventType=1` and `accountActivityDetails` references. Display descriptions
  may be replaced by `descriptionTransform`. The two-row observation had
  matching raw/transformed/CSV descriptions; larger or differing cases remain
  unverified. The offline inspector requires auxiliary references for every
  row and rejects a CSV that differs from the raw JSON description.
- The CSV success callback creates a `text/csv` Blob by prefixing a U+FEFF
  character to the decoded response string. The browser artifact
  is therefore a UTF-8 BOM derivative, not the original declared Shift_JIS
  HTTP bytes. Its exact bytes and a completed download still have not been
  captured. Future evidence must distinguish the HTTP response, decoded text
  and browser-generated file and record the transformation between them.
- CSV body `token` comes from `util.getToken()`. The public getter returns
  the client token, and its setter also populates the `X-CSRF-Token` header.
  This identifies the static source, not the runtime rotation/collector-session
  boundary. No token or session-storage value was read or recorded.
- The date picker bounds use the server date and the first day of its month
  two years earlier. This agrees with the official history-availability
  guidance below, but does not prove server row limits or period completeness.

One later ordinary UI query attempted a three-month period. It reached error
`CME0042` with a re-login/inactivity notice and logout; no period-history request
was emitted. The agent stopped without reauthentication. No three-month rows,
page continuation, CSV or retention-edge success was obtained from that attempt.

Official public guidance rechecked on 2026-10-10:

- [History FAQ](https://faq.sbishinseibank.co.jp/faq_detail.html?category=687%3Fpage%3D1&id=105&page=1):
  activity is available from the query date back to the same month two years
  earlier; desktop CSV is available. This is advertised availability, not
  proof that this collector retrieved that entire interval.
- [Report guide](https://www.sbishinseibank.co.jp/service/newpd/guide/estatement_kakunin.html):
  reports can be selected from the latest report month back through 60 months.
  [Report FAQ](https://faq.sbishinseibank.co.jp/faq_detail.html?id=112550)
  says a month's report becomes viewable on the next month's seventh business
  day. No report UI, report request or PDF bytes were observed in this slice.

## Implemented locally

`src/local/history-observation.ts` has no runtime caller. It builds the
observed explicit-period body with a local 31-day budget, validates bounded
decoded JSON with strict key/type/context checks, distinguishes the observed
empty status, and compares a declared Shift_JIS decoded CSV with its peer
JSON rows. It rejects unknown shapes/errors, context drift, malformed dates,
duplicates, incomplete auxiliary rows and CSV differences. It never returns
complete coverage and reports neither byte-exact capture nor persistence.

The all-profile route regression proves refusal before session reads, token
rotation or network access. Synthetic tests are not a hosted collection test.

## Next authenticated UI work (owner-controlled)

1. Reuse the authenticated tab if still valid. If expired, the owner logs in;
   do not automate new authentication, OTP/QR/FIDO or extra permission.
2. Observe the next-page control only when a bounded requested period has
   more than one page. Record method/path and field changes, page/row counts,
   duplicate/missing-reference comparisons and UI totals, never values.
   A one-page sample cannot establish pagination or a maximum-row limit.
3. Observe the UI's maximum-period/truncation notice and establish the meaning
   of `purgeflag` from the UI or confirmed provider semantics. Until then even
   a matched small CSV remains unknown for full requested-period coverage.
4. For CSV, verify the remaining runtime token/rotation boundary without
   exporting token values. Capture the ordinary download as a browser-derived
   UTF-8 BOM artifact, not as the original HTTP bytes. Original-response byte
   capture requires a separately verified, approved capture path. Record each
   artifact's encoding, byte length, digest and transformation lineage; compare
   rows with its peer JSON. Retain private evidence only in the explicitly
   approved store. Neither a click nor decoded CDP text proves a saved file.
5. Monthly PDF navigation is separate. Start with one visible report, not a
   full retention sweep; establish request, byte capture, report month and
   structure before a PDF parser. Apply the public retention/publication rules
   above without treating advertised availability as observed completeness.

Stop at login redirects, 401/403/429, a challenge, or a protected-operation
screen. No transfer, FX, deposit creation/cancellation, memo or settings flow.

## Offline implementation after those observations

- Add an exact same-page read path without changing the existing snapshot
  outputs. Keep unknown account families, windows and pagination unsupported.
- Preserve approved provider evidence append-only, sanitize authentication
  material before leaving the page, and write a terminal last. Keep requested
  period, provider-echoed period, pages and truncation/unknown reasons separate.
  Successful earlier-page evidence must survive a later-page refusal.
- Add a separate history dataset/parser registration with synthetic replay
  tests. Do not assume top-page reference IDs have the same identity scope;
  verify overlaps across periods/captures before changing publication rules.
- Explicitly prevent double counting the same bank transaction from top,
  period JSON and CSV. Keep raw preservation, parsing, publication/adoption,
  and owner-accepted economic relations separate.
- Require fresh independent review, relevant native CI, approved deployment
  and read-only production evidence before claiming acquisition is enabled
  or complete. Do not close #447 for this offline slice.
