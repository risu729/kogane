// Exact response plus bounded calendar-year derivatives. The provider offers
// no year parameter; these are local partitions of one audited response.
import {
  assetHistoryError,
  assetHistoryYear,
  assetHistoryShardKey,
  ASSET_HISTORY_SOURCE_KEY,
  ASSET_HISTORY_INVENTORY_KEY,
  ASSET_HISTORY_INVENTORY_SCHEMA,
  ASSET_HISTORY_SHARD_SCHEMA,
  type AssetHistoryCapture,
  type AssetHistoryInventory,
  type AssetHistoryShard,
} from "../../../packages/parsers/src/parsers/sbi-asset-history-schema";
import { sha256Hex } from "../../../packages/collection/src/digest";
import type { Artifact } from "./types";
import { parseAssetHistoryJson } from "../../../packages/parsers/src/parsers/sbi-asset-history-json";
import { validateAssetHistory } from "../../../packages/parsers/src/parsers/sbi-asset-history-validation";

export async function assetHistoryArtifacts(input: {
  body: unknown;
  bytes: Uint8Array;
  capturedAt: string;
}): Promise<Artifact[]> {
  const views = validateAssetHistory(parseAssetHistoryJson(new TextDecoder().decode(input.bytes)));
  const sourceCapture: AssetHistoryCapture = {
    artifactKey: ASSET_HISTORY_SOURCE_KEY,
    sha256: await sha256Hex(input.bytes),
    capturedAt: input.capturedAt,
    request: { method: "GET", path: "/account/api/assets/valuations" },
  };
  const years = [
    ...new Set(views.flatMap((v) => Object.keys(v.transitions ?? {}).map(assetHistoryYear))),
  ].sort();
  if (years.length === 0) throw assetHistoryError("sbi_asset_history_shard_inventory");
  const shards: Artifact[] = [];
  const inventory: AssetHistoryInventory = {
    schemaVersion: ASSET_HISTORY_INVENTORY_SCHEMA,
    sourceCapture,
    shards: [],
  };
  for (const year of years) {
    const history: Record<string, unknown> = {};
    let pointCount = 0;
    for (const view of views) {
      const times = Object.keys(view.transitions ?? {})
        .filter((t) => assetHistoryYear(t) === year)
        .sort();
      if (times.length > 53 || (view.transitions !== null && times.length === 0))
        throw assetHistoryError("sbi_asset_history_shard_inventory");
      pointCount = Math.max(pointCount, times.length);
      const held = new Set(times);
      history[`holdCategories${view.suffix}`] = view.holdCategories;
      history[`valuationsTransitions${view.suffix}`] =
        view.transitions === null
          ? null
          : Object.fromEntries(times.map((t) => [t, view.transitions![t]!]));
      history[`balances${view.suffix}`] = view.balances.filter(([t]) => held.has(String(t)));
      history[`acquisitionCosts${view.suffix}`] = view.acquisitionCosts.filter(([t]) =>
        held.has(String(t)),
      );
    }
    const body: AssetHistoryShard = {
      schemaVersion: ASSET_HISTORY_SHARD_SCHEMA,
      sourceCapture,
      year,
      history,
    };
    const artifactKey = assetHistoryShardKey(year);
    inventory.shards.push({
      artifactKey,
      year,
      sha256: await sha256Hex(new TextEncoder().encode(JSON.stringify(body))),
      pointCount,
    });
    shards.push({
      artifactKey,
      dataset: "account-assets-history",
      mediaType: "application/json",
      body,
      inputArtifactKeys: [ASSET_HISTORY_SOURCE_KEY, ASSET_HISTORY_INVENTORY_KEY],
    });
  }
  return [
    {
      artifactKey: ASSET_HISTORY_INVENTORY_KEY,
      dataset: "account-assets-history-inventory",
      mediaType: "application/json",
      body: inventory,
      inputArtifactKeys: [ASSET_HISTORY_SOURCE_KEY],
    },
    ...shards,
  ];
}

/** Shared persistence refuses incomplete or altered inventories as partial. */
export async function assetHistoryInventoryComplete(
  artifacts: readonly Artifact[],
): Promise<boolean> {
  const source = artifacts.find((a) => a.artifactKey === ASSET_HISTORY_SOURCE_KEY);
  const history = artifacts.filter(
    (a) =>
      a.dataset === "account-assets-history" ||
      a.dataset === "account-assets-history-inventory" ||
      a.dataset === "account-assets-history-source",
  );
  if (history.length === 0) return true;
  if (source?.bytes === undefined || source.role !== "provider_response") return false;
  const inventory = artifacts.find((a) => a.artifactKey === ASSET_HISTORY_INVENTORY_KEY);
  if (inventory === undefined) return false;
  if (inventory.body === null || typeof inventory.body !== "object") return false;
  const candidate = inventory.body as AssetHistoryInventory;
  if (typeof candidate.sourceCapture?.capturedAt !== "string") return false;
  try {
    if (
      JSON.stringify(parseAssetHistoryJson(new TextDecoder().decode(source.bytes))) !==
      JSON.stringify(source.body)
    )
      return false;
    const expected = await assetHistoryArtifacts({
      body: source.body,
      bytes: source.bytes,
      capturedAt: candidate.sourceCapture.capturedAt,
    });
    if (history.length !== expected.length + 1) return false;
    for (const item of expected) {
      const found = history.filter((a) => a.artifactKey === item.artifactKey);
      if (
        found.length !== 1 ||
        found[0]!.dataset !== item.dataset ||
        JSON.stringify(found[0]!.body) !== JSON.stringify(item.body) ||
        JSON.stringify(found[0]!.inputArtifactKeys) !== JSON.stringify(item.inputArtifactKeys) ||
        found[0]!.bytes !== undefined ||
        found[0]!.role !== undefined
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
