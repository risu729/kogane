import { afterEach, expect, test } from "bun:test";
import { fetchPreview, PREVIEW_LIMIT } from "../src/preview-fetch.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const url = "/api/evidence/v1/runs/r_1/artifacts/a_2/raw";

function digest(value: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function respond(response: Response) {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

test("preview rejoins a UTF-8 sequence split across chunks", async () => {
  const text = "AあB";
  const bytes = new TextEncoder().encode(text);
  // あ is the three bytes e3 81 82. The cuts fall inside that sequence.
  const parts = [bytes.subarray(0, 2), bytes.subarray(2, 3), bytes.subarray(3)];
  expect(parts.map((part) => part.byteLength)).toEqual([2, 1, 2]);
  expect(parts[1]?.[0]).toBe(0x81);
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index];
      index += 1;
      if (part === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(part);
    },
    cancel() {
      cancelled = true;
    },
  });
  respond(new Response(stream));
  expect(await fetchPreview(url, new AbortController().signal, digest(bytes), bytes.length)).toBe(
    text,
  );
  expect(cancelled).toBe(false);
  expect(stream.locked).toBe(false);
});

test("preview accepts chunks that sum to the preview limit", async () => {
  expect(PREVIEW_LIMIT).toBe(512 * 1024);
  const bytes = new Uint8Array(PREVIEW_LIMIT);
  bytes.fill(0x61);
  const parts = [
    bytes.subarray(0, 1),
    bytes.subarray(1, PREVIEW_LIMIT - 1),
    bytes.subarray(PREVIEW_LIMIT - 1),
  ];
  expect(parts.map((part) => part.byteLength)).toEqual([1, PREVIEW_LIMIT - 2, 1]);
  let cancelled = false;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index];
      index += 1;
      if (part === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(part);
    },
    cancel() {
      cancelled = true;
    },
  });
  respond(new Response(stream));
  const text = await fetchPreview(
    url,
    new AbortController().signal,
    digest(bytes),
    bytes.byteLength,
  );
  expect(text.length).toBe(PREVIEW_LIMIT);
  expect(digest(text)).toBe(digest(bytes));
  expect(cancelled).toBe(false);
  expect(stream.locked).toBe(false);
});

test("preview rejects a multi-chunk sum past the preview limit and cancels", async () => {
  const head = new Uint8Array(PREVIEW_LIMIT);
  head.fill(0x61);
  const tail = Uint8Array.of(0x62);
  expect(head.byteLength).toBe(PREVIEW_LIMIT);
  expect(tail.byteLength < PREVIEW_LIMIT).toBe(true);
  expect(head.byteLength + tail.byteLength).toBe(PREVIEW_LIMIT + 1);
  const parts = [head, tail];
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[pulls];
      pulls += 1;
      if (part === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(part);
    },
    cancel() {
      cancelled = true;
    },
  });
  respond(new Response(stream));
  await expect(
    fetchPreview(url, new AbortController().signal, digest(head), head.byteLength),
  ).rejects.toMatchObject({ status: 413 });
  expect(pulls).toBe(2);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

test("preview aborts at the next read checkpoint and cancels the reader", async () => {
  const abort = new AbortController();
  const reason = new Error("read-checkpoint");
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Uint8Array.of(0x41));
      abort.abort(reason);
    },
    cancel() {
      cancelled = true;
    },
  });
  respond(new Response(stream));
  await expect(fetchPreview(url, abort.signal, digest("A"), 1)).rejects.toBe(reason);
  expect(pulls).toBe(1);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

test("preview aborts after the response returns and before reading a chunk", async () => {
  const abort = new AbortController();
  const reason = new Error("before-first-read");
  let fetches = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(Uint8Array.of(0x41));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = (async () => {
    fetches += 1;
    abort.abort(reason);
    return new Response(stream);
  }) as unknown as typeof fetch;
  await expect(fetchPreview(url, abort.signal, digest("A"), 1)).rejects.toBe(reason);
  expect(fetches).toBe(1);
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});

test("preview reports the abort reason when a later read fails", async () => {
  const abort = new AbortController();
  const reason = new Error("abort-wins");
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(Uint8Array.of(0x41));
        return;
      }
      abort.abort(reason);
      controller.error(new Error("stream-broke"));
    },
  });
  respond(new Response(stream));
  await expect(fetchPreview(url, abort.signal, digest("A"), 1)).rejects.toBe(reason);
  expect(pulls).toBe(2);
  expect(stream.locked).toBe(false);
});

test("preview reports an interrupted read when the stream fails", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("stream-broke"));
    },
  });
  respond(new Response(stream));
  await expect(
    fetchPreview(url, new AbortController().signal, digest("A"), 1),
  ).rejects.toMatchObject({
    name: "ApiError",
    status: 0,
    message: "ファイルの読み込みが中断されました。再試行してください。",
  });
  expect(stream.locked).toBe(false);
});
