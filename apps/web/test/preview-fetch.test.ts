import { afterEach, expect, test } from "bun:test";
import { fetchPreview, PREVIEW_LIMIT, previewLanguage } from "../src/preview-fetch.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const url = "/api/evidence/v1/runs/r_1/artifacts/a_2/raw";
const signal = () => new AbortController().signal;
function digest(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function respond(response: Response) {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

test("preview preserves JSON number lexemes, whitespace and Japanese text", async () => {
  const text = '{"amount":900719925474099312345,"name":"明細"}\n';
  const bytes = new TextEncoder().encode(text);
  respond(new Response(bytes));
  expect(await fetchPreview(url, signal(), digest(bytes), bytes.length)).toBe(text);
});

test("preview denies mismatched bytes, size and authentication responses", async () => {
  for (const status of [302, 401, 403]) {
    respond(new Response(null, { status }));
    await expect(fetchPreview(url, signal(), digest("x"), 1)).rejects.toMatchObject({
      status: 401,
    });
  }
  respond(new Response("<html>login</html>"));
  await expect(fetchPreview(url, signal(), digest("x"), 1)).rejects.toMatchObject({ status: 409 });
  respond(new Response("y"));
  await expect(fetchPreview(url, signal(), digest("x"), 1)).rejects.toMatchObject({ status: 409 });
});

test("preview bounds streamed responses and cancels excess even without content-length", async () => {
  let cancelled = false;
  respond(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(PREVIEW_LIMIT + 1));
        },
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await expect(fetchPreview(url, signal(), digest("x"), 1)).rejects.toMatchObject({ status: 413 });
  expect(cancelled).toBe(true);
});

test("preview checks URL, metadata and cancellation before requesting", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("x");
  }) as unknown as typeof fetch;
  await expect(
    fetchPreview("https://other.test/file", signal(), digest("x"), 1),
  ).rejects.toMatchObject({ status: 400 });
  await expect(fetchPreview(url, signal(), digest("x"), PREVIEW_LIMIT + 1)).rejects.toMatchObject({
    status: 413,
  });
  const controller = new AbortController();
  controller.abort();
  await expect(fetchPreview(url, controller.signal, digest("x"), 1)).rejects.toThrow();
  expect(calls).toBe(0);
});

test("declared charset is honored and undecodable or binary content is rejected", async () => {
  const sjis = Uint8Array.of(0x82, 0xa0);
  respond(new Response(sjis));
  expect(await fetchPreview(url, signal(), digest(sjis), 2, "text/html; charset=Shift_JIS")).toBe(
    "あ",
  );
  respond(new Response(sjis));
  await expect(fetchPreview(url, signal(), digest(sjis), 2)).rejects.toMatchObject({ status: 422 });
  const binary = Uint8Array.of(0);
  respond(new Response(binary));
  await expect(fetchPreview(url, signal(), digest(binary), 1)).rejects.toMatchObject({
    status: 422,
  });
});

test("preview format uses declared types before filename hints", () => {
  expect(previewLanguage("application/problem+json", "opaque")).toBe("json");
  expect(previewLanguage("text/html; charset=utf-8", "opaque")).toBe("xml");
  expect(previewLanguage(null, "capture.HTML")).toBe("xml");
  expect(previewLanguage("text/csv", "opaque")).toBe("text");
  expect(previewLanguage("application/pdf", "not-really.html")).toBeNull();
  expect(previewLanguage(null, "opaque")).toBeNull();
});
