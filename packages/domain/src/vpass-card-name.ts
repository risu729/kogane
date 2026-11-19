// The Vpass card product name (#1357): what the `vpass-credit-snapshot`
// parser may keep from a response's `cardName`, and the display label the
// shared organization step builds from it. One rule for both sides, so a name
// the parser would refuse is never shown even if a row carries it.
//
// The name is a product name, not an identity: it never selects an account or
// changes a mapping (identity rules and their labels are unchanged). A card
// number is never a name, so a value with a run of four or more decimal
// digits (ASCII or any other script, masked numbers included) is not kept.

/** Longest card name kept; longer text is not a product name. */
const VPASS_CARD_NAME_MAX = 64;

/** The kept name, or `undefined` when the value must not be kept. Never throws. */
export function vpassCardName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name.length < 1 || name.length > VPASS_CARD_NAME_MAX) return undefined;
  if (/\p{Decimal_Number}{4,}/u.test(name) || /\p{Cc}/u.test(name)) return undefined;
  return name;
}

/** The card's display label, `<cardName>（card-NNN）`, or `undefined`. */
export function vpassCardLabel(name: unknown, sourceAccount: unknown): string | undefined {
  const kept = vpassCardName(name);
  if (kept === undefined || typeof sourceAccount !== "string") return undefined;
  const ordinal = /^vpass:(card-\d{3})$/u.exec(sourceAccount)?.[1];
  return ordinal === undefined ? undefined : `${kept}（${ordinal}）`;
}
