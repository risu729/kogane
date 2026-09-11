import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ApiError } from "../web/src/api.ts";
import { evidenceRawUrl, getEvidenceJson } from "../web/src/evidence-api.ts";
import { evidenceFixture } from "./evidence-client-fixture.ts";

let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});
const path = "/api/evidence/v1/meta";
const signal = () => new AbortController().signal;
function serve(response: Response): void {
  fetchSpy?.mockRestore();
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(response);
}
async function errorFor(requestPath = path): Promise<ApiError> {
  try {
    await getEvidenceJson(requestPath, signal());
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected API failure");
}
describe("production evidence JSON client", () => {
  test("uses cancellable same-origin no-store requests without redirect following or local fallback", async () => {
    const { meta } = evidenceFixture();
    serve(Response.json(meta));
    const abortSignal = signal();
    expect(await getEvidenceJson<typeof meta>(path, abortSignal)).toEqual(meta);
    expect(fetchSpy!.mock.calls).toHaveLength(1);
    expect(fetchSpy!.mock.calls[0]![0]).toBe(path);
    expect(fetchSpy!.mock.calls[0]![1]).toMatchObject({
      signal: abortSignal,
      credentials: "same-origin",
      cache: "no-store",
      redirect: "manual",
    });
  });
  test("auth and HTTP failures have fixed messages and never retain private response bodies", async () => {
    for (const status of [401, 403, 404, 429, 500]) {
      const response = new Response("private-account-provider-token", {
        status,
        statusText: "private-secret",
      });
      serve(response);
      const error = await errorFor();
      expect(error.status).toBe(status);
      expect(error.message).not.toContain("private");
      expect(error.cause).toBeUndefined();
      expect(response.bodyUsed).toBe(false);
      expect(fetchSpy!.mock.calls).toHaveLength(1);
    }
  });
  test("login redirects cannot become empty or successful records", async () => {
    serve(
      new Response(null, { status: 302, headers: { location: "https://auth.test/private-token" } }),
    );
    const error = await errorFor();
    expect(error.status).toBe(401);
    expect(error.message).toContain("認証");
    expect(error.message).not.toContain("private");
  });
  test("browser opaque redirects require authentication without consuming the login response", async () => {
    const response = new Response(null);
    Object.defineProperties(response, {
      type: { value: "opaqueredirect" },
      status: { value: 0 },
      ok: { value: false },
    });
    serve(response);
    const error = await errorFor();
    expect(error.status).toBe(401);
    expect(error.message).toContain("認証");
    expect(response.bodyUsed).toBe(false);
    expect(fetchSpy!.mock.calls).toHaveLength(1);
  });
  test("invalid success bodies and mismatched identities are rejected without body leakage", async () => {
    for (const response of [
      new Response("private-html", { headers: { "content-type": "text/html" } }),
      new Response('{"private-secret":', { headers: { "content-type": "application/json" } }),
      Response.json({ private: "provider-secret" }),
    ]) {
      serve(response);
      expect((await errorFor()).message).not.toContain("private");
    }
    const { detail } = evidenceFixture();
    serve(Response.json(detail));
    expect((await errorFor("/api/evidence/v1/runs/r_42/artifacts/a_8")).message).toContain(
      "識別子",
    );
  });
  test("network exceptions stay private while cancellation remains cancellation", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("private-network-url"));
    const error = await errorFor();
    expect(error.status).toBe(0);
    expect(error.message).not.toContain("private");
    const controller = new AbortController();
    controller.abort();
    await expect(getEvidenceJson(path, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });
  test("raw links contain validated scoped identities and never trigger a byte fetch", () => {
    fetchSpy = spyOn(globalThis, "fetch");
    expect(evidenceRawUrl("r_42", "a_7")).toBe("/api/evidence/v1/runs/r_42/artifacts/a_7/raw");
    for (const id of ["r_0", "r_01", "r_9007199254740992", "../other", "r_1/private"])
      expect(() => evidenceRawUrl(id, "a_7")).toThrow(ApiError);
    expect(() => evidenceRawUrl("r_42", "a_0")).toThrow(ApiError);
    expect(fetchSpy.mock.calls).toHaveLength(0);
  });
  test("unknown paths fail before any network request", async () => {
    fetchSpy = spyOn(globalThis, "fetch");
    expect((await errorFor("/api/transactions")).status).toBe(400);
    expect(fetchSpy.mock.calls).toHaveLength(0);
  });
});
