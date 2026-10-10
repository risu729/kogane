mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import type { CollectionManifest } from "../src/model";

let container: {
  startAndWaitForPorts(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
};
mock.module("../../../packages/collection/src/container-stub", () => ({
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
const artifact = { type: "artifact", month: "2099-02", page: 1, pageCount: 1, html: fixtureHtml() };

test("stored diagnostics separate rolling run coverage from incomplete acquisition", async () => {
  const result = await run([metadata, artifact]);
  const stored = result.logs
    .map((line) => JSON.parse(line))
    .find((r) => r.event === "globalpass-collection-stored");
  expect(stored).toMatchObject({
    status: "partial",
    coverageStatus: "partial",
    unitCoverageStatus: "partial",
    coverageReason: "rolling-window",
  });
});

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
    expect(r.manifest?.schemaVersion).toBe("globalpass-browser-poc-v3");
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
    expect(r.manifest?.paginationStatus).toBe("pages_walked");
    expect(r.destroyed).toBe(1);
  });
  test("throwing loggers preserve an original collection failure and one teardown", async () => {
    const r = await run([], { httpStatus: 503, loggerThrows: true });
    expect(r.response.status).toBe(502);
    expect(r.manifest?.status).toBe("failed");
    expect(r.manifest?.artifacts).toHaveLength(0);
    expect(r.manifest?.failures[0]?.errorCode).toBe("browser_collection_failed");
    expect(r.destroyed).toBe(1);
    expect([...r.stored.keys()].filter((key) => key.endsWith("/terminal.json"))).toHaveLength(1);
  });
});

// Each of the sanitizer's four refusals, driven through the Worker from the
// container stream. The pages carry `private-` markers where a provider value
// would be; none may reach a log line, the manifest or DATA.
const refusals: Array<{ code: string; expectation: string; html: () => string }> = [
  {
    code: "globalpass_html_contract_invalid",
    expectation: "credential_field",
    html: () =>
      fixtureHtml().replace(
        "</body>",
        '<input type="password" id="password" value="private-password-field"></body>',
      ),
  },
  {
    code: "globalpass_html_redaction_failed",
    expectation: "redaction_count_mismatch",
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
    expectation: "variant_unmatched",
    html: () => fixtureHtml().replace('<input type="hidden" name="nablarch_submit" value="1">', ""),
  },
  {
    code: "globalpass_html_utf8_invalid",
    expectation: "utf8_invalid",
    html: () => fixtureHtml().replace("</body>", "\ud800</body>"),
  },
];

describe("GLOBAL PASS sanitizer refusals carry their closed code", () => {
  for (const refusal of refusals) {
    test(refusal.code, async () => {
      const r = await run([
        metadata,
        { type: "artifact", month: "2099-02", page: 1, pageCount: 1, html: refusal.html() },
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
          expectationCode:
            refusal.expectation as CollectionManifest["failures"][number]["expectationCode"],
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
        shape: { expectation: refusal.expectation, summarized: true },
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

// Synthetic pages in the observed Nablarch pager shape (2026-10-04): two
// identical pagers per page, an enabled link is `a.nablarch_nextSubmit` /
// `a.nablarch_prevSubmit` posting to the activity path, a disabled one is
// text; two `table.tableStyle4` per statement block. Counts are placeholders.
type Language = "en" | "ja";
function pagerHtml(total: number, index: number, count: number, language: Language): string {
  const labels =
    language === "en"
      ? {
          found: `Found ${total} Result`,
          page: `[${index}/${count}page]`,
          back: "Back",
          next: "Next",
        }
      : {
          found: `検索結果 ${total}件`,
          page: `[${index}/${count}ページ]`,
          back: "前へ",
          next: "次へ",
        };
  const link = (kind: "prev" | "next", label: string, enabled: boolean) =>
    enabled
      ? `<a class="nablarch_${kind}Submit" name="${kind}Submit" href="/p/statementInquiry/RW1313010201" onclick="return window.nablarch_submit(event, this);" tabindex="0">${label}</a>`
      : label;
  return (
    '<div class="nablarch_paging">' +
    `<div class="resultCountHeader">${labels.found}</div>` +
    `<div class="nablarch_currentPageNumber">${labels.page}</div>` +
    `<div class="nablarch_prevSubmit">${link("prev", labels.back, index > 1)}</div>` +
    `<div class="nablarch_nextSubmit">${link("next", labels.next, index < count)}</div>` +
    "</div>"
  );
}
function pagedHtml(
  total: number,
  index: number,
  count: number,
  blocks: number,
  language: Language = "en",
): string {
  const pager = pagerHtml(total, index, count, language);
  const block =
    '<table class="tableStyle4"><tr><td>SYNTHETIC</td></tr></table>' +
    '<table class="tableStyle4"><tr><td>SYNTHETIC</td></tr></table>';
  return fixtureHtml().replace("</body>", `${pager}${block.repeat(blocks)}${pager}</body>`);
}
function pageRecord(
  month: string,
  page: number,
  pageCount: number,
  html: string,
): Record<string, unknown> {
  return { type: "artifact", month, page, pageCount, html };
}
const emptyMonth = (month: string) => pageRecord(month, 1, 1, fixtureHtml());
function events(r: { logs: string[] }, name: string): Record<string, unknown>[] {
  return r.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((e) => e.event === name);
}

describe("GLOBAL PASS months are walked page by page", () => {
  for (const language of ["en", "ja"] as const) {
    test(`a two-page month walked whole is success, one artifact per page (${language})`, async () => {
      const r = await run([
        metadata,
        pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10, language)),
        pageRecord("2099-02", 2, 2, pagedHtml(16, 2, 2, 6, language)),
        emptyMonth("2099-01"),
      ]);
      expect(r.response.status).toBe(200);
      expect(r.manifest?.status).toBe("success");
      expect(r.manifest?.failures).toEqual([]);
      expect(r.manifest?.artifacts.map((a) => [a.month, a.page, a.key.split("/").at(-1)])).toEqual([
        ["2099-02", 1, "activity-2099-02.html"],
        ["2099-02", 2, "activity-2099-02-p2.html"],
        ["2099-01", 1, "activity-2099-01.html"],
      ]);
      const terminal = [...r.stored.values()]
        .map((bytes) => new TextDecoder().decode(bytes))
        .find((body) => body.includes('"units"'));
      expect(terminal).toContain('"coverageStatus":"complete"');
      expect(terminal).toContain('"artifactKey":"activity-2099-02-p2.html"');
      expect(events(r, "globalpass-activity-pages")).toEqual([
        {
          event: "globalpass-activity-pages",
          runId: r.manifest!.runId,
          monthIndex: 0,
          page: 1,
          walkPageCount: 2,
          statedTotal: 16,
          pageIndex: 1,
          pageCount: 2,
          statementBlocks: 10,
        },
        {
          event: "globalpass-activity-pages",
          runId: r.manifest!.runId,
          monthIndex: 0,
          page: 2,
          walkPageCount: 2,
          statedTotal: 16,
          pageIndex: 2,
          pageCount: 2,
          statementBlocks: 6,
        },
        {
          event: "globalpass-activity-pages",
          runId: r.manifest!.runId,
          monthIndex: 1,
          page: 1,
          walkPageCount: 1,
          statedTotal: null,
          pageIndex: null,
          pageCount: null,
          statementBlocks: 0,
        },
      ]);
      expect(events(r, "globalpass-activity-coverage")).toEqual([
        {
          event: "globalpass-activity-coverage",
          runId: r.manifest!.runId,
          monthIndex: 0,
          pagesCaptured: 2,
          walkPageCount: 2,
        },
        {
          event: "globalpass-activity-coverage",
          runId: r.manifest!.runId,
          monthIndex: 1,
          pagesCaptured: 1,
          walkPageCount: 1,
        },
      ]);
      // The log lines name a month by its position only, and carry no page text.
      const logs = r.logs.join("\n");
      expect(logs).not.toContain("2099-");
      expect(logs).not.toContain("SYNTHETIC");
      expect(logs).not.toContain("Found");
      expect(logs).not.toContain("検索結果");
    });
  }

  test("a [1/1page] month and an empty month are both whole", async () => {
    const r = await run([
      metadata,
      pageRecord("2099-02", 1, 1, pagedHtml(7, 1, 1, 7)),
      emptyMonth("2099-01"),
    ]);
    expect(r.manifest?.status).toBe("success");
    expect(r.manifest?.failures).toEqual([]);
  });

  const failureOf = (code: string): CollectionManifest["failures"] => [
    {
      operation: "pagination",
      errorType: "PaginationError",
      errorCode: code as CollectionManifest["failures"][number]["errorCode"],
      artifactKey: "activity-2099-02.html",
    },
  ];

  test("pages the container did not send (a stop) leave the month unwalked", async () => {
    const r = await run([
      metadata,
      pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
      {
        type: "error",
        operation: "browser-collection",
        errorType: "Error",
        errorCode: "browser_collection_failed",
      },
    ]);
    expect(r.manifest?.status).toBe("partial");
    expect(r.manifest?.artifacts.map((a) => a.page)).toEqual([1]);
    expect(r.manifest?.failures.map((f) => f.errorCode)).toEqual([
      "browser_collection_failed",
      "activity_pages_unwalked",
      "selected_month_missing",
    ]);
  });

  test("a month stating more pages than the cap is sent capped and is unwalked", async () => {
    const records = [1, 2, 3, 4, 5].map((page) =>
      pageRecord("2099-02", page, 7, pagedHtml(70, page, 7, 10)),
    );
    const r = await run([metadata, ...records, emptyMonth("2099-01")]);
    expect(r.manifest?.artifacts).toHaveLength(6);
    expect(r.manifest?.failures).toEqual(failureOf("activity_pages_unwalked"));
    expect(r.manifest?.status).toBe("partial");
  });

  test("a total that differs between pages is unreadable", async () => {
    const r = await run([
      metadata,
      pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
      pageRecord("2099-02", 2, 2, pagedHtml(17, 2, 2, 7)),
      emptyMonth("2099-01"),
    ]);
    expect(r.manifest?.artifacts).toHaveLength(3);
    expect(r.manifest?.failures).toEqual(failureOf("activity_pager_unreadable"));
    expect(r.manifest?.status).toBe("partial");
  });

  test("blocks that do not add up to the total are a mismatch", async () => {
    const r = await run([
      metadata,
      pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
      pageRecord("2099-02", 2, 2, pagedHtml(16, 2, 2, 5)),
      emptyMonth("2099-01"),
    ]);
    expect(r.manifest?.failures).toEqual(failureOf("activity_total_mismatch"));
    expect(r.manifest?.status).toBe("partial");
    const terminal = [...r.stored.values()]
      .map((bytes) => new TextDecoder().decode(bytes))
      .find((body) => body.includes('"units"'));
    expect(terminal).toContain('"safeErrorCode":"activity_total_mismatch"');
  });

  test("a page whose pager names another page than its walk position is unreadable", async () => {
    // Next did not advance: the container sent page 1's state as page 2.
    const r = await run([
      metadata,
      pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
      pageRecord("2099-02", 2, 2, pagedHtml(16, 1, 2, 10)),
      emptyMonth("2099-01"),
    ]);
    expect(r.manifest?.failures).toEqual(failureOf("activity_pager_unreadable"));
  });

  test("a refused page leaves its month's other pages stored and the month undecided", async () => {
    const r = await run([
      metadata,
      pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
      pageRecord(
        "2099-02",
        2,
        2,
        pagedHtml(16, 2, 2, 6).replace(
          '<input type="hidden" name="nablarch_submit" value="1">',
          "",
        ),
      ),
      emptyMonth("2099-01"),
    ]);
    expect(r.manifest?.artifacts.map((a) => [a.month, a.page])).toEqual([
      ["2099-02", 1],
      ["2099-01", 1],
    ]);
    expect(r.manifest?.failures.map((f) => [f.operation, f.errorCode, f.artifactKey])).toEqual([
      ["sanitization", "globalpass_html_shape_unreviewed", "activity-2099-02-p2.html"],
    ]);
    expect(r.manifest?.status).toBe("partial");
  });

  const contractCases: Array<[string, Record<string, unknown>[]]> = [
    [
      "page 2 before page 1",
      [
        pageRecord("2099-02", 2, 2, pagedHtml(16, 2, 2, 6)),
        pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
      ],
    ],
    [
      "a skipped page",
      [
        pageRecord("2099-02", 1, 3, pagedHtml(26, 1, 3, 10)),
        pageRecord("2099-02", 3, 3, pagedHtml(26, 3, 3, 6)),
      ],
    ],
    [
      "a repeated page",
      [
        pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
        pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
      ],
    ],
    [
      "a page count that changes within the month",
      [
        pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
        pageRecord("2099-02", 2, 3, pagedHtml(16, 2, 2, 6)),
      ],
    ],
    [
      "a page beyond the page count",
      [
        pageRecord("2099-02", 1, 1, pagedHtml(7, 1, 1, 7)),
        pageRecord("2099-02", 2, 1, pagedHtml(7, 1, 1, 7)),
      ],
    ],
    [
      "the next month before the last page",
      [pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)), emptyMonth("2099-01")],
    ],
    [
      "page 2 of another month",
      [
        pageRecord("2099-02", 1, 2, pagedHtml(16, 1, 2, 10)),
        pageRecord("2099-01", 2, 2, pagedHtml(16, 2, 2, 6)),
      ],
    ],
    ["a page number beyond the cap", [pageRecord("2099-02", 6, 7, pagedHtml(70, 6, 7, 10))]],
    ["a page number of zero", [pageRecord("2099-02", 0, 1, fixtureHtml())]],
    ["a record without its page", [{ type: "artifact", month: "2099-02", html: fixtureHtml() }]],
  ];
  for (const [name, records] of contractCases) {
    test(`out-of-order page records break the contract: ${name}`, async () => {
      const r = await run([metadata, ...records]);
      expect(r.manifest?.failures.map((f) => f.errorCode)).toContain("container_contract_invalid");
      expect(r.manifest?.status).not.toBe("success");
    });
  }

  test("a stream that ends before the month's last page breaks the contract", async () => {
    const r = await run([
      metadata,
      emptyMonth("2099-02"),
      pageRecord("2099-01", 1, 2, pagedHtml(16, 1, 2, 10)),
    ]);
    expect(r.manifest?.failures.map((f) => f.errorCode)).toEqual([
      "container_contract_invalid",
      "activity_pages_unwalked",
    ]);
    expect(r.manifest?.artifacts).toHaveLength(2);
  });
});

describe("GLOBAL PASS refusal shape is counts and closed codes only", () => {
  // A synthetic page shaped like a statement table, with merchant names,
  // amounts, dates and a card-like number where a provider's values would be.
  const merchant = "SYNTHETIC MERCHANT KOGANEYA";
  const tokens = [merchant, "KOGANEYA", "12,345", "98765", "2099/01/15", "4980-1234-5678-9012"];
  const refusedPage = () =>
    fixtureHtml()
      .replace("<h1>ご利用明細</h1>", "<title>ご利用明細</title><h1>ご利用明細</h1>")
      .replace(
        "</body>",
        '<table class="private-table-class"><tr><th>日付</th><th>店名</th><th>金額</th></tr>' +
          `<tr><td>2099/01/15</td><td>${merchant}</td><td>12,345</td></tr>` +
          `<tr><td data-ref="98765">4980-1234-5678-9012</td><td>x</td><td>y</td></tr></table>` +
          '<script>var session = "private-script";</script></body>',
      );

  test("the logged shape says which expectation failed and carries no page text", async () => {
    const r = await run([
      metadata,
      { type: "artifact", month: "2099-02", page: 1, pageCount: 1, html: refusedPage() },
      { ...artifact, month: "2099-01" },
    ]);
    const failed = r.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.stage === "artifact-write" && e.outcome === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      code: "globalpass_html_contract_invalid",
      shape: {
        expectation: "forbidden_token",
        phase: "input",
        summarized: true,
        elements: { table: 1, tr: 3, th: 3, td: 6, form: 5, script: 1, a: 0, title: 1 },
        contract: {
          forms: 5,
          staticActionForms: 0,
          hiddenInputs: 11,
          hiddenUnlisted: 0,
          nablarchHidden: 4,
          nablarchHiddenNonempty: 3,
          nablarchSubmit: 4,
          referenceDate: 0,
        },
        landmarks: {
          doctype: true,
          activityHeading: true,
          title: true,
          activityHeadingInTitle: true,
          loginForm: false,
          passwordField: false,
          monthSelect: false,
          sentinel: false,
        },
        forbiddenTokens: { session: 1, token: 0, turnstile: 0 },
      },
    });
    expect(r.manifest?.failures[0]).toMatchObject({ expectationCode: "forbidden_token" });
    const serialized = [r.logs.join("\n"), JSON.stringify(r.manifest)].join("\n");
    for (const token of [...tokens, "private-", "ご利用明細", "日付", "var "]) {
      expect(serialized).not.toContain(token);
    }
    // No run of 12 characters of the refused page appears in the logged shape.
    const shapeJson = JSON.stringify(failed[0]!.shape);
    const input = refusedPage();
    for (let index = 0; index + 12 <= input.length; index++) {
      expect(shapeJson).not.toContain(input.slice(index, index + 12));
    }
    // Every string in the logged shape is a closed code of at most 32 characters.
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(failed[0]!.shape);
    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) expect(value).toMatch(/^[a-z0-9_]{1,32}$/u);
  });
});
