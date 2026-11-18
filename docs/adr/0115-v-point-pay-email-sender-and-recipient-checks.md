# ADR 0115: V Point Pay notification provenance: the parser checks the sender, the collector checks the recipient

- Status: proposed
- Date: 2026-11-18
- Decided by: owner, 2026-11-18 04:42 UTC (the recipient check moves out of
  the parser; the collector checks at receipt) and owner, 2026-11-18 04:47 UTC
  (what is checked is the sender, not the recipient)
- Stacked on: [PR 1384](https://github.com/risu729/kogane/pull/1384)
  (synthetic routing addresses in the collector tests)
- Carried by: `validateProvenance` in `packages/parsers/src/parsers/v-point-pay.ts`
  (`v-point-pay-notification-event@1.1.0`), `prepareVPointPayEmail` and the
  `email` handler in `services/collector-vpoint/src`,
  [V Point Pay source notes](../sources/v-point-pay.md#layer-b-financial-observations-from-notification-events),
  [observations](../observations.md#v-point-pay-the-parser-checks-the-sender-not-the-recipient-notification-event-110)

## Context

`services/collector-vpoint` stores each official V Point Pay notification as a
pair: the message (`notification.eml`) and a normalized event
(`normalized-event.json`). Since schema `vpoint-pay-email-event-v2` the event
carries a Layer A `sourceProvenance` block: the delivery form (`direct`, or
`forwarded-rfc822` when the owner forwarded the notification as an attached
message), the SMTP envelope sender and recipient, and the outer message
digest. `v-point-pay-notification-event` reads only the normalized event.

Before this decision the checks were split as follows.

- **Recipient.** The collector parses V Point Pay mail only when the SMTP
  recipient is its configured `VPOINT_PAY_EMAIL_RECIPIENT`, and
  `prepareVPointPayEmail` refuses any other recipient
  (`vpoint_pay_email_envelope_invalid`) before anything is stored. Parser
  1.0.2 also required the recorded `envelopeTo` to equal a constant in its
  source, which was the real routing address. A parser takes no
  configuration (`parse` reads only the bytes and the artifact metadata), so
  the constant duplicated deployment configuration in parser code, and a
  routing change would have needed a parser release.
  [PR 1384](https://github.com/risu729/kogane/pull/1384) pinned the
  constant to the deployed config with a test and wrote it down as a limit.
- **Sender.** The collector accepts a candidate message only when its
  RFC 5322 From is the provider's public notification address, for both forms
  (the stored message is the inner forwarded part when forwarded), and for
  direct delivery also requires that address as the SMTP envelope sender
  (`vpoint_pay_email_envelope_sender_invalid`). Parser 1.0.2 checked the
  envelope sender of direct events only. The normalized event did not record
  the stored message's From, so a forwarded event, whose envelope names the
  forwarder, reached the parser with no sender it could check.

Cloudflare's EmailEvent exposes the SMTP envelope and raw MIME but no trusted
SPF, DKIM or DMARC result, so every sender comparison here is a shape check
on what the message and envelope say, not authentication
(`authenticationProvenance=not-exposed-by-cloudflare-email-event`,
`sourceVerification=source_unverified`).

## Options considered

1. Keep the parser constant and pin it to the deployed config with a test
   (PR 1384). Rejected by the owner (04:42 UTC): the routing address stays
   in parser source and a routing change still needs a parser release.
2. Give parsers configuration. Rejected: a parse result would depend on
   deployment configuration and no longer be a function of the stored
   evidence alone, so a re-parse could change with a deploy.
3. Remove the recipient from the provenance, or stop validating it.
   Rejected: the evidence would stop recording where the mail went, and the
   provenance block is an exact schema whose drift the parser refuses.
4. Keep `envelopeTo` required and well formed, remove only the equality, and
   make the sender the parser's provenance check in both forms by recording
   the stored message's From. Chosen.

For forwarded events stored before this change, which record no From:

- (a) refuse them. Rejected: a re-parse would retract observations whose
  sender the collector checked at receipt, without any new evidence against
  them.
- (b) accept them as before and write the gap down as a limit. Chosen.

## Decision

- **The collector is the only recipient check.** It compares the SMTP
  recipient with its configured `VPOINT_PAY_EMAIL_RECIPIENT` at receipt, as
  before: mail to any other mailbox is not parsed as V Point Pay and is never
  stored (`prepareVPointPayEmail` refuses it with
  `vpoint_pay_email_envelope_invalid`).
- **The parser records the recipient but does not compare it.**
  `v-point-pay-notification-event@1.1.0` removes the routing-address
  constant and the equality. `sourceProvenance.envelopeTo` must still be
  present and a bounded mailbox (at most 320 characters, one `@`, no
  whitespace), so the evidence keeps recording where the mail went.
- **The sender is the parser's provenance check.** Direct delivery still
  needs the official sender as `envelopeFrom`. The collector now writes
  provenance `vpoint-pay-email-source-provenance-v2`, which adds
  `messageFrom`: the RFC 5322 From of the stored message (the notification
  itself when direct, the inner forwarded part otherwise). For provenance v2
  the parser requires `messageFrom` to be the official sender in both forms.
  The official sender is a public provider address and stays a parser
  constant. The collector also refuses a candidate whose recorded From is not
  the official sender (`vpoint_pay_email_message_sender_invalid`) before
  storage.
- **Provenance v1 keeps its reading.** A v1 direct event is checked by its
  envelope sender, as before. A v1 forwarded event carries no sender the
  parser could check; it is accepted on the collector's check at receipt.
- Every other refusal is kept: the event schema and exact keys, identity,
  canonical instants, event types and subject agreement, amount bounds and
  signs, run preconditions, the provenance schema and exact keys, both
  delivery forms with their stored-message scope and outer digest, mailbox
  shapes, `sourceVerification` and `authenticationProvenance`.

## Consequences

- **The routing address leaves the code.** It remains only in the deployed
  configuration (`services/collector-vpoint/wrangler.jsonc` and
  `cloudflare.config.ts`). Parser tests use synthetic addresses only, and
  PR 1384's test that read the deployed recipient into the parser tests is
  dropped.
- **Re-parse under 1.1.0.** Observations do not depend on the provenance, and
  every event 1.0.2 accepted is accepted by 1.1.0 with the same complete
  result (`expected-1.0.2.json` freezes 1.0.2's outputs for the anonymous
  fixtures as v1 events and as v2 events in both forms). A v2 event 1.0.2
  refused only because its recorded recipient differed from the constant
  would now be read; every stored v2 event passed the collector's comparison
  with its configured recipient at receipt, so this changes nothing for mail
  that passed that check unless the configured recipient itself changed.
  Production was not read for this decision. Existing raw objects, parse
  runs and observations remain append-only; the processor registers the
  release and the repair lane re-parses stored evidence.
- **New mail is stored with provenance v2.** Parser 1.0.2 refuses a
  provenance-v2 event as schema drift, so an event the new collector stores
  before the processor runs 1.1.0 fails its first parse and is read when the
  repair lane re-parses it under 1.1.0.
- **A redelivery across the deploy boundary conflicts.** The normalized event
  of a message changes with provenance v2, so a mail stored before the deploy
  and delivered again with the same bytes after it produces a different run
  terminal for the same run id; `persistRun` answers `conflict` and the
  handler fails the mail with a closed code instead of storing a second
  version. The first stored pair is unchanged.
- **Limits.** A v1 forwarded event has no parser sender check (the collector
  checked it at receipt; the paired `notification.eml` holds the From). A
  legacy `vpoint-pay-email-event-v1` event has no provenance at all, as
  before. The sender check is a shape check, not authentication. The
  recipient guard is in the collector alone: a defect there is no longer
  caught by the parser.

## Verification

- `packages/parsers/test/v-point-pay-refusals.test.ts`: the recipient is
  recorded but not compared (any synthetic mailbox is accepted; empty,
  missing, malformed or oversized values are refused); provenance v2 requires
  the official sender as `messageFrom` in both forms and refuses a forwarder,
  a lookalike or a malformed value; provenance v2 without `messageFrom` and
  v1 with it are drift; every other provenance contradiction is still
  refused; 1.1.0 reproduces the frozen 1.0.1 and 1.0.2 results. The sender
  and recipient tests failed against 1.0.2 before the parser change.
- `services/collector-vpoint/worker-test/vpoint-pay-recipient.test.ts` runs
  the Worker's email handler against the recipient the deployed Wrangler
  config binds: an official notification sent to it is stored, and the same
  notification sent to another mailbox on the same domain, a subdomain, the
  Web OTP alias or an unrelated mailbox is never stored.
- `services/collector-vpoint/test/vpoint-pay-email.test.ts`: provenance v2 is
  written exactly, a forwarded notification records the inner official From,
  and storage is refused for another recipient or a non-provider From.
- `experiments/observation-pipeline-local/test/v-point-pay-parser.test.ts`:
  a provenance-v2 forwarded event with a synthetic recipient is read without
  propagating the provenance, and a forwarder as `messageFrom` is refused.
