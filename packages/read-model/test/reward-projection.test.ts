// The reward projection connects the stored buckets to the expiry derivation
// only where the stored rules allow it (ADR 0049). The rules and programmes
// are read from the CORE migrations exactly as seeded; every bucket, quantity,
// date and reference below is synthetic.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTED_EXPIRY_REASONS, validBucketExpiryBasis } from "../../domain/src/rewards.ts";
import type { TemporalValue } from "../../domain/src/time.ts";
import {
  buildRewardProjection,
  REWARD_PROJECTION_RELEASE,
  UNCLASSIFIED_REWARD_HISTORY,
  type RewardExpiryProjectionRow,
  type RewardProjectionInputContent,
} from "../src/reward-projection.ts";
import {
  EXPIRY_RULES_SQL,
  type ExpiryRuleSqlRow,
  type RewardBucketSqlRow,
} from "../src/rewards.ts";
import { fromTemplate } from "./schema-template";

const MIGRATIONS = join(import.meta.dir, "../../../packages/storage-d1/migrations/core");

function migratedDatabase(): Database {
  return fromTemplate("core", () => {
    const db = new Database(":memory:");
    for (const name of readdirSync(MIGRATIONS)
      .filter((entry) => entry.endsWith(".sql"))
      .sort())
      db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
    return db;
  });
}

interface ProgramRow {
  program_id: string;
  institution_ref: string;
  program_ref: string;
  source_id: string;
  unit_ref: string;
  holding_kind: string;
  terms_evidence_refs_json: string;
  release_id: string;
}

let rules: ExpiryRuleSqlRow[] = [];
let programs = new Map<string, ProgramRow>();

beforeAll(() => {
  const db = migratedDatabase();
  rules = db.query(EXPIRY_RULES_SQL).all(null) as ExpiryRuleSqlRow[];
  programs = new Map(
    (db.query("SELECT * FROM reward_programs").all() as ProgramRow[]).map((row) => [
      row.program_id,
      row,
    ]),
  );
  db.close();
}, 60_000);

let nextId = 0;
function bucketRow(
  programId: string,
  holdingRef: string,
  slot: string,
  kind: string,
  quantity: { coefficient: string; scale: number } | "unparsed" | "missing",
  observedExpiry: unknown,
): RewardBucketSqlRow {
  const program = programs.get(programId)!;
  nextId += 1;
  return {
    id: nextId,
    program_id: programId,
    holding_ref: holdingRef,
    bucket_ref: `${programId}:${slot}`,
    bucket_kind: kind,
    restriction_refs_json: "[]",
    unit_ref: program.unit_ref,
    quantity_coefficient: typeof quantity === "string" ? null : quantity.coefficient,
    quantity_scale: typeof quantity === "string" ? null : quantity.scale,
    quantity_status: typeof quantity === "string" ? quantity : "exact",
    observed_expiry_json: observedExpiry === null ? null : JSON.stringify(observedExpiry),
    observed_at: "2026-09-01T00:00:00.000Z",
    parse_run_id: 1,
    source_fact_kind: "balance",
    source_fact_id: 100 + nextId,
    institution_ref: program.institution_ref,
    program_ref: program.program_ref,
    source_id: program.source_id,
    program_unit_ref: program.unit_ref,
    holding_kind: program.holding_kind,
    terms_evidence_refs_json: program.terms_evidence_refs_json,
    release_id: program.release_id,
  };
}

const DISPLAYED: TemporalValue = {
  kind: "local-date",
  value: "2026-12-31",
  zone: "Asia/Tokyo",
  basis: "provider",
};
const UNREADABLE: TemporalValue = { kind: "unknown", reasonCode: "provider_expiry_unparsed" };

function projection(ruleRows: ExpiryRuleSqlRow[] = rules): RewardExpiryProjectionRow[] {
  const buckets = [
    bucketRow(
      "program:v-point",
      "program:v-point:member",
      "regular",
      "regular",
      { coefficient: "1200", scale: 0 },
      null,
    ),
    bucketRow(
      "program:v-point",
      "program:v-point:member",
      "dated",
      "time-limited",
      { coefficient: "300", scale: 0 },
      DISPLAYED,
    ),
    bucketRow(
      "program:v-point",
      "program:v-point:member",
      "store",
      "restricted",
      "unparsed",
      UNREADABLE,
    ),
    bucketRow(
      "program:v-point-pay",
      "program:v-point-pay:prepaid-yen",
      "prepaid",
      "regular",
      { coefficient: "500", scale: 0 },
      null,
    ),
    bucketRow(
      "program:mobile-suica-sf",
      "program:mobile-suica-sf:sf",
      "sf",
      "regular",
      "missing",
      null,
    ),
  ];
  const content: RewardProjectionInputContent = {
    manifest: {
      evaluatedAt: "2026-09-12T00:00:00.000Z",
      evaluationCalendar: "UTC:start-of-day:assumed",
      promotionRelease: "reward-promotion-v1",
      policyRelease: REWARD_PROJECTION_RELEASE,
      claimsHighWater: nextId,
      ruleCount: ruleRows.length,
      bucketCount: buckets.length,
      membershipCount: 0,
      offerCount: 0,
      simulationCount: 0,
    },
    rules: ruleRows,
    buckets,
    membership: [],
    offers: [],
    simulations: [],
  };
  return buildRewardProjection(content).estimates;
}

const row = (rows: RewardExpiryProjectionRow[], ruleId: string, slot: string) =>
  rows.find((entry) => entry.ruleId === ruleId && entry.bucketRef.endsWith(`:${slot}`))!;

describe("the stored buckets against the seeded rules", () => {
  test("the seeded rules are the four the repository records, and only the V Point pair is verified", () => {
    expect(
      rules.map((rule) => [rule.rule_id, rule.version, rule.family, rule.verification]),
    ).toEqual([
      ["rule:mobile-suica-sf:validity", "v1", "unsupported", "needs-rule-verification"],
      ["rule:v-point:fixed-expiry-lot", "v1", "fixed-lot", "verified"],
      ["rule:v-point:regular-inactivity", "v1", "inactivity", "verified"],
      ["rule:v-point-pay:prepaid-validity", "v1", "unsupported", "needs-rule-verification"],
    ]);
  });

  test("every bucket is listed under every rule of its programme, each with a valid basis", () => {
    const rows = projection();
    // V Point: three buckets under two rules; V Point Pay and Suica: one each.
    expect(rows).toHaveLength(8);
    for (const entry of rows) expect(validBucketExpiryBasis(entry.expiryBasis)).toBe(true);
  });

  test("no stored rule yields a computed date today: each computed side names its reason", () => {
    const rows = projection();
    const computed = rows.map((entry) => [
      entry.ruleId,
      entry.bucketRef.split(":").at(-1),
      entry.expiryBasis.computed.status,
      entry.expiryBasis.computed.reasonCode,
    ]);
    expect(computed).toEqual([
      ["rule:mobile-suica-sf:validity", "sf", "unavailable", "rule_not_verified"],
      ["rule:v-point-pay:prepaid-validity", "prepaid", "unavailable", "rule_not_verified"],
      ["rule:v-point:fixed-expiry-lot", "dated", "unavailable", "fixed_deadline_not_derivable"],
      ["rule:v-point:fixed-expiry-lot", "regular", "unavailable", "rule_bucket_kind_not_covered"],
      ["rule:v-point:fixed-expiry-lot", "store", "unavailable", "fixed_deadline_not_derivable"],
      ["rule:v-point:regular-inactivity", "dated", "unavailable", "rule_bucket_kind_not_covered"],
      [
        "rule:v-point:regular-inactivity",
        "regular",
        "unavailable",
        "no_qualifying_activity_observed",
      ],
      ["rule:v-point:regular-inactivity", "store", "unavailable", "rule_bucket_kind_not_covered"],
    ]);
    for (const entry of rows) {
      expect(COMPUTED_EXPIRY_REASONS).toContain(entry.expiryBasis.computed.reasonCode!);
      expect(entry.policyEstimated).toBeNull();
    }
  });

  test("the V Point regular bucket records the verified rule and the unclassified history it could not use", () => {
    const regular = row(projection(), "rule:v-point:regular-inactivity", "regular");
    const computed = regular.expiryBasis.computed;
    expect(computed.rule).toEqual({
      ruleRef: "rule:v-point:regular-inactivity@v1",
      ruleId: "rule:v-point:regular-inactivity",
      version: "v1",
      family: "inactivity",
      verification: "verified",
      validPeriod: null,
      evidenceRefs: ["docs/sources/v-point.md#4.1"],
      qualifyingActivityPolicyRef: "policy:v-point:qualifying-activity:v1",
      deadlineCalendar: { zone: "Asia/Tokyo", dayBoundary: "end-of-day", zoneBasis: "assumed" },
    });
    expect(computed.activity).toEqual({
      windowRef: UNCLASSIFIED_REWARD_HISTORY.windowRef,
      completeness: "unknown",
      earliestObserved: null,
      anchorActivityRef: null,
      anchorDate: null,
    });
    expect(computed.uncertaintyCodes).toEqual([
      "deadline_zone_assumed",
      "history_completeness_unknown",
    ]);
    expect(regular.expiresOn).toBeNull();
    expect(regular.deadlineBasis).toBe("unknown");
    expect(regular.state).toBe("partial");
  });

  test("a dated V Point bucket keeps the provider's display as the deadline and computes nothing beside it", () => {
    const dated = row(projection(), "rule:v-point:fixed-expiry-lot", "dated");
    expect(dated.expiryBasis.displayed).toEqual({
      value: DISPLAYED,
      observedAt: {
        kind: "instant",
        value: "2026-09-01T00:00:00.000Z",
        zone: "UTC",
        basis: "collector",
      },
      sourceFactRefs: dated.basisRefs,
    });
    expect(dated.expiryBasis.agreement).toBe("not-comparable");
    expect(dated.expiresOn).toBe("2026-12-31");
    expect(dated.deadlineBasis).toBe("provider-observed");
  });

  test("an unparsed quantity and an unreadable display stay unparsed and unknown, never zero or expired", () => {
    const rows = projection().filter(
      (entry) => entry.bucketRef.endsWith(":store") || entry.bucketRef.endsWith(":sf"),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const entry of rows) {
      expect(entry.amountStatus).not.toBe("exact");
      expect(entry.amountCoefficient).toBeNull();
      expect(entry.expiresOn).toBeNull();
      expect(entry.reasonCodes).not.toContain("deadline_passed");
    }
    const store = row(projection(), "rule:v-point:fixed-expiry-lot", "store");
    expect(store.expiryBasis.displayed?.value).toEqual(UNREADABLE);
    expect(store.state).toBe("partial");
  });

  test("a programme with no stored rule computes nothing: no expiry row, never a date", () => {
    // Without a rule there is nothing to derive from; the holdings route still
    // lists the buckets with their displays (ADR 0049, consequences).
    const rows = projection(rules.filter((rule) => rule.program_id !== "program:v-point"));
    expect(rows.some((entry) => entry.programId === "program:v-point")).toBe(false);
    expect(rows.map((entry) => entry.programId).sort()).toEqual([
      "program:mobile-suica-sf",
      "program:v-point-pay",
    ]);
    for (const entry of rows) {
      expect(entry.expiryBasis.computed.status).toBe("unavailable");
      expect(entry.expiresOn).toBeNull();
    }
  });

  test("an unverified rule is never 'no expiry' and leaves the prepaid balances undated", () => {
    for (const ruleId of ["rule:v-point-pay:prepaid-validity", "rule:mobile-suica-sf:validity"]) {
      const entry = projection().find((candidate) => candidate.ruleId === ruleId)!;
      expect(entry.state).toBe("needs-rule-verification");
      expect(entry.expiryBasis.computed.status).toBe("unavailable");
      expect(entry.expiryBasis.computed.activity).toBeNull();
      expect(entry.reasonCodes).not.toContain("no_expiry_under_verified_terms");
      expect(entry.expiresOn).toBeNull();
    }
  });
});
