// The operator's 収集を依頼 (Phase 3, ADR 0048): one POST to the operations
// API, the same application service `kogane.ops.collection.request` calls.
// 202 means the request is stored, never that a provider was contacted.

export const COLLECTIONS_PATH = "/api/ops/v1/collections";

export interface AcceptedCollection {
  operationId: string;
  status: string;
}

/** A refused or unreadable answer, with the server's closed code when it sent one. */
export class CollectionRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null) {
    super("collection_request_failed");
    this.name = "CollectionRequestError";
    this.status = status;
    this.code = code;
  }
}

/** Today in Japan, as the date-only bound the request carries. */
export function tokyoDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * A fresh retry key for one confirmation. A re-send under the same key (a
 * retry after a lost answer) is the same operation; a new confirmation is a
 * new request.
 */
export function collectionRequestKey(): string {
  return `ui-collect-${crypto.randomUUID()}`;
}

/**
 * Stores a collection request for a CORE source. The window is today's date:
 * the collector runs its connection's daily scope and the window is stored,
 * not applied (ADR 0048).
 */
export async function postCollectionRequest(
  source: string,
  idempotencyKey: string,
  now: Date = new Date(),
): Promise<AcceptedCollection> {
  const today = tokyoDate(now);
  let response: Response;
  try {
    response = await fetch(COLLECTIONS_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ source, requestedScope: { from: today, to: today }, idempotencyKey }),
    });
  } catch {
    throw new CollectionRequestError(0, null);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    /* An unreadable answer is judged by its status alone. */
  }
  const record =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  if (response.status !== 202) {
    const code = record["error"];
    throw new CollectionRequestError(
      response.status,
      typeof code === "string" && /^[a-z][a-z_]{0,63}$/u.test(code) ? code : null,
    );
  }
  const operationId = record["operationId"],
    status = record["status"];
  if (
    typeof operationId !== "string" ||
    !/^op_[0-9a-f]{64}$/u.test(operationId) ||
    typeof status !== "string"
  )
    throw new CollectionRequestError(response.status, null);
  return { operationId, status };
}
