import { expect, test, vi } from "vitest";
import worker from "../src/worker";

test("SMBC Access context and same-origin guards survive unused admin secret retirement", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let reads = 0;
  const poisoned = new Proxy(
    {},
    {
      get() {
        reads++;
        throw Error("must-not-read-secret-or-state");
      },
    },
  );
  const fetch = worker.fetch as unknown as (
    request: Request,
    env: object,
    ctx: object,
  ) => Promise<Response>;
  try {
    for (const path of ["/", "/api/status", "/api/start", "/api/finish", "/api/publish"]) {
      const response = await fetch(
        new Request(`https://collector.invalid${path}`, {
          method: path.startsWith("/api/") && path !== "/api/status" ? "POST" : "GET",
          headers: {
            authorization: "Bearer formerly-valid-token",
            "cf-access-jwt-assertion": "synthetic-forged-assertion",
          },
        }),
        poisoned,
        {},
      );
      expect(response.status).toBe(403);
    }
    expect(reads).toBe(0);
    let operations = 0;
    const env = {
      BACKFILL_SESSION: {
        getByName: () =>
          new Proxy(
            {},
            {
              get() {
                operations++;
                throw Error("must-not-start");
              },
            },
          ),
      },
    };
    const ctx = { access: { getIdentity: async () => ({ user_uuid: "synthetic-human" }) } };
    for (const path of ["/api/start", "/api/finish", "/api/publish"]) {
      const response = await fetch(
        new Request(`https://collector.invalid${path}`, {
          method: "POST",
          headers: { origin: "https://other.invalid", "content-type": "application/json" },
          body: "{}",
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(400);
    }
    expect(operations).toBe(0);
  } finally {
    log.mockRestore();
    errorLog.mockRestore();
  }
});
