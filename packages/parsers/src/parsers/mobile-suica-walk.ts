// The observed search is inclusive. Replace the complete boundary-day suffix,
// rather than subtracting one day or collapsing equal rows into a set.
export const MAX_HISTORY_PAGES = 26 * 7 + 1;
// A row a little past the documented 26 weeks stays a preserved parser
// warning, as before the walk. Only a year-wrapped month/day inference, which
// is always at least 365 days old, is an impossible date.
const YEAR_WRAP_MS = 365 * 86_400_000;
interface WalkRow {
  date: string;
  amount: number | null;
  amountText: string;
}
export function strictHistoryDate(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error("history_date_invalid");
}
export function mergeHistoryPage<T extends WalkRow>(
  previous: readonly T[],
  page: readonly T[],
  cursor: string,
  asOf: string,
  index: number,
): T[] {
  strictHistoryDate(cursor);
  strictHistoryDate(asOf);
  if (page.length > 100 || index >= MAX_HISTORY_PAGES) throw new Error("history_row_count_invalid");
  let latest = cursor;
  for (const row of page) {
    strictHistoryDate(row.date);
    if (
      row.date > latest ||
      row.date >= asOf ||
      Date.parse(asOf) - Date.parse(row.date) >= YEAR_WRAP_MS
    )
      throw new Error("history_date_order_invalid");
    latest = row.date;
  }
  if (index === 0) {
    if (cursor !== asOf || previous.length !== 0) throw new Error("history_cursor_invalid");
    return [...page];
  }
  if (previous.at(-1)?.date !== cursor) throw new Error("history_cursor_invalid");
  const overlap = previous.filter((row) => row.date === cursor);
  if (page.length < overlap.length) throw new Error("history_overlap_invalid");
  for (const [offset, old] of overlap.entries()) {
    const next = page[offset]!;
    const identity = (row: T) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row).filter(([key]) => key !== "amount" && key !== "amountText"),
        ),
      );
    if (
      identity(old) !== identity(next) ||
      (old.amount !== null && (old.amount !== next.amount || old.amountText !== next.amountText))
    )
      throw new Error("history_overlap_invalid");
  }
  if (page.length === 100 && page.at(-1)!.date >= cursor)
    throw new Error("history_single_day_limit");
  return [...previous.filter((row) => row.date > cursor), ...page];
}
