/**
 * Absence checks over stored records and log lines ("no record holds the
 * planted amount 98765") must not depend on chance. Those texts also carry
 * random hex and clock values: `aud_` ids and correlation ids are random
 * UUIDs, payload and confirmation digests and generated rule ids are hex, and
 * lane ticks store millisecond clocks. A short digit needle occurs inside one
 * of them now and then (a hosted run failed on an audit id `aud_3987658a-…`).
 *
 * This masks every UUID, then every remaining run of twelve or more hex
 * digits (which covers 13-digit millisecond clocks). A needle of five or more
 * digits then matches only where the text carries it outside those tokens:
 * what is left of an ISO timestamp has no digit run longer than four. A
 * four-digit needle is safe only against a text without timestamps. The
 * masking hides a planted value only if it sits inside a UUID or a run of
 * twelve hex digits, which no record or log line writes a value as.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const LONG_HEX = /[0-9a-f]{12,}/giu;

export function maskRandomTokens(text: string): string {
  return text.replace(UUID, "<uuid>").replace(LONG_HEX, "<hex>");
}
