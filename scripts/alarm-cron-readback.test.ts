import { expect, test } from "bun:test";
import { verifyAlarmCronRemoval } from "../tasks/_lib/ci/alarm-cron-readback.mjs";
const accountId = "a".repeat(32);
const jobs = [
  { enabled: true, worker: "collector-test" },
  { enabled: true, worker: "collector-test" },
  { enabled: true, worker: "processor-test" },
  { enabled: false, worker: null },
];
test("Cron readback deduplicates enabled Workers and never changes triggers", async () => {
  const seen: string[] = [];
  const count = await verifyAlarmCronRemoval({
    jobs,
    accountId,
    token: "synthetic",
    fetchImpl: async (url: string, init: RequestInit) => {
      seen.push(url);
      expect(init.method).toBeUndefined();
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer synthetic");
      return Response.json({ success: true, result: { schedules: [] } });
    },
  });
  expect(count).toBe(2);
  expect(seen).toHaveLength(2);
  expect(seen[0]).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/collector-test/schedules`,
  );
});
test("a remaining Cron, missing response shape or failed authentication stops activation", async () => {
  for (const response of [
    Response.json({ success: true, result: { schedules: [{ cron: "*/5 * * * *" }] } }),
    Response.json({ success: true, result: {} }),
    new Response("synthetic provider text", { status: 401 }),
  ]) {
    let calls = 0;
    await expect(
      verifyAlarmCronRemoval({
        jobs,
        accountId,
        token: "synthetic",
        fetchImpl: async () => {
          calls++;
          return response;
        },
      }),
    ).rejects.toThrow(/^schedule_cron_readback_/u);
    expect(calls).toBe(1);
  }
});
test("invalid credentials or Worker identities cannot send an API request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return Response.json({});
  };
  for (const args of [
    { jobs, accountId: "bad", token: "synthetic" },
    { jobs, accountId, token: "" },
    { jobs: [{ enabled: true, worker: "../other" }], accountId, token: "synthetic" },
  ])
    await expect(verifyAlarmCronRemoval({ ...args, fetchImpl })).rejects.toThrow(
      /^schedule_cron_readback_/u,
    );
  expect(calls).toBe(0);
});

test("transport and malformed responses produce closed codes without replay", async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error("synthetic sensitive transport detail");
    },
    async () => new Response("not JSON"),
    async () => Response.json(null),
  ]) {
    try {
      await verifyAlarmCronRemoval({ jobs, accountId, token: "synthetic", fetchImpl });
      throw new Error("expected readback rejection");
    } catch (error) {
      expect((error as Error).message).toMatch(
        /^schedule_cron_readback_(unavailable|invalid_response)$/u,
      );
    }
  }
});
