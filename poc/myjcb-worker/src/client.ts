import { CookieJar } from "./cookie-jar";
import { allowedUrl, assertAllowedRequest, type ReadOperation } from "./policy";
import { StopConditionError } from "./types";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
type GetOperation = Exclude<ReadOperation, "login-submit" | "credit-past-json">;

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
    operation: GetOperation,
    query?: URLSearchParams,
  ): Promise<ReadResponse> {
    const url = allowedUrl(operation, query);
    assertAllowedRequest(operation, "GET", url);
    const cookie = this.jar.header(url);
    const headers = new Headers({
      Accept: "text/html,application/xhtml+xml,application/octet-stream;q=0.8,*/*;q=0.5",
      "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
      Referer: refererFor(operation, query),
      "User-Agent": this.userAgent,
    });
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(url, { headers, redirect: "manual" });
    this.jar.updateFromResponse(response, url);
    if (response.status >= 300 && response.status < 400) {
      throw Object.assign(new StopConditionError(`MyJCB ${operation} returned an unexpected redirect (${response.status})`), { httpStatus: response.status });
    }
    if (response.status === 401 || response.status === 403 || response.status === 429) {
      throw Object.assign(new StopConditionError(`MyJCB ${operation} stopped at HTTP ${response.status}`), { httpStatus: response.status });
    }
    if (!response.ok) {
      throw Object.assign(new StopConditionError(`MyJCB ${operation} returned HTTP ${response.status}`), { httpStatus: response.status });
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

  async postCreditPastJson(input: {
    readonly generalJsonShikibetuId: string;
    readonly id: string;
    readonly detailMonth: number;
  }): Promise<ReadResponse> {
    if (!input.generalJsonShikibetuId || input.generalJsonShikibetuId.length > 512) {
      throw new StopConditionError("Rejected invalid MyJCB JSON discriminator");
    }
    if (!/^0301006\d{2}$/u.test(input.id)) {
      throw new StopConditionError("Rejected invalid MyJCB JSON-RPC request ID");
    }
    if (!Number.isInteger(input.detailMonth) || input.detailMonth < 0 || input.detailMonth > 17) {
      throw new StopConditionError("Rejected invalid MyJCB JSON-RPC referer month");
    }
    const operation = "credit-past-json" as const;
    const url = allowedUrl(operation);
    assertAllowedRequest(operation, "POST", url);
    const headers = new Headers({
      Accept: "application/json",
      "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
      "Content-Type": "application/json",
      Origin: url.origin,
      Referer: allowedUrl(
        "credit-detail",
        new URLSearchParams({ detailMonth: String(input.detailMonth), output: "web" }),
      ).href,
      "User-Agent": this.userAgent,
    });
    const cookie = this.jar.header(url);
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(url, {
      method: "POST",
      headers,
      redirect: "manual",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "execute",
        params: [{ generalJsonShikibetuId: input.generalJsonShikibetuId }],
        id: input.id,
      }),
    });
    this.jar.updateFromResponse(response, url);
    if (response.status !== 200) {
      throw Object.assign(new StopConditionError(`MyJCB ${operation} returned HTTP ${response.status}`), { httpStatus: response.status });
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:;|$)/iu.test(contentType)) {
      throw new StopConditionError(`MyJCB ${operation} returned a non-JSON response`);
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new StopConditionError(`MyJCB ${operation} response exceeds the size limit`);
    }
    return { url, status: response.status, contentType, body };
  }
}

function refererFor(operation: GetOperation, query?: URLSearchParams): string {
  if (operation === "credit-csv" || operation === "credit-ofx" || operation === "credit-pdf") {
    const month = query?.get("detailMonth") ?? "0";
    return allowedUrl(
      "credit-detail",
      new URLSearchParams({ detailMonth: month, output: "web" }),
    ).href;
  }
  if (operation === "credit-detail") return allowedUrl("mypage").href;
  if (operation === "credit-menu") return allowedUrl("mypage").href;
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
