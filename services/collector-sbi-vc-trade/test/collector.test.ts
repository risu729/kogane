import { describe, expect, test } from "bun:test";
import { collectSbiVcTrade } from "../src/collector";
import type { CollectorArtifact, SessionMaterial } from "../src/types";

const seed: SessionMaterial = {
  cookies: {
    vctBffSid: "sid",
    jSessionId: "jsession",
    awsAlbApp: ["app0", "app1", "app2", "app3"],
    awsAlb: "alb",
    awsAlbCors: "cors",
  },
  secureKey: "secure",
};

describe("Worker collector", () => {
  test("runs only the fixed read sequence, paginates, rotates session, and redacts secureKey", async () => {
    const requests: Array<{ event: string; data: Record<string, unknown> }> = [];
    const artifacts: CollectorArtifact[] = [];
    const sessions: SessionMaterial[] = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        event: string;
        data: Record<string, unknown>;
      };
      requests.push(request);
      const paged = request.event === "executionList" || request.event === "getCashflowList";
      const responseHeaders = new Headers({ "content-type": "application/json" });
      responseHeaders.append("set-cookie", "AWSALB=rotated; Secure");
      responseHeaders.append("set-cookie", "__cf_bm=ignored; Secure");
      return new Response(
        JSON.stringify({
          meta: { status: "OK", secureKey: "next-secure", timestamp: "synthetic" },
          body: paged
            ? {
                list: [{ synthetic: true }],
                pageNumber: Number(request.data.pageNumber),
                pageSize: 30,
                totalNumOfPages: 1,
                totalSize: 1,
              }
            : { synthetic: true },
        }),
        { status: 200, headers: responseHeaders },
      );
    }) as typeof fetch;

    const finalSession = await collectSbiVcTrade({
      session: seed,
      fetcher,
      onSession: async (session) => {
        sessions.push(structuredClone(session));
      },
      onArtifact: async (artifact) => {
        artifacts.push(artifact);
      },
    });

    expect(requests.map((request) => request.event)).toEqual([
      "cashBalanceList",
      "accountMargin",
      "positionSummaryList",
      "executionList",
      "executionList",
      "getCashflowList",
    ]);
    expect(requests[3]?.data.historical).toBe("false");
    expect(requests[4]?.data.historical).toBe("true");
    expect(requests[5]?.data).toMatchObject({
      historical: "true",
      currency: ["JPY"],
      cashflowType: ["REMITTANCE_DEPOSIT", "REMITTANCE_WITHDRAW"],
    });
    expect(artifacts.map((artifact) => artifact.dataset)).toEqual([
      "cash-balances",
      "account-margin",
      "position-summary",
      "executions-recent-page-0001",
      "executions-historical-page-0001",
      "cashflows-historical-page-0001",
    ]);
    expect(artifacts.every((artifact) => !artifact.body.includes("next-secure"))).toBe(true);
    expect(sessions).toHaveLength(6);
    expect(finalSession.secureKey).toBe("next-secure");
    expect(finalSession.cookies.awsAlb).toBe("rotated");
  });

  test("rejects malformed pagination metadata instead of silently truncating history", async () => {
    const artifacts: CollectorArtifact[] = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        event: string;
        data: Record<string, unknown>;
      };
      const isMalformedHistoricalExecution =
        request.event === "executionList" && request.data.historical === "true";
      return Response.json({
        meta: { status: "OK", secureKey: "next-secure" },
        body: isMalformedHistoricalExecution
          ? { list: [{ synthetic: true }] }
          : { list: [], pageNumber: 0, pageSize: 30, totalNumOfPages: 0, totalSize: 0 },
      });
    }) as typeof fetch;

    await expect(
      collectSbiVcTrade({
        session: seed,
        fetcher,
        onSession: async () => undefined,
        onArtifact: async (artifact) => {
          artifacts.push(artifact);
        },
      }),
    ).rejects.toThrow("executions-historical_invalid_pagination");

    expect(artifacts.at(-1)?.dataset).toBe("executions-historical-page-0001");
  });

  test("rejects a short non-terminal page instead of skipping history", async () => {
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        event: string;
        data: Record<string, unknown>;
      };
      const isHistoricalExecution =
        request.event === "executionList" && request.data.historical === "true";
      return Response.json({
        meta: { status: "OK", secureKey: "next-secure" },
        body: isHistoricalExecution
          ? {
              list: [{ synthetic: true }],
              pageNumber: 0,
              pageSize: 30,
              totalNumOfPages: 2,
              totalSize: 31,
            }
          : { list: [], pageNumber: 0, pageSize: 30, totalNumOfPages: 0, totalSize: 0 },
      });
    }) as typeof fetch;

    await expect(
      collectSbiVcTrade({
        session: seed,
        fetcher,
        onSession: async () => undefined,
        onArtifact: async () => undefined,
      }),
    ).rejects.toThrow("executions-historical_pagination_length_mismatch");
  });

  test("rejects a recent view larger than its single collected page", async () => {
    const artifacts: CollectorArtifact[] = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        event: string;
        data: Record<string, unknown>;
      };
      const recent = request.event === "executionList" && request.data.historical === "false";
      return Response.json({
        meta: { status: "OK", secureKey: "next-secure" },
        body: recent
          ? {
              list: Array.from({ length: 30 }, () => ({ synthetic: true })),
              pageNumber: 0,
              pageSize: 30,
              totalNumOfPages: 2,
              totalSize: 31,
            }
          : { list: [], pageNumber: 0, pageSize: 30, totalNumOfPages: 0, totalSize: 0 },
      });
    }) as typeof fetch;

    await expect(
      collectSbiVcTrade({
        session: seed,
        fetcher,
        onSession: async () => undefined,
        onArtifact: async (artifact) => {
          artifacts.push(artifact);
        },
      }),
    ).rejects.toThrow("executions_recent_page_limit_exceeded");
    expect(artifacts.at(-1)?.dataset).toBe("executions-recent-page-0001");
  });

  test("keeps both historical pages when a later total contradicts the first", async () => {
    const artifacts: CollectorArtifact[] = [];
    const requests: Array<{ event: string; data: Record<string, unknown> }> = [];
    const page = (
      pageNumber: number,
      totalSize: number,
      listLength: number,
      totalNumOfPages: number,
    ) => ({
      list: Array.from({ length: listLength }, () => ({ synthetic: true })),
      pageNumber,
      pageSize: 30,
      totalNumOfPages,
      totalSize,
    });
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        event: string;
        data: Record<string, unknown>;
      };
      requests.push(request);
      const historical = request.event === "executionList" && request.data.historical === "true";
      const recent = request.event === "executionList" && request.data.historical === "false";
      const pageNumber = Number(request.data.pageNumber);
      const body = recent
        ? page(0, 1, 1, 1)
        : historical && pageNumber === 0
          ? page(0, 31, 30, 2)
          : historical && pageNumber === 1
            ? page(1, 32, 1, 2)
            : { synthetic: true };
      return Response.json({ meta: { status: "OK", secureKey: "next-secure" }, body });
    }) as typeof fetch;

    await expect(
      collectSbiVcTrade({
        session: seed,
        fetcher,
        onSession: async () => undefined,
        onArtifact: async (artifact) => {
          artifacts.push(artifact);
        },
      }),
    ).rejects.toThrow("executions-historical_pagination_total_changed");

    expect(artifacts.map((artifact) => artifact.dataset)).toEqual([
      "cash-balances",
      "account-margin",
      "position-summary",
      "executions-recent-page-0001",
      "executions-historical-page-0001",
      "executions-historical-page-0002",
    ]);
    const executions = requests.filter((request) => request.event === "executionList");
    expect(executions.map((request) => request.data.historical)).toEqual(["false", "true", "true"]);
    expect(executions.map((request) => request.data.pageNumber)).toEqual(["0", "0", "1"]);
    for (const request of executions) {
      expect(request.data).toMatchObject({
        pageSize: "30",
        sortKey: "executionDatetime",
        sortAsc: "false",
        isExOrder: "true",
        isCloseOrder: "false",
      });
    }
    expect(requests.some((request) => request.event === "getCashflowList")).toBe(false);
  });
});
