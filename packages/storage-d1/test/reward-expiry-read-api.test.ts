// A synthetic READ snapshot served by `rewardExpiryFromRead`.
//
// The published projection always consumes the unclassified history, so it
// cannot store a calculated date beside `history_incomplete`. This file writes
// three synthetic estimate rows, as stored JSON, and reads them back through
// the exported route function. It does not call `estimateExpiry`. No Access
// token, no worker flag and no provider call.
//
// `Env` is ambient in the App project. Naming it here lets this package's
// typecheck load the route module, which only mentions `Env` as a parameter.
import type { D1Like as ReadModelD1 } from "../../read-model/src/d1.ts";

declare global {
  interface Env {
    DB: ReadModelD1;
  }
}

import { describe, expect, test } from "bun:test";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import {
  EXPIRY_DERIVATION_RELEASE,
  validBucketExpiryBasis,
  type BucketExpiryBasis,
  type ExpiryRuleBasis,
} from "../../domain/src/rewards.ts";
import type { LocalDateValue, TemporalValue } from "../../domain/src/time.ts";
import {
  REWARD_EVALUATION_CALENDAR,
  REWARD_PROJECTION_RELEASE,
} from "../../read-model/src/index.ts";
import type { RewardExpiryProjectionRow } from "../../read-model/src/reward-projection.ts";
import {
  beginRewardSnapshot,
  claimRewardWriterLease,
  ensureReadInstance,
  readContentKey,
  rewardEstimateDigest,
  rewardSnapshot,
  rewardWriterFence,
  sealAndPublishRewardSnapshot,
  writeRewardEstimateChunk,
  type RewardSnapshotPlan,
} from "../src/read/index.ts";
import {
  rewardExpiryFromRead,
  type RewardReadContext,
} from "../../../services/app/src/rewards-read.ts";
import { createSqliteReadDatabase } from "./sqlite-read-database.ts";

const TOKYO = "Asia/Tokyo";
const EVALUATED_AT = "2026-09-11T00:00:00.000Z";
const NOW = EVALUATED_AT;
const PROGRAM = "program:synthetic";
const HOLDING_REF = "holding:synthetic";
const RULE_ID = "rule:synthetic:inactivity";
const RULE_VERSION = "v1";
const RULE_REF = `${RULE_ID}@${RULE_VERSION}`;

const day = (value: string): LocalDateValue => ({
  kind: "local-date",
  value,
  zone: TOKYO,
  basis: "provider",
});

const derived = (value: string): LocalDateValue => ({ ...day(value), basis: "derived" });

const ruleBasis: ExpiryRuleBasis = {
  ruleRef: RULE_REF,
  ruleId: RULE_ID,
  version: RULE_VERSION,
  family: "inactivity",
  verification: "verified",
  validPeriod: null,
  evidenceRefs: ["evidence:synthetic-terms:1"],
  qualifyingActivityPolicyRef: "policy:synthetic:qualifying-activity:v1",
  deadlineCalendar: { zone: TOKYO, dayBoundary: "end-of-day", zoneBasis: "documented" },
};

/** A stored basis, not a call to `estimateExpiry`. The route must echo it. */
const datedBasis: BucketExpiryBasis = {
  displayed: {
    value: day("2026-12-31"),
    observedAt: day("2026-09-01"),
    sourceFactRefs: ["fact:bucket:dated"],
  },
  computed: {
    status: "date",
    value: derived("2027-03-01"),
    reasonCode: null,
    rule: ruleBasis,
    activity: {
      windowRef: "window:synthetic",
      completeness: "partial",
      earliestObserved: day("2026-01-01"),
      anchorActivityRef: "act:earn-1",
      anchorDate: derived("2026-03-01"),
    },
    membership: null,
    uncertaintyCodes: ["history_incomplete"],
    release: EXPIRY_DERIVATION_RELEASE,
  },
  agreement: "disagree",
};

const unknownBasis: BucketExpiryBasis = {
  displayed: {
    value: day("2026-11-30"),
    observedAt: day("2026-09-01"),
    sourceFactRefs: ["fact:bucket:unknown"],
  },
  computed: {
    status: "unavailable",
    value: null,
    reasonCode: "history_completeness_unknown",
    rule: ruleBasis,
    activity: {
      windowRef: "window:synthetic",
      completeness: "unknown",
      earliestObserved: null,
      anchorActivityRef: null,
      anchorDate: null,
    },
    membership: null,
    uncertaintyCodes: [],
    release: EXPIRY_DERIVATION_RELEASE,
  },
  agreement: "not-comparable",
};

function storedRow(
  seq: number,
  bucketRef: string,
  basis: BucketExpiryBasis,
  fields: {
    state: RewardExpiryProjectionRow["state"];
    deadlineBasis: RewardExpiryProjectionRow["deadlineBasis"];
    expiresOn: string | null;
    providerObserved: TemporalValue | null;
    policyEstimated: TemporalValue | null;
    reasonCodes: string[];
    uncertaintyCodes: string[];
  },
): RewardExpiryProjectionRow {
  return {
    rowKey: `${HOLDING_REF}|${RULE_REF}|${bucketRef}`,
    rowSeq: seq,
    programId: PROGRAM,
    holdingRef: HOLDING_REF,
    bucketRef,
    ruleId: RULE_ID,
    ruleVersion: RULE_VERSION,
    bucketKind: "regular",
    amountCoefficient: "1000",
    amountScale: 0,
    amountStatus: "exact",
    unitRef: "points:synthetic",
    basisRefs: [`fact:${bucketRef}`],
    expiryBasis: basis,
    ...fields,
  };
}

interface ExpiryBody {
  rows: {
    bucketRef: string;
    expiresOn: string | null;
    basis: string;
    providerObserved: TemporalValue | null;
    policyEstimated: TemporalValue | null;
    reasonCodes: string[];
    uncertaintyCodes: string[];
    expiryBasis: BucketExpiryBasis | null;
  }[];
  page: { hasMore: boolean; nextCursor: string | null };
  snapshot: { snapshotId: string; evaluatedAt: string; evaluationCalendar: string };
}

describe("READ expiry keeps the two dates and the history reasons apart", () => {
  test("a published snapshot returns the stored basis unchanged, and an invalid basis stays null", async () => {
    const invalidBasis: BucketExpiryBasis = {
      ...datedBasis,
      displayed: {
        ...datedBasis.displayed!,
        sourceFactRefs: ["fact:bucket:dated", "fact:bucket:dated"],
      },
    };
    expect(validBucketExpiryBasis(datedBasis)).toBe(true);
    expect(validBucketExpiryBasis(unknownBasis)).toBe(true);
    expect(validBucketExpiryBasis(invalidBasis)).toBe(false);

    const rows = [
      storedRow(0, "bucket:dated", datedBasis, {
        state: "conflict",
        deadlineBasis: "provider-observed",
        expiresOn: "2026-12-31",
        providerObserved: day("2026-12-31"),
        policyEstimated: derived("2027-03-01"),
        reasonCodes: ["provider_and_policy_differ"],
        uncertaintyCodes: ["history_incomplete"],
      }),
      storedRow(1, "bucket:unknown", unknownBasis, {
        state: "partial",
        deadlineBasis: "provider-observed",
        expiresOn: "2026-11-30",
        providerObserved: day("2026-11-30"),
        policyEstimated: null,
        reasonCodes: ["history_completeness_unknown", "provider_expiry_only"],
        uncertaintyCodes: ["history_completeness_unknown"],
      }),
      storedRow(2, "bucket:invalid", invalidBasis, {
        state: "conflict",
        deadlineBasis: "provider-observed",
        expiresOn: "2028-01-15",
        providerObserved: day("2028-01-15"),
        policyEstimated: derived("2028-06-01"),
        reasonCodes: ["provider_and_policy_differ"],
        uncertaintyCodes: [],
      }),
    ];
    const digested = [];
    for (const row of rows) digested.push({ row, digest: await rewardEstimateDigest(row) });

    const { d1: db } = createSqliteReadDatabase();
    const instance = await ensureReadInstance(db, NOW, "reward-instance-expiry");
    const inputDigest = "3".repeat(64);
    const buildDigest = "4".repeat(64);
    const plan: RewardSnapshotPlan = {
      contentKey: await readContentKey(inputDigest, buildDigest),
      inputDigest,
      buildDigest,
      contractVersion: "reward-projection-input-v1",
      evaluatedAt: EVALUATED_AT,
      calendarRuleId: REWARD_EVALUATION_CALENDAR,
      ruleSetDigest: "c".repeat(64),
      ruleCount: 1,
      claimsRelease: "reward-promotion-v1",
      claimsHighWater: 3,
      sourceRevision: 10,
      visibilityRevision: 3,
      coreEpoch: "core-epoch-1",
      inputManifestJson: JSON.stringify({ evaluatedAt: EVALUATED_AT }),
      policyRelease: REWARD_PROJECTION_RELEASE,
      inputRefs: [
        { kind: "expiry_rule", id: RULE_REF, digest: "d".repeat(64) },
        { kind: "evaluation_clock", id: EVALUATED_AT, digest: "e".repeat(64) },
      ],
    };
    const started = await beginRewardSnapshot(db, instance.read_instance_id, plan, NOW);
    if (!started) throw new Error("snapshot did not start");
    const lease = "lease-expiry";
    expect(await claimRewardWriterLease(db, started.snapshotId, lease, 1_000, 60_000)).toBe(true);
    const fence = await rewardWriterFence(db, started.snapshotId, lease);
    if (fence === null) throw new Error("lease was not held");
    expect(
      await writeRewardEstimateChunk(db, started.snapshotId, digested, {
        lease,
        fence,
        now: NOW,
        rowsWritten: 0,
      }),
    ).toBe("written");
    const sealed = await sealAndPublishRewardSnapshot(
      db,
      {
        snapshotId: started.snapshotId,
        readInstanceId: instance.read_instance_id,
        sourceRevision: plan.sourceRevision,
        visibilityRevision: plan.visibilityRevision,
        coreEpoch: plan.coreEpoch,
        evaluatedAt: plan.evaluatedAt,
      },
      {
        estimateCount: digested.length,
        simulationCount: 0,
        rowDigests: digested.map((entry) => entry.digest),
      },
      { lease, now: NOW },
    );
    expect(sealed.published).toBe(true);
    const snapshot = await rewardSnapshot(db, started.snapshotId);
    if (!snapshot) throw new Error("published snapshot was not readable");
    const context: RewardReadContext = {
      read: db,
      readInstanceId: instance.read_instance_id,
      snapshot,
    };
    const response = await rewardExpiryFromRead(
      context,
      new URL("https://fixture.test/api/v2/rewards/expiry"),
      PROGRAM,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ExpiryBody;
    expect(body.snapshot.snapshotId).toBe(started.snapshotId);
    expect(body.snapshot.evaluatedAt).toBe(EVALUATED_AT);
    expect(body.snapshot.evaluationCalendar).toBe(REWARD_EVALUATION_CALENDAR);
    expect(body.page.hasMore).toBe(false);
    expect(body.page.nextCursor).toBeNull();
    expect(body.rows.map((row) => row.bucketRef)).toEqual([
      "bucket:dated",
      "bucket:unknown",
      "bucket:invalid",
    ]);

    const calendarDay = (value: TemporalValue | null) =>
      value?.kind === "local-date" ? value.value : null;
    const datedOut = body.rows[0]!;
    expect(datedOut.expiryBasis).toEqual(datedBasis);
    expect(calendarDay(datedOut.providerObserved)).toBe("2026-12-31");
    expect(calendarDay(datedOut.policyEstimated)).toBe("2027-03-01");
    expect(calendarDay(datedOut.providerObserved)).not.toBe(calendarDay(datedOut.policyEstimated));
    expect(datedOut.expiresOn).toBe("2026-12-31");
    expect(datedOut.basis).toBe("provider-observed");
    expect(datedOut.uncertaintyCodes).toEqual(["history_incomplete"]);
    expect(datedOut.reasonCodes).toEqual(["provider_and_policy_differ"]);
    expect(datedOut.expiryBasis?.computed.status).toBe("date");
    expect(datedOut.expiryBasis?.computed.reasonCode).toBeNull();

    const unknownOut = body.rows[1]!;
    expect(unknownOut.expiryBasis).toEqual(unknownBasis);
    expect(calendarDay(unknownOut.providerObserved)).toBe("2026-11-30");
    expect(unknownOut.policyEstimated).toBeNull();
    expect(unknownOut.expiryBasis?.computed.value).toBeNull();
    expect(unknownOut.expiryBasis?.computed.reasonCode).toBe("history_completeness_unknown");
    expect(unknownOut.expiryBasis?.computed.uncertaintyCodes).toEqual([]);
    expect(unknownOut.uncertaintyCodes).toEqual(["history_completeness_unknown"]);
    expect(unknownOut.reasonCodes).toEqual([
      "history_completeness_unknown",
      "provider_expiry_only",
    ]);

    const invalidOut = body.rows[2]!;
    expect(invalidOut.expiryBasis).toBeNull();
    expect(invalidOut.providerObserved).toEqual(day("2028-01-15"));
    expect(invalidOut.policyEstimated).toEqual({
      kind: "local-date",
      value: "2028-06-01",
      zone: TOKYO,
      basis: "derived",
    });
    expect(invalidOut.expiresOn).toBe("2028-01-15");
    // The served page is the shared contract: an invalid basis is null in it,
    // not a value the response check has to reject.
    expect(validApiResponse("/api/v2/rewards/expiry", body)).toBe(true);
  });
});
