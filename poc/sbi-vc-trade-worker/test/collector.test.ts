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
          body: paged ? { list: [{ synthetic: true }], totalSize: "1" } : { synthetic: true },
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
          : { list: [], totalSize: "0" },
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
          ? { list: [{ synthetic: true }], totalSize: "31" }
          : { list: [], totalSize: "0" },
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
});
