import { createBitwardenAssertion } from "../packages/auth-bitwarden/src/fido2";
import type { BitwardenPasskey } from "../packages/auth-bitwarden/src/vault";
import { createPasskeySession, loginWithPasskey } from "../packages/provider-sbi-sec/src/session";
import type { PasskeyAssertionProvider, SbiSession } from "../packages/provider-sbi-sec/src/types";

interface BitwardenCliItem {
  id?: unknown;
  name?: unknown;
  login?: {
    uris?: unknown;
    fido2Credentials?: unknown;
  };
}

interface BitwardenCliUri {
  uri?: unknown;
}

type BitwardenCliPasskey = Record<string, unknown>;

interface TraceEntry {
  stage: string;
  method: string;
  status?: number;
  outcome: "response" | "blocked-before-mts" | "network-error";
}

const MTS_PROBE_ORIGIN = "https://sbi-mts-probe.invalid";

class MtsHandoffReached extends Error {
  constructor() {
    super("MTS handoff reached");
    this.name = "MtsHandoffReached";
  }
}

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const requiredString = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing ${label}`);
  return value;
};

const optionalString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const readBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
};

const readCounter = (value: unknown) => {
  const counter = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(counter) && counter >= 0 ? counter : 0;
};

const amountState = (amount: { value: number | null } | undefined) => {
  if (typeof amount?.value !== "number") return "missing";
  if (amount.value > 0) return "positive";
  if (amount.value < 0) return "negative";
  return "zero";
};

const numberState = (value: number | null | undefined) => {
  if (typeof value !== "number") return "missing";
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "zero";
};

const requiredDate = (value: string, label: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD`);
  return value;
};

const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

const addUtcDays = (value: string, days: number) => {
  const date = new Date(`${requiredDate(value, "date")}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
};

const splitInclusiveDateRange = (from: string, to: string, maximumDays: number) => {
  if (!Number.isSafeInteger(maximumDays) || maximumDays < 1) {
    throw new Error("maximumDays must be a positive integer");
  }
  if (from > to) throw new Error("date range start must not be after end");
  const windows: Array<{ from: string; to: string }> = [];
  for (let start = from; start <= to;) {
    const candidateEnd = addUtcDays(start, maximumDays - 1);
    const end = candidateEnd < to ? candidateEnd : to;
    windows.push({ from: start, to: end });
    start = addUtcDays(end, 1);
  }
  return windows;
};

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const arrayValue = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const foreignGraphql = async (
  session: SbiSession,
  endpoint: "bff" | "int",
  operationName: string,
  query: string,
  variables: Record<string, unknown>,
) => {
  const foreign = session.foreignStock;
  if (!foreign?.sessionId || !foreign.accountId || foreign.loginAuthenticated !== true) {
    throw new Error("foreign stock session is not authenticated");
  }
  const url =
    endpoint === "bff" ? foreign.endpoints.graphqlBffUrl : foreign.endpoints.graphqlIntUrl;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${foreign.sessionId}`,
      "account-id": foreign.accountId,
      "content-type": "application/json",
      ...(foreign.endpoints.userAgent ? { "user-agent": foreign.endpoints.userAgent } : {}),
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  const body = (await response.json()) as unknown;
  const root = objectValue(body);
  if (!response.ok || arrayValue(root?.errors).length > 0) {
    throw new Error(`foreign stock GraphQL ${operationName} failed`);
  }
  return objectValue(root?.data) ?? {};
};

const fetchUsHistorySearchDuration = async (session: SbiSession) => {
  const data = await foreignGraphql(
    session,
    "bff",
    "GetSearchingDuration",
    `query GetSearchingDuration($input: GetSearchingDurationRequest!) {
      getSearchingDuration(input: $input) {
        pastYears searchDateFrom searchDateTo
      }
    }`,
    {
      input: {
        countryCode: "US",
        searchFunction: "EXECUTION_HISTORY",
        searchDateType: "TRADE_DATE_BASE",
        dateType: "MONTH",
        quantity: 1,
      },
    },
  );
  const duration = objectValue(data.getSearchingDuration);
  if (!duration) throw new Error("GetSearchingDuration returned no duration");
  return {
    pastYears: typeof duration.pastYears === "number" ? duration.pastYears : undefined,
    searchDateFrom: optionalString(duration.searchDateFrom),
    searchDateTo: optionalString(duration.searchDateTo),
  };
};

const readOnlyResult = async <T>(read: () => Promise<T>) => {
  try {
    return { ok: true as const, value: await read() };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    return {
      ok: false as const,
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorCode: code,
      errorMessage: error instanceof Error ? error.message : undefined,
    };
  }
};

const readPasskey = (item: BitwardenCliItem) => {
  const credentials = item.login?.fido2Credentials;
  if (!Array.isArray(credentials) || credentials.length !== 1) {
    throw new Error("expected exactly one Bitwarden passkey in the selected item");
  }
  const raw = credentials[0] as BitwardenCliPasskey;
  const passkey: BitwardenPasskey = {
    cipherId: requiredString(item.id, "cipher ID"),
    cipherName: requiredString(item.name, "cipher name"),
    credentialId: requiredString(raw.credentialId, "credential ID"),
    rpId: requiredString(raw.rpId, "RP ID"),
    rpName: optionalString(raw.rpName),
    userName: optionalString(raw.userName),
    userHandle: optionalString(raw.userHandle),
    userDisplay: optionalString(raw.userDisplayName ?? raw.userDisplay),
    counter: readCounter(raw.counter),
    discoverable: readBoolean(raw.discoverable, true),
    keyValue: requiredString(raw.keyValue, "private key"),
  };
  return passkey;
};

const hostnameMatchesRpId = (hostname: string, rpId: string) =>
  hostname === rpId || hostname.endsWith(`.${rpId}`);

const deriveAuthEntryUrl = (item: BitwardenCliItem, rpId: string) => {
  const override = process.env.SBI_AUTH_BASE_URL;
  if (override) return new URL(override).toString();

  const uris = item.login?.uris;
  if (!Array.isArray(uris)) throw new Error("Bitwarden item has no login URI");
  const matchingUri = uris
    .map((entry) => (entry as BitwardenCliUri).uri)
    .filter((value): value is string => typeof value === "string")
    .map((value) => new URL(value))
    .find((url) => url.protocol === "https:" && hostnameMatchesRpId(url.hostname, rpId));
  if (!matchingUri) throw new Error("no HTTPS Bitwarden URI matches the passkey RP ID");

  const path = process.env.SBI_AUTH_ENTRY_PATH ?? "/login/entry";
  return new URL(path, matchingUri.origin).toString();
};

const classifyStage = (url: URL) => {
  if (url.hostname === "sbi-mts-probe.invalid") return "mts-handoff";
  if (url.pathname === "/mtsmobile/ssologingate") return "mts-login";
  if (url.pathname === "/mtsmobile/commgate") return "mts-read";
  if (url.pathname.includes("authentication:ssoLogin")) return "foreign-login";
  if (url.pathname.includes("/graphql/")) return "foreign-graphql-read";
  if (url.pathname.includes("/rest/")) return "foreign-rest-read";
  if (url.pathname.includes("/account/api/assets/")) return "main-assets-read";
  if (url.pathname.includes("/banking/api/yen/")) return "main-yen-history-read";
  if (url.pathname.includes("/ETGate/")) return "main-etgate";
  if (url.pathname === "/api/fido2/auth/challenge") return "challenge";
  if (url.pathname === "/fido2/auth") return "assertion";
  if (url.pathname === "/sso/channel") return "callback";
  return "entry";
};

const verifyMtsHandoff = (init?: RequestInit) => {
  const body = init?.body;
  if (!(body instanceof URLSearchParams)) throw new Error("unexpected MTS handoff body");
  if (body.get("KIND") !== "L" || !body.get("TOKEN")) {
    throw new Error("MTS handoff did not contain the decrypted access token");
  }
};

const main = async () => {
  const rawItem = JSON.parse(await readStdin()) as BitwardenCliItem;
  const passkey = readPasskey(rawItem);
  const authBaseUrl = deriveAuthEntryUrl(rawItem, passkey.rpId);
  const origin = new URL(authBaseUrl).origin;
  const provider: PasskeyAssertionProvider = {
    rpId: passkey.rpId,
    createAssertion: async (request) =>
      createBitwardenAssertion(passkey, request, {
        origin,
        userVerification: true,
        counterBump: false,
      }),
  };

  const trace: TraceEntry[] = [];
  const liveMtsBaseUrl = process.env.SBI_MTS_BASE_URL;
  const liveForeignStockBaseUrl = process.env.SBI_FOREIGN_STOCK_BASE_URL;
  const liveMainSiteBaseUrl = process.env.SBI_MAIN_SITE_BASE_URL;
  for (const [label, value] of [
    ["SBI_MTS_BASE_URL", liveMtsBaseUrl],
    ["SBI_FOREIGN_STOCK_BASE_URL", liveForeignStockBaseUrl],
    ["SBI_MAIN_SITE_BASE_URL", liveMainSiteBaseUrl],
  ] as const) {
    if (value && new URL(value).protocol !== "https:") {
      throw new Error(`${label} must use HTTPS`);
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const stage = classifyStage(url);
    if (stage === "mts-handoff" && !liveMtsBaseUrl) {
      verifyMtsHandoff(init);
      trace.push({ stage, method, outcome: "blocked-before-mts" });
      throw new MtsHandoffReached();
    }
    try {
      const response = await originalFetch(input, init);
      trace.push({
        stage,
        method,
        status: response.status,
        outcome: "response",
      });
      return response;
    } catch (error) {
      trace.push({ stage, method, outcome: "network-error" });
      throw error;
    }
  };

  try {
    if (liveMtsBaseUrl) {
      const client = await loginWithPasskey({
        authBaseUrl,
        mtsBaseUrl: liveMtsBaseUrl,
        foreignStockBaseUrl: liveForeignStockBaseUrl,
        mainSiteBaseUrl: liveMainSiteBaseUrl,
        passkeyProvider: provider,
      });
      const profile = await client.account.profile();
      const cashResult = await readOnlyResult(() => client.account.positions.cash());
      const powerResult = await readOnlyResult(() => client.account.power.buyingPower());
      const marginResult = await readOnlyResult(() => client.account.positions.margin());
      const domesticExecutionsResult = await readOnlyResult(() =>
        client.orders.inquiry.executionsToday(),
      );
      const domesticOpenOrdersResult = await readOnlyResult(() => client.orders.inquiry.open());
      const domesticHistoryFrom = requiredDate(
        process.env.SBI_DOMESTIC_HISTORY_FROM ?? "2024-01-01",
        "SBI_DOMESTIC_HISTORY_FROM",
      );
      const domesticHistoryTo = requiredDate(
        process.env.SBI_DOMESTIC_HISTORY_TO ?? new Date().toISOString().slice(0, 10),
        "SBI_DOMESTIC_HISTORY_TO",
      );
      const domesticTradeHistoryResult = await readOnlyResult(() =>
        client.orders.inquiry.tradeRecords({
          market: "XTKS",
          from: domesticHistoryFrom,
          to: domesticHistoryTo,
          limit: 200,
        }),
      );
      const verifyDomesticHistoryWindows =
        process.env.SBI_VERIFY_DOMESTIC_HISTORY_WINDOWS === "true";
      const domesticHistoryWindows = verifyDomesticHistoryWindows
        ? splitInclusiveDateRange(domesticHistoryFrom, domesticHistoryTo, 90)
        : [];
      const domesticHistoryWindowResults = [] as Array<{
        window: { from: string; to: string };
        result: Awaited<
          ReturnType<
            typeof readOnlyResult<Awaited<ReturnType<typeof client.orders.inquiry.tradeRecords>>>
          >
        >;
      }>;
      for (const window of domesticHistoryWindows) {
        domesticHistoryWindowResults.push({
          window,
          result: await readOnlyResult(() =>
            client.orders.inquiry.tradeRecords({
              market: "XTKS",
              ...window,
              limit: 200,
            }),
          ),
        });
      }

      const usMarkets = ["XNAS", "XNYS", "ARCX"] as const;
      const usPositionResults = liveForeignStockBaseUrl
        ? await Promise.all(
            usMarkets.map(async (market) => ({
              market,
              result: await readOnlyResult(() => client.account.positions.cash({ market })),
            })),
          )
        : [];
      const exportedSession = liveForeignStockBaseUrl ? await client.session.export() : undefined;
      const usHistorySearchDurationResult = exportedSession
        ? await readOnlyResult(() => fetchUsHistorySearchDuration(exportedSession))
        : undefined;
      const foreignCashBalanceResult = exportedSession
        ? await readOnlyResult(() => client.account.positions.foreignCash({ days: 5 }))
        : undefined;
      const usHistoryFrom = requiredDate(
        process.env.SBI_US_HISTORY_FROM ?? "2021-01-01",
        "SBI_US_HISTORY_FROM",
      );
      const usHistoryTo = requiredDate(
        process.env.SBI_US_HISTORY_TO ?? new Date().toISOString().slice(0, 10),
        "SBI_US_HISTORY_TO",
      );
      const usTradeHistoryResult = liveForeignStockBaseUrl
        ? await readOnlyResult(() =>
            client.orders.inquiry.tradeRecords({
              from: usHistoryFrom,
              to: usHistoryTo,
              limit: 999,
            }),
          )
        : undefined;
      const verifyUsHistoryWindows = process.env.SBI_VERIFY_US_HISTORY_WINDOWS === "true";
      const defaultScanFrom = (() => {
        const pastYears = usHistorySearchDurationResult?.ok
          ? usHistorySearchDurationResult.value.pastYears
          : undefined;
        const toYear = Number(usHistoryTo.slice(0, 4));
        return pastYears && Number.isSafeInteger(pastYears)
          ? `${toYear - pastYears}-01-01`
          : usHistoryFrom;
      })();
      const usHistoryScanFrom = requiredDate(
        process.env.SBI_US_HISTORY_SCAN_FROM ?? defaultScanFrom,
        "SBI_US_HISTORY_SCAN_FROM",
      );
      const usHistoryWindows =
        verifyUsHistoryWindows && liveForeignStockBaseUrl
          ? splitInclusiveDateRange(usHistoryScanFrom, usHistoryTo, 90)
          : [];
      const usHistoryWindowResults = [] as Array<{
        window: { from: string; to: string };
        result: Awaited<
          ReturnType<
            typeof readOnlyResult<Awaited<ReturnType<typeof client.orders.inquiry.tradeRecords>>>
          >
        >;
      }>;
      for (const window of usHistoryWindows) {
        usHistoryWindowResults.push({
          window,
          result: await readOnlyResult(() =>
            client.orders.inquiry.tradeRecords({ ...window, limit: 999 }),
          ),
        });
      }

      const verifyMarketData = process.env.SBI_VERIFY_MARKET_DATA === "true";
      const domesticSample = cashResult.ok ? cashResult.value.positions[0] : undefined;
      const domesticQuoteResult =
        verifyMarketData && domesticSample?.issue.market
          ? await readOnlyResult(() =>
              client.market.issue.board({
                issueCode: domesticSample.issue.code,
                market: domesticSample.issue.market,
              }),
            )
          : undefined;
      const domesticChartResult =
        verifyMarketData && domesticSample?.issue.market
          ? await readOnlyResult(() =>
              client.market.issue.chart({
                issueCode: domesticSample.issue.code,
                market: domesticSample.issue.market,
                period: "day",
                count: 5,
              }),
            )
          : undefined;
      const usSample = usPositionResults
        .flatMap(({ result }) => (result.ok ? result.value.positions : []))
        .at(0);
      const usQuoteResults = verifyMarketData
        ? await Promise.all(
            usPositionResults
              .flatMap(({ result }) => (result.ok ? result.value.positions : []))
              .filter((position) => Boolean(position.issue.market))
              .map((position) =>
                readOnlyResult(() =>
                  client.market.issue.board({
                    issueCode: position.issue.code,
                    market: position.issue.market!,
                  }),
                ),
              ),
          )
        : [];
      const usChartResult =
        verifyMarketData && usSample?.issue.market
          ? await readOnlyResult(() =>
              client.market.issue.chart({
                issueCode: usSample.issue.code,
                market: usSample.issue.market,
                period: "day",
                count: 5,
              }),
            )
          : undefined;

      const assetsResult = liveMainSiteBaseUrl
        ? await readOnlyResult(() => client.account.assets.current())
        : undefined;
      const yenHistoryResult = liveMainSiteBaseUrl
        ? await readOnlyResult(() => client.banking.detailHistory())
        : undefined;
      const exchangeRateResult =
        verifyMarketData && liveMainSiteBaseUrl
          ? await readOnlyResult(() =>
              client.orders.exchange.rate({ currencyCode: "USD", side: "buy" }),
            )
          : undefined;
      const methodErrors = [
        cashResult.ok ? cashResult.value.error : undefined,
        powerResult.ok ? powerResult.value.error : undefined,
        marginResult.ok ? marginResult.value.error : undefined,
        domesticExecutionsResult.ok ? domesticExecutionsResult.value.error : undefined,
        domesticOpenOrdersResult.ok ? domesticOpenOrdersResult.value.error : undefined,
        domesticTradeHistoryResult.ok ? domesticTradeHistoryResult.value.error : undefined,
        ...usPositionResults.map(({ result }) => (result.ok ? result.value.error : undefined)),
        usTradeHistoryResult?.ok ? usTradeHistoryResult.value.error : undefined,
      ].filter((error) => error?.code && error.code !== "000000");
      const hasMethodError = methodErrors.length > 0;
      const usPositionCount = usPositionResults.reduce(
        (total, { result }) => total + (result.ok ? result.value.positions.length : 0),
        0,
      );
      const usTradeDates = usTradeHistoryResult?.ok
        ? usTradeHistoryResult.value.records
            .map((record) => record.tradeDate)
            .filter((date): date is string => Boolean(date))
            .sort()
        : [];
      const domesticHistoryWindowRecords = domesticHistoryWindowResults.flatMap(({ result }) =>
        result.ok ? result.value.records : [],
      );
      const domesticHistoryWindowUniqueRecords = new Map(
        domesticHistoryWindowRecords.map((record) => [record.id, record]),
      );
      const domesticHistoryWindowDates = [...domesticHistoryWindowUniqueRecords.values()]
        .map((record) => record.tradeDate)
        .filter((date): date is string => Boolean(date))
        .sort();
      const usHistoryWindowRecords = usHistoryWindowResults.flatMap(({ result }) =>
        result.ok ? result.value.records : [],
      );
      const usHistoryWindowUniqueRecords = new Map(
        usHistoryWindowRecords.map((record) => [record.id, record]),
      );
      const usHistoryWindowDates = [...usHistoryWindowUniqueRecords.values()]
        .map((record) => record.tradeDate)
        .filter((date): date is string => Boolean(date))
        .sort();
      const foreignCashBalanceDates = foreignCashBalanceResult?.ok
        ? foreignCashBalanceResult.value.balances
            .map((balance) => optionalString(balance.businessDate))
            .filter((date): date is string => Boolean(date))
            .sort()
        : [];
      const yenHistoryDates = yenHistoryResult?.ok
        ? yenHistoryResult.value.map((transaction) => transaction.occurredAt).sort()
        : [];
      const yenDividendTransactions = yenHistoryResult?.ok
        ? yenHistoryResult.value.filter((transaction) =>
            /配当|分配金/.test(transaction.description ?? ""),
          )
        : [];
      const domesticIssueIdentifiers = cashResult.ok
        ? cashResult.value.positions.flatMap((position) =>
            [position.issue.code, position.issue.name].filter((value): value is string =>
              Boolean(value),
            ),
          )
        : [];
      process.stdout.write(
        `${JSON.stringify(
          {
            status: hasMethodError ? "mts-read-returned-error" : "passkey-and-mts-read-succeeded",
            readOperations: [
              "account.positions.cash",
              "account.positions.margin",
              "account.power.buyingPower",
              "orders.inquiry.executionsToday",
              "orders.inquiry.open",
              "orders.inquiry.tradeRecords (domestic)",
              ...(liveForeignStockBaseUrl
                ? [
                    "account.positions.cash (US)",
                    "orders.inquiry.tradeRecords (US)",
                    "foreign cash balance (USD)",
                    ...(verifyUsHistoryWindows ? ["US trade history 90-day window scan"] : []),
                  ]
                : []),
              ...(liveMainSiteBaseUrl ? ["account.assets.current", "banking.detailHistory"] : []),
            ],
            domesticCashReadSucceeded: cashResult.ok,
            domesticCashPositionCount: cashResult.ok
              ? cashResult.value.positions.length
              : undefined,
            domesticCashServerTotalCount: cashResult.ok ? cashResult.value.totalCount : undefined,
            domesticCashReadErrorType: cashResult.ok ? undefined : cashResult.errorType,
            domesticCashReadErrorCode: cashResult.ok ? undefined : cashResult.errorCode,
            domesticMarginReadSucceeded: marginResult.ok,
            domesticMarginPositionCount: marginResult.ok
              ? marginResult.value.positions.length
              : undefined,
            domesticMarginServerTotalCount: marginResult.ok
              ? marginResult.value.totalCount
              : undefined,
            domesticMarginReadErrorType: marginResult.ok ? undefined : marginResult.errorType,
            domesticMarginReadErrorCode: marginResult.ok ? undefined : marginResult.errorCode,
            hasMarginAccount: profile.hasMarginAccount,
            accountPowerReadSucceeded: powerResult.ok,
            accountPowerReadErrorType: powerResult.ok ? undefined : powerResult.errorType,
            accountPowerReadErrorCode: powerResult.ok ? undefined : powerResult.errorCode,
            cashBuyingPowerState: powerResult.ok
              ? amountState(powerResult.value.cashBuyingPower)
              : undefined,
            withdrawableYenState: powerResult.ok
              ? amountState(powerResult.value.withdrawableAmount)
              : undefined,
            sbiHybridDepositBalanceState: powerResult.ok
              ? amountState(powerResult.value.sbiHybridDepositBalance)
              : undefined,
            domesticExecutionsTodayReadSucceeded: domesticExecutionsResult.ok,
            domesticExecutionsTodayCount: domesticExecutionsResult.ok
              ? domesticExecutionsResult.value.orders.length
              : undefined,
            domesticExecutionsTodayErrorType: domesticExecutionsResult.ok
              ? undefined
              : domesticExecutionsResult.errorType,
            domesticExecutionsTodayErrorCode: domesticExecutionsResult.ok
              ? undefined
              : domesticExecutionsResult.errorCode,
            domesticOpenOrdersReadSucceeded: domesticOpenOrdersResult.ok,
            domesticOpenOrdersCount: domesticOpenOrdersResult.ok
              ? domesticOpenOrdersResult.value.orders.length
              : undefined,
            domesticOpenOrdersErrorType: domesticOpenOrdersResult.ok
              ? undefined
              : domesticOpenOrdersResult.errorType,
            domesticOpenOrdersErrorCode: domesticOpenOrdersResult.ok
              ? undefined
              : domesticOpenOrdersResult.errorCode,
            domesticTradeHistoryReadSucceeded: domesticTradeHistoryResult.ok,
            domesticTradeHistoryCount: domesticTradeHistoryResult.ok
              ? domesticTradeHistoryResult.value.records.length
              : undefined,
            domesticTradeHistoryMethodErrorCode: domesticTradeHistoryResult.ok
              ? domesticTradeHistoryResult.value.error?.code
              : undefined,
            domesticTradeHistoryErrorType: domesticTradeHistoryResult.ok
              ? undefined
              : domesticTradeHistoryResult.errorType,
            domesticHistoryWindowScanEnabled: verifyDomesticHistoryWindows,
            domesticHistoryWindowCount: verifyDomesticHistoryWindows
              ? domesticHistoryWindows.length
              : undefined,
            domesticHistoryWindowSuccessCount: verifyDomesticHistoryWindows
              ? domesticHistoryWindowResults.filter(({ result }) => result.ok).length
              : undefined,
            domesticHistoryWindowFailureCount: verifyDomesticHistoryWindows
              ? domesticHistoryWindowResults.filter(({ result }) => !result.ok).length
              : undefined,
            domesticHistoryWindowFailures: verifyDomesticHistoryWindows
              ? domesticHistoryWindowResults
                  .filter(({ result }) => !result.ok)
                  .map(({ window, result }) => ({
                    ...window,
                    errorType: result.ok ? undefined : result.errorType,
                    errorCode: result.ok ? undefined : result.errorCode,
                  }))
              : undefined,
            domesticHistoryWindowHasMoreCount: verifyDomesticHistoryWindows
              ? domesticHistoryWindowResults.filter(
                  ({ result }) => result.ok && result.value.hasMore,
                ).length
              : undefined,
            domesticHistoryWindowRecordCount: verifyDomesticHistoryWindows
              ? domesticHistoryWindowRecords.length
              : undefined,
            domesticHistoryWindowUniqueRecordCount: verifyDomesticHistoryWindows
              ? domesticHistoryWindowUniqueRecords.size
              : undefined,
            domesticHistoryWindowDuplicateCount: verifyDomesticHistoryWindows
              ? domesticHistoryWindowRecords.length - domesticHistoryWindowUniqueRecords.size
              : undefined,
            domesticHistoryWindowOldestDate: verifyDomesticHistoryWindows
              ? domesticHistoryWindowDates.at(0)
              : undefined,
            domesticHistoryWindowNewestDate: verifyDomesticHistoryWindows
              ? domesticHistoryWindowDates.at(-1)
              : undefined,
            usPositionsConfigured: Boolean(liveForeignStockBaseUrl),
            usPositionsReadSucceeded:
              usPositionResults.length > 0 && usPositionResults.every(({ result }) => result.ok),
            usPositionCount,
            usPositionCountsByMarket: Object.fromEntries(
              usPositionResults.map(({ market, result }) => [
                market,
                result.ok ? result.value.positions.length : undefined,
              ]),
            ),
            usPositionErrors: usPositionResults
              .filter(({ result }) => !result.ok)
              .map(({ market, result }) => ({
                market,
                errorType: result.ok ? undefined : result.errorType,
                errorCode: result.ok ? undefined : result.errorCode,
              })),
            domesticPositionsWithCurrentPrice: cashResult.ok
              ? cashResult.value.positions.filter(
                  (position) => typeof position.currentPrice?.value === "number",
                ).length
              : undefined,
            usPositionsWithCurrentPrice: usPositionResults.reduce(
              (total, { result }) =>
                total +
                (result.ok
                  ? result.value.positions.filter(
                      (position) => typeof position.currentPrice?.value === "number",
                    ).length
                  : 0),
              0,
            ),
            marketDataProbeEnabled: verifyMarketData,
            domesticQuoteReadSucceeded: domesticQuoteResult?.ok,
            domesticQuoteHasPrice: domesticQuoteResult?.ok
              ? typeof domesticQuoteResult.value.quote?.price?.value === "number"
              : undefined,
            domesticChartReadSucceeded: domesticChartResult?.ok,
            domesticChartPointCount: domesticChartResult?.ok
              ? domesticChartResult.value.prices.length
              : undefined,
            usQuoteReadSuccessCount: usQuoteResults.filter((result) => result.ok).length,
            usQuoteWithLastPriceCount: usQuoteResults.filter(
              (result) => result.ok && typeof result.value.quote?.price?.value === "number",
            ).length,
            usQuoteWithPreviousCloseCount: usQuoteResults.filter(
              (result) => result.ok && typeof result.value.quote?.previousClose?.value === "number",
            ).length,
            usChartReadSucceeded: usChartResult?.ok,
            usChartPointCount: usChartResult?.ok ? usChartResult.value.prices.length : undefined,
            exchangeRateReadSucceeded: exchangeRateResult?.ok,
            exchangeRateHasReferenceRate: exchangeRateResult?.ok
              ? Boolean(exchangeRateResult.value.referenceExchangeRate)
              : undefined,
            exchangeRateHasComputedRate: exchangeRateResult?.ok
              ? Boolean(exchangeRateResult.value.computeExchangeRate)
              : undefined,
            exchangeRateErrorType:
              exchangeRateResult && !exchangeRateResult.ok
                ? exchangeRateResult.errorType
                : undefined,
            exchangeRateErrorCode:
              exchangeRateResult && !exchangeRateResult.ok
                ? exchangeRateResult.errorCode
                : undefined,
            usTradeHistoryConfigured: Boolean(liveForeignStockBaseUrl),
            usTradeHistoryReadSucceeded: usTradeHistoryResult?.ok,
            usTradeHistoryQueryFrom: liveForeignStockBaseUrl ? usHistoryFrom : undefined,
            usTradeHistoryQueryTo: liveForeignStockBaseUrl ? usHistoryTo : undefined,
            usTradeHistoryCount: usTradeHistoryResult?.ok
              ? usTradeHistoryResult.value.records.length
              : undefined,
            usTradeHistoryHasMore: usTradeHistoryResult?.ok
              ? usTradeHistoryResult.value.hasMore
              : undefined,
            usTradeHistoryOldestDate: usTradeDates.at(0),
            usTradeHistoryNewestDate: usTradeDates.at(-1),
            usTradeHistoryErrorType:
              usTradeHistoryResult && !usTradeHistoryResult.ok
                ? usTradeHistoryResult.errorType
                : undefined,
            usTradeHistoryErrorCode:
              usTradeHistoryResult && !usTradeHistoryResult.ok
                ? usTradeHistoryResult.errorCode
                : undefined,
            usHistorySearchDurationReadSucceeded: usHistorySearchDurationResult?.ok,
            usHistorySearchDurationPastYears: usHistorySearchDurationResult?.ok
              ? usHistorySearchDurationResult.value.pastYears
              : undefined,
            usHistorySearchDurationDefaultFrom: usHistorySearchDurationResult?.ok
              ? usHistorySearchDurationResult.value.searchDateFrom
              : undefined,
            usHistorySearchDurationDefaultTo: usHistorySearchDurationResult?.ok
              ? usHistorySearchDurationResult.value.searchDateTo
              : undefined,
            usHistoryWindowScanEnabled: verifyUsHistoryWindows,
            usHistoryWindowScanFrom: verifyUsHistoryWindows ? usHistoryScanFrom : undefined,
            usHistoryWindowScanTo: verifyUsHistoryWindows ? usHistoryTo : undefined,
            usHistoryWindowCount: verifyUsHistoryWindows ? usHistoryWindows.length : undefined,
            usHistoryWindowSuccessCount: verifyUsHistoryWindows
              ? usHistoryWindowResults.filter(({ result }) => result.ok).length
              : undefined,
            usHistoryWindowFailureCount: verifyUsHistoryWindows
              ? usHistoryWindowResults.filter(({ result }) => !result.ok).length
              : undefined,
            usHistoryWindowFailures: verifyUsHistoryWindows
              ? usHistoryWindowResults
                  .filter(({ result }) => !result.ok)
                  .map(({ window, result }) => ({
                    ...window,
                    errorType: result.ok ? undefined : result.errorType,
                    errorCode: result.ok ? undefined : result.errorCode,
                  }))
              : undefined,
            usHistoryWindowHasMoreCount: verifyUsHistoryWindows
              ? usHistoryWindowResults.filter(
                  ({ result }) => result.ok && result.value.hasMore === true,
                ).length
              : undefined,
            usHistoryWindowRecordCount: verifyUsHistoryWindows
              ? usHistoryWindowRecords.length
              : undefined,
            usHistoryWindowUniqueRecordCount: verifyUsHistoryWindows
              ? usHistoryWindowUniqueRecords.size
              : undefined,
            usHistoryWindowDuplicateCount: verifyUsHistoryWindows
              ? usHistoryWindowRecords.length - usHistoryWindowUniqueRecords.size
              : undefined,
            usHistoryWindowOldestDate: verifyUsHistoryWindows
              ? usHistoryWindowDates.at(0)
              : undefined,
            usHistoryWindowNewestDate: verifyUsHistoryWindows
              ? usHistoryWindowDates.at(-1)
              : undefined,
            foreignCashBalanceReadSucceeded: foreignCashBalanceResult?.ok,
            foreignCashBalanceEntryCount: foreignCashBalanceResult?.ok
              ? foreignCashBalanceResult.value.balances.length
              : undefined,
            foreignCashBalanceCurrencies: foreignCashBalanceResult?.ok
              ? [
                  ...new Set(
                    foreignCashBalanceResult.value.balances.map((balance) => balance.currencyCode),
                  ),
                ]
                  .filter(Boolean)
                  .sort()
              : undefined,
            foreignCashBalanceAccountKindCount: foreignCashBalanceResult?.ok
              ? new Set(
                  foreignCashBalanceResult.value.balances.map((balance) => balance.accountKind),
                ).size
              : undefined,
            foreignCashBalanceOldestDate: foreignCashBalanceDates.at(0),
            foreignCashBalanceNewestDate: foreignCashBalanceDates.at(-1),
            foreignCashBalancePositiveKeepCashCount: foreignCashBalanceResult?.ok
              ? foreignCashBalanceResult.value.balances.filter(
                  (balance) => amountState(balance.keepCash) === "positive",
                ).length
              : undefined,
            foreignCashBalancePositiveBuyPossibleCount: foreignCashBalanceResult?.ok
              ? foreignCashBalanceResult.value.balances.filter(
                  (balance) => amountState(balance.buyPossibleAmount) === "positive",
                ).length
              : undefined,
            foreignCashBalanceErrorType:
              foreignCashBalanceResult && !foreignCashBalanceResult.ok
                ? foreignCashBalanceResult.errorType
                : undefined,
            foreignCashBalanceErrorCode:
              foreignCashBalanceResult && !foreignCashBalanceResult.ok
                ? foreignCashBalanceResult.errorCode
                : undefined,
            accountAssetsConfigured: Boolean(liveMainSiteBaseUrl),
            accountAssetsReadSucceeded: assetsResult?.ok,
            accountAssetCategories: assetsResult?.ok
              ? assetsResult.value.summaryDetails.map((detail) => ({
                  category: detail.category,
                  valuationState: numberState(detail.valuation),
                }))
              : undefined,
            accountAssetsErrorType:
              assetsResult && !assetsResult.ok ? assetsResult.errorType : undefined,
            accountAssetsErrorCode:
              assetsResult && !assetsResult.ok ? assetsResult.errorCode : undefined,
            yenHistoryConfigured: Boolean(liveMainSiteBaseUrl),
            yenHistoryReadSucceeded: yenHistoryResult?.ok,
            yenHistoryCount: yenHistoryResult?.ok ? yenHistoryResult.value.length : undefined,
            yenHistoryOldestDate: yenHistoryDates.at(0),
            yenHistoryNewestDate: yenHistoryDates.at(-1),
            yenHistoryErrorType:
              yenHistoryResult && !yenHistoryResult.ok ? yenHistoryResult.errorType : undefined,
            yenHistoryErrorCode:
              yenHistoryResult && !yenHistoryResult.ok ? yenHistoryResult.errorCode : undefined,
            yenDividendTransactionCount: yenDividendTransactions.length,
            yenDividendWithFourDigitCodeCount: yenDividendTransactions.filter((transaction) =>
              /(^|\D)\d{4}(\D|$)/.test(transaction.description ?? ""),
            ).length,
            yenDividendMatchingCurrentIssueCount: yenDividendTransactions.filter((transaction) =>
              domesticIssueIdentifiers.some((identifier) =>
                (transaction.description ?? "").includes(identifier),
              ),
            ).length,
            yenDividendWithSpecificDescriptionCount: yenDividendTransactions.filter(
              (transaction) =>
                !/^(株式)?配当金$|^分配金$/.test(
                  (transaction.description ?? "").replaceAll(/\s/g, ""),
                ),
            ).length,
            hasMethodError,
            trace,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    try {
      await createPasskeySession({
        authBaseUrl,
        mtsBaseUrl: MTS_PROBE_ORIGIN,
        passkeyProvider: provider,
      });
      throw new Error("MTS handoff was not intercepted");
    } catch (error) {
      if (!(error instanceof MtsHandoffReached)) throw error;
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          status: "passkey-auth-succeeded",
          mtsHandoffReached: true,
          accessTokenPresent: true,
          trace,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
};

try {
  await main();
} catch (error) {
  const name = error instanceof Error ? error.name : "UnknownError";
  process.stderr.write(`${JSON.stringify({ status: "failed", errorType: name })}\n`);
  process.exitCode = 1;
}
