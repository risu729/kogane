import { expect, mock, test } from "bun:test";
mock.module("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => {
    throw Error("must-not-access-container");
  },
}));
const { default: worker } = await import("../src/worker");

const retired = ["/trigger"];
// Synthetic old bearer, spoofed Access headers, and RPC-shaped URLs cannot
// make public HTTP reach an environment binding, provider, or private RPC.
for (const path of [...retired, "/runOperation", "/runScheduled", "/rpc", "/alarmCollection"]) {
  for (const method of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
    for (const bearer of [null, "wrong-token", "formerly-valid-token"]) {
      test(`retired public route ${method} ${path}, bearer=${bearer ?? "missing"}`, async () => {
        let reads = 0;
        const bindings = new Proxy(
          {},
          {
            get() {
              reads++;
              throw Error("private-environment-must-not-be-read");
            },
          },
        );
        const headers: Record<string, string> = {
          "cf-access-jwt-assertion": "synthetic-forged-assertion",
          "cf-access-authenticated-user-email": "synthetic@example.invalid",
        };
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        const request = new Request(`https://collector.invalid${path}`, {
          method,
          headers,
          ...(method === "GET"
            ? {}
            : {
                body: JSON.stringify({
                  version: "kogane-collector-operation-v1",
                  action: "collect",
                }),
              }),
        });
        const fetch = worker.fetch as unknown as (
          request: Request,
          env: object,
          ctx: object,
        ) => Promise<Response>;
        const response = await fetch(request, bindings, {});
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('{"error":"Not found"}');
        expect(reads).toBe(0);
      });
    }
  }
}

test("relay bearer remains separate from the retired admin token and targets remain restricted", async () => {
  const relayToken = "synthetic-relay-token-".repeat(3);
  let otherReads = 0;
  const bindings = new Proxy(
    { RELAY_TOKEN: relayToken },
    {
      get(target, key) {
        if (key === "RELAY_TOKEN") return target.RELAY_TOKEN;
        otherReads++;
        throw Error("must-not-access-relay-network");
      },
    },
  );
  const fetch = worker.fetch as unknown as (
    request: Request,
    env: object,
    ctx: object,
  ) => Promise<Response>;
  for (const bearer of [null, "wrong-token", "formerly-valid-token", relayToken]) {
    const headers: Record<string, string> = { upgrade: "websocket" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const response = await fetch(
      new Request("https://collector.invalid/tcp?host=not-allowed.invalid&port=443", { headers }),
      bindings,
      {},
    );
    expect(response.status).toBe(bearer === relayToken ? 403 : 401);
  }
  expect(otherReads).toBe(0);
});
