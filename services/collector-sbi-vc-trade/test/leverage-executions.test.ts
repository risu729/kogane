import { describe, expect, test } from "bun:test";
import { collectSbiVcLeverageExecutions } from "../src/leverage-executions";
import { buildSharedRunPlan } from "../src/shared-collection";
import type { CollectorArtifact, SessionMaterial } from "../src/types";

const SEED: SessionMaterial = {
  cookies: {
    vctBffSid: "synthetic-sid",
    jSessionId: "synthetic-jsession",
    awsAlbApp: ["app0", "app1", "app2", "app3"],
    awsAlb: "synthetic-alb",
    awsAlbCors: "synthetic-cors",
  },
  secureKey: "synthetic-initial",
};
const EMPTY = { pageSize: 20, pageNumber: 0, totalSize: 0, totalNumOfPages: 0, list: [] };

async function collect(answer: (index: number) => unknown = () => EMPTY) {
  const requests: { event: string; data: Record<string, unknown> }[] = [];
  const artifacts: CollectorArtifact[] = [];
  const sessions: SessionMaterial[] = [];
  const result = await collectSbiVcLeverageExecutions({
    session: SEED,
    onSession: async (session) => {
      sessions.push(session);
    },
    onArtifact: async (artifact) => {
      artifacts.push(artifact);
    },
    fetcher: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as (typeof requests)[number]);
      const body = answer(requests.length - 1);
      return body instanceof Response
        ? body
        : Response.json({
            meta: { status: "OK", secureKey: `synthetic-rotation-${requests.length}` },
            body,
          });
    },
  });
  return { ...result, requests, artifacts, sessions };
}

describe("observed leverage execution empty views", () => {
  test("captures all four exact filters and rotates the session without publishing rows", async () => {
    const result = await collect();
    expect(result.failures).toHaveLength(4);
    expect(result.units.map((unit) => unit.unitKey)).toEqual([
      "executions-leverage-open-recent",
      "executions-leverage-open-historical",
      "executions-leverage-close-recent",
      "executions-leverage-close-historical",
    ]);
    expect(
      result.units.every(
        (unit) =>
          unit.status === "partial" &&
          unit.errorCode === "leverage_execution_transport_unverified" &&
          unit.absenceMeaning === undefined &&
          unit.expectedCount === undefined &&
          unit.observedCount === undefined,
      ),
    ).toBe(true);
    expect(
      result.requests.map((request) => [request.data.isCloseOrder, request.data.historical]),
    ).toEqual([
      ["false", "false"],
      ["false", "true"],
      ["true", "false"],
      ["true", "true"],
    ]);
    for (const [index, request] of result.requests.entries()) {
      expect(request).toEqual({
        event: "executionList",
        data: {
          secureKey: index === 0 ? "synthetic-initial" : `synthetic-rotation-${index}`,
          historical: String(index % 2 === 1),
          currencyPairs: [],
          fromDate: "",
          toDate: "",
          isActiveStatus: false,
          isTodayOrder: "false",
          isHistory: true,
          isTargetDate: true,
          isAuction: "false",
          sortKey: "executionDatetime",
          sortAsc: "false",
          pageNumber: "0",
          pageSize: "20",
          isExOrder: "false",
          isCloseOrder: String(index >= 2),
        },
      });
      expect(result.artifacts[index]?.dataset).toBe(`${result.units[index]?.unitKey}-page-0001`);
      expect(JSON.parse(String(result.artifacts[index]?.body)).meta).toEqual({ status: "OK" });
    }
    expect(result.sessions).toHaveLength(4);
  });

  test.each([
    null,
    {},
    { ...EMPTY, list: null },
    { ...EMPTY, pageSize: "20" },
    { ...EMPTY, pageNumber: "0" },
    { ...EMPTY, totalSize: "0" },
    { ...EMPTY, totalNumOfPages: "0" },
    { ...EMPTY, pageNumber: 1 },
    { ...EMPTY, totalSize: 1 },
    { ...EMPTY, totalNumOfPages: 1 },
    { ...EMPTY, pageSize: 30 },
    { ...EMPTY, pageSize: undefined },
  ])("refuses a contradictory or unobserved empty envelope %#", async (body) => {
    const result = await collect((index) => (index === 0 ? body : EMPTY));
    expect(result.units[0]).toMatchObject({
      status: "partial",
      errorCode: "leverage_execution_invalid_pagination",
    });
    expect(result.units[0]?.absenceMeaning).toBeUndefined();
    expect(
      result.units
        .slice(1)
        .every((unit) => unit.errorCode === "leverage_execution_transport_unverified"),
    ).toBe(true);
    expect(result.artifacts).toHaveLength(4);
  });

  test("retains nonempty rows but never borrows the spot row contract or fetches page two", async () => {
    const body = {
      ...EMPTY,
      list: [{ CExecutionId: "synthetic-id", commissionAmount: "0" }],
      totalSize: 21,
      totalNumOfPages: 2,
    };
    const result = await collect((index) => (index === 0 ? body : EMPTY));
    expect(result.units[0]).toMatchObject({
      status: "partial",
      errorCode: "leverage_execution_rows_unobserved",
    });
    expect(JSON.parse(String(result.artifacts[0]?.body)).body).toEqual(body);
    expect(result.requests).toHaveLength(4);
    expect(
      result.units
        .slice(1)
        .every((unit) => unit.errorCode === "leverage_execution_transport_unverified"),
    ).toBe(true);
  });

  test.each([302, 401, 403, 429, 503])(
    "stops all subsequent views after HTTP %i",
    async (status) => {
      const result = await collect(
        () => new Response("synthetic private provider text", { status }),
      );
      expect(result.requests).toHaveLength(1);
      expect(result.artifacts).toHaveLength(0);
      expect(result.units[0]?.errorCode).toBe(`collector_http_${status}`);
      expect(
        result.units
          .slice(1)
          .every((unit) => unit.errorCode === "leverage_execution_session_stopped"),
      ).toBe(true);
      expect(result.units.every((unit) => unit.status === "partial")).toBe(true);
    },
  );

  test("stops after gateway rejection and keeps provider text out of failures", async () => {
    const result = await collect(() =>
      Response.json({ meta: { status: "synthetic-private-status" }, body: EMPTY }),
    );
    expect(result.requests).toHaveLength(1);
    expect(result.units[0]?.errorCode).toBe("collector_gateway_rejected");
    expect(JSON.stringify(result.failures)).not.toContain("synthetic-private-status");
  });

  test("non-JSON login replies and unknown error messages stop without retaining private text", async () => {
    for (const answer of [
      () =>
        new Response("<html>synthetic private login</html>", {
          headers: { "content-type": "text/html" },
        }),
      () => {
        throw new Error("synthetic-private-provider-text");
      },
    ]) {
      const result = await collect(answer);
      expect(result.requests).toHaveLength(1);
      expect(
        result.units
          .slice(1)
          .every((unit) => unit.errorCode === "leverage_execution_session_stopped"),
      ).toBe(true);
      expect(JSON.stringify(result.failures)).not.toContain("synthetic-private");
    }
  });
  test("assigns every capture to its own terminal unit while preserving account coverage", async () => {
    const result = await collect((index) => (index === 0 ? { ...EMPTY, list: [{}] } : EMPTY));
    const artifacts = result.artifacts.map((artifact) => ({
      dataset: artifact.dataset,
      key: "synthetic",
      sha256: "a".repeat(64),
      bytes: String(artifact.body).length,
    }));
    const manifest = {
      schemaVersion: "synthetic",
      source: "sbi-vc-trade" as const,
      runId: "00000000-0000-4000-8000-000000000000",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:01:00Z",
      status: "partial" as const,
      artifacts,
      failures: result.failures,
      units: [{ unitKey: "account" as const, status: "success" as const }, ...result.units],
    };
    const plan = await buildSharedRunPlan({
      manifest,
      manifestJson: JSON.stringify(manifest),
      captures: result.artifacts.map((artifact) => ({
        dataset: artifact.dataset,
        body: artifact.body,
      })),
      identity: { attemptId: "synthetic-attempt" },
    });
    await expect(
      buildSharedRunPlan({
        manifest: { ...manifest, units: manifest.units.slice(0, 1) },
        manifestJson: JSON.stringify(manifest),
        captures: result.artifacts.map((artifact) => ({
          dataset: artifact.dataset,
          body: artifact.body,
        })),
        identity: { attemptId: "synthetic-attempt" },
      }),
    ).rejects.toThrow("shared_leverage_unit_missing");
    expect(plan.run.units[0]).toMatchObject({
      unitKey: "account",
      coverageStatus: "complete",
      artifactCount: 0,
    });
    expect(
      plan.run.units.slice(1).map((unit) => [unit.coverageStatus, unit.artifactCount]),
    ).toEqual([
      ["partial", 1],
      ["partial", 1],
      ["partial", 1],
      ["partial", 1],
    ]);
    for (const [index, artifact] of plan.artifacts.slice(0, 4).entries()) {
      expect(artifact.unitKey).toBe(result.units[index]?.unitKey);
    }
  });
});

test("no publishing parser accepts the four leverage evidence datasets", () => {
  // Keep the parser workspace's own TypeScript configuration across this boundary.
  const registry = new URL("../../../packages/parsers/src/parsers/registry.ts", import.meta.url)
    .href;
  const script = `
    const { PARSERS } = await import(${JSON.stringify(registry)});
    const matches = [];
    for (const close of ["open", "close"]) for (const view of ["recent", "historical"]) {
      const dataset = "executions-leverage-" + close + "-" + view + "-page-0001";
      matches.push(PARSERS.filter((parser) => parser.accepts({
        id: 1, sourceId: "sbi-vc-trade", runStatus: "partial", runFailureCount: 4,
        dataset, url: null, mime: "application/json", fetchedAt: "2026-01-01T00:00:00Z", sha256: "a".repeat(64),
      })).map((parser) => parser.name));
    }
    process.stdout.write(JSON.stringify(matches));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script]);
  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual([[], [], [], []]);
});
