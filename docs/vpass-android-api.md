# Vpass Android app API investigation

This note records a second browserless route discovered in the official Vpass
Android app. It is distinct from replaying the website login form. The app
creates a session through a native JSON API and then calls the same statement
JSON endpoints that the website uses.

Application artifacts and full decompiler output are intentionally not
published in this repository. The secret-free, offline procedure is documented
in [Reproducing the Vpass Android static analysis](vpass-android-reproduction.md).

## Artifact

| Field | Value |
| --- | --- |
| Package | `com.smbc_card.vpass` |
| Version | `5.12.0` (`versionCode 5120009`) |
| APK SHA-256 | `6b9df70c5f3a40c840fd45573385690bd777e6b341134f1e585ad3b87ba95a9a` |
| Signing certificate SHA-256 | `10:18:A2:EB:10:EF:51:1F:52:F8:48:4B:11:39:42:FE:99:12:41:26:C0:E1:AF:16:D9:95:3E:AC:5B:84:76:2C` |
| Decompiled with | JADX 1.5.6; 106 reported errors |
| Protected asset | `assets/fjcnwlye`; 29,664 bytes |
| Recovered DEX | DEX 037; 29,652 bytes; SHA-256 `f0b8817b4107698cb79f9803646a1048b87cd117e9da8bd151ad7bc1970ffada` |

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
| Encrypted asset size | 18,784 bytes | 29,664 bytes |
| Recovered DEX | DEX 035; 18,776 bytes | DEX 037; 29,652 bytes |
| Request RSA padding | PKCS#1 v1.5 | OAEP SHA-256 / MGF1-SHA-256 |
| Auth key / IV randomness | `java.util.Random` | `java.security.SecureRandom` |

Both releases use the same `Fauth`/`Vauth` request model and contain the same
four byte-identical RSA-2048 public-key PEM files. The protected asset and
native library changed between builds, but the asset loader's derivation scheme
and embedded base material did not. Static recovery confirms that the business
plaintext format, delimiter, device-ID transformation, SHA-256 input,
AES-CBC envelope, and response-token decryption are unchanged. The material
protocol change is the request-side RSA padding shown above.

## Confirmed request path

```text
ephemeral persisted device UUID
  -> POST https://spap.smbc-card.com/api/v3/common/Config
     (protected Config plaintext, production false-key branch)
  -> cookies and X-VappSessionTime
ID/password + the same device UUID
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
and `Authorization` when a token is available. It omits `X-VappSessionTime`
only for the literal `/api/v3/Auth`, `common/Config`, and `common/Vjaconfig`
routes. `Fauth` is not excluded, so the value established by `common/Config`
must be sent on the credential request.

The two credential-authentication request shapes are:

```json
{
  "auth": "<encrypted application payload>",
  "is_first_login": 1,
  "push": -1,
  "auto_login": 0,
  "os_type": 2,
  "id_type": 2
}
```

These are the fresh default-app Vpass values: the app starts with no push
setting (`-1`), reports its Android OS type as `2`, and maps its internal
Vpass-ID type `1` to `Fauth` `id_type=2`. `id_type` does not exist on `Vauth`.

### Recovered `Fauth`/`Vauth` plaintext and envelope

The protected 5.12.0 implementation confirms that the delimiter is `|`. For a
first Vpass login, `auth` is built from this eight-field plaintext:

```text
login_id|password|device_id_with_check_digit|global_id||company_code|unix_seconds|sha256
```

`company_code` is initialized to `001`. Field 4 is not a push token: the
builder calls `LoginRepository`, which returns the saved `LoginInfoRO.globalId`.
On a fresh client there is no `LoginInfoRO`; Java `StringBuilder.append(null)`
therefore emits the literal string `null`. The final value is lowercase
SHA-256 over UTF-8:

```text
password + unix_seconds + login_id + company_code
```

For saved-ID-token login, field 1 is the saved ID token and the hash input is
`company_code + unix_seconds + saved_id_token`. The timestamp is integer Unix
seconds. The device ID starts as a persisted UUID. The app removes its hyphens,
converts the hex value to a 39-digit zero-padded decimal value, applies a
right-to-left repeating 2-through-7 mod-11 check digit, removes the UUID
character at index 8, and inserts the digit at `original length - 4`.

The 5.12.0 request envelope is:

1. Generate independent 16-character ASCII AES key and IV values with
   `SecureRandom` from the app's fixed 72-character alphabet.
2. Encrypt the UTF-8 plaintext with `AES/CBC/PKCS5Padding` and form
   `IV || ciphertext`.
3. Encrypt the AES key with the release RSA-2048 public key using OAEP with
   SHA-256, MGF1-SHA-256, and an empty label.
4. Form `(IV || ciphertext) || 256-byte RSA block` and encode with standard
   Base64 without wrapping or `=` padding.

Version 5.1.1 uses the same construction except that its request RSA operation
is PKCS#1 v1.5 and its ASCII key/IV generator uses `java.util.Random`.

### Required `common/Config` preflight

The normal login call site invokes `ConfigAPI` before `Fauth`. The protected
Config plaintext is also eight pipe-delimited fields:

```text
empty_id|empty_password|device_uuid|global_id|constant|company_code|unix_milliseconds|sha256
```

For a fresh client, `global_id` is again the literal `null`, `company_code` is
`001`, and the digest input is
`empty_id + empty_password + company_code + constant + unix_milliseconds`.
Unlike the credential plaintext, Config uses milliseconds. Its envelope uses
the production **false-key** branch (`pubkey_relese.pem`) and the same 5.12.0
OAEP-SHA-256/MGF1-SHA-256 construction. The JSON body additionally sends
`appVersion`, `osType: "Android"`, and the Android SDK integer as `osVersion`.

The Config response's cookies are retained, host-only cookies are normalized
to `smbc-card.com` as in `ReceivedCookiesInterceptor`, and the returned
`X-VappSessionTime` is copied onto `Fauth`. A secret-free Config-only probe from
Sydney Cloudflare egress returned HTTP 200, application status 200, and the
session-time header. No response body or header value was persisted.

The guarded credential probe was then run once in that same in-memory flow.
`Fauth` returned HTTP 400, application status 400, and
`type=parameters_invalid`; no `login_token` was returned, so the statement
endpoint was not called. This was an application JSON response rather than an
Akamai HTML denial. It confirms that Config and transport/session setup work,
but it does **not** yet validate the reconstructed credential payload. The
runner deliberately stopped without retrying and persisted no credential,
cookie, token, or response body.

The JSON response field `login_token` uses the reverse-shaped envelope in both
versions. After Base64 decoding, the app takes the final 256 bytes as a PKCS#1
v1.5 RSA block and applies the release public key in decrypt mode to recover
the AES key. The prefix is `16-byte IV || AES ciphertext`, decrypted with
`AES/CBC/PKCS5Padding`, then split on `|`. The unusual public-key decrypt means
the server produced a PKCS#1 type-1/private-key block; it is not OAEP response
decryption.

The retained working archive contains both recovered DEX files, their JADX
output and integrity metadata, and secret-free Python reference implementations
for asset recovery and both auth-envelope directions. Application artifacts,
public-key bodies, and all account data remain outside this public repository.

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

## Static recovery of the protected DEX

The login plaintext builder (`BaseAuthAPI`) and cryptographic methods
(`EncryptedMethods`) are absent from the APK's ordinary DEX files, which is why
the first JADX pass could only show their call sites. The APK instead contains:

- one stripped `libjnleeeqeor.so` per supported ABI, exporting `JNI_OnLoad`;
- high-entropy `assets/fjcnwlye` (29,664 bytes); and
- an obfuscated `kh.*` runtime which loads the native library.

Static inspection confirmed that the `kh.*` runtime derives an AES-CBC key and
IV from embedded base material plus the Java hash of the asset name, decrypts
`fjcnwlye`, validates it as `classes.dex`, and injects its elements into the
Android class loader. Reproducing that derivation offline recovered valid DEX
035 and DEX 037 files for 5.1.1 and 5.12.0 respectively. Their header size,
declared file size, SHA-1 signature, and Adler-32 checksum all validate. Each
contains exactly four classes: `AesEncryption`, `EncryptedMethods`,
`RsaEncryption`, and `BaseAuthAPI`.

APKiD labels the native library as a possible IBM Trusteer Mobile SDK/TSO
artifact, and its unusual ELF version sections support that attribution, but
the label itself says "to be verified". This product-name attribution remains
an inference. It does not affect the recovered Java/Kotlin crypto semantics.

## Browserless implementation implications

The earlier dynamic-analysis blocker is removed. The Vauth plaintext builder,
request encryption, and `login_token` decryption use standard algorithms and
can be implemented without Android, a browser, the APK loader, or
`libjnleeeqeor.so`. Dynamic Android instrumentation is now optional validation,
not a prerequisite for a pure HTTP client.

That does not yet prove production login. A browserless implementation still
needs to reproduce current app headers and flags, retain all `Set-Cookie`
values in one cookie jar, carry `X-VappSessionTime`, handle the decrypted token
fields, and demonstrate a real login without triggering current server or
Akamai policy. The app's public-key files should be hash-pinned and the crypto
versioned because request padding changed between releases. Plaintext auth,
passwords, tokens, and cookie values must never be logged.

## Next validation gates

1. Compare a redacted official-app `Fauth` request with the independent
   runner, focusing on the encrypted plaintext and outer integer flags. The
   Config step, key selection, OAEP envelope, cookies, and session-time header
   are already live-validated and are therefore lower-priority suspects.
2. Determine whether `parameters_invalid` is a generic authentication failure
   or a structural request failure without repeatedly submitting credentials.
3. After resolving that mismatch, perform one guarded login and only then
   enumerate cards and available months and compare statement JSON with the
   existing PoC.
4. Repeat the proven pure HTTP client in the intended Cloudflare Container or
   Kubernetes runtime.

Until the guarded real-login test passes, this is a complete static protocol
reconstruction rather than a proven production authentication path. It is now
the highest-value browserless route to implement before more browser
fingerprint work.
