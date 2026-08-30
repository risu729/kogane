import type {
  JsonObject,
  RawArtifact,
  SonyBankCredential,
} from "./types";

const ORIGIN = "https://sonybank.jp";
const LOGIN_PAGE = `${ORIGIN}/pages/db/dbca0100/input/`;
const DASHBOARD_PAGE = `${ORIGIN}/pages/da/daya010a/`;
const HISTORY_PAGE = `${ORIGIN}/pages/ea/eaba0600/search/`;
const LOGIN_PATH = "/custom-web00/dbca/cust-web/to-customers/login";
const CSRF_PATH = "/custom-web00/dbca/csrf-token/get";
const GROSS_BALANCE_PATH = "/custom-web00/dcba/cust-web/gross-balance/acq";
const HISTORY_PATH =
  "/custom-web00/eaba/cust-web/ordinary-deposit-transaction-histories";
const HISTORY_PAGER_PATH =
  "/custom-web00/eaba/cust-web/ordinary-deposit-transaction-histories-pager";
const HISTORY_CSV_PATH =
  "/custom-web00/eaba/ordinary-deposit-transaction-histories/csv/load";
const PAGE_SIZE = 3;
const MAX_HISTORY_PAGES = 1_000;

interface RawJsonResponse {
  rawText: string;
  json: JsonObject;
}

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface RequestContext {
  area: "db" | "da" | "ea";
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

  const history = await client.history(options.from, options.to);
  const csv = await client.historyCsv(options.from, options.to);
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
    {
      dataset: "collection-summary",
      filename: "collection-summary.json",
      mediaType: "application/json",
      body: JSON.stringify({
        schemaVersion: "sony-bank-collection-summary-v1",
        window: { from: options.from, to: options.to },
        transactionCount: history.transactionCount,
        pageCount: history.pages.length,
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

  async revision(area: "db" | "da" | "ea"): Promise<string> {
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
    from: string,
    to: string,
  ): Promise<{ pages: RawJsonResponse[]; transactionCount: number }> {
    const revision = await this.revision("ea");
    const pages: RawJsonResponse[] = [];
    let acquisitionStart = 1;
    let observedTransactions = 0;
    let declaredTotal: number | null = null;

    for (let pageIndex = 0; pageIndex < MAX_HISTORY_PAGES; pageIndex += 1) {
      const first = pageIndex === 0;
      const page = await this.requestJson(
        first ? HISTORY_PATH : HISTORY_PAGER_PATH,
        {
          branchNum: this.credential.branchNum,
          accountNum: this.credential.accountNum,
          currencyCdInq: first ? "JPY" : "",
          ...(first ? {} : { currencyCd: "JPY" }),
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
      const rows = Array.isArray(page.json.transactionHistInfo)
        ? page.json.transactionHistInfo.length
        : 0;
      observedTransactions += rows;
      declaredTotal ??= countValue(page.json.countCnt);
      if (rows < PAGE_SIZE || (declaredTotal !== null && observedTransactions >= declaredTotal)) {
        return {
          pages,
          transactionCount: declaredTotal ?? observedTransactions,
        };
      }
      acquisitionStart += PAGE_SIZE;
    }
    throw new Error("Sony Bank history exceeded the bounded page limit");
  }

  async historyCsv(
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
        currencyCd: "JPY",
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
      throw new SonyBankError(context.eventId, response.status, errorCodes(body));
    }
    return {
      body: await response.arrayBuffer(),
      mediaType: response.headers.get("content-type") ?? "application/octet-stream",
    };
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

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
