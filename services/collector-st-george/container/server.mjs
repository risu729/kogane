import http from "node:http";
import { pathToFileURL } from "node:url";
import { publicFailure, runBrowserCollection, validateRequest } from "./browser.mjs";

const MAX_REQUEST_BYTES = 16 * 1024;
export function createServer(collect = runBrowserCollection) {
  let active = false;
  return http.createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && request.url === "/health") {
      send(200, { status: "ready" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/collect") {
      send(404, { status: "failed", reason: "not-found" });
      return;
    }
    if (active) {
      send(409, { status: "failed", reason: "busy" });
      return;
    }
    active = true;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) {
          send(413, { status: "failed", reason: "invalid-request" });
          return;
        }
        chunks.push(chunk);
      }
      let value;
      try {
        value = validateRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        send(400, { status: "failed", reason: "invalid-request" });
        return;
      }
      const result = await collect(value);
      send(result.status === "success" ? 200 : 503, result);
    } catch (error) {
      send(503, publicFailure(error));
    } finally {
      active = false;
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.requestTimeout = 200_000;
  server.headersTimeout = 10_000;
  server.listen(8080, "0.0.0.0");
}
