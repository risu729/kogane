import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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
import { createHandler } from "../src/worker";
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
async function manifestFor(response: Response) {
  const result = (await response.json()) as { runId: string };
  const terminal = await readTerminal(env.DATA, "mizuho-bank", result.runId);
  if (terminal.outcome !== "found") throw new Error("terminal-not-found");
  return terminal.manifest;
}

describe("Mizuho Worker and shared DATA integration", () => {
  it("authenticates before reading sessions or calling the bank", async () => {
    let called = false;
    const handler = createHandler({
      collect: async () => {
        called = true;
        return collection();
      },
      persist: persistMizuhoRun,
    });
    expect((await handler.fetch(request("private-invalid", "wrong-token"), env)).status).toBe(401);
    expect((await handler.fetch(request("private-invalid"), env)).status).toBe(400);
    expect((await handler.fetch(request("x".repeat(96 * 1024 + 1)), env)).status).toBe(400);
    expect(called).toBe(false);
  });
  it("writes sanitized objects and a verifiable terminal, without exposing sessions", async () => {
    const handler = createHandler({ collect: async () => collection(), persist: persistMizuhoRun });
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(200);
    const publicText = await response.clone().text();
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
    const handler = createHandler({
      collect: async () => collection(true),
      persist: persistMizuhoRun,
    });
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(207);
    const manifest = await manifestFor(response);
    expect(manifest.providerOutcome).toBe("success");
    expect(manifest.coverageStatus).toBe("partial");
    expect(manifest.units.find((u) => u.unitKey.startsWith("ordinary:"))?.coverageStatus).toBe(
      "partial",
    );
    expect(manifest.ranges).toEqual([]);
  });
  it("records expiration as a failed acquisition without an empty-success observation", async () => {
    const handler = createHandler({
      collect: async () => {
        throw new MizuhoClientError("authentication-required");
      },
      persist: persistMizuhoRun,
    });
    const response = await handler.fetch(request(), env);
    expect(response.status).toBe(502);
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
    const handler = createHandler({ collect: async () => invalid, persist: persistMizuhoRun });
    expect((await handler.fetch(request(), env)).status).toBe(502);
    expect(await listTerminals(env.DATA, { source: "mizuho-bank" })).toEqual(before);
    const failedWrite = createHandler({
      collect: async () => collection(),
      persist: async () => {
        throw new Error("synthetic-private-cookie");
      },
    });
    const response = await failedWrite.fetch(request(), env);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("synthetic-private");
  });
});
