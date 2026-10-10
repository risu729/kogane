import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { afterEach, expect, spyOn, test } from "bun:test";
import worker from "../src/worker";
import { alarmCollection } from "../src/worker";
import * as mobileAuth from "../src/mobile-auth";
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

test.each(["vpass-shared-collection", "vpass-daily-collection-complete", "all"])(
  "a throwing %s sink preserves a successful alarm and does not repeat requests or writes",
  async (sink) => {
    const records: Record<string, unknown>[] = [];
    let thrownLogs = 0;
    for (const method of ["log", "error"] as const) {
      const spy = spyOn(console, method).mockImplementation((value) => {
        const record = JSON.parse(String(value)) as { event: string };
        records.push(record);
        if (sink === "all" || record.event === sink) {
          thrownLogs++;
          throw new Error("private-logger-failure");
        }
      });
      restores.push(() => spy.mockRestore());
    }
    // Synthetic auth boundary: no real key, credential, session or provider request.
    const authSpies = [
      spyOn(mobileAuth, "assertPublicKeyHash").mockImplementation(() => {}),
      spyOn(mobileAuth, "buildConfigAuth").mockReturnValue("synthetic-config-auth"),
      spyOn(mobileAuth, "buildFirstLoginAuth").mockReturnValue("synthetic-login-auth"),
    ];
    restores.push(() => authSpies.forEach((spy) => spy.mockRestore()));
    const member = (content: Record<string, unknown>) =>
      Response.json({ header: { resultCode: 0 }, body: { content } });
    const responses = [
      Response.json(
        { status: 200 },
        {
          headers: {
            "x-vappsessiontime": "synthetic-time",
            "set-cookie": "sid=synthetic-cookie; Path=/",
          },
        },
      ),
      Response.json({ status: 200, data: { login_token: "synthetic-token" } }),
      member({
        DropdownListInitDisplayServiceBean: {
          multiCardInfoList: [{ name: "Synthetic card", value: "synthetic-card" }],
        },
      }),
      member({ MultiCardUpdateBean: { cardIdentifyKey: "synthetic-card" } }),
      member({ WebMeisaiTopDisplayServiceBean: { seikyuYMList: [{ value: "209901" }] } }),
      member({
        WebMeisaiTopDisplayServiceBean: {
          meisaiList: [],
          webMeisaiTopK3Vo: { allCnt: "0", nextPageRow: "1" },
        },
      }),
    ];
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          const response = responses.shift();
          if (!response) throw new Error("unexpected synthetic request");
          return response;
        },
        { preconnect: () => {} },
      ),
    );
    restores.push(() => fetcher.mockRestore());
    const data = new FakeR2Bucket();
    const env = {
      DATA: data,
      VPASS_AUTH_PUBLIC_KEY_B64: "c3ludGhldGlj",
      VPASS_CONFIG_PUBLIC_KEY_B64: "c3ludGhldGlj",
      VPASS_DEVICE_ID: "00000000-0000-4000-8000-000000000000",
      VPASS_ID: "synthetic-user",
      VPASS_PASSWORD: "synthetic-password",
    } as unknown as Parameters<typeof worker.scheduled>[1];
    const result = await alarmCollection(env, "0 21 * * *", Date.parse("2026-09-05T00:00:00Z"));
    expect(result, JSON.stringify({ requests: fetcher.mock.calls.length, records })).toEqual({
      status: "completed",
      runIds: ["2026-09-05T00-00-00-000Z-card-001"],
      failureCode: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(thrownLogs).toBeGreaterThan(0);
    expect(responses).toHaveLength(0);
    expect(data.putKeys).toHaveLength(data.entries.size);
    const terminals = [...data.entries].filter(([key]) => key.endsWith("/terminal.json"));
    expect(terminals).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(terminals[0]![1].bytes)).providerOutcome).toBe(
      "success",
    );
  },
);

test("scheduled login failure produces a correlated terminal record and safe R2 error", async () => {
  const records: Array<Record<string, unknown>> = [];
  for (const method of ["log", "error"] as const) {
    const spy = spyOn(console, method).mockImplementation((value) =>
      records.push(JSON.parse(String(value))),
    );
    restores.push(() => spy.mockRestore());
  }
  const data = new FakeR2Bucket();
  const env = {
    DATA: data,
  } as unknown as Parameters<typeof worker.scheduled>[1];
  await expect(
    worker.scheduled(
      { scheduledTime: Date.parse("2026-09-05T00:00:00Z") } as ScheduledController,
      env,
    ),
  ).rejects.toThrow("Missing Worker secret");
  expect(records).toContainEqual(
    expect.objectContaining({
      source: "vpass",
      stage: "session-open",
      outcome: "failed",
      category: "configuration",
    }),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      stage: "terminal",
      outcome: "failed",
      runId: "2026-09-05T00-00-00-000Z",
    }),
  );
  const terminal = [...data.entries].find(([key]) => key.endsWith("/terminal.json"));
  expect(terminal).toBeDefined();
  expect(JSON.parse(new TextDecoder().decode(terminal![1].bytes)).providerOutcome).toBe("failed");
});
