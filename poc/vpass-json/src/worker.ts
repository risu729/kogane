import { randomUUID } from "node:crypto";
import {
  AUTH_KEY_SHA256,
  CONFIG_KEY_SHA256,
  assertPublicKeyHash,
  buildConfigAuth,
  buildFirstLoginAuth,
} from "./mobile-auth";

const AUTH_URL = "https://spap.smbc-card.com/api/v3/Fauth";
const CONFIG_URL = "https://spap.smbc-card.com/api/v3/common/Config";
const MEMBER_BASE_URL = "https://www.smbc-card.com";
const CARD_LIST_PATH = "/memapi/jaxrs/multicard/dropdownlist_init/v1";
const CARD_SELECT_PATH = "/memapi/jaxrs/multicard/operation_card_update/v1";
const MEISAI_TOP_PATH = "/memapi/jaxrs/web_meisai/web_meisai_top/v1";
const MEISAI_ANSWER_PATH = "/memapi/jaxrs/meisai/meisai_ans/v1";
const APP_VERSION = "5.12.0";
const MAX_PAGES_PER_MONTH = 100;
const MOBILE_UA =
  `com.smbc_card.vpass.android_v${APP_VERSION} ` +
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241105.008; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36";

interface Env {
  SNAPSHOTS: R2Bucket;
  VPASS_ID: string;
  VPASS_PASSWORD: string;
  VPASS_DEVICE_ID: string;
  VPASS_AUTH_PUBLIC_KEY_B64: string;
  VPASS_CONFIG_PUBLIC_KEY_B64: string;
  ADMIN_TRIGGER_TOKEN: string;
}

type JsonObject = Record<string, unknown>;

interface RawJsonResponse {
  rawText: string;
  json: JsonObject;
}

interface RunSummary {
  runId: string;
  startedAt: string;
  completedAt: string;
  cardCount: number;
  selectedCardIndex: number;
  monthCount: number;
  pageCount: number;
  transactionCount: number;
  objectCount: number;
}

interface AllCardsRunSummary {
  runId: string;
  startedAt: string;
  completedAt: string;
  cardCount: number;
  successCount: number;
  failureCount: number;
  monthCount: number;
  pageCount: number;
  transactionCount: number;
  objectCount: number;
}

interface VpassSession {
  cookies: CookieBag;
  cardList: RawJsonResponse;
  cards: string[];
}

interface MonthCapture {
  pages: Array<{ kind: "top" | "answer"; index: number; rawJson: string }>;
  transactionCount: number;
}

class CookieBag {
  readonly #values = new Map<string, string>();

  absorb(headers: Headers): void {
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    const sources = extended.getSetCookie?.() ?? splitSetCookie(headers.get("set-cookie"));
    for (const source of sources) {
      const pair = source.split(";", 1)[0]?.trim();
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) continue;
      this.#values.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header(): string {
    return [...this.#values].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get size(): number {
    return this.#values.size;
  }
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  // Expires contains a comma, while the next cookie begins after a comma followed
  // by a token and '='. Modern Workers exposes getSetCookie(); this is a fallback.
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: unknown, ...path: string[]): JsonObject | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return isObject(current) ? current : null;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function pairMonths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const month = item["value"];
    return typeof month === "string" && /^\d{6}$/.test(month) ? [month] : [];
  });
}

function cardKeys(response: unknown): string[] {
  const list = objectAt(
    response,
    "body",
    "content",
    "DropdownListInitDisplayServiceBean",
  )?.["multiCardInfoList"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (!isObject(item)) return [];
    const value = item["value"];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
}

function availableMonths(response: unknown): string[] {
  const content = objectAt(response, "body", "content");
  if (!content) return [];
  const sources = [
    objectAt(content, "WebMeisaiTopDisplayServiceBean")?.["seikyuYMList"],
    objectAt(content, "WebMeisaiCommonDisplayServiceBean")?.["comSeikyuYMList"],
    objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean")?.["seikyuYMList"],
  ];
  return [...new Set(sources.flatMap(pairMonths))].sort().reverse();
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function adler32(value: string): number {
  let a = 1;
  let b = 0;
  for (const byte of new TextEncoder().encode(value)) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

function requestBody(path: string, content: JsonObject): string {
  return JSON.stringify({
    header: { requestHash: adler32(path), requestTimestamp: Date.now(), corpCode: "" },
    body: { content },
  });
}

function safeRunId(now = new Date()): string {
  return now.toISOString().replaceAll(":", "-").replace(".", "-");
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing Worker secret: ${name}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "Unknown error";
}

async function jsonResponse(response: Response, label: string): Promise<RawJsonResponse> {
  const rawText = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!isObject(parsed)) throw new Error(`${label} returned non-object JSON`);
  return { rawText, json: parsed };
}

async function authenticate(env: Env, cookies: CookieBag): Promise<void> {
  const authKey = Buffer.from(requireSecret(env.VPASS_AUTH_PUBLIC_KEY_B64, "VPASS_AUTH_PUBLIC_KEY_B64"), "base64");
  const configKey = Buffer.from(
    requireSecret(env.VPASS_CONFIG_PUBLIC_KEY_B64, "VPASS_CONFIG_PUBLIC_KEY_B64"),
    "base64",
  );
  assertPublicKeyHash(authKey, AUTH_KEY_SHA256, "auth public key");
  assertPublicKeyHash(configKey, CONFIG_KEY_SHA256, "Config public key");

  const deviceId = requireSecret(env.VPASS_DEVICE_ID, "VPASS_DEVICE_ID");
  const commonHeaders = {
    accept: "application/json",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "user-agent": MOBILE_UA,
    "x-app-version": APP_VERSION,
    "x-os-version": "15",
  };

  const configResponse = await fetch(CONFIG_URL, {
    method: "POST",
    redirect: "manual",
    headers: commonHeaders,
    body: JSON.stringify({
      auth: buildConfigAuth({ deviceId }, configKey),
      appVersion: APP_VERSION,
      osType: "Android",
      osVersion: "35",
    }),
  });
  cookies.absorb(configResponse.headers);
  const config = await jsonResponse(configResponse, "Config");
  const configStatus = typeof config.json["status"] === "number" ? config.json["status"] : null;
  const sessionTime = configResponse.headers.get("x-vappsessiontime");
  if (configStatus !== 200 || !sessionTime) {
    throw new Error(`Config rejected the session (application status ${String(configStatus)})`);
  }

  const loginId = requireSecret(env.VPASS_ID, "VPASS_ID");
  const password = requireSecret(env.VPASS_PASSWORD, "VPASS_PASSWORD");
  const authResponse = await fetch(AUTH_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...commonHeaders,
      cookie: cookies.header(),
      "x-vappsessiontime": sessionTime,
    },
    body: JSON.stringify({
      auth: buildFirstLoginAuth({ loginId, password, deviceId, deviceToken: "" }, authKey),
      is_first_login: 1,
      push: 0,
      auto_login: 0,
      os_type: 2,
      id_type: 2,
    }),
  });
  cookies.absorb(authResponse.headers);
  const auth = await jsonResponse(authResponse, "Fauth");
  const authStatus = typeof auth.json["status"] === "number" ? auth.json["status"] : null;
  const loginToken = objectAt(auth.json, "data")?.["login_token"];
  if (authStatus !== 200 || typeof loginToken !== "string" || cookies.size === 0) {
    throw new Error(`Fauth rejected the login (application status ${String(authStatus)})`);
  }
}

async function memberPost(cookies: CookieBag, path: string, content: JsonObject): Promise<RawJsonResponse> {
  const response = await fetch(MEMBER_BASE_URL + path, {
    method: "POST",
    headers: {
      accept: "application/json",
      "cache-control": "no-cache",
      "content-type": "application/json",
      cookie: cookies.header(),
      "user-agent": MOBILE_UA,
    },
    body: requestBody(path, content),
  });
  cookies.absorb(response.headers);
  const result = await jsonResponse(response, path);
  const resultCode = objectAt(result.json, "header")?.["resultCode"];
  if (resultCode !== 0 && resultCode !== "0" && resultCode !== "0000") {
    throw new Error(`${path} returned resultCode ${String(resultCode)}`);
  }
  return result;
}

async function openSession(env: Env): Promise<VpassSession> {
  const cookies = new CookieBag();
  await authenticate(env, cookies);
  const cardList = await memberPost(cookies, CARD_LIST_PATH, {
    displayDropdownList: "enable",
  });
  const cards = cardKeys(cardList.json);
  if (cards.length === 0) throw new Error("Vpass returned no selectable cards");
  return { cookies, cardList, cards };
}

async function putJson(env: Env, key: string, rawText: string): Promise<void> {
  await env.SNAPSHOTS.put(key, rawText, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
}

async function putCardError(
  env: Env,
  prefix: string,
  runId: string,
  started: Date,
  selectedCardZeroBased: number,
  error: unknown,
): Promise<void> {
  await putJson(
    env,
    `${prefix}/error.json`,
    JSON.stringify(
      {
        runId,
        startedAt: started.toISOString(),
        failedAt: new Date().toISOString(),
        status: "error",
        message: errorMessage(error),
        selectedCardIndex: selectedCardZeroBased + 1,
        objectCount: 1,
      },
      null,
      2,
    ),
  );
}

async function collectMonth(
  cookies: CookieBag,
  month: string,
): Promise<MonthCapture> {
  // The Android app always supplies p03=1 for the first finalized-statement
  // page. Omitting p03 returns only the display/header bean with zero rows.
  let current = await memberPost(cookies, MEISAI_TOP_PATH, { p01: month, p03: "1" });
  const content = objectAt(current.json, "body", "content");
  if (!content) throw new Error(`${month} response has no content`);

  if (objectAt(content, "WebMeisaiTopDisplayServiceBean")) {
    let transactions = 0;
    const seen = new Set<string>();
    const pages: MonthCapture["pages"] = [];
    for (let page = 0; page < MAX_PAGES_PER_MONTH; page += 1) {
      pages.push({ kind: "top", index: page, rawJson: current.rawText });
      const bean = objectAt(current.json, "body", "content", "WebMeisaiTopDisplayServiceBean");
      const rowCount = arrayAt(bean, "meisaiList").length;
      transactions += rowCount;
      const detail = objectAt(bean, "webMeisaiTopK3Vo");
      const allCount = integer(detail?.["allCnt"]);
      const nextPageRow = integer(detail?.["nextPageRow"]);
      if (
        (allCount !== null && nextPageRow !== null && allCount < nextPageRow) ||
        (rowCount === 0 && page > 0)
      ) {
        return { pages, transactionCount: transactions };
      }
      const candidate = detail?.["nextPageRow"];
      const cursor = typeof candidate === "string" || typeof candidate === "number" ? String(candidate) : "";
      if (!cursor || seen.has(cursor)) throw new Error(`${month} returned an invalid page cursor`);
      seen.add(cursor);
      current = await memberPost(cookies, MEISAI_TOP_PATH, { p01: month, p03: cursor });
    }
    throw new Error(`${month} exceeded ${MAX_PAGES_PER_MONTH} pages`);
  }

  const customized = objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean");
  if (!customized) throw new Error(`${month} returned an unknown statement shape`);
  let transactions = arrayAt(customized, "meisaiList").length;
  const pages: MonthCapture["pages"] = [{ kind: "top", index: 0, rawJson: current.rawText }];
  let total = integer(customized["total"]) ?? transactions;
  const pageSize = Math.max(1, integer(customized["pageSize"]) ?? 100);
  let page = 1;
  // Current/unsettled statements are fetched by a different app method. A
  // top response may merely signal that route with an empty customized bean,
  // so always make the first meisai_ans request when no rows were returned.
  let shouldFetch = transactions === 0 || transactions < total;
  while (shouldFetch && page < MAX_PAGES_PER_MONTH) {
    current = await memberPost(cookies, MEISAI_ANSWER_PATH, {
      seikyuYM: month,
      start: String(transactions),
      end: String(transactions + pageSize - 1),
    });
    const responseBean = objectAt(
      current.json,
      "body",
      "content",
      "CustomizedMeisaiAnsDisplayServiceBean",
    );
    const rows = arrayAt(responseBean, "meisaiList");
    pages.push({ kind: "answer", index: page, rawJson: current.rawText });
    if (rows.length === 0) break;
    transactions += rows.length;
    total = integer(responseBean?.["total"]) ?? total;
    const pageFlag = responseBean?.["pageFlg"];
    shouldFetch = transactions < total || (pageFlag !== "1" && pageFlag !== "3");
    page += 1;
  }
  if (shouldFetch && page >= MAX_PAGES_PER_MONTH) {
    throw new Error(`${month} exceeded ${MAX_PAGES_PER_MONTH} pages`);
  }
  return { pages, transactionCount: transactions };
}

async function captureCard(
  env: Env,
  session: VpassSession,
  selectedCardZeroBased: number,
  started: Date,
  runId: string,
): Promise<RunSummary> {
  const cardLabel = `card-${String(selectedCardZeroBased + 1).padStart(3, "0")}`;
  const prefix =
    `vpass/${started.toISOString().slice(0, 10).replaceAll("-", "/")}/${runId}/${cardLabel}`;
  const { cookies, cardList, cards } = session;
  try {
    const selectedCard = cards[selectedCardZeroBased];
    if (!selectedCard) {
      throw new Error(
        `Requested card ${selectedCardZeroBased + 1}, but Vpass returned ${cards.length} cards`,
      );
    }

    const selection = await memberPost(cookies, CARD_SELECT_PATH, {
      cardIdentifyKey: selectedCard,
    });
    const top = await memberPost(cookies, MEISAI_TOP_PATH, {});
    const months = availableMonths(top.json);
    if (months.length === 0) throw new Error(`${cardLabel} returned no available statement months`);

    let pageCount = 0;
    let transactionCount = 0;
    const monthResults: Record<string, { pages: number; transactions: number }> = {};
    const captures: Record<string, MonthCapture> = {};
    for (const month of months) {
      const result = await collectMonth(cookies, month);
      captures[month] = result;
      monthResults[month] = {
        pages: result.pages.length,
        transactions: result.transactionCount,
      };
      pageCount += result.pages.length;
      transactionCount += result.transactionCount;
    }

    const summary: RunSummary = {
      runId,
      startedAt: started.toISOString(),
      completedAt: new Date().toISOString(),
      cardCount: cards.length,
      selectedCardIndex: selectedCardZeroBased + 1,
      monthCount: months.length,
      pageCount,
      transactionCount,
      objectCount: 2,
    };
    await putJson(
      env,
      `${prefix}/snapshot.json`,
      JSON.stringify({
        format: "kogane-vpass-r2-snapshot/v1",
        runId,
        selectedCardIndex: selectedCardZeroBased + 1,
        cardListRawJson: cardList.rawText,
        selectCardRawJson: selection.rawText,
        webMeisaiTopRawJson: top.rawText,
        months: captures,
      }),
    );
    await putJson(
      env,
      `${prefix}/manifest.json`,
      JSON.stringify({ ...summary, status: "success", months: monthResults }, null, 2),
    );
    return summary;
  } catch (error) {
    await putCardError(env, prefix, runId, started, selectedCardZeroBased, error);
    throw error;
  }
}

async function collectOneCard(
  env: Env,
  selectedCardZeroBased: number,
  scheduledTime = Date.now(),
): Promise<RunSummary> {
  const started = new Date(scheduledTime);
  const runId = safeRunId(started);
  const cardLabel = `card-${String(selectedCardZeroBased + 1).padStart(3, "0")}`;
  const prefix =
    `vpass/${started.toISOString().slice(0, 10).replaceAll("-", "/")}/${runId}/${cardLabel}`;
  let session: VpassSession;
  try {
    session = await openSession(env);
  } catch (error) {
    await putCardError(env, prefix, runId, started, selectedCardZeroBased, error);
    throw error;
  }
  return captureCard(env, session, selectedCardZeroBased, started, runId);
}

async function collectAllCards(env: Env, scheduledTime: number): Promise<AllCardsRunSummary> {
  const started = new Date(scheduledTime);
  const runId = safeRunId(started);
  const runPrefix =
    `vpass/${started.toISOString().slice(0, 10).replaceAll("-", "/")}/${runId}`;
  let session: VpassSession;
  try {
    session = await openSession(env);
  } catch (error) {
    await putJson(
      env,
      `${runPrefix}/error.json`,
      JSON.stringify(
        {
          runId,
          startedAt: started.toISOString(),
          failedAt: new Date().toISOString(),
          status: "error",
          message: errorMessage(error),
          objectCount: 1,
        },
        null,
        2,
      ),
    );
    throw error;
  }

  const summaries: RunSummary[] = [];
  const failures: number[] = [];
  for (let index = 0; index < session.cards.length; index += 1) {
    try {
      summaries.push(await captureCard(env, session, index, started, runId));
    } catch {
      failures.push(index + 1);
    }
  }

  const summary: AllCardsRunSummary = {
    runId,
    startedAt: started.toISOString(),
    completedAt: new Date().toISOString(),
    cardCount: session.cards.length,
    successCount: summaries.length,
    failureCount: failures.length,
    monthCount: summaries.reduce((total, item) => total + item.monthCount, 0),
    pageCount: summaries.reduce((total, item) => total + item.pageCount, 0),
    transactionCount: summaries.reduce((total, item) => total + item.transactionCount, 0),
    objectCount: summaries.reduce((total, item) => total + item.objectCount, 0) + failures.length,
  };
  console.log(JSON.stringify({ event: "vpass-daily-collection-complete", ...summary }));
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${session.cards.length} card collections failed`);
  }
  return summary;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await collectAllCards(env, controller.scheduledTime);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "kogane-vpass-collector-poc" });
    }
    if (
      request.method !== "POST" ||
      (url.pathname !== "/__collect" && url.pathname !== "/__collect-all")
    ) {
      return new Response("Not found", { status: 404 });
    }
    const expected = requireSecret(env.ADMIN_TRIGGER_TOKEN, "ADMIN_TRIGGER_TOKEN");
    if (request.headers.get("authorization") !== `Bearer ${expected}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (url.pathname === "/__collect-all") {
      return Response.json(await collectAllCards(env, Date.now()));
    }
    const requestedCard = Number(url.searchParams.get("card"));
    if (!Number.isInteger(requestedCard) || requestedCard < 1) {
      return Response.json({ error: "card must be a positive integer" }, { status: 400 });
    }
    const summary = await collectOneCard(env, requestedCard - 1);
    return Response.json(summary);
  },
} satisfies ExportedHandler<Env>;
