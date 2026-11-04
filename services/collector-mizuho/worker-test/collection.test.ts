import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  readTerminal,
  listTerminals,
  verifyReferencedObjects,
} from "../../../packages/collection/src/index";
import {
  mizuhoAccountHtml,
  mizuhoHistoryHtml,
} from "../../../packages/parsers/test/mizuho-fixture";
import {
  parseAccountPage,
  parseHistoryPage,
  sanitizeMizuhoPage,
} from "../../../packages/parsers/src/parsers/mizuho-html";
import { createHandler, createCollection } from "../src/worker";
import { persistMizuhoRun } from "../src/storage";
import { MizuhoClientError, type MizuhoCollection, type MizuhoSession } from "../src/client";

const session: MizuhoSession = {
  origin: "https://web1.ib.mizuhobank.co.jp",
  cookies: "JSESSIONID=synthetic-private-cookie",
  userAgent: "Synthetic browser",
  referer: "https://web1.ib.mizuhobank.co.jp/servlet/BALINQ0301002B.do",
  form: {
    name: "ACCHST_04110B",
    fields: {
      _FRAMEID: "frame",
      _TARGETID: "frame",
      _LUID: "private-luid",
      _TOKEN: "synthetic-private-token",
      _FORMID: "ACCHST_04110B",
      _SUBINDEX: "",
      POSTKEY: "private-postkey",
    },
  },
};
const request = (body = JSON.stringify(session), token = "local-test-only") =>
  new Request("https://collector.test/trigger", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
function collection(partial = false): MizuhoCollection {
  const accountHtml = sanitizeMizuhoPage(mizuhoAccountHtml());
  const historyHtml = sanitizeMizuhoPage(
    mizuhoHistoryHtml(undefined, undefined, partial ? "2" : "1"),
  );
  const accounts = parseAccountPage(accountHtml).accounts;
  return {
    session,
    accounts,
    histories: [parseHistoryPage(historyHtml, accounts[0]!)],
    partial,
    issues: partial ? ["history-pagination-unverified"] : [],
    failedUnits: [],
    artifacts: [
      {
        artifactKey: "account-list.html",
        unitKey: "account-list",
        dataset: "mizuho-account-list-html",
        body: accountHtml,
        mediaType: "text/html",
        partial: false,
      },
      {
        artifactKey: "ordinary/001-1234567/history/1-1.html",
        unitKey: "ordinary:001:1234567:page:1:1",
        dataset: "mizuho-ordinary-history-html",
        body: historyHtml,
        mediaType: "text/html",
        partial,
      },
    ],
  };
}
async function manifestFor(response: Awaited<ReturnType<ReturnType<typeof createCollection>>>) {
  const result = response.body as { runId: string };
  const terminal = await readTerminal(env.DATA, "mizuho-bank", result.runId);
  if (terminal.outcome !== "found") throw new Error("terminal-not-found");
  return terminal.manifest;
}

describe("Mizuho Worker and shared DATA integration", () => {
  for (const scenario of ["success", "collection-failure", "persistence-failure"] as const) {
    it.each(["configuration", "login", "collection", "persistence", "result", "all"] as const)(
      `a throwing %s log sink preserves the alarm ${scenario} and attempt counts`,
      async (sink) => {
        let thrownLogs = 0;
        const log = vi.spyOn(console, "log").mockImplementation((value) => {
          const record = JSON.parse(String(value)) as { event: string; phase?: string };
          if (
            sink === "all" ||
            record.phase === sink ||
            (sink === "result" && record.event === "mizuho-collection-result")
          ) {
            thrownLogs++;
            throw new Error("private-logger-failure");
          }
        });
        const login = vi.fn(async () => session);
        const collect = vi.fn(async () => {
          if (scenario === "collection-failure") throw new MizuhoClientError("read-http-error");
          return collection();
        });
        const persist = vi.fn<typeof persistMizuhoRun>(async (bucket, input) => {
          if (scenario === "persistence-failure") throw new Error("private-storage-failure");
          return persistMizuhoRun(bucket, input);
        });
        try {
          const result = await createHandler({ login, collect, persist }).alarmCollection(env);
          expect(result).toEqual({
            status: scenario === "success" ? "completed" : "failed",
            runIds: [expect.any(String)],
            failureCode: scenario === "success" ? null : "collection_failed",
          });
          expect(login).toHaveBeenCalledTimes(1);
          expect(collect).toHaveBeenCalledTimes(1);
          expect(persist).toHaveBeenCalledTimes(1);
          expect(thrownLogs).toBeGreaterThan(0);
          const terminal = await readTerminal(env.DATA, "mizuho-bank", result.runIds[0]!);
          if (scenario === "persistence-failure") expect(terminal.outcome).toBe("missing");
          else {
            expect(terminal.outcome).toBe("found");
            if (terminal.outcome !== "found") throw new Error("terminal-not-found");
            expect(terminal.manifest.providerOutcome).toBe(
              scenario === "success" ? "success" : "failed",
            );
            expect(terminal.manifest.artifacts).toHaveLength(scenario === "success" ? 2 : 0);
          }
        } finally {
          log.mockRestore();
        }
      },
    );
  }
  it.each(["success", "login-failure", "persistence-failure"] as const)(
    "throwing every log preserves legacy scheduled %s without retries",
    async (scenario) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {
        throw new Error("private-logger-failure");
      });
      const login = vi.fn(async () => {
        if (scenario === "login-failure") throw new MizuhoClientError("login-challenge-required");
        return session;
      });
      const collect = vi.fn(async () => collection());
      const persist = vi.fn<typeof persistMizuhoRun>(async (bucket, input) => {
        if (scenario === "persistence-failure") throw new Error("private-storage-failure");
        return persistMizuhoRun(bucket, input);
      });
      const controller = { scheduledTime: Date.now(), cron: "25 21 * * *", noRetry: vi.fn() };
      try {
        const scheduled = createHandler({ login, collect, persist }).scheduled(controller, env);
        if (scenario === "success") await expect(scheduled).resolves.toBeUndefined();
        else await expect(scheduled).rejects.toThrow("mizuho-scheduled-collection-failed");
        expect(controller.noRetry).toHaveBeenCalledTimes(1);
        expect(login).toHaveBeenCalledTimes(1);
        expect(collect).toHaveBeenCalledTimes(scenario === "login-failure" ? 0 : 1);
        expect(persist).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    },
  );
  it.each(["success", "pagination", "acquisition", "login", "persistence"] as const)(
    "logs a safe result on the production alarm path: %s",
    async (scenario) => {
      const collected = collection(scenario === "pagination" || scenario === "acquisition");
      if (scenario === "acquisition") {
        collected.failedUnits = ["private-account-key"];
        collected.issues = ["read-http-error", "private-provider-message", "read-http-error"];
      }
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const handler = createHandler({
          login: async () => {
            if (scenario === "login") throw new MizuhoClientError("login-challenge-required");
            return session;
          },
          collect: async () => collected,
          persist:
            scenario === "persistence"
              ? async () => {
                  throw new Error("private-storage-response");
                }
              : persistMizuhoRun,
        });
        const result = await handler.alarmCollection(env);
        expect(result.status).toBe(
          ["login", "persistence"].includes(scenario) ? "failed" : "completed",
        );
        const records = log.mock.calls.map(([value]) => JSON.parse(String(value)));
        const results = records.filter((r) => r.event === "mizuho-collection-result");
        expect(results).toHaveLength(1);
        expect(results[0].runId).toBe(result.runIds[0]);
        if (scenario === "acquisition")
          expect(results[0]).toMatchObject({
            providerOutcome: "partial",
            coverageStatus: "partial",
            coverageReason: "collection-incomplete",
            failedUnitCount: 1,
            issueCodes: ["read-http-error", "unclassified-collection-issue"],
          });
        if (scenario === "login")
          expect(results[0]).toMatchObject({
            providerOutcome: "failed",
            errorCode: "login-challenge-required",
            failurePhase: "login",
          });
        if (scenario === "persistence")
          expect(results[0]).toMatchObject({
            providerOutcome: "success",
            persistence: "failed",
            persistenceErrorCode: "persistence-failed",
          });
        const text = JSON.stringify(records);
        for (const forbidden of ["private", "syntheticpassword", "1234567", "https://", "<html"])
          expect(text).not.toContain(forbidden);
      } finally {
        log.mockRestore();
      }
    },
  );
  it("rejects retired triggers before reading sessions or calling the bank", async () => {
    let called = false;
    const login = vi.fn(async () => session);
    const handler = createHandler({
      login,
      collect: async () => {
        called = true;
        return collection();
      },
      persist: persistMizuhoRun,
    });
    expect((await handler.fetch(request("private-invalid", "wrong-token"), env)).status).toBe(404);
    expect((await handler.fetch(request("private-invalid"), env)).status).toBe(404);
    expect((await handler.fetch(request("x".repeat(96 * 1024 + 1)), env)).status).toBe(404);
    expect((await handler.fetch(request("{}", "wrong-token"), env)).status).toBe(404);
    for (const invalid of ["null", "[]", '{"password":"syntheticpassword"}', '{"session":{}}'])
      expect((await handler.fetch(request(invalid), env)).status).toBe(404);
    expect(login).not.toHaveBeenCalled();
    expect(called).toBe(false);
  });
  it("the internal executor logs in once with configured credentials and retains no authentication data", async () => {
    const login = vi.fn(async () => session);
    const collect = vi.fn(async () => collection());
    const handler = createCollection({ login, collect, persist: persistMizuhoRun });
    const response = await handler(env);
    expect(response.httpStatus).toBe(200);
    expect(login).toHaveBeenCalledExactlyOnceWith({
      customerNumber: "0000000000",
      password: "syntheticpassword",
    });
    expect(collect).toHaveBeenCalledExactlyOnceWith({ session });
    const text = JSON.stringify(response.body);
    const manifest = await manifestFor(response);
    const persisted = [JSON.stringify(manifest)];
    for (const item of manifest.artifacts)
      persisted.push(await (await env.DATA.get(item.storageRef.key))!.text());
    for (const secret of [
      "0000000000",
      "syntheticpassword",
      "synthetic-private-cookie",
      "synthetic-private-token",
    ])
      expect(text + persisted.join("\n")).not.toContain(secret);
  });
  it("retires explicit-session injection without reading credentials or logging in", async () => {
    const login = vi.fn(async () => {
      throw new Error("must-not-login");
    });
    const handler = createHandler({
      login,
      collect: async () => collection(),
      persist: persistMizuhoRun,
    });
    const response = await handler.fetch(request(), {
      ...env,
      MIZUHO_CUSTOMER_NUMBER: "",
      MIZUHO_LOGIN_PASSWORD: "",
    });
    expect(response.status).toBe(404);
    expect(login).not.toHaveBeenCalled();
  });
  it.each(["MIZUHO_CUSTOMER_NUMBER", "MIZUHO_LOGIN_PASSWORD"] as const)(
    "fails closed before login when %s is missing",
    async (secret) => {
      const login = vi.fn(async () => session);
      const collect = vi.fn(async () => collection());
      const handler = createCollection({ login, collect, persist: persistMizuhoRun });
      const response = await handler({ ...env, [secret]: "" });
      expect(response.httpStatus).toBe(502);
      expect(response.body).toMatchObject({
        status: "failed",
        error: "mizuho-credentials-missing",
        artifactCount: 0,
      });
      expect(login).not.toHaveBeenCalled();
      expect(collect).not.toHaveBeenCalled();
      expect((await manifestFor(response)).providerOutcome).toBe("failed");
    },
  );
  it("records an authentication challenge as a failed run without credential retries", async () => {
    const login = vi.fn(async () => {
      throw new MizuhoClientError("login-challenge-required");
    });
    const collect = vi.fn(async () => collection());
    const handler = createCollection({ login, collect, persist: persistMizuhoRun });
    const response = await handler(env);
    expect(response.httpStatus).toBe(502);
    expect(response.body).toMatchObject({
      error: "login-challenge-required",
      artifactCount: 0,
    });
    expect(login).toHaveBeenCalledTimes(1);
    expect(collect).not.toHaveBeenCalled();
    const manifest = await manifestFor(response);
    expect(manifest.providerOutcome).toBe("failed");
    expect(manifest.artifacts).toEqual([]);
  });
  it.each([false, true])(
    "runs daily collection through the shared persistence path (partial=%s)",
    async (partial) => {
      const login = vi.fn(async () => session);
      const collect = vi.fn(async () => collection(partial));
      const controller = { scheduledTime: Date.now(), cron: "25 21 * * *", noRetry: vi.fn() };
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const handler = createHandler({ login, collect, persist: persistMizuhoRun });
        await handler.scheduled(controller, env);
        expect(controller.noRetry).toHaveBeenCalledTimes(1);
        expect(login).toHaveBeenCalledTimes(1);
        expect(collect).toHaveBeenCalledTimes(1);
        const records = log.mock.calls.map(([value]) => JSON.parse(String(value)));
        expect(
          records.filter((r) => r.event === "mizuho-collection-phase").map((r) => r.phase),
        ).toEqual(["configuration", "login", "collection", "persistence"]);
        const result = records.find((r) => r.event === "mizuho-collection-result");
        expect(result).toEqual({
          event: "mizuho-collection-result",
          runId: expect.any(String),
          status: partial ? "partial" : "success",
          artifactCount: 2,
          persistence: "persisted",
          providerOutcome: "success",
          coverageStatus: partial ? "partial" : "unknown",
          coverageReason: partial ? "history-pagination-unverified" : "first-page-scope-unverified",
          accountCount: 1,
          historyCount: 1,
          failedUnitCount: 0,
          issueCodes: partial ? ["history-pagination-unverified"] : [],
        });
        const terminal = await readTerminal(env.DATA, "mizuho-bank", result.runId);
        expect(terminal.outcome).toBe("found");
        if (terminal.outcome !== "found") throw new Error("terminal-not-found");
        expect(terminal.manifest.providerOutcome).toBe("success");
        expect(terminal.manifest.coverageStatus).toBe(partial ? "partial" : "unknown");
      } finally {
        log.mockRestore();
      }
    },
  );
  it("marks scheduled login failure without retries or sensitive logs", async () => {
    const login = vi.fn(async () => {
      throw new Error("syntheticpassword private provider response");
    });
    const collect = vi.fn(async () => collection());
    const controller = { scheduledTime: Date.now(), cron: "25 21 * * *", noRetry: vi.fn() };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const handler = createHandler({ login, collect, persist: persistMizuhoRun });
      await expect(handler.scheduled(controller, env)).rejects.toThrow(
        "mizuho-scheduled-collection-failed",
      );
      expect(controller.noRetry).toHaveBeenCalledTimes(1);
      expect(login).toHaveBeenCalledTimes(1);
      expect(collect).not.toHaveBeenCalled();
      const records = log.mock.calls.map(([value]) => JSON.parse(String(value)));
      const message = JSON.stringify(records.find((r) => r.event === "mizuho-collection-result"));
      expect(message).not.toContain("syntheticpassword");
      expect(message).not.toContain("private");
      const result = JSON.parse(message) as { runId: string };
      expect(result).toEqual({
        event: "mizuho-collection-result",
        runId: expect.any(String),
        status: "failed",
        artifactCount: 0,
        persistence: "persisted",
        providerOutcome: "failed",
        coverageStatus: "unknown",
        coverageReason: "collection-unavailable",
        accountCount: 0,
        historyCount: 0,
        failedUnitCount: 0,
        issueCodes: [],
        errorCode: "read-parse-error",
        failurePhase: "login",
      });
      const terminal = await readTerminal(env.DATA, "mizuho-bank", result.runId);
      expect(terminal.outcome).toBe("found");
      if (terminal.outcome !== "found") throw new Error("terminal-not-found");
      expect(terminal.manifest.providerOutcome).toBe("failed");
      expect(terminal.manifest.artifacts).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
  it("writes sanitized objects and a verifiable terminal, without exposing sessions", async () => {
    const handler = createCollection({
      login: async () => session,
      collect: async () => collection(),
      persist: persistMizuhoRun,
    });
    const response = await handler(env);
    expect(response.httpStatus).toBe(200);
    const publicText = JSON.stringify(response.body);
    expect(publicText).not.toContain("synthetic-private");
    expect(publicText).not.toContain("1234567");
    const manifest = await manifestFor(response);
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("unknown");
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.transformations).toHaveLength(2);
    expect((await verifyReferencedObjects(env.DATA, manifest)).outcome).toBe("ok");
    for (const artifact of manifest.artifacts) {
      const object = await env.DATA.get(artifact.storageRef.key);
      const text = await object!.text();
      expect(text).not.toContain("synthetic-private");
      expect(text).not.toContain("POSTKEY");
      expect(text).not.toContain("<input");
    }
  });
  it("keeps successful page acquisition distinct from incomplete history coverage", async () => {
    const handler = createCollection({
      login: async () => session,
      collect: async () => collection(true),
      persist: persistMizuhoRun,
    });
    const response = await handler(env);
    expect(response.httpStatus).toBe(207);
    const manifest = await manifestFor(response);
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("partial");
    expect(manifest.units.find((u) => u.unitKey.startsWith("ordinary:"))?.coverageStatus).toBe(
      "partial",
    );
    expect(manifest.ranges).toEqual([]);
  });
  it("records expiration as a failed acquisition without an empty-success observation", async () => {
    const handler = createCollection({
      login: async () => session,
      collect: async () => {
        throw new MizuhoClientError("authentication-required");
      },
      persist: persistMizuhoRun,
    });
    const response = await handler(env);
    expect(response.httpStatus).toBe(502);
    const manifest = await manifestFor(response);
    expect(manifest.providerOutcome).toBe("failed");
    expect(manifest.artifacts).toEqual([]);
    expect(manifest.units[0]?.safeErrorCode).toBe("collection-unit-failed");
  });
  it("cannot publish a terminal when sanitization or persistence fails", async () => {
    const before = await listTerminals(env.DATA, { source: "mizuho-bank" });
    const invalid = collection();
    invalid.artifacts[0]!.body = invalid.artifacts[0]!.body.replace(
      "</form>",
      '<input type="hidden" value="synthetic-private-token"></form>',
    );
    const handler = createCollection({
      login: async () => session,
      collect: async () => invalid,
      persist: persistMizuhoRun,
    });
    expect((await handler(env)).httpStatus).toBe(502);
    expect(await listTerminals(env.DATA, { source: "mizuho-bank" })).toEqual(before);
    const failedWrite = createCollection({
      login: async () => session,
      collect: async () => collection(),
      persist: async () => {
        throw new Error("synthetic-private-cookie");
      },
    });
    const response = await failedWrite(env);
    expect(response.httpStatus).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain("synthetic-private");
  });
});
