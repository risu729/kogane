// The pure half of the operations services (02 §4-5, U06): how a request is
// identified, what a stage list means, and what a session policy grants. The
// SQL half is exercised against the real migrations in
// services/evidence-browser/test/ops-api.test.ts.
import { expect, test } from "bun:test";
import {
  OPERATION_KINDS,
  OPERATION_STAGES,
  operationIdFor,
  operationPayloadDigest,
  sessionRefreshPolicy,
  STAGES_BY_KIND,
} from "../src/index.ts";

const COLLECTION = {
  source: "sony-bank",
  requestedScope: { from: "2026-01-01", to: "2026-01-31" },
};

test("the same request is the same operation, whoever sent it twice (G3-06)", async () => {
  const digest = await operationPayloadDigest("collection", COLLECTION);
  // The key never changes what was asked for, so a retry under a key and the
  // first send of the same payload agree on the payload digest.
  expect(await operationPayloadDigest("collection", { ...COLLECTION, idempotencyKey: "a" })).toBe(
    digest,
  );
  // Key order does not change it either; a different value does.
  expect(
    await operationPayloadDigest("collection", {
      requestedScope: { to: "2026-01-31", from: "2026-01-01" },
      source: "sony-bank",
    }),
  ).toBe(digest);
  expect(
    await operationPayloadDigest("collection", {
      ...COLLECTION,
      requestedScope: { from: "2026-01-01", to: "2026-02-01" },
    }),
  ).not.toBe(digest);
  // The same payload under a different kind is a different operation.
  expect(await operationPayloadDigest("import", { source: "sony-bank", runId: "r" })).not.toBe(
    digest,
  );
});

test("an operation id is bound to its principal", async () => {
  const mine = await operationIdFor("collection", "operator-a", "nightly");
  expect(mine).toMatch(/^op_[0-9a-f]{64}$/u);
  expect(await operationIdFor("collection", "operator-a", "nightly")).toBe(mine);
  // Two principals sending the same key hold two operations, so one caller's
  // retry key can never address another caller's work.
  expect(await operationIdFor("collection", "operator-b", "nightly")).not.toBe(mine);
  expect(await operationIdFor("projection", "operator-a", "nightly")).not.toBe(mine);
});

test("every kind reports the stages it can actually reach, in contract order", () => {
  for (const kind of OPERATION_KINDS) {
    const stages = STAGES_BY_KIND[kind];
    // Only names from contracts/stages.json, in its order, without repeats.
    expect(stages.every((stage) => OPERATION_STAGES.includes(stage))).toBe(true);
    expect(
      [...stages].sort((a, b) => OPERATION_STAGES.indexOf(a) - OPERATION_STAGES.indexOf(b)),
    ).toEqual([...stages]);
    expect(new Set(stages).size).toBe(stages.length);
  }
  // A replay does not re-persist or re-register evidence, and a rebuild only
  // republishes: claiming those stages would claim progress nobody made.
  expect(STAGES_BY_KIND.collection).toEqual([...OPERATION_STAGES]);
  expect(STAGES_BY_KIND.replay).toEqual(["parsed", "adopted", "projected"]);
  expect(STAGES_BY_KIND.projection).toEqual(["projected"]);
  expect(STAGES_BY_KIND["session-refresh"]).toEqual([]);
});

test("a session refresh needs a person unless the deployment says otherwise (G3-11)", () => {
  // Absent, empty, malformed, wrong shape, or a mode nobody defined: a human.
  for (const configured of [
    undefined,
    "",
    "not json",
    "[]",
    '"unattended"',
    '{"sony-bank":"automatic"}',
    '{"sony-bank":true}',
  ])
    expect(sessionRefreshPolicy(configured)("sony-bank")).toBe("human");
  const policy = sessionRefreshPolicy('{"sony-bank":"unattended"}');
  expect(policy("sony-bank")).toBe("unattended");
  // Naming one source never grants another.
  expect(policy("other-test")).toBe("human");
});
