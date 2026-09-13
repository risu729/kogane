# Mizuho direct collection feasibility

This local experiment is a bounded public-entry probe for Mizuho Direct. It
uses Bun's normal HTTP client without credentials, a cookie jar, authentication
submission or retries. It has no package dependencies.

```sh
mise run //experiments/mizuho-direct:probe
mise run //experiments/mizuho-direct:ci
```

Only `probe` contacts the bank. Tests use synthetic responses and HTML, and do
not run the live command. No deployment
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

The account/history parsers have been promoted into
[`packages/parsers`](../../packages/parsers/src/parsers/mizuho-html.ts), with
their synthetic regression tests in
[`mizuho-html.test.ts`](../../packages/parsers/test/mizuho-html.test.ts).
The integrated [Mizuho collector](../../services/collector-mizuho/) uses those
shared parsers. This experiment contains no duplicate parser implementation.

On 2026-09-13, an owner-authorized browser login and read-only account/history
navigation succeeded under Kuebiko capture. A separate local WSL HTTP test
reused that session to fetch the account list successfully without resubmitting
the password. This establishes a local balance-read path, not unattended login,
session renewal, direct HTTP history pagination or cloud compatibility.
The collector's implementation and readiness are documented with the
[service](../../services/collector-mizuho/); this public probe does not establish
its deployment or session-refresh status. No authenticated fetch runner or
credential storage is included in this experiment. See the current
[source research](../../docs/sources/mizuho-bank.md).
