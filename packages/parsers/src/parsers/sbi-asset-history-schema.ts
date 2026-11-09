// The observed asset-history payload contains financial numbers, known
// category codes and timestamp keys only. Reject drift before a collector
// persists it; semantic consistency and exact quantities belong to the parser.
export const ASSET_HISTORY_PROFILES = [
  { profile: "full", suffix: "" },
  { profile: "without-deposit", suffix: "WithoutDeposit" },
  { profile: "without-ideco", suffix: "WithoutIdeco" },
  { profile: "without-deposit-and-ideco", suffix: "WithoutDepositAndIdeco" },
] as const;
export const ASSET_HISTORY_CATEGORIES = [
  "DOMESTIC_DEPOSIT",
  "DOMESTIC_STOCK_SPOT",
  "FOREIGN_DEPOSIT",
  "SBI_HYBRID_DEPOSIT",
  "FOREIGN_STOCK_US",
  "ALL",
] as const;
export type AssetHistoryCategory = (typeof ASSET_HISTORY_CATEGORIES)[number];
export interface AssetHistoryPoint {
  valuation: number;
  acquisitionCost: number;
  profitLoss: number | null;
  profitLossRate: number | null;
}
export interface AssetHistoryView {
  profile: (typeof ASSET_HISTORY_PROFILES)[number]["profile"];
  suffix: (typeof ASSET_HISTORY_PROFILES)[number]["suffix"];
  holdCategories: AssetHistoryCategory[];
  transitions: Record<string, Partial<Record<AssetHistoryCategory, AssetHistoryPoint>>> | null;
  balances: [number, number][];
  acquisitionCosts: [number, number][];
}
export const ASSET_HISTORY_CODES = [
  "sbi_asset_history_schema",
  "sbi_asset_history_category",
  "sbi_asset_history_bound",
  "sbi_asset_history_timestamp",
  "sbi_asset_history_weekly_gap",
  "sbi_asset_history_money",
  "sbi_asset_history_native_mismatch",
  "sbi_asset_history_total_mismatch",
  "sbi_asset_history_fetch_failed",
  "sbi_asset_history_shard_inventory",
] as const;
export type AssetHistoryCode = (typeof ASSET_HISTORY_CODES)[number];
export type AssetHistoryError = Error & { code: AssetHistoryCode };
export function assetHistoryError(
  code: AssetHistoryCode,
  options?: ErrorOptions,
): AssetHistoryError {
  return Object.assign(new Error(code, options), { code });
}
export function isAssetHistoryError(error: unknown): error is AssetHistoryError {
  if (!(error instanceof Error)) return false;
  const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
  return typeof code === "string" && (ASSET_HISTORY_CODES as readonly string[]).includes(code);
}

const MAX_POINTS = 4096;
const POINT_FIELDS = ["valuation", "acquisitionCost", "profitLoss", "profitLossRate"];
const ROOT_FIELDS = ASSET_HISTORY_PROFILES.flatMap(({ suffix }) => [
  `holdCategories${suffix}`,
  `valuationsTransitions${suffix}`,
  `acquisitionCosts${suffix}`,
  `balances${suffix}`,
]);
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw assetHistoryError("sbi_asset_history_schema");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw assetHistoryError("sbi_asset_history_schema");
}
function category(value: unknown): AssetHistoryCategory {
  if (typeof value !== "string" || !(ASSET_HISTORY_CATEGORIES as readonly string[]).includes(value))
    throw assetHistoryError("sbi_asset_history_category");
  return value as AssetHistoryCategory;
}
function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && /^[1-9]\d{12}$/u.test(String(value));
}
function tuples(value: unknown): [number, number][] {
  if (!Array.isArray(value)) throw assetHistoryError("sbi_asset_history_schema");
  if (value.length > MAX_POINTS) throw assetHistoryError("sbi_asset_history_bound");
  for (const tuple of value)
    if (!Array.isArray(tuple) || tuple.length !== 2 || !timestamp(tuple[0]) || !numeric(tuple[1]))
      throw assetHistoryError("sbi_asset_history_schema");
  return value as [number, number][];
}

/** Validated views retain the original objects, including unselected rows. */
export function assetHistoryViews(value: unknown): AssetHistoryView[] {
  const body = object(value);
  keys(body, ROOT_FIELDS);
  return ASSET_HISTORY_PROFILES.map(({ profile, suffix }) => {
    const held = body[`holdCategories${suffix}`];
    if (!Array.isArray(held) || held.length > ASSET_HISTORY_CATEGORIES.length)
      throw assetHistoryError("sbi_asset_history_schema");
    const holdCategories = held.map(category);
    if (holdCategories.includes("ALL") || new Set(holdCategories).size !== holdCategories.length)
      throw assetHistoryError("sbi_asset_history_category");
    const balances = tuples(body[`balances${suffix}`]);
    const acquisitionCosts = tuples(body[`acquisitionCosts${suffix}`]);
    const raw = body[`valuationsTransitions${suffix}`];
    // Only the explicit unavailable shape of these views has been observed.
    if (suffix.includes("Ideco") && raw !== null)
      throw assetHistoryError("sbi_asset_history_schema");
    if (raw === null) {
      if (holdCategories.length !== 0 || balances.length !== 0 || acquisitionCosts.length !== 0)
        throw assetHistoryError("sbi_asset_history_schema");
      return { profile, suffix, holdCategories, balances, acquisitionCosts, transitions: null };
    }
    const transitions = object(raw);
    const times = Object.keys(transitions);
    if (times.length === 0 || holdCategories.length === 0)
      throw assetHistoryError("sbi_asset_history_schema");
    if (times.length > MAX_POINTS) throw assetHistoryError("sbi_asset_history_bound");
    for (const time of times) {
      if (!/^[1-9]\d{12}$/u.test(time)) throw assetHistoryError("sbi_asset_history_timestamp");
      const rows = object(transitions[time]);
      Object.keys(rows).forEach(category);
      if (![...holdCategories, "ALL"].every((key) => Object.hasOwn(rows, key)))
        throw assetHistoryError("sbi_asset_history_category");
      for (const point of Object.values(rows)) {
        const row = object(point);
        keys(row, POINT_FIELDS);
        if (
          !numeric(row["valuation"]) ||
          !numeric(row["acquisitionCost"]) ||
          (row["profitLoss"] !== null && !numeric(row["profitLoss"])) ||
          (row["profitLossRate"] !== null && !numeric(row["profitLossRate"]))
        )
          throw assetHistoryError("sbi_asset_history_schema");
      }
    }
    return {
      profile,
      suffix,
      holdCategories,
      balances,
      acquisitionCosts,
      transitions: transitions as AssetHistoryView["transitions"],
    };
  });
}

/** No fields are dropped or rewritten after this closed-shape audit. */
export function sanitizeAssetHistory(value: unknown): unknown {
  assetHistoryViews(value);
  return value;
}

export const ASSET_HISTORY_SOURCE_KEY = "account-assets-history-source.json";
export const ASSET_HISTORY_INVENTORY_KEY = "account-assets-history-inventory.json";
export const ASSET_HISTORY_SHARD_SCHEMA = "sbi-asset-history-year-v1";
export const ASSET_HISTORY_INVENTORY_SCHEMA = "sbi-asset-history-inventory-v1";
export interface AssetHistoryCapture {
  artifactKey: typeof ASSET_HISTORY_SOURCE_KEY;
  sha256: string;
  capturedAt: string;
  request: { method: "GET"; path: "/account/api/assets/valuations" };
}
export interface AssetHistoryShard {
  schemaVersion: typeof ASSET_HISTORY_SHARD_SCHEMA;
  sourceCapture: AssetHistoryCapture;
  year: string;
  history: Record<string, unknown>;
}
export interface AssetHistoryInventory {
  schemaVersion: typeof ASSET_HISTORY_INVENTORY_SCHEMA;
  sourceCapture: AssetHistoryCapture;
  shards: { artifactKey: string; year: string; sha256: string; pointCount: number }[];
}

export function assetHistoryYear(time: string): string {
  return new Date(Number(time) + 9 * 3600000).toISOString().slice(0, 4);
}
export function assetHistoryShardKey(year: string): string {
  return `account-assets-history-${year}.json`;
}

/** The envelope is ours; its history remains the provider's original fields. */
export function assetHistoryPayload(value: unknown): { history: unknown; root: string } {
  const body = object(value);
  if (!Object.hasOwn(body, "schemaVersion")) return { history: body, root: "json:$" };
  keys(body, ["schemaVersion", "sourceCapture", "year", "history"]);
  if (
    body["schemaVersion"] !== ASSET_HISTORY_SHARD_SCHEMA ||
    typeof body["year"] !== "string" ||
    !/^\d{4}$/u.test(body["year"])
  )
    throw assetHistoryError("sbi_asset_history_schema");
  const capture = object(body["sourceCapture"]);
  keys(capture, ["artifactKey", "sha256", "capturedAt", "request"]);
  const request = object(capture["request"]);
  keys(request, ["method", "path"]);
  if (
    capture["artifactKey"] !== ASSET_HISTORY_SOURCE_KEY ||
    typeof capture["sha256"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(capture["sha256"]) ||
    typeof capture["capturedAt"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(capture["capturedAt"]) ||
    !Number.isFinite(Date.parse(capture["capturedAt"])) ||
    request["method"] !== "GET" ||
    request["path"] !== "/account/api/assets/valuations"
  )
    throw assetHistoryError("sbi_asset_history_schema");
  for (const view of assetHistoryViews(body["history"]))
    if (view.transitions !== null) {
      const times = Object.keys(view.transitions);
      if (times.length > 53 || times.some((time) => assetHistoryYear(time) !== body["year"]))
        throw assetHistoryError("sbi_asset_history_bound");
    }
  return { history: body["history"], root: "json:$.history" };
}
