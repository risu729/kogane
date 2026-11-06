// The Processor's internal JSON routes bound their request bodies in bytes
// while reading them: the schedule operator and agent-read routes, the two
// delegated schedule adapters and the change-command API stop at the first
// chunk past 16 KiB and cancel the stream, and answer with the code each route
// already used for a body that is too large. The App bounds the same bodies
// before forwarding them; this is the Processor's own bound. Every body is
// synthetic, and no route reaches storage before its body is read.
import { describe, expect, test } from "bun:test";
import { boundedText } from "../src/bounded-body.ts";
import { changeCommandRoute } from "../src/change-commands.ts";
import { delegatedMaintenanceRoute } from "../src/delegated-maintenance.ts";
import { delegatedScheduleRoute } from "../src/delegated-schedules.ts";
import { scheduleRoute } from "../src/schedule-store.ts";
import { envelopeHeaders } from "./audit-envelope.ts";

const LIMIT = 16 * 1024;
const env = { SCHEDULES_ENABLED: "true" } as unknown as Env;
const BASE = "https://pipeline.internal";

/**
 * A JSON body under the limit in UTF-16 code units and over it in UTF-8 bytes:
 * each "あ" is one code unit and three bytes.
 */
const MULTIBYTE = JSON.stringify({ note: "あ".repeat(6_000) });

/**
 * A body with no content-length that would be 1 MiB if read to the end. It
 * counts the bytes it hands out and whether the reader cancelled it.
 */
function endlessBody(total = 1024 * 1024, chunk = 1024) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= total) return controller.close();
        state.pulled += chunk;
        controller.enqueue(new Uint8Array(chunk).fill(0x20));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state, total };
}

const delegatedExecution = JSON.stringify({
  delegationRef: `dlg_${"b".repeat(64)}`,
  writesPerDay: 1,
  notAfter: new Date(Date.now() + 600_000).toISOString(),
  commandFamilies: [],
});

interface Route {
  name: string;
  path: string;
  headers: Record<string, string>;
  call(request: Request): Promise<Response | null | undefined>;
  tooLarge: { status: number; error: string };
}

const routes: Route[] = [
  {
    name: "schedule operator write",
    path: "/internal/schedules/maintenance",
    headers: {
      "x-kogane-internal-caller": "kogane-evidence-browser",
      "x-kogane-operator": "operator@synthetic.test",
      ...envelopeHeaders(),
    },
    call: (request) => scheduleRoute(request, env, new URL(request.url)),
    tooLarge: { status: 413, error: "request_too_large" },
  },
  {
    name: "schedule agent read",
    path: "/internal/schedules/agent/read",
    headers: {
      "x-kogane-internal-caller": "kogane-evidence-browser",
      "x-kogane-agent": "agent-synthetic",
    },
    call: (request) => scheduleRoute(request, env, new URL(request.url)),
    tooLarge: { status: 413, error: "request_too_large" },
  },
  {
    name: "delegated job update",
    path: "/internal/delegated-schedules/job",
    headers: {
      "x-kogane-internal-caller": "kogane-evidence-browser",
      "x-kogane-verified-actor": "mcp-client:owner-synthetic",
      "x-kogane-actor-kind": "delegated",
      "x-kogane-audit-path": "mcp",
      "x-kogane-correlation-id": crypto.randomUUID(),
      "x-kogane-delegation-ref": `dlg_${"b".repeat(64)}`,
      "x-kogane-delegated-execution": delegatedExecution,
    },
    call: (request) => delegatedScheduleRoute(request, env, new URL(request.url)),
    tooLarge: { status: 413, error: "request_too_large" },
  },
  {
    name: "delegated maintenance update",
    path: "/internal/delegated-maintenance",
    headers: {
      "x-kogane-internal-caller": "kogane-evidence-browser",
      "x-kogane-verified-actor": "mcp-client:owner-synthetic",
      "x-kogane-actor-kind": "delegated",
      "x-kogane-audit-path": "mcp",
      "x-kogane-correlation-id": crypto.randomUUID(),
      "x-kogane-delegation-ref": `dlg_${"b".repeat(64)}`,
      "x-kogane-delegated-execution": delegatedExecution,
    },
    call: (request) => delegatedMaintenanceRoute(request, env, new URL(request.url)),
    tooLarge: { status: 413, error: "request_too_large" },
  },
  {
    name: "change command",
    path: "/command/v1/plan",
    headers: {
      "x-kogane-verified-actor": "operator@synthetic.test",
      "x-kogane-actor-kind": "human",
      ...envelopeHeaders(),
    },
    call: (request) => changeCommandRoute(env, request, new URL(request.url).pathname),
    tooLarge: { status: 400, error: "invalid_command" },
  },
];

describe.each(routes)("$name", (route) => {
  test("a multibyte body under 16 Ki code units but over 16 KiB is too large", async () => {
    expect(MULTIBYTE.length).toBeLessThan(LIMIT);
    expect(new TextEncoder().encode(MULTIBYTE).byteLength).toBeGreaterThan(LIMIT);
    const response = await route.call(
      new Request(`${BASE}${route.path}`, {
        method: "POST",
        headers: route.headers,
        body: MULTIBYTE,
      }),
    );
    expect(response?.status).toBe(route.tooLarge.status);
    expect(await response?.json()).toEqual({ error: route.tooLarge.error });
  });

  test("a streamed body without content-length is refused without reading it all", async () => {
    const { stream, state, total } = endlessBody();
    const request = new Request(`${BASE}${route.path}`, {
      method: "POST",
      headers: route.headers,
      body: stream,
    });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await route.call(request);
    expect(response?.status).toBe(route.tooLarge.status);
    expect(await response?.json()).toEqual({ error: route.tooLarge.error });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(total);
    expect(state.pulled).toBeLessThanOrEqual(LIMIT + 2 * 1024);
  });
});

describe("boundedText", () => {
  const request = (body: BodyInit | null) =>
    new Request(`${BASE}/`, { method: "POST", ...(body === null ? {} : { body }) });

  test("reads a body of exactly the limit and refuses one byte more", async () => {
    expect(await boundedText(request("a".repeat(64)), 64)).toBe("a".repeat(64));
    expect(await boundedText(request("a".repeat(65)), 64)).toBeNull();
    expect(await boundedText(request("あ".repeat(21)), 64)).toBe("あ".repeat(21));
    expect(await boundedText(request("あ".repeat(22)), 64)).toBeNull();
  });

  test("an absent body reads as empty text, like request.text()", async () => {
    expect(await boundedText(request(null), 64)).toBe("");
  });

  test("decodes a character split across chunks", async () => {
    const bytes = new TextEncoder().encode("xあy");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    expect(await boundedText(request(stream), 64)).toBe("xあy");
  });

  test("replaces malformed UTF-8 like request.text(), or throws when fatal", async () => {
    const malformed = Uint8Array.of(0x7b, 0xff, 0x7d);
    expect(await boundedText(request(malformed), 64)).toBe(await request(malformed).text());
    await expect(boundedText(request(malformed), 64, { fatal: true })).rejects.toThrow();
  });
});
