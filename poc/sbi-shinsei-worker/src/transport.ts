import {
  AuthenticationBoundaryError,
  ResponseTooLargeError,
  UnknownResponseShapeError,
} from "./errors";
import { assertReadAllowed, getReadRoute } from "./read-allowlist";
import { validateKnownResponse } from "./response-schemas";
import type {
  JsonObject,
  ReadExecutionProfile,
  ReadTransportResult,
  SessionStateStore,
  TransportRequest,
} from "./types";

const JSON_MEDIA_TYPES = new Set(["application/json", "application/javascript", "text/json"]);

/**
 * MobileFirst/WLClient-style read transport.
 *
 * The transport is deliberately unusable while the corresponding catalog
 * entry lacks authenticated-capture validation and a response schema. That
 * check happens before session lookup and before fetch.
 */
export class SbiShinseiReadTransport {
  constructor(
    private readonly options: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      session: SessionStateStore;
      executionProfile?: ReadExecutionProfile;
      userAgent?: string;
    },
  ) {}

  async call(request: TransportRequest): Promise<JsonObject> {
    return (await this.callWithRaw(request)).data;
  }

  async callWithRaw(request: TransportRequest): Promise<ReadTransportResult> {
    const candidate = getReadRoute(request.operation);
    const url = `${candidate.origin}${candidate.path}`;
    const route = assertReadAllowed(
      {
        operation: request.operation,
        method: candidate.method,
        url,
      },
      this.options.executionProfile ?? "direct-http-diagnostic",
    );

    const authorization = this.options.session.getAuthorization();
    const csrfToken = this.options.session.getCsrfToken();
    if (!authorization || !csrfToken) {
      throw new AuthenticationBoundaryError(
        "No validated read-only PowerDirect session is available",
      );
    }

    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      authorization,
      "content-type": "application/json",
      referer: `${route.origin}/SFC/apps/services/www/SFC/desktopbrowser/default/`,
      "x-requested-with": "XMLHttpRequest",
      "X-CSRF-Token": csrfToken,
    };
    if (this.options.userAgent) headers["user-agent"] = this.options.userAgent;
    const init: RequestInit = {
      method: route.method,
      headers,
      redirect: "manual",
    };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);
    const response = await this.options.fetch(url, init);

    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new AuthenticationBoundaryError(
        `PowerDirect authentication boundary returned HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      throw new UnknownResponseShapeError(`PowerDirect read returned HTTP ${response.status}`);
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!contentType || !JSON_MEDIA_TYPES.has(contentType)) {
      throw new UnknownResponseShapeError("PowerDirect read returned an unrecognized content type");
    }

    const body = await readLimited(response, route.maxResponseBytes);
    const rawBody = new TextDecoder().decode(body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new UnknownResponseShapeError("PowerDirect read returned invalid JSON");
    }

    const validated = validateKnownResponse(route.responseSchema, parsed);
    rotateCsrfTokenIfPresent(this.options.session, validated);
    return {
      data: validated,
      rawBody,
      mediaType: contentType,
    };
  }
}

export function rotateCsrfTokenIfPresent(session: SessionStateStore, response: JsonObject): void {
  const header = response.header;
  if (header === undefined) return;
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new UnknownResponseShapeError("Validated PowerDirect response omitted its header object");
  }
  const nextToken = (header as JsonObject).newToken;
  if (nextToken === undefined) return;
  if (typeof nextToken !== "string" || nextToken.length === 0) {
    throw new UnknownResponseShapeError(
      "PowerDirect response contained an invalid next CSRF token",
    );
  }
  session.rotateCsrfToken(nextToken);
}

async function readLimited(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maximumBytes
  ) {
    throw new ResponseTooLargeError("PowerDirect response exceeded size limit");
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError("PowerDirect response exceeded size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
