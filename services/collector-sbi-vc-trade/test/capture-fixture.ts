// A subprocess boundary keeps this Worker's generated Env and DO mock out of
// the Processor's runtime. Every response and persisted byte is synthetic.
import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/reader";
import { encryptSession } from "../src/crypto";
import type { SessionMaterial } from "../src/types.ts";

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
  if (!["success", "raw-error", "classic-error", "raw-invalid"].includes(scenario ?? ""))
    throw new Error("invalid_synthetic_scenario");
  const sessionRef = process.argv[3] ?? "synthetic-session";
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
    ) as { meta: Record<string, unknown>; body: unknown };
  const names: Record<string, string> = {
    cashBalanceList: "cash-balances",
    accountMargin: "account-margin",
    positionSummaryList: "position-summary",
  };
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const { event, data } = JSON.parse(String(init?.body)) as {
      event: string;
      data: Record<string, unknown>;
    };
    if (event === "tradeReportList")
      return Response.json({
        meta: { status: "OK" },
        body:
          data.statementType === "MONTH" || data.statementType === "YEAR"
            ? { list: [], pageNumber: "0", totalSize: "0", totalNumOfPages: "0" }
            : { list: [] },
      });
    if (event === "getCashflowList" && data.pageSize === "20") {
      if (scenario === "raw-error") return new Response("synthetic unavailable", { status: 503 });
      return Response.json({
        meta: { status: "OK" },
        body: {
          list: [
            {
              ...(scenario === "raw-invalid" ? {} : { cashflowID: "synthetic-raw-only" }),
              cashflowType: "UNKNOWN_SYNTHETIC_TYPE",
              processStatusType: "UNKNOWN_SYNTHETIC_STATUS",
              currency: "BTC",
              cashflowAmount: "0.00000001",
            },
          ],
          pageNumber: 0,
          pageSize: 20,
          totalSize: 1,
          totalNumOfPages: 1,
        },
      });
    }
    if (event === "getCashflowList" && scenario === "classic-error")
      return new Response("synthetic unavailable", { status: 503 });
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
    const response = fixture(dataset);
    if (scenario === "raw-error") response.meta.timestamp = "2026/09/08 09:00:01";
    return Response.json(response);
  }) as typeof fetch;
  const bucket = new FakeR2Bucket();
  for (const method of ["log", "warn", "error"] as const) console[method] = () => {};
  const worker = new SbiVcSessionState(state, {
    SESSION_ENCRYPTION_KEY: key,
    COLLECTOR_SCHEMA_VERSION: "synthetic-sbi-vc-unit-test",
    DATA: bucket,
  } as unknown as Env);
  const summary = await worker.runCollection();
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
