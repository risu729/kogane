import type {
  ArtifactMeta,
  BalanceObservation,
  Observation,
  Parser,
  ParseResult,
} from "../types.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
import {
  exactKeys,
  strictBoolean,
  strictObject,
  strictSafeInteger,
  strictString,
} from "./sbi-strict.ts";

const SOURCE = "v-point";
const MIME = "application/json";
const INSTRUMENT = "V_POINT";
const PAGE_SIZE = 30;
const MAX_HISTORY_PAGES = 200;
const BALANCE_KEYS = ["common", "get_month", "store", "tmoney"] as const;
const HISTORY_KEYS = [
  "date_reflect",
  "date_use",
  "is_use_mbo",
  "point",
  "point_div",
  "point_type",
  "reason",
  "store_alliance_name",
  "store_category",
  "store_company",
  "store_name",
] as const;

export const vPointBalanceInfo: Parser = {
  name: "v-point-balance-info",
  version: "1.0.0",
  accepts: (artifact) => accepts(artifact, "balance-info"),
  parse(bytes, artifact) {
    requireEligible(artifact, "balance-info");
    const results = envelope(bytes, "balance-info");
    exactKeys(results, BALANCE_KEYS, "balance-info.results");
    const getMonth = strictSafeInteger(results.get_month, "balance-info.results.get_month", {
      minimum: 0,
    });
    const tmoney = strictObject(results.tmoney, "balance-info.results.tmoney");
    exactKeys(tmoney, [], "balance-info.results.tmoney");
    if (!Array.isArray(results.common) || results.common.length > 100) {
      throw new Error("balance-info.results.common must be a bounded array");
    }
    if (!Array.isArray(results.store) || results.store.length > 1_000) {
      throw new Error("balance-info.results.store must be a bounded array");
    }

    const observations: Observation[] = [];
    for (const [index, value] of results.common.entries()) {
      const row = strictObject(value, `balance-info.results.common[${index}]`);
      exactKeys(
        row,
        ["expiration", "point", "point_type"],
        `balance-info.results.common[${index}]`,
      );
      const point = strictSafeInteger(row.point, `balance-info.results.common[${index}].point`);
      const pointType = strictSafeInteger(
        row.point_type,
        `balance-info.results.common[${index}].point_type`,
        { minimum: 0 },
      );
      const expiration = strictString(
        row.expiration,
        `balance-info.results.common[${index}].expiration`,
        { empty: true, max: 100 },
      );
      observations.push(
        pointBalance({
          sourceAccount: `v-point:common:bucket-${index}`,
          metric: "available_point_bucket",
          point,
          artifact,
          rawLocator: `json:$.results.common[${index}]`,
          extra: {
            ...row,
            _kogane: {
              asset: "v_point",
              expiration,
              pointType,
              pointTypeMeaning: "unmapped-provider-enum",
              getMonth,
            },
          },
        }),
      );
    }
    for (const [groupIndex, value] of results.store.entries()) {
      const group = strictObject(value, `balance-info.results.store[${groupIndex}]`);
      exactKeys(group, ["alliance_name", "items"], `balance-info.results.store[${groupIndex}]`);
      const allianceName = strictString(
        group.alliance_name,
        `balance-info.results.store[${groupIndex}].alliance_name`,
        { empty: true, max: 500 },
      );
      if (!Array.isArray(group.items) || group.items.length > 1_000) {
        throw new Error(`balance-info.results.store[${groupIndex}].items must be a bounded array`);
      }
      for (const [itemIndex, value] of group.items.entries()) {
        const item = strictObject(
          value,
          `balance-info.results.store[${groupIndex}].items[${itemIndex}]`,
        );
        exactKeys(
          item,
          ["expiration", "point"],
          `balance-info.results.store[${groupIndex}].items[${itemIndex}]`,
        );
        const point = strictSafeInteger(
          item.point,
          `balance-info.results.store[${groupIndex}].items[${itemIndex}].point`,
        );
        const expiration = strictString(
          item.expiration,
          `balance-info.results.store[${groupIndex}].items[${itemIndex}].expiration`,
          { empty: true, max: 100 },
        );
        observations.push(
          pointBalance({
            sourceAccount: `v-point:store-limited:group-${groupIndex}:item-${itemIndex}`,
            metric: "available_point_bucket",
            point,
            artifact,
            rawLocator: `json:$.results.store[${groupIndex}].items[${itemIndex}]`,
            extra: {
              ...item,
              allianceName,
              _kogane: { asset: "v_point", expiration, getMonth },
            },
          }),
        );
      }
    }
    return { observations, warnings: [] };
  },
};

export const vPointSmfgPoint: Parser = {
  name: "v-point-smfg-point",
  version: "1.0.0",
  accepts: (artifact) => accepts(artifact, "smfg-point"),
  parse(bytes, artifact) {
    requireEligible(artifact, "smfg-point");
    const results = envelope(bytes, "smfg-point");
    exactKeys(results, ["get_point"], "smfg-point.results");
    const points = strictObject(results.get_point, "smfg-point.results.get_point");
    exactKeys(points, ["point_smbc", "point_smcc"], "smfg-point.results.get_point");
    return {
      observations: (["point_smbc", "point_smcc"] as const).map((field) =>
        pointBalance({
          sourceAccount: `v-point:smfg:${field.slice("point_".length)}`,
          metric: "displayed_point_balance",
          point: strictSafeInteger(points[field], `smfg-point.results.get_point.${field}`),
          artifact,
          rawLocator: `json:$.results.get_point.${field}`,
          extra: {
            field,
            _kogane: {
              asset: "v_point",
              providerBreakdownMeaning: "not-inferred",
            },
          },
        }),
      ),
      warnings: [],
    };
  },
};

export const vPointHistoryPage: Parser = {
  name: "v-point-history-page",
  version: "1.0.0",
  accepts: (artifact) =>
    artifact.sourceId === SOURCE &&
    artifact.mime === MIME &&
    /^history-page-\d{4}$/u.test(artifact.dataset ?? ""),
  parse(bytes, artifact): ParseResult {
    requireSuccessfulRun(artifact);
    if (artifact.sourceId !== SOURCE || artifact.mime !== MIME) {
      throw new Error("V Point history metadata is unsupported");
    }
    const match = /^history-page-(\d{4})$/u.exec(artifact.dataset ?? "");
    const page = Number(match?.[1]);
    if (!match || page < 1 || page > MAX_HISTORY_PAGES) {
      throw new Error("V Point history page dataset is invalid");
    }
    const results = envelope(bytes, "history-page");
    exactKeys(results, ["graph", "history", "total"], "history-page.results");
    const total = strictSafeInteger(results.total, "history-page.results.total", {
      minimum: 0,
      maximum: 1_000_000,
    });
    if (!Array.isArray(results.history) || results.history.length > PAGE_SIZE) {
      throw new Error("history-page.results.history must be a bounded array");
    }
    const expectedRows = Math.min(PAGE_SIZE, Math.max(total - (page - 1) * PAGE_SIZE, 0));
    if (results.history.length !== expectedRows || (total === 0 && page !== 1)) {
      throw new Error("V Point history pagination is incomplete");
    }
    validateGraph(results.graph);

    const observations = results.history.map((value, index) => {
      const row = strictObject(value, `history-page.results.history[${index}]`);
      exactKeys(row, HISTORY_KEYS, `history-page.results.history[${index}]`);
      const point = strictSafeInteger(row.point, `history-page.results.history[${index}].point`);
      const reflectedDate = compactDate(
        row.date_reflect,
        `history-page.results.history[${index}].date_reflect`,
      );
      const usedDate = compactDate(row.date_use, `history-page.results.history[${index}].date_use`);
      const pointDivision = strictSafeInteger(
        row.point_div,
        `history-page.results.history[${index}].point_div`,
        { minimum: 0 },
      );
      const pointType = strictSafeInteger(
        row.point_type,
        `history-page.results.history[${index}].point_type`,
        { minimum: 0 },
      );
      const isUseMbo = strictBoolean(
        row.is_use_mbo,
        `history-page.results.history[${index}].is_use_mbo`,
      );
      for (const field of [
        "reason",
        "store_alliance_name",
        "store_category",
        "store_company",
        "store_name",
      ] as const) {
        strictString(row[field], `history-page.results.history[${index}].${field}`, {
          empty: true,
          max: 2_000,
        });
      }
      const description = firstNonEmpty(row.reason, row.store_name, row.store_company);
      const counterparty = firstNonEmpty(
        row.store_name,
        row.store_company,
        row.store_alliance_name,
      );
      const effectiveDate = usedDate ?? reflectedDate;
      return {
        kind: "transaction" as const,
        sourceAccount: "v-point:member",
        amountMinor: point,
        amountText: String(point),
        amountScale: 0,
        currency: INSTRUMENT,
        ...(description ? { description } : {}),
        ...(counterparty ? { counterparty } : {}),
        ...(effectiveDate ? { asOf: effectiveDate } : {}),
        observedAt: artifact.fetchedAt,
        rawLocator: `json:$.results.history[${index}]`,
        extra: {
          ...row,
          _kogane: {
            asset: "v_point",
            page,
            total,
            reflectedDate,
            usedDate,
            dateBasis: usedDate ? "date_use" : reflectedDate ? "date_reflect" : "unavailable",
            pointDivision,
            pointDivisionMeaning: "unmapped-provider-enum",
            pointType,
            pointTypeMeaning: "unmapped-provider-enum",
            isUseMbo,
            amountSignOrigin: "provider-point-field",
            providerStableId: "unavailable",
          },
        },
      };
    });
    return { observations, warnings: [] };
  },
};

function accepts(artifact: ArtifactMeta, dataset: string): boolean {
  return artifact.sourceId === SOURCE && artifact.dataset === dataset && artifact.mime === MIME;
}

function requireEligible(artifact: ArtifactMeta, dataset: string): void {
  requireSuccessfulRun(artifact);
  if (!accepts(artifact, dataset)) throw new Error(`V Point ${dataset} metadata is unsupported`);
}

function requireSuccessfulRun(artifact: ArtifactMeta): void {
  if (
    (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
    !unitScopeAdmitted(artifact)
  ) {
    throw new Error("V Point observations require a successful failure-free fetch run");
  }
}

function envelope(bytes: Uint8Array, label: string): Record<string, unknown> {
  const root = strictObject(JSON.parse(decodeUtf8(bytes)), label);
  exactKeys(root, ["status", "results"], label);
  const status = strictObject(root.status, `${label}.status`);
  exactKeys(status, ["code", "response"], `${label}.status`);
  if (status.code !== "0000") throw new Error(`${label} provider status is not successful`);
  strictString(status.response, `${label}.status.response`, { empty: true, max: 1_000 });
  return strictObject(root.results, `${label}.results`);
}

function validateGraph(value: unknown): void {
  const graph = strictObject(value, "history-page.results.graph");
  exactKeys(graph, ["monthly", "yearly"], "history-page.results.graph");
  for (const field of ["monthly", "yearly"] as const) {
    const series = graph[field];
    if (!Array.isArray(series) || series.length > 120) {
      throw new Error(`history-page.results.graph.${field} must be a bounded array`);
    }
    for (const [index, value] of series.entries()) {
      const row = strictObject(value, `history-page.results.graph.${field}[${index}]`);
      exactKeys(row, ["label", "point"], `history-page.results.graph.${field}[${index}]`);
      strictString(row.label, `history-page.results.graph.${field}[${index}].label`, {
        empty: true,
        max: 100,
      });
      strictSafeInteger(row.point, `history-page.results.graph.${field}[${index}].point`);
    }
  }
}

function compactDate(value: unknown, label: string): string | undefined {
  const text = strictString(value, label, { empty: true, max: 32 });
  if (text === "") return undefined;
  const match = /^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/u.exec(text);
  if (!match) throw new Error(`${label} has an unsupported format`);
  const normalized = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${normalized}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== normalized)
    throw new Error(`${label} is not a calendar date`);
  return normalized;
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function pointBalance(options: {
  sourceAccount: string;
  metric: string;
  point: number;
  artifact: ArtifactMeta;
  rawLocator: string;
  extra: Record<string, unknown>;
}): BalanceObservation {
  return {
    kind: "balance",
    sourceAccount: options.sourceAccount,
    metric: options.metric,
    amountMinor: options.point,
    amountText: String(options.point),
    amountScale: 0,
    instrument: INSTRUMENT,
    observedAt: options.artifact.fetchedAt,
    rawLocator: options.rawLocator,
    extra: options.extra,
  };
}
