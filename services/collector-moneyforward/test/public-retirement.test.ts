import { expect, test } from "bun:test";
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
