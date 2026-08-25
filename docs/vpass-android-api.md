# Vpass Android app API investigation

This note records a second browserless route discovered in the official Vpass
Android app. It is distinct from replaying the website login form. The app
creates a session through a native JSON API and then calls the same statement
JSON endpoints that the website uses.

The decompiled snapshot is preserved separately in the private repository
[`risu729/vpass-android-decompiled`](https://github.com/risu729/vpass-android-decompiled).
The APK itself and all acquisition credentials are excluded from that repository.

## Artifact

| Field | Value |
| --- | --- |
| Package | `com.smbc_card.vpass` |
| Version | `5.12.0` (`versionCode 5120009`) |
| APK SHA-256 | `6b9df70c5f3a40c840fd45573385690bd777e6b341134f1e585ad3b87ba95a9a` |
| Signing certificate SHA-256 | `10:18:A2:EB:10:EF:51:1F:52:F8:48:4B:11:39:42:FE:99:12:41:26:C0:E1:AF:16:D9:95:3E:AC:5B:84:76:2C` |
| Decompiled with | JADX 1.5.6; 106 reported errors |

The package, version, and signing certificate were checked locally before
analysis. This is an unofficial reverse-engineering snapshot, not an SMCC API
contract.

## Current and archived release comparison

The current artifact came from Google Play through Aurora/apkeep. For a static
comparison, version 5.1.1 (2024) was downloaded from
[AM5's version archive](https://am5.com/c/g1/download/%E4%B8%89%E4%BA%95%E4%BD%8F%E5%8F%8B%E3%82%AB%E3%83%BC%E3%83%89-Vpass%E3%82%A2%E3%83%97%E3%83%AA/com.smbc_card.vpass/20197/apk/0);
the actual file URL on that page was hosted by Microsoft SharePoint. The file
was treated as untrusted until `apksigner` verified the same SMCC signing
certificate as the Google Play artifact.

| Field | Archived 5.1.1 | Current 5.12.0 |
| --- | --- | --- |
| Version code | `511000` | `5120009` |
| APK SHA-256 | `80b1e4e699c9390c31271dc5778b73b0caf6ff2a63864a6a8ca0061f070c230e` | `6b9df70c5f3a40c840fd45573385690bd777e6b341134f1e585ad3b87ba95a9a` |
| Minimum / target SDK | 23 / 34 | 24 / 36 |
| JADX errors | 26 | 106 |
| Signing certificate | Same SMCC certificate | Same SMCC certificate |
| Protected login classes present in ordinary DEX | No | No |

Both releases use the same `Fauth`/`Vauth` request model and the same call from
the protected plaintext builder to `EncryptedMethods`. They also contain four
byte-identical RSA-2048 public-key PEM files and the same opaque asset and
native-library names. The opaque asset and native library themselves changed
between releases, as expected for different protected builds.

The older release is easier for JADX to read around the cookie jar and WebView
handoff, but it does not reveal the login plaintext order, delimiter, RSA
padding, or response-token decryption. The comparison therefore establishes
protocol and key continuity; it does not remove the dynamic-analysis blocker.

## Confirmed request path

```text
ID/password
  -> protected app-side plaintext builder and encryption
  -> POST https://spap.smbc-card.com/api/v3/Fauth
     (Vauth is the corresponding VJA-mode route)
  -> login token, shared cookies, and X-VappSessionTime
  -> shared in-memory OkHttp cookie jar
  -> POST https://www.smbc-card.com/memapi/jaxrs/...
  -> card list, selected card, available months, statement pages
```

`AppClient` uses the `spap.smbc-card.com/api/v3/` base URL. Its request headers
include `X-App-Version`, `X-OS-Version`, an app `User-Agent`, JSON content type,
and `Authorization` when a token is available. Except on authentication and
configuration routes it also sends `X-VappSessionTime` returned by the server.

The two credential-authentication request shapes are:

```json
{
  "auth": "<encrypted application payload>",
  "is_first_login": 1,
  "push": 0,
  "auto_login": 0,
  "os_type": 1,
  "id_type": 2
}
```

`id_type` exists on `Fauth` but not on `Vauth`. The exact integer values depend
on the selected account/login mode and must not be hard-coded from this example.

`ReceivedCookiesInterceptor` collects every `Set-Cookie`, normalizes it to the
configured `smbc-card.com` domain, and saves it into a process-wide in-memory
cookie jar. `AddCookiesInterceptor` then sends the complete jar on both app and
member-API requests. This is the bridge from native authentication to the
member statement APIs; it is not a browser Cookie Store export.

The member API base URL is `https://www.smbc-card.com/memapi/jaxrs/`. Relevant
routes confirmed from `VpassService` include:

- `POST web_meisai/web_meisai_top/v1`
- `POST meisai/meisai_ans/v1`
- `POST multicard/dropdownlist_init/v1`
- `POST multicard/operation_card_update/v1`

`CreditCardFinalStatementRequest` uses request hash `1494552592`, with `p01`
for the billing month and `p03` for the page. The response models contain the
same `seikyuYMList`, `meisaiList`, `total`, date, merchant, amount, and payment
fields already handled by the JSON PoC. Therefore no CSV conversion is needed.

## Unauthenticated network probes

On 2026-08-26, plain `curl` from an Australian Cloudflare/WARP egress reached
all of these endpoints without browser execution:

| Request | Result |
| --- | --- |
| Empty `web_meisai_top/v1` request without a session | HTTP 401 JSON, normal Vpass forced-login response |
| `common/Config` with an empty `auth` | HTTP 202 JSON, application-level parameter error |
| `Vauth` with an empty `auth` | HTTP 400 JSON, application-level parameter error |
| `Fauth` with an empty `auth` | HTTP 400 JSON, application-level parameter error |

The responses set some Akamai-named cookies, but none was an Akamai HTML
`Access Denied` response. This demonstrates only reachability and application
parsing. It does not yet prove that a real encrypted login succeeds from every
cloud network. It does show that these native app endpoints do not require a
browser merely to reach the Vpass application layer.

## Remaining blocker

The login plaintext builder (`BaseAuthAPI`) and cryptographic methods
(`EncryptedMethods`) are referenced by normal DEX code but their definitions
are absent from the extracted DEX files. The APK instead contains:

- one stripped `libjnleeeqeor.so` per supported ABI, exporting `JNI_OnLoad`;
- high-entropy `assets/fjcnwlye` (29,664 bytes); and
- an obfuscated `kh.*` runtime which loads the native library.

Static inspection indicates that the `kh.*` runtime decrypts the asset and
injects its DEX elements through Android's class loader. APKiD labels the native
library as a possible IBM Trusteer Mobile SDK/TSO artifact, and its unusual ELF
version sections support that inference, but the product attribution is not
confirmed. Static JADX output alone is therefore insufficient to
construct a valid `auth` value. The app also decrypts the returned
`login_token`, so a complete pure-HTTP client needs both directions or a way to
avoid consuming the decrypted fields.

## Next validation gates

1. If useful, compare a substantially older correctly signed release. Version
   5.1.1 confirms that the protection was already present in April 2024, so
   adjacent versions are low-value targets.
2. Observe the official app on a test Android device:
   hook immediately before `EncryptedMethods` and at the OkHttp interceptor,
   recording field names and shapes but never committing credentials or tokens.
3. Reimplement only the required plaintext builder and cryptographic envelope
   in a local test client. Do not reuse the app's APK, native library, or a live
   browser profile in the deployed collector.
4. Perform one guarded real-login test, then enumerate cards and months and
   compare statement JSON with the current PoC.
5. Only after that succeeds, test the pure HTTP implementation in a Worker and
   in a Cloudflare Container. A browser Container is unnecessary if the same
   request succeeds with standards-based `fetch`.

Until gate 4 passes, the Android path is a promising alternative, not the
production authentication design. It should be preferred over further browser
fingerprint tuning for the next experiment because the unauthenticated native
API already reaches normal JSON application responses from cloud egress.
