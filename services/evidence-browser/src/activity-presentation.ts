import type { TransactionRow } from "../../../poc/observation-pipeline/shared/api-contract";
import { classifyActivity } from "../../../poc/observation-pipeline/shared/activity-semantics";

/** Only narrowly selected parser facts from the very same B row reach the collection API. */
export async function describeActivities(
  db: D1Database,
  rows: TransactionRow[],
): Promise<TransactionRow[]> {
  if (rows.length > 501) throw new Error("activity_presentation_budget");
  const facts = new Map<number, unknown>();
  const field = (path: string) =>
    `CASE WHEN json_type(extra_json, '${path}') = 'text' AND length(json_extract(extra_json, '${path}')) BETWEEN 1 AND 256 THEN json_extract(extra_json, '${path}') ELSE NULL END`;
  const projection = `json_object('_kogane', json_object(
    'direction', ${field("$._kogane.direction")}, 'amountBasis', ${field("$._kogane.amountBasis")},
    'period', ${field("$._kogane.period")}, 'valueDate', ${field("$._kogane.valueDate")},
    'quantityText', ${field("$._kogane.quantityText")},
    'quantity', json_object('text', ${field("$._kogane.quantity.text")}, 'currency', ${field("$._kogane.quantity.currency")}),
    'price', json_object('text', ${field("$._kogane.price.text")}, 'currency', ${field("$._kogane.price.currency")})
  ))`;
  for (let offset = 0; offset < rows.length; offset += 80) {
    const ids = rows.slice(offset, offset + 80).map((row) => row.id);
    const result = await db
      .prepare(
        `SELECT id, CASE WHEN json_valid(extra_json) THEN ${projection} ELSE '{}' END AS facts FROM transaction_observations WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .bind(...ids)
      .all<{ id: number; facts: string }>();
    for (const row of result.results) facts.set(row.id, JSON.parse(row.facts));
  }
  return rows.map((row) => ({
    ...row,
    interpretation: classifyActivity({
      sourceId: row.source_id,
      parserName: row.parser.split("@")[0]!,
      status: row.status,
      extra: facts.get(row.id),
    }),
  }));
}
