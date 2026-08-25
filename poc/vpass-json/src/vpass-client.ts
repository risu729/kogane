import { Impit } from "impit";
import { CookieJar } from "tough-cookie";

const BASE_URL = "https://www.smbc-card.com";
const MYPAGE_PATH = "/memx/mypage/index.html";
const LOGIN_PAGE_PATH = "/mem/index.jsp";
const UA_DEVICE_PATH = "/memapi/jaxrs/services/api/UAService/getDevice/v1";
const LOGIN_PATH = "/memapi/jaxrs/xt_login/agree/v1";
const CARD_LIST_PATH = "/memapi/jaxrs/multicard/dropdownlist_init/v1";
const CARD_SELECT_PATH = "/memapi/jaxrs/multicard/operation_card_update/v1";
const MEISAI_TOP_PATH = "/memapi/jaxrs/web_meisai/web_meisai_top/v1";
const MEISAI_ANSWER_PATH = "/memapi/jaxrs/meisai/meisai_ans/v1";

export type JsonObject = Record<string, unknown>;

export interface RawJsonResponse {
  rawBytes: Uint8Array;
  rawText: string;
  json: JsonObject;
}

export interface VpassCard {
  name: string;
  value: string;
}

export interface StatementPage extends RawJsonResponse {
  kind: "top" | "answer";
  pageIndex: number;
  transactionCount: number;
}

export interface StatementMonth {
  kind: "web-meisai-top" | "customized-meisai";
  pages: StatementPage[];
  transactionCount: number;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectAt(value: unknown, ...path: string[]): JsonObject | null {
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

function toInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

function pairList(value: unknown): VpassCard[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const name = item["name"];
    const pairValue = item["value"];
    return typeof name === "string" && typeof pairValue === "string"
      ? [{ name, value: pairValue }]
      : [];
  });
}

export function adler32(value: string): number {
  const bytes = new TextEncoder().encode(value);
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

function wrappedBody(path: string, content: JsonObject): JsonObject {
  return {
    header: {
      requestHash: adler32(path),
      requestTimestamp: Date.now(),
      corpCode: "",
    },
    body: { content },
  };
}

export function extractAvailableMonths(response: unknown): string[] {
  const content = objectAt(response, "body", "content");
  if (!content) return [];

  const sources: unknown[] = [
    objectAt(content, "WebMeisaiTopDisplayServiceBean")?.["seikyuYMList"],
    objectAt(content, "WebMeisaiCommonDisplayServiceBean")?.["comSeikyuYMList"],
    objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean")?.["seikyuYMList"],
  ];
  const months = new Set<string>();
  for (const source of sources) {
    for (const pair of pairList(source)) {
      if (/^\d{6}$/.test(pair.value)) months.add(pair.value);
    }
  }
  return [...months].sort().reverse();
}

function topTransactions(response: unknown): unknown[] {
  return arrayAt(
    response,
    "body",
    "content",
    "WebMeisaiTopDisplayServiceBean",
    "meisaiList",
  );
}

function customizedTransactions(response: unknown): unknown[] {
  return arrayAt(
    response,
    "body",
    "content",
    "CustomizedMeisaiAnsDisplayServiceBean",
    "meisaiList",
  );
}

export class VpassClient {
  readonly #cookies = new CookieJar();
  readonly #http = new Impit({
    browser: "chrome",
    cookieJar: this.#cookies,
    headers: { "accept-language": "ja,en-US;q=0.9,en;q=0.8" },
  });
  #bootstrapped = false;
  #authenticated = false;

  async bootstrap(): Promise<void> {
    if (this.#bootstrapped) return;
    await this.#expectOk(await this.#http.fetch(BASE_URL + MYPAGE_PATH), "Vpass top");
    await this.#apiPost(UA_DEVICE_PATH, {}, MYPAGE_PATH, false);
    await this.#expectOk(await this.#http.fetch(BASE_URL + LOGIN_PAGE_PATH), "login page");
    await this.#cookies.setCookie("layout_mode=PC; Path=/; Secure", BASE_URL);
    this.#bootstrapped = true;
  }

  async login(userId: string, password: string): Promise<void> {
    if (!userId || !password) throw new Error("Vpass ID and password are required");
    await this.bootstrap();

    const response = await this.#http.fetch(BASE_URL + LOGIN_PATH, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE_URL,
        referer: BASE_URL + LOGIN_PAGE_PATH,
      },
      body: new URLSearchParams({ userid: userId, password }).toString(),
    });

    if (
      response.status < 300 ||
      response.status >= 400 ||
      response.headers.get("x-loginresult") !== "0"
    ) {
      throw new Error("Vpass login failed; credentials or additional authentication may be required");
    }

    const location = response.headers.get("location");
    if (!location) throw new Error("Vpass login did not return a redirect");
    const next = new URL(location, BASE_URL);
    if (next.origin !== BASE_URL) throw new Error("Refusing a login redirect outside Vpass");
    await this.#expectOk(await this.#http.fetch(next, { redirect: "follow" }), "login redirect");
    await this.#expectOk(await this.#http.fetch(BASE_URL + MYPAGE_PATH), "authenticated top");
    this.#authenticated = true;
  }

  async listCards(): Promise<{ cards: VpassCard[]; evidence: RawJsonResponse }> {
    const evidence = await this.#apiPost(CARD_LIST_PATH, {
      displayDropdownList: "enable",
    });
    const bean = objectAt(
      evidence.json,
      "body",
      "content",
      "DropdownListInitDisplayServiceBean",
    );
    const cards = pairList(bean?.["multiCardInfoList"]);
    if (cards.length === 0) throw new Error("Vpass returned no cards");
    return { cards, evidence };
  }

  async selectCard(cardIdentifyKey: string): Promise<RawJsonResponse> {
    if (!cardIdentifyKey) throw new Error("Card identifier is empty");
    return this.#apiPost(CARD_SELECT_PATH, { cardIdentifyKey });
  }

  async listAvailableMonths(): Promise<{ months: string[]; evidence: RawJsonResponse }> {
    const evidence = await this.#apiPost(MEISAI_TOP_PATH, {});
    const months = extractAvailableMonths(evidence.json);
    if (months.length === 0) throw new Error("Vpass returned no available statement months");
    return { months, evidence };
  }

  async fetchStatementMonth(yyyymm: string): Promise<StatementMonth> {
    if (!/^\d{6}$/.test(yyyymm)) throw new Error(`Invalid statement month: ${yyyymm}`);

    const first = await this.#apiPost(MEISAI_TOP_PATH, { p01: yyyymm });
    const content = objectAt(first.json, "body", "content");
    if (!content) throw new Error("Vpass statement response has no content");

    if (objectAt(content, "WebMeisaiTopDisplayServiceBean")) {
      return this.#fetchWebMeisaiTopPages(yyyymm, first);
    }
    if (objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean")) {
      return this.#fetchCustomizedPages(yyyymm, first);
    }
    throw new Error("Unknown Vpass statement response shape");
  }

  async #fetchWebMeisaiTopPages(
    yyyymm: string,
    first: RawJsonResponse,
  ): Promise<StatementMonth> {
    const pages: StatementPage[] = [];
    let current = first;
    const seenCursors = new Set<string>();
    let complete = false;

    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const transactions = topTransactions(current.json);
      pages.push({
        ...current,
        kind: "top",
        pageIndex,
        transactionCount: transactions.length,
      });

      const bean = objectAt(
        current.json,
        "body",
        "content",
        "WebMeisaiTopDisplayServiceBean",
      );
      const detail = objectAt(bean, "webMeisaiTopK3Vo");
      if (!isTrue(bean?.["nextPageDispFlg"])) {
        complete = true;
        break;
      }

      const cursorCandidate = detail?.["nextPageRow"] ?? bean?.["nextFirstRow"];
      const cursor =
        typeof cursorCandidate === "string" || typeof cursorCandidate === "number"
          ? String(cursorCandidate)
          : "";
      if (!cursor || seenCursors.has(cursor)) {
        throw new Error("Vpass normal statement pagination returned an invalid cursor");
      }
      seenCursors.add(cursor);
      current = await this.#apiPost(MEISAI_TOP_PATH, { p01: yyyymm, p03: cursor });
    }
    if (!complete) throw new Error("Vpass normal statement exceeded 100 pages");

    return {
      kind: "web-meisai-top",
      pages,
      transactionCount: pages.reduce((sum, page) => sum + page.transactionCount, 0),
    };
  }

  async #fetchCustomizedPages(
    yyyymm: string,
    first: RawJsonResponse,
  ): Promise<StatementMonth> {
    const firstTransactions = customizedTransactions(first.json);
    const pages: StatementPage[] = [
      {
        ...first,
        kind: "top",
        pageIndex: 0,
        transactionCount: firstTransactions.length,
      },
    ];
    const bean = objectAt(
      first.json,
      "body",
      "content",
      "CustomizedMeisaiAnsDisplayServiceBean",
    );
    const total = toInteger(bean?.["total"]) ?? firstTransactions.length;
    const pageSize = Math.max(1, toInteger(bean?.["pageSize"]) ?? 100);
    let start = firstTransactions.length;
    let pageIndex = 1;

    while (start < total) {
      const current = await this.#apiPost(MEISAI_ANSWER_PATH, {
        conditionList: [
          { name: "seikyuYM", value: yyyymm },
          { name: "ktmktKbn", value: "0" },
        ],
        start,
        end: start + pageSize - 1,
      });
      const transactions = customizedTransactions(current.json);
      if (transactions.length === 0) {
        throw new Error("Vpass customized statement pagination stopped before total was reached");
      }
      pages.push({
        ...current,
        kind: "answer",
        pageIndex,
        transactionCount: transactions.length,
      });
      start += transactions.length;
      pageIndex += 1;
      if (pageIndex > 100) throw new Error("Vpass customized statement exceeded 100 pages");
    }

    return {
      kind: "customized-meisai",
      pages,
      transactionCount: pages.reduce((sum, page) => sum + page.transactionCount, 0),
    };
  }

  async #apiPost(
    path: string,
    content: JsonObject,
    refererPath = MYPAGE_PATH,
    requireLogin = true,
  ): Promise<RawJsonResponse> {
    if (requireLogin && !this.#authenticated) throw new Error("Vpass login is required");
    const response = await this.#http.fetch(BASE_URL + path, {
      method: "POST",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json",
        origin: BASE_URL,
        referer: BASE_URL + refererPath,
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify(wrappedBody(path, content)),
    });
    await this.#expectOk(response, path);

    const rawBytes = new Uint8Array(await response.arrayBuffer());
    const rawText = new TextDecoder().decode(rawBytes);
    const parsed: unknown = JSON.parse(rawText);
    if (!isObject(parsed)) throw new Error(`Vpass API returned non-object JSON: ${path}`);
    const resultCode = objectAt(parsed, "header")?.["resultCode"];
    if (typeof resultCode === "string" && resultCode !== "0" && resultCode !== "0000") {
      throw new Error(`Vpass API error ${resultCode}: ${path}`);
    }
    return { rawBytes, rawText, json: parsed };
  }

  async #expectOk(
    response: Awaited<ReturnType<Impit["fetch"]>>,
    label: string,
  ): Promise<void> {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${label} was rejected (${response.status}); stopping without retry`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${label} failed (${response.status})`);
    }
  }
}
