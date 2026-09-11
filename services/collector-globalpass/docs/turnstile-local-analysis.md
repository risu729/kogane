# Turnstile capture local analysis

This procedure indexes JavaScript response bodies already saved by Kuebiko or
by the bounded CDP probe. It does not modify the capture and does not place
response text, query values, or high-entropy challenge path segments in the
JSON report.

## Available local parser tooling

Checked in WSL on 2026-08-30:

- Node.js 26.8.1
- TypeScript 5.9.3 (direct development dependency)
- Esprima 4.0.1 and Escodegen 2.1.0 (available transitively)
- Prettier, Acorn, Babel parser, and Terser are not installed

The analyzer uses the TypeScript parser and printer because TypeScript is a
direct dependency of this PoC. It does not depend on incidental packages in the
Wrangler dependency tree.

## Safe report

Run from `poc/globalpass-worker`:

```bash
capture_run=/mnt/c/Users/risu/AppData/Local/Kuebiko/captures/2026-08-29T12-55-57
node scripts/analyze-turnstile-capture.mjs "$capture_run" \
  > /tmp/kogane-turnstile-index.json
```

The report contains, for each unique Turnstile JavaScript body:

- SHA-256 and byte length
- sanitized URL(s) and MIME type(s)
- TypeScript parse diagnostics and coarse AST statistics
- line/column indexes for `fetch`, `XMLHttpRequest`, `TextEncoder`, Web Crypto
  and `subtle`, base64 helpers, and common serialization primitives
- SHA-256 and length of the in-memory formatted representation

It does not contain source snippets, arbitrary identifiers, string literals,
request headers, cookies, query values, or challenge identifiers.

## Optional local formatted source

Formatting is performed in memory for every report. To write the formatted
source for deeper local inspection, explicitly select a directory outside the
Git worktree:

```bash
capture_run=/mnt/c/Users/risu/AppData/Local/Kuebiko/captures/2026-08-29T12-55-57
pretty_output=/tmp/kogane-turnstile-pretty
node scripts/analyze-turnstile-capture.mjs "$capture_run" \
  --pretty-dir "$pretty_output" \
  > /tmp/kogane-turnstile-index.json
```

Files under `pretty_output` contain raw response text. Do not copy them into
this repository, attach them to a pull request, or paste them into logs. Remove
the temporary directory after analysis.

## Verification

```bash
node --test test/analyze-turnstile-capture.test.mjs
node --test test/analyze-turnstile-debugger-capture.test.mjs
node --test test/compare-turnstile-probes.test.mjs
node scripts/analyze-turnstile-capture.mjs --help
```

The tests use synthetic bodies and identifiers only. They verify URL redaction,
absence of raw source in the report, the requested AST feature categories, and
capture-directory traversal protection.

## Compare private embedded captures

Some probes store request and response bodies inside one private JSON file. The
comparison command hashes and parses those bodies in memory and emits only a
redacted structural report:

```bash
left_capture=/path/outside-git/left.json
right_capture=/path/outside-git/right.json
node scripts/compare-turnstile-probes.mjs "$left_capture" "$right_capture" \
  > /tmp/kogane-turnstile-comparison.json
```

The comparison covers captured script body hashes, AST and normalized token
shape, POST body length/entropy/character shape, header names, and initiator
stack locations. Arbitrary function names are represented only by length and
SHA-256.

An initiator frame can be mapped to its enclosing AST function only if the
capture also contains that exact script source. `sourceCoverage` records mapped
and unmapped frames and lists sanitized missing source URLs. If an OOPIF
document body was not captured, the report must not claim to have recovered its
send function; a future capture must save the matching `Debugger.getScriptSource`
result or the document response body from the correct target session.

## Debugger script-source captures

The CDP capture script can also save `Debugger.getScriptSource` results in the
top-level `scripts` array. Analyze one or compare two such captures with:

```bash
successful_capture=/path/outside-git/success-debugger.json
failed_capture=/path/outside-git/failure-debugger.json
node scripts/analyze-turnstile-debugger-capture.mjs \
  "$successful_capture" "$failed_capture" \
  > /tmp/kogane-turnstile-debugger-comparison.json
```

The report maps POST initiator frames by the exact target session and raw URL
in memory. Its output contains only sanitized URLs, hashes, lengths, AST shape,
allowlisted Web API names, and structural summaries. The raw script source,
POST bodies, response bodies, headers, cookies, arbitrary identifiers, and
challenge identifiers are never serialized.

`webcrack` can optionally normalize the local source before the same safe
allowlist scan. It is deliberately not a project dependency. Point the analyzer
at an outside-worktree installation with `WEBCRACK_MODULE=/absolute/path/to/index.js`.
The normalized source remains in memory and is not written to Git or the report.

## 2026-08-30 successful and failed probe comparison

The successful WSL/TAMIA capture and failed OCI/TAMIA capture shared the exact
84,236-byte `api.js` loader, but their OOPIF `rch` runtimes were different
session-specific programs:

- success runtime: 249,222 bytes, 108,951 AST nodes, 1,386 bitwise operators
- failure runtime: 248,518 bytes, 109,106 AST nodes, 1,357 bitwise operators
- the source hashes and AST shape hashes differed, while the allowlisted API
  vocabulary and overall architecture were the same

Both runs performed two XHR POSTs to the same sanitized endpoint shape. In both
runs the first body was 3,788 bytes. The second body was 85,527 bytes on success
and 85,986 bytes on failure. The first response was an opaque, base64-like,
high-entropy program (823,224 versus 846,312 bytes) and did not exactly match
any captured JavaScript source. This supports the interpretation that the
existing `rch` runtime decodes/interprets it as challenge bytecode rather than
executing the response verbatim as JavaScript.

The second response is the clearest success/failure discriminator observed in
these two samples: 4,288 bytes on success versus 127,724 bytes on failure. Both
HTTP statuses were 200, so HTTP status alone cannot identify acceptance. The
larger failed response is consistent with an additional challenge or rejection
program, but that meaning remains an inference until runtime instructions or
the resulting page state are correlated.

The second POST used the same top-level transport wrapper as the first POST,
but had a deeper initiator stack (7 frames on success, 8 on failure). In the
successful capture, those additional frames included functions containing the
`navigator`/`performance` and `localStorage` string tables. This connects the
large second payload to VM-driven environment collection more strongly than a
source-wide string search alone.

The runtime's allowlisted vocabulary includes `XMLHttpRequest`, `open`, `send`,
`setRequestHeader`, `readyState`, `status`, `responseText`, `TextEncoder`,
`Uint8Array`, `ArrayBuffer`, `DataView`, `atob`, `crypto`, `getRandomValues`,
`navigator`, `platform`, `language`, `maxTouchPoints`, `innerWidth`,
`innerHeight`, `performance`, `speechSynthesis`, and `localStorage`. A static
string reference proves that an API is available to the VM, not that its value
was used in a particular request. Standard Web Crypto operations such as
`subtle.encrypt`, `subtle.digest`, and `subtle.importKey` were not present. The
combination of `getRandomValues`, byte-array primitives, `TextEncoder`, `atob`,
and more than 1,300 bitwise operations points instead to a randomized custom
binary codec/VM envelope. Static analysis does not justify naming a standard
cipher.

The AST also finds VM host-property resolver patterns equivalent to choosing a
property key directly when no host object exists, or resolving
`hostObject[propertyKey]` otherwise, then calling the resolved target. There
were six such sites in the successful runtime and three in the failed runtime.
This explains why a conventional search for direct `navigator.userAgent` or
`xhr.send(...)` calls misses most behavior: host API names are bytecode values
resolved by the interpreter at runtime.

## Targeted runtime observation

A useful next probe is a conditional CDP breakpoint at each AST-detected host
property resolver. On pause, inspect only the property-key local and record an
allowlisted API name, or otherwise only its length and SHA-256. Do not persist
arbitrary raw values. Install the breakpoint when `Debugger.scriptParsed`
reports the session-specific `rch` source; columns cannot be reused across
captures because the runtime is rebuilt per challenge.

Pausing on every resolver call would produce a large timing disturbance and
could itself change the Turnstile result. Prefer either a condition limited to
specific allowlisted names (`XMLHttpRequest`, `send`, `navigator`,
`performance`, `localStorage`, and similar), or a very small pause budget. A
`beforeScriptExecution` instrumentation breakpoint can avoid the race when
installing the resolver breakpoints, but it also adds startup delay and should
be tested in a separate probe. The current static result links the VM and
transport structurally, but no captured initiator frame landed directly inside
the detected property-resolver function, so runtime observation is required to
prove the exact property sequence used for each POST.

Two bounded successful WSL runs then tested that observation path. A breakpoint
installed from the first POST initiator paused at the second POST wrapper while
the final token still reached 794 characters, so the targeted breakpoint did
not change the observed success outcome. The wrapper received an opaque string
and VM state/function tables, not a descriptive JavaScript object with sensor
field names. A second run installed `beforeScriptExecution` plus the detected
resolver breakpoints. It still produced a 794-character token but reached only
one resolver pause within the small pause budget, and the only identifier-like
local was a session-specific high-entropy value. It did not prove a browser API
name and is not published. This confirms that looking only at the transport
wrapper cannot recover the pre-envelope field map.

The capture implementation is
[`scripts/capture-turnstile-cdp.mjs`](../scripts/capture-turnstile-cdp.mjs).
It attaches to OOPIF and worker targets, stores response/request bodies and
compiled script sources only in an explicitly selected mode-0600 file outside
Git, and limits VM pauses. [`scripts/run-turnstile-capture-chrome.sh`](../scripts/run-turnstile-capture-chrome.sh)
starts the otherwise normal headed Chrome/Xvfb control without Playwright.
Debugger-heavy runs are diagnostic only.

Temporary analysis installs and reports are cleanup targets. In the documented
probe environment these include `/tmp/kogane-turnstile-tools`,
`/tmp/kogane-turnstile-index.json`,
`/tmp/kogane-turnstile-comparison.json`, and any explicitly selected pretty
source directory. Private captures remain outside the Git worktree.

## Public automation implementations and applicability

Cloudflare explicitly states that Selenium, Puppeteer, Playwright, and Cypress
are unsupported for solving production challenges. Its recommended automated
test route uses dummy sitekeys, which cannot help with a third-party production
widget. This is the baseline against which community claims should be read:

- [Cloudflare supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)
- [Cloudflare automated testing keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
- [Playwright request for Turnstile bypass, closed as not planned](https://github.com/microsoft/playwright/issues/23884)
- [Playwright headless failure on a Cloudflare-protected site](https://github.com/microsoft/playwright/issues/23563)

Cloudflare Browser Run is a poor fit for this third-party login even though it
provides a convenient serverless Chrome. Cloudflare documents that Puppeteer,
Playwright, and CDP requests from Browser Run receive a non-configurable
`cf-brapi-devtools` header and Web Bot Auth signatures with a published bot
detection ID. That makes the automation origin explicit to the destination and
is consistent with the unsuccessful Browser Run probe:

- [Browser Run automatic request headers and bot detection](https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/)

The relevant self-hosted approaches all run a real Chrome process, usually
headed under Xvfb, and try to reduce automation protocol fingerprints:

- [`nodriver`](https://github.com/ultrafunkamsterdam/nodriver) is the current
  successor to undetected-chromedriver. It controls Chrome directly over CDP,
  avoids Selenium/WebDriver, recommends Xvfb on headless servers, and can attach
  to a persistent profile. It is AGPL-3.0. Its built-in Cloudflare checkbox
  helper is an interaction helper, not a guarantee that a production challenge
  will accept the browser.
- [`rebrowser-patches`](https://github.com/rebrowser/rebrowser-patches) patches
  Puppeteer/Playwright's `Runtime.enable` automation leak. It is a smaller change
  to the existing Node container, but the project documents version-specific
  support and warns that patches are fragile across library updates.
- [`puppeteer-real-browser`](https://github.com/ZFC-Digital/puppeteer-real-browser)
  combines real Chrome, Xvfb, rebrowser-patched Puppeteer, and realistic cursor
  movement. The repository now says it will no longer receive updates, so it is
  useful as implementation evidence, not a good long-term dependency.
- [`undetected-chromedriver`](https://github.com/ultrafunkamsterdam/undetected-chromedriver)
  is the older Selenium-based option. Public reports show Cloudflare behavior
  changing and Turnstile no longer passing reliably, so it is lower priority
  than nodriver.
- `puppeteer-extra-plugin-stealth` is insufficient on its own; its open
  [Turnstile/Cloudflare failure issue](https://github.com/berstend/puppeteer-extra/issues/908)
  reproduces failure even in headed mode.

The lowest-risk next Container experiments are therefore:

1. Google Chrome stable, headed under Xvfb, persistent Kogane-only profile,
   coherent Japanese locale/timezone/viewport, and `nodriver` without its
   `expert` mode or any injected fingerprint overrides.
2. The same Chrome/profile/network with the existing Node implementation but a
   version-pinned rebrowser patch, avoiding Debugger/Runtime instrumentation in
   the collection run.
3. Only if a checkbox is actually presented, use a trusted-coordinate real
   pointer click; do not introduce a token-returning solver service.

Each experiment must change one variable at a time and compare the two POST
sizes, initiator stack, second response size, and final page state. A Turnstile
token or HTTP 200 alone is not acceptance evidence. The Debugger-heavy capture
mode is for diagnosis only: enabling Debugger/Runtime and installing
breakpoints may itself change the score and should not be used for the final
collector.
