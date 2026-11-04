// Display metadata belongs to the selected parent fact, never a separate latest query.
import { isRecord } from "../../domain/src/guards.ts";
import {
  validRewardProviderExpiryDisplayMetadata,
  type RewardProviderExpirySection,
} from "../../domain/src/reward-expiry-observations.ts";
import type { SqlExecutor } from "./reader.ts";
import { observedAtValue, type RewardBucketSqlRow } from "./rewards.ts";
export async function captureProviderExpirySections(
  sql: SqlExecutor,
  buckets: readonly RewardBucketSqlRow[],
): Promise<RewardProviderExpirySection[]> {
  const parents = buckets.filter(
    (row) => row.program_id === "program:j-point" && row.source_fact_kind === "balance",
  );
  if (parents.length === 0) return [];
  const facts: { id: number; parse_run_id: number; extra_json: string }[] = [];
  // D1 limits each statement to 100 bind parameters, below the 200-row capture bound.
  for (let offset = 0; offset < parents.length; offset += 100) {
    const chunk = parents.slice(offset, offset + 100);
    facts.push(
      ...(await sql.all<{ id: number; parse_run_id: number; extra_json: string }>(
        `SELECT id,parse_run_id,extra_json FROM balance_observations WHERE id IN (${chunk.map(() => "?").join(",")})`,
        chunk.map((row) => row.source_fact_id),
      )),
    );
  }
  return parents.map((parent) => {
    const fact = facts.find(
      (row) => row.id === parent.source_fact_id && row.parse_run_id === parent.parse_run_id,
    );
    let metadata: unknown;
    try {
      const extra: unknown = fact ? JSON.parse(fact.extra_json) : null;
      metadata =
        isRecord(extra) && isRecord(extra._kogane) ? extra._kogane.rewardExpiryDisplays : null;
    } catch {
      metadata = null;
    }
    const admitted =
      validRewardProviderExpiryDisplayMetadata(metadata) &&
      metadata.displays.every((display) => display.quantity.unitRef === parent.unit_ref)
        ? metadata
        : {
            coverage: "unknown" as const,
            reasonCode: "provider_expiry_unavailable" as const,
            displays: [],
          };
    return {
      ...admitted,
      programId: parent.program_id,
      holdingRef: parent.holding_ref,
      parentBucketRef: parent.bucket_ref,
      unitRef: parent.unit_ref,
      observedAt: observedAtValue(parent.observed_at),
      sourceFactRefs: [`balance:${parent.source_fact_id}`],
    };
  });
}
