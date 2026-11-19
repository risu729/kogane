// The finalized statement page's row kinds, as the statement parser
// (`packages/parsers/src/parsers/vpass.ts`) and the counts-only shape
// diagnostic recognize them. Only the exact shapes below are named; any other
// row is `other`.
//
// `45` and `4C` are the page's header rows. The provider's stated total
// (`webMeisaiTopK3Vo.allCnt`) does not count them: in every finalized month of
// the 2026-11-18 production run (30 months, 7 cards, counts only), `allCnt`
// equalled the number of `4K/002`, `4K/005` and `4K/007` rows, and each page
// carried exactly one `45` and one `4C` row besides
// (ADR 0023, 2026-11-19 amendment).

export type FinalizedRowKind = "45" | "4C" | "4K002" | "4K005" | "4K007" | "other";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The kind of one finalized-page `meisaiList` entry; never reads a value beyond the type codes. */
export function finalizedRowKind(value: unknown): FinalizedRowKind {
  const row = object(value);
  const data = row?.["data"];
  if (!Array.isArray(data) || row?.["rowType"] !== data[0]) return "other";
  if (data[0] === "45" && data.length === 5) return "45";
  if (data[0] === "4C" && data.length === 4 && data[1] === "") return "4C";
  if (data[0] !== "4K") return "other";
  if (data[1] === "002" && data.length === 4) return "4K002";
  if (data[1] === "005" && data.length === 11) return "4K005";
  if (data[1] === "007" && data.length === 14) return "4K007";
  return "other";
}

/** Whether a finalized-page row is a header row the stated total does not count. */
export function isFinalizedHeaderRow(value: unknown): boolean {
  const kind = finalizedRowKind(value);
  return kind === "45" || kind === "4C";
}
