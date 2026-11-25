import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { readTerminal, verifyReferencedObjects } from "../../../packages/collection/src/index";
import { prestiaBankHtml } from "../../../packages/parsers/test/prestia-bank-fixture";
import {
  parsePrestiaBankBalancePage,
  sanitizePrestiaBankPage,
} from "../../../packages/parsers/src/parsers/prestia-bank-html";
import { createHandler, createCollection } from "../src/worker";
import { persistPrestiaBankRun } from "../src/storage";
import { PrestiaBankError } from "../src/client";
const request = (body = "{}", token = "local-test-only") =>
  new Request("https://collector.test/trigger", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
function collection() {
  const body = sanitizePrestiaBankPage(prestiaBankHtml()),
    parsed = parsePrestiaBankBalancePage(body);
  return {
    body,
    accountCount: parsed.accounts.length,
    foreignCurrencyCount: 3,
    aggregateCount: parsed.aggregates.length,
    monthlyAverageCount: parsed.monthlyAverages.length,
    signoffFailed: false,
  };
}
describe("PRESTIA bank Worker shared DATA acquisition", () => {
  it("persists a failed signoff flag while publishing parseable successful balance evidence", async () => {
    const response = await createCollection({
      collect: async () => ({ ...collection(), signoffFailed: true }),
    })(env);
    expect(response.httpStatus).toBe(200);
    expect(response.body).toMatchObject({ status: "success", signoffFailed: true });
    const terminal = await readTerminal(env.DATA, "prestia-bank", response.body.runId!);
    if (terminal.outcome !== "found") throw Error("missing-terminal");
    expect(terminal.manifest.providerOutcome).toBe("success");
    expect(terminal.manifest.coverageStatus).toBe("complete");
    expect(terminal.manifest.units[0]?.coverageStatus).toBe("complete");
    expect(terminal.manifest.reports).toContainEqual({
      reportRef: "logout",
      reportKind: "logout",
      scope: "run",
      outcome: "failed",
      safeErrorCode: "logout_failed",
    });
    expect((await verifyReferencedObjects(env.DATA, terminal.manifest)).outcome).toBe("ok");
    const stored = await env.DATA.get(terminal.manifest.artifacts[0]!.storageRef.key);
    expect(parsePrestiaBankBalancePage(await stored!.text())).toEqual(
      parsePrestiaBankBalancePage(collection().body),
    );
  });
  it("rejects retired triggers before bank access", async () => {
    const collect = vi.fn(async () => collection()),
      handler = createHandler({ collect });
    expect((await handler.fetch(request("private-invalid", "wrong"), env)).status).toBe(404);
    for (const invalid of [
      "null",
      "[]",
      "not-json",
      '{"password":"private-password"}',
      "x".repeat(1025),
    ])
      expect((await handler.fetch(request(invalid), env)).status).toBe(404);
    expect(collect).not.toHaveBeenCalled();
    const health = await handler.fetch(new Request("https://collector.test/health"), env);
    expect(await health.json()).toMatchObject({
      ok: true,
      source: "prestia-bank",
      releaseSha: "0000000000000000000000000000000000000000",
    });
  });
  it("collects once and persists a terminal-last sanitized bank snapshot, not credentials", async () => {
    const collect = vi.fn(async () => collection()),
      handler = createCollection({ collect, persist: persistPrestiaBankRun });
    const response = await handler(env);
    expect(response.httpStatus).toBe(200);
    expect(collect).toHaveBeenCalledTimes(1);
    const result = response.body as {
      runId: string;
      artifactCount: number;
      foreignCurrencyCount: number;
      monthlyAverageCount: number;
    };
    expect(result).toMatchObject({
      artifactCount: 1,
      foreignCurrencyCount: 3,
      monthlyAverageCount: 3,
    });
    const terminal = await readTerminal(env.DATA, "prestia-bank", result.runId);
    if (terminal.outcome !== "found") throw Error("missing-terminal");
    expect(terminal.manifest.providerOutcome).toBe("success");
    expect(terminal.manifest.units[0]).toMatchObject({
      unitKey: "balance-summary",
      artifactCount: 1,
      coverageStatus: "complete",
    });
    expect((await verifyReferencedObjects(env.DATA, terminal.manifest)).outcome).toBe("ok");
    const artifact = await env.DATA.get(terminal.manifest.artifacts[0]!.storageRef.key);
    const stored = await artifact!.text();
    for (const privateValue of [
      "syntheticuser12",
      "syntheticpassword",
      "synthetic-token",
      "synthetic-owner",
      "Set-Cookie",
    ])
      expect(stored + JSON.stringify(terminal.manifest) + JSON.stringify(result)).not.toContain(
        privateValue,
      );
  });
  it("stores a failure-free body only; denied authentication has no artifact and no retry", async () => {
    const collect = vi.fn(async () => {
        throw new PrestiaBankError("login-rejected");
      }),
      handler = createCollection({ collect });
    const response = await handler(env);
    expect(response.httpStatus).toBe(502);
    const result = response.body as { runId: string };
    expect(result).toMatchObject({ status: "failed", artifactCount: 0, error: "login-rejected" });
    const terminal = await readTerminal(env.DATA, "prestia-bank", result.runId);
    if (terminal.outcome !== "found") throw Error("missing-terminal");
    expect(terminal.manifest.providerOutcome).toBe("failed");
    expect(terminal.manifest.artifacts).toHaveLength(0);
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it.each([
    [new PrestiaBankError("login-challenge-required"), "login-challenge-required"],
    [new Error("synthetic-provider-notice private-account-label"), "balance-parse-error"],
  ])(
    "the Processor alarm path logs the run's closed failure code, never provider text (%#)",
    async (thrown, code) => {
      const collect = vi.fn(async () => {
        throw thrown;
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const result = await createHandler({ collect }).alarmCollection(env);
        expect(result).toMatchObject({ status: "failed", failureCode: "collection_failed" });
        const lines = log.mock.calls.map(([value]) => String(value));
        const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records).toEqual([
          {
            event: "prestia-bank-scheduled-collection",
            runId: result.runIds[0],
            status: "failed",
            persistence: "persisted",
            artifactCount: 0,
            error: code,
          },
        ]);
        for (const privateValue of ["synthetic-provider-notice", "private-account-label"])
          expect(lines.join("\n")).not.toContain(privateValue);
      } finally {
        log.mockRestore();
      }
    },
  );
  it("the scheduled handler logs one result line per run", async () => {
    const controller = { scheduledTime: Date.now(), cron: "30 21 * * *", noRetry: vi.fn() };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await createHandler({ collect: async () => collection() }).scheduled(
        controller as unknown as ScheduledController,
        env,
      );
      const records = log.mock.calls.map(([value]) => JSON.parse(String(value)));
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: "prestia-bank-scheduled-collection",
        status: "success",
        persistence: "persisted",
        artifactCount: 1,
      });
      expect(controller.noRetry).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
  it("never persists executable or authentication material injected into a body", async () => {
    const collect = vi.fn(async () => ({
      ...collection(),
      body: collection().body.replace(
        "</form>",
        '<input name="password" value="private-password"></form>',
      ),
    }));
    const response = await createCollection({ collect })(env);
    expect(response.httpStatus).toBe(502);
    expect(response.body).toMatchObject({
      persistence: "failed",
      error: "persistence-failed",
    });
  });
  it("does not acknowledge a failed persistence as successful acquisition", async () => {
    const handler = createCollection({
      collect: async () => collection(),
      persist: async () => {
        throw Error("private-r2-error");
      },
    });
    const response = await handler(env);
    expect(response.httpStatus).toBe(502);
    expect(response.body).toMatchObject({
      persistence: "failed",
      error: "persistence-failed",
    });
  });
});
