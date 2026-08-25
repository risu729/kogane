# Vpass authentication and session transport experiments

Observed on 2026-08-26. No Vpass ID, password, cookie value, account payload,
card identifier, HAR, profile archive, or screenshot is committed here. Cookie
counts describe only `smbc-card.com` records and are not sufficient to recreate
a session.

## Question

The experiments separate two capabilities that earlier notes treated as one:

1. **Issue or refresh an authenticated Vpass session** by submitting the
   password login through the Akamai-protected endpoint.
2. **Consume an already authenticated session** in another browser, OS, host,
   or network.

The observed answer is asymmetric but not deterministic: visible Windows Chrome
has produced successful bootstraps and failures under closely related
conditions, while Linux Chrome can consume a transported session but has not
been able to refresh it after expiry.

## Result matrix

| Source or test profile | Target/runtime | Operation | Result |
| --- | --- | --- | --- |
| Established Windows Kuebiko profile, current auth already invalid | Same Windows Chrome 153 profile, visible UI interaction | New password login | Success; My Page loaded without Access Denied |
| Same successful login, 33 live cookies | Completely new Windows profile | Open My Page | Success |
| Same successful login, 33 live cookies | WSL, headed official Chrome 151 | Open My Page | Success |
| Same successful login, 33 live cookies | OCI ARM64, headed official Chrome 151 | Open My Page | Success |
| Closed Kuebiko capture, 17 cookies including session cookies | OCI ARM64, headed official Chrome 151 | Open My Page | Success |
| The later-expired 33-cookie set | OCI ARM64, headed official Chrome 151 | Open My Page | Redirected to login |
| Same expired source profile | A new tab in the original Windows process | Open My Page | Redirected to login; the old rendered tab was stale |
| Completely fresh Windows profile | Windows Chrome 153 | Password login, then one retry | Returned to the login form both times; no credential-error text or explicit Access Denied page |
| Fresh Windows profile plus only captured Akamai-named cookies | Windows Chrome 153 | Password login, then one retry | Same result as the fresh control |
| Completely fresh Linux context | WSL, headed official Chrome 151 | Password login | Access Denied at `/memapi/jaxrs/xt_login/agree/v1` |
| Fresh Linux context plus only captured Akamai-named cookies | WSL, headed official Chrome 151 | Password login | Same Access Denied result |
| Persistent WSL profile previously seeded with a valid transported session | WSL, headed official Chrome 151 | Password login after that session expired | Access Denied at the same login endpoint |
| Camoufox 0.5.5, coherent Windows Firefox 152 fingerprint | Linux Docker, AU/SYD WARP egress | Password login | Login page 200; login POST 403 / Access Denied |
| Camoufox 0.5.5, coherent macOS Firefox 152 fingerprint | Linux Docker, AU/SYD WARP egress | Password login | No expected login POST; inconclusive |
| Kameleo 5.1 Chroma, coherent Windows Chrome 152 fingerprint | Linux Docker, AU/SYD WARP egress | Password login | Login page 200; login POST 403 / Access Denied |
| Persistent Kameleo Windows Chrome, public-site warm-up and human-like input | Same Linux Docker runtime | Password login | Test click did not submit the form; inconclusive |

The Akamai-only arms used two captured Akamai-named cookies; one was already
expired and was not retained by a fresh browser. The browser generated and
rotated additional Akamai cookies normally before the login attempt. Copying
those cookie names and values therefore did not reproduce the established
profile's accepted state.

The established Windows re-login updated eight existing first-party cookies
and added one. Of five Akamai-named cookies, three changed and two retained the
same value. Akamai state was updated rather than cleared wholesale. Immediately
after that login, both the new session and the older closed-capture session
still worked from OCI. Vpass did not enforce a single globally active session
in this trial.

## TAMIA exit-node and input-path control

A later same-day control changed the local Windows and WSL default route from
the Australian address `129.94.128.25` to the `tamia` exit node address
`223.223.22.214` in Japan. The route was verified in both Windows and WSL before
the trials.

| Profile and operation | AU direct | JP via `tamia` | Interpretation |
| --- | --- | --- | --- |
| Completely fresh headed WSL Chrome 151, initial Vpass GET | HTTP 200 login page | HTTP 200 login page | Neither IP was unconditionally blocked. |
| Previously rejected persistent WSL profile, initial Vpass GET | HTTP 403 | HTTP 403 | That profile/cookie state remained rejected across the IP change. |
| Completely fresh headed WSL Chrome 151, password login | Previously HTTP 403 at login POST | HTTP 403 at the same login POST | Japanese home egress did not make Linux password login pass. |
| Completely fresh visible WSL Chrome 151, user typed and clicked manually | Not repeated | Access Denied | Removing CDP/automation input did not make Linux login pass. |
| Previously successful Windows profile, CDP `Input.insertText` plus dispatched mouse events | Returned to login form | Returned to login form | Changing only the exit IP did not change this automation result. |

The Windows CDP trials were not explicit Access Denied pages and did not show a
credential-error message. Cookies rotated in both cases, but authentication was
not issued. The later manual WSL trial removes synthetic input as the explanation
for the Linux 403. The remaining difference is a broader coherent platform and
profile context; the captured evidence does not identify one exact Akamai rule.

The test ended with `tamia` selected as the local exit node. Temporary fresh
profiles were removed, and the two test-only Kuebiko captures that included
unrelated extension/startup traffic were sent to the Recycle Bin. No existing
profile or earlier retained evidence was removed.

## What the wire showed

The login form submitted `userid` and `password` as URL-encoded fields to:

```text
https://www.smbc-card.com/memapi/jaxrs/xt_login/agree/v1
```

The observed DNS chain was:

```text
www.smbc-card.com
  -> www.smbc-card.com.edgekey.net
  -> e17338.dsca.akamaiedge.net
```

The values matched the credentials supplied to the form. They were protected
by TLS on the network, but the request goes through the Akamai edge serving the
Vpass hostname. This establishes edge visibility in the normal reverse-proxy
path; it does not establish what Akamai stores or whether account identity is a
Bot Manager scoring key.

Separate telemetry requests did **not** contain the raw known ID or password:

- Vpass called `UAService/getDevice/v1` with a small JSON envelope.
- `/akam/13/pixel_*` received the named browser, screen, font, navigation, and
  timing fields documented in the earlier capture analysis.
- The rotating random first-party endpoint received repeated opaque text
  payloads of roughly 2-6 KiB.

Akamai does not need the account ID inside those sensor payloads to rate-limit
or reject a browser. Cookies, IP, TLS/browser fingerprint, timing, interaction,
session flow, and the protected login request can be correlated at the edge.

## What is established

- Browser process lifetime and server session lifetime are independent. A
  closed browser's captured session still worked, while a running browser's
  rendered My Page remained visible after its session stopped working.
- A valid Vpass session was portable across Windows and Linux, Chrome 153 and
  Chrome 151, x86_64 and ARM64, and the local and OCI hosts in these trials.
- The successful session was not strictly bound to the source IP or source
  Chrome profile at the time it was consumed.
- Password login was not portable. A Linux profile that had successfully used
  a transported session still failed the next password login after expiry.
- Akamai-named cookies alone are not the missing state. The accepted Windows
  profile may also depend on other first-party state, profile continuity,
  accumulated sensor history, platform/browser characteristics, and current
  server-side score.
- Repeating a rejected login in the same Windows profile did not improve it.
  Linux returned an explicit edge denial on the first attempt.
- A controlled AU/JP exit-node change did not change the login outcome. `tamia`
  is not a demonstrated remedy, and the AU address was not a universal block.
- CDP text insertion plus dispatched mouse events did not reproduce the earlier
  successful visible Windows interaction, even in the previously accepted
  profile.
- A completely fresh visible WSL Chrome profile also received Access Denied
  when the user typed and clicked manually. Linux rejection is therefore not a
  Playwright/CDP-input artifact in this control.

## Recommended boundary

Treat Vpass authentication as two components:

```text
repeatedly validated persistent browser runner (not selected)
  -> validate existing session
  -> if needed, perform one bounded OS-level UI login in the established profile
  -> export a minimal point-in-time session envelope
  -> encrypt for the named collector and publish a new auth generation

Cloudflare Container or OCI Kubernetes collector
  -> start an isolated Chrome context
  -> import the newest session generation before first Vpass navigation
  -> validate with a read-only My Page/internal-JSON request
  -> run page-local JSON collection while valid
  -> publish a rotated encrypted session generation if still valid
  -> discard the local context after checkpointing evidence
  -> stop on redirect, 401, or 403; never retry password login
```

Visible Windows Chrome is the only platform that has issued a session, but it
is not yet a stable control: an established profile and several fresh profiles
succeeded, while closely related fresh trials failed. The operator does not
want physical Windows automation as a deployed dependency. Linux is a proven
**session consumer**, not a proven issuer.

Establish at least two manual Windows successes after separate restarts with
IP, profile, language and window state fixed. Then compare fresh Windows and
automation in that same established profile. Only after that control is stable
should the retained persistent Kameleo Windows Chrome profile be retried. A
coherent Windows/macOS implementation inside Cloudflare Containers is an
acceptable deployment candidate. Real Android Chrome and persistent macOS are
fallback controls if the Container candidate fails. Do not spend more
credentialed trials on simple Linux UA/platform overrides.

Keep-alive collection may extend an idle session, but an absolute Vpass expiry
has not been measured and must not be assumed away. Every scheduled run starts
with a positive session check. A failed check emits a refresh request and does
not submit credentials from Linux.

Until a selected issuer passes password login repeatedly, do not copy the Vpass
ID/password into Cloudflare. Keep Bitwarden as the source and deliver only the
encrypted, source-scoped session envelope to a replay consumer. Treat that
envelope as a credential: no logs, D1 rows, build layers, or broad vault export.

## Cloudflare Container gate

Workers Paid is immediately justified for testing the **consumer** path:

1. Start official headed Chrome in a Container with direct TLS egress.
2. Import a newly validated encrypted session envelope before navigation.
3. Confirm My Page and page-local JSON access.
4. Confirm encrypted session-envelope checkpoint/restore across Container
   sleep; do not persist a full profile unless a later control proves it is
   required.
5. Measure session longevity under the intended collection schedule.

Do not spend credentialed trials on fresh Linux password login unless a
material browser/platform condition changes. Do not add the Hiroshima Tunnel
until direct Container egress fails with a simultaneously valid transported
session; the portability trials do not support IP-only routing as the remedy.

A remote password-bootstrap Container test is useful only after the Windows
control is repeatable and the local persistent engine-level browser arm is
ready. Otherwise another 403 cannot be attributed to Cloudflare egress, browser
implementation, profile history, or temporary Akamai state.
