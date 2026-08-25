import { randomUUID } from "node:crypto";
import { CookieJar } from "tough-cookie";
import {
  AUTH_KEY_SHA256,
  CONFIG_KEY_SHA256,
  assertPublicKeyHash,
  buildConfigAuth,
  buildFirstLoginAuth,
} from "./mobile-auth";
import {
  adler32,
  extractAvailableMonths,
  isObject,
  objectAt,
  type JsonObject,
  type RawJsonResponse,
  type StatementMonth,
  type StatementPage,
  type VpassCard,
} from "./vpass-client";

const AUTH_URL = "https://spap.smbc-card.com/api/v3/Fauth";
const CONFIG_URL = "https://spap.smbc-card.com/api/v3/common/Config";
const MEMBER_BASE_URL = "https://www.smbc-card.com";
const CARD_LIST_PATH = "/memapi/jaxrs/multicard/dropdownlist_init/v1";
const CARD_SELECT_PATH = "/memapi/jaxrs/multicard/operation_card_update/v1";
const MEISAI_TOP_PATH = "/memapi/jaxrs/web_meisai/web_meisai_top/v1";
const MEISAI_ANSWER_PATH = "/memapi/jaxrs/meisai/meisai_ans/v1";
const APP_VERSION = "5.12.0";
const MOBILE_UA =
  `com.smbc_card.vpass.android_v${APP_VERSION} ` +
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241105.008; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36";

function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  if (extended.getSetCookie) return extended.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g) : [];
}

function arrayAt(value: unknown, ...path: string[]): unknown[] {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function cardsFrom(response: unknown): VpassCard[] {
  const list = objectAt(
    response,
    "body",
    "content",
    "DropdownListInitDisplayServiceBean",
  )?.["multiCardInfoList"];
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => {
    if (!isObject(item)) return [];
    const name = item["name"];
    const value = item["value"];
    return typeof name === "string" && typeof value === "string" ? [{ name, value }] : [];
  });
}

function wrappedBody(path: string, content: JsonObject): string {
  return JSON.stringify({
    header: { requestHash: adler32(path), requestTimestamp: Date.now(), corpCode: "" },
    body: { content },
  });
}

export class MobileVpassClient {
  readonly #cookies = new CookieJar();
  #authenticated = false;

  async login(
    loginId: string,
    password: string,
    authPublicKey: Uint8Array,
    configPublicKey: Uint8Array,
    deviceId = randomUUID(),
  ): Promise<void> {
    assertPublicKeyHash(authPublicKey, AUTH_KEY_SHA256, "auth public key");
    assertPublicKeyHash(configPublicKey, CONFIG_KEY_SHA256, "Config public key");
    const headers = {
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
      headers,
      body: JSON.stringify({
        auth: buildConfigAuth({ deviceId }, configPublicKey),
        appVersion: APP_VERSION,
        osType: "Android",
        osVersion: "35",
      }),
    });
    await this.#absorbCookies(configResponse);
    const config = await this.#parseJson(configResponse, "Config");
    const sessionTime = configResponse.headers.get("x-vappsessiontime");
    if (config.json["status"] !== 200 || !sessionTime) {
      throw new Error("Vpass Config did not establish a session");
    }

    const authResponse = await fetch(AUTH_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...headers,
        cookie: await this.#cookies.getCookieString(AUTH_URL),
        "x-vappsessiontime": sessionTime,
      },
      body: JSON.stringify({
        auth: buildFirstLoginAuth(
          { loginId, password, deviceId, deviceToken: "" },
          authPublicKey,
        ),
        is_first_login: 1,
        push: 0,
        auto_login: 0,
        os_type: 2,
        id_type: 2,
      }),
    });
    await this.#absorbCookies(authResponse);
    const auth = await this.#parseJson(authResponse, "Fauth");
    if (auth.json["status"] !== 200 || typeof objectAt(auth.json, "data")?.["login_token"] !== "string") {
      throw new Error("Vpass Fauth rejected the login");
    }
    this.#authenticated = true;
  }

  async listCards(): Promise<{ cards: VpassCard[]; evidence: RawJsonResponse }> {
    const evidence = await this.#memberPost(CARD_LIST_PATH, { displayDropdownList: "enable" });
    const cards = cardsFrom(evidence.json);
    if (cards.length === 0) throw new Error("Vpass returned no selectable cards");
    return { cards, evidence };
  }

  async selectCard(cardIdentifyKey: string): Promise<RawJsonResponse> {
    return this.#memberPost(CARD_SELECT_PATH, { cardIdentifyKey });
  }

  async listAvailableMonths(): Promise<{ months: string[]; evidence: RawJsonResponse }> {
    const evidence = await this.#memberPost(MEISAI_TOP_PATH, {});
    const months = extractAvailableMonths(evidence.json);
    if (months.length === 0) throw new Error("Vpass returned no available statement months");
    return { months, evidence };
  }

  async fetchStatementMonth(yyyymm: string): Promise<StatementMonth> {
    if (!/^\d{6}$/.test(yyyymm)) throw new Error(`Invalid statement month: ${yyyymm}`);
    const first = await this.#memberPost(MEISAI_TOP_PATH, { p01: yyyymm, p03: "1" });
    const content = objectAt(first.json, "body", "content");
    if (!content) throw new Error(`${yyyymm} response has no content`);
    if (objectAt(content, "WebMeisaiTopDisplayServiceBean")) {
      return this.#fetchFinalized(yyyymm, first);
    }
    if (objectAt(content, "CustomizedMeisaiAnsDisplayServiceBean")) {
      return this.#fetchUsage(yyyymm, first);
    }
    throw new Error(`${yyyymm} returned an unknown statement shape`);
  }

  async #fetchFinalized(yyyymm: string, first: RawJsonResponse): Promise<StatementMonth> {
    const pages: StatementPage[] = [];
    const seen = new Set<string>();
    let current = first;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const bean = objectAt(current.json, "body", "content", "WebMeisaiTopDisplayServiceBean");
      const rows = arrayAt(bean, "meisaiList");
      pages.push({ ...current, kind: "top", pageIndex, transactionCount: rows.length });
      const detail = objectAt(bean, "webMeisaiTopK3Vo");
      const allCount = integer(detail?.["allCnt"]);
      const nextRow = integer(detail?.["nextPageRow"]);
      if (
        (allCount !== null && nextRow !== null && allCount < nextRow) ||
        (rows.length === 0 && pageIndex > 0)
      ) {
        return {
          kind: "web-meisai-top",
          pages,
          transactionCount: pages.reduce((sum, page) => sum + page.transactionCount, 0),
        };
      }
      const cursor = detail?.["nextPageRow"];
      const next = typeof cursor === "string" || typeof cursor === "number" ? String(cursor) : "";
      if (!next || seen.has(next)) throw new Error(`${yyyymm} returned an invalid page cursor`);
      seen.add(next);
      current = await this.#memberPost(MEISAI_TOP_PATH, { p01: yyyymm, p03: next });
    }
    throw new Error(`${yyyymm} exceeded 100 finalized pages`);
  }

  async #fetchUsage(yyyymm: string, first: RawJsonResponse): Promise<StatementMonth> {
    const firstBean = objectAt(
      first.json,
      "body",
      "content",
      "CustomizedMeisaiAnsDisplayServiceBean",
    );
    const firstRows = arrayAt(firstBean, "meisaiList");
    const pages: StatementPage[] = [
      { ...first, kind: "top", pageIndex: 0, transactionCount: firstRows.length },
    ];
    let rowCount = firstRows.length;
    let total = integer(firstBean?.["total"]) ?? rowCount;
    const pageSize = Math.max(1, integer(firstBean?.["pageSize"]) ?? 100);
    let pageIndex = 1;
    let shouldFetch = rowCount === 0 || rowCount < total;
    while (shouldFetch && pageIndex < 100) {
      const current = await this.#memberPost(MEISAI_ANSWER_PATH, {
        seikyuYM: yyyymm,
        start: String(rowCount),
        end: String(rowCount + pageSize - 1),
      });
      const bean = objectAt(
        current.json,
        "body",
        "content",
        "CustomizedMeisaiAnsDisplayServiceBean",
      );
      const rows = arrayAt(bean, "meisaiList");
      pages.push({ ...current, kind: "answer", pageIndex, transactionCount: rows.length });
      if (rows.length === 0) break;
      rowCount += rows.length;
      total = integer(bean?.["total"]) ?? total;
      const pageFlag = bean?.["pageFlg"];
      shouldFetch = rowCount < total || (pageFlag !== "1" && pageFlag !== "3");
      pageIndex += 1;
    }
    if (shouldFetch && pageIndex >= 100) throw new Error(`${yyyymm} exceeded 100 usage pages`);
    return { kind: "customized-meisai", pages, transactionCount: rowCount };
  }

  async #memberPost(path: string, content: JsonObject): Promise<RawJsonResponse> {
    if (!this.#authenticated) throw new Error("Vpass login is required");
    const response = await fetch(MEMBER_BASE_URL + path, {
      method: "POST",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        "content-type": "application/json",
        cookie: await this.#cookies.getCookieString(MEMBER_BASE_URL + path),
        "user-agent": MOBILE_UA,
      },
      body: wrappedBody(path, content),
    });
    await this.#absorbCookies(response);
    const parsed = await this.#parseJson(response, path);
    const resultCode = objectAt(parsed.json, "header")?.["resultCode"];
    if (resultCode !== 0 && resultCode !== "0" && resultCode !== "0000") {
      throw new Error(`${path} returned resultCode ${String(resultCode)}`);
    }
    return parsed;
  }

  async #absorbCookies(response: Response): Promise<void> {
    for (const source of setCookieHeaders(response.headers)) {
      let normalized = `${source.replace(/;\s*domain=[^;]*/gi, "")}; Domain=smbc-card.com`;
      if (!/;\s*path=/i.test(normalized)) normalized += "; Path=/";
      await this.#cookies.setCookie(normalized, AUTH_URL);
    }
  }

  async #parseJson(response: Response, label: string): Promise<RawJsonResponse> {
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${label} was rejected (${response.status}); stopping without retry`);
    }
    if (!response.ok) throw new Error(`${label} failed (${response.status})`);
    const rawBytes = new Uint8Array(await response.arrayBuffer());
    const rawText = new TextDecoder().decode(rawBytes);
    const parsed: unknown = JSON.parse(rawText);
    if (!isObject(parsed)) throw new Error(`${label} returned non-object JSON`);
    return { rawBytes, rawText, json: parsed };
  }
}
