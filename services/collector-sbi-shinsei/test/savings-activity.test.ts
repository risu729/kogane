import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseSavingsHistory, savingsRetention } from "../src/savings-activity";
import { buildSharedRunPlan } from "../src/shared-collection";
import { validateKnownResponse } from "../src/response-schemas";

const fixture = () =>
  JSON.parse(
    readFileSync(
      `${import.meta.dir}/../../../tests/fixtures/observation-pipeline/sbi-shinsei-parser-boundaries/savings-activity.json`,
      "utf8",
    ),
  );
const inventory = (scope: any) => ({
  responseParam: { overview: { responseParam: { savingsDetails: [scope] } } },
});
const handoff = (input: any) => ({
  fromDate: input.scope.fromDate,
  toDate: input.scope.toDate,
  accounts: [
    {
      accountNo: input.scope.accountNo,
      currency: input.scope.currency,
      productCode: input.scope.productCode,
      raw: JSON.stringify(input.response),
    },
  ],
});

test("uses the first day of the same month two years earlier and Tokyo's current day", () => {
  expect(savingsRetention(new Date("2099-01-31T15:00:00Z"))).toEqual({
    fromDate: "20970201",
    toDate: "20990201",
  });
});

test("binds each provider response to the complete inventory and retains raw/derived lineage", async () => {
  const input = fixture();
  const result = parseSavingsHistory(
    handoff(input),
    inventory(input.scope),
    new Date("2099-01-15T03:00:00Z"),
  );
  expect(result.failures).toEqual([]);
  expect(result.artifacts.map((a) => a.filename)).toEqual([
    "raw-period-activity-0001.json",
    "savings-activity-0001.json",
  ]);
  const plan = await buildSharedRunPlan({
    artifacts: [
      ...result.artifacts,
      {
        dataset: "top-accounts-balance-and-activity",
        filename: "raw-top-accounts-balance-and-activity.json",
        mediaType: "application/json",
        body: JSON.stringify(inventory(input.scope)),
      },
    ],
    manifest: {
      schemaVersion: "synthetic-v1",
      source: "sbi-shinsei",
      runId: "synthetic-run",
      startedAt: "2099-01-15T03:00:00Z",
      completedAt: "2099-01-15T03:01:00Z",
      liveReadsEnabled: true,
      status: "success",
      failures: [],
      artifacts: [],
    },
    identity: { attemptId: "synthetic-attempt" },
  });
  expect(plan.run.units).toMatchObject([{ coverageStatus: "complete", artifactCount: 2 }]);
  expect(plan.run.ranges).toMatchObject([
    { rangeKind: "requested", startValue: "2097-01-01", endValue: "2099-01-15" },
    { rangeKind: "declared_coverage" },
  ]);
  expect(plan.run.reports).toMatchObject([{ scope: "unit", outcome: "success" }]);
  expect(plan.artifacts[0]!.role).toBe("sanitized_provider_capture");
  expect(plan.artifacts[1]!.role).toBe("collector_derived");
  expect(plan.run.transformations[1]).toMatchObject({
    stepKind: "extracted",
    inputArtifactKeys: [
      "raw-period-activity-0001.json",
      "raw-top-accounts-balance-and-activity.json",
    ],
    outputArtifactKey: "savings-activity-0001.json",
  });
});

test("unknown status and context mismatch remain a partial account with closed diagnostics", async () => {
  const input = fixture();
  input.response.responseParam.activity.errorInfo.statusID = "99999";
  expect(() => validateKnownResponse("sbi-shinsei-period-activity-v1", input.response)).toThrow();
  const result = parseSavingsHistory(
    handoff(input),
    inventory(input.scope),
    new Date("2099-01-15T03:00:00Z"),
  );
  expect(result.artifacts).toHaveLength(0);
  expect(result.failures).toMatchObject([
    {
      operation: "read:history-0001",
      errorType: "ResponseSchemaError",
      message: "provider_response_invalid",
    },
  ]);
  const plan = await buildSharedRunPlan({
    artifacts: [],
    manifest: {
      schemaVersion: "synthetic-v1",
      source: "sbi-shinsei",
      runId: "synthetic-failed-run",
      startedAt: "2099-01-15T03:00:00Z",
      completedAt: "2099-01-15T03:01:00Z",
      liveReadsEnabled: true,
      status: "partial",
      failures: result.failures,
      artifacts: [],
    },
    identity: { attemptId: "synthetic-failed-attempt" },
  });
  expect(plan.run.units).toMatchObject([
    { artifactCount: 0, coverageStatus: "partial", safeErrorCode: "provider_response_invalid" },
  ]);
  expect(plan.run.reports).toMatchObject([
    { scope: "unit", outcome: "partial", safeErrorCode: "provider_response_invalid" },
  ]);
  expect(plan.run.ranges).toHaveLength(1);
  expect(JSON.stringify(plan.run)).not.toContain(input.scope.accountNo);
  const manifest = plan.artifacts.find((artifact) => artifact.artifactKey === "manifest.json")!;
  expect(manifest.body.kind).toBe("bytes");
  if (manifest.body.kind === "bytes")
    expect(new TextDecoder().decode(manifest.body.bytes)).not.toContain(input.scope.accountNo);
  const missing = handoff(input);
  missing.accounts = [];
  expect(() =>
    parseSavingsHistory(missing, inventory(input.scope), new Date("2099-01-15T03:00:00Z")),
  ).toThrow();
});
