import { CookieJar } from "./cookie-jar";
import { allowedUrl, assertAllowedRequest, type ReadOperation } from "./policy";
import { StopConditionError } from "./types";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface ReadResponse {
  readonly url: URL;
  readonly status: number;
  readonly contentType: string;
  readonly body: ArrayBuffer;
}

export class MyJcbReadClient {
  constructor(
    private readonly jar: CookieJar,
    private readonly userAgent: string,
  ) {}

  async get(
    operation: Exclude<ReadOperation, "login-submit">,
    query?: URLSearchParams,
  ): Promise<ReadResponse> {
    const url = allowedUrl(operation, query);
    assertAllowedRequest(operation, "GET", url);
    const cookie = this.jar.header(url);
    const headers = new Headers({
      Accept: "text/html,application/xhtml+xml,application/octet-stream;q=0.8,*/*;q=0.5",
      "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
      Referer: refererFor(operation),
      "User-Agent": this.userAgent,
    });
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(url, { headers, redirect: "manual" });
    this.jar.updateFromResponse(response, url);
    if (response.status >= 300 && response.status < 400) {
      throw new StopConditionError(
        `MyJCB ${operation} returned an unexpected redirect (${response.status})`,
      );
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw new StopConditionError(`MyJCB ${operation} stopped at HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new StopConditionError(`MyJCB ${operation} returned HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new StopConditionError(`MyJCB ${operation} response exceeds the size limit`);
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new StopConditionError(`MyJCB ${operation} response exceeds the size limit`);
    }
    return {
      url,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      body,
    };
  }
}

function refererFor(operation: Exclude<ReadOperation, "login-submit">): string {
  if (operation === "debit-detail") {
    return allowedUrl(
      "debit-menu",
      new URLSearchParams({ link_id: "myj_main_debitDetailMenu" }),
    ).href;
  }
  if (operation === "debit-menu") return allowedUrl("mypage").href;
  return allowedUrl("login-page").href;
}

export function decodeMyJcbHtml(body: ArrayBuffer, contentType: string): string {
  const charset = contentType.match(/charset\s*=\s*([^;\s]+)/iu)?.[1]?.replace(/["']/gu, "") ??
    "shift_jis";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    throw new StopConditionError(`Unsupported MyJCB response charset: ${charset}`);
  }
}
