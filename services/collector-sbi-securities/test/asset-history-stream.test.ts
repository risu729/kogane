import { afterEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { ASSET_HISTORY_JSON_LIMITS } from "../../../packages/parsers/src/parsers/sbi-asset-history-json";
import { readAssetHistoryResponse } from "../src/asset-history";
import { fetchAssetHistory } from "../src/main-site";
import { safeFailureCode } from "../src/shared-run";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

for (const contentLength of [null, "1"])
  test(`acquisition cancels an oversized stream before consuming it; Content-Length=${contentLength}`, async () => {
    const limit = ASSET_HISTORY_JSON_LIMITS.bytes;
    const chunkSize = 64 * 1024;
    const total = limit * 2;
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced === total) {
            controller.close();
            return;
          }
          produced += chunkSize;
          controller.enqueue(new Uint8Array(chunkSize));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const headers = new Headers();
    if (contentLength !== null) headers.set("content-length", contentLength);
    const response = new Response(stream, { headers });
    expect(response.headers.get("content-length")).toBe(contentLength);
    globalThis.fetch = mock(async () => response) as unknown as typeof fetch;

    await expect(
      fetchAssetHistory({ assetsUrl: "https://site.invalid/account/assets", cookies: [] }),
    ).rejects.toThrow("sbi_asset_history_bound");
    expect(cancelled).toBe(true);
    expect(produced).toBe(limit + chunkSize);
    expect(produced).toBeLessThan(total);
    expect(stream.locked).toBe(false);
  });

test("the exact byte limit is accepted with every original byte preserved", async () => {
  const limit = ASSET_HISTORY_JSON_LIMITS.bytes;
  const hash = createHash("sha256");
  let produced = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (produced === limit) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(Math.min(1024 * 1024, limit - produced));
        chunk.fill(produced / (1024 * 1024));
        hash.update(chunk);
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const bytes = await readAssetHistoryResponse(new Response(stream));
  expect(bytes.byteLength).toBe(limit);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash.digest("hex"));
  expect(cancelled).toBe(false);
  expect(stream.locked).toBe(false);
});

test("normal chunks preserve split UTF-8 bytes without decoding or rewriting", async () => {
  const original = new TextEncoder().encode('{"synthetic":"円"}');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of original) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  expect(await readAssetHistoryResponse(new Response(stream))).toEqual(original);
});

test("cancellation errors cannot replace the closed overflow failure or leak their cause", async () => {
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(ASSET_HISTORY_JSON_LIMITS.bytes + 1));
      },
      cancel() {
        throw new Error("SYNTHETIC_SENTINEL");
      },
    },
    { highWaterMark: 0 },
  );
  const error = await readAssetHistoryResponse(new Response(stream)).catch(
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("sbi_asset_history_bound");
  expect((error as Error).cause).toBeUndefined();
  expect(safeFailureCode(error)).toBe("sbi_asset_history_bound");
  expect(stream.locked).toBe(false);
});

test("stream failures retain only a closed fetch code and release the reader", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("SYNTHETIC_SENTINEL"));
    },
  });
  const error = await readAssetHistoryResponse(new Response(stream)).catch(
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("sbi_asset_history_fetch_failed");
  expect((error as Error).cause).toBeUndefined();
  expect(safeFailureCode(error)).toBe("sbi_asset_history_fetch_failed");
  expect(stream.locked).toBe(false);
});
