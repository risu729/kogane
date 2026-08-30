import type {
  GatewayEnvelope,
  JsonObject,
  SessionMaterial,
} from "./types";

const ORIGIN = "https://simple.sbivc.co.jp";
const TRADE_PATH = "/api/cccmdipresen/gw/trade";

const READ_EVENTS = {
  cashBalanceList: true,
  accountMargin: true,
  positionSummaryList: true,
  executionList: true,
  getCashflowList: true,
  tradeReportList: true,
} as const;

export type ReadEvent = keyof typeof READ_EVENTS;

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface PageOptions {
  pageNumber: number;
  pageSize: number;
  historical: boolean;
}

export interface ReportPageOptions {
  statementType: string;
  pageNumber: number;
  pageSize: number;
  fromBasisYmdDate?: string;
  toBasisYmdDate?: string;
  unreadOnly?: boolean;
}

/**
 * Minimal client for four statically verified, read-only events.
 *
 * Deliberately no generic public `send(event)` exists: the same gateway accepts
 * order, withdrawal, lending and authentication-setting writes.
 */
export class SbiVcTradeClient {
  readonly #fetcher: Fetcher;
  readonly #session: SessionMaterial;

  constructor(session: SessionMaterial, fetcher: Fetcher = fetch) {
    validateSession(session);
    this.#session = session;
    this.#fetcher = fetcher;
  }

  cashBalances(productId?: string): Promise<GatewayEnvelope> {
    return this.#read("cashBalanceList", {
      secureKey: this.#session.secureKey,
      ...(productId ? { productId } : {}),
    });
  }

  accountMargin(): Promise<GatewayEnvelope> {
    return this.#read("accountMargin", {
      secureKey: this.#session.secureKey,
    });
  }

  positionSummary(): Promise<GatewayEnvelope> {
    return this.#read("positionSummaryList", {
      secureKey: this.#session.secureKey,
    });
  }

  executions(options: PageOptions): Promise<GatewayEnvelope> {
    return this.#read("executionList", {
      secureKey: this.#session.secureKey,
      pageNumber: String(options.pageNumber),
      pageSize: String(options.pageSize),
      sortKey: "executionDatetime",
      sortAsc: "false",
      isExOrder: "true",
      isCloseOrder: "false",
      historical: String(options.historical),
    });
  }

  cashflows(options: PageOptions): Promise<GatewayEnvelope> {
    return this.#read("getCashflowList", {
      secureKey: this.#session.secureKey,
      pageNumber: String(options.pageNumber),
      pageSize: String(options.pageSize),
      historical: String(options.historical),
      currency: ["JPY"],
      cashflowType: ["REMITTANCE_DEPOSIT", "REMITTANCE_WITHDRAW"],
    });
  }

  tradeReports(options: ReportPageOptions): Promise<GatewayEnvelope> {
    if (!options.statementType.trim()) throw new Error("statementType is required");
    return this.#read("tradeReportList", {
      secureKey: this.#session.secureKey,
      statementType: options.statementType,
      ...(options.fromBasisYmdDate ? { fromBasisYmdDate: options.fromBasisYmdDate } : {}),
      ...(options.toBasisYmdDate ? { toBasisYmdDate: options.toBasisYmdDate } : {}),
      getUnreadReportOnly: String(options.unreadOnly ?? false),
      pageSize: String(options.pageSize),
      pageNumber: String(options.pageNumber),
    });
  }

  async #read(event: ReadEvent, data: JsonObject): Promise<GatewayEnvelope> {
    if (!Object.hasOwn(READ_EVENTS, event)) {
      throw new Error("event is not in the read-only allowlist");
    }
    const response = await this.#fetcher(`${ORIGIN}${TRADE_PATH}`, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: this.#session.cookieHeader,
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
      },
      body: JSON.stringify({ event, data }),
    });
    if (!response.ok) {
      throw new GatewayError(`gateway returned HTTP ${response.status}`, response.status);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      throw new GatewayError("gateway returned a non-JSON response", response.status);
    }
    const parsed = await response.json() as unknown;
    if (!isEnvelope(parsed)) {
      throw new GatewayError("gateway response envelope is invalid", response.status);
    }
    if (parsed.meta.status !== "OK") {
      throw new GatewayError(`gateway status was ${parsed.meta.status}`, response.status);
    }
    return parsed;
  }
}

export class GatewayError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "GatewayError";
  }
}

function validateSession(value: SessionMaterial): void {
  if (!value.cookieHeader.trim() || !value.secureKey.trim()) {
    throw new Error("session material is incomplete");
  }
  if (/\r|\n/u.test(value.cookieHeader)) {
    throw new Error("cookieHeader contains a newline");
  }
}

function isEnvelope(value: unknown): value is GatewayEnvelope {
  if (!isObject(value) || !isObject(value.meta)) return false;
  return typeof value.meta.status === "string" && "body" in value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
