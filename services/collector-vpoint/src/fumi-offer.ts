import { VPOINT_EMAIL_SUBJECT } from "./email";

export const FUMI_PLUGIN_ID = "kogane-vpoint-otp";
export const FUMI_MANIFEST_VERSION = "1.0.0";
export const FUMI_MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  pluginId: FUMI_PLUGIN_ID,
  version: FUMI_MANIFEST_VERSION,
  protocol: "fumi-offer-v1",
  mode: "exclusive",
  inputFields: ["subject"],
  offerInputFields: ["subject", "envelope", "text"],
  capabilities: ["offer"],
  match: `subject == ${JSON.stringify(VPOINT_EMAIL_SUBJECT)}`,
});

export interface FumiOfferRequest {
  schemaVersion: 1;
  kind: "owner";
  operationId: string;
  requestSha256: string;
  attempt: { generation: number; expiresAt: number };
  source: { eventId: string; rawSha256: string; receivedAt: string };
  pluginId: string;
  manifestVersion: string;
  manifestSha256: string;
  input: {
    subject?: string;
    from?: string;
    to?: string;
    hasAttachments?: boolean;
    envelope?: { from: string; to: string; receivedAt: string };
    text?: string;
  };
}
export interface FumiReceiptRequest {
  schemaVersion: 1;
  operationId: string;
  requestSha256: string;
}
export interface FumiReceipt extends FumiReceiptRequest {
  result: "handled" | "not_applicable" | "retryable_error" | "rejected" | "uncertain" | "not_found";
}

const encoder = new TextEncoder();
const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  if (Object.keys(value).some((key) => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
}
function invalid() {
  return new Error("Invalid Fumi owner request");
}
function text(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    encoder.encode(value).byteLength <= maximum
  );
}
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical((item as Record<string, unknown>)[key])]),
      );
    return item;
  };
  return JSON.stringify(canonical(value));
}
export async function sha256(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function fumiRequestSha256(
  request: Omit<FumiOfferRequest, "requestSha256"> | FumiOfferRequest,
): Promise<string> {
  const { attempt: _attempt, ...body } = request;
  const withoutHash = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "requestSha256"),
  );
  return sha256(canonicalJson(withoutHash));
}
export function parseFumiReceiptRequest(value: unknown): FumiReceiptRequest {
  const item = record(value, ["schemaVersion", "operationId", "requestSha256"]);
  if (
    item["schemaVersion"] !== 1 ||
    typeof item["operationId"] !== "string" ||
    !digestPattern.test(item["operationId"]) ||
    typeof item["requestSha256"] !== "string" ||
    !digestPattern.test(item["requestSha256"])
  )
    throw invalid();
  return item as unknown as FumiReceiptRequest;
}
export async function parseFumiOffer(value: unknown): Promise<FumiOfferRequest> {
  const item = record(value, [
    "schemaVersion",
    "kind",
    "operationId",
    "requestSha256",
    "attempt",
    "source",
    "pluginId",
    "manifestVersion",
    "manifestSha256",
    "input",
  ]);
  parseFumiReceiptRequest({
    schemaVersion: item["schemaVersion"],
    operationId: item["operationId"],
    requestSha256: item["requestSha256"],
  });
  const source = record(item["source"], ["eventId", "rawSha256", "receivedAt"]);
  const attempt = record(item["attempt"], ["generation", "expiresAt"]);
  const input = record(item["input"], [
    "subject",
    "from",
    "to",
    "hasAttachments",
    "envelope",
    "text",
  ]);
  if (
    item["kind"] !== "owner" ||
    !text(item["pluginId"], 64) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(item["pluginId"]) ||
    !text(item["manifestVersion"], 64) ||
    !versionPattern.test(item["manifestVersion"]) ||
    !text(item["manifestSha256"], 64) ||
    !digestPattern.test(item["manifestSha256"]) ||
    !text(source["eventId"], 64) ||
    !digestPattern.test(source["eventId"]) ||
    !text(source["rawSha256"], 64) ||
    !digestPattern.test(source["rawSha256"]) ||
    !validTime(source["receivedAt"]) ||
    !Number.isSafeInteger(attempt["generation"]) ||
    (attempt["generation"] as number) < 0 ||
    !Number.isSafeInteger(attempt["expiresAt"])
  )
    throw invalid();
  for (const field of ["subject", "from", "to"] as const) {
    if (input[field] !== undefined && !text(input[field], 4096)) throw invalid();
  }
  if (
    (input["text"] !== undefined && !text(input["text"], 16 * 1024)) ||
    (input["hasAttachments"] !== undefined && typeof input["hasAttachments"] !== "boolean")
  )
    throw invalid();
  if (input["envelope"] !== undefined) {
    const envelope = record(input["envelope"], ["from", "to", "receivedAt"]);
    if (
      !text(envelope["from"], 320) ||
      !text(envelope["to"], 320) ||
      !validTime(envelope["receivedAt"]) ||
      envelope["receivedAt"] !== source["receivedAt"]
    )
      throw invalid();
  }
  const request = item as unknown as FumiOfferRequest;
  if ((await fumiRequestSha256(request)) !== request.requestSha256) throw invalid();
  return request;
}
export function validTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
export function freshAttempt(request: Pick<FumiOfferRequest, "attempt">, now: number): boolean {
  return request.attempt.expiresAt > now && request.attempt.expiresAt <= now + 10_000;
}
export function receipt(request: FumiReceiptRequest, result: FumiReceipt["result"]): FumiReceipt {
  return {
    schemaVersion: 1,
    operationId: request.operationId,
    requestSha256: request.requestSha256,
    result,
  };
}
