// Synthetic only: there is no outbound fetch, bank hostname, credential or dependency.
export const BACKPRESSURE_CHUNK_BYTES = 64 * 1024;
export const BACKPRESSURE_MAX_CHUNKS = 4096;
// Keep the synthetic HTTP socket alive through the deliberate 35s quiet window.
// This does not change the Container's 30s idle policy or the driver's 120s request deadline.
export const SYNTHETIC_IDLE_TIMEOUT_SECONDS = 60;
export function startSyntheticServer({ hostname = "0.0.0.0", port = 8080 } = {}) {
  return Bun.serve({
    hostname,
    port,
    idleTimeout: SYNTHETIC_IDLE_TIMEOUT_SECONDS,
    fetch: syntheticServer(),
  });
}
export function syntheticServer() {
  const processIdentity = crypto.randomUUID();
  let posts = 0;
  let streams = 0;
  let backpressureChunks = 0;
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ ready: 1 });
    if (path === "/stats")
      return Response.json({ posts, streams, processIdentity, backpressureChunks });
    if (path === "/once" && request.method === "POST") {
      posts++;
      return Response.json({ accepted: 1, processIdentity });
    }
    if (path === "/delay") {
      await new Promise((done) => setTimeout(done, 35_000));
      return Response.json({ completed: 1 });
    }
    if (path === "/backpressure") {
      streams++;
      backpressureChunks = 0;
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          streams--;
        }
      };
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (finished) return;
            if (backpressureChunks === BACKPRESSURE_MAX_CHUNKS) {
              finish();
              controller.close();
              return;
            }
            backpressureChunks++;
            controller.enqueue(crypto.getRandomValues(new Uint8Array(BACKPRESSURE_CHUNK_BYTES)));
          },
          cancel: finish,
        }),
        {
          headers: { "content-type": "application/octet-stream", "cache-control": "no-transform" },
        },
      );
    }
    if (path === "/stream" || path === "/stream-error" || path === "/hold") {
      streams++;
      let count = 0,
        finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          streams--;
        }
      };
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await new Promise((done) => setTimeout(done, 1000));
            if (finished) return;
            if (path === "/stream-error" && count === 35) {
              finish();
              controller.error(new Error("synthetic_stream_failure"));
              return;
            }
            if (count++ === (path === "/hold" ? 300 : 40)) {
              finish();
              controller.close();
            } else controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            finish();
          },
        }),
        { headers: { "content-type": "application/octet-stream" } },
      );
    }
    if (path === "/exit" && request.method === "POST") {
      setTimeout(() => process.exit(7), 100);
      return Response.json({ accepted: 1 });
    }
    return Response.json({ code: "route_missing" }, { status: 404 });
  };
}
if (import.meta.main) {
  process.on("SIGTERM", () => process.exit(0));
  startSyntheticServer();
}
