import type {
  ApiCollection,
  JsonObject,
  RawArtifact,
  VPointPayCredential,
} from "./types";

const ORIGIN = "https://vpoint.smbc-card.com";
const TOKEN_PATH = "/vpoint/api/v2/token";
const COMMON_SETTINGS_PATH = "/vpoint/api/v2/common_settings";
const BALANCE_PATH = "/vpoint/api/v2/prepaid/balance";
const TRANSACTION_PATH = "/vpoint/api/v1/prepaid/transaction";
const APP_VERSION = "2.5.0";
const OS_VERSION = "16";
const MAX_HISTORY_MONTHS = 120;
const USER_AGENT =
  `com.smbc_card.vpoint.android_v${APP_VERSION} ` +
  "Mozilla/5.0 (Linux; Android 16; Mobile) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RawJsonResponse {
  rawText: string;
  json: JsonObject;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
}

export async function probeVPointPayApi(options: {
  fetcher?: Fetcher;
  deviceUuid?: string;
} = {}): Promise<void> {
  await requestJson({
    path: COMMON_SETTINGS_PATH,
    deviceUuid: options.deviceUuid ?? crypto.randomUUID(),
    fetcher: options.fetcher ?? defaultFetch,
  });
}

export async function collectVPointPay(options: {
  credential: VPointPayCredential;
  saveRotatedRefreshToken: (refreshToken: string) => Promise<void>;
  fetcher?: Fetcher;
  now?: Date;
}): Promise<ApiCollection> {
  const fetcher = options.fetcher ?? defaultFetch;
  validateCredential(options.credential);
  const token = await refreshAccessToken({
    credential: options.credential,
    fetcher,
  });
  await options.saveRotatedRefreshToken(token.refreshToken);

  const balance = await requestJson({
    path: `${BALANCE_PATH}?force=true&charge_limit=true`,
    accessToken: token.accessToken,
    deviceUuid: options.credential.deviceUuid,
    fetcher,
  });
  const earliestMonth = requiredMonth(
    balance.json.inquiry_period,
    "balance inquiry_period",
  );
  const latestMonth = currentJstMonth(options.now ?? new Date());
  const months = enumerateMonths(earliestMonth, latestMonth);
  const artifacts: RawArtifact[] = [
    {
      dataset: "balance",
      filename: "balance.json",
      mediaType: "application/json",
      body: balance.rawText,
    },
  ];
  let transactionCount = 0;

  for (const month of months) {
    const response = await requestJson({
      path: `${TRANSACTION_PATH}?target_month=${month}`,
      accessToken: token.accessToken,
      deviceUuid: options.credential.deviceUuid,
      fetcher,
    });
    const list = response.json.tran_list;
    if (!Array.isArray(list)) {
      throw new VPointPayProtocolError(
        `transaction ${month} returned no tran_list`,
      );
    }
    transactionCount += list.length;
    artifacts.push({
      dataset: `transactions-${month}`,
      filename: `transactions-${month}.json`,
      mediaType: "application/json",
      body: response.rawText,
    });
  }

  artifacts.push({
    dataset: "collection-summary",
    filename: "collection-summary.json",
    mediaType: "application/json",
    body: JSON.stringify({
      schemaVersion: "vpoint-pay-collection-summary-v1",
      earliestMonth,
      latestMonth,
      transactionMonthCount: months.length,
      transactionCount,
    }),
  });

  return {
    artifacts,
    earliestMonth,
    latestMonth,
    transactionMonthCount: months.length,
    transactionCount,
  };
}

async function refreshAccessToken(options: {
  credential: VPointPayCredential;
  fetcher: Fetcher;
}): Promise<TokenResponse> {
  const response = await requestJson({
    path: TOKEN_PATH,
    method: "POST",
    deviceUuid: options.credential.deviceUuid,
    body: JSON.stringify({
      grant_type: "refresh_token",
      authorization_code: "",
      refresh_token: options.credential.refreshToken,
    }),
    fetcher: options.fetcher,
    isTokenRefresh: true,
  });
  const accessToken = response.json.access_token;
  const refreshToken = response.json.refresh_token;
  if (
    typeof accessToken !== "string" || accessToken.length === 0 ||
    typeof refreshToken !== "string" || refreshToken.length === 0
  ) {
    throw new VPointPayProtocolError("token response omitted rotated tokens");
  }
  return { accessToken, refreshToken };
}

async function requestJson(options: {
  path: string;
  deviceUuid: string;
  fetcher: Fetcher;
  method?: "GET" | "POST";
  body?: string;
  accessToken?: string;
  isTokenRefresh?: boolean;
}): Promise<RawJsonResponse> {
  const response = await options.fetcher(`${ORIGIN}${options.path}`, {
    method: options.method ?? "GET",
    headers: requestHeaders({
      deviceUuid: options.deviceUuid,
      accessToken: options.accessToken,
      hasJsonBody: options.body !== undefined,
    }),
    body: options.body,
    redirect: "manual",
  });
  const rawText = await response.text();
  if (!response.ok) {
    if (options.isTokenRefresh && [400, 401, 403].includes(response.status)) {
      throw new VPointPayReauthenticationRequiredError(response.status);
    }
    throw new VPointPayHttpError(options.path, response.status);
  }
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    throw new VPointPayProtocolError(`${options.path} returned non-JSON`);
  }
  if (!isObject(json)) {
    throw new VPointPayProtocolError(`${options.path} returned invalid JSON`);
  }
  return { rawText, json };
}

function requestHeaders(options: {
  deviceUuid: string;
  accessToken?: string;
  hasJsonBody: boolean;
}): Headers {
  const headers = new Headers({
    accept: "application/json",
    "cache-control": "no-cache",
    "user-agent": USER_AGENT,
    "x-app-version": APP_VERSION,
    "x-os-type": "android",
    "x-os-version": OS_VERSION,
    device_id: makeDeviceId(options.deviceUuid),
  });
  if (options.hasJsonBody) headers.set("content-type", "application/json");
  if (options.accessToken) {
    headers.set("x-vapp-access-token", options.accessToken);
  }
  return headers;
}

export function makeDeviceId(
  uuid: string,
  epochSeconds = Math.floor(Date.now() / 1000),
): string {
  validateDeviceUuid(uuid);
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) {
    throw new Error("V Point Pay epoch seconds must be a positive integer");
  }
  const normalized = uuid.toLowerCase();
  const compact = normalized.replaceAll("-", "");
  const difference = BigInt(`0x${compact}`) - BigInt(epochSeconds);
  const reversed = [...difference.toString(10)].reverse();
  let weighted = 0;
  for (const [index, digit] of reversed.entries()) {
    weighted += ((index % 7) + 3) * Number(digit);
  }
  const remainder = weighted % 13;
  const checkDigit = remainder < 4 ? 0 : 13 - remainder;
  const withoutSecondHyphen = normalized.slice(0, 13) + normalized.slice(14);
  const checked = withoutSecondHyphen.slice(0, 28) +
    String(checkDigit) + withoutSecondHyphen.slice(28);
  const epochAsHex = BigInt(`0x${epochSeconds.toString(10)}`);
  const transformed = checked
    .split("-")
    .map((part) => (BigInt(`0x${part}`) + epochAsHex).toString(16))
    .join("-");
  return `${epochSeconds}-${transformed}`;
}

export function enumerateMonths(start: string, end: string): string[] {
  const startValue = monthIndex(requiredMonth(start, "start month"));
  const endValue = monthIndex(requiredMonth(end, "end month"));
  if (startValue > endValue) {
    throw new VPointPayProtocolError("inquiry period starts after current month");
  }
  const count = endValue - startValue + 1;
  if (count > MAX_HISTORY_MONTHS) {
    throw new VPointPayProtocolError(
      `inquiry period exceeds ${MAX_HISTORY_MONTHS} months`,
    );
  }
  return Array.from({ length: count }, (_, offset) => {
    const value = startValue + offset;
    const year = Math.floor(value / 12);
    const month = (value % 12) + 1;
    return `${year}${String(month).padStart(2, "0")}`;
  });
}

function currentJstMonth(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid collection date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new Error("Could not determine current JST month");
  return `${year}${month}`;
}

function monthIndex(value: string): number {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4));
  return year * 12 + month - 1;
}

function requiredMonth(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{6}$/u.test(value)) {
    throw new VPointPayProtocolError(`${label} is not yyyyMM`);
  }
  const month = Number(value.slice(4));
  if (month < 1 || month > 12) {
    throw new VPointPayProtocolError(`${label} contains an invalid month`);
  }
  return value;
}

function validateCredential(value: VPointPayCredential): void {
  if (value.refreshToken.trim().length === 0) {
    throw new Error("V Point Pay refresh token is empty");
  }
  validateDeviceUuid(value.deviceUuid);
}

function validateDeviceUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("V Point Pay device UUID is invalid");
  }
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

export class VPointPayHttpError extends Error {
  constructor(operation: string, status: number) {
    super(`V Point Pay ${operation} failed with HTTP ${status}`);
    this.name = "VPointPayHttpError";
  }
}

export class VPointPayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VPointPayProtocolError";
  }
}

export class VPointPayReauthenticationRequiredError extends Error {
  constructor(status: number) {
    super(`V Point Pay app reauthentication is required (HTTP ${status})`);
    this.name = "VPointPayReauthenticationRequiredError";
  }
}
