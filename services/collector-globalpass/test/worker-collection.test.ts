import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import type { CollectionManifest } from "../src/model";

let container: {
  startAndWaitForPorts(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
};
mock.module("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: () => container,
}));
const { default: worker } = await import("../src/worker");
const spies: ReturnType<typeof spyOn>[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function fixtureHtml(): string {
  return (
    "<!DOCTYPE html><html><head></head><body><h1>ご利用明細</h1>" +
    '<input type="hidden" name="cc" value="01006">' +
    '<input type="hidden" name="engUseFlg" value="0">' +
    '<input type="hidden" name="nablarch_needs_hidden_encryption" value="1">' +
    ["private-state1", "private-state2", "private-state3", ""]
      .map((value) => `<input type="hidden" name="nablarch_hidden" value="${value}">`)
      .join("") +
    '<input type="hidden" name="nablarch_submit" value="1">'.repeat(4) +
    "<form></form>".repeat(5) +
    "</body></html>"
  );
}
const metadata = {
  type: "metadata",
  availableMonths: ["2099-02", "2099-01"],
  selectedMonths: ["2099-02", "2099-01"],
  browserVersion: "synthetic",
};
const artifact = { type: "artifact", month: "2099-02", html: fixtureHtml() };

async function run(
  records: unknown[],
  options: {
    httpStatus?: number;
    teardownError?: boolean;
    loggerThrows?: boolean;
  } = {},
) {
  const logs: string[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    spies.push(
      spyOn(console, level).mockImplementation((line) => {
        if (options.loggerThrows) throw new Error("logger unavailable");
        logs.push(String(line));
      }),
    );
  }
  let destroyed = 0;
  let sentBody: Record<string, string> = {};
  let manifest: CollectionManifest | undefined;
  const data = new FakeR2Bucket();
  container = {
    async startAndWaitForPorts() {},
    async fetch(request) {
      sentBody = await request.json();
      return new Response(records.map((record) => JSON.stringify(record)).join("\n") + "\n", {
        status: options.httpStatus ?? 200,
      });
    },
    async destroy() {
      destroyed++;
      if (options.teardownError) throw new Error("private-teardown");
    },
  };
  const env = {
    ADMIN_TRIGGER_TOKEN: "synthetic-admin-token-".repeat(3),
    GLOBALPASS_ID: "private-user",
    GLOBALPASS_PASSWORD: "private-password",
    RELAY_TOKEN: "private-relay-token",
    RELAY_PUBLIC_URL: "wss://relay.test/tcp?network=tamia",
    COLLECTOR_CONTAINER: {},
    DATA: data,
  };
  const response = await worker.fetch(
    new Request("https://collector.test/trigger", {
      method: "POST",
      headers: { authorization: `Bearer ${env.ADMIN_TRIGGER_TOKEN}` },
    }) as Request<unknown, IncomingRequestCfProperties>,
    env as unknown as Env,
    {} as ExecutionContext,
  );
  const result = (await response.json()) as Record<string, unknown>;
  const saved = data.entries.get(String(result.manifestKey));
  if (saved) manifest = JSON.parse(new TextDecoder().decode(saved.bytes));
  return {
    response,
    result,
    manifest,
    logs,
    destroyed,
    sentBody,
    stored: new Map([...data.entries].map(([key, entry]) => [key, entry.bytes])),
  };
}

describe("GLOBAL PASS diagnostics preserve the current collection contract", () => {
  test("retains sanitized partial evidence with a completed shared terminal", async () => {
    const r = await run([
      metadata,
      artifact,
      {
        type: "error",
        operation: "browser-collection",
        errorType: "Error",
        errorCode: "browser_collection_failed",
      },
    ]);
    expect(r.response.status).toBe(502);
    expect(r.manifest?.schemaVersion).toBe("globalpass-browser-poc-v2");
    expect(r.manifest?.status).toBe("partial");
    expect(r.manifest?.artifacts).toHaveLength(1);
    expect(r.manifest?.failures.map((f) => f.errorCode)).toEqual([
      "browser_collection_failed",
      "selected_month_missing",
    ]);
    expect(r.result).not.toHaveProperty("central");
    expect(new TextDecoder().decode([...r.stored.values()][0] as Uint8Array)).not.toContain(
      "private-state",
    );
    expect(new URL(r.sentBody.relayUrl!).searchParams.get("runId")).toBe(r.manifest!.runId);
    expect(new URL(r.sentBody.relayUrl!).searchParams.get("network")).toBe("tamia");
    expect(r.logs.join("\n")).not.toContain("private-");
    expect(r.destroyed).toBe(1);
  });
  test("HTTP failure is logged inside request stage and still stores a failed manifest", async () => {
    const r = await run([], { httpStatus: 503 });
    expect(r.manifest?.status).toBe("failed");
    expect(r.manifest?.artifacts).toHaveLength(0);
    expect(r.manifest?.failures[0]?.errorCode).toBe("browser_collection_failed");
    const events = r.logs.map((line) => JSON.parse(line));
    expect(
      events.some(
        (e) => e.stage === "container-request" && e.outcome === "failed" && e.httpStatus === 503,
      ),
    ).toBe(true);
    expect(events.some((e) => e.stage === "container-request" && e.outcome === "success")).toBe(
      false,
    );
    expect(r.destroyed).toBe(1);
  });
  test("rejects duplicate metadata without losing the first artifact", async () => {
    const r = await run([metadata, artifact, metadata]);
    expect(r.manifest?.status).toBe("partial");
    expect(r.manifest?.artifacts).toHaveLength(1);
    expect(r.manifest?.failures[0]?.errorCode).toBe("container_contract_invalid");
  });
  test("throwing loggers and failed teardown cannot change successful capture", async () => {
    const r = await run([metadata, artifact, { ...artifact, month: "2099-01" }], {
      loggerThrows: true,
      teardownError: true,
    });
    expect(r.response.status).toBe(200);
    expect(r.manifest?.status).toBe("success");
    expect(r.manifest?.captureComplete).toBe(true);
    expect(r.manifest?.paginationStatus).toBe("first_page_only");
    expect(r.destroyed).toBe(1);
  });
});

// Each of the sanitizer's four refusals, driven through the Worker from the
// container stream. The pages carry `private-` markers where a provider value
// would be; none may reach a log line, the manifest or DATA.
const refusals: Array<{ code: string; html: () => string }> = [
  {
    code: "globalpass_html_contract_invalid",
    html: () =>
      fixtureHtml().replace(
        "</body>",
        '<input type="password" id="password" value="private-password-field"></body>',
      ),
  },
  {
    code: "globalpass_html_redaction_failed",
    // A `nablarch_hidden` input without `type="hidden"`: redacted, but not
    // counted by the shape, so the counts disagree.
    html: () =>
      fixtureHtml().replace(
        "</body>",
        '<input name="nablarch_hidden" value="private-untyped-state"></body>',
      ),
  },
  {
    code: "globalpass_html_shape_unreviewed",
    html: () => fixtureHtml().replace('<input type="hidden" name="nablarch_submit" value="1">', ""),
  },
  {
    code: "globalpass_html_utf8_invalid",
    html: () => fixtureHtml().replace("</body>", "\ud800</body>"),
  },
];

describe("GLOBAL PASS sanitizer refusals carry their closed code", () => {
  for (const refusal of refusals) {
    test(refusal.code, async () => {
      const r = await run([
        metadata,
        { type: "artifact", month: "2099-02", html: refusal.html() },
        { ...artifact, month: "2099-01" },
      ]);
      expect(r.manifest?.status).toBe("partial");
      expect(r.manifest?.artifacts.map((a) => a.month)).toEqual(["2099-01"]);
      expect(r.manifest?.failures).toEqual([
        {
          operation: "sanitization",
          errorType: "GlobalPassSanitizerError",
          errorCode: refusal.code as CollectionManifest["failures"][number]["errorCode"],
          artifactKey: "activity-2099-02.html",
        },
      ]);
      const events = r.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
      const failed = events.filter((e) => e.stage === "artifact-write" && e.outcome === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        event: "collector-diagnostic",
        source: "prestia-globalpass",
        category: "response",
        errorType: "GlobalPassSanitizerError",
        code: refusal.code,
      });
      // The run's terminal carries the code as its safe error code.
      const stored = [...r.stored.values()].map((bytes) => new TextDecoder().decode(bytes));
      const terminal = stored.find((body) => body.includes('"safeErrorCode"'));
      expect(terminal).toContain(`"safeErrorCode":"${refusal.code}"`);
      // Nothing of the refused page leaves: no marker, no password field, no
      // page heading, anywhere in the logs, the manifest or DATA.
      for (const text of [r.logs.join("\n"), JSON.stringify(r.manifest), ...stored]) {
        expect(text).not.toContain("private-");
        expect(text).not.toContain('type="password"');
      }
      expect([r.logs.join("\n"), JSON.stringify(r.manifest)].join("\n")).not.toContain(
        "ご利用明細",
      );
    });
  }
});

describe("GLOBAL PASS pages that state more pages are not a whole month", () => {
  const paged = (pager: string) =>
    fixtureHtml().replace(
      "</body>",
      `<div>Found 16 Result</div><div>${pager} <a href="javascript:void(0);">Back</a> <a href="javascript:void(0);">Next</a></div></body>`,
    );

  test("page 1 of 2 is kept, and the month and run are partial with a closed code", async () => {
    const r = await run([
      metadata,
      { type: "artifact", month: "2099-02", html: paged("[1/2page]") },
      { ...artifact, month: "2099-01" },
    ]);
    expect(r.response.status).toBe(502);
    expect(r.manifest?.status).toBe("partial");
    expect(r.manifest?.captureComplete).toBe(false);
    expect(r.manifest?.artifacts.map((a) => a.month)).toEqual(["2099-02", "2099-01"]);
    expect(r.manifest?.failures).toEqual([
      {
        operation: "pagination",
        errorType: "PaginationError",
        errorCode: "activity_pages_unwalked",
        artifactKey: "activity-2099-02.html",
      },
    ]);
    const pages = r.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.event === "globalpass-activity-pages");
    expect(pages).toEqual([
      {
        event: "globalpass-activity-pages",
        runId: r.manifest!.runId,
        monthIndex: 0,
        statedTotal: 16,
        pageIndex: 1,
        pageCount: 2,
        errorCode: "activity_pages_unwalked",
      },
      {
        event: "globalpass-activity-pages",
        runId: r.manifest!.runId,
        monthIndex: 1,
        statedTotal: null,
        pageIndex: null,
        pageCount: null,
      },
    ]);
    // The log lines name a month by its position only.
    expect(r.logs.join("\n")).not.toContain("2099-");
  });

  test("a refused page still reports that it was one of several", async () => {
    const r = await run([
      metadata,
      {
        type: "artifact",
        month: "2099-02",
        html: paged("[1/2page]").replace(
          '<input type="hidden" name="nablarch_submit" value="1">',
          "",
        ),
      },
      { ...artifact, month: "2099-01" },
    ]);
    expect(r.manifest?.failures.map((f) => [f.operation, f.errorCode])).toEqual([
      ["sanitization", "globalpass_html_shape_unreviewed"],
      ["pagination", "activity_pages_unwalked"],
    ]);
  });

  test("a one-page pager states no further page", async () => {
    const r = await run([
      metadata,
      { type: "artifact", month: "2099-02", html: paged("[1/1page]") },
      { ...artifact, month: "2099-01" },
    ]);
    expect(r.manifest?.status).toBe("success");
    expect(r.manifest?.failures).toEqual([]);
  });
});
