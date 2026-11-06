// The one mapping from a current card usage row (packages/read-model/src/card-usage.ts)
// to the fact the domain classifies (`classifyCardUsage`). The recognition
// lane (services/processor/src/card-purchase-job.ts) and the purchases read
// (`queryCardPurchases`, which counts unrecognised rows per closed reason) both
// read rows through it, so the read reports the reason the writer acts on.
import type { CardUsageFact } from "../../../domain/src/card-purchase.ts";
import { quantityFromNormalizedDecimal, type Quantity } from "../../../domain/src/values.ts";
import type { NormalizedDecimal } from "../../../observation-shared/src/normalized-decimal.ts";
import type { CurrentCardUsageRow } from "../../../read-model/src/card-usage.ts";

/** The columns of a current usage row the fact is built from. */
export const CARD_USAGE_FACT_COLUMNS = [
  "observation_id",
  "parse_run_id",
  "source_id",
  "producer_id",
  "external_id_namespace",
  "source_account",
  "external_id",
  "account_id",
  "account_status",
  "policy_family",
  "provider_status",
  "as_of",
  "statement_period",
  "snapshot_fetched_at",
  "value_status",
  "coefficient",
  "scale",
  "value_basis",
  "unit_ref",
  "payment_type",
  "provider_sale_code",
  "usage_amount_text",
  "payment_amount_text",
] as const satisfies readonly (keyof CurrentCardUsageRow)[];

export type CardUsageFactRow = Pick<CurrentCardUsageRow, (typeof CARD_USAGE_FACT_COLUMNS)[number]>;

/** The decimal-v1 amount of a row; an absent projection is `missing`, never zero. */
function amountOf(row: CardUsageFactRow): Quantity {
  const normalized: NormalizedDecimal = {
    policyVersion: "decimal-v1",
    status: row.value_status ?? "missing",
    coefficient: row.coefficient,
    scale: row.scale,
    basis: row.value_basis ?? "none",
  };
  return quantityFromNormalizedDecimal(row.unit_ref ?? "unknown-unit", normalized);
}

/**
 * The fact the domain classifies. Every returned row is already the newest
 * representation (step 3 of `currentCardUsageSql`). A mapping whose status is
 * `unresolved` names a placeholder account, not a card, so it reads as no
 * account at all (`account_not_resolved`).
 */
export function cardUsageFactOf(row: CardUsageFactRow): CardUsageFact {
  return {
    observationId: row.observation_id,
    parseRunId: row.parse_run_id,
    sourceId: row.source_id,
    producerId: row.producer_id,
    externalIdNamespace: row.external_id_namespace,
    sourceAccount: row.source_account,
    externalId: row.external_id,
    accountId: row.account_status === "unresolved" ? null : row.account_id,
    identityPolicyFamily: row.policy_family,
    providerStatus: row.provider_status,
    amount: amountOf(row),
    usageDate: row.as_of,
    paymentType: row.payment_type,
    statementPeriod: row.statement_period,
    // The row's own capture: a MyJCB snapshot is one ledger artifact, so this
    // is the `fetched_at` its relative `detailMonth-N` label is resolved from.
    capturedAt: row.snapshot_fetched_at,
    providerSaleCode: row.provider_sale_code,
    usageAmountText: row.usage_amount_text,
    paymentAmountText: row.payment_amount_text,
    newestRepresentation: true,
  };
}
