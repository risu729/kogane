// The amount at risk on an expiry estimate row of the published reward
// snapshot (`GET /api/v2/rewards/expiry`, services/app/src/rewards-read.ts).
// READ 0002 and 0004 CHECK that a row is `exact` exactly when both decimal-v1
// columns are set (packages/storage-d1/test/reward-read-writer.test.ts proves
// the table refuses the other pairings), so a pairing that CHECK refuses is a
// READ store the schema never admits: the read fails rather than serving a
// value nobody stored or an `exact` status with a reason. A status that is not
// exact with one stray column is admitted, and keeps its reason. The rows come from a stand-in
// READ database that returns them as given. Every value is synthetic.
import { describe, expect, it } from "vitest";
import type { D1Like, RewardEstimateRow } from "../../../packages/storage-d1/src/read/index";
import { rewardExpiryFromRead, type RewardReadContext } from "../src/rewards-read";

const row = (overrides: Partial<RewardEstimateRow>): RewardEstimateRow => ({
  snapshot_id: "snapshot-synthetic",
  row_key: "holding:x|rule:x@v1|bucket:x",
  row_seq: 0,
  program_id: "program:synthetic",
  holding_ref: "holding:x",
  bucket_ref: "bucket:x",
  rule_id: "rule:x",
  rule_version: "v1",
  bucket_kind: "regular",
  state: "partial",
  deadline_basis: "unknown",
  expires_on: null,
  amount_coefficient: "500",
  amount_scale: 0,
  amount_status: "exact",
  unit_ref: "points:synthetic",
  provider_observed_json: null,
  policy_estimated_json: null,
  reason_codes_json: "[]",
  uncertainty_codes_json: "[]",
  basis_refs_json: "[]",
  row_digest: "a".repeat(64),
  expiry_basis_json: null,
  ...overrides,
});

/** A READ database whose estimate page is `rows`, with no provider display sections. */
function readOf(rows: RewardEstimateRow[]): D1Like {
  return {
    prepare(sql: string) {
      const statement = {
        bind: () => statement,
        all: async () => ({
          results: sql.includes("FROM reward_expiry_estimates_v2") ? rows : [],
        }),
        first: async () => null,
        run: async () => ({ meta: { changes: 0 } }),
        raw: async () => [],
      };
      return statement;
    },
    batch: async () => [],
  } as unknown as D1Like;
}

async function quantitiesOf(rows: RewardEstimateRow[]) {
  const context = {
    read: readOf(rows),
    readInstanceId: "read-instance-synthetic",
    snapshot: { snapshot_id: "snapshot-synthetic" },
    revision: { coreEpoch: "epoch-synthetic", visibilityRevision: 1 },
  } as unknown as RewardReadContext;
  const page = (await rewardExpiryFromRead(
    context,
    new URL("https://fixture.test/"),
    undefined,
  )) as {
    rows: { quantity: unknown }[];
  };
  return page.rows.map((entry) => entry.quantity);
}

describe("the amount at risk on a reward expiry row", () => {
  it("is exact with its decimal-v1 value, or its status with a decimal-v1 reason", async () => {
    expect(
      await quantitiesOf([
        row({}),
        row({ amount_status: "unparsed", amount_coefficient: null, amount_scale: null }),
        row({ amount_status: "missing", amount_coefficient: null, amount_scale: null }),
        // The CHECK admits a status that is not exact with one column; the
        // writer never stores it, and the stray column is never a value.
        row({ amount_status: "conflict", amount_coefficient: "500", amount_scale: null }),
        row({ amount_status: "missing", amount_coefficient: null, amount_scale: 0 }),
      ]),
    ).toEqual([
      {
        unitRef: "points:synthetic",
        value: {
          status: "exact",
          value: { coefficient: "500", scale: 0 },
          normalizationVersion: "decimal-v1",
        },
      },
      {
        unitRef: "points:synthetic",
        value: { status: "unparsed", reasonCode: "decimal-v1:unparsed" },
      },
      {
        unitRef: "points:synthetic",
        value: { status: "missing", reasonCode: "decimal-v1:missing" },
      },
      {
        unitRef: "points:synthetic",
        value: { status: "conflict", reasonCode: "decimal-v1:conflict" },
      },
      {
        unitRef: "points:synthetic",
        value: { status: "missing", reasonCode: "decimal-v1:missing" },
      },
    ]);
  });

  it("refuses a pairing the READ schema never stores, never an exact status with a reason", async () => {
    for (const stored of [
      // `exact` without its columns: once served as `{status: "exact", reasonCode}`.
      row({ amount_coefficient: null, amount_scale: null }),
      row({ amount_coefficient: null }),
      // `exact` with a coefficient and no scale: once served with a null scale.
      row({ amount_scale: null }),
      // A status that is not exact but keeps both columns, a value.
      row({ amount_status: "missing" }),
      // A status outside decimal-v1.
      row({ amount_status: "estimated", amount_coefficient: null, amount_scale: null }),
    ])
      await expect(quantitiesOf([stored])).rejects.toThrow("reward_estimate_amount_invalid");
  });

  it("serves exactly the pairings the READ CHECK admits, over every status and column", async () => {
    // READ 0002 and 0004, written out: the status is one of the four, and
    // `(amount_status='exact') = (amount_coefficient IS NOT NULL AND amount_scale IS NOT NULL)`.
    const admitted = (status: string, coefficient: string | null, scale: number | null) =>
      ["exact", "missing", "unparsed", "conflict"].includes(status) &&
      (status === "exact") === (coefficient !== null && scale !== null);
    let cells = 0;
    for (const status of ["exact", "missing", "unparsed", "conflict", "estimated"])
      for (const coefficient of [null, "500"])
        for (const scale of [null, 0]) {
          cells++;
          const stored = row({
            amount_status: status,
            amount_coefficient: coefficient,
            amount_scale: scale,
          });
          if (!admitted(status, coefficient, scale)) {
            await expect(quantitiesOf([stored])).rejects.toThrow("reward_estimate_amount_invalid");
            continue;
          }
          // An admitted row is its value when exact, else its status and
          // reason: a stray column is never shown.
          expect(await quantitiesOf([stored])).toEqual([
            status === "exact"
              ? {
                  unitRef: "points:synthetic",
                  value: {
                    status: "exact",
                    value: { coefficient: "500", scale: 0 },
                    normalizationVersion: "decimal-v1",
                  },
                }
              : {
                  unitRef: "points:synthetic",
                  value: { status, reasonCode: `decimal-v1:${status}` },
                },
          ]);
        }
    expect(cells).toBe(20);
  });
});
