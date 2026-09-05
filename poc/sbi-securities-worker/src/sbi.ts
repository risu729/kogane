import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { requestPasskeyAccessToken } from "./auth";
import type {
  Artifact,
  DomesticSession,
  ForeignSession,
  SbiCredential,
  SbiEndpoints,
  SbiHandshakeKey,
} from "./types";

const MTS_HEADER_BYTES = 70;
const FOREIGN_USER_AGENT = "SBIFStockAndroid/1.6.10(kogane/0)";

export async function collectDomesticArtifacts(options: {
  endpoints: SbiEndpoints;
  credential: SbiCredential;
  handshakeKey: SbiHandshakeKey;
}): Promise<{ session: DomesticSession; artifacts: Artifact[] }> {
  const accessToken = await requestPasskeyAccessToken({
    authEntryUrl: options.endpoints.authEntryUrl,
    credential: options.credential,
    handshakeKey: options.handshakeKey,
    channel: "kabu-app",
  });
  const session = await loginDomestic(
    accessToken,
    options.endpoints.mtsBaseUrl,
  );
  const positions = await callMts(
    session,
    "F2631",
    fixedAscii("0", 3) +
      fixedAscii("999", 3) +
      fixedAscii(session.branchCode, 3) +
      fixedAscii(session.accountNumber, 7),
  );
  return {
    session,
    artifacts: [
      {
        dataset: "domestic-cash-positions",
        mediaType: "application/json",
        body: {
          format: "sbi-mts-fixed-width-shift-jis",
          trCode: positions.trCode,
          resultCode: positions.resultCode,
          httpStatus: positions.httpStatus,
          accountHash: session.accountHash,
          payloadBase64: positions.payload.toString("base64"),
        },
      },
    ],
  };
}

export async function collectForeignArtifacts(options: {
  endpoints: SbiEndpoints;
  credential: SbiCredential;
  handshakeKey: SbiHandshakeKey;
  from?: string;
  to?: string;
}): Promise<Artifact[]> {
  const accessToken = await requestPasskeyAccessToken({
    authEntryUrl: options.endpoints.authEntryUrl,
    credential: options.credential,
    handshakeKey: options.handshakeKey,
    channel: "foreign-kabu-app",
  });
  const session = await loginForeign(
    accessToken,
    options.endpoints.foreignStockBaseUrl,
  );
  const to = options.to ?? jstDate(new Date());
  const from = options.from ?? addUtcDays(to, -89);
  assertDateRange(from, to);

  const positions = await foreignGraphql(
    session,
    "GetSecuritiesBalanceList",
    SECURITIES_BALANCES,
    {
      input: {
        countryCode: "US",
        page: { pageNum: 1, pageSize: 999 },
      },
    },
  );
  const foreignCash = await foreignGraphql(
    session,
    "GetForeignCashBalance",
    FOREIGN_CASH_BALANCES,
    {
      input: { currencyCode: "USD", days: 5 },
    },
  );
  const historyPages: unknown[] = [];
  for (let pageNum = 1; pageNum <= 20; pageNum += 1) {
    const page = await foreignGraphql(
      session,
      "GetTradeRecordList",
      TRADE_RECORD_LIST,
      {
        input: {
          productCode: "FOREIGN_STOCK",
          countryCode: "US",
          specificAccountCode: null,
          tradeHistoryType: "TRADE_RECORD",
          searchDateType: "TRADE_DATE_BASE",
          searchDateFrom: from,
          searchDateTo: to,
          page: { pageNum, pageSize: 999 },
        },
      },
    );
    historyPages.push(page);
    if (!hasNextTradeRecordPage(page)) break;
    if (pageNum === 20) {
      throw new Error("SBI foreign trade history exceeded 20 pages");
    }
  }

  return [
    {
      dataset: "foreign-cash-positions",
      mediaType: "application/json",
      body: positions,
    },
    {
      dataset: "foreign-cash-balances",
      mediaType: "application/json",
      body: foreignCash,
    },
    {
      dataset: "foreign-trade-records",
      mediaType: "application/json",
      window: { from, to },
      body: { pages: historyPages },
    },
  ];
}

export async function callMts(
  session: DomesticSession,
  trCode: string,
  trin = "",
): Promise<{
  httpStatus: number;
  trCode: string;
  resultCode: string;
  payload: Buffer;
}> {
  const response = await fetch(
    new URL("/mtsmobile/commgate", session.mtsBaseUrl),
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "okhttp/4.12.0",
      },
      body: new URLSearchParams({
        SID: session.sessionId,
        TRCODE: trCode,
        FSTIME: "         ",
        TRIN: trin,
      }),
    },
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  const header = parseMtsHeader(buffer);
  if (header.sessionId) session.sessionId = header.sessionId;
  if (header.trCode && header.trCode !== trCode) {
    throw new Error("SBI MTS response returned an unexpected TR code");
  }
  if (header.resultCode && header.resultCode !== "000000") {
    throw new Error(`SBI MTS ${trCode} failed with result ${header.resultCode}`);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`SBI MTS ${trCode} failed with HTTP ${response.status}`), { httpStatus: response.status });
  }
  return {
    httpStatus: response.status,
    trCode: header.trCode || trCode,
    resultCode: header.resultCode,
    payload: buffer.subarray(Math.min(MTS_HEADER_BYTES, buffer.length)),
  };
}

async function loginDomestic(
  accessToken: string,
  mtsBaseUrl: string,
): Promise<DomesticSession> {
  const response = await fetch(
    new URL("/mtsmobile/ssologingate", requiredHttpsBase(mtsBaseUrl, "SBI MTS base URL")),
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ KIND: "L", TOKEN: accessToken }),
    },
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  const header = parseMtsHeader(buffer);
  if (!response.ok) {
    throw Object.assign(new Error(`SBI MTS login failed with HTTP ${response.status}`), { httpStatus: response.status });
  }
  if (header.resultCode && header.resultCode !== "000000") {
    throw new Error(`SBI MTS login failed with result ${header.resultCode}`);
  }
  const loginStatus = asciiField(buffer, 70, 1);
  if (loginStatus !== "0") {
    throw new Error(`SBI MTS login returned status ${loginStatus || "missing"}`);
  }
  const branchCode = asciiField(buffer, 71, 3);
  const accountNumber = asciiField(buffer, 74, 7);
  if (!header.sessionId || !branchCode || !accountNumber) {
    throw new Error("SBI MTS login response omitted session or account routing fields");
  }
  return {
    sessionId: header.sessionId,
    branchCode,
    accountNumber,
    accountHash: createHash("sha256")
      .update(`${branchCode}:${accountNumber}`)
      .digest("hex")
      .slice(0, 20),
    mtsBaseUrl: requiredHttpsBase(mtsBaseUrl, "SBI MTS base URL"),
  };
}

async function loginForeign(
  accessToken: string,
  baseUrl: string,
): Promise<ForeignSession> {
  const normalizedBase = requiredHttpsBase(
    baseUrl,
    "SBI foreign stock base URL",
  );
  const restUrl = new URL("/rest/", normalizedBase).toString();
  const graphqlBffUrl = new URL("/graphql/bff", normalizedBase).toString();
  const graphqlIntUrl = new URL("/graphql/int", normalizedBase).toString();
  const response = await fetch(
    new URL("account/authentication:ssoLogin", restUrl),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": FOREIGN_USER_AGENT,
      },
      body: JSON.stringify({ ssoToken: accessToken }),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`SBI foreign SSO failed with HTTP ${response.status}`), { httpStatus: response.status });
  }
  const body = parseJsonObject(text, "SBI foreign SSO");
  const sessionId =
    response.headers.get("Set-Session") ?? optionalString(body["sessionId"]);
  const accountId =
    response.headers.get("Account-Id") ?? optionalString(body["accountId"]);
  if (!sessionId || !accountId) {
    throw new Error("SBI foreign SSO omitted session headers");
  }
  const marketPriceHash = await fetchForeignHash({
    path: "information/market_price/countries/US/price_hashes",
    restUrl,
    sessionId,
    accountId,
  });
  return {
    sessionId,
    accountId,
    restUrl,
    graphqlBffUrl,
    graphqlIntUrl,
    userAgent: FOREIGN_USER_AGENT,
    marketPriceHash,
  };
}

async function fetchForeignHash(options: {
  path: string;
  restUrl: string;
  sessionId: string;
  accountId: string;
}): Promise<string> {
  const response = await fetch(new URL(options.path, options.restUrl), {
    headers: foreignHeaders(options),
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`SBI foreign hash request failed with HTTP ${response.status}`), { httpStatus: response.status });
  }
  const body = parseJsonObject(text, "SBI foreign hash");
  const hash = optionalString(body["hashValue"]);
  if (!hash) throw new Error("SBI foreign hash response omitted hashValue");
  return hash;
}

async function foreignGraphql(
  session: ForeignSession,
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(session.graphqlIntUrl, {
    method: "POST",
    headers: {
      ...foreignHeaders(session),
      "content-type": "application/json",
      hash_token: session.marketPriceHash,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `SBI foreign GraphQL ${operationName} failed with HTTP ${response.status}`,
    );
  }
  const body = parseJsonObject(text, `SBI foreign GraphQL ${operationName}`);
  if (Array.isArray(body["errors"]) && body["errors"].length > 0) {
    throw new Error(`SBI foreign GraphQL ${operationName} returned errors`);
  }
  const data = body["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`SBI foreign GraphQL ${operationName} omitted data`);
  }
  return data as Record<string, unknown>;
}

function foreignHeaders(options: {
  sessionId: string;
  accountId: string;
  userAgent?: string;
}): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${options.sessionId}`,
    "account-id": options.accountId,
    "user-agent": options.userAgent ?? FOREIGN_USER_AGENT,
  };
}

function hasNextTradeRecordPage(data: Record<string, unknown>): boolean {
  const list = objectOrUndefined(data["listTradeRecords"]);
  const page = objectOrUndefined(list?.["page"]);
  return page?.["hasNextPage"] === true;
}

function parseMtsHeader(buffer: Buffer): {
  sessionId: string;
  trCode: string;
  resultCode: string;
} {
  if (buffer.length < MTS_HEADER_BYTES) {
    throw new Error("SBI MTS response was shorter than its fixed header");
  }
  return {
    sessionId: asciiField(buffer, 6, 28),
    trCode: asciiField(buffer, 34, 5),
    resultCode: asciiField(buffer, 45, 6),
  };
}

function asciiField(buffer: Buffer, offset: number, width: number): string {
  return buffer
    .subarray(offset, Math.min(offset + width, buffer.length))
    .toString("ascii")
    .replaceAll("\u0000", "")
    .trim();
}

function fixedAscii(value: string, width: number): string {
  if (!/^[\x20-\x7e]*$/u.test(value)) {
    throw new Error("SBI MTS fixed field must contain ASCII only");
  }
  return value.slice(0, width).padEnd(width, " ");
}

function requiredHttpsBase(value: string, label: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return url.toString();
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

function objectOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function assertDateRange(from: string, to: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(to) ||
    from > to
  ) {
    throw new Error("SBI history window must be a valid YYYY-MM-DD range");
  }
  const fromDate = Date.parse(`${from}T00:00:00.000Z`);
  const toDate = Date.parse(`${to}T00:00:00.000Z`);
  const days = Math.floor((toDate - fromDate) / 86_400_000) + 1;
  if (days > 90) throw new Error("SBI history window must not exceed 90 days");
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function jstDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const SECURITIES_BALANCES = `
query GetSecuritiesBalanceList($input: Input_account_balance_ListSecuritiesBalancesRequest) {
  listSecuritiesBalances(input: $input) {
    securitiesBalances {
      specificAccountCode securitiesQuantity frnAcquisitionPrice acquisitionPrice currencyCode countryCode
      securities { countryCode securitiesCode securitiesName securitiesShortName ric }
      market { marketCode marketName marketShortName timeZone }
      evaluationProfitLoss {
        frnEvaluationAmount frnEvaluationProfitLoss evaluationAmount evaluationProfitLoss
        evaluationProfitLossPercent frnEvaluationProfitLossPercent
      }
      stockPrice { last tickArrow }
    }
    page { hasNextPage pageNum pageSize }
  }
}`;

const FOREIGN_CASH_BALANCES = `
query GetForeignCashBalance($input: Input_account_balance_ListForeignScheduleCashBalancesRequest) {
  listForeignScheduleCashBalances(input: $input) {
    foreignCashBalances {
      accountKind
      currencyCashBalances {
        currencyCode
        foreignScheduleCashBalances {
          businessDate daysLater buyPossibleAmount keepCash transferPossibleAmount
          remainingBuyPossibleAmount amountPayValue
        }
      }
    }
  }
}`;

const TRADE_RECORD_LIST = `
query GetTradeRecordList($input: Input_account_ListTradeRecordsRequest) {
  listTradeRecords(input: $input) {
    tradeRecords {
      securities { countryCode securitiesCode securitiesName securitiesShortName ric }
      tradeRecordTypeCode tradeCurrencyCode listedSecuritiesStatus orderPriceKindCode
      specificAccountCode settlementCurrencyCode amount quantity price tradeDate valueDate
      marginCloseLimitType
    }
    page { hasNextPage }
  }
  checkJrNisaOpen { opened }
}`;
