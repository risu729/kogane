import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { readTerminal, verifyReferencedObjects } from "../../../packages/collection/src/index";
import { prestiaBankHtml } from "../../../packages/parsers/test/prestia-bank-fixture";
import {
  parsePrestiaBankBalancePage,
  sanitizePrestiaBankPage,
} from "../../../packages/parsers/src/parsers/prestia-bank-html";
import { createHandler } from "../src/worker";
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
  it("requires admin authorization and the exact empty-object trigger before bank access", async () => {
    const collect = vi.fn(async () => collection()),
      handler = createHandler({ collect });
    expect((await handler.fetch(request("private-invalid", "wrong"), env)).status).toBe(401);
    for (const invalid of [
      "null",
      "[]",
      "not-json",
      '{"password":"private-password"}',
      "x".repeat(1025),
    ])
      expect((await handler.fetch(request(invalid), env)).status).toBe(400);
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
      handler = createHandler({ collect, persist: persistPrestiaBankRun });
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(collect).toHaveBeenCalledTimes(1);
    const result = (await response.json()) as {
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
      handler = createHandler({ collect });
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(502);
    const result = (await response.json()) as { runId: string };
    expect(result).toMatchObject({ status: "failed", artifactCount: 0, error: "login-rejected" });
    const terminal = await readTerminal(env.DATA, "prestia-bank", result.runId);
    if (terminal.outcome !== "found") throw Error("missing-terminal");
    expect(terminal.manifest.providerOutcome).toBe("failed");
    expect(terminal.manifest.artifacts).toHaveLength(0);
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it("never persists executable or authentication material injected into a body", async () => {
    const collect = vi.fn(async () => ({
      ...collection(),
      body: collection().body.replace(
        "</form>",
        '<input name="password" value="private-password"></form>',
      ),
    }));
    const response = await createHandler({ collect }).fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      persistence: "failed",
      error: "persistence-failed",
    });
  });
  it("does not acknowledge a failed persistence as successful acquisition", async () => {
    const handler = createHandler({
      collect: async () => collection(),
      persist: async () => {
        throw Error("private-r2-error");
      },
    });
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      persistence: "failed",
      error: "persistence-failed",
    });
  });
});
