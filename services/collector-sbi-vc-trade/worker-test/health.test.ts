import { describe, expect, test } from "vitest";
import worker from "../src/worker";

const SCHEMA = "sbi-vc-trade-worker-poc-v1";
const TOKEN = "synthetic-admin-token";

// Synthetic requests have no edge metadata; the handler never reads request.cf.
function incomingRequest(url: string, init?: RequestInit): Parameters<typeof worker.fetch>[0] {
  return new Request(url, init) as Parameters<typeof worker.fetch>[0];
}

describe("deployment liveness", () => {
  test("public healthz reads only the schema version and returns no session state", async () => {
    const bindings = new Proxy(
      { COLLECTOR_SCHEMA_VERSION: SCHEMA },
      {
        get(target, key) {
          if (key === "COLLECTOR_SCHEMA_VERSION") return target.COLLECTOR_SCHEMA_VERSION;
          throw new Error(`unexpected binding access: ${String(key)}`);
        },
      },
    ) as unknown as Env;
    const response = await worker.fetch(incomingRequest("https://worker.test/healthz"), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", schemaVersion: SCHEMA });
  });

  test("admin routes and other healthz methods still reject anonymous requests", async () => {
    const bindings = { ADMIN_TOKEN: TOKEN } as Env;
    for (const [path, method] of [
      ["/health", "GET"],
      ["/healthz", "POST"],
      ["/run", "POST"],
      ["/reauth", "POST"],
      ["/collect", "POST"],
    ]) {
      const response = await worker.fetch(
        incomingRequest(`https://worker.test${path}`, { method }),
        bindings,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  test("the authenticated health route retains its session diagnostics", async () => {
    const bindings = {
      ADMIN_TOKEN: TOKEN,
      SESSION_STATE: {
        getByName: () => ({
          getHealth: async () => ({
            lastHttpStatus: null,
            lastErrorCode: null,
            lastReauthErrorCode: null,
          }),
        }),
      },
    } as unknown as Env;
    const response = await worker.fetch(
      incomingRequest("https://worker.test/health", {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      bindings,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      lastHttpStatus: null,
      lastErrorCode: null,
      lastReauthErrorCode: null,
      waitingForHuman: false,
    });
  });
});
