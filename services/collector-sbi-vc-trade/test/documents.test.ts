import { describe, expect, test } from "bun:test";
import { collectSbiVcDocuments, decodeDocument } from "../src/documents";
import { inspectPnlZip } from "../src/pnl-zip";
import { describeArtifact } from "../src/storage";
import { buildSharedRunPlan, type SharedCapture } from "../src/shared-collection";
import { persistRun } from "../../../packages/collection/src/writer";
import { objectKey } from "../../../packages/collection/src/keys";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import type { CollectorArtifact, SessionMaterial, StoredArtifact } from "../src/types";
import { PDF_BYTES, pnlZip } from "./document-fixture";

const session: SessionMaterial = {
  cookies: {
    vctBffSid: "synthetic",
    jSessionId: "synthetic",
    awsAlbApp: ["a", "b", "c", "d"],
    awsAlb: "synthetic",
    awsAlbCors: "synthetic",
  },
  secureKey: "synthetic",
};
const apiCaptures: SharedCapture[] = [
  {
    dataset: "executions-recent-page-0001",
    body: JSON.stringify({
      body: {
        list: [
          {
            CExecutionId: "synthetic-execution",
            CExecutionIdSubNo: "1",
            executionDatetime: "2026/09/06 12:34:56",
          },
        ],
      },
    }),
  },
  { dataset: "executions-historical-page-0001", body: JSON.stringify({ body: { list: [] } }) },
  { dataset: "cashflows-all-recent-page-0001", body: JSON.stringify({ body: { list: [] } }) },
  {
    dataset: "cashflows-all-historical-page-0001",
    body: JSON.stringify({
      body: {
        list: [
          {
            cashflowID: "synthetic-flow",
            processStatusType: "PROCESSED",
            eventDatetime: "2026/09/06 12:34:56",
          },
        ],
      },
    }),
  },
  // Overlapping filtered remittances are never added to the full-list count.
  {
    dataset: "cashflows-historical-page-0001",
    body: JSON.stringify({ body: { list: [{ cashflowID: "synthetic-flow" }] } }),
  },
];

async function run(
  options: {
    badIndex?: boolean;
    transportError?: unknown;
    annualOffered?: boolean;
    wrongMime?: boolean;
    zip?: Uint8Array;
    captures?: SharedCapture[];
    cashflowsComplete?: boolean;
    now?: Date;
  } = {},
) {
  const zip = options.zip ?? (await pnlZip());
  const requests: { event: string; data: Record<string, unknown> }[] = [];
  const artifacts: CollectorArtifact[] = [];
  const result = await collectSbiVcDocuments({
    session,
    captures: options.captures ?? apiCaptures,
    cashflowsComplete: options.cashflowsComplete ?? true,
    now: options.now ?? new Date("2026-11-10T00:00:00Z"),
    onSession: async () => {},
    onArtifact: async (artifact) => {
      artifacts.push(artifact);
    },
    fetcher: async (_input, init) => {
      if (options.transportError !== undefined) throw options.transportError;
      const request = JSON.parse(String(init?.body)) as {
        event: string;
        data: Record<string, unknown>;
      };
      requests.push(request);
      const current = request.data.fromBasisYmdDate === "20260101";
      const monthly = request.data.statementType === "MONTH";
      const annual = request.data.statementType === "YEAR";
      const row = {
        statementType: annual ? "YEAR" : monthly ? "MONTH" : "TRADE_DATA",
        reportTitle: "Synthetic report",
        basisYmdDate: "20260930",
        ...(monthly ? { readStatus: "0", readStatusString: "未閲覧" } : {}),
      };
      const list = (annual ? options.annualOffered : current) ? [row] : [];
      const body =
        request.event === "tradeReportList"
          ? monthly || annual
            ? {
                list,
                pageNumber: String(request.data.pageNumber),
                totalSize: options.badIndex && current ? "2" : String(list.length),
                totalNumOfPages: list.length ? "1" : "0",
              }
            : { list }
          : {
              type: "Buffer",
              data: [...(request.event === "monthlyTradeReport" ? PDF_BYTES : zip)],
            };
      const mime =
        request.event === "tradeReportList"
          ? "application/json"
          : request.event === "monthlyTradeReport"
            ? options.wrongMime
              ? "text/html"
              : "application/pdf"
            : "application/zip";
      return new Response(
        JSON.stringify({ meta: { status: "OK", secureKey: "synthetic-next" }, body }),
        { headers: { "content-type": mime } },
      );
    },
  });
  return { ...result, artifacts, requests };
}

describe("SBI VC observed document reads", () => {
  test("walks all observed years and preserves the complete eight-digit download identity", async () => {
    const output = await run();
    expect(output.failures).toEqual([]);
    const annual = output.requests.filter((request) => request.data.statementType === "YEAR");
    expect(annual.map((request) => request.data)).toEqual([
      {
        statementType: "YEAR",
        getUnreadReportOnly: "false",
        pageSize: "30",
        pageNumber: "0",
        secureKey: "synthetic",
      },
    ]);
    expect(output.units.find((unit) => unit.unitKey === "report-annual-index")).toMatchObject({
      status: "success",
      observedCount: 0,
      expectedCount: 0,
      absenceMeaning: "complete-empty",
    });
    const indices = output.requests.filter(
      (request) => request.event === "tradeReportList" && request.data.statementType !== "YEAR",
    );
    expect(indices).toHaveLength(18);
    expect(indices[0]!.data).toMatchObject({
      fromBasisYmdDate: "20180101",
      toBasisYmdDate: "20181231",
      pageSize: "30",
      pageNumber: "0",
      getUnreadReportOnly: "false",
    });
    expect(indices.at(-1)!.data).toMatchObject({
      fromBasisYmdDate: "20260101",
      statementType: "TRADE_DATA",
    });
    expect(
      output.requests
        .filter((request) => request.event !== "tradeReportList")
        .map((request) => request.data),
    ).toEqual([
      { secureKey: "synthetic-next", basisYmDate: "20260930" },
      { secureKey: "synthetic-next", basisYmDate: "20260930" },
    ]);
    expect(
      output.artifacts.find((artifact) => artifact.dataset === "monthly-report-pdf")!.body,
    ).toEqual(PDF_BYTES);
    expect(
      output.artifacts
        .filter((artifact) => typeof artifact.body === "string")
        .every((artifact) => !String(artifact.body).includes("synthetic-next")),
    ).toBe(true);
    expect(
      output.artifacts.find((artifact) => artifact.dataset === "pnl-check-20260930")!.body,
    ).toBe(
      JSON.stringify({
        schema: "sbi-vc-pnl-check-v1",
        csv: { executions: 1, cashflows: 1 },
        status: "matched",
        api: { executions: 1, cashflows: 1 },
      }),
    );
    const rolled = await run({ now: new Date("2026-12-31T15:00:00Z") });
    expect(rolled.requests.some((request) => request.data.fromBasisYmdDate === "20270101")).toBe(
      true,
    );
  });

  test("a bad monthly index or PDF does not discard an independent ZIP", async () => {
    for (const options of [{ badIndex: true }, { wrongMime: true }]) {
      const output = await run(options);
      expect(output.failures.length).toBeGreaterThan(0);
      expect(output.units.find((unit) => unit.unitKey === "pnl-data-20260930")?.status).toBe(
        "success",
      );
      expect(output.artifacts.some((artifact) => artifact.dataset === "pnl-data-zip")).toBe(true);
    }
  });
  test("changing, throwing and nonstring exception accessors cannot escape closed report codes", async () => {
    const privateText = "synthetic-private-provider-text";
    const fallback = "report_collection_failed";
    for (const scenario of [
      {
        value: (read: number) => (read === 1 ? "collector_http_503" : privateText),
        expected: ["collector_http_503", fallback, fallback],
      },
      {
        value: () => {
          throw new Error(privateText);
        },
        expected: [fallback, fallback, fallback],
      },
      {
        value: () => ({
          toString: () => {
            throw new Error(privateText);
          },
        }),
        expected: [fallback, fallback, fallback],
      },
    ]) {
      let reads = 0;
      const error = Object.defineProperty(new Error(), "message", {
        get: () => scenario.value(++reads),
      });
      const output = await run({ now: new Date("2018-11-10T00:00:00Z"), transportError: error });
      expect(reads).toBe(3);
      expect(output.failures.map((failure) => failure.errorCode)).toEqual(scenario.expected);
      expect(JSON.stringify(output)).not.toContain(privateText);
    }
  });

  test("an offered annual report stays raw and partial without guessing its download", async () => {
    const output = await run({ annualOffered: true });
    expect(output.units.find((unit) => unit.unitKey === "report-annual-index")).toMatchObject({
      status: "partial",
      observedCount: 1,
      expectedCount: 1,
      errorCode: "annual_report_download_unobserved",
    });
    expect(
      output.artifacts.some((artifact) => artifact.dataset === "report-annual-list-page-0001"),
    ).toBe(true);
    expect(
      output.requests
        .filter((request) => request.event !== "tradeReportList")
        .map((request) => request.event),
    ).toEqual(["monthlyTradeReport", "plCalcData"]);
  });

  test("CSV comparison refuses a bare execution id and incomplete API coverage without losing the export", async () => {
    for (const output of [
      await run({ zip: await pnlZip({ executionIds: ["synthetic-execution"] }) }),
      await run({ cashflowsComplete: false }),
      await run({ captures: [] }),
    ]) {
      expect(output.units.find((unit) => unit.unitKey === "pnl-data-20260930")?.status).toBe(
        "success",
      );
      expect(output.units.find((unit) => unit.unitKey === "pnl-check-20260930")?.status).toBe(
        "partial",
      );
      expect(output.artifacts.filter((artifact) => artifact.document !== undefined)).toHaveLength(
        2,
      );
    }
  });

  test("JSON Buffer envelopes become immutable native PDF/ZIP objects, reused on recapture", async () => {
    const output = await run();
    const bucket = new FakeR2Bucket();
    const captures: SharedCapture[] = [];
    const records: StoredArtifact[] = [];
    for (const artifact of output.artifacts) {
      const { record } = await describeArtifact({ prefix: "synthetic", artifact });
      records.push({ ...record, key: objectKey(record.sha256) });
      captures.push({
        ...artifact,
        ...(record.artifactKey === undefined ? {} : { artifactKey: record.artifactKey }),
      });
    }
    const plans = [];
    for (const runId of [
      "00000000-0000-4000-8000-000000001249",
      "00000000-0000-4000-8000-000000001250",
    ]) {
      const manifest = {
        schemaVersion: "synthetic",
        source: "sbi-vc-trade" as const,
        runId,
        startedAt: "2026-11-10T00:00:00Z",
        completedAt: "2026-11-10T00:00:01Z",
        status: "success" as const,
        artifacts: records,
        failures: [],
        units: output.units,
      };
      const plan = await buildSharedRunPlan({
        manifest,
        manifestJson: JSON.stringify(manifest),
        captures,
        identity: { attemptId: `attempt-${runId}` },
      });
      expect((await persistRun(bucket, plan)).outcome).toBe("persisted");
      plans.push(plan);
    }
    const documents = plans[0]!.artifacts.filter(
      (artifact) => artifact.role === "provider_document",
    );
    expect(documents).toHaveLength(2);
    expect(documents.map((artifact) => artifact.artifactKey)).toEqual(
      plans[1]!.artifacts
        .filter((artifact) => artifact.role === "provider_document")
        .map((artifact) => artifact.artifactKey),
    );
    for (const artifact of documents) {
      expect(artifact.artifactKey).toContain(`20260930-${artifact.sha256}`);
      const native = bucket.entries.get(objectKey(artifact.sha256))!;
      // Shared CAS objects are MIME-neutral; the terminal declares the format.
      expect(artifact.mediaType).toBe(
        artifact.artifactKey.endsWith(".pdf") ? "application/pdf" : "application/zip",
      );
      const original = output.artifacts.find(
        (entry) => entry.document?.mediaType === artifact.mediaType,
      )!.body;
      if (typeof original === "string") throw new Error("expected native document bytes");
      expect(native.bytes).toEqual(original);
      expect(native.bytes[0]).toBe(artifact.mediaType === "application/pdf" ? 0x25 : 0x50);
    }
  });

  test("binary decoders reject fake PDF JSON, out-of-range Buffer bytes and wrong signatures", () => {
    for (const body of [
      { type: "Buffer", data: [256] },
      { type: "Buffer", data: [1.5] },
      { type: "Other", data: [] },
      { type: "Buffer", data: [...new TextEncoder().encode('{"body":"not a PDF"}')] },
    ])
      expect(() => decodeDocument(body, "application/pdf")).toThrow();
  });
});

describe("P&L CSV validation", () => {
  test("accepts both observed balance-header versions and explicit header-only zero rows", async () => {
    expect(
      await inspectPnlZip(
        await pnlZip({ latestBalances: true, executionIds: [], cashflows: 0 }),
        "20260930",
      ),
    ).toEqual({ executions: 0, cashflows: 0, executionIds: [], executionDates: [] });
    expect(await inspectPnlZip(await pnlZip({ latestBalances: true }), "20260930")).toMatchObject({
      executions: 1,
      cashflows: 1,
    });
    const empty = await run({
      zip: await pnlZip({ latestBalances: true, executionIds: [], cashflows: 0 }),
      captures: apiCaptures.map((capture) => ({
        ...capture,
        body: JSON.stringify({ body: { list: [] } }),
      })),
    });
    const checked = empty.artifacts.find(
      (artifact) => artifact.dataset === "pnl-check-20260930",
    )!.body;
    if (typeof checked !== "string") throw new Error("expected comparison JSON");
    expect(JSON.parse(checked)).toMatchObject({
      csv: { executions: 0, cashflows: 0 },
      api: { executions: 0, cashflows: 0 },
      status: "matched",
    });
    const prefix = "日時,入出金の種別,暗号資産/通貨,数量,評価レート,入出金額（円）";
    expect(
      await inspectPnlZip(
        await pnlZip({ cashHeader: `${prefix},残高_UNKNOWN1,残高_JPY,備考` }),
        "20260930",
      ),
    ).toMatchObject({ cashflows: 1 });
    await expect(
      inspectPnlZip(await pnlZip({ cashHeader: `${prefix},残高_JPY,残高_JPY,備考` }), "20260930"),
    ).rejects.toThrow("pnl_csv_schema_unobserved");
    await expect(
      inspectPnlZip(
        await pnlZip({
          cashHeader: `${prefix},${Array.from({ length: 129 }, (_, index) => `残高_SYNTH${index}`).join(",")},備考`,
        }),
        "20260930",
      ),
    ).rejects.toThrow("pnl_csv_schema_unobserved");
  });
  test("counts quoted CRLF rows and exact composite execution identities without publishing them", async () => {
    expect(await inspectPnlZip(await pnlZip(), "20260930")).toEqual({
      executions: 1,
      cashflows: 1,
      executionIds: ["synthetic-execution-1"],
      executionDates: ["2026/09/06 12:34:56"],
    });
  });
  test("refuses corrupt archives, extra files, schema changes and impossible dates", async () => {
    for (const options of [
      { corruptCrc: true },
      { extraFile: true },
      { badHeader: true },
      { date: "2026/09/31 12:34:56" },
      { date: "2026/10/01 00:00:00" },
    ])
      await expect(inspectPnlZip(await pnlZip(options), "20260930")).rejects.toThrow();
  });
});
