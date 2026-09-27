/**
 * A count or cursor the provider states, read exactly.
 *
 * Vpass states these both ways: on the live site (2026-09-27, field names and
 * types only) a finalized statement page's `webMeisaiTopK3Vo.allCnt` is a JSON
 * string and a customized page's `total` a JSON number. Both are accepted as
 * written: a non-negative safe integer number, or a string of ASCII digits
 * only (no sign, space, separator, decimal point or full-width digit) whose
 * value is a safe integer. Anything else is `null`, a reason the caller
 * reports, never a zero.
 */
export function providerCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^[0-9]{1,16}$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}
