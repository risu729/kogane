import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VPointSession } from "../src/session";
import {
  FUMI_MANIFEST_JSON,
  FUMI_MANIFEST_VERSION,
  FUMI_PLUGIN_ID,
  fumiRequestSha256,
  sha256,
  type FumiOfferRequest,
} from "../src/fumi-offer";
import { VPOINT_EMAIL_SUBJECT } from "../src/email";

const stubs: DurableObjectStub<VPointSession>[] = [];
beforeAll(async () => {
  // The real lease API needs only its operational table, not the financial schema.
  await env.SCHEDULE_DB.exec(
    "CREATE TABLE IF NOT EXISTS collection_execution_leases (source TEXT PRIMARY KEY,lease_ref TEXT,started_at TEXT,heartbeat_at TEXT)",
  );
});
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected synthetic network request"),
  );
});
afterEach(async () => {
  for (const stub of stubs.splice(0))
    await runInDurableObject(stub, async (_instance, state) => state.storage.deleteAll());
  vi.restoreAllMocks();
});
async function fixture(age = 1000) {
  const stub = env.VPOINT_SESSION.get(env.VPOINT_SESSION.newUniqueId());
  stubs.push(stub);
  const requestedAt = new Date(Date.now() - age).toISOString();
  await runInDurableObject(stub, async (_instance, state) =>
    state.storage.put("email-challenge", {
      version: 1,
      requestedAt,
      codePageUrl: "https://tsite.jp/tm/pc/login/STKIp0002042.do",
      codeForm: [["org.apache.struts.taglib.html.TOKEN", "synthetic-token"]],
      cookies: [],
    }),
  );
  const receivedAt = new Date().toISOString();
  const request: FumiOfferRequest = {
    schemaVersion: 1,
    kind: "owner",
    operationId: "a".repeat(64),
    requestSha256: "",
    attempt: { generation: 1, expiresAt: Date.now() + 5000 },
    source: { eventId: "b".repeat(64), rawSha256: "c".repeat(64), receivedAt },
    pluginId: FUMI_PLUGIN_ID,
    manifestVersion: FUMI_MANIFEST_VERSION,
    manifestSha256: await sha256(FUMI_MANIFEST_JSON),
    input: {
      subject: VPOINT_EMAIL_SUBJECT,
      text: "認証コード 123456\n--------------------\nhttps://example.invalid/12345",
      envelope: {
        from: "provider@example.invalid",
        to: "synthetic-otp@example.invalid",
        receivedAt,
      },
    },
  };
  request.requestSha256 = await fumiRequestSha256(request);
  return { stub, request };
}
const status = (request: FumiOfferRequest) => ({
  schemaVersion: 1 as const,
  operationId: request.operationId,
  requestSha256: request.requestSha256,
});
async function pauseAlarm(stub: DurableObjectStub<VPointSession>) {
  await runInDurableObject(stub, async (_instance, state) =>
    state.storage.setAlarm(Date.now() + 600_000),
  );
}
function provider() {
  return vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!["tsite.jp", "mypage.tsite.jp"].includes(url.hostname))
      throw new Error("Unexpected synthetic host");
    if (url.pathname.endsWith("STKIp0002045.do"))
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://mypage.tsite.jp/?hid=1",
          "set-cookie": "AUTH=synthetic; Domain=tsite.jp; Path=/; Secure",
        },
      });
    if (url.pathname.startsWith("/api/"))
      return Response.json({
        status: { code: "0000" },
        results:
          url.pathname.endsWith("tpoint_history") || url.pathname.endsWith("tmoney_history")
            ? { total: 0, history: [], graph: {} }
            : {},
      });
    return new Response("<html>synthetic</html>");
  });
}
describe("private durable owner offers", () => {
  it("accepts once, survives eviction, and rejects a changed immutable request", async () => {
    const { stub, request } = await fixture();
    expect((await stub.fumiOffer(request)).result).toBe("handled");
    await pauseAlarm(stub);
    await evictDurableObject(stub);
    expect(await stub.fumiReceipt(status(request))).toEqual({
      ...status(request),
      result: "handled",
    });
    expect(await stub.fumiOffer({ ...request, attempt: { generation: 2, expiresAt: 0 } })).toEqual({
      ...status(request),
      result: "handled",
    });
    const changed = { ...request, input: { ...request.input, text: "5678" } };
    changed.requestSha256 = await fumiRequestSha256(changed);
    expect((await stub.fumiOffer(changed)).result).toBe("rejected");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("serializes two operations against one challenge without two external attempts", async () => {
    const { stub, request } = await fixture();
    const second = {
      ...request,
      operationId: "d".repeat(64),
      source: { ...request.source, rawSha256: "e".repeat(64) },
    };
    second.requestSha256 = await fumiRequestSha256(second);
    const results = await Promise.all([stub.fumiOffer(request), stub.fumiOffer(second)]);
    await pauseAlarm(stub);
    expect(results.map((value) => value.result).sort()).toEqual(["handled", "retryable_error"]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("returns no-claim fallback for unrelated, ambiguous, pre-request and expired mail", async () => {
    for (const change of ["subject", "recipient", "ambiguous", "pre-request", "expired"]) {
      const { stub, request } = await fixture(change === "expired" ? 61_000 : 1000);
      if (change === "subject") request.input.subject = "Unrelated OTP";
      if (change === "recipient") request.input.envelope!.to = "other@example.invalid";
      if (change === "ambiguous") request.input.text = "1234 and 5678";
      if (change === "pre-request")
        request.source.receivedAt = request.input.envelope!.receivedAt = new Date(
          Date.now() - 10_000,
        ).toISOString();
      request.requestSha256 = await fumiRequestSha256(request);
      expect((await stub.fumiOffer(request)).result).toBe("not_applicable");
      expect((await stub.fumiReceipt(status(request))).result).toBe("not_applicable");
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("rejects stale attempt claims and exposes not_found only while nothing was accepted", async () => {
    const { stub, request } = await fixture();
    request.attempt.expiresAt = Date.now() - 1;
    expect((await stub.fumiOffer(request)).result).toBe("retryable_error");
    expect((await stub.fumiReceipt(status(request))).result).toBe("not_found");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("continues durable auth through collection and a terminal, without retaining OTP bytes", async () => {
    const calls = provider();
    const { stub, request } = await fixture();
    expect((await stub.fumiOffer(request)).result).toBe("handled");
    await pauseAlarm(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await pauseAlarm(stub);
    expect(await stub.getSession()).toContain("AUTH=synthetic");
    const mid = await runInDurableObject(stub, async (_instance, state) =>
      state.storage.get("fumi:job"),
    );
    expect(JSON.stringify(mid)).not.toContain("123456");
    expect(JSON.stringify(mid)).not.toContain("synthetic-token");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(`fumi:receipt:${request.operationId}`),
      ),
    ).toMatchObject({ state: "complete", value: { result: "handled" } });
    expect((await env.DATA.list({ prefix: "runs/v-point/" })).objects.length).toBeGreaterThan(0);
    const count = calls.mock.calls.length;
    expect((await stub.fumiOffer(request)).result).toBe("handled");
    expect(calls).toHaveBeenCalledTimes(count);
  });
  it("never replays an external attempt after an interrupted durable stage", async () => {
    const { stub, request } = await fixture();
    await stub.fumiOffer(request);
    await runInDurableObject(stub, async (_instance, state) => {
      const job = await state.storage.get<Record<string, unknown>>("fumi:job");
      if (!job) throw new Error("Synthetic job missing");
      delete job["code"];
      delete job["challenge"];
      job["stage"] = "authenticating";
      await state.storage.put("fumi:job", job);
      await state.storage.setAlarm(Date.now() + 600_000);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.fumiReceipt(status(request))).result).toBe("handled");
    expect(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(`fumi:receipt:${request.operationId}`),
      ),
    ).toMatchObject({ state: "uncertain" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("deduplicates legacy delivery against a queued Fumi offer of the same source", async () => {
    const { stub, request } = await fixture();
    await stub.fumiOffer(request);
    await pauseAlarm(stub);
    expect(
      await stub.completeEmailCode("123456", "synthetic-run", {
        sourceSha256: request.source.rawSha256,
        receivedAt: request.source.receivedAt,
        recipient: "synthetic-otp@example.invalid",
      }),
    ).toEqual({ status: "already_handled" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("keeps a legacy authentication claim exclusive and does not let an offer repeat it", async () => {
    const calls = provider();
    const { stub, request } = await fixture();
    const authenticated = await stub.completeEmailCode("123456", "synthetic-run", {
      sourceSha256: request.source.rawSha256,
      receivedAt: request.source.receivedAt,
      recipient: "synthetic-otp@example.invalid",
    });
    expect(authenticated.status).toBe("authenticated");
    const count = calls.mock.calls.length;
    expect((await stub.fumiOffer(request)).result).toBe("handled");
    expect((await stub.ensureEmailChallenge("synthetic-another-run")).status).toBe("pending");
    expect(calls).toHaveBeenCalledTimes(count);
    if (authenticated.status !== "authenticated")
      throw new Error("Synthetic authentication missing");
    const claim = {
      schemaVersion: authenticated.schemaVersion,
      operationId: authenticated.operationId,
      requestSha256: authenticated.requestSha256,
    };
    expect(await stub.beginLegacyCollection(claim)).toBe(true);
    expect(await stub.beginLegacyCollection(claim)).toBe(false);
    await stub.finishLegacyCollection(claim, false);
    expect(
      await runInDurableObject(stub, async (_instance, state) =>
        state.storage.get(`fumi:receipt:${claim.operationId}`),
      ),
    ).toMatchObject({ state: "failed", value: { result: "handled" } });
  });
  it("retries a challenge being created without consuming mail or advancing its receipt", async () => {
    const { stub, request } = await fixture();
    await runInDurableObject(stub, async (_instance, state) =>
      state.storage.put("email-requesting", {
        token: "synthetic-request",
        requestedAt: new Date().toISOString(),
      }),
    );
    expect((await stub.fumiOffer(request)).result).toBe("retryable_error");
    expect((await stub.fumiReceipt(status(request))).result).toBe("not_found");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
