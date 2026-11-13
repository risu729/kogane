// The actual DO runs across a subprocess boundary with synthetic transport and
// storage, keeping its generated Env and cloudflare:workers mock isolated.
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/reader";
import { encryptSession } from "../src/crypto";
import type { SessionMaterial } from "../src/types.ts";
import { PDF_BYTES, pnlZip } from "./document-fixture";

mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: DurableObjectState,
      readonly env: Env,
    ) {}
  },
}));
const { SbiVcSessionState } = await import("../src/worker");

async function capture() {
  const scenario = process.argv[2];
  if (scenario !== "valid" && scenario !== "bad-zip")
    throw new Error("invalid_synthetic_document_scenario");
  const sessionRef = process.argv[3];
  if (!sessionRef) throw new Error("synthetic_session_ref_required");
  const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
  const session: SessionMaterial = {
    cookies: {
      vctBffSid: "synthetic",
      jSessionId: "synthetic",
      awsAlbApp: ["a", "b", "c", "d"],
      awsAlb: "synthetic",
      awsAlbCors: "synthetic",
    },
    secureKey: "synthetic-secure",
  };
  const values = new Map<string, unknown>([
    ["session", await encryptSession(session, key)],
    ["sessionRef", sessionRef],
  ]);
  const state = {
    storage: {
      get: async (name: string) => values.get(name),
      put: async (name: string | Record<string, unknown>, value?: unknown) => {
        if (typeof name === "string") values.set(name, value);
        else for (const [field, item] of Object.entries(name)) values.set(field, item);
      },
      delete: async (name: string) => values.delete(name),
    },
    abort: () => undefined,
  } as unknown as DurableObjectState;
  const fixture = (dataset: string) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../../tests/fixtures/observation-pipeline/sbi-vc-trade/2026-09-07/run-20260907-synthetic01/${dataset}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as unknown;
  const names: Record<string, string> = {
    cashBalanceList: "cash-balances",
    accountMargin: "account-margin",
    positionSummaryList: "position-summary",
  };
  const zip = await pnlZip({ corruptCrc: scenario === "bad-zip" });
  const lastYear = Number(
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone: "Asia/Tokyo" }).format(
      new Date(),
    ),
  );
  const indexes = new Set<string>();
  const downloads = new Set<string>();
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { event, data } = JSON.parse(String(init?.body)) as {
      event: string;
      data: Record<string, unknown>;
    };
    if (event === "getCashflowList" && data.pageSize === "20")
      return new Response("synthetic unavailable", { status: 503 });
    if (event === "tradeReportList") {
      if (data.statementType === "YEAR") {
        if (
          Object.keys(data).length !== 5 ||
          data.getUnreadReportOnly !== "false" ||
          data.pageSize !== "30" ||
          data.pageNumber !== "0" ||
          data.secureKey !== session.secureKey ||
          Object.hasOwn(data, "fromBasisYmdDate") ||
          Object.hasOwn(data, "toBasisYmdDate") ||
          indexes.has("YEAR")
        )
          throw new Error("unexpected_synthetic_annual_index_request");
        indexes.add("YEAR");
        return Response.json({
          meta: { status: "OK" },
          body: { pageNumber: "0", totalSize: "0", totalNumOfPages: "0", list: [] },
        });
      }
      const year = Number(String(data.fromBasisYmdDate).slice(0, 4));
      if (
        year < 2018 ||
        year > lastYear ||
        data.fromBasisYmdDate !== `${year}0101` ||
        data.toBasisYmdDate !== `${year}1231` ||
        data.getUnreadReportOnly !== "false" ||
        data.pageSize !== "30" ||
        data.pageNumber !== "0" ||
        data.secureKey !== session.secureKey ||
        (data.statementType !== "MONTH" && data.statementType !== "TRADE_DATA")
      )
        throw new Error("unexpected_synthetic_report_index_request");
      indexes.add(`${year}:${data.statementType}`);
      const list =
        year === 2026
          ? [
              {
                statementType: data.statementType,
                reportTitle: "Synthetic private report",
                basisYmdDate: "20260930",
                ...(data.statementType === "MONTH"
                  ? { readStatus: "0", readStatusString: "unread" }
                  : {}),
              },
            ]
          : [];
      return Response.json({
        meta: { status: "OK" },
        body:
          data.statementType === "MONTH"
            ? {
                list,
                pageNumber: "0",
                totalSize: String(list.length),
                totalNumOfPages: String(list.length),
              }
            : { list },
      });
    }
    if (event === "monthlyTradeReport" || event === "plCalcData") {
      if (data.basisYmDate !== "20260930" || data.secureKey !== session.secureKey)
        throw new Error("unexpected_synthetic_document_request");
      downloads.add(event);
      // Observed HTTP media types describe native bytes, while the transport
      // actually wraps those bytes in a JSON Buffer envelope.
      return new Response(
        JSON.stringify({
          meta: { status: "OK" },
          body: { type: "Buffer", data: [...(event === "monthlyTradeReport" ? PDF_BYTES : zip)] },
        }),
        {
          headers: {
            "content-type": event === "monthlyTradeReport" ? "application/pdf" : "application/zip",
          },
        },
      );
    }
    if (event === "executionList" && data.isExOrder === "false")
      return Response.json({
        meta: { status: "OK" },
        body: { list: [], pageNumber: 0, pageSize: 20, totalSize: 0, totalNumOfPages: 0 },
      });
    const dataset =
      event === "executionList"
        ? `executions-${data.historical === "true" ? "historical" : "recent"}-page-0001`
        : event === "getCashflowList"
          ? "cashflows-historical-page-0001"
          : names[event];
    if (!dataset) throw new Error("unexpected_synthetic_request");
    return Response.json(fixture(dataset));
  }) as typeof fetch;
  const bucket = new FakeR2Bucket();
  for (const method of ["log", "warn", "error"] as const) console[method] = () => {};
  const worker = new SbiVcSessionState(state, {
    SESSION_ENCRYPTION_KEY: key,
    COLLECTOR_SCHEMA_VERSION: "synthetic-sbi-vc-document-test",
    DATA: bucket,
  } as unknown as Env);
  const summary = await worker.runCollection();
  if (indexes.size !== (lastYear - 2018 + 1) * 2 + 1 || downloads.size !== 2)
    throw new Error("synthetic_document_capture_incomplete");
  const terminal = await readTerminal(bucket, "sbi-vc-trade", summary.runId);
  if (terminal.outcome !== "found") throw new Error("synthetic_terminal_missing");
  return {
    summary,
    terminal: terminal.manifest,
    objects: [...bucket.entries].map(([key, entry]) => ({
      key,
      body: Buffer.from(entry.bytes).toString("base64"),
      contentType: entry.contentType,
      customMetadata: entry.customMetadata,
      sha256: entry.nativeSha256,
    })),
  };
}

if (import.meta.main) process.stdout.write(JSON.stringify(await capture()));
