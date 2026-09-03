import type {
  JsonObject,
  RawArtifact,
  SonyBankCredential,
} from "./types";

const ORIGIN = "https://sonybank.jp";
const LOGIN_PAGE = `${ORIGIN}/pages/db/dbca0100/input/`;
const DASHBOARD_PAGE = `${ORIGIN}/pages/da/daya010a/`;
const HISTORY_PAGE = `${ORIGIN}/pages/ea/eaba0600/search/`;
const WALLET_CONFIRM_PAGE = `${ORIGIN}/pages/ja/jada160a/confirm1/`;
const LOGIN_PATH = "/custom-web00/dbca/cust-web/to-customers/login";
const CSRF_PATH = "/custom-web00/dbca/csrf-token/get";
const GROSS_BALANCE_PATH = "/custom-web00/dcba/cust-web/gross-balance/acq";
const HISTORY_PATH =
  "/custom-web00/eaba/cust-web/ordinary-deposit-transaction-histories";
const HISTORY_PAGER_PATH =
  "/custom-web00/eaba/cust-web/ordinary-deposit-transaction-histories-pager";
const HISTORY_CSV_PATH =
  "/custom-web00/eaba/ordinary-deposit-transaction-histories/csv/load";
const WALLET_SSO_PATH = "/custom-web00/jada/debit-sso/login-usage-dtl-inq";
const WALLET_GATEWAY_URL = "https://igw.sonybank.jp/vcfb/vcfb02001";
const WALLET_CARD_ORIGIN = "https://dc.sonybank.jp";
const PAGE_SIZE = 3;
const MAX_HISTORY_PAGES = 1_000;
const WALLET_MONTH_INTERVAL_MS = 10_250;
const FOREIGN_CURRENCY_CODES = [
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "NZD",
  "CAD",
  "CHF",
  "HKD",
  "ZAR",
  "SEK",
] as const;

interface RawJsonResponse {
  rawText: string;
  json: JsonObject;
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RequestContext {
  area: "db" | "da" | "ea" | "ja";
  revision: string;
  pageUrl: string;
  screenId: string;
  eventId: string;
  providerKey?: string;
}

export interface SonyBankCollection {
  artifacts: RawArtifact[];
  transactionCount: number;
}

interface HistoryCollection {
  pages: RawJsonResponse[];
  transactionCount: number;
}

interface WalletMonth {
  value: string;
  label: string;
  submitName: string;
}

export class CookieBag {
  readonly #values = new Map<string, string>();

  absorb(headers: Headers): void {
    const extended = headers as Headers & { getSetCookie?: () => string[] };
    const sources = (extended.getSetCookie?.() ?? [headers.get("set-cookie")])
      .flatMap((value) => splitSetCookie(value));
    for (const source of sources) {
      const pair = source.split(";", 1)[0]?.trim();
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) continue;
      this.#values.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header(): string {
    return [...this.#values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  names(): string[] {
    return [...this.#values.keys()].sort();
  }
}

export function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/gu);
}

export function parseCredential(value: string): SonyBankCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SONY_BANK_CREDENTIAL_JSON must be valid JSON");
  }
  if (!isObject(parsed)) {
    throw new Error("SONY_BANK_CREDENTIAL_JSON must be an object");
  }
  const branchNum = parsed.branchNum;
  const accountNum = parsed.accountNum;
  const loginPwd = parsed.loginPwd;
  if (
    typeof branchNum !== "string" ||
    !/^\d{3}$/u.test(branchNum) ||
    typeof accountNum !== "string" ||
    !/^\d{7}$/u.test(accountNum) ||
    typeof loginPwd !== "string" ||
    loginPwd.length === 0
  ) {
    throw new Error("Sony Bank credential fields are invalid");
  }
  return { branchNum, accountNum, loginPwd };
}

export async function collectSonyBank(options: {
  credential: SonyBankCredential;
  from: string;
  to: string;
  fetcher?: Fetcher;
}): Promise<SonyBankCollection> {
  const fetcher = options.fetcher ?? fetch;
  const client = new SonyBankClient(fetcher, options.credential);
  await client.login();

  const gross = await client.requestJson(
    GROSS_BALANCE_PATH,
    { branchNum: options.credential.branchNum, accountNum: options.credential.accountNum },
    {
      area: "da",
      revision: await client.revision("da"),
      pageUrl: DASHBOARD_PAGE,
      screenId: "DAYA010AM1f",
      eventId: "DAYA010AM1fE13",
    },
  );

  const history = await client.history("JPY", options.from, options.to);
  const csv = await client.historyCsv("JPY", options.from, options.to);
  const foreign = [];
  let foreignTransactionCount = 0;
  for (const currency of FOREIGN_CURRENCY_CODES) {
    const currencyHistory = await client.history(currency, options.from, options.to);
    const currencyCsv = currencyHistory.transactionCount > 0
      ? await client.historyCsv(currency, options.from, options.to)
      : null;
    foreignTransactionCount += currencyHistory.transactionCount;
    foreign.push({ currency, history: currencyHistory, csv: currencyCsv });
  }
  const wallet = await client.walletHistory();
  const artifacts: RawArtifact[] = [
    {
      dataset: "gross-balance",
      filename: "gross-balance.json",
      mediaType: "application/json",
      body: gross.rawText,
    },
    ...history.pages.map((page, index) => ({
      dataset: `yen-history-page-${String(index + 1).padStart(4, "0")}`,
      filename: `yen-history-page-${String(index + 1).padStart(4, "0")}.json`,
      mediaType: "application/json",
      body: page.rawText,
    })),
    {
      dataset: "yen-history-csv",
      filename: "yen-history.csv",
      mediaType: csv.mediaType,
      body: csv.body,
    },
    ...foreign.flatMap(({ currency, history: currencyHistory, csv: currencyCsv }) => [
      ...currencyHistory.pages.map((page, index) => ({
        dataset: `foreign-history-${currency.toLowerCase()}-page-${String(index + 1).padStart(4, "0")}`,
        filename: `foreign-history-${currency.toLowerCase()}-page-${String(index + 1).padStart(4, "0")}.json`,
        mediaType: "application/json",
        body: page.rawText,
      })),
      ...(currencyCsv ? [{
        dataset: `foreign-history-${currency.toLowerCase()}-csv`,
        filename: `foreign-history-${currency.toLowerCase()}.csv`,
        mediaType: currencyCsv.mediaType,
        body: currencyCsv.body,
      }] : []),
    ]),
    ...wallet.months.map((month) => ({
      dataset: `wallet-history-${month.value.slice(0, 6)}`,
      filename: `wallet-history-${month.value.slice(0, 4)}-${month.value.slice(4, 6)}.html`,
      mediaType: "text/html; charset=UTF-8",
      body: month.html,
    })),
    {
      dataset: "collection-summary",
      filename: "collection-summary.json",
      mediaType: "application/json",
      body: JSON.stringify({
        schemaVersion: "sony-bank-collection-summary-v2",
        window: { from: options.from, to: options.to },
        transactionCount: history.transactionCount,
        pageCount: history.pages.length,
        foreignCurrencyCount: FOREIGN_CURRENCY_CODES.length,
        foreignTransactionCount,
        foreignPageCount: foreign.reduce(
          (count, entry) => count + entry.history.pages.length,
          0,
        ),
        walletMonthCount: wallet.months.length,
        cookieNames: client.cookieNames(),
      }),
    },
  ];
  return { artifacts, transactionCount: history.transactionCount };
}

class SonyBankClient {
  readonly #cookies = new CookieBag();
  #csrf = "";
  readonly #revisions = new Map<string, string>();
  private readonly fetcher: Fetcher;

  constructor(
    fetcher: Fetcher,
    private readonly credential: SonyBankCredential,
  ) {
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async login(): Promise<void> {
    const page = await this.fetcher(LOGIN_PAGE, { redirect: "follow" });
    if (!page.ok) {
      throw new SonyBankError("login-page", page.status);
    }
    this.#cookies.absorb(page.headers);

    const dbRevision = await this.revision("db");
    const csrfResponse = await this.requestJson(
      CSRF_PATH,
      {},
      {
        area: "db",
        revision: dbRevision,
        pageUrl: LOGIN_PAGE,
        screenId: "DBCA0100I1f",
        eventId: "DBCA5700C1fE99",
      },
      false,
    );
    assertNoErrors("csrf", csrfResponse.json);
    if (!this.#csrf || !this.#cookies.names().includes("FSID")) {
      throw new Error("Sony Bank did not issue CSRF and FSID");
    }

    const login = await this.requestJson(
      LOGIN_PATH,
      this.credential,
      {
        area: "db",
        revision: dbRevision,
        pageUrl: LOGIN_PAGE,
        screenId: "DBCA0100I1f",
        eventId: "DBCA0100I1fE15",
        providerKey: "CustomAuth",
      },
    );
    assertNoErrors("login", login.json);
    if (!Array.isArray(login.json.accountInfo) || login.json.accountInfo.length === 0) {
      throw new Error("Sony Bank login returned no account information");
    }
  }

  async revision(area: "db" | "da" | "ea" | "ja"): Promise<string> {
    const cached = this.#revisions.get(area);
    if (cached) return cached;
    const response = await this.fetcher(
      `${ORIGIN}/pages/config/revisions/${area}/revision.json`,
      { headers: { accept: "application/json" } },
    );
    if (!response.ok) {
      throw new SonyBankError(`revision-${area}`, response.status);
    }
    const value = (await response.text()).trim();
    if (!/^\d+$/u.test(value)) {
      throw new Error(`Sony Bank ${area} revision is invalid`);
    }
    const revision = `revision-${value}`;
    this.#revisions.set(area, revision);
    return revision;
  }

  async requestJson(
    path: string,
    body: JsonObject | SonyBankCredential,
    context: RequestContext,
    includeCsrf = true,
  ): Promise<RawJsonResponse> {
    const headers = this.headers(context, includeCsrf);
    const response = await this.fetcher(`${ORIGIN}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
    });
    this.#cookies.absorb(response.headers);
    const nextCsrf = response.headers.get("bff-csrf");
    if (nextCsrf) this.#csrf = nextCsrf;
    const rawText = await response.text();
    if (!response.ok) {
      throw new SonyBankError(context.eventId, response.status, errorCodes(rawText));
    }
    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      throw new Error(`Sony Bank ${context.eventId} returned non-JSON`);
    }
    if (!isObject(json)) {
      throw new Error(`Sony Bank ${context.eventId} returned invalid JSON`);
    }
    assertNoErrors(context.eventId, json);
    return { rawText, json };
  }

  async history(
    currency: string,
    from: string,
    to: string,
  ): Promise<HistoryCollection> {
    const revision = await this.revision("ea");
    const pages: RawJsonResponse[] = [];
    let acquisitionStart = 1;
    let declaredTotal: number | null = null;

    for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
      const first = pageIndex === 0;
      const page = await this.requestJson(
        first ? HISTORY_PATH : HISTORY_PAGER_PATH,
        {
          branchNum: this.credential.branchNum,
          accountNum: this.credential.accountNum,
          currencyCdInq: first ? currency : "",
          ...(first ? {} : { currencyCd: currency }),
          inquiryStrtdtCat: from,
          inquiryEnddtCat: to,
          maximumAcqCnt: PAGE_SIZE,
          acquisitionStrtCnt: acquisitionStart,
          sortSelect: "00001",
          detailDispSg: "1",
        },
        {
          area: "ea",
          revision,
          pageUrl: HISTORY_PAGE,
          screenId: "EABA0600S1f",
          eventId: first ? "EABA0600S1fE10" : "EABA0600S1fE11",
        },
      );
      pages.push(page);
      const pageInfo = validateHistoryPage(page.json, pageIndex, declaredTotal);
      declaredTotal = pageInfo.total;
      if (pageInfo.terminal) {
        return {
          pages,
          transactionCount: declaredTotal,
        };
      }
      acquisitionStart += PAGE_SIZE;
    }
    throw new Error("Sony Bank history exceeded the bounded page limit");
  }

  async historyCsv(
    currency: string,
    from: string,
    to: string,
  ): Promise<{ body: ArrayBuffer; mediaType: string }> {
    const context: RequestContext = {
      area: "ea",
      revision: await this.revision("ea"),
      pageUrl: HISTORY_PAGE,
      screenId: "EABA0600S1f",
      eventId: "EABA0600S1fE12",
    };
    const response = await this.fetcher(`${ORIGIN}${HISTORY_CSV_PATH}`, {
      method: "POST",
      headers: this.headers(context, true),
      body: JSON.stringify({
        branchNum: this.credential.branchNum,
        accountNum: this.credential.accountNum,
        currencyCd: currency,
        inquiryStrtdtCat: from,
        inquiryEnddtCat: to,
        sortSelect: "00001",
        detailDispSg: "1",
      }),
      redirect: "manual",
    });
    this.#cookies.absorb(response.headers);
    const nextCsrf = response.headers.get("bff-csrf");
    if (nextCsrf) this.#csrf = nextCsrf;
    if (!response.ok) {
      const body = await response.text();
      throw new SonyBankError(
        `${context.eventId}:${currency}`,
        response.status,
        errorCodes(body),
      );
    }
    return {
      body: await response.arrayBuffer(),
      mediaType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async walletHistory(): Promise<{
    months: Array<WalletMonth & { html: string }>;
  }> {
    const sso = await this.requestJson(
      WALLET_SSO_PATH,
      {
        branchNum: this.credential.branchNum,
        accountNum: this.credential.accountNum,
        debitSSOTransactionType: "10",
        serviceId: "DAYA070Ao",
        buttonId: "021",
      },
      {
        area: "ja",
        revision: await this.revision("ja"),
        pageUrl: WALLET_CONFIRM_PAGE,
        screenId: "JADA160AC5f",
        eventId: "JADA160AC5fE01",
      },
    );
    const messageCheck = sso.json.debitSsoBinDat;
    if (typeof messageCheck !== "string" || messageCheck.length === 0) {
      throw new Error("Sony Bank WALLET SSO returned no message");
    }

    const gatewayResponse = await this.fetcher(WALLET_GATEWAY_URL, {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ MessageCheck: messageCheck }),
      redirect: "manual",
    });
    if (!gatewayResponse.ok) {
      throw new SonyBankError("wallet-gateway", gatewayResponse.status);
    }
    const gatewayHtml = await responseText(gatewayResponse);
    const r01 = hiddenInputValue(gatewayHtml, "r01");
    const cc = hiddenInputValue(gatewayHtml, "cc");
    const action = formAction(gatewayHtml, "tisdcform");
    if (!r01 || !cc || !action) {
      throw new Error("Sony Bank WALLET gateway response was invalid");
    }

    const walletCookies = new CookieBag();
    let page = await this.fetcher(new URL(action, WALLET_CARD_ORIGIN), {
      method: "POST",
      headers: {
        accept: "text/html",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ r01, cc }),
      redirect: "manual",
    });
    walletCookies.absorb(page.headers);
    let html = await responseText(page);
    assertWalletPage(page.status, html);
    let walletPageUrl = page.url || new URL(action, WALLET_CARD_ORIGIN).href;

    const months = walletMonths(html);
    if (months.length === 0 || months.length > 15) {
      throw new Error("Sony Bank WALLET returned an invalid month list");
    }
    const artifacts: Array<WalletMonth & { html: string }> = [];
    for (const month of months) {
      if (artifacts.length > 0) {
        await delay(WALLET_MONTH_INTERVAL_MS);
        const state = walletMonthRequest(html, month);
        const headers = new Headers({
          accept: "text/html",
          "content-type": "application/x-www-form-urlencoded",
          origin: WALLET_CARD_ORIGIN,
          referer: walletPageUrl,
        });
        const cookie = walletCookies.header();
        if (cookie) headers.set("cookie", cookie);
        page = await this.fetcher(new URL(state.action, WALLET_CARD_ORIGIN), {
          method: "POST",
          headers,
          body: state.body,
          redirect: "manual",
        });
        walletCookies.absorb(page.headers);
        if (!page.ok) {
          throw new Error(
            `Sony Bank WALLET month ${month.value} failed with HTTP ${page.status}; cookieNames=${walletCookies.names().join(",")}`,
          );
        }
        html = await responseText(page);
        walletPageUrl = page.url || new URL(state.action, WALLET_CARD_ORIGIN).href;
        assertWalletPage(page.status, html);
      }
      if (selectedWalletMonth(html) !== month.value) {
        throw new Error("Sony Bank WALLET selected month mismatch");
      }
      artifacts.push({ ...month, html: sanitizeWalletHtml(html) });
    }
    return { months: artifacts };
  }

  cookieNames(): string[] {
    return this.#cookies.names();
  }

  private headers(context: RequestContext, includeCsrf: boolean): Headers {
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
      "FBaaS-Message-Locale": "ja",
      "FBaaS-Request-Biz-Hd-Common": JSON.stringify({
        screenId: context.screenId,
        eventId: context.eventId,
      }),
      "FBaaS-Revision": context.revision,
      "FBaaS-SS": context.area,
      "FBaaS-URI": context.pageUrl,
    });
    const cookie = this.#cookies.header();
    if (cookie) headers.set("cookie", cookie);
    if (includeCsrf) {
      if (!this.#csrf) throw new Error("Sony Bank CSRF is missing");
      headers.set("BFF-CSRF", this.#csrf);
    }
    if (context.providerKey) {
      headers.set("FBaaS-Provider-Key", context.providerKey);
    }
    return headers;
  }
}

export function validateHistoryPage(
  json: JsonObject,
  pageIndex: number,
  expectedTotal: number | null,
): { rowCount: number; total: number; terminal: boolean } {
  const rowCount = Array.isArray(json.transactionHistInfo)
    ? json.transactionHistInfo.length
    : null;
  if (rowCount === null || rowCount > PAGE_SIZE || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new Error("sony_bank_history_pagination_invalid");
  }
  const total = countValue(json.countCnt);
  if (total === null) throw new Error("sony_bank_history_pagination_invalid");
  if (expectedTotal !== null && total !== expectedTotal) {
    throw new Error("sony_bank_history_pagination_total_changed");
  }
  const expectedRows = Math.max(0, Math.min(PAGE_SIZE, total - (pageIndex * PAGE_SIZE)));
  if (rowCount !== expectedRows) {
    throw new Error("sony_bank_history_pagination_length_mismatch");
  }
  return {
    rowCount,
    total,
    terminal: (pageIndex + 1) * PAGE_SIZE >= total,
  };
}

class SonyBankError extends Error {
  constructor(operation: string, status: number, codes: string[] = []) {
    super(
      `Sony Bank ${operation} failed with HTTP ${status}` +
        (codes.length > 0 ? ` (${codes.join(",")})` : ""),
    );
    this.name = "SonyBankError";
  }
}

function assertNoErrors(operation: string, value: JsonObject): void {
  if (!Array.isArray(value.errors) || value.errors.length === 0) return;
  const codes = value.errors
    .map((error) => (isObject(error) && typeof error.code === "string" ? error.code : null))
    .filter((code): code is string => code !== null);
  throw new Error(
    `Sony Bank ${operation} returned business errors` +
      (codes.length > 0 ? ` (${codes.join(",")})` : ""),
  );
}

function errorCodes(rawText: string): string[] {
  try {
    const value: unknown = JSON.parse(rawText);
    if (!isObject(value) || !Array.isArray(value.errors)) return [];
    return value.errors
      .map((error) => (isObject(error) && typeof error.code === "string" ? error.code : null))
      .filter((code): code is string => code !== null)
      .slice(0, 5);
  } catch {
    return [];
  }
}

function countValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function sanitizeWalletHtml(html: string): string {
  return html
    .replace(/;jsessionid=[^?"'<>\s]+/giu, "")
    .replace(/<input\b[^>]*>/giu, (tag) => {
      const type = attributeValue(tag, "type").toLowerCase();
      const name = attributeValue(tag, "name");
      if (type !== "hidden" && name !== "cc") return tag;
      return tag.replace(/\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/iu, ' value=""');
    });
}

export function walletMonths(html: string): WalletMonth[] {
  const form = formBlock(html, "nablarch_form3");
  const select = form.match(
    /<select\b[^>]*\bname\s*=\s*["']W131301\.referenceDate["'][^>]*>([\s\S]*?)<\/select>/iu,
  )?.[1];
  if (!select) return [];
  return [...select.matchAll(/<option\b[^>]*\bvalue\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/giu)]
    .map((match, index) => ({
      value: decodeHtml(match[1] ?? ""),
      label: stripTags(decodeHtml(match[2] ?? "")),
      submitName: `nablarch_form3_${index + 1}`,
    }))
    .filter((month) => /^\d{8}$/u.test(month.value));
}

export function selectedWalletMonth(html: string): string | null {
  const form = formBlock(html, "nablarch_form3");
  const select = form.match(
    /<select\b[^>]*\bname\s*=\s*["']W131301\.referenceDate["'][^>]*>([\s\S]*?)<\/select>/iu,
  )?.[1];
  if (!select) return null;
  const options = [...select.matchAll(/<option\b([^>]*)\bvalue\s*=\s*["'](\d{8})["']([^>]*)>/giu)]
    .map((match) => ({
      value: match[2]!,
      selected: /(?:^|\s)selected(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/iu
        .test(`${match[1] ?? ""} ${match[3] ?? ""}`),
    }));
  const selected = options.filter((option) => option.selected);
  if (selected.length > 1) return null;
  return (selected[0] ?? options[0])?.value ?? null;
}

function walletMonthRequest(
  html: string,
  month: WalletMonth,
): { action: string; body: URLSearchParams } {
  const action = html.match(
    new RegExp(
      `"${escapeRegExp(month.submitName)}"\\s*:\\s*\\{\\s*"action"\\s*:\\s*"([^"]+)"`,
      "iu",
    ),
  )?.[1];
  if (!action) throw new Error("Sony Bank WALLET month action was missing");
  const form = formBlock(html, "nablarch_form3");
  const body = new URLSearchParams();
  for (const match of form.matchAll(/<input\b[^>]*>/giu)) {
    const name = attributeValue(match[0], "name");
    if (!name) continue;
    body.append(name, decodeHtml(attributeValue(match[0], "value")));
  }
  body.set("W131301.referenceDate", month.value);
  body.set("nablarch_submit", month.submitName);
  return { action: decodeHtml(action), body };
}

function hiddenInputValue(html: string, name: string): string {
  for (const match of html.matchAll(/<input\b[^>]*>/giu)) {
    if (attributeValue(match[0], "name") === name) {
      return decodeHtml(attributeValue(match[0], "value"));
    }
  }
  return "";
}

function formAction(html: string, name: string): string {
  const form = html.match(
    new RegExp(`<form\\b[^>]*\\bname\\s*=\\s*["']${escapeRegExp(name)}["'][^>]*>`, "iu"),
  )?.[0];
  return form ? decodeHtml(attributeValue(form, "action")) : "";
}

function formBlock(html: string, name: string): string {
  return html.match(
    new RegExp(
      `<form\\b[^>]*\\bname\\s*=\\s*["']${escapeRegExp(name)}["'][^>]*>([\\s\\S]*?)<\\/form>`,
      "iu",
    ),
  )?.[1] ?? "";
}

function attributeValue(tag: string, name: string): string {
  return tag.match(
    new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"),
  )?.slice(1).find((value) => value !== undefined) ?? "";
}

function assertWalletPage(status: number, html: string): void {
  if (status < 200 || status >= 300) {
    throw new SonyBankError("wallet-statement", status);
  }
  if (!html.includes("W131301.referenceDate") || /<title>\s*(?:システムエラー|ページが見つかりません)\s*<\/title>/iu.test(html)) {
    throw new Error("Sony Bank WALLET statement page was invalid");
  }
}

async function responseText(response: Response): Promise<string> {
  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") ?? "";
  const decoder = /charset\s*=\s*(?:windows-31j|shift[_-]?jis)/iu.test(contentType)
    ? new TextDecoder("shift_jis")
    : new TextDecoder();
  return decoder.decode(bytes);
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&lt;": "<",
    "&gt;": ">",
  };
  return value.replace(/&(amp|quot|#39|lt|gt);/gu, (entity) => entities[entity] ?? entity);
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
