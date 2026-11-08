import { expect, test, vi } from "vitest";
import worker, { alarmCollection } from "../src/worker";
const token = "synthetic-relay-token-00000000000000000000";
const context = { waitUntil() {} } as unknown as ExecutionContext;
test("alarm retains durable refusal and persistence reasons without a second request", async () => {
  const cases = [
    [
      { status: "blocked", reason: "login-rejected", runId: "synthetic-run" },
      { status: "failed", failureCode: "st_george_login_rejected", runIds: ["synthetic-run"] },
    ],
    [
      { status: "failed", reason: "persistence-incomplete" },
      { status: "failed", failureCode: "terminal_persistence_failed", runIds: [] },
    ],
    [
      { status: "blocked", reason: "synthetic_secret" },
      { status: "failed", failureCode: "collection_failed", runIds: [] },
    ],
    [
      { status: "stored", runId: "synthetic-run" },
      { status: "completed", failureCode: null, runIds: ["synthetic-run"] },
    ],
  ] as const;
  for (const [body, expected] of cases) {
    const fetch = vi.fn(async () => Response.json(body));
    const env = {
      SESSION_STATE: { idFromName: () => "test", get: () => ({ fetch }) },
    } as unknown as Env;
    expect(await alarmCollection(env, "35 21 * * *", 0)).toEqual(expected);
    expect(fetch).toHaveBeenCalledOnce();
  }
});
function bindings(): Env {
  return {
    RELAY_TOKEN: token,
    COLLECTOR_SCHEMA_VERSION: "st-george-browser-v1",
  } as Env;
}
test("health works without credentials; there is no public trigger or resume", async () => {
  const fetch = vi.fn(async () => Response.json({ status: "stored" }));
  const env = {
    ...bindings(),
    SESSION_STATE: { idFromName: () => "test", get: () => ({ fetch }) },
  } as unknown as Env;
  expect(
    await (await worker.fetch(new Request("https://test/health"), env, context)).json(),
  ).toEqual({ ok: true, source: "st-george", schemaVersion: "st-george-browser-v1" });
  for (const path of ["/trigger", "/resume", "/operator-trigger"])
    for (const headers of [{}, { authorization: `Bearer ${token}` }]) {
      const response = await worker.fetch(
        new Request(`https://test${path}`, { method: "POST", headers }),
        env,
        context,
      );
      expect(response.status).toBe(404);
    }
  expect(fetch).not.toHaveBeenCalled();
});
test("an operations request reaches the coordinator as the operator's request; the alarm does not", async () => {
  const urls: string[] = [];
  const fetch = vi.fn(async (request: Request) => {
    urls.push(request.url);
    return Response.json({ status: "stored", runId: "synthetic-run" });
  });
  const env = {
    SESSION_STATE: { idFromName: () => "test", get: () => ({ fetch }) },
  } as unknown as Env;
  await alarmCollection(env, "35 21 * * *", 0);
  await alarmCollection(env, "35 21 * * *", 0, { operatorRequested: true });
  expect(urls).toEqual(["https://state/trigger", "https://state/operator-trigger"]);
});
test("the Tamia relay rejects unauthenticated or arbitrary destinations before any socket opens", async () => {
  const env = bindings();
  const request = (headers: Record<string, string>) =>
    new Request("https://test/tcp?host=example.com&port=443", {
      headers: { upgrade: "websocket", ...headers },
    });
  expect((await worker.fetch(request({}), env, context)).status).toBe(401);
  expect(
    (await worker.fetch(request({ authorization: `Bearer ${token}` }), env, context)).status,
  ).toBe(403);
});

test("daily collection disables platform retries before entering the shared coordinator", async () => {
  for (const status of [200, 409]) {
    const noRetry = vi.fn();
    const fetch = vi.fn(async (request: Request) => {
      expect(noRetry).toHaveBeenCalledOnce();
      expect(request.url).toBe("https://state/trigger");
      expect(request.method).toBe("POST");
      return new Response(null, { status });
    });
    const idFromName = vi.fn((name: string) => {
      expect(noRetry).toHaveBeenCalledOnce();
      expect(name).toBe("st-george");
      return "test";
    });
    const get = vi.fn((id: string) => {
      expect(noRetry).toHaveBeenCalledOnce();
      expect(id).toBe("test");
      return { fetch };
    });
    const env = {
      ...bindings(),
      SESSION_STATE: { idFromName, get },
    } as unknown as Env;
    const result = worker.scheduled({ noRetry } as unknown as ScheduledController, env);
    if (status === 200) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("st-george-collection-not-completed");
    expect(idFromName).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  }
});
