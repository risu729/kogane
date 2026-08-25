# Cloudflare Browser Run Vpass results

Observed on 2026-08-25. No Vpass credential, cookie value, response body, card
identifier, or public IP address was written to this repository.

## Browser environment

The unmodified Browser Run page exposed:

- `navigator.userAgent`: `Cloudflare-Workers`
- `navigator.platform`: `Linux x86_64`
- `navigator.webdriver`: `true`
- language: `en-US`

With that default network identity, the Vpass login page GET returned HTTP 403
and the browser rendered `Access Denied`.

The documented Puppeteer custom-user-agent API was then used to send a Windows
Chrome 153 User-Agent and matching Client Hints. No `webdriver` or JavaScript
property hiding was added. With this change, the login page returned 200, the
real form was present, Vpass/Akamai/analytics JavaScript executed, and the page
received the normal set of session and bot-management cookie names. Cookie
values were neither returned nor logged.

Browser Run still reported `Cloudflare-Workers`, Linux, and `webdriver=true` to
page JavaScript. Cloudflare also documents that rendering traffic comes from
Cloudflare IP ranges and includes automatic identification headers. This was
therefore not equivalent to the successful Windows Chrome 153 session.

## Login result

The final bounded run filled the real `userid` and `password` controls and
clicked the form's submit input once. Its request to
`/memapi/jaxrs/xt_login/agree/v1` returned:

- HTTP 403,
- HTML `Access Denied`,
- no `x-loginresult`, and
- no redirect location.

An earlier harness invocation timed out during navigation before its stage was
observable. The harness was then changed to report only the current stage and
whether a login POST was seen, without logging request data. The corrected run
above captured the definitive 403 response; no further login was attempted.

## Comparison

| Client | Egress | JavaScript | Vpass login result |
| --- | --- | --- | --- |
| Real Chrome 153 on Windows | host route observed as Cloudflare WARP/Gateway, AU | yes | success: 302 and `x-loginresult: 0` |
| upstream `impit` Chrome 151 Windows | Japanese home via `tamia` | no | Akamai 403 before Vpass result |
| `curl_cffi 0.16.1` Chrome 150 | Japanese home via `tamia` | no | Akamai 403 before Vpass result |
| Cloudflare Browser Run + Windows Chrome 153 network UA | Cloudflare | yes | Akamai 403 before Vpass result |

The combined evidence shows that neither a Japanese source IP, transport
impersonation, nor JavaScript execution in Cloudflare's identifiable automated
browser is sufficient on its own. The later OCI/WSL comparison in
`../oci-browser-probe/RESULTS.md` also reproduced the rejection in Linux Chrome
over the same Cloudflare WARP route used by the Windows host, then reproduced it
again in a completely new Windows Kuebiko profile. The evidence does not support
treating home egress or Windows alone as the missing requirement; continuity in
the previously validated browser profile is the strongest remaining factor.

## References

- [Cloudflare Browser Run get started](https://developers.cloudflare.com/browser-run/get-started/)
- [Cloudflare Browser Run FAQ](https://developers.cloudflare.com/browser-run/faq/)
- [Cloudflare Browser Run Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/)
