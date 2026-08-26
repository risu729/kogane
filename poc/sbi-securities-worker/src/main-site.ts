import { createHash } from "node:crypto";
import { callMts } from "./sbi";
import type {
  Artifact,
  DomesticSession,
} from "./types";

const MAIN_SITE_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const MEMBER_SITE_ORIGIN = "https://member.c.sbisec.co.jp";

interface ScopedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
}

interface MainSiteAuth {
  baseUrl: string;
  assetsUrl: string;
  cookies: ScopedCookie[];
}

export async function collectMainSiteArtifacts(options: {
  session: DomesticSession;
  mainSiteBaseUrl: string;
  from?: string;
  to?: string;
}): Promise<Artifact[]> {
  const to = options.to ?? jstDate(new Date());
  const from = options.from ?? addUtcDays(to, -89);
  assertDateRange(from, to);
  const auth = await createMainSiteAuth(
    options.session,
    options.mainSiteBaseUrl,
  );
  const artifacts: Artifact[] = [];

  const assets = await fetchAssets(auth);
  artifacts.push({
    dataset: "account-assets-current",
    mediaType: "application/json",
    body: assets,
  });

  const yenHistory = await fetchYenHistory(options.session, auth);
  artifacts.push({
    dataset: "yen-detail-history",
    mediaType: "application/json",
    body: yenHistory,
  });

  const domesticHistory = await fetchDomesticTradeHistory({
    session: options.session,
    auth,
    from,
    to,
  });
  artifacts.push({
    dataset: "domestic-trade-records",
    mediaType: "application/json",
    window: { from, to },
    body: domesticHistory,
  });
  return artifacts;
}

async function createMainSiteAuth(
  session: DomesticSession,
  mainSiteBaseUrl: string,
): Promise<MainSiteAuth> {
  const baseUrl = requiredHttpsBase(mainSiteBaseUrl, "SBI main-site base URL");
  const cookies: ScopedCookie[] = [];
  const siteLinkParam = await fetchMainSiteLinkParam(session);
  const etGateUrl = new URL("/ETGate/", baseUrl);
  setParams(etGateUrl, mainSiteAssetLoginParams(siteLinkParam));

  const etGateResponse = await fetch(etGateUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": MAIN_SITE_USER_AGENT,
    },
    redirect: "manual",
  });
  updateCookieJar(cookies, etGateResponse, etGateUrl);
  const etGateHtml = decodeShiftJis(await etGateResponse.arrayBuffer());
  if (!etGateResponse.ok) {
    throw new Error(
      `SBI main-site ETGate failed with HTTP ${etGateResponse.status}`,
    );
  }
  const form = parseHtmlForm(etGateHtml, etGateUrl);
  const switchResponse = await fetch(form.action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(cookies, form.action),
      referer: etGateUrl.toString(),
      "user-agent": MAIN_SITE_USER_AGENT,
    },
    body: new URLSearchParams(form.fields),
    redirect: "manual",
  });
  updateCookieJar(cookies, switchResponse, form.action);
  const ssoUrl = responseLocationUrl(switchResponse, form.action);
  const ssoResponse = await fetch(ssoUrl, {
    headers: {
      cookie: cookieHeader(cookies, ssoUrl),
      referer: form.action.toString(),
      "user-agent": MAIN_SITE_USER_AGENT,
    },
    redirect: "manual",
  });
  updateCookieJar(cookies, ssoResponse, ssoUrl);
  const assetsUrl = responseLocationUrl(ssoResponse, ssoUrl);
  const assetsResponse = await fetch(assetsUrl, {
    headers: {
      cookie: cookieHeader(cookies, assetsUrl),
      referer: ssoUrl.toString(),
      "user-agent": MAIN_SITE_USER_AGENT,
    },
    redirect: "manual",
  });
  updateCookieJar(cookies, assetsResponse, assetsUrl);
  if (!assetsResponse.ok) {
    throw new Error(
      `SBI main-site assets page failed with HTTP ${assetsResponse.status}`,
    );
  }
  return {
    baseUrl,
    assetsUrl: assetsUrl.toString(),
    cookies,
  };
}

async function fetchAssets(auth: MainSiteAuth): Promise<Record<string, unknown>> {
  const requestUrl = new URL(
    "/account/api/assets/valuations/current",
    auth.assetsUrl,
  );
  const response = await fetch(requestUrl, {
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: cookieHeader(auth.cookies, requestUrl),
      referer: auth.assetsUrl,
      "user-agent": MAIN_SITE_USER_AGENT,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `SBI account assets failed with HTTP ${response.status}`,
    );
  }
  return parseJsonObject(text, "SBI account assets");
}

async function fetchYenHistory(
  session: DomesticSession,
  auth: MainSiteAuth,
): Promise<Record<string, unknown>> {
  const entryUrl = new URL("/ETGate/", auth.baseUrl);
  entryUrl.search = new URLSearchParams({
    _ControlID: "WPLETsmR001Control",
    _PageID: "WPLETsmR001Sdtl23",
    _ActionID: "NoActionID",
    _DataStoreID: "DSWPLETsmR001Control",
    OutSide: "on",
    getFlg: "on",
    path: "banking/yen/detail-history",
  }).toString();
  const page = await fetchMainSiteAuthenticatedPage(session, auth, entryUrl);
  const html = await page.response.text();
  if (!page.response.ok) {
    throw new Error(
      `SBI yen history page failed with HTTP ${page.response.status}`,
    );
  }
  if (html.includes("臨時メンテナンス")) {
    throw new Error("SBI yen history is under maintenance");
  }
  const csrfToken = extractCsrfToken(html);
  if (!csrfToken) throw new Error("SBI yen history page omitted CSRF token");
  const requestUrl = new URL(
    "/banking/api/yen/detail/init",
    MEMBER_SITE_ORIGIN,
  );
  const response = await fetch(requestUrl, {
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: page.cookieHeader,
      referer: new URL(
        "/banking/yen/detail-history",
        MEMBER_SITE_ORIGIN,
      ).toString(),
      "user-agent": MAIN_SITE_USER_AGENT,
      "x-csrf-token": csrfToken,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `SBI yen history API failed with HTTP ${response.status}`,
    );
  }
  return parseJsonObject(text, "SBI yen history API");
}

async function fetchDomesticTradeHistory(options: {
  session: DomesticSession;
  auth: MainSiteAuth;
  from: string;
  to: string;
}): Promise<{ records: DomesticTradeRecord[]; hasMore: boolean }> {
  const initial = await fetchMainSiteAuthenticatedPage(
    options.session,
    options.auth,
    (authenticatedHtml, responseUrl) => {
      const historyLink = [
        ...authenticatedHtml.matchAll(
          /<a\b[^>]*href=["']([^"']*WPLETacR007Control[^"']*)["'][^>]*>[\s\S]*?<\/a>/giu,
        ),
      ][0]?.[1];
      if (!historyLink) {
        throw new Error(
          "SBI authenticated page omitted the domestic trade-history link",
        );
      }
      return new URL(historyLink.replaceAll("&amp;", "&"), responseUrl);
    },
  );
  let response = initial.response;
  let html = decodeShiftJis(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(
      `SBI domestic trade history failed with HTTP ${response.status}`,
    );
  }
  if (titleText(html)?.includes("メンテナンス")) {
    throw new Error("SBI domestic trade history is under maintenance");
  }

  const form = parseHtmlFormContaining(
    html,
    new URL(response.url),
    "ACT_search",
  );
  const [fromYear, fromMonth, fromDay] = options.from.split("-");
  const [toYear, toMonth, toDay] = options.to.split("-");
  const fields = new URLSearchParams(form.fields);
  fields.set("ref_from_yyyy", fromYear ?? "");
  fields.set("ref_from_mm", fromMonth ?? "");
  fields.set("ref_from_dd", fromDay ?? "");
  fields.set("ref_to_yyyy", toYear ?? "");
  fields.set("ref_to_mm", toMonth ?? "");
  fields.set("ref_to_dd", toDay ?? "");
  fields.set("max_cnt", "200");

  const searchResponse = await fetch(form.action, {
    method: form.method,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader(initial.cookies, form.action),
      referer: response.url,
      "user-agent": MAIN_SITE_USER_AGENT,
    },
    body: fields,
    redirect: "manual",
  });
  updateCookieJar(initial.cookies, searchResponse, form.action);
  response = searchResponse;
  if (response.headers.has("location")) {
    const resultUrl = responseLocationUrl(response, form.action);
    response = await fetch(resultUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie: cookieHeader(initial.cookies, resultUrl),
        referer: form.action.toString(),
        "user-agent": MAIN_SITE_USER_AGENT,
      },
      redirect: "manual",
    });
    updateCookieJar(initial.cookies, response, resultUrl);
  }
  html = decodeShiftJis(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(
      `SBI domestic trade-history search failed with HTTP ${response.status}`,
    );
  }
  return parseDomesticTradeRecords(html);
}

async function fetchMainSiteAuthenticatedPage(
  session: DomesticSession,
  auth: MainSiteAuth,
  entry:
    | URL
    | ((authenticatedHtml: string, responseUrl: URL) => URL),
): Promise<{
  response: Response;
  cookieHeader: string;
  cookies: ScopedCookie[];
}> {
  const cookies = auth.cookies.map((cookie) => ({ ...cookie }));
  const siteLinkParam = await fetchMainSiteLinkParam(session);
  const loginUrl = new URL("/ETGate/", auth.baseUrl);
  setParams(loginUrl, mainSiteAssetLoginParams(siteLinkParam));
  const loginResponse = await fetch(loginUrl, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      cookie: cookieHeader(cookies, loginUrl),
      referer: auth.assetsUrl,
      "user-agent": MAIN_SITE_USER_AGENT,
    },
    redirect: "manual",
  });
  updateCookieJar(cookies, loginResponse, loginUrl);

  let requestUrl: URL;
  let referer: string;
  const location = loginResponse.headers.get("location");
  if (location) {
    requestUrl = new URL(location, loginUrl);
    referer = loginUrl.toString();
  } else {
    const loginHtml = decodeShiftJis(await loginResponse.arrayBuffer());
    if (!loginResponse.ok) {
      throw new Error(
        `SBI main-site session switch failed with HTTP ${loginResponse.status}`,
      );
    }
    const form = parseHtmlForm(loginHtml, loginUrl);
    const switchResponse = await fetch(form.action, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(cookies, form.action),
        referer: loginUrl.toString(),
        "user-agent": MAIN_SITE_USER_AGENT,
      },
      body: new URLSearchParams(form.fields),
      redirect: "manual",
    });
    updateCookieJar(cookies, switchResponse, form.action);
    requestUrl = responseLocationUrl(switchResponse, form.action);
    referer = form.action.toString();
  }

  const authenticated = await followRedirects(requestUrl, referer, cookies);
  const authenticatedHtml = decodeShiftJis(
    await authenticated.response.arrayBuffer(),
  );
  requestUrl =
    typeof entry === "function"
      ? entry(authenticatedHtml, authenticated.url)
      : entry;
  const result = await followRedirects(
    requestUrl,
    auth.assetsUrl,
    cookies,
  );
  return {
    response: result.response,
    cookieHeader: cookieHeader(cookies, result.url),
    cookies,
  };
}

async function followRedirects(
  initialUrl: URL,
  initialReferer: string,
  cookies: ScopedCookie[],
): Promise<{ response: Response; url: URL }> {
  let requestUrl = initialUrl;
  let referer = initialReferer;
  for (let count = 0; count < 10; count += 1) {
    const response = await fetch(requestUrl, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie: cookieHeader(cookies, requestUrl),
        referer,
        "user-agent": MAIN_SITE_USER_AGENT,
      },
      redirect: "manual",
    });
    updateCookieJar(cookies, response, requestUrl);
    const location = response.headers.get("location");
    if (!location) return { response, url: requestUrl };
    referer = requestUrl.toString();
    requestUrl = new URL(location, requestUrl);
  }
  throw new Error("SBI main-site navigation exceeded 10 redirects");
}

async function fetchMainSiteLinkParam(
  session: DomesticSession,
): Promise<string> {
  const response = await callMts(
    session,
    "F1132",
    fixedAscii(session.branchCode, 3) +
      fixedAscii(session.accountNumber, 7),
  );
  const value = decodeShiftJis(response.payload.subarray(0, 1000)).trim();
  if (!value) throw new Error("SBI MTS F1132 omitted the main-site link");
  return value;
}

interface DomesticTradeRecord {
  id: string;
  tradeDate?: string;
  issueName: string;
  issueCode: string;
  marketLabel: string;
  tradeType: string;
  accountLabel: string;
  orderKind: string;
  quantity: string;
  price: string;
  valueDate?: string;
  amount: string;
  rawCells: string[];
}

function parseDomesticTradeRecords(
  html: string,
): { records: DomesticTradeRecord[]; hasMore: boolean } {
  const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)]
    .map((match) => match[1] ?? "")
    .find(
      (candidate) =>
        htmlText(candidate).includes("約定日") &&
        htmlText(candidate).includes("約定数量"),
    );
  if (!table) {
    if (/\bname=["']ACT_search["']/iu.test(html)) {
      return { records: [], hasMore: false };
    }
    throw new Error("SBI domestic history response omitted its result table");
  }

  const occurrences = new Map<string, number>();
  const records = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)]
    .map((row) =>
      [...(row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map(
        (cell) => htmlText(cell[1] ?? ""),
      ),
    )
    .filter(
      (cells) =>
        cells.length === 7 && /^\d{2}\/\d{2}\/\d{2}$/u.test(cells[0] ?? ""),
    )
    .map((cells) => {
      const issue = cells[1] ?? "";
      const issueMatch = issue.match(/^(.+?)\s+([0-9A-Z]{4})\s+(.+)$/u);
      const trade = (cells[2] ?? "").match(/^(.+?)\s+([^/]+)\/\s*(.*)$/u);
      const quantityPrice = (cells[3] ?? "").match(
        /^([\d,.+-]+)\s+([\d,.+-]+)$/u,
      );
      const valueAmount = (cells[5] ?? "").match(
        /^(\d{2}\/\d{2}\/\d{2})\s+([\d,.+△()-]+)$/u,
      );
      const fingerprint = createHash("sha256")
        .update(cells.join("\u001f"))
        .digest("hex")
        .slice(0, 24);
      const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
      occurrences.set(fingerprint, occurrence);
      const tradeDate = shortDate(cells[0] ?? "");
      const valueDate = shortDate(valueAmount?.[1] ?? "");
      return {
        id: `${fingerprint}:${occurrence}`,
        ...(tradeDate ? { tradeDate } : {}),
        issueName: issueMatch?.[1]?.trim() ?? issue,
        issueCode: issueMatch?.[2] ?? "",
        marketLabel: issueMatch?.[3] ?? "",
        tradeType: trade?.[1]?.trim() ?? cells[2] ?? "",
        accountLabel: trade?.[2]?.trim() ?? "",
        orderKind: trade?.[3]?.trim() ?? "",
        quantity: quantityPrice?.[1] ?? "",
        price: quantityPrice?.[2] ?? "",
        ...(valueDate ? { valueDate } : {}),
        amount: valueAmount?.[2] ?? "",
        rawCells: cells,
      };
    });
  return { records, hasMore: records.length >= 200 };
}

function mainSiteAssetLoginParams(siteLinkParam: string): Record<string, string> {
  return {
    _ControlID: "WPLETlgR001Control",
    _PageID: "WPLETlgR001Rlgn20",
    _DataStoreID: "DSWPLETlgR001Control",
    _ActionID: "NoActionID",
    _ReturnPageInfo:
      "WPLETsmR001Control/WPLETsmR001Sdtl18/NoActionID/DSWPLETsmR001Control",
    getFlg: "on",
    sw_param1: "account",
    sw_param2: "assets",
    OutSide: "on",
    page_from: "3",
    allPrmFlg: "on",
    ACT_login: "",
    RSW: siteLinkParam,
  };
}

function parseHtmlForm(
  html: string,
  baseUrl: URL,
): { action: URL; fields: Array<[string, string]> } {
  const opening = html.match(/<form\b[^>]*>/iu)?.[0];
  if (!opening) throw new Error("SBI main-site response omitted a form");
  const action = attributeValue(opening, "action");
  if (!action) throw new Error("SBI main-site form omitted action");
  const fields: Array<[string, string]> = [];
  for (const match of html.matchAll(/<input\b[^>]*>/giu)) {
    const name = attributeValue(match[0], "name");
    if (name) fields.push([name, attributeValue(match[0], "value") ?? ""]);
  }
  if (fields.length === 0) throw new Error("SBI main-site form omitted fields");
  return { action: new URL(action, baseUrl), fields };
}

function parseHtmlFormContaining(
  html: string,
  baseUrl: URL,
  controlName: string,
): {
  action: URL;
  method: string;
  fields: Array<[string, string]>;
} {
  const match = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/giu)].find(
    (candidate) =>
      new RegExp(`\\bname=["']${controlName}["']`, "iu").test(
        candidate[2] ?? "",
      ),
  );
  if (!match) throw new Error(`SBI main-site response omitted ${controlName}`);
  const opening = `<form${match[1] ?? ""}>`;
  const body = match[2] ?? "";
  const action = new URL(
    attributeValue(opening, "action") ?? baseUrl.toString(),
    baseUrl,
  );
  const method = (attributeValue(opening, "method") ?? "GET").toUpperCase();
  const fields: Array<[string, string]> = [];
  for (const input of body.matchAll(/<input\b[^>]*>/giu)) {
    const tag = input[0];
    const name = attributeValue(tag, "name");
    if (!name || /\bdisabled\b/iu.test(tag)) continue;
    const type = (attributeValue(tag, "type") ?? "text").toLowerCase();
    if (
      (type === "checkbox" || type === "radio") &&
      !/\bchecked\b/iu.test(tag)
    ) {
      continue;
    }
    if (
      (type === "submit" || type === "button") &&
      name !== controlName
    ) {
      continue;
    }
    fields.push([name, attributeValue(tag, "value") ?? ""]);
  }
  for (const select of body.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/giu,
  )) {
    const name = attributeValue(`<select${select[1] ?? ""}>`, "name");
    if (!name || /\bdisabled\b/iu.test(select[1] ?? "")) continue;
    const entries = [
      ...(select[2] ?? "").matchAll(
        /<option\b([^>]*)>([\s\S]*?)<\/option>/giu,
      ),
    ];
    const selected =
      entries.find((entry) => /\bselected\b/iu.test(entry[1] ?? "")) ??
      entries[0];
    if (selected) {
      fields.push([
        name,
        attributeValue(`<option${selected[1] ?? ""}>`, "value") ??
          htmlText(selected[2] ?? ""),
      ]);
    }
  }
  return { action, method, fields };
}

function updateCookieJar(
  jar: ScopedCookie[],
  response: Response,
  requestUrl: URL,
): void {
  for (const header of setCookieHeaders(response.headers)) {
    const parts = header.split(";").map((part) => part.trim());
    const nameValue = parts[0];
    const separator = nameValue?.indexOf("=") ?? -1;
    if (!nameValue || separator <= 0) continue;
    const attributes = new Map<string, string>();
    for (const part of parts.slice(1)) {
      const attributeSeparator = part.indexOf("=");
      const name = (
        attributeSeparator < 0 ? part : part.slice(0, attributeSeparator)
      ).toLowerCase();
      attributes.set(
        name,
        attributeSeparator < 0 ? "" : part.slice(attributeSeparator + 1),
      );
    }
    const domainAttribute = attributes
      .get("domain")
      ?.replace(/^\./u, "")
      .toLowerCase();
    const cookie: ScopedCookie = {
      name: nameValue.slice(0, separator),
      value: nameValue.slice(separator + 1),
      domain: domainAttribute ?? requestUrl.hostname.toLowerCase(),
      path: attributes.get("path") ?? defaultCookiePath(requestUrl.pathname),
      hostOnly: !domainAttribute,
      secure: attributes.has("secure"),
    };
    const existing = jar.findIndex(
      (entry) =>
        entry.name === cookie.name &&
        entry.domain === cookie.domain &&
        entry.path === cookie.path,
    );
    if (existing >= 0) jar.splice(existing, 1);
    if (cookie.value && attributes.get("max-age") !== "0") jar.push(cookie);
  }
}

function cookieHeader(jar: ScopedCookie[], requestUrl: URL): string {
  return jar
    .filter((cookie) => {
      const hostname = requestUrl.hostname.toLowerCase();
      const domainMatches = cookie.hostOnly
        ? hostname === cookie.domain
        : hostname === cookie.domain ||
          hostname.endsWith(`.${cookie.domain}`);
      const pathMatches =
        requestUrl.pathname === cookie.path ||
        requestUrl.pathname.startsWith(
          cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`,
        );
      return (
        domainMatches &&
        pathMatches &&
        (!cookie.secure || requestUrl.protocol === "https:")
      );
    })
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  return (
    extended.getSetCookie?.() ??
    headers.get("set-cookie")?.split(/,(?=\s*[^;,]+=)/gu) ??
    []
  );
}

function responseLocationUrl(response: Response, baseUrl: URL): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(
      `SBI main-site expected redirect but received HTTP ${response.status}`,
    );
  }
  return new URL(location, baseUrl);
}

function attributeValue(tag: string, name: string): string | undefined {
  const match = tag.match(
    new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"),
  );
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtml(value);
}

function extractCsrfToken(html: string): string | undefined {
  return (
    html.match(
      /<meta[^>]+name=["']_csrf["'][^>]+content=["']([^"']+)["']/iu,
    )?.[1] ??
    html.match(
      /<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/iu,
    )?.[1] ??
    html.match(/["']_csrf["']\s*:\s*["']([^"']+)["']/u)?.[1] ??
    html.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/u)?.[1]
  );
}

function htmlText(value: string): string {
  return decodeHtml(textOutsideTags(value))
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function textOutsideTags(value: string): string {
  let output = "";
  let inTag = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (!inTag) {
      if (character !== "<") {
        output += character;
        continue;
      }
      inTag = true;
      if (/^<br(?:\s|\/|>)/iu.test(value.slice(index, index + 5))) {
        output += " ";
      }
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      inTag = false;
    }
  }
  return output;
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function decodeShiftJis(value: ArrayBuffer | Uint8Array): string {
  return new TextDecoder("shift-jis").decode(value);
}

function titleText(html: string): string | undefined {
  return html
    .match(/<title>(.*?)<\/title>/isu)?.[1]
    ?.replace(/\s+/gu, " ")
    .trim();
}

function shortDate(value: string): string | undefined {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{2})$/u);
  return match ? `20${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function setParams(url: URL, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    url.searchParams.set(key, value);
  }
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
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

function assertDateRange(from: string, to: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(to) ||
    from > to
  ) {
    throw new Error("SBI history window must be a valid YYYY-MM-DD range");
  }
  const days =
    Math.floor(
      (Date.parse(`${to}T00:00:00.000Z`) -
        Date.parse(`${from}T00:00:00.000Z`)) /
        86_400_000,
    ) + 1;
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
