import { applySessionUpdates, cookieHeader, parseGatewayMeta } from "./session";
import type { CollectorArtifact, ReadEvent, SessionMaterial } from "./types";

const ORIGIN = "https://simple.sbivc.co.jp";
const TRADE_URL = `${ORIGIN}/api/cccmdipresen/gw/trade`;
const PAGE_SIZE = 30;
const MAX_PAGES = 100;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function collectSbiVcTrade(options: {
  diagnostic?: ReturnType<typeof import("../../collector-diagnostics/src/index").createDiagnostics>;
  session: SessionMaterial;
  fetcher?: Fetcher;
  onSession: (session: SessionMaterial) => Promise<void>;
  onArtifact: (artifact: CollectorArtifact) => Promise<void>;
}): Promise<SessionMaterial> {
  const fetcher = options.fetcher ?? fetch;
  let session = structuredClone(options.session);

  const collect = async (dataset: string, event: ReadEvent, data: Record<string, unknown>): Promise<unknown> => {
    const stage = `gateway-${dataset.replace(/-page-[0-9]+$/u, "")}`;
    const result = options.diagnostic
      ? await options.diagnostic.step(stage, () => readGateway(fetcher, session, event, data))
      : await readGateway(fetcher, session, event, data);
    session = result.session;
    await options.onSession(session);
    await options.onArtifact({ dataset, body: result.sanitizedBody });
    return result.body;
  };

  await collect("cash-balances", "cashBalanceList", { secureKey: session.secureKey });
  await collect("account-margin", "accountMargin", { secureKey: session.secureKey });
  await collect("position-summary", "positionSummaryList", { secureKey: session.secureKey });
  await collect("executions-recent-page-0001", "executionList", executionData(session, 0, false));

  await collectPages({
    prefix: "executions-historical",
    collect: (dataset, pageNumber) => collect(
      dataset,
      "executionList",
      executionData(session, pageNumber, true),
    ),
  });
  await collectPages({
    prefix: "cashflows-historical",
    collect: (dataset, pageNumber) => collect(dataset, "getCashflowList", {
      secureKey: session.secureKey,
      pageNumber: String(pageNumber),
      pageSize: String(PAGE_SIZE),
      historical: "true",
      currency: ["JPY"],
      cashflowType: ["REMITTANCE_DEPOSIT", "REMITTANCE_WITHDRAW"],
    }),
  });
  return session;
}

function executionData(session: SessionMaterial, pageNumber: number, historical: boolean): Record<string, unknown> {
  return {
    secureKey: session.secureKey,
    pageNumber: String(pageNumber),
    pageSize: String(PAGE_SIZE),
    sortKey: "executionDatetime",
    sortAsc: "false",
    isExOrder: "true",
    isCloseOrder: "false",
    historical: String(historical),
  };
}

async function collectPages(options: {
  prefix: string;
  collect: (dataset: string, pageNumber: number) => Promise<unknown>;
}): Promise<void> {
  let expectedTotal: number | null = null;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const dataset = `${options.prefix}-page-${String(pageNumber + 1).padStart(4, "0")}`;
    const body = await options.collect(dataset, pageNumber);
    const page = pageInfo(body);
    if (page === null) throw new Error(`${options.prefix}_invalid_pagination`);
    expectedTotal ??= page.totalSize;
    if (page.totalSize !== expectedTotal) {
      throw new Error(`${options.prefix}_pagination_total_changed`);
    }
    const offset = pageNumber * PAGE_SIZE;
    const expectedLength = Math.min(PAGE_SIZE, Math.max(expectedTotal - offset, 0));
    if (page.listLength !== expectedLength) {
      throw new Error(`${options.prefix}_pagination_length_mismatch`);
    }
    if (offset + page.listLength >= expectedTotal) return;
  }
  throw new Error(`${options.prefix}_page_limit_exceeded`);
}

async function readGateway(
  fetcher: Fetcher,
  session: SessionMaterial,
  event: ReadEvent,
  data: Record<string, unknown>,
): Promise<{ session: SessionMaterial; body: unknown; sanitizedBody: string }> {
  const response = await fetcher(TRADE_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: cookieHeader(session),
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
    },
    body: JSON.stringify({ event, data }),
  });
  if (!response.ok) throw new Error(`collector_http_${response.status}`);
  if (!(response.headers.get("content-type")?.toLowerCase().includes("application/json"))) {
    throw new Error("collector_non_json_response");
  }
  const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
  const parsed = JSON.parse(text) as unknown;
  const meta = parseGatewayMeta(parsed);
  if (meta.status !== "OK") throw new Error("collector_gateway_rejected");
  const updated = applySessionUpdates(session, response.headers.getSetCookie(), meta).session;
  const sanitized = sanitizeEnvelope(parsed);
  return { session: updated, body: sanitized.body, sanitizedBody: JSON.stringify(sanitized) };
}

function sanitizeEnvelope(value: unknown): { meta: Record<string, unknown>; body: unknown } {
  if (!isRecord(value) || !isRecord(value.meta) || !("body" in value)) {
    throw new Error("collector_invalid_gateway_envelope");
  }
  const { secureKey: _secureKey, ...meta } = value.meta;
  return { meta, body: value.body };
}

function pageInfo(body: unknown): { listLength: number; totalSize: number } | null {
  if (!isRecord(body) || !Array.isArray(body.list)) return null;
  const totalSize = toNonNegativeInteger(body.totalSize);
  if (totalSize === null) return null;
  return { listLength: body.list.length, totalSize };
}

function toNonNegativeInteger(value: unknown): number | null {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("collector_missing_response_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("collector_response_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
