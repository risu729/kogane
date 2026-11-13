import { afterEach, expect, spyOn, test } from "bun:test";
import { MyJcbReadClient } from "../src/client";
import { CookieJar } from "../src/cookie-jar";
import { safeErrorDetails } from "../../../packages/collector-diagnostics/src/index";
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
});

test("read failures retain numeric HTTP status but no response body", async () => {
  const mocked = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("private-statement-body", { status: 429 }),
  );
  restore = () => mocked.mockRestore();
  let error: unknown;
  try {
    await new MyJcbReadClient(new CookieJar(), "test").get("mypage");
  } catch (caught) {
    error = caught;
  }
  expect(safeErrorDetails(error)).toMatchObject({
    httpStatus: 429,
    category: "http",
    errorType: "StopConditionError",
  });
  expect(JSON.stringify(safeErrorDetails(error))).not.toContain("private-statement-body");
});

test("observed export headers, exact query and original streamed bytes are preserved", async () => {
  const bytes = new TextEncoder().encode("%PDF-1.4\nsynthetic\n%%EOF\n");
  const mocked = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(
      "https://my.jcb.co.jp/iss-pc/member/details_inquiry/detailDbPdf.html?detailMonth=2&output=pdf",
    );
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "attachment;filename=synthetic.pdf",
      },
    });
  });
  restore = () => mocked.mockRestore();
  const result = await new MyJcbReadClient(new CookieJar(), "synthetic").get(
    "credit-pdf",
    new URLSearchParams({ detailMonth: "2", output: "pdf" }),
  );
  expect(new Uint8Array(result.body)).toEqual(bytes);
  expect(JSON.stringify(result)).not.toContain("synthetic.pdf");
});
test("unknown export headers and chunked oversized bytes fail closed without following or retrying", async () => {
  let calls = 0;
  const mocked = spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls += 1;
    if (calls === 1)
      return new Response("<html>synthetic</html>", { headers: { "Content-Type": "text/html" } });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
      {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment;filename=synthetic.pdf",
        },
      },
    );
  });
  restore = () => mocked.mockRestore();
  const client = new MyJcbReadClient(new CookieJar(), "synthetic");
  const query = new URLSearchParams({ detailMonth: "2", output: "pdf" });
  await expect(client.get("credit-pdf", query)).rejects.toThrow("headers_unsupported");
  await expect(client.get("credit-pdf", query)).rejects.toThrow("too_large");
  expect(calls).toBe(2);
});

test("remaining run budget bounds streamed bytes before file validation and cancels overflow", async () => {
  let cancelled = false;
  const mocked = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment;filename=synthetic.pdf",
        },
      },
    ),
  );
  restore = () => mocked.mockRestore();
  await expect(
    new MyJcbReadClient(new CookieJar(), "synthetic").get(
      "credit-pdf",
      new URLSearchParams({ detailMonth: "2", output: "pdf" }),
      { maxResponseBytes: 3 },
    ),
  ).rejects.toThrow("budget_exhausted");
  expect(cancelled).toBe(true);
});
