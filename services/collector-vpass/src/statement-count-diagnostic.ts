// Counts-only investigation. No network, storage, identifiers or provider text
// leave this reducer. It never supplies or modifies collection coverage.
import { providerCount } from "./provider-count";
import { logVpassDiagnostic } from "./log-diagnostic";

type Family = "finalized" | "customized" | "unknown";
type Relation = "equal" | "short" | "excess" | "unverified";
type RowKind = "45" | "4C" | "4K002" | "4K005" | "4K007" | "other";
type Page = { readonly rawJson: string };
type Month = { readonly pages: readonly Page[] };

const histogram = () => ({ equal: 0, short: 0, excess: 0, unverified: 0 });
const bucket = () => ({
  months: 0,
  pages: 0,
  rows: 0,
  rowKinds: { "45": 0, "4C": 0, "4K002": 0, "4K005": 0, "4K007": 0, other: 0 },
  rawRowsVersusLastTotal: histogram(),
  detailRowsVersusLastTotal: histogram(),
  totalStability: { stable: 0, changed: 0, unverified: 0 },
  finalTotalBeforeNextCursor: { yes: 0, no: 0, unverified: 0 },
  unreadablePages: 0,
  missingRowsPages: 0,
});

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function relation(rows: number, total: number | null): Relation {
  return total === null
    ? "unverified"
    : rows === total
      ? "equal"
      : rows < total
        ? "short"
        : "excess";
}

function rowKind(value: unknown): RowKind {
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

/** Caller supplies ordered pages grouped privately by month, for one card.
 * Bounds are safety limits, not claims about the provider. Exceeding one aborts
 * with a closed code, never a partial report. Unknown rows remain `other`.
 */
export function diagnoseStatementCounts(months: readonly Month[]) {
  if (months.length > 24 || months.some((month) => month.pages.length > 100))
    throw new Error("vpass_count_diagnostic_bounds");
  let characters = 0;
  for (const month of months)
    for (const page of month.pages) {
      characters += page.rawJson.length;
      if (page.rawJson.length > 5_000_000 || characters > 20_000_000)
        throw new Error("vpass_count_diagnostic_bounds");
    }
  const report = { finalized: bucket(), customized: bucket(), unknown: bucket() };
  let rowBudget = 100_000;
  for (const month of months) {
    let family: Family | undefined;
    const item = bucket();
    let lastTotal: number | null = null;
    let firstTotal: number | null = null;
    let missingTotal = false;
    let changedTotal = false;
    let lastCursor: number | null = null;
    for (const page of month.pages) {
      item.pages += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(page.rawJson);
      } catch {
        item.unreadablePages += 1;
      }
      const content = object(object(object(parsed)?.["body"])?.["content"]);
      const finalized = object(content?.["WebMeisaiTopDisplayServiceBean"]);
      const customized = object(content?.["CustomizedMeisaiAnsDisplayServiceBean"]);
      const pageFamily: Family =
        finalized && !customized
          ? "finalized"
          : customized && !finalized
            ? "customized"
            : "unknown";
      family = family === undefined ? pageFamily : family === pageFamily ? family : "unknown";
      const bean =
        pageFamily === "finalized"
          ? finalized
          : pageFamily === "customized"
            ? customized
            : undefined;
      const rows = bean?.["meisaiList"];
      if (!Array.isArray(rows)) item.missingRowsPages += 1;
      else {
        rowBudget -= rows.length;
        if (rowBudget < 0) throw new Error("vpass_count_diagnostic_bounds");
        item.rows += rows.length;
        for (const row of rows)
          item.rowKinds[pageFamily === "finalized" ? rowKind(row) : "other"] += 1;
      }
      const detail = object(finalized?.["webMeisaiTopK3Vo"]);
      const total = providerCount(
        pageFamily === "finalized" ? detail?.["allCnt"] : bean?.["total"],
      );
      if (total === null) missingTotal = true;
      else {
        firstTotal ??= total;
        changedTotal ||= firstTotal !== total;
      }
      lastTotal = total;
      lastCursor = providerCount(detail?.["nextPageRow"]);
    }
    const target = report[family ?? "unknown"];
    target.months += 1;
    target.pages += item.pages;
    target.rows += item.rows;
    target.unreadablePages += item.unreadablePages;
    target.missingRowsPages += item.missingRowsPages;
    for (const key of Object.keys(item.rowKinds) as RowKind[])
      target.rowKinds[key] += item.rowKinds[key];
    const countReadable =
      family !== "unknown" && item.unreadablePages === 0 && item.missingRowsPages === 0;
    target.rawRowsVersusLastTotal[relation(item.rows, countReadable ? lastTotal : null)] += 1;
    target.detailRowsVersusLastTotal[
      relation(
        item.rowKinds["4K005"] + item.rowKinds["4K007"],
        countReadable && family === "finalized" && item.rowKinds.other === 0 ? lastTotal : null,
      )
    ] += 1;
    target.totalStability[
      missingTotal || lastTotal === null ? "unverified" : changedTotal ? "changed" : "stable"
    ] += 1;
    target.finalTotalBeforeNextCursor[
      family !== "finalized" || lastTotal === null || lastCursor === null
        ? "unverified"
        : lastTotal < lastCursor
          ? "yes"
          : "no"
    ] += 1;
  }
  return report;
}

/** Observes captures already in memory after persistence. No identifiers enter
 * the record, no coverage decision reads it, and no diagnostic failure escapes.
 * A stopped diagnostic supplies no partial counts (missing is not zero).
 */
export function logStatementCountDiagnostic(months: Readonly<Record<string, Month>>): void {
  try {
    const report = diagnoseStatementCounts(Object.values(months));
    logVpassDiagnostic({ event: "vpass-statement-count-shapes", status: "available", report });
  } catch {
    logVpassDiagnostic({
      event: "vpass-statement-count-shapes",
      status: "unavailable",
      code: "count_diagnostic_unavailable",
    });
  }
}
