// The keepalive's stored health record and log lines carry closed codes only
// (AGENTS.md; docs/sources/sbi-vc-trade.md). The gateway's own status string
// is provider text: a rejection is recorded as `rejected`, never as what the
// gateway said.
import { env, applyD1Migrations, runInDurableObject, type D1Migration } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { HealthState } from "../src/types";

const testEnv = env as Env & { SCHEDULE_TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.SCHEDULE_DB, testEnv.SCHEDULE_TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

// Synthetic values only; the marker stands in for whatever the gateway says.
const MARKER = "PRIVATE_GATEWAY_STATUS_MARKER_7f3a";
const SEED = JSON.stringify({
  cookies: {
    vctBffSid: "sid",
    jSessionId: "jsession",
    awsAlbApp: ["app0", "app1", "app2", "app3"],
    awsAlb: "alb",
    awsAlbCors: "cors",
  },
  secureKey: "secure",
});
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function gateway(status: string): Response {
  return new Response(JSON.stringify({ meta: { status }, body: {} }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function keepAlive(name: string, status: string) {
  const stub = env.SESSION_STATE.getByName(name);
  return runInDurableObject(stub, async (instance, state) => {
    // The seed and key are this test's synthetic secrets.
    Object.assign((instance as unknown as { env: Env }).env, {
      SESSION_SEED: SEED,
      SESSION_ENCRYPTION_KEY: KEY,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(gateway(status));
    const lines: string[] = [];
    for (const level of ["log", "warn", "error"] as const)
      vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
        lines.push(values.map(String).join(" "));
      });
    const health = await instance.runKeepAlive();
    const stored = await state.storage.get<HealthState>("health");
    return { health, stored, lines };
  });
}

test("a rejected gateway status is stored and logged as a closed code, never its text", async () => {
  const { health, stored, lines } = await keepAlive("keepalive-rejected", MARKER);
  expect(health).toMatchObject({
    lastGatewayStatus: "rejected",
    lastErrorCode: "gateway_rejected",
    lastHttpStatus: 200,
    consecutiveFailures: 1,
  });
  expect(stored).toEqual(health);
  expect(JSON.stringify(stored)).not.toContain(MARKER);
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.join("\n")).not.toContain(MARKER);
});

test("a health record holding a gateway string from before is read as rejected", async () => {
  const stub = env.SESSION_STATE.getByName("keepalive-legacy-record");
  const health = await runInDurableObject(stub, async (instance, state) => {
    await state.storage.put("health", { lastGatewayStatus: MARKER, consecutiveFailures: 1 });
    return instance.getHealth();
  });
  expect(health).toMatchObject({ lastGatewayStatus: "rejected", consecutiveFailures: 1 });
  expect(JSON.stringify(health)).not.toContain(MARKER);
});

test("an accepted gateway status is stored as OK", async () => {
  const { health, stored, lines } = await keepAlive("keepalive-accepted", "OK");
  expect(health).toMatchObject({
    lastGatewayStatus: "OK",
    lastErrorCode: null,
    consecutiveFailures: 0,
  });
  expect(stored).toEqual(health);
  expect(lines.join("\n")).toContain("sbi_vc_keepalive");
});

test.each([401, 403, 200])(
  "a refused session waits for refresh without replaying it (HTTP %s)",
  async (status) => {
    const stub = env.SESSION_STATE.getByName(`refresh-required-${status}`);
    await runInDurableObject(stub, async (instance, state) => {
      Object.assign((instance as unknown as { env: Env }).env, {
        SESSION_SEED: SEED,
        SESSION_ENCRYPTION_KEY: KEY,
      });
      const fetched = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(status === 200 ? gateway("rejected") : new Response(null, { status }));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const refused = await instance.runKeepAlive();
      expect(refused.sessionRefreshRequired).toBe(true);
      expect(await state.storage.get<HealthState>("health")).toEqual(refused);
      // Neither repeated alarms nor a failed login can make this seed usable.
      expect(await instance.runKeepAlive()).toEqual(refused);
      const login = await instance.runReauthenticate();
      expect(login.lastReauthErrorCode).not.toBeNull();
      expect(login.sessionRefreshRequired).toBe(true);
      expect(await instance.runKeepAlive()).toEqual(login);
      expect(fetched).toHaveBeenCalledOnce();
      expect(login.consecutiveFailures).toBe(1);
    });
  },
);

test("a server error can be probed again without invalidating the session", async () => {
  const stub = env.SESSION_STATE.getByName("retry-server-error");
  await runInDurableObject(stub, async (instance) => {
    Object.assign((instance as unknown as { env: Env }).env, {
      SESSION_SEED: SEED,
      SESSION_ENCRYPTION_KEY: KEY,
    });
    const fetched = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(gateway("OK"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await instance.runKeepAlive()).sessionRefreshRequired).toBe(false);
    expect((await instance.runKeepAlive()).lastErrorCode).toBeNull();
    expect(fetched).toHaveBeenCalledTimes(2);
  });
});
