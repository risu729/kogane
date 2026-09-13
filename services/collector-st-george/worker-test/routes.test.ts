import { expect, test } from "vitest";
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
