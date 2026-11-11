import { sha256Hex } from "../../../packages/collection/src/digest";
import {
  INCOME_HISTORY_SCHEMA,
  INCOME_HISTORY_START,
  IncomeHistoryError,
  auditIncomeJson,
  readIncomeJson,
  validateIncomeHistory,
  type IncomeHistoryBundle,
  type IncomeHistoryKind,
} from "../../../packages/parsers/src/parsers/sbi-income-history-schema";
import { incomeDataset } from "../../../packages/parsers/src/parsers/sbi-income-history";
import type { Artifact } from "./types";

export const incomeSourceKey = (
  kind: IncomeHistoryKind,
  role: "rows" | "summary" | "all-summary",
) => `${incomeDataset(kind)}-${role}-source.json`;

/** Only observed request values; continuation offsets are deliberately absent. */
export function incomeHistoryUrl(
  baseUrl: string,
  kind: IncomeHistoryKind,
  role: "rows" | "summary" | "all-summary",
  range: { from: string; to: string },
): URL {
  const path =
    kind === "income"
      ? `/account/api/assets/dividends${role === "rows" ? "" : "/category/summary"}`
      : `/account/api/assets/profit-loss${role === "rows" ? "" : "/summary"}`;
  const url = new URL(path, baseUrl);
  const slash = (date: string) => date.replaceAll("-", "/");
  const params =
    kind === "income"
      ? {
          category: "",
          accountType: "",
          dispositionDateFrom: slash(range.from),
          dispositionDateTo: slash(range.to),
        }
      : {
          baseDateFrom: slash(range.from),
          baseDateTo: slash(range.to),
          baseDateType: "CONTRACT",
          accountType: "",
          product: role === "all-summary" ? "ALL" : "DOMESTIC_STOCK",
          domesticCategory: role === "all-summary" ? "" : "SPOT",
          countryCode: "",
          bondCategory: "",
          fundCategory: "",
        };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (role === "rows") {
    url.searchParams.set("offset", "1");
    url.searchParams.set("limit", "30");
  }
  return url;
}

/** The observed first-page request plus independent summary is the complete supported route. */
export async function collectIncomeHistory(options: {
  kind: IncomeHistoryKind;
  today: string;
  fetch: (
    role: "rows" | "summary" | "all-summary",
    range: { from: string; to: string },
  ) => Promise<Uint8Array>;
  retain: (artifact: Artifact) => void;
}): Promise<void> {
  const { kind } = options;
  const range = { from: INCOME_HISTORY_START, to: options.today };
  const texts = new Map<string, string>();
  const roles =
    kind === "income"
      ? (["summary", "rows"] as const)
      : (["all-summary", "summary", "rows"] as const);
  for (const role of roles) {
    const bytes = await options.fetch(role, range);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new IncomeHistoryError("sbi_income_history_schema");
    }
    auditIncomeJson(readIncomeJson(text), kind, role === "rows" ? "rows" : "summary");
    // Retain closed-schema raw financial evidence before precision, category,
    // count and pagination checks; unknown/login/secret payloads never reach it.
    options.retain({
      artifactKey: incomeSourceKey(kind, role),
      dataset: `${incomeDataset(kind)}-${role}-source`,
      role: "provider_response",
      mediaType: "application/json",
      body: null,
      bytes,
    });
    texts.set(role, text);
  }
  const body: IncomeHistoryBundle = {
    schemaVersion: INCOME_HISTORY_SCHEMA,
    kind,
    requestedRange: range,
    summaryText: texts.get("summary")!,
    rowsText: texts.get("rows")!,
    allSummaryText: texts.get("all-summary") ?? null,
  };
  validateIncomeHistory(body, kind);
  options.retain({
    dataset: incomeDataset(kind),
    mediaType: "application/json",
    body,
    inputArtifactKeys: roles.map((role) => incomeSourceKey(kind, role)),
    window: range,
  });
}

/** Registration cannot treat missing or altered original inputs as complete. */
export async function incomeHistoryInventoryComplete(
  artifacts: readonly Artifact[],
): Promise<boolean> {
  try {
    for (const kind of ["income", "gains"] as const) {
      const dataset = incomeDataset(kind);
      const sources = artifacts.filter(
        (a) => a.dataset.startsWith(`${dataset}-`) && a.dataset.endsWith("-source"),
      );
      const derived = artifacts.filter((a) => a.dataset === dataset);
      if (sources.length === 0 && derived.length === 0) continue;
      if (derived.length !== 1) return false;
      const artifact = derived[0]!;
      const { bundle } = validateIncomeHistory(artifact.body, kind);
      const roles =
        kind === "income"
          ? (["summary", "rows"] as const)
          : (["all-summary", "summary", "rows"] as const);
      const keys = roles.map((role) => incomeSourceKey(kind, role));
      if (
        sources.length !== roles.length ||
        JSON.stringify(artifact.inputArtifactKeys) !== JSON.stringify(keys) ||
        JSON.stringify(artifact.window) !== JSON.stringify(bundle.requestedRange) ||
        artifact.bytes !== undefined ||
        artifact.role !== undefined ||
        artifact.mediaType !== "application/json" ||
        (artifact.artifactKey !== undefined && artifact.artifactKey !== `${dataset}.json`)
      )
        return false;
      for (const role of roles) {
        const source = sources.filter((a) => a.artifactKey === incomeSourceKey(kind, role));
        if (
          source.length !== 1 ||
          source[0]!.role !== "provider_response" ||
          source[0]!.bytes === undefined ||
          source[0]!.mediaType !== "application/json"
        )
          return false;
        const text =
          role === "all-summary"
            ? bundle.allSummaryText!
            : role === "summary"
              ? bundle.summaryText
              : bundle.rowsText;
        if (
          (await sha256Hex(source[0]!.bytes)) !== (await sha256Hex(new TextEncoder().encode(text)))
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
