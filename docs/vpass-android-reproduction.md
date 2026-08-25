# Reproducing the Vpass Android static analysis

This document describes how the Vpass Android APK was acquired, verified,
decompiled, and inspected, and how its protected authentication DEX was
recovered without installing or executing the app. It is intended to make the
analysis in [Vpass Android app API investigation](vpass-android-api.md)
repeatable when a new app version is released.

This repository intentionally does **not** contain an APK, decompiled source,
recovered DEX, PEM key body, Google Play token, account credential, cookie, or
captured authenticated response. Obtain application artifacts from a source
you are entitled to use and keep them outside the repository. Review the
applicable terms, copyright rules, and law before repeating the analysis.

## Reproduction boundary

The procedure has two independent parts:

1. Offline static recovery: acquire an APK, verify its identity, decompile the
   ordinary DEX files, recover `assets/fjcnwlye`, and decompile the recovered
   raw DEX. This part uses no Vpass account and makes no Vpass network request.
2. Protocol validation: implement the recovered algorithm independently with
   dummy fixtures first, then make one guarded request using credentials read
   at runtime. Never place those credentials or the resulting tokens in a
   command line, fixture, log, commit, or issue.

The class names below are the names assigned by JADX 1.5.6 for Vpass 5.12.0.
Obfuscation may rename them in later versions. Treat data flow and API calls as
the stable search criteria, not `kh.C0190` or a particular method number.

## Tools and working directory

The recorded analysis used:

- `apkeep` for the Google Play download;
- Android SDK Build Tools `apksigner` and `aapt2`;
- JADX 1.5.6;
- apktool 2.12.1;
- Python 3 with PyCryptodome for the offline AES operation; and
- standard `unzip`, `sha256sum`, `file`, `rg`, and JDK tools.

Use a disposable directory outside the Kogane checkout:

```bash
work_dir="$(mktemp -d)"
install -d -m 700 \
  "$work_dir/apk" \
  "$work_dir/jadx" \
  "$work_dir/apktool" \
  "$work_dir/recovered"
```

Do not reuse a variable such as `$HOME` for this path. Preserve a small
secret-free metadata record containing tool versions, acquisition date,
package/version, hashes, and verification results before deleting the working
directory.

## 1. Acquire the APK

### Current Google Play release

The current 5.12.0 artifact was downloaded from Google Play with `apkeep`.
Keep the Google account and token in a mode-0600 config file outside the
repository rather than passing them as command-line arguments:

```ini
[google]
email = account@example.invalid
aas_token = REDACTED
```

Then download the package:

```bash
chmod 600 /secure/path/apkeep.ini
apkeep \
  -a com.smbc_card.vpass \
  -d google-play \
  -i /secure/path/apkeep.ini \
  "$work_dir/apk"
```

An AAS or OAuth token is acquisition infrastructure, not Vpass application
data. Do not preserve it with the APK metadata. If Google Play returns split
APKs, retain the complete split set and record that fact; the recorded 5.12.0
analysis used a single APK containing the ordinary DEX files and protected
asset.

### Archived release

Version 5.1.1 was used only to compare protocol evolution. It came from an
unofficial AM5 listing whose file was served by Microsoft SharePoint. Any
third-party copy is untrusted until its package and signing certificate are
checked against a current Google Play copy. Do not install or execute it merely
because its filename looks correct.

## 2. Verify identity and preserve hashes

Set `apk` to the downloaded file and record its digest before extracting it:

```bash
apk="$work_dir/apk/com.smbc_card.vpass.apk"
sha256sum "$apk"
aapt2 dump badging "$apk" | sed -n '1,3p'
apksigner verify --verbose --print-certs "$apk"
```

Check all of the following:

- the package is exactly `com.smbc_card.vpass`;
- the reported version is the version being documented;
- `apksigner` reports a valid signer; and
- the signer certificate SHA-256 equals a certificate obtained from the
  trusted current Google Play artifact.

For the recorded releases, the checkpoints are:

| Item | 5.1.1 | 5.12.0 |
| --- | --- | --- |
| Version code | `511000` | `5120009` |
| APK SHA-256 | `80b1e4e699c9390c31271dc5778b73b0caf6ff2a63864a6a8ca0061f070c230e` | `6b9df70c5f3a40c840fd45573385690bd777e6b341134f1e585ad3b87ba95a9a` |
| Minimum / target SDK | 23 / 34 | 24 / 36 |
| Signer certificate SHA-256 | `10:18:A2:EB:10:EF:51:1F:52:F8:48:4B:11:39:42:FE:99:12:41:26:C0:E1:AF:16:D9:95:3E:AC:5B:84:76:2C` | same |

A matching signer establishes that both APKs were signed by the same key. It
does not make the third-party host trusted, establish source-code correctness,
or authorize redistribution. Stop if the package or signer differs.

## 3. Decompile the ordinary APK contents

Run both tools because they answer different questions. JADX provides readable
Java/Kotlin approximations; apktool preserves resources and smali closer to the
DEX instructions.

```bash
jadx --show-bad-code \
  -d "$work_dir/jadx/ordinary" \
  "$apk" \
  2>"$work_dir/jadx/ordinary.log"

apktool d --force \
  -o "$work_dir/apktool/ordinary" \
  "$apk" \
  >"$work_dir/apktool/ordinary.log" 2>&1
```

JADX errors are not proof that an entire APK failed to decompile. Preserve the
error count and inspect the affected methods. The recorded runs reported 26
errors for 5.1.1 and 106 for 5.12.0.

Search for the authentication request and the definitions it calls:

```bash
rg -n \
  'BaseAuthAPI|EncryptedMethods|AuthRequest|Fauth|Vauth|generateAuthString' \
  "$work_dir/jadx/ordinary/sources"
```

The ordinary DEX set contains call sites and request models for
`BaseAuthAPI`/`EncryptedMethods`, but not their class definitions. This was the
first indication that the missing implementation was loaded separately rather
than merely being one of JADX's failed methods.

## 4. Locate the protected payload and loader

List suspicious assets, native libraries, and DEX files:

```bash
unzip -l "$apk" | rg 'assets/|lib/.+\.so$|classes[0-9]*\.dex$'
unzip -p "$apk" assets/fjcnwlye >"$work_dir/recovered/fjcnwlye.enc"
file "$work_dir/recovered/fjcnwlye.enc"
wc -c "$work_dir/recovered/fjcnwlye.enc"
sha256sum "$work_dir/recovered/fjcnwlye.enc"
```

In 5.12.0, `assets/fjcnwlye` is a 29,664-byte opaque high-entropy blob whose
length is a multiple of the AES block size. The APK also contains one stripped
`libjnleeeqeor.so` for each supported ABI. Those observations were leads, not
proof of either the cipher or payload type.

Search the ordinary decompilation for class-loader, DEX, ZIP, and crypto data
flow:

```bash
rg -n \
  'fjcnwlye|PathClassLoader|DexFile|ZipEntry|Cipher|getAssets|open\(' \
  "$work_dir/jadx/ordinary/sources"
```

For 5.12.0, following this flow showed:

- `kh.C0190` holds two 16-byte base arrays and coordinates loading;
- the loader derives bytes using the Java `String.hashCode` of the asset name;
- `kh.C0162` writes the decrypted stream as a ZIP entry named `classes.dex`;
- `kh.C0062` performs a load/validity check; and
- `kh.C0088` adds the resulting DEX elements to a `PathClassLoader`.

These obfuscated names may change. The evidence to follow in a new version is
the chain from `AssetManager.open(...)`, through AES decryption, to creation of
a `classes.dex` ZIP entry and mutation of `dexElements`.

## 5. Recover the raw DEX offline

### Derivation reconstructed from the loader

The asset name is the literal `fjcnwlye`. Its Java string hash, treated as an
unsigned 32-bit value, is `0xfa420550`. Convert it to four big-endian bytes and
repeat those bytes four times to form a 16-byte mask:

```text
mask = BE32(java_string_hash("fjcnwlye")) repeated four times
```

Read the two 16-byte signed-byte arrays returned by the loader's two nearby
methods. In the recorded 5.12.0 JADX naming, `kh.C0190.m27964()` supplies the
base key and `kh.C0190.m27963()` supplies the base IV. Convert negative Java
byte literals modulo 256, then derive:

```text
AES key = base key XOR mask
AES IV  = base IV  XOR mask
```

Decrypt the complete asset using AES-CBC, then remove PKCS#5/#7 padding. The
unpadded result begins with `dex\n` and is the raw protected DEX. A minimal
independent implementation has this shape:

```python
mask = java_string_hash(asset_name).to_bytes(4, "big") * 4
key = bytes(a ^ b for a, b in zip(base_key, mask, strict=True))
iv = bytes(a ^ b for a, b in zip(base_iv, mask, strict=True))
padded = AES.new(key, AES.MODE_CBC, iv).decrypt(encrypted_asset)
raw_dex = unpad(padded, AES.block_size, style="pkcs7")
```

The base arrays are deliberately not copied into Kogane. Extract them from the
APK version under analysis so a changed loader cannot silently reuse stale
material. They are application constants, not account secrets, but publishing
the original APK or bulk decompiled output is outside this repository's scope.

### Validate before trusting the output

Do not accept only a `dex\n` prefix. Validate all DEX header invariants:

1. Bytes 0-7 are `dex\nNNN\0`.
2. The little-endian `file_size` at offset 32 equals the actual length.
3. The little-endian `header_size` at offset 36 is 112.
4. Bytes 12-31 equal SHA-1 of bytes 32 through EOF.
5. The little-endian checksum at offset 8 equals Adler-32 of bytes 12 through
   EOF.

The known-good offline recovery checkpoints are:

| Item | 5.1.1 | 5.12.0 |
| --- | --- | --- |
| Encrypted asset bytes | 18,784 | 29,664 |
| Encrypted asset SHA-256 | `822b010432f649063bb36a26b321ed13b27d988bd51006aba733e6642443f687` | `0c9b51a9fed041e6ada9b2e03866ad3f55b2531219de8c2233b44292c4588380` |
| DEX version | 035 | 037 |
| Recovered DEX bytes | 18,776 | 29,652 |
| Recovered DEX SHA-256 | `30cb2267a3e6e62a31491c419421dd04d2c42e0a36b48b04d2832827e77c9dbe` | `f0b8817b4107698cb79f9803646a1048b87cd117e9da8bd151ad7bc1970ffada` |

The 5.12.0 padding length was 12 bytes. Matching these values reproduces the
recorded recovery; a later app version is expected to have different APK,
asset, and DEX hashes.

## 6. Decompile and inspect the recovered DEX

```bash
jadx --show-bad-code \
  -d "$work_dir/jadx/protected" \
  "$work_dir/recovered/classes.dex" \
  2>"$work_dir/jadx/protected.log"
```

The recorded recovered DEX contains exactly four class definitions:

- `common.util.AesEncryption`;
- `common.util.EncryptedMethods`;
- `common.util.RsaEncryption`; and
- `remote.app.BaseAuthAPI`.

This explains why ordinary JADX only found references. The app loader decrypts
and inserts these classes at runtime; the offline procedure recovers the same
payload without executing the APK or native library.

Trace the request in this order:

1. `BaseAuthAPI.generateAuthString` for plaintext field order, delimiter,
   timestamp, hash input, and device-ID check digit.
2. The callers in `FaAuthAPI` and `AuthAPI` for `Fauth` versus `Vauth` and
   their outer JSON fields.
3. `EncryptedMethods` for the hybrid AES/RSA request envelope.
4. `AesEncryption` and `RsaEncryption` for exact transformations, padding,
   key selection, and Base64 flags.
5. `BaseAuthAPI` response handling for `login_token` decoding and verification.

Do not infer one path's cipher from an unrelated helper such as
`InnerEncryption`. Confirm the actual call graph from the authentication
method.

## 7. Compare releases semantically

Do not compare only obfuscated names or decompiler error counts. Compare these
protocol properties:

- plaintext field order and delimiter;
- device-ID transformation;
- request hash input;
- AES mode, IV placement, and Base64 flags;
- RSA public-key hash and request padding;
- source of randomness;
- response split point and RSA/AES operations; and
- HTTP headers, outer JSON fields, cookie jar, and session-time propagation.

Confirmed unchanged between 5.1.1 and 5.12.0 are the plaintext format, `|`
delimiter, device-ID transformation, SHA-256 calculation, AES-CBC construction,
response-token construction, and all four RSA public-key file hashes. Confirmed
changes are:

- request AES-key wrapping changed from RSA PKCS#1 v1.5 to OAEP with SHA-256
  and MGF1-SHA-256; and
- key/IV generation changed from `java.util.Random` to `SecureRandom`.

The native-library attribution is not required for this recovery. APKiD 3.1.0
tentatively labelled `libjnleeeqeor.so` as IBM Trusteer SDK/TSO, and unusual
`.gnu.version_x`/`.gnu.version_y` ELF sections were consistent with that label.
Because APKiD itself marks the signature "to be verified" and no runtime
registration table was observed, the product attribution remains an inference.

## 8. Validate an independent implementation safely

Before a live request, use fixed dummy values to test:

- the Config eight-field plaintext, millisecond timestamp, fixed constant,
  false-key branch, and SHA-256 input order;
- the eight-field plaintext and empty fifth field;
- the device-ID check digit and placement;
- lowercase SHA-256 input ordering;
- AES-CBC padding and envelope length;
- 256-byte RSA request suffix;
- unpadded, unwrapped standard Base64; and
- both the 5.1.1 PKCS#1 and 5.12.0 OAEP version branches.

For a guarded live test, read the ID and password from an already-configured
secret provider or inherited file descriptor. Disable shell tracing, redact
HTTP bodies and headers, use a fresh in-memory cookie jar, and print only the
HTTP status plus a small allow-listed set of non-sensitive response fields.
The test must call `common/Config` first, retain every `Set-Cookie` internally,
normalize host-only cookies to `smbc-card.com`, and copy the returned
`X-VappSessionTime` onto `Fauth`, but must never serialize any value. For a
fresh client, both protected plaintexts append a missing `LoginInfoRO.globalId`
as the literal string `null` because the original implementation uses Java
`StringBuilder.append(String)`.

The public PoC includes a guarded runner. Its Config-only mode requests no
credentials and prints only allow-listed status booleans:

```bash
bun run src/mobile-auth-probe.ts \
  --request-key /private/path/f2hKiZCtFQdbfuiVGduZ.pem \
  --response-key /private/path/pubkey_relese.pem \
  --config-only
```

Remove `--config-only` for the single credential test, and add
`--check-statements` only when the read-only month-list check is intended. Both
the ID and password prompts are masked. The runner performs no retry and writes
no credential, response body, token, cookie, or financial record to disk.

A successful `Fauth`/`Vauth` response is only the first gate. Confirm that the
same in-memory session can call `web_meisai_top/v1`, extract the server-provided
available month list, and fetch one statement page. Do not enumerate more
history than required for the validation.

## Confirmed results versus inference

Confirmed by offline artifact inspection and cryptographic integrity checks:

- the APK identities, hashes, and common signing certificate in the table;
- `assets/fjcnwlye` decrypts to a complete, checksum-valid raw DEX;
- the recovered DEX defines the four missing classes;
- the plaintext, request envelope, and response-envelope algorithms documented
  in the API investigation; and
- the protocol differences between 5.1.1 and 5.12.0.

Still inference or requiring a live validation:

- the exact commercial protection product behind `libjnleeeqeor.so`;
- whether a future release preserves any obfuscated class or asset name;
- whether current server-side policy accepts the independent client from every
  network/runtime; and
- whether undocumented API behavior remains stable enough for production use.
