import type { JsonObject, RawArtifact } from "./types";

const ORIGIN = "https://mypage.tsite.jp";
const BALANCE_PATH = "/api/balance_info";
const HISTORY_PATH = "/api/tpoint_history";
const VMONEY_HISTORY_PATH = "/api/tmoney_history";
const SMFG_PATH = "/api/smfg_point";
const MAX_HISTORY_PAGES = 200;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RawJsonResponse {
  rawText: string;
  json: JsonObject;
}

export interface VPointCollection {
  artifacts: RawArtifact[];
  historyTotal: number;
  historyPageCount: number;
  vMoneyHistoryTotal: number;
  vMoneyHistoryPageCount: number;
}

interface HistoryCollection {
  pages: RawJsonResponse[];
  total: number;
}

export async function collectVPoint(options: {
  sessionCookie: string;
  fetcher?: Fetcher;
}): Promise<VPointCollection> {
  const sessionCookie = parseSessionCookie(options.sessionCookie);
  const client = new VPointClient(options.fetcher ?? defaultFetch, sessionCookie);
  const balance = await client.requestJson(BALANCE_PATH);
  const smfg = await client.requestJson(SMFG_PATH);
  const history = await client.history();
  const vMoneyHistory = await client.vMoneyHistory();
  const artifacts: RawArtifact[] = [
    {
      dataset: "balance-info",
      filename: "balance-info.json",
      mediaType: "application/json",
      body: balance.rawText,
    },
    {
      dataset: "smfg-point",
      filename: "smfg-point.json",
      mediaType: "application/json",
      body: smfg.rawText,
    },
    ...history.pages.map((page, index) => ({
      dataset: `history-page-${String(index + 1).padStart(4, "0")}`,
      filename: `history-page-${String(index + 1).padStart(4, "0")}.json`,
      mediaType: "application/json",
      body: page.rawText,
    })),
    ...vMoneyHistory.pages.map((page, index) => ({
      dataset: `vmoney-history-page-${String(index + 1).padStart(4, "0")}`,
      filename: `vmoney-history-page-${String(index + 1).padStart(4, "0")}.json`,
      mediaType: "application/json",
      body: page.rawText,
    })),
    {
      dataset: "collection-summary",
      filename: "collection-summary.json",
      mediaType: "application/json",
      body: JSON.stringify({
        schemaVersion: "vpoint-collection-summary-v2",
        historyTotal: history.total,
        historyPageCount: history.pages.length,
        vMoneyHistoryTotal: vMoneyHistory.total,
        vMoneyHistoryPageCount: vMoneyHistory.pages.length,
      }),
    },
  ];
  return {
    artifacts,
    historyTotal: history.total,
    historyPageCount: history.pages.length,
    vMoneyHistoryTotal: vMoneyHistory.total,
    vMoneyHistoryPageCount: vMoneyHistory.pages.length,
  };
}

export function parseSessionCookie(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("\r") ||
    trimmed.includes("\n") ||
    !trimmed.includes("=")
  ) {
    throw new Error("V Point session cookie must be a valid Cookie header value");
  }
  return trimmed;
}

export function historyForm(page: number): FormData {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error("V Point history page must be a positive integer");
  }
  const form = new FormData();
  form.set("page", String(page));
  form.set("get_graph", "1");
  form.set("sort", "use");
  form.set("filter_save", "1");
  form.set("filter_use", "1");
  form.set("filter_cancel", "1");
  form.set("filter_expired", "1");
  form.set("filter_transfer", "1");
  form.set("filter_correct", "1");
  form.set("filter_extend", "1");
  form.set("filter_reissue", "1");
  form.set("filter_date", "");
  return form;
}

export function vMoneyHistoryForm(page: number): FormData {
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new Error("V Money history page must be a positive integer");
  }
  const form = new FormData();
  form.set("page", String(page));
  form.set("sort", "use");
  form.set("filter_use", "1");
  form.set("filter_charge", "1");
  form.set("filter_use_cancel", "1");
  form.set("filter_charge_cancel", "1");
  form.set("filter_expired", "1");
  form.set("filter_transfer", "1");
  form.set("filter_refund", "1");
  form.set("filter_date", "");
  return form;
}

class VPointClient {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly sessionCookie: string,
  ) {}

  async requestJson(path: string, body?: BodyInit): Promise<RawJsonResponse> {
    const response = await this.fetcher(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        cookie: this.sessionCookie,
        referer: `${ORIGIN}/?hid=1`,
        "x-requested-with": "XMLHttpRequest",
      },
      body,
      redirect: "manual",
    });
    const rawText = await response.text();
    if (!response.ok) {
      throw new VPointError(path, response.status);
    }
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new Error(`V Point ${path} returned non-JSON`);
    }
    if (!isObject(json)) {
      throw new Error(`V Point ${path} returned invalid JSON`);
    }
    const status = json.status;
    const code = isObject(status) && typeof status.code === "string"
      ? status.code
      : null;
    if (code !== "0000") {
      if (code === "0010") throw new VPointSessionExpiredError();
      throw new Error(
        `V Point ${path} returned application status ${code ?? "unknown"}`,
      );
    }
    return { rawText, json };
  }

  async history(): Promise<HistoryCollection> {
    return this.paginatedHistory(HISTORY_PATH, historyForm, false);
  }

  async vMoneyHistory(): Promise<HistoryCollection> {
    return this.paginatedHistory(VMONEY_HISTORY_PATH, vMoneyHistoryForm, true);
  }

  private async paginatedHistory(
    path: string,
    formForPage: (page: number) => FormData,
    emptyResultsAreEmptyHistory: boolean,
  ): Promise<HistoryCollection> {
    const pages: RawJsonResponse[] = [];
    let declaredTotal: number | null = null;
    let observedRows = 0;
    let pageSize: number | null = null;

    for (let page = 1; page <= MAX_HISTORY_PAGES; page += 1) {
      const response = await this.requestJson(path, formForPage(page));
      const results = response.json.results;
      if (
        emptyResultsAreEmptyHistory &&
        (!isObject(results) || Object.keys(results).length === 0)
      ) {
        pages.push(response);
        return { pages, total: 0 };
      }
      if (!isObject(results)) {
        throw new Error(`${path} returned no results object`);
      }
      const rows = Array.isArray(results.history) ? results.history.length : 0;
      const total = countValue(results.total);
      if (declaredTotal === null) {
        declaredTotal = total;
        pageSize = rows;
        if (declaredTotal > 0 && pageSize === 0) {
          throw new Error("V Point history declared rows but returned an empty first page");
        }
      } else if (total !== declaredTotal) {
        throw new Error("V Point history total changed during pagination");
      }
      pages.push(response);
      observedRows += rows;
      if (observedRows >= declaredTotal || rows === 0) {
        return { pages, total: declaredTotal };
      }
      if (pageSize !== null && rows < pageSize) {
        throw new Error("V Point history ended before the declared total");
      }
    }
    throw new Error("V Point history exceeded the bounded page limit");
  }
}

class VPointError extends Error {
  constructor(operation: string, status: number) {
    super(`V Point ${operation} failed with HTTP ${status}`);
    this.name = "VPointError";
  }
}

export class VPointSessionExpiredError extends Error {
  constructor() {
    super("V Point session is not authenticated or has expired");
    this.name = "VPointSessionExpiredError";
  }
}

function countValue(value: unknown): number {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("V Point history total is invalid");
  }
  return count;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, init);
}
