# ADR 0111: Accept requested V Point OTPs through a private durable owner offer

- Status: proposed
- Date: 2026-11-11 UTC

## Context

Fumi owns general mail archival, forwarding and fallback. Kogane owns V Point
authentication state and its domain-specific code parser. The owner requested
owner-maintained rules that Fumi adopts, with requested OTPs consumed once and
unrelated messages left for normal fallback. A static subject match is not a claim.

The existing email handler separately asked whether a challenge was pending and
then submitted a code. That check could race another delivery. It had no durable
offer identity, receipt lookup or recovery record for a lost response.

## Options considered

- Put provider-specific state and parsing in Fumi: duplicates Kogane ownership and
  gives the general router provider authority.
- Wrap the existing pending check and completion calls: leaves the race and
  response-loss ambiguity intact.
- Add a private owner entrypoint and claim through the existing session object:
  keeps one authority for both legacy delivery and adopted offers. Selected.

## Decision

`FumiOffer` is a named `WorkerEntrypoint` on the existing collector. Its `manifest`,
`offer` and `receipt` methods are available only through an administrator-created
Service Binding capability. Default HTTP still exposes only health; RPC-shaped
URLs do not reach these methods. No credential or public offer endpoint is added.

Kogane publishes the exact `FUMI_MANIFEST_JSON` bytes and their SHA-256 through that
entrypoint. Its CEL predicate matches only the observed subject. Match input is
`subject`; separately granted offer input is `subject`, trusted SMTP `envelope`
and at most 16 KiB of decoded `text`. The administrator pins the owner manifest,
version, digest and disclosure grants in Fumi. Mail cannot select a service,
recipient, credential or archive object. Header addresses are not sender proof.

The `fumi-offer-v1` request carries stable operation/event/source identities, the
manifest pin and explicitly granted input. SHA-256 covers recursively key-sorted
UTF-8 JSON, excluding top-level `requestSha256` and mutable `attempt`. Each attempt
has an integer generation and an expiry at most ten seconds ahead. The session
object rechecks that expiry immediately before a new atomic claim. Expired attempts
are retryable without a claim. Existing receipts remain readable after expiry.

The session object checks its durable operation receipt before considering a new
claim. Repeating an operation/hash returns its prior outcome; changing the hash
rejects it. Matching requires the exact subject, configured envelope recipient,
one observed four-to-six-digit preamble code, a current request and a received time
inside that request's one-minute acceptance interval. The request clock starts
before the provider's code-send POST. Unrelated, ambiguous, pre-request and expired
mail receives a durable `not_applicable` result without a provider call. A request
being created or another accepted job temporarily holds a new offer for retry.

An accepted offer atomically removes the pending challenge and writes its receipt,
source-deduplication marker, queued job and alarm. `handled` means durable owner
responsibility, not successful provider authentication or collection. The alarm
marks an external phase started before calling it. It removes code/challenge bytes
from stored job state before submission, then persists a valid session and queues
collection. Shared collection retains its existing execution lease, DATA objects
and terminal-last persistence contract.

Legacy email delivery uses the same atomic gate but retains its synchronous
authentication and post-auth collection checks: a run without a durable terminal
still fails the email event. The two paths deduplicate the same raw-message digest.
They cannot submit two codes for one pending request. Existing notification-email
storage and legacy Gmail forwarding remain separate; an adopted offer never forwards.

## Consequences

Receipts and source markers are retained indefinitely as small private operational
records; they are not silently expired into `not_found`. Queued codes/challenge
state live only in the private session object until the first attempt or expiry.
They enter neither DATA nor logs. Cookies remain in existing session storage.

An interrupted external phase becomes internally `uncertain` at its watchdog; it
is not automatically submitted again. Authentication watchdogs are two minutes;
collection watchdogs are fifteen minutes, beyond the existing thirteen-minute
execution deadline. Failed/uncertain jobs keep the durable `handled` receipt, so
Fumi cannot reinterpret ownership as unmatched. Logs record only closed job state
and a generated run reference. Subsequent normal collection can request a new
challenge after the old job ends; this change adds no manual provider execution.

`not_found` is a status-only answer with no durable claim. Fumi reconciles it only
after its original sending lease and attempt expiry, preventing a paused old attempt
from claiming after destination generation advances. Fumi must offer immediately
after durable MIME availability; its five-minute repair cadence alone cannot meet
the observed one-minute OTP validity.

Deployment, Service Binding adoption, private configuration and observed production
OTP acceptance remain separate. This implementation neither changes Email Routing
rules nor retires forwarding. Select one forwarding owner before activating adopted
specialist delivery, and retain independent raw archival and normal fallback.

## Verification

Pure synthetic tests cover exact manifest grants, canonical hashes, bounded fields,
attempt expiry and the existing parser/auth form chain. Workers-runtime tests use
real session-object storage, eviction and alarms, mocked provider responses and
local DATA/D1. They cover duplicate/changed offers, two operations on one challenge,
legacy/owner exclusion, unrelated/expired mail, creation races, interrupted phases,
secret removal, and authenticated collection through a durable terminal. Existing
legacy terminal-failure assertions remain. No live login or collection is a test.
