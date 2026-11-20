// The closed row kinds of a finalized statement page
// (`WebMeisaiTopDisplayServiceBean.meisaiList`), read by shape only.
//
// One classifier serves both readers: the counts-only shape diagnostic
// (`./statement-count-diagnostic`, ADR 0023's 2026-10-10 amendment) and the
// month check (`monthCheck` in `./shared-collection`, ADR 0023 option 8 and
// its 2026-11-19 amendment). A row is one of the five kinds the statement
// parser accepts (`packages/parsers/src/parsers/vpass.ts`) only when its
// `rowType` repeats `data[0]` and its cells have that kind's length; anything
// else is `other`. Nothing here reads a cell's text beyond the two code cells,
// and nothing about the row leaves this function but its kind.

export type FinalizedRowKind = "45" | "4C" | "4K002" | "4K005" | "4K007" | "other";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

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

/**
 * The finalized page's header rows, which `webMeisaiTopK3Vo.allCnt` does not
 * count: on every finalized page the owner's counts-only read covered (30
 * months across 7 cards, 2026-11-18), each page carried exactly one `45` and
 * one `4C` row and `allCnt` equalled the `4K/002` + `4K/005` + `4K/007` rows
 * (ADR 0023's 2026-11-19 amendment, the owner's decision D1). Every other
 * kind, `other` included, is counted.
 */
export function isFinalizedHeaderRow(value: unknown): boolean {
  const kind = finalizedRowKind(value);
  return kind === "45" || kind === "4C";
}
