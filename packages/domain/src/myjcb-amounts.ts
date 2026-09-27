// The MyJCB cell grammars that card purchase recognition
// (`card-purchase.ts`) and the confirmed-page proof
// (`myjcb-statement-page.ts`, ADR 0005 amendment d) share: the payment type in
// the combined ご利用先など／支払区分 cell, and a display amount. They import
// nothing but exact values, so the MyJCB parsers, whose code digest covers
// every module they import, do not depend on recognition as a whole.
import { absentQuantity, exactQuantity, integerDecimal, type Quantity } from "./values.ts";

/**
 * Words of a MyJCB payment type that is not one single payment: installments,
 * revolving, bonus and cash advance (キャッシング1回払い is a loan, not a
 * purchase). Any of them anywhere in the cell excludes the row, even when a
 * merchant name is what contains it: a skipped purchase is safe, a guessed one
 * is not.
 */
export const MYJCB_NOT_SINGLE_WORDS = ["分割", "リボ", "ボーナス", "キャッシング"] as const;
/**
 * A payment count, `N回払` or `N回払い`, in ASCII digits (after NFKC) or kanji
 * numerals, whitespace allowed inside. It never starts right after another
 * digit, so a merchant name ending in a digit and written with no space
 * before `1回払` reads as a larger count (`21回払`) and is excluded, never as 1.
 */
const MYJCB_PAYMENT_COUNT =
  /(?<![0-9〇一二三四五六七八九十百千])([0-9]+|[〇一二三四五六七八九十百千]+)\s*回\s*払/gu;

/**
 * Whether a MyJCB combined `ご利用先など／支払区分` cell states one single
 * payment: after NFKC it holds at least one payment count (`1回払`, `1回払い`,
 * `一回払い`, `１ 回払`) and every count it holds is 1, and with whitespace
 * removed it holds none of `MYJCB_NOT_SINGLE_WORDS`. `2回払`, `11回払`,
 * `分割払い`, `リボ払`, `ボーナス1回払`, `キャッシング1回払い`, a cell without a
 * count and an absent cell are not.
 */
export function myjcbSinglePayment(cell: string | null): boolean {
  if (typeof cell !== "string") return false;
  const text = cell.normalize("NFKC");
  const compact = text.replace(/\s+/gu, "");
  if (MYJCB_NOT_SINGLE_WORDS.some((word) => compact.includes(word))) return false;
  const counts = [...text.matchAll(MYJCB_PAYMENT_COUNT)].map((match) => match[1]);
  return counts.length > 0 && counts.every((count) => count === "1" || count === "一");
}

/**
 * A MyJCB display amount, read with the grammar the MyJCB ledger parser reads
 * its own amount cell with (`packages/parsers/src/parsers/myjcb.ts`
 * `jpyAmount`): NFKC, whitespace removed, an optional leading yen sign and
 * trailing `円`, then an exact integer with optional thousands separators and
 * an optional leading minus (`1,200円`, `-500円`). Anything else is not read as
 * a number.
 */
export function myjcbDisplayInteger(value: string | null): bigint | null {
  if (value === null) return null;
  const text = value
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/^[¥\\]/u, "")
    .replace(/円$/u, "");
  if (!/^-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u.test(text)) return null;
  return BigInt(text.replaceAll(",", ""));
}

/**
 * A MyJCB display amount as a JPY quantity, read with `myjcbDisplayInteger`:
 * exact when the text reads, `unparsed` otherwise, never zero (INV05). Sums of
 * such amounts go through `sumQuantities` (INV03); the confirmed-page proof in
 * `myjcb-statement-page.ts` is its one reader.
 */
export function myjcbDisplayQuantity(value: string | null): Quantity {
  const amount = myjcbDisplayInteger(value);
  return amount === null
    ? absentQuantity("JPY", "unparsed", "myjcb_display_amount_unreadable")
    : exactQuantity("JPY", integerDecimal(amount));
}
