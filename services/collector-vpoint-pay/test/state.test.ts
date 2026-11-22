import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { afterEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
const { VPointPayCredentialState } = await import("../src/state");
const { default: worker } = await import("../src/worker");

const UUID = "00112233-4455-6677-8899-aabbccddeeff";

function fixture(stored: Record<string, string>, secrets: Partial<Env>) {
  let writes = 0;
  const state = Object.assign({} as DurableObjectState, {
    storage: {
      get: async (key: string) => stored[key],
      put: async () => {
        writes++;
      },
    },
  });
  const instance = new VPointPayCredentialState(state, secrets as Env);
  return { instance, writes: () => writes };
}

describe("V Point Pay readiness without credential changes", () => {
  test("diagnostic reads prefer rotated state and never reseed from old secrets", async () => {
    const f = fixture(
      { "refresh-token": "rotated-test-token", "device-uuid": UUID },
      {
        VPOINT_PAY_REFRESH_TOKEN: "old-test-token",
        VPOINT_PAY_DEVICE_UUID: "invalid-old-test-device",
      },
    );
    expect(await f.instance.credentialStatus()).toEqual({
      source: "durable-object",
      structurallyReady: true,
      missingFields: [],
      invalidFields: [],
    });
    expect(f.writes()).toBe(0);
  });

  test("partial state diagnosis does not combine a token with an unpaired UUID", async () => {
    const f = fixture(
      { "refresh-token": "rotated-test-token" },
      {
        VPOINT_PAY_DEVICE_UUID: UUID,
      },
    );
    expect(await f.instance.credentialStatus()).toEqual({
      source: "worker-secrets",
      structurallyReady: false,
      missingFields: ["refresh-token"],
      invalidFields: [],
    });
    expect(f.writes()).toBe(0);
  });

  test("invalid reset preserves existing credentials without writing", async () => {
    const f = fixture(
      { "refresh-token": "rotated-test-token", "device-uuid": UUID },
      {
        VPOINT_PAY_REFRESH_TOKEN: "old-test-token",
        VPOINT_PAY_DEVICE_UUID: "invalid-device",
      },
    );
    await expect(f.instance.resetFromSecrets()).rejects.toThrow("invalid=device-uuid");
    expect(f.writes()).toBe(0);
  });

  test("retired credential diagnostics never read state", async () => {
    let reads = 0;
    const env = Object.assign({} as Env, {
      ADMIN_TRIGGER_TOKEN: "admin-test-only",
      VPOINT_PAY_STATE: {
        idFromName: () => {
          reads++;
        },
      },
    });
    const response = await worker.fetch(
      new Request("https://collector.test/credential-status", { method: "POST" }),
      env,
    );
    expect(response.status).toBe(404);
    expect(reads).toBe(0);
  });
});

describe("retired V Point Pay app collector", () => {
  test("manual provider and credential mutation routes never touch state", async () => {
    let calls = 0;
    const env = Object.assign({} as Env, {
      ADMIN_TRIGGER_TOKEN: "admin-test-only",
      VPOINT_PAY_STATE: {
        idFromName: () => {
          calls++;
          throw new Error("must not access state");
        },
      },
    });
    for (const path of ["/trigger", "/probe", "/reset-credentials"]) {
      const response = await worker.fetch(
        new Request(`https://collector.test${path}`, {
          method: "POST",
          headers: { authorization: "Bearer admin-test-only" },
        }),
        env,
      );
      expect(response.status).toBe(410);
    }
    expect(calls).toBe(0);
  });

  test("health clearly distinguishes a disabled collector", async () => {
    const response = await worker.fetch(new Request("https://collector.test/health"), {} as Env);
    expect(await response.json()).toMatchObject({
      collectionEnabled: false,
      status: "disabled",
      reason: "email_only",
    });
  });

  test("delayed scheduled events need no environment and do not collect", async () => {
    await expect(worker.scheduled()).resolves.toBeUndefined();
  });
});

// INV05: a run that did not finish its collection never learned how many
// months and transactions it read, so its result and its persisted line leave
// both counts out instead of reporting 0. A finished run reports what it read,
// including a known 0 for a month with no transaction. The provider is a
// mocked `fetch`; nothing leaves the test.
describe("V Point Pay run counts are reported only when the collection finished", () => {
  const PRIVATE = "private-provider-body";
  const COUNT_FIELDS = ["transactionMonthCount", "transactionCount"] as const;
  afterEach(() => {
    mock.restore();
    setSystemTime();
  });

  async function run(options: {
    stored?: Record<string, string>;
    inquiryPeriod?: string;
    failingPath?: string;
    noTransactions?: boolean;
    thrown?: unknown;
  }) {
    setSystemTime(new Date("2026-08-31T00:00:00Z"));
    const lines: Array<Record<string, unknown>> = [];
    for (const method of ["log", "error"] as const)
      spyOn(console, method).mockImplementation((value) => {
        lines.push(JSON.parse(String(value)) as Record<string, unknown>);
      });
    spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (Object.hasOwn(options, "thrown")) throw options.thrown;
      if (options.failingPath !== undefined && url.pathname.endsWith(options.failingPath))
        return new Response(PRIVATE, { status: 503 });
      if (url.pathname.endsWith("/token"))
        return Response.json({
          access_token: "access-value",
          refresh_token: "new-refresh",
          created_at: 1,
          expires_in: 3600,
        });
      if (url.pathname.endsWith("/balance"))
        return Response.json({
          currency_code: "JPY",
          account_balance: "100",
          charge_limit: {},
          inquiry_period: options.inquiryPeriod ?? "202607",
        });
      const month = url.searchParams.get("target_month");
      return Response.json({
        tran_month: month,
        agr_num: "masked-in-test",
        crd_num_last_4_digits: "0000",
        tran_list: month === "202608" && !options.noTransactions ? [{ tran_amt: "10" }] : [],
      });
    }) as typeof fetch);
    const storage = new Map(Object.entries(options.stored ?? {}));
    const state = Object.assign({} as DurableObjectState, {
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (entries: string | Record<string, string>, value?: string) => {
          if (typeof entries === "string") storage.set(entries, value!);
          else for (const [key, entry] of Object.entries(entries)) storage.set(key, entry);
        },
      },
    });
    const instance = new VPointPayCredentialState(state, {
      COLLECTOR_SCHEMA_VERSION: "test",
      DATA: new FakeR2Bucket(),
    } as unknown as Env);
    const result = await instance.runCollection();
    const persisted = lines.filter((line) => line.event === "vpoint-pay-collection-persisted");
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(PRIVATE);
    return { result, line: persisted[0]! };
  }
  const credential = { "refresh-token": "old-refresh", "device-uuid": UUID };

  for (const [label, inquiryPeriod, noTransactions, counts] of [
    ["two months", "202607", false, { transactionMonthCount: 2, transactionCount: 1 }],
    [
      "a month with no transaction",
      "202608",
      true,
      { transactionMonthCount: 1, transactionCount: 0 },
    ],
  ] as const) {
    test(`a finished run reports its counts (${label})`, async () => {
      const { result, line } = await run({ stored: credential, inquiryPeriod, noTransactions });
      expect(result.status).toBe("success");
      expect(result).toMatchObject(counts);
      expect(line).toMatchObject(counts);
    });
  }

  for (const failingPath of ["/token", "/balance", "/transaction"]) {
    test(`a run stopped at ${failingPath} leaves both counts out`, async () => {
      const { result, line } = await run({ stored: credential, failingPath });
      expect(result.status).toBe("failed");
      expect(line).toMatchObject({ status: "failed", failureCount: 1 });
      for (const field of COUNT_FIELDS) {
        expect(Object.hasOwn(result, field)).toBe(false);
        expect(Object.hasOwn(line, field)).toBe(false);
      }
    });
  }

  test("a run with no credential leaves both counts out and asks nothing", async () => {
    const { result, line } = await run({});
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    for (const field of COUNT_FIELDS) {
      expect(Object.hasOwn(result, field)).toBe(false);
      expect(Object.hasOwn(line, field)).toBe(false);
    }
  });

  // The run's failure entry states closed codes only: a thrown name is
  // whatever its thrower chose and a message can carry provider text, so
  // neither is kept (docs/collection.md, `v-point-pay`).
  test.each([
    ["a custom name", Object.assign(new Error(PRIVATE), { name: "PrivateProviderName" })],
    ["a non-Error value", PRIVATE],
    [
      "a throwing name getter",
      Object.defineProperty(new Error(PRIVATE), "name", {
        get() {
          throw new Error(PRIVATE);
        },
      }),
    ],
  ])("a failure thrown with %s is stored as closed codes", async (_label, thrown) => {
    const { result } = await run({ stored: credential, thrown });
    expect(result.status).toBe("failed");
    expect(result.failures).toEqual([
      { operation: "collect", errorType: "UnknownError", message: "operation_failed" },
    ]);
    expect(JSON.stringify(result)).not.toContain("Private");
    expect(JSON.stringify(result)).not.toContain(PRIVATE);
  });
  test("a provider HTTP failure keeps its own closed name and code", async () => {
    const { result } = await run({ stored: credential, failingPath: "/balance" });
    expect(result.failures).toEqual([
      { operation: "collect", errorType: "VPointPayHttpError", message: "provider_http_failed" },
    ]);
  });
});
