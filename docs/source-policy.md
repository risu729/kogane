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
- official APK availability and whether app analysis is likely to help;
- third-party clients, their exact transport/auth approach, activity, and
  license;
- feasibility on Workers, Containers, OCI Kubernetes, and local issuance;
- a 1-5 implementation-cost score and a recommended next experiment;
- a strict read-only allowlist when the upstream surface also exposes writes.

Multiple official routes to the same value are compared explicitly. For
example, a point balance exposed by a card portal and by the point program may
have different history windows or expiry detail; automation convenience alone
does not decide the source.

