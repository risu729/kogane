import { expect, test } from "bun:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { miniflareHttpProxyGuarded } from "./miniflare-http-proxy.ts";

function startRuntime(): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: `export default {
        fetch(request) {
          return Response.json({
            url: request.url,
            connection: request.headers.get("connection"),
          });
        },
      };`,
      compatibilityDate: "2026-09-07",
      r2Buckets: ["EVIDENCE"],
    }),
  );
}

test("Miniflare's dispatcher preserves the original URL and closes each runtime connection", async () => {
  expect(miniflareHttpProxyGuarded()).toBe(true);
  const mf = startRuntime();
  try {
    // Bun's built-in undici silently bypasses this dispatcher: before the
    // guard, the Worker saw 127.0.0.1 and connection: keep-alive. Miniflare's
    // routing headers and reset=true must reach its own runtime dispatcher.
    const url = "http://pipeline.internal/transport-check?synthetic=true";
    const response = await mf.dispatchFetch(url);
    expect(await response.json()).toEqual({ url, connection: "close" });
  } finally {
    await mf.dispose();
  }
});

test("a live R2 proxy remains usable after a separate runtime is disposed", async () => {
  const live = startRuntime();
  const separate = startRuntime();
  let separateDisposed = false;
  try {
    const bucket = await live.getR2Bucket("EVIDENCE");
    await bucket.put("before", "synthetic-before");
    const otherBucket = await separate.getR2Bucket("EVIDENCE");
    await otherBucket.put("other", "synthetic-other");
    await separate.dispose();
    separateDisposed = true;
    // The failing CI scenario resumes the shared fixture after disposing a
    // locally scoped runtime. No retry, delay, or replacement fixture is used.
    await bucket.put("after", "synthetic-after");
    expect(await (await bucket.get("before"))?.text()).toBe("synthetic-before");
    expect(await (await bucket.get("after"))?.text()).toBe("synthetic-after");
  } finally {
    await live.dispose();
    if (!separateDisposed) await separate.dispose();
  }
});
