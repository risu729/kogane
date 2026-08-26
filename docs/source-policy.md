# Direct Source Policy

Kogane collects from the institution or service that originally produced the
observation. Aggregators are avoided by default.

## Source preference

For each account, use the cheapest direct official path that preserves enough
evidence:

1. official CSV, OFX, QIF, PDF, or other export;
2. official documented API;
3. replay of the official website/app's read-only internal API;
4. official email statement or notification;
5. browser/app automation against the official service;
6. manual capture or entry.

An aggregator is not inserted between steps 2 and 3. It may be used only as an
optional reconciliation observation when the direct source cannot supply a
field, and never as the sole store of raw evidence.

## Reverse engineering is in scope

Official-route preference does not make reverse engineering a non-goal. When
public documentation or exports do not establish the data model, retention,
session renewal, or read-only transport, source research proceeds to the
service's own Web or app implementation. A source PR must not reject APK/IPA,
JavaScript, or protocol analysis merely because the official export is easier.

Useful research includes:

- deobfuscating and tracing Web JavaScript that constructs authentication or
  read requests;
- obtaining the user's legitimately installed Play-delivered split APKs and
  recording package, version, signing certificate, and provenance;
- static analysis of manifests, deep links, bundled schemas, host/path strings,
  network-security configuration, native libraries, and token/session code;
- read-only dynamic observation on the user's device or browser to identify
  request ordering, pagination, refresh, device metadata, and pending-to-posted
  transitions;
- comparing the Web/app transport with maintained third-party clients and the
  official artifacts returned for the same records.

The boundary is behavioral, not a blanket ban on analysis. The research must
not initiate transactions or settings changes, persist credentials or personal
values in Git/logs, enumerate unrelated endpoints, or turn an observed write
endpoint into a collector dependency. If a security control prevents passive
observation, record the exact barrier and the additional experiment required;
do not describe the whole reverse-engineering track as out of scope.

Device-bound authentication deserves the same distinction. A source PR may
conclude that an independent client is impractical, but only after mapping the
official enrolment, key storage, signed challenge, attestation/integrity,
deep-link, and app-to-Web session handoff boundaries as far as legitimate
static analysis and owner-operated read-only observation allow. Implementing a
bypass remains prohibited; investigating the mechanism and estimating the
cost of a compatible client remain in scope.

## Why aggregators are secondary

- they often reduce transaction, reward, lot, or account-subtype detail;
- refresh timing and retained history are controlled by another party;
- pending-to-posted transitions may be flattened;
- one aggregator account can obscure which upstream interface produced a
  value;
- access may depend on commercial credentials or a paid plan;
- a direct collector remains necessary when an institution is unsupported or
  temporarily disconnected.

Aggregator output can still be useful as an independent cross-check. When it
is retained, it is identified as its own source observation and is never
merged into the direct observation in place.

## Research record required per direct source

Every source PR records:

- official web/app/export surfaces and exact data available;
- transaction/history granularity, oldest available date, and result limits;
- separate sub-accounts, currencies, points, expiry, cost basis, or pending
  state that another route may omit;
- login, MFA, passkey, CAPTCHA, device binding, and session-reuse behavior;
- observed CDN/WAF/anti-bot controls, separating evidence from inference;
- official APK availability, what static/dynamic analysis established, and the
  next analysis needed when the private transport remains unknown;
- third-party clients, their exact transport/auth approach, activity, and
  license;
- feasibility on Workers, Containers, OCI Kubernetes, and local issuance;
- a 1-5 implementation-cost score and a recommended next experiment;
- a strict read-only allowlist when the upstream surface also exposes writes.

Multiple official routes to the same value are compared explicitly. For
example, a point balance exposed by a card portal and by the point program may
have different history windows or expiry detail; automation convenience alone
does not decide the source.
