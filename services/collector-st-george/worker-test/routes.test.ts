import { expect, test, vi } from "vitest";
import worker from "../src/worker";
const token = "synthetic-admin-token-00000000000000000000";
const context = { waitUntil() {} } as unknown as ExecutionContext;
function bindings(): Env {
  return {
    ADMIN_TRIGGER_TOKEN: token,
    RELAY_TOKEN: token,
    COLLECTOR_SCHEMA_VERSION: "st-george-browser-v1",
  } as Env;
}
test("health works without credentials; collection and resume require the admin token", async () => {
  const env = bindings();
  expect(
    await (await worker.fetch(new Request("https://test/health"), env, context)).json(),
  ).toEqual({ ok: true, source: "st-george", schemaVersion: "st-george-browser-v1" });
  for (const path of ["/trigger", "/resume"]) {
    expect(
      (await worker.fetch(new Request(`https://test${path}`, { method: "POST" }), env, context))
        .status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          new Request(`https://test${path}?range=all`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          }),
          env,
          context,
        )
      ).status,
    ).toBe(400);
  }
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

test("empty POST streams reach the coordinator; any request bytes are rejected", async () => {
  const fetch = vi.fn(async () => Response.json({ status: "ready" }));
  const env = {
    ...bindings(),
    SESSION_STATE: { idFromName: () => "test", get: () => ({ fetch }) },
  } as unknown as Env;
  for (const path of ["/trigger", "/resume"]) {
    for (const body of [null, "", new Uint8Array()]) {
      const response = await worker.fetch(
        new Request(`https://test${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body,
        }),
        env,
        context,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ready" });
    }
    for (const body of [" ", "{}", "credentials=synthetic"]) {
      expect(
        (
          await worker.fetch(
            new Request(`https://test${path}`, {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-length": "0" },
              body,
            }),
            env,
            context,
          )
        ).status,
      ).toBe(400);
    }
  }
  expect(fetch).toHaveBeenCalledTimes(6);
});

test("nonempty streamed input is cancelled before coordinator access", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel,
  });
  const response = await worker.fetch(
    new Request("https://test/trigger", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body,
    }),
    bindings(),
    context,
  );
  expect(response.status).toBe(400);
  expect(cancel).toHaveBeenCalledOnce();
});

test("daily collection disables platform retries before entering the shared coordinator", async () => {
  for (const status of [200, 409]) {
    const noRetry = vi.fn();
    const fetch = vi.fn(async () => {
      expect(noRetry).toHaveBeenCalledOnce();
      return new Response(null, { status });
    });
    const env = {
      ...bindings(),
      SESSION_STATE: { idFromName: () => "test", get: () => ({ fetch }) },
    } as unknown as Env;
    const result = worker.scheduled({ noRetry } as unknown as ScheduledController, env);
    if (status === 200) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("st-george-collection-not-completed");
    expect(fetch).toHaveBeenCalledOnce();
  }
});
