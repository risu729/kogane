import { describe, expect, test } from "bun:test";
import {
  COLLECTION_STAGES,
  JOB_OUTCOMES,
  NEVER_COMPLETE_ON,
  registrationIdempotencyKey,
  stageRecord,
  StageContractError,
} from "../src/stages";
import { PROVIDER_OUTCOMES } from "../src/manifest";

describe("stage contract", () => {
  test("matches contracts/stages.json", () => {
    expect([...COLLECTION_STAGES]).toEqual([
      "persisted",
      "registered",
      "parsed",
      "adopted",
      "projected",
    ]);
    expect([...JOB_OUTCOMES]).toEqual(["pending", "completed", "retryable", "blocked"]);
    expect([...NEVER_COMPLETE_ON]).toEqual(["queued", "building", "flag_off", "no_processor"]);
    expect([...PROVIDER_OUTCOMES]).toEqual(["success", "partial", "failed"]);
  });

  test("the four non-completion reasons can never be recorded as completed", () => {
    for (const reason of NEVER_COMPLETE_ON) {
      expect(() => stageRecord("registered", "completed", reason)).toThrow(StageContractError);
      expect(stageRecord("registered", "pending", reason)).toEqual({
        stage: "registered",
        outcome: "pending",
        reasonCode: reason,
      });
    }
    expect(stageRecord("persisted", "completed")).toEqual({
      stage: "persisted",
      outcome: "completed",
    });
  });

  test("idempotency is run identity plus digest plus processing contract", () => {
    const base = {
      source: "kogane-synthetic",
      runId: "run-001",
      terminalDigest: "a".repeat(64),
      registrationContractVersion: "registration-v1",
    };
    expect(registrationIdempotencyKey(base)).toBe(
      `kogane-synthetic run-001 ${"a".repeat(64)} registration-v1`,
    );
    // A changed ingest contract is a new registration, not a reuse.
    expect(
      registrationIdempotencyKey({ ...base, registrationContractVersion: "registration-v2" }),
    ).not.toBe(registrationIdempotencyKey(base));
    // A second delivery of the same terminal is the same key.
    expect(registrationIdempotencyKey({ ...base })).toBe(registrationIdempotencyKey(base));
  });
});
