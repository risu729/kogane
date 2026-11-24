// Display metadata belongs to the selected parent fact, never a separate latest query.
//
// A section belongs to a selected J-POINT total (ADR 0068). The reader selects
// either the connection's total or the lots of its complete acquisition history
// (ADR 0107), never both. A lot is a balance claim too, but its own fact is an
// acquisition-bucket stock carrying its own observed expiry month, not a total:
// it is no parent, and gets no section that would call its expiry unconfirmed.
import { isRecord } from "../../domain/src/guards.ts";
import {
  validRewardProviderExpiryDisplayMetadata,
  type RewardProviderExpirySection,
} from "../../domain/src/reward-expiry-observations.ts";
import type { SqlExecutor } from "./reader.ts";
import { observedAtValue, type RewardBucketSqlRow } from "./rewards.ts";

/** The metric of the J-POINT total fact a provider display section belongs to. */
const JPOINT_TOTAL_METRIC = "displayed_jpoint_total";

interface ParentFact {
  id: number;
  parse_run_id: number;
  metric: string;
  extra_json: string;
}
export async function captureProviderExpirySections(
  sql: SqlExecutor,
  buckets: readonly RewardBucketSqlRow[],
): Promise<RewardProviderExpirySection[]> {
  const parents = buckets.filter(
    (row) => row.program_id === "program:j-point" && row.source_fact_kind === "balance",
  );
  if (parents.length === 0) return [];
  const facts: ParentFact[] = [];
  // D1 limits each statement to 100 bind parameters, below the 200-row capture bound.
  for (let offset = 0; offset < parents.length; offset += 100) {
    const chunk = parents.slice(offset, offset + 100);
    facts.push(
      ...(await sql.all<ParentFact>(
        `SELECT id,parse_run_id,metric,extra_json FROM balance_observations WHERE id IN (${chunk.map(() => "?").join(",")})`,
        chunk.map((row) => row.source_fact_id),
      )),
    );
  }
  const factOf = (parent: RewardBucketSqlRow): ParentFact | undefined =>
    facts.find(
      (row) => row.id === parent.source_fact_id && row.parse_run_id === parent.parse_run_id,
    );
  // A parent whose own fact is another measure (an acquisition-history lot) is
  // not a total. One whose fact cannot be read stays a section of unknown
  // coverage below, as a total's would.
  const totals = parents.filter((parent) => {
    const fact = factOf(parent);
    return fact === undefined || fact.metric === JPOINT_TOTAL_METRIC;
  });
  return totals.map((parent) => {
    const fact = factOf(parent);
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
