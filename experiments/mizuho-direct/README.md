# Mizuho direct collection feasibility

This local experiment includes a bounded public-entry probe and offline parsers
for observed Mizuho Direct ordinary-deposit account and history HTML. The probe
uses Bun's normal HTTP client without credentials, a cookie jar, authentication
submission or retries. The parsers accept HTML in memory and make no requests.

```sh
mise run //experiments/mizuho-direct:probe
mise run //experiments/mizuho-direct:ci
```

Only `probe` contacts the bank. Tests use synthetic responses and HTML, and do
not run the live command. The HTML parsers use `parse5`. No deployment
configuration, cloud resources or schedules are included.

The result distinguishes an observed public login form (`login-ready`), the
known page codes `maintenance-50010` and `unsupported-environment-50020`, a
challenge, an unknown response, and transport/limit failures. These outcomes
describe this HTTP request and environment. A maintenance or unsupported
response does not establish a bank-wide outage or browser incompatibility.
`login-ready` does not establish successful authentication or direct collection.

The report contains HTTP status, allowlisted content type, final allowed
origin/path, byte count, elapsed time, known public form field names, and
sanitized base/form actions. It never outputs bodies, input/hidden values,
cookies, arbitrary headers, URL queries, credentials or arbitrary field names.
The CLI accepts no arguments. It reads no files or authentication environment
variables and writes no files.

Requests are restricted to HTTPS `web.ib.mizuhobank.co.jp` or numeric `webN`
hosts and `/servlet/LOGBNK0000000B.do`, with no query, fragment or userinfo.
Redirects are checked before following and capped at three; the complete chain
has a 15-second deadline and a 512 KiB body limit. The next login form action
may appear in metadata but is never submitted. Response bodies stay in memory
only while inspecting public markup.

HTML inspection is deliberately narrow: only the known customer-number form
is recognized. Different markup remains unknown rather than being treated as
an authenticated session. No browser fingerprint, JavaScript execution,
WAF bypass or session portability is implemented.

`parseAccountPage(html)` returns ordinary JPY accounts with branch/account
identity and current/available balances. `parseHistoryPage(html, account)`
checks the history page against the discovered account and returns dated,
signed movements, balances after each movement and displayed/total counts.
Amounts are exact integer yen strings. Page-local row indices are not stable
transaction IDs. Separate identical transactions remain separate; duplicate
desktop/mobile balance elements within a row must agree. Unsupported account
types, malformed fields, authentication pages and unobserved empty states fail
with fixed error codes. Returned records contain private financial data and
must not be logged or committed.

On 2026-09-13, an owner-authorized browser login and read-only account/history
navigation succeeded under Kuebiko capture. A separate local WSL HTTP test
reused that session to fetch the account list successfully without resubmitting
the password. This establishes a local balance-read path, not unattended login,
session renewal, direct HTTP history pagination or cloud compatibility.
No authenticated fetch runner or credential storage is included in this
experiment. See the current [source research](../../docs/sources/mizuho-bank.md).
